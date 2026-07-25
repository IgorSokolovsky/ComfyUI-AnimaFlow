"""Plain-script tests for the Panel Parser (Batch) node's pure logic.

Run directly: `python tests/test_panel_parser.py` (no pytest, per project convention).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes._panel_parser_helpers import (
    DEFAULT_DELIMITER_REGEX,
    DEFAULT_STORY_REGEX,
    split_panel_body,
    split_panels,
)
from nodes.node_panel_parser import PanelBatch

SAMPLE_TEXT = """=== PANEL 1 ===
score_7, masterpiece

Yuna: woman, long black hair. white blouse. sitting, smiling. facing camera.

Background: office at night
Composition: over-the-shoulder
Camera: medium shot
Lighting: cool glow

=== PANEL 2 ===
score_7, masterpiece

Jae: man, short dark hair. blue shirt. standing, holding coffee. from behind.

Background: office at night
Composition: wide shot
Camera: full shot
Lighting: warm glow
"""

SAMPLE_TEXT_WITH_STORY = """=== PANEL 1 ===
score_7, masterpiece

Yuna: woman, long black hair, white blouse, sitting, smiling

Background: office at night;
Composition: over-the-shoulder;
Camera: medium shot;
Lighting: cool glow;

--- STORY ---
Narration: The office was quiet.
Yuna: "Still here?"

=== PANEL 2 ===
score_7, masterpiece

Jae: man, short dark hair, blue shirt, standing, holding coffee

Background: office at night;
Composition: wide shot;
Camera: full shot;
Lighting: warm glow;
"""


def test_split_panels_multiple_panels():
    panels = split_panels(SAMPLE_TEXT, DEFAULT_DELIMITER_REGEX)
    assert len(panels) == 2
    assert panels[0].startswith("score_7, masterpiece")
    assert "Yuna:" in panels[0]
    assert panels[1].startswith("score_7, masterpiece")
    assert "Jae:" in panels[1]
    # Delimiter lines themselves are not part of the panel body.
    assert "PANEL" not in panels[0]
    assert "PANEL" not in panels[1]


def test_split_panels_preamble_before_first_delimiter_dropped():
    text = "Some commentary the model shouldn't have written.\n" + SAMPLE_TEXT
    panels = split_panels(text, DEFAULT_DELIMITER_REGEX)
    assert len(panels) == 2
    assert "commentary" not in panels[0]
    assert panels[0].startswith("score_7, masterpiece")


def test_split_panels_blank_pieces_dropped():
    text = "=== PANEL 1 ===\nreal panel text\n=== PANEL 2 ===\n   \n=== PANEL 3 ===\nmore text"
    panels = split_panels(text, DEFAULT_DELIMITER_REGEX)
    assert panels == ["real panel text", "more text"]


def test_split_panels_single_panel_no_delimiter_fallback():
    text = "  just one plain block of panel text, no delimiter at all  "
    panels = split_panels(text, DEFAULT_DELIMITER_REGEX)
    assert panels == ["just one plain block of panel text, no delimiter at all"]


def test_split_panels_empty_input_yields_empty_list():
    assert split_panels("", DEFAULT_DELIMITER_REGEX) == []
    assert split_panels("   \n\n  ", DEFAULT_DELIMITER_REGEX) == []
    assert split_panels(None, DEFAULT_DELIMITER_REGEX) == []


def test_split_panels_invalid_regex_falls_back_to_single_panel():
    text = "=== PANEL 1 ===\nsome text here"
    panels = split_panels(text, "[invalid(regex")
    assert panels == [text.strip()]


def test_split_panels_invalid_regex_blank_text_yields_empty_list():
    assert split_panels("   ", "[invalid(regex") == []


def test_split_panels_case_insensitive_and_variable_equals_count():
    text = "==PANEL 1==\nfirst\n========= panel 2 =========\nsecond"
    panels = split_panels(text, DEFAULT_DELIMITER_REGEX)
    assert panels == ["first", "second"]


def test_split_panels_custom_delimiter_regex():
    text = "PANEL_A\nfirst panel\nPANEL_B\nsecond panel"
    panels = split_panels(text, r"^PANEL_[A-Z]$")
    assert panels == ["first panel", "second panel"]


def test_split_panel_body_marker_present():
    block = "image prompt lines here\n--- STORY ---\nNarration: hello\nYuna: \"hi\""
    image_prompt, story = split_panel_body(block, DEFAULT_STORY_REGEX)
    assert image_prompt == "image prompt lines here"
    assert story == 'Narration: hello\nYuna: "hi"'
    assert "STORY" not in image_prompt


def test_split_panel_body_marker_absent():
    block = "just an image prompt, no story block at all"
    image_prompt, story = split_panel_body(block, DEFAULT_STORY_REGEX)
    assert image_prompt == block
    assert story == ""


def test_split_panel_body_blank_input():
    assert split_panel_body("", DEFAULT_STORY_REGEX) == ("", "")
    assert split_panel_body(None, DEFAULT_STORY_REGEX) == ("", "")
    assert split_panel_body("   ", DEFAULT_STORY_REGEX) == ("", "")


def test_split_panel_body_variable_dashes_and_case_insensitive():
    block = "prompt text\n----story----\nsome narration"
    image_prompt, story = split_panel_body(block, DEFAULT_STORY_REGEX)
    assert image_prompt == "prompt text"
    assert story == "some narration"

    block2 = "prompt text\n-- STORY --\nmore narration"
    image_prompt2, story2 = split_panel_body(block2, DEFAULT_STORY_REGEX)
    assert image_prompt2 == "prompt text"
    assert story2 == "more narration"


def test_split_panel_body_invalid_regex_falls_back():
    block = "prompt text\n--- STORY ---\nnarration"
    image_prompt, story = split_panel_body(block, "[invalid(regex")
    assert image_prompt == block.strip()
    assert story == ""


def test_node_input_types_contract():
    schema = PanelBatch.INPUT_TYPES()
    assert schema["required"]["panels_text"][0] == "STRING"
    assert schema["required"]["panels_text"][1]["default"] == ""
    assert schema["optional"]["delimiter_regex"][0] == "STRING"
    assert schema["optional"]["delimiter_regex"][1]["default"] == DEFAULT_DELIMITER_REGEX
    assert schema["optional"]["story_delimiter_regex"][0] == "STRING"
    assert schema["optional"]["story_delimiter_regex"][1]["default"] == DEFAULT_STORY_REGEX
    assert schema["optional"]["start_index"][0] == "INT"
    assert schema["optional"]["start_index"][1] == {"default": 1, "min": 0}
    assert PanelBatch.CATEGORY == "AnimaFlow/panel"
    assert PanelBatch.FUNCTION == "parse"
    assert PanelBatch.RETURN_TYPES == ("STRING", "STRING", "INT", "INT")
    assert PanelBatch.RETURN_NAMES == ("panel", "story", "panel_index", "count")
    assert PanelBatch.OUTPUT_IS_LIST == (True, True, True, False)


def test_node_parse_returns_lists_and_scalar_count():
    node = PanelBatch()
    panels, stories, indices, count = node.parse(SAMPLE_TEXT_WITH_STORY)
    assert isinstance(panels, list)
    assert isinstance(stories, list)
    assert isinstance(indices, list)
    assert isinstance(count, int)
    assert len(panels) == 2
    assert len(stories) == 2
    assert indices == [1, 2]
    assert count == 2


def test_node_parse_splits_image_prompt_and_story_per_panel():
    node = PanelBatch()
    panels, stories, indices, count = node.parse(SAMPLE_TEXT_WITH_STORY)
    # Panel 1 has a STORY block; panel 2 does not.
    assert "STORY" not in panels[0]
    assert "Narration" not in panels[0]
    assert stories[0] == 'Narration: The office was quiet.\nYuna: "Still here?"'
    assert panels[1].startswith("score_7, masterpiece")
    assert "Jae:" in panels[1]
    assert stories[1] == ""


def test_node_parse_empty_text_yields_empty_lists_and_zero_count():
    node = PanelBatch()
    panels, stories, indices, count = node.parse("")
    assert panels == []
    assert stories == []
    assert indices == []
    assert count == 0


def test_node_parse_default_delimiter_regex_used_when_omitted():
    node = PanelBatch()
    panels, stories, indices, count = node.parse(SAMPLE_TEXT_WITH_STORY)
    # calling without delimiter_regex uses PanelBatch's default kwarg value
    assert count == 2


def test_node_parse_default_start_index_is_one():
    node = PanelBatch()
    _, _, indices, _ = node.parse(SAMPLE_TEXT_WITH_STORY)
    assert indices == [1, 2]


def test_node_parse_custom_start_index_offsets_indices():
    node = PanelBatch()
    _, _, indices, count = node.parse(SAMPLE_TEXT_WITH_STORY, start_index=5)
    assert indices == [5, 6]
    assert count == 2


def test_node_parse_start_index_zero():
    node = PanelBatch()
    _, _, indices, _ = node.parse(SAMPLE_TEXT_WITH_STORY, start_index=0)
    assert indices == [0, 1]


def test_node_parse_start_index_ignored_when_empty_input():
    node = PanelBatch()
    panels, stories, indices, count = node.parse("", start_index=5)
    assert panels == []
    assert stories == []
    assert indices == []
    assert count == 0


ALL_TESTS = [
    test_split_panels_multiple_panels,
    test_split_panels_preamble_before_first_delimiter_dropped,
    test_split_panels_blank_pieces_dropped,
    test_split_panels_single_panel_no_delimiter_fallback,
    test_split_panels_empty_input_yields_empty_list,
    test_split_panels_invalid_regex_falls_back_to_single_panel,
    test_split_panels_invalid_regex_blank_text_yields_empty_list,
    test_split_panels_case_insensitive_and_variable_equals_count,
    test_split_panels_custom_delimiter_regex,
    test_split_panel_body_marker_present,
    test_split_panel_body_marker_absent,
    test_split_panel_body_blank_input,
    test_split_panel_body_variable_dashes_and_case_insensitive,
    test_split_panel_body_invalid_regex_falls_back,
    test_node_input_types_contract,
    test_node_parse_returns_lists_and_scalar_count,
    test_node_parse_splits_image_prompt_and_story_per_panel,
    test_node_parse_empty_text_yields_empty_lists_and_zero_count,
    test_node_parse_default_delimiter_regex_used_when_omitted,
    test_node_parse_default_start_index_is_one,
    test_node_parse_custom_start_index_offsets_indices,
    test_node_parse_start_index_zero,
    test_node_parse_start_index_ignored_when_empty_input,
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
