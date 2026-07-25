"""Prompt Rules — ComfyUI encode nodes for the clean-room rules engine (`core/`).

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

_CATEGORY = "AnimaFlow/anima_prompt"


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
        # ruleset. Authored via the Rule Builder overlay (`js/anima_prompt/rule_builder/`).
        "embedded_rules": ("STRING", {"default": "", "multiline": True}),
        "log_trace": ("BOOLEAN", {"default": True}),
    }


class PromptRulesText:
    """`Prompt Rules` (text) — resolves + applies rulesets, returns strings."""

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
