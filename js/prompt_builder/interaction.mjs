/**
 * interaction.mjs — input wiring for the Prompt Builder DOM UI.
 *
 * Connects the DOM root's events (built by `render.mjs`'s `buildRoot`) to
 * state updates (`core.mjs`) and re-rendering (`render.mjs`). No element
 * creation/removal lives here; that belongs to `render.mjs`.
 */

import { sanitizeToken, appendTokenToTemplate } from "./core.mjs";
import { rebuildFields } from "./render.mjs";

/**
 * Mirror the DOM textarea's current value into the hidden `template`
 * widget so it keeps serializing normally to the backend.
 */
function mirrorTemplateToWidget(refs) {
  if (refs.templateWidget) {
    refs.templateWidget.value = refs.templateEl.value;
  }
}

function closeAddRow(refs) {
  refs.addRow.classList.remove("wpb-show");
  refs.addNameInput.value = "";
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

  // Template edit -> mirror to the hidden widget -> re-derive FIELDS rows
  // (add new, remove gone, cache removed values) -> update preview.
  refs.templateEl.addEventListener("input", () => {
    mirrorTemplateToWidget(refs);
    rebuildFields(node, refs);
  });

  refs.addBtn.addEventListener("click", () => {
    refs.addRow.classList.add("wpb-show");
    if (typeof refs.addNameInput.focus === "function") {
      refs.addNameInput.focus();
    }
  });

  function confirmAdd() {
    const token = sanitizeToken(refs.addNameInput.value);
    if (!token) {
      // Empty / all-punctuation input: keep the row open, refocus.
      if (typeof refs.addNameInput.focus === "function") {
        refs.addNameInput.focus();
      }
      return;
    }
    const nextTemplate = appendTokenToTemplate(refs.templateEl.value, token);
    if (nextTemplate !== refs.templateEl.value) {
      refs.templateEl.value = nextTemplate;
      mirrorTemplateToWidget(refs);
    }
    closeAddRow(refs);
    rebuildFields(node, refs);
  }

  refs.addConfirmBtn.addEventListener("click", confirmAdd);
  refs.addCancelBtn.addEventListener("click", () => closeAddRow(refs));
  refs.addNameInput.addEventListener("keydown", (event) => {
    const key = event && event.key;
    if (key === "Enter") {
      confirmAdd();
    } else if (key === "Escape") {
      closeAddRow(refs);
    }
  });

  return refs;
}
