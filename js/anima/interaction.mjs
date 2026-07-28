/**
 * interaction.mjs — event wiring + node-level orchestration for
 * `AnimaGenerator` / `AnimaPreview`. `render.mjs` only builds/paints small
 * presentational DOM pieces; THIS module owns the tree shape (which rows
 * exist right now, in which order, wired to what) and the state <-> hidden-
 * widget handshake — mirrors `js/controls/interaction.mjs`'s split with
 * `render.mjs`.
 *
 * ## `ctx` — the one object every function here takes
 *
 *   {
 *     doc: document,                  // or a stub, under test
 *     getCanvasEl(): HTMLCanvasElement|null,   // app.canvas.canvas, live
 *     havePackages(): {spectrum, usdu, impact},// soft-import presence, live
 *   }
 *
 * `getCanvasEl`/`havePackages` are the only two places this whole feature
 * needs `window`/`app`/`LiteGraph` — kept OUT of this file (index.js owns
 * them) so this module stays testable with a stub.
 *
 * ## Full-body REBUILD, and why popovers are never rebuilt while open
 *
 * See `render.mjs`'s top doc comment for why this node rebuilds its whole
 * body on every discrete action rather than diffing. The rule that makes
 * that safe: a popover's anchor is a row element living INSIDE the panel, so
 * rebuilding the panel while that popover is still open would detach its
 * anchor. So every body-mutating handler calls `closeActiveOverlay()` FIRST,
 * THEN mutates + persists + rebuilds; editing a field INSIDE an open
 * popover mutates + persists but does not rebuild the body (only, if the
 * edit changes what that SAME popover should show, rebuilds the popover's
 * own content in place — `refresh()`).
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
 * field it isn't sure about.
 */

import { installCanvasZoomPassthrough } from "../shared/canvas_zoom.mjs";
import { activeOverlayRef, closeActiveOverlay, closeOverlayIfOwnedBy, openOverlayWithZoom } from "../shared/overlay.mjs";
import { buildNumericField, buildStepperField } from "../shared/fields.mjs";

import {
  MAX_DETAILER_PASSES,
  SAMPLER_FIELDS,
  CONTEXT_FIELDS,
  COMPARE_SLOTS,
  SAVE_WHICH_OPTIONS,
  STAGE_ORDER,
  normalizeGenerationSettings,
  normalizePreviewSettings,
  resolveStageSampler,
  addDetailerBlock,
  removeDetailerBlock,
  moveDetailerBlock,
  isBuiltinDetailerBlock,
} from "./state.mjs";

import {
  injectStyles,
  buildPanelShell,
  buildClickRow,
  buildSwitch,
  buildGear,
  buildDrivenField,
  buildTextField,
  buildBoolField,
  sectionLabel,
  buildSublabel,
  buildNote,
  buildMissing,
  buildPopoverShell,
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
 * `restoreGenState`. */
export function ensureGenState(node) {
  const w = getGenSettingsWidget(node);
  const state = normalizeGenerationSettings(w ? w.value : "{}");
  node._anGenState = state;
  writeGenStateToWidget(node, state);
  return state;
}
export const restoreGenStateFromWidget = ensureGenState;

export function persistGenState(node) {
  writeGenStateToWidget(node, node._anGenState);
}

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

// ---------------------------------------------------------------------------
// Popover open/close -- one choke point, so every popover this node opens
// gets the ownerKey toggle + wheel-zoom passthrough + the
// rebuild-on-close-only contract described in this module's top doc comment.
// ---------------------------------------------------------------------------

/**
 * Opens (or, on a second click of the SAME anchor, closes) a popover.
 * `buildContent(refresh)` builds the popover's content root; it receives a
 * `refresh()` callback it can call after an in-place mutation to rebuild
 * ITS OWN content. `onClosed(node, ctx)` runs when the popover closes for
 * any reason (rebuilds the body with the field's final values).
 */
function openPopover({ ctx, node, key, anchorEl, title, buildContent, onClosed }) {
  if (closeOverlayIfOwnedBy(key)) {
    return; // toggle: this row's own popover was open -- just close it
  }
  closeActiveOverlay(); // a DIFFERENT popover was open -- switch to this one
  const doc = ctx.doc;
  const { root: shell, closeBtn } = buildPopoverShell(doc, title);

  let handle = null;
  const refresh = () => {
    while (shell.children.length > 1) {
      shell.removeChild(shell.children[shell.children.length - 1]);
    }
    const content = buildContent(refresh);
    if (content) {
      shell.appendChild(content);
    }
    if (handle && typeof handle.reposition === "function") {
      handle.reposition();
    }
  };
  refresh();

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeActiveOverlay();
  });

  handle = openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, shell, "right", () => {
    anchorEl.classList && anchorEl.classList.remove("wtn-an-open");
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
    if (typeof onClosed === "function") {
      onClosed();
    }
  }, "wtn-an-pop-overlay wtn-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
  anchorEl.classList && anchorEl.classList.add("wtn-an-open");
}

const SAMPLERS = ["euler", "euler_ancestral", "er_sde", "dpmpp_2m", "heun", "ddim"];
const SCHEDULERS = ["simple", "sgm_uniform", "karras", "normal", "beta", "exponential"];

// ---------------------------------------------------------------------------
// Sampler section (first-pass sampler + summary rows + Mod Guidance)
// ---------------------------------------------------------------------------

function buildSamplerSection(doc, node, ctx, state) {
  const frag = el(doc, "div");
  frag.appendChild(sectionLabel(doc, "sampler", "first pass"));

  const { supplied } = computeContextSupplied(node);
  const sampler = state.sampler;
  const summary = buildClickRow({
    doc, name: `${supplied.sampler_name ? "—" : sampler.sampler_name} / ${supplied.scheduler ? "—" : sampler.scheduler}`,
    value: `${supplied.steps ? "—" : sampler.steps} steps · cfg ${supplied.cfg ? "—" : Number(sampler.cfg).toFixed(1)}`,
  });
  summary.root.addEventListener("click", () => openSamplerPopover(node, ctx, summary.root));
  frag.appendChild(summary.root);

  const seedRow = buildClickRow({
    doc, name: "seed",
    value: supplied.seed ? "from Context Bridge" : (sampler.seed === -1 ? "-1 (random)" : String(sampler.seed)),
  });
  seedRow.root.addEventListener("click", () => openSamplerPopover(node, ctx, seedRow.root));
  frag.appendChild(seedRow.root);

  const have = ctx.havePackages ? ctx.havePackages() : { spectrum: true };
  const mg = state.mod_guidance;
  const mgRow = buildClickRow({
    doc, name: "mod guidance",
    value: !have.spectrum ? "unavailable" : (mg.enabled ? mg.profile : "off"),
  });
  mgRow.root.addEventListener("click", () => openModGuidancePopover(node, ctx, mgRow.root));
  frag.appendChild(mgRow.root);

  return frag;
}

function openSamplerPopover(node, ctx, anchorEl) {
  openPopover({
    ctx, node, key: "sampler", anchorEl, title: "Sampler",
    buildContent: () => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const sampler = state.sampler;
      const { bridgeFound, supplied } = computeContextSupplied(node);

      const box = el(doc, "div");
      box.appendChild(buildNote(
        doc,
        bridgeFound
          ? "Fields the Anima Context Bridge has wired drive this run; everything else comes from here."
          : "No Anima Context Bridge resolved upstream of ‘context’ (unwired, or wired through something that isn't a bridge) -- every field below comes from here.",
      ));

      SAMPLER_FIELDS.forEach((field) => {
        if (supplied[field]) {
          box.appendChild(buildDrivenField(doc, field, "Context Bridge").root);
          return;
        }
        if (field === "sampler_name") {
          box.appendChild(buildStepperField(doc, { label: "sampler_name", value: sampler.sampler_name, options: SAMPLERS }, {
            onChange: (v) => { sampler.sampler_name = v; persistGenState(node); },
          }).root);
        } else if (field === "scheduler") {
          box.appendChild(buildStepperField(doc, { label: "scheduler", value: sampler.scheduler, options: SCHEDULERS }, {
            onChange: (v) => { sampler.scheduler = v; persistGenState(node); },
          }).root);
        } else if (field === "cfg") {
          box.appendChild(buildNumericField(doc, {
            label: "cfg", kind: "float", opts: { min: 0, max: 30, step: 0.1 },
            getValue: () => sampler.cfg, setValue: (v) => { sampler.cfg = v; },
          }, () => persistGenState(node)).root);
        } else if (field === "steps") {
          box.appendChild(buildNumericField(doc, {
            label: "steps", kind: "int", opts: { min: 1, max: 150, step: 1 },
            getValue: () => sampler.steps, setValue: (v) => { sampler.steps = v; },
          }, () => persistGenState(node)).root);
        } else if (field === "seed") {
          box.appendChild(buildNumericField(doc, {
            label: "seed", kind: "int", opts: { min: -1, max: 2147483647, step: 1 },
            getValue: () => sampler.seed, setValue: (v) => { sampler.seed = v; },
          }, () => persistGenState(node)).root);
        }
      });

      box.appendChild(buildNumericField(doc, {
        label: "denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
        getValue: () => sampler.denoise, setValue: (v) => { sampler.denoise = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildNumericField(doc, {
        label: "shift", kind: "float", opts: { min: 0, max: 10, step: 0.1 },
        getValue: () => sampler.shift, setValue: (v) => { sampler.shift = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildNote(doc, "shift 3.0 is Anima's recommended default and is always applied. Later stages inherit these unless their own inherit_sampler_settings is off."));
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

function openModGuidancePopover(node, ctx, anchorEl) {
  openPopover({
    ctx, node, key: "mod", anchorEl, title: "Mod guidance",
    buildContent: (refresh) => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const have = ctx.havePackages ? ctx.havePackages() : { spectrum: true };
      if (!have.spectrum) {
        return buildMissing(doc, "ComfyUI-Spectrum-KSampler not installed -- Mod Guidance is unavailable.");
      }
      const mg = state.mod_guidance;
      const box = el(doc, "div");

      const enabledField = buildBoolField(doc, "enabled", mg.enabled);
      enabledField.switchEl.addEventListener("click", () => {
        mg.enabled = !mg.enabled;
        persistGenState(node);
        refresh();
      });
      box.appendChild(enabledField.root);

      box.appendChild(buildStepperField(doc, { label: "profile", value: mg.profile, options: ["step_i8_skip27", "step_i14", "uniform_w3"] }, {
        onChange: (v) => { mg.profile = v; persistGenState(node); },
      }).root);
      box.appendChild(buildNumericField(doc, {
        label: "mod_w", kind: "float", opts: { min: 0, max: 10, step: 0.1 },
        getValue: () => mg.mod_w, setValue: (v) => { mg.mod_w = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildNumericField(doc, {
        label: "mod_start_layer", kind: "int", opts: { min: 0, max: 48, step: 1 },
        getValue: () => mg.mod_start_layer, setValue: (v) => { mg.mod_start_layer = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildNumericField(doc, {
        label: "mod_end_layer", kind: "int", opts: { min: 0, max: 48, step: 1 },
        getValue: () => mg.mod_end_layer, setValue: (v) => { mg.mod_end_layer = v; },
      }, () => persistGenState(node)).root);

      box.appendChild(buildSublabel(doc, "quality tags"));
      const pos = buildTextField(doc, "positive", mg.quality_tags);
      pos.control.addEventListener("change", () => {
        mg.quality_tags = pos.control.value;
        persistGenState(node);
      });
      box.appendChild(pos.root);
      const neg = buildTextField(doc, "negative", mg.quality_neg);
      neg.control.addEventListener("change", () => {
        mg.quality_neg = neg.control.value;
        persistGenState(node);
      });
      box.appendChild(neg.root);
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

// ---------------------------------------------------------------------------
// Stage-sampler sub-block (highres/upscale/each detailer block) -- design
// doc §6b. Hides EXACTLY `cfg`/`sampler_name`/`scheduler` while
// `inherit_sampler_settings` is on; `steps`/`denoise` are always the
// stage's own. Appends into `container`.
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
  container.appendChild(inheritField.root);

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
  } else {
    const resolved = resolveStageSampler(stageSettings, firstPassSampler);
    container.appendChild(buildNote(doc, `Using cfg ${Number(resolved.cfg).toFixed(1)}, ${resolved.sampler_name} / ${resolved.scheduler} from the first pass. Steps and denoise above are still this stage's own.`));
  }
}

// ---------------------------------------------------------------------------
// Stages section
// ---------------------------------------------------------------------------

const STAGE_DEFS = [
  { key: "highres", name: "Highres" },
  { key: "detailer", name: "Detailer" },
  { key: "upscale", name: "Upscale" },
  { key: "postprocess", name: "Postprocess" },
];

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

function buildStagesSection(doc, node, ctx, state) {
  const have = ctx.havePackages ? ctx.havePackages() : { spectrum: true, usdu: true, impact: true };
  const frag = el(doc, "div");
  const onCount = STAGE_DEFS.filter((s) => state[s.key].enabled).length;
  frag.appendChild(sectionLabel(doc, "stages", `${onCount}/${STAGE_DEFS.length} on`));

  STAGE_DEFS.forEach(({ key, name }) => {
    const stage = state[key];
    const on = !!stage.enabled;
    const blocked = on && stageBlocked(key, state, have);
    const row = el(doc, "div", `wtn-an-stagerow${on ? "" : " wtn-an-off"}${blocked ? " wtn-an-dep" : ""}`);
    const sw = buildSwitch(doc, on);
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      closeActiveOverlay();
      stage.enabled = !on;
      persistGenState(node);
      repaintGenerator(node, ctx);
    });
    const sn = el(doc, "span", "wtn-an-sn");
    sn.textContent = name;
    const ss = el(doc, "span", "wtn-an-ss");
    ss.textContent = stageSummary(key, state, have);
    const gear = buildGear(doc, `${name} settings`);
    gear.addEventListener("click", (e) => {
      e.stopPropagation();
      openStagePopover(node, ctx, key, row);
    });
    row.appendChild(sw);
    row.appendChild(sn);
    row.appendChild(ss);
    row.appendChild(gear);
    frag.appendChild(row);
  });

  return frag;
}

function openStagePopover(node, ctx, key, anchorEl) {
  if (key === "highres") {
    return openHighresPopover(node, ctx, anchorEl);
  }
  if (key === "detailer") {
    return openDetailerPopover(node, ctx, anchorEl);
  }
  if (key === "upscale") {
    return openUpscalePopover(node, ctx, anchorEl);
  }
  return openPostprocessPopover(node, ctx, anchorEl);
}

function openHighresPopover(node, ctx, anchorEl) {
  openPopover({
    ctx, node, key: "highres", anchorEl, title: "Highres",
    buildContent: (refresh) => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const h = state.highres;
      const box = el(doc, "div");
      box.appendChild(buildNote(doc, "Latent upscale, resample at low denoise. Runs before the detailer, so faces get fixed at generation resolution rather than after an upscale."));
      box.appendChild(buildNumericField(doc, {
        label: "scale_by", kind: "float", opts: { min: 1, max: 4, step: 0.05 },
        getValue: () => h.scale_by, setValue: (v) => { h.scale_by = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildStepperField(doc, { label: "upscale_method", value: h.upscale_method, options: ["bicubic", "bilinear", "nearest-exact", "area"] }, {
        onChange: (v) => { h.upscale_method = v; persistGenState(node); },
      }).root);
      box.appendChild(buildTextField(doc, "multiple", h.multiple).root);
      box.appendChild(buildNumericField(doc, {
        label: "max_long_edge", kind: "int", opts: { min: 512, max: 8192, step: 32 },
        getValue: () => h.max_long_edge, setValue: (v) => { h.max_long_edge = v; },
      }, () => persistGenState(node)).root);
      appendStageSamplerFields(doc, box, h, state.sampler, () => persistGenState(node), refresh);
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

function openUpscalePopover(node, ctx, anchorEl) {
  openPopover({
    ctx, node, key: "upscale", anchorEl, title: "Upscale",
    buildContent: (refresh) => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const have = ctx.havePackages ? ctx.havePackages() : { usdu: true };
      const box = el(doc, "div");
      if (!have.usdu) {
        box.appendChild(buildMissing(doc, "ComfyUI_UltimateSDUpscale not installed -- the upscale stage is disabled."));
      }
      const u = state.upscale;
      box.appendChild(buildNumericField(doc, {
        label: "scale_by", kind: "float", opts: { min: 1, max: 4, step: 0.05 },
        getValue: () => u.scale_by, setValue: (v) => { u.scale_by = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildTextField(doc, "upscale_model", u.usdu.upscale_model_name).root);
      box.appendChild(buildStepperField(doc, { label: "mode_type", value: u.usdu.mode_type, options: ["Linear", "Chess", "None"] }, {
        onChange: (v) => { u.usdu.mode_type = v; persistGenState(node); },
      }).root);
      box.appendChild(buildStepperField(doc, { label: "seam_fix_mode", value: u.usdu.seam_fix_mode, options: ["None", "Band Pass", "Half Tile", "Half Tile + Intersections"] }, {
        onChange: (v) => { u.usdu.seam_fix_mode = v; persistGenState(node); },
      }).root);
      box.appendChild(buildNumericField(doc, {
        label: "seam_fix_denoise", kind: "float", opts: { min: 0, max: 1, step: 0.01 },
        getValue: () => u.usdu.seam_fix_denoise, setValue: (v) => { u.usdu.seam_fix_denoise = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildNote(doc, "mode_type is tile ORDER (Linear/Chess/None). tiled_decode is an unrelated VAE flag -- don't conflate them."));
      appendStageSamplerFields(doc, box, u, state.sampler, () => persistGenState(node), refresh);
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

function openPostprocessPopover(node, ctx, anchorEl) {
  openPopover({
    ctx, node, key: "postprocess", anchorEl, title: "Postprocess",
    buildContent: () => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const fit = state.postprocess.fit;
      const box = el(doc, "div");
      box.appendChild(buildNote(doc, "The output size cap."));
      box.appendChild(buildStepperField(doc, { label: "mode", value: fit.mode, options: ["max_long_edge", "megapixels"] }, {
        onChange: (v) => { fit.mode = v; persistGenState(node); },
      }).root);
      box.appendChild(buildStepperField(doc, { label: "method", value: fit.method, options: ["bicubic", "bilinear", "area"] }, {
        onChange: (v) => { fit.method = v; persistGenState(node); },
      }).root);
      box.appendChild(buildNumericField(doc, {
        label: "max_long_edge", kind: "int", opts: { min: 256, max: 8192, step: 32 },
        getValue: () => fit.max_long_edge, setValue: (v) => { fit.max_long_edge = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildNumericField(doc, {
        label: "max_megapixels", kind: "float", opts: { min: 0.5, max: 32, step: 0.5 },
        getValue: () => fit.max_megapixels, setValue: (v) => { fit.max_megapixels = v; },
      }, () => persistGenState(node)).root);
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

function openDetailerPopover(node, ctx, anchorEl) {
  openPopover({
    ctx, node, key: "detailer", anchorEl, title: "Detailer",
    buildContent: (refresh) => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const have = ctx.havePackages ? ctx.havePackages() : { impact: true };
      const box = el(doc, "div");
      if (!have.impact) {
        box.appendChild(buildNote(doc, "ComfyUI-Impact-Pack not installed. DetailerForEach is an Impact node, so the whole stage is unavailable.", true));
      }
      box.appendChild(buildNote(doc, "N blocks, like upstream: face and eye built in, + adds more. Each block detects for itself from its own detect_prompt -- no SEGS inputs."));

      const detailer = state.detailer;
      if (!node._anDetailerTab || !detailer.blocks[node._anDetailerTab]) {
        node._anDetailerTab = detailer.order[0] || "face";
      }
      const activeId = node._anDetailerTab;

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
        return box;
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
      box.appendChild(guideSizeForField.root);
      box.appendChild(buildNumericField(doc, {
        label: "noise_mask_feather", kind: "int", opts: { min: 1, max: 64, step: 1 },
        getValue: () => block.noise_mask_feather, setValue: (v) => { block.noise_mask_feather = v; },
      }, () => persistGenState(node)).root);
      box.appendChild(buildNote(doc, "Do not \"fix\" these -- guide_size_for must be false and noise_mask_feather must not be 0.", true));

      appendStageSamplerFields(doc, box, block, state.sampler, () => persistGenState(node), refresh);
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

// ---------------------------------------------------------------------------
// Generator body root + mount/repaint
// ---------------------------------------------------------------------------

export function buildGeneratorBody(doc, node, ctx) {
  const state = node._anGenState;
  const body = el(doc, "div", "wtn-an-body");
  body.appendChild(buildSamplerSection(doc, node, ctx, state));
  body.appendChild(buildStagesSection(doc, node, ctx, state));
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
// itself is wired at all.
// ---------------------------------------------------------------------------

export function buildPreviewBody(doc, node, ctx) {
  const state = node._anPreviewState;
  const previewImages = node._anPreviewImages || {};
  const stagesPresent = STAGE_ORDER.filter((s) => previewImages[s]);
  const body = el(doc, "div", "wtn-an-body");

  const saveRow = buildClickRow({
    doc, name: "save",
    value: state.save.enabled ? `${state.save.which} · ${state.save.extension}` : "off",
  });
  saveRow.root.addEventListener("click", () => openSavePopover(node, ctx, saveRow.root));
  body.appendChild(saveRow.root);

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

function openSavePopover(node, ctx, anchorEl) {
  openPopover({
    ctx, node, key: "pvsave", anchorEl, title: "Save",
    buildContent: (refresh) => {
      const doc = ctx.doc;
      const state = node._anPreviewState;
      const save = state.save;
      const box = el(doc, "div");
      box.appendChild(buildNote(doc, "Saving lives here, not on the Generator -- this node holds the images, so it's the only place base/mid/final can be saved under different names."));

      const enabledField = buildBoolField(doc, "enabled", save.enabled);
      enabledField.switchEl.addEventListener("click", () => {
        save.enabled = !save.enabled;
        persistPreviewState(node);
        refresh();
      });
      box.appendChild(enabledField.root);

      box.appendChild(buildStepperField(doc, { label: "which", value: save.which, options: SAVE_WHICH_OPTIONS }, {
        onChange: (v) => { save.which = v; persistPreviewState(node); },
      }).root);
      box.appendChild(buildStepperField(doc, { label: "extension", value: save.extension, options: ["png", "jpg", "webp"] }, {
        onChange: (v) => { save.extension = v; persistPreviewState(node); },
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
      box.appendChild(filenameF.root);
      const embedField = buildBoolField(doc, "embed workflow", save.embed_workflow);
      embedField.switchEl.addEventListener("click", () => {
        save.embed_workflow = !save.embed_workflow;
        persistPreviewState(node);
        refresh();
      });
      box.appendChild(embedField.root);

      box.appendChild(buildSublabel(doc, "filename tokens"));
      box.appendChild(buildNote(doc, "%stage% (base/mid/final), %seed%, %date:FMT%, %counter:N%, %width%, %height%."));
      return box;
    },
    onClosed: () => repaintPreview(node, ctx),
  });
}

export function mountPreviewUI(node, ctx) {
  if (node._anRefs) {
    return node._anRefs;
  }
  const doc = ctx.doc;
  injectStyles(doc);
  const { root, panel } = buildPanelShell(doc);
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
 * `AnimaPreview`'s `onExecuted` handler -- `message.images` is
 * `nodes/anima/preview.py`'s own `"ui": {"images": [...]}}` payload: `{
 * filename, subfolder, type, stage}` per entry, ALWAYS one entry per
 * present stage regardless of `save.enabled` (design doc §7/§7a's fix).
 *
 * VERIFY-IN-COMFYUI: that `onExecuted`'s `message` argument really is the
 * node's own `ui` dict verbatim -- no live ComfyUI process in this dev
 * environment to confirm against; matches every other node in this repo's
 * `../ComfyUI-Pixaroma` sibling that reads `message.<key>` straight off
 * `onExecuted`.
 */
export function handleExecuted(node, ctx, message) {
  if (!message || !Array.isArray(message.images)) {
    return;
  }
  const cacheBust = Date.now();
  const byStage = {};
  for (const entry of message.images) {
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
 * passthrough listener and any open popover. There is exactly ONE DOM
 * widget per node (this module never mounted more than one), so there are
 * no sibling per-row widgets to remove here; this is still the one place
 * that must run on `onRemoved`, so nothing (listener or overlay) is ever
 * left mounted after the node itself is gone. */
export function teardownNode(node) {
  closeActiveOverlay();
  const refs = node._anRefs;
  if (refs && refs.zoomUninstall) {
    refs.zoomUninstall();
    refs.zoomUninstall = null;
  }
}

// ---------------------------------------------------------------------------
// Resize wrappers (legacy litegraph primary; see render.mjs's "Resize"
// section -- there is no refit/auto-fit left to re-export; the floor
// (`measureMinHeight`) and the fresh-node defaults are all that's left).
// ---------------------------------------------------------------------------

export { measureMinHeight, DEFAULT_H, PREVIEW_DEFAULT_H };
export { closeActiveOverlay };
