/**
 * civitai_search.mjs — the Civitai SEARCH + DOWNLOAD panel (`docs/lora-
 * loader-design.md` §7c/§7c-i/§7c-iii/§8/§9), M2's own addition to the
 * track-agnostic reuse boundary `civitai_api.mjs`'s own top doc comment
 * names (`model_picker.mjs`, `model_info.mjs`, and now this file are what
 * `AnimaLoaderPanel` imports unchanged at M3 -- see that file's doc comment
 * for the full layering contract, and `test_model_picker.mjs`'s guard, which
 * now scans THIS file too).
 *
 * Opened anchored to the header's 🔍 button (a node-embedded PICKER per
 * §7c: kind-locked, "download and pick a file to use" rather than the
 * unscoped toolbar modal) via the same shared, nested-overlay-safe mechanism
 * every other popover in this pack uses (`../shared/overlay.mjs`) — the same
 * narrow-vertical-panel idiom as the model picker and the ⓘ panel (§7c-ii:
 * "The node's surfaces are narrow vertical panels").
 *
 * ## What THIS slice builds, and what it deliberately does not
 *
 * The search input (debounced) + the full filter set (§7c-i: type locked,
 * base model / sort / period / maximum browsing level all present, laid out
 * as a compact row of `<select>` pills rather than the modal's rail —
 * "layout differs, feature set does not"), the `public_only`/`rate_limited`/
 * `offline` search states, the four RESULT-CARD states (§7c-iii: installed /
 * downloading / available / gated, with the exact labels that section
 * settles), the editable destination folder (§ decision 5, defaulting to
 * this kind's own `models/<kind>` root), and the download/poll/cancel flow
 * (§9: one job at a time, server-side, never blocking a graph run). Docs task
 * 2026-07-31 added two more: a live 40px THUMBNAIL per result and a
 * per-result VERSION PICKER (`resolveVersionView` + the `<select>` in
 * `buildCard`'s own right-hand ACTION COLUMN, stacked directly above that
 * card's action element — moved there 2026-07-31, owner: "the version should
 * be above the download button" — only rendered for a multi-version result)
 * — every render/download-payload decision in `buildCard` reads the SELECTED
 * version's own flat view, never the raw multi-version result directly.
 *
 * **§7c-iv (owner, 2026-07-31) replaced the single `thumb_url` string with an
 * ordered `images: [{url, nsfw_level, type}, ...]` candidate list** (already
 * thumbnail-rewritten server-side) — picking a URL out of it is now a
 * FRONTEND decision, because it depends on the user's own "maximum browsing
 * level" setting, which the server can't apply for anything above PG (see
 * `levelLabelToInt`/`pickThumbCandidates`/`thumbState`'s own doc comments,
 * and the CSS/`buildThumb` section below for the resulting FIVE thumbnail
 * states). The old per-result `thumb_url` key is gone from the wire shape
 * entirely — `resolveVersionView` now flattens `images`, not `thumb_url`.
 *
 * §7c-ii's per-result VERTICAL info panel (`openModelDetailPanel`, below --
 * version selector, both descriptions, the author's gallery with
 * prompt-on-hover + copy) now opens on a card click that lands OUTSIDE any
 * of the card's own interactive controls (the version `<select>`, the
 * action button, the delete confirm) -- each of those already
 * `stopPropagation`s its own click/change, same convention as every other
 * nested control in this file.
 *
 * ## Filters are remembered USER-WIDE, never in the node's state blob
 *
 * `../shared/settings.mjs`'s `CIVITAI_SEARCH_BASE_MODEL`/`_SORT`/`_PERIOD`/
 * `_LEVEL` ids (§7c-i: "remembered user-wide... not in the node's state
 * blob") — read on open, written back the moment the user changes one, so
 * every mount of this panel (this node, a future Loader Panel, the M2b
 * toolbar modal) opens with the SAME filters. `_LEVEL` (§7c-iv) supersedes
 * the old `_NSFW` checkbox id -- see that id's own comment in `settings.mjs`
 * for why the old one is kept registered, unused, rather than deleted. This
 * module reads/writes those settings itself (unlike `model_picker.mjs`/
 * `model_info.mjs`'s `hideExtension`/`civitaiEnabled` convention of taking
 * such things as a caller-supplied parameter) — there is no per-node
 * override for a browsing preference like this at all, so there is nothing
 * for a caller to inject; `js/shared/settings.mjs` is itself track-agnostic
 * (imports nothing of ours), so reaching into it directly here does not
 * violate the layering guard, which only ever forbids a `lora_*` import.
 *
 * ## The download job is a MODULE-LEVEL singleton, not panel-local state
 *
 * The backend serialises downloads process-wide (`_DOWNLOAD_MANAGER`, one
 * instance for the whole ComfyUI process, §9's own "one download at a
 * time") — a SECOND download can't run even from a different panel/tab, so
 * this file mirrors that with its own single `_activeDownload` + polling
 * loop kept OUTSIDE `openCivitaiSearch`'s own closure. Two things this buys:
 *
 *   1. Closing the panel mid-download does not orphan the poll — the loop
 *      keeps running (so `invalidateList` still fires the moment the
 *      transfer finishes, even with no panel open to watch it), and a LATER
 *      `openCivitaiSearch` call (this node, or a sibling one) subscribes to
 *      whatever is already in flight via `subscribeDownloadState` rather
 *      than losing track of it.
 *   2. A second "Download" click anywhere is answered LOCALLY (no network
 *      round trip) the instant a job is already known to be running,
 *      alongside the server's own `busy` reason for the case this client
 *      genuinely doesn't know about one yet (a job started from a different
 *      browser tab) — the task brief's "surface `busy` rather than queueing
 *      your own" is honoured either way: never silently queued, always
 *      reported.
 *
 * ## Untrusted text (task brief) — textContent, never innerHTML
 *
 * Every Civitai-supplied string rendered here (model name, creator) goes
 * through `textContent` — never string-concatenated into `innerHTML`; this
 * file's only `innerHTML` writes are `= ""` clears, matching `model_info.
 * mjs`'s own convention (see that file's top doc comment).
 */

import {
  openOverlayWithZoom,
  closeOverlayIfOwnedBy,
  closeOverlaysNotAncestorOf,
  activeOverlayRef,
  computeAnchoredMaxHeight,
  POPOVER_ANCHOR_GAP_PX,
  POPOVER_VIEWPORT_MARGIN_PX,
} from "../shared/overlay.mjs";
import {
  searchModels, startDownload, downloadProgress, cancelDownload, invalidateList, deleteModel, fetchModelDetail,
} from "./civitai_api.mjs";
// §7c-ii's own VERTICAL info panel ("The detail view", built once, mounted
// twice) -- a sibling of the ⓘ panel, opened by a result card click. See
// `openModelDetailPanel`, below, and `model_detail_view.mjs`'s own top doc
// comment for the full "one component, two mounts" contract; the modal's
// own master/detail swap (`civitai_modal.mjs`) is the OTHER mount.
import { buildModelDetailView } from "./model_detail_view.mjs";
// "Remove an installed model" (`docs/TODO.md`) -- the type-to-confirm
// dialog is shared with `model_info.mjs`'s ⓘ panel rather than grown twice;
// see that module's own top doc comment for the full contract.
import { openDeleteConfirm, removedSummary } from "../shared/delete_confirm.mjs";
import {
  getSetting,
  setSetting,
  SETTING_IDS,
  SETTING_DEFAULTS,
  CIVITAI_SEARCH_BASE_MODEL_OPTIONS,
  CIVITAI_SEARCH_SORT_OPTIONS,
  CIVITAI_SEARCH_PERIOD_OPTIONS,
  CIVITAI_SEARCH_LEVEL_OPTIONS,
} from "../shared/settings.mjs";
// §7c-iv's thumbnail-candidate mechanism now lives in `../shared/civitai_thumb
// .mjs` (moved, not duplicated, so the ⓘ info panel -- `model_info.mjs` --
// can share it rather than carry a second copy; see that file's own top doc
// comment for the full "why"). Re-exported below under their original names
// so every existing import of THIS file (`test_civitai_search.mjs` included)
// keeps working unchanged; `attachThumbCandidate` is imported directly for
// `buildThumb`'s own use, below.
import {
  levelLabelToInt,
  pickThumbCandidates,
  thumbState,
  advanceThumbAttempt,
  THUMB_RETRY_BACKOFF_MS,
  attachThumbCandidate,
  THUMB_SKELETON_CLASS,
  THUMB_SKELETON_CSS,
} from "../shared/civitai_thumb.mjs";
// C/E (task brief, 2026-07-31): route this surface's own diagnostic output
// (search issued/its result count, download start/finish) through the
// pack-wide "Console logging" level -- see that module's own top doc
// comment. "LoRA search" is this surface's own tag (task brief: "make each
// line identify which surface it came from") -- distinct from the toolbar
// browser's own "Civitai browser" tag, even though both eventually call the
// SAME `civitai_api.mjs` network functions.
import { logSummary, logDebug } from "../shared/console_log.mjs";

export { levelLabelToInt, pickThumbCandidates, thumbState, advanceThumbAttempt, THUMB_RETRY_BACKOFF_MS };

const STYLE_ID = "wtn-cs-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly -- same "every render module
// keeps its own hardcoded fallback copy" convention as every sibling in this
// reuse boundary (`model_picker.mjs`/`model_info.mjs`'s own top doc
// comments).
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
  ok: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  info: "#7dd3fc",
};

const SEARCH_ICON_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M11 4a7 7 0 104.418 12.44l4.571 4.571 1.415-1.415-4.572-4.572A7 7 0 0011 4zm-5 7a5 5 0 1110 0 5 5 0 01-10 0z'/%3E%3C/svg%3E";
const IMAGE_PLACEHOLDER_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2H4zm0 2h16v9.59l-3.79-3.8a1 1 0 00-1.42 0L11 15.59l-2.29-2.3a1 1 0 00-1.42 0L4 16.59V6zm4 2a2 2 0 100 4 2 2 0 000-4z'/%3E%3C/svg%3E";

const CSS = `
.wtn-cs-panel {
  width: 346px; max-height: 76vh; /* JS-computed inline max-height overrides this the instant the
  panel is attached (see \`applyMaxHeight\` below) -- 76vh only ever paints for the one frame before
  that runs, and is the fallback if no real viewport is available at all (headless/no window). */
  display: flex; flex-direction: column; overflow: hidden;
  box-sizing: border-box; border-radius: 10px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  box-shadow: var(--wtn-shadow, 0 20px 46px rgba(0,0,0,.66));
  font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-cs-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; flex: none;
  border-bottom: 1px solid var(--wtn-line, ${TOKENS.line}); font-size: 12.5px; font-weight: 600;
}
.wtn-cs-close { margin-left: auto; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 13px; }
.wtn-cs-close:hover { color: var(--wtn-ink, ${TOKENS.ink}); }
/* \`.wtn-cs-body\` is itself a flex column so only \`.wtn-cs-scroll\` (the
   results list) scrolls -- the search field, filter pills, hint and any
   status banner live in \`.wtn-cs-pinned\` (flex: none, always visible), and
   the destination/footer hints stay pinned too. \`min-height: 0\` on both the
   body and the scroll area is what lets a flex child shrink below its
   content's natural size instead of just overflowing its ancestor -- without
   it, \`.wtn-cs-scroll\`'s own \`overflow-y: auto\` would never actually engage. */
.wtn-cs-body { padding: 9px 10px 10px; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.wtn-cs-pinned { flex: none; }
.wtn-cs-scroll { flex: 1 1 auto; min-height: 120px; /* keep in sync with MIN_RESULTS_HEIGHT_PX below */ overflow-y: auto; margin: 0 -2px; padding: 0 2px; }

/* An explicit \`Search\` button beside the field (§7c-i, "not a debounce") --
   \`.wtn-cs-searchrow\` holds both, so the row grows/shrinks together; the
   field itself keeps its own \`margin-bottom\` moved onto the row. */
.wtn-cs-searchrow { display: flex; align-items: stretch; gap: 6px; margin-bottom: 7px; }
.wtn-cs-search-wrap { position: relative; flex: 1 1 auto; min-width: 0; }
.wtn-cs-search-icon {
  position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
  width: 12px; height: 12px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-image: url("${SEARCH_ICON_SVG}"); -webkit-mask-image: url("${SEARCH_ICON_SVG}");
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
}
.wtn-cs-search {
  width: 100%; box-sizing: border-box; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-accent-deep, ${TOKENS.accentDeep}); color: var(--wtn-ink, ${TOKENS.ink});
  padding: 6px 8px 6px 24px; border-radius: 6px; font-size: 12px;
}
.wtn-cs-search-btn {
  flex: none; font-family: var(--wtn-font-mono, monospace); font-size: 11px; padding: 0 10px; border-radius: 6px;
  cursor: pointer; background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent});
  border: 1px solid var(--wtn-accent, ${TOKENS.accent});
}
.wtn-cs-search-btn:hover:not(:disabled) { background: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-cs-search-btn:disabled { opacity: .45; cursor: default; }

.wtn-cs-filters { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.wtn-cs-pill {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px; padding: 2px 7px; border-radius: 9px;
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  background: var(--wtn-console, ${TOKENS.console});
}
.wtn-cs-pill-locked { border-style: dashed; }
.wtn-cs-sel {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px; padding: 2px 6px; border-radius: 9px;
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  background: var(--wtn-console, ${TOKENS.console}); cursor: pointer;
}
.wtn-cs-sel:hover { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); color: var(--wtn-ink, ${TOKENS.ink}); }

.wtn-cs-hint { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 10.5px; line-height: 1.35; margin: -1px 0 7px; flex: none; }
.wtn-cs-warn { color: var(--wtn-warn, ${TOKENS.warn}); font-size: 10.5px; line-height: 1.35; margin: -1px 0 7px; }
.wtn-cs-info { color: var(--wtn-info, ${TOKENS.info}); font-size: 10.5px; line-height: 1.35; margin: -1px 0 7px; }
.wtn-cs-bad { color: var(--wtn-bad, ${TOKENS.bad}); font-size: 10.5px; line-height: 1.35; margin: -1px 0 7px; }

.wtn-cs-dest { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.wtn-cs-dest label { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); font-size: 11px; flex: none; }
.wtn-cs-dest input {
  flex: 1 1 auto; width: auto; min-width: 0; box-sizing: border-box; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink, ${TOKENS.ink});
  font: 11px var(--wtn-font-mono, monospace); padding: 4px 6px; border-radius: 5px;
}

.wtn-cs-active {
  display: flex; align-items: center; gap: 8px; font-size: 11px; padding: 6px 8px; border-radius: 6px;
  border: 1px solid var(--wtn-accent-deep, ${TOKENS.accentDeep}); background: var(--wtn-console, ${TOKENS.console});
  margin-bottom: 7px;
}
.wtn-cs-active .wtn-cs-bar { flex: 1 1 auto; }

.wtn-cs-list { display: flex; flex-direction: column; gap: 6px; min-height: 30px; }
.wtn-cs-empty { padding: 14px 6px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); font-size: 12px; text-align: center; }
/* BUG G's own "loading more" footer row -- reuses \`.wtn-cs-empty\`'s
   colour/centering but at the list's own smaller type scale (a full 12px
   "no results" size would read as its own oversized banner sitting under a
   list of 12px cards). */
.wtn-cs-loading-more { padding: 8px 6px; font-size: 10.5px; }

.wtn-cs-card {
  display: flex; gap: 8px; align-items: center; padding: 6px; border-radius: 7px;
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); background: var(--wtn-surface-2, ${TOKENS.surface2});
}
.wtn-cs-thumb {
  flex: none; width: 40px; height: 40px; border-radius: 5px; overflow: hidden;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  display: flex; align-items: center; justify-content: center;
  /* \`position: relative\` is what lets the shared "loading" skeleton
     (\`../shared/civitai_thumb.mjs\`'s \`THUMB_SKELETON_CSS\`, spliced in
     below) overlay this box via \`position: absolute; inset: 0\` without
     taking a flex slot of its own -- see that constant's own doc comment. */
  position: relative;
}
.wtn-cs-thumb-ph {
  width: 16px; height: 16px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-image: url("${IMAGE_PLACEHOLDER_SVG}"); -webkit-mask-image: url("${IMAGE_PLACEHOLDER_SVG}");
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
}
.wtn-cs-thumb-gated { color: var(--wtn-warn, ${TOKENS.warn}); font-size: 15px; }
/* §7c-iv's fifth thumb state -- deliberately NOT \`.wtn-cs-thumb-gated\`'s own
   warn/amber colour, and a different glyph (\`buildThumb\`) -- "two padlocks
   in one UI is a real ambiguity" (that section's own words): this one means
   "nothing in this model's own gallery passes your browsing level", never
   "needs an API key". */
.wtn-cs-thumb-locked { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 15px; }
/* The live in-browser thumbnail (an \`images[]\` candidate, §7c-iv) fills the
   same 40px box the placeholder/padlock/lock already occupy -- \`object-fit:
   cover\` so a non-square gallery image never distorts. */
.wtn-cs-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
${THUMB_SKELETON_CSS}
.wtn-cs-meta { flex: 1 1 auto; min-width: 0; }
.wtn-cs-title { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* The base-model chip + download count share one row (owner, 2026-07-30) --
   the chip is js/shared/theme.css's own \`.wtn-chip.wtn-chip--accent\`
   (its doc comment there covers the colour choice); \`.wtn-cs-chip\` here
   only re-tunes SIZE for this card's already-compact type scale, never
   colour -- reuse, not a parallel style. */
.wtn-cs-metarow { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
.wtn-cs-chip { flex: none; font-size: 9.5px; padding: 1px 7px; }
.wtn-cs-metarow .wtn-cs-sub { flex: 1 1 auto; min-width: 0; margin-top: 0; }
/* The right-hand ACTION COLUMN (owner, 2026-07-31: "the version should be
   above the download button") -- holds the per-result version picker (when
   present) stacked directly above whichever action element the card's own
   state renders (Download / \`installed\` badge / \`key required\` badge / the
   %-plus-Cancel pair), both right-aligned. \`buildCard\` appends this ONE
   element to the card in place of appending the action directly, so the
   action and (when present) the version select stay vertically grouped in
   every one of the four card states -- see that function's own comment for
   why the downloading state's %/Cancel pair is wrapped in
   \`.wtn-cs-actioncol-row\` rather than appended as two loose siblings.
   \`flex: none\` + a \`max-width\` (this card's meta column, not the action
   column, is what should absorb any extra width) so neither a long model
   name nor a long version name ever widens the card -- \`align-items:
   flex-end\` is what right-aligns every child regardless of its own width. */
.wtn-cs-actioncol { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; max-width: 100px; }
/* The %/Cancel pair (downloading state) reads as one row stacked under the
   version select, not two independently-wrapping siblings. */
.wtn-cs-actioncol-row { display: flex; align-items: center; gap: 4px; }
/* The per-result version picker (docs task 2026-07-31; moved into
   \`.wtn-cs-actioncol\` above 2026-07-31) -- ONLY for a multi-version result.
   Re-tuned from the metarow's own 110px cap for its new, narrower home
   (\`.wtn-cs-actioncol\`'s own 100px). A bare \`max-width\` alone clips a
   \`<select>\`'s rendered value with no ellipsis (unlike a block element, a
   native select needs its own \`white-space\`/\`overflow\`/\`text-overflow\`
   to render one) -- \`box-sizing: border-box\` so the cap is the select's
   FULL width (border + padding included), matching how \`max-width\` already
   behaves on every other bordered element in this file. */
.wtn-cs-version-sel {
  flex: none; max-width: 100px; box-sizing: border-box;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wtn-cs-sub { font-family: var(--wtn-font-mono, monospace); font-size: 10px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wtn-cs-cardmsg { font-size: 10px; color: var(--wtn-bad, ${TOKENS.bad}); margin-top: 2px; }
.wtn-cs-bar { height: 4px; border-radius: 2px; background: var(--wtn-console, ${TOKENS.console}); overflow: hidden; margin-top: 4px; }
.wtn-cs-bar i { display: block; height: 100%; background: var(--wtn-accent, ${TOKENS.accent}); }

.wtn-cs-action {
  flex: none; font: 10.5px var(--wtn-font-mono, monospace); padding: 4px 9px; border-radius: 5px; cursor: pointer;
  background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent});
  border: 1px solid var(--wtn-accent, ${TOKENS.accent});
}
.wtn-cs-action:hover { background: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-cs-action:disabled { opacity: .5; cursor: default; }
.wtn-cs-action-installed { background: transparent; color: var(--wtn-ok, ${TOKENS.ok}); border-color: var(--wtn-line-soft, ${TOKENS.lineSoft}); cursor: default; }
/* BUG E (owner, 2026-07-30): an installed card has no action at all --
   nothing to click -- so it must never show a hover affordance. Without
   this override, \`.wtn-cs-action:hover\` above (a real class this badge ALSO
   carries, see \`buildCard\`'s \`"wtn-cs-action wtn-cs-action-installed"\`)
   still fires on hover and paints the "clickable" accent background even
   though the badge is inert. The gated button (below) is the SAME bug and
   gets the same fix; \`available\`/\`downloading\` are genuinely clickable
   (Download / Cancel), so \`.wtn-cs-action:hover\`/\`.wtn-cs-action-cancel:
   hover\` below are correct as-is and are NOT touched here. */
.wtn-cs-action-installed:hover { background: transparent; }
.wtn-cs-action-gated { background: transparent; color: var(--wtn-warn, ${TOKENS.warn}); border-color: rgba(251,191,36,.4); }
/* Owner, 2026-07-30 ("hover on key required also highlight it (should
   not)"): the gated button is \`disabled\` (\`buildCard\`) -- same non-
   clickable badge as \`.wtn-cs-action-installed\` above, same fix. */
.wtn-cs-action-gated:hover { background: transparent; }
.wtn-cs-action-cancel { background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); border: 1px dashed var(--wtn-line, ${TOKENS.line}); }
.wtn-cs-action-cancel:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
/* An installed card's own delete affordance (docs/TODO.md, "Remove an
   installed model" -- buttons in the ⓘ panel AND the search menu). Sits
   BESIDE the ✓ installed badge, never replacing it -- the badge still says
   what the card's action column already told the user; this is a second,
   independent action, styled like the cancel button (transparent, dashed)
   but in the bad/red hue so it reads as destructive without shouting. */
.wtn-cs-action-delete { background: transparent; color: var(--wtn-bad, ${TOKENS.bad}); border: 1px dashed rgba(248,113,113,.4); }
.wtn-cs-action-delete:hover { border-color: var(--wtn-bad, ${TOKENS.bad}); }
`;

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

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
// Pure helpers -- no DOM, no `doc`/`window` reference anywhere below, so
// these are importable and directly testable under plain `node`
// (test_civitai_search.mjs), matching every sibling in this reuse boundary.
// ---------------------------------------------------------------------------

/** `kind` -> the default DISPLAYED destination folder (§ decision 5's
 * "editable folder field defaulting to `models/loras`") -- kind-
 * parameterised from day one (§7a), only `loras` reachable from a live route
 * today. Falls back to the bare literal `"models"` for an unknown/future
 * kind rather than guessing a folder name that might not exist. */
export const DEFAULT_ROOT_DISPLAY = { loras: "models/loras", checkpoints: "models/checkpoints", unet: "models/unet" };

/** `kind` -> the label shown on the LOCKED `type:` pill (§7c-i: "only `type`
 * is locked, shown but not changeable"). */
export const TYPE_LABEL_FOR_KIND = { loras: "LoRA", checkpoints: "Checkpoint", unet: "UNet" };

/** A compact "12.4k"-style count -- `""`/`"0"` never invented for garbage
 * input (negative/non-finite/non-numeric degrades to `"0"`, matching
 * `model_picker.mjs`'s own "never throw, never show NaN" contract for
 * `formatFileSize`). */
export function formatCompactCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return "0";
  }
  if (n < 1000) {
    return String(Math.round(n));
  }
  const units = [
    { v: 1_000_000_000, s: "B" },
    { v: 1_000_000, s: "M" },
    { v: 1_000, s: "k" },
  ];
  for (const u of units) {
    if (n >= u.v) {
      const value2 = n / u.v;
      // One decimal place up to 99.9 (matching the mockup's own "12.4k" --
      // §7c-iii), a bare integer above that so a huge count never renders a
      // clutter decimal like "1234.5k".
      const rounded = value2 >= 100 ? Math.round(value2) : Math.round(value2 * 10) / 10;
      return `${rounded}${u.s}`;
    }
  }
  return String(Math.round(n));
}

/** Download progress as a whole-number 0-100 percentage, or `null` when
 * `total` isn't a usable positive number (an unknown content-length --
 * render an indeterminate state, never a fabricated percentage). Never
 * throws on garbage input. */
export function downloadPercent(bytes, total) {
  const b = Number(bytes);
  const t = Number(total);
  if (!Number.isFinite(b) || b < 0 || !Number.isFinite(t) || t <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round((b / t) * 100)));
}

/** The stable identity a download job is tracked by -- a search result's own
 * `(model_id, primary_version_id)` pair, since a download always targets ONE
 * specific version's primary file (§2b: "the by-hash lookup is per version",
 * same reasoning extended to search results here). `""` for a garbage
 * result rather than throwing. */
export function resultKey(result) {
  if (!result || typeof result !== "object") {
    return "";
  }
  return `${result.model_id}:${result.primary_version_id}`;
}

/**
 * The per-result VERSION PICKER's own pure core (docs task 2026-07-31,
 * "Civitai search panel version picker"). Every render helper in this file
 * (`resultKey`/`resultCardState`/`resultBaseModel`/`resultSubtitle`, the
 * thumbnail, and the `/download/start` payload) reads this flat VIEW rather
 * than the raw multi-version `result` directly -- so switching versions on
 * a card is one uniform re-render, not a parallel "which version am I
 * showing" check duplicated in each of those functions.
 *
 * The returned view carries the SELECTED version's own `file_name`/
 * `download_url`/`size_kb`/`gated`/`installed`/`base_model`/`images`/
 * `triggers`/`preview_url` (`api.py`'s `_annotate_search_results` computes
 * every one of these per version, not just the primary), plus
 * `primary_version_id` set to THAT version's own id -- not necessarily
 * `result`'s own primary version. That last point is what makes
 * `resultKey` (which reads exactly this field) follow the user's version
 * choice for free: download-progress tracking and the session-gated set
 * (`markResultGated`) key off whichever version is actually selected, with
 * no separate plumbing for it.
 *
 * `selectedVersionId` not found among `result.versions` -- including the
 * common "nothing picked yet" case, `undefined` -- falls back to
 * `versions[0]`, matching a card's existing default-to-primary behaviour. A
 * version whose own `file_name`/`download_url` are `null` (its
 * `pick_primary_file` was `None` server-side -- no downloadable file at
 * all) is returned AS-IS with those fields `null`; a caller (`buildCard`)
 * is what turns that into a disabled download button with a reason, never
 * this function's job.
 *
 * `result.versions` missing, non-array, or empty (including every result
 * shape from BEFORE this feature, and this file's own single-version test
 * fixtures) returns `result` UNCHANGED -- there is no version to select
 * between, so nothing here should differ from today's behaviour.
 */
export function resolveVersionView(result, selectedVersionId) {
  if (!result || typeof result !== "object") {
    return result;
  }
  const versions = Array.isArray(result.versions) ? result.versions : null;
  if (!versions || versions.length === 0) {
    return result;
  }
  const version = versions.find((v) => v && v.version_id === selectedVersionId) || versions[0];
  return {
    ...result,
    file_name: version.file_name != null ? version.file_name : null,
    download_url: version.download_url != null ? version.download_url : null,
    size_kb: version.size_kb != null ? version.size_kb : null,
    gated: !!version.gated,
    installed: !!version.installed,
    base_model: version.base_model || "",
    // §7c-iv: the ordered candidate list (`{url, nsfw_level, type}`,
    // already thumbnail-rewritten server-side) replaces the old single
    // `thumb_url` string -- `pickThumbCandidates`/`thumbState` are what turn
    // this into an actual URL (or "nothing at this level"), below.
    images: Array.isArray(version.images) ? version.images : [],
    triggers: Array.isArray(version.triggers) ? version.triggers : [],
    preview_url: version.preview_url || null,
    primary_version_id: version.version_id,
  };
}

/**
 * BUG G -- appends `incoming` after `existing`, skipping any entry whose
 * `resultKey` is already present in `existing`: Civitai's own pagination can
 * legitimately repeat an entry across pages (the task brief's own "dedupe on
 * a stable key"), so identity is checked by `resultKey`, never by object
 * identity or array index. Neither argument is mutated -- returns a NEW
 * array, matching every other pure helper in this file. Garbage/non-array
 * input on either side degrades to treating that side as empty rather than
 * throwing (mirrors `resultKey`'s own "never throw" contract); a garbage
 * ENTRY within a valid array (one `resultKey` resolves to `""` for) is kept
 * rather than silently dropped -- `""` never collides with a real key, so
 * every such entry is still added, just never deduplicated against another
 * garbage entry.
 */
export function appendDedupedResults(existing, incoming) {
  const before = Array.isArray(existing) ? existing : [];
  const add = Array.isArray(incoming) ? incoming : [];
  const seen = new Set();
  for (const r of before) {
    const key = resultKey(r);
    if (key) {
      seen.add(key);
    }
  }
  const out = before.slice();
  for (const r of add) {
    const key = resultKey(r);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

/**
 * The four card states (§7c-iii), in priority order: an in-flight download
 * FOR THIS RESULT wins over everything else (its `installed`/`gated` flags
 * are now stale -- a download would not have started if it were already
 * installed), then `installed` (the most final truth there is -- the file is
 * literally on disk), then `gated` -- from EITHER the search response's own
 * up-front flag OR `sessionGatedKeys` (BUG F, owner 2026-07-30): the
 * up-front flag is only Civitai's `earlyAccessEndsAt` guess
 * (`civitai_search.py`'s own doc comment), and a live download that actually
 * came back `key_required` is GROUND TRUTH the guess got wrong for THIS
 * result -- `openCivitaiSearch`'s `onDownloadStateChange` records that key
 * into the module-level `_sessionGatedKeys` set once, and every card for
 * that same `(model_id, primary_version_id)` renders gated from then on,
 * this session, even across a brand-new search whose response repeats the
 * same wrong `gated: false` -- else `"available"`.
 *
 * `sessionGatedKeys` is optional (any `{has(key)}`-shaped collection, e.g. a
 * `Set`) so every existing caller/test that only ever cared about the
 * response's own flags keeps working unmodified.
 */
export function resultCardState(result, activeJob, sessionGatedKeys) {
  if (!result) {
    return "available";
  }
  const key = resultKey(result);
  if (activeJob && activeJob.key === key) {
    return "downloading";
  }
  if (result.installed) {
    return "installed";
  }
  if (result.gated || (sessionGatedKeys && typeof sessionGatedKeys.has === "function" && sessionGatedKeys.has(key))) {
    return "gated";
  }
  return "available";
}

/** The base model, on its OWN (owner, 2026-07-30 review of the search
 * panel): it used to be folded into `resultSubtitle`'s joined text
 * (`"SDXL 1.0 · 12.4k ↓"`), buried next to the download count where the
 * owner's own words were "i didn't see it" scanning a list. Rendered as a
 * standalone chip in `buildCard` instead -- this function only ever answers
 * WHAT to put in it. `""` (never rendered) when genuinely unknown -- "omit
 * rather than invent" (§1a-vi), unlike `model_picker.mjs`'s local-file
 * `metaLineFor`, a Civitai result with no `base_model` genuinely has none to
 * report (Civitai itself, not a missing local read). */
export function resultBaseModel(result) {
  if (!result) {
    return "";
  }
  return (result.base_model && String(result.base_model).trim()) || "";
}

/** The card's second line -- now JUST the download count (`"12.4k ↓"`);
 * the base model that used to share this line moved to its own chip
 * (`resultBaseModel`, above). */
export function resultSubtitle(result) {
  if (!result) {
    return "";
  }
  const downloads = result.stats && Number.isFinite(result.stats.downloads) ? result.stats.downloads : 0;
  return `${formatCompactCount(downloads)} ↓`;
}

/** The GATED card's second line (§7c-iii: "padlock + `needs an API key`") --
 * always the bare `"needs an API key"` now (owner, 2026-07-30): the base
 * model that used to prefix this line moved to the SAME standalone chip
 * every other card state uses (`resultBaseModel` + `buildCard`'s own chip),
 * so a gated card and an available/installed one stay visually consistent
 * -- one card style carrying the base model as inline text while another
 * carried it as a chip would read as two different components, not one. */
export function gatedSubtitle() {
  return "needs an API key";
}

// ---------------------------------------------------------------------------
// §7c-iv -- the "maximum browsing level" select, thumbnail candidate
// selection, and the retry-then-advance state machine now live in
// `../shared/civitai_thumb.mjs` (moved 2026-07-31 so `model_info.mjs`'s ⓘ
// panel can share them -- see that module's own top doc comment). Re-exported
// above under their original names.
// ---------------------------------------------------------------------------

/**
 * The destination FIELD's text -> the `subfolder` value actually sent to
 * `/wtn/model_browser/download/start` (relative to the kind's own root,
 * `download.resolve_destination_path`'s own convention). The field's
 * DISPLAYED default is the full-looking `"models/loras"` (decision 5), so a
 * user who never touches it must resolve to `""` (root) rather than a
 * double-nested `models/loras/models/loras`; a value that still starts with
 * that same root prefix has it stripped so appending `/characters` resolves
 * to just `"characters"`; anything else (the common case of a user typing a
 * bare subfolder name like `"characters"`) is used AS-IS. The backend
 * re-validates this regardless (`download.validate_subfolder`) -- this is a
 * convenience guess, never the guard (task brief).
 */
/**
 * Whether the explicit `Search` button (§7c-i, "An explicit Search button,
 * not a debounce") should be ENABLED -- true only when the current query
 * text differs from the text of the last EXECUTED search. Typing alone must
 * never fire a search; this is the one thing that tells the user "there is
 * something new to fetch," and is also why it's disabled the instant a
 * search actually runs (the caller updates `lastSearchedText` at that same
 * moment). Both arguments are trimmed before comparing -- leading/trailing
 * whitespace alone is not a meaningfully different query -- and a
 * non-string argument degrades to `""` rather than throwing. Shared by both
 * search surfaces (this file's own panel, and `civitai_modal.mjs`'s) -- "one
 * implementation," per that section's own closing line.
 */
export function searchButtonEnabled(queryText, lastSearchedText) {
  const q = typeof queryText === "string" ? queryText.trim() : "";
  const last = typeof lastSearchedText === "string" ? lastSearchedText.trim() : "";
  return q !== last;
}

/**
 * A search query derived from an installed file's own NAME -- §7e's
 * `notfound` action, "Search Civitai by name" (by-hash failing is the
 * *common* case: re-saving/merging/quantising a LoRA changes its hash, so a
 * published LoRA won't match once the file has been altered). Strips any
 * subfolder prefix and the extension, then ONE common trailing version/step
 * marker if present (`-v2`, `_step00001200`, `-e15`, `_epoch3`) -- cheap, not
 * clever (task brief: "a slightly imperfect query the user can edit beats a
 * magic transform that quietly searches for the wrong thing"). Whatever
 * remains has `_`/`-` collapsed to spaces, matching `model_info.mjs`'s own
 * `prettyTitle`. `""` for a garbage/empty `name`, never throws.
 */
export function queryFromModelName(name) {
  if (typeof name !== "string" || !name) {
    return "";
  }
  let base = name.split("/").pop().replace(/\.[^./]+$/, "");
  base = base.replace(/[-_](v\d+(?:\.\d+)?|step\d+|e\d+|epoch\d+)$/i, "");
  return base.replace(/[_-]+/g, " ").trim();
}

export function subfolderFromDestinationField(value, kind) {
  const root = DEFAULT_ROOT_DISPLAY[kind] || "";
  if (typeof value !== "string") {
    return "";
  }
  let raw = value.trim().replace(/\\/g, "/");
  raw = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!raw || raw === root) {
    return "";
  }
  if (root && raw.startsWith(`${root}/`)) {
    return raw.slice(root.length + 1);
  }
  return raw;
}

/** A calm, never-alarming line for a search RESPONSE that isn't `"ok"` --
 * `""` for `"ok"` (nothing to say) or anything unrecognised. `rate_limited`
 * is deliberately worded as "slow down," never as an error (task brief: "the
 * backend also rate-limits; ... must render as a calm 'slow down' state,
 * never an error") -- it is OUR OWN §9 rate limiter refusing the call, not
 * Civitai's, so retrying shortly is the whole story. */
export function searchReasonMessage(response) {
  if (!response) {
    return "";
  }
  if (response.reason === "rate_limited") {
    return "Searching too quickly — wait a moment and try again.";
  }
  if (response.reason === "invalid_kind") {
    return "This node can't search that kind of model.";
  }
  if (response.reason === "offline") {
    const map = {
      timeout: "Civitai timed out.",
      dns_tls: "Couldn't reach Civitai (DNS).",
      unreadable: "Civitai sent an unreadable reply.",
      rate_limited: "Civitai returned 429 — an API key relieves rate limits.",
    };
    return map[response.offline_reason] || response.message || "Couldn't reach Civitai.";
  }
  return "";
}

/** A readable line for a `download/start` response whose `reason` isn't
 * `"started"` -- covers every documented reason (task brief: "especially
 * `too_large`, `invalid_destination`, `already_installed`, and the
 * download's distinct `key_required`" -- NOTE `key_required` is a download-
 * START reason too, not only a terminal progress `status`: a gated file's
 * card is disabled client-side by §7c-iii's own first-class `gated` flag, but
 * this message still exists for the defense-in-depth case of a START request
 * that reaches the server anyway). */
export function downloadStartMessage(response) {
  if (!response) {
    return "Couldn't start the download.";
  }
  const map = {
    already_installed: "This file is already on disk.",
    invalid_destination: "That destination folder isn't allowed.",
    invalid_url: "Refusing an untrusted download URL.",
    busy: "Another download is already running — wait for it to finish.",
    invalid_kind: "This node can't download that kind of model.",
    key_required: "Civitai requires an API key for this file — add one in Settings → AnimaFlow → Controls.",
  };
  return map[response.reason] || response.message || "";
}

/** A readable line for a download job's TERMINAL `status` (everything
 * `downloadProgress` can resolve to other than the in-flight `"downloading"`/
 * `"cancelling"`). */
export function downloadTerminalMessage(status, response) {
  const map = {
    ok: "Downloaded.",
    cancelled: "Cancelled.",
    too_large: "This file exceeded the size cap partway through — cancelled.",
    key_required: "Civitai requires an API key for this file (early access or a restricted download).",
  };
  return map[status] || (response && response.message) || "";
}

// ---------------------------------------------------------------------------
// Panel height -- computed from the space actually available BELOW the
// anchor (owner: "we should set max height and inner scroll ... based also
// on the available space so it won't overflow down the viewport"), never a
// fixed vh/px constant. Only the RESULTS area scrolls; the search field,
// filter pills and any status banner stay pinned above it -- see this file's
// `openCivitaiSearch` DOM section for the `.wtn-cs-pinned`/`.wtn-cs-scroll`
// split this feeds.
// ---------------------------------------------------------------------------

/** The results area's own floor (task brief: "a panel anchored right at the
 * bottom edge still shows something usable rather than collapsing to a
 * sliver") -- a couple of result cards' worth (`.wtn-cs-card` is ~52px tall
 * incl. gap), never zero. */
export const MIN_RESULTS_HEIGHT_PX = 120;

/** Matches `overlay.mjs`'s own "below" placement gap (`rect.bottom + 6`) --
 * kept in agreement rather than guessing independently. Re-exports
 * `overlay.mjs`'s `POPOVER_ANCHOR_GAP_PX` under this file's original name so
 * any existing import of `PANEL_ANCHOR_GAP_PX` keeps working unchanged (see
 * `computeSearchPanelMaxHeight`'s own doc comment below for why the
 * computation itself moved there). */
export const PANEL_ANCHOR_GAP_PX = POPOVER_ANCHOR_GAP_PX;

/** Breathing room so a maxed-out panel never touches the viewport's own
 * bottom edge. Re-exported from `overlay.mjs` -- see `PANEL_ANCHOR_GAP_PX`
 * above. */
export const PANEL_VIEWPORT_MARGIN_PX = POPOVER_VIEWPORT_MARGIN_PX;

/** BUG G's own infinite-scroll trigger distance -- the next page fetches
 * once fewer than this many pixels remain below the visible viewport of
 * `.wtn-cs-scroll` (`scrollHeight - scrollTop - clientHeight`), so the next
 * page is already loading by the time the user actually reaches the bottom
 * rather than after a visible dead stop. */
export const SCROLL_LOAD_MORE_THRESHOLD_PX = 96;

/**
 * The panel's own `max-height`, derived from the space actually available
 * below the anchor -- `viewportHeight - anchorBottom - gap - margin` -- never
 * smaller than `chromeHeight + MIN_RESULTS_HEIGHT_PX` (the head + pinned
 * controls + footer's own real height, plus the results floor above), so the
 * results area always reserves at least its minimum even when that means the
 * panel's OWN height exceeds the space actually below the anchor -- at that
 * point `overlay.mjs`'s own viewport-flip (it measures the REAL rendered
 * height, which is this number) is what decides whether the panel opens
 * above the anchor instead. This function only ever answers "how much room
 * is there below" -- reusing, never duplicating, the flip decision itself.
 *
 * `null` when no real viewport size is available (mirrors `overlay.mjs`'s
 * own "`null` means never adjust" convention for a headless host with no
 * live `window`) -- the caller keeps its CSS fallback `max-height` untouched.
 *
 * The actual computation now lives in `overlay.mjs`'s
 * `computeAnchoredMaxHeight` (owner-reported overflow bug, 2026-07-30 --
 * `model_picker.mjs` needed the exact same fix, and is deliberately
 * track-agnostic, so the pure math moved to the one module both already
 * import) -- this function is kept, unchanged in name and behaviour, as a
 * thin delegation so every existing import of `computeSearchPanelMaxHeight`
 * (this file's own call site below, `test_civitai_search.mjs`) keeps working
 * with no changes required.
 */
export function computeSearchPanelMaxHeight({ anchorBottom, viewportHeight, chromeHeight }) {
  return computeAnchoredMaxHeight({ anchorBottom, viewportHeight, chromeHeight, minContentHeight: MIN_RESULTS_HEIGHT_PX });
}

// ---------------------------------------------------------------------------
// The download job -- a MODULE-LEVEL singleton (this file's own top doc
// comment). Every `openCivitaiSearch` call SUBSCRIBES to this rather than
// keeping its own copy, so a job survives the panel that started it closing.
// ---------------------------------------------------------------------------

let _activeDownload = null; // { kind, jobId, key, filename, status, bytes, total, message } | null
const _subscribers = new Set();

/** BUG F (owner, 2026-07-30) -- every `resultKey` this session has actually
 * seen a `key_required` download failure for, keyed the SAME way
 * `resultKey` already is. A live 401/403 is ground truth that the search
 * response's own up-front `gated` guess (Civitai's `earlyAccessEndsAt`, see
 * `civitai_search.py`'s doc comment) got wrong for that one result -- once
 * learned here, `resultCardState`'s `sessionGatedKeys` argument makes every
 * later render of that same key gated, even a brand-new search that repeats
 * the same wrong `gated: false`. Session-only (this module, cleared on a
 * page reload same as `_activeDownload`) -- there is no server-side place to
 * remember this yet, and re-learning it on the next click is an acceptable
 * cost for something this rare. */
let _sessionGatedKeys = new Set();

/** Records that `key` (a `resultKey(...)` value) is now known-gated this
 * session -- see `_sessionGatedKeys`'s own doc comment. A no-op for a falsy
 * key (the `resultKey(garbage) === ""` case) rather than polluting the set
 * with an empty string that could spuriously match another garbage result. */
export function markResultGated(key) {
  if (key) {
    _sessionGatedKeys.add(key);
  }
}

/**
 * The module-level session-gated-key `Set` itself (BUG F) — exported so a
 * DIFFERENT surface sharing this file's own download-job singleton (the M2b
 * toolbar modal, `civitai_modal.mjs`) can pass the SAME set into its own
 * `resultCardState` calls, rather than maintaining a second, out-of-sync
 * copy of "what did we learn is gated this session." Nothing in THIS file
 * changes because of this export — `markResultGated`/
 * `reconcileGatedKeysOnApiKeySignature` remain the only writers, and every
 * existing call site here keeps reading/writing the identical reference.
 * Read-only in effect for a caller (no method on the returned `Set` this
 * module doesn't already use itself).
 */
export function sessionGatedKeys() {
  return _sessionGatedKeys;
}

/**
 * BUG (owner, 2026-07-30): "i entered key but it still say key required
 * (and i cant redownload it)". `_sessionGatedKeys` above is correctly
 * LEARNED from a live `key_required` failure, but nothing ever
 * re-evaluated that learning -- the only thing that ever cleared the set
 * was `_resetDownloadStateForTests`, a test-only function. A user who did
 * exactly what the gated message told them to (added an API key) had no
 * way to make the panel notice: the premise the learning was correct UNDER
 * ("no key yet") had changed, but the set just kept saying gated, and the
 * gated button is `disabled` (`buildCard`), so there was no retry
 * affordance either.
 *
 * Fix: remember a cheap SIGNATURE of the API key setting (`apiKeySignature`,
 * below) each time this runs, and clear the whole learned-gated set the
 * moment the signature differs from the last one seen -- including the
 * reported empty -> non-empty transition, and a non-empty -> DIFFERENT
 * non-empty change (someone swapping keys). Once cleared, a
 * previously-learned-gated result falls straight back to whatever
 * `resultCardState` already says from its OTHER two inputs -- still
 * `gated` if the search response's own up-front flag says so (early access
 * is untouched by any of this), else `available`, which is exactly what
 * puts the "↓ Download" button back -- no separate "retry" affordance
 * needed on top of the existing available-state button.
 *
 * Re-checked from `runSearch`'s own top (this file's only call site that
 * covers BOTH "the panel opens" -- `openCivitaiSearch`'s own trailing
 * `runSearch({ resetCursor: true })` call -- and "a new search runs": the
 * debounced text search, every filter change, and paging all already funnel
 * through this one function, so a single call site does both jobs the task
 * asked for with nothing else to keep in sync).
 *
 * The empty -> empty case (key stays unset) and the non-empty -> SAME
 * non-empty case (key unchanged) are both "no change" by this same
 * comparison -- a session-learned gated key correctly stays gated while the
 * key setting itself hasn't moved.
 */
let _lastApiKeySignature = null; // string | null; `null` = "never checked yet" -- never itself treated as a change

/** A cheap, non-cryptographic hash -- ONLY ever used to detect that the key
 * changed, never to recover or compare against the key's actual value. */
function _cheapStringHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * A cheap signature for `rawKey` (its length + a cheap hash) -- exported so
 * the change-detection logic below is directly testable with a plain
 * string, matching this module's "pure helper takes plain arguments, no
 * DOM/window" convention. 🔒 Never returns, logs, or otherwise surfaces the
 * key itself (`src/model_browser/keys.py`'s own top doc comment: "never
 * logged... never surfaced") -- this is deliberately NOT reversible back to
 * the original string.
 */
export function apiKeySignature(rawKey) {
  const s = typeof rawKey === "string" ? rawKey : "";
  return `${s.length}:${_cheapStringHash(s)}`;
}

/**
 * Clears `sessionGatedKeys` iff `signature` differs from the last one this
 * function has seen (module-level `_lastApiKeySignature`) -- the pure
 * decision behind the fix above, factored out so it is directly testable
 * with a plain `Set` and a plain signature string rather than needing a
 * fake `window.app`. The FIRST call ever (`_lastApiKeySignature === null`)
 * only records the baseline and never clears -- there is nothing stale to
 * clear yet on a fresh module load.
 */
export function reconcileGatedKeysOnApiKeySignature(signature, sessionGatedKeys) {
  if (_lastApiKeySignature !== null && signature !== _lastApiKeySignature
    && sessionGatedKeys && typeof sessionGatedKeys.clear === "function") {
    sessionGatedKeys.clear();
  }
  _lastApiKeySignature = signature;
}

function _notify() {
  for (const fn of _subscribers) {
    fn();
  }
}

/** Subscribe to every change of the active download job (started, progress,
 * finished/cancelled/failed) -- returns an unsubscribe function. Call the
 * returned function when the panel closes; the download itself is NOT
 * cancelled by unsubscribing (this file's own top doc comment: it keeps
 * running server-side, and this module keeps polling it, regardless of
 * whether any panel is open to watch). */
export function subscribeDownloadState(fn) {
  if (typeof fn !== "function") {
    return () => {};
  }
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

/** A shallow copy of the currently-active job, or `null` -- read-only,
 * never triggers a fetch of its own (same "read the cache, never fetch"
 * discipline as `civitai_api.mjs`'s `cachedInfo`). */
export function getActiveDownloadState() {
  return _activeDownload ? { ..._activeDownload } : null;
}

/** Test-only: force-clears the module-level singletons (the active download
 * job, BUG F's `_sessionGatedKeys`, AND the API-key signature the "un-gate
 * on key change" fix above tracks -- all the same kind of session-lifetime
 * state, cleared together) so a suite can start every test from a clean
 * slate -- never called by any real (non-test) code path (mirrors
 * `js/shared/settings.mjs`'s own `_resetRegistrationForTests` convention). */
export function _resetDownloadStateForTests() {
  _activeDownload = null;
  _subscribers.clear();
  _sessionGatedKeys.clear();
  _lastApiKeySignature = null;
}

function _sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function _pollLoop(jobId, pollIntervalMs) {
  for (;;) {
    if (!_activeDownload || _activeDownload.jobId !== jobId) {
      return; // superseded/cleared while we were awaiting -- stop silently
    }
    const resp = await downloadProgress(jobId);
    if (!_activeDownload || _activeDownload.jobId !== jobId) {
      return;
    }
    if (resp.reason === "unknown_job") {
      _activeDownload = null;
      _notify();
      return;
    }
    _activeDownload = { ..._activeDownload, status: resp.status, bytes: resp.bytes, total: resp.total, message: resp.message };
    _notify();
    if (resp.status === "downloading" || resp.status === "cancelling") {
      await _sleep(pollIntervalMs);
      continue;
    }
    // Terminal. `"ok"` is the ONLY status that means the file is genuinely
    // on disk now (the atomic-rename guarantee, `download.py`'s own top doc
    // comment) -- invalidate the client list cache so the picker's
    // `installed`/missing-file marks refresh on its NEXT open, with no page
    // reload (task brief, deliverable 4).
    if (resp.status === "ok") {
      invalidateList(_activeDownload.kind);
    }
    _activeDownload = null;
    _notify();
    return;
  }
}

/**
 * Starts a download job, or returns immediately with a `busy`-shaped
 * response if one is ALREADY known to be running (this file's own top doc
 * comment, point 2 -- a local short-circuit, never a silent queue: the
 * caller gets the SAME `{reason: "busy", message}` shape either way, whether
 * this function or the server itself is the one that said so). On
 * `reason === "started"`, kicks off the background poll loop (fire-and-
 * forget) and notifies subscribers immediately so a caller's very next
 * render already shows the "downloading" state. `pollIntervalMs` is test-
 * only (default 800ms in real use) -- exists so a test can drive the poll
 * loop with a short, deterministic interval instead of waiting on a real
 * 800ms timer.
 *
 * `civitaiMeta`/`previewUrl` (task brief, "wire the download sidecar -- it
 * has never been connected") -- passed straight through to `startDownload`,
 * which is the one that actually puts them on the wire; see that function's
 * own doc comment.
 */
export async function startDownloadJob({ kind, subfolder = "", filename, downloadUrl, sizeKb, key, civitaiMeta, previewUrl }, pollIntervalMs = 800) {
  if (_activeDownload) {
    return { reason: "busy", message: "Another download is already running — wait for it to finish.", job_id: null };
  }
  const resp = await startDownload({ kind, subfolder, filename, downloadUrl, sizeKb, civitaiMeta, previewUrl });
  if (resp.reason === "started") {
    _activeDownload = { kind, jobId: resp.job_id, key, filename, status: "downloading", bytes: 0, total: null, message: "" };
    _notify();
    _pollLoop(resp.job_id, pollIntervalMs);
  }
  return resp;
}

/** Cancels the active job, if any -- a no-op (never throws, never fetches)
 * when nothing is running. The job doesn't disappear from `getActiveDownloadState`
 * immediately; the running poll loop is what observes the server-reported
 * `"cancelled"` status and clears it (§9: cancellation is cooperative). */
export async function cancelActiveDownloadJob() {
  if (!_activeDownload) {
    return;
  }
  await cancelDownload(_activeDownload.jobId);
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function buildFilterSelect(doc, options, current, onChange) {
  const sel = el(doc, "select", "wtn-cs-sel");
  for (const value of options) {
    const opt = el(doc, "option");
    opt.value = value;
    opt.textContent = value === "" ? "Any" : value === "AllTime" ? "All time" : value;
    if (value === current) {
      opt.selected = true;
    }
    sel.appendChild(opt);
  }
  sel.value = current;
  sel.addEventListener("click", (e) => e.stopPropagation());
  sel.addEventListener("change", (e) => {
    e.stopPropagation();
    onChange(sel.value);
  });
  return sel;
}

/**
 * The 40px thumbnail box -- FIVE states from `thumbState` (§7c-iv's "fifth
 * card state", that function's own doc comment has the full priority rule),
 * plus a transient SIXTH one this function itself manages:
 *
 *   - `"gated"`       -- §7c-iii's padlock, unchanged: no thumbnail at all.
 *   - `"locked"`      -- a DIFFERENT lock glyph + tooltip than `gated`'s own
 *                        (§7c-iv's own "two padlocks" warning) -- this model
 *                        HAS images, every one is above the chosen browsing
 *                        level.
 *   - `"placeholder"` -- the existing neutral grey box, for a model with NO
 *                        images at all.
 *   - `"image"`       -- while any candidate's own `<img>` is still in
 *                        flight, shows the shared `THUMB_SKELETON_CLASS`
 *                        shimmer (owner request, 2026-07-31) -- built once,
 *                        before `candidates[0]` is even tried, and removed
 *                        only once the WHOLE retry-then-advance chain
 *                        (`../shared/civitai_thumb.mjs`'s
 *                        `attachThumbCandidate`) reaches a terminal outcome:
 *                        `onLoaded` (a candidate genuinely rendered) or
 *                        `onExhausted` (every candidate, including its own
 *                        retry, failed) -- this card's own `onExhausted`
 *                        callback, below, is what makes THAT fallback the
 *                        plain `wtn-cs-thumb-ph` placeholder rather than
 *                        re-deriving `locked` (see that module's own
 *                        "PRE-CHECK, not a post-exhaustion guess" doc
 *                        comment).
 *
 * `isStale`/`backoffMs` are only meaningful for the `"image"` state -- see
 * `attachThumbCandidate`'s own doc comment.
 */
function buildThumb(doc, state, candidates, isStale, backoffMs) {
  const thumb = el(doc, "div", "wtn-cs-thumb");
  if (state === "gated") {
    const lock = el(doc, "span", "wtn-cs-thumb-gated");
    lock.textContent = "\u{1F512}"; // 🔒 -- Civitai's own gate glyph, matching the mockup's padlock
    lock.title = "Add a Civitai API key to download this file.";
    thumb.appendChild(lock);
    return thumb;
  }
  if (state === "locked") {
    // A DIFFERENT glyph than `gated`'s own 🔒 (§7c-iv: "two padlocks in one
    // UI is a real ambiguity") -- "preview hidden", not "needs an API key".
    const lock = el(doc, "span", "wtn-cs-thumb-locked");
    lock.textContent = "\u{1F648}"; // 🙈 -- "see no evil", distinct from the gated padlock
    lock.title = "Preview hidden — above your browsing level";
    thumb.appendChild(lock);
    return thumb;
  }
  if (state === "image" && Array.isArray(candidates) && candidates.length > 0) {
    // The shared "loading" skeleton (owner request, 2026-07-31) -- built
    // ONCE, before the first candidate is even tried, and removed only on
    // the chain's own terminal outcome (`onLoaded`/`onExhausted` below) --
    // never torn down between an individual retry/advance step, which is
    // what lets it survive the WHOLE chain rather than flashing on and off.
    const skeleton = el(doc, "span", THUMB_SKELETON_CLASS);
    thumb.appendChild(skeleton);
    const clearSkeleton = (t) => {
      if (skeleton.parentNode === t && typeof t.removeChild === "function") {
        t.removeChild(skeleton);
      }
    };
    attachThumbCandidate(doc, thumb, candidates, { index: 0, retried: false }, isStale, backoffMs, (d, t) => {
      clearSkeleton(t);
      t.appendChild(el(d, "span", "wtn-cs-thumb-ph"));
    }, (d, t) => {
      clearSkeleton(t);
    });
    return thumb;
  }
  // "placeholder", or a garbage/empty candidates list reaching here anyway
  // (defence in depth -- `buildCard` never calls this with "image" and an
  // empty list, but this function never assumes its caller got that right).
  thumb.appendChild(el(doc, "span", "wtn-cs-thumb-ph"));
  return thumb;
}

/**
 * Opens the Civitai search panel, anchored to `anchorEl`. Kind-LOCKED (§7c:
 * a node-embedded picker) -- `kind` never changes for the life of one open
 * panel.
 *
 * @param {{ctx: {doc, getCanvasEl}, anchorEl: Element, kind: string,
 *   ownerKey?: string, onClose?: () => void, pollIntervalMs?: number,
 *   thumbRetryBackoffMs?: number, initialQuery?: string,
 *   onDeleted?: (kind: string, name: string) => void}} opts
 *   `pollIntervalMs` (default 800ms in real use) is test-only -- threaded
 *   straight through to `startDownloadJob` so a test can drive the download
 *   poll loop deterministically instead of waiting on real 800ms timers.
 *   `thumbRetryBackoffMs` (default `THUMB_RETRY_BACKOFF_MS`, ~400ms in real
 *   use) is the same kind of test-only override for the §7c-iv thumbnail
 *   retry backoff. `initialQuery` (§7e's `notfound` action, "Search Civitai
 *   by name") pre-fills the search field before the panel's own initial
 *   search runs -- the button starts disabled exactly as it would after any
 *   other completed search, since that IS the search this call makes.
 *   `onDeleted(kind, name)` -- called after a card's own delete affordance
 *   (an "installed" card only) succeeds, so a caller (e.g. a LoRA row
 *   pointing at the just-deleted file) can trigger its own missing-file
 *   re-check; this panel already handles its own re-render + `invalidateList`
 *   regardless of whether a caller supplies this.
 * @returns {object|null} the overlay handle, or `null` if this call just
 *   TOGGLED an already-open panel closed (mirrors `model_picker.mjs`'s own
 *   `openModelPicker` convention).
 */
export function openCivitaiSearch({
  ctx, anchorEl, kind, ownerKey, onClose, pollIntervalMs = 800, thumbRetryBackoffMs = THUMB_RETRY_BACKOFF_MS,
  initialQuery = "", onDeleted,
} = {}) {
  const key = ownerKey || `civitai-search:${kind}`;
  if (closeOverlayIfOwnedBy(key)) {
    return null;
  }
  closeOverlaysNotAncestorOf(anchorEl);

  const doc = ctx.doc;
  injectStyles(doc);

  const panel = el(doc, "div", "wtn-cs-panel wtn");

  const head = el(doc, "div", "wtn-cs-head");
  const headTitle = el(doc, "span");
  headTitle.textContent = "Browse Civitai";
  head.appendChild(headTitle);
  const closeBtn = el(doc, "span", "wtn-cs-close");
  closeBtn.textContent = "✕"; // ✕
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handle.close();
  });
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const body = el(doc, "div", "wtn-cs-body");
  panel.appendChild(body);

  // `.wtn-cs-pinned` -- everything that must stay visible regardless of how
  // long the results list gets (task brief: "search field, filter pills and
  // any status banner pinned"); only `.wtn-cs-scroll` below (the results
  // list) ever scrolls. See this file's CSS `.wtn-cs-body`/`.wtn-cs-pinned`/
  // `.wtn-cs-scroll` comment for the flex mechanics.
  const pinned = el(doc, "div", "wtn-cs-pinned");
  body.appendChild(pinned);

  // An explicit `Search` button beside the field (§7c-i, "not a debounce")
  // -- nothing fires from typing alone; see `updateSearchButtonState`/the
  // `search` "input"/"keydown" listeners below.
  const searchRow = el(doc, "div", "wtn-cs-searchrow");
  const searchWrap = el(doc, "div", "wtn-cs-search-wrap");
  searchWrap.appendChild(el(doc, "span", "wtn-cs-search-icon"));
  const search = el(doc, "input", "wtn-cs-search");
  search.type = "text";
  search.placeholder = "Search Civitai…";
  search.spellcheck = false;
  if (initialQuery) {
    search.value = initialQuery;
  }
  searchWrap.appendChild(search);
  searchRow.appendChild(searchWrap);
  const searchBtn = el(doc, "button", "wtn-cs-search-btn");
  searchBtn.type = "button";
  searchBtn.textContent = "Search";
  searchBtn.title = "Run this search";
  searchRow.appendChild(searchBtn);
  pinned.appendChild(searchRow);

  // ---- filters (§7c-i: the FULL set, `type` locked, laid out as a compact
  // row of dropdown pills -- a node panel is ~340px, no room for the
  // modal's own rail) ------------------------------------------------------
  const filters = el(doc, "div", "wtn-cs-filters");
  const typePill = el(doc, "span", "wtn-cs-pill wtn-cs-pill-locked");
  typePill.textContent = `type: ${TYPE_LABEL_FOR_KIND[kind] || kind} \u{1F512}`;
  typePill.title = "Locked — this surface only searches the kind it was opened for.";
  filters.appendChild(typePill);

  let currentFilters = {
    baseModel: getSetting(SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL]),
    sort: getSetting(SETTING_IDS.CIVITAI_SEARCH_SORT, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_SORT]),
    period: getSetting(SETTING_IDS.CIVITAI_SEARCH_PERIOD, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_PERIOD]),
    // §7c-iv: the label string ("PG".."XXX") -- `levelLabelToInt` is where
    // this becomes the numeric value `searchModels`/thumbnail-picking need.
    level: getSetting(SETTING_IDS.CIVITAI_BROWSING_LEVEL, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_BROWSING_LEVEL]),
  };

  const baseModelSel = buildFilterSelect(doc, CIVITAI_SEARCH_BASE_MODEL_OPTIONS, currentFilters.baseModel, (v) => {
    currentFilters.baseModel = v;
    setSetting(SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL, v);
    runSearch({ resetCursor: true });
  });
  filters.appendChild(baseModelSel);

  const sortSel = buildFilterSelect(doc, CIVITAI_SEARCH_SORT_OPTIONS, currentFilters.sort, (v) => {
    currentFilters.sort = v;
    setSetting(SETTING_IDS.CIVITAI_SEARCH_SORT, v);
    runSearch({ resetCursor: true });
  });
  filters.appendChild(sortSel);

  const periodSel = buildFilterSelect(doc, CIVITAI_SEARCH_PERIOD_OPTIONS, currentFilters.period, (v) => {
    currentFilters.period = v;
    setSetting(SETTING_IDS.CIVITAI_SEARCH_PERIOD, v);
    runSearch({ resetCursor: true });
  });
  filters.appendChild(periodSel);

  // §7c-iv: "Maximum browsing level" replaces the NSFW checkbox -- PG is a
  // genuine server-side guarantee, PG-13/R/X/XXX are filtered client-side
  // from a fuller gallery fetch (this file's own top doc comment).
  const levelSel = buildFilterSelect(doc, CIVITAI_SEARCH_LEVEL_OPTIONS, currentFilters.level, (v) => {
    currentFilters.level = v;
    setSetting(SETTING_IDS.CIVITAI_BROWSING_LEVEL, v);
    runSearch({ resetCursor: true });
  });
  levelSel.title = "Maximum browsing level — PG never asks Civitai for adult content at all; PG-13/R/X/XXX filter a fuller gallery client-side.";
  filters.appendChild(levelSel);
  pinned.appendChild(filters);

  const hint = el(doc, "div", "wtn-cs-hint");
  hint.textContent = "Same filters as the toolbar browser — only type is locked, and filters are remembered across every AnimaFlow model browser.";
  pinned.appendChild(hint);

  const publicOnlyLine = el(doc, "div", "wtn-cs-warn");
  publicOnlyLine.textContent = "No API key set — public results only.";
  publicOnlyLine.style.display = "none";
  pinned.appendChild(publicOnlyLine);

  const statusLine = el(doc, "div");
  pinned.appendChild(statusLine);

  // ---- destination (§ decision 5: editable, defaulting to models/<kind>) --
  const dest = el(doc, "div", "wtn-cs-dest");
  const destLabel = el(doc, "label");
  destLabel.textContent = "Save to:";
  const destInput = el(doc, "input");
  destInput.type = "text";
  destInput.value = DEFAULT_ROOT_DISPLAY[kind] || "models";
  destInput.spellcheck = false;
  destInput.addEventListener("click", (e) => e.stopPropagation());
  destInput.addEventListener("pointerdown", (e) => e.stopPropagation());
  dest.appendChild(destLabel);
  dest.appendChild(destInput);
  pinned.appendChild(dest);

  const activeHost = el(doc, "div");
  pinned.appendChild(activeHost);

  // `.wtn-cs-scroll` -- the ONLY scrolling area (task brief). The results
  // list lives here, sized by the panel's own JS-computed `max-height`
  // (`applyMaxHeight`, below) rather than a fixed vh/px constant.
  const scrollArea = el(doc, "div", "wtn-cs-scroll");
  body.appendChild(scrollArea);

  const list = el(doc, "div", "wtn-cs-list");
  scrollArea.appendChild(list);

  const footerHint = el(doc, "div", "wtn-cs-hint");
  footerHint.style.marginTop = "8px";
  footerHint.textContent = `Downloads run server-side into ${DEFAULT_ROOT_DISPLAY[kind] || "models"}/ — this browser cannot write there. A run is never blocked by a fetch.`;
  body.appendChild(footerHint); // pinned footer, NOT inside .wtn-cs-scroll -- always visible

  // ---- state --------------------------------------------------------------
  let results = [];
  let nextCursor = null;
  let loading = true;
  // BUG G: distinct from `loading` (which replaces the WHOLE list with a
  // "Searching…" placeholder for a fresh/reset search) -- `loadingMore` is
  // true only while a PAGING fetch (`resetCursor: false`) is in flight, so
  // the already-rendered results stay on screen with a small footer
  // affordance appended below them (`renderList`) instead of being replaced.
  let loadingMore = false;
  let searchSeq = 0;
  // §7c-i's own "Search button" state -- the text of the last EXECUTED
  // search (never the field's own live value). `null` until the panel's
  // trailing `runSearch({resetCursor:true})` call (below) runs for the
  // first time; `searchButtonEnabled`/`updateSearchButtonState` compare
  // against it, never the field directly.
  let lastSearchedQuery = null;
  // §7c-iv's own "make sure a card that re-renders mid-retry doesn't leave a
  // stale timer writing to a detached element" -- bumped once at the very
  // top of every `renderList()` call (below); a thumbnail's own pending
  // retry/advance timer (`attachThumbCandidate`'s `isStale` closure) captures
  // the generation IT was built under and refuses to touch the DOM once a
  // later `renderList()` has moved the generation past it, regardless of
  // whether the old thumb box object happens to still be reachable.
  let renderGeneration = 0;
  const cardMessages = new Map(); // resultKey -> a readable line under that card
  // The version picker's own selection state (docs task 2026-07-31) -- keyed
  // by `model_id`, value is the chosen `version_id`. Lives in THIS closure
  // (not the module-level singletons above it) because it's per-panel
  // browsing state, not something a download job or a different panel needs
  // to see: preserved across `appendDedupedResults` (pagination keeps a
  // model's own chosen version), cleared at the top of every reset-cursor
  // `runSearch` call (a brand-new query has nothing to preserve a choice
  // FOR yet).
  const selectedVersions = new Map();

  /** The specific version object within `result.versions` that `job.key`
   * belongs to, or `null` for a legacy/single-version result with no
   * `versions` array at all (the caller falls back to mutating `result`
   * itself in that case -- see `onDownloadStateChange`). */
  function findVersionByJobKey(result, key) {
    const versions = Array.isArray(result.versions) ? result.versions : null;
    if (!versions) {
      return null;
    }
    return versions.find((v) => v && resultKey({ model_id: result.model_id, primary_version_id: v.version_id }) === key) || null;
  }

  function renderActive() {
    activeHost.innerHTML = "";
    const job = getActiveDownloadState();
    // Only show the PERSISTENT banner when the active job's own card is NOT
    // already visible in the current results list -- otherwise the card
    // itself (§7c-iii's "downloading" state, below) already shows the exact
    // same progress, and duplicating it here would just be noise. Tests the
    // RESOLVED, currently-displayed view of each result -- i.e. whichever
    // version its own dropdown has selected right now -- never "any version
    // of this result matches," which used to suppress the banner even when
    // the version actually rendered on the card was a DIFFERENT one (regression,
    // 2026-07-31): switch a card's dropdown away from the version that's
    // downloading and neither the card nor this banner showed it, with no way
    // to cancel until the dropdown was switched back.
    if (!job || results.some((r) => resultKey(resolveVersionView(r, selectedVersions.get(r.model_id))) === job.key)) {
      return;
    }
    const row = el(doc, "div", "wtn-cs-active");
    const label = el(doc, "span");
    label.textContent = `Downloading ${job.filename || "…"}`;
    row.appendChild(label);
    const pct = downloadPercent(job.bytes, job.total);
    const bar = el(doc, "div", "wtn-cs-bar");
    const fill = el(doc, "i");
    fill.style.width = `${pct == null ? 0 : pct}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    const pctLabel = el(doc, "span");
    pctLabel.textContent = pct == null ? "…" : `${pct}%`;
    row.appendChild(pctLabel);
    const cancelBtn = el(doc, "button", "wtn-cs-action wtn-cs-action-cancel");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cancelActiveDownloadJob();
    });
    row.appendChild(cancelBtn);
    activeHost.appendChild(row);
  }

  function buildCard(result) {
    // The version-picker view (docs task 2026-07-31) -- computed ONCE, then
    // every render decision below reads ONLY this flat `view`, never `result`
    // directly, so a version switch is a single uniform re-render (this
    // file's own doc comment on `resolveVersionView` has the full
    // reasoning). `result.versions` (the raw, un-flattened list) is still
    // consulted separately, below, for the ONE thing the view doesn't carry:
    // whether there's more than one version to choose between at all.
    const selectedVersionId = selectedVersions.get(result.model_id);
    const view = resolveVersionView(result, selectedVersionId);

    const card = el(doc, "div", "wtn-cs-card");
    const rKey = resultKey(view);
    const job = getActiveDownloadState();
    const state = resultCardState(view, job, _sessionGatedKeys);

    // §7c-iv: the thumbnail box's own state is a SEPARATE decision from the
    // card's action state above -- `thumbState` folds `gated` in as the one
    // thing that still wins over everything (§7c-iii's rule, unchanged).
    // `gen`/`isStale` are this card's own render-generation capture (this
    // file's own `renderGeneration` doc comment) -- captured HERE, once per
    // card build, so every retry/advance step this card's thumb ever takes
    // shares the same stale-check regardless of how many re-renders happen
    // while a retry timer is still pending.
    const levelInt = levelLabelToInt(currentFilters.level);
    // `view.nsfw_level` -- the MODEL's own top-level bitmask union (survives
    // `resolveVersionView`'s spread untouched, since only per-VERSION fields
    // are overridden there) -- is what lets `thumbState` tell "genuinely no
    // gallery" apart from "gallery trimmed to nothing at this level" for an
    // empty `view.images` (owner-reported, 2026-07-31: "why some images are
    // not shown?" -- see `civitai_thumb.mjs`'s own doc comment).
    const tState = thumbState(state, view.images, levelInt, view.nsfw_level);
    const candidates = tState === "image" ? pickThumbCandidates(view.images, levelInt) : [];
    const gen = renderGeneration;
    const isStale = () => gen !== renderGeneration;
    card.appendChild(buildThumb(doc, tState, candidates, isStale, thumbRetryBackoffMs));
    // The download sidecar's own `preview_url` (task brief, §7c-iv's "save
    // what you're showing" rule): the FIRST level-passing candidate -- i.e.
    // the card's own primary attempt, already level-filtered by construction
    // (`candidates`, above) -- or `null` when nothing passes the level at
    // all (`locked`/`placeholder`/`gated`), so the backend saves NO preview
    // rather than an over-level one. This is a deliberate simplification of
    // "currently displaying": if the primary candidate has failed to load
    // and the box has since advanced to a later one, this still sends the
    // PRIMARY level-passing URL rather than tracking the live retry index --
    // still level-filtered, still one of the candidates the box would show.
    const previewUrl = candidates.length > 0 ? candidates[0] : null;

    const meta = el(doc, "div", "wtn-cs-meta");
    const title = el(doc, "div", "wtn-cs-title");
    title.textContent = view.name || "(untitled)";
    title.title = view.name || "";
    meta.appendChild(title);

    // Base model + download count on their own row (owner, 2026-07-30): the
    // base model used to be folded into the subtitle's joined text, where it
    // "didn't register" scanning a list -- now a standalone chip, reusing
    // `js/shared/theme.css`'s own `.wtn-chip` vocabulary (a new `--accent`
    // variant, muted per that file's own precedent -- see its doc comment).
    // Omitted entirely (never a placeholder) when genuinely unknown, same
    // "omit rather than invent" rule `resultBaseModel` itself documents.
    const metaRow = el(doc, "div", "wtn-cs-metarow");
    const baseModel = resultBaseModel(view);
    if (baseModel) {
      const chip = el(doc, "span", "wtn-chip wtn-chip--accent wtn-cs-chip");
      chip.textContent = baseModel;
      chip.title = baseModel;
      metaRow.appendChild(chip);
    }
    const sub = el(doc, "div", "wtn-cs-sub");
    sub.textContent = state === "gated" ? gatedSubtitle() : resultSubtitle(view);
    metaRow.appendChild(sub);
    meta.appendChild(metaRow);

    if (state === "downloading") {
      const pct = downloadPercent(job.bytes, job.total);
      const bar = el(doc, "div", "wtn-cs-bar");
      const fill = el(doc, "i");
      fill.style.width = `${pct == null ? 0 : pct}%`;
      bar.appendChild(fill);
      meta.appendChild(bar);
    }
    const msg = cardMessages.get(rKey);
    // A version with no downloadable file at all (`pick_primary_file` was
    // `None` server-side) gets a readable reason under the card instead of
    // a Download button that would fire a request with `filename: null` --
    // only in the "available" state, since installed/downloading/gated
    // already have their own, more specific messaging.
    const missingFile = !view.file_name || !view.download_url;
    if (msg) {
      const msgEl = el(doc, "div", "wtn-cs-cardmsg");
      msgEl.textContent = msg;
      meta.appendChild(msgEl);
    } else if (state === "available" && missingFile) {
      const msgEl = el(doc, "div", "wtn-cs-cardmsg");
      msgEl.textContent = "No downloadable file for this version.";
      meta.appendChild(msgEl);
    }
    card.appendChild(meta);

    // The right-hand ACTION COLUMN (owner, 2026-07-31: "the version should be
    // above the download button") -- the version picker (when there's a
    // genuine choice, `result.versions.length > 1`; a single-version or
    // legacy no-`versions`-array result never shows one at all) stacked
    // directly above whichever action element this card's state renders
    // below, both right-aligned via `.wtn-cs-actioncol`'s own `align-items:
    // flex-end`. One element (`actionCol`) is appended to the card in place
    // of the action alone, so the two stay grouped regardless of how tall
    // either one is.
    const actionCol = el(doc, "div", "wtn-cs-actioncol");

    const versions = Array.isArray(result.versions) ? result.versions : null;
    if (versions && versions.length > 1) {
      const versionSel = el(doc, "select", "wtn-cs-sel wtn-cs-version-sel");
      versionSel.title = "Choose which version to download.";
      for (const v of versions) {
        const opt = el(doc, "option");
        opt.value = String(v.version_id);
        // Falls back to `#<version_id>` for a version Civitai returned with
        // no `name` at all (rare, but `_parse_version` never invents one).
        opt.textContent = v.name || `#${v.version_id}`;
        if (v.version_id === view.primary_version_id) {
          opt.selected = true;
        }
        versionSel.appendChild(opt);
      }
      versionSel.value = String(view.primary_version_id);
      // `stopPropagation` on both `click` and `change` -- the SAME pattern
      // the filter `<select>`s (`buildFilterSelect`, above) already use, so
      // opening/using this dropdown never lets litegraph steal the gesture.
      versionSel.addEventListener("click", (e) => e.stopPropagation());
      versionSel.addEventListener("change", (e) => {
        e.stopPropagation();
        const chosenId = Number(versionSel.value);
        // Switching versions never disturbs a DIFFERENT card's in-flight
        // download -- this only ever touches this one model's own entry in
        // the selection map, and re-renders; the module-level
        // `_activeDownload` singleton (if any) is untouched.
        selectedVersions.set(result.model_id, chosenId);
        renderList();
      });
      actionCol.appendChild(versionSel);
    }

    if (state === "installed") {
      const badge = el(doc, "span", "wtn-cs-action wtn-cs-action-installed");
      badge.textContent = "✓ installed"; // ✓ installed -- NOT the mockup's "have" (owner, §7c-iii)
      actionCol.appendChild(badge);
      // "Remove an installed model" (docs/TODO.md) -- the search menu's own
      // delete affordance, beside the badge (a second, independent action,
      // not a replacement for it). `view.file_name` is the on-disk name
      // `installed` was itself computed against (`api.py`'s own
      // `_annotate_search_results` checks the destination at the kind's
      // ROOT, subfolder `""`), so it resolves the same file.
      const deleteBtn = el(doc, "button", "wtn-cs-action wtn-cs-action-delete");
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.title = "Delete this file from disk.";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openDeleteConfirm({
          doc,
          kind,
          name: view.file_name,
          sizeBytes: Number.isFinite(view.size_kb) ? view.size_kb * 1024 : null,
          deleteFn: deleteModel,
          onDeleted: (delResult) => {
            logSummary("LoRA search", `deleted ${view.file_name} (${removedSummary(delResult.removed)})`);
            // The file is gone -- flip THIS version back to "available"
            // (never vanish/throw the card) and invalidate the client list
            // cache so the picker stops offering it (docs/TODO.md).
            const versions = Array.isArray(result.versions) ? result.versions : null;
            const matchedVersion = versions && versions.find((v) => v && v.version_id === view.primary_version_id);
            if (matchedVersion) {
              matchedVersion.installed = false;
            } else {
              result.installed = false;
            }
            invalidateList(kind);
            if (typeof onDeleted === "function") {
              onDeleted(kind, view.file_name);
            }
            renderList();
          },
        });
      });
      actionCol.appendChild(deleteBtn);
    } else if (state === "downloading") {
      // The %/Cancel pair reads as ONE row stacked under the version select
      // (task brief: "make sure that pair still reads sensibly stacked under
      // a version select") -- `.wtn-cs-actioncol-row` (CSS, above) keeps them
      // side-by-side rather than each wrapping onto its own line.
      const pct = downloadPercent(job.bytes, job.total);
      const row = el(doc, "div", "wtn-cs-actioncol-row");
      const pctLabel = el(doc, "span", "wtn-cs-sub");
      pctLabel.textContent = pct == null ? "…" : `${pct}%`;
      row.appendChild(pctLabel);
      const cancelBtn = el(doc, "button", "wtn-cs-action wtn-cs-action-cancel");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelActiveDownloadJob();
      });
      row.appendChild(cancelBtn);
      actionCol.appendChild(row);
    } else if (state === "gated") {
      const btn = el(doc, "button", "wtn-cs-action wtn-cs-action-gated");
      btn.type = "button";
      btn.textContent = "key required"; // amber -- see .wtn-cs-action-gated (§7c-iii)
      btn.disabled = true;
      btn.title = "Add a Civitai API key in Settings → AnimaFlow → Controls to download this file.";
      actionCol.appendChild(btn);
    } else {
      const btn = el(doc, "button", "wtn-cs-action");
      btn.type = "button";
      btn.textContent = "↓ Download"; // ↓ Download -- NOT the mockup's "get" (owner, §7c-iii)
      if (missingFile) {
        // This version has no downloadable file at all -- disable rather
        // than let a click fire `/download/start` with `filename: null`.
        btn.disabled = true;
        btn.title = "No downloadable file for this version.";
      } else if (job) {
        // A DIFFERENT job is already running in this panel/process -- never
        // silently queue a second one (task brief); disable rather than let
        // the click round-trip to a guaranteed `busy`.
        btn.disabled = true;
        btn.title = "Another download is already running.";
      }
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (missingFile) {
          return; // never fire a request with filename: null
        }
        cardMessages.delete(rKey);
        const subfolder = subfolderFromDestinationField(destInput.value, kind);
        // The sidecar-seeding fields (`api.py`'s own `/download/start`
        // docstring, "no info sidecar, no preview image" fix) -- both were
        // accepted server-side since `4965389` but never actually sent, so
        // the whole feature was dead code (task brief). `civitaiMeta` is
        // OUR OWN normalized fields for this exact result -- the same shape
        // `civitai_search.parse_search_response`/`_annotate_search_results`
        // already produced them in, so the backend can seed a
        // `.civitai.info` sidecar with no second lookup. `previewUrl` is
        // `null` whenever nothing passes the level (`previewUrl`, above) --
        // the backend then saves no preview, which is specified, not a
        // failure (task brief).
        const civitaiMeta = {
          model_id: result.model_id,
          version_id: view.primary_version_id,
          name: view.name,
          type: result.type,
          base_model: view.base_model,
          tags: result.tags,
          triggers: view.triggers,
        };
        const resp = await startDownloadJob({
          kind, subfolder, filename: view.file_name, downloadUrl: view.download_url, sizeKb: view.size_kb, key: rKey,
          civitaiMeta, previewUrl,
        }, pollIntervalMs);
        if (resp.reason !== "started") {
          cardMessages.set(rKey, downloadStartMessage(resp));
          logSummary("LoRA search", `download NOT started: ${view.file_name} (${resp.reason})`);
        } else {
          logSummary("LoRA search", `download started: ${view.file_name} (${kind})`);
        }
        renderList();
      });
      actionCol.appendChild(btn);
    }

    card.appendChild(actionCol);

    // §7c-ii: a card click OUTSIDE any of its own interactive controls opens
    // the vertical detail panel (decision 21 -- "a new VERTICAL info panel...
    // not the modal, not an in-panel swap"). Every control above already
    // `stopPropagation`s its own click, so this only ever fires for the
    // card's own body/thumb/title/metarow.
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      openModelDetailPanel({
        ctx, anchorEl: card, kind, result, versionId: selectedVersionId,
        destInput, pollIntervalMs, thumbRetryBackoffMs,
        onVersionPersist: (id) => selectedVersions.set(result.model_id, id),
      });
    });
    return card;
  }

  function renderList() {
    // §7c-iv -- every card built by this pass shares this new generation, so
    // a previously-built card's own thumbnail retry/advance timer (captured
    // under the OLD generation) can tell it is now stale, even though the
    // old thumb box object itself may still technically be reachable.
    renderGeneration += 1;
    renderActive();
    list.innerHTML = "";
    if (loading) {
      const msg = el(doc, "div", "wtn-cs-empty");
      msg.textContent = "Searching…";
      list.appendChild(msg);
      return;
    }
    if (!results.length) {
      const msg = el(doc, "div", "wtn-cs-empty");
      msg.textContent = "No results.";
      list.appendChild(msg);
      return;
    }
    for (const result of results) {
      list.appendChild(buildCard(result));
    }
    if (loadingMore) {
      // BUG G's own loading affordance -- appended BELOW the already-
      // rendered results, never replacing them (a page-two fetch never
      // wipes page one).
      const msg = el(doc, "div", "wtn-cs-empty wtn-cs-loading-more");
      msg.textContent = "Loading more…";
      list.appendChild(msg);
    }
  }

  function renderStatus() {
    statusLine.innerHTML = "";
    publicOnlyLine.style.display = "none";
  }

  /**
   * BUG G -- fetches a page. `resetCursor: true` (a brand-new query or a
   * filter change) always fires, replaces `results` wholesale, and forgets
   * any prior page position (`nextCursor`/`loadingMore` reset FIRST, before
   * the request even goes out -- task brief: "reset paging on every new
   * search or filter change... a stale cursor from the previous query
   * appending onto new results would be a nasty, hard-to-spot bug").
   * `resetCursor: false` (the infinite-scroll path, `maybeLoadMore` below)
   * is a no-op when a page is already in flight or there is no further page
   * (`loadingMore`/`nextCursor` guard -- task brief's "one request in flight
   * at a time" and "stop cleanly when next_cursor is null/absent") and
   * APPENDS (deduped, `appendDedupedResults`) rather than replacing.
   *
   * Also the one call site for the "un-gate on key change" fix
   * (`reconcileGatedKeysOnApiKeySignature`'s own top doc comment): this
   * function already runs both when the panel first opens (`openCivitaiSearch`'s
   * own trailing call, below) and on every later search/filter change, so
   * checking the API key setting here covers both of the task's "natural
   * points" with one call.
   *
   * ⚠️ §7c-iv's accepted PG cost, documented rather than fixed: at the PG
   * setting the request below sends `level: 1`, which the search route turns
   * into `nsfw=false` -- Civitai then returns an adult model with its OWN
   * gallery trimmed to level-1 images only (sometimes none), never the
   * model's full set. Such a model therefore arrives with an EMPTY `images`
   * array, indistinguishable here from a genuinely image-less one --
   * `thumbState` renders the plain placeholder for it, not the `locked` lock,
   * even though the real reason is "above your level," not "no pictures."
   * That is the accepted trade for PG being a genuine server-side guarantee
   * (Civitai is never even ASKED for adult content at that setting) rather
   * than a cosmetic client-side filter -- see this file's own top doc
   * comment and design doc §7c-iv for the full reasoning. Not fixable from
   * here: the information needed to tell the two apart was never sent.
   */
  async function runSearch({ resetCursor = true } = {}) {
    reconcileGatedKeysOnApiKeySignature(
      apiKeySignature(getSetting(SETTING_IDS.CIVITAI_API_KEY, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_API_KEY])),
      _sessionGatedKeys,
    );
    if (resetCursor) {
      nextCursor = null;
      loadingMore = false;
      // A brand-new query/filter change REPLACES the results list wholesale
      // -- nothing yet to preserve a version choice for (task brief:
      // "cleared when a new query replaces the list"). Paging
      // (`resetCursor: false`, below) never reaches this branch, which is
      // exactly what lets a selection survive `appendDedupedResults`.
      selectedVersions.clear();
    } else if (loadingMore || !nextCursor) {
      return;
    } else {
      loadingMore = true;
    }
    const seq = (searchSeq += 1);
    if (resetCursor) {
      loading = true;
    }
    renderList();
    const query = search.value.trim();
    if (resetCursor) {
      // §7c-i: "each filter-triggered search updates the last-searched
      // text, so the button settles back to disabled afterwards" -- true
      // here of every reset-cursor search regardless of what triggered it
      // (the button itself, Enter, or a filter change), since all three
      // reach this one function. Pagination (`resetCursor: false`) never
      // reaches this branch -- untouched, per spec.
      lastSearchedQuery = query;
      updateSearchButtonState();
    }
    logDebug(
      "LoRA search",
      `${kind}: issuing ${resetCursor ? "search" : "page fetch"} (query=${JSON.stringify(query)}, `
      + `baseModel=${JSON.stringify(currentFilters.baseModel)}, sort=${currentFilters.sort}, `
      + `period=${currentFilters.period}, level=${currentFilters.level})`,
    );
    const resp = await searchModels(kind, {
      query,
      baseModel: currentFilters.baseModel,
      sort: currentFilters.sort,
      period: currentFilters.period,
      level: levelLabelToInt(currentFilters.level),
      cursor: resetCursor ? "" : (nextCursor || ""),
    });
    if (seq !== searchSeq) {
      // Superseded by a newer search (this ALSO covers a paging fetch made
      // stale by a filter change/new query in the meantime -- that newer
      // call already reset `loadingMore`/`nextCursor` itself at its own
      // start, above) -- discard this stale reply.
      return;
    }
    loading = false;
    loadingMore = false;
    publicOnlyLine.style.display = resp.public_only ? "" : "none";

    statusLine.innerHTML = "";
    if (resp.reason !== "ok") {
      const lineClass = resp.reason === "rate_limited" ? "wtn-cs-info" : "wtn-cs-bad";
      const line = el(doc, "div", lineClass);
      line.textContent = searchReasonMessage(resp) || resp.message || "Search failed.";
      statusLine.appendChild(line);
      logSummary("LoRA search", `${kind}: search issued (query=${JSON.stringify(query)}) failed -- ${resp.reason}`);
      if (resetCursor) {
        results = [];
        nextCursor = null;
      }
      // A page-TWO failure (`rate_limited` -- our own limiter, per §9 -- or
      // anything else) leaves the already-rendered EARLIER pages untouched,
      // and deliberately leaves `nextCursor` itself alone too, so scrolling
      // back down retries the SAME page rather than losing the user's place
      // (task brief: "handle rate_limited on a page-two fetch as calmly as
      // on page one").
      renderList();
      return;
    }
    const incoming = resp.results || [];
    results = resetCursor ? appendDedupedResults([], incoming) : appendDedupedResults(results, incoming);
    nextCursor = resp.next_cursor;
    logSummary("LoRA search", `${kind}: search issued (query=${JSON.stringify(query)}) -> ${incoming.length} result(s)`);
    renderList();
  }

  /** BUG G's infinite-scroll trigger -- fires on every `.wtn-cs-scroll`
   * scroll event, but `runSearch`'s own `loadingMore`/`nextCursor` guard
   * (above) is what actually keeps a burst of scroll events down to at most
   * ONE in-flight request; this function only ever decides WHETHER the user
   * is close enough to the bottom to ask. */
  function maybeLoadMore() {
    if (loadingMore || !nextCursor) {
      return;
    }
    const remaining = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
    if (remaining <= SCROLL_LOAD_MORE_THRESHOLD_PX) {
      runSearch({ resetCursor: false });
    }
  }
  scrollArea.addEventListener("scroll", maybeLoadMore);

  search.addEventListener("click", (e) => e.stopPropagation());

  // §7c-i: "An explicit Search button, not a debounce" -- typing alone never
  // fires a search (no timer, no blur); it only updates whether the button
  // itself is enabled. `runSearch` is what updates `lastSearchedQuery` once
  // a search actually executes (its own doc comment).
  function updateSearchButtonState() {
    searchBtn.disabled = !searchButtonEnabled(search.value, lastSearchedQuery);
  }
  search.addEventListener("input", updateSearchButtonState);
  searchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (searchBtn.disabled) {
      return;
    }
    runSearch({ resetCursor: true });
  });
  // Enter runs the SAME action -- "an explicit button keyboard users cannot
  // reach is a downgrade for them" (§7c-i).
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if (typeof e.preventDefault === "function") {
        e.preventDefault();
      }
      if (!searchBtn.disabled) {
        runSearch({ resetCursor: true });
      }
    }
  });

  /**
   * The download-state subscriber: reconciles a TERMINAL job outcome against
   * this panel's own `results`/`cardMessages` before repainting. `_pollLoop`
   * (module-level, `civitai_api`-agnostic) notifies TWICE on completion --
   * once with the job still present but `status` already terminal (`"ok"`/
   * `"cancelled"`/...), then again with the job cleared to `null` -- so this
   * catches the outcome on the FIRST of those two notifies, while `job.key`
   * still identifies which result it was for. Idempotent (marking a result
   * `installed` twice, or clearing an already-cleared message, is harmless),
   * so there is no "already handled" flag to maintain.
   *
   * `job.key` is the SELECTED version's own key (`resolveVersionView`'s own
   * doc comment) -- `findVersionByJobKey` (this file's top-level helper,
   * above) is what lets a multi-version result mutate exactly that ONE
   * version's `installed`/`gated` flag rather than the whole result's, so
   * switching versions on the SAME card afterwards still reflects each
   * version's own, independent outcome (docs task 2026-07-31: "switching to
   * a version that is already installed must flip the card to the installed
   * state, and back again"). Finding `finishedResult` itself deliberately
   * checks EVERY version of a result (the result's own key first for the
   * single-version/legacy-shape case, then `findVersionByJobKey` across the
   * full `versions` array) rather than only the currently-SELECTED one --
   * unlike `renderActive`'s banner-suppression check (which must track only
   * what's actually rendered), the job here may target a version the user has
   * since switched the dropdown away from, and that version's own flag still
   * needs mutating on completion.
   */
  function onDownloadStateChange() {
    const job = getActiveDownloadState();
    if (job && job.status && job.status !== "downloading" && job.status !== "cancelling") {
      // C/E -- one summary line per TERMINAL transition, never per poll tick
      // (this branch already only ever runs on a terminal status, above).
      logSummary("LoRA search", `download finished: ${job.filename || job.key} (${job.status})`);
      const finishedResult = results.find((r) => resultKey(r) === job.key || !!findVersionByJobKey(r, job.key));
      const finishedVersion = finishedResult ? findVersionByJobKey(finishedResult, job.key) : null;
      if (job.status === "ok") {
        // The atomic-rename guarantee (`download.py`'s own top doc comment)
        // means "ok" IS "the file is genuinely on disk now" -- flip this
        // card straight to the "installed" state without waiting on a fresh
        // search, matching the picker's own instant-refresh expectation
        // (task brief, deliverable 4).
        if (finishedVersion) {
          finishedVersion.installed = true;
        } else if (finishedResult) {
          finishedResult.installed = true;
        }
        cardMessages.delete(job.key);
      } else if (job.status === "key_required") {
        // BUG F (owner, 2026-07-30): the download itself just answered
        // 401/403 -- GROUND TRUTH that the up-front `gated` guess for this
        // result was wrong (or absent). Flip this card straight to the
        // gated state (no waiting on a fresh search that would just repeat
        // the same wrong guess), AND remember it session-wide
        // (`markResultGated`) so a LATER re-render or a brand-new search
        // still renders it gated -- see `resultCardState`'s own doc comment.
        // `gatedSubtitle()`'s "needs an API key" already says everything a
        // gated card needs to; no separate red `cardmsg` line underneath a
        // Download button that no longer exists.
        markResultGated(job.key);
        if (finishedVersion) {
          finishedVersion.gated = true;
        } else if (finishedResult) {
          finishedResult.gated = true;
        }
        cardMessages.delete(job.key);
      } else {
        cardMessages.set(job.key, downloadTerminalMessage(job.status, job));
      }
    }
    renderList();
  }
  const unsubscribe = subscribeDownloadState(onDownloadStateChange);

  renderStatus();
  renderList(); // initial "Searching…" paint

  // ---- height + side: `overlay.mjs`'s own `reposition()` decides both
  // together now (that module's own top doc comment, owner-reported bug
  // 2026-07-30) -- this file's job is only to hand it this panel's own floor
  // (chrome + the results area's own minimum), never to pre-shrink the panel
  // and hope the flip agrees. A no-op with no real live `window` to measure
  // (every headless test with no `defaultView`), matching `overlay.mjs`'s own
  // "`null` means never adjust" convention (`reposition()` itself degrades to
  // its no-vh fallback in that case). ----
  const win = doc.defaultView || (typeof window !== "undefined" ? window : null);

  function resultsFloorPx() {
    // The head + pinned controls + footer's own REAL rendered height --
    // measured live rather than assumed, so a taller filter row (a longer
    // base-model list wrapping, say) is accounted for automatically --
    // plus the results area's own minimum (`MIN_RESULTS_HEIGHT_PX`), matching
    // `computeSearchPanelMaxHeight`'s old `minContentHeight` argument.
    return head.getBoundingClientRect().height
      + pinned.getBoundingClientRect().height
      + footerHint.getBoundingClientRect().height
      + MIN_RESULTS_HEIGHT_PX;
  }

  let onWindowResize = null;
  let anchorPollHandle = null;

  const handle = openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, panel, "below", () => {
    unsubscribe();
    if (typeof scrollArea.removeEventListener === "function") {
      scrollArea.removeEventListener("scroll", maybeLoadMore);
    }
    if (win && onWindowResize && typeof win.removeEventListener === "function") {
      win.removeEventListener("resize", onWindowResize);
    }
    if (anchorPollHandle != null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(anchorPollHandle);
    }
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }, "wtn-cs-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;

  // Now that the panel is actually attached to `doc.body`, re-run
  // `reposition()` with this panel's own floor -- side and height are decided
  // together, in `overlay.mjs`, not pre-shrunk here first.
  function resize() {
    if (typeof handle.reposition === "function") {
      handle.reposition({ minHeight: resultsFloorPx() });
    }
  }
  resize();

  // Recompute trigger 1/2: window resize.
  onWindowResize = () => resize();
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("resize", onWindowResize);
  }

  // Recompute trigger 2/2: the canvas panning/zooming the node moves this
  // DOM-widget anchor with no DOM event to hook -- polled once per frame
  // while the panel is open, acting only on an actual change. Guarded
  // exactly like `js/controls/interaction.mjs`'s own `scheduleFit`
  // (`typeof requestAnimationFrame !== "function"`): a genuine no-op under
  // every headless test, never a fake timer to keep in sync there.
  let lastAnchorSig = null;
  function anchorSig() {
    const r = typeof anchorEl.getBoundingClientRect === "function" ? anchorEl.getBoundingClientRect() : null;
    return r ? `${r.left}:${r.top}:${r.right}:${r.bottom}` : null;
  }
  function pollAnchorMove() {
    const sig = anchorSig();
    if (sig !== null && sig !== lastAnchorSig) {
      lastAnchorSig = sig;
      resize();
    }
    anchorPollHandle = requestAnimationFrame(pollAnchorMove);
  }
  if (typeof requestAnimationFrame === "function") {
    lastAnchorSig = anchorSig();
    anchorPollHandle = requestAnimationFrame(pollAnchorMove);
  }

  if (typeof search.focus === "function") {
    search.focus(); // "focused on open" (task brief)
  }

  runSearch({ resetCursor: true });

  return handle;
}

// ---------------------------------------------------------------------------
// §7c-ii -- the picker's own VERTICAL detail panel (decision 21): a SIBLING
// overlay of the ⓘ panel, anchored to the CARD that was clicked, never the
// modal and never an in-panel swap of the results list. `model_detail_view.mjs`
// supplies the actual content (`buildModelDetailView`, `layout: "vertical"`)
// -- this function is purely the MOUNT: the overlay shell, the fetch/
// re-render loop for the two extra fields a search result doesn't already
// carry (`civitai_api.mjs`'s `fetchModelDetail`), and this surface's own
// primary action ("↓ Download & use in this row" -- returns to the row that
// opened it, §7c, unlike the modal's destination-derived download).
// ---------------------------------------------------------------------------

/**
 * Opens the vertical detail panel for `result`, anchored to `anchorEl` (the
 * clicked card). A second click on the SAME card toggles it closed
 * (`closeOverlayIfOwnedBy`, same convention as `openCivitaiSearch`/
 * `openModelInfo`); it nests INSIDE the still-open search panel rather than
 * replacing it (`closeOverlaysNotAncestorOf` keeps every ANCESTOR overlay of
 * `anchorEl` open — the search panel's own overlay element contains the
 * card, so it survives) — the same mechanism the ⓘ panel already relies on
 * to stay layered under the picker.
 *
 * @param {object} opts
 * @param {{doc, getCanvasEl}} opts.ctx
 * @param {Element} opts.anchorEl - the clicked card.
 * @param {string} opts.kind
 * @param {object} opts.result - the raw search-result object.
 * @param {number} [opts.versionId] - the version already selected on the
 *   card (its own per-card version `<select>`, if the user had touched it).
 * @param {Element} [opts.destInput] - the panel's own "Save to:" field, reused
 *   for the detail view's own download (same destination, no second field).
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.thumbRetryBackoffMs]
 * @param {(versionId: number) => void} [opts.onVersionPersist] - lets the
 *   picker's own per-card version `<select>` state stay in sync with a
 *   version switch made INSIDE the detail panel.
 * @returns {object|null}
 */
export function openModelDetailPanel({
  ctx, anchorEl, kind, result, versionId, destInput, pollIntervalMs = 800,
  thumbRetryBackoffMs = THUMB_RETRY_BACKOFF_MS, onVersionPersist, onClose,
} = {}) {
  const key = `model-detail:${kind}:${result && result.model_id}:${result && result.primary_version_id}`;
  if (closeOverlayIfOwnedBy(key)) {
    return null;
  }
  closeOverlaysNotAncestorOf(anchorEl);

  const doc = ctx.doc;
  injectStyles(doc);

  const panel = el(doc, "div", "wtn-cs-panel wtn-dv-panel wtn");
  const host = el(doc, "div");
  panel.appendChild(host);

  // `versionId` may be `undefined` (a card whose own version <select> the
  // user never touched) -- resolve it to the actual primary version id up
  // front, same fallback `resolveVersionView` itself applies, so the very
  // first `fetchModelDetail` call targets a real version id rather than
  // `undefined`.
  let currentVersionId = versionId != null ? versionId : resolveVersionView(result).primary_version_id;
  let detailState = { status: "loading", gallery: [] };
  let closed = false;
  let actionMessage = null;

  function currentLevel() {
    return levelLabelToInt(getSetting(SETTING_IDS.CIVITAI_BROWSING_LEVEL, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_BROWSING_LEVEL]));
  }

  /**
   * This panel's OWN primary action -- deliberately a SEPARATE, small
   * implementation from `buildCard`'s action column rather than a shared
   * extraction: the two surfaces' actions already differ in shape (no
   * per-card version `<select>` here -- the SHARED version selector already
   * lives in `buildModelDetailView` itself; no "Delete" affordance --
   * matches an INSTALLED result having nothing left to download, not a
   * place to manage the file from) and duplicating four states' worth of
   * markup is a smaller risk than reworking `buildCard`'s already-tested
   * action column to serve two call shapes at once.
   */
  function buildAction(d, view) {
    const rKey = resultKey(view);
    const job = getActiveDownloadState();
    const state = resultCardState(view, job, sessionGatedKeys());
    const wrap = el(d, "div", "wtn-dv-detailaction");

    if (state === "installed") {
      const badge = el(d, "span", "wtn-cs-action wtn-cs-action-installed");
      badge.textContent = "✓ installed";
      wrap.appendChild(badge);
      return wrap;
    }
    if (state === "downloading") {
      const pct = downloadPercent(job.bytes, job.total);
      const row = el(d, "div", "wtn-cs-actioncol-row");
      const pctLabel = el(d, "span", "wtn-cs-sub");
      pctLabel.textContent = pct == null ? "…" : `${pct}%`;
      row.appendChild(pctLabel);
      const cancelBtn = el(d, "button", "wtn-cs-action wtn-cs-action-cancel");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelActiveDownloadJob();
      });
      row.appendChild(cancelBtn);
      wrap.appendChild(row);
      return wrap;
    }
    if (state === "gated") {
      const btn = el(d, "button", "wtn-cs-action wtn-cs-action-gated");
      btn.type = "button";
      btn.textContent = "key required";
      btn.disabled = true;
      btn.title = "Add a Civitai API key in Settings → AnimaFlow → Controls to download this file.";
      wrap.appendChild(btn);
      return wrap;
    }

    const missingFile = !view.file_name || !view.download_url;
    const btn = el(d, "button", "wtn-cs-action");
    btn.type = "button";
    btn.textContent = "↓ Download & use in this row"; // primary action -- returns to the row that opened it (§7c)
    if (missingFile) {
      btn.disabled = true;
      btn.title = "No downloadable file for this version.";
    } else if (job) {
      btn.disabled = true;
      btn.title = "Another download is already running.";
    }
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (missingFile) {
        return;
      }
      actionMessage = null;
      const subfolder = destInput ? subfolderFromDestinationField(destInput.value, kind) : "";
      const civitaiMeta = {
        model_id: result.model_id, version_id: view.primary_version_id, name: view.name,
        type: result.type, base_model: view.base_model, tags: result.tags, triggers: view.triggers,
      };
      const previewCandidates = pickThumbCandidates(view.images, currentLevel());
      const resp = await startDownloadJob({
        kind, subfolder, filename: view.file_name, downloadUrl: view.download_url, sizeKb: view.size_kb,
        key: rKey, civitaiMeta, previewUrl: previewCandidates.length > 0 ? previewCandidates[0] : null,
      }, pollIntervalMs);
      if (resp.reason !== "started") {
        actionMessage = downloadStartMessage(resp);
        logSummary("LoRA search", `download NOT started: ${view.file_name} (${resp.reason})`);
      } else {
        logSummary("LoRA search", `download started: ${view.file_name} (${kind})`);
      }
      render();
    });
    wrap.appendChild(btn);
    if (actionMessage) {
      const msgEl = el(d, "div", "wtn-cs-cardmsg");
      msgEl.textContent = actionMessage;
      wrap.appendChild(msgEl);
    }
    return wrap;
  }

  function render() {
    host.innerHTML = "";
    const built = buildModelDetailView({
      doc, layout: "vertical", result, versionId: currentVersionId, browsingLevel: currentLevel(),
      detail: detailState, buildActionEl: buildAction,
      onVersionChange: (id) => {
        currentVersionId = id;
        if (typeof onVersionPersist === "function") {
          onVersionPersist(id);
        }
        loadDetail();
      },
      onBack: () => handle.close(),
      thumbRetryBackoffMs,
    });
    host.appendChild(built.el);
  }

  async function loadDetail() {
    // Keep whatever MODEL description is already known while a version
    // switch re-fetches -- it doesn't change per version, so there's no
    // reason to flash it away and back.
    detailState = {
      status: "loading", gallery: [],
      modelDescription: detailState.modelDescription,
      modelDescriptionChecked: detailState.modelDescriptionChecked,
    };
    render();
    const resp = await fetchModelDetail(result.model_id, currentVersionId);
    if (closed) {
      return; // panel closed while the fetch was in flight -- discard silently
    }
    detailState = {
      status: resp.reason === "found" ? "loaded" : "error",
      modelDescription: resp.model_description,
      modelDescriptionChecked: resp.model_description_checked,
      versionDescription: resp.version_description,
      gallery: Array.isArray(resp.gallery) ? resp.gallery : [],
    };
    render();
  }

  render();
  loadDetail();

  const unsubscribe = subscribeDownloadState(() => render());

  const handle = openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, panel, "right", () => {
    closed = true;
    unsubscribe();
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }, "wtn-dv-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;

  return handle;
}
