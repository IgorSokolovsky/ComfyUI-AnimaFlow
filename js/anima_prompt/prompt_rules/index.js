/**
 * index.js — registers the Prompt Rules nodes' (`PromptRulesText` /
 * `PromptRulesClip`, `nodes/anima_prompt/prompt_rules.py`) themed frontend: a
 * single `addDOMWidget` root (`render.mjs`'s `buildRoot`) replacing the
 * stock canvas widgets/buttons, matching the house theme used by
 * `js/anima_prompt/anima_prompt_studio` (the reference implementation this build was
 * asked to mirror).
 *
 * Absolute `/scripts/app.js` import (this file is nested in
 * `js/anima_prompt/prompt_rules/` — the frontend skill's gotcha #1: a relative
 * `../../scripts/app.js` resolves wrong from a subfolder and silently kills
 * the whole extension). Same absolute-import reasoning applies to the
 * cross-folder `rule_builder` import below (kept byte-for-byte identical to
 * the previous version of this file — see the "Open Rule Builder" section).
 *
 * ## Widget-hiding decisions (which widgets get the DOM treatment)
 *
 * ALL SIX of this node's declared widgets are hidden-and-mirrored (per the
 * serialized-STRING state pattern from the frontend skill — a REAL,
 * still-serializing widget the JS only hides for rendering):
 *   - `profile`, `sheets`, `positive`, `negative`, `log_trace` each get a
 *     themed DOM control (`render.mjs`'s topbar fields / POSITIVE+NEGATIVE
 *     panes / trace switch) that mirrors the widget two ways — see
 *     `interaction.mjs`'s module doc comment for the full sync contract.
 *   - `embedded_rules` has no DOM control at all (nothing on this node
 *     previews its JSON) — it stays hidden-only, exactly as the previous
 *     version of this file already did; only `addOpenRuleBuilderButton`
 *     below ever reads/writes it.
 * `clip` (the CLIP-variant-only required input) is a connection SOCKET, not
 * a widget — it never appears in `node.widgets` and needs no hiding.
 *
 * ## Two-way sync summary (see interaction.mjs for the full contract)
 *
 * DOM edits write straight into the matching widget's `.value`
 * (`wireInteractions`). The reverse direction — a widget value changed
 * PROGRAMMATICALLY, not by typing in this UI — is resynced via
 * `refreshFromWidgets` at three points: initial mount, `onConfigure`
 * restore (workflow load/undo), and right after the "Pick…" popover closes
 * (it writes directly into the `positive`/`negative` widgets through its
 * own `getPositiveWidget`/`getNegativeWidget` contract, bypassing this
 * node's textareas entirely, so those need an explicit resync or the
 * inserted token would stay invisible until the next full reload).
 */
import { app } from "/scripts/app.js";
import { openRuleBuilder } from "/extensions/ComfyUI-AnimaFlow/anima_prompt/rule_builder/index.js";
import { openPicker } from "./picker.mjs";
import { parseEmbedded } from "./core.mjs";
import {
  injectStyles,
  buildRoot,
  measureMinHeight,
  scheduleInitialFit,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import { wireInteractions, refreshFromWidgets, findWidget } from "./interaction.mjs";
import { attachHighlighting, teardownHighlighting } from "./highlight_wiring.mjs";

// Both encode-node variants (`nodes/anima_prompt/prompt_rules.py`) get the same
// themed UI -- they differ only in output type (CONDITIONING vs STRING) and
// the CLIP variant's extra `clip` socket, not in how their
// `positive`/`negative`/`profile`/`sheets`/`log_trace`/`embedded_rules`
// widgets work.
const NODE_CLASS_NAMES = ["PromptRulesClip", "PromptRulesText"];

const WIDGETS_TO_HIDE = ["profile", "sheets", "positive", "negative", "log_trace", "embedded_rules"];

// The shared tag-highlighter's own doc comment (`js/shared/highlight/
// index.js`) documents this exact absolute import path. Kept as a GUARDED
// DYNAMIC import in `wireHighlighting` below (never a static top-level
// import here) for two reasons: (1) `highlight_wiring.mjs`'s own doc
// comment explains why a static absolute import breaks under this node's
// headless `test_resize.mjs`; (2) unlike that concern, THIS file is never
// itself executed by the headless test -- but a static import here would
// still mean an absent/broken route (e.g. an older install missing
// `autocomplete/api.py`'s `/wtn/classify` route) throws at EXTENSION LOAD
// TIME and takes the whole node down with it. A dynamic `import()` inside a
// `.catch()` degrades non-fatally instead, per this build's "never prevent
// the node from mounting" requirement.
const HIGHLIGHT_URL = "/extensions/ComfyUI-AnimaFlow/shared/highlight/index.js";

/** Hide a declared widget from rendering only — it keeps serializing
 * normally (per the skill's "hide a declared widget that must still
 * serialize" pattern). Works for widgets with an `inputEl` (the STRING
 * ones: `positive`/`negative`/`sheets`/`embedded_rules`) and ones without
 * (the canvas-drawn `profile` combo and `log_trace` boolean). Named
 * `targetWidget` (not `widget`) deliberately — this pack's own
 * `test_resize.mjs` convention (see `anima_prompt_studio/index.js`) greps
 * `index.js`'s source for a leftover `widget.computeSize =` assignment on
 * the DOM widget itself; reusing the name `widget` here would collide with
 * that check. */
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

function hideNativeWidgets(node) {
  WIDGETS_TO_HIDE.forEach((name) => hideWidget(findWidget(node, name)));
}

/** Floor a freshly-created node's size UP to `[DEFAULT_W, DEFAULT_H]`
 * (never down), guarded by `node._prConfigured` so a node being restored
 * from a saved workflow is never touched — mirrors
 * `js/anima_prompt/anima_prompt_studio/index.js`'s `ensureInitialFloor` exactly. */
function ensureInitialFloor(node) {
  if (node._prConfigured) {
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
 * "Open Rule Builder" -- opens the full-screen Rule Builder overlay
 * (`js/anima_prompt/rule_builder/overlay.mjs`, via its `index.js`'s re-exported
 * `openRuleBuilder(ctx)`) pointed at THIS node's `embedded_rules` widget:
 * reads its current value as the initial ruleset via `parseEmbedded`, and
 * writes `ctx.onApply`'s result back into it (JSON-stringified) so "Apply
 * to node" in the overlay round-trips through this exact widget. Kept
 * behaviorally IDENTICAL to the previous version of this file (same
 * `mode: "embedded"` pin, same `parseEmbedded`, same `profile`/`positive`/
 * `negative` initial values, same `onApply`/`onClose` shape) -- only the
 * widget lookups and the button's own DOM element changed (a themed
 * `.wtn-btn--primary` in `refs.ruleBuilderBtn` instead of a native
 * `node.addWidget("button", ...)`).
 */
function addOpenRuleBuilderButton(node, refs, embeddedWidget) {
  refs.ruleBuilderBtn.addEventListener("click", () => {
    const positiveWidget = findWidget(node, "positive");
    const negativeWidget = findWidget(node, "negative");
    const profileWidget = findWidget(node, "profile");

    openRuleBuilder({
      // The encode node's button is ALWAYS about editing THIS node's own
      // `embedded_rules` widget -- never a file sheet (that's what the
      // separate "Rule Builder" menu command / toolbar button, and the
      // overlay's own File-sheet/Embedded mode toggle once it's open, are
      // for). So `mode` is pinned to "embedded" unconditionally here,
      // regardless of whether `embedded_rules` currently holds anything --
      // an empty widget just means "start authoring a new embedded
      // ruleset from the seeded example", not "switch to sheet mode".
      mode: "embedded",
      embedded: parseEmbedded(embeddedWidget && embeddedWidget.value),
      profile: profileWidget ? profileWidget.value : undefined,
      positive: positiveWidget ? positiveWidget.value : "",
      negative: negativeWidget ? negativeWidget.value : "",
      // Round-trips "Apply to node" (overlay.mjs's `apply-embedded` button)
      // back into this exact widget -- the only place this node reads its
      // embedded ruleset from (`nodes/anima_prompt/_rules_helpers.py`'s
      // resolution order: file sheets, THEN `embedded_rules`).
      onApply(ruleset) {
        if (!embeddedWidget) {
          return;
        }
        embeddedWidget.value = JSON.stringify(ruleset);
        node.setDirtyCanvas(true, true);
      },
      onClose() {},
    });
  });
}

/**
 * "Pick…" -- opens the lighter character/outfit/background/pose picker
 * popover (`./picker.mjs`), which inserts a token into this node's
 * `positive`/`negative` text widget via the `getPositiveWidget`/
 * `getNegativeWidget` contract (kept verbatim from the previous version of
 * this file). The popover writes directly into the WIDGET, bypassing this
 * node's own textarea -- `onClose` resyncs the DOM from the widgets
 * (`refreshFromWidgets`) so the inserted token actually shows up.
 */
function addPickerButton(node, refs) {
  refs.pickBtn.addEventListener("click", () => {
    openPicker({
      node,
      getPositiveWidget: () => findWidget(node, "positive"),
      getNegativeWidget: () => findWidget(node, "negative"),
      onClose: () => refreshFromWidgets(node, refs),
    });
  });
}

/**
 * Loads the shared tag-highlighter and wires it into both textareas + the
 * legend slot (`highlight_wiring.mjs`'s `attachHighlighting`), then re-fits
 * the node so the (collapsed) legend's small summary row is accounted for
 * (via `scheduleInitialFit`, which is itself a no-op on a node restored from
 * a saved workflow -- see its doc comment in `render.mjs` -- so this never
 * fights the user's saved size). `import()` only ever runs inside a real
 * browser `document`; under any other host (or if the route/module fails to
 * load for any reason) this silently no-ops, per `highlight_wiring.mjs`'s
 * "never throws, never prevents the node from mounting" contract.
 */
function wireHighlighting(node, refs) {
  if (typeof document === "undefined") {
    return;
  }
  import(HIGHLIGHT_URL)
    .then((mod) => {
      attachHighlighting(node, refs, {
        attachHighlighterImpl: mod.attachHighlighter,
        createLegendImpl: mod.createLegend,
        doc: refs.doc,
      });
      scheduleInitialFit(node, refs.root);
    })
    .catch(() => {
      // No live ComfyUI server to serve the route (older install missing
      // `/wtn/classify`, or any other load failure) -- non-fatal, the node
      // works exactly as it does without highlighting.
    });
}

/**
 * Build (or, if already built, return) the node's DOM UI refs. Mounts one
 * `addDOMWidget` containing the whole styled UI (top bar + POSITIVE/
 * NEGATIVE panes + action row).
 *
 * Widget sizing follows the same two-renderer contract as every other DOM-
 * widget node in this pack (see `render.mjs`'s own doc comment): legacy
 * `getMinHeight` (PRIMARY — this build targets the legacy litegraph
 * renderer) + Nodes 2.0 `computeLayoutSize` (`minWidth: 1`, forward-compat
 * only). Neither path itself resizes the node — that's `scheduleInitialFit`'s
 * job (this node has no dynamic rows, so it's the ONLY resize trigger; see
 * `render.mjs`'s module doc comment).
 */
function mountUI(node) {
  if (node._prRefs) {
    return node._prRefs;
  }

  hideNativeWidgets(node);

  injectStyles(typeof document !== "undefined" ? document : undefined);
  const doc = typeof document !== "undefined" ? document : undefined;
  const refs = buildRoot(doc);
  node._prRefs = refs;

  wireInteractions(node, refs);
  refreshFromWidgets(node, refs);
  wireHighlighting(node, refs);

  const embeddedWidget = findWidget(node, "embedded_rules");
  addOpenRuleBuilderButton(node, refs, embeddedWidget);
  addPickerButton(node, refs);

  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget("pr_ui", "pr_ui", refs.root, {
      serialize: false,
      // Legacy canvas renderer sizing path (PRIMARY) — NOT computeSize/
      // getHeight (those fight node.setSize under the legacy renderer).
      getMinHeight: () => measureMinHeight(refs.root),
    });
  } else {
    // Defensive fallback for a host without addDOMWidget; shouldn't occur
    // in ComfyUI's actual runtime.
    widget = { name: "pr_ui", type: "pr_ui", element: refs.root };
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
  // Guards against a hypothetical double `onNodeCreated` re-entry (this
  // pack's other nodes use the same `_wtn*Setup`-style guard, e.g.
  // `js/anima_prompt/prompt_combiner/index.js`'s `_promptCombinerRefs` existence
  // check) -- kept as the exact same flag name the previous version of this
  // file used.
  if (node._wtnPromptRulesSetup) {
    return;
  }
  node._wtnPromptRulesSetup = true;

  const refs = mountUI(node);
  ensureInitialFloor(node);
  // GUARDED initial fit — a no-op if this node turns out to be loading
  // from a saved workflow (see `scheduleInitialFit`'s doc comment in
  // render.mjs): by the time its rAF fires, onConfigure has already set
  // `node._prConfigured` and litegraph has already restored `node.size`.
  scheduleInitialFit(node, refs.root);
}

/**
 * Restore the DOM UI after `onConfigure` has restored `node.properties`,
 * `widgets_values` (including every hidden widget's REAL saved value), and
 * `node.size` from a saved workflow: resync every DOM control from the
 * NOW-restored widgets (`refreshFromWidgets`). Deliberately does NOT call
 * `scheduleInitialFit`/`scheduleRefit` — trusts the `node.size` litegraph
 * already restored (mirrors `js/anima_prompt/anima_prompt_studio/index.js`'s
 * `restoreNode`).
 */
function restoreNode(node) {
  const refs = mountUI(node);
  refreshFromWidgets(node, refs);
}

app.registerExtension({
  name: "webtoon.prompt_rules",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_CLASS_NAMES.includes(nodeData.name)) {
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
      // pattern for why the ordering matters (the still-pending initial-fit
      // rAF queued back in onNodeCreated must see this flag by the time it
      // fires).
      this._prConfigured = true;
      const result = originalOnConfigure ? originalOnConfigure.apply(this, args) : undefined;
      restoreNode(this);
      return result;
    };

    const originalOnRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      // A deleted node must not leave a detached mirror div or a pending
      // classify debounce timer behind -- see `highlight_wiring.mjs`'s
      // `teardownHighlighting` doc comment. Safe even if highlighting never
      // attached (module load failed/no document): both handles are just
      // `null` and every step there already no-ops.
      if (this._prRefs) {
        teardownHighlighting(this._prRefs);
      }
      return originalOnRemoved ? originalOnRemoved.apply(this, args) : undefined;
    };
  },
});
