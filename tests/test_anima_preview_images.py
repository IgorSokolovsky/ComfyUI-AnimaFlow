"""Plain-script tests for `AnimaPreview.preview()`'s actual `"ui": {"images":
[...]}}` payload -- the contract fixed in this build: saving OFF must not
mean the frontend's hover wipe gets zero images, and every entry must carry
a `stage` key so the wipe can tell which pane is which.

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


def _images_from(**wired_and_state):
    """Runs `AnimaPreview().preview(...)` with fake writers installed and
    returns the emitted `ui.images` list. `state` (a dict, JSON-encoded
    here) and `image_a`/`image_b`/`image_c` (any non-None sentinel counts as
    "wired") are passed straight through as kwargs."""
    state = wired_and_state.pop("state", {})
    calls, restore = _install_fake_writers()
    try:
        node = AnimaPreview()
        result = node.preview(preview_state=json.dumps(state), **wired_and_state)
        return result["ui"]["images"], calls
    finally:
        restore()


# ---------------------------------------------------------------------------
# Saving OFF -- the bug this build fixes: the wipe must still get an image
# for every wired stage.
# ---------------------------------------------------------------------------


def test_saving_off_yields_a_temp_entry_per_wired_stage():
    images, calls = _images_from(
        state={"save": {"enabled": False}},
        image_a="A", image_b="B", image_c="C",
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
        state={"save": {"enabled": True, "which": "every wired input"}},
        image_a="A", image_b="B", image_c="C",
    )
    assert len(images) == 3
    assert all(img["type"] == "output" for img in images)
    stages_seen = [img["stage"] for img in images]
    assert sorted(stages_seen) == ["base", "final", "mid"]
    assert len(stages_seen) == len(set(stages_seen)), "no stage should get two entries"
    assert calls["temp"] == [] or calls["temp"] == [[]]  # nothing left over for the temp writer


def test_saving_on_shown_only_still_previews_the_other_compared_stage_via_temp():
    # `which: "shown"` (the default) only SAVES compare.b ("final" here) --
    # but `base` is also wired and named by compare.a, so the wipe still
    # needs it: it must arrive as a TEMP entry, not be silently dropped.
    # This is the one test that asserts BOTH halves of the contract at once:
    # `which` still controls what's SAVED, while the PREVIEW set stays
    # "every wired stage" regardless.
    images, calls = _images_from(
        state={"save": {"enabled": True, "which": "shown"}, "compare": {"enabled": True, "a": "base", "b": "final"}},
        image_a="A", image_c="C",
    )
    by_stage = {img["stage"]: img for img in images}
    assert set(by_stage) == {"base", "final"}
    assert by_stage["final"]["type"] == "output"  # shown == compare.b == final -> actually saved
    assert by_stage["base"]["type"] == "temp"  # wired + compared, but not in save.which's scope
    assert calls["save"] == [["final"]]
    assert calls["temp"] == [["base"]]


# ---------------------------------------------------------------------------
# Single-socket and empty-graph edges.
# ---------------------------------------------------------------------------


def test_only_image_b_wired_yields_exactly_one_mid_entry():
    images, _ = _images_from(state={}, image_b="B")
    assert len(images) == 1
    assert images[0]["stage"] == "mid"


def test_nothing_wired_yields_an_empty_list_no_exception():
    images, calls = _images_from(state={})
    assert images == []
    assert calls["save"] == []
    assert calls["temp"] == []


ALL_TESTS = [
    test_saving_off_yields_a_temp_entry_per_wired_stage,
    test_saving_on_every_wired_input_yields_output_entries_no_temp_duplicates,
    test_saving_on_shown_only_still_previews_the_other_compared_stage_via_temp,
    test_only_image_b_wired_yields_exactly_one_mid_entry,
    test_nothing_wired_yields_an_empty_list_no_exception,
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
