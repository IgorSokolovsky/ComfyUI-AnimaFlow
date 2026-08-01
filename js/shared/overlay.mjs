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
 * ## A THIRD layer, 2026-07-31: re-placing after the content GROWS, not just
 * once at open (owner-reported, three separate panels)
 *
 * The two corrections above both fix how a single `reposition()` call
 * decides where to put the overlay. Neither touches WHEN `reposition()` gets
 * called — and every anchored panel in this pack calls it exactly once,
 * right after opening, while its content is still whatever it was at that
 * instant (typically a short "Loading…" placeholder). `computeAnchoredMaxHeight`
 * /the `"below"` branch's own cap only ever engages when the content doesn't
 * fit AT THE TIME `reposition()` runs — a short placeholder fits, so no cap
 * is applied, and the inner `overflow-y: auto` region it's paired with never
 * gets a bounded box to scroll inside of. When the real content lands
 * asynchronously and grows past it, the panel just grows past the bottom of
 * the viewport instead of scrolling — confirmed on `model_picker.mjs` (one
 * `reposition()` call, at open, ever), `civitai_search.mjs` (repositions at
 * open plus on window-resize and anchor-move, but nothing for a CONTENT size
 * change), and `model_info.mjs` (which hit this first and grew its own
 * local `repositionAfterChange` workaround rather than wait for a shared
 * fix here).
 *
 * The fix: `openOverlay` itself now watches `contentEl` with a
 * `ResizeObserver` (resolved from `doc.defaultView.ResizeObserver` first,
 * falling back to `globalThis.ResizeObserver`; `undefined` on both — every
 * headless test in this pack, and any host with no live one — is a clean,
 * total no-op, exactly this module's existing "no mechanism available"
 * convention) and calls `reposition()` again whenever the observed height
 * genuinely changes, so no caller has to wire this up by hand (unlike
 * `model_info.mjs`'s own `repositionAfterChange`, which still exists as a
 * separate, redundant mechanism on that one panel — harmless since a second
 * re-place landing on the same position is a no-op in effect, but worth
 * collapsing into this one once it's proven out; not done here, on purpose,
 * so as not to disturb a fix the owner only just confirmed works).
 *
 * Two things make this converge instead of oscillate:
 *
 * 1. It remembers the LAST `sizeOpts` (`{ minHeight }`) any caller passed to
 *    `reposition()`, and reuses that same floor for the automatic re-place —
 *    re-placing with a *lost* floor would silently undo whatever minimum the
 *    caller originally asked for.
 * 2. It compares the observed height against the height `reposition()`
 *    itself last actually placed at (recorded right after that call
 *    finishes, i.e. AFTER any height cap it applied), not against whatever
 *    height was current when the observer fired — `reposition()`'s own
 *    "below" branch can shrink `contentEl` via `max-height`, which is itself
 *    a resize the observer will see; comparing against the POST-cap height
 *    means that follow-up observation reads as "unchanged" and stops the
 *    loop. A `repositioning` flag additionally swallows any observation
 *    fired synchronously from inside `reposition()`'s own body, in case a
 *    given `ResizeObserver` implementation (or a test double) ever delivers
 *    one that way rather than batched to a later turn.
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
import { Z_PANEL } from "./z_layers.mjs";

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

/** `elm.getBoundingClientRect()`, or `null` if `elm` doesn't have a real one
 * (every existing headless test stub that never sets `_rect`, or a host with
 * no live DOM at all) — mirrors this module's own "no measurement available"
 * convention rather than throwing or synthesizing a fake box. */
function measureBox(elm) {
  if (!elm || typeof elm.getBoundingClientRect !== "function") {
    return null;
  }
  const box = elm.getBoundingClientRect();
  return box || null;
}

/** Margin kept between a popover's own edge and the viewport's -- the single
 * named constant for what used to be a `4` scattered across three separate
 * spots in `reposition()` below (the vertical flip's floor, the horizontal
 * flip's floor, and the old "right" placement's own bottom clamp). Distinct
 * from `POPOVER_VIEWPORT_MARGIN_PX` (12px): that one reserves room for a
 * "below"-anchored popover's own scrollable-content HEIGHT
 * (`computeAnchoredMaxHeight`); this one is the POSITION clamp's own edge
 * margin, a separate mechanism entirely. */
export const OVERLAY_EDGE_MARGIN_PX = 4;

/**
 * Final pass, run for EVERY placement (below/right, flipped or not): pins
 * `overlay` inside the viewport on all four edges, `OVERLAY_EDGE_MARGIN_PX`
 * of breathing room from each. A no-op if there's no real viewport size at
 * all (`vw == null && vh == null` -- the existing "never adjust" convention),
 * or if `overlay` itself can't be measured.
 *
 * Measures `overlay` AND `contentEl` — not just the overlay — because the
 * overlay box only ever gets the ANCHOR's width for `"below"` (or is left
 * entirely unsized for `"right"`), while the panels mounted inside it
 * routinely set their own wider fixed width in CSS (`.wtn-cs-panel`,
 * `.wtn-mp-panel`, `.wtn-lora-set`, ...). A clamp that measured only the
 * overlay's own rect would report success while the content still spilled
 * past it — the owner-reported 2026-07-30 bug this whole pass exists to fix.
 *
 * Order matters: the far edge (right, then bottom) is clamped FIRST, the
 * near edge (left, then top) SECOND. That way a popover genuinely bigger
 * than the viewport still lands with its top-left corner pinned to the
 * margin — the START of its content stays visible — rather than the
 * near-edge clamp winning and pinning the END instead.
 */
function clampOverlayToViewport(overlay, contentEl, vw, vh) {
  if (vw == null && vh == null) {
    return;
  }
  const obox = measureBox(overlay);
  if (!obox) {
    return;
  }
  const cbox = measureBox(contentEl);
  const rightEdge = cbox ? Math.max(obox.right, cbox.right) : obox.right;
  const bottomEdge = cbox ? Math.max(obox.bottom, cbox.bottom) : obox.bottom;
  let left = parseFloat(overlay.style.left) || 0;
  let top = parseFloat(overlay.style.top) || 0;

  if (vw != null) {
    const overshoot = rightEdge - (vw - OVERLAY_EDGE_MARGIN_PX); // far edge first
    if (overshoot > 0) {
      left -= overshoot;
    }
    left = Math.max(OVERLAY_EDGE_MARGIN_PX, left); // near edge second
    overlay.style.left = `${left}px`;
  }
  if (vh != null) {
    const overshootH = bottomEdge - (vh - OVERLAY_EDGE_MARGIN_PX); // far edge first
    if (overshootH > 0) {
      top -= overshootH;
    }
    top = Math.max(OVERLAY_EDGE_MARGIN_PX, top); // near edge second
    overlay.style.top = `${top}px`;
  }
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
 *
 * ## `"below"`'s side AND height are ONE decision, not two (owner-reported
 * bug, 2026-07-30)
 *
 * Before this fix, a "below" popover's vertical FLIP (this function, right
 * below) and its height CAP (`computeAnchoredMaxHeight`, at the bottom of
 * this file) were computed independently by different code -- the flip here
 * measured whatever height the popover currently rendered at, while
 * `civitai_search.mjs`/`model_picker.mjs` pre-shrank that same popover to
 * whatever room existed BELOW the anchor before ever calling this function
 * again. A popover shrunk to exactly fit below will, tautologically, always
 * "fit below" -- so the flip never fired, even though the ⚙ settings dialog's
 * OWN flip (which has no such pre-shrink -- a static CSS `max-height` is the
 * only cap it ever had) proved the flip mechanism itself was fine. Sizing to
 * one side had silently decided the side.
 *
 * The fix: `reposition()`'s own `"below"` branch now owns BOTH. On every
 * call, it (1) clears any `max-height` a PREVIOUS call of this same
 * `reposition()` applied to `contentEl` -- never re-reads its own earlier cap
 * as if it were the content's natural size (the subtle part on a SECOND
 * open/reposition), (2) measures `contentEl`'s natural height with that
 * cleared (any static CSS `max-height` a caller's own stylesheet applies,
 * e.g. `.wtn-lora-set`'s 78vh, is untouched and still bounds this -- clearing
 * only removes what THIS mechanism itself applied), (3) decides: fits below
 * as-is -> below, uncapped; else fits above as-is -> above, uncapped (this is
 * the ⚙ dialog's own case, and the reported bug -- a popover that genuinely
 * doesn't fit below must be judged against its real desired size, not a
 * pre-shrunk one); else -> whichever side has more room, capped to that room
 * (never below `minHeight`, an optional per-call floor -- see `reposition`'s
 * own param doc below), (4) applies the resulting `top` and `max-height`
 * together, so a caller genuinely too tall for the whole viewport still gets
 * a floor-respecting cap on whichever side is less bad, rather than
 * `computeAnchoredMaxHeight`'s old "below-only" answer.
 *
 * `computeAnchoredMaxHeight` (bottom of this file) is kept, unchanged, for
 * any caller that only ever wants a bare "how much room below" number and
 * doesn't open through `reposition()`'s own flip at all -- but
 * `civitai_search.mjs`/`model_picker.mjs` no longer call it themselves for
 * their popover's own max-height; they hand their floor to `reposition()`
 * via its `minHeight` option instead, so this decision lives in exactly one
 * place rather than being computed once here and once per caller.
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
  // The anchored overlay/panel rung of the shared z-index scale
  // (`../shared/z_layers.mjs` -- read that module's own top doc comment
  // before ever hand-picking a number here again: this used to be a bare
  // `"10020"`, and a DIFFERENT bare number in `delete_confirm.mjs` is the
  // owner-reported bug this scale exists to fix).
  overlay.style.zIndex = String(Z_PANEL);
  overlay.appendChild(contentEl);
  const body = doc.body || doc;
  body.appendChild(overlay);

  /**
   * `sizeOpts` (optional) -- `{ minHeight }`: a per-call floor beneath which
   * the `"below"` branch's own squeeze-cap (case 3 of this module's own top
   * doc comment: "neither side fits naturally") must never shrink
   * `contentEl`, mirroring `computeAnchoredMaxHeight`'s `Math.max(minTotal,
   * available)`. Ignored for `"right"` (no height decision happens there)
   * and safe to omit entirely -- every existing call site that never passed
   * anything (the ⚙ dialog, row/option menus, the ⓘ panel) keeps floor `0`,
   * unchanged from before this option existed.
   */
  // Most recent non-undefined `sizeOpts` any caller has passed to
  // `reposition()` -- reused by the automatic content-resize re-place
  // (below `reposition()`'s own definition) so it never re-places with a
  // LOST floor. `undefined` until the first caller that actually passes
  // one; the automatic re-place before that point just passes `undefined`
  // straight through, identical to every existing no-args call.
  let lastSizeOpts;
  // `contentEl`'s own height at the moment `reposition()` last FINISHED
  // placing the overlay (i.e. after any height cap it applied) -- what the
  // resize-observer re-place, below, diffs the newly observed height
  // against to decide "did anything actually change." `null` until the
  // first `reposition()` call completes.
  let placedHeight = null;
  // True only while THIS `reposition()` call's own body is running --
  // guards the resize observer below against reacting to a resize IT ITSELF
  // caused (`reposition()`'s own `contentEl.style.maxHeight` mutation is a
  // resize too), in case a given `ResizeObserver` implementation (or a test
  // double) ever delivers that notification synchronously rather than
  // batched to a later turn.
  let repositioning = false;
  const reposition = (sizeOpts) => {
    if (sizeOpts !== undefined) {
      lastSizeOpts = sizeOpts;
    }
    repositioning = true;
    const rect = typeof anchorEl.getBoundingClientRect === "function"
      ? anchorEl.getBoundingClientRect()
      : { left: 0, top: 0, right: 0, bottom: 0, width: 240 };
    const { w: vw, h: vh } = viewportSize(doc);

    if (placement === "below") {
      overlay.style.left = `${rect.left}px`;
      overlay.style.width = `${Math.max(120, rect.width)}px`;
      if (vh != null) {
        const gap = POPOVER_ANCHOR_GAP_PX;
        const margin = POPOVER_VIEWPORT_MARGIN_PX;
        // Clear any max-height a PREVIOUS reposition() call applied to
        // `contentEl` before measuring -- otherwise that stale cap gets read
        // back as this call's "natural" size (see this module's own top doc
        // comment: "the subtle part on a SECOND open/reposition"). Any
        // static CSS max-height a caller's own stylesheet applies (the ⚙
        // dialog's 78vh, the search panel's 76vh, the picker's 62vh) is
        // untouched by this -- it's an inline-style clear, not a class
        // override, so those still bound the "natural" measurement below,
        // exactly like today.
        if (contentEl && contentEl.style) {
          contentEl.style.maxHeight = "";
        }
        const naturalBox = measureBox(contentEl) || measureBox(overlay);
        const naturalHeight = naturalBox ? naturalBox.height : 0;

        const roomBelow = vh - rect.bottom - gap - margin;
        const roomAbove = rect.top - gap - margin;
        const minTotal = sizeOpts && Number.isFinite(sizeOpts.minHeight) && sizeOpts.minHeight >= 0
          ? sizeOpts.minHeight
          : 0;

        let side;
        let capHeight = null;
        if (naturalHeight <= 0) {
          // No real measurement to decide from (e.g. `contentEl` hasn't
          // rendered any box yet) -- default to below, uncapped, matching
          // this function's own pre-fix behaviour for a falsy `boxH`.
          side = "below";
        } else if (naturalHeight <= roomBelow) {
          side = "below"; // fits as-is -- no flip, no cap (case 4 of the top doc comment)
        } else if (naturalHeight <= roomAbove) {
          side = "above"; // doesn't fit below but DOES fit above, uncapped -- THE reported bug
        } else if (roomAbove > roomBelow) {
          side = "above"; // neither side fits naturally -- pick the side with more room
          capHeight = Math.max(minTotal, roomAbove);
        } else {
          side = "below";
          capHeight = Math.max(minTotal, roomBelow);
        }

        if (capHeight != null && contentEl && contentEl.style) {
          contentEl.style.maxHeight = `${Math.round(capHeight)}px`;
        }

        if (side === "above") {
          // Re-measure: `contentEl` may just have been capped above, so its
          // rendered height can differ from `naturalHeight`.
          const finalBox = measureBox(contentEl) || measureBox(overlay);
          const finalH = finalBox ? finalBox.height : naturalHeight;
          overlay.style.top = `${rect.top - finalH - gap}px`;
        } else {
          overlay.style.top = `${rect.bottom + gap}px`;
        }
      } else {
        overlay.style.top = `${rect.bottom + 6}px`; // no real viewport -- unchanged fallback
      }
    } else {
      // "right"
      const gap = 10;
      overlay.style.left = `${rect.right + gap}px`;
      overlay.style.top = `${rect.top}px`;
      if (vw != null) {
        const box = measureBox(overlay);
        const boxW = box ? box.width : 0;
        if (boxW && rect.right + gap + boxW > vw) {
          overlay.style.left = `${rect.left - boxW - gap}px`; // flip: open to the LEFT instead (final clamp below catches any residual overflow)
        }
      }
    }

    // One final pass, for EVERY placement (below/right, flipped or not): pin
    // the popover inside the viewport on all four edges. See
    // `clampOverlayToViewport`'s own doc comment for why this measures BOTH
    // `overlay` and `contentEl`, and why far-edge-then-near-edge ordering
    // matters — this is what fixes the owner-reported 2026-07-30 overflow
    // (menus spilling off the right side; only the bottom was ever handled).
    clampOverlayToViewport(overlay, contentEl, vw, vh);

    // Record the height THIS call actually placed at (after any cap it just
    // applied) -- this, not whatever height happens to be current when the
    // resize observer next fires, is what the automatic re-place below
    // diffs against, so a follow-up observation of the SAME cap this call
    // just applied reads as "unchanged" and the loop stops. See this
    // module's own top doc comment, "A THIRD layer, 2026-07-31."
    const placedBox = measureBox(contentEl) || measureBox(overlay);
    placedHeight = placedBox ? placedBox.height : null;
    repositioning = false;
  };
  reposition();

  // Watches `contentEl` for a height change AFTER this initial placement
  // (async content replacing a "Loading…" placeholder, a result list
  // growing, ...) and re-places the overlay when it happens, so no caller
  // has to remember to call `reposition()` itself on every content change --
  // see this module's own top doc comment, "A THIRD layer, 2026-07-31," for
  // why this converges instead of oscillating. Resolved from
  // `doc.defaultView` first, falling back to `globalThis`, and `undefined`
  // on both (every headless test in this pack, and any host with no live
  // one) is a clean, total no-op -- this mechanism simply never engages,
  // exactly like the viewport-flip above degrades to "never adjust" with no
  // real `window`.
  const resizeObserverCtor = (doc.defaultView && doc.defaultView.ResizeObserver)
    || (typeof globalThis !== "undefined" ? globalThis.ResizeObserver : undefined);
  let resizeObserver = null;
  if (typeof resizeObserverCtor === "function") {
    resizeObserver = new resizeObserverCtor(() => {
      if (repositioning) {
        // A resize `reposition()` itself just caused (its own max-height
        // cap on `contentEl`) -- swallow it here; `reposition()`'s own
        // `placedHeight` bookkeeping (above) already accounts for the
        // POST-cap height, so there is nothing new to react to.
        return;
      }
      const box = measureBox(contentEl) || measureBox(overlay);
      const h = box ? box.height : null;
      if (h == null || placedHeight == null || Math.abs(h - placedHeight) < 0.5) {
        return; // no real change -- never a spurious re-place (the panels' own periodic re-renders must not jitter the popover)
      }
      reposition(lastSizeOpts);
    });
    resizeObserver.observe(contentEl);
  }

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
    if (resizeObserver) {
      // A leaked observer holding a detached `contentEl` is exactly the kind
      // of thing that survives green tests -- tear it down every time, not
      // just when a content-resize actually happened.
      resizeObserver.disconnect();
      resizeObserver = null;
    }
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
 * `openOverlay` above, plus wheel handling on the overlay element itself
 * (`js/shared/canvas_zoom.mjs`) — so wheeling over any popover/menu this
 * pack ever opens (the LoRA search panel, option lists, ⚙ popovers, the ⓘ
 * panel, row context menus, the picker — every one of them opens through
 * THIS function) stays on the overlay and never reaches the canvas behind
 * it, while a genuinely scrollable child that still has room keeps scrolling
 * normally.
 *
 * This is deliberately `{ forwardToCanvas: false }` — a MENU, unlike a
 * node's own body, is a surface you interact with, not a window onto the
 * graph: scrolling a result list should scroll the list, not zoom the canvas
 * behind it, and a short menu with nothing to scroll should simply do
 * nothing on an unconsumed wheel (no zoom, no page scroll leaking out from
 * behind it either). The node-BODY passthrough this same helper was
 * originally built around (`.claude/skills/comfyui-node-renders-but-dead/
 * SKILL.md` symptom 8 — wheel-to-zoom silently dying under a DOM-widget row)
 * is untouched: that path calls `installCanvasZoomPassthrough` directly on
 * the row/node root with no `forwardToCanvas` override at all
 * (`js/controls/interaction.mjs`, `js/anima/interaction.mjs`,
 * `js/prompt_rules/node/index.js`), so it keeps forwarding exactly as
 * before. Only overlays opened through this one function change behaviour.
 *
 * `getCanvasEl` is the real `() => app.canvas && app.canvas.canvas` getter
 * from the caller's `index.js` (or `undefined` under test) — kept as a
 * parameter for API/signature stability even though menu mode never calls
 * it, so a future caller that needs the node-body forwarding behaviour for
 * some OTHER overlay doesn't require a signature change to opt back in.
 * Sets `handle.ownerKey`/tracks `_activeOverlay` itself, so callers don't
 * have to repeat that bookkeeping at every call site — set
 * `handle.ownerKey = key` is still the CALLER's job (this function doesn't
 * know what key a given opener wants to use), see `js/anima/interaction.mjs`
 * for the pattern.
 */
export function openOverlayWithZoom(getCanvasEl, doc, anchorEl, contentEl, placement, onClose, overlayClassName) {
  const handle = openOverlay(doc, anchorEl, contentEl, placement, onClose, overlayClassName);
  const uninstallZoom = installCanvasZoomPassthrough(handle.overlay, getCanvasEl, { forwardToCanvas: false });
  const origClose = handle.close;
  handle.close = () => {
    uninstallZoom();
    origClose();
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Anchor-aware max-height -- a SECOND overflow guard alongside the "below"
// placement's own viewport-flip above (`reposition()`, above): a popover can
// still be too TALL to fit even after flipping above the anchor, or a
// caller may never want the flip at all (a "below"-only list, like the
// model picker's) and just needs its own scrollable area clamped to
// whatever room genuinely exists.
//
// Extracted here (owner-reported overflow bug, 2026-07-30) from
// `civitai_search.mjs`'s original `computeSearchPanelMaxHeight` -- that
// panel's `.wtn-cs-panel` used to clamp itself with a static CSS `vh` value
// only, which says nothing about how much room actually exists BELOW a
// given anchor and overflowed the bottom of the screen for a node sitting
// low in the viewport (`c00fd24` fixed it there). `model_picker.mjs` had the
// exact same bug (`.wtn-mp-panel`'s own static `max-height: 62vh`) and needs
// the exact same computation -- but `model_picker.mjs` is deliberately
// track-agnostic (`AnimaLoaderPanel` imports it unchanged at M3, and a
// layering guard forbids it importing a `lora_*`/search-specific module), so
// this pure computation lives HERE, the one shared popover/overlay module
// both already import, rather than in `civitai_search.mjs` itself.
// ---------------------------------------------------------------------------

/** Gap between an anchor's own bottom edge and an anchored, "below"-placed
 * popover's top -- shared by every "how much room is there below the
 * anchor" computation in this pack. */
export const POPOVER_ANCHOR_GAP_PX = 6;

/** Breathing room so a maxed-out popover never touches the viewport's own
 * bottom edge. */
export const POPOVER_VIEWPORT_MARGIN_PX = 12;

/**
 * A "below"-anchored popover's own `max-height`, derived from the space
 * actually available below `anchorBottom` -- `viewportHeight - anchorBottom
 * - gap - margin` -- never smaller than `chromeHeight + minContentHeight`
 * (whatever fixed header/search-box the caller's own popover renders above
 * its scrollable area, plus that scrollable area's own floor), so a popover
 * anchored low in the viewport still reserves at least a USABLE amount of
 * its own scrollable content rather than shrinking to an unusable sliver --
 * at that point the popover's own height exceeds the space actually below
 * the anchor, and (for a caller using `openOverlay`'s `"below"` placement)
 * `reposition()`'s own viewport-flip, above, is what decides whether it
 * opens above the anchor instead. This function only ever answers "how much
 * room is there below" -- reusing, never duplicating, that flip decision.
 *
 * `null` when no real viewport size is available (mirrors this module's own
 * "`null` means never adjust" convention for a headless host with no live
 * `window`) -- the caller keeps its own CSS fallback `max-height` untouched.
 */
export function computeAnchoredMaxHeight({ anchorBottom, viewportHeight, chromeHeight, minContentHeight }) {
  if (!Number.isFinite(anchorBottom) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return null;
  }
  const safeChrome = Number.isFinite(chromeHeight) && chromeHeight >= 0 ? chromeHeight : 0;
  const safeMinContent = Number.isFinite(minContentHeight) && minContentHeight >= 0 ? minContentHeight : 0;
  const minTotal = safeChrome + safeMinContent;
  const available = viewportHeight - anchorBottom - POPOVER_ANCHOR_GAP_PX - POPOVER_VIEWPORT_MARGIN_PX;
  return Math.max(minTotal, available);
}
