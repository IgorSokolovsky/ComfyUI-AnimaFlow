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
 * come from `buildModelDetailView` below, parameterised only by `layout`
 * ("vertical" — one column — vs. "grid" — the modal's multi-column gallery,
 * §"The detail view": "same data, same component, two layouts").
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
.wtn-dv { display: flex; flex-direction: column; gap: 2px; font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink}); }
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

.wtn-dv-sechead { font-family: var(--wtn-font-mono, monospace); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--wtn-accent, ${TOKENS.accent}); margin: 8px 0 4px; }
.wtn-dv-desc { font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: pre-wrap; line-height: 1.4; }
.wtn-dv-desc-empty { font-size: 11.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; }

.wtn-dv-gallery-vertical { display: flex; flex-direction: column; gap: 10px; }
.wtn-dv-gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
.wtn-dv-gimg { position: relative; border-radius: 7px; overflow: hidden; }
.wtn-dv-gbox {
  position: relative; width: 100%; aspect-ratio: 1 / 1; background: var(--wtn-console, ${TOKENS.console});
  display: flex; align-items: center; justify-content: center;
}
.wtn-dv-gbox img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wtn-dv-goverlay {
  position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end; gap: 4px;
  padding: 8px; background: linear-gradient(180deg, transparent 40%, rgba(6,8,11,.92) 100%);
  opacity: 0; transition: opacity .12s ease; pointer-events: none;
}
.wtn-dv-gimg:hover .wtn-dv-goverlay, .wtn-dv-gimg:focus-within .wtn-dv-goverlay { opacity: 1; pointer-events: auto; }
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
    const promptEl = el(doc, "div", "wtn-dv-gprompt");
    promptEl.textContent = entry.prompt; // never innerHTML -- a prompt may contain "<lora:x:0.8>" or raw HTML
    overlay.appendChild(promptEl);
    const paramsLabel = galleryParamsLabel(entry.params);
    if (paramsLabel) {
      const paramsEl = el(doc, "div", "wtn-dv-gparams");
      paramsEl.textContent = paramsLabel;
      overlay.appendChild(paramsEl);
    }
    const copyBtn = el(doc, "button", "wtn-dv-gcopy");
    copyBtn.type = "button";
    copyBtn.textContent = "Copy prompt";
    copyBtn.title = "Copy this prompt";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onCopyPrompt(entry.prompt);
    });
    overlay.appendChild(copyBtn);
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
 * @param {"vertical"|"grid"} [opts.layout] - "vertical" (the picker's single
 *   column, §7c-ii) or "grid" (the modal's multi-column gallery, decision 11)
 *   -- the ONLY thing that differs between the two mounts.
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
 * @param {() => void} [opts.onBack] - "← results"/"← back to results".
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
  layout = "vertical",
  result,
  versionId,
  browsingLevel = 1,
  detail,
  buildActionEl,
  onVersionChange,
  onBack,
  onCopyPrompt = defaultCopyToClipboard,
  thumbRetryBackoffMs = THUMB_RETRY_BACKOFF_MS,
  galleryConcurrency = 4,
} = {}) {
  injectStyles(doc);

  let stale = false;
  const isStale = () => stale;

  const root = el(doc, "div", `wtn-dv wtn ${layout === "grid" ? "wtn-dv-grid" : "wtn-dv-vertical"}`);

  const safeResult = result && typeof result === "object" ? result : {};
  const view = resolveVersionView(safeResult, versionId);
  const versions = Array.isArray(safeResult.versions) ? safeResult.versions : [];

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
  root.appendChild(head);

  // ---- View on Civitai ↗ (§7d: links the SELECTED VERSION, never the
  // model's bare landing page) ---------------------------------------------
  const civUrl = civitaiModelUrl(safeResult.model_id, view.primary_version_id);
  if (civUrl) {
    const civLink = el(doc, "a", "wtn-dv-civlink");
    civLink.href = civUrl;
    civLink.target = "_blank";
    civLink.rel = "noopener noreferrer";
    civLink.textContent = "View on Civitai ↗";
    root.appendChild(civLink);
  }

  root.appendChild(el(doc, "hr", "wtn-dv-sep"));

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
  root.appendChild(versionRow);

  const actionHost = el(doc, "div", "wtn-dv-actionhost");
  if (typeof buildActionEl === "function") {
    const actionEl = buildActionEl(doc, view, safeResult);
    if (actionEl) {
      actionHost.appendChild(actionEl);
    }
  }
  root.appendChild(actionHost);

  // ---- both descriptions, each under its OWN label (§7d-i) ---------------
  const d = detail && typeof detail === "object" ? detail : {};
  const descView = detailDescriptionsView({
    modelDescription: d.modelDescription,
    versionDescription: d.versionDescription,
    modelDescriptionChecked: d.modelDescriptionChecked,
    loading: d.status === "loading",
  });
  if (descView.model) {
    const heading = el(doc, "div", "wtn-dv-sechead");
    heading.textContent = "Model Description";
    root.appendChild(heading);
    const body = el(doc, "div", "wtn-dv-desc");
    body.textContent = descView.model; // never innerHTML -- already plain text (html_to_text ran server-side)
    root.appendChild(body);
  }
  if (descView.version) {
    const heading = el(doc, "div", "wtn-dv-sechead");
    heading.textContent = "Version Description";
    root.appendChild(heading);
    const body = el(doc, "div", "wtn-dv-desc");
    body.textContent = descView.version;
    root.appendChild(body);
  }
  if (descView.emptyMessage) {
    const empty = el(doc, "div", "wtn-dv-desc-empty");
    empty.textContent = descView.emptyMessage;
    root.appendChild(empty);
  }

  root.appendChild(el(doc, "hr", "wtn-dv-sep"));

  // ---- gallery (author's own -- see this file's own top doc comment for
  // why the heading reads GALLERY, not "community images") ----------------
  const galleryHeading = el(doc, "div", "wtn-dv-sechead");
  galleryHeading.textContent = "Gallery";
  root.appendChild(galleryHeading);

  const gallery = Array.isArray(d.gallery) ? d.gallery : [];
  const gState = galleryState(gallery, browsingLevel, view.nsfw_level);
  if (d.status === "loading" && gallery.length === 0) {
    const loadingEl = el(doc, "div", "wtn-dv-gallery-empty");
    loadingEl.textContent = "Loading gallery…";
    root.appendChild(loadingEl);
  } else if (gState === "locked") {
    const lockedEl = el(doc, "div", "wtn-dv-gallery-locked");
    lockedEl.textContent = "Gallery hidden — above your browsing level.";
    root.appendChild(lockedEl);
  } else {
    const visible = visibleGalleryEntries(gallery, browsingLevel);
    if (visible.length === 0) {
      const emptyEl = el(doc, "div", "wtn-dv-gallery-empty");
      emptyEl.textContent = "No gallery images for this version.";
      root.appendChild(emptyEl);
    } else {
      const grid = el(doc, "div", layout === "grid" ? "wtn-dv-gallery-grid" : "wtn-dv-gallery-vertical");
      const gate = createLoadGate(galleryConcurrency);
      for (const entry of visible) {
        grid.appendChild(buildGalleryEntryEl(doc, entry, { onCopyPrompt, isStale, backoffMs: thumbRetryBackoffMs, gate }));
      }
      root.appendChild(grid);
    }
  }

  // ---- back affordance ----------------------------------------------------
  if (typeof onBack === "function") {
    const backBtn = el(doc, "button", "wtn-dv-back");
    backBtn.type = "button";
    backBtn.textContent = "← back to results";
    backBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onBack();
    });
    root.appendChild(backBtn);
  }

  return {
    el: root,
    destroy() {
      stale = true;
    },
  };
}
