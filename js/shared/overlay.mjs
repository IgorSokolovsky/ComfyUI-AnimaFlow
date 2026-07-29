/**
 * overlay.mjs — the single "popover/menu anchored to a DOM element, appended
 * to `document.body`" mechanism shared by every DOM-widget node in this
 * pack. Extracted from `js/controls/interaction.mjs` + `js/controls/
 * render.mjs` while building `js/anima/` (`docs/generator-design.md` §12:
 * "Reuse the Control Panel's overlay helper ... do not reimplement the
 * anchoring") — Controls keeps using it via a thin wrapper in its own
 * `render.mjs`/`interaction.mjs` so there is exactly ONE implementation, not
 * a fork.
 *
 * ## A correction made during extraction (read before assuming this already
 * had viewport-flip)
 *
 * `docs/generator-design.md` §12 and `playground/generator.html`'s CSS
 * comment both assert the Control Panel's `openOverlayWithZoom` "already
 * owns" a viewport-flip decision (open above/left instead of below/right
 * when there's no room). It did NOT — `js/controls/interaction.mjs`'s
 * `reposition()` only ever placed a popover at a fixed offset from the
 * anchor with no boundary check at all, and neither module contained a
 * flip. That is a genuine discrepancy between the design doc and the code
 * it describes, flagged in this build's report rather than silently
 * "corrected" without a trace. The flip below is NEW, added here because
 * `js/anima/`'s row popovers (unlike the Control Panel's, which mostly sit
 * near the canvas's left edge in practice) are exactly the case that needs
 * it, and this is the one place both callers can share it from.
 *
 * The flip only ever activates when a REAL viewport size is available
 * (`doc.defaultView.innerWidth`/`innerHeight`, both real numbers) — under
 * every existing headless test (`js/controls/test_resize.mjs`'s
 * `makeWindowStub`, which never sets either) it stays a no-op, so extracting
 * this changes zero existing Controls test outcomes.
 *
 * ## Why overlays live on `document.body`, not inside the anchor's own tree
 *
 * A DOM-widget row/root's own container may clip overflow inside the node's
 * rendered area, and the node itself is `position: static` on the canvas, so
 * `left`/`top` set on a child would resolve against an arbitrary ancestor.
 * Appending to `document.body` and positioning from the anchor's REAL
 * `getBoundingClientRect()` (already correct screen coordinates in both
 * renderers) sidesteps both problems — see `js/controls/render.mjs`'s
 * original doc comment for the fuller version of this reasoning.
 */

import { installCanvasZoomPassthrough } from "./canvas_zoom.mjs";

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

function winOf(doc) {
  return (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
}

/** Real numeric viewport size, or `null` if none is available (every
 * existing headless test, and any host with no live `window`) — `null`
 * means "never flip", not "assume some fallback size". */
function viewportSize(doc) {
  const win = winOf(doc);
  const w = win && typeof win.innerWidth === "number" ? win.innerWidth : null;
  const h = win && typeof win.innerHeight === "number" ? win.innerHeight : null;
  return { w, h };
}

/**
 * Opens a themed overlay anchored to `anchorEl`, appended to `doc.body`.
 * `placement` is `"below"` (drops below the anchor, at the anchor's own
 * width — an option list) or `"right"` (opens beside the anchor — a ⚙
 * popover or context menu). `overlayClassName` lets each caller keep its own
 * CSS hook (Controls' `"wtn-ctl-overlay wtn"`, Anima's own) while sharing
 * this one implementation — defaults to the generic `"wtn-overlay wtn"`.
 *
 * Returns `{ overlay, close, reposition }`; `close()` removes it and detaches
 * its own outside-pointerdown/Escape listeners. Only ever call this through
 * `openOverlayWithZoom` below in real node code (it adds wheel-zoom
 * passthrough); tests exercise this bare form directly.
 */
export function openOverlay(doc, anchorEl, contentEl, placement, onClose, overlayClassName) {
  const win = winOf(doc);
  const overlay = el(doc, "div", overlayClassName || "wtn-overlay wtn");
  // Belt-and-suspenders: `.wtn-overlay`'s `position: fixed` normally comes
  // from the injected stylesheet, but if that injection is ever missing/
  // late/failed, a `position: static` overlay lays out as a block at the
  // very bottom of the page -- invisible, not merely unstyled, and every
  // click on it silently does nothing a user can see. Setting it inline
  // here means a stylesheet failure can never hide a menu again (the
  // `comfyui-node-renders-but-dead` skill's root cause A).
  overlay.style.position = "fixed";
  overlay.style.left = "0px";
  overlay.style.top = "0px";
  overlay.style.zIndex = "10020";
  overlay.appendChild(contentEl);
  const body = doc.body || doc;
  body.appendChild(overlay);

  const reposition = () => {
    const rect = typeof anchorEl.getBoundingClientRect === "function"
      ? anchorEl.getBoundingClientRect()
      : { left: 0, top: 0, right: 0, bottom: 0, width: 240 };
    const { w: vw, h: vh } = viewportSize(doc);

    if (placement === "below") {
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.bottom + 6}px`;
      overlay.style.width = `${Math.max(120, rect.width)}px`;
      if (vh != null) {
        // Measure AFTER width is set, so a wrapped-text height is real —
        // the overlay is already attached to `body`, so this reflects
        // actual layout in a live browser.
        const box = typeof overlay.getBoundingClientRect === "function" ? overlay.getBoundingClientRect() : null;
        const boxH = box ? box.height : 0;
        if (boxH && rect.bottom + 6 + boxH > vh) {
          overlay.style.top = `${Math.max(4, rect.top - boxH - 6)}px`; // flip: open ABOVE instead
        }
      }
    } else {
      // "right"
      const gap = 10;
      overlay.style.left = `${rect.right + gap}px`;
      overlay.style.top = `${rect.top}px`;
      if (vw != null) {
        const box = typeof overlay.getBoundingClientRect === "function" ? overlay.getBoundingClientRect() : null;
        const boxW = box ? box.width : 0;
        const boxH = box ? box.height : 0;
        if (boxW && rect.right + gap + boxW > vw) {
          overlay.style.left = `${Math.max(4, rect.left - boxW - gap)}px`; // flip: open to the LEFT instead
        }
        if (vh != null && boxH && rect.top + boxH > vh) {
          overlay.style.top = `${Math.max(4, vh - boxH - 4)}px`; // clamp so a tall popover never falls off the bottom
        }
      }
    }
  };
  reposition();

  function onDocPointerDown(e) {
    if (overlay.contains(e.target) || (anchorEl && anchorEl.contains && anchorEl.contains(e.target))) {
      return;
    }
    close();
  }
  function onKeydown(e) {
    if (e.key === "Escape") {
      close();
    }
  }
  // `outsideActive` -- whether THIS overlay's own outside-click/Escape
  // listeners are currently attached. Split out of `close()`'s own teardown
  // (below) into `suspendOutsideClose`/`resumeOutsideClose` so a NESTED
  // overlay (`openStepperOptionList` opening on top of an already-open ⚙
  // menu, task item 3) can silence its ancestor's outside-click handling
  // for as long as it's the topmost thing open, without closing that
  // ancestor -- see this module's own "nested overlays" doc comment, below
  // `activeOverlayRef`, for the stack that actually calls these two.
  // Un-suspended (attached) by default: a caller that never nests (every
  // existing `js/controls/` opener, and every `js/anima/` opener that isn't
  // itself opened from inside another one) never calls either, so this
  // stays exactly the always-on behaviour it always was.
  let outsideActive = false;
  function resumeOutsideClose() {
    if (outsideActive || closed || !win) {
      return;
    }
    outsideActive = true;
    win.addEventListener("pointerdown", onDocPointerDown, true);
    win.addEventListener("keydown", onKeydown, true);
  }
  function suspendOutsideClose() {
    if (!outsideActive) {
      return;
    }
    outsideActive = false;
    if (win) {
      win.removeEventListener("pointerdown", onDocPointerDown, true);
      win.removeEventListener("keydown", onKeydown, true);
    }
  }
  let closed = false;
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    suspendOutsideClose();
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }
  if (win) {
    // Deferred so the SAME click that opened this overlay doesn't also
    // immediately close it via the outside-click listener.
    win.setTimeout(() => {
      resumeOutsideClose();
    }, 0);
  }

  return { overlay, close, reposition, suspendOutsideClose, resumeOutsideClose };
}

// ---------------------------------------------------------------------------
// A STACK of open overlays, not a single slot (task item 3) -- shared by
// every caller of this file (Controls AND Anima), correct since only one
// STACK of overlays should ever be open across the WHOLE page, not one per
// node type. Was a single `{current}` slot until `js/anima/`'s hybrid
// essentials/⚙ dispatch started nesting a stepper's option-list overlay
// INSIDE an already-open ⚙ menu (`openStepperOptionList` opened from
// `openAdvancedMenu`'s own content) -- the single slot made that second
// `open` call think the ⚙ menu was "a different overlay to replace," so
// opening the option list silently closed its own parent (the actual bug
// this stack fixes).
//
// **Contract:** opening a child (its `anchorEl` sits INSIDE an already-open
// overlay's own element) must not close that ancestor; closing an ancestor
// (`closeActiveOverlay`, or `closeOverlayIfOwnedBy` finding its key anywhere
// in the stack, not just at the top) must close every overlay nested inside
// it; outside-click/Escape must close ONLY the innermost (`openOverlay`'s
// own `suspendOutsideClose`/`resumeOutsideClose`, wired below, silence every
// overlay's listener except the current top's, so a single dismissal event
// can only ever match one level).
//
// `activeOverlayRef.current` is kept as a get/set PROPERTY (not a plain
// field) specifically so the many existing call sites in both
// `js/controls/interaction.mjs` and `js/anima/interaction.mjs` — which read/
// write it directly (`activeOverlayRef.current = handle` right after
// opening; `if (activeOverlayRef.current === handle) { activeOverlayRef.
// current = null; }` inside their own `onClose`) — keep working completely
// unchanged: the getter reads the STACK's top, and the setter pushes (a real
// handle) or pops (`null`, only ever assigned by a caller that just
// confirmed IT owns the current top) onto/off the SAME array this module's
// own stack-aware helpers use. A track that only ever opens one overlay at a
// time (`js/controls/` — confirmed by grep, its own overlay openers never
// nest one inside another) never sees a stack deeper than one entry, so this
// is a transparent, behaviour-preserving generalization for that track, not
// a rewrite of it.
// ---------------------------------------------------------------------------

const overlayStack = [];

function topOf(stack) {
  return stack.length ? stack[stack.length - 1] : null;
}

/** Suspends the CURRENT top's own outside-click/Escape listening (if any) --
 * called right before a new overlay is pushed ON TOP of it, so the outgoing
 * top's dismissal doesn't compete with the incoming one's for the same
 * outside click. A no-op on an empty stack. */
function suspendCurrentTop() {
  const top = topOf(overlayStack);
  if (top && typeof top.suspendOutsideClose === "function") {
    top.suspendOutsideClose();
  }
}

/** Resumes the (new) top's own outside-click/Escape listening -- called
 * right after a pop, so the overlay left exposed underneath the one that
 * just closed can be dismissed by outside-click/Escape again. A no-op on an
 * empty stack, or if the top never suspended (every existing single-level
 * caller: its own listener was never touched, so this is harmless). */
function resumeCurrentTop() {
  const top = topOf(overlayStack);
  if (top && typeof top.resumeOutsideClose === "function") {
    top.resumeOutsideClose();
  }
}

export const activeOverlayRef = {
  get current() {
    return topOf(overlayStack);
  },
  set current(handle) {
    if (handle == null) {
      // A caller only ever assigns `null` after confirming
      // `activeOverlayRef.current === <the handle closing right now>` --
      // i.e. the handle at the TOP of the stack -- so this is always "pop
      // the top," never "remove some arbitrary earlier entry."
      overlayStack.pop();
      resumeCurrentTop();
    } else {
      suspendCurrentTop();
      overlayStack.push(handle);
    }
  },
};

/** Closes every overlay currently in the stack, innermost (top) first, so a
 * parent closing also closes whatever was nested inside it -- used for a
 * full-body repaint (nothing left to anchor ANY of them to any more) and
 * for "a totally unrelated new overlay is opening, replace the whole
 * stack." Safe to call on an empty stack. */
export function closeActiveOverlay() {
  while (overlayStack.length) {
    const top = overlayStack[overlayStack.length - 1];
    top.close(); // triggers its own onClose, which pops it via the setter above
    // Safety net: if `top`'s own `onClose` didn't already pop it (a caller
    // that doesn't follow the `activeOverlayRef.current = null` guard
    // convention), force the pop so this loop can never spin forever on a
    // handle that refuses to leave the stack.
    if (overlayStack.length && overlayStack[overlayStack.length - 1] === top) {
      overlayStack.pop();
    }
  }
}

/**
 * Close the overlay identified by `key` (each opener's own stable id, e.g.
 * `${kind}:${row.id}` or `gen:${stageKey}`) — searching the WHOLE stack, not
 * just the top, so a second click on an opener whose menu has grown a
 * nested child (its own key is no longer the top entry) still finds and
 * closes it — plus every overlay nested inside it (closing a parent closes
 * its children, this module's own top doc comment). Returns whether
 * anything actually closed. This — not the outside-click/Escape listener
 * inside `openOverlay` above — is what makes a second click on the SAME
 * control close its own popover instead of closing-then-reopening it: see
 * this module's top doc comment / the `comfyui-node-renders-but-dead`
 * skill's root cause G.
 */
export function closeOverlayIfOwnedBy(key) {
  const idx = overlayStack.findIndex((handle) => handle.ownerKey === key);
  if (idx === -1) {
    return false;
  }
  while (overlayStack.length > idx) {
    const top = overlayStack[overlayStack.length - 1];
    top.close();
    if (overlayStack.length && overlayStack[overlayStack.length - 1] === top) {
      overlayStack.pop(); // same safety net as closeActiveOverlay's own loop
    }
  }
  return true;
}

/**
 * Closes every overlay in the stack that is NOT an ancestor of `anchorEl`
 * — walking from the innermost (top) outward, popping each one, until it
 * finds an overlay whose own `.overlay` element already CONTAINS `anchorEl`
 * (meaning the thing about to open is anchored to something living INSIDE
 * that overlay's own rendered content — a genuinely NESTED child of it, not
 * a replacement for it) or the stack runs out.
 *
 * This is the actual fix for task item 3's bug: `openStepperOptionList`
 * used to call `closeActiveOverlay()` unconditionally before opening, which
 * closed whatever was active even when that was its OWN parent ⚙ menu (the
 * stepper's `comboEl` lives inside that menu's own overlay element). Calling
 * this instead, with the stepper's `comboEl` as `anchorEl`, stops as soon as
 * it reaches that parent — leaving it (and anything further down the stack)
 * open — while still correctly closing a DIFFERENT stepper's own option
 * list if one happened to be open as a sibling under the same parent (its
 * overlay does NOT contain the new `comboEl`, so it gets popped before the
 * walk reaches the shared parent that does).
 *
 * A genuinely unrelated new anchor (nothing on the stack contains it at
 * all — e.g. a different section's own ⚙, opened while some other
 * section's menu was open) still walks all the way down and closes
 * everything, matching the pre-stack single-slot behaviour for that case.
 */
export function closeOverlaysNotAncestorOf(anchorEl) {
  while (overlayStack.length) {
    const top = overlayStack[overlayStack.length - 1];
    if (anchorEl && top.overlay && typeof top.overlay.contains === "function" && top.overlay.contains(anchorEl)) {
      break; // `anchorEl` lives inside this overlay -- it's an ancestor, keep it (and everything below it) open
    }
    top.close();
    if (overlayStack.length && overlayStack[overlayStack.length - 1] === top) {
      overlayStack.pop(); // same safety net as closeActiveOverlay's own loop
    }
  }
}

/**
 * `openOverlay` above, plus wheel-zoom passthrough on the overlay element
 * itself (`js/shared/canvas_zoom.mjs`) — so wheeling over any popover/menu
 * this pack ever opens zooms the canvas same as wheeling over the node body,
 * except over a genuinely scrollable child that still has room.
 * `getCanvasEl` is the real `() => app.canvas && app.canvas.canvas` getter
 * from the caller's `index.js` (or `undefined` under test, where
 * `installCanvasZoomPassthrough` harmlessly never finds a canvas to dispatch
 * to). Sets `handle.ownerKey`/tracks `_activeOverlay` itself, so callers
 * don't have to repeat that bookkeeping at every call site — set
 * `handle.ownerKey = key` is still the CALLER's job (this function doesn't
 * know what key a given opener wants to use), see `js/anima/interaction.mjs`
 * for the pattern.
 */
export function openOverlayWithZoom(getCanvasEl, doc, anchorEl, contentEl, placement, onClose, overlayClassName) {
  const handle = openOverlay(doc, anchorEl, contentEl, placement, onClose, overlayClassName);
  const uninstallZoom = installCanvasZoomPassthrough(handle.overlay, getCanvasEl);
  const origClose = handle.close;
  handle.close = () => {
    uninstallZoom();
    origClose();
  };
  return handle;
}
