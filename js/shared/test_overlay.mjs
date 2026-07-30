/**
 * test_overlay.mjs — regression tests for `overlay.mjs`, focused on the
 * owner-requested change (2026-07-30): "the LoRA search menu internal scroll
 * should be different than the node's -- it should block the canvas scroll
 * completely, and this should be for all our menus." `openOverlayWithZoom`
 * is the ONE function every popover/menu in this pack opens through, so
 * fixing it here fixes it everywhere at once.
 *
 * This file does NOT re-test the anchoring/positioning/nested-stack
 * behaviour of `openOverlay`/the overlay stack -- that's already covered via
 * the real callers (`js/anima/test_history.mjs`, `js/controls/
 * test_resize.mjs`, etc). It tests exactly one thing `openOverlayWithZoom`
 * itself is responsible for: how it wires `installCanvasZoomPassthrough`
 * onto the overlay element, per this pack's convention of each track/module
 * keeping its own minimal doc stub rather than sharing one (see
 * `js/anima/test_history.mjs`'s own `makeDocStub` doc comment) -- this one
 * only needs enough of a DOM to create elements, append them, and fire wheel
 * events, so it's smaller than that one.
 *
 * Plain `node js/shared/test_overlay.mjs`.
 */
import assert from "node:assert/strict";

import {
  openOverlayWithZoom,
  closeActiveOverlay,
  activeOverlayRef,
  computeAnchoredMaxHeight,
  POPOVER_ANCHOR_GAP_PX,
  POPOVER_VIEWPORT_MARGIN_PX,
} from "./overlay.mjs";

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

// ---------------------------------------------------------------------------
// Minimal doc stub -- just enough for openOverlay to anchor/append elements
// and for a wheel event to be fired at a specific target inside the overlay.
// ---------------------------------------------------------------------------

function makeElement(tag) {
  const e = {
    tagName: tag,
    style: {},
    children: [],
    parentNode: null,
    get parentElement() {
      return e.parentNode;
    },
    _listeners: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    addEventListener(type, fn) {
      (e._listeners[type] = e._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = e._listeners[type];
      if (!arr) {
        return;
      }
      const i = arr.indexOf(fn);
      if (i >= 0) {
        arr.splice(i, 1);
      }
    },
    appendChild(child) {
      e.children.push(child);
      child.parentNode = e;
      return child;
    },
    removeChild(child) {
      const i = e.children.indexOf(child);
      if (i >= 0) {
        e.children.splice(i, 1);
      }
      child.parentNode = null;
      return child;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, right: 30, bottom: 40, width: 20, height: 30 };
    },
    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === e) {
          return true;
        }
        cur = cur.parentNode;
      }
      return false;
    },
  };
  return e;
}

function makeDocStub() {
  const win = {
    _listeners: {},
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener(type, fn) {
      (win._listeners[type] = win._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = win._listeners[type];
      if (!arr) {
        return;
      }
      const i = arr.indexOf(fn);
      if (i >= 0) {
        arr.splice(i, 1);
      }
    },
    setTimeout: (fn) => fn(), // run synchronously -- no real timers needed for these tests
  };
  const doc = {
    createElement: makeElement,
    body: makeElement("body"),
    defaultView: win,
  };
  return doc;
}

/** Fires a wheel event straight at `el`'s own registered listeners (bubbling
 * isn't modeled -- `installCanvasZoomPassthrough` is always installed
 * directly on the overlay root, and reads `e.target` to walk UP looking for
 * a scrollable ancestor, so `target` here can differ from `el`). */
function fireWheel(el, overrides = {}) {
  let prevented = false;
  let stopped = false;
  const e = {
    type: "wheel",
    target: overrides.target || el,
    clientX: 0,
    clientY: 0,
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    ...overrides,
  };
  (el._listeners.wheel || []).forEach((fn) => fn(e));
  return { get prevented() { return prevented; }, get stopped() { return stopped; } };
}

function makeCanvas() {
  const dispatched = [];
  return {
    dispatchEvent(evt) {
      dispatched.push(evt);
      return true;
    },
    get dispatched() {
      return dispatched;
    },
  };
}

// ---------------------------------------------------------------------------
// openOverlayWithZoom's wheel handling
// ---------------------------------------------------------------------------

test("wheel over an overlay opened via openOverlayWithZoom is consumed, never dispatched to the canvas", () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const content = doc.createElement("div");
  const canvas = makeCanvas();
  const handle = openOverlayWithZoom(() => canvas, doc, anchor, content, "below", () => {});
  try {
    const { prevented, stopped } = fireWheel(handle.overlay);
    assert.ok(prevented, "an overlay owns the wheel completely -- it must not leak to the page/canvas behind it");
    assert.ok(stopped);
    assert.equal(canvas.dispatched.length, 0, "menu wheel must never be forwarded to the canvas");
  } finally {
    handle.close();
  }
});

test("a scrollable region inside the overlay content still scrolls normally -- no preventDefault, no canvas dispatch", () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const content = doc.createElement("div");
  const list = doc.createElement("div");
  list.style.overflowY = "auto";
  list.scrollTop = 10;
  list.scrollHeight = 100;
  list.clientHeight = 50; // room to scroll further down (10+50=60 < 99)
  content.appendChild(list);
  const canvas = makeCanvas();
  const handle = openOverlayWithZoom(() => canvas, doc, anchor, content, "below", () => {});
  try {
    const { prevented } = fireWheel(handle.overlay, { target: list, deltaY: 100 });
    assert.equal(prevented, false, "native scroll of the in-overlay list must not be interfered with");
    assert.equal(canvas.dispatched.length, 0);
  } finally {
    handle.close();
  }
});

test("same as above, but the wheel target is a DEEPLY NESTED child (a LoRA result row's own icon, not the scroll list itself) -- the ancestor walk must still find the scrollable list", () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const content = doc.createElement("div");
  const list = doc.createElement("div");
  list.style.overflowY = "auto";
  list.scrollTop = 10;
  list.scrollHeight = 100;
  list.clientHeight = 50;
  const row = doc.createElement("div");
  const icon = doc.createElement("span"); // the actual e.target of a real wheel event over a result row
  row.appendChild(icon);
  list.appendChild(row);
  content.appendChild(list);
  const canvas = makeCanvas();
  const handle = openOverlayWithZoom(() => canvas, doc, anchor, content, "below", () => {});
  try {
    const { prevented } = fireWheel(handle.overlay, { target: icon, deltaY: 100 });
    assert.equal(prevented, false, "the ancestor walk must reach the scrollable list, not stop at the icon");
    assert.equal(canvas.dispatched.length, 0);
  } finally {
    handle.close();
  }
});

test("a short, non-scrolling overlay (no scrollable content at all) simply consumes the wheel -- no zoom, no page scroll leak", () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const content = doc.createElement("div"); // no overflow style anywhere -- nothing to scroll
  const canvas = makeCanvas();
  const handle = openOverlayWithZoom(() => canvas, doc, anchor, content, "right", () => {});
  try {
    const { prevented } = fireWheel(handle.overlay, { target: content });
    assert.ok(prevented);
    assert.equal(canvas.dispatched.length, 0);
  } finally {
    handle.close();
  }
});

test("the wheel listener is removed on close() -- a further wheel event over the (now-detached) overlay does nothing", () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const content = doc.createElement("div");
  const canvas = makeCanvas();
  const handle = openOverlayWithZoom(() => canvas, doc, anchor, content, "below", () => {});
  const overlay = handle.overlay;
  handle.close();
  assert.equal((overlay._listeners.wheel || []).length, 0, "close() must uninstall the wheel listener, not just detach the DOM node");
  const { prevented } = fireWheel(overlay);
  assert.equal(prevented, false);
  assert.equal(canvas.dispatched.length, 0);
});

test("closeActiveOverlay() also tears down the wheel listener via the overlay's own close()", () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const content = doc.createElement("div");
  const canvas = makeCanvas();
  const handle = openOverlayWithZoom(() => canvas, doc, anchor, content, "below", () => {});
  // Mirrors every real caller: push onto the shared stack so closeActiveOverlay finds it.
  activeOverlayRef.current = handle;
  closeActiveOverlay();
  assert.equal((handle.overlay._listeners.wheel || []).length, 0);
});

// ---------------------------------------------------------------------------
// computeAnchoredMaxHeight -- owner-reported overflow bug, 2026-07-30 (the
// LoRA model picker's own `.wtn-mp-panel` clamped itself with a static CSS
// `62vh` only, which overflowed the bottom of the screen for a node sitting
// low in the viewport -- the exact same bug `civitai_search.mjs`'s panel had
// and already fixed via `computeSearchPanelMaxHeight`, extracted here so
// BOTH callers share one computation without `model_picker.mjs` (track-
// agnostic, forbidden from importing a `lora_*`/search-specific module) ever
// depending on `civitai_search.mjs`).
// ---------------------------------------------------------------------------

test("computeAnchoredMaxHeight: anchor near the TOP of a tall viewport -- a large max-height, not a fixed cap", () => {
  // 800px viewport, anchor bottom at 60 (near the top), 30px of chrome above
  // the caller's own scrollable area.
  const maxH = computeAnchoredMaxHeight({ anchorBottom: 60, viewportHeight: 800, chromeHeight: 30 });
  assert.equal(maxH, 800 - 60 - POPOVER_ANCHOR_GAP_PX - POPOVER_VIEWPORT_MARGIN_PX);
  assert.ok(maxH > 600, "plenty of room below a top-anchored popover should yield a large max-height");
});

test("computeAnchoredMaxHeight: anchor near the BOTTOM of the viewport -- clamped to the minimum, never negative or absurdly small", () => {
  const maxH = computeAnchoredMaxHeight({ anchorBottom: 780, viewportHeight: 800, chromeHeight: 30, minContentHeight: 40 });
  assert.equal(maxH, 30 + 40, "floors to chromeHeight + minContentHeight rather than the (negative) raw available space");
  assert.ok(maxH > 0);
});

test("computeAnchoredMaxHeight: non-finite/zero/missing viewportHeight returns null -- the caller must leave its CSS fallback alone", () => {
  assert.equal(computeAnchoredMaxHeight({ anchorBottom: 100, viewportHeight: null, chromeHeight: 30 }), null);
  assert.equal(computeAnchoredMaxHeight({ anchorBottom: 100, viewportHeight: undefined, chromeHeight: 30 }), null);
  assert.equal(computeAnchoredMaxHeight({ anchorBottom: 100, viewportHeight: 0, chromeHeight: 30 }), null);
  assert.equal(computeAnchoredMaxHeight({ anchorBottom: 100, viewportHeight: NaN, chromeHeight: 30 }), null);
  assert.equal(computeAnchoredMaxHeight({ anchorBottom: NaN, viewportHeight: 800, chromeHeight: 30 }), null, "a non-finite anchorBottom must also degrade to null, not a garbage number");
});

test("computeAnchoredMaxHeight: garbage/missing chromeHeight or minContentHeight degrades to 0 rather than throwing or going negative", () => {
  const maxH = computeAnchoredMaxHeight({ anchorBottom: 100, viewportHeight: 800, chromeHeight: null, minContentHeight: undefined });
  assert.equal(maxH, Math.max(0, 800 - 100 - POPOVER_ANCHOR_GAP_PX - POPOVER_VIEWPORT_MARGIN_PX));
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
