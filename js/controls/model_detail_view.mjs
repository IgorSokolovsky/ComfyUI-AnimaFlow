/**
 * model_detail_view.mjs — the model/version DETAIL VIEW (`docs/lora-loader-
 * design.md` §7c-ii / "The detail view" / §7d-i / §7d), built ONCE and
 * mounted TWICE per that section's own table: *"the modal's detail view
 * (which is also the picker's, §7c-ii)"*. This file is the ONE component;
 * `civitai_search.mjs` (the node picker) and `civitai_modal.mjs` (the
 * toolbar modal) each own their own MOUNTING mechanics around it —
 * an anchored, sibling floating panel for the picker (decision 21: "a new
 * VERTICAL info panel... not the modal, not an in-panel swap") vs. a
 * master→detail swap of the results area for the modal (decision 11) — but
 * neither owns a second copy of the actual content: identity, version
 * selector, both descriptions, `View on Civitai ↗`, and the gallery all
 * come from `buildModelDetailView` below, parameterised by `galleryTileWidth`
 * (2026-08-01: both mounts' gallery is now the SAME single horizontally-
 * scrolling filmstrip row, differing only in tile size — see that
 * parameter's own doc comment for the full "why" and its own naming
 * history: it was `layout`, a two-valued `"twoCol"|"filmstrip"` gallery
 * SHAPE switch, before the picker's own gallery became a filmstrip too and
 * left nothing for a "shape" to name — and, before THAT, `"vertical"`/
 * `"grid"`, which had drifted to describe the shape backwards) and, since
 * 2026-08-01, by `fixedTopBar` too (that parameter's own doc comment has the
 * full "why" — the picker and the modal turned out to want DIFFERENT
 * pinned-controls shapes, not just different gallery layouts).
 *
 * ## Track-agnostic, joining the existing reuse boundary
 *
 * Imports `resolveVersionView`/`resultBaseModel`/`formatCompactCount` from
 * `civitai_search.mjs` and `civitaiModelUrl` from `model_info.mjs` — both
 * already track-agnostic, guarded members of the same boundary
 * (`test_model_picker.mjs`'s `GUARDED_FILES`, extended here) — rather than
 * duplicating any of that logic a third time. This file never imports a
 * `lora_*` module itself, for the identical reason.
 *
 * ⚠️ `civitai_search.mjs` itself imports `buildModelDetailView` (below) back
 * from THIS file (its own `openModelDetailPanel`, §7c-ii's mount) — a
 * genuine module cycle, not an oversight. It's SAFE here specifically
 * because every one of the three functions this file imports FROM
 * `civitai_search.mjs` is an `export function` declaration (hoisted), so its
 * binding exists the instant that module starts evaluating, regardless of
 * which of the two modules Node happens to load first — verified by this
 * pack's own test suite actually exercising both directions (`test_civitai_
 * search.mjs`'s "§7c-ii" section, `test_model_detail_view.mjs`), not merely
 * assumed. Do not turn either import into a `const`-bound arrow function
 * without re-checking this.
 *
 * ## What data this file does NOT already have, and where it comes from
 *
 * A search result (`civitai_search.parse_search_response`) already carries
 * everything about EVERY version except two things: the per-version
 * `version_description` and the author's own prompt-carrying `gallery`
 * (fetched fresh per version, since each version's gallery differs), and the
 * per-MODEL `model_description` (fetched once per model). Fetching those is
 * the CALLER's job (`civitai_api.mjs`'s `fetchModelDetail`) — this file only
 * ever RENDERS whatever `detail` shape it's handed (`{status, model
 * Description, versionDescription, modelDescriptionChecked, gallery}`), so a
 * loading/error state is exactly as testable as a resolved one with no
 * network anywhere in this module for THAT data.
 *
 * ## ONE deliberate exception: the COMMUNITY IMAGES grid fetches itself
 *
 * `docs/lora-loader-design.md` "BOTH galleries, for different reasons" put a
 * SECOND grid at the bottom — the community's own images (`/api/v1/images?
 * modelVersionId=...`, `src/model_browser/api.py`'s `community_images_impl`)
 * — below both descriptions, and required it to be LAZY: fetched only once
 * the section itself scrolls into view, never on open. That is a DOM-
 * visibility question only the element actually on screen can answer, so
 * (unlike every other field above) this ONE section owns its own
 * `IntersectionObserver` and its own fetch (`fetchCommunityImages`, an
 * injectable option — same "caller-injectable, network-backed default"
 * shape as `onCopyPrompt`/`defaultCopyToClipboard`, not a hardcoded `fetch()`
 * call) rather than waiting on the caller to hand it pre-resolved data. Two
 * things keep this from becoming a second, uncontrolled source of requests:
 * the observer disconnects after its first intersection (a component-level
 * "already started" flag guards a second network call even if it fires more
 * than once first), and `civitai_api.mjs`'s own `fetchCommunityImages` cache
 * is a SECOND, independent guarantee behind that, for the case a caller
 * rebuilds this whole component (a new instance, a new observer) while the
 * section is already visible. See `buildModelDetailView`'s own
 * `fetchCommunityImages`/`communityTileWidth`/`communityImagesLimit`
 * parameters for the rest of the contract.
 *
 * This grid carries NO prompt (`community_images_impl`'s own docstring: 0/40
 * sampled images carry one, deliberately no `prompt` key on the wire) and
 * gets no copy-prompt affordance and no prompt-on-hover — that is the AUTHOR
 * gallery's job, immediately below. It only attributes each image to its
 * `username` (rendered nowhere when absent — never a fabricated
 * "anonymous") and reports how many are hidden by the viewer's own browsing
 * level, reusing the exact `.wtn-dv-gallery-hidden` class/wording the author
 * gallery already established rather than inventing a second phrasing.
 *
 * ## The gallery's source is the AUTHOR's, not the community's (measured 2026-08-01)
 *
 * `docs/lora-loader-design.md`'s own correction block: the community
 * endpoint (`/api/v1/images?modelVersionId=...`) carries NO prompt on any of
 * 40 sampled images (`meta: {}` on every one); the author's own
 * `/api/v1/model-versions/{id}` carries one on 18/20. So the heading below
 * reads **`GALLERY`**, not the earlier draft's "COMMUNITY IMAGES" — that
 * label would misrepresent the data now: these are the author's own
 * generation examples, not other users' submissions. Everything else the
 * design doc specifies for this section (prompt-on-hover, params, copy,
 * lazy-load, concurrency cap, level-awareness) is unchanged by that rename.
 *
 * ## Untrusted text — textContent, never innerHTML
 *
 * A prompt legitimately contains `<lora:name:0.8>`-shaped substrings and can
 * be raw, unescaped HTML a malicious/careless uploader typed into a
 * generation client — EVERY piece of Civitai-supplied text here (name,
 * creator, descriptions, prompts, params) is written with `textContent`,
 * never string-concatenated into `innerHTML`. This file's only `innerHTML`
 * writes are `= ""` clears of a dynamic host before rebuilding it.
 *
 * ## Lazy-load + a concurrency cap (§9's "never block a run" applied to bandwidth)
 *
 * A gallery is the one surface in this whole feature that can pull real
 * bandwidth (§"Three constraints the spec already fixes"). `createLoadGate`
 * (pure, directly testable) caps how many gallery images are ever
 * concurrently fetching at once — every entry gets its skeleton immediately,
 * but the actual `<img src=...>` attach (`attachThumbCandidate`, shared with
 * every other gallery in this pack) is deferred until a gate slot frees,
 * combined with the `<img loading="lazy">` that mechanism already sets.
 *
 * ## Font sizing is accessible, not a hardcoded px scale (2026-08-02)
 *
 * Every font-size in this file's own CSS reads off ONE root custom property,
 * `--wtn-dv-font-scale` (a plain factor relative to `1rem`, never a bare
 * `px`), so a user's own browser font-size/zoom preference still applies --
 * see this file's own "Accessible font sizing" section (just above the CSS
 * constant) for the full mechanism, `FONT_RATIOS`/`fontCalc`. The base itself
 * is `buildModelDetailView`'s own `fontSizePx` parameter, a caller-supplied
 * per-MOUNT value (the picker and the modal read two DIFFERENT
 * `js/shared/settings.mjs` ids, at two different defaults) -- this component
 * never reads a setting or asks which mount it's in, exactly like
 * `galleryTileWidth` already established for gallery width.
 */

import { resolveVersionView, resultBaseModel, formatCompactCount } from "./civitai_search.mjs";
import { civitaiModelUrl } from "./model_info.mjs";
import { formatFileSize } from "./model_picker.mjs";
import { fetchCommunityImages as networkFetchCommunityImages } from "./civitai_api.mjs";
import {
  levelLabelToInt,
  thumbState,
  attachThumbCandidate,
  THUMB_RETRY_BACKOFF_MS,
  THUMB_SKELETON_CLASS,
  THUMB_SKELETON_CSS,
} from "../shared/civitai_thumb.mjs";

export { levelLabelToInt };

const STYLE_ID = "wtn-dv-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly -- same "every render module
// keeps its own hardcoded fallback copy" convention as every sibling in this
// reuse boundary.
const TOKENS = {
  surface2: "#1b212a",
  line: "#28303b",
  lineSoft: "#1f2731",
  ink: "#e7ecf3",
  inkDim: "#93a0b1",
  inkFaint: "#5f6c7d",
  console: "#0a0d12",
  accent: "#2dd4bf",
  accentStrong: "#34e5d2",
  accentDeep: "#14b8a6",
  onAccent: "#062420",
  info: "#7dd3fc",
};

// ---------------------------------------------------------------------------
// Pure -- no DOM, no `doc`/`window` reference anywhere below. Directly
// testable under plain `node` (test_model_detail_view.mjs).
// ---------------------------------------------------------------------------

/** A version's own option label for the version `<select>` -- `"v3.0 — 144
 * MB"`-shaped (the mockup's own wording, §"The detail view"). The size half
 * is OMITTED (never a placeholder like "? MB") when the version's primary
 * file size is unknown; the name half falls back to `#<id>` for a version
 * Civitai returned with no name at all, same convention `civitai_search.mjs`'s
 * own per-card version `<select>` already uses. Never throws on garbage
 * input. */
export function versionOptionLabel(version) {
  if (!version || typeof version !== "object") {
    return "";
  }
  const name = (typeof version.name === "string" && version.name.trim()) || `#${version.version_id}`;
  const sizeKb = version.size_kb;
  const size = Number.isFinite(sizeKb) ? formatFileSize(sizeKb * 1024) : "";
  return size ? `${name} — ${size}` : name;
}

/** `publishedAt` (a version's own ISO datetime string) -> a stable,
 * locale-independent `"YYYY-MM-DD"` label, or `""` for anything unusable --
 * never throws. Deliberately NOT `toLocaleDateString` (locale-dependent,
 * so a test asserting an exact string would be environment-fragile). */
export function formatDateLabel(publishedAt) {
  if (typeof publishedAt !== "string" || !publishedAt) {
    return "";
  }
  const d = new Date(publishedAt);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The two descriptions section's own view (§7d-i, "never collapsed into
 * one" — mirrors `model_info.mjs`'s `descriptionsView`, re-worded for this
 * component since it has no `↻ Civitai` footer button of its own to point
 * an "unchecked" message at, and it can genuinely be mid-fetch, which the ⓘ
 * panel's own cache-first version never is).
 *
 * `model`/`version` are that section's own trimmed text, or `null` when
 * there's nothing to show -- a caller renders NO heading at all for a `null`
 * field ("render each only when present... never invent a heading for an
 * empty one"). `emptyMessage` is set ONLY when BOTH are `null`:
 *
 *   - `loading` (a fetch for THIS version is still in flight) -> "Loading…".
 *   - `modelDescriptionChecked === true` (a DEFINITIVE "there genuinely is
 *     none" answer, §7d-i's own wire contract) -> an honest "none" line.
 *   - anything else (a transient fetch failure, or not yet resolved) -> a
 *     line inviting a retry, never a false "no description" claim.
 *
 * Never throws on garbage input.
 */
export function detailDescriptionsView({
  modelDescription,
  versionDescription,
  modelDescriptionChecked,
  loading = false,
} = {}) {
  const model = typeof modelDescription === "string" && modelDescription.trim() ? modelDescription.trim() : null;
  const version = typeof versionDescription === "string" && versionDescription.trim() ? versionDescription.trim() : null;
  if (model || version) {
    return { model, version, emptyMessage: null };
  }
  if (loading) {
    return { model: null, version: null, emptyMessage: "Loading descriptions…" };
  }
  const emptyMessage = modelDescriptionChecked
    ? "No description on Civitai for this model or version."
    : "Couldn't check Civitai for a description right now — try again.";
  return { model: null, version: null, emptyMessage };
}

/** Every `gallery` entry whose OWN `nsfw_level` is at or below `level` --
 * the gallery's own per-entry analogue of `civitai_thumb.mjs`'s
 * `pickThumbCandidates` (SAME predicate, reused rather than re-derived: an
 * absent per-image level is treated as `16`, conservative, never a leak
 * below the user's own setting), except this keeps the WHOLE entry (prompt,
 * params) rather than only its URL, since a gallery grid needs both.
 * Garbage/non-array `gallery`, or a garbage/non-finite `level` (defaults to
 * `1`, PG), degrade rather than throw. */
export function visibleGalleryEntries(gallery, level) {
  const list = Array.isArray(gallery) ? gallery : [];
  const lvl = Number.isFinite(level) ? level : 1;
  return list.filter((img) => img && typeof img.url === "string" && img.url
    && (Number.isFinite(img.nsfw_level) ? img.nsfw_level : 16) <= lvl);
}

/**
 * How many usable gallery entries `visibleGalleryEntries` is filtering OUT
 * at `level` -- owner, 2026-08-01: *"why does the gallery show only 6
 * images"* turned out to be `visibleGalleryEntries`'s own level filter
 * (working as designed), silently dropping the rest with no indication --
 * inconsistent with a CARD's own thumbnail, which shows an explicit
 * `locked` glyph for the same reason. This is the number a caller renders
 * as an honest one-line count ("N images hidden by your browsing level")
 * instead of just vanishing them. `total` uses the SAME "has a usable url"
 * predicate `visibleGalleryEntries` itself applies (never counting a
 * genuinely unusable entry as "hidden"), so the result is always
 * `total - visible`, never negative. At the maximum browsing level nothing
 * can be above it, so this is always `0` there -- never a special case, a
 * consequence of the same subtraction. Garbage/non-array `gallery` degrades
 * to `0`, never throws. */
export function hiddenGalleryCount(gallery, level) {
  const list = Array.isArray(gallery) ? gallery : [];
  const total = list.filter((img) => img && typeof img.url === "string" && img.url).length;
  const visible = visibleGalleryEntries(list, level).length;
  return Math.max(0, total - visible);
}

/** The gallery BOX's own state -- reuses `civitai_thumb.mjs`'s `thumbState`
 * verbatim (same "empty list can also mean locked" bitmask-union logic,
 * §7c-iv), with `cardState` always `null`/absent: this view has no `gated`
 * concept of its own (nothing here is about needing an API key to
 * download -- that's the ACTION column's job, injected by the caller), so
 * only the three states that concern a gallery of pictures ever apply:
 * `"locked"` (has images, all above the chosen level), `"placeholder"` (no
 * images at all), `"image"` (at least one passes). */
export function galleryState(gallery, level, modelNsfwLevel) {
  return thumbState(null, gallery, level, modelNsfwLevel);
}

// ---------------------------------------------------------------------------
// The COMMUNITY IMAGES grid ("BOTH galleries, for different reasons") -- the
// bottom-of-panel grid, honestly evidence rather than a prompt source (no
// `prompt` key on the wire at all, `src/model_browser/civitai_parse.py`'s
// `parse_community_images`). Deliberately REUSES `visibleGalleryEntries`/
// `hiddenGalleryCount` above rather than a second level-filter -- both
// already operate generically on any `{url, nsfw_level}`-shaped array, and a
// community entry is exactly that shape (plus `username`/`reaction_count`,
// neither of which the filter itself needs to look at).
// ---------------------------------------------------------------------------

/**
 * Decides what (if anything) the community grid should render, from a raw
 * `fetchCommunityImages` response and the viewer's own browsing level --
 * pure, no DOM, so the "silent on failure or empty" rule (task brief point
 * 5) is directly testable without ever building a real section.
 *
 * `shouldRender` is `false` -- meaning: no heading, no grid, no hidden-count
 * line, nothing at all -- for every NON-`"ok"` reason (`notfound`/`offline`/
 * `rate_limited`, `community_images_impl`'s own vocabulary) and for a
 * genuinely empty `images` array on a real `"ok"`. Both collapse to the same
 * silence deliberately: "a failed or empty fetch must never turn a working
 * detail view into a broken one" makes no distinction between them, and
 * inventing one (an error line for the former, an empty-state box for the
 * latter) is exactly what that rule forbids.
 *
 * When `shouldRender` is `true`, `visible` is `visibleGalleryEntries`'s own
 * level-passing subset (reused verbatim, never a second predicate) and
 * `hiddenCount` is `hiddenGalleryCount`'s own count for the SAME array/level
 * -- which may be `> 0` even when `visible` is empty: every image the server
 * sent is real, just every one sits above the viewer's own browsing level,
 * so the honest render is the heading plus the hidden-count line and no
 * grid, not silence (the images are not "absent", they are "hidden by your
 * own setting" -- the same distinction `thumbState`'s own "empty list can
 * also mean locked" doc comment draws, one level up: there the SERVER
 * trimmed the list before it arrived; here the CLIENT filter empties an
 * already-nonempty one, but the "these exist, you just can't see them"
 * conclusion the caller shows the user is the identical honest message).
 *
 * Garbage `resp` (not an object, missing `images`) or a garbage/non-finite
 * `level` degrade to "nothing to render"/PG respectively, never throw.
 */
export function communityImagesView(resp, level) {
  const images = resp && typeof resp === "object" && resp.reason === "ok" && Array.isArray(resp.images)
    ? resp.images
    : [];
  if (images.length === 0) {
    return { shouldRender: false, visible: [], hiddenCount: 0 };
  }
  return {
    shouldRender: true,
    visible: visibleGalleryEntries(images, level),
    hiddenCount: hiddenGalleryCount(images, level),
  };
}

/** A community image's own attribution caption -- `"by someone"`, or `"by
 * someone · ♥ 12"` when a positive `reaction_count` is also known -- or `""`
 * for a `null`/absent `username` (task brief point 3: "render nothing rather
 * than a placeholder", never a fabricated "anonymous"/"unknown"). Pure
 * string construction only; the CALLER is responsible for writing the
 * result with `textContent`, never `innerHTML` -- `username` is third-party,
 * user-authored text (task brief's own "untrusted text" warning). Never
 * throws on garbage input. */
export function communityAttributionLabel(entry) {
  if (!entry || typeof entry !== "object" || typeof entry.username !== "string" || !entry.username) {
    return "";
  }
  const reactions = Number.isFinite(entry.reaction_count) && entry.reaction_count > 0
    ? ` · ♥ ${entry.reaction_count}`
    : "";
  return `by ${entry.username}${reactions}`;
}

/** A gallery entry's generation-parameters line -- `"Euler a · 20 steps ·
 * CFG 7 · 832x1216"`-shaped, only the fields actually present (never an
 * invented placeholder for a missing one), `""` for no usable params at
 * all. Never throws on garbage input. */
export function galleryParamsLabel(params) {
  if (!params || typeof params !== "object") {
    return "";
  }
  const parts = [];
  if (typeof params.sampler === "string" && params.sampler.trim()) {
    parts.push(params.sampler.trim());
  }
  if (Number.isFinite(params.steps)) {
    parts.push(`${params.steps} steps`);
  }
  if (Number.isFinite(params.cfg)) {
    parts.push(`CFG ${params.cfg}`);
  }
  if (typeof params.size === "string" && params.size.trim()) {
    parts.push(params.size.trim());
  }
  return parts.join(" · ");
}

/**
 * A bounded-concurrency task queue (§9's "never block a run" applied to
 * bandwidth, extended to a gallery's own image fetches) -- `schedule(task)`
 * enqueues `task(release)`; `task` is responsible for calling `release()`
 * exactly once, whenever its own work (an image load OR its own exhaustion)
 * is done, which is what lets the NEXT queued task start. At most
 * `maxConcurrent` tasks ever run at once; everything past that waits its
 * turn, FIFO. A `maxConcurrent` that's `<= 0` or non-finite degrades to `1`
 * (never zero -- a gate that never runs anything would hang the whole
 * gallery forever). Never throws.
 */
export function createLoadGate(maxConcurrent = 4) {
  const max = Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.floor(maxConcurrent) : 1;
  let active = 0;
  const queue = [];
  function pump() {
    while (active < max && queue.length > 0) {
      const task = queue.shift();
      active += 1;
      let released = false;
      task(() => {
        if (released) {
          return; // a task that double-releases must never over-free a slot
        }
        released = true;
        active -= 1;
        pump();
      });
    }
  }
  return {
    schedule(task) {
      queue.push(task);
      pump();
    },
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return queue.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Accessible font sizing (owner, 2026-08-02: "the text is small ... 14px or
// 16px and heading should be 24px", then: "we should keep browser
// conventions and accessibility in mind" -- that last sentence is what makes
// the UNIT choice below load-bearing, not decorative).
//
// A hardcoded absolute `px` font-size ignores the single most common
// accessibility setting there is (the user's own browser font-size
// preference/zoom). Instead: ONE scale factor, `--wtn-dv-font-scale`, set on
// the component's own root as the caller's chosen base size (a per-mount
// setting, clamped below) divided by 16 -- the browser's conventional
// default root size -- and every actual font-size in this file's CSS reads
// `calc(var(--wtn-dv-font-scale) * <ratio> * 1rem)` (`fontCalc`, below),
// NEVER a bare `em` on the rule itself: an `em` compounds through however
// many ancestors also carry their own font-size (`.wtn-dv-gprompt` sits
// several levels inside `.wtn-dv-gdrawer`), while every rule anchoring to
// the SAME root-relative `1rem` cannot. The result is exactly the setting's
// own px value at the browser's own default zoom, and it still scales
// correctly for a user who has raised their default size or zoomed in --
// the whole point of the instruction; a plain-px implementation would
// satisfy "14px" today and fail the actual requirement the moment either
// changes.
//
// TWO settings own this component's base, one per MOUNT, not one shared
// value (owner, on being told a single shared setting would make the
// picker's ~396px panel just as dense as the wide browser modal: "you did
// right, and yes for our panel we should have different set then the
// browser modal") -- `civitai_modal.mjs`/`civitai_search.mjs` each read
// their OWN id (`SETTING_IDS.CIVITAI_DETAIL_MODAL_FONT_SIZE` /
// `_PANEL_FONT_SIZE`, `js/shared/settings.mjs`) and pass the result as
// `buildModelDetailView`'s own `fontSizePx` parameter -- the exact same
// shape `galleryTileWidth` already established (one option, one caller-
// supplied px number per mount; this component never reads a setting or
// asks which mount it's in). `FONT_RATIOS`, directly below, is the ONE
// shared table both mounts scale off of -- never a second, independently-
// tuned ratio list; only the BASE differs per mount.
// ---------------------------------------------------------------------------

/** The accepted range for either detail-view font-size setting -- a floor so
 * the user can't pick something genuinely unreadable, and a ceiling so body
 * text can't overflow the picker's own ~396px panel. Exported so
 * `js/shared/settings.mjs`'s own tooltip text and this file's tests both
 * cite the SAME two numbers rather than restating them. */
export const DETAIL_VIEW_FONT_SIZE_MIN = 12;
export const DETAIL_VIEW_FONT_SIZE_MAX = 20;

/** The modal's own default (owner's literal ask, "14px") -- also this file's
 * own CSS-level `var()` fallback (`fontCalc`, below), for the (should-
 * never-happen) case the root's inline custom property is somehow absent. */
export const DETAIL_VIEW_FALLBACK_FONT_SIZE_PX = 14;

const BROWSER_DEFAULT_ROOT_PX = 16;

/** `px` clamped into `[DETAIL_VIEW_FONT_SIZE_MIN, DETAIL_VIEW_FONT_SIZE_MAX]`,
 * or `fallback` for anything non-finite -- never throws, mirrors this file's
 * own "a garbage caller value degrades, never crashes" convention
 * (`galleryTileWidth`'s own handling in `buildModelDetailView`, below). */
export function clampDetailViewFontSize(px, fallback = DETAIL_VIEW_FALLBACK_FONT_SIZE_PX) {
  const n = Number(px);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.min(DETAIL_VIEW_FONT_SIZE_MAX, Math.max(DETAIL_VIEW_FONT_SIZE_MIN, safe));
}

/** The clamped `px` as a scale factor relative to `1rem` (the browser's own
 * conventional 16px default root) -- what actually gets written into
 * `--wtn-dv-font-scale`. `14 -> 0.875`, `12 -> 0.75`, etc. */
export function detailViewFontScale(px, fallback = DETAIL_VIEW_FALLBACK_FONT_SIZE_PX) {
  return clampDetailViewFontSize(px, fallback) / BROWSER_DEFAULT_ROOT_PX;
}

/**
 * The ONE ratio table both mounts scale off of (task brief: "this must not
 * become two font systems") -- every value is relative to `body: 1`, the
 * base itself. Three are the owner's own named targets: `body` (the literal
 * ask, "14px", so `.wtn-dv-desc` and its peers land exactly on the base),
 * `sechead` (24/14, "heading should be 24px" at a 14px base), and `title`
 * (~20/14 -- THIS FILE'S OWN INFERENCE, not an owner instruction: the owner
 * named only "text" and "heading", so the model-name title sitting between
 * the two is a judgment call, flagged in the build report for the owner to
 * retune). Every remaining ratio is this component's PRE-EXISTING relative
 * size -- old hardcoded px divided by the old hardcoded 12px root -- carried
 * forward onto the new base rather than re-picked by eye (task brief). Note
 * `body` covers FIVE selectors that were already identical (11.5px) before
 * this change -- `.wtn-dv-creator`, `.wtn-dv-desc`, `.wtn-dv-desc-empty`,
 * `.wtn-dv-gallery-empty`/`.wtn-dv-gallery-locked`, and `.wtn-dv-back` --
 * literally this file's own "body text" tier already, by construction, not a
 * new grouping invented for this pass.
 */
export const FONT_RATIOS = {
  root: 1,
  body: 1,
  title: 20 / 14,
  sechead: 24 / 14,
  civlink: 12 / 12,
  stats: 11 / 12,
  badge: 10 / 12,
  galleryHidden: 10.5 / 12,
  gprompt: 10.5 / 12,
  gparams: 9.5 / 12,
  gcopy: 10 / 12,
  close: 13 / 12,
  // The community grid's own attribution caption -- same small-text tier as
  // `badge` (a byline-shaped label, not a paragraph), added rather than
  // reusing `badge` directly so this section's own font-size stays a named,
  // independently-retunable entry (this table's own "never a second,
  // independently-tuned ratio LIST" rule is about not FORKING the table,
  // not about every selector sharing one entry with an unrelated one).
  ccaption: 10 / 12,
};

/** `font-size: calc(...)` value for one `FONT_RATIOS` entry -- always
 * anchored to `1rem` (never a bare `em`, this section's own top comment) so
 * nesting depth can never compound it. The `var()` fallback is
 * `DETAIL_VIEW_FALLBACK_FONT_SIZE_PX`'s own scale (0.875) -- only reached if
 * `--wtn-dv-font-scale` is somehow unset on the root, which `buildModel
 * DetailView` always sets. */
function fontCalc(ratio) {
  return `calc(var(--wtn-dv-font-scale, ${DETAIL_VIEW_FALLBACK_FONT_SIZE_PX / BROWSER_DEFAULT_ROOT_PX}) * ${ratio} * 1rem)`;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
/* Owner-reported bug (2026-08-01): "the details panel is not scrollable
   (didn't it should show also gallery?)" -- the gallery WAS built, just
   below the fold: this root used to append every section as a flat, un-
   scrollable column, so a long MODEL DESCRIPTION pushed the gallery past
   whatever bounded its mount (the picker's own \`.wtn-cs-panel\` -- 76vh,
   \`overflow: hidden\` -- or the modal's \`.wtn-cm-detailhost\`), and
   \`overflow: hidden\` on that ancestor CLIPPED it rather than making it
   reachable. \`.wtn-dv\` is now itself a flex column that FILLS whatever
   bounded box its mount gives it (\`flex: 1 1 auto; min-height: 0\` -- the
   trap this whole fix is about: a flex child's default \`min-height: auto\`
   refuses to shrink below its content, so without this override an
   \`overflow-y: auto\` further down the chain never actually engages, no
   matter how correctly IT is written -- \`civitai_search.mjs\`'s own
   \`.wtn-cs-body\`/\`.wtn-cs-scroll\` doc comment names the exact same trap),
   split into TWO children, ONE of which never scrolls and the other of
   which is the ONLY thing that does -- \`.wtn-dv-body\` (\`flex: 1 1 auto;
   min-height: 0; overflow-y: auto\`) either way. Which pinned shape it pairs
   with is \`buildModelDetailView\`'s own \`fixedTopBar\` parameter (that
   function's own doc comment has the full "why" -- the picker's sibling
   panel and the modal's master->detail swap turned out to want DIFFERENT
   pinned sets, not the same one): \`.wtn-dv-header\` (identity, \`View on
   Civitai ↗\`, the version selector, the download action -- the picker) or
   \`.wtn-dv-topbar\` (ONLY \`← results\`, the version selector, the download
   action, on one row -- the modal). When \`.wtn-dv\` is mounted WITHOUT a
   bounded ancestor (the modal's own \`.wtn-cm-detailhost\` already scrolls
   the whole thing itself -- see that file's own CSS comment), \`.wtn-dv\`
   simply sizes to its natural content height as before and \`.wtn-dv-body\`'s
   own \`flex-grow\`/\`overflow-y\` are inert -- harmless, not a second,
   competing scrollbar. */
.wtn-dv { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: ${fontCalc(FONT_RATIOS.root)}; color: var(--wtn-ink, ${TOKENS.ink}); }
/* Owner-reported bug (2026-08-01): "the detail panel should have padding,
   see how the content is tight to the border of the panel" -- neither pinned
   region (this rule, \`.wtn-dv-topbar\` below) nor the scrolling body
   (\`.wtn-dv-body\` below) had ANY padding, so identity/descriptions/gallery
   all butted straight against the panel edge. \`position: relative\` is only
   so \`.wtn-dv-close\` (below) can anchor to THIS box's own corner, not the
   whole \`.wtn-dv\` root. The reserved 18px on the right (34px vs. the 16px
   every other edge gets) is that same close button's own clearance -- so a
   long, wrapped title's first line never runs under it.
   Owner-reported, second pass (2026-08-01): "the panel's padding is too
   tight ... raise it to 16px" -- raised from the original 9/10px above to a
   uniform 16px on every edge (right stays 16px plus the 18px close-button
   clearance = 34px). This gives the header a real, non-zero padding-bottom
   for the first time (it used to rely entirely on \`.wtn-dv-actionhost\`'s
   own \`margin: 6px 0 8px\` for that gap, which is why the bottom used to be
   0) -- see \`.wtn-dv-body\`'s own comment, below, for why the body's OWN top
   padding has to become 0 in exchange: with 16px on both sides of that
   seam, the gap between the version/download row and the first line of
   scrolling content would otherwise double. */
.wtn-dv-header { flex: none; display: flex; flex-direction: column; gap: 2px; position: relative; padding: 16px 34px 16px 16px; }
/* The picker's own close affordance (owner, 2026-08-01, replacing the
   removed "← back to results" -- see \`onClose\`'s own doc comment on
   \`buildModelDetailView\` for the full "why") -- same ✕ glyph, same
   ink-faint/ink hover colours, same top-right corner as this pack's other
   two panel closers (\`civitai_search.mjs\`'s own \`.wtn-cs-close\`,
   \`civitai_modal.mjs\`'s own \`.wtn-cm-close\`), just this component's own
   class rather than reaching into either sibling file's stylesheet. */
.wtn-dv-close { position: absolute; top: 8px; right: 8px; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: ${fontCalc(FONT_RATIOS.close)}; }
.wtn-dv-close:hover { color: var(--wtn-ink, ${TOKENS.ink}); }
/* Owner-reported, then corrected to modal-only (2026-08-01): "back to
   results should not be in the end of the scroll down... it should be in
   the top navigation bar, which should be fixed position, which should
   also show the download button and the version selection" -- the MODAL's
   own shape only (\`fixedTopBar: true\`; the picker keeps \`.wtn-dv-header\`,
   above, unchanged -- see \`buildModelDetailView\`'s own doc comment for the
   full "why one component, two pinned shapes"). \`← results\` sits on the
   left, intrinsic size; \`.wtn-dv-vdstack\` (below) is the ONE other child,
   pushed flush right.
   Owner, SECOND correction, same day: "remove the version label, the field
   is sufficient, and make it above the download button on the right side of
   the screen" -- supersedes an earlier one-row arrangement for THIS shape
   specifically (the picker's own \`.wtn-dv-vdrow\`, below, is unaffected --
   it still shares one row; only the modal asked to stack instead). */
.wtn-dv-topbar {
  flex: none; display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-width: 0;
  /* Owner-reported (2026-08-01): "the panel's padding is too tight ... raise
     it to 16px" -- same uniform 16px as \`.wtn-dv-header\` above, so the two
     pinned shapes stay coherent with each other; bottom stays the
     pre-existing separator clearance, just raised from 8px to 16px along
     with the rest rather than left as a mismatched leftover value. */
  padding: 16px; border-bottom: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
}
/* Owner-reported, with a screenshot (2026-08-01): "← back to results" reads
   shorter than the version <select> beside it in this row -- the SAME class
   of bug \`.wtn-cs-action\`'s own doc comment already names for the Delete-vs-
   ✓-installed mismatch (a plain element's box is padding+line-height+border,
   but a native form control ALSO carries the browser's own chrome, which
   doesn't obey that padding/line-height the same way). Genuinely scoped to
   \`.wtn-dv-topbar\` -- \`.wtn-dv-back\` only ever renders in THIS shape (the
   picker's header uses \`onClose\`'s ✕ instead, never a back button), unlike
   the select's own height/arrow-clearance fix, which used to be scoped the
   same way and had to stop being (see \`.wtn-dv-version-sel\`, below, for
   that fix and the full "why"). */
.wtn-dv-topbar .wtn-dv-back {
  flex: none; margin-top: 0; align-self: center; height: 26px; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; padding: 0 9px;
  appearance: none; -webkit-appearance: none;
}
/* The version-select-plus-download STACK (owner, second correction,
   2026-08-01: "make it above the download button on the right side of the
   screen") -- version select on top, the download action beneath it, both
   right-aligned as ONE block via \`margin-left: auto\` (never
   \`justify-content\` on \`.wtn-dv-topbar\` itself, which would just recentre
   \`← results\` instead of moving only the intended child). \`min-width: 0\`
   is this element's own link in the SAME overflow chain
   \`civitai_modal.mjs\`'s own \`.wtn-cm-main\`/\`.wtn-cm-detailhost\` and
   \`.wtn-dv\`/\`.wtn-dv-body\` (below) all needed (owner: "i think we have
   horizontal issue in the model detail page, see its cut" -- also why the
   Download button read as missing: it was clipped off the right edge, not
   absent). */
.wtn-dv-vdstack { display: flex; flex-direction: column; gap: 4px; margin-left: auto; min-width: 0; }
/* The scrolling body's own padding lives HERE, on the element that actually
   carries \`overflow-y: auto\` -- never on an ancestor. Padding on a scroll
   container's PARENT instead would leave its scrollbar inset from the panel
   edge and clip content oddly at the scroll boundary; this is why it isn't
   hoisted onto \`.wtn-dv\` (the ancestor both pinned shapes and this body
   share). Owner, second pass (2026-08-01): "the content card which scrolls,
   top padding should be 0 so it will not have too much space between the
   version and download button" -- raising every edge to a uniform 16px
   (matching \`.wtn-dv-header\`/\`.wtn-dv-topbar\` above) would otherwise DOUBLE
   the gap at this exact seam, since the pinned region right above now also
   carries a real 16px bottom padding for the first time. TOP stays 0 for
   that reason -- the pinned region's own padding-bottom already supplies
   the separation -- while the other three edges get the same 16px as
   everything else. \`wtn-flex-bound\` (this element's own class list, set by
   \`buildModelDetailView\` -- \`js/shared/theme.css\` has that class's own
   doc comment) is the shared \`min-width: 0; min-height: 0;\` fix for the
   SAME horizontal-overflow chain \`.wtn-dv-vdstack\` above and \`.wtn-dv\`
   below are also part of, rather than a fourth hand-written copy of the
   same two properties. */
.wtn-dv-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 0 16px 16px 16px; }
/* Owner-reported (2026-08-02): the GALLERY heading rendered with nothing
   under it -- a live probe (\`.claude/skills/css-layout-diagnose-headless\`)
   showed the data and tile widths were correct (\`firstTileBox: {width: 115,
   height: 0}\`) but every filmstrip tile measured zero height. Cause: THIS
   element (\`.wtn-dv-body\`, above) is itself \`display: flex; flex-direction:
   column\`, so every section appended into it -- the gallery heading and its
   filmstrip, both descriptions, the hidden-count line, the community grid
   -- is a flex ITEM, and a flex item's default \`flex-shrink: 1\` lets a tall
   sibling (the community grid, once it has content) squash an EARLIER
   section below its own natural, \`aspect-ratio\`-derived height; the
   filmstrip's own \`overflow-y: hidden\` (deliberate, see that rule's own
   comment) then clips the squashed box to nothing rather than making it
   reachable, instead of the intended behaviour -- the COLUMN scrolls, every
   section keeps its natural height. This is not special to the gallery:
   EVERY direct child of \`.wtn-dv-body\` has the identical latent defect, so
   the fix is the whole column, never a per-section patch (verified: none of
   this column's ~9 sections ever wants to grow OR shrink -- each is sized
   entirely by its own content). \`flex: none\` is \`.wtn-flex-fixed\`'s own
   declaration (\`js/shared/theme.css\`, the mirror of \`.wtn-flex-bound\` just
   above -- that class's own comment has the full "why a pair"); applied
   here STRUCTURALLY (\`> *\`, matching \`js/anima/render.mjs\`'s own
   \`.wtn-an-panel-pv > .wtn-an-body > *\` precedent for the identical shape)
   rather than as a class on each of the many call sites that append into
   \`bodyHost\`, so a FUTURE section added to this column inherits the fix by
   construction instead of depending on whoever adds it remembering a class.
   A plain-node test has no layout engine and so cannot PROVE a box's
   rendered height -- this declaration is asserted directly in
   test_model_detail_view.mjs, but the real proof is the headless
   measurement in this task's own build report. */
.wtn-dv-body > * { flex: none; }
.wtn-dv-head { display: flex; gap: 10px; align-items: flex-start; }
.wtn-dv-thumb {
  width: 58px; height: 58px; flex: none; border-radius: 7px; overflow: hidden;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  display: flex; align-items: center; justify-content: center; position: relative;
}
.wtn-dv-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
${THUMB_SKELETON_CSS}
.wtn-dv-thumb-ph, .wtn-dv-gimg-ph {
  width: 22px; height: 22px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
}
.wtn-dv-identity { flex: 1 1 auto; min-width: 0; }
.wtn-dv-title { font-size: ${fontCalc(FONT_RATIOS.title)}; font-weight: 600; line-height: 1.25; }
/* Owner-reported (2026-08-01): "LORA / ZImageBase currently sit on their
   own line below 'by EauDeNoire' ... put them on the same row ... that
   reclaims a line in a panel where vertical space is the scarce resource"
   -- \`.wtn-dv-bylinerow\` is the shared row; the byline sits in normal flow
   (left), the chips get \`margin-left: auto\` on \`.wtn-dv-badges\` itself
   (below) rather than \`justify-content: space-between\` on THIS rule, which
   would misalign a LONE child (no creator, or no chips at all) to the left
   instead of leaving it exactly where it already belongs. */
.wtn-dv-bylinerow { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.wtn-dv-creator { font-size: ${fontCalc(FONT_RATIOS.body)}; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-dv-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-left: auto; }
.wtn-dv-badge {
  font-size: ${fontCalc(FONT_RATIOS.badge)}; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-dv-stats { font-size: ${fontCalc(FONT_RATIOS.stats)}; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin-top: 4px; }

.wtn-dv-civlink { display: inline-block; margin: 6px 0 0; color: var(--wtn-info, ${TOKENS.info}); font-size: ${fontCalc(FONT_RATIOS.civlink)}; text-decoration: none; }
.wtn-dv-civlink:hover { text-decoration: underline; }

.wtn-dv-sep { border: 0; border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); margin: 10px 0; }

/* Owner-reported (2026-08-01), third time this exact fix has half-landed:
   "the select's arrow is still touching the right border ... put the arrow
   clearance on the select itself, not a mount-scoped descendant selector,
   so both shapes inherit it and it cannot diverge again." Previously this
   height/arrow-clearance pair lived ONLY on \`.wtn-dv-topbar .wtn-dv-version-
   sel\` (the modal's shape) -- so the picker's own \`.wtn-dv-header\` mount
   never got it, which is exactly the bug being fixed here. Declared on
   \`.wtn-dv-version-sel\` itself, unscoped, so it's inherited by BOTH mounts
   by construction rather than by two separately-tuned copies agreeing.
   \`.wtn-dv-vdrow\` (the picker's one-row layout) and \`.wtn-dv-vdstack\`
   (the modal's stacked layout, above) each wrap this SAME select -- there is
   no longer a \`.wtn-dv-versionrow\`/\`<label>\` pair at all; the "Version"
   label itself was dropped the same pass (owner: "redundant -- the select's
   own options read 'Hands zib v1.0 — 162 MB', self-evidently a version").
   The 26px HEIGHT itself no longer lives here (2026-08-01, second fix that
   same day) -- it moved to the shared \`.wtn-select\` base in
   \`js/shared/theme.css\` (this select's OTHER class, see
   \`buildModelDetailView\`'s \`el(doc, "select", "wtn-select wtn-dv-version-
   sel")\`) once \`civitai_modal.mjs\`'s own \`.wtn-cm-version-sel\` needed the
   identical fix and declaring it a third time per-surface was exactly the
   bug this whole comment already describes. \`box-sizing: border-box\` is
   dropped too -- \`js/shared/theme.css\`'s own \`.wtn *\` rule already makes
   it universal, so restating it here was always redundant, just never
   removed until this pass touched the rule anyway. Only the ARROW clearance
   (the padding override) stays -- that part genuinely IS specific to a
   select long enough to need it, unlike height. */
.wtn-dv-vdrow { display: flex; align-items: center; gap: 8px; }
.wtn-dv-version-sel { flex: 1 1 auto; min-width: 0; padding: 0 22px 0 8px; }
.wtn-dv-actionhost { flex: none; margin: 0; }

/* Owner-reported (2026-08-01): "GALLERY"/"VERSION DESCRIPTION"/"MODEL
   DESCRIPTION" read too small to work as section separators in a panel this
   size -- the fix is SIZE only ("keep whatever letter-spacing/uppercase
   treatment they already have"), so only \`font-size\` changes here (10px ->
   13px); letter-spacing/text-transform/colour are untouched, and every
   section heading in this file shares this ONE rule, so the three stay
   identical to each other by construction, not by three separate values
   happening to agree. */
/* \`font-weight: normal\` is new here (2026-08-02, accessibility pass) --
   these three headings are now real \`<h4>\` elements (\`buildModelDetailView\`,
   below -- "Give the section headings real heading semantics", so a screen
   reader gets actual structure, not a styled \`<div>\`), and a bare \`<h4>\`
   carries the browser's own UA-stylesheet bold by default. Explicit \`normal\`
   keeps the rendered weight identical to the old \`<div>\` (which inherited
   \`normal\` from its own ancestors, having no font-weight of its own) -- the
   ask was SIZE, not a new visual weight. \`<h4>\` was chosen to match this
   pack's own existing convention for a real heading element (\`interaction
   .mjs\`'s \`buildSeedPopover\`/\`buildLatentPopover\`/etc. each use a bare \`<h4>\`
   for their own single popover title) -- there is no h1-h3 anywhere in this
   pack's DOM to nest under, so matching the level already in use elsewhere
   beats inventing a new tier. */
.wtn-dv-sechead { font-family: var(--wtn-font-mono, monospace); font-size: ${fontCalc(FONT_RATIOS.sechead)}; font-weight: normal; letter-spacing: .08em; text-transform: uppercase; color: var(--wtn-accent, ${TOKENS.accent}); margin: 8px 0 4px; }
/* \`overflow-wrap: anywhere\` (owner: "i think we have horizontal issue in
   the model detail page, see its cut") -- \`min-width: 0\` up the whole flex
   chain (\`.wtn-flex-bound\`, this element's own root/body ancestors, and
   \`civitai_modal.mjs\`'s own \`.wtn-cm-main\`/\`.wtn-cm-detailhost\`) stops a
   BOX from refusing to shrink, but a single UNBREAKABLE token inside it (a
   long URL with no spaces, in a pasted model description) still can't wrap
   at ordinary \`white-space: pre-wrap\` word boundaries -- this is what lets
   the text itself break instead of pushing its box wider. */
/* \`line-height: 1.5\` (raised from 1.4, 2026-08-02) -- WCAG 1.4.12 wants body
   text at line-height >= 1.5; this is the one place in this file that reads
   as an actual paragraph of prose (a model/version description) rather than
   a short label, so it's the one line-height this pass raises. Headings
   stay tighter (\`.wtn-dv-title\`/\`.wtn-dv-sechead\` keep their own values,
   above) -- that's WCAG's own carve-out, not an oversight. */
.wtn-dv-desc { font-size: ${fontCalc(FONT_RATIOS.body)}; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: pre-wrap; line-height: 1.5; overflow-wrap: anywhere; }
.wtn-dv-desc-empty { font-size: ${fontCalc(FONT_RATIOS.body)}; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; }
.wtn-dv-gallery-hidden { font-size: ${fontCalc(FONT_RATIOS.galleryHidden)}; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin-top: 6px; }

/* Owner, 2026-08-01: BOTH mounts are a single horizontally-scrolling
   FILMSTRIP row now ("in the detail panel ... the gallery, let's lower the
   images again, maybe so 3 images per row and horizontal scroll") --
   collapsing the earlier two-shape split (a plain 2-column grid for the
   picker vs. this single scrolling row for the modal, itself a same-day
   rename from "vertical"/"grid", which had come to describe the shape
   BACKWARDS). The two mounts now differ ONLY in TILE SIZE, never in shape
   -- see \`buildModelDetailView\`'s own \`galleryTileWidth\` doc comment (the
   parameter the old two-valued \`layout\` collapsed into) for the full
   "why" and that rename itself. \`min-width: 0\` is the exact horizontal
   mirror of \`.wtn-dv-body\`'s own \`min-height: 0\` fix above (this file's
   own CSS comment on that rule has the full trap): a flex item's default
   \`min-width: auto\` refuses to shrink below its content's width, which
   would silently defeat \`overflow-x: auto\` here the same way an
   unshrinkable height defeated \`overflow-y: auto\` there. Tiles get
   \`flex: none\` (never shrinking to fit, which is what actually forces the
   overflow rather than everyone cramming into the available width) and an
   explicit width -- \`var(--wtn-dv-gallery-tile)\`, set inline by
   \`buildModelDetailView\` on THIS grid element from its own
   \`galleryTileWidth\` parameter, not a bare number, so the one call site
   that knows "how wide" is the only place that number lives -- since
   \`.wtn-dv-gbox\`'s own \`width: 100%\` needs a definite box to be 100% OF. */
.wtn-dv-gallery-filmstrip { display: flex; flex-direction: row; gap: 10px; overflow-x: auto; overflow-y: hidden; min-width: 0; padding-bottom: 4px; }
.wtn-dv-gallery-filmstrip .wtn-dv-gimg { flex: none; width: var(--wtn-dv-gallery-tile, 200px); }
.wtn-dv-gimg { position: relative; border-radius: 7px; overflow: hidden; }
/* Owner, 2026-08-01 ("3 images per row"): the picker's own tiles shrank to
   ~115px to fit three across its ~396px panel -- narrow enough that the
   prompt drawer (below) is not readable if confined to the tile's own
   width, and legible prompts are the entire reason the AUTHOR gallery was
   chosen over the community one (this file's own top doc comment). That
   round's fix was the drawer escaping past its own tile's edge on
   hover/focus (this rule flipping to \`overflow: visible\` was the mechanism)
   -- REVERSED 2026-08-02, owner report with screenshots: "the prompt ...
   seems it's not aligned to the image", the drawer overhanging onto the
   NEIGHBOURING tile. The escape could never have worked: this tile's own
   parent, \`.wtn-dv-gallery-filmstrip\` (above), carries \`overflow-x: auto\`,
   and an ancestor's non-visible overflow clips its descendants regardless of
   what any element between them says -- flipping THIS rule to \`visible\`
   only moved the clip from the tile to the filmstrip one level up, which is
   exactly what let the drawer spill sideways into whichever tile happened to
   sit next to it. The durable fix is the drawer matching its own tile
   exactly (see \`.wtn-dv-gdrawer\` below) rather than trying to escape a
   scroll container that will always win. This rule now stays permanently
   \`hidden\` -- nothing needs to get out any more. */
.wtn-dv-gbox {
  position: relative; width: 100%; aspect-ratio: 1 / 1; background: var(--wtn-console, ${TOKENS.console});
  display: flex; align-items: center; justify-content: center;
  /* Clips (and rounds) the IMAGE itself. \`.wtn-dv-gimg\` (the tile, above)
     now clips permanently too, at the same rect, so this is redundant with
     the tile's own clip for a plain image -- kept anyway to decouple "the
     image reads with rounded corners" from "the tile clips its contents",
     which are two different concerns that only coincide today; a future
     change to the tile's own overflow rule (for an unrelated reason) should
     not have to remember it was also the only thing rounding the image. */
  overflow: hidden; border-radius: 7px;
}
.wtn-dv-gbox img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wtn-dv-goverlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end;
  opacity: 0; transition: opacity .12s ease; pointer-events: none;
}
.wtn-dv-gimg:hover .wtn-dv-goverlay, .wtn-dv-gimg:focus-within .wtn-dv-goverlay { opacity: 1; pointer-events: auto; }
/* The DRAWER surface (owner, 2026-08-01: "black background with
   transparency ... and top border (so we know its a drawer above the
   image)") -- ONE scrim behind prompt+params+copy together (sized to their
   OWN content, via \`.wtn-dv-goverlay\`'s \`justify-content: flex-end\` above),
   not the old gradient sweeping most of the image -- that's what makes it
   read as a drawer rather than text floating on a fade. Owner suggested
   alpha .1-.2; a screenshot showed exactly why that fails at those values --
   pale prompt text over a bright/busy generation image is illegible. .65
   is what actually reads, a deliberate call over the suggested range --
   dial back down HERE if that turns out too dark once seen live. \`6,8,11\`
   is this file's own dark tone (the old gradient's own end colour, above),
   reused rather than invented; the border colour is this pack's own
   \`--wtn-line\` (js/shared/theme.css), not invented either.

   2026-08-01, second pass ("3 images per row"): tried making this WIDER
   than its own tile (centred, escaping past both edges on hover) so a
   ~115px picker tile could still show a readable prompt -- REVERSED
   2026-08-02, owner report with screenshots: the drawer was overhanging its
   tile and spilling onto the neighbouring image, because the tile's own
   parent (\`.wtn-dv-gallery-filmstrip\`, above) is itself a scroll container
   (\`overflow-x: auto\`), and an ancestor's own non-\`visible\` overflow clips
   every descendant no matter what any element in between declares --
   \`.wtn-dv-gimg\` flipping to \`overflow: visible\` on hover got the drawer
   out of the TILE and straight into the FILMSTRIP's own clip, which is
   exactly the cut-off-mid-word look the screenshot showed. That is the
   durable fact to keep: a box cannot escape past an ancestor that clips,
   however many of the boxes between the two say \`visible\`.

   The fix instead: the drawer matches its own tile EXACTLY -- \`left: 0;
   right: 0\` (no \`width\`, no \`transform\`) against \`.wtn-dv-goverlay\` (the
   nearest positioned ancestor, itself sized to the tile via \`inset: 0\`), so
   the drawer's box IS the tile's box, never wider. The known cost (the
   owner has effectively accepted this by asking for alignment): at the
   picker's ~115px tiles the prompt column is narrow. \`.wtn-dv-gprompt\`'s
   own \`max-height: 72px; overflow-y: auto\` (below) is what keeps that
   readable -- it scrolls vertically rather than clipping, so a narrow
   column just means a taller scroll, not lost text. */
.wtn-dv-gdrawer {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column; gap: 4px; padding: 8px;
  background: rgba(6, 8, 11, .65);
  border-top: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: 0 0 7px 7px;
}
/* \`overflow-x: hidden\` is explicit, not assumed -- CSS computes a
   \`visible\`/non-\`visible\` overflow PAIR: if either axis is set to
   something other than \`visible\` and the other is left \`visible\`, the
   \`visible\` one silently COMPUTES to \`auto\` too. \`overflow-y: auto\` alone
   therefore also turns on horizontal scrolling for anything wider than the
   box (owner report, 2026-08-02: a horizontal scrollbar under the prompt,
   its text clipped on the left edge) -- the same trap \`.wtn-dv-desc\`'s own
   \`overflow-wrap: anywhere\` above already exists to guard against, here
   applied to the same failure mode. \`overflow-wrap: anywhere\` lets an
   unbreakable token (a long tag run with no spaces) wrap instead of forcing
   the box wider in the first place. */
.wtn-dv-gprompt { font-size: ${fontCalc(FONT_RATIOS.gprompt)}; color: var(--wtn-ink, ${TOKENS.ink}); max-height: 72px; overflow-y: auto; overflow-x: hidden; overflow-wrap: anywhere; }
.wtn-dv-gparams { font-family: var(--wtn-font-mono, monospace); font-size: ${fontCalc(FONT_RATIOS.gparams)}; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); overflow-wrap: anywhere; }
.wtn-dv-gcopy {
  align-self: flex-start; font-family: var(--wtn-font-mono, monospace); font-size: ${fontCalc(FONT_RATIOS.gcopy)}; padding: 2px 7px; border-radius: 5px; cursor: pointer;
  background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); border: 1px solid var(--wtn-accent, ${TOKENS.accent});
}
.wtn-dv-gcopy:hover { background: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-dv-gallery-empty, .wtn-dv-gallery-locked { font-size: ${fontCalc(FONT_RATIOS.body)}; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); padding: 6px 0; }

/* The COMMUNITY IMAGES grid ("BOTH galleries, for different reasons") --
   deliberately a RESPONSIVE GRID, not a filmstrip: the author gallery above
   already owns that shape, and this section is explicitly a different one
   (task brief: "not a filmstrip -- the author strip is the filmstrip and
   this is deliberately a different shape"). \`repeat(auto-fill, minmax(...))\`
   is what makes it work at BOTH mounts with no JS branching on which mount
   this is -- the same "one caller-supplied number per mount" pattern
   \`galleryTileWidth\` already established, except here the number is a
   MINIMUM a tile may shrink to (auto-fill lays out however many columns of
   at least that width fit the container), not a fixed pixel width, since a
   grid -- unlike a fixed-tile horizontal filmstrip -- is supposed to reflow
   with the panel rather than force a scrollbar.
   \`.wtn-dv-community-host\` is the section's OWN observed sentinel -- it is
   the element \`buildModelDetailView\`'s own IntersectionObserver watches,
   and (this file's own top doc comment, "ONE deliberate exception") stays
   completely EMPTY -- no heading, no box, nothing -- until that observer
   fires and a fetch resolves with something to show. An empty \`<div>\` has
   zero height by construction, so this never reserves visible space for a
   section that may render nothing at all (task brief point 5). */
.wtn-dv-community-host { min-width: 0; }
.wtn-dv-community-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--wtn-dv-community-tile, 90px), 1fr));
  gap: 8px; margin-top: 4px;
}
.wtn-dv-community-tile { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.wtn-dv-cbox {
  position: relative; width: 100%; aspect-ratio: 1 / 1; background: var(--wtn-console, ${TOKENS.console});
  display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 7px;
}
.wtn-dv-cbox img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* Attribution (task brief point 3: "an uncredited grid of other people's
   work is the wrong default") -- a static caption UNDER the tile, never a
   hover overlay: point 4 forbids a copy-prompt control here and the author
   gallery's own \`.wtn-dv-gdrawer\` is exactly the hover mechanism that
   would invite one, besides which "escaping a clip is impossible" (task
   brief's own third constraint) makes a hover affordance the wrong choice
   for a grid this dense anyway. \`overflow-wrap: anywhere\` mirrors
   \`.wtn-dv-desc\`'s own guard -- a long, space-less username must wrap
   rather than force the tile wider. */
.wtn-dv-ccaption { font-size: ${fontCalc(FONT_RATIOS.ccaption)}; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); overflow-wrap: anywhere; }

.wtn-dv-back {
  margin-top: 10px; align-self: flex-start; font-family: var(--wtn-font-mono, monospace); font-size: ${fontCalc(FONT_RATIOS.body)}; padding: 4px 9px;
  border-radius: 6px; cursor: pointer; background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  border: 1px dashed var(--wtn-line, ${TOKENS.line});
}
.wtn-dv-back:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
`;

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  if (typeof document !== "undefined") {
    import(THEME_URL)
      .then((mod) => mod.injectTheme())
      .catch(() => {});
  }
  if (typeof targetDoc.getElementById === "function" && targetDoc.getElementById(STYLE_ID)) {
    return;
  }
  const style = targetDoc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  const host = targetDoc.head || targetDoc.body || targetDoc;
  if (host && typeof host.appendChild === "function") {
    host.appendChild(style);
  }
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

async function defaultCopyToClipboard(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
  } catch {
    // fall through -- a copy failure is never fatal to this view
  }
  return false;
}

function buildThumb(doc, view, level, isStale, backoffMs) {
  const thumb = el(doc, "div", "wtn-dv-thumb");
  const state = galleryState(view.images, level, view.nsfw_level);
  if (state === "locked") {
    const lock = el(doc, "span", "wtn-dv-thumb-ph");
    lock.textContent = "\u{1F648}"; // 🙈
    lock.title = "Preview hidden — above your browsing level";
    thumb.appendChild(lock);
    return thumb;
  }
  const candidates = visibleGalleryEntries(view.images, level).map((im) => im.url);
  if (state === "image" && candidates.length > 0) {
    const skeleton = el(doc, "span", THUMB_SKELETON_CLASS);
    thumb.appendChild(skeleton);
    const clearSkeleton = (t) => {
      if (skeleton.parentNode === t && typeof t.removeChild === "function") {
        t.removeChild(skeleton);
      }
    };
    attachThumbCandidate(doc, thumb, candidates, { index: 0, retried: false }, isStale, backoffMs, (d, t) => {
      clearSkeleton(t);
      t.appendChild(el(d, "span", "wtn-dv-thumb-ph"));
    }, (d, t) => {
      clearSkeleton(t);
    });
    return thumb;
  }
  thumb.appendChild(el(doc, "span", "wtn-dv-thumb-ph"));
  return thumb;
}

function buildGalleryEntryEl(doc, entry, { onCopyPrompt, isStale, backoffMs, gate }) {
  const card = el(doc, "div", "wtn-dv-gimg");
  const box = el(doc, "div", "wtn-dv-gbox");
  const skeleton = el(doc, "span", THUMB_SKELETON_CLASS);
  box.appendChild(skeleton);
  card.appendChild(box);

  gate.schedule((release) => {
    if (isStale()) {
      release();
      return;
    }
    const clearSkeleton = (t) => {
      if (skeleton.parentNode === t && typeof t.removeChild === "function") {
        t.removeChild(skeleton);
      }
    };
    attachThumbCandidate(doc, box, [entry.url], { index: 0, retried: false }, isStale, backoffMs, (d, t) => {
      clearSkeleton(t);
      t.appendChild(el(d, "span", "wtn-dv-gimg-ph"));
      release();
    }, (d, t) => {
      clearSkeleton(t);
      release();
    });
  });

  // Prompt-on-hover (task brief: "an image with no meta degrading cleanly
  // rather than showing an empty hover") -- the overlay element itself is
  // only ever built when there's a real prompt to show; an entry with no
  // usable `prompt` (a community-shaped `meta: {}`, or an author image that
  // genuinely lacks one) gets no overlay at all, never an empty box that
  // reveals on hover with nothing in it.
  if (typeof entry.prompt === "string" && entry.prompt) {
    const overlay = el(doc, "div", "wtn-dv-goverlay");
    // The drawer (this file's own CSS comment on `.wtn-dv-gdrawer`) -- ONE
    // scrim behind prompt+params+copy, not each painted on the image
    // directly, so the three read as a single panel rather than three
    // separate things floating over it.
    const drawer = el(doc, "div", "wtn-dv-gdrawer");
    const promptEl = el(doc, "div", "wtn-dv-gprompt");
    promptEl.textContent = entry.prompt; // never innerHTML -- a prompt may contain "<lora:x:0.8>" or raw HTML
    drawer.appendChild(promptEl);
    const paramsLabel = galleryParamsLabel(entry.params);
    if (paramsLabel) {
      const paramsEl = el(doc, "div", "wtn-dv-gparams");
      paramsEl.textContent = paramsLabel;
      drawer.appendChild(paramsEl);
    }
    const copyBtn = el(doc, "button", "wtn-dv-gcopy");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy prompt";
    copyBtn.title = "Copy this prompt";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onCopyPrompt(entry.prompt);
    });
    drawer.appendChild(copyBtn);
    overlay.appendChild(drawer);
    card.appendChild(overlay);
  }
  return card;
}

/** `buildModelDetailView`'s own network default for its `fetchCommunityImages`
 * option -- a thin wrapper around `civitai_api.mjs`'s network function
 * (imported under an alias so the OPTION and the NETWORK function can share
 * the more readable name, same reasoning `onCopyPrompt`/`defaultCopyToClipboard`
 * already establishes: a caller-injected function with a real, working
 * default, never a hardcoded `fetch()` call inline in the render path). */
async function defaultFetchCommunityImages(versionId, limit) {
  return networkFetchCommunityImages(versionId, limit);
}

/**
 * One community-grid tile -- the thumbnail (same skeleton/retry/exhaust
 * machinery every other gallery in this pack shares, `attachThumbCandidate`)
 * plus a static attribution caption underneath (`communityAttributionLabel`,
 * reused verbatim, never re-derived). Deliberately carries NO prompt
 * overlay, NO drawer, NO copy button, and NO hover-revealed anything --
 * unlike `buildGalleryEntryEl` just above, this function has no `onCopyPrompt`
 * parameter to plumb through at all, which is what makes "no copy-prompt
 * control exists anywhere in this section" true by construction rather than
 * by a runtime check (task brief point 4). */
function buildCommunityEntryEl(doc, entry, { isStale, backoffMs, gate }) {
  const tile = el(doc, "div", "wtn-dv-community-tile");
  const box = el(doc, "div", "wtn-dv-cbox");
  const skeleton = el(doc, "span", THUMB_SKELETON_CLASS);
  box.appendChild(skeleton);
  tile.appendChild(box);

  gate.schedule((release) => {
    if (isStale()) {
      release();
      return;
    }
    const clearSkeleton = (t) => {
      if (skeleton.parentNode === t && typeof t.removeChild === "function") {
        t.removeChild(skeleton);
      }
    };
    attachThumbCandidate(doc, box, [entry.url], { index: 0, retried: false }, isStale, backoffMs, (d, t) => {
      clearSkeleton(t);
      t.appendChild(el(d, "span", "wtn-dv-gimg-ph"));
      release();
    }, (d, t) => {
      clearSkeleton(t);
      release();
    });
  });

  const captionText = communityAttributionLabel(entry);
  if (captionText) {
    const caption = el(doc, "div", "wtn-dv-ccaption");
    caption.textContent = captionText; // never innerHTML -- `username` is third-party, user-authored text
    tile.appendChild(caption);
  }
  return tile;
}

/** Renders `communityImagesView(resp, level)` into `host` (a caller-owned,
 * INITIALLY EMPTY `.wtn-dv-community-host`), wholesale -- `host.innerHTML =
 * ""` first so a re-render (there is at most one, per this section's own
 * "at most once per version per open" contract, but this stays idempotent
 * regardless) never doubles up. Renders NOTHING at all -- no heading, no
 * empty-state line -- when `communityImagesView` says not to (task brief
 * point 5); otherwise a `Community Images` heading, the level-passing grid
 * (only when non-empty -- a fully level-locked result still gets the
 * heading and the hidden-count line, no empty grid), and the hidden-count
 * line (`.wtn-dv-gallery-hidden`, the AUTHOR gallery's own class/wording,
 * reused verbatim rather than a second phrasing) whenever anything is
 * actually hidden. */
function renderCommunityImages(doc, host, resp, level, { tileWidthPx, backoffMs, concurrency, isStale }) {
  host.innerHTML = "";
  const view = communityImagesView(resp, level);
  if (!view.shouldRender) {
    return; // silent -- covers every non-"ok" reason AND a genuinely empty gallery alike
  }
  const heading = el(doc, "h4", "wtn-dv-sechead");
  heading.textContent = "Community Images";
  host.appendChild(heading);
  if (view.visible.length > 0) {
    const grid = el(doc, "div", "wtn-dv-community-grid");
    grid.style.setProperty("--wtn-dv-community-tile", `${tileWidthPx}px`);
    const gate = createLoadGate(concurrency);
    for (const entry of view.visible) {
      grid.appendChild(buildCommunityEntryEl(doc, entry, { isStale, backoffMs, gate }));
    }
    host.appendChild(grid);
  }
  if (view.hiddenCount > 0) {
    const hiddenEl = el(doc, "div", "wtn-dv-gallery-hidden");
    hiddenEl.textContent = `${view.hiddenCount} image${view.hiddenCount === 1 ? "" : "s"} hidden by your browsing level.`;
    host.appendChild(hiddenEl);
  }
}

/**
 * Builds the detail view's own root element. Rebuilt wholesale on every
 * call (matches `civitai_search.mjs`/`civitai_modal.mjs`'s own "rebuild the
 * dynamic host" convention) -- the CALLER owns re-invoking this whenever
 * `result`/`versionId`/`detail` change (a version switch, a fetch
 * resolving) and swapping the returned `el` into its own host.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {number} [opts.galleryTileWidth] - the gallery's own tile width, in
 *   px (default 200, the modal's pre-existing size). Replaces the old
 *   two-valued `layout: "twoCol"|"filmstrip"` gallery SHAPE switch
 *   (2026-08-01, owner: "let's lower the images again, maybe so 3 images
 *   per row and horizontal scroll" -- the picker's own gallery, previously a
 *   plain 2-column grid with no horizontal scroll, became a filmstrip too,
 *   at a smaller tile size, to fit three across its own ~396px panel). Both
 *   mounts are now the SAME single horizontally-scrolling filmstrip row
 *   (`.wtn-dv-gallery-filmstrip`) -- tile WIDTH is the only thing that ever
 *   differed between them, so `layout` naming a "shape" stopped being true
 *   the moment a second shape stopped existing; this parameter names what
 *   it actually controls instead. The picker passes `115` (three tiles fit
 *   its own panel width); the modal keeps this default of `200` unchanged.
 *   The prompt drawer (below) is sized to match this SAME tile exactly (see
 *   `.wtn-dv-gdrawer`'s own CSS comment) -- a 2026-08-02 reversal of an
 *   earlier attempt to widen the drawer past a narrow tile, which could
 *   never actually escape `.wtn-dv-gallery-filmstrip`'s own `overflow-x:
 *   auto` clip regardless of what the tile itself did.
 * @param {object} opts.result - the raw search-result object (has `versions[]`,
 *   `model_id`, `name`, `creator`, `type`, `tags`, `stats`, `nsfw_level`).
 * @param {number} [opts.versionId] - the currently-selected version id;
 *   falls back to the primary version, same as `resolveVersionView`.
 * @param {number} [opts.browsingLevel] - the numeric "maximum browsing
 *   level" (`levelLabelToInt`'s own output) -- governs the gallery AND the
 *   identity thumbnail.
 * @param {object} [opts.detail] - `{status: "loading"|"loaded"|"error",
 *   modelDescription, versionDescription, modelDescriptionChecked, gallery}`
 *   -- the caller's own fetched extra data for `versionId` (or `undefined`
 *   while nothing has resolved yet, rendered as a loading state).
 * @param {(doc: Document, view: object, result: object) => Element} [opts.buildActionEl]
 *   - the caller's OWN primary-action element (download/installed/gated/...),
 *   built against the SELECTED version's flat `view` -- this component never
 *   makes a download decision itself (§7c: the two mounts' actions genuinely
 *   differ -- "returns to the row" vs. "lands in the derived folder").
 * @param {(versionId: number) => void} [opts.onVersionChange]
 * @param {() => void} [opts.onBack] - "← back to results" -- the TOPBAR
 *   shape's own control ONLY (`fixedTopBar: true`, the modal): it genuinely
 *   swaps the master grid back into view, so "back" is an honest verb for
 *   what it does. Rendered into `.wtn-dv-topbar`; has no effect at all when
 *   `fixedTopBar` is false -- the header shape never had a real "back" step
 *   to offer (see `onClose`, directly below, for what it renders instead).
 * @param {() => void} [opts.onClose] - the HEADER shape's own control ONLY
 *   (`fixedTopBar` false/default, the picker): a ✕ affordance pinned to the
 *   top-right corner of `.wtn-dv-header`. Owner, 2026-08-01: *"why do we
 *   have a back button in this menu?"* -- fair, because the picker's detail
 *   view is a SIBLING overlay (§7c-ii), never a swap back to a list, so
 *   dismissing it is "close", not "back". This replaced an earlier
 *   `onBack`-driven "← back to results" that used to render at the BOTTOM of
 *   the scrolling `.wtn-dv-body` in this shape -- both the wrong verb (no
 *   "back" step exists here to describe) and the wrong place (the bottom of
 *   a long scroll, when Escape/outside-click were the only OTHER way out of
 *   this panel and neither is discoverable). Has no effect at all when
 *   `fixedTopBar` is true -- the topbar shape's own `← back to results`
 *   (above) already covers leaving it.
 * @param {boolean} [opts.fixedTopBar] - which PINNED shape this mount wants
 *   (owner, 2026-08-01, corrected to per-mount the same day -- "what i
 *   mentioned was for the browser modal"): `false` (default, the picker's
 *   own sibling panel) keeps identity/`View on Civitai ↗`/the version
 *   selector/the download action together in `.wtn-dv-header`, with
 *   `onClose`'s own ✕ pinned to that same header's corner (see its own doc
 *   comment, above, for why a close affordance replaced the earlier back
 *   button here). `true` (the modal's master→detail swap) instead pins
 *   ONLY `← results` + the version selector + the download action, together,
 *   on one row, in `.wtn-dv-topbar` -- the modal's own actual complaint was
 *   that reaching `← results` meant scrolling past an entire model
 *   description first; identity/`View on Civitai ↗` move into the
 *   scrolling body in this shape. An explicit, caller-set parameter rather
 *   than an inference from `layout` -- the two happen to correlate one-to-
 *   one today (each mount always passes the same `layout`+`fixedTopBar`
 *   pair), but they answer different questions (gallery column count vs.
 *   which controls are pinned) and a THIRD mount is not entitled to assume
 *   they still agree.
 * @param {(text: string) => (void|Promise<void>)} [opts.onCopyPrompt] -
 *   defaults to `navigator.clipboard.writeText`, injectable for tests.
 * @param {number} [opts.thumbRetryBackoffMs]
 * @param {number} [opts.galleryConcurrency] - the gallery's own load-gate cap
 *   (default 4) -- task brief: "cap concurrency."
 * @param {number} [opts.fontSizePx] - the base body-text size, in px, THIS
 *   MOUNT wants (default `DETAIL_VIEW_FALLBACK_FONT_SIZE_PX`, 14 -- the
 *   modal's own pre-existing/owner-asked-for size). Sibling to
 *   `galleryTileWidth`, above, in every sense: one option, one caller-
 *   supplied number per mount, clamped/degraded the same defensive way
 *   (`clampDetailViewFontSize`, this file's own "Accessible font sizing"
 *   section) rather than trusted raw. The picker passes its OWN, smaller
 *   setting (`civitai_search.mjs` reads `CIVITAI_DETAIL_PANEL_FONT_SIZE`);
 *   the modal passes its own (`civitai_modal.mjs` reads
 *   `CIVITAI_DETAIL_MODAL_FONT_SIZE`) -- this component itself never reads a
 *   setting or asks which mount it is in, exactly like `galleryTileWidth`.
 *   Every OTHER font-size in this component is a fixed ratio off this one
 *   number (`FONT_RATIOS`) -- never a second, independently-chosen size.
 * @param {number} [opts.communityTileWidth] - the COMMUNITY grid's own
 *   MINIMUM tile width, in px (default 140 -- the modal's size, mirroring
 *   `galleryTileWidth`'s own default being the MODAL's size while the picker
 *   overrides down; `civitai_search.mjs` passes its own narrower
 *   `DETAIL_PANEL_COMMUNITY_TILE_PX`, 90, for its ~396px panel). Sibling to
 *   `galleryTileWidth`, above, in shape ("one option, one caller-supplied
 *   number per mount") but NOT in meaning: this grid is a responsive
 *   `auto-fill`/`minmax(...)` CSS grid (task brief: "a responsive grid, not
 *   a filmstrip"), so this is a FLOOR a tile may shrink to, not the fixed
 *   width every filmstrip tile takes -- the grid itself decides how many
 *   columns of at least this width fit whichever mount it's in. A
 *   garbage/non-positive value degrades to this same default, mirroring
 *   `galleryTileWidth`'s own guard.
 * @param {number} [opts.communityImagesLimit] - the `limit` query param this
 *   section's own fetch sends (default 24, matching the route's own default,
 *   `src/model_browser/api.py`'s `_COMMUNITY_IMAGES_DEFAULT_LIMIT`).
 * @param {(versionId: number, limit: number) => Promise<{reason: string, images: Array}>} [opts.fetchCommunityImages]
 *   - the COMMUNITY grid's own network call, injectable for tests (default
 *   `defaultFetchCommunityImages`, a thin wrapper around `civitai_api.mjs`'s
 *   real `fetchCommunityImages`) -- same "caller-injectable, network-backed
 *   default" shape as `onCopyPrompt`, never a hardcoded `fetch()` in the
 *   render path. Called AT MOST ONCE per `buildModelDetailView` call (this
 *   file's own top doc comment, "ONE deliberate exception", has the full
 *   "why" and the two layers that enforce it), triggered by the section's
 *   own `IntersectionObserver` the first time it scrolls into view -- never
 *   on open, never a second time for repeated intersections of the SAME
 *   call. Falls back to firing immediately (eager, not lazy) when
 *   `doc.defaultView.IntersectionObserver` is unavailable -- an extremely
 *   unlikely environment in practice (every evergreen browser this pack
 *   targets has had it for years), but "the feature quietly never works"
 *   is a worse failure than "the feature loses its lazy-load property" in
 *   that one degenerate case (task brief: "behind an explicit action if an
 *   observer proves impractical in this DOM" -- eager IS that fallback
 *   action here, since there is no scroll-position signal left to wait on).
 * @returns {{el: Element, destroy: () => void}} `destroy()` marks every
 *   pending thumbnail/gallery retry timer stale so a caller that replaces
 *   this element mid-retry never leaves an orphaned timer writing into a
 *   detached box (same `renderGeneration` discipline every sibling render
 *   module in this pack already follows), and disconnects the community
 *   section's own `IntersectionObserver` if it hasn't fired yet.
 */
export function buildModelDetailView({
  doc,
  galleryTileWidth = 200,
  fontSizePx = DETAIL_VIEW_FALLBACK_FONT_SIZE_PX,
  communityTileWidth = 140,
  communityImagesLimit = 24,
  fetchCommunityImages: fetchCommunityImagesFn = defaultFetchCommunityImages,
  result,
  versionId,
  browsingLevel = 1,
  detail,
  buildActionEl,
  onVersionChange,
  onBack,
  onClose,
  fixedTopBar = false,
  onCopyPrompt = defaultCopyToClipboard,
  thumbRetryBackoffMs = THUMB_RETRY_BACKOFF_MS,
  galleryConcurrency = 4,
} = {}) {
  injectStyles(doc);

  let stale = false;
  const isStale = () => stale;

  // A garbage/non-finite/non-positive `galleryTileWidth` degrades to the
  // same 200px default rather than producing an invalid `width: NaNpx` --
  // mirrors this file's own "never throw on a bad caller value" convention.
  const tileWidthPx = Number.isFinite(galleryTileWidth) && galleryTileWidth > 0 ? galleryTileWidth : 200;

  // Same degrade rule as `tileWidthPx`, for the community grid's own minimum
  // tile width.
  const communityTileWidthPx = Number.isFinite(communityTileWidth) && communityTileWidth > 0 ? communityTileWidth : 140;

  // The accessible font-size scale (this file's own "Accessible font
  // sizing" section, above) -- clamped/degraded exactly like tileWidthPx
  // just above, then written as the ONE custom property every font-size in
  // this component's CSS reads through `fontCalc`.
  const fontScale = detailViewFontScale(fontSizePx);

  // `wtn-flex-bound` (js/shared/theme.css) -- the shared `min-width: 0;
  // min-height: 0;` fix for a bounded flex/scroll region, applied to both
  // this root AND `bodyHost` below: this component's own third occurrence
  // of the trap (`.wtn-cm-main`/`.wtn-cm-detailhost`, civitai_modal.mjs, are
  // the other two) is exactly why it's a shared class now, not a fourth
  // hand-written copy of the same two properties.
  const root = el(doc, "div", "wtn-dv wtn wtn-flex-bound");
  root.style.setProperty("--wtn-dv-font-scale", String(fontScale));
  // The pinned/scrolling split (this file's own CSS comment, "Owner-reported
  // bug (2026-08-01)") -- `topControls` never scrolls; `bodyHost` is the ONE
  // region that does. Named `bodyHost`, not `body`, because the description
  // section below already uses `body` for each description's own text
  // element -- two different things, kept from colliding on one name.
  // `topControls` carries whichever CSS class matches `fixedTopBar`
  // (`buildModelDetailView`'s own doc comment on that parameter has the
  // full "why" for the two shapes) -- everything appended into it below is
  // otherwise IDENTICAL code for both; only the identity block and the back
  // affordance change which host they append to.
  const topControls = el(doc, "div", fixedTopBar ? "wtn-dv-topbar" : "wtn-dv-header");
  const bodyHost = el(doc, "div", "wtn-dv-body wtn-flex-bound");
  root.appendChild(topControls);
  root.appendChild(bodyHost);
  // Identity (thumbnail/title/creator/badges/stats) and `View on Civitai ↗`
  // are part of the pinned header shape, but scroll away with everything
  // else in the topbar shape (only `← results`/version/download are pinned
  // there) -- `identityHost` is simply whichever of the two that is.
  const identityHost = fixedTopBar ? bodyHost : topControls;

  const safeResult = result && typeof result === "object" ? result : {};
  const view = resolveVersionView(safeResult, versionId);
  const versions = Array.isArray(safeResult.versions) ? safeResult.versions : [];

  // ---- the topbar shape's own "← results", built FIRST so it can be the
  // FIRST child appended below (task brief's own order: back, version,
  // download). ---------------------------------------------------------------
  if (fixedTopBar && typeof onBack === "function") {
    const backBtn = el(doc, "button", "wtn-dv-back");
    backBtn.type = "button";
    backBtn.textContent = "← back to results";
    backBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onBack();
    });
    topControls.appendChild(backBtn);
  }

  // ---- the header shape's own ✕ close affordance (owner, 2026-08-01) --
  // `onClose`'s own doc comment above has the full "why a close button, not
  // a back button, and why the corner rather than the bottom of the scroll".
  // `.wtn-dv-close` is absolutely positioned (this file's own CSS), so where
  // it's appended within `topControls` doesn't affect where it paints --
  // appended here, alongside the topbar's own pinned controls, rather than
  // down in the identity block below, purely to keep every `topControls`-
  // level append grouped together at the top of this function. -------------
  if (!fixedTopBar && typeof onClose === "function") {
    const closeBtn = el(doc, "span", "wtn-dv-close");
    closeBtn.textContent = "✕"; // ✕
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClose();
    });
    topControls.appendChild(closeBtn);
  }

  // ---- identity ----------------------------------------------------------
  const head = el(doc, "div", "wtn-dv-head");
  head.appendChild(buildThumb(doc, view, browsingLevel, isStale, thumbRetryBackoffMs));
  const identity = el(doc, "div", "wtn-dv-identity");
  const title = el(doc, "div", "wtn-dv-title");
  title.textContent = view.name || "(untitled)";
  title.title = view.name || "";
  identity.appendChild(title);
  // Byline + chips share ONE row (owner, 2026-08-01: "LORA / ZImageBase
  // currently sit on their own line below 'by EauDeNoire' ... put them on
  // the same row ... that reclaims a line in a panel where vertical space
  // is the scarce resource") -- byline left-aligned (normal flow), chips
  // pushed flush right via `.wtn-dv-badges`'s own `margin-left: auto`
  // rather than `justify-content: space-between` on the row, which would
  // misalign a LONE child (no creator, or no chips at all) to the left.
  const bylineRow = el(doc, "div", "wtn-dv-bylinerow");
  if (safeResult.creator) {
    const creator = el(doc, "div", "wtn-dv-creator");
    creator.textContent = `by ${safeResult.creator}`;
    bylineRow.appendChild(creator);
  }
  const badges = el(doc, "div", "wtn-dv-badges");
  if (safeResult.type) {
    const typeBadge = el(doc, "span", "wtn-dv-badge");
    typeBadge.textContent = String(safeResult.type);
    badges.appendChild(typeBadge);
  }
  const baseModel = resultBaseModel(view);
  if (baseModel) {
    const baseBadge = el(doc, "span", "wtn-dv-badge");
    baseBadge.textContent = baseModel;
    badges.appendChild(baseBadge);
  }
  if (badges.children.length) {
    bylineRow.appendChild(badges);
  }
  if (bylineRow.children.length) {
    identity.appendChild(bylineRow);
  }
  const stats = safeResult.stats && typeof safeResult.stats === "object" ? safeResult.stats : null;
  const updated = formatDateLabel(view.published_at);
  const statParts = [];
  if (stats) {
    statParts.push(`${formatCompactCount(stats.downloads)} downloads`);
    if (Number.isFinite(stats.rating) && stats.rating > 0) {
      statParts.push(`★ ${stats.rating}`);
    }
  }
  if (updated) {
    statParts.push(`updated ${updated}`);
  }
  if (statParts.length) {
    const statsEl = el(doc, "div", "wtn-dv-stats");
    statsEl.textContent = statParts.join(" · ");
    identity.appendChild(statsEl);
  }
  head.appendChild(identity);
  identityHost.appendChild(head);

  // ---- View on Civitai ↗ (§7d: links the SELECTED VERSION, never the
  // model's bare landing page) ---------------------------------------------
  const civUrl = civitaiModelUrl(safeResult.model_id, view.primary_version_id);
  if (civUrl) {
    const civLink = el(doc, "a", "wtn-dv-civlink");
    civLink.href = civUrl;
    civLink.target = "_blank";
    civLink.rel = "noopener noreferrer";
    civLink.textContent = "View on Civitai ↗";
    identityHost.appendChild(civLink);
  }

  identityHost.appendChild(el(doc, "hr", "wtn-dv-sep"));

  // ---- version selector + primary action -- NO "Version" label (owner,
  // 2026-08-01: "redundant -- the select's own options read 'Hands zib
  // v1.0 — 162 MB', self-evidently a version"); the select just takes the
  // row/stack's full flexible width in its place. --------------------------
  const versionSel = el(doc, "select", "wtn-select wtn-dv-version-sel");
  const usableVersions = versions.length ? versions : [{ version_id: view.primary_version_id, name: view.name, size_kb: view.size_kb }];
  for (const v of usableVersions) {
    const opt = el(doc, "option");
    opt.value = String(v.version_id);
    opt.textContent = versionOptionLabel(v);
    if (v.version_id === view.primary_version_id) {
      opt.selected = true;
    }
    versionSel.appendChild(opt);
  }
  versionSel.value = String(view.primary_version_id);
  versionSel.disabled = usableVersions.length <= 1;
  versionSel.title = "Choose which version to view and download.";
  versionSel.addEventListener("click", (e) => e.stopPropagation());
  versionSel.addEventListener("change", (e) => {
    e.stopPropagation();
    const chosenId = Number(versionSel.value);
    if (typeof onVersionChange === "function") {
      onVersionChange(chosenId);
    }
  });

  const actionHost = el(doc, "div", "wtn-dv-actionhost");
  if (typeof buildActionEl === "function") {
    const actionEl = buildActionEl(doc, view, safeResult);
    if (actionEl) {
      actionHost.appendChild(actionEl);
    }
  }

  if (fixedTopBar) {
    // The modal's own shape (owner, second correction, 2026-08-01: "make it
    // above the download button on the right side of the screen") -- a
    // right-aligned STACK, version on top, download beneath -- see
    // `.wtn-dv-vdstack`'s own CSS comment for the full "why".
    const vdStack = el(doc, "div", "wtn-dv-vdstack");
    vdStack.appendChild(versionSel);
    vdStack.appendChild(actionHost);
    topControls.appendChild(vdStack);
  } else {
    // The picker's own shape (owner: "version select and download on one
    // row ... select flexible, button intrinsic, same as the modal's
    // topbar already does" -- before the modal's OWN ask changed to a
    // stack, above; the picker keeps the one-row layout it was given).
    const vdRow = el(doc, "div", "wtn-dv-vdrow");
    vdRow.appendChild(versionSel);
    vdRow.appendChild(actionHost);
    topControls.appendChild(vdRow);
  }

  const d = detail && typeof detail === "object" ? detail : {};

  // ---- gallery, MOVED to the TOP of the scrolling body (owner, 2026-08-01:
  // "if its the author gallery it should be at the top, before the model
  // description ... fastest answer to what does this LoRA actually do" --
  // it used to sit below a description that can run thousands of pixels,
  // which is what made it feel missing in the first place). Author's own --
  // see this file's own top doc comment for why the heading reads GALLERY,
  // not "community images". ------------------------------------------------
  // A real `<h4>`, not a styled `<div>` (2026-08-02, accessibility pass --
  // `.wtn-dv-sechead`'s own CSS comment, above, has the full "why `<h4>`/why
  // `font-weight: normal`"). Same for the two description headings below.
  const galleryHeading = el(doc, "h4", "wtn-dv-sechead");
  galleryHeading.textContent = "Gallery";
  bodyHost.appendChild(galleryHeading);

  const gallery = Array.isArray(d.gallery) ? d.gallery : [];
  const gState = galleryState(gallery, browsingLevel, view.nsfw_level);
  if (d.status === "loading" && gallery.length === 0) {
    const loadingEl = el(doc, "div", "wtn-dv-gallery-empty");
    loadingEl.textContent = "Loading gallery…";
    bodyHost.appendChild(loadingEl);
  } else if (gState === "locked") {
    const lockedEl = el(doc, "div", "wtn-dv-gallery-locked");
    lockedEl.textContent = "Gallery hidden — above your browsing level.";
    bodyHost.appendChild(lockedEl);
  } else {
    const visible = visibleGalleryEntries(gallery, browsingLevel);
    if (visible.length === 0) {
      const emptyEl = el(doc, "div", "wtn-dv-gallery-empty");
      emptyEl.textContent = "No gallery images for this version.";
      bodyHost.appendChild(emptyEl);
    } else {
      const grid = el(doc, "div", "wtn-dv-gallery-filmstrip");
      // The one call site that knows "how wide" -- `--wtn-dv-gallery-tile`
      // (read by `.wtn-dv-gallery-filmstrip .wtn-dv-gimg`'s own `width`,
      // above, by inheritance from THIS element) is set here, once, rather
      // than duplicated as a bare number downstream. `.wtn-dv-gdrawer` no
      // longer has a `width` of its own to read it (2026-08-02: it matches
      // its tile via `left: 0; right: 0` instead of a computed width).
      grid.style.setProperty("--wtn-dv-gallery-tile", `${tileWidthPx}px`);
      const gate = createLoadGate(galleryConcurrency);
      for (const entry of visible) {
        grid.appendChild(buildGalleryEntryEl(doc, entry, { onCopyPrompt, isStale, backoffMs: thumbRetryBackoffMs, gate }));
      }
      bodyHost.appendChild(grid);
      // Owner, 2026-08-01: "why does the gallery show only 6 images" -- the
      // level filter, silently. State the omission instead of just vanishing
      // it (never a grid of lock glyphs, one for each -- "one honest line is
      // information"), and ONLY when something is actually hidden --
      // `hiddenGalleryCount` is already 0 at the maximum browsing level, so
      // this never renders a false claim there.
      const hiddenCount = hiddenGalleryCount(gallery, browsingLevel);
      if (hiddenCount > 0) {
        const hiddenEl = el(doc, "div", "wtn-dv-gallery-hidden");
        hiddenEl.textContent = `${hiddenCount} image${hiddenCount === 1 ? "" : "s"} hidden by your browsing level.`;
        bodyHost.appendChild(hiddenEl);
      }
    }
  }

  bodyHost.appendChild(el(doc, "hr", "wtn-dv-sep"));

  // ---- both descriptions, each under its OWN label (§7d-i), VERSION before
  // MODEL -- reordered the same day as the gallery move above (owner's own
  // new body order: "identity/stats -> gallery -> version description ->
  // model description"). ---------------------------------------------------
  const descView = detailDescriptionsView({
    modelDescription: d.modelDescription,
    versionDescription: d.versionDescription,
    modelDescriptionChecked: d.modelDescriptionChecked,
    loading: d.status === "loading",
  });
  if (descView.version) {
    const heading = el(doc, "h4", "wtn-dv-sechead");
    heading.textContent = "Version Description";
    bodyHost.appendChild(heading);
    const body = el(doc, "div", "wtn-dv-desc");
    body.textContent = descView.version;
    bodyHost.appendChild(body);
  }
  if (descView.model) {
    const heading = el(doc, "h4", "wtn-dv-sechead");
    heading.textContent = "Model Description";
    bodyHost.appendChild(heading);
    const body = el(doc, "div", "wtn-dv-desc");
    body.textContent = descView.model; // never innerHTML -- already plain text (html_to_text ran server-side)
    bodyHost.appendChild(body);
  }
  if (descView.emptyMessage) {
    const empty = el(doc, "div", "wtn-dv-desc-empty");
    empty.textContent = descView.emptyMessage;
    bodyHost.appendChild(empty);
  }

  // ---- COMMUNITY IMAGES, below BOTH descriptions (task brief's own layout
  // instruction) -- this file's own top doc comment, "ONE deliberate
  // exception", has the full "why" this section owns its own fetch rather
  // than waiting on the caller like every field above. `communityHost` is
  // the sentinel the observer below watches; it starts and STAYS completely
  // empty (no heading, no placeholder box) until a fetch resolves with
  // something worth showing (`renderCommunityImages`'s own "silent on
  // failure or empty" rule). --------------------------------------------
  const communityHost = el(doc, "div", "wtn-dv-community-host");
  bodyHost.appendChild(communityHost);

  let communityFetchStarted = false;
  let communityObserver = null;

  function startCommunityFetch() {
    if (communityFetchStarted) {
      return; // an observer firing more than once must never trigger a second request
    }
    communityFetchStarted = true;
    if (communityObserver) {
      communityObserver.disconnect();
    }
    Promise.resolve(fetchCommunityImagesFn(view.primary_version_id, communityImagesLimit)).then((resp) => {
      if (isStale()) {
        return; // this render pass is no longer current -- never write into a detached host
      }
      renderCommunityImages(doc, communityHost, resp, browsingLevel, {
        tileWidthPx: communityTileWidthPx, backoffMs: thumbRetryBackoffMs, concurrency: galleryConcurrency, isStale,
      });
    });
  }

  const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
  if (win && typeof win.IntersectionObserver === "function") {
    communityObserver = new win.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        startCommunityFetch();
      }
    });
    communityObserver.observe(communityHost);
  } else {
    // No IntersectionObserver in this DOM -- `fetchCommunityImages`'s own
    // doc comment has the full "why eager, not silently never" reasoning.
    startCommunityFetch();
  }

  // The header shape (picker) used to build its OWN "← back to results"
  // here, at the bottom of the scrolling body -- removed (owner, 2026-08-01:
  // "why do we have a back button in this menu?"). It never described a real
  // navigation step (this panel is a SIBLING overlay, not a swap back to a
  // list) and sat at the bottom of a long scroll besides. Replaced by
  // `onClose`'s own ✕, pinned in `.wtn-dv-header`'s corner -- see that
  // parameter's own doc comment for the full "why". The topbar shape's
  // (modal's) `← back to results` is unchanged, built at the TOP of this
  // function as the first child of `.wtn-dv-topbar` -- see that block's own
  // comment, above.

  return {
    el: root,
    destroy() {
      stale = true;
      if (communityObserver) {
        communityObserver.disconnect();
      }
    },
  };
}
