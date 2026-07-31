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
// Declaration shape — sixteen settings (the original ten, documented below,
// plus M2's five: docs/lora-loader-design.md §8's `CIVITAI_API_KEY` and
// §7c-i's four remembered search filters, `CIVITAI_SEARCH_BASE_MODEL`/
// `_SORT`/`_PERIOD`/`_NSFW`, plus §7c-iv's own `CIVITAI_SEARCH_LEVEL`, which
// supersedes `_NSFW` but does not replace its own registered entry), all
// under the AnimaFlow category, ids in the documented namespace, every one
// with a tooltip and a default matching the table. Re-count rather than
// trusting this number — it only ever grows.
// ---------------------------------------------------------------------------

test("ANIMAFLOW_SETTINGS declares exactly the sixteen documented settings", () => {
  assert.equal(ANIMAFLOW_SETTINGS.length, 16);
  const ids = ANIMAFLOW_SETTINGS.map((s) => s.id).sort();
  assert.deepEqual(ids, Object.values(SETTING_IDS).sort());
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

test("the four search-filter settings are combos/boolean matching civitai_search.mjs's own option lists, NSFW defaults off", () => {
  const baseModel = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_BASE_MODEL);
  assert.equal(baseModel.type, "combo");
  assert.deepEqual(baseModel.options, CIVITAI_SEARCH_BASE_MODEL_OPTIONS);
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

  const nsfw = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_NSFW);
  assert.equal(nsfw.type, "boolean");
  assert.equal(nsfw.defaultValue, false, "NSFW ships OFF (owner decision, §7c-i) -- kept registered even though superseded (§7c-iv)");
});

// ---------------------------------------------------------------------------
// §7c-iv -- the "maximum browsing level" select supersedes CIVITAI_SEARCH_NSFW.
// ---------------------------------------------------------------------------

test("CIVITAI_SEARCH_LEVEL: a combo of exactly PG/PG-13/R/X/XXX, defaulting to PG, remembered user-wide", () => {
  const level = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_LEVEL);
  assert.equal(level.type, "combo");
  assert.deepEqual(level.options, CIVITAI_SEARCH_LEVEL_OPTIONS);
  assert.deepEqual(CIVITAI_SEARCH_LEVEL_OPTIONS, ["PG", "PG-13", "R", "X", "XXX"]);
  assert.equal(level.defaultValue, "PG");
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.CIVITAI_SEARCH_LEVEL], "PG");
});

test("CIVITAI_SEARCH_LEVEL_TO_INT: each label maps to Civitai's own bitmask value, in ascending order", () => {
  assert.deepEqual(CIVITAI_SEARCH_LEVEL_TO_INT, { PG: 1, "PG-13": 2, R: 4, X: 8, XXX: 16 });
});

test("both the old NSFW id and the new LEVEL id stay registered -- an id is append-only, never deleted", () => {
  assert.equal(SETTING_IDS.CIVITAI_SEARCH_NSFW, "AnimaFlow.Controls.CivitaiSearchNsfw");
  assert.equal(SETTING_IDS.CIVITAI_SEARCH_LEVEL, "AnimaFlow.Controls.CivitaiSearchLevel");
  assert.ok(ANIMAFLOW_SETTINGS.some((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_NSFW), "the superseded id must still be registered, not deleted");
  assert.ok(ANIMAFLOW_SETTINGS.some((s) => s.id === SETTING_IDS.CIVITAI_SEARCH_LEVEL));
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
