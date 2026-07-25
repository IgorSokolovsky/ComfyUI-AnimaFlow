/**
 * interaction.mjs — input wiring + litegraph slot mutation for the Prompt
 * Combiner DOM UI.
 *
 * Connects the DOM root's events (built by `render.mjs`'s `buildRoot`) to
 * state updates (`core.mjs`), litegraph's real `addInput`/`removeInput`
 * (the input slots ARE the variable list — see core.mjs), and re-rendering
 * (`render.mjs`).
 *
 * Fix B — the TEMPLATE is the single source of truth for the node's input
 * sockets: `reconcileInputsFromTemplate` below parses `{token}`s out of the
 * template text and adds/removes real input slots to match. Every path that
 * changes the template text (typing directly, "＋ Add Input", a row's ✕)
 * funnels through it, so a socket only ever exists because its `{token}`
 * currently appears in the template. No element creation/removal lives
 * here; that belongs to `render.mjs`.
 */

import {
  sanitizeToken,
  appendTokenToTemplate,
  removeTokenFromTemplate,
  hasInputNamed,
  parseTokens,
  syncStateFromInputs,
} from "./core.mjs";
import { rebuildInputsList, scheduleRefit } from "./render.mjs";

/**
 * The wildcard slot type used so a Prompt Combiner input accepts a
 * connection from either a STRING or a PROMPT_DATA output. `"*"` is the
 * common ComfyUI/litegraph "accept anything" convention (matches by
 * equality against any output type in litegraph's connection validation).
 *
 * NOTE — cannot be confirmed without a live ComfyUI: if this build's
 * litegraph does NOT treat a plain `"*"` string as "any" (some older/forked
 * validators instead expect a special wildcard object whose `toString()`
 * returns `"*"` and which overrides equality/`.includes` checks — the
 * pattern used by e.g. rgthree-comfy's `AnyType`), swap this single
 * constant for that object. See the manual checklist in the build report.
 */
export const ANY_TYPE = "*";

/**
 * Add a real input slot named `name` to `node` (litegraph `addInput`) if it
 * doesn't already have one. No-op if a slot with that name already exists,
 * or if `node.addInput` isn't available (defensive; shouldn't happen in
 * ComfyUI's actual runtime).
 */
export function addInputSlot(node, name) {
  if (!name || hasInputNamed(node, name)) {
    return;
  }
  if (typeof node.addInput === "function") {
    node.addInput(name, ANY_TYPE);
  }
  syncStateFromInputs(node);
}

/**
 * Mirror the DOM textarea's current value into the hidden `template`
 * widget so it keeps serializing normally to the backend. Exported so
 * `index.js` can reuse it when seeding the default template on a fresh
 * node.
 */
export function mirrorTemplateToWidget(refs) {
  if (refs.templateWidget) {
    refs.templateWidget.value = refs.templateEl.value;
  }
}

/**
 * Make the TEMPLATE the single source of truth for the node's input
 * sockets: parse `{token}`s out of `refs.templateEl.value`, add a real
 * input slot (`node.addInput`) for every token that doesn't have one yet,
 * and remove every existing input slot whose name no longer appears in the
 * template (`node.removeInput`, which drops its wire) — matched by NAME,
 * never by array position. Rebuilds the INPUTS rows to match afterward, and
 * schedules exactly one auto-fit refit, but ONLY when a slot was actually
 * added or removed (the ONE structural change) — a template edit that
 * doesn't change the token set (prose, punctuation, reordering an existing
 * clause) is a no-op here: same names, so no add/remove, no row rebuild, no
 * refit.
 *
 * Reentrancy-guarded (`refs._reconciling`): `node.addInput`/`removeInput`
 * can themselves trigger `onConnectionsChange` synchronously in some
 * LiteGraph builds, and this function must never be re-entered while it's
 * already mutating slots for the same node. Idempotent: calling it again
 * with the same template/inputs is a safe no-op (used by `onConfigure`
 * restore, where the just-restored `node.inputs` already match the
 * just-restored template).
 */
export function reconcileInputsFromTemplate(node, refs) {
  if (!node || !refs || refs._reconciling) {
    return false;
  }
  refs._reconciling = true;
  let changed = false;
  try {
    const tokens = parseTokens(refs.templateEl.value);
    const tokenSet = new Set(tokens);

    // Remove slots for tokens no longer in the template. Walk backwards so
    // index-based `removeInput` calls never skip a slot as the array
    // shifts underneath the loop.
    for (let i = ((node.inputs && node.inputs.length) || 0) - 1; i >= 0; i--) {
      const input = node.inputs[i];
      const name = input && input.name;
      if (name && !tokenSet.has(name)) {
        if (typeof node.removeInput === "function") {
          node.removeInput(i);
        }
        changed = true;
      }
    }
    if (changed) {
      syncStateFromInputs(node);
    }

    // Add a slot for every token that doesn't have one yet, in token order.
    tokens.forEach((name) => {
      if (!hasInputNamed(node, name)) {
        addInputSlot(node, name); // also syncs properties.combinerState
        changed = true;
      }
    });

    if (changed) {
      rebuildInputsList(node, refs, refs._handleRemove);
      scheduleRefit(node, refs.root);
    }
  } finally {
    refs._reconciling = false;
  }
  return changed;
}

function closeAddRow(refs) {
  refs.addRow.classList.remove("wpc-show");
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

  // A row's ✕ button: drop `{name}` from the template text; reconciling
  // (triggered right here, not via the `input` listener below, since we set
  // `.value` programmatically) removes the now-orphaned socket and its
  // wire.
  function handleRemove(name) {
    const nextTemplate = removeTokenFromTemplate(refs.templateEl.value, name);
    if (nextTemplate !== refs.templateEl.value) {
      refs.templateEl.value = nextTemplate;
    }
    mirrorTemplateToWidget(refs);
    reconcileInputsFromTemplate(node, refs);
  }

  // Template edit -> mirror to the hidden widget AND reconcile the input
  // sockets against the (possibly now different) token set. This is the ONE
  // place typing creates/removes a socket; `reconcileInputsFromTemplate`'s
  // own no-op-when-token-set-unchanged guard is what keeps a non-structural
  // edit (prose, reordering) from ever touching `node.inputs` or resizing.
  // The frontend cannot compute the combined output (that only exists at
  // execution, from the upstream nodes' real values), so a template edit
  // never touches the LIVE PREVIEW either (it shows the last executed
  // result).
  refs.templateEl.addEventListener("input", () => {
    mirrorTemplateToWidget(refs);
    reconcileInputsFromTemplate(node, refs);
  });

  refs.addBtn.addEventListener("click", () => {
    refs.addRow.classList.add("wpc-show");
    if (typeof refs.addNameInput.focus === "function") {
      refs.addNameInput.focus();
    }
  });

  function confirmAdd() {
    const name = sanitizeToken(refs.addNameInput.value);
    if (!name) {
      // Empty / all-punctuation input: keep the row open, refocus.
      if (typeof refs.addNameInput.focus === "function") {
        refs.addNameInput.focus();
      }
      return;
    }
    // Append `{name}` to the template text; `reconcileInputsFromTemplate`
    // is what actually creates the socket (Fix B: the template is the only
    // thing that creates/removes sockets, so this control never calls
    // `addInput` directly). A name that already has a `{token}` in the
    // template is a no-op here (`appendTokenToTemplate` returns the
    // template unchanged) — no duplicate socket, just closes the row.
    const nextTemplate = appendTokenToTemplate(refs.templateEl.value, name);
    if (nextTemplate !== refs.templateEl.value) {
      refs.templateEl.value = nextTemplate;
      mirrorTemplateToWidget(refs);
      reconcileInputsFromTemplate(node, refs);
    }
    closeAddRow(refs);
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

  // Expose for index.js (initial build + onConfigure restore both need to
  // (re)populate the INPUTS list with the same remove-handler wiring) and
  // for `reconcileInputsFromTemplate` itself (passed through to
  // `rebuildInputsList`).
  refs._handleRemove = handleRemove;

  return refs;
}
