"""SceneCreator — deterministic scene-prompt composer node.

Thin node wrapper; all logic lives in `_scene_creator_helpers` (plus the
shared `render_prompt` from `_prompt_builder_helpers` and `unwrap_value` /
`ContainsAnyDict` from `_prompt_combiner_helpers`). A scene template with
`{wildcards}` composes scene fields; the reserved `{characters}` token is
filled by assembling the enabled characters, each a dynamic wired input
socket (STRING or PROMPT_DATA identity tags) plus per-character
enabled/appearance/action/focus state and a list of addable outfit entries
(each with its own optional wired socket that overrides that entry's
outfit text when connected) supplied by the frontend via the `scene_state`
STRING widget's JSON (a normal, natively-serialized widget the frontend
hides — same mechanism as the `template` widget — NOT a hidden input +
graphToPrompt injection, which doesn't reliably reach the backend). The
reserved `{backgrounds}` token is filled the same way from the enabled
backgrounds, each a dynamic wired socket plus per-background enabled/text
state. The wired socket values themselves arrive in `**kwargs` keyed by
socket name (real connections).

The node's primary output is a labeled-PROSE document (see
`build_scene_text`) rather than a flat comma-joined string or JSON; the
flat string still exists on PROMPT_DATA's `.prompt` for wired downstream
nodes.
"""

from __future__ import annotations

from ..anima_prompt._prompt_builder_helpers import render_prompt
from ..anima_prompt._prompt_combiner_helpers import ContainsAnyDict, unwrap_value
from ._scene_creator_helpers import (
    DEFAULT_TEMPLATE,
    RESERVED_BACKGROUNDS_TOKEN,
    RESERVED_CHARACTERS_TOKEN,
    assemble_background_block,
    assemble_characters,
    build_scene_data,
    build_scene_text,
    flatten_characters_block,
    parse_scene_state,
)


class SceneCreator:
    CATEGORY = "AnimaFlow/panel"
    EXPERIMENTAL = True
    FUNCTION = "build"
    RETURN_TYPES = ("STRING", "PROMPT_DATA")
    RETURN_NAMES = ("scene", "data")

    RESERVED_CHARACTERS_TOKEN = RESERVED_CHARACTERS_TOKEN
    RESERVED_BACKGROUNDS_TOKEN = RESERVED_BACKGROUNDS_TOKEN

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "template": ("STRING", {"multiline": True, "default": DEFAULT_TEMPLATE}),
                "scene_state": ("STRING", {"default": "{}"}),
            },
            "optional": ContainsAnyDict(),
        }

    def build(self, template, scene_state="{}", **kwargs):
        fields, characters, backgrounds = parse_scene_state(scene_state)

        characters_list = assemble_characters(characters, kwargs)
        background_block = assemble_background_block(backgrounds, kwargs)

        structured_str = build_scene_text(template, fields, characters_list, background_block)

        # Flat path (back-compat): still assemble a flat comma-joined scene
        # string for PROMPT_DATA's `.prompt`, same shape as before this change.
        flat_values = dict(fields)
        flat_values[RESERVED_CHARACTERS_TOKEN] = flatten_characters_block(characters_list)
        flat_values[RESERVED_BACKGROUNDS_TOKEN] = background_block
        prompt_flat = render_prompt(template, flat_values)

        data = build_scene_data(template, flat_values, prompt_flat, structured_str)

        slots = {name: unwrap_value(value) for name, value in kwargs.items()}

        # Primary output is now the labeled-prose string; `.prompt` on the
        # PROMPT_DATA output stays the flat string for wired downstream nodes.
        return {"ui": {"text": [structured_str], "slots": slots}, "result": (structured_str, data)}
