"""Plain-script tests for the Prompt Combiner node's pure logic.

Run directly: `python tests/test_prompt_combiner.py` (no pytest, per project convention).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima_prompt._prompt_combiner_helpers import (
    build_combined_prompt_data,
    build_field_text,
    unwrap_value,
)
from nodes.anima_prompt.node_prompt_combiner import PromptCombiner


def test_unwrap_prompt_data_dict():
    value = {"template": "{x}", "variables": {}, "prompt": "1girl, solo", "name": "combined"}
    assert unwrap_value(value) == "1girl, solo"


def test_unwrap_plain_string():
    assert unwrap_value("hello world") == "hello world"


def test_unwrap_plain_string_is_stripped():
    assert unwrap_value("  spaced  ") == "spaced"


def test_unwrap_missing_or_none():
    assert unwrap_value(None) == ""
    assert unwrap_value(None) == unwrap_value(None)


def test_unwrap_dict_without_prompt_key_falls_back_to_str():
    # Not a PROMPT_DATA shape (no "prompt" key) -> stringified as-is.
    value = {"foo": "bar"}
    assert unwrap_value(value) == str(value)


def test_node_input_types_contract():
    schema = PromptCombiner.INPUT_TYPES()
    assert schema["required"]["template"][0] == "STRING"
    assert schema["required"]["template"][1]["default"] == "{character}, {background}"
    # optional schema must report every key as contained (flexible-inputs pattern)
    optional = schema["optional"]
    assert "anything_at_all" in optional
    assert "character" in optional
    assert PromptCombiner.CATEGORY == "AnimaFlow/anima_prompt"
    assert PromptCombiner.FUNCTION == "combine"
    assert PromptCombiner.RETURN_TYPES == ("STRING", "PROMPT_DATA")
    assert PromptCombiner.RETURN_NAMES == ("prompt", "data")


def test_node_input_types_optional_getitem_matches_get_input_info():
    # Regression test for the ComfyUI `get_input_info` crash:
    #   input_info = valid_inputs["optional"][input_name]  # KeyError on empty dict
    # Simulate exactly what get_input_info does for an undeclared dynamic
    # input name ("test") to prove `__getitem__` never raises KeyError and
    # yields a valid (type, options) spec.
    d = PromptCombiner.INPUT_TYPES()["optional"]
    assert "test" in d

    info = d["test"]
    assert isinstance(info, tuple)
    assert len(info) == 2

    input_type = info[0]
    extra_info = info[1]
    # Wildcard type: ComfyUI compares types with `!=`, so this must be False
    # against any other type string for the connection to validate.
    assert (input_type != "STRING") is False
    assert (input_type != "PROMPT_DATA") is False
    assert isinstance(extra_info, dict)


def test_combine_prompt_data_and_string_inputs():
    node = PromptCombiner()
    character = {
        "template": "{character}",
        "variables": {"character": "Aria"},
        "prompt": "1girl, solo",
        "name": "combined",
    }
    template = "{character}, {background}"
    output = node.combine(template, character=character, background="forest")
    structured_str, data = output["result"]
    # Primary output is now the labeled-prose string (no JSON/braces/quotes).
    assert structured_str == "Character: 1girl, solo\nBackground: forest"
    assert data["structured"] == structured_str
    # `.prompt` on PROMPT_DATA stays the flat string, unchanged.
    assert data["prompt"] == "1girl, solo, forest", data["prompt"]
    assert data["variables"] == {"character": "1girl, solo", "background": "forest"}
    assert output["ui"]["text"] == [structured_str]


def test_combine_blank_variable_drops_cleanly():
    node = PromptCombiner()
    template = "{character}, {background}, {style}"
    output = node.combine(template, character="Aria", background="   ", style="")
    structured_str, data = output["result"]
    assert data["prompt"] == "Aria", data["prompt"]
    assert not data["prompt"].startswith(",")
    assert not data["prompt"].endswith(",")
    assert ",," not in data["prompt"]
    assert ", ," not in data["prompt"]
    assert structured_str == "Character: Aria"
    assert output["ui"]["text"] == [structured_str]


def test_combine_missing_input_for_token_yields_empty():
    node = PromptCombiner()
    template = "{character}, {background}"
    # "background" never connected -> not present in kwargs at all.
    output = node.combine(template, character="Aria")
    structured_str, data = output["result"]
    assert data["prompt"] == "Aria", data["prompt"]
    assert data["variables"]["background"] == ""
    assert structured_str == "Character: Aria"
    assert output["ui"]["text"] == [structured_str]


def test_combine_all_blank_yields_empty_string():
    node = PromptCombiner()
    template = "{character}, {background}"
    output = node.combine(template)
    structured_str, data = output["result"]
    assert data["prompt"] == "", data["prompt"]
    assert structured_str == "", structured_str
    assert output["ui"]["text"] == [structured_str]


def test_combined_prompt_data_shape():
    values = {"character": "Aria", "background": "forest"}
    structured_str = build_field_text(values)
    data = build_combined_prompt_data("{character}, {background}", values, "Aria, forest", structured_str)
    assert set(data.keys()) == {"template", "variables", "prompt", "structured", "name"}
    assert data["template"] == "{character}, {background}"
    assert data["variables"] == values
    assert data["prompt"] == "Aria, forest"
    assert data["structured"] == structured_str
    assert data["structured"] == "Character: Aria\nBackground: forest"
    assert data["name"] == "combined"


ALL_TESTS = [
    test_unwrap_prompt_data_dict,
    test_unwrap_plain_string,
    test_unwrap_plain_string_is_stripped,
    test_unwrap_missing_or_none,
    test_unwrap_dict_without_prompt_key_falls_back_to_str,
    test_node_input_types_contract,
    test_node_input_types_optional_getitem_matches_get_input_info,
    test_combine_prompt_data_and_string_inputs,
    test_combine_blank_variable_drops_cleanly,
    test_combine_missing_input_for_token_yields_empty,
    test_combine_all_blank_yields_empty_string,
    test_combined_prompt_data_shape,
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
