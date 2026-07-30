/**
 * test_lora_state.mjs — regression tests for `lora_state.mjs`'s pure state
 * model: normalization tolerance (a hostile blob never throws, unknown keys
 * survive, missing keys default), add/remove/duplicate/move, the
 * master-switch tri-state logic, and the `N/M` counter. No DOM, no
 * `app`/`window`/`LiteGraph` -- plain `node js/controls/test_lora_state.mjs`.
 *
 * `reorderRows` ("move") is `rows.mjs`'s pure array-move helper, reused
 * as-is by `lora_interaction.mjs` (see that file's top doc comment) -- this
 * suite imports it directly from `./rows.mjs` to confirm it behaves
 * correctly over LoRA row objects too (id-based identity, not kind-aware),
 * rather than re-testing `rows.mjs`'s own suite here.
 */

import assert from "node:assert/strict";

import {
  DEFAULT_STRENGTH,
  STRENGTH_STEP,
  STRENGTH_STEP_MIN,
  STRENGTH_STEP_MAX,
  STRENGTH_MIN,
  STRENGTH_MAX,
  CACHE_MODES,
  CACHE_MODE_ORDER,
  CACHE_MODE_LABELS,
  DEFAULT_CACHE_MODE,
  DEFAULT_SEP,
  DEFAULT_SEP_STRENGTHS,
  clampStrength,
  clampStrengthStep,
  mkRow,
  defaultState,
  normalizeRow,
  normalizeState,
  hasSavedRows,
  addRow,
  duplicateRow,
  removeRow,
  setRowOn,
  bumpRowStrength,
  setRowStrength,
  parseTypedStrength,
  setSepStrengths,
  setCacheMode,
  setSep,
  setDefaultStrength,
  setStrengthStep,
  allRowsOn,
  onCounts,
  toggleMaster,
} from "./lora_state.mjs";

import { reorderRows } from "./rows.mjs";

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

// =========================================================================
// clampStrength
// =========================================================================

test("clampStrength: clamps into [STRENGTH_MIN, STRENGTH_MAX]", () => {
  assert.equal(clampStrength(-5), STRENGTH_MIN);
  assert.equal(clampStrength(50), STRENGTH_MAX);
  assert.equal(clampStrength(0.8), 0.8);
});

test("clampStrength: non-finite input falls back to DEFAULT_STRENGTH", () => {
  assert.equal(clampStrength(NaN), DEFAULT_STRENGTH);
  assert.equal(clampStrength(undefined), DEFAULT_STRENGTH);
  assert.equal(clampStrength("nope"), DEFAULT_STRENGTH);
  assert.equal(clampStrength(null), DEFAULT_STRENGTH);
});

test("clampStrength: rounds to 2 decimals -- repeated +STEP never drifts", () => {
  let v = 0;
  for (let i = 0; i < 3; i += 1) {
    v = clampStrength(v + STRENGTH_STEP);
  }
  assert.equal(v, 0.15);
});

// =========================================================================
// mkRow / defaultState
// =========================================================================

test("mkRow: defaults -- on, DEFAULT_STRENGTH for both sm/sc, empty name/triggers", () => {
  const row = mkRow();
  assert.equal(row.on, true);
  assert.equal(row.sm, DEFAULT_STRENGTH);
  assert.equal(row.sc, DEFAULT_STRENGTH);
  assert.equal(row.name, "");
  assert.deepEqual(row.triggers, []);
  assert.equal(typeof row.id, "number");
});

test("mkRow: two calls never share an id, even with identical overrides", () => {
  const a = mkRow({ name: "x" });
  const b = mkRow({ name: "x" });
  assert.notEqual(a.id, b.id);
});

test("mkRow: overrides.id can never win -- id is always freshly allocated", () => {
  const row = mkRow({ id: 999999, name: "x" });
  assert.notEqual(row.id, 999999);
});

test("mkRow: sc defaults to the (clamped) sm when only sm is overridden", () => {
  const row = mkRow({ sm: 1.4 });
  assert.equal(row.sm, 1.4);
  assert.equal(row.sc, 1.4);
});

test("defaultState: version 1, empty rows, cacheMode last, sep ', ', and Slice 5's three per-node ⚙ defaults", () => {
  const s = defaultState();
  assert.equal(s.version, 1);
  assert.deepEqual(s.rows, []);
  assert.equal(s.cacheMode, DEFAULT_CACHE_MODE);
  assert.equal(s.sep, DEFAULT_SEP);
  assert.equal(s.sepStrengths, DEFAULT_SEP_STRENGTHS);
  assert.equal(s.defaultStrength, DEFAULT_STRENGTH);
  assert.equal(s.strengthStep, STRENGTH_STEP);
});

// =========================================================================
// clampStrengthStep (§7b "Strength step (arrows)")
// =========================================================================

test("clampStrengthStep: clamps into [STRENGTH_STEP_MIN, STRENGTH_STEP_MAX]", () => {
  assert.equal(clampStrengthStep(0.005), STRENGTH_STEP_MIN);
  assert.equal(clampStrengthStep(5), STRENGTH_STEP_MAX);
  assert.equal(clampStrengthStep(0.1), 0.1);
});

test("clampStrengthStep: non-finite, zero, or negative input falls back to STRENGTH_STEP", () => {
  assert.equal(clampStrengthStep(NaN), STRENGTH_STEP);
  assert.equal(clampStrengthStep(undefined), STRENGTH_STEP);
  assert.equal(clampStrengthStep("nope"), STRENGTH_STEP);
  assert.equal(clampStrengthStep(0), STRENGTH_STEP);
  assert.equal(clampStrengthStep(-0.05), STRENGTH_STEP);
});

// =========================================================================
// Normalization tolerance -- a hostile blob must never throw, and every
// documented shape degrades sanely.
// =========================================================================

const HOSTILE_TOP_LEVEL = [null, undefined, 42, "hello", [1, 2, 3], true, { rows: "nope" }, { rows: null }, { rows: 42 }];

test("normalizeState: every hostile top-level shape degrades to a valid, empty-rows state without throwing", () => {
  for (const blob of HOSTILE_TOP_LEVEL) {
    const s = normalizeState(blob);
    assert.equal(s.version, 1, `version for ${JSON.stringify(blob)}`);
    assert.deepEqual(s.rows, [], `rows for ${JSON.stringify(blob)}`);
    assert.equal(s.cacheMode, DEFAULT_CACHE_MODE);
    assert.equal(s.sep, DEFAULT_SEP);
  }
});

test("normalizeState: a hostile row inside `rows` (null/number/string/array) is dropped, not coerced", () => {
  const s = normalizeState({ rows: [null, 42, "x", [1, 2], { name: "keep me" }] });
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].name, "keep me");
});

test("normalizeState: unknown TOP-LEVEL keys survive a round trip", () => {
  const s = normalizeState({ rows: [], futureField: "carry me" });
  assert.equal(s.futureField, "carry me");
});

test("normalizeState: unknown PER-ROW keys survive a round trip (additive contract)", () => {
  const s = normalizeState({ rows: [{ name: "a.safetensors", futureRowField: 123 }] });
  assert.equal(s.rows[0].futureRowField, 123);
});

test("normalizeState: missing cacheMode/sep default; an invalid cacheMode falls back to 'last'", () => {
  const s1 = normalizeState({ rows: [] });
  assert.equal(s1.cacheMode, "last");
  assert.equal(s1.sep, ", ");
  const s2 = normalizeState({ rows: [], cacheMode: "bogus", sep: 42 });
  assert.equal(s2.cacheMode, "last");
  assert.equal(s2.sep, ", ");
  for (const mode of CACHE_MODES) {
    const s3 = normalizeState({ rows: [], cacheMode: mode });
    assert.equal(s3.cacheMode, mode);
  }
});

test("normalizeState: Slice 5's three per-node ⚙ fields -- missing default, hostile degrades, a real value survives", () => {
  const s1 = normalizeState({ rows: [] });
  assert.equal(s1.sepStrengths, false);
  assert.equal(s1.defaultStrength, DEFAULT_STRENGTH);
  assert.equal(s1.strengthStep, STRENGTH_STEP);

  // truthy-but-not-boolean must NOT spoof sepStrengths on (same convention
  // as row.on's own tolerance, exercised elsewhere in this file).
  const s2 = normalizeState({ rows: [], sepStrengths: "yes" });
  assert.equal(s2.sepStrengths, false);
  const s3 = normalizeState({ rows: [], sepStrengths: true, defaultStrength: 1.4, strengthStep: 0.1 });
  assert.equal(s3.sepStrengths, true);
  assert.equal(s3.defaultStrength, 1.4);
  assert.equal(s3.strengthStep, 0.1);

  // Every hostile top-level shape must ALSO degrade these three sanely.
  for (const blob of HOSTILE_TOP_LEVEL) {
    const s = normalizeState(blob);
    assert.equal(s.sepStrengths, false, `sepStrengths for ${JSON.stringify(blob)}`);
    assert.equal(s.defaultStrength, DEFAULT_STRENGTH, `defaultStrength for ${JSON.stringify(blob)}`);
    assert.equal(s.strengthStep, STRENGTH_STEP, `strengthStep for ${JSON.stringify(blob)}`);
  }
});

test("normalizeRow: on defaults true; only an explicit `false` turns a row off", () => {
  assert.equal(normalizeRow({}).on, true);
  assert.equal(normalizeRow({ on: false }).on, false);
  assert.equal(normalizeRow({ on: "no" }).on, true); // truthy-but-not-boolean does NOT spoof off
  assert.equal(normalizeRow({ on: 0 }).on, true);
});

test("normalizeRow: name defaults to '' for anything that isn't already a string", () => {
  assert.equal(normalizeRow({ name: 5 }).name, "");
  assert.equal(normalizeRow({ name: null }).name, "");
  assert.equal(normalizeRow({}).name, "");
  assert.equal(normalizeRow({ name: "ok.safetensors" }).name, "ok.safetensors");
});

test("normalizeRow: sm/sc clamp independently; sc falls back to sm when absent/garbage", () => {
  const r1 = normalizeRow({ sm: 99, sc: -99 });
  assert.equal(r1.sm, STRENGTH_MAX);
  assert.equal(r1.sc, STRENGTH_MIN);
  const r2 = normalizeRow({ sm: 0.4 });
  assert.equal(r2.sc, 0.4);
  const r3 = normalizeRow({ sm: 0.4, sc: "NaN" });
  assert.equal(r3.sc, 0.4);
});

test("normalizeRow: triggers -- a non-array becomes []; non-string/blank entries are dropped and trimmed", () => {
  assert.deepEqual(normalizeRow({ triggers: "not-an-array" }).triggers, []);
  assert.deepEqual(normalizeRow({ triggers: null }).triggers, []);
  assert.deepEqual(normalizeRow({ triggers: [" a ", "", "  ", 5, null, "b"] }).triggers, ["a", "b"]);
});

test("normalizeRow: customTriggers -- same tolerance as triggers, and it's a SEPARATE field", () => {
  assert.deepEqual(normalizeRow({ customTriggers: "not-an-array" }).customTriggers, []);
  assert.deepEqual(normalizeRow({ customTriggers: null }).customTriggers, []);
  assert.deepEqual(normalizeRow({ customTriggers: [" elf ears ", "", 5, "glow"] }).customTriggers, ["elf ears", "glow"]);
  // The two lists are independent -- one being set never leaks into the other.
  const r = normalizeRow({ triggers: ["a"], customTriggers: ["b"] });
  assert.deepEqual(r.triggers, ["a"]);
  assert.deepEqual(r.customTriggers, ["b"]);
});

test("mkRow: customTriggers defaults to [] too, and honours an override", () => {
  assert.deepEqual(mkRow().customTriggers, []);
  assert.deepEqual(mkRow({ customTriggers: ["elf ears"] }).customTriggers, ["elf ears"]);
});

test("normalizeRow: two rows normalized from IDENTICAL raw input still get distinct ids", () => {
  const raw = { name: "same.safetensors" };
  const a = normalizeRow(raw);
  const b = normalizeRow(raw);
  assert.notEqual(a.id, b.id);
});

test("hasSavedRows: only an explicit rows ARRAY counts -- distinguishes 'brand new' from 'deliberately emptied'", () => {
  assert.equal(hasSavedRows({}), false);
  assert.equal(hasSavedRows({ rows: "nope" }), false);
  assert.equal(hasSavedRows(null), false);
  assert.equal(hasSavedRows(42), false);
  assert.equal(hasSavedRows([1, 2, 3]), false);
  assert.equal(hasSavedRows({ rows: [] }), true); // deliberately emptied -- still "saved"
  assert.equal(hasSavedRows({ rows: [{ name: "x" }] }), true);
});

// =========================================================================
// add / remove / duplicate / move
// =========================================================================

test("addRow: pushes a fresh default row and returns it", () => {
  const state = defaultState();
  const row = addRow(state);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0], row);
  assert.equal(row.on, true);
});

test("addRow: a new row starts at state.defaultStrength (§7b), not the hardcoded DEFAULT_STRENGTH", () => {
  const state = defaultState();
  setDefaultStrength(state, 1.2);
  const row = addRow(state);
  assert.equal(row.sm, 1.2);
  assert.equal(row.sc, 1.2);
});

test("addRow: falls back to DEFAULT_STRENGTH when state predates the defaultStrength field", () => {
  const state = defaultState();
  delete state.defaultStrength; // simulates a workflow saved by an older build
  const row = addRow(state);
  assert.equal(row.sm, DEFAULT_STRENGTH);
  assert.equal(row.sc, DEFAULT_STRENGTH);
});

test("duplicateRow: inserts an independent copy immediately after the original, with a fresh id", () => {
  const state = defaultState();
  const original = addRow(state);
  original.name = "a.safetensors";
  original.triggers.push("word");
  const copy = duplicateRow(state, original.id);
  assert.equal(state.rows.length, 2);
  assert.equal(state.rows[1], copy);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.name, "a.safetensors");
  // Independent array -- mutating the copy's triggers must not touch the original's.
  copy.triggers.push("only-copy");
  assert.deepEqual(original.triggers, ["word"]);
  assert.deepEqual(copy.triggers, ["word", "only-copy"]);

  // Same independence for customTriggers -- a deselected-but-remembered
  // custom word must not become shared state between the two rows.
  original.customTriggers.push("elf ears");
  const copy2 = duplicateRow(state, original.id);
  copy2.customTriggers.push("only-copy-2");
  assert.deepEqual(original.customTriggers, ["elf ears"]);
  assert.deepEqual(copy2.customTriggers, ["elf ears", "only-copy-2"]);
});

test("duplicateRow: unknown id returns null and leaves rows untouched", () => {
  const state = defaultState();
  addRow(state);
  const result = duplicateRow(state, 999999);
  assert.equal(result, null);
  assert.equal(state.rows.length, 1);
});

test("removeRow: removes the row with a matching id and returns true; unknown id returns false", () => {
  const state = defaultState();
  const a = addRow(state);
  const b = addRow(state);
  assert.equal(removeRow(state, 999999), false);
  assert.equal(state.rows.length, 2);
  assert.equal(removeRow(state, a.id), true);
  assert.deepEqual(state.rows, [b]);
});

test("setRowOn: flips the matching row's `on`, coerced to a real boolean; unknown id returns false", () => {
  const state = defaultState();
  const a = addRow(state);
  assert.equal(setRowOn(state, a.id, false), true);
  assert.equal(a.on, false);
  assert.equal(setRowOn(state, a.id, "truthy-string"), true);
  assert.equal(a.on, true); // coerced with !!, not stored as the string itself
  assert.equal(setRowOn(state, 999999, true), false);
});

test("bumpRowStrength: bumps sm AND sc together (single-strength-control contract) and clamps", () => {
  const state = defaultState();
  const a = addRow(state); // sm = sc = DEFAULT_STRENGTH (0.8)
  assert.equal(bumpRowStrength(state, a.id, STRENGTH_STEP), true);
  assert.equal(a.sm, clampStrength(DEFAULT_STRENGTH + STRENGTH_STEP)); // clamped/rounded, not raw float addition
  assert.equal(a.sc, a.sm);
  // Clamp at the ceiling.
  a.sm = STRENGTH_MAX;
  a.sc = STRENGTH_MAX;
  bumpRowStrength(state, a.id, 1);
  assert.equal(a.sm, STRENGTH_MAX);
  assert.equal(a.sc, STRENGTH_MAX);
  assert.equal(bumpRowStrength(state, 999999, STRENGTH_STEP), false);
});

test("bumpRowStrength: with sepStrengths true, sm/sc diverge -- only the named field moves (§7b 'Show two strengths per row')", () => {
  const state = defaultState();
  setSepStrengths(state, true);
  const a = addRow(state); // sm = sc = DEFAULT_STRENGTH
  bumpRowStrength(state, a.id, STRENGTH_STEP, "sm");
  assert.equal(a.sm, clampStrength(DEFAULT_STRENGTH + STRENGTH_STEP));
  assert.equal(a.sc, DEFAULT_STRENGTH, "sc must NOT move when only sm was bumped, in two-strength mode");

  bumpRowStrength(state, a.id, -STRENGTH_STEP * 2, "sc");
  assert.equal(a.sc, clampStrength(DEFAULT_STRENGTH - STRENGTH_STEP * 2));
  assert.equal(a.sm, clampStrength(DEFAULT_STRENGTH + STRENGTH_STEP), "sm must NOT move when only sc was bumped");
});

test("bumpRowStrength: an unrecognised field defaults to 'sm'", () => {
  const state = defaultState();
  setSepStrengths(state, true);
  const a = addRow(state);
  bumpRowStrength(state, a.id, STRENGTH_STEP, "bogus");
  assert.equal(a.sm, clampStrength(DEFAULT_STRENGTH + STRENGTH_STEP));
  assert.equal(a.sc, DEFAULT_STRENGTH);
});

// =========================================================================
// BUG 17 (2026-07-29 owner report) -- the typed-strength field: parsing
// user text and the absolute-set counterpart to bumpRowStrength.
// =========================================================================

test("parseTypedStrength: a plain finite number string parses through", () => {
  assert.equal(parseTypedStrength("0.65"), 0.65);
  assert.equal(parseTypedStrength("  1.2  "), 1.2); // surrounding whitespace tolerated
  assert.equal(parseTypedStrength("-0.5"), -0.5); // a single leading '-' IS a valid number
  assert.equal(parseTypedStrength("2"), 2);
});

test("parseTypedStrength: every garbage case from the owner's own list returns null, never a number", () => {
  assert.equal(parseTypedStrength(""), null);
  assert.equal(parseTypedStrength("   "), null);
  assert.equal(parseTypedStrength("abc"), null);
  assert.equal(parseTypedStrength("--1"), null); // not a valid numeric token
  assert.equal(parseTypedStrength("1e999"), null); // overflows to Infinity -- NOT finite
  assert.equal(parseTypedStrength("NaN"), null); // the literal string "NaN"
  assert.equal(parseTypedStrength("0.5\nDROP TABLE"), null); // pasted multi-line blob
  assert.equal(parseTypedStrength(null), null);
  assert.equal(parseTypedStrength(undefined), null);
  assert.equal(parseTypedStrength(NaN), null);
});

test("parseTypedStrength: never clamps/rounds itself -- that stays clampStrength's ONE job", () => {
  assert.equal(parseTypedStrength("500"), 500); // NOT clamped here -- the caller clamps
  assert.equal(parseTypedStrength("-50"), -50);
});

test("setRowStrength: single-strength mode -- sets sm AND sc together, clamped/rounded through clampStrength", () => {
  const state = defaultState();
  const a = addRow(state);
  assert.equal(setRowStrength(state, a.id, "sm", 0.6543), true);
  assert.equal(a.sm, clampStrength(0.6543));
  assert.equal(a.sc, a.sm, "sc must move in lockstep when sepStrengths is off, exactly like bumpRowStrength");
  assert.equal(setRowStrength(state, 999999, "sm", 1), false);
});

test("setRowStrength: sepStrengths true -- only the named field moves, the other stays put", () => {
  const state = defaultState();
  setSepStrengths(state, true);
  const a = addRow(state); // sm = sc = DEFAULT_STRENGTH
  setRowStrength(state, a.id, "sm", 1.5);
  assert.equal(a.sm, 1.5);
  assert.equal(a.sc, DEFAULT_STRENGTH, "sc must NOT move when only sm was set, in two-strength mode");
  setRowStrength(state, a.id, "sc", 0.3);
  assert.equal(a.sc, 0.3);
  assert.equal(a.sm, 1.5, "sm must NOT move when only sc was set");
});

test("setRowStrength: clamps out-of-range input through the SAME range as bumpRowStrength (STRENGTH_MIN=0, no negative clamp floor beyond that)", () => {
  const state = defaultState();
  const a = addRow(state);
  setRowStrength(state, a.id, "sm", -50);
  assert.equal(a.sm, STRENGTH_MIN, "STRENGTH_MIN is 0 -- inherited from upstream's range, not a deliberate negative-LoRA-weight decision (see lora_state.mjs's own BUG 17 comment)");
  setRowStrength(state, a.id, "sm", 500);
  assert.equal(a.sm, STRENGTH_MAX);
});

test("setRowStrength + bumpRowStrength: a typed value and an arrow-bumped value land on the IDENTICAL stored number for the same target", () => {
  const state = defaultState();
  const a = addRow(state); // 0.8
  const b = addRow(state); // 0.8
  // Row a: bump by +STRENGTH_STEP*3 via the arrows.
  bumpRowStrength(state, a.id, STRENGTH_STEP * 3);
  // Row b: type the SAME resulting target value directly.
  setRowStrength(state, b.id, "sm", DEFAULT_STRENGTH + STRENGTH_STEP * 3);
  assert.equal(a.sm, b.sm, "typed and arrow-bumped paths must agree, since both funnel through clampStrength");
});

test("bumpRowStrength: with sepStrengths false (the default), the field argument is IGNORED -- both fields always stay locked together", () => {
  const state = defaultState(); // sepStrengths: false
  const a = addRow(state);
  bumpRowStrength(state, a.id, STRENGTH_STEP, "sc"); // asked for "sc" only
  assert.equal(a.sm, clampStrength(DEFAULT_STRENGTH + STRENGTH_STEP), "sm must move too -- lockstep wins over the field argument");
  assert.equal(a.sc, a.sm);
});

// =========================================================================
// ⚙ dialog setters (§7b, Slice 5)
// =========================================================================

test("setSepStrengths: coerces to a real boolean", () => {
  const state = defaultState();
  setSepStrengths(state, 1);
  assert.equal(state.sepStrengths, true);
  setSepStrengths(state, 0);
  assert.equal(state.sepStrengths, false);
});

test("setCacheMode: accepts any valid mode; an invalid one falls back to the default", () => {
  const state = defaultState();
  for (const mode of CACHE_MODE_ORDER) {
    setCacheMode(state, mode);
    assert.equal(state.cacheMode, mode);
  }
  setCacheMode(state, "bogus");
  assert.equal(state.cacheMode, DEFAULT_CACHE_MODE);
});

test("setSep: accepts any string (including empty -- 'no separator' is a deliberate choice); non-string falls back to the default", () => {
  const state = defaultState();
  setSep(state, " | ");
  assert.equal(state.sep, " | ");
  setSep(state, "");
  assert.equal(state.sep, "");
  setSep(state, 42);
  assert.equal(state.sep, DEFAULT_SEP);
});

test("setDefaultStrength: clamps via clampStrength", () => {
  const state = defaultState();
  setDefaultStrength(state, 99);
  assert.equal(state.defaultStrength, STRENGTH_MAX);
  setDefaultStrength(state, "nope");
  assert.equal(state.defaultStrength, DEFAULT_STRENGTH);
});

test("setStrengthStep: clamps via clampStrengthStep", () => {
  const state = defaultState();
  setStrengthStep(state, 5);
  assert.equal(state.strengthStep, STRENGTH_STEP_MAX);
  setStrengthStep(state, 0);
  assert.equal(state.strengthStep, STRENGTH_STEP);
});

test("CACHE_MODE_LABELS: human labels for exactly the three modes, matching CACHE_MODE_ORDER's own keys", () => {
  assert.deepEqual(CACHE_MODE_ORDER, ["last", "all", "none"]);
  assert.equal(CACHE_MODE_LABELS.last, "Standard");
  assert.equal(CACHE_MODE_LABELS.all, "Fast");
  assert.equal(CACHE_MODE_LABELS.none, "Lowest");
  for (const mode of CACHE_MODE_ORDER) {
    assert.equal(typeof CACHE_MODE_LABELS[mode], "string");
  }
});

test("reorderRows (rows.mjs, reused as-is): moves a LoRA row by id-bearing identity, not by kind", () => {
  const state = defaultState();
  const a = addRow(state);
  const b = addRow(state);
  const c = addRow(state);
  const moved = reorderRows(state.rows, 0, 2);
  assert.deepEqual(moved.map((r) => r.id), [b.id, c.id, a.id]);
  // Pure -- the original array is untouched.
  assert.deepEqual(state.rows.map((r) => r.id), [a.id, b.id, c.id]);
});

test("reorderRows: an out-of-range fromIndex returns a same-order copy, never throws", () => {
  const state = defaultState();
  const a = addRow(state);
  const b = addRow(state);
  assert.deepEqual(reorderRows(state.rows, -1, 0).map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(reorderRows(state.rows, 5, 0).map((r) => r.id), [a.id, b.id]);
});

// =========================================================================
// Master switch tri-state + counter (design doc §1a-ii, decision 13)
// =========================================================================

test("allRowsOn: false for an empty stack -- 'nothing to be on' is not 'all on'", () => {
  assert.equal(allRowsOn([]), false);
});

test("allRowsOn: true only when every row is on", () => {
  const state = defaultState();
  const a = addRow(state);
  const b = addRow(state);
  assert.equal(allRowsOn(state.rows), true);
  b.on = false;
  assert.equal(allRowsOn(state.rows), false);
  a.on = false;
  assert.equal(allRowsOn(state.rows), false); // all-OFF is also not all-on
});

test("onCounts: [onCount, total]", () => {
  const state = defaultState();
  const a = addRow(state);
  const b = addRow(state);
  const c = addRow(state);
  b.on = false;
  assert.deepEqual(onCounts(state.rows), [2, 3]);
  assert.deepEqual(onCounts([]), [0, 0]);
  void a;
  void c;
});

test("toggleMaster: mixed -> turns EVERYTHING on", () => {
  const state = defaultState();
  const a = addRow(state);
  const b = addRow(state);
  b.on = false;
  const result = toggleMaster(state);
  assert.equal(result, true);
  assert.equal(a.on, true);
  assert.equal(b.on, true);
});

test("toggleMaster: all-off -> turns EVERYTHING on", () => {
  const state = defaultState();
  const a = addRow(state);
  const b = addRow(state);
  a.on = false;
  b.on = false;
  const result = toggleMaster(state);
  assert.equal(result, true);
  assert.equal(a.on, true);
  assert.equal(b.on, true);
});

test("toggleMaster: all-on -> turns EVERYTHING off (only case that goes the other way)", () => {
  const state = defaultState();
  const a = addRow(state);
  const b = addRow(state);
  const result = toggleMaster(state);
  assert.equal(result, false);
  assert.equal(a.on, false);
  assert.equal(b.on, false);
});

test("toggleMaster: an empty stack is a harmless no-op", () => {
  const state = defaultState();
  const result = toggleMaster(state);
  assert.equal(result, false);
  assert.deepEqual(state.rows, []);
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
