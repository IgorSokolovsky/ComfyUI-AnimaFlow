/**
 * core.mjs — pure state/logic for the Scene Creator node. No DOM access.
 *
 * Mirrors `nodes/_scene_creator_helpers.py`'s contract: a scene TEMPLATE with
 * `{wildcards}` drives one DOM text field per token EXCEPT the two reserved
 * tokens `{characters}` and `{backgrounds}`, which the backend fills in from
 * the enabled characters/backgrounds instead. `parseTokens` / `humanize` /
 * `sanitizeToken` / `appendTokenToTemplate` are intentionally copied (not
 * imported) from `js/prompt_builder/core.mjs` / `js/prompt_combiner/
 * core.mjs` — sibling node folders must not import across each other.
 * `assembleCharacters` / `assembleBackgroundBlock` / `buildSceneText` mirror
 * `_scene_creator_helpers.py`'s `assemble_characters` / `assemble_
 * background_block` / `build_scene_text` byte-for-byte (see their doc
 * comments below) — `js/scene_creator/render.mjs` uses them to compute a
 * CLIENT-SIDE live preview of the scene's labeled-PROSE document between
 * runs; the backend's `onExecuted` result is still the authoritative preview
 * right after a run. A JSON `{token: value}` document was tried first, but
 * proved noisy for a Qwen-style text encoder (Anima) — braces/quotes read as
 * literal tokens rather than structure — so labeled prose (one paragraph per
 * character, `"Label: value"` scene lines) replaced it (see `buildSceneText`'s
 * doc comment below for the exact format).
 *
 * Authoritative frontend state lives in `node.properties.sceneState`:
 *   {
 *     version: 1,
 *     fields: { "<token>": "<value>" },
 *     backgrounds: [ { socket: "bg_1", name, enabled, text } ],
 *     characters: [
 *       {
 *         socket: "char_1", name, enabled,
 *         appearance, action, focus,
 *         outfits: [ { socket: "outfit_2", text, enabled }, ... ],
 *       },
 *     ],
 *     nextId: 3,
 *   }
 * `appearance` and `focus` are plain free-text fields; `action` is the
 * character's pose/expression/action text (older saved states used
 * `expression` for this — `normalizeCharacter` migrates it to `action` and
 * drops `expression` entirely, mirroring `_scene_creator_helpers.py`'s
 * `_normalize_character`). `socket` is the stable litegraph input-slot name
 * added via `node.addInput(socket, "*")`. A character/background's IDENTITY
 * (or an outfit's override) arrives over that wire at execution time; every
 * other field (`name`/`enabled`/`appearance`/`action`/`focus`/`text`) is
 * plain FE state carried to the backend via the `scene_state` STRING
 * widget's serialized JSON (a normal, natively-serialized Python-declared
 * widget the frontend hides — the SAME mechanism `template` already uses —
 * kept in sync from `node.properties.sceneState` by `syncStateWidget`,
 * called after every mutation; see `index.js`'s `hideStateWidget`/
 * `loadStateFromWidget`). Socket ids are unique + stable via the single
 * monotonic `nextId` counter shared across ALL socket kinds (`char_`, `bg_`,
 * `outfit_`) — see `addCharacterToState`/`addOutfitToState`/
 * `addBackgroundToState`.
 */

export const RESERVED_CHARACTERS_TOKEN = "characters";
export const RESERVED_BACKGROUNDS_TOKEN = "backgrounds";
export const RESERVED_TOKENS = new Set([
  RESERVED_CHARACTERS_TOKEN,
  RESERVED_BACKGROUNDS_TOKEN,
]);

// The one token rendered UNLABELED, as a bare lead line ahead of everything
// else (see `buildSceneText`) — mirrors `_scene_creator_helpers.py`'s
// `LEAD_TOKEN`. e.g. booru quality/rating tags, which read better as a plain
// leading clause than under a "Tags:" label.
export const LEAD_TOKEN = "tags";

// Tokens rendered as bare UNLABELED lines in the trailing "tail" bucket (see
// `buildSceneText`) — mirrors `_scene_creator_helpers.py`'s `TAIL_TOKENS`:
// free-form scene description / shot (camera+lighting merged by the user
// into one field) prose, in that order.
export const TAIL_TOKENS = new Set(["scene_description", "shot"]);

// Must match `nodes/_scene_creator_helpers.py`'s `DEFAULT_TEMPLATE` exactly —
// it's also the Python-side widget default, so this constant is only used
// here for reference/tests, never to seed the DOM (the widget already
// arrives with this value baked in via `INPUT_TYPES`).
export const DEFAULT_TEMPLATE =
  "{tags}, {characters}, {backgrounds}, {scene_description}, {shot}";

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
 * Sanitize a raw "Add Scene Field" / "Add Character" / "Add Background" name
 * into a valid identifier: trim, lowercase, collapse anything outside
 * `[a-z0-9_]` into `_`, and drop leading/trailing underscores. Returns `""`
 * for input that sanitizes away to nothing.
 */
export function sanitizeToken(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Append `{token}` to `template` as a new `, {token}` clause, unless `token`
 * already appears in the template (no duplicate) or `token` is one of the
 * two reserved tokens (`characters`/`backgrounds` — never scene fields;
 * mirrors the playground's `confirmField`).
 */
export function appendTokenToTemplate(template, token) {
  if (!token || RESERVED_TOKENS.has(token)) {
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
 * The SCENE FIELD tokens for `template`: every `{token}` EXCEPT the two
 * reserved tokens (`characters`/`backgrounds`), which are never rendered as
 * scene field rows (they're filled backend-side from the enabled
 * characters/backgrounds instead).
 */
export function sceneFieldTokens(template) {
  return parseTokens(template).filter((token) => !RESERVED_TOKENS.has(token));
}

/**
 * Normalize a raw (possibly malformed / loaded-from-disk) outfit entry into
 * the canonical shape. Drops an entry with no usable `socket`.
 */
function normalizeOutfit(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const socket = String(raw.socket || "").trim();
  if (!socket) {
    return null;
  }
  return {
    socket,
    text: typeof raw.text === "string" ? raw.text : "",
    enabled: raw.enabled !== false,
  };
}

/**
 * Normalize a raw character entry into the canonical shape (including its
 * nested `outfits` list). Drops an entry with no usable `socket`.
 *
 * Canonical fields: `socket`, `name`, `enabled`, `appearance` (plain text),
 * `action` (the character's pose/expression/action text), `focus` (plain
 * text), `outfits`.
 *
 * Two migrations happen here, mirroring `_scene_creator_helpers.py`'s
 * `_normalize_character` exactly:
 * - Legacy scalar outfit: an OLDER frontend saved a single scalar `outfit`
 *   text field (no `outfits` list, no per-outfit socket) — if that's all we
 *   find, stash the text on `_legacyOutfitText` so `ensureState` can turn it
 *   into a real (freshly socketed) outfit entry instead of silently
 *   dropping it.
 * - `expression` -> `action`: older states used `"expression"` instead of
 *   `"action"`. Mirrors `_normalize_character`'s exact rule: migration is
 *   keyed on whether the `action` KEY IS PRESENT on `raw` at all — if it is
 *   (any value, even `""`), it wins as-is and `expression` is simply
 *   discarded; only when `action` is ABSENT does a string `expression` get
 *   copied over to `action`. Either way, `expression` itself is never
 *   carried into the canonical result — `action` is the only canonical key
 *   from here on.
 */
function normalizeCharacter(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const socket = String(raw.socket || "").trim();
  if (!socket) {
    return null;
  }
  const outfits = Array.isArray(raw.outfits)
    ? raw.outfits.map(normalizeOutfit).filter((o) => o !== null)
    : [];

  let action;
  if ("action" in raw) {
    // `action` key present on the raw entry -> it wins as-is (defensively
    // coerced to a string), regardless of any `expression` alongside it.
    action = typeof raw.action === "string" ? raw.action : "";
  } else if (typeof raw.expression === "string") {
    action = raw.expression;
  } else {
    action = "";
  }

  const character = {
    socket,
    name: typeof raw.name === "string" ? raw.name : String(raw.name || "Character"),
    enabled: raw.enabled !== false,
    appearance: typeof raw.appearance === "string" ? raw.appearance : "",
    action,
    focus: typeof raw.focus === "string" ? raw.focus : "",
    outfits,
  };
  if (!outfits.length && typeof raw.outfit === "string" && raw.outfit.trim()) {
    character._legacyOutfitText = raw.outfit;
  }
  return character;
}

/**
 * Normalize a raw background entry into the canonical shape. Drops an entry
 * with no usable `socket`.
 */
function normalizeBackground(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const socket = String(raw.socket || "").trim();
  if (!socket) {
    return null;
  }
  return {
    socket,
    name: typeof raw.name === "string" ? raw.name : String(raw.name || "Background"),
    enabled: raw.enabled !== false,
    text: typeof raw.text === "string" ? raw.text : "",
  };
}

/**
 * Extract the trailing `_<n>` numeric suffix from a socket name
 * (`char_3` -> 3, `outfit_12` -> 12), or `null` if it doesn't match.
 */
function extractSocketNumber(socket) {
  const match = /^[a-z]+_([0-9]+)$/.exec(String(socket || ""));
  return match ? parseInt(match[1], 10) : null;
}

/**
 * The highest socket-id number currently in use across every background,
 * character, and outfit socket in `state` — used to floor `state.nextId` so
 * it can never collide with (or be safely lower than) an id already on the
 * node, however the state got there (defensive against a hand-edited or
 * older-shape saved workflow).
 */
function maxSocketNumber(state) {
  let max = 0;
  (state.backgrounds || []).forEach((bg) => {
    const n = extractSocketNumber(bg.socket);
    if (n !== null && n > max) {
      max = n;
    }
  });
  (state.characters || []).forEach((character) => {
    const n = extractSocketNumber(character.socket);
    if (n !== null && n > max) {
      max = n;
    }
    (character.outfits || []).forEach((outfit) => {
      const on = extractSocketNumber(outfit.socket);
      if (on !== null && on > max) {
        max = on;
      }
    });
  });
  return max;
}

/**
 * Return `node.properties.sceneState`, creating it (and `node.properties`)
 * with the default shape if missing, and defensively normalizing a
 * malformed/older-shape state (e.g. loaded from a saved workflow):
 * normalizes `backgrounds`/`characters` (incl. nested `outfits`), floors
 * `nextId` above every socket-id number actually in use, and migrates any
 * legacy scalar-outfit character into a freshly-socketed outfit entry.
 */
export function ensureState(node) {
  if (!node.properties) {
    node.properties = {};
  }
  const state = node.properties.sceneState;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    node.properties.sceneState = {
      version: 1,
      fields: {},
      backgrounds: [],
      characters: [],
      nextId: 1,
    };
    return node.properties.sceneState;
  }

  if (typeof state.version !== "number") {
    state.version = 1;
  }
  if (!state.fields || typeof state.fields !== "object" || Array.isArray(state.fields)) {
    state.fields = {};
  }
  if (!Array.isArray(state.backgrounds)) {
    state.backgrounds = [];
  } else {
    state.backgrounds = state.backgrounds.map(normalizeBackground).filter((b) => b !== null);
  }
  if (!Array.isArray(state.characters)) {
    state.characters = [];
  } else {
    state.characters = state.characters.map(normalizeCharacter).filter((c) => c !== null);
  }

  const floor = maxSocketNumber(state) + 1;
  if (typeof state.nextId !== "number" || !Number.isFinite(state.nextId) || state.nextId < floor) {
    state.nextId = floor;
  }

  state.characters.forEach((character) => {
    if (!character.outfits.length && character._legacyOutfitText) {
      const socket = "outfit_" + state.nextId;
      state.nextId += 1;
      character.outfits.push({ socket, text: character._legacyOutfitText, enabled: true });
    }
    delete character._legacyOutfitText;
  });

  return state;
}

/**
 * Read-only accessor for the state (same as `ensureState`).
 */
export function getState(node) {
  return ensureState(node);
}

/**
 * The name of the Python-declared `scene_state` STRING widget (a normal,
 * natively-serialized required widget — see `nodes/node_scene_creator.py`'s
 * `INPUT_TYPES`). The frontend hides it (like `template`) but never sets
 * `serialize = false` on it, so its `.value` round-trips to the backend on
 * every run AND persists/restores across save+reload exactly like any other
 * widget's `widgets_values`.
 */
export const STATE_WIDGET_NAME = "scene_state";

/**
 * Find the `scene_state` widget on `node`, or `undefined` if it hasn't been
 * created yet (before `onNodeCreated`, i.e. this should never actually
 * happen for a real litegraph node, since Python-declared required widgets
 * exist before any JS hook runs).
 */
export function findStateWidget(node) {
  return ((node && node.widgets) || []).find((w) => w.name === STATE_WIDGET_NAME);
}

/**
 * Mirror `node.properties.sceneState` into the hidden-but-serializing
 * `scene_state` widget's `.value` so it keeps reaching the backend on every
 * run. Call this after EVERY mutation of `node.properties.sceneState` (a
 * scene-field edit, a character/outfit/background add/remove/toggle/edit, or
 * a template edit that changes the field set) — a no-op if the widget
 * doesn't exist yet.
 */
export function syncStateWidget(node) {
  const widget = findStateWidget(node);
  if (!widget) {
    return;
  }
  const state = (node.properties && node.properties.sceneState) || {};
  widget.value = JSON.stringify(state);
}

/**
 * Restore `node.properties.sceneState` from the (litegraph-restored)
 * `scene_state` widget's `.value` — the actual persisted source of truth,
 * since the widget is what serializes to/from the saved workflow JSON (the
 * same mechanism the `template` widget already uses). Guarded against
 * missing/malformed JSON (falls through to whatever's already in
 * `node.properties`, then to `ensureState`'s defaults). Used both for a
 * freshly-created node (widget value defaults to `"{}"`) and for a node
 * being restored via `onConfigure` (widget value already holds the saved
 * JSON by the time this runs, since litegraph restores `widgets_values`
 * before calling `onConfigure`).
 */
export function loadStateFromWidget(node) {
  const widget = findStateWidget(node);
  if (widget && typeof widget.value === "string" && widget.value.trim()) {
    try {
      const parsed = JSON.parse(widget.value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (!node.properties) {
          node.properties = {};
        }
        node.properties.sceneState = parsed;
      }
    } catch (err) {
      // Malformed JSON on the widget — fall through to whatever's already in
      // node.properties (or ensureState's defaults) below.
    }
  }
  return ensureState(node);
}

/**
 * Index of the character entry with the given `socket`, or -1.
 */
export function findCharacterIndex(state, socket) {
  return (state.characters || []).findIndex((c) => c.socket === socket);
}

/**
 * Index of the background entry with the given `socket`, or -1.
 */
export function findBackgroundIndex(state, socket) {
  return (state.backgrounds || []).findIndex((b) => b.socket === socket);
}

/**
 * Index of the outfit entry with the given `socket` within `character`'s
 * `outfits` list, or -1.
 */
export function findOutfitIndex(character, outfitSocket) {
  return ((character && character.outfits) || []).findIndex((o) => o.socket === outfitSocket);
}

/**
 * Allocate + return a fresh outfit entry (`{socket: "outfit_<n>", text: "",
 * enabled: true}`), consuming the next id off the SHARED `state.nextId`
 * counter (shared across char/bg/outfit sockets — see the module header).
 */
function createOutfitEntry(state) {
  const socket = "outfit_" + state.nextId;
  state.nextId += 1;
  return { socket, text: "", enabled: true };
}

/**
 * Create + append a new character entry to `state.characters`, assigning it
 * the next stable socket id (`char_<n>`) PLUS one default outfit entry (its
 * own freshly-socketed `outfit_<n2>`), consuming two ids off `state.nextId`.
 * Returns the new character object (including its one outfit).
 */
export function addCharacterToState(state, name) {
  const socket = "char_" + state.nextId;
  state.nextId += 1;
  const outfit = createOutfitEntry(state);
  const character = {
    socket,
    name: String(name || "").trim() || "Character",
    enabled: true,
    appearance: "",
    action: "",
    focus: "",
    outfits: [outfit],
  };
  state.characters.push(character);
  return character;
}

/**
 * Remove the character entry matching `socket` from `state.characters`.
 * Returns the removed entry (including its full `outfits` list, so the
 * caller can drop each outfit's litegraph socket too), or `null` if no match
 * was found.
 */
export function removeCharacterFromState(state, socket) {
  const idx = findCharacterIndex(state, socket);
  if (idx === -1) {
    return null;
  }
  const [removed] = state.characters.splice(idx, 1);
  return removed;
}

/**
 * Append a new outfit entry (its own freshly-socketed `outfit_<n>`) to the
 * character matching `characterSocket`. Returns the new outfit entry, or
 * `null` if no matching character was found.
 */
export function addOutfitToState(state, characterSocket) {
  const idx = findCharacterIndex(state, characterSocket);
  if (idx === -1) {
    return null;
  }
  const outfit = createOutfitEntry(state);
  state.characters[idx].outfits.push(outfit);
  return outfit;
}

/**
 * Remove the outfit entry matching `outfitSocket` from the character
 * matching `characterSocket`. Returns the removed outfit entry, or `null` if
 * no match was found (either the character or the outfit itself).
 */
export function removeOutfitFromState(state, characterSocket, outfitSocket) {
  const idx = findCharacterIndex(state, characterSocket);
  if (idx === -1) {
    return null;
  }
  const outfits = state.characters[idx].outfits;
  const outfitIdx = findOutfitIndex(state.characters[idx], outfitSocket);
  if (outfitIdx === -1) {
    return null;
  }
  const [removed] = outfits.splice(outfitIdx, 1);
  return removed;
}

/**
 * Create + append a new background entry to `state.backgrounds`, assigning
 * it the next stable socket id (`bg_<n>`). Returns the new background
 * object.
 */
export function addBackgroundToState(state, name) {
  const socket = "bg_" + state.nextId;
  state.nextId += 1;
  const background = {
    socket,
    name: String(name || "").trim() || "Background",
    enabled: true,
    text: "",
  };
  state.backgrounds.push(background);
  return background;
}

/**
 * Remove the background entry matching `socket` from `state.backgrounds`.
 * Returns the removed entry, or `null` if no match was found.
 */
export function removeBackgroundFromState(state, socket) {
  const idx = findBackgroundIndex(state, socket);
  if (idx === -1) {
    return null;
  }
  const [removed] = state.backgrounds.splice(idx, 1);
  return removed;
}

/**
 * Flip the `enabled` flag on the character matching `socket`. Returns the
 * new `enabled` value, or `undefined` if no match was found.
 */
export function toggleCharacterEnabled(state, socket) {
  const idx = findCharacterIndex(state, socket);
  if (idx === -1) {
    return undefined;
  }
  state.characters[idx].enabled = !state.characters[idx].enabled;
  return state.characters[idx].enabled;
}

/**
 * Flip the `enabled` flag on the background matching `socket`. Returns the
 * new `enabled` value, or `undefined` if no match was found.
 */
export function toggleBackgroundEnabled(state, socket) {
  const idx = findBackgroundIndex(state, socket);
  if (idx === -1) {
    return undefined;
  }
  state.backgrounds[idx].enabled = !state.backgrounds[idx].enabled;
  return state.backgrounds[idx].enabled;
}

/**
 * Flip the `enabled` flag on the outfit matching `outfitSocket` within the
 * character matching `characterSocket`. Returns the new `enabled` value, or
 * `undefined` if no match was found.
 */
export function toggleOutfitEnabled(state, characterSocket, outfitSocket) {
  const cIdx = findCharacterIndex(state, characterSocket);
  if (cIdx === -1) {
    return undefined;
  }
  const oIdx = findOutfitIndex(state.characters[cIdx], outfitSocket);
  if (oIdx === -1) {
    return undefined;
  }
  const outfit = state.characters[cIdx].outfits[oIdx];
  outfit.enabled = !outfit.enabled;
  return outfit.enabled;
}

/**
 * Set a plain string field (`appearance`, `action`, or `focus`) on the
 * character matching `socket`. No-op if no match was found.
 */
export function setCharacterField(state, socket, key, value) {
  const idx = findCharacterIndex(state, socket);
  if (idx === -1) {
    return;
  }
  state.characters[idx][key] = value;
}

/**
 * Set the `text` (Details) field on the background matching `socket`. No-op
 * if no match was found.
 */
export function setBackgroundText(state, socket, value) {
  const idx = findBackgroundIndex(state, socket);
  if (idx === -1) {
    return;
  }
  state.backgrounds[idx].text = value;
}

/**
 * Set the `text` field on the outfit matching `outfitSocket` within the
 * character matching `characterSocket`. No-op if no match was found.
 */
export function setOutfitText(state, characterSocket, outfitSocket, value) {
  const cIdx = findCharacterIndex(state, characterSocket);
  if (cIdx === -1) {
    return;
  }
  const oIdx = findOutfitIndex(state.characters[cIdx], outfitSocket);
  if (oIdx === -1) {
    return;
  }
  state.characters[cIdx].outfits[oIdx].text = value;
}

// ---- JS mirrors of `_scene_creator_helpers.py`'s assembly (for the
// client-side live preview — see `render.mjs`'s `computeClientSceneJson`).
// These MUST match the Python versions byte-for-byte: same non-empty
// dropping, same key order, same wire-overrides-text-vs-wire-plus-text
// semantics. `wiredValues` mirrors the backend's `kwargs`/`onExecuted`'s
// `slots` map (socket name -> already-unwrapped string) — `{}` before any
// run, so every character/background/outfit falls back to its own text
// field until the node has actually executed once.

/**
 * Join an (already-normalized) character's enabled outfit entries. Mirrors
 * `_assemble_outfits_block`: for each enabled entry, the wired value
 * (`wiredValues[entry.socket]`) overrides `entry.text` when non-empty;
 * entries are processed in order and joined with `", "`, dropping empty
 * pieces.
 */
export function assembleOutfitsBlock(outfits, wiredValues) {
  const pieces = [];
  (outfits || []).forEach((entry) => {
    if (!entry || !entry.enabled) {
      return;
    }
    const wireRaw = entry.socket ? (wiredValues && wiredValues[entry.socket]) : undefined;
    const wire = wireRaw === undefined || wireRaw === null ? "" : String(wireRaw).trim();
    const value = wire || String(entry.text || "").trim();
    if (value) {
      pieces.push(value);
    }
  });
  return pieces.join(", ");
}

/**
 * Build the structured `characters` array from enabled character entries.
 * Mirrors `assemble_characters` exactly:
 * - `appearance` is the wired `socket` value when non-empty, else the
 *   character's own `appearance` field.
 * - `clothes` is `assembleOutfitsBlock`'s result for that character's
 *   outfits.
 * - `action` / `focus` are the character's own text fields.
 * - The emitted entry always has `name`; `appearance`/`clothes`/`action`/
 *   `focus` are included only when non-empty. A character is skipped
 *   entirely (not just left name-only) if ALL five are empty.
 */
export function assembleCharacters(characters, wiredValues) {
  const result = [];
  (characters || []).forEach((character) => {
    if (!character || !character.enabled) {
      return;
    }
    const wireRaw = character.socket ? (wiredValues && wiredValues[character.socket]) : undefined;
    const wire = wireRaw === undefined || wireRaw === null ? "" : String(wireRaw).trim();
    const appearance = wire || String(character.appearance || "").trim();

    const outfits = Array.isArray(character.outfits) ? character.outfits : [];
    const clothes = assembleOutfitsBlock(outfits, wiredValues);

    const action = String(character.action || "").trim();
    const focus = String(character.focus || "").trim();
    const name = String(character.name || "").trim();

    if (!name && !appearance && !clothes && !action && !focus) {
      return;
    }

    const entry = { name };
    if (appearance) {
      entry.appearance = appearance;
    }
    if (clothes) {
      entry.clothes = clothes;
    }
    if (action) {
      entry.action = action;
    }
    if (focus) {
      entry.focus = focus;
    }
    result.push(entry);
  });
  return result;
}

/**
 * Build the `{backgrounds}` substitution from enabled background entries.
 * Mirrors `assemble_background_block` exactly: for each enabled background,
 * the wired value AND its own `text` are BOTH kept (unlike an outfit's
 * wire-overrides-text) — joined with `", "`, dropping any empty piece — and
 * the per-background blocks are then joined with `", "`.
 */
export function assembleBackgroundBlock(backgrounds, wiredValues) {
  const blocks = [];
  (backgrounds || []).forEach((background) => {
    if (!background || !background.enabled) {
      return;
    }
    const wireRaw = background.socket ? (wiredValues && wiredValues[background.socket]) : undefined;
    const tags = wireRaw === undefined || wireRaw === null ? "" : String(wireRaw).trim();
    const text = String(background.text || "").trim();
    const pieces = [tags, text].filter((piece) => piece);
    if (pieces.length) {
      blocks.push(pieces.join(", "));
    }
  });
  return blocks.join(", ");
}

/**
 * Render one `assembleCharacters` entry as a labeled prose paragraph.
 * Mirrors `render_character_paragraph` byte-for-byte: takes the present
 * sub-values in the fixed order `appearance`, `clothes`, `action`, `focus`,
 * each stripped, joins them with `", "`, then appends a single trailing
 * `;` to the whole paragraph. The paragraph is prefixed with `"<name>: "`
 * when `name` is non-empty, else it's just the body (still `;`-terminated).
 * A character with a name but no body (all four sub-values empty — e.g. a
 * name-only cameo) yields just the bare name — no `;`, no dangling `": "`.
 */
export function renderCharacterParagraph(character) {
  const name = String((character && character.name) || "").trim();
  const pieces = [];
  ["appearance", "clothes", "action", "focus"].forEach((key) => {
    const value = String((character && character[key]) || "").trim();
    if (value) {
      pieces.push(value);
    }
  });

  if (!pieces.length) {
    return name;
  }

  const body = `${pieces.join(", ")};`;
  return name ? `${name}: ${body}` : body;
}

/**
 * Assemble the scene as LABELED PROSE SECTIONS. Mirrors `build_scene_text`
 * byte-for-byte (see its doc comment for the full rationale — a JSON
 * `{token: value}` document was tried first but proved noisy for a
 * Qwen-style text encoder).
 *
 * Each `{token}` from `parseTokens(template)` routes into one of four
 * FIXED-ORDER buckets (the final section order is lead -> characters ->
 * labeled -> tail, regardless of where each token actually sits in the
 * template):
 * - `LEAD_TOKEN` (`"tags"`): rendered UNLABELED as a bare lead line — the
 *   one token exempt from labeling (no trailing punctuation added). Only
 *   ever one such line.
 * - The reserved `characters` token: each `assembleCharacters` entry becomes
 *   one paragraph (`renderCharacterParagraph`); paragraphs are joined with a
 *   blank line (`"\n\n"`) between characters.
 * - LABELED: the reserved `backgrounds` token becomes a single
 *   `"Background: <value>;"` line; any OTHER token that isn't in
 *   `TAIL_TOKENS` becomes `"<Humanize(token)>: <value>;"` — EVERY labeled
 *   line ends with a trailing `;`. Preserves the template's token order,
 *   packed with a single `"\n"` between lines (no blank lines within this
 *   section).
 * - TAIL: any token in `TAIL_TOKENS` (`"scene_description"`, `"shot"`)
 *   renders as a bare UNLABELED value line — no label, no punctuation.
 *   Preserves the template's token order, packed with a single `"\n"`
 *   between lines.
 *
 * Any empty value (blank field, empty characters list, empty background) is
 * dropped entirely — no empty lines, no dangling labels. The four bucket
 * results are then joined with a blank line (`"\n\n"`), skipping any bucket
 * that ended up empty.
 */
export function buildSceneText(template, fields, charactersList, backgroundBlock) {
  let lead = "";
  let characterBlock = "";
  const labeledLines = [];
  const tailLines = [];

  parseTokens(template).forEach((token) => {
    if (token === LEAD_TOKEN) {
      lead = String((fields && fields[token]) || "").trim();
    } else if (token === RESERVED_CHARACTERS_TOKEN) {
      const paragraphs = (charactersList || []).map(renderCharacterParagraph);
      characterBlock = paragraphs.filter((p) => p).join("\n\n");
    } else if (token === RESERVED_BACKGROUNDS_TOKEN) {
      const background = String(backgroundBlock || "").trim();
      if (background) {
        labeledLines.push(`Background: ${background};`);
      }
    } else if (TAIL_TOKENS.has(token)) {
      const value = String((fields && fields[token]) || "").trim();
      if (value) {
        tailLines.push(value);
      }
    } else {
      const value = String((fields && fields[token]) || "").trim();
      if (value) {
        labeledLines.push(`${humanize(token)}: ${value};`);
      }
    }
  });

  const parts = [lead, characterBlock, labeledLines.join("\n"), tailLines.join("\n")].filter(
    (part) => part,
  );
  return parts.join("\n\n");
}

/**
 * Read the current litegraph input slot names, in slot order, from
 * `node.inputs`. Returns `[]` if the node has no inputs yet.
 */
export function getInputNames(node) {
  const inputs = (node && node.inputs) || [];
  return inputs.map((input) => input && input.name).filter((name) => !!name);
}

/**
 * Whether `node.inputs` already has a slot named `name`.
 */
export function hasInputNamed(node, name) {
  return getInputNames(node).includes(name);
}
