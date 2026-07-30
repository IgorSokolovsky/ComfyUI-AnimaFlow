/**
 * state_diagnostic.mjs — pure builders for the queue-time stale-state
 * diagnostic ("AnimaLoaderPanel generates with a stale model" investigation:
 * every simpler hypothesis has been eliminated by evidence, so the task is
 * to capture, at the moment a prompt is actually submitted, whether each
 * relevant node's LIVE serialized widget value agrees with the value that
 * ended up in the outgoing payload).
 *
 * Every function here is pure — no `app`/`window`/DOM/litegraph access, so
 * this module is testable under plain `node` exactly like `rows.mjs`/
 * `lora_state.mjs` (see `test_state_diagnostic.mjs`). The impure half (
 * reading `app.graph`'s live nodes/widgets, calling `console.*`) lives in
 * `js/controls/index.js`'s `installStateDiagnosticHook`/`runStateDiagnostic`
 * — this module only ever receives already-extracted strings and hands back
 * plain data/strings, never touching the DOM or a real node itself.
 *
 * DELIBERATELY does not import `rows.mjs`'s or `lora_state.mjs`'s own
 * `normalizeState` — this diagnostic only ever needs to LOOK at whatever a
 * widget's raw JSON string says, not materialize a fully-defaulted state
 * object (ids minted, missing fields backfilled, etc.). Tying a
 * diagnostic-only module to the two live state schemas it exists to catch a
 * possible MISMATCH between would be exactly backwards — this stays a
 * dumb, tolerant reader of `{rows: [...]}` shaped JSON, nothing more.
 */

// The one widget name each diagnostic-relevant class serializes its state
// through (`js/controls/interaction.mjs`'s `getStateWidget` for the two
// Panel classes — same widget name, "panel_state", for both — and
// `js/controls/lora_interaction.mjs`'s own `getStateWidget` for the LoRA
// Loader, "lora_state"). Exported so `index.js`'s node walk can build its
// class allow-list from this one place rather than a second hardcoded copy.
export const STATE_WIDGET_NAME_BY_CLASS = {
  AnimaControlPanel: "panel_state",
  AnimaLoaderPanel: "panel_state",
  AnimaLoraLoader: "lora_state",
};

export const DIAGNOSTIC_CLASSES = Object.keys(STATE_WIDGET_NAME_BY_CLASS);

/**
 * Parse `raw` (a widget's serialized STRING value, or garbage) into a rows
 * array, tolerating anything at all: a non-string, invalid JSON, a parsed
 * value that isn't a plain object, a `rows` that isn't an array, or
 * individual rows that aren't plain objects all degrade to `[]` rather than
 * throwing — a broken/garbage value must still produce SOME diagnostic
 * output (an empty fingerprint), never an exception that skips the node
 * entirely.
 */
export function parseRowsForFingerprint(raw) {
  if (typeof raw !== "string") {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.rows)) {
    return [];
  }
  return parsed.rows.filter((r) => r && typeof r === "object" && !Array.isArray(r));
}

/**
 * One row → a short `<position>→<label>[=<value>]` fingerprint entry.
 * `position` is the row's own numeric `slot` (Control/Loader Panel rows —
 * a real output-socket slot) when present, else the row's 1-based ARRAY
 * POSITION prefixed `#` (AnimaLoraLoader rows — an ordered list, not
 * per-socket slots), so the two forms stay visually distinguishable at a
 * glance. `label` is `name` (falling back to `kind`, then `"(unnamed)"` for
 * a genuinely blank row — never silently dropped). `value` is appended only
 * when present AND distinct from `label` — this is what actually catches a
 * stale MODEL: a Loader Panel row's `name` is typically just its kind
 * ("unet"/"vae"/"clip") unless renamed, but `value` is the resolved
 * filename that determines what actually loads, so leaving it out would
 * hide exactly the field this diagnostic exists to compare.
 */
export function fingerprintRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row, idx) => {
    const label =
      (typeof row.name === "string" && row.name.trim()) ||
      (typeof row.kind === "string" && row.kind.trim()) ||
      "(unnamed)";
    const pos = Number.isFinite(row.slot) ? String(row.slot) : `#${idx + 1}`;
    const value = row.value;
    const hasDistinctValue = value !== undefined && value !== null && String(value) !== label;
    return hasDistinctValue ? `${pos}→${label}=${value}` : `${pos}→${label}`;
  });
}

/** `raw` (a widget's serialized STRING value, or garbage) straight to its
 * fingerprint array — the one entry point `index.js` actually calls per
 * side (live/payload). */
export function fingerprintOf(raw) {
  return fingerprintRows(parseRowsForFingerprint(raw));
}

/**
 * One node's full comparison record. `liveValue`/`payloadValue` are the raw,
 * UNTOUCHED serialized STRING values (never re-stringified/pretty-printed)
 * — printed verbatim by the caller so a whitespace- or key-ordering-only
 * difference between two textually-different-but-parses-the-same-way blobs
 * stays visible, rather than being hidden behind a parsed summary (two JSON
 * strings that PARSE equal but differ textually still bust ComfyUI's own
 * cache-key comparison, so that mismatch matters exactly as much as an
 * "obviously different" one).
 *
 * `payloadHasInput` (the widget's name wasn't even a key in the outgoing
 * node's `inputs` at all) is treated as disagreement — a widget that never
 * reached the payload is at least as loud a finding as one that reached it
 * with the wrong value.
 */
export function buildNodeReport({ nodeId, className, widgetName, liveValue, payloadValue, payloadHasInput }) {
  const agree = !!payloadHasInput && liveValue === payloadValue;
  return {
    nodeId: String(nodeId),
    className: String(className || "?"),
    widgetName: String(widgetName || "?"),
    liveValue,
    payloadValue,
    payloadHasInput: !!payloadHasInput,
    agree,
    liveFingerprint: fingerprintOf(liveValue),
    payloadFingerprint: fingerprintOf(payloadValue),
  };
}

/**
 * `report` → `{ loud, lines }`. `loud` is `true` for anything that is NOT a
 * clean agreement (a genuine mismatch, or the widget missing from the
 * payload entirely) — `index.js` uses this to pick `console.warn` over
 * `console.log`, so the interesting case is impossible to scroll past.
 * `lines` is always a non-empty array of plain strings, each already
 * prefixed `[AnimaFlow]` (matching `src/anima/logs.py`'s own message
 * convention) — never a single giant multi-line string, so a caller-side
 * `console.warn`/`console.log` per line reads the same as every other line
 * in this pack's console output.
 */
export function formatNodeReportLines(report) {
  const { nodeId, className, widgetName, agree, payloadHasInput, liveFingerprint, payloadFingerprint, liveValue, payloadValue } =
    report;
  const head = `[AnimaFlow] state-diagnostic node ${nodeId} (${className}) widget '${widgetName}'`;

  if (!payloadHasInput) {
    return {
      loud: true,
      lines: [
        `${head}: !!! MISMATCH !!! this widget is ABSENT from the submitted payload's inputs entirely`,
        `${head}: live fingerprint = [${liveFingerprint.join(", ")}]`,
        `${head}: live raw = ${liveValue}`,
      ],
    };
  }

  if (agree) {
    return {
      loud: false,
      lines: [`${head}: live == payload (agree) — fingerprint = [${liveFingerprint.join(", ")}]`],
    };
  }

  return {
    loud: true,
    lines: [
      `${head}: !!! MISMATCH !!! live widget value differs from the submitted payload value`,
      `${head}: live    fingerprint = [${liveFingerprint.join(", ")}]`,
      `${head}: payload fingerprint = [${payloadFingerprint.join(", ")}]`,
      `${head}: live    raw = ${liveValue}`,
      `${head}: payload raw = ${payloadValue}`,
    ],
  };
}

/** `[AnimaFlow] state-diagnostic: N node(s) checked, M mismatch(es)` — the
 * one summary line `index.js` prints after every node's own lines, so a scan
 * of the console immediately answers "did anything disagree" without
 * reading every node's block. */
export function formatSummaryLine(checkedCount, mismatchCount) {
  return `[AnimaFlow] state-diagnostic: ${checkedCount} node(s) checked, ${mismatchCount} mismatch(es)`;
}

/** Whether `output` (the `.output` half of whatever `app.graphToPrompt`
 * resolved to) is a real, comparable prompt-payload object — a plain object,
 * not an array. `false` for anything else (missing, `null`, a primitive, a
 * bare array) — the caller uses this to distinguish "the payload genuinely
 * doesn't have this widget's input" (a real per-node finding) from "there is
 * no payload to compare against at all" (`graphToPrompt` rejected/threw
 * synchronously and its `.finally`-driven listener fan-out still fired with
 * `undefined`, or a future frontend build changed the resolved shape) —
 * the latter must never be reported as every single node "missing" its
 * input, which would be actively misleading. */
export function hasComparablePayload(output) {
  return !!output && typeof output === "object" && !Array.isArray(output);
}

/** The one line printed instead of any per-node comparison when
 * `hasComparablePayload` says there is nothing usable to compare against —
 * loud (this is itself worth flagging: either the submit never actually
 * produced a payload, or this diagnostic's assumption about
 * `graphToPrompt`'s resolved shape (`{workflow, output}`, confirmed against
 * the currently installed `comfyui_frontend_package` build — see
 * `submit_guard.mjs`'s own doc comment) no longer holds on this frontend
 * build. */
export function formatNoPayloadLine() {
  return "[AnimaFlow] state-diagnostic: graphToPrompt did not resolve a usable {output} payload (call failed, or the resolved shape doesn't match this diagnostic's assumption) -- skipping per-node comparison this submit";
}
