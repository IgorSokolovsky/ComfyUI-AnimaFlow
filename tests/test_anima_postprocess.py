"""Plain-script tests for `src/anima/postprocess.py` (output-size-cap
maths, design doc §6 step 5/§9 fourth item/§1b item 4 -- the fix for the old
port only ever rounding UP).

Run directly: `python tests/test_anima_postprocess.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import postprocess as pp

# ---------------------------------------------------------------------------
# fit_size
# ---------------------------------------------------------------------------


def test_disabled_is_a_no_op():
    w, h, scale = pp.fit_size(3000, 4000, enabled=False)
    assert (w, h, scale) == (3000, 4000, 1.0)


def test_already_within_cap_is_a_no_op():
    w, h, scale = pp.fit_size(1024, 1024, enabled=True, max_long_edge=2048)
    assert (w, h, scale) == (1024, 1024, 1.0)


def test_max_long_edge_downscales_the_long_edge_to_the_cap():
    w, h, scale = pp.fit_size(4096, 2048, enabled=True, mode=pp.MODE_MAX_LONG_EDGE, max_long_edge=2048)
    assert scale < 1.0
    assert max(w, h) <= 2048
    # aspect ratio roughly preserved (within rounding/alignment).
    assert abs((w / h) - (4096 / 2048)) < 0.05


def test_never_enlarges_scale_never_exceeds_one():
    # THE fix (§9): the old port only ever rounded UP. This function must
    # never be able to produce a scale above 1.0 at all.
    w, h, scale = pp.fit_size(512, 512, enabled=True, mode=pp.MODE_MAX_LONG_EDGE, max_long_edge=4096)
    assert scale == 1.0
    assert (w, h) == (512, 512)


def test_megapixels_mode_downscales_when_over_cap():
    w, h, scale = pp.fit_size(4096, 4096, enabled=True, mode=pp.MODE_MEGAPIXELS, max_megapixels=4.0)
    assert scale < 1.0
    assert (w * h) <= 4_000_000 * 1.05  # allow small alignment slack


def test_megapixels_mode_no_op_when_under_cap():
    w, h, scale = pp.fit_size(1000, 1000, enabled=True, mode=pp.MODE_MEGAPIXELS, max_megapixels=4.0)
    assert scale == 1.0


def test_result_is_aligned():
    w, h, scale = pp.fit_size(4001, 4001, enabled=True, mode=pp.MODE_MAX_LONG_EDGE, max_long_edge=2000, align=8)
    assert w % 8 == 0
    assert h % 8 == 0


def test_result_never_below_one_alignment_unit():
    w, h, scale = pp.fit_size(10, 10, enabled=True, mode=pp.MODE_MAX_LONG_EDGE, max_long_edge=1, align=8)
    assert w >= 8 and h >= 8


def test_hostile_input_never_raises():
    w, h, scale = pp.fit_size(-5, "garbage", enabled=True)
    assert w >= 1 and h >= 1


# ---------------------------------------------------------------------------
# run_postprocess -- the settings-tree-shaped wrapper.
# ---------------------------------------------------------------------------


def test_run_postprocess_disabled_reports_no_op():
    metadata = pp.run_postprocess(3000, 2000, {"enabled": False, "fit": {}})
    assert metadata["enabled"] is False
    assert metadata["applied"] is False
    assert metadata["target_width"] == 3000
    assert metadata["target_height"] == 2000


def test_run_postprocess_enabled_applies_the_cap():
    metadata = pp.run_postprocess(4096, 2048, {
        "enabled": True, "fit": {"mode": "max_long_edge", "max_long_edge": 2048},
    })
    assert metadata["applied"] is True
    assert max(metadata["target_width"], metadata["target_height"]) <= 2048


def test_run_postprocess_hostile_settings_never_raises():
    metadata = pp.run_postprocess(100, 100, "not-a-dict")
    assert isinstance(metadata, dict)
    metadata = pp.run_postprocess(100, 100, {"enabled": True, "fit": "not-a-dict"})
    assert isinstance(metadata, dict)
    metadata = pp.run_postprocess(100, 100, {"enabled": True, "fit": {"max_long_edge": "garbage", "max_megapixels": "garbage"}})
    assert isinstance(metadata, dict)


ALL_TESTS = [
    test_disabled_is_a_no_op,
    test_already_within_cap_is_a_no_op,
    test_max_long_edge_downscales_the_long_edge_to_the_cap,
    test_never_enlarges_scale_never_exceeds_one,
    test_megapixels_mode_downscales_when_over_cap,
    test_megapixels_mode_no_op_when_under_cap,
    test_result_is_aligned,
    test_result_never_below_one_alignment_unit,
    test_hostile_input_never_raises,
    test_run_postprocess_disabled_reports_no_op,
    test_run_postprocess_enabled_applies_the_cap,
    test_run_postprocess_hostile_settings_never_raises,
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
