/**
 * civitai_thumb.mjs — the level-aware Civitai THUMBNAIL CANDIDATE picker,
 * extracted from `js/controls/civitai_search.mjs` (`docs/lora-loader-
 * design.md` §7c-iv) so the ⓘ info panel (`js/controls/model_info.mjs`) can
 * share it rather than carry a second copy.
 *
 * ## Why this had to move (not just get imported one-way)
 *
 * `d1274a4` added `levelLabelToInt`/`pickThumbCandidates`/`thumbState`/
 * `advanceThumbAttempt`/`THUMB_RETRY_BACKOFF_MS`/`attachThumbCandidate` to
 * `civitai_search.mjs` for the search-result card. The design doc's own
 * "level governs the ⓘ panel too" section (§7c-iv) is explicit that the ⓘ
 * panel needs **exactly the same behaviour** — same retry-then-advance rule,
 * same `locked` state, same "unknown level counts as 16" — not a rewrite of
 * it. `docs/TODO.md`'s "Shells and Core Mechanics" item names this exact
 * failure mode: a mechanic duplicated across two surfaces is how this
 * codebase has shipped the same bug twice. So the mechanism lives here now,
 * and `civitai_search.mjs` re-exports the pure functions under their
 * original names (so its own existing imports/tests keep working unchanged)
 * while importing `attachThumbCandidate` directly for its own `buildThumb`.
 *
 * ## What's pure vs. DOM here
 *
 * `levelLabelToInt`/`pickThumbCandidates`/`thumbState`/`advanceThumbAttempt`
 * are pure, DOM-free (no `doc`/`window` reference anywhere) — directly
 * testable under plain `node` (`test_civitai_thumb.mjs`). `attachThumbCandidate`
 * is the one DOM driver, a thin wrapper around `advanceThumbAttempt`'s state
 * machine; see its own doc comment for the `onExhausted`/`onLoaded` callbacks
 * that let each caller decide what final element to show (a search card's
 * `wtn-cs-thumb-ph` placeholder vs. the ⓘ panel's `wtn-mi-thumb-ph`/
 * `wtn-mi-thumb-locked` — two different CSS vocabularies, one mechanism) and
 * when to clear its own `THUMB_SKELETON_CLASS` "loading" overlay (below).
 *
 * ## The "locked" state is a PRE-CHECK, not a post-exhaustion guess
 *
 * `thumbState` decides `"locked"` vs `"image"` vs `"placeholder"` BEFORE any
 * `<img>` is ever attempted, purely from the candidate list and the user's
 * chosen level. Once `attachThumbCandidate` is actually running (the
 * `"image"` state), its own exhaustion (every level-PASSING candidate failed
 * to *load*) always falls back to the plain placeholder, never re-derives
 * `"locked"` — a candidate that passed the level but 404s is "broken", not
 * "hidden by your setting", and conflating the two would misreport the
 * reason. Both call sites keep this same split.
 *
 * ## An EMPTY `images` list can also mean "locked" (owner-reported, 2026-07-31)
 *
 * "Blank thumbnails in the modal" — several cards rendered a bare placeholder
 * that was actually the §7c-iv PG consequence: at level PG the server sends
 * `nsfw=false`, Civitai trims the gallery to level-1 images, and a model with
 * none passing arrives with `images: []`, indistinguishable from a model that
 * genuinely has no gallery at all. `hasNsfwAboveLevel`, below, is what breaks
 * the tie: each search result ALSO carries its own top-level `nsfw_level`, a
 * bitmask UNION of every level the model's *whole* gallery spans (not just
 * what a `images: []`-trimmed response returned) — if any bit above the
 * user's level is set there, the model provably has hidden pictures, and
 * `thumbState` now renders `"locked"` for that case instead of the plain
 * placeholder. Never compared with `<=`/`<` (that trap is this function's own
 * doc comment) — a model-level mask is a union, not an ordinal.
 */

import { CIVITAI_SEARCH_LEVEL_TO_INT } from "./settings.mjs";

// ---------------------------------------------------------------------------
// Pure -- no DOM, no `doc`/`window` reference anywhere below (this file's
// only import, `settings.mjs`, is itself track-agnostic and DOM-free).
// ---------------------------------------------------------------------------

/** The "maximum browsing level" setting's own label string ("PG".."XXX",
 * `../shared/settings.mjs`'s `CIVITAI_SEARCH_LEVEL_OPTIONS`) -> Civitai's
 * numeric bitmask value (`1` PG / `2` PG-13 / `4` R / `8` X / `16` XXX) --
 * the one place either consumer converts between the two. An unrecognised/
 * garbage label (a hand-edited `comfy.settings.json`, or simply a value from
 * before this setting existed) degrades to `1` (PG), the most conservative
 * of the five, never throws. */
export function levelLabelToInt(label) {
  return CIVITAI_SEARCH_LEVEL_TO_INT[label] || 1;
}

/** The ordered candidate thumbnail URLs out of a version's own `images`
 * array (§7c-iv) -- every entry whose `nsfw_level` is at or below `level`,
 * in Civitai's own order, URLs only (a caller only ever needs the next URL
 * to try, never the whole image object). **A `null`/absent per-image
 * `nsfw_level` is treated as `16` (XXX)** -- conservative, so an unlabelled
 * image never leaks below the user's own setting; every image measured
 * against the live API carried a level, so this should be rare in practice
 * (design doc §7c-iv). Garbage/non-array `images`, or a garbage/non-finite
 * `level` (defaults to `1`, PG), degrade rather than throw. Comparing a
 * SINGLE image's own `nsfw_level` with `<=` is safe -- unlike the model-level
 * `nsfw_level`, which is a bitmask UNION across every image and must never
 * be compared ordinally, one image carries exactly one level, so `1 < 2 < 4
 * < 8 < 16` is a genuine ordering for this comparison. */
export function pickThumbCandidates(images, level) {
  const list = Array.isArray(images) ? images : [];
  const lvl = Number.isFinite(level) ? level : 1;
  return list
    .filter((img) => img && typeof img.url === "string" && img.url)
    .filter((img) => (Number.isFinite(img.nsfw_level) ? img.nsfw_level : 16) <= lvl)
    .map((img) => img.url);
}

/** Civitai's own per-image `nsfwLevel` bit values, in ascending order -- the
 * five single bits a MODEL-level `nsfw_level` can union together (see
 * `hasNsfwAboveLevel`'s own doc comment, below). Kept as one named list
 * rather than re-deriving it from `CIVITAI_SEARCH_LEVEL_TO_INT` so this
 * file's own bit-test never depends on `settings.mjs`'s label strings. */
const NSFW_LEVEL_BITS = [1, 2, 4, 8, 16];

/**
 * Whether `mask` (a model's own top-level `nsfw_level` -- a BITMASK UNION of
 * every level its gallery spans, `civitai_search.py`'s `_parse_search_item`)
 * has ANY bit set above `level`, i.e. whether the model genuinely has at
 * least one gallery image the user's own browsing-level setting would hide.
 *
 * **A bitmask union must never be compared with `<=`/`<` as if it were an
 * ordinal** (owner brief, §7c-iv's own trap): a model whose gallery spans PG
 * AND XXX carries `mask === 17` (`1 | 16`), which is numerically `> 1` even
 * at the PG level though it plainly has PG images too, and a model at the
 * union `31` (every level) is not "worse" than one at `16` in any ordinal
 * sense. This function therefore tests each of Civitai's five DEFINED single
 * bits individually -- true iff at least one bit STRICTLY GREATER than
 * `level` is actually set in `mask`.
 *
 * `mask` absent/non-finite/`<= 0` (no `nsfw_level` at all, or a model with
 * a `0`/negative one) degrades to `false` -- "we don't know of anything
 * above the level" is the only honest answer without a real mask, and the
 * caller's existing `"placeholder"` fallback already covers "genuinely don't
 * know". Never throws.
 */
export function hasNsfwAboveLevel(mask, level) {
  const m = Number.isFinite(mask) ? mask : 0;
  if (m <= 0) {
    return false;
  }
  const lvl = Number.isFinite(level) ? level : 1;
  return NSFW_LEVEL_BITS.some((bit) => bit > lvl && (m & bit) !== 0);
}

/** The thumbnail BOX's own state (§7c-iv's "fifth card state" -- about the
 * box only, never a caller's own action/download state, which is why
 * `cardState` is the only caller-specific input): `"gated"` when the caller
 * says so (§7c-iii, unchanged by this feature -- a gated card never shows a
 * thumbnail regardless of `images`; `gated` wins over everything below, per
 * that section's own "two padlocks" rule; the ⓘ panel has no such concept and
 * simply never passes it), else, when `images` is genuinely empty: `"locked"`
 * if `modelNsfwLevel` (the MODEL's own top-level `nsfw_level` bitmask union,
 * §7c-iv's build notes -- optional, and distinct from a per-image level)
 * has any bit set above `level` -- the server trimmed this model's gallery to
 * nothing at the caller's own browsing level, but the model plainly HAS
 * pictures above it, so this is the SAME "hidden by your setting" case as a
 * non-empty gallery that all fails the filter, not a genuine absence
 * (owner-reported, 2026-07-31: "why some images are not shown?" -- an empty
 * `images` list is otherwise indistinguishable from a model with no gallery
 * at all). Falls back to the plain `"placeholder"` when `modelNsfwLevel` is
 * absent or carries no bit above `level` -- an honest "we don't know" or
 * "genuinely no gallery," never a guessed reason. Non-empty `images`
 * (unaffected by `modelNsfwLevel`, which only ever disambiguates the EMPTY
 * case) is `"locked"` when NOTHING in it passes `level` (the model has
 * pictures, they're all above the user's own setting), or `"image"` when at
 * least one candidate passes -- `pickThumbCandidates` is what a caller then
 * uses to get the actual URL list to try. */
export function thumbState(cardState, images, level, modelNsfwLevel) {
  if (cardState === "gated") {
    return "gated";
  }
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) {
    return hasNsfwAboveLevel(modelNsfwLevel, level) ? "locked" : "placeholder";
  }
  return pickThumbCandidates(list, level).length > 0 ? "image" : "locked";
}

/** How long to wait before retrying the SAME failed thumbnail URL once
 * (§7c-iv: "retry the same URL once after a short backoff (~400ms)") before
 * advancing to the next candidate. Exported/overridable (both callers' own
 * `thumbRetryBackoffMs`-shaped option) purely so a test can drive this
 * deterministically instead of waiting on a real ~400ms timer. */
export const THUMB_RETRY_BACKOFF_MS = 400;

/**
 * Advances the retry-then-advance state machine (§7c-iv) one failure at a
 * time. Pure and DOM-free so the SEQUENCE itself is directly testable
 * without a real `<img>`/timer -- `attachThumbCandidate`'s own DOM driver,
 * below, is a thin wrapper around this.
 *
 * `<img>.onerror` carries no status code (a timeout, a 404 and a transcode
 * failure are indistinguishable from the error event) -- so this function
 * never looks at WHY a candidate failed, only at how many times THIS one
 * has.
 *
 * `state` is `{index, retried}` describing the candidate that just failed
 * (its position in `candidates`, and whether IT has already been retried
 * once) -- omit for the very first failure of `candidates[0]` (defaults to
 * `{index: 0, retried: false}`). Returns `{action, index}`:
 *   - `"retry"`     -- try `candidates[index]` again (the SAME url) --
 *                      caller waits the backoff first.
 *   - `"advance"`   -- try `candidates[index]` (a NEW, next url) -- no
 *                      backoff; this is a fresh URL, not a repeat.
 *   - `"exhausted"` -- every candidate has now failed (including its own
 *                      retry) -- show the placeholder/locked fallback.
 * Garbage/non-array `candidates` degrades to `[]` (immediately
 * `"exhausted"`), never throws.
 */
export function advanceThumbAttempt(candidates, state) {
  const list = Array.isArray(candidates) ? candidates : [];
  const index = state && Number.isFinite(state.index) ? state.index : 0;
  const retried = !!(state && state.retried);
  if (index >= list.length) {
    return { action: "exhausted", index };
  }
  if (!retried) {
    return { action: "retry", index };
  }
  const nextIndex = index + 1;
  if (nextIndex >= list.length) {
    return { action: "exhausted", index: nextIndex };
  }
  return { action: "advance", index: nextIndex };
}

// ---------------------------------------------------------------------------
// DOM -- the one impure function in this file, plus the shared "loading"
// skeleton (owner request, 2026-07-31: "show loading animation (skeleton)
// while the image is loaded").
// ---------------------------------------------------------------------------

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

/**
 * The shared "candidate image is in flight" skeleton -- a DISTINCT state from
 * the terminal `placeholder`/`locked`/`gated` ones (only `loading` ever
 * animates), and one that must survive the WHOLE retry-then-advance chain --
 * a caller shows exactly ONE of these per `"image"`-state attempt sequence
 * (built once, before the first candidate is even tried) and only removes it
 * once `attachThumbCandidate` calls back with either `onLoaded` (success) or
 * `onExhausted` (every candidate, including its own retry, failed) -- never
 * torn down and rebuilt between an individual retry/advance step, which is
 * exactly what would flash placeholder-look/skeleton/placeholder-look
 * instead of reading as "still working."
 *
 * `THUMB_SKELETON_CSS` is a CSS TEXT SNIPPET, not something this module
 * injects itself -- neither consumer shares a stylesheet host; each
 * (`civitai_search.mjs`/`model_info.mjs`) owns its OWN single `<style>` tag
 * (that file's own `injectStyles`), so this is spliced into that string
 * instead of adding a second one. Sized via `position: absolute; inset: 0`
 * so it overlays a loading (still cross-axis-sized, still-blank) `<img>`
 * without disturbing the thumb box's own flex layout or occupying a flex
 * slot of its own -- REQUIRES the caller's own thumb box to be `position:
 * relative` (`.wtn-cs-thumb`/`.wtn-mi-thumb` both are, in their own CSS).
 * "Fill its container" (owner's own wording) rather than a fixed size --
 * ONE implementation for both the 40px search card and the 58px ⓘ panel.
 *
 * `prefers-reduced-motion` is handled ENTIRELY in this CSS (no JS branch,
 * matching `bedeae4`'s FLIP-drag convention) -- the animation drops to a
 * static tint, never a JS-side check.
 */
export const THUMB_SKELETON_CLASS = "wtn-thumb-skeleton";
export const THUMB_SKELETON_CSS = `
.${THUMB_SKELETON_CLASS} {
  position: absolute; inset: 0; width: 100%; height: 100%;
  background: linear-gradient(90deg, rgba(255,255,255,.04) 25%, rgba(255,255,255,.10) 37%, rgba(255,255,255,.04) 63%);
  background-size: 400% 100%;
  animation: wtn-thumb-shimmer 1.4s ease infinite;
}
@keyframes wtn-thumb-shimmer {
  0% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
@media (prefers-reduced-motion: reduce) {
  .${THUMB_SKELETON_CLASS} { animation: none; background: rgba(255,255,255,.06); }
}
`;

/**
 * Attaches (or re-attaches, on retry/advance) an `<img>` for
 * `candidates[attempt.index]` into `thumb`. The DOM driver behind
 * `advanceThumbAttempt`'s pure state machine (§7c-iv) -- `onload` calls
 * `onLoaded(doc, thumb)` the moment the candidate genuinely renders (the
 * caller's cue to remove its own skeleton, above); `onerror` calls
 * `advanceThumbAttempt`, then either waits `backoffMs` and re-attaches the
 * SAME url (`"retry"`), re-attaches immediately for a NEW url (`"advance"`),
 * or calls `onExhausted(doc, thumb)` (`"exhausted"`) so the CALLER decides
 * what final element to show -- a search card always falls back to its own
 * plain placeholder; the ⓘ panel's identity thumb instead distinguishes
 * `"locked"` from `"placeholder"` there (see `model_info.mjs`'s own
 * `renderThumb`), which is exactly why neither is hardcoded here.
 *
 * `isStale()` is the caller's own render-generation check (mirroring
 * `civitai_search.mjs`'s `renderGeneration` counter / `model_info.mjs`'s own
 * `thumbGeneration`) -- called before EVERY DOM mutation this function or its
 * pending `setTimeout` ever perform (`onload` included), so a card/panel that
 * gets re-rendered mid-retry (a download poll re-rendering the search list
 * every ~800ms; the ⓘ panel re-rendering after a `↻ Civitai`/"Clear cache"
 * round trip) never leaves an orphaned timer -- or a stale success callback
 * -- writing into a thumb box that isn't showing anymore.
 */
export function attachThumbCandidate(doc, thumb, candidates, attempt, isStale, backoffMs, onExhausted, onLoaded) {
  const img = el(doc, "img");
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.onload = () => {
    if (isStale()) {
      return; // this render pass is no longer the current one -- never touch a detached thumb
    }
    if (typeof onLoaded === "function") {
      onLoaded(doc, thumb);
    }
  };
  img.onerror = () => {
    if (isStale()) {
      return; // this render pass is no longer the current one -- never touch a detached thumb
    }
    // `removeChild` (not `.remove()`) so this works against both a real DOM
    // element and this pack's own minimal doc-stub test double.
    if (img.parentNode === thumb && typeof thumb.removeChild === "function") {
      thumb.removeChild(img);
    }
    const result = advanceThumbAttempt(candidates, attempt);
    if (result.action === "exhausted") {
      if (typeof onExhausted === "function") {
        onExhausted(doc, thumb);
      }
      return;
    }
    const nextAttempt = { index: result.index, retried: result.action === "retry" };
    if (result.action === "retry") {
      // Same URL, after a short backoff (§7c-iv) -- `<img>.onerror` carries
      // no status code, so a timeout/404/transcode failure are all handled
      // by this ONE rule.
      setTimeout(() => {
        if (isStale()) {
          return;
        }
        attachThumbCandidate(doc, thumb, candidates, nextAttempt, isStale, backoffMs, onExhausted, onLoaded);
      }, backoffMs);
      return;
    }
    // "advance" -- a genuinely different URL, tried immediately -- no backoff.
    attachThumbCandidate(doc, thumb, candidates, nextAttempt, isStale, backoffMs, onExhausted, onLoaded);
  };
  img.src = candidates[attempt.index];
  thumb.appendChild(img);
}
