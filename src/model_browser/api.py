"""Guarded aiohttp routes for the shared model-browser library (docs/lora-
loader-design.md §7a-§7e), following `src/anima/api.py`'s exact idiom for
the pure/impure split: a pure `*_impl(payload) -> dict` function per route,
importable and callable with no aiohttp/Request object anywhere -- what the
plain-script tests in `tests/test_model_browser.py` actually exercise --
with the aiohttp registration itself wrapped in a bare
`try/except Exception: pass` so importing this module OUTSIDE a live
ComfyUI process (this pack's own test suite, or anything else that imports
`src.model_browser` on its own) is a no-op rather than a crash.

Each route handler ALSO runs its `*_impl` call through
`loop.run_in_executor` before answering -- `src/autocomplete/api.py`'s
`/wtn/autocomplete`/`/wtn/classify` routes are the in-repo precedent for
this (same shape, same reasoning: real work must never run inline on
ComfyUI's single-threaded event loop). It matters most here for `/lookup`:
`lookup_impl` can chunk-hash a multi-GB file and make a synchronous
`urllib` call with up to a 30s timeout (§2b) -- inline, either one would
stall ComfyUI's ENTIRE HTTP/WS server (generation progress included) for
that whole window, which is exactly what design doc §9's "never block a
graph run" forbids.

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
from typing import Any, Dict

from . import lookup as lookup_mod
from .kinds import folder_for_kind
from .local import find_preview_path, list_models, resolve_model_path

_INVALID_KIND: Dict[str, Any] = {
    "reason": "invalid_kind",
    "message": "Unknown or unsupported model kind.",
}


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

except Exception:  # noqa: BLE001 - any failure here means "not running inside ComfyUI"
    # VERIFY-IN-COMFYUI: route registration itself (the decorators above)
    # only actually runs inside a live ComfyUI process with `server.py`'s
    # `PromptServer.instance` constructed; not exercised by the plain-script
    # tests, which only call the `*_impl` functions directly.
    pass
