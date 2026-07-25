"""Pure width/height/scale math for `AnimaImageScaleByMultiple`.

Ported from `../ComfyUI-EasyUseAnima/easyuse_anima/image/scaling.py` +
`.../image/geometry.py`, adapted to this node's simpler contract: there is
no user-facing `scale_by` widget here (unlike the reference), so the
"desired ratio" is implicitly 1.0 — the whole point of this utility is to
round the CURRENT size UP to the nearest size that is both a multiple of
`multiple` in both dimensions AND keeps the exact source aspect ratio,
optionally capped back down by `max_long_edge`. That is what "the nearest-
ratio upscale that lands on a multiple" (see the node's docstring) means in
practice: an image already sized to a valid multiple round-trips through
this function unchanged (scale_factor == 1.0).

Only plain-int/math-module logic lives here (no torch/comfy import), so it
is fully unit-testable without a ComfyUI environment — see
`test_anima_image_scale.py`.
"""

from __future__ import annotations

from math import ceil, gcd, lcm

IMAGE_UPSCALE_METHODS = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]
DEFAULT_UPSCALE_METHOD = "bicubic"


def normalize_upscale_method(value) -> str:
    """Sanitize a possibly-invalid `upscale_method` widget value down to one
    of `IMAGE_UPSCALE_METHODS`, defaulting to `DEFAULT_UPSCALE_METHOD`."""
    method = str(value or "").strip()
    return method if method in IMAGE_UPSCALE_METHODS else DEFAULT_UPSCALE_METHOD


def align_up(value: int, alignment: int) -> int:
    """Round `value` UP to the nearest multiple of `alignment` (minimum
    `alignment` itself, so a 0/negative input never yields 0)."""
    value = int(value)
    alignment = max(1, int(alignment))
    return max(alignment, ((value + alignment - 1) // alignment) * alignment)


def align_down(value: int, alignment: int) -> int:
    """Round `value` DOWN to the nearest multiple of `alignment` (floor of 1
    — this can legitimately return a size smaller than `alignment` itself in
    the degenerate case where `max_long_edge` is smaller than `alignment`;
    see `compute_scale_by_multiple`'s fallback branch)."""
    value = max(1, int(value))
    alignment = max(1, int(alignment))
    return max(1, (value // alignment) * alignment)


def compute_scale_by_multiple(
    width: int,
    height: int,
    multiple: int,
    max_long_edge: int = 0,
) -> tuple[int, int, float]:
    """Compute `(target_width, target_height, scale_factor)` for scaling a
    `width` x `height` source so both output dimensions are exact multiples
    of `multiple`, rounding UP (never down, unless `max_long_edge` forces a
    smaller size) while preserving the source aspect ratio exactly.

    Algorithm: reduce `width`/`height` to their smallest integer ratio
    (`base_width`/`base_height`, dividing out `gcd(width, height)`), then
    find the smallest step size (`unit_step`, an `lcm` of what each base
    dimension needs to reach a `multiple`-aligned value) such that scaling
    both base dimensions by any positive integer count of `unit_step` always
    lands both on an exact multiple of `multiple` — then pick the smallest
    such count that is >= the source size (the "round up" behavior). This
    keeps the exact source aspect ratio (unlike rounding width/height
    independently, which can distort it) and guarantees multiple-alignment
    in both dimensions simultaneously.

    If `max_long_edge` > 0 and the rounded-up result would exceed it, the
    unit count is reduced (still aspect-preserving + multiple-aligned) to
    fit under the cap. In the rare case where even a single alignment unit
    already exceeds `max_long_edge` for this aspect ratio (i.e. `multiple`
    itself is too coarse for the requested cap), there is no exact-aspect
    multiple-aligned candidate that fits — this falls back to independently
    aspect-scaling then `align_down`-ing each dimension, accepting the
    resulting minor aspect-ratio drift as a documented edge-case tradeoff
    (that configuration — a cap smaller than the multiple can produce — is a
    contradiction between the two settings, not a normal use case).
    """
    source_width = max(1, int(width))
    source_height = max(1, int(height))
    multiple = max(1, int(multiple))
    max_long_edge = max(0, int(max_long_edge))

    if multiple <= 1:
        # No alignment requested at all — only the max_long_edge cap (if
        # any) can still shrink the image; otherwise it passes through
        # unchanged (scale_factor == 1.0).
        if max_long_edge > 0 and max(source_width, source_height) > max_long_edge:
            scale = max_long_edge / max(source_width, source_height)
            target_width = max(1, round(source_width * scale))
            target_height = max(1, round(source_height * scale))
            return target_width, target_height, (target_width / source_width + target_height / source_height) / 2.0
        return source_width, source_height, 1.0

    ratio_gcd = gcd(source_width, source_height)
    base_width = source_width // ratio_gcd
    base_height = source_height // ratio_gcd
    width_unit = multiple // gcd(base_width, multiple)
    height_unit = multiple // gcd(base_height, multiple)
    unit_step = lcm(width_unit, height_unit)
    long_base = max(base_width, base_height)

    unit_count = max(1, ceil(ratio_gcd / unit_step))
    target_width = base_width * unit_step * unit_count
    target_height = base_height * unit_step * unit_count

    if max_long_edge > 0 and max(target_width, target_height) > max_long_edge:
        capped_unit_count = max_long_edge // (long_base * unit_step)
        if capped_unit_count >= 1:
            target_width = base_width * unit_step * capped_unit_count
            target_height = base_height * unit_step * capped_unit_count
        else:
            # Degenerate: no positive multiple of `unit_step` fits under the
            # cap for this aspect ratio. Best-effort fallback below.
            scale = max_long_edge / max(source_width, source_height)
            target_width = align_down(max(1, round(source_width * scale)), multiple)
            target_height = align_down(max(1, round(source_height * scale)), multiple)

    scale_width = target_width / source_width
    scale_height = target_height / source_height
    scale_factor = (scale_width + scale_height) / 2.0
    return target_width, target_height, scale_factor


__all__ = (
    "DEFAULT_UPSCALE_METHOD",
    "IMAGE_UPSCALE_METHODS",
    "align_down",
    "align_up",
    "compute_scale_by_multiple",
    "normalize_upscale_method",
)
