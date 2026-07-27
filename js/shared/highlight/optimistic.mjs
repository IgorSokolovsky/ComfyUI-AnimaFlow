/**
 * optimistic.mjs — the client-side "tier 1" paint: an approximate,
 * synchronous tag split (never re-implementing `src/autocomplete/classify.py`'s
 * real classifier — see the module docstring below for why that's fine)
 * consulted against `name_cache.mjs`'s cache so a returning tag recolors
 * INSTANTLY, on every keystroke, with no network round-trip.
 *
 * `buildOptimisticSpans(text)` returns spans in the exact shape
 * `classify.mjs`'s `buildSpans` produces (`{start, end, text, section,
 * label, known, weighted, count, gap}`), so `overlay.mjs`'s
 * `renderMirrorHtml` can paint either's output identically -- `index.js`'s
 * two-tier paint just picks which builder to call.
 *
 * The splitter only needs to be APPROXIMATELY right: comma / newline /
 * full-width-comma delimited, paren-aware enough not to split inside a
 * weighted group like `(a, b:1.2)`. It never has to agree perfectly with the
 * backend -- a wrong guess here is corrected within one debounce cycle by
 * the authoritative `/wtn/classify` pass (`index.js`'s `paintColored`).
 * Keeping it this small, rather than porting `classify.py`'s real tokenizer,
 * is deliberate: precision belongs to the one classifier that owns the DB;
 * this only needs to be right often enough that recoloring a tag the user
 * is just re-typing doesn't visibly flicker.
 */

import { lookupTagName } from "./name_cache.mjs";

const FULLWIDTH_COMMA = "，";

function isDelimiterChar(ch) {
  return ch === "," || ch === "\n" || ch === FULLWIDTH_COMMA;
}

/**
 * Splits `text` into an ordered list of `{start, end, text, delimiter}`
 * segments: single-character delimiter segments (comma / newline /
 * full-width comma) and the tag-body runs between them. Tracks ROUND-PAREN
 * depth only (not brackets) so a delimiter inside a weighted group like
 * `(a, b:1.2)` doesn't split it -- exactly the one case the plan calls out;
 * anything else exotic (nested wildcard/artist-mix syntax) is left for the
 * authoritative pass to sort out.
 */
export function splitApproxTagSpans(text) {
  const value = String(text ?? "");
  const spans = [];
  let depth = 0;
  let tokenStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && isDelimiterChar(ch)) {
      spans.push({ start: tokenStart, end: index, text: value.slice(tokenStart, index), delimiter: false });
      spans.push({ start: index, end: index + 1, text: ch, delimiter: true });
      tokenStart = index + 1;
    }
  }
  spans.push({ start: tokenStart, end: value.length, text: value.slice(tokenStart), delimiter: false });
  return spans;
}

const WEIGHTED_WRAPPER_RE = /^\((.*):[+-]?(?:\d+(?:\.\d*)?|\.\d+)\)$/s;

/** Strips a `(tag:1.2)` weight wrapper and a trailing bare `:` off a tag
 * body, for the cache LOOKUP key only (mirrors the shape of
 * `classify.py`'s/the reference's `tokenBase`, trimmed to just what the
 * optimistic pass needs -- it never has to parse escapes or `@artist`
 * markers, since those still resolve fine through `normalizeTagName`).
 */
export function approxTagBase(text) {
  let value = String(text ?? "").trim();
  const match = WEIGHTED_WRAPPER_RE.exec(value);
  if (match) {
    value = match[1].trim();
  }
  value = value.replace(/:+$/, "").trim();
  return value;
}

function plainSpan(start, end, text) {
  return { start, end, text, section: null, label: "", known: true, weighted: false, count: 0, gap: true };
}

/**
 * Builds paintable spans for `text` PURELY from the client-side split above
 * plus `name_cache.mjs`'s lookup -- no network, no debounce, safe to call on
 * every keystroke. A tag body whose normalized base isn't in the cache
 * degrades to a plain (uncolored) span, same as the old `paintPlain()`
 * behavior -- this is why replacing that call with this one is safe even
 * before the cache has ever been populated (e.g. right after a page load):
 * everything is simply plain until the first real classify response lands
 * and starts teaching the cache.
 */
export function buildOptimisticSpans(text) {
  const value = String(text ?? "");
  const rawSpans = splitApproxTagSpans(value);
  const spans = [];
  for (const raw of rawSpans) {
    if (!raw.text) {
      continue; // e.g. two delimiters back-to-back -- nothing to paint
    }
    if (raw.delimiter) {
      spans.push(plainSpan(raw.start, raw.end, raw.text));
      continue;
    }
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw.text);
    const leading = match?.[1] || "";
    const body = match?.[2] || "";
    const trailing = match?.[3] || "";
    let cursor = raw.start;
    if (leading) {
      spans.push(plainSpan(cursor, cursor + leading.length, leading));
      cursor += leading.length;
    }
    if (body) {
      const known = lookupTagName(approxTagBase(body));
      if (known) {
        spans.push({
          start: cursor,
          end: cursor + body.length,
          text: body,
          section: known.section,
          label: known.label,
          known: true,
          weighted: false,
          count: 0,
          gap: false,
        });
      } else {
        spans.push(plainSpan(cursor, cursor + body.length, body));
      }
      cursor += body.length;
    }
    if (trailing) {
      spans.push(plainSpan(cursor, cursor + trailing.length, trailing));
    }
  }
  if (!spans.length && value.length) {
    spans.push(plainSpan(0, value.length, value));
  }
  return spans;
}
