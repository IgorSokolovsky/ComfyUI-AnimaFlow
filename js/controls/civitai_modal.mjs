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
 * The master→detail swap (decision 11) now lands too: a result card click
 * OUTSIDE its own download action replaces the RESULTS AREA (search bar +
 * grid) with `model_detail_view.mjs`'s `buildModelDetailView` (`layout:
 * "grid"`), while the filter rail stays put -- "your filters are the
 * context you came from" -- with a `← results` affordance to swap back. See
 * `openDetail`/`closeDetail`/`renderSwap`, below.
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
  searchButtonEnabled,
} from "./civitai_search.mjs";
import { searchUnscoped, fetchModelDetail } from "./civitai_api.mjs";
// "The detail view" -- one component, mounted twice (this modal's own
// master→detail swap, decision 11, and the picker's vertical sibling panel,
// `civitai_search.mjs`'s `openModelDetailPanel`). See that file's own top
// doc comment for the full "one component" contract.
import { buildModelDetailView } from "./model_detail_view.mjs";
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

/* Owner-reported (2026-08-01): "i think we have horizontal issue in the
   model detail page, see its cut" -- also why the Download button read as
   MISSING in that screenshot: it was clipped off the right edge, not
   absent. Root cause: this element is a flex ROW item of \`.wtn-cm-body\`
   (that rule's own \`display: flex\` has no \`flex-direction\`, so it defaults
   to \`row\`), and a flex item's \`min-width\` defaults to \`auto\` -- refuses
   to shrink below its own content's natural width -- so one long unbroken
   line deep inside (a model description) could push THIS element, and
   everything to its right, wider than the modal. \`min-height: 0\` (already
   present) guards the OTHER axis (\`.wtn-cm-main\` is itself
   \`flex-direction: column\`, so ITS children's min-HEIGHT is the trap one
   level down); \`wtn-flex-bound\` (this element's own class list, set where
   it's built -- \`js/shared/theme.css\` has that class's own doc comment) is
   the shared fix for both, applied here alongside \`.wtn-cm-detailhost\`
   (below) and \`model_detail_view.mjs\`'s own \`.wtn-dv\`/\`.wtn-dv-body\` --
   the SAME trap's third and fourth occurrence, which is why it's a shared
   class now rather than a fourth hand-written \`min-width: 0\`. */
.wtn-cm-main { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; }
.wtn-cm-searchbar { padding: 10px 16px; flex: none; border-bottom: 1px solid var(--wtn-line, ${TOKENS.line}); display: flex; flex-direction: column; gap: 6px; }
/* An explicit \`Search\` button beside the field (§7c-i, "not a debounce") --
   shared behaviour with civitai_search.mjs's own row, "one implementation"
   per that section's closing line. */
.wtn-cm-searchrow { display: flex; align-items: stretch; gap: 6px; }
.wtn-cm-search { flex: 1 1 auto; min-width: 0; }
.wtn-cm-search-btn {
  flex: none; font: 12px var(--wtn-font-ui, inherit); font-weight: 600; padding: 5px 12px; border-radius: 7px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); cursor: pointer;
}
.wtn-cm-search-btn:disabled { cursor: default; opacity: .45; }
.wtn-cm-warn { color: var(--wtn-warn, ${TOKENS.warn}); font-size: 12px; }
.wtn-cm-bad { color: var(--wtn-bad, ${TOKENS.bad}); font-size: 12px; }
.wtn-cm-info { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); font-size: 12px; }
.wtn-cm-active { display: flex; align-items: center; gap: 8px; font-size: 12px; padding-top: 4px; }
.wtn-cm-bar { position: relative; flex: 1 1 auto; height: 6px; background: var(--wtn-surface, ${TOKENS.surface}); border-radius: 4px; overflow: hidden; min-width: 60px; }
.wtn-cm-bar i { position: absolute; inset: 0; width: 0; background: var(--wtn-accent, ${TOKENS.accent}); display: block; }

.wtn-cm-gridwrap { flex: 1 1 auto; overflow-y: auto; padding: 14px 16px; }
/* The master->detail swap's own host (decision 11) -- takes over the SAME
   flex slot searchbar+gridWrap occupy when a card is clicked; the rail
   stays untouched (it's body's own sibling, not main's). \`min-height: 0\`
   (owner, 2026-08-01: "the details panel is not scrollable") -- without it
   this flex child (of \`.wtn-cm-main\`, itself already \`min-height: 0\`)
   refuses to shrink below the detail content's own natural height, so
   \`overflow-y: auto\` here never actually engages and the swap just grows
   \`main\` past the modal's own bound instead of scrolling in place --
   civitai_search.mjs's own \`.wtn-cs-body\`/\`.wtn-dv-host\` doc comments name
   this exact trap. \`wtn-flex-bound\` (this element's own class list, set
   where it's built) additionally covers this element's \`min-width\`, for
   the SAME reason \`.wtn-cm-main\`'s own doc comment (above) gives -- the
   detail view mounted inside this host can be just as wide as it is tall. */
.wtn-cm-detailhost { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px 16px; }
.wtn-cm-empty { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 12.5px; padding: 20px 4px; }
.wtn-cm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
/* Owner-reported (2026-08-01): "in the browser modal the cards should also
   have shadow elevate and cursor pointer on hover" -- the same fix
   \`civitai_search.mjs\`'s own \`.wtn-cs-card\` already got, reused rather than
   re-authored (that file's own doc comment on \`.wtn-cs-card\` has the full
   "why" for \`cursor: pointer\`/the hover elevation/why the interactive
   children are unaffected). \`--wtn-row-shadow\` (\`js/shared/theme.css\`) is
   the SAME token that selector reads -- lifted there specifically so this
   card and that one can never drift onto two different hand-tuned values.
   Every card in THIS grid is genuinely clickable, including a \`kind: null\`
   one (\`buildCard\`'s own unconditional click listener, below, calls
   \`openDetail(result)\` regardless of \`kind\` -- a null-kind result still
   opens a real, useful detail view, just one whose action column shows the
   honest "not installable" line instead of a download button) -- so unlike
   a genuinely inert control, there is no card here to withhold the pointer
   from. */
.wtn-cm-card {
  display: flex; flex-direction: column; gap: 6px; padding: 8px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: 8px; cursor: pointer; transition: box-shadow .12s ease;
}
.wtn-cm-card:hover { box-shadow: var(--wtn-row-shadow, 0 3px 10px rgba(0,0,0,.4)); }
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
/* The per-card version select (owner, 2026-08-01: "add a version select
   above the download button") -- \`.wtn-cm-actioncol\`'s default
   \`align-items: stretch\` already gives every child (this select, the
   action button below it) the SAME full column width, so no extra
   alignment rule is needed here; \`width: 100%\`/\`box-sizing: border-box\`
   just make that explicit for a \`<select>\` rather than relying on stretch
   alone.
   Owner-reported, with a screenshot (2026-08-01): this select read visibly
   TALLER than the \`↓ Download\` button beneath it -- this class also carries
   \`wtn-select\` (see \`buildCard\`'s own \`el(targetDoc, "select", "wtn-select
   wtn-cm-version-sel")\`), and the shared 26px control height this track
   already used elsewhere (\`model_detail_view.mjs\`'s own \`.wtn-dv-version-
   sel\`/\`.wtn-dv-back\`, this file's own \`.wtn-dv-topbar .wtn-cm-action\`
   below) had only ever been declared on THOSE two per-surface classes, never
   on the shared \`.wtn-select\` base a new select inherits by construction --
   so this one fell through to a plain \`<select>\`'s native sizing instead.
   Fixed on \`.wtn-select\` itself now (\`js/shared/theme.css\`), not copied a
   third time here -- this rule needs no height of its own any more. */
.wtn-cm-version-sel { width: 100%; box-sizing: border-box; }
.wtn-cm-dest { font-size: 10.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-cm-nokind { font-size: 11px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; }
/* Same report, same screenshot: the fix above only works if the Download
   button UNDER this select actually resolves to the SAME 26px, not merely a
   padding/line-height box that happens to look close. Pinned explicitly here
   for the same reason \`civitai_search.mjs\`'s own \`.wtn-cs-action\` pins its
   own height rather than leaving it to content -- a native \`<button>\` and a
   native \`<select>\` don't size the same way from equal padding, so "equal
   padding" was never actually a guarantee of "equal height". \`display:
   inline-flex\`/\`align-items: center\`/\`justify-content: center\` keep the
   label centred now that height no longer comes from line-height + padding;
   \`appearance: none\` matches \`.wtn-cs-action\`'s own reset for the same
   reason (a native button already carries some UA chrome of its own). */
.wtn-cm-action {
  height: 26px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  font: 12px var(--wtn-font-ui, inherit); font-weight: 600; padding: 0 10px; border-radius: 7px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent});
  cursor: pointer; appearance: none; -webkit-appearance: none; margin: 0;
}
.wtn-cm-action:disabled { cursor: default; opacity: .6; }
.wtn-cm-action-installed { background: transparent; border-color: rgba(74,222,128,.4); color: var(--wtn-ok, ${TOKENS.ok}); }
.wtn-cm-action-gated { background: var(--wtn-warn, ${TOKENS.warn}); color: #201400; }
.wtn-cm-action-cancel { background: transparent; border-color: rgba(248,113,113,.4); color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-cm-actioncol-row { display: flex; align-items: center; gap: 8px; }
/* Owner-reported, with a screenshot (2026-08-01): in the detail view's fixed
   top bar ("← back to results" / the version select / this action), this
   button read shorter than the version \`<select>\` beside it -- same class
   of bug as \`civitai_search.mjs\`'s own \`.wtn-cs-action\` doc comment names
   for the Delete-vs-✓-installed mismatch (a native form control carries
   browser chrome that ignores ordinary padding/line-height sizing), fixed
   the same way there. Scoped to \`.wtn-dv-topbar\` (\`model_detail_view.mjs\`'s
   own class, defined in that file's stylesheet -- CSS cascades across
   stylesheets regardless of which file declares a rule) rather than made
   global, since at the time THIS grid's own \`.wtn-cm-card\` action column
   was never reported as mismatched.
   UPDATE (2026-08-01, later the same day): the base \`.wtn-cm-action\` rule
   above now declares this SAME height/box-sizing/centering itself (the per-
   card select needed the identical fix), which makes this override a true,
   harmless duplicate -- both sides are pinned to 26px by construction, so
   they cannot drift apart, and it stays rather than being pulled because a
   regression test below still pins its existence and this override remains
   correct. Height matches \`.wtn-dv-topbar\`'s other two controls
   (\`model_detail_view.mjs\`'s own \`.wtn-dv-back\`/\`.wtn-dv-version-sel\`,
   26px) exactly -- one shared number across two files' CSS, not two
   independently-tuned ones. */
.wtn-dv-topbar .wtn-cm-action {
  height: 26px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  padding: 0 10px;
}
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
  const main = el(targetDoc, "div", "wtn-cm-main wtn-flex-bound");
  body.appendChild(main);

  const searchbar = el(targetDoc, "div", "wtn-cm-searchbar");
  // An explicit `Search` button beside the field (§7c-i) -- nothing fires
  // from typing alone; see `updateSearchButtonState`/the `search`
  // "input"/"keydown" listeners below.
  const searchRow = el(targetDoc, "div", "wtn-cm-searchrow");
  const search = el(targetDoc, "input", "wtn-input wtn-cm-search");
  search.type = "text";
  search.placeholder = "Search Civitai…";
  search.spellcheck = false;
  search.addEventListener("click", (e) => e.stopPropagation());
  searchRow.appendChild(search);
  const searchBtn = el(targetDoc, "button", "wtn-cm-search-btn");
  searchBtn.type = "button";
  searchBtn.textContent = "Search";
  searchBtn.title = "Run this search";
  searchRow.appendChild(searchBtn);
  searchbar.appendChild(searchRow);

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

  // ---- the master→detail swap's own host (decision 11) -- a THIRD child
  // of `main`, alongside `searchbar`/`gridWrap`; `renderSwap` toggles which
  // of the two is visible. Kept as a separate host rather than replacing
  // `main`'s children outright so `searchbar`'s own state (the query text,
  // the filter selects) survives a round trip through the detail view with
  // no re-render of its own.
  const detailHost = el(targetDoc, "div", "wtn-cm-detailhost wtn-flex-bound");
  detailHost.style.display = "none";
  main.appendChild(detailHost);

  // ---- state ------------------------------------------------------------
  let results = [];
  let nextCursor = null;
  let loading = true;
  let loadingMore = false;
  let searchSeq = 0;
  let renderGeneration = 0;
  // §"The detail view" -- the master→detail swap's own state. `detailResult`
  // is the raw search result the user clicked into; `null` means "list mode"
  // (`renderSwap`'s own single source of truth for which half of `main` is
  // visible -- never a separate boolean to keep in sync).
  let detailResult = null;
  let detailVersionId = null;
  let detailData = { status: "loading", gallery: [] };
  let detailActionMessage = null;
  const cardMessages = new Map();
  // Per-card version choice (owner, 2026-08-01: "add a version select above
  // the download button, the same per-card picker the anchored search panel
  // already has") -- the SAME `model_id -> chosen version id` map shape as
  // `civitai_search.mjs`'s own `selectedVersions` (that file's `buildCard`),
  // reused rather than re-derived: `resolveVersionView(result, selectedId)`
  // is the identical shared helper, imported already (above).
  const selectedVersions = new Map();
  // §7c-i's own "Search button" state -- see civitai_search.mjs's
  // `lastSearchedQuery` doc comment; `null` until the trailing
  // `runSearch({resetCursor:true})` call (below) runs for the first time.
  let lastSearchedQuery = null;

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
    // Per-card version selector (owner, 2026-08-01, reversing the earlier
    // "no per-card version selector this pass" -- the SAME per-card picker
    // `civitai_search.mjs`'s own `buildCard` already has, reused rather than
    // re-derived): `selectedVersions` is this mount's own copy of that exact
    // `model_id -> chosen version id` map, and `resolveVersionView` is the
    // SAME shared helper. Every render decision below reads ONLY this flat
    // `view`, never `result` directly, so a version switch is a single
    // uniform re-render.
    const selectedVersionId = selectedVersions.get(result.model_id);
    const view = resolveVersionView(result, selectedVersionId);
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

    // The per-card version picker, above the download button (owner,
    // 2026-08-01) -- ONLY for a multi-version result, same guard
    // `civitai_search.mjs`'s own `buildCard` uses. Mirrors that file's
    // implementation exactly (options, selection, stopPropagation on both
    // `click`/`change`, re-render on switch) rather than a second, divergent
    // per-card version picker.
    const versions = Array.isArray(result.versions) ? result.versions : null;
    if (versions && versions.length > 1) {
      const versionSel = el(targetDoc, "select", "wtn-select wtn-cm-version-sel");
      versionSel.title = "Choose which version to download.";
      for (const v of versions) {
        const opt = el(targetDoc, "option");
        opt.value = String(v.version_id);
        opt.textContent = v.name || `#${v.version_id}`;
        if (v.version_id === view.primary_version_id) {
          opt.selected = true;
        }
        versionSel.appendChild(opt);
      }
      versionSel.value = String(view.primary_version_id);
      versionSel.addEventListener("click", (e) => e.stopPropagation());
      versionSel.addEventListener("change", (e) => {
        e.stopPropagation();
        const chosenId = Number(versionSel.value);
        // Switching versions never disturbs a DIFFERENT card's in-flight
        // download -- only this one model's own entry in the selection map.
        selectedVersions.set(result.model_id, chosenId);
        renderGrid();
      });
      actionCol.appendChild(versionSel);
    }

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
      // Owner-reported (2026-08-01): "remove the -> models/checkpoints/
      // caption" -- repeated on every card it was noise, and the destination
      // is already stated by the "Save to:" field elsewhere.
      // `destinationLabelForKind(kind)` (the caption's own text) is simply
      // never called here any more; `kind` itself still drives which folder
      // `startDownloadJob`, below, actually writes into -- only the VISIBLE
      // caption is gone, not the destination logic.
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

    // Decision 11 -- a card click OUTSIDE its own controls swaps to the
    // detail view. Every interactive child above already `stopPropagation`s
    // its own click (the version select, the download/cancel/delete
    // buttons), so this only ever fires for the card's own body/thumb/title.
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      openDetail(result);
    });
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

  // -------------------------------------------------------------------------
  // The master→detail swap (decision 11) -- `model_detail_view.mjs` supplies
  // the actual content (`buildModelDetailView`, `layout: "filmstrip"`); everything
  // here is this MOUNT's own wiring: which half of `main` is visible, the
  // fetch/re-render loop for the two extra fields a search result doesn't
  // already carry (`civitai_api.mjs`'s `fetchModelDetail`), and this
  // surface's own primary action -- download to the DERIVED destination
  // folder (§7c: "the modal answers to nobody", unlike the picker's "returns
  // to the row").
  // -------------------------------------------------------------------------

  /** Swaps the results area for the detail view. The RAIL is untouched --
   * "your filters are the context you came from" (task brief) -- only
   * `searchbar`/`gridWrap` hide and `detailHost` takes their place. */
  function renderSwap() {
    const inDetail = detailResult != null;
    searchbar.style.display = inDetail ? "none" : "";
    gridWrap.style.display = inDetail ? "none" : "";
    detailHost.style.display = inDetail ? "" : "none";
    if (inDetail) {
      renderDetailHost();
    } else {
      detailHost.innerHTML = "";
    }
  }

  function buildDetailAction(doc, view, result) {
    const rKey = resultKey(view);
    const detailKind = resultKind(result);
    const job = getActiveDownloadState();
    const state = resultCardState(view, job, sessionGatedKeys());
    const wrap = el(doc, "div", "wtn-cm-actioncol");

    if (!detailKind) {
      const line = el(doc, "div", "wtn-cm-nokind");
      line.textContent = NOT_INSTALLABLE_MESSAGE;
      wrap.appendChild(line);
      return wrap;
    }
    if (state === "installed") {
      const badge = el(doc, "span", "wtn-cm-action wtn-cm-action-installed");
      badge.textContent = "✓ installed";
      wrap.appendChild(badge);
      return wrap;
    }
    if (state === "downloading") {
      const pct = downloadPercent(job.bytes, job.total);
      const row = el(doc, "div", "wtn-cm-actioncol-row");
      const pctLabel = el(doc, "span", "wtn-cm-sub");
      pctLabel.textContent = pct == null ? "…" : `${pct}%`;
      row.appendChild(pctLabel);
      const cancelBtn = el(doc, "button", "wtn-cm-action wtn-cm-action-cancel");
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
      const btn = el(doc, "button", "wtn-cm-action wtn-cm-action-gated");
      btn.type = "button";
      btn.textContent = "key required";
      btn.disabled = true;
      btn.title = "Add a Civitai API key in Settings → AnimaFlow → Controls to download this file.";
      wrap.appendChild(btn);
      return wrap;
    }

    // Owner-reported, with a screenshot (2026-08-01): "→ models/checkpoints/"
    // sat ABOVE the Download button -- it's a CAPTION for that button (where
    // the file will land), so it reads as attached to it by sitting
    // UNDERNEATH, not floating above. Built here (destination is known
    // before the button is), appended AFTER `btn` below -- DOM order is
    // what actually controls the read order, not source order of the two
    // `el()` calls.
    const dest = el(doc, "div", "wtn-cm-dest");
    dest.textContent = destinationLabelForKind(detailKind);
    const missingFile = !view.file_name || !view.download_url;
    const btn = el(doc, "button", "wtn-cm-action");
    btn.type = "button";
    btn.textContent = "↓ Download";
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
      detailActionMessage = null;
      const civitaiMeta = {
        model_id: result.model_id, version_id: view.primary_version_id, name: view.name,
        type: result.type, base_model: view.base_model, tags: result.tags, triggers: view.triggers,
      };
      const previewCandidates = pickThumbCandidates(view.images, levelLabelToInt(currentFilters.level));
      const resp = await startDownloadJob({
        kind: detailKind, subfolder: "", filename: view.file_name, downloadUrl: view.download_url, sizeKb: view.size_kb,
        key: rKey, civitaiMeta, previewUrl: previewCandidates.length > 0 ? previewCandidates[0] : null,
      }, pollIntervalMs);
      if (resp.reason !== "started") {
        detailActionMessage = downloadStartMessage(resp);
        logSummary("Civitai browser", `download NOT started: ${view.file_name} (${resp.reason})`);
      } else {
        logSummary("Civitai browser", `download started: ${view.file_name} (${detailKind})`);
      }
      renderDetailHost();
      renderGrid(); // keep the list's own card in sync for when the user swaps back
    });
    wrap.appendChild(btn);
    wrap.appendChild(dest);
    if (detailActionMessage) {
      const msgEl = el(doc, "div", "wtn-cm-cardmsg");
      msgEl.textContent = detailActionMessage;
      wrap.appendChild(msgEl);
    }
    return wrap;
  }

  function renderDetailHost() {
    detailHost.innerHTML = "";
    if (!detailResult) {
      return;
    }
    const built = buildModelDetailView({
      doc: targetDoc, layout: "filmstrip", result: detailResult, versionId: detailVersionId,
      browsingLevel: levelLabelToInt(currentFilters.level), detail: detailData,
      buildActionEl: buildDetailAction,
      onVersionChange: (id) => {
        detailVersionId = id;
        loadDetailData();
      },
      onBack: closeDetail,
      // Owner, 2026-08-01: "back to results ... top navigation bar ...
      // fixed position ... also show the download button and the version
      // selection" -- the MODAL's own fixed one-row bar (`model_detail_view
      // .mjs`'s own `fixedTopBar` doc comment has the full "why" split from
      // the picker's unchanged `.wtn-dv-header` shape).
      fixedTopBar: true,
    });
    detailHost.appendChild(built.el);
  }

  async function loadDetailData() {
    if (!detailResult) {
      return;
    }
    const modelId = detailResult.model_id;
    const versionId = detailVersionId;
    detailData = {
      status: "loading", gallery: [],
      modelDescription: detailData.modelDescription,
      modelDescriptionChecked: detailData.modelDescriptionChecked,
    };
    renderDetailHost();
    const resp = await fetchModelDetail(modelId, versionId);
    // Discard a stale reply -- the user closed the detail view, or switched
    // to a DIFFERENT model/version, while this fetch was in flight.
    if (!detailResult || detailResult.model_id !== modelId || detailVersionId !== versionId) {
      return;
    }
    detailData = {
      status: resp.reason === "found" ? "loaded" : "error",
      modelDescription: resp.model_description,
      modelDescriptionChecked: resp.model_description_checked,
      versionDescription: resp.version_description,
      gallery: Array.isArray(resp.gallery) ? resp.gallery : [],
    };
    renderDetailHost();
  }

  function openDetail(result) {
    detailResult = result;
    detailVersionId = resolveVersionView(result).primary_version_id;
    detailData = { status: "loading", gallery: [] };
    detailActionMessage = null;
    renderSwap();
    loadDetailData();
  }

  function closeDetail() {
    detailResult = null;
    detailVersionId = null;
    renderSwap();
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
    if (resetCursor) {
      // §7c-i: every reset-cursor search (button, Enter, or a filter
      // change) settles the button back to disabled for this exact text.
      // Pagination (`resetCursor: false`) never reaches this branch.
      lastSearchedQuery = query;
      updateSearchButtonState();
    }
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

  // §7c-i: "An explicit Search button, not a debounce" -- typing alone
  // never fires a search; it only updates whether the button is enabled.
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
    if (detailResult) {
      // `finished` (above) is the SAME object `detailResult` references
      // (`openDetail` is handed a result straight out of `results`, never a
      // copy) -- its own `installed`/`gated` flags are already updated by
      // the mutation above; this just repaints the visible swap to reflect it.
      renderDetailHost();
    }
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
