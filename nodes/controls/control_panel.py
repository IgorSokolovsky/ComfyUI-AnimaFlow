"""Anima Control Panel -- one row per control (sampler, scheduler, seed, int,
float, bool, empty latent), one output slot per row (contract:
docs/control-panel-design.md).

State lives on a declared, natively-serialized STRING widget (`panel_state`),
written by the frontend after every mutation -- NOT a `hidden` INPUT_TYPES
entry, and nothing here relies on a `graphToPrompt` wrapper (see
`.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` §2 for why that
silently fails in production; the design doc's §1 "Deliberately NOT copied"
explains why this pack forked from Pixaroma's handshake here).

Python's job is thin: parse the state, look up each fixed output slot's row
by SLOT (not by display position -- dragging a row to reorder it must never
move its wire, §4), and coerce that row's value to the right Python type.
All the actual coercion logic lives in `_rows_helpers.py`, kept pure so it --
and its tests -- never need torch/comfy.

Unlike `loader_panel.py`, this node does NOT scan the graph to skip
unreferenced output slots. Every row here is cheap regardless of whether
anything is wired to it -- a string pass-through, an int/float clamp, or at
worst a `torch.zeros` for a latent -- so the hidden-`PROMPT` scan and its
bookkeeping would add real complexity to buy nothing. That optimization
earns its keep on the Loader Panel specifically because loading a row there
means pulling a real model onto the GPU, which is not free.
"""
from __future__ import annotations

from ._rows_helpers import detect_state_mismatch, latent_wh_batch, parse_state, rows_by_slot, value_for_row
from ._type_helpers import ANY

# Picker category is Title Case; the folder underneath it stays snake_case
# (`nodes/controls/`, `js/controls/`) since Python package names must stay
# importable -- "folder and category agree" now means "agree
# case-insensitively", per the prompt_rules rename this repo just made.
CATEGORY = "AnimaFlow/Controls"

# Fixed output-slot budget. May grow later (a saved workflow's slot wiring
# only ever depends on `RETURN_NAMES` staying valid up to whatever count was
# in play when it was saved) -- MUST NEVER SHRINK, or an existing workflow's
# wire into `value_16` would dangle.
MAX_ROWS = 16


class AnimaControlPanel:
    """`Anima Control Panel` -- sampler/scheduler/seed/int/float/bool/latent
    rows, each wired out to its own fixed output slot."""

    DESCRIPTION = (
        "Holds sampler/scheduler/seed/int/float/bool/latent dials, one "
        "row and socket per dial. A fresh row adopts its type, range and "
        "name from whatever you plug it into first, so wire it before "
        "setting its value. Reordering rows "
        "never rewires them -- a row keeps the slot it was created with, "
        "so hover a dot if you're unsure which row it belongs to."
    )

    CATEGORY = CATEGORY
    FUNCTION = "run"
    RETURN_TYPES = (ANY,) * MAX_ROWS
    RETURN_NAMES = tuple(f"value_{i + 1}" for i in range(MAX_ROWS))
    OUTPUT_TOOLTIPS = tuple(
        (
            f"Control row output slot {i + 1}. Emits the row currently occupying "
            "this slot's value -- a sampler/scheduler name (STRING), a seed/int "
            "(INT), a float (FLOAT), a real BOOLEAN for a bool row, or a real "
            "LATENT for a latent row. Emits 0 if no row currently occupies this "
            "slot (an unresolved 'auto' row also emits 0). Wildcard-typed in "
            "Python; the frontend narrows the visible wire type per row."
        )
        for i in range(MAX_ROWS)
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "panel_state": (
                    "STRING",
                    {
                        "default": "{}",
                        "tooltip": (
                            "Serialized Control Panel state (JSON): the rows, "
                            "their kinds, current values and options. Written by "
                            "the panel's own frontend widget after every edit -- "
                            "this field is hidden for rendering only, not removed "
                            "from the graph, and is not meant to be hand-edited."
                        ),
                    },
                ),
            },
        }

    def run(self, panel_state: str = "{}"):
        # LOUD, unconditional -- this node has no "console logging" gate to
        # sit behind at all (see `loader_panel.py`'s own diagnostic logging
        # for why THAT node does; this one never grew one). A hijacked
        # `panel_state` input (2026-07-29 live bug -- `detect_state_mismatch`'s
        # own docstring has the full story) silently replaces the user's
        # ENTIRE row list with something else's STRING output, and
        # `parse_state` below already degrades that to an empty row list
        # with ZERO signal. This only OBSERVES it -- it never changes what
        # `parse_state` returns, and stays silent for the two non-noteworthy
        # cases (genuinely absent/first-run, or a value that IS this node's
        # own shape).
        mismatch_reason = detect_state_mismatch(panel_state)
        if mismatch_reason:
            print(
                f"[AnimaFlow] Anima Control Panel: panel_state did not arrive as "
                f"this node's own saved state ({mismatch_reason}). Another "
                f"extension appears to have wired something into this node's "
                f"state input -- a same-typed STRING output getting broadcast "
                f"here by something like cg-use-everywhere is a common cause. "
                f"Falling back to default rows for this run."
            )

        state = parse_state(panel_state)
        slots = rows_by_slot(state["rows"], MAX_ROWS)

        out = []
        for slot in range(1, MAX_ROWS + 1):
            row = slots.get(slot)
            if row is not None and row.get("kind") == "latent":
                out.append(_empty_latent(row.get("opts")))
            else:
                out.append(value_for_row(row))
        return tuple(out)


def _empty_latent(opts):
    """A latent row -> a real `LATENT`, matching ComfyUI's own
    `EmptyLatentImage` (`{"samples": torch.zeros([batch, 4, h // 8, w // 8])}`).
    `torch` is imported lazily, here inside the function, so `_rows_helpers.py`
    (and its tests) stay torch-free -- see the comfyui-pack-import-structure
    skill and docs/control-panel-design.md §9.
    """
    import torch

    w, h, batch = latent_wh_batch(opts)
    return {"samples": torch.zeros([batch, 4, h // 8, w // 8])}


NODE_CLASS_MAPPINGS = {"AnimaControlPanel": AnimaControlPanel}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaControlPanel": "Anima Control Panel"}
