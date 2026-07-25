"""Plain-script tests for the LLM Panels node's pure logic.

Run directly: `python test_llm_panels.py` (no pytest, per project convention).
No real network calls are made anywhere in this file — `build_messages` /
`build_payload` / `extract_content` / `split_panels_and_synopsis` are pure
functions; the actual HTTP POST lives in `nodes/node_llm_panels.py` and is
intentionally NOT exercised here.
"""

from __future__ import annotations

import re

from nodes._llm_panels_helpers import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_SYSTEM_PROMPT,
    PANEL_DELIMITER_TEMPLATE,
    SYNOPSIS_DELIMITER,
    build_messages,
    build_payload,
    extract_content,
    split_panels_and_synopsis,
)
from nodes.node_llm_panels import LLMPanels


def test_build_messages_roles_and_brief():
    messages = build_messages("SYSTEM TEXT", "A dog finds a treasure map.", 4)
    assert len(messages) == 2
    assert messages[0] == {"role": "system", "content": "SYSTEM TEXT"}
    assert messages[1]["role"] == "user"
    assert "A dog finds a treasure map." in messages[1]["content"]


def test_build_messages_target_panels_auto_when_zero_or_negative():
    messages = build_messages("SYS", "brief", 0)
    user_content = messages[1]["content"]
    assert "as many panels as this part of the story needs" in user_content
    assert "ending" in user_content
    assert "roughly" not in user_content

    messages_neg = build_messages("SYS", "brief", -3)
    assert "as many panels as this part of the story needs" in messages_neg[1]["content"]


def test_build_messages_target_panels_cap_when_positive():
    messages = build_messages("SYS", "brief", 7)
    user_content = messages[1]["content"]
    assert "up to about 7 panels" in user_content
    assert "fewer" in user_content.lower()
    assert "do not pad to reach 7" in user_content


def test_build_messages_folds_character_bible():
    messages = build_messages("SYS", "brief text", 0, character_bible="Yuna: long black hair.")
    user_content = messages[1]["content"]
    assert "Yuna: long black hair." in user_content


def test_build_messages_omits_character_bible_section_when_blank():
    messages = build_messages("SYS", "brief text", 3, character_bible="")
    user_content = messages[1]["content"]
    assert "character bible" not in user_content.lower()

    messages2 = build_messages("SYS", "brief text", 3, character_bible="   ")
    assert "character bible" not in messages2[1]["content"].lower()


def test_build_messages_no_continuation_context_by_default():
    messages = build_messages("SYS", "brief text", 3)
    user_content = messages[1]["content"]
    assert "story so far" not in user_content.lower()
    assert "already written" not in user_content.lower()
    assert "continuation" not in user_content.lower()


def test_build_messages_folds_synopsis_and_frames_continuation():
    messages = build_messages("SYS", "brief text", 4, synopsis="Yuna and Jae met at the office.")
    user_content = messages[1]["content"]
    assert "Story so far (synopsis):" in user_content
    assert "Yuna and Jae met at the office." in user_content
    assert "CONTINUATION" in user_content
    assert "already written" not in user_content.lower()


def test_build_messages_folds_previous_panels_and_frames_continuation():
    messages = build_messages("SYS", "brief text", 4, previous_panels="=== PANEL 1 ===\nsome panel")
    user_content = messages[1]["content"]
    assert "Panels already written (do NOT repeat these — continue from here):" in user_content
    assert "=== PANEL 1 ===\nsome panel" in user_content
    assert "CONTINUATION" in user_content


def test_build_messages_blank_previous_panels_and_synopsis_no_continuation_framing():
    messages = build_messages("SYS", "brief text", 4, previous_panels="   ", synopsis="")
    user_content = messages[1]["content"]
    assert "CONTINUATION" not in user_content
    assert "story so far" not in user_content.lower()
    assert "already written" not in user_content.lower()


def test_build_payload_seed_omitted_when_zero():
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]
    payload = build_payload("some-model", messages, 0.8, 2048, seed=0)
    assert "seed" not in payload
    assert payload == {
        "model": "some-model",
        "messages": messages,
        "temperature": 0.8,
        "max_tokens": 2048,
    }


def test_build_payload_seed_present_when_positive():
    messages = [{"role": "system", "content": "s"}]
    payload = build_payload("some-model", messages, 0.5, 1024, seed=42)
    assert payload["seed"] == 42


def test_build_payload_negative_seed_treated_like_zero():
    messages = [{"role": "system", "content": "s"}]
    payload = build_payload("some-model", messages, 0.5, 1024, seed=-1)
    assert "seed" not in payload


def test_build_payload_correct_keys_and_values():
    messages = [{"role": "system", "content": "s"}]
    payload = build_payload("openrouter/auto", messages, 0.8, 2048, seed=99)
    assert set(payload.keys()) == {"model", "messages", "temperature", "max_tokens", "seed"}
    assert payload["model"] == "openrouter/auto"
    assert payload["messages"] is messages
    assert payload["temperature"] == 0.8
    assert payload["max_tokens"] == 2048
    assert payload["seed"] == 99


def test_extract_content_happy_path():
    response = {"choices": [{"message": {"content": "=== PANEL 1 ===\ntext"}}]}
    assert extract_content(response) == "=== PANEL 1 ===\ntext"


def test_extract_content_malformed_not_a_dict():
    try:
        extract_content(["not", "a", "dict"])
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_extract_content_malformed_missing_choices():
    try:
        extract_content({"foo": "bar"})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_extract_content_malformed_empty_choices():
    try:
        extract_content({"choices": []})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_extract_content_malformed_choice_not_dict():
    try:
        extract_content({"choices": ["nope"]})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_extract_content_malformed_missing_message():
    try:
        extract_content({"choices": [{}]})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_extract_content_malformed_message_not_dict():
    try:
        extract_content({"choices": [{"message": "nope"}]})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_extract_content_malformed_content_not_string():
    try:
        extract_content({"choices": [{"message": {"content": None}}]})
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_split_panels_and_synopsis_marker_present():
    content = (
        "=== PANEL 1 ===\npanel one text\n"
        "=== PANEL 2 ===\npanel two text\n"
        "=== SYNOPSIS ===\nYuna and Jae met at the office."
    )
    panels_text, synopsis = split_panels_and_synopsis(content)
    assert panels_text == "=== PANEL 1 ===\npanel one text\n=== PANEL 2 ===\npanel two text"
    assert synopsis == "Yuna and Jae met at the office."
    assert "SYNOPSIS" not in panels_text


def test_split_panels_and_synopsis_marker_absent():
    content = "=== PANEL 1 ===\njust one panel, no synopsis block"
    panels_text, synopsis = split_panels_and_synopsis(content)
    assert panels_text == content.strip()
    assert synopsis == ""


def test_split_panels_and_synopsis_blank_content():
    assert split_panels_and_synopsis("") == ("", "")
    assert split_panels_and_synopsis(None) == ("", "")


def test_split_panels_and_synopsis_variable_equals_and_case_insensitive():
    content = "panel body here\n====synopsis====\nthe summary"
    panels_text, synopsis = split_panels_and_synopsis(content)
    assert panels_text == "panel body here"
    assert synopsis == "the summary"


def test_split_panels_and_synopsis_only_splits_on_first_marker():
    content = "body\n=== SYNOPSIS ===\nsummary line one\n=== SYNOPSIS ===\nshould stay in synopsis"
    panels_text, synopsis = split_panels_and_synopsis(content)
    assert panels_text == "body"
    assert synopsis == "summary line one\n=== SYNOPSIS ===\nshould stay in synopsis"


def test_split_panels_and_synopsis_end_marker_rides_along_with_synopsis():
    # A completed story: the raw content ends with the SYNOPSIS block
    # followed by the "=== END ===" completion marker. Since the rule places
    # "=== END ===" AFTER the synopsis marker, split_panels_and_synopsis
    # (which only splits on the FIRST "=== SYNOPSIS ===" line) keeps
    # panels_text clean of it, and it rides along inside the synopsis half.
    content = (
        "=== PANEL 1 ===\npanel one text\n"
        "=== SYNOPSIS ===\nYuna and Jae's story concludes here.\n"
        "=== END ==="
    )
    panels_text, synopsis = split_panels_and_synopsis(content)
    assert "=== END ===" not in panels_text
    assert "=== END ===" in synopsis
    assert panels_text == "=== PANEL 1 ===\npanel one text"
    assert synopsis == "Yuna and Jae's story concludes here.\n=== END ==="


def test_default_system_prompt_mentions_delimiter_and_background_label():
    assert "=== PANEL" in DEFAULT_SYSTEM_PROMPT
    assert PANEL_DELIMITER_TEMPLATE.split("{n}")[0].strip() in DEFAULT_SYSTEM_PROMPT
    assert "Background:" in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_mentions_continuation_and_synopsis_block():
    assert "CONTINUATION" in DEFAULT_SYSTEM_PROMPT
    assert SYNOPSIS_DELIMITER in DEFAULT_SYSTEM_PROMPT
    assert "renumber" in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_panel_count_is_upper_cap_not_minimum():
    assert "EXACTLY or MORE" not in DEFAULT_SYSTEM_PROMPT
    assert "UPPER guide, not a minimum" in DEFAULT_SYSTEM_PROMPT
    assert "END there with FEWER panels" in DEFAULT_SYSTEM_PROMPT
    assert "never pad, stall, or invent filler" in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_mentions_end_completion_marker():
    assert "=== END ===" in DEFAULT_SYSTEM_PROMPT
    assert 'after the "=== SYNOPSIS ===" block' in DEFAULT_SYSTEM_PROMPT
    assert "do NOT output" in DEFAULT_SYSTEM_PROMPT
    # The END rule is stated AFTER the synopsis rule in the prompt text, so
    # the marker rides along with (after) the synopsis block in real output.
    synopsis_rule_pos = DEFAULT_SYSTEM_PROMPT.index('output one final block starting with "=== SYNOPSIS ==="')
    end_rule_pos = DEFAULT_SYSTEM_PROMPT.index("=== END ===", synopsis_rule_pos)
    assert synopsis_rule_pos < end_rule_pos


def test_default_system_prompt_mentions_story_marker():
    assert "--- STORY ---" in DEFAULT_SYSTEM_PROMPT
    assert "narration" in DEFAULT_SYSTEM_PROMPT.lower()
    assert "dialogue" in DEFAULT_SYSTEM_PROMPT.lower()


def test_default_system_prompt_mentions_exact_shape_and_placeholders():
    assert "EXACT SHAPE" in DEFAULT_SYSTEM_PROMPT
    for placeholder in ("[gender]", "[Name]", "[quality tags]", "[Name 2]"):
        assert placeholder in DEFAULT_SYSTEM_PROMPT, placeholder
    # The literal "{n}" placeholder is instructional template syntax for the
    # LLM, not a Python format field — DEFAULT_SYSTEM_PROMPT is never
    # .format()-ed, so it must survive verbatim.
    assert "{n}" in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_mentions_example_section_and_sera_jae_lines():
    assert "EXAMPLE:" in DEFAULT_SYSTEM_PROMPT
    assert "Sera: woman, mature female" in DEFAULT_SYSTEM_PROMPT
    assert "Jae: man, tall, muscular" in DEFAULT_SYSTEM_PROMPT
    assert 'Jae: "You\'re still here?"' in DEFAULT_SYSTEM_PROMPT
    assert 'Sera: "...I could ask you the same thing."' in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_mentions_persistent_identity_and_appearance_order():
    assert "PERSISTENT IDENTITY ONLY" in DEFAULT_SYSTEM_PROMPT
    assert "mature female" in DEFAULT_SYSTEM_PROMPT
    assert "tsurime" in DEFAULT_SYSTEM_PROMPT
    assert "mole under eye" in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_mentions_background_setting_bible():
    assert "Background:" in DEFAULT_SYSTEM_PROMPT
    assert "setting bible" in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_mentions_composition_sentence_rule():
    assert "NAME each character" in DEFAULT_SYSTEM_PROMPT
    assert "over-the-shoulder" in DEFAULT_SYSTEM_PROMPT
    assert "back-to-camera & blurred" in DEFAULT_SYSTEM_PROMPT
    assert "sharp focus" in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_mentions_shot_line_rule():
    assert "SHOT LINE" in DEFAULT_SYSTEM_PROMPT
    assert "depth of field" in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_no_composition_camera_lighting_labels():
    assert "Composition:" not in DEFAULT_SYSTEM_PROMPT
    assert "Camera:" not in DEFAULT_SYSTEM_PROMPT
    assert "Lighting:" not in DEFAULT_SYSTEM_PROMPT


def test_default_system_prompt_example_character_paragraphs_have_no_action_or_focus_wording():
    # The OLD format had "action"/"focus" as per-character clause labels
    # (e.g. "appearance, clothes, action, focus"). The new CHARACTER
    # PARAGRAPHS are PERSISTENT IDENTITY ONLY — no pose/action/focus — so
    # the example's Sera/Jae paragraphs must not mention either word (the
    # word "focus" is fine elsewhere, e.g. "sharp focus" in the composition
    # sentence describing camera focus, which is NOT a per-character clause).
    match = re.search(r"Sera: .*?;", DEFAULT_SYSTEM_PROMPT)
    assert match is not None
    sera_paragraph = match.group(0)
    match2 = re.search(r"Jae: .*?;", DEFAULT_SYSTEM_PROMPT)
    assert match2 is not None
    jae_paragraph = match2.group(0)
    for paragraph in (sera_paragraph, jae_paragraph):
        assert "action" not in paragraph.lower(), paragraph
        assert "focus" not in paragraph.lower(), paragraph


def test_panel_delimiter_template_shape():
    assert PANEL_DELIMITER_TEMPLATE == "=== PANEL {n} ==="
    assert PANEL_DELIMITER_TEMPLATE.format(n=3) == "=== PANEL 3 ==="


def test_synopsis_delimiter_shape():
    assert SYNOPSIS_DELIMITER == "=== SYNOPSIS ==="


def test_node_input_types_contract():
    schema = LLMPanels.INPUT_TYPES()
    required = schema["required"]
    assert required["brief"][0] == "STRING"
    assert required["api_key"][0] == "STRING"
    assert required["api_key"][1]["default"] == ""
    assert required["model"][0] == "STRING"
    assert required["model"][1]["default"] == DEFAULT_MODEL
    assert "num_panels" not in required

    optional = schema["optional"]
    assert optional["target_panels"][0] == "INT"
    assert optional["target_panels"][1] == {"default": 0, "min": 0, "max": 24}
    assert optional["base_url"][1]["default"] == DEFAULT_BASE_URL
    assert optional["system_prompt"][1]["default"] == DEFAULT_SYSTEM_PROMPT
    assert optional["character_bible"][1]["default"] == ""
    assert optional["previous_panels"][0] == "STRING"
    assert optional["previous_panels"][1]["default"] == ""
    assert optional["synopsis"][0] == "STRING"
    assert optional["synopsis"][1]["default"] == ""
    assert optional["temperature"][1] == {"default": 0.8, "min": 0.0, "max": 2.0, "step": 0.05}
    assert optional["max_tokens"][1] == {"default": 2048, "min": 64, "max": 32768}
    assert optional["seed"][1] == {"default": 0, "min": 0}

    assert LLMPanels.CATEGORY == "AnimaFlow/llm"
    assert LLMPanels.FUNCTION == "generate"
    assert LLMPanels.RETURN_TYPES == ("STRING", "STRING")
    assert LLMPanels.RETURN_NAMES == ("panels_text", "synopsis")


ALL_TESTS = [
    test_build_messages_roles_and_brief,
    test_build_messages_target_panels_auto_when_zero_or_negative,
    test_build_messages_target_panels_cap_when_positive,
    test_build_messages_folds_character_bible,
    test_build_messages_omits_character_bible_section_when_blank,
    test_build_messages_no_continuation_context_by_default,
    test_build_messages_folds_synopsis_and_frames_continuation,
    test_build_messages_folds_previous_panels_and_frames_continuation,
    test_build_messages_blank_previous_panels_and_synopsis_no_continuation_framing,
    test_build_payload_seed_omitted_when_zero,
    test_build_payload_seed_present_when_positive,
    test_build_payload_negative_seed_treated_like_zero,
    test_build_payload_correct_keys_and_values,
    test_extract_content_happy_path,
    test_extract_content_malformed_not_a_dict,
    test_extract_content_malformed_missing_choices,
    test_extract_content_malformed_empty_choices,
    test_extract_content_malformed_choice_not_dict,
    test_extract_content_malformed_missing_message,
    test_extract_content_malformed_message_not_dict,
    test_extract_content_malformed_content_not_string,
    test_split_panels_and_synopsis_marker_present,
    test_split_panels_and_synopsis_marker_absent,
    test_split_panels_and_synopsis_blank_content,
    test_split_panels_and_synopsis_variable_equals_and_case_insensitive,
    test_split_panels_and_synopsis_only_splits_on_first_marker,
    test_split_panels_and_synopsis_end_marker_rides_along_with_synopsis,
    test_default_system_prompt_mentions_delimiter_and_background_label,
    test_default_system_prompt_mentions_continuation_and_synopsis_block,
    test_default_system_prompt_panel_count_is_upper_cap_not_minimum,
    test_default_system_prompt_mentions_end_completion_marker,
    test_default_system_prompt_mentions_story_marker,
    test_default_system_prompt_mentions_exact_shape_and_placeholders,
    test_default_system_prompt_mentions_example_section_and_sera_jae_lines,
    test_default_system_prompt_mentions_persistent_identity_and_appearance_order,
    test_default_system_prompt_mentions_background_setting_bible,
    test_default_system_prompt_mentions_composition_sentence_rule,
    test_default_system_prompt_mentions_shot_line_rule,
    test_default_system_prompt_no_composition_camera_lighting_labels,
    test_default_system_prompt_example_character_paragraphs_have_no_action_or_focus_wording,
    test_panel_delimiter_template_shape,
    test_synopsis_delimiter_shape,
    test_node_input_types_contract,
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
