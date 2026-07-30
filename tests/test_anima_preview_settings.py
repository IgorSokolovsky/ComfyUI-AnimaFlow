"""Plain-script tests for `src/anima/preview_settings.py` (the Preview
node's own settings blob, design doc §8, its §7a filename-token formatter,
and the PURE stage-routing decisions -- `resolve_wired_stages`/
`resolve_shown_stage`/`resolve_save_stages`/`split_preview_stages` -- that
`nodes/anima/_preview_helpers.py`'s impure writers are driven by).

Run directly: `python tests/test_anima_preview_settings.py` (no pytest, per project convention).
"""
from __future__ import annotations

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import preview_settings as ps

# ---------------------------------------------------------------------------
# normalize_preview_settings -- same tolerant/additive contract as settings.py.
# ---------------------------------------------------------------------------


def test_defaults_shape():
    normalized = ps.normalize_preview_settings("{}")
    assert normalized["compare"]["enabled"] is True
    assert normalized["compare"]["a"] == "base"
    assert normalized["compare"]["b"] == "final"
    # Off by default (task item 6, flipped 2026-07-29) -- a brand-new
    # Preview node no longer writes into the user's output folder just by
    # existing; "Save now" (nodes/anima/_preview_helpers.py's save_now) is
    # the on-demand alternative.
    assert normalized["save"]["enabled"] is False


def test_unknown_keys_survive():
    raw = json.dumps({"a_future_field": 42})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["a_future_field"] == 42


def test_missing_keys_default():
    raw = json.dumps({"compare": {"a": "mid"}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["compare"]["a"] == "mid"
    assert normalized["compare"]["b"] == "final"  # default fills the rest.
    assert normalized["save"]["enabled"] is False


def test_an_explicit_saved_true_survives_the_default_flip():
    """The default flipping to `False` must never rewrite a workflow that
    already saved an explicit `true` -- `_deep_merge_defaults` only fills in
    a key ABSENT from the raw blob, so this is a genuine regression test for
    that contract, not just a restatement of `test_unknown_keys_survive`."""
    raw = json.dumps({"save": {"enabled": True}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["save"]["enabled"] is True


def test_an_explicit_saved_false_also_survives():
    raw = json.dumps({"save": {"enabled": False}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["save"]["enabled"] is False


def test_garbage_compare_slot_falls_back_to_default():
    raw = json.dumps({"compare": {"a": "not-a-real-stage", "b": "also-garbage"}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["compare"]["a"] == "base"
    assert normalized["compare"]["b"] == "final"


def test_garbage_save_which_falls_back_to_shown():
    raw = json.dumps({"save": {"which": "not-a-real-option"}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["save"]["which"] == "shown"


def test_version_migrates_forward():
    raw = json.dumps({"version": 0})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["version"] == ps.PREVIEW_SETTINGS_VERSION


def test_hostile_input_never_raises():
    for bad in ["{not json", "null", "[1,2,3]", None, 42, {"compare": None}, {"save": "not-a-dict"}]:
        normalized = ps.normalize_preview_settings(bad if not isinstance(bad, dict) else json.dumps(bad))
        assert isinstance(normalized, dict)
        assert isinstance(normalized["compare"], dict)
        assert isinstance(normalized["save"], dict)


# ---------------------------------------------------------------------------
# format_filename -- %stage%/%seed%/%date:FMT%/%counter:N%/%width%/%height%
# ---------------------------------------------------------------------------

_FIXED_NOW = datetime.datetime(2026, 7, 27, 13, 5, 9)


def test_stage_and_seed_tokens():
    result = ps.format_filename("%stage%_%seed%", stage="final", seed=12345, width=1024, height=1024, counter=0, now=_FIXED_NOW)
    assert result == "final_12345"


def test_date_token_custom_format():
    result = ps.format_filename("%date:yyyy-MM-dd%", stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW)
    assert result == "2026-07-27"


def test_date_token_with_time_components():
    result = ps.format_filename("%date:yyyy-MM-dd-HHmmss%", stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW)
    assert result == "2026-07-27-130509"


def test_counter_token_zero_padded():
    result = ps.format_filename("img_%counter:4%", stage="base", seed=0, width=1, height=1, counter=7, now=_FIXED_NOW)
    assert result == "img_0007"


def test_width_height_tokens():
    result = ps.format_filename("%width%x%height%", stage="base", seed=0, width=832, height=1216, counter=0, now=_FIXED_NOW)
    assert result == "832x1216"


def test_full_template_combining_every_token():
    result = ps.format_filename(
        "%date:yyyy-MM-dd%_%seed%_%stage%_%counter:3%_%width%x%height%",
        stage="mid", seed=99, width=512, height=768, counter=2, now=_FIXED_NOW,
    )
    assert result == "2026-07-27_99_mid_002_512x768"


def test_template_with_no_tokens_passes_through_unchanged():
    assert ps.format_filename("plain_name", stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW) == "plain_name"


def test_hostile_template_never_raises():
    assert isinstance(ps.format_filename(None, stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW), str)
    assert isinstance(ps.format_filename(123, stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW), str)


# ---------------------------------------------------------------------------
# collision_suffixed_filename -- the PURE half of the "never overwrite" fix
# (data-loss bug: a re-run with the same seed/day/stage silently clobbered
# the previous file). attempt=0 is always the plain name; attempt>=1 inserts
# a zero-padded 6-digit counter BEFORE the extension.
# ---------------------------------------------------------------------------


def test_collision_suffixed_filename_no_collision_keeps_plain_name():
    assert ps.collision_suffixed_filename("2026-07-29_42_final.png", 0) == "2026-07-29_42_final.png"


def test_collision_suffixed_filename_first_collision_is_000000():
    assert ps.collision_suffixed_filename("2026-07-29_42_final.png", 1) == "2026-07-29_42_final_000000.png"


def test_collision_suffixed_filename_second_collision_is_000001():
    assert ps.collision_suffixed_filename("2026-07-29_42_final.png", 2) == "2026-07-29_42_final_000001.png"


def test_collision_suffixed_filename_preserves_extension():
    # The suffix goes BEFORE the extension, never after it.
    assert ps.collision_suffixed_filename("name.png", 1) == "name_000000.png"
    assert not ps.collision_suffixed_filename("name.png", 1).endswith(".png_000000")


def test_collision_suffixed_filename_handles_a_dotted_stem():
    # Only the LAST extension is treated as one -- `my.file.png`'s suffix
    # must land right before `.png`, not after the first dot.
    assert ps.collision_suffixed_filename("my.file.png", 1) == "my.file_000000.png"


def test_collision_suffixed_filename_no_extension_at_all():
    assert ps.collision_suffixed_filename("plain_name", 1) == "plain_name_000000"


# ---------------------------------------------------------------------------
# Stage-routing -- resolve_wired_stages/resolve_shown_stage/resolve_save_stages/
# split_preview_stages. All pure: no comfy/torch import, `wired` is just a
# `{stage_name: tensor_or_None}` dict now (2026-07-28 reversal -- there is no
# socket name to stand in for a stage anymore, `AnimaPreview` builds this
# dict directly from stage LABELS, see `resolve_run_stage_labels` below).
# ---------------------------------------------------------------------------


def _wired(**kwargs):
    """`_wired(base=True, final=True)` -> the `wired` dict shape these
    functions expect (`None` for an absent stage, any truthy sentinel for a
    present one -- the functions only ever check `is not None`)."""
    sockets = {"base": None, "mid": None, "final": None}
    for key, value in kwargs.items():
        sockets[key] = value if value else "present"
    return sockets


def test_resolve_wired_stages_returns_only_wired_in_stable_order():
    assert ps.resolve_wired_stages(_wired()) == []
    assert ps.resolve_wired_stages(_wired(mid=True)) == ["mid"]
    assert ps.resolve_wired_stages(_wired(final=True, base=True)) == ["base", "final"]
    assert ps.resolve_wired_stages(_wired(base=True, mid=True, final=True)) == ["base", "mid", "final"]


def test_resolve_shown_stage_prefers_compare_b_then_falls_back_to_most_finished_wired():
    # compare.b present -> that's shown.
    assert ps.resolve_shown_stage({"enabled": True, "a": "base", "b": "final"}, _wired(base=True, final=True)) == "final"
    # compare.b named but NOT present -> falls back to most-finished present stage.
    assert ps.resolve_shown_stage({"enabled": True, "a": "base", "b": "final"}, _wired(base=True, mid=True)) == "mid"
    # compare off entirely -> same fallback priority.
    assert ps.resolve_shown_stage({"enabled": False, "a": "base", "b": "final"}, _wired(base=True)) == "base"
    # nothing present -> None, never raises.
    assert ps.resolve_shown_stage({"enabled": True, "a": "base", "b": "final"}, _wired()) is None


def test_resolve_shown_stage_one_entry_degrades_to_single_image():
    # Task brief: "a one-entry list degrades to single-image" -- the ONLY
    # present stage wins regardless of what compare.a/.b name.
    assert ps.resolve_shown_stage({"enabled": True, "a": "base", "b": "final"}, _wired(base=True)) == "base"
    assert ps.resolve_shown_stage({"enabled": True, "a": "base", "b": "final"}, _wired(mid=True)) == "mid"


def test_resolve_save_stages_which_semantics():
    wired = _wired(base=True, mid=True, final=True)
    compare = {"enabled": True, "a": "base", "b": "final"}

    assert ps.resolve_save_stages({"which": "every wired input"}, compare, wired) == ["base", "mid", "final"]
    assert ps.resolve_save_stages({"which": "both compared"}, compare, wired) == ["base", "final"]
    assert ps.resolve_save_stages({"which": "shown"}, compare, wired) == ["final"]
    # Garbage `which` falls back to "shown"'s behaviour, never raises.
    assert ps.resolve_save_stages({"which": "not-a-real-option"}, compare, wired) == ["final"]
    # "both compared" only returns stages that are ACTUALLY present.
    assert ps.resolve_save_stages({"which": "both compared"}, compare, _wired(base=True)) == ["base"]


# ---------------------------------------------------------------------------
# resolve_save_now_stage -- task item 6's "Save now" button: final -> mid ->
# base, whichever is actually present, and the fallback chain each rung down.
# ---------------------------------------------------------------------------


def test_resolve_save_now_stage_prefers_final_then_mid_then_base():
    assert ps.resolve_save_now_stage(["base", "mid", "final"]) == "final"
    assert ps.resolve_save_now_stage(["base", "final"]) == "final"
    assert ps.resolve_save_now_stage(["base", "mid"]) == "mid"
    assert ps.resolve_save_now_stage(["mid"]) == "mid"
    assert ps.resolve_save_now_stage(["base"]) == "base"


def test_resolve_save_now_stage_empty_or_garbage_returns_none():
    assert ps.resolve_save_now_stage([]) is None
    assert ps.resolve_save_now_stage(None) is None


# ---------------------------------------------------------------------------
# resolve_run_stage_labels -- the single pure place a run's images-list
# position -> stage-label mapping comes from (task brief).
# ---------------------------------------------------------------------------


def test_resolve_run_stage_labels_prefers_metadata_json_when_it_matches():
    metadata = json.dumps({"stage_labels": ["base", "final"]})
    assert ps.resolve_run_stage_labels(2, metadata) == ["base", "final"]


def test_resolve_run_stage_labels_falls_back_when_length_mismatches():
    # metadata says 3 stages, but only 1 image actually arrived -- don't
    # trust a mismatched record, fall back to the positional default.
    metadata = json.dumps({"stage_labels": ["base", "mid", "final"]})
    assert ps.resolve_run_stage_labels(1, metadata) == ["base"]


def test_resolve_run_stage_labels_falls_back_on_garbage_metadata():
    for bad in ["{not json", "null", "42", "", None, 123]:
        assert ps.resolve_run_stage_labels(2, bad) == ["base", "mid"]


def test_resolve_run_stage_labels_falls_back_when_stage_labels_missing_or_wrong_shape():
    assert ps.resolve_run_stage_labels(1, json.dumps({"no_stage_labels_here": True})) == ["base"]
    assert ps.resolve_run_stage_labels(2, json.dumps({"stage_labels": "not-a-list"})) == ["base", "mid"]
    assert ps.resolve_run_stage_labels(2, json.dumps({"stage_labels": [1, 2]})) == ["base", "mid"]


def test_resolve_run_stage_labels_zero_images_yields_empty_list():
    assert ps.resolve_run_stage_labels(0, None) == []


def test_split_preview_stages_routes_saved_stages_to_output_the_rest_to_temp():
    routing = ps.split_preview_stages(["base", "mid", "final"], ["final"])
    assert routing == {"output": ["final"], "temp": ["base", "mid"]}

    # Nothing saved (save off, or stages_to_save empty) -> everything previewed lands in temp.
    routing_none_saved = ps.split_preview_stages(["base", "final"], [])
    assert routing_none_saved == {"output": [], "temp": ["base", "final"]}

    # Every previewed stage also saved -> nothing left for temp.
    routing_all_saved = ps.split_preview_stages(["base", "final"], ["base", "final"])
    assert routing_all_saved == {"output": ["base", "final"], "temp": []}

    # A stage in `stages_to_save` that ISN'T in `preview_stages` (shouldn't
    # happen -- save_stages is itself derived from wired sockets -- but must
    # not fabricate a preview entry for it) never appears in either list.
    routing_extra_save = ps.split_preview_stages(["final"], ["base", "final"])
    assert routing_extra_save == {"output": ["final"], "temp": []}


ALL_TESTS = [
    test_defaults_shape,
    test_unknown_keys_survive,
    test_missing_keys_default,
    test_an_explicit_saved_true_survives_the_default_flip,
    test_an_explicit_saved_false_also_survives,
    test_garbage_compare_slot_falls_back_to_default,
    test_garbage_save_which_falls_back_to_shown,
    test_version_migrates_forward,
    test_hostile_input_never_raises,
    test_stage_and_seed_tokens,
    test_date_token_custom_format,
    test_date_token_with_time_components,
    test_counter_token_zero_padded,
    test_width_height_tokens,
    test_full_template_combining_every_token,
    test_template_with_no_tokens_passes_through_unchanged,
    test_hostile_template_never_raises,
    test_collision_suffixed_filename_no_collision_keeps_plain_name,
    test_collision_suffixed_filename_first_collision_is_000000,
    test_collision_suffixed_filename_second_collision_is_000001,
    test_collision_suffixed_filename_preserves_extension,
    test_collision_suffixed_filename_handles_a_dotted_stem,
    test_collision_suffixed_filename_no_extension_at_all,
    test_resolve_wired_stages_returns_only_wired_in_stable_order,
    test_resolve_shown_stage_prefers_compare_b_then_falls_back_to_most_finished_wired,
    test_resolve_shown_stage_one_entry_degrades_to_single_image,
    test_resolve_save_stages_which_semantics,
    test_resolve_save_now_stage_prefers_final_then_mid_then_base,
    test_resolve_save_now_stage_empty_or_garbage_returns_none,
    test_split_preview_stages_routes_saved_stages_to_output_the_rest_to_temp,
    test_resolve_run_stage_labels_prefers_metadata_json_when_it_matches,
    test_resolve_run_stage_labels_falls_back_when_length_mismatches,
    test_resolve_run_stage_labels_falls_back_on_garbage_metadata,
    test_resolve_run_stage_labels_falls_back_when_stage_labels_missing_or_wrong_shape,
    test_resolve_run_stage_labels_zero_images_yields_empty_list,
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
