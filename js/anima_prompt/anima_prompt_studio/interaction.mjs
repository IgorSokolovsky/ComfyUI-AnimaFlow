/**
 * interaction.mjs — input wiring + state-mutation orchestration for the
 * Anima Prompt Studio DOM UI.
 *
 * Connects the DOM root's events (built by `render.mjs`'s `buildRoot`/
 * `renderPane`) to `core.mjs`'s pure state mutations, the hidden
 * `blocks_state`/`rules_correction_enabled` widget mirrors, and
 * re-rendering (`render.mjs`). This is the ONE place that decides which
 * mutations are "structural" (full pane rebuild + `scheduleRefit`) vs.
 * in-place (`updateBlockRow`, no refit) vs. preview-only (no DOM change
 * beyond the LIVE PREVIEW strip) — see `createRowHandlers`'s doc comment.
 */

import {
  addBlock,
  removeBlock,
  moveBlock,
  toggleEnabled,
  togglePin,
  setBlockText,
  setBlockLabel,
  hasTriggerBlock,
  serializeBlocksState,
} from "./core.mjs";
import {
  renderPane,
  updateBlockRow,
  renderPreview,
  setRulesToggleUI,
  scheduleRefit,
} from "./render.mjs";

export function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

/** The `separator` widget stays a normal, visible native widget (see
 * `index.js`'s module doc comment for why only `blocks_state` and
 * `rules_correction_enabled` get the hide-and-mirror treatment) — this just
 * reads its live value for preview assembly. */
export function getSeparator(node) {
  const w = findWidget(node, "separator");
  return (w && typeof w.value === "string" && w.value) || ", ";
}

/** Reads the (hidden) `rules_correction_enabled` widget's live boolean
 * value — the single source of truth for the custom switch's ON/OFF
 * state, per the "drive the native widget directly" choice documented in
 * `index.js`. */
export function getRulesCorrectionEnabled(node) {
  const w = findWidget(node, "rules_correction_enabled");
  return !!(w && w.value);
}

/** Mirror `node.properties.studioState` into the hidden `blocks_state`
 * widget's `.value` — the serialized-STRING state pattern from the
 * frontend skill: a REAL, still-serializing widget the JS only hides for
 * rendering, never `serialize:false`s. Called after every mutation. */
export function syncBlocksStateWidget(node) {
  const w = findWidget(node, "blocks_state");
  if (w) {
    w.value = serializeBlocksState(node.properties.studioState);
  }
}

/** Re-render just the LIVE PREVIEW strip from the current state/separator/
 * toggle — never touches block-list DOM, never resizes. */
export function refreshPreview(node, refs) {
  renderPreview(
    refs,
    node.properties.studioState,
    getSeparator(node),
    getRulesCorrectionEnabled(node),
  );
}

/** Full rebuild of BOTH panes + the preview strip — used at mount and
 * after an `onConfigure` restore. Does NOT itself schedule a refit
 * (callers decide: the initial mount uses `scheduleInitialFit`, a restore
 * trusts the saved `node.size` and calls neither). */
export function renderAllPanes(node, refs) {
  const state = node.properties.studioState;
  renderPane(refs, "positive", state, refs.rowHandlers);
  renderPane(refs, "negative", state, refs.rowHandlers);
  refreshPreview(node, refs);
}

/**
 * Build (and cache on `refs.rowHandlers`) the row-level callback object
 * `render.mjs`'s `renderPane`/`buildBlockRow` wires each row's controls to.
 * Every handler:
 *   1. Mutates `node.properties.studioState` via the matching `core.mjs`
 *      function.
 *   2. Mirrors the result into the hidden `blocks_state` widget
 *      (`syncBlocksStateWidget`) so the backend always has the current
 *      state.
 *   3. Re-renders exactly as much as the change requires:
 *      - `onMove`/`onDelete` are STRUCTURAL (row count or order changed):
 *        full `renderPane` rebuild of the affected pane + `scheduleRefit`.
 *      - `onToggleEnabled`/`onTogglePin` are NOT structural (same rows,
 *        same order): `updateBlockRow` updates that one row in place, no
 *        rebuild, no refit.
 *      - `onLabelChange`/`onTextChange` don't touch block-list DOM at all
 *        (the input/textarea the user is typing into already shows the new
 *        value) — only the LIVE PREVIEW re-renders.
 *   4. Always refreshes the LIVE PREVIEW (cheap, and every mutation can
 *      change the assembled text).
 *
 * `refs.rowHandlers` is looked up (not closed over as a local `handlers`
 * object) inside `onMove`/`onDelete`'s `renderPane` calls, so a single
 * cached handlers object keeps working across rebuilds without needing to
 * be re-created each time.
 */
export function createRowHandlers(node, refs) {
  const handlers = {
    onToggleEnabled(pane, id) {
      const state = node.properties.studioState;
      if (!toggleEnabled(state, pane, id)) {
        return;
      }
      syncBlocksStateWidget(node);
      const block = (state[pane] || []).find((b) => b.id === id);
      if (block) {
        updateBlockRow(refs, pane, block);
      }
      refreshPreview(node, refs);
    },

    onTogglePin(pane, id) {
      const state = node.properties.studioState;
      if (!togglePin(state, pane, id)) {
        return;
      }
      syncBlocksStateWidget(node);
      const block = (state[pane] || []).find((b) => b.id === id);
      if (block) {
        updateBlockRow(refs, pane, block);
      }
      refreshPreview(node, refs);
    },

    onMove(pane, id, direction) {
      const state = node.properties.studioState;
      if (!moveBlock(state, pane, id, direction)) {
        return;
      }
      syncBlocksStateWidget(node);
      renderPane(refs, pane, state, refs.rowHandlers);
      refreshPreview(node, refs);
      scheduleRefit(node, refs.root);
    },

    onDelete(pane, id) {
      const state = node.properties.studioState;
      if (!removeBlock(state, pane, id)) {
        return;
      }
      syncBlocksStateWidget(node);
      renderPane(refs, pane, state, refs.rowHandlers);
      refreshPreview(node, refs);
      scheduleRefit(node, refs.root);
    },

    onLabelChange(pane, id, label) {
      const state = node.properties.studioState;
      if (!setBlockLabel(state, pane, id, label)) {
        return;
      }
      syncBlocksStateWidget(node);
      // No preview/refit — label is display-only, never part of the
      // assembled prompt text.
    },

    onTextChange(pane, id, text) {
      const state = node.properties.studioState;
      if (!setBlockText(state, pane, id, text)) {
        return;
      }
      syncBlocksStateWidget(node);
      refreshPreview(node, refs);
    },
  };

  refs.rowHandlers = handlers;
  return handlers;
}

function toggleRulesCorrection(node, refs) {
  const w = findWidget(node, "rules_correction_enabled");
  if (!w) {
    return;
  }
  w.value = !w.value;
  setRulesToggleUI(refs, !!w.value);
  refreshPreview(node, refs);
}

/**
 * Wire the two top-level, always-present controls: each pane's "+ type"
 * add-row buttons (STRUCTURAL — new row, full rebuild + refit; the
 * one-trigger-per-pane guard is a UI-level no-op here, never a hard
 * validation error — see `core.mjs`'s `hasTriggerBlock` doc comment) and
 * the Rules correction switch (native widget driven directly — see
 * `index.js`'s module doc comment for that choice). Idempotent (a second
 * call on the same `refs` is a no-op).
 */
export function wireInteractions(node, refs) {
  if (refs.wired) {
    return refs;
  }
  refs.wired = true;

  createRowHandlers(node, refs);

  Object.entries(refs.panes).forEach(([pane, paneRefs]) => {
    Object.entries(paneRefs.addButtons).forEach(([type, btn]) => {
      btn.addEventListener("click", () => {
        const state = node.properties.studioState;
        if (type === "trigger" && hasTriggerBlock(state, pane)) {
          // One-trigger-per-pane UI guard (nicety only — see module doc).
          return;
        }
        addBlock(state, pane, type);
        syncBlocksStateWidget(node);
        renderPane(refs, pane, state, refs.rowHandlers);
        refreshPreview(node, refs);
        scheduleRefit(node, refs.root);
      });
    });
  });

  refs.switchEl.addEventListener("click", () => toggleRulesCorrection(node, refs));
  refs.switchEl.addEventListener("keydown", (event) => {
    const key = event && event.key;
    if (key === "Enter" || key === " ") {
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      toggleRulesCorrection(node, refs);
    }
  });

  return refs;
}
