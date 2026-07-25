/**
 * core.mjs — pure block-list state + assembly logic for the Anima Prompt
 * Studio node. No DOM access (importable/testable under plain Node).
 *
 * Mirrors `nodes/_anima_prompt_studio_helpers.py`'s schema and algorithm
 * 1:1 (per the frontend skill's "keep JS render logic byte-for-byte
 * equivalent to the Python render logic" note):
 *   - A block: `{id, type, label, text, enabled, pin}`.
 *   - `blocks_state`: `{positive: [block, ...], negative: [block, ...]}`.
 *   - `assemblePaneSegments`/`substituteRest` are a direct port of
 *     `assemble_pane_segments`/`substitute_rest` — same position-preserving
 *     pin/rest-placeholder algorithm, same tolerant-parse contract.
 *
 * The LIVE PREVIEW this module powers (`assemblePanePreview`) NEVER calls
 * the real Prompt Rules engine — it always renders the UNCORRECTED
 * assembly (rest-placeholder text substituted with itself, i.e. identity).
 * This is a deliberate, documented scope choice (see `render.mjs`'s preview
 * section + the build report): it is byte-for-byte identical to the
 * backend's own output when `rules_correction_enabled` is OFF, and an
 * honest "pre-correction" preview when it's ON — `index.js`/`render.mjs`
 * label it "(uncorrected)" in that case so nobody mistakes it for the real
 * corrected result.
 */

export const BLOCK_TYPES = ["quality", "artist", "trigger", "general"];

export const TYPE_LABELS = {
  quality: "Quality Tags",
  artist: "Artist Mix",
  trigger: "LoRA Trigger",
  general: "General",
};

// ---------------------------------------------------------------------------
// Block id generation
// ---------------------------------------------------------------------------

let uidCounter = 1000;

/** Reset the module-level id counter (test hygiene only — production code
 * never needs to call this, ids just need to be unique per session). */
export function resetBlockIdCounter(start = 1000) {
  uidCounter = start;
}

function nextBlockId() {
  uidCounter += 1;
  return "blk" + uidCounter;
}

// ---------------------------------------------------------------------------
// Block / state construction
// ---------------------------------------------------------------------------

/** Build a new block of `type` (falls back to "general" for an unrecognized
 * type), auto-labeled from `TYPE_LABELS`, pinned by default only for
 * "trigger" (mirrors `playground/anima_prompt_studio.html`'s seed data —
 * LoRA trigger words are the canonical "must not be reordered" case). */
export function makeBlock(type, text = "") {
  const resolvedType = BLOCK_TYPES.includes(type) ? type : "general";
  return {
    id: nextBlockId(),
    type: resolvedType,
    label: TYPE_LABELS[resolvedType] || "General",
    text,
    enabled: true,
    pin: resolvedType === "trigger",
  };
}

/** The block editor's seed content — mirrors
 * `_anima_prompt_studio_helpers.default_blocks_state()` / the widget's
 * Python-side JSON default exactly (4 positive blocks + 1 negative block).
 * Only used as a defensive fallback if the `blocks_state` widget somehow
 * has no value at all when the node mounts; normally the Python default
 * JSON already seeds the widget before `onNodeCreated` ever runs, so
 * `parseBlocksState(widget.value)` is what actually seeds the UI. */
export function defaultBlocksState() {
  return {
    positive: [
      {
        id: "p1", type: "quality", label: "Quality Tags",
        text: "newest, masterpiece, best quality, absurdres", enabled: true, pin: false,
      },
      {
        id: "p2", type: "artist", label: "Artist Mix",
        text: "@wlop, @sakimichan", enabled: true, pin: false,
      },
      {
        id: "p3", type: "trigger", label: "LoRA Trigger",
        text: "ohwx_style, celica_v2", enabled: true, pin: true,
      },
      {
        id: "p4", type: "general", label: "Scene",
        text: "1girl, solo, silver hair, violet eyes, rainy neon alley, cinematic lighting",
        enabled: true, pin: false,
      },
    ],
    negative: [
      {
        id: "n1", type: "general", label: "Negative",
        text: "worst quality, low quality, blurry, extra digits, watermark", enabled: true, pin: false,
      },
    ],
  };
}

/** Normalize a single raw block object to the class contract — mirrors
 * `_anima_prompt_studio_helpers._normalize_block` exactly: missing/
 * unrecognized `type` -> "general"; missing `enabled` -> true; missing
 * `pin` -> false; missing `text`/`label` -> "". */
export function normalizeBlock(raw) {
  const block = raw && typeof raw === "object" ? raw : {};
  const type = BLOCK_TYPES.includes(block.type) ? block.type : "general";
  return {
    id: block.id != null ? String(block.id) : "",
    type,
    label: block.label != null ? String(block.label) : "",
    text: block.text != null ? String(block.text) : "",
    enabled: block.enabled === undefined ? true : !!block.enabled,
    pin: block.pin === undefined ? false : !!block.pin,
  };
}

function normalizePane(pane) {
  if (!Array.isArray(pane)) {
    return [];
  }
  return pane
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map(normalizeBlock);
}

/** Tolerant parse of the `blocks_state` widget's JSON string — mirrors
 * `_anima_prompt_studio_helpers.parse_blocks_state` exactly: invalid JSON,
 * or JSON that isn't an object (a list/string/number/null), never throws —
 * it returns the empty shape `{positive: [], negative: []}` instead. A
 * corrupted hidden widget must never break the node's UI. */
export function parseBlocksState(raw) {
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { positive: [], negative: [] };
  }
  return {
    positive: normalizePane(data.positive),
    negative: normalizePane(data.negative),
  };
}

/** Serialize `state` (only its `positive`/`negative` arrays) back to the
 * JSON string the `blocks_state` widget carries. */
export function serializeBlocksState(state) {
  return JSON.stringify({
    positive: (state && state.positive) || [],
    negative: (state && state.negative) || [],
  });
}

// ---------------------------------------------------------------------------
// Mutations — each mutates `state[pane]` in place and returns whether it
// actually changed anything (so callers know whether to sync the widget /
// re-render / schedule a structural refit).
// ---------------------------------------------------------------------------

function paneList(state, pane) {
  if (!Array.isArray(state[pane])) {
    state[pane] = [];
  }
  return state[pane];
}

function findBlockIndex(state, pane, id) {
  return paneList(state, pane).findIndex((b) => b.id === id);
}

/** Whether `pane` already has a "trigger" block — the one-trigger-per-pane
 * UI guard (per the plan: a UI-level nicety only, never enforced here as a
 * hard rule — `addBlock` itself will happily add a second trigger block if
 * asked; callers wanting the guard check this first). */
export function hasTriggerBlock(state, pane) {
  return paneList(state, pane).some((b) => b.type === "trigger");
}

/** Append a new block of `type` to `pane`. Always succeeds (no
 * one-trigger-per-pane enforcement here — see `hasTriggerBlock`). Returns
 * the created block. */
export function addBlock(state, pane, type) {
  const block = makeBlock(type);
  paneList(state, pane).push(block);
  return block;
}

/** Remove the block with `id` from `pane`. Returns `true` if a block was
 * actually removed. */
export function removeBlock(state, pane, id) {
  const list = paneList(state, pane);
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) {
    return false;
  }
  list.splice(idx, 1);
  return true;
}

/** Swap the block with `id` one position toward `direction` ("up" or
 * "down"). Returns `true` if a swap happened (`false` at either boundary or
 * if `id` isn't found). */
export function moveBlock(state, pane, id, direction) {
  const list = paneList(state, pane);
  const idx = list.findIndex((b) => b.id === id);
  if (idx === -1) {
    return false;
  }
  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= list.length) {
    return false;
  }
  const tmp = list[idx];
  list[idx] = list[targetIdx];
  list[targetIdx] = tmp;
  return true;
}

/** Flip `enabled` on the block with `id`. Returns `true` if found. */
export function toggleEnabled(state, pane, id) {
  const idx = findBlockIndex(state, pane, id);
  if (idx === -1) {
    return false;
  }
  const list = paneList(state, pane);
  list[idx] = { ...list[idx], enabled: !list[idx].enabled };
  return true;
}

/** Flip `pin` on the block with `id`. Returns `true` if found. */
export function togglePin(state, pane, id) {
  const idx = findBlockIndex(state, pane, id);
  if (idx === -1) {
    return false;
  }
  const list = paneList(state, pane);
  list[idx] = { ...list[idx], pin: !list[idx].pin };
  return true;
}

/** Set the `text` of the block with `id` — non-structural (typing). Returns
 * `true` if found. */
export function setBlockText(state, pane, id, text) {
  const idx = findBlockIndex(state, pane, id);
  if (idx === -1) {
    return false;
  }
  paneList(state, pane)[idx].text = text;
  return true;
}

/** Set the `label` of the block with `id` — non-structural. Returns `true`
 * if found. */
export function setBlockLabel(state, pane, id, label) {
  const idx = findBlockIndex(state, pane, id);
  if (idx === -1) {
    return false;
  }
  paneList(state, pane)[idx].label = label;
  return true;
}

/** Find a block by id in `pane`, or `null`. */
export function findBlock(state, pane, id) {
  return paneList(state, pane).find((b) => b.id === id) || null;
}

// ---------------------------------------------------------------------------
// Assembly (mirrors `_anima_prompt_studio_helpers.py` EXACTLY)
// ---------------------------------------------------------------------------

/** Direct port of `assemble_pane_segments`. Returns
 * `{segments, restRaw}` where `segments` is an array of `["pin", text]` /
 * `["rest", null]` tuples. */
export function assemblePaneSegments(blocks, separator) {
  const segments = [];
  const restParts = [];
  let restStarted = false;

  for (const block of blocks || []) {
    if (!block.enabled) {
      continue;
    }
    const text = String(block.text || "").trim();
    if (!text) {
      continue;
    }
    if (block.pin) {
      segments.push(["pin", text]);
      continue;
    }
    if (!restStarted) {
      segments.push(["rest", null]);
      restStarted = true;
    }
    restParts.push(text);
  }

  return { segments, restRaw: restParts.join(separator) };
}

/** Direct port of `substitute_rest`. */
export function substituteRest(segments, restCorrected, separator) {
  const parts = [];
  for (const [kind, value] of segments) {
    const text = kind === "rest" ? String(restCorrected || "").trim() : value || "";
    if (text) {
      parts.push(text);
    }
  }
  return parts.join(separator);
}

/** The client-side, ALWAYS-UNCORRECTED preview assembly for one pane: runs
 * the same segment algorithm as the backend, then substitutes the rest
 * placeholder with its own raw text (identity — no engine call). This is
 * byte-for-byte identical to the backend's own output whenever
 * `rules_correction_enabled` is OFF; when it's ON, it's an honest
 * pre-correction preview only — see this module's docstring. */
export function assemblePanePreview(blocks, separator) {
  const { segments, restRaw } = assemblePaneSegments(blocks, separator);
  return substituteRest(segments, restRaw, separator);
}

export function assembleBothPanesPreview(state, separator) {
  return {
    positive: assemblePanePreview((state && state.positive) || [], separator),
    negative: assemblePanePreview((state && state.negative) || [], separator),
  };
}
