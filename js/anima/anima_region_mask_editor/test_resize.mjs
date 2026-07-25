/**
 * test_resize.mjs — regression tests for the Anima Region Mask Editor
 * frontend:
 *
 *   A. `core.mjs` pure state — region construction/normalization/parsing
 *      mirror `_anima_region_mask_helpers.py`'s schema 1:1 (unknown shape
 *      -> rect, missing id/label defaulted, x/y/w/h clamped into 0..1 and
 *      further clamped so x+w<=1/y+h<=1, non-object list items dropped,
 *      capped at 6), add/remove/shape-switch mutations, and
 *      `moveRegionTo`/`resizeRegionTo`'s clamping mirrors the Python clamp
 *      semantics 1:1 (same cases as `tests/test_anima_region_mask_editor.py`
 *      where applicable).
 *   B. `render.mjs` resize mechanism (ComfyUI-Pixaroma find_replace
 *      mechanism, matched exactly — mirrors
 *      `js/anima_prompt/anima_prompt_studio/test_resize.mjs`):
 *      `measureMinHeight`/`setNodeHeight`/`refitNode`/`scheduleRefit`/
 *      `scheduleInitialFit`.
 *   C. `render.mjs` DOM behavior — `renderStage`/`renderList` build one
 *      box/row per region, `updateRegionGeometryDOM`/`updateRegionShapeDOM`/
 *      `updateRegionSelectionDOM` update in place without touching
 *      siblings, `updateAddButtonsState` disables the add buttons at the
 *      6-region cap.
 *   D. `interaction.mjs` structural-vs-in-place gating — THE core
 *      requirement of this node's build: add/delete a region call
 *      `scheduleRefit` exactly once; a drag/resize (`beginDrag`/
 *      `updateDrag`/`endDrag`) and a shape switch do NOT.
 *   E. `index.js` source-level assertions (same reason as
 *      `js/anima_prompt/anima_prompt_studio/test_resize.mjs`: `app` resolves only
 *      inside a real ComfyUI/browser host) — widget sizing wiring, hides
 *      ONLY the `regions` widget, the guarded initial fit vs. unconditional
 *      refit split, and that `restoreNode` never resizes.
 *
 * Run directly: `node js/anima/anima_region_mask_editor/test_resize.mjs`
 * (plain script, no test framework — matches the project's `python
 * tests/test_x.py` convention).
 *
 * MANUAL-IN-COMFYUI CHECKLIST (cannot be confirmed by this headless
 * harness — the real `addDOMWidget`/LiteGraph runtime contract only exists
 * live):
 *   [ ] Adding/removing a region resizes the node (grows or shrinks to
 *       fit); dragging/resizing a region box or switching its shape does
 *       NOT resize the node; a drag stays smooth (no jitter) all the way
 *       to the stage edges.
 *   [ ] Saving a workflow with authored regions, then reloading the page,
 *       restores exactly the same regions (no dupes) at the saved node
 *       size.
 *   [ ] Queueing the node produces 6 real MASK tensor outputs, matching
 *       `_anima_region_mask_helpers.rasterize_to_mask_tensor`/
 *       `empty_mask_tensor`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  MAX_REGIONS,
  MIN_REGION_SIZE,
  SHAPES,
  addRegion,
  defaultRegions,
  findRegion,
  moveRegionTo,
  normalizeRegion,
  parseRegions,
  removeRegion,
  resizeRegionTo,
  serializeRegions,
  setRegionShape,
} from "./core.mjs";

import {
  buildRoot,
  colorForRegion,
  injectStyles,
  measureMinHeight,
  refitNode,
  renderList,
  renderStage,
  scheduleInitialFit,
  scheduleRefit,
  setNodeHeight,
  updateAddButtonsState,
  updateRegionGeometryDOM,
  updateRegionSelectionDOM,
  updateRegionShapeDOM,
  updateStageAspect,
  CHROME,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";

import {
  beginDrag,
  createRegionHandlers,
  endDrag,
  findWidget,
  handleAddRegion,
  handleDeleteRegion,
  handleShapeChange,
  readCanvasSize,
  renderAll,
  selectRegion,
  syncRegionsWidget,
  updateDrag,
  wireInteractions,
} from "./interaction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let count = 0;

function test(name, fn) {
  count += 1;
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

// ---- Stubbed requestAnimationFrame ------------------------------------

let rafQueue = [];
globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
function flushRAF() {
  const pending = rafQueue;
  rafQueue = [];
  pending.forEach((cb) => cb());
}
function resetRAF() {
  rafQueue = [];
}

globalThis.getComputedStyle = (el) => (el && el.style) || {};

// ---- Minimal DOM stub (mirrors js/anima_prompt/anima_prompt_studio/test_resize.mjs's) ---

function makeDocStub() {
  let doc;

  function makeElement(tag) {
    const el = {
      tagName: tag,
      _listeners: {},
      children: [],
      style: {},
      attributes: {},
      value: "",
      textContent: "",
      innerHTML: "",
      title: "",
      disabled: false,
      selected: false,
      parentNode: null,
      get ownerDocument() {
        return doc;
      },
      classList: {
        _set: new Set(),
        add(c) {
          this._set.add(c);
        },
        remove(c) {
          this._set.delete(c);
        },
        contains(c) {
          return this._set.has(c);
        },
        toggle(c, force) {
          const on = force === undefined ? !this._set.has(c) : !!force;
          if (on) {
            this._set.add(c);
          } else {
            this._set.delete(c);
          }
          return on;
        },
      },
      setAttribute(name, val) {
        el.attributes[name] = val;
      },
      addEventListener(type, fn) {
        (el._listeners[type] = el._listeners[type] || []).push(fn);
      },
      appendChild(child) {
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx >= 0) {
          el.children.splice(idx, 1);
        }
        child.parentNode = null;
        return child;
      },
      getBoundingClientRect() {
        return { width: 0, height: 0 };
      },
      focus() {},
    };
    Object.defineProperty(el, "className", {
      get() {
        return el._className || "";
      },
      set(v) {
        el._className = v;
      },
    });
    Object.defineProperty(el, "firstChild", {
      get() {
        return el.children.length ? el.children[0] : null;
      },
    });
    return el;
  }

  doc = {
    createElement: makeElement,
    createTextNode(text) {
      return { nodeType: 3, textContent: text, parentNode: null };
    },
    getElementById() {
      return null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
  };
  return doc;
}

function fire(el, type, eventObj) {
  (el._listeners[type] || []).forEach((fn) => fn(eventObj || {}));
}

function makeFakeNode(initialSize, widgetValues) {
  const setSizeCalls = [];
  const widgets = Object.entries(widgetValues || {}).map(([name, value]) => ({ name, value }));
  const node = {
    size: initialSize.slice(),
    properties: {},
    widgets,
    setSize(size) {
      setSizeCalls.push(size.slice());
      node.size = size.slice();
    },
    setDirtyCanvas() {},
  };
  return { node, setSizeCalls };
}

function makeMountedRefs() {
  const doc = makeDocStub();
  injectStyles(doc);
  return buildRoot(doc);
}

// =========================================================================
// A. core.mjs — region construction / normalization / parsing / mutations
// =========================================================================

test("SHAPES/MAX_REGIONS are the expected constants", () => {
  assert.deepEqual(SHAPES, ["rect", "ellipse"]);
  assert.equal(MAX_REGIONS, 6);
});

test("defaultRegions mirrors the Python seed shape (2 starter regions)", () => {
  const regions = defaultRegions();
  assert.equal(regions.length, 2);
  assert.equal(regions[0].shape, "rect");
  assert.equal(regions[1].shape, "ellipse");
});

test("normalizeRegion defaults an unrecognized shape to rect", () => {
  const r = normalizeRegion({ id: 1, shape: "triangle", x: 0, y: 0, w: 0.1, h: 0.1 }, 0);
  assert.equal(r.shape, "rect");
});

test("normalizeRegion defaults missing id/label", () => {
  const r = normalizeRegion({ shape: "rect", x: 0, y: 0, w: 0.1, h: 0.1 }, 2);
  assert.equal(r.id, 3);
  assert.ok(typeof r.label === "string" && r.label);
});

test("normalizeRegion clamps out-of-range/negative x/y/w/h into 0..1, keeping x+w<=1", () => {
  const r = normalizeRegion({ id: 1, x: -0.5, y: 1.5, w: 2.0, h: -1.0 }, 0);
  assert.ok(r.x >= 0 && r.x <= 1);
  assert.ok(r.y >= 0 && r.y <= 1);
  assert.equal(r.x, 0);
  assert.equal(r.y, 1);
  assert.ok(r.w >= 0);
  assert.ok(r.h >= 0);
  assert.ok(r.x + r.w <= 1 + 1e-9);
  assert.ok(r.y + r.h <= 1 + 1e-9);
});

test("parseRegions returns [] for malformed JSON (never throws)", () => {
  assert.deepEqual(parseRegions("{not valid"), []);
  assert.deepEqual(parseRegions("[1, 2,"), []);
});

test("parseRegions returns [] for a JSON object/string/number/null", () => {
  assert.deepEqual(parseRegions(JSON.stringify({ a: 1 })), []);
  assert.deepEqual(parseRegions(JSON.stringify("x")), []);
  assert.deepEqual(parseRegions(JSON.stringify(42)), []);
  assert.deepEqual(parseRegions(""), []);
  assert.deepEqual(parseRegions(null), []);
});

test("parseRegions drops non-object list items", () => {
  const raw = JSON.stringify([{ id: 1, x: 0, y: 0, w: 0.1, h: 0.1 }, "nope", 5, null]);
  const regions = parseRegions(raw);
  assert.equal(regions.length, 1);
  assert.equal(regions[0].id, 1);
});

test("parseRegions caps at 6 regions", () => {
  const raw = JSON.stringify(
    Array.from({ length: 10 }, (_, i) => ({ id: i + 1, x: 0, y: 0, w: 0.05, h: 0.05 })),
  );
  assert.equal(parseRegions(raw).length, 6);
});

test("serializeRegions round-trips through parseRegions", () => {
  const regions = [{ id: 1, label: "a", shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
  const round = parseRegions(serializeRegions(regions));
  assert.equal(round[0].label, "a");
});

test("addRegion appends a new region, capped at 6", () => {
  const regions = [];
  const created = addRegion(regions, "ellipse");
  assert.equal(regions.length, 1);
  assert.equal(created.shape, "ellipse");
  for (let i = 0; i < 5; i += 1) {
    addRegion(regions, "rect");
  }
  assert.equal(regions.length, 6);
  const rejected = addRegion(regions, "rect");
  assert.equal(rejected, null, "a 7th add must be rejected");
  assert.equal(regions.length, 6);
});

test("addRegion falls back to rect for an unrecognized shape", () => {
  const regions = [];
  const created = addRegion(regions, "triangle");
  assert.equal(created.shape, "rect");
});

test("removeRegion removes the matching region and returns true", () => {
  const regions = [{ id: 1 }, { id: 2 }];
  assert.equal(removeRegion(regions, 1), true);
  assert.deepEqual(regions.map((r) => r.id), [2]);
});

test("removeRegion returns false for an unknown id", () => {
  const regions = [{ id: 1 }];
  assert.equal(removeRegion(regions, 99), false);
  assert.equal(regions.length, 1);
});

test("setRegionShape switches shape, falls back to rect for unrecognized values", () => {
  const regions = [{ id: 1, shape: "rect" }];
  assert.equal(setRegionShape(regions, 1, "ellipse"), true);
  assert.equal(regions[0].shape, "ellipse");
  setRegionShape(regions, 1, "triangle");
  assert.equal(regions[0].shape, "rect");
  assert.equal(setRegionShape(regions, 99, "ellipse"), false);
});

test("findRegion finds by id or returns null", () => {
  const regions = [{ id: 1 }, { id: 2 }];
  assert.equal(findRegion(regions, 2), regions[1]);
  assert.equal(findRegion(regions, 99), null);
});

test("moveRegionTo clamps x/y into 0..1 and keeps the region inside the canvas (mirrors Python)", () => {
  const region = { id: 1, x: 0.5, y: 0.5, w: 0.3, h: 0.2 };
  moveRegionTo(region, -1, 2);
  assert.ok(region.x >= 0 && region.x <= 1 - region.w + 1e-9);
  assert.ok(region.y >= 0 && region.y <= 1 - region.h + 1e-9);
  assert.equal(region.x, 0);
  assert.equal(region.y, 0.8); // clamped to 1 - h
});

test("moveRegionTo allows a valid in-bounds move", () => {
  const region = { id: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  moveRegionTo(region, 0.3, 0.4);
  assert.equal(region.x, 0.3);
  assert.equal(region.y, 0.4);
});

test("resizeRegionTo clamps w/h into 0..1, floors at MIN_REGION_SIZE, and never exceeds the canvas edge", () => {
  const region = { id: 1, x: 0.8, y: 0.8, w: 0.1, h: 0.1 };
  resizeRegionTo(region, 5.0, -5.0);
  assert.ok(region.w <= 1 - region.x + 1e-9);
  assert.ok(region.h <= 1 - region.y + 1e-9);
  assert.ok(Math.abs(region.w - 0.2) < 1e-9); // capped to 1 - x
  assert.equal(region.h, MIN_REGION_SIZE); // floored, never negative/zero
});

test("resizeRegionTo allows a valid in-bounds resize", () => {
  const region = { id: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
  resizeRegionTo(region, 0.4, 0.3);
  assert.equal(region.w, 0.4);
  assert.equal(region.h, 0.3);
});

// =========================================================================
// B. render.mjs — resize mechanism
// =========================================================================

test("measureMinHeight returns the floor for a missing root", () => {
  assert.equal(measureMinHeight(null), 220);
});

test("measureMinHeight sums visible children + gap + padding, floors at 220, rounds to 4px", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  root.style.rowGap = "10px";
  root.style.paddingTop = "3px";
  root.style.paddingBottom = "3px";
  const a = doc.createElement("div");
  a.offsetHeight = 100;
  a.offsetParent = {};
  const b = doc.createElement("div");
  b.offsetHeight = 100;
  b.offsetParent = {};
  root.appendChild(a);
  root.appendChild(b);
  assert.equal(measureMinHeight(root), 220);
});

test("measureMinHeight skips children whose offsetParent is null", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const visible = doc.createElement("div");
  visible.offsetHeight = 300;
  visible.offsetParent = {};
  const hidden = doc.createElement("div");
  hidden.offsetHeight = 9999;
  hidden.offsetParent = null;
  root.appendChild(visible);
  root.appendChild(hidden);
  assert.equal(measureMinHeight(root), 300);
});

test("setNodeHeight sets height only, preserves width, records _armAutoH", () => {
  const { node, setSizeCalls } = makeFakeNode([460, 300], {});
  setNodeHeight(node, 600);
  assert.equal(node.size[0], 460);
  assert.equal(node.size[1], 600);
  assert.equal(node._armAutoH, 600);
  assert.deepEqual(setSizeCalls[0], [460, 600]);
});

test("refitNode grows the node when measured content + CHROME exceeds current height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 200], {});

  refitNode(node, root);

  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.ok(want > 200);
  assert.equal(setSizeCalls.length, 1);
  assert.equal(node.size[1], want);
  assert.equal(node.size[0], 460);
});

test("refitNode does not shrink a node the user manually enlarged past the last auto-fit height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 900], {});
  node._armAutoH = 300;

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0);
});

test("scheduleRefit defers through requestAnimationFrame — never resizes synchronously", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 200], {});

  scheduleRefit(node, root);
  assert.equal(setSizeCalls.length, 0);
  assert.equal(rafQueue.length, 1);
  flushRAF();
  assert.equal(setSizeCalls.length, 1);
});

test("scheduleInitialFit does not resize when node._armConfigured is true (loaded node keeps saved size)", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 260], {});
  node._armConfigured = true;

  scheduleInitialFit(node, root);
  flushRAF();

  assert.equal(setSizeCalls.length, 0);
  assert.equal(node.size[1], 260);
});

test("scheduleInitialFit DOES fit a genuinely fresh node", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 100], {});

  scheduleInitialFit(node, root);
  flushRAF();

  assert.equal(setSizeCalls.length, 1);
});

// =========================================================================
// C. render.mjs — DOM behavior
// =========================================================================

test("colorForRegion cycles through the 6-color palette by id", () => {
  const c1 = colorForRegion({ id: 1 });
  const c7 = colorForRegion({ id: 7 });
  assert.equal(c1, c7); // (7-1) % 6 === (1-1) % 6
});

test("renderStage builds one box per region, applies the selected class", () => {
  const refs = makeMountedRefs();
  const regions = [{ id: 1, label: "a", shape: "rect", x: 0, y: 0, w: 0.5, h: 0.5 }, { id: 2, label: "b", shape: "ellipse", x: 0.5, y: 0.5, w: 0.3, h: 0.3 }];
  renderStage(refs, regions, 2, null);
  assert.equal(refs.regionEls.size, 2);
  assert.equal(refs.stageEl.children.length, 2);
  assert.ok(refs.regionEls.get(2).el.classList.contains("wtn-arm-region-selected"));
  assert.ok(!refs.regionEls.get(1).el.classList.contains("wtn-arm-region-selected"));
});

test("renderList builds one row per region + an empty-state message when there are none", () => {
  const refs = makeMountedRefs();
  renderList(refs, [], null, null);
  assert.match(refs.listEl.children[0].textContent, /No regions yet/);
  assert.equal(refs.chipEl.textContent, "0 / 6 regions");

  const regions = [{ id: 1, label: "a", shape: "rect" }];
  renderList(refs, regions, 1, null);
  assert.equal(refs.rowEls.size, 1);
  assert.equal(refs.chipEl.textContent, "1 / 6 regions");
  assert.ok(refs.rowEls.get(1).row.classList.contains("wtn-arm-row-selected"));
});

test("updateRegionGeometryDOM updates only the target region's style, never rebuilds", () => {
  const refs = makeMountedRefs();
  const regions = [{ id: 1, shape: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, { id: 2, shape: "rect", x: 0.5, y: 0.5, w: 0.2, h: 0.2 }];
  renderStage(refs, regions, null, null);
  const el1Before = refs.regionEls.get(1).el;
  const el2Before = refs.regionEls.get(2).el;

  regions[0].x = 0.4;
  regions[0].y = 0.4;
  updateRegionGeometryDOM(refs, regions[0]);

  assert.equal(refs.regionEls.get(1).el, el1Before, "same element, no rebuild");
  assert.equal(refs.regionEls.get(2).el, el2Before, "sibling untouched");
  assert.equal(el1Before.style.left, "40%");
  assert.equal(el1Before.style.top, "40%");
});

test("updateRegionShapeDOM updates border-radius + the list row's select value in place", () => {
  const refs = makeMountedRefs();
  const regions = [{ id: 1, label: "a", shape: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }];
  renderStage(refs, regions, null, null);
  renderList(refs, regions, null, null);

  regions[0].shape = "ellipse";
  updateRegionShapeDOM(refs, regions[0]);

  assert.equal(refs.regionEls.get(1).el.style.borderRadius, "50%");
  assert.equal(refs.rowEls.get(1).select.value, "ellipse");
});

test("updateRegionSelectionDOM toggles the selected class across stage boxes and list rows", () => {
  const refs = makeMountedRefs();
  const regions = [{ id: 1, label: "a", shape: "rect", x: 0, y: 0, w: 0.2, h: 0.2 }, { id: 2, label: "b", shape: "rect", x: 0.5, y: 0.5, w: 0.2, h: 0.2 }];
  renderStage(refs, regions, 1, null);
  renderList(refs, regions, 1, null);

  updateRegionSelectionDOM(refs, 2);

  assert.ok(!refs.regionEls.get(1).el.classList.contains("wtn-arm-region-selected"));
  assert.ok(refs.regionEls.get(2).el.classList.contains("wtn-arm-region-selected"));
  assert.ok(!refs.rowEls.get(1).row.classList.contains("wtn-arm-row-selected"));
  assert.ok(refs.rowEls.get(2).row.classList.contains("wtn-arm-row-selected"));
});

test("updateAddButtonsState disables the add buttons once at the 6-region cap", () => {
  const refs = makeMountedRefs();
  updateAddButtonsState(refs, Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })));
  assert.equal(refs.addRectBtn.disabled, false);
  updateAddButtonsState(refs, Array.from({ length: 6 }, (_, i) => ({ id: i + 1 })));
  assert.equal(refs.addRectBtn.disabled, true);
  assert.equal(refs.addEllipseBtn.disabled, true);
});

test("updateStageAspect sets the stage's aspect-ratio style", () => {
  const refs = makeMountedRefs();
  updateStageAspect(refs, 1216, 832);
  assert.equal(refs.stageEl.style.aspectRatio, "1216 / 832");
});

// =========================================================================
// D. interaction.mjs — structural-vs-in-place gating
// =========================================================================

function makeInteractionFixture(initialRegions) {
  resetRAF();
  const refs = makeMountedRefs();
  const { node, setSizeCalls } = makeFakeNode([460, 520], {
    regions: JSON.stringify(initialRegions),
    canvas_width: 1024,
    canvas_height: 1024,
  });
  node.properties.regions = parseRegions(findWidget(node, "regions").value);
  wireInteractions(node, refs);
  renderAll(node, refs);
  return { node, refs, setSizeCalls };
}

test("findWidget/readCanvasSize read the node's live widget values", () => {
  const { node } = makeInteractionFixture([]);
  const size = readCanvasSize(node);
  assert.equal(size.width, 1024);
  assert.equal(size.height, 1024);
});

test("readCanvasSize falls back to 1024 for missing/non-numeric widgets", () => {
  const { node } = makeFakeNode([460, 520], {});
  const size = readCanvasSize(node);
  assert.equal(size.width, 1024);
  assert.equal(size.height, 1024);
});

test("handleAddRegion is STRUCTURAL: adds a region, syncs the widget, schedules exactly one refit", () => {
  const { node, refs } = makeInteractionFixture([]);
  resetRAF();

  handleAddRegion(node, refs, "rect");

  assert.equal(node.properties.regions.length, 1);
  const synced = parseRegions(findWidget(node, "regions").value);
  assert.equal(synced.length, 1, "regions widget must be re-synced");
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
});

test("handleAddRegion is a no-op past the 6-region cap (no refit scheduled)", () => {
  const seed = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, x: 0, y: 0, w: 0.1, h: 0.1 }));
  const { node, refs } = makeInteractionFixture(seed);
  resetRAF();

  handleAddRegion(node, refs, "rect");

  assert.equal(node.properties.regions.length, 6);
  assert.equal(rafQueue.length, 0);
});

test("handleDeleteRegion is STRUCTURAL: removes the region, schedules exactly one refit", () => {
  const seed = [{ id: 1, x: 0, y: 0, w: 0.1, h: 0.1 }, { id: 2, x: 0.5, y: 0.5, w: 0.1, h: 0.1 }];
  const { node, refs } = makeInteractionFixture(seed);
  resetRAF();

  handleDeleteRegion(node, refs, 1);

  assert.equal(node.properties.regions.length, 1);
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("handleShapeChange is NOT structural: no refit scheduled", () => {
  const seed = [{ id: 1, shape: "rect", x: 0, y: 0, w: 0.1, h: 0.1 }];
  const { node, refs } = makeInteractionFixture(seed);
  resetRAF();

  handleShapeChange(node, refs, 1, "ellipse");

  assert.equal(node.properties.regions[0].shape, "ellipse");
  assert.equal(rafQueue.length, 0, "a shape switch must never schedule a refit");
});

test("beginDrag/updateDrag/endDrag (a move) are NOT structural: no refit, widget synced, clamped into 0..1", () => {
  const seed = [{ id: 1, shape: "rect", x: 0.3, y: 0.3, w: 0.2, h: 0.2 }];
  const { node, refs } = makeInteractionFixture(seed);
  refs.stageEl.getBoundingClientRect = () => ({ width: 100, height: 100 });
  resetRAF();

  beginDrag(node, refs, 1, "move", { clientX: 0, clientY: 0 });
  updateDrag(node, refs, { clientX: 50, clientY: -1000 }); // dx=+0.5, dy way out of range

  const region = findRegion(node.properties.regions, 1);
  assert.ok(region.x >= 0 && region.x <= 1 - region.w + 1e-9);
  assert.ok(region.y >= 0 && region.y <= 1 - region.h + 1e-9);
  assert.equal(region.y, 0, "clamped to the top edge despite a huge negative delta");
  assert.equal(rafQueue.length, 0, "a drag must never schedule a refit");

  const synced = parseRegions(findWidget(node, "regions").value);
  assert.ok(Math.abs(synced[0].x - region.x) < 1e-9, "regions widget must be re-synced on every drag step");

  endDrag(refs);
  assert.equal(refs.drag, null);
});

test("beginDrag/updateDrag (a resize) clamps w/h and never exceeds the canvas edge", () => {
  const seed = [{ id: 1, shape: "rect", x: 0.7, y: 0.7, w: 0.1, h: 0.1 }];
  const { node, refs } = makeInteractionFixture(seed);
  refs.stageEl.getBoundingClientRect = () => ({ width: 100, height: 100 });
  resetRAF();

  beginDrag(node, refs, 1, "resize", { clientX: 0, clientY: 0 });
  updateDrag(node, refs, { clientX: 1000, clientY: 1000 }); // huge positive delta

  const region = findRegion(node.properties.regions, 1);
  assert.ok(region.w <= 1 - region.x + 1e-9);
  assert.ok(region.h <= 1 - region.y + 1e-9);
  assert.equal(rafQueue.length, 0, "a resize must never schedule a refit");
});

test("updateDrag is a no-op when no drag is in progress", () => {
  const { node, refs } = makeInteractionFixture([{ id: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.1 }]);
  const before = JSON.stringify(node.properties.regions);
  updateDrag(node, refs, { clientX: 999, clientY: 999 });
  assert.equal(JSON.stringify(node.properties.regions), before);
});

test("selectRegion (list-row click) is NOT structural: only the highlight updates", () => {
  const seed = [{ id: 1, x: 0, y: 0, w: 0.1, h: 0.1 }, { id: 2, x: 0.5, y: 0.5, w: 0.1, h: 0.1 }];
  const { node, refs } = makeInteractionFixture(seed);
  resetRAF();

  selectRegion(node, refs, 2);

  assert.equal(refs.activeId, 2);
  assert.ok(refs.regionEls.get(2).el.classList.contains("wtn-arm-region-selected"));
  assert.equal(rafQueue.length, 0);
});

test("createRegionHandlers caches itself on refs.regionHandlers", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([460, 520], { regions: "[]" });
  node.properties.regions = [];
  const handlers = createRegionHandlers(node, refs);
  assert.equal(refs.regionHandlers, handlers);
});

test("wireInteractions is idempotent (a second call is a no-op)", () => {
  const { node, refs } = makeInteractionFixture([]);
  const before = refs.regionHandlers;
  wireInteractions(node, refs);
  assert.equal(refs.regionHandlers, before);
});

test("clicking the add-rect toolbar button drives the same STRUCTURAL path as handleAddRegion", () => {
  const { node, refs } = makeInteractionFixture([]);
  resetRAF();

  fire(refs.addRectBtn, "click");

  assert.equal(node.properties.regions.length, 1);
  assert.equal(node.properties.regions[0].shape, "rect");
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("syncRegionsWidget mirrors node.properties.regions onto the regions widget", () => {
  const { node } = makeInteractionFixture([]);
  node.properties.regions.push({ id: 1, label: "manual", shape: "rect", x: 0, y: 0, w: 0.1, h: 0.1 });
  syncRegionsWidget(node);
  const synced = parseRegions(findWidget(node, "regions").value);
  assert.equal(synced[0].label, "manual");
});

// =========================================================================
// E. index.js — source-level assertions
// =========================================================================

const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const indexCode = stripComments(indexSource);

test("index.js imports app from the absolute /scripts/app.js path", () => {
  assert.match(indexSource, /from\s+"\/scripts\/app\.js"/);
});

test("index.js hides ONLY the regions widget (not canvas_width/canvas_height)", () => {
  assert.match(indexCode, /hideWidget\(regionsWidget\)/);
  assert.ok(!/hideWidget\(.*[Cc]anvas/.test(indexCode), "canvas_width/canvas_height must stay native widgets");
});

test("index.js creates the widget with the legacy getMinHeight option, backed by measureMinHeight", () => {
  assert.match(indexSource, /getMinHeight/);
  assert.match(indexSource, /measureMinHeight/);
  assert.ok(!/widget\.computeSize\s*=/.test(indexCode), "found a leftover widget.computeSize assignment");
  assert.ok(!/widget\.getHeight\s*=/.test(indexCode), "found a leftover widget.getHeight assignment");
});

test("index.js's widget.computeLayoutSize reports minWidth: 1 for the Nodes 2.0 renderer path", () => {
  assert.match(indexCode, /computeLayoutSize/);
  assert.match(indexCode, /minWidth:\s*1/);
});

test("index.js schedules the guarded initial fit in setupNode, never scheduleRefit there", () => {
  const setupIdx = indexCode.indexOf("function setupNode");
  const setupBody = indexCode.slice(setupIdx, indexCode.indexOf("\n}", setupIdx));
  assert.match(setupBody, /scheduleInitialFit\(/);
  assert.ok(!/scheduleRefit\(/.test(setupBody), "setupNode must use the GUARDED initial fit, not scheduleRefit");
});

test("index.js's restoreNode never calls scheduleRefit or scheduleInitialFit", () => {
  const idx = indexCode.indexOf("function restoreNode");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(!/scheduleRefit\(/.test(body));
  assert.ok(!/scheduleInitialFit\(/.test(body));
});

test("index.js's onConfigure wrap sets _armConfigured = true BEFORE calling the original onConfigure or restoreNode", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onConfigure = function");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  const flagIdx = body.indexOf("_armConfigured = true");
  const origIdx = body.indexOf("originalOnConfigure.apply");
  const restoreIdx = body.indexOf("restoreNode(this)");
  assert.ok(flagIdx >= 0);
  assert.ok(origIdx > flagIdx);
  assert.ok(restoreIdx > flagIdx);
});

test("index.js's restoreNode re-parses regions via parseRegions and rebuilds via renderAll", () => {
  const idx = indexCode.indexOf("function restoreNode");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.match(body, /parseRegions\(/);
  assert.match(body, /renderAll\(/);
});

test("index.js's onRemoved unwires the drag listeners", () => {
  assert.match(indexCode, /unwireInteractions\(/);
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
