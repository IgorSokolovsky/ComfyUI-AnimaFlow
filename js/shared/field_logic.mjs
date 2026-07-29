/**
 * field_logic.mjs — layer 1 of the pack's field/row/DOM stack
 * (docs/control-panel-design.md §6a, `.claude/skills/animaflow-shared-fields/
 * SKILL.md`): pure field-level maths and normalizers used by BOTH tracks.
 *
 * NO DOM, no `app`/`window`/`LiteGraph` reference anywhere in this file, and
 * — the thing that makes this layer 1 rather than a Controls concern — NO
 * dependency on Controls' own row/state shape either: nothing here reads
 * `row.id`/`row.kind`/`row.slot`/`row.renamed`/`row.slotLabelOwned`, only the
 * generic `{value, opts}` (or bare `opts`) pair that `js/shared/fields.mjs`'s
 * own field builders already construct ad hoc for exactly this purpose (see
 * `buildNumericField`'s `const row = { value: getValue(), opts };`).
 *
 * Moved out of `js/controls/rows.mjs` (2026-07-29, layering fix —
 * `docs/control-panel-design.md` §6a / the shared-fields skill's "three
 * layers" table): that file previously held this maths in the SAME module as
 * the Controls-specific row catalog, slot bookkeeping, state normalization
 * and "auto" row resolution, which is what let `js/shared/fields.mjs` import
 * *upward* from a track — an inversion, not a design. `js/controls/rows.mjs`
 * re-exports every name below verbatim, so no call site in either track had
 * to change; `js/shared/test_field_logic.mjs`'s own layering-guard test is
 * what keeps this direction from silently reverting.
 */

// ---------------------------------------------------------------------------
// Seed — always a STRING (2^64-1 > Number.MAX_SAFE_INTEGER; see
// `js/controls/rows.mjs`'s original "seed is a STRING in state" note — a
// numeric seed silently rounds at the top of the range).
// ---------------------------------------------------------------------------

const MAX_SEED = 2n ** 64n - 1n;

/** Clamp a hand-edited/typed/pasted seed to a valid `[0, 2^64-1]` string.
 * Tolerant of anything: empty, `Infinity`/`NaN`, a 400-digit integer, a
 * negative number, non-digit junk — all clamp to a legal string rather than
 * throwing, mirroring the guard the Python side does independently
 * (`nodes/controls/_rows_helpers.py`'s `int()` + clamp, per the design doc). */
export function clampSeedString(raw) {
  const match = String(raw ?? "").match(/\d+/);
  if (!match) {
    return "0";
  }
  let n;
  try {
    n = BigInt(match[0]);
  } catch {
    return "0";
  }
  if (n < 0n) {
    n = 0n;
  }
  if (n > MAX_SEED) {
    n = MAX_SEED;
  }
  return n.toString();
}

/** Roll a fresh seed for the "N" button. Combines two 32-bit randoms into a
 * BigInt so the result isn't quietly capped at `Number.MAX_SAFE_INTEGER`
 * either — not cryptographically meaningful, just "a new plausible seed". */
export function randomSeedString() {
  const hi = BigInt(Math.floor(Math.random() * 0x100000000));
  const lo = BigInt(Math.floor(Math.random() * 0x100000000));
  return ((hi << 32n) | lo).toString();
}

/** The four `seed_after_generate` modes, in the fixed order every stepper/
 * combo built off them cycles through. Consumed both here (`applyAfterGenerate`)
 * and by `js/controls/rows.mjs`'s own state normalization (`normalizeRow`),
 * which is why `rows.mjs` imports this back rather than redeclaring it. */
export const AFTER_MODES = ["fixed", "increment", "decrement", "randomize"];

/**
 * Advance ONE seed row after a run — stock-ComfyUI seed-control semantics:
 * the value present AT QUEUE TIME is the one that was actually used, so this
 * must be called AFTER the queued prompt has actually been sent (see
 * `js/controls/index.js`'s `queuePrompt` wrap — never before, or `lastUsed`
 * would record a seed that was never really queued).
 *
 * Records `row.opts.lastUsed = row.value` (the seed that WAS just used)
 * BEFORE touching `row.value` at all, then advances `row.value` per
 * `row.opts.after`:
 *   - `"fixed"` — `row.value` is left untouched (but `lastUsed` is still
 *     recorded, so the ↺ reuse-last-seed button always has something to fall
 *     back to the moment the mode is switched OFF fixed, even though it stays
 *     hidden while fixed).
 *   - `"randomize"` — a fresh `randomSeedString()`.
 *   - `"increment"`/`"decrement"` — BigInt ±1, CLAMPED at `[0, MAX_SEED]`
 *     rather than wrapping — a wrapping seed would silently jump from one
 *     edge of the range to the other, which reads as a bug, not a feature
 *     (mirrors `clampSeedString`'s own no-wrap contract above).
 * An unknown/missing `after` (a hand-edited/garbage state) is treated as
 * `"randomize"`, mirroring `js/controls/rows.mjs`'s own `normalizeRow`
 * fallback.
 *
 * Pure row mutation — NO DOM, NO `app`/`api` access — takes only the generic
 * `{value, opts}` shape (a real Controls row, or a throwaway row-shaped
 * wrapper — see `js/anima/index.js`'s own use of this for exactly that).
 * Returns whether ANYTHING that must be persisted changed — `row.value`
 * moved, OR `row.opts.lastUsed` moved from whatever it held coming in — NOT
 * merely whether `row.value` changed. That distinction is the whole point:
 * on `fixed`, `row.value` never moves, but `lastUsed` still needs to reach
 * the caller's persisted state (via e.g. `js/controls/index.js`'s
 * `advanceSeedsAfterRun` -> `persistState`) or the ↺ button has nothing to
 * restore after a page reload. This still stays cheap rather than
 * degenerating into "always true": on `fixed`, run 1 sets `lastUsed` from
 * absent to a real value (a genuine change -> persists once), and run 2
 * finds `lastUsed` already equal to `row.value` from run 1 (no change ->
 * skips) — so a `fixed` row persists exactly once per value it's ever held,
 * never once per run. Do NOT "simplify" this back to
 * `row.value !== prevValue`.
 */
export function applyAfterGenerate(row) {
  const prevValue = row.value;
  const prevLastUsed = row.opts.lastUsed;
  row.opts.lastUsed = prevValue;
  const lastUsedChanged = row.opts.lastUsed !== prevLastUsed;
  const after = AFTER_MODES.includes(row.opts.after) ? row.opts.after : "randomize";
  if (after === "fixed") {
    return lastUsedChanged;
  }
  if (after === "randomize") {
    row.value = randomSeedString();
  } else if (after === "increment") {
    const n = BigInt(clampSeedString(prevValue));
    row.value = (n >= MAX_SEED ? MAX_SEED : n + 1n).toString();
  } else if (after === "decrement") {
    const n = BigInt(clampSeedString(prevValue));
    row.value = (n <= 0n ? 0n : n - 1n).toString();
  }
  return row.value !== prevValue || lastUsedChanged;
}

// ---------------------------------------------------------------------------
// Numeric (int/float) range/step/value maths — ported from
// ComfyUI-Pixaroma's js/sliders/core.mjs (rangeOf/clampValue/decimalsOf),
// generalized to operate on a `{value, opts:{min,max,step}}` shape.
// ---------------------------------------------------------------------------

/** Decimal places implied by `step` (0.01 -> 2), floored at 0/capped at 6 —
 * used both for display and for rounding, so a float row never shows
 * `0.30000000000000004`. */
export function decimalsOf(step) {
  const s = Math.abs(Number(step) || 0);
  if (!s || !Number.isFinite(s)) {
    return 2;
  }
  const txt = String(s);
  const dot = txt.indexOf(".");
  if (dot < 0) {
    return 0;
  }
  return Math.min(6, txt.length - dot - 1);
}

/** A field's range, always returned low-to-high — a user (or a hand-edited
 * workflow) can set Min 100 / Max 0, and every reader has to agree on which
 * end is which or the fill paints backwards and the drag runs the wrong way. */
export function rangeOf(opts) {
  let lo = Number(opts && opts.min);
  let hi = Number(opts && opts.max);
  if (!Number.isFinite(lo)) {
    lo = 0;
  }
  if (!Number.isFinite(hi)) {
    hi = 100;
  }
  if (hi < lo) {
    const t = lo;
    lo = hi;
    hi = t;
  }
  return [lo, hi];
}

/** Snap `value` to `opts`'s step grid, clamp to its range, and kill float
 * drift — `kind` is `"int"` or `"float"`. */
export function clampNumeric(kind, value, opts) {
  const [min, max] = rangeOf(opts);
  let step = Math.abs(Number(opts && opts.step));
  if (!Number.isFinite(step) || step <= 0) {
    step = kind === "int" ? 1 : 0.01;
  }
  let n = Number(value);
  if (!Number.isFinite(n)) {
    n = min;
  }
  n = Math.round((n - min) / step) * step + min;
  n = Math.min(max, Math.max(min, n));
  if (kind === "int") {
    return Math.round(n);
  }
  return Number(n.toFixed(decimalsOf(step)));
}

/** 0..100 — how far across its own range `row.value` sits, for an inline
 * slider fill. Takes a plain `{value, opts}` pair, not a Controls row. */
export function numericPercent(row) {
  const [min, max] = rangeOf(row.opts);
  const span = max - min || 1;
  const n = Number(row.value);
  const v = Number.isFinite(n) ? n : min;
  return Math.max(0, Math.min(1, (v - min) / span)) * 100;
}

/** A numeric field's display text, decimal places implied by its step.
 *
 * Guards against `"-0.00"` (Pixaroma review-round item 9,
 * docs/pixaroma-review-rounds-plan.md): a range that crosses zero can hold
 * a value that's genuinely negative but rounds to zero AT THE STEP'S OWN
 * DISPLAY PRECISION -- either a literal JS `-0` (`(-0.00001).toFixed(2)`
 * still carries the minus sign: `"-0.00"`, and `Number("-0.00")` IS `-0`,
 * a real negative-zero float, not merely a string artifact) or a tiny
 * negative drift value that just happens to format to all zeros at this
 * `step`'s decimal count. Checking the FORMATTED string's numeric value
 * (rather than `row.value` itself, or a raw `=== 0`/`Object.is(n, -0)`
 * check) catches both: it doesn't matter whether the underlying number is
 * exactly `-0` or merely `-0.0000001` at 2 decimals -- if what's ABOUT TO
 * BE SHOWN reads as zero, it must read as a plain, unsigned zero. */
export function formatNumericValue(row) {
  const step = row.opts && row.opts.step;
  const n = Number(row.value);
  if (!Number.isFinite(n)) {
    return "0";
  }
  const decimals = decimalsOf(step);
  const formatted = n.toFixed(decimals);
  return Number(formatted) === 0 ? (0).toFixed(decimals) : formatted;
}

// ---------------------------------------------------------------------------
// Reading ComfyUI's own node defs (injectable registry — the only real
// caller anywhere in this pack is `js/controls/index.js`, which passes the
// REAL `window.LiteGraph.registered_node_types`; kept as a pure function so
// it's testable with a fake registry under plain `node`).
// ---------------------------------------------------------------------------

/**
 * `getComboOptions(registry, "KSampler", "sampler_name")` -> the option
 * list (a fresh array copy), or `null` if that node class/field isn't
 * registered (pack absent) or its spec isn't a combo. Tolerant of a
 * malformed/partial registry entry at every step — never throws.
 *
 * **2026-07-28 (V3 node-def schema fix)** — a live probe (ComfyUI 0.28.3 /
 * frontend 1.45.21) found TWO combo spec shapes live in the SAME session,
 * verbatim:
 *
 *   // V1 schema (UNETLoader, and every OLDER node def):
 *   required.unet_name === [["anima_baseV10.safetensors", "other.safetensors", ...]]
 *
 *   // V3 schema (UpscaleModelLoader, and other migrated node defs):
 *   required.model_name === ["COMBO", { multiselect: false, options: ["4x-AnimeSharp.pth", ...] }]
 *
 * `spec[0]` for the V3 shape is the literal STRING `"COMBO"`, not an array —
 * the old `Array.isArray(spec[0]) ? spec[0] : null` check returned `null` for
 * every V3-migrated node, even when the user genuinely has files installed
 * (the "upscale model picker is empty/disabled" bug this fixes: the folder
 * was never empty, this function just couldn't see the V3 list at all). Same
 * root cause class as this pack's other V3-migration fixes — the schema bites
 * on INPUT defs here, not just RETURN_TYPES/`_output0`.
 *
 * Resolution order, structural (duck-typed on `spec[1].options`, NOT by
 * matching the literal `"COMBO"` string alone — a future schema revision may
 * spell the sentinel differently, but "the second element carries a real
 * `options` array" is the actual shape that matters):
 *   1. `spec[0]` is an array -> that's the V1 list (unchanged).
 *   2. `spec[0]` is anything else AND `spec[1]` is a plain object whose
 *      `options` is an array -> that's the V3 list.
 *   3. Anything else (missing, malformed, `spec[1]` present but with no
 *      `options` array) -> `null`, exactly as before.
 */
export function getComboOptions(registry, className, field) {
  try {
    const nodeData = registry && registry[className] && registry[className].nodeData;
    const required = nodeData && nodeData.input && nodeData.input.required;
    const spec = required && required[field];
    if (!Array.isArray(spec)) {
      return null;
    }
    if (Array.isArray(spec[0])) {
      return spec[0].slice(); // V1 schema
    }
    const opts = spec[1] && typeof spec[1] === "object" ? spec[1].options : null;
    return Array.isArray(opts) ? opts.slice() : null; // V3 schema, or unrecognized -> null
  } catch {
    return null;
  }
}
