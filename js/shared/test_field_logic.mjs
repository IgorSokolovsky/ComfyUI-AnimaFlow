/**
 * test_field_logic.mjs — regression tests for `field_logic.mjs` (layer 1 of
 * the field/row/DOM stack, docs/control-panel-design.md §6a /
 * `.claude/skills/animaflow-shared-fields/SKILL.md`) PLUS the layering guard
 * that keeps the whole point of moving this code out of `js/controls/rows.mjs`
 * from silently reverting. Plain `node`, no DOM/`app`/`window` — same
 * convention as every other `test_*.mjs` in this pack.
 *
 * These are NEW tests, not a relocation of `js/controls/test_rows.mjs`'s own
 * coverage of the same functions — that file is left completely untouched
 * (still imports every moved name from `./rows.mjs`, which now re-exports it
 * from here verbatim) so its own count stays exactly 115/115. This file adds
 * direct coverage of the promoted module plus the one thing nothing
 * previously checked: the import direction itself.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  clampSeedString,
  randomSeedString,
  AFTER_MODES,
  applyAfterGenerate,
  decimalsOf,
  rangeOf,
  clampNumeric,
  numericPercent,
  formatNumericValue,
  getComboOptions,
} from "./field_logic.mjs";

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
// clampSeedString / randomSeedString
// ---------------------------------------------------------------------------

test("clampSeedString: digit-only input passes through as a string", () => {
  assert.equal(clampSeedString("42"), "42");
  assert.equal(clampSeedString(42), "42");
});

test("clampSeedString: negative/garbage/empty all clamp to a legal string, never throw", () => {
  assert.equal(clampSeedString(""), "0");
  assert.equal(clampSeedString("nonsense"), "0");
  assert.equal(clampSeedString(-5), "5"); // first digit run matched, no sign handling
  assert.equal(clampSeedString(null), "0");
  assert.equal(clampSeedString(undefined), "0");
});

test("clampSeedString: clamps at 2**64-1, never wraps or overflows to a float", () => {
  const max = (2n ** 64n - 1n).toString();
  assert.equal(clampSeedString(max), max);
  assert.equal(clampSeedString("99999999999999999999999999999999"), max);
});

test("randomSeedString: always an in-range, digit-only string, and not constant", () => {
  const max = 2n ** 64n - 1n;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const s = randomSeedString();
    assert.match(s, /^\d+$/);
    assert.ok(BigInt(s) >= 0n && BigInt(s) <= max);
    seen.add(s);
  }
  assert.ok(seen.size > 1, "20 rolls should not all collide");
});

// ---------------------------------------------------------------------------
// applyAfterGenerate
// ---------------------------------------------------------------------------

test("applyAfterGenerate: fixed leaves value untouched but records lastUsed (and reports the change once)", () => {
  const row = { value: "10", opts: { after: "fixed" } };
  assert.equal(applyAfterGenerate(row), true); // lastUsed moved from absent -> "10"
  assert.equal(row.value, "10");
  assert.equal(row.opts.lastUsed, "10");
  assert.equal(applyAfterGenerate(row), false); // lastUsed already equals value: no change
});

test("applyAfterGenerate: increment/decrement move by exactly 1, clamped at the range edges", () => {
  const inc = { value: "10", opts: { after: "increment" } };
  applyAfterGenerate(inc);
  assert.equal(inc.value, "11");

  const dec = { value: "0", opts: { after: "decrement" } };
  applyAfterGenerate(dec);
  assert.equal(dec.value, "0"); // clamped at the floor, never wraps

  const atMax = { value: (2n ** 64n - 1n).toString(), opts: { after: "increment" } };
  applyAfterGenerate(atMax);
  assert.equal(atMax.value, (2n ** 64n - 1n).toString()); // clamped at the ceiling
});

test("applyAfterGenerate: randomize picks a fresh value; unknown/missing mode falls back to randomize", () => {
  const row = { value: "10", opts: {} };
  applyAfterGenerate(row);
  assert.notEqual(row.value, "10");
  assert.match(row.value, /^\d+$/);

  const garbage = { value: "10", opts: { after: "not-a-real-mode" } };
  applyAfterGenerate(garbage);
  assert.notEqual(garbage.value, "10");
});

test("AFTER_MODES is exactly the four documented modes, in order", () => {
  assert.deepEqual(AFTER_MODES, ["fixed", "increment", "decrement", "randomize"]);
});

// ---------------------------------------------------------------------------
// Numeric maths: decimalsOf / rangeOf / clampNumeric / numericPercent /
// formatNumericValue
// ---------------------------------------------------------------------------

test("decimalsOf: derives decimal places from step, floored at 0 and capped at 6", () => {
  assert.equal(decimalsOf(1), 0);
  assert.equal(decimalsOf(0.01), 2);
  assert.equal(decimalsOf(0.0001234567), 6); // capped at 6, not the full 10 implied by the string
  assert.equal(decimalsOf(0), 2); // falsy step -> the documented default
  assert.equal(decimalsOf(undefined), 2);
});

test("rangeOf: returns [min, max] low-to-high even when the caller's min/max are swapped", () => {
  assert.deepEqual(rangeOf({ min: 0, max: 100 }), [0, 100]);
  assert.deepEqual(rangeOf({ min: 100, max: 0 }), [0, 100]); // swapped back
  assert.deepEqual(rangeOf({}), [0, 100]); // missing -> documented fallback
});

test("clampNumeric: snaps to the step grid and clamps to range, for both int and float", () => {
  assert.equal(clampNumeric("int", 7.4, { min: 0, max: 10, step: 1 }), 7);
  assert.equal(clampNumeric("int", 999, { min: 0, max: 10, step: 1 }), 10);
  assert.equal(clampNumeric("float", 0.317, { min: 0, max: 1, step: 0.01 }), 0.32);
  assert.equal(clampNumeric("float", -5, { min: 0, max: 1, step: 0.01 }), 0);
});

test("numericPercent: 0/50/100 at the range edges/midpoint; falls back to min for a non-finite value", () => {
  assert.equal(numericPercent({ value: 0, opts: { min: 0, max: 100 } }), 0);
  assert.equal(numericPercent({ value: 100, opts: { min: 0, max: 100 } }), 100);
  assert.equal(numericPercent({ value: 50, opts: { min: 0, max: 100 } }), 50);
  assert.equal(numericPercent({ value: NaN, opts: { min: 10, max: 20 } }), 0);
});

test("formatNumericValue: decimals implied by step, and never emits a signed zero", () => {
  assert.equal(formatNumericValue({ value: 3, opts: { step: 1 } }), "3");
  assert.equal(formatNumericValue({ value: 0.3, opts: { step: 0.01 } }), "0.30");
  assert.equal(formatNumericValue({ value: -0.00001, opts: { step: 0.01 } }), "0.00"); // not "-0.00"
  assert.equal(formatNumericValue({ value: NaN, opts: { step: 1 } }), "0");
});

// ---------------------------------------------------------------------------
// getComboOptions
// ---------------------------------------------------------------------------

test("getComboOptions: reads the V1 (array) combo schema", () => {
  const registry = { KSampler: { nodeData: { input: { required: { sampler_name: [["euler", "dpmpp_2m"]] } } } } };
  assert.deepEqual(getComboOptions(registry, "KSampler", "sampler_name"), ["euler", "dpmpp_2m"]);
});

test("getComboOptions: reads the V3 ([\"COMBO\", {options}]) combo schema", () => {
  const registry = {
    UpscaleModelLoader: { nodeData: { input: { required: { model_name: ["COMBO", { options: ["4x-AnimeSharp.pth"] }] } } } },
  };
  assert.deepEqual(getComboOptions(registry, "UpscaleModelLoader", "model_name"), ["4x-AnimeSharp.pth"]);
});

test("getComboOptions: missing class/field, or a malformed entry, returns null rather than throwing", () => {
  assert.equal(getComboOptions({}, "Nope", "field"), null);
  assert.equal(getComboOptions(null, "Nope", "field"), null);
  assert.equal(getComboOptions({ KSampler: {} }, "KSampler", "sampler_name"), null);
  const registry = { X: { nodeData: { input: { required: { f: ["COMBO", { notOptions: [] }] } } } } };
  assert.equal(getComboOptions(registry, "X", "f"), null);
});

// ---------------------------------------------------------------------------
// Layering guard — docs/control-panel-design.md §6a / the shared-fields
// skill: "js/shared/ must never import from a track". This is the one thing
// nothing checked for the weeks `fields.mjs` imported `../controls/rows.mjs`
// upward; from here on it's enforced, not just remembered.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const SHARED_DIR = path.dirname(__filename);

// `js/shared/graph_loading.mjs` and `submit_guard.mjs` import an ABSOLUTE
// `/scripts/app.js` path -- that's ComfyUI itself, not a track, and is
// explicitly allowed. Only a RELATIVE import that climbs out of `js/shared/`
// into `../anima/` or `../controls/` is the violation this test exists to
// catch; a bare `/scripts/...` string never matches the relative-import
// regex below at all, so it needs no special-casing.
const FORBIDDEN_RE = /from\s+["'](\.\.\/(?:anima|controls)\/[^"']*)["']/g;

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (/\.(mjs|js)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

test("no file under js/shared/ imports from js/anima/ or js/controls/ -- shared code must not depend on a track", () => {
  const files = listFilesRecursive(SHARED_DIR);
  assert.ok(files.length > 5, "sanity check: the scan actually found files");

  const violations = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    let match;
    FORBIDDEN_RE.lastIndex = 0;
    while ((match = FORBIDDEN_RE.exec(source))) {
      violations.push(`${path.relative(SHARED_DIR, file)} imports "${match[1]}"`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "js/shared/ must never import from a track (js/anima/ or js/controls/) -- " +
      "the layering is field logic (js/shared/field_logic.mjs, pure) -> fields " +
      "(js/shared/fields.mjs, DOM+layer 1) -> socket rows (js/controls/rows.mjs, " +
      "litegraph+layers 1-2), and dependencies only ever point UP that list, never " +
      "down into a track. If a shared module needs something that lives in a track, " +
      "that thing is mis-filed -- promote it into js/shared/, don't reach down for " +
      "it (docs/control-panel-design.md §6a). Violations found:\n  " +
      violations.join("\n  "),
  );
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exit(1);
}
