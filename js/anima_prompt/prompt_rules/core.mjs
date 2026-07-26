/**
 * core.mjs — pure, DOM-free logic for the Prompt Rules node's themed UI.
 *
 * Companion to `render.mjs` (DOM building/CSS/resize) and `interaction.mjs`
 * (event wiring + native-widget two-way sync); this module only ever
 * transforms plain values, so it's importable/testable under plain `node`
 * (mirrors `js/anima_prompt/anima_prompt_studio/core.mjs`'s split).
 */

/**
 * Read a combo widget's CURRENT option list at runtime — deliberately never
 * hardcodes `PROFILE_CHOICES` here (the actual source of truth is
 * `nodes/anima_prompt/_rules_helpers.py`; this file must not import it, or even
 * know its name, so the selector can never drift out of sync with whatever
 * list the backend combo widget was actually built with). Tolerant of every
 * shape a ComfyUI combo widget's `options.values` shows up in: a plain
 * array (the common case), a callable `() => array` (some dynamic combos
 * use this), or entirely missing/malformed — all of which yield `[]` rather
 * than throwing, so a not-yet-fully-initialized widget never crashes the
 * selector build.
 */
export function readProfileValues(widget) {
  const opts = widget && widget.options;
  let values = opts && opts.values;
  if (typeof values === "function") {
    try {
      values = values();
    } catch {
      values = null;
    }
  }
  return Array.isArray(values) ? values.slice() : [];
}

/**
 * Parse the `embedded_rules` widget's current STRING value into a Ruleset
 * object for `openRuleBuilder`'s `ctx.embedded` — mirrors the previous
 * `js/anima_prompt/prompt_rules/index.js`'s inline `parseEmbedded(widget)` exactly,
 * just taking the raw string directly (so it's testable without a fake
 * widget object). `{}` (nothing embedded yet) on an empty value or any
 * parse failure — a corrupt/hand-edited widget value must never crash the
 * "Open Rule Builder" button, just open empty.
 */
export function parseEmbedded(raw) {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Normalize a possibly-missing/null `sheets` widget value to a string for
 * the DOM field — mirrors `nodes/anima_prompt/prompt_rules.py`'s
 * `_shared_required()`'s `"sheets": ("STRING", {"default": "*"})`. An
 * explicit empty string is preserved verbatim (per `_rules_helpers.py`'s
 * `resolve_sheet_selection` doc comment: `""` means "no file sheets",
 * distinct from `"*"`/`None` meaning "all sheets") — only `null`/`undefined`
 * (a widget that somehow has no value at all yet) falls back to `"*"`.
 */
export function normalizeSheetsValue(value) {
  return value == null ? "*" : String(value);
}
