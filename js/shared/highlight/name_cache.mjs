/**
 * name_cache.mjs — a module-level, tag-NAME-keyed `{section, label}` lookup:
 * the "tier 1" ingredient of the two-tier optimistic/authoritative paint (see
 * `index.js`'s docstring). The idea is adapted, with attribution, from
 * `../ComfyUI-EasyUseAnima/web/js/prompt_studio/highlight_core.js`'s
 * `renderHighlightedText`, which keys the backend's tokens by `tokenKey()`
 * (a normalized tag name, via its own `byBase` map) rather than by offset —
 * so a returning tag recolors instantly from what's already known, and the
 * backend only needs to supply/refresh that knowledge.
 *
 * Deliberately module-level (not per-textarea, not per-node): a user editing
 * the SAME prompt in two panes (positive/negative), or across two node
 * instances, benefits from whichever pane classified a tag first. Bounded
 * (`MAX_ENTRIES`) with simple LRU-ish eviction (`Map` iteration order, most
 * recently touched moved to the end) so a very long session can't grow it
 * without limit.
 */

const MAX_ENTRIES = 4000;

/**
 * Sections whose classification is an intrinsic property of the TAG NAME
 * itself, wherever it recurs -- caching these by name is a safe prediction:
 *  - `quality` / `safety` / `year` / `count` / `character` / `artist` /
 *    `artist_unknown` / `copyright` / `meta` / `general` -- a DB/rule-based
 *    category for a specific tag string, independent of where it sits in
 *    the prompt.
 *  - `natural` -- a run of prose classifies the same way wherever it recurs
 *    (it's "not a tag", not a fact about its position).
 *
 * Deliberately NOT cached here (left for the authoritative pass only):
 *  - `comment` / `syntax` -- depend on surrounding SYNTAX (a `#` starting a
 *    line, a `(tag:1.2)` weight wrapper), not on the tag identity; the same
 *    bare word elsewhere in the prompt is not a comment or a syntax error.
 *  - `wildcard` / `translation` -- depend on a wrapper (`__foo__`, `%{foo}`);
 *    the bare word "foo" typed elsewhere is not a wildcard/translation.
 *  - `unknown` -- not a real classification, just "not resolved yet"; caching
 *    it would freeze a brand-new tag as permanently unknown the instant it's
 *    first seen, before the DB/backend has had a chance to classify it.
 */
export const NAME_CACHEABLE_SECTIONS = new Set([
  "quality",
  "safety",
  "year",
  "count",
  "character",
  "artist",
  "artist_unknown",
  "copyright",
  "meta",
  "general",
  "natural",
]);

const INLINE_SPACE_RE = /[ \t]+/g;
const ESCAPE_RE = /\\(.)/g;

/**
 * Mirrors `autocomplete/classify.py`'s `_normalize` (NFKC normalize, unescape
 * a backslash-escaped character, underscores -> spaces, casefold, collapse
 * inline whitespace, trim) -- the SAME key space, so a name learned from one
 * response reliably matches the next occurrence of that tag however it's
 * spelled/escaped/underscored/spaced.
 */
export function normalizeTagName(value) {
  let text = String(value ?? "");
  text = text.normalize("NFKC");
  text = text.replace(ESCAPE_RE, "$1");
  text = text.replace(/_/g, " ");
  text = text.toLowerCase(); // JS has no native casefold(); toLowerCase() is
  // the standard approximation and matches for the ASCII/CJK tag text this
  // module actually sees.
  text = text.replace(INLINE_SPACE_RE, " ");
  return text.trim();
}

const cache = new Map();

function evictOverflow(maxEntries) {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

/**
 * Records one classify-response token into the cache, keyed on its `base`
 * (falling back to `text` if `base` is missing), IF its section is one of
 * `NAME_CACHEABLE_SECTIONS`. A no-op for a syntax-dependent section, a
 * token with no usable name, or anything malformed -- never throws.
 */
export function rememberToken(token, options = {}) {
  if (!token || typeof token !== "object") {
    return;
  }
  const section = token.section;
  if (!NAME_CACHEABLE_SECTIONS.has(section)) {
    return;
  }
  const raw = token.base || token.text;
  const key = normalizeTagName(raw);
  if (!key) {
    return;
  }
  cache.delete(key); // re-inserting moves it to the end -- most-recently-seen
  cache.set(key, { section, label: typeof token.label === "string" ? token.label : "" });
  evictOverflow(options.maxEntries || MAX_ENTRIES);
}

/** Records every token in `tokens` (an array, e.g. straight from a classify
 * response) -- silently ignores a non-array/empty input. */
export function rememberTokens(tokens, options = {}) {
  if (!Array.isArray(tokens)) {
    return;
  }
  for (const token of tokens) {
    rememberToken(token, options);
  }
}

/** Looks up `rawText` (normalized the same way it was cached) -> `{section,
 * label}`, or `null` if this exact tag name has never been seen. */
export function lookupTagName(rawText) {
  const key = normalizeTagName(rawText);
  if (!key) {
    return null;
  }
  return cache.get(key) || null;
}

/** Current number of distinct cached names -- test/diagnostic hook. */
export function nameCacheSize() {
  return cache.size;
}

/** Empties the cache -- test isolation hook (this module's state is a
 * process-wide singleton, so `test_highlight.mjs` resets it between tests). */
export function clearNameCache() {
  cache.clear();
}
