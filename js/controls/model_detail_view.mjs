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
 * come from `buildModelDetailView` below, parameterised by `layout`
 * (renamed 2026-08-01 -- see that parameter's own doc comment for the full
 * "why": `"twoCol"`, the picker's small two-across grid, vs. `"filmstrip"`,
 * the modal's single horizontally-scrolling row — the OLD names,
 * `"vertical"`/`"grid"`, described the gallery's shape backwards once the
 * picker's own gallery became a two-column GRID and the modal's became a
 * single-row FILMSTRIP) and, since 2026-08-01, by `fixedTopBar` too (that
 * parameter's own doc comment has the full "why" — the picker and the modal
 * turned out to want DIFFERENT pinned-controls shapes, not just different
 * gallery layouts).
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
 * network anywhere in this module.
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
 */

import { resolveVersionView, resultBaseModel, formatCompactCount } from "./civitai_search.mjs";
import { civitaiModelUrl } from "./model_info.mjs";
import { formatFileSize } from "./model_picker.mjs";
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
.wtn-dv { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink}); }
/* Owner-reported bug (2026-08-01): "the detail panel should have padding,
   see how the content is tight to the border of the panel" -- neither pinned
   region (this rule, \`.wtn-dv-topbar\` below) nor the scrolling body
   (\`.wtn-dv-body\` below) had ANY padding, so identity/descriptions/gallery
   all butted straight against the panel edge. Matches this pack's own
   existing panel rhythm rather than inventing a new spacing scale --
   \`civitai_search.mjs\`'s own \`.wtn-cs-body\` is \`padding: 9px 10px 10px\`;
   this header shares that same top/side value, minus the bottom third
   (its last child, \`.wtn-dv-actionhost\`, already carries its own \`margin:
   6px 0 8px\`, so a padding-bottom here would just double that gap against
   \`.wtn-dv-body\`'s own top padding immediately below it). \`position:
   relative\` is only so \`.wtn-dv-close\` (below) can anchor to THIS box's own
   corner, not the whole \`.wtn-dv\` root. The reserved 18px on the right
   (28px vs. the 10px every other edge gets) is that same close button's own
   clearance -- so a long, wrapped title's first line never runs under it. */
.wtn-dv-header { flex: none; display: flex; flex-direction: column; gap: 2px; position: relative; padding: 9px 28px 0 10px; }
/* The picker's own close affordance (owner, 2026-08-01, replacing the
   removed "← back to results" -- see \`onClose\`'s own doc comment on
   \`buildModelDetailView\` for the full "why") -- same ✕ glyph, same
   ink-faint/ink hover colours, same top-right corner as this pack's other
   two panel closers (\`civitai_search.mjs\`'s own \`.wtn-cs-close\`,
   \`civitai_modal.mjs\`'s own \`.wtn-cm-close\`), just this component's own
   class rather than reaching into either sibling file's stylesheet. */
.wtn-dv-close { position: absolute; top: 8px; right: 8px; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 13px; }
.wtn-dv-close:hover { color: var(--wtn-ink, ${TOKENS.ink}); }
/* Owner-reported, then corrected to modal-only (2026-08-01): "back to
   results should not be in the end of the scroll down... it should be in
   the top navigation bar, which should be fixed position, which should
   also show the download button and the version selection" -- the MODAL's
   own shape only (\`fixedTopBar: true\`; the picker keeps \`.wtn-dv-header\`,
   above, unchanged -- see \`buildModelDetailView\`'s own doc comment for the
   full "why one component, two pinned shapes"). One row -- the modal is 90%
   of the viewport, so unlike a narrow anchored panel these three always
   fit; no wrapping needed. The version selector (\`.wtn-dv-versionrow\`,
   reused unchanged from the header shape, just re-scoped below) gets the
   FLEXIBLE width -- its own labels carry a name AND a size and are the most
   variable of the three -- while \`← results\`/the download action keep
   their intrinsic size. */
.wtn-dv-topbar {
  flex: none; display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  /* Same padding fix as \`.wtn-dv-header\` above, this shape's own pinned
     region -- top/sides match this pack's own panel rhythm
     (\`civitai_search.mjs\`'s \`.wtn-cs-head\`, \`padding: 8px 10px\`); bottom
     stays the pre-existing 8px (the separator's own clearance, unchanged). */
  padding: 8px 10px 8px; border-bottom: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
}
.wtn-dv-topbar .wtn-dv-versionrow { flex: 1 1 auto; min-width: 0; margin-bottom: 0; }
.wtn-dv-topbar .wtn-dv-actionhost { flex: none; margin: 0; }
/* Owner-reported, with a screenshot (2026-08-01): "← back to results" reads
   shorter than the version <select> beside it in this row -- the SAME class
   of bug \`.wtn-cs-action\`'s own doc comment already names for the Delete-vs-
   ✓-installed mismatch (a plain element's box is padding+line-height+border,
   but a native form control ALSO carries the browser's own chrome, which
   doesn't obey that padding/line-height the same way) -- not a padding
   difference to eyeball, a THIRD different element (a dashed \`<button>\`, a
   native \`<select>\`, and whatever \`buildActionEl\` returns) each sized by its
   own chrome. Fixed the same way: pin all three to one explicit height +
   box-sizing: border-box, so line-height/native chrome no longer decides
   it. Height picked to comfortably fit the SELECT (the tallest of the
   three unstyled) rather than the button's smaller natural size. */
.wtn-dv-topbar .wtn-dv-back {
  flex: none; margin-top: 0; align-self: center; height: 26px; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; padding: 0 9px;
  appearance: none; -webkit-appearance: none;
}
/* Owner-reported, same screenshot: the select's own dropdown arrow sits
   flush against its right border -- needs its own padding-right to clear
   it, same family of native-\`<select>\` problem \`.wtn-cs-version-sel\`
   (civitai_search.mjs) already solved for ITS own narrow, ellipsised shape;
   this one doesn't need the ellipsis treatment (this row's version select
   is the flexible-width element, never clipped), just the right-hand
   clearance and the same fixed-height/border-box treatment as the other
   two controls in this row. */
.wtn-dv-topbar .wtn-dv-version-sel { height: 26px; box-sizing: border-box; padding: 0 22px 0 8px; }
/* The scrolling body's own padding lives HERE, on the element that actually
   carries \`overflow-y: auto\` -- never on an ancestor. Padding on a scroll
   container's PARENT instead would leave its scrollbar inset from the panel
   edge and clip content oddly at the scroll boundary; this is why it isn't
   hoisted onto \`.wtn-dv\` (the ancestor both pinned shapes and this body
   share). Value matches \`civitai_search.mjs\`'s own \`.wtn-cs-body\` exactly
   (\`padding: 9px 10px 10px\`) -- same family of panel, same rhythm. */
.wtn-dv-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 9px 10px 10px; }
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
.wtn-dv-title { font-size: 14px; font-weight: 600; line-height: 1.25; }
.wtn-dv-creator { font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); margin-top: 2px; }
.wtn-dv-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.wtn-dv-badge {
  font-size: 10px; padding: 1px 7px; border-radius: 9px; border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-dv-stats { font-size: 11px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin-top: 4px; }

.wtn-dv-civlink { display: inline-block; margin: 6px 0 0; color: var(--wtn-info, ${TOKENS.info}); font-size: 12px; text-decoration: none; }
.wtn-dv-civlink:hover { text-decoration: underline; }

.wtn-dv-sep { border: 0; border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); margin: 10px 0; }

.wtn-dv-versionrow { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.wtn-dv-versionrow label { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); font-size: 11px; flex: none; }
.wtn-dv-version-sel { flex: 1 1 auto; min-width: 0; }

.wtn-dv-actionhost { margin: 6px 0 8px; }

/* Owner-reported (2026-08-01): "GALLERY"/"VERSION DESCRIPTION"/"MODEL
   DESCRIPTION" read too small to work as section separators in a panel this
   size -- the fix is SIZE only ("keep whatever letter-spacing/uppercase
   treatment they already have"), so only \`font-size\` changes here (10px ->
   13px); letter-spacing/text-transform/colour are untouched, and every
   section heading in this file shares this ONE rule, so the three stay
   identical to each other by construction, not by three separate values
   happening to agree. */
.wtn-dv-sechead { font-family: var(--wtn-font-mono, monospace); font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--wtn-accent, ${TOKENS.accent}); margin: 8px 0 4px; }
.wtn-dv-desc { font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: pre-wrap; line-height: 1.4; }
.wtn-dv-desc-empty { font-size: 11.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; }
.wtn-dv-gallery-hidden { font-size: 10.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin-top: 6px; }

/* Owner, 2026-08-01: two mounts, two DIFFERENT gallery shapes (renamed the
   same day from the old "vertical"/"grid" \`layout\` values, which had come
   to describe the gallery's shape BACKWARDS -- see \`buildModelDetailView\`'s
   own \`layout\` doc comment for the full "why" and the rename itself).
   \`"twoCol"\` (the picker, owner: "the author images gallery ... image
   sizes should be small so 2 images fit in 1 row ... no horizontal scroll,
   only vertical") is a plain 2-column grid that wraps downward with the
   rest of the scrolling body -- no \`overflow\` of its own at all, so there
   is nothing here that COULD scroll sideways. \`"filmstrip"\` (the modal,
   owner: "it should be in 1 line with horizontal scroll") is a single ROW
   that scrolls horizontally, contained to itself -- \`min-width: 0\` is the
   exact horizontal mirror of \`.wtn-dv-body\`'s own \`min-height: 0\` fix
   above (this file's own CSS comment on that rule has the full trap): a
   flex item's default \`min-width: auto\` refuses to shrink below its
   content's width, which would silently defeat \`overflow-x: auto\` here the
   same way an unshrinkable height defeated \`overflow-y: auto\` there. Tiles
   get \`flex: none\` (never shrinking to fit, which is what actually forces
   the overflow rather than everyone cramming into the available width) and
   an explicit width, since \`.wtn-dv-gbox\`'s own \`width: 100%\` needs a
   definite box to be 100% OF. */
.wtn-dv-gallery-twocol { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.wtn-dv-gallery-filmstrip { display: flex; flex-direction: row; gap: 10px; overflow-x: auto; overflow-y: hidden; min-width: 0; padding-bottom: 4px; }
.wtn-dv-gallery-filmstrip .wtn-dv-gimg { flex: none; width: 200px; }
.wtn-dv-gimg { position: relative; border-radius: 7px; overflow: hidden; }
.wtn-dv-gbox {
  position: relative; width: 100%; aspect-ratio: 1 / 1; background: var(--wtn-console, ${TOKENS.console});
  display: flex; align-items: center; justify-content: center;
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
   \`--wtn-line\` (js/shared/theme.css), not invented either. */
.wtn-dv-gdrawer {
  display: flex; flex-direction: column; gap: 4px; padding: 8px;
  background: rgba(6, 8, 11, .65);
  border-top: 1px solid var(--wtn-line, ${TOKENS.line});
}
.wtn-dv-gprompt { font-size: 10.5px; color: var(--wtn-ink, ${TOKENS.ink}); max-height: 72px; overflow-y: auto; }
.wtn-dv-gparams { font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-dv-gcopy {
  align-self: flex-start; font: 10px var(--wtn-font-mono, monospace); padding: 2px 7px; border-radius: 5px; cursor: pointer;
  background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); border: 1px solid var(--wtn-accent, ${TOKENS.accent});
}
.wtn-dv-gcopy:hover { background: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-dv-gallery-empty, .wtn-dv-gallery-locked { font-size: 11.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); padding: 6px 0; }

.wtn-dv-back {
  margin-top: 10px; align-self: flex-start; font: 11.5px var(--wtn-font-mono, monospace); padding: 4px 9px;
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

/**
 * Builds the detail view's own root element. Rebuilt wholesale on every
 * call (matches `civitai_search.mjs`/`civitai_modal.mjs`'s own "rebuild the
 * dynamic host" convention) -- the CALLER owns re-invoking this whenever
 * `result`/`versionId`/`detail` change (a version switch, a fetch
 * resolving) and swapping the returned `el` into its own host.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {"twoCol"|"filmstrip"} [opts.layout] - which GALLERY shape this
 *   mount wants (renamed 2026-08-01 from `"vertical"`/`"grid"`, which had
 *   drifted to describe the shape backwards -- the picker's own gallery is
 *   now the one that's a GRID, and the modal's is now a single scrolling
 *   ROW): `"twoCol"` (default, the picker, §7c-ii) is a plain 2-column grid,
 *   small tiles, wrapping downward with the rest of the scrolling body --
 *   NO horizontal scroll of its own (owner, 2026-08-01: "no horizontal
 *   scroll, only vertical"). `"filmstrip"` (the modal, decision 11) is a
 *   SINGLE row that scrolls sideways, contained to itself (owner: "it
 *   should be in 1 line with horizontal scroll") -- this is the ONLY thing
 *   that differs between the two mounts' gallery.
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
 * @returns {{el: Element, destroy: () => void}} `destroy()` marks every
 *   pending thumbnail/gallery retry timer stale so a caller that replaces
 *   this element mid-retry never leaves an orphaned timer writing into a
 *   detached box (same `renderGeneration` discipline every sibling render
 *   module in this pack already follows).
 */
export function buildModelDetailView({
  doc,
  layout = "twoCol",
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

  const root = el(doc, "div", `wtn-dv wtn ${layout === "filmstrip" ? "wtn-dv-filmstrip" : "wtn-dv-twocol"}`);
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
  const bodyHost = el(doc, "div", "wtn-dv-body");
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
  if (safeResult.creator) {
    const creator = el(doc, "div", "wtn-dv-creator");
    creator.textContent = `by ${safeResult.creator}`;
    identity.appendChild(creator);
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
    identity.appendChild(badges);
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

  // ---- version selector + primary action ---------------------------------
  const versionRow = el(doc, "div", "wtn-dv-versionrow");
  const versionLabel = el(doc, "label");
  versionLabel.textContent = "Version";
  versionRow.appendChild(versionLabel);
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
  versionRow.appendChild(versionSel);
  topControls.appendChild(versionRow);

  const actionHost = el(doc, "div", "wtn-dv-actionhost");
  if (typeof buildActionEl === "function") {
    const actionEl = buildActionEl(doc, view, safeResult);
    if (actionEl) {
      actionHost.appendChild(actionEl);
    }
  }
  topControls.appendChild(actionHost);

  const d = detail && typeof detail === "object" ? detail : {};

  // ---- gallery, MOVED to the TOP of the scrolling body (owner, 2026-08-01:
  // "if its the author gallery it should be at the top, before the model
  // description ... fastest answer to what does this LoRA actually do" --
  // it used to sit below a description that can run thousands of pixels,
  // which is what made it feel missing in the first place). Author's own --
  // see this file's own top doc comment for why the heading reads GALLERY,
  // not "community images". ------------------------------------------------
  const galleryHeading = el(doc, "div", "wtn-dv-sechead");
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
      const grid = el(doc, "div", layout === "filmstrip" ? "wtn-dv-gallery-filmstrip" : "wtn-dv-gallery-twocol");
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
    const heading = el(doc, "div", "wtn-dv-sechead");
    heading.textContent = "Version Description";
    bodyHost.appendChild(heading);
    const body = el(doc, "div", "wtn-dv-desc");
    body.textContent = descView.version;
    bodyHost.appendChild(body);
  }
  if (descView.model) {
    const heading = el(doc, "div", "wtn-dv-sechead");
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
    },
  };
}
