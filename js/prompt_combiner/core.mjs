/**
 * core.mjs — pure state/logic for the Prompt Combiner node. No DOM access.
 *
 * Prompt Combiner's variables are real graph INPUT SLOTS, but the TEMPLATE
 * is the single source of truth for which ones exist: `node.inputs` is kept
 * in sync with the `{token}`s currently parsed out of the template text (see
 * `interaction.mjs`'s `reconcileInputsFromTemplate`) — typing a new `{foo}`
 * adds a real input slot, and deleting a token's `{foo}` (by editing the
 * text directly, or via a row's ✕, which strips its token first) removes it
 * again, dropping its wire. `properties.combinerState.inputs` (`core.mjs`'s
 * `syncStateFromInputs`) is a resilient backup mirror of `node.inputs`, not
 * an independent source of truth.
 *
 * `parseTokens` / `humanize` / `sanitizeToken` / `appendTokenToTemplate` are
 * intentionally copied (not imported) from `js/prompt_builder/core.mjs` —
 * the two node folders must not import across each other.
 */

export const DEFAULT_TEMPLATE = "{character}, {background}";
export const DEFAULT_INPUTS = ["character", "background"];

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
 * Sanitize a raw "Add Input" name into a valid `{token}`/slot identifier:
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
 * returned unchanged — no duplicate).
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

/**
 * Remove `{token}` from `template` (used when an input slot is removed).
 * Strips the `{token}` placeholder itself, then cleans up the comma-joined
 * clause list the same way `renderPrompt`-style cleanup would (split on
 * `,`, trim each piece, drop empties, rejoin with `", "`) so removing a
 * clause never leaves a dangling `, ,` or stray leading/trailing comma.
 * Returns `template` unchanged if `token` doesn't appear in it.
 */
export function removeTokenFromTemplate(template, token) {
  if (!token) {
    return template;
  }
  const re = new RegExp("\\{" + token + "\\}", "g");
  const source = template || "";
  if (!re.test(source)) {
    return template;
  }
  const stripped = source.replace(re, "");
  return stripped
    .split(",")
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .join(", ");
}

/**
 * Return `node.properties.combinerState`, creating it (and
 * `node.properties`) with the default shape if missing.
 */
export function ensureState(node) {
  if (!node.properties) {
    node.properties = {};
  }
  const state = node.properties.combinerState;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    node.properties.combinerState = { version: 1, inputs: [] };
  } else {
    if (typeof state.version !== "number") {
      state.version = 1;
    }
    if (!Array.isArray(state.inputs)) {
      state.inputs = [];
    }
  }
  return node.properties.combinerState;
}

/**
 * Read-only accessor for the state (same as `ensureState`).
 */
export function getState(node) {
  return ensureState(node);
}

/**
 * Normalize `node.properties.combinerState` after `onConfigure` has
 * restored `node.properties` from a saved workflow. Safe to call even if
 * `properties` is missing or malformed.
 */
export function restoreFromProperties(node) {
  return ensureState(node);
}

/**
 * Read the current dynamic input slot names, in slot order, from
 * `node.inputs` (the source of truth — a real litegraph array of
 * `{name, type, link, ...}`). Returns `[]` if the node has no inputs yet.
 */
export function getInputNames(node) {
  const inputs = (node && node.inputs) || [];
  return inputs.map((input) => input && input.name).filter((name) => !!name);
}

/**
 * Mirror `node.inputs` (the source of truth) into
 * `node.properties.combinerState.inputs` — a resilient, easy-to-inspect
 * backup of the variable list. Called after any structural input change and
 * after restore. Returns the names array it wrote.
 */
export function syncStateFromInputs(node) {
  const state = ensureState(node);
  const names = getInputNames(node);
  state.inputs = names;
  return names;
}

/**
 * Whether `node.inputs` already has a slot named `name`.
 */
export function hasInputNamed(node, name) {
  return getInputNames(node).includes(name);
}

/**
 * Whether a DEFERRED default-template seed (see `index.js`'s
 * `scheduleDefaultTemplateSeed`) should actually seed the
 * `DEFAULT_TEMPLATE`/`DEFAULT_INPUTS`: only when `node.inputs` is STILL
 * empty at the deferred tick.
 *
 * `onNodeCreated` fires BEFORE litegraph restores a saved workflow's input
 * slots onto `node.inputs` (that happens as part of `onConfigure`, which
 * runs synchronously — before any `requestAnimationFrame`/`setTimeout`
 * macrotask). So seeding the default template directly from `onNodeCreated`
 * risks a genuinely-loaded node ending up with its saved inputs PLUS a
 * duplicate `character`/`background` pair. Deferring the seed and
 * re-checking here fixes that: a genuinely fresh node (nothing to restore)
 * is still empty at the deferred tick and gets the defaults; a loaded node
 * already has its restored inputs by then and is left alone.
 */
export function shouldSeedDefaultInputs(node) {
  return !(node && node.inputs && node.inputs.length > 0);
}

/**
 * Find the index of the input slot named `name` in `node.inputs`, or -1.
 */
export function findInputIndex(node, name) {
  return getInputNames(node).indexOf(name);
}
