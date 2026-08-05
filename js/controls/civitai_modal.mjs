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
 * grid) with `model_detail_view.mjs`'s `buildModelDetailView` (its own
 * single-row, horizontally-scrolling gallery filmstrip -- see that
 * function's own `galleryTileWidth` doc comment), while the filter rail
 * stays put -- "your filters are the context you came from" -- with a
 * `← results` affordance to swap back. See
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
 * ## The Checkpoint/UNet destination selector (2026-08-05, extended same day)
 *
 * Owner report: many models -- Anima, Qwen- and Flux-family especially --
 * are typed `Checkpoint` on Civitai while shipping UNet-only weights, and
 * Civitai has no reliable field distinguishing the two. Rather than guess
 * (a heuristic on base-model name or file size would be silently wrong
 * sometimes -- worse than a visible default), the detail view's own action
 * column offers an explicit per-download choice between `models/checkpoints/`
 * and `models/diffusion_models/` whenever the result's DERIVED kind is
 * either one (`downloadKindChoices`), defaulting to that derived kind
 * (`resolveDownloadKind`) -- see `docs/lora-loader-design.md`'s own
 * subsection for the full "why no heuristic" reasoning. A `loras`-derived
 * result (or any other kind) keeps today's plain static caption unchanged --
 * there's no ambiguity to resolve there.
 *
 * **This first landed scoped to the detail view only** -- reasoned then as
 * "the only place a destination is shown at all", since the grid card's own
 * destination caption had been removed outright as noise (2026-08-01, see
 * `buildCard`'s own comment). That reasoning missed that the grid card's own
 * `↓ Download` button calls `startDownloadJob` directly, with no detour
 * through the detail view -- the fastest, most likely path (search, click
 * Download) silently kept the wrong-folder behaviour unless the user
 * happened to open the detail view first. Fixed the same day: an ambiguous
 * card (derived kind `checkpoints`/`unet`) now renders the SAME selector
 * (`buildDownloadKindSelect`, shared by both surfaces) above its own Download
 * button, via its own `cardChosenKinds` per-model_id map (`selectedVersions`'
 * own idiom, immediately below that map's declaration) -- a `loras` card, the
 * common case, is untouched: still no caption, no selector, pixel-identical.
 * The two surfaces' choices reconcile ONE direction, card -> detail
 * (`openDetail`'s own comment): opening a result's detail view seeds
 * `detailChosenKind` from that card's own choice, so picking UNet on the
 * card and then downloading from the detail view does not silently revert
 * to the derived kind; the detail view's own pre-existing "resets on
 * re-open" contract (below) is otherwise unchanged. The choice is PER
 * DOWNLOAD, never persisted -- neither map survives a fresh search
 * (`runSearch`'s own reset-cursor branch) or a modal re-open (both are
 * declared inside `openCivitaiModal`'s own closure) -- and each drives both
 * the `/download/start` payload's `kind` and the displayed destination live.
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
  queryFromModelName,
} from "./civitai_search.mjs";
import {
  searchUnscoped,
  fetchModelDetail,
  listModels,
  invalidateList,
  deleteModel,
  thumbUrl,
  lookupInfo,
} from "./civitai_api.mjs";
import { Z_MODAL } from "../shared/z_layers.mjs";
// "The detail view" -- one component, mounted twice (this modal's own
// master→detail swap, decision 11, and the picker's vertical sibling panel,
// `civitai_search.mjs`'s `openModelDetailPanel`). See that file's own top
// doc comment for the full "one component" contract.
import { buildModelDetailView, createLoadGate } from "./model_detail_view.mjs";
// The Installed tab (`docs/lora-loader-design.md` "Installed-by-kind
// section") reuses these two rather than growing a fourth naming rule/
// preview mechanism of its own -- `displayRowName`/`metaLineFor` are the
// SAME settings-aware name and size/base-model line the picker already
// renders (§1a-vii's "one setting, one rule"); neither import makes this
// file any less track-agnostic (`model_picker.mjs` is itself one of the
// reuse-boundary files, `civitai_api.mjs`'s own top doc comment).
import { displayRowName, metaLineFor } from "./model_picker.mjs";
// The type-to-confirm delete dialog -- already built, wired here rather than
// rebuilt (task brief: "both exist; wire them, do not rebuild them").
// `lookupStateView` -- the ⓘ panel's own notfound/offline WORDING (§7e),
// reused rather than a second vocabulary invented for the Installed card's
// own "no sidecar" detail state (2026-08-03 task brief) -- this file never
// imports/opens `openModelInfo` itself any more: the Installed card's ⓘ
// button is gone (owner, 2026-08-03: "the info button should not be
// there"), its click now opens the SAME master->detail swap Search cards
// already use.
import { lookupStateView } from "./model_info.mjs";
import { openDeleteConfirm, removedSummary } from "../shared/delete_confirm.mjs";
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
 * The Checkpoint/UNet ambiguity (owner report, `docs/lora-loader-design.md`'s
 * own "the modal is unscoped" section, checkpoint/unet subsection): many
 * models -- Anima, Qwen- and Flux-family especially -- are typed
 * `Checkpoint` on Civitai while shipping UNet-only weights, and there is NO
 * reliable API field distinguishing the two (`civitai_search.KIND_FOR_TYPE`'s
 * own docstring). Rather than guessing (a heuristic on base-model name or
 * file size would be silently wrong sometimes, which is worse than a visible
 * default), the detail view offers an explicit per-download choice, WHICH
 * DEFAULTS TO the backend's own derived kind.
 *
 * `kind` -> the two choices to offer, or `null` when there's no ambiguity to
 * resolve (a `loras` result, or a falsy/unmapped kind -- `resultKind`'s own
 * "never guess a folder" already handles the latter). The order is FIXED
 * (`checkpoints` before `unet`, matching `INSTALLED_KIND_ORDER`) regardless
 * of which of the two IS the derived kind -- offered symmetrically, since a
 * `UNet`-typed result runs the identical ambiguity the other way (task
 * brief: "symmetric is less code than a special case"). Never throws.
 */
export function downloadKindChoices(kind) {
  return kind === "checkpoints" || kind === "unet" ? ["checkpoints", "unet"] : null;
}

/**
 * The download-kind selector's own state resolution: given the result's
 * DERIVED kind and whatever this session's already-chosen override is (or
 * `null`/undefined for "nothing chosen yet"), the kind that actually drives
 * both the `/download/start` payload and the displayed destination. Falls
 * back to the derived kind whenever the chosen one isn't one of THIS
 * result's own offered choices (covers "never chosen" and "chosen for a
 * DIFFERENT result" alike, since the caller's chosen-kind state is a single
 * variable, not keyed per result -- see `buildDetailAction`'s own comment for
 * why that's safe). Never throws.
 */
export function resolveDownloadKind(derivedKind, chosenKind) {
  const choices = downloadKindChoices(derivedKind);
  if (choices && choices.includes(chosenKind)) {
    return chosenKind;
  }
  return derivedKind;
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
// The Installed tab (owner, 2026-07-30; placement settled 2026-08-02/03,
// `docs/lora-loader-design.md` "Installed-by-kind section") -- a SECOND top-
// level tab, peer of Search, grouped by kind. Every helper below is pure
// (no DOM) so the grouping/sorting/filtering decisions are directly testable
// without a stub DOM, matching this file's own top-of-file convention.
// ---------------------------------------------------------------------------

/** The three kinds this pack can install, in the order the Installed tab
 * shows them (`src/model_browser/kinds.py`'s own whitelist -- these are the
 * only three, and this file must never invent a fourth). A plain, swappable,
 * TOP-LEVEL constant, matching `MODEL_TYPE_OPTIONS`'s own "one place, never
 * inlined into the rendering code" convention above. */
export const INSTALLED_KIND_ORDER = ["loras", "checkpoints", "unet"];

/** Each kind's own section heading (the mockup's "LORAS"/"CHECKPOINTS"/
 * "UNET" -- rendered in whatever case; `.wtn-cm-inst-heading`'s own CSS
 * upper-cases it, so this holds the plain display form). */
export const INSTALLED_KIND_LABELS = { loras: "LoRAs", checkpoints: "Checkpoints", unet: "UNet" };

/**
 * `models`, sorted for display -- `"name"` (case-insensitive, A→Z, the
 * default) or `"size"` (largest first, the second option the task brief
 * allows "only if it is nearly free" -- it is, the same numeric compare
 * `model_picker.mjs`'s own `formatFileSize` already reads `model.size`
 * through). Never mutates `models`; garbage/non-array input degrades to
 * `[]`. A model missing the field it's being sorted by sorts as if that
 * field were empty/zero, never thrown out of the list.
 */
export function sortInstalledModels(models, sortBy) {
  const list = Array.isArray(models) ? models.slice() : [];
  if (sortBy === "size") {
    return list.sort((a, b) => (Number.isFinite(b && b.size) ? b.size : 0) - (Number.isFinite(a && a.size) ? a.size : 0));
  }
  return list.sort((a, b) => {
    const an = (a && typeof a.name === "string" ? a.name : "").toLowerCase();
    const bn = (b && typeof b.name === "string" ? b.name : "").toLowerCase();
    return an.localeCompare(bn);
  });
}

/**
 * The Installed tab's own view model: one entry per kind the user has left
 * CHECKED in the rail's "Kind" filter (`enabledKinds`), in `INSTALLED_KIND_
 * ORDER` -- an unchecked kind's whole section is omitted outright (the rail
 * filters SECTIONS, not just their contents; a kind with genuinely zero
 * files is a different, ALWAYS-shown case, below). `modelsByKind` is a plain
 * `{kind: models[]|undefined}` map -- `undefined` for a kind whose `/list`
 * fetch hasn't resolved yet THIS session (`loaded: false`, so the caller
 * renders a "Loading…" line rather than a false "no files" one); a present
 * array, even `[]`, means the fetch genuinely landed (`loaded: true`,
 * `count`/`models` reflect the real, possibly-empty, result -- "you have
 * none" is still real information, per the task brief, so this never
 * collapses an empty KIND out of the list the way an unchecked kind does).
 * `models` is already sorted (`sortInstalledModels`). Never throws on
 * garbage `modelsByKind`/`enabledKinds`.
 */
export function installedSections(modelsByKind, enabledKinds, sortBy) {
  const enabled = new Set(Array.isArray(enabledKinds) ? enabledKinds : []);
  const src = modelsByKind && typeof modelsByKind === "object" ? modelsByKind : {};
  return INSTALLED_KIND_ORDER.filter((kind) => enabled.has(kind)).map((kind) => {
    const raw = src[kind];
    const loaded = Array.isArray(raw);
    return {
      kind,
      label: INSTALLED_KIND_LABELS[kind] || kind,
      loaded,
      count: loaded ? raw.length : 0,
      models: loaded ? sortInstalledModels(raw, sortBy) : [],
    };
  });
}

// ---------------------------------------------------------------------------
// CSS -- 90% viewport, centred, over a scrim (deliberately NOT the Rule
// Builder's own full-bleed `position: fixed; inset: 0` geometry -- see
// `openCivitaiModal`'s own doc comment for why that distinction is load-
// bearing, not a style nit).
// ---------------------------------------------------------------------------

const CSS = `
.wtn-cm-scrim {
  position: fixed; inset: 0; z-index: ${Z_MODAL};
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
/* The Checkpoint/UNet download-kind selector (\`downloadKindChoices\`'s own doc
   comment) -- carries \`.wtn-cm-dest\`'s own tone (above) PLUS this width/
   sizing rule, the SAME "full width, box-sizing border-box" convention
   \`.wtn-cm-version-sel\` already gives the per-card version picker; \`wtn-
   select\` (also on the element) is what supplies the shared 26px control
   height every select in this track inherits. */
.wtn-cm-dest-select { width: 100%; box-sizing: border-box; }
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

/* The Installed tab (docs/lora-loader-design.md "Installed-by-kind
   section"). Search | Installed live where the modal's own title used to --
   a plain segmented tab pair, not a second header row (matches the rest of
   this modal's own "no extra chrome" convention, D1/D5 above). */
.wtn-cm-tabs { display: flex; gap: 6px; }
.wtn-cm-tab {
  font: 12px var(--wtn-font-ui, inherit); font-weight: 600; padding: 5px 12px; border-radius: 7px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  cursor: pointer; appearance: none; -webkit-appearance: none;
}
.wtn-cm-tab-active {
  background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent});
  border-color: var(--wtn-accent, ${TOKENS.accent});
}
.wtn-cm-kind-checks { display: flex; flex-direction: column; gap: 6px; }
.wtn-cm-kind-check { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; }
/* One heading per kind, in INSTALLED_KIND_ORDER -- uppercase via CSS
   (INSTALLED_KIND_LABELS itself holds the plain-case form) so the JS side
   never hand-cases a display string. */
.wtn-cm-inst-heading {
  font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); margin: 16px 0 8px;
}
.wtn-cm-inst-heading:first-child { margin-top: 0; }
/* Delete -- mirrors civitai_search.mjs's own .wtn-cs-action-delete
   verbatim (a duplicated copy, this file's own "every render module keeps
   its own" convention, this file's top doc comment). */
.wtn-cm-action-delete { background: transparent; border-color: rgba(248,113,113,.4); color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-cm-action-delete:hover { border-color: var(--wtn-bad, ${TOKENS.bad}); }

/* The Installed tab's own "checking Civitai..."/notfound/offline state
   (2026-08-03, renderInstalledLookupHost) -- a plain, minimal box, since
   this is a rarer, transient state (a file with no sidecar yet), not the
   full detail view. */
.wtn-cm-lookupbox { display: flex; flex-direction: column; gap: 8px; padding: 16px; max-width: 480px; }
.wtn-cm-lookup-headline { font-weight: 600; font-size: 13px; }
.wtn-cm-lookup-why { font-size: 12px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
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

/**
 * Builds the Checkpoint/UNet destination `<select>` (`downloadKindChoices`'s
 * own doc comment) -- the ONE DOM builder for this control, extended
 * 2026-08-05 to be shared by the grid card (`buildCard`) AND the detail
 * view's own action column (`buildDetailAction`), rather than each keeping
 * its own copy of the same option-building loop (task brief: "reuse the
 * exported `downloadKindChoices`/`resolveDownloadKind` and the
 * `.wtn-cm-dest-select` styling... do not write a second copy of that
 * logic"). `onChange(value)` is the caller's own state write (a card's
 * per-model_id map entry, or the detail view's single `detailChosenKind`) --
 * this function holds none of that state itself, matching every other DOM
 * builder in this file (`buildChipFilterSection`, `buildSingleSelectRow`).
 */
function buildDownloadKindSelect(doc, kindChoices, chosenKind, onChange) {
  const dest = el(doc, "select", "wtn-select wtn-cm-dest wtn-cm-dest-select");
  dest.title = "Civitai marks this ambiguously between a full checkpoint and UNet-only weights -- choose where it actually installs.";
  for (const choice of kindChoices) {
    const opt = el(doc, "option");
    opt.value = choice;
    opt.textContent = destinationLabelForKind(choice);
    if (choice === chosenKind) {
      opt.selected = true;
    }
    dest.appendChild(opt);
  }
  dest.value = chosenKind;
  dest.addEventListener("click", (e) => e.stopPropagation());
  dest.addEventListener("change", (e) => {
    e.stopPropagation();
    onChange(dest.value);
  });
  return dest;
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
  //
  // Search | Installed (`docs/lora-loader-design.md` "Installed-by-kind
  // section", placement settled 2026-08-02/03) -- the tab pair now sits
  // where the plain "Browse Civitai" title used to; Installed is a PEER of
  // Search, not a filter of it (task brief), so this is two tab buttons, not
  // a second header row. `setActiveTab`, below (after both tabs' own rail/
  // main DOM exist), is the only thing that ever toggles between them.
  const tabStrip = el(targetDoc, "div", "wtn-cm-tabs");
  const searchTabBtn = el(targetDoc, "button", "wtn-cm-tab wtn-cm-tab-active");
  searchTabBtn.type = "button";
  searchTabBtn.textContent = "Search";
  tabStrip.appendChild(searchTabBtn);
  const installedTabBtn = el(targetDoc, "button", "wtn-cm-tab");
  installedTabBtn.type = "button";
  installedTabBtn.textContent = "Installed";
  tabStrip.appendChild(installedTabBtn);
  head.appendChild(tabStrip);
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

  // ---- the Installed tab (docs/lora-loader-design.md "Installed-by-kind
  // section") -- a SECOND rail + SECOND main column, siblings of the two
  // above; `setActiveTab` (below `close()`'s own definition, once every
  // element it toggles exists) is the only thing that ever shows/hides
  // either pair. Building both up front, hidden, rather than mounting one
  // lazily on first switch is what makes "switching tabs preserves the
  // Search query/results/download" (task brief) true for free -- nothing
  // about Search's own DOM or state is ever rebuilt or touched by a tab
  // switch, only `style.display`. -----------------------------------------

  const installedRail = el(targetDoc, "div", "wtn-cm-rail");
  installedRail.style.display = "none";
  body.appendChild(installedRail);

  // The rail's own "Kind"/"Sort" state -- session-local (not persisted to a
  // setting, unlike Search's own filters), matching the task brief's own
  // placement table: these two are Installed's own controls, not a saved
  // preference the way Search's rail sections are.
  const installedFilters = { kinds: new Set(INSTALLED_KIND_ORDER), sort: "name" };

  const kindChecksWrap = el(targetDoc, "div", "wtn-cm-kind-checks");
  for (const kind of INSTALLED_KIND_ORDER) {
    const kindLabel = el(targetDoc, "label", "wtn-cm-kind-check");
    const cb = el(targetDoc, "input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => {
      e.stopPropagation();
      if (cb.checked) {
        installedFilters.kinds.add(kind);
      } else {
        installedFilters.kinds.delete(kind);
      }
      renderInstalled();
    });
    kindLabel.appendChild(cb);
    const kindLabelText = el(targetDoc, "span");
    kindLabelText.textContent = INSTALLED_KIND_LABELS[kind] || kind;
    kindLabel.appendChild(kindLabelText);
    kindChecksWrap.appendChild(kindLabel);
  }
  installedRail.appendChild(buildRailSection(targetDoc, "Kind", kindChecksWrap));

  const installedSortSel = buildSingleSelectRow(targetDoc, ["name", "size"], installedFilters.sort, (v) => {
    installedFilters.sort = v;
    renderInstalled();
  }, (value) => (value === "size" ? "Size" : "Name"));
  installedRail.appendChild(buildRailSection(targetDoc, "Sort", installedSortSel));

  const installedMain = el(targetDoc, "div", "wtn-cm-main wtn-flex-bound");
  installedMain.style.display = "none";
  body.appendChild(installedMain);

  const installedGridWrap = el(targetDoc, "div", "wtn-cm-gridwrap");
  installedMain.appendChild(installedGridWrap);

  // The Installed tab's OWN master->detail swap host -- a SIBLING of
  // `installedGridWrap` within `installedMain` (2026-08-03, "an Installed
  // card opens the detail view same as in search"), mirroring Search's own
  // `detailHost`/`gridWrap` pair one level up rather than reusing THAT one:
  // `detailHost` lives inside Search's own `main`, which is itself hidden
  // (`style.display: none`) whenever the Installed tab is active, so
  // anything painted into it would be invisible while this tab is showing.
  // Requirement #5 ("returning from detail lands back on Installed, with its
  // kind filters/sort intact, never on Search") holds for free from this:
  // the swap only ever toggles `installedGridWrap`/`installedDetailHost`,
  // never touches `installedRail` (the Kind checks/Sort select) or which
  // tab/rail pair `setActiveTab` shows.
  const installedDetailHost = el(targetDoc, "div", "wtn-cm-detailhost wtn-flex-bound");
  installedDetailHost.style.display = "none";
  installedMain.appendChild(installedDetailHost);

  // Per-kind local-file list -- `undefined` until that kind's `/list` fetch
  // has resolved THIS modal-open (`installedSections`'s own "loaded"
  // distinction: "not fetched yet" renders a "Loading…" line, never a false
  // "no files" one). A plain object holding THIS tab's own snapshot, never
  // read from `civitai_api.mjs`'s module-level cache directly at render
  // time -- only ever replaced wholesale by `fetchInstalledKind`/
  // `refreshInstalledKind` (below), once a real fetch has actually landed.
  // That is what keeps this tab immune to `civitaiNameFor`'s own tri-state
  // "cache just invalidated, not yet repopulated" window (`civitai_api.mjs`'s
  // own doc comment): there is no render in between invalidate and refetch
  // that this object could ever observe, because nothing writes to it until
  // the refetch itself resolves.
  const installedModels = { loras: undefined, checkpoints: undefined, unet: undefined };
  // A SEPARATE generation counter from the Search grid's own
  // `renderGeneration` (below) -- switching tabs must never abandon a
  // Search-tab thumbnail's in-flight retry chain, and vice versa; each tab
  // owns its own "is this render pass still current" counter.
  let installedRenderGeneration = 0;

  // The Installed tab's own master->detail swap state (2026-08-03) --
  // mirrors Search's own `detailResult`/`detailVersionId`/`detailData`
  // trio, below, one level up: `installedDetailResult` non-null means "the
  // detail view is showing"; `installedLookupPhase` non-null is the OTHER
  // way this tab can be in detail mode -- a card with no known ids yet,
  // mid- or post- its own by-hash lookup ("loading"/"notfound"/"offline").
  // Never both non-null at once: `openInstalledDetail`/`runInstalledLookup`/
  // `closeInstalledDetail` each clear the other's state before setting their
  // own.
  let installedDetailResult = null;
  let installedDetailVersionId = null;
  let installedDetailData = { status: "loading", gallery: [] };
  let installedLookupPhase = null; // null | "loading" | "notfound" | "offline"
  let installedLookupResponse = null;
  let installedLookupKind = null;
  let installedLookupModel = null;

  function fetchInstalledKind(kind) {
    return listModels(kind).then((models) => {
      installedModels[kind] = models;
      if (activeTab === "installed") {
        renderInstalled();
      }
    });
  }

  /** Invalidate-then-refetch-then-rerender (task brief item 1; `d255da3`'s
   * own half-fix, and `lora_interaction.mjs:321-322`'s `refreshLoraModels`
   * is the exact pattern this follows): `invalidateList` alone leaves the
   * client-side list cache empty until SOMETHING re-fetches it, so a delete
   * must always be followed by a real `listModels(kind, true)` and a
   * re-render, never the invalidate alone. */
  function refreshInstalledKind(kind) {
    invalidateList(kind);
    return listModels(kind, true).then((models) => {
      installedModels[kind] = models;
      if (activeTab === "installed") {
        renderInstalled();
      }
    });
  }

  /** The pseudo search-RESULT `model_detail_view.mjs`'s `buildModelDetailView`
   * renders for an Installed card (2026-08-03) -- shaped exactly like a
   * flattened Search result (`civitai_search.mjs`'s own `resolveVersionView`
   * output: `model_id`/`primary_version_id`/`kind`/`name`/`base_model`/
   * `triggers`/`images`/`installed`/...), so the SAME `buildModelDetailView`
   * + `buildDetailAction` this file already uses for Search renders it with
   * no third, divergent code path. `installed: true` unconditionally --
   * this is only ever built for a file already on disk -- which is what
   * makes `resultCardState` resolve to `"installed"` (a green "✓ installed"
   * badge, never a download button: there is nothing to download, it's
   * already here).
   *
   * `data`, when given, is a `lookupInfo` "found" response's own `data`
   * (§2b's `parse_model_version` shape) -- richer than a bare `/list` row
   * (it can carry `tags`/`images`/a fresher `name`/`base_model`), so its
   * fields win when present; the `/list` row's own fields (`model`, always
   * available) are the fallback for everything `data` doesn't carry. `null`
   * for the "already had ids from `/list`" path, where there is no such
   * response at all.
   */
  function buildInstalledDetailResult(kind, model, data) {
    const info = data && typeof data === "object" ? data : {};
    const modelId = Number.isFinite(info.model_id) ? info.model_id : model.model_id;
    const versionId = Number.isFinite(info.version_id) ? info.version_id : model.version_id;
    const name = (typeof info.name === "string" && info.name.trim())
      || model.civitai_name
      || model.name;
    return {
      model_id: modelId,
      primary_version_id: versionId,
      kind,
      name,
      type: typeof info.type === "string" ? info.type : "",
      creator: null,
      stats: null,
      base_model: (typeof info.base_model === "string" && info.base_model) || model.base_model || "",
      triggers: Array.isArray(info.triggers) ? info.triggers : (Array.isArray(model.triggers) ? model.triggers : []),
      tags: Array.isArray(info.tags) ? info.tags : [],
      images: Array.isArray(info.images) ? info.images : [],
      file_name: null,
      download_url: null,
      size_kb: null,
      gated: false,
      installed: true,
    };
  }

  /** Swaps the Installed tab's own grid for its own detail view (or its own
   * "checking Civitai…"/notfound/offline state) -- the Installed tab's
   * mirror of `renderSwap`, below, one level up. The Kind/Sort rail
   * (`installedRail`) is untouched either way -- "your filters are the
   * context you came from," same rule Search's own swap already follows. */
  function renderInstalledSwap() {
    const inDetail = installedDetailResult != null || installedLookupPhase != null;
    installedGridWrap.style.display = inDetail ? "none" : "";
    installedDetailHost.style.display = inDetail ? "" : "none";
    if (!inDetail) {
      installedDetailHost.innerHTML = "";
      return;
    }
    if (installedDetailResult != null) {
      renderInstalledDetailHost();
    } else {
      renderInstalledLookupHost();
    }
  }

  function renderInstalledDetailHost() {
    installedDetailHost.innerHTML = "";
    if (!installedDetailResult) {
      return;
    }
    const built = buildModelDetailView({
      // `galleryTileWidth`/`communityTileWidth` both omitted -- same "use
      // the modal's existing defaults, don't invent a third mount's worth
      // of numbers" rule `renderDetailHost` (below) already follows.
      doc: targetDoc, result: installedDetailResult, versionId: installedDetailVersionId,
      fontSizePx: modalFontSizePx(),
      browsingLevel: levelLabelToInt(currentFilters.level), detail: installedDetailData,
      // `buildDetailAction` -- the SAME action-column builder Search's own
      // detail view uses, unmodified: `installedDetailResult.installed` is
      // always `true` here, so `resultCardState` resolves to `"installed"`
      // and this renders the identical green badge a Search card shows for
      // a model already on disk -- no second "you have this" affordance
      // invented for the same fact.
      buildActionEl: buildDetailAction,
      onVersionChange: (id) => {
        installedDetailVersionId = id;
        loadInstalledDetailData();
      },
      onBack: closeInstalledDetail,
      fixedTopBar: true,
    });
    installedDetailHost.appendChild(built.el);
  }

  async function loadInstalledDetailData() {
    if (!installedDetailResult) {
      return;
    }
    const modelId = installedDetailResult.model_id;
    const versionId = installedDetailVersionId;
    installedDetailData = {
      status: "loading", gallery: [],
      modelDescription: installedDetailData.modelDescription,
      modelDescriptionChecked: installedDetailData.modelDescriptionChecked,
    };
    renderInstalledDetailHost();
    const resp = await fetchModelDetail(modelId, versionId);
    // Discard a stale reply -- the user closed the detail view, or switched
    // to a DIFFERENT installed model/version, while this fetch was in flight.
    if (!installedDetailResult || installedDetailResult.model_id !== modelId || installedDetailVersionId !== versionId) {
      return;
    }
    installedDetailData = {
      status: resp.reason === "found" ? "loaded" : "error",
      modelDescription: resp.model_description,
      modelDescriptionChecked: resp.model_description_checked,
      versionDescription: resp.version_description,
      gallery: Array.isArray(resp.gallery) ? resp.gallery : [],
    };
    renderInstalledDetailHost();
  }

  /** Opens the Installed tab's own detail view for `model` (a `/list` row)
   * -- called either straight from a card click (`data` omitted, ids
   * already known from `/list`) or once `runInstalledLookup`'s own by-hash
   * lookup resolves `found` (`data` is that response's own parsed record). */
  function openInstalledDetail(kind, model, data) {
    installedLookupPhase = null;
    installedLookupResponse = null;
    installedLookupKind = null;
    installedLookupModel = null;
    installedDetailResult = buildInstalledDetailResult(kind, model, data);
    installedDetailVersionId = installedDetailResult.primary_version_id;
    installedDetailData = { status: "loading", gallery: [] };
    renderInstalledSwap();
    loadInstalledDetailData();
  }

  function closeInstalledDetail() {
    installedDetailResult = null;
    installedDetailVersionId = null;
    installedLookupPhase = null;
    installedLookupResponse = null;
    installedLookupKind = null;
    installedLookupModel = null;
    renderInstalledSwap();
  }

  /** The "no sidecar yet" click path (task brief, 2026-08-03): a file we've
   * never identified carries no `model_id`/`version_id` on its `/list` row
   * at all, so there is nothing to open a detail view WITH yet -- this runs
   * the SAME by-hash lookup the (now-removed) ⓘ panel used
   * (`lookupInfo`, `civitai_api.mjs`), showing the detail host's own
   * loading state while it runs (a hash lookup on a multi-GB checkpoint is
   * not instant), then:
   *   - `found` (with a usable version id) -> we now have ids; open the
   *     detail view exactly as the "already had ids" path does, just fed
   *     this response's own richer data instead of `null`;
   *   - `notfound`/`offline` (or a `found` with no usable version id at all,
   *     an edge case even rarer than a genuine miss) -> render that state in
   *     the detail host, reusing `model_info.mjs`'s own `lookupStateView`
   *     wording/actions (`renderInstalledLookupHost`, below) rather than a
   *     second, invented vocabulary.
   *
   * This is an explicit card click, never fired on render or on hover
   * (§9's "network only on an explicit action") -- see `buildInstalledCard`'s
   * own click listener, the only caller.
   */
  function runInstalledLookup(kind, model) {
    installedDetailResult = null;
    installedLookupPhase = "loading";
    installedLookupResponse = null;
    installedLookupKind = kind;
    installedLookupModel = model;
    renderInstalledSwap();
    lookupInfo(kind, model.name).then((resp) => {
      // Stale guard -- the user may have closed this detail, or clicked a
      // DIFFERENT card, before a slow hash lookup on a large file resolves.
      if (installedLookupKind !== kind || installedLookupModel !== model || installedLookupPhase !== "loading") {
        return;
      }
      if (resp.reason === "found" && resp.data && Number.isFinite(resp.data.version_id)) {
        openInstalledDetail(kind, model, resp.data);
        return;
      }
      // A "found" with no usable version id can't open a detail view either
      // -- there is nothing to fetch by -- so it degrades to the SAME
      // honest "not found" wording as a genuine miss, rather than a third
      // vocabulary for a corner case `model_info.mjs`'s own states never
      // had to name.
      installedLookupResponse = resp.reason === "found"
        ? { reason: "notfound", offline_reason: null, message: "" }
        : resp;
      installedLookupPhase = resp.reason === "offline" ? "offline" : "notfound";
      renderInstalledSwap();
    });
  }

  /** Renders the Installed tab's own "checking Civitai…"/notfound/offline
   * state -- `lookupStateView` (`model_info.mjs`) supplies the icon/
   * headline/why/actions verbatim (task brief: "reusing model_info.mjs's
   * existing wording... rather than inventing a second vocabulary"); this
   * function only wires the two actions that can ever apply here
   * (`search-by-name`/`retry` -- `lookupStateView`'s other action ids,
   * `cancel`/`check`/`forget`, belong to states this surface never reaches:
   * there is no in-flight cancel button for a plain `await`, no "not checked
   * yet" resting state since a click always runs the lookup immediately, and
   * no cached sidecar to forget when the whole POINT of this branch is that
   * there wasn't one). */
  function renderInstalledLookupHost() {
    installedDetailHost.innerHTML = "";
    const backBtn = el(targetDoc, "button", "wtn-cm-action");
    backBtn.type = "button";
    backBtn.textContent = "← back to results";
    backBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeInstalledDetail();
    });
    installedDetailHost.appendChild(backBtn);

    if (installedLookupPhase === "loading") {
      const msg = el(targetDoc, "div", "wtn-cm-empty");
      msg.textContent = "Checking Civitai…";
      installedDetailHost.appendChild(msg);
      return;
    }

    const view = lookupStateView({ phase: "result", response: installedLookupResponse || {} });
    if (!view) {
      return;
    }
    const box = el(targetDoc, "div", "wtn-cm-lookupbox");
    const headline = el(targetDoc, "div", "wtn-cm-lookup-headline");
    headline.textContent = `${view.icon} ${view.headline}`;
    box.appendChild(headline);
    const why = el(targetDoc, "div", "wtn-cm-lookup-why");
    why.textContent = view.why;
    box.appendChild(why);
    for (const action of view.actions || []) {
      if (action.id !== "search-by-name" && action.id !== "retry") {
        continue;
      }
      const btn = el(targetDoc, "button", "wtn-cm-action");
      btn.type = "button";
      btn.textContent = action.label;
      if (action.title) {
        btn.title = action.title;
      }
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (action.id === "search-by-name") {
          // Hands off to THIS modal's own Search tab, pre-filled with a
          // cheap, non-clever guess at the model's real name
          // (`civitai_search.mjs`'s own `queryFromModelName`, the SAME
          // guess `lora_interaction.mjs`'s own `onSearchByName` already
          // uses) -- never a second search surface opened on top of this
          // one, since the modal already has its own.
          const kindForSearch = installedLookupKind;
          const modelForSearch = installedLookupModel;
          closeInstalledDetail();
          setActiveTab("search");
          search.value = queryFromModelName(modelForSearch ? modelForSearch.name : "");
          updateSearchButtonState();
          logSummary("Civitai browser", `installed "${kindForSearch}:${modelForSearch ? modelForSearch.name : ""}" not found by hash -- searching by name`);
          runSearch({ resetCursor: true });
        } else if (action.id === "retry") {
          runInstalledLookup(installedLookupKind, installedLookupModel);
        }
      });
      box.appendChild(btn);
    }
    installedDetailHost.appendChild(box);
  }

  function buildInstalledCard(kind, model, thumbGate) {
    const card = el(targetDoc, "div", "wtn-cm-card wtn-cm-inst-card");
    const gen = installedRenderGeneration;
    const isStale = () => gen !== installedRenderGeneration;

    const thumb = el(targetDoc, "div", "wtn-cm-thumb");
    card.appendChild(thumb);
    // The local preview route (`thumbUrl`, `civitai_api.mjs`) is fully
    // offline -- never level-filtered (§7c-iv: "never what the user already
    // has locally"), unlike a Civitai-sourced thumbnail. Only ONE candidate
    // URL ever exists for a local file (unlike a search result's own
    // ordered gallery), but this still goes through the shared retry-then-
    // advance/skeleton machinery (`attachThumbCandidate`) behind the SAME
    // concurrency gate every other gallery in this pack uses (task brief
    // item 3) -- three kinds' worth of cards requesting their previews at
    // once is the most image traffic this modal will ever make.
    if (model && model.has_preview) {
      const skeleton = el(targetDoc, "span", THUMB_SKELETON_CLASS);
      thumb.appendChild(skeleton);
      const clearSkeleton = (t) => {
        if (skeleton.parentNode === t && typeof t.removeChild === "function") {
          t.removeChild(skeleton);
        }
      };
      thumbGate.schedule((release) => {
        if (isStale()) {
          release();
          return;
        }
        attachThumbCandidate(targetDoc, thumb, [thumbUrl(kind, model.name)], { index: 0, retried: false }, isStale, thumbRetryBackoffMs, (d, t) => {
          clearSkeleton(t);
          t.appendChild(el(d, "span", "wtn-cm-thumb-ph"));
          release();
        }, (d, t) => {
          clearSkeleton(t);
          release();
        });
      });
    } else {
      // `has_preview: false` -- the SAME placeholder the picker already
      // uses (task brief: "do not invent a second one"), shown immediately,
      // no gate/network involved at all.
      thumb.appendChild(el(targetDoc, "span", "wtn-cm-thumb-ph"));
    }

    const title = el(targetDoc, "div", "wtn-cm-title");
    // `model.civitai_name` read straight off THIS already-fetched `/list`
    // entry -- never `civitaiNameFor`'s own tri-state cache lookup (see
    // `installedModels`'s own doc comment, above, for why that's safe here).
    // `displayRowName` is the ONE settings-aware seam every name in this
    // pack paints through (§1a-vii), so "Hide file extension"/"Show Civitai
    // name" apply here exactly as everywhere else.
    const shownName = displayRowName(model.name, model.civitai_name);
    title.textContent = shownName;
    title.title = model.name; // ALWAYS the real file name, regardless of what's displayed
    card.appendChild(title);

    const meta = el(targetDoc, "div", "wtn-cm-sub");
    // `metaLineFor` -- the picker's OWN size/base-model line ("144 MB · SDXL"
    // normally, "no preview" for a preview-less file) -- reused verbatim
    // (task brief: "matching the picker's own layout"), not re-derived.
    meta.textContent = metaLineFor(model);
    card.appendChild(meta);

    const actionCol = el(targetDoc, "div", "wtn-cm-actioncol");

    // No ⓘ button any more (owner, 2026-08-03: "the info button should not
    // be there, clicking the card open the detail page same as in search")
    // -- Delete is the ONLY action left in this column; the card's own body
    // click, below, is what opens the detail view now.
    const deleteBtn = el(targetDoc, "button", "wtn-cm-action wtn-cm-action-delete");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Delete";
    deleteBtn.title = "Delete this file from disk.";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteConfirm({
        doc: targetDoc,
        kind,
        name: model.name,
        sizeBytes: Number.isFinite(model.size) ? model.size : null,
        deleteFn: deleteModel,
        onDeleted: (delResult) => {
          logSummary("Civitai browser", `deleted ${model.name} (${removedSummary(delResult.removed)})`);
          refreshInstalledKind(kind);
        },
      });
    });
    actionCol.appendChild(deleteBtn);

    card.appendChild(actionCol);

    // The card's own body opens the detail view -- the SAME master->detail
    // swap a Search card's click already opens (task brief: "clicking the
    // card open the detail page same as in search"). `deleteBtn`'s own click
    // listener above already `stopPropagation`s, so this only ever fires
    // for the card's own thumb/title/meta. A card whose ids are already
    // known (this file's own sidecar had them, `local.list_models`'s
    // `model_id`/`version_id`) opens straight into the detail view; one that
    // doesn't runs the by-hash lookup first (`runInstalledLookup`, above).
    card.addEventListener("click", (e) => {
      e.stopPropagation();
      if (Number.isFinite(model && model.model_id) && Number.isFinite(model && model.version_id)) {
        openInstalledDetail(kind, model, null);
      } else {
        runInstalledLookup(kind, model);
      }
    });
    return card;
  }

  /** Repaints the Installed tab from `installedModels`/`installedFilters` --
   * rebuilt wholesale on every call (matches this file's own `renderGrid`
   * convention), never partially patched. */
  function renderInstalled() {
    installedRenderGeneration += 1;
    installedGridWrap.innerHTML = "";
    const sections = installedSections(installedModels, [...installedFilters.kinds], installedFilters.sort);
    if (!sections.length) {
      const msg = el(targetDoc, "div", "wtn-cm-empty");
      msg.textContent = "No kinds selected.";
      installedGridWrap.appendChild(msg);
      return;
    }
    // ONE gate for the whole render pass, shared across every kind's own
    // cards (task brief item 3) -- caps TOTAL concurrent thumbnail loads
    // across all three kinds together, not per kind.
    const thumbGate = createLoadGate(4);
    for (const section of sections) {
      const heading = el(targetDoc, "div", "wtn-cm-inst-heading");
      heading.textContent = `${section.label} (${section.count})`;
      installedGridWrap.appendChild(heading);
      if (!section.loaded) {
        const msg = el(targetDoc, "div", "wtn-cm-empty");
        msg.textContent = "Loading…";
        installedGridWrap.appendChild(msg);
        continue;
      }
      if (!section.models.length) {
        // A kind with genuinely zero files still gets its heading (above)
        // plus this quiet empty line -- "you have none" is real information,
        // not a silently missing section (task brief).
        const msg = el(targetDoc, "div", "wtn-cm-empty");
        msg.textContent = "No files.";
        installedGridWrap.appendChild(msg);
        continue;
      }
      const grid = el(targetDoc, "div", "wtn-cm-grid");
      for (const model of section.models) {
        grid.appendChild(buildInstalledCard(section.kind, model, thumbGate));
      }
      installedGridWrap.appendChild(grid);
    }
  }

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
  // The Checkpoint/UNet ambiguity's per-download override (`downloadKindChoices`'s
  // own doc comment) -- `null` means "nothing chosen yet, use the derived kind"
  // (`resolveDownloadKind`'s own fallback). Deliberately a SINGLE variable, not
  // a per-model_id map like `selectedVersions` below: the choice is per
  // DOWNLOAD, never persisted (task brief), so a fresh detail-view open with
  // no card-level choice to seed from (see `cardChosenKinds`, immediately
  // below, and `openDetail`'s own comment) still resets to `null` -- there is
  // nothing to remember across a re-open with no card selection behind it.
  let detailChosenKind = null;
  // The SAME ambiguity's per-CARD choice (2026-08-05, follow-up to a973001:
  // "the grid card can still download with no destination choice -- the
  // primary path") -- a `model_id -> chosen kind` map, the SAME per-card-
  // state idiom `selectedVersions` (below) already uses, since the GRID
  // shows many results at once and each needs its own independent choice
  // (unlike the detail view's deliberately-single `detailChosenKind`, above).
  // Cleared on every fresh search (`runSearch`'s own reset-cursor branch) --
  // never a stored setting -- and never survives a modal re-open either,
  // since it's declared inside this closure. `openDetail`, below, seeds
  // `detailChosenKind` from THIS map's own entry for the clicked result (if
  // any) rather than always starting blank, so a choice made on the card is
  // not silently discarded on opening its detail view -- see `openDetail`'s
  // own comment for the full reconciliation this decision makes (one
  // direction only: card -> detail, not the reverse).
  const cardChosenKinds = new Map();
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
      //
      // The Checkpoint/UNet ambiguity's ACTIONABLE selector (2026-08-05,
      // follow-up to a973001) is a different thing from that removed
      // caption -- it renders ONLY for the two derived kinds that are
      // actually ambiguous (`downloadKindChoices`, `null` for everything
      // else including `loras`), so every non-ambiguous card here stays
      // pixel-identical to before. `buildDownloadKindSelect` is the SAME DOM
      // builder the detail view's own action column uses (its own doc
      // comment); `chosenKind`, not `kind`, is what actually drives the
      // download below.
      const kindChoices = downloadKindChoices(kind);
      const chosenKind = resolveDownloadKind(kind, cardChosenKinds.get(result.model_id));
      if (kindChoices) {
        const destSel = buildDownloadKindSelect(targetDoc, kindChoices, chosenKind, (value) => {
          cardChosenKinds.set(result.model_id, value);
          renderGrid();
        });
        actionCol.appendChild(destSel);
      }
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
          kind: chosenKind, subfolder: "", filename: view.file_name, downloadUrl: view.download_url, sizeKb: view.size_kb,
          key: rKey, civitaiMeta, previewUrl,
        }, pollIntervalMs);
        if (resp.reason !== "started") {
          cardMessages.set(rKey, downloadStartMessage(resp));
          logSummary("Civitai browser", `download NOT started: ${view.file_name} (${resp.reason})`);
        } else {
          logSummary("Civitai browser", `download started: ${view.file_name} (${chosenKind})`);
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
  // the actual content (`buildModelDetailView`, its own default 200px gallery
  // tile -- this mount never overrides `galleryTileWidth`, unlike the
  // picker's narrower panel); everything here is this MOUNT's own wiring:
  // which half of `main` is visible, the
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
    //
    // The Checkpoint/UNet ambiguity (`downloadKindChoices`'s own doc comment)
    // -- a `checkpoints`/`unet`-DERIVED result gets a small `<select>`
    // offering both, defaulting to the derived kind, INSTEAD of the plain
    // static caption every other kind (`loras`) still gets. `chosenKind` is
    // what actually drives the download's `kind` below AND the caption/select
    // text -- never just a display-only choice.
    const kindChoices = downloadKindChoices(detailKind);
    const chosenKind = resolveDownloadKind(detailKind, detailChosenKind);
    // `buildDownloadKindSelect` -- the SAME DOM builder the grid card's own
    // action column uses (its own doc comment, above `buildCard`) -- keeps
    // this the ONE place the <select>'s markup exists, 2026-08-05.
    const dest = kindChoices
      ? buildDownloadKindSelect(doc, kindChoices, chosenKind, (value) => {
        detailChosenKind = value;
        renderDetailHost();
      })
      : el(doc, "div", "wtn-cm-dest");
    if (!kindChoices) {
      dest.textContent = destinationLabelForKind(chosenKind);
    }
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
        kind: chosenKind, subfolder: "", filename: view.file_name, downloadUrl: view.download_url, sizeKb: view.size_kb,
        key: rKey, civitaiMeta, previewUrl: previewCandidates.length > 0 ? previewCandidates[0] : null,
      }, pollIntervalMs);
      if (resp.reason !== "started") {
        detailActionMessage = downloadStartMessage(resp);
        logSummary("Civitai browser", `download NOT started: ${view.file_name} (${resp.reason})`);
      } else {
        logSummary("Civitai browser", `download started: ${view.file_name} (${chosenKind})`);
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

  // This modal's own base font size for the detail view
  // (`model_detail_view.mjs`'s own `fontSizePx` parameter) -- a SEPARATE
  // setting id from the picker's own (`civitai_search.mjs`'s
  // `panelFontSizePx`), because the modal is wide while the picker's own
  // panel is only ~396px (owner, 2026-08-02: "yes for our panel we should
  // have different set then the browser modal"). Read fresh per render.
  function modalFontSizePx() {
    return getSetting(SETTING_IDS.CIVITAI_DETAIL_MODAL_FONT_SIZE, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_DETAIL_MODAL_FONT_SIZE]);
  }

  function renderDetailHost() {
    detailHost.innerHTML = "";
    if (!detailResult) {
      return;
    }
    const built = buildModelDetailView({
      // `galleryTileWidth`/`communityTileWidth` both omitted -- this mount
      // wants the function's own 200px/140px defaults (this file's own
      // comment above, "The master→detail swap"), unlike the picker's
      // narrower panel (`civitai_search.mjs`'s own `DETAIL_PANEL_GALLERY_
      // TILE_PX`/`DETAIL_PANEL_COMMUNITY_TILE_PX`).
      doc: targetDoc, result: detailResult, versionId: detailVersionId,
      fontSizePx: modalFontSizePx(),
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
    // Reconciliation (2026-08-05, follow-up to a973001): seed the detail
    // view's own choice from whatever THIS card already has chosen
    // (`cardChosenKinds`), rather than unconditionally resetting to the
    // derived kind -- "if a user picks UNet on the card... downloads from
    // there, the choice should not silently revert." A result whose card was
    // never touched (or has no ambiguity at all) has no entry here, so this
    // is `undefined` -> `?? null` -> `resolveDownloadKind`'s own "nothing
    // chosen yet" fallback, exactly the prior behaviour. Deliberately ONE
    // direction only (card -> detail): switching the selector INSIDE the
    // detail view, then leaving and re-entering it WITHOUT touching the
    // card, still resets to the derived kind -- the pre-existing, still-
    // tested "per-download, not persisted" contract for the detail view's
    // own re-open path is unchanged; only a card-level choice carries
    // forward.
    detailChosenKind = cardChosenKinds.get(result.model_id) ?? null;
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
      // The per-card Checkpoint/UNet choice is per-download, never a stored
      // preference (`cardChosenKinds`'s own doc comment) -- a genuinely NEW
      // search (never a `resetCursor: false` pagination fetch) must not let
      // a stale choice from the previous result set silently carry over,
      // even if a model of the SAME id happens to reappear.
      cardChosenKinds.clear();
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

  // ---- Search | Installed tab switching -----------------------------------
  // `activeTab` is the single source of truth `setActiveTab` reads/writes;
  // switching only ever toggles `style.display` on the four rail/main
  // elements built above -- Search's own state (the query, `results`,
  // `currentFilters`, the download subscription above) is never rebuilt or
  // even read here, which is what makes "switching tabs preserves the
  // search query/results/an in-flight download" (task brief) true for free.
  let activeTab = "search";
  function setActiveTab(tab) {
    if (activeTab === tab) {
      return;
    }
    activeTab = tab;
    searchTabBtn.classList.toggle("wtn-cm-tab-active", tab === "search");
    installedTabBtn.classList.toggle("wtn-cm-tab-active", tab === "installed");
    rail.style.display = tab === "search" ? "" : "none";
    main.style.display = tab === "search" ? "" : "none";
    installedRail.style.display = tab === "installed" ? "" : "none";
    installedMain.style.display = tab === "installed" ? "" : "none";
    if (tab === "installed") {
      // Repaint with whatever's already known FIRST (instant, possibly
      // "Loading…" for a kind never fetched this modal-open) -- then kick
      // off each kind's own fetch, which repaints again once it lands.
      // `listModels` (no `force`) serves an already-warm kind's cache
      // instantly, so re-entering this tab never re-hits the network for a
      // kind that's already resolved.
      renderInstalled();
      for (const kind of INSTALLED_KIND_ORDER) {
        fetchInstalledKind(kind);
      }
    }
  }
  searchTabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setActiveTab("search");
  });
  installedTabBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setActiveTab("installed");
  });

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
