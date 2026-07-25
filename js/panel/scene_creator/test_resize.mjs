/**
 * test_resize.mjs — regression tests for the Scene Creator frontend:
 *
 *   A. Resize mechanism (ComfyUI-Pixaroma find_replace mechanism, matched
 *      EXACTLY, mirrors `js/anima_prompt/prompt_builder/test_resize.mjs` and
 *      `js/anima_prompt/prompt_combiner/test_resize.mjs`): `measureMinHeight` measures
 *      real, settled DOM content (skipping detached/hidden children),
 *      substitutes a small `PREVIEW_MIN` for the LIVE PREVIEW section's own
 *      (open-ended) `offsetHeight` so a long rendered scene can never
 *      inflate the floor it's measured against (no feedback loop, no
 *      bottom-clipping), floors at 180, and rounds to a 4px grid;
 *      `refitNode` grows the node when content needs more room, shrinks it
 *      to fit when the user hasn't manually enlarged it past the last
 *      auto-fit height, and never shrinks past a manual enlargement;
 *      `setNodeHeight` only ever touches `size[1]`; `scheduleRefit` always
 *      defers through `requestAnimationFrame`. The widget is created with
 *      the legacy `getMinHeight` option (NOT `computeSize`/`getHeight`), and
 *      `computeLayoutSize` reports `{minWidth: 1}` for the Nodes 2.0 path.
 *   B. SCENE FIELDS reconcile (`rebuildFields`) skips BOTH reserved tokens
 *      (`characters` AND `backgrounds`) entirely — neither is ever rendered
 *      as a field row.
 *   C. BACKGROUNDS: "＋ Add Background" adds a real input socket + a card and
 *      schedules exactly ONE structural refit; a card's ✕ removes both the
 *      socket and the card with exactly ONE refit; toggle/text edits do NOT
 *      resize.
 *   D. CHARACTERS: "＋ Add Character" adds a char socket + a DEFAULT OUTFIT
 *      socket + a card (with one outfit row) and schedules exactly ONE
 *      structural refit; a card's ✕ removes the char socket AND every one of
 *      its outfit sockets, with exactly ONE refit; the ON/OFF toggle flips
 *      `enabled` in state WITHOUT resizing.
 *   E. OUTFITS: "＋ outfit" adds a new outfit socket + row with exactly ONE
 *      refit; an outfit row's ✕ removes its socket + row with exactly ONE
 *      refit; toggling/editing an outfit's text does NOT resize.
 *   F. `scene_state` delivery: a normal, natively-serialized required STRING
 *      widget (declared in `nodes/node_scene_creator.py`'s `INPUT_TYPES`,
 *      like `template`) that the frontend hides (`hidden=true`,
 *      `computeSize=()=>[0,-4]`, `inputEl.style.display="none"`) but NEVER
 *      marks `serialize=false` on, kept in sync with
 *      `node.properties.sceneState` by `syncStateWidget` after every
 *      mutation, and parsed back via `loadStateFromWidget` on mount/
 *      `onConfigure`. There is no `app.graphToPrompt` wrap anymore (the old
 *      hidden-INPUT + injection path, which did not reliably deliver
 *      `scene_state` in this ComfyUI, has been removed entirely).
 *   G. `onExecuted` fills the LIVE PREVIEW and stores `_sceneSlots`; a wired
 *      outfit shows the resolved-value chip, an unwired one shows its text
 *      input.
 *   H. `onConnectionsChange` flips an outfit row between its text input and
 *      its "🔗 wired" chip purely from the connection state, with no resize.
 *   I. `onConfigure` restore re-adds every socket (background/character/
 *      outfit) idempotently (`syncAllSockets`) — calling it twice against
 *      the same state never duplicates a slot — and never resizes.
 *
 * Run directly: `node js/panel/scene_creator/test_resize.mjs` (plain script, no
 * test framework — matches the project's `python test_*.py` convention).
 *
 * `index.js` itself imports `app` from the absolute ComfyUI host path
 * (`/scripts/app.js`), which only resolves inside a real ComfyUI/browser
 * host, so this harness exercises:
 *   - `render.mjs`'s and `interaction.mjs`'s pure, DOM-stub-testable
 *     functions directly (resize math, SCENE FIELDS reconcile, BACKGROUNDS/
 *     CHARACTERS/OUTFITS add/remove/toggle, wire-chip toggling, LIVE
 *     PREVIEW rendering), and
 *   - `index.js`'s source TEXT for the parts that can only run inside
 *     LiteGraph (the legacy `getMinHeight` + Nodes 2.0 `computeLayoutSize`
 *     widget wiring, the `_scBootstrapped`-guarded initial size floor, the
 *     `_scConfigured`-guarded initial fit (set at the very start of the
 *     `onConfigure` wrap, before the original/restoreNode run), the
 *     `scheduleRefit` triggers, the `onExecuted` wrapper, and the
 *     `graphToPrompt` `scene_state` injection).
 *
 * MANUAL-IN-COMFYUI CHECKLIST (cannot be confirmed by this headless
 * harness — the real `addDOMWidget`/LiteGraph runtime contract, and the
 * legacy-vs-Nodes-2.0 renderer split, only exist live):
 *   [ ] The node loads with no 404/module errors in the browser console for
 *       `/scripts/...` (absolute import works from the `js/panel/scene_creator/`
 *       subfolder).
 *   [ ] Typing `{weather}` into the TEMPLATE creates a "Weather" scene field
 *       row immediately; typing `{characters}` or `{backgrounds}` does NOT
 *       create a field row.
 *   [ ] "＋ Add Background" prompts for a name, creates a new input socket
 *       named `bg_N`, and a card appears with a connection dot, ON/OFF
 *       toggle, and a Details text field.
 *   [ ] "＋ Add Character" prompts for a name, creates a new input socket on
 *       the node named `char_N` PLUS a second socket named `outfit_M`, and a
 *       card appears with a connection dot, ON/OFF toggle, an Expression
 *       input, and one outfit row (with its own connection dot, text input,
 *       ON/OFF toggle, and ✕).
 *   [ ] "＋ outfit" inside a character card adds another `outfit_N` socket
 *       and row.
 *   [ ] Wiring a Prompt Builder's `prompt` output into a character's or
 *       background's identity socket lights up its connection dot green;
 *       wiring one into an OUTFIT's own socket hides that outfit's text
 *       input and shows a "🔗 wired" chip instead.
 *   [ ] Toggling a character/background/outfit OFF dims it and does NOT
 *       resize the node; toggling back ON un-dims it.
 *   [ ] Removing a character (✕) drops its socket AND every one of its
 *       outfit sockets (and their wires, if connected) plus its card, and
 *       the node resizes to fit. Removing a background or a single outfit
 *       behaves the same at its own scope.
 *   [ ] The node's HEIGHT grows/shrinks to fit content on each of: first
 *       drop, a scene-field/background/character/outfit add/remove, save+
 *       reload, and a run; its WIDTH never changes on its own, and dragging
 *       the node wider/narrower by hand sticks.
 *   [ ] Saving a workflow with backgrounds + characters (with multiple
 *       outfits) + scene fields, then reloading the page, restores exactly
 *       the same sockets + card state (no duplicates, wires intact, all
 *       text/enabled state preserved).
 *   [ ] Running the node (with at least one enabled, wired character) shows
 *       the real composed scene string in LIVE PREVIEW, the node resizes to
 *       fit it, every wired outfit's chip shows its resolved value, and
 *       every wired character/background shows its resolved-value hint
 *       under its name.
 *   [ ] Feeding the node's `scene` STRING output into a Show Text node (or
 *       inspecting the queued prompt payload) confirms the `scene_state`
 *       widget input arrives populated with the current
 *       fields/backgrounds/characters(+outfits) JSON.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildRoot,
  rebuildFields,
  rebuildBackgrounds,
  rebuildCharacters,
  refreshConnectionDots,
  refreshOutfitWireState,
  refreshIdentityHints,
  isSocketConnected,
  renderLivePreview,
  measureMinHeight,
  setNodeHeight,
  refitNode,
  scheduleRefit,
  scheduleInitialFit,
  computeClientSceneText,
  updateComputedPreview,
  CHROME,
  DEFAULT_W,
  DEFAULT_H,
  PREVIEW_MIN,
} from "./render.mjs";
import {
  wireInteractions,
  addCharacter,
  removeCharacter,
  addOutfit,
  removeOutfit,
  addBackground,
  removeBackground,
  syncAllSockets,
} from "./interaction.mjs";
import {
  ensureState,
  sceneFieldTokens,
  RESERVED_CHARACTERS_TOKEN,
  RESERVED_BACKGROUNDS_TOKEN,
  STATE_WIDGET_NAME,
  findStateWidget,
  syncStateWidget,
  loadStateFromWidget,
  assembleOutfitsBlock,
  assembleCharacters,
  assembleBackgroundBlock,
  renderCharacterParagraph,
  buildSceneText,
} from "./core.mjs";

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

// ---- Minimal DOM stub (mirrors js/anima_prompt/prompt_combiner/test_resize.mjs) -----

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

function makeFakeNode(initialSize, initialInputs) {
  const setSizeCalls = [];
  const node = {
    size: initialSize.slice(),
    properties: {},
    inputs: (initialInputs || []).map((i) => ({ ...i })),
    setSize(size) {
      setSizeCalls.push(size.slice());
      node.size = size.slice();
    },
    setDirtyCanvas() {},
    addInput(name, type) {
      node.inputs.push({ name, type, link: null });
    },
    removeInput(index) {
      node.inputs.splice(index, 1);
    },
  };
  return { node, setSizeCalls };
}

function inputNames(node) {
  return node.inputs.map((i) => i.name);
}

// ---- render.mjs: measureMinHeight ---------------------------------------

test("measureMinHeight returns 180 (the floor) for a missing root", () => {
  assert.equal(measureMinHeight(null), 180);
  assert.equal(measureMinHeight(undefined), 180);
});

test("measureMinHeight sums visible children offsetHeight + gap + padding", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  root.style.rowGap = "13px";
  root.style.paddingTop = "4px";
  root.style.paddingBottom = "2px";
  const child1 = doc.createElement("div");
  child1.offsetHeight = 100;
  child1.offsetParent = {};
  const child2 = doc.createElement("div");
  child2.offsetHeight = 50;
  child2.offsetParent = {};
  const child3 = doc.createElement("div");
  child3.offsetHeight = 30;
  child3.offsetParent = {};
  root.appendChild(child1);
  root.appendChild(child2);
  root.appendChild(child3);
  // 100 + 50 + 30 = 180 content, + 13px gap * 2 gaps = 26, + 6px padding =
  // 212, already a multiple of 4 and above the 180 floor -> unchanged.
  assert.equal(measureMinHeight(root), 212);
});

test("measureMinHeight floors at 180 when measured content is small", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 42;
  child.offsetParent = {};
  root.appendChild(child);
  assert.equal(measureMinHeight(root), 180);
});

test("measureMinHeight skips children whose offsetParent is null (hidden/detached)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const visible = doc.createElement("div");
  visible.offsetHeight = 100;
  visible.offsetParent = {};
  const hidden = doc.createElement("div");
  hidden.offsetHeight = 999;
  hidden.offsetParent = null;
  root.appendChild(visible);
  root.appendChild(hidden);
  assert.equal(measureMinHeight(root), 180);
});

test("measureMinHeight rounds the result to the nearest 4px grid", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 201; // -> Math.round(201/4)*4 = 200
  child.offsetParent = {};
  root.appendChild(child);
  assert.equal(measureMinHeight(root), 200);
});

test("measureMinHeight substitutes PREVIEW_MIN for the LIVE PREVIEW section instead of its real offsetHeight (no feedback loop)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const fixed = doc.createElement("div");
  fixed.offsetHeight = 120;
  fixed.offsetParent = {};
  const preview = doc.createElement("div");
  preview.offsetHeight = 5000; // a huge rendered scene
  preview.offsetParent = {};
  preview.classList.add("wsc-section-preview");
  root.appendChild(fixed);
  root.appendChild(preview);
  const result = measureMinHeight(root);
  assert.ok(result < 300, `expected the huge preview offsetHeight to be substituted, got ${result}`);
  assert.ok(result >= 220 - 4 && result <= 220 + 4, `expected ~220, got ${result}`);
  assert.equal(PREVIEW_MIN, 100);
});

test("measureMinHeight does NOT special-case a child lacking the wsc-section-preview class, even with a huge offsetHeight", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5000;
  child.offsetParent = {};
  root.appendChild(child);
  assert.equal(measureMinHeight(root), 5000);
});

// ---- render.mjs: setNodeHeight / refitNode / scheduleRefit -------------

test("setNodeHeight sets height only, preserves width, and records _scAutoH", () => {
  const { node, setSizeCalls } = makeFakeNode([321, 100]);
  setNodeHeight(node, 250);
  assert.equal(node.size[0], 321, "width must be untouched");
  assert.equal(node.size[1], 250);
  assert.equal(node._scAutoH, 250);
  assert.equal(setSizeCalls.length, 1);
  assert.deepEqual(setSizeCalls[0], [321, 250]);
});

test("refitNode is a no-op when root is missing", () => {
  const { node, setSizeCalls } = makeFakeNode([300, 200]);
  refitNode(node, null);
  assert.equal(setSizeCalls.length, 0);
});

test("refitNode grows the node when measured content + CHROME exceeds current height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 300;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 100]);

  refitNode(node, root);

  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.ok(want > 100);
  assert.equal(setSizeCalls.length, 1);
  assert.equal(node.size[1], want);
  assert.equal(node.size[0], 300, "width preserved");
});

test("refitNode does NOT shrink a node the user manually enlarged past the last auto-fit height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 500]);
  node._scAutoH = 200;

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0, "must not shrink a user-enlarged node");
  assert.equal(node.size[1], 500);
});

test("scheduleRefit defers through requestAnimationFrame — never resizes synchronously", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 300;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 50]);
  let dirtyCalls = 0;
  node.setDirtyCanvas = () => {
    dirtyCalls += 1;
  };
  resetRAF();

  scheduleRefit(node, root);
  assert.equal(setSizeCalls.length, 0, "must not resize before the rAF callback runs");
  assert.equal(rafQueue.length, 1, "expected exactly one rAF scheduled");

  flushRAF();
  assert.equal(setSizeCalls.length, 1, "resize happens once the rAF callback runs");
  assert.equal(dirtyCalls, 1);
});

// ---- render.mjs: scheduleInitialFit is GUARDED by node._scConfigured --
//
// Regression coverage for the "workflow reload snaps the node back to
// content size" bug: `onConfigure` (index.js) sets `node._scConfigured =
// true` synchronously, BEFORE the rAF this schedules ever fires, for any
// node being loaded from a saved workflow. The guard must live INSIDE the
// rAF callback (checked at fire time), not at schedule time.

test("scheduleInitialFit does NOT resize when node._scConfigured is true (a loaded node keeps its saved size)", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900; // content that would normally force a big grow
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 260]); // the "saved" size
  node._scConfigured = true; // onConfigure already ran (workflow load)

  scheduleInitialFit(node, root);
  assert.equal(setSizeCalls.length, 0, "must not resize synchronously");
  flushRAF();

  assert.equal(setSizeCalls.length, 0, "a loaded node's initial fit must not resize");
  assert.equal(node.size[1], 260, "the saved size must be preserved");
});

test("scheduleInitialFit DOES fit a genuinely fresh node (node._scConfigured never set)", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 100]);

  scheduleInitialFit(node, root);
  flushRAF();

  assert.equal(setSizeCalls.length, 1, "a fresh node's initial fit should size to content");
});

test("scheduleInitialFit defers through requestAnimationFrame — never resizes synchronously", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const { node, setSizeCalls } = makeFakeNode([300, 100]);

  scheduleInitialFit(node, root);
  assert.equal(setSizeCalls.length, 0);
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

// ---- core.mjs / render.mjs: SCENE FIELDS reconcile skips BOTH reserved
// tokens (`characters` AND `backgrounds`) --------------------------------

test("sceneFieldTokens excludes BOTH reserved tokens", () => {
  const tokens = sceneFieldTokens("{backgrounds}, {place}, {characters}, {lighting}");
  assert.deepEqual(tokens, ["place", "lighting"]);
  assert.ok(!tokens.includes(RESERVED_CHARACTERS_TOKEN));
  assert.ok(!tokens.includes(RESERVED_BACKGROUNDS_TOKEN));
});

test("rebuildFields never creates a row for `characters` or `backgrounds`", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  refs.templateEl.value = "{backgrounds}, {place}, {characters}, {lighting}";

  rebuildFields(node, refs);

  assert.deepEqual(Array.from(refs.fieldRows.keys()).sort(), ["lighting", "place"]);
  assert.ok(!refs.fieldRows.has("characters"));
  assert.ok(!refs.fieldRows.has("backgrounds"));
  assert.equal(refs.fieldCountEl.textContent, "2");
  flushRAF();
});

test("rebuildFields removes a row when its token is deleted from the template, keeping the cached value", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  refs.templateEl.value = "{place}, {lighting}";
  rebuildFields(node, refs);
  flushRAF();
  const state = ensureState(node);
  state.fields.lighting = "warm glow";

  refs.templateEl.value = "{place}";
  rebuildFields(node, refs);

  assert.ok(!refs.fieldRows.has("lighting"));
  assert.equal(state.fields.lighting, "warm glow", "cached value survives row removal");
  flushRAF();
});

test("rebuildFields schedules exactly one refit on the first build and on a structural change only", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  refs.templateEl.value = "{place}";

  rebuildFields(node, refs); // first build -> 1 refit
  assert.equal(rafQueue.length, 1);
  flushRAF();

  rebuildFields(node, refs); // same tokens -> no refit
  assert.equal(rafQueue.length, 0);

  refs.templateEl.value = "{place}, {lighting}";
  rebuildFields(node, refs); // structural add -> 1 refit
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("rebuildFields({ silent: true }) — the onConfigure restore path — never schedules any refit, even on a structural change", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 400], []);

  refs.templateEl.value = "{place}";
  rebuildFields(node, refs); // first build
  flushRAF();

  refs.templateEl.value = "{place}, {lighting}, {weather}"; // structural change
  rebuildFields(node, refs, { silent: true }); // simulates onConfigure's restore call

  assert.equal(rafQueue.length, 0, "the restore path must not schedule any refit");
});

test("onConfigure's restore call itself never calls setSize — the restored node.size is trusted", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 400], []);
  node._scConfigured = true; // onConfigure already set this before restoring

  refs.templateEl.value = "{place}, {lighting}, {weather}"; // the restored template
  rebuildFields(node, refs, { silent: true }); // restoreNode's call
  flushRAF(); // even if something were queued, flushing must not resize

  assert.equal(setSizeCalls.length, 0, "restore must never call setSize");
  assert.equal(node.size[1], 400, "the restored size must be untouched");
});

test("a structural SCENE FIELD add/remove AFTER onConfigure still schedules exactly one refit (post-load user actions are never gated by _scConfigured)", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  refs.root.children.forEach((child) => {
    child.offsetHeight = 260;
    child.offsetParent = {};
  });
  const { node, setSizeCalls } = makeFakeNode([300, 100], []);
  node._scConfigured = true; // node was loaded from a workflow

  refs.templateEl.value = "{place}";
  rebuildFields(node, refs, { silent: true }); // mirrors restoreNode's own rebuild
  flushRAF();
  setSizeCalls.length = 0;

  refs.templateEl.value = "{place}, {lighting}"; // the user adds a field post-load
  rebuildFields(node, refs); // a genuine, non-silent user structural action

  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
  assert.equal(setSizeCalls.length, 1, "a post-load add/remove must still resize exactly once");
});

// ---- interaction.mjs: BACKGROUNDS add/remove/toggle --------------------

test("addBackground adds one input socket + one card + schedules exactly one structural refit", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);

  const background = addBackground(node, refs, "Bedroom");

  assert.equal(background.socket, "bg_1");
  assert.deepEqual(inputNames(node), ["bg_1"]);
  assert.ok(refs.bgCards.has("bg_1"), "expected a card for the new background");
  assert.equal(refs.bgCountEl.textContent, "1");
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
});

test("removeBackground drops the socket (by name) and the card, scheduling exactly one refit", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addBackground(node, refs, "Bedroom");
  flushRAF();
  addBackground(node, refs, "Rooftop");
  flushRAF();

  removeBackground(node, refs, "bg_1");

  assert.deepEqual(inputNames(node), ["bg_2"], "bg_1's socket must be gone");
  assert.ok(!refs.bgCards.has("bg_1"), "bg_1's card must be gone");
  assert.ok(refs.bgCards.has("bg_2"), "bg_2 untouched");
  assert.equal(refs.bgCountEl.textContent, "1");
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("a background card's remove (X) button removes its socket + card via the wired handler", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addBackground(node, refs, "Bedroom");
  flushRAF();

  const entry = refs.bgCards.get("bg_1");
  fire(entry.removeBtn, "click");

  assert.deepEqual(inputNames(node), []);
  assert.ok(!refs.bgCards.has("bg_1"));
  flushRAF();
});

test("toggling a background's ON/OFF flips `enabled` in state WITHOUT scheduling a resize", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addBackground(node, refs, "Bedroom");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const state = ensureState(node);
  const entry = refs.bgCards.get("bg_1");

  fire(entry.toggleBtn, "click");

  assert.equal(state.backgrounds[0].enabled, false);
  assert.equal(rafQueue.length, 0, "toggling must never schedule a refit");
  assert.equal(setSizeCalls.length, 0, "toggling must never resize the node");
});

test("editing a background's Details text writes into state without resizing", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addBackground(node, refs, "Bedroom");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const entry = refs.bgCards.get("bg_1");
  entry.textInput.value = "bedroom interior, night";
  fire(entry.textInput, "input");

  const state = ensureState(node);
  assert.equal(state.backgrounds[0].text, "bedroom interior, night");
  assert.equal(rafQueue.length, 0);
  assert.equal(setSizeCalls.length, 0);
});

// ---- interaction.mjs: CHARACTERS add/remove/toggle (with default outfit) -

test("addCharacter adds a char socket + a DEFAULT OUTFIT socket + one card + schedules exactly one structural refit", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);

  const character = addCharacter(node, refs, "Yuna");

  assert.equal(character.socket, "char_1");
  assert.equal(character.outfits.length, 1);
  assert.equal(character.outfits[0].socket, "outfit_2");
  assert.deepEqual(inputNames(node), ["char_1", "outfit_2"]);
  assert.ok(refs.charCards.has("char_1"), "expected a card for the new character");
  const cardEntry = refs.charCards.get("char_1");
  assert.equal(cardEntry.outfitRows.size, 1, "expected one default outfit row");
  assert.ok(cardEntry.outfitRows.has("outfit_2"));
  assert.equal(refs.charCountEl.textContent, "1");
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
});

test("adding a second character assigns the next stable socket ids (no collision, shared nextId counter)", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);

  const first = addCharacter(node, refs, "Yuna");
  flushRAF();
  const second = addCharacter(node, refs, "Jae");
  flushRAF();

  assert.equal(first.socket, "char_1");
  assert.equal(first.outfits[0].socket, "outfit_2");
  assert.equal(second.socket, "char_3");
  assert.equal(second.outfits[0].socket, "outfit_4");
  assert.deepEqual(inputNames(node), ["char_1", "outfit_2", "char_3", "outfit_4"]);
});

test("removeCharacter drops the char socket AND its outfit socket(s) + the card, scheduling exactly one refit", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  addCharacter(node, refs, "Jae");
  flushRAF();
  // Give Yuna a second outfit so removal must drop BOTH her outfit sockets.
  addOutfit(node, refs, "char_1");
  flushRAF();
  assert.deepEqual(inputNames(node), ["char_1", "outfit_2", "char_3", "outfit_4", "outfit_5"]);

  removeCharacter(node, refs, "char_1");

  assert.deepEqual(inputNames(node), ["char_3", "outfit_4"], "char_1 + both its outfit sockets must be gone");
  assert.ok(!refs.charCards.has("char_1"), "char_1's card must be gone");
  assert.ok(refs.charCards.has("char_3"), "char_3 untouched");
  assert.equal(refs.charCountEl.textContent, "1");
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("a character card's remove (X) button removes its socket(s) + card via the wired handler", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();

  const entry = refs.charCards.get("char_1");
  fire(entry.removeBtn, "click");

  assert.deepEqual(inputNames(node), []);
  assert.ok(!refs.charCards.has("char_1"));
  flushRAF();
});

test("toggling a character's ON/OFF flips `enabled` in state WITHOUT scheduling a resize", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const state = ensureState(node);
  assert.equal(state.characters[0].enabled, true);
  const entry = refs.charCards.get("char_1");

  fire(entry.toggleBtn, "click");

  assert.equal(state.characters[0].enabled, false);
  assert.ok(entry.card.classList.contains("wsc-char-off"));
  assert.equal(entry.toggleBtn.textContent, "OFF");
  assert.equal(rafQueue.length, 0, "toggling must never schedule a refit");
  assert.equal(setSizeCalls.length, 0, "toggling must never resize the node");

  fire(entry.toggleBtn, "click");
  assert.equal(state.characters[0].enabled, true);
  assert.ok(entry.card.classList.contains("wsc-char-on"));
});

test("editing a character's Action writes into state without resizing", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const entry = refs.charCards.get("char_1");
  entry.actionInput.value = "shy smile";
  fire(entry.actionInput, "input");

  const state = ensureState(node);
  assert.equal(state.characters[0].action, "shy smile");
  assert.equal(rafQueue.length, 0);
  assert.equal(setSizeCalls.length, 0);
});

test("editing a character's Appearance writes into state without resizing", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const entry = refs.charCards.get("char_1");
  entry.appearanceInput.value = "tall, silver hair";
  fire(entry.appearanceInput, "input");

  const state = ensureState(node);
  assert.equal(state.characters[0].appearance, "tall, silver hair");
  assert.equal(rafQueue.length, 0);
  assert.equal(setSizeCalls.length, 0);
});

test("editing a character's Focus writes into state without resizing", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const entry = refs.charCards.get("char_1");
  entry.focusInput.value = "hands";
  fire(entry.focusInput, "input");

  const state = ensureState(node);
  assert.equal(state.characters[0].focus, "hands");
  assert.equal(rafQueue.length, 0);
  assert.equal(setSizeCalls.length, 0);
});

test("refreshConnectionDots reflects node.inputs link state onto each character card's dot", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  resetRAF();

  refreshConnectionDots(node, refs);
  assert.ok(!refs.charCards.get("char_1").dot.classList.contains("wsc-dot-on"));

  node.inputs[0].link = 7;
  refreshConnectionDots(node, refs);
  assert.ok(refs.charCards.get("char_1").dot.classList.contains("wsc-dot-on"));
});

// ---- interaction.mjs: OUTFITS add/remove/toggle (nested inside a character) --

test("addOutfit adds a new outfit socket + row to a character, scheduling exactly one structural refit", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  assert.deepEqual(inputNames(node), ["char_1", "outfit_2"]);

  const outfit = addOutfit(node, refs, "char_1");

  assert.equal(outfit.socket, "outfit_3");
  assert.deepEqual(inputNames(node), ["char_1", "outfit_2", "outfit_3"]);
  const cardEntry = refs.charCards.get("char_1");
  assert.equal(cardEntry.outfitRows.size, 2);
  assert.ok(cardEntry.outfitRows.has("outfit_3"));
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
});

test("removeOutfit drops one outfit's socket + row only, scheduling exactly one refit", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  addOutfit(node, refs, "char_1");
  flushRAF();
  assert.deepEqual(inputNames(node), ["char_1", "outfit_2", "outfit_3"]);

  removeOutfit(node, refs, "char_1", "outfit_2");

  assert.deepEqual(inputNames(node), ["char_1", "outfit_3"]);
  const cardEntry = refs.charCards.get("char_1");
  assert.equal(cardEntry.outfitRows.size, 1);
  assert.ok(!cardEntry.outfitRows.has("outfit_2"));
  assert.ok(cardEntry.outfitRows.has("outfit_3"));
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("an outfit row's remove (X) button removes its socket + row via the wired handler", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();

  const cardEntry = refs.charCards.get("char_1");
  const rowEntry = cardEntry.outfitRows.get("outfit_2");
  fire(rowEntry.removeBtn, "click");

  assert.deepEqual(inputNames(node), ["char_1"]);
  assert.equal(cardEntry.outfitRows.size, 0);
  flushRAF();
});

test("the '+ outfit' button adds a row via the wired handler", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();

  const cardEntry = refs.charCards.get("char_1");
  fire(cardEntry.addOutfitBtn, "click");
  flushRAF();

  assert.equal(cardEntry.outfitRows.size, 2);
  assert.deepEqual(inputNames(node), ["char_1", "outfit_2", "outfit_3"]);
});

test("toggling an outfit's ON/OFF flips `enabled` in state WITHOUT scheduling a resize", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const state = ensureState(node);
  const rowEntry = refs.charCards.get("char_1").outfitRows.get("outfit_2");

  fire(rowEntry.toggleBtn, "click");

  assert.equal(state.characters[0].outfits[0].enabled, false);
  assert.ok(rowEntry.row.classList.contains("wsc-outfit-off"));
  assert.equal(rowEntry.toggleBtn.textContent, "OFF");
  assert.equal(rafQueue.length, 0, "toggling an outfit must never schedule a refit");
  assert.equal(setSizeCalls.length, 0, "toggling an outfit must never resize the node");
});

test("editing an outfit's text writes into state without resizing", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const rowEntry = refs.charCards.get("char_1").outfitRows.get("outfit_2");
  rowEntry.textInput.value = "oversized shirt";
  fire(rowEntry.textInput, "input");

  const state = ensureState(node);
  assert.equal(state.characters[0].outfits[0].text, "oversized shirt");
  assert.equal(rafQueue.length, 0);
  assert.equal(setSizeCalls.length, 0);
});

// ---- render.mjs: wired-outfit chip vs text-input collapse --------------

test("an unwired outfit shows its text input; a wired outfit shows the '🔗 wired' chip (no resolved value yet)", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();

  const rowEntry = refs.charCards.get("char_1").outfitRows.get("outfit_2");
  assert.equal(rowEntry.textInput.style.display, "", "unwired outfit shows its text input");
  assert.equal(rowEntry.chipEl.style.display, "none");

  // Wire the outfit's own socket (simulates a connection landing on it).
  const idx = node.inputs.findIndex((i) => i.name === "outfit_2");
  node.inputs[idx].link = 42;

  refreshOutfitWireState(node, refs);

  assert.equal(rowEntry.textInput.style.display, "none", "wired outfit hides its text input");
  assert.equal(rowEntry.chipEl.style.display, "", "wired outfit shows the chip");
  assert.equal(rowEntry.chipEl.textContent, "🔗 wired");
});

test("onExecuted's slots populate a wired outfit's chip with the resolved value", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();

  const idx = node.inputs.findIndex((i) => i.name === "outfit_2");
  node.inputs[idx].link = 42;

  // Simulates index.js's onExecuted wrap: store _sceneSlots, then refresh.
  node._sceneSlots = { outfit_2: "oversized shirt" };
  refreshOutfitWireState(node, refs);

  const rowEntry = refs.charCards.get("char_1").outfitRows.get("outfit_2");
  assert.equal(rowEntry.chipEl.textContent, "🔗 oversized shirt");
  assert.equal(rowEntry.textInput.style.display, "none");
});

test("onConnectionsChange (simulated via refreshConnectionDots + refreshOutfitWireState) flips an outfit between text and chip WITHOUT resizing", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna");
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const rowEntry = refs.charCards.get("char_1").outfitRows.get("outfit_2");
  const idx = node.inputs.findIndex((i) => i.name === "outfit_2");

  node.inputs[idx].link = 5;
  refreshConnectionDots(node, refs);
  refreshOutfitWireState(node, refs);
  assert.equal(rowEntry.chipEl.style.display, "");
  assert.equal(rowEntry.textInput.style.display, "none");

  node.inputs[idx].link = null;
  refreshConnectionDots(node, refs);
  refreshOutfitWireState(node, refs);
  assert.equal(rowEntry.chipEl.style.display, "none");
  assert.equal(rowEntry.textInput.style.display, "");

  assert.equal(rafQueue.length, 0, "connection-status refresh must never schedule a refit");
  assert.equal(setSizeCalls.length, 0, "connection-status refresh must never resize");
});

test("isSocketConnected reports true only for a slot with a non-null link", () => {
  const { node } = makeFakeNode([300, 200], [{ name: "outfit_2", type: "*", link: null }]);
  assert.equal(isSocketConnected(node, "outfit_2"), false);
  assert.equal(isSocketConnected(node, "missing"), false);
  node.inputs[0].link = 3;
  assert.equal(isSocketConnected(node, "outfit_2"), true);
});

test("refreshIdentityHints shows a character/background's resolved value from node._sceneSlots and hides it when absent", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  addCharacter(node, refs, "Yuna"); // consumes ids 1 (char_1) + 2 (outfit_2)
  addBackground(node, refs, "Bedroom"); // shared nextId counter -> bg_3
  resetRAF();

  refreshIdentityHints(node, refs);
  assert.equal(refs.charCards.get("char_1").hintEl.style.display, "none");
  assert.equal(refs.bgCards.get("bg_3").hintEl.style.display, "none");

  node._sceneSlots = { char_1: "1girl, silver hair", bg_3: "bedroom interior, night" };
  refreshIdentityHints(node, refs);

  assert.equal(refs.charCards.get("char_1").hintEl.textContent, "1girl, silver hair");
  assert.equal(refs.charCards.get("char_1").hintEl.style.display, "");
  assert.equal(refs.bgCards.get("bg_3").hintEl.textContent, "bedroom interior, night");
  assert.equal(refs.bgCards.get("bg_3").hintEl.style.display, "");
});

// ---- interaction.mjs: syncAllSockets (onConfigure idempotent restore) --

test("syncAllSockets adds a missing socket for each restored background/character/outfit", () => {
  const { node } = makeFakeNode([300, 200], []);
  const state = ensureState(node);
  state.backgrounds.push({ socket: "bg_1", name: "Bedroom", enabled: true, text: "" });
  state.characters.push({
    socket: "char_2",
    name: "Yuna",
    enabled: true,
    action: "",
    outfits: [{ socket: "outfit_3", text: "", enabled: true }],
  });

  const changed = syncAllSockets(node);

  assert.equal(changed, true);
  assert.deepEqual(inputNames(node), ["bg_1", "char_2", "outfit_3"]);
});

test("syncAllSockets is idempotent against already-matching node.inputs (no duplicates)", () => {
  const { node } = makeFakeNode(
    [300, 200],
    [
      { name: "bg_1", type: "*", link: null },
      { name: "char_2", type: "*", link: null },
      { name: "outfit_3", type: "*", link: null },
    ],
  );
  const state = ensureState(node);
  state.backgrounds.push({ socket: "bg_1", name: "Bedroom", enabled: true, text: "" });
  state.characters.push({
    socket: "char_2",
    name: "Yuna",
    enabled: true,
    action: "",
    outfits: [{ socket: "outfit_3", text: "", enabled: true }],
  });

  const changed1 = syncAllSockets(node);
  const changed2 = syncAllSockets(node);

  assert.equal(changed1, false, "sockets already present -> nothing to add");
  assert.equal(changed2, false);
  assert.equal(node.inputs.length, 3, "no duplicate sockets");
});

test("rebuildCharacters/rebuildBackgrounds rebuild cards fresh from restored state without duplicating rows, and never resize", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode(
    [300, 200],
    [
      { name: "bg_1", type: "*", link: null },
      { name: "char_1", type: "*", link: null },
      { name: "outfit_2", type: "*", link: null },
    ],
  );
  const state = ensureState(node);
  state.backgrounds.push({ socket: "bg_1", name: "Bedroom", enabled: false, text: "night" });
  state.characters.push({
    socket: "char_1",
    name: "Yuna",
    enabled: false,
    action: "smirk",
    outfits: [{ socket: "outfit_2", text: "coat", enabled: true }],
  });
  wireInteractions(node, refs);

  rebuildBackgrounds(node, refs, refs._backgroundHandlers);
  rebuildCharacters(node, refs, refs._characterHandlers);
  rebuildBackgrounds(node, refs, refs._backgroundHandlers); // idempotent second call
  rebuildCharacters(node, refs, refs._characterHandlers);

  assert.equal(refs.bgCards.size, 1);
  assert.equal(refs.charCards.size, 1);
  const bgEntry = refs.bgCards.get("bg_1");
  assert.equal(bgEntry.nameEl.textContent, "Bedroom");
  assert.equal(bgEntry.textInput.value, "night");
  assert.ok(bgEntry.card.classList.contains("wsc-char-off"));
  const charEntry = refs.charCards.get("char_1");
  assert.equal(charEntry.nameEl.textContent, "Yuna");
  assert.equal(charEntry.actionInput.value, "smirk");
  assert.ok(charEntry.card.classList.contains("wsc-char-off"));
  assert.equal(charEntry.outfitRows.size, 1);
  assert.equal(charEntry.outfitRows.get("outfit_2").textInput.value, "coat");
  assert.equal(refs.bgsEl.children.length, 1, "no duplicate DOM rows (backgrounds)");
  assert.equal(refs.charsEl.children.length, 1, "no duplicate DOM rows (characters)");
  assert.equal(setSizeCalls.length, 0, "rebuild* must never resize by itself");
});

// ---- render.mjs: renderLivePreview (onExecuted fills the preview) ------

test("renderLivePreview shows the italic muted placeholder before any run (text undefined)", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  renderLivePreview(refs, undefined);
  assert.match(refs.previewEl.innerHTML, /wsc-preview-empty/);
  assert.match(refs.previewEl.innerHTML, /Run to preview the scene/);
  assert.equal(refs.previewEl.wscRenderedText, undefined);
});

test("renderLivePreview shows the escaped final scene string once onExecuted has run", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  renderLivePreview(refs, "bedroom interior, 1girl, silver hair, blushing");
  assert.equal(refs.previewEl.innerHTML, "bedroom interior, 1girl, silver hair, blushing");
  assert.equal(refs.previewEl.wscRenderedText, "bedroom interior, 1girl, silver hair, blushing");
});

test("renderLivePreview escapes HTML-significant characters in the run result", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  renderLivePreview(refs, "<b>red hair</b> & jeans");
  assert.equal(refs.previewEl.innerHTML, "&lt;b&gt;red hair&lt;/b&gt; &amp; jeans");
});

test("renderLivePreview treats an empty-string run result as a real result, not the placeholder", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  renderLivePreview(refs, "");
  assert.equal(refs.previewEl.innerHTML, "");
  assert.equal(refs.previewEl.wscRenderedText, "");
});

// ---- core.mjs: assembleOutfitsBlock / assembleCharacters /
// assembleBackgroundBlock / renderCharacterParagraph / buildSceneText — JS
// mirrors of `_scene_creator_helpers.py`'s assembly, matched byte-for-byte
// against the Python tests in `test_scene_creator.py`. Serialization is
// LABELED PROSE, not JSON (a JSON `{token: value}` document was tried first
// but proved noisy for a Qwen-style text encoder). ----------------------

test("assembleOutfitsBlock: wire overrides text when non-empty; joins enabled entries in order, dropping empties", () => {
  const outfits = [
    { socket: "o1", text: "fallback text 1", enabled: true },
    { socket: "o2", text: "jacket", enabled: true },
  ];
  const result = assembleOutfitsBlock(outfits, { o1: "black dress" });
  assert.equal(result, "black dress, jacket");
});

test("assembleOutfitsBlock: disabled entries are skipped entirely", () => {
  const outfits = [
    { socket: "o1", text: "black dress", enabled: true },
    { socket: "o2", text: "SKIP ME", enabled: false },
  ];
  const result = assembleOutfitsBlock(outfits, {});
  assert.equal(result, "black dress");
});

test("assembleCharacters: two enabled, one disabled — wired appearance overrides the field, PROMPT_DATA-shaped wire values are NOT auto-unwrapped (raw string expected)", () => {
  const characters = [
    {
      socket: "char_1",
      name: "Rex",
      enabled: true,
      outfits: [{ socket: "", text: "leather jacket", enabled: true }],
      action: "determined",
    },
    {
      socket: "char_2",
      name: "SKIP",
      enabled: false,
      outfits: [{ socket: "", text: "should be skipped", enabled: true }],
      action: "should be skipped",
    },
    {
      socket: "char_3",
      name: "Mira",
      enabled: true,
      outfits: [{ socket: "", text: "school uniform", enabled: true }],
      action: "shy smile",
      focus: "hands",
    },
  ];
  const wired = {
    char_1: "1girl, red hair, solo",
    char_3: "1boy, blue eyes",
  };
  const result = assembleCharacters(characters, wired);
  assert.deepEqual(result, [
    { name: "Rex", appearance: "1girl, red hair, solo", clothes: "leather jacket", action: "determined" },
    { name: "Mira", appearance: "1boy, blue eyes", clothes: "school uniform", action: "shy smile", focus: "hands" },
  ]);
});

test("assembleCharacters: unwired character falls back to its own appearance field", () => {
  const characters = [
    {
      socket: "char_1",
      enabled: true,
      appearance: "tall, scarred",
      outfits: [{ socket: "", text: "cloak", enabled: true }],
      action: "stoic",
    },
  ];
  const result = assembleCharacters(characters, {});
  assert.deepEqual(result, [{ name: "", appearance: "tall, scarred", clothes: "cloak", action: "stoic" }]);
});

test("assembleCharacters: all-blank character (no name either) is dropped entirely", () => {
  const characters = [
    { socket: "char_1", enabled: true, outfits: [{ socket: "", text: "", enabled: true }], action: "  " },
  ];
  assert.deepEqual(assembleCharacters(characters, {}), []);
});

test("assembleCharacters: a name-only character is kept", () => {
  const characters = [{ socket: "char_1", name: "Nameless Cameo", enabled: true }];
  assert.deepEqual(assembleCharacters(characters, {}), [{ name: "Nameless Cameo" }]);
});

test("assembleCharacters: no characters yields an empty array", () => {
  assert.deepEqual(assembleCharacters([], {}), []);
});

test("assembleCharacters: multiple outfits — wire overrides one entry's text, another entry's own text is kept, joined in order", () => {
  const characters = [
    {
      socket: "char_1",
      enabled: true,
      action: "confident",
      outfits: [
        { socket: "char_1_outfit_1", text: "fallback text 1", enabled: true },
        { socket: "char_1_outfit_2", text: "jacket", enabled: true },
      ],
    },
  ];
  const wired = { char_1: "1girl, solo", char_1_outfit_1: "black dress" };
  const result = assembleCharacters(characters, wired);
  assert.deepEqual(result, [
    { name: "", appearance: "1girl, solo", clothes: "black dress, jacket", action: "confident" },
  ]);
});

test("assembleBackgroundBlock: two enabled, one disabled, one blank-text — wire AND text both kept (not override), joined in order", () => {
  const backgrounds = [
    { socket: "bg_1", enabled: true, text: "golden hour" },
    { socket: "bg_2", enabled: false, text: "should be skipped" },
    { socket: "bg_3", enabled: true, text: "" },
  ];
  const wired = { bg_1: "rooftop skyline, dusk", bg_3: "misty forest clearing" };
  const block = assembleBackgroundBlock(backgrounds, wired);
  assert.equal(block, "rooftop skyline, dusk, golden hour, misty forest clearing");
  assert.ok(!block.includes("should be skipped"));
});

test("assembleBackgroundBlock: no backgrounds yields an empty string", () => {
  assert.equal(assembleBackgroundBlock([], {}), "");
});

test("renderCharacterParagraph: full order (appearance, clothes, action, focus), comma-joined, single trailing ';'", () => {
  const character = {
    name: "Yuna",
    appearance: "woman, 24yo, long black hair, hime cut, purple eyes",
    clothes: "white blouse, black blazer, pencil skirt",
    action: "sitting turned in chair, looking up, surprised smile",
    focus: "sharp focus, facing camera",
  };
  assert.equal(
    renderCharacterParagraph(character),
    "Yuna: woman, 24yo, long black hair, hime cut, purple eyes, " +
      "white blouse, black blazer, pencil skirt, " +
      "sitting turned in chair, looking up, surprised smile, " +
      "sharp focus, facing camera;",
  );
});

test("renderCharacterParagraph: no name omits the prefix entirely", () => {
  const character = { appearance: "1girl, solo", clothes: "wired black dress", action: "smiling" };
  assert.equal(renderCharacterParagraph(character), "1girl, solo, wired black dress, smiling;");
});

test("renderCharacterParagraph: does not strip periods from pieces (no trailing-period handling any more)", () => {
  const character = { appearance: "tall.", action: "calm.." };
  assert.equal(renderCharacterParagraph(character), "tall., calm..;");
});

test("renderCharacterParagraph: a name-only character (no body) yields just the bare name — no ';'", () => {
  assert.equal(renderCharacterParagraph({ name: "Nameless Cameo" }), "Nameless Cameo");
});

test("buildSceneText: four-bucket order (lead -> characters -> labeled -> tail), regardless of template token position", () => {
  const template = "{tags}, {characters}, {backgrounds}, {mood}, {scene_description}, {shot}";
  const fields = {
    tags: "score_7, masterpiece",
    mood: "tense",
    scene_description: "office standoff",
    shot: "medium shot, harsh light",
  };
  const charactersList = [{ name: "Yuna", appearance: "long black hair" }];
  const result = buildSceneText(template, fields, charactersList, "cafe interior");
  assert.equal(
    result,
    "score_7, masterpiece\n\n" +
      "Yuna: long black hair;\n\n" +
      "Background: cafe interior;\n" +
      "Mood: tense;\n\n" +
      "office standoff\n" +
      "medium shot, harsh light",
  );
});

test("buildSceneText: TAIL tokens preserve template order and are rendered bare (no label, no ';')", () => {
  const result = buildSceneText(
    "{shot}, {scene_description}",
    { shot: "medium shot", scene_description: "quiet office" },
    [],
    "",
  );
  assert.equal(result, "medium shot\nquiet office");
  assert.ok(!result.includes(":"));
  assert.ok(!result.includes(";"));
});

test("buildSceneText: empty characters/background are omitted entirely", () => {
  const result = buildSceneText("{characters}, {backgrounds}, {lighting}", { lighting: "sunset" }, [], "");
  assert.equal(result, "Lighting: sunset;");
  assert.ok(!result.includes("Background"));
});

test("buildSceneText: no JSON syntax, preserves unicode", () => {
  const result = buildSceneText("{tags}, {lighting}", { tags: "score_7", lighting: "café glow" }, [], "");
  assert.equal(result, "score_7\n\nLighting: café glow;");
  assert.ok(!result.includes("{") && !result.includes("}") && !result.includes('"'));
});

test("buildSceneText: all-empty input yields an empty string", () => {
  assert.equal(
    buildSceneText("{tags}, {characters}, {backgrounds}, {scene_description}, {shot}", {}, [], ""),
    "",
  );
});

// ---- render.mjs: computeClientSceneText / updateComputedPreview — the
// CLIENT-SIDE live preview between runs -----------------------------------

test("computeClientSceneText mirrors buildSceneText from the node's current state, falling back to text fields when no wired value exists yet", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  refs.templateEl.value = "{tags}, {characters}, {backgrounds}, {lighting}";
  rebuildFields(node, refs);
  flushRAF();

  const state = ensureState(node);
  state.fields.tags = "score_7";
  state.fields.lighting = "soft glow";
  addCharacter(node, refs, "Yuna");
  flushRAF();
  const charEntry = refs.charCards.get("char_1");
  charEntry.appearanceInput.value = "long black hair";
  fire(charEntry.appearanceInput, "input");
  addBackground(node, refs, "Cafe");
  flushRAF();
  const bgEntry = refs.bgCards.get("bg_3");
  bgEntry.textInput.value = "cafe interior";
  fire(bgEntry.textInput, "input");

  const text = computeClientSceneText(node, refs);
  assert.equal(
    text,
    "score_7\n\nYuna: long black hair;\n\nBackground: cafe interior;\nLighting: soft glow;",
  );
});

test("computeClientSceneText prefers node._sceneSlots (the last onExecuted's resolved values) over a character's own appearance field", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  refs.templateEl.value = "{characters}";
  rebuildFields(node, refs);
  flushRAF();
  addCharacter(node, refs, "Yuna");
  flushRAF();
  const charEntry = refs.charCards.get("char_1");
  charEntry.appearanceInput.value = "fallback text";
  fire(charEntry.appearanceInput, "input");

  node._sceneSlots = { char_1: "1girl, silver hair" };
  const text = computeClientSceneText(node, refs);
  assert.equal(text, "Yuna: 1girl, silver hair;");
});

test("updateComputedPreview shows the placeholder (not a literal empty string) when the computed scene text is empty", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  refs.templateEl.value = "{lighting}";
  rebuildFields(node, refs);
  flushRAF();

  updateComputedPreview(node, refs);

  assert.match(refs.previewEl.innerHTML, /wsc-preview-empty/);
});

test("a scene field edit refreshes the LIVE PREVIEW with the computed prose (without resizing)", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  refs.templateEl.value = "{lighting}";
  rebuildFields(node, refs);
  flushRAF();
  setSizeCalls.length = 0;
  resetRAF();

  const entry = refs.fieldRows.get("lighting");
  entry.input.value = "sunset";
  fire(entry.input, "input");

  assert.equal(refs.previewEl.wscRenderedText, "Lighting: sunset;");
  assert.equal(rafQueue.length, 0, "a plain field edit must never schedule a refit");
  assert.equal(setSizeCalls.length, 0);
});

test("onExecuted's real result overrides the client-computed preview; a later edit recomputes it", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  wireInteractions(node, refs);
  refs.templateEl.value = "{lighting}";
  rebuildFields(node, refs);
  flushRAF();

  // Simulates index.js's onExecuted wrap directly overwriting the preview
  // with the real backend text (bypassing updateComputedPreview).
  renderLivePreview(refs, "Lighting: REAL BACKEND RESULT");
  assert.match(refs.previewEl.wscRenderedText, /REAL BACKEND RESULT/);

  const entry = refs.fieldRows.get("lighting");
  entry.input.value = "midnight";
  fire(entry.input, "input");

  assert.equal(refs.previewEl.wscRenderedText, "Lighting: midnight;");
  assert.ok(!refs.previewEl.wscRenderedText.includes("REAL BACKEND RESULT"));
});

// ---- index.js: source-level assertions --------------------------------

const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const indexCode = stripComments(indexSource);

test("index.js creates the widget with the legacy getMinHeight option (NOT computeSize/getHeight), backed by measureMinHeight", () => {
  assert.ok(/getMinHeight/.test(indexSource));
  assert.ok(/measureMinHeight/.test(indexSource));
  assert.ok(!/widget\.computeSize\s*=/.test(indexCode), "found a leftover widget.computeSize assignment");
  assert.ok(!/widget\.getHeight\s*=/.test(indexCode), "found a leftover widget.getHeight assignment");
});

test("index.js's widget.computeLayoutSize reports {minWidth: 1} for the Nodes 2.0 renderer path", () => {
  assert.ok(/computeLayoutSize/.test(indexSource));
  assert.ok(/minWidth:\s*1/.test(indexCode));
});

test("index.js schedules the guarded initial fit at onNodeCreated (via rebuildFields) and an unconditional refit on a changed onExecuted", () => {
  assert.ok(/scheduleInitialFit/.test(indexSource) || /rebuildFields/.test(indexSource));
  const setupIdx = indexCode.indexOf("function setupNode");
  const setupBody = indexCode.slice(setupIdx, indexCode.indexOf("\n}", setupIdx));
  assert.ok(!/scheduleRefit\(/.test(setupBody), "setupNode must not call scheduleRefit directly");
  const executedIdx = indexCode.indexOf("onExecuted = function");
  const executedBody = indexCode.slice(executedIdx, indexCode.indexOf("\n    };", executedIdx));
  assert.ok(/scheduleRefit\(/.test(executedBody));
});

test("index.js's restoreNode never calls scheduleRefit or scheduleInitialFit directly — it trusts the restored node.size", () => {
  const idx = indexCode.indexOf("function restoreNode");
  assert.ok(idx >= 0, "expected a restoreNode function");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(!/scheduleRefit\(/.test(body), "restoreNode must not call scheduleRefit");
  assert.ok(!/scheduleInitialFit\(/.test(body), "restoreNode must not call scheduleInitialFit");
  assert.ok(/rebuildFields\(node,\s*refs,\s*\{\s*silent:\s*true\s*\}\)/.test(body));
});

test("index.js's onConfigure wrap sets _scConfigured = true BEFORE calling the original onConfigure or restoreNode", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onConfigure = function");
  assert.ok(idx >= 0, "expected an onConfigure wrap");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  const flagIdx = body.indexOf("_scConfigured = true");
  const origIdx = body.indexOf("originalOnConfigure.apply");
  const restoreIdx = body.indexOf("restoreNode(this)");
  assert.ok(flagIdx >= 0, "expected _scConfigured = true in the onConfigure wrap");
  assert.ok(origIdx > flagIdx, "the flag must be set before calling the original onConfigure");
  assert.ok(restoreIdx > flagIdx, "the flag must be set before calling restoreNode");
});

test("index.js's restoreNode re-syncs ALL sockets (background/character/outfit) via syncAllSockets", () => {
  assert.ok(/syncAllSockets/.test(indexSource));
  const idx = indexCode.indexOf("function restoreNode");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(/syncAllSockets\(node\)/.test(body));
  assert.ok(/rebuildBackgrounds\(/.test(body));
  assert.ok(/rebuildCharacters\(/.test(body));
});

test("index.js floors a fresh node's size UP via Math.max, guarded by _scBootstrapped (a SEPARATE flag from the onConfigure-set _scConfigured)", () => {
  assert.ok(/_scBootstrapped/.test(indexCode));
  assert.ok(/_scConfigured/.test(indexCode));
  assert.ok(/Math\.max/.test(indexCode));
});

test("index.js wraps onExecuted, derives the LIVE PREVIEW text from message.text.join(\"\"), stores _sceneSlots, and only refits when the text changed", () => {
  assert.ok(/onExecuted/.test(indexSource));
  assert.ok(/message\.text/.test(indexSource));
  assert.ok(/\.join\(""\)/.test(indexSource));
  assert.ok(/_sceneCreatorLastResult/.test(indexSource));
  assert.ok(/_sceneSlots/.test(indexSource));
  assert.ok(/message\.slots/.test(indexSource));
  assert.ok(/renderLivePreview/.test(indexSource));
  assert.ok(/changed/.test(indexCode));
  const executedIdx = indexCode.indexOf("onExecuted = function");
  const executedBody = indexCode.slice(executedIdx, indexCode.indexOf("\n    };", executedIdx));
  assert.ok(/refreshOutfitWireState\(/.test(executedBody));
  assert.ok(/refreshIdentityHints\(/.test(executedBody));
});

// ---- scene_state delivery: declared, natively-serialized STRING widget ---
// (replaces the old hidden-INPUT + graphToPrompt injection, which did not
// reliably deliver `scene_state` to the backend in this ComfyUI).

test("index.js no longer wraps app.graphToPrompt anywhere (the broken hidden-input delivery path is fully removed)", () => {
  assert.ok(!/graphToPrompt/.test(indexCode), "no functional graphToPrompt reference should remain");
  assert.ok(!/async setup\s*\(/.test(indexCode), "the setup() hook used only for the old wrap should be gone");
});

test("index.js hides the scene_state widget the SAME way as template (hidden=true, computeSize collapse, inputEl display:none) and never sets serialize=false on it", () => {
  const idx = indexCode.indexOf("function hideStateWidget");
  assert.ok(idx >= 0, "expected a hideStateWidget function");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(/stateWidget\.hidden\s*=\s*true/.test(body));
  assert.ok(/stateWidget\.computeSize\s*=\s*\(\)\s*=>\s*\[0,\s*-4\]/.test(body));
  assert.ok(/inputEl\.style\.display\s*=\s*"none"/.test(body));
  assert.ok(!/serialize\s*=\s*false/.test(body), "scene_state must never be marked serialize:false");
});

test("index.js's mountUI hides the scene_state widget via findStateWidget", () => {
  const idx = indexCode.indexOf("function mountUI");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(/hideStateWidget\(findStateWidget\(node\)\)/.test(body));
});

test("index.js's setupNode and restoreNode both call loadStateFromWidget (parses the persisted scene_state widget value into node.properties.sceneState), not properties-only restore", () => {
  const setupIdx = indexCode.indexOf("function setupNode");
  const setupBody = indexCode.slice(setupIdx, indexCode.indexOf("\n}", setupIdx));
  assert.ok(/loadStateFromWidget\(node\)/.test(setupBody));

  const restoreIdx = indexCode.indexOf("function restoreNode");
  const restoreBody = indexCode.slice(restoreIdx, indexCode.indexOf("\n}", restoreIdx));
  assert.ok(/loadStateFromWidget\(node\)/.test(restoreBody));
});

test("findStateWidget finds the widget named scene_state on node.widgets", () => {
  const node = { widgets: [{ name: "template", value: "x" }, { name: STATE_WIDGET_NAME, value: "{}" }] };
  const widget = findStateWidget(node);
  assert.ok(widget);
  assert.equal(widget.name, "scene_state");
});

test("the scene_state widget must serialize (serialize !== false) — hiding it must never disable serialization", () => {
  const node = { widgets: [{ name: STATE_WIDGET_NAME, value: "{}" }] };
  const widget = findStateWidget(node);
  assert.notEqual(widget.serialize, false);
});

test("syncStateWidget writes JSON.stringify(node.properties.sceneState) into the scene_state widget's value", () => {
  const stateWidget = { name: STATE_WIDGET_NAME, value: "{}" };
  const node = {
    widgets: [stateWidget],
    properties: {
      sceneState: { version: 1, fields: { place: "a rooftop" }, backgrounds: [], characters: [], nextId: 1 },
    },
  };
  syncStateWidget(node);
  assert.equal(stateWidget.value, JSON.stringify(node.properties.sceneState));
});

test("syncStateWidget is a safe no-op when the scene_state widget doesn't exist yet", () => {
  const node = { widgets: [], properties: { sceneState: { fields: {} } } };
  assert.doesNotThrow(() => syncStateWidget(node));
});

test("editing a scene field syncs the scene_state widget with the updated fields JSON", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  const stateWidget = { name: STATE_WIDGET_NAME, value: "{}" };
  node.widgets = [stateWidget];
  refs.templateEl.value = "{place}";
  rebuildFields(node, refs);
  flushRAF();

  const entry = refs.fieldRows.get("place");
  entry.input.value = "a rooftop";
  fire(entry.input, "input");

  const parsed = JSON.parse(stateWidget.value);
  assert.equal(parsed.fields.place, "a rooftop");
});

test("adding a character syncs the scene_state widget with the new character entry", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  const stateWidget = { name: STATE_WIDGET_NAME, value: "{}" };
  node.widgets = [stateWidget];
  wireInteractions(node, refs);

  addCharacter(node, refs, "Yuna");

  const parsed = JSON.parse(stateWidget.value);
  assert.equal(parsed.characters.length, 1);
  assert.equal(parsed.characters[0].name, "Yuna");
  flushRAF();
});

test("adding a background syncs the scene_state widget with the new background entry", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  const stateWidget = { name: STATE_WIDGET_NAME, value: "{}" };
  node.widgets = [stateWidget];
  wireInteractions(node, refs);

  addBackground(node, refs, "Bedroom");

  const parsed = JSON.parse(stateWidget.value);
  assert.equal(parsed.backgrounds.length, 1);
  assert.equal(parsed.backgrounds[0].name, "Bedroom");
  flushRAF();
});

test("loadStateFromWidget (the onConfigure restore path) parses the scene_state widget's JSON into node.properties.sceneState", () => {
  const stateWidget = {
    name: STATE_WIDGET_NAME,
    value: JSON.stringify({
      version: 1,
      fields: { mood: "tense" },
      backgrounds: [{ socket: "bg_1", name: "Bedroom", enabled: true, text: "" }],
      characters: [],
      nextId: 2,
    }),
  };
  const node = { widgets: [stateWidget] };

  const state = loadStateFromWidget(node);

  assert.equal(state.fields.mood, "tense");
  assert.equal(state.backgrounds.length, 1);
  assert.equal(node.properties.sceneState.fields.mood, "tense", "must land in node.properties.sceneState");
});

test("loadStateFromWidget falls back to ensureState's defaults on malformed widget JSON", () => {
  const stateWidget = { name: STATE_WIDGET_NAME, value: "not valid json" };
  const node = { widgets: [stateWidget] };

  const state = loadStateFromWidget(node);

  assert.deepEqual(state.fields, {});
  assert.deepEqual(state.backgrounds, []);
  assert.deepEqual(state.characters, []);
});

test("loadStateFromWidget defaults cleanly for a fresh node's default '{}' widget value", () => {
  const stateWidget = { name: STATE_WIDGET_NAME, value: "{}" };
  const node = { widgets: [stateWidget] };

  const state = loadStateFromWidget(node);

  assert.deepEqual(state.fields, {});
  assert.deepEqual(state.backgrounds, []);
  assert.deepEqual(state.characters, []);
  assert.equal(state.nextId, 1);
});

// ---- loadStateFromWidget: `expression` -> `action` migration (mirrors
// `_scene_creator_helpers.py`'s `_normalize_character`, and its dedicated
// Python tests `test_parse_scene_state_expression_migrates_to_action_when_
// action_missing` / `test_parse_scene_state_expression_dropped_when_action_
// already_present` / `test_parse_scene_state_legacy_scalar_outfit_
// normalized` in test_scene_creator.py) — driven through the REAL load
// entry point (`loadStateFromWidget`), not `normalizeCharacter` directly.

test("loadStateFromWidget migrates a legacy expression-only character to action (action key absent)", () => {
  const stateWidget = {
    name: STATE_WIDGET_NAME,
    value: JSON.stringify({
      version: 1,
      characters: [{ socket: "char_1", enabled: true, expression: "smiling" }],
    }),
  };
  const node = { widgets: [stateWidget] };

  const state = loadStateFromWidget(node);

  assert.equal(state.characters[0].action, "smiling");
  assert.ok(!("expression" in state.characters[0]));
});

test("loadStateFromWidget drops expression and keeps action when BOTH are present on the raw character", () => {
  const stateWidget = {
    name: STATE_WIDGET_NAME,
    value: JSON.stringify({
      version: 1,
      characters: [{ socket: "char_1", enabled: true, expression: "old", action: "new" }],
    }),
  };
  const node = { widgets: [stateWidget] };

  const state = loadStateFromWidget(node);

  assert.equal(state.characters[0].action, "new");
  assert.ok(!("expression" in state.characters[0]));
});

test("loadStateFromWidget migrates the legacy scalar-outfit character (`outfit`, with or without `outfit_socket`) into a freshly-socketed outfits entry, alongside the expression->action migration", () => {
  // NOTE: unlike the Python backend's `_normalize_outfits` (which reuses a
  // legacy `outfit_socket` when present), the JS `_legacyOutfitText` path
  // always mints a FRESH socket via `ensureState`'s shared `nextId` counter
  // for ANY legacy scalar-outfit character, regardless of `outfit_socket` —
  // a pre-existing JS/Python behavior difference, out of scope for this
  // migration-guard fix; this test documents the actual current behavior.
  const stateWidget = {
    name: STATE_WIDGET_NAME,
    value: JSON.stringify({
      version: 1,
      characters: [
        { socket: "char_1", enabled: true, outfit: "leather jacket", expression: "determined" },
        {
          socket: "char_2",
          enabled: true,
          outfit: "cloak",
          outfit_socket: "char_2_outfit",
          expression: "stoic",
        },
        { socket: "char_3", enabled: true, expression: "no outfit data at all" },
      ],
    }),
  };
  const node = { widgets: [stateWidget] };

  const state = loadStateFromWidget(node);

  assert.equal(state.characters[0].outfits.length, 1);
  assert.equal(state.characters[0].outfits[0].text, "leather jacket");
  assert.ok(state.characters[0].outfits[0].socket.startsWith("outfit_"), "expected a freshly-socketed outfit entry");
  assert.equal(state.characters[0].action, "determined");
  assert.ok(!("expression" in state.characters[0]));

  assert.equal(state.characters[1].outfits.length, 1);
  assert.equal(state.characters[1].outfits[0].text, "cloak");
  assert.ok(state.characters[1].outfits[0].socket.startsWith("outfit_"), "expected a freshly-socketed outfit entry");
  assert.equal(state.characters[1].action, "stoic");
  assert.ok(!("expression" in state.characters[1]));

  assert.equal(state.characters[2].outfits.length, 0);
  assert.equal(state.characters[2].action, "no outfit data at all");
  assert.ok(!("expression" in state.characters[2]));
});

test("index.js's onConnectionsChange wrap only refreshes connection dots + outfit wire state (no rebuild/resize call in that handler)", () => {
  const idx = indexCode.indexOf("onConnectionsChange = function");
  assert.ok(idx >= 0, "expected an onConnectionsChange wrap");
  const handlerBlock = indexCode.slice(idx, indexCode.indexOf("};", idx));
  assert.ok(/refreshConnectionDots/.test(handlerBlock));
  assert.ok(/refreshOutfitWireState/.test(handlerBlock));
  assert.ok(!/scheduleRefit/.test(handlerBlock), "onConnectionsChange must not trigger a refit");
  assert.ok(!/rebuildCharacters/.test(handlerBlock), "onConnectionsChange must not rebuild cards");
  assert.ok(!/rebuildBackgrounds/.test(handlerBlock), "onConnectionsChange must not rebuild cards");
});

// ---- Summary ------------------------------------------------------------

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
