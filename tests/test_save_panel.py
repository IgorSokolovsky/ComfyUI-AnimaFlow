"""Plain-script tests for the Save Panel (metadata) node's pure logic.

Run directly: `python tests/test_save_panel.py` (no pytest, per project convention).

Only the pure `build_text_metadata` helper is exercised here — this file
deliberately does NOT import torch, PIL, or folder_paths (none of which are
installed in this headless test environment); those live behind lazy
imports inside `nodes/node_save_panel.py`'s `save()` method. The actual
image-tensor -> PNG-with-metadata save can only be verified live inside a
running ComfyUI instance.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json

from nodes.panel._save_panel_helpers import (
    COMFY_PROMPT_KEY,
    WEBTOON_PANEL_INDEX_KEY,
    WEBTOON_PROMPT_KEY,
    WEBTOON_STORY_KEY,
    build_text_metadata,
)
from nodes.panel.node_save_panel import SavePanel


def test_build_text_metadata_distinct_webtoon_keys():
    metadata = build_text_metadata("a prompt", "some story", 3)
    assert metadata[WEBTOON_PROMPT_KEY] == "a prompt"
    assert metadata[WEBTOON_STORY_KEY] == "some story"
    assert metadata[WEBTOON_PANEL_INDEX_KEY] == "3"
    assert WEBTOON_PROMPT_KEY == "webtoon_prompt"
    assert WEBTOON_STORY_KEY == "webtoon_story"
    assert WEBTOON_PANEL_INDEX_KEY == "webtoon_panel_index"


def test_build_text_metadata_empty_prompt_and_story_omitted():
    metadata = build_text_metadata("", "   ", 0)
    assert WEBTOON_PROMPT_KEY not in metadata
    assert WEBTOON_STORY_KEY not in metadata
    assert WEBTOON_PANEL_INDEX_KEY not in metadata
    assert metadata == {}


def test_build_text_metadata_panel_index_zero_omitted_positive_included():
    metadata_zero = build_text_metadata("p", "s", 0)
    assert WEBTOON_PANEL_INDEX_KEY not in metadata_zero

    metadata_neg = build_text_metadata("p", "s", -1)
    assert WEBTOON_PANEL_INDEX_KEY not in metadata_neg

    metadata_pos = build_text_metadata("p", "s", 7)
    assert metadata_pos[WEBTOON_PANEL_INDEX_KEY] == "7"


def test_build_text_metadata_only_prompt_no_story():
    metadata = build_text_metadata("only prompt here", "", 0)
    assert metadata == {WEBTOON_PROMPT_KEY: "only prompt here"}


def test_build_text_metadata_strips_whitespace():
    metadata = build_text_metadata("  padded prompt  ", "  padded story  ", 1)
    assert metadata[WEBTOON_PROMPT_KEY] == "padded prompt"
    assert metadata[WEBTOON_STORY_KEY] == "padded story"


def test_build_text_metadata_comfy_prompt_json_dumped():
    comfy_prompt = {"1": {"class_type": "KSampler", "inputs": {"seed": 42}}}
    metadata = build_text_metadata("p", "s", 1, comfy_prompt=comfy_prompt)
    assert metadata[COMFY_PROMPT_KEY] == json.dumps(comfy_prompt)
    assert json.loads(metadata[COMFY_PROMPT_KEY]) == comfy_prompt
    assert COMFY_PROMPT_KEY == "prompt"


def test_build_text_metadata_comfy_prompt_none_omitted():
    metadata = build_text_metadata("p", "s", 1, comfy_prompt=None)
    assert COMFY_PROMPT_KEY not in metadata


def test_build_text_metadata_extra_pnginfo_json_dumped_per_key():
    extra_pnginfo = {"workflow": {"nodes": [1, 2, 3]}}
    metadata = build_text_metadata("p", "s", 1, extra_pnginfo=extra_pnginfo)
    assert metadata["workflow"] == json.dumps({"nodes": [1, 2, 3]})
    assert json.loads(metadata["workflow"]) == {"nodes": [1, 2, 3]}


def test_build_text_metadata_extra_pnginfo_multiple_keys():
    extra_pnginfo = {"workflow": {"a": 1}, "other_meta": ["x", "y"]}
    metadata = build_text_metadata("p", "s", 1, extra_pnginfo=extra_pnginfo)
    assert metadata["workflow"] == json.dumps({"a": 1})
    assert metadata["other_meta"] == json.dumps(["x", "y"])


def test_build_text_metadata_extra_pnginfo_non_dict_ignored():
    metadata = build_text_metadata("p", "s", 1, extra_pnginfo="not a dict")
    assert "workflow" not in metadata
    metadata2 = build_text_metadata("p", "s", 1, extra_pnginfo=None)
    assert set(metadata2.keys()) == {WEBTOON_PROMPT_KEY, WEBTOON_STORY_KEY, WEBTOON_PANEL_INDEX_KEY}


def test_build_text_metadata_all_values_are_strings():
    metadata = build_text_metadata(
        "p", "s", 5, extra_pnginfo={"workflow": {"a": 1}}, comfy_prompt={"1": {}}
    )
    for value in metadata.values():
        assert isinstance(value, str), value


def test_build_text_metadata_no_key_collisions_between_webtoon_and_comfy():
    metadata = build_text_metadata(
        "p", "s", 5, extra_pnginfo={"workflow": {"a": 1}}, comfy_prompt={"1": {}}
    )
    assert set(metadata.keys()) == {
        WEBTOON_PROMPT_KEY,
        WEBTOON_STORY_KEY,
        WEBTOON_PANEL_INDEX_KEY,
        COMFY_PROMPT_KEY,
        "workflow",
    }
    # None of the webtoon_* keys equal the stock comfy keys.
    assert WEBTOON_PROMPT_KEY != COMFY_PROMPT_KEY
    assert WEBTOON_PROMPT_KEY != "workflow"
    assert WEBTOON_STORY_KEY != COMFY_PROMPT_KEY
    assert WEBTOON_STORY_KEY != "workflow"


def test_node_input_types_contract():
    schema = SavePanel.INPUT_TYPES()
    required = schema["required"]
    assert required["images"][0] == "IMAGE"
    assert required["filename_prefix"][0] == "STRING"
    assert required["filename_prefix"][1]["default"] == "webtoon/panel"

    optional = schema["optional"]
    assert optional["prompt_text"][0] == "STRING"
    assert optional["prompt_text"][1]["default"] == ""
    assert optional["story_text"][0] == "STRING"
    assert optional["story_text"][1]["default"] == ""
    assert optional["panel_index"][0] == "INT"
    assert optional["panel_index"][1] == {"default": 0, "min": 0}

    hidden = schema["hidden"]
    assert hidden["prompt"] == "PROMPT"
    assert hidden["extra_pnginfo"] == "EXTRA_PNGINFO"

    assert not hasattr(SavePanel, "INPUT_IS_LIST")
    assert SavePanel.CATEGORY == "AnimaFlow/panel"
    assert SavePanel.FUNCTION == "save"
    assert SavePanel.RETURN_TYPES == ()
    assert SavePanel.OUTPUT_NODE is True


ALL_TESTS = [
    test_build_text_metadata_distinct_webtoon_keys,
    test_build_text_metadata_empty_prompt_and_story_omitted,
    test_build_text_metadata_panel_index_zero_omitted_positive_included,
    test_build_text_metadata_only_prompt_no_story,
    test_build_text_metadata_strips_whitespace,
    test_build_text_metadata_comfy_prompt_json_dumped,
    test_build_text_metadata_comfy_prompt_none_omitted,
    test_build_text_metadata_extra_pnginfo_json_dumped_per_key,
    test_build_text_metadata_extra_pnginfo_multiple_keys,
    test_build_text_metadata_extra_pnginfo_non_dict_ignored,
    test_build_text_metadata_all_values_are_strings,
    test_build_text_metadata_no_key_collisions_between_webtoon_and_comfy,
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
