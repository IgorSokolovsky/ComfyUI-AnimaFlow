/**
 * rows.mjs — pure logic for the Control Panel / Loader Panel nodes
 * (`AnimaControlPanel` / `AnimaLoaderPanel`, `nodes/controls/*.py`, being
 * built in parallel by another agent against `docs/control-panel-design.md`).
 *
 * NO DOM, NO `app`/`window`/`LiteGraph` reference anywhere in this file — it
 * is importable under plain `node` (see `test_rows.mjs`) and is the single
 * place the row catalog, the state shape, the slot bookkeeping, and the
 * ratio/tier maths live. `render.mjs` (DOM) and `interaction.mjs` (event
 * wiring + node orchestration) both import from here rather than
 * duplicating any of it.
 *
 * ## State shape (mirrors docs/control-panel-design.md §4 exactly)
 *
 *   { version: 1, rows: [ { id, slot, kind, name, value, opts, renamed,
 *                           slotLabelOwned } ] }
 *
 * `id` is a frontend-only bookkeeping key (never serialized by
 * Python — see `nodes/controls/_rows_helpers.py`'s contract) and, unlike
 * every other field here, NOT stable across a save/reload either:
 * `normalizeRow` below mints a fresh one via `nextUid()` on every parse of
 * the saved `panel_state` widget value, including the one `index.js`'s
 * `restoreStateFromWidget` FORCES on every `onConfigure` even when
 * `onNodeCreated`'s own earlier `ensureState` call already parsed the exact
 * same JSON moments before. Never key ANY durable fact off `row.id` — that
 * was the root cause of the slot-rename-reverts-on-reload bug `slotLabelOwned`
 * below exists to fix; see `interaction.mjs`'s `syncSlotLabel`. `slot` is the
 * durable output-index label described below. `rows` is DISPLAY order.
 * `renamed` and `slotLabelOwned` are both top-level row keys (never nested in
 * `opts`) rather than a Python-side concern: `_rows_helpers.py`'s
 * `parse_state` passes each row dict through untouched (it only ever reads
 * specific known keys off it — `kind`/`opts`/`value`/`slot` — never rejects or
 * strips an unrecognized one), so both flags round-trip through a save/load
 * with zero Python changes. See `commitRename`/`applyResolvedKind` below for
 * what sets/reads `renamed`, and `interaction.mjs`'s `syncSlotLabel` for
 * `slotLabelOwned`.
 *
 * ## Slot vs. display order — the mechanism drag-to-reorder depends on
 *
 * `slot` is assigned ONCE, at row creation (`assignSlot` below: lowest
 * unused positive integer), and never renumbered by anything in this
 * module. `rows` (the array) is display order only. `interaction.mjs` maps
 * `row.slot` to a real `node.outputs` array index (`node.outputs[slot - 1]`)
 * and re-parks that index's dot at whichever row currently owns that slot's
 * Y — so dragging a row in the panel changes ITS OWN VISUAL POSITION without
 * touching any `node.outputs` index, and therefore never rewires a single
 * link. Duplicating a row calls `assignSlot` again, which always hands out a
 * FRESH number (the duplicate is a new output — it cannot inherit the
 * original's wires). Removing a row simply drops it from `rows`; its slot
 * number becomes free and `assignSlot` will hand it to the next new row
 * before ever handing out anything above the current max.
 */

// ---------------------------------------------------------------------------
// Row catalog
// ---------------------------------------------------------------------------

export const MAX_ROWS = { control: 16, loader: 8 };

// A zero-width space: truthy (so neither renderer falls back to drawing the
// raw output name on top of our row) but paints nothing — same trick
// ComfyUI-Pixaroma's sliders use for the same reason (see js/sliders/core.mjs).
export const ZW = "​";

// The output TYPE for an interior "hole" -- a slot index (`node.outputs[i]`)
// that no row currently owns, left behind because removing a row frees its
// slot NUMBER without shrinking `node.outputs` (see this module's slot-vs-
// display-order doc comment above; `interaction.mjs`'s `syncOutputs` is
// where a hole actually gets stamped with this).
//
// This must NEVER be `"*"`, `""`, or any other falsy-after-normalization
// value -- litegraph's own `LiteGraph.isValidConnection` special-cases
// exactly those as "wildcard, connects to anything", so a `"*"`-typed hole
// (which is literally what an earlier version of this code left a freed
// slot as) is a socket that silently accepts a wire from ANY output in the
// graph, binding it to a slot with no row behind it -- worse than the
// visible-dot bug it was meant to paper over. A private string nothing
// else will ever declare as a real input/output type refuses every
// connection outright, from either side, at the engine level, before this
// pack's own code ever gets a say.
export const VACANT_SLOT_TYPE = "__wtn_ctl_vacant__";

export const CONTROL_CATALOG = ["sampler", "scheduler", "seed", "int", "float", "latent"];
export const LOADER_CATALOG = ["unet", "vae", "clip"];

/**
 * One entry per row kind. `outputType` is either a plain socket type string
 * (`INT`/`FLOAT`/`LATENT`/`MODEL`/`VAE`/`CLIP`) or the literal `"combo"`
 * sentinel, which tells `outputTypeForRow` below to run the combo-typing
 * chain instead of returning a fixed string (see that function's doc
 * comment — this is the one genuinely unresolved question in the whole
 * design, per docs/control-panel-design.md §5).
 *
 * `pickerList`, where present, is a SEPARATE concern from `outputType`: it
 * marks a kind whose VALUE is chosen from a live option list (rendered as
 * the ◀ [ value ▾ ] ▶ stepper, wired to `getKnownLists()`/`NODE_DEF_SOURCE`
 * below) — always equal to the kind's own key, which doubles as the lookup
 * key into both. `sampler`/`scheduler` happen to have BOTH `outputType:
 * "combo"` (their wire really does carry ComfyUI's COMBO type) AND
 * `pickerList` (their value is also list-picked) — easy to conflate since
 * they always agree for those two. `unet`/`vae`/`clip` are exactly the case
 * that separates them: their value is ALSO list-picked (`pickerList` set),
 * but their wire is a fixed `MODEL`/`VAE`/`CLIP` socket type, never the
 * combo sentinel. Use `isPickerKind` below for "does this row need a
 * stepper/option-list UI", and `outputType`/`outputTypeForRow` ONLY for "what
 * does this row's wire actually carry" — never substitute one check for the
 * other.
 */
export const KIND_META = {
  sampler: { menu: "Sampler", outputType: "combo", pickerList: "sampler", hasGear: false, panel: "control" },
  scheduler: { menu: "Scheduler", outputType: "combo", pickerList: "scheduler", hasGear: false, panel: "control" },
  seed: { menu: "Seed", outputType: "INT", hasGear: true, panel: "control" },
  int: { menu: "Int", outputType: "INT", hasGear: false, panel: "control" },
  float: { menu: "Float", outputType: "FLOAT", hasGear: false, panel: "control" },
  latent: { menu: "Empty latent", outputType: "LATENT", hasGear: true, panel: "control" },
  unet: { menu: "UNET loader", outputType: "MODEL", pickerList: "unet", hasGear: true, panel: "loader" },
  vae: { menu: "VAE loader", outputType: "VAE", pickerList: "vae", hasGear: false, panel: "loader" },
  clip: { menu: "CLIP loader", outputType: "CLIP", pickerList: "clip", hasGear: true, panel: "loader" },
  auto: { menu: "Auto", outputType: "*", hasGear: false, panel: "both" },
};

/** Whether `kindMeta` renders/wires as a picker row (a stepper driven off a
 * live option list) — see the `KIND_META` doc comment above for why this
 * must NEVER be inferred from `outputType`. `NODE_DEF_SOURCE`/a live
 * `getKnownLists()` result are both keyed by the SAME string as
 * `kindMeta.pickerList` (== the kind's own key), so callers can pass
 * `row.kind` straight into either once this returns true. */
export function isPickerKind(kindMeta) {
  return !!(kindMeta && kindMeta.pickerList);
}

/**
 * Where each combo-backed kind's option list lives in ComfyUI's own node
 * defs — read at runtime by `index.js`'s `getComboOptions` (below), never
 * hardcoded here, so the lists always track whatever is actually installed
 * (docs/control-panel-design.md §3/"Loader Panel": "option lists need no
 * backend route").
 */
export const NODE_DEF_SOURCE = {
  sampler: { className: "KSampler", field: "sampler_name" },
  scheduler: { className: "KSampler", field: "scheduler" },
  unet: { className: "UNETLoader", field: "unet_name" },
  vae: { className: "VAELoader", field: "vae_name" },
  clip: { className: "CLIPLoader", field: "clip_name" },
};

export const AFTER_MODES = ["fixed", "increment", "decrement", "randomize"];
export const AFTER_LETTER = { fixed: "F", randomize: "R", increment: "I", decrement: "D" };

export const UNET_DTYPES = ["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"];
export const CLIP_TYPES = ["stable_diffusion", "sdxl", "flux", "wan", "qwen_image"];
export const CLIP_DEVICES = ["default", "cpu"];

// ---------------------------------------------------------------------------
// Anima-model heuristic default — a fresh/orphaned `unet` picker row (a
// brand-new row, or a saved value that fell off the currently-installed
// list) must not blindly adopt `optionList[0]` the way every other picker
// kind does: on a real models folder, index 0 is whatever sorts first,
// essentially never an Anima checkpoint (the ORIGINAL bug, just narrower --
// see this pack's Loader Panel bug report). Mirrors
// `src/anima/resources.py`'s `UNET_NAME_CANDIDATES`/`preferred_name_default`
// EXACTLY, including the same `anima(?![a-z])` heuristic regex -- KEEP THE
// TWO IN SYNC (comment repeated at that module's own definition site) or
// AnimaGenerator's internal unet_name picker and this Loader Panel's
// fresh-row default can silently disagree about which installed file "is"
// the Anima model.
// ---------------------------------------------------------------------------

export const UNET_NAME_CANDIDATES = [
  "anima-base-v1.0.safetensors",
  // Upstream's own second candidate, verbatim -- see resources.py's
  // identical comment on its Python twin.
  "ANIMA\\anima_baseV10.safetensors",
];

/** Last path segment, lowercased, tolerant of either slash direction --
 * JS twin of `resources.py`'s `_preferred_name_basename`. */
function preferredNameBasename(name) {
  return String(name).replace(/\\/g, "/").split("/").pop().toLowerCase();
}

/** Matches "anima" case-insensitively but NOT as a substring of a longer
 * word -- the negative lookahead is what rejects **Animagine XL**
 * (`animagineXL31.safetensors`, a real, unrelated SDXL anime model: "g"
 * immediately follows "anima") while still accepting
 * `nyaIrisAnima_base1V20.safetensors` ("_" follows), `anima-base-v1.0...`
 * ("-" follows), `ANIMA/anima_baseV10...` ("_" follows), and bare
 * `Anima.safetensors` (end of string). Identical regex to
 * `resources.py`'s `_ANIMA_HEURISTIC_RE` -- keep both in sync. */
const ANIMA_HEURISTIC_RE = /anima(?![a-z])/i;

/** First entry in `names` (list order, not sorted) the heuristic above
 * matches, or `null` if nothing does. */
function firstAnimaHeuristicMatch(names) {
  const found = names.find((n) => ANIMA_HEURISTIC_RE.test(String(n)));
  return found === undefined ? null : found;
}

/**
 * `names` (a live installed-file list) + `candidates` (preference order) ->
 * the best default filename. Resolution order mirrors
 * `resources.py`'s `preferred_name_default` EXACTLY: exact candidate ->
 * basename-insensitive candidate -> `anima`-heuristic -> `names[0]` ->
 * `candidates[0]`/`""` if `names` is empty. Used by `interaction.mjs`'s
 * `repaintRows` for a `unet` row instead of the plain `optionList[0]` every
 * other picker kind still uses (see this section's doc comment for why
 * `unet` alone needs it).
 */
export function preferredNameDefault(names, candidates) {
  const list = Array.isArray(names) ? names : [];
  const cands = Array.isArray(candidates) ? candidates : [];
  if (!list.length) {
    return cands.length ? cands[0] : "";
  }
  for (const candidate of cands) {
    if (list.includes(candidate)) {
      return candidate;
    }
  }
  const byBasename = new Map(list.map((n) => [preferredNameBasename(n), n]));
  for (const candidate of cands) {
    const match = byBasename.get(preferredNameBasename(candidate));
    if (match !== undefined) {
      return match;
    }
  }
  const heuristic = firstAnimaHeuristicMatch(list);
  if (heuristic !== null) {
    return heuristic;
  }
  return list[0];
}

/**
 * Aspect ratios, each pinned to its canonical dimensions at the 1024 tier
 * (the SDXL/Anima buckets people already recognise — 832×1216, 1344×768…).
 * docs/control-panel-design.md §3a: deriving these from an area formula
 * instead lands 2:3 at 832×1248, which reads as wrong to anyone who knows
 * the buckets — so the table is pinned, not derived.
 */
export const RATIOS = [
  ["1:1", 1024, 1024], ["16:9", 1344, 768], ["9:16", 768, 1344],
  ["2:1", 1408, 704], ["3:2", 1216, 832], ["2:3", 832, 1216],
  ["4:3", 1152, 896], ["3:4", 896, 1152], ["4:5", 912, 1152],
];
export const TIERS = [512, 768, 1024, 1280, 1328, 1408, 1536, 2048];

export function snap16(n) {
  return Math.max(64, Math.round(n / 16) * 16);
}

/** Every tier scales the canonical 1024-tier pair by `tier/1024` and snaps
 * to 16 — see this module's ratio-table doc comment above. Falls back to
 * the first ratio ("1:1") for an unknown ratio name, and to the 1024 tier
 * for a non-finite/unknown tier, rather than throwing on bad state. */
export function dimsFor(ratio, tier) {
  const found = RATIOS.find((r) => r[0] === ratio) || RATIOS[0];
  const t = Number(tier);
  const k = (Number.isFinite(t) && t > 0 ? t : 1024) / 1024;
  return [snap16(found[1] * k), snap16(found[2] * k)];
}

// ---------------------------------------------------------------------------
// Seed — always a STRING (2^64-1 > Number.MAX_SAFE_INTEGER; see the design
// doc §4's "seed is a STRING in state" note — a numeric seed silently
// rounds at the top of the range).
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

/**
 * Advance ONE seed row after a run — stock-ComfyUI seed-control semantics:
 * the value present AT QUEUE TIME is the one that was actually used, so this
 * must be called AFTER the queued prompt has actually been sent (see
 * `index.js`'s `queuePrompt` wrap — never before, or `lastUsed` would record
 * a seed that was never really queued).
 *
 * Records `row.opts.lastUsed = row.value` (the seed that WAS just used)
 * BEFORE touching `row.value` at all, then advances `row.value` per
 * `row.opts.after`:
 *   - `"fixed"` — `row.value` is left untouched (but `lastUsed` is still
 *     recorded, so the ↺ reuse-last-seed button — `interaction.mjs`'s
 *     `wireSeedRow` — always has something to fall back to the moment the
 *     mode is switched OFF fixed, even though it stays hidden while fixed).
 *   - `"randomize"` — a fresh `randomSeedString()`.
 *   - `"increment"`/`"decrement"` — BigInt ±1, CLAMPED at `[0, MAX_SEED]`
 *     rather than wrapping — a wrapping seed would silently jump from one
 *     edge of the range to the other, which reads as a bug, not a feature
 *     (mirrors `clampSeedString`'s own no-wrap contract above).
 * An unknown/missing `after` (a hand-edited/garbage state) is treated as
 * `"randomize"`, mirroring `normalizeRow`'s own fallback below.
 *
 * Pure row mutation — NO DOM, NO `app`/`api` access — so `index.js`'s
 * `queuePrompt` wrap can call this directly with zero further imports, and
 * it stays unit-testable here under plain `node`. Returns whether ANYTHING
 * that must be persisted changed — `row.value` moved, OR `row.opts.lastUsed`
 * moved from whatever it held coming in — NOT merely whether `row.value`
 * changed. That distinction is the whole point: on `fixed`, `row.value`
 * never moves, but `lastUsed` still needs to reach the serialized
 * `panel_state` widget (via `index.js`'s `advanceSeedsAfterRun` ->
 * `persistState`) or the ↺ button has nothing to restore after a page
 * reload. This still stays cheap rather than degenerating into
 * "always true": on `fixed`, run 1 sets `lastUsed` from absent to a real
 * value (a genuine change -> persists once), and run 2 finds `lastUsed`
 * already equal to `row.value` from run 1 (no change -> skips) — so a
 * `fixed` row persists exactly once per value it's ever held, never once
 * per run. Do NOT "simplify" this back to `row.value !== prevValue`.
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
// generalized to operate on a row's `{value, opts:{min,max,step}}` shape.
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

/** A row's range, always returned low-to-high — a user (or a hand-edited
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

/** Pick a range that is actually draggable. A `steps` input allows
 * `1..10000`; a slider spanning that is ~40 steps per pixel — useless. Keep
 * the input's own minimum and step, cap the top at 4x the current value
 * (never above the input's real maximum) — ported verbatim from
 * ComfyUI-Pixaroma's `usefulRange` (js/sliders/core.mjs). */
export function usefulRange(min, max, step, value) {
  const span = (max - min) / (step || 1);
  if (Number.isFinite(span) && span <= 400) {
    return [min, max];
  }
  const v = Number.isFinite(value) ? value : min;
  let top = Math.max(v * 4, min + 10 * step);
  if (Number.isFinite(max)) {
    top = Math.min(top, max);
  }
  return [min, top];
}

// ---------------------------------------------------------------------------
// Row factory + slot assignment
// ---------------------------------------------------------------------------

let _uid = 0;
/** Frontend-only bookkeeping id, never touches `slot`. Exposed mainly so
 * tests can reset/observe it deterministically if ever needed. */
export function nextUid() {
  _uid += 1;
  return _uid;
}

/** Build a fresh row of `kind` with that kind's default `value`/`opts`.
 * `overrides` may set `name`/`value` and is shallow-merged into `opts`
 * (never wholesale-replaces it), so a caller can override e.g. just
 * `{opts: {min: 1}}` without having to restate every other option. */
export function mkRow(kind, overrides = {}) {
  // `slotLabelOwned` starts `false` -- a fresh row's output slot has never
  // had a user-set socket label, so it's still ours to manage (see
  // `interaction.mjs`'s `syncSlotLabel`).
  const row = { id: nextUid(), kind, name: kind, value: undefined, opts: {}, renamed: false, slotLabelOwned: false };

  if (kind === "seed") {
    row.value = "0";
    row.opts = { after: "randomize", lastMode: "randomize" };
  } else if (kind === "int") {
    row.value = 1;
    row.opts = { min: 1, max: 100, step: 1 };
  } else if (kind === "float") {
    row.value = 0.5;
    row.opts = { min: 0, max: 1, step: 0.01 };
  } else if (kind === "latent") {
    row.opts = { mode: "predefined", ratio: "1:1", tier: 1024, w: 1024, h: 1024, batch: 1 };
  } else if (kind === "unet") {
    row.opts = { weight_dtype: "default" };
  } else if (kind === "clip") {
    // "qwen_image", NOT CLIP_TYPES[0] ("stable_diffusion") -- this pack
    // targets Anima, whose CLIP is a Qwen text encoder; AnimaGenerator's own
    // internal clip_type picker already defaults to "qwen_image"
    // (nodes/anima/generator.py), so the two must agree or the Loader Panel
    // (the RECOMMENDED path) silently loads the wrong CLIP type. Only the
    // fresh-row default changes here -- normalizeRow's fallback below is the
    // other site; an already-saved `stable_diffusion` value is untouched by
    // either (see that site's comment for why).
    row.opts = { type: "qwen_image", device: "default" };
  }
  // sampler / scheduler / vae / auto: no extra opts.

  if (overrides.name !== undefined) {
    row.name = overrides.name;
  }
  if (overrides.value !== undefined) {
    row.value = overrides.value;
  }
  if (overrides.opts) {
    row.opts = { ...row.opts, ...overrides.opts };
  }
  return row;
}

// ---------------------------------------------------------------------------
// Row presets — pre-configured `int`/`float` rows for a common control
// (steps/cfg/denoise), NOT new kinds. `nodes/controls/_rows_helpers.py`'s
// `value_for_row` dispatches on the row's `kind` STRING alone (verified by
// reading it: `sampler`/`scheduler`/`seed`/`int`/`float`, anything else falls
// through to `0`) — a genuinely new kind would need a matching Python change
// or silently emit `0` while the UI still shows the real value, exactly the
// failure class the UE label fix above already guards against once today. A
// preset keeps `kind: "int"`/`kind: "float"` and only pre-fills
// `name`/`value`/`opts`, so the existing backend path is already correct —
// no Python change needed.
// ---------------------------------------------------------------------------

export const ROW_PRESETS = {
  // Ranges below are the DRAGGABLE ranges, not KSampler's absolute limits
  // (its `steps` allows up to 10000, `cfg` up to 100 — a slider spanning
  // that is unusably fine-grained; same reasoning as `usefulRange` above).
  steps: { kind: "int", menu: "Steps", name: "steps", value: 30, opts: { min: 1, max: 120, step: 1 } },
  cfg: { kind: "float", menu: "CFG", name: "cfg", value: 5.0, opts: { min: 0, max: 20, step: 0.1 } },
  denoise: { kind: "float", menu: "Denoise", name: "denoise", value: 1.0, opts: { min: 0, max: 1, step: 0.01 } },
};

/** Whether `id` is a preset id (`"steps"`/`"cfg"`/`"denoise"`) rather than a
 * real row kind — the two id spaces never collide (no preset shares a name
 * with a `KIND_META` key), but callers should use this rather than assuming. */
export function isPresetId(id) {
  return Object.prototype.hasOwnProperty.call(ROW_PRESETS, id);
}

/** The `{ menu, outputType }` a "+ Add" menu entry shows, whether `id` is a
 * real row kind (straight from `KIND_META`) or a preset id (its OWN `menu`
 * label, but the underlying kind's `outputType` — a preset has no socket
 * type of its own, it borrows its base kind's). Returns `undefined` for
 * neither (an unrecognized id), same as a bare `KIND_META[id]` lookup would. */
export function menuMetaFor(id) {
  if (isPresetId(id)) {
    const preset = ROW_PRESETS[id];
    const base = KIND_META[preset.kind];
    return base && { menu: preset.menu, outputType: base.outputType };
  }
  return KIND_META[id];
}

/** Build a fresh row for `id` — either a bare kind (`mkRow(id)`, unchanged
 * behaviour) or a preset id (`mkRow(preset.kind, {name, value, opts})`,
 * additionally stamped `renamed: true`). That stamp is deliberate: without
 * it, the FIRST wire this row's output gets would run through
 * `applyResolvedKind` (below) exactly like any other row and silently adopt
 * the connection target's name, relabeling a "cfg" row to whatever the
 * target input happens to be called — defeating the entire point of a named
 * preset. Reusing `renamed` (the same flag a manual rename sets) rather than
 * inventing a parallel mechanism means every other renamed-row behavior
 * (`applyResolvedKind` below, the row's own Rename menu item) already treats
 * a preset identically to a user-renamed row for free. Range/step/value
 * adoption on connect is UNAFFECTED — `applyResolvedKind` only gates the
 * NAME half on `renamed`, never the opts/value half. */
export function mkCatalogRow(id) {
  if (isPresetId(id)) {
    const preset = ROW_PRESETS[id];
    const row = mkRow(preset.kind, { name: preset.name, value: preset.value, opts: preset.opts });
    row.renamed = true;
    return row;
  }
  return mkRow(id);
}

// Cap on a hand-typed row rename -- long enough for any real label, short
// enough that a pasted essay can't blow out the row layout (the label
// itself already ellipsizes past its own min-width, but the state file
// staying sane doesn't depend on the CSS).
export const MAX_ROW_NAME_LEN = 40;

/** Sanitize a hand-typed (or hand-edited-payload) row name: trim, cap at
 * `MAX_ROW_NAME_LEN`, and fall back to `kind` (the same default `mkRow`/
 * `normalizeRow` already use for a missing name) if the trimmed result is
 * empty -- a row can never end up with a blank label. */
export function sanitizeRowName(raw, kind) {
  const trimmed = String(raw ?? "").trim().slice(0, MAX_ROW_NAME_LEN);
  return trimmed || kind;
}

/** Commit a user-typed rename onto `row` IN PLACE (mirrors
 * `applyResolvedKind`'s in-place-mutation contract, so every existing DOM
 * ref/closure holding this row object sees the change immediately): sets
 * `row.name` via `sanitizeRowName` and stamps `row.renamed = true`. That flag
 * is the entire point -- see `applyResolvedKind` below, which skips adopting
 * a connection target's name for any row a user has renamed by hand, while
 * still adopting its range/step/value. Returns the sanitized name. */
export function commitRename(row, raw) {
  row.name = sanitizeRowName(raw, row.kind);
  row.renamed = true;
  return row.name;
}

/** Hand `row` the lowest unused positive integer among every OTHER row's
 * slot, and stamp it in place. This is the entire "never renumber" contract:
 * called exactly once per row, at creation (fresh add) or re-creation
 * (duplicate) — never on reorder.
 *
 * NARROW, DELIBERATE EXCEPTION: `planHoleCompaction` (below) is the ONE
 * other place a row's `slot` is ever changed after this call, and only
 * under a precondition this function does not itself enforce — every row
 * whose slot it proposes to move must be UNWIRED
 * (`interaction.mjs`'s `compactHoles` supplies the real wiredness, read off
 * `node.outputs[slot-1].links`). That's safe specifically BECAUSE it's
 * unwired: the entire reason "never renumber" exists is that a row's slot
 * is the durable output-array INDEX a downstream link is bound to (design
 * doc §4, "display order and slot order are separate" — renumbering a
 * WIRED row would silently retarget someone's wire out from under them). A
 * row with no link has nothing for a renumber to retarget, so closing a
 * hole underneath it costs nothing a user could ever notice except making
 * the stray dot the hole itself was causing go away (the actual bug —
 * see `interaction.mjs`'s `markSlotVacant`/`parkVacantSlot`). If this
 * exception ever needs to widen past "compact an interior hole downward,"
 * treat that as a fresh design question, not an extension of this comment.
 *
 * SECOND, EQUALLY LOAD-BEARING PRECONDITION: `interaction.mjs`'s
 * `compactHoles` only ever calls `planHoleCompaction` (and only ever applies
 * what it returns) as a result of a genuine USER ACTION — add/remove/edit a
 * row — never while a saved workflow is being restored
 * (`node._ctrlConfiguring`, gated at `syncOutputs`'s call site). A hole is
 * part of that workflow's own last-saved shape; loading it must reproduce
 * that shape exactly, not "fix" it on the way in. So in practice this
 * exception only ever fires in the same session, off the same live
 * wiredness read, that a row was just added/removed/duplicated/resolved —
 * never as a side effect of opening a file.
 */
export function assignSlot(rows, row) {
  const used = new Set(rows.filter((r) => r !== row && Number.isFinite(r.slot)).map((r) => r.slot));
  let s = 1;
  while (used.has(s)) {
    s += 1;
  }
  row.slot = s;
  return row;
}

/**
 * Change 1 of the stray-output-dot fix (diagnosed live: an interior "hole"
 * left by `assignSlot` handing out the LOWEST free slot, then a later
 * removal freeing a slot BELOW one still in use — `interaction.mjs`'s
 * `syncOutputs`/`markSlotVacant` is what keeps a hole invisible for as long
 * as it exists, but it can't make one stop existing). Given the CURRENT
 * `rows` and a real `isWiredBySlot(slot) -> boolean` oracle, decide which
 * interior holes can be closed WITHOUT ever renumbering a wired row's slot,
 * and return the `{from, to}` moves that close them — `from`/`to` are both
 * plain slot NUMBERS, never row objects or `node.outputs` array indices.
 * Each row moves AT MOST once in the returned plan, even if it conceptually
 * hops through several holes to get to its final slot (see "Algorithm"
 * below). Never mutates `rows` — purely a planner; `interaction.mjs`'s
 * `compactHoles` is the one place that actually rewrites `row.slot`.
 *
 * ## Algorithm
 *
 * Repeatedly: find the highest INTERIOR hole under the current highest USED
 * slot (`maxSlot`). The only possible candidate to fill it is whichever row
 * currently sits AT `maxSlot` — by construction nothing between the hole and
 * `maxSlot` outranks it, and nothing above `maxSlot` exists at all. If that
 * row is wired, STOP ENTIRELY: it is the SAME row blocking every remaining
 * hole too, since `maxSlot` sits above every one of them, not just the one
 * just checked. If it's unwired, "move" it into the hole — bookkept via a
 * slot -> origin-slot map so a row that cascades down through several
 * closed holes in one call still nets out to a single final `{from, to}` —
 * and recompute `maxSlot`. Stop when no interior hole remains.
 *
 * This fully compacts the exact reported-bug shape (live 1,2,3,4,5,7 + hole
 * at 6, slot 7 unwired — see `test_resize.mjs`'s regression test), and
 * partially compacts a more tangled multi-hole layout up to the first wired
 * row it meets counting DOWN from the top, leaving that row's hole (and
 * every hole below it that would have needed the SAME row) alone, per this
 * function's unwired-only contract.
 *
 * Returns `[]` for no rows, no interior holes at all (including a
 * "hole" that isn't interior — nothing above the highest used slot, the
 * ordinary trailing case `syncOutputs`'s own trim already handles), or a
 * `maxSlot` row that's wired on the very first check.
 */
export function planHoleCompaction(rows, isWiredBySlot) {
  const wired = typeof isWiredBySlot === "function" ? isWiredBySlot : () => false;

  const used = new Set();
  for (const r of rows) {
    if (Number.isFinite(r.slot) && r.slot > 0) {
      used.add(r.slot);
    }
  }
  if (!used.size) {
    return [];
  }

  // Current slot (as this simulation stands right now) -> the ORIGINAL slot
  // number of the row that occupies it -- lets a row that cascades through
  // several closed holes in one call collapse to a single final move.
  const origin = new Map();
  for (const s of used) {
    origin.set(s, s);
  }

  let maxSlot = Math.max(...used);
  const finalTo = new Map(); // originalSlot -> latest destination slot

  for (;;) {
    let hole = -1;
    for (let s = maxSlot - 1; s >= 1; s--) {
      if (!used.has(s)) {
        hole = s;
        break;
      }
    }
    if (hole < 0) {
      break; // nothing interior left to close
    }
    const originSlot = origin.get(maxSlot);
    if (wired(originSlot)) {
      break; // the ONLY candidate above every remaining hole is wired
    }
    used.delete(maxSlot);
    used.add(hole);
    origin.set(hole, originSlot);
    origin.delete(maxSlot);
    finalTo.set(originSlot, hole);
    maxSlot = Math.max(...used);
  }

  const plan = [];
  for (const [from, to] of finalTo) {
    if (from !== to) {
      plan.push({ from, to });
    }
  }
  plan.sort((a, b) => a.to - b.to);
  return plan;
}

// ---------------------------------------------------------------------------
// State shape: default / normalize / mutate
// ---------------------------------------------------------------------------

/** A brand-new node's starting state. The Loader Panel starts pre-populated
 * with its three fixed loaders (an empty loader panel has nothing useful to
 * emit); the Control Panel starts empty — its whole catalog is opt-in via
 * "+ Add control". */
export function defaultState(panelKind) {
  if (panelKind === "loader") {
    const rows = [mkRow("unet"), mkRow("vae"), mkRow("clip")];
    rows.forEach((r) => assignSlot(rows, r));
    return { version: 1, rows };
  }
  return { version: 1, rows: [] };
}

function normalizeRow(raw, panelKind) {
  const kind = raw.kind;
  const row = {
    id: nextUid(),
    slot: Number.isFinite(raw.slot) && raw.slot > 0 ? Math.round(raw.slot) : undefined,
    kind,
    name: sanitizeRowName(raw.name, kind),
    value: raw.value,
    opts: raw.opts && typeof raw.opts === "object" ? { ...raw.opts } : {},
    // Only a literal `true` counts -- a hand-edited/garbage payload can't
    // spoof "user renamed this" with a truthy-but-not-boolean value, and a
    // fresh/never-renamed row (no `renamed` key at all) correctly stays
    // false so it keeps adopting a name on first auto-resolve connection.
    renamed: raw.renamed === true,
    // Same boolean-safety contract as `renamed` immediately above, for the
    // socket-label equivalent: a slot the user renamed directly (litegraph's
    // own Rename Slot dialog) stays owned across THIS parse, no matter that
    // `id` above just got a brand-new value -- see `interaction.mjs`'s
    // `syncSlotLabel`, the one place that ever sets this to `true`. An old
    // saved row with no `slotLabelOwned` key at all (every row saved before
    // this fix existed) correctly starts `false`, same as a brand-new row --
    // the first sync after upgrading re-derives ownership from the restored
    // `out.label` itself, per that function's own fallback heuristic.
    slotLabelOwned: raw.slotLabelOwned === true,
  };

  if (kind === "seed") {
    row.value = clampSeedString(row.value);
    const after = AFTER_MODES.includes(row.opts.after) ? row.opts.after : "randomize";
    const lastMode = AFTER_MODES.includes(row.opts.lastMode)
      ? row.opts.lastMode
      : (after === "fixed" ? "randomize" : after);
    const opts = { after, lastMode };
    // Carry `lastUsed` (the seed `applyAfterGenerate` actually queued last
    // time, above) through a normalize pass — this object was previously
    // rebuilt as exactly `{after, lastMode}`, which silently DROPPED
    // `lastUsed` on every save/reload. Old saved workflows have no
    // `lastUsed` at all — that's fine, it's simply omitted (never defaulted
    // to `"0"` or similar), so the ↺ reuse button stays correctly hidden
    // until this row's first post-load run records a real one.
    if (row.opts.lastUsed != null) {
      opts.lastUsed = clampSeedString(row.opts.lastUsed);
    }
    row.opts = opts;
  } else if (kind === "int" || kind === "float") {
    const [min, max] = rangeOf(row.opts);
    let step = Number(row.opts.step);
    if (!Number.isFinite(step) || step <= 0) {
      step = kind === "int" ? 1 : 0.01;
    }
    row.opts = {
      min: kind === "int" ? Math.round(min) : min,
      max: kind === "int" ? Math.round(max) : max,
      step,
    };
    row.value = clampNumeric(kind, row.value, row.opts);
  } else if (kind === "latent") {
    const mode = row.opts.mode === "custom" ? "custom" : "predefined";
    const ratio = RATIOS.some((r) => r[0] === row.opts.ratio) ? row.opts.ratio : "1:1";
    const tier = TIERS.includes(Number(row.opts.tier)) ? Number(row.opts.tier) : 1024;
    let w = Number(row.opts.w);
    let h = Number(row.opts.h);
    if (mode === "predefined" || !Number.isFinite(w) || !Number.isFinite(h)) {
      [w, h] = dimsFor(ratio, tier);
    } else {
      w = snap16(Math.max(16, w));
      h = snap16(Math.max(16, h));
    }
    let batch = Math.round(Number(row.opts.batch));
    if (!Number.isFinite(batch) || batch < 1) {
      batch = 1;
    }
    row.opts = { mode, ratio, tier, w, h, batch };
  } else if (kind === "unet") {
    row.opts = { weight_dtype: UNET_DTYPES.includes(row.opts.weight_dtype) ? row.opts.weight_dtype : "default" };
    row.value = typeof row.value === "string" ? row.value : undefined;
  } else if (kind === "vae") {
    row.opts = {};
    row.value = typeof row.value === "string" ? row.value : undefined;
  } else if (kind === "clip") {
    // Fallback is "qwen_image" (Anima's own CLIP type -- see mkRow's clip
    // branch above), used ONLY when `row.opts.type` is missing/invalid
    // (a hand-edited payload, or an old save with no `type` at all). A
    // stored value that IS a valid CLIP_TYPES entry -- including a
    // deliberately-picked "stable_diffusion" -- passes through UNCHANGED:
    // there's no way to tell "this is the old wrong default" apart from "the
    // user picked this on purpose", and stomping the latter is worse than
    // leaving the former. Existing saved rows are NOT migrated -- a user
    // with a pre-fix row still showing "stable_diffusion" needs to flip it
    // by hand in the ⚙ popover.
    row.opts = {
      type: CLIP_TYPES.includes(row.opts.type) ? row.opts.type : "qwen_image",
      device: CLIP_DEVICES.includes(row.opts.device) ? row.opts.device : "default",
    };
    row.value = typeof row.value === "string" ? row.value : undefined;
  } else if (kind === "sampler" || kind === "scheduler") {
    row.opts = {};
    row.value = typeof row.value === "string" ? row.value : undefined;
  } else {
    // "auto" (or anything unrecognized, guarded out by the caller's
    // allowedKinds filter before this function ever sees it)
    row.opts = {};
  }
  return row;
}

/**
 * Defensively parse `raw` (the JSON already `JSON.parse`d, or garbage) into
 * a valid state for `panelKind` — clamps to `MAX_ROWS`, drops rows whose
 * `kind` isn't in this panel's catalog (or `"auto"`), clamps every row's
 * opts/value by kind, and re-stamps `slot` for anything missing/duplicate/
 * non-finite while leaving every already-valid unique slot untouched (so
 * restoring a saved workflow never silently renumbers a link).
 */
export function normalizeState(raw, panelKind) {
  const maxRows = MAX_ROWS[panelKind] || MAX_ROWS.control;
  const catalog = panelKind === "loader" ? LOADER_CATALOG : CONTROL_CATALOG;
  const allowedKinds = new Set([...catalog, "auto"]);

  let rows = [];
  if (raw && typeof raw === "object" && Array.isArray(raw.rows)) {
    rows = raw.rows
      .filter((r) => r && typeof r === "object" && allowedKinds.has(r.kind))
      .slice(0, maxRows)
      .map((r) => normalizeRow(r, panelKind));
  }

  const seen = new Set();
  for (const r of rows) {
    if (Number.isFinite(r.slot) && r.slot > 0 && !seen.has(r.slot)) {
      seen.add(r.slot);
    } else {
      r.slot = undefined;
    }
  }
  for (const r of rows) {
    if (r.slot === undefined) {
      assignSlot(rows, r);
    }
  }

  return { version: 1, rows };
}

/** Append a new row to `state` for `kindOrPresetId` (a bare kind like
 * `"int"`, or one of `ROW_PRESETS`'s ids like `"steps"` — `mkCatalogRow`
 * resolves either) (display order: last), assigning it a fresh slot. Returns
 * the new row, or `null` if the panel is already at `MAX_ROWS[panelKind]`. */
export function addRow(state, kindOrPresetId, panelKind) {
  const maxRows = MAX_ROWS[panelKind] || MAX_ROWS.control;
  if (state.rows.length >= maxRows) {
    return null;
  }
  const row = mkCatalogRow(kindOrPresetId);
  assignSlot(state.rows, row);
  state.rows.push(row);
  return row;
}

/** Insert a copy of the row with id `rowId` immediately after it. The copy
 * is a NEW output (`assignSlot` again) — it cannot inherit the original's
 * wires, so pretending otherwise would be a lie (design doc §3). Returns the
 * new row, or `null` if not found / the panel is already full. */
export function duplicateRow(state, rowId, panelKind) {
  const maxRows = MAX_ROWS[panelKind] || MAX_ROWS.control;
  if (state.rows.length >= maxRows) {
    return null;
  }
  const idx = state.rows.findIndex((r) => r.id === rowId);
  if (idx < 0) {
    return null;
  }
  const copy = { ...state.rows[idx], id: nextUid(), opts: { ...state.rows[idx].opts } };
  copy.slot = undefined;
  // A duplicate's OUTPUT is a fresh socket (assignSlot below hands it a
  // brand-new slot number) -- it starts with no label of its own, so it must
  // never inherit the ORIGINAL's `slotLabelOwned` claim on a socket this copy
  // doesn't even share. Explicit reset rather than relying on the spread
  // above to have skipped it (it wouldn't have -- `slotLabelOwned` is a plain
  // top-level key like every other field `{...}` copies verbatim).
  copy.slotLabelOwned = false;
  assignSlot(state.rows, copy);
  state.rows.splice(idx + 1, 0, copy);
  return copy;
}

/** Drop the row with id `rowId`. Its slot becomes free — `assignSlot` will
 * hand it to the next added row before ever handing out anything above the
 * current max. Returns `true` if a row was actually removed. */
export function removeRow(state, rowId) {
  const idx = state.rows.findIndex((r) => r.id === rowId);
  if (idx < 0) {
    return false;
  }
  state.rows.splice(idx, 1);
  return true;
}

/**
 * Pure array reorder: move the element at `fromIndex` in `originalRows` to
 * `toIndex`, clamped to the array's bounds. Deliberately takes
 * `originalRows` (a snapshot) rather than mutating in place — callers
 * dragging a row must recompute from the ORIGINAL order on every pointer
 * move, not from a previously-mutated array, or rows leapfrog each other as
 * the array mutates underneath the maths (this exact trap is called out in
 * `playground/control-panel.html`'s `pointermove` handler).
 */
export function reorderRows(originalRows, fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= originalRows.length) {
    return originalRows.slice();
  }
  const clampedTo = Math.max(0, Math.min(originalRows.length - 1, toIndex));
  const arr = originalRows.slice();
  arr.splice(clampedTo, 0, ...arr.splice(fromIndex, 1));
  return arr;
}

// ---------------------------------------------------------------------------
// Output typing — docs/control-panel-design.md §5, "the one real unknown"
// ---------------------------------------------------------------------------

/**
 * Which of the three combo-typing strategies is active. Legacy litegraph
 * compares output/input type STRINGS; a combo widget's declared type is
 * either the option list itself (older builds) or the literal string
 * `"COMBO"` (newer ones).
 *
 * VERIFIED 2026-07-27 in a live ComfyUI page (docs/control-panel-design.md
 * §5): `"COMBO"` is correct — sampler and scheduler rows wire to a KSampler
 * and deliver the right value. `"list"` and `"permissive"` stay implemented
 * below only in case a future frontend version needs them; do not flip this
 * constant while combos are working.
 */
export const COMBO_TYPE_STRATEGY = "COMBO"; // "COMBO" | "list" | "permissive"

/** `list` is this combo kind's CURRENT option list (or `null`/empty if the
 * owning node def isn't installed) — see `outputTypeForRow` below. */
export function resolveComboOutputType(list) {
  if (COMBO_TYPE_STRATEGY === "list" && Array.isArray(list) && list.length) {
    return list.join(",");
  }
  if (COMBO_TYPE_STRATEGY === "permissive") {
    return "*";
  }
  return "COMBO";
}

/**
 * The narrowed output type for `row`, given `listsByKind` (the live option
 * lists this session's `KSampler`/`UNETLoader`/`VAELoader`/`CLIPLoader` defs
 * currently carry — see `NODE_DEF_SOURCE`/`index.js`'s `getComboOptions`).
 * An unresolved `"auto"` row is always `"*"` (permissive — nothing is known
 * about it yet, so any wire is refused only by the TARGET's own type, not
 * ours).
 */
export function outputTypeForRow(row, listsByKind) {
  const meta = KIND_META[row.kind];
  if (!meta || row.kind === "auto") {
    return "*";
  }
  if (meta.outputType === "combo") {
    const list = listsByKind && listsByKind[row.kind];
    return resolveComboOutputType(list);
  }
  return meta.outputType;
}

// ---------------------------------------------------------------------------
// Slot label — cg-use-everywhere ("UE") interop. UE can broadcast directly
// FROM a node's own output slots (its right-click menu shows "Broadcasting
// Outputs > sampler | scheduler"), no "Anything Everywhere" node needed —
// but for REPEATED types (two COMBO rows: sampler + scheduler) it disambig-
// uates by comparing the broadcasting output's NAME/LABEL against the
// destination input's name, not just its type. Every slot previously carried
// the bare `ZW` sentinel as its label (see `outputTypeForRow`'s sibling
// concern, `out.name`, which must stay `value_${slot}` and is UNRELATED to
// this), which worked by TYPE alone for a single COMBO row but left two rows
// of the same type indistinguishable to UE.
// ---------------------------------------------------------------------------

/**
 * `"row-name"` (default): a slot this module still owns (see
 * `interaction.mjs`'s `syncOutputs`/`syncSlotLabel` ownership bookkeeping)
 * gets labeled with the row's OWN display name (e.g. `"sampler"`), so UE's
 * name-based disambiguation works with zero manual renaming. `"hidden"`: the
 * pre-UE-interop behaviour — every still-owned slot's label stays the bare
 * `ZW` sentinel (never painted, and useless to UE's name match, but
 * guaranteed never to visibly bleed onto the canvas either).
 *
 * VERIFIED 2026-07-27 in a live ComfyUI page (docs/control-panel-design.md
 * §5): a real label causes no visible bleed — litegraph paints slot text on
 * the canvas while our rows are opaque DOM layered above it. `"hidden"`
 * remains as an escape hatch; nothing currently needs it.
 */
export const SLOT_LABEL_MODE = "row-name"; // "row-name" | "hidden"

// Zero-width space (this module's `ZW`) and a leading BOM — both invisible,
// both seen in the wild: litegraph's rename-slot dialog pre-fills with the
// slot's CURRENT label, so renaming a ZW-sentinel'd slot produces
// `${ZW}typed text` (confirmed against a live dump) — a UE exact-string name
// match fails on that invisible leading character even though the visible
// text reads identical to what the user typed.
const ZW_EDGE_RE = /^[\u200b\ufeff]+|[\u200b\ufeff]+$/g;

/** Strip a leading/trailing zero-width space or BOM from `label` — a no-op
 * on a label that never had one. Exported so `interaction.mjs` can heal a
 * `${ZW}typed` rename in place without re-deriving this regex. */
export function stripZeroWidthEdges(label) {
  return String(label ?? "").replace(ZW_EDGE_RE, "");
}

/** Whether `label` counts as "nothing meaningful has ever been written
 * here" — a brand-new output with no `label` at all, an empty string, the
 * bare `ZW` sentinel, or a label that's ONLY zero-width junk. This is the
 * ONE condition `interaction.mjs`'s `syncSlotLabel` needs re-derived from
 * scratch (a row that has never had a real label yet); it is NOT the whole
 * ownership rule — a label matching what we ourselves last wrote is ALSO
 * still ours, but that half needs `interaction.mjs`'s own per-node
 * bookkeeping (this module never touches `node.*`), not this predicate. */
export function isBlankSlotLabel(label) {
  if (label === undefined || label === null || label === ZW) {
    return true;
  }
  return stripZeroWidthEdges(label) === "";
}

/** The label a still-owned slot gets stamped with: the row's own (already
 * sanitized, already length-capped — see `sanitizeRowName`/`MAX_ROW_NAME_LEN`
 * above) display name in `"row-name"` mode, or the bare `ZW` sentinel in
 * `"hidden"` mode. Never emits an empty string — falls back to the ZW
 * sentinel rather than a label a user would see as a phantom blank rename,
 * covering the (should-never-happen) case of a row with a blank name.
 *
 * `mode` defaults to the live `SLOT_LABEL_MODE` constant (every real caller
 * — `interaction.mjs`'s `syncSlotLabel` — uses that default); the parameter
 * exists ONLY so a test can exercise `"hidden"`'s behaviour without actually
 * flipping the shipped default (unlike `COMBO_TYPE_STRATEGY`'s sibling
 * `resolveComboOutputType`, which has no such override and is only verified
 * by flipping the constant live — a real workflow can't safely mix per-row
 * label modes, so this parameter is a test seam, not a per-row feature). */
export function defaultSlotLabel(row, mode = SLOT_LABEL_MODE) {
  if (mode === "hidden") {
    return ZW;
  }
  const name = String((row && row.name) || (row && row.kind) || "").trim();
  return name || ZW;
}

// ---------------------------------------------------------------------------
// Auto rows — docs/control-panel-design.md §6
// ---------------------------------------------------------------------------

function sameList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Resolve an `"auto"` row's real kind from the input it was just wired to.
 *
 * @param {object} target - `{ type, name, min, max, step2, value, comboValues }`
 *   describing the CONNECTION TARGET's declared input type and (for a
 *   widget-backed input) the widget behind it. `type` is one of
 *   `"INT"|"FLOAT"|"COMBO"|"LATENT"|"MODEL"|"VAE"|"CLIP"` (case-insensitive).
 * @param {{allowedKinds?: Set<string>, knownLists?: {sampler?: string[], scheduler?: string[]}}} opts
 *   `allowedKinds` restricts which kinds THIS panel may resolve into (the
 *   Control Panel rejects MODEL/VAE/CLIP; the Loader Panel rejects
 *   seed/int/float/sampler/scheduler/latent) — defaults to every Control
 *   Panel kind. `knownLists` is used to match a COMBO target by comparing
 *   its OPTION LIST against `sampler_name`'s/`scheduler`'s (never by input
 *   NAME — `sampler_name` isn't a reliable name across custom node packs).
 * @returns {{kind:string, name?:string, value?:*, opts?:object}|null} the
 *   resolved row fields to merge in (via `applyResolvedKind`), or `null` if
 *   this target can't be resolved (kind stays `"auto"`, e.g. an unrecognized
 *   combo list, or a type this panel doesn't accept at all).
 */
export function resolveAutoKind(target, opts = {}) {
  const allowed = opts.allowedKinds || new Set(CONTROL_CATALOG);
  const t = String((target && target.type) || "").toUpperCase();
  const name = String((target && target.name) || "").toLowerCase();

  if (t === "INT") {
    if ((name === "seed" || name === "noise_seed") && allowed.has("seed")) {
      return {
        kind: "seed",
        name: target.name || "seed",
        value: clampSeedString(target.value),
        opts: { after: "randomize", lastMode: "randomize" },
      };
    }
    if (!allowed.has("int")) {
      return null;
    }
    let step = Number(target.step2);
    if (!Number.isFinite(step) || step <= 0) {
      step = 1;
    }
    step = Math.max(1, Math.round(step));
    let min = Number.isFinite(Number(target.min)) ? Math.round(Number(target.min)) : 0;
    let max = Number.isFinite(Number(target.max)) ? Math.round(Number(target.max)) : 100;
    const cur = Number(target.value);
    const [lo, hi] = usefulRange(min, max, step, cur);
    return {
      kind: "int",
      name: target.name ? String(target.name).replace(/_/g, " ") : "Value",
      value: Number.isFinite(cur) ? Math.round(cur) : Math.round(lo),
      opts: { min: Math.round(lo), max: Math.round(hi), step },
    };
  }

  if (t === "FLOAT") {
    if (!allowed.has("float")) {
      return null;
    }
    let step = Number(target.step2);
    if (!Number.isFinite(step) || step <= 0) {
      step = 0.01;
    }
    const min = Number.isFinite(Number(target.min)) ? Number(target.min) : 0;
    const max = Number.isFinite(Number(target.max)) ? Number(target.max) : 1;
    const cur = Number(target.value);
    const [lo, hi] = usefulRange(min, max, step, cur);
    return {
      kind: "float",
      name: target.name ? String(target.name).replace(/_/g, " ") : "Value",
      value: Number.isFinite(cur) ? Number(cur.toFixed(decimalsOf(step))) : lo,
      opts: { min: lo, max: hi, step },
    };
  }

  if (t === "COMBO") {
    const values = Array.isArray(target.comboValues) ? target.comboValues : [];
    const lists = opts.knownLists || {};
    if (allowed.has("sampler") && sameList(values, lists.sampler)) {
      return { kind: "sampler", name: "sampler name", value: target.value, opts: {} };
    }
    if (allowed.has("scheduler") && sameList(values, lists.scheduler)) {
      return { kind: "scheduler", name: "scheduler", value: target.value, opts: {} };
    }
    // Unrecognized combo list -- stays "auto" (unresolved) rather than
    // guessing; see this function's doc comment.
    return null;
  }

  if (t === "LATENT" && allowed.has("latent")) {
    return { kind: "latent", name: "empty latent", opts: mkRow("latent").opts };
  }

  if (t === "MODEL" || t === "VAE" || t === "CLIP") {
    // MODEL's row kind is "unet" (the loader that PRODUCES a MODEL) -- not
    // a lowercased "model", which isn't a kind in the catalog at all.
    const kind = t === "MODEL" ? "unet" : t.toLowerCase();
    if (!allowed.has(kind)) {
      return null;
    }
    return { kind, name: kind, value: typeof target.value === "string" ? target.value : undefined, opts: mkRow(kind).opts };
  }

  return null;
}

/** Apply a `resolveAutoKind` result to `row` in place. Returns `true` if
 * anything was applied (a truthy `resolved`), `false` otherwise (row stays
 * `"auto"`).
 *
 * `row.renamed` gates the NAME half of the adoption only: an untouched row
 * (the common case -- a fresh "auto" row wired straight to an input) still
 * adopts the target's name, same as ever. But a row the user has already
 * renamed by hand (via the row's Rename menu item / double-click, even
 * while it was still "auto" and unwired) must never have that name
 * silently overwritten the moment it connects -- range/min/max/step/value
 * are still adopted regardless, since those aren't something a user can
 * set by hand at all before the row resolves. */
export function applyResolvedKind(row, resolved) {
  if (!resolved) {
    return false;
  }
  row.kind = resolved.kind;
  if (resolved.name !== undefined && !row.renamed) {
    row.name = resolved.name;
  }
  if (resolved.value !== undefined) {
    row.value = resolved.value;
  }
  row.opts = { ...(resolved.opts || {}) };
  return true;
}

// ---------------------------------------------------------------------------
// Display formatting (pure — render.mjs uses these, no DOM required to test)
// ---------------------------------------------------------------------------

/** `{ main: "832 × 1216", dim: "(2:3) ×4" }` — ratio shown ONLY in
 * Predefined mode (design doc §3a: in Custom mode the numbers are whatever
 * the user typed, so naming a ratio would assert a choice never made). */
export function formatLatentValue(row) {
  const o = row.opts || {};
  const parts = [];
  if (o.mode === "predefined") {
    parts.push(`(${o.ratio})`);
  }
  if (Number(o.batch) > 1) {
    parts.push(`×${o.batch}`);
  }
  return { main: `${o.w} × ${o.h}`, dim: parts.join(" ") };
}

/** The numeric row's display text, decimal places implied by its step.
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

/** 0..100 — how far across its own range the row's current value sits, for
 * the inline slider fill. */
export function numericPercent(row) {
  const [min, max] = rangeOf(row.opts);
  const span = max - min || 1;
  const n = Number(row.value);
  const v = Number.isFinite(n) ? n : min;
  return Math.max(0, Math.min(1, (v - min) / span)) * 100;
}

// ---------------------------------------------------------------------------
// Reading ComfyUI's own node defs (injectable registry -- see index.js,
// which is the only caller that ever passes a REAL `window.LiteGraph.
// registered_node_types`; kept here, not there, so it's testable with a
// fake registry under plain `node`).
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
