"""Per-kind LOCAL file listing + safetensors metadata (docs/lora-loader-
design.md §1a-v "the picker dropdown" / §1a-vi "can we know a LoRA's
category"). Everything here is stdlib + a lazy `folder_paths` import -- no
torch, no tensor loading, ever: reading safetensors metadata means reading
the file's 8-byte header-length prefix and that many bytes of JSON, nothing
past it.

`folder_paths` is imported LAZILY, inside functions, so this module stays
importable (and testable, `sys.modules`-stubbed) with no ComfyUI installed --
same convention as `nodes/controls/_loaders_helpers.py`.

🔒 Every function that resolves a client-supplied `name` to a real path
(`resolve_model_path`, and `list_models`'s own per-file resolution) first
runs `kind` through `kinds.folder_for_kind`'s whitelist, then verifies the
resolved path's REAL (symlink-followed) location sits inside one of that
kind's configured `folder_paths` directories -- the same class of guard as
`../ComfyUI-Pixaroma/server_routes.py:2062-2078`'s `_resolve_lora_path` and
its `_is_path_under` (`server_routes.py:1497-1561`; the STRICT
realpath-then-`commonpath` branch at `:1531-1537` is the part this module's
own `_is_path_under` below matches -- upstream's ADDITIONAL lexical fallback
for a cross-drive junction, `:1544-1560`, is not ported here; this pack has
no equivalent split-models-across-drives scenario reported yet).

Two functions below are near-verbatim ports (MIT, THIRD_PARTY_NOTICES.md;
each has its own precise citation): `read_safetensors_metadata` and
`find_preview_path`.
"""
from __future__ import annotations

import json
import os
import struct
from typing import Any, Dict, List, Optional

from .kinds import folder_for_kind

# Real safetensors headers are tens of KB; capped far above that -- the
# IDENTICAL bound (MIT, THIRD_PARTY_NOTICES.md) as
# `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:24`'s own `_MAX_HEADER_BYTES`
# -- so a corrupt or adversarial length prefix can never make us try to
# allocate gigabytes "reading a header".
_MAX_HEADER_BYTES = 200 * 1024 * 1024

# Preview-file discovery order (§1a-v): a Civitai-helper-style dedicated
# preview extension first, then a bare image with the same basename -- the
# IDENTICAL tuple (MIT, THIRD_PARTY_NOTICES.md) as
# `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:28-31`'s own `_PREVIEW_EXTS`.
_PREVIEW_EXTS = (
    ".preview.png", ".preview.jpeg", ".preview.jpg", ".preview.webp",
    ".png", ".jpg", ".jpeg", ".webp",
)

# Priority order for each field, per §1a-vi's "available in the file" table.
# First present, non-empty value wins; nothing here CLASSIFIES the value
# into a coarse family (no "SDXL"/"SD1.5" bucketing) -- it's surfaced
# exactly as the file states it, since guessing wrongly is worse than
# showing the raw string (the same "never guess a category" principle
# §1a-vi states explicitly for the separate category question).
_TRIGGER_KEYS = ("modelspec.trigger_phrase", "ss_trigger_words")
_BASE_MODEL_KEYS = ("modelspec.architecture", "ss_base_model_version", "ss_sd_model_name")


# ---------------------------------------------------------------------------
# Safetensors metadata -- header-only, never touches tensor data.
# ---------------------------------------------------------------------------


def read_safetensors_metadata(path: str) -> Dict[str, Any]:
    """The file's `__metadata__` dict (str -> str), or `{}` for ANY problem
    (missing file, a truncated header, an oversized/garbage length prefix,
    or a header that isn't valid JSON) -- never raises. Reads ONLY the
    8-byte little-endian header-length prefix and that many header bytes;
    the tensor block itself is never opened, so no torch import is needed
    or possible here.

    Near-verbatim port of `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:34-57`'s
    own `read_safetensors_metadata` (MIT, THIRD_PARTY_NOTICES.md).
    """
    try:
        with open(path, "rb") as fh:
            raw = fh.read(8)
            if len(raw) != 8:
                return {}
            n = struct.unpack("<Q", raw)[0]
            if n <= 0 or n > _MAX_HEADER_BYTES:
                return {}
            head = fh.read(n)
            if len(head) != n:
                return {}
        obj = json.loads(head)
    except Exception:
        return {}
    if not isinstance(obj, dict):
        return {}
    meta = obj.get("__metadata__")
    return meta if isinstance(meta, dict) else {}


def trigger_words_from_metadata(meta: Any) -> List[str]:
    """Trigger words straight from the file's own metadata (§1a-vi):
    `modelspec.trigger_phrase` first, `ss_trigger_words` as a fallback --
    both are a single comma-separated string in real files. De-duped
    case-insensitively, first-seen order preserved. `[]` for a non-dict
    `meta` or one with neither key present/non-empty.
    """
    if not isinstance(meta, dict):
        return []
    for key in _TRIGGER_KEYS:
        phrase = meta.get(key)
        if not isinstance(phrase, str) or not phrase.strip():
            continue
        out: List[str] = []
        seen = set()
        for part in phrase.split(","):
            word = part.strip()
            if word and word.lower() not in seen:
                seen.add(word.lower())
                out.append(word)
        if out:
            return out
    return []


def base_model_from_metadata(meta: Any) -> str:
    """The first non-empty value among `modelspec.architecture` /
    `ss_base_model_version` / `ss_sd_model_name` (§1a-vi's priority order),
    RAW -- this function doesn't classify it into a coarse family, it just
    surfaces whatever the file itself says (never guess -- §1a-vi's
    principle for the separate category question applies here too: a wrong
    label is worse than an honest blank). `""` when none are present.
    """
    if not isinstance(meta, dict):
        return ""
    for key in _BASE_MODEL_KEYS:
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def find_preview_path(model_path: str) -> Optional[str]:
    """A local preview image sitting next to `model_path` (`<base>.preview.
    png` etc., falling back to a bare `<base>.png` and friends), or `None`.
    This is what keeps the picker's thumbnail fully offline (§1a-v) -- no
    Civitai involved, and no network at all.

    Near-verbatim port of `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:197-204`'s
    own `find_preview_path` (MIT, THIRD_PARTY_NOTICES.md).
    """
    base = os.path.splitext(model_path)[0]
    for ext in _PREVIEW_EXTS:
        candidate = base + ext
        if os.path.isfile(candidate):
            return candidate
    return None


# ---------------------------------------------------------------------------
# Path resolution + the traversal guard.
# ---------------------------------------------------------------------------


def _is_path_under(path: str, *roots: str) -> bool:
    """Whether `path`'s REAL (symlink-resolved) location sits inside ANY of
    `roots` (also resolved) -- the guard every resolution below applies
    before trusting a client-supplied name. Same STRICT realpath-then-
    `commonpath` core as `../ComfyUI-Pixaroma/server_routes.py:1531-1537`'s
    own `_is_path_under` (module docstring above has the full citation,
    including the upstream lexical cross-drive fallback deliberately NOT
    ported here). `False` (never raises) if the paths don't share a common
    drive/root at all (Windows cross-drive `commonpath` raises `ValueError`).
    """
    real_path = os.path.realpath(path)
    for root in roots:
        real_root = os.path.realpath(root)
        try:
            if os.path.commonpath([real_path, real_root]) == real_root:
                return True
        except ValueError:
            continue
    return False


def _model_dirs(folder: str) -> List[str]:
    import folder_paths  # ComfyUI-only; lazy -- see module docstring.

    try:
        return list(folder_paths.get_folder_paths(folder))
    except Exception:
        return []


def resolve_model_path(kind: object, name: Any) -> Optional[str]:
    """A whitelisted `kind` + a client-supplied `name` -> a real, on-disk
    path GUARANTEED to live inside one of that kind's configured model
    directories, or `None` for anything that doesn't check out:

      - an unwhitelisted `kind` -- handled entirely by `folder_for_kind`,
        without `folder_paths` ever being touched, so a traversal attempt
        spelled as a `kind` (e.g. `"../../etc"`) never reaches path
        resolution at all;
      - a non-string/empty `name`;
      - a name `folder_paths` itself can't resolve, or that doesn't exist
        on disk;
      - the actual traversal guard -- a resolved path that, after following
        `..`/symlinks, ends up OUTSIDE every configured directory for this
        kind.

    Fails CLOSED: if the kind's directory list can't even be determined
    (`folder_paths` error, or genuinely empty), nothing resolves rather than
    trusting an unverifiable path.
    """
    folder = folder_for_kind(kind)
    if folder is None:
        return None
    if not isinstance(name, str) or not name:
        return None

    import folder_paths  # ComfyUI-only; lazy -- see module docstring.

    try:
        path = folder_paths.get_full_path(folder, name)
    except Exception:
        path = None
    if not path or not os.path.isfile(path):
        return None

    roots = _model_dirs(folder)
    if not roots or not _is_path_under(path, *roots):
        return None
    return path


def _group_for(relative_name: str) -> str:
    """The picker's root group label (§1a-v): a file sitting at the top of
    the kind's folder (no subfolder) groups under `All`; anything with a
    subfolder groups under that subfolder's own first path segment.
    """
    head, _, _ = relative_name.replace("\\", "/").rpartition("/")
    return head if head else "All"


def list_models(kind: object) -> List[Dict[str, Any]]:
    """Every file `folder_paths` knows about for `kind`, each described by
    `{name, size, group, base_model, triggers, has_preview}`:

      - `name` includes any subfolder prefix, matching `folder_paths.
        get_filename_list`'s own convention (e.g. `"detail/my_lora.
        safetensors"`);
      - `size` is the file's byte size on disk, `0` if it can't be stat'd;
      - `group` is the picker's subfolder grouping (§1a-v/§1a-vi);
      - `base_model`/`triggers` come from the file's own safetensors
        metadata -- `""`/`[]` for a non-`.safetensors` file, or one with no
        usable metadata (reading metadata never raises, see
        `read_safetensors_metadata`);
      - `has_preview` is whether a local preview image sits next to it.

    Returns `[]` for an unwhitelisted `kind`, or if `folder_paths` itself
    can't enumerate the folder at all (matching the caution at
    `../ComfyUI-Pixaroma/server_routes.py:2091`'s "a scan failure is not an
    empty folder" -- a caller that needs to tell those two cases apart
    should check `folder_for_kind(kind)` itself first). Every listed file is additionally
    guaranteed to sit inside one of this kind's configured directories --
    the same traversal guard `resolve_model_path` applies, run here per
    file rather than per single lookup.
    """
    folder = folder_for_kind(kind)
    if folder is None:
        return []

    import folder_paths  # ComfyUI-only; lazy -- see module docstring.

    try:
        names = list(folder_paths.get_filename_list(folder))
    except Exception:
        return []

    roots = _model_dirs(folder)
    out: List[Dict[str, Any]] = []
    for name in names:
        try:
            path = folder_paths.get_full_path(folder, name)
        except Exception:
            path = None
        if not path or not os.path.isfile(path):
            continue
        if roots and not _is_path_under(path, *roots):
            continue  # never list a file outside this kind's configured dirs

        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0

        meta = read_safetensors_metadata(path) if path.lower().endswith(".safetensors") else {}
        out.append({
            "name": name,
            "size": size,
            "group": _group_for(name),
            "base_model": base_model_from_metadata(meta),
            "triggers": trigger_words_from_metadata(meta),
            "has_preview": find_preview_path(path) is not None,
        })
    return out


__all__ = (
    "read_safetensors_metadata",
    "trigger_words_from_metadata",
    "base_model_from_metadata",
    "find_preview_path",
    "resolve_model_path",
    "list_models",
)
