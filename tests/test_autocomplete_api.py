"""Plain-script tests for `src/autocomplete/api.py` — the aiohttp route layer.

Run directly: `python tests/test_autocomplete_api.py` (no pytest, per
project convention).

`search_impl` itself (the pure query -> payload logic) is exercised
end-to-end here too, but the main point of this file is the R5 regression
fix: the `/wtn/autocomplete` route handler must offload `search_impl` to a
worker thread (`loop.run_in_executor`) instead of calling it inline on the
event loop thread, so a slow/cold search never stalls ComfyUI's entire
HTTP/websocket server for its duration.

This dev environment has neither `aiohttp` nor ComfyUI's own `server`
module installed (see `src/autocomplete/api.py`'s own guarded try/except), so
route REGISTRATION itself never actually runs here in the other test files.
This file instead injects minimal FAKE `aiohttp`/`server` modules into
`sys.modules` before importing `src.autocomplete.api` fresh, so the module's
own try block succeeds and the real decorated handler function can be
captured and called directly with `asyncio.run` - no real aiohttp/ComfyUI
install needed, and nothing here touches the real network/websocket stack.
"""

from __future__ import annotations

import asyncio
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

MODULE_NAME = "src.autocomplete.api"


class _FakeRoutes:
    """Minimal stand-in for aiohttp's `web.RouteTableDef`/`app.router` -
    only needs to support the `@routes.get(path)` decorator shape
    `api.py` uses, capturing the decorated function by path."""

    def __init__(self):
        self.handlers: dict[str, object] = {}

    def get(self, path):
        def decorator(func):
            self.handlers[path] = func
            return func

        return decorator


class _FakePromptServerInstance:
    def __init__(self):
        self.routes = _FakeRoutes()


class _FakeJsonResponse:
    """Stand-in for `aiohttp.web.json_response(payload)` - just remembers
    the payload it was given so the test can assert on it directly."""

    def __init__(self, payload):
        self.payload = payload


def _install_fake_aiohttp_and_server():
    """Inject fake `aiohttp`/`server` modules so `src/autocomplete/api.py`'s own
    guarded `try: from aiohttp import web; from server import PromptServer`
    block succeeds, then import (or re-import) `src.autocomplete.api` fresh so
    its route-registration code actually runs against these fakes. Returns
    `(module, fake_routes, previous_sys_modules)` - `previous_sys_modules`
    is a dict of whatever `sys.modules` entries this replaced (for
    `_restore`)."""
    previous = {
        name: sys.modules.get(name)
        for name in ("aiohttp", "server", MODULE_NAME)
    }

    fake_aiohttp = types.ModuleType("aiohttp")
    fake_aiohttp.web = types.SimpleNamespace(json_response=_FakeJsonResponse)
    sys.modules["aiohttp"] = fake_aiohttp

    fake_server = types.ModuleType("server")
    fake_prompt_server_instance = _FakePromptServerInstance()
    fake_server.PromptServer = types.SimpleNamespace(instance=fake_prompt_server_instance)
    sys.modules["server"] = fake_server

    sys.modules.pop(MODULE_NAME, None)
    import importlib

    module = importlib.import_module(MODULE_NAME)
    return module, fake_prompt_server_instance.routes, previous


def _restore_sys_modules(previous: dict):
    for name, value in previous.items():
        if value is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = value


class _FakeQuery(dict):
    """Minimal stand-in for aiohttp's `request.query` (a case-sensitive
    mapping with a `.get(key, default)` method) - `dict` already has that
    shape."""


class _FakeRequest:
    def __init__(self, **query):
        self.query = _FakeQuery(query)


def test_route_registers_and_returns_expected_payload_shape():
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get("/wtn/autocomplete")
        assert handler is not None, "route was not registered against the fake PromptServer"

        request = _FakeRequest(q="1girl", limit="5")
        response = asyncio.run(handler(request))
        assert isinstance(response, _FakeJsonResponse)
        payload = response.payload
        assert payload["query"] == "1girl"
        assert isinstance(payload["results"], list)
        # Byte-identical response SHAPE to the pre-fix synchronous call -
        # this is purely an event-loop-blocking fix, not a behavior change.
        assert payload == module.search_impl("1girl", limit="5", category=None)
    finally:
        _restore_sys_modules(previous)


def test_route_handler_offloads_search_impl_off_the_event_loop():
    # The core R5 regression test: while a SLOW search_impl call is in
    # flight (run via loop.run_in_executor on a worker thread), the event
    # loop itself must remain free to run OTHER coroutines concurrently -
    # proving the handler no longer blocks the loop for the search's
    # duration. Before the R5 fix, a synchronous in-handler call would have
    # frozen the tick loop below for the full sleep duration.
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get("/wtn/autocomplete")
        assert handler is not None

        import time

        def _slow_search_impl(query, limit=20, category=None):
            time.sleep(0.2)  # simulates the reported cold-cache ~0.93s scan
            return {"query": query, "results": []}

        original_search_impl = module.search_impl
        module.search_impl = _slow_search_impl
        try:
            tick_count = 0

            async def _ticker():
                nonlocal tick_count
                while True:
                    tick_count += 1
                    await asyncio.sleep(0.01)

            async def _main():
                ticker_task = asyncio.ensure_future(_ticker())
                request = _FakeRequest(q="slow", limit="1")
                response = await handler(request)
                ticker_task.cancel()
                return response

            response = asyncio.run(_main())
            assert response.payload == {"query": "slow", "results": []}
            # ~0.2s / 0.01s per tick == ~20 ticks if the loop stayed free;
            # a generous lower bound (>= 5) avoids flakiness on a loaded
            # CI/dev machine while still failing hard if the loop was
            # blocked for the whole 0.2s (which would leave tick_count at 0
            # or 1).
            assert tick_count >= 5, (
                f"event loop only ticked {tick_count} times during the slow search - "
                "looks like search_impl is blocking the loop again"
            )
        finally:
            module.search_impl = original_search_impl
    finally:
        _restore_sys_modules(previous)


def test_route_registration_is_skipped_outside_comfyui():
    # The ORIGINAL guard behavior (this repo's actual dev environment - no
    # aiohttp/server installed at all) must still degrade to "route not
    # registered", not raise, exactly as before this fix.
    previous = {name: sys.modules.get(name) for name in ("aiohttp", "server", MODULE_NAME)}
    try:
        for name in ("aiohttp", "server", MODULE_NAME):
            sys.modules.pop(name, None)
        import importlib

        try:
            module = importlib.import_module(MODULE_NAME)
            raised = False
        except Exception:
            raised = True
        assert not raised
        assert hasattr(module, "search_impl")
        assert not hasattr(module, "routes")
    finally:
        _restore_sys_modules(previous)


ALL_TESTS = [
    test_route_registers_and_returns_expected_payload_shape,
    test_route_handler_offloads_search_impl_off_the_event_loop,
    test_route_registration_is_skipped_outside_comfyui,
]


if __name__ == "__main__":
    failures = []
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
