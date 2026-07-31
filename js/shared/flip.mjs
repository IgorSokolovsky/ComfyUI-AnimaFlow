/**
 * flip.mjs — shared FLIP (First-Last-Invert-Play) drag-reorder settle
 * animation core, extracted from `js/controls/lora_interaction.mjs`'s
 * original `captureRowTops`/`flipRows` (built for the LoRA loader, which has
 * exactly ONE `addDOMWidget` for the whole node body — see that module's own
 * top doc comment) while porting the identical animation to the Control /
 * Loader Panel (`js/controls/interaction.mjs`), whose row architecture is
 * different: one `addDOMWidget` PER ROW (`render.mjs`'s own top doc comment
 * explains why — each row parks its own output socket at that row widget's
 * `.y`).
 *
 * ## Why this module doesn't know or care about that difference
 *
 * FLIP itself is architecture-agnostic: capture each row's screen `top`
 * BEFORE a reorder, let the reorder happen (however the caller's track
 * repaints it), capture again, and animate the delta with an inverse
 * `transform`. The only two things that differ between the two tracks are
 * (a) where the row LIST lives (`node._lrRows` vs `node._ctrlRows`) and (b)
 * how to get a row's actual DOM element off one of that list's entries — both
 * pushed onto the caller via the `entries` array and the `getEl(entry)`
 * accessor, so this module never touches `node` at all.
 *
 * The ONE thing this module does NOT abstract over, on purpose, is WHEN it's
 * called: the LoRA loader's reorder is a synchronous DOM move
 * (`syncRows`'s `appendChild` on an existing child moves it immediately), so
 * its wrapper (`lora_interaction.mjs`) can call straight into this module the
 * instant the reorder returns. The Control Panel's reorder only swaps
 * `node.widgets`' order — the actual on-screen position is repainted
 * ASYNCHRONOUSLY by ComfyUI's own DOM-widget host (confirmed by reading the
 * installed `comfyui_frontend_package`'s bundled `DomWidgets`/`DomWidget` Vue
 * components: each row's wrapper `<div>` is repositioned off
 * `canvas.onDrawForeground`, which only runs once litegraph's own render
 * loop actually redraws — something `setDirtyCanvas(true, true)` merely
 * SCHEDULES for the next animation frame, never performs synchronously), so
 * ITS wrapper (`js/controls/interaction.mjs`) has to defer the call into this
 * module by one `requestAnimationFrame` first. Baking that extra wait in
 * here would be wrong for the LoRA loader's already-synchronous case (an
 * unnecessary frame of lag on every swap) — so the "when" stays each
 * caller's own job; see `js/controls/interaction.mjs`'s own `flipRows` doc
 * comment for its extra wrapping.
 *
 * `transform` is the ONLY CSS property this module ever touches, on purpose:
 * a DOM-widget row is composited over a canvas, so transitioning any layout
 * property there would visibly thrash. For the Control Panel specifically,
 * the ComfyUI DOM-widget host wraps each row element in its OWN `<div>`
 * whose `transform` IT manages (canvas-zoom `scale(...)`, recomputed every
 * redraw) — this module never touches that wrapper, only the row element
 * itself (`getEl(entry)`), which ComfyUI mounts once via `appendChild` and
 * never touches again, so there is nothing to fight over.
 *
 * `prefers-reduced-motion` is handled ENTIRELY by the `className` rule's own
 * `@media` query (`render.mjs`/`lora_render.mjs` both carry the identical
 * `.wtn-row-flip` rule) — there is deliberately no JS branch for it here: with
 * the transition removed, the exact same set-transform-then-clear sequence
 * below simply snaps instead of gliding.
 */

/** Every entry (from `entries`, e.g. `node._lrRows`/`node._ctrlRows`) whose
 * element (via `getEl(entry)`) supports `getBoundingClientRect`, keyed by
 * `entry.id` — call this BEFORE a reorder is applied/repainted, so `flipRows`
 * (below) has an "old" position to diff the "new" one against. Never throws
 * on an entry whose element lacks a real `getBoundingClientRect` (a headless
 * test stub's default rect is static, which is fine — see `flipRows`'s own
 * doc comment on what that means for headless tests). */
export function captureRowTops(entries, getEl) {
  const map = new Map();
  for (const entry of entries || []) {
    const el = entry && getEl(entry);
    if (el && typeof el.getBoundingClientRect === "function") {
      map.set(entry.id, el.getBoundingClientRect().top);
    }
  }
  return map;
}

/**
 * Call once the reorder this `beforeTops` was captured against has actually
 * been REPAINTED (see this module's top doc comment — that moment differs
 * per track, which is why the caller decides when, not this function). For
 * every entry whose element's top moved (`beforeTops` vs its NOW top), writes
 * the OLD-minus-NEW delta as an inline `transform: translateY(...)`
 * immediately (so the row visually stays where it was for one frame), then —
 * one animation frame later — adds `className` (which transitions `transform`
 * back to nothing) and clears the inline style, removing the class again
 * after `settleMs`. `transform` is the ONLY property ever touched.
 *
 * Under a host with no `requestAnimationFrame` (this pack's own headless-test
 * convention) the transform is cleared immediately instead of animated — an
 * instant settle, never a row stuck mid-transform.
 */
export function flipRows(entries, getEl, beforeTops, { className, settleMs }) {
  for (const entry of entries || []) {
    const was = beforeTops.get(entry.id);
    if (was == null) {
      continue;
    }
    const el = entry && getEl(entry);
    if (!el || typeof el.getBoundingClientRect !== "function" || !el.style) {
      continue;
    }
    const now = el.getBoundingClientRect().top;
    const dy = was - now;
    if (!dy) {
      continue; // this row didn't visually move (e.g. the dragged row itself, still under the pointer)
    }
    el.classList.remove(className); // restart cleanly if a previous flip is still mid-flight
    el.style.transform = `translateY(${dy}px)`;
    if (typeof requestAnimationFrame !== "function") {
      el.style.transform = "";
      continue;
    }
    requestAnimationFrame(() => {
      el.classList.add(className);
      el.style.transform = "";
      const clear = () => el.classList.remove(className);
      if (typeof setTimeout === "function") {
        setTimeout(clear, settleMs);
      } else {
        clear();
      }
    });
  }
}
