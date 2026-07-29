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
};

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
};

// ---------------------------------------------------------------------------
// Declarations — the actual `app.registerExtension({ settings: [...] })`
// items. `category: ["AnimaFlow", ...]` is what makes the sidebar section
// itself read "AnimaFlow" (task brief) — every item shares that first
// element.
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
      + "run. 'off' silences it entirely; 'summary' prints the run header, "
      + "the resolved sampler values, and one line per stage; 'debug' adds "
      + "finer-grained detail (full context-supplied report, each stage's own "
      + "resolved sampler values). Replaces the old ANIMAFLOW_DEBUG "
      + "environment variable, which still works as an override for a "
      + "headless run with no browser attached: if set to a truthy value it "
      + "forces 'debug' regardless of this setting.",
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
