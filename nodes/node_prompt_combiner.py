"""PromptCombiner — combines several named connection inputs via a template.

Thin node wrapper; all logic lives in `_prompt_combiner_helpers` (and the
shared `parse_tokens` / `render_prompt` from `_prompt_builder_helpers`). The
per-slot inputs are dynamically named connections (character, background,
style, ...) added by the frontend, carrying either a plain STRING or a
PROMPT_DATA dict; they arrive here in `**kwargs` keyed by slot name.
"""

from __future__ import annotations

from ._prompt_builder_helpers import parse_tokens, render_prompt
from ._prompt_combiner_helpers import (
    ContainsAnyDict,
    build_combined_prompt_data,
    build_field_text,
    unwrap_value,
)

DEFAULT_TEMPLATE = "{character}, {background}, {style}"


class PromptCombiner:
    CATEGORY = "AnimaFlow/prompt"
    EXPERIMENTAL = True
    FUNCTION = "combine"
    RETURN_TYPES = ("STRING", "PROMPT_DATA")
    RETURN_NAMES = ("prompt", "data")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template": ("STRING", {"multiline": True, "default": "{character}, {background}"}),
            },
            "optional": ContainsAnyDict(),
        }

    def combine(self, template, **kwargs):
        tokens = parse_tokens(template)
        values = {token: unwrap_value(kwargs.get(token)) for token in tokens}
        prompt = render_prompt(template, values)
        structured_str = build_field_text(values)
        data = build_combined_prompt_data(template, values, prompt, structured_str)
        # Primary output is now the labeled-prose string; `.prompt` on the
        # PROMPT_DATA output stays the flat string for wired downstream nodes.
        return {"ui": {"text": [structured_str]}, "result": (structured_str, data)}
