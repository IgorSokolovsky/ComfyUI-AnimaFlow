/**
 * core.mjs — pure region-list state for the Anima Region Mask Editor node.
 * No DOM access (importable/testable under plain Node).
 *
 * Mirrors `nodes/anima/_anima_region_mask_helpers.py`'s schema and clamp
 * semantics 1:1 (per the frontend skill's "keep JS render logic byte-for-
 * byte equivalent to the Python render logic" note):
 *   - A region: `{id, label, shape, x, y, w, h}`, x/y/w/h normalized 0..1.
 *   - `parseRegions`/`normalizeRegion` mirror `parse_regions`/
 *     `_normalize_region` -- tolerant parse, unknown shape -> "rect",
 *     missing id/label defaulted, x/y/w/h clamped into 0..1 and further
 *     clamped so x+w <= 1 / y+h <= 1, capped at MAX_REGIONS, non-object
 *     list items dropped.
 *   - `moveRegionTo`/`resizeRegionTo` use the SAME clamp shape Python's
 *     `_normalize_region` does (x/y clamped to 0..1, then w/h capped so the
 *     region never extends past the canvas edge) for continuous drag/
 *     resize updates, plus a JS-only `MIN_REGION_SIZE` usability floor (see
 *     its own doc comment -- Python has no equivalent hard minimum, only
 *     the non-negative-dimensions guarantee `region_to_pixel_box` provides).
 */

export const MAX_REGIONS = 6;
export const SHAPES = ["rect", "ellipse"];
export const DEFAULT_SHAPE = "rect";

// UI-only usability floor so a region can never be dragged/resized down to
// zero-size (and become impossible to grab again) -- Python's own
// `_normalize_region`/`region_to_pixel_box` have no equivalent hard floor,
// only the guarantee that a degenerate/zero-size region never produces
// NEGATIVE pixel dimensions (see `_anima_region_mask_helpers.py`'s own
// tests). This constant is a JS-side-only nicety, not a byte-for-byte
// mirror of anything on the Python side.
export const MIN_REGION_SIZE = 0.02;

// Mirrors `_anima_region_mask_helpers.DEFAULT_REGIONS` /
// `playground/anima_region_mask_editor.html`'s starter `masks` array
// field-for-field.
export function defaultRegions() {
  return [
    { id: 1, label: "character A", shape: "rect", x: 0.06, y: 0.18, w: 0.36, h: 0.62 },
    { id: 2, label: "character B", shape: "ellipse", x: 0.55, y: 0.22, w: 0.38, h: 0.58 },
  ];
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, number));
}

/** Mirrors `_anima_region_mask_helpers._normalize_region` exactly: unknown/
 * missing `shape` -> "rect", missing/non-numeric `id` -> `index + 1`,
 * missing `label` -> a generated placeholder, x/y/w/h clamped into 0..1 and
 * further clamped so x+w <= 1 / y+h <= 1. */
export function normalizeRegion(raw, index) {
  const region = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  const shape = SHAPES.includes(region.shape) ? region.shape : DEFAULT_SHAPE;

  let id = Number(region.id);
  if (!Number.isFinite(id)) {
    id = index + 1;
  }

  const label = region.label != null ? String(region.label) : "region " + (index + 1);

  let x = clamp01(region.x, 0);
  let y = clamp01(region.y, 0);
  let w = clamp01(region.w, 0);
  let h = clamp01(region.h, 0);
  w = Math.max(0, Math.min(w, 1 - x));
  h = Math.max(0, Math.min(h, 1 - y));

  return { id, label, shape, x, y, w, h };
}

/** Tolerant parse of the `regions` widget's JSON string -- mirrors
 * `parse_regions` exactly: invalid JSON, or JSON that isn't a list, both
 * return `[]` (never throws -- a corrupted hidden widget must never break
 * the node's UI); non-object list items are dropped; result capped at
 * `MAX_REGIONS`. */
export function parseRegions(raw) {
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!Array.isArray(data)) {
    return [];
  }
  const objectItems = data.filter((item) => item && typeof item === "object" && !Array.isArray(item));
  return objectItems.slice(0, MAX_REGIONS).map((item, i) => normalizeRegion(item, i));
}

/** Serialize `regions` back to the JSON string the `regions` widget
 * carries (capped defensively at MAX_REGIONS, though callers should never
 * let the in-memory list exceed that in the first place). */
export function serializeRegions(regions) {
  return JSON.stringify((regions || []).slice(0, MAX_REGIONS));
}

function nextRegionId(regions) {
  let max = 0;
  (regions || []).forEach((region) => {
    if (Number.isFinite(region.id) && region.id > max) {
      max = region.id;
    }
  });
  return max + 1;
}

/** Append a new region of `shape` (falls back to "rect" for an
 * unrecognized shape) to `regions`, IN PLACE. Returns the created region,
 * or `null` if `regions` is already at `MAX_REGIONS` (the toolbar's
 * add-rect/add-ellipse buttons are capped at 6, per the plan). */
export function addRegion(regions, shape) {
  if (!Array.isArray(regions) || regions.length >= MAX_REGIONS) {
    return null;
  }
  const id = nextRegionId(regions);
  const region = {
    id,
    label: "region " + id,
    shape: SHAPES.includes(shape) ? shape : DEFAULT_SHAPE,
    x: 0.3,
    y: 0.3,
    w: 0.3,
    h: 0.3,
  };
  regions.push(region);
  return region;
}

/** Remove the region with `id` from `regions`, IN PLACE. Returns `true` if
 * a region was actually removed. */
export function removeRegion(regions, id) {
  const list = regions || [];
  const idx = list.findIndex((region) => region.id === id);
  if (idx === -1) {
    return false;
  }
  list.splice(idx, 1);
  return true;
}

/** Switch the shape of the region with `id`. Returns `true` if found. */
export function setRegionShape(regions, id, shape) {
  const region = findRegion(regions, id);
  if (!region) {
    return false;
  }
  region.shape = SHAPES.includes(shape) ? shape : DEFAULT_SHAPE;
  return true;
}

/** Find a region by id, or `null`. */
export function findRegion(regions, id) {
  return (regions || []).find((region) => region.id === id) || null;
}

/** Move `region` (IN PLACE) so its top-left corner is as close to `(x, y)`
 * as the canvas allows: each coordinate is clamped into `0..1`, then
 * further clamped so the region never extends past the opposite canvas
 * edge (`x <= 1 - w`, `y <= 1 - h`) -- the same clamp shape Python's
 * `_normalize_region` applies. Returns `region`. */
export function moveRegionTo(region, x, y) {
  const cx = clamp01(x, region.x);
  const cy = clamp01(y, region.y);
  region.x = Math.max(0, Math.min(cx, 1 - region.w));
  region.y = Math.max(0, Math.min(cy, 1 - region.h));
  return region;
}

/** Resize `region` (IN PLACE) so its `w`/`h` are as close to `(w, h)` as
 * the canvas allows: each dimension is clamped into `0..1`, floored at
 * `MIN_REGION_SIZE` (JS-only usability floor, see module doc comment), then
 * capped so the region never extends past the canvas edge given its
 * CURRENT `x`/`y` (`w <= 1 - x`, `h <= 1 - y`). Returns `region`. */
export function resizeRegionTo(region, w, h) {
  const cw = clamp01(w, region.w);
  const ch = clamp01(h, region.h);
  region.w = Math.max(MIN_REGION_SIZE, Math.min(cw, 1 - region.x));
  region.h = Math.max(MIN_REGION_SIZE, Math.min(ch, 1 - region.y));
  return region;
}
