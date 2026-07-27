/**
 * test_canvas_zoom.mjs — regression tests for `canvas_zoom.mjs` (the
 * wheel-zooms-the-canvas-through-a-DOM-widget fix ported from
 * ComfyUI-Pixaroma's `js/shared/canvas_zoom.mjs`). Plain `node`, minimal
 * stubbed elements/window — no real browser/ComfyUI host, same convention
 * as every other `test_*.mjs` in this pack.
 *
 * MANUAL-IN-COMFYUI CHECKLIST (this headless harness cannot confirm any of
 * this — the real canvas zoom behaviour, and the two scrollable lists
 * actually scrolling, only exist live):
 *   [ ] Wheeling over a Control Panel row (with the cursor NOT over the
 *       option list / ⚙ popover / resolution list) zooms the graph.
 *   [ ] The option list (`.wtn-ctl-menu`) still scrolls with the wheel when
 *       it has more options than fit, and the canvas zooms once scrolled to
 *       either end.
 *   [ ] The latent popover's resolution list (`.wtn-ctl-reslist`) behaves
 *       identically.
 *   [ ] Nodes 2.0 (`Comfy.VueNodes.Enabled`) is unaffected — wheel behaves
 *       exactly as ComfyUI's own Vue renderer already handles it.
 */

import assert from "node:assert/strict";

import { isVueNodes, scrollRegionWantsWheel, installCanvasZoomPassthrough } from "./canvas_zoom.mjs";

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
// Minimal stubs
// ---------------------------------------------------------------------------

function makeEl(overrides = {}) {
  const el = {
    nodeType: 1,
    parentElement: null,
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    scrollLeft: 0,
    scrollWidth: 0,
    clientWidth: 0,
    _listeners: {},
    _dispatched: [],
    addEventListener(type, fn, opts) {
      (el._listeners[type] = el._listeners[type] || []).push({ fn, opts });
    },
    removeEventListener(type, fn) {
      const arr = el._listeners[type];
      if (!arr) {
        return;
      }
      const i = arr.findIndex((entry) => entry.fn === fn);
      if (i >= 0) {
        arr.splice(i, 1);
      }
    },
    dispatchEvent(evt) {
      el._dispatched.push(evt);
      return true;
    },
    ...overrides,
  };
  return el;
}

function fireWheel(root, overrides = {}) {
  let prevented = false;
  let stopped = false;
  const e = {
    type: "wheel",
    target: overrides.target || root,
    clientX: 10,
    clientY: 20,
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {
      stopped = true;
    },
    ...overrides,
  };
  (root._listeners.wheel || []).forEach(({ fn }) => fn(e));
  return { event: e, get prevented() { return prevented; }, get stopped() { return stopped; } };
}

// ---------------------------------------------------------------------------
// isVueNodes
// ---------------------------------------------------------------------------

test("isVueNodes is false with no window at all", () => {
  assert.equal(isVueNodes(), false);
});

test("isVueNodes reflects window.LiteGraph.vueNodesMode live (never cached)", () => {
  globalThis.window = { LiteGraph: { vueNodesMode: false } };
  try {
    assert.equal(isVueNodes(), false);
    globalThis.window.LiteGraph.vueNodesMode = true;
    assert.equal(isVueNodes(), true);
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// scrollRegionWantsWheel -- the four required cases + the scroll-up mirror.
// Deliberately run WITHOUT a global `window` so `styleOf`'s fallback branch
// (reads `el.style` directly) is what's exercised -- see canvas_zoom.mjs's
// own doc comment on why that fallback exists and is what makes this
// function unit-testable at all under plain `node`.
// ---------------------------------------------------------------------------

function makeScrollable({ scrollTop, scrollHeight, clientHeight, overflowY = "auto" }) {
  const el = makeEl({ scrollTop, scrollHeight, clientHeight });
  el.style.overflowY = overflowY;
  return el;
}

test("case 1: room to scroll DOWN + wheel down -> the element wants the wheel (scrolls, no zoom)", () => {
  const root = makeEl();
  const scrollable = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 }); // not at bottom (10+50=60 < 99)
  assert.ok(scrollRegionWantsWheel(scrollable, root, 0, 100));
});

test("case 2: already at the BOTTOM + wheel down -> passes through (canvas zooms)", () => {
  const root = makeEl();
  const scrollable = makeScrollable({ scrollTop: 50, scrollHeight: 100, clientHeight: 50 }); // 50+50=100 >= 99
  assert.equal(scrollRegionWantsWheel(scrollable, root, 0, 100), false);
});

test("case 3: already at the TOP + wheel up -> passes through (canvas zooms)", () => {
  const root = makeEl();
  const scrollable = makeScrollable({ scrollTop: 0, scrollHeight: 100, clientHeight: 50 });
  assert.equal(scrollRegionWantsWheel(scrollable, root, 0, -100), false);
});

test("case 4: no scrollbar at all (content fits, scrollHeight <= clientHeight) -> passes through immediately regardless of direction", () => {
  const root = makeEl();
  const noScroll = makeScrollable({ scrollTop: 0, scrollHeight: 40, clientHeight: 50 });
  assert.equal(scrollRegionWantsWheel(noScroll, root, 0, 100), false);
  assert.equal(scrollRegionWantsWheel(noScroll, root, 0, -100), false);
});

test("mirror of case 1: room to scroll UP + wheel up -> the element wants the wheel", () => {
  const root = makeEl();
  const scrollable = makeScrollable({ scrollTop: 40, scrollHeight: 100, clientHeight: 50 }); // not at top
  assert.ok(scrollRegionWantsWheel(scrollable, root, 0, -100));
});

test("a scrollable element in the MIDDLE of its range keeps the wheel in BOTH directions", () => {
  const root = makeEl();
  const scrollable = makeScrollable({ scrollTop: 25, scrollHeight: 100, clientHeight: 50 });
  assert.ok(scrollRegionWantsWheel(scrollable, root, 0, 100));
  assert.ok(scrollRegionWantsWheel(scrollable, root, 0, -100));
});

test("an element with overflow-y not auto/scroll never wants the wheel, even with room", () => {
  const root = makeEl();
  const notScrollable = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50, overflowY: "hidden" });
  assert.equal(scrollRegionWantsWheel(notScrollable, root, 0, 100), false);
});

test("walks from target up through ancestors to find the scrollable region, stopping at root.parentElement", () => {
  const root = makeEl();
  const scrollable = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
  root.parentElement = scrollable.parentElement; // irrelevant, just wiring
  const child = makeEl({ parentElement: scrollable });
  scrollable.parentElement = null;
  assert.ok(scrollRegionWantsWheel(child, root, 0, 100));
});

test("never wants the wheel once the walk reaches root.parentElement (out of our own DOM)", () => {
  const outerScrollable = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
  const root = makeEl({ parentElement: outerScrollable });
  // target IS root -- the walk starts at root and stops at root.parentElement,
  // so outerScrollable (outside our own widget) is never consulted.
  assert.equal(scrollRegionWantsWheel(root, root, 0, 100), false);
});

test("horizontal scroll (deltaX dominant) uses overflowX/scrollLeft/scrollWidth/clientWidth instead", () => {
  const root = makeEl();
  const el = makeEl({ scrollLeft: 0, scrollWidth: 100, clientWidth: 50 });
  el.style.overflowX = "auto";
  assert.ok(scrollRegionWantsWheel(el, root, 100, 0)); // room to scroll right
  el.scrollLeft = 50; // at the right edge (50+50=100)
  assert.equal(scrollRegionWantsWheel(el, root, 100, 0), false);
});

// ---------------------------------------------------------------------------
// installCanvasZoomPassthrough
// ---------------------------------------------------------------------------

test("installs a NON-PASSIVE wheel listener (required for preventDefault to work)", () => {
  const root = makeEl();
  installCanvasZoomPassthrough(root);
  assert.equal(root._listeners.wheel.length, 1);
  assert.deepEqual(root._listeners.wheel[0].opts, { passive: false });
});

test("returns a no-op (never throws) for a root without addEventListener", () => {
  const uninstall = installCanvasZoomPassthrough(null);
  assert.doesNotThrow(() => uninstall());
});

test("no-ops entirely under Nodes 2.0 (isVueNodes() true): never calls preventDefault, never dispatches to the canvas", () => {
  globalThis.window = { LiteGraph: { vueNodesMode: true } };
  try {
    const root = makeEl();
    const canvas = makeEl();
    installCanvasZoomPassthrough(root, () => canvas);
    const { prevented, stopped } = fireWheel(root);
    assert.equal(prevented, false);
    assert.equal(stopped, false);
    assert.equal(canvas._dispatched.length, 0);
  } finally {
    delete globalThis.window;
  }
});

test("a scrollable region under the cursor wins -- no preventDefault, no dispatch to the canvas", () => {
  const root = makeEl();
  const scrollable = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
  const canvas = makeEl();
  installCanvasZoomPassthrough(root, () => canvas);
  const { prevented } = fireWheel(root, { target: scrollable, deltaY: 100 });
  assert.equal(prevented, false);
  assert.equal(canvas._dispatched.length, 0);
});

test("a plain (non-scrollable) target re-dispatches a synthetic wheel to the canvas, preserving coordinates/deltas", () => {
  globalThis.window = {}; // WheelEvent needs to exist; see note below
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const canvas = makeEl();
    installCanvasZoomPassthrough(root, () => canvas);
    const { prevented, stopped } = fireWheel(root, { clientX: 123, clientY: 456, deltaX: 7, deltaY: -9, deltaMode: 1, ctrlKey: true });
    assert.ok(prevented);
    assert.ok(stopped);
    assert.equal(canvas._dispatched.length, 1);
    const dispatched = canvas._dispatched[0];
    assert.equal(dispatched.type, "wheel");
    assert.equal(dispatched.clientX, 123);
    assert.equal(dispatched.clientY, 456);
    assert.equal(dispatched.deltaX, 7);
    assert.equal(dispatched.deltaY, -9);
    assert.equal(dispatched.deltaMode, 1);
    assert.equal(dispatched.ctrlKey, true);
    assert.equal(dispatched.bubbles, true);
    assert.equal(dispatched.cancelable, true);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("never dispatches when getCanvasEl returns nothing (canvas not yet created/recreated)", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    installCanvasZoomPassthrough(root, () => null);
    const { prevented } = fireWheel(root);
    assert.equal(prevented, false);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("getCanvasEl is called fresh on every wheel event, never cached (the canvas can be recreated)", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    let calls = 0;
    const canvasA = makeEl();
    const canvasB = makeEl();
    installCanvasZoomPassthrough(root, () => {
      calls += 1;
      return calls === 1 ? canvasA : canvasB;
    });
    fireWheel(root);
    fireWheel(root);
    assert.equal(calls, 2);
    assert.equal(canvasA._dispatched.length, 1);
    assert.equal(canvasB._dispatched.length, 1);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("teardown (the returned uninstall fn) removes the listener -- a further wheel event does nothing", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const canvas = makeEl();
    const uninstall = installCanvasZoomPassthrough(root, () => canvas);
    uninstall();
    assert.equal((root._listeners.wheel || []).length, 0);
    fireWheel(root);
    assert.equal(canvas._dispatched.length, 0);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
