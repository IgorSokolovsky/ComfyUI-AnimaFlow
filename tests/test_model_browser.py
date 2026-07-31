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

import email.message
import io
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
    civitai_client, civitai_parse, civitai_search, download, hashing, interop,
    keys, kinds, local, lookup, rate_limit, sidecar,
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
# interop.py -- reading Civicomfy's VERIFIED `.cminfo.json` (2026-07-30
# "no info sidecar" fix's reverse-direction half). No code was copied from
# Civicomfy -- only its verified filename constant and field names (see
# `interop.py`'s own module docstring + THIRD_PARTY_NOTICES.md).
# ---------------------------------------------------------------------------

# A realistic `.cminfo.json` payload, shaped exactly like Civicomfy's own
# `downloader/manager.py`'s `_save_metadata` (verified live, 2026-07-30) --
# PascalCase, flat, no gallery images (its preview is a separate file).
_CMINFO_FIXTURE = {
    "ModelId": 999, "ModelName": "My Character LoRA", "ModelDescription": "The author's write-up.",
    "CreatorUsername": "someartist", "Tags": ["character", "anime"], "ModelType": "LORA",
    "VersionId": 12345, "VersionName": "v1.0", "VersionDescription": "Trained on preview3.",
    "BaseModel": "Illustrious", "TrainedWords": ["mychar", "blue hair"],
    "Hashes": {"SHA256": "deadbeef"}, "DownloadUrlUsed": "https://civitai.com/api/download/models/12345",
}


def test_interop_cminfo_path_is_the_verified_civicomfy_suffix():
    assert interop.CMINFO_SUFFIX == ".cminfo.json"
    assert interop.cminfo_path("/models/loras/a.safetensors") == "/models/loras/a.cminfo.json"


def test_interop_translate_cminfo_typical_fixture_feeds_parse_model_version():
    shape = interop.translate_cminfo(_CMINFO_FIXTURE)
    parsed = civitai_parse.parse_model_version(shape)
    assert parsed["model_id"] == 999
    assert parsed["version_id"] == 12345
    assert parsed["name"] == "My Character LoRA"
    assert parsed["type"] == "LORA"
    assert parsed["base_model"] == "Illustrious"
    assert parsed["tags"] == ["character", "anime"]
    assert parsed["triggers"] == ["mychar", "blue hair"]
    assert parsed["model_description"] == "The author's write-up."
    assert parsed["version_description"] == "Trained on preview3."
    # Civicomfy stores no gallery images in this file (its preview is a
    # SEPARATE download) -- never invent a thumbnail from nothing.
    assert "thumbnail" not in parsed


def test_interop_translate_cminfo_never_raises_on_malformed_input():
    assert interop.translate_cminfo(None) == {}
    assert interop.translate_cminfo("not-a-dict") == {}
    assert interop.translate_cminfo({}) == {}
    assert interop.translate_cminfo({"ModelId": "not-an-int"}) == {}


def test_interop_read_cminfo_as_civitai_shape_missing_file_is_none():
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "a.safetensors")
        open(model_path, "wb").close()
        assert interop.read_cminfo_as_civitai_shape(model_path) is None


def test_interop_read_cminfo_as_civitai_shape_real_file_round_trip():
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "a.safetensors")
        open(model_path, "wb").close()
        with open(interop.cminfo_path(model_path), "w", encoding="utf-8") as fh:
            json.dump(_CMINFO_FIXTURE, fh)
        shape = interop.read_cminfo_as_civitai_shape(model_path)
        assert shape is not None
        assert civitai_parse.parse_model_version(shape)["name"] == "My Character LoRA"


def test_interop_read_cminfo_unreadable_json_returns_none_never_raises():
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "a.safetensors")
        open(model_path, "wb").close()
        with open(interop.cminfo_path(model_path), "w", encoding="utf-8") as fh:
            fh.write("not valid json {{{")
        assert interop.read_cminfo_as_civitai_shape(model_path) is None


# ---------------------------------------------------------------------------
# sidecar.read_sidecar's interop fallback (2026-07-30): prefers OUR OWN
# `.civitai.info` when present; falls back to Civicomfy's `.cminfo.json`
# (translated) only when ours is genuinely absent.
# ---------------------------------------------------------------------------


def test_read_sidecar_falls_back_to_cminfo_when_our_own_sidecar_is_absent():
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "a.safetensors")
        open(model_path, "wb").close()
        # No `.civitai.info` at all -- only a `.cminfo.json`, as if
        # Civicomfy (not us) had downloaded this exact file.
        with open(interop.cminfo_path(model_path), "w", encoding="utf-8") as fh:
            json.dump(_CMINFO_FIXTURE, fh)

        cached = sidecar.read_sidecar(model_path)
        assert cached is not None
        parsed = civitai_parse.parse_model_version(cached)
        assert parsed["name"] == "My Character LoRA"
        assert parsed["base_model"] == "Illustrious"


def test_read_sidecar_prefers_our_own_civitai_info_when_both_exist():
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "a.safetensors")
        open(model_path, "wb").close()
        # BOTH files exist, disagreeing on purpose -- `.civitai.info` must win.
        sidecar.write_sidecar(model_path, {"modelId": 1, "id": 2, "baseModel": "Ours-Wins"})
        with open(interop.cminfo_path(model_path), "w", encoding="utf-8") as fh:
            json.dump({**_CMINFO_FIXTURE, "BaseModel": "Cminfo-Should-Lose"}, fh)

        cached = sidecar.read_sidecar(model_path)
        assert cached == {"modelId": 1, "id": 2, "baseModel": "Ours-Wins"}


def test_read_sidecar_neither_file_present_is_none():
    with tempfile.TemporaryDirectory() as tmp:
        model_path = os.path.join(tmp, "a.safetensors")
        open(model_path, "wb").close()
        assert sidecar.read_sidecar(model_path) is None


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
    assert parsed["thumbnail"] == "https://example.com/img/anim=false,width=256/x.jpg"
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
    assert civitai_parse.parse_model_version(obj)["thumbnail"] == "https://example.com/anim=false,width=256/safe.jpg"


def test_parse_model_version_all_explicit_gallery_yields_no_thumbnail():
    obj = {"images": [{"url": "https://example.com/explicit.jpg", "nsfw": "XXX", "nsfwLevel": 16}]}
    assert "thumbnail" not in civitai_parse.parse_model_version(obj)


# ---------------------------------------------------------------------------
# 2026-07-30 "no info sidecar, no preview image" fix: `pick_gallery_image_url`
# (the UNTRANSFORMED variant `_pick_thumbnail` above now shares its adult-
# filtering loop with) and `civitai_shape_from_search_meta` (the download-
# time sidecar seed, built from OUR OWN normalized search-result fields).
# ---------------------------------------------------------------------------


def test_pick_gallery_image_url_prefers_explicitly_safe_and_is_untransformed():
    images = [
        {"url": "https://example.com/explicit.jpg", "nsfw": "X", "nsfwLevel": 8},
        {"url": "https://example.com/original=true/safe.jpg", "nsfw": False, "nsfwLevel": 1},
    ]
    # UNTRANSFORMED -- no `_thumb_url` width=256 rewrite, unlike `_pick_thumbnail`.
    assert civitai_parse.pick_gallery_image_url(images) == "https://example.com/original=true/safe.jpg"


def test_pick_gallery_image_url_all_explicit_yields_none():
    images = [{"url": "https://example.com/explicit.jpg", "nsfw": "XXX", "nsfwLevel": 16}]
    assert civitai_parse.pick_gallery_image_url(images) is None
    assert civitai_parse.pick_gallery_image_url(None) is None
    assert civitai_parse.pick_gallery_image_url("not-a-list") is None


def test_pick_thumbnail_still_transforms_its_own_result():
    # `_pick_thumbnail` is now a thin wrapper over `pick_gallery_image_url` --
    # confirm it still applies the anim=false,width=256 rewrite (regression
    # guard for the refactor, on top of the existing dedicated thumbnail
    # tests above).
    images = [{"url": "https://example.com/original=true/safe.jpg", "nsfw": False, "nsfwLevel": 1}]
    assert civitai_parse._pick_thumbnail(images) == "https://example.com/anim=false,width=256/safe.jpg"


def test_pick_thumbnail_url_is_the_promoted_public_name_and_stays_in_all():
    # docs task 2026-07-31 "Civitai search panel thumbnails": `_pick_thumbnail`
    # was promoted to a public `pick_thumbnail_url` -- both names must resolve
    # to the exact same function (an alias, not a divergent copy), and the
    # public one must be advertised in `__all__`.
    assert civitai_parse.pick_thumbnail_url is civitai_parse._pick_thumbnail
    assert "pick_thumbnail_url" in civitai_parse.__all__
    images = [{"url": "https://example.com/original=true/safe.jpg", "nsfw": False, "nsfwLevel": 1}]
    assert civitai_parse.pick_thumbnail_url(images) == "https://example.com/anim=false,width=256/safe.jpg"


# ---------------------------------------------------------------------------
# docs/lora-loader-design.md §7c-iv: `_thumb_url` emits `anim=false,width=256`
# -- a no-op on stills, a poster-frame extractor on video entries (measured
# live 2026-07-31: `width=256` alone makes the CDN transcode a video, which
# times out and can't render in an `<img>` anyway).
# ---------------------------------------------------------------------------


def test_thumb_url_emits_anim_false_width_256():
    url = "https://image.civitai.com/xyz/original=true/135268953.mp4"
    assert civitai_parse._thumb_url(url) == "https://image.civitai.com/xyz/anim=false,width=256/135268953.mp4"


def test_thumb_url_still_tolerates_original_true_with_other_params():
    # The regex's existing tolerance for `original=true,<other-params>` (not
    # just a bare `original=true`) must survive the rewrite-target change.
    url = "https://image.civitai.com/xyz/original=true,quality=90/1917130.jpeg"
    assert civitai_parse._thumb_url(url) == "https://image.civitai.com/xyz/anim=false,width=256/1917130.jpeg"


def test_thumb_url_passes_through_a_url_with_no_transform_segment():
    url = "https://image.civitai.com/xyz/1917130.jpeg"
    assert civitai_parse._thumb_url(url) == url


def test_civitai_shape_from_search_meta_typical_fields():
    meta = {
        "model_id": 999, "version_id": 12345, "name": "My Character LoRA",
        "type": "LORA", "base_model": "Illustrious",
        "tags": ["character", "anime"], "triggers": ["mychar", "blue hair"],
    }
    shape = civitai_parse.civitai_shape_from_search_meta(meta)
    # Fed straight into the SAME parser a live by-hash lookup's response
    # goes through -- no second parser to keep in sync.
    parsed = civitai_parse.parse_model_version(shape)
    assert parsed["model_id"] == 999
    assert parsed["version_id"] == 12345
    assert parsed["name"] == "My Character LoRA"
    assert parsed["type"] == "LORA"
    assert parsed["base_model"] == "Illustrious"
    assert parsed["tags"] == ["character", "anime"]
    assert parsed["triggers"] == ["mychar", "blue hair"]
    # A search result never carries description text -- omitted, not invented.
    assert "model_description" not in parsed
    assert "version_description" not in parsed


def test_civitai_shape_from_search_meta_never_raises_on_malformed_input():
    assert civitai_parse.civitai_shape_from_search_meta(None) == {}
    assert civitai_parse.civitai_shape_from_search_meta("not-a-dict") == {}
    assert civitai_parse.civitai_shape_from_search_meta({}) == {}
    # Garbage-typed fields are simply dropped, never crash the build.
    assert civitai_parse.civitai_shape_from_search_meta({"model_id": "not-an-int", "tags": "not-a-list"}) == {}


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


def test_lookup_by_hash_401_and_403_are_forbidden_not_key_required():
    # This read-only transport has never claimed `key_required` -- a 401/403
    # here (2026-07-30: most likely the same edge-level rejection the
    # `_USER_AGENT` fix addresses) is reported as its own `forbidden`
    # offline_reason, never folded into `unknown` or any auth-specific claim.
    for code in (401, 403):
        def raise_it(code=code):
            raise urllib.error.HTTPError("url", code, "reason", None, None)

        opener, calls = _sequence_opener([raise_it, raise_it])
        result = civitai_client.lookup_by_hash("deadbeef", opener=opener)
        assert result["reason"] == "offline", code
        assert result["offline_reason"] == "forbidden", code
        assert len(calls) == 2  # NOT definitive like a 404 -- both hosts tried


# ---------------------------------------------------------------------------
# civitai_client._USER_AGENT -- the 2026-07-30 fix (see the constant's own
# docstring: Civitai rejected the bare product-token UA in the field, and
# every download of a public file was misreported as needing an API key as a
# result). Both `civitai_client`'s own opener and `download.py`'s download
# opener must send the EXACT SAME string -- they must never drift apart.
# ---------------------------------------------------------------------------


def test_user_agent_is_the_verified_working_browser_shaped_string():
    assert civitai_client._USER_AGENT.startswith("Mozilla/5.0")
    assert "AnimaFlow-ComfyUI/model-browser" in civitai_client._USER_AGENT
    # Not the old bare product-token string that measured as rejected.
    assert civitai_client._USER_AGENT != "AnimaFlow-ComfyUI/model-browser"


def test_civitai_client_default_opener_sends_the_shared_user_agent():
    # No real socket -- `urllib.request.urlopen` itself is swapped out, same
    # "no real network in a unit test" discipline every other transport test
    # in this file already follows via the injectable `opener` seam (this
    # one exercises `_default_opener` ITSELF, the one function with no such
    # seam of its own, so the swap happens one level further down instead).
    captured = {}

    def fake_urlopen(request, timeout=None):
        captured["user_agent"] = request.get_header("User-agent")
        return None

    real_urlopen = urllib.request.urlopen
    urllib.request.urlopen = fake_urlopen
    try:
        civitai_client._default_opener("https://civitai.com/api/v1/models", 5.0)
    finally:
        urllib.request.urlopen = real_urlopen
    assert captured.get("user_agent") == civitai_client._USER_AGENT


def test_download_opener_sends_the_same_user_agent_as_civitai_client():
    # Same no-real-socket discipline as the test above, one level further
    # down again: `_default_download_opener` builds its OWN opener via
    # `urllib.request.build_opener`, so that's what's swapped out here.
    captured = {}

    class _FakeOpener:
        def open(self, request, timeout=None):
            captured["user_agent"] = request.get_header("User-agent")
            return None

    real_build_opener = urllib.request.build_opener
    urllib.request.build_opener = lambda *args, **kwargs: _FakeOpener()
    try:
        download._default_download_opener("https://civitai.com/api/download/models/1", 5.0)
    finally:
        urllib.request.build_opener = real_build_opener
    assert captured.get("user_agent") == civitai_client._USER_AGENT
    assert captured.get("user_agent") != "AnimaFlow-ComfyUI/model-browser"  # no drift back to the old string


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


# ---------------------------------------------------------------------------
# docs/lora-loader-design.md §7c-iv: "Maximum browsing level" replaces the
# NSFW checkbox -- `clean_level` is the pure validation `search_impl` calls
# before mapping the level to Civitai's own binary `nsfw` request param.
# ---------------------------------------------------------------------------


def test_clean_level_accepts_every_real_level():
    for level in civitai_search.LEVEL_VALUES:
        assert civitai_search.clean_level(level) == level


def test_clean_level_falls_back_to_pg_for_garbage():
    for bad in (0, 3, 32, -1, "bogus", None, [], {}, True, False):
        assert civitai_search.clean_level(bad) == civitai_search.DEFAULT_LEVEL == 1, bad


def test_clean_level_accepts_a_numeric_string():
    # The route hands `clean_level` a raw query-string value -- a
    # stringified level must validate the same as the int itself.
    assert civitai_search.clean_level("4") == 4
    assert civitai_search.clean_level("31") == civitai_search.DEFAULT_LEVEL  # not a real level -- falls back


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


def test_parse_search_response_flattens_primary_base_model_onto_the_result():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    result = civitai_search.parse_search_response(raw)["results"][0]
    assert result["base_model"] == "SDXL"
    assert result["versions"][0]["base_model"] == "SDXL"  # per-version copy stays intact too


def test_parse_search_response_no_base_model_on_primary_version_omits_the_key_absent_not_empty_string():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10,  # no `baseModel` key at all
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    result = civitai_search.parse_search_response(raw)["results"][0]
    # ABSENT, not `""` -- "omit rather than invent" (a Civitai result with
    # no base model genuinely has none; a placeholder would be a lie).
    assert "base_model" not in result
    assert result["versions"][0]["base_model"] == ""  # the per-version field keeps its own (empty) convention


def test_parse_search_response_multi_version_flattens_the_primary_ones_base_model_not_a_later_versions():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [
                {
                    "id": 10, "baseModel": "SDXL",
                    "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
                },
                {
                    "id": 9, "baseModel": "SD 1.5",
                    "files": [{"name": "b.safetensors", "downloadUrl": "https://civitai.com/b", "primary": True}],
                },
            ],
        }],
    }
    result = civitai_search.parse_search_response(raw)["results"][0]
    # The primary version (`versions[0]`, Civitai's own ordering) wins at
    # the top level -- NOT "the model's base model" in any aggregate sense.
    assert result["base_model"] == "SDXL"
    # Each version keeps its own individually-correct value underneath.
    assert result["versions"][0]["base_model"] == "SDXL"
    assert result["versions"][1]["base_model"] == "SD 1.5"


# ---------------------------------------------------------------------------
# docs/lora-loader-design.md §7c-iv: model-level `nsfwLevel` is a BITMASK
# UNION of the model's gallery images, parsed alongside (never in place of)
# the legacy `nsfw` bool -- neither may be used to decide anything by itself.
# ---------------------------------------------------------------------------


def test_parse_search_response_nsfw_level_parsed_at_model_level():
    raw = {
        "items": [{
            "id": 1, "nsfw": False, "nsfwLevel": 31,  # a real measured case: legacy bool says safe, level says otherwise
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    result = civitai_search.parse_search_response(raw)["results"][0]
    assert result["nsfw"] is False
    assert result["nsfw_level"] == 31


def test_parse_search_response_nsfw_level_none_when_absent():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    result = civitai_search.parse_search_response(raw)["results"][0]
    assert result["nsfw_level"] is None


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
# 2026-07-30 "no info sidecar, no preview image" fix: a search result's
# per-version `triggers`/`preview_url` -- the fields the download-time
# sidecar/preview-save reuse rather than a fresh API call.
# ---------------------------------------------------------------------------


def test_parse_search_response_carries_triggers_and_preview_url_per_version():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL", "trainedWords": ["mychar", "  ", "blue hair"],
                "images": [
                    {"url": "https://image.civitai.com/explicit.jpg", "nsfw": "X", "nsfwLevel": 8},
                    {"url": "https://image.civitai.com/safe.jpg", "nsfw": False, "nsfwLevel": 1},
                ],
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    version = civitai_search.parse_search_response(raw)["results"][0]["versions"][0]
    assert version["triggers"] == ["mychar", "blue hair"]
    # UNTRANSFORMED -- no width=256 rewrite (that's only `_pick_thumbnail`'s
    # own live-thumbnail use, never this download-time preview save).
    assert version["preview_url"] == "https://image.civitai.com/safe.jpg"


def test_parse_search_response_no_trigger_words_or_images_omits_neither_field_but_they_stay_empty_none():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    version = civitai_search.parse_search_response(raw)["results"][0]["versions"][0]
    assert version["triggers"] == []
    assert version["preview_url"] is None


# ---------------------------------------------------------------------------
# docs/lora-loader-design.md §7c-iv (2026-07-31): `thumb_url` (one pre-chosen,
# adult-filtered URL) is REPLACED by `images` -- the version's full gallery,
# thumbnail-rewritten but UNFILTERED, so the frontend can pick per the user's
# own browsing-level setting. `preview_url` (the untransformed, download-time
# preview pick) is untouched and stays a sibling, never derived from `images`.
# ---------------------------------------------------------------------------


def test_parse_search_response_images_are_256px_while_preview_url_stays_untransformed():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "images": [{"url": "https://image.civitai.com/original=true/safe.jpg", "nsfw": False, "nsfwLevel": 1}],
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    version = civitai_search.parse_search_response(raw)["results"][0]["versions"][0]
    assert version["preview_url"] == "https://image.civitai.com/original=true/safe.jpg"
    assert version["images"] == [{"url": "https://image.civitai.com/anim=false,width=256/safe.jpg", "nsfw_level": 1, "type": ""}]
    assert version["images"][0]["url"] != version["preview_url"]


def test_parse_search_response_no_images_leaves_images_empty_and_preview_url_none():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    version = civitai_search.parse_search_response(raw)["results"][0]["versions"][0]
    assert version["images"] == []
    assert version["preview_url"] is None


def test_parse_search_response_images_are_never_adult_filtered_unlike_preview_url():
    # `images` hands over EVERY entry regardless of nsfwLevel -- filtering by
    # the chosen browsing level is the frontend's job now (§7c-iv), so an
    # explicit entry that `preview_url`'s own adult filter would refuse must
    # still show up here.
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "images": [{"url": "https://image.civitai.com/original=true/explicit.jpg", "nsfw": "XXX", "nsfwLevel": 16}],
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    version = civitai_search.parse_search_response(raw)["results"][0]["versions"][0]
    assert version["images"] == [{"url": "https://image.civitai.com/anim=false,width=256/explicit.jpg", "nsfw_level": 16, "type": ""}]
    # `preview_url` keeps its existing adult-filtering behaviour untouched --
    # an all-explicit gallery still yields no download-time preview.
    assert version["preview_url"] is None


def test_parse_search_response_images_preserve_order_and_carry_video_type():
    # A gallery entry can be `type: "video"` (§7c-iv) -- it's a normal,
    # renderable candidate now that `_thumb_url` includes `anim=false`, not
    # something to drop. Order must survive exactly as Civitai sent it.
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "images": [
                    {"url": "https://image.civitai.com/original=true/first.jpg", "nsfwLevel": 1, "type": "image"},
                    {"url": "https://image.civitai.com/original=true/second.mp4", "nsfwLevel": 2, "type": "video"},
                    {"url": "https://image.civitai.com/original=true/third.jpg", "nsfwLevel": 4},  # no `type` at all
                ],
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    version = civitai_search.parse_search_response(raw)["results"][0]["versions"][0]
    assert version["images"] == [
        {"url": "https://image.civitai.com/anim=false,width=256/first.jpg", "nsfw_level": 1, "type": "image"},
        {"url": "https://image.civitai.com/anim=false,width=256/second.mp4", "nsfw_level": 2, "type": "video"},
        {"url": "https://image.civitai.com/anim=false,width=256/third.jpg", "nsfw_level": 4, "type": ""},
    ]


def test_parse_search_response_images_drop_entries_with_no_url_and_default_missing_level_to_none():
    raw = {
        "items": [{
            "id": 1,
            "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "images": [
                    {"url": "", "nsfwLevel": 1},
                    {"nsfwLevel": 1},  # no `url` key at all
                    "not-a-dict",
                    {"url": "https://image.civitai.com/ok.jpg"},  # no `nsfwLevel` at all -- unknown, not PG
                ],
                "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}],
            }],
        }],
    }
    version = civitai_search.parse_search_response(raw)["results"][0]["versions"][0]
    # No `/original=true/` segment on this one -- `_thumb_url` passes it
    # through untouched (same tolerance the regex has always had).
    assert version["images"] == [{"url": "https://image.civitai.com/ok.jpg", "nsfw_level": None, "type": ""}]


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
    # `.bin` deliberately -- NOT a `.safetensors`/`.sft` destination, so the
    # 2026-07-30 safetensors-header integrity gate never applies here; this
    # test is about the plain exact-length success path, not header validity
    # (that's `test_stream_download_valid_safetensors_header_is_ok` below).
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "sub", "a.bin")
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


# ---------------------------------------------------------------------------
# 2026-07-30 integrity-gate fix: a short/dropped stream (`bytes_written !=
# Content-Length`) or a wrong-content body (an HTML/login page with a
# perfectly correct `Content-Length` for ITSELF) used to be renamed over
# `dest_path` and reported `"ok"` anyway -- root cause of a real
# `json.JSONDecodeError` out of `AnimaLoaderPanel`. Both gates run BEFORE the
# atomic rename; on either failure `dest_path` is never touched and `.part`
# is cleaned up, same contract as every other failure reason.
# ---------------------------------------------------------------------------


def test_stream_download_short_read_with_known_length_is_incomplete():
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        dest = os.path.join(loras_root, "dropped.safetensors")

        # The server PROMISED 1000 bytes via Content-Length, but the stream
        # only actually delivers 500 before ending (a dropped connection /
        # the server closing early) -- indistinguishable from a clean finish
        # by `if not chunk: break` alone.
        def opener(url, timeout):
            return _FakeDownloadResponse(b"x" * 500, headers={"Content-Length": "1000"})

        result = download.stream_download("https://civitai.com/x", dest, opener=opener, chunk_size=64)
        assert result["reason"] == "incomplete"
        assert "500" in result["message"] and "1000" in result["message"]
        assert not os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")

        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.destination_exists("loras", "", "dropped.safetensors") is False
        finally:
            restore()


def test_stream_download_no_content_length_is_still_ok():
    # No `Content-Length` header at all -- the length gate can't run, so it
    # must be SKIPPED, not treated as a mismatch (`total` stays `None`).
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "no_length.bin")
        payload = b"y" * (2 * 1024 * 1024 + 3)

        def opener(url, timeout):
            return _FakeDownloadResponse(payload, headers={})

        result = download.stream_download("https://civitai.com/x", dest, opener=opener, chunk_size=1024 * 1024)
        assert result["reason"] == "ok"
        assert os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")
        with open(dest, "rb") as fh:
            assert fh.read() == payload


def test_stream_download_html_error_page_to_safetensors_dest_is_corrupt():
    # A wrong-content body: an HTML error/login page served with a perfectly
    # correct `Content-Length` FOR ITSELF -- the length gate alone can't
    # catch this, only the safetensors-header sanity check can.
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        dest = os.path.join(loras_root, "real_skin-step00000200.safetensors")
        body = b"<html><body>Please log in to continue</body></html>"

        def opener(url, timeout):
            return _FakeDownloadResponse(body, headers={"Content-Length": str(len(body))})

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "corrupt"
        assert not os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")

        restore = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            assert download.destination_exists("loras", "", "real_skin-step00000200.safetensors") is False
        finally:
            restore()


def test_stream_download_valid_safetensors_header_is_ok():
    header_json = json.dumps({"__metadata__": {"format": "pt"}}).encode("utf-8")
    payload = struct.pack("<Q", len(header_json)) + header_json

    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "good.safetensors")

        def opener(url, timeout):
            return _FakeDownloadResponse(payload, headers={"Content-Length": str(len(payload))})

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "ok"
        assert os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")


def test_stream_download_non_safetensors_destination_skips_header_check():
    # Arbitrary bytes that would fail the safetensors header parse outright
    # -- but the destination is `.pt`, so the header gate must not apply.
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "legacy.pt")
        body = b"not a safetensors header at all"

        def opener(url, timeout):
            return _FakeDownloadResponse(body, headers={"Content-Length": str(len(body))})

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "ok"
        assert os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")


# ---------------------------------------------------------------------------
# 2026-07-30 fix #2: a `200` whose `Content-Type` is `text/html` is never a
# valid model file -- confirmed live, a gated LoRA's download landed as a
# 10 KB file that was actually Civitai's own login page, served with a
# genuine 200 and a correct `Content-Length` FOR ITSELF (so neither the
# length gate nor the safetensors-header gate is the right tool -- the fix
# is a Content-Type check BEFORE any bytes are read or written).
# ---------------------------------------------------------------------------


class _ReadTrackingDownloadResponse(_FakeDownloadResponse):
    """Same as `_FakeDownloadResponse`, plus recording whether `.read()` was
    ever called -- the HTML-content-type gate's whole point is failing
    BEFORE the body is read at all, and a plain assertion on written bytes
    can't distinguish "never read" from "read then discarded"."""

    def __init__(self, body: bytes, *, headers=None):
        super().__init__(body, headers=headers)
        self.read_called = False

    def read(self, n=-1):
        self.read_called = True
        return super().read(n)


def test_stream_download_html_200_response_is_key_required_not_corrupt():
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "gated.safetensors")
        login_page = b"<!doctype html>\n<html lang=\"en\"><head><title>Civitai Login</title></head></html>"
        response = _ReadTrackingDownloadResponse(
            login_page, headers={"Content-Length": str(len(login_page)), "Content-Type": "text/html"},
        )

        def opener(url, timeout):
            return response

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "key_required"
        assert result["bytes_written"] == 0
        assert not os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")
        assert response.read_called is False  # the whole point: fail before reading the body


def test_stream_download_html_200_response_with_charset_param_is_still_key_required():
    # `_is_html_content_type` parses a MEDIA TYPE, not the whole header
    # string -- a trailing `charset=utf-8` parameter must not defeat it.
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "gated.safetensors")
        login_page = b"<!doctype html><html><head><title>Civitai Login</title></head></html>"
        response = _ReadTrackingDownloadResponse(
            login_page,
            headers={"Content-Length": str(len(login_page)), "Content-Type": "text/html; charset=utf-8"},
        )

        def opener(url, timeout):
            return response

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "key_required"
        assert result["bytes_written"] == 0
        assert not os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")
        assert response.read_called is False


def test_stream_download_binary_content_type_still_downloads_successfully():
    # The control case: a normal `application/octet-stream` response must
    # still stream and land exactly as before -- this fix must not touch the
    # ordinary success path.
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "real.safetensors")
        header_json = json.dumps({"__metadata__": {"format": "pt"}}).encode("utf-8")
        payload = struct.pack("<Q", len(header_json)) + header_json

        def opener(url, timeout):
            return _FakeDownloadResponse(
                payload, headers={"Content-Length": str(len(payload)), "Content-Type": "application/octet-stream"},
            )

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "ok"
        assert os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")


def test_stream_download_missing_content_type_header_still_downloads():
    # No `Content-Type` header at all -- must not invent a requirement the
    # server never stated (same stance as the missing-Content-Length case).
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "no_content_type.bin")
        payload = b"z" * (1024 * 1024 + 5)

        def opener(url, timeout):
            return _FakeDownloadResponse(payload, headers={"Content-Length": str(len(payload))})

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "ok"
        assert os.path.isfile(dest)
        assert not os.path.isfile(dest + ".part")


# A real Civitai "you must be logged in to download this" body -- verified
# live (2026-07-30) against three actual early-access LoRA versions:
# `Content-Type: application/json`, `{"error": "Unauthorized", "message":
# "The creator of this asset requires you to be logged in to download it"}`.
_CIVITAI_KEY_REQUIRED_BODY = json.dumps({
    "error": "Unauthorized",
    "message": "The creator of this asset requires you to be logged in to download it",
}).encode("utf-8")


def _http_error_with_body(code: int, body: bytes, *, content_type: str = "application/json; charset=utf-8"):
    """A real `urllib.error.HTTPError` with an actually-readable `.headers`/
    `.read()` -- unlike the bare `HTTPError(url, code, msg, None, None)`
    shape used elsewhere in this file (which is fine for tests that never
    look past `.code`), `_is_key_required_body` needs a genuine
    Content-Type header and a genuine body stream to classify against."""
    hdrs = email.message.Message()
    hdrs["Content-Type"] = content_type
    return urllib.error.HTTPError("https://civitai.com/x", code, "reason", hdrs, io.BytesIO(body))


def test_stream_download_401_with_confirmed_body_is_key_required():
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "gated.safetensors")

        def opener(url, timeout):
            raise _http_error_with_body(401, _CIVITAI_KEY_REQUIRED_BODY)

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "key_required"
        assert not os.path.isfile(dest)


def test_stream_download_403_with_confirmed_body_is_also_key_required():
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "gated.safetensors")

        def opener(url, timeout):
            raise _http_error_with_body(403, _CIVITAI_KEY_REQUIRED_BODY)

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "key_required"


def test_stream_download_401_without_a_body_is_forbidden_not_key_required():
    # The actual 2026-07-30 bug: an edge/WAF-level 401 (e.g. the rejected
    # User-Agent) carries no confirming Civitai auth-error body -- this used
    # to be reported as `key_required` unconditionally, turning a public
    # file's download failure into a confidently wrong claim.
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "not_actually_gated.safetensors")

        def opener(url, timeout):
            raise urllib.error.HTTPError("url", 401, "Unauthorized", None, None)

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "offline"
        assert result["offline_reason"] == "forbidden"
        assert not os.path.isfile(dest)


def test_stream_download_403_with_html_body_is_forbidden_not_key_required():
    # A non-JSON (e.g. an HTML block/challenge page) 403 must not be read as
    # "needs a key" either -- only Civitai's own confirmed JSON shape does.
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "not_actually_gated.safetensors")

        def opener(url, timeout):
            raise _http_error_with_body(403, b"<html>Access Denied</html>", content_type="text/html")

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "offline"
        assert result["offline_reason"] == "forbidden"


def test_stream_download_401_with_unrelated_json_body_is_forbidden_not_key_required():
    # JSON, but not Civitai's own auth-refusal shape -- still not confirmed.
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "not_actually_gated.safetensors")

        def opener(url, timeout):
            raise _http_error_with_body(401, json.dumps({"error": "SomethingElse"}).encode("utf-8"))

        result = download.stream_download("https://civitai.com/x", dest, opener=opener)
        assert result["reason"] == "offline"
        assert result["offline_reason"] == "forbidden"


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
# 2026-07-30 "no info sidecar, no preview image" fix: `fetch_preview_image`,
# `finalize_successful_download`, and the `DownloadManager` wiring that runs
# it ONLY after a real download reaches `"ok"`.
# ---------------------------------------------------------------------------


def test_preview_extension_for_content_type_maps_known_types_and_rejects_unknown():
    assert download._preview_extension_for_content_type("image/png") == ".preview.png"
    assert download._preview_extension_for_content_type("image/jpeg; charset=binary") == ".preview.jpeg"
    assert download._preview_extension_for_content_type("image/webp") == ".preview.webp"
    assert download._preview_extension_for_content_type("image/gif") is None
    assert download._preview_extension_for_content_type("text/html") is None
    assert download._preview_extension_for_content_type(None) is None
    assert download._preview_extension_for_content_type(123) is None


def test_fetch_preview_image_success_writes_file_with_correct_extension():
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()
        payload = b"\x89PNG-fake-bytes"

        def opener(url, timeout):
            return _FakeDownloadResponse(payload, headers={"Content-Type": "image/png"})

        result = download.fetch_preview_image("https://image.civitai.com/x.png", dest_model, opener=opener)
        assert result == os.path.join(tmp, "a.preview.png")
        assert os.path.isfile(result)
        with open(result, "rb") as fh:
            assert fh.read() == payload
        # `local.find_preview_path` -- our own reader -- finds it too.
        assert local.find_preview_path(dest_model) == result


def test_fetch_preview_image_rejects_non_https_url_without_calling_opener():
    def _must_not_be_called(*args, **kwargs):
        raise AssertionError("a non-HTTPS preview url must never reach the opener")

    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()
        result = download.fetch_preview_image("http://image.civitai.com/x.png", dest_model, opener=_must_not_be_called)
        assert result is None
        assert local.find_preview_path(dest_model) is None


def test_fetch_preview_image_is_safe_redirect_refusal_never_calls_the_opener():
    # Same SSRF guard `stream_download`'s redirect handling uses
    # (`_is_safe_redirect`) -- gates the INITIAL preview url too (see
    # `fetch_preview_image`'s own docstring for why this, not
    # `is_allowed_download_url`, is the right analogue here).
    previous = download._is_safe_redirect
    download._is_safe_redirect = lambda url: False
    try:
        calls = []

        def opener(url, timeout):
            calls.append(url)
            raise AssertionError("must never be called once _is_safe_redirect refuses")

        with tempfile.TemporaryDirectory() as tmp:
            dest_model = os.path.join(tmp, "a.safetensors")
            open(dest_model, "wb").close()
            result = download.fetch_preview_image("https://evil.example.com/x.png", dest_model, opener=opener)
            assert result is None
            assert calls == []
    finally:
        download._is_safe_redirect = previous


def test_fetch_preview_image_unknown_content_type_is_rejected_body_never_written():
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()

        def opener(url, timeout):
            return _FakeDownloadResponse(b"<html>not an image</html>", headers={"Content-Type": "text/html"})

        result = download.fetch_preview_image("https://image.civitai.com/x", dest_model, opener=opener)
        assert result is None
        assert local.find_preview_path(dest_model) is None


def test_fetch_preview_image_oversized_body_is_rejected():
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()

        def opener(url, timeout):
            return _FakeDownloadResponse(b"x" * 4096, headers={"Content-Type": "image/png"})

        result = download.fetch_preview_image(
            "https://image.civitai.com/x.png", dest_model, opener=opener, max_bytes=1024,
        )
        assert result is None
        assert local.find_preview_path(dest_model) is None


def test_fetch_preview_image_opener_raising_returns_none_never_raises():
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()

        def opener(url, timeout):
            raise urllib.error.URLError(OSError("connection reset"))

        result = download.fetch_preview_image("https://image.civitai.com/x.png", dest_model, opener=opener)
        assert result is None
        assert local.find_preview_path(dest_model) is None


# --- finalize_successful_download -------------------------------------------


def test_finalize_successful_download_writes_sidecar_and_preview():
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()
        civitai_meta = {"model_id": 1, "version_id": 2, "name": "X", "base_model": "SDXL", "tags": ["character"], "triggers": ["mytrigger"]}
        opener_calls = []

        def preview_opener(url, timeout):
            opener_calls.append(url)
            return _FakeDownloadResponse(b"imgbytes", headers={"Content-Type": "image/jpeg"})

        download.finalize_successful_download(
            dest_model, civitai_meta=civitai_meta, preview_url="https://image.civitai.com/x.jpg",
            preview_opener=preview_opener,
        )

        cached = sidecar.read_sidecar(dest_model)
        assert cached is not None
        parsed = civitai_parse.parse_model_version(cached)
        assert parsed["name"] == "X"
        assert parsed["base_model"] == "SDXL"
        assert parsed["triggers"] == ["mytrigger"]

        preview_path = local.find_preview_path(dest_model)
        assert preview_path == os.path.join(tmp, "a.preview.jpeg")
        assert opener_calls == ["https://image.civitai.com/x.jpg"]


def test_finalize_successful_download_no_civitai_meta_or_preview_url_is_a_no_op():
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()

        def _must_not_be_called(*args, **kwargs):
            raise AssertionError("no preview_url was given -- the opener must never be reached")

        download.finalize_successful_download(dest_model, preview_opener=_must_not_be_called)
        assert sidecar.read_sidecar(dest_model) is None
        assert local.find_preview_path(dest_model) is None


def test_finalize_successful_download_civitai_enabled_false_skips_the_preview_fetch_but_still_writes_sidecar():
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()

        def _must_not_be_called(*args, **kwargs):
            raise AssertionError("civitai_enabled=False -- the preview opener must never be called at all")

        download.finalize_successful_download(
            dest_model,
            civitai_meta={"model_id": 1, "name": "X"},
            preview_url="https://image.civitai.com/x.jpg",
            civitai_enabled=False,
            preview_opener=_must_not_be_called,
        )
        # The sidecar write is NOT a network call -- unaffected by the flag.
        cached = sidecar.read_sidecar(dest_model)
        assert cached is not None
        assert civitai_parse.parse_model_version(cached)["name"] == "X"
        assert local.find_preview_path(dest_model) is None


def test_finalize_successful_download_preview_fetch_failure_never_raises_and_sidecar_still_written():
    # THE explicit regression this task's correction asked for: "a preview
    # fetch that raises/times out ⇒ the model download still reports ok,
    # sidecar still written, no preview file."
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()

        def raising_preview_opener(url, timeout):
            raise socket.timeout("timed out")

        # Must not raise.
        download.finalize_successful_download(
            dest_model,
            civitai_meta={"model_id": 1, "name": "X"},
            preview_url="https://image.civitai.com/x.jpg",
            preview_opener=raising_preview_opener,
        )
        cached = sidecar.read_sidecar(dest_model)
        assert cached is not None
        assert civitai_parse.parse_model_version(cached)["name"] == "X"
        assert local.find_preview_path(dest_model) is None


def test_finalize_successful_download_overwrite_policy_sidecar_always_preview_never_when_one_exists():
    # Overwrite policy, pinned: `.civitai.info` is ALWAYS refreshed; an
    # EXISTING preview (ours or another tool's) is NEVER clobbered.
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "a.safetensors")
        open(dest_model, "wb").close()
        # A stale sidecar already exists -- must be overwritten with fresh data.
        sidecar.write_sidecar(dest_model, {"modelId": 1, "id": 1, "baseModel": "Stale"})
        # A preview already exists (simulating another tool's file, or an
        # earlier download) -- must be left untouched.
        existing_preview = os.path.join(tmp, "a.preview.webp")
        with open(existing_preview, "wb") as fh:
            fh.write(b"already-here")

        def _must_not_be_called(*args, **kwargs):
            raise AssertionError("a preview already exists -- the opener must never be called")

        download.finalize_successful_download(
            dest_model,
            civitai_meta={"model_id": 2, "version_id": 3, "name": "Fresh", "base_model": "SDXL"},
            preview_url="https://image.civitai.com/x.jpg",
            preview_opener=_must_not_be_called,
        )

        cached = sidecar.read_sidecar(dest_model)
        parsed = civitai_parse.parse_model_version(cached)
        assert parsed["name"] == "Fresh"  # overwritten, stale data gone
        assert parsed["base_model"] == "SDXL"

        # The pre-existing preview is exactly as it was -- never touched.
        assert local.find_preview_path(dest_model) == existing_preview
        with open(existing_preview, "rb") as fh:
            assert fh.read() == b"already-here"


# --- DownloadManager wiring: finalize runs ONLY on a real "ok" -------------


def test_download_manager_start_runs_finalize_on_ok_writing_sidecar_and_preview():
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "ok.safetensors")

        def fake_stream(url, dest_path, *, max_size_bytes, timeout, progress_cb, should_cancel):
            open(dest_path, "wb").close()  # simulate the atomic rename already having happened
            return {"reason": "ok", "message": "", "bytes_written": 0}

        preview_calls = []

        def preview_opener(url, timeout):
            preview_calls.append(url)
            return _FakeDownloadResponse(b"imgbytes", headers={"Content-Type": "image/png"})

        manager = download.DownloadManager(stream_fn=fake_stream, preview_opener=preview_opener)
        manager.start(
            "job-ok", "https://civitai.com/x", dest_model,
            civitai_meta={"model_id": 1, "name": "X"},
            preview_url="https://image.civitai.com/x.png",
        )
        for _ in range(200):
            progress = manager.progress("job-ok")
            if progress["status"] != "downloading":
                break
            time.sleep(0.005)
        assert progress["status"] == "ok"  # the download itself still reports ok
        assert sidecar.read_sidecar(dest_model) is not None
        assert local.find_preview_path(dest_model) == os.path.join(tmp, "ok.preview.png")
        assert preview_calls == ["https://image.civitai.com/x.png"]


def test_download_manager_start_never_finalizes_on_a_failed_download_directory_stays_clean():
    # "A failed/short/HTML download writes no sidecar and no preview --
    # assert the directory is clean" -- exercised here at the FULL manager
    # level, `civitai_meta`/`preview_url` supplied exactly as a real caller
    # would, on a download that does NOT reach `"ok"`.
    with tempfile.TemporaryDirectory() as tmp:
        dest_model = os.path.join(tmp, "failed.safetensors")

        def fake_stream(url, dest_path, *, max_size_bytes, timeout, progress_cb, should_cancel):
            # No file written -- matches a real failed/incomplete/corrupt
            # `stream_download` outcome (dest_path never touched).
            return {"reason": "corrupt", "message": "not a valid file", "bytes_written": 0}

        def _must_not_be_called(*args, **kwargs):
            raise AssertionError("finalize must never run for a non-ok result")

        manager = download.DownloadManager(stream_fn=fake_stream, preview_opener=_must_not_be_called)
        manager.start(
            "job-bad", "https://civitai.com/x", dest_model,
            civitai_meta={"model_id": 1, "name": "X"},
            preview_url="https://image.civitai.com/x.png",
        )
        for _ in range(200):
            progress = manager.progress("job-bad")
            if progress["status"] != "downloading":
                break
            time.sleep(0.005)
        assert progress["status"] == "corrupt"
        assert not os.path.isfile(dest_model)
        assert sidecar.read_sidecar(dest_model) is None
        assert local.find_preview_path(dest_model) is None
        assert os.listdir(tmp) == []  # the directory is genuinely clean


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


def test_search_impl_flattens_primary_versions_triggers_and_preview_url_onto_the_result():
    # 2026-07-30 "no info sidecar, no preview image" fix: these are exactly
    # the two fields `download_start_impl`'s own `civitai_meta`/`preview_url`
    # payload fields expect the frontend to hand straight back.
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models

    def fake_search_models(kind, query, **kwargs):
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {
                "items": [{
                    "id": 1, "name": "Skin Detail XL", "type": "LORA",
                    "modelVersions": [{
                        "id": 10, "baseModel": "SDXL", "trainedWords": ["mytrigger"],
                        "images": [{"url": "https://image.civitai.com/safe.jpg", "nsfw": False, "nsfwLevel": 1}],
                        "files": [{"name": "skin.safetensors", "sizeKB": 1000,
                                   "downloadUrl": "https://civitai.com/x", "primary": True}],
                    }],
                }],
                "metadata": {},
            },
        }

    mb_api.civitai_search.search_models = fake_search_models
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "skin"})
            card = result["results"][0]
            assert card["triggers"] == ["mytrigger"]
            assert card["preview_url"] == "https://image.civitai.com/safe.jpg"
        finally:
            restore_fp()
            mb_api.civitai_search.search_models = previous_search_models
            restore_limiter()


# ---------------------------------------------------------------------------
# docs/lora-loader-design.md §7c-iv: `search_impl` takes a `level`, not an
# `nsfw` bool -- PG (level 1, the default) sends `nsfw=false` (the one real
# server-side guarantee); every other valid level sends `nsfw=true` (the
# only way to get the full gallery back, since the API has no per-level
# request parameter); a garbage level falls back to PG, same tolerance
# `sort`/`period` already get.
# ---------------------------------------------------------------------------


def _install_fake_search_models_capturing_kwargs(seen_kwargs):
    def fake_search_models(kind, query, **kwargs):
        seen_kwargs.append(kwargs)
        return {"reason": "found", "offline_reason": None, "message": "", "data": {"items": [], "metadata": {}}}
    mb_api.civitai_search.search_models = fake_search_models


def test_search_impl_default_level_is_pg_and_sends_nsfw_false():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models
    seen_kwargs = []
    _install_fake_search_models_capturing_kwargs(seen_kwargs)
    try:
        mb_api.search_impl({"kind": "loras", "query": "x"})
        assert seen_kwargs[-1]["nsfw"] is False
    finally:
        mb_api.civitai_search.search_models = previous_search_models
        restore_limiter()


def test_search_impl_level_one_sends_nsfw_false_every_other_valid_level_sends_nsfw_true():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models
    seen_kwargs = []
    _install_fake_search_models_capturing_kwargs(seen_kwargs)
    try:
        for level in civitai_search.LEVEL_VALUES:
            mb_api.search_impl({"kind": "loras", "query": "x", "level": level})
        assert seen_kwargs[0]["nsfw"] is False  # level 1 (PG)
        assert all(kwargs["nsfw"] is True for kwargs in seen_kwargs[1:])  # levels 2/4/8/16
    finally:
        mb_api.civitai_search.search_models = previous_search_models
        restore_limiter()


def test_search_impl_garbage_level_falls_back_to_pg_and_sends_nsfw_false():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models
    seen_kwargs = []
    _install_fake_search_models_capturing_kwargs(seen_kwargs)
    try:
        for bad in (0, 3, 32, "bogus", None):
            mb_api.search_impl({"kind": "loras", "query": "x", "level": bad})
        assert all(kwargs["nsfw"] is False for kwargs in seen_kwargs), seen_kwargs
    finally:
        mb_api.civitai_search.search_models = previous_search_models
        restore_limiter()


# ---------------------------------------------------------------------------
# docs task 2026-07-31 "Civitai search panel version picker": every version
# (not just the primary) gets its own `file_name`/`download_url`/`size_kb`/
# `gated`/`installed`/`images`, and the top-level flatten reads THOSE same
# per-version fields back off `versions[0]` -- one code path, not two.
# ---------------------------------------------------------------------------


def test_annotate_search_results_computes_all_five_fields_for_every_version_not_just_the_primary():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models

    def fake_search_models(kind, query, **kwargs):
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {"items": [{
                "id": 1, "name": "Multi Version LoRA",
                "modelVersions": [
                    {
                        "id": 10, "baseModel": "SDXL",
                        "images": [{"url": "https://image.civitai.com/original=true/one.jpg", "nsfw": False, "nsfwLevel": 1}],
                        "files": [{"name": "not_installed.safetensors", "sizeKB": 500,
                                   "downloadUrl": "https://civitai.com/a", "primary": True}],
                    },
                    {
                        "id": 9, "baseModel": "Pony", "earlyAccessEndsAt": "2099-01-01",
                        "images": [{"url": "https://image.civitai.com/original=true/two.jpg", "nsfw": False, "nsfwLevel": 1}],
                        "files": [{"name": "already_installed.safetensors", "sizeKB": 900,
                                   "downloadUrl": "https://civitai.com/b", "primary": True}],
                    },
                ],
            }]},
        }

    mb_api.civitai_search.search_models = fake_search_models
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        open(os.path.join(loras_root, "already_installed.safetensors"), "wb").close()
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "x"})
            versions = result["results"][0]["versions"]
            assert len(versions) == 2

            v0, v1 = versions[0], versions[1]
            # The PRIMARY (first) version -- not gated, not installed.
            assert v0["file_name"] == "not_installed.safetensors"
            assert v0["download_url"] == "https://civitai.com/a"
            assert v0["size_kb"] == 500
            assert v0["gated"] is False
            assert v0["installed"] is False
            assert v0["images"] == [{"url": "https://image.civitai.com/anim=false,width=256/one.jpg", "nsfw_level": 1, "type": ""}]

            # The SECOND version -- gated (earlyAccessEndsAt) AND already on
            # disk. Both computed independently of the primary version's own
            # values -- a version picker needs each version's OWN truth.
            assert v1["file_name"] == "already_installed.safetensors"
            assert v1["download_url"] == "https://civitai.com/b"
            assert v1["size_kb"] == 900
            assert v1["gated"] is True
            assert v1["installed"] is True
            assert v1["images"] == [{"url": "https://image.civitai.com/anim=false,width=256/two.jpg", "nsfw_level": 1, "type": ""}]
        finally:
            restore_fp()
            mb_api.civitai_search.search_models = previous_search_models
            restore_limiter()


def test_annotate_search_results_top_level_flatten_matches_versions_zero_exactly():
    restore_limiter = _install_permissive_search_limiter()
    previous_search_models = civitai_search.search_models

    def fake_search_models(kind, query, **kwargs):
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {"items": [{
                "id": 1, "name": "Two Versions",
                "modelVersions": [
                    {
                        "id": 10, "baseModel": "SDXL", "trainedWords": ["trig"],
                        "images": [{"url": "https://image.civitai.com/original=true/one.jpg", "nsfw": False, "nsfwLevel": 1}],
                        "files": [{"name": "primary.safetensors", "sizeKB": 123,
                                   "downloadUrl": "https://civitai.com/a", "primary": True}],
                    },
                    {
                        "id": 9, "baseModel": "Pony",
                        "files": [{"name": "second.safetensors", "sizeKB": 456,
                                   "downloadUrl": "https://civitai.com/b", "primary": True}],
                    },
                ],
            }]},
        }

    mb_api.civitai_search.search_models = fake_search_models
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "x"})
            card = result["results"][0]
            primary = card["versions"][0]

            # The published top-level contract's key set/meaning is
            # untouched -- these now read STRAIGHT OFF `versions[0]`'s own
            # just-computed fields (this function's own docstring), so they
            # must match it byte-for-byte, never merely "close".
            assert card["file_name"] == primary["file_name"] == "primary.safetensors"
            assert card["download_url"] == primary["download_url"] == "https://civitai.com/a"
            assert card["size_kb"] == primary["size_kb"] == 123
            assert card["gated"] == primary["gated"] is False
            assert card["installed"] == primary["installed"] is False
            assert card["base_model"] == primary["base_model"] == "SDXL"
            assert card["primary_version_id"] == primary["version_id"] == 10
            assert card["triggers"] == primary["triggers"] == ["trig"]
            assert card["preview_url"] == primary["preview_url"] == "https://image.civitai.com/original=true/one.jpg"
            assert card["images"] == primary["images"] == [
                {"url": "https://image.civitai.com/anim=false,width=256/one.jpg", "nsfw_level": 1, "type": ""},
            ]

            # The second version's own fields are untouched by the flatten
            # -- the top level is never a blend of both.
            second = card["versions"][1]
            assert second["file_name"] == "second.safetensors"
            assert second["base_model"] == "Pony"
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
        # Recorded SEPARATELY from `start_calls` (kept a plain 4-tuple, same
        # as before this fix, so the one existing test that unpacks it
        # positionally never needed to change) -- the three new 2026-07-30
        # "no info sidecar, no preview image" kwargs, one dict per call.
        self.start_kwargs = []
        self.progress_calls = []
        self.cancel_calls = []
        self._start_result = start_result or {"reason": "started", "job_id": "job-x"}
        self._progress_result = progress_result or {"reason": "ok", "status": "downloading", "bytes": 0, "total": None, "message": ""}
        self._cancel_result = cancel_result or {"reason": "cancelling", "message": "Cancelling…"}

    def start(self, job_id, url, dest_path, *, max_size_bytes, civitai_meta=None, preview_url=None, civitai_enabled=True):
        self.start_calls.append((job_id, url, dest_path, max_size_bytes))
        self.start_kwargs.append({"civitai_meta": civitai_meta, "preview_url": preview_url, "civitai_enabled": civitai_enabled})
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


def test_download_start_impl_threads_civitai_meta_and_preview_url_through_to_the_manager():
    # 2026-07-30 "no info sidecar, no preview image" fix: the payload-level
    # contract `download_start_impl`'s own docstring describes.
    fake, restore = _install_fake_download_manager()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "new.safetensors", "subfolder": "",
                "download_url": "https://civitai.com/x",
                "civitai_meta": {"model_id": 1, "name": "X"},
                "preview_url": "https://image.civitai.com/x.jpg",
                "civitai_enabled": False,
            })
            assert result["reason"] == "started"
            assert fake.start_kwargs[-1] == {
                "civitai_meta": {"model_id": 1, "name": "X"},
                "preview_url": "https://image.civitai.com/x.jpg",
                "civitai_enabled": False,
            }
        finally:
            restore_fp()
            restore()


def test_download_start_impl_defaults_civitai_enabled_true_and_tolerates_a_non_dict_meta():
    # No `civitai_meta`/`preview_url`/`civitai_enabled` at all in the
    # payload -- matches the behaviour before this fix existed, and a
    # hostile/malformed `civitai_meta` degrades to `None` rather than being
    # passed through raw.
    fake, restore = _install_fake_download_manager()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.download_start_impl({
                "kind": "loras", "filename": "new.safetensors", "subfolder": "",
                "download_url": "https://civitai.com/x", "civitai_meta": "not-a-dict", "preview_url": 12345,
            })
            assert result["reason"] == "started"
            assert fake.start_kwargs[-1] == {"civitai_meta": None, "preview_url": None, "civitai_enabled": True}
        finally:
            restore_fp()
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
    test_interop_cminfo_path_is_the_verified_civicomfy_suffix,
    test_interop_translate_cminfo_typical_fixture_feeds_parse_model_version,
    test_interop_translate_cminfo_never_raises_on_malformed_input,
    test_interop_read_cminfo_as_civitai_shape_missing_file_is_none,
    test_interop_read_cminfo_as_civitai_shape_real_file_round_trip,
    test_interop_read_cminfo_unreadable_json_returns_none_never_raises,
    test_read_sidecar_falls_back_to_cminfo_when_our_own_sidecar_is_absent,
    test_read_sidecar_prefers_our_own_civitai_info_when_both_exist,
    test_read_sidecar_neither_file_present_is_none,
    test_parse_model_version_typical_response,
    test_parse_model_version_no_trainedwords_no_model_name_still_found,
    test_parse_model_version_genuinely_empty_response_parses_to_nothing,
    test_parse_model_version_top_level_tags_win_over_model_tags,
    test_parse_model_version_tags_as_dicts_are_tolerated,
    test_parse_model_version_explicit_gallery_falls_back_to_non_adult,
    test_parse_model_version_all_explicit_gallery_yields_no_thumbnail,
    test_pick_gallery_image_url_prefers_explicitly_safe_and_is_untransformed,
    test_pick_gallery_image_url_all_explicit_yields_none,
    test_pick_thumbnail_still_transforms_its_own_result,
    test_pick_thumbnail_url_is_the_promoted_public_name_and_stays_in_all,
    test_thumb_url_emits_anim_false_width_256,
    test_thumb_url_still_tolerates_original_true_with_other_params,
    test_thumb_url_passes_through_a_url_with_no_transform_segment,
    test_civitai_shape_from_search_meta_typical_fields,
    test_civitai_shape_from_search_meta_never_raises_on_malformed_input,
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
    test_lookup_by_hash_401_and_403_are_forbidden_not_key_required,
    test_user_agent_is_the_verified_working_browser_shaped_string,
    test_civitai_client_default_opener_sends_the_shared_user_agent,
    test_download_opener_sends_the_same_user_agent_as_civitai_client,
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
    test_clean_level_accepts_every_real_level,
    test_clean_level_falls_back_to_pg_for_garbage,
    test_clean_level_accepts_a_numeric_string,
    test_search_models_rejects_unwhitelisted_kind_without_any_network,
    test_search_models_success_and_api_key_rides_as_token_param,
    test_search_models_no_api_key_omits_token_param,
    test_search_models_404_folds_into_offline_unknown_not_notfound,
    test_search_models_timeout_is_distinct_reason,
    test_parse_search_response_typical_multi_item_shape,
    test_parse_search_response_early_access_marks_version_and_files_gated,
    test_parse_search_response_files_missing_name_or_url_are_dropped,
    test_parse_search_response_flattens_primary_base_model_onto_the_result,
    test_parse_search_response_no_base_model_on_primary_version_omits_the_key_absent_not_empty_string,
    test_parse_search_response_multi_version_flattens_the_primary_ones_base_model_not_a_later_versions,
    test_parse_search_response_nsfw_level_parsed_at_model_level,
    test_parse_search_response_nsfw_level_none_when_absent,
    test_parse_search_response_malformed_shapes_never_raise,
    test_pick_primary_file_prefers_primary_flag_then_falls_back_to_first,
    test_parse_search_response_carries_triggers_and_preview_url_per_version,
    test_parse_search_response_no_trigger_words_or_images_omits_neither_field_but_they_stay_empty_none,
    test_parse_search_response_images_are_256px_while_preview_url_stays_untransformed,
    test_parse_search_response_no_images_leaves_images_empty_and_preview_url_none,
    test_parse_search_response_images_are_never_adult_filtered_unlike_preview_url,
    test_parse_search_response_images_preserve_order_and_carry_video_type,
    test_parse_search_response_images_drop_entries_with_no_url_and_default_missing_level_to_none,
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
    test_stream_download_short_read_with_known_length_is_incomplete,
    test_stream_download_no_content_length_is_still_ok,
    test_stream_download_html_error_page_to_safetensors_dest_is_corrupt,
    test_stream_download_valid_safetensors_header_is_ok,
    test_stream_download_non_safetensors_destination_skips_header_check,
    test_stream_download_html_200_response_is_key_required_not_corrupt,
    test_stream_download_html_200_response_with_charset_param_is_still_key_required,
    test_stream_download_binary_content_type_still_downloads_successfully,
    test_stream_download_missing_content_type_header_still_downloads,
    test_stream_download_401_with_confirmed_body_is_key_required,
    test_stream_download_403_with_confirmed_body_is_also_key_required,
    test_stream_download_401_without_a_body_is_forbidden_not_key_required,
    test_stream_download_403_with_html_body_is_forbidden_not_key_required,
    test_stream_download_401_with_unrelated_json_body_is_forbidden_not_key_required,
    test_stream_download_404_is_offline_notfound,
    test_stream_download_interrupted_mid_stream_leaves_nothing_the_presence_check_counts,
    test_download_manager_start_progress_and_completion,
    test_download_manager_unknown_job_id,
    test_download_manager_busy_while_a_download_is_in_flight,
    test_download_manager_cancel_signals_should_cancel_and_reaches_cancelled_status,
    test_preview_extension_for_content_type_maps_known_types_and_rejects_unknown,
    test_fetch_preview_image_success_writes_file_with_correct_extension,
    test_fetch_preview_image_rejects_non_https_url_without_calling_opener,
    test_fetch_preview_image_is_safe_redirect_refusal_never_calls_the_opener,
    test_fetch_preview_image_unknown_content_type_is_rejected_body_never_written,
    test_fetch_preview_image_oversized_body_is_rejected,
    test_fetch_preview_image_opener_raising_returns_none_never_raises,
    test_finalize_successful_download_writes_sidecar_and_preview,
    test_finalize_successful_download_no_civitai_meta_or_preview_url_is_a_no_op,
    test_finalize_successful_download_civitai_enabled_false_skips_the_preview_fetch_but_still_writes_sidecar,
    test_finalize_successful_download_preview_fetch_failure_never_raises_and_sidecar_still_written,
    test_finalize_successful_download_overwrite_policy_sidecar_always_preview_never_when_one_exists,
    test_download_manager_start_runs_finalize_on_ok_writing_sidecar_and_preview,
    test_download_manager_start_never_finalizes_on_a_failed_download_directory_stays_clean,
    test_resolve_api_key_setting_wins_over_env,
    test_resolve_api_key_falls_back_to_env_when_no_setting,
    test_resolve_api_key_public_only_when_neither_is_set,
    test_resolve_api_key_blank_values_are_treated_as_unset,
    test_min_interval_limiter_allows_then_refuses_then_allows_again,
    test_min_interval_limiter_seconds_until_allowed,
    test_search_impl_rejects_unwhitelisted_kind_without_any_network,
    test_search_impl_happy_path_annotates_installed_and_gated_and_reports_public_only,
    test_search_impl_flattens_primary_versions_triggers_and_preview_url_onto_the_result,
    test_search_impl_default_level_is_pg_and_sends_nsfw_false,
    test_search_impl_level_one_sends_nsfw_false_every_other_valid_level_sends_nsfw_true,
    test_search_impl_garbage_level_falls_back_to_pg_and_sends_nsfw_false,
    test_annotate_search_results_computes_all_five_fields_for_every_version_not_just_the_primary,
    test_annotate_search_results_top_level_flatten_matches_versions_zero_exactly,
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
    test_download_start_impl_threads_civitai_meta_and_preview_url_through_to_the_manager,
    test_download_start_impl_defaults_civitai_enabled_true_and_tolerates_a_non_dict_meta,
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
