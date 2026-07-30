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
 *   [ ] Wheeling a Control Panel/Anima scrollable region to either end and
 *       CONTINUING the same physical scroll gesture (no pause) does NOT
 *       start zooming the canvas mid-gesture — the quiet-period lock below
 *       is only exercised against injected fake time in this headless
 *       harness, never real wheel timing.
 */

import assert from "node:assert/strict";

import { isVueNodes, scrollRegionWantsWheel, installCanvasZoomPassthrough, WHEEL_LOCK_MS } from "./canvas_zoom.mjs";

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

// ---------------------------------------------------------------------------
// Quiet-period lock -- see canvas_zoom.mjs's own top doc comment ("Quiet-
// period lock"). Driven entirely by an injected `now()` -- no real timers.
// ---------------------------------------------------------------------------

/** A fake clock: `{ now, advance }` -- `now()` reads the current fake time,
 * `advance(ms)` moves it forward. Deterministic, no real timers anywhere in
 * this section. */
function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("WHEEL_LOCK_MS default is exported and tunable in one place", () => {
  assert.equal(WHEEL_LOCK_MS, 450);
});

test("a consumed wheel arms the lock: the VERY NEXT unconsumed wheel (0ms later) does not reach the canvas", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const scrollable = makeScrollable({ scrollTop: 50, scrollHeight: 100, clientHeight: 50 }); // at the bottom
    const canvas = makeEl();
    const clock = makeClock(1000);
    installCanvasZoomPassthrough(root, () => canvas, { now: clock.now, lockMs: WHEEL_LOCK_MS });

    // First wheel: still has room (not at bottom yet from THIS delta's
    // perspective -- craft one that's consumed).
    const midScroll = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
    fireWheel(root, { target: midScroll, deltaY: 100 }); // consumed -- arms the lock at t=1000

    // Immediately after (same fake time, 0ms elapsed), a wheel over a
    // NON-scrollable target would normally zoom -- the lock must block it.
    const { prevented } = fireWheel(root, { target: scrollable /* at its end -- not consumed */, deltaY: 100 });
    assert.equal(prevented, false, "the lock must block the canvas dispatch (no preventDefault)");
    assert.equal(canvas._dispatched.length, 0, "the lock must block the canvas dispatch (no re-dispatched wheel)");
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("an unconsumed wheel arriving BEFORE the lock window elapses is still blocked", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const canvas = makeEl();
    const clock = makeClock(0);
    installCanvasZoomPassthrough(root, () => canvas, { now: clock.now, lockMs: 450 });

    const midScroll = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
    fireWheel(root, { target: midScroll, deltaY: 100 }); // consumed at t=0

    clock.advance(449); // one ms short of the lock window
    const { prevented } = fireWheel(root, { deltaY: 100 }); // plain, non-scrollable target
    assert.equal(prevented, false);
    assert.equal(canvas._dispatched.length, 0);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("an unconsumed wheel arriving AFTER the lock window elapses reaches the canvas normally", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const canvas = makeEl();
    const clock = makeClock(0);
    installCanvasZoomPassthrough(root, () => canvas, { now: clock.now, lockMs: 450 });

    const midScroll = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
    fireWheel(root, { target: midScroll, deltaY: 100 }); // consumed at t=0

    clock.advance(450); // exactly the lock window -- no longer "less than" it
    const { prevented } = fireWheel(root, { deltaY: 100 });
    assert.ok(prevented, "past the quiet period, the wheel must zoom the canvas again");
    assert.equal(canvas._dispatched.length, 1);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("the lock is per-root/per-install: one node's consumed scroll never blocks a DIFFERENT node's zoom", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const rootA = makeEl();
    const canvasA = makeEl();
    const rootB = makeEl();
    const canvasB = makeEl();
    const clock = makeClock(0); // both installs share the SAME clock -- proves the lock state itself, not timing, is what's isolated
    installCanvasZoomPassthrough(rootA, () => canvasA, { now: clock.now, lockMs: 450 });
    installCanvasZoomPassthrough(rootB, () => canvasB, { now: clock.now, lockMs: 450 });

    const midScrollA = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
    fireWheel(rootA, { target: midScrollA, deltaY: 100 }); // arms ONLY rootA's lock

    // Same instant, root B's own (unrelated) wheel must zoom normally --
    // root A's lock must not leak into root B's closure.
    const { prevented } = fireWheel(rootB, { deltaY: 100 });
    assert.ok(prevented, "root B's own lock was never armed -- its wheel must reach its own canvas");
    assert.equal(canvasB._dispatched.length, 1);
    assert.equal(canvasA._dispatched.length, 0, "root A's canvas must never receive root B's wheel");
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("the existing two-argument call form still behaves exactly as before (no options -- real Date.now() clock, default 450ms lock)", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const canvas = makeEl();
    installCanvasZoomPassthrough(root, () => canvas); // TWO args, exactly the pre-existing call form
    const { prevented } = fireWheel(root); // plain target, no scroll region involved at all
    assert.ok(prevented, "with no prior consumed wheel, the two-arg form must zoom immediately, same as before this dispatch");
    assert.equal(canvas._dispatched.length, 1);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

// ---------------------------------------------------------------------------
// options.getLockMs -- the LIVE variant of options.lockMs (wires the "Wheel
// quiet period (ms)" Settings-dialog value, js/shared/settings.mjs).
// ---------------------------------------------------------------------------

test("options.getLockMs is called fresh on every wheel event (a live setting can change mid-session, unlike options.lockMs)", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const canvas = makeEl();
    const clock = makeClock(0);
    let currentLockMs = 100;
    installCanvasZoomPassthrough(root, () => canvas, { now: clock.now, getLockMs: () => currentLockMs });

    const midScroll = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
    fireWheel(root, { target: midScroll, deltaY: 100 }); // consumed at t=0, arms the lock

    clock.advance(50); // inside the CURRENT 100ms lock
    let result = fireWheel(root, { deltaY: 100 });
    assert.equal(result.prevented, false, "still inside the 100ms lock -- must not zoom yet");

    // The setting changes LIVE, mid-session, to a shorter quiet period --
    // this must take effect on the very next wheel event, no re-install.
    currentLockMs = 10;
    result = fireWheel(root, { deltaY: 100 }); // t is still only 50ms past the consumed event -- now past the NEW 10ms lock
    assert.ok(result.prevented, "a shorter getLockMs() must apply immediately, without reinstalling");
    assert.equal(canvas._dispatched.length, 1);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("options.getLockMs wins over options.lockMs when both are given", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const canvas = makeEl();
    const clock = makeClock(0);
    installCanvasZoomPassthrough(root, () => canvas, { now: clock.now, lockMs: 450, getLockMs: () => 10 });

    const midScroll = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
    fireWheel(root, { target: midScroll, deltaY: 100 }); // consumed at t=0

    clock.advance(20); // past getLockMs()'s 10ms, well short of lockMs's 450ms
    const { prevented } = fireWheel(root, { deltaY: 100 });
    assert.ok(prevented, "getLockMs (10ms) must be the one honoured, not the stale lockMs (450ms)");
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

// ---------------------------------------------------------------------------
// options.forwardToCanvas: false -- the MENU mode used by
// `js/shared/overlay.mjs`'s `openOverlayWithZoom` (every popover/menu in the
// pack opens through it). An unconsumed wheel is CONSUMED (preventDefault +
// stopPropagation), never re-dispatched to the canvas -- a menu owns the
// wheel completely, it doesn't forward it anywhere. A scrollable region
// inside the overlay that still has room is untouched either way --
// `scrollRegionWantsWheel` doesn't know or care about this option.
// ---------------------------------------------------------------------------

test("forwardToCanvas: false -- a plain (non-scrollable) target consumes the wheel but never dispatches to the canvas", () => {
  const root = makeEl();
  const canvas = makeEl();
  installCanvasZoomPassthrough(root, () => canvas, { forwardToCanvas: false });
  const { prevented, stopped } = fireWheel(root);
  assert.ok(prevented, "a menu must swallow the wheel so it can't leak to the page behind it");
  assert.ok(stopped);
  assert.equal(canvas._dispatched.length, 0, "menu mode never re-dispatches to the canvas");
});

test("forwardToCanvas: false -- a short menu with NOTHING scrollable still does nothing visible: consumed, no dispatch, no throw even with no getCanvasEl at all", () => {
  const root = makeEl();
  installCanvasZoomPassthrough(root, undefined, { forwardToCanvas: false });
  const { prevented } = fireWheel(root);
  assert.ok(prevented, "still consumed even though there is nowhere it could have forwarded to");
});

test("forwardToCanvas: false -- a scrollable region under the cursor still scrolls normally: no preventDefault, no dispatch", () => {
  const root = makeEl();
  const scrollable = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 }); // room to scroll down
  const canvas = makeEl();
  installCanvasZoomPassthrough(root, () => canvas, { forwardToCanvas: false });
  const { prevented } = fireWheel(root, { target: scrollable, deltaY: 100 });
  assert.equal(prevented, false, "native scrolling of an in-overlay list must be left alone");
  assert.equal(canvas._dispatched.length, 0);
});

test("forwardToCanvas: false -- once a scrollable region hits its end, the wheel is consumed immediately (no quiet-period wait, unlike node-body mode)", () => {
  const root = makeEl();
  const canvas = makeEl();
  const clock = makeClock(1000);
  installCanvasZoomPassthrough(root, () => canvas, { forwardToCanvas: false, now: clock.now });

  const scrollable = makeScrollable({ scrollTop: 50, scrollHeight: 100, clientHeight: 50 }); // already at the bottom
  const { prevented, stopped } = fireWheel(root, { target: scrollable, deltaY: 100 }); // not consumed by the list -- 0ms after "start"
  assert.ok(prevented, "menu mode consumes on the very next event, no lock to wait out");
  assert.ok(stopped);
  assert.equal(canvas._dispatched.length, 0);
});

test("forwardToCanvas: false -- no-ops entirely under Nodes 2.0, same as forwarding mode", () => {
  globalThis.window = { LiteGraph: { vueNodesMode: true } };
  try {
    const root = makeEl();
    const canvas = makeEl();
    installCanvasZoomPassthrough(root, () => canvas, { forwardToCanvas: false });
    const { prevented } = fireWheel(root);
    assert.equal(prevented, false);
    assert.equal(canvas._dispatched.length, 0);
  } finally {
    delete globalThis.window;
  }
});

test("forwardToCanvas: false -- teardown removes the listener same as the default mode", () => {
  const root = makeEl();
  const uninstall = installCanvasZoomPassthrough(root, undefined, { forwardToCanvas: false });
  uninstall();
  assert.equal((root._listeners.wheel || []).length, 0);
});

test("the default (no forwardToCanvas option, and forwardToCanvas: true explicitly) still forwards to the canvas -- node-body behaviour is unchanged", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const rootDefault = makeEl();
    const canvasDefault = makeEl();
    installCanvasZoomPassthrough(rootDefault, () => canvasDefault);
    fireWheel(rootDefault);
    assert.equal(canvasDefault._dispatched.length, 1);

    const rootExplicit = makeEl();
    const canvasExplicit = makeEl();
    installCanvasZoomPassthrough(rootExplicit, () => canvasExplicit, { forwardToCanvas: true });
    fireWheel(rootExplicit);
    assert.equal(canvasExplicit._dispatched.length, 1);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

test("a non-numeric options.getLockMs() return value falls back to options.lockMs/WHEEL_LOCK_MS rather than throwing", () => {
  globalThis.window = {};
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
  try {
    const root = makeEl();
    const canvas = makeEl();
    const clock = makeClock(0);
    installCanvasZoomPassthrough(root, () => canvas, { now: clock.now, lockMs: 50, getLockMs: () => "garbage" });

    const midScroll = makeScrollable({ scrollTop: 10, scrollHeight: 100, clientHeight: 50 });
    fireWheel(root, { target: midScroll, deltaY: 100 });

    clock.advance(10); // short of the 50ms fallback
    let result = fireWheel(root, { deltaY: 100 });
    assert.equal(result.prevented, false);

    clock.advance(50); // now past it
    result = fireWheel(root, { deltaY: 100 });
    assert.ok(result.prevented);
  } finally {
    delete globalThis.window;
    delete globalThis.WheelEvent;
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
