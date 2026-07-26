/**
 * index.js — registers the AnimaGenerator node's sectioned-panel frontend
 * extension.
 *
 * Absolute `/scripts/app.js` import (this file is nested in
 * `js/anima/anima_generator/` — the frontend skill's gotcha #1: a relative
 * `../../scripts/app.js` resolves wrong from a subfolder and silently kills
 * the whole extension).
 *
 * ## The critical architectural constraint (per the plan)
 *
 * `AnimaGenerator` (`nodes/anima/node_anima_generator.py`) is NEVER modified
 * by this build. Every one of its 33 real, natively-serialized widgets
 * (`core.mjs`'s `CARD_DEFS`/`getAllLayoutWidgetNames`) is HIDDEN for
 * rendering only (`hideWidget` in `interaction.mjs` — `hidden = true` +
 * `computeSize = () => [0, -4]` + hide `inputEl` if present) and re-presented
 * as a DOM control that reads its initial value from `w.value` and writes
 * back to `w.value` (plus calls `w.callback` if present) on every edit —
 * `w.serialize` is never touched, so saved workflows keep loading and
 * `generate()`'s own `IS_CHANGED`/execution semantics are completely
 * unaffected. No JSON-blob state widget is introduced anywhere in this
 * build. Sockets (`model`, `vae`, `clip`, `positive`, `negative`, `latent`,
 * `lora_stack`, `segs`, `detailer_hook`) are never touched at all — they
 * aren't widgets, so `hideLayoutWidgets` never looks for them (`CARD_DEFS`
 * doesn't name any of them).
 *
 * ## `positive_text`/`negative_text` stay native
 *
 * These two multiline STRING widgets are deliberately excluded from
 * `core.mjs`'s `CARD_DEFS` and left as ComfyUI's own native textarea
 * widgets, per the plan (tag autocomplete in `js/autocomplete/` attaches to
 * them by widget NAME, and re-hosting a textarea in DOM risks breaking
 * that attachment — see this build's report for the "still attaches"
 * confirmation). `repositionDomWidget` (in `interaction.mjs`) moves the
 * sectioned-panel DOM widget to just BEFORE them in `node.widgets`, so the
 * panel renders above the two textareas and they land at the bottom of the
 * node, as the plan asks.
 *
 * ## Resize: one fixed-size box that scrolls, not grow-to-fit
 *
 * This build replaced the earlier "grow/shrink the node to exactly fit its
 * content" model with upstream's model: `render.mjs`'s `.wtn-ag-box` always
 * fills whatever height the DOM widget is currently given and scrolls its
 * own content when that doesn't fit (see `render.mjs`'s top doc comment for
 * the full account, including why `height: 100%` on the root is correct
 * here — the ComfyUI-Pixaroma `note` node precedent). Concretely:
 *
 *   - Legacy `getMinHeight` (PRIMARY — this build targets the legacy
 *     litegraph renderer) + Nodes 2.0 `computeLayoutSize` (`minWidth: 1`,
 *     forward-compat only) both now report a FIXED floor
 *     (`render.mjs`'s `HEIGHT_MIN`), not a measurement of current content —
 *     the key semantic change from the previous revision's
 *     `measureMinHeight`. Neither path resizes the node itself; they only
 *     tell litegraph "never let this widget's box go below this height".
 *   - Nothing in this file (or `interaction.mjs`) schedules a resize as a
 *     *consequence* of an edit any more: collapsing/expanding a stage and
 *     switching the upscale backend only change what's inside the box's
 *     scroll region now. `render.mjs`'s `scheduleRefit`/`scheduleInitialFit`
 *     /`refitNode`/`setNodeHeight`/`measureMinHeight` were all removed
 *     entirely — there is no more auto-fit-to-content step anywhere in this
 *     node for them to serve.
 *   - `ensureInitialFloor` (below) still floors a freshly-created node to a
 *     sensible default size once, and the manual-drag width+height clamp
 *     (`createResizeClampHandler`, wired at the bottom of this file) still
 *     stops a user from dragging the node into an unusably small box — both
 *     are orthogonal to content height now (see `render.mjs`'s top doc
 *     comment for why they're the two things this build keeps).
 *
 * ## External-mutation resync (the gap this build's follow-up fix closes)
 *
 * Every DOM control here is mirrored FROM its native widget's value at
 * mount and at `onConfigure` restore (`refreshAllCards`) -- but a widget can
 * also be mutated by something other than this panel or a saved-workflow
 * load: the sharpest real example is `seed` after ComfyUI's own
 * `control_after_generate` (randomize/increment/decrement) rewrites it once
 * a queued prompt finishes, entirely outside this panel's own edit path.
 * Two per-node lifecycle hooks (`onNodeCreated`/`onConfigure`) can't catch
 * that -- it isn't tied to either. Instead, `setup()` below registers ONE
 * global `api` listener (mirrors this exact pack's own
 * `js/anima/anima_preview/index.js` precedent: a single `api.addEventListener`
 * fanning out to every mounted node instance, not a per-node hook) on
 * `execution_success`/`execution_error`/`execution_interrupted` -- the
 * "this queued prompt is over" signals (all three, not just success: the
 * widget mutation itself happens at QUEUE time via ComfyUI's own
 * `afterQueued` widget hook, before this node's own execution even starts,
 * so it's already landed by the time ANY of these three fire, regardless of
 * how the run itself turned out). Deliberately NOT `nodeType.prototype
 * .onExecuted`: `AnimaGenerator.generate()` (`nodes/anima/node_anima_generator.py`)
 * returns a plain tuple, never a `{"ui": ...}` dict, so ComfyUI's backend
 * never emits the per-node "executed" websocket message this node would
 * need for `onExecuted` to fire at all -- that hook would silently never
 * run here. `handleExternalExecutionEvent`/`findAnimaGeneratorNodes` below
 * are the only pieces of this fix coupled to a real `app`/`api` host;
 * the actual resync logic (`interaction.mjs`'s `refreshFieldValues`/
 * `resyncAllFromWidgets`) is plain, host-agnostic, and unit-tested in
 * `test_resize.mjs` without either.
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { getAllLayoutWidgetNames } from "./core.mjs";
import {
  injectStyles,
  buildRoot,
  HEIGHT_MIN,
  createResizeClampHandler,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import {
  hideLayoutWidgets,
  mountAllCards,
  refreshAllCards,
  repositionDomWidget,
  resyncAllFromWidgets,
} from "./interaction.mjs";
import { CARD_DEFS } from "./core.mjs";

const NODE_CLASS_NAME = "AnimaGenerator";
// "This queued prompt is over" signals -- see this file's top doc comment
// for why all three (not just success) matter and why this isn't
// `onExecuted`.
const RESYNC_EVENTS = Object.freeze(["execution_success", "execution_error", "execution_interrupted"]);

/** Floor a freshly-created node's size UP to `[DEFAULT_W, DEFAULT_H]` (never
 * down), guarded by `node._agConfigured` so a node being restored from a
 * saved workflow is never touched -- mirrors
 * `js/anima_prompt/anima_prompt_studio/index.js`'s `ensureInitialFloor` exactly. */
function ensureInitialFloor(node) {
  if (node._agConfigured) {
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
 * Build (or, if already built, return) the node's DOM UI refs: hides every
 * card-layout widget (`hideLayoutWidgets`), mounts one `addDOMWidget`
 * containing the sectioned panel, repositions it above the native
 * `positive_text`/`negative_text` textareas, and wires + renders every card
 * (`mountAllCards`).
 */
function mountUI(node) {
  if (node._agRefs) {
    return node._agRefs;
  }

  hideLayoutWidgets(node, getAllLayoutWidgetNames());

  injectStyles(typeof document !== "undefined" ? document : undefined);
  const doc = typeof document !== "undefined" ? document : undefined;
  const refs = buildRoot(doc, CARD_DEFS);
  node._agRefs = refs;

  mountAllCards(node, refs);

  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("ag_panel", "ag_panel", refs.root, {
      serialize: false,
      // Legacy canvas renderer sizing path (PRIMARY) -- NOT computeSize/
      // getHeight (those fight node.setSize under the legacy renderer). A
      // FIXED floor now (render.mjs's HEIGHT_MIN), not a content
      // measurement -- see this file's/render.mjs's top doc comments for
      // why that's the correct contract for a box that fills the widget's
      // height and scrolls internally.
      getMinHeight: () => HEIGHT_MIN,
    });
  } else {
    // Defensive fallback for a host without addDOMWidget; shouldn't occur
    // in ComfyUI's actual runtime.
    widget = { name: "ag_panel", type: "ag_panel", element: refs.root };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }
  widget.serialize = false;
  if (widget.options) {
    widget.options.serialize = false;
  }
  // Nodes 2.0 (Vue/DOM renderer) sizing path -- forward-compat only.
  widget.computeLayoutSize = function () {
    return { minHeight: HEIGHT_MIN, minWidth: 1 };
  };
  refs.widget = widget;

  repositionDomWidget(node, widget);

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }

  return refs;
}

function setupNode(node) {
  // No more scheduleInitialFit -- content scrolls inside a fixed-size box
  // now (see render.mjs's top doc comment), so a fresh node just gets
  // ensureInitialFloor's DEFAULT_W/DEFAULT_H floor; there is no
  // auto-fit-to-content pass left to (guardedly) run.
  mountUI(node);
  ensureInitialFloor(node);
}

/**
 * Restore the DOM UI after `onConfigure` has restored every card-layout
 * widget's REAL saved value and `node.size` from a saved workflow:
 * re-render every card's fields from those now-current widget values, which
 * also re-derives each optional card's open/closed state from its
 * just-restored `*_enabled` value (`refreshAllCards` -> `renderCard` ->
 * `setCardEnabledUI`) -- Enabled is the only source of truth for that now,
 * so there is no separate collapse-state property to restore. Never resizes
 * the node -- trusts the `node.size` litegraph already restored (mirrors
 * `js/anima_prompt/anima_prompt_studio/index.js`'s `restoreNode`); there is
 * no `scheduleRefit`/`scheduleInitialFit` left in this build to call even
 * if it wanted to (see `render.mjs`'s top doc comment for why they were
 * removed).
 */
function restoreNode(node) {
  const refs = mountUI(node);
  refreshAllCards(node, refs);
}

/** Every currently-live `AnimaGenerator` node instance, via litegraph's
 * public `findNodesByType` (NOT the private `app.graph._nodes` array --
 * `findNodesByType` is the documented API for exactly this "give me every
 * node of this type" query, so this stays correct even if litegraph's
 * internal node-storage shape changes). Defensive: an absent/unexpected
 * `app.graph` shape returns `[]` rather than throwing -- this must never be
 * the thing that breaks queueing. */
function findAnimaGeneratorNodes() {
  try {
    if (app.graph && typeof app.graph.findNodesByType === "function") {
      return app.graph.findNodesByType(NODE_CLASS_NAME) || [];
    }
  } catch (err) {
    // Fall through to the empty-array degrade below.
  }
  return [];
}

/** Handler for every "this queued prompt is over" `api` event (see this
 * file's top doc comment for the exact event list and why). Delegates
 * straight to `interaction.mjs`'s `resyncAllFromWidgets`, which already
 * skips not-yet-mounted nodes and swallows any single node's resync failure
 * -- this function adds nothing but the live-host node lookup. */
function handleExternalExecutionEvent() {
  resyncAllFromWidgets(findAnimaGeneratorNodes());
}

let apiListenerAttached = false;

app.registerExtension({
  name: "webtoon.anima_generator",

  async setup() {
    // Guards against a hypothetical double `setup()` call (mirrors
    // `js/anima/anima_preview/index.js`'s identical `apiListenerAttached`
    // guard) -- `api` is a page-wide singleton, so this listener must only
    // ever be attached once regardless of how many AnimaGenerator nodes end
    // up on the graph.
    if (apiListenerAttached) {
      return;
    }
    apiListenerAttached = true;
    try {
      if (api && typeof api.addEventListener === "function") {
        RESYNC_EVENTS.forEach((evt) => api.addEventListener(evt, handleExternalExecutionEvent));
      }
    } catch (err) {
      // No live `api` (e.g. an unexpected host) -- degrade to a no-op. The
      // panel still mirrors widget values correctly at mount/onConfigure;
      // it just won't auto-resync an externally-mutated widget (like `seed`
      // after control_after_generate) until the next reload/undo.
    }
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
      // Mark this node as loaded-from-a-workflow FIRST, before anything else
      // runs -- see js/anima_prompt/anima_prompt_studio/index.js's identical
      // pattern for why the ordering matters (ensureInitialFloor's own
      // `_agConfigured` guard, back in onNodeCreated/setupNode, must see
      // this flag correctly).
      this._agConfigured = true;
      const result = originalOnConfigure ? originalOnConfigure.apply(this, args) : undefined;
      restoreNode(this);
      return result;
    };

    // Manual-drag width+height FLOOR -- see render.mjs's createResizeClampHandler
    // doc comment for the full mechanism/rationale (why onResize, the
    // anti-recursion guard, the min_size belt-and-braces). This is on the
    // PROTOTYPE (applies to every AnimaGenerator instance); the handler
    // itself needs nothing but `this` (the node instance) any more -- the
    // floor is a fixed constant now (render.mjs's computeSizeFloor), not a
    // measurement of this node's own `._agRefs.root`.
    nodeType.prototype.onResize = createResizeClampHandler(nodeType.prototype.onResize);
  },
});
