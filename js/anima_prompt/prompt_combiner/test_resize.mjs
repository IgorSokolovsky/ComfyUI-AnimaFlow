/**
 * test_resize.mjs — regression tests for the Prompt Combiner frontend:
 *
 *   A. LIVE PREVIEW — `renderLivePreview` shows the italic muted placeholder
 *      before any run, and the escaped REAL combined string once one has
 *      been supplied (mirroring the backend's `onExecuted` handshake wired
 *      in `index.js`).
 *   B. Resize mechanism (ComfyUI-Pixaroma find_replace mechanism, matched
 *      EXACTLY, mirrors `js/anima_prompt/prompt_builder/test_resize.mjs`):
 *      `measureMinHeight` measures real, settled DOM content (skipping
 *      detached/hidden children), substitutes a small `PREVIEW_MIN` for the
 *      LIVE PREVIEW section's own (open-ended) `offsetHeight` so a long
 *      combined result can never inflate the floor it's measured against
 *      (no feedback loop, no bottom-clipping), floors at 180, and rounds to
 *      a 4px grid; `refitNode` grows the node when content needs more room,
 *      shrinks it to fit when the user hasn't manually enlarged it past the
 *      last auto-fit height, and never shrinks past a manual enlargement;
 *      `setNodeHeight` only ever touches `size[1]`; `scheduleRefit` always
 *      defers through `requestAnimationFrame` (stubbed here) — never
 *      resizes synchronously. `rebuildInputsList` itself never calls
 *      `setSize` any more; every trigger (first build, a structural INPUTS
 *      change, `onConfigure` restore, a changed `onExecuted` preview) calls
 *      `scheduleRefit` explicitly. The widget is created with the legacy
 *      `getMinHeight` option (NOT `computeSize`/`getHeight`), and
 *      `computeLayoutSize` reports `{minWidth: 1}` for the Nodes 2.0 path.
 *   C. Template-drives-sockets (Fix B) — `reconcileInputsFromTemplate` adds
 *      a real input slot for every new `{token}` typed into the template and
 *      removes the slot for any token no longer present (matched by name),
 *      schedules exactly one refit when (and only when) that happened, is
 *      idempotent (safe to call repeatedly against an already-matching
 *      `node.inputs`, e.g. after `onConfigure` restore — no duplicates), and
 *      is reentrancy-guarded. The "＋ Add Input" control and a row's ✕ both
 *      go through editing the template text, not `addInput`/`removeInput`
 *      directly.
 *   D. Deferred default-template seeding — `core.mjs`'s
 *      `shouldSeedDefaultInputs` only says "seed" when `node.inputs` is
 *      still empty at the deferred tick, so a loaded node (inputs already
 *      restored by `onConfigure` before that tick) never gets duplicate
 *      `character`/`background` slots.
 *
 * Run directly: `node js/anima_prompt/prompt_combiner/test_resize.mjs` (plain script, no
 * test framework — matches the project's `python test_*.py` convention).
 *
 * `index.js` itself imports `app` from the absolute ComfyUI path
 * (`/scripts/app.js`), which only resolves inside a real ComfyUI/browser
 * host, so this harness exercises:
 *   - `render.mjs`'s and `interaction.mjs`'s pure, DOM-stub-testable
 *     functions directly (LIVE PREVIEW rendering, the resize math, and the
 *     template->sockets reconciliation), and
 *   - `core.mjs`'s pure `shouldSeedDefaultInputs` directly, and
 *   - `index.js`'s source TEXT for the parts that can only run inside
 *     LiteGraph (the legacy `getMinHeight` + Nodes 2.0 `computeLayoutSize`
 *     widget wiring, the `_pcConfigured`-guarded initial floor, the
 *     `scheduleRefit` triggers, the `onExecuted` wrapper, and the
 *     deferred-seed scheduling).
 *
 * MANUAL-IN-COMFYUI CHECKLIST (cannot be confirmed by this headless
 * harness — the real `addDOMWidget`/LiteGraph runtime contract, and the
 * legacy-vs-Nodes-2.0 renderer split, only exist live):
 *   [ ] Editing the TEMPLATE textarea to add `{style}` creates a `style`
 *       input socket immediately; deleting `{style}` from the text removes
 *       the socket (and drops its wire if connected).
 *   [ ] The node's HEIGHT grows/shrinks to fit content on each of: first
 *       drop, an add/remove via the template, save+reload, and a run; its
 *       WIDTH never changes on its own, and dragging the node wider/narrower
 *       by hand sticks.
 *   [ ] Saving a workflow with custom inputs, then reloading the page,
 *       restores exactly the same sockets (no duplicates, wires intact).
 *   [ ] Running the node updates the LIVE PREVIEW with the real combined
 *       string and the node resizes (grows or shrinks) to fit it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildRoot,
  rebuildInputsList,
  updateConnectionStatuses,
  renderLivePreview,
  measureMinHeight,
  setNodeHeight,
  refitNode,
  scheduleRefit,
  scheduleInitialFit,
  CHROME,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";
import { wireInteractions, reconcileInputsFromTemplate } from "./interaction.mjs";
import { shouldSeedDefaultInputs, DEFAULT_INPUTS } from "./core.mjs";

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
//
// `scheduleRefit` (and everything built on it) defers through
// `requestAnimationFrame`; stub it as a queue so tests can assert exactly
// how many refits were scheduled, then deterministically run them with
// `flushRAF()` instead of depending on a real browser frame.

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

// `measureMinHeight` reads `getComputedStyle(root)` directly (a global,
// matching real browser code) for `rowGap`/`gap`/`paddingTop`/`paddingBottom`.
// Stub it to just return the element's own (plain-object) `.style` so tests
// can set those properties directly on a stub element.
globalThis.getComputedStyle = (el) => (el && el.style) || {};

// ---- Minimal DOM stub -------------------------------------------------
//
// Just enough of the DOM surface `render.mjs`/`interaction.mjs` touch:
// element creation, className/style/attributes, appendChild/removeChild (+
// parentNode/firstChild), addEventListener, and a plain-object `classList`.
// Deliberately does NOT stub `offsetHeight`/`offsetParent` by default, so
// tests opt in explicitly per-element.

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

test("measureMinHeight sums visible children offsetHeight + gap + padding read via getComputedStyle", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  root.style.rowGap = "13px";
  root.style.paddingTop = "4px";
  root.style.paddingBottom = "2px";
  const child1 = doc.createElement("div");
  child1.offsetHeight = 100;
  const child2 = doc.createElement("div");
  child2.offsetHeight = 50;
  const child3 = doc.createElement("div");
  child3.offsetHeight = 30;
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
  // Only `visible` counts: 100, and only 1 counted child -> no gap applied;
  // 100 is below the 180 floor -> floored.
  assert.equal(measureMinHeight(root), 180);
});

test("measureMinHeight only counts one gap fewer than the visible child count", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  root.style.rowGap = "10px";
  const a = doc.createElement("div");
  a.offsetHeight = 5;
  a.offsetParent = {};
  const hiddenBetween = doc.createElement("div");
  hiddenBetween.offsetHeight = 500;
  hiddenBetween.offsetParent = null;
  const b = doc.createElement("div");
  b.offsetHeight = 5;
  b.offsetParent = {};
  root.appendChild(a);
  root.appendChild(hiddenBetween);
  root.appendChild(b);
  // 2 visible children -> 1 gap: 5 + 5 + 10 = 20, floored to 180.
  assert.equal(measureMinHeight(root), 180);
});

test("measureMinHeight rounds the result to the nearest 4px grid", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 201; // -> Math.round(201/4)*4 = 200
  root.appendChild(child);
  assert.equal(measureMinHeight(root), 200);
});

test("measureMinHeight substitutes PREVIEW_MIN for the LIVE PREVIEW section instead of its real offsetHeight (no feedback loop, no bottom-clipping)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const fixed = doc.createElement("div");
  fixed.offsetHeight = 120;
  fixed.offsetParent = {};
  const preview = doc.createElement("div");
  preview.offsetHeight = 5000; // a huge combined result
  preview.offsetParent = {};
  preview.classList.add("wpc-section-preview");
  root.appendChild(fixed);
  root.appendChild(preview);
  // The preview contributes only PREVIEW_MIN (100), NOT its real 5000
  // offsetHeight: 120 + 100 = 220, well under 5000+120.
  const result = measureMinHeight(root);
  assert.ok(result < 300, `expected the huge preview offsetHeight to be substituted, got ${result}`);
  assert.ok(result >= 220 - 4 && result <= 220 + 4, `expected ~220, got ${result}`);
});

test("measureMinHeight does NOT special-case a child lacking the wpc-section-preview class, even with a huge offsetHeight", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5000;
  root.appendChild(child);
  assert.equal(measureMinHeight(root), 5000);
});

// ---- render.mjs: setNodeHeight / refitNode / scheduleRefit -------------

test("setNodeHeight sets height only, preserves width, and records _pcAutoH", () => {
  const { node, setSizeCalls } = makeFakeNode([321, 100]);
  setNodeHeight(node, 250);
  assert.equal(node.size[0], 321, "width must be untouched");
  assert.equal(node.size[1], 250);
  assert.equal(node._pcAutoH, 250);
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
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 100]);

  refitNode(node, root);

  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.ok(want > 100);
  assert.equal(setSizeCalls.length, 1);
  assert.equal(node.size[1], want);
  assert.equal(node.size[0], 300, "width preserved");
});

test("refitNode shrinks to fit content when the node has no auto-fit history (e.g. first build)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5;
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 500]);

  refitNode(node, root);

  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.ok(want < 500);
  assert.equal(setSizeCalls.length, 1);
  assert.equal(node.size[1], want);
});

test("refitNode does NOT shrink a node the user manually enlarged past the last auto-fit height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5;
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 500]);
  node._pcAutoH = 200; // last auto-fit height
  // node.size[1] (500) > autoH (200) + 4 -> userEnlarged.

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0, "must not shrink a user-enlarged node");
  assert.equal(node.size[1], 500);
});

test("refitNode still GROWS past a user-enlarged height if content needs more room", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 1000;
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 500]);
  node._pcAutoH = 200; // user previously enlarged 200 -> 500

  refitNode(node, root);

  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.ok(want > 500);
  assert.equal(setSizeCalls.length, 1);
  assert.equal(node.size[1], want);
});

test("refitNode is a no-op when content already matches the current height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 0;
  root.appendChild(child);
  // Compute the actual target height (measureMinHeight floors at 180
  // regardless of the near-zero content, then adds CHROME, then floors
  // again at DEFAULT_H) rather than assuming DEFAULT_H itself, since the
  // 180 floor + CHROME can now exceed DEFAULT_H.
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const { node, setSizeCalls } = makeFakeNode([300, want]);

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0);
});

test("scheduleRefit defers through requestAnimationFrame — never resizes synchronously", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 300;
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

// ---- render.mjs: scheduleInitialFit is GUARDED by node._pcConfigured --
//
// Regression coverage for the "workflow reload snaps the node back to
// content size" bug: `onConfigure` (index.js) sets `node._pcConfigured =
// true` synchronously, BEFORE the rAF this schedules ever fires, for any
// node being loaded from a saved workflow. The guard must live INSIDE the
// rAF callback (checked at fire time), not at schedule time.

test("scheduleInitialFit does NOT resize when node._pcConfigured is true (a loaded node keeps its saved size)", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900; // content that would normally force a big grow
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 220]); // the "saved" size
  node._pcConfigured = true; // onConfigure already ran (workflow load)

  scheduleInitialFit(node, root);
  assert.equal(setSizeCalls.length, 0, "must not resize synchronously");
  flushRAF();

  assert.equal(setSizeCalls.length, 0, "a loaded node's initial fit must not resize");
  assert.equal(node.size[1], 220, "the saved size must be preserved");
});

test("scheduleInitialFit DOES fit a genuinely fresh node (node._pcConfigured never set)", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
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

// ---- render.mjs: renderLivePreview -------------------------------------

test("renderLivePreview shows the italic muted placeholder before any run (text undefined)", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  renderLivePreview(refs, undefined);
  assert.match(refs.previewEl.innerHTML, /wpc-preview-empty/);
  assert.match(refs.previewEl.innerHTML, /Run to preview the combined prompt/);
  assert.equal(refs.previewEl.wpcRenderedText, undefined);
});

test("renderLivePreview shows the escaped final combined string once onExecuted has run", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  renderLivePreview(refs, "a, b");
  assert.equal(refs.previewEl.innerHTML, "a, b");
  assert.equal(refs.previewEl.wpcRenderedText, "a, b");
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
  assert.equal(refs.previewEl.wpcRenderedText, "");
});

test("rebuildInputsList re-applies node._promptCombinerLastResult (survives a structural rebuild)", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 400], [{ name: "character", link: 1 }]);
  node._promptCombinerLastResult = "red hair, forest";

  rebuildInputsList(node, refs, () => {});

  assert.equal(refs.previewEl.innerHTML, "red hair, forest");
});

test("updateConnectionStatuses re-applies the current LIVE PREVIEW without resizing", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode([300, 400], [{ name: "character", link: null }]);
  rebuildInputsList(node, refs, () => {});
  node._promptCombinerLastResult = "already ran";
  setSizeCalls.length = 0;

  node.inputs[0].link = 7; // connect
  updateConnectionStatuses(node, refs);

  assert.equal(setSizeCalls.length, 0, "a connection-status change must never resize the node");
  assert.equal(refs.previewEl.innerHTML, "already ran");
  assert.ok(refs.inputRows.get("character").dot.classList.contains("wpc-dot-on"));
});

// ---- render.mjs: rebuildInputsList never resizes ------------------------
//
// Resizing moved entirely to `scheduleRefit`, called explicitly by
// `index.js`/`interaction.mjs` at each structural trigger; `rebuildInputsList`
// itself is now a pure DOM-rows sync with no sizing side effect at all.

test("rebuildInputsList never calls node.setSize, no matter how many rows change", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode(
    [300, 400],
    [{ name: "character" }, { name: "background" }],
  );

  rebuildInputsList(node, refs, () => {}); // first build
  node.inputs.push({ name: "style" });
  rebuildInputsList(node, refs, () => {}); // add
  node.inputs.splice(0, 1);
  rebuildInputsList(node, refs, () => {}); // remove

  assert.equal(setSizeCalls.length, 0, "rebuildInputsList must never resize the node itself");
});

// ---- interaction.mjs: reconcileInputsFromTemplate (Fix B) --------------

test("reconcileInputsFromTemplate adds one socket when a new {token} is typed", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], [{ name: "character" }]);
  refs.templateEl.value = "{character}, {style}";

  const changed = reconcileInputsFromTemplate(node, refs);

  assert.equal(changed, true);
  assert.deepEqual(inputNames(node), ["character", "style"]);
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled for a structural add");
  flushRAF();
});

test("reconcileInputsFromTemplate removes a socket when its token is deleted from the template", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode(
    [300, 200],
    [{ name: "character" }, { name: "background" }],
  );
  refs.templateEl.value = "{character}";

  const changed = reconcileInputsFromTemplate(node, refs);

  assert.equal(changed, true);
  assert.deepEqual(inputNames(node), ["character"]);
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled for a structural remove");
  flushRAF();
});

test("reconcileInputsFromTemplate is a no-op for a non-structural template edit (same token set)", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode(
    [300, 200],
    [{ name: "character" }, { name: "background" }],
  );
  refs.templateEl.value = "{character}, {background}, extra prose with no braces";

  const changed = reconcileInputsFromTemplate(node, refs);

  assert.equal(changed, false);
  assert.deepEqual(inputNames(node), ["character", "background"]);
  assert.equal(rafQueue.length, 0, "a non-structural edit must never schedule a refit");
});

test("reconcileInputsFromTemplate is idempotent against already-matching node.inputs (onConfigure restore, no dupes)", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode(
    [300, 200],
    [{ name: "character" }, { name: "background" }],
  );
  refs.templateEl.value = "{character}, {background}";

  const changed1 = reconcileInputsFromTemplate(node, refs);
  const changed2 = reconcileInputsFromTemplate(node, refs);

  assert.equal(changed1, false);
  assert.equal(changed2, false);
  assert.equal(node.inputs.length, 2, "no duplicate sockets");
  assert.equal(rafQueue.length, 0);
});

test("the onConfigure restore sequence (reconcile + rebuild, matching state) calls no setSize at all", () => {
  // Mirrors index.js's restoreNode: node.inputs/template are ALREADY
  // restored (by litegraph, before onConfigure fires) to match each other,
  // so reconcileInputsFromTemplate is a pure no-op and rebuildInputsList
  // never resizes itself — restoreNode calls neither scheduleRefit nor
  // scheduleInitialFit, so the restored node.size must survive untouched.
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node, setSizeCalls } = makeFakeNode(
    [300, 500], // the "saved" size
    [{ name: "character" }, { name: "background" }],
  );
  node._pcConfigured = true; // onConfigure already set this before restoring
  refs.templateEl.value = "{character}, {background}";

  const changed = reconcileInputsFromTemplate(node, refs);
  rebuildInputsList(node, refs, () => {});

  assert.equal(changed, false, "restored inputs already match the restored template");
  assert.equal(setSizeCalls.length, 0, "restore must never call setSize");
  assert.equal(rafQueue.length, 0, "restore must never schedule a refit");
  assert.equal(node.size[1], 500, "the restored size must be untouched");
});

test("an explicit INPUTS add AFTER onConfigure still schedules exactly one refit (post-load user actions are never gated by _pcConfigured)", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  // Stub real, settled offsetHeights on the root's direct children so
  // measureMinHeight computes a real number (not NaN) and refitNode actually
  // has something to compare `node.size[1]` against.
  refs.root.children.forEach((child) => {
    child.offsetHeight = 260;
    child.offsetParent = {};
  });
  const { node, setSizeCalls } = makeFakeNode([300, 100], [{ name: "character" }]);
  node._pcConfigured = true; // node was loaded from a workflow

  refs.templateEl.value = "{character}, {style}"; // the user adds a field post-load
  const changed = reconcileInputsFromTemplate(node, refs);

  assert.equal(changed, true);
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
  assert.equal(setSizeCalls.length, 1, "a post-load add must still resize exactly once");
});

test("reconcileInputsFromTemplate matches slots by NAME, not array position", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode(
    [300, 200],
    [{ name: "background" }, { name: "character" }], // deliberately out of token order
  );
  refs.templateEl.value = "{character}, {background}";

  const changed = reconcileInputsFromTemplate(node, refs);

  assert.equal(changed, false, "same names present -> no add/remove even if order differs");
  assert.equal(node.inputs.length, 2);
});

test("reconcileInputsFromTemplate guards against reentrancy", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], []);
  refs.templateEl.value = "{a}";
  refs._reconciling = true;

  const changed = reconcileInputsFromTemplate(node, refs);

  assert.equal(changed, false);
  assert.equal(node.inputs.length, 0);
});

test("a row's remove control strips its {token} from the template and reconcile drops the socket", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode(
    [300, 200],
    [{ name: "character" }, { name: "background" }],
  );
  refs.templateEl.value = "{character}, {background}";
  wireInteractions(node, refs);

  refs._handleRemove("background");

  assert.equal(refs.templateEl.value, "{character}");
  assert.deepEqual(inputNames(node), ["character"]);
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("confirming '+ Add Input' appends {name} to the template and reconcile creates the socket", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], [{ name: "character" }]);
  refs.templateEl.value = "{character}";
  wireInteractions(node, refs);

  refs.addNameInput.value = "Style";
  fire(refs.addConfirmBtn, "click");

  assert.equal(refs.templateEl.value, "{character}, {style}");
  assert.deepEqual(inputNames(node), ["character", "style"]);
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("typing a new {token} directly into the template textarea adds one socket + schedules one refit", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode([300, 200], [{ name: "character" }]);
  refs.templateEl.value = "{character}";
  wireInteractions(node, refs);

  refs.templateEl.value = "{character}, {style}";
  fire(refs.templateEl, "input");

  assert.deepEqual(inputNames(node), ["character", "style"]);
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("deleting a token directly from the template textarea removes its socket", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode(
    [300, 200],
    [{ name: "character" }, { name: "background" }],
  );
  refs.templateEl.value = "{character}, {background}";
  wireInteractions(node, refs);

  refs.templateEl.value = "{character}";
  fire(refs.templateEl, "input");

  assert.deepEqual(inputNames(node), ["character"]);
  assert.equal(rafQueue.length, 1);
  flushRAF();
});

test("a non-structural template edit via typing changes no sockets and schedules no refit", () => {
  resetRAF();
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const { node } = makeFakeNode(
    [300, 200],
    [{ name: "character" }, { name: "background" }],
  );
  refs.templateEl.value = "{character}, {background}";
  wireInteractions(node, refs);

  refs.templateEl.value = "{character}, {background}, some filler prose with no braces";
  fire(refs.templateEl, "input");

  assert.deepEqual(inputNames(node), ["character", "background"]);
  assert.equal(rafQueue.length, 0);
});

// ---- core.mjs: shouldSeedDefaultInputs (deferred default-template seed) --

test("shouldSeedDefaultInputs is true for a genuinely fresh node (no inputs at the deferred tick)", () => {
  const node = { inputs: [] };
  assert.equal(shouldSeedDefaultInputs(node), true);
});

test("shouldSeedDefaultInputs is true when node.inputs is missing entirely", () => {
  const node = {};
  assert.equal(shouldSeedDefaultInputs(node), true);
});

test("shouldSeedDefaultInputs is false when node.inputs is already populated at the deferred tick (simulated load)", () => {
  const node = { inputs: [{ name: "style" }] };
  assert.equal(shouldSeedDefaultInputs(node), false);
});

test("shouldSeedDefaultInputs is false even if node.inputs only has the same DEFAULT_INPUTS restored already", () => {
  const node = { inputs: DEFAULT_INPUTS.map((name) => ({ name })) };
  assert.equal(shouldSeedDefaultInputs(node), false);
});

// ---- index.js: source-level assertions --------------------------------
//
// `index.js` imports `app` from the absolute ComfyUI host path
// (`/scripts/app.js`), which cannot resolve under plain Node, so its
// LiteGraph-facing pieces (the widget sizing wiring, the refit triggers,
// onExecuted, the deferred-seed scheduling) are verified by source
// inspection instead of execution.

const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");

// Strip `/* ... */` and `// ...` comments so the "does the CODE do X"
// assertions below don't false-positive on doc comments that merely
// *describe* rationale (mentioning e.g. `node.size[1]` by name to explain
// what NOT to do). Good enough for this source file (no string literals
// containing `//` or `/*`).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const indexCode = stripComments(indexSource);

test("index.js's widget.computeLayoutSize reports {minWidth: 1} for the Nodes 2.0 renderer path", () => {
  assert.ok(/computeLayoutSize/.test(indexSource));
  assert.ok(/minWidth:\s*1/.test(indexCode));
});

test("index.js creates the widget with the legacy getMinHeight option (NOT computeSize/getHeight), backed by measureMinHeight", () => {
  assert.ok(/getMinHeight/.test(indexSource));
  assert.ok(/measureMinHeight/.test(indexSource));
  // The old computeSize/getHeight sizing hooks for the MAIN wpc_ui widget
  // must be gone. `templateWidget.computeSize = () => [0, -4]` (a separate,
  // legit hook that hides the canvas-drawn `template` widget) is NOT this
  // regression, so check specifically for `widget.computeSize =` /
  // `widget.getHeight =` (the main DOM widget's own assignment), not any
  // occurrence of the bare words.
  assert.ok(!/widget\.computeSize\s*=/.test(indexCode), "found a leftover widget.computeSize assignment");
  assert.ok(!/widget\.getHeight\s*=/.test(indexCode), "found a leftover widget.getHeight assignment");
});

test("index.js's widget.computeLayoutSize reports minHeight from measureMinHeight for the Nodes 2.0 renderer path", () => {
  assert.ok(/widget\.computeLayoutSize/.test(indexCode));
  assert.ok(/minHeight:\s*measureMinHeight\(refs\.root\)/.test(indexCode));
});

test("index.js's widget sizing (getMinHeight/computeLayoutSize) never reads node.size[1] — height comes from measureMinHeight only, never fed back from the node's own current size", () => {
  // Scope to just the widget-creation-through-sizing block (the
  // `node.addDOMWidget(...)` call through the `refs.widget = widget;` line
  // right after) so this doesn't false-positive on `ensureInitialFloor`'s
  // legitimate one-time read of the node's CURRENT height to floor it up —
  // that's not the getMinHeight/computeLayoutSize feedback loop this guards
  // against.
  const widgetSizingBlock = indexCode.slice(
    indexCode.indexOf("node.addDOMWidget("),
    indexCode.indexOf("refs.widget = widget;"),
  );
  assert.ok(widgetSizingBlock.length > 0, "expected to find the widget-sizing block in index.js");
  assert.ok(
    !/node\.size\[1\]/.test(widgetSizingBlock),
    "found a node.size[1] read inside the widget's getMinHeight/computeLayoutSize",
  );
  assert.ok(/measureMinHeight/.test(widgetSizingBlock));
});

test("index.js no longer contains the old resize-floor / deterministic-setSize mechanism", () => {
  assert.ok(!/installResizeFloor/.test(indexCode));
  assert.ok(!/measureRootContent/.test(indexCode));
  assert.ok(!/computeContentMinHeight/.test(indexCode));
  assert.ok(!/resizing_node/.test(indexCode));
  assert.ok(!/NODE_CHROME_HEIGHT/.test(indexCode));
});

test("index.js schedules the guarded initial fit at onNodeCreated and an unconditional refit on a changed onExecuted", () => {
  assert.ok(/scheduleInitialFit/.test(indexSource));
  assert.ok(/scheduleRefit/.test(indexSource));
  // setupNode: exactly one scheduleInitialFit call, no direct scheduleRefit.
  const setupIdx = indexCode.indexOf("function setupNode");
  const setupBody = indexCode.slice(setupIdx, indexCode.indexOf("\n}", setupIdx));
  assert.ok(/scheduleInitialFit\(/.test(setupBody));
  assert.ok(!/scheduleRefit\(/.test(setupBody), "setupNode must use the GUARDED initial fit, not scheduleRefit");
  // onExecuted still uses the unconditional scheduleRefit (unaffected by the fix).
  const executedIdx = indexCode.indexOf("onExecuted = function");
  const executedBody = indexCode.slice(executedIdx, indexCode.indexOf("\n    };", executedIdx));
  assert.ok(/scheduleRefit\(/.test(executedBody));
});

test("index.js's restoreNode never calls scheduleRefit or scheduleInitialFit — it trusts the restored node.size", () => {
  const idx = indexCode.indexOf("function restoreNode");
  assert.ok(idx >= 0, "expected a restoreNode function");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(!/scheduleRefit\(/.test(body), "restoreNode must not call scheduleRefit");
  assert.ok(!/scheduleInitialFit\(/.test(body), "restoreNode must not call scheduleInitialFit");
});

test("index.js's onConfigure wrap sets _pcConfigured = true BEFORE calling the original onConfigure or restoreNode", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onConfigure = function");
  assert.ok(idx >= 0, "expected an onConfigure wrap");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  const flagIdx = body.indexOf("_pcConfigured = true");
  const origIdx = body.indexOf("originalOnConfigure.apply");
  const restoreIdx = body.indexOf("restoreNode(this)");
  assert.ok(flagIdx >= 0, "expected _pcConfigured = true in the onConfigure wrap");
  assert.ok(origIdx > flagIdx, "the flag must be set before calling the original onConfigure");
  assert.ok(restoreIdx > flagIdx, "the flag must be set before calling restoreNode");
});

test("index.js floors a fresh node's size UP via Math.max, guarded by _pcConfigured", () => {
  assert.ok(/_pcConfigured/.test(indexCode));
  assert.ok(/Math\.max/.test(indexCode));
});

test("index.js wraps onExecuted, derives the LIVE PREVIEW text from message.text.join(\"\"), and only refits when it changed", () => {
  assert.ok(/onExecuted/.test(indexSource));
  assert.ok(/message\.text/.test(indexSource));
  assert.ok(/\.join\(""\)/.test(indexSource));
  assert.ok(/_promptCombinerLastResult/.test(indexSource));
  assert.ok(/renderLivePreview/.test(indexSource));
  assert.ok(/changed/.test(indexCode));
});

test("index.js seeds the default TEMPLATE and reconciles instead of addInput'ing defaults directly", () => {
  assert.ok(/DEFAULT_TEMPLATE/.test(indexSource));
  assert.ok(/reconcileInputsFromTemplate/.test(indexSource));
  assert.ok(!/function seedDefaultInputs/.test(indexCode));
  assert.ok(!/DEFAULT_INPUTS/.test(indexCode));
});

test("index.js defers default-template seeding (requestAnimationFrame/setTimeout) and re-checks emptiness", () => {
  assert.ok(/requestAnimationFrame/.test(indexSource));
  assert.ok(/setTimeout/.test(indexSource));
  assert.ok(/shouldSeedDefaultInputs/.test(indexSource));
});

// ---- Summary ------------------------------------------------------------

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
