/**
 * test_settings.mjs — regression tests for `settings.mjs` (the "AnimaFlow"
 * Settings-dialog section + the `getSetting` accessor every consumer in this
 * pack reads through). Plain `node`, no real browser/ComfyUI host — same
 * convention as every other `test_*.mjs` in this pack.
 */

import assert from "node:assert/strict";

import {
  SETTING_IDS,
  SETTING_DEFAULTS,
  ANIMAFLOW_SETTINGS,
  CIVITAI_SEARCH_BASE_MODEL_OPTIONS,
  CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS,
  CIVITAI_SEARCH_SORT_OPTIONS,
  CIVITAI_SEARCH_PERIOD_OPTIONS,
  CIVITAI_SEARCH_LEVEL_OPTIONS,
  CIVITAI_SEARCH_LEVEL_TO_INT,
  registerAnimaFlowSettings,
  _resetRegistrationForTests,
  getSetting,
  setSetting,
} from "./settings.mjs";

let failures = 0;
let count = 0;
function test(name, fn) {
  count += 1;
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

// ---------------------------------------------------------------------------
// Declaration shape — EIGHTEEN registered ids (`SETTING_IDS`/`SETTING_
// DEFAULTS`: the original ten, plus M2's five -- docs/lora-loader-design.md
// §8's `CIVITAI_API_KEY` and §7c-i's four remembered search filters,
// `CIVITAI_SEARCH_BASE_MODEL`/`_SORT`/`_PERIOD`/`_NSFW`, plus §7c-iv's own
// browsing-level id (`CIVITAI_BROWSING_LEVEL`, RENAMED 2026-07-31 from
// `CIVITAI_SEARCH_LEVEL` -- see that id's own comment in `settings.mjs`),
// plus M2b's own two internal multi-value rail filters, `CIVITAI_MODAL_BASE_
// MODELS`/`CIVITAI_MODAL_MODEL_TYPES`) -- but only FIFTEEN of them get a
// dialog ROW in `ANIMAFLOW_SETTINGS`. Three are deliberately excluded (A3/A4,
// owner screenshots 2026-07-31): `CIVITAI_SEARCH_NSFW` (superseded, its own
// tooltip admitted it does nothing) and the two `CIVITAI_MODAL_*` ids (the
// toolbar browser's own internal rail-chip state) -- see `ANIMAFLOW_SETTINGS`'s
// own top comment in `settings.mjs` for why omitting a dialog row never stops
// an id from being read/written. Re-count rather than trusting either number
// — they only ever grow.
// ---------------------------------------------------------------------------

// The three ids deliberately excluded from the dialog list (A3/A4) -- kept as
// a named constant so every assertion below that needs "every REGISTERED id
// except these" reads as one rule, not a repeated inline exclusion list.
const DIALOG_EXCLUDED_IDS = [
  SETTING_IDS.CIVITAI_SEARCH_NSFW,
  SETTING_IDS.CIVITAI_MODAL_BASE_MODELS,
  SETTING_IDS.CIVITAI_MODAL_MODEL_TYPES,
];

test("SETTING_IDS/SETTING_DEFAULTS both declare exactly eighteen ids", () => {
  assert.equal(Object.keys(SETTING_IDS).length, 18);
  assert.deepEqual(Object.keys(SETTING_DEFAULTS).sort(), Object.values(SETTING_IDS).sort());
});

test("ANIMAFLOW_SETTINGS declares exactly fifteen dialog rows -- every registered id EXCEPT the three internal/superseded ones", () => {
  assert.equal(ANIMAFLOW_SETTINGS.length, 15);
  const ids = ANIMAFLOW_SETTINGS.map((s) => s.id).sort();
  const expected = Object.values(SETTING_IDS).filter((id) => !DIALOG_EXCLUDED_IDS.includes(id)).sort();
  assert.deepEqual(ids, expected);
});

test("the three dialog-excluded ids are NOT in ANIMAFLOW_SETTINGS, but ARE still real SETTING_IDS/SETTING_DEFAULTS entries", () => {
  for (const id of DIALOG_EXCLUDED_IDS) {
    assert.ok(!ANIMAFLOW_SETTINGS.some((s) => s.id === id), `${id} must not have a dialog row`);
    assert.ok(Object.values(SETTING_IDS).includes(id), `${id} must still be a registered SETTING_IDS entry`);
    assert.ok(Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, id), `${id} must still have a default`);
  }
});

test("every setting's id is in the AnimaFlow.<Group>.<Name> namespace", () => {
  for (const setting of ANIMAFLOW_SETTINGS) {
    assert.match(setting.id, /^AnimaFlow\.[A-Za-z]+\.[A-Za-z]+$/, setting.id);
  }
});

test("every setting's category is an array whose first element is 'AnimaFlow' -- the sidebar section name", () => {
  for (const setting of ANIMAFLOW_SETTINGS) {
    assert.ok(Array.isArray(setting.category), setting.id);
    assert.equal(setting.category[0], "AnimaFlow", setting.id);
  }
});

test("every setting carries a non-empty tooltip", () => {
  for (const setting of ANIMAFLOW_SETTINGS) {
    assert.equal(typeof setting.tooltip, "string", setting.id);
    assert.ok(setting.tooltip.length > 20, `${setting.id} tooltip looks too short to be real`);
  }
});

test("every setting's defaultValue matches the documented table (SETTING_DEFAULTS)", () => {
  for (const setting of ANIMAFLOW_SETTINGS) {
    assert.equal(setting.defaultValue, SETTING_DEFAULTS[setting.id], setting.id);
  }
});

test("the ten documented defaults, by name (regression against the task's own table)", () => {
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.CONSOLE_LOGGING], "off");
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.WHEEL_QUIET_PERIOD_MS], 450);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.TOOLTIP_DELAY_MS], 250);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.NODE_PANEL_FONT_SIZE], 14);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.NODE_CHROME], true);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.PERSIST_CONTEXT_RUN], false);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.CONFIRM_REMOVE_ROW], true);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.CIVITAI_ENABLED], true);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.HIDE_FILE_EXTENSION], false);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.SHOW_PREVIEW_THUMBNAILS], true);
});

test("the Civitai setting is a boolean, defaulting ON (must be explicitly turned off to go offline)", () => {
  const setting = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_ENABLED);
  assert.equal(setting.type, "boolean");
  assert.equal(setting.defaultValue, true);
});

test("the console-logging setting is a combo of exactly off/summary/debug, defaulting to off", () => {
  const setting = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CONSOLE_LOGGING);
  assert.equal(setting.type, "combo");
  assert.deepEqual(setting.options, ["off", "summary", "debug"]);
  assert.equal(setting.defaultValue, "off");
});

// ---------------------------------------------------------------------------
// M2 (docs/lora-loader-design.md §7c/§8) -- the Civitai API key + the four
// remembered search filters.
// ---------------------------------------------------------------------------

test("CIVITAI_API_KEY: id matches src/model_browser/keys.py's SETTING_ID verbatim -- it is NOT this file's to choose", () => {
  // This id string is read server-side by `src/model_browser/keys.py`
  // (`SETTING_ID = "AnimaFlow.Controls.CivitaiApiKey"`), wired ahead of this
  // frontend slice specifically so the read path works the instant this id
  // exists. A rename here would silently break that resolution with no
  // error on either side.
  assert.equal(SETTING_IDS.CIVITAI_API_KEY, "AnimaFlow.Controls.CivitaiApiKey");
  const setting = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_API_KEY);
  assert.equal(setting.type, "text");
  assert.equal(setting.defaultValue, "");
});

test("the base-model/sort/period search-filter settings are combos matching civitai_search.mjs's own option lists", () => {
  const baseModel = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL);
  assert.equal(baseModel.type, "combo");
  // A1 -- the DIALOG's own `{text, value}` variant, NOT the plain-string list
  // (`civitai_search.mjs`/`civitai_modal.mjs` still use the plain one).
  assert.deepEqual(baseModel.options, CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS);
  assert.notStrictEqual(baseModel.options, CIVITAI_SEARCH_BASE_MODEL_OPTIONS, "must not be the plain-string array");
  assert.equal(baseModel.defaultValue, "");

  const sort = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_SORT);
  assert.equal(sort.type, "combo");
  assert.deepEqual(sort.options, CIVITAI_SEARCH_SORT_OPTIONS);
  // Matches src/model_browser/civitai_search.py's own DEFAULT_SORT verbatim.
  assert.equal(sort.defaultValue, "Highest Rated");

  const period = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_PERIOD);
  assert.equal(period.type, "combo");
  assert.deepEqual(period.options, CIVITAI_SEARCH_PERIOD_OPTIONS);
  // Matches src/model_browser/civitai_search.py's own DEFAULT_PERIOD verbatim.
  assert.equal(period.defaultValue, "AllTime");
});

// ---------------------------------------------------------------------------
// A1 -- the base-model dialog combo's `{text, value}` options never produce
// an empty fallback (the untranslated-i18n-key bug, `settings.mjs`'s own
// `CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS` doc comment has the full
// decompiled-bundle evidence).
// ---------------------------------------------------------------------------

test("CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS: every entry has a non-empty text/truthy fallback, values match the plain list 1:1", () => {
  assert.equal(CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS.length, CIVITAI_SEARCH_BASE_MODEL_OPTIONS.length);
  for (let i = 0; i < CIVITAI_SEARCH_BASE_MODEL_OPTIONS.length; i += 1) {
    const entry = CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS[i];
    assert.equal(typeof entry, "object");
    assert.equal(entry.value, CIVITAI_SEARCH_BASE_MODEL_OPTIONS[i], "value must match the plain list, position-for-position");
    assert.equal(typeof entry.text, "string");
    assert.ok(entry.text.length > 0, `entry ${i} (value=${JSON.stringify(entry.value)}) must have a non-empty text fallback`);
  }
  const anyEntry = CIVITAI_SEARCH_BASE_MODEL_DIALOG_OPTIONS.find((e) => e.value === "");
  assert.ok(anyEntry, "the empty 'any base model' value must still be present");
  assert.equal(anyEntry.text, "Any", "the empty option's own display fallback, matching the picker's own 'Any' label");
});

// ---------------------------------------------------------------------------
// A2 -- CIVITAI_BROWSING_LEVEL (renamed from CIVITAI_SEARCH_LEVEL, owner
// 2026-07-31: the id/label said "search" when it now governs every surface
// that loads a Civitai image) -- and §7c-iv's own supersede-not-replace of
// CIVITAI_SEARCH_NSFW.
// ---------------------------------------------------------------------------

test("CIVITAI_BROWSING_LEVEL: a combo of exactly PG/PG-13/R/X/XXX, defaulting to PG, remembered user-wide, scope-neutral name", () => {
  const level = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_BROWSING_LEVEL);
  assert.equal(level.type, "combo");
  assert.deepEqual(level.options, CIVITAI_SEARCH_LEVEL_OPTIONS);
  assert.deepEqual(CIVITAI_SEARCH_LEVEL_OPTIONS, ["PG", "PG-13", "R", "X", "XXX"]);
  assert.equal(level.defaultValue, "PG");
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.CIVITAI_BROWSING_LEVEL], "PG");
  // Scope-neutral -- neither the id nor the visible name says "search" any
  // more (it governs the ⓘ panel and the download-time preview too).
  assert.equal(SETTING_IDS.CIVITAI_BROWSING_LEVEL, "AnimaFlow.Controls.CivitaiBrowsingLevel");
  assert.doesNotMatch(level.name.toLowerCase(), /search/);
});

test("CIVITAI_SEARCH_LEVEL_TO_INT: each label maps to Civitai's own bitmask value, in ascending order", () => {
  assert.deepEqual(CIVITAI_SEARCH_LEVEL_TO_INT, { PG: 1, "PG-13": 2, R: 4, X: 8, XXX: 16 });
});

test("the old NSFW id stays registered (append-only) but has no dialog row; the renamed browsing-level id has one", () => {
  assert.equal(SETTING_IDS.CIVITAI_SEARCH_NSFW, "AnimaFlow.Controls.CivitaiSearchNsfw");
  assert.ok(Object.values(SETTING_IDS).includes(SETTING_IDS.CIVITAI_SEARCH_NSFW), "the superseded id must still be a registered SETTING_IDS entry");
  assert.ok(!ANIMAFLOW_SETTINGS.some((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_NSFW), "A3 -- no dialog row for the superseded id");
  assert.ok(ANIMAFLOW_SETTINGS.some((s) => s.id === SETTING_IDS.CIVITAI_BROWSING_LEVEL));
});

// ---------------------------------------------------------------------------
// M2b -- the toolbar modal's own multi-value rail filters (docs/lora-loader-
// design.md §7c-i's rail: "select-adds-a-chip"). Stored as a JSON-array-of-
// strings STRING (no native multi-select settings-dialog widget type), never
// hand-edited from the dialog -- A4 (owner screenshot, 2026-07-31) removed
// their dialog row entirely (they used to render as bare `[]` text fields);
// `civitai_modal.mjs`'s own rail is their only real editor.
// ---------------------------------------------------------------------------

test("CIVITAI_MODAL_BASE_MODELS / CIVITAI_MODAL_MODEL_TYPES: registered ids/defaults (empty JSON array), but NO dialog row (A4)", () => {
  for (const id of [SETTING_IDS.CIVITAI_MODAL_BASE_MODELS, SETTING_IDS.CIVITAI_MODAL_MODEL_TYPES]) {
    assert.ok(!ANIMAFLOW_SETTINGS.some((s) => s.id === id), `${id} must have no dialog row`);
    assert.equal(SETTING_DEFAULTS[id], "[]");
    assert.match(id, /^AnimaFlow\.Controls\./);
  }
});

test("CIVITAI_MODAL_BASE_MODELS / CIVITAI_MODAL_MODEL_TYPES are distinct ids from the picker's own single-value filters", () => {
  assert.notEqual(SETTING_IDS.CIVITAI_MODAL_BASE_MODELS, SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL);
  assert.equal(SETTING_IDS.CIVITAI_MODAL_BASE_MODELS, "AnimaFlow.Controls.CivitaiModalBaseModels");
  assert.equal(SETTING_IDS.CIVITAI_MODAL_MODEL_TYPES, "AnimaFlow.Controls.CivitaiModalModelTypes");
});

// ---------------------------------------------------------------------------
// Register-once — importing/calling twice registers a single time.
// ---------------------------------------------------------------------------

function fakeApp() {
  const calls = [];
  return {
    calls,
    registerExtension(ext) {
      calls.push(ext);
    },
  };
}

test("registerAnimaFlowSettings registers the section exactly once, even across repeated calls", () => {
  _resetRegistrationForTests();
  try {
    const app = fakeApp();
    registerAnimaFlowSettings(app);
    registerAnimaFlowSettings(app);
    registerAnimaFlowSettings(app);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].name, "AnimaFlow.settings");
    assert.deepEqual(app.calls[0].settings, ANIMAFLOW_SETTINGS);
  } finally {
    _resetRegistrationForTests();
  }
});

test("registerAnimaFlowSettings called from a SECOND entry point after the first is a no-op (a different fake app never receives it)", () => {
  _resetRegistrationForTests();
  try {
    const appA = fakeApp();
    const appB = fakeApp();
    registerAnimaFlowSettings(appA);
    registerAnimaFlowSettings(appB); // "any entry point loading is enough" -- the first already did it
    assert.equal(appA.calls.length, 1);
    assert.equal(appB.calls.length, 0);
  } finally {
    _resetRegistrationForTests();
  }
});

test("registerAnimaFlowSettings never throws against a missing/garbage app", () => {
  _resetRegistrationForTests();
  try {
    assert.doesNotThrow(() => registerAnimaFlowSettings(null));
    assert.doesNotThrow(() => registerAnimaFlowSettings(undefined));
    assert.doesNotThrow(() => registerAnimaFlowSettings({}));
  } finally {
    _resetRegistrationForTests();
  }
});

// ---------------------------------------------------------------------------
// getSetting — new API, old-API fallback, and the fallback value on
// anything else.
// ---------------------------------------------------------------------------

test("getSetting reads from the new API (app.extensionManager.setting.get) when present", () => {
  const app = { extensionManager: { setting: { get: (id) => (id === "x" ? "debug" : undefined) } } };
  assert.equal(getSetting("x", "off", app), "debug");
});

test("getSetting falls back to the OLD API (app.ui.settings.getSettingValue) when the new one is absent", () => {
  const app = { ui: { settings: { getSettingValue: (id) => (id === "x" ? 999 : undefined) } } };
  assert.equal(getSetting("x", 450, app), 999);
});

test("getSetting prefers the new API over the old one when BOTH are present", () => {
  const app = {
    extensionManager: { setting: { get: () => "from-new" } },
    ui: { settings: { getSettingValue: () => "from-old" } },
  };
  assert.equal(getSetting("x", "fallback", app), "from-new");
});

test("getSetting falls back to the OLD API when the new one exists but returns null/undefined for this id", () => {
  const app = {
    extensionManager: { setting: { get: () => undefined } },
    ui: { settings: { getSettingValue: () => "from-old" } },
  };
  assert.equal(getSetting("x", "fallback", app), "from-old");
});

test("getSetting returns the fallback when no app is reachable at all", () => {
  assert.equal(getSetting("x", "fallback"), "fallback");
  assert.equal(getSetting("x", "fallback", null), "fallback");
  assert.equal(getSetting("x", "fallback", undefined), "fallback");
});

test("getSetting returns the fallback when the app object is garbage (neither API present)", () => {
  assert.equal(getSetting("x", "fallback", {}), "fallback");
  assert.equal(getSetting("x", "fallback", { extensionManager: {} }), "fallback");
  assert.equal(getSetting("x", "fallback", { ui: {} }), "fallback");
});

test("getSetting returns the fallback when a read API throws", () => {
  const app = {
    extensionManager: { setting: { get: () => { throw new Error("boom"); } } },
    ui: { settings: { getSettingValue: () => { throw new Error("boom too"); } } },
  };
  assert.equal(getSetting("x", "fallback", app), "fallback");
});

test("getSetting falls back to window.app when no appRef is injected", () => {
  globalThis.window = { app: { extensionManager: { setting: { get: () => "from-window" } } } };
  try {
    assert.equal(getSetting("x", "fallback"), "from-window");
  } finally {
    delete globalThis.window;
  }
});

test("getSetting prefers an injected appRef over window.app", () => {
  globalThis.window = { app: { extensionManager: { setting: { get: () => "from-window" } } } };
  try {
    const injected = { extensionManager: { setting: { get: () => "from-injected" } } };
    assert.equal(getSetting("x", "fallback", injected), "from-injected");
  } finally {
    delete globalThis.window;
  }
});

test("getSetting never throws with no window at all", () => {
  assert.doesNotThrow(() => getSetting("x", "fallback"));
});

// ---------------------------------------------------------------------------
// setSetting — the write-side counterpart (Slice 5, docs/lora-loader-design.md
// §7b: the LoRA Loader's own ⚙ dialog writes THREE of its eight fields
// through here, not through the per-node state blob).
// ---------------------------------------------------------------------------

test("setSetting writes through the new API (app.extensionManager.setting.set) and returns true", () => {
  const calls = [];
  const app = { extensionManager: { setting: { set: (id, v) => calls.push([id, v]) } } };
  assert.equal(setSetting("x", true, app), true);
  assert.deepEqual(calls, [["x", true]]);
});

test("setSetting falls back to the OLD API (app.ui.settings.setSettingValue) when the new one is absent", () => {
  const calls = [];
  const app = { ui: { settings: { setSettingValue: (id, v) => calls.push([id, v]) } } };
  assert.equal(setSetting("x", "hello", app), true);
  assert.deepEqual(calls, [["x", "hello"]]);
});

test("setSetting prefers the new API over the old one when BOTH are present", () => {
  const newCalls = [];
  const oldCalls = [];
  const app = {
    extensionManager: { setting: { set: (id, v) => newCalls.push([id, v]) } },
    ui: { settings: { setSettingValue: (id, v) => oldCalls.push([id, v]) } },
  };
  setSetting("x", 1, app);
  assert.deepEqual(newCalls, [["x", 1]]);
  assert.deepEqual(oldCalls, []);
});

test("setSetting returns false when no app is reachable, when the app is garbage, or when a write API throws -- never throws itself", () => {
  assert.equal(setSetting("x", 1), false);
  assert.equal(setSetting("x", 1, null), false);
  assert.equal(setSetting("x", 1, {}), false);
  const throwing = { extensionManager: { setting: { set: () => { throw new Error("boom"); } } } };
  assert.doesNotThrow(() => setSetting("x", 1, throwing));
  assert.equal(setSetting("x", 1, throwing), false);
});

test("setSetting falls back to window.app when no appRef is injected", () => {
  const calls = [];
  globalThis.window = { app: { extensionManager: { setting: { set: (id, v) => calls.push([id, v]) } } } };
  try {
    assert.equal(setSetting("x", "y"), true);
    assert.deepEqual(calls, [["x", "y"]]);
  } finally {
    delete globalThis.window;
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
