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
// rule at the single-tag granularity: joining multiple
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

// Escapes a literal `(`/`)` in `text` as `\(`/`\)`, UNLESS it's already
// escaped (an odd number of immediately-preceding backslashes) -- so a tag
// arriving pre-escaped (`fate_\(series\)`, as some CSV rows already are)
// isn't double-escaped into `fate \\(series\\)`. Mirrors the reference
// pack's `_escape_literal_parentheses` (ComfyUI-EasyUseAnima/anima_prompt/
// correction.py), minus its wider prompt-syntax context (weight suffixes,
// outer-paren grouping) which doesn't apply to a single freshly-inserted tag.
function escapeLiteralParens(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === ")") {
      let backslashes = 0;
      let cursor = i - 1;
      while (cursor >= 0 && text[cursor] === "\\") {
        backslashes += 1;
        cursor -= 1;
      }
      if (backslashes % 2 === 0) {
        out += "\\";
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Converts a canonical booru tag NAME (as stored in `autocomplete/data/
 * {gelbooru,danbooru}.csv`, e.g. `looking_at_viewer`, `fate_(series)`) into
 * safe, insertable PROMPT TEXT: underscores become spaces (booru tag names
 * use `_` as a word-joiner; trained models -- Anima included -- see the
 * space form), literal parentheses are backslash-escaped (bare `(`/`)` is
 * ComfyUI/A1111 attention-weighting syntax, not literal text), and a
 * leading `@` artist marker (this pack's convention, consumed by
 * `AnimaConditioningEncode`'s `artist_tags`) is preserved rather than
 * space-separated from the rest of the tag.
 *
 * Deliberately does NOT lowercase -- unlike the reference pack's
 * `normalize_tag` (a lookup/dedupe KEY function), this is an INSERTION
 * function: the text it produces lands directly in the user's prompt, so a
 * tag's own casing must survive verbatim.
 *
 * Display (`render.mjs`) and search/matching (the `/wtn/autocomplete` API)
 * both keep operating on the raw canonical tag; this function is used ONLY
 * at the point of committing a completion into the textarea.
 *
 * Pure and DOM-free like the rest of this module. Never throws: null/
 * undefined/non-string input yields `""`.
 */
export function tagToPromptText(tag) {
  if (tag == null) {
    return "";
  }
  let text = String(tag).trim();
  if (!text) {
    return "";
  }
  const hasArtistMarker = text.startsWith("@");
  if (hasArtistMarker) {
    text = text.slice(1);
  }
  text = text.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  text = escapeLiteralParens(text);
  return hasArtistMarker ? "@" + text : text;
}

// Pack ownership gate -- see index.js's top doc comment for the full
// rationale (this used to be a pack-wide, graph-wide extension; it's now
// scoped to AnimaFlow's own nodes only). Every node class in this repo
// declares `CATEGORY = "AnimaFlow/<topic>"` in Python (anima / anima_prompt),
// which ComfyUI surfaces to the frontend as `nodeData.category`
// at `beforeRegisterNodeDef` time and mirrors onto the registered node
// type as `nodeType.category` (so `node.constructor?.category` reads the
// same string off any live instance). Kept here, not in index.js, because
// it's pure string/Set logic with no DOM involved -- testable the same way
// as the rest of this module.
export const OWNED_CATEGORY_PREFIX = "AnimaFlow/";

/** Is `category` (a `nodeData.category` or `node.constructor.category`
 * string) one of ours? Prefix match, not equality -- the two topics
 * (`AnimaFlow/anima`, `AnimaFlow/anima_prompt`) both qualify, and any
 * future topic added under the same prefix is picked up automatically
 * with no code change here.
 */
export function isOwnedCategory(category) {
  return typeof category === "string" && category.startsWith(OWNED_CATEGORY_PREFIX);
}

/**
 * Pure ownership decision for one node, given its resolved `identity`
 * (`{className, category}` -- index.js is responsible for extracting these
 * off a real node instance, since that extraction needs `node.comfyClass`/
 * `node.type`/`node.constructor` duck-typing that's specific to the live
 * litegraph object shape) and the `ownedNames` Set built from
 * `beforeRegisterNodeDef`.
 *
 * PRIMARY signal: `identity.className` is in `ownedNames` -- populated once
 * per node TYPE, at registration, from that type's own `nodeData.category`
 * (see `isOwnedCategory`), so by the time any node of that type is placed
 * on the graph the set already has it.
 *
 * FALLBACK signal: `identity.category` itself passes `isOwnedCategory` --
 * covers the (believed impossible in current ComfyUI, but defensively
 * handled) case where `nodeData.category` was missing/unreadable at
 * `beforeRegisterNodeDef` time so the name never made it into `ownedNames`,
 * by re-checking the same category string live off the node's constructor
 * instead of ever falling back to a hardcoded node-name list.
 */
export function resolveOwnership(identity, ownedNames) {
  const className = identity && identity.className;
  if (className && ownedNames && ownedNames.has(className)) {
    return true;
  }
  return isOwnedCategory(identity && identity.category);
}

// Widget-NAME patterns this attaches to, per the plan: "ends in `_text`,
// `prompt`, `positive`, `negative`" (`template` added too, for any node whose
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
