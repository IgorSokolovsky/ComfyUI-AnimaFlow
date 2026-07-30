/**
 * test_queue_probe_fingerprint.mjs — regression tests for
 * `queue_probe_fingerprint.mjs` (the pure half of the queue-time state
 * probe, `.claude/CLAUDE.md` Task 2, 2026-07-30). Plain `node`, no real
 * browser/ComfyUI host — this module has zero `app`/`window`/DOM reference,
 * so every function here is exercised directly, exactly like the reverted
 * `state_diagnostic.mjs` this is modelled on (`test_state_diagnostic.mjs`,
 * `git show 4ec1c60`).
 */

import assert from "node:assert/strict";

import {
  STATE_WIDGET_NAME_BY_CLASS,
  DIAGNOSTIC_CLASSES,
  ROW_BASED_CLASSES,
  parseRows,
  rowFingerprint,
  fingerprintRows,
  fingerprintOf,
  rowFingerprintsAgree,
  compareRowFingerprints,
  buildNodeReport,
  formatNodeReportLines,
  formatSummaryLine,
  hasComparablePayload,
  formatNoPayloadLine,
  formatDuplicateWidgetLine,
} from "./queue_probe_fingerprint.mjs";

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
// STATE_WIDGET_NAME_BY_CLASS / ROW_BASED_CLASSES -- all FIVE stateful nodes,
// both tracks (2b80edb's audit is the authority on the count).
// ---------------------------------------------------------------------------

test("STATE_WIDGET_NAME_BY_CLASS covers all five stateful nodes, both tracks", () => {
  assert.deepEqual(STATE_WIDGET_NAME_BY_CLASS, {
    AnimaControlPanel: "panel_state",
    AnimaLoaderPanel: "panel_state",
    AnimaLoraLoader: "lora_state",
    AnimaGenerator: "generation_settings",
    AnimaPreview: "preview_state",
  });
  assert.equal(DIAGNOSTIC_CLASSES.length, 5);
});

test("ROW_BASED_CLASSES is exactly the three Controls-track classes -- Generator/Preview have no per-row concept at all", () => {
  assert.deepEqual(
    [...ROW_BASED_CLASSES].sort(),
    ["AnimaControlPanel", "AnimaLoaderPanel", "AnimaLoraLoader"].sort(),
  );
  assert.ok(!ROW_BASED_CLASSES.has("AnimaGenerator"));
  assert.ok(!ROW_BASED_CLASSES.has("AnimaPreview"));
});

// ---------------------------------------------------------------------------
// parseRows -- tolerant of garbage, never throws.
// ---------------------------------------------------------------------------

test("parseRows: a well-formed {rows: [...]} string parses straight through", () => {
  const rows = parseRows(JSON.stringify({ rows: [{ id: "a", kind: "unet", slot: 1, value: "foo.safetensors" }] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "unet");
});

test("parseRows: non-string, invalid JSON, non-object, missing/non-array rows, and non-object row entries all degrade to [] -- never throw", () => {
  assert.deepEqual(parseRows(undefined), []);
  assert.deepEqual(parseRows(null), []);
  assert.deepEqual(parseRows(42), []);
  assert.deepEqual(parseRows("{not json"), []);
  assert.deepEqual(parseRows(JSON.stringify([1, 2, 3])), []);
  assert.deepEqual(parseRows(JSON.stringify({})), []);
  assert.deepEqual(parseRows(JSON.stringify({ rows: "nope" })), []);
  assert.deepEqual(parseRows(JSON.stringify({ rows: [1, "x", null, ["a"]] })), []);
});

// ---------------------------------------------------------------------------
// rowFingerprint / fingerprintRows / fingerprintOf -- the task brief's
// `slot -> {id, kind, value, opts}` shape, tolerant field extraction.
// ---------------------------------------------------------------------------

test("rowFingerprint: a Control/Loader Panel row (slot/kind/value/opts all present) maps straight through", () => {
  const row = { id: "row-1", kind: "unet", slot: 3, value: "foo.safetensors", opts: { weight_dtype: "default" } };
  assert.deepEqual(rowFingerprint(row, 0), {
    slot: 3,
    id: "row-1",
    kind: "unet",
    value: "foo.safetensors",
    opts: { weight_dtype: "default" },
  });
});

test("rowFingerprint: a row with no `slot` falls back to a `#<position>` marker (1-based, from its ARRAY index)", () => {
  const row = { id: "row-1", name: "some/lora.safetensors" };
  assert.deepEqual(rowFingerprint(row, 2), {
    slot: "#3",
    id: "row-1",
    kind: "some/lora.safetensors",
    value: undefined,
    opts: undefined,
  });
});

test("rowFingerprint: `kind` falls back to `name` when the row has no `kind` field (AnimaLoraLoader's own shape) -- never invents a value", () => {
  const row = { id: "x" };
  const fp = rowFingerprint(row, 0);
  assert.equal(fp.kind, null);
  assert.equal(fp.value, undefined);
  assert.equal(fp.opts, undefined);
});

test("fingerprintRows: non-array input degrades to [] rather than throwing", () => {
  assert.deepEqual(fingerprintRows(null), []);
  assert.deepEqual(fingerprintRows(undefined), []);
  assert.deepEqual(fingerprintRows("nope"), []);
});

test("fingerprintOf: a raw serialized string goes straight from parse to fingerprint", () => {
  const raw = JSON.stringify({ rows: [{ id: "a", kind: "vae", slot: 1, value: "v.safetensors" }] });
  const fp = fingerprintOf(raw);
  assert.equal(fp.length, 1);
  assert.equal(fp[0].kind, "vae");
  assert.equal(fp[0].slot, 1);
});

// ---------------------------------------------------------------------------
// rowFingerprintsAgree -- NEVER compares `id` (2b80edb's audit: a fresh id
// is minted on every parse, so two independently-parsed copies of the exact
// SAME state legitimately have different ids every time).
// ---------------------------------------------------------------------------

test("rowFingerprintsAgree: two fingerprints with the SAME slot/kind/value/opts but DIFFERENT ids still agree", () => {
  const a = { slot: 1, id: "id-a", kind: "unet", value: "foo.safetensors", opts: { weight_dtype: "default" } };
  const b = { slot: 1, id: "id-b", kind: "unet", value: "foo.safetensors", opts: { weight_dtype: "default" } };
  assert.ok(rowFingerprintsAgree(a, b));
});

test("rowFingerprintsAgree: a genuinely different value disagrees", () => {
  const a = { slot: 1, id: "id-a", kind: "unet", value: "foo.safetensors" };
  const b = { slot: 1, id: "id-b", kind: "unet", value: "bar.safetensors" };
  assert.ok(!rowFingerprintsAgree(a, b));
});

test("rowFingerprintsAgree: a different slot disagrees, even with everything else identical", () => {
  const a = { slot: 1, id: "id-a", kind: "unet", value: "foo.safetensors" };
  const b = { slot: 2, id: "id-b", kind: "unet", value: "foo.safetensors" };
  assert.ok(!rowFingerprintsAgree(a, b));
});

test("rowFingerprintsAgree: a different opts object disagrees (structural compare, not reference)", () => {
  const a = { slot: 1, id: "id-a", kind: "float", value: 0.5, opts: { min: 0, max: 1, step: 0.01 } };
  const b = { slot: 1, id: "id-b", kind: "float", value: 0.5, opts: { min: 0, max: 2, step: 0.01 } };
  assert.ok(!rowFingerprintsAgree(a, b));
});

test("rowFingerprintsAgree: missing entries on either side never agree, never throw", () => {
  assert.ok(!rowFingerprintsAgree(undefined, { slot: 1 }));
  assert.ok(!rowFingerprintsAgree({ slot: 1 }, undefined));
  assert.ok(!rowFingerprintsAgree(undefined, undefined));
});

// ---------------------------------------------------------------------------
// compareRowFingerprints -- index-by-index, length-mismatch tolerant.
// ---------------------------------------------------------------------------

test("compareRowFingerprints: identical fingerprint arrays (different ids) produce zero mismatches", () => {
  const live = [
    { slot: 1, id: "a1", kind: "unet", value: "foo.safetensors" },
    { slot: 2, id: "a2", kind: "vae", value: "v.safetensors" },
  ];
  const payload = [
    { slot: 1, id: "b1", kind: "unet", value: "foo.safetensors" },
    { slot: 2, id: "b2", kind: "vae", value: "v.safetensors" },
  ];
  assert.deepEqual(compareRowFingerprints(live, payload), []);
});

test("compareRowFingerprints: a single differing row is reported at its own index -- this is the stale-model case", () => {
  const live = [
    { slot: 1, id: "a1", kind: "unet", value: "NEW.safetensors" },
    { slot: 2, id: "a2", kind: "vae", value: "v.safetensors" },
  ];
  const payload = [
    { slot: 1, id: "b1", kind: "unet", value: "STALE.safetensors" },
    { slot: 2, id: "b2", kind: "vae", value: "v.safetensors" },
  ];
  assert.deepEqual(compareRowFingerprints(live, payload), [0]);
});

test("compareRowFingerprints: a length mismatch (a row added/removed on one side) flags the extra index too", () => {
  const live = [{ slot: 1, id: "a1", kind: "unet", value: "foo" }, { slot: 2, id: "a2", kind: "vae", value: "v" }];
  const payload = [{ slot: 1, id: "b1", kind: "unet", value: "foo" }];
  assert.deepEqual(compareRowFingerprints(live, payload), [1]);
});

test("compareRowFingerprints: non-array input degrades to empty arrays rather than throwing", () => {
  assert.deepEqual(compareRowFingerprints(null, undefined), []);
});

// ---------------------------------------------------------------------------
// buildNodeReport -- the one entry point queue_probe.mjs actually calls.
// ---------------------------------------------------------------------------

test("buildNodeReport: a row-based class with identical raw strings agrees, row-level fingerprints populated, zero row mismatches", () => {
  const raw = JSON.stringify({ rows: [{ id: "a", kind: "unet", slot: 1, value: "foo.safetensors" }] });
  const report = buildNodeReport({
    nodeId: 7,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveRaw: raw,
    payloadRaw: raw,
    payloadHasInput: true,
  });
  assert.equal(report.agree, true);
  assert.equal(report.rowBased, true);
  assert.equal(report.rowMismatches.length, 0);
  assert.equal(report.liveFingerprint.length, 1);
});

test("buildNodeReport: a row-based class with a stale model in the PAYLOAD (live already shows the new one) disagrees on the raw string AND flags the exact row", () => {
  const liveRaw = JSON.stringify({ rows: [{ id: "a", kind: "unet", slot: 1, value: "NEW.safetensors" }] });
  const payloadRaw = JSON.stringify({ rows: [{ id: "b", kind: "unet", slot: 1, value: "STALE.safetensors" }] });
  const report = buildNodeReport({
    nodeId: 7,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveRaw,
    payloadRaw,
    payloadHasInput: true,
  });
  assert.equal(report.agree, false);
  assert.deepEqual(report.rowMismatches, [0]);
});

test("buildNodeReport: a flat (non-row-based) class -- AnimaGenerator/AnimaPreview -- never runs the row breakdown at all", () => {
  const report = buildNodeReport({
    nodeId: 3,
    className: "AnimaGenerator",
    widgetName: "generation_settings",
    liveRaw: "{}",
    payloadRaw: "{}",
    payloadHasInput: true,
  });
  assert.equal(report.rowBased, false);
  assert.deepEqual(report.liveFingerprint, []);
  assert.deepEqual(report.payloadFingerprint, []);
  assert.deepEqual(report.rowMismatches, []);
});

test("buildNodeReport: payloadHasInput=false is ALWAYS a disagreement, even if payloadRaw happens to equal liveRaw (e.g. both undefined)", () => {
  const report = buildNodeReport({
    nodeId: 1,
    className: "AnimaGenerator",
    widgetName: "generation_settings",
    liveRaw: "{}",
    payloadRaw: undefined,
    payloadHasInput: false,
  });
  assert.equal(report.agree, false);
});

// ---------------------------------------------------------------------------
// formatNodeReportLines -- loud/quiet + always-present row breakdown.
// ---------------------------------------------------------------------------

test("formatNodeReportLines: an absent-from-payload widget is loud with exactly two lines, and never prints a payload raw it doesn't have", () => {
  const report = buildNodeReport({
    nodeId: 1,
    className: "AnimaGenerator",
    widgetName: "generation_settings",
    liveRaw: "{}",
    payloadRaw: undefined,
    payloadHasInput: false,
  });
  const { loud, lines } = formatNodeReportLines(report);
  assert.equal(loud, true);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("ABSENT from the submitted payload"));
  assert.ok(lines.every((l) => !l.includes("payload raw")));
});

test("formatNodeReportLines: a clean agreement on a flat class is quiet, one line", () => {
  const report = buildNodeReport({
    nodeId: 1,
    className: "AnimaPreview",
    widgetName: "preview_state",
    liveRaw: "{}",
    payloadRaw: "{}",
    payloadHasInput: true,
  });
  const { loud, lines } = formatNodeReportLines(report);
  assert.equal(loud, false);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("agree"));
});

test("formatNodeReportLines: a row-based class ALWAYS gets one line per row, both sides shown, even when everything agrees (task brief: 'per row for both')", () => {
  const raw = JSON.stringify({
    rows: [
      { id: "a", kind: "unet", slot: 1, value: "foo.safetensors" },
      { id: "b", kind: "vae", slot: 2, value: "v.safetensors" },
    ],
  });
  const report = buildNodeReport({
    nodeId: 1,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveRaw: raw,
    payloadRaw: raw,
    payloadHasInput: true,
  });
  const { loud, lines } = formatNodeReportLines(report);
  assert.equal(loud, false);
  // one summary line + one line per row
  assert.equal(lines.length, 3);
  assert.ok(lines[1].includes("row slot 1"));
  assert.ok(lines[1].includes("live="));
  assert.ok(lines[1].includes("payload="));
  assert.ok(lines[2].includes("row slot 2"));
  assert.ok(!lines[1].includes("MISMATCH"));
});

test("formatNodeReportLines: a row-based class with ONE stale row is loud, and only that row's line is marked MISMATCH", () => {
  const liveRaw = JSON.stringify({
    rows: [
      { id: "a1", kind: "unet", slot: 1, value: "NEW.safetensors" },
      { id: "a2", kind: "vae", slot: 2, value: "v.safetensors" },
    ],
  });
  const payloadRaw = JSON.stringify({
    rows: [
      { id: "b1", kind: "unet", slot: 1, value: "STALE.safetensors" },
      { id: "b2", kind: "vae", slot: 2, value: "v.safetensors" },
    ],
  });
  const report = buildNodeReport({
    nodeId: 1,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveRaw,
    payloadRaw,
    payloadHasInput: true,
  });
  const { loud, lines } = formatNodeReportLines(report);
  assert.equal(loud, true);
  const row1Line = lines.find((l) => l.includes("row slot 1"));
  const row2Line = lines.find((l) => l.includes("row slot 2"));
  assert.ok(row1Line.includes("MISMATCH"));
  assert.ok(!row2Line.includes("MISMATCH"));
});

test("formatNodeReportLines: raw strings are printed VERBATIM -- never re-JSON.stringify'd (a whitespace-only difference must stay visible)", () => {
  const liveRaw = '{"rows":[{"id":"a","kind":"unet","slot":1,"value":"foo"}]}';
  const payloadRaw = '{ "rows": [ { "id": "a", "kind": "unet", "slot": 1, "value": "foo" } ] }'; // same data, different whitespace
  const report = buildNodeReport({
    nodeId: 1,
    className: "AnimaLoaderPanel",
    widgetName: "panel_state",
    liveRaw,
    payloadRaw,
    payloadHasInput: true,
  });
  assert.equal(report.agree, false, "textually different raw strings must NOT agree, even if they parse the same");
  const { lines } = formatNodeReportLines(report);
  assert.ok(lines.some((l) => l.includes(liveRaw)));
  assert.ok(lines.some((l) => l.includes(payloadRaw)));
});

// ---------------------------------------------------------------------------
// formatSummaryLine / hasComparablePayload / formatNoPayloadLine
// ---------------------------------------------------------------------------

test("formatSummaryLine: renders the checked/mismatch counts", () => {
  assert.equal(formatSummaryLine(5, 0), "[AnimaFlow] queue-probe: 5 node(s) checked, 0 mismatch(es)");
  assert.equal(formatSummaryLine(2, 1), "[AnimaFlow] queue-probe: 2 node(s) checked, 1 mismatch(es)");
});

test("hasComparablePayload: true only for a plain, non-array object", () => {
  assert.equal(hasComparablePayload({ 1: { inputs: {} } }), true);
  assert.equal(hasComparablePayload(null), false);
  assert.equal(hasComparablePayload(undefined), false);
  assert.equal(hasComparablePayload([]), false);
  assert.equal(hasComparablePayload("nope"), false);
  assert.equal(hasComparablePayload(42), false);
});

test("formatNoPayloadLine: a single non-empty string, prefixed [AnimaFlow]", () => {
  const line = formatNoPayloadLine();
  assert.equal(typeof line, "string");
  assert.ok(line.startsWith("[AnimaFlow]"));
});

// ---------------------------------------------------------------------------
// formatDuplicateWidgetLine -- candidate 4 (2026-07-30 course correction).
// ---------------------------------------------------------------------------

test("formatDuplicateWidgetLine: names the node/class/widget, the count, and every duplicate's raw value verbatim in node.widgets order", () => {
  const rawValues = ['{"rows":[]}', '{"rows":[{"x":1}]}'];
  const line = formatDuplicateWidgetLine(7, "AnimaLoaderPanel", "panel_state", rawValues);
  assert.ok(line.startsWith("[AnimaFlow]"));
  assert.ok(line.includes("node 7"));
  assert.ok(line.includes("AnimaLoaderPanel"));
  assert.ok(line.includes("panel_state"));
  assert.ok(line.includes("2 widgets"));
  // The raw values are embedded via JSON.stringify(rawValues) (an array of
  // strings), which escapes each entry's own quotes -- assert against that
  // SAME encoding rather than the unescaped literal.
  assert.ok(line.includes(JSON.stringify(rawValues)));
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
