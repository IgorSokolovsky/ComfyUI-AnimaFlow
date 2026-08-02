/**
 * settings.mjs — the pack-wide "AnimaFlow" section in ComfyUI's Settings
 * dialog (the sidebar entry alongside EasyUseAnima/Pixaroma/Use Everywhere),
 * plus the one accessor every consumer reads a live value through.
 *
 * ## Why this lives here, not in a 6th auto-loaded `.js`
 *
 * `.claude/CLAUDE.md`'s JS download budget caps auto-loaded `.js` files at
 * 5 (one entry point per track, each registering every node class its own
 * track owns). This file is a plain `.mjs` — never auto-loaded, only fetched
 * when something `import()`s it — so declaring the settings here (count
 * grows over time -- re-count `ANIMAFLOW_SETTINGS.length` rather than
 * trusting a number in prose) and
 * having EVERY existing entry point (`js/anima/index.js`, `js/controls/
 * index.js`) call `registerAnimaFlowSettings(app)` from inside their own
 * `beforeRegisterNodeDef` (which already runs unconditionally, for every
 * node type, on every page — see either entry point's own top doc comment)
 * costs nothing extra: the budget stays at 5, and the section still shows up
 * on a page that has none of this pack's nodes on it at all, because
 * `beforeRegisterNodeDef` fires before any node is ever placed.
 * `registerAnimaFlowSettings` is idempotent (module-level guard, below) so
 * calling it from more than one entry point is deliberately safe — "any
 * entry point loading is enough to register the section" (task brief).
 *
 * This module has ZERO `/scripts/app.js`/`window`/`document` reference at
 * module scope (only a runtime `typeof window !== "undefined"` guard inside
 * `getSetting`, mirroring `js/shared/canvas_zoom.mjs`'s own
 * `defaultGetCanvasEl` precedent), so it is a plain relative import, safe to
 * import STATICALLY from anywhere in this pack — including modules that must
 * stay importable under plain `node` (`fields.mjs`, `node_chrome.mjs`,
 * `interaction.mjs` in both tracks) — exactly like `../controls/rows.mjs` and
 * `./canvas_zoom.mjs` already are.
 *
 * ## `getSetting(id, fallback)` — the ONE accessor every consumer uses
 *
 * Tries the current frontend's real setting store first
 * (`app.extensionManager.setting.get`, the ComfyUI-Frontend-package API),
 * then an older frontend's `app.ui.settings.getSettingValue` (task brief),
 * and returns `fallback` for anything else at all — no live `app`, no
 * matching method, the method itself throwing, or a `null`/`undefined`
 * result. No consumer in this pack ever reads `app.extensionManager`/
 * `app.ui.settings` directly; every one of them goes through this function,
 * so a future frontend API change is a one-place fix.
 *
 * `appRef` (third, optional argument) lets a caller that already holds a
 * real `app` reference (every `index.js` in this pack) pass it in directly
 * rather than relying on the `window.app` global fallback — same reasoning
 * `canvas_zoom.mjs`'s `getCanvasEl` takes an injectable getter instead of a
 * hardcoded global lookup. Tests exercise BOTH paths: an injected fake `app`
 * (no `window` involved at all) and the `window.app` fallback.
 *
 * VERIFY-IN-COMFYUI: the exact `app.registerExtension({ settings: [...] })`
 * item shape (`id`/`name`/`type`/`defaultValue`/`tooltip`/`category`/
 * `options`) and the two read APIs above are written from ComfyUI's
 * documented JS-extension conventions — there is no live ComfyUI frontend in
 * this dev environment to confirm the Settings dialog actually renders this
 * shape correctly; if a live install disagrees, this is the one file to fix.
 *
 * ## ID namespace — APPEND-ONLY from here on
 *
 * Every id below is `AnimaFlow.<Group>.<Name>` and is the PERSISTENCE KEY
 * ComfyUI's own `default/comfy.settings.json` stores the user's choice
 * under (`src/anima/frontend_settings.py` reads that same file, keyed by
 * these exact strings — the two sides duplicate the literal because Python
 * and JS can't share one module, matching this pack's existing convention
 * of duplicated-but-tested-for-parity schema strings, e.g.
 * `GENERATION_SETTINGS_SCHEMA` in both `state.mjs` and `settings.py`). Renaming
 * or removing an id silently discards every user's already-saved choice for
 * it — treat this list as APPEND-ONLY, exactly like a node's widget order.
 */

// ---------------------------------------------------------------------------
// IDs — APPEND-ONLY (this module's own top doc comment).
// ---------------------------------------------------------------------------

export const SETTING_IDS = {
  CONSOLE_LOGGING: "AnimaFlow.General.ConsoleLogging",
  WHEEL_QUIET_PERIOD_MS: "AnimaFlow.Canvas.WheelQuietPeriodMs",
  TOOLTIP_DELAY_MS: "AnimaFlow.Fields.TooltipDelayMs",
  NODE_PANEL_FONT_SIZE: "AnimaFlow.Anima.NodePanelFontSize",
  NODE_CHROME: "AnimaFlow.Theme.NodeChrome",
  PERSIST_CONTEXT_RUN: "AnimaFlow.Anima.PersistPostRunValues",
  CONFIRM_REMOVE_ROW: "AnimaFlow.Controls.ConfirmRemoveRow",
  CIVITAI_ENABLED: "AnimaFlow.Controls.CivitaiEnabled",
  // Slice 5 (docs/lora-loader-design.md §7b): the LoRA Loader's own ⚙
  // dialog shows these two alongside Civitai, but per §7b's ownership split
  // they are USER-WIDE display/posture prefs, not per-node state -- so the
  // dialog's own switches for them read/write THESE ids (`getSetting`/
  // `setSetting`), never `lora_state.mjs`'s state blob.
  HIDE_FILE_EXTENSION: "AnimaFlow.Controls.HideFileExtension",
  SHOW_PREVIEW_THUMBNAILS: "AnimaFlow.Controls.ShowPreviewThumbnails",
  // M2 (docs/lora-loader-design.md §7c/§7c-i/§8) -- the search panel's own
  // remembered-user-wide state. `CIVITAI_API_KEY`'s id string is NOT ours to
  // choose: `src/model_browser/keys.py`'s `SETTING_ID` already reads THIS
  // exact string (`"AnimaFlow.Controls.CivitaiApiKey"`) -- it was wired
  // server-side ahead of this frontend slice specifically so the read path
  // starts working the instant this id exists, with no further Python change
  // (that module's own top doc comment). §8's "never the node state blob"
  // rule means this key is ONLY ever read/written through this id -- never
  // through `lora_state.mjs`'s serialized blob (the Preview embeds workflows
  // into saved PNGs, so a key in that blob would leak into every shared
  // image).
  CIVITAI_API_KEY: "AnimaFlow.Controls.CivitaiApiKey",
  // The other four are a browsing PREFERENCE (§7c-i: "remembered user-wide
  // ... not in the node's state blob"), so the picker and the later toolbar
  // modal (M2b) open with the same remembered filters -- one browser, three
  // mounts, not three independently-configured ones.
  CIVITAI_SEARCH_BASE_MODEL: "AnimaFlow.Controls.CivitaiSearchBaseModel",
  CIVITAI_SEARCH_SORT: "AnimaFlow.Controls.CivitaiSearchSort",
  CIVITAI_SEARCH_PERIOD: "AnimaFlow.Controls.CivitaiSearchPeriod",
  // SUPERSEDED by CIVITAI_BROWSING_LEVEL, below (docs/lora-loader-design.md
  // §7c-iv, owner 2026-07-31: a five-level "maximum browsing level" select
  // replaces the NSFW checkbox, because Civitai's own `nsfw` request
  // parameter is binary and a level selector needs the full gallery fetched
  // client-side regardless). Kept registered (`SETTING_IDS`/`SETTING_DEFAULTS`
  // both keep this entry -- an id is append-only, this module's own top doc
  // comment: removing it would silently discard whatever a user had already
  // saved here, which is not a safe operation), but as of A3 (owner
  // screenshot, 2026-07-31: "a control that does nothing is worse than no
  // control") it is deliberately EXCLUDED from `ANIMAFLOW_SETTINGS` below --
  // see that array's own top comment for the rule this and the two
  // `CIVITAI_MODAL_*` ids below all share.
  CIVITAI_SEARCH_NSFW: "AnimaFlow.Controls.CivitaiSearchNsfw",
  // RENAMED from `CIVITAI_SEARCH_LEVEL`/`AnimaFlow.Controls.CivitaiSearchLevel`
  // (owner, 2026-07-31, docs/lora-loader-design.md's own "The id and label say
  // 'search'" section): this governs every surface that loads a Civitai image
  // -- the search panel/modal, the ⓘ info panel's identity thumb, and the
  // download-time preview sidecar -- not just search, so the old id/label
  // were actively misleading once the ⓘ panel and sidecar started reading it
  // too (`58a1749`). Five choices, `CIVITAI_SEARCH_LEVEL_OPTIONS` below (that
  // options array's own name is UNCHANGED -- it's an enum, not a setting id,
  // and renaming it buys nothing), PG default. Stored as the LABEL string
  // ("PG".."XXX"), matching `_SORT`/`_PERIOD`'s own "raw enum string, sent
  // through a small mapping rather than the wire value itself" convention --
  // `civitai_search.mjs`'s own `levelLabelToInt` is the one place that turns
  // this into the numeric bitmask value (`1`/`2`/`4`/`8`/`16`) the search
  // route actually reads.
  //
  // Renaming the id ORPHANS any already-saved value (a brand-new id has
  // nothing stored under it yet), so this resets every user's remembered
  // level back to the PG default exactly once. That is acceptable **only**
  // because the superseded id was a single commit old at rename time (owner,
  // 2026-07-31) -- ids are otherwise append-only for exactly this reason
  // (this module's own top doc comment), and the SAME rename a month from now
  // would not be acceptable. Do not repeat this reasoning to justify a LATER
  // rename of an id that has actually been in use.
  CIVITAI_BROWSING_LEVEL: "AnimaFlow.Controls.CivitaiBrowsingLevel",
  // M2b (docs/lora-loader-design.md §7c-i's rail): the toolbar MODAL's own
  // multi-value filters -- "Filter by Base Model"/"Filter by Model Type" are
  // `<select>`-adds-a-chip, unlike the picker's own single-value
  // `CIVITAI_SEARCH_BASE_MODEL` combo above, so they need their OWN id
  // (a single-value id can't hold a list without changing what the picker's
  // existing combo means). Still "remembered user-wide... not in the node's
  // state blob" (§7c-i), same ownership boundary as every filter above --
  // just a JSON-array-of-strings STRING value rather than a bare enum,
  // because ComfyUI's Settings-dialog widget types (`combo`/`boolean`/
  // `text`/`number`) have no native multi-select -- `type: "text"` stores
  // the serialized array, and `civitai_modal.mjs`'s own `parseStoredList`/
  // `serializeList` are the one place that (de)serializes it. A4 (owner
  // screenshot, 2026-07-31): these two are the rail's OWN chip state, never
  // meant to be hand-edited as a raw `[]` text field -- excluded from
  // `ANIMAFLOW_SETTINGS` below (kept here in `SETTING_IDS`/`SETTING_DEFAULTS`
  // so an already-saved value is never discarded; see that array's own top
  // comment for the rule this and `CIVITAI_SEARCH_NSFW` above both share).
  CIVITAI_MODAL_BASE_MODELS: "AnimaFlow.Controls.CivitaiModalBaseModels",
  CIVITAI_MODAL_MODEL_TYPES: "AnimaFlow.Controls.CivitaiModalModelTypes",
  // docs/lora-loader-design.md §1a-vii ("show the CIVITAI name instead of
  // the filename -- a setting"): a display-only preference, appended here
  // (append-only, this module's own top doc comment), composing with
  // `HIDE_FILE_EXTENSION` above -- both are read through `model_picker.mjs`'s
  // `displayRowName`, the ONE settings-aware name-display seam every
  // `paintRow` in the Controls track already calls. Defaults OFF: filenames,
  // today's behaviour, and what actually matches disk (§1a-vii's own "the
  // non-negotiable" -- the filename stays the identity regardless of this
  // setting's value; this governs DISPLAY only).
  SHOW_CIVITAI_NAME: "AnimaFlow.Controls.ShowCivitaiName",
  // 2026-08-02 (detail-view accessibility task, owner screenshot: "the text
  // is small ... let's increase it"): the model/version DETAIL VIEW's own
  // base body-text size (`js/controls/model_detail_view.mjs`) -- ONE id per
  // MOUNT, not a single shared value. The task started as one setting; the
  // owner, on being told that would make the picker's own ~396px panel just
  // as dense as the wide browser modal, corrected it: "you did right, and
  // yes for our panel we should have different set then the browser modal."
  // `AnimaFlow.Controls.*`, not `AnimaFlow.Anima.*` -- that track's own
  // `NODE_PANEL_FONT_SIZE` above is a DIFFERENT surface (the Generator/
  // Preview node panel); this is a Civitai surface, matching every other
  // `CIVITAI_*` id's own namespace. Every OTHER size in the detail view is a
  // fixed ratio off whichever of these two the caller supplies
  // (`model_detail_view.mjs`'s own `FONT_RATIOS`) -- never a second,
  // independently-chosen number. Both are clamped to `DETAIL_VIEW_FONT_SIZE_
  // MIN`/`_MAX` (`model_detail_view.mjs`, 12-20) regardless of what a user
  // types here -- not an unreadable/overflowing size just because the number
  // box allows it.
  CIVITAI_DETAIL_MODAL_FONT_SIZE: "AnimaFlow.Controls.CivitaiDetailModalFontSize",
  CIVITAI_DETAIL_PANEL_FONT_SIZE: "AnimaFlow.Controls.CivitaiDetailPanelFontSize",
};

// ---------------------------------------------------------------------------
// The search panel's own filter ENUMS (docs/lora-loader-design.md §7c-i) --
// declared here, once, so the Settings-dialog combo item below and
// `js/controls/civitai_search.mjs`'s own `<select>` pills share the exact
// same allowed-values list rather than two hand-copied arrays drifting apart
// (both are plain JS, unlike the JS/Python schema pairs elsewhere in this
// pack that genuinely can't share a module). `sort`/`period`'s values are
// Civitai's own raw enum strings, byte-for-byte matching `src/model_browser/
// civitai_search.py`'s `SORT_VALUES`/`PERIOD_VALUES` -- sent to the search
// route AS-IS, so a value here that didn't match one of those would silently
// fall back to that module's own default rather than doing what the user
// picked. `BASE_MODEL` has no server-side enum at all (`civitai_search.py`
// passes it through unvalidated) -- this is Civitai's own authoritative list
// of base-model values, verbatim and in the owner's order (design §1a-vi:
// never invent a catalogue value). Do NOT normalise, re-case, de-duplicate
// or "tidy" this list -- entries that look redundant (`Krea 2`/`Krea2`,
// `LTXV2`/`LTXV 2.3`) are two distinct values Civitai itself uses, both sent
// on the wire unchanged. An unlisted base model simply isn't offered as a
// quick filter here.
// ---------------------------------------------------------------------------

export const CIVITAI_SEARCH_BASE_MODEL_OPTIONS = [
  "",
  "ACE Audio", "Anima", "AuraFlow", "Boogu", "Chroma", "CogVideoX", "Ernie", "Flux 1.0", "Flux.1 D",
  "Flux.1 Kontext", "Flux.1 Krea", "Flux.1 S", "Flux.2 D", "Flux.2 Klein 4B", "Flux.2 Klein 4B-base",
  "Flux.2 Klein 9B", "Flux.2 Klein 9B-base", "Grok", "HappyHorse", "HiDream", "HiDream-O1", "Hunyuan 1",
  "Hunyuan Video", "Ideogram 4.0", "Illustrious", "Illustrious 0.1", "Imagen4", "Kling", "Kolors", "Krea 2",
  "Krea2", "LTXV", "LTXV 2.3", "LTXV2", "Lens", "Lumina", "MAI", "MageFlow", "Mochi", "Nano Banana", "NoobAI",
  "ODOR", "OpenAI", "Other", "PixArt E", "PixArt a", "Playground v2", "Pony", "Pony V7", "Qwen", "Qwen 2",
  "Reve", "SD 1.4", "SD 1.5", "SD 1.5 Hyper", "SD 1.5 LCM", "SD 2.0", "SD 2.0 768", "SD 2.1", "SD 2.1 768",
  "SD 2.1 Unclip", "SDXL 0.9", "SDXL 1.0", "SDXL 1.0 LCM", "SDXL Distilled", "SDXL Hyper", "SDXL Lightning",
  "SVD XT", "Seedance", "Seedream", "Sora 2", "Stable Cascade", "Upscaler", "Veo 3", "Vidu Q1",
  "Wan Image 2.7", "Wan Video", "Wan Video 1.3B t2v", "Wan Video 14B i2v 480p", "Wan Video 14B i2v 720p",
  "Wan Video 14B t2v", "Wan Video 2.2 I2V-A14B", "Wan Video 2.2 T2V-A14B", "Wan Video 2.2 TI2V-5B",
  "Wan Video 2.5 I2V", "Wan Video 2.5 T2V", "Wan Video 2.7", "Z-Image", "ZImageBase", "ZImageTurbo",
];
export const CIVITAI_SEARCH_SORT_OPTIONS = ["Relevancy", "Most Downloaded", "Highest Rated", "Newest"];
export const CIVITAI_SEARCH_PERIOD_OPTIONS = ["Day", "Week", "Month", "Year", "AllTime"];

/**
 * A1 (owner screenshot, 2026-07-31): the Settings-dialog COMBO for this
 * setting rendered `settings.AnimaFlow_Controls_CivitaiSearchBaseModel.
 * options.` (a raw, untranslated i18n key) as its first choice, because the
 * installed `comfyui-frontend-package` bundle's own `translateOptions`
 * (`assets/dialogService-*.js`, decompiled -- there is no source map to cite
 * a line number against) builds each option's i18n lookup as
 * `` `settings.${slug(id)}.options.${slug(optionText)}` `` with the option's
 * OWN TEXT as the untranslated fallback:
 *
 *   `e.map(e=>{let r=typeof e=="string"?e:e.text,i=typeof e=="string"?e:e.value;
 *   return{text:n(`settings.${slug(id)}.options.${slug(r)}`,r),value:i}})`
 *
 * For a plain string option, `r` (the slug input) AND the fallback are the
 * SAME string -- so `CIVITAI_SEARCH_BASE_MODEL_OPTIONS[0]` (`""`, "any base
 * model") produces the key `...options.` (a slug of `""` is `""`) with a
 * FALSY fallback (`""` itself) -- ComfyUI's `t(key, fallback)` renders the
 * raw key when neither a translation nor a truthy fallback exists. Every
 * other option's own text IS its fallback, so only this one, uniquely empty,
 * value breaks. The in-panel `<select>` (`civitai_search.mjs`'s
 * `buildFilterSelect`) never hits this: it builds its OWN option elements and
 * maps `"" -> "Any"` directly, with no i18n layer in between at all.
 *
 * The fix confirmed by reading that same bundle: `translateOptions` accepts
 * a `{text, value}` OBJECT per option (`typeof e=="string"?e:e.text` / `e.value`
 * above) -- `text` feeds BOTH the slug and the fallback, `value` is what
 * actually reaches `t.setting.value`/gets persisted. Mapping the empty
 * option's `text` to `"Any"` (matching the picker's own label for it) gives
 * every option a non-empty fallback, so the untranslated-key case can never
 * recur for THIS setting -- no sentinel value substitution needed anywhere,
 * since the wire `value` for "any" stays the real `""` this setting's
 * default/every reader already expects (`CIVITAI_SEARCH_BASE_MODEL_OPTIONS`
 * itself, used by the picker's own `<select>` and the modal's rail, is
 * UNCHANGED -- this is a SEPARATE array, only ever consumed by the dialog
 * declaration below).
 */
export const CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS = CIVITAI_SEARCH_BASE_MODEL_OPTIONS.map((value) => ({
  text: value === "" ? "Any" : value,
  value,
}));

// The "maximum browsing level" select (docs/lora-loader-design.md §7c-iv) --
// five labels, in ascending order, matching Civitai's own `nsfwLevel`
// bitmask (`1 PG · 2 PG-13 · 4 R · 8 X · 16 XXX`; `32 Blocked` is never
// offered -- it is never browsable at any setting). The SETTING's own
// persisted value is one of these label strings (`CIVITAI_BROWSING_LEVEL`,
// above); `CIVITAI_SEARCH_LEVEL_TO_INT` is the one place that converts a
// label to the numeric value the search route and the per-image
// `nsfw_level` comparison actually use. (This options array/int-map keep
// their own `CIVITAI_SEARCH_LEVEL_*` names -- they're enums, not a setting
// id, and renaming them buys nothing; only the SETTING id itself was
// scope-neutralised, A2.)
export const CIVITAI_SEARCH_LEVEL_OPTIONS = ["PG", "PG-13", "R", "X", "XXX"];
export const CIVITAI_SEARCH_LEVEL_TO_INT = { PG: 1, "PG-13": 2, R: 4, X: 8, XXX: 16 };

// The documented default for each id, above — every consumer's own
// `getSetting(id, DEFAULT)` fallback cites one of these by name rather than
// a second literal, so "what does this setting do when unset" only has one
// place to look.
export const SETTING_DEFAULTS = {
  [SETTING_IDS.CONSOLE_LOGGING]: "off",
  [SETTING_IDS.WHEEL_QUIET_PERIOD_MS]: 450,
  [SETTING_IDS.TOOLTIP_DELAY_MS]: 250,
  [SETTING_IDS.NODE_PANEL_FONT_SIZE]: 14,
  [SETTING_IDS.NODE_CHROME]: true,
  [SETTING_IDS.PERSIST_CONTEXT_RUN]: false,
  [SETTING_IDS.CONFIRM_REMOVE_ROW]: true,
  [SETTING_IDS.CIVITAI_ENABLED]: true,
  [SETTING_IDS.HIDE_FILE_EXTENSION]: false,
  [SETTING_IDS.SHOW_PREVIEW_THUMBNAILS]: true,
  [SETTING_IDS.CIVITAI_API_KEY]: "",
  // Matches `src/model_browser/civitai_search.py`'s own `DEFAULT_SORT`/
  // `DEFAULT_PERIOD` -- so a freshly-installed panel's remembered filters
  // behave identically to what the search route would already do if these
  // were left unset entirely.
  [SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL]: "",
  [SETTING_IDS.CIVITAI_SEARCH_SORT]: "Highest Rated",
  [SETTING_IDS.CIVITAI_SEARCH_PERIOD]: "AllTime",
  // Superseded (§7c-iv) -- see CIVITAI_SEARCH_NSFW's own comment above.
  [SETTING_IDS.CIVITAI_SEARCH_NSFW]: false,
  // PG (owner, §7c-iv) -- a genuine server-side guarantee (Civitai is never
  // asked for adult content at all at this level), unlike the other four.
  [SETTING_IDS.CIVITAI_BROWSING_LEVEL]: "PG",
  // Empty JSON array -- "no chips yet" (§7c-i: "an empty group shows a faint
  // `any`"), matching `CIVITAI_SEARCH_BASE_MODEL`'s own "" = "any" default in
  // spirit, just serialized (this id's own `SETTING_IDS` comment).
  [SETTING_IDS.CIVITAI_MODAL_BASE_MODELS]: "[]",
  [SETTING_IDS.CIVITAI_MODAL_MODEL_TYPES]: "[]",
  // Off -- filenames, today's behaviour (§1a-vii's own default rule).
  [SETTING_IDS.SHOW_CIVITAI_NAME]: false,
  // 14 -- the owner's own explicit ask ("the text should be either 14px or
  // 16px"), applied to the wide browser modal's detail view.
  [SETTING_IDS.CIVITAI_DETAIL_MODAL_FONT_SIZE]: 14,
  // 12 -- NOT the owner's number; this is the builder's own call, a real
  // increase over today's 11.5px body text while staying legible in the
  // picker's own ~396px panel. Flagged for the owner to retune once seen
  // live (this task's own build report).
  [SETTING_IDS.CIVITAI_DETAIL_PANEL_FONT_SIZE]: 12,
};

// ---------------------------------------------------------------------------
// Declarations — the actual `app.registerExtension({ settings: [...] })`
// items. `category: ["AnimaFlow", ...]` is what makes the sidebar section
// itself read "AnimaFlow" (task brief) — every item shares that first
// element.
//
// **The dialog is for things a user should change. Persisted-but-internal
// state keeps its id and stays out of this list.** (Owner screenshots,
// 2026-07-31, A3/A4.) Three ids are deliberately ABSENT from the array below
// even though every one of them is a real, live `SETTING_IDS`/
// `SETTING_DEFAULTS` entry that `getSetting`/`setSetting` reads and writes
// exactly like any other: `CIVITAI_SEARCH_NSFW` (superseded, its own tooltip
// already admitted it does nothing — a visible control nobody can act on
// usefully is worse than none) and `CIVITAI_MODAL_BASE_MODELS`/
// `CIVITAI_MODAL_MODEL_TYPES` (the toolbar browser's own rail chip state, a
// `[]`-shaped JSON string with no sane hand-edited form — the rail itself,
// `civitai_modal.mjs`, is their only real editor). Omitting an id from THIS
// array does not stop it working: the installed `comfyui-frontend-package`
// bundle's own setting store keys its persisted VALUES by id directly
// (`e.value[id]`, decompiled from `assets/dialogService-*.js`'s `get`/`set`),
// independent of whether `addSetting` (fired per entry in this array, once
// per `registerExtension` call) was ever called for that id — so leaving an
// id out of this list only ever removes its DIALOG ROW, never its ability to
// be read/written/persisted. That is what makes "keep the id and default
// registered, but drop the dialog entry" (A3/A4) a real, safe operation
// rather than a contradiction.
// ---------------------------------------------------------------------------

export const ANIMAFLOW_SETTINGS = [
  {
    id: SETTING_IDS.CONSOLE_LOGGING,
    name: "Console logging",
    category: ["AnimaFlow", "General", "Console logging"],
    type: "combo",
    options: ["off", "summary", "debug"],
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CONSOLE_LOGGING],
    tooltip:
      "How much the Anima Generator/Preview print to the server console per "
      + "run. Also governs the Controls track's own Civitai activity -- the "
      + "LoRA search panel, the toolbar browser modal, the ⓘ info panel, and "
      + "the model picker -- so search/download/lookup activity is visible "
      + "at 'debug' and silent otherwise. 'off' silences everything; "
      + "'summary' prints the run header, the resolved sampler values, one "
      + "line per stage, and one line per user-visible Civitai operation "
      + "(a search issued and its result count, a download starting/"
      + "finishing, a lookup's outcome); 'debug' adds finer-grained detail "
      + "(full context-supplied report, each stage's own resolved sampler "
      + "values, cache-hit-vs-fetch detail on the Civitai side). Replaces "
      + "the old ANIMAFLOW_DEBUG environment variable, which still works as "
      + "an override for a headless run with no browser attached: if set to "
      + "a truthy value it forces 'debug' regardless of this setting.",
  },
  {
    id: SETTING_IDS.WHEEL_QUIET_PERIOD_MS,
    name: "Wheel quiet period (ms)",
    category: ["AnimaFlow", "Canvas", "Wheel quiet period (ms)"],
    type: "number",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.WHEEL_QUIET_PERIOD_MS],
    tooltip:
      "After scrolling an Anima/Controls panel to either end, how long (in "
      + "milliseconds) the SAME continuing wheel gesture is prevented from "
      + "also zooming the graph. Lower it for snappier zoom-after-scroll; "
      + "raise it if a fast scroll still occasionally zooms the canvas "
      + "mid-gesture.",
  },
  {
    id: SETTING_IDS.TOOLTIP_DELAY_MS,
    name: "Tooltip delay (ms)",
    category: ["AnimaFlow", "Fields", "Tooltip delay (ms)"],
    type: "number",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.TOOLTIP_DELAY_MS],
    tooltip:
      "How long (in milliseconds) the cursor must hover an ⓘ icon before its "
      + "tooltip appears, across every themed node in this pack.",
  },
  {
    id: SETTING_IDS.NODE_PANEL_FONT_SIZE,
    name: "Node panel type size (px)",
    category: ["AnimaFlow", "Anima", "Node panel type size (px)"],
    type: "number",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.NODE_PANEL_FONT_SIZE],
    tooltip:
      "Base font size (in pixels) for the Anima Generator/Preview's own "
      + "panel — every row height, header height, and field size scales "
      + "proportionally with it. Applied once when this pack's frontend "
      + "modules first load on a page, so a change here needs a page "
      + "refresh to take effect; it will not resize an already-open panel.",
  },
  {
    id: SETTING_IDS.NODE_CHROME,
    name: "Themed node chrome",
    category: ["AnimaFlow", "Theme", "Themed node chrome"],
    type: "boolean",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.NODE_CHROME],
    tooltip:
      "Paint this pack's nodes (body + title bar) in the house dark-slate/"
      + "teal theme when a fresh node is placed. Turn off to leave a new "
      + "node at ComfyUI's own default colour. Never overrides a colour you "
      + "picked yourself via right-click → Colors, on any node, whether this "
      + "is on or off.",
  },
  {
    id: SETTING_IDS.PERSIST_CONTEXT_RUN,
    name: "Keep post-run values across reload",
    category: ["AnimaFlow", "Anima", "Keep post-run values across reload"],
    type: "boolean",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.PERSIST_CONTEXT_RUN],
    tooltip:
      "Remember the Generator's last-run \"context-supplied\" values "
      + "(e.g. a sampler scalar Use Everywhere injected at submit time) "
      + "across a page reload, instead of only for the current session. "
      + "The remembered values can go stale if you rewire the graph after "
      + "the last run and then reload without running again — that staleness "
      + "is the accepted cost of turning this on.",
  },
  {
    id: SETTING_IDS.CONFIRM_REMOVE_ROW,
    name: "Confirm before removing a row",
    category: ["AnimaFlow", "Controls", "Confirm before removing a row"],
    type: "boolean",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CONFIRM_REMOVE_ROW],
    tooltip:
      "Ask for confirmation before removing a Control/Loader Panel row that "
      + "is currently wired to something. Turn off to remove a wired row "
      + "(and its link) immediately, with no prompt.",
  },
  {
    id: SETTING_IDS.CIVITAI_ENABLED,
    name: "Civitai",
    category: ["AnimaFlow", "Controls", "Civitai"],
    type: "boolean",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CIVITAI_ENABLED],
    tooltip:
      "Allow the LoRA Loader (and, later, the Loader Panel) to reach Civitai "
      + "at all. Off hides EVERY network affordance on the node -- the ⓘ "
      + "panel's lookup status and its \"↻ Civitai\"/\"View on Civitai ↗\" "
      + "controls, and the row menu's/header's Civitai-browsing entry points "
      + "-- so the node is provably offline: there is no path left from "
      + "which a request could originate. File-derived trigger words keep "
      + "working either way, and so does anything ALREADY cached next to a "
      + "file (its notes, its trigger words, its display name) -- that's "
      + "read from disk, never re-fetched, so turning this off only removes "
      + "the way to look up something new, not what's already known "
      + "(docs/lora-loader-design.md §7b decision 20, §7d).",
  },
  {
    id: SETTING_IDS.HIDE_FILE_EXTENSION,
    name: "Hide file extension",
    category: ["AnimaFlow", "Controls", "Hide file extension"],
    type: "boolean",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.HIDE_FILE_EXTENSION],
    tooltip:
      "Show a LoRA/model's name in the picker without its file extension "
      + "(e.g. \"celica_v2\" instead of \"celica_v2.safetensors\"). Purely "
      + "cosmetic -- the underlying file name used to load it never changes.",
  },
  {
    id: SETTING_IDS.SHOW_CIVITAI_NAME,
    name: "Show Civitai name instead of filename",
    category: ["AnimaFlow", "Controls", "Show Civitai name instead of filename"],
    type: "boolean",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.SHOW_CIVITAI_NAME],
    tooltip:
      "Show a LoRA/model's Civitai display name (e.g. \"Realistic Skin "
      + "Detail\") instead of its file name, in the picker row, the LoRA "
      + "row's own name field, and the ⓘ info panel's title. Only ever "
      + "shows a name this pack already knows -- downloaded through this "
      + "pack's own browser, or looked up once via ⓘ -- and silently falls "
      + "back to the file name for anything else, so a mixed folder never "
      + "looks broken. Purely cosmetic: the underlying file used to load "
      + "the model never changes, and a MISSING file always shows its file "
      + "name regardless of this setting (docs/lora-loader-design.md §1a-vii).",
  },
  {
    id: SETTING_IDS.SHOW_PREVIEW_THUMBNAILS,
    name: "Show preview thumbnails",
    category: ["AnimaFlow", "Controls", "Show preview thumbnails"],
    type: "boolean",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.SHOW_PREVIEW_THUMBNAILS],
    tooltip:
      "Show each LoRA/model's small local preview image in the picker list "
      + "and its larger thumbnail in the ⓘ info panel. Turn off for less "
      + "clutter or to avoid loading the (local, non-Civitai) preview files "
      + "at all -- the picker/panel still work, just without the pictures.",
  },
  {
    id: SETTING_IDS.CIVITAI_API_KEY,
    name: "Civitai API key",
    category: ["AnimaFlow", "Controls", "Civitai API key"],
    type: "text",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CIVITAI_API_KEY],
    tooltip:
      "Your own Civitai API key, used server-side ONLY -- for gated/early-"
      + "access downloads and to relieve search rate limits. Never sent "
      + "anywhere except Civitai's own API, never logged, and never written "
      + "into a node's saved state (a LoRA Loader's state blob is embedded in "
      + "every saved workflow, and the Preview embeds workflows into saved "
      + "PNGs -- a key living there would leak into every shared image, so it "
      + "lives ONLY here). Leave blank for public-only search results and no "
      + "gated downloads; the CIVITAI_API_KEY environment variable also works "
      + "as a fallback if you already have that set for another tool "
      + "(docs/lora-loader-design.md §8).",
  },
  {
    id: SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL,
    name: "Civitai search: base model filter",
    category: ["AnimaFlow", "Controls", "Civitai search: base model filter"],
    type: "combo",
    // A1 -- `{text, value}` objects, NOT the plain-string
    // `CIVITAI_SEARCH_BASE_MODEL_OPTIONS` every other consumer (the picker's
    // own `<select>`, the modal's rail) uses -- see
    // `CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS`'s own doc comment above for
    // why the plain-string form uniquely broke for this one setting's first
    // (empty, "any") option.
    options: CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS,
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL],
    tooltip:
      "The base-model filter last used in the Civitai search panel (LoRA "
      + "Loader 🔍, and later the toolbar browser/Loader Panel) -- remembered "
      + "user-wide so every surface opens with the same filter, rather than "
      + "per node. An empty value means \"any base model\".",
  },
  {
    id: SETTING_IDS.CIVITAI_SEARCH_SORT,
    name: "Civitai search: sort",
    category: ["AnimaFlow", "Controls", "Civitai search: sort"],
    type: "combo",
    options: CIVITAI_SEARCH_SORT_OPTIONS,
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_SORT],
    tooltip: "The sort order last used in the Civitai search panel -- remembered user-wide.",
  },
  {
    id: SETTING_IDS.CIVITAI_SEARCH_PERIOD,
    name: "Civitai search: period",
    category: ["AnimaFlow", "Controls", "Civitai search: period"],
    type: "combo",
    options: CIVITAI_SEARCH_PERIOD_OPTIONS,
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_PERIOD],
    tooltip: "The time-period filter last used in the Civitai search panel -- remembered user-wide.",
  },
  // A3 -- CIVITAI_SEARCH_NSFW has NO entry here any more (own tooltip used to
  // admit it does nothing at all) -- see this array's own top comment for why
  // that is safe: the id/default stay live in `SETTING_IDS`/`SETTING_DEFAULTS`
  // above, only the dialog ROW is gone.
  {
    // A2 -- RENAMED from `CIVITAI_SEARCH_LEVEL` (see `SETTING_IDS`'s own
    // comment on `CIVITAI_BROWSING_LEVEL` for the full "why" and the accepted
    // one-time reset to PG this rename causes).
    id: SETTING_IDS.CIVITAI_BROWSING_LEVEL,
    name: "Civitai: maximum browsing level",
    category: ["AnimaFlow", "Controls", "Civitai: maximum browsing level"],
    type: "combo",
    options: CIVITAI_SEARCH_LEVEL_OPTIONS,
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CIVITAI_BROWSING_LEVEL],
    tooltip:
      "The maximum Civitai content level shown across EVERY surface that "
      + "loads a Civitai image -- the search panel and toolbar browser's own "
      + "results/thumbnails, the ⓘ info panel's identity thumbnail, and the "
      + "download-time preview sidecar (PG / PG-13 / R / X / XXX) -- "
      + "remembered user-wide, one setting for all of them, not per surface. "
      + "Replaces the old NSFW checkbox (§7c-iv). PG is a genuine server-side "
      + "guarantee -- Civitai is never asked for adult content at all -- "
      + "while PG-13/R/X/XXX are filtered client-side from a fuller gallery "
      + "fetch, since Civitai's own search API has no level parameter of its "
      + "own. Never filters a file already on disk -- only what this pack "
      + "fetches and shows FROM Civitai.",
  },
  // A4 -- CIVITAI_MODAL_BASE_MODELS/CIVITAI_MODAL_MODEL_TYPES have NO entry
  // here any more (they used to render as bare `[]` text fields) -- same
  // reasoning as CIVITAI_SEARCH_NSFW above: the ids/defaults stay live,
  // `civitai_modal.mjs`'s own rail is their only real editor.
  {
    id: SETTING_IDS.CIVITAI_DETAIL_MODAL_FONT_SIZE,
    name: "Civitai detail view: modal body text size (px)",
    category: ["AnimaFlow", "Controls", "Civitai detail view: modal body text size (px)"],
    type: "number",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CIVITAI_DETAIL_MODAL_FONT_SIZE],
    tooltip:
      "Base body-text size (in pixels) for the browser modal's model/version "
      + "detail view -- every other size in that view (section headings at "
      + "24px, the model-name title, stats, gallery captions, ...) scales "
      + "proportionally off this one number, never picked independently. "
      + "Expressed internally as a scale relative to your browser's own root "
      + "font size, so a larger browser zoom/default text size still "
      + "enlarges everything in this view too -- never a fixed pixel size "
      + "that ignores it. Clamped to 12-20px regardless of what's typed "
      + "here -- outside that range stops being legible or starts "
      + "overflowing the panel. Applied fresh every time the modal's detail "
      + "view (re)renders.",
  },
  {
    id: SETTING_IDS.CIVITAI_DETAIL_PANEL_FONT_SIZE,
    name: "Civitai detail view: picker panel body text size (px)",
    category: ["AnimaFlow", "Controls", "Civitai detail view: picker panel body text size (px)"],
    type: "number",
    defaultValue: SETTING_DEFAULTS[SETTING_IDS.CIVITAI_DETAIL_PANEL_FONT_SIZE],
    tooltip:
      "The SAME kind of base body-text size, for the LoRA picker's own "
      + "narrower (~396px) ⓘ/detail panel -- a separate setting from the "
      + "modal's own, above, so the two surfaces can size differently (the "
      + "picker is much narrower than the modal). Defaults smaller than the "
      + "modal's own setting for exactly that reason. Same 12-20px clamp, "
      + "same proportional scaling of every other size in the view, same "
      + "browser-zoom awareness.",
  },
];

// ---------------------------------------------------------------------------
// Registration — idempotent, "any entry point loading is enough" (this
// module's top doc comment).
// ---------------------------------------------------------------------------

let _registered = false;

/** Register the "AnimaFlow" Settings-dialog section. `appRef` is the real
 * `app` singleton (`/scripts/app.js`'s default export) — every caller in
 * this pack already has one (`index.js`'s own top-level import). A no-op,
 * never throws, the second and every later call, and for anything that
 * isn't a real `app` (`registerExtension` missing) — mirrors this pack's
 * other idempotent installers (`js/anima/index.js`'s own
 * `installQueuePromptHook`). */
export function registerAnimaFlowSettings(appRef) {
  if (_registered) {
    return;
  }
  if (!appRef || typeof appRef.registerExtension !== "function") {
    return;
  }
  _registered = true;
  appRef.registerExtension({
    name: "AnimaFlow.settings",
    settings: ANIMAFLOW_SETTINGS,
  });
}

/** Test-only: undo the register-once guard so a suite can exercise
 * `registerAnimaFlowSettings` from a clean slate. Never called by any real
 * (non-test) code path in this pack. */
export function _resetRegistrationForTests() {
  _registered = false;
}

// ---------------------------------------------------------------------------
// getSetting — the one accessor (this module's top doc comment).
// ---------------------------------------------------------------------------

function resolveAppRef(appRef) {
  if (appRef) {
    return appRef;
  }
  if (typeof window !== "undefined" && window.app) {
    return window.app;
  }
  return null;
}

/** `id`'s current value from the live ComfyUI frontend, or `fallback` for
 * anything that goes wrong along the way (no `app` reachable, neither read
 * API present, either one throwing, or a `null`/`undefined` result) — never
 * throws. `appRef` is optional; omit it to fall back to the `window.app`
 * global (this module's top doc comment). */
export function getSetting(id, fallback, appRef) {
  const appInst = resolveAppRef(appRef);
  if (!appInst) {
    return fallback;
  }
  try {
    const manager = appInst.extensionManager;
    if (manager && manager.setting && typeof manager.setting.get === "function") {
      const value = manager.setting.get(id);
      if (value !== undefined && value !== null) {
        return value;
      }
    }
  } catch {
    // Fall through to the older API below.
  }
  try {
    const settings = appInst.ui && appInst.ui.settings;
    if (settings && typeof settings.getSettingValue === "function") {
      const value = settings.getSettingValue(id);
      if (value !== undefined && value !== null) {
        return value;
      }
    }
  } catch {
    // Fall through to the fallback below.
  }
  return fallback;
}

/**
 * Writes `id`'s value through the live ComfyUI frontend -- the write-side
 * counterpart to `getSetting`, above, added in Slice 5 for the LoRA Loader's
 * own ⚙ dialog (`lora_interaction.mjs`'s `openLoraSettings`): three of its
 * eight fields (Hide file extension / Civitai / Show preview thumbnails) are
 * USER-WIDE settings per §7b's ownership split, so the node's own dialog
 * must be able to CHANGE them, not just read them. Same two-API-then-give-up
 * shape as `getSetting`: tries the current frontend's real setting store
 * (`app.extensionManager.setting.set`), then an older frontend's
 * `app.ui.settings.setSettingValue`, and returns `false` for anything else at
 * all (no live `app`, no matching method, the method itself throwing) --
 * never throws. Returns `true` iff a write API was actually called (NOT a
 * guarantee ComfyUI's own persistence succeeded -- this pack has no way to
 * observe that, same as every other fire-and-forget call into `app.*` in
 * this codebase). `appRef` mirrors `getSetting`'s own optional third
 * argument.
 */
export function setSetting(id, value, appRef) {
  const appInst = resolveAppRef(appRef);
  if (!appInst) {
    return false;
  }
  try {
    const manager = appInst.extensionManager;
    if (manager && manager.setting && typeof manager.setting.set === "function") {
      manager.setting.set(id, value);
      return true;
    }
  } catch {
    // Fall through to the older API below.
  }
  try {
    const settings = appInst.ui && appInst.ui.settings;
    if (settings && typeof settings.setSettingValue === "function") {
      settings.setSettingValue(id, value);
      return true;
    }
  } catch {
    // Nothing left to try.
  }
  return false;
}
