import { app } from "/scripts/app.js";
import {
  ensureState,
  restoreFromProperties,
  syncStateFromInputs,
  shouldSeedDefaultInputs,
  DEFAULT_TEMPLATE,
} from "./core.mjs";
import {
  injectStyles,
  buildRoot,
  rebuildInputsList,
  updateConnectionStatuses,
  renderLivePreview,
  measureMinHeight,
  scheduleRefit,
  scheduleInitialFit,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import {
  wireInteractions,
  mirrorTemplateToWidget,
  reconcileInputsFromTemplate,
} from "./interaction.mjs";

const NODE_CLASS_NAME = "PromptCombiner";
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
 * Floor a freshly-created node's size UP to `[DEFAULT_W, DEFAULT_H]` (never
 * down) exactly once, before the content-aware `scheduleInitialFit` gets a
 * chance to measure real content. Guarded by `node._pcConfigured` — set
 * `true` at the very start of the `onConfigure` wrap, BEFORE the original
 * `onConfigure`/`restoreNode` run — so a node being loaded from a saved
 * workflow never has its restored size clobbered: `onNodeCreated` always
 * fires before `onConfigure`, but litegraph's own restoration of `node.size`
 * from the serialized workflow happens as part of `configure()`, AFTER this
 * floor runs and BEFORE our `onConfigure` hook body executes, so the floor's
 * effect on a loaded node is moot; this guard is a defensive backstop
 * against any re-entry after that point.
 */
function ensureInitialFloor(node) {
  if (node._pcConfigured) {
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
 * Defer seeding the default TEMPLATE (`"{character}, {background}"`) to a
 * later tick (a `requestAnimationFrame`, falling back to `setTimeout(0)`),
 * and only actually seed if `node.inputs` is STILL empty at that point (see
 * `core.mjs`'s `shouldSeedDefaultInputs` for why the deferred re-check
 * matters: `onNodeCreated`, which schedules this, fires BEFORE litegraph
 * restores a saved workflow's input slots onto `node.inputs`).
 *
 * Fix B: this does NOT call `addInput` for `character`/`background`
 * directly — it sets the DOM textarea's value to `DEFAULT_TEMPLATE` and
 * lets `reconcileInputsFromTemplate` create the matching sockets, so the
 * template stays the single source of truth even for the initial seed.
 */
function scheduleDefaultTemplateSeed(node) {
  function runSeed() {
    if (!shouldSeedDefaultInputs(node)) {
      return;
    }
    const refs = node._promptCombinerRefs;
    if (!refs) {
      return;
    }
    refs.templateEl.value = DEFAULT_TEMPLATE;
    mirrorTemplateToWidget(refs);
    reconcileInputsFromTemplate(node, refs);
  }

  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(runSeed);
  } else if (typeof setTimeout === "function") {
    setTimeout(runSeed, 0);
  } else {
    runSeed();
  }
}

/**
 * Build (or, if already built, return) the node's DOM UI refs. Mounts one
 * `addDOMWidget` containing the whole styled UI (TEMPLATE / INPUTS /
 * LIVE PREVIEW).
 *
 * The widget reports its size to LiteGraph through BOTH renderer paths (see
 * `render.mjs`'s ComfyUI-Pixaroma-mechanism doc comment):
 *   - `getMinHeight` (an `addDOMWidget` option, NOT `computeSize`/
 *     `getHeight`) — the LEGACY canvas renderer's path, and the PRIMARY one
 *     this build targets. Reports `measureMinHeight(refs.root)` — the fixed
 *     sections' real height plus the LIVE PREVIEW's small `PREVIEW_MIN`
 *     floor (never the preview's own, open-ended `offsetHeight`, or a long
 *     combined result would clip the node's bottom AND self-inflate the
 *     floor it's being measured against).
 *   - `computeLayoutSize` — the Nodes 2.0 Vue/DOM renderer's path, kept for
 *     forward compatibility only; `minWidth: 1` lets that renderer size
 *     width independently rather than pinning it to the measured content.
 * Neither path itself calls `setSize` — the actual resize-to-fit-content
 * happens exclusively via `scheduleRefit`, wired at the explicit structural
 * triggers below (first build, an INPUTS add/remove, `onConfigure` restore,
 * a changed `onExecuted` LIVE PREVIEW).
 */
function mountUI(node) {
  if (node._promptCombinerRefs) {
    return node._promptCombinerRefs;
  }

  const templateWidget = findTemplateWidget(node);
  hideTemplateWidget(templateWidget);

  injectStyles(typeof document !== "undefined" ? document : undefined);

  const doc = typeof document !== "undefined" ? document : undefined;
  const refs = buildRoot(doc);
  refs.templateWidget = templateWidget;
  refs.templateEl.value = (templateWidget && templateWidget.value) || "";

  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("wpc_ui", "wpc_ui", refs.root, {
      serialize: false,
      // Legacy canvas renderer sizing path (PRIMARY) — see the function doc
      // above. NOT `computeSize`/`getHeight`: those fight `node.setSize`'s
      // own clamp-to-minimum under the legacy renderer, which is what used
      // to under-calculate the floor and clip the node's bottom.
      getMinHeight: () => measureMinHeight(refs.root),
    });
  } else {
    // Defensive fallback for a host without `addDOMWidget`; keeps node
    // setup from hard-crashing even though this shouldn't occur in
    // ComfyUI's actual runtime.
    widget = { name: "wpc_ui", type: "wpc_ui", element: refs.root };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }
  widget.serialize = false;
  if (widget.options) {
    widget.options.serialize = false;
  }

  // Nodes 2.0 (Vue/DOM renderer) sizing path — see the function doc above.
  widget.computeLayoutSize = function () {
    return { minHeight: measureMinHeight(refs.root), minWidth: 1 };
  };
  refs.widget = widget;

  node._promptCombinerRefs = refs;

  wireInteractions(node, refs);
  rebuildInputsList(node, refs, refs._handleRemove);
  // Re-apply whatever LIVE PREVIEW state already exists on this node
  // instance (the last executed result, if any survived a redraw/re-mount
  // within the session; otherwise the placeholder `rebuildInputsList` just
  // rendered).
  renderLivePreview(refs, node._promptCombinerLastResult);

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }

  return refs;
}

function setupNode(node) {
  ensureState(node);
  const refs = mountUI(node);
  ensureInitialFloor(node);
  // GUARDED initial fit — a no-op if this turns out to be a node being
  // loaded from a saved workflow (see `scheduleInitialFit`'s doc comment):
  // by the time its rAF fires, `onConfigure` has already set
  // `node._pcConfigured` and litegraph has already restored `node.size`, so
  // this correctly does nothing instead of clobbering the restored size. A
  // genuinely fresh node still gets sized to its (usually minimal) initial
  // content, same as before.
  scheduleInitialFit(node, refs.root);
  // Deferred, not synchronous: see `scheduleDefaultTemplateSeed`'s doc
  // comment for why seeding here (before litegraph has restored a saved
  // workflow's inputs) would risk duplicate slots on load.
  scheduleDefaultTemplateSeed(node);
}

/**
 * Restore the DOM UI after `onConfigure` has restored `node.properties` AND
 * `node.inputs` (litegraph restores real input slots from the saved
 * workflow before calling the `onConfigure` hook, the same way it restores
 * `widgets_values` for the `template` widget, AND `node.size` itself) from a
 * saved workflow: sync `properties.combinerState` from the now-restored
 * `node.inputs`, sync the DOM textarea from the now-restored `template`
 * widget, then reconcile (idempotent — the restored inputs already match the
 * restored template's tokens, so this is a no-op add/remove-wise, just
 * guards against any mismatch — `changed` stays `false`, so it schedules no
 * refit) and refresh the INPUTS rows. Deliberately does NOT call
 * `scheduleRefit` itself — trusts the `node.size` litegraph already restored
 * (Vue Compat #18 / false-dirty-on-load guard). `node._pcConfigured` (set by
 * the `onConfigure` wrap BEFORE this function runs) is what makes the
 * still-pending initial `scheduleInitialFit` rAF (queued back in
 * `onNodeCreated`, which always runs before `onConfigure`) a no-op once it
 * fires.
 */
function restoreNode(node) {
  restoreFromProperties(node);
  syncStateFromInputs(node);
  const refs = mountUI(node);
  const templateWidget = findTemplateWidget(node);
  refs.templateWidget = templateWidget;
  refs.templateEl.value = (templateWidget && templateWidget.value) || "";
  reconcileInputsFromTemplate(node, refs);
  rebuildInputsList(node, refs, refs._handleRemove);
}

app.registerExtension({
  name: "webtoon.prompt_combiner",

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
      this._pcConfigured = true;
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
      const refs = this._promptCombinerRefs;
      if (refs) {
        // A link connected/disconnected: refresh status dots + re-apply the
        // current LIVE PREVIEW only — no row add/remove, no refit.
        updateConnectionStatuses(this, refs);
      }
      return result;
    };

    // The backend returns `{"ui": {"text": [structured_str]}, "result":
    // (...)}` on every run (see `nodes/node_prompt_combiner.py`'s
    // `combine`) — the node's primary output is labeled PROSE, one
    // `"<Label>: <value>"` line per non-empty variable (`build_field_text`;
    // a JSON `{token: value}` document was tried first but proved noisy for
    // a Qwen-style text encoder). That `message.text` array is the ONLY
    // place the real result is ever available to the frontend (input values
    // arrive over connection wires only at execution time, so the browser
    // cannot compute this itself). Store it on the node so it survives
    // redraws/re-mounts within the session, then push it into the LIVE
    // PREVIEW — and, if the text actually changed, schedule a refit (the
    // preview's new content may need more or less room).
    const originalOnExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = originalOnExecuted ? originalOnExecuted.apply(this, arguments) : undefined;
      const text =
        message && Array.isArray(message.text) ? message.text.join("") : undefined;
      if (typeof text === "string") {
        const changed = text !== this._promptCombinerLastResult;
        this._promptCombinerLastResult = text;
        const refs = this._promptCombinerRefs;
        if (refs) {
          renderLivePreview(refs, text);
          if (changed) {
            scheduleRefit(this, refs.root);
          }
        }
      }
      return result;
    };
  },
});
