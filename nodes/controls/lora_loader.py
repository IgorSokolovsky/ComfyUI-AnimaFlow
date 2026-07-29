"""`Anima LoRA Loader` -- stack any number of LoRAs onto a MODEL (and,
optionally, a CLIP) in one node (contract: docs/lora-loader-design.md, plan
`sunny-purring-boole` Slice 1). Frontend-driven, thin Python (§3/§4): the
node's whole row list lives in the declared, natively-serialized
`lora_state` STRING widget -- never `hidden` + `graphToPrompt` (see the
design doc §3 for why that handshake is forbidden in this pack) -- and this
class only parses it, applies every switched-on row in order, and joins the
picked trigger words. Everything ComfyUI-specific (state parsing, the
memory-mode cache, the actual apply call) lives in `_lora_helpers.py`.

`clip` is `optional` (§4's node-surface table) -- a REQUIRED socket
hard-fails the queue the moment nothing is wired to it, and a model-only
LoRA stack (no text encode involved downstream) is a legitimate use.
"""
from __future__ import annotations

from typing import Any

from ._lora_helpers import LoraCache, apply_loras, parse_state

# See control_panel.py's own CATEGORY comment: Title Case in the picker, the
# folder underneath (`nodes/controls/`, `js/controls/`) stays snake_case.
CATEGORY = "AnimaFlow/Controls"

# Frozen for `tests/test_lora_state.py`'s required-key-order regression
# (`.claude/CLAUDE.md`: widget order is append-only -- `9388cf9` broke this
# once). A future ADDITION goes at the end of `required`, or into
# `optional` -- never inserted mid-list.
REQUIRED_KEY_ORDER = ("model", "lora_state")


class AnimaLoraLoader:
    """`Anima LoRA Loader` -- stack as many LoRAs as you want, each with its
    own on/off switch, model + clip strength, and picked trigger words.
    Applies every switched-on row to MODEL (and CLIP, if wired) in row
    order; the `triggers` output carries only the words picked on rows that
    actually applied -- a missing or corrupt file contributes nothing even
    if its row is switched on, while a deliberately zero-strength row still
    counts (see `_lora_helpers.apply_loras`'s own docstring, §1b)."""

    DESCRIPTION = (
        "Stack as many LoRAs as you want in one node. Each row has its own "
        "on/off switch, model + clip strength, and picked trigger words -- "
        "the switched-on picks come out of the triggers output as plain "
        "text you wire into your prompt. IMPORTANT: route this node's OWN "
        "clip output onward to your text encode, not the checkpoint's raw "
        "one -- wiring the raw CLIP still applies every LoRA's model "
        "effect, but its CLIP effect silently vanishes, so trigger words "
        "read differently than intended with no error at all."
    )

    CATEGORY = CATEGORY
    EXPERIMENTAL = True
    FUNCTION = "apply"
    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "triggers")
    OUTPUT_TOOLTIPS = (
        "The model with every switched-on LoRA applied, in row order.",
        "The CLIP with every switched-on LoRA applied -- passes through "
        "unchanged if no CLIP was connected.",
        "The trigger words picked in the info panel, from rows that "
        "actually applied only, joined as plain text for your prompt.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (
                    "MODEL",
                    {"tooltip": "The diffusion model every switched-on LoRA row is applied to."},
                ),
                "lora_state": (
                    "STRING",
                    {
                        "default": "{}",
                        "tooltip": (
                            "Serialized LoRA stack (JSON): each row's picked "
                            "file, on/off switch, model/clip strength, and "
                            "selected trigger words, plus the memory-use mode "
                            "and trigger-word separator. Written by this "
                            "node's own frontend widget after every edit -- "
                            "hidden for rendering only, not meant to be "
                            "hand-edited."
                        ),
                    },
                ),
            },
            "optional": {
                "clip": (
                    "CLIP",
                    {
                        "tooltip": (
                            "The CLIP (text encoder) every switched-on LoRA "
                            "row is also applied to. Optional, but route the "
                            "checkpoint's CLIP in here and this node's OWN "
                            "clip output onward to your text encode -- "
                            "leaving it unwired is only correct for a "
                            "model-only setup (see this node's DESCRIPTION)."
                        ),
                    },
                ),
            },
        }

    def __init__(self) -> None:
        # Per-node-instance cache implementing the three memory modes
        # (§1b) -- lives here, not at module scope, so it survives between
        # runs of THIS node the way ComfyUI already keeps node instances
        # alive between queue executions (see `_lora_helpers.LoraCache`'s
        # own docstring for the mode semantics and the `last`-mode fix).
        self._cache = LoraCache()

    def apply(self, model: Any, lora_state: str = "{}", clip: Any = None):
        state = parse_state(lora_state)
        model, clip, triggers = apply_loras(model, clip, state, self._cache)
        return (model, clip, triggers)


NODE_CLASS_MAPPINGS = {"AnimaLoraLoader": AnimaLoraLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaLoraLoader": "Anima LoRA Loader"}
