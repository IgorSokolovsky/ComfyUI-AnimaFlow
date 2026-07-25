"""AnimaRegionMaskEditor — rect/ellipse mask authoring, canvas + drag/resize
handles (see `js/anima/anima_region_mask_editor/`), normalized coordinates
rasterized to real `MASK` tensors HERE before leaving the node (no geometry
blob crosses the wire — see `_anima_region_mask_helpers.py`'s module
docstring for the full design rationale).

Thin node: all geometry logic lives in `_anima_region_mask_helpers.py`
(pure up through `rasterize_region_rows`, torch only imported lazily inside
`rasterize_to_mask_tensor`/`empty_mask_tensor`). This module itself never
imports `torch`.

## Why exactly 6 numbered outputs, always populated

`RETURN_TYPES = ("MASK",) * 6` — a fixed arity, not a dynamic one, since
ComfyUI's static `INPUT_TYPES`/`RETURN_TYPES` contract has no notion of "as
many outputs as the user has authored regions" (the same constraint
`AnimaRegionalConditioning`'s 6 numbered optional input pairs are built
around, on the other end of this pair of nodes). Any of the 6 slots beyond
however many regions are actually authored still returns a valid all-zeros
`MASK` tensor at the configured canvas size (`empty_mask_tensor`) rather
than `None` — so a workflow that wires all 6 outputs to
`AnimaRegionalConditioning`'s `mask_1..mask_6` (or anywhere else) never
breaks just because fewer than 6 regions have been drawn; an all-zeros mask
combined with `AnimaRegionalConditioning`'s "a pair only takes effect when
BOTH its mask and its conditioning are wired" rule is also functionally
inert on that side (an all-zero mask masks nothing in, but the pair is only
"active" there when a real `cond_i` is ALSO wired, which a user simply
wouldn't do for a region they never drew).
"""

from __future__ import annotations

from ._anima_region_mask_helpers import (
    DEFAULT_REGIONS_JSON,
    MAX_REGIONS,
    empty_mask_tensor,
    parse_regions,
    rasterize_to_mask_tensor,
)


class AnimaRegionMaskEditor:
    CATEGORY = "AnimaFlow/anima"
    FUNCTION = "build"
    RETURN_TYPES = ("MASK",) * MAX_REGIONS
    RETURN_NAMES = tuple(f"mask_{i}" for i in range(1, MAX_REGIONS + 1))
    OUTPUT_TOOLTIPS = tuple(
        (
            f"Region {i}'s rasterized mask, at canvas_width x canvas_height, values 0..1. "
            f"If fewer than {i} regions have been authored on the canvas, this is a valid "
            "all-zeros mask of the same size (never None) so downstream wiring never breaks "
            "on a missing output."
        )
        for i in range(1, MAX_REGIONS + 1)
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "canvas_width": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 8,
                    "tooltip": (
                        "The pixel width the normalized (0..1) authored regions rasterize "
                        "to on output. Should match the width of the latent/image the "
                        "resulting masks will be used against (e.g. AnimaRegionalConditioning "
                        "wired into the same KSampler pass) so region boundaries land where "
                        "they were drawn relative to the actual generated image."
                    ),
                }),
                "canvas_height": ("INT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 8,
                    "tooltip": (
                        "The pixel height the normalized (0..1) authored regions rasterize "
                        "to on output. Should match the height of the latent/image the "
                        "resulting masks will be used against, same reasoning as canvas_width."
                    ),
                }),
                "regions": ("STRING", {
                    "default": DEFAULT_REGIONS_JSON,
                    "tooltip": (
                        "The editor's own serialized region geometry (JSON list of "
                        "{id, label, shape, x, y, w, h} objects, x/y/w/h normalized 0..1), "
                        "authored via the node's canvas UI (drag to move, corner handle to "
                        "resize, toolbar to add rect/ellipse regions) — not meant to be "
                        "hand-typed. Capped at 6 entries; anything past that, or malformed "
                        "JSON, is silently ignored rather than erroring."
                    ),
                }),
            },
        }

    def build(self, canvas_width=1024, canvas_height=1024, regions=DEFAULT_REGIONS_JSON):
        parsed = parse_regions(regions)
        masks = []
        for i in range(MAX_REGIONS):
            if i < len(parsed):
                masks.append(rasterize_to_mask_tensor(parsed[i], canvas_width, canvas_height))
            else:
                masks.append(empty_mask_tensor(canvas_width, canvas_height))
        return tuple(masks)
