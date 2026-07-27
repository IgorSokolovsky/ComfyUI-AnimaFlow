"""Pure width/height/scale math for `AnimaImageScaleByMultiple`.

Ported from `../ComfyUI-EasyUseAnima/easyuse_anima/image/scaling.py` +
`.../image/geometry.py`, adapted to this node's simpler contract: a single
`scale_by` widget (mirroring the reference's own `scale_by`, default `1.5`
there) is applied to the source size, and the result is rounded to a size
that is a multiple of `multiple` in both dimensions, optionally capped back
down by `max_long_edge`.

REGRESSION FIXED: before `scale_by` existed, this function only ever
rounded a size UP to the nearest already-covering multiple-aligned size, so
every standard SDXL/Anima resolution (already 64-aligned) round-tripped
unchanged with scale_factor == 1.0 — used as `AnimaGenerator`'s ONLY
highres-stage sizing input, that made `highres_enabled=True` silently
perform a second full img2img pass at the SAME resolution, burning the cost
of a highres fix while delivering none of the resolution. `scale_by`
(threaded through as `AnimaGenerator`'s new `highres_scale_by` widget,
default `1.5`) fixes that.

REGRESSION #2 FIXED (R1 follow-up — see the delegating plan's "practical
impact is severe" report): the FIRST fix kept a strict "exact source aspect
ratio + round-UP-only" contract for every `scale_by`, not just `1.0`. For
aspect ratios whose reduced (w:h) integers are coprime with `multiple` —
crucially **832x1216, the standard Anima/SDXL portrait resolution** — the
smallest valid same-ratio step beyond the source size overshoots badly: at
the shipped `scale_by=1.5` default, 832x1216 landed at exactly 1664x2432,
i.e. 2.0x linear / 4.0x pixels, an ~78% bigger highres pass than requested,
at highres denoise, on Colab-hosted ComfyUI where that is a realistic
VRAM/OOM failure a user cannot discover from the widget.

THE FIX (this revision): for `scale_by != 1.0`, this function now mirrors
the reference pack's actual nearest-candidate search (`_image_scale_by_
multiple_size` + `_aligned_size_near_scale` in the reference files above) —
it tolerates a small amount of aspect-ratio drift (empirically ~1-2%, never
more) in exchange for landing much closer to the requested linear scale,
instead of insisting on the exact source ratio at any cost. Concretely, TWO
candidate sizes are computed and the one closer to the nominal request wins:

  1. `exact-ratio candidate` — the ORIGINAL round-up-only, exact-aspect-
     ratio algorithm (see REGRESSION FIXED above). This is also, verbatim,
     the answer for `scale_by == 1.0` — see the contract note below.
  2. `aligned-near-scale candidate` — ported from the reference's
     `_aligned_size_near_scale`: scale each dimension independently to the
     target size, then try both the next multiple-aligned value UP and
     DOWN for each dimension (4 combinations), and pick whichever
     combination lands closest to the requested per-dimension scale (ties
     broken by minimal aspect drift, then by larger area). This candidate
     CAN land slightly under `scale_by` (a documented change from the old
     round-up-only invariant) and can drift the aspect ratio by roughly
     ~1-2% for awkward ratios — both traded deliberately for staying near
     the requested compute budget instead of silently 2x/4x-ing it.

  Whichever of the two lands closer to the nominal target long edge (with
  a same tie-break the reference uses: prefer whichever candidate actually
  upscales both dimensions when `scale_by > 1.0` and the other doesn't)
  wins. Unlike the reference (which only ever runs this comparison when
  `max_long_edge > 0`, because its own default `multiple` of 32 rarely
  produces the coprime overshoot that our default `multiple` of 64 does),
  this port ALWAYS runs the comparison — deliberately generalizing the gate
  so the fix applies even with `max_long_edge=0` (this node's default),
  which is exactly the configuration the regression report measured.

**`scale_by=1.0` contract — UNCHANGED, byte-identical**: this is the ONE
value where NO drift-tolerant search happens at all; it always returns the
"exact-ratio candidate" above directly (guaranteed via an explicit early
return), i.e. exactly the pre-existing "round the current size up to the
nearest multiple-aligned size, exact aspect ratio, never below the source
size" contract this function has always guaranteed at this value — see
`test_scale_by_one_is_byte_identical_to_pre_scale_by_behavior` and the
three spot-checks in the R1-follow-up build report. The postprocess-resize
call site (which never passes `scale_by`, so always gets this default)
depends on this and is unaffected by anything in this revision.

Only plain-int/math-module logic lives here (no torch/comfy import), so it
is fully unit-testable without a ComfyUI environment — see
`test_anima_image_scale.py`.
"""

from __future__ import annotations

from math import ceil, gcd, isfinite, lcm

# Sane bounds for a `scale_by` widget value — mirrors the reference pack's
# own `_scale_by_value` clamp (`../ComfyUI-EasyUseAnima/easyuse_anima/image/
# scaling.py`). 0.01 floor rather than allowing 0/negative through: "scale to
# zero (or a mirrored/negative size)" has no sane interpretation, but a
# malformed/degenerate widget value should never crash a running graph, so
# it collapses to the smallest usable positive scale instead of raising.
MIN_SCALE_BY = 0.01
MAX_SCALE_BY = 8.0
DEFAULT_SCALE_BY = 1.0

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


def align_nearest(value: int, alignment: int) -> int:
    """Round `value` to WHICHEVER of `align_down`/`align_up` is numerically
    closer (ties go to `align_up`) — used only by the last-resort fallback
    in `compute_scale_by_multiple` (mirrors the reference pack's own
    `_align_nearest` in `.../image/geometry.py`), never by the main
    `scale_by == 1.0` or `_aligned_size_near_scale` paths."""
    value = max(1, int(value))
    alignment = max(1, int(alignment))
    lower = align_down(value, alignment)
    upper = align_up(value, alignment)
    return lower if (value - lower) < (upper - value) else upper


def _aligned_size_near_scale(
    source_width: int,
    source_height: int,
    scale: float,
    alignment: int,
    max_long_edge: int,
) -> tuple[int, int, float] | None:
    """Ported near-verbatim from the reference pack's own
    `_aligned_size_near_scale` (`../ComfyUI-EasyUseAnima/easyuse_anima/
    image/geometry.py`): scale each dimension independently toward `scale`
    (capped by `max_long_edge` if set), then consider BOTH the
    `alignment`-aligned value immediately below and immediately above each
    scaled dimension (up to 4 width x height combinations), and return
    whichever combination lands closest to the per-dimension target scale
    — ties broken by minimal aspect-ratio drift from the source, then by
    largest resulting area. Deliberately tolerates aspect-ratio drift and
    scale under/overshoot in exchange for never landing wildly past the
    requested `scale` (see the module docstring's "REGRESSION #2 FIXED").

    Returns `None` if no candidate satisfies `max_long_edge` (or if the
    capped target scale collapses to <= 0), signaling the caller should
    fall back to another strategy.
    """
    source_long_edge = max(source_width, source_height)
    target_scale = scale
    if max_long_edge > 0 and source_long_edge * target_scale > max_long_edge:
        target_scale = max_long_edge / source_long_edge
    if target_scale <= 0:
        return None

    target_width = max(1, round(source_width * target_scale))
    target_height = max(1, round(source_height * target_scale))
    width_candidates = {
        max(alignment, (target_width // alignment) * alignment),
        align_up(target_width, alignment),
    }
    height_candidates = {
        max(alignment, (target_height // alignment) * alignment),
        align_up(target_height, alignment),
    }

    candidates: list[tuple[int, int, float]] = []
    for candidate_width in width_candidates:
        for candidate_height in height_candidates:
            if max_long_edge > 0 and max(candidate_width, candidate_height) > max_long_edge:
                continue
            if scale > 1.0 and max_long_edge > source_long_edge:
                if candidate_width <= source_width or candidate_height <= source_height:
                    continue
            applied_scale = (candidate_width / source_width + candidate_height / source_height) / 2.0
            candidates.append((candidate_width, candidate_height, applied_scale))
    if not candidates:
        return None

    source_ratio = source_width / source_height
    return min(
        candidates,
        key=lambda item: (
            abs((item[0] / source_width) - target_scale) + abs((item[1] / source_height) - target_scale),
            abs((item[0] / item[1]) - source_ratio),
            -item[0] * item[1],
        ),
    )


def normalize_scale_by(value, default: float = DEFAULT_SCALE_BY) -> float:
    """Sanitize a possibly-invalid `scale_by` widget value: non-numeric or
    non-finite (NaN/inf) input falls back to `default`; finite input is
    clamped to `[MIN_SCALE_BY, MAX_SCALE_BY]` — degenerate zero/negative
    values collapse to the `MIN_SCALE_BY` floor (a "scale to zero-or-mirror"
    request has no sane interpretation, but must never raise), matching the
    reference pack's own `_scale_by_value` clamp."""
    try:
        scale = float(value)
    except (TypeError, ValueError):
        scale = default
    if not isfinite(scale):
        scale = default
    return max(MIN_SCALE_BY, min(MAX_SCALE_BY, scale))


def compute_scale_by_multiple(
    width: int,
    height: int,
    multiple: int,
    max_long_edge: int = 0,
    scale_by: float = DEFAULT_SCALE_BY,
) -> tuple[int, int, float]:
    """Compute `(target_width, target_height, scale_factor)` for scaling a
    `width` x `height` source by `scale_by`, rounded to multiples of
    `multiple` in both dimensions, optionally capped by `max_long_edge`.

    `scale_by=1.0` — BACKWARD-COMPAT ANCHOR, byte-identical to the original
    (pre-`scale_by`, pre-R1-follow-up) contract: rounds the current size UP
    to the nearest multiple-aligned size, preserving the exact source aspect
    ratio, never below the source size (except under a `max_long_edge` cap).
    See the module docstring's "REGRESSION FIXED" / contract note — this is
    verified byte-for-byte by `test_scale_by_one_is_byte_identical_to_pre_
    scale_by_behavior`.

    `scale_by != 1.0` — two candidates are computed, and whichever lands
    closer to the nominal request wins (see the module docstring's
    "REGRESSION #2 FIXED" / "THE FIX" for the full rationale):

      1. `exact_candidate` — the SAME round-up-only, exact-aspect-ratio
         algorithm as the `scale_by=1.0` anchor, just with `scale_by`'s
         actual value instead of `1.0`. Reduce `width`/`height` to their
         smallest integer ratio (`base_width`/`base_height`, dividing out
         `gcd(width, height)`), find the smallest step size (`unit_step`, an
         `lcm` of what each base dimension needs to reach a
         `multiple`-aligned value) such that scaling both base dimensions by
         any positive integer count of `unit_step` always lands both on an
         exact multiple of `multiple`, then take the smallest such count
         that is `>= ratio_gcd * scale_by`. Exact ratio, but for aspect
         ratios coprime with `multiple` this can overshoot the requested
         scale substantially (the R1-follow-up regression).
      2. `aligned_candidate` — `_aligned_size_near_scale` (see its own
         docstring): tolerates small aspect-ratio drift to land close to the
         requested scale, ported from the reference pack.

    Whichever candidate's long edge is closer to the nominal target long
    edge wins (falling back to preferring genuine upscaling when
    `scale_by > 1.0` and only one candidate actually upscales both
    dimensions) — mirrors the reference pack's own comparison, generalized
    to always run (not just when `max_long_edge > 0`; see the module
    docstring for why).

    If `max_long_edge > 0` and the rounded-up `exact_candidate` would exceed
    it, its unit count is reduced (still aspect-preserving + multiple-
    aligned) to fit under the cap; `aligned_candidate` honors the same cap
    internally. In the rare case where even a single alignment unit already
    exceeds `max_long_edge` for this aspect ratio (i.e. `multiple` itself is
    too coarse for the requested cap), `exact_candidate` becomes unusable and
    `aligned_candidate` is preferred if it produced anything; if neither
    produced anything, this falls back to independently `align_nearest`-ing
    each dimension, accepting the resulting minor aspect-ratio drift as a
    documented edge-case tradeoff (a cap smaller than the multiple can
    produce is a contradiction between the two settings, not a normal use
    case).
    """
    source_width = max(1, int(width))
    source_height = max(1, int(height))
    multiple = max(1, int(multiple))
    max_long_edge = max(0, int(max_long_edge))
    scale_by = normalize_scale_by(scale_by)

    if multiple <= 1:
        # No alignment requested at all — apply scale_by directly (1.0 is a
        # pure passthrough, matching the original contract exactly), then
        # the max_long_edge cap (if any) can still shrink the result.
        target_width = max(1, round(source_width * scale_by))
        target_height = max(1, round(source_height * scale_by))
        if max_long_edge > 0 and max(target_width, target_height) > max_long_edge:
            cap_scale = max_long_edge / max(target_width, target_height)
            target_width = max(1, round(target_width * cap_scale))
            target_height = max(1, round(target_height * cap_scale))
        return target_width, target_height, (target_width / source_width + target_height / source_height) / 2.0

    ratio_gcd = gcd(source_width, source_height)
    base_width = source_width // ratio_gcd
    base_height = source_height // ratio_gcd
    width_unit = multiple // gcd(base_width, multiple)
    height_unit = multiple // gcd(base_height, multiple)
    unit_step = lcm(width_unit, height_unit)
    long_base = max(base_width, base_height)

    scaled_ratio_gcd = ratio_gcd * scale_by
    unit_count = max(1, ceil(scaled_ratio_gcd / unit_step))
    exact_width = base_width * unit_step * unit_count
    exact_height = base_height * unit_step * unit_count

    exact_candidate: tuple[int, int, float] | None
    if max_long_edge > 0 and max(exact_width, exact_height) > max_long_edge:
        capped_unit_count = max_long_edge // (long_base * unit_step)
        if capped_unit_count >= 1:
            exact_width = base_width * unit_step * capped_unit_count
            exact_height = base_height * unit_step * capped_unit_count
            exact_candidate = (
                exact_width,
                exact_height,
                (exact_width / source_width + exact_height / source_height) / 2.0,
            )
        else:
            # Degenerate: no positive multiple of `unit_step` fits under the
            # cap for this aspect ratio at all.
            exact_candidate = None
    else:
        exact_candidate = (
            exact_width,
            exact_height,
            (exact_width / source_width + exact_height / source_height) / 2.0,
        )

    if scale_by == 1.0 and exact_candidate is not None:
        # BACKWARD-COMPAT ANCHOR: never substitute the drift-tolerant
        # candidate at scale_by=1.0, even if it happened to measure
        # "closer" by some metric — 1.0 IS the target, this IS the answer.
        return exact_candidate

    aligned_candidate = _aligned_size_near_scale(source_width, source_height, scale_by, multiple, max_long_edge)

    if exact_candidate is None:
        if aligned_candidate is not None:
            return aligned_candidate
        # Last-resort fallback: neither candidate produced anything under
        # the cap at all — a truly degenerate configuration (`multiple` far
        # coarser than `max_long_edge`, e.g. multiple=64 with
        # max_long_edge=10). Deliberate deviation from the reference here:
        # the reference's own equivalent fallback re-scales by `scale_by`
        # alone and IGNORES `max_long_edge` entirely in this corner case
        # (verified against `../ComfyUI-EasyUseAnima`), which would violate
        # "keep honoring max_long_edge as a cap" — instead, derive the
        # fallback scale from the cap too (when set), so the cap is still
        # respected as best-effort even here; independently align-nearest
        # each dimension, accepting aspect-ratio drift.
        fallback_scale = scale_by
        if max_long_edge > 0:
            fallback_scale = min(scale_by, max_long_edge / max(source_width, source_height))
        target_width = align_nearest(max(1, round(source_width * fallback_scale)), multiple)
        target_height = align_nearest(max(1, round(source_height * fallback_scale)), multiple)
        return target_width, target_height, (target_width / source_width + target_height / source_height) / 2.0

    if aligned_candidate is None:
        return exact_candidate

    # Both candidates exist and scale_by != 1.0 — pick whichever lands
    # closer to the nominal request (mirrors the reference pack's own
    # comparison in `_image_scale_by_multiple_size`).
    source_long_edge = max(source_width, source_height)
    target_long_edge = min(source_long_edge * scale_by, max_long_edge) if max_long_edge > 0 else source_long_edge * scale_by

    exact_long_error = abs(max(exact_candidate[0], exact_candidate[1]) - target_long_edge)
    aligned_long_error = abs(max(aligned_candidate[0], aligned_candidate[1]) - target_long_edge)

    exact_upscales = exact_candidate[0] > source_width and exact_candidate[1] > source_height
    aligned_upscales = aligned_candidate[0] > source_width and aligned_candidate[1] > source_height

    if scale_by > 1.0 and aligned_upscales and not exact_upscales:
        return aligned_candidate
    if aligned_long_error < exact_long_error:
        return aligned_candidate
    return exact_candidate


__all__ = (
    "DEFAULT_SCALE_BY",
    "DEFAULT_UPSCALE_METHOD",
    "IMAGE_UPSCALE_METHODS",
    "MAX_SCALE_BY",
    "MIN_SCALE_BY",
    "align_down",
    "align_nearest",
    "align_up",
    "compute_scale_by_multiple",
    "normalize_scale_by",
    "normalize_upscale_method",
)
