/**
 * test_rows.mjs — regression tests for `rows.mjs`'s pure logic: the row
 * catalog/slot bookkeeping, the ratio/tier maths, seed clamping, numeric
 * range/clamp, state normalization, the auto-kind resolver, output-type
 * narrowing, and the injectable node-def reader. No DOM, no `app`/`window` —
 * plain `node js/controls/test_rows.mjs`.
 */

import assert from "node:assert/strict";

import {
  MAX_ROWS,
  MAX_ROW_NAME_LEN,
  CONTROL_CATALOG,
  LOADER_CATALOG,
  KIND_META,
  RATIOS,
  TIERS,
  snap16,
  dimsFor,
  clampSeedString,
  randomSeedString,
  applyAfterGenerate,
  decimalsOf,
  rangeOf,
  clampNumeric,
  usefulRange,
  mkRow,
  assignSlot,
  sanitizeRowName,
  commitRename,
  defaultState,
  normalizeState,
  addRow,
  duplicateRow,
  removeRow,
  reorderRows,
  resolveComboOutputType,
  outputTypeForRow,
  resolveAutoKind,
  applyResolvedKind,
  formatLatentValue,
  formatNumericValue,
  numericPercent,
  getComboOptions,
  ZW,
  SLOT_LABEL_MODE,
  stripZeroWidthEdges,
  isBlankSlotLabel,
  defaultSlotLabel,
  ROW_PRESETS,
  isPresetId,
  menuMetaFor,
  mkCatalogRow,
  CLIP_TYPES,
  UNET_NAME_CANDIDATES,
  preferredNameDefault,
} from "./rows.mjs";

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
// Catalog constants
// =========================================================================

test("MAX_ROWS: control=16, loader=8", () => {
  assert.equal(MAX_ROWS.control, 16);
  assert.equal(MAX_ROWS.loader, 8);
});

test("CONTROL_CATALOG / LOADER_CATALOG match the design doc's row catalog", () => {
  assert.deepEqual(CONTROL_CATALOG, ["sampler", "scheduler", "seed", "int", "float", "latent"]);
  assert.deepEqual(LOADER_CATALOG, ["unet", "vae", "clip"]);
});

test("KIND_META has an entry for every catalog kind + auto, with hasGear matching the design's ⚙ column", () => {
  for (const kind of [...CONTROL_CATALOG, ...LOADER_CATALOG, "auto"]) {
    assert.ok(KIND_META[kind], `missing KIND_META for ${kind}`);
  }
  // No ⚙ on int/float/sampler/scheduler/vae -- design doc §3: "range/step/
  // value are adopted from the first wire" (int/float) or "no ⚙" (vae).
  assert.equal(KIND_META.int.hasGear, false);
  assert.equal(KIND_META.float.hasGear, false);
  assert.equal(KIND_META.sampler.hasGear, false);
  assert.equal(KIND_META.scheduler.hasGear, false);
  assert.equal(KIND_META.vae.hasGear, false);
  assert.equal(KIND_META.seed.hasGear, true);
  assert.equal(KIND_META.latent.hasGear, true);
  assert.equal(KIND_META.unet.hasGear, true);
  assert.equal(KIND_META.clip.hasGear, true);
});

// =========================================================================
// Ratio / tier maths (design doc §3a)
// =========================================================================

test("dimsFor: the canonical pairs at the 1024 tier are exact", () => {
  assert.deepEqual(dimsFor("1:1", 1024), [1024, 1024]);
  assert.deepEqual(dimsFor("16:9", 1024), [1344, 768]);
  assert.deepEqual(dimsFor("9:16", 1024), [768, 1344]);
  assert.deepEqual(dimsFor("2:1", 1024), [1408, 704]);
  assert.deepEqual(dimsFor("3:2", 1024), [1216, 832]);
  assert.deepEqual(dimsFor("2:3", 1024), [832, 1216]);
  assert.deepEqual(dimsFor("4:3", 1024), [1152, 896]);
  assert.deepEqual(dimsFor("3:4", 1024), [896, 1152]);
  assert.deepEqual(dimsFor("4:5", 1024), [912, 1152]);
});

test("dimsFor: every other tier scales the 1024 pair by tier/1024 and snaps to 16", () => {
  for (const tier of TIERS) {
    const [w, h] = dimsFor("2:3", tier);
    assert.equal(w % 16, 0, `w=${w} not 16-aligned at tier ${tier}`);
    assert.equal(h % 16, 0, `h=${h} not 16-aligned at tier ${tier}`);
    const expectedW = Math.max(64, Math.round((832 * tier) / 1024 / 16) * 16);
    const expectedH = Math.max(64, Math.round((1216 * tier) / 1024 / 16) * 16);
    assert.equal(w, expectedW, `tier ${tier}`);
    assert.equal(h, expectedH, `tier ${tier}`);
  }
});

test("dimsFor: falls back to 1:1 for an unknown ratio, and to the 1024 tier for a bad tier", () => {
  assert.deepEqual(dimsFor("9:9", 1024), dimsFor("1:1", 1024));
  assert.deepEqual(dimsFor("1:1", NaN), dimsFor("1:1", 1024));
  assert.deepEqual(dimsFor("1:1", undefined), dimsFor("1:1", 1024));
});

test("snap16 floors at 64 and rounds to the nearest 16", () => {
  assert.equal(snap16(10), 64);
  assert.equal(snap16(100), 96);
  assert.equal(snap16(110), 112);
});

test("changing ratio preserves the tier (dimsFor takes the tier as an independent argument)", () => {
  const tier = 1328;
  const [w1] = dimsFor("2:3", tier);
  const [w2] = dimsFor("16:9", tier);
  assert.notEqual(w1, w2);
  // Both were computed at the SAME tier -- verifying the caller pattern
  // (rows.mjs never infers tier from ratio) rather than re-deriving it.
  assert.deepEqual(dimsFor("2:3", tier), [snap16((832 * tier) / 1024), snap16((1216 * tier) / 1024)]);
});

test("RATIOS / TIERS expose exactly the design doc's tables", () => {
  assert.equal(RATIOS.length, 9);
  assert.deepEqual(TIERS, [512, 768, 1024, 1280, 1328, 1408, 1536, 2048]);
});

// =========================================================================
// Seed -- always a string, clamped to [0, 2^64-1]
// =========================================================================

test("clampSeedString clamps a huge (400-digit) integer to 2^64-1", () => {
  const huge = "9".repeat(400);
  assert.equal(clampSeedString(huge), (2n ** 64n - 1n).toString());
});

test("clampSeedString handles Infinity/NaN/empty/negative without throwing", () => {
  assert.equal(clampSeedString("Infinity"), "0");
  assert.equal(clampSeedString("NaN"), "0");
  assert.equal(clampSeedString(""), "0");
  assert.equal(clampSeedString(null), "0");
  assert.equal(clampSeedString(undefined), "0");
  // "-5" has no LEADING sign in the digit-extraction regex, so it reads
  // as the digits "5" (a real minus never reaches BigInt() at all) --
  // still never throws, which is the actual contract here.
  assert.equal(clampSeedString(-5), "5");
});

test("clampSeedString passes a valid in-range seed through unchanged", () => {
  assert.equal(clampSeedString("1000000000000"), "1000000000000");
  assert.equal(clampSeedString((2n ** 64n - 1n).toString()), (2n ** 64n - 1n).toString());
});

test("randomSeedString returns a numeric string within [0, 2^64-1]", () => {
  for (let i = 0; i < 20; i += 1) {
    const s = randomSeedString();
    assert.match(s, /^\d+$/);
    assert.ok(BigInt(s) >= 0n && BigInt(s) <= 2n ** 64n - 1n);
  }
});

// =========================================================================
// applyAfterGenerate -- advancing a seed row after a run (stock-ComfyUI
// semantics: the value at queue time is the one that was used)
// =========================================================================

const MAX_SEED_STR = (2n ** 64n - 1n).toString();

test("applyAfterGenerate: fixed leaves value untouched but still records lastUsed", () => {
  const row = mkRow("seed", { value: "42", opts: { after: "fixed", lastMode: "randomize" } });
  const changed = applyAfterGenerate(row);
  assert.equal(row.value, "42");
  assert.equal(row.opts.lastUsed, "42");
  // `lastUsed` moved from absent -> "42" on this call -- that alone must be
  // reported as "changed" (the new contract: value OR lastUsed moved), or
  // it never reaches persistState and is lost on reload. See the dedicated
  // regression test below for the exact run-1-true/run-2-false shape.
  assert.equal(changed, true);
});

test("applyAfterGenerate: fixed returns true the FIRST time (lastUsed newly recorded) and false the SECOND time (lastUsed unchanged) -- the exact bug that lost the ↺ seed across a reload", () => {
  const row = mkRow("seed", { value: "42", opts: { after: "fixed", lastMode: "randomize" } });
  const firstChanged = applyAfterGenerate(row);
  assert.equal(firstChanged, true, "run 1: lastUsed moved from absent to '42'");
  assert.equal(row.opts.lastUsed, "42");
  assert.equal(row.value, "42");

  const secondChanged = applyAfterGenerate(row);
  assert.equal(secondChanged, false, "run 2: lastUsed already equals row.value -- nothing moved");
  assert.equal(row.opts.lastUsed, "42");
  assert.equal(row.value, "42");
});

test("applyAfterGenerate: randomize records lastUsed as the PRE-advance value, then rolls a new one", () => {
  const row = mkRow("seed", { value: "42", opts: { after: "randomize", lastMode: "randomize" } });
  const changed = applyAfterGenerate(row);
  assert.equal(row.opts.lastUsed, "42");
  assert.notEqual(row.value, "42");
  assert.match(row.value, /^\d+$/);
  assert.equal(changed, true);
});

test("applyAfterGenerate: increment advances by 1 and records lastUsed", () => {
  const row = mkRow("seed", { value: "100", opts: { after: "increment", lastMode: "increment" } });
  const changed = applyAfterGenerate(row);
  assert.equal(row.opts.lastUsed, "100");
  assert.equal(row.value, "101");
  assert.equal(changed, true);
});

test("applyAfterGenerate: decrement advances by -1 and records lastUsed", () => {
  const row = mkRow("seed", { value: "100", opts: { after: "decrement", lastMode: "decrement" } });
  const changed = applyAfterGenerate(row);
  assert.equal(row.opts.lastUsed, "100");
  assert.equal(row.value, "99");
  assert.equal(changed, true);
});

test("applyAfterGenerate: increment CLAMPS at MAX_SEED rather than wrapping (value itself doesn't move, but lastUsed newly recording still counts as changed)", () => {
  const row = mkRow("seed", { value: MAX_SEED_STR, opts: { after: "increment", lastMode: "increment" } });
  const changed = applyAfterGenerate(row);
  assert.equal(row.opts.lastUsed, MAX_SEED_STR);
  assert.equal(row.value, MAX_SEED_STR); // stayed pinned, never wrapped to 0
  assert.equal(changed, true); // lastUsed moved from absent -> MAX_SEED_STR
  // A SECOND call, still pinned at the ceiling: lastUsed is now already
  // MAX_SEED_STR, so nothing moved this time -- exercises the "value never
  // moves AND lastUsed stops moving too" steady state.
  const changedAgain = applyAfterGenerate(row);
  assert.equal(row.value, MAX_SEED_STR);
  assert.equal(changedAgain, false);
});

test("applyAfterGenerate: decrement CLAMPS at 0 rather than going negative/wrapping (value itself doesn't move, but lastUsed newly recording still counts as changed)", () => {
  const row = mkRow("seed", { value: "0", opts: { after: "decrement", lastMode: "decrement" } });
  const changed = applyAfterGenerate(row);
  assert.equal(row.opts.lastUsed, "0");
  assert.equal(row.value, "0"); // stayed pinned, never wrapped to MAX_SEED
  assert.equal(changed, true); // lastUsed moved from absent -> "0"
  const changedAgain = applyAfterGenerate(row);
  assert.equal(row.value, "0");
  assert.equal(changedAgain, false);
});

test("applyAfterGenerate: an unknown/missing after mode falls back to randomize (matches normalizeRow's own fallback)", () => {
  const row = mkRow("seed", { value: "42", opts: { after: "bogus", lastMode: "bogus" } });
  const changed = applyAfterGenerate(row);
  assert.equal(row.opts.lastUsed, "42");
  assert.notEqual(row.value, "42");
  assert.equal(changed, true);

  const noAfter = mkRow("seed", { value: "7", opts: {} });
  applyAfterGenerate(noAfter);
  assert.equal(noAfter.opts.lastUsed, "7");
  assert.notEqual(noAfter.value, "7");
});

test("applyAfterGenerate mutates the SAME row object in place (identity preserved, no DOM/app/api access)", () => {
  const row = mkRow("seed", { value: "5", opts: { after: "fixed", lastMode: "fixed" } });
  const same = row;
  applyAfterGenerate(row);
  assert.equal(row, same);
});

// =========================================================================
// Numeric (int/float) maths
// =========================================================================

test("decimalsOf reads decimal places from step, floors at 0, caps at 6", () => {
  assert.equal(decimalsOf(1), 0);
  assert.equal(decimalsOf(0.01), 2);
  assert.equal(decimalsOf(0.1), 1);
  assert.equal(decimalsOf(0), 2); // no usable step -> the documented default
  assert.equal(decimalsOf("not a number"), 2);
});

test("rangeOf always returns low-to-high even if min/max are swapped", () => {
  assert.deepEqual(rangeOf({ min: 100, max: 0 }), [0, 100]);
  assert.deepEqual(rangeOf({ min: 0, max: 100 }), [0, 100]);
  assert.deepEqual(rangeOf({}), [0, 100]);
});

test("clampNumeric snaps to the step grid, clamps to range, rounds int to whole numbers", () => {
  assert.equal(clampNumeric("int", 5.7, { min: 0, max: 10, step: 1 }), 6);
  assert.equal(clampNumeric("int", 999, { min: 0, max: 10, step: 1 }), 10);
  assert.equal(clampNumeric("int", -5, { min: 0, max: 10, step: 1 }), 0);
  assert.equal(clampNumeric("float", 0.1234, { min: 0, max: 1, step: 0.01 }), 0.12);
});

test("usefulRange keeps the full range when it's already draggable (<=400 steps)", () => {
  assert.deepEqual(usefulRange(0, 100, 1, 50), [0, 100]);
});

test("usefulRange caps a huge range at ~4x the current value, never above the real max", () => {
  const [lo, hi] = usefulRange(1, 10000, 1, 20);
  assert.equal(lo, 1);
  assert.ok(hi <= 10000);
  assert.equal(hi, 80); // 20 * 4
});

// =========================================================================
// Row factory + slot assignment (docs/control-panel-design.md §4)
// =========================================================================

test("mkRow builds sane per-kind defaults", () => {
  assert.equal(mkRow("seed").value, "0");
  assert.deepEqual(mkRow("seed").opts, { after: "randomize", lastMode: "randomize" });
  assert.equal(mkRow("int").opts.step, 1);
  assert.equal(mkRow("float").opts.step, 0.01);
  assert.equal(mkRow("latent").opts.mode, "predefined");
  assert.equal(mkRow("unet").opts.weight_dtype, "default");
  assert.equal(mkRow("clip").opts.device, "default");
});

test('mkRow("clip"): a fresh row defaults to opts.type "qwen_image", NOT CLIP_TYPES[0] ("stable_diffusion") -- Bug 1', () => {
  const row = mkRow("clip");
  assert.equal(row.opts.type, "qwen_image");
  assert.notEqual(row.opts.type, CLIP_TYPES[0]);
});

test("normalizeState: a stored clip type that IS a valid CLIP_TYPES entry (including the old wrong default, stable_diffusion) survives untouched -- no silent migration", () => {
  const state = normalizeState(
    { rows: [{ kind: "clip", slot: 1, value: "clip_l.safetensors", opts: { type: "stable_diffusion", device: "default" } }] },
    "loader"
  );
  assert.equal(state.rows[0].opts.type, "stable_diffusion");
});

test("normalizeState: a garbage/missing clip type falls back to qwen_image, not stable_diffusion", () => {
  const garbage = normalizeState(
    { rows: [{ kind: "clip", slot: 1, value: "clip_l.safetensors", opts: { type: "not-a-real-type" } }] },
    "loader"
  );
  assert.equal(garbage.rows[0].opts.type, "qwen_image");
  const missing = normalizeState(
    { rows: [{ kind: "clip", slot: 1, value: "clip_l.safetensors", opts: {} }] },
    "loader"
  );
  assert.equal(missing.rows[0].opts.type, "qwen_image");
});

// =========================================================================
// preferredNameDefault -- the `unet` row's anima-heuristic default (Bug 2),
// mirroring src/anima/resources.py's `preferred_name_default` EXACTLY. See
// tests/test_anima_resources.py for the Python twin of this exact matrix.
// =========================================================================

test("preferredNameDefault: a candidate present wins even if not first in the folder list", () => {
  const names = ["some-other-model.safetensors", "anima-base-v1.0.safetensors", "yet-another.safetensors"];
  assert.equal(preferredNameDefault(names, UNET_NAME_CANDIDATES), "anima-base-v1.0.safetensors");
});

test("preferredNameDefault: no candidate present falls back to names[0]", () => {
  const names = ["totally-unrelated-a.safetensors", "totally-unrelated-b.safetensors"];
  assert.equal(preferredNameDefault(names, UNET_NAME_CANDIDATES), "totally-unrelated-a.safetensors");
});

test("preferredNameDefault: empty names list falls back to candidates[0], empty candidates falls back to ''", () => {
  assert.equal(preferredNameDefault([], UNET_NAME_CANDIDATES), UNET_NAME_CANDIDATES[0]);
  assert.equal(preferredNameDefault([], []), "");
});

test("preferredNameDefault: basename-insensitive candidate match (subfolder separator/case)", () => {
  const names = ["ANIMA/anima_baseV10.safetensors", "unrelated.safetensors"];
  assert.equal(preferredNameDefault(names, UNET_NAME_CANDIDATES), "ANIMA/anima_baseV10.safetensors");
});

test("preferredNameDefault: heuristic matches a real-world Anima filename that matches no fixed candidate", () => {
  const names = ["aaa-totally-unrelated.safetensors", "nyaIrisAnima_base1V20.safetensors"];
  assert.equal(preferredNameDefault(names, UNET_NAME_CANDIDATES), "nyaIrisAnima_base1V20.safetensors");
});

test("preferredNameDefault: heuristic beats names[0] even when the Anima file sorts last", () => {
  const names = ["zzz-totally-unrelated.safetensors", "nyaIrisAnima_base1V20.safetensors"];
  assert.equal(preferredNameDefault(names, UNET_NAME_CANDIDATES), "nyaIrisAnima_base1V20.safetensors");
});

test("preferredNameDefault: an exact candidate still beats the heuristic when both are installed", () => {
  const names = ["nyaIrisAnima_base1V20.safetensors", "anima-base-v1.0.safetensors"];
  assert.equal(preferredNameDefault(names, UNET_NAME_CANDIDATES), "anima-base-v1.0.safetensors");
});

test("preferredNameDefault: Animagine XL false positive is rejected, falling through to names[0]", () => {
  const names = ["aaa-totally-unrelated.safetensors", "animagineXL31.safetensors"];
  const result = preferredNameDefault(names, UNET_NAME_CANDIDATES);
  assert.equal(result, "aaa-totally-unrelated.safetensors");
  assert.notEqual(result, "animagineXL31.safetensors");
});

test("preferredNameDefault: heuristic is case-insensitive", () => {
  const names = ["zzz-totally-unrelated.safetensors", "ANIMA.safetensors"];
  assert.equal(preferredNameDefault(names, UNET_NAME_CANDIDATES), "ANIMA.safetensors");
});

test("mkRow overrides merge into opts rather than replacing it wholesale", () => {
  const row = mkRow("int", { opts: { min: 5 } });
  assert.equal(row.opts.min, 5);
  assert.equal(row.opts.max, 100); // untouched default preserved
});

test("mkRow defaults renamed to false", () => {
  assert.equal(mkRow("int").renamed, false);
  assert.equal(mkRow("auto").renamed, false);
});

// =========================================================================
// Row presets -- steps/cfg/denoise (pre-configured int/float rows, NOT new
// kinds -- see rows.mjs's ROW_PRESETS doc comment / nodes/controls/
// _rows_helpers.py's value_for_row, which dispatches on `kind` alone)
// =========================================================================

test("ROW_PRESETS: steps/cfg/denoise are presets of int/float, with the exact ranges the design calls for", () => {
  assert.equal(ROW_PRESETS.steps.kind, "int");
  assert.deepEqual(ROW_PRESETS.steps.opts, { min: 1, max: 120, step: 1 });
  assert.equal(ROW_PRESETS.steps.value, 30);

  assert.equal(ROW_PRESETS.cfg.kind, "float");
  assert.deepEqual(ROW_PRESETS.cfg.opts, { min: 0, max: 20, step: 0.1 });
  assert.equal(ROW_PRESETS.cfg.value, 5.0);

  assert.equal(ROW_PRESETS.denoise.kind, "float");
  assert.deepEqual(ROW_PRESETS.denoise.opts, { min: 0, max: 1, step: 0.01 });
  assert.equal(ROW_PRESETS.denoise.value, 1.0);
});

test("isPresetId distinguishes preset ids from real row kinds", () => {
  assert.ok(isPresetId("steps"));
  assert.ok(isPresetId("cfg"));
  assert.ok(isPresetId("denoise"));
  assert.equal(isPresetId("int"), false);
  assert.equal(isPresetId("sampler"), false);
});

test("menuMetaFor: a preset id reports its OWN menu label but its base kind's outputType", () => {
  assert.deepEqual(menuMetaFor("steps"), { menu: "Steps", outputType: "INT" });
  assert.deepEqual(menuMetaFor("cfg"), { menu: "CFG", outputType: "FLOAT" });
  assert.deepEqual(menuMetaFor("denoise"), { menu: "Denoise", outputType: "FLOAT" });
});

test("menuMetaFor: a real kind falls through to KIND_META unchanged", () => {
  assert.equal(menuMetaFor("int"), KIND_META.int);
  assert.equal(menuMetaFor("sampler"), KIND_META.sampler);
});

for (const [id, preset] of Object.entries(ROW_PRESETS)) {
  test(`mkCatalogRow("${id}") builds a row with the preset's exact kind/name/value/opts, stamped renamed:true`, () => {
    const row = mkCatalogRow(id);
    assert.equal(row.kind, preset.kind);
    assert.equal(row.name, preset.name);
    assert.equal(row.value, preset.value);
    assert.deepEqual(row.opts, preset.opts);
    assert.equal(row.renamed, true, "a preset's name must be protected like a manual rename");
  });
}

test('mkCatalogRow: a bare kind (not a preset id) behaves exactly like mkRow -- unaffected, not renamed', () => {
  const row = mkCatalogRow("int");
  assert.equal(row.kind, "int");
  assert.equal(row.name, "int");
  assert.equal(row.renamed, false);
});

test("addRow accepts a preset id the same way it accepts a bare kind, and assigns it a fresh slot", () => {
  const state = defaultState("control");
  const row = addRow(state, "cfg", "control");
  assert.equal(row.kind, "float");
  assert.equal(row.name, "cfg");
  assert.equal(row.value, 5.0);
  assert.equal(row.slot, 1);
  assert.equal(row.renamed, true);
});

test("applyResolvedKind never overwrites a preset row's protected name on first connection, but still adopts range/step/value", () => {
  const row = mkCatalogRow("denoise");
  const resolved = { kind: "float", name: "some_target_widget", value: 0.75, opts: { min: 0, max: 2, step: 0.05 } };
  applyResolvedKind(row, resolved);
  assert.equal(row.name, "denoise"); // protected
  assert.equal(row.value, 0.75); // still adopted
  assert.equal(row.opts.max, 2); // still adopted
});

// =========================================================================
// Rename (docs/control-panel-design.md §3: int/float have no ⚙, so this is
// the only way to relabel them -- and every other kind's label too)
// =========================================================================

test("sanitizeRowName trims whitespace and passes a short name through unchanged", () => {
  assert.equal(sanitizeRowName("  steps  ", "int"), "steps");
  assert.equal(sanitizeRowName("cfg", "float"), "cfg");
});

test("sanitizeRowName falls back to the row's kind for empty/whitespace-only/null/undefined input", () => {
  assert.equal(sanitizeRowName("", "int"), "int");
  assert.equal(sanitizeRowName("   ", "float"), "float");
  assert.equal(sanitizeRowName(null, "seed"), "seed");
  assert.equal(sanitizeRowName(undefined, "unet"), "unet");
});

test("sanitizeRowName caps a pasted essay at MAX_ROW_NAME_LEN characters", () => {
  const long = "x".repeat(200);
  const result = sanitizeRowName(long, "int");
  assert.equal(result.length, MAX_ROW_NAME_LEN);
  assert.equal(result, "x".repeat(MAX_ROW_NAME_LEN));
});

test("commitRename sets row.name via sanitizeRowName, stamps row.renamed = true, and returns the sanitized name", () => {
  const row = mkRow("int");
  assert.equal(row.renamed, false);
  const result = commitRename(row, "  steps  ");
  assert.equal(result, "steps");
  assert.equal(row.name, "steps");
  assert.equal(row.renamed, true);
});

test("commitRename falls back to the row's kind for an empty/whitespace-only name, but still marks it renamed", () => {
  const row = mkRow("float");
  commitRename(row, "   ");
  assert.equal(row.name, "float");
  assert.equal(row.renamed, true); // a deliberate rename action, even though the result equals the default
});

test("assignSlot hands out the LOWEST unused positive integer", () => {
  const rows = [{ slot: 1 }, { slot: 3 }];
  const fresh = {};
  assignSlot(rows, fresh);
  assert.equal(fresh.slot, 2);
});

test("assignSlot on an empty row list starts at 1", () => {
  const fresh = {};
  assignSlot([], fresh);
  assert.equal(fresh.slot, 1);
});

// =========================================================================
// State: default / normalize / mutate
// =========================================================================

test("defaultState: control panel starts empty, loader panel starts with unet+vae+clip", () => {
  const control = defaultState("control");
  assert.deepEqual(control.rows, []);
  const loader = defaultState("loader");
  assert.deepEqual(loader.rows.map((r) => r.kind), ["unet", "vae", "clip"]);
  assert.deepEqual(loader.rows.map((r) => r.slot), [1, 2, 3]);
});

test("normalizeState drops rows whose kind isn't in this panel's catalog (or auto)", () => {
  const state = normalizeState({ rows: [{ kind: "unet", slot: 1 }, { kind: "seed", slot: 2 }] }, "control");
  assert.deepEqual(state.rows.map((r) => r.kind), ["seed"]);
});

test("normalizeState clamps to MAX_ROWS for the panel", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ kind: "int", slot: i + 1, value: 1, opts: {} }));
  const state = normalizeState({ rows }, "control");
  assert.equal(state.rows.length, 16);
});

test("normalizeState keeps an already-valid unique slot, re-stamps a duplicate/missing one", () => {
  const state = normalizeState(
    {
      rows: [
        { kind: "int", slot: 5, value: 1, opts: {} },
        { kind: "float", slot: 5, value: 1, opts: {} }, // duplicate slot
        { kind: "seed", value: "1" }, // missing slot
      ],
    },
    "control",
  );
  const slots = state.rows.map((r) => r.slot);
  assert.equal(slots[0], 5); // untouched
  assert.equal(new Set(slots).size, 3); // all unique after re-stamping
});

test("normalizeState clamps a garbage seed/int/float/latent row rather than throwing", () => {
  const state = normalizeState(
    {
      rows: [
        { kind: "seed", slot: 1, value: "Infinity", opts: { after: "bogus" } },
        { kind: "int", slot: 2, value: "not a number", opts: { min: 100, max: 0, step: -5 } },
        { kind: "latent", slot: 3, opts: { mode: "bogus", ratio: "bogus", tier: 999, w: -5, h: -5, batch: -1 } },
      ],
    },
    "control",
  );
  const [seedRow, intRow, latentRow] = state.rows;
  assert.equal(seedRow.value, "0");
  assert.equal(seedRow.opts.after, "randomize");
  assert.ok(Number.isFinite(intRow.value));
  assert.equal(latentRow.opts.mode, "predefined");
  assert.equal(latentRow.opts.tier, 1024);
  assert.equal(latentRow.opts.batch, 1);
});

test("normalizeState preserves a seed row's lastUsed (clamped), and omits it entirely when absent", () => {
  const state = normalizeState(
    {
      rows: [
        { kind: "seed", slot: 1, value: "5", opts: { after: "increment", lastMode: "increment", lastUsed: "4" } },
        { kind: "seed", slot: 2, value: "9", opts: { after: "fixed", lastMode: "randomize" } }, // no lastUsed at all
      ],
    },
    "control",
  );
  assert.equal(state.rows[0].opts.lastUsed, "4");
  assert.equal(Object.prototype.hasOwnProperty.call(state.rows[1].opts, "lastUsed"), false);
});

test("normalizeState clamps an out-of-range lastUsed the same way it clamps value", () => {
  const huge = "9".repeat(400);
  const state = normalizeState(
    { rows: [{ kind: "seed", slot: 1, value: "1", opts: { after: "fixed", lastMode: "fixed", lastUsed: huge } }] },
    "control",
  );
  assert.equal(state.rows[0].opts.lastUsed, (2n ** 64n - 1n).toString()); // clampSeedString's own MAX_SEED clamp
});

test("normalizeState tolerates non-object / missing rows entirely", () => {
  assert.deepEqual(normalizeState(null, "control").rows, []);
  assert.deepEqual(normalizeState({}, "control").rows, []);
  assert.deepEqual(normalizeState("garbage", "control").rows, []);
});

test("normalizeState round-trips an explicit renamed:true flag (and the name that came with it), defaulting to false when absent", () => {
  const state = normalizeState(
    {
      rows: [
        { kind: "int", slot: 1, name: "steps", renamed: true, value: 5, opts: {} },
        { kind: "float", slot: 2, name: "cfg", value: 1, opts: {} }, // no renamed key at all
      ],
    },
    "control",
  );
  assert.equal(state.rows[0].name, "steps");
  assert.equal(state.rows[0].renamed, true);
  assert.equal(state.rows[1].name, "cfg");
  assert.equal(state.rows[1].renamed, false);
});

test("normalizeState never trusts a truthy-but-non-boolean renamed value from a hand-edited payload", () => {
  const state = normalizeState({ rows: [{ kind: "int", slot: 1, renamed: "yes", value: 1, opts: {} }] }, "control");
  assert.equal(state.rows[0].renamed, false);
});

test("normalizeState also trims/caps a hand-edited row's name via sanitizeRowName", () => {
  const state = normalizeState({ rows: [{ kind: "int", slot: 1, name: "  padded  ", value: 1, opts: {} }] }, "control");
  assert.equal(state.rows[0].name, "padded");
});

test("addRow appends in display order with a fresh slot, refuses past MAX_ROWS", () => {
  const state = { version: 1, rows: [] };
  for (let i = 0; i < 16; i += 1) {
    assert.ok(addRow(state, "int", "control"));
  }
  assert.equal(state.rows.length, 16);
  assert.equal(addRow(state, "int", "control"), null);
});

test("duplicateRow inserts right after the original with a NEW slot (never inherits wires)", () => {
  const state = { version: 1, rows: [] };
  const original = addRow(state, "seed", "control");
  original.value = "42";
  const copy = duplicateRow(state, original.id, "control");
  assert.equal(state.rows.indexOf(copy), state.rows.indexOf(original) + 1);
  assert.notEqual(copy.slot, original.slot);
  assert.equal(copy.value, "42"); // copies the VALUE, just not the slot
});

test("duplicateRow refuses past MAX_ROWS and for an unknown id", () => {
  const state = { version: 1, rows: [] };
  for (let i = 0; i < 8; i += 1) {
    addRow(state, "unet", "loader");
  }
  assert.equal(duplicateRow(state, state.rows[0].id, "loader"), null);
  const small = { version: 1, rows: [] };
  addRow(small, "unet", "loader");
  assert.equal(duplicateRow(small, 999999, "loader"), null);
});

test("removeRow frees its slot for reuse before any number above the current max", () => {
  const state = { version: 1, rows: [] };
  const a = addRow(state, "int", "control");
  const b = addRow(state, "int", "control");
  const c = addRow(state, "int", "control");
  assert.deepEqual([a.slot, b.slot, c.slot], [1, 2, 3]);
  assert.ok(removeRow(state, b.id));
  const d = addRow(state, "int", "control");
  assert.equal(d.slot, 2); // reused, not 4
});

test("removeRow returns false for an id that doesn't exist", () => {
  const state = { version: 1, rows: [] };
  assert.equal(removeRow(state, 12345), false);
});

test("reorderRows moves an element without mutating the input array", () => {
  const original = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const moved = reorderRows(original, 0, 2);
  assert.deepEqual(moved.map((r) => r.id), [2, 3, 1]);
  assert.deepEqual(original.map((r) => r.id), [1, 2, 3]); // untouched
});

test("reorderRows clamps an out-of-range target index", () => {
  const original = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(reorderRows(original, 0, 999).map((r) => r.id), [2, 3, 1]);
  assert.deepEqual(reorderRows(original, 2, -999).map((r) => r.id), [3, 1, 2]);
});

test("a drag-reorder recomputed from the ORIGINAL snapshot on every step never leapfrogs", () => {
  // Mirrors playground/control-panel.html's pointermove handler: always
  // reorder the SNAPSHOT taken at drag-start, never the previous result.
  const snapshot = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const step1 = reorderRows(snapshot, 0, 1);
  const step2 = reorderRows(snapshot, 0, 2); // recomputed from snapshot, not step1
  assert.deepEqual(step2.map((r) => r.id), ["b", "c", "a", "d"]);
});

// =========================================================================
// Output typing (docs/control-panel-design.md §5)
// =========================================================================

test("resolveComboOutputType defaults to the 'COMBO' strategy", () => {
  assert.equal(resolveComboOutputType(["a", "b"]), "COMBO");
  assert.equal(resolveComboOutputType(null), "COMBO");
});

test("outputTypeForRow: plain types pass through, combo kinds go through resolveComboOutputType, auto is always '*'", () => {
  assert.equal(outputTypeForRow({ kind: "seed" }, {}), "INT");
  assert.equal(outputTypeForRow({ kind: "latent" }, {}), "LATENT");
  assert.equal(outputTypeForRow({ kind: "unet" }, {}), "MODEL");
  assert.equal(outputTypeForRow({ kind: "sampler" }, { sampler: ["euler"] }), "COMBO");
  assert.equal(outputTypeForRow({ kind: "auto" }, {}), "*");
});

// =========================================================================
// Slot label -- cg-use-everywhere ("UE") interop (docs/control-panel-
// design.md's UE-name-disambiguation fix)
// =========================================================================

test("SLOT_LABEL_MODE defaults to \"row-name\"", () => {
  assert.equal(SLOT_LABEL_MODE, "row-name");
});

test("stripZeroWidthEdges strips a leading/trailing zero-width space or BOM, and is a no-op on plain text", () => {
  assert.equal(stripZeroWidthEdges(`${ZW}sampler_name`), "sampler_name");
  assert.equal(stripZeroWidthEdges(`sampler_name${ZW}`), "sampler_name");
  assert.equal(stripZeroWidthEdges(`${ZW}sampler_name${ZW}`), "sampler_name");
  assert.equal(stripZeroWidthEdges("﻿sampler_name"), "sampler_name"); // a leading BOM
  assert.equal(stripZeroWidthEdges("sampler_name"), "sampler_name");
  assert.equal(stripZeroWidthEdges(""), "");
  assert.equal(stripZeroWidthEdges(undefined), "");
  // never strips a zero-width char embedded in the MIDDLE of real text
  assert.equal(stripZeroWidthEdges(`sam${ZW}pler`), `sam${ZW}pler`);
});

test("isBlankSlotLabel: undefined/null/empty/the bare ZW sentinel/pure zero-width junk all count as blank; real text never does", () => {
  assert.ok(isBlankSlotLabel(undefined));
  assert.ok(isBlankSlotLabel(null));
  assert.ok(isBlankSlotLabel(""));
  assert.ok(isBlankSlotLabel(ZW));
  assert.ok(isBlankSlotLabel(`${ZW}${ZW}`)); // pure zero-width junk, no real text
  assert.equal(isBlankSlotLabel("sampler"), false);
  assert.equal(isBlankSlotLabel(`${ZW}sampler_name`), false); // has real text after the ZW
});

test('defaultSlotLabel: "row-name" mode (the default) uses the row\'s own name, trimmed, falling back to kind', () => {
  assert.equal(defaultSlotLabel({ name: "sampler", kind: "sampler" }), "sampler");
  assert.equal(defaultSlotLabel({ name: "  cfg  ", kind: "float" }), "cfg");
  assert.equal(defaultSlotLabel({ name: "", kind: "int" }), "int"); // blank name falls back to kind
  assert.equal(defaultSlotLabel({ name: undefined, kind: "seed" }), "seed");
});

test('defaultSlotLabel: "hidden" mode (test-only override -- see this function\'s doc comment) always returns the bare ZW sentinel, regardless of the row\'s name', () => {
  assert.equal(defaultSlotLabel({ name: "sampler", kind: "sampler" }, "hidden"), ZW);
  assert.equal(defaultSlotLabel({ name: "cfg", kind: "float" }, "hidden"), ZW);
});

// =========================================================================
// Auto rows (docs/control-panel-design.md §6)
// =========================================================================

const CONTROL_ALLOWED = new Set(CONTROL_CATALOG);
const LOADER_ALLOWED = new Set(LOADER_CATALOG);

test("resolveAutoKind: INT named seed/noise_seed resolves to seed and adopts the current value", () => {
  const resolved = resolveAutoKind({ type: "INT", name: "noise_seed", value: 12345 }, { allowedKinds: CONTROL_ALLOWED });
  assert.equal(resolved.kind, "seed");
  assert.equal(resolved.value, "12345");
});

test("resolveAutoKind: a plain INT resolves to int, adopting name/min/max/step/value with usefulRange applied", () => {
  const resolved = resolveAutoKind(
    { type: "INT", name: "steps", min: 1, max: 10000, step2: 1, value: 20 },
    { allowedKinds: CONTROL_ALLOWED },
  );
  assert.equal(resolved.kind, "int");
  assert.equal(resolved.name, "steps");
  assert.equal(resolved.value, 20);
  assert.equal(resolved.opts.max, 80); // usefulRange: 20 * 4
});

test("resolveAutoKind: FLOAT resolves to float", () => {
  const resolved = resolveAutoKind(
    { type: "FLOAT", name: "cfg", min: 0, max: 20, step2: 0.1, value: 7.5 },
    { allowedKinds: CONTROL_ALLOWED },
  );
  assert.equal(resolved.kind, "float");
  assert.equal(resolved.value, 7.5);
});

test("resolveAutoKind: COMBO matches by comparing the OPTION LIST, never by input name", () => {
  const samplers = ["euler", "dpmpp_2m", "ddim"];
  const schedulers = ["normal", "karras"];
  const resolved = resolveAutoKind(
    { type: "COMBO", name: "some_weird_custom_name", value: "euler", comboValues: samplers },
    { allowedKinds: CONTROL_ALLOWED, knownLists: { sampler: samplers, scheduler: schedulers } },
  );
  assert.equal(resolved.kind, "sampler");
  assert.equal(resolved.value, "euler");
});

test("resolveAutoKind: an unrecognized COMBO list stays unresolved (returns null)", () => {
  const resolved = resolveAutoKind(
    { type: "COMBO", name: "whatever", value: "x", comboValues: ["only", "two"] },
    { allowedKinds: CONTROL_ALLOWED, knownLists: { sampler: ["a", "b", "c"], scheduler: ["d", "e"] } },
  );
  assert.equal(resolved, null);
});

test("resolveAutoKind: LATENT resolves to latent with sane default opts", () => {
  const resolved = resolveAutoKind({ type: "LATENT" }, { allowedKinds: CONTROL_ALLOWED });
  assert.equal(resolved.kind, "latent");
  assert.equal(resolved.opts.mode, "predefined");
});

test("resolveAutoKind: MODEL/VAE/CLIP are rejected on the Control Panel's allowed set", () => {
  assert.equal(resolveAutoKind({ type: "MODEL" }, { allowedKinds: CONTROL_ALLOWED }), null);
  assert.equal(resolveAutoKind({ type: "VAE" }, { allowedKinds: CONTROL_ALLOWED }), null);
  assert.equal(resolveAutoKind({ type: "CLIP" }, { allowedKinds: CONTROL_ALLOWED }), null);
});

test("resolveAutoKind: MODEL/VAE/CLIP resolve on the Loader Panel's allowed set", () => {
  assert.equal(resolveAutoKind({ type: "MODEL", value: "x.safetensors" }, { allowedKinds: LOADER_ALLOWED }).kind, "unet");
  assert.equal(resolveAutoKind({ type: "VAE", value: "y.safetensors" }, { allowedKinds: LOADER_ALLOWED }).kind, "vae");
  assert.equal(resolveAutoKind({ type: "CLIP", value: "z.safetensors" }, { allowedKinds: LOADER_ALLOWED }).kind, "clip");
});

test("resolveAutoKind: seed/int/float/sampler/scheduler/latent are rejected on the Loader Panel", () => {
  assert.equal(resolveAutoKind({ type: "INT", name: "seed" }, { allowedKinds: LOADER_ALLOWED }), null);
  assert.equal(resolveAutoKind({ type: "INT", name: "steps" }, { allowedKinds: LOADER_ALLOWED }), null);
  assert.equal(resolveAutoKind({ type: "FLOAT" }, { allowedKinds: LOADER_ALLOWED }), null);
  assert.equal(resolveAutoKind({ type: "LATENT" }, { allowedKinds: LOADER_ALLOWED }), null);
});

test("applyResolvedKind mutates the SAME row object in place (identity preserved)", () => {
  const row = mkRow("auto");
  const resolved = resolveAutoKind({ type: "INT", name: "steps", min: 1, max: 100, value: 30 }, { allowedKinds: CONTROL_ALLOWED });
  const same = row;
  assert.ok(applyResolvedKind(row, resolved));
  assert.equal(row, same);
  assert.equal(row.kind, "int");
});

test("applyResolvedKind is a no-op (returns false) for a null resolution", () => {
  const row = mkRow("auto");
  assert.equal(applyResolvedKind(row, null), false);
  assert.equal(row.kind, "auto");
});

test("applyResolvedKind still adopts the resolved NAME for an un-renamed row (no regression to the existing auto-resolve behaviour)", () => {
  const row = mkRow("auto");
  const resolved = resolveAutoKind(
    { type: "FLOAT", name: "cfg", min: 0, max: 20, step2: 0.1, value: 7.5 },
    { allowedKinds: CONTROL_ALLOWED },
  );
  assert.ok(applyResolvedKind(row, resolved));
  assert.equal(row.name, "cfg");
  assert.equal(row.value, 7.5);
});

test("applyResolvedKind skips adopting a resolved NAME for a row renamed by hand, but still adopts value/opts", () => {
  const row = mkRow("auto");
  commitRename(row, "denoise");
  const resolved = resolveAutoKind(
    { type: "FLOAT", name: "cfg", min: 0, max: 20, step2: 0.1, value: 7.5 },
    { allowedKinds: CONTROL_ALLOWED },
  );
  assert.ok(applyResolvedKind(row, resolved));
  assert.equal(row.kind, "float");
  assert.equal(row.name, "denoise"); // kept -- NOT overwritten by resolved.name ("cfg")
  assert.equal(row.value, 7.5); // still adopted
  assert.equal(row.opts.max, 20); // still adopted
});

// =========================================================================
// Display formatting
// =========================================================================

test("formatLatentValue shows the ratio ONLY in predefined mode", () => {
  const predefined = mkRow("latent", { opts: { mode: "predefined", ratio: "2:3", w: 832, h: 1216, batch: 1 } });
  assert.deepEqual(formatLatentValue(predefined), { main: "832 × 1216", dim: "(2:3)" });
  const custom = mkRow("latent", { opts: { mode: "custom", w: 900, h: 700, batch: 1 } });
  assert.deepEqual(formatLatentValue(custom), { main: "900 × 700", dim: "" });
});

test("formatLatentValue shows batch only when > 1", () => {
  const row = mkRow("latent", { opts: { mode: "predefined", ratio: "1:1", w: 1024, h: 1024, batch: 4 } });
  assert.equal(formatLatentValue(row).dim, "(1:1) ×4");
});

test("formatNumericValue respects the step's decimal places", () => {
  assert.equal(formatNumericValue(mkRow("int", { value: 30, opts: { step: 1 } })), "30");
  assert.equal(formatNumericValue(mkRow("float", { value: 5, opts: { step: 0.1 } })), "5.0");
});

// docs/pixaroma-review-rounds-plan.md Tier 2 item 9: a range crossing zero
// can hold a value that's genuinely negative but rounds to all-zeros at the
// step's own display precision -- must never render with a leading "-".
test('formatNumericValue never shows "-0.00" for a literal negative-zero float value (Number("-0.00") IS a real -0)', () => {
  const row = mkRow("float", { value: -0, opts: { min: -1, max: 1, step: 0.01 } });
  assert.equal(formatNumericValue(row), "0.00");
  assert.notEqual(formatNumericValue(row), "-0.00");
});

test("formatNumericValue never shows a negative sign for tiny negative drift that rounds to zero at the step's decimals", () => {
  const tiny = mkRow("float", { value: -0.00001, opts: { min: -10, max: 10, step: 0.01 } });
  assert.equal(formatNumericValue(tiny), "0.00");
  const tinier = mkRow("float", { value: -1e-10, opts: { min: -1, max: 1, step: 0.01 } });
  assert.equal(formatNumericValue(tinier), "0.00");
});

test("formatNumericValue still shows a real negative value (not near zero) with its sign intact", () => {
  const row = mkRow("float", { value: -5, opts: { min: -10, max: 10, step: 0.1 } });
  assert.equal(formatNumericValue(row), "-5.0");
});

test('formatNumericValue: the zero-guard also holds for an "int" row (0 decimals) crossing zero', () => {
  const row = mkRow("int", { value: -0, opts: { min: -10, max: 10, step: 1 } });
  assert.equal(formatNumericValue(row), "0");
  assert.notEqual(formatNumericValue(row), "-0");
});

test("numericPercent maps value across [min,max] to 0..100", () => {
  const row = mkRow("int", { value: 25, opts: { min: 0, max: 100, step: 1 } });
  assert.equal(numericPercent(row), 25);
});

// =========================================================================
// getComboOptions (injectable registry)
// =========================================================================

test("getComboOptions reads a combo spec's option list from a fake registry", () => {
  const registry = {
    KSampler: {
      nodeData: {
        input: { required: { sampler_name: [["euler", "dpmpp_2m"]], scheduler: [["normal", "karras"]] } },
      },
    },
  };
  assert.deepEqual(getComboOptions(registry, "KSampler", "sampler_name"), ["euler", "dpmpp_2m"]);
  assert.deepEqual(getComboOptions(registry, "KSampler", "scheduler"), ["normal", "karras"]);
});

test("getComboOptions returns null for a missing class/field/malformed registry -- never throws", () => {
  assert.equal(getComboOptions({}, "KSampler", "sampler_name"), null);
  assert.equal(getComboOptions(null, "KSampler", "sampler_name"), null);
  assert.equal(getComboOptions({ KSampler: {} }, "KSampler", "sampler_name"), null);
  assert.equal(
    getComboOptions({ UNETLoader: { nodeData: { input: { required: { unet_name: ["COMBO"] } } } } }, "UNETLoader", "unet_name"),
    null, // spec[0] isn't an array (newer-build "COMBO" string form) -- no list available
  );
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
