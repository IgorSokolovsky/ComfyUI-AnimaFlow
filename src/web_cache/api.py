"""Browser-cache fix for this pack's own `.mjs`/`.js` files -- TWO
independent layers, both needed. Ported from `../ComfyUI-Pixaroma/
server_routes.py` (MIT (c) pixaroma -- see THIRD_PARTY_NOTICES.md):
lines 66-96 (the rationale comment this module's own top comment restates),
97-101 (`_pixaroma_no_cache`, ported as `_no_cache_headers` below),
119-144 (`_pixaroma_stamp_imports_mw`, ported as `_stamp_middleware` below),
and 147-167 (`_pixaroma_install_no_cache`, ported as `install()` below).
`_pixaroma_stamp_version` (`server_routes.py:103-116`) is deliberately NOT
ported as-is -- see `stamp.compute_js_version`'s own doc comment for why this
pack uses a different version source.

Layer 1 (headers): ComfyUI core's cache middleware sets "Cache-Control:
no-store" on JS responses, but it checks `request.path.endswith(".js")`,
which never matches `.mjs` -- an `on_response_prepare` hook mirrors that rule
for OUR OWN `.mjs`/`.js` responses.

Layer 2 (import-URL version stamping): headers only help when the browser
actually ASKS the server -- an already-poisoned cache never asks. A
middleware serves our `.js`/`.mjs` files with every relative `.mjs` import
rewritten to `./x.mjs?v=<version>` (`stamp.stamp_import_urls`). Entry
`index.js` files are always refetched (core sends no-store for `.js`), so a
changed version makes every internal module URL brand new and the whole tree
loads fresh with no user action.

Python change -> needs a full ComfyUI restart, both because this is
server-side code and because the version stamp itself
(`stamp.compute_js_version`) is computed once at import time -- see that
function's own doc comment.

This module only touches THIS pack's own served files (the `/extensions/
<this-pack's-dir>/` prefix, auto-derived from the install's own folder name
so a renamed install still works) and stays importable with no ComfyUI
installed: the `aiohttp`/`server.PromptServer` import is guarded exactly like
`src/anima/api.py`/`src/model_browser/api.py`, so importing this module
outside a live ComfyUI process (this pack's own plain-script tests) is a
no-op instead of a crash. `aiohttp` itself is never added to
`requirements.txt` -- it is borrowed from the ComfyUI environment, same as
every other guarded `api.py` in this pack.
"""
from __future__ import annotations

import os

from .stamp import compute_js_version, stamp_import_urls

# Pack root is two levels up from this file: src/web_cache/api.py -> src ->
# pack root. WEB_DIRECTORY is "./js" (__init__.py), so
# /extensions/<pack-dir>/X maps to <pack-root>/js/X -- same derivation as
# `../ComfyUI-Pixaroma/server_routes.py:87-92`.
_PACK_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_PACK_DIR = os.path.basename(_PACK_ROOT)
_PREFIX = "/extensions/" + _PACK_DIR + "/"
_JS_ROOT = os.path.realpath(os.path.join(_PACK_ROOT, "js"))

# Computed ONCE, here, at import time, and held for the process lifetime --
# see `stamp.compute_js_version`'s own doc comment for why. Never re-read
# per-request (that would reopen the same-version-per-page-load hole this
# design deliberately closes).
VERSION = compute_js_version(_JS_ROOT)


def _is_our_served_js(path: str) -> bool:
    """True for a request path this pack itself serves as `.mjs`/`.js` under
    its own `/extensions/<dir>/` prefix. Shared by both layers below so the
    path rule can't drift between them."""
    return path.startswith(_PREFIX) and (path.endswith(".mjs") or path.endswith(".js"))


def install() -> None:
    """Install both layers on the live ComfyUI app. Two INDEPENDENT
    `getattr(app, "_..._installed", False)` guards (mirrors
    `_pixaroma_install_no_cache`, `server_routes.py:147-167`) so one failing
    still leaves the other protecting users, and so re-importing this module
    (or a hot module reload) never double-installs either one.

    Requires a live `PromptServer.instance.app`; the whole aiohttp/server
    import this function's callers depend on is guarded at the bottom of this
    module, not here -- this function itself assumes both are importable.
    """
    from aiohttp import web
    from server import PromptServer

    inst = getattr(PromptServer, "instance", None)
    app = getattr(inst, "app", None) if inst else None
    if app is None:
        return

    async def _no_cache_headers(request, response):
        """Layer 1 -- mirrors core's own `.js`-only no-store rule
        (`server_routes.py:97-101`) for OUR `.mjs`/`.js` responses, which
        core's own check misses entirely."""
        if _is_our_served_js(request.path):
            response.headers["Cache-Control"] = "no-store"

    @web.middleware
    async def _stamp_middleware(request, handler):
        """Layer 2 -- ported from `_pixaroma_stamp_imports_mw`
        (`server_routes.py:119-144`). On any error, falls through to the
        native static handler (unstamped but served) and logs loudly -- a
        partial rewrite that silently half-applies is exactly how a module
        ends up double-instanced."""
        path = request.path
        if request.method == "GET" and _is_our_served_js(path):
            try:
                rel = path[len(_PREFIX):]
                file_path = os.path.realpath(os.path.join(_JS_ROOT, rel))
                # Path-traversal guard: the resolved file must sit under the
                # realpath'd js/ root.
                if file_path.startswith(_JS_ROOT + os.sep) and os.path.isfile(file_path):
                    with open(file_path, "r", encoding="utf-8") as fh:
                        text = fh.read()
                    text = stamp_import_urls(text, VERSION)
                    return web.Response(
                        text=text,
                        content_type="application/javascript",
                        charset="utf-8",
                        headers={"Cache-Control": "no-store"},
                    )
            except Exception as exc:  # noqa: BLE001 - fall through, never 500
                print(f"[AnimaFlow] web_cache: import-stamp serve failed, falling back: {exc}")
        return await handler(request)

    try:
        if not getattr(app, "_web_cache_no_cache_installed", False):
            app.on_response_prepare.append(_no_cache_headers)
            app._web_cache_no_cache_installed = True
    except Exception as exc:  # noqa: BLE001 - one layer failing must not break the other
        print(f"[AnimaFlow] web_cache: no-cache hook not installed: {exc}")

    try:
        if not getattr(app, "_web_cache_stamp_installed", False):
            app.middlewares.append(_stamp_middleware)
            app._web_cache_stamp_installed = True
    except Exception as exc:  # noqa: BLE001 - one layer failing must not break the other
        print(f"[AnimaFlow] web_cache: import-stamp middleware not installed: {exc}")


try:
    # Real ComfyUI context only: `server.PromptServer` and `aiohttp` (both
    # imported inside `install()` itself) only exist inside a live ComfyUI
    # process. Guarded exactly like `src/anima/api.py`/`src/model_browser/
    # api.py` so importing this module from a plain-script test is a no-op,
    # not a crash.
    install()
except Exception:  # noqa: BLE001 - any failure here means "not running inside ComfyUI"
    # VERIFY-IN-COMFYUI: installation itself only actually runs inside a live
    # ComfyUI process; not exercised by the plain-script tests, which only
    # call `stamp.stamp_import_urls`/`stamp.compute_js_version` directly.
    pass
