/**
 * index.js — registers the Anima Prompt Studio node's frontend extension.
 *
 * Absolute `/scripts/app.js` import (this file is nested in
 * `js/anima_prompt/anima_prompt_studio/` — the frontend skill's gotcha #1: a relative
 * `../../scripts/app.js` resolves wrong from a subfolder and silently kills
 * the whole extension).
 *
 * ## Widget-hiding decisions (which widgets get the DOM treatment)
 *
 * Two of this node's five widgets are hidden-and-mirrored (per the
 * serialized-STRING state pattern from the frontend skill — a REAL,
 * still-serializing widget the JS only hides for rendering):
 *   - `blocks_state`: the block editor's own JSON state. This is the whole
 *     reason this node has heavy JS at all.
 *   - `rules_correction_enabled`: driven directly by the custom top-bar
 *     switch (`render.mjs`'s `.wtn-aps-switch`), rather than building a
 *     second, independent piece of state for it — the switch just flips
 *     this native BOOLEAN widget's `.value` and mirrors the visual state
 *     back (`setRulesToggleUI`). Chosen over a from-scratch custom toggle
 *     abstraction because there's nothing to gain from decoupling it: the
 *     widget already IS a plain boolean, hiding+mirroring it is the same
 *     amount of code as inventing a parallel property, and it keeps
 *     `IS_CHANGED`/persistence working through the exact same mechanism as
 *     `blocks_state`.
 *
 * `separator`, `rules_profile`, `rules_sheets` are deliberately left as
 * ComfyUI's own default canvas widgets (rendered above the DOM widget, in
 * `INPUT_TYPES` declaration order) — no custom DOM needed for a plain text
 * field / two combo-ish string fields, and keeping them native is less
 * code, matches how e.g. `js/anima_prompt/prompt_rules` leaves its similar `profile`/
 * `sheets` widgets alone. Only the block editor and the correction toggle
 * warranted a DOM rebuild.
 *
 * ## No `onExecuted` / no network preview call
 *
 * `AnimaPromptStudio.compose()` is a thin passthrough returning a plain
 * `(positive, negative)` tuple (no `{"ui": {...}}` side-channel, unlike
 * `PromptCombiner`) — so there is no backend "last run" result to reflect
 * here. The LIVE PREVIEW strip is therefore ALWAYS the pure client-side,
 * uncorrected assembly (`core.mjs`'s `assemblePanePreview`), clearly
 * labeled "(uncorrected)" whenever `rules_correction_enabled` is on
 * (`render.mjs`'s `renderPreview`). A debounced call to the existing
 * `/wtn/rules/preview` route for a truly-corrected live preview was
 * explicitly called out as a nice-to-have, not required, in the plan; it
 * is NOT implemented here — the offline, always-available preview keeps
 * this already-highest-JS-effort node's surface area smaller, and it's an
 * honest preview (never silently wrong) rather than a best-effort one that
 * can go stale/fail against an unreachable route.
 */
import { app } from "/scripts/app.js";
import { parseBlocksState } from "./core.mjs";
import {
  injectStyles,
  buildRoot,
  setRulesToggleUI,
  measureMinHeight,
  scheduleRefit,
  scheduleInitialFit,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import { wireInteractions, renderAllPanes, findWidget } from "./interaction.mjs";

const NODE_CLASS_NAME = "AnimaPromptStudio";
const BLOCKS_STATE_WIDGET_NAME = "blocks_state";
const RULES_WIDGET_NAME = "rules_correction_enabled";

/** Hide a declared widget from rendering only — it keeps serializing
 * normally (per the skill's "hide a declared widget that must still
 * serialize" pattern). Works for both the text `blocks_state` widget (which
 * has an `inputEl`) and the boolean `rules_correction_enabled` widget
 * (which typically doesn't). */
function hideWidget(targetWidget) {
  if (!targetWidget) {
    return;
  }
  targetWidget.hidden = true;
  targetWidget.computeSize = () => [0, -4];
  if (targetWidget.inputEl && targetWidget.inputEl.style) {
    targetWidget.inputEl.style.display = "none";
  }
}

/** Floor a freshly-created node's size UP to `[DEFAULT_W, DEFAULT_H]`
 * (never down), guarded by `node._apsConfigured` so a node being restored
 * from a saved workflow is never touched — mirrors
 * `js/anima_prompt/prompt_combiner/index.js`'s `ensureInitialFloor` exactly (see that
 * file's doc comment for the full ordering rationale). */
function ensureInitialFloor(node) {
  if (node._apsConfigured) {
    return;
  }
  const curW = Array.isArray(node.size) && typeof node.size[0] === "number" ? node.size[0] : 0;
  const curH = Array.isArray(node.size) && typeof node.size[1] === "number" ? node.size[1] : 0;
  const w = Math.max(curW, DEFAULT_W);
  const h = Math.max(curH, DEFAULT_H);
  if (w === curW && h === curH) {
    return;
  }
  if (typeof node.setSize === "function") {
    node.setSize([w, h]);
  } else if (Array.isArray(node.size)) {
    node.size[0] = w;
    node.size[1] = h;
  }
}

/**
 * Build (or, if already built, return) the node's DOM UI refs. Mounts one
 * `addDOMWidget` containing the whole styled UI (top bar + panes + LIVE
 * PREVIEW). Seeds `node.properties.studioState` from the `blocks_state`
 * widget's CURRENT value the first time this runs — that's either Python's
 * default seed JSON (a fresh node) or whatever JSON a pasted/duplicated
 * node already carries; `restoreNode` (below) re-seeds from the value AGAIN
 * after `onConfigure` has actually restored a saved workflow's
 * `widgets_values` onto it, since this initial parse happens too early to
 * see that for a loaded node (`onNodeCreated` always fires before
 * `onConfigure`).
 *
 * Widget sizing follows the same two-renderer contract as every other DOM-
 * widget node in this pack (see `render.mjs`'s own doc comment): legacy
 * `getMinHeight` (PRIMARY — this build targets the legacy litegraph
 * renderer) + Nodes 2.0 `computeLayoutSize` (`minWidth: 1`, forward-compat
 * only). Neither path itself resizes the node — that's `scheduleRefit`/
 * `scheduleInitialFit`'s job, wired at explicit structural triggers only.
 */
function mountUI(node) {
  if (node._apsRefs) {
    return node._apsRefs;
  }

  const blocksStateWidget = findWidget(node, BLOCKS_STATE_WIDGET_NAME);
  const rulesWidget = findWidget(node, RULES_WIDGET_NAME);
  hideWidget(blocksStateWidget);
  hideWidget(rulesWidget);

  injectStyles(typeof document !== "undefined" ? document : undefined);
  const doc = typeof document !== "undefined" ? document : undefined;
  const refs = buildRoot(doc);
  node._apsRefs = refs;

  node.properties = node.properties || {};
  node.properties.studioState = parseBlocksState(blocksStateWidget && blocksStateWidget.value);

  wireInteractions(node, refs);
  renderAllPanes(node, refs);
  setRulesToggleUI(refs, !!(rulesWidget && rulesWidget.value));

  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("aps_ui", "aps_ui", refs.root, {
      serialize: false,
      // Legacy canvas renderer sizing path (PRIMARY) — NOT computeSize/
      // getHeight (those fight node.setSize under the legacy renderer).
      getMinHeight: () => measureMinHeight(refs.root),
    });
  } else {
    // Defensive fallback for a host without addDOMWidget; shouldn't occur
    // in ComfyUI's actual runtime.
    widget = { name: "aps_ui", type: "aps_ui", element: refs.root };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }
  widget.serialize = false;
  if (widget.options) {
    widget.options.serialize = false;
  }
  // Nodes 2.0 (Vue/DOM renderer) sizing path — forward-compat only.
  widget.computeLayoutSize = function () {
    return { minHeight: measureMinHeight(refs.root), minWidth: 1 };
  };
  refs.widget = widget;

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }

  return refs;
}

function setupNode(node) {
  const refs = mountUI(node);
  ensureInitialFloor(node);
  // GUARDED initial fit — a no-op if this node turns out to be loading
  // from a saved workflow (see `scheduleInitialFit`'s doc comment in
  // render.mjs): by the time its rAF fires, onConfigure has already set
  // `node._apsConfigured` and litegraph has already restored `node.size`.
  scheduleInitialFit(node, refs.root);
}

/**
 * Restore the DOM UI after `onConfigure` has restored `node.properties`,
 * `widgets_values` (including `blocks_state`'s and
 * `rules_correction_enabled`'s REAL saved values), and `node.size` from a
 * saved workflow: re-parse `node.properties.studioState` from the NOW-
 * restored `blocks_state` widget value (overwriting `mountUI`'s earlier,
 * too-early parse), fully rebuild both panes + the preview strip from it,
 * and re-sync the correction switch's visual state from the restored
 * `rules_correction_enabled` widget. Deliberately does NOT call
 * `scheduleRefit`/`scheduleInitialFit` — trusts the `node.size` litegraph
 * already restored (mirrors `js/anima_prompt/prompt_combiner/index.js`'s `restoreNode`).
 */
function restoreNode(node) {
  const refs = mountUI(node);
  const blocksStateWidget = findWidget(node, BLOCKS_STATE_WIDGET_NAME);
  const rulesWidget = findWidget(node, RULES_WIDGET_NAME);
  node.properties = node.properties || {};
  node.properties.studioState = parseBlocksState(blocksStateWidget && blocksStateWidget.value);
  renderAllPanes(node, refs);
  setRulesToggleUI(refs, !!(rulesWidget && rulesWidget.value));
}

app.registerExtension({
  name: "webtoon.anima_prompt_studio",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS_NAME) {
      return;
    }

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated ? originalOnNodeCreated.apply(this, args) : undefined;
      setupNode(this);
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      // Mark this node as loaded-from-a-workflow FIRST, before anything
      // else runs — see `js/anima_prompt/prompt_combiner/index.js`'s identical pattern
      // for why the ordering matters (the still-pending initial-fit rAF
      // queued back in onNodeCreated must see this flag by the time it
      // fires).
      this._apsConfigured = true;
      const result = originalOnConfigure ? originalOnConfigure.apply(this, args) : undefined;
      restoreNode(this);
      return result;
    };
  },
});
