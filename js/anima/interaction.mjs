/**
 * interaction.mjs — event wiring + node-level orchestration for
 * `AnimaGenerator` / `AnimaPreview`. `render.mjs` only builds/paints small
 * presentational DOM pieces; THIS module owns the tree shape (which sections
 * exist right now, in which order, expanded or not, wired to what) and the
 * state <-> hidden-widget handshake — mirrors `js/controls/interaction.mjs`'s
 * split with `render.mjs`.
 *
 * ## `ctx` — the one object every function here takes
 *
 *   {
 *     doc: document,                  // or a stub, under test
 *     getCanvasEl(): HTMLCanvasElement|null,   // app.canvas.canvas, live
 *     havePackages(): {spectrum, usdu, impact},// soft-import presence, live
 *     getKnownLists(): {checkpoints, upscale_models},// installed-file lists, live
 *   }
 *
 * `getCanvasEl`/`havePackages`/`getKnownLists` are the only three places this
 * whole feature needs `window`/`app`/`LiteGraph` — kept OUT of this file
 * (index.js owns them) so this module stays testable with a stub.
 * `getKnownLists` mirrors `js/controls/index.js`'s identical-purpose
 * `readKnownLists`: each of `checkpoints`/`upscale_models` is either the
 * live installed-file array for that ComfyUI folder (read off
 * `CheckpointLoaderSimple.ckpt_name`/`UpscaleModelLoader.model_name`'s own
 * registered combo spec — `js/controls/rows.mjs`'s `getComboOptions`,
 * reused rather than reimplemented, per that module's own cross-track
 * precedent already established by `js/shared/fields.mjs`) or `null` if that
 * node class isn't registered at all. Feeds the Detailer section's SAM3
 * checkpoint picker and the Upscale section's `upscale_model_name` picker
 * (both used to be hardcoded upstream defaults with no frontend control at
 * all — this task's whole point) — see `buildDetailerBody`/
 * `buildUpscaleSection` below. A `null`/empty list degrades HONESTLY: the
 * picker still shows whatever value the settings tree already holds
 * (never silently rewritten), just rendered disabled (`ce0528f`'s lesson:
 * never default to `list[0]` in place of a saved value).
 *
 * ## 2026-07-28 reversal (inline-sections dispatch, `docs/generator-
 * design.md` §12) — sections expand IN PLACE, no more popover to protect
 *
 * See `render.mjs`'s top doc comment for the full history (modal → drawer →
 * row-anchored popover → this). The popover-era rule this file used to carry
 * — "a popover's anchor lives INSIDE the panel, so rebuilding the panel
 * while it's open would detach it; close it first, rebuild after" — is GONE
 * along with the popover itself: every section (Sampler, Mod Guidance,
 * Highres, Detailer, Upscale, Postprocess, Save) now renders directly inside
 * `.wtn-an-panel`, so a full-body repaint (`repaintGenerator`/
 * `repaintPreview`, unchanged) is simply the ONE response to every action —
 * toggling a section open/closed, flipping an enable switch, editing a
 * field, adding a detailer block. `openPopover`/`activeOverlayRef`/
 * `closeActiveOverlay`/`openOverlayWithZoom` and every `openXPopover`
 * function are DELETED, not left unreferenced — `js/shared/overlay.mjs` is
 * no longer imported here at all (it is still `js/controls/`'s own overlay
 * mechanism; that track is untouched by this dispatch).
 *
 * Expand/collapse state lives in the settings blob itself, under
 * `ui_expanded` (`state.mjs`'s `normalizeExpandedSections`/`DEFAULT_
 * EXPANDED_GENERATOR_SECTIONS`/`DEFAULT_EXPANDED_PREVIEW_SECTIONS`) — see
 * that module's own top doc comment for why it's safe there (kept OUT of
 * the two fixture-tested defaults trees, applied as a second pure step
 * AFTER `normalizeGenerationSettings`/`normalizePreviewSettings`, in
 * `ensureGenState`/`ensurePreviewState` below) rather than `node.properties`.
 * It reaches the same serialized STRING widget every other edit already
 * does (`persistGenState`/`persistPreviewState` serialize the WHOLE state
 * object, `ui_expanded` included), so a workflow reopens with the same
 * sections expanded it was saved with — free, with no extra wiring.
 *
 * ## Context-supplied fields (design doc §5a, task item 4)
 *
 * The Generator no longer has its own `seed`/`steps`/`cfg`/`sampler_name`/
 * `scheduler` sockets — there is one `context` (`ANIMA_CONTEXT`) input. The
 * frontend cannot see inside that object at graph-edit time (it's only
 * produced at execution), so `computeContextSupplied` below reads the most
 * reliable signal actually available: walking the real litegraph link from
 * `context` back to the `AnimaContextBridge` node (tolerating any number of
 * single-input pass-through nodes — Reroute and similar — in between,
 * mirroring the Control Panel's own tolerance of "*" pass-through targets)
 * and checking WHICH of the bridge's own eleven sockets are wired. If
 * `context` is unwired, wired to something that isn't a bridge, or the
 * chain doesn't resolve, every field renders editable — this frontend has
 * no way to distinguish "definitely not supplied" from "can't tell" beyond
 * that one-hop-upstream check, so the honest default is to never disable a
 * field it isn't sure about. **2026-07-28 (inline-sections dispatch)**: a
 * supplied field now renders as a genuinely DISABLED
 * `buildNumericField`/`buildStepperField` (same shape, same value on
 * screen, `disabledReason` set) with a yellow `buildInfoIcon(..., warn:
 * true)` beside it, rather than the deleted `buildDrivenField`'s bare text
 * row — see `buildSamplerField` below and `render.mjs`'s own top doc comment
 * for why the value shown is this settings tree's own (this frontend still
 * cannot see inside the bridge's execution-time output; the tooltip says so
 * rather than guessing at it).
 */

import { installCanvasZoomPassthrough } from "../shared/canvas_zoom.mjs";
import { buildNumericField, buildStepperField, hideActiveInfoTip } from "../shared/fields.mjs";
// `getComboOptions` -- reused, not reimplemented, from the Controls track
// (`js/shared/fields.mjs` already imports OTHER pure helpers from this same
// module, one-directional `shared`/`anima` -> `controls/rows.mjs`, per that
// file's own top doc comment; this is the identical precedent, just for a
// different function). Re-exported below purely so `index.js` -- which
// deliberately never statically imports `js/controls/rows.mjs` itself, to
// stay inside the JS download budget -- can reach it through this module's
// own LAZILY-loaded `mods.interaction`, exactly like `js/controls/index.js`
// reaches its own copy through `mods.rows`.
export { getComboOptions } from "../controls/rows.mjs";

import {
  MAX_DETAILER_PASSES,
  SAMPLER_FIELDS,
  CONTEXT_FIELDS,
  COMPARE_SLOTS,
  SAVE_WHICH_OPTIONS,
  STAGE_ORDER,
  DEFAULT_EXPANDED_GENERATOR_SECTIONS,
  DEFAULT_EXPANDED_PREVIEW_SECTIONS,
  normalizeGenerationSettings,
  normalizePreviewSettings,
  normalizeExpandedSections,
  resolveStageSampler,
  addDetailerBlock,
  removeDetailerBlock,
  moveDetailerBlock,
  isBuiltinDetailerBlock,
} from "./state.mjs";

import {
  injectStyles,
  buildPanelShell,
  buildSwitch,
  buildSectionHeader,
  withInfoIcon,
  buildTextField,
  buildBoolField,
  sectionLabel,
  buildSublabel,
  buildMissing,
  buildWipeLayer,
  measureMinHeight,
  DEFAULT_H,
  PREVIEW_DEFAULT_H,
} from "./render.mjs";

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

// ---------------------------------------------------------------------------
// Widget <-> state handshake (dynamic-node-frontend skill: a DECLARED,
// natively-serialized STRING widget, hidden for rendering only -- never
// `serialize = false`).
// ---------------------------------------------------------------------------

export function getGenSettingsWidget(node) {
  return (node.widgets || []).find((w) => w.name === "generation_settings");
}
export function getPreviewStateWidget(node) {
  return (node.widgets || []).find((w) => w.name === "preview_state");
}

function writeGenStateToWidget(node, state) {
  const w = getGenSettingsWidget(node);
  if (w) {
    w.value = JSON.stringify(state);
  }
}
function writePreviewStateToWidget(node, state) {
  const w = getPreviewStateWidget(node);
  if (w) {
    w.value = JSON.stringify(state);
  }
}

/** First mount / brand-new node: normalize whatever the widget currently
 * holds (Python's literal `"{}"` default, or a hand-edited API payload) and
 * write the fully-expanded tree straight back — see the frontend skill's
 * "declaring is not writing" trap. Safe to call repeatedly; always
 * re-normalizes from the widget's CURRENT value, so it doubles as
 * `restoreGenState`.
 *
 * `state.ui_expanded` (this module's top doc comment) is normalized as a
 * SECOND pure step, deliberately AFTER `normalizeGenerationSettings` rather
 * than inside it — that keeps the Python-parity normalizer byte-identical
 * to its fixture (`state.mjs`'s own top doc comment explains why). */
export function ensureGenState(node) {
  const w = getGenSettingsWidget(node);
  const state = normalizeGenerationSettings(w ? w.value : "{}");
  state.ui_expanded = normalizeExpandedSections(state.ui_expanded, DEFAULT_EXPANDED_GENERATOR_SECTIONS);
  node._anGenState = state;
  writeGenStateToWidget(node, state);
  return state;
}
export const restoreGenStateFromWidget = ensureGenState;

export function persistGenState(node) {
  writeGenStateToWidget(node, node._anGenState);
}

/** Same two-step normalization as `ensureGenState` above, for the Preview's
 * `ui_expanded.save`. */
export function ensurePreviewState(node) {
  const w = getPreviewStateWidget(node);
  const state = normalizePreviewSettings(w ? w.value : "{}");
  state.ui_expanded = normalizeExpandedSections(state.ui_expanded, DEFAULT_EXPANDED_PREVIEW_SECTIONS);
  node._anPreviewState = state;
  writePreviewStateToWidget(node, state);
  return state;
}
export const restorePreviewStateFromWidget = ensurePreviewState;

export function persistPreviewState(node) {
  writePreviewStateToWidget(node, node._anPreviewState);
}

// ---------------------------------------------------------------------------
// Litegraph socket wiring helpers.
// ---------------------------------------------------------------------------

export function isInputWired(node, name) {
  const inputs = node.inputs || [];
  const input = inputs.find((i) => i && i.name === name);
  return !!(input && input.link != null);
}

// ---------------------------------------------------------------------------
// Socket self-healing (`AnimaGenerator`'s Python surface changed under it --
// `d021c09`; an ALREADY-PLACED node keeps every old socket AND gains the new
// ones, since litegraph restores a saved node's `inputs`/`outputs` arrays
// verbatim from the workflow file, oblivious to whatever `INPUT_TYPES`/
// `RETURN_TYPES` the CURRENT Python class declares). `healNodeSockets`
// reconciles an already-restored instance against the definition
// `beforeRegisterNodeDef` was just handed for THAT EXACT class (`nodeData`)
// -- no `window.LiteGraph` registry lookup needed at all here, unlike
// `js/controls/index.js`'s cross-class `readKnownLists` (KSampler's combo
// lists, read from a DIFFERENT node's definition) -- this is always the SAME
// class we were just handed the definition for.
//
// Three rules, matching the task brief exactly:
//   1. A socket whose name isn't ANYWHERE in the current definition is
//      DEAD -- its link (if any) points at something the backend no longer
//      declares -- so it's removed outright.
//   2. A duplicate name (the real-world trigger: re-registering a class
//      hands a restored instance every NEW socket without touching the OLD
//      ones already sitting in its saved `inputs`/`outputs` arrays) collapses
//      to its FIRST occurrence.
//   3. Whatever survives is reordered to the definition's own order, since
//      litegraph indexes links POSITIONALLY (docs/control-panel-design.md
//      §4's whole reasoning for keeping "slot" separate from display order)
//      -- reordering an array of sockets without ALSO retargeting every
//      surviving link's `target_slot`/`origin_slot` to its socket's NEW
//      index would silently rewire the graph rather than heal it.
//
// `computeNodeDefinition` is the ONLY thing that reads `nodeData` --
// everything past it works in plain socket-NAME terms, so a `STRING`
// optional field a past workflow already converted from widget to input
// (litegraph's own "convert to input" gesture) is treated exactly like any
// other declared field: present in the definition => never removed just
// because it isn't a type that renders as a socket BY DEFAULT. Matching by
// NAME only (never by declared type) is deliberate -- this repo's own test
// fixtures already assume `AnimaPreview.metadata_json` manifests as a real
// litegraph input despite carrying no `forceInput`, exactly the case this
// choice has to get right.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * `nodeData` -> `{ inputOrder: string[], outputs: [{name, type}] }`, or
 * `null` for anything this function can't trust: missing/malformed shape
 * (`nodeData`/`nodeData.input` not an object, `required`/`optional` present
 * but not objects, `output`/`output_name` present but not arrays), OR a
 * shape that passed every one of those checks yet still came out with NO
 * inputs AND NO outputs -- indistinguishable from a broken definition this
 * function's own type checks didn't catch, and every real node in this pack
 * declares at least one of the two, so refusing to heal against it is
 * strictly safer than risking a wipe of every socket on a real node against
 * a definition this function got wrong (the task's explicit guard: never
 * heal against an empty definition).
 */
export function computeNodeDefinition(nodeData) {
  if (!isPlainObject(nodeData)) {
    return null;
  }
  const input = nodeData.input;
  if (input !== undefined && !isPlainObject(input)) {
    return null;
  }
  const required = input ? input.required : undefined;
  const optional = input ? input.optional : undefined;
  if (required !== undefined && !isPlainObject(required)) {
    return null;
  }
  if (optional !== undefined && !isPlainObject(optional)) {
    return null;
  }
  const output = nodeData.output;
  if (output !== undefined && !Array.isArray(output)) {
    return null;
  }
  const outputName = nodeData.output_name;
  if (outputName !== undefined && !Array.isArray(outputName)) {
    return null;
  }

  // Required keys before optional keys, each in their own declared order --
  // the append-only convention every `INPUT_TYPES` in this pack already
  // follows (`.claude/CLAUDE.md`'s "widget order is append-only"), so this
  // IS the definition's own canonical socket order.
  const seen = new Set();
  const inputOrder = [];
  for (const key of Object.keys(required || {})) {
    if (!seen.has(key)) {
      seen.add(key);
      inputOrder.push(key);
    }
  }
  for (const key of Object.keys(optional || {})) {
    if (!seen.has(key)) {
      seen.add(key);
      inputOrder.push(key);
    }
  }

  const outputTypes = output || [];
  const outputs = outputTypes.map((type, i) => {
    const name = Array.isArray(outputName) && typeof outputName[i] === "string" && outputName[i] ? outputName[i] : type;
    return { name, type };
  });

  if (inputOrder.length === 0 && outputs.length === 0) {
    return null;
  }
  return { inputOrder, outputs };
}

/** `node.graph.links[id]`, or `null` if the id/graph/table isn't there --
 * every caller already tolerates `null` (a link that can't be found is
 * simply left un-retargeted; the socket move itself still happens). */
function findLink(node, linkId) {
  if (linkId == null) {
    return null;
  }
  const links = node.graph && node.graph.links;
  return (links && links[linkId]) || null;
}

/** Point socket `item` (already sitting at `newIndex` in `node.inputs`/
 * `node.outputs`) at its new position, on every `LLink` that still
 * references it -- an input has at most one (`item.link`); an output can
 * fan out to several (`item.links`). This is the manual half of rule 3
 * above: there is no litegraph "move slot" API, so a reorder has to fix
 * this bookkeeping itself, exactly as `removeInput`/`removeOutput` already
 * do for the slots that shift down after something is removed. */
function retargetSlot(node, item, newIndex, isOutput) {
  if (isOutput) {
    (item.links || []).forEach((linkId) => {
      const link = findLink(node, linkId);
      if (link) {
        link.origin_slot = newIndex;
      }
    });
  } else if (item.link != null) {
    const link = findLink(node, item.link);
    if (link) {
      link.target_slot = newIndex;
    }
  }
}

/** Defensive fallback for a host with no `removeInput`/`removeOutput`
 * (shouldn't occur against real litegraph -- see the build report) --
 * splices the dead slot out and re-derives every SURVIVING slot's own
 * index (`retargetSlot`), the same bookkeeping the real API would have
 * done. */
function fallbackRemoveSlot(node, key, idx, isOutput) {
  const arr = node[key];
  if (!Array.isArray(arr) || idx < 0 || idx >= arr.length) {
    return;
  }
  const removed = arr[idx];
  const links = node.graph && node.graph.links;
  if (isOutput) {
    (removed.links || []).forEach((linkId) => {
      if (links) {
        delete links[linkId];
      }
    });
  } else if (removed.link != null && links) {
    delete links[removed.link];
  }
  arr.splice(idx, 1);
  arr.forEach((item, i) => {
    if (i >= idx) {
      retargetSlot(node, item, i, isOutput);
    }
  });
}

/**
 * Reconciles ONE socket array (`node.inputs` or `node.outputs`, per `key`)
 * against `defNames` (the current definition's own names, IN ORDER).
 * Removes anything not in `defNames`, and every duplicate past the first
 * matching occurrence, via `node.removeInput`/`removeOutput` -- the API
 * methods, so a removed slot's own link is properly torn down and every
 * LATER slot's `target_slot`/`origin_slot` shifts down with it, per the
 * task's explicit preference over a raw splice -- then reorders whatever
 * survives to match `defNames` (manual -- see `retargetSlot`; no litegraph
 * API does this). Never touches the array at all if it already matches
 * (same names, same order): the no-op case this whole feature must get
 * right, so an already-correct node reports `changed: false` and `node[key]`
 * stays the EXACT SAME array reference -- no new array, no dirty flag.
 */
function reconcileSocketArray(node, key, defNames) {
  const existing = Array.isArray(node[key]) ? node[key] : [];
  if (existing.length === 0) {
    return { changed: false, removedNames: [] };
  }
  const isOutput = key === "outputs";
  const defSet = new Set(defNames);
  const seenNames = new Set();
  const removedIdx = [];
  const removedNames = [];

  existing.forEach((item, idx) => {
    const name = item && item.name;
    if (!defSet.has(name) || seenNames.has(name)) {
      removedIdx.push(idx);
      removedNames.push(name);
      return;
    }
    seenNames.add(name);
  });

  if (removedIdx.length > 0) {
    const removeFnName = isOutput ? "removeOutput" : "removeInput";
    const removeFn = typeof node[removeFnName] === "function" ? node[removeFnName].bind(node) : null;
    // Highest index first -- removing low-to-high would shift the indices
    // of entries not yet processed out from under this loop.
    removedIdx
      .slice()
      .sort((a, b) => b - a)
      .forEach((idx) => {
        if (removeFn) {
          removeFn(idx);
        } else {
          fallbackRemoveSlot(node, key, idx, isOutput);
        }
      });
  }

  const survivors = Array.isArray(node[key]) ? node[key] : [];
  const byName = new Map(survivors.map((item) => [item.name, item]));
  const desired = defNames.filter((name) => byName.has(name)).map((name) => byName.get(name));
  const alreadyInOrder = desired.length === survivors.length && desired.every((item, i) => item === survivors[i]);

  if (!alreadyInOrder) {
    node[key] = desired;
    desired.forEach((item, i) => retargetSlot(node, item, i, isOutput));
  }

  return { changed: removedIdx.length > 0 || !alreadyInOrder, removedNames };
}

/** Grab `node.size`'s current `[w, h]` as a fresh 2-entry array, or `null`
 * if `node.size` isn't there or isn't shaped like one -- `restoreNodeSize`
 * below already tolerates a `null` snapshot on its own (nothing to put
 * back), this just keeps that check in ONE place. */
function captureNodeSize(node) {
  if (Array.isArray(node.size) && node.size.length >= 2 && typeof node.size[0] === "number" && typeof node.size[1] === "number") {
    return [node.size[0], node.size[1]];
  }
  return null;
}

/** Write a `captureNodeSize` snapshot back onto `node.size`, IN PLACE --
 * assigning the two array ENTRIES directly rather than calling
 * `node.setSize(...)`, so this can never re-enter `index.js`'s own
 * `onResize` clamp chain (`clampGeneratorSize`/`clampPreviewSize`) while a
 * healing pass is still unwinding on the same call stack. A no-op if there
 * was nothing captured, or nowhere left to write it into (`node.size`
 * vanished, or shrank under 2 entries, between the capture and here --
 * shouldn't happen, but this stays defensive rather than throwing).
 *
 * Also marks the canvas dirty, since nothing else on `healNodeSockets`' own
 * call path necessarily will: `index.js`'s `onConfigure` wrapper calls
 * `mountNode` (via `restoreNode`) AFTER healing, but `mountNode` early-
 * returns on `node._anMounted` -- already `true` by the time healing runs,
 * because `onNodeCreated`'s own `loadMods().then(...)` is always ATTACHED
 * before `onConfigure`'s (litegraph's construct-then-configure deserialize
 * order), so that callback's `mountNode` call -- the one that actually sets
 * `_anMounted` and calls `setDirtyCanvas` -- has already run and returned by
 * the time this one fires. Without this call, a restored size fix would sit
 * correct in `node.size` but never actually repaint until some UNRELATED
 * later dirty flag happened to fire. */
function restoreNodeSize(node, saved) {
  if (!saved || !Array.isArray(node.size) || node.size.length < 2) {
    return;
  }
  node.size[0] = saved[0];
  node.size[1] = saved[1];
  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

/**
 * The one entry point `index.js` calls -- from the SAME deferred
 * `onConfigure` callback `restoreNode` already runs in, deliberately NOT
 * synchronously inside `onConfigure` itself. Litegraph's per-node
 * `configure()` restores THIS node's own `inputs`/`outputs` arrays
 * synchronously (matches this file's/`js/controls/index.js`'s existing
 * "litegraph has already restored every widget's real saved value before
 * either callback fires" doc note), but the GRAPH-level `links` table
 * (`node.graph.links`, keyed by link id) is only assembled AFTER every node
 * has been configured -- still inside that same synchronous
 * `graph.configure()` call, but strictly after this function would have
 * already returned if it ran eagerly inside `onConfigure`. Reordering
 * survivors needs to retarget real `LLink` objects (`retargetSlot`) that
 * plain don't exist yet at that point; deferring to a microtask (the
 * `loadMods().then(...)` this rides on already does exactly that, since a
 * Promise callback never runs before the CURRENT synchronous stack -- the
 * entire graph-configure pass, links table included -- has finished
 * unwinding) is what makes that safe.
 *
 * VERIFY-IN-COMFYUI: this ordering (every node configured, THEN the graph's
 * own `links` table built, all synchronously within one `graph.configure()`
 * call) is read from litegraph's documented deserialize sequence, not
 * exercised against a live process (none installed in this dev
 * environment).
 *
 * ## Size preserve/restore around the mutation (the "shrinks to min on every
 * refresh" fix)
 *
 * VERIFY-IN-COMFYUI: litegraph's own `removeInput`/`removeOutput`/
 * `addInput`/`addOutput` are documented as each ending with
 * `this.size = this.computeSize()` -- i.e. every one of `reconcileSocketArray`'s
 * add/remove calls, below, throws away whatever size litegraph JUST restored
 * from the saved workflow and replaces it with the node's freshly-computed
 * MINIMUM. This is read from litegraph's documented behaviour, not exercised
 * against a live ComfyUI process (none installed in this dev environment) --
 * but it is exactly the reported bug ("our generator height and width is
 * sized down on refresh page to min"): a workflow saved before the Context
 * Bridge landed carries stale sockets, `healNodeSockets` heals it on EVERY
 * load (the user never re-saves), and every one of those heals used to
 * re-snap the node back to its minimum, silently, every single refresh.
 *
 * The fix: snapshot `node.size` BEFORE either `reconcileSocketArray` call,
 * and write it straight back (`restoreNodeSize`) afterward -- but ONLY when
 * healing actually changed something. A load that heals nothing must stay
 * byte-for-byte unchanged (no size write at all), so a clean, already-
 * current workflow still cannot open "modified". Removing this preserve/
 * restore silently reintroduces the exact bug above -- and per the
 * VERIFY-IN-COMFYUI caveat, keeping it costs nothing even if some litegraph
 * build turns out NOT to resize on these calls: a no-op restore of the size
 * to itself is harmless either way.
 */
export function healNodeSockets(node, nodeData) {
  const def = computeNodeDefinition(nodeData);
  if (!def) {
    return { changed: false, removedInputs: [], removedOutputs: [] };
  }
  const savedSize = captureNodeSize(node);
  const inputResult = reconcileSocketArray(node, "inputs", def.inputOrder);
  const outputResult = reconcileSocketArray(node, "outputs", def.outputs.map((o) => o.name));
  const changed = inputResult.changed || outputResult.changed;
  if (changed) {
    restoreNodeSize(node, savedSize);
  }
  return {
    changed,
    removedInputs: inputResult.removedNames,
    removedOutputs: outputResult.removedNames,
  };
}

// ---------------------------------------------------------------------------
// Context-bridge resolution -- see this module's top doc comment.
// ---------------------------------------------------------------------------

const CONTEXT_BRIDGE_TYPE = "AnimaContextBridge";
const MAX_PASSTHROUGH_HOPS = 24;

function findInput(nodeLike, name) {
  return (nodeLike.inputs || []).find((i) => i && i.name === name);
}

/** The real litegraph node feeding `nodeLike`'s `inputName` input, or `null`
 * if that input is unwired, dangling, or the graph/link tables aren't
 * available (every case fails closed, never throws). Tries `getInputLink`
 * (the documented litegraph API) first, falling back to `graph.links[id]`
 * (older/undocumented but common) — this dev environment has no live
 * ComfyUI process to confirm which one a given litegraph build actually
 * exposes, so both are tried. */
function resolveLinkOrigin(nodeLike, inputName) {
  const input = findInput(nodeLike, inputName);
  if (!input || input.link == null) {
    return null;
  }
  const graph = nodeLike.graph;
  if (!graph || typeof graph.getNodeById !== "function") {
    return null;
  }
  let link = null;
  if (typeof nodeLike.getInputLink === "function") {
    const idx = (nodeLike.inputs || []).indexOf(input);
    link = nodeLike.getInputLink(idx);
  }
  if (!link && graph.links) {
    link = graph.links[input.link];
  }
  if (!link || link.origin_id == null) {
    return null;
  }
  return graph.getNodeById(link.origin_id);
}

/**
 * Walk backward from `node`'s "context" input to the real
 * `AnimaContextBridge` node, tolerating any number of single-input/
 * single-output pass-through nodes in between (Reroute and similar,
 * matched GENERICALLY by "exactly one input", not by class name — mirrors
 * the Control Panel's own tolerance of arbitrary "*" pass-through targets).
 * Returns the producer node, or `null` for unwired / dangling / a cycle / a
 * producer that isn't the bridge.
 *
 * VERIFY-IN-COMFYUI: this walk (and the `getInputLink`/`graph.links`
 * fallback chain in `resolveLinkOrigin`) is read from litegraph's documented
 * API surface, not exercised against a live process (none installed in this
 * dev environment).
 */
export function resolveContextBridge(node) {
  let current = node;
  let inputName = "context";
  const visited = new Set([node]);
  for (let hop = 0; hop < MAX_PASSTHROUGH_HOPS; hop += 1) {
    const producer = resolveLinkOrigin(current, inputName);
    if (!producer || visited.has(producer)) {
      return null; // unwired, dangling, or a cycle
    }
    visited.add(producer);
    if (producer.type === CONTEXT_BRIDGE_TYPE || producer.comfyClass === CONTEXT_BRIDGE_TYPE) {
      return producer;
    }
    const pInputs = producer.inputs || [];
    if (pInputs.length === 1) {
      current = producer;
      inputName = pInputs[0].name;
      continue;
    }
    return null; // wired to something real that isn't the bridge
  }
  return null;
}

/** `{bridgeFound, bridge, supplied: {field: bool}}` for every one of
 * `CONTEXT_FIELDS` — see this module's top doc comment for the fail-closed
 * contract when no bridge resolves. */
export function computeContextSupplied(node) {
  const bridge = resolveContextBridge(node);
  if (!bridge) {
    return { bridgeFound: false, bridge: null, supplied: {} };
  }
  const supplied = {};
  for (const field of CONTEXT_FIELDS) {
    const input = findInput(bridge, field);
    supplied[field] = !!(input && input.link != null);
  }
  return { bridgeFound: true, bridge, supplied };
}

const GENERATOR_TYPE = "AnimaGenerator";

/** Every real litegraph node immediately fed by `nodeLike`'s `outputName`
 * OUTPUT, in link order — `output.links` (an array of link ids) ->
 * `graph.links[id].target_id` -> `graph.getNodeById(...)`. Mirrors
 * `resolveLinkOrigin`'s backward failure contract: no such output, no
 * links, no graph/link table, a dangling link, or a target id that doesn't
 * resolve all simply contribute nothing to the result, never throw. Unlike
 * an input (which carries at most one link), an output can fan out to
 * several — every one of them is followed. */
function resolveLinkTargets(nodeLike, outputName) {
  const output = (nodeLike.outputs || []).find((o) => o && o.name === outputName);
  const linkIds = output && Array.isArray(output.links) ? output.links : [];
  if (!linkIds.length) {
    return [];
  }
  const graph = nodeLike.graph;
  if (!graph || typeof graph.getNodeById !== "function" || !graph.links) {
    return [];
  }
  const targets = [];
  for (const linkId of linkIds) {
    const link = graph.links[linkId];
    if (!link || link.target_id == null) {
      continue;
    }
    const target = graph.getNodeById(link.target_id);
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}

/**
 * Walk FORWARD from `bridge`'s "context" OUTPUT to every real
 * `AnimaGenerator` reachable from it, tunnelling through any number of
 * single-input/single-output pass-through nodes (Reroute and similar,
 * matched GENERICALLY by "exactly one output" — the forward mirror of
 * `resolveContextBridge`'s own "exactly one input" backward tolerance) and
 * fanning out across every link a single output can carry (an input has at
 * most one; an output can drive several, so this walk — unlike the
 * backward one — can branch). Returns every distinct generator found, in
 * discovery order; `[]` for a dead end (unwired, dangling, every branch a
 * cycle, or a `bridge` that isn't real) — never throws, since every failure
 * path routes through `resolveLinkTargets`, which already fails closed. A
 * node reached that is neither a pass-through nor an `AnimaGenerator` (a
 * real node with more than one output, wired to something else entirely) is
 * simply not followed past — it contributes nothing, exactly like a
 * dangling link.
 *
 * This is what makes the Generator's "context-supplied" panel repaint when
 * a socket is wired/unwired on the BRIDGE rather than on the Generator
 * itself — the Bridge mounts no UI of its own (`js/anima/index.js`'s
 * `mountsUi` gate) and so never gets its own `onConnectionsChange` repaint
 * hook the way the Generator does for its OWN `context` link; this walk is
 * what lets that hook, installed on the Bridge, find every Generator
 * downstream of it and repaint THEM instead.
 *
 * VERIFY-IN-COMFYUI: same caveat as `resolveContextBridge` — read from
 * litegraph's documented link-table shape (`output.links`/`graph.links[id]`/
 * `target_id`), not exercised against a live process (none installed in
 * this dev environment).
 */
export function resolveDownstreamGenerators(bridge) {
  if (!bridge) {
    return [];
  }
  const found = [];
  const foundSet = new Set();
  const visited = new Set([bridge]);

  function walk(node, outputName, hop) {
    if (hop >= MAX_PASSTHROUGH_HOPS) {
      return;
    }
    for (const target of resolveLinkTargets(node, outputName)) {
      if (visited.has(target)) {
        continue; // a cycle -- already walked this node, never re-enter it
      }
      if (target.type === GENERATOR_TYPE || target.comfyClass === GENERATOR_TYPE) {
        if (!foundSet.has(target)) {
          foundSet.add(target);
          found.push(target);
        }
        continue; // a generator is a leaf for this walk -- don't walk past it
      }
      const outputs = target.outputs || [];
      if (outputs.length !== 1) {
        continue; // not a pass-through (and not a generator) -- this branch dead-ends
      }
      visited.add(target);
      walk(target, outputs[0].name, hop + 1);
    }
  }

  walk(bridge, "context", 0);
  return found;
}

/**
 * Wipes whatever the last run reported for `node`'s context-supplied
 * fields (`node._anContextRun`, `handleGeneratorExecuted`'s own stash) --
 * the ONE place `index.js`'s two `onConnectionsChange` hooks (the
 * Generator's own, and the Bridge's forward-walk one) both route through,
 * so a stale "supplied" from before a rewire can never outlive the wiring
 * it described. A no-op (never throws) for a falsy `node` or one that never
 * had anything stashed.
 */
export function clearContextRun(node) {
  if (node) {
    node._anContextRun = null;
  }
}

/**
 * Merges the LIVE litegraph-link view (`computeContextSupplied`, above)
 * with the LAST RUN's own report (`node._anContextRun`, stashed by
 * `handleGeneratorExecuted` off `AnimaGenerator`'s `anima_context` `ui`
 * payload — `src/anima/context.build_context_ui_payload`'s shape) — post-
 * run is authoritative for anything the live link walk can't see at all
 * (Use Everywhere never rides a litegraph link), so EITHER signal being
 * true is enough to treat a field as context-supplied.
 *
 * `node._anContextRun` is cleared on every connection change (both the
 * Generator's own `onConnectionsChange` hook and the Bridge's forward-walk
 * one, both in `index.js`) specifically so a stale "supplied" from before a
 * rewire can never outlive the wiring it described — this function only
 * ever reads whatever's CURRENTLY stashed, it doesn't do that clearing
 * itself.
 *
 * -> `{ bridgeFound, bridge, supplied: {field: bool}, source: {field:
 * "live"|"run"|null}, runSupplied: {field: bool}, values: {field: value} }`.
 * `source` is which signal EXPLAINS the "supplied" state (live wins when
 * both are true, since it's the more concrete of the two to name in a
 * tooltip); `runSupplied` is the run's OWN flag independently of `source`
 * (a caller needs this to tell "the run said supplied but carried no
 * value" apart from "never run at all"); `values` carries the run's own
 * sampler scalar for a field the run reported supplied for AND actually
 * had a value for — never invented, never present for a field the run
 * didn't report a real value for (`build_context_ui_payload`'s own
 * "supplied but None" case included).
 */
export function computeEffectiveContextSupplied(node) {
  const live = computeContextSupplied(node);
  const run = (node && node._anContextRun) || null;
  const runSuppliedAll = (run && run.supplied) || {};
  const runValuesAll = (run && run.values) || {};

  const supplied = {};
  const source = {};
  const runSupplied = {};
  const values = {};
  for (const field of CONTEXT_FIELDS) {
    const isLive = !!live.supplied[field];
    const isRun = !!runSuppliedAll[field];
    runSupplied[field] = isRun;
    supplied[field] = isLive || isRun;
    source[field] = isLive ? "live" : (isRun ? "run" : null);
    if (isRun && runValuesAll[field] !== undefined && runValuesAll[field] !== null) {
      values[field] = runValuesAll[field];
    }
  }
  return { bridgeFound: live.bridgeFound, bridge: live.bridge, supplied, source, runSupplied, values };
}

const SAMPLERS = ["euler", "euler_ancestral", "er_sde", "dpmpp_2m", "heun", "ddim"];
const SCHEDULERS = ["simple", "sgm_uniform", "karras", "normal", "beta", "exponential"];

// ---------------------------------------------------------------------------
// Expandable section (2026-07-28 inline-sections dispatch, THEN the
// switch-owns-expand/collapse dispatch the same day) -- the ONE shape every
// section (Sampler, Mod Guidance, Highres, Detailer, Upscale, Postprocess,
// Save) is built from: a `buildSectionHeader` (render.mjs), an optional
// enable switch, and -- only while `expanded` -- a `.wtn-an-sbody`
// `buildBody` fills in. There is no more "this popover's own local refresh"
// concept (this module's top doc comment): every mutation, including a tab
// switch inside the Detailer section, just calls `onToggleExpand`'s/
// `onToggleSwitch`'s sibling `repaintGenerator`/`repaintPreview` directly --
// one full-body repaint is already how every OTHER action here works, and
// there is no separate floating layer left to protect from that.
//
// **Expand/collapse is the SWITCH's job, not the header's, for any section
// that HAS a switch.** Clicking the header row of a switched section (Mod
// Guidance, Highres, Detailer, Upscale, Postprocess, Save) does nothing at
// all -- no listener is even attached for that case. The switch's own click
// (still `stopPropagation`'d, so it never ALSO reaches a header listener)
// now does double duty: `onToggleSwitch` flips `enabled` AND sets that
// section's `ui_expanded[key]` to match (on => expanded, off => collapsed),
// in ONE persist + ONE repaint -- see `setSwitchAndExpand` below, which
// every switched section's `onToggleSwitch` calls so this isn't
// reimplemented seven times. Consequence, intentional: a section that's
// currently enabled cannot be collapsed while it STAYS enabled -- turning it
// off is what collapses it. `onToggleExpand` is still accepted in every
// call site's spec object (kept for symmetry / in case a future switchless
// section needs it wired the old way), it is simply never invoked by this
// function when `hasSwitch` is true.
//
// **Carve-out: a SWITCHLESS section (Sampler, no enable switch at all --
// design brief: "Sampler is a section too, always present") keeps the
// header-click expand/collapse toggle.** Without a switch there is nothing
// else on the header that could open/close it, so removing the header
// listener for this case would make its body permanently unreachable.
// ---------------------------------------------------------------------------

/**
 * `spec`: `{ key, label, expanded, hasSwitch, switchOn, infoTooltip,
 * infoWarn, summary, dep, onToggleExpand, onToggleSwitch, buildBody(body) }`.
 * `buildBody` is only called (and its result only appended) while
 * `expanded` is true.
 */
function buildSection(doc, spec) {
  const { label, expanded, hasSwitch, switchOn, infoTooltip, infoWarn, summary, dep, onToggleExpand, onToggleSwitch, buildBody } = spec;
  const frag = el(doc, "div", "wtn-an-section");
  const head = buildSectionHeader(doc, { label, expanded, hasSwitch, switchOn, infoTooltip, infoWarn, summary, dep });
  if (!hasSwitch) {
    // Switchless section (Sampler) -- see this section's own top doc comment
    // for why the header click keeps doing this job here and ONLY here.
    head.root.addEventListener("click", () => onToggleExpand());
  }
  if (head.switchEl) {
    head.switchEl.addEventListener("click", (e) => {
      e.stopPropagation();
      onToggleSwitch();
    });
  }
  frag.appendChild(head.root);
  if (expanded) {
    const body = el(doc, "div", "wtn-an-sbody");
    buildBody(body);
    frag.appendChild(body);
  }
  return frag;
}

/**
 * The combined write a switched section's switch now performs (this
 * section's own top doc comment): flip `entry.enabled` and set
 * `state.ui_expanded[key]` to match it, in one pure mutation -- every call
 * site still owns its own single `persist*`/`repaint*` call around this, so
 * there is exactly one persist and one repaint per click, never two.
 */
function setSwitchAndExpand(state, key, entry) {
  entry.enabled = !entry.enabled;
  state.ui_expanded[key] = entry.enabled;
}

// ---------------------------------------------------------------------------
// Sampler section (no enable switch -- design brief: "Sampler is a section
// too, always present, no enable switch") + Mod Guidance section.
// ---------------------------------------------------------------------------

/** The "supplied but the source didn't say what" tail every disabled
 * sampler field's tooltip gets appended when `eff.runSupplied[field]` is
 * true but `eff.values` carries nothing for it — the run's own "don't
 * invent a value" contract (`computeEffectiveContextSupplied`'s doc
 * comment / `src/anima/context.build_context_ui_payload`'s "supplied but
 * None" case) surfacing as readable text instead of a silently-stale
 * number. */
const NO_RUN_VALUE_NOTE = " The last run reported it supplied but carried no value for this field — showing the settings value.";

/** One SAMPLER_FIELDS entry -- editable (`buildNumericField`/
 * `buildStepperField`) when nothing supplies it (live wire NOR last run),
 * or the SAME field shape genuinely disabled (`disabledReason`) with a
 * yellow ⓘ beside it when either does (this module's top doc comment).
 * `eff` is `computeEffectiveContextSupplied(node)`'s own return shape --
 * see that function's doc comment for `source`/`runSupplied`/`values`.
 *
 * The disabled value shown is the RUN's own (`eff.values[field]`) when the
 * last run actually reported one for this field, REGARDLESS of whether
 * `source` picked "live" or "run" for the TOOLTIP text (a field can be
 * both currently live-wired AND have a real run value -- showing the real
 * number beats a guess either way); it falls back to this settings tree's
 * own value whenever there's no run value to show (never run at all, or a
 * run that reported supplied with none -- `NO_RUN_VALUE_NOTE` covers that
 * second case in the tooltip). */
function buildSamplerField(doc, node, field, sampler, eff) {
  const isSupplied = !!eff.supplied[field];
  const hasRunValue = !!eff.runSupplied[field] && Object.prototype.hasOwnProperty.call(eff.values, field);
  const displayValue = hasRunValue ? eff.values[field] : sampler[field];

  let disabledReason;
  if (isSupplied) {
    disabledReason = eff.source[field] === "live"
      ? "Supplied by the Context Bridge upstream — disconnect that socket to edit here."
      : "Supplied at run time — from the Context Bridge or Use Everywhere; this frontend cannot see UE wires at edit time.";
    if (eff.runSupplied[field] && !hasRunValue) {
      disabledReason += NO_RUN_VALUE_NOTE;
    }
  }

  let fieldRoot;
  if (field === "sampler_name" || field === "scheduler") {
    const options = field === "sampler_name" ? SAMPLERS : SCHEDULERS;
    fieldRoot = buildStepperField(doc, { label: field, value: displayValue, options, disabledReason }, {
      onChange: (v) => { sampler[field] = v; persistGenState(node); },
    }).root;
  } else {
    const opts = field === "cfg" ? { min: 0, max: 30, step: 0.1 }
      : field === "steps" ? { min: 1, max: 150, step: 1 }
        : { min: -1, max: 2147483647, step: 1 }; // seed
    const kind = field === "cfg" ? "float" : "int";
    fieldRoot = buildNumericField(doc, {
      label: field, kind, opts, disabledReason,
      getValue: () => displayValue, setValue: (v) => { sampler[field] = v; },
    }, () => persistGenState(node)).root;
  }
  return withInfoIcon(doc, fieldRoot, disabledReason, true);
}

/** One SAMPLER_FIELDS entry's summary-line text -- the run's own value
 * (formatted, if given) when supplied AND the run actually had one, `"—"`
 * when supplied but the run didn't, or this settings tree's own value when
 * nothing supplies it at all. `format` is optional (defaults to plain
 * `String`), used for `cfg`'s one-decimal display. */
function summaryFieldText(field, eff, sampler, format) {
  const fmt = format || ((v) => String(v));
  if (eff.supplied[field]) {
    return eff.runSupplied[field] && Object.prototype.hasOwnProperty.call(eff.values, field)
      ? fmt(eff.values[field])
      : "—";
  }
  return fmt(sampler[field]);
}

function buildSamplerSection(doc, node, ctx, state) {
  const expanded = !!state.ui_expanded.sampler;
  const sampler = state.sampler;
  const eff = computeEffectiveContextSupplied(node);
  const { bridgeFound } = eff;
  const summary = `${summaryFieldText("sampler_name", eff, sampler)} / ${summaryFieldText("scheduler", eff, sampler)} · `
    + `${summaryFieldText("steps", eff, sampler)} steps · cfg ${summaryFieldText("cfg", eff, sampler, (v) => Number(v).toFixed(1))}`;
  const infoTooltip = bridgeFound
    ? "Fields the Anima Context Bridge has wired drive this run; everything else comes from here."
    : "No Anima Context Bridge resolved upstream of ‘context’ (unwired, or wired through something that isn't a bridge) -- every field below comes from here.";

  return buildSection(doc, {
    key: "sampler", label: "Sampler", expanded, hasSwitch: false, infoTooltip, summary,
    onToggleExpand: () => {
      state.ui_expanded.sampler = !expanded;
      persistGenState(node);
      repaintGenerator(node, ctx);
    },
    buildBody: (body) => {
      SAMPLER_FIELDS.forEach((field) => {
        body.appendChild(buildSamplerField(doc, node, field, sampler, eff));
      });
      body.appendChild(buildNumericField(doc, {
        label: "denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
        getValue: () => sampler.denoise, setValue: (v) => { sampler.denoise = v; },
      }, () => persistGenState(node)).root);
      const shiftField = buildNumericField(doc, {
        label: "shift", kind: "float", opts: { min: 0, max: 10, step: 0.1 },
        getValue: () => sampler.shift, setValue: (v) => { sampler.shift = v; },
      }, () => persistGenState(node)).root;
      body.appendChild(withInfoIcon(doc, shiftField, "shift 3.0 is Anima's recommended default and is always applied. Later stages inherit these unless their own inherit_sampler_settings is off."));
    },
  });
}

function buildModGuidanceSection(doc, node, ctx, state, have) {
  const expanded = !!state.ui_expanded.mod_guidance;
  const mg = state.mod_guidance;
  const missing = !have.spectrum;
  const missingText = "ComfyUI-Spectrum-KSampler not installed -- Mod Guidance is unavailable.";

  return buildSection(doc, {
    key: "mod_guidance", label: "Mod Guidance", expanded, hasSwitch: true, switchOn: mg.enabled,
    infoTooltip: missing ? missingText : null, infoWarn: missing, dep: missing,
    summary: !missing && mg.enabled ? mg.profile : null,
    onToggleExpand: () => { state.ui_expanded.mod_guidance = !expanded; persistGenState(node); repaintGenerator(node, ctx); },
    onToggleSwitch: () => { setSwitchAndExpand(state, "mod_guidance", mg); persistGenState(node); repaintGenerator(node, ctx); },
    buildBody: (body) => {
      if (missing) {
        body.appendChild(buildMissing(doc, missingText));
        return;
      }
      body.appendChild(buildStepperField(doc, { label: "profile", value: mg.profile, options: ["step_i8_skip27", "step_i14", "uniform_w3"] }, {
        onChange: (v) => { mg.profile = v; persistGenState(node); },
      }).root);
      body.appendChild(buildNumericField(doc, {
        label: "mod_w", kind: "float", opts: { min: 0, max: 10, step: 0.1 },
        getValue: () => mg.mod_w, setValue: (v) => { mg.mod_w = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildNumericField(doc, {
        label: "mod_start_layer", kind: "int", opts: { min: 0, max: 48, step: 1 },
        getValue: () => mg.mod_start_layer, setValue: (v) => { mg.mod_start_layer = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildNumericField(doc, {
        label: "mod_end_layer", kind: "int", opts: { min: 0, max: 48, step: 1 },
        getValue: () => mg.mod_end_layer, setValue: (v) => { mg.mod_end_layer = v; },
      }, () => persistGenState(node)).root);

      body.appendChild(buildSublabel(doc, "quality tags"));
      const pos = buildTextField(doc, "positive", mg.quality_tags);
      pos.control.addEventListener("change", () => {
        mg.quality_tags = pos.control.value;
        persistGenState(node);
      });
      body.appendChild(pos.root);
      const neg = buildTextField(doc, "negative", mg.quality_neg);
      neg.control.addEventListener("change", () => {
        mg.quality_neg = neg.control.value;
        persistGenState(node);
      });
      body.appendChild(neg.root);
    },
  });
}

// ---------------------------------------------------------------------------
// Stage-sampler sub-block (highres/upscale/each detailer block) -- design
// doc §6b. Hides EXACTLY `cfg`/`sampler_name`/`scheduler` while
// `inherit_sampler_settings` is on; `steps`/`denoise` are always the
// stage's own. Appends into `container`. `refresh` is now always the
// enclosing section's own `repaintGenerator` call (no more popover-local
// refresh -- this module's top doc comment).
// ---------------------------------------------------------------------------

function appendStageSamplerFields(doc, container, stageSettings, firstPassSampler, onCommit, refresh) {
  const inherit = stageSettings.inherit_sampler_settings !== false;
  container.appendChild(buildSublabel(doc, "sampler · this stage"));

  const inheritField = buildBoolField(doc, "inherit", inherit);
  inheritField.word.textContent = inherit ? "on · cfg/sampler/scheduler from the first pass" : "off · this stage picks its own";
  inheritField.switchEl.addEventListener("click", () => {
    stageSettings.inherit_sampler_settings = !inherit;
    onCommit();
    refresh();
  });
  if (inherit) {
    const resolved = resolveStageSampler(stageSettings, firstPassSampler);
    container.appendChild(withInfoIcon(doc, inheritField.root,
      `Using cfg ${Number(resolved.cfg).toFixed(1)}, ${resolved.sampler_name} / ${resolved.scheduler} from the first pass. Steps and denoise below are still this stage's own.`));
  } else {
    container.appendChild(inheritField.root);
  }

  container.appendChild(buildNumericField(doc, {
    label: "steps", kind: "int", opts: { min: 1, max: 150, step: 1 },
    getValue: () => stageSettings.steps, setValue: (v) => { stageSettings.steps = v; },
  }, onCommit).root);
  container.appendChild(buildNumericField(doc, {
    label: "denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
    getValue: () => stageSettings.denoise, setValue: (v) => { stageSettings.denoise = v; },
  }, onCommit).root);

  if (!inherit) {
    container.appendChild(buildNumericField(doc, {
      label: "cfg", kind: "float", opts: { min: 0, max: 30, step: 0.1 },
      getValue: () => stageSettings.cfg, setValue: (v) => { stageSettings.cfg = v; },
    }, onCommit).root);
    container.appendChild(buildStepperField(doc, { label: "sampler_name", value: stageSettings.sampler_name, options: SAMPLERS }, {
      onChange: (v) => { stageSettings.sampler_name = v; onCommit(); },
    }).root);
    container.appendChild(buildStepperField(doc, { label: "scheduler", value: stageSettings.scheduler, options: SCHEDULERS }, {
      onChange: (v) => { stageSettings.scheduler = v; onCommit(); },
    }).root);
  }
}

/**
 * A `buildStepperField` bound to a live installed-file list from
 * `ctx.getKnownLists()` (`checkpoints`/`upscale_models` — this module's top
 * doc comment) — the SAM3 checkpoint / upscale model pickers, both
 * previously hardcoded upstream defaults with no frontend control at all
 * (this task's whole point).
 *
 * Degrades HONESTLY when `listKey`'s list is empty or unobtainable (no
 * models installed, or the owning node class isn't registered): the field
 * still shows `getValue()`'s current SAVED value, but renders DISABLED
 * (`buildStepperField`'s own `disabledReason` — no arrows, no cycling)
 * rather than an empty, clickable-but-useless picker. Never silently
 * substitutes `list[0]` for a saved value the list doesn't happen to
 * contain — `ce0528f`'s lesson: a value the user already has saved wins
 * over anything guessed from a list.
 */
function buildModelFilePicker(doc, ctx, listKey, label, missingText, getValue, setValue, onCommit) {
  const lists = ctx.getKnownLists ? ctx.getKnownLists() : {};
  const list = Array.isArray(lists && lists[listKey]) ? lists[listKey] : [];
  return buildStepperField(doc, {
    label, value: getValue(), options: list, disabledReason: list.length ? undefined : missingText,
  }, {
    onChange: (v) => { setValue(v); onCommit(); },
  }).root;
}

// ---------------------------------------------------------------------------
// Stage sections -- Highres, Detailer, Upscale, Postprocess. Each is a
// `buildSection` with its own enable switch (design brief); `stageSummary`/
// `stageBlocked` are unchanged from the popover era (still what feeds a
// section's muted header summary / `dep` dimming).
// ---------------------------------------------------------------------------

const STAGE_KEYS = ["highres", "detailer", "upscale", "postprocess"];

function stageSummary(stageKey, state, have) {
  if (stageKey === "highres") {
    const h = state.highres;
    return `${h.scale_by}x  denoise ${h.denoise}  ${h.steps} steps${h.inherit_sampler_settings ? "" : "  own sampler"}`;
  }
  if (stageKey === "detailer") {
    if (!have.impact) {
      return "Impact Pack not installed";
    }
    const order = state.detailer.order || [];
    const live = order.filter((id) => state.detailer.blocks[id] && state.detailer.blocks[id].enabled);
    if (!live.length) {
      return "no blocks on";
    }
    return live.map((id) => state.detailer.blocks[id].label).join(" > ");
  }
  if (stageKey === "upscale") {
    return have.usdu ? "USDU" : "USDU not installed";
  }
  return "fit " + state.postprocess.fit.max_long_edge + " long edge";
}

function stageBlocked(stageKey, state, have) {
  if (stageKey === "detailer") {
    const order = state.detailer.order || [];
    return !have.impact || !order.some((id) => state.detailer.blocks[id] && state.detailer.blocks[id].enabled);
  }
  if (stageKey === "upscale") {
    return !have.usdu;
  }
  return false;
}

function buildHighresSection(doc, node, ctx, state, have) {
  const expanded = !!state.ui_expanded.highres;
  const h = state.highres;
  return buildSection(doc, {
    key: "highres", label: "Highres", expanded, hasSwitch: true, switchOn: h.enabled,
    infoTooltip: "Latent upscale, resample at low denoise. Runs before the detailer, so faces get fixed at generation resolution rather than after an upscale.",
    summary: h.enabled ? stageSummary("highres", state, have) : null,
    // No `dep` here -- `stageBlocked` has no real logic for "highres" (it
    // only gates on a soft-import for detailer/upscale); passing it through
    // anyway would always be `false` and reads as a meaningless dead check.
    onToggleExpand: () => { state.ui_expanded.highres = !expanded; persistGenState(node); repaintGenerator(node, ctx); },
    onToggleSwitch: () => { setSwitchAndExpand(state, "highres", h); persistGenState(node); repaintGenerator(node, ctx); },
    buildBody: (body) => {
      body.appendChild(buildNumericField(doc, {
        label: "scale_by", kind: "float", opts: { min: 1, max: 4, step: 0.05 },
        getValue: () => h.scale_by, setValue: (v) => { h.scale_by = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildStepperField(doc, { label: "upscale_method", value: h.upscale_method, options: ["bicubic", "bilinear", "nearest-exact", "area"] }, {
        onChange: (v) => { h.upscale_method = v; persistGenState(node); },
      }).root);
      body.appendChild(buildTextField(doc, "multiple", h.multiple).root);
      body.appendChild(buildNumericField(doc, {
        label: "max_long_edge", kind: "int", opts: { min: 512, max: 8192, step: 32 },
        getValue: () => h.max_long_edge, setValue: (v) => { h.max_long_edge = v; },
      }, () => persistGenState(node)).root);
      appendStageSamplerFields(doc, body, h, state.sampler, () => persistGenState(node), () => repaintGenerator(node, ctx));
    },
  });
}

function buildUpscaleSection(doc, node, ctx, state, have) {
  const expanded = !!state.ui_expanded.upscale;
  const u = state.upscale;
  const missing = !have.usdu;
  const missingText = "ComfyUI_UltimateSDUpscale not installed -- the upscale stage is disabled.";
  const infoTooltip = "mode_type is tile ORDER (Linear/Chess/None). tiled_decode is an unrelated VAE flag -- don't conflate them."
    + (missing ? ` ${missingText}` : "");

  return buildSection(doc, {
    key: "upscale", label: "Upscale", expanded, hasSwitch: true, switchOn: u.enabled,
    infoTooltip, infoWarn: missing, dep: u.enabled && missing,
    summary: u.enabled ? stageSummary("upscale", state, have) : null,
    onToggleExpand: () => { state.ui_expanded.upscale = !expanded; persistGenState(node); repaintGenerator(node, ctx); },
    onToggleSwitch: () => { setSwitchAndExpand(state, "upscale", u); persistGenState(node); repaintGenerator(node, ctx); },
    buildBody: (body) => {
      if (missing) {
        body.appendChild(buildMissing(doc, missingText));
      }
      body.appendChild(buildNumericField(doc, {
        label: "scale_by", kind: "float", opts: { min: 1, max: 4, step: 0.05 },
        getValue: () => u.scale_by, setValue: (v) => { u.scale_by = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildModelFilePicker(
        doc, ctx, "upscale_models", "upscale_model_name",
        "No upscale models installed (UpscaleModelLoader's own list is empty or unavailable) -- showing the saved value.",
        () => u.usdu.upscale_model_name, (v) => { u.usdu.upscale_model_name = v; }, () => persistGenState(node),
      ));
      body.appendChild(buildStepperField(doc, { label: "mode_type", value: u.usdu.mode_type, options: ["Linear", "Chess", "None"] }, {
        onChange: (v) => { u.usdu.mode_type = v; persistGenState(node); },
      }).root);
      body.appendChild(buildStepperField(doc, { label: "seam_fix_mode", value: u.usdu.seam_fix_mode, options: ["None", "Band Pass", "Half Tile", "Half Tile + Intersections"] }, {
        onChange: (v) => { u.usdu.seam_fix_mode = v; persistGenState(node); },
      }).root);
      body.appendChild(buildNumericField(doc, {
        label: "seam_fix_denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
        getValue: () => u.usdu.seam_fix_denoise, setValue: (v) => { u.usdu.seam_fix_denoise = v; },
      }, () => persistGenState(node)).root);
      appendStageSamplerFields(doc, body, u, state.sampler, () => persistGenState(node), () => repaintGenerator(node, ctx));
    },
  });
}

function buildPostprocessSection(doc, node, ctx, state) {
  const expanded = !!state.ui_expanded.postprocess;
  const post = state.postprocess;
  const fit = post.fit;
  return buildSection(doc, {
    key: "postprocess", label: "Postprocess", expanded, hasSwitch: true, switchOn: post.enabled,
    infoTooltip: "The output size cap.",
    summary: post.enabled ? stageSummary("postprocess", state, {}) : null,
    onToggleExpand: () => { state.ui_expanded.postprocess = !expanded; persistGenState(node); repaintGenerator(node, ctx); },
    onToggleSwitch: () => { setSwitchAndExpand(state, "postprocess", post); persistGenState(node); repaintGenerator(node, ctx); },
    buildBody: (body) => {
      body.appendChild(buildStepperField(doc, { label: "mode", value: fit.mode, options: ["max_long_edge", "megapixels"] }, {
        onChange: (v) => { fit.mode = v; persistGenState(node); },
      }).root);
      body.appendChild(buildStepperField(doc, { label: "method", value: fit.method, options: ["bicubic", "bilinear", "area"] }, {
        onChange: (v) => { fit.method = v; persistGenState(node); },
      }).root);
      body.appendChild(buildNumericField(doc, {
        label: "max_long_edge", kind: "int", opts: { min: 256, max: 8192, step: 32 },
        getValue: () => fit.max_long_edge, setValue: (v) => { fit.max_long_edge = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildNumericField(doc, {
        label: "max_megapixels", kind: "float", opts: { min: 0.5, max: 32, step: 0.5 },
        getValue: () => fit.max_megapixels, setValue: (v) => { fit.max_megapixels = v; },
      }, () => persistGenState(node)).root);
    },
  });
}

/** The Detailer section's body -- tabs (one per block) + the active block's
 * own fields. `node._anDetailerTab` is ephemeral UI-only state (which block
 * is showing), same as before the inline-sections dispatch; every action
 * here still ends in a full `repaintGenerator` (`refresh` below), which is
 * exactly how every other section already behaves now. */
function buildDetailerBody(doc, node, ctx, state, box) {
  const detailer = state.detailer;
  const refresh = () => repaintGenerator(node, ctx);
  if (!node._anDetailerTab || !detailer.blocks[node._anDetailerTab]) {
    node._anDetailerTab = detailer.order[0] || "face";
  }
  const activeId = node._anDetailerTab;

  // SAM3 checkpoint (`detailer.sam3.checkpoint`) -- shared by EVERY block in
  // this stage (upstream's own `ctx_SAM3` loads once, per
  // `src/anima/pipeline.py`'s `run_detailer`), so it renders ONCE here,
  // above the per-block tabs, rather than duplicated inside each block's own
  // fields below. Previously a hardcoded upstream default with no frontend
  // control at all -- this task's whole point (see this module's top doc
  // comment on `getKnownLists`).
  box.appendChild(buildSublabel(doc, "sam3"));
  box.appendChild(buildModelFilePicker(
    doc, ctx, "checkpoints", "checkpoint",
    "No checkpoints installed (CheckpointLoaderSimple's own list is empty or unavailable) -- showing the saved value.",
    () => detailer.sam3.checkpoint, (v) => { detailer.sam3.checkpoint = v; }, () => persistGenState(node),
  ));

  const tabs = el(doc, "div", "wtn-an-passtabs");
  detailer.order.forEach((id) => {
    const block = detailer.blocks[id];
    if (!block) {
      return;
    }
    const btn = el(doc, "button");
    btn.type = "button";
    btn.className = id === activeId ? "wtn-an-on" : "";
    btn.textContent = block.label + (block.enabled ? "" : " (off)");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      node._anDetailerTab = id;
      refresh();
    });
    tabs.appendChild(btn);
  });
  const addBtn = el(doc, "button");
  addBtn.type = "button";
  const atMax = Object.keys(detailer.blocks).length >= MAX_DETAILER_PASSES;
  addBtn.disabled = atMax;
  addBtn.title = atMax ? "MAX_DETAILER_PASSES reached" : "Add a block";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const newId = addDetailerBlock(detailer);
    if (newId) {
      node._anDetailerTab = newId;
      persistGenState(node);
    }
    refresh();
  });
  tabs.appendChild(addBtn);
  box.appendChild(tabs);

  const block = detailer.blocks[activeId];
  if (!block) {
    return;
  }
  const order = detailer.order;
  const idx = order.indexOf(activeId);

  const moveRow = el(doc, "div", "wtn-an-passtabs");
  const up = el(doc, "button");
  up.type = "button";
  up.textContent = "<";
  up.disabled = idx <= 0;
  up.title = "Execution order";
  up.addEventListener("click", (e) => {
    e.stopPropagation();
    moveDetailerBlock(detailer, activeId, -1);
    persistGenState(node);
    refresh();
  });
  const down = el(doc, "button");
  down.type = "button";
  down.textContent = ">";
  down.disabled = idx < 0 || idx >= order.length - 1;
  down.addEventListener("click", (e) => {
    e.stopPropagation();
    moveDetailerBlock(detailer, activeId, 1);
    persistGenState(node);
    refresh();
  });
  const onBtn = el(doc, "button");
  onBtn.type = "button";
  onBtn.textContent = block.enabled ? "on" : "off";
  onBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    block.enabled = !block.enabled;
    persistGenState(node);
    refresh();
  });
  moveRow.appendChild(up);
  moveRow.appendChild(down);
  moveRow.appendChild(onBtn);
  if (isBuiltinDetailerBlock(activeId)) {
    const builtin = el(doc, "button");
    builtin.type = "button";
    builtin.disabled = true;
    builtin.title = "face/eye are built in and cannot be removed";
    builtin.textContent = "built in";
    moveRow.appendChild(builtin);
  } else {
    const del = el(doc, "button");
    del.type = "button";
    del.textContent = "remove";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeDetailerBlock(detailer, activeId);
      node._anDetailerTab = detailer.order[Math.min(idx, detailer.order.length - 1)] || "face";
      persistGenState(node);
      refresh();
    });
    moveRow.appendChild(del);
  }
  box.appendChild(moveRow);

  box.appendChild(buildTextField(doc, "label", block.label).root);
  box.appendChild(buildTextField(doc, "detect_prompt", block.detect_prompt).root);
  box.appendChild(buildNumericField(doc, {
    label: "detect_count", kind: "int", opts: { min: 1, max: 20, step: 1 },
    getValue: () => block.detect_count, setValue: (v) => { block.detect_count = v; },
  }, () => persistGenState(node)).root);
  box.appendChild(buildNumericField(doc, {
    label: "threshold", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
    getValue: () => block.threshold, setValue: (v) => { block.threshold = v; },
  }, () => persistGenState(node)).root);

  box.appendChild(buildSublabel(doc, "refine"));
  box.appendChild(buildNumericField(doc, {
    label: "feather", kind: "int", opts: { min: 0, max: 64, step: 1 },
    getValue: () => block.feather, setValue: (v) => { block.feather = v; },
  }, () => persistGenState(node)).root);
  box.appendChild(buildNumericField(doc, {
    label: "guide_size", kind: "int", opts: { min: 64, max: 4096, step: 32 },
    getValue: () => block.guide_size, setValue: (v) => { block.guide_size = v; },
  }, () => persistGenState(node)).root);
  box.appendChild(buildNumericField(doc, {
    label: "max_size", kind: "int", opts: { min: 64, max: 4096, step: 32 },
    getValue: () => block.max_size, setValue: (v) => { block.max_size = v; },
  }, () => persistGenState(node)).root);
  box.appendChild(buildNumericField(doc, {
    label: "crop_factor", kind: "float", opts: { min: 1, max: 10, step: 0.1 },
    getValue: () => block.crop_factor, setValue: (v) => { block.crop_factor = v; },
  }, () => persistGenState(node)).root);
  box.appendChild(buildNumericField(doc, {
    label: "cycle", kind: "int", opts: { min: 1, max: 10, step: 1 },
    getValue: () => block.cycle, setValue: (v) => { block.cycle = v; },
  }, () => persistGenState(node)).root);
  const guideSizeForField = buildBoolField(doc, "guide_size_for", block.guide_size_for);
  guideSizeForField.switchEl.addEventListener("click", () => {
    block.guide_size_for = !block.guide_size_for;
    persistGenState(node);
    refresh();
  });
  // The one warn ⓘ covers BOTH fields it names -- see this module's top doc
  // comment on the ⓘ affordance replacing a `buildNote` text block.
  box.appendChild(withInfoIcon(doc, guideSizeForField.root, "Do not \"fix\" these -- guide_size_for must be false and noise_mask_feather must not be 0.", true));
  box.appendChild(buildNumericField(doc, {
    label: "noise_mask_feather", kind: "int", opts: { min: 1, max: 64, step: 1 },
    getValue: () => block.noise_mask_feather, setValue: (v) => { block.noise_mask_feather = v; },
  }, () => persistGenState(node)).root);

  appendStageSamplerFields(doc, box, block, state.sampler, () => persistGenState(node), refresh);
}

function buildDetailerSection(doc, node, ctx, state, have) {
  const expanded = !!state.ui_expanded.detailer;
  const detailer = state.detailer;
  const missing = !have.impact;
  const missingText = "ComfyUI-Impact-Pack not installed. DetailerForEach is an Impact node, so the whole stage is unavailable.";
  const infoTooltip = "N blocks, like upstream: face and eye built in, + adds more. Each block detects for itself from its own detect_prompt -- no SEGS inputs."
    + (missing ? ` ${missingText}` : "");

  return buildSection(doc, {
    key: "detailer", label: "Detailer", expanded, hasSwitch: true, switchOn: detailer.enabled,
    infoTooltip, infoWarn: missing, dep: detailer.enabled && stageBlocked("detailer", state, have),
    summary: detailer.enabled ? stageSummary("detailer", state, have) : null,
    onToggleExpand: () => { state.ui_expanded.detailer = !expanded; persistGenState(node); repaintGenerator(node, ctx); },
    onToggleSwitch: () => { setSwitchAndExpand(state, "detailer", detailer); persistGenState(node); repaintGenerator(node, ctx); },
    buildBody: (body) => buildDetailerBody(doc, node, ctx, state, body),
  });
}

// ---------------------------------------------------------------------------
// Generator body root + mount/repaint
// ---------------------------------------------------------------------------

export function buildGeneratorBody(doc, node, ctx) {
  const state = node._anGenState;
  const have = ctx.havePackages ? ctx.havePackages() : { spectrum: true, usdu: true, impact: true };
  const body = el(doc, "div", "wtn-an-body");

  body.appendChild(sectionLabel(doc, "sampler"));
  body.appendChild(buildSamplerSection(doc, node, ctx, state));
  body.appendChild(buildModGuidanceSection(doc, node, ctx, state, have));

  const onCount = STAGE_KEYS.filter((k) => state[k].enabled).length;
  body.appendChild(sectionLabel(doc, "stages", `${onCount}/${STAGE_KEYS.length} on`));
  body.appendChild(buildHighresSection(doc, node, ctx, state, have));
  body.appendChild(buildDetailerSection(doc, node, ctx, state, have));
  body.appendChild(buildUpscaleSection(doc, node, ctx, state, have));
  body.appendChild(buildPostprocessSection(doc, node, ctx, state));
  return body;
}

export function mountGeneratorUI(node, ctx) {
  if (node._anRefs) {
    return node._anRefs;
  }
  const doc = ctx.doc;
  injectStyles(doc);
  const { root, panel } = buildPanelShell(doc);
  ensureGenState(node);
  const body = buildGeneratorBody(doc, node, ctx);
  panel.appendChild(body);
  const refs = { doc, root, panel, body };
  node._anRefs = refs;
  return refs;
}

export function repaintGenerator(node, ctx) {
  const refs = mountGeneratorUI(node, ctx);
  // The old body's icons (and any tip one of them is showing right now) are
  // about to be discarded wholesale -- see js/shared/fields.mjs's
  // `wireInfoTip` doc comment for the orphaned-tooltip trap this call
  // prevents.
  hideActiveInfoTip();
  const newBody = buildGeneratorBody(refs.doc, node, ctx);
  if (refs.body && refs.body.parentNode) {
    refs.body.parentNode.removeChild(refs.body);
  }
  refs.panel.appendChild(newBody);
  refs.body = newBody;
  if (node.setDirtyCanvas) {
    node.setDirtyCanvas(true, true);
  }
  return refs;
}

/**
 * `AnimaGenerator`'s `onExecuted` handler -- `message.anima_context` is
 * `nodes/anima/generator.py`'s own `"ui": {"anima_context": {...}}}`
 * payload (`src/anima/context.build_context_ui_payload`'s shape:
 * `{supplied: {field: bool, ...}, values: {field: value, ...}}`) -- the
 * only signal that can see a sampler scalar Use Everywhere injected
 * straight into the prompt at submit time (this module's top doc comment /
 * `computeEffectiveContextSupplied`'s own doc comment).
 *
 * Stashes the payload verbatim as `node._anContextRun` and repaints --
 * **`node._anContextRun` must NEVER be persisted into the settings blob**;
 * it is run output, not settings (this function never calls
 * `persistGenState`, deliberately), so a reload legitimately loses it. It
 * is cleared on every connection change instead (`index.js`'s
 * `onConnectionsChange` hooks, both the Generator's own and the Bridge's
 * forward-walk one), so a stale "supplied" can never outlive the wiring it
 * described.
 *
 * Reads ONLY `message.anima_context` -- no fallback to any other key
 * (dynamic-node-frontend skill §5: a stray `images` key is ComfyUI's OWN
 * native-preview trigger, never this node's data; matches `handleExecuted`
 * below reading ONLY `anima_stages`).
 *
 * VERIFY-IN-COMFYUI: that `onExecuted`'s `message` argument really is the
 * node's own `ui` dict verbatim, and that a non-`OUTPUT_NODE`'s `ui` dict
 * genuinely reaches it at all -- no live ComfyUI process in this dev
 * environment to confirm against (matches `nodes/anima/generator.py`'s own
 * VERIFY-IN-COMFYUI note on the Python side of this same channel).
 */
export function handleGeneratorExecuted(node, ctx, message) {
  if (!message || !message.anima_context || typeof message.anima_context !== "object" || Array.isArray(message.anima_context)) {
    return;
  }
  node._anContextRun = message.anima_context;
  repaintGenerator(node, ctx);
}

// ---------------------------------------------------------------------------
// Preview node
//
// `images` is now one optional LIST input (never three fixed sockets) --
// design doc §5/§7 reversal. Which stages the wipe can actually SHOW is no
// longer "which socket is wired", it's "which stage names are present in
// THIS RUN's `node._anPreviewImages`" (populated by `handleExecuted`, keyed
// by the `stage` field Python already resolved via
// `resolve_run_stage_labels` -- this module never re-derives that mapping).
// Before any run, that map is empty, so the wipe shows a "wired -- run to
// preview" / "nothing wired yet" placeholder depending on whether `images`
// itself is wired at all. (`handleExecuted`'s own doc comment below reads
// this data off `message.anima_stages`, NOT `message.images` -- see that
// comment for why.)
// ---------------------------------------------------------------------------

export function buildPreviewBody(doc, node, ctx) {
  const state = node._anPreviewState;
  const previewImages = node._anPreviewImages || {};
  const stagesPresent = STAGE_ORDER.filter((s) => previewImages[s]);
  const body = el(doc, "div", "wtn-an-body");

  body.appendChild(buildSaveSection(doc, node, ctx, state));

  const compare = state.compare;
  const wantsDual = !!compare.enabled;
  const haveA = stagesPresent.includes(compare.a);
  const haveB = stagesPresent.includes(compare.b);
  // Dual-pane wipe only when BOTH named stages are actually present this
  // run. A selected compare.a/compare.b that isn't present degrades to the
  // SAME single-image branch "compare off" already uses.
  const dualPane = wantsDual && haveA && haveB;
  const wipe = el(doc, "div", `wtn-an-wipe${dualPane ? "" : " wtn-an-single"}`);
  wipe.style.setProperty("--wipe-x", "50%");

  if (!stagesPresent.length) {
    const empty = el(doc, "div", "wtn-an-empty");
    empty.textContent = isInputWired(node, "images") ? "wired — run the graph to preview" : "nothing wired yet";
    wipe.appendChild(empty);
  } else if (dualPane) {
    wipe.appendChild(buildWipeLayer(doc, previewImages, compare.a, "wtn-an-a"));
    wipe.appendChild(buildWipeLayer(doc, previewImages, compare.b, "wtn-an-b"));
    const divider = el(doc, "div", "wtn-an-divider");
    wipe.appendChild(divider);
    const labL = el(doc, "div", "wtn-an-plab wtn-an-l");
    labL.textContent = compare.a;
    const labR = el(doc, "div", "wtn-an-plab wtn-an-r");
    labR.textContent = compare.b;
    wipe.appendChild(labL);
    wipe.appendChild(labR);
  } else {
    const soloStage = haveB ? compare.b : (haveA ? compare.a : stagesPresent[stagesPresent.length - 1]);
    wipe.appendChild(buildWipeLayer(doc, previewImages, soloStage, "wtn-an-a"));
    const labL = el(doc, "div", "wtn-an-plab wtn-an-l");
    labL.textContent = soloStage;
    wipe.appendChild(labL);
  }
  body.appendChild(wipe);

  const pvbar = el(doc, "div", "wtn-an-pvbar");
  const sw = buildSwitch(doc, wantsDual);
  sw.addEventListener("click", () => {
    compare.enabled = !wantsDual;
    persistPreviewState(node);
    repaintPreview(node, ctx);
  });
  const label = el(doc, "span", "wtn-an-pvlab");
  label.textContent = "compare";
  pvbar.appendChild(sw);
  pvbar.appendChild(label);

  if (wantsDual) {
    const segs = el(doc, "div", "wtn-an-segs");
    const segA = el(doc, "div", "wtn-an-seg");
    COMPARE_SLOTS.forEach((slot) => {
      const btn = el(doc, "button");
      btn.type = "button";
      btn.className = compare.a === slot ? "wtn-an-on" : "";
      btn.textContent = slot;
      btn.addEventListener("click", () => {
        compare.a = slot;
        persistPreviewState(node);
        repaintPreview(node, ctx);
      });
      segA.appendChild(btn);
    });
    const vs = el(doc, "span");
    vs.textContent = "vs";
    const segB = el(doc, "div", "wtn-an-seg");
    COMPARE_SLOTS.forEach((slot) => {
      const btn = el(doc, "button");
      btn.type = "button";
      btn.className = compare.b === slot ? "wtn-an-on" : "";
      btn.textContent = slot;
      btn.addEventListener("click", () => {
        compare.b = slot;
        persistPreviewState(node);
        repaintPreview(node, ctx);
      });
      segB.appendChild(btn);
    });
    segs.appendChild(segA);
    segs.appendChild(vs);
    segs.appendChild(segB);
    pvbar.appendChild(segs);
  }
  body.appendChild(pvbar);

  return { body, wipeEl: wipe };
}

/** The Preview's one section -- Save (2026-07-28 inline-sections dispatch).
 * The header's own switch now owns `save.enabled`, so there's no more
 * redundant "enabled" boolfield inside the body (the popover era had one
 * because its outer row carried no switch of its own). The filename-token
 * legend folds into the filename field's own ⓘ instead of a separate
 * sublabel + note block. */
function buildSaveSection(doc, node, ctx, state) {
  const expanded = !!state.ui_expanded.save;
  const save = state.save;
  return buildSection(doc, {
    key: "save", label: "Save", expanded, hasSwitch: true, switchOn: save.enabled,
    infoTooltip: "Saving lives here, not on the Generator -- this node holds the images, so it's the only place base/mid/final can be saved under different names.",
    summary: save.enabled ? `${save.which} · ${save.extension}` : null,
    onToggleExpand: () => { state.ui_expanded.save = !expanded; persistPreviewState(node); repaintPreview(node, ctx); },
    onToggleSwitch: () => { setSwitchAndExpand(state, "save", save); persistPreviewState(node); repaintPreview(node, ctx); },
    buildBody: (body) => {
      body.appendChild(buildStepperField(doc, { label: "which", value: save.which, options: SAVE_WHICH_OPTIONS }, {
        onChange: (v) => { save.which = v; persistPreviewState(node); },
      }).root);
      body.appendChild(buildStepperField(doc, { label: "extension", value: save.extension, options: ["png", "jpg", "webp"] }, {
        onChange: (v) => { save.extension = v; persistPreviewState(node); },
      }).root);
      const pathF = buildTextField(doc, "path", save.path);
      pathF.control.addEventListener("change", () => {
        save.path = pathF.control.value;
        persistPreviewState(node);
      });
      body.appendChild(pathF.root);
      const filenameF = buildTextField(doc, "filename", save.filename);
      filenameF.control.addEventListener("change", () => {
        save.filename = filenameF.control.value;
        persistPreviewState(node);
      });
      body.appendChild(withInfoIcon(doc, filenameF.root, "%stage% (base/mid/final), %seed%, %date:FMT%, %counter:N%, %width%, %height%."));
      const embedField = buildBoolField(doc, "embed workflow", save.embed_workflow);
      embedField.switchEl.addEventListener("click", () => {
        save.embed_workflow = !save.embed_workflow;
        persistPreviewState(node);
        repaintPreview(node, ctx);
      });
      body.appendChild(embedField.root);
    },
  });
}

export function mountPreviewUI(node, ctx) {
  if (node._anRefs) {
    return node._anRefs;
  }
  const doc = ctx.doc;
  injectStyles(doc);
  // `{ preview: true }` -- the ONLY thing that ever passes it -- is what
  // gives this node's panel `wtn-an-panel-pv` (render.mjs's "Preview node:
  // hover wipe" CSS comment for the full reversal it carries: no scrollbar,
  // a taller floor, the wipe flex-filling the body instead of staying
  // square). `mountGeneratorUI` below calls `buildPanelShell(doc)` with no
  // second argument, so its panel is unaffected.
  const { root, panel } = buildPanelShell(doc, { preview: true });
  ensurePreviewState(node);
  const { body, wipeEl } = buildPreviewBody(doc, node, ctx);
  panel.appendChild(body);
  const refs = { doc, root, panel, body, wipeEl };
  node._anRefs = refs;
  wireWipe(node, ctx, refs);
  return refs;
}

export function repaintPreview(node, ctx) {
  const refs = mountPreviewUI(node, ctx);
  // Same orphaned-tooltip guard as `repaintGenerator` above.
  hideActiveInfoTip();
  const { body, wipeEl } = buildPreviewBody(refs.doc, node, ctx);
  if (refs.body && refs.body.parentNode) {
    refs.body.parentNode.removeChild(refs.body);
  }
  refs.panel.appendChild(body);
  refs.body = body;
  refs.wipeEl = wipeEl;
  wireWipe(node, ctx, refs);
  if (node.setDirtyCanvas) {
    node.setDirtyCanvas(true, true);
  }
  return refs;
}

/**
 * `AnimaPreview`'s `onExecuted` handler -- `message.anima_stages` is
 * `nodes/anima/preview.py`'s own `"ui": {"anima_stages": [...]}}` payload:
 * `{filename, subfolder, type, stage}` per entry, ALWAYS one entry per
 * present stage regardless of `save.enabled` (design doc §7/§7a's fix).
 *
 * **The key is `anima_stages`, deliberately NOT `images`.** This node
 * already draws its OWN preview (the DOM wipe); ComfyUI's frontend treats
 * a `"ui": {"images": [...]}}` payload as ITS OWN "draw a native image
 * preview in the node" trigger, so returning under `images` produced two
 * stacked previews (this node's wipe AND ComfyUI's own, caption and all --
 * the actual bug this rename fixes). Renaming the channel is what stops
 * that at the source, on the Python side, rather than trying to suppress
 * ComfyUI's own rendering from here. Accepted cost: a stage's entries no
 * longer show up in ComfyUI's outputs sidebar / queue-history thumbnails
 * (those are keyed off the same native `images` mechanism) -- acceptable
 * because an unsaved stage was only ever a `temp` file anyway, and a SAVED
 * stage still lands on disk under its own `%stage%`-templated filename, so
 * nothing is actually lost, just not double-surfaced in that one UI.
 *
 * This function reads ONLY `anima_stages` -- no fallback to a legacy
 * `message.images`. A stale frontend paired with this new backend (or vice
 * versa) simply shows the placeholder rather than silently reviving the
 * double-preview bug a fallback would keep alive.
 *
 * VERIFY-IN-COMFYUI: that `onExecuted`'s `message` argument really is the
 * node's own `ui` dict verbatim -- no live ComfyUI process in this dev
 * environment to confirm against; matches every other node in this repo's
 * `../ComfyUI-Pixaroma` sibling that reads `message.<key>` straight off
 * `onExecuted`.
 */
export function handleExecuted(node, ctx, message) {
  if (!message || !Array.isArray(message.anima_stages)) {
    return;
  }
  const cacheBust = Date.now();
  const byStage = {};
  for (const entry of message.anima_stages) {
    if (entry && typeof entry.stage === "string" && !(entry.stage in byStage)) {
      byStage[entry.stage] = { ...entry, _cacheBust: cacheBust };
    }
  }
  node._anPreviewImages = byStage;
  repaintPreview(node, ctx);
}

/** The hover wipe -- design doc §7. `pointermove` with NO button gate is
 * what makes it hover rather than drag; `event.stopPropagation()` on both
 * handlers is load-bearing, or litegraph steals the gesture. */
export function wipeXFromEvent(rect, clientX) {
  if (!rect || !Number.isFinite(rect.width) || rect.width <= 0) {
    return 50;
  }
  return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
}

function wireWipe(node, ctx, refs) {
  const wipe = refs.wipeEl;
  if (!wipe || wipe._anWired) {
    return;
  }
  wipe._anWired = true;
  const set = (e) => {
    const rect = typeof wipe.getBoundingClientRect === "function" ? wipe.getBoundingClientRect() : null;
    const pct = wipeXFromEvent(rect, e.clientX);
    wipe.style.setProperty("--wipe-x", `${pct.toFixed(2)}%`);
  };
  wipe.addEventListener("pointermove", (e) => {
    e.stopPropagation();
    set(e);
  });
  wipe.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    set(e);
  });
}

// ---------------------------------------------------------------------------
// Wheel-zoom passthrough + teardown (both node types). Installed on the DOM
// widget's ROOT (which contains the single scrollable `.wtn-an-panel`) --
// `js/shared/canvas_zoom.mjs`'s own tree-walk is what makes the panel
// scroll-vs-zoom decision correct without any bespoke logic here.
// ---------------------------------------------------------------------------

export function installZoomPassthrough(node, ctx) {
  const refs = node._anRefs;
  if (!refs || refs.zoomUninstall) {
    return;
  }
  refs.zoomUninstall = installCanvasZoomPassthrough(refs.root, ctx.getCanvasEl);
}

/** Tears down everything this module mounted on `node` -- the zoom
 * passthrough listener. There is exactly ONE DOM widget per node (this
 * module never mounted more than one), so there are no sibling per-row
 * widgets to remove here; this is still the one place that must run on
 * `onRemoved`, so nothing is ever left mounted after the node itself is
 * gone. **2026-07-28 (inline-sections dispatch)**: there is no more open
 * popover to close here either -- every section lives inside the panel
 * itself, which is torn down along with the node's own DOM by litegraph. */
export function teardownNode(node) {
  const refs = node._anRefs;
  if (refs && refs.zoomUninstall) {
    refs.zoomUninstall();
    refs.zoomUninstall = null;
  }
  // The node's own DOM (icons included) is about to be torn down by
  // litegraph -- close whatever tip might still be showing rather than
  // leaving it orphaned on `doc.body` (js/shared/fields.mjs's
  // `wireInfoTip` doc comment).
  hideActiveInfoTip();
}

// ---------------------------------------------------------------------------
// Resize wrappers (legacy litegraph primary; see render.mjs's "Resize"
// section -- there is no refit/auto-fit left to re-export; the floor
// (`measureMinHeight`) and the fresh-node defaults are all that's left).
// ---------------------------------------------------------------------------

export { measureMinHeight, DEFAULT_H, PREVIEW_DEFAULT_H };
