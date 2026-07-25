/**
 * test_resize.mjs — regression tests for the measured resize mechanism
 * (ComfyUI-Pixaroma `find_replace` approach, matched exactly — see
 * `render.mjs`'s module header):
 *
 *   A. `measureMinHeight` sums visible children's `offsetHeight` + row gap +
 *      vertical padding, skipping children whose `offsetParent` is `null`
 *      (hidden) — EXCEPT the `.wpb-section-preview` child, which always
 *      contributes a fixed `PREVIEW_MIN` instead of its real (flexible)
 *      `offsetHeight`, so a huge/empty preview can never feed back into the
 *      measured floor and grow it (no feedback loop). Floors the total at
 *      180 and rounds to a 4px grid.
 *   B. `refitNode` GROWS when the measured content no longer fits, does NOT
 *      shrink when the user has manually dragged the node taller than the
 *      last auto-fit height (`userEnlarged`), and DOES shrink-to-fit when
 *      the user hasn't done that.
 *   C. `setNodeHeight` always preserves `node.size[0]` (width untouched).
 *   D. The DOM widget is created with `getMinHeight` (the LEGACY litegraph
 *      canvas renderer's own widget-sizing hook — the user's actual host)
 *      and does NOT define `computeSize`/`getHeight`. It also exposes a
 *      `computeLayoutSize` hook returning `{ minWidth: 1, minHeight }`
 *      (Nodes 2.0 compatibility only).
 *   E. A refit is always scheduled via `requestAnimationFrame`, never
 *      measured synchronously — the harness stubs `requestAnimationFrame`
 *      to run callbacks synchronously-on-demand so this is observable.
 *   F. A field VALUE edit (or a non-structural template edit) triggers no
 *      refit at all.
 *
 * Run directly: `node js/anima_prompt/prompt_builder/test_resize.mjs` (plain script, no
 * test framework — matches the project's `python test_*.py` convention).
 *
 * `index.js` itself imports `app` from the absolute ComfyUI host path
 * (`/scripts/app.js`), which only resolves inside a real ComfyUI/browser
 * host, so this harness exercises:
 *   - `render.mjs`'s pure, DOM-stub-testable functions directly
 *     (`measureMinHeight`, `setNodeHeight`, `refitNode`, `scheduleRefit`,
 *     `scheduleInitialFit`, `rebuildFields`), and
 *   - `index.js`'s source TEXT for the parts that can only run inside
 *     LiteGraph (the `getMinHeight` widget option, the absence of legacy
 *     `computeSize`/`getHeight` overrides, the `computeLayoutSize` Nodes
 *     2.0 hook, the `_pbConfigured`-guarded initial fit (set at the very
 *     start of the `onConfigure` wrap, before the original/`restoreNode`
 *     run), and the `_pbBootstrapped`-guarded initial size floor).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildRoot,
  rebuildFields,
  updatePreview,
  measureMinHeight,
  setNodeHeight,
  refitNode,
  scheduleRefit,
  scheduleInitialFit,
  CHROME,
  DEFAULT_W,
  DEFAULT_H,
  PREVIEW_MIN,
} from "./render.mjs";
import {
  STATE_WIDGET_NAME,
  findStateWidget,
  syncStateWidget,
  restoreStateFromWidget,
  buildFieldText,
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

// ---- rAF stub ----------------------------------------------------------
//
// `scheduleRefit` resolves the bare `requestAnimationFrame` identifier from
// the global scope at call time, so stubbing `globalThis.requestAnimationFrame`
// before calling it is enough — no module mocking needed. Queues callbacks
// instead of running them immediately, so tests can assert "nothing has
// measured yet" before flushing.
function installRafStub() {
  const queue = [];
  globalThis.requestAnimationFrame = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  return {
    flush() {
      const pending = queue.splice(0, queue.length);
      pending.forEach((cb) => cb());
    },
    pendingCount() {
      return queue.length;
    },
  };
}

// ---- Minimal DOM stub -------------------------------------------------
//
// Just enough of the DOM surface `render.mjs` touches: element creation,
// className/style/attributes, appendChild/removeChild (+ parentNode /
// firstChild), addEventListener, and a plain-object `classList`.

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
      offsetHeight: 0,
      offsetParent: {}, // truthy stand-in for "visible" unless a test nulls it
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
        el._className
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => el.classList.add(c));
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
    defaultView: null,
  };
  return doc;
}

function fire(el, type) {
  (el._listeners[type] || []).forEach((fn) => fn());
}

function makeFakeNode(initialSize, widgets) {
  const setSizeCalls = [];
  const node = {
    size: initialSize.slice(),
    properties: {},
    widgets: widgets || [],
    setSize(size) {
      setSizeCalls.push(size.slice());
      node.size = size.slice();
    },
    setDirtyCanvas() {},
  };
  return { node, setSizeCalls };
}

/**
 * A minimal stand-in for the real `prompt_builder_state` STRING widget:
 * just enough surface (`name`, `value`, `serialize`) for `findStateWidget`/
 * `syncStateWidget`/`restoreStateFromWidget` (core.mjs) and the
 * hide-a-widget pattern (index.js) to exercise against.
 */
function makeFakeStateWidget(initialValue) {
  return { name: STATE_WIDGET_NAME, value: initialValue !== undefined ? initialValue : "{}" };
}

// ---- render.mjs: measureMinHeight ----------------------------------

test("measureMinHeight returns the 180 floor for a missing/childless root", () => {
  assert.equal(measureMinHeight(null), 180);
  assert.equal(measureMinHeight(undefined), 180);
  const doc = makeDocStub();
  const root = doc.createElement("div");
  assert.equal(measureMinHeight(root), 180);
});

test("measureMinHeight sums visible children's offsetHeight + gap + padding (above the floor)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child1 = doc.createElement("div");
  child1.offsetHeight = 140;
  const child2 = doc.createElement("div");
  child2.offsetHeight = 100;
  const child3 = doc.createElement("div");
  child3.offsetHeight = 80;
  root.appendChild(child1);
  root.appendChild(child2);
  root.appendChild(child3);
  // No getComputedStyle stubbed -> gap/padding both fall back to 0, so this
  // is purely the sum of offsetHeights: 140 + 100 + 80 = 320 (already a
  // multiple of 4, and above the 180 floor, so neither rounding nor the
  // floor changes it).
  assert.equal(measureMinHeight(root), 320);
});

test("measureMinHeight adds row-gap and vertical padding from getComputedStyle", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  doc.defaultView = {
    getComputedStyle(el) {
      if (el === root) {
        return { rowGap: "13px", paddingTop: "4px", paddingBottom: "2px" };
      }
      return {};
    },
  };
  const child1 = doc.createElement("div");
  child1.offsetHeight = 200;
  const child2 = doc.createElement("div");
  child2.offsetHeight = 100;
  root.appendChild(child1);
  root.appendChild(child2);
  // 200 + 100 = 300 content, + 13px gap * 1 gap (2 visible children) = 13,
  // + 4 + 2 padding = 6. Total = 319, rounded to the nearest 4px -> 320.
  assert.equal(measureMinHeight(root), 320);
});

test("measureMinHeight skips children with offsetParent === null (hidden)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child1 = doc.createElement("div");
  child1.offsetHeight = 260;
  const hidden = doc.createElement("div");
  hidden.offsetHeight = 999;
  hidden.offsetParent = null;
  root.appendChild(child1);
  root.appendChild(hidden);
  // Only child1 counts; single visible child -> no gap contribution.
  assert.equal(measureMinHeight(root), 260);
});

test("measureMinHeight floors small/empty content at 180", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 10; // tiny -> well under the floor
  root.appendChild(child);
  assert.equal(measureMinHeight(root), 180);
});

test("measureMinHeight rounds its total to the nearest 4px", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 253; // 253 / 4 = 63.25 -> rounds to 63 * 4 = 252
  root.appendChild(child);
  assert.equal(measureMinHeight(root), 252);
});

test("measureMinHeight substitutes PREVIEW_MIN for the wpb-section-preview child, never its real offsetHeight (no feedback loop)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const fixed = doc.createElement("div");
  fixed.offsetHeight = 200; // the TEMPLATE/FIELDS-equivalent fixed part
  const preview = doc.createElement("div");
  preview.className = "wpb-section wpb-section-preview";
  preview.offsetHeight = 9999; // huge real height (a long rendered prompt)
  root.appendChild(fixed);
  root.appendChild(preview);
  // Expected: 200 (fixed) + PREVIEW_MIN (100), NOT 200 + 9999. Proves the
  // preview's real, flexible height never feeds back into the floor.
  const result = measureMinHeight(root);
  assert.equal(result, 200 + PREVIEW_MIN);
  assert.ok(result < 9999, "the preview's real offsetHeight must never be counted");
});

// ---- render.mjs: setNodeHeight ------------------------------------------

test("setNodeHeight preserves node.size[0] (width) and records _pbAutoH", () => {
  const { node, setSizeCalls } = makeFakeNode([300, 400]);
  setNodeHeight(node, 250);
  assert.equal(setSizeCalls.length, 1);
  assert.deepEqual(setSizeCalls[0], [300, 250]);
  assert.equal(node.size[0], 300);
  assert.equal(node.size[1], 250);
  assert.equal(node._pbAutoH, 250);
});

// ---- render.mjs: refitNode ----------------------------------------------

test("refitNode GROWS when measured content no longer fits", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 500; // + CHROME -> want well above cur
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 200]);

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 1, "expected a resize to grow");
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.equal(setSizeCalls[0][1], want);
  assert.equal(setSizeCalls[0][0], 300, "width untouched");
});

test("refitNode does NOT shrink when the user has manually dragged the node taller", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 10; // tiny content -> want is small (floored)
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 200]);
  node._pbAutoH = 200; // last auto-fit height was 200

  node.size[1] = 500; // user dragged the node much taller than the auto height
  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0, "a user-enlarged node must not be snapped back");
  assert.equal(node.size[1], 500);
});

test("refitNode DOES shrink-to-fit when the user hasn't manually enlarged the node", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 10; // tiny content -> want is small (floored)
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([300, 400]);
  node._pbAutoH = 400; // last auto-fit height equals current height -> not user-enlarged

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 1, "expected a shrink-to-fit resize");
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.equal(setSizeCalls[0][1], want);
  assert.ok(want < 400);
});

test("refitNode floors the target at max(measureMinHeight + CHROME, DEFAULT_H) even with empty content", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  // measureMinHeight(root) floors internally at 180, so the node-level floor
  // here is max(180 + CHROME, DEFAULT_H).
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const { node, setSizeCalls } = makeFakeNode([300, want]);
  node._pbAutoH = want;

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0, "already at the floor -> no-op");
  assert.equal(node.size[1], want);
});

test("refitNode is a no-op when want === cur", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const { node, setSizeCalls } = makeFakeNode([300, want]);
  node._pbAutoH = want;

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0);
});

// ---- render.mjs: scheduleRefit is rAF-only, never synchronous ----------

test("scheduleRefit defers measurement to requestAnimationFrame (nothing happens until flushed)", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const root = doc.createElement("div");
    const child = doc.createElement("div");
    child.offsetHeight = 500;
    root.appendChild(child);
    const { node, setSizeCalls } = makeFakeNode([300, 100]);

    scheduleRefit(node, root);
    assert.equal(setSizeCalls.length, 0, "must not measure/resize synchronously");
    assert.equal(raf.pendingCount(), 1, "expected exactly one rAF callback queued");

    raf.flush();
    assert.equal(setSizeCalls.length, 1, "resize should happen once the frame is flushed");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

// ---- render.mjs: scheduleInitialFit is GUARDED by node._pbConfigured --
//
// Regression coverage for the "workflow reload snaps the node back to
// content size" bug: `onConfigure` (index.js) sets `node._pbConfigured =
// true` synchronously, BEFORE the rAF this schedules ever fires, for any
// node being loaded from a saved workflow. The guard must live INSIDE the
// rAF callback (checked at fire time), not at schedule time.

test("scheduleInitialFit does NOT resize when node._pbConfigured is true (a loaded node keeps its saved size)", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const root = doc.createElement("div");
    const child = doc.createElement("div");
    child.offsetHeight = 900; // content that would normally force a big grow
    root.appendChild(child);
    const { node, setSizeCalls } = makeFakeNode([300, 220]); // the "saved" size
    node._pbConfigured = true; // onConfigure already ran (workflow load)

    scheduleInitialFit(node, root);
    assert.equal(setSizeCalls.length, 0, "must not resize synchronously");
    raf.flush();

    assert.equal(setSizeCalls.length, 0, "a loaded node's initial fit must not resize");
    assert.equal(node.size[1], 220, "the saved size must be preserved");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("scheduleInitialFit DOES fit a genuinely fresh node (node._pbConfigured never set)", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const root = doc.createElement("div");
    const child = doc.createElement("div");
    child.offsetHeight = 900;
    root.appendChild(child);
    const { node, setSizeCalls } = makeFakeNode([300, 100]);

    scheduleInitialFit(node, root);
    raf.flush();

    assert.equal(setSizeCalls.length, 1, "a fresh node's initial fit should size to content");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("scheduleInitialFit defers to requestAnimationFrame (never measures synchronously)", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const root = doc.createElement("div");
    const { node, setSizeCalls } = makeFakeNode([300, 100]);

    scheduleInitialFit(node, root);
    assert.equal(setSizeCalls.length, 0);
    assert.equal(raf.pendingCount(), 1);
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

// ---- render.mjs: rebuildFields / scheduleRefit integration -------------

test("first build schedules exactly one refit via rAF, preserving width", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node, setSizeCalls } = makeFakeNode([300, 50]);

    refs.templateEl.value = "{a}, {b}";
    rebuildFields(node, refs);
    assert.equal(setSizeCalls.length, 0, "no synchronous resize on first build");
    assert.equal(raf.pendingCount(), 1);

    raf.flush();
    assert.equal(setSizeCalls.length, 1);
    assert.equal(setSizeCalls[0][0], 300, "width must be preserved");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("a structural token ADD after first build schedules exactly one more refit", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node } = makeFakeNode([300, 400]);

    refs.templateEl.value = "{a}, {b}";
    rebuildFields(node, refs); // first build
    raf.flush();

    refs.templateEl.value = "{a}, {b}, {c}";
    rebuildFields(node, refs); // structural: token added

    assert.equal(raf.pendingCount(), 1, "expected exactly one rAF scheduled for a structural add");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("a structural token REMOVE after first build schedules exactly one more refit", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node } = makeFakeNode([300, 400]);

    refs.templateEl.value = "{a}, {b}, {c}";
    rebuildFields(node, refs); // first build
    raf.flush();

    refs.templateEl.value = "{a}, {b}";
    rebuildFields(node, refs); // structural: token removed

    assert.equal(raf.pendingCount(), 1, "expected exactly one rAF scheduled for a structural remove");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("a value edit (field input) schedules no refit at all", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node } = makeFakeNode([300, 400]);

    refs.templateEl.value = "{a}, {b}";
    rebuildFields(node, refs); // first build
    raf.flush();

    const entry = refs.fieldRows.get("a");
    entry.input.value = "hello world";
    fire(entry.input, "input"); // simulates the user typing into the field

    assert.equal(raf.pendingCount(), 0, "a plain field value edit must never schedule a refit");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("rebuildFields({ silent: true }) — the onConfigure restore path — never schedules any refit, even on a structural change", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node } = makeFakeNode([300, 400]);

    refs.templateEl.value = "{a}";
    rebuildFields(node, refs); // first build
    raf.flush();

    refs.templateEl.value = "{a}, {b}, {c}"; // structural change: tokens added
    rebuildFields(node, refs, { silent: true }); // simulates onConfigure's restore call

    assert.equal(raf.pendingCount(), 0, "the restore path must not schedule any refit");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("onConfigure's restore call itself never calls setSize — the restored node.size is trusted", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node, setSizeCalls } = makeFakeNode([300, 400]);
    node._pbConfigured = true; // onConfigure already set this before restoring

    refs.templateEl.value = "{a}, {b}, {c}"; // the restored template
    rebuildFields(node, refs, { silent: true }); // restoreNode's call
    raf.flush(); // even if something were queued, flushing must not resize

    assert.equal(setSizeCalls.length, 0, "restore must never call setSize");
    assert.equal(node.size[1], 400, "the restored size must be untouched");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("a structural field add/remove AFTER onConfigure still schedules exactly one refit (post-load user actions are never gated by _pbConfigured)", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node, setSizeCalls } = makeFakeNode([300, 400]);
    node._pbConfigured = true; // node was loaded from a workflow

    refs.templateEl.value = "{a}";
    rebuildFields(node, refs, { silent: true }); // mirrors restoreNode's own rebuild
    raf.flush();
    setSizeCalls.length = 0;

    refs.templateEl.value = "{a}, {b}"; // the user adds a field post-load
    rebuildFields(node, refs); // a genuine, non-silent user structural action

    assert.equal(raf.pendingCount(), 1, "expected exactly one refit scheduled");
    raf.flush();
    assert.equal(setSizeCalls.length, 1, "a post-load add/remove must still resize exactly once");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("a non-structural template edit (same token set) schedules no refit", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node } = makeFakeNode([300, 400]);

    refs.templateEl.value = "{a}, {b}";
    rebuildFields(node, refs); // first build
    raf.flush();

    refs.templateEl.value = "{a}, {b}, some filler text with no braces";
    rebuildFields(node, refs); // token set unchanged

    assert.equal(raf.pendingCount(), 0, "a template edit that doesn't change the token set must never schedule a refit");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

// ---- render.mjs: buildRoot wires the preview section's stable class ---

test("buildRoot's preview section carries the wpb-section-preview class measureMinHeight keys off", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const previewSection = refs.root.children.find((c) =>
    c.classList.contains("wpb-section-preview")
  );
  assert.ok(previewSection, "expected a direct child of root with wpb-section-preview");
});

// ---- core.mjs: prompt_builder_state widget delivery (the fixed bug) ----
//
// The `prompt_builder_state` field is now a declared, natively-serialized
// STRING widget (`required` in `nodes/node_prompt_builder.py`'s
// `INPUT_TYPES`) that the frontend hides and writes to directly, exactly
// like `template` — NOT a `hidden` input injected via an `app.graphToPrompt`
// wrap (which never reliably reached the backend in this ComfyUI).

test("findStateWidget locates the widget by name; syncStateWidget writes the current promptBuilderState JSON into it", () => {
  const stateWidget = makeFakeStateWidget("{}");
  const { node } = makeFakeNode([300, 400], [stateWidget]);
  node.properties.promptBuilderState = { version: 1, fields: { a: "hello" } };

  assert.equal(findStateWidget(node), stateWidget);

  syncStateWidget(node);

  assert.equal(stateWidget.value, JSON.stringify({ version: 1, fields: { a: "hello" } }));
});

test("syncStateWidget is a safe no-op when the node has no prompt_builder_state widget", () => {
  const { node } = makeFakeNode([300, 400], []);
  node.properties.promptBuilderState = { version: 1, fields: { a: "hello" } };
  assert.doesNotThrow(() => syncStateWidget(node));
});

test("restoreStateFromWidget parses the widget's (LiteGraph-restored) JSON into node.properties.promptBuilderState", () => {
  const stateWidget = makeFakeStateWidget(
    JSON.stringify({ version: 1, fields: { character: "Aria", hair_style: "braid" } })
  );
  const { node } = makeFakeNode([300, 400], [stateWidget]);

  const state = restoreStateFromWidget(node);

  assert.deepEqual(state, { version: 1, fields: { character: "Aria", hair_style: "braid" } });
  assert.deepEqual(node.properties.promptBuilderState, {
    version: 1,
    fields: { character: "Aria", hair_style: "braid" },
  });
});

test("restoreStateFromWidget guards against malformed/empty JSON, falling back to the default shape", () => {
  const { node: nodeMalformed } = makeFakeNode([300, 400], [makeFakeStateWidget("{not valid json")]);
  assert.deepEqual(restoreStateFromWidget(nodeMalformed), { version: 1, fields: {} });

  const { node: nodeEmpty } = makeFakeNode([300, 400], [makeFakeStateWidget("")]);
  assert.deepEqual(restoreStateFromWidget(nodeEmpty), { version: 1, fields: {} });

  const { node: nodeMissingWidget } = makeFakeNode([300, 400], []);
  assert.deepEqual(restoreStateFromWidget(nodeMissingWidget), { version: 1, fields: {} });
});

test("a field VALUE edit calls syncStateWidget: the hidden prompt_builder_state widget's value reflects the edit immediately", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const stateWidget = makeFakeStateWidget("{}");
    const { node } = makeFakeNode([300, 400], [stateWidget]);

    refs.templateEl.value = "{a}, {b}";
    rebuildFields(node, refs); // first build
    raf.flush();

    // rebuildFields itself already synced (seeding "" for new tokens) -
    // confirm the widget carries the seeded shape before the edit.
    assert.equal(stateWidget.value, JSON.stringify({ version: 1, fields: { a: "", b: "" } }));

    const entry = refs.fieldRows.get("a");
    entry.input.value = "hello world";
    fire(entry.input, "input"); // simulates the user typing into the field

    assert.equal(
      stateWidget.value,
      JSON.stringify({ version: 1, fields: { a: "hello world", b: "" } }),
      "the widget must be re-synced immediately after a field value edit"
    );
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("rebuildFields syncs the state widget after an add/remove wildcard (structural template edit)", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const stateWidget = makeFakeStateWidget("{}");
    const { node } = makeFakeNode([300, 400], [stateWidget]);

    refs.templateEl.value = "{a}";
    rebuildFields(node, refs);
    raf.flush();
    assert.equal(stateWidget.value, JSON.stringify({ version: 1, fields: { a: "" } }));

    refs.templateEl.value = "{a}, {b}"; // add wildcard
    rebuildFields(node, refs);
    assert.equal(
      stateWidget.value,
      JSON.stringify({ version: 1, fields: { a: "", b: "" } }),
      "expected the newly-added token to be synced to the widget"
    );
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

// ---- core.mjs: buildFieldText — the labeled-PROSE mirror of the backend's
// `build_field_text`, matched byte-for-byte against the Python tests in
// `test_prompt_builder.py`. A JSON `{token: value}` document was tried first
// but proved noisy for a Qwen-style text encoder; this replaced it. --------

test("buildFieldText drops empty fields, preserves the tokens' order, and labels each line", () => {
  const result = buildFieldText(["character", "hair_style", "eyes"], {
    character: "Aria",
    hair_style: "",
    eyes: "green",
  });
  assert.equal(result, "Character: Aria\nEyes: green");
});

test("buildFieldText trims each value before storing/checking emptiness", () => {
  const result = buildFieldText(["mood"], { mood: "  tense  " });
  assert.equal(result, "Mood: tense");
});

test("buildFieldText has no JSON syntax and preserves unicode", () => {
  const result = buildFieldText(["character", "hair_style"], { character: "Élise", hair_style: "twin buns" });
  assert.equal(result, "Character: Élise\nHair Style: twin buns");
  assert.ok(!result.includes("{") && !result.includes("}") && !result.includes('"'));
});

test("buildFieldText yields an empty string when every field is blank", () => {
  assert.equal(buildFieldText(["character", "hair_style"], { character: "", hair_style: "  " }), "");
});

test("buildFieldText treats a missing token as an empty (dropped) value", () => {
  assert.equal(buildFieldText(["character"], {}), "");
});

// ---- render.mjs: updatePreview shows the labeled-prose text (mirrors the
// backend's primary output), not JSON or the flat renderPrompt string ----

test("updatePreview shows one labeled line per non-empty field, dropping empty ones", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node } = makeFakeNode([300, 400]);

    refs.templateEl.value = "{character}, {hair_style}";
    rebuildFields(node, refs);

    const entry = refs.fieldRows.get("character");
    entry.input.value = "Aria";
    fire(entry.input, "input");

    assert.equal(refs.previewEl.wpbRenderedText, "Character: Aria");
    assert.ok(!refs.previewEl.innerHTML.includes("wpb-preview-empty"));
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("updatePreview shows the italic muted placeholder when every field is still empty", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node } = makeFakeNode([300, 400]);

    refs.templateEl.value = "{character}";
    rebuildFields(node, refs);

    assert.match(refs.previewEl.innerHTML, /wpb-preview-empty/);
    assert.equal(refs.previewEl.wpbRenderedText, "");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("updatePreview updates live as fields change, without resizing", () => {
  const raf = installRafStub();
  try {
    const doc = makeDocStub();
    const refs = buildRoot(doc);
    const { node, setSizeCalls } = makeFakeNode([300, 400]);

    refs.templateEl.value = "{character}";
    rebuildFields(node, refs);
    raf.flush();
    setSizeCalls.length = 0;

    const entry = refs.fieldRows.get("character");
    entry.input.value = "Kael";
    fire(entry.input, "input");
    assert.equal(refs.previewEl.wpbRenderedText, "Character: Kael");

    entry.input.value = "Kael Rin";
    fire(entry.input, "input");
    assert.equal(refs.previewEl.wpbRenderedText, "Character: Kael Rin");

    assert.equal(setSizeCalls.length, 0, "a value edit must never resize the node");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

// ---- index.js: source-level assertions --------------------------------
//
// `index.js` imports `app` from the absolute ComfyUI host path
// (`/scripts/app.js`), which cannot resolve under plain Node, so its
// LiteGraph-facing pieces are verified by source inspection instead of
// execution.

const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");

// Strip `/* ... */` and `// ...` comments so the "does the CODE do X"
// assertions below don't false-positive on doc comments that merely
// *describe* rationale (e.g. mentioning `getMinHeight` by name). Good
// enough for this source file (no string literals containing `//` or `/*`).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const indexCode = stripComments(indexSource);

test("index.js's addDOMWidget call passes a getMinHeight option (LEGACY, primary path)", () => {
  assert.ok(/getMinHeight\s*:/.test(indexCode), "expected a getMinHeight option in the addDOMWidget call");
  assert.ok(/measureMinHeight\(refs\.root\)/.test(indexCode));
});

test("index.js's widget defines NO computeSize/getHeight overrides", () => {
  assert.ok(!/widget\.computeSize\s*=/.test(indexCode), "widget.computeSize should be removed");
  assert.ok(!/widget\.getHeight\s*=/.test(indexCode), "widget.getHeight should be removed");
});

test("index.js exposes computeLayoutSize (Nodes 2.0 compatibility) with minWidth: 1", () => {
  assert.ok(/widget\.computeLayoutSize\s*=/.test(indexCode));
  assert.ok(/minWidth:\s*1/.test(indexCode));
  assert.ok(/minHeight:\s*measureMinHeight\(refs\.root\)/.test(indexCode));
});

test("index.js wires rebuildFields for onNodeCreated (setupNode) and onConfigure (restoreNode), gated by _pbConfigured", () => {
  assert.ok(/rebuildFields/.test(indexCode));
  assert.ok(/function setupNode/.test(indexCode));
  assert.ok(/function restoreNode/.test(indexCode));
  assert.ok(/_pbConfigured/.test(indexCode));
});

test("index.js's onConfigure wrap sets _pbConfigured = true BEFORE calling the original onConfigure or restoreNode", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onConfigure = function");
  assert.ok(idx >= 0, "expected an onConfigure wrap");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  const flagIdx = body.indexOf("_pbConfigured = true");
  const origIdx = body.indexOf("originalOnConfigure.apply");
  const restoreIdx = body.indexOf("restoreNode(this)");
  assert.ok(flagIdx >= 0, "expected _pbConfigured = true in the onConfigure wrap");
  assert.ok(origIdx > flagIdx, "the flag must be set before calling the original onConfigure");
  assert.ok(restoreIdx > flagIdx, "the flag must be set before calling restoreNode");
});

test("index.js's restoreNode calls rebuildFields with { silent: true } — the restore path never schedules a refit itself", () => {
  const idx = indexCode.indexOf("function restoreNode");
  assert.ok(idx >= 0, "expected a restoreNode function");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(/rebuildFields\(node,\s*refs,\s*\{\s*silent:\s*true\s*\}\)/.test(body));
});

test("index.js's setupNode no longer calls scheduleRefit directly (the guarded initial fit lives entirely in rebuildFields)", () => {
  const idx = indexCode.indexOf("function setupNode");
  assert.ok(idx >= 0);
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(!/scheduleRefit\(/.test(body), "setupNode must not call scheduleRefit directly");
});

test("index.js no longer has the old deterministic/floor-only resize helpers", () => {
  assert.ok(!/installResizeFloor/.test(indexCode), "installResizeFloor should be removed");
  assert.ok(!/computeWidgetHeight/.test(indexCode), "computeWidgetHeight should be removed");
  assert.ok(!/MIN_NODE_WIDTH/.test(indexCode), "MIN_NODE_WIDTH should be removed");
});

// ---- index.js: prompt_builder_state widget delivery (the fixed bug) ---

test("index.js hides the prompt_builder_state widget exactly like the template widget (hidden + collapsed computeSize + inputEl display:none), and never sets serialize on it", () => {
  const idx = indexCode.indexOf("function hideStateWidget");
  assert.ok(idx >= 0, "expected a hideStateWidget function");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(/stateWidget\.hidden\s*=\s*true/.test(body));
  assert.ok(/stateWidget\.computeSize\s*=\s*\(\)\s*=>\s*\[0,\s*-4\]/.test(body));
  assert.ok(/stateWidget\.inputEl\.style\.display\s*=\s*"none"/.test(body));
  // The whole point of the fix: this widget MUST keep serializing, so
  // hideStateWidget (unlike the UI-only wpb_ui DOM widget elsewhere in the
  // file) must never touch `.serialize`.
  assert.ok(!/serialize/.test(body), "hideStateWidget must never set serialize on the state widget");
});

test("index.js finds the prompt_builder_state widget via core.mjs's findStateWidget (a real declared widget, not a hidden INPUT_TYPES entry)", () => {
  assert.ok(/findStateWidget/.test(indexCode));
  assert.ok(/from\s+"\.\/core\.mjs"/.test(indexCode));
});

test("index.js no longer wraps app.graphToPrompt (the removed delivery mechanism)", () => {
  assert.ok(!/graphToPrompt/.test(indexCode), "the app.graphToPrompt wrap must be removed entirely");
  assert.ok(!/async setup\(\)/.test(indexCode), "the extension's now-empty setup() hook should be removed too");
});

test("index.js's onConfigure path (restoreNode) parses the restored prompt_builder_state widget back into state via restoreStateFromWidget", () => {
  const idx = indexCode.indexOf("function restoreNode");
  assert.ok(idx >= 0, "expected a restoreNode function");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(
    /restoreStateFromWidget\(node\)/.test(body),
    "restoreNode must re-parse the widget's restored value into node.properties.promptBuilderState"
  );
});

test("index.js's mountUI (the on-mount restore point) also calls restoreStateFromWidget, before the first rebuildFields", () => {
  const idx = indexCode.indexOf("function mountUI");
  assert.ok(idx >= 0, "expected a mountUI function");
  const end = indexCode.indexOf("\nfunction setupNode", idx);
  const body = indexCode.slice(idx, end >= 0 ? end : indexCode.length);
  const restoreIdx = body.indexOf("restoreStateFromWidget(node)");
  const rebuildIdx = body.indexOf("rebuildFields(node, refs)");
  assert.ok(restoreIdx >= 0, "expected mountUI to call restoreStateFromWidget");
  assert.ok(rebuildIdx >= 0, "expected mountUI to call rebuildFields");
  assert.ok(restoreIdx < rebuildIdx, "state must be restored from the widget BEFORE rows are (re)built");
});

// ---- Summary ------------------------------------------------------------

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
