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
import socket
import struct
import sys
import tempfile
import threading
import time
import types
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.model_browser import api as mb_api
from src.model_browser import (
    civitai_client, civitai_parse, civitai_search, download, hashing, keys,
    kinds, local, lookup, rate_limit, sidecar,
)

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
    # §7d-i: the version's own text is its own first-class field now, never
    # collapsed with the model's write-up (this fixture's `model` sub-object
    # carries no `description` of its own, so `model_description` is absent).
    assert "model_description" not in parsed
    assert parsed["version_description"] == "Use at 0.8 strength."


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
# BUG 2 (2026-07-29 owner report): author's notes never appeared even when
# Civitai has them -- root cause was reading only the per-VERSION
# `description`, never `model.description`.
#
# §7d-i (owner, 2026-07-30): the two are now independent, first-class
# fields -- `model_description` and `version_description` -- never
# collapsed into one, and never gated on each other.
# ---------------------------------------------------------------------------


def test_parse_model_version_both_descriptions_present_are_returned_distinctly():
    obj = {
        "description": "Trained on preview3.",  # per-VERSION -- a changelog, not the write-up
        "model": {"name": "X", "description": "The author's real write-up."},
    }
    parsed = civitai_parse.parse_model_version(obj)
    assert parsed["model_description"] == "The author's real write-up."
    assert parsed["version_description"] == "Trained on preview3."


def test_parse_model_version_only_version_description_leaves_model_description_absent():
    # The REAL by-hash shape (verified live, 2026-07-29): `model` is
    # `{name, type, nsfw, poi}` -- no `description` at all, most of the time.
    obj = {"description": "Use at 0.8 strength.", "model": {"name": "X", "type": "LORA", "nsfw": False, "poi": False}}
    parsed = civitai_parse.parse_model_version(obj)
    assert "model_description" not in parsed
    assert parsed["version_description"] == "Use at 0.8 strength."


def test_parse_model_version_only_model_description_leaves_version_description_absent():
    obj = {"model": {"name": "X", "description": "The author's real write-up."}}
    parsed = civitai_parse.parse_model_version(obj)
    assert parsed["model_description"] == "The author's real write-up."
    assert "version_description" not in parsed


def test_parse_model_version_no_description_anywhere_is_simply_absent():
    obj = {"model": {"name": "X"}}
    parsed = civitai_parse.parse_model_version(obj)
    assert "model_description" not in parsed
    assert "version_description" not in parsed


# ---------------------------------------------------------------------------
# BUG 11a (2026-07-29 owner report): Civitai descriptions are HTML, and the
# author's notes rendered as literal raw markup ("<p>Trained on
# preview3.</p>") because we correctly write with textContent (never
# innerHTML -- that's the XSS boundary and stays put). `html_to_text` is the
# fix: convert to plain text BEFORE it ever reaches `out["model_description"]`
# or `out["version_description"]`.
# ---------------------------------------------------------------------------


def test_html_to_text_owners_exact_example():
    assert civitai_parse.html_to_text("<p>Trained on preview3.</p>") == "Trained on preview3."


def test_html_to_text_multi_paragraph_stays_readable():
    html = "<h1>DreamShaper - V∞!</h1><p>Please check out my other <a href=\"x\">base models</a>.</p>"
    text = civitai_parse.html_to_text(html)
    assert "<" not in text and ">" not in text
    assert "DreamShaper - V∞!" in text
    assert "Please check out my other base models." in text


def test_html_to_text_br_becomes_newline():
    assert civitai_parse.html_to_text("line one<br>line two<br/>line three") == "line one\nline two\nline three"


def test_html_to_text_list_items_get_their_own_line():
    html = "<ul><li>Better at photorealism</li><li>Better at NSFW</li></ul>"
    assert civitai_parse.html_to_text(html) == "Better at photorealism\nBetter at NSFW"


def test_html_to_text_decodes_entities_after_stripping_real_tags():
    # A literal '&lt;script&gt;' the AUTHOR typed must survive as literal
    # text ("<script>"), not be caught by the tag-stripper meant for real
    # tags -- entities decode LAST, after real-tag stripping.
    assert civitai_parse.html_to_text("Use &lt;script&gt; tags &amp; quotes &quot;like this&quot;.") == \
        'Use <script> tags & quotes "like this".'


def test_html_to_text_collapses_excess_blank_lines_and_trims():
    html = "<p>First.</p>\n\n\n<p>Second.</p>   "
    assert civitai_parse.html_to_text(html) == "First.\n\nSecond."


def test_html_to_text_blank_or_non_string_is_empty_string_never_raises():
    assert civitai_parse.html_to_text("") == ""
    assert civitai_parse.html_to_text("   ") == ""
    assert civitai_parse.html_to_text(None) == ""
    assert civitai_parse.html_to_text(123) == ""


def test_parse_model_description_extracts_top_level_field():
    assert civitai_parse.parse_model_description({"id": 1, "description": "Full write-up."}) == "Full write-up."


def test_parse_model_description_converts_html_to_plain_text():
    assert civitai_parse.parse_model_description({"description": "<p>Full write-up.</p>"}) == "Full write-up."


def test_parse_model_description_blank_or_missing_is_none():
    assert civitai_parse.parse_model_description({"description": "   "}) is None
    assert civitai_parse.parse_model_description({}) is None
    assert civitai_parse.parse_model_description(None) is None
    assert civitai_parse.parse_model_description("not-a-dict") is None


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
# civitai_client.lookup_model_by_id -- BUG 2's fallback fetch, same
# transport rules as lookup_by_hash (not re-tested exhaustively -- shared
# implementation shape, just the model-specific bits).
# ---------------------------------------------------------------------------


def test_lookup_model_by_id_success_on_first_host():
    body = json.dumps({"id": 1, "description": "Full write-up."}).encode("utf-8")
    opener, calls = _sequence_opener([lambda: _FakeResponse(body)])
    result = civitai_client.lookup_model_by_id(1, opener=opener)
    assert result["reason"] == "found"
    assert result["data"]["description"] == "Full write-up."
    assert len(calls) == 1
    assert "/api/v1/models/1" in calls[0][0]


def test_lookup_model_by_id_404_is_definitive_and_never_tries_backup_host():
    def raise_404():
        raise urllib.error.HTTPError("url", 404, "Not Found", None, None)

    opener, calls = _sequence_opener([raise_404])
    result = civitai_client.lookup_model_by_id(999999, opener=opener)
    assert result["reason"] == "notfound"
    assert len(calls) == 1


def test_lookup_model_by_id_timeout_is_distinct_reason():
    import socket

    def raise_timeout():
        raise socket.timeout("timed out")

    opener, calls = _sequence_opener([raise_timeout, raise_timeout])
    result = civitai_client.lookup_model_by_id(1, opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "timeout"


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
        previous_by_id = civitai_client.lookup_model_by_id

        def _must_not_be_called(*args, **kwargs):
            raise AssertionError("network lookup must not run when a sidecar is cached")

        # BUG 2's description-fallback augmentation DOES run here (this
        # sidecar has a `modelId` but no `description`) -- offline, so it
        # changes nothing and never marks "checked" (transient-retry rule).
        def _fake_by_id(*args, **kwargs):
            return {"reason": "offline", "offline_reason": "timeout", "message": "", "data": None}

        lookup.civitai_client.lookup_by_hash = _must_not_be_called
        lookup.civitai_client.lookup_model_by_id = _fake_by_id
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["reason"] == "found"
            assert result["source"] == "sidecar"
            assert result["data"]["base_model"] == "SDXL"
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            lookup.civitai_client.lookup_model_by_id = previous_by_id
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
        previous_by_id = civitai_client.lookup_model_by_id
        seen_hashes = []

        def fake_lookup_by_hash(sha, **kwargs):
            seen_hashes.append(sha)
            return {
                "reason": "found", "offline_reason": None, "message": "",
                "data": {"modelId": 7, "id": 8, "baseModel": "Pony"},
            }

        # BUG 2's description-fallback augmentation runs on this "found"
        # result too (no `description` in the fixture, `modelId` present) --
        # offline here so it's a no-op, same reasoning as the sibling test
        # above.
        def _fake_by_id(*args, **kwargs):
            return {"reason": "offline", "offline_reason": "timeout", "message": "", "data": None}

        lookup.civitai_client.lookup_by_hash = fake_lookup_by_hash
        lookup.civitai_client.lookup_model_by_id = _fake_by_id
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
            lookup.civitai_client.lookup_model_by_id = previous_by_id
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


# ---------------------------------------------------------------------------
# BUG 2 -- the model-id description fallback, wired into lookup_model_info.
# §7d-i (owner, 2026-07-30): `model_description`/`version_description` are
# now independent, first-class fields -- these tests exercise that
# independence through the full `lookup_model_info` orchestration, plus the
# per-field "checked" distinction the design doc calls for.
# ---------------------------------------------------------------------------


def test_lookup_model_info_fetches_model_description_fallback_when_missing_and_caches_it():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        # A sidecar with a modelId but NO model description -- the real
        # by-hash shape when the embedded `model` object is `{name, type,
        # nsfw, poi}`.
        sidecar.write_sidecar(model_path, {"modelId": 42, "id": 1, "baseModel": "SDXL", "model": {"name": "X"}})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_by_id = civitai_client.lookup_model_by_id
        seen_ids = []

        def fake_by_id(model_id, **kwargs):
            seen_ids.append(model_id)
            return {"reason": "found", "offline_reason": None, "message": "", "data": {"id": 42, "description": "The real write-up."}}

        lookup.civitai_client.lookup_model_by_id = fake_by_id
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["reason"] == "found"
            assert result["data"]["model_description"] == "The real write-up."
            assert result["data"]["model_description_checked"] is True
            assert seen_ids == [42]

            # Cached into the sidecar -- re-reading it directly shows the
            # description folded into `model`, plus the once-only marker.
            cached = sidecar.read_sidecar(model_path)
            assert cached["model"]["description"] == "The real write-up."
            assert cached["_wtn_model_description_checked"] is True

            # A SECOND call must NOT re-ask -- once-only cost.
            lookup.civitai_client.lookup_model_by_id = _must_not_be_called_again
            result2 = lookup.lookup_model_info("loras", "a.safetensors")
            assert result2["data"]["model_description"] == "The real write-up."
            assert result2["data"]["model_description_checked"] is True
        finally:
            lookup.civitai_client.lookup_model_by_id = previous_by_id
            restore()


# ---------------------------------------------------------------------------
# BUG 11b (2026-07-29 owner report), superseded by §7d-i: a VERSION
# description existing must NOT skip the model-id fallback fetch -- that was
# the actual root cause of author's-notes showing a changelog note ("Trained
# on preview3.") instead of the real write-up. Now that the two fields are
# fully independent there is no shared gate left to regress, but the
# behaviour is still exercised end-to-end.
# ---------------------------------------------------------------------------


def test_lookup_model_info_fetches_fallback_even_when_a_version_description_already_exists():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        # A version-level description IS present (a changelog note, like the
        # owner's real "Trained on preview3." example) -- and, per the real
        # by-hash shape, `model` has no `description` of its own.
        sidecar.write_sidecar(model_path, {
            "modelId": 42, "id": 1, "baseModel": "SDXL",
            "description": "Trained on preview3.",
            "model": {"name": "X", "type": "LORA", "nsfw": False, "poi": False},
        })

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_by_id = civitai_client.lookup_model_by_id
        seen_ids = []

        def fake_by_id(model_id, **kwargs):
            seen_ids.append(model_id)
            return {"reason": "found", "offline_reason": None, "message": "", "data": {"id": 42, "description": "The author's real write-up."}}

        lookup.civitai_client.lookup_model_by_id = fake_by_id
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert seen_ids == [42], "the fallback fetch MUST run even though a version description already exists"
            assert result["data"]["model_description"] == "The author's real write-up."
            assert result["data"]["version_description"] == "Trained on preview3.", "the version's own note is a first-class field, not discarded"
        finally:
            lookup.civitai_client.lookup_model_by_id = previous_by_id
            restore()


def test_lookup_model_info_only_version_description_when_fetch_genuinely_finds_nothing():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {
            "modelId": 42, "id": 1, "baseModel": "SDXL",
            "description": "Trained on preview3.",
            "model": {"name": "X", "type": "LORA", "nsfw": False, "poi": False},
        })

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_by_id = civitai_client.lookup_model_by_id
        seen_ids = []

        # The fetch runs (it must, per the test above) but genuinely finds
        # nothing usable -- a definitive miss, not a transient failure.
        def fake_by_id(model_id, **kwargs):
            seen_ids.append(model_id)
            return {"reason": "found", "offline_reason": None, "message": "", "data": {"id": 42}}  # no description field

        lookup.civitai_client.lookup_model_by_id = fake_by_id
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert seen_ids == [42], "only a version description present must still attempt the model-id fetch"
            assert "model_description" not in result["data"], "genuinely absent -- not empty, not a stand-in for the version note"
            assert result["data"]["version_description"] == "Trained on preview3."
            # A definitive (if empty) answer -- checked, not merely unasked.
            assert result["data"]["model_description_checked"] is True
        finally:
            lookup.civitai_client.lookup_model_by_id = previous_by_id
            restore()


def test_lookup_model_info_only_model_description_leaves_version_description_absent():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        # No version-level `description` at all -- only the model's own.
        sidecar.write_sidecar(model_path, {
            "modelId": 42, "id": 1, "baseModel": "SDXL",
            "model": {"name": "X", "description": "The author's real write-up."},
        })

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["data"]["model_description"] == "The author's real write-up."
            assert "version_description" not in result["data"]
            assert result["data"]["model_description_checked"] is True
        finally:
            restore()


def test_lookup_model_info_neither_description_is_distinguishable_from_not_yet_checked():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {"modelId": 42, "id": 1, "baseModel": "SDXL"})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_by_id = civitai_client.lookup_model_by_id
        try:
            # A transient failure -- Civitai never gave a definitive answer,
            # so this is "not yet checked", not "confirmed absent".
            lookup.civitai_client.lookup_model_by_id = lambda model_id, **kw: {
                "reason": "offline", "offline_reason": "timeout", "message": "", "data": None,
            }
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert "model_description" not in result["data"]
            assert "version_description" not in result["data"]
            assert result["data"]["model_description_checked"] is False, "a transient failure must read as unchecked, not confirmed-absent"

            # Now Civitai gives a DEFINITIVE (if empty) answer -- confirmed
            # absent, distinguishable from the unchecked state above.
            lookup.civitai_client.lookup_model_by_id = lambda model_id, **kw: {
                "reason": "found", "offline_reason": None, "message": "", "data": {"id": 42},
            }
            result2 = lookup.lookup_model_info("loras", "a.safetensors")
            assert "model_description" not in result2["data"]
            assert result2["data"]["model_description_checked"] is True, "a definitive miss must read as checked, not unchecked forever"
        finally:
            lookup.civitai_client.lookup_model_by_id = previous_by_id
            restore()


def test_lookup_model_info_version_description_present_with_no_model_id_at_all():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        # No modelId at all -- there is no fallback fetch to ever run, so
        # `model_description_checked` is True (nothing further to learn),
        # even though `model_description` itself is absent.
        sidecar.write_sidecar(model_path, {"id": 1, "baseModel": "SDXL", "description": "Trained on preview3."})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["data"]["version_description"] == "Trained on preview3."
            assert "model_description" not in result["data"]
            assert result["data"]["model_description_checked"] is True
        finally:
            restore()


def test_lookup_model_info_description_fallback_skipped_when_cached_only():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {"modelId": 42, "id": 1, "baseModel": "SDXL"})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_by_id = civitai_client.lookup_model_by_id

        def _must_not_run(*args, **kwargs):
            raise AssertionError("cached_only must never reach the model-id fallback fetch either")

        lookup.civitai_client.lookup_model_by_id = _must_not_run
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors", cached_only=True)
            assert result["reason"] == "found"
            assert "model_description" not in result["data"]
            assert result["data"]["model_description_checked"] is False, "cached_only never asks, so this must read as unchecked"
        finally:
            lookup.civitai_client.lookup_model_by_id = previous_by_id
            restore()


def test_lookup_model_info_description_fallback_transient_offline_does_not_mark_checked():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {"modelId": 42, "id": 1, "baseModel": "SDXL"})

        restore = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]},
            names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_by_id = civitai_client.lookup_model_by_id
        calls = []

        def fake_by_id(model_id, **kwargs):
            calls.append(model_id)
            return {"reason": "offline", "offline_reason": "timeout", "message": "", "data": None}

        lookup.civitai_client.lookup_model_by_id = fake_by_id
        try:
            lookup.lookup_model_info("loras", "a.safetensors")
            lookup.lookup_model_info("loras", "a.safetensors")
            assert len(calls) == 2, "a transient offline failure must NOT set the once-only marker -- retry on the next open"
            cached = sidecar.read_sidecar(model_path)
            assert "_wtn_model_description_checked" not in cached
        finally:
            lookup.civitai_client.lookup_model_by_id = previous_by_id
            restore()


def test_lookup_model_info_sidecar_round_trip_preserves_both_descriptions():
    # §7d-i: "both cached in the sidecar, so a second open costs nothing and
    # neither triggers a refetch" -- exercised through the full
    # `lookup_model_info` orchestration (a raw civitai "found" response ->
    # sidecar write -> a fresh, cache-only-style re-read with the model-id
    # fetch made to blow up if it's ever reached again).
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
        previous_by_id = civitai_client.lookup_model_by_id

        def fake_lookup_by_hash(sha, **kwargs):
            return {
                "reason": "found", "offline_reason": None, "message": "",
                "data": {
                    "modelId": 7, "id": 8, "baseModel": "Pony",
                    "description": "Trained on preview3.",
                    "model": {"name": "X", "type": "LORA", "nsfw": False, "poi": False},
                },
            }

        def fake_by_id(model_id, **kwargs):
            return {"reason": "found", "offline_reason": None, "message": "", "data": {"id": model_id, "description": "The author's real write-up."}}

        lookup.civitai_client.lookup_by_hash = fake_lookup_by_hash
        lookup.civitai_client.lookup_model_by_id = fake_by_id
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["source"] == "civitai"
            assert result["data"]["model_description"] == "The author's real write-up."
            assert result["data"]["version_description"] == "Trained on preview3."

            # Second open: must come straight from the sidecar, no fetch of
            # either kind reached again, and BOTH fields survive intact.
            lookup.civitai_client.lookup_by_hash = _must_not_be_called_again
            lookup.civitai_client.lookup_model_by_id = _must_not_be_called_again
            result2 = lookup.lookup_model_info("loras", "a.safetensors")
            assert result2["source"] == "sidecar"
            assert result2["data"]["model_description"] == "The author's real write-up."
            assert result2["data"]["version_description"] == "Trained on preview3."
            assert result2["data"]["model_description_checked"] is True
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            lookup.civitai_client.lookup_model_by_id = previous_by_id
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


# ---------------------------------------------------------------------------
# M2 -- civitai_search.py: request-building + response-parsing, pure/offline.
# ---------------------------------------------------------------------------


def test_type_for_kind_known_and_unknown():
    assert civitai_search.type_for_kind("loras") == "LORA"
    assert civitai_search.type_for_kind("checkpoints") == "Checkpoint"
    assert civitai_search.type_for_kind("unet") == "Checkpoint"
    for bad in ("../../etc", "", None, 42, "LORAS"):
        assert civitai_search.type_for_kind(bad) is None, bad


def test_build_search_url_shape_and_params():
    url = civitai_search.build_search_url(
        "civitai.com", "loras", "skin detail",
        base_model="SDXL", sort="Most Downloaded", period="Month", nsfw=True, cursor="abc", limit=5,
    )
    assert url.startswith("https://civitai.com/api/v1/models?")
    assert "types=LORA" in url
    assert "sort=Most+Downloaded" in url
    assert "period=Month" in url
    assert "limit=5" in url
    assert "nsfw=true" in url
    assert "query=skin+detail" in url
    assert "baseModels=SDXL" in url
    assert "cursor=abc" in url


def test_build_search_url_rejects_unwhitelisted_kind():
    assert civitai_search.build_search_url("civitai.com", "../../etc", "x") is None
    assert civitai_search.build_search_url("civitai.com", "not-a-kind", "x") is None


def test_build_search_url_garbage_sort_and_period_fall_back_to_defaults():
    url = civitai_search.build_search_url("civitai.com", "loras", "x", sort="bogus", period="bogus")
    assert f"sort={urllib.parse.quote_plus(civitai_search.DEFAULT_SORT)}" in url
    assert f"period={civitai_search.DEFAULT_PERIOD}" in url


def test_build_search_url_limit_is_clamped():
    url = civitai_search.build_search_url("civitai.com", "loras", "x", limit=999)
    assert f"limit={civitai_search._MAX_LIMIT}" in url
    url_low = civitai_search.build_search_url("civitai.com", "loras", "x", limit=0)
    assert "limit=1" in url_low


def test_search_models_rejects_unwhitelisted_kind_without_any_network():
    result = civitai_search.search_models("../../etc", "x", opener=lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not reach the network")))
    assert result["reason"] == "invalid_kind"


def test_search_models_success_and_api_key_rides_as_token_param():
    body = json.dumps({"items": [], "metadata": {}}).encode("utf-8")
    seen_urls = []

    def opener(url, timeout):
        seen_urls.append(url)
        return _FakeResponse(body)

    result = civitai_search.search_models("loras", "skin", api_key="secret-key-123", opener=opener)
    assert result["reason"] == "found"
    assert len(seen_urls) == 1
    assert "token=secret-key-123" in seen_urls[0]


def test_search_models_no_api_key_omits_token_param():
    body = json.dumps({"items": []}).encode("utf-8")
    seen_urls = []

    def opener(url, timeout):
        seen_urls.append(url)
        return _FakeResponse(body)

    civitai_search.search_models("loras", "skin", api_key=None, opener=opener)
    assert "token=" not in seen_urls[0]


def test_search_models_404_folds_into_offline_unknown_not_notfound():
    def raise_404():
        raise urllib.error.HTTPError("url", 404, "Not Found", None, None)

    opener, calls = _sequence_opener([raise_404])
    result = civitai_search.search_models("loras", "x", opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "unknown"
    assert len(calls) == 1  # still definitive -- no backup-host retry


def test_search_models_timeout_is_distinct_reason():
    import socket as _socket

    def raise_timeout():
        raise _socket.timeout("timed out")

    opener, calls = _sequence_opener([raise_timeout, raise_timeout])
    result = civitai_search.search_models("loras", "x", opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "timeout"


def test_parse_search_response_typical_multi_item_shape():
    raw = {
        "items": [
            {
                "id": 1,
                "name": "Skin Detail XL",
                "type": "LORA",
                "nsfw": False,
                "tags": ["realism", {"name": "skin"}],
                "creator": {"username": "someartist"},
                "stats": {"downloadCount": 12400, "favoriteCount": 890, "rating": 4.8},
                "modelVersions": [
                    {
                        "id": 10, "modelId": 1, "name": "v1.0", "baseModel": "SDXL",
                        "publishedAt": "2026-01-01T00:00:00Z",
                        "files": [
                            {"name": "skin_detail_xl.safetensors", "sizeKB": 144000.0,
                             "downloadUrl": "https://civitai.com/api/download/models/10",
                             "primary": True, "hashes": {"SHA256": "deadbeef"}},
                        ],
                    },
                ],
            },
            "not-a-dict-item",
            {"id": 2},  # no modelVersions at all -- must be dropped
        ],
        "metadata": {"nextCursor": "xyz"},
    }
    parsed = civitai_search.parse_search_response(raw)
    assert parsed["next_cursor"] == "xyz"
    assert len(parsed["results"]) == 1  # the other two items are dropped
    result = parsed["results"][0]
    assert result["model_id"] == 1
    assert result["name"] == "Skin Detail XL"
    assert result["tags"] == ["realism", "skin"]
    assert result["creator"] == "someartist"
    assert result["stats"] == {"downloads": 12400, "favorites": 890, "rating": 4.8}
    version = result["versions"][0]
    assert version["version_id"] == 10
    assert version["base_model"] == "SDXL"
    assert version["gated"] is False
    file = version["files"][0]
    assert file["name"] == "skin_detail_xl.safetensors"
    assert file["download_url"] == "https://civitai.com/api/download/models/10"
    assert file["sha256"] == "deadbeef"
    assert file["primary"] is True
    assert file["gated"] is False  # copied down from the version


def test_parse_search_response_early_access_marks_version_and_files_gated():
    raw = {
        "items": [{
            "id": 5,
            "modelVersions": [{
                "id": 50, "baseModel": "SDXL", "earlyAccessEndsAt": "2099-01-01T00:00:00Z",
                "files": [{"name": "gated.safetensors", "downloadUrl": "https://civitai.com/x", "primary": True}],
            }],
        }],
    }
    result = civitai_search.parse_search_response(raw)["results"][0]
    assert result["versions"][0]["gated"] is True
    assert result["versions"][0]["files"][0]["gated"] is True


def test_parse_search_response_files_missing_name_or_url_are_dropped():
    raw = {
        "items": [{
            "id": 5,
            "modelVersions": [{
                "id": 50, "baseModel": "SDXL",
                "files": [
                    {"name": "", "downloadUrl": "https://civitai.com/x"},
                    {"name": "ok.safetensors", "downloadUrl": ""},
                    {"downloadUrl": "https://civitai.com/x"},
                    {"name": "good.safetensors", "downloadUrl": "https://civitai.com/good"},
                ],
            }],
        }],
    }
    files = civitai_search.parse_search_response(raw)["results"][0]["versions"][0]["files"]
    assert [f["name"] for f in files] == ["good.safetensors"]


def test_parse_search_response_malformed_shapes_never_raise():
    assert civitai_search.parse_search_response(None) == {"results": [], "next_cursor": None}
    assert civitai_search.parse_search_response("not-a-dict") == {"results": [], "next_cursor": None}
    assert civitai_search.parse_search_response({}) == {"results": [], "next_cursor": None}
    assert civitai_search.parse_search_response({"items": "not-a-list"}) == {"results": [], "next_cursor": None}


def test_pick_primary_file_prefers_primary_flag_then_falls_back_to_first():
    files = [{"name": "a", "primary": False}, {"name": "b", "primary": True}, {"name": "c", "primary": False}]
    assert civitai_search.pick_primary_file(files)["name"] == "b"
    files_no_primary = [{"name": "x"}, {"name": "y"}]
    assert civitai_search.pick_primary_file(files_no_primary)["name"] == "x"
    assert civitai_search.pick_primary_file([]) is None
    assert civitai_search.pick_primary_file("not-a-list") is None


# ---------------------------------------------------------------------------
# M2 -- download.py: sanitisation, destination resolution, the streamed
# downloader, and the serial DownloadManager.
# ---------------------------------------------------------------------------


def test_sanitize_filename_accepts_normal_names():
    assert download.sanitize_filename("my_lora.safetensors") == "my_lora.safetensors"
    assert download.sanitize_filename("  spaced.ckpt  ") == "spaced.ckpt"
    assert download.sanitize_filename("weights.pt") == "weights.pt"
    assert download.sanitize_filename("weights.bin") == "weights.bin"


def test_sanitize_filename_rejects_hostile_values():
    for bad in (
        "../evil.safetensors", "a/b.safetensors", "a\\b.safetensors",
        "..\\..\\evil.safetensors", "/etc/passwd.safetensors", ".hidden.safetensors",
        "no-extension", "wrong.exe", "", "   ", None, 42, ["x.safetensors"],
        "..", "a..b.safetensors",  # ".." anywhere, even mid-string, is rejected
    ):
        assert download.sanitize_filename(bad) is None, bad


def test_sanitize_filename_rejects_an_embedded_nul_byte():
    # 🔒 2026-07-30 fix: an embedded NUL used to sail through every other
    # check here and reach `os.path.realpath` downstream, which raises
    # `ValueError: embedded null character` -- uncaught, that broke
    # `api.py`'s "every route answers 200 with a reason" contract.
    assert download.sanitize_filename("mo\x00del.safetensors") is None
    assert download.sanitize_filename("\x00.safetensors") is None
    assert download.sanitize_filename("model.safetensors\x00") is None


def test_validate_subfolder_accepts_normal_values():
    assert download.validate_subfolder(None) == ""
    assert download.validate_subfolder("") == ""
    assert download.validate_subfolder("detail") == "detail"
    assert download.validate_subfolder("detail/") == "detail"  # trailing slash tolerated
    assert download.validate_subfolder("detail/character") == "detail/character"


def test_validate_subfolder_rejects_hostile_values():
    for bad in (
        "..", "../secret", "detail/../secret", "detail//x", "/etc/passwd",
        "C:\\Windows", "detail\\x", 42, ["detail"],
    ):
        assert download.validate_subfolder(bad) is None, bad


def test_validate_subfolder_rejects_an_embedded_nul_byte():
    assert download.validate_subfolder("de\x00tail") is None
    assert download.validate_subfolder("\x00") is None


def test_resolve_destination_path_rejects_a_nul_byte_in_filename_or_subfolder_without_raising():
    # End-to-end: a NUL byte in EITHER input must degrade to `None`, never
    # raise -- covers the actual crash path the security review found
    # (`local._is_path_under`'s `os.path.realpath`), reached via
    # `resolve_destination_path` when a caller's own sanitisation somehow
    # let a NUL through.
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.resolve_destination_path("loras", "", "mo\x00del.safetensors") is None
            assert download.resolve_destination_path("loras", "de\x00tail", "a.safetensors") is None
        finally:
            restore()


def test_local_is_path_under_never_raises_on_an_embedded_nul_byte():
    # 🔒 2026-07-30 fix: `os.path.realpath` raises `ValueError: embedded
    # null character` for a NUL-containing path -- that call used to sit
    # OUTSIDE this function's own try/except. Both the `path` and each
    # `root` are exercised here.
    with tempfile.TemporaryDirectory() as tmp:
        assert local._is_path_under("mo\x00del.safetensors", tmp) is False
        assert local._is_path_under(os.path.join(tmp, "a.safetensors"), "ro\x00ot") is False


def test_resolve_destination_path_rejects_unwhitelisted_kind_without_folder_paths():
    assert download.resolve_destination_path("../../etc", "", "a.safetensors") is None
    assert download.resolve_destination_path("not-a-kind", "", "a.safetensors") is None


def test_resolve_destination_path_happy_path_and_subfolder():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            path = download.resolve_destination_path("loras", "", "a.safetensors")
            assert path == os.path.join(loras_root, "a.safetensors")

            sub_path = download.resolve_destination_path("loras", "detail", "b.safetensors")
            assert sub_path == os.path.join(loras_root, "detail", "b.safetensors")
        finally:
            restore()


def test_resolve_destination_path_rejects_hostile_filename_or_subfolder():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.resolve_destination_path("loras", "", "../escape.safetensors") is None
            assert download.resolve_destination_path("loras", "../escape", "a.safetensors") is None
            assert download.resolve_destination_path("loras", "", "/etc/passwd.safetensors") is None
        finally:
            restore()


def test_resolve_destination_path_subfolder_that_escapes_root_via_realpath_is_rejected():
    # A subfolder that PASSES the cheap `validate_subfolder` check (no `..`
    # segment) but whose REAL location (via a symlink) escapes the
    # configured root must still be refused -- the actual guarantee lives in
    # `local._is_path_under`'s realpath check, not the syntax pass.
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        outside = os.path.join(tmp, "outside")
        os.makedirs(loras_root)
        os.makedirs(outside)
        try:
            os.symlink(outside, os.path.join(loras_root, "escape_link"))
        except (OSError, NotImplementedError):
            return  # symlinks unavailable on this platform -- skip gracefully
        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.resolve_destination_path("loras", "escape_link", "a.safetensors") is None
        finally:
            restore()


def test_destination_exists_true_only_when_the_real_file_is_present():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.destination_exists("loras", "", "present.safetensors") is False
            open(os.path.join(loras_root, "present.safetensors"), "wb").close()
            assert download.destination_exists("loras", "", "present.safetensors") is True
            # A `.part` sibling must NEVER count -- this is the guarantee
            # decision 2 depends on.
            open(os.path.join(loras_root, "partial.safetensors.part"), "wb").close()
            assert download.destination_exists("loras", "", "partial.safetensors") is False
        finally:
            restore()


def test_is_allowed_download_url():
    assert download.is_allowed_download_url("https://civitai.com/api/download/models/1") is True
    assert download.is_allowed_download_url("https://civitai.red/api/download/models/1") is True
    assert download.is_allowed_download_url("http://civitai.com/api/download/models/1") is False  # not https
    assert download.is_allowed_download_url("https://evil.example.com/x") is False  # not a Civitai host
    assert download.is_allowed_download_url("ftp://civitai.com/x") is False
    assert download.is_allowed_download_url(None) is False
    assert download.is_allowed_download_url(42) is False


def _fake_resolver_returning(*ips):
    """An injectable `resolver(hostname, port)` (`_is_safe_redirect`'s own
    `resolver=` seam) that returns fixed addresses -- used so a test never
    depends on real, external DNS being reachable."""
    def resolver(host, port):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0)) for ip in ips]
    return resolver


def _fake_resolver_raising(exc):
    def resolver(host, port):
        raise exc
    return resolver


def test_is_safe_redirect_https_and_not_private():
    # A "real" third-party CDN host -- resolved via an INJECTED resolver
    # (`resolver=`) rather than real DNS, so this doesn't depend on network
    # access in a test environment. Public IP borrowed from `example.com`.
    assert download._is_safe_redirect(
        "https://cdn.example-storage.com/file.bin", resolver=_fake_resolver_returning("93.184.216.34"),
    ) is True
    assert download._is_safe_redirect("http://cdn.example-storage.com/file.bin") is False  # scheme downgrade -- rejected before resolution
    assert download._is_safe_redirect("https://localhost/file.bin") is False
    assert download._is_safe_redirect("not a url at all::::") is False

    # These are IP LITERALS -- `getaddrinfo` resolves a literal locally, no
    # network needed, so the REAL resolver (not injected) is used here,
    # same as the actual (unmocked) code path.
    assert download._is_safe_redirect("https://127.0.0.1/file.bin") is False
    assert download._is_safe_redirect("https://10.0.0.5/file.bin") is False  # private range
    assert download._is_safe_redirect("https://169.254.1.1/file.bin") is False  # link-local
    assert download._is_safe_redirect("https://224.0.0.1/file.bin") is False  # multicast
    assert download._is_safe_redirect("https://0.0.0.0/file.bin") is False  # unspecified


def test_is_safe_redirect_dns_name_resolving_to_a_private_address_is_rejected():
    # A hostname that LOOKS fine but resolves internally -- exactly the case
    # a syntax-only check on the hostname string could never catch at all.
    assert download._is_safe_redirect(
        "https://internal.example.com/steal", resolver=_fake_resolver_returning("10.0.0.5"),
    ) is False


def test_is_safe_redirect_one_safe_address_among_several_unsafe_ones_is_still_rejected():
    # Multiple A records, ONE of which is unsafe -- every returned address
    # must be checked, not just the first.
    assert download._is_safe_redirect(
        "https://multi.example.com/x", resolver=_fake_resolver_returning("93.184.216.34", "127.0.0.1"),
    ) is False


def test_is_safe_redirect_resolution_failure_is_rejected_not_defaulted_to_allow():
    assert download._is_safe_redirect(
        "https://does-not-resolve.example.invalid/x",
        resolver=_fake_resolver_raising(socket.gaierror("nodename nor servname provided")),
    ) is False
    assert download._is_safe_redirect(
        "https://empty-result.example.com/x", resolver=lambda host, port: [],
    ) is False


# ---------------------------------------------------------------------------
# 🔒 2026-07-30 SECURITY FIX -- confirmed SSRF bypass: `_is_safe_redirect`
# used to parse the hostname STRING with `ipaddress.ip_address` and treat a
# `ValueError` (any non-dotted-quad/IPv6-literal syntax) as "must be a real
# hostname, therefore allowed" -- but decimal/hex/bare-integer IPv4
# encodings are ALL real addresses the platform resolver (and hence
# `urllib`'s own eventual connection) parses identically to the dotted-quad
# form. These are LOCAL address-parsing behaviours (no DNS query), so the
# REAL resolver is used here -- exactly reproducing the measured bypass and
# proving the fix (resolve, don't pattern-match) actually closes it.
# ---------------------------------------------------------------------------


def test_is_safe_redirect_decimal_ipv4_encoding_of_loopback_is_rejected():
    assert socket.getaddrinfo("2130706433", None)[0][4][0] == "127.0.0.1"  # sanity: this platform's resolver DOES parse it
    assert download._is_safe_redirect("https://2130706433/steal") is False


def test_is_safe_redirect_decimal_ipv4_encoding_of_cloud_metadata_is_rejected():
    # 169.254.169.254 -- the AWS/GCP/Azure metadata endpoint; squarely in
    # scope since the owner runs on Colab.
    assert socket.getaddrinfo("2852039166", None)[0][4][0] == "169.254.169.254"  # sanity
    assert download._is_safe_redirect("https://2852039166/steal") is False


def test_is_safe_redirect_hex_ipv4_encoding_of_loopback_is_rejected():
    assert socket.getaddrinfo("0x7f.0.0.1", None)[0][4][0] == "127.0.0.1"  # sanity
    assert download._is_safe_redirect("https://0x7f.0.0.1/steal") is False


def test_is_safe_redirect_bare_integer_zero_is_rejected():
    assert socket.getaddrinfo("0", None)[0][4][0] == "0.0.0.0"  # sanity
    assert download._is_safe_redirect("https://0/steal") is False


def test_safe_redirect_handler_refuses_hostile_hops_through_the_actual_wiring():
    # Drives the fix through `_SafeRedirectHandler.redirect_request` itself
    # -- the real object `urllib`'s opener calls on every redirect -- not
    # just the pure `_is_safe_redirect` predicate. `fp` is unused by the
    # modern stdlib implementation for a non-error return, so `None` is fine.
    handler = download._SafeRedirectHandler()
    req = urllib.request.Request("https://civitai.com/api/download/models/1")

    safe = handler.redirect_request(req, None, 302, "Found", {}, "https://civitai.com/cdn-redirect")
    assert isinstance(safe, urllib.request.Request)
    assert safe.full_url == "https://civitai.com/cdn-redirect"

    for hostile_url in (
        "https://127.0.0.1/steal",
        "https://2130706433/steal",              # decimal loopback
        "https://2852039166/steal",               # decimal cloud metadata
        "https://0x7f.0.0.1/steal",                # hex loopback
        "https://0/steal",                         # bare integer -> 0.0.0.0
        "http://civitai.com/scheme-downgrade",     # https -> http mid-chain
    ):
        assert handler.redirect_request(req, None, 302, "Found", {}, hostile_url) is None, hostile_url


def test_safe_redirect_handler_chain_of_good_hops_then_a_bad_one():
    # A realistic multi-hop redirect chain (Civitai -> its own edge -> a CDN
    # -> ... ) that stays safe for N hops and then turns hostile -- each hop
    # is a SEPARATE `redirect_request` call, exactly how `urllib`'s opener
    # drives a real chain one redirect at a time.
    handler = download._SafeRedirectHandler()
    req = urllib.request.Request("https://civitai.com/api/download/models/1")
    chain = [
        "https://civitai.com/edge/1",
        "https://civitai.com/edge/2",
        "https://civitai.com/edge/3",
        "https://127.0.0.1/final-hop-is-hostile",
    ]
    results = [handler.redirect_request(req, None, 302, "Found", {}, hop) for hop in chain]
    assert [r is not None for r in results] == [True, True, True, False]


class _FakeDownloadResponse:
    """Same shape as `_FakeResponse` above, plus a `.headers` dict --
    `download.stream_download` reads `Content-Length` off it."""

    def __init__(self, body: bytes, *, headers=None):
        self._body = body
        self.headers = headers or {}

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


def test_stream_download_success_writes_dest_and_removes_part():
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "sub", "a.safetensors")
        payload = b"x" * (3 * 1024 * 1024 + 7)  # not a clean multiple of the chunk size
        progress_calls = []

        def opener(url, timeout):
            return _FakeDownloadResponse(payload, headers={"Content-Length": str(len(payload))})

        result = download.stream_download(
            "https://civitai.com/api/download/models/1", dest,
            opener=opener, chunk_size=1024 * 1024,
            progress_cb=lambda written, total: progress_calls.append((written, total)),
        )
        assert result["reason"] == "ok"
        assert result["bytes_written"] == len(payload)
        assert os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")
        with open(dest, "rb") as fh:
            assert fh.read() == payload
        assert progress_calls  # progress_cb was actually driven
        assert progress_calls[-1][0] == len(payload)
        assert progress_calls[-1][1] == len(payload)  # total came from Content-Length


def test_stream_download_rejects_non_https_url_without_calling_opener():
    def _must_not_be_called(*args, **kwargs):
        raise AssertionError("a non-HTTPS url must never reach the opener")

    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.safetensors")
        result = download.stream_download("http://civitai.com/x", dest, opener=_must_not_be_called)
        assert result["reason"] == "offline"
        assert result["offline_reason"] == "invalid_url"
        assert not os.path.isfile(dest)


def test_stream_download_cancellation_leaves_no_part_and_never_registers_installed():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        dest = os.path.join(loras_root, "cancelled.safetensors")

        def opener(url, timeout):
            return _FakeDownloadResponse(b"x" * (5 * 1024 * 1024))

        cancel_after_first_chunk = {"calls": 0}

        def should_cancel():
            cancel_after_first_chunk["calls"] += 1
            return cancel_after_first_chunk["calls"] > 1  # allow one read through, then cancel

        result = download.stream_download(
            "https://civitai.com/x", dest, opener=opener, chunk_size=1024 * 1024, should_cancel=should_cancel,
        )
        assert result["reason"] == "cancelled"
        assert not os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")

        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.destination_exists("loras", "", "cancelled.safetensors") is False
        finally:
            restore()


def test_stream_download_too_large_cleans_up_and_never_registers_installed():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        dest = os.path.join(loras_root, "huge.safetensors")

        def opener(url, timeout):
            return _FakeDownloadResponse(b"x" * (5 * 1024 * 1024))

        result = download.stream_download("https://civitai.com/x", dest, opener=opener, max_size_bytes=1024, chunk_size=4096)
        assert result["reason"] == "too_large"
        assert not os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")

        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.destination_exists("loras", "", "huge.safetensors") is False
        finally:
            restore()


def test_stream_download_401_is_key_required_not_a_generic_offline_reason():
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "gated.safetensors")

        def opener(url, timeout):
            raise urllib.error.HTTPError("url", 401, "Unauthorized", None, None)

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "key_required"
        assert not os.path.isfile(dest)


def test_stream_download_403_is_also_key_required():
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "gated.safetensors")

        def opener(url, timeout):
            raise urllib.error.HTTPError("url", 403, "Forbidden", None, None)

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "key_required"


def test_stream_download_404_is_offline_notfound():
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "missing.safetensors")

        def opener(url, timeout):
            raise urllib.error.HTTPError("url", 404, "Not Found", None, None)

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "offline"
        assert result["offline_reason"] == "notfound"


def test_stream_download_interrupted_mid_stream_leaves_nothing_the_presence_check_counts():
    # THE explicit regression this task's correction asked for: a download
    # that writes SOME bytes and then fails mid-transfer must leave the
    # destination in a state where `destination_exists` reports False --
    # never a truncated file mistaken for "installed".
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        dest = os.path.join(loras_root, "interrupted.safetensors")

        class _FlakyResponse:
            def __init__(self):
                self.headers = {}
                self._reads = 0

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self, n=-1):
                self._reads += 1
                if self._reads == 1:
                    return b"partial-bytes-that-never-complete"
                raise urllib.error.URLError(OSError("connection reset"))

        def opener(url, timeout):
            return _FlakyResponse()

        result = download.stream_download("https://civitai.com/x", dest, opener=opener, chunk_size=8)
        assert result["reason"] == "offline"
        assert not os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")

        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.destination_exists("loras", "", "interrupted.safetensors") is False
        finally:
            restore()


def test_download_manager_start_progress_and_completion():
    def fake_stream(url, dest_path, *, max_size_bytes, timeout, progress_cb, should_cancel):
        progress_cb(50, 100)
        progress_cb(100, 100)
        return {"reason": "ok", "message": "", "bytes_written": 100}

    manager = download.DownloadManager(stream_fn=fake_stream)
    result = manager.start("job-1", "https://civitai.com/x", "/tmp/does-not-matter.safetensors")
    assert result == {"reason": "started", "job_id": "job-1"}

    # `start` launches a background thread -- give it a moment to finish
    # (the fake stream_fn returns immediately, no real I/O) before asserting
    # on the manager's own state.
    for _ in range(200):
        progress = manager.progress("job-1")
        if progress["status"] not in ("downloading",):
            break
        time.sleep(0.005)
    assert progress["reason"] == "ok"
    assert progress["status"] == "ok"
    assert progress["bytes"] == 100
    assert progress["total"] == 100


def test_download_manager_unknown_job_id():
    manager = download.DownloadManager(stream_fn=lambda *a, **k: {"reason": "ok", "bytes_written": 0})
    assert manager.progress("no-such-job")["reason"] == "unknown_job"
    assert manager.cancel("no-such-job")["reason"] == "unknown_job"


def test_download_manager_busy_while_a_download_is_in_flight():
    started_event = threading.Event()
    release_event = threading.Event()

    def fake_stream(url, dest_path, *, max_size_bytes, timeout, progress_cb, should_cancel):
        started_event.set()
        release_event.wait(timeout=5)
        return {"reason": "ok", "bytes_written": 0}

    manager = download.DownloadManager(stream_fn=fake_stream)
    first = manager.start("job-a", "https://civitai.com/a", "/tmp/a.safetensors")
    assert first["reason"] == "started"
    assert started_event.wait(timeout=5), "the background thread never started"

    second = manager.start("job-b", "https://civitai.com/b", "/tmp/b.safetensors")
    assert second == {"reason": "busy", "message": "Another download is already in progress.", "job_id": None}

    release_event.set()  # let the first job finish so the thread doesn't leak past this test


def test_download_manager_cancel_signals_should_cancel_and_reaches_cancelled_status():
    cancel_seen = threading.Event()

    def fake_stream(url, dest_path, *, max_size_bytes, timeout, progress_cb, should_cancel):
        for _ in range(200):
            if should_cancel():
                cancel_seen.set()
                return {"reason": "cancelled", "message": "Download cancelled.", "bytes_written": 0}
            time.sleep(0.005)
        return {"reason": "ok", "bytes_written": 0}

    manager = download.DownloadManager(stream_fn=fake_stream)
    manager.start("job-c", "https://civitai.com/c", "/tmp/c.safetensors")
    cancel_result = manager.cancel("job-c")
    assert cancel_result["reason"] == "cancelling"
    assert cancel_seen.wait(timeout=5)

    for _ in range(200):
        progress = manager.progress("job-c")
        if progress["status"] != "downloading":
            break
        time.sleep(0.005)
    assert progress["status"] == "cancelled"


# ---------------------------------------------------------------------------
# M2 -- keys.py: the §8 resolution ladder.
# ---------------------------------------------------------------------------


def test_resolve_api_key_setting_wins_over_env():
    previous = keys.get_setting
    keys.get_setting = lambda setting_id, default=None: "setting-key" if setting_id == keys.SETTING_ID else default
    try:
        resolved = keys.resolve_api_key(env={"CIVITAI_API_KEY": "env-key"})
        assert resolved.api_key == "setting-key"
        assert resolved.source == "setting"
        assert resolved.public_only is False
    finally:
        keys.get_setting = previous


def test_resolve_api_key_falls_back_to_env_when_no_setting():
    previous = keys.get_setting
    keys.get_setting = lambda setting_id, default=None: default  # nothing set
    try:
        resolved = keys.resolve_api_key(env={"CIVITAI_API_KEY": "env-key"})
        assert resolved.api_key == "env-key"
        assert resolved.source == "env"
        assert resolved.public_only is False
    finally:
        keys.get_setting = previous


def test_resolve_api_key_public_only_when_neither_is_set():
    previous = keys.get_setting
    keys.get_setting = lambda setting_id, default=None: default
    try:
        resolved = keys.resolve_api_key(env={})
        assert resolved.api_key is None
        assert resolved.source == "none"
        assert resolved.public_only is True
    finally:
        keys.get_setting = previous


def test_resolve_api_key_blank_values_are_treated_as_unset():
    previous = keys.get_setting
    keys.get_setting = lambda setting_id, default=None: "   "
    try:
        resolved = keys.resolve_api_key(env={"CIVITAI_API_KEY": "   "})
        assert resolved.api_key is None
        assert resolved.source == "none"
    finally:
        keys.get_setting = previous


# ---------------------------------------------------------------------------
# M2 -- rate_limit.py.
# ---------------------------------------------------------------------------


def test_min_interval_limiter_allows_then_refuses_then_allows_again():
    clock = {"t": 0.0}
    limiter = rate_limit.MinIntervalLimiter(1.5, clock=lambda: clock["t"])
    assert limiter.allow() is True
    assert limiter.allow() is False  # same instant -- too soon
    clock["t"] += 1.0
    assert limiter.allow() is False  # still under 1.5s
    clock["t"] += 0.6
    assert limiter.allow() is True  # 1.6s since the last ALLOWED call


def test_min_interval_limiter_seconds_until_allowed():
    clock = {"t": 0.0}
    limiter = rate_limit.MinIntervalLimiter(2.0, clock=lambda: clock["t"])
    assert limiter.seconds_until_allowed() == 0.0  # never called yet
    limiter.allow()
    clock["t"] += 0.5
    assert limiter.seconds_until_allowed() == 1.5


# ---------------------------------------------------------------------------
# M2 -- api.py: search_impl / download_start_impl / download_progress_impl /
# download_cancel_impl.
# ---------------------------------------------------------------------------


def _install_permissive_search_limiter():
    """Swaps in an always-allow rate limiter for a `search_impl` test that
    isn't itself testing rate-limiting -- avoids cross-test bleed from the
    real, shared `_SEARCH_LIMITER` singleton (tests run fast enough back-to-
    back that its real 1.5s interval would otherwise flakily reject a LATER
    test's first call)."""
    previous = mb_api._SEARCH_LIMITER
    mb_api._SEARCH_LIMITER = rate_limit.MinIntervalLimiter(0.0)
    return lambda: setattr(mb_api, "_SEARCH_LIMITER", previous)


def test_search_impl_rejects_unwhitelisted_kind_without_any_network():
    restore = _install_permissive_search_limiter()
    try:
        result = mb_api.search_impl({"kind": "../../etc", "query": "x"})
        assert result["reason"] == "invalid_kind"
        assert result["results"] == []
        assert result["public_only"] is True
    finally:
        restore()


def test_search_impl_happy_path_annotates_installed_and_gated_and_reports_public_only():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models

    def fake_search_models(kind, query, **kwargs):
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {
                "items": [{
                    "id": 1, "name": "Skin Detail XL", "type": "LORA",
                    "modelVersions": [{
                        "id": 10, "baseModel": "SDXL",
                        "files": [{"name": "skin.safetensors", "sizeKB": 1000,
                                   "downloadUrl": "https://civitai.com/x", "primary": True}],
                    }],
                }],
                "metadata": {"nextCursor": "next-page"},
            },
        }

    mb_api.civitai_search.search_models = fake_search_models
    # `search_impl` annotates `installed` via `download.destination_exists`,
    # which -- for a WHITELISTED kind -- reaches `local._model_dirs`'s own
    # unguarded `import folder_paths` (same as every other "valid kind"
    # test in this file); a real ComfyUI-less environment needs the stub.
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "skin"})
            assert result["reason"] == "ok"
            assert result["next_cursor"] == "next-page"
            assert result["public_only"] is True  # no key configured in this test env
            card = result["results"][0]
            assert card["installed"] is False  # nothing on disk in this test env
            assert card["gated"] is False
            assert card["base_model"] == "SDXL"
            assert card["file_name"] == "skin.safetensors"
        finally:
            restore_fp()
            mb_api.civitai_search.search_models = previous_search_models
            restore_limiter()


def test_search_impl_marks_a_result_installed_when_its_primary_file_is_already_on_disk():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models

    def fake_search_models(kind, query, **kwargs):
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {"items": [{
                "id": 1, "name": "X",
                "modelVersions": [{"id": 10, "baseModel": "SDXL",
                                   "files": [{"name": "already_have.safetensors", "downloadUrl": "https://civitai.com/x", "primary": True}]}],
            }]},
        }

    mb_api.civitai_search.search_models = fake_search_models
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        open(os.path.join(loras_root, "already_have.safetensors"), "wb").close()
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "x"})
            assert result["results"][0]["installed"] is True
        finally:
            restore_fp()
            mb_api.civitai_search.search_models = previous_search_models
            restore_limiter()


def test_search_impl_marks_a_gated_result_before_any_download_attempt():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models

    def fake_search_models(kind, query, **kwargs):
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {"items": [{
                "id": 1, "name": "Gated",
                "modelVersions": [{"id": 10, "baseModel": "SDXL", "earlyAccessEndsAt": "2099-01-01",
                                   "files": [{"name": "gated.safetensors", "downloadUrl": "https://civitai.com/x", "primary": True}]}],
            }]},
        }

    mb_api.civitai_search.search_models = fake_search_models
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "x"})
            assert result["results"][0]["gated"] is True
        finally:
            restore_fp()
            mb_api.civitai_search.search_models = previous_search_models
            restore_limiter()


def test_search_impl_passes_through_offline_reason_and_still_reports_public_only():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models
    mb_api.civitai_search.search_models = lambda kind, query, **kwargs: {
        "reason": "offline", "offline_reason": "timeout", "message": "Civitai timed out.", "data": None,
    }
    try:
        result = mb_api.search_impl({"kind": "loras", "query": "x"})
        assert result["reason"] == "offline"
        assert result["offline_reason"] == "timeout"
        assert result["results"] == []
        assert "public_only" in result
    finally:
        mb_api.civitai_search.search_models = previous_search_models
        restore_limiter()


def test_search_impl_rate_limited_never_reaches_the_network():
    previous_limiter = mb_api._SEARCH_LIMITER
    denying_limiter = rate_limit.MinIntervalLimiter(1000.0)
    denying_limiter.allow()  # consume the one free call so the NEXT is refused
    mb_api._SEARCH_LIMITER = denying_limiter

    previous_search_models = civitai_search.search_models

    def _must_not_be_called(*args, **kwargs):
        raise AssertionError("a rate-limited search must never reach civitai_search.search_models")

    mb_api.civitai_search.search_models = _must_not_be_called
    try:
        result = mb_api.search_impl({"kind": "loras", "query": "x"})
        assert result["reason"] == "rate_limited"
        assert result["results"] == []
    finally:
        mb_api.civitai_search.search_models = previous_search_models
        mb_api._SEARCH_LIMITER = previous_limiter


# --- download_start_impl / download_progress_impl / download_cancel_impl ---


class _FakeDownloadManager:
    """Swapped in for `mb_api._DOWNLOAD_MANAGER` -- records every call so a
    test can assert `download_start_impl` never reaches the manager on a
    rejected request (invalid destination/already-installed/invalid url/
    too-large), and controls exactly what `start`/`progress`/`cancel`
    return on the happy path."""

    def __init__(self, start_result=None, progress_result=None, cancel_result=None):
        self.start_calls = []
        self.progress_calls = []
        self.cancel_calls = []
        self._start_result = start_result or {"reason": "started", "job_id": "job-x"}
        self._progress_result = progress_result or {"reason": "ok", "status": "downloading", "bytes": 0, "total": None, "message": ""}
        self._cancel_result = cancel_result or {"reason": "cancelling", "message": "Cancelling…"}

    def start(self, job_id, url, dest_path, *, max_size_bytes):
        self.start_calls.append((job_id, url, dest_path, max_size_bytes))
        return dict(self._start_result)

    def progress(self, job_id):
        self.progress_calls.append(job_id)
        return dict(self._progress_result)

    def cancel(self, job_id):
        self.cancel_calls.append(job_id)
        return dict(self._cancel_result)


def _install_fake_download_manager(**kwargs):
    previous = mb_api._DOWNLOAD_MANAGER
    fake = _FakeDownloadManager(**kwargs)
    mb_api._DOWNLOAD_MANAGER = fake
    return fake, lambda: setattr(mb_api, "_DOWNLOAD_MANAGER", previous)


def test_download_start_impl_rejects_unwhitelisted_kind_without_touching_the_manager():
    fake, restore = _install_fake_download_manager()
    try:
        result = mb_api.download_start_impl({"kind": "../../etc", "filename": "a.safetensors", "download_url": "https://civitai.com/x"})
        assert result["reason"] == "invalid_kind"
        assert fake.start_calls == []
    finally:
        restore()


def test_download_start_impl_rejects_hostile_destination_without_touching_the_manager():
    fake, restore = _install_fake_download_manager()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "../escape.safetensors", "subfolder": "",
                "download_url": "https://civitai.com/x",
            })
            assert result["reason"] == "invalid_destination"
            assert fake.start_calls == []
        finally:
            restore_fp()
            restore()


def test_download_start_impl_rejects_a_nul_byte_filename_with_a_reason_instead_of_raising():
    # 🔒 2026-07-30 fix, end-to-end at the ROUTE layer (`api.py`'s own
    # contract: "every route answers 200 with a reason"): before the fix,
    # this raised `ValueError: embedded null character` straight out of
    # `download_start_impl` -- which runs inside `loop.run_in_executor` in
    # the real aiohttp route, so it would have surfaced as an unhandled
    # exception rather than a JSON `{reason: ...}` response.
    fake, restore = _install_fake_download_manager()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "mo\x00del.safetensors", "subfolder": "",
                "download_url": "https://civitai.com/x",
            })
            assert result["reason"] == "invalid_destination"
            assert fake.start_calls == []
        finally:
            restore_fp()
            restore()


def test_download_start_impl_already_installed_short_circuits_before_the_manager():
    fake, restore = _install_fake_download_manager()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        open(os.path.join(loras_root, "have.safetensors"), "wb").close()
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "have.safetensors", "subfolder": "",
                "download_url": "https://civitai.com/x",
            })
            assert result["reason"] == "already_installed"
            assert fake.start_calls == []
        finally:
            restore_fp()
            restore()


def test_download_start_impl_rejects_an_untrusted_download_url():
    fake, restore = _install_fake_download_manager()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "new.safetensors", "subfolder": "",
                "download_url": "https://evil.example.com/x",
            })
            assert result["reason"] == "invalid_url"
            assert fake.start_calls == []
        finally:
            restore_fp()
            restore()


def test_download_start_impl_rejects_an_advisory_size_over_the_cap():
    fake, restore = _install_fake_download_manager()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            huge_kb = (download.DEFAULT_MAX_DOWNLOAD_BYTES / 1024) + 1
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "new.safetensors", "subfolder": "",
                "download_url": "https://civitai.com/x", "size_kb": huge_kb,
            })
            assert result["reason"] == "too_large"
            assert fake.start_calls == []
        finally:
            restore_fp()
            restore()


def test_download_start_impl_happy_path_starts_a_job_and_never_returns_the_api_key():
    fake, restore = _install_fake_download_manager(start_result={"reason": "started", "job_id": "job-real"})
    previous_resolve = keys.resolve_api_key
    keys.resolve_api_key = lambda **kwargs: keys.ResolvedKey("super-secret", "setting")
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "new.safetensors", "subfolder": "",
                "download_url": "https://civitai.com/x", "size_kb": 100,
            })
            assert result["reason"] == "started"
            assert len(fake.start_calls) == 1
            job_id, url, dest_path, max_size_bytes = fake.start_calls[0]
            # `download_start_impl` generates its OWN job id (uuid4) and uses
            # it consistently for both the manager call and its own return
            # value -- the fake manager's own `start_result["job_id"]` is
            # deliberately NOT what's returned (that would be the real
            # manager's job to decide, and it never disagrees in practice).
            assert result["job_id"] == job_id
            assert "token=super-secret" in url
            assert dest_path == os.path.join(loras_root, "new.safetensors")
            # The key must never appear in the RETURNED result, only in the
            # URL handed to the (fake, in-test) manager.
            assert "super-secret" not in json.dumps(result)
        finally:
            restore_fp()
            keys.resolve_api_key = previous_resolve
            restore()


def test_download_start_impl_propagates_busy_from_the_manager():
    fake, restore = _install_fake_download_manager(start_result={"reason": "busy", "message": "Another download is already in progress.", "job_id": None})
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "new.safetensors", "subfolder": "",
                "download_url": "https://civitai.com/x",
            })
            assert result["reason"] == "busy"
            assert result["job_id"] is None
        finally:
            restore_fp()
            restore()


def test_download_progress_impl_and_cancel_impl_delegate_to_the_manager():
    fake, restore = _install_fake_download_manager(
        progress_result={"reason": "ok", "status": "downloading", "bytes": 42, "total": 100, "message": ""},
        cancel_result={"reason": "cancelling", "message": "Cancelling…"},
    )
    try:
        progress = mb_api.download_progress_impl({"job_id": "job-1"})
        assert progress["bytes"] == 42
        assert fake.progress_calls == ["job-1"]

        cancel = mb_api.download_cancel_impl({"job_id": "job-1"})
        assert cancel["reason"] == "cancelling"
        assert fake.cancel_calls == ["job-1"]
    finally:
        restore()


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
    test_parse_model_version_both_descriptions_present_are_returned_distinctly,
    test_parse_model_version_only_version_description_leaves_model_description_absent,
    test_parse_model_version_only_model_description_leaves_version_description_absent,
    test_parse_model_version_no_description_anywhere_is_simply_absent,
    test_html_to_text_owners_exact_example,
    test_html_to_text_multi_paragraph_stays_readable,
    test_html_to_text_br_becomes_newline,
    test_html_to_text_list_items_get_their_own_line,
    test_html_to_text_decodes_entities_after_stripping_real_tags,
    test_html_to_text_collapses_excess_blank_lines_and_trims,
    test_html_to_text_blank_or_non_string_is_empty_string_never_raises,
    test_parse_model_description_extracts_top_level_field,
    test_parse_model_description_converts_html_to_plain_text,
    test_parse_model_description_blank_or_missing_is_none,
    test_lookup_by_hash_success_on_first_host,
    test_lookup_by_hash_404_is_definitive_and_never_tries_backup_host,
    test_lookup_by_hash_non_404_error_falls_through_to_backup_host,
    test_lookup_by_hash_oversized_body_is_rejected,
    test_lookup_by_hash_unreadable_body_is_distinct_reason,
    test_lookup_by_hash_timeout_is_distinct_reason,
    test_lookup_by_hash_dns_failure_is_distinct_reason,
    test_lookup_by_hash_429_is_distinct_reason_and_falls_through,
    test_lookup_model_by_id_success_on_first_host,
    test_lookup_model_by_id_404_is_definitive_and_never_tries_backup_host,
    test_lookup_model_by_id_timeout_is_distinct_reason,
    test_sha256_file_matches_hashlib_and_streams_in_chunks,
    test_sha256_file_missing_file_raises_oserror,
    test_lookup_model_info_missing_file_is_offline_missing_file,
    test_lookup_model_info_cached_sidecar_short_circuits_network,
    test_lookup_model_info_no_sidecar_fetches_hashes_and_writes_sidecar,
    test_lookup_model_info_offline_and_notfound_pass_through,
    test_lookup_model_info_found_but_unparseable_degrades_to_notfound,
    test_lookup_model_info_fetches_model_description_fallback_when_missing_and_caches_it,
    test_lookup_model_info_fetches_fallback_even_when_a_version_description_already_exists,
    test_lookup_model_info_only_version_description_when_fetch_genuinely_finds_nothing,
    test_lookup_model_info_only_model_description_leaves_version_description_absent,
    test_lookup_model_info_neither_description_is_distinguishable_from_not_yet_checked,
    test_lookup_model_info_version_description_present_with_no_model_id_at_all,
    test_lookup_model_info_description_fallback_skipped_when_cached_only,
    test_lookup_model_info_description_fallback_transient_offline_does_not_mark_checked,
    test_lookup_model_info_sidecar_round_trip_preserves_both_descriptions,
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
    test_type_for_kind_known_and_unknown,
    test_build_search_url_shape_and_params,
    test_build_search_url_rejects_unwhitelisted_kind,
    test_build_search_url_garbage_sort_and_period_fall_back_to_defaults,
    test_build_search_url_limit_is_clamped,
    test_search_models_rejects_unwhitelisted_kind_without_any_network,
    test_search_models_success_and_api_key_rides_as_token_param,
    test_search_models_no_api_key_omits_token_param,
    test_search_models_404_folds_into_offline_unknown_not_notfound,
    test_search_models_timeout_is_distinct_reason,
    test_parse_search_response_typical_multi_item_shape,
    test_parse_search_response_early_access_marks_version_and_files_gated,
    test_parse_search_response_files_missing_name_or_url_are_dropped,
    test_parse_search_response_malformed_shapes_never_raise,
    test_pick_primary_file_prefers_primary_flag_then_falls_back_to_first,
    test_sanitize_filename_accepts_normal_names,
    test_sanitize_filename_rejects_hostile_values,
    test_sanitize_filename_rejects_an_embedded_nul_byte,
    test_validate_subfolder_accepts_normal_values,
    test_validate_subfolder_rejects_hostile_values,
    test_validate_subfolder_rejects_an_embedded_nul_byte,
    test_resolve_destination_path_rejects_a_nul_byte_in_filename_or_subfolder_without_raising,
    test_local_is_path_under_never_raises_on_an_embedded_nul_byte,
    test_resolve_destination_path_rejects_unwhitelisted_kind_without_folder_paths,
    test_resolve_destination_path_happy_path_and_subfolder,
    test_resolve_destination_path_rejects_hostile_filename_or_subfolder,
    test_resolve_destination_path_subfolder_that_escapes_root_via_realpath_is_rejected,
    test_destination_exists_true_only_when_the_real_file_is_present,
    test_is_allowed_download_url,
    test_is_safe_redirect_https_and_not_private,
    test_is_safe_redirect_dns_name_resolving_to_a_private_address_is_rejected,
    test_is_safe_redirect_one_safe_address_among_several_unsafe_ones_is_still_rejected,
    test_is_safe_redirect_resolution_failure_is_rejected_not_defaulted_to_allow,
    test_is_safe_redirect_decimal_ipv4_encoding_of_loopback_is_rejected,
    test_is_safe_redirect_decimal_ipv4_encoding_of_cloud_metadata_is_rejected,
    test_is_safe_redirect_hex_ipv4_encoding_of_loopback_is_rejected,
    test_is_safe_redirect_bare_integer_zero_is_rejected,
    test_safe_redirect_handler_refuses_hostile_hops_through_the_actual_wiring,
    test_safe_redirect_handler_chain_of_good_hops_then_a_bad_one,
    test_stream_download_success_writes_dest_and_removes_part,
    test_stream_download_rejects_non_https_url_without_calling_opener,
    test_stream_download_cancellation_leaves_no_part_and_never_registers_installed,
    test_stream_download_too_large_cleans_up_and_never_registers_installed,
    test_stream_download_401_is_key_required_not_a_generic_offline_reason,
    test_stream_download_403_is_also_key_required,
    test_stream_download_404_is_offline_notfound,
    test_stream_download_interrupted_mid_stream_leaves_nothing_the_presence_check_counts,
    test_download_manager_start_progress_and_completion,
    test_download_manager_unknown_job_id,
    test_download_manager_busy_while_a_download_is_in_flight,
    test_download_manager_cancel_signals_should_cancel_and_reaches_cancelled_status,
    test_resolve_api_key_setting_wins_over_env,
    test_resolve_api_key_falls_back_to_env_when_no_setting,
    test_resolve_api_key_public_only_when_neither_is_set,
    test_resolve_api_key_blank_values_are_treated_as_unset,
    test_min_interval_limiter_allows_then_refuses_then_allows_again,
    test_min_interval_limiter_seconds_until_allowed,
    test_search_impl_rejects_unwhitelisted_kind_without_any_network,
    test_search_impl_happy_path_annotates_installed_and_gated_and_reports_public_only,
    test_search_impl_marks_a_result_installed_when_its_primary_file_is_already_on_disk,
    test_search_impl_marks_a_gated_result_before_any_download_attempt,
    test_search_impl_passes_through_offline_reason_and_still_reports_public_only,
    test_search_impl_rate_limited_never_reaches_the_network,
    test_download_start_impl_rejects_unwhitelisted_kind_without_touching_the_manager,
    test_download_start_impl_rejects_hostile_destination_without_touching_the_manager,
    test_download_start_impl_rejects_a_nul_byte_filename_with_a_reason_instead_of_raising,
    test_download_start_impl_already_installed_short_circuits_before_the_manager,
    test_download_start_impl_rejects_an_untrusted_download_url,
    test_download_start_impl_rejects_an_advisory_size_over_the_cap,
    test_download_start_impl_happy_path_starts_a_job_and_never_returns_the_api_key,
    test_download_start_impl_propagates_busy_from_the_manager,
    test_download_progress_impl_and_cancel_impl_delegate_to_the_manager,
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
