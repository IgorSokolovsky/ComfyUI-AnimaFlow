/**
 * interaction.mjs — input wiring + litegraph slot mutation for the Scene
 * Creator DOM UI.
 *
 * Connects the DOM root's events (built by `render.mjs`'s `buildRoot`) to
 * state updates (`core.mjs`), litegraph's real `addInput`/`removeInput` for
 * CHARACTER / OUTFIT / BACKGROUND sockets, and re-rendering (`render.mjs`).
 * No element creation/removal lives here; that belongs to `render.mjs`.
 *
 * Unlike Prompt Combiner (where the TEMPLATE is the single source of truth
 * for every socket), here only CHARACTER, OUTFIT, and BACKGROUND entries get
 * real litegraph sockets — the TEMPLATE only drives SCENE FIELDS (plain DOM
 * inputs, no sockets; see `render.mjs`'s `rebuildFields`). Those sockets are
 * created/removed exclusively via "＋ Add Character"/"＋ Add Background"/
 * "＋ outfit" and their respective ✕ buttons, never by editing the template
 * text.
 */

import {
  sanitizeToken,
  appendTokenToTemplate,
  ensureState,
  addCharacterToState,
  removeCharacterFromState,
  addOutfitToState,
  removeOutfitFromState,
  addBackgroundToState,
  removeBackgroundFromState,
  hasInputNamed,
} from "./core.mjs";
import { rebuildFields, rebuildCharacters, rebuildBackgrounds, scheduleRefit } from "./render.mjs";

/**
 * The wildcard slot type used so a Scene Creator socket accepts a connection
 * from either a STRING or a PROMPT_DATA output (matches
 * `js/anima_prompt/prompt_combiner/interaction.mjs`'s `ANY_TYPE`).
 */
export const ANY_TYPE = "*";

/**
 * Mirror the DOM textarea's current value into the hidden `template` widget
 * so it keeps serializing normally to the backend.
 */
export function mirrorTemplateToWidget(refs) {
  if (refs.templateWidget) {
    refs.templateWidget.value = refs.templateEl.value;
  }
}

/**
 * Add a real litegraph input slot for every socket named in
 * `node.properties.sceneState` (every background, every character, every
 * character's every outfit) that doesn't already have one — idempotent
 * (matches by socket NAME against existing `node.inputs`, so a second call
 * is always a safe no-op; never duplicates a slot). Used on mount/
 * `onConfigure` restore as a defensive re-sync (litegraph itself restores
 * real input slots from the saved workflow before `onConfigure` runs, so
 * this normally has nothing to do — it's a backstop for any mismatch).
 * Returns `true` if any slot was actually added.
 */
export function syncAllSockets(node) {
  const state = ensureState(node);
  let changed = false;
  const addIfMissing = (name) => {
    if (!hasInputNamed(node, name)) {
      if (typeof node.addInput === "function") {
        node.addInput(name, ANY_TYPE);
        changed = true;
      }
    }
  };
  (state.backgrounds || []).forEach((background) => addIfMissing(background.socket));
  (state.characters || []).forEach((character) => {
    addIfMissing(character.socket);
    (character.outfits || []).forEach((outfit) => addIfMissing(outfit.socket));
  });
  return changed;
}

/**
 * Add a new character: assigns it a stable socket id PLUS one default
 * outfit's own stable socket id, adds BOTH real litegraph input slots,
 * rebuilds the CHARACTERS cards, and schedules the ONE structural refit this
 * causes.
 */
export function addCharacter(node, refs, name) {
  const state = ensureState(node);
  const character = addCharacterToState(state, name);
  if (typeof node.addInput === "function") {
    node.addInput(character.socket, ANY_TYPE);
    (character.outfits || []).forEach((outfit) => node.addInput(outfit.socket, ANY_TYPE));
  }
  rebuildCharacters(node, refs, refs._characterHandlers);
  scheduleRefit(node, refs.root);
  return character;
}

/**
 * Remove a character by socket name: drops its real litegraph input slot
 * AND every one of its outfits' input slots (matched by NAME — dropping any
 * wire they had), splices it out of `sceneState.characters`, rebuilds the
 * CHARACTERS cards, and schedules the ONE structural refit this causes.
 */
export function removeCharacter(node, refs, socket) {
  const state = ensureState(node);
  const removed = removeCharacterFromState(state, socket);
  const socketsToDrop = [socket, ...((removed && removed.outfits) || []).map((o) => o.socket)];
  socketsToDrop.forEach((name) => {
    const inputs = (node && node.inputs) || [];
    const idx = inputs.findIndex((i) => i && i.name === name);
    if (idx !== -1 && typeof node.removeInput === "function") {
      node.removeInput(idx);
    }
  });
  rebuildCharacters(node, refs, refs._characterHandlers);
  scheduleRefit(node, refs.root);
}

/**
 * Add a new outfit to the character matching `characterSocket`: assigns it
 * a stable socket id, adds the real litegraph input slot, rebuilds the
 * CHARACTERS cards, and schedules the ONE structural refit this causes.
 */
export function addOutfit(node, refs, characterSocket) {
  const state = ensureState(node);
  const outfit = addOutfitToState(state, characterSocket);
  if (outfit && typeof node.addInput === "function") {
    node.addInput(outfit.socket, ANY_TYPE);
  }
  rebuildCharacters(node, refs, refs._characterHandlers);
  scheduleRefit(node, refs.root);
  return outfit;
}

/**
 * Remove one outfit (by its own socket name) from the character matching
 * `characterSocket`: drops its real litegraph input slot (dropping any wire
 * it had), splices it out of that character's `outfits`, rebuilds the
 * CHARACTERS cards, and schedules the ONE structural refit this causes.
 */
export function removeOutfit(node, refs, characterSocket, outfitSocket) {
  const state = ensureState(node);
  const removed = removeOutfitFromState(state, characterSocket, outfitSocket);
  if (removed) {
    const inputs = (node && node.inputs) || [];
    const idx = inputs.findIndex((i) => i && i.name === outfitSocket);
    if (idx !== -1 && typeof node.removeInput === "function") {
      node.removeInput(idx);
    }
  }
  rebuildCharacters(node, refs, refs._characterHandlers);
  scheduleRefit(node, refs.root);
}

/**
 * Add a new background: assigns it a stable socket id, adds the real
 * litegraph input slot, rebuilds the BACKGROUNDS cards, and schedules the
 * ONE structural refit this causes.
 */
export function addBackground(node, refs, name) {
  const state = ensureState(node);
  const background = addBackgroundToState(state, name);
  if (typeof node.addInput === "function") {
    node.addInput(background.socket, ANY_TYPE);
  }
  rebuildBackgrounds(node, refs, refs._backgroundHandlers);
  scheduleRefit(node, refs.root);
  return background;
}

/**
 * Remove a background by socket name: drops its real litegraph input slot
 * (dropping any wire it had), splices it out of `sceneState.backgrounds`,
 * rebuilds the BACKGROUNDS cards, and schedules the ONE structural refit
 * this causes.
 */
export function removeBackground(node, refs, socket) {
  const state = ensureState(node);
  removeBackgroundFromState(state, socket);
  const inputs = (node && node.inputs) || [];
  const idx = inputs.findIndex((i) => i && i.name === socket);
  if (idx !== -1 && typeof node.removeInput === "function") {
    node.removeInput(idx);
  }
  rebuildBackgrounds(node, refs, refs._backgroundHandlers);
  scheduleRefit(node, refs.root);
}

function closeAddRow(row, nameInput) {
  row.classList.remove("wsc-show");
  nameInput.value = "";
}

/**
 * Wire every interactive element in `refs` (as returned by `buildRoot`) for
 * `node`. Idempotent — a second call on the same `refs` is a no-op.
 */
export function wireInteractions(node, refs) {
  if (refs.wired) {
    return refs;
  }
  refs.wired = true;

  // Bundled handler objects handed to `rebuildCharacters`/`rebuildBackgrounds`
  // (and, transitively, to each card's bound remove/add-outfit controls) —
  // built once here so every rebuild call (initial, structural, restore)
  // wires cards identically.
  refs._characterHandlers = {
    onRemove: (socket) => removeCharacter(node, refs, socket),
    onAddOutfit: (characterSocket) => addOutfit(node, refs, characterSocket),
    onRemoveOutfit: (characterSocket, outfitSocket) => removeOutfit(node, refs, characterSocket, outfitSocket),
  };
  refs._backgroundHandlers = {
    onRemove: (socket) => removeBackground(node, refs, socket),
  };

  // ---- Template edit -> mirror to hidden widget -> reconcile SCENE FIELDS
  // (never touches character/background/outfit sockets) ----
  refs.templateEl.addEventListener("input", () => {
    mirrorTemplateToWidget(refs);
    rebuildFields(node, refs);
  });

  // ---- Add Scene Field ----
  refs.addFieldBtn.addEventListener("click", () => {
    refs.addFieldRow.classList.add("wsc-show");
    if (typeof refs.addFieldNameInput.focus === "function") {
      refs.addFieldNameInput.focus();
    }
  });

  function confirmAddField() {
    const token = sanitizeToken(refs.addFieldNameInput.value);
    if (!token) {
      if (typeof refs.addFieldNameInput.focus === "function") {
        refs.addFieldNameInput.focus();
      }
      return;
    }
    const nextTemplate = appendTokenToTemplate(refs.templateEl.value, token);
    if (nextTemplate !== refs.templateEl.value) {
      refs.templateEl.value = nextTemplate;
      mirrorTemplateToWidget(refs);
    }
    closeAddRow(refs.addFieldRow, refs.addFieldNameInput);
    rebuildFields(node, refs);
  }

  refs.addFieldConfirmBtn.addEventListener("click", confirmAddField);
  refs.addFieldCancelBtn.addEventListener("click", () =>
    closeAddRow(refs.addFieldRow, refs.addFieldNameInput),
  );
  refs.addFieldNameInput.addEventListener("keydown", (event) => {
    const key = event && event.key;
    if (key === "Enter") {
      confirmAddField();
    } else if (key === "Escape") {
      closeAddRow(refs.addFieldRow, refs.addFieldNameInput);
    }
  });

  // ---- Add Background ----
  refs.addBgBtn.addEventListener("click", () => {
    refs.addBgRow.classList.add("wsc-show");
    if (typeof refs.addBgNameInput.focus === "function") {
      refs.addBgNameInput.focus();
    }
  });

  function confirmAddBg() {
    const name = (refs.addBgNameInput.value || "").trim();
    if (!name) {
      if (typeof refs.addBgNameInput.focus === "function") {
        refs.addBgNameInput.focus();
      }
      return;
    }
    addBackground(node, refs, name);
    closeAddRow(refs.addBgRow, refs.addBgNameInput);
  }

  refs.addBgConfirmBtn.addEventListener("click", confirmAddBg);
  refs.addBgCancelBtn.addEventListener("click", () =>
    closeAddRow(refs.addBgRow, refs.addBgNameInput),
  );
  refs.addBgNameInput.addEventListener("keydown", (event) => {
    const key = event && event.key;
    if (key === "Enter") {
      confirmAddBg();
    } else if (key === "Escape") {
      closeAddRow(refs.addBgRow, refs.addBgNameInput);
    }
  });

  // ---- Add Character ----
  refs.addCharBtn.addEventListener("click", () => {
    refs.addCharRow.classList.add("wsc-show");
    if (typeof refs.addCharNameInput.focus === "function") {
      refs.addCharNameInput.focus();
    }
  });

  function confirmAddChar() {
    const name = (refs.addCharNameInput.value || "").trim();
    if (!name) {
      if (typeof refs.addCharNameInput.focus === "function") {
        refs.addCharNameInput.focus();
      }
      return;
    }
    addCharacter(node, refs, name);
    closeAddRow(refs.addCharRow, refs.addCharNameInput);
  }

  refs.addCharConfirmBtn.addEventListener("click", confirmAddChar);
  refs.addCharCancelBtn.addEventListener("click", () =>
    closeAddRow(refs.addCharRow, refs.addCharNameInput),
  );
  refs.addCharNameInput.addEventListener("keydown", (event) => {
    const key = event && event.key;
    if (key === "Enter") {
      confirmAddChar();
    } else if (key === "Escape") {
      closeAddRow(refs.addCharRow, refs.addCharNameInput);
    }
  });

  return refs;
}
