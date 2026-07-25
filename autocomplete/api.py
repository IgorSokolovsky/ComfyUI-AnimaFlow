"""aiohttp route for tag autocomplete (Gelbooru-primary / Danbooru-fallback).

Route REGISTRATION needs a live ComfyUI `server.PromptServer` instance, so
the `from server import PromptServer` import (and the aiohttp import it
implies) is guarded exactly like `api/rules_api.py`: importing this module
OUTSIDE ComfyUI (e.g. from a plain-script test, or from this pack's own
root `__init__.py` running standalone) must not crash — it just skips
registering the route.

The pure `search_impl` function below has NO aiohttp/ComfyUI dependency at
all (plain args in, plain dict out) — that's what's actually unit-tested;
the thin aiohttp handler just adapts a request's query string to it.

R5 FIX (event-loop blocking): `search_impl` does a linear heapq prefix/
substring scan over the bundled Gelbooru+Danbooru CSVs (~417k rows) —
measured 60-105ms warm, ~0.93s cold. The route handler below used to call
it directly, synchronously, inside the `async def` handler — since aiohttp
runs all handlers on ONE event loop thread, that stalled ComfyUI's entire
HTTP/websocket server (including generation-progress updates) for the
duration, on every keystroke a user typed into any autocomplete-enabled
text widget. The handler now offloads `search_impl` to a worker thread via
`loop.run_in_executor(None, ...)`, so the event loop stays free to service
other requests/websocket messages while a search is in flight. The
response shape/behavior is unchanged — this is purely about not blocking;
per the plan, the linear-scan algorithm itself is intentional and is NOT
being redesigned here (no SQLite index, no different search strategy).
"""

from __future__ import annotations

from typing import Optional

from .index import search as search_entries

DEFAULT_LIMIT = 20
MIN_LIMIT = 1
MAX_LIMIT = 50


def _clamp_limit(raw) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = DEFAULT_LIMIT
    return max(MIN_LIMIT, min(value, MAX_LIMIT))


def search_impl(query: str, limit=DEFAULT_LIMIT, category: Optional[str] = None) -> dict:
    """`GET /wtn/autocomplete?q=<query>&limit=<n>&category=<cat>` payload:
    `{query, results: [{tag, category, count, source}]}`.
    """
    query = query or ""
    clamped_limit = _clamp_limit(limit)
    category = category or None
    entries = search_entries(query, limit=clamped_limit, category=category)
    return {
        "query": query,
        "results": [
            {"tag": e.tag, "category": e.category, "count": e.count, "source": e.source}
            for e in entries
        ],
    }


try:
    import asyncio
    import functools

    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/wtn/autocomplete")
    async def _route_autocomplete(request):  # noqa: ANN001 - aiohttp handler signature
        query = request.query.get("q", "")
        limit = request.query.get("limit", DEFAULT_LIMIT)
        category = request.query.get("category") or None
        # Offload the (linear-scan) search work to the default executor's
        # worker-thread pool instead of running it inline on the event loop
        # thread - see the module docstring's "R5 FIX" note. Response
        # shape/behavior is otherwise byte-identical to the old synchronous
        # call.
        loop = asyncio.get_running_loop()
        payload = await loop.run_in_executor(
            None, functools.partial(search_impl, query, limit=limit, category=category)
        )
        return web.json_response(payload)

except Exception:  # noqa: BLE001 - any failure here means "not running inside ComfyUI"
    # VERIFY-IN-COMFYUI: route registration itself (the decorator above)
    # only actually runs inside a live ComfyUI process with `server.py`'s
    # `PromptServer.instance` constructed; not exercised by the plain-script
    # tests, which only call `search_impl` directly.
    pass
