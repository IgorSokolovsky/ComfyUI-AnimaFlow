"""Plain-script tests for `AnimaPromptStudio` and its pure
`_anima_prompt_studio_helpers` logic.

Run directly: `python tests/test_anima_prompt_studio.py` (no pytest, per
project convention). Covers: `parse_blocks_state`'s tolerant-parse contract
(never raises on bad input), `assemble_pane_segments`'s position-preserving
pin/rest placeholder algorithm, `substitute_rest`'s splice-and-join, the
`build_prompt_studio_output` orchestrator's byte-identical passthrough when
correction is off vs. a REAL (unmocked) `_rules_helpers.run_rules` call
against `rules/celica.yaml` when it's on, `IS_CHANGED` digesting (including
the sheet-digest hot-reload trick, reusing `_rules_helpers.sheet_digests`
directly), and the node's `INPUT_TYPES` tooltip contract.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima_prompt import _anima_prompt_studio_helpers as psh
from nodes.anima_prompt import _rules_helpers as rh
from nodes.anima_prompt.node_anima_prompt_studio import AnimaPromptStudio

RULES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rules")


def block(id_="b1", type_="general", label="Label", text="some text", enabled=True, pin=False):
    return {"id": id_, "type": type_, "label": label, "text": text, "enabled": enabled, "pin": pin}


# ---------------------------------------------------------------------------
# parse_blocks_state
# ---------------------------------------------------------------------------

def test_parse_blocks_state_valid_json():
    raw = json.dumps({
        "positive": [block("p1", "quality", "Q", "masterpiece")],
        "negative": [block("n1", "general", "N", "blurry")],
    })
    state = psh.parse_blocks_state(raw)
    assert [b["id"] for b in state["positive"]] == ["p1"]
    assert [b["id"] for b in state["negative"]] == ["n1"]


def test_parse_blocks_state_malformed_json_does_not_raise():
    state = psh.parse_blocks_state("{not valid json")
    assert state == {"positive": [], "negative": []}


def test_parse_blocks_state_empty_string_does_not_raise():
    state = psh.parse_blocks_state("")
    assert state == {"positive": [], "negative": []}


def test_parse_blocks_state_none_does_not_raise():
    state = psh.parse_blocks_state(None)
    assert state == {"positive": [], "negative": []}


def test_parse_blocks_state_json_list_instead_of_object_falls_back():
    state = psh.parse_blocks_state(json.dumps([1, 2, 3]))
    assert state == {"positive": [], "negative": []}


def test_parse_blocks_state_json_string_instead_of_object_falls_back():
    state = psh.parse_blocks_state(json.dumps("just a string"))
    assert state == {"positive": [], "negative": []}


def test_parse_blocks_state_json_number_instead_of_object_falls_back():
    state = psh.parse_blocks_state(json.dumps(42))
    assert state == {"positive": [], "negative": []}


def test_parse_blocks_state_missing_keys_default_to_empty_lists():
    state = psh.parse_blocks_state(json.dumps({}))
    assert state == {"positive": [], "negative": []}


def test_parse_blocks_state_missing_positive_key_only():
    state = psh.parse_blocks_state(json.dumps({"negative": [block("n1")]}))
    assert state["positive"] == []
    assert len(state["negative"]) == 1


def test_parse_blocks_state_unknown_type_normalized_to_general():
    state = psh.parse_blocks_state(json.dumps({
        "positive": [{"id": "p1", "type": "mystery", "text": "x"}],
        "negative": [],
    }))
    assert state["positive"][0]["type"] == "general"


def test_parse_blocks_state_missing_enabled_pin_text_label_defaulted():
    state = psh.parse_blocks_state(json.dumps({
        "positive": [{"id": "p1", "type": "quality"}],
        "negative": [],
    }))
    b = state["positive"][0]
    assert b["enabled"] is True
    assert b["pin"] is False
    assert b["text"] == ""
    assert b["label"] == ""


def test_parse_blocks_state_non_dict_pane_entry_is_dropped():
    state = psh.parse_blocks_state(json.dumps({
        "positive": [block("p1"), "not-a-dict", 42, None],
        "negative": [],
    }))
    assert [b["id"] for b in state["positive"]] == ["p1"]


# ---------------------------------------------------------------------------
# assemble_pane_segments
# ---------------------------------------------------------------------------

def test_assemble_pin_before_rest():
    blocks = [
        block("p1", text="pinned-a", pin=True),
        block("p2", text="rest-a"),
        block("p3", text="rest-b"),
    ]
    segments, rest_raw = psh.assemble_pane_segments(blocks, ", ")
    assert segments == [("pin", "pinned-a"), ("rest", None)]
    assert rest_raw == "rest-a, rest-b"


def test_assemble_pin_after_rest():
    blocks = [
        block("p1", text="rest-a"),
        block("p2", text="rest-b"),
        block("p3", text="pinned-a", pin=True),
    ]
    segments, rest_raw = psh.assemble_pane_segments(blocks, ", ")
    assert segments == [("rest", None), ("pin", "pinned-a")]
    assert rest_raw == "rest-a, rest-b"


def test_assemble_pin_interleaved_both_sides_of_rest_preserves_position():
    blocks = [
        block("p1", text="pin-1", pin=True),
        block("p2", text="rest-a"),
        block("p3", text="pin-2", pin=True),
        block("p4", text="rest-b"),
        block("p5", text="pin-3", pin=True),
    ]
    segments, rest_raw = psh.assemble_pane_segments(blocks, ", ")
    # Only ONE rest placeholder, at the position of the FIRST non-pinned
    # block; every non-pinned block's text (wherever it appears) folds into
    # that one placeholder instead of getting its own segment.
    assert segments == [
        ("pin", "pin-1"),
        ("rest", None),
        ("pin", "pin-2"),
        ("pin", "pin-3"),
    ]
    assert rest_raw == "rest-a, rest-b"


def test_assemble_disabled_blocks_skipped():
    blocks = [
        block("p1", text="visible"),
        block("p2", text="hidden", enabled=False),
    ]
    segments, rest_raw = psh.assemble_pane_segments(blocks, ", ")
    assert segments == [("rest", None)]
    assert rest_raw == "visible"


def test_assemble_blank_text_blocks_skipped():
    blocks = [
        block("p1", text="   "),
        block("p2", text=""),
        block("p3", text="kept"),
    ]
    segments, rest_raw = psh.assemble_pane_segments(blocks, ", ")
    assert segments == [("rest", None)]
    assert rest_raw == "kept"


def test_assemble_blank_pinned_block_skipped_too():
    blocks = [
        block("p1", text="  ", pin=True),
        block("p2", text="kept"),
    ]
    segments, rest_raw = psh.assemble_pane_segments(blocks, ", ")
    assert segments == [("rest", None)]
    assert rest_raw == "kept"


def test_assemble_empty_pane():
    segments, rest_raw = psh.assemble_pane_segments([], ", ")
    assert segments == []
    assert rest_raw == ""


def test_assemble_all_blocks_pinned_no_rest_placeholder():
    blocks = [
        block("p1", text="a", pin=True),
        block("p2", text="b", pin=True),
    ]
    segments, rest_raw = psh.assemble_pane_segments(blocks, ", ")
    assert segments == [("pin", "a"), ("pin", "b")]
    assert rest_raw == ""


def test_assemble_all_blocks_non_pinned():
    blocks = [
        block("p1", text="a"),
        block("p2", text="b"),
    ]
    segments, rest_raw = psh.assemble_pane_segments(blocks, ", ")
    assert segments == [("rest", None)]
    assert rest_raw == "a, b"


def test_assemble_space_separator_no_hardcoded_comma_splitting():
    blocks = [block("p1", text="a"), block("p2", text="b")]
    segments, rest_raw = psh.assemble_pane_segments(blocks, " ")
    assert rest_raw == "a b"


def test_assemble_newline_separator_no_hardcoded_comma_splitting():
    blocks = [block("p1", text="a"), block("p2", text="b")]
    segments, rest_raw = psh.assemble_pane_segments(blocks, "\n")
    assert rest_raw == "a\nb"


# ---------------------------------------------------------------------------
# substitute_rest
# ---------------------------------------------------------------------------

def test_substitute_rest_empty_rest_corrected_omits_segment():
    segments = [("pin", "keep-a"), ("rest", None), ("pin", "keep-b")]
    result = psh.substitute_rest(segments, "", ", ")
    assert result == "keep-a, keep-b"


def test_substitute_rest_blank_rest_corrected_omits_segment():
    segments = [("pin", "keep-a"), ("rest", None)]
    result = psh.substitute_rest(segments, "   ", ", ")
    assert result == "keep-a"


def test_substitute_rest_join_skips_blank_segments():
    segments = [("pin", ""), ("rest", None), ("pin", "keep")]
    result = psh.substitute_rest(segments, "corrected", ", ")
    assert result == "corrected, keep"


def test_substitute_rest_no_rest_placeholder_is_a_no_op_for_rest_corrected():
    segments = [("pin", "a"), ("pin", "b")]
    result = psh.substitute_rest(segments, "should be ignored", ", ")
    assert result == "a, b"


def test_substitute_rest_honors_separator():
    segments = [("pin", "a"), ("rest", None), ("pin", "b")]
    result = psh.substitute_rest(segments, "corrected", "\n")
    assert result == "a\ncorrected\nb"


def test_substitute_rest_strips_rest_corrected_whitespace():
    segments = [("rest", None)]
    result = psh.substitute_rest(segments, "  padded  ", ", ")
    assert result == "padded"


# ---------------------------------------------------------------------------
# build_prompt_studio_output
# ---------------------------------------------------------------------------

def _state_json(positive, negative):
    return json.dumps({"positive": positive, "negative": negative})


def test_build_output_correction_disabled_is_byte_identical_passthrough():
    raw = _state_json(
        [block("p1", text="a"), block("p2", text="b", pin=True), block("p3", text="c")],
        [block("n1", text="blurry")],
    )
    pos, neg = psh.build_prompt_studio_output(raw, ", ", rules_correction_enabled=False)
    # No engine involvement at all. The non-pinned "rest" placeholder sits
    # at the position of the FIRST non-pinned block ("a"), folding every
    # non-pinned block's text (here also "c") into that one spot; the
    # pinned block "b" is emitted verbatim at its own position, after the
    # rest placeholder in this layout — see `assemble_pane_segments`'s
    # single-rest-placeholder contract.
    assert pos == "a, c, b"
    assert neg == "blurry"


def test_build_output_correction_disabled_matches_manual_assembly_for_any_state():
    raw = _state_json(
        [block("p1", text="masterpiece"), block("p2", text="1girl")],
        [block("n1", text="worst quality")],
    )
    pos, neg = psh.build_prompt_studio_output(raw, ", ", rules_correction_enabled=False)
    assert pos == "masterpiece, 1girl"
    assert neg == "worst quality"


ANIMA_POS = (
    "[quality] masterpiece, best quality\n"
    "[character:celica]\n"
    "appearance:\n"
    "clothes: jacket\n"
    "action:\n"
    "focus: celica, jacket\n"
)
ANIMA_NEG = "sketch"


def test_build_output_correction_enabled_real_engine_pin_survives_verbatim():
    # A pinned LoRA-trigger-style block that must never be touched by the
    # engine, positioned BEFORE the celica-fixture text (the "rest").
    raw = _state_json(
        [
            block("p1", type_="trigger", text="ohwx_style_trigger_do_not_touch", pin=True),
            block("p2", type_="general", text=ANIMA_POS),
        ],
        [block("n1", text=ANIMA_NEG)],
    )
    pos, neg = psh.build_prompt_studio_output(
        raw, ", ", rules_correction_enabled=True, rules_profile="anima", rules_sheets="celica",
    )
    # Pinned text survives verbatim, at the front (its own position).
    assert pos.startswith("ohwx_style_trigger_do_not_touch")
    # Non-pinned "rest" (the celica fixture text) got REAL correction from
    # the unmocked engine (mirrors test_prompt_rules.py's own assertions).
    assert "short black hair" in pos, pos
    assert "pixie cut" in pos, pos
    assert "blue eyes" in pos, pos
    assert "black leather jacket" in pos, pos
    assert "blurry" in neg, neg


def test_build_output_correction_enabled_no_rest_text_skips_engine_call_but_still_returns_pins():
    raw = _state_json(
        [block("p1", text="pinned-only", pin=True)],
        [block("n1", text="", pin=False)],
    )
    pos, neg = psh.build_prompt_studio_output(raw, ", ", rules_correction_enabled=True, rules_sheets="celica")
    assert pos == "pinned-only"
    assert neg == ""


# ---------------------------------------------------------------------------
# IS_CHANGED
# ---------------------------------------------------------------------------

def test_is_changed_digest_changes_with_blocks_state():
    d1 = psh.is_changed_digest(_state_json([block("p1", text="a")], []), ", ")
    d2 = psh.is_changed_digest(_state_json([block("p1", text="b")], []), ", ")
    assert d1 != d2


def test_is_changed_digest_changes_with_separator():
    raw = _state_json([block("p1", text="a")], [])
    d1 = psh.is_changed_digest(raw, ", ")
    d2 = psh.is_changed_digest(raw, " ")
    assert d1 != d2


def test_is_changed_digest_changes_with_rules_profile():
    raw = _state_json([block("p1", text="a")], [])
    d1 = psh.is_changed_digest(raw, ", ", True, "anima", "celica")
    d2 = psh.is_changed_digest(raw, ", ", True, "illustrious", "celica")
    assert d1 != d2


def test_is_changed_digest_changes_with_rules_sheets():
    raw = _state_json([block("p1", text="a")], [])
    d1 = psh.is_changed_digest(raw, ", ", True, "anima", "celica")
    d2 = psh.is_changed_digest(raw, ", ", True, "anima", "*")
    assert d1 != d2


def test_is_changed_digest_changes_with_rules_correction_enabled_flag():
    raw = _state_json([block("p1", text="a")], [])
    d1 = psh.is_changed_digest(raw, ", ", False, "anima", "celica")
    d2 = psh.is_changed_digest(raw, ", ", True, "anima", "celica")
    assert d1 != d2


def test_is_changed_digest_changes_when_a_referenced_sheet_files_digest_changes():
    # Reuses `_rules_helpers.sheet_digests` directly (per the class contract)
    # -- prove the hot-reload trick actually works end to end by writing a
    # scratch sheet file into rules/, taking the digest, touching its
    # content (changes size -> changes `sheet_digests`), and confirming the
    # node-level digest changed too. Cleaned up in `finally`.
    scratch_name = "zz_prompt_studio_scratch_sheet"
    scratch_path = os.path.join(RULES_DIR, f"{scratch_name}.yaml")
    raw = _state_json([block("p1", text="a")], [])
    try:
        with open(scratch_path, "w", encoding="utf-8") as f:
            f.write("version: 1\nrules: []\n")
        before = psh.is_changed_digest(raw, ", ", True, "anima", scratch_name)

        with open(scratch_path, "w", encoding="utf-8") as f:
            f.write("version: 1\nrules: []\n# a comment to change the file size\n")
        after = psh.is_changed_digest(raw, ", ", True, "anima", scratch_name)

        assert before != after
        # Cross-check against the raw helper directly, per the "reuse, don't
        # re-derive" contract.
        assert rh.sheet_digests(scratch_name) != ""
    finally:
        if os.path.exists(scratch_path):
            os.remove(scratch_path)


def test_node_is_changed_matches_helper_digest():
    raw = _state_json([block("p1", text="a")], [])
    expected = psh.is_changed_digest(raw, ", ", False, "anima", "*")
    actual = AnimaPromptStudio.IS_CHANGED(raw, ", ", False, "anima", "*")
    assert actual == expected


# ---------------------------------------------------------------------------
# INPUT_TYPES tooltip contract
# ---------------------------------------------------------------------------

def test_node_input_types_contract():
    spec = AnimaPromptStudio.INPUT_TYPES()
    required = spec["required"]
    optional = spec.get("optional", {})

    assert set(required.keys()) == {"blocks_state", "separator", "rules_correction_enabled"}
    assert set(optional.keys()) == {"rules_profile", "rules_sheets"}

    for name, (_type, options) in {**required, **optional}.items():
        tooltip = options.get("tooltip")
        assert tooltip, f"{name} is missing a tooltip"
        assert len(tooltip) > len(name) + 10, f"{name}'s tooltip looks like a restated name: {tooltip!r}"
        assert name.replace("_", " ") != tooltip.lower(), f"{name}'s tooltip just restates the name"

    assert AnimaPromptStudio.RETURN_TYPES == ("STRING", "STRING")
    assert AnimaPromptStudio.RETURN_NAMES == ("positive", "negative")
    assert len(AnimaPromptStudio.OUTPUT_TOOLTIPS) == 2
    for tooltip in AnimaPromptStudio.OUTPUT_TOOLTIPS:
        assert tooltip and len(tooltip) > 20


def test_node_category_and_function():
    assert AnimaPromptStudio.CATEGORY == "AnimaFlow/anima_prompt"
    assert AnimaPromptStudio.FUNCTION == "compose"


def test_node_compose_matches_helper():
    raw = _state_json([block("p1", text="a"), block("p2", text="b", pin=True)], [block("n1", text="c")])
    expected = psh.build_prompt_studio_output(raw, ", ", False, "anima", "*")
    node = AnimaPromptStudio()
    actual = node.compose(raw, ", ", False, "anima", "*")
    assert actual == expected


ALL_TESTS = [
    test_parse_blocks_state_valid_json,
    test_parse_blocks_state_malformed_json_does_not_raise,
    test_parse_blocks_state_empty_string_does_not_raise,
    test_parse_blocks_state_none_does_not_raise,
    test_parse_blocks_state_json_list_instead_of_object_falls_back,
    test_parse_blocks_state_json_string_instead_of_object_falls_back,
    test_parse_blocks_state_json_number_instead_of_object_falls_back,
    test_parse_blocks_state_missing_keys_default_to_empty_lists,
    test_parse_blocks_state_missing_positive_key_only,
    test_parse_blocks_state_unknown_type_normalized_to_general,
    test_parse_blocks_state_missing_enabled_pin_text_label_defaulted,
    test_parse_blocks_state_non_dict_pane_entry_is_dropped,
    test_assemble_pin_before_rest,
    test_assemble_pin_after_rest,
    test_assemble_pin_interleaved_both_sides_of_rest_preserves_position,
    test_assemble_disabled_blocks_skipped,
    test_assemble_blank_text_blocks_skipped,
    test_assemble_blank_pinned_block_skipped_too,
    test_assemble_empty_pane,
    test_assemble_all_blocks_pinned_no_rest_placeholder,
    test_assemble_all_blocks_non_pinned,
    test_assemble_space_separator_no_hardcoded_comma_splitting,
    test_assemble_newline_separator_no_hardcoded_comma_splitting,
    test_substitute_rest_empty_rest_corrected_omits_segment,
    test_substitute_rest_blank_rest_corrected_omits_segment,
    test_substitute_rest_join_skips_blank_segments,
    test_substitute_rest_no_rest_placeholder_is_a_no_op_for_rest_corrected,
    test_substitute_rest_honors_separator,
    test_substitute_rest_strips_rest_corrected_whitespace,
    test_build_output_correction_disabled_is_byte_identical_passthrough,
    test_build_output_correction_disabled_matches_manual_assembly_for_any_state,
    test_build_output_correction_enabled_real_engine_pin_survives_verbatim,
    test_build_output_correction_enabled_no_rest_text_skips_engine_call_but_still_returns_pins,
    test_is_changed_digest_changes_with_blocks_state,
    test_is_changed_digest_changes_with_separator,
    test_is_changed_digest_changes_with_rules_profile,
    test_is_changed_digest_changes_with_rules_sheets,
    test_is_changed_digest_changes_with_rules_correction_enabled_flag,
    test_is_changed_digest_changes_when_a_referenced_sheet_files_digest_changes,
    test_node_is_changed_matches_helper_digest,
    test_node_input_types_contract,
    test_node_category_and_function,
    test_node_compose_matches_helper,
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

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
