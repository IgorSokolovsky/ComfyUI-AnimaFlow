"""AnimaImageScaleByMultiple — standalone highres-fix scaling utility.

Near-verbatim port of the reference pack's `EasyUseAnimaImageScaleByMultiple`
(`../ComfyUI-EasyUseAnima/easyuse_anima/nodes/image_nodes.py` +
`.../image/scaling.py`), simplified to this pack's contract: no `scale_by`
widget — the desired ratio is implicitly 1.0 (round the current size UP to
the nearest multiple-aligned, aspect-preserving size), optionally capped by
`max_long_edge`. See `_anima_image_scale_helpers.compute_scale_by_multiple`
for the pure math (fully unit-tested without torch/comfy).

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
    compute_scale_by_multiple,
    normalize_upscale_method,
)


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
        "Actual scale ratio applied (output size / input size) — 1.0 if the input was already multiple-aligned and under any max_long_edge cap.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE", {
                    "tooltip": "Source image to align/scale. Every frame in the batch is resampled to the same computed width/height.",
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

    def scale(self, image, multiple=64, max_long_edge=0, upscale_method=DEFAULT_UPSCALE_METHOD):
        upscale_method = normalize_upscale_method(upscale_method)
        samples = image.movedim(-1, 1)
        source_width = int(samples.shape[3])
        source_height = int(samples.shape[2])
        width, height, scale_factor = compute_scale_by_multiple(
            source_width,
            source_height,
            multiple,
            max_long_edge,
        )

        import comfy.utils  # lazy: only needed at actual execution time inside ComfyUI

        scaled = comfy.utils.common_upscale(samples, width, height, upscale_method, "disabled")
        return (scaled.movedim(1, -1), width, height, scale_factor)
