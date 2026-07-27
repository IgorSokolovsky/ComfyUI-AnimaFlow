/**
 * test_highlight.mjs — regression tests for the shared prompt
 * tag-highlighting module (`js/shared/highlight/`), in the same style as
 * the sibling `test_resize.mjs` files: plain `node`, `node:assert/strict`,
 * self-relative `__dirname`, PASS/FAIL tally + exit code, a minimal stubbed
 * DOM (no real browser/ComfyUI host).
 *
 *   A. `classify.mjs`'s `buildSpans` — span construction straight from
 *      token offsets: adjacent tokens, a gap between tokens, a single
 *      whole-string token, the malformed-response degradation path
 *      (missing/non-array `tokens`, out-of-range/inverted/overlapping
 *      offsets), empty text, and the CJK/emoji (multi-byte) alignment case
 *      (Python code-point offsets vs JS UTF-16 code units).
 *   B. `classify.mjs`'s `createClassifier` — debounce (only fires after
 *      the quiet period), cache (identical text -> no refetch), the
 *      malformed-response degradation path (network throw / non-2xx /
 *      bad JSON -> `tokens: []`, never throws), and last-write-wins
 *      ordering (a stale, late-arriving response for older text never
 *      overwrites a newer one, regardless of network arrival order).
 *   C. `overlay.mjs` — `copyTextMetrics` (metric-property copying),
 *      `renderMirrorHtml` (span markup + the trailing-newline fix),
 *      `ensureOverlay`/`syncBounds`/`removeOverlay` against the DOM stub
 *      (mirror is a SIBLING, never a reparent of the textarea; original
 *      styles restored on removal).
 *   D. `colors.mjs` — all 16 sections present with a color + background +
 *      weight + label, CSS generation covers every section (color,
 *      font-weight, background chip, opacity cascade).
 *   E. `legend.mjs` — collapsed by default, one item per section, swatches
 *      addressed by `data-section` and reusing the real `wtn-hl-tok` class.
 *   F. `index.mjs`'s `attachHighlighter`/`detach` — idempotent attach,
 *      initial + debounced-on-input classification with a fake
 *      timer/fetch, the "last painted text" repaint-churn guard, that
 *      `detach()` removes the mirror and restores the textarea's original
 *      inline styles, and the two-tier (optimistic-then-authoritative)
 *      paint path: text painted synchronously at attach and on every
 *      `input` (before any fetch resolves), the optimistic -> authoritative
 *      repaint for IDENTICAL text surviving the churn guard, a genuinely
 *      redundant repaint still being suppressed, and `refresh()` painting
 *      optimistically immediately.
 *   G. `name_cache.mjs` / `optimistic.mjs` — the two-tier paint's tier 1:
 *      the name cache populates from a classify response and is reused by
 *      `lookupTagName`, syntax-dependent sections are NOT name-cached,
 *      cache bounding/eviction, the client-side approximate splitter
 *      (paren-aware comma/newline split), and `attachHighlighter`
 *      end-to-end: an optimistic paint colors a cached tag with NO fetch
 *      in flight, an unknown tag renders plain optimistically, and the
 *      authoritative paint still replaces an optimistic one for identical
 *      text (the guard trap, now with a third paint kind in the mix).
 *
 * `name_cache.mjs`'s cache is a process-wide module singleton, so every
 * test below runs through `test()`/`asyncTest()`, which clear it before
 * each run -- otherwise an earlier test seeding "1girl" -> general would
 * silently color later, unrelated tests that assume a cold cache.
 *
 * Run directly: `node js/shared/highlight/test_highlight.mjs`.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildSpans, createClassifier } from "./classify.mjs";
import {
  METRIC_PROPERTIES,
  copyTextMetrics,
  renderMirrorHtml,
  ensureOverlay,
  syncBounds,
  removeOverlay,
} from "./overlay.mjs";
import { SECTIONS, sectionInfo, sectionLabel, sectionVarsCss, sectionTokenCss } from "./colors.mjs";
import { createLegend } from "./legend.mjs";
import { attachHighlighter, detach } from "./index.mjs";
import {
  NAME_CACHEABLE_SECTIONS,
  normalizeTagName,
  rememberToken,
  rememberTokens,
  lookupTagName,
  nameCacheSize,
  clearNameCache,
} from "./name_cache.mjs";
import { splitApproxTagSpans, approxTagBase, buildOptimisticSpans } from "./optimistic.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname; // kept for parity with sibling test files' convention

let failures = 0;
let count = 0;

function test(name, fn) {
  count += 1;
  clearNameCache(); // isolate from whatever an earlier test cached
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

async function asyncTest(name, fn) {
  count += 1;
  clearNameCache(); // isolate from whatever an earlier test cached
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Minimal DOM stub ---------------------------------------------------

function makeDocStub() {
  const idRegistry = new Map();
  let doc;

  function makeElement(tag) {
    const el = {
      tagName: tag,
      style: {},
      attributes: {},
      _listeners: {},
      children: [],
      value: "",
      textContent: "",
      innerHTML: "",
      className: "",
      offsetLeft: 0,
      offsetTop: 0,
      offsetWidth: 0,
      offsetHeight: 0,
      scrollTop: 0,
      scrollLeft: 0,
      spellcheck: undefined,
      parentNode: null,
      get ownerDocument() {
        return doc;
      },
      setAttribute(name, val) {
        el.attributes[name] = val;
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
      },
      removeAttribute(name) {
        delete el.attributes[name];
      },
      addEventListener(type, fn) {
        (el._listeners[type] = el._listeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        if (el._listeners[type]) {
          el._listeners[type] = el._listeners[type].filter((f) => f !== fn);
        }
      },
      appendChild(child) {
        el.children.push(child);
        child.parentNode = el;
        if (child.id) {
          idRegistry.set(child.id, child);
        }
        return child;
      },
      insertBefore(newNode, refNode) {
        const idx = el.children.indexOf(refNode);
        if (idx < 0) {
          el.children.push(newNode);
        } else {
          el.children.splice(idx, 0, newNode);
        }
        newNode.parentNode = el;
        return newNode;
      },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx >= 0) {
          el.children.splice(idx, 1);
        }
        child.parentNode = null;
        return child;
      },
      focus() {},
    };
    return el;
  }

  doc = {
    createElement: makeElement,
    getElementById(id) {
      return idRegistry.get(id) || null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
  };
  return doc;
}

function fire(el, type) {
  (el._listeners[type] || []).forEach((fn) => fn());
}

// =========================================================================
// A. classify.mjs -- buildSpans
// =========================================================================

test("buildSpans: adjacent tokens produce no gap span between them", () => {
  const text = "abcdef";
  const tokens = [
    { start: 0, end: 3, section: "quality" },
    { start: 3, end: 6, section: "general" },
  ];
  const spans = buildSpans(text, tokens);
  assert.equal(spans.length, 2);
  assert.deepEqual(
    spans.map((s) => [s.start, s.end, s.text, s.section, s.gap]),
    [
      [0, 3, "abc", "quality", false],
      [3, 6, "def", "general", false],
    ],
  );
});

test("buildSpans: a gap between two tokens becomes a plain 'gap' span", () => {
  const text = "0123456789";
  const tokens = [
    { start: 0, end: 3, section: "quality" },
    { start: 5, end: 8, section: "general" },
  ];
  const spans = buildSpans(text, tokens);
  assert.equal(spans.length, 4); // token, gap, token, trailing gap
  assert.deepEqual(
    spans.map((s) => [s.start, s.end, s.text, s.gap]),
    [
      [0, 3, "012", false],
      [3, 5, "34", true],
      [5, 8, "567", false],
      [8, 10, "89", true],
    ],
  );
  assert.equal(spans[1].section, null);
});

test("buildSpans: a single token spanning the whole string yields one span, no gaps", () => {
  const text = "1girl, solo";
  const tokens = [{ start: 0, end: text.length, section: "general" }];
  const spans = buildSpans(text, tokens);
  assert.deepEqual(spans, [
    {
      start: 0,
      end: text.length,
      text,
      section: "general",
      label: "",
      known: true,
      weighted: false,
      count: 0,
      gap: false,
    },
  ]);
});

test("buildSpans: empty text yields no spans at all", () => {
  assert.deepEqual(buildSpans("", []), []);
  assert.deepEqual(buildSpans("", [{ start: 0, end: 1, section: "general" }]), []);
});

test("buildSpans degrades to one plain span for the WHOLE text when tokens is missing/malformed", () => {
  const text = "newest, 1girl, masterpiece";
  for (const malformed of [undefined, null, "not-an-array", 42, {}]) {
    const spans = buildSpans(text, malformed);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].gap, true);
    assert.equal(spans[0].section, null);
    assert.equal(spans[0].text, text);
  }
});

test("buildSpans skips a token with a missing/non-numeric start or end", () => {
  const text = "abcdef";
  const spans = buildSpans(text, [
    { end: 3, section: "quality" }, // missing start
    { start: 3, section: "general" }, // missing end
    { start: "x", end: 4, section: "meta" }, // non-numeric start
    { start: 0, end: 3, section: "year" }, // the one valid token
  ]);
  assert.equal(spans.length, 2); // the valid token + trailing gap
  assert.equal(spans[0].section, "year");
  assert.equal(spans[1].gap, true);
});

test("buildSpans clamps an out-of-range start/end into [0, text length]", () => {
  const text = "abcdef"; // length 6
  const spans = buildSpans(text, [{ start: -5, end: 999, section: "general" }]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[0].end, 6);
  assert.equal(spans[0].text, text);
});

test("buildSpans drops an inverted/empty range (end <= start) after clamping", () => {
  const spans = buildSpans("abcdef", [{ start: 4, end: 2, section: "general" }]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].gap, true);
  assert.equal(spans[0].text, "abcdef");
});

test("buildSpans keeps the first token and drops a later one that overlaps it", () => {
  const text = "abcdef";
  const spans = buildSpans(text, [
    { start: 0, end: 4, section: "quality" },
    { start: 2, end: 6, section: "general" }, // overlaps the first -- dropped
  ]);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].section, "quality");
  assert.equal(spans[0].end, 4);
  assert.equal(spans[1].gap, true);
  assert.equal(spans[1].text, "ef");
});

test("buildSpans sorts out-of-order tokens by start before placing them", () => {
  const text = "abcdef";
  const spans = buildSpans(text, [
    { start: 3, end: 6, section: "general" },
    { start: 0, end: 3, section: "quality" },
  ]);
  assert.deepEqual(spans.map((s) => s.section), ["quality", "general"]);
});

test("buildSpans preserves weighted/known/count/label fields", () => {
  const spans = buildSpans("tag", [
    { start: 0, end: 3, section: "artist", label: "Artist", known: false, weighted: true, count: 12345 },
  ]);
  assert.equal(spans[0].label, "Artist");
  assert.equal(spans[0].known, false);
  assert.equal(spans[0].weighted, true);
  assert.equal(spans[0].count, 12345);
});

test("buildSpans stays aligned across an astral character (emoji/CJK-extension) -- code points, not UTF-16 units", () => {
  const text = "a\u{1F600}b"; // "a" + U+1F600 (a surrogate pair in JS) + "b" -- 3 code points, 4 UTF-16 units
  assert.equal(text.length, 4); // sanity: confirms the surrogate pair really is 2 JS units
  const spans = buildSpans(text, [
    { start: 0, end: 1, section: "general" }, // "a" by code point
    { start: 1, end: 2, section: "meta" }, // the emoji by code point
    { start: 2, end: 3, section: "general" }, // "b" by code point
  ]);
  assert.equal(spans.length, 3);
  assert.equal(spans[0].text, "a");
  assert.equal(spans[1].text, "\u{1F600}");
  assert.equal(spans[2].text, "b");
});

// =========================================================================
// B. classify.mjs -- createClassifier
// =========================================================================

function makeFakeTimers() {
  let queue = [];
  let nextId = 1;
  return {
    setTimeoutImpl(fn, ms) {
      const id = nextId++;
      queue.push({ id, fn, ms });
      return id;
    },
    clearTimeoutImpl(id) {
      queue = queue.filter((t) => t.id !== id);
    },
    flush() {
      const pending = queue;
      queue = [];
      pending.forEach((t) => t.fn());
    },
    pendingCount() {
      return queue.length;
    },
  };
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body) {
  return { ok: true, json: async () => body };
}

test("createClassifier: schedule() does not call fetch synchronously -- it waits for the debounce timer", () => {
  const timers = makeFakeTimers();
  let fetchCalls = 0;
  const classifier = createClassifier({
    debounceMs: 200,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    fetchImpl: () => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse({ tokens: [] }));
    },
  });
  classifier.schedule("hello", () => {});
  assert.equal(fetchCalls, 0);
  assert.equal(timers.pendingCount(), 1);
});

test("createClassifier: rapid re-schedule cancels the previous debounce timer (only the latest text fetches)", () => {
  const timers = makeFakeTimers();
  const fetchedTexts = [];
  const classifier = createClassifier({
    debounceMs: 200,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    fetchImpl: (url, init) => {
      fetchedTexts.push(JSON.parse(init.body).text);
      return Promise.resolve(jsonResponse({ tokens: [] }));
    },
  });
  classifier.schedule("h", () => {});
  classifier.schedule("he", () => {});
  classifier.schedule("hel", () => {});
  assert.equal(timers.pendingCount(), 1); // the first two timers were cancelled, not fired
  timers.flush();
  assert.deepEqual(fetchedTexts, ["hel"]);
});

await asyncTest("createClassifier: cache -- identical text to the last COMPLETED request never refetches", async () => {
  const timers = makeFakeTimers();
  let fetchCalls = 0;
  const results = [];
  const classifier = createClassifier({
    debounceMs: 50,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    fetchImpl: () => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse({ tokens: [{ start: 0, end: 4, section: "general" }] }));
    },
  });
  classifier.schedule("1girl", (tokens) => results.push(tokens));
  timers.flush();
  await delay(0);
  assert.equal(fetchCalls, 1);
  assert.equal(results.length, 1);

  // Same text again -- served from cache, no new timer, no new fetch.
  classifier.schedule("1girl", (tokens) => results.push(tokens));
  assert.equal(timers.pendingCount(), 0);
  assert.equal(fetchCalls, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(results[1], results[0]);
});

await asyncTest("createClassifier degrades to tokens:[] on a network error, never throws or rejects", async () => {
  const timers = makeFakeTimers();
  let result = null;
  const classifier = createClassifier({
    debounceMs: 10,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    fetchImpl: () => {
      throw new Error("network down");
    },
  });
  classifier.schedule("x", (tokens) => {
    result = tokens;
  });
  timers.flush();
  await delay(0);
  assert.deepEqual(result, []);
});

await asyncTest("createClassifier degrades to tokens:[] on a non-2xx status (e.g. a 404 from an older install)", async () => {
  const timers = makeFakeTimers();
  let result = null;
  const classifier = createClassifier({
    debounceMs: 10,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
  });
  classifier.schedule("x", (tokens) => {
    result = tokens;
  });
  timers.flush();
  await delay(0);
  assert.deepEqual(result, []);
});

await asyncTest("createClassifier degrades to tokens:[] on malformed JSON (missing/non-array tokens)", async () => {
  const timers = makeFakeTimers();
  const results = [];
  const classifier = createClassifier({
    debounceMs: 10,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    fetchImpl: () => Promise.resolve(jsonResponse({ tokens: "not-an-array" })),
  });
  classifier.schedule("x", (tokens) => results.push(tokens));
  timers.flush();
  await delay(0);
  assert.deepEqual(results, [[]]);
});

await asyncTest(
  "createClassifier: last-write-wins -- a stale response for OLDER text never overwrites a newer one, regardless of arrival order",
  async () => {
    const timers = makeFakeTimers();
    const deferredByText = new Map();
    const results = [];
    const classifier = createClassifier({
      debounceMs: 50,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      fetchImpl: (url, init) => {
        const { text } = JSON.parse(init.body);
        const deferred = makeDeferred();
        deferredByText.set(text, deferred);
        return deferred.promise;
      },
    });

    // Two distinct requests, each past its own debounce window (simulating
    // the user pausing after "first prompt", then again after "second
    // prompt") -- both genuinely in flight at once.
    classifier.schedule("first prompt", (tokens, text) => results.push({ text, tokens }));
    timers.flush();
    classifier.schedule("second prompt", (tokens, text) => results.push({ text, tokens }));
    timers.flush();

    assert.ok(deferredByText.has("first prompt"));
    assert.ok(deferredByText.has("second prompt"));

    // The NEWER request's response arrives first...
    deferredByText
      .get("second prompt")
      .resolve(jsonResponse({ tokens: [{ start: 0, end: 6, section: "general" }] }));
    await delay(0);
    // ...then the OLDER request's response arrives late.
    deferredByText
      .get("first prompt")
      .resolve(jsonResponse({ tokens: [{ start: 0, end: 5, section: "quality" }] }));
    await delay(0);

    assert.equal(results.length, 1, "the stale late response must be dropped, not delivered");
    assert.equal(results[0].text, "second prompt");
    assert.equal(results[0].tokens[0].section, "general");
  },
);

// =========================================================================
// C. overlay.mjs
// =========================================================================

test("METRIC_PROPERTIES includes every font/box metric the technique depends on", () => {
  const required = [
    "font",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "fontVariant",
    "fontKerning",
    "fontFeatureSettings",
    "lineHeight",
    "letterSpacing",
    "wordSpacing",
    "textIndent",
    "whiteSpace",
    "overflowWrap",
    "wordBreak",
    "tabSize",
    "direction",
    "textTransform",
    "textRendering",
    "padding",
    "border",
    "boxSizing",
    "fontStretch",
  ];
  for (const prop of required) {
    assert.ok(METRIC_PROPERTIES.includes(prop), `missing metric property: ${prop}`);
  }
  assert.ok(METRIC_PROPERTIES.length >= 25);
});

test("copyTextMetrics copies every listed property whose source has a value, skips undefined", () => {
  const source = { fontSize: "14px", fontFamily: "monospace", lineHeight: "1.5" };
  const target = { style: {} };
  copyTextMetrics(source, target);
  assert.equal(target.style.fontSize, "14px");
  assert.equal(target.style.fontFamily, "monospace");
  assert.equal(target.style.lineHeight, "1.5");
  assert.equal("fontWeight" in target.style, false);
});

test("copyTextMetrics is a safe no-op for missing source/target", () => {
  assert.doesNotThrow(() => copyTextMetrics(null, { style: {} }));
  assert.doesNotThrow(() => copyTextMetrics({ fontSize: "1px" }, null));
});

test("renderMirrorHtml: empty text renders nothing", () => {
  assert.equal(renderMirrorHtml("", []), "");
  assert.equal(renderMirrorHtml(null, []), "");
});

test("renderMirrorHtml: a trailing newline gets a trailing space so the last (empty) line keeps its height", () => {
  const text = "1girl, solo\n";
  const spans = buildSpans(text, [{ start: 0, end: 5, section: "general" }]);
  const html = renderMirrorHtml(text, spans);
  assert.ok(html.endsWith(" "), `expected a trailing space, got: ${JSON.stringify(html.slice(-5))}`);
});

test("renderMirrorHtml: no trailing newline means no extra trailing space", () => {
  const html = renderMirrorHtml("1girl", buildSpans("1girl", [{ start: 0, end: 5, section: "general" }]));
  assert.ok(!html.endsWith(" "));
});

test("renderMirrorHtml: paints a known token as a span with its section, weighted flag, and title", () => {
  const text = "masterpiece";
  const spans = buildSpans(text, [{ start: 0, end: text.length, section: "quality", label: "Quality", weighted: true }]);
  const html = renderMirrorHtml(text, spans);
  assert.match(html, /class="wtn-hl-tok"/);
  assert.match(html, /data-section="quality"/);
  assert.match(html, /data-weighted="true"/);
  assert.match(html, /data-known="true"/);
  assert.match(html, /title="Quality"/);
  assert.match(html, />masterpiece</);
});

test("renderMirrorHtml: a token explicitly marked known:false does NOT get data-known (falls to the 0.88 opacity default)", () => {
  const text = "some_new_tag";
  const spans = buildSpans(text, [{ start: 0, end: text.length, section: "general", known: false }]);
  const html = renderMirrorHtml(text, spans);
  assert.match(html, /class="wtn-hl-tok"/);
  assert.ok(!html.includes("data-known"), "known:false must not emit data-known");
});

test("renderMirrorHtml: a gap span is rendered as plain escaped text, no span wrapper", () => {
  const text = "a & b";
  const spans = buildSpans(text, []); // malformed/no tokens -> whole thing is one gap
  const html = renderMirrorHtml(text, spans);
  assert.equal(html, "a &amp; b");
});

test("renderMirrorHtml escapes HTML-significant characters in token text", () => {
  const text = "<script>";
  const spans = buildSpans(text, [{ start: 0, end: text.length, section: "syntax" }]);
  const html = renderMirrorHtml(text, spans);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("ensureOverlay inserts the mirror as a SIBLING before the textarea -- never reparenting/replacing it", () => {
  const doc = makeDocStub();
  const wrapper = doc.createElement("div");
  const textarea = doc.createElement("textarea");
  wrapper.appendChild(textarea);
  assert.equal(wrapper.children.length, 1);

  const mirror = ensureOverlay(doc, textarea);

  assert.ok(mirror);
  assert.equal(wrapper.children.length, 2);
  assert.equal(wrapper.children[0], mirror);
  assert.equal(wrapper.children[1], textarea, "the textarea itself must still be the same element, same parent");
  assert.equal(textarea.parentNode, wrapper);
});

test("ensureOverlay sets the parent to position:relative only when it was static", () => {
  const doc = makeDocStub();
  const wrapper = doc.createElement("div");
  const textarea = doc.createElement("textarea");
  wrapper.appendChild(textarea);
  ensureOverlay(doc, textarea);
  assert.equal(wrapper.style.position, "relative");
});

test("ensureOverlay is idempotent -- a second call returns the same mirror, does not insert twice", () => {
  const doc = makeDocStub();
  const wrapper = doc.createElement("div");
  const textarea = doc.createElement("textarea");
  wrapper.appendChild(textarea);
  const first = ensureOverlay(doc, textarea);
  const second = ensureOverlay(doc, textarea);
  assert.equal(first, second);
  assert.equal(wrapper.children.length, 2);
});

test("ensureOverlay applies transparent-text/visible-caret styling, preserving the original for restore", () => {
  const doc = makeDocStub();
  const wrapper = doc.createElement("div");
  const textarea = doc.createElement("textarea");
  textarea.style.color = "#e7ecf3";
  wrapper.appendChild(textarea);
  ensureOverlay(doc, textarea);
  assert.equal(textarea.style.color, "transparent");
  assert.match(textarea.style.caretColor, /wtn-ink/);
});

test("syncBounds mirrors the textarea's offset box and scroll position onto the mirror", () => {
  const doc = makeDocStub();
  const wrapper = doc.createElement("div");
  const textarea = doc.createElement("textarea");
  wrapper.appendChild(textarea);
  const mirror = ensureOverlay(doc, textarea);

  textarea.offsetLeft = 4;
  textarea.offsetTop = 8;
  textarea.offsetWidth = 300;
  textarea.offsetHeight = 120;
  textarea.scrollTop = 42;
  textarea.scrollLeft = 7;
  syncBounds(textarea, mirror);

  assert.equal(mirror.style.left, "4px");
  assert.equal(mirror.style.top, "8px");
  assert.equal(mirror.style.width, "300px");
  assert.equal(mirror.style.height, "120px");
  assert.equal(mirror.scrollTop, 42);
  assert.equal(mirror.scrollLeft, 7);
});

test("removeOverlay removes the mirror and restores the textarea's original inline styles", () => {
  const doc = makeDocStub();
  const wrapper = doc.createElement("div");
  const textarea = doc.createElement("textarea");
  textarea.style.color = "#e7ecf3";
  textarea.style.background = "#0a0d12";
  wrapper.appendChild(textarea);
  const mirror = ensureOverlay(doc, textarea);
  assert.equal(wrapper.children.length, 2);

  removeOverlay(textarea);

  assert.equal(wrapper.children.length, 1);
  assert.equal(wrapper.children[0], textarea);
  assert.equal(mirror.parentNode, null);
  assert.equal(textarea.style.color, "#e7ecf3");
  assert.equal(textarea.style.background, "#0a0d12");
});

// =========================================================================
// D. colors.mjs
// =========================================================================

test("SECTIONS defines exactly the 16 documented sections, each with a label + color + weight", () => {
  const expectedIds = [
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
    "translation",
    "wildcard",
    "comment",
    "syntax",
    "unknown",
  ];
  assert.deepEqual(SECTIONS.map((s) => s.id), expectedIds);
  const seenCombos = new Set();
  for (const section of SECTIONS) {
    assert.match(section.hex, /^#[0-9a-f]{6}$/i, `${section.id} needs a hex color`);
    assert.ok(section.label && section.label.length > 0, `${section.id} needs a label`);
    assert.ok(
      Number.isInteger(section.weight) && section.weight >= 100 && section.weight <= 900,
      `${section.id} needs a numeric CSS font-weight`,
    );
    // Two sections deliberately REUSE a hue in the adopted reference table
    // (`artist_unknown`/`syntax` both #f87171; `natural`/`unknown` both
    // #cbd5e1) and are told apart by background/underline instead -- so the
    // uniqueness check is on the full (hex, background, weight, underline)
    // combination, not the hex alone.
    const combo = `${section.hex}|${section.bg || "transparent"}|${section.weight}|${section.underline || ""}`;
    seenCombos.add(combo);
  }
  assert.equal(seenCombos.size, expectedIds.length, "every section's FULL treatment must be distinguishable");
});

test("SECTIONS carries the exact color/background/weight table adopted from the reference pack", () => {
  const expected = {
    quality: { hex: "#facc15", bg: "rgba(202, 138, 4, 0.18)", weight: 700 },
    safety: { hex: "#38bdf8", bg: "rgba(2, 132, 199, 0.18)", weight: 600 },
    year: { hex: "#2dd4bf", bg: "rgba(13, 148, 136, 0.18)", weight: 600 },
    count: { hex: "#60a5fa", bg: "rgba(37, 99, 235, 0.18)", weight: 700 },
    character: { hex: "#f472b6", bg: "rgba(219, 39, 119, 0.18)", weight: 700 },
    artist: { hex: "#a78bfa", bg: "rgba(124, 58, 237, 0.18)", weight: 700 },
    artist_unknown: { hex: "#f87171", bg: null, weight: 400 },
    copyright: { hex: "#fb923c", bg: "rgba(234, 88, 12, 0.18)", weight: 700 },
    meta: { hex: "#94a3b8", bg: "rgba(100, 116, 139, 0.18)", weight: 600 },
    general: { hex: "#4ade80", bg: "rgba(22, 163, 74, 0.16)", weight: 600 },
    natural: { hex: "#cbd5e1", bg: "rgba(71, 85, 105, 0.16)", weight: 400 },
    translation: { hex: "#22d3ee", bg: "rgba(8, 145, 178, 0.22)", weight: 700 },
    wildcard: { hex: "#c084fc", bg: "rgba(126, 34, 206, 0.24)", weight: 700 },
    comment: { hex: "#9ca3af", bg: "rgba(156, 163, 175, 0.14)", weight: 400 },
    syntax: { hex: "#f87171", bg: null, weight: 400 },
    unknown: { hex: "#cbd5e1", bg: null, weight: 400 },
  };
  for (const section of SECTIONS) {
    const want = expected[section.id];
    assert.equal(section.hex, want.hex, `${section.id} hex`);
    assert.equal(section.bg || null, want.bg, `${section.id} background`);
    assert.equal(section.weight, want.weight, `${section.id} weight`);
  }
  assert.equal(SECTIONS.find((s) => s.id === "comment").italic, true, "comment must stay italic");
  assert.equal(SECTIONS.find((s) => s.id === "syntax").underline, "wavy", "syntax keeps its wavy underline");
  assert.equal(
    SECTIONS.find((s) => s.id === "syntax").underlineColor,
    "#ef4444",
    "syntax's underline color is the fixed #ef4444, independent of its text color",
  );
});

test("sectionInfo/sectionLabel fall back to 'unknown' for an unrecognized section id", () => {
  assert.equal(sectionInfo("something-new-from-a-future-backend"), sectionInfo("unknown"));
  assert.equal(sectionLabel("something-new-from-a-future-backend"), sectionLabel("unknown"));
});

test("sectionVarsCss/sectionTokenCss emit a rule for every section, incl. background chips and weight", () => {
  const varsCss = sectionVarsCss();
  const tokenCss = sectionTokenCss();
  for (const section of SECTIONS) {
    assert.ok(varsCss.includes(section.varName), `missing var declaration for ${section.id}`);
    assert.ok(tokenCss.includes(`data-section="${section.id}"`), `missing token rule for ${section.id}`);
    assert.ok(tokenCss.includes(`font-weight: ${section.weight};`), `missing font-weight for ${section.id}`);
    if (section.bg) {
      assert.ok(varsCss.includes(section.bgVarName), `missing bg var declaration for ${section.id}`);
      assert.ok(varsCss.includes(section.bg), `missing bg fallback value for ${section.id}`);
    }
  }
  assert.ok(tokenCss.includes('[data-weighted="true"]'));
});

test("sectionTokenCss emits the border-radius chip rule only for sections with a background", () => {
  const tokenCss = sectionTokenCss();
  const withBg = SECTIONS.filter((s) => s.bg);
  const withoutBg = SECTIONS.filter((s) => !s.bg);
  assert.ok(withBg.length > 0 && withoutBg.length > 0, "fixture sanity: need both kinds present");
  for (const section of withBg) {
    const ruleStart = tokenCss.indexOf(`[data-section="${section.id}"]`);
    const ruleEnd = tokenCss.indexOf("}", ruleStart);
    const rule = tokenCss.slice(ruleStart, ruleEnd);
    assert.ok(rule.includes("border-radius: 3px;"), `${section.id} (has a bg) should get the chip radius`);
  }
});

test("sectionTokenCss's opacity cascade: 0.88 base, 1 for known tokens, 1 for count regardless of known", () => {
  const tokenCss = sectionTokenCss();
  assert.ok(tokenCss.includes(".wtn-hl-tok {\n  opacity: 0.88;\n}"), "missing the 0.88 base rule");
  assert.ok(tokenCss.includes('.wtn-hl-tok[data-known="true"] {\n  opacity: 1;\n}'), "missing the known->1 override");
  assert.ok(
    tokenCss.includes('.wtn-hl-tok[data-section="count"] {\n  opacity: 1;\n}'),
    "missing the count->1 override",
  );
});

// =========================================================================
// E. legend.mjs
// =========================================================================

test("createLegend is collapsed by default (no 'open' attribute)", () => {
  const doc = makeDocStub();
  const legend = createLegend({ doc });
  assert.ok(legend);
  assert.equal(legend.root.tagName, "details");
  assert.equal(Object.prototype.hasOwnProperty.call(legend.root.attributes, "open"), false);
});

test("createLegend can start open when asked", () => {
  const doc = makeDocStub();
  const legend = createLegend({ doc, open: true });
  assert.ok(Object.prototype.hasOwnProperty.call(legend.root.attributes, "open"));
});

test("createLegend renders one item per section, each swatch addressed by data-section", () => {
  const doc = makeDocStub();
  const legend = createLegend({ doc });
  const body = legend.root.children.find((c) => c.tagName === "div");
  const grid = body.children.find((c) => c.tagName === "div");
  assert.equal(grid.children.length, SECTIONS.length);
  const sectionIds = grid.children.map((item) => item.children[0].getAttribute("data-section"));
  assert.deepEqual(sectionIds, SECTIONS.map((s) => s.id));
});

test("createLegend's swatches reuse the real 'wtn-hl-tok' token class + data-known, so legend and text share one CSS rule", () => {
  const doc = makeDocStub();
  const legend = createLegend({ doc });
  const body = legend.root.children.find((c) => c.tagName === "div");
  const grid = body.children.find((c) => c.tagName === "div");
  for (const item of grid.children) {
    const swatch = item.children[0];
    assert.match(swatch.className, /\bwtn-hl-tok\b/, "swatch must carry the token class, not a bespoke one");
    assert.equal(swatch.getAttribute("data-known"), "true");
  }
});

test("createLegend's setOpen toggles the open attribute", () => {
  const doc = makeDocStub();
  const legend = createLegend({ doc });
  legend.setOpen(true);
  assert.ok(Object.prototype.hasOwnProperty.call(legend.root.attributes, "open"));
  legend.setOpen(false);
  assert.equal(Object.prototype.hasOwnProperty.call(legend.root.attributes, "open"), false);
});

test("createLegend's destroy removes the element from its parent", () => {
  const doc = makeDocStub();
  const wrapper = doc.createElement("div");
  const legend = createLegend({ doc });
  wrapper.appendChild(legend.root);
  assert.equal(wrapper.children.length, 1);
  legend.destroy();
  assert.equal(wrapper.children.length, 0);
});

test("createLegend returns null with no document available", () => {
  assert.equal(createLegend({ doc: null }), null);
});

// =========================================================================
// F. index.mjs -- attachHighlighter / detach
// =========================================================================

function makeAttachedFixture(extra = {}) {
  const doc = makeDocStub();
  const wrapper = doc.createElement("div");
  const textarea = doc.createElement("textarea");
  textarea.value = extra.initialValue ?? "1girl, solo";
  wrapper.appendChild(textarea);

  const timers = makeFakeTimers();
  const fetchCalls = [];
  const fetchImpl =
    extra.fetchImpl
    || ((url, init) => {
      const { text } = JSON.parse(init.body);
      fetchCalls.push(text);
      return Promise.resolve(
        jsonResponse({ tokens: [{ start: 0, end: Math.min(5, text.length), section: "general" }] }),
      );
    });

  const tokensReceived = [];
  const handle = attachHighlighter(textarea, {
    doc,
    debounceMs: 100,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    fetchImpl,
    onTokens: (tokens, text) => tokensReceived.push({ tokens, text }),
    ...extra.opts,
  });

  return { doc, wrapper, textarea, timers, fetchCalls, tokensReceived, handle };
}

await asyncTest("attachHighlighter paints an initial classification on attach", async () => {
  const { timers, textarea, tokensReceived } = makeAttachedFixture();
  timers.flush();
  await delay(0);
  assert.equal(tokensReceived.length, 1);
  assert.equal(tokensReceived[0].text, textarea.value);
});

test("attachHighlighter paints the mirror PLAIN immediately at attach -- before the very first classify response lands (workflow load with a saved, non-empty prompt must never start blank)", () => {
  const { handle } = makeAttachedFixture({ initialValue: "1girl, masterpiece" });
  // No timers.flush()/delay -- this must be true synchronously, right after attach.
  assert.equal(handle.mirror.innerHTML, "1girl, masterpiece");
  assert.ok(!handle.mirror.innerHTML.includes("wtn-hl-tok"), "no color yet -- that's the second phase");
});

test("attachHighlighter paints newly-typed text synchronously on 'input', before any fetch resolves -- text is never invisible/stale", () => {
  const { timers, textarea, handle } = makeAttachedFixture({ initialValue: "1girl" });
  assert.equal(handle.mirror.innerHTML, "1girl"); // the attach-time plain paint

  textarea.value = "1girl, solo, new_tag";
  fire(textarea, "input");

  // The debounce timer for this edit hasn't even fired yet, let alone the
  // network request it would trigger -- the mirror must already reflect
  // the CURRENT text regardless.
  assert.equal(timers.pendingCount(), 1, "input scheduled a debounce timer, not yet fired");
  assert.equal(handle.mirror.innerHTML, "1girl, solo, new_tag");
  assert.ok(!handle.mirror.innerHTML.includes("wtn-hl-tok"), "still plain -- color is the second phase");
});

await asyncTest("the plain -> colored repaint for the SAME text is NOT suppressed by the churn guard -- the mirror still gains color once classify resolves", async () => {
  const { timers, handle } = makeAttachedFixture({ initialValue: "1girl, solo" });
  // Right after attach: plain-painted synchronously, no color yet.
  assert.equal(handle.mirror.innerHTML, "1girl, solo");
  assert.ok(!handle.mirror.innerHTML.includes("wtn-hl-tok"));

  timers.flush();
  await delay(0);

  // Same text throughout -- if the churn guard keyed purely on "text
  // already painted", this repaint would have been (wrongly) skipped and
  // the mirror would still be plain.
  assert.ok(handle.mirror.innerHTML.includes("wtn-hl-tok"), "classify's result must still be allowed to color this text");
  assert.match(handle.mirror.innerHTML, /data-section="general"/);
});

await asyncTest("a genuinely redundant repaint (same text, same resolved tokens) IS still suppressed -- no duplicate onTokens, mirror content doesn't churn", async () => {
  const { timers, textarea, tokensReceived, handle } = makeAttachedFixture({ initialValue: "1girl, solo" });
  timers.flush();
  await delay(0);
  assert.equal(tokensReceived.length, 1);
  const coloredHtml = handle.mirror.innerHTML;
  assert.ok(coloredHtml.includes("wtn-hl-tok"));

  // Re-fire input with the IDENTICAL value (e.g. a focus/blur round trip
  // that re-dispatches `input` without an actual edit) -- the classifier's
  // own "identical text" cache resolves this synchronously-ish with the
  // SAME tokens.
  fire(textarea, "input");
  timers.flush();
  await delay(0);

  assert.equal(tokensReceived.length, 1, "no extra onTokens call for a truly redundant repaint");
  assert.equal(handle.mirror.innerHTML, coloredHtml, "mirror content must not churn either");
});

test("attachHighlighter is idempotent -- a second attach on the same textarea returns the same handle", () => {
  const { textarea, handle } = makeAttachedFixture();
  const second = attachHighlighter(textarea, { doc: textarea.ownerDocument });
  assert.equal(second, handle);
});

await asyncTest("attachHighlighter debounces reclassification on input, and only fetches the latest value", async () => {
  const { timers, textarea, fetchCalls } = makeAttachedFixture();
  timers.flush(); // resolve the initial paint's fetch
  await delay(0);
  fetchCalls.length = 0;

  // Deliberately never lands back on "1girl, solo" (the fixture's initial,
  // already-cached value) partway through -- that would hit the classifier's
  // OWN "identical text" cache instead of exercising the debounce-cancel
  // path this test targets (see the cache test above for that behavior).
  textarea.value = "1girl";
  fire(textarea, "input");
  textarea.value = "1girl, so";
  fire(textarea, "input");
  textarea.value = "1girl, solo, smile";
  fire(textarea, "input");

  assert.equal(timers.pendingCount(), 1); // earlier debounce timers were cancelled
  timers.flush();
  await delay(0);
  assert.deepEqual(fetchCalls, ["1girl, solo, smile"]);
});

await asyncTest("attachHighlighter's 'last painted text' guard skips onTokens for a repeat of the same text", async () => {
  const { timers, textarea, tokensReceived } = makeAttachedFixture();
  timers.flush();
  await delay(0);
  assert.equal(tokensReceived.length, 1);

  // Re-fire input with the SAME value (e.g. a focus/blur round-trip) --
  // the classifier cache resolves synchronously-ish, but the handle must
  // not repaint/re-notify for text it already painted.
  fire(textarea, "input");
  timers.flush();
  await delay(0);
  assert.equal(tokensReceived.length, 1, "no additional paint for unchanged text");
});

test("refresh() paints the CURRENT text plain immediately, synchronously, before reclassifying (the programmatic textarea.value-write case)", () => {
  const { textarea, handle } = makeAttachedFixture({ initialValue: "1girl" });
  // Simulate `highlight_wiring.mjs`'s `refreshHighlighters` use case: a
  // caller sets `textarea.value` directly (no `input` event fires), then
  // calls `refresh()` to resync.
  textarea.value = "1girl, masterpiece, programmatic_update";
  handle.refresh();
  assert.equal(handle.mirror.innerHTML, "1girl, masterpiece, programmatic_update");
  assert.ok(!handle.mirror.innerHTML.includes("wtn-hl-tok"), "must be plain immediately -- color is the second phase");
});

test("attachHighlighter's detach() removes the mirror and restores the textarea's original styles", () => {
  const { wrapper, textarea, handle } = makeAttachedFixture();
  textarea.style.color = "#e7ecf3"; // hypothetical pre-existing style, restored on detach
  assert.equal(wrapper.children.length, 2);

  handle.detach();

  assert.equal(wrapper.children.length, 1);
  assert.equal(wrapper.children[0], textarea);
});

test("detach(handle) is a working alias for handle.detach()", () => {
  const { wrapper, handle } = makeAttachedFixture();
  detach(handle);
  assert.equal(wrapper.children.length, 1);
});

test("attachHighlighter never touches keydown/keyup/click -- it only listens for input/scroll (autocomplete owns those)", () => {
  const { textarea } = makeAttachedFixture();
  assert.ok(textarea._listeners.input && textarea._listeners.input.length > 0);
  assert.ok(!textarea._listeners.keydown);
  assert.ok(!textarea._listeners.keyup);
  assert.ok(!textarea._listeners.click);
});

// =========================================================================
// G. name_cache.mjs / optimistic.mjs -- the two-tier paint's tier 1
// =========================================================================

test("normalizeTagName mirrors classify.py's _normalize: underscores -> spaces, casefold, collapse whitespace, trim", () => {
  assert.equal(normalizeTagName("1girl"), "1girl");
  assert.equal(normalizeTagName("blue_hair"), "blue hair");
  assert.equal(normalizeTagName("Blue_Hair"), "blue hair");
  assert.equal(normalizeTagName("  blue   hair  "), "blue hair");
  assert.equal(normalizeTagName("BLUE_HAIR"), "blue hair");
  assert.equal(normalizeTagName(""), "");
  assert.equal(normalizeTagName(null), "");
});

test("NAME_CACHEABLE_SECTIONS contains exactly the 11 identity-stable sections, excluding the 5 syntax-dependent ones", () => {
  const expected = new Set([
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
  assert.deepEqual(NAME_CACHEABLE_SECTIONS, expected);
  for (const excluded of ["comment", "syntax", "wildcard", "translation", "unknown"]) {
    assert.ok(!NAME_CACHEABLE_SECTIONS.has(excluded), `${excluded} must NOT be name-cacheable`);
  }
});

test("rememberToken populates the cache from a classify-response-shaped token, and lookupTagName reuses it", () => {
  rememberToken({ start: 0, end: 5, base: "1girl", section: "general", label: "Trained tag" });
  assert.deepEqual(lookupTagName("1girl"), { section: "general", label: "Trained tag" });
  // Reused across a differently-spelled occurrence of the SAME tag --
  // underscored, uppercased, padded -- exactly the "user re-typing a
  // known tag" case the optimistic pass is built for.
  assert.deepEqual(lookupTagName("  1GIRL  "), { section: "general", label: "Trained tag" });
});

test("rememberToken falls back to `text` when `base` is missing", () => {
  rememberToken({ start: 0, end: 11, text: "masterpiece", section: "quality" });
  assert.deepEqual(lookupTagName("masterpiece"), { section: "quality", label: "" });
});

test("rememberToken is a no-op for a token with no usable base/text, or a malformed token", () => {
  rememberToken({ start: 0, end: 1, section: "general" }); // no base, no text
  assert.equal(lookupTagName(""), null);
  assert.doesNotThrow(() => rememberToken(null));
  assert.doesNotThrow(() => rememberToken(undefined));
  assert.doesNotThrow(() => rememberToken("not-an-object"));
  assert.equal(nameCacheSize(), 0);
});

test("rememberToken does NOT cache a syntax-dependent section (comment/syntax/wildcard/translation/unknown)", () => {
  for (const section of ["comment", "syntax", "wildcard", "translation", "unknown"]) {
    rememberToken({ start: 0, end: 4, base: `tag_${section}`, section });
  }
  for (const section of ["comment", "syntax", "wildcard", "translation", "unknown"]) {
    assert.equal(lookupTagName(`tag_${section}`), null, `${section} must not be name-cached`);
  }
  assert.equal(nameCacheSize(), 0);
});

test("rememberTokens populates from every token in a classify response array in one call", () => {
  rememberTokens([
    { start: 0, end: 5, base: "1girl", section: "general" },
    { start: 7, end: 12, base: "smile", section: "general" },
    { start: 14, end: 25, base: "masterpiece", section: "quality" },
  ]);
  assert.equal(nameCacheSize(), 3);
  assert.equal(lookupTagName("smile").section, "general");
  assert.equal(lookupTagName("masterpiece").section, "quality");
});

test("rememberTokens is a safe no-op for a non-array input", () => {
  assert.doesNotThrow(() => rememberTokens(null));
  assert.doesNotThrow(() => rememberTokens("not-an-array"));
  assert.equal(nameCacheSize(), 0);
});

test("the name cache is bounded -- oldest entries are evicted once maxEntries is exceeded", () => {
  for (let i = 0; i < 5; i += 1) {
    rememberToken({ start: 0, end: 1, base: `tag_${i}`, section: "general" }, { maxEntries: 3 });
  }
  assert.equal(nameCacheSize(), 3);
  assert.equal(lookupTagName("tag_0"), null, "oldest entries must have been evicted");
  assert.equal(lookupTagName("tag_1"), null);
  assert.ok(lookupTagName("tag_4"), "the most recently remembered entry must survive");
});

test("splitApproxTagSpans splits on comma/newline/full-width comma, marking delimiters", () => {
  const spans = splitApproxTagSpans("1girl,solo\nsmile，masterpiece");
  const nonDelims = spans.filter((s) => !s.delimiter).map((s) => s.text);
  const delims = spans.filter((s) => s.delimiter).map((s) => s.text);
  assert.deepEqual(nonDelims, ["1girl", "solo", "smile", "masterpiece"]);
  assert.deepEqual(delims, [",", "\n", "，"]);
});

test("splitApproxTagSpans does NOT split a comma inside a weighted paren group, e.g. (a, b:1.2)", () => {
  const spans = splitApproxTagSpans("1girl, (a, b:1.2), solo");
  const nonDelims = spans.filter((s) => !s.delimiter).map((s) => s.text.trim());
  assert.deepEqual(nonDelims, ["1girl", "(a, b:1.2)", "solo"]);
});

test("approxTagBase strips a (tag:1.2) weight wrapper and a trailing bare colon", () => {
  assert.equal(approxTagBase("(masterpiece:1.3)"), "masterpiece");
  assert.equal(approxTagBase("1girl:"), "1girl");
  assert.equal(approxTagBase("  1girl  "), "1girl");
  assert.equal(approxTagBase("solo"), "solo");
});

test("buildOptimisticSpans colors a tag body found in the name cache, in the SAME span shape buildSpans produces", () => {
  rememberToken({ start: 0, end: 5, base: "1girl", section: "general", label: "Trained tag" });
  const spans = buildOptimisticSpans("1girl, solo");
  const tagSpan = spans.find((s) => s.text === "1girl");
  assert.ok(tagSpan, "the cached tag must produce a real (non-gap) span");
  assert.equal(tagSpan.gap, false);
  assert.equal(tagSpan.section, "general");
  assert.equal(tagSpan.label, "Trained tag");
  // Same shape as classify.mjs's buildSpans output -- renderMirrorHtml/
  // spanHtml don't need to know which builder produced a span.
  for (const key of ["start", "end", "text", "section", "label", "known", "weighted", "count", "gap"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(tagSpan, key), `optimistic span missing '${key}'`);
  }
  const uncached = spans.find((s) => s.text === "solo");
  assert.equal(uncached.gap, true, "a tag not in the cache renders as a plain gap span");
});

test("buildOptimisticSpans renders an unfamiliar (never-cached) prompt entirely plain -- no regression vs. the old paintPlain", () => {
  const spans = buildOptimisticSpans("brand_new_tag, another_unknown_one");
  assert.ok(spans.every((s) => s.gap === true || s.section === null));
});

test("buildOptimisticSpans handles a weighted cached tag: (masterpiece:1.3) still resolves via its unwrapped base", () => {
  rememberToken({ start: 0, end: 11, base: "masterpiece", section: "quality" });
  const spans = buildOptimisticSpans("(masterpiece:1.3), 1girl");
  const weightedSpan = spans.find((s) => s.text.trim() === "(masterpiece:1.3)");
  assert.ok(weightedSpan);
  assert.equal(weightedSpan.section, "quality");
});

// ---- End-to-end via attachHighlighter -----------------------------------

test("attachHighlighter's initial paint colors a cache-known tag OPTIMISTICALLY, with zero fetch calls made yet", () => {
  rememberToken({ start: 0, end: 5, base: "1girl", section: "general", label: "Trained tag" });
  const { handle, fetchCalls } = makeAttachedFixture({ initialValue: "1girl, brand_new_tag" });
  // No timers.flush()/delay() -- the debounced classify hasn't fired, let
  // alone resolved, so this MUST be true synchronously, right after attach.
  assert.equal(fetchCalls.length, 0, "no network call has happened yet");
  assert.ok(handle.mirror.innerHTML.includes("wtn-hl-tok"), "the cached tag must already be colored");
  assert.match(handle.mirror.innerHTML, /data-section="general"/);
});

test("attachHighlighter's initial paint renders an uncached tag plain -- optimistic degrades gracefully, exactly like the old paintPlain", () => {
  const { handle, fetchCalls } = makeAttachedFixture({ initialValue: "totally_unseen_tag, another_one" });
  assert.equal(fetchCalls.length, 0);
  assert.ok(!handle.mirror.innerHTML.includes("wtn-hl-tok"), "nothing in the cache -- must stay plain until classify resolves");
});

await asyncTest(
  "the authoritative paint still REPLACES an optimistic one for identical text -- the guard trap, now with a third paint kind",
  async () => {
    // Seed the cache with a WRONG guess for this tag (as if it had been
    // seen with a different classification once before), then let the
    // backend's fake response return the CORRECT section for the same
    // span -- the authoritative repaint must win, not the stale guess.
    rememberToken({ start: 0, end: 6, base: "figure", section: "general" });
    const { timers, handle } = makeAttachedFixture({
      initialValue: "figure, solo",
      fetchImpl: (url, init) => {
        const { text } = JSON.parse(init.body);
        return Promise.resolve(
          jsonResponse({ tokens: [{ start: 0, end: 6, section: "character", label: "Character", base: "figure" }] }),
        );
      },
    });

    // Right after attach: optimistically painted from the (wrong) cached guess.
    assert.ok(handle.mirror.innerHTML.includes("wtn-hl-tok"));
    assert.match(handle.mirror.innerHTML, /data-section="general"/, "optimistic guess painted first");

    timers.flush();
    await delay(0);

    // The authoritative response disagrees with the optimistic guess for
    // the SAME text -- if the churn guard treated "optimistic" as fully
    // satisfying "this text is painted", this repaint would have been
    // (wrongly) skipped and the mirror would still show the stale guess.
    assert.match(handle.mirror.innerHTML, /data-section="character"/, "authoritative classification must win");
    assert.ok(!handle.mirror.innerHTML.includes('data-section="general"'), "the stale optimistic guess must be gone");

    // And the authoritative response taught the cache the CORRECTED section.
    assert.equal(lookupTagName("figure").section, "character");
  },
);

test("a repeated optimistic paint for text already painted (in EITHER kind) is suppressed -- no downgrade of an authoritative paint back to a guess", () => {
  rememberToken({ start: 0, end: 5, base: "1girl", section: "general" });
  const { textarea, handle } = makeAttachedFixture({ initialValue: "1girl" });
  const optimisticHtml = handle.mirror.innerHTML;
  assert.ok(optimisticHtml.includes("wtn-hl-tok"));

  // Re-firing 'input' with the SAME text must not force a fresh optimistic
  // re-render (it would be a no-op even if it did, but this proves the
  // guard actually short-circuits rather than silently re-computing).
  fire(textarea, "input");
  assert.equal(handle.mirror.innerHTML, optimisticHtml);
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
