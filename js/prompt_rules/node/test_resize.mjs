/**
 * test_resize.mjs — regression tests for the Prompt Rules themed frontend
 * (`PromptRulesText` / `PromptRulesClip`):
 *
 *   A. `core.mjs` pure logic — `readProfileValues` reads a combo widget's
 *      live `options.values` (array / callable / missing, never hardcodes
 *      the profile list), `parseEmbedded` tolerantly parses the
 *      `embedded_rules` widget's JSON (never throws), `normalizeSheetsValue`
 *      mirrors the `sheets` widget's `"*"`-default / explicit-empty-string
 *      contract from `nodes/prompt_rules/_rules_helpers.py`.
 *   B. `render.mjs` DOM building — `buildRoot` lays out the topbar
 *      (PROFILE/SHEETS/BETA), POSITIVE/NEGATIVE panes (status dots, the
 *      `log_trace` switch in the NEGATIVE header), and the action row using
 *      the SHARED `.wtn-btn`/`.wtn-btn--primary`/`.wtn-btn--ghost` classes
 *      (no bespoke button styling); `setProfileOptions` rebuilds the
 *      `<select>` from live values and preserves an off-list current value;
 *      `setLogTraceUI`/`autoGrowTextarea` reflect state correctly.
 *   C. Resize mechanism (ComfyUI-Pixaroma find_replace mechanism, matched
 *      exactly): `measureMinHeight`/`setNodeHeight`/`refitNode`/
 *      `scheduleRefit`/`scheduleInitialFit`.
 *   D. `interaction.mjs` two-way native-widget sync — THE core requirement
 *      of this build: DOM edits (topbar fields, both textareas, the trace
 *      switch) write straight into the matching native widget's `.value`;
 *      `refreshFromWidgets` reads every widget's CURRENT value back into
 *      the DOM (mount / restore / post-picker-insert); `wireInteractions`
 *      is idempotent.
 *   E. `index.js` source-level assertions (`app` resolves only inside a
 *      real ComfyUI/browser host, so this file can't import `index.js`
 *      directly) — the absolute `/scripts/app.js`
 *      import, ALL SIX native widgets hidden, the legacy `getMinHeight` +
 *      Nodes 2.0 `computeLayoutSize` widget sizing wiring, the guarded
 *      initial fit vs. unconditional refit split, the `_wtnPromptRulesSetup`
 *      re-entry guard, and that the "Open Rule Builder" / "Pick…" buttons
 *      keep their exact documented contracts (`mode: "embedded"`,
 *      `parseEmbedded`, `onApply` writing `embedded_rules` +
 *      `setDirtyCanvas`, `getPositiveWidget`/`getNegativeWidget`, and the
 *      picker's `onClose` resyncing the DOM via `refreshFromWidgets`).
 *   F. `highlight_wiring.mjs` — the shared tag-highlighter integration:
 *      `attachHighlighting` attaches a (fake, injected) highlighter to BOTH
 *      textareas and builds a REAL `js/shared/highlight/legend.mjs` legend
 *      (collapsed by default) into the node's legend slot; toggling the
 *      legend's native `<details>` `toggle` event schedules a refit that
 *      grows the node; `refreshFromWidgets` (via `refreshHighlighters`)
 *      forces both handles to resync EVERY time it runs — the
 *      programmatic-`textarea.value`-write trap, asserted directly, not
 *      eyeballed; `teardownHighlighting` detaches both handles and destroys
 *      the legend; every entry point degrades to `null` handles (never
 *      throws) when an impl is missing, throws, or itself returns `null`.
 *   G. `index.js` source-level assertions for the highlighter wiring: the
 *      `./highlight_wiring.mjs` import, the highlight module load being a
 *      GUARDED `import()` (never a static top-level import — a broken/
 *      missing route must not take the whole extension down), `mountUI`
 *      wiring highlighting after `refreshFromWidgets`, and the `onRemoved`
 *      hook calling `teardownHighlighting` before the original `onRemoved`.
 *
 * Run directly: `node js/prompt_rules/node/test_resize.mjs` (plain script,
 * no test framework — matches the project's `python tests/test_x.py`
 * convention).
 *
 * MANUAL-IN-COMFYUI CHECKLIST (cannot be confirmed by this headless
 * harness — the real `addDOMWidget`/LiteGraph runtime contract only exists
 * live):
 *   [ ] Tag autocomplete (`js/autocomplete/`) still pops up while typing in
 *       either the POSITIVE or NEGATIVE textarea (verified structurally
 *       here via `js/autocomplete/index.js`'s DOM-widget fallback path,
 *       which scans `widget.element.querySelectorAll("textarea")` — both
 *       panes render real `<textarea>` elements under the DOM widget's
 *       root, so they're discovered the same way Prompt Builder's fields
 *       already are).
 *   [ ] "Open Rule Builder" opens the overlay pre-seeded from this node's
 *       current `embedded_rules`/`profile`/`positive`/`negative`, and
 *       "Apply to node" writes back into `embedded_rules` (check
 *       `widgets_values` in the saved workflow JSON).
 *   [ ] "Pick…" inserts a token into whichever pane is selected in the
 *       popover, and the node's own POSITIVE/NEGATIVE textarea updates
 *       immediately (no reload needed) once the popover closes.
 *   [ ] Saving a workflow, then reloading the page, restores exactly the
 *       same profile/sheets/positive/negative/log_trace values at the saved
 *       node size (no duplicate UI).
 *   [ ] Dragging the node wider sticks; typing a long prompt never jitters
 *       the node's own height (only the textarea grows, up to its own
 *       max-height, then scrolls internally).
 *   [ ] Both textareas actually paint classifier colors while typing (real
 *       `/wtn/classify` round-trip) and the legend expands/collapses with a
 *       visibly correct node re-fit (this headless harness only proves the
 *       WIRING, via injected fakes -- see `js/shared/highlight/
 *       test_highlight.mjs` for the highlighter/legend internals, and this
 *       file's section F for the wiring itself).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { readProfileValues, parseEmbedded, normalizeSheetsValue } from "./core.mjs";

import {
  buildRoot,
  injectStyles,
  setProfileOptions,
  setLogTraceUI,
  autoGrowTextarea,
  measureMinHeight,
  setNodeHeight,
  refitNode,
  scheduleRefit,
  scheduleInitialFit,
  CHROME,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";

import {
  findWidget,
  getWidgets,
  refreshFromWidgets,
  wireInteractions,
} from "./interaction.mjs";

import {
  attachHighlighting,
  refreshHighlighters,
  teardownHighlighting,
} from "./highlight_wiring.mjs";

// A real, side-effect-free (no network/timers) shared module -- safe to
// import directly under plain `node` via a RELATIVE path (only the
// documented ABSOLUTE `/extensions/ComfyUI-AnimaFlow/...` import breaks
// under node; see `highlight_wiring.mjs`'s doc comment). Used below to
// exercise the REAL collapsed-by-default legend contract, not a fake.
import { createLegend } from "../../shared/highlight/legend.mjs";
import { installCanvasZoomPassthrough } from "../../shared/canvas_zoom.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let count = 0;

function test(name, fn) {
  count += 1;
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

// ---- Stubbed requestAnimationFrame ------------------------------------

let rafQueue = [];
globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
function flushRAF() {
  const pending = rafQueue;
  rafQueue = [];
  pending.forEach((cb) => cb());
}
function resetRAF() {
  rafQueue = [];
}

globalThis.getComputedStyle = (el) => (el && el.style) || {};

// ---- Minimal DOM stub -------------------------------------------------

function makeDocStub() {
  let doc;

  function makeElement(tag) {
    const el = {
      tagName: tag,
      _listeners: {},
      children: [],
      style: {},
      attributes: {},
      value: "",
      textContent: "",
      innerHTML: "",
      title: "",
      disabled: false,
      parentNode: null,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      get ownerDocument() {
        return doc;
      },
      // Only ever appended-to by other elements in this stub's usage (never a
      // real Text/Comment container), so `parentElement` and `parentNode`
      // are interchangeable here -- added for `canvas_zoom.mjs`'s
      // `scrollRegionWantsWheel`, which walks a DOM tree via `parentElement`.
      get parentElement() {
        return el.parentNode;
      },
      classList: {
        _set: new Set(),
        add(c) {
          this._set.add(c);
        },
        remove(c) {
          this._set.delete(c);
        },
        contains(c) {
          return this._set.has(c);
        },
        toggle(c, force) {
          const on = force === undefined ? !this._set.has(c) : !!force;
          if (on) {
            this._set.add(c);
          } else {
            this._set.delete(c);
          }
          return on;
        },
      },
      setAttribute(name, val) {
        el.attributes[name] = val;
      },
      addEventListener(type, fn) {
        (el._listeners[type] = el._listeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = el._listeners[type];
        if (!arr) {
          return;
        }
        const i = arr.indexOf(fn);
        if (i >= 0) {
          arr.splice(i, 1);
        }
      },
      appendChild(child) {
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx >= 0) {
          el.children.splice(idx, 1);
        }
        child.parentNode = null;
        return child;
      },
      focus() {},
    };
    Object.defineProperty(el, "className", {
      get() {
        return el._className || "";
      },
      set(v) {
        el._className = v;
      },
    });
    Object.defineProperty(el, "firstChild", {
      get() {
        return el.children.length ? el.children[0] : null;
      },
    });
    return el;
  }

  doc = {
    createElement: makeElement,
    createTextNode(text) {
      return { nodeType: 3, textContent: text, parentNode: null };
    },
    getElementById() {
      return null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
  };
  return doc;
}

function fire(el, type) {
  (el._listeners[type] || []).forEach((fn) => fn());
}

function makeFakeNode(initialSize, widgetValues, widgetOptions) {
  const setSizeCalls = [];
  const widgets = Object.entries(widgetValues || {}).map(([name, value]) => ({
    name,
    value,
    options: (widgetOptions && widgetOptions[name]) || undefined,
  }));
  const node = {
    size: initialSize.slice(),
    properties: {},
    widgets,
    setSize(size) {
      setSizeCalls.push(size.slice());
      node.size = size.slice();
    },
    setDirtyCanvas() {},
  };
  return { node, setSizeCalls };
}

function makeMountedRefs() {
  const doc = makeDocStub();
  injectStyles(doc);
  return buildRoot(doc);
}

// =========================================================================
// A. core.mjs — pure logic
// =========================================================================

test("readProfileValues reads a plain array from options.values", () => {
  const widget = { options: { values: ["anima", "illustrious", "flux", "raw"] } };
  assert.deepEqual(readProfileValues(widget), ["anima", "illustrious", "flux", "raw"]);
});

test("readProfileValues calls a callable options.values", () => {
  const widget = { options: { values: () => ["a", "b"] } };
  assert.deepEqual(readProfileValues(widget), ["a", "b"]);
});

test("readProfileValues returns [] for a throwing callable, missing options, or a missing widget", () => {
  assert.deepEqual(
    readProfileValues({
      options: {
        values: () => {
          throw new Error("boom");
        },
      },
    }),
    [],
  );
  assert.deepEqual(readProfileValues({ options: {} }), []);
  assert.deepEqual(readProfileValues({}), []);
  assert.deepEqual(readProfileValues(null), []);
});

test("readProfileValues never hardcodes the profile list -- it's 100% derived from the widget", () => {
  const widget = { options: { values: ["only-one-choice"] } };
  assert.deepEqual(readProfileValues(widget), ["only-one-choice"]);
});

test("parseEmbedded returns {} for empty/malformed JSON or a JSON string/number, never throws", () => {
  assert.deepEqual(parseEmbedded(""), {});
  assert.deepEqual(parseEmbedded(null), {});
  assert.deepEqual(parseEmbedded("{not valid"), {});
  assert.deepEqual(parseEmbedded(JSON.stringify("x")), {});
  assert.deepEqual(parseEmbedded(JSON.stringify(42)), {});
});

test("parseEmbedded parses a valid ruleset object", () => {
  const ruleset = { characters: [{ name: "a" }] };
  assert.deepEqual(parseEmbedded(JSON.stringify(ruleset)), ruleset);
});

test("normalizeSheetsValue defaults null/undefined to '*' but preserves an explicit empty string", () => {
  assert.equal(normalizeSheetsValue(null), "*");
  assert.equal(normalizeSheetsValue(undefined), "*");
  assert.equal(normalizeSheetsValue(""), "");
  assert.equal(normalizeSheetsValue("sheetA,sheetB"), "sheetA,sheetB");
});

// =========================================================================
// B. render.mjs — DOM building
// =========================================================================

test("buildRoot lays out the topbar (profile/sheets/beta), both panes, and the action row", () => {
  const refs = makeMountedRefs();
  assert.equal(refs.root.className, "wtn-pr-root wtn");
  assert.ok(refs.profileSelect);
  assert.ok(refs.sheetsInput);
  assert.ok(refs.positiveTextarea && String(refs.positiveTextarea.tagName).toLowerCase() === "textarea");
  assert.ok(refs.negativeTextarea && String(refs.negativeTextarea.tagName).toLowerCase() === "textarea");
  assert.ok(refs.traceSwitch);
  assert.ok(refs.ruleBuilderBtn);
  assert.ok(refs.pickBtn);
});

test("buildRoot's action buttons use the SHARED wtn-btn classes, not bespoke styling", () => {
  const refs = makeMountedRefs();
  assert.match(refs.ruleBuilderBtn.className, /\bwtn-btn\b/);
  assert.match(refs.ruleBuilderBtn.className, /\bwtn-btn--primary\b/);
  assert.match(refs.pickBtn.className, /\bwtn-btn\b/);
  assert.match(refs.pickBtn.className, /\bwtn-btn--ghost\b/);
});

test("setProfileOptions rebuilds the select's options from live values and selects current", () => {
  const refs = makeMountedRefs();
  setProfileOptions(refs, ["anima", "illustrious", "flux", "raw"], "flux");
  assert.equal(refs.profileSelect.children.length, 4);
  assert.equal(refs.profileSelect.value, "flux");
});

test("setProfileOptions appends an off-list current value instead of discarding it", () => {
  const refs = makeMountedRefs();
  setProfileOptions(refs, ["anima", "illustrious"], "custom-profile");
  assert.equal(refs.profileSelect.children.length, 3);
  assert.equal(refs.profileSelect.value, "custom-profile");
});

test("setProfileOptions clears any previously-built options first (no accumulation on re-render)", () => {
  const refs = makeMountedRefs();
  setProfileOptions(refs, ["a", "b"], "a");
  setProfileOptions(refs, ["a", "b", "c"], "c");
  assert.equal(refs.profileSelect.children.length, 3);
});

test("setLogTraceUI toggles the switch's on class", () => {
  const refs = makeMountedRefs();
  setLogTraceUI(refs, true);
  assert.ok(refs.traceSwitch.classList.contains("wtn-pr-switch-on"));
  setLogTraceUI(refs, false);
  assert.ok(!refs.traceSwitch.classList.contains("wtn-pr-switch-on"));
});

test("autoGrowTextarea clamps between its min and max height", () => {
  const ta = { style: {}, scrollHeight: 5 };
  autoGrowTextarea(ta);
  assert.equal(ta.style.height, "90px");
  ta.scrollHeight = 5000;
  autoGrowTextarea(ta);
  assert.equal(ta.style.height, "280px");
});

// =========================================================================
// C. render.mjs — resize mechanism (ComfyUI-Pixaroma find_replace, matched exactly)
// =========================================================================

test("measureMinHeight returns the floor for a missing root", () => {
  assert.equal(measureMinHeight(null), 220);
});

test("measureMinHeight sums visible children + gap + padding, floors at 220, rounds to 4px", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  root.style.rowGap = "10px";
  root.style.paddingTop = "3px";
  root.style.paddingBottom = "3px";
  const a = doc.createElement("div");
  a.offsetHeight = 100;
  a.offsetParent = {};
  const b = doc.createElement("div");
  b.offsetHeight = 100;
  b.offsetParent = {};
  root.appendChild(a);
  root.appendChild(b);
  assert.equal(measureMinHeight(root), 220);
});

test("measureMinHeight skips children whose offsetParent is null", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const visible = doc.createElement("div");
  visible.offsetHeight = 300;
  visible.offsetParent = {};
  const hidden = doc.createElement("div");
  hidden.offsetHeight = 9999;
  hidden.offsetParent = null;
  root.appendChild(visible);
  root.appendChild(hidden);
  assert.equal(measureMinHeight(root), 300);
});

test("setNodeHeight sets height only, preserves width, records _prAutoH", () => {
  const { node, setSizeCalls } = makeFakeNode([380, 200], {});
  setNodeHeight(node, 500);
  assert.equal(node.size[0], 380);
  assert.equal(node.size[1], 500);
  assert.equal(node._prAutoH, 500);
  assert.deepEqual(setSizeCalls[0], [380, 500]);
});

test("refitNode grows the node when measured content + CHROME exceeds current height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 800;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([380, 200], {});

  refitNode(node, root);

  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.ok(want > 200);
  assert.equal(setSizeCalls.length, 1);
  assert.equal(node.size[1], want);
  assert.equal(node.size[0], 380);
});

test("refitNode does not shrink a node the user manually enlarged past the last auto-fit height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([380, 900], {});
  node._prAutoH = 300;

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0);
});

test("scheduleRefit defers through requestAnimationFrame — never resizes synchronously", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([380, 200], {});

  scheduleRefit(node, root);
  assert.equal(setSizeCalls.length, 0);
  assert.equal(rafQueue.length, 1);
  flushRAF();
  assert.equal(setSizeCalls.length, 1);
});

test("scheduleInitialFit does not resize when node._prConfigured is true (loaded node keeps saved size)", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([380, 260], {});
  node._prConfigured = true;

  scheduleInitialFit(node, root);
  flushRAF();

  assert.equal(setSizeCalls.length, 0);
  assert.equal(node.size[1], 260);
});

test("scheduleInitialFit DOES fit a genuinely fresh node", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([380, 100], {});

  scheduleInitialFit(node, root);
  flushRAF();

  assert.equal(setSizeCalls.length, 1);
});

// =========================================================================
// D. interaction.mjs — native-widget two-way sync
// =========================================================================

function makeInteractionFixture(values) {
  resetRAF();
  const refs = makeMountedRefs();
  const { node } = makeFakeNode(
    [380, 380],
    {
      profile: values.profile ?? "anima",
      sheets: values.sheets ?? "*",
      positive: values.positive ?? "",
      negative: values.negative ?? "",
      log_trace: values.log_trace ?? true,
    },
    { profile: { values: values.profileChoices || ["anima", "illustrious", "flux", "raw"] } },
  );
  wireInteractions(node, refs);
  refreshFromWidgets(node, refs);
  return { node, refs };
}

test("findWidget/getWidgets find every mirrored widget by name", () => {
  const { node } = makeInteractionFixture({});
  const w = getWidgets(node);
  assert.ok(w.profile && w.sheets && w.positive && w.negative && w.logTrace);
  assert.equal(findWidget(node, "profile"), w.profile);
});

test("refreshFromWidgets (widget -> DOM) mirrors every widget's current value into its DOM control", () => {
  const { node, refs } = makeInteractionFixture({
    profile: "flux",
    sheets: "sheetA",
    positive: "1girl, solo",
    negative: "worst quality",
    log_trace: false,
  });
  assert.equal(refs.profileSelect.value, "flux");
  assert.equal(refs.sheetsInput.value, "sheetA");
  assert.equal(refs.positiveTextarea.value, "1girl, solo");
  assert.equal(refs.negativeTextarea.value, "worst quality");
  assert.ok(!refs.traceSwitch.classList.contains("wtn-pr-switch-on"));
});

test("a value changed PROGRAMMATICALLY on the widget (workflow load / picker insert) is reflected by a fresh refreshFromWidgets call", () => {
  const { node, refs } = makeInteractionFixture({ positive: "original" });
  assert.equal(refs.positiveTextarea.value, "original");

  // Simulate the picker inserting a token straight into the widget, the
  // way `./picker.mjs`'s `insertToken` does (bypassing this node's own
  // textarea entirely).
  findWidget(node, "positive").value = "original, inserted token";

  refreshFromWidgets(node, refs);
  assert.equal(refs.positiveTextarea.value, "original, inserted token");
});

test("editing the positive/negative textarea (DOM -> widget) writes straight into the native widget", () => {
  const { node, refs } = makeInteractionFixture({});
  refs.positiveTextarea.value = "typed positive";
  fire(refs.positiveTextarea, "input");
  assert.equal(findWidget(node, "positive").value, "typed positive");

  refs.negativeTextarea.value = "typed negative";
  fire(refs.negativeTextarea, "input");
  assert.equal(findWidget(node, "negative").value, "typed negative");
});

test("editing the sheets field (DOM -> widget) writes straight into the native widget, including an explicit empty string", () => {
  const { node, refs } = makeInteractionFixture({});
  refs.sheetsInput.value = "sheetA,sheetB";
  fire(refs.sheetsInput, "input");
  assert.equal(findWidget(node, "sheets").value, "sheetA,sheetB");

  refs.sheetsInput.value = "";
  fire(refs.sheetsInput, "input");
  assert.equal(findWidget(node, "sheets").value, "");
});

test("changing the profile select (DOM -> widget) writes straight into the native widget", () => {
  const { node, refs } = makeInteractionFixture({ profile: "anima" });
  refs.profileSelect.value = "raw";
  fire(refs.profileSelect, "change");
  assert.equal(findWidget(node, "profile").value, "raw");
});

test("clicking the trace switch (DOM -> widget) flips the native log_trace widget and updates the switch UI", () => {
  const { node, refs } = makeInteractionFixture({ log_trace: false });
  assert.ok(!refs.traceSwitch.classList.contains("wtn-pr-switch-on"));

  fire(refs.traceSwitch, "click");

  assert.equal(findWidget(node, "log_trace").value, true);
  assert.ok(refs.traceSwitch.classList.contains("wtn-pr-switch-on"));
});

test("wireInteractions is idempotent (a second call does not double-attach listeners)", () => {
  const { node, refs } = makeInteractionFixture({ log_trace: false });
  wireInteractions(node, refs);
  fire(refs.traceSwitch, "click");
  // If listeners were double-attached, two clicks worth of toggles would
  // fire from one event, flipping the value back to false.
  assert.equal(findWidget(node, "log_trace").value, true);
});

// =========================================================================
// F. highlight_wiring.mjs — shared tag-highlighter integration
// =========================================================================

/** A fake `attachHighlighter` -- one spy handle per distinct textarea, so
 * assertions can tell the positive and negative panes apart and count
 * `refresh()`/`detach()` calls without touching the real network/timer-
 * driven shared module (that's `js/shared/highlight/test_highlight.mjs`'s
 * job). Mirrors the real handle's shape: `{ textarea, mirror, refresh(),
 * detach() }`.
 */
function makeFakeAttachHighlighterImpl() {
  const byTextarea = new Map();
  function attachHighlighterImpl(textarea) {
    if (byTextarea.has(textarea)) {
      return byTextarea.get(textarea);
    }
    const handle = {
      textarea,
      mirror: {},
      refreshCalls: 0,
      detachCalls: 0,
      refresh() {
        handle.refreshCalls += 1;
      },
      detach() {
        handle.detachCalls += 1;
      },
    };
    byTextarea.set(textarea, handle);
    return handle;
  }
  return attachHighlighterImpl;
}

test("attachHighlighting attaches a highlighter to BOTH the positive and negative textareas", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([380, 380], {});
  const attachHighlighterImpl = makeFakeAttachHighlighterImpl();

  attachHighlighting(node, refs, { attachHighlighterImpl });

  assert.ok(refs.positiveHighlight, "expected the positive pane to get a handle");
  assert.equal(refs.positiveHighlight.textarea, refs.positiveTextarea);
  assert.ok(refs.negativeHighlight, "expected the negative pane to get a handle");
  assert.equal(refs.negativeHighlight.textarea, refs.negativeTextarea);
  assert.notEqual(refs.positiveHighlight, refs.negativeHighlight, "each pane must get its own handle");
});

test("attachHighlighting builds a REAL legend (collapsed by default) into the node's legend slot", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([380, 380], {});

  attachHighlighting(node, refs, { createLegendImpl: createLegend, doc: refs.doc });

  assert.ok(refs.legend, "expected a legend to attach");
  assert.equal(refs.legend.root.parentNode, refs.legendSlot, "legend must mount into the legend slot below the actions row");
  assert.ok(
    !("open" in refs.legend.root.attributes),
    "a freshly-built legend must be collapsed by default (no 'open' attribute)",
  );
});

test("attachHighlighting is idempotent — a second call does not re-attach", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([380, 380], {});
  let calls = 0;
  const attachHighlighterImpl = (ta) => {
    calls += 1;
    return { textarea: ta, refresh() {}, detach() {} };
  };

  attachHighlighting(node, refs, { attachHighlighterImpl });
  attachHighlighting(node, refs, { attachHighlighterImpl });

  assert.equal(calls, 2, "expected exactly one attach per textarea from the FIRST call only");
});

test("toggling the legend (native <details> `toggle` event) schedules a refit that grows the node", () => {
  resetRAF();
  const refs = makeMountedRefs();
  const { node, setSizeCalls } = makeFakeNode([380, 380], {});

  attachHighlighting(node, refs, { createLegendImpl: createLegend, doc: refs.doc });
  assert.ok(refs.legend, "expected a real legend to attach");

  // Give every root child a real (stubbed) height so measureMinHeight/
  // refitNode see a determinate "legend expanded" content size that
  // exceeds the node's current height (mirrors section C's manually-built
  // roots -- the DOM stub has no real layout engine to derive these from).
  for (const child of refs.root.children) {
    child.offsetHeight = child === refs.legendSlot ? 900 : 10;
    child.offsetParent = {};
  }

  assert.equal(rafQueue.length, 0);
  fire(refs.legend.root, "toggle");
  assert.equal(rafQueue.length, 1, "expected the toggle handler to schedule a refit via requestAnimationFrame");
  assert.equal(setSizeCalls.length, 0, "a refit must be rAF-deferred, never synchronous");

  flushRAF();

  assert.equal(setSizeCalls.length, 1);
  assert.ok(node.size[1] > 380, "expected the node to grow to fit the expanded legend");
});

test("refreshFromWidgets forces both highlight handles to resync EVERY time it runs (the programmatic-update trap)", () => {
  resetRAF();
  const { node, refs } = makeInteractionFixture({ positive: "original", negative: "original neg" });
  const attachHighlighterImpl = makeFakeAttachHighlighterImpl();
  attachHighlighting(node, refs, { attachHighlighterImpl });

  assert.equal(refs.positiveHighlight.refreshCalls, 0);
  assert.equal(refs.negativeHighlight.refreshCalls, 0);

  // Simulate the picker inserting a token straight into the widget (bypasses
  // this node's own textarea entirely, exactly like `./picker.mjs`'s
  // `insertToken` -- see `interaction.mjs`'s doc comment).
  findWidget(node, "positive").value = "original, inserted token";
  refreshFromWidgets(node, refs);

  assert.equal(refs.positiveTextarea.value, "original, inserted token");
  assert.equal(refs.positiveHighlight.refreshCalls, 1, "expected refresh() after the programmatic textarea.value write");
  assert.equal(refs.negativeHighlight.refreshCalls, 1, "both panes resync on every refreshFromWidgets call, not just the changed one");

  // A second call (e.g. onConfigure restore) must resync again, not just once.
  refreshFromWidgets(node, refs);
  assert.equal(refs.positiveHighlight.refreshCalls, 2);
  assert.equal(refs.negativeHighlight.refreshCalls, 2);
});

test("refreshHighlighters no-ops (never throws) when a handle is null or refs is missing", () => {
  assert.doesNotThrow(() => refreshHighlighters(null));
  assert.doesNotThrow(() => refreshHighlighters({}));
  assert.doesNotThrow(() => refreshHighlighters({ positiveHighlight: null, negativeHighlight: null }));
});

test("teardownHighlighting detaches both highlighters and destroys the legend, then clears refs", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([380, 380], {});
  const attachHighlighterImpl = makeFakeAttachHighlighterImpl();

  attachHighlighting(node, refs, { attachHighlighterImpl, createLegendImpl: createLegend, doc: refs.doc });
  const positiveHandle = refs.positiveHighlight;
  const negativeHandle = refs.negativeHighlight;
  const legendDestroySpy = { calls: 0 };
  const originalDestroy = refs.legend.destroy;
  refs.legend.destroy = (...args) => {
    legendDestroySpy.calls += 1;
    return originalDestroy.apply(refs.legend, args);
  };

  teardownHighlighting(refs);

  assert.equal(positiveHandle.detachCalls, 1);
  assert.equal(negativeHandle.detachCalls, 1);
  assert.equal(legendDestroySpy.calls, 1);
  assert.equal(refs.positiveHighlight, null);
  assert.equal(refs.negativeHighlight, null);
  assert.equal(refs.legend, null);
});

test("teardownHighlighting is safe to call even when highlighting never attached", () => {
  const refs = makeMountedRefs();
  assert.doesNotThrow(() => teardownHighlighting(refs));
  assert.doesNotThrow(() => teardownHighlighting(null));
  assert.doesNotThrow(() => teardownHighlighting(undefined));
});

test("attachHighlighting degrades to null handles (never prevents the node from mounting) when no impls are provided", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([380, 380], { positive: "", negative: "" });
  wireInteractions(node, refs);

  assert.doesNotThrow(() => attachHighlighting(node, refs, {}));
  assert.equal(refs.positiveHighlight, null);
  assert.equal(refs.negativeHighlight, null);
  assert.equal(refs.legend, null);

  // The rest of the node's contract must keep working exactly as it does
  // without highlighting.
  assert.doesNotThrow(() => refreshFromWidgets(node, refs));
  assert.doesNotThrow(() => refreshHighlighters(refs));
  assert.doesNotThrow(() => teardownHighlighting(refs));
});

test("attachHighlighting degrades to null handles when the injected impls THROW (simulated load/build failure)", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([380, 380], {});
  const throwing = () => {
    throw new Error("boom");
  };

  assert.doesNotThrow(() =>
    attachHighlighting(node, refs, { attachHighlighterImpl: throwing, createLegendImpl: throwing }),
  );
  assert.equal(refs.positiveHighlight, null);
  assert.equal(refs.negativeHighlight, null);
  assert.equal(refs.legend, null);
});

test("attachHighlighting degrades to null handles when createLegendImpl itself returns null (no document / failed load)", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([380, 380], {});

  attachHighlighting(node, refs, { attachHighlighterImpl: () => null, createLegendImpl: () => null });

  assert.equal(refs.positiveHighlight, null);
  assert.equal(refs.negativeHighlight, null);
  assert.equal(refs.legend, null);
});

// =========================================================================
// G. index.js — source-level assertions
// =========================================================================

const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const indexCode = stripComments(indexSource);

test("index.js imports app from the absolute /scripts/app.js path", () => {
  assert.match(indexSource, /from\s+"\/scripts\/app\.js"/);
});

test("index.js imports openRuleBuilder from the absolute rule_builder path (unchanged, not owned by this build)", () => {
  assert.match(
    indexSource,
    /from\s+"\/extensions\/ComfyUI-AnimaFlow\/prompt_rules\/rule_builder\/index\.js"/,
  );
});

test("index.js hides all six native widgets (profile, sheets, positive, negative, log_trace, embedded_rules)", () => {
  assert.match(indexCode, /WIDGETS_TO_HIDE\s*=\s*\[[^\]]*"profile"[^\]]*\]/);
  ["profile", "sheets", "positive", "negative", "log_trace", "embedded_rules"].forEach((name) => {
    assert.match(indexCode, new RegExp(`"${name}"`), `expected "${name}" in WIDGETS_TO_HIDE`);
  });
  assert.match(indexCode, /hideNativeWidgets\(node\)/);
});

test("index.js creates the widget with the legacy getMinHeight option, backed by measureMinHeight", () => {
  assert.match(indexSource, /getMinHeight/);
  assert.match(indexSource, /measureMinHeight/);
  assert.ok(!/widget\.computeSize\s*=/.test(indexCode), "found a leftover widget.computeSize assignment");
  assert.ok(!/widget\.getHeight\s*=/.test(indexCode), "found a leftover widget.getHeight assignment");
});

test("index.js's widget.computeLayoutSize reports minWidth: 1 for the Nodes 2.0 renderer path", () => {
  assert.match(indexCode, /computeLayoutSize/);
  assert.match(indexCode, /minWidth:\s*1/);
});

test("index.js keeps the _wtnPromptRulesSetup re-entry guard", () => {
  assert.match(indexCode, /_wtnPromptRulesSetup/);
});

test("index.js schedules the guarded initial fit in setupNode, never scheduleRefit there", () => {
  const setupIdx = indexCode.indexOf("function setupNode");
  const setupBody = indexCode.slice(setupIdx, indexCode.indexOf("\n}", setupIdx));
  assert.match(setupBody, /scheduleInitialFit\(/);
  assert.ok(!/scheduleRefit\(/.test(setupBody), "setupNode must use the GUARDED initial fit, not scheduleRefit");
});

test("index.js's restoreNode never calls scheduleRefit or scheduleInitialFit, and resyncs from widgets", () => {
  const idx = indexCode.indexOf("function restoreNode");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(!/scheduleRefit\(/.test(body));
  assert.ok(!/scheduleInitialFit\(/.test(body));
  assert.match(body, /refreshFromWidgets\(/);
});

test("index.js's onConfigure wrap sets _prConfigured = true BEFORE calling the original onConfigure or restoreNode", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onConfigure = function");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  const flagIdx = body.indexOf("_prConfigured = true");
  const origIdx = body.indexOf("originalOnConfigure.apply");
  const restoreIdx = body.indexOf("restoreNode(this)");
  assert.ok(flagIdx >= 0);
  assert.ok(origIdx > flagIdx);
  assert.ok(restoreIdx > flagIdx);
});

test("addOpenRuleBuilderButton keeps mode:\"embedded\", parseEmbedded, and onApply writing embedded_rules + setDirtyCanvas", () => {
  const idx = indexCode.indexOf("function addOpenRuleBuilderButton");
  const body = indexCode.slice(idx, indexCode.indexOf("\nfunction ", idx + 10));
  assert.match(body, /mode:\s*"embedded"/);
  assert.match(body, /parseEmbedded\(/);
  assert.match(body, /embeddedWidget\.value\s*=\s*JSON\.stringify\(ruleset\)/);
  assert.match(body, /node\.setDirtyCanvas\(true,\s*true\)/);
});

test("addPickerButton keeps getPositiveWidget/getNegativeWidget and resyncs the DOM via refreshFromWidgets on close", () => {
  const idx = indexCode.indexOf("function addPickerButton");
  const body = indexCode.slice(idx, indexCode.indexOf("\nfunction ", idx + 10));
  assert.match(body, /getPositiveWidget:\s*\(\)\s*=>\s*findWidget\(node,\s*"positive"\)/);
  assert.match(body, /getNegativeWidget:\s*\(\)\s*=>\s*findWidget\(node,\s*"negative"\)/);
  assert.match(body, /onClose:\s*\(\)\s*=>\s*refreshFromWidgets\(node,\s*refs\)/);
});

test("index.js never hides or manages the clip socket as if it were a widget", () => {
  assert.ok(!/"clip"/.test(indexCode));
});

test("index.js imports attachHighlighting/teardownHighlighting from ./highlight_wiring.mjs", () => {
  assert.match(indexSource, /from\s+"\.\/highlight_wiring\.mjs"/);
  assert.match(indexCode, /attachHighlighting/);
  assert.match(indexCode, /teardownHighlighting/);
});

test("index.js loads the shared highlighter via a GUARDED dynamic import, never a static top-level import", () => {
  // A static top-level `import ... from ".../shared/highlight/index.mjs"`
  // would throw at EXTENSION LOAD TIME if the route is missing/broken (an
  // older install, a dropped route), taking the whole node down with it --
  // must be a dynamic `import()` inside a `.catch()` instead.
  const staticImportLines = indexSource
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line));
  assert.ok(
    staticImportLines.every((line) => !/shared\/highlight/.test(line)),
    "found a static top-level import of the highlight module",
  );
  assert.match(indexCode, /import\(HIGHLIGHT_URL\)/);
  const wireIdx = indexCode.indexOf("function wireHighlighting");
  const wireBody = indexCode.slice(wireIdx, indexCode.indexOf("\nfunction ", wireIdx + 10));
  assert.match(wireBody, /\.catch\(/, "expected the dynamic import to be non-fatal via .catch()");
  assert.match(wireBody, /attachHighlighting\(node,\s*refs/);
});

test("index.js's mountUI wires highlighting AFTER refreshFromWidgets", () => {
  const idx = indexCode.indexOf("function mountUI");
  const body = indexCode.slice(idx, indexCode.indexOf("\nfunction ", idx + 10));
  const refreshIdx = body.indexOf("refreshFromWidgets(node, refs)");
  const wireIdx = body.indexOf("wireHighlighting(node, refs)");
  assert.ok(refreshIdx >= 0, "expected mountUI to call refreshFromWidgets");
  assert.ok(wireIdx >= 0, "expected mountUI to call wireHighlighting");
  assert.ok(wireIdx > refreshIdx, "wireHighlighting must run after the initial refreshFromWidgets");
});

test("index.js's onRemoved hook tears down highlighting via teardownHighlighting before the original onRemoved", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onRemoved = function");
  assert.ok(idx >= 0, "expected an onRemoved hook wrapping the node type");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  assert.match(body, /teardownHighlighting\(/);
  const teardownIdx = body.indexOf("teardownHighlighting(");
  const originalIdx = body.indexOf("originalOnRemoved");
  assert.ok(originalIdx > teardownIdx, "teardown must run before falling through to the original onRemoved");
});

test("index.js imports installCanvasZoomPassthrough from the shared js/shared/canvas_zoom.mjs (relative, not guarded -- the module has no app/window at module scope)", () => {
  assert.match(indexSource, /from\s+"\.\.\/\.\.\/shared\/canvas_zoom\.mjs"/);
  assert.match(indexCode, /installCanvasZoomPassthrough/);
});

test("index.js's mountUI installs the zoom passthrough on refs.root and stashes the uninstall fn on refs", () => {
  const idx = indexCode.indexOf("function mountUI");
  const body = indexCode.slice(idx, indexCode.indexOf("\nfunction ", idx + 10));
  assert.match(body, /refs\.uninstallZoom\s*=\s*installCanvasZoomPassthrough\(\s*refs\.root/);
});

test("index.js's onRemoved hook calls refs.uninstallZoom", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onRemoved = function");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  assert.match(body, /_prRefs\.uninstallZoom/);
});

// =========================================================================
// H. Wheel-zoom passthrough (js/shared/canvas_zoom.mjs) integration --
// the generic per-direction scroll matrix is covered exhaustively in
// js/shared/test_canvas_zoom.mjs; this section proves the helper is wired
// onto the REAL root this node builds, and -- the part that matters most
// here -- that a long PROMPT TEXTAREA (`.wtn-pr-textarea`, overflow-y:auto,
// max-height:280px in render.mjs) keeps the wheel while it still has room to
// scroll, and only passes it through (to zoom) once scrolled to its end.
// =========================================================================

// Minimal WheelEvent polyfill -- canvas_zoom.mjs's re-dispatch constructs a
// real `new WheelEvent(...)`, which doesn't exist under plain `node`.
if (typeof globalThis.WheelEvent === "undefined") {
  globalThis.WheelEvent = function WheelEvent(type, opts) {
    this.type = type;
    Object.assign(this, opts);
  };
}

function fireWheelOn(root, target, deltaY) {
  let prevented = false;
  const e = {
    type: "wheel",
    target,
    clientX: 0,
    clientY: 0,
    deltaX: 0,
    deltaY,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  };
  (root._listeners.wheel || []).forEach((fn) => fn(e));
  return prevented;
}

test("a textarea WITH ROOM to scroll keeps the wheel (no preventDefault, canvas untouched)", () => {
  const refs = makeMountedRefs();
  const canvas = { dispatchEvent() {} };
  installCanvasZoomPassthrough(refs.root, () => canvas);

  refs.positiveTextarea.style.overflowY = "auto";
  refs.positiveTextarea.scrollTop = 10;
  refs.positiveTextarea.scrollHeight = 300; // exceeds max-height -- genuinely scrollable
  refs.positiveTextarea.clientHeight = 100; // 10 + 100 = 110 < 299 -- not at the bottom yet

  const prevented = fireWheelOn(refs.root, refs.positiveTextarea, 50); // wheel down
  assert.equal(prevented, false, "expected the textarea to keep the wheel (scroll), not the canvas");
});

test("the SAME textarea scrolled to its bottom passes the wheel through (canvas zooms instead)", () => {
  const refs = makeMountedRefs();
  let dispatched = null;
  const canvas = { dispatchEvent: (e) => { dispatched = e; } };
  installCanvasZoomPassthrough(refs.root, () => canvas);

  refs.positiveTextarea.style.overflowY = "auto";
  refs.positiveTextarea.scrollHeight = 300;
  refs.positiveTextarea.clientHeight = 100;
  refs.positiveTextarea.scrollTop = 200; // 200 + 100 = 300 -- pinned at the bottom

  const prevented = fireWheelOn(refs.root, refs.positiveTextarea, 50); // wheel down, past the end
  assert.ok(prevented, "expected the wheel to pass through to the canvas once scrolled to the end");
  assert.ok(dispatched, "expected a synthetic wheel dispatched at the canvas");
});

test("a textarea that fits its content entirely (no real scrollbar) never keeps the wheel", () => {
  const refs = makeMountedRefs();
  let dispatched = null;
  const canvas = { dispatchEvent: (e) => { dispatched = e; } };
  installCanvasZoomPassthrough(refs.root, () => canvas);

  refs.positiveTextarea.style.overflowY = "auto";
  refs.positiveTextarea.scrollHeight = 90; // <= clientHeight -- nothing to scroll
  refs.positiveTextarea.clientHeight = 100;
  refs.positiveTextarea.scrollTop = 0;

  const prevented = fireWheelOn(refs.root, refs.positiveTextarea, 50);
  assert.ok(prevented);
  assert.ok(dispatched);
});

test("wheeling over the rest of the node body (not over either textarea) always reaches the canvas", () => {
  const refs = makeMountedRefs();
  let dispatched = null;
  const canvas = { dispatchEvent: (e) => { dispatched = e; } };
  installCanvasZoomPassthrough(refs.root, () => canvas);

  const prevented = fireWheelOn(refs.root, refs.root, 50);
  assert.ok(prevented);
  assert.ok(dispatched);
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
