/**
 * civitai_modal.mjs — the M2b toolbar MODAL: the third, UNSCOPED mount of
 * the one shared Civitai browser (`docs/lora-loader-design.md` §7c/§7c-i/
 * "The modal"). The other two mounts (the LoRA Loader's node picker and the
 * Loader Panel, M3) are kind-LOCKED and live in `civitai_search.mjs`; this
 * one answers to nobody -- it searches every supported model type at once
 * and downloads to whichever folder a result's own type resolves to,
 * "never guess a folder" (§ "Downloads that can land anywhere").
 *
 * ## Reuse, not a rewrite -- what comes from where
 *
 * This file is deliberately thin. Every mechanic that already exists is
 * IMPORTED, never copied (task brief: "extract what you need into shared
 * code rather than copying it... do not rewrite the anchored panel"):
 *
 *   - `../shared/civitai_thumb.mjs` -- the level-aware thumbnail candidate
 *     picker, retry-then-advance state machine, and loading skeleton (§7c-iv).
 *   - `./civitai_api.mjs`'s `searchUnscoped` -- the one genuinely NEW client
 *     function this feature needed (no existing search call can omit `kind`).
 *   - `./civitai_search.mjs` -- the picker's own pure result helpers
 *     (`resolveVersionView`/`resultCardState`/`resultBaseModel`/
 *     `resultSubtitle`/`gatedSubtitle`/`resultKey`/`appendDedupedResults`/
 *     `searchReasonMessage`/`downloadStartMessage`/`downloadTerminalMessage`),
 *     its module-level DOWNLOAD-JOB SINGLETON (`startDownloadJob`/
 *     `cancelActiveDownloadJob`/`subscribeDownloadState`/
 *     `getActiveDownloadState`) -- so "one download at a time, server-side"
 *     (§9) holds ACROSS every surface, not just within one -- and its
 *     session-gated-key learning (`markResultGated`/`apiKeySignature`/
 *     `reconcileGatedKeysOnApiKeySignature`/`sessionGatedKeys`, BUG F). None
 *     of `civitai_search.mjs`'s own behaviour changes because this file
 *     imports from it; that module keeps working exactly as before,
 *     unmodified in structure (`sessionGatedKeys` is the one small ADDITIVE
 *     export this feature needed, documented at its own definition).
 *
 * `civitai_search.mjs` is itself one of the track-agnostic reuse-boundary
 * files (`test_model_picker.mjs`'s `GUARDED_FILES`, extended to include this
 * file too) -- neither it nor this file may ever import a `lora_*` module.
 *
 * ## What this pass builds, and what it deliberately does not
 *
 * Toolbar button + command (mounted from `index.js`, this file lazily
 * `import()`ed only on click/command), the 90%-viewport modal SHELL (scrim +
 * panel, full-bleed geometry NOT copied from the Rule Builder -- see
 * `openCivitaiModal`'s own doc comment), the filter RAIL (§7c-i:
 * `<select>`-adds-a-chip for base model/model type, plain `<select>` for
 * sort/period/level), the result GRID (reusing the shared thumbnail
 * machinery), and download.
 *
 * Explicitly OUT of scope, a genuinely separate second pass (task brief):
 * the master→detail swap (a result card click is INERT here beyond its own
 * download action -- no version picker on the card either, since version
 * selection belongs to the detail view that doesn't exist yet), the
 * community-images gallery, and copy-prompt.
 *
 * ## The `kind: null` state is a SAFETY NET, kept deliberately minimal
 *
 * (Owner direction, 2026-07-31, mid-build.) The backend derives a `kind` per
 * result (our folder for that Civitai model type, or `null` when we have
 * none of the three) -- a `null`-kind result never renders a download
 * button, full stop, because guessing a folder (writing a Workflow JSON into
 * `models/loras/`) is the one failure this feature must never produce. But
 * the eventual plan is to TRIM the Model Type filter's own options to a
 * supported set, making this state rare -- so this pass renders it as one
 * quiet, honest line (`NOT_INSTALLABLE_MESSAGE`) where the button would be:
 * no explanatory panel, no "request support" affordance, no special card
 * styling, and — per the same direction — **no client-side filtering of
 * results by kind**. `MODEL_TYPE_OPTIONS` (below) is a plain top-level
 * constant for exactly this reason: it is going to be trimmed to the
 * supported set shortly, and keeping it in ONE place (never inlined into
 * the rail-rendering code) is what makes that a one-line change later.
 *
 * ## Integration note -- the backend contract this file is written against
 *
 * **Landed** (`a6bc45b`): `kind` is optional on the SEARCH path only (its
 * absence is the "search every supported type" signal `searchUnscoped`
 * sends), every result carries its own derived `kind` (our folder for that
 * Civitai model type, or `null` when we have none -- `resultKind`'s own doc
 * comment), and `base_model`/`types` both accept MULTIPLE values as repeated
 * query-string params under their existing singular keys (`base_model`,
 * `types` -- never a comma-joined or invented-plural form; `civitai_api.mjs`'s
 * own `searchUnscoped` doc comment has the wire-format detail). Every
 * result-shape read here (`resultKind`, `resolveVersionView`, etc.) still
 * degrades to a safe "unknown" rather than throwing against anything
 * malformed or from an older backend build -- that defensive read was never
 * specific to the backend gap this note used to describe, and stays useful
 * regardless.
 */

import {
  resultKey,
  resolveVersionView,
  resultCardState,
  resultBaseModel,
  resultSubtitle,
  gatedSubtitle,
  appendDedupedResults,
  searchReasonMessage,
  downloadStartMessage,
  downloadTerminalMessage,
  downloadPercent,
  subscribeDownloadState,
  getActiveDownloadState,
  startDownloadJob,
  cancelActiveDownloadJob,
  markResultGated,
  sessionGatedKeys,
  apiKeySignature,
  reconcileGatedKeysOnApiKeySignature,
  DEFAULT_ROOT_DISPLAY,
  SCROLL_LOAD_MORE_THRESHOLD_PX,
} from "./civitai_search.mjs";
import { searchUnscoped } from "./civitai_api.mjs";
import {
  getSetting,
  setSetting,
  SETTING_IDS,
  SETTING_DEFAULTS,
  CIVITAI_SEARCH_SORT_OPTIONS,
  CIVITAI_SEARCH_PERIOD_OPTIONS,
  CIVITAI_SEARCH_LEVEL_OPTIONS,
  CIVITAI_SEARCH_BASE_MODEL_OPTIONS,
} from "../shared/settings.mjs";
import {
  levelLabelToInt,
  pickThumbCandidates,
  thumbState,
  attachThumbCandidate,
  THUMB_RETRY_BACKOFF_MS,
  THUMB_SKELETON_CLASS,
  THUMB_SKELETON_CSS,
} from "../shared/civitai_thumb.mjs";
// C/E (task brief, 2026-07-31): route this surface's own diagnostic output
// (search issued/its result count, download start/finish) through the
// pack-wide "Console logging" level -- see that module's own top doc
// comment. "Civitai browser" is this surface's own tag (task brief: "make
// each line identify which surface it came from") -- distinct from the
// node-embedded picker's own "LoRA search" tag.
import { logSummary, logDebug } from "../shared/console_log.mjs";

const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";
const STYLE_ID = "wtn-cm-style";

// Mirrors js/shared/theme.mjs's TOKENS exactly -- same "every render module
// keeps its own hardcoded fallback copy" convention `civitai_search.mjs`/
// `model_picker.mjs`/`model_info.mjs` already follow.
const TOKENS = {
  bg: "#0e1116",
  surface: "#151a21",
  surface2: "#1b212a",
  line: "#28303b",
  ink: "#e7ecf3",
  inkDim: "#93a0b1",
  inkFaint: "#5f6c7d",
  accent: "#2dd4bf",
  accentDeep: "#14b8a6",
  onAccent: "#062420",
  ok: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
};

// The "no image" glyph -- same picture-frame silhouette as `civitai_search.
// mjs`'s own `IMAGE_PLACEHOLDER_SVG` (a duplicated hardcoded copy, matching
// this file's own "every render module keeps its own copy" convention,
// above), sized for THIS surface's own, much larger grid thumb box below
// rather than the 40px card's 16px icon (owner-reported, 2026-07-31: "the
// placeholder itself is near-invisible in the modal's large box").
const IMAGE_PLACEHOLDER_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2H4zm0 2h16v9.59l-3.79-3.8a1 1 0 00-1.42 0L11 15.59l-2.29-2.3a1 1 0 00-1.42 0L4 16.59V6zm4 2a2 2 0 100 4 2 2 0 000-4z'/%3E%3C/svg%3E";

// ---------------------------------------------------------------------------
// Pure -- no DOM, no `doc`/`window` reference anywhere below. Directly
// testable under plain `node` (`test_civitai_modal.mjs`).
// ---------------------------------------------------------------------------

/**
 * The "Filter by Model Type" rail options -- a plain, swappable, TOP-LEVEL
 * constant (owner direction, 2026-07-31: "build the Model Type chip options
 * from a list you can swap out in one place... that list is going to be
 * trimmed to a supported set shortly"). Civitai's own ~19 model types
 * (`docs/lora-loader-design.md` §7c-i's own enumeration of their chip grid),
 * kept as the full catalogue for now -- narrowing this to only the types
 * this pack can actually install (currently three folders: LoRA,
 * Checkpoint, UNet-ish) is a SEPARATE, not-yet-settled decision (the owner's
 * own words: "we will see when we get to it"), so this pass does not guess
 * at a subset. Changing what's offered is exactly one edit to this array --
 * never inlined into `buildChipFilterSection`'s own rendering code.
 */
export const MODEL_TYPE_OPTIONS = [
  "Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion", "Hypernetwork",
  "AestheticGradient", "Controlnet", "Detection", "MotionModule", "Other",
  "Poses", "TextEncoder", "Embedding", "UNet", "Upscaler", "VAE", "VLM",
  "Wildcards", "Workflows",
];

/** The honest, minimal line a `kind: null` result shows in place of a
 * download button (owner direction, 2026-07-31) -- exported so both this
 * file and its test can share the exact wording rather than a test
 * re-guessing what string to look for. */
export const NOT_INSTALLABLE_MESSAGE = "Not a type this pack installs.";

/**
 * The backend's own derived `kind` for a search result (our folder for that
 * Civitai model type -- `"loras"`/`"checkpoints"`/`"unet"` -- or `null` when
 * there's none of the three, `docs/lora-loader-design.md`'s "the modal is
 * unscoped" section). `null` for anything not a genuinely non-empty string
 * -- garbage, absent (today's backend, which doesn't send this key yet --
 * see this file's own top doc comment), or an explicit `null` all mean the
 * same thing here: "never guess a folder." Never throws.
 */
export function resultKind(result) {
  if (!result || typeof result !== "object") {
    return null;
  }
  return typeof result.kind === "string" && result.kind ? result.kind : null;
}

/** Where a downloadable result will land (task brief: "a downloadable
 * result shows where it will land, since the user did not choose a folder
 * this time") -- reuses `civitai_search.mjs`'s own `DEFAULT_ROOT_DISPLAY`
 * rather than a second copy. `""` for a falsy/unmapped kind (never rendered
 * -- callers only call this once `resultKind` has already confirmed a real
 * kind). */
export function destinationLabelForKind(kind) {
  if (!kind) {
    return "";
  }
  return `→ ${DEFAULT_ROOT_DISPLAY[kind] || `models/${kind}`}/`; // → models/<kind>/
}

/**
 * Appends `value` to `list` if it isn't already present, returning a NEW
 * array (never mutates `list`) -- the rail's own "select adds a chip" rule
 * (§7c-i): "a duplicate selection is a no-op." Garbage/non-array `list`
 * degrades to treating it as empty; a falsy/blank `value` is a no-op (the
 * select's own "Add a..." placeholder option, value `""`, must never become
 * a chip). Never throws.
 */
export function addFilterValue(list, value) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || arr.includes(v)) {
    return arr;
  }
  arr.push(v);
  return arr;
}

/** Removes `value` from `list`, returning a NEW array (never mutates
 * `list`) -- the rail's own `✕` (§7c-i: "every chip carries a ✕... the rule
 * is the same -- the ✕ means you put this here"). Garbage/non-array `list`
 * degrades to `[]`. Never throws. */
export function removeFilterValue(list, value) {
  const arr = Array.isArray(list) ? list : [];
  return arr.filter((x) => x !== value);
}

/** Parses a rail multi-value filter setting's own stored representation (a
 * JSON-array-of-strings STRING -- `settings.mjs`'s own `CIVITAI_MODAL_
 * BASE_MODELS`/`CIVITAI_MODAL_MODEL_TYPES` doc comment explains why it's a
 * string, not a native array setting) back into a plain `string[]`. Tolerates
 * an ALREADY-parsed array too (a test, or a future settings API that stops
 * round-tripping through JSON) -- never throws on garbage: a non-string/
 * non-array value, unparseable JSON, or parsed JSON that isn't an array all
 * degrade to `[]`. Every entry is filtered to non-empty strings, same
 * "tolerant, never trust the stored shape" discipline as every other
 * `SETTING_DEFAULTS`-backed read in this pack. */
export function parseStoredList(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((v) => typeof v === "string" && v);
  }
  if (typeof raw !== "string" || !raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string" && v) : [];
  } catch {
    return [];
  }
}

/** The write-side counterpart to `parseStoredList` -- always a JSON array
 * string, filtered to non-empty strings, never throws. */
export function serializeList(list) {
  const arr = Array.isArray(list) ? list.filter((v) => typeof v === "string" && v) : [];
  return JSON.stringify(arr);
}

// ---------------------------------------------------------------------------
// CSS -- 90% viewport, centred, over a scrim (deliberately NOT the Rule
// Builder's own full-bleed `position: fixed; inset: 0` geometry -- see
// `openCivitaiModal`'s own doc comment for why that distinction is load-
// bearing, not a style nit).
// ---------------------------------------------------------------------------

const CSS = `
.wtn-cm-scrim {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(6, 8, 11, 0.72);
  display: flex; align-items: center; justify-content: center;
}
.wtn-cm-panel {
  width: 90vw; height: 90vh; max-width: 90vw; max-height: 90vh;
  background: var(--wtn-bg, ${TOKENS.bg}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: var(--wtn-radius-lg, 14px); box-shadow: var(--wtn-shadow, 0 24px 60px rgba(0,0,0,.6));
  display: flex; flex-direction: column; overflow: hidden;
  font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-cm-head {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px; flex: none;
  border-bottom: 1px solid var(--wtn-line, ${TOKENS.line}); font-weight: 650; font-size: 14px;
}
.wtn-cm-close { margin-left: auto; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 16px; background: none; border: none; }
.wtn-cm-close:hover { color: var(--wtn-ink, ${TOKENS.ink}); }

.wtn-cm-body { flex: 1 1 auto; display: flex; min-height: 0; }

.wtn-cm-rail {
  width: 216px; flex: none; overflow-y: auto; padding: 10px;
  display: flex; flex-direction: column; gap: 14px;
  border-right: 1px solid var(--wtn-line, ${TOKENS.line});
}
/* D1 (REVERSED 2026-07-31, owner, docs/lora-loader-design.md section 7c-i's
   own "no card/box chrome per section" correction): each rail section used
   to be its own bordered, filled '.wtn-collapse' panel -- five of those
   stacked read as five separate widgets, not one rail. This was FIRST fixed
   by scoping a reset onto '.wtn-collapse' itself (still a <details>, just
   unstyled) -- D5, immediately below, replaces that <details>/<summary>
   entirely with a plain heading, so this rule no longer has anything to
   match; kept here, as dead weight, ONLY because D5's own "record the
   reversal, don't delete the trail" convention (below) applies to this one
   too -- '.wtn-collapse' itself (js/shared/theme.css) was never touched,
   scoped or otherwise; every OTHER consumer (the Rule Builder, etc.) keeps
   its own look unchanged regardless. */
/* D5 (owner, 2026-07-31, approved: "remove collapse and use plain heading in
   the browser"): D1 above already established "no card/box chrome" by
   scoping a reset onto the shared '.wtn-collapse' <details>/<summary> --
   faithful to §7c-i's own "Civitai's own rail is the reference for
   structure -- collapsible sections", which earns its place on Civitai's OWN
   rail (19 model-type chips under one heading) but not on ours, where every
   section holds exactly one <select>: collapsing a single control saves
   ~30px and costs a click for nothing. This is a SECOND, independent
   reversal of that same §7c-i clause -- not a restoration of D1 (D1's own
   "no chrome" conclusion stands; this instead drops the disclosure widget
   the chrome used to live inside). ⚠️ Recorded here so a later pass never
   "fixes" this back to collapsible sections as though the triangle's
   disappearance were a regression -- it is deliberate, matching D2/D3/D4's
   own "reversal, not an oversight" convention immediately below. '.wtn-cm-
   rail-heading' is a plain, non-interactive label; '.wtn-collapse' itself
   (js/shared/theme.css) is UNTOUCHED -- other surfaces (the Rule Builder,
   etc.) keep using it exactly as before; only this rail stops. */
.wtn-cm-rail-section { display: flex; flex-direction: column; }
.wtn-cm-rail-heading {
  font-size: 12px; font-weight: 650; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  margin: 0 0 6px;
}
.wtn-cm-rail select { width: 100%; margin-top: 6px; }
.wtn-cm-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.wtn-cm-chip { display: inline-flex; align-items: center; gap: 5px; }
.wtn-cm-chip-x { cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-weight: 700; }
.wtn-cm-chip-x:hover { color: var(--wtn-bad, ${TOKENS.bad}); }

.wtn-cm-main { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.wtn-cm-searchbar { padding: 10px 16px; flex: none; border-bottom: 1px solid var(--wtn-line, ${TOKENS.line}); display: flex; flex-direction: column; gap: 6px; }
.wtn-cm-search { width: 100%; }
.wtn-cm-warn { color: var(--wtn-warn, ${TOKENS.warn}); font-size: 12px; }
.wtn-cm-bad { color: var(--wtn-bad, ${TOKENS.bad}); font-size: 12px; }
.wtn-cm-info { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); font-size: 12px; }
.wtn-cm-active { display: flex; align-items: center; gap: 8px; font-size: 12px; padding-top: 4px; }
.wtn-cm-bar { position: relative; flex: 1 1 auto; height: 6px; background: var(--wtn-surface, ${TOKENS.surface}); border-radius: 4px; overflow: hidden; min-width: 60px; }
.wtn-cm-bar i { position: absolute; inset: 0; width: 0; background: var(--wtn-accent, ${TOKENS.accent}); display: block; }

.wtn-cm-gridwrap { flex: 1 1 auto; overflow-y: auto; padding: 14px 16px; }
.wtn-cm-empty { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 12.5px; padding: 20px 4px; }
.wtn-cm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
.wtn-cm-card {
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: 8px;
}
.wtn-cm-thumb {
  position: relative; width: 100%; aspect-ratio: 1 / 1; border-radius: 6px; overflow: hidden;
  background: var(--wtn-surface, ${TOKENS.surface}); display: flex; align-items: center; justify-content: center;
}
.wtn-cm-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* The 🔒/🙈 glyphs (locked/gated) are real text content (\`buildThumb\`) --
   20px reads clearly against this box's own aspect-ratio-1/1 size (much
   bigger than the 40px search card's 15px). \`.wtn-cm-thumb-ph\`, unlike
   those two, used to carry NO glyph at all -- an empty \`<span>\` with only
   this rule's \`color\`/\`font-size\`, neither of which does anything without
   actual content (owner-reported, 2026-07-31: "why some images are not
   shown?" -- several cards were a genuinely blank box, not merely a small
   icon). It now gets the SAME picture-frame mask \`.wtn-cs-thumb-ph\` uses,
   sized for this box rather than the 40px card's 16px. */
.wtn-cm-thumb-locked, .wtn-cm-thumb-gated { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 20px; }
.wtn-cm-thumb-ph {
  width: 34px; height: 34px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-image: url("${IMAGE_PLACEHOLDER_SVG}"); -webkit-mask-image: url("${IMAGE_PLACEHOLDER_SVG}");
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
  mask-position: center; -webkit-mask-position: center;
}
${THUMB_SKELETON_CSS}
.wtn-cm-title { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtn-cm-metarow { display: flex; flex-wrap: wrap; gap: 4px; }
.wtn-cm-chip-tag { font-family: var(--wtn-font-mono, monospace); font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-cm-sub { font-size: 11px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-cm-cardmsg { font-size: 11px; color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-cm-actioncol { display: flex; flex-direction: column; gap: 4px; margin-top: auto; }
.wtn-cm-dest { font-size: 10.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-cm-nokind { font-size: 11px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; }
.wtn-cm-action { font: 12px var(--wtn-font-ui, inherit); font-weight: 600; padding: 5px 10px; border-radius: 7px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); cursor: pointer; }
.wtn-cm-action:disabled { cursor: default; opacity: .6; }
.wtn-cm-action-installed { background: transparent; border-color: rgba(74,222,128,.4); color: var(--wtn-ok, ${TOKENS.ok}); }
.wtn-cm-action-gated { background: var(--wtn-warn, ${TOKENS.warn}); color: #201400; }
.wtn-cm-action-cancel { background: transparent; border-color: rgba(248,113,113,.4); color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-cm-actioncol-row { display: flex; align-items: center; gap: 8px; }
`;

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

export function injectModalStyles(doc) {
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
// Filter rail builders (DOM).
// ---------------------------------------------------------------------------

function buildSingleSelectRow(doc, options, current, onChange, labelForValue) {
  const sel = el(doc, "select", "wtn-select");
  for (const value of options) {
    const opt = el(doc, "option");
    opt.value = value;
    opt.textContent = labelForValue ? labelForValue(value) : value;
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
 * A "select adds a chip" multi-value filter (§7c-i) -- the rail's own
 * divergence from Civitai's ~19-chip grid. `getCurrent()`/`setCurrent(list)`
 * read/write the caller's own state (never held here) so this stays a pure
 * DOM builder with no state of its own; `onChanged()` is called after every
 * add/remove so the caller can re-run the search. Returns `{ el, refresh }`
 * -- `refresh()` re-renders both the chip row AND the `<select>`'s own
 * option labels (D3, below), without rebuilding the `<select>` element
 * itself (its own identity/listeners survive every refresh).
 *
 * **D2 (REVERSED 2026-07-31, owner, from the built rail) -- an empty group
 * renders NOTHING**, not a faint "any" line. This previously matched §7c-i's
 * own "an empty group shows a faint `any` so 'no filter' is stated rather
 * than blank" -- the owner's own words override it: the `<select>` directly
 * above already reads `"Add a base model…"`/`"Add a model type…"`, so `any`
 * only restates what the control already says, for a second line of text per
 * section that adds nothing. Do NOT "fix" this back to rendering `any` as a
 * regression fix later -- it is deliberate, not an oversight (the design doc
 * itself records the same reversal).
 *
 * **D3 -- the OPEN `<select>` shows a `✓` against already-selected values.**
 * A native `<select>` cannot render arbitrary markup in one of its own
 * `<option>`s, so the ✓ is a plain text PREFIX on that option's own label
 * (`"✓ SDXL 1.0"`), computed fresh every `refresh()` call (selection changes
 * on every add/remove) -- the underlying `value` attribute is never touched,
 * so selecting an already-selected value stays the existing no-op
 * (`addFilterValue`'s own dedupe). `optionEls` (a `value -> <option>` map,
 * built once) is what lets `refresh()` re-label the right elements without
 * rebuilding the `<select>` -- rebuilding it on every chip add/remove would
 * also destroy the user's mid-interaction scroll position within the
 * dropdown's own option list.
 */
function buildChipFilterSection(doc, { placeholder, options, getCurrent, setCurrent, onChanged }) {
  const wrap = el(doc, "div");
  const sel = el(doc, "select", "wtn-select");
  const placeholderOpt = el(doc, "option");
  placeholderOpt.value = "";
  placeholderOpt.textContent = placeholder;
  sel.appendChild(placeholderOpt);
  const optionEls = new Map(); // value -> <option> (D3 -- relabeled on every refresh)
  for (const value of options) {
    const opt = el(doc, "option");
    opt.value = value;
    opt.textContent = value;
    sel.appendChild(opt);
    optionEls.set(value, opt);
  }
  sel.value = "";
  sel.addEventListener("click", (e) => e.stopPropagation());
  const chipsHost = el(doc, "div", "wtn-cm-chips");

  function refresh() {
    const list = getCurrent();
    const selected = new Set(list);
    // D3 -- relabel every option to reflect CURRENT selection, every refresh.
    for (const [value, opt] of optionEls) {
      opt.textContent = selected.has(value) ? `✓ ${value}` : value;
    }

    chipsHost.innerHTML = "";
    // D2 -- an empty group renders nothing at all (see this function's own
    // top doc comment for why this reverses the design doc's earlier rule).
    if (!list.length) {
      return;
    }
    for (const value of list) {
      const chip = el(doc, "span", "wtn-chip wtn-chip--accent wtn-cm-chip");
      const label = el(doc, "span");
      label.textContent = value;
      chip.appendChild(label);
      const x = el(doc, "span", "wtn-cm-chip-x");
      x.textContent = "✕"; // ✕
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        setCurrent(removeFilterValue(getCurrent(), value));
        refresh();
        onChanged();
      });
      chip.appendChild(x);
      chipsHost.appendChild(chip);
    }
  }

  sel.addEventListener("change", (e) => {
    e.stopPropagation();
    const chosen = sel.value;
    sel.value = ""; // "reads as an action" (§7c-i) -- always resets to the placeholder
    if (!chosen) {
      return;
    }
    setCurrent(addFilterValue(getCurrent(), chosen));
    refresh();
    onChanged();
  });

  wrap.appendChild(sel);
  wrap.appendChild(chipsHost);
  refresh();
  return { el: wrap, refresh };
}

/**
 * A rail section: a plain heading (never a disclosure triangle) directly
 * above `contentEl` -- D5, this file's own top-of-CSS doc comment. Used to
 * build a `<details class="wtn-collapse">`/`<summary>` pair (D1); every
 * existing call site keeps the same `(doc, label, contentEl)` signature
 * unchanged, so this is a body-only edit.
 */
function buildRailSection(doc, label, contentEl) {
  const section = el(doc, "div", "wtn-cm-rail-section");
  const heading = el(doc, "div", "wtn-cm-rail-heading");
  heading.textContent = label;
  section.appendChild(heading);
  section.appendChild(contentEl);
  return section;
}

function buildThumb(doc, state, candidates, isStale, backoffMs) {
  const thumb = el(doc, "div", "wtn-cm-thumb");
  if (state === "gated") {
    const lock = el(doc, "span", "wtn-cm-thumb-gated");
    lock.textContent = "\u{1F512}"; // 🔒
    lock.title = "Add a Civitai API key to download this file.";
    thumb.appendChild(lock);
    return thumb;
  }
  if (state === "locked") {
    const lock = el(doc, "span", "wtn-cm-thumb-locked");
    lock.textContent = "\u{1F648}"; // 🙈 -- distinct from the gated padlock (§7c-iv)
    lock.title = "Preview hidden — above your browsing level";
    thumb.appendChild(lock);
    return thumb;
  }
  if (state === "image" && Array.isArray(candidates) && candidates.length > 0) {
    const skeleton = el(doc, "span", THUMB_SKELETON_CLASS);
    thumb.appendChild(skeleton);
    const clearSkeleton = (t) => {
      if (skeleton.parentNode === t && typeof t.removeChild === "function") {
        t.removeChild(skeleton);
      }
    };
    attachThumbCandidate(doc, thumb, candidates, { index: 0, retried: false }, isStale, backoffMs, (d, t) => {
      clearSkeleton(t);
      t.appendChild(el(d, "span", "wtn-cm-thumb-ph"));
    }, (d, t) => {
      clearSkeleton(t);
    });
    return thumb;
  }
  thumb.appendChild(el(doc, "span", "wtn-cm-thumb-ph"));
  return thumb;
}

// ---------------------------------------------------------------------------
// The modal shell.
// ---------------------------------------------------------------------------

let activeModal = null;

/**
 * Opens the toolbar modal. **90% of the viewport, centred, over a scrim --
 * deliberately NOT the Rule Builder overlay's own full-bleed `position:
 * fixed; inset: 0` geometry** (`js/prompt_rules/rule_builder/overlay.mjs`):
 * that one is a work surface you live in while authoring; this is "look
 * something up, take it, come back," so the graph stays visible at the
 * edges and keeps the user oriented (design doc, "The detail view"'s own
 * closing paragraph makes the same point about the community gallery's
 * geometry). What IS copied from the Rule Builder is its MECHANISM: an own
 * overlay root appended to `doc.body`, a scrim, Escape-to-close, scrim-
 * click-to-close, and focus restore on close (below) -- none of which
 * `js/shared/overlay.mjs` provides, since that module's own `openOverlay` is
 * an ANCHORED popover mechanism (positioned relative to a node's own DOM),
 * fundamentally the wrong shape for a modal that answers to no anchor at
 * all.
 *
 * Closes any already-open instance first (single modal at a time, same
 * convention as `openRuleBuilder`). `doc` is injectable for testing under
 * plain `node` (mirrors every other DOM module in this pack); real callers
 * (`index.js`) omit it and get the live `document`.
 */
export function openCivitaiModal({ doc, onClose, pollIntervalMs = 800, thumbRetryBackoffMs = THUMB_RETRY_BACKOFF_MS } = {}) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc) {
    return null;
  }
  if (activeModal) {
    activeModal.close();
  }

  injectModalStyles(targetDoc);

  // Focus restore (task brief: "restores focus") -- captured BEFORE any DOM
  // is built, so the element the user actually had focused (the toolbar
  // button, or whatever else) is what gets it back on close.
  const previouslyFocused = targetDoc.activeElement || null;

  const scrim = el(targetDoc, "div", "wtn wtn-cm wtn-cm-scrim");
  const panel = el(targetDoc, "div", "wtn-cm-panel");
  scrim.appendChild(panel);

  const head = el(targetDoc, "div", "wtn-cm-head");
  // D4 (REVERSED 2026-07-31, owner, from the built rail): the "unscoped --
  // every supported type" subtitle badge is GONE -- the title alone is
  // enough. Do not re-add a badge element here.
  const headTitle = el(targetDoc, "span");
  headTitle.textContent = "Browse Civitai";
  head.appendChild(headTitle);
  const closeBtn = el(targetDoc, "button", "wtn-cm-close");
  closeBtn.type = "button";
  closeBtn.textContent = "✕"; // ✕
  closeBtn.title = "Close (Esc)";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const body = el(targetDoc, "div", "wtn-cm-body");
  panel.appendChild(body);

  // ---- filter rail (§7c-i) --------------------------------------------
  const rail = el(targetDoc, "div", "wtn-cm-rail");
  body.appendChild(rail);

  let currentFilters = {
    sort: getSetting(SETTING_IDS.CIVITAI_SEARCH_SORT, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_SORT]),
    period: getSetting(SETTING_IDS.CIVITAI_SEARCH_PERIOD, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_PERIOD]),
    level: getSetting(SETTING_IDS.CIVITAI_BROWSING_LEVEL, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_BROWSING_LEVEL]),
    baseModels: parseStoredList(getSetting(SETTING_IDS.CIVITAI_MODAL_BASE_MODELS, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_MODAL_BASE_MODELS])),
    modelTypes: parseStoredList(getSetting(SETTING_IDS.CIVITAI_MODAL_MODEL_TYPES, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_MODAL_MODEL_TYPES])),
  };

  const sortSel = buildSingleSelectRow(targetDoc, CIVITAI_SEARCH_SORT_OPTIONS, currentFilters.sort, (v) => {
    currentFilters.sort = v;
    setSetting(SETTING_IDS.CIVITAI_SEARCH_SORT, v);
    runSearch({ resetCursor: true });
  });
  rail.appendChild(buildRailSection(targetDoc, "Sort models by", sortSel));

  const periodSel = buildSingleSelectRow(targetDoc, CIVITAI_SEARCH_PERIOD_OPTIONS, currentFilters.period, (v) => {
    currentFilters.period = v;
    setSetting(SETTING_IDS.CIVITAI_SEARCH_PERIOD, v);
    runSearch({ resetCursor: true });
  }, (value) => (value === "AllTime" ? "All time" : value));
  rail.appendChild(buildRailSection(targetDoc, "Period", periodSel));

  const levelSel = buildSingleSelectRow(targetDoc, CIVITAI_SEARCH_LEVEL_OPTIONS, currentFilters.level, (v) => {
    currentFilters.level = v;
    setSetting(SETTING_IDS.CIVITAI_BROWSING_LEVEL, v);
    runSearch({ resetCursor: true });
  });
  levelSel.title = "Maximum browsing level — PG never asks Civitai for adult content at all; PG-13/R/X/XXX filter a fuller gallery client-side.";
  rail.appendChild(buildRailSection(targetDoc, "Maximum browsing level", levelSel));

  const baseModelSection = buildChipFilterSection(targetDoc, {
    placeholder: "Add a base model…",
    options: CIVITAI_SEARCH_BASE_MODEL_OPTIONS.filter((v) => v !== ""),
    getCurrent: () => currentFilters.baseModels,
    setCurrent: (list) => {
      currentFilters.baseModels = list;
      setSetting(SETTING_IDS.CIVITAI_MODAL_BASE_MODELS, serializeList(list));
    },
    onChanged: () => runSearch({ resetCursor: true }),
  });
  rail.appendChild(buildRailSection(targetDoc, "Filter by Base Model", baseModelSection.el));

  const modelTypeSection = buildChipFilterSection(targetDoc, {
    placeholder: "Add a model type…",
    options: MODEL_TYPE_OPTIONS,
    getCurrent: () => currentFilters.modelTypes,
    setCurrent: (list) => {
      currentFilters.modelTypes = list;
      setSetting(SETTING_IDS.CIVITAI_MODAL_MODEL_TYPES, serializeList(list));
    },
    onChanged: () => runSearch({ resetCursor: true }),
  });
  rail.appendChild(buildRailSection(targetDoc, "Filter by Model Type", modelTypeSection.el));

  // ---- main column: search bar + grid ----------------------------------
  const main = el(targetDoc, "div", "wtn-cm-main");
  body.appendChild(main);

  const searchbar = el(targetDoc, "div", "wtn-cm-searchbar");
  const search = el(targetDoc, "input", "wtn-input wtn-cm-search");
  search.type = "text";
  search.placeholder = "Search Civitai…";
  search.spellcheck = false;
  search.addEventListener("click", (e) => e.stopPropagation());
  searchbar.appendChild(search);

  const publicOnlyLine = el(targetDoc, "div", "wtn-cm-warn");
  publicOnlyLine.textContent = "No API key set — public results only.";
  publicOnlyLine.style.display = "none";
  searchbar.appendChild(publicOnlyLine);

  const statusLine = el(targetDoc, "div");
  searchbar.appendChild(statusLine);

  const activeHost = el(targetDoc, "div");
  searchbar.appendChild(activeHost);

  main.appendChild(searchbar);

  const gridWrap = el(targetDoc, "div", "wtn-cm-gridwrap");
  const grid = el(targetDoc, "div", "wtn-cm-grid");
  gridWrap.appendChild(grid);
  main.appendChild(gridWrap);

  // ---- state ------------------------------------------------------------
  let results = [];
  let nextCursor = null;
  let loading = true;
  let loadingMore = false;
  let searchSeq = 0;
  let renderGeneration = 0;
  const cardMessages = new Map();

  function renderActive() {
    activeHost.innerHTML = "";
    const job = getActiveDownloadState();
    if (!job || results.some((r) => resultKey(resolveVersionView(r)) === job.key)) {
      return;
    }
    const row = el(targetDoc, "div", "wtn-cm-active");
    const label = el(targetDoc, "span");
    label.textContent = `Downloading ${job.filename || "…"}`;
    row.appendChild(label);
    const pct = downloadPercent(job.bytes, job.total);
    const bar = el(targetDoc, "div", "wtn-cm-bar");
    const fill = el(targetDoc, "i");
    fill.style.width = `${pct == null ? 0 : pct}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    const pctLabel = el(targetDoc, "span");
    pctLabel.textContent = pct == null ? "…" : `${pct}%`;
    row.appendChild(pctLabel);
    const cancelBtn = el(targetDoc, "button", "wtn-cm-action wtn-cm-action-cancel");
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
    // No per-card version selector this pass -- version choice belongs to
    // the detail view (design doc "The detail view"), which is explicitly
    // out of scope here (this file's own top doc comment). Always the
    // primary version.
    const view = resolveVersionView(result);
    const kind = resultKind(result);

    const card = el(targetDoc, "div", "wtn-cm-card");
    const rKey = resultKey(view);
    const job = getActiveDownloadState();
    const state = resultCardState(view, job, sessionGatedKeys());

    const levelInt = levelLabelToInt(currentFilters.level);
    // `view.nsfw_level` -- the MODEL's own top-level bitmask union, untouched
    // by `resolveVersionView`'s per-version spread -- lets `thumbState` tell
    // "genuinely no gallery" apart from "gallery trimmed to nothing at this
    // level" for an empty `view.images` (owner-reported, 2026-07-31: "why
    // some images are not shown?" -- see `civitai_thumb.mjs`'s own doc
    // comment for the bitmask-union trap this must never fall into).
    const tState = thumbState(state, view.images, levelInt, view.nsfw_level);
    const candidates = tState === "image" ? pickThumbCandidates(view.images, levelInt) : [];
    const gen = renderGeneration;
    const isStale = () => gen !== renderGeneration;
    card.appendChild(buildThumb(targetDoc, tState, candidates, isStale, thumbRetryBackoffMs));
    const previewUrl = candidates.length > 0 ? candidates[0] : null;

    const title = el(targetDoc, "div", "wtn-cm-title");
    title.textContent = view.name || "(untitled)";
    title.title = view.name || "";
    card.appendChild(title);

    const metaRow = el(targetDoc, "div", "wtn-cm-metarow");
    const baseModel = resultBaseModel(view);
    if (baseModel) {
      const chip = el(targetDoc, "span", "wtn-chip wtn-chip--accent wtn-cm-chip-tag");
      chip.textContent = baseModel;
      chip.title = baseModel;
      metaRow.appendChild(chip);
    }
    const typeLabel = typeof result.type === "string" ? result.type.trim() : "";
    if (typeLabel) {
      const typeChip = el(targetDoc, "span", "wtn-cm-chip-tag");
      typeChip.textContent = typeLabel;
      metaRow.appendChild(typeChip);
    }
    if (metaRow.children.length) {
      card.appendChild(metaRow);
    }

    const sub = el(targetDoc, "div", "wtn-cm-sub");
    sub.textContent = state === "gated" ? gatedSubtitle() : resultSubtitle(view);
    card.appendChild(sub);

    if (state === "downloading") {
      const pct = downloadPercent(job.bytes, job.total);
      const bar = el(targetDoc, "div", "wtn-cm-bar");
      const fill = el(targetDoc, "i");
      fill.style.width = `${pct == null ? 0 : pct}%`;
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    const msg = cardMessages.get(rKey);
    const missingFile = !view.file_name || !view.download_url;
    if (msg) {
      const msgEl = el(targetDoc, "div", "wtn-cm-cardmsg");
      msgEl.textContent = msg;
      card.appendChild(msgEl);
    } else if (state === "available" && kind && missingFile) {
      const msgEl = el(targetDoc, "div", "wtn-cm-cardmsg");
      msgEl.textContent = "No downloadable file for this version.";
      card.appendChild(msgEl);
    }

    const actionCol = el(targetDoc, "div", "wtn-cm-actioncol");

    if (!kind) {
      // §"kind: null" -- the safety net, kept minimal (owner direction,
      // 2026-07-31): one quiet line, no download button, nothing else.
      const line = el(targetDoc, "div", "wtn-cm-nokind");
      line.textContent = NOT_INSTALLABLE_MESSAGE;
      actionCol.appendChild(line);
    } else if (state === "installed") {
      const badgeEl = el(targetDoc, "span", "wtn-cm-action wtn-cm-action-installed");
      badgeEl.textContent = "✓ installed"; // ✓ installed
      actionCol.appendChild(badgeEl);
    } else if (state === "downloading") {
      const pct = downloadPercent(job.bytes, job.total);
      const row = el(targetDoc, "div", "wtn-cm-actioncol-row");
      const pctLabel = el(targetDoc, "span", "wtn-cm-sub");
      pctLabel.textContent = pct == null ? "…" : `${pct}%`;
      row.appendChild(pctLabel);
      const cancelBtn = el(targetDoc, "button", "wtn-cm-action wtn-cm-action-cancel");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelActiveDownloadJob();
      });
      row.appendChild(cancelBtn);
      actionCol.appendChild(row);
    } else if (state === "gated") {
      const btn = el(targetDoc, "button", "wtn-cm-action wtn-cm-action-gated");
      btn.type = "button";
      btn.textContent = "key required";
      btn.disabled = true;
      btn.title = "Add a Civitai API key in Settings → AnimaFlow → Controls to download this file.";
      actionCol.appendChild(btn);
    } else {
      const dest = el(targetDoc, "div", "wtn-cm-dest");
      dest.textContent = destinationLabelForKind(kind);
      actionCol.appendChild(dest);
      const btn = el(targetDoc, "button", "wtn-cm-action");
      btn.type = "button";
      btn.textContent = "↓ Download"; // ↓ Download
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
        cardMessages.delete(rKey);
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
          kind, subfolder: "", filename: view.file_name, downloadUrl: view.download_url, sizeKb: view.size_kb,
          key: rKey, civitaiMeta, previewUrl,
        }, pollIntervalMs);
        if (resp.reason !== "started") {
          cardMessages.set(rKey, downloadStartMessage(resp));
          logSummary("Civitai browser", `download NOT started: ${view.file_name} (${resp.reason})`);
        } else {
          logSummary("Civitai browser", `download started: ${view.file_name} (${kind})`);
        }
        renderGrid();
      });
      actionCol.appendChild(btn);
    }

    card.appendChild(actionCol);
    return card;
  }

  function renderGrid() {
    renderGeneration += 1;
    renderActive();
    grid.innerHTML = "";
    if (loading) {
      const msg = el(targetDoc, "div", "wtn-cm-empty");
      msg.textContent = "Searching…";
      grid.appendChild(msg);
      return;
    }
    if (!results.length) {
      const msg = el(targetDoc, "div", "wtn-cm-empty");
      msg.textContent = "No results.";
      grid.appendChild(msg);
      return;
    }
    for (const result of results) {
      grid.appendChild(buildCard(result));
    }
    if (loadingMore) {
      const msg = el(targetDoc, "div", "wtn-cm-empty");
      msg.textContent = "Loading more…";
      grid.appendChild(msg);
    }
  }

  async function runSearch({ resetCursor = true } = {}) {
    reconcileGatedKeysOnApiKeySignature(
      apiKeySignature(getSetting(SETTING_IDS.CIVITAI_API_KEY, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_API_KEY])),
      sessionGatedKeys(),
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
    renderGrid();
    const query = search.value.trim();
    logDebug(
      "Civitai browser",
      `issuing ${resetCursor ? "search" : "page fetch"} (query=${JSON.stringify(query)}, `
      + `baseModels=${JSON.stringify(currentFilters.baseModels)}, modelTypes=${JSON.stringify(currentFilters.modelTypes)}, `
      + `sort=${currentFilters.sort}, period=${currentFilters.period}, level=${currentFilters.level})`,
    );
    const resp = await searchUnscoped({
      query,
      baseModels: currentFilters.baseModels,
      modelTypes: currentFilters.modelTypes,
      sort: currentFilters.sort,
      period: currentFilters.period,
      level: levelLabelToInt(currentFilters.level),
      cursor: resetCursor ? "" : (nextCursor || ""),
    });
    if (seq !== searchSeq) {
      return;
    }
    loading = false;
    loadingMore = false;
    publicOnlyLine.style.display = resp.public_only ? "" : "none";
    statusLine.innerHTML = "";
    if (resp.reason !== "ok") {
      const lineClass = resp.reason === "rate_limited" ? "wtn-cm-info" : "wtn-cm-bad";
      const line = el(targetDoc, "div", lineClass);
      line.textContent = searchReasonMessage(resp) || resp.message || "Search failed.";
      statusLine.appendChild(line);
      logSummary("Civitai browser", `search issued (query=${JSON.stringify(query)}) failed -- ${resp.reason}`);
      if (resetCursor) {
        results = [];
        nextCursor = null;
      }
      renderGrid();
      return;
    }
    const incoming = resp.results || [];
    results = resetCursor ? appendDedupedResults([], incoming) : appendDedupedResults(results, incoming);
    nextCursor = resp.next_cursor;
    logSummary("Civitai browser", `search issued (query=${JSON.stringify(query)}) -> ${incoming.length} result(s)`);
    renderGrid();
  }

  function maybeLoadMore() {
    if (loadingMore || !nextCursor) {
      return;
    }
    const remaining = gridWrap.scrollHeight - gridWrap.scrollTop - gridWrap.clientHeight;
    if (remaining <= SCROLL_LOAD_MORE_THRESHOLD_PX) {
      runSearch({ resetCursor: false });
    }
  }
  gridWrap.addEventListener("scroll", maybeLoadMore);

  const SEARCH_DEBOUNCE_MS = 400;
  let debounceTimer = null;
  search.addEventListener("input", () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => runSearch({ resetCursor: true }), SEARCH_DEBOUNCE_MS);
  });

  function onDownloadStateChange() {
    const job = getActiveDownloadState();
    if (job && job.status && job.status !== "downloading" && job.status !== "cancelling") {
      // C/E -- one summary line per TERMINAL transition, never per poll tick.
      logSummary("Civitai browser", `download finished: ${job.filename || job.key} (${job.status})`);
      const finished = results.find((r) => resultKey(resolveVersionView(r)) === job.key);
      if (finished) {
        const versions = Array.isArray(finished.versions) ? finished.versions : null;
        const v0 = versions && versions[0];
        if (job.status === "ok") {
          finished.installed = true;
          if (v0) {
            v0.installed = true;
          }
          cardMessages.delete(job.key);
        } else if (job.status === "key_required") {
          markResultGated(job.key);
          finished.gated = true;
          if (v0) {
            v0.gated = true;
          }
          cardMessages.delete(job.key);
        } else {
          cardMessages.set(job.key, downloadTerminalMessage(job.status, job));
        }
      }
    }
    renderGrid();
  }
  const unsubscribe = subscribeDownloadState(onDownloadStateChange);

  renderGrid();

  // ---- lifecycle: Escape, scrim click, focus restore ---------------------
  // Escape is listened for on the WINDOW, not `doc` (mirrors `overlay.mjs`'s
  // own `onKeydown`/`onDocPointerDown` convention) -- every doc stub in this
  // pack's own tests (`test_civitai_search.mjs`'s `makeDocStub`, etc.) wires
  // `addEventListener` on `defaultView`, not on the `doc` object itself.
  const listenWin = targetDoc.defaultView || (typeof window !== "undefined" ? window : null);
  function onKeydown(e) {
    if (e.key === "Escape") {
      close();
    }
  }
  function onScrimClick(e) {
    if (e.target === scrim) {
      close();
    }
  }
  if (listenWin && typeof listenWin.addEventListener === "function") {
    listenWin.addEventListener("keydown", onKeydown);
  }
  scrim.addEventListener("mousedown", onScrimClick);

  let closed = false;
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    unsubscribe();
    if (typeof gridWrap.removeEventListener === "function") {
      gridWrap.removeEventListener("scroll", maybeLoadMore);
    }
    if (listenWin && typeof listenWin.removeEventListener === "function") {
      listenWin.removeEventListener("keydown", onKeydown);
    }
    if (scrim.parentNode) {
      scrim.parentNode.removeChild(scrim);
    } else if (typeof targetDoc.body === "object" && targetDoc.body && typeof targetDoc.body.removeChild === "function") {
      try {
        targetDoc.body.removeChild(scrim);
      } catch {
        // Already detached -- nothing to do.
      }
    }
    if (activeModal === handle) {
      activeModal = null;
    }
    // Focus restore (task brief) -- best-effort: a previously-focused
    // element that's since been removed from the document, or a stub with
    // no real `.focus()`, must never throw.
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      try {
        previouslyFocused.focus();
      } catch {
        // Best-effort -- never let a focus restore crash the close path.
      }
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }

  const body2 = targetDoc.body || targetDoc;
  body2.appendChild(scrim);

  if (typeof search.focus === "function") {
    search.focus();
  }

  const handle = { close, panel, scrim };
  activeModal = handle;

  runSearch({ resetCursor: true });

  return handle;
}

/** Test-only: force-clears the module-level singleton so a suite can start
 * every test from a clean slate. Never called by any real (non-test) code
 * path. */
export function _resetModalForTests() {
  if (activeModal) {
    try {
      activeModal.close();
    } catch {
      // Best-effort teardown for a test that left the modal open.
    }
  }
  activeModal = null;
}
