/**
 * lora_state.mjs — the pure state model for `AnimaLoraLoader` (`docs/
 * lora-loader-design.md` §3). Zero DOM, zero `node`/`app`/`window`/
 * `LiteGraph` reference anywhere in this file — mirrors `js/controls/
 * rows.mjs`'s own split (state/logic pure, `render.mjs` DOM, `interaction.mjs`
 * event wiring) so this module stays importable, and testable, under plain
 * `node` with no ComfyUI installed.
 *
 * ## Why this is a SEPARATE file from `rows.mjs`, not an extension of it
 *
 * `rows.mjs` is the Control Panel / Loader Panel's row model, and it is
 * shaped entirely around **socket-per-row** bookkeeping this node doesn't
 * have (`slot`, `assignSlot`, `outputTypeForRow`, hole compaction — design
 * doc §5: "this is NOT a layer-3 socket-rows consumer"). Folding LoRA rows
 * into that file would mean every LoRA row silently carries fields that
 * mean nothing here, and every future edit to `rows.mjs` risks touching a
 * consumer it was never designed for. The ONE thing genuinely shared is the
 * pure array-move helper, `reorderRows` (`rows.mjs:859`) — `lora_interaction
 * .mjs` imports that directly rather than this file re-exporting it, so
 * there is exactly one array-move implementation in this pack, not two.
 *
 * ## State shape (design doc §3, "adopted as-is"; the last three top-level
 * fields are Slice 5's ⚙ dialog, §7b's PER-NODE half of the split -- the
 * other half, hide-extension/Civitai/show-thumbnails, is USER-WIDE and lives
 * in `../shared/settings.mjs` instead, never here)
 *
 *   {
 *     version: 1,
 *     rows: [ { id, name, on, sm, sc, triggers: [], customTriggers: [] }, ... ],
 *     cacheMode: "last" | "all" | "none",   // §7b "LoRA memory use"
 *     sep: ", ",                            // §7b "Trigger words separator"
 *     sepStrengths: false,                  // §7b "Show two strengths per row"
 *     defaultStrength: 0.8,                 // §7b "Default strength (new LoRAs)"
 *     strengthStep: 0.05,                   // §7b "Strength step (arrows)"
 *   }
 *
 * `sm`/`sc` are the model/clip strengths. Whether a row shows/edits them as
 * ONE shared control or TWO independent ones is `sepStrengths` (Slice 5's
 * "Show two strengths per row"): `bumpRowStrength` below keeps the two
 * fields in lockstep while it's `false` (the default -- one control drives
 * both), and lets them diverge, one field at a time, once it's `true`. This
 * is why the fields have always existed side by side even before the toggle
 * did: there was never anything to invent retroactively, only a UI gate to
 * add.
 *
 * `triggers` (Python-facing, §1b: "only these ... reach the triggers
 * output") is the row's CURRENTLY SELECTED words — candidates and custom
 * words alike, whichever the ⓘ panel's chips currently show ticked.
 * `customTriggers` (Slice 4, `model_info.mjs`'s ⓘ panel) is the SEPARATE,
 * always-additive list of every word the user has ever typed into "add your
 * own" for this row, selected or not — it exists because deselecting a
 * custom chip must only untick it, never forget it (design doc §1a-i item
 * 1: "you may delete what you wrote" via its own ✕, which is a DIFFERENT
 * action from merely toggling it off); `triggers` alone can't carry that,
 * since it holds only the currently-selected subset. Python never reads
 * `customTriggers` — `_lora_helpers.py`'s `row_triggers` only ever looks at
 * `triggers` — so this is purely a frontend-side memory, kept in the same
 * additive/tolerant blob for the same reason every other row field is.
 *
 * ## Normalization contract — tolerant AND additive (design doc §3, §10)
 *
 * "Tolerant" = a hostile/garbage blob (`null`, `42`, a bare array, a string,
 * `{rows: "nope"}`, a row that's `null`/a number/an array) degrades to sane
 * defaults and NEVER throws. "Additive" = unknown keys — at both the
 * top-level and per-row — survive a normalize round-trip unchanged, so a
 * NEWER frontend build's field isn't silently dropped by an OLDER one just
 * because this file doesn't know about it yet (the same forward-compatible
 * contract `nodes/controls/_rows_helpers.py`'s `parse_state` states for the
 * Python side). This is why `normalizeRow`/`normalizeState` both spread the
 * raw object FIRST and only then overwrite the fields they actually
 * understand — a whitelist-style rebuild (what `rows.mjs`'s own
 * `normalizeRow` does, deliberately, for ITS shape) would drop anything it
 * doesn't recognize, which is the opposite of what this state blob needs.
 */

// ---------------------------------------------------------------------------
// Row id allocation — frontend-only bookkeeping, independent of rows.mjs's
// own `nextUid` counter (two separate node types, two separate id spaces;
// nothing ever compares a LoRA row's id against a Control/Loader Panel
// row's id, so sharing a counter would buy nothing and would couple two
// otherwise-independent modules for no reason).
// ---------------------------------------------------------------------------

let _uid = 0;
/** Frontend-only row id, unique for this page session. Exported so tests can
 * observe/reset it deterministically if ever needed (mirrors `rows.mjs`'s
 * own `nextUid`). */
export function nextUid() {
  _uid += 1;
  return _uid;
}

// ---------------------------------------------------------------------------
// Strength — default/step/range (§7b: "Default strength", "Strength step").
// The ⚙ dialog that would make these user-configurable is a Slice 5
// placeholder this slice (see `lora_render.mjs`'s header) — these constants
// are what a fresh row and the ▲▼ steppers use until then.
// ---------------------------------------------------------------------------

export const DEFAULT_STRENGTH = 0.8;
export const STRENGTH_STEP = 0.05;
export const STRENGTH_MIN = -10;
export const STRENGTH_MAX = 10;

// The ⚙ dialog's own "Strength step (arrows)" field (§7b) is itself a
// number the user edits -- clamp IT to a sane range too, so a hand-edited
// `0` (a step that would make the arrows do nothing, forever) or a
// hostile `1e308` never reaches `bumpRowStrength`. `0.01` is the smallest
// step worth having (the ▲▼ arrows would otherwise never visibly move
// `clampStrength`'s own 2-decimal display); `1` was picked when the range
// was `[0, 2]` on the reasoning "the whole usable range in one bump" --
// that reasoning no longer holds now that the range is `[-10, 10]`
// (owner decision, 2026-07-30, see `STRENGTH_MIN`/`STRENGTH_MAX` above),
// but `1` is still a perfectly usable single-bump step, so it is left as
// a recommendation for the owner to revisit rather than changed here.
export const STRENGTH_STEP_MIN = 0.01;
export const STRENGTH_STEP_MAX = 1;

// §7b "LoRA memory use": human labels over the raw keys Python's
// `_lora_helpers.py` actually reads (`cec90cd`'s display-name-map
// precedent -- the UI says "Standard", the state stores "last"). Order here
// is the ⚙ dialog's own segmented-button order (mockup: Standard/Fast/Lowest).
export const CACHE_MODE_ORDER = ["last", "all", "none"];
export const CACHE_MODE_LABELS = { last: "Standard", all: "Fast", none: "Lowest" };

/** Clamp to `[STRENGTH_MIN, STRENGTH_MAX]` and round to 2 decimals — the
 * round-off guards against float drift from repeated `+= STRENGTH_STEP`
 * bumps (`0.1 + 0.2 !== 0.3`-class error), same reasoning `rows.mjs`'s own
 * `clampNumeric` documents for its own stepper. */
export function clampStrength(value) {
  const n = Number.isFinite(value) ? value : DEFAULT_STRENGTH;
  const clamped = Math.max(STRENGTH_MIN, Math.min(STRENGTH_MAX, n));
  return Math.round(clamped * 100) / 100;
}

// Range widened 2026-07-30 (owner decision): `STRENGTH_MIN`/`STRENGTH_MAX`
// were `[0, 2]` (inherited wholesale from upstream Pixaroma, no
// negative-weight use case considered) until the owner reported that range
// as wrong on two counts -- some LoRAs legitimately want strengths beyond
// `2`, and applying a LoRA at a negative strength (e.g. `-5`) is a real,
// intentional use, not an error. The range is now `[-10, 10]`. Typed input
// clamps through this SAME range, unchanged.

/** Parses a user-TYPED strength string (BUG 17's editable strength field)
 * into a finite `number`, or `null` for anything that isn't genuinely one --
 * empty/whitespace-only, `"abc"`, `"--1"`, `"1e999"` (a real number token
 * that OVERFLOWS to `Infinity`), `"NaN"` (the literal three-letter string),
 * a pasted newline/multi-line blob. Deliberately stricter than a bare
 * `Number(...)` call: `Number("")` is `0`, a real number that would let an
 * emptied field silently commit as zero rather than being treated as
 * "nothing usable was typed" -- reverting to the row's own current value on
 * a `null` here is `lora_interaction.mjs`'s job, not this function's.
 * Never clamps or rounds -- that stays `clampStrength`'s ONE job, so a
 * typed value and an arrow-bumped value are guaranteed to land on IDENTICAL
 * stored numbers (both eventually pass through the exact same function). */
export function parseTypedStrength(text) {
  if (typeof text !== "string") {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Clamp/round a "Strength step (arrows)" value into
 * `[STRENGTH_STEP_MIN, STRENGTH_STEP_MAX]` -- same rounding reasoning as
 * `clampStrength` above. Non-finite, zero, or negative input falls back to
 * `STRENGTH_STEP` (a step of 0 or less would make the ▲▼ arrows do nothing,
 * or go backwards while labelled "increase"). */
export function clampStrengthStep(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return STRENGTH_STEP;
  }
  const clamped = Math.max(STRENGTH_STEP_MIN, Math.min(STRENGTH_STEP_MAX, n));
  return Math.round(clamped * 100) / 100;
}

export const CACHE_MODES = new Set(["last", "all", "none"]);
export const DEFAULT_CACHE_MODE = "last";
export const DEFAULT_SEP = ", ";
export const DEFAULT_SEP_STRENGTHS = false;

// ---------------------------------------------------------------------------
// Row construction
// ---------------------------------------------------------------------------

/** A fresh row — `on: true` by default (a newly added LoRA should actually
 * apply; the master switch / counter read it immediately). `overrides` is
 * spread in AFTER the defaults but BEFORE `id` is (re)assigned, so a caller
 * can override `name`/`sm`/`sc`/`triggers`/`on` but can never make two rows
 * share an id — `id` is the one thing every lookup in `lora_interaction.mjs`
 * keys off, so it is always freshly allocated here, never inherited from
 * `overrides`. */
function cleanStringArray(value) {
  return Array.isArray(value) ? value.filter((t) => typeof t === "string") : [];
}

function buildRow(overrides = {}) {
  const sm = Number.isFinite(overrides.sm) ? clampStrength(overrides.sm) : DEFAULT_STRENGTH;
  const sc = Number.isFinite(overrides.sc) ? clampStrength(overrides.sc) : sm;
  return {
    ...overrides,
    id: nextUid(),
    name: typeof overrides.name === "string" ? overrides.name : "",
    on: overrides.on !== false,
    sm,
    sc,
    triggers: cleanStringArray(overrides.triggers),
    customTriggers: cleanStringArray(overrides.customTriggers),
  };
}

export { buildRow as mkRow };

/** `{version, rows: [], cacheMode: "last", sep: ", "}` — an empty LoRA
 * stack, unlike the Loader Panel's `defaultState` (`rows.mjs:643`), has
 * nothing useful to pre-populate (design doc §4a: this is a list the user
 * builds, not three fixed loader slots), so there is no "brand new vs
 * deliberately emptied" ambiguity to resolve here the way `interaction.mjs`'s
 * `resolveState` needs for the Loader Panel — both cases are legitimately
 * `rows: []`. */
export function defaultState() {
  return {
    version: 1,
    rows: [],
    cacheMode: DEFAULT_CACHE_MODE,
    sep: DEFAULT_SEP,
    sepStrengths: DEFAULT_SEP_STRENGTHS,
    defaultStrength: DEFAULT_STRENGTH,
    strengthStep: STRENGTH_STEP,
  };
}

// ---------------------------------------------------------------------------
// Normalization — see this file's top doc comment ("tolerant AND additive").
// ---------------------------------------------------------------------------

function normalizeTriggers(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out = [];
  for (const t of raw) {
    if (typeof t !== "string") {
      continue;
    }
    const trimmed = t.trim();
    if (trimmed) {
      out.push(trimmed);
    }
  }
  return out;
}

// `customTriggers` is normalized IDENTICALLY to `triggers` (same shape: a
// list of trimmed, non-empty strings) -- see this file's top doc comment for
// why it's a separate field rather than a flag on `triggers` entries.
const normalizeCustomTriggers = normalizeTriggers;

/** One row, hostile input tolerated: `raw` may be `null`/a number/an array/
 * anything — never assumed to already be a well-shaped object. Unknown keys
 * survive (`...safe` spread first); every field this module actually reads
 * elsewhere gets a defensive, always-valid value written back on top. */
export function normalizeRow(raw) {
  const safe = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const sm = clampStrength(safe.sm);
  // `sc` defaults to the (already-clamped) `sm`, not `DEFAULT_STRENGTH` --
  // a row saved before separate strengths existed (or one that never used
  // them) should read as "both strengths are this one number", not silently
  // reset its clip strength to the pack default out from under `sm`.
  const sc = Number.isFinite(safe.sc) ? clampStrength(safe.sc) : sm;
  return {
    ...safe,
    id: nextUid(),
    name: typeof safe.name === "string" ? safe.name : "",
    on: safe.on !== false,
    sm,
    sc,
    triggers: normalizeTriggers(safe.triggers),
    customTriggers: normalizeCustomTriggers(safe.customTriggers),
  };
}

/** Whether `raw` (the parsed widget JSON, or garbage) already carries an
 * explicit `rows` ARRAY — mirrors `interaction.mjs`'s identically-named
 * helper for the Control/Loader Panels. Exported mainly so
 * `lora_interaction.mjs`'s `ensureState`/`restoreStateFromWidget` can decide
 * whether the materialized default needs writing back to the widget (the
 * dynamic-node-frontend skill's "declaring the widget is not writing it"
 * trap) without re-deriving this check. */
export function hasSavedRows(raw) {
  return !!(raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.rows));
}

/** The full state blob, hostile input tolerated. Never throws: a non-object
 * `raw` (including `null`/a number/a string/a bare array) degrades to `{}`
 * before anything else runs. */
export function normalizeState(raw) {
  const base = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rowsIn = Array.isArray(base.rows) ? base.rows : [];
  const rows = rowsIn
    // A row that isn't itself a plain object (a `null`, a number, a bare
    // array slipped into `rows`) is dropped rather than coerced -- there is
    // no sane "default" for a row with literally no data at all, and
    // `normalizeRow` would otherwise manufacture a same-shaped row for every
    // piece of garbage in the array, silently multiplying junk into
    // legitimate-looking rows.
    .filter((r) => r && typeof r === "object" && !Array.isArray(r))
    .map((r) => normalizeRow(r));
  const cacheMode = CACHE_MODES.has(base.cacheMode) ? base.cacheMode : DEFAULT_CACHE_MODE;
  const sep = typeof base.sep === "string" ? base.sep : DEFAULT_SEP;
  // `sepStrengths` -- only a REAL boolean `true` opts in (matches `row.on`'s
  // own "truthy-but-not-boolean does NOT spoof" convention, above); anything
  // else (missing, a string, a number) degrades to the single-control default.
  const sepStrengths = base.sepStrengths === true;
  const defaultStrength = clampStrength(base.defaultStrength);
  const strengthStep = clampStrengthStep(base.strengthStep);
  return { ...base, version: 1, rows, cacheMode, sep, sepStrengths, defaultStrength, strengthStep };
}

// ---------------------------------------------------------------------------
// Mutations — mutate `state.rows` IN PLACE and return the changed row/bool,
// mirroring `rows.mjs`'s own `addRow`/`duplicateRow`/`removeRow` convention
// (`interaction.mjs`'s callers already expect "mutate then persist", not an
// immutable-update style) so `lora_interaction.mjs` reads the same as its
// sibling.
// ---------------------------------------------------------------------------

/** Push a fresh row (defaults only — the caller supplies nothing, since
 * "add" always starts from a blank/unpicked LoRA per the mockup's "(pick a
 * LoRA)" placeholder; the picker, Slice 3, is what actually names it).
 * Starts at `state.defaultStrength` (§7b "Default strength (new LoRAs)",
 * Slice 5) rather than the hardcoded `DEFAULT_STRENGTH` -- falls back to it
 * when `state` predates the field (a workflow saved by an older build). */
export function addRow(state) {
  const dflt = Number.isFinite(state && state.defaultStrength) ? state.defaultStrength : DEFAULT_STRENGTH;
  const row = buildRow({ sm: dflt, sc: dflt });
  state.rows.push(row);
  return row;
}

/** Insert a copy of the row with id `rowId` immediately after it. Returns
 * the new row, or `null` if not found. The copy gets a FRESH id (never the
 * original's) -- two rows must never share one, `id` is the only thing every
 * lookup in `lora_interaction.mjs` keys off. */
export function duplicateRow(state, rowId) {
  const idx = state.rows.findIndex((r) => r.id === rowId);
  if (idx < 0) {
    return null;
  }
  const copy = {
    ...state.rows[idx],
    id: nextUid(),
    triggers: state.rows[idx].triggers.slice(),
    customTriggers: state.rows[idx].customTriggers.slice(),
  };
  state.rows.splice(idx + 1, 0, copy);
  return copy;
}

/** Remove the row with id `rowId`. Returns whether anything was actually
 * removed. */
export function removeRow(state, rowId) {
  const idx = state.rows.findIndex((r) => r.id === rowId);
  if (idx < 0) {
    return false;
  }
  state.rows.splice(idx, 1);
  return true;
}

/** Flip a single row's `on` flag to `on` (coerced to a real boolean).
 * Returns whether the row was found. */
export function setRowOn(state, rowId, on) {
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return false;
  }
  row.on = !!on;
  return true;
}

/**
 * Bumps a row's strength by `delta` and clamps. `field` (`"sm"` or `"sc"`,
 * default `"sm"`) selects WHICH field the caller means -- but it only
 * actually matters when `state.sepStrengths` is `true` (§7b "Show two
 * strengths per row", Slice 5): with it `false` (the default), `sm`/`sc`
 * stay in LOCKSTEP regardless of which one `field` names, exactly this
 * function's pre-Slice-5 behaviour (a single stepper drives both, so a
 * caller that never passes `field` at all -- every pre-Slice-5 call site --
 * is unaffected). With it `true`, only the named field moves, letting the
 * two diverge one bump at a time. Returns whether the row was found.
 */
export function bumpRowStrength(state, rowId, delta, field = "sm") {
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return false;
  }
  const key = field === "sc" ? "sc" : "sm";
  if (state && state.sepStrengths) {
    row[key] = clampStrength(row[key] + delta);
    return true;
  }
  const next = clampStrength(row.sm + delta);
  row.sm = next;
  row.sc = next;
  return true;
}

/** BUG 17's typed-strength counterpart to `bumpRowStrength` above -- SAME
 * lockstep rule (both fields move together while `sepStrengths` is off;
 * only `field` moves once it's on), reusing it rather than re-deriving a
 * second copy, so a typed value and an arrow-bumped value are guaranteed to
 * land on the identical stored number. `value` is clamped/rounded through
 * the SAME `clampStrength` every other strength write already goes
 * through. Returns `false` (and mutates nothing) if `rowId` doesn't
 * resolve to a real row, matching `bumpRowStrength`'s own contract. */
export function setRowStrength(state, rowId, field, value) {
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return false;
  }
  const key = field === "sc" ? "sc" : "sm";
  const clamped = clampStrength(value);
  if (state && state.sepStrengths) {
    row[key] = clamped;
    return true;
  }
  row.sm = clamped;
  row.sc = clamped;
  return true;
}

// ---------------------------------------------------------------------------
// ⚙ dialog setters (§7b, Slice 5) -- one pure mutator per per-node field,
// mirroring the "mutate in place, caller persists" convention every other
// mutation above already follows. The THREE user-wide fields (hide
// extension / Civitai / show thumbnails) have NO setter here at all -- they
// never touch this state blob; `lora_interaction.mjs`'s `openLoraSettings`
// writes those straight through `../shared/settings.mjs`'s `setSetting`.
// ---------------------------------------------------------------------------

/** §7b "Show two strengths per row". */
export function setSepStrengths(state, on) {
  state.sepStrengths = !!on;
}

/** §7b "LoRA memory use" -- an invalid mode falls back to the default,
 * exactly `normalizeState`'s own tolerance for the same field. */
export function setCacheMode(state, mode) {
  state.cacheMode = CACHE_MODES.has(mode) ? mode : DEFAULT_CACHE_MODE;
}

/** §7b "Trigger words separator" -- anything non-string falls back to the
 * default rather than storing garbage (an empty string IS a valid,
 * deliberate choice -- "no separator" -- and survives unchanged). */
export function setSep(state, sep) {
  state.sep = typeof sep === "string" ? sep : DEFAULT_SEP;
}

/** §7b "Default strength (new LoRAs)". */
export function setDefaultStrength(state, value) {
  state.defaultStrength = clampStrength(value);
}

/** §7b "Strength step (arrows)". */
export function setStrengthStep(state, value) {
  state.strengthStep = clampStrengthStep(value);
}

// ---------------------------------------------------------------------------
// Master switch / counter — design doc §1a-ii, decision 13.
// ---------------------------------------------------------------------------

/** `true` iff there is at least one row AND every row is on -- an EMPTY
 * stack is never "all on" (there is nothing to be on), which matters
 * because `toggleMaster` below reads this to decide which way to flip. */
export function allRowsOn(rows) {
  return rows.length > 0 && rows.every((r) => r.on);
}

/** `[onCount, total]`, exactly what the header's `N/M` counter renders
 * (design doc: "no 'on' word... the switch already says what the number is
 * about"). */
export function onCounts(rows) {
  return [rows.filter((r) => r.on).length, rows.length];
}

/**
 * The header master switch's own tri-state click rule (decision 13,
 * verbatim): mixed OR all-off -> turn EVERYTHING on (the action you almost
 * always want); only when everything is ALREADY on does a click turn
 * everything off. An empty stack is treated as "not all on" (nothing to
 * turn off), so clicking it is a harmless no-op rather than an error.
 * Mutates every row's `on` in place; returns the new `allRowsOn` value.
 */
export function toggleMaster(state) {
  const turnOn = !allRowsOn(state.rows);
  for (const row of state.rows) {
    row.on = turnOn;
  }
  return allRowsOn(state.rows);
}
