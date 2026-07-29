"""Plain-script tests for `AnimaPreview.preview()`'s actual
`"ui": {"anima_stages": [...]}}` payload -- the contract fixed in the
original build: saving OFF must not mean the frontend's hover wipe gets zero
images, and every entry must carry a `stage` key so the wipe can tell which
pane is which.

**2026-07-28, LATER the same day**: the payload's key was renamed from
`images` to `anima_stages` -- `"ui": {"images": [...]}}` is ComfyUI's OWN
frontend trigger for drawing a native image preview inside the node, and
this node already draws its own (`js/anima/`'s DOM hover wipe), so returning
under `images` produced two stacked previews. See `nodes/anima/preview.py`'s
`preview()` for the full rationale and its accepted cost. This file asserts
BOTH halves of that fix: the payload lands under `anima_stages`, AND `ui`
carries no `images` key at all.

**2026-07-28 reversal**: `image_a`/`image_b`/`image_c` are gone. This file
now drives `preview()` through its real `images` LIST + `metadata_json`
inputs, and (since `AnimaPreview.INPUT_IS_LIST = True`) wraps every kwarg in
a one-element list the same way ComfyUI's own execution engine would, EXCEPT
`images` itself, which stays the real multi-item list (see
`nodes/anima/preview.py`'s own module docstring for why that one input is
never wrapped again).

File writing is FAKED, not performed -- `nodes/anima/_preview_helpers.py`'s
`save_images`/`write_temp_stage_images` are monkeypatched at the MODULE level
(not just passed as args) so this file exercises the real end-to-end path
through `AnimaPreview.preview()` -> `build_preview_ui_images` ->
`split_preview_stages`, without needing PIL, numpy, or `folder_paths` to
exist (none are importable in this dev environment -- see
`_preview_helpers.py`'s own "lazy, per-call" import convention, which is
exactly what makes this monkeypatch safe: the real functions are never
imported at module load time, only looked up by name inside
`build_preview_ui_images` at CALL time).

Run directly: `python tests/test_anima_preview_images.py` (no pytest, per project convention).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima import _preview_helpers as ph
from nodes.anima.preview import AnimaPreview


def _install_fake_writers():
    """Swap `save_images`/`write_temp_stage_images` for fakes that record
    which stages they were asked to write and return ComfyUI-shaped entries
    without touching a disk or importing PIL. Returns `(calls, restore)`."""
    calls = {"save": [], "temp": []}
    originals = {"save": ph.save_images, "temp": ph.write_temp_stage_images}

    def fake_save_images(*, wired, stages_to_save, preview_settings, seed=0, prompt=None, extra_pnginfo=None):
        calls["save"].append(list(stages_to_save))
        return [
            {"filename": f"{stage}_out.png", "subfolder": "AnimaFlow", "type": "output", "stage": stage}
            for stage in stages_to_save
        ]

    def fake_write_temp_stage_images(wired, stages):
        calls["temp"].append(list(stages))
        return [
            {"filename": f"{stage}_temp.png", "subfolder": "", "type": "temp", "stage": stage}
            for stage in stages
        ]

    ph.save_images = fake_save_images
    ph.write_temp_stage_images = fake_write_temp_stage_images

    def restore():
        ph.save_images = originals["save"]
        ph.write_temp_stage_images = originals["temp"]

    return calls, restore


def _images_from(state, images=None, metadata_labels=None):
    """Runs `AnimaPreview().preview(...)` with fake writers installed and
    with every input wrapped the way `INPUT_IS_LIST = True` would (a
    one-element list for `preview_state`/`metadata_json`; `images` itself
    stays a real multi-item list, matching `nodes/anima/preview.py`'s own
    contract) -> `(ui_images, calls)`.

    `images` is a plain list of sentinel tensors (any non-None value counts
    as "present" downstream). `metadata_labels`, if given, becomes this
    run's `metadata_json.stage_labels` -- omit it to exercise the positional
    (base/mid/final) fallback instead.

    Reads the result back out from `result["ui"]["anima_stages"]` -- NOT
    `result["ui"]["images"]` -- and asserts there is no `images` key at all,
    every single call (see this module's own top doc comment for why that
    absence is the whole point of the rename this fixture drives).
    """
    images = list(images) if images else []
    metadata_json = (
        json.dumps({"stage_labels": list(metadata_labels)}) if metadata_labels is not None else ""
    )
    calls, restore = _install_fake_writers()
    try:
        node = AnimaPreview()
        result = node.preview(
            preview_state=[json.dumps(state)],
            images=images,
            metadata_json=[metadata_json],
            prompt=[None],
            extra_pnginfo=[None],
        )
        assert "images" not in result["ui"], (
            "the ui dict must carry NO 'images' key -- that key is ComfyUI's own "
            "native-preview trigger, and this node draws its own preview"
        )
        return result["ui"]["anima_stages"], calls
    finally:
        restore()


# ---------------------------------------------------------------------------
# Saving OFF -- the bug this build fixes: the wipe must still get an image
# for every stage present this run.
# ---------------------------------------------------------------------------


def test_saving_off_yields_a_temp_entry_per_present_stage():
    images, calls = _images_from(
        {"save": {"enabled": False}}, images=["A", "B", "C"], metadata_labels=["base", "mid", "final"],
    )
    assert len(images) == 3
    by_stage = {img["stage"]: img for img in images}
    assert set(by_stage) == {"base", "mid", "final"}
    for stage, img in by_stage.items():
        assert img["type"] == "temp", stage
    assert calls["save"] == [] or calls["save"] == [[]]  # save writer never asked to write anything
    assert calls["temp"] and sorted(calls["temp"][0]) == ["base", "final", "mid"]


# ---------------------------------------------------------------------------
# Saving ON -- entries are the output files, correctly staged, and a stage
# that gets saved never ALSO gets a temp copy.
# ---------------------------------------------------------------------------


def test_saving_on_every_wired_input_yields_output_entries_no_temp_duplicates():
    images, calls = _images_from(
        {"save": {"enabled": True, "which": "every wired input"}},
        images=["A", "B", "C"], metadata_labels=["base", "mid", "final"],
    )
    assert len(images) == 3
    assert all(img["type"] == "output" for img in images)
    stages_seen = [img["stage"] for img in images]
    assert sorted(stages_seen) == ["base", "final", "mid"]
    assert len(stages_seen) == len(set(stages_seen)), "no stage should get two entries"
    assert calls["temp"] == [] or calls["temp"] == [[]]  # nothing left over for the temp writer


def test_saving_on_shown_only_still_previews_the_other_compared_stage_via_temp():
    # `which: "shown"` (the default) only SAVES compare.b ("final" here) --
    # but `base` is also present and named by compare.a, so the wipe still
    # needs it: it must arrive as a TEMP entry, not be silently dropped.
    # This is the one test that asserts BOTH halves of the contract at once:
    # `which` still controls what's SAVED, while the PREVIEW set stays
    # "every present stage" regardless.
    images, calls = _images_from(
        {"save": {"enabled": True, "which": "shown"}, "compare": {"enabled": True, "a": "base", "b": "final"}},
        images=["A", "C"], metadata_labels=["base", "final"],
    )
    by_stage = {img["stage"]: img for img in images}
    assert set(by_stage) == {"base", "final"}
    assert by_stage["final"]["type"] == "output"  # shown == compare.b == final -> actually saved
    assert by_stage["base"]["type"] == "temp"  # present + compared, but not in save.which's scope
    assert calls["save"] == [["final"]]
    assert calls["temp"] == [["base"]]


# ---------------------------------------------------------------------------
# Single-image and empty-graph edges.
# ---------------------------------------------------------------------------


def test_only_mid_present_yields_exactly_one_mid_entry():
    images, _ = _images_from({}, images=["B"], metadata_labels=["mid"])
    assert len(images) == 1
    assert images[0]["stage"] == "mid"


def test_nothing_wired_yields_an_empty_list_no_exception():
    images, calls = _images_from({}, images=[])
    assert images == []
    assert calls["save"] == []
    assert calls["temp"] == []


def test_one_entry_list_with_no_metadata_falls_back_to_base_label():
    # No metadata_json at all -- a single image degrades to "base" (the
    # positional default's first entry), not an exception.
    images, _ = _images_from({}, images=["A"])
    assert len(images) == 1
    assert images[0]["stage"] == "base"


# ---------------------------------------------------------------------------
# "Save now" (task item 6) -- `nodes/anima/_preview_helpers.py`'s `save_now`.
# Every touchpoint that would otherwise need PIL/folder_paths is injected
# (`output_dir_fn`/`temp_dir_fn`/`exists_fn`/`probe_fn`/`write_fn`), matching
# this file's own "fake the writer, don't perform it" convention -- only
# `output_dir_fn`/`temp_dir_fn` point at a REAL temp directory (so
# `os.makedirs`/`_next_counter`'s own `os.listdir` scan have something real
# to touch); nothing here imports PIL or `folder_paths`.
# ---------------------------------------------------------------------------


def _save_now_fakes(tmp_root):
    output_dir = os.path.join(tmp_root, "output")
    temp_dir = os.path.join(tmp_root, "temp")
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)
    calls = {"probe": [], "write": []}

    def probe_fn(source_path):
        calls["probe"].append(source_path)
        return (64, 48)

    def write_fn(source_path, dest_path):
        calls["write"].append((source_path, dest_path))

    return {
        "output_dir_fn": lambda: output_dir,
        "temp_dir_fn": lambda: temp_dir,
        "exists_fn": lambda path: True,
        "probe_fn": probe_fn,
        "write_fn": write_fn,
    }, calls


def test_save_now_prefers_final_then_mid_then_base():
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, calls = _save_now_fakes(tmp_root)
        stage_entries = {
            "base": {"filename": "base_temp.png", "subfolder": "", "type": "temp"},
            "mid": {"filename": "mid_temp.png", "subfolder": "", "type": "temp"},
            "final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"},
        }
        result = ph.save_now(
            stage_entries=stage_entries,
            preview_settings={"save": {"extension": "png", "path": "AnimaFlow", "filename": "%stage%_%seed%"}},
            seed=42,
            **fakes,
        )
        assert result["stage"] == "final"
        assert result["type"] == "output"
        assert result["filename"] == "final_42.png"
        assert len(calls["write"]) == 1
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_save_now_falls_back_when_the_better_stages_are_absent():
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, _ = _save_now_fakes(tmp_root)
        only_mid_and_base = {
            "base": {"filename": "base_temp.png", "subfolder": "", "type": "temp"},
            "mid": {"filename": "mid_temp.png", "subfolder": "", "type": "temp"},
        }
        result = ph.save_now(stage_entries=only_mid_and_base, preview_settings={}, **fakes)
        assert result["stage"] == "mid"

        only_base = {"base": {"filename": "base_temp.png", "subfolder": "", "type": "temp"}}
        result2 = ph.save_now(stage_entries=only_base, preview_settings={}, **fakes)
        assert result2["stage"] == "base"
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_save_now_raises_a_readable_error_when_nothing_is_available():
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, _ = _save_now_fakes(tmp_root)
        try:
            ph.save_now(stage_entries={}, preview_settings={}, **fakes)
            raise AssertionError("expected SaveNowError")
        except ph.SaveNowError as exc:
            assert "nothing to save" in str(exc).lower()
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_save_now_raises_when_the_source_file_is_no_longer_on_disk():
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, _ = _save_now_fakes(tmp_root)
        fakes["exists_fn"] = lambda path: False
        try:
            ph.save_now(
                stage_entries={"base": {"filename": "gone.png", "subfolder": "", "type": "temp"}},
                preview_settings={}, **fakes,
            )
            raise AssertionError("expected SaveNowError")
        except ph.SaveNowError as exc:
            assert "no longer on disk" in str(exc).lower()
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_save_now_reads_from_the_output_dir_for_an_already_saved_stage_temp_dir_otherwise():
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, _ = _save_now_fakes(tmp_root)
        seen_sources = []
        original_probe = fakes["probe_fn"]

        def probe_fn(source_path):
            seen_sources.append(source_path)
            return original_probe(source_path)

        fakes["probe_fn"] = probe_fn
        ph.save_now(
            stage_entries={"final": {"filename": "final.png", "subfolder": "sub", "type": "output"}},
            preview_settings={}, **fakes,
        )
        assert seen_sources[0] == os.path.join(fakes["output_dir_fn"](), "sub", "final.png")

        ph.save_now(
            stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            preview_settings={}, **fakes,
        )
        assert seen_sources[1] == os.path.join(fakes["temp_dir_fn"](), "final_temp.png")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


ALL_TESTS = [
    test_saving_off_yields_a_temp_entry_per_present_stage,
    test_saving_on_every_wired_input_yields_output_entries_no_temp_duplicates,
    test_saving_on_shown_only_still_previews_the_other_compared_stage_via_temp,
    test_only_mid_present_yields_exactly_one_mid_entry,
    test_nothing_wired_yields_an_empty_list_no_exception,
    test_one_entry_list_with_no_metadata_falls_back_to_base_label,
    test_save_now_prefers_final_then_mid_then_base,
    test_save_now_falls_back_when_the_better_stages_are_absent,
    test_save_now_raises_a_readable_error_when_nothing_is_available,
    test_save_now_raises_when_the_source_file_is_no_longer_on_disk,
    test_save_now_reads_from_the_output_dir_for_an_already_saved_stage_temp_dir_otherwise,
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
