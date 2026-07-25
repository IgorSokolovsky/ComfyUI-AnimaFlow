"""Pure geometry logic for `AnimaRegionMaskEditor`.

The node's whole design point (see the plan's Phase 4 section /
`playground/anima_region_mask_editor.html`) is that region geometry never
crosses the wire as a custom type: regions are authored in the node's JS as
normalized `0..1` rect/ellipse boxes, mirrored into the hidden `regions`
STRING widget as JSON, and rasterized to real `MASK` tensors HERE, in
Python, before the node returns anything. Everything in this module up to
`rasterize_region_rows` is plain-Python/no-import (no `torch`, no `comfy`)
so it is fully unit-testable outside a ComfyUI process; only the two
tensor-producing functions at the bottom import `torch`, and only lazily
inside their own function bodies (mirrors
`nodes/anima/_anima_image_scale_helpers.py` / `node_anima_image_scale.py`'s
lazy-`comfy.utils` convention).

## Region schema

`{"id": int, "label": str, "shape": "rect"|"ellipse", "x": float, "y":
float, "w": float, "h": float}`, with `x/y/w/h` normalized `0..1` against
whatever `canvas_width`/`canvas_height` the node is configured with — matches
`playground/anima_region_mask_editor.html`'s `masks` array (and
`js/anima/anima_region_mask_editor/core.mjs`'s mirrored JS shape) field-for-
field.

## Why the region cap is 6

`AnimaRegionMaskEditor` exposes exactly 6 numbered `MASK` outputs
(`RETURN_TYPES = ("MASK",) * 6`, matching `AnimaRegionalConditioning`'s 6
numbered input pairs on the other end of this pack's regional-prompting
pair). A 7th authored region would have no output slot to rasterize into,
so `parse_regions` silently caps the parsed list at `MAX_REGIONS` rather
than raising or silently dropping data in a surprising place downstream —
the cap is enforced at parse time, in the one function every other piece of
this module (and the node itself) funnels through.

## MASK tensor shape/dtype

`rasterize_to_mask_tensor`/`empty_mask_tensor` produce shape `(1, height,
width)`, `dtype=torch.float32`, values in `[0.0, 1.0]` — a batch-of-one,
channel-less mask, matching ComfyUI's own `MASK` convention (`[B, H, W]`,
no trailing channel dim, unlike `IMAGE`'s `[B, H, W, C]`). Evidence for this
shape (this dev environment has no `torch`/`comfy` installed, so it cannot
be verified by actually running a core mask node — see the module docstring
convention in `nodes/anima/_comfy_core_bridge.py`):

- `../ComfyUI-EasyUseAnima/easyuse_anima/prompt/regional.py`'s own
  `_regional_union_mask_for_ids` (the reference pack's closest analogue to
  this function) builds `mask_tensor = torch.zeros((height, width),
  dtype=torch.float32)` and returns `mask_tensor.unsqueeze(0)` — i.e. the
  exact same `(1, H, W)` float32 shape adopted here.
- `../ComfyUI-EasyUseAnima/easyuse_anima/prompt/regional.py`'s
  `_regional_mask_bounds_area` (consumer side) explicitly branches on
  `len(mask.shape) == 3` (batched, `[B, H, W]`) vs `== 2` (bare `[H, W]`),
  confirming both shapes are treated as valid `MASK` tensors in the wild but
  the batched 3D form is what this pack's own reference code actually
  *produces*.

# VERIFY-IN-COMFYUI: the shape/dtype above (and whether ComfyUI's core mask
# consumers are equally happy with a bare 2D `(H, W)` tensor, which some
# core nodes accept via an internal `.unsqueeze(0)` normalization step) is
# not exercised by this repo's plain-script test suite, which has no
# `torch` install and cannot import a live ComfyUI `nodes.py`/`comfy.utils`
# to compare against directly (see `_comfy_core_bridge.py`'s own
# `VERIFY-IN-COMFYUI` note for why bare `import nodes`/`import comfy` behave
# differently here than inside a real ComfyUI process). Confirm the exact
# shape a live ComfyUI's `LoadImageMask`/`SolidMask`/`MaskComposite` core
# nodes emit before shipping if this ever misbehaves downstream.
"""

from __future__ import annotations

import json

MAX_REGIONS = 6
VALID_SHAPES = ("rect", "ellipse")
DEFAULT_SHAPE = "rect"

# The node's own default `regions` widget seed — mirrors
# `playground/anima_region_mask_editor.html`'s starter `masks` array (and
# `js/anima/anima_region_mask_editor/core.mjs`'s `defaultRegions()`) field-
# for-field, so a freshly-added node shows the same two starter regions the
# mockup does.
DEFAULT_REGIONS = [
    {"id": 1, "label": "character A", "shape": "rect", "x": 0.06, "y": 0.18, "w": 0.36, "h": 0.62},
    {"id": 2, "label": "character B", "shape": "ellipse", "x": 0.55, "y": 0.22, "w": 0.38, "h": 0.58},
]
DEFAULT_REGIONS_JSON = json.dumps(DEFAULT_REGIONS)


def _clamp01(value, default: float = 0.0) -> float:
    """Coerce `value` to a float clamped into `[0.0, 1.0]`; falls back to
    `default` (never raises) for anything non-numeric, including NaN."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN != NaN
        return default
    return max(0.0, min(1.0, number))


def _normalize_region(raw, index: int) -> dict:
    """Normalize one raw region object (from tolerant-parsed JSON, so it may
    be anything) into the class contract: unknown/missing `shape` -> "rect",
    missing/non-numeric `id` -> `index + 1`, missing `label` -> a generated
    placeholder, `x/y/w/h` clamped into `0..1` and further clamped so
    `x + w <= 1` / `y + h <= 1` (a region can never claim to extend past the
    canvas edge, matching `region_to_pixel_box`'s own clamping)."""
    region = raw if isinstance(raw, dict) else {}

    shape = region.get("shape")
    shape = shape if shape in VALID_SHAPES else DEFAULT_SHAPE

    region_id = region.get("id")
    try:
        region_id = int(region_id)
    except (TypeError, ValueError):
        region_id = index + 1

    label = region.get("label")
    label = str(label) if label is not None else f"region {index + 1}"

    x = _clamp01(region.get("x"), 0.0)
    y = _clamp01(region.get("y"), 0.0)
    w = _clamp01(region.get("w"), 0.0)
    h = _clamp01(region.get("h"), 0.0)
    w = max(0.0, min(w, 1.0 - x))
    h = max(0.0, min(h, 1.0 - y))

    return {"id": region_id, "label": label, "shape": shape, "x": x, "y": y, "w": w, "h": h}


def parse_regions(raw: str) -> list:
    """Tolerant parse of the `regions` widget's JSON string: invalid JSON,
    or JSON that isn't a list (an object/string/number/null), both return
    `[]` — NEVER raises, since a corrupted hidden widget value must not
    crash a workflow. Non-dict list items (a stray string/number/null
    mixed into an otherwise-valid list) are dropped rather than normalized
    into a placeholder region. Caps the result at `MAX_REGIONS` (see module
    docstring for why)."""
    try:
        data = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        data = None
    if not isinstance(data, list):
        return []
    dict_items = [item for item in data if isinstance(item, dict)]
    return [_normalize_region(item, i) for i, item in enumerate(dict_items[:MAX_REGIONS])]


def region_to_pixel_box(region: dict, canvas_width: int, canvas_height: int) -> tuple:
    """Normalized `0..1` `x/y/w/h` -> integer pixel bounds `(x0, y0, x1,
    y1)`, clamped to `[0, canvas_width]` / `[0, canvas_height]`, guaranteeing
    `x1 >= x0` and `y1 >= y0` (a degenerate/zero-size region never produces
    a negative width/height — it collapses to an empty `x1 == x0` box
    instead)."""
    canvas_width = max(1, int(canvas_width))
    canvas_height = max(1, int(canvas_height))

    x = region.get("x", 0.0)
    y = region.get("y", 0.0)
    w = region.get("w", 0.0)
    h = region.get("h", 0.0)

    x0 = int(round(x * canvas_width))
    y0 = int(round(y * canvas_height))
    x1 = int(round((x + w) * canvas_width))
    y1 = int(round((y + h) * canvas_height))

    x0 = max(0, min(canvas_width, x0))
    y0 = max(0, min(canvas_height, y0))
    x1 = max(0, min(canvas_width, x1))
    y1 = max(0, min(canvas_height, y1))

    if x1 < x0:
        x1 = x0
    if y1 < y0:
        y1 = y0

    return (x0, y0, x1, y1)


def rasterize_region_rows(region: dict, canvas_width: int, canvas_height: int) -> list:
    """Pure-Python rasterization of `region` at `canvas_width` x
    `canvas_height`: returns a list of `canvas_height` rows, each a list of
    `canvas_width` floats (`0.0`/`1.0`) — the exact same pure representation
    `rasterize_to_mask_tensor` below converts to a real tensor, and what
    this module's tests assert against cell-by-cell.

    `rect` fills every pixel inside its pixel box. `ellipse` fills pixels
    whose normalized offset from the box's centre satisfies
    `((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1.0` — the standard
    ellipse inequality, `rx`/`ry` being the box's half-width/half-height
    (floored at `0.5` so a 1px-wide/tall box still has a well-defined
    ellipse). Mirrors `../ComfyUI-EasyUseAnima/easyuse_anima/prompt/
    regional.py`'s `_regional_union_mask_for_ids` ellipse math exactly.
    """
    canvas_width = max(1, int(canvas_width))
    canvas_height = max(1, int(canvas_height))
    rows = [[0.0] * canvas_width for _ in range(canvas_height)]

    x0, y0, x1, y1 = region_to_pixel_box(region, canvas_width, canvas_height)
    if x1 <= x0 or y1 <= y0:
        return rows

    shape = region.get("shape", DEFAULT_SHAPE)
    if shape == "ellipse":
        cx = (x0 + x1 - 1) / 2.0
        cy = (y0 + y1 - 1) / 2.0
        rx = max(0.5, (x1 - x0) / 2.0)
        ry = max(0.5, (y1 - y0) / 2.0)
        for py in range(y0, y1):
            row = rows[py]
            ny = (py - cy) / ry
            ny2 = ny * ny
            for px in range(x0, x1):
                nx = (px - cx) / rx
                if nx * nx + ny2 <= 1.0:
                    row[px] = 1.0
    else:
        for py in range(y0, y1):
            row = rows[py]
            for px in range(x0, x1):
                row[px] = 1.0

    return rows


# ---------------------------------------------------------------------------
# Torch-touching functions — lazy `import torch` inside the function body
# only (see module docstring for the MASK shape/dtype this produces).
# ---------------------------------------------------------------------------


def empty_mask_tensor(width: int, height: int):
    """An all-zeros `MASK` tensor at `(width, height)` — shape `(1, height,
    width)`, `dtype=torch.float32` (see module docstring). Used for any of
    `AnimaRegionMaskEditor`'s 6 output slots beyond however many regions
    have actually been authored, so downstream wiring always receives a
    valid tensor instead of `None` (a documented design decision — see the
    node module's docstring)."""
    import torch  # lazy: only needed at actual execution time inside ComfyUI

    return torch.zeros((1, max(1, int(height)), max(1, int(width))), dtype=torch.float32)


def rasterize_to_mask_tensor(region: dict, width: int, height: int):
    """Rasterize `region` to a real `MASK` tensor at `(width, height)` —
    shape `(1, height, width)`, `dtype=torch.float32` (see module
    docstring). Delegates the actual fill logic to `rasterize_region_rows`
    (pure, tested in detail) and only converts the result to a tensor here."""
    import torch  # lazy: only needed at actual execution time inside ComfyUI

    rows = rasterize_region_rows(region, width, height)
    tensor = torch.tensor(rows, dtype=torch.float32)
    return tensor.unsqueeze(0)


__all__ = (
    "DEFAULT_REGIONS",
    "DEFAULT_REGIONS_JSON",
    "DEFAULT_SHAPE",
    "MAX_REGIONS",
    "VALID_SHAPES",
    "empty_mask_tensor",
    "parse_regions",
    "rasterize_region_rows",
    "rasterize_to_mask_tensor",
    "region_to_pixel_box",
)
