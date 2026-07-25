/**
 * test_tag_insert.mjs — regression tests for the tag-autocomplete INSERTION
 * fix (two bugs, one function):
 *
 *   Bug 1 (underscores): booru tag NAMES use `_` as a word-joiner, but
 *   trained models (Anima included) see the space form -- accepting a
 *   completion must not insert `looking_at_viewer` into the prompt.
 *   Bug 2 (literal parens): `(`/`)` are ComfyUI/A1111 attention-weighting
 *   syntax, so a tag like `fate_(series)` must land as `fate \(series\)`,
 *   not `fate (series)` (which would emphasize "series").
 *
 * `core.mjs`'s `tagToPromptText` is the pure fix; `interaction.mjs` is
 * wired to route the committed replacement through it instead of using
 * `item.tag` verbatim. Display (`render.mjs`) and search/matching (the
 * `/wtn/autocomplete` API, Python-side) are UNCHANGED -- this is an
 * insertion-only fix, asserted here only via a source-level grep on
 * `interaction.mjs` (see below for why).
 *
 * Run directly: `node js/autocomplete/test_tag_insert.mjs` (plain script,
 * no test framework -- matches the project's `python tests/test_x.py`
 * convention, and this pack's own `js/**\/test_resize.mjs` files).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { tagToPromptText } from "./core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// =========================================================================
// tagToPromptText — underscores -> spaces
// =========================================================================

test("underscored tags become space-separated prompt text", () => {
  assert.equal(tagToPromptText("looking_at_viewer"), "looking at viewer");
  assert.equal(tagToPromptText("blue_eyes"), "blue eyes");
});

test("a tag with no underscore is unchanged", () => {
  assert.equal(tagToPromptText("1girl"), "1girl");
  assert.equal(tagToPromptText("solo"), "solo");
});

// =========================================================================
// tagToPromptText — literal parentheses escaping
// =========================================================================

test("literal parens are backslash-escaped after the underscore->space swap", () => {
  assert.equal(tagToPromptText("fate_(series)"), "fate \\(series\\)");
  assert.equal(tagToPromptText("star_(symbol)"), "star \\(symbol\\)");
});

test("an already-escaped tag is not double-escaped", () => {
  assert.equal(tagToPromptText("fate_\\(series\\)"), "fate \\(series\\)");
});

// =========================================================================
// tagToPromptText — leading `@` artist marker
// =========================================================================

test("a leading @ artist marker is preserved, not stripped or space-separated", () => {
  assert.equal(tagToPromptText("@wlop"), "@wlop");
});

test("an underscored artist tag still gets its own underscore converted, @ preserved", () => {
  assert.equal(tagToPromptText("@some_artist"), "@some artist");
});

// =========================================================================
// tagToPromptText — casing preserved (deliberate divergence from the
// reference pack's normalize_tag, which lowercases for lookup/dedupe; this
// is an INSERTION function, so a tag's own casing must survive verbatim)
// =========================================================================

test("casing is preserved -- NOT lowercased", () => {
  const result = tagToPromptText("Fate_(Series)");
  assert.equal(result, "Fate \\(Series\\)");
  assert.notEqual(result, result.toLowerCase(), "expected mixed case to survive, not be lowercased");
});

// =========================================================================
// tagToPromptText — whitespace collapse / trim
// =========================================================================

test("whitespace is trimmed and internal runs collapsed to a single space", () => {
  assert.equal(tagToPromptText("  blue   eyes  "), "blue eyes");
  assert.equal(tagToPromptText("blue___eyes"), "blue eyes");
});

// =========================================================================
// tagToPromptText — empty / null / undefined input never throws
// =========================================================================

test("empty string, null, and undefined all return an empty string without throwing", () => {
  assert.equal(tagToPromptText(""), "");
  assert.equal(tagToPromptText("   "), "");
  assert.equal(tagToPromptText(null), "");
  assert.equal(tagToPromptText(undefined), "");
});

// =========================================================================
// interaction.mjs — source-level assertion that the commit path actually
// routes through tagToPromptText. This is a source-grep, not a live DOM
// exercise, because `interaction.mjs` (like `index.js` in
// js/anima_prompt/anima_prompt_studio/test_resize.mjs) touches real
// textarea/document APIs (`el.value`, `setSelectionRange`,
// `dispatchEvent`) that only resolve inside a real browser/ComfyUI host,
// not this headless `node` runner.
// =========================================================================

const interactionSource = readFileSync(path.join(__dirname, "interaction.mjs"), "utf8");

test("interaction.mjs imports tagToPromptText from core.mjs", () => {
  assert.match(interactionSource, /import\s*\{[^}]*\btagToPromptText\b[^}]*\}\s*from\s*"\.\/core\.mjs"/);
});

test("interaction.mjs's commitSelected passes tagToPromptText(item.tag) -- not the raw item.tag -- to commitToken", () => {
  const idx = interactionSource.indexOf("function commitSelected");
  const body = interactionSource.slice(idx, interactionSource.indexOf("\n  }", idx));
  assert.match(body, /tagToPromptText\(item\.tag\)/);
  assert.match(body, /commitToken\(\s*el\.value,\s*state\.tokenStart,\s*state\.tokenEnd,\s*replacement\s*\)/);
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
