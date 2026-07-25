/**
 * index.js — registers the Anima Region Mask Editor node's frontend
 * extension.
 *
 * Absolute `/scripts/app.js` import (this file is nested in
 * `js/anima/anima_region_mask_editor/` — the frontend skill's gotcha #1: a
 * relative `../../scripts/app.js` resolves wrong from a subfolder and
 * silently kills the whole extension).
 *
 * ## Widget-hiding decisions
 *
 * Only ONE of this node's three widgets gets the hide-and-mirror
 * treatment:
 *   - `regions`: the editor's own serialized region geometry (JSON) — the
 *     whole reason this node has heavy JS at all. Hidden per the
 *     serialized-STRING-widget state pattern from the frontend skill (a
 *     REAL, still-serializing widget the JS only hides for rendering —
 *     never `serialize:false`).
 *
 * `canvas_width`/`canvas_height` are deliberately left as ComfyUI's own
 * default native INT widgets (rendered above the DOM widget, in
 * `INPUT_TYPES` declaration order) — no custom DOM needed for two plain
 * integer fields, matching how `js/anima_prompt/anima_prompt_studio` leaves its
 * `separator`/`rules_profile`/`rules_sheets` widgets alone for the same
 * reason. This node's own `render.mjs`/`interaction.mjs` read their live
 * values (`readCanvasSize`) only for the stage's cosmetic aspect ratio; the
 * actual rasterization always happens in Python against whatever value
 * those widgets carry at execution time, regardless of what the stage's
 * preview box looks like.
 */
import { app } from "/scripts/app.js";
import { defaultRegions, parseRegions } from "./core.mjs";
import {
  buildRoot,
  injectStyles,
  measureMinHeight,
  scheduleInitialFit,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import { renderAll, unwireInteractions, wireInteractions } from "./interaction.mjs";

const NODE_CLASS_NAME = "AnimaRegionMaskEditor";
const REGIONS_WIDGET_NAME = "regions";

/** Hide a declared widget from rendering only — it keeps serializing
 * normally (per the skill's "hide a declared widget that must still
 * serialize" pattern). */
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

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

/** Floor a freshly-created node's size UP to `[DEFAULT_W, DEFAULT_H]`
 * (never down), guarded by `node._armConfigured` so a node being restored
 * from a saved workflow is never touched — mirrors
 * `js/anima_prompt/anima_prompt_studio/index.js`'s `ensureInitialFloor` exactly. */
function ensureInitialFloor(node) {
  if (node._armConfigured) {
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
 * Build (or, if already built, return) the node's DOM UI refs. Seeds
 * `node.properties.regions` from the `regions` widget's CURRENT value the
 * first time this runs (either Python's default seed JSON for a fresh
 * node, or whatever JSON a pasted/duplicated node already carries) —
 * `restoreNode` re-seeds AGAIN after `onConfigure` has actually restored a
 * saved workflow's `widgets_values`, since this initial parse runs too
 * early to see that for a loaded node (`onNodeCreated` always fires before
 * `onConfigure`).
 */
function mountUI(node) {
  if (node._armRefs) {
    return node._armRefs;
  }

  const regionsWidget = findWidget(node, REGIONS_WIDGET_NAME);
  hideWidget(regionsWidget);

  injectStyles(typeof document !== "undefined" ? document : undefined);
  const doc = typeof document !== "undefined" ? document : undefined;
  const refs = buildRoot(doc);
  node._armRefs = refs;

  node.properties = node.properties || {};
  const parsed = parseRegions(regionsWidget && regionsWidget.value);
  node.properties.regions = parsed.length ? parsed : defaultRegions();

  wireInteractions(node, refs);
  renderAll(node, refs);

  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("arm_ui", "arm_ui", refs.root, {
      serialize: false,
      // Legacy canvas renderer sizing path (PRIMARY) — NOT computeSize/
      // getHeight (those fight node.setSize under the legacy renderer).
      getMinHeight: () => measureMinHeight(refs.root),
    });
  } else {
    // Defensive fallback for a host without addDOMWidget; shouldn't occur
    // in ComfyUI's actual runtime.
    widget = { name: "arm_ui", type: "arm_ui", element: refs.root };
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
  // from a saved workflow (see `scheduleInitialFit`'s doc comment).
  scheduleInitialFit(node, refs.root);
}

/**
 * Restore the DOM UI after `onConfigure` has restored `node.properties`,
 * `widgets_values` (including `regions`'s REAL saved value), and
 * `node.size` from a saved workflow: re-parse `node.properties.regions`
 * from the NOW-restored `regions` widget value, fully rebuild the stage +
 * list from it. Deliberately does NOT call `scheduleRefit`/
 * `scheduleInitialFit` — trusts the `node.size` litegraph already restored
 * (mirrors `js/anima_prompt/anima_prompt_studio/index.js`'s `restoreNode`).
 */
function restoreNode(node) {
  const refs = mountUI(node);
  const regionsWidget = findWidget(node, REGIONS_WIDGET_NAME);
  node.properties = node.properties || {};
  const parsed = parseRegions(regionsWidget && regionsWidget.value);
  node.properties.regions = parsed;
  refs.activeId = null;
  renderAll(node, refs);
}

app.registerExtension({
  name: "webtoon.anima_region_mask_editor",

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
      // else runs — see `js/anima_prompt/anima_prompt_studio/index.js`'s identical
      // pattern for why the ordering matters (the still-pending
      // initial-fit rAF queued back in onNodeCreated must see this flag by
      // the time it fires).
      this._armConfigured = true;
      const result = originalOnConfigure ? originalOnConfigure.apply(this, args) : undefined;
      restoreNode(this);
      return result;
    };

    const originalOnRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      if (this._armRefs) {
        unwireInteractions(this._armRefs);
      }
      return originalOnRemoved ? originalOnRemoved.apply(this, args) : undefined;
    };
  },
});
