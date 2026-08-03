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
from src.anima.history import HistoryStore


def _install_fake_writers():
    """Swap `save_images`/`write_temp_stage_images` for fakes that record
    which stages they were asked to write and return ComfyUI-shaped entries
    without touching a disk or importing PIL. Returns `(calls, restore)`."""
    calls = {"save": [], "temp": [], "seed": []}
    originals = {"save": ph.save_images, "temp": ph.write_temp_stage_images}

    def fake_save_images(*, wired, stages_to_save, preview_settings, seed=0, prompt=None, extra_pnginfo=None):
        calls["save"].append(list(stages_to_save))
        calls["seed"].append(seed)
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
# `anima_seed` -- the bug this build fixes: "Save now"'s `%seed%` token
# always resolving to `0` (`docs/TODO.md`'s last Now item), because
# `nodes/anima/preview.py`'s `ui` payload never carried the seed it had
# already computed on every run (`extract_seed_from_prompt`, `preview.py:201`,
# before this fix). This exercises `AnimaPreview.preview()` directly (not
# through `_images_from`, since that helper only hands back
# `result["ui"]["anima_stages"]`) so it can read `result["ui"]["anima_seed"]`
# too -- the actual channel `js/anima/interaction.mjs`'s `handleExecuted`
# reads from.
# ---------------------------------------------------------------------------


def _run_preview_with_prompt(prompt, images=None, metadata_json="", save_enabled=False):
    """Same shape as `_images_from` (fake writers installed, every
    `INPUT_IS_LIST`-wrapped kwarg wrapped the way ComfyUI's own execution
    engine would) but returns the WHOLE `result["ui"]` dict, since this
    section needs `anima_seed` alongside `anima_stages`.

    `metadata_json` defaults to `""` (genuinely absent -- the pre-2026-08-03
    behaviour every existing caller in this section exercises); pass a real
    JSON string to drive the "prefers metadata_json's resolved seed" half of
    `resolve_preview_seed`. `save_enabled` defaults to `False` (the file-
    saving default) -- pass `True` for a test that also needs `calls["seed"]`
    (only populated when `save_images` actually runs) alongside `anima_seed`.
    """
    calls, restore = _install_fake_writers()
    try:
        node = AnimaPreview()
        state = {"save": {"enabled": True, "which": "every wired input"}} if save_enabled else {}
        result = node.preview(
            preview_state=[json.dumps(state)],
            images=list(images) if images else [],
            metadata_json=[metadata_json],
            prompt=[prompt],
            extra_pnginfo=[None],
        )
        return result["ui"], calls
    finally:
        restore()


def test_preview_ui_payload_carries_the_resolved_seed_as_a_one_element_string_list():
    # The two landmines this shape avoids (both already bitten by this repo
    # once, `preview.py`'s own doc comment): (1) a `ui` value must be a LIST,
    # never a bare scalar -- `f22b3c0`/`885410b`; (2) the seed must be a
    # decimal STRING, never a JSON number -- `717feaa`/design doc §8.
    prompt = {"7": {"class_type": "AnimaContextBridge", "inputs": {"seed": 42}}}
    ui, _ = _run_preview_with_prompt(prompt, images=["A"])
    assert ui["anima_seed"] == ["42"], "must be a ONE-ELEMENT LIST of a decimal STRING, not a bare int/str"
    assert isinstance(ui["anima_seed"], list)
    assert isinstance(ui["anima_seed"][0], str)


def test_preview_ui_payload_seed_survives_a_20_digit_value_byte_for_byte():
    # The precision case design doc §8 exists for: a real seed can reach
    # 2**64-1, past JS's Number.MAX_SAFE_INTEGER (2**53-1) -- this asserts
    # the STRING form is exact, not merely "close" (a float round-trip would
    # silently corrupt the tail digits).
    big_seed = 16963467365598029952  # from an actual run, design doc §8
    assert big_seed > 2 ** 53 - 1
    prompt = {"7": {"class_type": "AnimaContextBridge", "inputs": {"seed": big_seed}}}
    ui, _ = _run_preview_with_prompt(prompt, images=["A"])
    assert ui["anima_seed"] == [str(big_seed)]


def test_preview_ui_payload_falls_back_to_zero_with_no_prompt_seed_available():
    # `extract_seed_from_prompt`'s own pre-existing gap (unchanged by this
    # task, see its own docstring): no prompt at all still must not crash,
    # and still emits a real, well-shaped `anima_seed` entry.
    ui, _ = _run_preview_with_prompt(None, images=["A"])
    assert ui["anima_seed"] == ["0"]


# ---------------------------------------------------------------------------
# 2026-08-03 fix: the Preview's seed comes from `metadata_json`'s own
# RESOLVED `sampler.seed`, not the `AnimaContextBridge` prompt scan -- the
# scan is almost always empty once `seed` is wired (its own `forceInput=True`
# means the API-format graph's `inputs.seed` is a link, not a literal), which
# is exactly why the owner saw seed `0` in the history/save-filename/
# `anima_seed` payload while the settings JSON on the very same entry showed
# the real seed.
# ---------------------------------------------------------------------------


def test_preview_prefers_the_resolved_metadata_seed_over_the_prompt_scan():
    # A wired seed (as it is via the Control Panel in practice): the prompt
    # scan's own literal ("1", a hand-set widget value on the Bridge, e.g.
    # from a test harness) must NOT win once metadata_json carries the
    # ACTUAL resolved value the run used.
    prompt = {"7": {"class_type": "AnimaContextBridge", "inputs": {"seed": 1}}}
    metadata_json = json.dumps({"sampler": {"seed": 999888777, "steps": 20}})
    ui, _ = _run_preview_with_prompt(prompt, images=["A"], metadata_json=metadata_json)
    assert ui["anima_seed"] == ["999888777"]


def test_preview_metadata_seed_survives_a_20_digit_value_byte_for_byte():
    # Same precision case as the prompt-scan version above, but through the
    # metadata_json path this fix adds -- a real 20-digit seed must arrive
    # with every digit intact, never rounded through a float.
    big_seed = 16963467365598029952  # from an actual run, design doc §8
    assert big_seed > 2 ** 53 - 1
    metadata_json = json.dumps({"sampler": {"seed": big_seed}})
    ui, _ = _run_preview_with_prompt(None, images=["A"], metadata_json=metadata_json)
    assert ui["anima_seed"] == [str(big_seed)]


def test_preview_falls_back_to_prompt_scan_when_metadata_json_is_unparseable():
    prompt = {"7": {"class_type": "AnimaContextBridge", "inputs": {"seed": 55}}}
    for bad_metadata in ["", "not json", "{not json", json.dumps([1, 2, 3])]:
        ui, _ = _run_preview_with_prompt(prompt, images=["A"], metadata_json=bad_metadata)
        assert ui["anima_seed"] == ["55"], f"metadata_json={bad_metadata!r} should have fallen back"


def test_preview_falls_back_to_prompt_scan_when_metadata_has_no_sampler_seed():
    prompt = {"7": {"class_type": "AnimaContextBridge", "inputs": {"seed": 55}}}
    for metadata_json in [
        json.dumps({"stage_labels": ["base"]}),  # no `sampler` block at all.
        json.dumps({"sampler": {"steps": 20}}),  # `sampler` present, no `seed`.
        json.dumps({"sampler": {"seed": None}}),  # `seed` present but null.
        json.dumps({"sampler": {"seed": "garbage"}}),  # non-numeric.
    ]:
        ui, _ = _run_preview_with_prompt(prompt, images=["A"], metadata_json=metadata_json)
        assert ui["anima_seed"] == ["55"], f"metadata_json={metadata_json!r} should have fallen back, not yielded 'None'"


def test_preview_null_metadata_seed_falls_back_rather_than_yielding_the_string_none():
    # Regression-shaped: a naive `str(seed)` on a `None` metadata seed would
    # produce the literal string "None" -- assert that never happens.
    prompt = {"7": {"class_type": "AnimaContextBridge", "inputs": {"seed": 7}}}
    ui, _ = _run_preview_with_prompt(prompt, images=["A"], metadata_json=json.dumps({"sampler": {"seed": None}}))
    assert ui["anima_seed"] == ["7"]
    assert "None" not in ui["anima_seed"][0]


def test_preview_all_three_seed_consumers_see_the_same_resolved_value():
    # The task brief's "one variable, three payoffs": `save_images`'s own
    # `seed` kwarg (the `%seed%` filename token), the recorded history
    # entry's `seed`, and the `anima_seed` ui payload must all agree -- all
    # three were independently getting `0` before this fix.
    metadata_json = json.dumps({"sampler": {"seed": 424242, "steps": 20}})
    fake_store = HistoryStore()
    original_store = ph._HISTORY_STORE
    ph._HISTORY_STORE = fake_store
    try:
        ui, calls = _run_preview_with_prompt(None, images=["A"], metadata_json=metadata_json, save_enabled=True)
        assert ui["anima_seed"] == ["424242"]
        assert calls["seed"] == [424242], "save_images must see the SAME resolved int, not 0"
        recorded = fake_store.list_entries()
        assert len(recorded) == 1
        # `HistoryStore.record` always stringifies `seed` (its own "decimal
        # STRING, never a JSON number" contract) -- same resolved digits,
        # just stringified at that store's own boundary.
        assert recorded[0]["seed"] == "424242", "the history entry must carry the SAME resolved seed"
    finally:
        ph._HISTORY_STORE = original_store


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
        # Every save now gets a counter, starting at `_00001` (2026-08-02
        # reversal, `src/anima/preview_settings.py`'s `collision_suffixed_
        # filename`) -- even this, the first save into a fresh directory.
        assert result["filename"] == "final_42_00001.png"
        assert len(calls["write"]) == 1
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_save_now_accepts_the_posted_seed_as_a_string_and_survives_a_20_digit_value():
    # `js/anima/interaction.mjs` posts the seed as a decimal STRING (never a
    # JSON number -- design doc §8), and `resolve_seed_int` is the ONE point
    # it becomes an `int` again, right at this `format_filename` call --
    # asserts a >2**53 seed survives that round trip BYTE FOR BYTE, not
    # merely "close" (the whole point of keeping it a string end-to-end).
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, _ = _save_now_fakes(tmp_root)
        big_seed = "16963467365598029952"  # from an actual run, design doc §8
        result = ph.save_now(
            stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            preview_settings={"save": {"extension": "png", "path": "AnimaFlow", "filename": "%stage%_%seed%"}},
            seed=big_seed,
            **fakes,
        )
        assert result["filename"] == f"final_{big_seed}_00001.png"
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_save_now_hostile_seed_inputs_never_raise_and_still_produce_a_file():
    # The posted seed is attacker-shaped data from the browser's point of
    # view (absent/None/""/non-numeric/negative/float/a 40-digit
    # number/a dict) -- none of these may raise out of `save_now`, and every
    # one must still produce a file (`resolve_seed_int`'s own hostile-input
    # contract, reused rather than re-invented here).
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, _ = _save_now_fakes(tmp_root)
        hostile_seeds_expect_zero = [None, "", "not-a-seed", -5, {"a": 1}, [1, 2], "-1", -1]
        for bad in hostile_seeds_expect_zero:
            result = ph.save_now(
                stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
                preview_settings={"save": {"extension": "png", "path": "AnimaFlow", "filename": "%stage%_%seed%"}},
                seed=bad,
                **fakes,
            )
            assert result["filename"] == "final_0_00001.png", f"seed={bad!r} produced {result['filename']!r}"

        # A 40-digit number: no clamping, no crash, no corruption -- Python's
        # arbitrary precision carries it through exactly (unlike the JS
        # side, which is exactly why the seed must never touch a JS Number).
        forty_digit = "1" * 40
        result = ph.save_now(
            stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            preview_settings={"save": {"extension": "png", "path": "AnimaFlow", "filename": "%stage%_%seed%"}},
            seed=forty_digit,
            **fakes,
        )
        assert result["filename"] == f"final_{forty_digit}_00001.png"

        # Absent entirely -- `seed` not passed at all -- must fall back to
        # the function's own default (`0`) exactly like an explicit `None`.
        result = ph.save_now(
            stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            preview_settings={"save": {"extension": "png", "path": "AnimaFlow", "filename": "%stage%_%seed%"}},
            **fakes,
        )
        assert result["filename"] == "final_0_00001.png"
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


# ---------------------------------------------------------------------------
# `save.path` is honoured -- the owner's own reported symptom ("i changed the
# path but the path i gave doesn't have the image"). This drives `save_now`
# entirely through its own injected `output_dir_fn`/`write_fn` seams (this
# module's existing `_save_now_fakes` helper), so no PIL and no live
# `folder_paths` is needed -- if this passes, the settings ARE honoured
# correctly at this layer, and a report of the file landing elsewhere points
# upstream, at what the frontend actually posts as `preview_state`.
# ---------------------------------------------------------------------------


def test_save_now_honours_a_custom_save_path_subfolder():
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, calls = _save_now_fakes(tmp_root)
        output_dir = fakes["output_dir_fn"]()
        result = ph.save_now(
            stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            preview_settings={"save": {"extension": "png", "path": "my_custom_folder", "filename": "%stage%_%seed%"}},
            seed=7,
            **fakes,
        )
        expected_dir = os.path.join(output_dir, "my_custom_folder")
        assert result["subfolder"] == "my_custom_folder"
        assert result["filename"] == "final_7_00001.png"
        # The write itself landed under the custom subfolder, not the
        # default "AnimaFlow" one -- `write_fn`'s own recorded call is the
        # ground truth here, not just the returned dict.
        assert len(calls["write"]) == 1
        _source, dest = calls["write"][0]
        assert dest == os.path.join(expected_dir, "final_7_00001.png")
        assert os.path.dirname(dest) == expected_dir
        # The returned `path` -- this task's own "return the location, not
        # just the name" ask -- is the full absolute path actually written,
        # matching the injected writer's own destination exactly.
        assert result["path"] == dest
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def test_save_now_default_save_path_falls_back_to_animaflow_when_absent():
    tmp_root = tempfile.mkdtemp()
    try:
        fakes, calls = _save_now_fakes(tmp_root)
        output_dir = fakes["output_dir_fn"]()
        ph.save_now(
            stage_entries={"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            preview_settings={"save": {"extension": "png", "filename": "%stage%_%seed%"}},
            seed=1,
            **fakes,
        )
        _source, dest = calls["write"][0]
        assert dest == os.path.join(output_dir, "AnimaFlow", "final_1_00001.png")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


# ---------------------------------------------------------------------------
# Instrumentation -- `save_now` logs the absolute path via the pack's shared
# "Console logging" mechanism (`src/console_logging.py`), same setting
# `pipeline.py`/`preview.py` already use. Drives the level via the
# `ANIMAFLOW_DEBUG` env var (the documented override, `src/anima/logs.py`'s
# own docstring) so this test needs no `comfy.settings.json` on disk at all.
# ---------------------------------------------------------------------------


def test_save_now_logs_the_absolute_path_at_summary_and_debug_levels():
    tmp_root = tempfile.mkdtemp()
    original_env = dict(os.environ)
    recorded = []

    class _RecordingLogger:
        def info(self, message):
            recorded.append(message)

    original_logger = ph._logger
    try:
        ph._logger = _RecordingLogger()

        fakes, _ = _save_now_fakes(tmp_root)
        output_dir = fakes["output_dir_fn"]()
        expected_path = os.path.join(output_dir, "my_custom_folder", "final_9_00001.png")

        # "off" (no ANIMAFLOW_DEBUG, no comfy.settings.json reachable) --
        # genuinely silent.
        os.environ.pop("ANIMAFLOW_DEBUG", None)
        ph.save_now(
            stage_entries={"final": {"filename": "a.png", "subfolder": "", "type": "temp"}},
            preview_settings={"save": {"extension": "png", "path": "my_custom_folder", "filename": "%stage%_%seed%"}},
            seed=9,
            **fakes,
        )
        assert recorded == []

        # "debug" (ANIMAFLOW_DEBUG=1) -- both the summary line (absolute
        # path, unconditionally) and the extra debug line (resolved output
        # dir / save.path as received / template / source / final path).
        os.environ["ANIMAFLOW_DEBUG"] = "1"
        fakes2, _ = _save_now_fakes(tmp_root)
        ph.save_now(
            stage_entries={"final": {"filename": "a.png", "subfolder": "", "type": "temp"}},
            preview_settings={"save": {"extension": "png", "path": "my_custom_folder", "filename": "%stage%_%seed%"}},
            seed=9,
            **fakes2,
        )
        assert len(recorded) == 2
        summary_line, debug_line = recorded
        assert expected_path in summary_line or os.path.join(fakes2["output_dir_fn"](), "my_custom_folder", "final_9_00001.png") in summary_line
        assert "my_custom_folder" in debug_line
        assert "save.path as received" in debug_line
        assert "%stage%_%seed%" in debug_line
    finally:
        ph._logger = original_logger
        os.environ.clear()
        os.environ.update(original_env)
        shutil.rmtree(tmp_root, ignore_errors=True)


ALL_TESTS = [
    test_saving_off_yields_a_temp_entry_per_present_stage,
    test_saving_on_every_wired_input_yields_output_entries_no_temp_duplicates,
    test_saving_on_shown_only_still_previews_the_other_compared_stage_via_temp,
    test_only_mid_present_yields_exactly_one_mid_entry,
    test_nothing_wired_yields_an_empty_list_no_exception,
    test_one_entry_list_with_no_metadata_falls_back_to_base_label,
    test_preview_ui_payload_carries_the_resolved_seed_as_a_one_element_string_list,
    test_preview_ui_payload_seed_survives_a_20_digit_value_byte_for_byte,
    test_preview_ui_payload_falls_back_to_zero_with_no_prompt_seed_available,
    test_preview_prefers_the_resolved_metadata_seed_over_the_prompt_scan,
    test_preview_metadata_seed_survives_a_20_digit_value_byte_for_byte,
    test_preview_falls_back_to_prompt_scan_when_metadata_json_is_unparseable,
    test_preview_falls_back_to_prompt_scan_when_metadata_has_no_sampler_seed,
    test_preview_null_metadata_seed_falls_back_rather_than_yielding_the_string_none,
    test_preview_all_three_seed_consumers_see_the_same_resolved_value,
    test_save_now_prefers_final_then_mid_then_base,
    test_save_now_accepts_the_posted_seed_as_a_string_and_survives_a_20_digit_value,
    test_save_now_hostile_seed_inputs_never_raise_and_still_produce_a_file,
    test_save_now_falls_back_when_the_better_stages_are_absent,
    test_save_now_raises_a_readable_error_when_nothing_is_available,
    test_save_now_raises_when_the_source_file_is_no_longer_on_disk,
    test_save_now_reads_from_the_output_dir_for_an_already_saved_stage_temp_dir_otherwise,
    test_save_now_honours_a_custom_save_path_subfolder,
    test_save_now_default_save_path_falls_back_to_animaflow_when_absent,
    test_save_now_logs_the_absolute_path_at_summary_and_debug_levels,
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
