/**
 * test_flip.mjs — regression tests for `flip.mjs`'s track-agnostic FLIP
 * (First-Last-Invert-Play) drag-reorder settle core, extracted from
 * `js/controls/lora_interaction.mjs`'s original `captureRowTops`/`flipRows`
 * (see that module's own top doc comment) while porting the same animation
 * to the Control/Loader Panel. Plain `node`, a tiny local DOM element stub
 * (mirrors `js/controls/test_lora_resize.mjs`'s own `_rect`-backed
 * `getBoundingClientRect` convention) — no `app`/`window`/`LiteGraph`.
 *
 * Exercises the core against TWO different entry shapes on purpose (one
 * shaped like `node._lrRows` -- `{ id, refs: { root } }` -- and one shaped
 * like `node._ctrlRows` -- `{ id, kind, widget, refs: { root, row,
 * kindMeta } }`) with two different `getEl` accessors, precisely because
 * `js/controls/interaction.mjs`'s own port of this module has to work
 * against the SECOND shape, not the first one this core was originally
 * written for — a test that only ever used the LoRA shape wouldn't catch a
 * `getEl`-parameterisation bug the Control Panel wrapper could hit.
 */

import assert from "node:assert/strict";

import { captureRowTops, flipRows } from "./flip.mjs";

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

// ---------------------------------------------------------------------------
// Minimal element stub -- just enough for getBoundingClientRect/classList/
// style, mirroring test_lora_resize.mjs's own `_rect`-backed convention.
// ---------------------------------------------------------------------------

function makeEl() {
  const classes = new Set();
  return {
    _rect: { top: 0 },
    style: {},
    classList: {
      add: (...cls) => cls.forEach((c) => classes.add(c)),
      remove: (...cls) => cls.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    getBoundingClientRect() {
      return this._rect;
    },
  };
}

const FLIP_OPTS = { className: "wtn-row-flip", settleMs: 200 };

// LoRA-shaped accessor: entry.refs.root.
function loraGetEl(entry) {
  return entry && entry.refs && entry.refs.root;
}

// ---------------------------------------------------------------------------
// captureRowTops
// ---------------------------------------------------------------------------

test("captureRowTops: keyed by entry id, reads each entry's element CURRENT top via the supplied getEl", () => {
  const elA = makeEl();
  const elB = makeEl();
  elA._rect.top = 5;
  elB._rect.top = 65;
  const entries = [
    { id: "x", refs: { root: elA } },
    { id: "y", refs: { root: elB } },
  ];
  const tops = captureRowTops(entries, loraGetEl);
  assert.equal(tops.get("x"), 5);
  assert.equal(tops.get("y"), 65);
});

test("captureRowTops: an entry whose element has no getBoundingClientRect is skipped, never throws", () => {
  const entries = [{ id: 1, refs: { root: {} } }];
  assert.doesNotThrow(() => captureRowTops(entries, loraGetEl));
  assert.equal(captureRowTops(entries, loraGetEl).size, 0);
});

test("captureRowTops: a null/undefined entries list is treated as empty, never throws", () => {
  assert.doesNotThrow(() => captureRowTops(null, loraGetEl));
  assert.equal(captureRowTops(null, loraGetEl).size, 0);
});

// ---------------------------------------------------------------------------
// flipRows -- LoRA-shaped entries (entry.refs.root)
// ---------------------------------------------------------------------------

test("flipRows: writes each MOVED entry's inverse-translate transform immediately, then (next rAF) transitions it to 0 via className", () => {
  const elA = makeEl();
  const elB = makeEl();
  elA._rect.top = 0;
  elB._rect.top = 30;
  const entries = [
    { id: 1, refs: { root: elA } },
    { id: 2, refs: { root: elB } },
  ];

  const before = captureRowTops(entries, loraGetEl); // {1: 0, 2: 30}

  // Simulate the reflow the caller's own repaint already performed: the two
  // rows swapped places.
  elA._rect.top = 30;
  elB._rect.top = 0;

  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
  try {
    flipRows(entries, loraGetEl, before, FLIP_OPTS);
    // Immediately (before any rAF fires): each row shows its OWN inverse
    // delta, and does NOT yet carry the transitioning class -- if it did,
    // the CSS transition would animate the assignment itself, defeating the
    // "instantly at the old position first" half of FLIP.
    assert.equal(elA.style.transform, "translateY(-30px)"); // was 0, now 30 -> dy = -30
    assert.equal(elB.style.transform, "translateY(30px)"); // was 30, now 0 -> dy = 30
    assert.equal(elA.classList.contains("wtn-row-flip"), false);
    assert.equal(elB.classList.contains("wtn-row-flip"), false);

    rafQueue.slice().forEach((cb) => cb());
    assert.equal(elA.style.transform, "", "cleared back to nothing -- the CSS transition animates FROM the inline value TO this");
    assert.equal(elB.style.transform, "");
    assert.equal(elA.classList.contains("wtn-row-flip"), true);
    assert.equal(elB.classList.contains("wtn-row-flip"), true);
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("flipRows: an entry whose top did NOT change is left completely untouched -- no transform, no flip class", () => {
  const el = makeEl();
  el._rect.top = 10;
  const entries = [{ id: 1, refs: { root: el } }];
  const before = captureRowTops(entries, loraGetEl);
  // top unchanged (10 -> 10)
  flipRows(entries, loraGetEl, before, FLIP_OPTS);
  assert.ok(!el.style.transform, "no transform must ever be written for a row that didn't move");
  assert.equal(el.classList.contains("wtn-row-flip"), false);
});

test("flipRows: with no requestAnimationFrame host (this suite's own default), the transform settles IMMEDIATELY -- never stuck mid-transform", () => {
  assert.equal(typeof globalThis.requestAnimationFrame, "undefined", "sanity: no rAF stub installed in this test");
  const el = makeEl();
  el._rect.top = 0;
  const entries = [{ id: 1, refs: { root: el } }];
  const before = captureRowTops(entries, loraGetEl);
  el._rect.top = 40;
  flipRows(entries, loraGetEl, before, FLIP_OPTS);
  assert.equal(el.style.transform, "", "must settle immediately with no animation-frame host available");
});

test("flipRows: an entry id absent from beforeTops (e.g. a brand-new row) is skipped, never throws", () => {
  const el = makeEl();
  el._rect.top = 0;
  const entries = [{ id: 999, refs: { root: el } }];
  assert.doesNotThrow(() => flipRows(entries, loraGetEl, new Map(), FLIP_OPTS));
  assert.ok(!el.style.transform, "a row with no 'before' entry must be left completely alone");
});

test("flipRows: a restarted flip (className still applied mid-flight) doesn't stack -- classList.remove is called before the new inline transform is written", () => {
  const el = makeEl();
  el._rect.top = 0;
  el.classList.add("wtn-row-flip"); // simulate a previous flip still mid-transition
  const entries = [{ id: 1, refs: { root: el } }];
  const before = captureRowTops(entries, loraGetEl);
  el._rect.top = 20;
  globalThis.requestAnimationFrame = () => {}; // never fires -- just need the "immediate settle" branch NOT taken
  try {
    flipRows(entries, loraGetEl, before, FLIP_OPTS);
    assert.equal(el.classList.contains("wtn-row-flip"), false, "must restart cleanly, not stack onto a still-running transition");
    assert.equal(el.style.transform, "translateY(-20px)");
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

// ---------------------------------------------------------------------------
// flipRows -- Control-Panel-shaped entries (one addDOMWidget PER ROW --
// entry.refs.root is STILL the element, but the entry itself carries a
// `widget`/`kind` this core must never look at, only `id` + whatever getEl
// returns).
// ---------------------------------------------------------------------------

function ctrlGetEl(entry) {
  return entry && entry.refs && entry.refs.root;
}

test("flipRows: works identically against Control-Panel-shaped entries ({id, kind, widget, refs: {root, row, kindMeta}}) via a getEl of the SAME name -- the core only ever touches id + getEl(entry)", () => {
  const elA = makeEl();
  const elB = makeEl();
  elA._rect.top = 0;
  elB._rect.top = 34; // ROW_H + ROW_GAP pitch, just for realism
  const entries = [
    { id: "row-a", kind: "int", widget: { y: 0 }, refs: { root: elA, row: { id: "row-a", kind: "int" }, kindMeta: {} } },
    { id: "row-b", kind: "seed", widget: { y: 34 }, refs: { root: elB, row: { id: "row-b", kind: "seed" }, kindMeta: {} } },
  ];

  const before = captureRowTops(entries, ctrlGetEl);
  // Simulate the async DOM-widget-host repaint the Control Panel wrapper
  // waits a frame for (see js/controls/interaction.mjs's own flipRows).
  elA._rect.top = 34;
  elB._rect.top = 0;

  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
  try {
    flipRows(entries, ctrlGetEl, before, FLIP_OPTS);
    assert.equal(elA.style.transform, "translateY(-34px)");
    assert.equal(elB.style.transform, "translateY(34px)");
    rafQueue.slice().forEach((cb) => cb());
    assert.equal(elA.classList.contains("wtn-row-flip"), true);
    assert.equal(elB.classList.contains("wtn-row-flip"), true);
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("flipRows: never reads entry.refs.row (the STATE row object, not a DOM element) even if a getEl accidentally returned it -- documents the real bug this core must not reintroduce", () => {
  // A `getEl` that (wrongly) returns the state row object instead of the DOM
  // element has no getBoundingClientRect -- the core's own guard must skip
  // it silently, never throw, matching how a stray wiring mistake would fail
  // (silently invisible, not a crash) -- exactly the failure mode this whole
  // task exists to avoid shipping.
  const entries = [{ id: 1, refs: { root: makeEl(), row: { id: 1, kind: "int", value: 5 } } }];
  const wrongGetEl = (entry) => entry.refs.row; // the trap: state object, not the element
  assert.doesNotThrow(() => captureRowTops(entries, wrongGetEl));
  assert.equal(captureRowTops(entries, wrongGetEl).size, 0, "a non-DOM 'element' must never be treated as one");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
