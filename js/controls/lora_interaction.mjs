/**
 * lora_interaction.mjs — event wiring + node-level orchestration for
 * `AnimaLoraLoader` (`docs/lora-loader-design.md`). `lora_render.mjs` only
 * builds/paints DOM; this module is where clicking, dragging, the state <->
 * hidden-widget handshake, and Class A sizing actually happen — mirrors
 * `js/controls/interaction.mjs`'s own split, adapted for a node with no
 * per-row output sockets (design doc §5) and therefore no `syncOutputs`/
 * `alignOutputsLegacy`/vacant-slot bookkeeping to carry.
 *
 * ## `ctx` — the one object every function here takes
 *
 *   { doc: document (or a stub, under test),
 *     getCanvasEl(): the live LiteGraph canvas element (or undefined),
 *     getCanvasScale(): the live canvas zoom factor, default 1 if absent
 *                       (BUG 15 -- `wireGrip`'s own doc comment below),
 *     isGraphLoading(): boolean }
 *
 * Much smaller than Control's `ctx` (no `panelConfig`/`getKnownLists`/
 * `describeLinkTarget`/`confirmRemove`): this node has one fixed shape, no
 * combo option lists to read from `window.LiteGraph`, and no link-target
 * inspection.
 *
 * ## Why the node-lifecycle orchestration (`setupLoraNode`/`restoreLoraNode`)
 * lives HERE, not in `index.js`
 *
 * Control's `setupNode`/`restoreNode` live in `index.js` because they read
 * `window.LiteGraph.registered_node_types` (`getKnownLists`) and
 * `window.confirm` (`confirmRemove`) — genuinely runtime-only concerns that
 * must stay out of a module the headless test suite imports directly. This
 * node needs NEITHER: no combo lists, no link inspection, no confirm
 * dialog — so its whole lifecycle (mount, restore, resize) is exactly as
 * testable as the rest of this file, and keeping it here (rather than
 * splitting it across two files for no reason) is what the task brief's
 * "litegraph hooks, sizing, drag/FLIP, persist" line means. `index.js`'s
 * sibling dispatch branch for `AnimaLoraLoader` is consequently much
 * thinner than the Control/Loader Panel one: it only wires the litegraph
 * prototype hooks (`onNodeCreated`/`onConfigure`/`onResize`/
 * `onDrawForeground`/`onRemoved`) to call straight into this module.
 *
 * ## ONE `addDOMWidget`, not one per row — see `lora_render.mjs`'s top doc
 * comment for why (no per-row output socket to park).
 *
 * ## Reorder without a rebuild — `syncRows` reuses DOM by row id
 *
 * Control's `applyReorderLive` (`js/controls/interaction.mjs:1082`) exists
 * because Control's normal rebuild path (`rebuildRowWidgets`) tears down and
 * recreates a real `addDOMWidget` per row, which would be destructive (and
 * would drop the dragged row's own pointer capture) if it ran on every
 * `pointermove`. This module's `syncRows` never has that problem: it is
 * ALREADY non-destructive on every call — existing rows are matched by
 * `row.id` and their DOM/listeners are REUSED verbatim; only genuinely new
 * or removed rows cause an element to be built or torn down, and reordering
 * is a plain `appendChild` of the SAME element into its new position
 * (`appendChild` on an existing child MOVES it — no re-creation, no
 * `pointercancel`, no listener loss). So dragging a row just mutates
 * `state.rows`' order (via `reorderRows`, the identical pure helper Control
 * uses) and calls `syncRows` again on every `pointermove` — the "reorder
 * without touching a dragged row's own DOM" outcome `applyReorderLive`
 * exists for, achieved here without needing a second, bespoke function.
 *
 * ## FLIP drag-reorder animation (design doc §1a-iii, Slice 5)
 *
 * `wireGrip`'s `onMove` (below) already mutates `state.rows`' order and
 * calls `syncRows` on every `pointermove` — the FLIP technique bolts onto
 * exactly that point: `captureRowTops` measures every surviving row's
 * CURRENT screen position immediately BEFORE `syncRows` repaints the new
 * order, and `flipRows` (called immediately after) measures again, writes
 * each row's own old-minus-new delta as an inline `transform`, then — one
 * animation frame later — lets `lora_render.mjs`'s own `.wtn-row-flip` CSS
 * class transition that back to zero. Only `transform` is ever touched (this
 * is a DOM widget composited over a canvas; a layout-property transition
 * there would visibly thrash); `prefers-reduced-motion` is handled entirely
 * by that CSS rule's own `@media` query, so there is no JS branch for it
 * here. `stopPropagation` on the pointer handlers (already present, below —
 * `wireGrip` predates this slice) remains load-bearing: without it litegraph
 * steals the gesture and no drag — animated or not — ever starts. The actual
 * capture/inverse-transform/settle mechanic now lives in `js/shared/flip.mjs`
 * (extracted while porting this same animation to the Control/Loader Panel —
 * see that module's own top doc comment); `captureRowTops`/`flipRows` below
 * are thin, track-local wrappers over it.
 *
 * Row COUNT never changes during a reorder (only order does), so the Class A
 * per-frame height correction (`onDrawForegroundLora`, below) has nothing to
 * react to mid-drag — `fitNodeH` reads `state.rows.length`, which `flipRows`
 * never touches, so the floor stays stable throughout (verified, not merely
 * assumed — `test_lora_resize.mjs`'s own "FLIP mid-drag" test asserts
 * `contentHeight`/`fitNodeH` are identical before and after a reorder).
 */

import {
  normalizeState,
  hasSavedRows,
  addRow,
  duplicateRow,
  removeRow,
  setRowOn,
  bumpRowStrength,
  setRowStrength,
  parseTypedStrength,
  toggleMaster,
  allRowsOn,
  onCounts,
  STRENGTH_STEP,
  setSepStrengths,
  setCacheMode,
  setSep,
  setDefaultStrength,
  setStrengthStep,
} from "./lora_state.mjs";

import { reorderRows } from "./rows.mjs";

// FLIP core -- EXTRACTED to js/shared/flip.mjs while porting this exact
// animation to the Control/Loader Panel (`js/controls/interaction.mjs`),
// whose row architecture needs a different "when to measure 'after'" but the
// SAME capture/inverse-transform/settle mechanic -- see that module's own
// top doc comment. `captureRowTops`/`flipRows` below are kept as thin,
// track-local wrappers (same exported names, same call signature) so this
// file's own doc comment/tests/call sites are untouched.
import { captureRowTops as sharedCaptureRowTops, flipRows as sharedFlipRows } from "../shared/flip.mjs";

// `civitai_api.mjs`/`model_picker.mjs` are the track-agnostic pair this
// node's row-menu/name-picker wiring depends on this slice (`docs/
// lora-loader-design.md`'s reuse boundary -- see `civitai_api.mjs`'s own top
// doc comment). Importing THEM from here is the allowed direction; the
// layering guard (`test_model_picker.mjs`) only forbids the reverse.
import { listModels, invalidateList, cachedList } from "./civitai_api.mjs";
import { openModelPicker } from "./model_picker.mjs";
// `model_info.mjs` is the third file in that same reuse boundary (its own
// top doc comment) -- the ⓘ panel Slice 4 wires live below (`openInfoPanelFor`).
import { openModelInfo } from "./model_info.mjs";
// `civitai_search.mjs` is M2's own addition to that same reuse boundary (its
// own top doc comment) -- the header's 🔍 wires it below (`wireHeader`).
import { openCivitaiSearch } from "./civitai_search.mjs";
import {
  openOverlayWithZoom,
  closeActiveOverlay,
  closeOverlayIfOwnedBy,
  closeOverlaysNotAncestorOf,
  activeOverlayRef,
} from "../shared/overlay.mjs";

import {
  injectStyles,
  buildRoot,
  buildRowElement,
  buildSettingsPanel,
  paintRow,
  paintHeader,
  applyNodeChrome,
  contentHeight,
  ROW_H,
  ROW_GAP,
  MIN_W,
  MIN_W_SEP,
  DEFAULT_W,
  WIDGETS_START_Y,
} from "./lora_render.mjs";

// Duck-typed size-pair check -- `node.size` on a live litegraph node is a
// Float64Array VIEW over a Rectangle, NOT a plain Array
// (`Array.isArray(node.size) === false`, measured live) -- see
// `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md` and
// `../shared/size.mjs`'s own top doc comment. Every size guard below uses
// this instead of `Array.isArray` for exactly that reason.
import { isSizeLike } from "../shared/size.mjs";
import { installCanvasZoomPassthrough, isVueNodes } from "../shared/canvas_zoom.mjs";
import { getSetting, setSetting, SETTING_IDS, SETTING_DEFAULTS } from "../shared/settings.mjs";

// Same pack-wide "wheel quiet period" setting Control's own row widgets use
// (`js/controls/interaction.mjs`'s `WHEEL_LOCK_OPTIONS`) -- read LIVE on
// every wheel event via `installCanvasZoomPassthrough`'s own `getLockMs`.
const WHEEL_LOCK_OPTIONS = {
  getLockMs: () => getSetting(SETTING_IDS.WHEEL_QUIET_PERIOD_MS, SETTING_DEFAULTS[SETTING_IDS.WHEEL_QUIET_PERIOD_MS]),
};

// ---------------------------------------------------------------------------
// State <-> hidden widget handshake (dynamic-node-frontend skill: a
// DECLARED, natively-serialized STRING widget -- never graphToPrompt
// injection -- mirrored into node.properties as the live working copy).
// ---------------------------------------------------------------------------

export function getStateWidget(node) {
  return (node.widgets || []).find((w) => w.name === "lora_state");
}

/** Hide `lora_state` from RENDERING only -- it keeps serializing normally
 * (never `w.serialize = false` here; see the dynamic-node-frontend skill's
 * "hide a declared widget that must still serialize" pattern, and
 * `js/controls/index.js`'s identically-shaped `hideStateWidget`).
 *
 * `w.options.hidden = true` is the Nodes 2.0 half of this -- Vue's widget
 * renderer never looks at `w.hidden`/`computeSize`/`inputEl` (all legacy-
 * litegraph-canvas concepts); it derives visibility purely from
 * `widget.options.hidden` (`isWidgetVisible` in the installed
 * `comfyui_frontend_package`'s `assets/promotionUtils-*.js` --
 * `js/controls/index.js`'s own `hideStateWidget` doc comment has the full
 * derivation). Harmless under legacy litegraph, which never reads
 * `options.hidden` for this purpose. */
export function hideStateWidget(node) {
  const w = getStateWidget(node);
  if (!w) {
    return;
  }
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (w.inputEl && w.inputEl.style) {
    w.inputEl.style.display = "none";
  }
  if (!w.options) {
    w.options = {};
  }
  w.options.hidden = true;
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

function writeStateToWidget(node, state) {
  const w = getStateWidget(node);
  if (w) {
    w.value = JSON.stringify(state);
  }
}

/** The live working state for `node`, initializing it from the hidden
 * widget's CURRENT value the first time -- never re-parses on subsequent
 * calls, so row object identities stay stable across repeated calls in the
 * same session (mirrors `interaction.mjs`'s own `ensureState`; unlike the
 * Loader Panel, an empty LoRA stack has nothing to pre-populate -- see
 * `lora_state.mjs`'s `defaultState` doc comment -- so there is no
 * panel-specific default to resolve against here). */
export function ensureState(node, ctx) {
  if (!node.properties) {
    node.properties = {};
  }
  const existing = node.properties.loraState;
  if (existing && Array.isArray(existing.rows)) {
    return existing;
  }
  const raw = parseWidgetValue(node);
  const state = normalizeState(raw);
  node.properties.loraState = state;
  if (!hasSavedRows(raw)) {
    // Python's literal `"{}"` default (a brand-new node) has no `rows` key
    // at all -- write the materialized default straight back so the widget
    // never keeps serializing that literal string while the UI (and
    // `node.properties`) already show real state (the dynamic-node-frontend
    // skill's "declaring the widget is not writing it" trap).
    writeStateToWidget(node, state);
  }
  return state;
}

/** FORCE a fresh parse of the hidden widget's value -- called from
 * `restoreLoraNode` (the `onConfigure` path) so a restored workflow's rows
 * are rebuilt from what was actually saved, not whatever `ensureState` may
 * have already defaulted to during `onNodeCreated`. Same "write the
 * materialized default back if the raw value had no `rows`" contract as
 * `ensureState`, for the identical reason. */
export function restoreStateFromWidget(node, ctx) {
  const raw = parseWidgetValue(node);
  const state = normalizeState(raw);
  if (!node.properties) {
    node.properties = {};
  }
  node.properties.loraState = state;
  if (!hasSavedRows(raw)) {
    writeStateToWidget(node, state);
  }
  return state;
}

/** Mirror the CURRENT state into the hidden widget's `.value` -- call after
 * EVERY mutation (the skill's contract: this is what actually reaches
 * `nodes/controls/lora_loader.py` and what persists into `widgets_values`). */
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

function winOf(ctx) {
  return (ctx && ctx.doc && ctx.doc.defaultView) || (typeof window !== "undefined" ? window : null);
}

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

// ---------------------------------------------------------------------------
// Missing-file marks -- refresh on `R` (Refresh Node Definitions) and
// WebSocket reconnect, the same moments native combos refresh (design doc
// §1a-iii). `index.js`'s refresh hook calls this, then repaints every
// mounted LoRA Loader node it finds (including inside subgraphs) via
// `syncRows` -- this function's OWN job is only the cache side: drop the
// stale `loras` list and force a real re-fetch.
// ---------------------------------------------------------------------------

export function refreshLoraModels() {
  invalidateList("loras");
  return listModels("loras", true);
}

// ---------------------------------------------------------------------------
// Row-level event wiring
// ---------------------------------------------------------------------------

/** Repaint ONE row from current state, without touching any other row or
 * the header -- the cheap path for a value-only edit (strength bump) that
 * never changes row count/order (mirrors `interaction.mjs`'s own
 * `afterEdit` cheap-repaint convention). */
function repaintOne(node, ctx, rowId) {
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.id === rowId);
  const entry = (node._lrRows || []).find((e) => e.id === rowId);
  if (row && entry) {
    paintRow(entry.refs, row, state.sepStrengths);
  }
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

// ---------------------------------------------------------------------------
// FLIP drag-reorder animation (design doc §1a-iii, Slice 5) -- see this
// module's top doc comment for the technique, and js/shared/flip.mjs's own
// top doc comment for why the core mechanic now lives there instead of here.
// Kept as two small, exported (for direct testability, matching every other
// DOM-touching helper in this file, and so existing call sites/tests are
// unaffected) thin wrappers rather than inlined into `wireGrip`'s `onMove`.
// ---------------------------------------------------------------------------

// Matches render.mjs/lora_render.mjs's own '.wtn-row-flip' transition
// duration (.18s) plus a small buffer -- long enough that the class is never
// removed WHILE the transition it enables is still visibly running.
const FLIP_SETTLE_MS = 200;

function loraRowEl(entry) {
  return entry && entry.refs && entry.refs.root;
}

/** Every currently-mounted row's CURRENT top position, keyed by row id --
 * call this BEFORE `syncRows` repaints a reorder, so `flipRows` (below) has
 * an "old" position to diff the "new" one against. Thin wrapper over
 * `js/shared/flip.mjs`'s track-agnostic core. */
export function captureRowTops(node) {
  return sharedCaptureRowTops(node._lrRows, loraRowEl);
}

/**
 * Call AFTER `syncRows` has already repainted the new row order (this
 * track's reorder is a synchronous DOM `appendChild` move -- see this
 * module's top doc comment -- so there is nothing to wait for; contrast
 * `js/controls/interaction.mjs`'s own `flipRows`, which defers this same
 * core by a frame first). Thin wrapper over `js/shared/flip.mjs`'s
 * `flipRows` -- see that module's own doc comment for the full mechanic.
 */
export function flipRows(node, beforeTops) {
  sharedFlipRows(node._lrRows, loraRowEl, beforeTops, { className: "wtn-row-flip", settleMs: FLIP_SETTLE_MS });
}

/**
 * BUG 15 (2026-07-29 owner report): "the drag has an issue, it goes over
 * multiple rows on a small mouse movement" -- confirmed root cause is
 * exactly the owner's hypothesis A, not B:
 *
 *   - `step` (below) IS `ROW_H + ROW_GAP` -- the SAME two constants
 *     `contentHeight()` (`lora_render.mjs`) sums for its own row pitch, so
 *     there is no second, stale copy of the pitch to drift (hypothesis B
 *     does not apply here).
 *   - The actual bug: `ev.clientY` is a SCREEN pixel coordinate, but `step`
 *     is a NODE/graph-space measurement. At any canvas zoom other than
 *     1:1, one row's worth of on-screen pointer movement is `step * scale`
 *     screen pixels -- dividing the raw screen delta by the un-scaled
 *     `step` therefore answers in `scale` rows per row of real movement (2
 *     rows per row at 2x zoom, 3 at 3x). `ctx.getCanvasScale()` (BUG 15's
 *     own new ctx accessor, `js/controls/index.js`) converts the screen
 *     delta into node space FIRST, by dividing it out, before the row-pitch
 *     division happens.
 *
 * **`js/controls/interaction.mjs`'s OWN `wireGrip` (Control Panel) has this
 * EXACT SAME defect** -- it's where this gesture pattern was ported from,
 * and it has the identical `Math.round((ev.clientY - startY) / step)` with
 * no scale division anywhere. Confirmed by reading, not fixed here --
 * that's a separate, scoped change for its own review, not smuggled into
 * this LoRA bugfix pass.
 *
 * The FLIP animation (`flipRows`, called from `onMove` below) is
 * confirmed presentational-only and NOT a contributor: the reorder index
 * (`delta`/`newOrder`) is computed ENTIRELY from `ev.clientY` (pointer
 * geometry) before `syncRows`/`flipRows` ever run: `flipRows` reads
 * `getBoundingClientRect()` only to compute a COSMETIC `transform`, never
 * to decide WHICH rows swap -- so an in-flight FLIP transition can't feed
 * back into the drag math.
 */
function wireGrip(node, ctx, rowId, refs) {
  refs.grip.addEventListener("pointerdown", (e) => {
    const win = winOf(ctx);
    if (!win) {
      return;
    }
    // `stopPropagation` is load-bearing -- without it litegraph steals the
    // gesture and the drag never starts (same lesson `generator-design.md`
    // §7 records for the Preview's hover-wipe, and `js/controls/
    // interaction.mjs`'s own `wireGrip`).
    if (typeof e.preventDefault === "function") {
      e.preventDefault();
    }
    e.stopPropagation();

    const state = ensureState(node, ctx);
    const snapshot = state.rows.slice();
    const fromIndex = snapshot.findIndex((r) => r.id === rowId);
    if (fromIndex < 0) {
      return;
    }
    const startY = e.clientY;
    const step = ROW_H + ROW_GAP;
    refs.root.classList.add("wtn-lora-dragging");

    const onMove = (ev) => {
      // Live-read, not captured once at drag-start -- matches this pack's
      // own "read live, never cache" convention for anything the user could
      // change mid-gesture (a wheel-zoom is technically possible mid-drag).
      const scale = typeof ctx.getCanvasScale === "function" ? ctx.getCanvasScale() : 1;
      const scaleFactor = Number.isFinite(scale) && scale > 0 ? scale : 1;
      const delta = Math.round((ev.clientY - startY) / (step * scaleFactor));
      const newOrder = reorderRows(snapshot, fromIndex, fromIndex + delta);
      if (newOrder.some((r, i) => r !== state.rows[i])) {
        // FLIP: measure BEFORE mutating/repainting (design doc §1a-iii,
        // this module's top doc comment) -- row count never changes here,
        // only order, so the Class A height floor stays stable throughout.
        const beforeTops = captureRowTops(node);
        state.rows = newOrder;
        // Non-destructive -- see this module's top doc comment. `refs.root`
        // (captured at wiring time) is the SAME element that will still be
        // in the DOM afterward, just possibly reordered among its siblings,
        // so re-adding the class after every move is what keeps the lifted
        // look on the row actually being dragged.
        syncRows(node, ctx);
        flipRows(node, beforeTops);
        refs.root.classList.add("wtn-lora-dragging");
      }
    };
    const onUp = () => {
      win.removeEventListener("pointermove", onMove);
      win.removeEventListener("pointerup", onUp);
      refs.root.classList.remove("wtn-lora-dragging");
      persistState(node, ctx);
    };
    win.addEventListener("pointermove", onMove);
    win.addEventListener("pointerup", onUp);
  });
}

/** Opens (or, on a second click of the SAME row's name field, closes) the
 * model picker for this row -- kind LOCKED to `"loras"` (design doc §7c:
 * this node-embedded surface is a picker, it returns a value to the row
 * that opened it, it never browses another kind). */
function openNamePickerFor(node, ctx, rowId, refs) {
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return;
  }
  openModelPicker({
    ctx,
    anchorEl: refs.nameBtn,
    kind: "loras",
    ownerKey: `lora-picker:${rowId}`,
    currentName: row.name || "",
    // Both read HERE (the picker itself never reaches into
    // `../shared/settings.mjs` -- same convention `civitaiEnabled` below
    // already follows for `model_info.mjs`), live on every open so a ⚙
    // dialog change (Slice 5) takes effect the very next time this picker
    // is opened, with no separate change listener needed.
    hideExtension: getSetting(SETTING_IDS.HIDE_FILE_EXTENSION, SETTING_DEFAULTS[SETTING_IDS.HIDE_FILE_EXTENSION]),
    showThumbnails: getSetting(SETTING_IDS.SHOW_PREVIEW_THUMBNAILS, SETTING_DEFAULTS[SETTING_IDS.SHOW_PREVIEW_THUMBNAILS]),
    onPick: (name) => {
      const s = ensureState(node, ctx);
      const r = s.rows.find((entry) => entry.id === rowId);
      if (!r) {
        return;
      }
      r.name = name;
      persistState(node, ctx);
      repaintOne(node, ctx, rowId);
    },
  });
}

/**
 * Opens (or, on a second click of the SAME row's ⓘ/"More info", closes) the
 * ⓘ info panel for this row (`model_info.mjs`, Slice 4) -- track-agnostic,
 * so this function is entirely the "bridge a real row to that generic API"
 * glue `model_info.mjs`'s own top doc comment names: file-derived
 * `triggers`/`base_model` come from the ALREADY-cached `loras` list
 * (`civitai_api.mjs`'s `cachedList`, no network of its own), the Civitai
 * setting is read HERE (`model_info.mjs` never reads it itself -- §7b
 * decision 20), and `onChange` writes the panel's selected/custom words
 * straight back onto this exact row.
 *
 * `browsingLevel` (§7c-iv, "the level governs the ⓘ panel too") -- read HERE
 * the same way, so the panel's identity thumb's Civitai-sourced fallback
 * always reflects whatever the user last set in the search panel's own
 * "Maximum browsing level" select (the two share the SAME user-wide setting,
 * `../shared/settings.mjs`'s `CIVITAI_BROWSING_LEVEL` -- RENAMED from
 * `CIVITAI_SEARCH_LEVEL`, A2, since it governs more than search).
 */
function openInfoPanelFor(node, ctx, rowId, refs) {
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return;
  }
  const entry = cachedList("loras").find((m) => m && m.name === row.name);
  const civitaiEnabled = getSetting(SETTING_IDS.CIVITAI_ENABLED, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_ENABLED]);
  const showThumbnails = getSetting(SETTING_IDS.SHOW_PREVIEW_THUMBNAILS, SETTING_DEFAULTS[SETTING_IDS.SHOW_PREVIEW_THUMBNAILS]);
  const browsingLevel = getSetting(SETTING_IDS.CIVITAI_BROWSING_LEVEL, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_BROWSING_LEVEL]);
  openModelInfo({
    ctx,
    anchorEl: refs.info,
    kind: "loras",
    name: row.name || "",
    ownerKey: `lora-info:${rowId}`,
    baseModel: (entry && entry.base_model) || "",
    fileTriggers: (entry && entry.triggers) || [],
    customTriggers: Array.isArray(row.customTriggers) ? row.customTriggers : [],
    selectedTriggers: Array.isArray(row.triggers) ? row.triggers : [],
    civitaiEnabled,
    showThumbnails,
    browsingLevel,
    onChange: (nextSelected, nextCustom) => {
      const s = ensureState(node, ctx);
      const r = s.rows.find((entry2) => entry2.id === rowId);
      if (!r) {
        return;
      }
      r.triggers = nextSelected;
      r.customTriggers = nextCustom;
      persistState(node, ctx);
    },
  });
}

/**
 * The row's right-click menu (design doc §1a-iii, decision 23): `More info`
 * (Slice 4: opens the ⓘ panel, same as clicking the row's own ⓘ) ·
 * `Duplicate` · `Disable`/`Enable` (label reflects the row's CURRENT `on`
 * state, so the menu never offers an action that's already true) ·
 * `Remove`. Only the two reorder arrows are dropped -- rows reorder by drag
 * (§1a-iii). Toggles closed on a second right-click of the SAME row, same
 * convention as `js/controls/interaction.mjs`'s own `openContextMenuFor`.
 */
function openRowMenuFor(node, ctx, rowId, refs) {
  const key = `lora-row-menu:${rowId}`;
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this row's own menu was already open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT overlay was open -- switch to this one
  const state = ensureState(node, ctx);
  const row = state.rows.find((r) => r.id === rowId);
  if (!row) {
    return;
  }
  const doc = ctx.doc;

  const menu = el(doc, "div", "wtn-ctl-menu wtn");
  const head = el(doc, "div", "wtn-ctl-mhead");
  head.textContent = row.name || "(no LoRA picked)";
  menu.appendChild(head);

  const info = el(doc, "div", "wtn-ctl-opt");
  info.textContent = "More info";
  info.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
    openInfoPanelFor(node, ctx, rowId, refs);
  });
  menu.appendChild(info);

  const dup = el(doc, "div", "wtn-ctl-opt");
  dup.textContent = "Duplicate";
  dup.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
    duplicateRow(state, rowId);
    persistState(node, ctx);
    syncRows(node, ctx);
  });
  menu.appendChild(dup);

  const toggle = el(doc, "div", "wtn-ctl-opt");
  toggle.textContent = row.on ? "Disable" : "Enable";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
    setRowOn(state, rowId, !row.on);
    persistState(node, ctx);
    syncRows(node, ctx);
  });
  menu.appendChild(toggle);

  const del = el(doc, "div", "wtn-ctl-opt wtn-ctl-opt-danger");
  del.textContent = "Remove";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
    removeRow(state, rowId);
    persistState(node, ctx);
    syncRows(node, ctx);
  });
  menu.appendChild(del);

  const handle = openOverlayWithZoom(ctx.getCanvasEl, doc, refs.root, menu, "below", () => {
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  }, "wtn-ctl-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
}

function wireRowMenu(node, ctx, rowId, refs) {
  refs.root.addEventListener("contextmenu", (e) => {
    if (typeof e.preventDefault === "function") {
      e.preventDefault();
    }
    e.stopPropagation();
    openRowMenuFor(node, ctx, rowId, refs);
  });
}

/** Wires the parts of a row: the drag grip, the name field (opens the model
 * picker) and its right-click menu, the strength ▲▼ steppers (model AND
 * clip -- the clip pair only ever matters visibly once the ⚙ dialog's
 * "Show two strengths per row" is on, §7b, but both are always wired so
 * flipping that setting needs no re-wiring), the on/off switch, and (Slice 4)
 * ⓘ -- opens the info panel, same as the row menu's "More info". */
function wireRow(node, ctx, rowId, refs) {
  wireGrip(node, ctx, rowId, refs);
  wireRowMenu(node, ctx, rowId, refs);

  refs.nameBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openNamePickerFor(node, ctx, rowId, refs);
  });

  refs.info.addEventListener("click", (e) => {
    e.stopPropagation();
    openInfoPanelFor(node, ctx, rowId, refs);
  });

  // `state.strengthStep` (§7b "Strength step (arrows)", Slice 5) is what the
  // ▲▼ arrows actually move by -- falls back to the pack-wide `STRENGTH_STEP`
  // constant for a state saved before the field existed (same tolerance
  // `normalizeState` itself applies; belt-and-braces here too since a caller
  // could hand this a raw, not-yet-normalized object).
  function bump(field, dir) {
    const state = ensureState(node, ctx);
    const step = Number.isFinite(state.strengthStep) && state.strengthStep > 0 ? state.strengthStep : STRENGTH_STEP;
    bumpRowStrength(state, rowId, dir * step, field);
    persistState(node, ctx);
    repaintOne(node, ctx, rowId);
  }

  refs.up.addEventListener("click", (e) => {
    e.stopPropagation();
    bump("sm", 1);
  });
  refs.down.addEventListener("click", (e) => {
    e.stopPropagation();
    bump("sm", -1);
  });
  if (refs.upClip) {
    refs.upClip.addEventListener("click", (e) => {
      e.stopPropagation();
      bump("sc", 1);
    });
  }
  if (refs.downClip) {
    refs.downClip.addEventListener("click", (e) => {
      e.stopPropagation();
      bump("sc", -1);
    });
  }

  // BUG 17 (2026-07-29 owner report): the strength value is now typeable,
  // not just arrow-nudgeable ("changing 0.80 to 0.65 took seven clicks").
  // Commits on blur AND Enter; Escape reverts. Never writes on every
  // keystroke -- persisting a half-typed "0." on each character would dirty
  // the workflow constantly, and typing is not itself a commit. Garbage
  // (empty, "abc", "--1", "1e999", "NaN", a pasted newline/blob) parses to
  // `null` via `lora_state.mjs`'s own `parseTypedStrength` and reverts to
  // whatever the row's CURRENT value already is -- never written anywhere.
  // A valid typed value goes through `setRowStrength`, the exact SAME
  // clamp/round + sepStrengths-lockstep rule `bump` above already uses (via
  // `bumpRowStrength`) -- so a typed 5 and an arrow-bumped-to-5 land on the
  // IDENTICAL stored number, never a second copy of that logic.
  function commitTyped(field, inputEl) {
    const state = ensureState(node, ctx);
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return;
    }
    const parsed = parseTypedStrength(inputEl.value);
    if (parsed === null) {
      repaintOne(node, ctx, rowId); // revert -- never write garbage anywhere
      return;
    }
    setRowStrength(state, rowId, field, parsed);
    persistState(node, ctx);
    repaintOne(node, ctx, rowId);
  }

  function wireStrengthInput(inputEl, field) {
    if (!inputEl) {
      return;
    }
    // Litegraph binds keyboard shortcuts on the canvas (Delete removes the
    // selected node, etc.) and steals pointer gestures for node drag/select
    // -- same reasoning `wireGrip`'s own `pointerdown` handler documents.
    // Without these, a keystroke typed here could reach the canvas instead
    // of the field, which -- with a node selected -- can do real damage.
    inputEl.addEventListener("pointerdown", (e) => e.stopPropagation());
    inputEl.addEventListener("click", (e) => e.stopPropagation());
    inputEl.addEventListener("blur", () => commitTyped(field, inputEl));
    inputEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commitTyped(field, inputEl);
        if (typeof inputEl.blur === "function") {
          inputEl.blur();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        repaintOne(node, ctx, rowId); // revert to the row's current value, discard the edit
        if (typeof inputEl.blur === "function") {
          inputEl.blur();
        }
      }
    });
  }

  wireStrengthInput(refs.strVal, "sm");
  wireStrengthInput(refs.strValClip, "sc");
  // VERIFY-IN-COMFYUI: "the grip still drags cleanly with the field
  // focused" -- the grip's own `pointerdown` handler (`wireGrip`, above) is
  // wired independently of this input and never reads focus state, so
  // there is no code-level interaction between the two to find; this is a
  // genuine real-browser focus/pointer-capture question a headless DOM
  // stub (no real focus/blur semantics) cannot answer. Check live: focus a
  // row's strength field, then drag that SAME row by its grip without
  // clicking away first.

  refs.sw.addEventListener("click", (e) => {
    e.stopPropagation();
    const state = ensureState(node, ctx);
    const row = state.rows.find((r) => r.id === rowId);
    if (!row) {
      return;
    }
    setRowOn(state, rowId, !row.on);
    persistState(node, ctx);
    // A single row's on/off flips the header's N/M counter and the master
    // switch's tri-state reading too, so this goes through the full
    // `syncRows` (still cheap -- see this module's top doc comment) rather
    // than `repaintOne`.
    syncRows(node, ctx);
  });
}

// ---------------------------------------------------------------------------
// ⚙ settings dialog (design doc §7b, Slice 5) -- keyed per NODE (unlike the
// row menu/⁠picker/info panel, which are keyed per ROW id): a `WeakMap` gives
// each node a stable string identity the first time its dialog is opened,
// preferring the node's own `.id` when one exists (a real litegraph node
// always has one; the fake node this file's own test suite uses does not,
// which is exactly why the fallback exists) so two different LoRA Loader
// nodes on the same canvas never collide on the SAME overlay-toggle key --
// opening node B's dialog while node A's is open must open B's, never just
// toggle A's closed.
// ---------------------------------------------------------------------------

let _settingsKeySeq = 0;
const _settingsKeys = new WeakMap();

function settingsKeyFor(node) {
  if (!_settingsKeys.has(node)) {
    _settingsKeySeq += 1;
    const suffix = node && node.id != null ? node.id : `n${_settingsKeySeq}`;
    _settingsKeys.set(node, `lora-settings:${suffix}`);
  }
  return _settingsKeys.get(node);
}

/**
 * Opens (or, on a second click, closes) the ⚙ dialog -- the eight settings
 * from §7b, five per-node (in `state`, persisted via `persistState`) and
 * three user-wide (`Settings -> AnimaFlow`, via `getSetting`/`setSetting`).
 * Every edit applies IMMEDIATELY (§7b: "edits apply immediately, ✕ closes"
 * -- no footer buttons at all, so there is nothing to "confirm").
 */
function openLoraSettings(node, ctx, anchorEl) {
  const key = settingsKeyFor(node);
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this node's own dialog was already open -- just close it
  }
  closeOverlaysNotAncestorOf(anchorEl);

  const doc = ctx.doc;
  const state = ensureState(node, ctx);
  const refs = buildSettingsPanel(doc);

  function refreshFromSettings() {
    refs.hideExtSwitch.classList.toggle(
      "wtn-lora-on",
      !!getSetting(SETTING_IDS.HIDE_FILE_EXTENSION, SETTING_DEFAULTS[SETTING_IDS.HIDE_FILE_EXTENSION]),
    );
    refs.civitaiSwitch.classList.toggle(
      "wtn-lora-on",
      !!getSetting(SETTING_IDS.CIVITAI_ENABLED, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_ENABLED]),
    );
    refs.thumbsSwitch.classList.toggle(
      "wtn-lora-on",
      !!getSetting(SETTING_IDS.SHOW_PREVIEW_THUMBNAILS, SETTING_DEFAULTS[SETTING_IDS.SHOW_PREVIEW_THUMBNAILS]),
    );
  }

  function refreshFromState() {
    refs.defaultStrengthInput.value = state.defaultStrength.toFixed(2);
    refs.strengthStepInput.value = state.strengthStep.toFixed(2);
    refs.sepStrengthsSwitch.classList.toggle("wtn-lora-on", !!state.sepStrengths);
    refs.sepInput.value = state.sep;
    for (const btn of refs.cacheModeBtns) {
      btn.setAttribute("aria-pressed", String(btn.dataset.mode === state.cacheMode));
    }
  }

  refreshFromState();
  refreshFromSettings();

  refs.defaultStrengthInput.addEventListener("change", () => {
    setDefaultStrength(state, Number(refs.defaultStrengthInput.value));
    persistState(node, ctx);
    refreshFromState();
  });
  refs.strengthStepInput.addEventListener("change", () => {
    setStrengthStep(state, Number(refs.strengthStepInput.value));
    persistState(node, ctx);
    refreshFromState();
  });
  refs.sepStrengthsSwitch.addEventListener("click", (e) => {
    e.stopPropagation();
    setSepStrengths(state, !state.sepStrengths);
    persistState(node, ctx);
    refreshFromState();
    // BUG 7 (2026-07-29 owner report): sepStrengths has its OWN, higher
    // width floor (MIN_W_SEP) -- a legitimate user-initiated resize, so
    // widen a too-narrow node up to it now rather than leaving the new
    // stepper clipped until the next manual drag. Turning it back OFF must
    // never shrink a node the user has already widened -- `enforceWidthFloor`
    // only ever grows (see its own doc comment).
    enforceWidthFloor(node, ctx);
    syncRows(node, ctx); // rows must repaint to show/hide the clip stepper (§7b)
  });
  refs.sepInput.addEventListener("input", () => {
    setSep(state, refs.sepInput.value);
    persistState(node, ctx);
  });
  for (const btn of refs.cacheModeBtns) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setCacheMode(state, btn.dataset.mode);
      persistState(node, ctx);
      refreshFromState();
    });
  }

  refs.hideExtSwitch.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = getSetting(SETTING_IDS.HIDE_FILE_EXTENSION, SETTING_DEFAULTS[SETTING_IDS.HIDE_FILE_EXTENSION]);
    setSetting(SETTING_IDS.HIDE_FILE_EXTENSION, !current);
    refreshFromSettings();
    // Task brief, 2026-07-31 (part B): "the second part is the one that gets
    // forgotten" -- every row's own label reads this setting at PAINT time
    // (`lora_render.mjs`'s `paintRow`, via `displayRowName`), so toggling it
    // here must force every row to repaint, not just update the switch's own
    // visual (mirrors the `civitaiSwitch` handler's identical `syncRows` call,
    // just below).
    syncRows(node, ctx);
  });
  refs.civitaiSwitch.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = getSetting(SETTING_IDS.CIVITAI_ENABLED, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_ENABLED]);
    setSetting(SETTING_IDS.CIVITAI_ENABLED, !current);
    refreshFromSettings();
    // The header's own 🔍 (and every other network affordance) reads this
    // setting live on every `syncRows` call (§7b decision 20) -- re-run it
    // so toggling here takes effect immediately, not just next repaint.
    syncRows(node, ctx);
  });
  refs.thumbsSwitch.addEventListener("click", (e) => {
    e.stopPropagation();
    const current = getSetting(SETTING_IDS.SHOW_PREVIEW_THUMBNAILS, SETTING_DEFAULTS[SETTING_IDS.SHOW_PREVIEW_THUMBNAILS]);
    setSetting(SETTING_IDS.SHOW_PREVIEW_THUMBNAILS, !current);
    refreshFromSettings();
  });

  refs.closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handle.close();
  });

  const handle = openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, refs.root, "below", () => {
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  }, "wtn-ctl-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
}

function wireHeader(node, ctx, refs) {
  refs.addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const state = ensureState(node, ctx);
    addRow(state);
    persistState(node, ctx);
    syncRows(node, ctx);
  });
  refs.master.addEventListener("click", (e) => {
    e.stopPropagation();
    const state = ensureState(node, ctx);
    toggleMaster(state);
    persistState(node, ctx);
    syncRows(node, ctx);
  });
  refs.settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openLoraSettings(node, ctx, refs.settingsBtn);
  });
  // M2 (docs/lora-loader-design.md §7c): the header's 🔍 opens the Civitai
  // search panel, kind-LOCKED to `"loras"` (this node-embedded surface is a
  // picker, never a browser of another kind -- §7c). Its VISIBILITY (not
  // this listener) is what §7b decision 20 actually gates -- `syncRows`
  // hides the whole button when the Civitai setting is off, so this handler
  // never fires from a hidden control, but it deliberately does not
  // re-check the setting itself: a hidden button has no way to be clicked.
  refs.searchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openCivitaiSearch({ ctx, anchorEl: refs.searchBtn, kind: "loras", ownerKey: `lora-civitai-search:${node.id != null ? node.id : ""}` });
  });
}

// ---------------------------------------------------------------------------
// Row DOM lifecycle -- see this module's top doc comment ("reorder without
// a rebuild") for why this single function covers add/remove/reorder/repaint
// without a separate "cheap path" vs "structural rebuild" split.
// ---------------------------------------------------------------------------

/**
 * Reconciles the rows host's DOM against the current state: existing rows
 * are matched by `id` and REUSED (never rebuilt/rewired), new rows get a
 * fresh element + listeners, removed rows are detached. Then every row still
 * present is repainted, the rows host is reordered to match `state.rows`
 * (a plain `appendChild` per entry, in order -- moves an existing child
 * without recreating it), and the header (`N/M` + master switch) and
 * empty-state visibility are updated.
 *
 * Safe to call after EVERY mutation (add/remove/reorder/toggle/bump) and on
 * initial mount/restore -- `injectStyles` runs first, unconditionally
 * (idempotent, guarded by `STYLE_ID` in `lora_render.mjs`), mirroring
 * `js/controls/interaction.mjs`'s own `syncRows` doing the same for the
 * identical reason (it must land before the first row element is ever
 * appended).
 */
export function syncRows(node, ctx) {
  injectStyles(ctx.doc);
  const state = ensureState(node, ctx);
  const refs = node._lrRefs;
  if (!refs) {
    return; // not mounted yet (defensive -- mountLoraNode always mounts first)
  }

  const existingById = new Map((node._lrRows || []).map((entry) => [entry.id, entry]));
  const nextEntries = state.rows.map((row) => {
    const found = existingById.get(row.id);
    if (found) {
      return found;
    }
    const rowRefs = buildRowElement(ctx.doc);
    wireRow(node, ctx, row.id, rowRefs);
    return { id: row.id, refs: rowRefs };
  });

  const keep = new Set(nextEntries);
  for (const entry of node._lrRows || []) {
    if (!keep.has(entry) && entry.refs.root.parentNode) {
      entry.refs.root.parentNode.removeChild(entry.refs.root);
    }
  }

  // `appendChild` on an element ALREADY in this parent MOVES it (no
  // teardown, no listener loss) -- this loop both places brand-new rows and
  // reorders existing ones, in one pass, matching `state.rows`' order.
  for (const entry of nextEntries) {
    refs.rowsHost.appendChild(entry.refs.root);
  }

  state.rows.forEach((row, i) => {
    paintRow(nextEntries[i].refs, row, state.sepStrengths);
  });
  node._lrRows = nextEntries;

  const allOn = allRowsOn(state.rows);
  const [onCount] = onCounts(state.rows);
  paintHeader(refs, state.rows, allOn, onCount);
  refs.empty.style.display = state.rows.length ? "none" : "flex";

  // §7b decision 20: the Civitai setting hides EVERY network affordance on
  // this node, including the header's 🔍 (browse Civitai) placeholder --
  // read live on every sync, same as `openInfoPanelFor`'s own read, so
  // flipping the setting takes effect the next time anything repaints this
  // node (no separate settings-change listener needed).
  refs.searchBtn.style.display = getSetting(SETTING_IDS.CIVITAI_ENABLED, SETTING_DEFAULTS[SETTING_IDS.CIVITAI_ENABLED])
    ? ""
    : "none";

  // BUG 14 (2026-07-29 owner report): "when adding a new row it is
  // overflowing over the node until my mouse is moved outside of the node,
  // then the node grows." `syncRows` is the ONE function every row-count-
  // changing mutation calls (Add, Duplicate, Remove, and the initial mount
  // of a restored workflow) -- the DOM widget above grows to its new
  // content height IMMEDIATELY (it's a real DOM element, reflowed
  // synchronously), but `node.size[1]` (what the canvas actually draws the
  // node's border at) used to only catch up on the NEXT `onDrawForeground`
  // -- litegraph's own per-frame draw hook, which measurably does NOT fire
  // on every state change, only on an actual redraw (a mouse-driven one,
  // per the bug report). That gap is the overflow: DOM already tall,
  // border still short, for however many frames it takes something else to
  // dirty the canvas.
  //
  // `fitNodeH` is pure arithmetic (`contentHeight` has no DOM measurement,
  // `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`) -- there is no
  // reason to wait for a measure pass at all. Apply it HERE, synchronously,
  // in the same turn as the state mutation that got us here, mutating
  // `node.size[1]` IN PLACE (never reassign `node.size` -- it may be a
  // `Float64Array` view over a `Rectangle` backing store, same rule as
  // every other Class A layer in this file). `setDirtyCanvas` right after
  // is what actually paints the corrected border on the very next frame
  // instead of whichever later frame the mouse happens to move on.
  //
  // VERIFY-IN-COMFYUI: this fixes the canvas-drawn BORDER's own timing
  // (`node.size[1]`, proven synchronous by the tests below). The DOM
  // widget's OWN internal height (litegraph's `arrange()`/`_arrangeWidgets`
  // re-measuring `getMinHeight`/`getMaxHeight`) is a SEPARATE mechanism this
  // headless suite cannot observe at all -- there is no real litegraph
  // layout pass to run against a fake node. It SHOULD already be correct
  // (those getters are live closures, re-read on every call, per the
  // `mountLoraNode`-level tests), and `setDirtyCanvas(true, true)` here is
  // what should prompt litegraph to actually re-invoke them promptly -- but
  // confirm live that the DOM body's own rendered height keeps pace with
  // the corrected border, not just that the border itself is now correct.
  //
  // Width is deliberately untouched here -- only row COUNT invalidates
  // height; reordering/toggling sepStrengths call this same function too,
  // but `fitNodeH`'s answer is unchanged when only order or mode changes
  // (verified by `test_lora_resize.mjs`'s own "FLIP mid-drag" test), so this
  // is a harmless no-op on those calls, not a special case to guard against.
  //
  // Same load-path bail as every other Class A layer: `syncRows` also runs
  // from `mountLoraNode`, which `setupLoraNode`/`restoreLoraNode` call WHILE
  // `node._lrConfiguring` may still be true (a restore in flight) -- writing
  // a synchronous height here in that window would stamp over a still-
  // restoring size before `restoreStateFromWidget` has even run, the exact
  // race `setupLoraNode`'s own doc comment describes.
  if (isSizeLike(node.size) && !node._lrConfiguring && !(ctx && typeof ctx.isGraphLoading === "function" && ctx.isGraphLoading())) {
    node.size[1] = fitNodeH(node, ctx);
  }

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

// ---------------------------------------------------------------------------
// Mount -- ONE addDOMWidget for the whole node body (see lora_render.mjs's
// top doc comment for why this node doesn't need one per row).
// ---------------------------------------------------------------------------

/**
 * Builds the DOM root + mounts the single `addDOMWidget`, exactly once per
 * node (`node._lrMounted` guard) -- a second call (e.g. from
 * `restoreLoraNode` running after `setupLoraNode` already mounted) is just a
 * `syncRows` refresh, matching the ALREADY-mounted case's cheap path.
 *
 * `getMinHeight`/`getMaxHeight` are the FIRST, declarative Class A layer
 * (`.claude/skills/comfyui-litegraph-node-sizing/SKILL.md` fact 1 -- min ==
 * max is the only real height lock): both close over `node`/`ctx` LIVE, so
 * they always report the CURRENT row count's content height, not a value
 * frozen at mount time.
 */
export function mountLoraNode(node, ctx) {
  if (node._lrMounted) {
    syncRows(node, ctx);
    return node._lrRefs;
  }
  injectStyles(ctx.doc);
  if (!ctx.doc || typeof node.addDOMWidget !== "function") {
    // Defensive fallback for a host without addDOMWidget/no live document
    // (shouldn't occur in ComfyUI's actual runtime) -- keep bookkeeping
    // consistent without any DOM.
    node._lrMounted = true;
    node._lrRefs = null;
    node._lrRows = [];
    return null;
  }

  const refs = buildRoot(ctx.doc);
  wireHeader(node, ctx, refs);

  const widget = node.addDOMWidget("lora_ui", "lora_ui", refs.root, {
    serialize: false,
    getMinHeight: () => contentHeight(rowCountOf(node, ctx)),
    // min == max pins the widget's own height -- see this function's doc
    // comment and the sizing skill's fact 1.
    getMaxHeight: () => contentHeight(rowCountOf(node, ctx)),
  });
  widget.serialize = false;
  if (widget.options) {
    widget.options.serialize = false;
  }
  widget.computeSize = () => [node.size[0], contentHeight(rowCountOf(node, ctx))];
  widget.computeLayoutSize = () => ({
    minHeight: contentHeight(rowCountOf(node, ctx)),
    maxHeight: contentHeight(rowCountOf(node, ctx)),
    minWidth: 1, // Nodes 2.0 forward-compat: impose no width constraint of its own
  });

  const uninstallZoom = installCanvasZoomPassthrough(refs.root, ctx.getCanvasEl, WHEEL_LOCK_OPTIONS);

  node._lrMounted = true;
  node._lrRefs = refs;
  node._lrWidget = widget;
  node._lrZoomUninstall = uninstallZoom;
  node._lrRows = [];

  syncRows(node, ctx);

  // Warm the `loras` list so a row whose file was renamed/removed on disk
  // shows its missing-file mark WITHOUT the picker ever being opened (a
  // restored workflow should say so on its very first paint) -- mirrors
  // `../ComfyUI-Pixaroma/js/lora_loader/index.js`'s own
  // `listLoras().then(() => { if (node._pixLlRoot) renderNode(node); })`.
  // `listModels` caches after the first real fetch, so a page with several
  // LoRA Loader nodes only pays this once. DOM-only repaint -- can't dirty a
  // freshly loaded workflow's saved size/values.
  listModels("loras").then(() => {
    if (node._lrMounted) {
      syncRows(node, ctx);
    }
  });

  return refs;
}

/** Teardown counterpart to `mountLoraNode` -- called from `onRemoved`. */
export function teardownLoraNode(node) {
  if (typeof node._lrZoomUninstall === "function") {
    node._lrZoomUninstall();
  }
}

// ---------------------------------------------------------------------------
// Class A sizing -- content-fixed height, width resizable with a floor
// (design doc §6: "Class A, but for a different reason than the panels" --
// this node COULD scroll, since it has no per-row sockets, but the owner's
// policy is content-fixed regardless). Six layers total:
//
//   1. addDOMWidget getMinHeight === getMaxHeight   (mountLoraNode, above)
//   2. setSize wrap                                 (wrapSetSizeLora)
//   3. onDrawForeground per-frame backstop           (onDrawForegroundLora)
//   4. load-path correction                          (applyContentHeightLora)
//   5. onResize (fires on some paths, never sufficient alone)
//                                                     (onResizeLora)
//   6. synchronous row-count-change apply (BUG 14 -- the only layer that
//      runs in the SAME turn as the mutation, not on a later frame)
//                                                     (syncRows, above)
//
// Every mechanism, and the ordering/authority rules between them, mirrors
// `js/controls/interaction.mjs`'s own Class A section (`onResizeControls`
// :2206, `onDrawForegroundControls` :2277, `wrapSetSizeControls` :2369,
// `applyContentHeight` :2415) -- see that file's extensive doc comments (and
// `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`) for the full
// derivation this only summarizes: `onResize` is measured to never fire on
// the legacy resize-drag path (`onResizeCalls: 0`); `setSize` IS called
// every drag frame, before the paint, which is why wrapping it (not
// `onResize`) is what actually stops the visible mid-drag stretch;
// `onDrawForeground` is the per-frame backstop that survives both gaps.
// ---------------------------------------------------------------------------

/** The current width FLOOR for `node` -- `MIN_W_SEP` while `sepStrengths` is
 * on, `MIN_W` otherwise (BUG 7, 2026-07-29 owner report: "the floor doesn't
 * depend on mode" let a node resized to the single-strength floor break the
 * instant sepStrengths was turned on). Every enforcement layer below reads
 * THIS, never the flat `MIN_W` directly, so toggling the setting can never
 * leave one layer clamping to the wrong number while another has already
 * moved on. */
function currentMinW(node, ctx) {
  const state = ensureState(node, ctx);
  return state.sepStrengths ? MIN_W_SEP : MIN_W;
}

/** The single authority for "what should node.size[1] be right now" --
 * `node.computeSize()` when present (the SAME function every layer below
 * defers to, never a second formula), else `WIDGETS_START_Y +
 * contentHeight(rows.length)` directly (BUG 3: the fallback must reserve
 * the same fixed output-socket column `computeLoraSize` does, or a node
 * whose `computeSize` is ever missing/broken would size itself right back
 * under the sockets). Mirrors `interaction.mjs`'s own `fitNodeH` exactly,
 * modulo that one addition. */
function fitNodeH(node, ctx) {
  try {
    const cs = typeof node.computeSize === "function" ? node.computeSize() : null;
    if (cs && Number.isFinite(cs[1]) && cs[1] > 0) {
      return Math.round(cs[1]);
    }
  } catch {
    // A broken/throwing computeSize must never take the fit down with it --
    // fall through to the arithmetic fallback below.
  }
  const state = ensureState(node, ctx);
  return WIDGETS_START_Y + contentHeight(state.rows.length);
}

/** Auto-fit the node to its content -- bails on the load path via BOTH
 * `node._lrConfiguring` and `ctx.isGraphLoading()` (the belt-and-braces pair
 * `index.js`'s own top doc comment on `isGraphLoading` explains: one covers
 * BEFORE `onConfigure` even runs, the other covers the window an async
 * `loadMods()` import takes during/after it). WIDTH stays the user's,
 * floored at `MIN_W`; HEIGHT is never user-owned. */
export function fitNode(node, ctx) {
  if (node._lrConfiguring || (ctx && typeof ctx.isGraphLoading === "function" && ctx.isGraphLoading())) {
    return;
  }
  const w = Math.max((node.size && node.size[0]) || DEFAULT_W, currentMinW(node, ctx));
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

/** Queue a `fitNode` call for the next animation frame, never synchronously
 * -- mirrors `interaction.mjs`'s `scheduleFit`; `fitNode`'s own guard is
 * re-checked at rAF-fire-time, which is what actually matters (see that
 * function's sibling in Control for the full race this closes). */
export function scheduleFit(node, ctx) {
  if (typeof requestAnimationFrame !== "function") {
    return;
  }
  requestAnimationFrame(() => fitNode(node, ctx));
}

/**
 * Layer 5 -- `onResize(size)`, litegraph's per-resize-drag hook. Measured
 * (`.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`) to NEVER fire on
 * the actual legacy height-resize-drag path (`onResizeCalls: 0`) -- kept
 * wired for the paths where it DOES fire (other builds/renderers), never
 * relied on as the only enforcement. HEIGHT is unconditionally rewritten to
 * `fitNodeH`'s answer; WIDTH is floored at `MIN_W`, left alone otherwise.
 * No-ops entirely under Nodes 2.0 (`isVueNodes()` -- v2 owns sizing via
 * `computeLayoutSize`, don't fight it). Mutates `size` IN PLACE (never
 * reassigns `node.size` -- see `../shared/size.mjs`'s own top doc comment on
 * why that would detach a `Float64Array` from its backing `Rectangle`).
 */
export function onResizeLora(node, ctx, size) {
  if (isVueNodes()) {
    return;
  }
  const arr = isSizeLike(size) ? size : node.size;
  if (!isSizeLike(arr)) {
    return;
  }
  const floor = currentMinW(node, ctx);
  if (arr[0] < floor) {
    arr[0] = floor;
  }
  arr[1] = fitNodeH(node, ctx);
  if (arr !== node.size && isSizeLike(node.size)) {
    node.size[0] = arr[0];
    node.size[1] = arr[1];
  }
}

/**
 * Layer 3 -- `onDrawForeground(ctx)`, litegraph's PER-FRAME draw hook. The
 * one that actually enforces Class A in practice (measured: a live height
 * drag never called `onResize` at all). Enforces unconditionally: `size[1]`
 * is always `fitNodeH`'s answer, `size[0]` floored at `MIN_W`. MUST be
 * cheap (runs every frame) -- compares before assigning, NEVER calls
 * `setSize`/`setDirtyCanvas` (either would schedule another draw, which
 * would call this again -- an infinite repaint loop, not a fix). Bails on
 * the load path (unlike `onResizeLora`, this genuinely CAN run mid-load --
 * a background tab's canvas repainting while `isGraphLoading()`'s trailing
 * window is still open) and under Nodes 2.0.
 */
export function onDrawForegroundLora(node, ctx) {
  if (isVueNodes()) {
    return;
  }
  if (node._lrConfiguring || (ctx && typeof ctx.isGraphLoading === "function" && ctx.isGraphLoading())) {
    return;
  }
  if (!isSizeLike(node.size)) {
    return;
  }
  const floor = currentMinW(node, ctx);
  if (node.size[0] < floor) {
    node.size[0] = floor;
  }
  const h = fitNodeH(node, ctx);
  if (node.size[1] !== h) {
    node.size[1] = h;
  }
}

/**
 * Layer 2 -- wraps `node.setSize` so the height lock lands at the point of
 * assignment, PRE-PAINT, rather than only being corrected after the fact.
 * Decompiling the installed `comfyui_frontend_package` (per the sizing
 * skill): litegraph's own resize-drag handler calls `n.setSize(c.size)` on
 * EVERY drag frame, BEFORE `this._dirty()` -- i.e. before the repaint that
 * would otherwise show the node holding the dragged (too-tall) size for
 * that frame. Wrapping `setSize` (not `onResize`, which never fires on this
 * path) is what stops the visible mid-drag stretch. Wraps, never
 * reimplements: always delegates to whatever `node.setSize` already was.
 * Bails identically to the other layers (Nodes 2.0, load path).
 */
export function wrapSetSizeLora(node, ctx) {
  if (typeof node.setSize !== "function") {
    return;
  }
  const original = node.setSize.bind(node);
  node.setSize = function setSizeLora(size) {
    if (isVueNodes() || node._lrConfiguring || (ctx && typeof ctx.isGraphLoading === "function" && ctx.isGraphLoading())) {
      return original(size);
    }
    const arr = isSizeLike(size) ? size : null;
    if (!arr) {
      return original(size);
    }
    const floor = currentMinW(node, ctx);
    if (arr[0] < floor) {
      arr[0] = floor;
    }
    arr[1] = fitNodeH(node, ctx);
    return original(arr);
  };
}

/**
 * Layer 4 -- the load-path counterpart to `onResizeLora`: `onResize` only
 * ever fires from a LIVE resize-drag, so it can never correct a workflow
 * saved with a stale/inconsistent height (an older build, or a hand-edited
 * one). Rewrites `node.size[1]` ONLY -- width is left completely untouched,
 * matching the pre-existing "never rewrite width on load" rule. On an
 * already-consistent workflow this is a genuine no-op (`fitNodeH` recomputes
 * the exact number the workflow was saved with).
 */
export function applyContentHeightLora(node, ctx) {
  if (!isSizeLike(node.size)) {
    return;
  }
  node.size[1] = fitNodeH(node, ctx);
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

/**
 * BUG 7 (2026-07-29 owner report): toggling `sepStrengths` ON can move
 * `currentMinW`'s answer past the node's CURRENT width -- unlike every other
 * layer above (which only ever clamp a drag/paint back down to a floor),
 * this one is allowed to actually GROW the node, because it's reacting to a
 * genuine user action (flipping the ⚙ switch), not a drag or a load. It
 * never shrinks a node the user has already widened themselves: calling
 * `node.setSize` with the CURRENT size unchanged is enough, because
 * `wrapSetSizeLora` (installed once, in `setupLoraNode`, long before any ⚙
 * dialog can be opened) already re-clamps `arr[0]` up to `currentMinW`'s
 * CURRENT answer on every call -- reusing that one floor rather than
 * duplicating the comparison a second time here.
 */
export function enforceWidthFloor(node, ctx) {
  if (typeof node.setSize === "function" && isSizeLike(node.size)) {
    node.setSize([node.size[0], node.size[1]]);
  }
}

// ---------------------------------------------------------------------------
// Node lifecycle -- called from index.js's onNodeCreated/onConfigure.
// ---------------------------------------------------------------------------

/**
 * Fresh-node (and first-mount-of-a-restored-node) path, from
 * `onNodeCreated`. Mirrors `js/controls/index.js`'s `setupNode`: chrome is
 * applied ONLY when `!node._lrConfiguring` (a genuinely fresh node -- see
 * that file's own doc comment for how that flag reliably distinguishes
 * fresh-vs-restoring even though `onNodeCreated` fires for both), the
 * initial floor-size block is gated on BOTH `!ctx.isGraphLoading()` and
 * `!node._lrConfiguring` for the identical reason `js/controls/index.js`'s
 * own `setupNode` documents at length (a restored node's `onNodeCreated`
 * microtask can run before `onConfigure` has restored anything at all).
 */
export function setupLoraNode(node, ctx) {
  if (node._lrSetup) {
    return;
  }
  node._lrSetup = true;

  hideStateWidget(node);
  ensureState(node, ctx);

  if (!node._lrConfiguring) {
    applyNodeChrome(node);
  }

  // BUG 3 (2026-07-29 owner report): this used to be the flat `2` Control
  // Panel uses -- correct THERE (its own outputs are parked at each row's
  // widget Y, so nothing above the widget needs reserving), wrong HERE
  // (this node's `MODEL`/`CLIP`/`triggers` outputs are FIXED, drawn at their
  // own native slot positions -- see `lora_render.mjs`'s own top doc comment
  // for the decompiled litegraph formula this replaces). `WIDGETS_START_Y`
  // reserves that real slot-column height instead, so the DOM widget starts
  // BELOW the sockets rather than painted on top of them.
  node.widgets_start_y = WIDGETS_START_Y;

  node.computeSize = function computeLoraSize() {
    return [currentMinW(node, ctx), WIDGETS_START_Y + contentHeight(rowCountOf(node, ctx))];
  };

  // THIRD Class A hook (alongside onResize/onDrawForeground, wired from
  // index.js) -- installed once per node, guarded by `_lrSetup` above.
  wrapSetSizeLora(node, ctx);

  // Initial floor sizing -- see this function's own doc comment for the
  // double guard. Height goes through `fitNodeH` (not a bare `contentHeight`
  // call) so it picks up the same `WIDGETS_START_Y` offset `computeLoraSize`
  // above does -- `node.computeSize` is already assigned by this point, so
  // `fitNodeH` reads it rather than falling back to raw arithmetic.
  if (!(ctx && typeof ctx.isGraphLoading === "function" && ctx.isGraphLoading()) && !node._lrConfiguring) {
    if (!isSizeLike(node.size) || node.size[0] < currentMinW(node, ctx)) {
      if (!node.size) {
        node.size = [0, 0];
      }
      node.size[0] = DEFAULT_W;
      node.size[1] = fitNodeH(node, ctx);
    }
  }

  mountLoraNode(node, ctx);
  scheduleFit(node, ctx);
}

/**
 * Restore path, from `onConfigure` (after litegraph has restored the real
 * saved `widgets_values`, including `lora_state`). Deliberately NO
 * `scheduleFit`/`fitNode` here -- trust the WIDTH litegraph already
 * restored (skill's "never resize on load" rule; a clean workflow must not
 * open "modified"). HEIGHT is the one exception (`applyContentHeightLora`),
 * for the same reason `js/controls/index.js`'s `restoreNode` documents:
 * `onResize` never fires on the load path at all, so nothing else here
 * would ever correct a workflow saved by an older, pre-fix build.
 */
export function restoreLoraNode(node, ctx) {
  hideStateWidget(node);
  restoreStateFromWidget(node, ctx);
  node.widgets_start_y = WIDGETS_START_Y; // BUG 3 -- see setupLoraNode's own doc comment
  mountLoraNode(node, ctx);
  applyContentHeightLora(node, ctx);
}
