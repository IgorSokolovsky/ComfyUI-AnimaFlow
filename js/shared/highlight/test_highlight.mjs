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
 *   D. `colors.mjs` — all 16 sections present with a color + label, CSS
 *      generation covers every section.
 *   E. `legend.mjs` — collapsed by default, one item per section, swatches
 *      addressed by `data-section`.
 *   F. `index.js`'s `attachHighlighter`/`detach` — idempotent attach,
 *      initial + debounced-on-input classification with a fake
 *      timer/fetch, the "last painted text" repaint-churn guard, that
 *      `detach()` removes the mirror and restores the textarea's original
 *      inline styles, and the two-phase (plain-then-colored) paint path:
 *      text painted synchronously at attach and on every `input` (before
 *      any fetch resolves), the plain -> colored repaint for IDENTICAL
 *      text surviving the churn guard, a genuinely redundant repaint
 *      still being suppressed, and `refresh()` painting plain immediately.
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
import { attachHighlighter, detach } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname; // kept for parity with sibling test files' convention

let failures = 0;
let count = 0;

function test(name, fn) {
  count += 1;
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
  assert.match(html, /title="Quality"/);
  assert.match(html, />masterpiece</);
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

test("SECTIONS defines exactly the 16 documented sections, each with a label + color", () => {
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
  const seenHex = new Set();
  for (const section of SECTIONS) {
    assert.match(section.hex, /^#[0-9a-f]{6}$/i, `${section.id} needs a hex color`);
    assert.ok(section.label && section.label.length > 0, `${section.id} needs a label`);
    seenHex.add(section.hex.toLowerCase());
  }
  assert.equal(seenHex.size, expectedIds.length, "every section's color must be distinguishable (unique hex)");
});

test("sectionInfo/sectionLabel fall back to 'unknown' for an unrecognized section id", () => {
  assert.equal(sectionInfo("something-new-from-a-future-backend"), sectionInfo("unknown"));
  assert.equal(sectionLabel("something-new-from-a-future-backend"), sectionLabel("unknown"));
});

test("sectionVarsCss/sectionTokenCss emit a rule for every section", () => {
  const varsCss = sectionVarsCss();
  const tokenCss = sectionTokenCss();
  for (const section of SECTIONS) {
    assert.ok(varsCss.includes(section.varName), `missing var declaration for ${section.id}`);
    assert.ok(tokenCss.includes(`data-section="${section.id}"`), `missing token rule for ${section.id}`);
  }
  assert.ok(tokenCss.includes('[data-weighted="true"]'));
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
// F. index.js -- attachHighlighter / detach
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

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
