/**
 * core.mjs — pure state for the Anima Preview node's frontend.
 *
 * No DOM here (that's render.mjs) and no litegraph/widget wiring (that's
 * index.js/interaction.mjs) — just the channel-name normalization (kept in
 * lockstep with the backend's `nodes/_anima_preview_channel.normalize_channel`
 * so a blank/whitespace channel widget matches the same `"default"` a blank
 * AnimaGenerator `preview_channel` field would broadcast on), the small
 * recent-frames history buffer, and the module-level registry of every
 * mounted AnimaPreview node instance that `index.js`'s single websocket
 * listener fans a frame out to by channel-name match.
 */

export const MAX_HISTORY = 6;
export const DEFAULT_CHANNEL = "default";

/** Mirrors the backend's `normalize_channel`: blank/whitespace-only ->
 * `DEFAULT_CHANNEL`, otherwise trimmed. */
export function normalizeChannel(value) {
  const text = String(value ?? "").trim();
  return text || DEFAULT_CHANNEL;
}

/** Append `frame` (`{stageLabel, imageData}`) to `history`, keeping at most
 * `MAX_HISTORY` entries (oldest dropped first). Pure — returns a NEW array,
 * never mutates `history`. */
export function pushFrame(history, frame) {
  const next = Array.isArray(history) ? history.slice() : [];
  next.push(frame);
  if (next.length > MAX_HISTORY) {
    next.splice(0, next.length - MAX_HISTORY);
  }
  return next;
}

// ---- Registry of mounted node instances --------------------------------
// index.js registers exactly ONE `api.addEventListener` for the whole
// extension (not one per node) and fans incoming frames out to whichever
// registered entries' current channel value matches — this Set is how it
// finds them. Each entry is `{ node, refs, getChannel }` (`getChannel` reads
// the LIVE channel widget value, not a snapshot, so editing the widget after
// mount immediately retunes which broadcasts a node receives).

const REGISTRY = new Set();

export function registerPreviewEntry(entry) {
  REGISTRY.add(entry);
}

export function unregisterPreviewEntry(entry) {
  REGISTRY.delete(entry);
}

export function getRegisteredPreviewEntries() {
  return Array.from(REGISTRY);
}

/** Entries whose live channel value (via `entry.getChannel()`) matches
 * `channel` (both sides normalized the same way). */
export function matchingPreviewEntries(channel) {
  const wanted = normalizeChannel(channel);
  return getRegisteredPreviewEntries().filter((entry) => {
    try {
      return normalizeChannel(entry.getChannel()) === wanted;
    } catch {
      return false;
    }
  });
}
