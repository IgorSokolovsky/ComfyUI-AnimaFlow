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
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/wtn/autocomplete")
    async def _route_autocomplete(request):  # noqa: ANN001 - aiohttp handler signature
        query = request.query.get("q", "")
        limit = request.query.get("limit", DEFAULT_LIMIT)
        category = request.query.get("category") or None
        return web.json_response(search_impl(query, limit=limit, category=category))

except Exception:  # noqa: BLE001 - any failure here means "not running inside ComfyUI"
    # VERIFY-IN-COMFYUI: route registration itself (the decorator above)
    # only actually runs inside a live ComfyUI process with `server.py`'s
    # `PromptServer.instance` constructed; not exercised by the plain-script
    # tests, which only call `search_impl` directly.
    pass
