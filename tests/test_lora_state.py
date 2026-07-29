"""Plain-script tests for `Anima LoRA Loader`'s state normalization + trigger
assembly (`nodes/controls/_lora_helpers.py`'s `parse_state`/`row_*`/
`collect_triggers`) and the node's own frozen widget surface
(`nodes/controls/lora_loader.py`).

Deliberately does NOT exercise the apply step or the memory-mode cache --
those need a lazy `folder_paths`/`comfy.sd`/`comfy.utils` stub, covered
instead in `tests/test_lora_apply.py`.

Run directly: `python tests/test_lora_state.py` (no pytest, per project convention).
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.controls import _lora_helpers as lh
from nodes.controls.lora_loader import REQUIRED_KEY_ORDER, AnimaLoraLoader

# ---------------------------------------------------------------------------
# parse_state -- hostile-payload tolerance, unknown-key survival
# ---------------------------------------------------------------------------


def test_parse_state_round_trips_a_normal_payload():
    raw = json.dumps({
        "cacheMode": "all",
        "sep": " | ",
        "rows": [
            {"id": "r1", "name": "a.safetensors", "on": True, "sm": 0.8, "sc": 0.6, "triggers": ["foo"]},
        ],
    })
    state = lh.parse_state(raw)
    assert state["cacheMode"] == "all"
    assert state["sep"] == " | "
    assert len(state["rows"]) == 1
    assert state["rows"][0]["name"] == "a.safetensors"


def test_parse_state_hostile_blobs_never_raise_and_degrade_to_empty():
    for bad in ["{not json", "", "null", "42", "[1,2,3]", None, 123, ["a", "list"]]:
        state = lh.parse_state(bad)
        assert state == {"cacheMode": "last", "sep": ", ", "rows": []}, (bad, state)


def test_parse_state_rows_not_a_list_degrades_to_empty():
    state = lh.parse_state(json.dumps({"rows": "oops"}))
    assert state["rows"] == []


def test_parse_state_unknown_cache_mode_clamps_to_last():
    for bad_mode in ("fast", "", None, 42, ["last"]):
        state = lh.parse_state(json.dumps({"cacheMode": bad_mode, "rows": []}))
        assert state["cacheMode"] == "last", bad_mode


def test_parse_state_non_string_sep_defaults():
    state = lh.parse_state(json.dumps({"sep": 42, "rows": []}))
    assert state["sep"] == ", "


def test_parse_state_drops_non_dict_rows_and_nameless_rows():
    raw = json.dumps({"rows": [
        "not-a-dict",
        123,
        {"on": True},              # no "name" at all
        {"name": "", "on": True},  # empty name
        {"name": "   ", "on": True},  # whitespace-only name
        {"name": "keep.safetensors"},
    ]})
    state = lh.parse_state(raw)
    assert len(state["rows"]) == 1
    assert state["rows"][0]["name"] == "keep.safetensors"


def test_parse_state_unknown_row_keys_survive_a_round_trip():
    # THE contract this test exists for (module docstring): a row is kept
    # AS-IS, never rebuilt field-by-field, so a key this Python doesn't even
    # know about survives untouched.
    raw = json.dumps({"rows": [
        {"name": "a.safetensors", "on": True, "future_field": 42, "nested": {"x": 1}},
    ]})
    state = lh.parse_state(raw)
    row = state["rows"][0]
    assert row["future_field"] == 42
    assert row["nested"] == {"x": 1}


# ---------------------------------------------------------------------------
# row_* accessors -- missing-key defaults, hostile values
# ---------------------------------------------------------------------------


def test_row_is_on_defaults_true_when_missing():
    assert lh.row_is_on({"name": "a"}) is True
    assert lh.row_is_on({"name": "a", "on": False}) is False
    assert lh.row_is_on({"name": "a", "on": 0}) is False
    assert lh.row_is_on({"name": "a", "on": 1}) is True


def test_row_strengths_defaults_sm_to_1_and_sc_to_sm():
    assert lh.row_strengths({"name": "a"}) == (1.0, 1.0)
    assert lh.row_strengths({"name": "a", "sm": 0.5}) == (0.5, 0.5)
    assert lh.row_strengths({"name": "a", "sm": 0.5, "sc": 0.2}) == (0.5, 0.2)


def test_row_strengths_clamps_hostile_values():
    sm, sc = lh.row_strengths({"name": "a", "sm": float("inf"), "sc": float("nan")})
    assert sm == 1.0  # NaN/inf -> default
    assert sc == 1.0  # sc's own default mirrors sm's resolved (defaulted) value
    sm2, sc2 = lh.row_strengths({"name": "a", "sm": 1e12, "sc": -1e12})
    assert sm2 == 100.0  # clamped to the strength bound
    assert sc2 == -100.0


def test_row_triggers_tolerates_garbage():
    assert lh.row_triggers({"name": "a"}) == []
    assert lh.row_triggers({"name": "a", "triggers": "not-a-list"}) == []
    assert lh.row_triggers({"name": "a", "triggers": ["one", "", "  ", "two", None, 3]}) == ["one", "two", "3"]


# ---------------------------------------------------------------------------
# collect_triggers -- de-dup, order, separator
# ---------------------------------------------------------------------------


def test_collect_triggers_dedupes_case_insensitively_first_seen_wins():
    rows = [
        {"name": "a", "triggers": ["Foo", "bar"]},
        {"name": "b", "triggers": ["FOO", "baz"]},
    ]
    assert lh.collect_triggers(rows, ", ") == "Foo, bar, baz"


def test_collect_triggers_uses_given_separator():
    rows = [{"name": "a", "triggers": ["one", "two"]}]
    assert lh.collect_triggers(rows, " | ") == "one | two"


def test_collect_triggers_non_string_sep_defaults():
    rows = [{"name": "a", "triggers": ["one"]}]
    assert lh.collect_triggers(rows, None) == "one"


def test_collect_triggers_empty_rows_is_empty_string():
    assert lh.collect_triggers([], ", ") == ""


# ---------------------------------------------------------------------------
# AnimaLoraLoader -- frozen widget surface
# ---------------------------------------------------------------------------


def test_required_key_order_is_frozen():
    input_types = AnimaLoraLoader.INPUT_TYPES()
    assert tuple(input_types["required"].keys()) == REQUIRED_KEY_ORDER
    assert REQUIRED_KEY_ORDER == ("model", "lora_state")


def test_clip_is_optional_not_required():
    # A required socket hard-fails the queue the moment nothing is wired to
    # it (`.claude/CLAUDE.md`) -- clip MUST be optional.
    input_types = AnimaLoraLoader.INPUT_TYPES()
    assert "clip" not in input_types["required"]
    assert "clip" in input_types["optional"]
    assert input_types["optional"]["clip"][0] == "CLIP"


def test_lora_state_default_and_tooltip_present():
    input_types = AnimaLoraLoader.INPUT_TYPES()
    lora_state_spec = input_types["required"]["lora_state"]
    assert lora_state_spec[0] == "STRING"
    assert lora_state_spec[1]["default"] == "{}"
    assert lora_state_spec[1]["tooltip"]


def test_every_input_and_output_has_a_tooltip():
    input_types = AnimaLoraLoader.INPUT_TYPES()
    for group in ("required", "optional"):
        for key, spec in input_types[group].items():
            assert isinstance(spec, tuple) and len(spec) >= 2, key
            assert spec[1].get("tooltip"), f"{group}.{key} has no tooltip"
    assert len(AnimaLoraLoader.OUTPUT_TOOLTIPS) == len(AnimaLoraLoader.RETURN_TYPES)
    for tip in AnimaLoraLoader.OUTPUT_TOOLTIPS:
        assert tip


def test_category_and_experimental():
    assert AnimaLoraLoader.CATEGORY == "AnimaFlow/Controls"
    assert AnimaLoraLoader.EXPERIMENTAL is True


def test_return_shape():
    assert AnimaLoraLoader.RETURN_TYPES == ("MODEL", "CLIP", "STRING")
    assert AnimaLoraLoader.RETURN_NAMES == ("MODEL", "CLIP", "triggers")


ALL_TESTS = [
    test_parse_state_round_trips_a_normal_payload,
    test_parse_state_hostile_blobs_never_raise_and_degrade_to_empty,
    test_parse_state_rows_not_a_list_degrades_to_empty,
    test_parse_state_unknown_cache_mode_clamps_to_last,
    test_parse_state_non_string_sep_defaults,
    test_parse_state_drops_non_dict_rows_and_nameless_rows,
    test_parse_state_unknown_row_keys_survive_a_round_trip,
    test_row_is_on_defaults_true_when_missing,
    test_row_strengths_defaults_sm_to_1_and_sc_to_sm,
    test_row_strengths_clamps_hostile_values,
    test_row_triggers_tolerates_garbage,
    test_collect_triggers_dedupes_case_insensitively_first_seen_wins,
    test_collect_triggers_uses_given_separator,
    test_collect_triggers_non_string_sep_defaults,
    test_collect_triggers_empty_rows_is_empty_string,
    test_required_key_order_is_frozen,
    test_clip_is_optional_not_required,
    test_lora_state_default_and_tooltip_present,
    test_every_input_and_output_has_a_tooltip,
    test_category_and_experimental,
    test_return_shape,
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
