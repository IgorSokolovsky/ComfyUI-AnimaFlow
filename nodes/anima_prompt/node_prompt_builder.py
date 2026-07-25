"""PromptBuilder — generic, template-driven prompt composer node.

Thin node wrapper; all logic lives in `_prompt_builder_helpers`. The dynamic
per-token fields are supplied by the frontend through a single JSON string
widget (`prompt_builder_state`) rather than one widget per token. That widget
is a real, natively-serialized `required` STRING input — the frontend hides
it (like `template`) and writes to it directly, rather than relying on a
`hidden` input injected via an `app.graphToPrompt` wrap, which does NOT
reliably reach the backend in this ComfyUI (see `js/anima_prompt/prompt_builder/`).
"""

from __future__ import annotations

from ._prompt_builder_helpers import (
    DEFAULT_TEMPLATE,
    build_field_text,
    build_prompt_data,
    parse_state,
    parse_tokens,
    render_prompt,
)


class PromptBuilder:
    CATEGORY = "AnimaFlow/anima_prompt"
    EXPERIMENTAL = True
    FUNCTION = "build"
    RETURN_TYPES = ("STRING", "PROMPT_DATA")
    RETURN_NAMES = ("prompt", "data")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template": ("STRING", {"multiline": True, "default": DEFAULT_TEMPLATE}),
                "prompt_builder_state": ("STRING", {"default": "{}"}),
            },
        }

    def build(self, template, prompt_builder_state="{}"):
        fields = parse_state(prompt_builder_state)
        tokens = parse_tokens(template)
        values = {t: str(fields.get(t, "")).strip() for t in tokens}
        prompt_flat = render_prompt(template, values)
        structured_str = build_field_text(values)
        data = build_prompt_data(template, values, prompt_flat, structured_str)
        # Primary output is now the labeled-prose string (see the
        # `_prompt_builder_helpers.PromptData` docstring); `.prompt` on the
        # PROMPT_DATA output stays the flat string for wired downstream nodes.
        return (structured_str, data)
