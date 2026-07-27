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
} from "./rows.mjs";

import {
  injectStyles,
  buildRowElement,
  buildAddRow,
  paintRow,
  openOverlay,
  bodyHeight,
  ROW_H,
  ROW_GAP,
  MIN_W,
  DEFAULT_W,
} from "./render.mjs";

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

function openListMenuFor(node, ctx, row, refs) {
  closeActiveOverlay();
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
  const handle = openOverlay(doc, refs.root, menu, "below", () => {
    refs.root.classList.remove("wtn-ctl-open");
    if (_activeOverlay === handle) {
      _activeOverlay = null;
    }
  });
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
    if (typeof e.target.closest === "function" && e.target.closest(".wtn-ctl-gear")) {
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

function openGearPopover(node, ctx, row, refs) {
  closeActiveOverlay();
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
  const handle = openOverlay(doc, refs.root, content, "right", () => {
    refs.gear.classList.remove("wtn-ctl-active");
    refs.root.classList.remove("wtn-ctl-open");
    if (_activeOverlay === handle) {
      _activeOverlay = null;
    }
  });
  _activeOverlay = handle;
  refs.gear.classList.add("wtn-ctl-active");
  refs.root.classList.add("wtn-ctl-open");
}

// ---------------------------------------------------------------------------
// Right-click menu: Duplicate + Remove row -- the ONLY removal path for a
// row with no ⚙ (int/float/sampler/scheduler/vae), so it isn't optional.
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

function openContextMenuFor(node, ctx, row, refs) {
  closeActiveOverlay();
  const doc = ctx.doc;
  const menu = el(doc, "div", "wtn-ctl-menu wtn");
  const head = el(doc, "div", "wtn-ctl-mhead");
  head.textContent = row.name || row.kind;
  menu.appendChild(head);

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

  const handle = openOverlay(doc, refs.root, menu, "below", () => {
    refs.root.classList.remove("wtn-ctl-open");
    if (_activeOverlay === handle) {
      _activeOverlay = null;
    }
  });
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

function openAddMenu(node, ctx, addRefs) {
  closeActiveOverlay();
  const doc = ctx.doc;
  const menu = el(doc, "div", "wtn-ctl-menu wtn");
  const head = el(doc, "div", "wtn-ctl-mhead");
  head.textContent = "Add a control";
  menu.appendChild(head);

  const kinds = [...ctx.panelConfig.catalog, ...(ctx.panelConfig.allowAuto ? ["auto"] : [])];
  kinds.forEach((kind) => {
    const meta = KIND_META[kind];
    const opt = el(doc, "div", "wtn-ctl-opt");
    opt.textContent = meta.menu;
    const hint = el(doc, "span", "wtn-ctl-hint");
    hint.textContent = kind === "auto" ? "decided by the first wire" : (meta.outputType === "combo" ? "COMBO" : meta.outputType);
    opt.appendChild(hint);
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      closeActiveOverlay();
      addRowAndSync(node, ctx, kind);
    });
    menu.appendChild(opt);
  });

  const handle = openOverlay(doc, addRefs.root, menu, "below", () => {
    if (_activeOverlay === handle) {
      _activeOverlay = null;
    }
  });
  _activeOverlay = handle;
}

// ---------------------------------------------------------------------------
// Row wiring dispatch
// ---------------------------------------------------------------------------

function wireRow(node, ctx, row, refs) {
  wireGrip(node, ctx, row, refs);
  wireContextMenu(node, ctx, row, refs);
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

function removeRowWidgets(node) {
  const existing = node._ctrlRows || [];
  if (node.widgets) {
    for (const entry of existing) {
      const idx = node.widgets.indexOf(entry.widget);
      if (idx >= 0) {
        node.widgets.splice(idx, 1);
      }
    }
    if (node._ctrlAddWidget) {
      const addIdx = node.widgets.indexOf(node._ctrlAddWidget);
      if (addIdx >= 0) {
        node.widgets.splice(addIdx, 1);
      }
    }
  }
  node._ctrlRows = [];
  node._ctrlAddWidget = null;
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
      entries.push({ id: row.id, kind: row.kind, widget, refs });
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
 * Keep `node.outputs` sized to the HIGHEST slot currently in use (never to
 * `rows.length` — see `rows.mjs`'s module doc comment: slot is a durable
 * output-array INDEX, not a display position). A freed slot below the
 * current max is intentionally left as an inert `"*"`-typed gap (falls back
 * to litegraph's normal top-right auto-stacking, since `alignOutputsLegacy`
 * below only parks `.pos` for indices a row actually owns) rather than
 * shifting every higher index down, which would be a silent renumber.
 *
 * VERIFY-IN-COMFYUI: a freed-but-not-yet-reused slot's gap output currently
 * renders wherever litegraph's default output stacking puts an
 * unpositioned slot (its usual top-right column) — acceptable since
 * `assignSlot` (rows.mjs) always reuses the lowest free slot first, so a
 * gap is normally short-lived, but this exact visual has only been reasoned
 * through here, not seen live.
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

  const lists = ctx.getKnownLists ? ctx.getKnownLists() : {};
  state.rows.forEach((row) => {
    const idx = row.slot - 1;
    const out = node.outputs[idx];
    if (!out) {
      return;
    }
    if (out.name !== ZW) {
      out.name = ZW;
    }
    if (out.label !== ZW) {
      out.label = ZW;
    }
    const t = outputTypeForRow(row, lists);
    if (out.type !== t) {
      out.type = t;
    }
  });

  alignOutputsLegacy(node);
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
