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
 *   { version: 1, rows: [ { id, slot, kind, name, value, opts, renamed } ] }
 *
 * `id` is a frontend-only bookkeeping key (never serialized by
 * Python — see `nodes/controls/_rows_helpers.py`'s contract); `slot` is the
 * durable output-index label described below. `rows` is DISPLAY order.
 * `renamed` is a top-level row key (never nested in `opts`) rather than a
 * Python-side concern: `_rows_helpers.py`'s `parse_state` passes each row
 * dict through untouched (it only ever reads specific known keys off it —
 * `kind`/`opts`/`value`/`slot` — never rejects or strips an unrecognized
 * one), so this flag round-trips through a save/load with zero Python
 * changes. See `commitRename`/`applyResolvedKind` below for what sets/reads
 * it.
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
  const row = { id: nextUid(), kind, name: kind, value: undefined, opts: {}, renamed: false };

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
    row.opts = { type: "stable_diffusion", device: "default" };
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
 * (duplicate) — never on reorder. */
export function assignSlot(rows, row) {
  const used = new Set(rows.filter((r) => r !== row && Number.isFinite(r.slot)).map((r) => r.slot));
  let s = 1;
  while (used.has(s)) {
    s += 1;
  }
  row.slot = s;
  return row;
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
  };

  if (kind === "seed") {
    row.value = clampSeedString(row.value);
    const after = AFTER_MODES.includes(row.opts.after) ? row.opts.after : "randomize";
    const lastMode = AFTER_MODES.includes(row.opts.lastMode)
      ? row.opts.lastMode
      : (after === "fixed" ? "randomize" : after);
    row.opts = { after, lastMode };
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
    row.opts = {
      type: CLIP_TYPES.includes(row.opts.type) ? row.opts.type : "stable_diffusion",
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
 * `"COMBO"` (newer ones) — this can only be settled by trying it against a
 * real, live ComfyUI page (docs/control-panel-design.md §5 explicitly warns
 * against guessing this from the schema). Flip this constant during that
 * verification pass; nothing else in this module needs to change.
 *
 * VERIFY-IN-COMFYUI: try `"COMBO"` first (current default); if a wire to a
 * combo input silently refuses, try `"list"`; `"permissive"` always
 * connects but loses the wire-time type guard entirely.
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
 * VERIFY-IN-COMFYUI: `ZW` exists ONLY to stop legacy litegraph painting the
 * output's name/label text on the CANVAS on top of our own opaque DOM row —
 * a real label should never visibly bleed through since our rows are DOM
 * elements layered above the canvas, not painted BY it, but that has only
 * been reasoned through here, not confirmed on a live page. If a real label
 * DOES paint over a row, flip this back to `"hidden"` — same one-constant
 * escape hatch as `COMBO_TYPE_STRATEGY` above.
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

/** The numeric row's display text, decimal places implied by its step. */
export function formatNumericValue(row) {
  const step = row.opts && row.opts.step;
  const n = Number(row.value);
  return Number.isFinite(n) ? n.toFixed(decimalsOf(step)) : "0";
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
 */
export function getComboOptions(registry, className, field) {
  try {
    const nodeData = registry && registry[className] && registry[className].nodeData;
    const required = nodeData && nodeData.input && nodeData.input.required;
    const spec = required && required[field];
    const values = Array.isArray(spec) ? spec[0] : null;
    return Array.isArray(values) ? values.slice() : null;
  } catch {
    return null;
  }
}
