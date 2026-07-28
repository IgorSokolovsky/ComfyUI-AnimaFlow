/**
 * canvas_zoom.mjs — mouse-wheel-zooms-the-canvas-through-a-DOM-widget fix
 * (LEGACY litegraph only; no-ops under Nodes 2.0).
 *
 * Ported from `../ComfyUI-Pixaroma/js/shared/canvas_zoom.mjs` (MIT — see
 * `THIRD_PARTY_NOTICES.md`'s ComfyUI-Pixaroma entry, extended to cover this
 * file) — same rationale, same two exports, same per-direction scroll logic.
 * In our own words:
 *
 * ComfyUI binds wheel-to-zoom on the `<canvas>` element itself. An
 * `addDOMWidget` element is layered OVER that canvas (this pack's whole
 * row-widget architecture — see `js/controls/render.mjs`'s top doc comment,
 * and `js/prompt_rules/node/`'s single body widget), so a wheel event fired
 * while the cursor sits over our rows/textarea is consumed by that DOM
 * element and never reaches the canvas underneath it — zoom silently stops
 * the moment the cursor crosses onto our UI. This mirrors ComfyUI's OWN
 * built-in preview widgets, which hit the identical problem and fix it the
 * identical way (`useCanvasInteractions` → `forwardEventToCanvas`): forward
 * the wheel to the canvas UNLESS the cursor is over a genuinely scrollable
 * region that still has room to scroll in the wheel's own direction (a long
 * prompt textarea, an option list, a resolution list) — there, let it
 * scroll normally instead of hijacking it. Nodes 2.0 already forwards the
 * wheel to the canvas via its own node container, so this whole mechanism
 * is CLASSIC-RENDERER-ONLY and must no-op under Nodes 2.0 (this repo's
 * `.claude/CLAUDE.md`: "Target renderer: LEGACY litegraph").
 *
 * No `nodes2.mjs` exists in this repo yet (unlike Pixaroma's), so the tiny
 * Nodes 2.0 check Pixaroma imports from its own `shared/nodes2.mjs` is
 * inlined here (`isVueNodes` below) rather than standing up a whole parallel
 * module for one boolean.
 *
 * ## Quiet-period lock — one continuous wheel gesture never both scrolls AND
 * zooms
 *
 * Without this, the INSTANT a wheel gesture that's scrolling `.wtn-an-panel`/
 * `.wtn-ctl-menu` (etc.) hits either end of its range, `scrollRegionWantsWheel`
 * starts returning `false` and the very next wheel EVENT of that same
 * continuing gesture (still the same physical scroll motion, no pause) falls
 * straight through to the canvas and zooms it — read by a user as the node
 * randomly jumping/zooming mid-scroll, not as "I scrolled past the end." The
 * fix is a per-INSTALL (per-root/per-node — deliberately a closure variable,
 * never module-level, so two different nodes' locks never interfere with each
 * other) quiet-period lock: every wheel event a scroll region CONSUMES stamps
 * `lastConsumedAt`; a wheel event that ISN'T consumed, arriving less than
 * `WHEEL_LOCK_MS` after that stamp, is dropped entirely — no
 * `preventDefault`, no re-dispatch to the canvas, the gesture just ends with
 * no visible effect. Only once the user has stopped wheeling for a full
 * `WHEEL_LOCK_MS` does an unconsumed wheel event reach the canvas again.
 * `scrollRegionWantsWheel` itself stays a pure, timing-free per-direction
 * predicate on purpose — this lock lives ONLY in `installCanvasZoomPassthrough`,
 * so the pure function keeps being trivially unit-testable with no clock at
 * all.
 *
 * `Date.now()` is neither available nor desirable inside the headless test
 * harness, so the clock is an INJECTABLE third argument
 * (`installCanvasZoomPassthrough(root, getCanvasEl, { now, lockMs })`),
 * defaulting `now` to `() => Date.now()` and `lockMs` to `WHEEL_LOCK_MS` — the
 * existing two-argument call form (`js/shared/overlay.mjs`, every `index.js`)
 * is completely unchanged by this, since both options are optional.
 *
 * This module is imported by BOTH `js/anima/` and `js/controls/` (see the
 * exports below), so this fix — and every other behaviour in this file —
 * lands for both tracks at once, from this one place. That's intentional,
 * not a scope leak: it's the same module either track would otherwise have
 * to duplicate.
 */

/** Default quiet period (ms): once a wheel event is consumed by an internal
 * scroll region, an unconsumed wheel event arriving sooner than this after
 * it is dropped rather than zooming the canvas — see this module's own top
 * doc comment ("Quiet-period lock"). Exported so it's tunable from one
 * place; callers can also override it per-install via the `lockMs` option. */
export const WHEEL_LOCK_MS = 450;

/**
 * True when ComfyUI's Nodes 2.0 (Vue) renderer is active — driven by
 * `LiteGraph.vueNodesMode`. Read live (never cached), so a runtime renderer
 * toggle is respected without a page reload.
 */
export function isVueNodes() {
  return !!(typeof window !== "undefined" && window.LiteGraph && window.LiteGraph.vueNodesMode);
}

/**
 * The computed style for `el` — real `getComputedStyle` in an actual
 * browser (so a `.wtn-ctl-menu { overflow-y: auto }` STYLESHEET rule is
 * honored, not just an inline `style=` attribute), falling back to `el`'s
 * own `.style` object when no global `getComputedStyle` exists (there is
 * none under plain `node`, per this pack's testing convention — see
 * `js/controls/test_resize.mjs`'s doc-stub pattern — so this fallback is
 * what makes `scrollRegionWantsWheel` unit-testable at all: a test sets
 * `el.style.overflowY = "auto"` directly rather than needing a real
 * stylesheet).
 */
function styleOf(el) {
  if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    return window.getComputedStyle(el);
  }
  return el.style || {};
}

/**
 * True when an element between `target` and `root` (inclusive of neither —
 * walk stops at `root.parentElement`) is scrollable in the wheel's own axis
 * AND still has room to scroll in the wheel's own DIRECTION — i.e. the wheel
 * should scroll THAT element, not zoom the canvas. This is deliberately
 * PER-DIRECTION, not a single "is this scrollable" boolean: an element in
 * the middle of its scroll range keeps the wheel in BOTH directions; one
 * pinned at an end (or with no scrollbar at all — `scrollHeight <=
 * clientHeight`) only keeps it for the direction that still has room, and
 * passes the wheel through everywhere else (so wheeling past either end, or
 * over a region that was never scrollable to begin with, reaches the canvas
 * and zooms instead of doing nothing).
 */
export function scrollRegionWantsWheel(target, root, deltaX, deltaY) {
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
  const stopAt = root && root.parentElement;
  let el = target;
  while (el && el !== stopAt) {
    if (el.nodeType === undefined || el.nodeType === 1) {
      const cs = styleOf(el);
      if (vertical) {
        const oy = cs.overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
          const atTop = el.scrollTop <= 0;
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
          if ((deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom)) {
            return true;
          }
        }
      } else {
        const ox = cs.overflowX;
        if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) {
          const atLeft = el.scrollLeft <= 0;
          const atRight = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
          if ((deltaX < 0 && !atLeft) || (deltaX > 0 && !atRight)) {
            return true;
          }
        }
      }
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Best-effort default for `getCanvasEl` (below) when a caller doesn't pass
 * its own: ComfyUI's `scripts/app.js` singleton also hangs off `window.app`
 * (its widely-relied-on global, same one `window.LiteGraph` sits next to).
 * Callers that already hold a real `app` import — every `index.js` in this
 * pack — should pass an explicit getter instead of relying on this guess.
 */
function defaultGetCanvasEl() {
  return (
    (typeof window !== "undefined" && window.app && window.app.canvas && window.app.canvas.canvas) || null
  );
}

/**
 * Install wheel-to-canvas-zoom passthrough on an in-node DOM widget `root`
 * (Classic renderer). Safe to call unconditionally — it no-ops under Nodes
 * 2.0. Returns an uninstall function (call it on node/row removal so the
 * listener doesn't leak — this pack already has teardown paths for that,
 * see `js/controls/interaction.mjs`'s `removeRowWidgets`/`onRemove`
 * convention).
 *
 * `getCanvasEl` (optional) returns the live LiteGraph `<canvas>` element,
 * called FRESH on every wheel event, never cached — the canvas can be
 * recreated. This is an injectable dependency rather than a static
 * `import { app } from "/scripts/app.js"` (Pixaroma's original does import
 * it statically) for the same reason `rows.mjs`'s `getComboOptions` takes an
 * injectable registry instead of reading `window.LiteGraph` itself: a
 * top-level `/scripts/app.js` import 404s under this file's own plain-`node`
 * test suite (see `js/controls/render.mjs`'s identical `THEME_URL` guarded-
 * import note). Every real caller (`js/controls/index.js`,
 * `js/prompt_rules/node/index.js`) already has a genuine `app` import and
 * should pass `() => app.canvas && app.canvas.canvas` explicitly;
 * `defaultGetCanvasEl` above is only a best-effort fallback if one doesn't.
 *
 * `options.now`/`options.lockMs` (both optional, both third-argument-only —
 * see this module's top doc comment's "Quiet-period lock" section) drive the
 * per-install quiet-period lock: `now()` defaults to `() => Date.now()`,
 * `lockMs` defaults to `WHEEL_LOCK_MS`. The lock's own `lastConsumedAt` state
 * lives in THIS closure, one per call to this function — never module-level —
 * so installing it on two different nodes' roots never lets one node's
 * scrolling arm the other node's lock.
 */
export function installCanvasZoomPassthrough(root, getCanvasEl, options) {
  if (!root || typeof root.addEventListener !== "function") {
    return () => {};
  }
  const resolveCanvas = typeof getCanvasEl === "function" ? getCanvasEl : defaultGetCanvasEl;
  const nowFn = options && typeof options.now === "function" ? options.now : () => Date.now();
  const lockMs = options && typeof options.lockMs === "number" ? options.lockMs : WHEEL_LOCK_MS;
  let lastConsumedAt = -Infinity;
  const onWheel = (e) => {
    if (isVueNodes()) {
      return; // Nodes 2.0 forwards the wheel to the canvas itself
    }
    if (scrollRegionWantsWheel(e.target, root, e.deltaX, e.deltaY)) {
      lastConsumedAt = nowFn(); // arms the quiet-period lock
      return; // a scrollable region still has room in this direction -- let it scroll
    }
    if (nowFn() - lastConsumedAt < lockMs) {
      // The SAME continuing gesture just finished scrolling an internal
      // region to one of its ends -- don't let it zoom the canvas too. The
      // gesture simply ends here: no preventDefault, no dispatch.
      return;
    }
    const canvasEl = resolveCanvas(); // read lazily -- the canvas can be recreated
    if (!canvasEl) {
      return;
    }
    e.preventDefault(); // requires the non-passive listener registered below
    e.stopPropagation();
    // Re-dispatch a synthetic wheel to the LiteGraph canvas so it zooms --
    // exactly what ComfyUI's own forwardEventToCanvas does for its preview
    // widgets.
    const { clientX, clientY, deltaX, deltaY, deltaMode, ctrlKey, metaKey, shiftKey } = e;
    canvasEl.dispatchEvent(
      new WheelEvent("wheel", {
        clientX,
        clientY,
        deltaX,
        deltaY,
        deltaMode,
        ctrlKey,
        metaKey,
        shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    );
  };
  root.addEventListener("wheel", onWheel, { passive: false });
  return () => root.removeEventListener("wheel", onWheel);
}
