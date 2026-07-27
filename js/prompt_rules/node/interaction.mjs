/**
 * interaction.mjs — input wiring + native-widget two-way sync for the
 * Prompt Rules DOM UI.
 *
 * The native, Python-declared widgets (`profile`, `sheets`, `positive`,
 * `negative`, `log_trace`, `embedded_rules`) stay the SOLE source of truth
 * that actually serializes into `widgets_values` and reaches
 * `nodes/prompt_rules/prompt_rules.py`'s `process()` — this module never invents a
 * parallel state object mirroring dynamic/repeating rows (there's no
 * dynamic/repeating data here to justify one). Every DOM
 * control this module wires is a thin two-way mirror of exactly one native
 * widget's `.value`:
 *
 *   - DOM -> widget: an input/change/click listener writes straight into
 *     `widget.value` (`wireInteractions`, below).
 *   - widget -> DOM: `refreshFromWidgets` reads every relevant widget's
 *     CURRENT `.value` back into its DOM control. Called at mount, after
 *     `onConfigure` restores a saved workflow's real values (`index.js`'s
 *     `restoreNode`), and after the "Pick…" popover closes (`index.js`'s
 *     `addPickerButton` — the popover writes directly into the `positive`/
 *     `negative` widgets via `getPositiveWidget`/`getNegativeWidget`,
 *     bypassing this module's own textarea, so the textarea needs an
 *     explicit resync or the inserted token would be invisible until the
 *     next full page reload). Every such PROGRAMMATIC `textarea.value`
 *     write also never fires the `input` event the highlighter repaints
 *     on, so `refreshFromWidgets` finishes by forcing both highlight
 *     handles to resync via `highlight_wiring.mjs`'s `refreshHighlighters`
 *     — see that module's doc comment for the full trap.
 *
 * `embedded_rules` has no DOM mirror at all (no visible control renders its
 * JSON) — it stays hidden-only, exactly as the previous
 * `js/prompt_rules/node/index.js` already did; only the "Open Rule Builder"
 * button (wired directly in `index.js`, which owns the cross-folder
 * `openRuleBuilder` import) ever writes to it.
 */

import {
  autoGrowTextarea,
  setLogTraceUI,
  setProfileOptions,
} from "./render.mjs";
import { readProfileValues, normalizeSheetsValue } from "./core.mjs";
import { refreshHighlighters } from "./highlight_wiring.mjs";

export function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

/** The five widgets this UI mirrors (NOT `embedded_rules` — see this
 * module's doc comment — and NOT `clip`, which is a connection socket, not
 * a widget). */
export function getWidgets(node) {
  return {
    profile: findWidget(node, "profile"),
    sheets: findWidget(node, "sheets"),
    positive: findWidget(node, "positive"),
    negative: findWidget(node, "negative"),
    logTrace: findWidget(node, "log_trace"),
  };
}

/**
 * widget -> DOM: read every native widget's CURRENT value into its DOM
 * mirror. Safe to call any number of times (mount, restore, post-picker) —
 * always reflects whatever the widgets hold RIGHT NOW, never a cached
 * snapshot. Re-grows both textareas afterward so restored/inserted content
 * is visible without requiring a keystroke first.
 */
export function refreshFromWidgets(node, refs) {
  const w = getWidgets(node);

  setProfileOptions(refs, readProfileValues(w.profile), w.profile && w.profile.value);
  refs.sheetsInput.value = normalizeSheetsValue(w.sheets && w.sheets.value);
  refs.positiveTextarea.value = (w.positive && w.positive.value) || "";
  refs.negativeTextarea.value = (w.negative && w.negative.value) || "";
  autoGrowTextarea(refs.positiveTextarea);
  autoGrowTextarea(refs.negativeTextarea);
  setLogTraceUI(refs, !!(w.logTrace && w.logTrace.value));

  // The programmatic-update trap (see this module's doc comment): the
  // textarea writes above never fire `input`, so force both highlight
  // handles to resync now -- a no-op for either pane whose handle is
  // `null` (highlighting unavailable/not yet wired).
  refreshHighlighters(refs);
}

function toggleLogTrace(node, refs, widgets) {
  if (!widgets.logTrace) {
    return;
  }
  widgets.logTrace.value = !widgets.logTrace.value;
  setLogTraceUI(refs, !!widgets.logTrace.value);
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

/**
 * DOM -> widget: wire every control's own edit event straight into its
 * native widget's `.value`. Idempotent (a second call on the same `refs` is
 * a no-op, guarded by `refs.wired` below).
 */
export function wireInteractions(node, refs) {
  if (refs.wired) {
    return refs;
  }
  refs.wired = true;

  const widgets = getWidgets(node);

  refs.profileSelect.addEventListener("change", () => {
    if (!widgets.profile) {
      return;
    }
    widgets.profile.value = refs.profileSelect.value;
    if (typeof node.setDirtyCanvas === "function") {
      node.setDirtyCanvas(true, true);
    }
  });

  refs.sheetsInput.addEventListener("input", () => {
    if (!widgets.sheets) {
      return;
    }
    widgets.sheets.value = refs.sheetsInput.value;
  });

  refs.positiveTextarea.addEventListener("input", () => {
    autoGrowTextarea(refs.positiveTextarea);
    if (widgets.positive) {
      widgets.positive.value = refs.positiveTextarea.value;
    }
  });

  refs.negativeTextarea.addEventListener("input", () => {
    autoGrowTextarea(refs.negativeTextarea);
    if (widgets.negative) {
      widgets.negative.value = refs.negativeTextarea.value;
    }
  });

  refs.traceSwitch.addEventListener("click", () => toggleLogTrace(node, refs, widgets));
  refs.traceSwitch.addEventListener("keydown", (event) => {
    const key = event && event.key;
    if (key === "Enter" || key === " ") {
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      toggleLogTrace(node, refs, widgets);
    }
  });

  return refs;
}
