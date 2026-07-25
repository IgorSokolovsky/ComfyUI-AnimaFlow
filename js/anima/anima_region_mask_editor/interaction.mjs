/**
 * interaction.mjs — input wiring + state-mutation orchestration for the
 * Anima Region Mask Editor DOM UI.
 *
 * Connects DOM events (region mousedown/drag, list-row shape select/
 * delete, toolbar add buttons) to `core.mjs`'s pure region-state mutations,
 * the hidden `regions` widget mirror, and re-rendering (`render.mjs`).
 * This is the ONE place that decides which mutations are STRUCTURAL (full
 * stage+list rebuild + `scheduleRefit`) vs. in-place (geometry/shape/
 * selection updates, no rebuild, no refit) -- see each handler's own doc
 * comment.
 */

import {
  addRegion,
  findRegion,
  moveRegionTo,
  removeRegion,
  resizeRegionTo,
  serializeRegions,
  setRegionShape,
} from "./core.mjs";
import {
  renderList,
  renderStage,
  scheduleRefit,
  updateAddButtonsState,
  updateRegionGeometryDOM,
  updateRegionSelectionDOM,
  updateRegionShapeDOM,
  updateStageAspect,
} from "./render.mjs";

export function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

/** Read the live `canvas_width`/`canvas_height` widget values (falling back
 * to 1024 for anything missing/non-numeric) -- used only for the stage's
 * cosmetic aspect ratio; the actual rasterization on the Python side always
 * reads the real widget values regardless of what this shows. */
export function readCanvasSize(node) {
  const widthWidget = findWidget(node, "canvas_width");
  const heightWidget = findWidget(node, "canvas_height");
  const width = widthWidget && Number(widthWidget.value);
  const height = heightWidget && Number(heightWidget.value);
  return {
    width: Number.isFinite(width) && width > 0 ? width : 1024,
    height: Number.isFinite(height) && height > 0 ? height : 1024,
  };
}

/** Mirror `node.properties.regions` into the hidden `regions` widget's
 * `.value` -- the serialized-STRING state pattern from the frontend skill:
 * a REAL, still-serializing widget the JS only hides for rendering, never
 * `serialize:false`s. Called after every mutation (structural or not). */
export function syncRegionsWidget(node) {
  const w = findWidget(node, "regions");
  if (w) {
    w.value = serializeRegions(node.properties.regions);
  }
}

/** Full rebuild of the stage + region list + add-button state from the
 * current `node.properties.regions` -- used at mount, after every
 * structural mutation, and after an `onConfigure` restore. Does NOT itself
 * schedule a refit (callers decide). */
export function renderAll(node, refs) {
  const regions = node.properties.regions;
  const size = readCanvasSize(node);
  updateStageAspect(refs, size.width, size.height);
  renderStage(refs, regions, refs.activeId, refs.regionHandlers);
  renderList(refs, regions, refs.activeId, refs.regionHandlers);
  updateAddButtonsState(refs, regions);
}

/** Select region `id` (or `null` to clear selection) -- NOT structural
 * (region/row count and order are unchanged): only the selection highlight
 * updates, in place. */
export function selectRegion(node, refs, id) {
  refs.activeId = id;
  updateRegionSelectionDOM(refs, id);
}

function getStageRect(refs) {
  if (refs.stageEl && typeof refs.stageEl.getBoundingClientRect === "function") {
    const rect = refs.stageEl.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      return rect;
    }
  }
  return { width: 1, height: 1 };
}

/**
 * Begin a move/resize drag on region `id` (mousedown on the region body vs.
 * its corner handle, decided by `render.mjs`'s `buildRegionEl`). Records
 * the drag's starting pointer position and the region's starting geometry
 * on `refs.drag` -- everything `updateDrag` needs to compute a delta on
 * each subsequent mousemove without re-reading the DOM. Also selects the
 * region (in place, no refit).
 */
export function beginDrag(node, refs, id, mode, event) {
  const region = findRegion(node.properties.regions, id);
  if (!region) {
    return;
  }
  const rect = getStageRect(refs);
  refs.drag = {
    id,
    mode,
    startX: (event && event.clientX) || 0,
    startY: (event && event.clientY) || 0,
    origX: region.x,
    origY: region.y,
    origW: region.w,
    origH: region.h,
    rectW: rect.width || 1,
    rectH: rect.height || 1,
  };
  selectRegion(node, refs, id);
}

/**
 * Continue an in-progress drag (mousemove): computes the pointer delta as a
 * fraction of the stage's pixel size, applies it via `moveRegionTo`/
 * `resizeRegionTo` (clamped exactly like the Python side, see `core.mjs`),
 * mirrors the result to the hidden `regions` widget, and updates ONLY that
 * region's `<div>` geometry in place (`updateRegionGeometryDOM`). NEVER
 * calls `scheduleRefit`/re-renders the list -- this is the "continuous
 * in-place update that must not thrash the node size on every mousemove"
 * requirement; see `render.mjs`'s top doc comment for the full reasoning.
 * A no-op if no drag is in progress, or the dragged region was deleted
 * mid-drag.
 */
export function updateDrag(node, refs, event) {
  const drag = refs.drag;
  if (!drag) {
    return;
  }
  const region = findRegion(node.properties.regions, drag.id);
  if (!region) {
    refs.drag = null;
    return;
  }
  const dx = (((event && event.clientX) || 0) - drag.startX) / drag.rectW;
  const dy = (((event && event.clientY) || 0) - drag.startY) / drag.rectH;

  if (drag.mode === "resize") {
    resizeRegionTo(region, drag.origW + dx, drag.origH + dy);
  } else {
    moveRegionTo(region, drag.origX + dx, drag.origY + dy);
  }

  syncRegionsWidget(node);
  updateRegionGeometryDOM(refs, region);
}

/** End the current drag (mouseup) -- a no-op if none is in progress. */
export function endDrag(refs) {
  refs.drag = null;
}

/**
 * Add a region of `shape` -- STRUCTURAL (the region list's row count
 * changes): full `renderAll` rebuild + `scheduleRefit`. A no-op (no rebuild,
 * no refit) if already at the 6-region cap (`addRegion` returns `null`).
 */
export function handleAddRegion(node, refs, shape) {
  const created = addRegion(node.properties.regions, shape);
  if (!created) {
    return;
  }
  syncRegionsWidget(node);
  refs.activeId = created.id;
  renderAll(node, refs);
  scheduleRefit(node, refs.root);
}

/**
 * Delete region `id` -- STRUCTURAL (row count changes): full `renderAll`
 * rebuild + `scheduleRefit`. A no-op if `id` isn't found.
 */
export function handleDeleteRegion(node, refs, id) {
  if (!removeRegion(node.properties.regions, id)) {
    return;
  }
  syncRegionsWidget(node);
  if (refs.activeId === id) {
    refs.activeId = null;
  }
  renderAll(node, refs);
  scheduleRefit(node, refs.root);
}

/**
 * Switch region `id`'s shape -- NOT structural (region/row count and order
 * are unchanged, so no refit): only that region's stage box + list row
 * update in place (`updateRegionShapeDOM`).
 */
export function handleShapeChange(node, refs, id, shape) {
  if (!setRegionShape(node.properties.regions, id, shape)) {
    return;
  }
  syncRegionsWidget(node);
  const region = findRegion(node.properties.regions, id);
  updateRegionShapeDOM(refs, region);
}

/**
 * Build (and cache on `refs.regionHandlers`) the handlers object
 * `render.mjs`'s `renderStage`/`renderList` wire each region box/list row's
 * controls to.
 */
export function createRegionHandlers(node, refs) {
  const handlers = {
    onRegionMouseDown(id, mode, event) {
      beginDrag(node, refs, id, mode, event);
    },
    onSelect(id) {
      selectRegion(node, refs, id);
    },
    onShapeChange(id, shape) {
      handleShapeChange(node, refs, id, shape);
    },
    onDelete(id) {
      handleDeleteRegion(node, refs, id);
    },
  };
  refs.regionHandlers = handlers;
  return handlers;
}

/**
 * Wire the toolbar's add-rect/add-ellipse buttons and the document-level
 * mousemove/mouseup listeners that drive an in-progress drag (a drag can
 * legitimately move the pointer outside the stage's own bounds, so these
 * must be document-level, not stage-scoped -- mirrors
 * `playground/anima_region_mask_editor.html`'s own `window.addEventListener`
 * pattern). Idempotent (a second call on the same `refs` is a no-op).
 * The `document`-level listeners are only attached when a real global
 * `document` exists (never true under this repo's headless
 * `test_resize.mjs` run, same guard `render.mjs`'s `injectStyles` uses for
 * the theme import) -- `beginDrag`/`updateDrag`/`endDrag` themselves are
 * still directly callable/testable without them.
 */
export function wireInteractions(node, refs) {
  if (refs.wired) {
    return refs;
  }
  refs.wired = true;

  createRegionHandlers(node, refs);

  refs.addRectBtn.addEventListener("click", () => handleAddRegion(node, refs, "rect"));
  refs.addEllipseBtn.addEventListener("click", () => handleAddRegion(node, refs, "ellipse"));

  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    const onMouseMove = (event) => updateDrag(node, refs, event);
    const onMouseUp = () => endDrag(refs);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    refs._onDocumentMouseMove = onMouseMove;
    refs._onDocumentMouseUp = onMouseUp;
  }

  return refs;
}

/** Detach the document-level drag listeners `wireInteractions` attached
 * (called from `index.js`'s `onRemoved` hook so a deleted node doesn't
 * leak a listener referencing its own stale `refs`). A no-op if
 * `wireInteractions` never attached any (headless/test environment). */
export function unwireInteractions(refs) {
  if (typeof document === "undefined" || typeof document.removeEventListener !== "function") {
    return;
  }
  if (refs._onDocumentMouseMove) {
    document.removeEventListener("mousemove", refs._onDocumentMouseMove);
  }
  if (refs._onDocumentMouseUp) {
    document.removeEventListener("mouseup", refs._onDocumentMouseUp);
  }
}
