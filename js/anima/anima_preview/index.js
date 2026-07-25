/**
 * index.js — Anima Preview node frontend extension.
 *
 * Registers a SINGLE websocket listener (in `setup()`, not per-node — mirrors
 * the reference pack's `extension_runtime.js`: `api.addEventListener(GENERATOR
 * _PREVIEW_EVENT, handlePreviewEvent)`) for the `"webtoon-anima-preview"`
 * event `nodes/_anima_preview_channel.broadcast_preview` sends, and fans each
 * incoming frame out to every mounted AnimaPreview node instance whose
 * `channel` widget currently matches (`core.mjs`'s `matchingPreviewEntries`) —
 * so any number of AnimaPreview nodes can watch the same channel, or none at
 * all, entirely independent of the graph's wiring.
 *
 * Absolute `/scripts/app.js` + `/scripts/api.js` imports (this file lives in
 * a subfolder of WEB_DIRECTORY — see the frontend skill's absolute-import
 * gotcha).
 */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import {
  DEFAULT_CHANNEL,
  pushFrame,
  registerPreviewEntry,
  unregisterPreviewEntry,
  matchingPreviewEntries,
  getRegisteredPreviewEntries,
} from "./core.mjs";
import {
  injectStyles,
  buildRoot,
  renderActiveFrame,
  renderThumbs,
  applyZoom,
  measureMinHeight,
  scheduleInitialFit,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import { wireInteractions, mirrorChannelToWidget, selectHistoryIndex } from "./interaction.mjs";

const NODE_CLASS_NAME = "AnimaPreview";
const CHANNEL_WIDGET_NAME = "channel";
// Must match `nodes/_anima_preview_channel.PREVIEW_EVENT` exactly — this
// pack's own namespace, deliberately distinct from the EasyUseAnima
// reference pack's `"easyuse-anima-aio-preview"` so both can coexist.
const PREVIEW_EVENT = "webtoon-anima-preview";

function findChannelWidget(node) {
  return (node.widgets || []).find((w) => w.name === CHANNEL_WIDGET_NAME);
}

/** Hide the native canvas-drawn `channel` widget without touching its
 * value/serialization — the styled DOM input is the only thing the user
 * sees, mirrored into the widget on every edit (see
 * `interaction.mjs`'s `mirrorChannelToWidget`), same pattern as
 * `js/anima_prompt/prompt_combiner`'s TEMPLATE widget. */
function hideChannelWidget(channelWidget) {
  if (!channelWidget) {
    return;
  }
  channelWidget.hidden = true;
  channelWidget.computeSize = () => [0, -4];
  if (channelWidget.inputEl && channelWidget.inputEl.style) {
    channelWidget.inputEl.style.display = "none";
  }
}

function mountUI(node) {
  if (node._animaPreviewRefs) {
    return node._animaPreviewRefs;
  }

  const channelWidget = findChannelWidget(node);
  hideChannelWidget(channelWidget);

  injectStyles(typeof document !== "undefined" ? document : undefined);

  const doc = typeof document !== "undefined" ? document : undefined;
  const refs = buildRoot(doc);
  refs.channelWidget = channelWidget;
  refs.channelInput.value = (channelWidget && channelWidget.value) || DEFAULT_CHANNEL;

  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("wap_ui", "wap_ui", refs.root, {
      serialize: false,
      // Legacy canvas renderer sizing path (PRIMARY) — see render.mjs's doc
      // comment. NOT computeSize/getHeight.
      getMinHeight: () => measureMinHeight(refs.root),
    });
  } else {
    widget = { name: "wap_ui", type: "wap_ui", element: refs.root };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }
  widget.serialize = false;
  if (widget.options) {
    widget.options.serialize = false;
  }
  // Nodes 2.0 (Vue/DOM renderer) sizing path — forward-compat only, see
  // render.mjs's doc comment. minWidth: 1 so width stays the user's to set.
  widget.computeLayoutSize = function () {
    return { minHeight: measureMinHeight(refs.root), minWidth: 1 };
  };
  refs.widget = widget;

  node._animaPreviewRefs = refs;

  wireInteractions(node, refs);
  renderActiveFrame(refs, null);
  applyZoom(refs);

  registerPreviewEntry({
    node,
    refs,
    getChannel: () => refs.channelInput.value,
  });

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }

  return refs;
}

function ensureInitialFloor(node) {
  if (node._apConfigured) {
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

function setupNode(node) {
  const refs = mountUI(node);
  ensureInitialFloor(node);
  scheduleInitialFit(node, refs.root);
}

function restoreNode(node) {
  const refs = mountUI(node);
  const channelWidget = findChannelWidget(node);
  refs.channelWidget = channelWidget;
  refs.channelInput.value = (channelWidget && channelWidget.value) || DEFAULT_CHANNEL;
  mirrorChannelToWidget(refs);
}

/** Handle one incoming `{channel, stage_label, image_data}` frame: fan out
 * to every currently-registered AnimaPreview node whose channel matches
 * (case/whitespace-normalized the same way the backend normalizes a blank
 * `preview_channel`), push it into that node's small recent-frames history,
 * and repaint (main viewer + thumbnail strip) WITHOUT resizing the node. */
function handlePreviewEvent(event) {
  const detail = event && event.detail;
  if (!detail || typeof detail.image_data !== "string" || !detail.image_data) {
    return;
  }
  const frame = { stageLabel: detail.stage_label || "", imageData: detail.image_data };
  const entries = matchingPreviewEntries(detail.channel);
  entries.forEach(({ refs }) => {
    refs.history = pushFrame(refs.history, frame);
    refs.activeIndex = refs.history.length - 1;
    renderActiveFrame(refs, frame);
    renderThumbs(refs, refs.history, refs.activeIndex, (index) => selectHistoryIndex(refs, index));
  });
}

let apiListenerAttached = false;

app.registerExtension({
  name: "webtoon.anima_preview",

  async setup() {
    if (apiListenerAttached) {
      return;
    }
    apiListenerAttached = true;
    api.addEventListener(PREVIEW_EVENT, handlePreviewEvent);
  },

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
      // Set BEFORE the original onConfigure/restoreNode run, so the
      // still-pending initial-fit rAF queued back in onNodeCreated (which
      // always fires first) sees this flag and skips resizing.
      this._apConfigured = true;
      const result = originalOnConfigure ? originalOnConfigure.apply(this, args) : undefined;
      restoreNode(this);
      return result;
    };

    const originalOnRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      // Set.delete needs the SAME object reference that was registered
      // (mountUI's `registerPreviewEntry` call) — that object isn't kept
      // around anywhere else, so scrub the registry by node identity
      // instead of trying to reconstruct an equal entry here.
      for (const entry of getRegisteredPreviewEntries()) {
        if (entry.node === this) {
          unregisterPreviewEntry(entry);
        }
      }
      return originalOnRemoved ? originalOnRemoved.apply(this, args) : undefined;
    };
  },
});
