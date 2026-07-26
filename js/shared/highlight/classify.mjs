/**
 * classify.mjs — pure token math (`buildSpans`) plus the debounced /
 * cached / last-write-wins fetch wrapper (`createClassifier`) that calls
 * `POST /wtn/classify`. No DOM here — that's `overlay.mjs`'s job — so this
 * file is trivially unit-testable under plain `node`.
 *
 * Contract (a concurrent agent owns the backend for this exact shape):
 *   POST /wtn/classify {"text": "<full prompt>", "limit": 500}
 *   -> {"tokens": [{start, end, text, base, section, label, known,
 *                    weighted, count}, …]}
 *   `start`/`end` are character offsets into the ORIGINAL text — spans are
 *   painted directly from them; this module never re-tokenizes client-side.
 *
 * Any missing/malformed response (bad JSON, non-array `tokens`, a 404 from
 * an older install, a network error, an aborted request) degrades to an
 * empty token list — `buildSpans([...], [])` then paints the whole string
 * as one untouched "gap" span, i.e. plain unhighlighted text. Nothing here
 * ever throws out of `schedule()`/`buildSpans()`.
 */

/** Splits `value` into an array of Unicode CODE POINTS (not UTF-16 code
 * units). Token `start`/`end` come from Python, where `str` indices are
 * code points, but a plain JS string index counts UTF-16 units — those two
 * diverge for any character outside the BMP (most emoji, CJK Extension B+,
 * etc: a surrogate PAIR in JS, one code point in Python). Indexing through
 * this array instead of the raw string keeps offsets aligned for that text,
 * instead of slicing a surrogate pair in half.
 */
function codePointsOf(value) {
  return Array.from(value);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(n, hi));
}

function gapSpan(codePoints, start, end) {
  return {
    start,
    end,
    text: codePoints.slice(start, end).join(""),
    section: null,
    label: "",
    known: true,
    weighted: false,
    count: 0,
    gap: true,
  };
}

/**
 * Builds paintable spans for `text` from the classifier's raw `tokens`
 * array, entirely from the given `start`/`end` offsets (never re-tokenizing
 * `text` itself). Fills any uncovered stretch (gaps between tokens, a
 * leading/trailing untagged run, or — degrading — the WHOLE string when
 * `tokens` is missing/malformed) with an untouched "gap" span
 * (`section: null`, `gap: true`) so the caller can render it as plain text.
 *
 * Defensive against a malformed backend response:
 *  - `tokens` not an array -> no spans built from it (whole text is one gap).
 *  - a token missing/non-numeric `start`/`end` -> skipped.
 *  - an out-of-range `start`/`end` -> clamped into `[0, text length]`.
 *  - `end <= start` after clamping -> skipped (empty/inverted range).
 *  - a token whose (clamped) `start` falls before the current paint cursor
 *    (i.e. it overlaps a token already placed) -> skipped, first-wins —
 *    tokens are otherwise sorted by `start` first so this is deterministic.
 */
export function buildSpans(text, tokens) {
  const value = String(text ?? "");
  const codePoints = codePointsOf(value);
  const length = codePoints.length;

  const valid = [];
  if (Array.isArray(tokens)) {
    for (const token of tokens) {
      if (!token || typeof token !== "object") {
        continue;
      }
      const rawStart = Number(token.start);
      const rawEnd = Number(token.end);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
        continue;
      }
      const start = clamp(Math.trunc(rawStart), 0, length);
      const end = clamp(Math.trunc(rawEnd), 0, length);
      if (end <= start) {
        continue;
      }
      valid.push({ ...token, start, end });
    }
  }
  valid.sort((a, b) => a.start - b.start || a.end - b.end);

  const spans = [];
  let cursor = 0;
  for (const token of valid) {
    if (token.start < cursor) {
      continue; // overlaps a token already placed -- first-wins
    }
    if (token.start > cursor) {
      spans.push(gapSpan(codePoints, cursor, token.start));
    }
    spans.push({
      start: token.start,
      end: token.end,
      text: codePoints.slice(token.start, token.end).join(""),
      section: typeof token.section === "string" && token.section ? token.section : "unknown",
      label: typeof token.label === "string" ? token.label : "",
      known: token.known !== false,
      weighted: token.weighted === true,
      count: Number.isFinite(Number(token.count)) ? Number(token.count) : 0,
      gap: false,
    });
    cursor = token.end;
  }
  if (cursor < length) {
    spans.push(gapSpan(codePoints, cursor, length));
  }
  if (!spans.length && length) {
    spans.push(gapSpan(codePoints, 0, length));
  }
  return spans;
}

/**
 * Builds a debounced, cached, last-write-wins classifier.
 *
 * `schedule(text, onResult)`:
 *  - identical `text` to the last COMPLETED request -> calls `onResult`
 *    immediately with the cached tokens, no network call (the "identical
 *    text -> no refetch" cache).
 *  - otherwise debounces `debounceMs`, then POSTs once. If a NEWER
 *    `schedule()` call starts its own request before this one's response
 *    arrives, this one's result is dropped when it finally resolves (an
 *    incrementing request id compared against the latest at completion
 *    time — "last write wins" regardless of which network response lands
 *    first). An `AbortController` (when available) also proactively cancels
 *    whatever was still in flight so a `detach()`/`cancel()` doesn't leave
 *    a dangling request.
 *  - any failure (network error, non-2xx/404, malformed JSON, aborted)
 *    resolves to `tokens: []` rather than throwing or rejecting.
 *
 * `cancel()` clears the pending debounce timer and aborts any in-flight
 * request without touching the cache.
 */
export function createClassifier(options = {}) {
  const {
    classifyUrl = "/wtn/classify",
    limit = 500,
    debounceMs = 200,
    fetchImpl = typeof fetch !== "undefined" ? fetch : undefined,
    setTimeoutImpl = typeof setTimeout !== "undefined" ? setTimeout : undefined,
    clearTimeoutImpl = typeof clearTimeout !== "undefined" ? clearTimeout : undefined,
  } = options;

  let debounceTimer = null;
  let requestSeq = 0;
  let activeController = null;
  let lastText = null;
  let lastTokens = [];

  function cancel() {
    if (debounceTimer != null) {
      clearTimeoutImpl?.(debounceTimer);
      debounceTimer = null;
    }
    if (activeController) {
      try {
        activeController.abort();
      } catch {
        // already settled/unsupported -- fine, we're just being tidy.
      }
      activeController = null;
    }
  }

  async function runRequest(text, seq) {
    let tokens = [];
    try {
      if (!fetchImpl) {
        throw new Error("no fetch implementation available");
      }
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      activeController = controller;
      const res = await fetchImpl(classifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, limit }),
        signal: controller ? controller.signal : undefined,
      });
      if (res && res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.tokens)) {
          tokens = data.tokens;
        }
      }
    } catch {
      tokens = []; // network error, abort, bad JSON, missing route -- degrade silently
    }
    return { tokens, seq };
  }

  function schedule(text, onResult) {
    const value = String(text ?? "");
    if (value === lastText) {
      onResult(lastTokens, value);
      return;
    }
    if (debounceTimer != null) {
      clearTimeoutImpl?.(debounceTimer);
      debounceTimer = null;
    }
    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = null;
      const seq = ++requestSeq;
      runRequest(value, seq).then(({ tokens, seq: doneSeq }) => {
        if (doneSeq !== requestSeq) {
          return; // superseded by a newer request -- last write wins
        }
        activeController = null;
        lastText = value;
        lastTokens = tokens;
        onResult(tokens, value);
      });
    }, debounceMs);
  }

  return { schedule, cancel };
}
