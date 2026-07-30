"""Anima Loader Panel -- unet/vae/clip rows, each wired out to its own fixed
output slot (contract: docs/control-panel-design.md §2/§3).

Split out from the Control Panel deliberately: ComfyUI's cache signature is
per NODE and propagates to everything downstream of ANY of its outputs, so a
seed row and a unet row sharing one node would reload the model on every
seed bump. This node only holds the rarely-changing rows (unet/vae/clip);
`control_panel.py` holds the constantly-changing ones.

Same state-widget contract as the Control Panel: a declared, natively-
serialized STRING (`panel_state`), not a `hidden` input, no `graphToPrompt`
dependency. Loading itself -- including the model-loader cache and the
filename-validation error -- lives in `_loaders_helpers.py`.

A row only loads when its output slot is actually wired to something (§2
"third consequence" in the design doc): loading a row means pulling a real
MODEL/VAE/CLIP onto the GPU, and a Colab-class user with tight VRAM pays for
every row present in state whether or not anything downstream consumes it.
`run()` declares hidden `prompt`/`unique_id` inputs (unrelated to
`panel_state`, which remains the only `required` input) purely to scan which
of our own output slots the graph actually references
(`_loaders_helpers.referenced_slots`) and skips loading -- emitting the same
`0` an absent row already emits -- for every slot nothing points at.

VERIFIED (not assumed) that adding these hidden inputs does NOT pull the
whole workflow into this node's cache signature -- i.e. an unrelated edit
anywhere else in the graph does NOT invalidate this node and force a
reload. Read directly from ComfyUI's own source
(github.com/comfyanonymous/ComfyUI, `master` branch, fetched 2026-07-27):
  - `comfy_execution/caching.py`,
    `CacheKeySetInputSignature.get_immediate_node_signature()` builds the
    per-node cache signature ONLY from `node["inputs"]` -- the node's own
    declared required/optional inputs as serialized in the prompt JSON --
    plus the `IS_CHANGED` result and (only when the class's hidden dict
    contains `"UNIQUE_ID"`, which ours now does) this node's OWN `node_id`.
    It never reads any OTHER node's `inputs`, so nothing elsewhere in the
    graph can appear in our signature.
  - `execution.py`'s `get_input_data()` is where hidden values (`PROMPT`,
    `UNIQUE_ID`, ...) actually get resolved into real objects -- and it does
    so from its own `unique_id`/`dynprompt` PARAMETERS, entirely separate
    from the `node["inputs"]` dict the signature above reads. Hidden values
    are never written into `node["inputs"]` in the first place.
  - `execution.py`'s `IsChangedCache.get()` only calls a node's `IS_CHANGED`
    at all if the class defines one (`hasattr(class_def, "IS_CHANGED")`).
    This class deliberately does NOT define `IS_CHANGED`, so that path is a
    no-op here regardless.
So: this node's cache key is `(class_type, False, this_node_id, ("panel_state", <value>))`
-- the whole-graph `prompt` never enters it. No `IS_CHANGED` override was
needed as a mitigation; if a future ComfyUI version changes this, an
`IS_CHANGED` hashing only `(panel_state, sorted(referenced slots))` would be
the fallback (mark any such change `VERIFY-IN-COMFYUI:` before relying on it
again).

NOT mirrored on `AnimaControlPanel`: see that file's docstring for why.
"""
from __future__ import annotations

from ._loaders_helpers import load_row_model, referenced_slots
from ._rows_helpers import parse_state, rows_by_slot
from ._type_helpers import ANY

# See control_panel.py's CATEGORY comment: Title Case in the picker, the
# folder underneath (`nodes/controls/`, `js/controls/`) stays snake_case.
CATEGORY = "AnimaFlow/Controls"

# Fixed output-slot budget -- smaller than the Control Panel's because a
# loader row is one of exactly three fixed kinds (unet/vae/clip), not an
# open-ended catalog. May grow later, must NEVER shrink (see
# control_panel.MAX_ROWS's comment -- the same slot-stability rule applies).
MAX_ROWS = 8


class AnimaLoaderPanel:
    """`Anima Loader Panel` -- unet/vae/clip rows, each emitting a real
    MODEL/VAE/CLIP object from its own fixed output slot. A row only loads
    (and only then touches VRAM) when its output slot is actually wired to
    something downstream; an unwired row's slot emits `0`, same as an empty
    slot."""

    DESCRIPTION = (
        "Holds unet/vae/clip loader rows in one node, each emitting a real "
        "MODEL/VAE/CLIP object from its own output socket. A row only "
        "loads -- and only then touches VRAM -- when its socket is "
        "actually wired to something downstream, so an unused row costs "
        "nothing. Kept separate from the Control Panel on purpose: sharing "
        "one node with a fast-changing row like seed would reload every "
        "model on every bump."
    )

    CATEGORY = CATEGORY
    EXPERIMENTAL = True
    FUNCTION = "run"
    RETURN_TYPES = (ANY,) * MAX_ROWS
    RETURN_NAMES = tuple(f"value_{i + 1}" for i in range(MAX_ROWS))
    OUTPUT_TOOLTIPS = tuple(
        (
            f"Loader row output slot {i + 1}. Emits the real MODEL/VAE/CLIP "
            "object loaded by the row currently occupying this slot (reused "
            "from a per-row-kind cache when the row's name/options haven't "
            "changed since the last load) -- but ONLY if this slot is "
            "actually wired to something; an unwired row is never loaded at "
            "all, to avoid pulling an unused model onto the GPU. Emits 0 if "
            "no row currently occupies this slot, or if this slot isn't "
            "wired to anything. Wildcard-typed in Python; the frontend "
            "narrows the visible wire type per row."
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
                            "Serialized Loader Panel state (JSON): its unet/vae/"
                            "clip rows, each row's picked filename and options "
                            "(weight_dtype/type/device). Written by the panel's "
                            "own frontend widget after every edit -- hidden for "
                            "rendering only, not meant to be hand-edited."
                        ),
                    },
                ),
            },
            # Used ONLY to work out which output slots are actually wired
            # (`_loaders_helpers.referenced_slots`), so an unwired row's
            # model is never loaded -- see this module's docstring for why
            # this is safe with respect to ComfyUI's cache signature.
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    def run(self, panel_state: str = "{}", prompt=None, unique_id=None):
        state = parse_state(panel_state)
        slots = rows_by_slot(state["rows"], MAX_ROWS)

        # `None` means "couldn't tell which slots are wired" -- fail OPEN
        # and load everything, exactly the old (pre-scan) behaviour, rather
        # than risk silently starving a row the graph actually needs.
        wanted = referenced_slots(prompt, unique_id, MAX_ROWS)

        out = []
        for slot in range(1, MAX_ROWS + 1):
            row = slots.get(slot)
            if row is None:
                out.append(0)
            elif wanted is not None and slot not in wanted:
                out.append(0)
            else:
                out.append(load_row_model(row))
        return tuple(out)


NODE_CLASS_MAPPINGS = {"AnimaLoaderPanel": AnimaLoaderPanel}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaLoaderPanel": "Anima Loader Panel"}
