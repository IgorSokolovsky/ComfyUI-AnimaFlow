/**
 * queue_probe_fingerprint.mjs — pure builders for the queue-time state probe
 * (`.claude/CLAUDE.md` Task 2, 2026-07-30: "it always worked when they
 * manually ran `app.graphToPrompt()` in the console before queueing, and
 * failed when they didn't" — so the earlier state-handshake audit is dead
 * (widget and payload already agree on every measurement that DIDN'T touch
 * `graphToPrompt`), and the remaining fault is somewhere on the real queue
 * path this probe exists to observe).
 *
 * Every function here is pure — no `app`/`window`/DOM/litegraph access, so
 * this module is testable under plain `node` exactly like the reverted
 * `state_diagnostic.mjs` it's modelled on (`git show 4ec1c60`, reverted in
 * `3feeb08` for an UNRELATED reason — a static-import-budget violation in
 * `js/controls/index.js`, not a flaw in this module's own logic). The impure
 * half (reading `app.graph`'s live nodes/widgets, wrapping `api.queuePrompt`,
 * calling `console.*`) lives in `js/shared/queue_probe.mjs` — this module
 * only ever receives already-extracted strings/objects and hands back plain
 * data/strings, never touching the DOM or a real node itself.
 *
 * ## Covers all FIVE stateful nodes, not just the three Controls-track ones
 *
 * The reverted `state_diagnostic.mjs` only knew about `AnimaControlPanel`/
 * `AnimaLoaderPanel`/`AnimaLoraLoader` (the Controls track). This probe also
 * covers `AnimaGenerator`/`AnimaPreview` (`generation_settings`/
 * `preview_state`) — `2b80edb`'s audit already established there are exactly
 * five stateful nodes pack-wide; a probe for "does the live widget value
 * reach the submitted payload" should watch all five, not just the ones the
 * original stale-model report happened to name.
 *
 * ## Row-level fingerprint format
 *
 * Per the task brief: `slot → {id, kind, value, opts}`, one entry per row,
 * for BOTH the live and payload side. `id` is included for DISPLAY only —
 * `2b80edb`'s own audit already proved `normalizeRow` mints a FRESH id on
 * every parse (`rowSignature` bakes it in specifically so two parses of
 * identical JSON never signature-match), so two independent parses of the
 * SAME underlying state will legitimately have different `id`s every time.
 * Treating `id` as part of "do these two rows agree" would produce a false
 * mismatch on every single row, always, regardless of whether there's a real
 * bug — exactly the kind of noise that would bury the real signal. Row
 * agreement (`rowFingerprintsAgree`) therefore compares `slot`/`kind`/
 * `value`/`opts` only.
 *
 * `kind`/`value`/`opts` are extracted TOLERANTLY, since not every row-based
 * class's rows share the same shape: Control/Loader Panel rows have all
 * four fields the task names; `AnimaLoraLoader` rows have no `kind`/`slot`
 * at all (its rows are an ordered list, keyed by `name` — the LoRA path —
 * not a socket slot) and no `opts` object as such (their per-row inputs are
 * `sm`/`sc`/`on`/`triggers`, not `opts`). Rather than hand-roll a SECOND
 * fingerprint shape for that one class, this stays a single tolerant
 * function: `kind` falls back to `row.name` (the field that best answers
 * "what is this row" for a LoRA row), `slot` falls back to a `#<position>`
 * marker (an ordered-list position, not a real socket), and `value`/`opts`
 * are simply absent (`undefined`) when the row has neither — never thrown,
 * never invented.
 */

// The one widget name each of the pack's five stateful node classes
// serializes its state through (`js/controls/interaction.mjs`'s
// `getStateWidget` for the two Panel classes — same widget name,
// "panel_state", for both; `js/controls/lora_interaction.mjs`'s own
// `getStateWidget` for the LoRA Loader, "lora_state"; `nodes/anima/
// generator.py`/`nodes/anima/_preview_helpers.py`'s own declared STRING
// widgets for the last two). Exported so `queue_probe.mjs`'s node walk can
// build its class allow-list from this one place rather than a second
// hardcoded copy.
export const STATE_WIDGET_NAME_BY_CLASS = {
  AnimaControlPanel: "panel_state",
  AnimaLoaderPanel: "panel_state",
  AnimaLoraLoader: "lora_state",
  AnimaGenerator: "generation_settings",
  AnimaPreview: "preview_state",
};

export const DIAGNOSTIC_CLASSES = Object.keys(STATE_WIDGET_NAME_BY_CLASS);

/** The three classes whose state is a `{rows: [...]}` array worth a per-row
 * breakdown — `AnimaGenerator`/`AnimaPreview` are flat state blobs with no
 * per-row concept at all (`2b80edb`'s audit: "Generator and Preview are
 * structurally immune -- no per-row ids at all"), so a row breakdown for
 * those two would just be noise. */
export const ROW_BASED_CLASSES = new Set(["AnimaControlPanel", "AnimaLoaderPanel", "AnimaLoraLoader"]);

/**
 * Parse `raw` (a widget's serialized STRING value, or garbage) into a rows
 * array, tolerating anything at all: a non-string, invalid JSON, a parsed
 * value that isn't a plain object, a `rows` that isn't an array, or
 * individual rows that aren't plain objects all degrade to `[]` rather than
 * throwing — a broken/garbage value must still produce SOME diagnostic
 * output (an empty fingerprint), never an exception that skips the node
 * entirely.
 */
export function parseRows(raw) {
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

/** One row → `{slot, id, kind, value, opts}` (the task brief's own shape).
 * See this module's own top doc comment for the tolerant fallback rules. */
export function rowFingerprint(row, idx) {
  const slot = Number.isFinite(row.slot) ? row.slot : `#${idx + 1}`;
  const kind = row.kind !== undefined ? row.kind : row.name !== undefined ? row.name : null;
  return {
    slot,
    id: row.id,
    kind,
    value: row.value !== undefined ? row.value : undefined,
    opts: row.opts !== undefined ? row.opts : undefined,
  };
}

export function fingerprintRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map((row, idx) => rowFingerprint(row, idx));
}

/** `raw` (a widget's serialized STRING value, or garbage) straight to its
 * row fingerprint array. */
export function fingerprintOf(raw) {
  return fingerprintRows(parseRows(raw));
}

function stableEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  if (typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Whether two row fingerprints "agree" — `slot`/`kind`/`value`/`opts` only,
 * DELIBERATELY never `id` (this module's own top doc comment explains why:
 * a fresh id is minted on every parse, so comparing it would manufacture a
 * mismatch on every row, always, regardless of whether there's a real bug). */
export function rowFingerprintsAgree(a, b) {
  if (!a || !b) {
    return false;
  }
  return (
    String(a.slot) === String(b.slot) &&
    stableEqual(a.kind, b.kind) &&
    stableEqual(a.value, b.value) &&
    stableEqual(a.opts, b.opts)
  );
}

/** Index-by-index comparison of two row-fingerprint arrays (live vs
 * payload) — returns the list of indices that disagree (including "one
 * side is simply missing a row the other has", i.e. a length mismatch).
 * Never throws on empty/mismatched-length input. */
export function compareRowFingerprints(liveFp, payloadFp) {
  const live = Array.isArray(liveFp) ? liveFp : [];
  const payload = Array.isArray(payloadFp) ? payloadFp : [];
  const maxLen = Math.max(live.length, payload.length);
  const mismatches = [];
  for (let i = 0; i < maxLen; i++) {
    if (!rowFingerprintsAgree(live[i], payload[i])) {
      mismatches.push(i);
    }
  }
  return mismatches;
}

/**
 * One node's full comparison record. `liveRaw`/`payloadRaw` are the raw,
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
export function buildNodeReport({ nodeId, className, widgetName, liveRaw, payloadRaw, payloadHasInput }) {
  const rowBased = ROW_BASED_CLASSES.has(className);
  const agree = !!payloadHasInput && liveRaw === payloadRaw;
  const liveFingerprint = rowBased ? fingerprintOf(liveRaw) : [];
  const payloadFingerprint = rowBased ? fingerprintOf(payloadRaw) : [];
  return {
    nodeId: String(nodeId),
    className: String(className || "?"),
    widgetName: String(widgetName || "?"),
    liveRaw,
    payloadRaw,
    payloadHasInput: !!payloadHasInput,
    agree,
    rowBased,
    liveFingerprint,
    payloadFingerprint,
    rowMismatches: rowBased ? compareRowFingerprints(liveFingerprint, payloadFingerprint) : [],
  };
}

/**
 * `report` → `{ loud, lines }`. `loud` is `true` for anything that is NOT a
 * clean agreement (a genuine mismatch on the raw string, a per-row
 * mismatch, or the widget missing from the payload entirely) — the caller
 * uses this to pick `console.warn` over `console.log`, so the interesting
 * case is impossible to scroll past. `lines` is always a non-empty array of
 * plain strings, each already prefixed `[AnimaFlow]` — never a single giant
 * multi-line string, so a caller-side `console.warn`/`console.log` per line
 * reads the same as every other line in this pack's console output.
 *
 * Row-based classes ALWAYS get one line per row (the task brief's "log a
 * fingerprint per row for both"), showing BOTH sides side by side — not
 * only the mismatching ones — so a clean run is directly visible as "every
 * row agrees", not just an absence of complaints.
 */
export function formatNodeReportLines(report) {
  const { nodeId, className, widgetName, agree, payloadHasInput, liveRaw, payloadRaw, rowBased, liveFingerprint, payloadFingerprint, rowMismatches } =
    report;
  const head = `[AnimaFlow] queue-probe node ${nodeId} (${className}) widget '${widgetName}'`;

  if (!payloadHasInput) {
    return {
      loud: true,
      lines: [
        `${head}: !!! MISMATCH !!! this widget is ABSENT from the submitted payload's inputs entirely`,
        `${head}: live raw = ${liveRaw}`,
      ],
    };
  }

  const lines = [];
  if (agree) {
    lines.push(`${head}: live == payload (agree)`);
  } else {
    lines.push(`${head}: !!! MISMATCH !!! live widget value differs from the submitted payload value`);
    lines.push(`${head}: live    raw = ${liveRaw}`);
    lines.push(`${head}: payload raw = ${payloadRaw}`);
  }

  if (rowBased) {
    const maxLen = Math.max(liveFingerprint.length, payloadFingerprint.length);
    for (let i = 0; i < maxLen; i++) {
      const liveEntry = liveFingerprint[i];
      const payloadEntry = payloadFingerprint[i];
      const slot = (liveEntry && liveEntry.slot) ?? (payloadEntry && payloadEntry.slot) ?? `#${i + 1}`;
      const rowMismatch = rowMismatches.includes(i);
      lines.push(
        `${head}: row slot ${slot} -> live=${JSON.stringify(liveEntry)} payload=${JSON.stringify(payloadEntry)}` +
          (rowMismatch ? ` !!! MISMATCH !!!` : ""),
      );
    }
  }

  return { loud: !agree || (rowBased && rowMismatches.length > 0), lines };
}

/** `[AnimaFlow] queue-probe: N node(s) checked, M mismatch(es)` — the one
 * summary line printed after every node's own lines, so a scan of the
 * console immediately answers "did anything disagree" without reading
 * every node's block. Counts a node as a "mismatch" on its TOP-LEVEL raw
 * agreement only (matching `queue_probe.mjs`'s own tally) — a row-level
 * breakdown is diagnostic detail, not a second count. */
export function formatSummaryLine(checkedCount, mismatchCount) {
  return `[AnimaFlow] queue-probe: ${checkedCount} node(s) checked, ${mismatchCount} mismatch(es)`;
}

/** Whether `output` (the per-node prompt dict half of the payload
 * `api.queuePrompt` was actually called with) is a real, comparable
 * prompt-payload object — a plain object, not an array. `false` for
 * anything else (missing, `null`, a primitive, a bare array) — the caller
 * uses this to distinguish "the payload genuinely doesn't have this
 * widget's input" (a real per-node finding) from "there is no payload to
 * compare against at all" (a future frontend build changed `api.queuePrompt`'s
 * own argument shape) — the latter must never be reported as every single
 * node "missing" its input, which would be actively misleading. */
export function hasComparablePayload(output) {
  return !!output && typeof output === "object" && !Array.isArray(output);
}

/** The one line printed instead of any per-node comparison when
 * `hasComparablePayload` says there is nothing usable to compare against —
 * loud (this is itself worth flagging: either `api.queuePrompt`'s own
 * argument shape no longer matches this probe's assumption, read off the
 * installed `comfyui_frontend_package` build (`js/shared/queue_probe.mjs`'s
 * own top doc comment has the exact call site), or something upstream
 * genuinely submitted with no output at all. */
export function formatNoPayloadLine() {
  return "[AnimaFlow] queue-probe: api.queuePrompt was not called with a usable {output} payload (argument shape doesn't match this probe's assumption) -- skipping per-node comparison this submit";
}
