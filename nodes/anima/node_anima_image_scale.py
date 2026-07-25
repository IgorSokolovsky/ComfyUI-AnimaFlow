"""AnimaImageScaleByMultiple — standalone highres-fix scaling utility.

Near-verbatim port of the reference pack's `EasyUseAnimaImageScaleByMultiple`
(`../ComfyUI-EasyUseAnima/easyuse_anima/nodes/image_nodes.py` +
`.../image/scaling.py`), including its `scale_by` widget (default `1.5`,
matching the reference exactly) — the requested size is scaled by `scale_by`,
then rounded to a multiple-aligned size, optionally capped by
`max_long_edge`. At `scale_by=1.0` this is exact-aspect-ratio, round-UP-only
alignment (no enlargement) — the original behavior of this node before
`scale_by` existed. At any OTHER `scale_by`, the result targets the
requested scale as closely as possible, tolerating a small (~1-2%) aspect-
ratio drift where needed rather than overshooting the requested scale
badly for aspect ratios coprime with `multiple` (see `_anima_image_scale_
helpers.compute_scale_by_multiple`'s module docstring, "REGRESSION #2
FIXED", for the exact regression this fixes — 832x1216, the standard Anima/
SDXL portrait resolution, used to land at 2.0x/4x-pixels instead of the
requested 1.5x). See `compute_scale_by_multiple` for the pure math (fully
unit-tested without torch/comfy) (this utility function is also
`AnimaGenerator`'s ONLY highres-stage sizing input — see that node's own
`highres_scale_by` widget).

Thin node: the only ComfyUI-dependent piece is the actual tensor resample,
which delegates to `comfy.utils.common_upscale` (the same core upscale
primitive the reference pack wraps via its `_common_upscale_image`) —
imported lazily inside `scale()` so this module itself never requires
`comfy`/`torch` to be importable (matters for the plain-script test suite,
which runs outside ComfyUI).
"""

from __future__ import annotations

from ._anima_image_scale_helpers import (
    DEFAULT_UPSCALE_METHOD,
    IMAGE_UPSCALE_METHODS,
    MAX_SCALE_BY,
    MIN_SCALE_BY,
    compute_scale_by_multiple,
    normalize_upscale_method,
)

# Widget default only — matches the reference pack's own node-level default
# (`../ComfyUI-EasyUseAnima/easyuse_anima/nodes/image_nodes.py`'s
# `EasyUseAnimaImageScaleByMultiple.scale_by`), NOT
# `_anima_image_scale_helpers.DEFAULT_SCALE_BY` (which stays `1.0` — the
# function's own neutral/no-op default, so any OTHER call site that omits
# `scale_by` entirely, e.g. `run_postprocess_resize`'s postprocess-resize
# stage, keeps behaving exactly as before this widget existed).
NODE_DEFAULT_SCALE_BY = 1.5


class AnimaImageScaleByMultiple:
    CATEGORY = "AnimaFlow/anima"
    EXPERIMENTAL = True
    FUNCTION = "scale"
    RETURN_TYPES = ("IMAGE", "INT", "INT", "FLOAT")
    RETURN_NAMES = ("image", "width", "height", "scale_factor")
    OUTPUT_TOOLTIPS = (
        "The resampled image, sized to width x height below.",
        "Final output width — guaranteed a multiple of `multiple` (unless the max_long_edge cap made that impossible; see its tooltip).",
        "Final output height — guaranteed a multiple of `multiple` (unless the max_long_edge cap made that impossible; see its tooltip).",
        "Actual scale ratio applied (output size / input size) — 1.0 if the input was already multiple-aligned, scale_by was 1.0, and under any max_long_edge cap.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Source image to align/scale. Every frame in the batch is resampled to the same computed width/height.",
                }),
                "scale_by": ("FLOAT", {
                    "default": NODE_DEFAULT_SCALE_BY,
                    "min": MIN_SCALE_BY,
                    "max": MAX_SCALE_BY,
                    "step": 0.01,
                    "tooltip": (
                        "Highres-fix multiplier applied to the source size, then rounded to a "
                        "multiple-aligned size (e.g. 1.5 means \"roughly 1.5x bigger\"). The result "
                        "targets this scale as closely as possible - for aspect ratios that don't "
                        "divide evenly into `multiple`, it may drift the aspect ratio by a small "
                        "amount (~1-2%) rather than overshoot the requested scale, and may land "
                        "slightly above OR below the exact multiplier. Set to 1.0 to align only, "
                        "WITHOUT enlarging and WITHOUT any aspect drift - the original behavior of "
                        "this node before scale_by existed, still exactly reproduced at this value."
                    ),
                }),
                "multiple": ("INT", {
                    "default": 64,
                    "min": 1,
                    "max": 1024,
                    "step": 1,
                    "tooltip": (
                        "Rounds the output width and height UP to the nearest multiple of this "
                        "value (while preserving the source aspect ratio exactly) so the result is "
                        "safe to feed into latent-space operations - VAE encode, highres passes, "
                        "Impact Pack detailer crops - that require dimensions divisible by a fixed "
                        "factor (commonly 8 for most VAEs, 32/64 for some highres/ANIMA workflows). "
                        "An already-aligned input passes through unscaled."
                    ),
                }),
                "max_long_edge": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 8,
                    "tooltip": (
                        "Caps the longer output dimension to this many pixels, shrinking the "
                        "multiple-aligned result back down (still aspect-preserving and, where "
                        "possible, still multiple-aligned) if the rounded-up size would otherwise "
                        "exceed it. Set to 0 to disable the cap entirely."
                    ),
                }),
                "upscale_method": (IMAGE_UPSCALE_METHODS, {
                    "default": DEFAULT_UPSCALE_METHOD,
                    "tooltip": "Interpolation algorithm used for the actual resample, passed straight through to ComfyUI's core upscale primitive.",
                }),
            },
        }

    def scale(self, image, scale_by=NODE_DEFAULT_SCALE_BY, multiple=64, max_long_edge=0, upscale_method=DEFAULT_UPSCALE_METHOD):
        upscale_method = normalize_upscale_method(upscale_method)
        samples = image.movedim(-1, 1)
        source_width = int(samples.shape[3])
        source_height = int(samples.shape[2])
        width, height, scale_factor = compute_scale_by_multiple(
            source_width,
            source_height,
            multiple,
            max_long_edge,
            scale_by,
        )

        import comfy.utils  # lazy: only needed at actual execution time inside ComfyUI

        scaled = comfy.utils.common_upscale(samples, width, height, upscale_method, "disabled")
        return (scaled.movedim(1, -1), width, height, scale_factor)
