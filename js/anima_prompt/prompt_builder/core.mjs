/**
 * core.mjs — pure state/logic for the Prompt Builder node. No DOM access.
 *
 * Mirrors `nodes/_prompt_builder_helpers.py` exactly: token parsing,
 * humanizing, prompt rendering, and the labeled-prose field assembly
 * (`buildFieldText` mirrors `build_field_text`) must stay in lockstep with
 * the backend so the live preview matches what the node actually produces.
 * The node's primary output is the labeled-prose text (see `render.mjs`'s
 * `updatePreview`) — one `"<Label>: <value>"` line per non-empty field, NOT
 * JSON (a JSON `{token: value}` document was tried first, but proved noisy
 * for a Qwen-style text encoder, which reads braces/quotes as literal
 * tokens rather than structure). `renderPrompt` (the flat, comma-joined
 * rendering) is kept here for any caller that still wants it (e.g. tests),
 * but is no longer what the LIVE PREVIEW shows.
 */

export const DEFAULT_TEMPLATE =
  "{character}, {hair_style}, {hair_color}, {eyes}, {body_type}, " +
  "{skin}, {marks}, {breasts}, {genital_state}, {body_details}";

// Name of the `required` STRING widget (declared in
// `nodes/node_prompt_builder.py`'s `INPUT_TYPES`) that carries the per-token
// field values to the backend. It is a real, natively-serialized widget
// (`index.js` hides it, exactly like `template`) — NOT a `hidden` input
// injected via an `app.graphToPrompt` wrap, which does not reliably reach
// the backend in this ComfyUI.
export const STATE_WIDGET_NAME = "prompt_builder_state";

const TOKEN_RE = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Extract unique `{token}` names from `template`, in first-appearance order.
 */
export function parseTokens(template) {
  const seen = new Set();
  const tokens = [];
  const re = new RegExp(TOKEN_RE);
  let match;
  while ((match = re.exec(template || "")) !== null) {
    const token = match[1];
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * `hair_style` -> "Hair Style". Splits on `_`, capitalizes each word, joins
 * with a space.
 */
export function humanize(token) {
  return (token || "")
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Fill `{token}` placeholders in `template` from `fields`, then clean up.
 *
 * Missing tokens render as empty string. After substitution the result is
 * split on `,`, each piece is trimmed, empty pieces are dropped, and the
 * remaining pieces are rejoined with `", "` (so blank fields don't leave
 * dangling `, ,` or a leading/trailing comma).
 */
export function renderPrompt(template, fields) {
  fields = fields || {};
  const filled = (template || "").replace(TOKEN_RE, (_match, token) => {
    const value = fields[token];
    // Trim each field value at substitution time, mirroring the backend's
    // per-field `.strip()` in `node_prompt_builder.py`'s `build()` (values
    // are stripped before rendering, not just cleaned up after).
    return value === undefined || value === null ? "" : String(value).trim();
  });
  return filled
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .join(", ");
}

/**
 * Render `tokens`/`fields` as labeled PROSE lines, in `tokens`' order —
 * mirrors `build_field_text` byte-for-byte. Each token's value is trimmed
 * (matching the backend's per-field `.strip()` before it ever reaches
 * `build_field_text`); empty/whitespace-only values are dropped entirely (no
 * dangling label, no blank line). Each non-empty value becomes one
 * `"<Humanize(token)>: <value>"` line (see `humanize`); lines are joined
 * with a single `"\n"`.
 */
export function buildFieldText(tokens, fields) {
  const lines = [];
  (tokens || []).forEach((token) => {
    const raw = fields ? fields[token] : undefined;
    const value = raw === undefined || raw === null ? "" : String(raw).trim();
    if (value) {
      lines.push(`${humanize(token)}: ${value}`);
    }
  });
  return lines.join("\n");
}

/**
 * Return `node.properties.promptBuilderState`, creating it (and
 * `node.properties`) with the default shape if missing.
 */
export function ensureState(node) {
  if (!node.properties) {
    node.properties = {};
  }
  const state = node.properties.promptBuilderState;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    node.properties.promptBuilderState = { version: 1, fields: {} };
  } else {
    if (typeof state.version !== "number") {
      state.version = 1;
    }
    if (!state.fields || typeof state.fields !== "object" || Array.isArray(state.fields)) {
      state.fields = {};
    }
  }
  return node.properties.promptBuilderState;
}

/**
 * Read-only accessor for the state (same as `ensureState`; kept as a
 * separate named export per the contract for callers that only want to
 * read, not necessarily imply "I'm about to mutate this").
 */
export function getState(node) {
  return ensureState(node);
}

/**
 * Find the `prompt_builder_state` widget on `node` (declared `required` in
 * `nodes/node_prompt_builder.py`'s `INPUT_TYPES`, hidden by `index.js` the
 * same way as `template`). Returns `undefined` if the node has no widgets
 * yet (shouldn't happen in practice — LiteGraph creates widgets from
 * `INPUT_TYPES` before any JS hook runs).
 */
export function findStateWidget(node) {
  return (node.widgets || []).find((w) => w.name === STATE_WIDGET_NAME);
}

/**
 * Write the current `node.properties.promptBuilderState` into the
 * `prompt_builder_state` widget's value, so it serializes with the rest of
 * the node's `widgets_values` — this is now the ONLY path the per-token
 * field values reach the backend by (no more `app.graphToPrompt` wrap). Must
 * be called after EVERY mutation of `promptBuilderState`: a field value
 * edit, an add/remove wildcard (template edit that changes the token set),
 * and any other template edit that reseeds/drops fields. No-op if the
 * widget isn't found (defensive; shouldn't happen).
 */
export function syncStateWidget(node) {
  const stateWidget = findStateWidget(node);
  if (!stateWidget) {
    return;
  }
  stateWidget.value = JSON.stringify(ensureState(node));
}

/**
 * Restore `node.properties.promptBuilderState` from the `prompt_builder_state`
 * widget's (already-restored-by-LiteGraph) value, then normalize its shape
 * via `ensureState`. This is the persistence source of truth now — the
 * widget's value round-trips through `widgets_values` in the saved workflow
 * exactly like `template`'s, so this is what makes a reload restore the
 * per-token field values correctly (see `index.js`'s `mountUI`/`restoreNode`,
 * which call this on mount and after `onConfigure`, respectively). Guarded
 * against a missing widget, a non-string value, and malformed/empty JSON
 * (e.g. a freshly-created node whose widget still holds the `"{}"` default,
 * or an older/corrupted save) — falls through to `ensureState`'s default
 * shape in every one of those cases rather than throwing.
 */
export function restoreStateFromWidget(node) {
  const stateWidget = findStateWidget(node);
  if (stateWidget && typeof stateWidget.value === "string" && stateWidget.value) {
    try {
      const parsed = JSON.parse(stateWidget.value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        node.properties = node.properties || {};
        node.properties.promptBuilderState = parsed;
      }
    } catch (err) {
      // Malformed JSON — ignore, ensureState below fills in the default
      // shape instead of throwing.
    }
  }
  return ensureState(node);
}

/**
 * Sanitize a raw "Add Wildcard" name into a valid `{token}` identifier:
 * trim, lowercase, collapse anything outside `[a-z0-9_]` into `_`, and drop
 * leading/trailing underscores. Returns `""` for input that sanitizes away
 * to nothing (e.g. blank, or all-punctuation).
 */
export function sanitizeToken(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Append `{token}` to `template` as a new `, {token}` clause, unless
 * `token` already appears in the template (in which case `template` is
 * returned unchanged — no duplicate). Mirrors the playground's
 * `confirmAdd()` behavior.
 */
export function appendTokenToTemplate(template, token) {
  if (!token) {
    return template;
  }
  const existing = new Set(parseTokens(template));
  if (existing.has(token)) {
    return template;
  }
  const trimmed = String(template || "").trim().replace(/,\s*$/, "");
  return trimmed.length ? trimmed + ", {" + token + "}" : "{" + token + "}";
}
