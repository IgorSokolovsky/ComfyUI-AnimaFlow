"""Reading OTHER Civitai-downloader tools' on-disk metadata, so a model one
of them already pulled still shows real info in our own picker/ⓘ panel --
the "reverse direction" half of the 2026-07-30 "no info sidecar, no preview
image" fix. Owner's instruction: "we should be consistent with the standard
so if Civicomfy and Comfy Manager do the same we should too" -- explicitly
CONDITIONAL on actually verifying that, not inventing a format and calling
it "the standard".

VERIFIED LIVE, 2026-07-30 (both repos fetched via the GitHub API, `main`):

  - **Civicomfy** (github.com/MoonGoblinDev/Civicomfy, **MIT** -- confirmed
    via the repo's own `LICENSE` file before reading anything else) writes a
    per-model sidecar at `<base>.cminfo.json` -- `config.py`'s own
    `METADATA_SUFFIX = ".cminfo.json"` (NOT the hyphenated `.cm-info.json`
    the owner recalled from memory -- the real constant has no hyphen;
    corrected here from the verified source, not assumed; re-confirmed
    against a second, independently-published archive of the same project
    dated 2026-01-12, same constant). Its shape is a FLAT, PascalCase-keyed
    CUSTOM JSON object (`downloader/manager.py`'s `_save_metadata`, ~line
    1047 as fetched) -- `ModelId`, `ModelName`, `ModelDescription`, `Tags`,
    `ModelType`, `VersionId`, `VersionName`, `VersionDescription`,
    `BaseModel`, `TrainedWords`, `Hashes`, `Stats`, ... -- a genuinely
    DIFFERENT shape from the raw Civitai API response our own
    `.civitai.info` caches verbatim, so reading it needs its own translator
    (`translate_cminfo`, below) rather than being handed straight to
    `civitai_parse.parse_model_version`. Its preview file is a SEPARATE
    download (`downloader/manager.py`'s `_download_and_save_preview`), to
    `<base>.preview.jpeg` always (`config.py`'s `PREVIEW_SUFFIX`) -- the
    SAME `<base>.preview.<ext>` convention `local._PREVIEW_EXTS` already
    reads, so no interop work was needed on the preview side for this tool.
  - **ComfyUI Model Manager** (github.com/hayden-cn/ComfyUI-Model-Manager,
    **GPL-3.0** -- confirmed via the repo's own `license` API response
    before reading anything else) writes NO equivalent JSON sidecar at all:
    its own model-info write path (`py/information.py`'s
    `CivitaiModelSearcher`) produces a `<base>.md` file with a
    YAML-frontmatter block -- an entirely different SERIALISATION
    (Markdown+YAML prose, not JSON), not a variant of the same schema. Its
    preview file naming (`py/utils.py`'s `_get_preview_path`/
    `save_model_preview`, `<base>.preview.<ext>`, always re-encoded to
    `.webp` for a still image) likewise already matches
    `local._PREVIEW_EXTS` -- also already compatible, nothing to add.

  These two tools do NOT share an "info sidecar" convention with EACH OTHER
  (one JSON, one Markdown+YAML) -- so per the owner's own explicit
  fallback instruction ("if they disagree with each other... write only our
  own `.civitai.info`"), this package's WRITE side stays exactly
  `sidecar.py`'s `.civitai.info`, unchanged by this fix. This module is the
  READ-side fallback, and only for the one format that genuinely IS a
  verified, schema-stable JSON sidecar: Civicomfy's `.cminfo.json`. ComfyUI
  Model Manager's Markdown+YAML write path is not parsed here -- doing so
  would mean reimplementing a YAML-frontmatter reader against a GPL-3.0
  project's own bespoke prose format for comparatively little payoff (its
  "info" isn't a machine-readable key/value cache in the same sense
  `.civitai.info`/`.cminfo.json` are -- it's prose with a YAML preamble) --
  "matching a JSON schema is not copying, but lifting code is" does not
  stretch to reimplementing a whole different tool's document format.

  No code was copied from either project -- only the VERIFIED filename
  constant and field-name facts above (see `THIRD_PARTY_NOTICES.md`).

Pure file I/O + a pure translator -- no network, importable with no ComfyUI
installed (same convention as `sidecar.py`).
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

# Civicomfy's own constant, verified live (see module docstring):
# `config.py`'s `METADATA_SUFFIX`. Kept as our own literal rather than an
# import -- Civicomfy is a sibling custom-node pack, not a Python dependency
# of this one (this package never imports another custom node pack, per its
# own soft-import convention for third-party node packs).
CMINFO_SUFFIX = ".cminfo.json"


def cminfo_path(model_path: str) -> str:
    """`<base>.cminfo.json` next to `model_path` -- Civicomfy's own sidecar
    naming (verified, see module docstring)."""
    return os.path.splitext(model_path)[0] + CMINFO_SUFFIX


def read_cminfo(model_path: str) -> Optional[Dict[str, Any]]:
    """The raw `.cminfo.json` sidecar Civicomfy wrote for `model_path`, or
    `None` if it doesn't exist, or exists but isn't a readable JSON object.
    Never raises -- same contract as `sidecar.read_sidecar`."""
    path = cminfo_path(model_path)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def translate_cminfo(data: Any) -> Dict[str, Any]:
    """Civicomfy's flat, PascalCase `.cminfo.json` shape -> the SAME
    raw-Civitai-response shape `civitai_parse.parse_model_version` reads --
    so a `.cminfo.json` sidecar is usable through the EXACT same parser as
    our own `.civitai.info` cache, with no second parser to keep in sync.

    Civicomfy stores no gallery images at all in this file -- its preview
    image is a SEPARATE file it downloads on its own (see module docstring),
    exactly like ours -- so the translated shape's `images` key is never
    set; `parse_model_version`'s thumbnail extraction simply finds nothing,
    which is correct here: the local preview file (found independently via
    `local.find_preview_path`) is the real source of a thumbnail for this
    tool's models, not this metadata file.

    Never raises: non-dict `data`, or one with nothing usable at all,
    returns `{}` (mirrors `parse_model_version`'s own "nothing usable"
    contract).
    """
    if not isinstance(data, dict):
        return {}
    out: Dict[str, Any] = {}

    version_id = data.get("VersionId")
    if isinstance(version_id, int) and not isinstance(version_id, bool):
        out["id"] = version_id
    model_id = data.get("ModelId")
    if isinstance(model_id, int) and not isinstance(model_id, bool):
        out["modelId"] = model_id
    if data.get("BaseModel"):
        out["baseModel"] = str(data["BaseModel"])
    trained = data.get("TrainedWords")
    if isinstance(trained, list):
        cleaned = [str(w) for w in trained if isinstance(w, str) and w.strip()]
        if cleaned:
            out["trainedWords"] = cleaned
    if data.get("VersionDescription"):
        out["description"] = str(data["VersionDescription"])

    model_obj: Dict[str, Any] = {}
    if data.get("ModelName"):
        model_obj["name"] = str(data["ModelName"])
    if data.get("ModelType"):
        model_obj["type"] = str(data["ModelType"])
    tags = data.get("Tags")
    if isinstance(tags, list):
        cleaned_tags = [str(t) for t in tags if isinstance(t, str) and t.strip()]
        if cleaned_tags:
            model_obj["tags"] = cleaned_tags
            out["tags"] = cleaned_tags
    if data.get("ModelDescription"):
        model_obj["description"] = str(data["ModelDescription"])
    if model_obj:
        out["model"] = model_obj

    return out


def read_cminfo_as_civitai_shape(model_path: str) -> Optional[Dict[str, Any]]:
    """`read_cminfo` + `translate_cminfo` -- the one function `sidecar.
    read_sidecar`'s fallback actually calls. `None` if there's no
    `.cminfo.json` at all, or it exists but translates to nothing usable
    (mirrors `civitai_parse.parse_model_version`'s own "nothing usable"
    stance, applied one layer earlier)."""
    raw = read_cminfo(model_path)
    if raw is None:
        return None
    translated = translate_cminfo(raw)
    return translated if translated else None


__all__ = ("CMINFO_SUFFIX", "cminfo_path", "read_cminfo", "translate_cminfo", "read_cminfo_as_civitai_shape")
