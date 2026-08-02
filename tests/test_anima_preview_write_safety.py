"""Plain-script tests for the "never overwrite" data-loss fix at
`nodes/anima/_preview_helpers.py`'s two write sites: `save_images` (the
auto-save path, the reported bug -- a re-run with the same seed/day/stage
used to silently clobber the previous file) and `save_now`'s default writer
`_default_write_image_copy` (the "Save now" button's path, which resolves a
`dest_path` the same way and had the identical defect).

Two layers are exercised:

  1. `write_without_overwriting` + `_pil_format_for_extension` directly --
     the shared impure collision loop, using a trivial `open(path, "xb")`
     writer so these need no PIL/numpy at all (neither is importable in
     this dev environment -- same convention as every other `tests/
     test_anima_*` file).
  2. Both write sites END TO END, with `folder_paths`/`PIL` stubbed via
     `sys.modules` (same "stub the ComfyUI-only lazy import" convention as
     `tests/test_controls_loaders.py`/`tests/test_lora_apply.py`) so
     `save_images`/`save_now`'s real code paths run against a real temp
     directory on disk -- the actual regression guard: saving twice with an
     identical resolved filename produces two files, and the FIRST file's
     bytes are unchanged.

Run directly: `python tests/test_anima_preview_write_safety.py` (no pytest,
per project convention).
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import the module under test FIRST (resolves this pack's own `nodes`
# package via the repo-root sys.path shim above), THEN stub `sys.modules`
# for `folder_paths`/`PIL` per-test below -- `_preview_helpers.py`'s own
# lazy imports happen per-call, inside its functions, so they pick up
# whatever is in `sys.modules` at CALL time, not at this module's import time.
from nodes.anima import _preview_helpers as ph


def _xb_writer(full_path: str) -> None:
    """The simplest possible EXCLUSIVE writer -- `open(path, "xb")` is
    exactly the mechanism the task brief names, and it needs no PIL at all,
    so this exercises `write_without_overwriting`'s real collision-closing
    behaviour (not a fake standing in for it) with zero extra dependencies.
    """
    with open(full_path, "xb") as fh:
        fh.write(b"WRITTEN")


# ---------------------------------------------------------------------------
# write_without_overwriting -- the shared impure collision loop.
# ---------------------------------------------------------------------------


def test_no_collision_returns_the_plain_name():
    tmp = tempfile.mkdtemp()
    try:
        result = ph.write_without_overwriting(tmp, "name.png", _xb_writer)
        assert result == "name.png"
        assert os.path.isfile(os.path.join(tmp, "name.png"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_one_existing_file_yields_the_00001_suffix_and_leaves_it_untouched():
    tmp = tempfile.mkdtemp()
    try:
        original_path = os.path.join(tmp, "name.png")
        with open(original_path, "wb") as fh:
            fh.write(b"ORIGINAL")

        result = ph.write_without_overwriting(tmp, "name.png", _xb_writer)

        assert result == "name_00001.png"
        assert os.path.isfile(os.path.join(tmp, "name_00001.png"))
        with open(original_path, "rb") as fh:
            assert fh.read() == b"ORIGINAL", "the pre-existing file must be untouched"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_00001_also_taken_yields_00002():
    tmp = tempfile.mkdtemp()
    try:
        with open(os.path.join(tmp, "name.png"), "wb") as fh:
            fh.write(b"ORIGINAL")
        with open(os.path.join(tmp, "name_00001.png"), "wb") as fh:
            fh.write(b"SECOND")

        result = ph.write_without_overwriting(tmp, "name.png", _xb_writer)

        assert result == "name_00002.png"
        assert os.path.isfile(os.path.join(tmp, "name_00002.png"))
        with open(os.path.join(tmp, "name.png"), "rb") as fh:
            assert fh.read() == b"ORIGINAL"
        with open(os.path.join(tmp, "name_00001.png"), "rb") as fh:
            assert fh.read() == b"SECOND"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_extension_preserved_suffix_lands_before_the_dot():
    tmp = tempfile.mkdtemp()
    try:
        with open(os.path.join(tmp, "name.png"), "wb") as fh:
            fh.write(b"ORIGINAL")
        result = ph.write_without_overwriting(tmp, "name.png", _xb_writer)
        assert result.endswith(".png")
        assert "_00001" in result
        assert not result.endswith(".png_00001")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_dotted_stem_handled():
    tmp = tempfile.mkdtemp()
    try:
        with open(os.path.join(tmp, "my.file.png"), "wb") as fh:
            fh.write(b"ORIGINAL")
        result = ph.write_without_overwriting(tmp, "my.file.png", _xb_writer)
        assert result == "my.file_00001.png"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_repeated_calls_to_the_same_desired_name_each_get_their_own_file_first_untouched():
    # This is the actual end-to-end regression guard at the SHARED helper
    # level: two "saves" that both resolve to the same desired filename
    # must produce two files on disk, and the first one's bytes must be
    # byte-for-byte unchanged afterwards -- not just "a file count of two".
    tmp = tempfile.mkdtemp()
    try:
        first = ph.write_without_overwriting(tmp, "shot.png", lambda p: open(p, "xb").write(b"FIRST"))
        second = ph.write_without_overwriting(tmp, "shot.png", lambda p: open(p, "xb").write(b"SECOND"))

        assert first == "shot.png"
        assert second == "shot_00001.png"
        assert first != second, "must never resolve to the same path twice"
        with open(os.path.join(tmp, first), "rb") as fh:
            assert fh.read() == b"FIRST", "the first file's bytes must survive the second save"
        with open(os.path.join(tmp, second), "rb") as fh:
            assert fh.read() == b"SECOND"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_bound_is_enforced_and_raises_a_readable_error():
    # Every candidate "already taken" -- must give up with a readable error
    # rather than spinning forever or (worse) falling through to an
    # overwrite. Patches the module constant down so the test itself stays
    # fast; restores it afterwards so it can't leak into another test.
    original_bound = ph._MAX_COLLISION_ATTEMPTS
    ph._MAX_COLLISION_ATTEMPTS = 5
    attempts = []

    def always_collides(full_path):
        attempts.append(full_path)
        raise FileExistsError(full_path)

    try:
        try:
            ph.write_without_overwriting("/tmp/unused", "name.png", always_collides)
            raise AssertionError("expected FilenameCollisionExhausted")
        except ph.FilenameCollisionExhausted as exc:
            assert len(attempts) == 5
            assert "name.png" in str(exc)
    finally:
        ph._MAX_COLLISION_ATTEMPTS = original_bound


# ---------------------------------------------------------------------------
# _pil_format_for_extension -- pure string mapping, no PIL/I-O needed.
# ---------------------------------------------------------------------------


def test_pil_format_for_extension_known_and_unknown():
    assert ph._pil_format_for_extension("png") == "PNG"
    assert ph._pil_format_for_extension("PNG") == "PNG"
    assert ph._pil_format_for_extension("jpg") == "JPEG"
    assert ph._pil_format_for_extension("jpeg") == "JPEG"
    assert ph._pil_format_for_extension("webp") == "WEBP"
    assert ph._pil_format_for_extension("bmp") == "BMP"  # unrecognised -> upper()


# ---------------------------------------------------------------------------
# End-to-end at BOTH write sites -- `folder_paths`/`PIL` stubbed via
# `sys.modules` so the real `save_images`/`save_now` (and its default
# writer, `_default_write_image_copy`) code paths run against a real
# directory on disk, with no actual PIL/numpy installed.
# ---------------------------------------------------------------------------


class _FakeImage:
    """Stands in for a `PIL.Image.Image` (or a batch item already converted
    to one) -- only `.width`/`.height`/`.save(fh, format=..., pnginfo=...)`
    are exercised by `save_images`. `.save` writes a small tag so a test can
    tell which run's image ended up in which file."""

    def __init__(self, tag: str, width: int = 64, height: int = 48):
        self.tag = tag
        self.width = width
        self.height = height

    def save(self, fh, format=None, pnginfo=None):  # noqa: A002 - matches PIL's own signature
        fh.write(f"IMAGE:{self.tag}:{format}".encode("utf-8"))


class _FakePngInfo:
    def __init__(self):
        self.items = []

    def add_text(self, key, value):
        self.items.append((key, value))


def _install_fake_pil_and_folder_paths(output_dir: str):
    """Stub `folder_paths` (pointing at a real temp `output_dir`) and `PIL`/
    `PIL.PngImagePlugin` (just enough surface for `save_images`'s own
    imports) into `sys.modules`. Returns a `restore()` callback."""
    saved = {name: sys.modules.get(name) for name in ("folder_paths", "PIL", "PIL.PngImagePlugin")}

    fake_folder_paths = types.ModuleType("folder_paths")
    fake_folder_paths.get_output_directory = lambda: output_dir

    fake_png_plugin = types.ModuleType("PIL.PngImagePlugin")
    fake_png_plugin.PngInfo = _FakePngInfo

    fake_pil = types.ModuleType("PIL")
    fake_pil.PngImagePlugin = fake_png_plugin

    sys.modules["folder_paths"] = fake_folder_paths
    sys.modules["PIL"] = fake_pil
    sys.modules["PIL.PngImagePlugin"] = fake_png_plugin

    def restore():
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod

    return restore


def test_save_images_never_overwrites_and_first_file_survives():
    output_root = tempfile.mkdtemp()
    restore = _install_fake_pil_and_folder_paths(output_root)
    original_tensor_to_pil = ph._tensor_to_pil_images
    # Bypass the real numpy/torch tensor conversion (neither installed in
    # this dev environment) -- the sentinel already IS the "PIL image" this
    # test cares about, matching `_images_from`'s own "images is a plain
    # list of sentinel tensors" convention in test_anima_preview_images.py.
    ph._tensor_to_pil_images = lambda image_tensor: [image_tensor]

    # `save_settings.get("path") or "AnimaFlow"` treats an empty string as
    # "unset" (falls back to the "AnimaFlow" default), so an explicit
    # subfolder name is used here rather than "" -- `save_images` joins it
    # onto `folder_paths.get_output_directory()` itself.
    preview_settings = {
        "save": {
            "enabled": True,
            "extension": "png",
            "path": "shots",
            # No %counter% token -- this is exactly the reported bug's
            # default-template shape: a same-seed/day/stage re-run resolves
            # to the identical filename with nothing to disambiguate it.
            "filename": "%stage%_%seed%",
            "embed_workflow": False,
        },
    }
    output_dir = os.path.join(output_root, "shots")
    try:
        first = ph.save_images(
            wired={"final": _FakeImage("RUN1")},
            stages_to_save=["final"],
            preview_settings=preview_settings,
            seed=42,
        )
        second = ph.save_images(
            wired={"final": _FakeImage("RUN2")},
            stages_to_save=["final"],
            preview_settings=preview_settings,
            seed=42,
        )

        assert first[0]["filename"] == "final_42.png"
        assert second[0]["filename"] == "final_42_00001.png", (
            "the second save with an identical resolved filename must get "
            "the collision suffix, never overwrite the first"
        )

        on_disk = sorted(os.listdir(output_dir))
        assert on_disk == ["final_42.png", "final_42_00001.png"]

        with open(os.path.join(output_dir, "final_42.png"), "rb") as fh:
            assert fh.read() == b"IMAGE:RUN1:PNG", "first file's bytes must be unchanged"
        with open(os.path.join(output_dir, "final_42_00001.png"), "rb") as fh:
            assert fh.read() == b"IMAGE:RUN2:PNG"
    finally:
        ph._tensor_to_pil_images = original_tensor_to_pil
        restore()
        shutil.rmtree(output_root, ignore_errors=True)


class _FakeSourceImage:
    """Stands in for the `PIL.Image` context-manager `_default_write_image_copy`
    opens via `Image.open(source_path)` -- tags its `.save` output with the
    SOURCE path it was opened from, so a test can tell two copies apart
    without needing real image bytes anywhere."""

    def __init__(self, source_path: str):
        self._source_path = source_path
        self.width = 64
        self.height = 48
        self.mode = "RGB"

    def load(self):
        pass

    def convert(self, mode):
        self.mode = mode
        return self

    def save(self, fh, format=None):  # noqa: A002 - matches PIL's own signature
        fh.write(f"COPY:{os.path.basename(self._source_path)}:{format}".encode("utf-8"))

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


def _install_fake_pil_image():
    saved = sys.modules.get("PIL.Image")
    fake_image_module = types.ModuleType("PIL.Image")
    fake_image_module.open = lambda path: _FakeSourceImage(path)
    sys.modules["PIL.Image"] = fake_image_module
    # `from PIL import Image` also needs the parent package to expose the
    # submodule as an attribute.
    saved_pil = sys.modules.get("PIL")
    fake_pil = saved_pil if saved_pil is not None else types.ModuleType("PIL")
    fake_pil.Image = fake_image_module
    sys.modules["PIL"] = fake_pil

    def restore():
        if saved is None:
            sys.modules.pop("PIL.Image", None)
        else:
            sys.modules["PIL.Image"] = saved
        if saved_pil is None:
            sys.modules.pop("PIL", None)
        else:
            sys.modules["PIL"] = saved_pil

    return restore


def test_save_now_default_writer_never_overwrites_and_first_file_survives():
    # Exercises `save_now`'s DEFAULT write path (`_default_write_image_copy`,
    # no `write_fn` injected) -- the "Save now" button's own write site,
    # which resolves a `dest_path` the same way `save_images` does and had
    # the identical defect.
    root = tempfile.mkdtemp()
    output_dir = os.path.join(root, "output")
    temp_dir = os.path.join(root, "temp")
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)

    # A real "already-written stage image" source file for save_now to copy
    # from -- content is irrelevant (the fake `PIL.Image.open` below ignores
    # it and tags by path instead), only its EXISTENCE matters (`exists_fn`
    # defaults to `os.path.isfile`).
    source_path = os.path.join(temp_dir, "final_temp.png")
    with open(source_path, "wb") as fh:
        fh.write(b"source bytes irrelevant")

    restore_image = _install_fake_pil_image()
    # Same "" -> "AnimaFlow" fallback note as the `save_images` test above --
    # use an explicit subfolder name.
    preview_settings = {
        "save": {"extension": "png", "path": "shots", "filename": "%stage%_%seed%"},
    }
    final_output_dir = os.path.join(output_dir, "shots")
    try:
        fakes = {
            "output_dir_fn": lambda: output_dir,
            "temp_dir_fn": lambda: temp_dir,
            # No write_fn / probe_fn override -- exercise the real defaults,
            # including `_default_write_image_copy`.
        }
        first = ph.save_now(
            stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            preview_settings=preview_settings, seed=42, **fakes,
        )
        second = ph.save_now(
            stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            preview_settings=preview_settings, seed=42, **fakes,
        )

        assert first["filename"] == "final_42.png"
        assert second["filename"] == "final_42_00001.png", (
            "a second Save-now click resolving to the same filename must "
            "get the collision suffix, never overwrite the first"
        )

        on_disk = sorted(os.listdir(final_output_dir))
        assert on_disk == ["final_42.png", "final_42_00001.png"]

        with open(os.path.join(final_output_dir, "final_42.png"), "rb") as fh:
            first_bytes = fh.read()
        assert first_bytes == f"COPY:{os.path.basename(source_path)}:PNG".encode("utf-8")
        with open(os.path.join(final_output_dir, "final_42_00001.png"), "rb") as fh:
            assert fh.read() == first_bytes, "same source copied twice -> identical content, but two files"
    finally:
        restore_image()
        shutil.rmtree(root, ignore_errors=True)


# ---------------------------------------------------------------------------
# Existing %counter% behaviour must be unaffected by this fix.
# ---------------------------------------------------------------------------


def test_explicit_counter_token_still_increments_per_batch_item_unaffected_by_collision_logic():
    output_dir = tempfile.mkdtemp()
    restore = _install_fake_pil_and_folder_paths(output_dir)
    original_tensor_to_pil = ph._tensor_to_pil_images
    ph._tensor_to_pil_images = lambda image_tensor: list(image_tensor)

    preview_settings = {
        "save": {
            "enabled": True,
            "extension": "png",
            "path": "shots",
            "filename": "%stage%_%counter:3%",
            "embed_workflow": False,
        },
    }
    try:
        result = ph.save_images(
            wired={"final": [_FakeImage("A"), _FakeImage("B")]},
            stages_to_save=["final"],
            preview_settings=preview_settings,
            seed=0,
        )
        # A batch of 2 -- `%counter:3%` still increments per item, exactly
        # as before this fix (batch index is ALSO appended for a batch > 1,
        # unchanged behaviour) -- and neither one collides with the other,
        # so no collision suffix is added to either.
        filenames = sorted(entry["filename"] for entry in result)
        assert filenames == ["final_000_000.png", "final_001_001.png"]
    finally:
        ph._tensor_to_pil_images = original_tensor_to_pil
        restore()
        shutil.rmtree(output_dir, ignore_errors=True)


ALL_TESTS = [
    test_no_collision_returns_the_plain_name,
    test_one_existing_file_yields_the_00001_suffix_and_leaves_it_untouched,
    test_00001_also_taken_yields_00002,
    test_extension_preserved_suffix_lands_before_the_dot,
    test_dotted_stem_handled,
    test_repeated_calls_to_the_same_desired_name_each_get_their_own_file_first_untouched,
    test_bound_is_enforced_and_raises_a_readable_error,
    test_pil_format_for_extension_known_and_unknown,
    test_save_images_never_overwrites_and_first_file_survives,
    test_save_now_default_writer_never_overwrites_and_first_file_survives,
    test_explicit_counter_token_still_increments_per_batch_item_unaffected_by_collision_logic,
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
