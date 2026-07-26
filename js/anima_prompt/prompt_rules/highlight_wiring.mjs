/**
 * highlight_wiring.mjs — wires the shared prompt tag-highlighter
 * (`js/shared/highlight/`) into this node's POSITIVE/NEGATIVE textareas, and
 * places its color legend in the node body below the action row, collapsed
 * by default.
 *
 * ## Why this is its own DEPENDENCY-INJECTED module, not a direct import
 *
 * `js/shared/highlight/index.js`'s own doc comment says every consumer
 * should `import { attachHighlighter, createLegend } from
 * "/extensions/ComfyUI-AnimaFlow/shared/highlight/index.js"` — an absolute
 * path. Per the `comfyui-dynamic-node-frontend` skill's `theme.mjs`
 * precedent, that exact shape of import FAILS to resolve under plain
 * `node` (no live ComfyUI asset server to rewrite `/extensions/...`), which
 * is fatal for any module this node's headless `test_resize.mjs` actually
 * imports and exercises (unlike `index.js` itself, which the test only
 * source-inspects via `readFileSync`, never executes).
 *
 * So the real `attachHighlighter`/`createLegend` are imported ONLY from
 * `index.js` (via a guarded `import()`, so a missing route or any other
 * load failure degrades non-fatally instead of throwing at extension-load
 * time) and handed to this module's `attachHighlighting` as
 * `attachHighlighterImpl`/`createLegendImpl`. `test_resize.mjs` injects
 * fake stand-ins the same way, so the WIRING logic (which textareas get
 * attached, where the legend is mounted, when `refresh()`/`detach()` fire)
 * is asserted directly instead of "eyeballed" — the shared module's own
 * `test_highlight.mjs` already covers the highlighter/legend internals.
 *
 * Every function below is a no-op / degrades to `null` handles rather than
 * throwing if its injected impl is missing, throws, or itself returns
 * `null` (the shared module's own documented degradation for "no document"
 * or a failed load) — this node must mount and work exactly as it does
 * today whether or not highlighting is available.
 */

import { scheduleRefit } from "./render.mjs";

/**
 * Attaches a highlighter to both `refs.positiveTextarea` and
 * `refs.negativeTextarea`, and builds the (collapsed) legend into
 * `refs.legendSlot` (see `render.mjs`'s `buildRoot`). Stores every handle on
 * `refs` (`positiveHighlight`, `negativeHighlight`, `legend`) so
 * `refreshHighlighters`/`teardownHighlighting`/the legend's own toggle-driven
 * refit can reach them later.
 *
 * Idempotent (mirrors `interaction.mjs`'s `wireInteractions`'s `refs.wired`
 * guard) — a second call on the same `refs` is a no-op.
 *
 * `opts`:
 *  - `attachHighlighterImpl` — the real `attachHighlighter` (or a test
 *    fake). Omitted/not-a-function -> both highlight handles stay `null`.
 *  - `createLegendImpl` — the real `createLegend` (or a test fake).
 *    Omitted/not-a-function -> `refs.legend` stays `null`.
 *  - `doc` — forwarded to `createLegendImpl({ doc, open: false })`.
 */
export function attachHighlighting(node, refs, opts = {}) {
  if (!refs || refs.highlightWired) {
    return refs;
  }
  refs.highlightWired = true;
  refs.positiveHighlight = null;
  refs.negativeHighlight = null;
  refs.legend = null;

  const { attachHighlighterImpl, createLegendImpl, doc } = opts;

  if (typeof attachHighlighterImpl === "function") {
    refs.positiveHighlight = safeAttach(attachHighlighterImpl, refs.positiveTextarea);
    refs.negativeHighlight = safeAttach(attachHighlighterImpl, refs.negativeTextarea);
  }

  if (typeof createLegendImpl === "function") {
    let legend = null;
    try {
      legend = createLegendImpl({ doc, open: false }) || null;
    } catch {
      legend = null; // load/build failure -- degrade to "no legend", never throw
    }
    refs.legend = legend;
    if (legend && legend.root && refs.legendSlot && typeof refs.legendSlot.appendChild === "function") {
      refs.legendSlot.appendChild(legend.root);
      wireLegendToggle(node, refs, legend);
    }
  }

  return refs;
}

function safeAttach(attachHighlighterImpl, textarea) {
  if (!textarea) {
    return null;
  }
  try {
    return attachHighlighterImpl(textarea) || null;
  } catch {
    return null; // network/DOM failure inside the shared module -- non-fatal
  }
}

/**
 * The legend is a `<details>` (per `js/shared/highlight/legend.mjs`), which
 * fires a native `toggle` event on expand/collapse. Without this, expanding
 * it grows the legend's content past the node's already-measured height and
 * it renders clipped/overlapping the next node down — so every toggle
 * re-fits the node via the SAME `scheduleRefit` every structural UI change
 * in this pack uses (grow-biased, rAF-deferred, never fights a user-enlarged
 * node — see `render.mjs`'s doc comment).
 */
function wireLegendToggle(node, refs, legend) {
  if (!legend.root || typeof legend.root.addEventListener !== "function") {
    return;
  }
  legend.root.addEventListener("toggle", () => {
    scheduleRefit(node, refs.root);
  });
}

/**
 * The programmatic-update fix: `interaction.mjs`'s `refreshFromWidgets` sets
 * `textarea.value` directly (never through user `input`), which the
 * highlighter never sees (it only repaints on the `input` event) — so every
 * call site of `refreshFromWidgets` (mount, `onConfigure` restore, the
 * "Pick…" popover's `onClose`) must force a resync afterward. Centralized
 * here (rather than inlined in `interaction.mjs`) so the "how do we safely
 * call a possibly-absent handle's `refresh()`" logic lives in one place.
 * No-ops for either pane whose handle is `null` (highlighting unavailable).
 */
export function refreshHighlighters(refs) {
  if (!refs) {
    return;
  }
  refs.positiveHighlight?.refresh?.();
  refs.negativeHighlight?.refresh?.();
}

/**
 * Node teardown: detaches both highlighter handles (removes their mirror
 * `<div>`, cancels any pending classify debounce/request) and destroys the
 * legend (removes it from the DOM). Called from `index.js`'s `onRemoved`
 * hook so a deleted node never leaves a detached mirror or a dangling timer
 * behind. Safe to call even if `attachHighlighting` never ran (e.g. the
 * highlighter failed to load) or was never called at all.
 */
export function teardownHighlighting(refs) {
  if (!refs) {
    return;
  }
  try {
    refs.positiveHighlight?.detach?.();
  } catch {
    // already detached/failed mid-flight -- fine, we're just being tidy
  }
  try {
    refs.negativeHighlight?.detach?.();
  } catch {
    // same as above
  }
  try {
    refs.legend?.destroy?.();
  } catch {
    // same as above
  }
  refs.positiveHighlight = null;
  refs.negativeHighlight = null;
  refs.legend = null;
}
