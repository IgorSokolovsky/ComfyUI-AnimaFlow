"""Plain-script tests for the Prompt Builder node's pure logic.

Run directly: `python tests/test_prompt_builder.py` (no pytest, per project convention).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima_prompt._prompt_builder_helpers import (
    DEFAULT_TEMPLATE,
    build_field_text,
    build_prompt_data,
    humanize,
    parse_state,
    parse_tokens,
    render_prompt,
)
from nodes.anima_prompt.node_prompt_builder import PromptBuilder


def test_parse_tokens_order_and_uniqueness():
    tokens = parse_tokens("{character}, {hair_style}, {hair_color}, {character}")
    assert tokens == ["character", "hair_style", "hair_color"], tokens


def test_parse_tokens_default_template():
    tokens = parse_tokens(DEFAULT_TEMPLATE)
    assert tokens == [
        "character",
        "hair_style",
        "hair_color",
        "eyes",
        "body_type",
        "skin",
        "marks",
        "breasts",
        "genital_state",
        "body_details",
    ], tokens


def test_parse_tokens_empty_template():
    assert parse_tokens("") == []
    assert parse_tokens("no tokens here") == []


def test_render_prompt_all_fields_set():
    template = "{character}, {hair_style}, {eyes}"
    values = {"character": "Aria", "hair_style": "long braid", "eyes": "green"}
    assert render_prompt(template, values) == "Aria, long braid, green"


def test_render_prompt_some_blank_fields_no_dangling_commas():
    template = "{character}, {hair_style}, {hair_color}, {eyes}"
    values = {"character": "Aria", "hair_style": "", "hair_color": "  ", "eyes": "green"}
    result = render_prompt(template, values)
    assert result == "Aria, green", result
    assert ",," not in result
    assert ", ," not in result
    assert not result.startswith(",")
    assert not result.endswith(",")


def test_render_prompt_all_blank_yields_empty_string():
    template = "{character}, {hair_style}"
    values = {"character": "", "hair_style": ""}
    assert render_prompt(template, values) == ""


def test_render_prompt_missing_token_in_values():
    # Token present in template but absent from the values dict entirely.
    template = "{character}, {hair_style}"
    values = {"character": "Aria"}
    result = render_prompt(template, values)
    assert result == "Aria", result


def test_render_prompt_token_with_internal_comma_gets_split():
    template = "{character}, {tags}"
    values = {"character": "Aria", "tags": "tag1, tag2"}
    result = render_prompt(template, values)
    assert result == "Aria, tag1, tag2", result


def test_parse_state_valid_json():
    fields = parse_state('{"version": 1, "fields": {"character": "Aria"}}')
    assert fields == {"character": "Aria"}


def test_parse_state_empty_string():
    assert parse_state("") == {}


def test_parse_state_invalid_json():
    assert parse_state("{not valid json") == {}
    assert parse_state("null") == {}
    assert parse_state("[1, 2, 3]") == {}


def test_parse_state_missing_fields_key():
    assert parse_state('{"version": 1}') == {}


def test_parse_state_fields_wrong_type():
    assert parse_state('{"fields": "not a dict"}') == {}


def test_humanize():
    assert humanize("hair_style") == "Hair Style"
    assert humanize("character") == "Character"
    assert humanize("genital_state") == "Genital State"
    assert humanize("") == ""
    assert humanize("a_b_c") == "A B C"


def test_build_field_text_drops_empty_and_preserves_order():
    values = {"character": "Aria", "hair_style": "", "hair_color": "  ", "eyes": "green"}
    result = build_field_text(values)
    assert result == "Character: Aria\nEyes: green"


def test_build_field_text_labels_and_preserves_unicode():
    result = build_field_text({"character": "Élise", "hair_style": "twin buns"})
    assert result == "Character: Élise\nHair Style: twin buns"
    assert "Élise" in result
    # No JSON/braces/quotes noise — plain labeled-prose lines only.
    assert "{" not in result and "}" not in result and '"' not in result


def test_build_field_text_all_blank_yields_empty_string():
    assert build_field_text({"character": "", "hair_style": "  "}) == ""


def test_name_derivation_from_character():
    values = {"character": "  Aria  ", "hair_style": "braid"}
    data = build_prompt_data("{character}, {hair_style}", values, "Aria, braid", "")
    assert data["name"] == "Aria", data


def test_name_derivation_defaults_to_prompt_when_blank():
    values = {"character": "   ", "hair_style": "braid"}
    data = build_prompt_data("{character}, {hair_style}", values, "braid", "")
    assert data["name"] == "prompt", data

    values2 = {"hair_style": "braid"}
    data2 = build_prompt_data("{hair_style}", values2, "braid", "")
    assert data2["name"] == "prompt", data2


def test_prompt_data_shape():
    values = {"character": "Aria", "hair_style": "braid"}
    structured_str = build_field_text(values)
    data = build_prompt_data("{character}, {hair_style}", values, "Aria, braid", structured_str)
    assert set(data.keys()) == {"template", "fields", "prompt", "structured", "name"}
    assert data["template"] == "{character}, {hair_style}"
    assert data["fields"] == values
    assert data["prompt"] == "Aria, braid"
    assert data["structured"] == structured_str
    assert data["structured"] == "Character: Aria\nHair Style: braid"
    assert data["name"] == "Aria"


def test_node_input_types_contract():
    schema = PromptBuilder.INPUT_TYPES()
    assert schema["required"]["template"][0] == "STRING"
    assert schema["required"]["template"][1]["default"] == DEFAULT_TEMPLATE
    assert schema["required"]["prompt_builder_state"][0] == "STRING"
    assert schema["required"]["prompt_builder_state"][1]["default"] == "{}"
    assert "hidden" not in schema or "prompt_builder_state" not in schema.get("hidden", {})
    assert PromptBuilder.CATEGORY == "AnimaFlow/anima_prompt"
    assert PromptBuilder.FUNCTION == "build"
    assert PromptBuilder.RETURN_TYPES == ("STRING", "PROMPT_DATA")
    assert PromptBuilder.RETURN_NAMES == ("prompt", "data")


def test_node_build_end_to_end():
    node = PromptBuilder()
    state = (
        '{"version": 1, "fields": {"character": "Aria", "hair_style": "long braid", '
        '"eyes": "green", "unused_token": "ignored"}}'
    )
    template = "{character}, {hair_style}, {hair_color}, {eyes}"
    structured_str, data = node.build(template, prompt_builder_state=state)
    # Primary output is now the labeled-prose string (no JSON/braces/quotes).
    assert structured_str == "Character: Aria\nHair Style: long braid\nEyes: green"
    assert data["structured"] == structured_str
    # `.prompt` on PROMPT_DATA stays the flat string, unchanged.
    assert data["prompt"] == "Aria, long braid, green", data["prompt"]
    assert data["name"] == "Aria"
    assert data["template"] == template
    assert data["fields"] == {
        "character": "Aria",
        "hair_style": "long braid",
        "hair_color": "",
        "eyes": "green",
    }
    assert "unused_token" not in data["fields"]


def test_node_build_default_state():
    node = PromptBuilder()
    structured_str, data = node.build(DEFAULT_TEMPLATE)
    assert structured_str == "", structured_str
    assert data["prompt"] == "", data["prompt"]
    assert data["structured"] == ""
    assert data["name"] == "prompt"


ALL_TESTS = [
    test_parse_tokens_order_and_uniqueness,
    test_parse_tokens_default_template,
    test_parse_tokens_empty_template,
    test_render_prompt_all_fields_set,
    test_render_prompt_some_blank_fields_no_dangling_commas,
    test_render_prompt_all_blank_yields_empty_string,
    test_render_prompt_missing_token_in_values,
    test_render_prompt_token_with_internal_comma_gets_split,
    test_parse_state_valid_json,
    test_parse_state_empty_string,
    test_parse_state_invalid_json,
    test_parse_state_missing_fields_key,
    test_parse_state_fields_wrong_type,
    test_build_field_text_drops_empty_and_preserves_order,
    test_build_field_text_labels_and_preserves_unicode,
    test_build_field_text_all_blank_yields_empty_string,
    test_humanize,
    test_name_derivation_from_character,
    test_name_derivation_defaults_to_prompt_when_blank,
    test_prompt_data_shape,
    test_node_input_types_contract,
    test_node_build_end_to_end,
    test_node_build_default_state,
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
