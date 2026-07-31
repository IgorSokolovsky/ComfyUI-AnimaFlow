/**
 * test_civitai_thumb.mjs — regression tests for `civitai_thumb.mjs`'s pure
 * helpers (`levelLabelToInt`, `pickThumbCandidates`, `thumbState`,
 * `advanceThumbAttempt`) plus a minimal DOM-level check of `attachThumbCandidate`
 * itself, via a tiny stub element (mirroring every other track's own
 * `makeDocStub` convention -- see `js/controls/test_model_picker.mjs`'s top
 * doc comment for why each keeps its own copy rather than sharing one).
 *
 * These tests were moved here from `js/controls/test_civitai_search.mjs`
 * (unchanged, module import aside) when the mechanism itself moved to
 * `civitai_thumb.mjs` -- see that file's own top doc comment for the "why".
 * `test_civitai_search.mjs` keeps its own DOM-level integration coverage of
 * the search card's `buildThumb` (which now calls this module's
 * `attachThumbCandidate`), and `test_model_info.mjs` covers the ⓘ panel's own
 * `renderThumb` the same way.
 *
 * Plain `node js/shared/test_civitai_thumb.mjs`.
 */

import assert from "node:assert/strict";

import {
  levelLabelToInt,
  pickThumbCandidates,
  thumbState,
  advanceThumbAttempt,
  THUMB_RETRY_BACKOFF_MS,
  attachThumbCandidate,
  THUMB_SKELETON_CLASS,
  THUMB_SKELETON_CSS,
} from "./civitai_thumb.mjs";

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
// levelLabelToInt / pickThumbCandidates / thumbState / advanceThumbAttempt.
// Pure, DOM-free.
// =========================================================================

test("levelLabelToInt: each label maps to Civitai's own bitmask value", () => {
  assert.equal(levelLabelToInt("PG"), 1);
  assert.equal(levelLabelToInt("PG-13"), 2);
  assert.equal(levelLabelToInt("R"), 4);
  assert.equal(levelLabelToInt("X"), 8);
  assert.equal(levelLabelToInt("XXX"), 16);
});

test("levelLabelToInt: a garbage/unrecognised/missing label degrades to 1 (PG), the most conservative, never throws", () => {
  assert.equal(levelLabelToInt("nope"), 1);
  assert.equal(levelLabelToInt(""), 1);
  assert.equal(levelLabelToInt(undefined), 1);
  assert.equal(levelLabelToInt(null), 1);
});

test("pickThumbCandidates: an image passes iff its own nsfw_level is at or below the chosen level -- exercised at each of the five levels", () => {
  const images = [
    { url: "pg.jpg", nsfw_level: 1, type: "image" },
    { url: "pg13.jpg", nsfw_level: 2, type: "image" },
    { url: "r.jpg", nsfw_level: 4, type: "image" },
    { url: "x.jpg", nsfw_level: 8, type: "image" },
    { url: "xxx.jpg", nsfw_level: 16, type: "image" },
  ];
  assert.deepEqual(pickThumbCandidates(images, 1), ["pg.jpg"]);
  assert.deepEqual(pickThumbCandidates(images, 2), ["pg.jpg", "pg13.jpg"]);
  assert.deepEqual(pickThumbCandidates(images, 4), ["pg.jpg", "pg13.jpg", "r.jpg"]);
  assert.deepEqual(pickThumbCandidates(images, 8), ["pg.jpg", "pg13.jpg", "r.jpg", "x.jpg"]);
  assert.deepEqual(pickThumbCandidates(images, 16), ["pg.jpg", "pg13.jpg", "r.jpg", "x.jpg", "xxx.jpg"]);
});

test("pickThumbCandidates: preserves Civitai's own gallery order -- never re-sorts by level", () => {
  const images = [
    { url: "second.jpg", nsfw_level: 4, type: "image" },
    { url: "first.jpg", nsfw_level: 1, type: "image" },
  ];
  assert.deepEqual(pickThumbCandidates(images, 16), ["second.jpg", "first.jpg"]);
});

test("pickThumbCandidates: a null/absent per-image nsfw_level is treated as 16 (XXX) -- conservative, never leaks below the user's own setting", () => {
  const images = [
    { url: "unlabelled.jpg", nsfw_level: null },
    { url: "also-unlabelled.jpg" },
  ];
  assert.deepEqual(pickThumbCandidates(images, 8), [], "neither passes at X -- an unlabelled image is treated as XXX");
  assert.deepEqual(pickThumbCandidates(images, 16), ["unlabelled.jpg", "also-unlabelled.jpg"], "both pass once the level itself is XXX");
});

test("pickThumbCandidates: garbage/non-array images, and a garbage/non-finite level (defaults to 1/PG), never throw", () => {
  assert.deepEqual(pickThumbCandidates(null, 16), []);
  assert.deepEqual(pickThumbCandidates(undefined, 16), []);
  assert.deepEqual(pickThumbCandidates("not-an-array", 16), []);
  const images = [{ url: "a.jpg", nsfw_level: 1 }, { url: "b.jpg", nsfw_level: 4 }];
  assert.deepEqual(pickThumbCandidates(images, NaN), ["a.jpg"], "a garbage level defaults to 1 (PG)");
  assert.deepEqual(pickThumbCandidates(images, undefined), ["a.jpg"]);
});

test("pickThumbCandidates: an entry with no usable url is skipped, never a blank/garbage src", () => {
  const images = [{ nsfw_level: 1 }, { url: "", nsfw_level: 1 }, { url: "ok.jpg", nsfw_level: 1 }];
  assert.deepEqual(pickThumbCandidates(images, 16), ["ok.jpg"]);
});

test("thumbState: gated wins over everything, even a non-empty images array that would otherwise be 'image'", () => {
  assert.equal(thumbState("gated", [{ url: "x.jpg", nsfw_level: 1 }], 16), "gated");
});

test("thumbState: 'placeholder' for genuinely empty/garbage images (not gated)", () => {
  assert.equal(thumbState("available", [], 16), "placeholder");
  assert.equal(thumbState("available", null, 16), "placeholder");
  assert.equal(thumbState("available", undefined, 16), "placeholder");
});

test("thumbState: 'locked' when images is non-empty but NOTHING passes the chosen level -- distinct from 'placeholder'", () => {
  const images = [{ url: "xxx.jpg", nsfw_level: 16 }];
  assert.equal(thumbState("available", images, 1), "locked", "an XXX-only gallery at the PG setting is locked, not placeholder");
  assert.equal(thumbState("installed", images, 1), "locked", "the caller's OWN state (installed/downloading/available) never changes this -- only 'gated' does");
});

test("thumbState: 'image' once at least one candidate passes", () => {
  const images = [{ url: "xxx.jpg", nsfw_level: 16 }, { url: "pg.jpg", nsfw_level: 1 }];
  assert.equal(thumbState("available", images, 1), "image");
});

test("advanceThumbAttempt: a single candidate -- first failure retries the SAME index, second failure exhausts (no more candidates)", () => {
  const candidates = ["only.jpg"];
  const first = advanceThumbAttempt(candidates, undefined);
  assert.deepEqual(first, { action: "retry", index: 0 });
  const second = advanceThumbAttempt(candidates, { index: 0, retried: true });
  assert.deepEqual(second, { action: "exhausted", index: 1 });
});

test("advanceThumbAttempt: two candidates -- retry candidate 0, then advance to candidate 1, then retry candidate 1, then exhaust", () => {
  const candidates = ["a.jpg", "b.jpg"];
  const step1 = advanceThumbAttempt(candidates, undefined); // candidates[0] just failed for the first time
  assert.deepEqual(step1, { action: "retry", index: 0 });
  const step2 = advanceThumbAttempt(candidates, { index: 0, retried: true }); // the retry ALSO failed
  assert.deepEqual(step2, { action: "advance", index: 1 });
  const step3 = advanceThumbAttempt(candidates, { index: 1, retried: false }); // candidates[1] just failed for the first time
  assert.deepEqual(step3, { action: "retry", index: 1 });
  const step4 = advanceThumbAttempt(candidates, { index: 1, retried: true }); // its own retry also failed
  assert.deepEqual(step4, { action: "exhausted", index: 2 });
});

test("advanceThumbAttempt: an empty/garbage candidates list is immediately exhausted, never throws", () => {
  assert.deepEqual(advanceThumbAttempt([], undefined), { action: "exhausted", index: 0 });
  assert.deepEqual(advanceThumbAttempt(null, undefined), { action: "exhausted", index: 0 });
  // `index` is already out of bounds against an empty list regardless of
  // `retried` -- the "index >= length" check fires before that flag is ever
  // consulted, so the returned index is the UNCHANGED input index (0), not
  // incremented.
  assert.deepEqual(advanceThumbAttempt(undefined, { index: 0, retried: true }), { action: "exhausted", index: 0 });
});

// =========================================================================
// attachThumbCandidate -- the ONE DOM driver in this module. A minimal stub
// element (not a full doc stub -- this function only ever touches the
// elements it's directly handed) exercises the caller-supplied `onExhausted`
// callback, which is the whole reason this isn't hardcoded to a single
// placeholder here (two different callers, two different CSS vocabularies
// for "locked" vs "placeholder" -- see this module's own top doc comment).
// =========================================================================

function makeStubDoc() {
  return {
    createElement(tag) {
      return {
        tagName: tag, _listeners: {}, children: [], src: "", alt: "", loading: "", referrerPolicy: "",
        parentNode: null,
        appendChild(child) {
          this.children.push(child);
          child.parentNode = this;
          return child;
        },
        removeChild(child) {
          const i = this.children.indexOf(child);
          if (i >= 0) {
            this.children.splice(i, 1);
          }
          child.parentNode = null;
          return child;
        },
      };
    },
  };
}

test("attachThumbCandidate: on exhaustion, calls the caller's own onExhausted(doc, thumb) rather than assuming a placeholder shape", () => {
  const doc = makeStubDoc();
  const thumb = doc.createElement("div");
  let exhaustedCalls = 0;
  attachThumbCandidate(doc, thumb, ["only.jpg"], { index: 0, retried: true }, () => false, THUMB_RETRY_BACKOFF_MS, (d, t) => {
    exhaustedCalls += 1;
    assert.equal(d, doc);
    assert.equal(t, thumb);
  });
  const img = thumb.children[0];
  assert.equal(img.src, "only.jpg");
  img.onerror(); // the retry (attempt.retried is already true) -- exhausts immediately, no timer involved
  assert.equal(exhaustedCalls, 1, "onExhausted must be called exactly once on exhaustion");
  assert.equal(thumb.children.includes(img), false, "the failed <img> must be removed before onExhausted runs");
});

test("attachThumbCandidate: isStale() suppresses the onerror handler entirely -- never calls onExhausted for a stale render", () => {
  const doc = makeStubDoc();
  const thumb = doc.createElement("div");
  let exhaustedCalls = 0;
  attachThumbCandidate(doc, thumb, ["only.jpg"], { index: 0, retried: true }, () => true, THUMB_RETRY_BACKOFF_MS, () => {
    exhaustedCalls += 1;
  });
  const img = thumb.children[0];
  img.onerror();
  assert.equal(exhaustedCalls, 0, "a stale render must never call onExhausted");
  assert.equal(thumb.children.includes(img), true, "a stale render must not even remove the <img>");
});

// =========================================================================
// attachThumbCandidate's onLoaded -- the "loading" skeleton's own success
// signal (owner request, 2026-07-31).
// =========================================================================

test("attachThumbCandidate: onload calls the caller's own onLoaded(doc, thumb) exactly once, and never onExhausted", () => {
  const doc = makeStubDoc();
  const thumb = doc.createElement("div");
  let loadedCalls = 0;
  let exhaustedCalls = 0;
  attachThumbCandidate(doc, thumb, ["a.jpg"], { index: 0, retried: false }, () => false, THUMB_RETRY_BACKOFF_MS,
    () => { exhaustedCalls += 1; },
    (d, t) => {
      loadedCalls += 1;
      assert.equal(d, doc);
      assert.equal(t, thumb);
    });
  const img = thumb.children[0];
  img.onload();
  assert.equal(loadedCalls, 1);
  assert.equal(exhaustedCalls, 0, "a successful load must never also report exhaustion");
});

test("attachThumbCandidate: isStale() suppresses onload too -- never calls onLoaded for a stale render", () => {
  const doc = makeStubDoc();
  const thumb = doc.createElement("div");
  let loadedCalls = 0;
  attachThumbCandidate(doc, thumb, ["a.jpg"], { index: 0, retried: false }, () => true, THUMB_RETRY_BACKOFF_MS, () => {}, () => {
    loadedCalls += 1;
  });
  thumb.children[0].onload();
  assert.equal(loadedCalls, 0, "a stale render must never call onLoaded");
});

test("attachThumbCandidate: a retry/advance step never fires onLoaded or onExhausted on its own -- only a genuine load or a true exhaustion do", () => {
  const doc = makeStubDoc();
  const thumb = doc.createElement("div");
  let loadedCalls = 0;
  let exhaustedCalls = 0;
  attachThumbCandidate(doc, thumb, ["a.jpg", "b.jpg"], { index: 0, retried: false }, () => false, 0,
    () => { exhaustedCalls += 1; },
    () => { loadedCalls += 1; });
  thumb.children[0].onerror(); // 1st failure -- queues a (0ms) retry, no terminal callback yet
  assert.equal(loadedCalls, 0);
  assert.equal(exhaustedCalls, 0);
});

// =========================================================================
// THUMB_SKELETON_CLASS / THUMB_SKELETON_CSS -- the shared "loading" state
// (owner request, 2026-07-31). Both consumers splice THIS CSS text into
// their own single stylesheet rather than this module injecting one itself
// -- see its own doc comment.
// =========================================================================

test("THUMB_SKELETON_CSS: styles THUMB_SKELETON_CLASS, animates by default, and drops the animation under prefers-reduced-motion", () => {
  assert.ok(THUMB_SKELETON_CSS.includes(`.${THUMB_SKELETON_CLASS}`), "must actually style the class it exports, not just declare the name");
  assert.match(THUMB_SKELETON_CSS, /animation:\s*wtn-thumb-shimmer/, "must animate by default (this is the ONLY thumb state that ever does)");
  assert.match(THUMB_SKELETON_CSS, /@keyframes\s+wtn-thumb-shimmer/, "the animation it references must actually be defined here");
  assert.match(THUMB_SKELETON_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, "reduced motion must be handled in CSS, not a JS branch (task brief)");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exit(1);
}
