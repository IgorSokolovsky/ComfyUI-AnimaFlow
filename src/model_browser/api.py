"""Guarded aiohttp routes for the shared model-browser library (docs/lora-
loader-design.md §7a-§7e, §9), following `src/anima/api.py`'s exact idiom
for the pure/impure split: a pure `*_impl(payload) -> dict` function per
route, importable and callable with no aiohttp/Request object anywhere --
what the plain-script tests in `tests/test_model_browser.py` actually
exercise -- with the aiohttp registration itself wrapped in a bare
`try/except Exception: pass` so importing this module OUTSIDE a live
ComfyUI process (this pack's own test suite, or anything else that imports
`src.model_browser` on its own) is a no-op rather than a crash.

Each route handler ALSO runs its `*_impl` call through
`loop.run_in_executor` before answering -- `src/autocomplete/api.py`'s
`/wtn/autocomplete`/`/wtn/classify` routes are the in-repo precedent for
this (same shape, same reasoning: real work must never run inline on
ComfyUI's single-threaded event loop). It matters most here for `/lookup`
and the M2 `/search`/`/download/*` routes below: any of them can make a
synchronous `urllib` call with up to a 30s timeout -- inline, that would
stall ComfyUI's ENTIRE HTTP/WS server (generation progress included) for
that whole window, which is exactly what design doc §9's "never block a
graph run" forbids. This is non-negotiable per the M2 brief: EVERY route,
including the trivial-looking `/download/progress`/`/download/cancel`,
goes through the same `run_in_executor` wrapping for consistency, even
though their own `*_impl` bodies are fast in-memory dict reads.

Every route answers HTTP 200 with a `reason` field, always -- the frontend
(not built in this slice) branches on `reason`, never on HTTP status, the
same contract §2b already commits to for the Civitai lookup specifically,
extended here to the whole surface so there's one rule, not one per route.

Routes (M1 -- local listing + the offline-capable Civitai hash lookup; the
`kind` whitelist below is the SAME security boundary `nodes/controls/
lora_loader.py`'s own state never needs to duplicate, because it's enforced
here, server-side, before anything touches a filesystem path):

    GET  /wtn/model_browser/list?kind=...
    POST /wtn/model_browser/lookup   {kind, name, force_refresh?}
    POST /wtn/model_browser/forget   {kind, name}
    GET  /wtn/model_browser/thumb?kind=...&name=...&max_edge=...

"Remove an installed model" (docs/TODO.md, owner decisions taken
2026-07-30) -- the first route in this pack that DESTROYS user data.
`kind` is whitelisted the SAME way as every route above; `name` goes
through the SAME `local.resolve_model_path` traversal/symlink guard, and
the actual deletion (model + sidecar + preview) is `remove.delete_model`'s
own job -- see that module's docstring for the full guarantee.

    POST /wtn/model_browser/delete   {kind, name}

The ⓘ backfill's own preview save (docs/lora-loader-design.md §7c-iv, "the
ⓘ backfill must save the image too") -- `lookup_impl`'s cache-miss path
writes metadata but never an image, so a model identified only through a
hash lookup re-fetches its thumbnail from Civitai on every render. This
route lets the frontend hand back the URL of the candidate it is ALREADY
displaying (level-filtered by construction) right after a lookup resolves;
see `lookup.save_preview`'s own docstring for the full contract (never
overwrites an existing preview, a failed fetch never fails the call, no
URL saves nothing).

    POST /wtn/model_browser/save_preview   {kind, name, preview_url}

M2 -- Civitai search + the streamed download queue (docs/lora-loader-
design.md §9). A GIVEN `kind` is whitelisted the SAME way on every one of
these; a download additionally re-validates the destination (`download.
resolve_destination_path`) and the source URL (`download.
is_allowed_download_url`) server-side even though the frontend is expected
to only ever offer values it already validated -- never trust the client
for a route that writes to disk.

M2b (docs/lora-loader-design.md §7c/"the modal") -- `/search`'s own `kind`
is now OPTIONAL: absent, it's the toolbar modal's UNSCOPED search (every
model type, no fixed destination), and an optional `types` list (the
modal's "Filter by Model Type" rail, §7c-i) is validated
(`civitai_search.clean_types`) rather than forwarded raw. `base_model` is
the OTHER multi-value rail filter ("Filter by Base Model") and, since
2026-07-31, shares `types`'s exact wire convention: read with `.getall`
(repeated `base_model=` query params, the SAME key the anchored panel's
own single-value filter already used) and cleaned by
`civitai_search.clean_base_models` before it ever reaches Civitai -- see
`search_impl`'s own docstring for the wire-contract bug this fixed (both
filters were silently no-ops: `types` because the modal comma-joined a
single value that then failed the enum check, `base_model` because the
modal sent it under an invented `base_models` plural key this route never
read at all). Every OTHER route below still REQUIRES a valid, whitelisted
`kind` -- unscoped applies to the search request only, since that's the
one route here that touches no filesystem path; `/download/start` and
every local-file route keep requiring one, because those actually
resolve/write a path.

    GET  /wtn/model_browser/search?kind=...&query=...&types=...&...
    POST /wtn/model_browser/download/start     {kind, subfolder, filename, download_url, size_kb?}
    GET  /wtn/model_browser/download/progress?job_id=...
    POST /wtn/model_browser/download/cancel    {job_id}

`/thumb` is Slice 3's own addition (docs/lora-loader-design.md §1a-v's
picker thumbnail) -- it's the one route here that answers with raw file
BYTES rather than a `{reason, ...}` JSON envelope (there is no JSON shape
for "here is an image"), so it is the one exception to this module's
"every route answers 200 with a `reason`" rule above: a 404 is the honest,
conventional answer for "no preview exists", and the frontend already
treats `has_preview: false` (from `/list`) as its OWN signal to never even
request this URL for that entry -- see `js/controls/civitai_api.mjs`'s
`thumbUrl`. Resolution goes through the EXACT SAME guarded path as every
other client-supplied `(kind, name)` pair in this package
(`local.resolve_model_path`, which whitelists `kind` via `folder_for_kind`
THEN verifies the resolved path's real location sits inside one of that
kind's configured directories) -- this route serves file bytes straight
off disk from a client-supplied name, so treating it as hostile input is
not optional.

Owner reversal, 2026-07-31: the saved preview file on disk is now the
ORIGINAL, untransformed image (`civitai_parse.saved_preview_url`), so
`/thumb` downscales it on the way OUT for the picker's small on-screen box
instead of serving it untouched (`downscale_thumb_bytes`/`thumb_bytes_impl`
above `thumb_path_impl`) -- Pillow (ships with ComfyUI, lazily imported,
never a hard dependency of this package) does the resize; its absence is a
silent fallback to the original bytes, never an error.
"""
from __future__ import annotations

import collections
import hashlib
import io
import logging
import mimetypes
import os
import urllib.parse
import uuid
from email.utils import formatdate
from typing import Any, Dict, Optional, Tuple

from . import civitai_search
from . import download
from . import keys
from . import logs as logs_mod
from . import lookup as lookup_mod
from . import rate_limit
from . import remove as remove_mod
from .kinds import folder_for_kind
from .local import find_preview_path, list_models, resolve_model_path

# One logger for the whole feature (`logs.py`'s own docstring) -- `search_impl`
# below is this module's one console-logging call site (task: "wire the
# model browser into the pack's existing console-logging setting"); every
# other route in this package logs through `download.py`/`lookup.py`
# instead, closer to where their own outcome is actually decided.
_logger = logging.getLogger(logs_mod.LOGGER_NAME)

_INVALID_KIND: Dict[str, Any] = {
    "reason": "invalid_kind",
    "message": "Unknown or unsupported model kind.",
}

# §9's "our own rate limiting on search, not just Civitai's" -- one search
# every 1.5s is generous for a single human clicking a 🔍 panel, and cheap
# insurance against "a stack of rows could fan out" (the brief's own
# phrasing) firing many searches at once.
_SEARCH_MIN_INTERVAL_SECONDS = 1.5
_SEARCH_LIMITER = rate_limit.MinIntervalLimiter(_SEARCH_MIN_INTERVAL_SECONDS)

# §9's "one download at a time (a serial queue)" -- a single process-wide
# manager; every `download_*_impl` function below goes through THIS
# instance, never constructs its own.
_DOWNLOAD_MANAGER = download.DownloadManager()


def list_models_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`GET /wtn/model_browser/list`'s pure body. `kind` is checked against
    the whitelist BEFORE anything touches `folder_paths` -- an
    unwhitelisted kind (including a traversal attempt like `"../../etc"`)
    never reaches path resolution at all, it's just a dict lookup that
    misses in `folder_for_kind`.
    """
    payload = payload or {}
    kind = payload.get("kind")
    if folder_for_kind(kind) is None:
        return {**_INVALID_KIND, "models": []}
    return {"reason": "ok", "models": list_models(kind)}


def lookup_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`POST /wtn/model_browser/lookup`'s pure body -- the Civitai hash
    lookup (§2b), cache-first via `lookup.lookup_model_info`. Same
    kind-whitelist-first guard as `list_models_impl`; past that, ALWAYS
    returns a `reason` of `found`/`notfound`/`offline`.

    `cached_only` (docs/lora-loader-design.md §7d/§7b decision 20) is a
    straight pass-through to `lookup_model_info`'s own flag of the same
    name -- when set, that function's control flow makes reaching Civitai's
    network entirely impossible for this call (see its own doc comment),
    which is what lets a caller with the "Civitai" setting off call this
    route AT ALL, for cached data only, without violating "no path left from
    which a request could originate."
    """
    payload = payload or {}
    kind = payload.get("kind")
    if folder_for_kind(kind) is None:
        return dict(_INVALID_KIND)
    name = payload.get("name")
    force_refresh = bool(payload.get("force_refresh", False))
    cached_only = bool(payload.get("cached_only", False))
    return lookup_mod.lookup_model_info(kind, name, force_refresh=force_refresh, cached_only=cached_only)


def forget_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`POST /wtn/model_browser/forget`'s pure body -- "Forget cached"
    (design doc §1a-i's ⓘ panel footer): delete the sidecar so info reverts
    to file-derived metadata.
    """
    payload = payload or {}
    kind = payload.get("kind")
    if folder_for_kind(kind) is None:
        return dict(_INVALID_KIND)
    name = payload.get("name")
    return {"reason": "ok", "deleted": lookup_mod.forget_cached(kind, name)}


def delete_model_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`POST /wtn/model_browser/delete`'s pure body -- "Remove an installed
    model" (docs/TODO.md, owner decisions taken 2026-07-30): destroys the
    model file `(kind, name)` resolves to, plus its `.civitai.info` sidecar
    and local preview image if either exists. Same kind-whitelist
    short-circuit as every route above; the actual guard (traversal,
    absolute path, Windows separator, a directory, a symlink escaping the
    kind's configured directories) is `remove.delete_model`'s own job, via
    the SAME `local.resolve_model_path` every other route already reuses --
    see that module's docstring for the full guarantee and reason
    vocabulary (`not_found` / `write_error` / `ok`).
    """
    payload = payload or {}
    kind = payload.get("kind")
    if folder_for_kind(kind) is None:
        return {**_INVALID_KIND, "removed": []}
    name = payload.get("name")
    return remove_mod.delete_model(kind, name)


def save_preview_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`POST /wtn/model_browser/save_preview`'s pure body -- docs/lora-
    loader-design.md §7c-iv, "the ⓘ backfill must save the image too". Same
    kind-whitelist short-circuit as every route above; the actual
    resolution/save is `lookup.save_preview`'s own job -- see that
    function's own docstring for the full contract (never overwrites an
    existing preview, a failed fetch never fails this call, no URL saves
    nothing).
    """
    payload = payload or {}
    kind = payload.get("kind")
    if folder_for_kind(kind) is None:
        return {**_INVALID_KIND, "saved": False, "detail": None, "path": None}
    name = payload.get("name")
    preview_url = payload.get("preview_url")
    return lookup_mod.save_preview(kind, name, preview_url)


def thumb_path_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`GET /wtn/model_browser/thumb`'s pure body -- resolves `(kind, name)`
    to a real, on-disk preview-image PATH (never opens or reads it -- the
    aiohttp handler below does the actual file read, itself offloaded to the
    executor same as this resolution step is). Always returns a `reason`,
    same contract as the other three `*_impl` functions, even though the
    route itself answers with raw bytes/404 rather than this dict directly:

      - `invalid_kind`  -- `kind` isn't in the whitelist (never touches
        `folder_paths`, same short-circuit as every other route here);
      - `not_found`     -- `kind` is valid but `name` doesn't resolve to a
        real file inside that kind's configured directories (the SAME
        traversal guard as `list_models_impl`/`lookup_impl`, via
        `local.resolve_model_path`);
      - `no_preview`    -- the model file itself is real, but no preview
        image sits next to it (`local.find_preview_path` found nothing);
      - `ok`            -- `path` is a real preview-image file to serve.
    """
    payload = payload or {}
    kind = payload.get("kind")
    if folder_for_kind(kind) is None:
        return {**_INVALID_KIND, "path": None}
    name = payload.get("name")
    model_path = resolve_model_path(kind, name)
    if model_path is None:
        return {"reason": "not_found", "message": "No such model file.", "path": None}
    preview_path = find_preview_path(model_path)
    if preview_path is None:
        return {"reason": "no_preview", "message": "No local preview image for this file.", "path": None}
    return {"reason": "ok", "path": preview_path}


# ---------------------------------------------------------------------------
# `/thumb` downscale-on-serve (owner, 2026-07-31): "save the ORIGINAL image
# on disk, and downscale when serving it to a small UI box" -- see
# `civitai_parse.saved_preview_url`'s own docstring for the save-time half
# of this reversal. A saved preview can now genuinely be a multi-MB PNG
# (the untransformed Civitai source), and this route serves it into the
# picker's ~40px box -- decoding that at full size for every row in a
# fifty-LoRA folder would be ~200 MB of unnecessary work. So THIS route
# downscales on the way out; the file on disk is never touched.
# ---------------------------------------------------------------------------

# Sane default long edge for a 40-58px picker box at 2x DPI -- matches
# `civitai_parse.LIVE_THUMB_TRANSFORM`'s own `width=256`, so the two
# in-app thumbnail paths (the Civitai-sourced live one and this
# locally-served one) land on the same effective resolution. An optional
# `max_edge` query param can override it; no frontend change is required
# for this to be correct on its own (see `_route_thumb` below).
DEFAULT_THUMB_MAX_EDGE = 256

# Process-wide, bounded LRU cache of ALREADY-DOWNSCALED bytes, keyed by
# `(path, mtime, max_edge)`. Deliberately module-level -- unlike `12625c0`
# ("the loader model cache belongs to the node, not the module"), which had
# to move a cache OFF a module global because two different Loader Panel
# NODE INSTANCES hold two different real MODEL/VAE/CLIP objects that must
# not evict each other. There is no such per-instance identity here: this
# cache holds nothing but re-encoded bytes of a file already on disk, and
# the SAME `(path, mtime, max_edge)` always decodes to the SAME bytes no
# matter which request or node asked -- sharing it across every request is
# the entire point (a picker scroll re-requesting the same fifty thumbnails
# should hit this cache instead of re-decoding each one). `mtime` in the key
# means a file replaced on disk (re-download, hand-swapped preview) is
# picked up with no explicit invalidation -- the old key just stops being
# requested and eventually falls out of the bound below. Bounded so a long
# session can't grow this into an unbounded leak.
_THUMB_CACHE_MAX_ENTRIES = 256
_thumb_downscale_cache: "collections.OrderedDict[Tuple[str, float, int], bytes]" = collections.OrderedDict()


def _thumb_cache_get(key: Tuple[str, float, int]) -> Optional[bytes]:
    """Read-through LRU lookup -- a hit is moved to the end so the eviction
    order in `_thumb_cache_put` below is genuinely least-recently-USED, not
    merely least-recently-inserted."""
    cached = _thumb_downscale_cache.get(key)
    if cached is not None:
        _thumb_downscale_cache.move_to_end(key)
    return cached


def _thumb_cache_put(key: Tuple[str, float, int], data: bytes) -> None:
    """Insert-or-replace `key`, then evict the oldest entries past
    `_THUMB_CACHE_MAX_ENTRIES` -- the bound that keeps this a cache rather
    than a leak."""
    _thumb_downscale_cache[key] = data
    _thumb_downscale_cache.move_to_end(key)
    while len(_thumb_downscale_cache) > _THUMB_CACHE_MAX_ENTRIES:
        _thumb_downscale_cache.popitem(last=False)


def _load_pillow_image_module() -> Any:
    """Lazy import of `PIL.Image` -- returns the module, or `None` if
    Pillow isn't installed. Called ONLY from inside `downscale_thumb_bytes`
    below, NEVER at module import time: `src/model_browser` must stay
    importable with no ComfyUI AND no Pillow installed (this repo's own
    test environment has neither -- `import PIL` fails here, verified --
    which is exactly what lets this suite run at all).
    """
    try:
        from PIL import Image
    except ImportError:
        return None
    return Image


def downscale_thumb_bytes(
    data: bytes,
    max_edge: int = DEFAULT_THUMB_MAX_EDGE,
    *,
    image_module: Any = None,
) -> Optional[bytes]:
    """Shrinks `data` (a whole image file's raw bytes) so its longer edge is
    at most `max_edge` pixels, preserving aspect ratio, and re-encodes to
    the SAME format the source already used. Returns `None` on ANY failure
    -- corrupt/unrecognised bytes, an unexpected decode error, or Pillow not
    being installed at all -- so a caller (`thumb_bytes_impl` below) can
    fall back to serving the original bytes unchanged: a degraded-but-
    working thumbnail beats a broken route, and this fallback must be
    silent, not an error response.

    Never upscales: `Image.thumbnail` below only ever shrinks (its own
    documented contract, never enlarges past the source's real size), so a
    source already smaller than `max_edge` comes back re-encoded at its
    original size rather than stretched up to it.

    `image_module` is the injected imaging seam: production leaves it
    `None` and this function lazily imports `PIL.Image` for itself
    (`_load_pillow_image_module`, never at module scope -- see that
    function's own docstring). Pillow itself is NOT importable in this
    repo's test environment (verified: `import PIL` fails here), so tests
    substitute a small stub exposing an `.open()` compatible with what this
    function calls -- the seam that lets the actual downscale PATH be
    exercised here, not merely its no-Pillow fallback.
    """
    if image_module is None:
        image_module = _load_pillow_image_module()
    if image_module is None:
        return None
    try:
        img = image_module.open(io.BytesIO(data))
        img.load()
        fmt = (img.format or "PNG").upper()
        img.thumbnail((max_edge, max_edge))
        if fmt == "JPEG" and img.mode not in ("RGB", "L"):
            # JPEG has no alpha channel -- a source PNG/GIF re-encoded to
            # JPEG (its own reported format was JPEG but decoded to a mode
            # JPEG can't save, seen on some CMYK/paletted sources) needs an
            # explicit RGB conversion or `.save` raises.
            img = img.convert("RGB")
        out = io.BytesIO()
        img.save(out, format=fmt)
        return out.getvalue()
    except Exception:  # noqa: BLE001 - best-effort only, must never raise
        return None


def thumb_bytes_impl(
    path: str,
    *,
    max_edge: int = DEFAULT_THUMB_MAX_EDGE,
    image_module: Any = None,
) -> bytes:
    """Reads `path` (already resolved and validated by `thumb_path_impl`
    above) and returns the bytes to actually SERVE for
    `GET /wtn/model_browser/thumb`: the original file downscaled to
    `max_edge`'s longer edge when Pillow is available, or the untouched
    original bytes when it isn't (`downscale_thumb_bytes` returning `None`
    -- a silent, tested fallback, never an error).

    Never rewrites `path` on disk -- this is a SERVE-time-only transform,
    the entire point of the owner's 2026-07-31 reversal (see this module's
    own "`/thumb` downscale-on-serve" comment above `DEFAULT_THUMB_MAX_
    EDGE`). Cached in memory keyed by `(path, mtime, max_edge)`
    (`_thumb_cache_get`/`_thumb_cache_put`) so repeat requests for the same
    file at the same size -- a picker scrolling past the same rows again --
    never re-read or re-decode anything.
    """
    mtime = os.path.getmtime(path)
    key = (path, mtime, max_edge)
    cached = _thumb_cache_get(key)
    if cached is not None:
        return cached

    with open(path, "rb") as fh:
        original = fh.read()

    downscaled = downscale_thumb_bytes(original, max_edge, image_module=image_module)
    result = downscaled if downscaled is not None else original
    _thumb_cache_put(key, result)
    return result


# ---------------------------------------------------------------------------
# `/thumb` HTTP caching (owner, live-measured 2026-07-31): "seems cache is
# not working, thumb is called each 1-2 sec" -- the route answered with NO
# validator at all (no `ETag`/`Last-Modified`/`Cache-Control`), so a browser
# has nothing to revalidate against and re-downloads on essentially every
# render. Fixed with real conditional-GET support below, kept in agreement
# with the in-process downscale cache's own `(path, mtime, max_edge)` key
# just above -- both answer the same question, "what determines the bytes".
# ---------------------------------------------------------------------------

# A preview file can genuinely be replaced out from under this route --
# `save_preview` overwrites it, and so does a fresh download -- so a NAIVE
# long `max-age` risks serving a stale image after either. That risk is
# already closed by the ETag being mtime-derived: replacing the file always
# mints a new tag, so the very next conditional request misses and gets the
# new bytes. Given that, `max-age=60` is safe AND is what actually fixes the
# reported symptom -- a picker reopened/scrolled within a minute now costs
# the browser zero network round trips instead of a full re-decode every
# 1-2s. `must-revalidate` makes the 60s boundary a hard one (no serving
# stale-while-revalidating past it) rather than "stale but usable".
#
# `private`, deliberately NOT `public` -- this route's bytes are read
# straight out of the user's own model folders, and this pack is routinely
# reached through a public tunnel (pinggy) rather than plain localhost --
# that's how the owner runs it, and how they reported this very bug.
# `public` licenses ANY shared cache sitting between the browser and this
# server (the tunnel, a corporate proxy, whatever else is in the path) to
# store and re-serve that content; `private` confines reuse to the
# requesting browser's own cache, which is all the fix actually needs --
# the ETag + `max-age=60` are already doing the real work here, so `public`
# would buy close to nothing while quietly opting local filesystem content
# into being cached by an intermediary. Don't "optimise" this back to
# `public`.
THUMB_CACHE_CONTROL = "private, max-age=60, must-revalidate"

# The 404 case ("no preview for this file" -- the common case for a model
# never looked up) must NOT be cacheable as though it were a real image:
# a save_preview call minutes later would otherwise stay invisible to a
# browser that cached the miss. `no-store` is unambiguous -- no freshness
# window to reason about, no validator to (mis)reuse.
THUMB_404_CACHE_CONTROL = "no-store"


def thumb_stat_impl(path: str) -> Optional[Tuple[float, int]]:
    """`os.stat`-only pure(ish) helper for the `/thumb` route's conditional-
    GET check -- returns `(mtime, size)`, or `None` if `path` vanished
    between `thumb_path_impl` resolving it and this call (a benign race:
    `forget`/`delete`/a re-download racing a render, same shape as every
    other filesystem race already tolerated elsewhere in this module).
    Deliberately separate from `thumb_bytes_impl`'s own `os.path.getmtime`
    call so the route can decide "304, do nothing else" BEFORE paying for
    the read+downscale that function does -- the whole point of a
    conditional GET is skipping that work, not just skipping the response
    body.
    """
    try:
        stat_result = os.stat(path)
    except OSError:
        return None
    return (stat_result.st_mtime, stat_result.st_size)


def thumb_etag(mtime: float, size: int, max_edge: int) -> str:
    """Builds a quoted HTTP `ETag` for `/thumb` from exactly the three
    things that determine the bytes actually served: the source file's
    `mtime` and `size` (replacing the file -- `save_preview`, a re-download,
    a hand-swapped preview -- changes at least one of these), and
    `max_edge` (the SAME file served at two sizes is two different
    payloads -- easy to miss, non-negotiable per the fix brief). Matches
    the in-process downscale cache's own `(path, mtime, max_edge)` key
    above; `path` itself isn't part of the tag because HTTP already scopes
    an `ETag` to the URL that answered it, and this route's URL already
    encodes `(kind, name)`.
    """
    digest = hashlib.sha1(f"{mtime!r}:{size}:{max_edge}".encode("ascii")).hexdigest()
    return f'"{digest}"'


def if_none_match_hits(if_none_match: Optional[str], etag: str) -> bool:
    """True if the request's `If-None-Match` header value -- a single tag,
    a comma-separated list of tags (RFC 7232 §3.2), or `*` -- already
    covers `etag`, meaning the route should answer `304` instead of
    resending the body. Weak (`W/`-prefixed) tags are compared by their
    underlying value on either side: a weak match is exactly what a
    conditional GET for a resource like this (never a "must be byte-
    identical" use case) should accept.
    """
    if not if_none_match:
        return False
    normalised_etag = etag[2:] if etag.startswith("W/") else etag
    for candidate in if_none_match.split(","):
        candidate = candidate.strip()
        if candidate == "*":
            return True
        normalised_candidate = candidate[2:] if candidate.startswith("W/") else candidate
        if normalised_candidate == normalised_etag:
            return True
    return False


def thumb_last_modified(mtime: float) -> str:
    """RFC 7231 `Last-Modified` formatting for `mtime` -- cheap alongside
    the `ETag` and helps any proxy in the path (the deployment goes through
    a tunnel, so this is not theoretical) make its own freshness decision
    without re-asking this route.
    """
    return formatdate(mtime, usegmt=True)


# ---------------------------------------------------------------------------
# M2 -- Civitai search (docs/lora-loader-design.md §9's own network policy).
# ---------------------------------------------------------------------------


def _annotate_search_results(results: list, kind: object) -> list:
    """Adds the disk-touching fields `civitai_search.parse_search_response`
    deliberately leaves out (that function stays pure/offline-testable --
    see its own docstring): per-file `installed` (decision 2: "already on
    disk => no download"), then a `file_name`/`download_url`/`size_kb`/
    `gated`/`installed` set on EVERY version (docs task 2026-07-31, "Civitai
    search panel version picker") -- not just the primary one -- so a
    version-selector frontend can render any version's own download
    affordance, not only `versions[0]`'s.

    docs/lora-loader-design.md M2b task 2 -- each RESULT also gets its own
    `kind` field: the kind it would actually land in, so the frontend can
    render an honest "can't download this type here" state instead of a
    button that fails.

      - `kind` GIVEN (either node-embedded picker, a locked search) -- every
        result uses that SAME fixed kind for both the `installed` check AND
        the new `kind` field, exactly as before this task (no regression):
        a locked search's own `types` filter already means every result IS
        that kind, so there's nothing to derive.
      - `kind` is `None` (the modal's unscoped search) -- there is no fixed
        kind to fall back on, so EACH result's own Civitai `type` decides,
        via `civitai_search.kind_for_type` -- `None` when we have no folder
        for that type at all, in which case the `installed` check also sees
        `None` (`download.destination_exists(None, ...)` -- always `False`,
        matching "we don't even know where this would go" rather than
        guessing a folder to check).

    The top-level `primary_*`/`file_name`/`download_url`/`size_kb`/`gated`/
    `installed`/`triggers`/`preview_url`/`images` convenience set on each
    RESULT is then READ STRAIGHT OFF `versions[0]`'s own just-computed
    fields, never recomputed independently -- one code path computes every
    version's download affordance (including the primary one), and the
    top-level flatten is nothing more than picking `versions[0]`'s copy of
    it back up. Before this, the top level had its OWN
    `pick_primary_file`/`bool(...)` calls duplicating this exact logic --
    two code paths for the same numbers can drift; this one can't, because
    there's only one.

    The `installed` check always uses the (fixed-or-derived) kind's ROOT
    (`subfolder=""`) -- the default destination (decision 1) -- since a
    search result has no subfolder of its own to check until a user picks
    one at download time; a LoRA a user keeps in a custom subfolder will
    show as downloadable again here even though it's technically already on
    disk elsewhere. This is a known, documented approximation, not an
    oversight.
    """
    for result in results:
        result_kind = kind if kind is not None else civitai_search.kind_for_type(result.get("type"))
        result["kind"] = result_kind

        versions = result.get("versions") or []
        for version in versions:
            for file in version.get("files", []):
                file["installed"] = download.destination_exists(result_kind, "", file.get("name"))

            # This version's own chosen file -- computed for EVERY version,
            # not just the primary one, so a version-selector card can show
            # any version's download affordance. `gated`/`installed` default
            # to `False` with no primary file, matching the exact fallback
            # the (now-removed) top-level-only computation used to apply --
            # see this function's own docstring for why the top level no
            # longer has a second copy of this rule to keep in sync.
            version_primary_file = civitai_search.pick_primary_file(version.get("files"))
            version["file_name"] = version_primary_file.get("name") if version_primary_file else None
            version["download_url"] = version_primary_file.get("download_url") if version_primary_file else None
            version["size_kb"] = version_primary_file.get("size_kb") if version_primary_file else None
            # `gated`/`installed` are two of the flags the CORRECTION's four
            # card states are built from (state 4 "gated"/state 1
            # "installed") -- first-class outcomes computed here, not
            # inferred client-side.
            version["gated"] = bool(version_primary_file.get("gated")) if version_primary_file else False
            version["installed"] = bool(version_primary_file.get("installed")) if version_primary_file else False

        primary_version = versions[0] if versions else None

        # BUG (pre-existing, left alone -- out of scope for this task):
        # `""` rather than an absent key when unknown, even though the
        # PARSER (`civitai_search._parse_search_item`) deliberately omits
        # this key entirely in that case ("omit rather than invent",
        # §1a-vi). The frontend already handles the empty string, and
        # changing it would touch behaviour this task isn't asking for.
        result["base_model"] = primary_version["base_model"] if primary_version else ""
        result["primary_version_id"] = primary_version["version_id"] if primary_version else None
        # Every one of these now reads STRAIGHT OFF `versions[0]`'s own
        # just-computed fields above -- see this function's own docstring.
        result["file_name"] = primary_version.get("file_name") if primary_version else None
        result["download_url"] = primary_version.get("download_url") if primary_version else None
        result["size_kb"] = primary_version.get("size_kb") if primary_version else None
        result["gated"] = primary_version.get("gated", False) if primary_version else False
        result["installed"] = primary_version.get("installed", False) if primary_version else False
        # 2026-07-30 "no info sidecar, no preview image" fix: flattened onto
        # the result the SAME way `base_model`/`file_name`/`download_url`
        # already are, so the frontend can hand them straight back on
        # `/download/start` (`civitai_meta`/`preview_url` below) with no
        # second lookup -- "the search result we already hold carries image
        # URLs -- reuse them rather than making a fresh API call".
        result["triggers"] = primary_version.get("triggers", []) if primary_version else []
        result["preview_url"] = primary_version.get("preview_url") if primary_version else None
        # docs/lora-loader-design.md §7c-iv (2026-07-31): replaces the old
        # single pre-chosen `thumb_url` -- the version's full gallery
        # CANDIDATE list, ordered exactly as Civitai returned it and already
        # thumbnail-rewritten (`civitai_search._parse_images`), flattened up
        # the SAME way `preview_url`/`triggers` already are. The frontend
        # picks the first entry at or below the user's chosen browsing
        # level (a setting this route has no access to at the per-image
        # level -- see `search_impl`'s own `level` handling for the ONE
        # thing that IS server-side: whether adult images are in this list
        # at all).
        result["images"] = primary_version.get("images", []) if primary_version else []
    return results


def _search_query_to_payload(query: Any) -> Dict[str, Any]:
    """`GET /wtn/model_browser/search`'s QUERY STRING -> `search_impl`'s
    payload dict -- pulled out of `_route_search` below into its own
    function so this parsing step is unit-testable against a REAL, encoded
    query string with no aiohttp installed at all (this repo's own test
    environment has neither `aiohttp` nor `multidict` -- verified). `query`
    only needs to duck-type the two methods `aiohttp`'s own
    `MultiDictProxy` (`request.query`) exposes and this function calls --
    `.get(key, default)` and `.getall(key, default)` --
    `tests/test_model_browser.py`'s own fake wraps stdlib `urllib.parse.
    parse_qs` for exactly that, so the SAME assertions that pin this
    route's wire contract run against this pure function with no extra
    dependency.

    `types`/`base_model` are BOTH read via `.getall` -- the fix for the
    M2b wire-contract bug (2026-07-31): the frontend's
    `civitai_api.mjs` sends repeated `types=`/`base_model=` pairs for BOTH
    multi-value filters (never comma-joined, and never an invented
    `base_models` plural), so this side reads them the same way
    `civitai_search.build_search_url` writes them -- one key, one meaning,
    one-or-many values, for both filters alike. A single value (the
    anchored panel's own `base_model=X`) arrives here as a ONE-ELEMENT
    list; `search_impl`/`civitai_search.build_search_url` (see that
    function's own docstring) treat that identically to how the old
    single-value code path worked, so the anchored panel's own behaviour
    is unchanged, byte for byte.
    """
    limit_raw = query.get("limit")
    return {
        # `kind` is OPTIONAL (M2b, docs/lora-loader-design.md §7c/"the
        # modal") -- absent (`None`) is an unscoped search, not
        # `invalid_kind`; `search_impl` is what draws that distinction.
        "kind": query.get("kind"),
        "query": query.get("query", ""),
        # `types` (the modal's "Filter by Model Type" rail, §7c-i) is
        # MULTI-VALUE -- `getall` collects every repeated `types=` pair
        # from the query string, same convention `civitai_search.
        # build_search_url` emits one on the way out. `search_impl`/
        # `civitai_search.clean_types` validate it; this function never
        # forwards it unchecked.
        "types": list(query.getall("types", [])),
        # `base_model` (the modal's "Filter by Base Model" rail, AND the
        # anchored panel's own single-value filter -- one key, shared by
        # both) is ALSO multi-value, same `.getall` convention as `types`
        # immediately above -- see this function's own docstring for the
        # bug this replaces.
        "base_model": list(query.getall("base_model", [])),
        "sort": query.get("sort") or None,
        "period": query.get("period") or None,
        # docs/lora-loader-design.md §7c-iv: raw string straight through,
        # same "let the pure layer validate/default it" pattern
        # `sort`/`period` above already use -- `search_impl`'s
        # `civitai_search.clean_level` is what actually falls back to
        # PG for a missing/garbage value, not this function.
        "level": query.get("level"),
        "cursor": query.get("cursor") or None,
        "limit": int(limit_raw) if limit_raw and limit_raw.isdigit() else civitai_search.DEFAULT_LIMIT,
    }


def search_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`GET /wtn/model_browser/search`'s pure-enough body (touches local
    disk for the `installed` annotation and the network for the search
    itself -- "pure" here means "callable directly with a payload dict",
    the same sense `lookup_impl` already uses, not "no I/O").

    Always returns `{"reason": ..., "message": str, "results": [...],
    "next_cursor": str|None, "public_only": bool}`:

      - `invalid_kind`   -- a GIVEN but unwhitelisted `kind` -- same
        whitelist short-circuit as every route here;
      - `rate_limited`   -- §9's own rate limiter refused this call (never
        Civitai's 429 -- that one surfaces as `offline`/`rate_limited` from
        `civitai_search.search_models` itself, kept distinct on purpose);
      - `offline`        -- the search request itself failed (see
        `offline_reason` for the specific cause, same vocabulary as
        `civitai_client`);
      - `ok`             -- `results`/`next_cursor` are populated.

    docs/lora-loader-design.md M2b task 1 -- `payload["kind"]` is now
    OPTIONAL, reflecting the toolbar modal's UNSCOPED search (§7c: "the
    modal ... answers to nobody"). `None`/absent is NOT `invalid_kind` --
    it means "every model type", and skips the whitelist check entirely
    (there's nothing to whitelist). A GIVEN `kind` is still validated
    exactly as before this task (unchanged behaviour, no regression) --
    this route resolves paths downstream (the `installed` check), so a
    GIVEN kind is never trusted raw regardless of how permissive the
    unscoped case is.

    `payload["types"]` (the modal's "Filter by Model Type" rail, §7c-i) is
    the multi-value Civitai `types` filter for an UNSCOPED search only --
    ignored when `kind` is given (the picker's `kind` already locks the
    type; §7c-i: "type ... locked to the caller's kind"). Passed straight
    to `civitai_search.search_models`, which validates it
    (`civitai_search.clean_types`) before it ever reaches the wire -- this
    route never does that validation itself, so there is exactly one place
    it happens.

    `payload["base_model"]` (the modal's "Filter by Base Model" rail, AND
    the anchored panel's own single-value filter -- ONE key, shared by
    both callers) is ALWAYS a list, never a bare string: `_route_search`
    below reads it with `.getall`, the SAME multi-value convention `types`
    already uses, so a caller with one value (the anchored panel) arrives
    here as a one-element list and a caller with several (the modal)
    arrives as several -- no special-casing either shape. Passed straight
    to `civitai_search.search_models`, same "validated downstream, not
    here" discipline as `types` (`civitai_search.clean_base_models`).
    Fixed 2026-07-31 -- see `civitai_search.clean_base_models`'s own
    docstring for the wire-contract bug this replaces (a comma-joined
    value under an invented `base_models` plural key nothing ever read).

    `public_only` (the CORRECTION's "no API key set -- public results only"
    banner) is set from `keys.resolve_api_key()` on EVERY branch, including
    failures -- the frontend can show that banner regardless of whether the
    search itself succeeded. The key's VALUE never appears anywhere in this
    return.

    docs/lora-loader-design.md §7c-iv: `payload["level"]` is the "Maximum
    browsing level" setting (PG=1/PG-13=2/R=4/X=8/XXX=16), not an `nsfw`
    bool -- `civitai_search.clean_level` validates it (garbage/missing
    falls back to PG, same tolerance `sort`/`period` already get). It maps
    to Civitai's own binary `nsfw` request parameter exactly once, right
    here: PG (`level == 1`) sends `nsfw=false` -- the one genuine server-
    side guarantee, we never ask for adult content at all -- and every
    level above PG sends `nsfw=true`, since Civitai has no request
    parameter for a specific level (measured: `browsingLevel=31`/`nsfw=16`/
    `nsfw=X` are all HTTP 400) -- the full gallery comes back and
    per-image/per-model filtering to the chosen level is the FRONTEND's job
    against `nsfw_level`/`images[].nsfw_level` (§7c-iv's own "Build notes").
    """
    payload = payload or {}
    kind = payload.get("kind")
    query = payload.get("query") or ""
    if kind is not None and folder_for_kind(kind) is None:
        # Debug-only: the ONE extra thing worth knowing about this
        # short-circuit beyond the summary line below (task: "the reason
        # short-circuits (invalid_kind, rate_limited)") -- which kind was
        # rejected, since the summary's `reason=invalid_kind` alone doesn't
        # say what was actually sent.
        logs_mod.log_debug(_logger, logs_mod.format_search_shortcircuit_debug, reason="invalid_kind", detail=f"kind={kind!r}")
        logs_mod.log_summary(_logger, logs_mod.format_search_summary, kind=kind, query=query, count=0, reason="invalid_kind")
        return {**_INVALID_KIND, "results": [], "next_cursor": None, "public_only": True}

    resolved_key = keys.resolve_api_key()

    if not _SEARCH_LIMITER.allow():
        logs_mod.log_debug(
            _logger, logs_mod.format_search_shortcircuit_debug,
            reason="rate_limited", detail=f"minimum interval is {_SEARCH_MIN_INTERVAL_SECONDS}s",
        )
        logs_mod.log_summary(_logger, logs_mod.format_search_summary, kind=kind, query=query, count=0, reason="rate_limited")
        return {
            "reason": "rate_limited",
            "message": "Searching too quickly -- wait a moment and try again.",
            "results": [], "next_cursor": None,
            "public_only": resolved_key.public_only,
        }

    level = civitai_search.clean_level(payload.get("level"))

    result = civitai_search.search_models(
        kind,
        query,
        types=payload.get("types"),
        # `payload["base_model"]` is always a LIST (see this function's own
        # docstring) -- an empty one (`[]`, the common "no filter" case)
        # collapses to `None` here, same "omit rather than send an empty
        # filter" convention `query`/`sort`/`period`/`cursor` below already
        # follow; a non-empty list rides straight through to
        # `civitai_search.search_models`/`clean_base_models` unchanged.
        base_model=payload.get("base_model") or None,
        sort=payload.get("sort") or civitai_search.DEFAULT_SORT,
        period=payload.get("period") or civitai_search.DEFAULT_PERIOD,
        nsfw=level > 1,
        cursor=payload.get("cursor") or None,
        limit=payload.get("limit", civitai_search.DEFAULT_LIMIT),
        api_key=resolved_key.api_key,
    )
    if result["reason"] != "found":
        logs_mod.log_summary(
            _logger, logs_mod.format_search_summary, kind=kind, query=query, count=0, reason=result["reason"],
        )
        return {
            "reason": result["reason"],
            "message": result.get("message", ""),
            "offline_reason": result.get("offline_reason"),
            "results": [], "next_cursor": None,
            "public_only": resolved_key.public_only,
        }

    parsed = civitai_search.parse_search_response(result["data"])
    results = _annotate_search_results(parsed["results"], kind)
    logs_mod.log_summary(
        _logger, logs_mod.format_search_summary, kind=kind, query=query, count=len(results), reason="ok",
    )
    return {
        "reason": "ok",
        "message": "",
        "results": results,
        "next_cursor": parsed["next_cursor"],
        "public_only": resolved_key.public_only,
    }


# ---------------------------------------------------------------------------
# M2 -- the streamed download queue (docs/lora-loader-design.md §9).
# ---------------------------------------------------------------------------


def download_start_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`POST /wtn/model_browser/download/start`'s body. Every input is
    re-validated server-side even though the frontend is only ever expected
    to offer values it already validated -- this route WRITES to disk, so
    the client is never trusted (§ "the security part that matters most").

      - `invalid_kind`        -- unwhitelisted `kind`;
      - `invalid_destination` -- `subfolder`/`filename` don't resolve to a
        safe path under the kind's configured root (`download.
        resolve_destination_path`: traversal, absolute path, Windows
        separator, bad extension, ...);
      - `already_installed`   -- decision 2: the destination file already
        exists -- no download, and the frontend is expected to have hidden
        the button already; this is the server-side enforcement of that
        rule, not merely a client convenience;
      - `invalid_url`         -- `download_url` isn't HTTPS on one of
        Civitai's own two hosts (`download.is_allowed_download_url`) --
        closes the "fetch-and-write an arbitrary URL" SSRF vector;
      - `too_large`           -- the caller's OWN advisory `size_kb` (from
        the search result) already exceeds the cap -- a fast, pre-flight
        rejection; `stream_download`'s own live byte-counting cap is the
        one that actually matters (a lying/absent `size_kb` doesn't skip
        it), this is just an early exit;
      - `busy`                -- another download is already running (the
        serial-queue rule) -- `download.DownloadManager.start`'s own
        result, passed through;
      - `started`             -- `job_id` is set; poll `/download/progress`.

    The resolved API key (if any) is appended to `download_url` as a
    `?token=` query parameter ONLY here, server-side, right before the
    fetch starts -- never returned in this function's own result, and
    `civitai_search.search_models`'s docstring has the same "never logged"
    note for the identical technique used there.

    Three further OPTIONAL fields feed the 2026-07-30 "no info sidecar, no
    preview image" fix -- all best-effort, none of them can turn a
    successful download into a reported failure (`download.
    finalize_successful_download`'s own docstring has the full contract):

      - `civitai_meta`  -- whatever OUR OWN normalized search-result fields
        (`model_id`, `version_id`, `name`, `type`, `base_model`, `tags`,
        `triggers` -- exactly `_annotate_search_results`'/`civitai_search.
        parse_search_response`'s own shape) the caller already holds from
        the `/search` response for this exact result, so the `.civitai.info`
        sidecar can be written from data already in hand, with NO fresh
        hash/fetch. Non-dict is treated as absent.
      - `preview_url`   -- the community image URL `_annotate_search_
        results` already flattened onto the search result -- reused as-is
        for the local preview save, never a fresh API call for it.
      - `civitai_enabled` (default `True`, matching "no flag sent" = the
        behaviour before this fix existed) -- mirrors `lookup_impl`'s own
        `cached_only` convention: an explicit `False` (the "Civitai" ⚙/
        Settings switch being off) makes the preview-image FETCH
        unreachable, never merely unused -- writing the sidecar from data
        already held is not a network call, so it is not gated by this flag.
    """
    payload = payload or {}
    kind = payload.get("kind")
    if folder_for_kind(kind) is None:
        return {**_INVALID_KIND, "job_id": None}

    filename = payload.get("filename")
    subfolder = payload.get("subfolder")
    source_url = payload.get("download_url")

    dest_path = download.resolve_destination_path(kind, subfolder, filename)
    if dest_path is None:
        return {"reason": "invalid_destination", "message": "That file name or destination folder isn't allowed.", "job_id": None}

    if download.destination_exists(kind, subfolder, filename):
        return {"reason": "already_installed", "message": "This file is already on disk.", "job_id": None}

    if not download.is_allowed_download_url(source_url):
        return {"reason": "invalid_url", "message": "Refusing an untrusted download URL.", "job_id": None}

    max_bytes = download.DEFAULT_MAX_DOWNLOAD_BYTES
    size_kb = payload.get("size_kb")
    if isinstance(size_kb, (int, float)) and not isinstance(size_kb, bool) and size_kb * 1024 > max_bytes:
        return {"reason": "too_large", "message": f"This file exceeds the {max_bytes}-byte cap.", "job_id": None}

    resolved_key = keys.resolve_api_key()
    fetch_url = source_url
    if resolved_key.api_key:
        separator = "&" if "?" in fetch_url else "?"
        fetch_url = f"{fetch_url}{separator}token={urllib.parse.quote(resolved_key.api_key)}"

    civitai_meta = payload.get("civitai_meta")
    preview_url = payload.get("preview_url")

    job_id = uuid.uuid4().hex
    start_result = _DOWNLOAD_MANAGER.start(
        job_id, fetch_url, dest_path, max_size_bytes=max_bytes,
        civitai_meta=civitai_meta if isinstance(civitai_meta, dict) else None,
        preview_url=preview_url if isinstance(preview_url, str) and preview_url else None,
        civitai_enabled=bool(payload.get("civitai_enabled", True)),
    )
    if start_result["reason"] != "started":
        return {**start_result, "job_id": None}
    return {"reason": "started", "message": "", "job_id": job_id}


def download_progress_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`GET /wtn/model_browser/download/progress`'s body -- a thin
    passthrough to `_DOWNLOAD_MANAGER.progress`, itself just a lock-guarded
    in-memory dict read (see that method's own docstring for the shape)."""
    payload = payload or {}
    return _DOWNLOAD_MANAGER.progress(payload.get("job_id"))


def download_cancel_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`POST /wtn/model_browser/download/cancel`'s body -- a thin
    passthrough to `_DOWNLOAD_MANAGER.cancel`."""
    payload = payload or {}
    return _DOWNLOAD_MANAGER.cancel(payload.get("job_id"))


try:
    import asyncio
    import functools

    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/wtn/model_browser/list")
    async def _route_list(request):  # noqa: ANN001 - aiohttp handler signature
        # Offload to the default executor's worker-thread pool, same R5-style
        # fix `src/autocomplete/api.py`'s `/wtn/autocomplete`/`/wtn/classify`
        # routes already apply: `list_models_impl` does real filesystem I/O
        # (an `os.listdir`-scale scan plus a safetensors-header read per
        # file), which must never run inline on the event-loop thread.
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None, functools.partial(list_models_impl, {"kind": request.query.get("kind")})
        )
        return web.json_response(result, status=200)

    @routes.post("/wtn/model_browser/lookup")
    async def _route_lookup(request):  # noqa: ANN001 - aiohttp handler signature
        payload = await request.json()
        # THE offload that matters most on this route: `lookup_impl` can
        # chunk-hash a multi-GB file AND make a synchronous `urllib` HTTP
        # call with up to a 30s timeout (§2b) -- run either of those inline
        # on the event loop and ComfyUI's entire HTTP/WS server (generation
        # progress included, not just this node) stalls for that whole
        # window, directly violating design doc §9's "never block a graph
        # run". Same `run_in_executor` shape as `/wtn/autocomplete` above.
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, functools.partial(lookup_impl, payload))
        return web.json_response(result, status=200)

    @routes.post("/wtn/model_browser/forget")
    async def _route_forget(request):  # noqa: ANN001 - aiohttp handler signature
        payload = await request.json()
        # `forget_impl` deletes a sidecar file -- disk I/O, same offload
        # reasoning as the two routes above.
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, functools.partial(forget_impl, payload))
        return web.json_response(result, status=200)

    @routes.post("/wtn/model_browser/delete")
    async def _route_delete(request):  # noqa: ANN001 - aiohttp handler signature
        payload = await request.json()
        # `delete_model_impl` does real filesystem work -- resolution,
        # containment re-verification, and up to three `os.remove` calls --
        # same offload reasoning as every other route here, and especially
        # non-negotiable for a route that destroys user data: it must never
        # run inline on the event loop.
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, functools.partial(delete_model_impl, payload))
        return web.json_response(result, status=200)

    @routes.post("/wtn/model_browser/save_preview")
    async def _route_save_preview(request):  # noqa: ANN001 - aiohttp handler signature
        payload = await request.json()
        # `save_preview_impl` can make a synchronous `urllib` HTTP call
        # (via `download.fetch_preview_image`) -- same `run_in_executor`
        # reasoning as `/lookup` and `/search` above: never block ComfyUI's
        # HTTP/WS server for this one extra, user-initiated request.
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, functools.partial(save_preview_impl, payload))
        return web.json_response(result, status=200)

    @routes.get("/wtn/model_browser/thumb")
    async def _route_thumb(request):  # noqa: ANN001 - aiohttp handler signature
        # Same offload reasoning as every route above -- `thumb_path_impl`
        # calls `resolve_model_path`, which does real filesystem work
        # (`os.path.realpath`/`os.path.isfile`/`os.path.commonpath` per
        # configured directory) -- never run inline on the event loop.
        loop = asyncio.get_running_loop()
        payload = {"kind": request.query.get("kind"), "name": request.query.get("name")}
        result = await loop.run_in_executor(None, functools.partial(thumb_path_impl, payload))
        if result.get("reason") != "ok" or not result.get("path"):
            # A clean 404 -- design doc's own non-negotiable for "no such
            # file"/"no preview for this file" alike. This is the ONE route
            # in this module that does NOT answer 200-with-a-reason for a
            # failure (see this module's own top doc comment): there is no
            # sensible image body to send back for "not found". `no-store`
            # (`THUMB_404_CACHE_CONTROL`) keeps a browser from caching this
            # miss as though it were a real image -- a `save_preview` call
            # minutes later must still be visible on the next request.
            return web.Response(status=404, headers={"Cache-Control": THUMB_404_CACHE_CONTROL})
        path = result["path"]

        # Owner reversal, 2026-07-31: the saved preview is now the ORIGINAL
        # image (`civitai_parse.saved_preview_url`), so this route downscales
        # on the way OUT instead of serving it untouched -- see this
        # module's own "`/thumb` downscale-on-serve" comment above
        # `DEFAULT_THUMB_MAX_EDGE`. `max_edge` is an optional override; no
        # frontend change is required, the default is right on its own.
        max_edge_raw = request.query.get("max_edge")
        max_edge = int(max_edge_raw) if max_edge_raw and max_edge_raw.isdigit() else DEFAULT_THUMB_MAX_EDGE

        # Conditional-GET check (owner, live-measured 2026-07-31 re-fetch
        # bug -- see this module's own "`/thumb` HTTP caching" comment
        # above `THUMB_CACHE_CONTROL`): stat `path` FIRST and decide 304
        # before paying for the read+downscale below -- that offload is
        # exactly what a repeat, already-cached render should skip.
        stat = await loop.run_in_executor(None, functools.partial(thumb_stat_impl, path))
        if stat is None:
            # Vanished between `thumb_path_impl` resolving it and this stat
            # -- same benign race `thumb_stat_impl` itself documents.
            return web.Response(status=404, headers={"Cache-Control": THUMB_404_CACHE_CONTROL})
        mtime, size = stat
        etag = thumb_etag(mtime, size, max_edge)
        cache_headers = {
            "ETag": etag,
            "Cache-Control": THUMB_CACHE_CONTROL,
            "Last-Modified": thumb_last_modified(mtime),
        }
        if if_none_match_hits(request.headers.get("If-None-Match"), etag):
            # Empty-body round trip instead of a full image transfer --
            # this is the actual fix for the reported "re-fetches every
            # 1-2s" symptom on any request that DOES reach the server (the
            # `max-age` window above is what stops most of them from even
            # doing that).
            return web.Response(status=304, headers=cache_headers)

        # THE offload that matters most on this route: a saved preview can
        # now genuinely be a multi-MB original, and reading + decoding +
        # re-encoding it is real CPU AND disk work -- inline on the event
        # loop it would stall ComfyUI's whole HTTP/WS server for that whole
        # window, same "never block a graph run"-adjacent reasoning §9
        # states for the lookup route above. `thumb_bytes_impl` itself
        # falls back to the untouched original bytes if Pillow isn't
        # installed (`downscale_thumb_bytes`'s own docstring) -- still one
        # executor hop either way, never inline.
        data = await loop.run_in_executor(None, functools.partial(thumb_bytes_impl, path, max_edge=max_edge))
        content_type, _ = mimetypes.guess_type(path)
        return web.Response(
            body=data,
            status=200,
            content_type=content_type or "application/octet-stream",
            headers=cache_headers,
        )

    @routes.get("/wtn/model_browser/search")
    async def _route_search(request):  # noqa: ANN001 - aiohttp handler signature
        # THE offload that matters most on this route (same reasoning as
        # `/lookup` above): `search_impl` makes a synchronous `urllib` HTTP
        # call with up to a 30s timeout -- inline on the event loop, that
        # stalls ComfyUI's entire HTTP/WS server for the whole window.
        # The query-string -> payload parsing itself lives in
        # `_search_query_to_payload` above (pulled out of this handler so
        # it's unit-testable with no aiohttp installed) -- `request.query`
        # is aiohttp's `MultiDictProxy`, which already duck-types the
        # `.get`/`.getall` interface that function calls.
        payload = _search_query_to_payload(request.query)
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, functools.partial(search_impl, payload))
        return web.json_response(result, status=200)

    @routes.post("/wtn/model_browser/download/start")
    async def _route_download_start(request):  # noqa: ANN001 - aiohttp handler signature
        payload = await request.json()
        # THE offload that matters most on this route: `download_start_impl`
        # resolves/validates a real filesystem path AND launches the actual
        # transfer -- the launch itself must not run inline on the event
        # loop either (starting a thread is cheap, but the destination/URL
        # validation ahead of it is real filesystem work, same reasoning as
        # every other route here).
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, functools.partial(download_start_impl, payload))
        return web.json_response(result, status=200)

    @routes.get("/wtn/model_browser/download/progress")
    async def _route_download_progress(request):  # noqa: ANN001 - aiohttp handler signature
        loop = asyncio.get_running_loop()
        payload = {"job_id": request.query.get("job_id")}
        result = await loop.run_in_executor(None, functools.partial(download_progress_impl, payload))
        return web.json_response(result, status=200)

    @routes.post("/wtn/model_browser/download/cancel")
    async def _route_download_cancel(request):  # noqa: ANN001 - aiohttp handler signature
        payload = await request.json()
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, functools.partial(download_cancel_impl, payload))
        return web.json_response(result, status=200)

except Exception:  # noqa: BLE001 - any failure here means "not running inside ComfyUI"
    # VERIFY-IN-COMFYUI: route registration itself (the decorators above)
    # only actually runs inside a live ComfyUI process with `server.py`'s
    # `PromptServer.instance` constructed; not exercised by the plain-script
    # tests, which only call the `*_impl` functions directly.
    pass
