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
  registerAnimaFlowSettings,
  _resetRegistrationForTests,
  getSetting,
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
// Declaration shape — seven settings, all under the AnimaFlow category, ids
// in the documented namespace, every one with a tooltip and a default
// matching the table (task brief).
// ---------------------------------------------------------------------------

test("ANIMAFLOW_SETTINGS declares exactly the seven documented settings", () => {
  assert.equal(ANIMAFLOW_SETTINGS.length, 7);
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

test("the seven documented defaults, by name (regression against the task's own table)", () => {
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.CONSOLE_LOGGING], "off");
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.WHEEL_QUIET_PERIOD_MS], 450);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.TOOLTIP_DELAY_MS], 250);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.NODE_PANEL_FONT_SIZE], 14);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.NODE_CHROME], true);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.PERSIST_CONTEXT_RUN], false);
  assert.equal(SETTING_DEFAULTS[SETTING_IDS.CONFIRM_REMOVE_ROW], true);
});

test("the console-logging setting is a combo of exactly off/summary/debug, defaulting to off", () => {
  const setting = ANIMAFLOW_SETTINGS.find((s) => s.id === SETTING_IDS.CONSOLE_LOGGING);
  assert.equal(setting.type, "combo");
  assert.deepEqual(setting.options, ["off", "summary", "debug"]);
  assert.equal(setting.defaultValue, "off");
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

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
