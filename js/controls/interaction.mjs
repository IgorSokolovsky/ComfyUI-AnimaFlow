/**
 * interaction.mjs — event wiring + node-level orchestration for the Control
 * Panel / Loader Panel row UI. `render.mjs` only builds/paints DOM; this
 * module is where clicking, dragging, the state <-> hidden-widget
 * handshake, and output-slot bookkeeping actually happen.
 *
 * `index.js` calls into this module's exported orchestration functions
 * (`ensureState`/`restoreStateFromWidget`/`persistState`/`syncRows`/
 * `syncOutputs`/`alignOutputsLegacy`/`fitNode`/`scheduleFit`/
 * `resolveAutoOnConnect`/`rowCountOf`) from its `onNodeCreated`/
 * `onConfigure`/`onConnectionsChange`/`arrange` hooks. Everything below that
 * is pure row-level event wiring is private to this module.
 *
 * ## `ctx` — the one object every function here takes
 *
 * `index.js` builds one `ctx` per node (or reuses one per panel kind — it's
 * stateless besides the closures it captures) shaped:
 *
 *   {
 *     panelConfig: { key: "control"|"loader", stateProp, catalog,
 *                    allowAuto, reorder, addLabel },
 *     doc: document,                    // or a stub, under test
 *     getKnownLists(): {sampler, scheduler, unet, vae, clip},  // live node-def reads
 *     describeLinkTarget(link): {...} | null,  // browser/graph-specific; see index.js
 *     confirmRemove(row): boolean,      // window.confirm wrapper (or a no-op under test)
 *   }
 *
 * `getKnownLists`/`describeLinkTarget` are the only two places this whole
 * feature needs `window.LiteGraph`/`node.graph` — kept OUT of this file
 * (and out of `rows.mjs`) so both stay testable with a stub.
 *
 * ## Why row DOM is rebuilt on a KIND/COUNT/ORDER change but only PAINTED
 * on a value edit
 *
 * A row's `id` is stable for its whole lifetime; its `kind` only changes
 * once (an `"auto"` row resolving on first connection — `rows.mjs`'s
 * `applyResolvedKind` mutates the SAME row object in place, it does not
 * replace it). But the DOM STRUCTURE a row needs differs by kind (an
 * unresolved `auto` row has no value area at all; a resolved `int` row
 * needs a fill + drag wiring it never had before) — so `syncRows` computes
 * a cheap `id:kind` signature of the whole row list and only tears down /
 * rebuilds DOM+listeners when that signature changes (add/remove/reorder/
 * kind-resolve). A plain value edit (seed roll, list pick, numeric drag,
 * latent dims) never changes the signature, so it only calls `paintRow` —
 * which is why an open ⚙ popover survives its own field's edits (see
 * `render.mjs`'s top doc comment: popovers are separate `document.body`
 * overlays, never children of the row DOM widget being repainted/rebuilt).
 *
 * ## Reorder is NOT a "structural" rebuild while it's happening
 *
 * Dragging a row would trip the `id:kind` signature check on every pointer
 * move (order changed) and blow away the very row (and its pointer capture)
 * being dragged. So `wireGrip`'s drag loop reorders `node.widgets` and
 * `node._ctrlRows` directly (`applyReorderLive`, no DOM rebuild) on every
 * move, and only updates the cached signature (skipping a redundant
 * rebuild, since the DOM already matches) once the drag ends.
 */

import {
  KIND_META,
  MAX_ROWS,
  ZW,
  VACANT_SLOT_TYPE,
  AFTER_MODES,
  UNET_DTYPES,
  CLIP_TYPES,
  CLIP_DEVICES,
  UNET_NAME_CANDIDATES,
  preferredNameDefault,
  RATIOS,
  TIERS,
  NODE_DEF_SOURCE,
  isPickerKind,
  normalizeState,
  defaultState,
  addRow,
  duplicateRow,
  removeRow,
  reorderRows,
  planHoleCompaction,
  clampSeedString,
  randomSeedString,
  clampNumeric,
  rangeOf,
  dimsFor,
  snap16,
  outputTypeForRow,
  resolveAutoKind,
  applyResolvedKind,
  commitRename,
  defaultSlotLabel,
  stripZeroWidthEdges,
  isBlankSlotLabel,
  menuMetaFor,
} from "./rows.mjs";

import {
  injectStyles,
  buildRowElement,
  buildAddRow,
  buildNameInput,
  paintRow,
  bodyHeight,
  ROW_H,
  ROW_GAP,
  MIN_W,
  DEFAULT_W,
} from "./render.mjs";

// Wheel-zooms-the-canvas-through-a-DOM-widget fix (Classic renderer only,
// no-ops under Nodes 2.0) -- see js/shared/canvas_zoom.mjs's top doc
// comment. A plain relative import, not a guarded dynamic one: unlike
// `render.mjs`'s THEME_URL (an absolute `/extensions/...` server route),
// this sibling module has zero `app`/`window`/`LiteGraph` reference at
// module scope, so it's just as importable under plain `node` as
// `rows.mjs`/`render.mjs` already are -- no 404 risk. `isVueNodes` (same
// module) is reused below by `onResizeControls`, for the identical "this
// mechanism is legacy-litegraph-only" reason.
import { installCanvasZoomPassthrough, isVueNodes } from "../shared/canvas_zoom.mjs";
// Duck-typed size-pair check -- `node.size` on a live litegraph node is a
// Float64Array VIEW over a Rectangle, NOT a plain Array
// (`Array.isArray(node.size) === false`, measured live); every size guard in
// this file uses this instead of `Array.isArray` so it actually fires on the
// real object, not just on a test stub's plain-array `size`. See
// `../shared/size.mjs`'s own top doc comment for the full story.
import { isSizeLike } from "../shared/size.mjs";
// The "Wheel quiet period (ms)" setting (`js/shared/settings.mjs`) -- read
// LIVE, on every wheel event, via `installCanvasZoomPassthrough`'s own
// `options.getLockMs` (see that function's doc comment). Same "plain
// relative import, zero app/window reference at module scope" reasoning as
// the import right above it.
import { getSetting, SETTING_IDS, SETTING_DEFAULTS } from "../shared/settings.mjs";

// FLIP drag-reorder settle animation -- the track-agnostic capture/inverse-
// transform/settle core, shared with `lora_interaction.mjs` (which ported
// it here first; see `js/shared/flip.mjs`'s own top doc comment for why the
// core lives there and what differs between the two tracks). Plain relative
// import, same reasoning as `size.mjs`/`settings.mjs` above -- zero `app`/
// `window`/`LiteGraph` reference at module scope.
import { captureRowTops as sharedCaptureRowTops, flipRows as sharedFlipRows } from "../shared/flip.mjs";

// Shared `options` object for every `installCanvasZoomPassthrough` call in
// this file (both below) -- `getLockMs` itself still resolves the setting
// FRESH on every wheel event (it's a closure calling `getSetting` live,
// never a captured value), so sharing this one object across installs costs
// nothing and isn't a "captured once" shortcut.
const WHEEL_LOCK_OPTIONS = {
  getLockMs: () => getSetting(SETTING_IDS.WHEEL_QUIET_PERIOD_MS, SETTING_DEFAULTS[SETTING_IDS.WHEEL_QUIET_PERIOD_MS]),
};

// The single-overlay-at-a-time bookkeeping + toggle primitive (ownerKey) --
// EXTRACTED to js/shared/overlay.mjs while building js/anima/ so both
// tracks share one implementation rather than a fork (see that module's top
// doc comment, and docs/generator-design.md §12). `closeActiveOverlay`/
// `closeOverlayIfOwnedBy` are used exactly as before; `openOverlayWithZoom`
// below is a thin wrapper that keeps this file's existing call-site
// signature (`ctx` first, not a bare `getCanvasEl`) and this pack's own
// `"wtn-ctl-overlay wtn"` CSS hook, so nothing downstream of this import
// had to change.
import {
  activeOverlayRef,
  closeActiveOverlay,
  closeOverlayIfOwnedBy,
  openOverlayWithZoom as sharedOpenOverlayWithZoom,
} from "../shared/overlay.mjs";

export { closeActiveOverlay };

// ---------------------------------------------------------------------------
// State <-> hidden widget handshake (per the dynamic-node-frontend skill:
// a DECLARED, natively-serialized STRING widget -- never graphToPrompt
// injection -- mirrored into node.properties as the live working copy).
// ---------------------------------------------------------------------------

export function getStateWidget(node) {
  return (node.widgets || []).find((w) => w.name === "panel_state");
}

function parseWidgetValue(node) {
  const w = getStateWidget(node);
  if (!w || !w.value) {
    return null;
  }
  try {
    return JSON.parse(w.value);
  } catch {
    return null;
  }
}

/** Whether `raw` (the parsed widget JSON, or garbage) already carries an
 * explicit `rows` array — the one bit `resolveState`/`ensureState`/
 * `restoreStateFromWidget` all need to agree on (see their doc comments). */
function hasSavedRows(raw) {
  return !!(raw && typeof raw === "object" && Array.isArray(raw.rows));
}

/**
 * `defaultState(panelKind)` if `raw` has no `rows` ARRAY at all (a brand
 * new node: Python's declared widget default is the literal string `"{}"`,
 * which parses to `{}` — no `rows` key whatsoever), else
 * `normalizeState(raw, panelKind)`. This distinction matters: the Loader
 * Panel's default state pre-populates its three fixed loaders (design doc
 * §3 — an empty loader panel has nothing useful to emit), but a user who
 * genuinely empties a panel down to zero rows persists an EXPLICIT
 * `{version:1, rows:[]}`, which must stay empty rather than silently
 * re-populating on the next reload.
 */
function resolveState(raw, panelKind) {
  if (hasSavedRows(raw)) {
    return normalizeState(raw, panelKind);
  }
  return defaultState(panelKind);
}

/** Mirror `state` into the hidden `panel_state` widget's `.value` -- the
 * only thing that actually reaches `nodes/controls/*.py` / survives into
 * `widgets_values`. Private: `persistState` (below) is the public "persist
 * after a mutation" entry point; `ensureState`/`restoreStateFromWidget` call
 * this directly (never `persistState`, which would recurse back into
 * `ensureState`) for the one case they themselves need to write. */
function writeStateToWidget(node, state) {
  const w = getStateWidget(node);
  if (w) {
    w.value = JSON.stringify(state);
  }
}

/** The live working state for `node`, initializing it from the hidden
 * widget's CURRENT value the first time (a brand-new node, or one whose
 * `node.properties` was cleared) — never re-parses on subsequent calls, so
 * row object identities stay stable across repeated calls in the same
 * session (this is what lets `applyResolvedKind` mutate a row in place and
 * have every existing DOM ref immediately see it).
 *
 * If the widget's raw value had NO `rows` array yet (`!hasSavedRows` --
 * Python's literal `"{}"` default on a brand-new node), the materialized
 * default is written straight back to the widget before returning. Without
 * this, a freshly-placed Loader Panel builds 3 real rows in the UI but the
 * `panel_state` widget itself keeps carrying `"{}"` — `nodes/controls/
 * *.py`'s `rows_by_slot` finds nothing in that, so every output would
 * silently emit 0 the first time this node is ever queued, and nothing
 * survives a save (the widget is what serializes). Never fires for a
 * genuinely emptied panel: that state already has an explicit `rows: []`,
 * which `hasSavedRows` treats as "already saved" and skips entirely -- this
 * never resurrects a row the user deliberately removed. */
export function ensureState(node, ctx) {
  if (!node.properties) {
    node.properties = {};
  }
  const prop = ctx.panelConfig.stateProp;
  const existing = node.properties[prop];
  if (existing && Array.isArray(existing.rows)) {
    return existing;
  }
  const raw = parseWidgetValue(node);
  const state = resolveState(raw, ctx.panelConfig.key);
  node.properties[prop] = state;
  if (!hasSavedRows(raw)) {
    writeStateToWidget(node, state);
  }
  return state;
}

/** FORCE a fresh parse of the hidden widget's value into `node.properties`
 * -- called from `onConfigure` (after litegraph has restored the real saved
 * `widgets_values`, including this exact widget) so a restored workflow's
 * rows/slots are rebuilt from what was actually saved, not whatever
 * `ensureState` may have already defaulted to during `onNodeCreated`. Same
 * "write the materialized default back if the raw value had no `rows`"
 * contract as `ensureState` above, for the same reason. */
export function restoreStateFromWidget(node, ctx) {
  const raw = parseWidgetValue(node);
  const state = resolveState(raw, ctx.panelConfig.key);
  if (!node.properties) {
    node.properties = {};
  }
  node.properties[ctx.panelConfig.stateProp] = state;
  if (!hasSavedRows(raw)) {
    writeStateToWidget(node, state);
  }
  return state;
}

/** Mirror the CURRENT state into the hidden widget's `.value` -- call after
 * EVERY mutation (per the skill's contract: this is what actually reaches
 * `nodes/controls/*.py` and what persists into `widgets_values`). */
export function persistState(node, ctx) {
  const state = ensureState(node, ctx);
  writeStateToWidget(node, state);
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
  return state;
}

export function rowCountOf(node, ctx) {
  return ensureState(node, ctx).rows.length;
}

// ---------------------------------------------------------------------------
// Small local DOM helper (mirrors render.mjs's own `el` -- kept private
// here too rather than exported/shared, per this pack's existing split).
// ---------------------------------------------------------------------------

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

function winOf(ctx) {
  return (ctx && ctx.doc && ctx.doc.defaultView) || (typeof window !== "undefined" ? window : null);
}

// ---------------------------------------------------------------------------
// `openOverlayWithZoom` -- thin wrapper over the shared primitive (see this
// file's import comment above): keeps this module's existing `ctx`-first
// call signature and this pack's own `"wtn-ctl-overlay wtn"` CSS hook, which
// `test_resize.mjs` asserts on. Wheel-zoom passthrough on the overlay
// element itself is the shared function's job -- ONE choke point for every
// overlay this node ever opens (option list, ⚙ popover, row context menu,
// add-catalog menu), so wheeling over any of them zooms the canvas same as
// wheeling over a row, EXCEPT over a genuinely scrollable child that still
// has room (the option list's own `.wtn-ctl-menu`/the latent popover's
// `.wtn-ctl-reslist`, both `overflow-y: auto`). `ctx.getCanvasEl` is
// `index.js`'s real `app.canvas.canvas` getter (or `undefined` under test).
function openOverlayWithZoom(ctx, doc, anchorEl, contentEl, placement, onClose) {
  return sharedOpenOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, contentEl, placement, onClose, "wtn-ctl-overlay wtn");
}

function optionListFor(ctx, kind) {
  const lists = ctx.getKnownLists ? ctx.getKnownLists() : {};
  return Array.isArray(lists[kind]) ? lists[kind] : [];
}

/** Persist + repaint (cheap path — see this module's top doc comment: never
 * touches row DOM structure, so it's safe to call from inside an open
 * popover's own field handlers). */
function afterEdit(node, ctx) {
  persistState(node, ctx);
  repaintRows(node, ctx);
  syncOutputs(node, ctx);
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

// ---------------------------------------------------------------------------
// Row-kind-specific wiring
// ---------------------------------------------------------------------------

/** `rowId` only -- never a captured `row` object. Every mutation below
 * re-resolves the CURRENT row from `ensureState(node, ctx).rows` at the
 * moment the handler actually fires, mirroring `lora_interaction.mjs`'s own
 * `wireGrip`/`openNamePickerFor`/etc (see this module's top doc comment for
 * why: `node.properties[stateProp]` can be swapped out from under an
 * already-wired row -- measured live, `sameObject=false` with the id
 * preserved -- and closing over the OLD row object silently mutates a
 * detached copy `persistState` never serializes). A row that no longer
 * exists (removed while this control was open) is a safe no-op, never a
 * throw. */
function wireComboRow(node, ctx, rowId, refs) {
  const cycle = (dir) => {
    const state = ensureState(node, ctx);
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return; // row vanished out from under this control -- nothing to cycle
    }
    const list = optionListFor(ctx, row.kind);
    if (!list.length) {
      return;
    }
    const idx = Math.max(0, list.indexOf(row.value));
    row.value = list[(idx + dir + list.length) % list.length];
    afterEdit(node, ctx);
    // The ◀/▶ steppers must NEVER open the menu (that's `refs.combo`'s job
    // alone), but if THIS row's own list menu happens to be open, stepping
    // the value closes it too -- never leaves a now-stale selection
    // highlighted in an overlay still open behind the click.
    closeOverlayIfOwnedBy(`list:${rowId}`);
  };
  refs.stepLeft.addEventListener("click", (e) => {
    e.stopPropagation();
    cycle(-1);
  });
  refs.stepRight.addEventListener("click", (e) => {
    e.stopPropagation();
    cycle(1);
  });
  refs.combo.addEventListener("click", (e) => {
    e.stopPropagation();
    openListMenuFor(node, ctx, rowId, refs);
  });
}

/** Opens (or, on a second click of the SAME field, closes) this row's
 * option-list menu -- see `closeOverlayIfOwnedBy`'s doc comment for why the
 * toggle has to be decided HERE rather than left to the outside-click
 * dismiss listener. Resolves `row` live from `rowId` both when the menu is
 * BUILT (so it reflects whatever's actually live right now, never a stale
 * closure) and AGAIN inside each option's own click (in case the row was
 * removed -- or the state object swapped -- while the menu sat open); either
 * miss is a safe no-op, never a throw. */
function openListMenuFor(node, ctx, rowId, refs) {
  const key = `list:${rowId}`;
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this field's own menu was open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT field's overlay was open -- switch to this one
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return; // row vanished out from under this control -- nothing to show
  }
  const doc = ctx.doc;
  const list = optionListFor(ctx, row.kind);
  const menu = el(doc, "div", "wtn-ctl-menu wtn");
  if (!list.length) {
    const empty = el(doc, "div", "wtn-ctl-mhead");
    empty.textContent = `${(NODE_DEF_SOURCE[row.kind] && NODE_DEF_SOURCE[row.kind].className) || row.kind} not installed`;
    menu.appendChild(empty);
  }
  list.forEach((opt) => {
    const optEl = el(doc, "div", `wtn-ctl-opt${opt === row.value ? " wtn-ctl-sel" : ""}`);
    optEl.textContent = opt;
    optEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const liveState = ensureState(node, ctx);
      const liveRow = liveState.rows.find((r) => r.id === rowId);
      closeActiveOverlay();
      if (!liveRow) {
        return; // row vanished while the menu was open -- nothing to write
      }
      liveRow.value = opt;
      afterEdit(node, ctx);
    });
    menu.appendChild(optEl);
  });
  const handle = openOverlayWithZoom(ctx, doc, refs.root, menu, "below", () => {
    refs.root.classList.remove("wtn-ctl-open");
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  });
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
  refs.root.classList.add("wtn-ctl-open");
}

function wireSeedRow(node, ctx, rowId, refs) {
  refs.modeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const state = ensureState(node, ctx);
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return;
    }
    if (row.opts.after === "fixed") {
      row.opts.after = AFTER_MODES.includes(row.opts.lastMode) ? row.opts.lastMode : "randomize";
    } else {
      row.opts.lastMode = row.opts.after;
      row.opts.after = "fixed";
    }
    afterEdit(node, ctx);
  });
  refs.newBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const state = ensureState(node, ctx);
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return;
    }
    row.value = randomSeedString();
    if (row.opts.after !== "fixed") {
      row.opts.lastMode = row.opts.after;
      row.opts.after = "fixed";
    }
    afterEdit(node, ctx);
  });
  if (refs.reuseBtn) {
    refs.reuseBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const state = ensureState(node, ctx);
      const row = state.rows.find((r) => r.id === rowId);
      if (!row) {
        return;
      }
      // Guarded even though paintRow already hides this button for the same
      // condition (render.mjs's seed branch) -- a stray click racing a
      // repaint that hasn't landed yet must never resurrect a `lastUsed`
      // that was never actually set.
      if (row.opts.lastUsed == null) {
        return;
      }
      row.value = row.opts.lastUsed;
      // Same "record lastMode before pinning to fixed" contract as newBtn
      // above, so the mode button's own toggle (wireSeedRow's first
      // listener) still resumes the RIGHT mode afterward.
      if (row.opts.after !== "fixed") {
        row.opts.lastMode = row.opts.after;
        row.opts.after = "fixed";
      }
      afterEdit(node, ctx);
    });
  }
}

function wireNumericRow(node, ctx, rowId, refs) {
  let dragging = false;
  const setFromClientX = (clientX) => {
    const state = ensureState(node, ctx);
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return; // row vanished mid-drag -- nothing left to set
    }
    const rect = typeof refs.root.getBoundingClientRect === "function" ? refs.root.getBoundingClientRect() : null;
    if (!rect || !Number.isFinite(rect.width) || rect.width <= 0) {
      return;
    }
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const [min, max] = rangeOf(row.opts);
    row.value = clampNumeric(row.kind, min + pct * (max - min), row.opts);
    paintRow(refs, row, null, null);
    if (typeof node.setDirtyCanvas === "function") {
      node.setDirtyCanvas(true, true);
    }
  };
  refs.root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) {
      return;
    }
    // Also bail while the row's name is mid-rename-edit -- a pointerdown to
    // position the caret/select text inside the edit box must never also
    // start a whole-row value drag (the gear guard below is the same
    // pattern for a gear-having kind, kept generic since int/float have
    // neither gear nor -- until now -- an in-row input).
    if (typeof e.target.closest === "function" && (e.target.closest(".wtn-ctl-gear") || e.target.closest(".wtn-ctl-name-edit"))) {
      return;
    }
    e.preventDefault();
    dragging = true;
    if (typeof refs.root.setPointerCapture === "function") {
      refs.root.setPointerCapture(e.pointerId);
    }
    setFromClientX(e.clientX);
  });
  refs.root.addEventListener("pointermove", (e) => {
    if (dragging) {
      setFromClientX(e.clientX);
    }
  });
  const stop = () => {
    if (dragging) {
      dragging = false;
      afterEdit(node, ctx);
    }
  };
  refs.root.addEventListener("pointerup", stop);
  refs.root.addEventListener("pointercancel", stop);
}

/** Clicking a `bool` row's switch (`render.mjs`'s `refs.switchEl`, `js/
 * shared/fields.mjs`'s `buildSwitch`) flips the value and persists/repaints.
 * `rowId` only, never a captured `row` -- resolves the CURRENT row from
 * state at fire-time, same contract as every other `wireX` function in this
 * file (this module's top doc comment; `lora_interaction.mjs`'s own switches
 * are the reference for this exact pattern). */
function wireBoolRow(node, ctx, rowId, refs) {
  if (!refs.switchEl) {
    return;
  }
  refs.switchEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const state = ensureState(node, ctx);
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return; // row vanished out from under this control -- nothing to flip
    }
    row.value = !row.value;
    afterEdit(node, ctx);
  });
}

// ---------------------------------------------------------------------------
// ⚙ popovers (seed / latent / unet / clip -- int/float/vae/sampler/scheduler
// have `hasGear: false` in rows.mjs's KIND_META, so wireRow never calls
// wireGear for them).
// ---------------------------------------------------------------------------

function popFooter(doc, node, ctx, row, onDone) {
  const foot = el(doc, "div", "wtn-ctl-popfoot");
  const done = el(doc, "button", "wtn-ctl-pbtn");
  done.type = "button";
  done.textContent = "Done";
  done.addEventListener("click", (e) => {
    e.stopPropagation();
    onDone();
  });
  const remove = el(doc, "button", "wtn-ctl-pbtn wtn-ctl-danger");
  remove.type = "button";
  remove.textContent = "Remove row";
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onDone();
    removeRowAndSync(node, ctx, row.id);
  });
  foot.appendChild(done);
  foot.appendChild(remove);
  return foot;
}

function buildSeedPopover(doc, node, ctx, row, closeFn) {
  const root = el(doc, "div", "wtn-ctl-pop wtn");
  const h = el(doc, "h4");
  h.textContent = "Seed";
  root.appendChild(h);

  const afterField = el(doc, "div", "wtn-ctl-field");
  const afterLabel = el(doc, "span");
  afterLabel.textContent = "after run";
  const afterSel = el(doc, "select");
  AFTER_MODES.forEach((m) => {
    const o = el(doc, "option");
    o.value = m;
    o.textContent = m;
    if (m === row.opts.after) {
      o.selected = true;
    }
    afterSel.appendChild(o);
  });
  afterSel.addEventListener("change", () => {
    row.opts.after = afterSel.value;
    if (afterSel.value !== "fixed") {
      row.opts.lastMode = afterSel.value;
    }
    afterEdit(node, ctx);
  });
  afterField.appendChild(afterLabel);
  afterField.appendChild(afterSel);

  const valField = el(doc, "div", "wtn-ctl-field");
  const valLabel = el(doc, "span");
  valLabel.textContent = "value";
  const valInput = el(doc, "input");
  valInput.type = "text";
  valInput.value = row.value;
  valInput.addEventListener("change", () => {
    row.value = clampSeedString(valInput.value);
    valInput.value = row.value;
    afterEdit(node, ctx);
  });
  valField.appendChild(valLabel);
  valField.appendChild(valInput);

  root.appendChild(afterField);
  root.appendChild(valField);
  root.appendChild(popFooter(doc, node, ctx, row, closeFn));
  return root;
}

function buildLatentPopover(doc, node, ctx, row, closeFn) {
  const root = el(doc, "div", "wtn-ctl-pop wtn-ctl-wide wtn");
  const h = el(doc, "h4");
  h.textContent = "Empty latent";
  root.appendChild(h);

  const seg = el(doc, "div", "wtn-ctl-seg");
  const customBtn = el(doc, "button");
  customBtn.type = "button";
  customBtn.textContent = "Custom";
  const predefBtn = el(doc, "button");
  predefBtn.type = "button";
  predefBtn.textContent = "Predefined";
  seg.appendChild(customBtn);
  seg.appendChild(predefBtn);
  root.appendChild(seg);

  const mid = el(doc, "div");
  root.appendChild(mid);

  const batchField = el(doc, "div", "wtn-ctl-field");
  const batchLabel = el(doc, "span");
  batchLabel.textContent = "batch";
  const batchInput = el(doc, "input");
  batchInput.type = "text";
  batchInput.value = row.opts.batch;
  batchInput.addEventListener("change", () => {
    const n = parseInt(batchInput.value, 10);
    row.opts.batch = Number.isFinite(n) && n >= 1 ? n : 1;
    batchInput.value = row.opts.batch;
    afterEdit(node, ctx);
  });
  batchField.appendChild(batchLabel);
  batchField.appendChild(batchInput);
  root.appendChild(batchField);
  root.appendChild(popFooter(doc, node, ctx, row, closeFn));

  function renderMid() {
    while (mid.firstChild) {
      mid.removeChild(mid.firstChild);
    }
    customBtn.className = row.opts.mode === "custom" ? "wtn-ctl-on" : "";
    predefBtn.className = row.opts.mode === "predefined" ? "wtn-ctl-on" : "";

    if (row.opts.mode === "custom") {
      const wh = el(doc, "div", "wtn-ctl-wh");
      const wLabel = el(doc, "label");
      wLabel.textContent = "width";
      const wInput = el(doc, "input");
      wInput.type = "text";
      wInput.value = row.opts.w;
      wInput.addEventListener("change", () => {
        const n = parseInt(wInput.value, 10);
        row.opts.w = Number.isFinite(n) ? snap16(Math.max(16, n)) : row.opts.w;
        wInput.value = row.opts.w;
        afterEdit(node, ctx);
      });
      wLabel.appendChild(wInput);
      const hLabel = el(doc, "label");
      hLabel.textContent = "height";
      const hInput = el(doc, "input");
      hInput.type = "text";
      hInput.value = row.opts.h;
      hInput.addEventListener("change", () => {
        const n = parseInt(hInput.value, 10);
        row.opts.h = Number.isFinite(n) ? snap16(Math.max(16, n)) : row.opts.h;
        hInput.value = row.opts.h;
        afterEdit(node, ctx);
      });
      hLabel.appendChild(hInput);
      wh.appendChild(wLabel);
      wh.appendChild(hLabel);
      mid.appendChild(wh);
    } else {
      const grid = el(doc, "div", "wtn-ctl-ratios");
      RATIOS.forEach(([name, w, hgt]) => {
        const b = el(doc, "div", `wtn-ctl-rbtn${name === row.opts.ratio ? " wtn-ctl-on" : ""}`);
        const ic = el(doc, "span", "wtn-ctl-ic");
        const [iw, ih] = w === hgt ? [9, 9] : w > hgt ? [12, 8] : [8, 12];
        ic.style.width = `${iw}px`;
        ic.style.height = `${ih}px`;
        b.appendChild(ic);
        const label = el(doc, "span");
        label.textContent = name;
        b.appendChild(label);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          row.opts.ratio = name;
          [row.opts.w, row.opts.h] = dimsFor(row.opts.ratio, row.opts.tier);
          afterEdit(node, ctx);
          renderMid();
        });
        grid.appendChild(b);
      });
      mid.appendChild(grid);

      const list = el(doc, "div", "wtn-ctl-reslist");
      TIERS.forEach((tier) => {
        const [w, hgt] = dimsFor(row.opts.ratio, tier);
        const r = el(doc, "div", `wtn-ctl-res${tier === row.opts.tier ? " wtn-ctl-on" : ""}`);
        r.textContent = `${w} × ${hgt}`;
        r.addEventListener("click", (e) => {
          e.stopPropagation();
          row.opts.tier = tier;
          [row.opts.w, row.opts.h] = dimsFor(row.opts.ratio, row.opts.tier);
          afterEdit(node, ctx);
          renderMid();
        });
        list.appendChild(r);
      });
      mid.appendChild(list);
    }
  }

  customBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    row.opts.mode = "custom";
    afterEdit(node, ctx);
    renderMid();
  });
  predefBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    row.opts.mode = "predefined";
    afterEdit(node, ctx);
    renderMid();
  });

  renderMid();
  return root;
}

function buildUnetPopover(doc, node, ctx, row, closeFn) {
  const root = el(doc, "div", "wtn-ctl-pop wtn");
  const h = el(doc, "h4");
  h.textContent = "UNET loader";
  root.appendChild(h);

  const field = el(doc, "div", "wtn-ctl-field");
  const label = el(doc, "span");
  label.textContent = "dtype";
  const sel = el(doc, "select");
  UNET_DTYPES.forEach((d) => {
    const o = el(doc, "option");
    o.value = d;
    o.textContent = d;
    if (d === row.opts.weight_dtype) {
      o.selected = true;
    }
    sel.appendChild(o);
  });
  sel.addEventListener("change", () => {
    row.opts.weight_dtype = sel.value;
    afterEdit(node, ctx);
  });
  field.appendChild(label);
  field.appendChild(sel);
  root.appendChild(field);
  root.appendChild(popFooter(doc, node, ctx, row, closeFn));
  return root;
}

function buildClipPopover(doc, node, ctx, row, closeFn) {
  const root = el(doc, "div", "wtn-ctl-pop wtn");
  const h = el(doc, "h4");
  h.textContent = "CLIP loader";
  root.appendChild(h);

  const typeField = el(doc, "div", "wtn-ctl-field");
  const typeLabel = el(doc, "span");
  typeLabel.textContent = "type";
  const typeSel = el(doc, "select");
  CLIP_TYPES.forEach((t) => {
    const o = el(doc, "option");
    o.value = t;
    o.textContent = t;
    if (t === row.opts.type) {
      o.selected = true;
    }
    typeSel.appendChild(o);
  });
  typeSel.addEventListener("change", () => {
    row.opts.type = typeSel.value;
    afterEdit(node, ctx);
  });
  typeField.appendChild(typeLabel);
  typeField.appendChild(typeSel);

  const devField = el(doc, "div", "wtn-ctl-field");
  const devLabel = el(doc, "span");
  devLabel.textContent = "device";
  const devSel = el(doc, "select");
  CLIP_DEVICES.forEach((d) => {
    const o = el(doc, "option");
    o.value = d;
    o.textContent = d;
    if (d === row.opts.device) {
      o.selected = true;
    }
    devSel.appendChild(o);
  });
  devSel.addEventListener("change", () => {
    row.opts.device = devSel.value;
    afterEdit(node, ctx);
  });
  devField.appendChild(devLabel);
  devField.appendChild(devSel);

  root.appendChild(typeField);
  root.appendChild(devField);
  root.appendChild(popFooter(doc, node, ctx, row, closeFn));
  return root;
}

function wireGear(node, ctx, rowId, refs) {
  if (!refs.gear) {
    return;
  }
  refs.gear.addEventListener("click", (e) => {
    e.stopPropagation();
    openGearPopover(node, ctx, rowId, refs);
  });
}

/** Opens (or, on a second click of the SAME row's ⚙, closes) that row's
 * settings popover -- same toggle contract as `openListMenuFor` above.
 * Resolves `row` live from `rowId` right before building the popover, so its
 * content (and every field handler closing over this SAME row object) is
 * bound to whatever `ensureState` actually serializes right now, never a
 * stale closure. A row that's vanished by the time the ⚙ is clicked is a
 * safe no-op -- no popover opens at all. */
function openGearPopover(node, ctx, rowId, refs) {
  const key = `gear:${rowId}`;
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this row's own popover was open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT overlay was open -- switch to this one
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return; // row vanished out from under this control -- nothing to show
  }
  const doc = ctx.doc;
  const closeFn = () => closeActiveOverlay();
  let content = null;
  if (row.kind === "seed") {
    content = buildSeedPopover(doc, node, ctx, row, closeFn);
  } else if (row.kind === "latent") {
    content = buildLatentPopover(doc, node, ctx, row, closeFn);
  } else if (row.kind === "unet") {
    content = buildUnetPopover(doc, node, ctx, row, closeFn);
  } else if (row.kind === "clip") {
    content = buildClipPopover(doc, node, ctx, row, closeFn);
  }
  if (!content) {
    return;
  }
  const handle = openOverlayWithZoom(ctx, doc, refs.root, content, "right", () => {
    refs.gear.classList.remove("wtn-ctl-active");
    refs.root.classList.remove("wtn-ctl-open");
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  });
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
  refs.gear.classList.add("wtn-ctl-active");
  refs.root.classList.add("wtn-ctl-open");
}

// ---------------------------------------------------------------------------
// Rename -- inline edit of a row's .wtn-ctl-name label. Triggered from the
// row's right-click menu (the discoverable path, wired in
// openContextMenuFor below) or a double-click on the label itself (the fast
// path, wireRename). Applies to EVERY row kind, not just int/float -- the
// label is shown on all of them, and int/float are simply the two kinds
// that otherwise have NO way to rename at all, since they deliberately have
// no ⚙ (design doc §3: their range/step/value are adopted from the first
// wire).
// ---------------------------------------------------------------------------

/** Swap `refs.name` for a themed `<input>` pre-filled with the row's current
 * name, focused with its text selected. Enter/blur commit (trim, cap,
 * empty-falls-back-to-the-kind's-default via `commitRename`, then
 * `row.renamed = true` so a later auto-resolve connection never stomps it —
 * see rows.mjs's `applyResolvedKind`); Escape reverts the label and persists
 * nothing. A no-op if this row is already mid-edit. */
function beginRename(node, ctx, row, refs) {
  if (refs.nameInput) {
    return;
  }
  closeActiveOverlay();
  const doc = ctx.doc;
  const parent = refs.name.parentNode;
  if (!parent) {
    return;
  }
  const input = buildNameInput(doc, row.name || row.kind);
  parent.insertBefore(input, refs.name);
  parent.removeChild(refs.name);
  refs.nameInput = input;

  // Order matters: null the ref BEFORE touching the DOM -- a real browser
  // can fire `blur` reentrantly the moment `end()` itself removes the
  // (still-focused) input, and that must never re-run commit()/cancel().
  const end = () => {
    if (!refs.nameInput) {
      return;
    }
    refs.nameInput = null;
    refs.name.textContent = row.name || row.kind;
    const p = input.parentNode;
    if (p) {
      p.insertBefore(refs.name, input);
      p.removeChild(input);
    }
  };
  const commit = () => {
    if (!refs.nameInput) {
      return;
    }
    commitRename(row, input.value);
    end();
    afterEdit(node, ctx);
  };
  const cancel = () => {
    end();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.stopPropagation();
      commit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
  });
  input.addEventListener("blur", () => {
    commit();
  });
  // Positioning the caret / selecting text inside the box must never bubble
  // into the row's own click/pointerdown handling (numeric row's whole-row
  // drag-to-set, in particular -- see wireNumericRow's own guard).
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());

  if (typeof input.focus === "function") {
    input.focus();
  }
  if (typeof input.select === "function") {
    input.select();
  }
}

/** The fast path: double-click the label itself (the menu item in
 * openContextMenuFor is the discoverable path to the same `beginRename`).
 * Resolves `row` live from `rowId` at the moment the dblclick actually fires
 * -- a row removed since this listener was wired is a safe no-op. */
function wireRename(node, ctx, rowId, refs) {
  refs.name.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    const state = ensureState(node, ctx);
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return;
    }
    beginRename(node, ctx, row, refs);
  });
}

// ---------------------------------------------------------------------------
// Right-click menu: Rename + Duplicate + Remove row -- Remove is the ONLY
// removal path for a row with no ⚙ (int/float/sampler/scheduler/vae), so
// it isn't optional; Rename is the discoverable path for every kind (see
// the section above).
// ---------------------------------------------------------------------------

function wireContextMenu(node, ctx, rowId, refs) {
  refs.root.addEventListener("contextmenu", (e) => {
    if (typeof e.preventDefault === "function") {
      e.preventDefault();
    }
    e.stopPropagation();
    openContextMenuFor(node, ctx, rowId, refs);
  });
}

/** Opens (or, on a second right-click of the SAME row, closes) that row's
 * right-click menu -- same toggle contract as `openListMenuFor`/
 * `openGearPopover` above (this one WAS already sharing the same
 * unconditional close-then-reopen bug, confirmed by inspection: nothing
 * about `contextmenu` made it any different from `click`). Resolves `row`
 * live from `rowId` before building the menu -- a row removed by the time
 * this fires is a safe no-op, no menu opens. */
function openContextMenuFor(node, ctx, rowId, refs) {
  const key = `context:${rowId}`;
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this row's own context menu was open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT overlay was open -- switch to this one
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return; // row vanished out from under this control -- nothing to show
  }
  const doc = ctx.doc;
  const menu = el(doc, "div", "wtn-ctl-menu wtn");
  const head = el(doc, "div", "wtn-ctl-mhead");
  head.textContent = row.name || row.kind;
  menu.appendChild(head);

  const rename = el(doc, "div", "wtn-ctl-opt");
  rename.textContent = "Rename";
  rename.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
    const liveState = ensureState(node, ctx);
    const liveRow = liveState.rows.find((r) => r.id === rowId);
    if (!liveRow) {
      return;
    }
    beginRename(node, ctx, liveRow, refs);
  });
  menu.appendChild(rename);

  const dup = el(doc, "div", "wtn-ctl-opt");
  dup.textContent = "Duplicate";
  const hint = el(doc, "span", "wtn-ctl-hint");
  hint.textContent = "new slot";
  dup.appendChild(hint);
  dup.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
    duplicateRowAndSync(node, ctx, rowId);
  });
  menu.appendChild(dup);

  const del = el(doc, "div", "wtn-ctl-opt");
  del.textContent = "Remove row";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
    removeRowAndSync(node, ctx, rowId);
  });
  menu.appendChild(del);

  const handle = openOverlayWithZoom(ctx, doc, refs.root, menu, "below", () => {
    refs.root.classList.remove("wtn-ctl-open");
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  });
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
  refs.root.classList.add("wtn-ctl-open");
}

// ---------------------------------------------------------------------------
// Drag-to-reorder grip (Control Panel only -- render.mjs only builds a grip
// when `panelConfig.reorder` is true).
// ---------------------------------------------------------------------------

// Matches render.mjs's own '.wtn-row-flip' transition duration (.18s) plus a
// small buffer -- long enough that the class is never removed WHILE the
// transition it enables is still visibly running (same constant, same
// reasoning, as `lora_interaction.mjs`'s identical `FLIP_SETTLE_MS`).
const FLIP_SETTLE_MS = 200;

function ctrlRowEl(entry) {
  return entry && entry.refs && entry.refs.root;
}

/** Every currently-mounted row's CURRENT top position, keyed by row id --
 * call this BEFORE mutating `node._ctrlRows`' order, so `flipRows` (below)
 * has an "old" position to diff the "new" one against. Thin wrapper over
 * `js/shared/flip.mjs`'s track-agnostic core -- exported for direct
 * testability, matching `lora_interaction.mjs`'s identical pair. */
export function captureRowTops(node) {
  return sharedCaptureRowTops(node._ctrlRows, ctrlRowEl);
}

/**
 * Call AFTER a reorder has been applied (`applyReorderLive` +
 * `alignOutputsLegacy` + `setDirtyCanvas` -- see `wireGrip`'s own `onMove`
 * below). UNLIKE the LoRA loader's synchronous DOM `appendChild` move (its
 * own `flipRows` calls straight into the shared core), a Control Panel
 * reorder only swaps `node.widgets`' order -- the row's actual on-screen
 * position is repainted ASYNCHRONOUSLY by ComfyUI's own DOM-widget host,
 * confirmed (not assumed) by reading the installed `comfyui_frontend_
 * package`'s bundled Vue components: each row's DOM-widget wrapper `<div>`
 * (a distinct element from our own `.wtn-ctl-row`, which is mounted as ITS
 * child and never touched again after that) is repositioned by a
 * `DomWidgets` component's `updateWidgets()`, itself hooked onto
 * `canvas.onDrawForeground` -- which only runs once litegraph's own render
 * loop actually redraws the canvas, something `setDirtyCanvas(true, true)`
 * merely SCHEDULES for the next animation frame rather than performing
 * synchronously. Measuring "now" immediately after the reorder (the way
 * `lora_interaction.mjs` does) would therefore always read the OLD
 * position -- every delta 0, no visible animation at all, exactly the
 * silent-failure mode this whole port has to avoid. So this wrapper defers
 * the actual measure-and-animate step by one `requestAnimationFrame` before
 * handing off to the shared core, which then does its OWN separate,
 * one-frame-later class-add (`js/shared/flip.mjs`) -- reordering, in a real
 * ComfyUI session, is therefore: [reorder + setDirtyCanvas] -> [next frame:
 * litegraph redraws, `arrange()` updates each row widget's `.y`,
 * `onDrawForeground` repositions the row's wrapper -- THIS wrapper's own
 * deferred callback fires here, measuring the now-correct position and
 * writing the inverse transform] -> [frame after that: the shared core adds
 * the transitioning class] -> settle.
 *
 * Under a host with no `requestAnimationFrame` (this pack's own
 * headless-test convention) there is nothing to defer TO, so this is a
 * silent no-op rather than an instant settle -- a row already has whatever
 * position the test gave it, with no reorder-triggered repaint to wait for
 * in the first place.
 *
 * NOT wired at drag-END (`onUp`, below) -- only from `onMove`'s own per-swap
 * branch, mirroring `lora_interaction.mjs`'s identical choice: the last
 * swap's own flip is already what settles the drag visually, so `onUp` only
 * clears the dragging class and persists.
 */
export function flipRows(node, beforeTops) {
  if (typeof requestAnimationFrame !== "function") {
    return;
  }
  requestAnimationFrame(() => {
    sharedFlipRows(node._ctrlRows, ctrlRowEl, beforeTops, { className: "wtn-row-flip", settleMs: FLIP_SETTLE_MS });
  });
}

/**
 * BUG 15 (2026-07-29 owner report): "the drag has an issue, it goes over
 * multiple rows on a small mouse movement" -- `ev.clientY` is a SCREEN pixel
 * coordinate, but `step` (below) is a NODE/graph-space measurement. At any
 * canvas zoom other than 1:1, one row's worth of on-screen pointer movement
 * is `step * scale` screen pixels, so dividing the raw screen delta by the
 * un-scaled `step` answers in `scale` rows per row of real movement (2 rows
 * per row at 2x zoom, 3 at 3x). Ported from `lora_interaction.mjs`'s own
 * `wireGrip`, where this exact defect was fixed first (`ae7cd38`) --
 * `ctx.getCanvasScale` (`index.js`'s `getCanvasScale`, now wired into BOTH
 * `buildCtx` and `buildLoraCtx`) converts the screen delta into node space
 * FIRST, by dividing it out, before the row-pitch division happens. Falls
 * back to scale `1` if `ctx.getCanvasScale` is missing or not a function
 * (an older/partial ctx, or a test stub) -- never breaks under those.
 */
function wireGrip(node, ctx, rowId, refs) {
  if (!refs.grip) {
    return;
  }
  refs.grip.addEventListener("pointerdown", (e) => {
    const win = winOf(ctx);
    if (!win) {
      return;
    }
    if (typeof e.preventDefault === "function") {
      e.preventDefault();
    }
    e.stopPropagation();
    closeActiveOverlay();

    // Resolved live, right here at drag-START (mirrors `lora_interaction.
    // mjs`'s own `wireGrip`) -- a fresh, single-gesture read of whatever
    // `ensureState` currently serializes, never a `row` object captured back
    // at wiring time.
    const state = ensureState(node, ctx);
    const snapshot = state.rows.slice();
    const fromIndex = snapshot.findIndex((r) => r.id === rowId);
    if (fromIndex < 0) {
      return;
    }
    const startY = e.clientY;
    const step = ROW_H + ROW_GAP;
    refs.root.classList.add("wtn-ctl-dragging");

    const onMove = (ev) => {
      // Live-read, not captured once at drag-start -- matches this pack's
      // own "read live, never cache" convention for anything the user could
      // change mid-gesture (a wheel-zoom is technically possible mid-drag).
      const scale = typeof ctx.getCanvasScale === "function" ? ctx.getCanvasScale() : 1;
      const scaleFactor = Number.isFinite(scale) && scale > 0 ? scale : 1;
      const delta = Math.round((ev.clientY - startY) / (step * scaleFactor));
      const newOrder = reorderRows(snapshot, fromIndex, fromIndex + delta);
      if (newOrder.some((r, i) => r !== state.rows[i])) {
        // FLIP: measure BEFORE mutating/repainting (mirrors
        // `lora_interaction.mjs`'s identical call site) -- row count never
        // changes here, only order, so nothing about sizing/output slots is
        // affected by adding this.
        const beforeTops = captureRowTops(node);
        state.rows = newOrder;
        applyReorderLive(node, newOrder.map((r) => r.id));
        alignOutputsLegacy(node);
        if (typeof node.setDirtyCanvas === "function") {
          node.setDirtyCanvas(true, true);
        }
        flipRows(node, beforeTops);
      }
    };
    const onUp = () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
      refs.root.classList.remove("wtn-ctl-dragging");
      // DOM already matches the final order (applyReorderLive kept it in
      // sync on every move) -- update the cached signature so the next
      // syncRows call takes the cheap paint-only path instead of a
      // redundant full rebuild.
      node._ctrlRowSig = rowSignature(state);
      persistState(node, ctx);
      alignOutputsLegacy(node);
      if (typeof node.setDirtyCanvas === "function") {
        node.setDirtyCanvas(true, true);
      }
    };
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
  });
}

/** Reorder `node.widgets`/`node._ctrlRows` to match `newIds` (row ids, in
 * the new display order) WITHOUT touching any row's DOM or listeners --
 * see this module's top doc comment on why a live drag can't go through
 * the normal rebuild path. The add-row widget (and anything else in
 * `node.widgets` that isn't one of our row widgets) stays wherever it
 * already was. */
function applyReorderLive(node, newIds) {
  const entries = node._ctrlRows || [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const newEntries = newIds.map((id) => byId.get(id)).filter(Boolean);
  if (node.widgets) {
    const isRowWidget = (w) => entries.some((e) => e.widget === w);
    const firstIdx = node.widgets.findIndex(isRowWidget);
    const withoutRows = node.widgets.filter((w) => !isRowWidget(w));
    const insertAt = firstIdx >= 0 ? firstIdx : withoutRows.length;
    const rowWidgets = newEntries.map((e) => e.widget).filter(Boolean);
    node.widgets = [...withoutRows.slice(0, insertAt), ...rowWidgets, ...withoutRows.slice(insertAt)];
  }
  node._ctrlRows = newEntries;
}

// ---------------------------------------------------------------------------
// "+ Add control" / "+ Add loader" catalog menu
// ---------------------------------------------------------------------------

function wireAddRow(node, ctx, addRefs) {
  addRefs.btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const state = ensureState(node, ctx);
    const maxRows = MAX_ROWS[ctx.panelConfig.key] || MAX_ROWS.control;
    if (state.rows.length >= maxRows) {
      return;
    }
    openAddMenu(node, ctx, addRefs);
  });
}

/** Opens (or, on a second click of the SAME add button, closes) the catalog
 * menu -- same toggle contract as `openListMenuFor`/`openGearPopover`/
 * `openContextMenuFor` above (this one WAS still sharing the unconditional
 * close-then-reopen bug: a second click always closed whatever was open --
 * itself included -- then immediately reopened a fresh menu, so it visibly
 * never closed). `addRefs.root` (the button element itself, stable for the
 * node's whole lifetime between rebuilds) doubles as its own `ownerKey` --
 * there's exactly one add button per node, so object identity is already a
 * unique key, no `${kind}:${id}` string needed. */
function openAddMenu(node, ctx, addRefs) {
  const key = addRefs.root;
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: the add menu was already open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT overlay was open -- switch to this one
  const doc = ctx.doc;
  const menu = el(doc, "div", "wtn-ctl-menu wtn");
  const head = el(doc, "div", "wtn-ctl-mhead");
  head.textContent = "Add a control";
  menu.appendChild(head);

  // `menuCatalog` (Control Panel: real kinds + preset ids like "steps"/"cfg"/
  // "denoise", presets ordered before the bare "int"/"float" they shortcut)
  // falls back to `catalog` (the plain kind list -- the Loader Panel, which
  // has no presets of its own, never sets `menuCatalog` and lands here).
  const entries = [...(ctx.panelConfig.menuCatalog || ctx.panelConfig.catalog), ...(ctx.panelConfig.allowAuto ? ["auto"] : [])];
  entries.forEach((id) => {
    const meta = id === "auto" ? KIND_META.auto : menuMetaFor(id);
    const opt = el(doc, "div", "wtn-ctl-opt");
    opt.textContent = meta.menu;
    const hint = el(doc, "span", "wtn-ctl-hint");
    hint.textContent = id === "auto" ? "decided by the first wire" : (meta.outputType === "combo" ? "COMBO" : meta.outputType);
    opt.appendChild(hint);
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      closeActiveOverlay();
      addRowAndSync(node, ctx, id);
    });
    menu.appendChild(opt);
  });

  const handle = openOverlayWithZoom(ctx, doc, addRefs.root, menu, "below", () => {
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  });
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
}

// ---------------------------------------------------------------------------
// Row wiring dispatch
// ---------------------------------------------------------------------------

// `row` here is only ever read AT BUILD TIME (`rebuildRowWidgets`'s own
// `state.rows.forEach` loop, immediately after `ensureState` -- never a
// closure held for later), purely to decide which kind of wiring this row
// needs. Every sub-`wireX` function below is handed `row.id` alone, never
// `row` itself -- each resolves its OWN live row at the moment its handler
// actually fires (see this module's top doc comment and each function's own
// doc comment for why a captured `row` object is exactly the bug this
// dispatcher must not reintroduce).
function wireRow(node, ctx, row, refs) {
  const rowId = row.id;
  wireGrip(node, ctx, rowId, refs);
  wireContextMenu(node, ctx, rowId, refs);
  wireRename(node, ctx, rowId, refs);
  wireGear(node, ctx, rowId, refs);
  const kindMeta = KIND_META[row.kind] || KIND_META.auto;
  if (row.kind === "auto") {
    return;
  }
  if (isPickerKind(kindMeta)) {
    wireComboRow(node, ctx, rowId, refs);
  } else if (row.kind === "seed") {
    wireSeedRow(node, ctx, rowId, refs);
  } else if (row.kind === "int" || row.kind === "float") {
    wireNumericRow(node, ctx, rowId, refs);
  } else if (row.kind === "bool") {
    wireBoolRow(node, ctx, rowId, refs);
  }
}

// ---------------------------------------------------------------------------
// Row widget lifecycle: build / rebuild / repaint
// ---------------------------------------------------------------------------

function rowSignature(state) {
  return state.rows.map((r) => `${r.id}:${r.kind}`).join("|");
}

/**
 * Tear down every row widget + the add widget: splice EACH out of
 * `node.widgets` (bookkeeping) AND call its own `.onRemove()` (DOM teardown)
 * -- mirrors ComfyUI-Pixaroma's identical two-step contract for a dynamic
 * DOM-widget row (`js/sliders/ui.mjs`, `js/switch/vue_list.mjs`,
 * `js/mute_switch/vue_list.mjs`'s `w.onRemove?.()` right after the splice).
 *
 * THIS WAS THE BUG: splicing a widget out of `node.widgets` only removes our
 * OWN bookkeeping reference to it -- `addDOMWidget`'s returned widget mounts
 * its `element` into ComfyUI's own DOM-widget host, and only that widget's
 * `onRemove()` detaches it again. `rebuildRowWidgets` tears down and rebuilds
 * EVERY row widget (not just the removed one) on every structural change, so
 * skipping `onRemove()` here orphaned the ENTIRE previous generation of row +
 * add widgets on every add/remove/duplicate/kind-resolve: their elements
 * stayed mounted, frozen at whatever Y `arrange()` had last given them.
 * Removing a row shrinks the body (`bodyHeight`), which shifts every row
 * below the removed one upward -- so an orphaned widget's frozen Y then
 * lands on top of a CURRENT row lower in the list. `.wtn-ctl-add`'s
 * `background: transparent` (render.mjs) means an orphaned "+ Add control"
 * strip frozen over a live int row doesn't hide it, it shows THROUGH it --
 * exactly the "+ Add control ... 31" ghosting reported live. Never fires for
 * `panel_state` (never in `node._ctrlRows`/`node._ctrlAddWidget`, so never
 * touched by this loop) or for a widget lacking `onRemove` (defensive `?.()`
 * -- a non-DOM fallback entry from `rebuildRowWidgets`'s doc-less branch has
 * `widget: null`, and a real ComfyUI widget always provides `onRemove`).
 */
function removeRowWidgets(node) {
  const existing = node._ctrlRows || [];
  if (node.widgets) {
    for (const entry of existing) {
      const idx = node.widgets.indexOf(entry.widget);
      if (idx >= 0) {
        node.widgets.splice(idx, 1);
      }
      entry.widget?.onRemove?.();
      entry.uninstallZoom?.(); // js/shared/canvas_zoom.mjs -- see rebuildRowWidgets's install site
    }
    if (node._ctrlAddWidget) {
      const addIdx = node.widgets.indexOf(node._ctrlAddWidget);
      if (addIdx >= 0) {
        node.widgets.splice(addIdx, 1);
      }
      node._ctrlAddWidget.onRemove?.();
    }
  }
  node._ctrlAddZoomUninstall?.();
  node._ctrlAddZoomUninstall = null;
  node._ctrlRows = [];
  node._ctrlAddWidget = null;
}

/** Uninstall every currently-live zoom-passthrough listener (every row root
 * + the add strip) WITHOUT touching `node.widgets`/`node._ctrlRows` --
 * called from `index.js`'s `onRemoved` (outright node deletion, as opposed
 * to `removeRowWidgets`'s "about to rebuild" teardown) so a listener is
 * never left dangling on a detached element waiting on garbage collection
 * alone. Safe to call on a node that was never built (empty arrays). */
export function teardownAllZoomPassthrough(node) {
  (node._ctrlRows || []).forEach((entry) => entry.uninstallZoom?.());
  node._ctrlAddZoomUninstall?.();
  node._ctrlAddZoomUninstall = null;
}

/** Repaint every existing row's DISPLAY (never its DOM structure) from the
 * current state — the cheap path taken whenever the row-list signature
 * hasn't changed (see this module's top doc comment). Also refreshes each
 * row's own output dot class/title and the "+ Add" strip's disabled state.
 *
 * Display-consistency defense (2026-07-30, alongside the handler-level fix):
 * if `entry.refs.row` is no longer the SAME object as the live state's row
 * of the same id (`node.properties[stateProp]` was swapped for a different,
 * id-preserving object without a `syncRows` rebuild in between — the
 * measured live symptom this whole pass exists for), rebind it to the live
 * row here before painting. This does not by itself fix a handler that
 * already closed over the stale object (that's the point of every `wireX`
 * function above resolving live at fire-time instead) — it only ensures the
 * NEXT paint, whatever triggers it, can never show a value that disagrees
 * with what `persistState` would actually serialize. A row id no longer
 * present in the live state at all (removed) is left as-is here; `syncRows`'
 * signature check is what tears down/rebuilds the entry list itself. */
function repaintRows(node, ctx) {
  const state = ensureState(node, ctx);
  const lists = ctx.getKnownLists ? ctx.getKnownLists() : {};
  const entries = node._ctrlRows || [];
  let adoptedDefault = false;
  entries.forEach((entry) => {
    if (!entry.refs) {
      return;
    }
    try {
      const liveRow = state.rows.find((r) => r.id === entry.id);
      if (liveRow && entry.refs.row !== liveRow) {
        entry.refs.row = liveRow;
      }
      const row = entry.refs.row;
      const kindMeta = KIND_META[row.kind] || KIND_META.auto;
      let optionList = null;
      let disabledReason = null;
      if (isPickerKind(kindMeta)) {
        optionList = lists[row.kind] || null;
        if (!optionList) {
          disabledReason = `${(NODE_DEF_SOURCE[row.kind] && NODE_DEF_SOURCE[row.kind].className) || row.kind} not installed`;
        } else if (optionList.length && !optionList.includes(row.value)) {
          // A freshly-added combo row (or one whose saved value fell off the
          // installed list) has nothing valid to show -- adopt SOME current
          // value, same as a real ComfyUI combo widget always showing one
          // rather than a blank. `unet` alone routes through
          // `preferredNameDefault` (rows.mjs) instead of the plain
          // `optionList[0]` every other kind uses: on a real models folder,
          // index 0 is whatever sorts first, essentially never an Anima
          // checkpoint -- this was the ORIGINAL bug, just narrower, and it
          // hits every brand-new `unet` row (value starts `undefined`), not
          // just an orphaned one. Mirrors `src/anima/resources.py`'s
          // `preferred_name_default` -- keep the two in sync (see that
          // module's own comment on this).
          row.value = row.kind === "unet" ? preferredNameDefault(optionList, UNET_NAME_CANDIDATES) : optionList[0];
          adoptedDefault = true;
        }
      }
      paintRow(entry.refs, row, optionList, disabledReason);
      const typeClass = row.kind === "auto" ? "any" : (kindMeta.outputType === "combo" ? "combo" : kindMeta.outputType.toLowerCase());
      entry.refs.dot.className = `wtn-ctl-dot t-${typeClass}`;
      const typeLabel = row.kind === "auto" ? "*" : (kindMeta.outputType === "combo" ? "COMBO" : kindMeta.outputType);
      entry.refs.dot.title = `${typeLabel} · slot ${row.slot}`;
    } catch (err) {
      console.error(`[AnimaFlow Controls] failed to repaint row (kind=${entry.kind}, id=${entry.id}):`, err);
    }
  });
  if (node._ctrlAddWidget && node._ctrlAddWidget.element) {
    const maxRows = MAX_ROWS[ctx.panelConfig.key] || MAX_ROWS.control;
    const full = state.rows.length >= maxRows;
    const btn = node._ctrlAddWidget.element;
    btn.classList.toggle("wtn-ctl-full", full);
    btn.disabled = full;
    btn.textContent = full ? `${maxRows} rows max` : ctx.panelConfig.addLabel;
  }
  if (adoptedDefault) {
    persistState(node, ctx);
  }
}

function rebuildRowWidgets(node, ctx) {
  closeActiveOverlay();
  removeRowWidgets(node);
  const state = ensureState(node, ctx);
  const doc = ctx.doc;
  if (!doc || typeof node.addDOMWidget !== "function") {
    // Defensive fallback for a host without addDOMWidget/no live document
    // (shouldn't occur in ComfyUI's actual runtime) -- keep row bookkeeping
    // consistent (so slot/output syncing still works) without any DOM.
    node._ctrlRows = state.rows.map((row) => ({ id: row.id, kind: row.kind, widget: null, refs: { row } }));
    return;
  }

  const entries = [];
  state.rows.forEach((row) => {
    // One row's build/wire is wrapped on its OWN so a single bad row (a
    // future kind with a gap in KIND_META, an addDOMWidget quirk under a
    // real ComfyUI build, etc.) degrades to that one row missing rather
    // than throwing out of the whole `forEach` -- which would silently
    // skip every remaining row AND the "+ Add" strip built right after this
    // loop (that exact failure mode is what made "+ Add loader" look dead
    // alongside the empty loader rows during the original bug report).
    try {
      const kindMeta = KIND_META[row.kind] || KIND_META.auto;
      const refs = buildRowElement(doc, row, kindMeta, ctx.panelConfig);
      const widget = node.addDOMWidget(`ctrl_row_${row.id}`, "ctrl_row", refs.root, {
        serialize: false,
        getMinHeight: () => ROW_H,
        // `getMaxHeight === getMinHeight` pins the widget's own height --
        // ComfyUI-Pixaroma's `js/lora_loader/index.js:93-101` (MIT, see
        // THIRD_PARTY_NOTICES.md) does the identical min==max pin, and the
        // installed `comfyui_frontend_package` 1.47.10's own DOM-widget
        // `computeLayoutSize` (`static/assets/promotionUtils-DzZo8o5W.js`)
        // reads both bounds together -- this is the NATIVE mechanism that
        // stops litegraph from ever growing a row past ROW_H in the first
        // place, ahead of (not instead of) the `setSize` clamp and the
        // per-frame draw hook below, both of which stay as defence in depth.
        getMaxHeight: () => ROW_H,
      });
      widget.serialize = false;
      if (widget.options) {
        widget.options.serialize = false;
      }
      widget.computeSize = () => [node.size[0], ROW_H];
      widget.computeLayoutSize = () => ({ minHeight: ROW_H, maxHeight: ROW_H, minWidth: 1 });
      wireRow(node, ctx, row, refs);
      // Wheel-zooms-the-canvas fix (js/shared/canvas_zoom.mjs) -- installed
      // on EVERY row's own root, since this node has no single wrapping body
      // element (one addDOMWidget per row -- see render.mjs's top doc
      // comment), so full coverage means one install per row. Torn down in
      // removeRowWidgets/teardownAllZoomPassthrough above.
      const uninstallZoom = installCanvasZoomPassthrough(refs.root, ctx.getCanvasEl, WHEEL_LOCK_OPTIONS);
      entries.push({ id: row.id, kind: row.kind, widget, refs, uninstallZoom });
    } catch (err) {
      console.error(`[AnimaFlow Controls] failed to build/wire row (kind=${row.kind}, id=${row.id}):`, err);
    }
  });
  node._ctrlRows = entries;

  const maxRows = MAX_ROWS[ctx.panelConfig.key] || MAX_ROWS.control;
  const addRefs = buildAddRow(doc, ctx.panelConfig.addLabel);
  const addWidget = node.addDOMWidget("ctrl_add_row", "ctrl_add", addRefs.root, {
    serialize: false,
    getMinHeight: () => 28,
    // Same min==max pin as the row widgets just above -- see that call's own
    // comment for the full derivation (ComfyUI-Pixaroma `js/lora_loader/
    // index.js:93-101`, MIT).
    getMaxHeight: () => 28,
  });
  addWidget.serialize = false;
  if (addWidget.options) {
    addWidget.options.serialize = false;
  }
  addWidget.computeSize = () => [node.size[0], 28];
  addWidget.computeLayoutSize = () => ({ minHeight: 28, maxHeight: 28, minWidth: 1 });
  addRefs.root.disabled = state.rows.length >= maxRows;
  wireAddRow(node, ctx, addRefs);
  node._ctrlAddWidget = addWidget;
  node._ctrlAddZoomUninstall = installCanvasZoomPassthrough(addRefs.root, ctx.getCanvasEl, WHEEL_LOCK_OPTIONS);

  repaintRows(node, ctx);
}

/**
 * The main entry point every structural operation (add/remove/duplicate/
 * kind-resolve/restore) calls: diffs the current row-list signature against
 * the cached one and either does a cheap repaint (nothing structural
 * changed) or a full rebuild (row widgets + listeners recreated to match
 * the new list). Always resyncs output slots/types and re-parks dots
 * afterward.
 *
 * `injectStyles(ctx.doc)` runs FIRST, unconditionally, on every call --
 * `index.js`'s `setupNode`/`restoreNode` (fresh node / node restored from a
 * saved workflow) both call `syncRows` before any row DOM exists, so this is
 * the one choke point that guarantees the `.wtn-ctl-*` stylesheet lands
 * before `rebuildRowWidgets` ever appends a row element -- injectStyles is
 * idempotent (`STYLE_ID` guard in render.mjs), so calling it on every
 * `syncRows` (including the cheap repaint-only path) is free.
 */
export function syncRows(node, ctx) {
  injectStyles(ctx.doc);
  const state = ensureState(node, ctx);
  const sig = rowSignature(state);
  try {
    if (node._ctrlRowSig === sig && node._ctrlStateRef === state && node._ctrlRows) {
      repaintRows(node, ctx);
    } else {
      // `rowSignature` is `id:kind` only -- it can't tell a genuinely NEW
      // state object apart from the one every existing row DOM closure
      // (`wireComboRow`/`openListMenuFor`/etc.) still references, if that new
      // object's rows ever happen to carry the same ids (today's
      // `restoreStateFromWidget` always mints fresh ids via `rows.mjs`'s
      // `nextUid()`, so this can't currently occur through that path --
      // see `test_resize.mjs`'s "core-mechanic audit" -- but nothing else
      // guarantees it never will). So identity is tracked separately,
      // alongside the signature: a mismatch on EITHER forces a real rebuild
      // (never just a repaint), so every closure re-binds to a row from THIS
      // state object, the one `persistState`/`ensureState` will actually
      // serialize.
      node._ctrlRowSig = sig;
      node._ctrlStateRef = state;
      rebuildRowWidgets(node, ctx);
    }
    syncOutputs(node, ctx);
  } catch (err) {
    console.error("[AnimaFlow Controls] syncRows failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Output slots: slot -> node.outputs[slot-1], types narrowed per row,
// dots parked on each row widget's own Y (legacy litegraph).
// ---------------------------------------------------------------------------

/**
 * Write/preserve `out.label` for `row`'s slot -- the UE ("cg-use-everywhere")
 * name-disambiguation fix.
 *
 * ## History: this used to be a session-Map heuristic, and that was the bug
 *
 * An earlier version of this function tracked ownership in THREE plain
 * node-instance fields (`_ctrlSlotRowId`/`_ctrlOwnedLabels`/`_ctrlLastLabel`,
 * all keyed by SLOT NUMBER) that were deliberately never persisted. That
 * missed something `rows.mjs`'s own module doc comment now calls out
 * explicitly: `row.id` is NOT stable across a save/reload -- `normalizeRow`
 * mints a fresh one on every parse of the saved `panel_state` widget value,
 * and `index.js`'s `restoreStateFromWidget` FORCES exactly that reparse on
 * every `onConfigure`, even though `onNodeCreated`'s own earlier
 * `ensureState` call (same page load, moments before) already parsed the
 * IDENTICAL saved JSON into a first generation of row objects and already
 * ran a `syncOutputs` pass against them. So the old code's "this slot number
 * was just handed to a DIFFERENT row than last time" check
 * (`_ctrlSlotRowId.get(row.slot) !== row.id`) fired on literally every
 * restored workflow -- not because the slot was genuinely reassigned to a
 * new row, but because `restoreStateFromWidget`'s second parse of the SAME
 * saved rows minted second-generation ids that disagreed with the first
 * generation's. That "hard reset" branch then unconditionally overwrote
 * `out.label` with `defaultSlotLabel(row)`, silently reverting ANY label the
 * user had set directly on the socket (litegraph's own Rename Slot dialog)
 * and saved -- the reported bug: a socket rename reverts, either to the
 * row's own name or to a zero-width blank, on the very first sync after
 * reload.
 *
 * ## The fix: ownership lives on the ROW, not a slot-keyed session Map
 *
 * `row.slotLabelOwned` (`rows.mjs`) is a durable, SERIALIZED fact -- it
 * round-trips through `panel_state` (`_rows_helpers.py`'s `parse_state`
 * passes it through untouched, same contract as `renamed`), so it survives
 * regardless of which generation of ids this particular sync's row objects
 * happen to carry. Once set, nothing in THIS module ever clears it again --
 * not a reparse, not a reorder, not a row rename -- because it belongs to
 * this exact row for as long as this exact row object exists, full stop.
 * `node._ctrlLastLabel` (below) is now the ONLY still-session-only field, and
 * it's keyed by `row.id` rather than slot; that's fine precisely because it
 * is no longer load-bearing for ownership itself -- see its own comment.
 *
 * A removed row's `slotLabelOwned` flag disappears WITH the row object (it
 * was never slot-keyed, so there is nothing left over for a slot to
 * "inherit"), and `syncOutputs`'s `markSlotVacant` forces that freed slot's
 * `out.label` to the bare `ZW` sentinel on every sync it sits unclaimed --
 * so a brand-new row that later reuses the freed slot number always starts
 * from a genuinely blank label, never the departed row's text OR its
 * ownership claim. This is what test-covers the "slot reused by a new row
 * must not inherit the old row's label" case with zero extra bookkeeping.
 *
 * ## Ownership rule (per `rows.mjs`'s `SLOT_LABEL_MODE` doc comment)
 *
 *  - `row.slotLabelOwned === true` -- permanently the user's. The only thing
 *    still done to it is a one-time zero-width edge strip
 *    (`stripZeroWidthEdges`), healing the `${ZW}typed text` case litegraph's
 *    rename dialog produces when it pre-fills with our own ZW-sentinel'd
 *    label (confirmed live); a label with no such edge is left byte-for-byte
 *    alone. `applyResolvedKind`/a row rename never look at this flag and
 *    never need to -- see the existing regression test asserting the socket
 *    wins over a later row rename.
 *  - Otherwise: `isBlankSlotLabel(out.label)` (a brand-new output with no
 *    label at all, an empty string, the bare `ZW` sentinel, or pure
 *    zero-width junk), OR it already equals `defaultSlotLabel(row)` (the
 *    label we'd write anyway -- covers the FIRST sync after a reload, when
 *    the restored `out.label` is legitimately our own still-unclaimed
 *    default and `node._ctrlLastLabel` is a fresh, empty Map with nothing to
 *    compare against yet), OR it equals exactly what we ourselves wrote on a
 *    PRIOR call this session (tracked in `node._ctrlLastLabel`, needed for
 *    the case `defaultSlotLabel(row)` no longer matches because the ROW was
 *    just renamed) -- still OURS to manage. Stamp `defaultSlotLabel(row)`.
 *    This is the branch that makes a plain row rename keep updating the slot
 *    label on every subsequent sync.
 *  - Anything else -- the user just set this directly on the socket for the
 *    FIRST time (this session or ever) -- claim `row.slotLabelOwned = true`
 *    permanently, returning `true` so `syncOutputs` knows to persist the
 *    claim (a durable fact that only just became true MUST reach
 *    `panel_state`, or it wouldn't survive the very reload it exists to
 *    survive).
 *
 * Returns whether ownership was just claimed for the first time this call
 * (`syncOutputs` uses this to know whether a persist is needed).
 */
function syncSlotLabel(node, row, out) {
  const raw = out.label;

  if (row.slotLabelOwned) {
    const cleaned = stripZeroWidthEdges(raw);
    if (cleaned !== raw) {
      out.label = cleaned;
    }
    return false;
  }

  const want = defaultSlotLabel(row);
  const stillOurs = isBlankSlotLabel(raw) || raw === want || raw === node._ctrlLastLabel.get(row.id);
  if (stillOurs) {
    if (out.label !== want) {
      out.label = want;
    }
    node._ctrlLastLabel.set(row.id, want);
    return false;
  }

  row.slotLabelOwned = true;
  node._ctrlLastLabel.delete(row.id);
  const cleaned = stripZeroWidthEdges(raw);
  if (cleaned !== raw) {
    out.label = cleaned;
  }
  return true;
}

/**
 * Real "is this row's socket wired" oracle for `rows.mjs`'s
 * `planHoleCompaction` — reads `node.outputs[slot-1].links` directly
 * (litegraph's own connection bookkeeping: a non-empty array of link ids
 * when something is plugged in, `null`/`undefined`/`[]` otherwise).
 * `rows.mjs` stays free of any `node`/litegraph reference by design (see
 * this module's top doc comment); `planHoleCompaction` takes an
 * `isWiredBySlot` FUNCTION precisely so it never needs to know how
 * "wired" is determined, only what the answer is for a given slot number.
 */
function isWiredBySlot(node, slot) {
  const out = node.outputs && node.outputs[slot - 1];
  return !!(out && Array.isArray(out.links) && out.links.length > 0);
}

/**
 * Change 1 of the stray-output-dot fix (`rows.mjs`'s `planHoleCompaction`
 * doc comment has the full mechanism/algorithm) — this function supplies
 * the one thing that module can't know on its own (real wiredness, via
 * `isWiredBySlot` above) and applies whatever plan comes back: for each
 * `{from, to}` move, find the row currently AT slot `from` and rewrite its
 * `slot` to `to` in place. Nothing else about the row changes — `syncOutputs`
 * (the sole caller, immediately after this returns) is what re-derives
 * `out.name`/`out.label`/`out.type`/`out.pos` for the row's NEW slot index,
 * and what trims the now-fully-unowned top slot this leaves behind.
 * Returns whether anything moved (the caller uses this to know whether a
 * persist is needed, same as `syncSlotLabel`'s `claimedOwnership`).
 *
 * Ordering hazard checked, not assumed (per the task's citation of
 * `../ComfyUI-Pixaroma/js/sliders/core.mjs:237-245`: `removeOutput` on a
 * WIRED slot fires `onConnectionsChange` as a disconnect, which is why that
 * pack — and `index.js`'s own `onConnectionsChange` hook here, which only
 * special-cases the `isConnected === true` branch and otherwise falls
 * through to the original handler untouched — has to care about "our own
 * remove vs. the user unplugging" at all). This function never calls
 * `node.removeOutput`/`node.addOutput` itself, and `planHoleCompaction`
 * only ever proposes moving a row whose slot has ZERO links in the first
 * place — so by the time `syncOutputs`'s trailing-trim calls
 * `node.removeOutput` on the slot this leaves vacated, that slot was
 * already unwired before this function ever touched it. There is no live
 * connection for a disconnect event to report, and no special-casing for it
 * to need.
 *
 * USER-ACTION-ONLY, NEVER ON LOAD: `syncOutputs` (the sole caller) skips
 * this function entirely while `node._ctrlConfiguring` is truthy — the same
 * flag, read the same way, that gates `setupNode`'s `applyNodeChrome` call
 * (`index.js:262`) and `scheduleFit` (this module, above). Its own doc
 * comment (`index.js:244-262`) is why it reliably means "a workflow restore
 * is in flight, right now, for this node": `onConfigure`'s wrapper sets it
 * SYNCHRONOUSLY before queuing anything async, and litegraph's
 * construct-then-configure deserialize loop runs with no `await` in
 * between, so by the time either `onNodeCreated`'s or `onConfigure`'s own
 * queued `syncRows` call actually fires (both go through `loadMods().then`),
 * the flag already reflects "was this node just restored" for the WHOLE
 * loading window, however long the import takes. `compactHoles` renumbers a
 * row's slot — exactly the mutation `assignSlot`'s doc comment (`rows.mjs`)
 * calls out as safe ONLY when a genuine user action (add/remove/edit a row)
 * triggers it; a saved workflow's interior hole is not a bug to silently
 * repair on the way in, it is that workflow's own last-saved shape, and
 * loading it must never call `removeOutput`/rewrite a slot on its own,
 * unprompted (this pack's "a clean workflow must not open modified" rule —
 * same rule `restoreNode`'s own doc comment in `index.js` states for size).
 */
function compactHoles(node, state) {
  const plan = planHoleCompaction(state.rows, (slot) => isWiredBySlot(node, slot));
  if (!plan.length) {
    return false;
  }
  let changed = false;
  for (const move of plan) {
    const row = state.rows.find((r) => r.slot === move.from);
    if (row && move.from !== move.to) {
      row.slot = move.to;
      changed = true;
    }
  }
  return changed;
}

/**
 * Keep `node.outputs` sized to the HIGHEST slot currently in use (never to
 * `rows.length` — see `rows.mjs`'s module doc comment: slot is a durable
 * output-array INDEX, not a display position). A freed slot below the
 * current max cannot just be deleted — that would shift every higher index
 * down, silently rewiring every link on every row above it — so it is left
 * IN PLACE as an interior "hole" and handed to `markSlotVacant` below,
 * which is what actually keeps it invisible and inert. `assignSlot`
 * (rows.mjs) always reuses the lowest free slot first, so a hole is
 * normally short-lived, but it must not be visibly broken for however long
 * it lasts.
 *
 * (Fixes the reported bug: a hole used to keep whatever `.name`/`.label`/
 * `.pos` the row that vacated it left behind, because nothing here ever
 * revisited an index no row claims — `alignOutputsLegacy` only ever WRITES
 * `.pos` for indices a live row owns, so the stale value just sat there.
 * Since a removed row is usually the last one added, its stale `.pos`
 * typically pointed at the bottom of the panel, right over the "+ Add
 * control" strip — a floating output dot with the removed row's own label
 * painted next to it. `markSlotVacant` now revisits every hole on every
 * sync and forces all three back to a blank, disconnectable-to-nothing
 * state.
 *
 * That fix was itself incomplete — see `markSlotVacant`'s own doc comment
 * for round two: deleting `.pos` outright hands the slot to litegraph's
 * DEFAULT output stacking, which parks an unpositioned output at the TOP of
 * the node, beside the title. `compactHoles` (above) is tried FIRST, every
 * sync, so most holes never reach `markSlotVacant`/`parkVacantSlot` at all;
 * the two of those are what keep a hole that genuinely can't be closed
 * (its would-be filler is wired) from ever being visible either.
 *
 * `compactHoles` itself is skipped outright while `node._ctrlConfiguring` is
 * truthy — see ITS doc comment for the full reasoning; this is what stops a
 * loaded workflow's own saved hole from being silently renumbered on
 * restore. Everything else below (the trailing-slot trim, the grow loop,
 * `markSlotVacant`/`alignOutputsLegacy`/`parkVacantSlot`) runs unconditionally
 * either way — a restored hole must still be BLANKED and PARKED exactly as
 * it would be mid-session, it just must not be CLOSED.)
 */
/** Grab `node.size`'s current `[w, h]` as a fresh 2-entry array, or `null` if
 * `node.size` isn't there or isn't shaped like one -- `restoreNodeSize`
 * below already tolerates a `null` snapshot on its own; this just keeps that
 * check in ONE place. Same helper `js/anima/interaction.mjs`'s
 * `healNodeSockets` carries under this exact name, for this exact reason --
 * see its doc comment for the full "shrinks to min on every refresh"
 * mechanism this guards against; kept as a private duplicate here rather
 * than a cross-track import (this pack's tracks stay independent modules). */
function captureNodeSize(node) {
  if (isSizeLike(node.size)) {
    return [node.size[0], node.size[1]];
  }
  return null;
}

/** Write a `captureNodeSize` snapshot back onto `node.size`, IN PLACE --
 * assigning the two array ENTRIES directly rather than calling
 * `node.setSize(...)`, so this can never re-enter any `onResize` clamp chain
 * installed elsewhere while a sync is still unwinding on the same call
 * stack (this track has no such clamp today, unlike `js/anima/`'s, but the
 * same defensive shape costs nothing and keeps the two tracks' fixes
 * identical). A no-op if there was nothing captured, or nowhere left to
 * write it into. Marks the canvas dirty so the restored size actually
 * repaints. */
function restoreNodeSize(node, saved) {
  if (!saved || !isSizeLike(node.size)) {
    return;
  }
  node.size[0] = saved[0];
  node.size[1] = saved[1];
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

/**
 * ## Size preserve/restore around the trim/grow loops below (the SAME
 * "shrinks to min on every refresh" trap `js/anima/interaction.mjs`'s
 * `healNodeSockets` doc comment covers in full)
 *
 * VERIFY-IN-COMFYUI: litegraph's own `removeOutput`/`addOutput` are
 * documented as each ending with `this.size = this.computeSize()` -- so
 * either while-loop below, if it actually calls the real API method (never
 * the plain-splice/push fallback, which has no such side effect), discards
 * whatever size litegraph just restored from the saved workflow. This is
 * read from litegraph's documented behaviour, not exercised against a live
 * process (none installed in this dev environment) -- same caveat as the
 * Anima track's own fix.
 *
 * Unlike Anima's Python surface (a real breaking class-shape change,
 * `d021c09`), this pack's own `RETURN_TYPES`/`MAX_ROWS` for
 * `AnimaControlPanel`/`AnimaLoaderPanel` has never changed shape -- `node.
 * outputs.length` and `state.rows`' own `maxSlot` are two views of the SAME
 * saved workflow and are kept EXACTLY equal by this very function every time
 * it runs (the trim/grow loops below converge them to match on every call,
 * including the one that ran right before the save that produced whatever
 * gets restored). So on a normal load, this pair is already consistent
 * BEFORE either loop below ever runs, and neither loop's condition is even
 * true -- no `removeOutput`/`addOutput` call, no size-clobbering side
 * effect, nothing to restore. That is what makes a clean, already-current
 * Control/Loader Panel workflow safe today without any extra guard.
 *
 * The preserve/restore below exists for the cases that invariant does NOT
 * cover: a workflow saved by an OLDER build of this same file (before some
 * now-fixed hole/compaction bug landed -- this module's own doc comments
 * record more than one such fix) or a hand-edited workflow, either of which
 * can hand this function a `node.outputs.length` that genuinely disagrees
 * with `maxSlot` on the very FIRST sync a restore ever runs. That first sync
 * happens from `setupNode` (via `onNodeCreated`, which litegraph fires
 * BEFORE `onConfigure` even for a restored node, per `index.js`'s own top
 * doc comment) while `node._ctrlConfiguring` is already true and BEFORE
 * `restoreNode`'s own sync runs -- i.e. squarely on the load path, with
 * nothing downstream (`scheduleFit` is deliberately never called from the
 * load path either) left to correct a size a stray `removeOutput`/
 * `addOutput` call clobbered. Preserving it here is what keeps that one case
 * from reproducing the exact reported bug on this track too -- and per the
 * VERIFY-IN-COMFYUI caveat above, it costs nothing on a litegraph build that
 * turns out not to resize on these calls: restoring a size to itself is
 * harmless. Only restored when the trim/grow loops actually removed or
 * added something -- `compactHoles`'s own `_ctrlConfiguring` gate above is
 * untouched, and an already-consistent load still writes `node.size`
 * nowhere at all.
 */
export function syncOutputs(node, ctx) {
  const state = ensureState(node, ctx);
  if (!node.outputs) {
    node.outputs = [];
  }
  // `node._ctrlConfiguring` is a workflow restore IN FLIGHT right now for
  // this exact node (see `compactHoles`'s doc comment for the full
  // create-vs-restore reasoning) -- compaction renumbers a row's slot, which
  // is a user-action-only mutation (`rows.mjs`'s `assignSlot` doc comment),
  // so it must never run on the load path. Plain property read, no
  // litegraph lookup involved -- a fake node under test can set this flag
  // directly, same as `scheduleFit` already does.
  const compacted = node._ctrlConfiguring ? false : compactHoles(node, state);
  const maxSlot = state.rows.reduce((m, r) => Math.max(m, Number(r.slot) || 0), 0);

  const savedSize = captureNodeSize(node);
  let outputsMutated = false;

  while (node.outputs.length > maxSlot) {
    const idx = node.outputs.length - 1;
    if (state.rows.some((r) => r.slot === idx + 1)) {
      break; // never shrink past an index a row still owns
    }
    outputsMutated = true;
    if (typeof node.removeOutput === "function") {
      node.removeOutput(idx);
    } else {
      node.outputs.pop();
    }
  }
  while (node.outputs.length < maxSlot) {
    outputsMutated = true;
    if (typeof node.addOutput === "function") {
      node.addOutput(ZW, "*");
    } else {
      node.outputs.push({ name: ZW, type: "*" });
    }
  }
  if (outputsMutated) {
    restoreNodeSize(node, savedSize);
  }

  if (!node._ctrlLastLabel) {
    // row id -> the label WE ourselves last wrote for that row's slot --
    // lets `syncSlotLabel` tell "the user changed this since we last looked"
    // from "still exactly what we stamped it with" without needing to
    // persist anything. Keyed by ROW ID rather than slot number precisely
    // because it is NOT load-bearing for ownership itself (see
    // `syncSlotLabel`'s doc comment) -- a stale entry surviving under an old
    // row's id after that row is removed is harmless: nothing ever reads it
    // again (a brand-new row minted later, even one reusing the freed slot
    // number, has a brand-new id).
    node._ctrlLastLabel = new Map();
  }

  const lists = ctx.getKnownLists ? ctx.getKnownLists() : {};
  const ownedSlots = new Set();
  let claimedOwnership = false;
  state.rows.forEach((row) => {
    ownedSlots.add(row.slot);
    const idx = row.slot - 1;
    const out = node.outputs[idx];
    if (!out) {
      return;
    }
    // `name` must stay `value_${slot}` -- EXACTLY Python's `RETURN_NAMES`
    // for that slot index (`nodes/controls/control_panel.py` /
    // `loader_panel.py`: `f"value_{i + 1}"`). This is never the ZW, and
    // never the row's own display name -- a mismatched `name` is what makes
    // ComfyUI's node-def reconciliation treat the slot as unknown and
    // re-add a phantom output (see this module's top doc comment and
    // ComfyUI-Pixaroma's `js/sliders/core.mjs` `syncOutputs`, which
    // documents the exact same contract). `label` is a SEPARATE concern,
    // handled by `syncSlotLabel` below (rows.mjs's `SLOT_LABEL_MODE`/UE
    // interop) -- never conflate the two the way this function used to.
    const wantName = `value_${row.slot}`;
    if (out.name !== wantName) {
      out.name = wantName;
    }
    if (syncSlotLabel(node, row, out)) {
      claimedOwnership = true;
    }
    const t = outputTypeForRow(row, lists);
    if (out.type !== t) {
      out.type = t;
    }
  });

  // Every index NOT in `ownedSlots` is an interior "hole" (a slot freed by
  // a row removal, per this function's top doc comment) -- revisit ALL of
  // them, EVERY sync, not just the moment a row is removed: a hole can sit
  // unclaimed for an arbitrary number of syncs before `assignSlot`/
  // `compactHoles` reuses or closes it, and each of those syncs must keep
  // re-asserting the blank state rather than trusting whatever the previous
  // call left behind.
  const holeIdxs = [];
  for (let idx = 0; idx < node.outputs.length; idx++) {
    if (ownedSlots.has(idx + 1)) {
      continue;
    }
    holeIdxs.push(idx);
    markSlotVacant(node.outputs[idx], idx + 1);
  }

  alignOutputsLegacy(node);

  // Park every surviving hole's dot NOW that live rows' own dots are
  // positioned (`parkVacantSlot`, below `markSlotVacant`) -- ordering here
  // is cosmetic, `parkVacantSlot` only ever READS a live widget's `.y`,
  // which `alignOutputsLegacy` never changes, but doing it right after
  // keeps every output's `.pos` freshly written in one clearly-sequenced
  // pass rather than interleaved with the owned-row loop above.
  holeIdxs.forEach((idx, holeRank) => {
    parkVacantSlot(node, node.outputs[idx], holeRank);
  });

  // A row's `slotLabelOwned` flag is part of the serialized row (`rows.mjs`)
  // -- if `syncSlotLabel` just claimed it for the FIRST time this call, that
  // durable fact must reach `panel_state` NOW, not whenever some unrelated
  // future edit next happens to call `persistState`. Without this, the claim
  // lives only on the in-memory row object: it correctly stops THIS session
  // from reverting the label again, but a save that happens before any other
  // edit would still miss it, and the very next reload would be back to
  // square one (`isBlankSlotLabel`/`_ctrlLastLabel` both fresh, but the
  // restored `out.label` no longer matches either since it's the user's real
  // text -- exactly the scenario `syncSlotLabel`'s doc comment walks through).
  // `compacted` needs the exact same "persist now, not on some later unrelated
  // edit" treatment -- `compactHoles` already rewrote `row.slot` in place, so
  // skipping this would leave the very fix this pair of functions exists for
  // unsaved until something else happens to trigger a persist.
  if (claimedOwnership || compacted) {
    persistState(node, ctx);
  }
}

/**
 * Force output index `slot - 1` into the blank, inert state a "hole" (an
 * output no current row owns — see `syncOutputs` above) must be in on
 * every sync, unconditionally — there is no row behind it to own an
 * exception the way `syncSlotLabel` preserves a user's own rename of a
 * LIVE slot. Only reached for a hole `compactHoles` could NOT close this
 * sync (its would-be filler is wired — `rows.mjs`'s `planHoleCompaction`).
 *
 *  - `out.name` stays `value_${slot}` — same Python-contract reasoning as
 *    the owned-row branch above: `RETURN_NAMES` is a fixed tuple for the
 *    whole `MAX_ROWS` range regardless of which slots currently have a
 *    row, so a hole's name must look exactly like an owned slot's would.
 *  - `out.label` is forced to the bare `ZW` sentinel. This is what stops
 *    litegraph painting the vacated row's old display text where no DOM
 *    row exists any more to cover it.
 *  - `out.type` becomes `VACANT_SLOT_TYPE` (rows.mjs), NEVER `"*"` — see
 *    that constant's doc comment. A wildcard-typed hole would still
 *    accept a wire from anything in the graph, silently binding it to a
 *    slot with no row behind it: a worse bug than the visible dot this
 *    function exists to fix.
 *  - `out.hidden = true`, IN ADDITION to everything below — UNVERIFIED
 *    against this pack's actual litegraph build: legacy litegraph's
 *    `drawNode` iterates `node.outputs` unconditionally as far as could be
 *    confirmed here, so this is not claimed to suppress the dot BY ITSELF.
 *    It costs nothing to set on a renderer that ignores it, and is a clean
 *    win on any renderer (present or future) that honours it — `out.pos`
 *    (via `parkVacantSlot` below) is what actually does the work today.
 *  - `out.pos` is PARKED (`parkVacantSlot`, below), not deleted.
 *    HISTORY: deleting outright USED TO BE the fix here — the original
 *    reported bug was a stale `.pos` inherited from whichever row last
 *    vacated this slot, typically left sitting over the "+ Add control"
 *    strip, and `delete out.pos` correctly cleared that (see the paragraph
 *    above this function, still accurate for the bug it describes). But
 *    deleting a slot's `.pos` entirely hands it to litegraph's own DEFAULT
 *    output stacking — and that default parks an unpositioned output at
 *    the TOP of the node, beside the title, which is a SECOND, DIFFERENT
 *    stray-dot bug (confirmed live, on a real graph, by a console probe:
 *    a hole `compactHoles` could not close because the row above it was
 *    wired). A deliberately parked, explicit `.pos` — in the socket gutter
 *    below the last live row, never at either failure mode's location —
 *    is the fix that survives both at once.
 */
function markSlotVacant(out, slot) {
  if (!out) {
    return;
  }
  const wantName = `value_${slot}`;
  if (out.name !== wantName) {
    out.name = wantName;
  }
  if (out.label !== ZW) {
    out.label = ZW;
  }
  if (out.type !== VACANT_SLOT_TYPE) {
    out.type = VACANT_SLOT_TYPE;
  }
  if (out.hidden !== true) {
    out.hidden = true;
  }
}

/** `[x, y]` for an output dot given DOM-widget-space `y` (a widget's own
 * `.y`, no margin baked in) and that widget's `margin` — the ONE formula
 * both `alignOutputsLegacy` (a live row's own dot) and `parkVacantSlot` (a
 * surviving hole's dot, below) need, so neither hardcodes a second copy of
 * it. `x` is always the node's own width (legacy litegraph paints every
 * output dot at the node's right edge); `y` is half a row down from the
 * widget's DOM-element top, offset by legacy's own DOM-widget inset
 * (`margin`, `DEFAULT_MARGIN = 10` if unset): the element paints at
 * `node.pos + margin + widget.y`, while `widget.y` itself carries no
 * margin — omitting it lands the dot ~10px above the row's true center. */
function dotPos(node, y, margin) {
  const m = Number.isFinite(margin) ? margin : 10;
  return [node.size[0], y + m + ROW_H * 0.5];
}

/** Park each row's output dot at ITS OWN row widget's Y (legacy litegraph
 * reads `output.pos` verbatim — ported from ComfyUI-Pixaroma's
 * `alignOutputsLegacy`, `js/sliders/ui.mjs`, keyed here by `row.slot - 1`
 * instead of positional index so reordering only moves the dot's Y, never
 * which `node.outputs` entry it is). */
export function alignOutputsLegacy(node) {
  const entries = node._ctrlRows || [];
  if (!node.outputs || !entries.length) {
    return;
  }
  for (const entry of entries) {
    const w = entry.widget;
    const row = entry.refs && entry.refs.row;
    if (!w || !row || !Number.isFinite(row.slot)) {
      continue;
    }
    const idx = row.slot - 1;
    const out = node.outputs[idx];
    if (!out) {
      continue;
    }
    const y = w.y;
    if (!Number.isFinite(y)) {
      continue;
    }
    const margin = Number.isFinite(w.margin) ? w.margin : 10;
    const [nx, ny] = dotPos(node, y, margin);
    if (!out.pos || out.pos[0] !== nx || Math.abs(out.pos[1] - ny) > 0.5) {
      out.pos = [nx, ny];
    }
  }
}

/** The widget-space `y` (no margin — same convention as `alignOutputsLegacy`
 * reads off a live row's `w.y`) a vacant slot ranked `holeRank` (0 for the
 * first surviving hole this sync, 1 for the next, …) should park its dot
 * at: one row-pitch (`ROW_H + ROW_GAP` — litegraph's own spacing between
 * two consecutive row widgets, the exact numbers this module already
 * imports from `render.mjs` for everything else) below the LOWEST live
 * row's own `widget.y`, then one further pitch per rank so several
 * survivors stack rather than overlap — never beside the title (row 0's
 * own `y`), never over the "+ Add control" strip (which sits ABOVE any of
 * this, not below the last row).
 *
 * Falls back to `2` (`widgets_start_y` — render.mjs/rows.mjs's shared
 * "before any row" convention, see this module's top doc comment) when
 * there is no live row to measure from at all. That edge case can't
 * actually produce an interior hole in the first place (nothing above an
 * empty panel for one to be "interior" under — `rows.mjs`'s
 * `planHoleCompaction` never returns a hole with nothing above it, and
 * `syncOutputs`'s own trim already deletes a trailing one before this is
 * ever called) — kept only so this degrades gracefully instead of reading
 * off a missing row if that invariant is ever wrong.
 */
function vacantSlotY(node, holeRank) {
  const entries = node._ctrlRows || [];
  let maxY = null;
  for (const entry of entries) {
    const w = entry.widget;
    const row = entry.refs && entry.refs.row;
    if (!w || !row || !Number.isFinite(row.slot) || !Number.isFinite(w.y)) {
      continue;
    }
    if (maxY === null || w.y > maxY) {
      maxY = w.y;
    }
  }
  const pitch = ROW_H + ROW_GAP;
  const base = maxY === null ? 2 : maxY + pitch;
  return base + pitch * holeRank;
}

/** Give a surviving vacant slot (`syncOutputs`'s `markSlotVacant`, called
 * right before this — see ITS doc comment for why `delete out.pos` stopped
 * being enough) a `.pos` that can never land beside the title or over the
 * "+ Add control" strip: `vacantSlotY` above for the Y, `dotPos` (shared
 * with `alignOutputsLegacy`) for turning that into an actual `[x, y]`. No
 * margin override — a vacant slot has no DOM widget of its own to read one
 * off, so this always uses `dotPos`'s own `DEFAULT_MARGIN = 10` fallback. */
function parkVacantSlot(node, out, holeRank) {
  if (!out) {
    return;
  }
  out.pos = dotPos(node, vacantSlotY(node, holeRank), undefined);
}

// ---------------------------------------------------------------------------
// Resize -- USER ACTIONS ONLY, never on load (per the dynamic-node-frontend
// skill). Ported from ComfyUI-Pixaroma's `js/lora_loader/index.js` (MIT ©
// pixaroma, see THIRD_PARTY_NOTICES.md) -- its `fitNodeH` (lines 57-63 there)
// and `fitToContent` (lines 68-74 there, its `isGraphLoading()` bail on line
// 69) fix the exact bug this track hit: TWO independent
// sources of node height competing for the same number. `fitNode` used to
// compute `bodyHeight(rows.length)` directly and never once asked
// `node.computeSize` -- meanwhile every row is mounted as its OWN
// `addDOMWidget` reporting its own `getMinHeight`/`computeSize`, plus the
// title bar and slot rows, and LiteGraph sums THOSE into its own total by a
// path that never goes through this module at all. When the two totals
// disagreed, the bigger one visibly won and the node settled taller than
// `bodyHeight` said it should be.
//
// The fix (`fitNodeH`, below): ask `node.computeSize()` FIRST and use
// `bodyHeight` only as a FALLBACK for when `computeSize` is unavailable or
// broken. In this pack `node.computeSize` is `index.js`'s own
// `computeControlsSize` override (design doc §7's `bodyHeight`-only
// arithmetic, kept specifically so legacy litegraph doesn't reserve an extra
// 20px slot row per output above the body) -- so this makes `node.computeSize`
// the ONE place the answer lives, and `fitNode` a caller of it rather than a
// second implementation racing it. `bodyHeight` used directly is exercised
// only when `node.computeSize` is missing (a node/stub that hasn't been
// through `setupNode` yet -- this is also the path this file's own headless
// test stub exercises, since it never installs `computeSize` at all).
// ---------------------------------------------------------------------------

/** The node height that shows every row with no scrollbar -- `node.
 * computeSize()` if it reports a usable value, `bodyHeight(rows.length)`
 * otherwise. See this section's own doc comment for why `computeSize` has to
 * be asked FIRST, not used as a redundant second opinion. */
function fitNodeH(node, ctx) {
  try {
    const cs = typeof node.computeSize === "function" ? node.computeSize() : null;
    if (cs && Number.isFinite(cs[1]) && cs[1] > 0) {
      return Math.round(cs[1]);
    }
  } catch (_e) {
    // A broken/throwing computeSize must never take the fit down with it --
    // just fall through to the arithmetic fallback below (mirrors the
    // reference's own try/catch around `node.computeSize?.()`).
  }
  const state = ensureState(node, ctx);
  return bodyHeight(state.rows.length);
}

/**
 * Auto-fit the node to its content. Per ComfyUI-Pixaroma's `js/lora_loader/
 * index.js` decision this was ported alongside: height is NEVER user-owned
 * -- there is no such thing as "the row count shrank but the node should stay
 * tall", it always resizes to exactly what `fitNodeH` reports. Width is the
 * ONE user-controlled dimension: floored at `MIN_W`, otherwise left exactly
 * as the caller's current `node.size[0]` already is.
 *
 * Bails on the load path via BOTH `node._ctrlConfiguring` and
 * `ctx.isGraphLoading()` -- the guard lives HERE now (it used to live only
 * inside `scheduleFit`'s queued rAF callback), so that every caller of
 * `fitNode`, not only the ones that go through `scheduleFit`, is covered: "no
 * call site can ever re-fit during a load." Mirrors the reference's own
 * `fitToContent`, whose first line is exactly this bail (`js/lora_loader/
 * index.js:69`, comment: "USER ACTIONS ONLY (never on the load path, or a
 * saved size gets rewritten and a clean workflow opens 'modified')").
 * `node._ctrlConfiguring` stays as the second, belt-and-braces guard for the
 * same reason `scheduleFit`'s own doc comment (below) has always given: it
 * covers a DIFFERENT window than `ctx.isGraphLoading()` does (before that
 * flag even starts vs. after a per-node flag's own async import can leak
 * past it) -- both are needed, neither replaces the other.
 */
export function fitNode(node, ctx) {
  if (node._ctrlConfiguring || (ctx && typeof ctx.isGraphLoading === "function" && ctx.isGraphLoading())) {
    return; // a workflow load is in flight -- trust the saved node.size
  }
  const w = Math.max((node.size && node.size[0]) || DEFAULT_W, MIN_W);
  const h = fitNodeH(node, ctx);
  if (typeof node.setSize === "function") {
    node.setSize([w, h]);
  } else if (node.size) {
    node.size[0] = w;
    node.size[1] = h;
  }
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

// ---------------------------------------------------------------------------
// Class A sizing lock (owner policy, 2026-07-29): height is CONTENT-FIXED,
// width is user-resizable with a floor -- `AnimaControlPanel`/
// `AnimaLoaderPanel` are the two existing Class A nodes (a future AnimaFlow
// LoRA loader is a third). Ported from ComfyUI-Pixaroma's `js/lora_loader/
// index.js` `onResize` (MIT, THIRD_PARTY_NOTICES.md), the reference model
// `pixaroma-review-rounds-plan.md` item 11 records in full.
//
// Before this: `fitNode`/`fitNodeH` above already make content height the
// FLOOR litegraph enforces on a resize-drag (via `node.computeSize()`), but a
// floor only ever stops a drag going SHORTER than content -- litegraph
// happily lets the user drag the node TALLER, since each row's own DOM
// widget reports a FIXED `computeSize`/`getMinHeight` for ITS OWN ROW_H
// slice (`rebuildRowWidgets`, above), never anything about the node's total.
// The node then sits taller than its content until the next structural
// change re-fits it -- the reported "resizes to a bigger height when not
// needed."
//
// The fix is `onResizeControls`, wired as `nodeType.prototype.onResize` in
// `index.js`: litegraph calls this on every resize-drag frame with the drag's
// own `size`, and this hook overwrites the height entry right back to
// `fitNodeH`'s answer before the frame ever paints -- so a height drag is a
// no-op, while a width drag (the ONE user-owned dimension here) goes through
// untouched, floored at `MIN_W`.
// ---------------------------------------------------------------------------

/**
 * `onResize(size)` -- litegraph's per-resize-drag hook, called from the
 * canvas's own resize-handle interaction (NOT called during
 * `onConfigure`/restore -- a load never drags the resize handle, so this
 * function never needs its own `_ctrlConfiguring`/`isGraphLoading` guard the
 * way `fitNode` does; `applyContentHeight`, below, is the separate load-path
 * counterpart for the "regardless of what height was saved" case).
 *
 * - HEIGHT is never user-owned: unconditionally rewritten to `fitNodeH`'s
 *   answer -- the SAME authority `fitNode` itself asks, never a second
 *   formula racing it (this file's own top "Resize" section doc comment is
 *   the whole reason that rule exists). A height drag has litegraph write
 *   `size[1]` to wherever the user dragged to and then call this hook, which
 *   immediately rewrites it back before the next paint -- the drag has no
 *   lasting effect, which IS the "non-draggable height" this exists for.
 * - WIDTH stays the user's, floored at `MIN_W` here too as belt-and-braces:
 *   litegraph's own resize-drag floor already reads `node.computeSize()[0]
 *   === MIN_W` (`computeControlsSize`, `index.js`), but mirroring the
 *   reference's redundant floor here costs nothing and covers the same
 *   "onResize does not fire on every legacy resize path" caveat the
 *   reference's own `onDrawForeground` clamp exists for
 *   (`pixaroma-review-rounds-plan.md` item 11) -- not ported here because
 *   this pack has no such second, non-onResize clamp path today; flagged
 *   there as the next thing to port if a sub-`MIN_W` width is ever observed
 *   live.
 *
 * LEGACY ONLY (`!isVueNodes()`): under Nodes 2.0 the per-row/add-strip DOM
 * widgets' own `computeLayoutSize` (`rebuildRowWidgets`, above) already owns
 * sizing through the Vue layout store -- writing `node.size` here as well
 * would fight that layout, per the reference's own comment ("clamping
 * `node.size` here would desync and pop on a workflow-tab switch"). This
 * pack's target renderer is legacy litegraph (`.claude/CLAUDE.md`);
 * `computeLayoutSize` stays forward-compat only, entirely unchanged by this
 * function -- so this dispatch does not newly assert anything about how
 * Nodes 2.0 handles a height drag, only that legacy is now correct and v2 is
 * left exactly as it already was.
 *
 * Mutates `size` IN PLACE, the documented `onResize(size)` contract
 * (`js/anima/render.mjs`'s identical doc comment on `clampGeneratorSize`/
 * `clampPreviewSize`) -- and mirrors the same values onto `node.size` too,
 * in case a caller ever passes a `size` that isn't the very same array
 * `node.size` already is (litegraph itself always passes `node.size`, but a
 * headless test stub is free to pass a fresh array to exercise this
 * function directly without a full fake node).
 */
export function onResizeControls(node, ctx, size) {
  if (isVueNodes()) {
    return; // Nodes 2.0 owns sizing via computeLayoutSize -- don't fight it
  }
  const arr = isSizeLike(size) ? size : node.size;
  if (!isSizeLike(arr)) {
    return;
  }
  if (arr[0] < MIN_W) {
    arr[0] = MIN_W;
  }
  arr[1] = fitNodeH(node, ctx);
  if (arr !== node.size && isSizeLike(node.size)) {
    node.size[0] = arr[0];
    node.size[1] = arr[1];
  }
}

// ---------------------------------------------------------------------------
// Draw-time correction -- the SECOND half of the Class A sizing lock, and (per
// a live ComfyUI measurement) the one that actually does the enforcing.
//
// A live `AnimaControlPanel` (3 rows) was height-dragged and re-measured:
// `onResizeCalls: 0` -- `onResize` never fired at all on that drag path, even
// though it was correctly wired (`onResizeInstalled: true`) and Nodes 2.0 was
// off (`vueNodesMode: false`). Every correction hanging off `onResizeControls`
// alone is dead code on that path -- exactly the caveat the reference already
// carries for the SAME reason (`../ComfyUI-Pixaroma/js/lora_loader/index.js`'s
// own comment on its `onDrawForeground` clamp: "onResize does not fire on
// every legacy resize path" -- `pixaroma-review-rounds-plan.md` item 11).
// `onDrawForeground` is litegraph's PER-FRAME draw hook, so it survives both
// "onResize never fired" and "litegraph re-applied the dragged size
// afterwards" -- there is no resize PATH to miss, because this doesn't hook a
// path at all, it re-asserts the invariant on every paint regardless of how
// the wrong size got there.
//
// `onResizeControls` stays wired for the paths where it DOES fire (other
// frontends/renderer builds) -- this is belt-and-braces alongside it, matching
// the reference having both, not a replacement for it.
// ---------------------------------------------------------------------------

/**
 * `onDrawForeground(ctx)` -- called every time litegraph paints the node.
 * Enforces Class A unconditionally: `size[1]` is always `fitNodeH`'s answer
 * (the SAME single authority `fitNode`/`onResizeControls` already use, never
 * a second formula), `size[0]` is floored at `MIN_W`, never anything else.
 *
 * MUST be cheap -- this runs every frame, for every Class A node on the
 * canvas. It writes `node.size` directly (never `setSize`) and ONLY the
 * entries that are actually wrong -- comparing before assigning, exactly like
 * `onResizeControls`'s own width floor already does. It never calls
 * `setDirtyCanvas`: this hook fires FROM a draw that's already happening, so
 * marking dirty here would just schedule ANOTHER draw, which would call this
 * hook again, which would dirty again -- a per-frame `setDirtyCanvas` here is
 * an infinite repaint loop, not a fix.
 *
 * Bails on the load path exactly like `fitNode` (`node._ctrlConfiguring` OR
 * `ctx.isGraphLoading()`) -- unlike `onResize` (which only ever fires from a
 * live resize-drag, never during a load), `onDrawForeground` genuinely CAN
 * run while a load is still settling (e.g. a background tab's canvas
 * repainting while `isGraphLoading()`'s trailing window is still open), so
 * this is the one Class A hook that has to carry that guard itself rather
 * than relying on "this path never fires on load" the way `onResizeControls`
 * can. Skipping the guard here would risk rewriting a freshly-opened, clean
 * workflow's saved size mid-load and flagging it "modified" -- the exact
 * failure mode every other load-path guard in this file exists to prevent.
 *
 * LEGACY ONLY (`isVueNodes()` bails): Nodes 2.0 owns sizing through
 * `computeLayoutSize`, same reasoning as `onResizeControls`'s own doc
 * comment.
 */
export function onDrawForegroundControls(node, ctx) {
  if (isVueNodes()) {
    return; // Nodes 2.0 owns sizing via computeLayoutSize -- don't fight it
  }
  if (node._ctrlConfiguring || (ctx && typeof ctx.isGraphLoading === "function" && ctx.isGraphLoading())) {
    return; // a workflow load may still be settling -- trust node.size
  }
  if (!isSizeLike(node.size)) {
    return;
  }
  if (node.size[0] < MIN_W) {
    node.size[0] = MIN_W;
  }
  const h = fitNodeH(node, ctx);
  if (node.size[1] !== h) {
    node.size[1] = h;
  }
}

// ---------------------------------------------------------------------------
// setSize wrap -- the THIRD hook Class A needs, and the one that stops the
// visible mid-drag stretch `onResizeControls`/`onDrawForegroundControls`
// only ever correct AFTER the fact.
//
// Decompiling the actually-installed `comfyui_frontend_package` **1.47.10**
// (`static/assets/promotionUtils-DzZo8o5W.js`), legacy litegraph's own
// resize-drag handler is:
//
//   let l = n.computeSize();
//   c.width  < l[0] && (..., c.width  = l[0]),
//   c.height < l[1] && (..., c.height = l[1]),
//   n.pos = c.pos, n.setSize(c.size), this._dirty()
//
// Two facts fall out of that, and together they're why `onResize` could
// never be made to work here (`onResizeControls`'s own doc comment has the
// live measurement: `onResizeCalls: 0` on an actual height drag):
//
// 1. Litegraph clamps BOTH axes to `computeSize()` as MINIMUMS only -- there
//    is no maximum, so nothing upstream stops a height DRAG from going
//    taller than content. That headroom is the whole defect: a floor alone
//    (what `computeSize` already provides) permits growing past content,
//    never forbids it.
// 2. `n.setSize(c.size)` runs on EVERY DRAG FRAME, and it runs BEFORE
//    `this._dirty()` -- i.e. before the repaint that would otherwise show
//    the node holding the dragged (too-tall) size for that frame.
//    `onResize` is never called on this path at all, and `onDrawForeground`
//    (a genuine per-frame hook) still only ever runs AFTER litegraph has
//    already written the dragged size and asked for a repaint -- so both of
//    them correct the node back to content height ONE FRAME LATE, which is
//    exactly the "stretches, then snaps back" the owner asked to close.
//    `setSize` itself is the one call that sits BEFORE that paint decision,
//    which is why wrapping it (not `onResize`) is the fix.
// ---------------------------------------------------------------------------

/**
 * Wrap `node.setSize` so Class A's height lock lands at the point of
 * assignment, pre-paint, rather than only being corrected after the fact by
 * `onResizeControls`/`onDrawForegroundControls` (both kept -- see their own
 * doc comments; this is defence in depth alongside them, not a replacement:
 * `onResizeControls` still matters for a build/path where `onResize` DOES
 * fire, and `onDrawForegroundControls` remains the backstop for any code
 * path that writes `node.size` directly and never goes through `setSize` at
 * all).
 *
 * Wraps, never reimplements: captures whatever `node.setSize` already is
 * (the fake node's own bookkeeping under test, litegraph's real
 * implementation live) and always delegates to it for the actual write --
 * this function only decides WHAT size to hand it.
 *
 * Guarded exactly like `onResizeControls`/`onDrawForegroundControls`: a bare
 * pass-through under `isVueNodes()` (Nodes 2.0 owns sizing via
 * `computeLayoutSize`, don't fight it) and under `node._ctrlConfiguring`/
 * `ctx.isGraphLoading()` (a load must never be fought -- litegraph itself
 * can call `setSize` while restoring a saved node, and `restoreNodeSize`,
 * above, already writes `node.size` directly rather than through this
 * wrapper for the identical reason: some call sites need to bypass the
 * clamp chain entirely, not merely have it no-op).
 *
 * Mutates the incoming `size` array's ENTRIES in place, never replaces the
 * reference -- the same convention `onResizeControls` already uses for its
 * own `size` parameter (a caller may have passed `node.size` itself; handing
 * back a different array object would desync it from whatever the caller
 * still holds a reference to).
 *
 * Verified as a no-op on `fitNode`'s own call: `fitNode` calls
 * `node.setSize([w, h])` with `h` already `fitNodeH`'s answer, so the clamp
 * below recomputes the exact SAME number (`fitNodeH` is pure given the
 * node's current rows/`computeSize`) and writes it back unchanged -- a
 * verified no-op, not a double correction. No recursion either: `original`
 * is the REAL captured method, called directly, never `node.setSize` (i.e.
 * never this wrapper) again.
 */
export function wrapSetSizeControls(node, ctx) {
  if (typeof node.setSize !== "function") {
    return; // nothing to wrap -- a stub/renderer without setSize at all
  }
  const original = node.setSize.bind(node);
  node.setSize = function setSizeControls(size) {
    if (isVueNodes() || node._ctrlConfiguring || (ctx && typeof ctx.isGraphLoading === "function" && ctx.isGraphLoading())) {
      return original(size); // Nodes 2.0, or a load in flight -- never fight either
    }
    const arr = isSizeLike(size) ? size : null;
    if (!arr) {
      return original(size); // not a [w, h]-shaped call -- pass through untouched
    }
    if (arr[0] < MIN_W) {
      arr[0] = MIN_W;
    }
    arr[1] = fitNodeH(node, ctx);
    return original(arr);
  };
}

/**
 * The load-path counterpart to `onResizeControls`: `onResize` only ever
 * fires from a LIVE resize-drag, so it can never correct a workflow saved by
 * an OLDER build of this file (before this fix landed) or a hand-edited one
 * whose saved height simply disagrees with its own row count -- Class A's
 * "height is never user-owned" invariant has to hold across a restore too,
 * not just a live drag.
 *
 * Rewrites `node.size[1]` ONLY -- WIDTH is left completely untouched,
 * deliberately NOT routed through `onResizeControls` (which also floors
 * width as belt-and-braces): the pre-existing "never rewrite width on load"
 * rule (`restoreNode`'s own doc comment, `index.js`) must keep holding even
 * while this corrects height; a saved width below `MIN_W` is a separate,
 * pre-existing gap this dispatch does not touch.
 *
 * On an ALREADY-CONSISTENT workflow (saved by this same, already-fixed
 * build) this is a genuine no-op: `fitNodeH` recomputes the exact number the
 * workflow was saved with, so `node.size[1]` is assigned its own current
 * value and nothing about the restore visibly changes. It only actually
 * changes anything for a workflow whose saved height predates this fix (or
 * was hand-edited) -- exactly the case this exists to correct, and exactly
 * the same "a clean, already-current workflow is safe without any extra
 * guard, an inconsistent one gets healed" reasoning `syncOutputs`'s own doc
 * comment already gives for `node.outputs.length` vs. `maxSlot`.
 */
export function applyContentHeight(node, ctx) {
  if (!isSizeLike(node.size)) {
    return;
  }
  node.size[1] = fitNodeH(node, ctx);
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

/**
 * Queue a `fitNode` call for the next animation frame, never synchronously.
 *
 * `node._ctrlConfiguring` ALONE is not a reliable guard at the moment this
 * rAF actually FIRES, even though it reads as one: `index.js`'s
 * `onConfigure` wrapper sets it SYNCHRONOUSLY at the top and clears it in a
 * `.finally()` chained off the same `loadMods()` promise `setupNode`'s own
 * call site rides -- and since ALL of that (the `.then`/`.catch`/`.finally`
 * callbacks) runs as plain microtasks, it fully drains and the flag is very
 * likely already back to `false` well before the browser gets around to
 * firing THIS rAF callback (a real animation frame, not a microtask, is the
 * next thing after the microtask queue empties). So a node genuinely still
 * being restored can reach this callback with `node._ctrlConfiguring`
 * already cleared. `fitNode`'s own guard (above) re-checks BOTH flags at the
 * moment it actually runs -- i.e. at rAF-fire-time, not at schedule-time --
 * which is what closes this exact race; nothing extra is needed here, and
 * that's precisely why the check moved off this function and onto `fitNode`
 * itself: putting it here only, as before, protected calls that go through
 * `scheduleFit` but not a hypothetical direct `fitNode` call anywhere else.
 */
export function scheduleFit(node, ctx) {
  if (typeof requestAnimationFrame !== "function") {
    return;
  }
  requestAnimationFrame(() => fitNode(node, ctx));
}

// ---------------------------------------------------------------------------
// Structural mutations (add / duplicate / remove) -- always persist, then
// resync rows (which resyncs outputs + realigns), then refit.
// ---------------------------------------------------------------------------

export function addRowAndSync(node, ctx, kind) {
  const state = ensureState(node, ctx);
  const row = addRow(state, kind, ctx.panelConfig.key);
  if (!row) {
    return null;
  }
  persistState(node, ctx);
  syncRows(node, ctx);
  scheduleFit(node, ctx);
  return row;
}

export function duplicateRowAndSync(node, ctx, rowId) {
  const state = ensureState(node, ctx);
  const row = duplicateRow(state, rowId, ctx.panelConfig.key);
  if (!row) {
    return null;
  }
  persistState(node, ctx);
  syncRows(node, ctx);
  scheduleFit(node, ctx);
  return row;
}

/** Remove the row with id `rowId`. If its output slot currently has a real
 * link, `ctx.confirmRemove(row)` is consulted first (design doc §3/§4: "the
 * only removal path for rows without a ⚙" — a link must never silently
 * vanish). Returns `true` if the row was actually removed. */
export function removeRowAndSync(node, ctx, rowId) {
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.id === rowId);
  if (row && Number.isFinite(row.slot) && node.outputs) {
    const out = node.outputs[row.slot - 1];
    const hasLink = out && Array.isArray(out.links) && out.links.length > 0;
    if (hasLink && typeof ctx.confirmRemove === "function" && !ctx.confirmRemove(row)) {
      return false;
    }
  }
  const ok = removeRow(state, rowId);
  if (!ok) {
    return false;
  }
  persistState(node, ctx);
  syncRows(node, ctx);
  scheduleFit(node, ctx);
  return true;
}

// ---------------------------------------------------------------------------
// Auto rows -- resolve on first user connection (docs/control-panel-
// design.md §6). `index.js`'s `onConnectionsChange` hook is the only caller,
// gated there on `!isGraphLoading() && !configuring` so a workflow's link
// replay on load can never rewrite a saved kind.
// ---------------------------------------------------------------------------

/**
 * @param {object} node
 * @param {object} ctx - needs `ctx.describeLinkTarget(link)` (browser/graph
 *   specific — inspects the actual downstream node/widget; see `index.js`)
 *   and `ctx.getKnownLists()`.
 * @param {number} slotIndex - the OUTPUT index (0-based) that was just
 *   connected — mapped back to the row that owns `slot === slotIndex + 1`.
 * @param {object} link - the litegraph link object.
 * @returns {boolean} whether a row was actually resolved.
 */
export function resolveAutoOnConnect(node, ctx, slotIndex, link) {
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.slot === slotIndex + 1);
  if (!row || row.kind !== "auto" || !link) {
    return false;
  }
  const target = typeof ctx.describeLinkTarget === "function" ? ctx.describeLinkTarget(link) : null;
  if (!target) {
    return false;
  }
  const allowedKinds = new Set(ctx.panelConfig.catalog);
  const resolved = resolveAutoKind(target, {
    allowedKinds,
    knownLists: ctx.getKnownLists ? ctx.getKnownLists() : {},
  });
  if (!applyResolvedKind(row, resolved)) {
    return false;
  }
  persistState(node, ctx);
  syncRows(node, ctx);
  scheduleFit(node, ctx);
  return true;
}
