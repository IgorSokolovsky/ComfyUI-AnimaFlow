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
 * base model / sort / period / NSFW all present, laid out as a compact row
 * of `<select>` pills rather than the modal's rail — "layout differs,
 * feature set does not"), the `public_only`/`rate_limited`/`offline` search
 * states, the four RESULT-CARD states (§7c-iii: installed / downloading /
 * available / gated, with the exact labels that section settles), the
 * editable destination folder (§ decision 5, defaulting to this kind's own
 * `models/<kind>` root), and the download/poll/cancel flow (§9: one job at a
 * time, server-side, never blocking a graph run).
 *
 * Explicitly OUT of scope (task brief, §7c-ii): the per-result VERTICAL info
 * panel with the community gallery, and `notfound`'s search-by-name link —
 * both land in the next slice. A card click in the list below is therefore
 * INERT (no vertical info panel to open yet) beyond its own download action.
 *
 * ## Filters are remembered USER-WIDE, never in the node's state blob
 *
 * `../shared/settings.mjs`'s `CIVITAI_SEARCH_BASE_MODEL`/`_SORT`/`_PERIOD`/
 * `_NSFW` ids (§7c-i: "remembered user-wide... not in the node's state
 * blob") — read on open, written back the moment the user changes one, so
 * every mount of this panel (this node, a future Loader Panel, the M2b
 * toolbar modal) opens with the SAME filters. This module reads/writes those
 * settings itself (unlike `model_picker.mjs`/`model_info.mjs`'s
 * `hideExtension`/`civitaiEnabled` convention of taking such things as a
 * caller-supplied parameter) — there is no per-node override for a browsing
 * preference like this at all, so there is nothing for a caller to inject;
 * `js/shared/settings.mjs` is itself track-agnostic (imports nothing of
 * ours), so reaching into it directly here does not violate the layering
 * guard, which only ever forbids a `lora_*` import.
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
import { searchModels, startDownload, downloadProgress, cancelDownload, invalidateList } from "./civitai_api.mjs";
import {
  getSetting,
  setSetting,
  SETTING_IDS,
  SETTING_DEFAULTS,
  CIVITAI_SEARCH_BASE_MODEL_OPTIONS,
  CIVITAI_SEARCH_SORT_OPTIONS,
  CIVITAI_SEARCH_PERIOD_OPTIONS,
} from "../shared/settings.mjs";

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

.wtn-cs-search-wrap { position: relative; margin-bottom: 7px; }
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
.wtn-cs-nsfw { display: inline-flex; align-items: center; gap: 4px; font-family: var(--wtn-font-mono, monospace); font-size: 10px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); cursor: pointer; }
.wtn-cs-nsfw input { cursor: pointer; }

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
}
.wtn-cs-thumb-ph {
  width: 16px; height: 16px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-image: url("${IMAGE_PLACEHOLDER_SVG}"); -webkit-mask-image: url("${IMAGE_PLACEHOLDER_SVG}");
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
}
.wtn-cs-thumb-gated { color: var(--wtn-warn, ${TOKENS.warn}); font-size: 15px; }
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
 */
export async function startDownloadJob({ kind, subfolder = "", filename, downloadUrl, sizeKb, key }, pollIntervalMs = 800) {
  if (_activeDownload) {
    return { reason: "busy", message: "Another download is already running — wait for it to finish.", job_id: null };
  }
  const resp = await startDownload({ kind, subfolder, filename, downloadUrl, sizeKb });
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

function buildThumb(doc, gated) {
  const thumb = el(doc, "div", "wtn-cs-thumb");
  if (gated) {
    const lock = el(doc, "span", "wtn-cs-thumb-gated");
    lock.textContent = "\u{1F512}"; // 🔒 -- Civitai's own gate glyph, matching the mockup's padlock
    thumb.appendChild(lock);
  } else {
    // No thumbnail data exists yet -- `civitai_search.parse_search_response`
    // doesn't carry an image URL today (Civitai's own search endpoint result
    // has no field for one wired here); a neutral placeholder, never a
    // broken-image icon, matching `model_picker.mjs`'s own "no preview"
    // convention (§1a-v).
    thumb.appendChild(el(doc, "span", "wtn-cs-thumb-ph"));
  }
  return thumb;
}

/**
 * Opens the Civitai search panel, anchored to `anchorEl`. Kind-LOCKED (§7c:
 * a node-embedded picker) -- `kind` never changes for the life of one open
 * panel.
 *
 * @param {{ctx: {doc, getCanvasEl}, anchorEl: Element, kind: string,
 *   ownerKey?: string, onClose?: () => void, pollIntervalMs?: number}} opts
 *   `pollIntervalMs` (default 800ms in real use) is test-only -- threaded
 *   straight through to `startDownloadJob` so a test can drive the download
 *   poll loop deterministically instead of waiting on real 800ms timers.
 * @returns {object|null} the overlay handle, or `null` if this call just
 *   TOGGLED an already-open panel closed (mirrors `model_picker.mjs`'s own
 *   `openModelPicker` convention).
 */
export function openCivitaiSearch({ ctx, anchorEl, kind, ownerKey, onClose, pollIntervalMs = 800 } = {}) {
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

  const searchWrap = el(doc, "div", "wtn-cs-search-wrap");
  searchWrap.appendChild(el(doc, "span", "wtn-cs-search-icon"));
  const search = el(doc, "input", "wtn-cs-search");
  search.type = "text";
  search.placeholder = "Search Civitai…";
  search.spellcheck = false;
  searchWrap.appendChild(search);
  pinned.appendChild(searchWrap);

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
    nsfw: !!getSetting(SETTING_IDS.CIVITAI_SEARCH_NSFW, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_NSFW]),
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

  const nsfwLabel = el(doc, "label", "wtn-cs-nsfw");
  const nsfwCheckbox = el(doc, "input");
  nsfwCheckbox.type = "checkbox";
  nsfwCheckbox.checked = currentFilters.nsfw;
  nsfwCheckbox.addEventListener("click", (e) => e.stopPropagation());
  nsfwCheckbox.addEventListener("change", () => {
    currentFilters.nsfw = nsfwCheckbox.checked;
    setSetting(SETTING_IDS.CIVITAI_SEARCH_NSFW, currentFilters.nsfw);
    runSearch({ resetCursor: true });
  });
  const nsfwText = el(doc, "span");
  nsfwText.textContent = "NSFW";
  nsfwLabel.appendChild(nsfwCheckbox);
  nsfwLabel.appendChild(nsfwText);
  filters.appendChild(nsfwLabel);
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
  const cardMessages = new Map(); // resultKey -> a readable line under that card

  function renderActive() {
    activeHost.innerHTML = "";
    const job = getActiveDownloadState();
    // Only show the PERSISTENT banner when the active job's own card is NOT
    // already visible in the current results list -- otherwise the card
    // itself (§7c-iii's "downloading" state, below) already shows the exact
    // same progress, and duplicating it here would just be noise.
    if (!job || results.some((r) => resultKey(r) === job.key)) {
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
    const card = el(doc, "div", "wtn-cs-card");
    const rKey = resultKey(result);
    const job = getActiveDownloadState();
    const state = resultCardState(result, job, _sessionGatedKeys);

    card.appendChild(buildThumb(doc, state === "gated"));

    const meta = el(doc, "div", "wtn-cs-meta");
    const title = el(doc, "div", "wtn-cs-title");
    title.textContent = result.name || "(untitled)";
    title.title = result.name || "";
    meta.appendChild(title);

    // Base model + download count on their own row (owner, 2026-07-30): the
    // base model used to be folded into the subtitle's joined text, where it
    // "didn't register" scanning a list -- now a standalone chip, reusing
    // `js/shared/theme.css`'s own `.wtn-chip` vocabulary (a new `--accent`
    // variant, muted per that file's own precedent -- see its doc comment).
    // Omitted entirely (never a placeholder) when genuinely unknown, same
    // "omit rather than invent" rule `resultBaseModel` itself documents.
    const metaRow = el(doc, "div", "wtn-cs-metarow");
    const baseModel = resultBaseModel(result);
    if (baseModel) {
      const chip = el(doc, "span", "wtn-chip wtn-chip--accent wtn-cs-chip");
      chip.textContent = baseModel;
      chip.title = baseModel;
      metaRow.appendChild(chip);
    }
    const sub = el(doc, "div", "wtn-cs-sub");
    sub.textContent = state === "gated" ? gatedSubtitle() : resultSubtitle(result);
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
    if (msg) {
      const msgEl = el(doc, "div", "wtn-cs-cardmsg");
      msgEl.textContent = msg;
      meta.appendChild(msgEl);
    }
    card.appendChild(meta);

    if (state === "installed") {
      const badge = el(doc, "span", "wtn-cs-action wtn-cs-action-installed");
      badge.textContent = "✓ installed"; // ✓ installed -- NOT the mockup's "have" (owner, §7c-iii)
      card.appendChild(badge);
    } else if (state === "downloading") {
      const pct = downloadPercent(job.bytes, job.total);
      const pctLabel = el(doc, "span", "wtn-cs-sub");
      pctLabel.style.marginRight = "4px";
      pctLabel.textContent = pct == null ? "…" : `${pct}%`;
      card.appendChild(pctLabel);
      const cancelBtn = el(doc, "button", "wtn-cs-action wtn-cs-action-cancel");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelActiveDownloadJob();
      });
      card.appendChild(cancelBtn);
    } else if (state === "gated") {
      const btn = el(doc, "button", "wtn-cs-action wtn-cs-action-gated");
      btn.type = "button";
      btn.textContent = "key required"; // amber -- see .wtn-cs-action-gated (§7c-iii)
      btn.disabled = true;
      btn.title = "Add a Civitai API key in Settings → AnimaFlow → Controls to download this file.";
      card.appendChild(btn);
    } else {
      const btn = el(doc, "button", "wtn-cs-action");
      btn.type = "button";
      btn.textContent = "↓ Download"; // ↓ Download -- NOT the mockup's "get" (owner, §7c-iii)
      if (job) {
        // A DIFFERENT job is already running in this panel/process -- never
        // silently queue a second one (task brief); disable rather than let
        // the click round-trip to a guaranteed `busy`.
        btn.disabled = true;
        btn.title = "Another download is already running.";
      }
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        cardMessages.delete(rKey);
        const subfolder = subfolderFromDestinationField(destInput.value, kind);
        const resp = await startDownloadJob({
          kind, subfolder, filename: result.file_name, downloadUrl: result.download_url, sizeKb: result.size_kb, key: rKey,
        }, pollIntervalMs);
        if (resp.reason !== "started") {
          cardMessages.set(rKey, downloadStartMessage(resp));
        }
        renderList();
      });
      card.appendChild(btn);
    }

    return card;
  }

  function renderList() {
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
   */
  async function runSearch({ resetCursor = true } = {}) {
    reconcileGatedKeysOnApiKeySignature(
      apiKeySignature(getSetting(SETTING_IDS.CIVITAI_API_KEY, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_API_KEY])),
      _sessionGatedKeys,
    );
    if (resetCursor) {
      nextCursor = null;
      loadingMore = false;
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
    const resp = await searchModels(kind, {
      query: search.value.trim(),
      baseModel: currentFilters.baseModel,
      sort: currentFilters.sort,
      period: currentFilters.period,
      nsfw: currentFilters.nsfw,
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
  const SEARCH_DEBOUNCE_MS = 400;
  let debounceTimer = null;
  search.addEventListener("input", () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => runSearch({ resetCursor: true }), SEARCH_DEBOUNCE_MS);
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
   */
  function onDownloadStateChange() {
    const job = getActiveDownloadState();
    if (job && job.status && job.status !== "downloading" && job.status !== "cancelling") {
      const finishedResult = results.find((r) => resultKey(r) === job.key);
      if (job.status === "ok") {
        // The atomic-rename guarantee (`download.py`'s own top doc comment)
        // means "ok" IS "the file is genuinely on disk now" -- flip this
        // card straight to the "installed" state without waiting on a fresh
        // search, matching the picker's own instant-refresh expectation
        // (task brief, deliverable 4).
        if (finishedResult) {
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
        if (finishedResult) {
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
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
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
