"""Plain-script tests for the `/wtn/model_browser/thumb` route's HTTP
caching (owner, live-measured 2026-07-31): "seems cache is not working,
thumb is called each 1-2 sec" -- the route answered with NO validator at
all (no `ETag`/`Last-Modified`/`Cache-Control`), so a browser had nothing
to revalidate against and re-downloaded on essentially every render.

Covers the pure helpers in `src/model_browser/api.py` (`thumb_stat_impl`,
`thumb_etag`, `if_none_match_hits`, `thumb_last_modified`) AND the actual
`_route_thumb` aiohttp handler end-to-end, via the same fake-`aiohttp`/
`server` injection idiom `tests/test_autocomplete_api.py` established --
this dev environment has neither `aiohttp` nor ComfyUI's own `server`
installed, so the module's own guarded `try/except` around route
registration never actually runs in any OTHER test file. Injecting minimal
fakes lets the real decorated handler be captured and called directly,
and -- the point of this file's route-level tests -- asserted against a
real response-shaped object (`.status`/`.headers`/`.body`), not a
hand-built dict describing what the route "would" do.

Run directly: `python tests/test_model_browser_thumb_cache.py` (no
pytest, per project convention).
"""
from __future__ import annotations

import asyncio
import importlib
import os
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.model_browser import api as mb_api  # noqa: E402 - after sys.path shim

MODULE_NAME = "src.model_browser.api"


# ---------------------------------------------------------------------------
# `folder_paths` stub -- same shape as `tests/test_model_browser.py`'s own
# `_install_fake_folder_paths` (deliberately duplicated per this repo's own
# precedent, e.g. `tests/test_model_browser_logs.py`'s copy, so each test
# file stays independently runnable).
# ---------------------------------------------------------------------------


def _install_fake_folder_paths(roots_by_folder, names_by_folder):
    fake = types.ModuleType("folder_paths")

    def get_folder_paths(folder):
        return list(roots_by_folder.get(folder, []))

    def get_filename_list(folder):
        return list(names_by_folder.get(folder, []))

    def get_full_path(folder, name):
        for root in roots_by_folder.get(folder, []):
            candidate = os.path.join(root, name)
            if os.path.isfile(candidate):
                return candidate
        return None

    fake.get_folder_paths = get_folder_paths
    fake.get_filename_list = get_filename_list
    fake.get_full_path = get_full_path

    previous = sys.modules.get("folder_paths")
    sys.modules["folder_paths"] = fake

    def restore():
        if previous is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = previous

    return restore


# ---------------------------------------------------------------------------
# Minimal fake `aiohttp`/`server`, mirroring `tests/test_autocomplete_api.py`'s
# `_install_fake_aiohttp_and_server` -- extended with a `_FakeResponse` that
# actually captures status/headers/body, since THIS file's whole point is
# asserting against a real response object rather than a hand-built dict.
# ---------------------------------------------------------------------------


class _FakeRoutes:
    """Stand-in for `PromptServer.instance.routes` -- captures every
    `@routes.get(...)`/`@routes.post(...)` decorated handler by
    `(method, path)`, same shape `api.py` actually calls both of."""

    def __init__(self):
        self.handlers: dict[tuple[str, str], object] = {}

    def get(self, path):
        def decorator(func):
            self.handlers[("GET", path)] = func
            return func

        return decorator

    def post(self, path):
        def decorator(func):
            self.handlers[("POST", path)] = func
            return func

        return decorator


class _FakePromptServerInstance:
    def __init__(self):
        self.routes = _FakeRoutes()


class _FakeJsonResponse:
    """Stand-in for `aiohttp.web.json_response(payload)` -- unused by the
    thumb route itself, but every OTHER route `api.py` registers references
    it at decoration time, so it must exist for the module import to
    succeed."""

    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status


class _FakeResponse:
    """Stand-in for `aiohttp.web.Response(...)` -- a REAL response-shaped
    object (status/headers/body/content_type as actual attributes) rather
    than a dict the test itself constructs, per this fix's own test brief:
    "Assert against the real response objects, not a hand-built dict."
    """

    def __init__(self, *, body=None, status=200, content_type=None, headers=None):
        self.body = body
        self.status = status
        self.content_type = content_type
        self.headers = dict(headers or {})


class _FakeQuery(dict):
    """Minimal stand-in for aiohttp's `request.query` (a `.get(key,
    default)`-capable mapping) -- `dict` already has that shape."""


class _FakeHeaders(dict):
    """Minimal stand-in for aiohttp's `request.headers` -- same shape,
    `.get(key)` is all `_route_thumb` ever calls on it."""


class _FakeRequest:
    def __init__(self, query=None, headers=None):
        self.query = _FakeQuery(query or {})
        self.headers = _FakeHeaders(headers or {})


def _install_fake_aiohttp_and_server():
    """Injects fake `aiohttp`/`server` modules so `api.py`'s own guarded
    `try: from aiohttp import web; from server import PromptServer` block
    succeeds, then re-imports `src.model_browser.api` fresh so its route
    registration actually runs against these fakes. Returns `(module,
    fake_routes, previous_sys_modules)`."""
    previous = {name: sys.modules.get(name) for name in ("aiohttp", "server", MODULE_NAME)}

    fake_aiohttp = types.ModuleType("aiohttp")
    fake_aiohttp.web = types.SimpleNamespace(json_response=_FakeJsonResponse, Response=_FakeResponse)
    sys.modules["aiohttp"] = fake_aiohttp

    fake_server = types.ModuleType("server")
    fake_prompt_server_instance = _FakePromptServerInstance()
    fake_server.PromptServer = types.SimpleNamespace(instance=fake_prompt_server_instance)
    sys.modules["server"] = fake_server

    sys.modules.pop(MODULE_NAME, None)
    module = importlib.import_module(MODULE_NAME)
    return module, fake_prompt_server_instance.routes, previous


def _restore_sys_modules(previous):
    for name, value in previous.items():
        if value is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = value


def _make_lora_with_preview(tmp, model_bytes=b"lora-bytes", preview_bytes=b"preview-bytes"):
    """Builds `<tmp>/loras/a.safetensors` + `a.preview.png` and installs a
    matching `folder_paths` stub, returning `(restore, preview_path)`."""
    loras_root = os.path.join(tmp, "loras")
    os.makedirs(loras_root)
    model_path = os.path.join(loras_root, "a.safetensors")
    with open(model_path, "wb") as fh:
        fh.write(model_bytes)
    preview_path = os.path.join(loras_root, "a.preview.png")
    with open(preview_path, "wb") as fh:
        fh.write(preview_bytes)
    restore = _install_fake_folder_paths(
        roots_by_folder={"loras": [loras_root]},
        names_by_folder={"loras": ["a.safetensors"]},
    )
    return restore, preview_path


# ---------------------------------------------------------------------------
# Pure helpers.
# ---------------------------------------------------------------------------


def test_thumb_etag_is_quoted_and_deterministic_for_the_same_inputs():
    etag = mb_api.thumb_etag(123.0, 456, 256)
    assert etag.startswith('"') and etag.endswith('"')
    assert etag == mb_api.thumb_etag(123.0, 456, 256)


def test_thumb_etag_changes_when_mtime_changes():
    assert mb_api.thumb_etag(123.0, 456, 256) != mb_api.thumb_etag(124.0, 456, 256)


def test_thumb_etag_changes_when_size_changes():
    assert mb_api.thumb_etag(123.0, 456, 256) != mb_api.thumb_etag(123.0, 457, 256)


def test_thumb_etag_changes_when_max_edge_changes():
    # The easy-to-miss requirement from the fix brief: the SAME file served
    # at two sizes is two different payloads, so `max_edge` must be part of
    # the tag.
    assert mb_api.thumb_etag(123.0, 456, 256) != mb_api.thumb_etag(123.0, 456, 128)


def test_if_none_match_hits_exact_single_tag():
    etag = '"abc123"'
    assert mb_api.if_none_match_hits(etag, etag) is True


def test_if_none_match_hits_none_or_empty_header_never_matches():
    etag = '"abc123"'
    assert mb_api.if_none_match_hits(None, etag) is False
    assert mb_api.if_none_match_hits("", etag) is False


def test_if_none_match_hits_a_different_tag_does_not_match():
    assert mb_api.if_none_match_hits('"other"', '"abc123"') is False


def test_if_none_match_hits_wildcard():
    assert mb_api.if_none_match_hits("*", '"abc123"') is True


def test_if_none_match_hits_comma_separated_list_and_weak_prefix():
    etag = '"abc123"'
    header = '"nope", W/"abc123", "also-nope"'
    assert mb_api.if_none_match_hits(header, etag) is True


def test_thumb_stat_impl_returns_none_for_a_missing_path():
    with tempfile.TemporaryDirectory() as tmp:
        missing = os.path.join(tmp, "does-not-exist.png")
        assert mb_api.thumb_stat_impl(missing) is None


def test_thumb_cache_control_is_private_not_public():
    # Regression pin (coordinator, 2026-07-31): this route serves bytes read
    # straight out of the user's own model folders, and the pack is
    # routinely reached through a public tunnel (pinggy) rather than plain
    # localhost -- `public` would license a shared intermediary (the tunnel,
    # a corporate proxy) to store and re-serve local filesystem content.
    # `private` confines reuse to the requesting browser's own cache, which
    # is all the ETag + `max-age=60` fix actually needs. Pinned here so a
    # later "optimisation" back to `public` fails a test, not just a review.
    directives = [part.strip() for part in mb_api.THUMB_CACHE_CONTROL.split(",")]
    assert "private" in directives
    assert "public" not in directives


def test_thumb_stat_impl_returns_mtime_and_size_for_a_real_file():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "a.png")
        with open(path, "wb") as fh:
            fh.write(b"12345")
        stat = mb_api.thumb_stat_impl(path)
        assert stat is not None
        mtime, size = stat
        assert size == 5
        assert mtime == os.path.getmtime(path)


# ---------------------------------------------------------------------------
# `_route_thumb` end-to-end, against the real (fake-aiohttp) response object.
# ---------------------------------------------------------------------------


def test_thumb_route_first_request_returns_200_with_an_etag():
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        assert handler is not None, "route was not registered against the fake PromptServer"

        with tempfile.TemporaryDirectory() as tmp:
            restore_fp, preview_path = _make_lora_with_preview(tmp)
            try:
                request = _FakeRequest(query={"kind": "loras", "name": "a.safetensors"})
                response = asyncio.run(handler(request))
                assert isinstance(response, _FakeResponse)
                assert response.status == 200
                assert response.body == b"preview-bytes"
                etag = response.headers.get("ETag")
                assert etag, "expected a real ETag header on a 200"
                assert response.headers.get("Cache-Control") == module.THUMB_CACHE_CONTROL
                assert response.headers.get("Last-Modified")
            finally:
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_matching_if_none_match_returns_304_with_empty_body():
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            restore_fp, preview_path = _make_lora_with_preview(tmp)
            try:
                first = asyncio.run(
                    handler(_FakeRequest(query={"kind": "loras", "name": "a.safetensors"}))
                )
                etag = first.headers.get("ETag")
                assert etag

                second = asyncio.run(
                    handler(
                        _FakeRequest(
                            query={"kind": "loras", "name": "a.safetensors"},
                            headers={"If-None-Match": etag},
                        )
                    )
                )
                assert second.status == 304
                assert not second.body
                # The 304 must still carry the SAME validators -- a client
                # revalidating its freshness lifetime, not just checking
                # equality, needs them.
                assert second.headers.get("ETag") == etag
            finally:
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_touching_the_file_changes_the_etag_and_is_200_again():
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            restore_fp, preview_path = _make_lora_with_preview(tmp)
            try:
                first = asyncio.run(
                    handler(_FakeRequest(query={"kind": "loras", "name": "a.safetensors"}))
                )
                etag = first.headers.get("ETag")

                # "Touch" the preview file with an unambiguously different
                # mtime -- some filesystems have only second-level
                # resolution, so nudge it forward by a whole minute rather
                # than relying on wall-clock timing.
                original_mtime = os.path.getmtime(preview_path)
                new_mtime = original_mtime + 60
                os.utime(preview_path, (new_mtime, new_mtime))

                revalidate = asyncio.run(
                    handler(
                        _FakeRequest(
                            query={"kind": "loras", "name": "a.safetensors"},
                            headers={"If-None-Match": etag},
                        )
                    )
                )
                assert revalidate.status == 200, "a changed file must not be answered with a stale 304"
                assert revalidate.headers.get("ETag") != etag
                assert revalidate.body == b"preview-bytes"
            finally:
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_same_file_different_max_edge_has_a_different_etag():
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            restore_fp, preview_path = _make_lora_with_preview(tmp)
            try:
                default_edge = asyncio.run(
                    handler(_FakeRequest(query={"kind": "loras", "name": "a.safetensors"}))
                )
                other_edge = asyncio.run(
                    handler(
                        _FakeRequest(query={"kind": "loras", "name": "a.safetensors", "max_edge": "128"})
                    )
                )
                assert default_edge.status == 200
                assert other_edge.status == 200
                assert default_edge.headers.get("ETag") != other_edge.headers.get("ETag")

                # And the earlier ETag, sent as `If-None-Match` against the
                # DIFFERENT `max_edge`, must not be honoured as a match.
                mismatched = asyncio.run(
                    handler(
                        _FakeRequest(
                            query={"kind": "loras", "name": "a.safetensors", "max_edge": "128"},
                            headers={"If-None-Match": default_edge.headers.get("ETag")},
                        )
                    )
                )
                assert mismatched.status == 200
            finally:
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_404_carries_no_positive_caching():
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            # A real, whitelisted kind with no matching file at all -- the
            # common case the fix brief calls out: "a model that has never
            # been looked up".
            restore_fp = _install_fake_folder_paths(
                roots_by_folder={"loras": [tmp]},
                names_by_folder={"loras": []},
            )
            try:
                response = asyncio.run(
                    handler(_FakeRequest(query={"kind": "loras", "name": "does-not-exist.safetensors"}))
                )
                assert response.status == 404
                assert not response.headers.get("ETag")
                assert not response.headers.get("Last-Modified")
                cache_control = response.headers.get("Cache-Control")
                assert cache_control == module.THUMB_404_CACHE_CONTROL
                assert "max-age" not in (cache_control or "")
            finally:
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_registration_is_skipped_outside_comfyui():
    # The ORIGINAL guard behavior (this repo's actual dev environment -- no
    # aiohttp/server installed at all) must still degrade to "route not
    # registered", not raise.
    previous = {name: sys.modules.get(name) for name in ("aiohttp", "server", MODULE_NAME)}
    try:
        for name in ("aiohttp", "server", MODULE_NAME):
            sys.modules.pop(name, None)
        module = importlib.import_module(MODULE_NAME)
        assert hasattr(module, "thumb_etag")
        assert not hasattr(module, "routes")
    finally:
        _restore_sys_modules(previous)


ALL_TESTS = [
    test_thumb_etag_is_quoted_and_deterministic_for_the_same_inputs,
    test_thumb_etag_changes_when_mtime_changes,
    test_thumb_etag_changes_when_size_changes,
    test_thumb_etag_changes_when_max_edge_changes,
    test_thumb_cache_control_is_private_not_public,
    test_if_none_match_hits_exact_single_tag,
    test_if_none_match_hits_none_or_empty_header_never_matches,
    test_if_none_match_hits_a_different_tag_does_not_match,
    test_if_none_match_hits_wildcard,
    test_if_none_match_hits_comma_separated_list_and_weak_prefix,
    test_thumb_stat_impl_returns_none_for_a_missing_path,
    test_thumb_stat_impl_returns_mtime_and_size_for_a_real_file,
    test_thumb_route_first_request_returns_200_with_an_etag,
    test_thumb_route_matching_if_none_match_returns_304_with_empty_body,
    test_thumb_route_touching_the_file_changes_the_etag_and_is_200_again,
    test_thumb_route_same_file_different_max_edge_has_a_different_etag,
    test_thumb_route_404_carries_no_positive_caching,
    test_thumb_route_registration_is_skipped_outside_comfyui,
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
        except Exception as exc:  # noqa: BLE001
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
