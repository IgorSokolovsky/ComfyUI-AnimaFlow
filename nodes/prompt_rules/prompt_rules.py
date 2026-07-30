"""Prompt Rules — ComfyUI encode nodes for the clean-room rules engine (`src/prompt_rules/core/`).

Two thin variants (contract: docs/nodes-and-api.md §1), differing only in
output type:
  - `PromptRulesClip` -> `("CONDITIONING", "CONDITIONING")` (encodes via CLIP)
  - `PromptRulesText` -> `("STRING", "STRING")`

All resolution (file sheets + embedded ruleset), engine plumbing, and
`IS_CHANGED` hashing live in `_rules_helpers`; these classes only wire up
ComfyUI's `INPUT_TYPES`/`IS_CHANGED` and, for the CLIP variant, the actual
CLIP encode call.
"""
from __future__ import annotations

from ._rules_helpers import PROFILE_CHOICES, is_changed_digest, run_rules

# Picker category is Title Case ("Prompt"); the folder/package underneath it
# stays snake_case (`nodes/prompt_rules/`, `js/prompt_rules/`) because Python
# package names must be importable. "Folder and category agree" now means
# "agree case-insensitively", not literally.
_CATEGORY = "AnimaFlow/Prompt"


def _shared_required() -> dict:
    return {
        "positive": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
        "negative": ("STRING", {"multiline": True, "dynamicPrompts": True, "default": ""}),
        "profile": (PROFILE_CHOICES, {"default": PROFILE_CHOICES[0]}),
        "sheets": ("STRING", {"default": "*"}),
    }


def _shared_optional() -> dict:
    return {
        # Serialized-STRING state pattern (dynamic-node-frontend skill): a
        # real widget the JS hides and writes to directly, rather than
        # ComfyUI's reserved `hidden` INPUT_TYPES section (which only
        # auto-populates a fixed set of special names). Empty = no embedded
        # ruleset. Authored via the Rule Builder overlay (`js/prompt_rules/rule_builder/`).
        "embedded_rules": ("STRING", {"default": "", "multiline": True}),
        "log_trace": ("BOOLEAN", {"default": True}),
    }


class PromptRulesText:
    """`Prompt Rules` (text) — resolves + applies rulesets, returns strings."""

    DESCRIPTION = (
        "Applies your character-sheet prompt rules to positive/negative, "
        "then returns plain text. Use this variant when the next "
        "node needs strings, not conditioning -- for conditioning straight "
        "out, use Prompt Rules (CLIP) instead. Which sheets apply is picked "
        "by the sheets field, and a per-node ruleset from the Rule Builder "
        "button is layered on top."
    )

    CATEGORY = _CATEGORY
    EXPERIMENTAL = True
    FUNCTION = "process"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": _shared_required(), "optional": _shared_optional()}

    def process(self, positive, negative, profile, sheets="*", embedded_rules="", log_trace=True):
        positive_out, negative_out, _trace = run_rules(
            positive, negative, profile, sheets, embedded_rules, log_trace=log_trace,
        )
        return (positive_out, negative_out)

    @classmethod
    def IS_CHANGED(cls, positive, negative, profile, sheets="*", embedded_rules="", log_trace=True):
        return is_changed_digest(positive, negative, profile, sheets, embedded_rules)


class PromptRulesClip:
    """`Prompt Rules (CLIP)` — resolves + applies rulesets, then CLIP-encodes."""

    DESCRIPTION = (
        "Applies your character-sheet prompt rules to positive/negative, "
        "then CLIP-encodes it. Wire clip in from your checkpoint (or LoRA "
        "loader) so this node can encode -- if you just want the resolved "
        "strings instead (for example, ahead of a natural-language "
        "encoder), use the Prompt Rules (text) variant instead."
    )

    CATEGORY = _CATEGORY
    EXPERIMENTAL = True
    FUNCTION = "process"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")

    @classmethod
    def INPUT_TYPES(cls):
        required = {"clip": ("CLIP", {})}
        required.update(_shared_required())
        return {"required": required, "optional": _shared_optional()}

    def process(self, clip, positive, negative, profile, sheets="*", embedded_rules="", log_trace=True):
        positive_out, negative_out, _trace = run_rules(
            positive, negative, profile, sheets, embedded_rules, log_trace=log_trace,
        )
        return (_encode(clip, positive_out), _encode(clip, negative_out))

    @classmethod
    def IS_CHANGED(cls, clip, positive, negative, profile, sheets="*", embedded_rules="", log_trace=True):
        return is_changed_digest(positive, negative, profile, sheets, embedded_rules)


def _encode(clip, text: str) -> list:
    # VERIFY-IN-COMFYUI: standard tokenize/encode_from_tokens CLIP path
    # (the same shape ComfyUI's own CLIPTextEncode uses); needs a live CLIP
    # object from a real ComfyUI process, not exercised by the plain-script
    # tests (`clip` is a mocked/None-free path only reachable inside ComfyUI).
    tokens = clip.tokenize(text)
    cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
    return [[cond, {"pooled_output": pooled}]]
