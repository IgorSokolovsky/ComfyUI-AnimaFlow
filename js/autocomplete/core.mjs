/**
 * core.mjs — pure logic for the generic tag-autocomplete popup. No DOM
 * access here at all (a plain-string in/out module, unlike `render.mjs`
 * and `interaction.mjs`), so the token-parsing/eligibility/commit rules can
 * be reasoned about (and, if this repo ever grows a JS test runner,
 * unit-tested) independent of any real textarea.
 */

// Tokens are separated by comma or newline -- deliberately NOT space, so a
// booru tag's own underscores (`long_hair`) and a prose field's multi-word
// phrase both stay one token. This mirrors the repo's separator-agnostic
// rule (CLAUDE.md) at the single-tag granularity: joining multiple
// tags/fields is configurable elsewhere, but a comma/newline is universally
// "the next thing" in both a tag list and a prose sentence list.
const DELIMITERS = /[\n,]/;

/**
 * The token the caret sits inside, given the control's full `text` and a
 * 0-based `caretPos` (`el.selectionStart`). Returns `{query, start, end}`:
 * `start`/`end` are the token's character offsets in `text` (the
 * replaceable range for `commitToken`), `query` is the text from the
 * token's start up to the caret (what the user has typed so far, used to
 * search) with any leading separator whitespace excluded.
 */
export function currentToken(text, caretPos) {
  const value = String(text || "");
  const pos = Math.max(0, Math.min(caretPos == null ? value.length : caretPos, value.length));

  let start = pos;
  while (start > 0 && !DELIMITERS.test(value[start - 1])) {
    start -= 1;
  }
  let end = pos;
  while (end < value.length && !DELIMITERS.test(value[end])) {
    end += 1;
  }

  // Skip leading whitespace right after the delimiter (", solo" -> the
  // replaceable range is just "solo") so committing a replacement doesn't
  // eat the separator's own space.
  while (start < pos && /\s/.test(value[start])) {
    start += 1;
  }

  return { query: value.slice(start, pos), start, end };
}

/**
 * Splice `replacement` into `text` over `[start, end)`. Adds `trailing`
 * (default `", "`) after the replacement UNLESS the very next character is
 * already a delimiter (comma/newline) -- avoids doubling separators when
 * the token being replaced wasn't the last one in the field. Returns
 * `{text, caretPos}` for the caller to apply to the real control.
 */
export function commitToken(text, start, end, replacement, trailing = ", ") {
  const value = String(text || "");
  const before = value.slice(0, start);
  const after = value.slice(end);
  const alreadySeparated = DELIMITERS.test(after.slice(0, 1));
  const insert = String(replacement || "") + (alreadySeparated ? "" : trailing);
  return { text: before + insert + after, caretPos: before.length + insert.length };
}

/** Debounce: `fn` only actually runs `wait` ms after the last call. The
 * returned wrapper's `.cancel()` clears any pending call (used on blur).
 */
export function debounce(fn, wait) {
  let handle = null;
  function wrapped(...args) {
    if (handle) {
      clearTimeout(handle);
    }
    handle = setTimeout(() => {
      handle = null;
      fn(...args);
    }, wait);
  }
  wrapped.cancel = () => {
    if (handle) {
      clearTimeout(handle);
      handle = null;
    }
  };
  return wrapped;
}

// Widget-NAME patterns this attaches to, per the plan: "ends in `_text`,
// `prompt`, `positive`, `negative`" (`template` added too -- PromptBuilder's
// own field is literally named that). This is intentionally loose/generic:
// any node in this pack (or, incidentally, any other pack sharing the
// canvas) with a widget named like this gets autocomplete for free.
const NAME_PATTERNS = [/_text$/i, /prompt/i, /positive/i, /negative/i, /template/i];

export function widgetNameMatches(name) {
  return NAME_PATTERNS.some((re) => re.test(String(name || "")));
}

/**
 * Should this ComfyUI widget get autocomplete attached? True if its name
 * matches `NAME_PATTERNS` (any control type), OR if its live DOM control is
 * a `<textarea>` (i.e. "any multiline STRING widget", per the plan --
 * these are the free-text prompt/description fields regardless of what
 * their author happened to name them). A plain single-line `<input>` only
 * qualifies via the name match, so unrelated numeric/seed-ish fields that
 * happen to render as a text input aren't accidentally targeted.
 */
export function isEligibleWidget(widget) {
  if (!widget) {
    return false;
  }
  const el = widget.inputEl;
  const tag = el && el.tagName ? el.tagName.toLowerCase() : null;
  if (tag === "textarea") {
    return true;
  }
  return widgetNameMatches(widget.name);
}
