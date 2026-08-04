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
import struct
import sys
import tempfile
import types
import zlib

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
# "An undecodable preview must behave like an absent one, not a broken
# image" (2026-08-04 fix) -- same real-PNG-fixture idiom as `tests/
# test_model_browser.py`'s own copy (deliberately duplicated, per this
# file's own top docstring precedent, so each test file stays independently
# runnable): a genuinely truncated real PNG, not random bytes, so this
# exercises the owner's own actual failure mode (a decodable header with
# missing trailing data), and a chunk-walking fake `PIL.Image` stand-in
# (Pillow itself is NOT importable in this environment) that actually
# succeeds/fails on the real bytes handed to it rather than a scripted
# outcome.
# ---------------------------------------------------------------------------


def _build_minimal_png_bytes() -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
    raw_scanline = b"\x00\xff\x00\x00"
    idat = chunk(b"IDAT", zlib.compress(raw_scanline))
    iend = chunk(b"IEND", b"")
    return signature + ihdr + idat + iend


def _truncate_png_bytes(data: bytes) -> bytes:
    return data[:-16]


def _png_chunk_walk_or_raise(data: bytes) -> None:
    signature = b"\x89PNG\r\n\x1a\n"
    if data[:8] != signature:
        raise ValueError("not a PNG signature")
    pos = 8
    saw_iend = False
    while pos < len(data):
        if pos + 8 > len(data):
            raise ValueError("truncated chunk header")
        length = int.from_bytes(data[pos:pos + 4], "big")
        tag = data[pos + 4:pos + 8]
        pos += 8
        if pos + length + 4 > len(data):
            raise ValueError("truncated chunk data")
        pos += length + 4
        if tag == b"IEND":
            saw_iend = True
            break
    if not saw_iend:
        raise ValueError("missing IEND -- truncated file")


class _FakeDecodedImage:
    """Minimal `PIL.Image.Image` stand-in -- just enough surface for
    `downscale_thumb_bytes` to call (`.format`/`.mode`/`.load()`/
    `.thumbnail()`/`.save()`), mirroring `tests/test_model_browser.py`'s own
    `_FakeThumbImage` (duplicated rather than imported, same "each test file
    stays independently runnable" precedent)."""

    def __init__(self, fmt: str, size):
        self.format = fmt
        self.size = size
        self.mode = "RGB"

    def load(self):
        pass

    def thumbnail(self, box):
        pass

    def save(self, fh, format=None):  # noqa: A002 - matches PIL's own kwarg name
        fh.write(f"FAKE:{format}:{self.size[0]}x{self.size[1]}".encode())


class _RealisticPngImageModule:
    """Stands in for `PIL.Image` -- `.open()` performs a REAL PNG chunk walk
    (`_png_chunk_walk_or_raise`) against the actual bytes handed to it,
    rather than a scripted raise/succeed, so a genuinely truncated real PNG
    fixture exercises the actual failure mode this fix is about."""

    def open(self, fh):
        _png_chunk_walk_or_raise(fh.read())
        return _FakeDecodedImage("PNG", (1, 1))


def _with_simulated_pillow(target_module, image_module):
    """Monkeypatches `target_module._load_pillow_image_module` to return
    `image_module` -- simulates Pillow being installed and resolving to this
    stand-in, for a ROUTE-level test: the aiohttp handler calls
    `thumb_bytes_impl(path, max_edge=max_edge)` with no `image_module`
    override (there's no query param for that), so Pillow's presence is
    resolved this same way in production. `target_module` MUST be the
    freshly re-imported module `_install_fake_aiohttp_and_server` returned,
    NOT this file's own top-level `mb_api` -- that import happened before
    this file's `sys.modules.pop(MODULE_NAME, None)`/re-import, so it's a
    stale reference to a DIFFERENT module object than the one the captured
    route handler's own closures actually call into."""
    previous = target_module._load_pillow_image_module
    target_module._load_pillow_image_module = lambda: image_module

    def restore():
        target_module._load_pillow_image_module = previous

    return restore


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
    # This also doubles as the "known-good" regression pin for the
    # 2026-08-04 conditional-GET fix (`thumb_cache_known_state`): the FIRST
    # call above decodes the file and caches it as real bytes ("good"), so
    # the SECOND call's matching `If-None-Match` is honoured with a 304 --
    # the one row of the fix's three-state table that must NOT change.
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


def test_thumb_route_returns_404_with_no_store_for_a_genuinely_truncated_real_preview():
    # The 2026-08-04 fix itself: `3e02428` stopped previews being written
    # truncated, but every preview saved BEFORE it can still be truncated on
    # disk, forever -- this route used to serve those broken bytes as a
    # plain 200.
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            truncated = _truncate_png_bytes(_build_minimal_png_bytes())
            restore_fp, preview_path = _make_lora_with_preview(tmp, preview_bytes=truncated)
            restore_pillow = _with_simulated_pillow(module, _RealisticPngImageModule())
            try:
                response = asyncio.run(
                    handler(_FakeRequest(query={"kind": "loras", "name": "a.safetensors"}))
                )
                assert response.status == 404
                assert not response.headers.get("ETag")
                assert not response.headers.get("Last-Modified")
                assert response.headers.get("Cache-Control") == module.THUMB_404_CACHE_CONTROL

                # A GET must not mutate disk -- the truncated file is left
                # exactly as it was; it's repaired the ordinary way, by a
                # later `savePreview`, never by this route.
                with open(preview_path, "rb") as fh:
                    assert fh.read() == truncated
            finally:
                restore_pillow()
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_still_returns_200_downscaled_for_a_valid_real_preview_when_pillow_is_available():
    # The other half of the same fix: a genuinely GOOD file must not be
    # collaterally 404'd just because Pillow is (simulated as) installed.
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            valid = _build_minimal_png_bytes()
            restore_fp, preview_path = _make_lora_with_preview(tmp, preview_bytes=valid)
            restore_pillow = _with_simulated_pillow(module, _RealisticPngImageModule())
            try:
                response = asyncio.run(
                    handler(_FakeRequest(query={"kind": "loras", "name": "a.safetensors"}))
                )
                assert response.status == 200
                assert response.body == b"FAKE:PNG:1x1"  # re-encoded, not the untouched original
                assert response.headers.get("ETag")
            finally:
                restore_pillow()
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_still_returns_200_with_the_original_bytes_when_pillow_is_absent_even_for_a_truncated_preview():
    # The regression this fix must NOT introduce (task brief, non-
    # negotiable): Pillow simply being ABSENT -- as opposed to installed but
    # failing to decode -- must still silently serve the untouched original,
    # even for a file that happens to be truncated; otherwise every preview
    # on a no-Pillow install would start 404ing. No monkeypatch here -- this
    # genuinely exercises this environment's real absence of Pillow
    # (verified elsewhere: `import PIL` fails here).
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            truncated = _truncate_png_bytes(_build_minimal_png_bytes())
            restore_fp, preview_path = _make_lora_with_preview(tmp, preview_bytes=truncated)
            try:
                response = asyncio.run(
                    handler(_FakeRequest(query={"kind": "loras", "name": "a.safetensors"}))
                )
                assert response.status == 200
                assert response.body == truncated
            finally:
                restore_fp()
    finally:
        _restore_sys_modules(previous)


# ---------------------------------------------------------------------------
# "The conditional-GET 304 bypasses the undecodable check" (2026-08-04 fix,
# see `thumb_cache_known_state`'s own doc comment in `src/model_browser/
# api.py`): a 304 must only be sent once THIS `(path, mtime, max_edge)` is
# positively known to decode -- not merely because an ETag (derived purely
# from on-disk mtime/size, which a corrupt file's own re-save never changes)
# happens to match. The COLD-CACHE cases below are the ones an obvious "just
# check the sentinel" fix would still get wrong: right after a process
# restart the in-memory downscale cache is genuinely empty, so "no entry"
# must NOT be silently treated as "known good".
# ---------------------------------------------------------------------------


def test_thumb_route_matching_if_none_match_for_known_undecodable_stays_404_with_no_store():
    # Cache warmed: the FIRST call below already establishes this exact
    # (path, mtime, max_edge) as undecodable (`thumb_cache_known_state` ==
    # "bad"). A later conditional request with a matching `If-None-Match`
    # must still 404 -- a 304 here would tell a stale browser its cached
    # BROKEN image is still current, exactly the bug this fix closes.
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            truncated = _truncate_png_bytes(_build_minimal_png_bytes())
            restore_fp, preview_path = _make_lora_with_preview(tmp, preview_bytes=truncated)
            restore_pillow = _with_simulated_pillow(module, _RealisticPngImageModule())
            try:
                first = asyncio.run(
                    handler(_FakeRequest(query={"kind": "loras", "name": "a.safetensors"}))
                )
                assert first.status == 404  # warms the "bad" cache entry

                stat = module.thumb_stat_impl(preview_path)
                etag = module.thumb_etag(stat[0], stat[1], module.DEFAULT_THUMB_MAX_EDGE)

                second = asyncio.run(
                    handler(
                        _FakeRequest(
                            query={"kind": "loras", "name": "a.safetensors"},
                            headers={"If-None-Match": etag},
                        )
                    )
                )
                assert second.status == 404, "a known-undecodable file must never 304"
                assert not second.headers.get("ETag")
                assert second.headers.get("Cache-Control") == module.THUMB_404_CACHE_CONTROL
            finally:
                restore_pillow()
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_cold_cache_conditional_request_for_corrupt_file_does_not_304():
    # THE bug itself, reproduced: a browser cached the pre-`3e02428` broken
    # 200 with an ETag derived purely from (mtime, size, max_edge) -- both
    # UNCHANGED by a server restart. A naive fix ("ETag matches => 304")
    # would keep serving that same cached broken image forever, since the
    # corrupt file's own mtime/size never change. Simulated here by
    # re-importing `api.py` between the two calls -- a fresh, EMPTY
    # in-process downscale cache is exactly the shape of an actual ComfyUI
    # restart -- then sending the conditional GET a stale-cache browser
    # would issue right after: an `If-None-Match` computed from the
    # (unchanged) file stat, against a process that has never decoded
    # anything yet.
    module1, fake_routes1, previous1 = _install_fake_aiohttp_and_server()
    handler1 = fake_routes1.handlers.get(("GET", "/wtn/model_browser/thumb"))
    with tempfile.TemporaryDirectory() as tmp:
        truncated = _truncate_png_bytes(_build_minimal_png_bytes())
        restore_fp, preview_path = _make_lora_with_preview(tmp, preview_bytes=truncated)
        try:
            stat = module1.thumb_stat_impl(preview_path)
            etag = module1.thumb_etag(stat[0], stat[1], module1.DEFAULT_THUMB_MAX_EDGE)

            # "Restart": re-import the module fresh -- `_thumb_downscale_
            # cache` is a brand-new, empty `OrderedDict` in the new module
            # object, even though the file on disk (and the ETag above) is
            # unchanged.
            module2, fake_routes2, previous2 = _install_fake_aiohttp_and_server()
            handler2 = fake_routes2.handlers.get(("GET", "/wtn/model_browser/thumb"))
            restore_pillow2 = _with_simulated_pillow(module2, _RealisticPngImageModule())
            try:
                response = asyncio.run(
                    handler2(
                        _FakeRequest(
                            query={"kind": "loras", "name": "a.safetensors"},
                            headers={"If-None-Match": etag},
                        )
                    )
                )
                assert response.status == 404, "a cold cache must not trust a matching ETag into a 304"
                assert response.headers.get("Cache-Control") == module2.THUMB_404_CACHE_CONTROL
                assert not response.headers.get("ETag")
            finally:
                restore_pillow2()
                _restore_sys_modules(previous2)
        finally:
            restore_fp()
    _restore_sys_modules(previous1)


def test_thumb_route_cold_cache_conditional_request_for_valid_file_decodes_then_next_one_304s():
    # The other half of the same scenario: a GENUINELY good file, cold
    # cache, conditional request -- must decode (not 304 on faith), and
    # having done so once, the VERY NEXT conditional request for the same
    # key gets the fast 304 path again ("known-good" now populated).
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            valid = _build_minimal_png_bytes()
            restore_fp, preview_path = _make_lora_with_preview(tmp, preview_bytes=valid)
            restore_pillow = _with_simulated_pillow(module, _RealisticPngImageModule())
            try:
                stat = module.thumb_stat_impl(preview_path)
                etag = module.thumb_etag(stat[0], stat[1], module.DEFAULT_THUMB_MAX_EDGE)

                first = asyncio.run(
                    handler(
                        _FakeRequest(
                            query={"kind": "loras", "name": "a.safetensors"},
                            headers={"If-None-Match": etag},
                        )
                    )
                )
                assert first.status == 200, "an empty cache must not 304 on faith alone"
                assert first.body == b"FAKE:PNG:1x1"

                second = asyncio.run(
                    handler(
                        _FakeRequest(
                            query={"kind": "loras", "name": "a.safetensors"},
                            headers={"If-None-Match": etag},
                        )
                    )
                )
                assert second.status == 304, "the decode above must have populated the cache as known-good"
            finally:
                restore_pillow()
                restore_fp()
    finally:
        _restore_sys_modules(previous)


def test_thumb_route_pillow_absent_conditional_request_on_cold_cache_still_200s_with_original_bytes():
    # No monkeypatch -- genuinely exercises Pillow's real absence in this
    # environment (verified elsewhere: `import PIL` fails here). A
    # conditional request against a COLD cache must not 304 just because the
    # ETag happens to match ("unknown" state, same as the corrupt-file case
    # above) -- it falls through to `thumb_bytes_impl`, which (Pillow being
    # absent) serves the untouched original, the SAME silent fallback an
    # unconditional request already gets (pinned by
    # `test_thumb_route_still_returns_200_with_the_original_bytes_when_
    # pillow_is_absent_even_for_a_truncated_preview` above).
    module, fake_routes, previous = _install_fake_aiohttp_and_server()
    try:
        handler = fake_routes.handlers.get(("GET", "/wtn/model_browser/thumb"))
        with tempfile.TemporaryDirectory() as tmp:
            truncated = _truncate_png_bytes(_build_minimal_png_bytes())
            restore_fp, preview_path = _make_lora_with_preview(tmp, preview_bytes=truncated)
            try:
                stat = module.thumb_stat_impl(preview_path)
                etag = module.thumb_etag(stat[0], stat[1], module.DEFAULT_THUMB_MAX_EDGE)

                response = asyncio.run(
                    handler(
                        _FakeRequest(
                            query={"kind": "loras", "name": "a.safetensors"},
                            headers={"If-None-Match": etag},
                        )
                    )
                )
                assert response.status == 200, "a cold cache must not 304 even when Pillow is absent"
                assert response.body == truncated
            finally:
                restore_fp()
    finally:
        _restore_sys_modules(previous)


# ---------------------------------------------------------------------------
# `thumb_cache_known_state` itself, in isolation.
# ---------------------------------------------------------------------------


def test_thumb_cache_known_state_is_unknown_for_a_never_seen_key():
    key = ("/some/path.png", 111.0, 256)
    assert mb_api.thumb_cache_known_state(key) == "unknown"


def test_thumb_cache_known_state_is_good_after_a_successful_decode_is_cached():
    key = ("/some/other-path.png", 222.0, 256)
    mb_api._thumb_cache_put(key, b"decoded-bytes")
    try:
        assert mb_api.thumb_cache_known_state(key) == "good"
    finally:
        mb_api._thumb_downscale_cache.pop(key, None)


def test_thumb_cache_known_state_is_bad_after_the_undecodable_sentinel_is_cached():
    key = ("/some/third-path.png", 333.0, 256)
    mb_api._thumb_cache_put(key, mb_api._THUMB_UNDECODABLE)
    try:
        assert mb_api.thumb_cache_known_state(key) == "bad"
    finally:
        mb_api._thumb_downscale_cache.pop(key, None)


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
    test_thumb_route_returns_404_with_no_store_for_a_genuinely_truncated_real_preview,
    test_thumb_route_still_returns_200_downscaled_for_a_valid_real_preview_when_pillow_is_available,
    test_thumb_route_still_returns_200_with_the_original_bytes_when_pillow_is_absent_even_for_a_truncated_preview,
    test_thumb_route_matching_if_none_match_for_known_undecodable_stays_404_with_no_store,
    test_thumb_route_cold_cache_conditional_request_for_corrupt_file_does_not_304,
    test_thumb_route_cold_cache_conditional_request_for_valid_file_decodes_then_next_one_304s,
    test_thumb_route_pillow_absent_conditional_request_on_cold_cache_still_200s_with_original_bytes,
    test_thumb_cache_known_state_is_unknown_for_a_never_seen_key,
    test_thumb_cache_known_state_is_good_after_a_successful_decode_is_cached,
    test_thumb_cache_known_state_is_bad_after_the_undecodable_sentinel_is_cached,
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
