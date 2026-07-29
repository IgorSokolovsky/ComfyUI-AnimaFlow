/**
 * test_size.mjs — regression tests for `size.mjs`'s `isSizeLike` predicate,
 * the shared fix for the 2026-07-29 "node.size is a Float64Array, not a
 * plain Array" bug (this file's own top doc comment, and
 * `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`). Plain `node`, no
 * DOM/`app`/`window` — same convention as every other `test_*.mjs` in this
 * pack.
 *
 * The Float64Array-shaped, guard-actually-fires regression coverage lives in
 * EACH track's own `test_resize.mjs` (`js/controls/test_resize.mjs`,
 * `js/anima/test_resize.mjs`) — this file only covers the predicate itself,
 * in isolation, since `js/shared/` must never import a track
 * (`js/shared/test_field_logic.mjs`'s own layering-guard test).
 */

import assert from "node:assert/strict";

import { isSizeLike } from "./size.mjs";

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

// ---------------------------------------------------------------------------
// The exact spec from the dispatch: plain array v, Float64Array v, too-short
// x, non-numeric x, null/undefined x, a string x.
// ---------------------------------------------------------------------------

test("isSizeLike: a plain [w, h] array is size-like", () => {
  assert.equal(isSizeLike([100, 200]), true);
});

test("isSizeLike: a Float64Array [w, h] is size-like -- the EXACT live shape node.size actually is (Array.isArray returns false for this, which is the whole bug)", () => {
  assert.equal(isSizeLike(Float64Array.from([100, 200])), true);
  assert.equal(Array.isArray(Float64Array.from([100, 200])), false, "sanity check: this is genuinely not a plain Array");
});

test("isSizeLike: too short (length < minLength) is rejected", () => {
  assert.equal(isSizeLike([100]), false); // length 1, default minLength 2
  assert.equal(isSizeLike([]), false);
  assert.equal(isSizeLike(Float64Array.from([100])), false);
});

test("isSizeLike: non-numeric entries are rejected", () => {
  assert.equal(isSizeLike(["a", "b"]), false);
  assert.equal(isSizeLike([100, "b"]), false);
  assert.equal(isSizeLike([NaN, 200]), false);
  assert.equal(isSizeLike([100, Infinity]), false);
  assert.equal(isSizeLike([null, 200]), false);
  assert.equal(isSizeLike([undefined, 200]), false);
});

test("isSizeLike: null/undefined is rejected", () => {
  assert.equal(isSizeLike(null), false);
  assert.equal(isSizeLike(undefined), false);
});

test("isSizeLike: a string is rejected outright, even a numeric-looking one whose .length would otherwise satisfy minLength", () => {
  assert.equal(isSizeLike("100,200"), false);
  assert.equal(isSizeLike("12"), false); // length 2, but entries are characters, not numbers
});

// ---------------------------------------------------------------------------
// minLength -- the width-only ([w]) check js/anima/render.mjs's
// clampMinWidth needs, distinct from the default full [w, h] pair check.
// ---------------------------------------------------------------------------

test("isSizeLike: minLength 1 only requires (and only checks) index 0", () => {
  assert.equal(isSizeLike([100], 1), true);
  assert.equal(isSizeLike([100, "garbage"], 1), true, "index 1 isn't checked at all when minLength is 1");
  assert.equal(isSizeLike(Float64Array.from([100, 200]), 1), true);
  assert.equal(isSizeLike([], 1), false);
  assert.equal(isSizeLike(["a"], 1), false);
});

// ---------------------------------------------------------------------------
// Other indexable shapes -- an object that merely duck-types the same
// contract (a real Rectangle-backed view isn't a Float64Array in every
// possible litegraph build, so the predicate must not hardcode that one
// constructor either).
// ---------------------------------------------------------------------------

test("isSizeLike: an arbitrary indexable object with a numeric .length and finite entries is accepted -- duck-typed, not constructor-checked", () => {
  assert.equal(isSizeLike({ 0: 100, 1: 200, length: 2 }), true);
});

test("isSizeLike: a plain object with no .length is rejected", () => {
  assert.equal(isSizeLike({ width: 100, height: 200 }), false);
});

test("isSizeLike: never throws, even for a Proxy wrapping a Float64Array -- TypedArray.prototype.length's getter brand-checks its receiver and throws for exactly this shape, which a duck-typing predicate must swallow rather than propagate", () => {
  const proxied = new Proxy(Float64Array.from([100, 200]), {});
  assert.doesNotThrow(() => isSizeLike(proxied));
});

test("isSizeLike: writes through the value it validated actually land -- Float64Array included", () => {
  const arr = [100, 200];
  assert.ok(isSizeLike(arr));
  arr[0] = 999;
  assert.equal(arr[0], 999);

  const f64 = Float64Array.from([100, 200]);
  assert.ok(isSizeLike(f64));
  f64[1] = 555;
  assert.equal(f64[1], 555, "writing through a Float64Array entry must work exactly like a plain array");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
