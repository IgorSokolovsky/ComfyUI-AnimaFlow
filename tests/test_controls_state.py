"""Plain-script tests for the Control Panel + Loader Panel's state parsing/
coercion (`nodes/controls/_rows_helpers.py`) and the node classes' slot->
output mapping (`nodes/controls/control_panel.py`, `nodes/controls/
loader_panel.py`).

Deliberately does NOT exercise the loader-model kinds' actual loading -- that
needs a lazy `folder_paths`/`nodes` (ComfyUI's own) import, stubbed instead in
`tests/test_controls_loaders.py`.

Run directly: `python tests/test_controls_state.py` (no pytest, per project convention).
"""
from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.controls import _rows_helpers as rh
from nodes.controls.control_panel import MAX_ROWS as CONTROL_MAX_ROWS
from nodes.controls.control_panel import AnimaControlPanel
from nodes.controls.loader_panel import MAX_ROWS as LOADER_MAX_ROWS
from nodes.controls.loader_panel import AnimaLoaderPanel
from nodes.controls._type_helpers import ANY

# ---------------------------------------------------------------------------
# parse_state / rows_by_slot -- round-trip and hostile-payload shapes
# ---------------------------------------------------------------------------


def test_parse_state_round_trips_a_normal_payload():
    raw = json.dumps({
        "version": 1,
        "rows": [{"slot": 1, "kind": "int", "name": "steps", "value": 30, "opts": {}}],
    })
    state = rh.parse_state(raw)
    assert state["version"] == 1
    assert state["rows"] == [{"slot": 1, "kind": "int", "name": "steps", "value": 30, "opts": {}}]


def test_parse_state_bad_json_degrades_to_empty():
    for bad in ["{not json", "", "null", "42", "[1,2,3]", None, 123, ["a", "list"]]:
        state = rh.parse_state(bad)
        assert state == {"version": 1, "rows": []}, (bad, state)


def test_parse_state_rows_not_a_list_degrades_to_empty():
    state = rh.parse_state(json.dumps({"version": 1, "rows": "oops"}))
    assert state["rows"] == []


def test_parse_state_preserves_version_field():
    state = rh.parse_state(json.dumps({"version": 7, "rows": []}))
    assert state["version"] == 7


def test_rows_by_slot_maps_by_slot_not_display_order():
    rows = [
        {"slot": 3, "kind": "int", "value": 3},
        {"slot": 1, "kind": "int", "value": 1},
    ]
    slots = rh.rows_by_slot(rows, 16)
    assert slots[3]["value"] == 3
    assert slots[1]["value"] == 1
    assert 2 not in slots  # a gap in slot numbers is legal


def test_rows_by_slot_drops_slots_beyond_max_rows():
    rows = [{"slot": 17, "kind": "int", "value": 1}, {"slot": 16, "kind": "int", "value": 2}]
    slots = rh.rows_by_slot(rows, 16)
    assert 17 not in slots
    assert slots[16]["value"] == 2


def test_rows_by_slot_drops_slot_zero_and_negative():
    rows = [{"slot": 0, "kind": "int"}, {"slot": -1, "kind": "int"}]
    slots = rh.rows_by_slot(rows, 16)
    assert slots == {}


def test_rows_by_slot_hand_edited_garbage_types_are_dropped_not_fatal():
    rows = [
        "not a dict",
        42,
        None,
        {"slot": "not-a-number", "kind": "int"},
        {"kind": "int"},  # missing slot entirely
        {"slot": [1, 2], "kind": "int"},  # slot is a list, not int-coercible
        {"slot": 5, "kind": "int", "value": 9},  # the one good row
    ]
    slots = rh.rows_by_slot(rows, 16)
    assert slots == {5: {"slot": 5, "kind": "int", "value": 9}}


def test_rows_by_slot_string_slot_is_coerced():
    # A hand-edited payload might carry "slot": "4" instead of 4.
    rows = [{"slot": "4", "kind": "int", "value": 1}]
    slots = rh.rows_by_slot(rows, 16)
    assert 4 in slots


def test_rows_by_slot_duplicate_slot_last_one_wins():
    rows = [
        {"slot": 2, "kind": "int", "value": "first"},
        {"slot": 2, "kind": "int", "value": "second"},
    ]
    slots = rh.rows_by_slot(rows, 16)
    assert slots[2]["value"] == "second"


# ---------------------------------------------------------------------------
# Seed coercion -- the full hostile-input set from the spec.
# ---------------------------------------------------------------------------

SEED_MAX = 2**64 - 1


def test_coerce_seed_normal_string():
    assert rh.coerce_seed("1000000000000") == 1000000000000


def test_coerce_seed_max_value_string():
    assert rh.coerce_seed(str(SEED_MAX)) == SEED_MAX


def test_coerce_seed_overflow_clamps_to_max():
    assert rh.coerce_seed(str(SEED_MAX + 1)) == SEED_MAX
    assert rh.coerce_seed(str(SEED_MAX * 1000)) == SEED_MAX


def test_coerce_seed_400_digit_integer_clamps_not_crashes():
    huge = "9" * 400
    assert rh.coerce_seed(huge) == SEED_MAX


def test_coerce_seed_negative_clamps_to_zero():
    assert rh.coerce_seed("-5") == 0
    assert rh.coerce_seed(-5) == 0


def test_coerce_seed_infinity_and_nan_strings_default_to_zero():
    assert rh.coerce_seed("Infinity") == 0
    assert rh.coerce_seed("-Infinity") == 0
    assert rh.coerce_seed("NaN") == 0


def test_coerce_seed_float_infinity_and_nan_default_to_zero():
    assert rh.coerce_seed(float("inf")) == 0
    assert rh.coerce_seed(float("-inf")) == 0
    assert rh.coerce_seed(float("nan")) == 0


def test_coerce_seed_garbage_string_defaults_to_zero():
    assert rh.coerce_seed("not-a-seed") == 0
    assert rh.coerce_seed("") == 0
    assert rh.coerce_seed("   ") == 0


def test_coerce_seed_none_and_bool_default_to_zero():
    assert rh.coerce_seed(None) == 0
    assert rh.coerce_seed(True) == 0
    assert rh.coerce_seed(False) == 0


def test_coerce_seed_accepts_int_and_float_types_too():
    # The frontend always sends a string, but a hand-edited API payload could
    # legitimately carry a JSON number instead.
    assert rh.coerce_seed(12345) == 12345
    assert rh.coerce_seed(12345.0) == 12345


# ---------------------------------------------------------------------------
# int / float coercion
# ---------------------------------------------------------------------------


def test_coerce_int_rounds_and_casts():
    assert rh.coerce_int(30) == 30
    assert rh.coerce_int(29.6) == 30
    assert rh.coerce_int("29.6") == 30


def test_coerce_int_non_finite_defaults_to_zero():
    assert rh.coerce_int(float("inf")) == 0
    assert rh.coerce_int(float("nan")) == 0
    assert rh.coerce_int("garbage") == 0
    assert rh.coerce_int(None) == 0


def test_coerce_int_clamps_extreme_magnitude():
    assert rh.coerce_int(1e308) == int(1e12)
    assert rh.coerce_int(-1e308) == int(-1e12)


def test_coerce_float_passes_through_and_guards():
    assert rh.coerce_float(5.0) == 5.0
    assert rh.coerce_float("5.5") == 5.5
    assert rh.coerce_float(float("nan")) == 0.0
    assert rh.coerce_float("garbage") == 0.0


# ---------------------------------------------------------------------------
# value_for_row -- the non-latent, non-loader kinds
# ---------------------------------------------------------------------------


def test_value_for_row_sampler_and_scheduler_pass_through_string():
    assert rh.value_for_row({"kind": "sampler", "value": "euler_ancestral"}) == "euler_ancestral"
    assert rh.value_for_row({"kind": "scheduler", "value": "karras"}) == "karras"


def test_value_for_row_sampler_non_string_value_stringified():
    assert rh.value_for_row({"kind": "sampler", "value": 5}) == "5"
    assert rh.value_for_row({"kind": "sampler", "value": None}) == ""


def test_value_for_row_seed_int_float_use_their_coercers():
    assert rh.value_for_row({"kind": "seed", "value": "42"}) == 42
    assert rh.value_for_row({"kind": "int", "value": 3.7}) == 4
    assert rh.value_for_row({"kind": "float", "value": "5.5"}) == 5.5


def test_value_for_row_auto_and_garbage_kind_emit_zero():
    assert rh.value_for_row({"kind": "auto"}) == 0
    assert rh.value_for_row({"kind": "totally-unknown-kind"}) == 0
    assert rh.value_for_row(None) == 0
    assert rh.value_for_row("not-a-dict") == 0


# ---------------------------------------------------------------------------
# coerce_bool / value_for_row("bool") -- owner, 2026-08-02: "control panel
# needs a switch/boolean field"
# ---------------------------------------------------------------------------


def test_coerce_bool_real_bool_passes_through():
    assert rh.coerce_bool(True) is True
    assert rh.coerce_bool(False) is False


def test_coerce_bool_tolerates_string_true_false_any_case():
    assert rh.coerce_bool("true") is True
    assert rh.coerce_bool("TRUE") is True
    assert rh.coerce_bool("True") is True
    assert rh.coerce_bool("false") is False
    assert rh.coerce_bool("FALSE") is False
    assert rh.coerce_bool("") is False
    assert rh.coerce_bool("garbage") is False


def test_coerce_bool_tolerates_numeric_1_and_0():
    assert rh.coerce_bool(1) is True
    assert rh.coerce_bool(0) is False
    assert rh.coerce_bool(1.0) is True
    assert rh.coerce_bool(0.0) is False
    assert rh.coerce_bool(-5) is True  # any non-zero number is truthy


def test_coerce_bool_hostile_shapes_default_false_never_raise():
    assert rh.coerce_bool(None) is False
    assert rh.coerce_bool({}) is False
    assert rh.coerce_bool({"a": 1}) is False
    assert rh.coerce_bool([]) is False
    assert rh.coerce_bool([1, 2]) is False
    assert rh.coerce_bool(float("nan")) is False
    assert rh.coerce_bool(float("inf")) is False


def test_value_for_row_bool_returns_a_real_python_bool():
    for stored, expected in [
        (True, True),
        (False, False),
        ("true", True),
        ("false", False),
        (1, True),
        (0, False),
        (None, False),
        ({}, False),
    ]:
        result = rh.value_for_row({"kind": "bool", "value": stored})
        assert isinstance(result, bool), f"stored={stored!r}: expected a real bool, got {type(result).__name__}"
        assert result is expected, f"stored={stored!r}"


# ---------------------------------------------------------------------------
# Latent dims -- including a pair that matches no ratio at all (Custom mode).
# ---------------------------------------------------------------------------


def test_latent_wh_batch_defaults_when_opts_missing():
    assert rh.latent_wh_batch(None) == (rh.DEFAULT_LATENT_W, rh.DEFAULT_LATENT_H, rh.DEFAULT_LATENT_BATCH)
    assert rh.latent_wh_batch({}) == (rh.DEFAULT_LATENT_W, rh.DEFAULT_LATENT_H, rh.DEFAULT_LATENT_BATCH)


def test_latent_wh_batch_predefined_canonical_pair():
    w, h, batch = rh.latent_wh_batch({"mode": "predefined", "ratio": "2:3", "tier": 1024, "w": 832, "h": 1216, "batch": 1})
    assert (w, h, batch) == (832, 1216, 1)


def test_latent_wh_batch_custom_dims_matching_no_ratio_are_legal():
    # Custom mode is legal input even when the pair doesn't correspond to any
    # entry in the ratio table -- Python only cares about w/h/batch.
    w, h, batch = rh.latent_wh_batch({"mode": "custom", "w": 837, "h": 1201, "batch": 2})
    assert (w, h, batch) == (837, 1201, 2)


def test_latent_wh_batch_ignores_ratio_and_tier_mismatch():
    # ratio/tier say one thing, w/h say another -- w/h wins, per spec.
    w, h, batch = rh.latent_wh_batch({"ratio": "1:1", "tier": 512, "w": 1600, "h": 900, "batch": 1})
    assert (w, h, batch) == (1600, 900, 1)


def test_latent_wh_batch_clamps_hostile_values():
    w, h, batch = rh.latent_wh_batch({"w": 1e9, "h": -50, "batch": 999})
    assert w == rh._LATENT_MAX_DIM
    assert h == rh._LATENT_MIN_DIM
    assert batch == rh._LATENT_MAX_BATCH


def test_latent_wh_batch_non_finite_falls_back_to_default():
    w, h, batch = rh.latent_wh_batch({"w": float("nan"), "h": float("inf"), "batch": float("-inf")})
    assert (w, h, batch) == (rh.DEFAULT_LATENT_W, rh.DEFAULT_LATENT_H, rh.DEFAULT_LATENT_BATCH)


# ---------------------------------------------------------------------------
# AnimaControlPanel.run -- full slot->output mapping, including gaps,
# out-of-range slots, rows beyond MAX_ROWS, and a hand-edited payload.
# ---------------------------------------------------------------------------


def test_control_panel_max_rows_is_16():
    assert CONTROL_MAX_ROWS == 16


def test_control_panel_return_types_are_all_wildcard():
    assert AnimaControlPanel.RETURN_TYPES == (ANY,) * CONTROL_MAX_ROWS
    assert len(AnimaControlPanel.RETURN_NAMES) == CONTROL_MAX_ROWS
    assert AnimaControlPanel.RETURN_NAMES[0] == "value_1"
    assert AnimaControlPanel.RETURN_NAMES[-1] == f"value_{CONTROL_MAX_ROWS}"
    assert len(AnimaControlPanel.OUTPUT_TOOLTIPS) == CONTROL_MAX_ROWS
    assert AnimaControlPanel.CATEGORY == "AnimaFlow/Controls"
    # Graduated out of beta 2026-07-30 -- the attribute is absent, not False
    # (ComfyUI treats a missing attribute the same as falsy; see
    # tests/test_node_graduation.py for the pack-wide guard on this).
    assert not getattr(AnimaControlPanel, "EXPERIMENTAL", False)


def test_control_panel_input_types_declares_a_real_string_widget():
    input_types = AnimaControlPanel.INPUT_TYPES()
    assert "hidden" not in input_types, "panel_state must not be a `hidden` input (see the dynamic-node-frontend skill)"
    assert input_types["required"]["panel_state"][0] == "STRING"
    assert input_types["required"]["panel_state"][1]["default"] == "{}"
    assert "tooltip" in input_types["required"]["panel_state"][1]


def test_control_panel_run_slot_mapping_gaps_and_defaults():
    state = json.dumps({
        "version": 1,
        "rows": [
            {"slot": 3, "kind": "sampler", "value": "euler"},
            {"slot": 1, "kind": "seed", "value": "1000000000000"},
            {"slot": 16, "kind": "int", "value": 7},
        ],
    })
    out = AnimaControlPanel().run(state)
    assert len(out) == 16
    assert out[0] == 1000000000000  # slot 1
    assert out[1] == 0              # slot 2: no row, kind-appropriate zero
    assert out[2] == "euler"        # slot 3
    assert out[15] == 7             # slot 16
    for i in (3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13):
        assert out[i] == 0


def test_control_panel_run_slot_beyond_max_rows_is_dropped_not_fatal():
    state = json.dumps({"version": 1, "rows": [{"slot": 99, "kind": "int", "value": 5}]})
    out = AnimaControlPanel().run(state)
    assert len(out) == 16
    assert all(v == 0 for v in out)


def test_control_panel_run_latent_row_emits_real_latent_dict():
    # `_empty_latent` does a lazy `import torch` (control_panel.py) -- if this
    # dev machine has no torch installed (this repo's own test env doesn't;
    # a live ComfyUI process always does), skip rather than fail: the point
    # of the lazy import is precisely that this module doesn't need torch to
    # otherwise import and run.
    try:
        import torch  # noqa: F401
    except ModuleNotFoundError:
        print("SKIP  test_control_panel_run_latent_row_emits_real_latent_dict: torch not installed")
        return
    state = json.dumps({
        "version": 1,
        "rows": [{"slot": 5, "kind": "latent", "opts": {"w": 832, "h": 1216, "batch": 1}}],
    })
    out = AnimaControlPanel().run(state)
    latent = out[4]
    assert isinstance(latent, dict) and "samples" in latent
    samples = latent["samples"]
    assert list(samples.shape) == [1, 4, 1216 // 8, 832 // 8]


def test_control_panel_run_hand_edited_garbage_payload_degrades_gracefully():
    state = json.dumps({
        "rows": [
            "garbage-string-row",
            {"slot": "oops", "kind": "int", "value": 1},
            {"slot": 2, "kind": "int", "value": "not-a-number-but-fine"},
            {"slot": 2.9, "kind": "float", "value": 3.5},  # non-int slot, coerces to 2
        ],
    })
    out = AnimaControlPanel().run(state)
    assert len(out) == 16
    # slot 2 ends up claimed by the last row that resolves to it (float 3.5).
    assert out[1] == 3.5


def test_control_panel_run_default_empty_state():
    out = AnimaControlPanel().run("{}")
    assert out == tuple([0] * 16)


def test_control_panel_run_bool_row_emits_a_real_bool_and_leaves_return_types_wildcard():
    state = json.dumps({
        "version": 1,
        "rows": [
            {"slot": 1, "kind": "bool", "name": "flag", "value": True, "opts": {}},
            {"slot": 2, "kind": "bool", "name": "other", "value": "false", "opts": {}},
        ],
    })
    out = AnimaControlPanel().run(state)
    assert out[0] is True
    assert out[1] is False
    # RETURN_TYPES/RETURN_NAMES are unaffected by adding a new row kind --
    # still the fixed wildcard tuple (design doc §5: Python stays ANY for
    # every slot, the frontend narrows the wire type).
    assert AnimaControlPanel.RETURN_TYPES == (ANY,) * CONTROL_MAX_ROWS


# ---------------------------------------------------------------------------
# AnimaLoaderPanel -- shape only (loading itself is test_controls_loaders.py).
# ---------------------------------------------------------------------------


def test_loader_panel_max_rows_is_8():
    assert LOADER_MAX_ROWS == 8


def test_loader_panel_return_types_are_all_wildcard():
    assert AnimaLoaderPanel.RETURN_TYPES == (ANY,) * LOADER_MAX_ROWS
    assert len(AnimaLoaderPanel.RETURN_NAMES) == LOADER_MAX_ROWS
    assert len(AnimaLoaderPanel.OUTPUT_TOOLTIPS) == LOADER_MAX_ROWS
    assert AnimaLoaderPanel.CATEGORY == "AnimaFlow/Controls"
    # Graduated out of beta 2026-07-30 -- the attribute is absent, not False
    # (ComfyUI treats a missing attribute the same as falsy; see
    # tests/test_node_graduation.py for the pack-wide guard on this).
    assert not getattr(AnimaLoaderPanel, "EXPERIMENTAL", False)


def test_loader_panel_input_types_declares_a_real_string_widget():
    input_types = AnimaLoaderPanel.INPUT_TYPES()
    # `panel_state` itself must stay a REQUIRED, natively-serialized STRING --
    # not moved into `hidden` -- same contract as the Control Panel.
    assert input_types["required"]["panel_state"][0] == "STRING"
    assert input_types["required"]["panel_state"][1]["default"] == "{}"
    # The Loader Panel (only) also declares PROMPT/UNIQUE_ID -- purely to
    # scan for which output slots are wired (see loader_panel.py's
    # docstring for why this doesn't touch the node's cache signature).
    assert input_types["hidden"] == {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"}


def test_loader_panel_run_empty_state_all_zero():
    out = AnimaLoaderPanel().run("{}")
    assert out == tuple([0] * 8)


ALL_TESTS = [
    test_parse_state_round_trips_a_normal_payload,
    test_parse_state_bad_json_degrades_to_empty,
    test_parse_state_rows_not_a_list_degrades_to_empty,
    test_parse_state_preserves_version_field,
    test_rows_by_slot_maps_by_slot_not_display_order,
    test_rows_by_slot_drops_slots_beyond_max_rows,
    test_rows_by_slot_drops_slot_zero_and_negative,
    test_rows_by_slot_hand_edited_garbage_types_are_dropped_not_fatal,
    test_rows_by_slot_string_slot_is_coerced,
    test_rows_by_slot_duplicate_slot_last_one_wins,
    test_coerce_seed_normal_string,
    test_coerce_seed_max_value_string,
    test_coerce_seed_overflow_clamps_to_max,
    test_coerce_seed_400_digit_integer_clamps_not_crashes,
    test_coerce_seed_negative_clamps_to_zero,
    test_coerce_seed_infinity_and_nan_strings_default_to_zero,
    test_coerce_seed_float_infinity_and_nan_default_to_zero,
    test_coerce_seed_garbage_string_defaults_to_zero,
    test_coerce_seed_none_and_bool_default_to_zero,
    test_coerce_seed_accepts_int_and_float_types_too,
    test_coerce_int_rounds_and_casts,
    test_coerce_int_non_finite_defaults_to_zero,
    test_coerce_int_clamps_extreme_magnitude,
    test_coerce_float_passes_through_and_guards,
    test_value_for_row_sampler_and_scheduler_pass_through_string,
    test_value_for_row_sampler_non_string_value_stringified,
    test_value_for_row_seed_int_float_use_their_coercers,
    test_value_for_row_auto_and_garbage_kind_emit_zero,
    test_coerce_bool_real_bool_passes_through,
    test_coerce_bool_tolerates_string_true_false_any_case,
    test_coerce_bool_tolerates_numeric_1_and_0,
    test_coerce_bool_hostile_shapes_default_false_never_raise,
    test_value_for_row_bool_returns_a_real_python_bool,
    test_latent_wh_batch_defaults_when_opts_missing,
    test_latent_wh_batch_predefined_canonical_pair,
    test_latent_wh_batch_custom_dims_matching_no_ratio_are_legal,
    test_latent_wh_batch_ignores_ratio_and_tier_mismatch,
    test_latent_wh_batch_clamps_hostile_values,
    test_latent_wh_batch_non_finite_falls_back_to_default,
    test_control_panel_max_rows_is_16,
    test_control_panel_return_types_are_all_wildcard,
    test_control_panel_input_types_declares_a_real_string_widget,
    test_control_panel_run_slot_mapping_gaps_and_defaults,
    test_control_panel_run_slot_beyond_max_rows_is_dropped_not_fatal,
    test_control_panel_run_latent_row_emits_real_latent_dict,
    test_control_panel_run_hand_edited_garbage_payload_degrades_gracefully,
    test_control_panel_run_default_empty_state,
    test_control_panel_run_bool_row_emits_a_real_bool_and_leaves_return_types_wildcard,
    test_loader_panel_max_rows_is_8,
    test_loader_panel_return_types_are_all_wildcard,
    test_loader_panel_input_types_declares_a_real_string_widget,
    test_loader_panel_run_empty_state_all_zero,
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
