"""AnimaRegionalConditioning — thin wrapper attaching native ComfyUI
conditioning-mask metadata per region.

Masks arrive here already rasterized as real `MASK` tensors (from
`AnimaRegionMaskEditor`, or any other source — this node makes no
assumption about where a wired `mask_i`/`cond_i` pair came from, per the
plan's "works with masks/conditioning from ANY source" requirement), so
this node does no rasterization at all — see
`_anima_regional_conditioning_helpers.py`'s module docstring for the full
metadata-attach design (native `mask`/`set_area_to_bounds`/`mask_strength`
keys, no invented keys, no hand-computed `area` bounding box).

## Delegates to core's own `ConditioningSetMask` when reachable

`encode()` looks up ComfyUI's own live `ConditioningSetMask` node class via
`_comfy_core_bridge.find_core_node_class` (the same verified-safe bare
`import nodes` bridge `AnimaGenerator`/`AnimaConditioningEncode` already
use) and, when found, delegates the actual metadata attach to THAT class's
own `.append(...)` method — so in a real ComfyUI process, this node's output
is produced by literally the same code path wiring core's own
`ConditioningSetMask` node into a workflow would use, immune to this pack's
own logic ever drifting from however a future ComfyUI version implements
that contract. This repo's own test/dev environment has no live ComfyUI
(`find_core_node_class` returns `None` there — see that module's
docstring), so `combine_regional_conditioning`'s pure fallback
(`attach_region_mask`, exercised directly by
`tests/test_anima_regional_conditioning.py`) is what actually runs when this
node is smoke-tested outside ComfyUI.
"""

from __future__ import annotations

from ._anima_regional_conditioning_helpers import (
    AREA_MODE_MASK_BOUNDS,
    AREA_MODES,
    combine_regional_conditioning,
)
from ._comfy_core_bridge import find_core_node_class

MAX_REGIONS = 6


class AnimaRegionalConditioning:
    CATEGORY = "AnimaFlow/anima"
    FUNCTION = "encode"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    OUTPUT_TOOLTIPS = (
        "The global positive conditioning, unchanged, followed by each actively-wired "
        "region's own conditioning (mask_i + cond_i both wired) with mask/area/strength "
        "metadata attached, in ascending region-number order.",
        "The global negative conditioning, passed through completely unchanged — regional "
        "masking in this node only ever applies to the positive side.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        required = {
            "positive": ("CONDITIONING", {
                "tooltip": (
                    "The global/base positive conditioning (e.g. from AnimaConditioningEncode "
                    "or core CLIPTextEncode) that applies everywhere on the canvas. Region "
                    "conditioning is layered on TOP of this, scoped to its own mask, not a "
                    "replacement for it."
                ),
            }),
            "negative": ("CONDITIONING", {
                "tooltip": (
                    "The global/base negative conditioning. Passed straight through unchanged "
                    "-- this node has no negative-side regional pairs, since negative-prompt "
                    "regional masking is not a supported concept here (matches how regional "
                    "prompting is conventionally applied: only the positive prompt varies by "
                    "region)."
                ),
            }),
            "mask_strength": ("FLOAT", {
                "default": 1.0,
                "min": 0.0,
                "max": 10.0,
                "step": 0.01,
                "tooltip": (
                    "Scales how strongly a region's own conditioning is enforced, relative to "
                    "the global prompt, within that region's mask -- 1.0 fully applies the "
                    "region's conditioning there, lower values blend it more softly against the "
                    "global prompt, 0.0 effectively disables regional override entirely. Applied "
                    "identically to every active region pair (per-region strength is not "
                    "supported)."
                ),
            }),
            "area_mode": (list(AREA_MODES), {
                "default": AREA_MODE_MASK_BOUNDS,
                "tooltip": (
                    "'mask bounds' restricts sampling attention to each region mask's own "
                    "bounding box only (cheaper/faster -- sets ComfyUI's native "
                    "set_area_to_bounds flag so the sampler derives the crop from the mask at "
                    "run time). 'default' applies the mask as a soft per-pixel weight over the "
                    "FULL canvas instead, with no bounding-box shortcut (more expensive, but "
                    "sometimes desired for very irregular/scattered masks)."
                ),
            }),
        }
        optional = {}
        for i in range(1, MAX_REGIONS + 1):
            optional[f"mask_{i}"] = ("MASK", {
                "tooltip": (
                    f"Region {i}'s mask, paired with cond_{i}. This pair only takes effect "
                    f"when BOTH mask_{i} AND cond_{i} are wired -- an unpaired mask (with no "
                    f"cond_{i}) or unpaired conditioning (with no mask_{i}) is silently ignored, "
                    "so partially wiring a region is always safe."
                ),
            })
            optional[f"cond_{i}"] = ("CONDITIONING", {
                "tooltip": (
                    f"Region {i}'s own conditioning, paired with mask_{i} -- encoded/authored "
                    "however you like (e.g. its own AnimaConditioningEncode/CLIPTextEncode), "
                    f"applied only inside mask_{i}'s area. This pair only takes effect when "
                    f"BOTH mask_{i} AND cond_{i} are wired."
                ),
            })
        return {"required": required, "optional": optional}

    def encode(
        self,
        positive,
        negative,
        mask_strength=1.0,
        area_mode=AREA_MODE_MASK_BOUNDS,
        **kwargs,
    ):
        pairs = [(kwargs.get(f"mask_{i}"), kwargs.get(f"cond_{i}")) for i in range(1, MAX_REGIONS + 1)]
        # VERIFY-IN-COMFYUI: `find_core_node_class` always returns `None` in
        # this repo's own dev/test environment (no live ComfyUI `nodes.py` —
        # see `_comfy_core_bridge.py`'s docstring), so the exact call
        # signature assumed here for core's `ConditioningSetMask.append` --
        # `(conditioning, mask, set_cond_area, strength)`, based on this
        # class's own known INPUT_TYPES order and the reference pack's own
        # UI copy ("mirrors ComfyUI ConditioningSetMask area behavior") --
        # has not been exercised against a real ComfyUI install. If a live
        # ComfyUI version ever changes that signature, this call site (only
        # this one line) is what needs updating; the pure fallback path
        # (`attach_region_mask`, exercised directly by this repo's own test
        # suite) is unaffected either way.
        core_conditioning_set_mask_cls = find_core_node_class("ConditioningSetMask")
        combined_positive = combine_regional_conditioning(
            positive,
            pairs,
            mask_strength,
            area_mode,
            core_conditioning_set_mask_cls,
        )
        return (combined_positive, negative)
