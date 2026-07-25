"""PanelBatch — splits a multi-panel labeled-prose text into a per-panel LIST.

Thin node wrapper; all logic lives in `_panel_parser_helpers`. Pairs with
`LLMPanels` (wired straight from its `panels_text` output, or pasted
manually): `panel`, `story`, and `panel_index` are emitted as ComfyUI LIST
outputs (`OUTPUT_IS_LIST`), so a downstream CLIP -> KSampler -> SaveImage
chain runs once per panel in a single queue run; `count` stays a single
scalar.

Each panel block is split twice: first `split_panels` peels the text apart
on `=== PANEL n ===` delimiters, then `split_panel_body` peels each panel
apart on its `--- STORY ---` marker — `panel` is the image-prompt half
(STORY block removed, so it never reaches the text encoder) and `story` is
the narration/dialogue half (may be `""` if a panel has no STORY block).

`start_index` supports cross-batch ordering for story continuation: batch 1
(default `start_index=1`) yields indices 1..N; batch 2 (e.g.
`start_index=5`, continuing from a 4-panel batch 1) yields indices 5..(5+M-1),
so downstream SaveImage filenames stay globally ordered across batches.
"""

from __future__ import annotations

from ._panel_parser_helpers import (
    DEFAULT_DELIMITER_REGEX,
    DEFAULT_STORY_REGEX,
    split_panel_body,
    split_panels,
)


class PanelBatch:
    CATEGORY = "AnimaFlow/panel"
    EXPERIMENTAL = True
    FUNCTION = "parse"
    RETURN_TYPES = ("STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("panel", "story", "panel_index", "count")
    OUTPUT_IS_LIST = (True, True, True, False)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "panels_text": ("STRING", {"multiline": True, "default": ""}),
            },
            "optional": {
                "delimiter_regex": ("STRING", {"default": DEFAULT_DELIMITER_REGEX}),
                "story_delimiter_regex": ("STRING", {"default": DEFAULT_STORY_REGEX}),
                "start_index": ("INT", {"default": 1, "min": 0}),
            },
        }

    def parse(
        self,
        panels_text,
        delimiter_regex=DEFAULT_DELIMITER_REGEX,
        story_delimiter_regex=DEFAULT_STORY_REGEX,
        start_index=1,
    ):
        blocks = split_panels(panels_text, delimiter_regex)
        if not blocks:
            return ([], [], [], 0)

        panels: list[str] = []
        stories: list[str] = []
        for block in blocks:
            image_prompt, story = split_panel_body(block, story_delimiter_regex)
            panels.append(image_prompt)
            stories.append(story)

        indices = list(range(start_index, start_index + len(panels)))
        return (panels, stories, indices, len(panels))
