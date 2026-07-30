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
    GET  /wtn/model_browser/thumb?kind=...&name=...

M2 -- Civitai search + the streamed download queue (docs/lora-loader-
design.md §9). `kind` is whitelisted the SAME way on every one of these; a
download additionally re-validates the destination (`download.
resolve_destination_path`) and the source URL (`download.
is_allowed_download_url`) server-side even though the frontend is expected
to only ever offer values it already validated -- never trust the client
for a route that writes to disk.

    GET  /wtn/model_browser/search?kind=...&query=...&...
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
"""
from __future__ import annotations

import mimetypes
import urllib.parse
import uuid
from typing import Any, Dict

from . import civitai_search
from . import download
from . import keys
from . import lookup as lookup_mod
from . import rate_limit
from .kinds import folder_for_kind
from .local import find_preview_path, list_models, resolve_model_path

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
# M2 -- Civitai search (docs/lora-loader-design.md §9's own network policy).
# ---------------------------------------------------------------------------


def _annotate_search_results(results: list, kind: object) -> list:
    """Adds the disk-touching fields `civitai_search.parse_search_response`
    deliberately leaves out (that function stays pure/offline-testable --
    see its own docstring): per-file `installed` (decision 2: "already on
    disk => no download"), plus a flattened `primary_*` convenience set on
    each RESULT (its first version's chosen file) for the simple picker
    card -- the full per-version `files` list survives untouched underneath
    for a future version-selector/detail view.

    The `installed` check always uses the kind's ROOT (`subfolder=""`) --
    the default destination (decision 1) -- since a search result has no
    subfolder of its own to check until a user picks one at download time;
    a LoRA a user keeps in a custom subfolder will show as downloadable
    again here even though it's technically already on disk elsewhere. This
    is a known, documented approximation, not an oversight.
    """
    for result in results:
        versions = result.get("versions") or []
        for version in versions:
            for file in version.get("files", []):
                file["installed"] = download.destination_exists(kind, "", file.get("name"))

        primary_version = versions[0] if versions else None
        primary_file = civitai_search.pick_primary_file(primary_version["files"]) if primary_version else None

        result["base_model"] = primary_version["base_model"] if primary_version else ""
        result["primary_version_id"] = primary_version["version_id"] if primary_version else None
        result["file_name"] = primary_file.get("name") if primary_file else None
        result["download_url"] = primary_file.get("download_url") if primary_file else None
        result["size_kb"] = primary_file.get("size_kb") if primary_file else None
        # `gated`/`installed` are the two flags the CORRECTION's four card
        # states are built from (state 4 "gated"/state 1 "installed") --
        # first-class outcomes computed here, not inferred client-side.
        result["gated"] = bool(primary_file.get("gated")) if primary_file else False
        result["installed"] = bool(primary_file.get("installed")) if primary_file else False
    return results


def search_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`GET /wtn/model_browser/search`'s pure-enough body (touches local
    disk for the `installed` annotation and the network for the search
    itself -- "pure" here means "callable directly with a payload dict",
    the same sense `lookup_impl` already uses, not "no I/O").

    Always returns `{"reason": ..., "message": str, "results": [...],
    "next_cursor": str|None, "public_only": bool}`:

      - `invalid_kind`   -- same whitelist short-circuit as every route here;
      - `rate_limited`   -- §9's own rate limiter refused this call (never
        Civitai's 429 -- that one surfaces as `offline`/`rate_limited` from
        `civitai_search.search_models` itself, kept distinct on purpose);
      - `offline`        -- the search request itself failed (see
        `offline_reason` for the specific cause, same vocabulary as
        `civitai_client`);
      - `ok`             -- `results`/`next_cursor` are populated.

    `public_only` (the CORRECTION's "no API key set -- public results only"
    banner) is set from `keys.resolve_api_key()` on EVERY branch, including
    failures -- the frontend can show that banner regardless of whether the
    search itself succeeded. The key's VALUE never appears anywhere in this
    return.
    """
    payload = payload or {}
    kind = payload.get("kind")
    if folder_for_kind(kind) is None:
        return {**_INVALID_KIND, "results": [], "next_cursor": None, "public_only": True}

    resolved_key = keys.resolve_api_key()

    if not _SEARCH_LIMITER.allow():
        return {
            "reason": "rate_limited",
            "message": "Searching too quickly -- wait a moment and try again.",
            "results": [], "next_cursor": None,
            "public_only": resolved_key.public_only,
        }

    result = civitai_search.search_models(
        kind,
        payload.get("query") or "",
        base_model=payload.get("base_model") or None,
        sort=payload.get("sort") or civitai_search.DEFAULT_SORT,
        period=payload.get("period") or civitai_search.DEFAULT_PERIOD,
        nsfw=bool(payload.get("nsfw", False)),
        cursor=payload.get("cursor") or None,
        limit=payload.get("limit", civitai_search.DEFAULT_LIMIT),
        api_key=resolved_key.api_key,
    )
    if result["reason"] != "found":
        return {
            "reason": result["reason"],
            "message": result.get("message", ""),
            "offline_reason": result.get("offline_reason"),
            "results": [], "next_cursor": None,
            "public_only": resolved_key.public_only,
        }

    parsed = civitai_search.parse_search_response(result["data"])
    results = _annotate_search_results(parsed["results"], kind)
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

    job_id = uuid.uuid4().hex
    start_result = _DOWNLOAD_MANAGER.start(job_id, fetch_url, dest_path, max_size_bytes=max_bytes)
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
            # sensible image body to send back for "not found".
            return web.Response(status=404)
        path = result["path"]

        def _read_bytes() -> bytes:
            with open(path, "rb") as fh:
                return fh.read()

        # THE offload that matters most on this route: a preview image can
        # be several MB, and reading it is real disk I/O -- inline on the
        # event loop it would stall ComfyUI's whole HTTP/WS server for that
        # read, same "never block a graph run"-adjacent reasoning §9 states
        # for the lookup route above.
        data = await loop.run_in_executor(None, _read_bytes)
        content_type, _ = mimetypes.guess_type(path)
        return web.Response(body=data, status=200, content_type=content_type or "application/octet-stream")

    @routes.get("/wtn/model_browser/search")
    async def _route_search(request):  # noqa: ANN001 - aiohttp handler signature
        # THE offload that matters most on this route (same reasoning as
        # `/lookup` above): `search_impl` makes a synchronous `urllib` HTTP
        # call with up to a 30s timeout -- inline on the event loop, that
        # stalls ComfyUI's entire HTTP/WS server for the whole window.
        query = request.query
        limit_raw = query.get("limit")
        payload = {
            "kind": query.get("kind"),
            "query": query.get("query", ""),
            "base_model": query.get("base_model") or None,
            "sort": query.get("sort") or None,
            "period": query.get("period") or None,
            "nsfw": (query.get("nsfw", "false") or "false").lower() == "true",
            "cursor": query.get("cursor") or None,
            "limit": int(limit_raw) if limit_raw and limit_raw.isdigit() else civitai_search.DEFAULT_LIMIT,
        }
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
