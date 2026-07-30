/**
 * test_state_diagnostic.mjs — regression tests for `state_diagnostic.mjs`
 * (the pure half of the queue-time stale-state diagnostic). No DOM, no
 * `app`/`window` — plain `node js/controls/test_state_diagnostic.mjs`.
 */

import assert from "node:assert/strict";

import {
  STATE_WIDGET_NAME_BY_CLASS,
  DIAGNOSTIC_CLASSES,
  parseRowsForFingerprint,
  fingerprintRows,
  fingerprintOf,
  buildNodeReport,
  formatNodeReportLines,
  formatSummaryLine,
  hasComparablePayload,
  formatNoPayloadLine,
} from "./state_diagnostic.mjs";

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
// STATE_WIDGET_NAME_BY_CLASS / DIAGNOSTIC_CLASSES
// ---------------------------------------------------------------------------

test("STATE_WIDGET_NAME_BY_CLASS covers exactly the three diagnostic-relevant classes", () => {
  assert.deepEqual(Object.keys(STATE_WIDGET_NAME_BY_CLASS).sort(), [
    "AnimaControlPanel",
    "AnimaLoaderPanel",
    "AnimaLoraLoader",
  ]);
});

test("AnimaControlPanel and AnimaLoaderPanel share the 'panel_state' widget name; AnimaLoraLoader uses 'lora_state'", () => {
  assert.equal(STATE_WIDGET_NAME_BY_CLASS.AnimaControlPanel, "panel_state");
  assert.equal(STATE_WIDGET_NAME_BY_CLASS.AnimaLoaderPanel, "panel_state");
  assert.equal(STATE_WIDGET_NAME_BY_CLASS.AnimaLoraLoader, "lora_state");
});

test("DIAGNOSTIC_CLASSES is derived from STATE_WIDGET_NAME_BY_CLASS's own keys", () => {
  assert.deepEqual(DIAGNOSTIC_CLASSES.sort(), Object.keys(STATE_WIDGET_NAME_BY_CLASS).sort());
});

// ---------------------------------------------------------------------------
// parseRowsForFingerprint — tolerant parsing
// ---------------------------------------------------------------------------

test("parseRowsForFingerprint parses a well-formed {rows:[...]} JSON string", () => {
  const raw = JSON.stringify({ version: 1, rows: [{ slot: 1, name: "unet", value: "a.safetensors" }] });
  const rows = parseRowsForFingerprint(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "a.safetensors");
});

test("parseRowsForFingerprint tolerates a non-string", () => {
  assert.deepEqual(parseRowsForFingerprint(undefined), []);
  assert.deepEqual(parseRowsForFingerprint(null), []);
  assert.deepEqual(parseRowsForFingerprint(42), []);
  assert.deepEqual(parseRowsForFingerprint({ rows: [] }), []);
});

test("parseRowsForFingerprint tolerates invalid JSON", () => {
  assert.deepEqual(parseRowsForFingerprint("{not json"), []);
  assert.deepEqual(parseRowsForFingerprint(""), []);
});

test("parseRowsForFingerprint tolerates JSON that isn't a {rows:[...]} object", () => {
  assert.deepEqual(parseRowsForFingerprint("42"), []);
  assert.deepEqual(parseRowsForFingerprint("null"), []);
  assert.deepEqual(parseRowsForFingerprint("[1,2,3]"), []);
  assert.deepEqual(parseRowsForFingerprint("{}"), []);
  assert.deepEqual(parseRowsForFingerprint(JSON.stringify({ rows: "not an array" })), []);
});

test("parseRowsForFingerprint drops non-object entries inside rows, keeps real ones", () => {
  const raw = JSON.stringify({ rows: [null, 5, [1, 2], { name: "seed" }, "x"] });
  const rows = parseRowsForFingerprint(raw);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "seed");
});

// ---------------------------------------------------------------------------
// fingerprintRows — the "slot→name[=value]" summary
// ---------------------------------------------------------------------------

test("fingerprintRows uses the row's numeric slot, and includes a distinct value", () => {
  const rows = [
    { slot: 1, name: "unet", value: "a.safetensors" },
    { slot: 2, name: "vae", value: "b.safetensors" },
    { slot: 3, name: "clip", value: "c.safetensors" },
  ];
  assert.deepEqual(fingerprintRows(rows), ["1→unet=a.safetensors", "2→vae=b.safetensors", "3→clip=c.safetensors"]);
});

test("fingerprintRows falls back to a 1-based #position when slot isn't a finite number (AnimaLoraLoader rows)", () => {
  const rows = [{ name: "loraA.safetensors" }, { name: "loraB.safetensors" }];
  assert.deepEqual(fingerprintRows(rows), ["#1→loraA.safetensors", "#2→loraB.safetensors"]);
});

test("fingerprintRows falls back to kind, then '(unnamed)', when name is missing/blank", () => {
  const rows = [{ slot: 1, kind: "sampler" }, { slot: 2 }, { slot: 3, name: "   " }];
  assert.deepEqual(fingerprintRows(rows), ["1→sampler", "2→(unnamed)", "3→(unnamed)"]);
});

test("fingerprintRows omits '=value' when value is undefined/null, or equal to the label", () => {
  const rows = [
    { slot: 1, name: "seed" },
    { slot: 2, name: "seed", value: null },
    { slot: 3, name: "seed", value: "seed" },
  ];
  assert.deepEqual(fingerprintRows(rows), ["1→seed", "2→seed", "3→seed"]);
});

test("fingerprintRows includes a distinct scalar value (numbers, not just strings)", () => {
  const rows = [{ slot: 1, name: "steps", value: 30 }];
  assert.deepEqual(fingerprintRows(rows), ["1→steps=30"]);
});

test("fingerprintRows tolerates a non-array", () => {
  assert.deepEqual(fingerprintRows(null), []);
  assert.deepEqual(fingerprintRows(undefined), []);
  assert.deepEqual(fingerprintRows("nope"), []);
});

test("fingerprintOf chains parse+fingerprint end to end", () => {
  const raw = JSON.stringify({ rows: [{ slot: 1, name: "unet", value: "x.safetensors" }] });
  assert.deepEqual(fingerprintOf(raw), ["1→unet=x.safetensors"]);
  assert.deepEqual(fingerprintOf("garbage"), []);
});

// ---------------------------------------------------------------------------
// buildNodeReport — the agree/disagree decision
// ---------------------------------------------------------------------------

const THREE_ROW_STATE = JSON.stringify({
  version: 1,
  rows: [
    { slot: 1, name: "unet", value: "unet_a.safetensors" },
    { slot: 2, name: "vae", value: "vae_a.safetensors" },
    { slot: 3, name: "clip", value: "clip_a.safetensors" },
  ],
});

test("buildNodeReport agrees when live===payload and the input was present", () => {
  const report = buildNodeReport({
    nodeId: 17,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveValue: THREE_ROW_STATE,
    payloadValue: THREE_ROW_STATE,
    payloadHasInput: true,
  });
  assert.equal(report.agree, true);
  assert.equal(report.nodeId, "17");
  assert.equal(report.liveFingerprint.length, 3);
  assert.deepEqual(report.liveFingerprint, report.payloadFingerprint);
});

test("buildNodeReport disagrees when the payload's value differs from the live value", () => {
  const staleState = JSON.stringify({
    version: 1,
    rows: [
      { slot: 1, name: "unet", value: "unet_a.safetensors" },
      { slot: 2, name: "vae", value: "vae_a.safetensors" },
      { slot: 3, name: "clip", value: "clip_OLD.safetensors" },
    ],
  });
  const report = buildNodeReport({
    nodeId: 17,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveValue: THREE_ROW_STATE,
    payloadValue: staleState,
    payloadHasInput: true,
  });
  assert.equal(report.agree, false);
  assert.notEqual(report.liveFingerprint[2], report.payloadFingerprint[2]);
});

test("buildNodeReport disagrees when the payload never had the input at all", () => {
  const report = buildNodeReport({
    nodeId: 17,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveValue: THREE_ROW_STATE,
    payloadValue: undefined,
    payloadHasInput: false,
  });
  assert.equal(report.agree, false);
  assert.equal(report.payloadHasInput, false);
});

test("buildNodeReport treats two textually-different-but-parse-equal JSON strings as a disagreement (raw string compare, not parsed)", () => {
  const withSpace = JSON.stringify({ rows: [{ slot: 1, name: "unet", value: "a.safetensors" }] }, null, 2);
  const noSpace = JSON.stringify({ rows: [{ slot: 1, name: "unet", value: "a.safetensors" }] });
  const report = buildNodeReport({
    nodeId: 1,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveValue: withSpace,
    payloadValue: noSpace,
    payloadHasInput: true,
  });
  assert.equal(report.agree, false);
  // But the fingerprints (the PARSED view) agree -- exactly the "reverse
  // mismatch" case the task brief calls out: same fingerprint, different
  // string, still worth flagging.
  assert.deepEqual(report.liveFingerprint, report.payloadFingerprint);
});

// ---------------------------------------------------------------------------
// formatNodeReportLines — loud vs quiet, and verbatim raw strings
// ---------------------------------------------------------------------------

test("formatNodeReportLines is quiet (loud:false) on agreement, one line, includes the fingerprint", () => {
  const report = buildNodeReport({
    nodeId: 3,
    className: "AnimaControlPanel",
    widgetName: "panel_state",
    liveValue: THREE_ROW_STATE,
    payloadValue: THREE_ROW_STATE,
    payloadHasInput: true,
  });
  const { loud, lines } = formatNodeReportLines(report);
  assert.equal(loud, false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /live == payload \(agree\)/);
  assert.match(lines[0], /1→unet=unet_a\.safetensors/);
});

test("formatNodeReportLines is loud on a value mismatch, and prints BOTH raw strings verbatim", () => {
  const stale = JSON.stringify({ rows: [{ slot: 1, name: "unet", value: "OLD.safetensors" }] });
  const report = buildNodeReport({
    nodeId: 3,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveValue: THREE_ROW_STATE,
    payloadValue: stale,
    payloadHasInput: true,
  });
  const { loud, lines } = formatNodeReportLines(report);
  assert.equal(loud, true);
  assert.ok(lines.some((l) => l.includes("!!! MISMATCH !!!")));
  assert.ok(lines.some((l) => l === `[AnimaFlow] state-diagnostic node 3 (AnimaLoaderPanel) widget 'panel_state': live    raw = ${THREE_ROW_STATE}`));
  assert.ok(lines.some((l) => l === `[AnimaFlow] state-diagnostic node 3 (AnimaLoaderPanel) widget 'panel_state': payload raw = ${stale}`));
});

test("formatNodeReportLines is loud when the widget is absent from the payload entirely", () => {
  const report = buildNodeReport({
    nodeId: 9,
    className: "AnimaLoraLoader",
    widgetName: "lora_state",
    liveValue: THREE_ROW_STATE,
    payloadValue: undefined,
    payloadHasInput: false,
  });
  const { loud, lines } = formatNodeReportLines(report);
  assert.equal(loud, true);
  assert.ok(lines.some((l) => l.includes("ABSENT from the submitted payload")));
});

test("formatNodeReportLines every line is prefixed [AnimaFlow]", () => {
  const agreeReport = buildNodeReport({
    nodeId: 1,
    className: "AnimaControlPanel",
    widgetName: "panel_state",
    liveValue: "{}",
    payloadValue: "{}",
    payloadHasInput: true,
  });
  for (const line of formatNodeReportLines(agreeReport).lines) {
    assert.ok(line.startsWith("[AnimaFlow]"), line);
  }
  const mismatchReport = buildNodeReport({
    nodeId: 1,
    className: "AnimaControlPanel",
    widgetName: "panel_state",
    liveValue: "{}",
    payloadValue: "{\"rows\":[]}",
    payloadHasInput: true,
  });
  for (const line of formatNodeReportLines(mismatchReport).lines) {
    assert.ok(line.startsWith("[AnimaFlow]"), line);
  }
});

// ---------------------------------------------------------------------------
// formatSummaryLine
// ---------------------------------------------------------------------------

test("formatSummaryLine reports checked and mismatch counts", () => {
  assert.equal(formatSummaryLine(3, 0), "[AnimaFlow] state-diagnostic: 3 node(s) checked, 0 mismatch(es)");
  assert.equal(formatSummaryLine(3, 1), "[AnimaFlow] state-diagnostic: 3 node(s) checked, 1 mismatch(es)");
});

// ---------------------------------------------------------------------------
// hasComparablePayload / formatNoPayloadLine -- the "graphToPrompt resolved
// to something unusable" guard (a rejected/failed call still fires the
// submit_guard.mjs listener fan-out with `undefined`; must not be reported
// as every node "missing" its input).
// ---------------------------------------------------------------------------

test("hasComparablePayload is true only for a real, non-array object", () => {
  assert.equal(hasComparablePayload({ 1: { inputs: {} } }), true);
  assert.equal(hasComparablePayload({}), true);
});

test("hasComparablePayload is false for undefined/null/a primitive/an array", () => {
  assert.equal(hasComparablePayload(undefined), false);
  assert.equal(hasComparablePayload(null), false);
  assert.equal(hasComparablePayload(0), false);
  assert.equal(hasComparablePayload(""), false);
  assert.equal(hasComparablePayload([1, 2]), false);
});

test("formatNoPayloadLine is a single [AnimaFlow]-prefixed string", () => {
  const line = formatNoPayloadLine();
  assert.equal(typeof line, "string");
  assert.ok(line.startsWith("[AnimaFlow]"));
  assert.match(line, /skipping per-node comparison/);
});

console.log(`\n${count - failures}/${count} tests passed`);
if (failures > 0) {
  process.exitCode = 1;
}
