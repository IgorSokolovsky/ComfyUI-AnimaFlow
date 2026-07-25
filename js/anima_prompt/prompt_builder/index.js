import { app } from "/scripts/app.js";
import { findStateWidget, restoreStateFromWidget } from "./core.mjs";
import {
  injectStyles,
  buildRoot,
  rebuildFields,
  measureMinHeight,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import { wireInteractions } from "./interaction.mjs";

const NODE_CLASS_NAME = "PromptBuilder";
const TEMPLATE_WIDGET_NAME = "template";

function findTemplateWidget(node) {
  return (node.widgets || []).find((w) => w.name === TEMPLATE_WIDGET_NAME);
}

/**
 * Hide the default canvas-drawn `template` widget without touching its
 * value/serialization: the DOM textarea (mirrored into `widget.value` on
 * every edit) is the only thing the user sees, but the widget itself still
 * serializes normally so the backend keeps receiving `template` exactly as
 * before.
 */
function hideTemplateWidget(templateWidget) {
  if (!templateWidget) {
    return;
  }
  templateWidget.hidden = true;
  templateWidget.computeSize = () => [0, -4];
  if (templateWidget.inputEl && templateWidget.inputEl.style) {
    templateWidget.inputEl.style.display = "none";
  }
}

/**
 * Hide the default canvas-drawn `prompt_builder_state` widget the exact same
 * way as `template` above: it stays a real, declared, natively-serialized
 * `required` STRING widget (see `nodes/node_prompt_builder.py`) — this only
 * hides its on-canvas presentation. Deliberately does NOT set
 * `serialize = false` anywhere (that would be the same bug all over again —
 * it MUST keep serializing into `widgets_values` for the backend to receive
 * it). `render.mjs`'s `syncStateWidget` (called after every mutation of
 * `node.properties.promptBuilderState`) is what keeps this widget's value in
 * sync with the live state; this function only ever touches its visibility.
 */
function hideStateWidget(stateWidget) {
  if (!stateWidget) {
    return;
  }
  stateWidget.hidden = true;
  stateWidget.computeSize = () => [0, -4];
  if (stateWidget.inputEl && stateWidget.inputEl.style) {
    stateWidget.inputEl.style.display = "none";
  }
}

/**
 * Build (or, if already built, return) the node's DOM UI refs. Mounts one
 * `addDOMWidget` containing the whole styled UI (TEMPLATE / FIELDS /
 * LIVE PREVIEW), matching `playground/prompt_builder.html`.
 */
function mountUI(node) {
  if (node._promptBuilderRefs) {
    return node._promptBuilderRefs;
  }

  const templateWidget = findTemplateWidget(node);
  hideTemplateWidget(templateWidget);

  const stateWidget = findStateWidget(node);
  hideStateWidget(stateWidget);
  // Parse whatever the (now-hidden) prompt_builder_state widget already
  // carries — a freshly-created node's widget just holds the INPUT_TYPES
  // `"{}"` default — into node.properties.promptBuilderState, guarded
  // against malformed JSON (see core.mjs's doc comment). This mount-time
  // call is the "on mount" restore point; `restoreNode` below (the
  // "onConfigure" restore point) calls it again once LiteGraph has actually
  // restored the widget's saved value.
  restoreStateFromWidget(node);

  injectStyles(typeof document !== "undefined" ? document : undefined);

  const doc = typeof document !== "undefined" ? document : undefined;
  const refs = buildRoot(doc);
  refs.templateWidget = templateWidget;
  refs.templateEl.value = (templateWidget && templateWidget.value) || "";
  refs.stateWidget = stateWidget;

  let widget;
  if (typeof node.addDOMWidget === "function") {
    // Sizing hooks (ComfyUI-Pixaroma `find_replace` mechanism exactly — see
    // render.mjs's module header). `getMinHeight` is the LEGACY litegraph
    // canvas renderer's own widget-sizing hook (the user's actual host) —
    // NOT `computeSize`/`getHeight`, which this widget deliberately does
    // NOT define, letting litegraph's default DOM-widget sizing (which
    // honors `getMinHeight` and otherwise follows the node's own width)
    // drive both dimensions. `serialize: false` keeps this UI-only widget
    // out of `widgets_values` (the real `template`/`prompt_builder_state`
    // persistence goes through those two hidden canvas widgets, not this
    // one — see `hideTemplateWidget`/`hideStateWidget` above).
    widget = node.addDOMWidget("wpb_ui", "wpb_ui", refs.root, {
      serialize: false,
      getMinHeight: () => measureMinHeight(refs.root),
    });
  } else {
    // Defensive fallback for a host without `addDOMWidget`; keeps node
    // setup from hard-crashing even though this shouldn't occur in
    // ComfyUI's actual runtime.
    widget = { name: "wpb_ui", type: "wpb_ui", element: refs.root };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }
  widget.serialize = false;
  if (widget.options) {
    widget.options.serialize = false;
  }
  // Nodes 2.0 only: `minWidth: 1` frees the width from this widget's own
  // opinion (letting the node's own width drive it), `minHeight` is the
  // measured content-floor straight from the DOM (see `measureMinHeight`).
  widget.computeLayoutSize = function () {
    return { minHeight: measureMinHeight(refs.root), minWidth: 1 };
  };
  refs.widget = widget;

  node._promptBuilderRefs = refs;

  wireInteractions(node, refs);
  // `rebuildFields` schedules the node's initial measured refit itself on
  // this first call (see its `isFirstBuild` handling in render.mjs) via the
  // GUARDED `scheduleInitialFit` — no synchronous setSize here, and no
  // resize at all if this turns out to be a node being loaded from a saved
  // workflow (see `_pbConfigured`, set by the `onConfigure` wrap below).
  rebuildFields(node, refs);

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }

  return refs;
}

function setupNode(node) {
  const refs = mountUI(node);
  // First-time-only floor: bump a freshly-created node up to the sane
  // defaults (never shrinks an already-larger node — e.g. one loaded from a
  // workflow that hasn't reached `onConfigure` yet, though litegraph's own
  // `configure()` overwrites `node.size` from the saved workflow right after
  // this runs anyway, before `onConfigure` fires). Guarded by
  // `_pbBootstrapped` — a SEPARATE flag from `_pbConfigured` below: this one
  // just needs "have I already bumped this node once", regardless of
  // load/fresh status, so it must never be reused as the "was this node
  // loaded from a workflow" signal `scheduleInitialFit` depends on.
  if (!node._pbBootstrapped) {
    node._pbBootstrapped = true;
    node.size = node.size || [0, 0];
    node.size[0] = Math.max(node.size[0] || 0, DEFAULT_W);
    node.size[1] = Math.max(node.size[1] || 0, DEFAULT_H);
    if (typeof node.setSize === "function") {
      node.setSize([node.size[0], node.size[1]]);
    }
  }
  // No explicit refit call here — `mountUI`'s `rebuildFields` call above
  // already scheduled the (guarded) initial fit exactly once. Calling
  // `scheduleRefit` (unconditional) here as well used to be what clobbered a
  // loaded node's restored size: its rAF fires AFTER `onConfigure` has set
  // `_pbConfigured` and litegraph has restored `node.size`, but being
  // unconditional it resized anyway.
}

/**
 * Restore the DOM UI after `onConfigure` has restored `node.properties` AND
 * `widgets_values` (including the `template` AND `prompt_builder_state`
 * widgets' values, AND `node.size` itself) from a saved workflow:
 * re-parse `node.properties.promptBuilderState` from the now-restored
 * `prompt_builder_state` widget (`restoreStateFromWidget` — this is the
 * actual persistence source of truth; see its doc comment in `core.mjs`),
 * sync the DOM textarea from the now-restored `template` widget, then
 * rebuild FIELDS rows from the freshly-restored state. Passes
 * `{ silent: true }` to `rebuildFields` so this NEVER schedules a refit —
 * even if the restored template's token set differs from whatever
 * `onNodeCreated` originally built rows for (a "structural change" by
 * `rebuildFields`'s own logic) — trusting the `node.size` litegraph already
 * restored (Vue Compat #18 / false-dirty-on-load guard). `node._pbConfigured`
 * (set by the `onConfigure` wrap, BEFORE this function runs) is what makes
 * the still-pending initial `scheduleInitialFit` rAF (queued back in
 * `onNodeCreated`, which always runs before `onConfigure`) a no-op once it
 * fires.
 */
function restoreNode(node) {
  restoreStateFromWidget(node);
  const refs = mountUI(node);
  const templateWidget = findTemplateWidget(node);
  refs.templateWidget = templateWidget;
  refs.templateEl.value = (templateWidget && templateWidget.value) || "";
  const stateWidget = findStateWidget(node);
  refs.stateWidget = stateWidget;
  rebuildFields(node, refs, { silent: true });
}

app.registerExtension({
  name: "webtoon.prompt_builder",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_CLASS_NAME) {
      return;
    }

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated
        ? originalOnNodeCreated.apply(this, args)
        : undefined;
      setupNode(this);
      return result;
    };

    const originalOnConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      // Mark this node as loaded-from-a-workflow FIRST, before anything
      // else runs — including the original `onConfigure` — so the
      // still-pending `scheduleInitialFit` rAF queued back in
      // `onNodeCreated` (which always fires before `onConfigure`) sees the
      // flag set by the time it actually runs and skips resizing.
      this._pbConfigured = true;
      const result = originalOnConfigure
        ? originalOnConfigure.apply(this, args)
        : undefined;
      restoreNode(this);
      return result;
    };
  },
});
