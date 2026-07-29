"""Plain-script tests for `src/model_browser/` -- the shared, kind-
parameterised local-file + Civitai library behind `Anima LoRA Loader`
(docs/lora-loader-design.md).

Covers: the `kind` whitelist (incl. rejecting a traversal attempt); local
file listing + safetensors metadata + preview discovery, against real temp
files; the sidecar cache; pure Civitai-response parsing from recorded-shape
JSON (incl. the no-`trainedWords`/no-`model.name` FOUND case, and that
`tags` survive); the HTTP transport's host-fallback/timeout/oversized-body/
distinct-offline-reason behaviour, via an injectable fake opener (no real
network); the `lookup`/`sidecar` orchestration; and the aiohttp routes'
pure `*_impl` bodies (always a `reason`, kind whitelist enforced before any
`folder_paths` import).

`folder_paths` is stubbed via `sys.modules` only for the tests that need
it -- the whitelist-rejection tests deliberately do NOT stub it, which is
itself part of what they prove (an unwhitelisted `kind` never reaches the
lazy `import folder_paths` at all, in an environment where that import
would otherwise fail).

Run directly: `python tests/test_model_browser.py` (no pytest, per project convention).
"""
from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
import types
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.model_browser import api as mb_api
from src.model_browser import civitai_client, civitai_parse, hashing, kinds, local, lookup, sidecar

# ---------------------------------------------------------------------------
# kinds.py -- the whitelist / security boundary
# ---------------------------------------------------------------------------


def test_folder_for_kind_known_kinds():
    assert kinds.folder_for_kind("loras") == "loras"
    assert kinds.folder_for_kind("checkpoints") == "checkpoints"
    assert kinds.folder_for_kind("unet") == "diffusion_models"


def test_folder_for_kind_rejects_traversal_and_garbage():
    for bad in ("../../etc", "../../../etc/passwd", "", None, 42, ["loras"], "LORAS", "lora"):
        assert kinds.folder_for_kind(bad) is None, bad


def test_only_loras_is_an_active_kind_today():
    assert kinds.is_active_kind("loras") is True
    assert kinds.is_active_kind("checkpoints") is False
    assert kinds.is_active_kind("unet") is False
    assert kinds.is_active_kind("../../etc") is False


# ---------------------------------------------------------------------------
# local.py -- safetensors metadata, preview discovery, path resolution --
# against REAL temp files (no folder_paths needed for the header-reading
# functions themselves).
# ---------------------------------------------------------------------------


def _write_fake_safetensors(path, metadata):
    """A minimal file shaped like a real safetensors header: an 8-byte
    little-endian length prefix, then that many bytes of JSON with a
    `__metadata__` key -- NO tensor data, since that's all
    `read_safetensors_metadata` ever reads."""
    header = json.dumps({"__metadata__": metadata}).encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(struct.pack("<Q", len(header)))
        fh.write(header)


def test_read_safetensors_metadata_real_file():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "a.safetensors")
        _write_fake_safetensors(path, {"modelspec.trigger_phrase": "foo, bar", "modelspec.architecture": "SDXL 1.0"})
        meta = local.read_safetensors_metadata(path)
        assert meta["modelspec.trigger_phrase"] == "foo, bar"


def test_read_safetensors_metadata_missing_or_truncated_file_never_raises():
    with tempfile.TemporaryDirectory() as tmp:
        assert local.read_safetensors_metadata(os.path.join(tmp, "nope.safetensors")) == {}
        truncated = os.path.join(tmp, "trunc.safetensors")
        with open(truncated, "wb") as fh:
            fh.write(b"\x05\x00\x00")  # fewer than 8 bytes
        assert local.read_safetensors_metadata(truncated) == {}


def test_read_safetensors_metadata_garbage_length_prefix_never_raises():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "bad.safetensors")
        with open(path, "wb") as fh:
            fh.write(struct.pack("<Q", 1 << 40))  # absurd length, over the cap
            fh.write(b"not enough bytes")
        assert local.read_safetensors_metadata(path) == {}


def test_trigger_words_from_metadata_dedupes_and_falls_back():
    assert local.trigger_words_from_metadata({"modelspec.trigger_phrase": "Foo, foo, Bar"}) == ["Foo", "Bar"]
    assert local.trigger_words_from_metadata({"ss_trigger_words": "only, this"}) == ["only", "this"]
    assert local.trigger_words_from_metadata({}) == []
    assert local.trigger_words_from_metadata("not-a-dict") == []


def test_base_model_from_metadata_priority_order():
    assert local.base_model_from_metadata({"modelspec.architecture": "SDXL 1.0", "ss_sd_model_name": "other"}) == "SDXL 1.0"
    assert local.base_model_from_metadata({"ss_base_model_version": "SDXL_1.0"}) == "SDXL_1.0"
    assert local.base_model_from_metadata({"ss_sd_model_name": "some_model.safetensors"}) == "some_model.safetensors"
    assert local.base_model_from_metadata({}) == ""


def test_find_preview_path():
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "a.safetensors")
        open(model_path, "wb").close()
        assert local.find_preview_path(model_path) is None
        preview = os.path.join(tmp, "a.preview.png")
        open(preview, "wb").close()
        assert local.find_preview_path(model_path) == preview


# ---------------------------------------------------------------------------
# resolve_model_path / list_models -- with a stubbed folder_paths.
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


def test_resolve_model_path_rejects_unwhitelisted_kind_without_touching_folder_paths():
    # No folder_paths stub installed at all -- if the whitelist check didn't
    # short-circuit BEFORE the lazy `import folder_paths`, this would raise
    # ModuleNotFoundError in this ComfyUI-less test environment instead of
    # returning None.
    assert local.resolve_model_path("../../etc", "passwd") is None
    assert local.resolve_model_path("not-a-real-kind", "a.safetensors") is None


def test_resolve_model_path_happy_path_and_traversal_guard():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        outside_root = os.path.join(tmp, "outside")
        os.makedirs(loras_root)
        os.makedirs(outside_root)
        good_path = os.path.join(loras_root, "a.safetensors")
        open(good_path, "wb").close()
        # A file that genuinely exists on disk but OUTSIDE the configured
        # loras directory -- simulates folder_paths resolving somewhere it
        # shouldn't (the actual traversal scenario the guard exists for).
        outside_path = os.path.join(outside_root, "escaped.safetensors")
        open(outside_path, "wb").close()

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            import folder_paths as fp

            assert local.resolve_model_path("loras", "a.safetensors") == good_path
            assert local.resolve_model_path("loras", "does-not-exist.safetensors") is None

            # Simulate a resolver returning a path outside the configured
            # roots (e.g. a crafted name that `folder_paths` itself
            # mis-resolves) -- the guard must still refuse it.
            fp.get_full_path = lambda folder, name: outside_path
            assert local.resolve_model_path("loras", "escaped.safetensors") is None
        finally:
            restore()


def test_resolve_model_path_rejects_a_hostile_absolute_path_as_name():
    # `os.path.join(root, name)` DISCARDS `root` entirely when `name` is
    # itself absolute -- the classic real-world footgun a naive
    # `folder_paths.get_full_path` (ours here does exactly `os.path.join`
    # then `os.path.isfile`, matching real `folder_paths` shape) could hit
    # if handed a client-supplied absolute path as `name`. `/etc/passwd` is
    # a real, always-present file on this test platform, standing in for
    # "some real file the naive join ends up pointing at".
    assert os.path.isfile("/etc/passwd"), "test platform assumption (POSIX /etc/passwd)"
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": []},
        )
        try:
            assert local.resolve_model_path("loras", "/etc/passwd") is None
        finally:
            restore()


def test_resolve_model_path_rejects_a_dotdot_laden_name_that_escapes_its_root():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        secret_dir = os.path.join(tmp, "secret")
        os.makedirs(loras_root)
        os.makedirs(secret_dir)
        secret_path = os.path.join(secret_dir, "secret.txt")
        open(secret_path, "wb").close()

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": []},
        )
        try:
            traversal_name = os.path.join("..", "secret", "secret.txt")
            # Sanity check: the naive join really DOES escape `loras_root`
            # and land on a real file -- proving the GUARD (not merely an
            # absent target) is what makes this resolve to `None` below.
            assert os.path.isfile(os.path.join(loras_root, traversal_name))
            assert local.resolve_model_path("loras", traversal_name) is None
        finally:
            restore()


def test_resolve_model_path_hostile_windows_separator_name_never_raises():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": []},
        )
        try:
            # Windows-style traversal strings -- on this (POSIX) test
            # platform the backslashes are just literal filename characters,
            # so these degrade to "no such file" rather than a real escape,
            # but the point is that resolution NEVER raises regardless of
            # platform or separator style a client happens to send.
            for hostile in (
                "..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts",
                "..\\secret.txt",
                "C:\\Windows\\System32\\config\\SAM",
            ):
                assert local.resolve_model_path("loras", hostile) is None, hostile
        finally:
            restore()


def test_list_models_skips_a_hostile_name_that_escapes_its_root():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        secret_dir = os.path.join(tmp, "secret")
        os.makedirs(loras_root)
        os.makedirs(secret_dir)
        open(os.path.join(loras_root, "a.safetensors"), "wb").close()
        open(os.path.join(secret_dir, "secret.safetensors"), "wb").close()

        traversal_name = os.path.join("..", "secret", "secret.safetensors")
        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors", traversal_name]},
        )
        try:
            models = local.list_models("loras")
            names = [m["name"] for m in models]
            assert "a.safetensors" in names
            assert traversal_name not in names  # the escaping entry is dropped, not listed
        finally:
            restore()


def test_list_models_groups_by_subfolder_and_reads_metadata():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(os.path.join(loras_root, "detail"))
        top_path = os.path.join(loras_root, "top.safetensors")
        sub_path = os.path.join(loras_root, "detail", "sub.safetensors")
        _write_fake_safetensors(top_path, {"modelspec.trigger_phrase": "toptrig", "modelspec.architecture": "SDXL"})
        open(sub_path, "wb").close()  # no metadata at all

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["top.safetensors", "detail/sub.safetensors"]},
        )
        try:
            models = local.list_models("loras")
            by_name = {m["name"]: m for m in models}
            assert by_name["top.safetensors"]["group"] == "All"
            assert by_name["top.safetensors"]["base_model"] == "SDXL"
            assert by_name["top.safetensors"]["triggers"] == ["toptrig"]
            assert by_name["detail/sub.safetensors"]["group"] == "detail"
            assert by_name["detail/sub.safetensors"]["triggers"] == []
            assert by_name["detail/sub.safetensors"]["base_model"] == ""
        finally:
            restore()


def test_list_models_unwhitelisted_kind_returns_empty_without_folder_paths():
    assert local.list_models("../../etc") == []


# ---------------------------------------------------------------------------
# sidecar.py -- read / write / delete, against real temp files.
# ---------------------------------------------------------------------------


def test_sidecar_round_trip_and_forget():
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "a.safetensors")
        open(model_path, "wb").close()

        assert sidecar.read_sidecar(model_path) is None
        assert sidecar.write_sidecar(model_path, {"modelId": 1, "id": 2}) is True
        assert sidecar.read_sidecar(model_path) == {"modelId": 1, "id": 2}
        assert os.path.isfile(sidecar.sidecar_path(model_path))

        assert sidecar.delete_sidecar(model_path) is True
        assert sidecar.read_sidecar(model_path) is None
        # Deleting again (already absent) is still a success, not a failure.
        assert sidecar.delete_sidecar(model_path) is True


# ---------------------------------------------------------------------------
# civitai_parse.py -- pure, from recorded-shape JSON.
# ---------------------------------------------------------------------------


def test_parse_model_version_typical_response():
    obj = {
        "id": 12345,
        "modelId": 999,
        "baseModel": "Illustrious",
        "trainedWords": ["mychar", "blue hair"],
        "description": "Use at 0.8 strength.",
        "model": {"name": "My Character LoRA", "type": "LORA", "tags": ["character", "anime"]},
        "images": [{"url": "https://example.com/img/original=true/x.jpg", "nsfw": "None", "nsfwLevel": 1}],
    }
    parsed = civitai_parse.parse_model_version(obj)
    assert parsed["name"] == "My Character LoRA"
    assert parsed["type"] == "LORA"
    assert parsed["base_model"] == "Illustrious"
    assert parsed["triggers"] == ["mychar", "blue hair"]
    assert parsed["tags"] == ["character", "anime"]  # KEPT -- our divergence from upstream
    assert parsed["model_id"] == 999
    assert parsed["version_id"] == 12345
    assert parsed["thumbnail"] == "https://example.com/img/width=256/x.jpg"
    assert parsed["description"] == "Use at 0.8 strength."


def test_parse_model_version_no_trainedwords_no_model_name_still_found():
    # §2b's specific regression: a response with NEITHER trainedWords NOR
    # model.name must still parse to something USABLE (non-empty), as long
    # as anything else identifying is present.
    obj = {"id": 1, "modelId": 2, "baseModel": "SD 1.5", "model": {"type": "LORA"}}
    parsed = civitai_parse.parse_model_version(obj)
    assert "triggers" not in parsed
    assert "name" not in parsed
    assert parsed  # non-empty -> FOUND, not notfound
    assert parsed["base_model"] == "SD 1.5"
    assert parsed["type"] == "LORA"


def test_parse_model_version_genuinely_empty_response_parses_to_nothing():
    assert civitai_parse.parse_model_version({}) == {}
    assert civitai_parse.parse_model_version(None) == {}
    assert civitai_parse.parse_model_version("not-a-dict") == {}
    assert civitai_parse.parse_model_version([1, 2, 3]) == {}


def test_parse_model_version_top_level_tags_win_over_model_tags():
    obj = {"tags": ["top"], "model": {"tags": ["nested"]}}
    assert civitai_parse.parse_model_version(obj)["tags"] == ["top"]


def test_parse_model_version_tags_as_dicts_are_tolerated():
    obj = {"model": {"tags": [{"name": "character"}, {"name": "style"}]}}
    assert civitai_parse.parse_model_version(obj)["tags"] == ["character", "style"]


def test_parse_model_version_explicit_gallery_falls_back_to_non_adult():
    obj = {
        "images": [
            {"url": "https://example.com/explicit.jpg", "nsfw": "X", "nsfwLevel": 8},
            {"url": "https://example.com/original=true/safe.jpg", "nsfw": False, "nsfwLevel": 1},
        ],
    }
    # The safe image should win even though it's second, since the first is adult.
    assert civitai_parse.parse_model_version(obj)["thumbnail"] == "https://example.com/width=256/safe.jpg"


def test_parse_model_version_all_explicit_gallery_yields_no_thumbnail():
    obj = {"images": [{"url": "https://example.com/explicit.jpg", "nsfw": "XXX", "nsfwLevel": 16}]}
    assert "thumbnail" not in civitai_parse.parse_model_version(obj)


# ---------------------------------------------------------------------------
# civitai_client.py -- HTTP transport, via an injectable fake opener.
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        if n is None or n < 0:
            data, self._body = self._body, b""
        else:
            data, self._body = self._body[:n], self._body[n:]
        return data


def _sequence_opener(steps):
    """`steps`: a list of callables, one per expected `opener(url, timeout)`
    call, each either returning a `_FakeResponse` or raising. Returns
    `(opener, calls)` where `calls` records every `(url, timeout)` seen."""
    calls = []

    def opener(url, timeout):
        calls.append((url, timeout))
        step = steps[len(calls) - 1]
        return step()

    return opener, calls


def test_lookup_by_hash_success_on_first_host():
    body = json.dumps({"id": 1, "modelId": 2}).encode("utf-8")
    opener, calls = _sequence_opener([lambda: _FakeResponse(body)])
    result = civitai_client.lookup_by_hash("deadbeef", opener=opener)
    assert result["reason"] == "found"
    assert result["data"] == {"id": 1, "modelId": 2}
    assert len(calls) == 1


def test_lookup_by_hash_404_is_definitive_and_never_tries_backup_host():
    def raise_404():
        raise urllib.error.HTTPError("url", 404, "Not Found", None, None)

    opener, calls = _sequence_opener([raise_404])
    result = civitai_client.lookup_by_hash("deadbeef", opener=opener)
    assert result["reason"] == "notfound"
    assert len(calls) == 1  # backup host NEVER tried


def test_lookup_by_hash_non_404_error_falls_through_to_backup_host():
    def raise_500():
        raise urllib.error.HTTPError("url", 500, "Server Error", None, None)

    body = json.dumps({"id": 5}).encode("utf-8")
    opener, calls = _sequence_opener([raise_500, lambda: _FakeResponse(body)])
    result = civitai_client.lookup_by_hash("deadbeef", opener=opener)
    assert result["reason"] == "found"
    assert len(calls) == 2  # both hosts tried


def test_lookup_by_hash_oversized_body_is_rejected():
    huge = b"x" * (5 * 1024 * 1024)
    opener, calls = _sequence_opener([lambda: _FakeResponse(huge), lambda: _FakeResponse(huge)])
    result = civitai_client.lookup_by_hash("deadbeef", opener=opener, max_body_bytes=4 * 1024 * 1024)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "unreadable"


def test_lookup_by_hash_unreadable_body_is_distinct_reason():
    opener, calls = _sequence_opener([
        lambda: _FakeResponse(b"<html>login required</html>"),
        lambda: _FakeResponse(b"<html>login required</html>"),
    ])
    result = civitai_client.lookup_by_hash("deadbeef", opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "unreadable"


def test_lookup_by_hash_timeout_is_distinct_reason():
    import socket

    def raise_timeout():
        raise socket.timeout("timed out")

    opener, calls = _sequence_opener([raise_timeout, raise_timeout])
    result = civitai_client.lookup_by_hash("deadbeef", opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "timeout"


def test_lookup_by_hash_dns_failure_is_distinct_reason():
    import socket

    def raise_dns():
        raise urllib.error.URLError(socket.gaierror("nodename nor servname provided"))

    opener, calls = _sequence_opener([raise_dns, raise_dns])
    result = civitai_client.lookup_by_hash("deadbeef", opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "dns_tls"


def test_lookup_by_hash_429_is_distinct_reason_and_falls_through():
    def raise_429():
        raise urllib.error.HTTPError("url", 429, "Too Many Requests", None, None)

    opener, calls = _sequence_opener([raise_429, raise_429])
    result = civitai_client.lookup_by_hash("deadbeef", opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "rate_limited"
    assert len(calls) == 2  # 429 IS transient -- both hosts tried


# ---------------------------------------------------------------------------
# hashing.py -- chunked sha256 against a real file.
# ---------------------------------------------------------------------------


def test_sha256_file_matches_hashlib_and_streams_in_chunks():
    import hashlib

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "data.bin")
        payload = os.urandom(1024 * 10 + 7)  # not a clean multiple of the chunk size
        with open(path, "wb") as fh:
            fh.write(payload)
        expected = hashlib.sha256(payload).hexdigest()
        assert hashing.sha256_file(path, chunk_size=1024) == expected
        assert hashing.sha256_file(path) == expected  # default chunk size too


def test_sha256_file_missing_file_raises_oserror():
    try:
        hashing.sha256_file("/no/such/path/at/all.safetensors")
        assert False, "expected OSError"
    except OSError:
        pass


# ---------------------------------------------------------------------------
# lookup.py -- orchestration: sidecar -> hash -> fetch -> sidecar write.
# ---------------------------------------------------------------------------


def test_lookup_model_info_missing_file_is_offline_missing_file():
    result = lookup.lookup_model_info("../../etc", "passwd")
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "missing_file"


def test_lookup_model_info_cached_sidecar_short_circuits_network():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {"modelId": 1, "id": 2, "baseModel": "SDXL"})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_lookup = civitai_client.lookup_by_hash

        def _must_not_be_called(*args, **kwargs):
            raise AssertionError("network lookup must not run when a sidecar is cached")

        lookup.civitai_client.lookup_by_hash = _must_not_be_called
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["reason"] == "found"
            assert result["source"] == "sidecar"
            assert result["data"]["base_model"] == "SDXL"
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            restore()


def test_lookup_model_info_no_sidecar_fetches_hashes_and_writes_sidecar():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        with open(model_path, "wb") as fh:
            fh.write(b"some lora bytes")

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_lookup = civitai_client.lookup_by_hash
        seen_hashes = []

        def fake_lookup_by_hash(sha, **kwargs):
            seen_hashes.append(sha)
            return {
                "reason": "found", "offline_reason": None, "message": "",
                "data": {"modelId": 7, "id": 8, "baseModel": "Pony"},
            }

        lookup.civitai_client.lookup_by_hash = fake_lookup_by_hash
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["reason"] == "found"
            assert result["source"] == "civitai"
            assert result["data"]["base_model"] == "Pony"
            assert len(seen_hashes) == 1 and len(seen_hashes[0]) == 64  # a real sha256 hex digest

            # The raw response is now cached -- a SECOND lookup must hit the
            # sidecar and NOT call the network again.
            lookup.civitai_client.lookup_by_hash = _must_not_be_called_again
            result2 = lookup.lookup_model_info("loras", "a.safetensors")
            assert result2["reason"] == "found" and result2["source"] == "sidecar"
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            restore()


def _must_not_be_called_again(*args, **kwargs):
    raise AssertionError("must use the freshly-written sidecar, not the network")


def test_lookup_model_info_offline_and_notfound_pass_through():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_lookup = civitai_client.lookup_by_hash
        try:
            lookup.civitai_client.lookup_by_hash = lambda sha, **kw: {
                "reason": "offline", "offline_reason": "timeout", "message": "Civitai timed out.", "data": None,
            }
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["reason"] == "offline" and result["offline_reason"] == "timeout"

            lookup.civitai_client.lookup_by_hash = lambda sha, **kw: {
                "reason": "notfound", "offline_reason": None, "message": "", "data": None,
            }
            result2 = lookup.lookup_model_info("loras", "a.safetensors")
            assert result2["reason"] == "notfound"
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            restore()


def test_lookup_model_info_found_but_unparseable_degrades_to_notfound():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_lookup = civitai_client.lookup_by_hash
        try:
            lookup.civitai_client.lookup_by_hash = lambda sha, **kw: {
                "reason": "found", "offline_reason": None, "message": "", "data": {},  # parses to nothing
            }
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["reason"] == "notfound"
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            restore()


def test_lookup_model_info_cached_only_with_a_sidecar_returns_found_and_never_touches_network():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {"modelId": 1, "id": 2, "baseModel": "SDXL"})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_lookup = civitai_client.lookup_by_hash
        previous_hash = hashing.sha256_file

        def _network_must_not_run(*args, **kwargs):
            raise AssertionError("network lookup must not run when a sidecar is cached")

        def _hash_must_not_run(*args, **kwargs):
            raise AssertionError("hashing must not run when a sidecar is cached")

        lookup.civitai_client.lookup_by_hash = _network_must_not_run
        lookup.hashing.sha256_file = _hash_must_not_run
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors", cached_only=True)
            assert result["reason"] == "found"
            assert result["source"] == "sidecar"
            assert result["data"]["base_model"] == "SDXL"

            # `cached_only` WINS over `force_refresh` -- the cache is still
            # checked (and the network still never touched) even if a caller
            # asked for a refresh at the same time.
            result2 = lookup.lookup_model_info("loras", "a.safetensors", force_refresh=True, cached_only=True)
            assert result2["reason"] == "found" and result2["source"] == "sidecar"
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            lookup.hashing.sha256_file = previous_hash
            restore()


def test_lookup_model_info_cached_only_with_no_sidecar_degrades_offline_civitai_disabled_before_hashing():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        with open(model_path, "wb") as fh:
            fh.write(b"some lora bytes")  # NOT empty -- a real hash would succeed, proving it never ran

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_lookup = civitai_client.lookup_by_hash
        previous_hash = hashing.sha256_file

        def _network_must_not_run(*args, **kwargs):
            raise AssertionError("cached_only must never reach civitai_client.lookup_by_hash")

        def _hash_must_not_run(*args, **kwargs):
            raise AssertionError("cached_only must return BEFORE hashing.sha256_file is ever reached")

        lookup.civitai_client.lookup_by_hash = _network_must_not_run
        lookup.hashing.sha256_file = _hash_must_not_run
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors", cached_only=True)
            assert result["reason"] == "offline"
            assert result["offline_reason"] == "civitai_disabled"
            assert result["data"] is None
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            lookup.hashing.sha256_file = previous_hash
            restore()


def test_lookup_impl_passes_cached_only_through_to_lookup_model_info():
    calls = []

    def fake_lookup_model_info(kind, name, *, force_refresh=False, cached_only=False):
        calls.append((kind, name, force_refresh, cached_only))
        return {"reason": "offline", "offline_reason": "civitai_disabled", "message": "", "data": None}

    previous = mb_api.lookup_mod.lookup_model_info
    mb_api.lookup_mod.lookup_model_info = fake_lookup_model_info
    try:
        result = mb_api.lookup_impl({"kind": "loras", "name": "a.safetensors", "cached_only": True})
        assert result["offline_reason"] == "civitai_disabled"
        assert calls == [("loras", "a.safetensors", False, True)]
    finally:
        mb_api.lookup_mod.lookup_model_info = previous


def test_forget_cached():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {"modelId": 1})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            assert lookup.forget_cached("loras", "a.safetensors") is True
            assert sidecar.read_sidecar(model_path) is None
        finally:
            restore()


def test_forget_cached_unresolvable_model_returns_false():
    assert lookup.forget_cached("../../etc", "passwd") is False


# ---------------------------------------------------------------------------
# api.py -- pure route impls: always a `reason`, whitelist before anything
# touches folder_paths.
# ---------------------------------------------------------------------------


def test_list_models_impl_rejects_traversal_kind_without_folder_paths():
    result = mb_api.list_models_impl({"kind": "../../etc"})
    assert result["reason"] == "invalid_kind"
    assert result["models"] == []


def test_lookup_impl_rejects_traversal_kind_without_folder_paths():
    result = mb_api.lookup_impl({"kind": "../../etc", "name": "passwd"})
    assert result["reason"] == "invalid_kind"


def test_forget_impl_rejects_traversal_kind_without_folder_paths():
    result = mb_api.forget_impl({"kind": "../../etc", "name": "passwd"})
    assert result["reason"] == "invalid_kind"


def test_list_models_impl_missing_kind_key_is_invalid():
    assert mb_api.list_models_impl({})["reason"] == "invalid_kind"
    assert mb_api.list_models_impl(None)["reason"] == "invalid_kind"


def test_list_models_impl_valid_kind_delegates_to_local_list_models():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        open(os.path.join(loras_root, "a.safetensors"), "wb").close()

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            result = mb_api.list_models_impl({"kind": "loras"})
            assert result["reason"] == "ok"
            assert [m["name"] for m in result["models"]] == ["a.safetensors"]
        finally:
            restore()


def test_forget_impl_valid_kind_returns_ok_with_deleted_flag():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {"modelId": 1})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            result = mb_api.forget_impl({"kind": "loras", "name": "a.safetensors"})
            assert result == {"reason": "ok", "deleted": True}
        finally:
            restore()


def test_thumb_path_impl_rejects_traversal_kind_without_folder_paths():
    result = mb_api.thumb_path_impl({"kind": "../../etc", "name": "passwd"})
    assert result["reason"] == "invalid_kind"
    assert result["path"] is None


def test_thumb_path_impl_missing_kind_key_is_invalid():
    assert mb_api.thumb_path_impl({})["reason"] == "invalid_kind"
    assert mb_api.thumb_path_impl(None)["reason"] == "invalid_kind"


def test_thumb_path_impl_unresolvable_name_is_not_found():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": []},
        )
        try:
            result = mb_api.thumb_path_impl({"kind": "loras", "name": "does-not-exist.safetensors"})
            assert result["reason"] == "not_found"
            assert result["path"] is None
        finally:
            restore()


def test_thumb_path_impl_no_preview_next_to_a_real_file():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        open(os.path.join(loras_root, "a.safetensors"), "wb").close()
        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            result = mb_api.thumb_path_impl({"kind": "loras", "name": "a.safetensors"})
            assert result["reason"] == "no_preview"
            assert result["path"] is None
        finally:
            restore()


def test_thumb_path_impl_ok_when_a_preview_file_sits_next_to_it():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        preview_path = os.path.join(loras_root, "a.preview.png")
        open(preview_path, "wb").close()
        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            result = mb_api.thumb_path_impl({"kind": "loras", "name": "a.safetensors"})
            assert result["reason"] == "ok"
            assert result["path"] == preview_path
        finally:
            restore()


def test_thumb_path_impl_rejects_a_traversal_name_same_guard_as_resolve_model_path():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        secret_dir = os.path.join(tmp, "secret")
        os.makedirs(loras_root)
        os.makedirs(secret_dir)
        open(os.path.join(secret_dir, "secret.safetensors"), "wb").close()
        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": []},
        )
        try:
            traversal_name = os.path.join("..", "secret", "secret.safetensors")
            result = mb_api.thumb_path_impl({"kind": "loras", "name": traversal_name})
            assert result["reason"] == "not_found"
            assert result["path"] is None
        finally:
            restore()


def test_every_impl_route_always_carries_a_reason_key():
    # A lightweight structural guarantee: whatever shape the payload is,
    # every impl function's result carries `reason` -- the contract the
    # aiohttp wrappers rely on to always answer HTTP 200. Deliberately only
    # unwhitelisted/garbage `kind`s here (no `folder_paths` stub in scope);
    # the valid-kind path is covered, WITH a stub, by the dedicated
    # `test_list_models_impl_valid_kind_delegates_to_local_list_models`/
    # `test_forget_impl_valid_kind_returns_ok_with_deleted_flag` above.
    for payload in ({}, {"kind": "bogus"}, {"kind": "../../etc"}, {"kind": None}, None):
        assert "reason" in mb_api.list_models_impl(payload)
        assert "reason" in mb_api.lookup_impl(payload)
        assert "reason" in mb_api.forget_impl(payload)
        assert "reason" in mb_api.thumb_path_impl(payload)


ALL_TESTS = [
    test_folder_for_kind_known_kinds,
    test_folder_for_kind_rejects_traversal_and_garbage,
    test_only_loras_is_an_active_kind_today,
    test_read_safetensors_metadata_real_file,
    test_read_safetensors_metadata_missing_or_truncated_file_never_raises,
    test_read_safetensors_metadata_garbage_length_prefix_never_raises,
    test_trigger_words_from_metadata_dedupes_and_falls_back,
    test_base_model_from_metadata_priority_order,
    test_find_preview_path,
    test_resolve_model_path_rejects_unwhitelisted_kind_without_touching_folder_paths,
    test_resolve_model_path_happy_path_and_traversal_guard,
    test_resolve_model_path_rejects_a_hostile_absolute_path_as_name,
    test_resolve_model_path_rejects_a_dotdot_laden_name_that_escapes_its_root,
    test_resolve_model_path_hostile_windows_separator_name_never_raises,
    test_list_models_skips_a_hostile_name_that_escapes_its_root,
    test_list_models_groups_by_subfolder_and_reads_metadata,
    test_list_models_unwhitelisted_kind_returns_empty_without_folder_paths,
    test_sidecar_round_trip_and_forget,
    test_parse_model_version_typical_response,
    test_parse_model_version_no_trainedwords_no_model_name_still_found,
    test_parse_model_version_genuinely_empty_response_parses_to_nothing,
    test_parse_model_version_top_level_tags_win_over_model_tags,
    test_parse_model_version_tags_as_dicts_are_tolerated,
    test_parse_model_version_explicit_gallery_falls_back_to_non_adult,
    test_parse_model_version_all_explicit_gallery_yields_no_thumbnail,
    test_lookup_by_hash_success_on_first_host,
    test_lookup_by_hash_404_is_definitive_and_never_tries_backup_host,
    test_lookup_by_hash_non_404_error_falls_through_to_backup_host,
    test_lookup_by_hash_oversized_body_is_rejected,
    test_lookup_by_hash_unreadable_body_is_distinct_reason,
    test_lookup_by_hash_timeout_is_distinct_reason,
    test_lookup_by_hash_dns_failure_is_distinct_reason,
    test_lookup_by_hash_429_is_distinct_reason_and_falls_through,
    test_sha256_file_matches_hashlib_and_streams_in_chunks,
    test_sha256_file_missing_file_raises_oserror,
    test_lookup_model_info_missing_file_is_offline_missing_file,
    test_lookup_model_info_cached_sidecar_short_circuits_network,
    test_lookup_model_info_no_sidecar_fetches_hashes_and_writes_sidecar,
    test_lookup_model_info_offline_and_notfound_pass_through,
    test_lookup_model_info_found_but_unparseable_degrades_to_notfound,
    test_lookup_model_info_cached_only_with_a_sidecar_returns_found_and_never_touches_network,
    test_lookup_model_info_cached_only_with_no_sidecar_degrades_offline_civitai_disabled_before_hashing,
    test_lookup_impl_passes_cached_only_through_to_lookup_model_info,
    test_forget_cached,
    test_forget_cached_unresolvable_model_returns_false,
    test_list_models_impl_rejects_traversal_kind_without_folder_paths,
    test_lookup_impl_rejects_traversal_kind_without_folder_paths,
    test_forget_impl_rejects_traversal_kind_without_folder_paths,
    test_list_models_impl_missing_kind_key_is_invalid,
    test_list_models_impl_valid_kind_delegates_to_local_list_models,
    test_forget_impl_valid_kind_returns_ok_with_deleted_flag,
    test_thumb_path_impl_rejects_traversal_kind_without_folder_paths,
    test_thumb_path_impl_missing_kind_key_is_invalid,
    test_thumb_path_impl_unresolvable_name_is_not_found,
    test_thumb_path_impl_no_preview_next_to_a_real_file,
    test_thumb_path_impl_ok_when_a_preview_file_sits_next_to_it,
    test_thumb_path_impl_rejects_a_traversal_name_same_guard_as_resolve_model_path,
    test_every_impl_route_always_carries_a_reason_key,
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
        except Exception as exc:  # noqa: BLE001 - surface unexpected errors as failures too
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
