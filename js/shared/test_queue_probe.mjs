/**
 * test_queue_probe.mjs — regression tests for `queue_probe.mjs` (the impure
 * half of the queue-time state probe, `.claude/CLAUDE.md` Task 2,
 * 2026-07-30). `queue_probe.mjs` carries a top-level `/scripts/app.js` +
 * `/scripts/api.js` import (both only exist inside a real ComfyUI page), so
 * — same convention as `js/shared/submit_guard.mjs`/`js/shared/
 * graph_loading.mjs`, neither of which has a dedicated test file, and every
 * `index.js`-adjacent check in this pack — this suite reads the file's own
 * source text rather than importing it. The pure comparison logic that DOES
 * import cleanly (`queue_probe_fingerprint.mjs`) has its own full
 * behavioural suite, `test_queue_probe_fingerprint.mjs`.
 *
 * The one property this file exists to pin down HARD, as a regression: the
 * owner's decisive clue ("it always worked when they manually ran
 * `app.graphToPrompt()` before queueing, and failed when they didn't") means
 * this probe must NEVER call or wrap `graphToPrompt` -- doing so would
 * create the very condition it exists to observe. A source-scan is the only
 * way to catch that mistake being reintroduced later, since nothing about a
 * behavioural test run under `node` can prove a *browser* hook was never
 * installed.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "queue_probe.mjs"), "utf8");

// This file's own doc comments deliberately quote `app.graphToPrompt()` in
// PROSE (explaining why the probe must avoid it) -- a naive scan over the
// raw source would trip on its own explanation. Strip block (`/** ... */`)
// and line (`// ...`) comments before scanning for actual CODE, exactly the
// distinction these regressions care about.
const CODE_ONLY = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

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

test("queue_probe.mjs never calls or wraps app.graphToPrompt -- the owner's clue means doing so would create the exact condition this probe exists to observe", () => {
  assert.doesNotMatch(CODE_ONLY, /app\.graphToPrompt\s*\(/, "must never CALL app.graphToPrompt");
  assert.doesNotMatch(CODE_ONLY, /app\.graphToPrompt\s*=/, "must never WRAP (reassign) app.graphToPrompt");
  assert.doesNotMatch(CODE_ONLY, /\.graphToPrompt\s*\(\s*\)/, "must never call a bare .graphToPrompt() of any kind");
});

test("queue_probe.mjs hooks api.queuePrompt -- the real submit funnel (api.queuePrompt's own 2nd argument IS the {output, workflow} payload, already produced by app.queuePrompt's single internal graphToPrompt call)", () => {
  assert.match(SRC, /import\s*\{\s*api\s*\}\s*from\s*"\/scripts\/api\.js"/, "must import api from /scripts/api.js");
  assert.match(SRC, /api\.queuePrompt\s*=\s*function/, "must wrap api.queuePrompt by reassignment");
});

test("queue_probe.mjs guards the wrap on the api object itself (hot-reload safe) and never wraps a non-function", () => {
  assert.match(SRC, /api\._wtnQueueProbeWrapped/, "must guard against a double-wrap via a flag on api itself");
  assert.match(
    SRC,
    /typeof\s+api\.queuePrompt\s*!==\s*"function"/,
    "must check api.queuePrompt is actually a function before wrapping it",
  );
});

test("queue_probe.mjs runs the probe body wrapped in its own try/catch, BEFORE delegating to the original call, and returns the original's result unmodified", () => {
  const fnIdx = SRC.indexOf("api.queuePrompt = function");
  assert.ok(fnIdx >= 0, "the wrapper function must exist");
  const fnBody = SRC.slice(fnIdx, SRC.indexOf("};", fnIdx));
  const tryIdx = fnBody.indexOf("try {");
  const runIdx = fnBody.indexOf("runQueueProbe(");
  const catchIdx = fnBody.indexOf("catch");
  const returnIdx = fnBody.indexOf("return original(");
  assert.ok(tryIdx >= 0 && runIdx > tryIdx, "runQueueProbe must be called inside a try block");
  assert.ok(catchIdx > runIdx, "a catch must follow the runQueueProbe call");
  assert.ok(returnIdx > catchIdx, "the original call's result must be returned AFTER the guarded probe body, unmodified");
});

test("queue_probe.mjs gates on the LIVE 'debug' console-logging setting BEFORE any graph walk", () => {
  const fnIdx = SRC.indexOf("function runQueueProbe(payload)");
  assert.ok(fnIdx >= 0, "runQueueProbe must exist");
  const nextFnIdx = SRC.indexOf("function ", fnIdx + 1);
  const fnBody = SRC.slice(fnIdx, nextFnIdx > fnIdx ? nextFnIdx : undefined);
  const settingIdx = fnBody.indexOf("getSetting(SETTING_IDS.CONSOLE_LOGGING");
  const walkIdx = fnBody.indexOf("findProbeNodes(");
  assert.ok(settingIdx >= 0, "must read the CONSOLE_LOGGING setting");
  assert.ok(walkIdx > settingIdx, "the setting must be checked BEFORE the graph walk ever runs");
});

test("queue_probe.mjs never imports anything from js/controls/rows.mjs or lora_state.mjs -- stays a thin, track-agnostic probe over the widget name map alone", () => {
  assert.doesNotMatch(SRC, /from\s*"\.\.\/controls\//);
});

test("queue_probe.mjs checks for a duplicate same-name widget (candidate 4, 2026-07-30 course correction) BEFORE building the raw-value report, using .filter() (not .find()) so a genuine duplicate is actually detected rather than silently collapsed to the first match", () => {
  const fnIdx = SRC.indexOf("function runQueueProbe(payload)");
  assert.ok(fnIdx >= 0);
  const nextFnIdx = SRC.indexOf("function ", fnIdx + 1);
  const fnBody = SRC.slice(fnIdx, nextFnIdx > fnIdx ? nextFnIdx : undefined);
  const filterIdx = fnBody.indexOf(".filter((w) => w.name === widgetName)");
  const dupCheckIdx = fnBody.indexOf("formatDuplicateWidgetLine");
  const reportIdx = fnBody.indexOf("buildNodeReport(");
  assert.ok(filterIdx >= 0, "must collect ALL matching widgets via .filter(), not just the first via .find()");
  assert.ok(dupCheckIdx > filterIdx, "the duplicate check must run after collecting all matches");
  assert.ok(reportIdx > dupCheckIdx, "the duplicate check must run BEFORE the raw-value report, so it's never buried under a (possibly misleading) diff");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
