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
  openOverlay,
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
// `rows.mjs`/`render.mjs` already are -- no 404 risk.
import { installCanvasZoomPassthrough } from "../shared/canvas_zoom.mjs";

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
// Single-overlay-at-a-time bookkeeping (option list / ⚙ popover / context
// menu / add-catalog menu all share this) -- mirrors
// `js/prompt_rules/node/picker.mjs`'s single-instance pattern.
// ---------------------------------------------------------------------------

let _activeOverlay = null;

export function closeActiveOverlay() {
  if (_activeOverlay) {
    _activeOverlay.close();
    _activeOverlay = null;
  }
}

/**
 * The toggle primitive every per-row overlay opener (option list / ⚙
 * popover / right-click menu) uses: close the active overlay ONLY IF it's
 * the one identified by `key` (each opener's own `${kind}:${row.id}` --
 * see `openListMenuFor`/`openGearPopover`/`openContextMenuFor` below),
 * returning whether it actually closed anything.
 *
 * THIS is the toggle -- not the document-level outside-click/Escape
 * listener in `render.mjs`'s `openOverlay`. That listener already correctly
 * ignores a pointerdown whose target is inside `anchorEl` (every opener
 * here passes the ROW's own root as the anchor), so a second click on the
 * SAME field was NEVER being closed by a stray outside-click race in the
 * first place -- the actual bug was that every opener unconditionally
 * called `closeActiveOverlay()` THEN immediately opened a brand-new overlay
 * on every click, with no memory of "is this exact field's overlay already
 * the one that's open". Two clicks on the same field: close (whatever's
 * open, including itself) -> reopen fresh -- net visible effect "nothing
 * happened" (still open), not an actual close. `ownerKey` is the fix: each
 * opener checks it FIRST and, if it matches, closes and stops -- no reopen.
 */
function closeOverlayIfOwnedBy(key) {
  if (_activeOverlay && _activeOverlay.ownerKey === key) {
    closeActiveOverlay();
    return true;
  }
  return false;
}

/**
 * `openOverlay` (render.mjs), plus wheel-zoom passthrough on the overlay
 * element itself -- ONE choke point for every overlay this node ever opens
 * (option list, ⚙ popover, row context menu, add-catalog menu), so wheeling
 * over any of them zooms the canvas same as wheeling over a row, EXCEPT over
 * a genuinely scrollable child that still has room (the option list's own
 * `.wtn-ctl-menu`/the latent popover's `.wtn-ctl-reslist`, both
 * `overflow-y: auto` -- `scrollRegionWantsWheel` finds them by walking up
 * from the wheel's actual target, so they keep scrolling normally).
 * `ctx.getCanvasEl` is `index.js`'s real `app.canvas.canvas` getter (or
 * `undefined` under test, where `installCanvasZoomPassthrough` harmlessly
 * falls back to never finding a canvas to dispatch to).
 */
function openOverlayWithZoom(ctx, doc, anchorEl, contentEl, placement, onClose) {
  const handle = openOverlay(doc, anchorEl, contentEl, placement, onClose);
  const uninstallZoom = installCanvasZoomPassthrough(handle.overlay, ctx.getCanvasEl);
  const origClose = handle.close;
  handle.close = () => {
    uninstallZoom();
    origClose();
  };
  return handle;
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

function wireComboRow(node, ctx, row, refs) {
  const cycle = (dir) => {
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
    closeOverlayIfOwnedBy(`list:${row.id}`);
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
    openListMenuFor(node, ctx, row, refs);
  });
}

/** Opens (or, on a second click of the SAME field, closes) this row's
 * option-list menu -- see `closeOverlayIfOwnedBy`'s doc comment for why the
 * toggle has to be decided HERE rather than left to the outside-click
 * dismiss listener. */
function openListMenuFor(node, ctx, row, refs) {
  const key = `list:${row.id}`;
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this field's own menu was open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT field's overlay was open -- switch to this one
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
      row.value = opt;
      closeActiveOverlay();
      afterEdit(node, ctx);
    });
    menu.appendChild(optEl);
  });
  const handle = openOverlayWithZoom(ctx, doc, refs.root, menu, "below", () => {
    refs.root.classList.remove("wtn-ctl-open");
    if (_activeOverlay === handle) {
      _activeOverlay = null;
    }
  });
  handle.ownerKey = key;
  _activeOverlay = handle;
  refs.root.classList.add("wtn-ctl-open");
}

function wireSeedRow(node, ctx, row, refs) {
  refs.modeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
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

function wireNumericRow(node, ctx, row, refs) {
  let dragging = false;
  const setFromClientX = (clientX) => {
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

function wireGear(node, ctx, row, refs) {
  if (!refs.gear) {
    return;
  }
  refs.gear.addEventListener("click", (e) => {
    e.stopPropagation();
    openGearPopover(node, ctx, row, refs);
  });
}

/** Opens (or, on a second click of the SAME row's ⚙, closes) that row's
 * settings popover -- same toggle contract as `openListMenuFor` above. */
function openGearPopover(node, ctx, row, refs) {
  const key = `gear:${row.id}`;
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this row's own popover was open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT overlay was open -- switch to this one
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
    if (_activeOverlay === handle) {
      _activeOverlay = null;
    }
  });
  handle.ownerKey = key;
  _activeOverlay = handle;
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
 * openContextMenuFor is the discoverable path to the same `beginRename`). */
function wireRename(node, ctx, row, refs) {
  refs.name.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    beginRename(node, ctx, row, refs);
  });
}

// ---------------------------------------------------------------------------
// Right-click menu: Rename + Duplicate + Remove row -- Remove is the ONLY
// removal path for a row with no ⚙ (int/float/sampler/scheduler/vae), so
// it isn't optional; Rename is the discoverable path for every kind (see
// the section above).
// ---------------------------------------------------------------------------

function wireContextMenu(node, ctx, row, refs) {
  refs.root.addEventListener("contextmenu", (e) => {
    if (typeof e.preventDefault === "function") {
      e.preventDefault();
    }
    e.stopPropagation();
    openContextMenuFor(node, ctx, row, refs);
  });
}

/** Opens (or, on a second right-click of the SAME row, closes) that row's
 * right-click menu -- same toggle contract as `openListMenuFor`/
 * `openGearPopover` above (this one WAS already sharing the same
 * unconditional close-then-reopen bug, confirmed by inspection: nothing
 * about `contextmenu` made it any different from `click`). */
function openContextMenuFor(node, ctx, row, refs) {
  const key = `context:${row.id}`;
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this row's own context menu was open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT overlay was open -- switch to this one
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
    beginRename(node, ctx, row, refs);
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
    duplicateRowAndSync(node, ctx, row.id);
  });
  menu.appendChild(dup);

  const del = el(doc, "div", "wtn-ctl-opt");
  del.textContent = "Remove row";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
    removeRowAndSync(node, ctx, row.id);
  });
  menu.appendChild(del);

  const handle = openOverlayWithZoom(ctx, doc, refs.root, menu, "below", () => {
    refs.root.classList.remove("wtn-ctl-open");
    if (_activeOverlay === handle) {
      _activeOverlay = null;
    }
  });
  handle.ownerKey = key;
  _activeOverlay = handle;
  refs.root.classList.add("wtn-ctl-open");
}

// ---------------------------------------------------------------------------
// Drag-to-reorder grip (Control Panel only -- render.mjs only builds a grip
// when `panelConfig.reorder` is true).
// ---------------------------------------------------------------------------

function wireGrip(node, ctx, row, refs) {
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

    const state = ensureState(node, ctx);
    const snapshot = state.rows.slice();
    const fromIndex = snapshot.findIndex((r) => r.id === row.id);
    if (fromIndex < 0) {
      return;
    }
    const startY = e.clientY;
    const step = ROW_H + ROW_GAP;
    refs.root.classList.add("wtn-ctl-dragging");

    const onMove = (ev) => {
      const delta = Math.round((ev.clientY - startY) / step);
      const newOrder = reorderRows(snapshot, fromIndex, fromIndex + delta);
      if (newOrder.some((r, i) => r !== state.rows[i])) {
        state.rows = newOrder;
        applyReorderLive(node, newOrder.map((r) => r.id));
        alignOutputsLegacy(node);
        if (typeof node.setDirtyCanvas === "function") {
          node.setDirtyCanvas(true, true);
        }
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
    if (_activeOverlay === handle) {
      _activeOverlay = null;
    }
  });
  handle.ownerKey = key;
  _activeOverlay = handle;
}

// ---------------------------------------------------------------------------
// Row wiring dispatch
// ---------------------------------------------------------------------------

function wireRow(node, ctx, row, refs) {
  wireGrip(node, ctx, row, refs);
  wireContextMenu(node, ctx, row, refs);
  wireRename(node, ctx, row, refs);
  wireGear(node, ctx, row, refs);
  const kindMeta = KIND_META[row.kind] || KIND_META.auto;
  if (row.kind === "auto") {
    return;
  }
  if (isPickerKind(kindMeta)) {
    wireComboRow(node, ctx, row, refs);
  } else if (row.kind === "seed") {
    wireSeedRow(node, ctx, row, refs);
  } else if (row.kind === "int" || row.kind === "float") {
    wireNumericRow(node, ctx, row, refs);
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
 * row's own output dot class/title and the "+ Add" strip's disabled state. */
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
          // installed list) has nothing valid to show -- adopt the first
          // option, same as a real ComfyUI combo widget always showing SOME
          // current value rather than a blank one.
          row.value = optionList[0];
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
      });
      widget.serialize = false;
      if (widget.options) {
        widget.options.serialize = false;
      }
      widget.computeSize = () => [node.size[0], ROW_H];
      widget.computeLayoutSize = () => ({ minHeight: ROW_H, minWidth: 1 });
      wireRow(node, ctx, row, refs);
      // Wheel-zooms-the-canvas fix (js/shared/canvas_zoom.mjs) -- installed
      // on EVERY row's own root, since this node has no single wrapping body
      // element (one addDOMWidget per row -- see render.mjs's top doc
      // comment), so full coverage means one install per row. Torn down in
      // removeRowWidgets/teardownAllZoomPassthrough above.
      const uninstallZoom = installCanvasZoomPassthrough(refs.root, ctx.getCanvasEl);
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
  });
  addWidget.serialize = false;
  if (addWidget.options) {
    addWidget.options.serialize = false;
  }
  addWidget.computeSize = () => [node.size[0], 28];
  addWidget.computeLayoutSize = () => ({ minHeight: 28, minWidth: 1 });
  addRefs.root.disabled = state.rows.length >= maxRows;
  wireAddRow(node, ctx, addRefs);
  node._ctrlAddWidget = addWidget;
  node._ctrlAddZoomUninstall = installCanvasZoomPassthrough(addRefs.root, ctx.getCanvasEl);

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
    if (node._ctrlRowSig === sig && node._ctrlRows) {
      repaintRows(node, ctx);
    } else {
      node._ctrlRowSig = sig;
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
 * name-disambiguation fix. Tracking is keyed by SLOT NUMBER (`row.slot`), not
 * row id -- a slot is the durable "wire identity" (`rows.mjs`'s module doc
 * comment), and `out.label` is a property of the OUTPUT OBJECT at that slot
 * index, which persists across `assignSlot` handing the same freed slot
 * number to a completely different row later in the same session (see the
 * "reassigned" branch below, and the regression test that caught this: two
 * `int` rows sharing a slot across a remove+re-add produced a spurious
 * "user-owned" label copied from the row that used to be there).
 *
 * Ownership rule (per `rows.mjs`'s `SLOT_LABEL_MODE` doc comment):
 *
 *  - This slot number was just handed to a DIFFERENT row than the one we
 *    last processed it for, WITHIN THIS SESSION (`node._ctrlSlotRowId`
 *    disagrees) -- a hard reset. Whatever text `out.label` currently
 *    carries belongs to whichever row vacated the slot, never to this one,
 *    so it is unconditionally overwritten with this row's own default,
 *    regardless of what it happens to look like.
 *  - Otherwise, `isBlankSlotLabel(out.label)` (a brand-new output with no
 *    label at all, an empty string, the bare `ZW` sentinel, or pure
 *    zero-width junk) OR exactly what we ourselves wrote on a PRIOR call
 *    (tracked in `node._ctrlLastLabel`) -- still OURS to manage. Stamp
 *    `defaultSlotLabel(row)`. This is the branch that makes a plain ROW
 *    RENAME keep updating the slot label on every subsequent sync
 *    (`defaultSlotLabel` re-derives from `row.name`, which just changed)
 *    rather than freezing after the very first write.
 *  - Anything else -- the user set this directly on the socket (litegraph's
 *    own rename-slot dialog; confirmed live to pre-fill with the CURRENT
 *    label, so renaming a ZW-sentinel'd or row-named slot lands as
 *    `${ZW}typed text` / `${oldName}typed text`) -- hand it to
 *    `node._ctrlOwnedLabels` PERMANENTLY for this session (a later row rename
 *    must never silently revert a user's UE-disambiguating name -- that
 *    reversion is the ORIGINAL bug report this function exists to fix). The
 *    only thing still done to it is a ONE-TIME zero-width edge strip
 *    (`stripZeroWidthEdges`), which is what heals the exact `${ZW}typed`
 *    case into a clean value UE can match by name; a label with no such edge
 *    is left byte-for-byte alone.
 *
 * `node._ctrlSlotRowId`/`_ctrlOwnedLabels`/`_ctrlLastLabel` are intentionally
 * NOT persisted (plain node-instance fields, reset every fresh page load) --
 * so on reload a slot with NO prior entry in `_ctrlSlotRowId` (the normal
 * "first sync of a fresh session" case, not a same-session reassignment) is
 * NOT hard-reset -- it falls through to the blank/last-written check above,
 * same as ever: a label that survived the save/reload round trip and
 * doesn't match a freshly-computed `defaultSlotLabel` is treated as the
 * user's, even if it was actually only our own never-touched default from a
 * prior session. That is the deliberately SAFE side to err on:
 * mis-classifying an untouched default as "user-owned" only costs a future
 * row-rename no longer propagating to a label nobody asked to keep in sync;
 * the alternative (mis-classifying a real user rename as still-ours) would
 * silently revert the user's UE-disambiguating name on the very next edit --
 * exactly the bug this function replaces.
 */
function syncSlotLabel(node, row, out) {
  const priorRowId = node._ctrlSlotRowId.get(row.slot);
  const reassignedThisSession = priorRowId !== undefined && priorRowId !== row.id;
  if (reassignedThisSession) {
    node._ctrlOwnedLabels.delete(row.slot);
    node._ctrlLastLabel.delete(row.slot);
  }
  node._ctrlSlotRowId.set(row.slot, row.id);

  const raw = out.label;
  const stillOurs =
    reassignedThisSession ||
    (!node._ctrlOwnedLabels.has(row.slot) && (isBlankSlotLabel(raw) || raw === node._ctrlLastLabel.get(row.slot)));

  if (stillOurs) {
    const want = defaultSlotLabel(row);
    if (out.label !== want) {
      out.label = want;
    }
    node._ctrlLastLabel.set(row.slot, want);
    return;
  }
  node._ctrlOwnedLabels.add(row.slot);
  const cleaned = stripZeroWidthEdges(raw);
  if (cleaned !== raw) {
    out.label = cleaned;
  }
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
 * state.)
 */
export function syncOutputs(node, ctx) {
  const state = ensureState(node, ctx);
  if (!node.outputs) {
    node.outputs = [];
  }
  const maxSlot = state.rows.reduce((m, r) => Math.max(m, Number(r.slot) || 0), 0);

  while (node.outputs.length > maxSlot) {
    const idx = node.outputs.length - 1;
    if (state.rows.some((r) => r.slot === idx + 1)) {
      break; // never shrink past an index a row still owns
    }
    if (typeof node.removeOutput === "function") {
      node.removeOutput(idx);
    } else {
      node.outputs.pop();
    }
  }
  while (node.outputs.length < maxSlot) {
    if (typeof node.addOutput === "function") {
      node.addOutput(ZW, "*");
    } else {
      node.outputs.push({ name: ZW, type: "*" });
    }
  }

  if (!node._ctrlSlotRowId) {
    // slot number -> the row id we last processed THAT SLOT for -- lets
    // `syncSlotLabel` detect "this slot number was just handed to a
    // DIFFERENT row" (a freed slot reused by `assignSlot`) and hard-reset
    // its label bookkeeping instead of misreading the vacated row's
    // leftover text as this row's user-set label.
    node._ctrlSlotRowId = new Map();
  }
  if (!node._ctrlOwnedLabels) {
    // slot numbers whose label the USER set directly on the socket
    // (litegraph's own rename-slot dialog) -- once a slot lands in here it
    // stays forever for this session (until reassigned to a different row,
    // see `syncSlotLabel` below).
    node._ctrlOwnedLabels = new Set();
  }
  if (!node._ctrlLastLabel) {
    // slot number -> the label WE ourselves last wrote -- lets
    // `syncSlotLabel` tell "the user changed this since we last looked"
    // from "still exactly what we stamped it with" without needing to
    // persist anything.
    node._ctrlLastLabel = new Map();
  }

  const lists = ctx.getKnownLists ? ctx.getKnownLists() : {};
  const ownedSlots = new Set();
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
    syncSlotLabel(node, row, out);
    const t = outputTypeForRow(row, lists);
    if (out.type !== t) {
      out.type = t;
    }
  });

  // Every index NOT in `ownedSlots` is an interior "hole" (a slot freed by
  // a row removal, per this function's top doc comment) -- revisit ALL of
  // them, EVERY sync, not just the moment a row is removed: a hole can sit
  // unclaimed for an arbitrary number of syncs before `assignSlot` reuses
  // it, and each of those syncs must keep re-asserting the blank state
  // rather than trusting whatever the previous call left behind.
  for (let idx = 0; idx < node.outputs.length; idx++) {
    if (ownedSlots.has(idx + 1)) {
      continue;
    }
    markSlotVacant(node.outputs[idx], idx + 1);
  }

  alignOutputsLegacy(node);
}

/**
 * Force output index `slot - 1` into the blank, inert state a "hole" (an
 * output no current row owns — see `syncOutputs` above) must be in on
 * every sync, unconditionally — there is no row behind it to own an
 * exception the way `syncSlotLabel` preserves a user's own rename of a
 * LIVE slot.
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
 *  - `out.pos` is deleted outright, not left at whatever the vacated row
 *    last set it to. `alignOutputsLegacy` below only ever WRITES `.pos`
 *    for indices a live row owns, so a hole's stale `.pos` is exactly the
 *    reported bug: a dot parked over the "+ Add control" strip (or
 *    wherever the vacated row's widget last sat). Deleting it hands the
 *    slot back to litegraph's own default output stacking, which never
 *    overlaps our DOM rows or the add strip.
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
  if (out.pos) {
    delete out.pos;
  }
}

/** Park each row's output dot at ITS OWN row widget's Y (legacy litegraph
 * reads `output.pos` verbatim — ported from ComfyUI-Pixaroma's
 * `alignOutputsLegacy`, `js/sliders/ui.mjs`, keyed here by `row.slot - 1`
 * instead of positional index so reordering only moves the dot's Y, never
 * which `node.outputs` entry it is). `w.margin` accounts for legacy's own
 * DOM-widget-element inset (`DEFAULT_MARGIN = 10`): the element paints at
 * `node.pos + margin + widget.y`, while `widget.y` itself carries no
 * margin — omitting it lands the dot ~10px above the row's true center. */
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
    const nx = node.size[0];
    const ny = y + margin + ROW_H * 0.5;
    if (!out.pos || out.pos[0] !== nx || Math.abs(out.pos[1] - ny) > 0.5) {
      out.pos = [nx, ny];
    }
  }
}

// ---------------------------------------------------------------------------
// Resize -- USER ACTIONS ONLY, never on load (per the dynamic-node-frontend
// skill). bodyHeight is pure arithmetic on row count (render.mjs), so this
// never needs to measure the live DOM.
// ---------------------------------------------------------------------------

export function fitNode(node, ctx) {
  const state = ensureState(node, ctx);
  const w = Math.max((node.size && node.size[0]) || DEFAULT_W, MIN_W);
  const h = bodyHeight(state.rows.length);
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

export function scheduleFit(node, ctx) {
  if (typeof requestAnimationFrame !== "function") {
    return;
  }
  requestAnimationFrame(() => {
    if (node._ctrlConfiguring) {
      return; // a workflow load is in flight -- trust the saved node.size
    }
    fitNode(node, ctx);
  });
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
