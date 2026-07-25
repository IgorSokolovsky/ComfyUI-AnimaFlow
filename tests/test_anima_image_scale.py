"""Plain-script tests for AnimaImageScaleByMultiple's pure logic.

Run directly: `python tests/test_anima_image_scale.py` (no pytest, per project
convention). The ratio/multiple math (`compute_scale_by_multiple`) needs no
torch/comfy import at all; one smoke test additionally exercises the full
node's `scale()` if `torch`/`comfy` happen to be importable in this
environment — it's guarded (skipped with a printed note, not a failure) if
they aren't, since this repo's plain-script suite runs outside ComfyUI.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima._anima_image_scale_helpers import (
    DEFAULT_SCALE_BY,
    DEFAULT_UPSCALE_METHOD,
    IMAGE_UPSCALE_METHODS,
    MAX_SCALE_BY,
    MIN_SCALE_BY,
    align_down,
    align_up,
    compute_scale_by_multiple,
    normalize_scale_by,
    normalize_upscale_method,
)
from nodes.anima.node_anima_image_scale import NODE_DEFAULT_SCALE_BY, AnimaImageScaleByMultiple


def test_align_up_rounds_up_to_multiple():
    assert align_up(1000, 64) == 1024
    assert align_up(1024, 64) == 1024  # already aligned -> unchanged
    assert align_up(1, 64) == 64
    assert align_up(0, 64) == 64


def test_align_down_rounds_down_to_multiple():
    assert align_down(1024, 64) == 1024
    assert align_down(1050, 64) == 1024
    assert align_down(10, 64) == 1  # degenerate: floors to 1, documented edge case


def test_normalize_upscale_method_valid_passthrough():
    for method in IMAGE_UPSCALE_METHODS:
        assert normalize_upscale_method(method) == method


def test_normalize_upscale_method_invalid_falls_back_to_default():
    assert normalize_upscale_method("not-a-real-method") == DEFAULT_UPSCALE_METHOD
    assert normalize_upscale_method(None) == DEFAULT_UPSCALE_METHOD
    assert normalize_upscale_method("") == DEFAULT_UPSCALE_METHOD


def test_already_aligned_square_is_identity():
    width, height, scale = compute_scale_by_multiple(1024, 1024, 64)
    assert (width, height) == (1024, 1024)
    assert scale == 1.0


def test_unaligned_square_rounds_up():
    width, height, scale = compute_scale_by_multiple(1000, 1000, 64)
    assert (width, height) == (1024, 1024)
    assert width % 64 == 0 and height % 64 == 0
    assert scale > 1.0


def test_non_square_preserves_exact_aspect_ratio():
    # 1000x700 -> gcd 100, base 10:7. Ported algorithm should land on a
    # multiple-aligned size with the EXACT same 10:7 ratio (not just close).
    width, height, scale = compute_scale_by_multiple(1000, 700, 64)
    assert width % 64 == 0
    assert height % 64 == 0
    assert width * 7 == height * 10, (width, height)  # exact 10:7 ratio preserved
    assert width >= 1000 and height >= 700  # rounds UP, never down
    assert scale >= 1.0


def test_max_long_edge_caps_result_downward():
    # Unrestricted this would round up to (1280, 896) (see the non-square
    # test above's ratio) - capping to 1024 must shrink it back down, still
    # multiple-aligned and aspect-preserving.
    width, height, scale = compute_scale_by_multiple(1000, 700, 64, max_long_edge=1024)
    assert max(width, height) <= 1024
    assert width % 64 == 0
    assert height % 64 == 0
    assert width * 7 == height * 10
    assert scale < 1.28  # less than the uncapped scale for the same input


def test_max_long_edge_no_effect_when_already_under_cap():
    width, height, scale = compute_scale_by_multiple(1000, 700, 64, max_long_edge=100000)
    uncapped = compute_scale_by_multiple(1000, 700, 64, max_long_edge=0)
    assert (width, height, scale) == uncapped


def test_multiple_of_one_disables_alignment():
    width, height, scale = compute_scale_by_multiple(777, 555, 1)
    assert (width, height) == (777, 555)
    assert scale == 1.0


def test_multiple_of_one_still_honors_max_long_edge():
    width, height, scale = compute_scale_by_multiple(1000, 500, 1, max_long_edge=500)
    assert max(width, height) <= 500
    assert width / height == 1000 / 500 or abs(width / height - 2.0) < 0.05


def test_degenerate_cap_smaller_than_multiple_does_not_crash():
    # max_long_edge smaller than `multiple` itself is a contradictory
    # config (documented edge case) - must not raise, and must still return
    # a small, positive size instead of blowing up to the multiple's floor.
    width, height, scale = compute_scale_by_multiple(1000, 700, 64, max_long_edge=10)
    assert width >= 1 and height >= 1
    assert max(width, height) <= 64  # best-effort, not a hard guarantee, but sane


def test_node_input_types_contract():
    schema = AnimaImageScaleByMultiple.INPUT_TYPES()
    required = schema["required"]
    assert required["image"][0] == "IMAGE"
    assert required["scale_by"][0] == "FLOAT"
    assert required["scale_by"][1]["default"] == NODE_DEFAULT_SCALE_BY == 1.5
    assert required["scale_by"][1]["min"] == MIN_SCALE_BY
    assert required["scale_by"][1]["max"] == MAX_SCALE_BY
    assert required["multiple"][0] == "INT"
    assert required["multiple"][1]["default"] == 64
    assert required["max_long_edge"][0] == "INT"
    assert required["max_long_edge"][1]["default"] == 0
    assert required["upscale_method"][0] == IMAGE_UPSCALE_METHODS
    for spec in required.values():
        assert "tooltip" in spec[1] and spec[1]["tooltip"]
    assert AnimaImageScaleByMultiple.CATEGORY == "AnimaFlow/anima"
    assert AnimaImageScaleByMultiple.FUNCTION == "scale"
    assert AnimaImageScaleByMultiple.RETURN_TYPES == ("IMAGE", "INT", "INT", "FLOAT")
    assert AnimaImageScaleByMultiple.RETURN_NAMES == ("image", "width", "height", "scale_factor")
    assert len(AnimaImageScaleByMultiple.OUTPUT_TOOLTIPS) == len(AnimaImageScaleByMultiple.RETURN_TYPES)


# --- R1 regression: scale_by actually enlarges the highres stage's target -


# The five standard SDXL/Anima resolutions the R1 regression report used to
# demonstrate the bug: every one of them is already 64-aligned, so BEFORE
# `scale_by` existed, `compute_scale_by_multiple` was a no-op on all five
# (scale_factor == 1.0) - see the module docstring's "REGRESSION FIXED" note.
STANDARD_RESOLUTIONS = [
    (1024, 1024),
    (832, 1216),
    (1216, 832),
    (768, 1344),
    (896, 1152),
]


def test_scale_by_default_is_one_point_zero_the_neutral_no_op_value():
    # The FUNCTION's own default (as opposed to the NODE widget's default,
    # NODE_DEFAULT_SCALE_BY == 1.5) must stay 1.0 - callers that omit
    # scale_by entirely (e.g. `run_postprocess_resize`'s call site) must not
    # start upscaling just because this parameter now exists.
    assert DEFAULT_SCALE_BY == 1.0


def test_scale_by_one_is_byte_identical_to_pre_scale_by_behavior():
    # For every standard resolution (and the non-square/degenerate cases
    # above), passing scale_by=1.0 explicitly must produce EXACTLY the same
    # (width, height, scale_factor) as calling with no scale_by argument at
    # all (the pre-fix call shape every existing call site still uses).
    for width, height in STANDARD_RESOLUTIONS + [(1000, 700), (1000, 1000), (777, 555)]:
        with_default = compute_scale_by_multiple(width, height, 64)
        with_explicit_one = compute_scale_by_multiple(width, height, 64, 0, 1.0)
        assert with_default == with_explicit_one, (width, height)


def test_scale_by_one_point_five_enlarges_every_standard_resolution():
    # This is the R1 fix's core assertion: at the shipped defaults
    # (multiple=64, max_long_edge=0), every standard resolution used to be a
    # no-op (scale_factor == 1.0); with scale_by=1.5 every one of them must
    # now be genuinely larger and multiple-aligned.
    #
    # NOTE (R1 follow-up): the exact-aspect-ratio / never-under-scale
    # invariants asserted here previously are GONE for scale_by != 1.0 - see
    # test_scale_by_lands_close_to_requested_scale_for_standard_resolutions
    # and test_scale_by_aspect_drift_stays_small below for what replaced
    # them (the old invariants are exactly what produced the R1-follow-up
    # regression: 832x1216 landing at 2.0x/4x-pixels instead of 1.5x).
    for width, height in STANDARD_RESOLUTIONS:
        target_width, target_height, scale_factor = compute_scale_by_multiple(width, height, 64, 0, 1.5)
        assert target_width > width and target_height > height, (width, height)
        assert target_width % 64 == 0 and target_height % 64 == 0, (width, height)


def test_scale_by_lands_close_to_requested_scale_for_standard_resolutions():
    # THE R1-FOLLOW-UP FIX'S CORE ASSERTION: the achieved linear scale must
    # stay close to the requested scale_by for every standard resolution -
    # in particular 832x1216 (the standard Anima/SDXL portrait resolution)
    # must NOT land at 2.0x (1664x2432) any more, the measured ~78%-more-
    # compute-than-requested regression this fix targets.
    requested_scale = 1.5
    tolerance = 0.10  # within ~10% of the requested linear scale
    for width, height in STANDARD_RESOLUTIONS:
        target_width, target_height, scale_factor = compute_scale_by_multiple(width, height, 64, 0, requested_scale)
        relative_error = abs(scale_factor - requested_scale) / requested_scale
        assert relative_error <= tolerance, (width, height, target_width, target_height, scale_factor)

    # The specific regression case, spelled out explicitly: 832x1216 must no
    # longer return 1664x2432 / 2.0x.
    width, height, scale_factor = compute_scale_by_multiple(832, 1216, 64, 0, 1.5)
    assert (width, height) != (1664, 2432)
    assert scale_factor != 2.0
    assert abs(scale_factor - 1.5) / 1.5 <= tolerance


def test_scale_by_aspect_drift_stays_small():
    # "Close to the requested scale" must not be achieved by mangling the
    # source aspect ratio - bound the drift to a small tolerance (~2%) for
    # every standard resolution at scale_by=1.5.
    aspect_drift_tolerance = 0.02
    for width, height in STANDARD_RESOLUTIONS:
        target_width, target_height, _ = compute_scale_by_multiple(width, height, 64, 0, 1.5)
        source_ratio = width / height
        target_ratio = target_width / target_height
        relative_drift = abs(target_ratio - source_ratio) / source_ratio
        assert relative_drift <= aspect_drift_tolerance, (width, height, target_width, target_height, relative_drift)


def test_max_long_edge_still_caps_a_scale_by_enlarged_result():
    # 1024x1024 at scale_by=1.5 uncapped is 1536x1536 (see the test above) -
    # capping to 1200 must shrink it back under the cap, still aligned.
    uncapped_width, uncapped_height, _ = compute_scale_by_multiple(1024, 1024, 64, 0, 1.5)
    assert max(uncapped_width, uncapped_height) > 1200

    width, height, scale = compute_scale_by_multiple(1024, 1024, 64, 1200, 1.5)
    assert max(width, height) <= 1200
    assert width % 64 == 0 and height % 64 == 0
    assert scale < 1.5


def test_normalize_scale_by_degenerate_values_are_handled_sanely():
    # 0 / negative collapse to the MIN_SCALE_BY floor (never crash, never
    # scale to zero/mirror) - a documented, deliberate choice (see
    # normalize_scale_by's own docstring), not "falls back to 1.0".
    assert normalize_scale_by(0) == MIN_SCALE_BY
    assert normalize_scale_by(-5) == MIN_SCALE_BY
    # Absurdly large values are clamped to MAX_SCALE_BY, not left unbounded.
    assert normalize_scale_by(999) == MAX_SCALE_BY
    # Non-finite/non-numeric input falls back to the neutral default.
    assert normalize_scale_by(float("nan")) == DEFAULT_SCALE_BY
    assert normalize_scale_by(None) == DEFAULT_SCALE_BY
    assert normalize_scale_by("not-a-number") == DEFAULT_SCALE_BY


def test_compute_scale_by_multiple_degenerate_scale_by_does_not_crash():
    # A 0/negative scale_by must not raise or produce a 0/negative size -
    # it collapses to the smallest usable positive scale (MIN_SCALE_BY),
    # still multiple-aligned.
    width, height, scale = compute_scale_by_multiple(1024, 1024, 64, 0, 0)
    assert width >= 1 and height >= 1
    assert width % 64 == 0 and height % 64 == 0
    assert scale > 0

    width, height, scale = compute_scale_by_multiple(1024, 1024, 64, 0, -3)
    assert width >= 1 and height >= 1
    assert width % 64 == 0 and height % 64 == 0
    assert scale > 0


def test_node_scale_by_default_matches_reference_pack():
    # Mirrors the reference pack's own EasyUseAnimaImageScaleByMultiple
    # widget default (1.5) - see node_anima_image_scale.py's own comment on
    # why this differs from the pure function's neutral default.
    schema = AnimaImageScaleByMultiple.INPUT_TYPES()
    assert schema["required"]["scale_by"][1]["default"] == 1.5


def test_smoke_full_node_with_torch_and_comfy_if_available():
    try:
        import torch  # type: ignore
        import comfy.utils  # noqa: F401  # type: ignore
    except Exception as exc:
        print(f"SKIP  test_smoke_full_node_with_torch_and_comfy_if_available: {exc} (not running inside ComfyUI)")
        return

    node = AnimaImageScaleByMultiple()
    image = torch.rand(1, 700, 1000, 3)  # [B, H, W, C], matches ComfyUI's IMAGE layout
    scaled, width, height, scale = node.scale(image, scale_by=1.0, multiple=64, max_long_edge=0, upscale_method="bicubic")
    assert width % 64 == 0 and height % 64 == 0
    assert scaled.shape[0] == 1 and scaled.shape[1] == height and scaled.shape[2] == width and scaled.shape[3] == 3
    assert scale >= 1.0


ALL_TESTS = [
    test_align_up_rounds_up_to_multiple,
    test_align_down_rounds_down_to_multiple,
    test_normalize_upscale_method_valid_passthrough,
    test_normalize_upscale_method_invalid_falls_back_to_default,
    test_already_aligned_square_is_identity,
    test_unaligned_square_rounds_up,
    test_non_square_preserves_exact_aspect_ratio,
    test_max_long_edge_caps_result_downward,
    test_max_long_edge_no_effect_when_already_under_cap,
    test_multiple_of_one_disables_alignment,
    test_multiple_of_one_still_honors_max_long_edge,
    test_degenerate_cap_smaller_than_multiple_does_not_crash,
    test_node_input_types_contract,
    test_scale_by_default_is_one_point_zero_the_neutral_no_op_value,
    test_scale_by_one_is_byte_identical_to_pre_scale_by_behavior,
    test_scale_by_one_point_five_enlarges_every_standard_resolution,
    test_scale_by_lands_close_to_requested_scale_for_standard_resolutions,
    test_scale_by_aspect_drift_stays_small,
    test_max_long_edge_still_caps_a_scale_by_enlarged_result,
    test_normalize_scale_by_degenerate_values_are_handled_sanely,
    test_compute_scale_by_multiple_degenerate_scale_by_does_not_crash,
    test_node_scale_by_default_matches_reference_pack,
    test_smoke_full_node_with_torch_and_comfy_if_available,
]


if __name__ == "__main__":
    failures = []
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
