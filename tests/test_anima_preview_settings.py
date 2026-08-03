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


def test_a_custom_save_path_round_trips_intact():
    # Regression test for the owner report ("i changed the path but the
    # path i gave doesn't have the image"): `_deep_merge_defaults` must only
    # fill in `save.path` when it's ABSENT from the raw blob -- a custom
    # value the user actually typed must survive `normalize_preview_settings`
    # byte-for-byte, never quietly replaced by the `"AnimaFlow"` default.
    raw = json.dumps({"save": {"path": "my_custom_folder"}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["save"]["path"] == "my_custom_folder"


def test_save_path_absent_from_the_raw_blob_defaults_to_animaflow():
    normalized = ps.normalize_preview_settings(json.dumps({"save": {}}))
    assert normalized["save"]["path"] == "AnimaFlow"


def test_save_path_survives_alongside_other_custom_save_fields():
    raw = json.dumps({
        "save": {"path": "shots/2026", "extension": "webp", "filename": "%stage%"},
    })
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["save"]["path"] == "shots/2026"
    assert normalized["save"]["extension"] == "webp"
    assert normalized["save"]["filename"] == "%stage%"


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


def test_bare_counter_token_substitutes_with_default_width_5():
    # 2026-08-03 fix: a bare `%counter%` (no `:N%` width) used to survive
    # literally into the filename -- now it substitutes, defaulting to 5
    # digits (matching `collision_suffixed_filename`'s own suffix width).
    result = ps.format_filename("shot_%counter%", stage="base", seed=0, width=1, height=1, counter=7, now=_FIXED_NOW)
    assert result == "shot_00007"


def test_bare_counter_token_pads_a_large_value_beyond_its_default_width():
    # `:05d`-style zfill only pads UP -- a value already wider than 5 digits
    # is never truncated.
    result = ps.format_filename("shot_%counter%", stage="base", seed=0, width=1, height=1, counter=123456, now=_FIXED_NOW)
    assert result == "shot_123456"


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
# the previous file). REVERSED 2026-08-02 (owner: "the save name is good but
# lets make sure by default we save with `<name>_00001`") from `40b3c9d`'s
# same-day "the first file at a given name keeps its plain name, unsuffixed"
# rule: there is no more unsuffixed case at all now -- EVERY `attempt` gets a
# zero-padded 5-digit counter BEFORE the extension, equal to `attempt + 1`
# (so `attempt=0` -> `_00001`, `attempt=1` -> `_00002`, ...).
# ---------------------------------------------------------------------------


def test_collision_suffixed_filename_first_attempt_is_00001():
    assert ps.collision_suffixed_filename("2026-07-29_42_final.png", 0) == "2026-07-29_42_final_00001.png"


def test_collision_suffixed_filename_second_attempt_is_00002():
    assert ps.collision_suffixed_filename("2026-07-29_42_final.png", 1) == "2026-07-29_42_final_00002.png"


def test_collision_suffixed_filename_third_attempt_is_00003():
    assert ps.collision_suffixed_filename("2026-07-29_42_final.png", 2) == "2026-07-29_42_final_00003.png"


def test_collision_suffixed_filename_preserves_extension():
    # The suffix goes BEFORE the extension, never after it.
    assert ps.collision_suffixed_filename("name.png", 0) == "name_00001.png"
    assert not ps.collision_suffixed_filename("name.png", 0).endswith(".png_00001")


def test_collision_suffixed_filename_handles_a_dotted_stem():
    # Only the LAST extension is treated as one -- `my.file.png`'s suffix
    # must land right before `.png`, not after the first dot.
    assert ps.collision_suffixed_filename("my.file.png", 0) == "my.file_00001.png"


def test_collision_suffixed_filename_no_extension_at_all():
    assert ps.collision_suffixed_filename("plain_name", 0) == "plain_name_00001"


def test_collision_suffixed_filename_owners_exact_case():
    # The owner's own example (2026-08-02): `panel_ep2` at attempts 0/1/2 now
    # reads `_00001`/`_00002`/`_00003` -- the counter is ALWAYS present,
    # including on the very first save (the reversal's whole point).
    assert ps.collision_suffixed_filename("panel_ep2.png", 0) == "panel_ep2_00001.png"
    assert ps.collision_suffixed_filename("panel_ep2.png", 1) == "panel_ep2_00002.png"
    assert ps.collision_suffixed_filename("panel_ep2.png", 2) == "panel_ep2_00003.png"


def test_collision_suffixed_filename_omit_at_zero_returns_plain_name_at_attempt_zero():
    # 2026-08-03 opt-out: a template with its own `%counter%` must not also
    # get our automatic `_00001` suffix -- attempt 0 is the plain name.
    assert ps.collision_suffixed_filename("shot_0007.png", 0, omit_at_zero=True) == "shot_0007.png"


def test_collision_suffixed_filename_omit_at_zero_still_suffixes_from_attempt_one():
    # The never-overwrite guarantee survives the opt-out: only attempt 0 is
    # unsuffixed, so a genuine collision still finds a free name.
    assert ps.collision_suffixed_filename("shot_0007.png", 1, omit_at_zero=True) == "shot_0007_00001.png"
    assert ps.collision_suffixed_filename("shot_0007.png", 2, omit_at_zero=True) == "shot_0007_00002.png"


def test_collision_suffixed_filename_omit_at_zero_defaults_to_false():
    # Every EXISTING call site that doesn't pass `omit_at_zero` keeps today's
    # unconditional-suffix behaviour exactly.
    assert ps.collision_suffixed_filename("panel_ep2.png", 0) == "panel_ep2_00001.png"


# ---------------------------------------------------------------------------
# template_has_counter_token -- the pre-substitution detector that decides
# whether a save opts out of the automatic `_00001` suffix (task: 2026-08-03).
# ---------------------------------------------------------------------------


def test_template_has_counter_token_detects_the_width_form():
    assert ps.template_has_counter_token("shot_%counter:4%") is True


def test_template_has_counter_token_detects_the_bare_form():
    assert ps.template_has_counter_token("shot_%counter%") is True


def test_template_has_counter_token_false_when_no_counter_present():
    assert ps.template_has_counter_token("%date:yyyy-MM-dd%_%seed%_%stage%") is False
    assert ps.template_has_counter_token("panel_ep2") is False


def test_template_has_counter_token_hostile_input_never_raises():
    assert ps.template_has_counter_token(None) is False
    assert ps.template_has_counter_token(123) is False


def test_collision_suffixed_filename_top_of_range_stays_5_digits():
    # `_MAX_COLLISION_ATTEMPTS = 10_000` (`nodes/anima/_preview_helpers.py`)
    # means the largest `attempt` the collision loop ever tries is 9999,
    # whose suffix is now `attempt + 1` = `10000` -- still exactly 5 digits
    # (`:05d` only pads UP to a minimum width, never truncates a longer
    # number), so the field still fits with no widening needed. Pinning this
    # so a future bump of that constant past 99999 can't silently widen the
    # field without a test noticing.
    assert ps.collision_suffixed_filename("name.png", 9999) == "name_10000.png"


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


def test_resolve_history_settings_snapshot_parses_and_stringifies_the_seed():
    metadata = json.dumps({
        "schema": "x", "version": 1, "stage_labels": ["base"],
        "sampler": {"seed": 16963467365598029952, "steps": 32},
    })
    snapshot = ps.resolve_history_settings_snapshot(metadata)
    assert snapshot["schema"] == "x"
    # A 20-digit int survives byte-for-byte as a STRING (never a JSON
    # number, same precision-safety rule as `anima_seed`/`sampler.seed`
    # elsewhere in this track).
    assert snapshot["sampler"]["seed"] == "16963467365598029952"
    assert isinstance(snapshot["sampler"]["seed"], str)
    assert snapshot["sampler"]["steps"] == 32


def test_resolve_history_settings_snapshot_never_mutates_its_input_string():
    # Parsing must not have any observable side effect on the caller's own
    # value -- `metadata_json` is a plain string here, so this is really
    # asserting idempotency/no-crash on repeated calls with the same input.
    metadata = json.dumps({"sampler": {"seed": 5}})
    first = ps.resolve_history_settings_snapshot(metadata)
    second = ps.resolve_history_settings_snapshot(metadata)
    assert first == second == {"sampler": {"seed": "5"}}


def test_resolve_history_settings_snapshot_missing_or_garbage_returns_none():
    assert ps.resolve_history_settings_snapshot(None) is None
    assert ps.resolve_history_settings_snapshot("") is None
    assert ps.resolve_history_settings_snapshot("not json") is None
    assert ps.resolve_history_settings_snapshot(json.dumps([1, 2, 3])) is None
    assert ps.resolve_history_settings_snapshot(12345) is None


def test_resolve_history_settings_snapshot_tolerates_a_missing_sampler_block():
    snapshot = ps.resolve_history_settings_snapshot(json.dumps({"stage_labels": ["base"]}))
    assert snapshot == {"stage_labels": ["base"]}


# ---------------------------------------------------------------------------
# resolve_preview_seed_from_metadata -- the 2026-08-03 fix: the Preview's
# seed comes from `metadata_json`'s own RESOLVED `sampler.seed`, not a
# literal-widget prompt scan (which is almost always empty once `seed` is
# wired, per `AnimaContextBridge`'s `forceInput=True`).
# ---------------------------------------------------------------------------


def test_resolve_preview_seed_from_metadata_reads_the_resolved_seed():
    metadata = json.dumps({"sampler": {"seed": 12345, "steps": 20}})
    assert ps.resolve_preview_seed_from_metadata(metadata) == 12345


def test_resolve_preview_seed_from_metadata_survives_a_20_digit_seed_exactly():
    # The case design doc §8 exists for: past JS's Number.MAX_SAFE_INTEGER,
    # but Python ints are arbitrary-precision -- this must come back with
    # every digit intact, not rounded.
    big_seed = 16963467365598029952
    metadata = json.dumps({"sampler": {"seed": big_seed}})
    resolved = ps.resolve_preview_seed_from_metadata(metadata)
    assert resolved == big_seed
    assert str(resolved) == "16963467365598029952"


def test_resolve_preview_seed_from_metadata_zero_is_a_real_seed_not_unavailable():
    # 0 is itself a valid literal seed -- must NOT be treated the same as
    # "unavailable" (that would make a real all-zeros seed indistinguishable
    # from the very bug this function fixes).
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"sampler": {"seed": 0}})) == 0


def test_resolve_preview_seed_from_metadata_missing_or_garbage_returns_none():
    for bad in [None, "", "not json", "{not json", json.dumps([1, 2, 3]), 12345]:
        assert ps.resolve_preview_seed_from_metadata(bad) is None


def test_resolve_preview_seed_from_metadata_no_sampler_block_returns_none():
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"stage_labels": ["base"]})) is None
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"sampler": "not-a-dict"})) is None


def test_resolve_preview_seed_from_metadata_null_or_non_numeric_seed_returns_none():
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"sampler": {"seed": None}})) is None
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"sampler": {}})) is None
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"sampler": {"seed": "not-a-number"}})) is None
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"sampler": {"seed": True}})) is None


def test_resolve_preview_seed_from_metadata_negative_seed_returns_none():
    # Shouldn't happen given pipeline.py's own resolve_seed_int, but a
    # hand-edited/garbage metadata_json is not this function's to trust --
    # never hand a nonsensical seed forward as if it were real.
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"sampler": {"seed": -1}})) is None


def test_resolve_preview_seed_from_metadata_accepts_a_numeric_string_seed():
    # Tolerant, matching resolve_seed_int's own leniency -- a numeric string
    # still parses to a real int.
    assert ps.resolve_preview_seed_from_metadata(json.dumps({"sampler": {"seed": "777"}})) == 777


ALL_TESTS = [
    test_defaults_shape,
    test_unknown_keys_survive,
    test_missing_keys_default,
    test_an_explicit_saved_true_survives_the_default_flip,
    test_an_explicit_saved_false_also_survives,
    test_garbage_compare_slot_falls_back_to_default,
    test_garbage_save_which_falls_back_to_shown,
    test_a_custom_save_path_round_trips_intact,
    test_save_path_absent_from_the_raw_blob_defaults_to_animaflow,
    test_save_path_survives_alongside_other_custom_save_fields,
    test_version_migrates_forward,
    test_hostile_input_never_raises,
    test_stage_and_seed_tokens,
    test_date_token_custom_format,
    test_date_token_with_time_components,
    test_counter_token_zero_padded,
    test_bare_counter_token_substitutes_with_default_width_5,
    test_bare_counter_token_pads_a_large_value_beyond_its_default_width,
    test_width_height_tokens,
    test_full_template_combining_every_token,
    test_template_with_no_tokens_passes_through_unchanged,
    test_hostile_template_never_raises,
    test_collision_suffixed_filename_first_attempt_is_00001,
    test_collision_suffixed_filename_second_attempt_is_00002,
    test_collision_suffixed_filename_third_attempt_is_00003,
    test_collision_suffixed_filename_preserves_extension,
    test_collision_suffixed_filename_handles_a_dotted_stem,
    test_collision_suffixed_filename_no_extension_at_all,
    test_collision_suffixed_filename_owners_exact_case,
    test_collision_suffixed_filename_omit_at_zero_returns_plain_name_at_attempt_zero,
    test_collision_suffixed_filename_omit_at_zero_still_suffixes_from_attempt_one,
    test_collision_suffixed_filename_omit_at_zero_defaults_to_false,
    test_template_has_counter_token_detects_the_width_form,
    test_template_has_counter_token_detects_the_bare_form,
    test_template_has_counter_token_false_when_no_counter_present,
    test_template_has_counter_token_hostile_input_never_raises,
    test_collision_suffixed_filename_top_of_range_stays_5_digits,
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
    test_resolve_history_settings_snapshot_parses_and_stringifies_the_seed,
    test_resolve_history_settings_snapshot_never_mutates_its_input_string,
    test_resolve_history_settings_snapshot_missing_or_garbage_returns_none,
    test_resolve_history_settings_snapshot_tolerates_a_missing_sampler_block,
    test_resolve_preview_seed_from_metadata_reads_the_resolved_seed,
    test_resolve_preview_seed_from_metadata_survives_a_20_digit_seed_exactly,
    test_resolve_preview_seed_from_metadata_zero_is_a_real_seed_not_unavailable,
    test_resolve_preview_seed_from_metadata_missing_or_garbage_returns_none,
    test_resolve_preview_seed_from_metadata_no_sampler_block_returns_none,
    test_resolve_preview_seed_from_metadata_null_or_non_numeric_seed_returns_none,
    test_resolve_preview_seed_from_metadata_negative_seed_returns_none,
    test_resolve_preview_seed_from_metadata_accepts_a_numeric_string_seed,
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
