/**
 * console_log.mjs — the ONE level-aware console-output helper the Controls
 * track routes every diagnostic line through (task brief, 2026-07-31: "the
 * owner wants search/download activity visible on 'debug' and silent
 * otherwise... reuse `SETTING_IDS.CONSOLE_LOGGING`; do not add a second
 * flag"). Three levels, matching `js/shared/settings.mjs`'s own
 * `CONSOLE_LOGGING` combo exactly: `"off"` (nothing), `"summary"` (one line
 * per user-visible operation), `"debug"` (adds finer-grained detail on top of
 * every `"summary"` line).
 *
 * ## Why this exists rather than five copies of the same check
 *
 * `js/anima/index.js`'s own `logHealedSockets` already gates a `console.info`
 * on this exact setting (`getSetting(SETTING_IDS.CONSOLE_LOGGING, ..., app)
 * === "off"` -- return early otherwise) -- this pack's only prior art for
 * this mechanism, and the reason this module's own gating logic mirrors it
 * rather than inventing a new comparison. That file is OUT OF SCOPE for this
 * change (a `.js` entry point, not a `.mjs`) and is left untouched; this
 * module exists so the FOUR Controls-track surfaces that need the same gate
 * (`civitai_search.mjs`, `civitai_modal.mjs`, `model_info.mjs`,
 * `model_picker.mjs`) share one implementation instead of five near-identical
 * copies of `getSetting(...) === "off"`.
 *
 * ## Every call names its own SURFACE
 *
 * `surface` (the first argument to both functions below) is a short, human
 * label -- `"LoRA search"`, `"Civitai browser"`, `"LoRA info"`, `"LoRA
 * picker"` -- prefixed onto every line as `[AnimaFlow <surface>]`, so a
 * session with the search panel, the info panel and the toolbar browser all
 * open at once (task brief: "make each line identify which surface it came
 * from") stays legible instead of becoming one undifferentiated stream.
 *
 * ## 🔒 Never the API key
 *
 * Neither function here is a place that may EVER receive the Civitai API key
 * — not the value, not a prefix, not a masked form (task brief). Only the
 * existing `public_only` boolean may be surfaced. Nothing in this module
 * enforces that (it has no idea what its caller passes); it is the CALLER's
 * discipline, same as `js/shared/settings.mjs`'s own `CIVITAI_API_KEY`
 * tooltip states for every other consumer of that setting.
 *
 * Relies on `getSetting`'s own `window.app` fallback (no `appRef` parameter
 * here) — every real caller runs in a live browser page, matching this
 * pack's existing convention for reading a user-wide setting from a plain
 * (non-`index.js`) module (`lora_interaction.mjs`'s own
 * `getSetting(SETTING_IDS.HIDE_FILE_EXTENSION, ...)` calls, no third
 * argument, are the precedent). A test stubs `globalThis.window = { app:
 * ... }`, mirroring `test_civitai_modal.mjs`'s own convention.
 */

import { getSetting, SETTING_IDS, SETTING_DEFAULTS } from "./settings.mjs";

const LEVEL_RANK = { off: 0, summary: 1, debug: 2 };

/** The live "Console logging" level, degrading to the setting's own default
 * for anything unreachable/garbage (no live `app`, an unrecognised stored
 * value) -- never throws. Exported for a caller that needs the raw level
 * itself rather than a gated log call (none, today, but this mirrors every
 * other `getSetting`-backed accessor in this pack being independently
 * testable). */
export function consoleLoggingLevel() {
  const level = getSetting(SETTING_IDS.CONSOLE_LOGGING, SETTING_DEFAULTS[SETTING_IDS.CONSOLE_LOGGING]);
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, level) ? level : SETTING_DEFAULTS[SETTING_IDS.CONSOLE_LOGGING];
}

function emit(minLevel, surface, args) {
  if (LEVEL_RANK[consoleLoggingLevel()] < LEVEL_RANK[minLevel]) {
    return;
  }
  const label = surface ? `[AnimaFlow ${surface}]` : "[AnimaFlow]";
  console.log(label, ...args);
}

/**
 * One line per user-visible operation (a search issued and its result count,
 * a download starting/finishing, a lookup's outcome) — printed at BOTH
 * `"summary"` and `"debug"`, silent at `"off"`. `surface` is the short label
 * prefixed onto the line (this module's own top doc comment); every
 * remaining argument is passed straight to `console.log` unchanged.
 */
export function logSummary(surface, ...args) {
  emit("summary", surface, args);
}

/**
 * Finer-grained detail (cache-hit-vs-fetch, the exact filters sent, a
 * version's own selected id) — printed ONLY at `"debug"`. Same `surface`/
 * pass-through-args contract as `logSummary`.
 */
export function logDebug(surface, ...args) {
  emit("debug", surface, args);
}
