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

`civitai_name_for` (docs/lora-loader-design.md §1a-vii, "show the CIVITAI
name instead of the filename") is this module's one genuinely Civitai-aware
function -- `list_models` calls it per file so the `/list` route can carry a
display name, sourced from whatever `sidecar.read_sidecar` already reads
(our own `.civitai.info`, or Civicomfy's `.cminfo.json` translated to the
same shape -- see that function's own doc comment). This does not violate
this module's "local file listing" scope: it never makes a network call,
never imports `civitai_client`, and reads through the exact same pure
`sidecar`/`civitai_parse` modules `lookup.py` already does for the SAME
cached-sidecar data -- `src/model_browser/` as a whole is "one source
(Civitai) inside a model browser" (design doc §0e's decision D), not two
disjoint packages, so a local listing function reading an already-cached
sidecar is squarely in scope.
"""
from __future__ import annotations

import collections
import json
import os
import struct
from typing import Any, Dict, List, Optional, Tuple

from . import civitai_parse, interop, sidecar
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


def _parse_safetensors_header(path: str) -> Optional[Dict[str, Any]]:
    """Read + parse ONLY `path`'s safetensors header (the 8-byte
    little-endian header-length prefix, then that many header bytes) -> the
    parsed JSON object, or `None` for ANY problem (missing file, a truncated
    header, an oversized/garbage length prefix, or header bytes that aren't
    valid JSON or aren't a JSON object) -- never raises. The tensor block
    itself is never opened, so no torch import is needed or possible here.

    Factored out of `read_safetensors_metadata` (2026-07-30) so
    `download.py`'s post-download integrity check can reuse the SAME parse
    rather than a second copy of it -- that function's own `{}`-on-any-
    failure contract deliberately can't tell "not a safetensors file" apart
    from "a safetensors file with no `__metadata__`", which is fine for its
    own best-effort-metadata job but useless as a validity signal.

    Near-verbatim port of `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:34-57`'s
    own `read_safetensors_metadata` (MIT, THIRD_PARTY_NOTICES.md).
    """
    try:
        with open(path, "rb") as fh:
            raw = fh.read(8)
            if len(raw) != 8:
                return None
            n = struct.unpack("<Q", raw)[0]
            if n <= 0 or n > _MAX_HEADER_BYTES:
                return None
            head = fh.read(n)
            if len(head) != n:
                return None
        obj = json.loads(head)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    return obj


def read_safetensors_metadata(path: str) -> Dict[str, Any]:
    """The file's `__metadata__` dict (str -> str), or `{}` for ANY problem
    (missing file, a truncated header, an oversized/garbage length prefix,
    or a header that isn't valid JSON) -- never raises. See
    `_parse_safetensors_header` for the actual read/parse.
    """
    obj = _parse_safetensors_header(path)
    if obj is None:
        return {}
    meta = obj.get("__metadata__")
    return meta if isinstance(meta, dict) else {}


def is_valid_safetensors_header(path: str) -> bool:
    """Whether `path` starts with a well-formed safetensors header: the
    8-byte length prefix followed by that many bytes that parse as a JSON
    object. This is the validity SIGNAL `read_safetensors_metadata`
    deliberately discards (a file with no `__metadata__` block is still a
    perfectly valid safetensors file, and gets `{}` there same as a
    genuinely corrupt one) -- `download.py`'s post-download integrity check
    needs exactly this distinction, so it calls this instead of duplicating
    the header parse.
    """
    return _parse_safetensors_header(path) is not None


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
# Preview corruption proof (2026-08-05, "`save_preview` may replace a
# preview it can PROVE is corrupt") -- `lookup.save_preview`'s never-
# overwrite rule used to protect ANY existing preview file, including one
# `3e02428`'s write-side truncation bug left broken forever (that fix closed
# the WRITE-side hole; every file already truncated before it stayed broken,
# re-fetching from Civitai on every render since `api.py`'s own `/thumb` 404s
# it -- `0489628`/`4d04ce8`). This narrows the rule to what it actually
# protects: a WORKING preview someone deliberately put there stays
# untouched; only a file this module can PROVE is undecodable may be
# replaced.
#
# Lives HERE, not `api.py` (which already owns an near-identical Pillow-
# presence check, `_load_pillow_image_module`/`downscale_thumb_bytes`,
# `api.py:512`): `api.py` imports `lookup.py`, so `lookup.py` must never
# import `api.py` back -- a cycle. `local.py` already owns `find_preview_
# path` and every other file-inspection role both `api.py` and `lookup.py`
# import, so the validator lives here instead, with its OWN lazy Pillow
# import. This is a deliberate SECOND copy of "try `from PIL import Image`,
# `None` if that fails" -- `api.py`'s own decode path was fixed twice in the
# last day and does not need a third round of churn in this pass; folding
# the two into one shared helper is left for a later tidy.
# ---------------------------------------------------------------------------


def _load_pillow_image_module() -> Any:
    """Lazy import of `PIL.Image` -- returns the module, or `None` if
    Pillow isn't installed. A second copy of `api.py`'s identically-named,
    identically-behaved helper -- see the module comment just above this
    function for why it isn't shared. Called ONLY from inside
    `is_preview_provably_corrupt` below, never at module import time --
    `src/model_browser/local.py` must stay importable (and testable) with no
    ComfyUI AND no Pillow installed, same constraint this module's own top
    docstring states for `folder_paths`.
    """
    try:
        from PIL import Image
    except ImportError:
        return None
    return Image


def is_preview_provably_corrupt(path: str, *, image_module: Any = None) -> Optional[bool]:
    """Whether the preview image at `path` is PROVEN undecodable --
    `lookup.save_preview`'s "may replace only what it can PROVE is corrupt"
    rule needs exactly this tri-state, not a plain bool:

      - `True`  -- Pillow is installed and could NOT open+verify `path` --
        genuinely corrupt/truncated bytes (the owner's own measured symptom:
        a decodable PNG/RIFF header declaring far more bytes than are
        actually on disk, `0489628`). This is the ONLY value that may ever
        justify treating an existing preview as replaceable.
      - `False` -- Pillow is installed and opened+verified `path` cleanly --
        a working preview, whatever wrote it, stays untouched.
      - `None`  -- Pillow ISN'T installed, so this function genuinely cannot
        tell good bytes from bad. A caller MUST treat this exactly like
        `False` (never replace) -- "cannot tell" means keep, never "assume
        corrupt": getting this backwards would destroy every good preview on
        any install without Pillow, the same discipline `api.py`'s own
        `thumb_bytes_impl`/`downscale_thumb_bytes` already apply to the
        (separate) question of what bytes to SERVE.

    Deliberately a HEADER/VERIFY-level check, not a full decode-and-re-
    encode: `Image.open(path)` followed by `.verify()` -- Pillow's own
    "check this file for damage without fully decoding the pixel data" API
    (it walks e.g. every PNG chunk's CRC), which is exactly the proof this
    function needs and nothing more. This runs on the ⓘ-panel lookup path,
    only ever called when a preview already exists to check (`save_preview`
    below never calls this for a model with no preview at all) -- there is
    nothing cheaper that would still prove anything.

    Never raises: ANY exception while opening or verifying `path` -- a
    missing file, a truncated header, a decodable header with missing pixel
    data, or anything else -- is `True` (proven corrupt), never propagated.

    `image_module` is the same injectable Pillow seam `api.py`'s own
    `downscale_thumb_bytes` already exposes for its tests (`None`, the
    default, means "use the real, lazily-imported `PIL.Image`" -- Pillow
    itself is NOT importable in this repo's test environment, verified
    elsewhere in this package's own test suite).
    """
    if image_module is None:
        image_module = _load_pillow_image_module()
    if image_module is None:
        return None
    try:
        img = image_module.open(path)
        try:
            img.verify()
        finally:
            close = getattr(img, "close", None)
            if callable(close):
                close()
        return False
    except Exception:  # noqa: BLE001 - any decode failure is proof enough, never propagated
        return True


# ---------------------------------------------------------------------------
# Civitai display name (§1a-vii) + ids (2026-08-03, "the Installed card opens
# a detail view") -- both read from whichever sidecar `sidecar.read_sidecar`
# already prefers, and both come out of the exact SAME `parse_model_version`
# call, so this caches the whole PARSED dict per `(sidecar_path, mtime)`
# rather than caching the name alone a second time under a second key -- one
# sidecar read + parse per `(path, mtime)` serves `civitai_name_for` AND
# `civitai_ids_for` both. Same `(path, mtime, ...)` cache-key precedent as
# `api.py`'s `/thumb` downscale cache (that module's own doc comment); bounded
# the same way.
# ---------------------------------------------------------------------------

_CIVITAI_PARSED_CACHE_MAX_ENTRIES = 512
_civitai_parsed_cache: "collections.OrderedDict[Tuple[str, float], Dict[str, Any]]" = collections.OrderedDict()

# A cache MISS (never looked up) must be distinguishable from a cached,
# genuinely-negative result ("this sidecar has no usable name") -- `None` is
# the real value for the latter, so a sentinel stands in for "not in the
# cache at all".
_UNSET = object()


def _civitai_parsed_cache_get(key: Tuple[str, float]) -> Any:
    if key in _civitai_parsed_cache:
        _civitai_parsed_cache.move_to_end(key)
        return _civitai_parsed_cache[key]
    return _UNSET


def _civitai_parsed_cache_put(key: Tuple[str, float], value: Dict[str, Any]) -> None:
    _civitai_parsed_cache[key] = value
    _civitai_parsed_cache.move_to_end(key)
    while len(_civitai_parsed_cache) > _CIVITAI_PARSED_CACHE_MAX_ENTRIES:
        _civitai_parsed_cache.popitem(last=False)


def _sidecar_cache_stamp(model_path: str) -> Optional[Tuple[str, float]]:
    """`(path, mtime)` of whichever sidecar file `sidecar.read_sidecar`
    would actually read for `model_path` -- our own `.civitai.info` if it
    exists, else Civicomfy's `.cminfo.json`, else `None` (neither exists, so
    there is nothing to cache a stamp against and no point calling
    `read_sidecar` at all -- it would return `None` too). Whichever file
    changes (a lookup/download rewrite, `save_preview`'s sidecar write, a
    'Forget cached' delete-then-recreate) changes this stamp, which is what
    invalidates the cache below with no explicit invalidation call needed.
    """
    own_path = sidecar.sidecar_path(model_path)
    try:
        return (own_path, os.path.getmtime(own_path))
    except OSError:
        pass
    cminfo = interop.cminfo_path(model_path)
    try:
        return (cminfo, os.path.getmtime(cminfo))
    except OSError:
        return None


def _parsed_civitai_for(model_path: str) -> Dict[str, Any]:
    """The `civitai_parse.parse_model_version` result cached for `model_path`
    -- `{}` when there is no sidecar at all, or one exists but parses to
    nothing usable. The ONE sidecar read + parse both `civitai_name_for` and
    `civitai_ids_for` (below) read from, cached per `(path, mtime)`
    (`_sidecar_cache_stamp`, above) so a large folder doesn't re-read +
    re-parse every sidecar TWICE per file on every `/list` call. A model with
    no sidecar at all costs one `os.path.getmtime`-shaped stat-and-miss per
    call (no sidecar read attempted, no cache entry made), not a cache entry
    -- there's nothing to invalidate for a file that doesn't exist yet.
    """
    stamp = _sidecar_cache_stamp(model_path)
    if stamp is None:
        return {}
    cached = _civitai_parsed_cache_get(stamp)
    if cached is not _UNSET:
        return cached
    raw = sidecar.read_sidecar(model_path)
    parsed = civitai_parse.parse_model_version(raw) if raw else {}
    _civitai_parsed_cache_put(stamp, parsed)
    return parsed


def civitai_name_for(model_path: str) -> Optional[str]:
    """The Civitai display name cached for `model_path` (§1a-vii), or `None`
    when there is no sidecar at all, or one exists but carries no usable
    name (`civitai_parse.parse_model_version`'s own `name` key, itself only
    ever set from a real, non-empty `model.name` in the source response) --
    "omit rather than invent" (§1a-vi's rule, applied here to a name instead
    of a category): never a placeholder, never the filename echoed back as
    if it were a Civitai name.

    Reads through the EXACT same `sidecar.read_sidecar` ->
    `civitai_parse.parse_model_version` pipeline `lookup.py` already uses
    for the ⓘ panel's own cached-info display, so a name shown here and one
    shown there always agree (`_parsed_civitai_for`, above, is the shared
    cached read both this function and `civitai_ids_for` go through).
    """
    parsed = _parsed_civitai_for(model_path)
    name = parsed.get("name")
    return name.strip() if isinstance(name, str) and name.strip() else None


def civitai_ids_for(model_path: str) -> Tuple[Optional[int], Optional[int]]:
    """`(model_id, version_id)` cached for `model_path` (2026-08-03, "an
    Installed card opens the detail view same as Search" -- the detail view
    needs a Civitai VERSION id to fetch, and `/list` carried no id of any
    kind before this), each independently `None` when the sidecar has no
    sidecar at all, or one exists but doesn't carry that particular id
    (`civitai_parse.parse_model_version`'s own `model_id`/`version_id` keys,
    each only ever set from a real int in the source response) -- "omit
    rather than invent" (§1a-vi's rule, same discipline `civitai_name_for`
    already applies to a name), never a placeholder, never `0`.

    Reads through the EXACT same shared cached parse `civitai_name_for` uses
    (`_parsed_civitai_for`, above) -- a name and its ids always come from the
    one sidecar read, never two independent reads that could disagree.
    """
    parsed = _parsed_civitai_for(model_path)
    model_id = parsed.get("model_id")
    version_id = parsed.get("version_id")
    clean_model_id = model_id if isinstance(model_id, int) and not isinstance(model_id, bool) else None
    clean_version_id = version_id if isinstance(version_id, int) and not isinstance(version_id, bool) else None
    return (clean_model_id, clean_version_id)


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

    🔒 2026-07-30 fix: `os.path.realpath` ALSO raises `ValueError: embedded
    null character` for a path containing `\x00` -- that used to be OUTSIDE
    this function's own try/except, so a NUL byte smuggled through a
    caller that didn't already reject one (`download.py`'s
    `sanitize_filename`/`validate_subfolder` now do, belt-and-suspenders)
    would crash straight out of this "never raises" guard. Both
    `os.path.realpath` calls are now inside the same `try` as the
    `commonpath` call, so ANY `ValueError` at any step -- a NUL byte, a
    Windows cross-drive mismatch, or anything else `os.path` might reject --
    degrades to "not under this root" for that one `root`, never a crash.
    """
    try:
        real_path = os.path.realpath(path)
    except ValueError:
        return False
    for root in roots:
        try:
            real_root = os.path.realpath(root)
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
    `{name, size, group, base_model, triggers, has_preview, civitai_name?,
    model_id?, version_id?}`:

      - `name` includes any subfolder prefix, matching `folder_paths.
        get_filename_list`'s own convention (e.g. `"detail/my_lora.
        safetensors"`);
      - `size` is the file's byte size on disk, `0` if it can't be stat'd;
      - `group` is the picker's subfolder grouping (§1a-v/§1a-vi);
      - `base_model`/`triggers` come from the file's own safetensors
        metadata -- `""`/`[]` for a non-`.safetensors` file, or one with no
        usable metadata (reading metadata never raises, see
        `read_safetensors_metadata`);
      - `has_preview` is whether a local preview image sits next to it;
      - `civitai_name` (§1a-vii) is OMITTED entirely -- never an empty
        string, never the filename -- unless `civitai_name_for` (above)
        found a genuinely usable Civitai display name in this file's
        sidecar. This is DISPLAY data only: `name` above remains the one
        identity value this route's caller may ever persist or resolve.
      - `model_id`/`version_id` (2026-08-03, "an Installed card opens the
        detail view") are each OMITTED INDEPENDENTLY -- never `0`, never a
        placeholder -- unless `civitai_ids_for` (above) found that exact id
        in this file's sidecar. A caller (the Installed tab) uses these to
        open the SAME master->detail view Search results open, with no
        network call needed when they're present; their absence is the
        caller's own signal to run a by-hash lookup first.

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
        entry: Dict[str, Any] = {
            "name": name,
            "size": size,
            "group": _group_for(name),
            "base_model": base_model_from_metadata(meta),
            "triggers": trigger_words_from_metadata(meta),
            "has_preview": find_preview_path(path) is not None,
        }
        civitai_name = civitai_name_for(path)
        if civitai_name:
            entry["civitai_name"] = civitai_name
        model_id, version_id = civitai_ids_for(path)
        if model_id is not None:
            entry["model_id"] = model_id
        if version_id is not None:
            entry["version_id"] = version_id
        out.append(entry)
    return out


__all__ = (
    "read_safetensors_metadata",
    "is_valid_safetensors_header",
    "trigger_words_from_metadata",
    "base_model_from_metadata",
    "find_preview_path",
    "is_preview_provably_corrupt",
    "civitai_name_for",
    "civitai_ids_for",
    "resolve_model_path",
    "list_models",
)
