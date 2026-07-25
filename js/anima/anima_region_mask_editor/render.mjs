/**
 * render.mjs — DOM UI for the Anima Region Mask Editor node.
 *
 * Builds ONE DOM root (mounted as a single `addDOMWidget`), styled with the
 * shared house theme (`injectTheme()` + `.wtn-*` classes from
 * `js/shared/theme.{mjs,css}`) instead of re-implementing
 * `playground/anima_region_mask_editor.html`'s inline `<style>` verbatim --
 * the playground is a visual/interaction reference only. Layout is modeled
 * on that mockup: a toolbar (add rect / add ellipse, region-count chip), a
 * canvas "stage" of absolutely-positioned region boxes (drag to move, a
 * corner handle to resize), and a region list below (shape switcher +
 * delete per row) -- stacked vertically rather than the mockup's
 * side-by-side cards, so the node's width stays the user's to set (see the
 * frontend skill's `minWidth: 1` note) instead of needing a fixed
 * side-panel width.
 *
 * ## Resize mechanism -- structural vs. in-place (the hard part)
 *
 * Same `measureMinHeight`/`refitNode`/`scheduleRefit` mechanism as every
 * other DOM-widget node in this pack (`js/anima_prompt/anima_prompt_studio`,
 * ComfyUI-Pixaroma `find_replace`, matched exactly: legacy `getMinHeight` +
 * Nodes 2.0 `computeLayoutSize`, post-layout `requestAnimationFrame`
 * measurement, grow-biased refit with a user-enlarge guard, height-only
 * `setSize`). `interaction.mjs` fires `scheduleRefit` ONLY on a STRUCTURAL
 * change -- adding or deleting a region, which changes the region-list's
 * row count (and therefore the node's needed height) -- never on a
 * drag/resize-in-place update. A drag/resize only ever calls
 * `updateRegionGeometryDOM` (below): it mutates the ALREADY-MOUNTED region
 * `<div>`'s inline `left`/`top`/`width`/`height` percentages directly,
 * touching no other DOM node and never re-measuring/re-fitting the node --
 * so a mousemove-driven drag stays perfectly smooth and never thrashes the
 * node's size, even though the SAME region's list row (shape/label) is
 * left completely alone during the drag too.
 *
 * ## Why `injectTheme` is a GUARDED DYNAMIC import
 *
 * Same reasoning as `js/anima_prompt/anima_prompt_studio/render.mjs`'s own doc
 * comment: a static top-level import of the absolute `/extensions/...`
 * theme URL would make this module fail to load entirely under plain
 * `node js/anima/anima_region_mask_editor/test_resize.mjs` (no real ComfyUI
 * server to serve that path). `injectStyles` only ever attempts the theme
 * import via a dynamic `import()`, gated on a real global `document`
 * existing (i.e. an actual browser). This module's own CSS uses the same
 * `var(--wtn-x, <hardcoded fallback hex>)` pattern every other node's CSS
 * already uses, with the literal hex values copied from `js/shared/
 * theme.mjs`'s `TOKENS` (kept in sync by hand, same as that module's own
 * doc comment asks of every consumer).
 */

import { SHAPES } from "./core.mjs";

const STYLE_ID = "wtn-anima-region-mask-editor-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly -- see this module's doc
// comment above for why these are hardcoded fallbacks rather than an
// imported reference.
const TOKENS = {
  surface: "#151a21",
  surface2: "#1b212a",
  line: "#28303b",
  ink: "#e7ecf3",
  inkDim: "#93a0b1",
  inkFaint: "#5f6c7d",
  console: "#0a0d12",
  accent: "#2dd4bf",
  ok: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  info: "#7dd3fc",
  tmp: "#c4b5fd",
};

// Per-region color palette -- mirrors `playground/anima_region_mask_editor
// .html`'s `COLORS` array exactly (indexed by `(region.id - 1) % 6`, same
// formula the mockup's `color(m)` helper uses).
export const COLORS = [TOKENS.accent, TOKENS.warn, TOKENS.tmp, TOKENS.info, TOKENS.bad, TOKENS.ok];

export function colorForRegion(region) {
  const id = (region && Number(region.id)) || 1;
  const idx = ((id - 1) % COLORS.length + COLORS.length) % COLORS.length;
  return COLORS[idx];
}

const CSS = `
.wtn-arm-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 2px 2px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  /* NO height:100% / min-height here -- see render.mjs's own doc comment. */
}
.wtn-arm-root, .wtn-arm-root * { box-sizing: border-box; }

.wtn-arm-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wtn-arm-addbtn {
  font-family: var(--wtn-font-ui, inherit); font-size: 11.5px; font-weight: 600; cursor: pointer;
  border-radius: 7px; padding: 5px 10px; border: 1px solid var(--wtn-line, ${TOKENS.line});
  background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-arm-addbtn:hover { border-color: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-arm-addbtn:disabled { opacity: .35; cursor: default; }
.wtn-arm-spacer { flex: 1 1 auto; }
.wtn-arm-chip {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}

.wtn-arm-stage {
  position: relative; width: 100%; border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: var(--wtn-radius-sm, 7px); overflow: hidden; cursor: crosshair; user-select: none;
  background:
    linear-gradient(45deg, var(--wtn-surface-2, ${TOKENS.surface2}) 25%, transparent 25%) 0 0/16px 16px,
    linear-gradient(-45deg, var(--wtn-surface-2, ${TOKENS.surface2}) 25%, transparent 25%) 0 0/16px 16px,
    linear-gradient(45deg, transparent 75%, var(--wtn-surface-2, ${TOKENS.surface2}) 75%) 0 0/16px 16px,
    linear-gradient(-45deg, transparent 75%, var(--wtn-surface-2, ${TOKENS.surface2}) 75%) 0 0/16px 16px,
    var(--wtn-console, ${TOKENS.console});
}
.wtn-arm-region {
  position: absolute; border-width: 2px; border-style: solid;
  box-shadow: 0 0 0 1px rgba(0,0,0,.4) inset; cursor: move;
}
.wtn-arm-region.wtn-arm-region-selected { box-shadow: 0 0 0 2px #fff inset, 0 0 0 1px rgba(0,0,0,.4); }
.wtn-arm-region .wtn-arm-rlabel {
  position: absolute; top: -1px; left: -1px; transform: translateY(-100%);
  font-family: var(--wtn-font-mono, monospace); font-size: 10px; font-weight: 700;
  padding: 1px 6px; color: #04110f; border-radius: 4px 4px 0 0; white-space: nowrap;
}
.wtn-arm-region .wtn-arm-handle {
  position: absolute; right: -5px; bottom: -5px; width: 10px; height: 10px;
  background: #fff; border: 1px solid rgba(0,0,0,.5); border-radius: 2px; cursor: se-resize;
}

.wtn-arm-list-empty { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 11.5px; font-style: italic; padding: 2px 0; }
.wtn-arm-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 9px; margin-bottom: 6px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 8px;
  background: var(--wtn-surface-2, ${TOKENS.surface2});
}
.wtn-arm-row.wtn-arm-row-selected { border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-arm-row .wtn-arm-swatch { width: 12px; height: 12px; border-radius: 3px; flex: 0 0 auto; }
.wtn-arm-row .wtn-arm-name {
  font-size: 12px; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-arm-row select {
  font-family: var(--wtn-font-ui, inherit); font-size: 10.5px; padding: 3px 5px;
  background: var(--wtn-console, ${TOKENS.console}); color: var(--wtn-ink, ${TOKENS.ink});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 5px;
}
.wtn-arm-row .wtn-arm-del {
  background: transparent; border: none; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  padding: 2px 6px; font-size: 12px; border-radius: 5px; cursor: pointer;
}
.wtn-arm-row .wtn-arm-del:hover { color: var(--wtn-bad, ${TOKENS.bad}); background: rgba(248,113,113,.14); }
`;

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  if (typeof document !== "undefined") {
    import(THEME_URL)
      .then((mod) => mod.injectTheme())
      .catch(() => {
        // No live ComfyUI server to serve this route -- non-fatal, this
        // module's own CSS already falls back to hardcoded hex values.
      });
  }
  if (typeof targetDoc.getElementById === "function" && targetDoc.getElementById(STYLE_ID)) {
    return;
  }
  const style = targetDoc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  const host = targetDoc.head || targetDoc.body || targetDoc;
  if (host && typeof host.appendChild === "function") {
    host.appendChild(style);
  }
}

/**
 * Build the whole node UI: toolbar (add rect / add ellipse, region-count
 * chip), stage (region boxes), region list. Returns a flat `refs` object
 * every other function in this module / `interaction.mjs` / `index.js`
 * reads from -- no re-querying by class name at call time.
 */
export function buildRoot(doc) {
  const d = doc || document;

  const root = d.createElement("div");
  root.className = "wtn-arm-root wtn";

  // ---- Toolbar ----
  const toolbar = d.createElement("div");
  toolbar.className = "wtn-arm-toolbar";
  const addRectBtn = d.createElement("button");
  addRectBtn.setAttribute("type", "button");
  addRectBtn.className = "wtn-arm-addbtn";
  addRectBtn.textContent = "▭ + rect";
  addRectBtn.title = "Add a rectangular mask region to the canvas (up to 6 total).";
  addRectBtn.setAttribute("aria-label", "Add rectangular region");
  const addEllipseBtn = d.createElement("button");
  addEllipseBtn.setAttribute("type", "button");
  addEllipseBtn.className = "wtn-arm-addbtn";
  addEllipseBtn.textContent = "◯ + ellipse";
  addEllipseBtn.title = "Add an elliptical mask region to the canvas (up to 6 total).";
  addEllipseBtn.setAttribute("aria-label", "Add elliptical region");
  const spacer = d.createElement("span");
  spacer.className = "wtn-arm-spacer";
  const chip = d.createElement("span");
  chip.className = "wtn-arm-chip";
  chip.title =
    "Regions are stored as normalized 0..1 canvas coordinates internally, then rasterized to a " +
    "real MASK tensor at the node's configured canvas size on output -- downstream nodes never " +
    "see geometry, only tensors.";
  toolbar.appendChild(addRectBtn);
  toolbar.appendChild(addEllipseBtn);
  toolbar.appendChild(spacer);
  toolbar.appendChild(chip);

  // ---- Stage ----
  const stage = d.createElement("div");
  stage.className = "wtn-arm-stage";
  stage.title = "Drag a region to move it; drag its corner handle to resize.";

  // ---- Region list ----
  const list = d.createElement("div");
  list.className = "wtn-arm-list";

  root.appendChild(toolbar);
  root.appendChild(stage);
  root.appendChild(list);

  return {
    doc: d,
    root,
    addRectBtn,
    addEllipseBtn,
    chipEl: chip,
    stageEl: stage,
    listEl: list,
    regionEls: new Map(),
    rowEls: new Map(),
    drag: null,
    activeId: null,
  };
}

/** Set the stage's visual aspect ratio to match `canvasWidth`/`canvasHeight`
 * (purely cosmetic -- the actual rasterization always uses the real
 * canvas_width/canvas_height widget values regardless of what this shows). */
export function updateStageAspect(refs, canvasWidth, canvasHeight) {
  const w = Math.max(1, Number(canvasWidth) || 1024);
  const h = Math.max(1, Number(canvasHeight) || 1024);
  refs.stageEl.style.aspectRatio = w + " / " + h;
}

function buildRegionEl(doc, region, handlers) {
  const el = doc.createElement("div");
  el.className = "wtn-arm-region";
  el.style.left = region.x * 100 + "%";
  el.style.top = region.y * 100 + "%";
  el.style.width = region.w * 100 + "%";
  el.style.height = region.h * 100 + "%";
  el.style.borderRadius = region.shape === "ellipse" ? "50%" : "4px";
  const color = colorForRegion(region);
  el.style.borderColor = color;
  el.style.background = color + "33";
  el.title = "Drag to move region " + region.id + " (" + region.label + ").";

  const label = doc.createElement("span");
  label.className = "wtn-arm-rlabel";
  label.textContent = region.id + " · " + region.label;
  label.style.background = color;
  el.appendChild(label);

  const handle = doc.createElement("div");
  handle.className = "wtn-arm-handle";
  handle.title = "Drag to resize region " + region.id + ".";
  handle.setAttribute("aria-label", "Resize region " + region.id);
  el.appendChild(handle);

  if (handlers) {
    el.addEventListener("mousedown", (event) => {
      const mode = event.target === handle ? "resize" : "move";
      handlers.onRegionMouseDown(region.id, mode, event);
      if (event.preventDefault) {
        event.preventDefault();
      }
      if (event.stopPropagation) {
        event.stopPropagation();
      }
    });
  }

  return { el, labelEl: label, handleEl: handle };
}

/**
 * Fully tear down and rebuild the stage's region `<div>`s from `regions`
 * (the STRUCTURAL rebuild path -- initial mount, every add/delete, and
 * `onConfigure` restore). Does NOT itself call `scheduleRefit` -- that is
 * the caller's job (`interaction.mjs`).
 */
export function renderStage(refs, regions, activeId, handlers) {
  while (refs.stageEl.firstChild) {
    refs.stageEl.removeChild(refs.stageEl.firstChild);
  }
  refs.regionEls.clear();

  (regions || []).forEach((region) => {
    const entry = buildRegionEl(refs.doc, region, handlers);
    entry.el.classList.toggle("wtn-arm-region-selected", region.id === activeId);
    refs.regionEls.set(region.id, entry);
    refs.stageEl.appendChild(entry.el);
  });
}

function buildRegionRow(doc, region, handlers) {
  const row = doc.createElement("div");
  row.className = "wtn-arm-row";

  const swatch = doc.createElement("span");
  swatch.className = "wtn-arm-swatch";
  swatch.style.background = colorForRegion(region);

  const name = doc.createElement("span");
  name.className = "wtn-arm-name";
  name.textContent = region.id + " · " + region.label;

  const select = doc.createElement("select");
  select.title = "Switch region " + region.id + "'s shape.";
  select.setAttribute("aria-label", "Region " + region.id + " shape");
  SHAPES.forEach((shape) => {
    const option = doc.createElement("option");
    option.value = shape;
    option.textContent = shape;
    if (shape === region.shape) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  const delBtn = doc.createElement("button");
  delBtn.setAttribute("type", "button");
  delBtn.className = "wtn-arm-del";
  delBtn.textContent = "✕";
  delBtn.title = "Delete region " + region.id + ".";
  delBtn.setAttribute("aria-label", "Delete region " + region.id);

  row.appendChild(swatch);
  row.appendChild(name);
  row.appendChild(select);
  row.appendChild(delBtn);

  if (handlers) {
    row.addEventListener("click", (event) => {
      if (event.target === select || event.target === delBtn) {
        return;
      }
      handlers.onSelect(region.id);
    });
    select.addEventListener("change", () => handlers.onShapeChange(region.id, select.value));
    delBtn.addEventListener("click", () => handlers.onDelete(region.id));
  }

  return { row, swatch, name, select, delBtn };
}

/** Fully tear down and rebuild the region-list rows from `regions` (the
 * STRUCTURAL rebuild path -- see `renderStage`'s doc comment; same
 * triggers). */
export function renderList(refs, regions, activeId, handlers) {
  while (refs.listEl.firstChild) {
    refs.listEl.removeChild(refs.listEl.firstChild);
  }
  refs.rowEls.clear();

  const list = regions || [];
  if (!list.length) {
    const empty = refs.doc.createElement("div");
    empty.className = "wtn-arm-list-empty";
    empty.textContent = "No regions yet. Add one above.";
    refs.listEl.appendChild(empty);
  }

  list.forEach((region) => {
    const entry = buildRegionRow(refs.doc, region, handlers);
    entry.row.classList.toggle("wtn-arm-row-selected", region.id === activeId);
    refs.rowEls.set(region.id, entry);
    refs.listEl.appendChild(entry.row);
  });

  refs.chipEl.textContent = list.length + " / " + 6 + " regions";
}

/** In-place geometry update for ONE region during a drag/resize -- sets
 * the already-mounted `<div>`'s inline left/top/width/height percentages
 * directly. Never touches any other DOM node, never calls
 * `scheduleRefit`/`measureMinHeight` -- see this module's top doc comment
 * for why this is what keeps a mousemove-driven drag from thrashing the
 * node's size. No-op if `region.id` isn't currently rendered. */
export function updateRegionGeometryDOM(refs, region) {
  const entry = refs.regionEls.get(region.id);
  if (!entry) {
    return;
  }
  entry.el.style.left = region.x * 100 + "%";
  entry.el.style.top = region.y * 100 + "%";
  entry.el.style.width = region.w * 100 + "%";
  entry.el.style.height = region.h * 100 + "%";
}

/** Update the shape-dependent visuals (border-radius on the stage box, the
 * list row's select value) for ONE region in place -- no rebuild, since
 * neither the stage's nor the list's row COUNT changes on a shape switch. */
export function updateRegionShapeDOM(refs, region) {
  const stageEntry = refs.regionEls.get(region.id);
  if (stageEntry) {
    stageEntry.el.style.borderRadius = region.shape === "ellipse" ? "50%" : "4px";
  }
  const rowEntry = refs.rowEls.get(region.id);
  if (rowEntry) {
    rowEntry.select.value = region.shape;
  }
}

/** Toggle the "selected" highlight on both the stage box and the list row
 * for `activeId` (and remove it from every other currently-rendered
 * region) -- in place, no rebuild. */
export function updateRegionSelectionDOM(refs, activeId) {
  refs.regionEls.forEach((entry, id) => {
    entry.el.classList.toggle("wtn-arm-region-selected", id === activeId);
  });
  refs.rowEls.forEach((entry, id) => {
    entry.row.classList.toggle("wtn-arm-row-selected", id === activeId);
  });
}

/** Reflect the current region count in the add-button disabled state +
 * tooltip, and the toolbar chip -- called after every structural change. */
export function updateAddButtonsState(refs, regions) {
  const atCap = (regions || []).length >= 6;
  refs.addRectBtn.disabled = atCap;
  refs.addEllipseBtn.disabled = atCap;
  const tip = atCap
    ? "Already at the maximum of 6 regions -- delete one first."
    : "Add a rectangular mask region to the canvas (up to 6 total).";
  const ellipseTip = atCap
    ? "Already at the maximum of 6 regions -- delete one first."
    : "Add an elliptical mask region to the canvas (up to 6 total).";
  refs.addRectBtn.title = tip;
  refs.addEllipseBtn.title = ellipseTip;
}

// ---------------------------------------------------------------------------
// Resize (ComfyUI-Pixaroma find_replace mechanism, matched exactly -- see
// this module's top doc comment)
// ---------------------------------------------------------------------------

export const CHROME = 60;
export const DEFAULT_W = 460;
export const DEFAULT_H = 520;

export function measureMinHeight(root) {
  if (!root) {
    return 220;
  }
  let h = 0;
  let count = 0;
  for (const child of root.children) {
    if (child.offsetParent === null) {
      continue;
    }
    count += 1;
    h += child.offsetHeight;
  }
  const cs = getComputedStyle(root);
  const gap = parseFloat(cs.rowGap || cs.gap) || 0;
  if (count > 1) {
    h += gap * (count - 1);
  }
  h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return Math.max(220, Math.round(h / 4) * 4);
}

export function setNodeHeight(node, h) {
  node.size[1] = h;
  if (typeof node.setSize === "function") {
    node.setSize([node.size[0], h]);
  }
  node._armAutoH = h;
}

export function refitNode(node, root) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const cur = node.size[1];
  const autoH = node._armAutoH;
  const userEnlarged = autoH != null && cur > autoH + 4;
  let target = cur;
  if (want > cur) {
    target = want;
  } else if (!userEnlarged && want < cur) {
    target = want;
  }
  if (target !== cur) {
    setNodeHeight(node, target);
  }
}

export function scheduleRefit(node, root) {
  requestAnimationFrame(() => {
    refitNode(node, root);
    if (node.setDirtyCanvas) {
      node.setDirtyCanvas(true, true);
    }
  });
}

export function scheduleInitialFit(node, root) {
  requestAnimationFrame(() => {
    if (node._armConfigured) {
      // Loaded from a saved workflow -- onConfigure already restored
      // node.size; trust it, don't grow/shrink to content.
      return;
    }
    refitNode(node, root);
    if (node.setDirtyCanvas) {
      node.setDirtyCanvas(true, true);
    }
  });
}
