"""Plain-script tests for `src/anima/loras.py` (design doc §5b inline LoRA
normalization, ported+widened from upstream `_normalize_aio_lora_stack`).

Run directly: `python tests/test_anima_loras.py` (no pytest, per project convention).
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import loras as l

# ---------------------------------------------------------------------------
# Every input shape upstream accepts.
# ---------------------------------------------------------------------------


def test_dict_shape_standard_keys():
    entries = l.normalize_lora_stack([{"name": "foo.safetensors", "strength_model": 0.8, "strength_clip": 0.6}])
    assert entries == [{"name": "foo.safetensors", "strength_model": 0.8, "strength_clip": 0.6}]


def test_dict_shape_alternate_key_spellings():
    entries = l.normalize_lora_stack([
        {"lora": "a.safetensors", "model_strength": 0.5, "clip_strength": 0.4},
        {"lora_name": "b.safetensors", "strength": 0.7, "strengthTwo": 0.3},
    ])
    assert entries[0] == {"name": "a.safetensors", "strength_model": 0.5, "strength_clip": 0.4}
    assert entries[1] == {"name": "b.safetensors", "strength_model": 0.7, "strength_clip": 0.3}


def test_dict_shape_strength_clip_defaults_to_strength_model():
    entries = l.normalize_lora_stack([{"name": "a.safetensors", "strength_model": 0.9}])
    assert entries[0]["strength_clip"] == 0.9


def test_list_shape_three_element_tuple():
    entries = l.normalize_lora_stack([("a.safetensors", 0.8, 0.6)])
    assert entries == [{"name": "a.safetensors", "strength_model": 0.8, "strength_clip": 0.6}]


def test_json_string_input():
    raw = json.dumps([{"name": "a.safetensors", "strength_model": 1.0, "strength_clip": 1.0}])
    entries = l.normalize_lora_stack(raw)
    assert entries == [{"name": "a.safetensors", "strength_model": 1.0, "strength_clip": 1.0}]


def test_dunder_value_envelope():
    entries = l.normalize_lora_stack({"__value__": [{"name": "a.safetensors", "strength_model": 1.0}]})
    assert entries == [{"name": "a.safetensors", "strength_model": 1.0, "strength_clip": 1.0}]


def test_entries_named_empty_or_none_are_dropped():
    entries = l.normalize_lora_stack([
        {"name": "", "strength_model": 1.0},
        {"name": "none", "strength_model": 1.0},
        {"name": "NONE", "strength_model": 1.0},
        {"name": "  ", "strength_model": 1.0},
        {"name": "real.safetensors", "strength_model": 1.0},
    ])
    assert entries == [{"name": "real.safetensors", "strength_model": 1.0, "strength_clip": 1.0}]


def test_garbage_json_string_degrades_to_empty_list():
    assert l.normalize_lora_stack("{not json") == []
    assert l.normalize_lora_stack("null") == []


def test_non_list_root_degrades_to_empty_list():
    assert l.normalize_lora_stack({"not": "a list"}) == []
    assert l.normalize_lora_stack(42) == []
    assert l.normalize_lora_stack(None) == []


def test_items_of_unrecognized_shape_are_skipped():
    entries = l.normalize_lora_stack(["a bare string", 42, None, {"name": "ok.safetensors", "strength_model": 1.0}])
    assert entries == [{"name": "ok.safetensors", "strength_model": 1.0, "strength_clip": 1.0}]


def test_non_numeric_strengths_default_to_one():
    entries = l.normalize_lora_stack([{"name": "a.safetensors", "strength_model": "garbage"}])
    assert entries[0]["strength_model"] == 1.0
    assert entries[0]["strength_clip"] == 1.0


# ---------------------------------------------------------------------------
# The widened 2-tuple case -- design doc §5b's whole point.
# ---------------------------------------------------------------------------


def test_widened_two_tuple_case_not_dropped():
    # Upstream requires len(item) >= 3, silently dropping this entry entirely.
    entries = l.normalize_lora_stack([("a.safetensors", 0.75)])
    assert entries == [{"name": "a.safetensors", "strength_model": 0.75, "strength_clip": 0.75}]


def test_widened_two_element_list_not_tuple_also_accepted():
    entries = l.normalize_lora_stack([["a.safetensors", 0.5]])
    assert entries == [{"name": "a.safetensors", "strength_model": 0.5, "strength_clip": 0.5}]


def test_single_element_list_still_rejected_not_enough_info():
    entries = l.normalize_lora_stack([["a.safetensors"]])
    assert entries == []


# ---------------------------------------------------------------------------
# entries_to_apply -- both-zero-strength entries are skipped when building,
# but stay in the normalized list (muted, not deleted -- §5b).
# ---------------------------------------------------------------------------


def test_both_zero_strengths_are_skipped_when_building():
    entries = l.normalize_lora_stack([
        {"name": "muted.safetensors", "strength_model": 0, "strength_clip": 0},
        {"name": "active.safetensors", "strength_model": 0.8, "strength_clip": 0.8},
    ])
    assert len(entries) == 2  # both survive normalization
    applied = l.entries_to_apply(entries)
    assert len(applied) == 1
    assert applied[0]["name"] == "active.safetensors"


def test_one_zero_one_nonzero_strength_is_not_skipped():
    entries = l.normalize_lora_stack([{"name": "half.safetensors", "strength_model": 0, "strength_clip": 0.5}])
    applied = l.entries_to_apply(entries)
    assert len(applied) == 1  # only BOTH being zero skips it.


def test_entries_to_apply_hostile_input_never_raises():
    assert l.entries_to_apply(None) == []
    assert l.entries_to_apply("not-a-list") == []
    assert l.entries_to_apply(["not-a-dict", 42, None]) == []


def test_order_is_preserved():
    entries = l.normalize_lora_stack([
        {"name": "first.safetensors", "strength_model": 1.0},
        {"name": "second.safetensors", "strength_model": 1.0},
        {"name": "third.safetensors", "strength_model": 1.0},
    ])
    assert [e["name"] for e in entries] == ["first.safetensors", "second.safetensors", "third.safetensors"]


ALL_TESTS = [
    test_dict_shape_standard_keys,
    test_dict_shape_alternate_key_spellings,
    test_dict_shape_strength_clip_defaults_to_strength_model,
    test_list_shape_three_element_tuple,
    test_json_string_input,
    test_dunder_value_envelope,
    test_entries_named_empty_or_none_are_dropped,
    test_garbage_json_string_degrades_to_empty_list,
    test_non_list_root_degrades_to_empty_list,
    test_items_of_unrecognized_shape_are_skipped,
    test_non_numeric_strengths_default_to_one,
    test_widened_two_tuple_case_not_dropped,
    test_widened_two_element_list_not_tuple_also_accepted,
    test_single_element_list_still_rejected_not_enough_info,
    test_both_zero_strengths_are_skipped_when_building,
    test_one_zero_one_nonzero_strength_is_not_skipped,
    test_entries_to_apply_hostile_input_never_raises,
    test_order_is_preserved,
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
