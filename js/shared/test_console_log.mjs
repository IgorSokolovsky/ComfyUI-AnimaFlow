/**
 * test_console_log.mjs — regression tests for `console_log.mjs` (the
 * level-aware logging helper the Controls track's Civitai surfaces route
 * their diagnostic output through). Plain `node`, no real browser/ComfyUI
 * host — same convention as every other `test_*.mjs` in this pack.
 */

import assert from "node:assert/strict";

import { consoleLoggingLevel, logSummary, logDebug } from "./console_log.mjs";
import { SETTING_IDS } from "./settings.mjs";

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

function withLevel(level, fn) {
  globalThis.window = { app: { extensionManager: { setting: { get: (id) => (id === SETTING_IDS.CONSOLE_LOGGING ? level : undefined) } } } };
  const calls = [];
  const origLog = console.log;
  console.log = (...args) => calls.push(args);
  try {
    fn(calls);
  } finally {
    console.log = origLog;
    delete globalThis.window;
  }
}

// ---------------------------------------------------------------------------
// consoleLoggingLevel -- reads the live setting, degrades to the default.
// ---------------------------------------------------------------------------

test("consoleLoggingLevel: reads whatever the live setting says", () => {
  withLevel("debug", () => {
    assert.equal(consoleLoggingLevel(), "debug");
  });
  withLevel("summary", () => {
    assert.equal(consoleLoggingLevel(), "summary");
  });
  withLevel("off", () => {
    assert.equal(consoleLoggingLevel(), "off");
  });
});

test("consoleLoggingLevel: defaults to 'off' with no live app reachable", () => {
  assert.equal(consoleLoggingLevel(), "off");
});

test("consoleLoggingLevel: an unrecognised stored value degrades to the default rather than throwing", () => {
  globalThis.window = { app: { extensionManager: { setting: { get: () => "garbage-level" } } } };
  try {
    assert.equal(consoleLoggingLevel(), "off");
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// logSummary / logDebug -- gated by level, never throw, tag the surface.
// ---------------------------------------------------------------------------

test("at 'off': neither logSummary nor logDebug prints anything", () => {
  withLevel("off", (calls) => {
    logSummary("LoRA search", "search issued");
    logDebug("LoRA search", "filters: {}");
    assert.equal(calls.length, 0);
  });
});

test("at 'summary': logSummary prints, logDebug stays silent", () => {
  withLevel("summary", (calls) => {
    logSummary("LoRA search", "search issued");
    logDebug("LoRA search", "filters: {}");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "[AnimaFlow LoRA search]");
    assert.equal(calls[0][1], "search issued");
  });
});

test("at 'debug': both logSummary and logDebug print", () => {
  withLevel("debug", (calls) => {
    logSummary("LoRA search", "search issued");
    logDebug("LoRA search", "filters: {}");
    assert.equal(calls.length, 2);
    assert.equal(calls[0][1], "search issued");
    assert.equal(calls[1][1], "filters: {}");
  });
});

test("every line is tagged with its own surface, distinguishing concurrent callers", () => {
  withLevel("debug", (calls) => {
    logSummary("LoRA search", "a");
    logSummary("Civitai browser", "b");
    logSummary("LoRA info", "c");
    logSummary("LoRA picker", "d");
    assert.deepEqual(calls.map((c) => c[0]), [
      "[AnimaFlow LoRA search]",
      "[AnimaFlow Civitai browser]",
      "[AnimaFlow LoRA info]",
      "[AnimaFlow LoRA picker]",
    ]);
  });
});

test("multiple trailing arguments are all forwarded, in order", () => {
  withLevel("debug", (calls) => {
    logSummary("LoRA search", "count:", 3, "kind:", "loras");
    assert.deepEqual(calls[0], ["[AnimaFlow LoRA search]", "count:", 3, "kind:", "loras"]);
  });
});

test("a falsy/absent surface still logs, with a bare pack-wide tag, never throws", () => {
  withLevel("summary", (calls) => {
    assert.doesNotThrow(() => logSummary("", "hello"));
    assert.equal(calls[0][0], "[AnimaFlow]");
  });
});

test("neither function ever throws, even with no live app reachable", () => {
  assert.doesNotThrow(() => logSummary("LoRA search", "x"));
  assert.doesNotThrow(() => logDebug("LoRA search", "x"));
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
