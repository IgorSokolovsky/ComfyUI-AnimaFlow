"""Plain-script tests for `src/anima/usdu.py` (USDU tile-planning maths,
design doc §6 step 4/§6a's mode_type-vs-tiled_decode note).

Run directly: `python tests/test_anima_usdu.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import usdu as u

# ---------------------------------------------------------------------------
# auto_tile_dimension
# ---------------------------------------------------------------------------


def test_auto_tile_dimension_clamps_to_min_and_max():
    assert u.auto_tile_dimension(100, preferred_size=1024, min_size=512, max_size=2048) >= 512
    assert u.auto_tile_dimension(100000, preferred_size=1024, min_size=512, max_size=2048) <= 2048


def test_auto_tile_dimension_aligns_to_64():
    for target in (1000, 1537, 2049, 777):
        assert u.auto_tile_dimension(target) % 64 == 0


def test_auto_tile_dimension_one_tile_when_target_below_preferred():
    # A target smaller than the preferred tile size splits into exactly one tile.
    result = u.auto_tile_dimension(800, preferred_size=1024, min_size=512, max_size=2048)
    assert result >= 512


# ---------------------------------------------------------------------------
# plan_usdu_tiles
# ---------------------------------------------------------------------------

_DEFAULT_USDU = {
    "auto_tile_size": True, "auto_tile_target": 1024, "auto_tile_min": 512, "auto_tile_max": 2048,
    "tile_width": 512, "tile_height": 512,
}


def test_plan_scales_target_size_by_scale_by():
    plan = u.plan_usdu_tiles(1024, 1024, 2.0, _DEFAULT_USDU)
    assert plan["target_width"] == 2048
    assert plan["target_height"] == 2048


def test_plan_auto_off_returns_fixed_tile_size_untouched():
    settings = dict(_DEFAULT_USDU, auto_tile_size=False, tile_width=768, tile_height=640)
    plan = u.plan_usdu_tiles(1024, 1024, 2.0, settings)
    assert plan["auto"] is False
    assert plan["tile_width"] == 768
    assert plan["tile_height"] == 640
    # target size is still reported even in manual mode.
    assert plan["target_width"] == 2048


def test_plan_auto_on_sizes_tiles_against_post_scale_target():
    plan = u.plan_usdu_tiles(1024, 1024, 2.0, _DEFAULT_USDU)
    assert plan["auto"] is True
    assert plan["tile_width"] % 64 == 0
    assert 512 <= plan["tile_width"] <= 2048


def test_plan_reports_input_and_target_sizes():
    plan = u.plan_usdu_tiles(800, 600, 1.5, _DEFAULT_USDU)
    assert plan["input_width"] == 800
    assert plan["input_height"] == 600
    assert plan["target_width"] == round(800 * 1.5)
    assert plan["target_height"] == round(600 * 1.5)


def test_mode_type_is_not_part_of_the_tile_plan():
    # §6a: mode_type (tile ORDER) is a completely separate axis from tile
    # SIZE planning -- this module must never read it at all.
    settings_a = dict(_DEFAULT_USDU, mode_type="Linear")
    settings_b = dict(_DEFAULT_USDU, mode_type="Chess")
    plan_a = u.plan_usdu_tiles(1024, 1024, 2.0, settings_a)
    plan_b = u.plan_usdu_tiles(1024, 1024, 2.0, settings_b)
    assert plan_a == plan_b


def test_tiled_decode_is_not_part_of_the_tile_plan():
    # §6a: tiled_decode is an unrelated VAE flag, not tile order or tile size.
    settings_a = dict(_DEFAULT_USDU, tiled_decode=True)
    settings_b = dict(_DEFAULT_USDU, tiled_decode=False)
    plan_a = u.plan_usdu_tiles(1024, 1024, 2.0, settings_a)
    plan_b = u.plan_usdu_tiles(1024, 1024, 2.0, settings_b)
    assert plan_a == plan_b


def test_hostile_input_never_raises():
    plan = u.plan_usdu_tiles("garbage", None, "garbage", "not-a-dict")
    assert isinstance(plan, dict)
    assert plan["input_width"] >= 1
    assert plan["input_height"] >= 1

    plan = u.plan_usdu_tiles(1024, 1024, 2.0, {
        "auto_tile_size": True,
        "auto_tile_target": "garbage", "auto_tile_min": "garbage", "auto_tile_max": "garbage",
    })
    assert isinstance(plan, dict)

    plan = u.plan_usdu_tiles(1024, 1024, 2.0, {
        "auto_tile_size": False, "tile_width": "garbage", "tile_height": None,
    })
    assert plan["tile_width"] == 512
    assert plan["tile_height"] == 512


ALL_TESTS = [
    test_auto_tile_dimension_clamps_to_min_and_max,
    test_auto_tile_dimension_aligns_to_64,
    test_auto_tile_dimension_one_tile_when_target_below_preferred,
    test_plan_scales_target_size_by_scale_by,
    test_plan_auto_off_returns_fixed_tile_size_untouched,
    test_plan_auto_on_sizes_tiles_against_post_scale_target,
    test_plan_reports_input_and_target_sizes,
    test_mode_type_is_not_part_of_the_tile_plan,
    test_tiled_decode_is_not_part_of_the_tile_plan,
    test_hostile_input_never_raises,
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
        except Exception as exc:  # noqa: BLE001
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
