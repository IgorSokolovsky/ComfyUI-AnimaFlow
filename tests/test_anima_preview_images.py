"""Plain-script tests for `AnimaPreview.preview()`'s actual `"ui": {"images":
[...]}}` payload -- the contract fixed in the original build: saving OFF must
not mean the frontend's hover wipe gets zero images, and every entry must
carry a `stage` key so the wipe can tell which pane is which.

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
import sys

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
        return result["ui"]["images"], calls
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


ALL_TESTS = [
    test_saving_off_yields_a_temp_entry_per_present_stage,
    test_saving_on_every_wired_input_yields_output_entries_no_temp_duplicates,
    test_saving_on_shown_only_still_previews_the_other_compared_stage_via_temp,
    test_only_mid_present_yields_exactly_one_mid_entry,
    test_nothing_wired_yields_an_empty_list_no_exception,
    test_one_entry_list_with_no_metadata_falls_back_to_base_label,
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
