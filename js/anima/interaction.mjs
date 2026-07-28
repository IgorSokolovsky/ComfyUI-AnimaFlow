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
 *     getKnownLists(): {checkpoints, upscale_models, samplers, schedulers},// installed-file / combo lists, live
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
 * checkpoint picker and the Upscale section's `Model` picker (settings path
 * `upscale.usdu.upscale_model_name` — only the DISPLAY label was renamed, to
 * avoid repeating the section card's own scope, task item 3) (both used to be
 * hardcoded upstream defaults with no frontend control at all — this task's
 * whole point) — see `buildDetailerBody`/`buildUpscaleSection` below. A
 * `null`/empty list degrades HONESTLY: the
 * picker still shows whatever value the settings tree already holds
 * (never silently rewritten), just rendered disabled (`ce0528f`'s lesson:
 * never default to `list[0]` in place of a saved value).
 * `samplers`/`schedulers` (2026-07-28) are the SAME mechanism off
 * `KSampler.sampler_name`/`.scheduler`'s own registered combo spec — see
 * `resolveSamplerOptions` below for how a field built from these degrades to
 * the (six-entry, deliberately last-resort) hardcoded `SAMPLERS`/`SCHEDULERS`
 * arrays when this list is empty/unavailable, rather than ever rewriting an
 * already-saved value that the live list doesn't happen to contain.
 *
 * ## 2026-07-28 reversal (inline-sections dispatch, `docs/generator-
 * design.md` §12) — sections' ESSENTIALS expand IN PLACE
 *
 * See `render.mjs`'s top doc comment for the full history (modal → drawer →
 * row-anchored popover → inline sections → this hybrid). The popover-era
 * rule this file used to carry — "a popover's anchor lives INSIDE the
 * panel, so rebuilding the panel while it's open would detach it; close it
 * first, rebuild after" — was GONE for a while (every section rendering
 * directly inside `.wtn-an-panel`, one full-body repaint the only response
 * to any action) but is now PARTIALLY BACK, in a narrower, deliberate form:
 * a section's inline body (Sampler, Mod Guidance, Highres, Detailer,
 * Upscale, Postprocess) still just expands/collapses in place, no anchor to
 * protect there — but the hybrid essentials/⚙ dispatch reintroduced
 * `js/shared/overlay.mjs` for the LONG TAIL of a section's fields (a ⚙
 * menu) and for a stepper's option list, both genuinely anchored, floating
 * overlays. `openAdvancedMenu`/`openStepperOptionList` (below) are the new
 * shape; the OLD per-section `openXPopover` functions this paragraph used
 * to describe as deleted are STILL deleted (never resurrected under their
 * old names) — `repaintGenerator`/`repaintPreview` now call
 * `closeActiveOverlay()` first, precisely because a full-body repaint DOES
 * once again risk detaching a currently-open overlay's anchor.
 *
 * Expand/collapse state for the Generator's inline sections lives in the
 * settings blob itself, under `ui_expanded` (`state.mjs`'s
 * `normalizeExpandedSections`/`DEFAULT_EXPANDED_GENERATOR_SECTIONS`) — see
 * that module's own top doc comment for why it's safe there (kept OUT of
 * the fixture-tested defaults tree, applied as a second pure step AFTER
 * `normalizeGenerationSettings`, in `ensureGenState` below) rather than
 * `node.properties`. It reaches the same serialized STRING widget every
 * other edit already does (`persistGenState` serializes the WHOLE state
 * object, `ui_expanded` included), so a workflow reopens with the same
 * sections expanded it was saved with — free, with no extra wiring. **The
 * Preview has no `ui_expanded` at all any more** — its one former section
 * (Save) is a menu row, not an accordion (task item 2); see `state.mjs`'s
 * own top doc comment.
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
 *
 * **Subgraph boundaries (design doc §5a-0, later dispatch)**: the walk above
 * used to give up the instant it hit a subgraph instance node standing in
 * for a whole subgraph (`isVirtualNode` + a `subgraph` property, `type` a
 * per-instance UUID rather than a class name), wrongly reporting no bridge
 * upstream even when one was wired inside. `resolveContextProducer` now
 * recognises that shape structurally and reads `supplied` straight off the
 * boundary's own PROMOTED sockets (the same `link != null` check the real
 * Bridge gets), descending into `subgraph.nodes`/`._nodes` only to try to
 * CONFIRM a real Bridge lives inside (`bridgeConfirmed`) so the section's own
 * ⓘ can stay honest about how sure it is — greying out a field never depends
 * on that confirmation, only `supplied` does. The forward mirror
 * (`resolveDownstreamGenerators`) gets the same recognition so a Bridge
 * INSIDE a subgraph can still find Generators outside it. Because a subgraph
 * instance's `type` is a per-instance UUID, `beforeRegisterNodeDef` can never
 * patch its prototype to catch a rewire on its promoted sockets —
 * `ensureBoundaryRepaintHook` installs directly on the instance instead, the
 * first time any walk resolves it.
 */

import { installCanvasZoomPassthrough } from "../shared/canvas_zoom.mjs";
import { buildNumericField, buildStepperField, hideActiveInfoTip } from "../shared/fields.mjs";
// The overlay mechanism -- back in this track for ANCHORED MENUS only (this
// module's top doc comment, "hybrid essentials/⚙ dispatch"). `js/controls/
// interaction.mjs` uses the exact same three imports for its own option
// lists / ⚙ popovers / add-menu -- this is the SAME shared singleton
// bookkeeping (`activeOverlayRef`), not a second instance of it, so only one
// overlay is ever open across the whole page regardless of which track owns
// the click that opened it.
import {
  openOverlayWithZoom, closeActiveOverlay, closeOverlayIfOwnedBy, activeOverlayRef,
} from "../shared/overlay.mjs";
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
  buildGearIcon,
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

/** First mount / brand-new node for the Preview -- no second `ui_expanded`
 * step here (unlike `ensureGenState`): the Preview's one former section
 * (Save) is a menu row now, not an accordion (task item 2 / `state.mjs`'s
 * own top doc comment), so there is nothing left for `ui_expanded` to
 * track on this node at all. */
export function ensurePreviewState(node) {
  const w = getPreviewStateWidget(node);
  const state = normalizePreviewSettings(w ? w.value : "{}");
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
 * Structural (NOT UUID/name-based) recognition of a subgraph BOUNDARY node —
 * the instance litegraph puts in the OUTER graph standing in for a whole
 * subgraph (design doc §5a-0, probed live 2026-07-28): `isVirtualNode ===
 * true`, PLUS a `subgraph` property. Both are required — a Reroute-ish
 * virtual node with no `subgraph` at all is NOT a boundary and must fall
 * through to the ordinary single-input pass-through handling below it, and
 * matching on `type` would be wrong on its face (a subgraph instance's
 * `type` is a per-instance UUID, never a stable class name to compare
 * against). */
function isSubgraphBoundary(node) {
  return !!(node && node.isVirtualNode === true && node.subgraph);
}

/** Descends into a (possibly nested) subgraph looking for a real
 * `AnimaContextBridge` node, so `resolveContextProducer`'s boundary case can
 * report an HONEST `bridgeConfirmed` rather than assuming one just because
 * the boundary's promoted sockets look right (this function is what makes
 * that honesty possible at all — see this module's top doc comment / design
 * doc §5a-0's "confirm a real Bridge lives inside" language).
 *
 * VERIFY-IN-COMFYUI: `subgraph.nodes` is this dev environment's best guess at
 * where a subgraph keeps its own node list (`subgraph._nodes` tried as a
 * fallback) — neither shape was part of the live probe this task shipped
 * with (that probe only covered the BOUNDARY node's own `inputs`). If
 * neither array exists, this returns `false` — "couldn't confirm", not "no
 * bridge" — and the caller (`resolveContextProducer`) treats that exactly
 * like "not confirmed", never like "definitely no bridge".
 *
 * `visited`/depth-capped the same way every other walk in this module is
 * (`MAX_PASSTHROUGH_HOPS`) — a subgraph nested inside itself (directly or
 * through a longer chain) must terminate rather than recurse forever. */
function subgraphContainsBridge(subgraph, visited, depth) {
  if (!subgraph || depth >= MAX_PASSTHROUGH_HOPS) {
    return false;
  }
  const nodes = Array.isArray(subgraph.nodes) ? subgraph.nodes
    : Array.isArray(subgraph._nodes) ? subgraph._nodes
      : null;
  if (!nodes) {
    return false; // can't confirm -- not "no bridge", just "unprobeable here"
  }
  for (const n of nodes) {
    if (!n || visited.has(n)) {
      continue; // already walked (a cyclic subgraph reference) -- skip, don't re-enter
    }
    visited.add(n);
    if (n.type === CONTEXT_BRIDGE_TYPE || n.comfyClass === CONTEXT_BRIDGE_TYPE) {
      return true;
    }
    if (isSubgraphBoundary(n) && subgraphContainsBridge(n.subgraph, visited, depth + 1)) {
      return true;
    }
  }
  return false;
}

const BOUNDARY_HOOK_FLAG = "_anBoundaryHookInstalled";

/**
 * Installs, at most ONCE per boundary-node INSTANCE, an `onConnectionsChange`
 * hook that repaints every `AnimaGenerator` downstream of it — the mirror of
 * `js/anima/index.js`'s own Bridge-side hook, needed here because a subgraph
 * instance's `type` is a per-instance UUID: there is no shared prototype
 * `beforeRegisterNodeDef` could ever patch for it (design doc §5a-0's
 * "the harder half is the repaint TRIGGER" paragraph). Called from
 * `resolveContextProducer` the moment ANY backward walk resolves a boundary
 * node, so the very first repaint that discovers one also arms it for every
 * later external rewire.
 *
 * - Chains whatever `onConnectionsChange` the instance already carries
 *   (never clobbers it) — same shape as every prototype patch in `index.js`.
 * - Gated on `ctx.isSubmitting()` exactly like the real Bridge's own hook,
 *   for the identical reason (`../shared/submit_guard.mjs`'s doc comment):
 *   Use Everywhere materializes and removes real links across every UE-fed
 *   socket at submit time, firing this ~14 times a run for churn that was
 *   never a real rewire. `ctx` is threaded in from whichever call ultimately
 *   resolved the boundary (`computeContextSupplied`/
 *   `computeEffectiveContextSupplied`'s own `ctx` parameter) — if none was
 *   given (a headless call with no ctx, or a test that doesn't care), this
 *   degrades to "never submitting", which fails OPEN (extra repaints, never
 *   a missed one) rather than silently skipping the guard's whole purpose.
 * - Marked on the instance (`BOUNDARY_HOOK_FLAG`) so a second resolution
 *   (every repaint re-resolves the producer) can't stack a second handler.
 * - Never throws: a generator with no `_anMods`/`_anRefs` yet is simply
 *   skipped, mirroring `index.js`'s own tolerance for "not mounted yet".
 */
export function ensureBoundaryRepaintHook(boundaryNode, ctx) {
  if (!boundaryNode || boundaryNode[BOUNDARY_HOOK_FLAG]) {
    return;
  }
  boundaryNode[BOUNDARY_HOOK_FLAG] = true;
  const isSubmittingFn = ctx && typeof ctx.isSubmitting === "function" ? ctx.isSubmitting : () => false;
  const previous = boundaryNode.onConnectionsChange;
  boundaryNode.onConnectionsChange = function (...args) {
    const result = previous ? previous.apply(this, args) : undefined;
    if (isSubmittingFn()) {
      return result;
    }
    const generators = resolveDownstreamGenerators(this);
    generators.forEach((gen) => {
      if (gen._anMods) {
        gen._anMods.interaction.clearContextRun(gen);
      }
      if (gen._anMods && gen._anRefs) {
        gen._anMods.interaction.repaintGenerator(gen, gen._anCtx);
      }
    });
    return result;
  };
}

/**
 * Walk backward from `node`'s "context" input to whatever's actually
 * SUPPLYING it, tolerating any number of single-input/single-output
 * pass-through nodes in between (Reroute and similar, matched GENERICALLY by
 * "exactly one input", not by class name — mirrors the Control Panel's own
 * tolerance of arbitrary "*" pass-through targets) — returning a
 * discriminated result rather than a bare node, because a subgraph BOUNDARY
 * (design doc §5a-0) is a producer worth reporting even though it isn't
 * literally the Bridge:
 *
 *   { kind: "bridge", node }                          -- the real AnimaContextBridge
 *   { kind: "boundary", node, bridgeConfirmed }        -- a subgraph instance
 *                                                         standing in for one
 *   null                                               -- unwired / dangling / a cycle / neither
 *
 * `ctx` (optional) is threaded straight through to `ensureBoundaryRepaintHook`
 * when a boundary resolves — see that function's own doc comment.
 *
 * VERIFY-IN-COMFYUI: this walk (and the `getInputLink`/`graph.links`
 * fallback chain in `resolveLinkOrigin`) is read from litegraph's documented
 * API surface, not exercised against a live process (none installed in this
 * dev environment).
 */
export function resolveContextProducer(node, ctx) {
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
      return { kind: "bridge", node: producer };
    }
    if (isSubgraphBoundary(producer)) {
      const bridgeConfirmed = subgraphContainsBridge(producer.subgraph, new Set(), 0);
      ensureBoundaryRepaintHook(producer, ctx);
      return { kind: "boundary", node: producer, bridgeConfirmed };
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

/** Backward-compatible narrow view of `resolveContextProducer` — the real
 * `AnimaContextBridge` node only, or `null` for every other case INCLUDING a
 * subgraph boundary (a boundary is a producer worth reporting through
 * `computeContextSupplied`, but it genuinely isn't "the bridge" itself, so
 * this stays `null` for it rather than silently returning something whose
 * own `.inputs` don't mean what a caller of THIS function would expect). */
export function resolveContextBridge(node) {
  const producer = resolveContextProducer(node);
  return producer && producer.kind === "bridge" ? producer.node : null;
}

/** `{bridgeFound, bridge, supplied: {field: bool}, viaBoundary, bridgeConfirmed}`
 * for every one of `CONTEXT_FIELDS` — see this module's top doc comment for
 * the fail-closed contract when nothing resolves.
 *
 * `supplied` is populated identically whether the producer is a real Bridge
 * or a subgraph boundary standing in for one — design doc §5a-0's whole
 * point is that a boundary's own promoted `inputs` carry the SAME
 * `link != null` truth the Bridge's own sockets do, so `findInput` is reused
 * verbatim against whichever node resolved. That is what actually fixes the
 * reported bug: greying out a sampler field only ever reads `supplied`, not
 * `bridgeFound` (see `buildSamplerField` below) — `bridgeFound`/
 * `viaBoundary`/`bridgeConfirmed` exist ONLY to keep the section's own ⓘ
 * honest about how sure this is, never to gate the disabling itself.
 *
 * - Real Bridge: `bridgeFound: true`, `viaBoundary: false`,
 *   `bridgeConfirmed: null` (not applicable -- there was no boundary to
 *   confirm anything about).
 * - Boundary with a confirmed Bridge inside: `bridgeFound: true`,
 *   `viaBoundary: true`, `bridgeConfirmed: true`.
 * - Boundary where a Bridge could NOT be confirmed inside (unprobeable
 *   subgraph shape, or genuinely none found): `bridgeFound: false`,
 *   `viaBoundary: true`, `bridgeConfirmed: false` — deliberately NOT the same
 *   as "no bridge resolved at all" (`viaBoundary: false`), so a caller can
 *   render an honest THIRD message instead of flatly asserting "No Anima
 *   Context Bridge resolved" while `supplied` may still show real fields
 *   disabled underneath it.
 * - Nothing resolves: `bridgeFound: false`, `bridge: null`, `supplied: {}`,
 *   `viaBoundary: false`, `bridgeConfirmed: null`.
 */
export function computeContextSupplied(node, ctx) {
  const producer = resolveContextProducer(node, ctx);
  if (!producer) {
    return { bridgeFound: false, bridge: null, supplied: {}, viaBoundary: false, bridgeConfirmed: null };
  }
  const supplied = {};
  for (const field of CONTEXT_FIELDS) {
    const input = findInput(producer.node, field);
    supplied[field] = !!(input && input.link != null);
  }
  if (producer.kind === "bridge") {
    return { bridgeFound: true, bridge: producer.node, supplied, viaBoundary: false, bridgeConfirmed: null };
  }
  return {
    bridgeFound: !!producer.bridgeConfirmed,
    bridge: producer.bridgeConfirmed ? producer.node : null,
    supplied,
    viaBoundary: true,
    bridgeConfirmed: !!producer.bridgeConfirmed,
  };
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
 * **Subgraph boundaries (design doc §5a-0, task item 2)**: a target that is
 * structurally a subgraph boundary (`isSubgraphBoundary` — same predicate
 * `resolveContextProducer` uses backward, never a UUID/name match) is
 * tunnelled through exactly like a plain pass-through, EXCEPT the outbound
 * socket name is resolved by NAME first (the boundary's own output matching
 * the name just walked, e.g. "context" promoted straight through), falling
 * back to "exactly one output" only when no same-named one exists — a
 * boundary node can expose several promoted sockets at once, so the plain
 * pass-through's "exactly one output" rule would wrongly dead-end on it even
 * when the relevant one is right there under the same name. This is what
 * lets a Bridge INSIDE a subgraph still reach a Generator outside it (or
 * vice versa) when the forward walk crosses that boundary mid-tunnel.
 *
 * VERIFY-IN-COMFYUI: same caveat as `resolveContextBridge` — read from
 * litegraph's documented link-table shape (`output.links`/`graph.links[id]`/
 * `target_id`), not exercised against a live process (none installed in
 * this dev environment). The boundary-crossing half above is EVEN LESS
 * verified than the rest of this walk: the live probe this task shipped
 * with only covered the BACKWARD (input-promotion) case, so this forward
 * side is inferred by symmetry, not observed.
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
      if (isSubgraphBoundary(target)) {
        visited.add(target);
        const targetOutputs = target.outputs || [];
        const namedOutput = targetOutputs.find((o) => o && o.name === outputName);
        const nextOutputName = namedOutput ? namedOutput.name
          : (targetOutputs.length === 1 ? targetOutputs[0].name : null);
        if (nextOutputName) {
          walk(target, nextOutputName, hop + 1);
        }
        // No resolvable outbound socket on the boundary -- dead-ends here,
        // same as any other unfollowable branch (never throws).
        continue;
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
 * "live"|"run"|null}, runSupplied: {field: bool}, values: {field: value},
 * viaBoundary, bridgeConfirmed }`. `source` is which signal EXPLAINS the
 * "supplied" state (live wins when both are true, since it's the more
 * concrete of the two to name in a tooltip); `runSupplied` is the run's OWN
 * flag independently of `source` (a caller needs this to tell "the run said
 * supplied but carried no value" apart from "never run at all"); `values`
 * carries the run's own sampler scalar for a field the run reported supplied
 * for AND actually had a value for — never invented, never present for a
 * field the run didn't report a real value for (`build_context_ui_payload`'s
 * own "supplied but None" case included). `viaBoundary`/`bridgeConfirmed`
 * pass `computeContextSupplied`'s own subgraph-boundary honesty straight
 * through unchanged — see that function's doc comment.
 *
 * `ctx` (optional) reaches `computeContextSupplied`/`resolveContextProducer`
 * unchanged — it's what lets a resolved subgraph boundary find
 * `ctx.isSubmitting` for its own repaint-hook install
 * (`ensureBoundaryRepaintHook`'s doc comment).
 */
export function computeEffectiveContextSupplied(node, ctx) {
  const live = computeContextSupplied(node, ctx);
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
  return {
    bridgeFound: live.bridgeFound,
    bridge: live.bridge,
    supplied,
    source,
    runSupplied,
    values,
    viaBoundary: live.viaBoundary,
    bridgeConfirmed: live.bridgeConfirmed,
  };
}

// LAST-RESORT fallback ONLY -- see `resolveSamplerOptions` below. The real
// source of truth is `ctx.getKnownLists().samplers`/`.schedulers`
// (`index.js`'s `MODEL_LIST_SOURCES`, off `KSampler`'s own registered combo
// spec); these two arrays are what a caller falls back to when that registry
// lookup comes back empty (a headless test with no stub, or a `KSampler` def
// that didn't register) -- six entries each, versus ComfyUI's real ~30
// samplers / ~10 schedulers, so NEVER treat these as the primary list.
const SAMPLERS = ["euler", "euler_ancestral", "er_sde", "dpmpp_2m", "heun", "ddim"];
const SCHEDULERS = ["simple", "sgm_uniform", "karras", "normal", "beta", "exponential"];

/**
 * The live `sampler_name`/`scheduler` option list for `listKey`
 * (`"samplers"`/`"schedulers"`) through `ctx.getKnownLists()`, falling back
 * to `fallback` (one of the two hardcoded arrays above) ONLY when the
 * registry lookup is unavailable or empty -- never silently prefers the
 * fallback when a real (even single-entry) list exists. Mirrors
 * `buildModelFilePicker`'s own "read through `ctx.getKnownLists()`" shape,
 * generalized past the two model-file pickers to cover these two as well.
 */
function resolveSamplerOptions(ctx, listKey, fallback) {
  const lists = ctx && typeof ctx.getKnownLists === "function" ? ctx.getKnownLists() : null;
  const list = lists && Array.isArray(lists[listKey]) ? lists[listKey] : null;
  return list && list.length ? list : fallback;
}

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
 * infoWarn, summary, dep, onToggleExpand, onToggleSwitch, buildBody(body),
 * hasGear, gearTooltip, gearActive, onGearClick(headerRefs) }`. `buildBody`
 * is only called (and its result only appended) while `expanded` is true.
 *
 * **⚙ (hybrid essentials/⚙ dispatch, task item 3)**: `onGearClick`, if
 * given, is wired as the gear's own click handler (already `stopPropagation`'d
 * by `buildGearIcon`/`render.mjs`'s `buildSectionHeader` -- clicking it can
 * never ALSO toggle this section's own expand/collapse or switch). It's
 * called with the FULL header refs object (`{root, sumEl, gearEl, ...}`,
 * `buildSectionHeader`'s own return shape) so the caller can anchor an
 * overlay to `root` and later update `sumEl.textContent` in place without
 * re-querying the DOM.
 */
function buildSection(doc, spec) {
  const {
    label, expanded, hasSwitch, switchOn, infoTooltip, infoWarn, summary, dep,
    onToggleExpand, onToggleSwitch, buildBody, hasGear, gearTooltip, gearActive, onGearClick,
  } = spec;
  const frag = el(doc, "div", "wtn-an-section");
  const head = buildSectionHeader(doc, {
    label, expanded, hasSwitch, switchOn, infoTooltip, infoWarn, summary, dep,
    hasGear, gearTooltip, gearActive,
    onGearClick: onGearClick ? () => onGearClick(head) : undefined,
  });
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
    // Card-attachment (task item 1): the body continues the SAME warn
    // tint as a `dep` header (both classes' own CSS rules are in
    // render.mjs's ".wtn-an-sbody" comment) so a missing-dependency
    // section reads coherently whether the header or the body itself
    // catches your eye.
    const body = el(doc, "div", `wtn-an-sbody${dep ? " wtn-an-dep" : ""}`);
    buildBody(body);
    frag.appendChild(body);
  }
  return frag;
}

// ---------------------------------------------------------------------------
// ⚙ advanced-fields menu + stepper option-list menu -- the two anchored
// overlays `js/shared/overlay.mjs` is back in this track FOR (this module's
// top doc comment). Both share the SAME singleton bookkeeping every other
// overlay in this pack uses (`activeOverlayRef`/`closeActiveOverlay`/
// `closeOverlayIfOwnedBy`) so a second click on the SAME opener toggles it
// closed instead of closing-then-reopening (`js/shared/overlay.mjs`'s own
// top doc comment covers the trap this guards against).
// ---------------------------------------------------------------------------

function openOverlayForCtx(ctx, doc, anchorEl, contentEl, placement, onClose) {
  return openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, contentEl, placement, onClose, "wtn-an-overlay wtn");
}

/**
 * The ⚙'s own menu (task item 3 / the Preview's Save row, task item 2) --
 * anchored `placement: "right"` to `anchorEl` (the section's own header
 * row, so it opens beside the section rather than the panel's narrow
 * width). `buildBody(box, helpers)` builds the menu's field content;
 * `helpers.rebuildMenu()` clears `box` and calls `buildBody` again IN
 * PLACE (for an edit that changes what the menu itself should show, e.g.
 * flipping `inherit_sampler_settings` reveals/hides cfg/sampler/scheduler)
 * WITHOUT closing the overlay or touching the main panel body at all --
 * this is the deliberate alternative to a full `repaintGenerator`/
 * `repaintPreview` call from inside an open menu, which would tear down
 * the very header this menu is anchored to (`this module's top doc
 * comment`'s whole point in bringing the overlay back). `helpers.
 * refreshSummary(text)` updates the section header's own `sumEl` text IN
 * PLACE (a plain DOM mutation, not a repaint) for an edit that changes only
 * a VALUE, not the menu's own shape -- the "persists and repaints the node
 * body... WITHOUT rebuilding the open menu" contract the task describes,
 * concretely: "repaints the node body" here means "updates the ONE piece
 * of the body that could visibly be stale (the summary)," not a full
 * teardown-and-rebuild.
 */
function openAdvancedMenu(doc, ctx, key, anchorEl, sumEl, buildBody) {
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this section's own menu was already open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT section/field's overlay was open -- switch to this one
  const box = el(doc, "div", "wtn-an-menu wtn-an-advmenu wtn");
  let handle;
  const helpers = {
    rebuildMenu: () => {
      while (box.firstChild) {
        box.removeChild(box.firstChild);
      }
      buildBody(box, helpers);
      if (handle && typeof handle.reposition === "function") {
        handle.reposition();
      }
    },
    refreshSummary: (text) => {
      if (sumEl) {
        sumEl.textContent = text == null ? "" : text;
      }
    },
  };
  buildBody(box, helpers);
  handle = openOverlayForCtx(ctx, doc, anchorEl, box, "right", () => {
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  });
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
}

/**
 * Wires a `buildStepperField`'s `onOpenList` -- opens (or, on a second
 * click of the SAME field, closes) a themed, scrollable option-list overlay
 * anchored `placement: "below"` the field's own combo element, marking the
 * CURRENT value selected (`.wtn-an-opt-sel`). Clicking an option commits it
 * -- `stepperRef.repaint(opt)` for immediate visual feedback (the field may
 * live inside an already-open ⚙ menu that this selection must NOT force a
 * `rebuildMenu()` of), THEN the caller's own `onSelect(opt)`, which owns
 * persistence (and, for an inline field, whatever repaint it already did
 * before this dispatch). Mirrors `js/controls/interaction.mjs`'s
 * `openListMenuFor` -- same toggle/singleton bookkeeping, generalized to a
 * plain `options` array instead of `ctx.getKnownLists()`.
 *
 * **Nesting note**: opening this from a stepper that lives INSIDE an
 * already-open ⚙ menu closes that menu first (only one overlay is ever
 * open pack-wide, `activeOverlayRef`'s own contract) -- accepted, not
 * fixed here; the option list still opens and commits correctly, the ⚙
 * menu just needs a second click to reopen afterward.
 */
function openStepperOptionList(doc, ctx, key, comboEl, options, currentValue, stepperRef, onSelect) {
  if (closeOverlayIfOwnedBy(key)) {
    return;
  }
  closeActiveOverlay();
  const menu = el(doc, "div", "wtn-an-menu wtn-an-optlist wtn");
  const list = Array.isArray(options) ? options : [];
  list.forEach((opt) => {
    const optEl = el(doc, "div", `wtn-an-opt${opt === currentValue ? " wtn-an-opt-sel" : ""}`);
    optEl.textContent = opt;
    optEl.addEventListener("click", (e) => {
      e.stopPropagation();
      closeActiveOverlay();
      stepperRef.repaint(opt);
      onSelect(opt);
    });
    menu.appendChild(optEl);
  });
  const handle = openOverlayForCtx(ctx, doc, comboEl, menu, "below", () => {
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  });
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
}

// A per-module, ever-increasing counter -- every `buildAnStepper` call gets
// its own key, unique for the lifetime of the CURRENTLY built DOM tree (a
// full repaint discards every old key along with the DOM it belonged to;
// see `repaintGenerator`/`repaintPreview`'s own `closeActiveOverlay()` call
// for why a stale key surviving past a repaint is harmless either way).
let _stepperKeySeq = 0;

/**
 * `buildStepperField` (`js/shared/fields.mjs`), with `onOpenList` ALREADY
 * wired to `openStepperOptionList` above -- the fix for task item 2's dead
 * dropdown (`buildStepperField` accepted `onOpenList` since this track's
 * very first dispatch; nothing ever passed it). Every stepper in
 * `js/anima/` should be built through this wrapper, not the bare
 * `buildStepperField`, so the option list is wired uniformly rather than
 * per call site. `spec`/`handlers` are `buildStepperField`'s own shapes
 * verbatim (this only adds `onOpenList`, and only when the field isn't
 * `disabledReason`'d -- a disabled stepper never wires ANY interaction,
 * `buildStepperField`'s own contract).
 */
function buildAnStepper(doc, ctx, spec, handlers) {
  const key = `an-stepper:${_stepperKeySeq++}`;
  const onChange = handlers && handlers.onChange;
  let ref;
  ref = buildStepperField(doc, spec, {
    onChange,
    // `currentValue` -- `buildStepperField`'s own live-tracked value, handed
    // to this callback by the field itself (fields.mjs's own top doc comment
    // on this fix). NOT `spec.value`: that's a build-time snapshot, and an
    // arrow click updates the field's displayed value via `repaint()`
    // in-place, without ever rebuilding this closure -- reading `spec.value`
    // here highlighted the WRONG (pre-arrow-click) entry the instant the list
    // was opened after cycling with an arrow first.
    onOpenList: (comboEl, currentValue) => {
      openStepperOptionList(doc, ctx, key, comboEl, spec.options, currentValue, ref, (v) => {
        if (typeof onChange === "function") {
          onChange(v);
        }
      });
    },
  });
  return ref;
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
function buildSamplerField(doc, node, ctx, field, sampler, eff) {
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
    const listKey = field === "sampler_name" ? "samplers" : "schedulers";
    const fallback = field === "sampler_name" ? SAMPLERS : SCHEDULERS;
    const options = resolveSamplerOptions(ctx, listKey, fallback);
    fieldRoot = buildAnStepper(doc, ctx, { label: field, value: displayValue, options, disabledReason }, {
      onChange: (v) => { sampler[field] = v; persistGenState(node); },
    }).root;
  } else {
    const opts = field === "cfg" ? { min: 0, max: 30, step: 0.1 }
      : field === "steps" ? { min: 1, max: 150, step: 1 }
        : { min: -1, max: 2147483647, step: 1 }; // seed
    const kind = field === "cfg" ? "float" : "int";
    fieldRoot = buildNumericField(doc, {
      label: field, kind, opts, disabledReason,
      // `getValue` MUST be a live read, not the `displayValue` CONSTANT
      // captured above -- `buildNumericField`'s own `repaint()` calls
      // `getValue()` on every `pointermove`, so a frozen primitive here
      // means the fill/label never move during a drag even though
      // `setValue` correctly writes `sampler[field]` underneath it (a
      // regression this dispatch's own live-use report caught: "only
      // updates when I connect something to the node," i.e. only on a full
      // rebuild, which is the only thing that ever recomputed
      // `displayValue`). A run-supplied field is disabled anyway (no drag
      // possible), so re-deriving the same run-vs-settings precedence here
      // on every read stays correct for that case too.
      getValue: () => (hasRunValue ? eff.values[field] : sampler[field]),
      setValue: (v) => { sampler[field] = v; },
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
  const eff = computeEffectiveContextSupplied(node, ctx);
  const { bridgeFound, viaBoundary } = eff;
  const summary = `${summaryFieldText("sampler_name", eff, sampler)} / ${summaryFieldText("scheduler", eff, sampler)} · `
    + `${summaryFieldText("steps", eff, sampler)} steps · cfg ${summaryFieldText("cfg", eff, sampler, (v) => Number(v).toFixed(1))}`;
  // Three honest wordings (design doc §5a-0's subgraph-boundary case, task
  // item 1) -- NEVER "no bridge resolved" when a boundary actually supplied
  // some of the fields disabled below, and never "confirmed" when it wasn't:
  //   1. a real Bridge resolved directly (or confirmed inside a subgraph).
  //   2. a subgraph boundary resolved, but a Bridge inside it could not be
  //      confirmed -- fields below may still show disabled (`supplied` reads
  //      straight off the boundary's own promoted sockets, independent of
  //      this wording), this text just can't vouch for WHY.
  //   3. nothing resolved at all.
  const infoTooltip = bridgeFound
    ? "Fields the Anima Context Bridge has wired drive this run; everything else comes from here."
    : viaBoundary
      ? "‘context’ is wired through a subgraph boundary; a Context Bridge inside it could not be confirmed from here, but any field shown disabled below is still read off that boundary's own wiring."
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
        body.appendChild(buildSamplerField(doc, node, ctx, field, sampler, eff));
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
      body.appendChild(buildAnStepper(doc, ctx, { label: "profile", value: mg.profile, options: ["step_i8_skip27", "step_i14", "uniform_w3"] }, {
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
// stage's own.
//
// **2026-07-28 (hybrid essentials/⚙ dispatch): this is now ADVANCED-MENU-ONLY
// content, never inline.** Per the task's own per-section table, `steps`/
// `denoise` are INLINE for every stage that has them (rendered directly by
// that section's own `buildBody`, not through this function any more);
// `inherit_sampler_settings` + the conditionally-shown `cfg`/`sampler_name`/
// `scheduler` are the part that moves behind a ⚙. `refresh` is no longer the
// enclosing section's `repaintGenerator` -- it's the ⚙ menu's OWN
// `rebuildMenu` (from `openAdvancedMenu`'s `helpers`), since flipping
// `inherit` changes what THIS MENU shows, not the main panel body; the menu
// stays open and rebuilds in place instead of a full-panel repaint tearing
// down the very anchor it's attached to.
// ---------------------------------------------------------------------------

function appendStageSamplerAdvancedFields(doc, ctx, container, stageSettings, firstPassSampler, onCommit, rebuildMenu) {
  const inherit = stageSettings.inherit_sampler_settings !== false;
  container.appendChild(buildSublabel(doc, "sampler · this stage"));

  const inheritField = buildBoolField(doc, "inherit", inherit);
  inheritField.word.textContent = inherit ? "on · cfg/sampler/scheduler from the first pass" : "off · this stage picks its own";
  inheritField.switchEl.addEventListener("click", () => {
    stageSettings.inherit_sampler_settings = !inherit;
    onCommit();
    rebuildMenu();
  });
  if (inherit) {
    const resolved = resolveStageSampler(stageSettings, firstPassSampler);
    container.appendChild(withInfoIcon(doc, inheritField.root,
      `Using cfg ${Number(resolved.cfg).toFixed(1)}, ${resolved.sampler_name} / ${resolved.scheduler} from the first pass. Steps and denoise are this stage's own, set inline.`));
  } else {
    container.appendChild(inheritField.root);
  }

  if (!inherit) {
    container.appendChild(buildNumericField(doc, {
      label: "cfg", kind: "float", opts: { min: 0, max: 30, step: 0.1 },
      getValue: () => stageSettings.cfg, setValue: (v) => { stageSettings.cfg = v; },
    }, onCommit).root);
    container.appendChild(buildAnStepper(doc, ctx, { label: "sampler_name", value: stageSettings.sampler_name, options: resolveSamplerOptions(ctx, "samplers", SAMPLERS) }, {
      onChange: (v) => { stageSettings.sampler_name = v; onCommit(); },
    }).root);
    container.appendChild(buildAnStepper(doc, ctx, { label: "scheduler", value: stageSettings.scheduler, options: resolveSamplerOptions(ctx, "schedulers", SCHEDULERS) }, {
      onChange: (v) => { stageSettings.scheduler = v; onCommit(); },
    }).root);
  }
}

// The real ComfyUI folder each `listKey` reads from -- named in the
// empty-list note/tooltip below (task item 3's "the REASON must be visible
// in the row, not just a disabled-looking picker" fix) so a user with
// nothing installed sees exactly where to drop a file, rather than a picker
// that just LOOKS broken. Keyed identically to `MODEL_LIST_SOURCES`
// (`index.js`) / `ctx.getKnownLists()`'s own return shape.
const MODEL_FOLDER_HINTS = {
  checkpoints: "models/checkpoints",
  upscale_models: "models/upscale_models",
};

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
 *
 * **2026-07-28 (empty-list presentation fix)**: a disabled stepper used to
 * read as broken rather than "working as designed, nothing to pick from."
 * The REASON is now visible in the row itself: the displayed value gets a
 * `" (no options available)"` suffix (the SAVED value, untouched underneath —
 * only the DISPLAY string changes, `getValue()`/`setValue` never see the
 * suffixed text). Deliberately NOT "no models found in `<folder>`" in the
 * row text — an empty `list` here does not always mean the folder is empty:
 * `getComboOptions` (`js/controls/rows.mjs`) can ALSO come back empty for a
 * node whose combo spec this frontend simply couldn't parse (the V3
 * node-def schema fix, same dispatch, is exactly a case that used to look
 * "empty" for a user who had files installed all along) — asserting the
 * folder is empty in the row itself would have been actively WRONG for that
 * user. The folder name still appears, but ONLY in `disabledReason`
 * (`buildStepperField`'s own tooltip, via `root.title`) as a hint of where to
 * look, phrased as a suggestion rather than a claim about what's there. A
 * `listKey` with no folder hint (shouldn't occur; every current caller has
 * one) falls back to `missingText` alone.
 */
function buildModelFilePicker(doc, ctx, listKey, label, missingText, getValue, setValue, onCommit) {
  const lists = ctx.getKnownLists ? ctx.getKnownLists() : {};
  const list = Array.isArray(lists && lists[listKey]) ? lists[listKey] : [];
  const savedValue = getValue();
  let displayValue = savedValue;
  let disabledReason;
  if (!list.length) {
    const folder = MODEL_FOLDER_HINTS[listKey];
    displayValue = savedValue ? `${savedValue} (no options available)` : "(no options available)";
    disabledReason = folder
      ? `${missingText} If this looks wrong, check ${folder} for a model file.`
      : missingText;
  }
  return buildAnStepper(doc, ctx, {
    label, value: displayValue, options: list, disabledReason,
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

/** Highres -- INLINE: `scale_by`, `steps`, `denoise`. ADVANCED (⚙):
 * `inherit_sampler_settings` + `cfg`/`sampler_name`/`scheduler`,
 * `max_long_edge`, `multiple`, `upscale_method` (task item 3's own table). */
function buildHighresSection(doc, node, ctx, state, have) {
  const expanded = !!state.ui_expanded.highres;
  const h = state.highres;
  const summaryText = () => stageSummary("highres", state, have);

  return buildSection(doc, {
    key: "highres", label: "Highres", expanded, hasSwitch: true, switchOn: h.enabled,
    infoTooltip: "Latent upscale, resample at low denoise. Runs before the detailer, so faces get fixed at generation resolution rather than after an upscale.",
    summary: h.enabled ? summaryText() : null,
    // No `dep` here -- `stageBlocked` has no real logic for "highres" (it
    // only gates on a soft-import for detailer/upscale); passing it through
    // anyway would always be `false` and reads as a meaningless dead check.
    hasGear: true,
    gearTooltip: "Advanced: sampler inherit/cfg/sampler/scheduler, max_long_edge, multiple, upscale_method.",
    onGearClick: (headerRefs) => {
      openAdvancedMenu(doc, ctx, "gen:highres:adv", headerRefs.root, headerRefs.sumEl, (box, helpers) => {
        box.appendChild(buildSublabel(doc, "highres · advanced"));
        box.appendChild(buildAnStepper(doc, ctx, { label: "upscale_method", value: h.upscale_method, options: ["bicubic", "bilinear", "nearest-exact", "area"] }, {
          onChange: (v) => { h.upscale_method = v; persistGenState(node); },
        }).root);
        const multipleF = buildTextField(doc, "multiple", h.multiple);
        multipleF.control.addEventListener("change", () => {
          h.multiple = multipleF.control.value;
          persistGenState(node);
        });
        box.appendChild(multipleF.root);
        box.appendChild(buildNumericField(doc, {
          label: "max_long_edge", kind: "int", opts: { min: 512, max: 8192, step: 32 },
          getValue: () => h.max_long_edge, setValue: (v) => { h.max_long_edge = v; },
        }, () => persistGenState(node)).root);
        appendStageSamplerAdvancedFields(doc, ctx, box, h, state.sampler, () => {
          persistGenState(node);
          helpers.refreshSummary(h.enabled ? summaryText() : null);
        }, helpers.rebuildMenu);
      });
    },
    onToggleExpand: () => { state.ui_expanded.highres = !expanded; persistGenState(node); repaintGenerator(node, ctx); },
    onToggleSwitch: () => { setSwitchAndExpand(state, "highres", h); persistGenState(node); repaintGenerator(node, ctx); },
    buildBody: (body) => {
      body.appendChild(buildNumericField(doc, {
        label: "scale_by", kind: "float", opts: { min: 1, max: 4, step: 0.05 },
        getValue: () => h.scale_by, setValue: (v) => { h.scale_by = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildNumericField(doc, {
        label: "steps", kind: "int", opts: { min: 1, max: 150, step: 1 },
        getValue: () => h.steps, setValue: (v) => { h.steps = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildNumericField(doc, {
        label: "denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
        getValue: () => h.denoise, setValue: (v) => { h.denoise = v; },
      }, () => persistGenState(node)).root);
    },
  });
}

/** Upscale -- INLINE: `usdu.upscale_model_name` (picker), `scale_by`,
 * `steps`, `denoise`. ADVANCED (⚙): `inherit_sampler_settings` +
 * `cfg`/`sampler_name`/`scheduler`, and every other `usdu.*` tile/seam
 * field (task item 3's own table). */
function buildUpscaleSection(doc, node, ctx, state, have) {
  const expanded = !!state.ui_expanded.upscale;
  const u = state.upscale;
  const missing = !have.usdu;
  const missingText = "ComfyUI_UltimateSDUpscale not installed -- the upscale stage is disabled.";
  const infoTooltip = "mode_type is tile ORDER (Linear/Chess/None). tiled_decode is an unrelated VAE flag -- don't conflate them."
    + (missing ? ` ${missingText}` : "");
  const summaryText = () => stageSummary("upscale", state, have);

  return buildSection(doc, {
    key: "upscale", label: "Upscale", expanded, hasSwitch: true, switchOn: u.enabled,
    infoTooltip, infoWarn: missing, dep: u.enabled && missing,
    summary: u.enabled ? summaryText() : null,
    hasGear: true,
    gearTooltip: "Advanced: sampler inherit/cfg/sampler/scheduler, and every USDU tile/seam field.",
    onGearClick: (headerRefs) => {
      openAdvancedMenu(doc, ctx, "gen:upscale:adv", headerRefs.root, headerRefs.sumEl, (box, helpers) => {
        const usdu = u.usdu;
        const commit = () => persistGenState(node);
        box.appendChild(buildSublabel(doc, "usdu · tiling"));
        box.appendChild(buildBoolFieldInto(doc, "auto_tile_size", usdu, "auto_tile_size", commit));
        box.appendChild(buildAnStepper(doc, ctx, { label: "mode_type", value: usdu.mode_type, options: ["Linear", "Chess", "None"] }, {
          onChange: (v) => { usdu.mode_type = v; commit(); },
        }).root);
        box.appendChild(buildNumericField(doc, {
          label: "auto_tile_target", kind: "int", opts: { min: 64, max: 4096, step: 32 },
          getValue: () => usdu.auto_tile_target, setValue: (v) => { usdu.auto_tile_target = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "auto_tile_min", kind: "int", opts: { min: 64, max: 4096, step: 32 },
          getValue: () => usdu.auto_tile_min, setValue: (v) => { usdu.auto_tile_min = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "auto_tile_max", kind: "int", opts: { min: 64, max: 8192, step: 32 },
          getValue: () => usdu.auto_tile_max, setValue: (v) => { usdu.auto_tile_max = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "tile_width", kind: "int", opts: { min: 64, max: 4096, step: 32 },
          getValue: () => usdu.tile_width, setValue: (v) => { usdu.tile_width = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "tile_height", kind: "int", opts: { min: 64, max: 4096, step: 32 },
          getValue: () => usdu.tile_height, setValue: (v) => { usdu.tile_height = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "mask_blur", kind: "int", opts: { min: 0, max: 64, step: 1 },
          getValue: () => usdu.mask_blur, setValue: (v) => { usdu.mask_blur = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "tile_padding", kind: "int", opts: { min: 0, max: 256, step: 8 },
          getValue: () => usdu.tile_padding, setValue: (v) => { usdu.tile_padding = v; },
        }, commit).root);
        box.appendChild(buildBoolFieldInto(doc, "force_uniform_tiles", usdu, "force_uniform_tiles", commit));
        box.appendChild(buildNumericField(doc, {
          label: "batch_size", kind: "int", opts: { min: 1, max: 16, step: 1 },
          getValue: () => usdu.batch_size, setValue: (v) => { usdu.batch_size = v; },
        }, commit).root);
        box.appendChild(buildBoolFieldInto(doc, "tiled_decode", usdu, "tiled_decode", commit));

        box.appendChild(buildSublabel(doc, "usdu · seam fix"));
        box.appendChild(buildAnStepper(doc, ctx, { label: "seam_fix_mode", value: usdu.seam_fix_mode, options: ["None", "Band Pass", "Half Tile", "Half Tile + Intersections"] }, {
          onChange: (v) => { usdu.seam_fix_mode = v; commit(); },
        }).root);
        box.appendChild(buildNumericField(doc, {
          label: "seam_fix_denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
          getValue: () => usdu.seam_fix_denoise, setValue: (v) => { usdu.seam_fix_denoise = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "seam_fix_width", kind: "int", opts: { min: 0, max: 512, step: 8 },
          getValue: () => usdu.seam_fix_width, setValue: (v) => { usdu.seam_fix_width = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "seam_fix_mask_blur", kind: "int", opts: { min: 0, max: 64, step: 1 },
          getValue: () => usdu.seam_fix_mask_blur, setValue: (v) => { usdu.seam_fix_mask_blur = v; },
        }, commit).root);
        box.appendChild(buildNumericField(doc, {
          label: "seam_fix_padding", kind: "int", opts: { min: 0, max: 256, step: 8 },
          getValue: () => usdu.seam_fix_padding, setValue: (v) => { usdu.seam_fix_padding = v; },
        }, commit).root);

        appendStageSamplerAdvancedFields(doc, ctx, box, u, state.sampler, () => {
          commit();
          helpers.refreshSummary(u.enabled ? summaryText() : null);
        }, helpers.rebuildMenu);
      });
    },
    onToggleExpand: () => { state.ui_expanded.upscale = !expanded; persistGenState(node); repaintGenerator(node, ctx); },
    onToggleSwitch: () => { setSwitchAndExpand(state, "upscale", u); persistGenState(node); repaintGenerator(node, ctx); },
    buildBody: (body) => {
      if (missing) {
        body.appendChild(buildMissing(doc, missingText));
      }
      // Label is "Model", NOT "upscale_model_name" -- the section card itself
      // already scopes it to Upscale, so repeating the full settings-path
      // name in the row was over-qualified (task item 3). DISPLAY only: the
      // settings path stays `upscale.usdu.upscale_model_name` (unchanged
      // below) so a state-shape change can't break a saved workflow.
      body.appendChild(buildModelFilePicker(
        doc, ctx, "upscale_models", "Model",
        "No upscale models installed (UpscaleModelLoader's own list is empty or unavailable) -- showing the saved value.",
        () => u.usdu.upscale_model_name, (v) => { u.usdu.upscale_model_name = v; }, () => persistGenState(node),
      ));
      body.appendChild(buildNumericField(doc, {
        label: "scale_by", kind: "float", opts: { min: 1, max: 4, step: 0.05 },
        getValue: () => u.scale_by, setValue: (v) => { u.scale_by = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildNumericField(doc, {
        label: "steps", kind: "int", opts: { min: 1, max: 150, step: 1 },
        getValue: () => u.steps, setValue: (v) => { u.steps = v; },
      }, () => persistGenState(node)).root);
      body.appendChild(buildNumericField(doc, {
        label: "denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
        getValue: () => u.denoise, setValue: (v) => { u.denoise = v; },
      }, () => persistGenState(node)).root);
    },
  });
}

/** A `buildBoolField` bound to `obj[key]`, wired to persist immediately --
 * a tiny shared helper for the several plain-boolean USDU/detailer/Save
 * advanced fields that don't need anything fancier than "flip and commit."
 * Returns the field's root directly (unlike `buildBoolField` itself, which
 * returns `{root, switchEl, word}`) since every call site here just wants
 * to `appendChild` it. */
function buildBoolFieldInto(doc, label, obj, key, onCommit) {
  const field = buildBoolField(doc, label, obj[key]);
  field.switchEl.addEventListener("click", () => {
    obj[key] = !obj[key];
    field.word.textContent = obj[key] ? "on" : "off";
    onCommit();
  });
  return field.root;
}

// Mod Guidance and Postprocess are explicitly OUT of scope for the inline/
// advanced split (task item 3: "leave their current field sets as they
// are -- not in scope, don't restructure them") -- `buildPostprocessSection`
// below is otherwise UNCHANGED except routing its two steppers through
// `buildAnStepper` (task item 2's stepper-onOpenList fix applies to every
// stepper in this file, restructured or not).
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
      body.appendChild(buildAnStepper(doc, ctx, { label: "mode", value: fit.mode, options: ["max_long_edge", "megapixels"] }, {
        onChange: (v) => { fit.mode = v; persistGenState(node); },
      }).root);
      body.appendChild(buildAnStepper(doc, ctx, { label: "method", value: fit.method, options: ["bicubic", "bilinear", "area"] }, {
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

/** A detailer block's ADVANCED fields (task item 3's own table) -- opened
 * from that block's OWN ⚙ (`buildDetailerBody` below), a SEPARATE menu from
 * the section-level ⚙ Highres/Upscale each have (Detailer's section header
 * has no advanced content of its own -- `detailer.sam3.checkpoint` is its
 * only section-wide setting, and it's already inline). Built from the SAME
 * field builders the inline rows use -- `withInfoIcon`'s guide_size_for/
 * noise_mask_feather pairing note carries over unchanged, just relocated. */
function buildDetailerAdvancedFields(doc, ctx, node, state, block, box, helpers) {
  const commit = () => persistGenState(node);

  const detectPromptF = buildTextField(doc, "detect_prompt", block.detect_prompt);
  detectPromptF.control.addEventListener("change", () => { block.detect_prompt = detectPromptF.control.value; commit(); });
  box.appendChild(detectPromptF.root);
  const wildcardF = buildTextField(doc, "wildcard", block.wildcard);
  wildcardF.control.addEventListener("change", () => { block.wildcard = wildcardF.control.value; commit(); });
  box.appendChild(wildcardF.root);
  box.appendChild(buildNumericField(doc, {
    label: "detect_count", kind: "int", opts: { min: 1, max: 20, step: 1 },
    getValue: () => block.detect_count, setValue: (v) => { block.detect_count = v; },
  }, commit).root);

  box.appendChild(buildSublabel(doc, "refine"));
  box.appendChild(buildNumericField(doc, {
    label: "feather", kind: "int", opts: { min: 0, max: 64, step: 1 },
    getValue: () => block.feather, setValue: (v) => { block.feather = v; },
  }, commit).root);
  box.appendChild(buildNumericField(doc, {
    label: "guide_size", kind: "int", opts: { min: 64, max: 4096, step: 32 },
    getValue: () => block.guide_size, setValue: (v) => { block.guide_size = v; },
  }, commit).root);
  box.appendChild(buildNumericField(doc, {
    label: "max_size", kind: "int", opts: { min: 64, max: 4096, step: 32 },
    getValue: () => block.max_size, setValue: (v) => { block.max_size = v; },
  }, commit).root);
  box.appendChild(buildNumericField(doc, {
    label: "crop_factor", kind: "float", opts: { min: 1, max: 10, step: 0.1 },
    getValue: () => block.crop_factor, setValue: (v) => { block.crop_factor = v; },
  }, commit).root);
  box.appendChild(buildNumericField(doc, {
    label: "cycle", kind: "int", opts: { min: 1, max: 10, step: 1 },
    getValue: () => block.cycle, setValue: (v) => { block.cycle = v; },
  }, commit).root);
  box.appendChild(buildNumericField(doc, {
    label: "refine_iterations", kind: "int", opts: { min: 1, max: 10, step: 1 },
    getValue: () => block.refine_iterations, setValue: (v) => { block.refine_iterations = v; },
  }, commit).root);
  box.appendChild(buildNumericField(doc, {
    label: "drop_size", kind: "int", opts: { min: 1, max: 2000, step: 1 },
    getValue: () => block.drop_size, setValue: (v) => { block.drop_size = v; },
  }, commit).root);
  const guideSizeForField = buildBoolField(doc, "guide_size_for", block.guide_size_for);
  guideSizeForField.switchEl.addEventListener("click", () => {
    block.guide_size_for = !block.guide_size_for;
    guideSizeForField.word.textContent = block.guide_size_for ? "on" : "off";
    commit();
  });
  // The one warn ⓘ covers BOTH fields it names -- see this module's top doc
  // comment on the ⓘ affordance replacing a `buildNote` text block.
  box.appendChild(withInfoIcon(doc, guideSizeForField.root, "Do not \"fix\" these -- guide_size_for must be false and noise_mask_feather must not be 0.", true));
  box.appendChild(buildNumericField(doc, {
    label: "noise_mask_feather", kind: "int", opts: { min: 1, max: 64, step: 1 },
    getValue: () => block.noise_mask_feather, setValue: (v) => { block.noise_mask_feather = v; },
  }, commit).root);
  box.appendChild(buildBoolFieldInto(doc, "noise_mask", block, "noise_mask", commit));
  box.appendChild(buildBoolFieldInto(doc, "force_inpaint", block, "force_inpaint", commit));
  box.appendChild(buildBoolFieldInto(doc, "inpaint_model", block, "inpaint_model", commit));
  box.appendChild(buildBoolFieldInto(doc, "bbox_fill", block, "bbox_fill", commit));
  box.appendChild(buildBoolFieldInto(doc, "contour_fill", block, "contour_fill", commit));
  box.appendChild(buildBoolFieldInto(doc, "combined", block, "combined", commit));
  box.appendChild(buildBoolFieldInto(doc, "individual_masks", block, "individual_masks", commit));
  box.appendChild(buildBoolFieldInto(doc, "tiled_decode", block, "tiled_decode", commit));
  box.appendChild(buildBoolFieldInto(doc, "tiled_encode", block, "tiled_encode", commit));
  const alignmentF = buildTextField(doc, "alignment", block.alignment);
  alignmentF.control.addEventListener("change", () => { block.alignment = alignmentF.control.value; commit(); });
  box.appendChild(alignmentF.root);

  appendStageSamplerAdvancedFields(doc, ctx, box, block, state.sampler, commit, helpers.rebuildMenu);
}

/** The Detailer section's body -- tabs (one per block) + the active block's
 * own fields. `node._anDetailerTab` is ephemeral UI-only state (which block
 * is showing), same as before the inline-sections dispatch; every action
 * here still ends in a full `repaintGenerator` (`refresh` below), which is
 * exactly how every other section already behaves now.
 *
 * **INLINE (task item 3's own table): label, enabled (the on/off button
 * already here), threshold, steps, denoise.** Everything else about a
 * block -- `detect_prompt`/`wildcard`/the sampler-inherit block/every other
 * field -- lives behind that block's OWN ⚙ (`buildDetailerAdvancedFields`
 * above), separate from the Highres/Upscale kind of SECTION-level ⚙: the
 * Detailer's section header carries no ⚙ of its own at all, since its only
 * section-wide setting (`sam3.checkpoint`) is already inline. */
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
  // The block's OWN ⚙ -- deliberately a plain `buildGearIcon` here, not
  // `buildSectionHeader`'s (this body isn't built from `buildSection` at
  // all, it's the tab-strip shape). Anchored to itself; `sumEl` is `null`
  // (there's no per-block header summary span for `refreshSummary` to
  // touch), which `openAdvancedMenu` already tolerates.
  let gearBtn;
  gearBtn = buildGearIcon(doc, "Advanced: detect_prompt, wildcard, sampler inherit, and the full detailer field set.", () => {
    openAdvancedMenu(doc, ctx, `gen:detailer:${activeId}:adv`, gearBtn, null, (advBox, helpers) => {
      buildDetailerAdvancedFields(doc, ctx, node, state, block, advBox, helpers);
    });
  });
  moveRow.appendChild(gearBtn);
  box.appendChild(moveRow);

  const labelF = buildTextField(doc, "label", block.label);
  labelF.control.addEventListener("change", () => {
    block.label = labelF.control.value;
    persistGenState(node);
    refresh(); // the tab strip's own button text names this block -- must repaint
  });
  box.appendChild(labelF.root);
  box.appendChild(buildNumericField(doc, {
    label: "threshold", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
    getValue: () => block.threshold, setValue: (v) => { block.threshold = v; },
  }, () => persistGenState(node)).root);
  box.appendChild(buildNumericField(doc, {
    label: "steps", kind: "int", opts: { min: 1, max: 150, step: 1 },
    getValue: () => block.steps, setValue: (v) => { block.steps = v; },
  }, () => persistGenState(node)).root);
  box.appendChild(buildNumericField(doc, {
    label: "denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
    getValue: () => block.denoise, setValue: (v) => { block.denoise = v; },
  }, () => persistGenState(node)).root);
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
  // Same reasoning, for the ⚙/option-list overlay this dispatch brought back
  // (this module's top doc comment): ANY full-body repaint discards the
  // header/field elements a currently-open overlay might be anchored to, so
  // it must close first -- an edit made FROM INSIDE an open menu never
  // reaches this function at all (it calls `persistGenState`/`helpers.
  // refreshSummary`/`helpers.rebuildMenu` directly instead, precisely so the
  // menu it's inside of survives), so this can never close a menu the very
  // click that triggered this repaint owns.
  closeActiveOverlay();
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
 * Confirmed live (2026-07-28): a completed run does call `onExecuted` on
 * this non-`OUTPUT_NODE` with `{anima_context: {...}}` intact -- the
 * `VERIFY-IN-COMFYUI` this doc comment used to carry (and the same one on
 * `nodes/anima/generator.py`'s side of this channel) is resolved, not just
 * dropped. **One real behaviour the probe surfaced: a CACHED run (this
 * node not re-executed this queue) emits no `executed` message at all** --
 * this function is simply never called that run, and that's fine as-is:
 * `computeEffectiveContextSupplied` (this module's top doc comment) already
 * falls back to the live litegraph-link walk when there's no run report,
 * and whatever `node._anContextRun` already held from an earlier run stays
 * valid for as long as the wiring it described hasn't changed (cleared only
 * on an actual connection change, never on "this run happened to be
 * cached").
 *
 * **2026-07-28, live bug**: the probe above also caught the report NEVER
 * reaching `node._anContextRun` at all, despite the server log proving the
 * Generator built the payload every run. Cause: ComfyUI's executor
 * accumulates each node's OWN `ui` dict values into a LIST across the
 * executions the node underwent this queue -- a value that's ALREADY a
 * list is concatenated onto the accumulator in place (this is exactly why
 * `ui.images`/this node's own `anima_stages` are always arrays, whether one
 * entry or many), but a value that ISN'T a list -- like this dict --
 * still goes through the SAME accumulator, so it arrives wrapped as a
 * single-element array, `[{supplied, values}]`. This function used to
 * REJECT any array outright (a guard added to be defensive about payload
 * shape) -- which silently discarded the real payload on every single run,
 * invisibly, because the guard *looked* correct.
 * `normalizeAnimaContextPayload` (below) is the shape-tolerant fix, kept as
 * its own pure/exported function so the five payload shapes it must handle
 * are directly testable without mounting a node at all.
 */
export function normalizeAnimaContextPayload(animaContext) {
  let payload = animaContext;
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return null; // an empty accumulator -- nothing reported this run
    }
    // A later report supersedes an earlier one (the multi-execution case
    // this accumulator exists FOR at all, e.g. a node inside a loop) --
    // take the LAST entry, not the first.
    payload = payload[payload.length - 1];
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null; // still not a bare object (nested array, string, null, ...)
  }
  return payload;
}

export function handleGeneratorExecuted(node, ctx, message) {
  const payload = normalizeAnimaContextPayload(message && message.anima_context);
  if (!payload) {
    return;
  }
  node._anContextRun = payload;
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

  body.appendChild(buildSaveRow(doc, node, ctx, state));

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
/**
 * The Preview's Save ROW (task item 2, hybrid essentials/⚙ dispatch) --
 * REPLACES the old inline accordion `buildSaveSection`. The user asked for
 * this specifically: the Preview's image must fill the node, and an inline
 * Save section ate that space (`render.mjs`'s own doc comment on
 * `PREVIEW_PANEL_MIN_H`'s recomputed arithmetic). Save is now a single row
 * that NEVER expands in place -- no chevron, no `.wtn-an-sbody` (`hasChevron:
 * false` on `buildSectionHeader`) -- clicking anywhere on the row (or its own
 * ⚙, same target really: both open the SAME menu, `stopPropagation` on the
 * switch is what keeps that one control separate) opens the SAME field set
 * the accordion used to hold, anchored `placement: "right"`. The switch
 * still toggles `save.enabled` directly, immediately, with a full repaint
 * (there is no `ui_expanded` left to keep in step with it any more --
 * `state.mjs`'s own top doc comment).
 */
function buildSaveRow(doc, node, ctx, state) {
  const save = state.save;
  const summaryText = () => `${save.which} · ${save.extension}`;

  const head = buildSectionHeader(doc, {
    label: "Save", expanded: false, hasChevron: false,
    hasSwitch: true, switchOn: save.enabled,
    infoTooltip: "Saving lives here, not on the Generator -- this node holds the images, so it's the only place base/mid/final can be saved under different names.",
    summary: save.enabled ? summaryText() : null,
    hasGear: true,
    gearTooltip: "which, extension, path, filename, embed workflow.",
    onGearClick: () => openSaveMenu(),
  });
  head.root.classList.add("wtn-an-menurow");
  if (head.switchEl) {
    head.switchEl.addEventListener("click", (e) => {
      e.stopPropagation();
      save.enabled = !save.enabled;
      persistPreviewState(node);
      repaintPreview(node, ctx);
    });
  }
  // The row itself is ALSO a click target for the same menu (the gear is
  // the discoverable affordance; the row-click is the forgiving one) --
  // the switch's own listener above already stops propagation, so flipping
  // it can never also open this.
  head.root.addEventListener("click", () => openSaveMenu());

  function openSaveMenu() {
    openAdvancedMenu(doc, ctx, "pv:save:adv", head.root, head.sumEl, (box, helpers) => {
      const refreshSum = () => helpers.refreshSummary(save.enabled ? summaryText() : null);
      box.appendChild(buildAnStepper(doc, ctx, { label: "which", value: save.which, options: SAVE_WHICH_OPTIONS }, {
        onChange: (v) => { save.which = v; persistPreviewState(node); refreshSum(); },
      }).root);
      box.appendChild(buildAnStepper(doc, ctx, { label: "extension", value: save.extension, options: ["png", "jpg", "webp"] }, {
        onChange: (v) => { save.extension = v; persistPreviewState(node); refreshSum(); },
      }).root);
      const pathF = buildTextField(doc, "path", save.path);
      pathF.control.addEventListener("change", () => {
        save.path = pathF.control.value;
        persistPreviewState(node);
      });
      box.appendChild(pathF.root);
      const filenameF = buildTextField(doc, "filename", save.filename);
      filenameF.control.addEventListener("change", () => {
        save.filename = filenameF.control.value;
        persistPreviewState(node);
      });
      box.appendChild(withInfoIcon(doc, filenameF.root, "%stage% (base/mid/final), %seed%, %date:FMT%, %counter:N%, %width%, %height%."));
      box.appendChild(buildBoolFieldInto(doc, "embed workflow", save, "embed_workflow", () => persistPreviewState(node)));
    });
  }

  return head.root;
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
  // Same reasoning as `repaintGenerator`'s own call -- the Save row's ⚙
  // menu (`buildSaveRow` below) is anchored to a header element this
  // repaint is about to discard.
  closeActiveOverlay();
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
 *
 * **2026-07-28, checked for the mirror-image bug (`handleGeneratorExecuted`'s
 * own doc comment above): this channel is SAFE BY CONSTRUCTION, not just by
 * luck.** ComfyUI's executor accumulates a node's `ui` value by EXTENDING an
 * accumulator list with it (`list.extend(value)`), which requires `value` to
 * already be a list -- `build_preview_ui_images` (`nodes/anima/
 * _preview_helpers.py`) is typed `-> List[Dict[str, Any]]` and always
 * returns a plain list (possibly empty), never a bare dict, so this channel
 * never hits the "dict flattened to its own key names" trap `anima_context`
 * did. `normalizeAnimaStagesPayload` below still accepts a bare object (one
 * entry, not wrapped) as cheap extra tolerance for a payload shape ComfyUI's
 * own contract shouldn't ever produce -- but a genuinely malformed payload
 * (null, a string, an array of non-objects) is still rejected exactly as
 * before, matching `normalizeAnimaContextPayload`'s own "don't loosen it to
 * accept anything" contract.
 */
export function normalizeAnimaStagesPayload(animaStages) {
  if (Array.isArray(animaStages)) {
    return animaStages;
  }
  if (animaStages && typeof animaStages === "object") {
    return [animaStages]; // a bare single entry -- not the shape Python sends, but cheap to tolerate
  }
  return null;
}

export function handleExecuted(node, ctx, message) {
  const entries = normalizeAnimaStagesPayload(message && message.anima_stages);
  if (!entries) {
    return;
  }
  const cacheBust = Date.now();
  const byStage = {};
  for (const entry of entries) {
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
