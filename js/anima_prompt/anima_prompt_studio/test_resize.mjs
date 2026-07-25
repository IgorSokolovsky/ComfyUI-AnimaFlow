/**
 * test_resize.mjs — regression tests for the Anima Prompt Studio frontend:
 *
 *   A. `core.mjs` pure state — block construction/normalization/parsing
 *      mirror `_anima_prompt_studio_helpers.py`'s schema 1:1 (unknown type
 *      -> general, missing enabled/pin/text/label defaulted, tolerant
 *      `parseBlocksState` never throws), and every mutation
 *      (add/remove/move/toggle-enabled/toggle-pin) produces the expected
 *      state shape.
 *   B. `core.mjs` assembly — `assemblePaneSegments`/`substituteRest`/
 *      `assemblePanePreview` mirror the Python position-preserving pin/rest
 *      algorithm exactly (pin-before-rest, pin-after-rest, pin-interleaved,
 *      all-pinned, non-comma separators — same cases as
 *      `tests/test_anima_prompt_studio.py`).
 *   C. Resize mechanism (ComfyUI-Pixaroma find_replace mechanism, matched
 *      exactly — mirrors `js/anima_prompt/prompt_combiner/test_resize.mjs` /
 *      `js/anima/anima_preview/render.mjs`): `measureMinHeight`/`setNodeHeight`/
 *      `refitNode`/`scheduleRefit`/`scheduleInitialFit`.
 *   D. `render.mjs` DOM behavior — `renderPane` builds one row per block
 *      (correct badge/label/tools state), `updateBlockRow` updates a single
 *      row in place without touching its siblings, `renderPreview` shows
 *      the uncorrected assembly and appends the "(uncorrected)" note only
 *      when `rulesCorrectionEnabled` is true, `setRulesToggleUI` reflects
 *      on/off.
 *   E. `interaction.mjs` structural-vs-in-place gating — THE core
 *      requirement of this node's build: add/remove/reorder call
 *      `scheduleRefit` exactly once; toggle-enabled/toggle-pin/label-edit/
 *      text-edit do NOT; the one-trigger-per-pane add-button guard is a
 *      UI-level no-op (never touches state a second time).
 *   F. `index.js` source-level assertions (same reason as
 *      `js/anima_prompt/prompt_combiner/test_resize.mjs`: `app` resolves only inside a
 *      real ComfyUI/browser host) — widget sizing wiring, hide-and-mirror
 *      of `blocks_state`/`rules_correction_enabled`, the guarded initial
 *      fit vs. unconditional refit split, and that `restoreNode` never
 *      resizes.
 *
 * Run directly: `node js/anima_prompt/anima_prompt_studio/test_resize.mjs` (plain
 * script, no test framework — matches the project's `python
 * tests/test_x.py` convention).
 *
 * MANUAL-IN-COMFYUI CHECKLIST (cannot be confirmed by this headless
 * harness — the real `addDOMWidget`/LiteGraph runtime contract only exists
 * live):
 *   [ ] Adding/removing/reordering a block resizes the node (grows or
 *       shrinks to fit); toggling enable/pin does NOT resize; typing in a
 *       block's textarea only grows that textarea, up to its own max-height
 *       (then scrolls internally) — never the node.
 *   [ ] The Rules correction switch flips the native
 *       `rules_correction_enabled` widget and the LIVE PREVIEW gets the
 *       "(uncorrected)" note.
 *   [ ] Saving a workflow with edited blocks, then reloading the page,
 *       restores exactly the same blocks (no dupes) at the saved node size.
 *   [ ] Queueing the node produces the real (possibly Rules-corrected)
 *       `positive`/`negative` STRING outputs, matching
 *       `_anima_prompt_studio_helpers.build_prompt_studio_output`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  BLOCK_TYPES,
  TYPE_LABELS,
  resetBlockIdCounter,
  makeBlock,
  defaultBlocksState,
  normalizeBlock,
  parseBlocksState,
  serializeBlocksState,
  addBlock,
  removeBlock,
  moveBlock,
  toggleEnabled,
  togglePin,
  setBlockText,
  setBlockLabel,
  findBlock,
  hasTriggerBlock,
  assemblePaneSegments,
  substituteRest,
  assemblePanePreview,
  assembleBothPanesPreview,
} from "./core.mjs";

import {
  buildRoot,
  injectStyles,
  renderPane,
  updateBlockRow,
  renderPreview,
  setRulesToggleUI,
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
  getSeparator,
  getRulesCorrectionEnabled,
  syncBlocksStateWidget,
  createRowHandlers,
  wireInteractions,
  renderAllPanes,
} from "./interaction.mjs";

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

// ---- Minimal DOM stub (mirrors js/anima_prompt/prompt_combiner/test_resize.mjs's) ---

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
      get ownerDocument() {
        return doc;
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

function makeFakeNode(initialSize, widgetValues) {
  const setSizeCalls = [];
  const widgets = Object.entries(widgetValues || {}).map(([name, value]) => ({ name, value }));
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

// =========================================================================
// A. core.mjs — block construction / normalization / parsing
// =========================================================================

test("BLOCK_TYPES/TYPE_LABELS cover the four known block types", () => {
  assert.deepEqual(BLOCK_TYPES, ["quality", "artist", "trigger", "general"]);
  BLOCK_TYPES.forEach((t) => assert.ok(TYPE_LABELS[t]));
});

test("makeBlock defaults an unrecognized type to general", () => {
  const b = makeBlock("mystery");
  assert.equal(b.type, "general");
});

test("makeBlock pins a trigger block by default, not other types", () => {
  resetBlockIdCounter();
  assert.equal(makeBlock("trigger").pin, true);
  assert.equal(makeBlock("general").pin, false);
  assert.equal(makeBlock("quality").pin, false);
  assert.equal(makeBlock("artist").pin, false);
});

test("makeBlock produces unique, non-empty ids across calls", () => {
  resetBlockIdCounter();
  const a = makeBlock("general");
  const b = makeBlock("general");
  assert.ok(a.id && b.id && a.id !== b.id);
});

test("defaultBlocksState mirrors the Python seed shape (4 positive, 1 negative)", () => {
  const state = defaultBlocksState();
  assert.equal(state.positive.length, 4);
  assert.equal(state.negative.length, 1);
  assert.deepEqual(
    state.positive.map((b) => b.type),
    ["quality", "artist", "trigger", "general"],
  );
  assert.equal(state.positive[2].pin, true, "the seed LoRA trigger block is pinned");
});

test("normalizeBlock defaults an unrecognized type to general", () => {
  const b = normalizeBlock({ id: "x", type: "mystery", text: "t" });
  assert.equal(b.type, "general");
});

test("normalizeBlock defaults missing enabled/pin/text/label", () => {
  const b = normalizeBlock({ id: "x", type: "quality" });
  assert.equal(b.enabled, true);
  assert.equal(b.pin, false);
  assert.equal(b.text, "");
  assert.equal(b.label, "");
});

test("normalizeBlock preserves an explicit enabled:false / pin:true", () => {
  const b = normalizeBlock({ id: "x", type: "general", enabled: false, pin: true });
  assert.equal(b.enabled, false);
  assert.equal(b.pin, true);
});

test("parseBlocksState returns the empty shape for malformed JSON (never throws)", () => {
  assert.deepEqual(parseBlocksState("{not valid"), { positive: [], negative: [] });
});

test("parseBlocksState returns the empty shape for a JSON array/string/number/null", () => {
  assert.deepEqual(parseBlocksState(JSON.stringify([1, 2])), { positive: [], negative: [] });
  assert.deepEqual(parseBlocksState(JSON.stringify("x")), { positive: [], negative: [] });
  assert.deepEqual(parseBlocksState(JSON.stringify(42)), { positive: [], negative: [] });
  assert.deepEqual(parseBlocksState(""), { positive: [], negative: [] });
  assert.deepEqual(parseBlocksState(null), { positive: [], negative: [] });
});

test("parseBlocksState drops non-object pane entries", () => {
  const state = parseBlocksState(
    JSON.stringify({ positive: [{ id: "p1", type: "general" }, "nope", 5, null], negative: [] }),
  );
  assert.equal(state.positive.length, 1);
  assert.equal(state.positive[0].id, "p1");
});

test("serializeBlocksState round-trips through parseBlocksState", () => {
  const state = { positive: [makeBlock("general", "a")], negative: [makeBlock("general", "b")] };
  const round = parseBlocksState(serializeBlocksState(state));
  assert.equal(round.positive[0].text, "a");
  assert.equal(round.negative[0].text, "b");
});

// =========================================================================
// A2. core.mjs — mutations
// =========================================================================

test("addBlock appends a new block to the given pane", () => {
  const state = { positive: [], negative: [] };
  const b = addBlock(state, "positive", "quality");
  assert.equal(state.positive.length, 1);
  assert.equal(state.positive[0].id, b.id);
  assert.equal(state.positive[0].type, "quality");
});

test("addBlock never enforces one-trigger-per-pane itself (UI-level guard only)", () => {
  const state = { positive: [], negative: [] };
  addBlock(state, "positive", "trigger");
  addBlock(state, "positive", "trigger");
  assert.equal(state.positive.filter((b) => b.type === "trigger").length, 2);
});

test("removeBlock removes the matching block and returns true", () => {
  const state = { positive: [makeBlock("general", "a")], negative: [] };
  const id = state.positive[0].id;
  assert.equal(removeBlock(state, "positive", id), true);
  assert.equal(state.positive.length, 0);
});

test("removeBlock returns false for an unknown id", () => {
  const state = { positive: [makeBlock("general", "a")], negative: [] };
  assert.equal(removeBlock(state, "positive", "nope"), false);
  assert.equal(state.positive.length, 1);
});

test("moveBlock swaps two adjacent blocks", () => {
  const a = makeBlock("general", "a");
  const b = makeBlock("general", "b");
  const state = { positive: [a, b], negative: [] };
  assert.equal(moveBlock(state, "positive", b.id, "up"), true);
  assert.deepEqual(state.positive.map((x) => x.id), [b.id, a.id]);
});

test("moveBlock is a no-op (returns false) at the top/bottom boundary", () => {
  const a = makeBlock("general", "a");
  const b = makeBlock("general", "b");
  const state = { positive: [a, b], negative: [] };
  assert.equal(moveBlock(state, "positive", a.id, "up"), false);
  assert.equal(moveBlock(state, "positive", b.id, "down"), false);
  assert.deepEqual(state.positive.map((x) => x.id), [a.id, b.id]);
});

test("toggleEnabled flips enabled and returns true", () => {
  const b = makeBlock("general", "a");
  const state = { positive: [b], negative: [] };
  assert.equal(toggleEnabled(state, "positive", b.id), true);
  assert.equal(findBlock(state, "positive", b.id).enabled, false);
  toggleEnabled(state, "positive", b.id);
  assert.equal(findBlock(state, "positive", b.id).enabled, true);
});

test("togglePin flips pin and returns true", () => {
  const b = makeBlock("general", "a");
  const state = { positive: [b], negative: [] };
  assert.equal(togglePin(state, "positive", b.id), true);
  assert.equal(findBlock(state, "positive", b.id).pin, true);
});

test("setBlockText/setBlockLabel update in place, return false for unknown id", () => {
  const b = makeBlock("general", "a");
  const state = { positive: [b], negative: [] };
  assert.equal(setBlockText(state, "positive", b.id, "new text"), true);
  assert.equal(findBlock(state, "positive", b.id).text, "new text");
  assert.equal(setBlockLabel(state, "positive", b.id, "New Label"), true);
  assert.equal(findBlock(state, "positive", b.id).label, "New Label");
  assert.equal(setBlockText(state, "positive", "nope", "x"), false);
});

test("hasTriggerBlock reflects the pane's current blocks", () => {
  const state = { positive: [makeBlock("trigger", "t")], negative: [] };
  assert.equal(hasTriggerBlock(state, "positive"), true);
  assert.equal(hasTriggerBlock(state, "negative"), false);
});

// =========================================================================
// B. core.mjs — assembly (mirrors _anima_prompt_studio_helpers.py exactly)
// =========================================================================

function block(text, opts = {}) {
  return { id: opts.id || "x", type: opts.type || "general", label: "", text, enabled: opts.enabled !== false, pin: !!opts.pin };
}

test("assemblePaneSegments: pin before rest", () => {
  const blocks = [block("pinned-a", { pin: true }), block("rest-a"), block("rest-b")];
  const { segments, restRaw } = assemblePaneSegments(blocks, ", ");
  assert.deepEqual(segments, [["pin", "pinned-a"], ["rest", null]]);
  assert.equal(restRaw, "rest-a, rest-b");
});

test("assemblePaneSegments: pin interleaved on both sides of rest preserves position", () => {
  const blocks = [
    block("pin-1", { pin: true }),
    block("rest-a"),
    block("pin-2", { pin: true }),
    block("rest-b"),
    block("pin-3", { pin: true }),
  ];
  const { segments, restRaw } = assemblePaneSegments(blocks, ", ");
  assert.deepEqual(segments, [
    ["pin", "pin-1"],
    ["rest", null],
    ["pin", "pin-2"],
    ["pin", "pin-3"],
  ]);
  assert.equal(restRaw, "rest-a, rest-b");
});

test("assemblePaneSegments: disabled and blank-text blocks are skipped", () => {
  const blocks = [block("visible"), block("hidden", { enabled: false }), block("   ")];
  const { segments, restRaw } = assemblePaneSegments(blocks, ", ");
  assert.deepEqual(segments, [["rest", null]]);
  assert.equal(restRaw, "visible");
});

test("assemblePaneSegments: all blocks pinned yields no rest placeholder", () => {
  const blocks = [block("a", { pin: true }), block("b", { pin: true })];
  const { segments, restRaw } = assemblePaneSegments(blocks, ", ");
  assert.deepEqual(segments, [["pin", "a"], ["pin", "b"]]);
  assert.equal(restRaw, "");
});

test("assemblePaneSegments: non-comma separators are honored (no hardcoded comma-splitting)", () => {
  const blocks = [block("a"), block("b")];
  assert.equal(assemblePaneSegments(blocks, " ").restRaw, "a b");
  assert.equal(assemblePaneSegments(blocks, "\n").restRaw, "a\nb");
});

test("substituteRest: empty rest_corrected omits the segment; join skips blanks", () => {
  const segments = [["pin", "a"], ["rest", null], ["pin", "b"]];
  assert.equal(substituteRest(segments, "", ", "), "a, b");
  assert.equal(substituteRest([["pin", ""], ["rest", null]], "corrected", ", "), "corrected");
});

test("assemblePanePreview is the identity (uncorrected) assembly", () => {
  const blocks = [block("a", { pin: true }), block("b"), block("c")];
  // rest placeholder sits at "b"'s position, "c" folds in -> "a, b, c" order
  // becomes "a" (pin) then rest="b, c": overall "a, b, c".
  assert.equal(assemblePanePreview(blocks, ", "), "a, b, c");
});

test("assembleBothPanesPreview assembles both panes independently", () => {
  const state = { positive: [block("p")], negative: [block("n")] };
  const result = assembleBothPanesPreview(state, ", ");
  assert.equal(result.positive, "p");
  assert.equal(result.negative, "n");
});

// =========================================================================
// C. render.mjs — resize mechanism
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
  // 100 + 100 + 10 (1 gap) + 6 (padding) = 216 -> floored to 220.
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

test("setNodeHeight sets height only, preserves width, records _apsAutoH", () => {
  const { node, setSizeCalls } = makeFakeNode([420, 200], {});
  setNodeHeight(node, 500);
  assert.equal(node.size[0], 420);
  assert.equal(node.size[1], 500);
  assert.equal(node._apsAutoH, 500);
  assert.deepEqual(setSizeCalls[0], [420, 500]);
});

test("refitNode grows the node when measured content + CHROME exceeds current height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 800;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([420, 200], {});

  refitNode(node, root);

  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.ok(want > 200);
  assert.equal(setSizeCalls.length, 1);
  assert.equal(node.size[1], want);
  assert.equal(node.size[0], 420);
});

test("refitNode does not shrink a node the user manually enlarged past the last auto-fit height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([420, 900], {});
  node._apsAutoH = 300;

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
  const { node, setSizeCalls } = makeFakeNode([420, 200], {});

  scheduleRefit(node, root);
  assert.equal(setSizeCalls.length, 0);
  assert.equal(rafQueue.length, 1);
  flushRAF();
  assert.equal(setSizeCalls.length, 1);
});

test("scheduleInitialFit does not resize when node._apsConfigured is true (loaded node keeps saved size)", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([420, 260], {});
  node._apsConfigured = true;

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
  const { node, setSizeCalls } = makeFakeNode([420, 100], {});

  scheduleInitialFit(node, root);
  flushRAF();

  assert.equal(setSizeCalls.length, 1);
});

// =========================================================================
// D. render.mjs — DOM behavior
// =========================================================================

function makeMountedRefs() {
  const doc = makeDocStub();
  injectStyles(doc);
  return buildRoot(doc);
}

test("renderPane builds one row per block, empty-state message for an empty pane", () => {
  const refs = makeMountedRefs();
  const state = { positive: [makeBlock("quality", "q1"), makeBlock("general", "g1")], negative: [] };
  renderPane(refs, "positive", state, null);
  renderPane(refs, "negative", state, null);

  assert.equal(refs.panes.positive.rows.size, 2);
  assert.equal(refs.panes.positive.blocksEl.children.length, 2);
  assert.equal(refs.panes.negative.blocksEl.children.length, 1);
  assert.match(refs.panes.negative.blocksEl.children[0].textContent, /No blocks yet/);
  assert.equal(refs.panes.positive.countEl.textContent, "2 blocks");
});

test("renderPane disables the trigger add-button once the pane already has one", () => {
  const refs = makeMountedRefs();
  const state = { positive: [makeBlock("trigger", "t")], negative: [] };
  renderPane(refs, "positive", state, null);
  assert.equal(refs.panes.positive.addButtons.trigger.disabled, true);
});

test("renderPane leaves the trigger add-button enabled when the pane has none", () => {
  const refs = makeMountedRefs();
  const state = { positive: [makeBlock("general", "g")], negative: [] };
  renderPane(refs, "positive", state, null);
  assert.equal(refs.panes.positive.addButtons.trigger.disabled, false);
});

test("updateBlockRow updates only the target row's classes/icons, never rebuilds siblings", () => {
  const refs = makeMountedRefs();
  const a = makeBlock("general", "a");
  const b = makeBlock("general", "b");
  const state = { positive: [a, b], negative: [] };
  renderPane(refs, "positive", state, null);
  const rowAEl = refs.panes.positive.rows.get(a.id).row;
  const rowBEl = refs.panes.positive.rows.get(b.id).row;

  toggleEnabled(state, "positive", a.id);
  updateBlockRow(refs, "positive", findBlock(state, "positive", a.id));

  assert.equal(refs.panes.positive.rows.get(a.id).row, rowAEl, "same row element, no rebuild");
  assert.equal(refs.panes.positive.rows.get(b.id).row, rowBEl, "sibling untouched");
  assert.ok(rowAEl.classList.contains("wtn-aps-block-disabled"));
  assert.ok(!rowBEl.classList.contains("wtn-aps-block-disabled"));
});

test("renderPreview shows the uncorrected assembly and omits the note when correction is off", () => {
  const refs = makeMountedRefs();
  const state = { positive: [makeBlock("general", "a")], negative: [makeBlock("general", "b")] };
  renderPreview(refs, state, ", ", false);
  assert.equal(refs.posOutEl.innerHTML, "a");
  assert.equal(refs.negOutEl.innerHTML, "b");
  assert.ok(!/uncorrected/.test(refs.previewTitleEl.innerHTML));
});

test("renderPreview appends an explicit (uncorrected) note when correction is on", () => {
  const refs = makeMountedRefs();
  const state = { positive: [makeBlock("general", "a")], negative: [] };
  renderPreview(refs, state, ", ", true);
  assert.match(refs.previewTitleEl.innerHTML, /uncorrected/);
});

test("renderPreview shows the empty placeholder for an empty pane", () => {
  const refs = makeMountedRefs();
  renderPreview(refs, { positive: [], negative: [] }, ", ", false);
  assert.match(refs.posOutEl.innerHTML, /wtn-aps-outbox-empty/);
});

test("setRulesToggleUI reflects on/off in the switch class + chip text", () => {
  const refs = makeMountedRefs();
  setRulesToggleUI(refs, true);
  assert.ok(refs.switchEl.classList.contains("wtn-aps-switch-on"));
  assert.equal(refs.chip.textContent, "Rules: on");
  setRulesToggleUI(refs, false);
  assert.ok(!refs.switchEl.classList.contains("wtn-aps-switch-on"));
  assert.equal(refs.chip.textContent, "Rules: off");
});

test("autoGrowTextarea clamps between its min and max height", () => {
  const ta = { style: {}, scrollHeight: 5 };
  autoGrowTextarea(ta);
  assert.equal(ta.style.height, "44px");
  ta.scrollHeight = 5000;
  autoGrowTextarea(ta);
  assert.equal(ta.style.height, "160px");
});

// =========================================================================
// E. interaction.mjs — structural-vs-in-place gating
// =========================================================================

function makeInteractionFixture(initialState) {
  resetRAF();
  const refs = makeMountedRefs();
  const { node, setSizeCalls } = makeFakeNode([420, 360], {
    blocks_state: JSON.stringify(initialState),
    separator: ", ",
    rules_correction_enabled: false,
  });
  node.properties.studioState = parseBlocksState(findWidget(node, "blocks_state").value);
  wireInteractions(node, refs);
  renderAllPanes(node, refs);
  return { node, refs, setSizeCalls };
}

test("findWidget/getSeparator/getRulesCorrectionEnabled read the node's live widget values", () => {
  const { node } = makeInteractionFixture({ positive: [], negative: [] });
  assert.equal(getSeparator(node), ", ");
  assert.equal(getRulesCorrectionEnabled(node), false);
  findWidget(node, "rules_correction_enabled").value = true;
  assert.equal(getRulesCorrectionEnabled(node), true);
});

test("clicking a pane's add-row button is STRUCTURAL: adds a block, syncs the widget, schedules exactly one refit", () => {
  const { node, refs } = makeInteractionFixture({ positive: [], negative: [] });
  resetRAF();

  fire(refs.panes.positive.addButtons.general, "click");

  assert.equal(node.properties.studioState.positive.length, 1);
  const synced = parseBlocksState(findWidget(node, "blocks_state").value);
  assert.equal(synced.positive.length, 1, "blocks_state widget must be re-synced");
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
});

test("the one-trigger-per-pane add-button guard is a UI-level no-op (no second trigger added)", () => {
  const { node, refs } = makeInteractionFixture({ positive: [], negative: [] });
  resetRAF();

  fire(refs.panes.positive.addButtons.trigger, "click");
  assert.equal(node.properties.studioState.positive.length, 1);
  assert.equal(refs.panes.positive.addButtons.trigger.disabled, true);

  fire(refs.panes.positive.addButtons.trigger, "click");
  assert.equal(
    node.properties.studioState.positive.filter((b) => b.type === "trigger").length,
    1,
    "a second trigger click must not add another trigger block",
  );
  flushRAF();
});

test("onDelete (via a row's delete button) is STRUCTURAL: removes the block, schedules exactly one refit", () => {
  const seed = { positive: [makeBlock("general", "a"), makeBlock("general", "b")], negative: [] };
  const { node, refs } = makeInteractionFixture(seed);
  const idToDelete = node.properties.studioState.positive[0].id;
  resetRAF();

  fire(refs.panes.positive.rows.get(idToDelete).delBtn, "click");

  assert.equal(node.properties.studioState.positive.length, 1);
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("onMove (via a row's up/down button) is STRUCTURAL: reorders, schedules exactly one refit", () => {
  const seed = { positive: [makeBlock("general", "a"), makeBlock("general", "b")], negative: [] };
  const { node, refs } = makeInteractionFixture(seed);
  const secondId = node.properties.studioState.positive[1].id;
  resetRAF();

  fire(refs.panes.positive.rows.get(secondId).upBtn, "click");

  assert.equal(node.properties.studioState.positive[0].id, secondId);
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("onToggleEnabled/onTogglePin (via a row's tool icons) are NOT structural: no refit scheduled", () => {
  const seed = { positive: [makeBlock("general", "a")], negative: [] };
  const { node, refs } = makeInteractionFixture(seed);
  const id = node.properties.studioState.positive[0].id;
  resetRAF();

  fire(refs.panes.positive.rows.get(id).toggleBtn, "click");
  fire(refs.panes.positive.rows.get(id).pinBtn, "click");

  assert.equal(node.properties.studioState.positive[0].enabled, false);
  assert.equal(node.properties.studioState.positive[0].pin, true);
  assert.equal(rafQueue.length, 0, "toggle-enabled/pin must never schedule a refit");
});

test("editing a block's textarea (content edit) is NOT structural: no refit, widget synced, preview updates", () => {
  const seed = { positive: [makeBlock("general", "a")], negative: [] };
  const { node, refs } = makeInteractionFixture(seed);
  const id = node.properties.studioState.positive[0].id;
  resetRAF();

  const entry = refs.panes.positive.rows.get(id);
  entry.textarea.value = "changed text";
  fire(entry.textarea, "input");

  assert.equal(node.properties.studioState.positive[0].text, "changed text");
  assert.equal(rafQueue.length, 0, "a textarea content edit must never schedule a refit");
  const synced = parseBlocksState(findWidget(node, "blocks_state").value);
  assert.equal(synced.positive[0].text, "changed text");
  assert.equal(refs.posOutEl.innerHTML, "changed text");
});

test("editing a block's label is NOT structural and does not touch the LIVE PREVIEW", () => {
  const seed = { positive: [makeBlock("general", "a")], negative: [] };
  const { node, refs } = makeInteractionFixture(seed);
  const id = node.properties.studioState.positive[0].id;
  const previewBefore = refs.posOutEl.innerHTML;
  resetRAF();

  const entry = refs.panes.positive.rows.get(id);
  entry.labelInput.value = "My Label";
  fire(entry.labelInput, "input");

  assert.equal(node.properties.studioState.positive[0].label, "My Label");
  assert.equal(rafQueue.length, 0);
  assert.equal(refs.posOutEl.innerHTML, previewBefore, "label edits never change assembled text");
});

test("createRowHandlers caches itself on refs.rowHandlers", () => {
  const refs = makeMountedRefs();
  const { node } = makeFakeNode([420, 360], { blocks_state: "{}" });
  node.properties.studioState = { positive: [], negative: [] };
  const handlers = createRowHandlers(node, refs);
  assert.equal(refs.rowHandlers, handlers);
});

test("wireInteractions is idempotent (a second call is a no-op)", () => {
  const { node, refs } = makeInteractionFixture({ positive: [], negative: [] });
  const before = refs.rowHandlers;
  wireInteractions(node, refs);
  assert.equal(refs.rowHandlers, before);
});

test("clicking the Rules correction switch flips the native widget and updates the toggle UI + preview note", () => {
  const seed = { positive: [makeBlock("general", "a")], negative: [] };
  const { node, refs } = makeInteractionFixture(seed);
  assert.equal(getRulesCorrectionEnabled(node), false);

  fire(refs.switchEl, "click");

  assert.equal(getRulesCorrectionEnabled(node), true);
  assert.ok(refs.switchEl.classList.contains("wtn-aps-switch-on"));
  assert.match(refs.previewTitleEl.innerHTML, /uncorrected/);
});

test("syncBlocksStateWidget mirrors node.properties.studioState onto the blocks_state widget", () => {
  const { node } = makeInteractionFixture({ positive: [], negative: [] });
  node.properties.studioState.positive.push(makeBlock("general", "manual"));
  syncBlocksStateWidget(node);
  const synced = parseBlocksState(findWidget(node, "blocks_state").value);
  assert.equal(synced.positive[0].text, "manual");
});

// =========================================================================
// F. index.js — source-level assertions
// =========================================================================

const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const indexCode = stripComments(indexSource);

test("index.js imports app from the absolute /scripts/app.js path", () => {
  assert.match(indexSource, /from\s+"\/scripts\/app\.js"/);
});

test("index.js hides both blocks_state and rules_correction_enabled widgets", () => {
  assert.match(indexCode, /hideWidget\(blocksStateWidget\)/);
  assert.match(indexCode, /hideWidget\(rulesWidget\)/);
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

test("index.js schedules the guarded initial fit in setupNode, never scheduleRefit there", () => {
  const setupIdx = indexCode.indexOf("function setupNode");
  const setupBody = indexCode.slice(setupIdx, indexCode.indexOf("\n}", setupIdx));
  assert.match(setupBody, /scheduleInitialFit\(/);
  assert.ok(!/scheduleRefit\(/.test(setupBody), "setupNode must use the GUARDED initial fit, not scheduleRefit");
});

test("index.js's restoreNode never calls scheduleRefit or scheduleInitialFit", () => {
  const idx = indexCode.indexOf("function restoreNode");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(!/scheduleRefit\(/.test(body));
  assert.ok(!/scheduleInitialFit\(/.test(body));
});

test("index.js's onConfigure wrap sets _apsConfigured = true BEFORE calling the original onConfigure or restoreNode", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onConfigure = function");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  const flagIdx = body.indexOf("_apsConfigured = true");
  const origIdx = body.indexOf("originalOnConfigure.apply");
  const restoreIdx = body.indexOf("restoreNode(this)");
  assert.ok(flagIdx >= 0);
  assert.ok(origIdx > flagIdx);
  assert.ok(restoreIdx > flagIdx);
});

test("index.js's restoreNode re-parses blocks_state via parseBlocksState and rebuilds both panes", () => {
  const idx = indexCode.indexOf("function restoreNode");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.match(body, /parseBlocksState\(/);
  assert.match(body, /renderAllPanes\(/);
});

test("index.js never implements a network call to /wtn/rules/preview (documented client-side-only preview)", () => {
  // Scoped to comment-stripped CODE, not indexSource — the module's own doc
  // comment legitimately NAMES the /wtn/rules/preview route as context for
  // why it's deliberately NOT called here; only actual code is asserted on.
  assert.ok(!/wtn\/rules\/preview/.test(indexCode));
  assert.ok(!/fetch\(/.test(indexCode));
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
