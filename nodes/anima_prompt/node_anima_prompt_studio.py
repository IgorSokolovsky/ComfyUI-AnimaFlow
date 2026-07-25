"""AnimaPromptStudio — dynamic add/remove/reorder prompt-block editor.

Plain `STRING`x2 output (not a custom type), so it wires directly into core
`CLIPTextEncode`, `AnimaConditioningEncode`, or any other pack's text node.
The block editor's own state (`blocks_state`) is authored via the node's JS
UI (`js/anima_prompt/anima_prompt_studio/`) — this class is thin, delegating all real
logic to `_anima_prompt_studio_helpers`. See that module's docstring for the
position-preserving pin/correction algorithm.

No width/height widgets, no Mod Guidance, no wildcard support — explicitly
out of scope for this node per the approved plan.
"""

from __future__ import annotations

from ._anima_prompt_studio_helpers import (
    DEFAULT_BLOCKS_STATE_JSON,
    build_prompt_studio_output,
    is_changed_digest,
)
from ._rules_helpers import PROFILE_CHOICES


class AnimaPromptStudio:
    CATEGORY = "AnimaFlow/anima_prompt"
    FUNCTION = "compose"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")
    OUTPUT_TOOLTIPS = (
        "The assembled positive prompt: enabled positive blocks joined in pane order by `separator`. "
        "Pinned blocks' text is kept verbatim at its own position; the non-pinned \"rest\" of the pane is "
        "optionally run through the Prompt Rules engine as a single pass first (see rules_correction_enabled).",
        "The assembled negative prompt — the same assembly rule as positive, applied to the negative pane's "
        "own blocks (the Rules engine call, when enabled, covers both panes' non-pinned text together).",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "blocks_state": ("STRING", {
                    "multiline": True,
                    "default": DEFAULT_BLOCKS_STATE_JSON,
                    "tooltip": (
                        "The block editor's own serialized state — JSON "
                        '`{"positive": [...], "negative": [...]}`, each block '
                        '`{id, type, label, text, enabled, pin}` — authored via this node\'s own UI '
                        "(add/remove/reorder/enable/pin rows in the positive and negative panes), not meant "
                        "to be hand-typed. The JS frontend hides this widget from view and writes to it on "
                        "every edit, but it is a REAL, normally-serializing widget — the backend always "
                        "receives whatever the editor currently shows. A corrupted or hand-edited value that "
                        "isn't a valid `{positive, negative}` object is tolerated (treated as an empty "
                        "editor) rather than raising."
                    ),
                }),
                "separator": ("STRING", {
                    "default": ", ",
                    "tooltip": (
                        "The string used to join enabled blocks' text within a pane, and to split/join the "
                        "non-pinned \"rest\" portion around a single Prompt Rules correction pass. Use \", \" "
                        "for tag-style prompts (Anima/Illustrious/Pony); use \" \", \". \", or a newline for "
                        "prose models (Flux/Wan). This is the ONE configured separator — nothing in this "
                        "node hardcodes comma-splitting against it."
                    ),
                }),
                "rules_correction_enabled": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "When on, each pane's non-pinned block text — folded into one \"rest\" string per "
                        "pane — is run through the in-repo Prompt Rules engine (the same entry point "
                        "`Prompt Rules` (text) uses) before final assembly. Pinned blocks are never touched "
                        "by this — see each block's pin control tooltip. Off (default) is a byte-identical "
                        "passthrough: blocks are just joined by `separator`, with no engine call at all."
                    ),
                }),
            },
            "optional": {
                "rules_profile": (PROFILE_CHOICES, {
                    "default": "anima",
                    "tooltip": (
                        "Only used when rules_correction_enabled is on: which tag-profile the Prompt Rules "
                        "engine parses/renders the non-pinned text against (anima/illustrious/flux/raw) — "
                        "must match the vocabulary your block text is actually written in."
                    ),
                }),
                "rules_sheets": ("STRING", {
                    "default": "*",
                    "tooltip": (
                        "Only used when rules_correction_enabled is on: which `rules/*.yaml` character "
                        "sheets to apply — comma-separated names (e.g. \"celica\") or \"*\" for every "
                        "sheet on disk. Mirrors the same widget on `Prompt Rules` / `Prompt Rules (CLIP)`."
                    ),
                }),
            },
        }

    def compose(
        self,
        blocks_state,
        separator=", ",
        rules_correction_enabled=False,
        rules_profile="anima",
        rules_sheets="*",
    ):
        return build_prompt_studio_output(
            blocks_state, separator, rules_correction_enabled, rules_profile, rules_sheets,
        )

    @classmethod
    def IS_CHANGED(
        cls,
        blocks_state,
        separator=", ",
        rules_correction_enabled=False,
        rules_profile="anima",
        rules_sheets="*",
    ):
        return is_changed_digest(
            blocks_state, separator, rules_correction_enabled, rules_profile, rules_sheets,
        )


__all__ = ("AnimaPromptStudio",)
