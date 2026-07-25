import { app } from "/scripts/app.js";
import { findStateWidget, loadStateFromWidget } from "./core.mjs";
import {
  injectStyles,
  buildRoot,
  rebuildFields,
  rebuildBackgrounds,
  rebuildCharacters,
  refreshConnectionDots,
  refreshOutfitWireState,
  refreshIdentityHints,
  renderLivePreview,
  measureMinHeight,
  scheduleRefit,
  scheduleInitialFit,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import { wireInteractions, syncAllSockets } from "./interaction.mjs";

const NODE_CLASS_NAME = "SceneCreator";
const TEMPLATE_WIDGET_NAME = "template";

function findTemplateWidget(node) {
  return (node.widgets || []).find((w) => w.name === TEMPLATE_WIDGET_NAME);
}

/**
 * Hide the default canvas-drawn `template` widget without touching its
 * value/serialization: the DOM textarea (mirrored into `widget.value` on
 * every edit) is the only thing the user sees, but the widget itself still
 * serializes normally so the backend keeps receiving `template` exactly as
 * before (see `js/prompt_builder/index.js` / `js/prompt_combiner/index.js`
 * for the identical pattern).
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
 * Hide the default canvas-drawn `scene_state` widget the SAME way as
 * `template` above: the frontend never displays it (its JSON is only ever
 * written by `core.mjs`'s `syncStateWidget`, called after every
 * `node.properties.sceneState` mutation), but it stays a normal,
 * natively-serialized required widget — NEVER `serialize = false` — so its
 * `.value` reaches the backend on every run exactly like `template` does.
 * This REPLACES the old hidden-INPUT + `app.graphToPrompt` injection, which
 * did not reliably deliver `scene_state` to the backend.
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
 * `addDOMWidget` containing the whole styled UI (TEMPLATE / SCENE FIELDS /
 * BACKGROUNDS / CHARACTERS / LIVE PREVIEW), matching
 * `playground/scene_creator.html`.
 *
 * The widget reports its size to LiteGraph through BOTH renderer paths (see
 * `render.mjs`'s ComfyUI-Pixaroma-mechanism doc comment): the legacy
 * `getMinHeight` option (PRIMARY — the user's actual host) and the Nodes 2.0
 * `computeLayoutSize` hook (`minWidth: 1`, forward-compat only). Neither path
 * itself calls `setSize` — the actual resize-to-fit-content happens
 * exclusively via `scheduleRefit`, wired at the explicit structural triggers
 * below (first build, a SCENE FIELD/BACKGROUND/CHARACTER/OUTFIT add/remove,
 * `onConfigure` restore, a changed `onExecuted` LIVE PREVIEW).
 */
function mountUI(node) {
  if (node._sceneCreatorRefs) {
    return node._sceneCreatorRefs;
  }

  const templateWidget = findTemplateWidget(node);
  hideTemplateWidget(templateWidget);
  hideStateWidget(findStateWidget(node));

  injectStyles(typeof document !== "undefined" ? document : undefined);

  const doc = typeof document !== "undefined" ? document : undefined;
  const refs = buildRoot(doc);
  refs.templateWidget = templateWidget;
  refs.templateEl.value = (templateWidget && templateWidget.value) || "";

  let widget;
  if (typeof node.addDOMWidget === "function") {
    // Legacy canvas renderer sizing path (PRIMARY) — NOT `computeSize`/
    // `getHeight`, which fight `node.setSize` under the legacy renderer.
    widget = node.addDOMWidget("wsc_ui", "wsc_ui", refs.root, {
      serialize: false,
      getMinHeight: () => measureMinHeight(refs.root),
    });
  } else {
    // Defensive fallback for a host without `addDOMWidget`.
    widget = { name: "wsc_ui", type: "wsc_ui", element: refs.root };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }
  widget.serialize = false;
  if (widget.options) {
    widget.options.serialize = false;
  }
  // Nodes 2.0 (Vue/DOM renderer) sizing path.
  widget.computeLayoutSize = function () {
    return { minHeight: measureMinHeight(refs.root), minWidth: 1 };
  };
  refs.widget = widget;

  node._sceneCreatorRefs = refs;

  wireInteractions(node, refs);
  // `rebuildFields` schedules the node's initial measured refit itself on
  // this first call via the GUARDED `scheduleInitialFit` (see its
  // `isFirstBuild` handling in render.mjs) — a no-op if this turns out to be
  // a node being loaded from a saved workflow (see `_scConfigured`, set by
  // the `onConfigure` wrap below). `rebuildBackgrounds`/`rebuildCharacters`
  // never resize themselves (only the explicit add/remove/outfit actions in
  // `interaction.mjs` do), so calling them here for the first time is safe
  // regardless of load/fresh status.
  rebuildFields(node, refs);
  rebuildBackgrounds(node, refs, refs._backgroundHandlers);
  rebuildCharacters(node, refs, refs._characterHandlers);
  // Each rebuild* call above already refreshed the LIVE PREVIEW with the
  // CLIENT-SIDE computed scene JSON (`updateComputedPreview`, in
  // render.mjs). If this node instance already has a REAL executed result
  // (survived a redraw/re-mount within the session), that's still the
  // authoritative preview — re-apply it, overriding the just-computed one.
  if (typeof node._sceneCreatorLastResult === "string") {
    renderLivePreview(refs, node._sceneCreatorLastResult);
  }

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }

  return refs;
}

function setupNode(node) {
  // Parse the `scene_state` widget's value (default `"{}"` on a genuinely
  // fresh node) into `node.properties.sceneState` BEFORE mounting the UI, so
  // `rebuildFields`/`rebuildBackgrounds`/`rebuildCharacters` build from it.
  loadStateFromWidget(node);
  const refs = mountUI(node);
  // First-time-only floor: bump a freshly-created node up to the sane
  // defaults (never shrinks an already-larger node). Guarded by
  // `_scBootstrapped` — a SEPARATE flag from `_scConfigured` below: this one
  // just needs "have I already bumped this node once", regardless of
  // load/fresh status, so it must never be reused as the "was this node
  // loaded from a workflow" signal `scheduleInitialFit` depends on.
  if (!node._scBootstrapped) {
    node._scBootstrapped = true;
    node.size = node.size || [0, 0];
    node.size[0] = Math.max(node.size[0] || 0, DEFAULT_W);
    node.size[1] = Math.max(node.size[1] || 0, DEFAULT_H);
    if (typeof node.setSize === "function") {
      node.setSize([node.size[0], node.size[1]]);
    }
  }
  // No explicit refit call here — `mountUI`'s `rebuildFields` call already
  // scheduled the (guarded) initial fit exactly once. An unconditional
  // `scheduleRefit` here (the old behavior) was what clobbered a loaded
  // node's restored size: its rAF fires AFTER `onConfigure` has set
  // `_scConfigured` and litegraph has restored `node.size`, but being
  // unconditional it resized anyway.
}

/**
 * Restore the DOM UI after `onConfigure` has restored `node.widgets_values`
 * (so the `scene_state` widget's `.value` already holds the saved JSON —
 * litegraph restores widget values, real input slots, AND `node.size` itself
 * before calling the `onConfigure` hook): parse `sceneState` back out of the
 * restored `scene_state` widget (`loadStateFromWidget` — the same mechanism
 * `template` already uses for its own restore), sync the DOM textarea from
 * the now-restored `template` widget, defensively re-add any missing
 * character/outfit/background input sockets (idempotent, via
 * `syncAllSockets`), then rebuild SCENE FIELDS + BACKGROUNDS + CHARACTERS
 * and re-apply the last LIVE PREVIEW. Passes `{ silent: true }` to
 * `rebuildFields` and never calls `scheduleRefit` itself (neither directly
 * nor via `rebuildBackgrounds`/`rebuildCharacters`, which never resize on
 * their own) — trusts the `node.size` litegraph already restored (Vue
 * Compat #18 / false-dirty-on-load guard). `node._scConfigured` (set by the
 * `onConfigure` wrap BEFORE this function runs) is what makes the
 * still-pending initial `scheduleInitialFit` rAF (queued back in
 * `onNodeCreated`, which always runs before `onConfigure`) a no-op once it
 * fires.
 */
function restoreNode(node) {
  loadStateFromWidget(node);
  const refs = mountUI(node);
  const templateWidget = findTemplateWidget(node);
  refs.templateWidget = templateWidget;
  refs.templateEl.value = (templateWidget && templateWidget.value) || "";
  syncAllSockets(node);
  rebuildFields(node, refs, { silent: true });
  rebuildBackgrounds(node, refs, refs._backgroundHandlers);
  rebuildCharacters(node, refs, refs._characterHandlers);
  // As in mountUI: each rebuild* call above already refreshed the LIVE
  // PREVIEW with the freshly-restored state's CLIENT-SIDE computed scene
  // JSON; re-apply the REAL executed result instead, if this node instance
  // still has one from earlier in the session.
  if (typeof node._sceneCreatorLastResult === "string") {
    renderLivePreview(refs, node._sceneCreatorLastResult);
  }
}

app.registerExtension({
  name: "webtoon.scene_creator",

  // NOTE: no `setup()`/`app.graphToPrompt` wrap here (deliberately removed).
  // `scene_state` is now a normal, natively-serialized required STRING
  // widget (see `nodes/node_scene_creator.py`'s `INPUT_TYPES`) that the
  // frontend hides but keeps in sync via `core.mjs`'s `syncStateWidget` —
  // litegraph delivers a serialized widget's `.value` to the backend on its
  // own on every run, exactly like the `template` widget already does. The
  // old hidden-INPUT + `graphToPrompt`-injection path did not reliably
  // deliver `scene_state` in this ComfyUI and has been removed entirely.

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
      this._scConfigured = true;
      const result = originalOnConfigure
        ? originalOnConfigure.apply(this, args)
        : undefined;
      restoreNode(this);
      return result;
    };

    const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = originalOnConnectionsChange
        ? originalOnConnectionsChange.apply(this, args)
        : undefined;
      const refs = this._sceneCreatorRefs;
      if (refs) {
        // A link connected/disconnected: refresh CHARACTER/BACKGROUND
        // connection-status dots AND flip each outfit row between its text
        // input and its "🔗 wired" chip — no row add/remove, no rebuild, no
        // refit.
        refreshConnectionDots(this, refs);
        refreshOutfitWireState(this, refs);
      }
      return result;
    };

    // The backend returns `{"ui": {"text": [scene], "slots": {...}},
    // "result": (...)}` on every run (see `nodes/node_scene_creator.py`'s
    // `build`). `message.text` is the ONLY place the real rendered scene is
    // ever available to the frontend, and `message.slots` (socket name ->
    // resolved value) is the ONLY place a wired socket's actual value is
    // ever available to the frontend (character/background identity and a
    // wired outfit's override all arrive over connection wires only at
    // execution time). Store both on the node so they survive redraws/
    // re-mounts within the session, then push the scene text into the LIVE
    // PREVIEW (scheduling a refit if it changed) and refresh every wired
    // outfit's chip + every character/background's resolved-value hint from
    // the new slots.
    const originalOnExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = originalOnExecuted ? originalOnExecuted.apply(this, arguments) : undefined;
      const text =
        message && Array.isArray(message.text) ? message.text.join("") : undefined;
      this._sceneSlots = (message && message.slots) || {};
      const refs = this._sceneCreatorRefs;
      if (typeof text === "string") {
        const changed = text !== this._sceneCreatorLastResult;
        this._sceneCreatorLastResult = text;
        if (refs) {
          renderLivePreview(refs, text);
          if (changed) {
            scheduleRefit(this, refs.root);
          }
        }
      }
      if (refs) {
        refreshOutfitWireState(this, refs);
        refreshIdentityHints(this, refs);
      }
      return result;
    };
  },
});
