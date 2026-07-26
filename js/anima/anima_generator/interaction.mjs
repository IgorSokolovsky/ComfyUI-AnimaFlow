/**
 * interaction.mjs — node/widget orchestration for the AnimaGenerator DOM
 * panel: finds+hides the real native widgets and builds/rebuilds each card's
 * field rows against them.
 *
 * ## No action here resizes the node any more
 *
 * This build replaced the node's earlier "grow/shrink to fit content" model
 * with `render.mjs`'s fixed-size, internally-scrolling `.wtn-ag-box` (see
 * that module's top doc comment for the full account). Toggling a stage's
 * Enabled checkbox (`wireEnabledCheckbox`'s change handler — still the
 * single open/closed control for its card, via `render.mjs`'s
 * `setCardEnabledUI`), collapsing/expanding a card, and switching the
 * `upscale_backend` combo (`onFieldChange`'s special case below — still
 * rebuilds the upscale card's body to show only the newly-selected
 * backend's fields, the dynamic field-swap the plan calls "the one
 * genuinely dynamic bit") all change ONLY what's inside that scroll box now
 * — none of them calls anything resize-related any more (there is nothing
 * left to call: `render.mjs`'s `scheduleRefit`/`refitNode` were removed
 * entirely by this build). The STRUCTURAL-vs-VALUE distinction this file
 * used to enforce (which edits were allowed to trigger a refit) no longer
 * exists as a concept — nothing here ever refits.
 *
 * ## Widget-mirroring contract (per the plan's critical constraint)
 *
 * Every DOM control here reads its INITIAL value from the real widget's
 * `.value` (via `render.mjs`'s `buildFieldRow`) and, on every edit, WRITES
 * back to that same `.value` (never a parallel object) then calls the
 * widget's own `.callback` if it has one (`typeof widget.callback ===
 * "function"`) so litegraph's own bookkeeping (anything a callback does,
 * e.g. a combo's dependent-widget refresh) stays consistent — exactly the
 * skill's "mirror your DOM control into w.value on every edit" pattern,
 * just without the `w.hidden` flip happening per-field (that happens once,
 * up front, via `hideLayoutWidgets`).
 */

import { CARD_DEFS, getCardFieldNames } from "./core.mjs";
import {
  renderCardFields,
  setCardEnabledUI,
  updateFieldRowValue,
} from "./render.mjs";

export function findWidget(node, name) {
  return ((node && node.widgets) || []).find((w) => w.name === name);
}

/** Hide a declared widget from rendering only — it keeps serializing
 * normally (per the skill's "hide a declared widget that must still
 * serialize" pattern) — sets `hidden`/`computeSize` and, if present, hides
 * its `inputEl`. NEVER sets `widget.serialize = false`: that would break
 * the very round-trip this whole node's "no Python change" design depends
 * on (a saved workflow must still carry every stage's real value). */
export function hideWidget(targetWidget) {
  if (!targetWidget) {
    return;
  }
  targetWidget.hidden = true;
  targetWidget.computeSize = () => [0, -4];
  if (targetWidget.inputEl && targetWidget.inputEl.style) {
    targetWidget.inputEl.style.display = "none";
  }
}

/** Hide every widget named anywhere in `core.mjs`'s `CARD_DEFS` (both
 * upscale-backend variants included) that actually exists on `node` right
 * now. A name with no matching widget (e.g. `control_after_generate` — see
 * `core.mjs`'s doc comment) is silently skipped here; `renderCard` below is
 * what logs the one-time warning when it actually tries to render that
 * field's row. `positive_text`/`negative_text` are never touched — they are
 * not in `getAllLayoutWidgetNames()` at all (kept native per the plan). */
export function hideLayoutWidgets(node, allLayoutWidgetNames) {
  allLayoutWidgetNames.forEach((name) => {
    const w = findWidget(node, name);
    if (w) {
      hideWidget(w);
    }
  });
}

export function getUpscaleBackendValue(node) {
  const w = findWidget(node, "upscale_backend");
  return (w && typeof w.value === "string" && w.value) || "usdu";
}

const loggedMissing = new Set();

/** Log a "widget not found, skipping this control" warning exactly ONCE per
 * (card, widget name) pair for the lifetime of the page — never throws,
 * never blanks the node; the row itself still renders (as an "(unavailable)"
 * placeholder, see `render.mjs`'s `buildFieldRow`). */
export function logMissingOnce(cardId, name) {
  const key = cardId + ":" + name;
  if (loggedMissing.has(key)) {
    return;
  }
  loggedMissing.add(key);
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(
      `[AnimaGenerator panel] widget "${name}" (card "${cardId}") was not found on this node -- skipping that control.`,
    );
  }
}

/** Reset the one-warning-per-pair dedup set (test hygiene only). */
export function resetLoggedMissing() {
  loggedMissing.clear();
}

/**
 * Move `domWidget` to just before `positive_text`/`negative_text` in
 * `node.widgets` so the sectioned panel renders ABOVE those two native
 * multiline textareas (per the plan: "keep them ... at the bottom"), rather
 * than below them (where `addDOMWidget` would otherwise leave it, having
 * pushed it to the END of an array where those two already-declared native
 * widgets sit). Safe: `domWidget` has `serialize: false`, so its position in
 * `node.widgets` has zero effect on `widgets_values`/save-load
 * correspondence for any OTHER (real, serializing) widget — only their
 * mutual order matters for that, and this function never touches it. No-op
 * if neither textarea exists (shouldn't happen — they're required
 * `INPUT_TYPES` optional-but-always-present widgets) or `domWidget` is
 * already positioned correctly.
 */
export function repositionDomWidget(node, domWidget) {
  if (!node || !Array.isArray(node.widgets) || !domWidget) {
    return;
  }
  const domIdx = node.widgets.indexOf(domWidget);
  if (domIdx === -1) {
    return;
  }
  const targetIdx = node.widgets.findIndex((w) => w.name === "positive_text" || w.name === "negative_text");
  if (targetIdx === -1 || targetIdx === domIdx) {
    return;
  }
  node.widgets.splice(domIdx, 1);
  const newTargetIdx = node.widgets.findIndex((w) => w.name === "positive_text" || w.name === "negative_text");
  node.widgets.splice(newTargetIdx, 0, domWidget);
}

// ---------------------------------------------------------------------------
// Per-card render + wiring
// ---------------------------------------------------------------------------

/** (Re)build ONE card's field rows from the node's CURRENT widget values —
 * used at initial mount, at `onConfigure` restore, and whenever the upscale
 * backend combo changes (see `onFieldChange` below). Also re-derives the
 * card's open/closed state from its `enabledWidget`'s live value (via
 * `setCardEnabledUI`) for every card that has one — this is what makes
 * initial mount AND `onConfigure` restore both correctly open/close a card
 * from its restored Enabled value with no separate step. A card with no
 * `enabledWidget` (SAMPLER, PREVIEW) is untouched here: its body has no
 * `hidden` toggling at all, so it just stays permanently visible. */
export function renderCard(node, refs, cardDef) {
  const shell = refs.cards[cardDef.id];
  if (!shell) {
    return;
  }
  const backend = cardDef.id === "upscale" ? getUpscaleBackendValue(node) : undefined;
  const fieldNames = getCardFieldNames(cardDef, backend);

  // Stash the just-built row refs on the shell -- `refreshFieldValues` below
  // reads this to do a CHEAP, non-rebuilding resync (the whole point of this
  // build's external-mutation fix: it must never redo what this function
  // just did).
  shell.fieldRows = renderCardFields(
    refs.doc,
    shell.bodyEl,
    fieldNames,
    (name) => findWidget(node, name),
    (name, widget, value) => onFieldChange(node, refs, cardDef, name, widget, value),
    (name) => logMissingOnce(cardDef.id, name),
  );

  if (cardDef.enabledWidget) {
    const enabledWidget = findWidget(node, cardDef.enabledWidget);
    setCardEnabledUI(shell, !!(enabledWidget && enabledWidget.value));
  }
}

/** The single field-edit entry point every rendered control's `onChange`
 * funnels through (see `render.mjs`'s `buildFieldRow`). Writes the widget,
 * calls its `callback` if present, and -- ONLY for `upscale_backend` --
 * rebuilds the upscale card's body (the dynamic field-swap). Never resizes
 * the node (see this file's top doc comment) -- the rebuilt fields just
 * change what's inside `.wtn-ag-box`'s scroll region. */
function onFieldChange(node, refs, cardDef, name, widget, value) {
  widget.value = value;
  if (typeof widget.callback === "function") {
    widget.callback(widget.value, undefined, node);
  }
  if (name === "upscale_backend") {
    renderCard(node, refs, cardDef);
  }
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

function wireEnabledCheckbox(node, refs, cardDef) {
  if (!cardDef.enabledWidget) {
    return;
  }
  const shell = refs.cards[cardDef.id];
  if (!shell.enabledCheckbox) {
    return;
  }
  const widget = findWidget(node, cardDef.enabledWidget);
  if (!widget) {
    logMissingOnce(cardDef.id, cardDef.enabledWidget);
    shell.enabledCheckbox.disabled = true;
    return;
  }
  shell.enabledCheckbox.checked = !!widget.value;
  shell.enabledCheckbox.addEventListener("change", () => {
    widget.value = !!shell.enabledCheckbox.checked;
    if (typeof widget.callback === "function") {
      widget.callback(widget.value, undefined, node);
    }
    // Opens/closes the card inside the scroll box only -- never resizes the
    // node (see this file's top doc comment).
    setCardEnabledUI(shell, widget.value);
    if (typeof node.setDirtyCanvas === "function") {
      node.setDirtyCanvas(true, true);
    }
  });
}

/** Wire every card's Enabled checkbox (once) and render each card's initial
 * field rows. `renderCard` (called per card below) is what derives each
 * optional card's initial open/closed state from its restored `enabledWidget`
 * value -- there is no separate collapse-state step, unlike the property-
 * backed collapse this build removes. Idempotent guard lives in `index.js`
 * (`node._agRefs`), not here — this always (re)does the wiring when called,
 * matching `mountUI`'s single call site. */
export function mountAllCards(node, refs) {
  CARD_DEFS.forEach((cardDef) => {
    wireEnabledCheckbox(node, refs, cardDef);
    renderCard(node, refs, cardDef);
  });
}

/** Re-render every card's fields from the node's NOW-restored widget values
 * (after `onConfigure`). `renderCard` (called per card below) re-derives
 * each optional card's open/closed state from its just-restored
 * `enabledWidget` value -- the same mechanism `mountAllCards` uses, so a
 * saved-workflow reload opens/closes every card exactly as it was saved with
 * zero extra bookkeeping. Does NOT re-wire listeners (already wired once by
 * `mountAllCards`, and the DOM elements those listeners are attached to are
 * the same shell elements — only each card's BODY is torn down/rebuilt by
 * `renderCard`). Does NOT call `scheduleRefit`/`scheduleInitialFit` -- trusts
 * the `node.size` litegraph already restored (mirrors
 * `js/anima_prompt/anima_prompt_studio/index.js`'s `restoreNode`). */
export function refreshAllCards(node, refs) {
  CARD_DEFS.forEach((cardDef) => {
    renderCard(node, refs, cardDef);
  });
}

/**
 * The external-mutation resync path (the gap this build fixes): re-sync
 * every ALREADY-RENDERED field row's DOM control from its native widget's
 * CURRENT value -- e.g. `seed` after ComfyUI's own `control_after_generate`
 * (randomize/increment/decrement) rewrites it post-queue, entirely outside
 * this panel. Unlike `refreshAllCards` (mount/`onConfigure` -- a full
 * teardown+rebuild via `renderCard`, correct there because a restored
 * workflow may also need a different upscale-backend field set applied),
 * this NEVER calls `renderCard`/`renderCardFields`: it only touches the
 * exact DOM elements `shell.fieldRows` already points at (stashed there the
 * last time `renderCard` ran), via `render.mjs`'s `updateFieldRowValue`.
 *
 * `activeEl` (typically `refs.doc.activeElement`) is threaded through to
 * `updateFieldRowValue` so a resync firing while the user is mid-typing in a
 * field never clobbers it (see that function's doc comment for the exact
 * per-kind skip rule). The Enabled checkbox gets the same treatment here
 * (skipped if it's the focused element) even though it's wired outside
 * `renderCardFields` -- it's still a plain value mirror of its widget.
 *
 * ## Enabled-driven open/close is still mirrored -- it just never resizes
 *
 * Because Enabled still directly controls whether a card's body is even
 * rendered (`setCardEnabledUI` hides/shows `bodyEl`), an externally-mutated
 * `*_enabled` widget (nothing in this panel does that today, but a future
 * Python-side default change or another extension writing the widget
 * directly is exactly the class of external mutation this whole resync path
 * exists for) must open/close that card here too, not just refresh its
 * checkbox's `.checked`. Compare the widget's CURRENT value against what the
 * checkbox already shows; only call `setCardEnabledUI` (open/close the card)
 * when they actually differ. Unlike the previous revision, there is no
 * refit to schedule/coalesce here at all any more (see this file's top doc
 * comment) -- opening/closing a card only ever changes what's visible
 * inside `.wtn-ag-box`'s scroll region, never the node's size.
 *
 * Deliberately does NOT re-derive the upscale card's backend-specific field
 * set (unlike `renderCard`) -- if `upscale_backend` itself were mutated
 * externally, the currently-rendered fields would go stale until the next
 * `onConfigure`/full restore; out of scope for this cheap per-execution path
 * (see this build's report).
 */
export function refreshFieldValues(node, refs) {
  if (!refs || !refs.cards) {
    return;
  }
  const activeEl = refs.doc ? refs.doc.activeElement : undefined;
  CARD_DEFS.forEach((cardDef) => {
    const shell = refs.cards[cardDef.id];
    if (!shell || !shell.fieldRows) {
      return;
    }
    Object.keys(shell.fieldRows).forEach((name) => {
      const widget = findWidget(node, name);
      if (!widget) {
        return;
      }
      updateFieldRowValue(shell.fieldRows[name], widget, activeEl);
    });
    if (cardDef.enabledWidget && shell.enabledCheckbox && shell.enabledCheckbox !== activeEl) {
      const enabledWidget = findWidget(node, cardDef.enabledWidget);
      if (enabledWidget) {
        const nowEnabled = !!enabledWidget.value;
        const wasEnabled = !!shell.enabledCheckbox.checked;
        if (nowEnabled !== wasEnabled) {
          setCardEnabledUI(shell, nowEnabled);
        }
      }
    }
  });
}

/**
 * Fan `refreshFieldValues` out to every live AnimaGenerator node in `nodes`
 * (typically `app.graph.findNodesByType("AnimaGenerator")` -- resolved by
 * `index.js`'s `findAnimaGeneratorNodes`, kept out of this module so this
 * function stays testable without a real ComfyUI `app`/`api` host). A node
 * with no mounted panel (`node._agRefs` unset -- e.g. a node of this type
 * that hasn't finished `onNodeCreated` yet) is silently skipped. Any
 * exception `refreshFieldValues` raises for ONE node is caught so it can
 * never stop the others, and can never bubble up into ComfyUI's own
 * execution-event dispatch (the entire reason this function, not
 * `refreshFieldValues` directly, is what an execution-event handler should
 * call) -- degrades to a no-op rather than throwing, per the plan's "never
 * blank the node" rule.
 */
export function resyncAllFromWidgets(nodes) {
  (nodes || []).forEach((node) => {
    const refs = node && node._agRefs;
    if (!refs) {
      return;
    }
    try {
      refreshFieldValues(node, refs);
    } catch (err) {
      // Never let one node's resync failure break the others or bubble into
      // ComfyUI's own execution-event dispatch.
    }
  });
}
