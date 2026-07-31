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
 * Also covers `reposition()`'s own viewport-clamp/flip decision (added
 * later, see the "reposition()'s viewport clamp" section comment below) and
 * the content-resize auto re-place `openOverlay` now performs on top of it
 * (`overlay.mjs`'s own top doc comment, "A THIRD layer, 2026-07-31") -- both
 * outgrew "just the zoom wiring" this file started as, but stayed here
 * rather than splitting out, since `openOverlay` is still the one function
 * under test either way.
 *
 * Plain `node js/shared/test_overlay.mjs`.
 */
import assert from "node:assert/strict";

import {
  openOverlay,
  openOverlayWithZoom,
  closeActiveOverlay,
  activeOverlayRef,
  computeAnchoredMaxHeight,
  POPOVER_ANCHOR_GAP_PX,
  POPOVER_VIEWPORT_MARGIN_PX,
  OVERLAY_EDGE_MARGIN_PX,
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

function makeDocStub(viewport) {
  // `viewport === null` simulates a host with no real window size at all
  // (mirrors `overlay.mjs`'s own "`null` means never adjust" convention) --
  // every OTHER call site keeps the original hardcoded 1200x800 default, so
  // none of the existing wheel-handling tests below change behaviour.
  const size = viewport === null ? { w: undefined, h: undefined } : { w: 1200, h: 800, ...viewport };
  const win = {
    _listeners: {},
    innerWidth: size.w,
    innerHeight: size.h,
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
// reposition()'s viewport clamp -- owner-reported live 2026-07-30: "the menus
// (settings/search etc...) are overflowing also to the right side (it should
// be fixed from all side and not only bottom)". Needs its own element/doc
// stub, distinct from `makeElement`/`makeDocStub` above (whose
// `getBoundingClientRect` is a fixed rect irrespective of `style` -- fine for
// the wheel tests, useless for a test that must observe what `reposition()`
// actually computed): `makeLayoutElement`'s box is DERIVED from `style.left`/
// `style.top` (summed up the real `parentNode` chain, since only `overlay`
// itself ever gets an explicit `style.left`/`top` -- `contentEl` sits inside
// it unstyled, exactly like `.wtn-cs-panel` etc. do in the real DOM) plus an
// `_size` intrinsic width/height a test can override per element, so a
// content box wider than its overlay is directly expressible.
// ---------------------------------------------------------------------------

function makeLayoutElement(tag) {
  const e = {
    tagName: tag,
    style: {},
    children: [],
    parentNode: null,
    _size: { width: 150, height: 40 }, // intrinsic content-box size; override per test
    _listeners: {},
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
    getBoundingClientRect() {
      let left = 0;
      let top = 0;
      let node = e;
      while (node) {
        left += parseFloat(node.style && node.style.left) || 0;
        top += parseFloat(node.style && node.style.top) || 0;
        node = node.parentNode;
      }
      const width = e.style.width ? parseFloat(e.style.width) : e._size.width;
      let height = e.style.height ? parseFloat(e.style.height) : e._size.height;
      // A real `max-height` genuinely constrains rendered height -- model
      // that here so a test can tell "the natural size was correctly
      // measured, THEN capped" apart from "a stale cap got read back as if
      // it were the natural size" (overlay.mjs's own reposition() must clear
      // any max-height it PREVIOUSLY applied before re-measuring on a second
      // call -- see the "re-opening/re-positioning twice" test below).
      if (e.style.maxHeight && e.style.maxHeight !== "none") {
        const mh = parseFloat(e.style.maxHeight);
        if (Number.isFinite(mh)) {
          height = Math.min(height, mh);
        }
      }
      return { left, top, right: left + width, bottom: top + height, width, height };
    },
  };
  return e;
}

function makeLayoutDocStub(viewport) {
  // `viewport === null` (rather than omitted) simulates a host with no real
  // window size at all -- mirrors `makeDocStub`'s own convention above.
  const size = viewport === null ? { w: undefined, h: undefined } : { w: 1200, h: 800, ...viewport };
  const win = {
    _listeners: {},
    innerWidth: size.w,
    innerHeight: size.h,
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
    setTimeout: (fn) => fn(),
  };
  const doc = {
    createElement: makeLayoutElement,
    body: makeLayoutElement("body"),
    defaultView: win,
  };
  return doc;
}

test("\"below\": anchor near the RIGHT edge, content wider than the anchor -- left is pulled back so the content's right edge sits inside the viewport (THE reported bug)", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 1000, top: 50, right: 1150, bottom: 80, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 400, height: 40 }; // wider than the anchor -- e.g. `.wtn-cs-panel`'s 346px vs a narrower row
  const handle = openOverlay(doc, anchor, content, "below");
  try {
    const left = parseFloat(handle.overlay.style.left);
    const contentRight = content.getBoundingClientRect().right;
    // The overlay is only sized to the anchor's own 150px width -- measuring
    // ONLY `overlay.getBoundingClientRect()` would see right=1150 (well
    // inside 1200) and conclude nothing needs clamping. The content's real
    // 400px box is what actually overflows, and is what must be pulled back.
    assert.ok(contentRight <= 1200 - OVERLAY_EDGE_MARGIN_PX, `content's right edge (${contentRight}) must sit inside the viewport`);
    assert.equal(left, 1000 - ((1000 + 400) - (1200 - OVERLAY_EDGE_MARGIN_PX)), "left pulled back by exactly the content's own overshoot");
    assert.ok(left < 1000, "left must move BACK from the anchor's own left, not stay put");
  } finally {
    handle.close();
  }
});

test("\"below\": anchor near the LEFT edge -- left never goes below the margin", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 2, top: 50, right: 122, bottom: 80, width: 120, height: 30 });
  const content = doc.createElement("div");
  const handle = openOverlay(doc, anchor, content, "below");
  try {
    assert.equal(handle.overlay.style.left, `${OVERLAY_EDGE_MARGIN_PX}px`);
  } finally {
    handle.close();
  }
});

test("\"right\": the existing flip-to-left still happens when there is room on the left", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 1000, top: 50, right: 1050, bottom: 80, width: 50, height: 30 });
  const content = doc.createElement("div"); // default 150x40 -- matches the overlay's own default box, so the new clamp is a no-op here
  const handle = openOverlay(doc, anchor, content, "right");
  try {
    // rect.right(1050) + gap(10) + boxW(150) = 1210 > vw(1200) -> flips left.
    assert.equal(handle.overlay.style.left, "840px", "rect.left(1000) - boxW(150) - gap(10)");
    assert.equal(handle.overlay.style.top, "50px", "unflipped/unclamped vertically -- plenty of room");
  } finally {
    handle.close();
  }
});

test("\"right\": flipped AND still too wide -- clamped, not left overflowing off the far side", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 1000, top: 50, right: 1050, bottom: 80, width: 50, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 1400, height: 40 }; // wider than the whole viewport
  const handle = openOverlay(doc, anchor, content, "right");
  try {
    // Flip still triggers (identical to the test above -- the flip decision
    // only ever measures the overlay's own box, unchanged by this task), but
    // the flipped position (840) would put a 1400px-wide box's left edge at
    // 840 -1400 overshoot well past the viewport on the left -- the final
    // clamp must catch that, pinning to the margin instead of a negative left.
    const left = parseFloat(handle.overlay.style.left);
    assert.equal(left, OVERLAY_EDGE_MARGIN_PX, "pinned to the margin, not left free to run negative");
    assert.ok(left >= 0, "never a negative/off-screen left");
  } finally {
    handle.close();
  }
});

test("a popover taller/wider than the whole viewport is pinned to the TOP-LEFT margin, not the bottom-right", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 500, top: 300, right: 650, bottom: 330, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 3000, height: 2000 }; // bigger than the viewport on both axes
  const handle = openOverlay(doc, anchor, content, "below");
  // A floor bigger than the whole viewport -- `reposition()`'s own "neither
  // side fits, cap to the bigger room, but never below the floor" branch
  // (this module's own top doc comment) can still hand back a height that's
  // genuinely too tall for the page, exactly like this content's own true
  // 2000px would be if `reposition()` didn't otherwise cap it to whatever
  // room the anchor actually has -- this is what still needs the emergency
  // top-left pin below, not a merely-tall-but-cappable popover.
  handle.reposition({ minHeight: 5000 });
  try {
    assert.equal(handle.overlay.style.left, `${OVERLAY_EDGE_MARGIN_PX}px`, "far-edge-then-near-edge clamping must settle on the LEFT margin");
    assert.equal(handle.overlay.style.top, `${OVERLAY_EDGE_MARGIN_PX}px`, "...and the TOP margin -- the start of the content stays visible, not its end");
  } finally {
    handle.close();
  }
});

// ---------------------------------------------------------------------------
// "below"'s side AND height are ONE decision (owner-reported bug,
// 2026-07-30): `reposition()` must decide which side to open on from the
// content's OWN natural (uncapped) size, THEN cap height only if neither
// side actually has room for it -- never the other way around (sizing to
// fit below first, which silently decided the side by construction). See
// this module's own top doc comment for the full writeup.
// ---------------------------------------------------------------------------

test("\"below\": anchor low on screen, content taller than the room below but fitting above -- placed ABOVE, NOT capped (THE reported bug)", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  // roomBelow = 800 - 730 - 6 - 12 = 52 (tiny); roomAbove = 700 - 6 - 12 = 682 (plenty).
  anchor.getBoundingClientRect = () => ({ left: 20, top: 700, right: 170, bottom: 730, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 300 }; // doesn't fit below (52px), fits above (682px) easily
  const handle = openOverlay(doc, anchor, content, "below");
  try {
    assert.equal(content.style.maxHeight, "", "fits above uncapped -- must NOT be squashed to whatever sliver was left below");
    assert.equal(handle.overlay.style.top, "394px", "700(anchor top) - 300(natural height) - 6(gap) -- flipped above, at FULL height");
  } finally {
    handle.close();
  }
});

test("\"below\": anchor low on screen, content taller than BOTH sides -- placed on the side with MORE room, capped to it", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  // Same anchor as above: roomBelow = 52, roomAbove = 682.
  anchor.getBoundingClientRect = () => ({ left: 20, top: 700, right: 170, bottom: 730, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 900 }; // doesn't fit either side naturally
  const handle = openOverlay(doc, anchor, content, "below");
  try {
    assert.equal(content.style.maxHeight, "682px", "capped to roomAbove -- the bigger of the two, not roomBelow");
    assert.equal(handle.overlay.style.top, "12px", "700(anchor top) - 682(capped height) - 6(gap)");
  } finally {
    handle.close();
  }
});

test("\"below\": anchor near the TOP, plenty of room below -- unchanged: below, uncapped", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 20, top: 50, right: 170, bottom: 80, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 300 }; // room below (702px) is abundant
  const handle = openOverlay(doc, anchor, content, "below");
  try {
    assert.equal(content.style.maxHeight, "", "plenty of room below -- no cap needed at all");
    assert.equal(handle.overlay.style.top, "86px", "80(anchor bottom) + 6(gap) -- unflipped");
  } finally {
    handle.close();
  }
});

test("\"below\": content that fits below EXACTLY -- below, no flip (the boundary case)", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  // roomBelow = 800 - 80 - 6 - 12 = 702, exactly.
  anchor.getBoundingClientRect = () => ({ left: 20, top: 50, right: 170, bottom: 80, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 702 }; // fits with nothing to spare
  const handle = openOverlay(doc, anchor, content, "below");
  try {
    assert.equal(content.style.maxHeight, "", "fits exactly -- still uncapped, not flipped");
    assert.equal(handle.overlay.style.top, "86px");
  } finally {
    handle.close();
  }
});

test("\"below\": re-opening/re-positioning the same overlay TWICE never reads a previously-applied max-height back as the natural size", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  const anchor = makeLayoutElement("button");
  // First position: roomBelow = 800 - 682 - 6 - 12 = 100, roomAbove = 318 - 6 - 12 = 300.
  anchor.getBoundingClientRect = () => ({ left: 10, top: 318, right: 100, bottom: 682, width: 90, height: 364 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 500 }; // doesn't fit either side the first time
  const handle = openOverlay(doc, anchor, content, "below");
  try {
    // Neither side fits (500 > 100, 500 > 300) -- roomAbove is bigger, so it
    // caps to 300 and flips above.
    assert.equal(content.style.maxHeight, "300px");
    assert.equal(handle.overlay.style.top, "12px", "318(anchor top) - 300(capped height) - 6(gap)");

    // The anchor moves: now roomBelow = 800 - 472 - 6 - 12 = 310, roomAbove =
    // 68 - 6 - 12 = 50. The content's own TRUE size never changed (still
    // 500) -- but if `reposition()` failed to clear the STALE 300px cap
    // before re-measuring, it would read back 300 (< the new 310px room
    // below) as if that were the content's natural size, wrongly conclude
    // "fits below, no cap needed" and clear the cap entirely -- silently
    // overflowing the (real, still-too-small-for-500) 310px room below.
    anchor.getBoundingClientRect = () => ({ left: 10, top: 68, right: 100, bottom: 472, width: 90, height: 404 });
    handle.reposition();
    assert.equal(content.style.maxHeight, "310px", "re-derived from the TRUE 500px natural size, not the stale 300px cap from the first call");
    assert.equal(handle.overlay.style.top, "478px", "472(anchor bottom) + 6(gap) -- now BELOW, since roomBelow(310) > roomAbove(50)");
  } finally {
    handle.close();
  }
});

test("no live window (vw/vh null) -- positions exactly as today, no throw", () => {
  const doc = makeLayoutDocStub(null);
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 10, top: 20, right: 250, bottom: 50, width: 240, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 5000, height: 5000 }; // absurdly oversized -- must still be a no-op with no real viewport to clamp against
  assert.doesNotThrow(() => {
    const handle = openOverlay(doc, anchor, content, "below");
    assert.equal(handle.overlay.style.left, "10px");
    assert.equal(handle.overlay.style.top, "56px"); // bottom + 6, no flip/clamp possible without a real vh
    assert.equal(handle.overlay.style.width, "240px");
    handle.close();
  });
});

// ---------------------------------------------------------------------------
// The content-resize auto re-place -- "A THIRD layer, 2026-07-31" in
// overlay.mjs's own top doc comment. Three owner reports, one cause: an
// anchored panel calls `reposition()` exactly once, right after opening,
// while it's still a short "Loading..." placeholder; the real content lands
// asynchronously, grows past whatever room was measured at that instant, and
// nothing ever re-places or re-caps it. `TestResizeObserver` below is a
// minimal, manually-driven stub (`.fire()` invokes the stored callback
// directly, no scheduling/batching modeled) -- exactly enough to prove
// `openOverlay` wires one up, reacts to a real height change, ignores a
// no-op one, and tears it down on close, without needing a real DOM's
// asynchronous delivery timing.
// ---------------------------------------------------------------------------

class TestResizeObserver {
  static instances = [];
  constructor(cb) {
    this.cb = cb;
    this.disconnected = false;
    this.observed = [];
    TestResizeObserver.instances.push(this);
  }
  observe(elm) {
    this.observed.push(elm);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** Test-only: simulate a real observation notification firing. `overlay.mjs`'s
   * own callback never reads the entries/observer arguments (it re-measures
   * `contentEl` itself), so this passes nothing. */
  fire() {
    this.cb([], this);
  }
}

/** Counts calls into `reposition()` by wrapping `anchorEl.getBoundingClientRect`
 * -- every `reposition()` call reads it exactly once, unconditionally, at its
 * very top, so this is a reliable proxy for "how many times has
 * `reposition()` actually run" without `overlay.mjs` needing to expose that
 * count itself. */
function countRepositionCalls(anchorEl) {
  const counter = { calls: 0 };
  const orig = anchorEl.getBoundingClientRect;
  anchorEl.getBoundingClientRect = (...args) => {
    counter.calls += 1;
    return orig.apply(anchorEl, args);
  };
  return counter;
}

test("content growing after open triggers exactly one automatic re-place", () => {
  TestResizeObserver.instances.length = 0;
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  doc.defaultView.ResizeObserver = TestResizeObserver;
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 20, top: 50, right: 170, bottom: 80, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 40 }; // short "Loading..." placeholder
  const handle = openOverlay(doc, anchor, content, "below");
  const counter = countRepositionCalls(anchor);
  try {
    const ro = TestResizeObserver.instances[0];
    assert.ok(ro, "openOverlay must create a ResizeObserver when the doc provides one");
    assert.equal(ro.observed[0], content, "it must observe contentEl, not the overlay wrapper");

    // The real content lands, replacing the placeholder -- still fits below
    // (room below is huge), but its height genuinely changed.
    content._size = { width: 150, height: 300 };
    ro.fire();
    assert.equal(counter.calls, 1, "grown content triggers exactly one automatic re-place");
    assert.equal(handle.overlay.style.top, "86px", "80(anchor bottom) + 6(gap) -- re-placed exactly like a fresh below-open would be");
  } finally {
    handle.close();
  }
});

test("a resize observation with unchanged height triggers no automatic re-place", () => {
  TestResizeObserver.instances.length = 0;
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  doc.defaultView.ResizeObserver = TestResizeObserver;
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 20, top: 50, right: 170, bottom: 80, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 300 };
  const handle = openOverlay(doc, anchor, content, "below");
  const counter = countRepositionCalls(anchor);
  try {
    const ro = TestResizeObserver.instances[0];
    ro.fire(); // nothing changed
    assert.equal(counter.calls, 0, "an unchanged height must never trigger a re-place -- a poll that re-renders the same content every 800ms must not jitter the popover");
  } finally {
    handle.close();
  }
});

test("a {minHeight} floor set by an earlier explicit reposition() call is remembered and reused by the automatic re-place", () => {
  TestResizeObserver.instances.length = 0;
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  doc.defaultView.ResizeObserver = TestResizeObserver;
  const anchor = makeLayoutElement("button");
  // roomBelow = 800 - 730 - 6 - 12 = 52 (tiny); roomAbove = 700 - 6 - 12 = 682.
  anchor.getBoundingClientRect = () => ({ left: 20, top: 700, right: 170, bottom: 730, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 40 }; // fits fine at first -- no cap yet, floor merely remembered
  const handle = openOverlay(doc, anchor, content, "below");
  try {
    handle.reposition({ minHeight: 5000 });
    assert.equal(content.style.maxHeight, "", "still fits -- no cap needed yet");

    const ro = TestResizeObserver.instances[0];
    content._size = { width: 150, height: 900 }; // now doesn't fit either side -- needs a cap
    ro.fire();
    assert.equal(content.style.maxHeight, "5000px", "the automatic re-place reused the LAST explicit call's floor, not a lost 0");
  } finally {
    handle.close();
  }
});

test("grow -> cap -> re-observe converges -- the cap's own follow-up notification never causes another re-place (no oscillation)", () => {
  TestResizeObserver.instances.length = 0;
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  doc.defaultView.ResizeObserver = TestResizeObserver;
  const anchor = makeLayoutElement("button");
  // Same anchor as the "neither side fits" test above: roomBelow = 52, roomAbove = 682.
  anchor.getBoundingClientRect = () => ({ left: 20, top: 700, right: 170, bottom: 730, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 40 };
  const handle = openOverlay(doc, anchor, content, "below");
  const counter = countRepositionCalls(anchor);
  try {
    const ro = TestResizeObserver.instances[0];

    // Grows past BOTH sides' room -- reposition() applies a cap, which
    // itself changes contentEl's OWN rendered height (a resize a real
    // ResizeObserver would notice too) -- firing again right after
    // simulates that follow-up notification.
    content._size = { width: 150, height: 900 };
    ro.fire();
    assert.equal(counter.calls, 1, "one re-place for the actual growth");
    assert.equal(content.style.maxHeight, "682px", "capped to roomAbove, same as the existing non-observer cap test above");

    ro.fire(); // the cap's own follow-up notification
    assert.equal(counter.calls, 1, "the post-cap height matches what reposition() just placed at -- must not cause a second call");
    ro.fire(); // fired again for good measure
    assert.equal(counter.calls, 1, "bounded: repeated observations of the same settled height never accumulate more calls");
  } finally {
    handle.close();
  }
});

test("close() disconnects the resize observer", () => {
  TestResizeObserver.instances.length = 0;
  const doc = makeLayoutDocStub({ w: 1200, h: 800 });
  doc.defaultView.ResizeObserver = TestResizeObserver;
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 20, top: 50, right: 170, bottom: 80, width: 150, height: 30 });
  const content = doc.createElement("div");
  const handle = openOverlay(doc, anchor, content, "below");
  const ro = TestResizeObserver.instances[0];
  assert.equal(ro.disconnected, false);
  handle.close();
  assert.equal(ro.disconnected, true, "close() must disconnect the resize observer -- a leaked observer holding a detached node is exactly the kind of thing that survives green tests");
});

test("no ResizeObserver available anywhere (no doc.defaultView one, and Node has no global one) -- silent no-op, content growth after open never re-places, no throw", () => {
  const doc = makeLayoutDocStub({ w: 1200, h: 800 }); // .ResizeObserver never set
  const anchor = makeLayoutElement("button");
  anchor.getBoundingClientRect = () => ({ left: 20, top: 50, right: 170, bottom: 80, width: 150, height: 30 });
  const content = doc.createElement("div");
  content._size = { width: 150, height: 40 };
  assert.doesNotThrow(() => {
    const handle = openOverlay(doc, anchor, content, "below");
    assert.equal(handle.overlay.style.top, "86px");
    content._size = { width: 150, height: 900 }; // grows, but nothing is observing it
    assert.equal(handle.overlay.style.top, "86px", "no observer exists to notice the growth, so nothing re-places it");
    handle.close();
  });
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
