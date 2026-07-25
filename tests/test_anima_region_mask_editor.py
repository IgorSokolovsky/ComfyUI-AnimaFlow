"""Plain-script tests for `AnimaRegionMaskEditor`'s pure geometry logic.

Run directly: `python tests/test_anima_region_mask_editor.py` (no pytest,
per project convention). `parse_regions`/`region_to_pixel_box`/
`rasterize_region_rows` need no `torch`/`comfy` import at all; the two
tensor-producing functions (`rasterize_to_mask_tensor`/`empty_mask_tensor`)
are guarded — SKIP-printed (not a failure) if `torch` isn't importable in
this environment, matching every prior phase's convention exactly (see
e.g. `test_anima_image_scale.py`).
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima._anima_region_mask_helpers import (
    DEFAULT_REGIONS_JSON,
    MAX_REGIONS,
    empty_mask_tensor,
    parse_regions,
    rasterize_region_rows,
    rasterize_to_mask_tensor,
    region_to_pixel_box,
)
from nodes.anima.node_anima_region_mask_editor import AnimaRegionMaskEditor


# ---------------------------------------------------------------------------
# parse_regions
# ---------------------------------------------------------------------------


def test_parse_regions_valid_json():
    raw = json.dumps([
        {"id": 1, "label": "a", "shape": "rect", "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4},
        {"id": 2, "label": "b", "shape": "ellipse", "x": 0.5, "y": 0.5, "w": 0.2, "h": 0.2},
    ])
    regions = parse_regions(raw)
    assert len(regions) == 2
    assert regions[0]["id"] == 1
    assert regions[0]["shape"] == "rect"
    assert regions[1]["shape"] == "ellipse"


def test_parse_regions_malformed_json_returns_empty_never_raises():
    assert parse_regions("{not valid") == []
    assert parse_regions("[1, 2,") == []


def test_parse_regions_non_list_json_returns_empty():
    assert parse_regions(json.dumps({"a": 1})) == []
    assert parse_regions(json.dumps("just a string")) == []
    assert parse_regions(json.dumps(42)) == []
    assert parse_regions(json.dumps(None)) == []
    assert parse_regions("") == []
    assert parse_regions(None) == []


def test_parse_regions_clamps_out_of_range_and_negative_xywh():
    raw = json.dumps([{"id": 1, "x": -0.5, "y": 1.5, "w": 2.0, "h": -1.0}])
    region = parse_regions(raw)[0]
    assert 0.0 <= region["x"] <= 1.0
    assert 0.0 <= region["y"] <= 1.0
    assert region["x"] == 0.0
    assert region["y"] == 1.0
    # w/h negative or out-of-range both clamp to a non-negative value that
    # keeps x+w <= 1 / y+h <= 1.
    assert region["w"] >= 0.0
    assert region["h"] >= 0.0
    assert region["x"] + region["w"] <= 1.0 + 1e-9
    assert region["y"] + region["h"] <= 1.0 + 1e-9


def test_parse_regions_unknown_shape_defaults_to_rect():
    raw = json.dumps([{"id": 1, "shape": "triangle", "x": 0, "y": 0, "w": 0.1, "h": 0.1}])
    assert parse_regions(raw)[0]["shape"] == "rect"


def test_parse_regions_missing_id_and_label_defaulted():
    raw = json.dumps([{"shape": "rect", "x": 0, "y": 0, "w": 0.1, "h": 0.1}])
    region = parse_regions(raw)[0]
    assert region["id"] == 1  # defaults to its own 1-based index
    assert isinstance(region["label"], str) and region["label"]


def test_parse_regions_caps_at_six():
    raw = json.dumps([{"id": i, "x": 0, "y": 0, "w": 0.05, "h": 0.05} for i in range(1, 11)])
    regions = parse_regions(raw)
    assert len(regions) == MAX_REGIONS == 6


def test_parse_regions_drops_non_dict_list_items():
    raw = json.dumps([{"id": 1, "x": 0, "y": 0, "w": 0.1, "h": 0.1}, "nope", 5, None])
    regions = parse_regions(raw)
    assert len(regions) == 1
    assert regions[0]["id"] == 1


# ---------------------------------------------------------------------------
# region_to_pixel_box
# ---------------------------------------------------------------------------


def test_region_to_pixel_box_exact_known_bounds():
    region = {"x": 0.25, "y": 0.5, "w": 0.5, "h": 0.25}
    box = region_to_pixel_box(region, 100, 200)
    assert box == (25, 100, 75, 150)


def test_region_to_pixel_box_clamps_at_canvas_edges():
    region = {"x": 0.9, "y": 0.9, "w": 0.5, "h": 0.5}
    box = region_to_pixel_box(region, 100, 100)
    x0, y0, x1, y1 = box
    assert x1 <= 100 and y1 <= 100
    assert x0 <= x1 and y0 <= y1


def test_region_to_pixel_box_negative_origin_clamped_to_zero():
    region = {"x": -1.0, "y": -1.0, "w": 0.2, "h": 0.2}
    x0, y0, x1, y1 = region_to_pixel_box(region, 100, 100)
    assert x0 == 0 and y0 == 0


def test_region_to_pixel_box_degenerate_zero_size_no_negative_dims():
    region = {"x": 0.5, "y": 0.5, "w": 0.0, "h": 0.0}
    x0, y0, x1, y1 = region_to_pixel_box(region, 100, 100)
    assert x1 >= x0
    assert y1 >= y0
    assert x1 - x0 == 0
    assert y1 - y0 == 0


def test_region_to_pixel_box_near_zero_size_no_negative_dims():
    region = {"x": 0.999, "y": 0.999, "w": 0.0001, "h": 0.0001}
    x0, y0, x1, y1 = region_to_pixel_box(region, 10, 10)
    assert x1 >= x0
    assert y1 >= y0


# ---------------------------------------------------------------------------
# rasterize_region_rows
# ---------------------------------------------------------------------------


def test_rasterize_full_canvas_rect_is_all_ones():
    region = {"shape": "rect", "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
    rows = rasterize_region_rows(region, 8, 8)
    assert len(rows) == 8 and all(len(row) == 8 for row in rows)
    assert all(cell == 1.0 for row in rows for cell in row)


def test_rasterize_quadrant_rect_fills_exact_cells():
    # Top-left quadrant of an 8x8 canvas: x in [0,4), y in [0,4).
    region = {"shape": "rect", "x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}
    rows = rasterize_region_rows(region, 8, 8)
    for y in range(8):
        for x in range(8):
            expected = 1.0 if (x < 4 and y < 4) else 0.0
            assert rows[y][x] == expected, f"cell ({x},{y}) expected {expected}, got {rows[y][x]}"
    # Explicit spot-checks, not just the totals.
    assert rows[0][0] == 1.0
    assert rows[3][3] == 1.0
    assert rows[4][0] == 0.0
    assert rows[0][4] == 0.0
    assert rows[7][7] == 0.0


def test_rasterize_ellipse_centre_filled_box_corners_not():
    # A centred ellipse spanning the whole 8x8 canvas: its centre pixel must
    # be filled, but the BOX's corners must not be -- this is the assertion
    # that actually proves ellipse != rect (a rect would fill the corners).
    region = {"shape": "ellipse", "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
    rows = rasterize_region_rows(region, 8, 8)
    assert rows[4][4] == 1.0  # centre-ish pixel
    assert rows[0][0] == 0.0  # box corner
    assert rows[0][7] == 0.0  # box corner
    assert rows[7][0] == 0.0  # box corner
    assert rows[7][7] == 0.0  # box corner


def test_rasterize_8x8_hand_checked_grid_rect():
    # A 4x4 rect in the centre of an 8x8 canvas: x=[2,6), y=[2,6).
    region = {"shape": "rect", "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}
    rows = rasterize_region_rows(region, 8, 8)
    expected = [[0.0] * 8 for _ in range(8)]
    for y in range(2, 6):
        for x in range(2, 6):
            expected[y][x] = 1.0
    assert rows == expected


def test_rasterize_8x8_hand_checked_grid_ellipse():
    # A 4x4-box ellipse centred at (3.5, 3.5), radius 2 in an 8x8 canvas:
    # box spans x=[2,6), y=[2,6) -- hand-verified against
    # ((px-3.5)/2)**2 + ((py-3.5)/2)**2 <= 1.0 for px,py in [2..5].
    region = {"shape": "ellipse", "x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5}
    rows = rasterize_region_rows(region, 8, 8)
    cx = cy = 3.5
    r = 2.0
    expected = [[0.0] * 8 for _ in range(8)]
    for y in range(2, 6):
        for x in range(2, 6):
            if ((x - cx) / r) ** 2 + ((y - cy) / r) ** 2 <= 1.0:
                expected[y][x] = 1.0
    assert rows == expected
    # Sanity: the corners of the box are excluded (ellipse != rect), the
    # centre is included.
    assert expected[2][2] == 0.0
    assert expected[3][3] == 1.0


def test_rasterize_region_beyond_canvas_edge_produces_no_negative_geometry():
    region = {"shape": "rect", "x": 0.999, "y": 0.999, "w": 0.5, "h": 0.5}
    rows = rasterize_region_rows(region, 4, 4)
    assert len(rows) == 4 and all(len(row) == 4 for row in rows)


# ---------------------------------------------------------------------------
# Guarded torch paths
# ---------------------------------------------------------------------------


def test_empty_mask_tensor_guarded():
    try:
        import torch  # type: ignore
    except Exception as exc:
        print(f"SKIP  test_empty_mask_tensor_guarded: {exc} (not running inside ComfyUI)")
        return

    tensor = empty_mask_tensor(64, 32)
    assert tuple(tensor.shape) == (1, 32, 64)
    assert float(tensor.max()) == 0.0
    assert float(tensor.min()) == 0.0


def test_rasterize_to_mask_tensor_guarded():
    try:
        import torch  # type: ignore
    except Exception as exc:
        print(f"SKIP  test_rasterize_to_mask_tensor_guarded: {exc} (not running inside ComfyUI)")
        return

    region = {"shape": "rect", "x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}
    tensor = rasterize_to_mask_tensor(region, 8, 8)
    assert tuple(tensor.shape) == (1, 8, 8)
    assert float(tensor[0, 0, 0]) == 1.0
    assert float(tensor[0, 7, 7]) == 0.0


def test_node_build_guarded_smoke():
    try:
        import torch  # type: ignore  # noqa: F401
    except Exception as exc:
        print(f"SKIP  test_node_build_guarded_smoke: {exc} (not running inside ComfyUI)")
        return

    node = AnimaRegionMaskEditor()
    regions = json.dumps([{"id": 1, "shape": "rect", "x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}])
    outputs = node.build(canvas_width=16, canvas_height=16, regions=regions)
    assert len(outputs) == MAX_REGIONS
    assert tuple(outputs[0].shape) == (1, 16, 16)
    # Every unused slot (2..6) is a valid all-zeros tensor, never None.
    for extra in outputs[1:]:
        assert extra is not None
        assert tuple(extra.shape) == (1, 16, 16)
        assert float(extra.max()) == 0.0


# ---------------------------------------------------------------------------
# INPUT_TYPES / RETURN_TYPES contract
# ---------------------------------------------------------------------------


def test_node_return_types_are_six_named_masks():
    assert AnimaRegionMaskEditor.RETURN_TYPES == ("MASK",) * 6
    assert AnimaRegionMaskEditor.RETURN_NAMES == tuple(f"mask_{i}" for i in range(1, 7))
    assert len(AnimaRegionMaskEditor.OUTPUT_TOOLTIPS) == 6
    for tooltip in AnimaRegionMaskEditor.OUTPUT_TOOLTIPS:
        assert isinstance(tooltip, str) and tooltip


def test_node_input_types_every_field_has_tooltip():
    schema = AnimaRegionMaskEditor.INPUT_TYPES()
    required = schema["required"]
    assert set(required.keys()) == {"canvas_width", "canvas_height", "regions"}
    for name, spec in required.items():
        assert "tooltip" in spec[1] and spec[1]["tooltip"], f"{name} missing a tooltip"
    assert required["canvas_width"][1]["default"] == 1024
    assert required["canvas_height"][1]["default"] == 1024
    assert required["regions"][1]["default"] == DEFAULT_REGIONS_JSON
    assert AnimaRegionMaskEditor.CATEGORY == "AnimaFlow/anima"
    assert AnimaRegionMaskEditor.FUNCTION == "build"


ALL_TESTS = [
    test_parse_regions_valid_json,
    test_parse_regions_malformed_json_returns_empty_never_raises,
    test_parse_regions_non_list_json_returns_empty,
    test_parse_regions_clamps_out_of_range_and_negative_xywh,
    test_parse_regions_unknown_shape_defaults_to_rect,
    test_parse_regions_missing_id_and_label_defaulted,
    test_parse_regions_caps_at_six,
    test_parse_regions_drops_non_dict_list_items,
    test_region_to_pixel_box_exact_known_bounds,
    test_region_to_pixel_box_clamps_at_canvas_edges,
    test_region_to_pixel_box_negative_origin_clamped_to_zero,
    test_region_to_pixel_box_degenerate_zero_size_no_negative_dims,
    test_region_to_pixel_box_near_zero_size_no_negative_dims,
    test_rasterize_full_canvas_rect_is_all_ones,
    test_rasterize_quadrant_rect_fills_exact_cells,
    test_rasterize_ellipse_centre_filled_box_corners_not,
    test_rasterize_8x8_hand_checked_grid_rect,
    test_rasterize_8x8_hand_checked_grid_ellipse,
    test_rasterize_region_beyond_canvas_edge_produces_no_negative_geometry,
    test_empty_mask_tensor_guarded,
    test_rasterize_to_mask_tensor_guarded,
    test_node_build_guarded_smoke,
    test_node_return_types_are_six_named_masks,
    test_node_input_types_every_field_has_tooltip,
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
