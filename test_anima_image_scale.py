"""Plain-script tests for AnimaImageScaleByMultiple's pure logic.

Run directly: `python test_anima_image_scale.py` (no pytest, per project
convention). The ratio/multiple math (`compute_scale_by_multiple`) needs no
torch/comfy import at all; one smoke test additionally exercises the full
node's `scale()` if `torch`/`comfy` happen to be importable in this
environment — it's guarded (skipped with a printed note, not a failure) if
they aren't, since this repo's plain-script suite runs outside ComfyUI.
"""

from __future__ import annotations

from nodes._anima_image_scale_helpers import (
    DEFAULT_UPSCALE_METHOD,
    IMAGE_UPSCALE_METHODS,
    align_down,
    align_up,
    compute_scale_by_multiple,
    normalize_upscale_method,
)
from nodes.node_anima_image_scale import AnimaImageScaleByMultiple


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


def test_smoke_full_node_with_torch_and_comfy_if_available():
    try:
        import torch  # type: ignore
        import comfy.utils  # noqa: F401  # type: ignore
    except Exception as exc:
        print(f"SKIP  test_smoke_full_node_with_torch_and_comfy_if_available: {exc} (not running inside ComfyUI)")
        return

    node = AnimaImageScaleByMultiple()
    image = torch.rand(1, 700, 1000, 3)  # [B, H, W, C], matches ComfyUI's IMAGE layout
    scaled, width, height, scale = node.scale(image, multiple=64, max_long_edge=0, upscale_method="bicubic")
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
