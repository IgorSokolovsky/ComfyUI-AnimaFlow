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
  let closed = false;
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    if (win) {
      win.removeEventListener("pointerdown", onDocPointerDown, true);
      win.removeEventListener("keydown", onKeydown, true);
    }
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
      win.addEventListener("pointerdown", onDocPointerDown, true);
      win.addEventListener("keydown", onKeydown, true);
    }, 0);
  }

  return { overlay, close, reposition };
}

// ---------------------------------------------------------------------------
// Single-overlay-at-a-time bookkeeping + the toggle primitive every opener
// needs (`comfyui-node-renders-but-dead` skill's root cause G: a menu that
// closes-then-reopens on a second click of its own opener). ONE module-level
// active-overlay slot, shared by every caller of this file (Controls AND
// Anima) -- correct, since only one overlay should ever be open across the
// WHOLE page, not one per node type.
//
// Exposed as a mutable REF OBJECT (`activeOverlayRef.current`), not a bare
// private variable + accessor functions, because several call sites (both
// in `js/controls/interaction.mjs` and `js/anima/interaction.mjs`) need to
// read/clear it directly from inside their OWN `onClose` callback (to null
// it out only if it's still THEIR handle, guarding against a stale close
// racing a newer overlay that already replaced it) — an object reference is
// what lets that read/write cross the module boundary without re-exporting
// a setter for every shape of that guard.
// ---------------------------------------------------------------------------

export const activeOverlayRef = { current: null };

export function closeActiveOverlay() {
  if (activeOverlayRef.current) {
    activeOverlayRef.current.close();
    activeOverlayRef.current = null;
  }
}

/**
 * Close the active overlay ONLY IF it's the one identified by `key` (each
 * opener's own stable id, e.g. `${kind}:${row.id}` or `gen:${stageKey}`),
 * returning whether it actually closed anything. This — not the outside-
 * click/Escape listener inside `openOverlay` above — is what makes a second
 * click on the SAME control close its own popover instead of closing-then-
 * reopening it: see this module's top doc comment / the `comfyui-node-
 * renders-but-dead` skill's root cause G.
 */
export function closeOverlayIfOwnedBy(key) {
  if (activeOverlayRef.current && activeOverlayRef.current.ownerKey === key) {
    closeActiveOverlay();
    return true;
  }
  return false;
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
