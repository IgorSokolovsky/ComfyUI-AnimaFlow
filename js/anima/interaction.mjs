/**
 * interaction.mjs — event wiring + node-level orchestration for
 * `AnimaGenerator` / `AnimaPreview`. `render.mjs` only builds/paints small
 * presentational DOM pieces (a status row, a stage row's chrome, a popover
 * field); THIS module owns the tree shape (which rows exist right now, in
 * which order, wired to what) and the state <-> hidden-widget handshake --
 * mirrors `js/controls/interaction.mjs`'s split with `render.mjs`.
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
 * them) so this module stays testable with a stub, matching
 * `js/controls/interaction.mjs`'s own convention.
 *
 * ## Full-body REBUILD, and why popovers are never rebuilt while open
 *
 * See `render.mjs`'s top doc comment for why this node rebuilds its whole
 * body on every discrete BODY-LEVEL action (stage toggle, internal-loaders
 * toggle, LoRA add/remove/reorder/mute) rather than diffing. The one rule
 * that makes that safe: **a popover's anchor is a row element living INSIDE
 * the body**, so rebuilding the body while that popover is still open would
 * detach its anchor (the overlay's `reposition()`/outside-click check both
 * read `anchorEl.getBoundingClientRect()`/`.contains()`, which go straight
 * to `{0,0,0,0}`/always-false against a UNMOUNTED element). So:
 *
 *   - Every BODY-LEVEL mutating handler calls `closeActiveOverlay()` FIRST
 *     (unconditionally), THEN mutates + persists + rebuilds the body. A
 *     structural change closing an unrelated open popover is the accepted
 *     trade for never orphaning one.
 *   - Editing a FIELD INSIDE an open popover mutates state + persists the
 *     widget (so the trap in `comfyui-dynamic-node-frontend`'s "declaring is
 *     not writing" is covered on every keystroke's commit) but does **not**
 *     rebuild the body — only, if the edit changes what that SAME popover
 *     itself should show (`inherit_sampler_settings`, a sampler-field wire
 *     toggle, a detailer block's own tab switch), rebuilds the **popover's
 *     own content in place** (`refreshPopover`, below), which never touches
 *     the body/anchor at all.
 *   - The body is refreshed with the field's final values when the popover
 *     **closes** (every close path routes through one `onClose` callback).
 */

import { installCanvasZoomPassthrough } from "../shared/canvas_zoom.mjs";
import { activeOverlayRef, closeActiveOverlay, closeOverlayIfOwnedBy, openOverlayWithZoom } from "../shared/overlay.mjs";

import {
  MAX_DETAILER_PASSES,
  SAMPLER_FIELDS,
  INHERITED_SAMPLER_FIELDS,
  COMPARE_SLOTS,
  SAVE_WHICH_OPTIONS,
  normalizeGenerationSettings,
  normalizePreviewSettings,
  resolveStageSampler,
  resolveOutputs,
  addLora,
  removeLora,
  moveLora,
  toggleMuteLora,
  addDetailerBlock,
  removeDetailerBlock,
  moveDetailerBlock,
  isBuiltinDetailerBlock,
  preferredNameDefault,
  UNET_NAME_CANDIDATES,
  CLIP_NAME_CANDIDATES,
  VAE_NAME_CANDIDATES,
} from "./state.mjs";

import {
  injectStyles,
  buildStatusRow,
  buildClickRow,
  buildSwitch,
  buildGear,
  sectionLabel,
  buildField,
  buildDrivenField,
  buildSublabel,
  buildNote,
  buildMissing,
  buildPopoverShell,
  buildWipeLayer,
  measureMinHeight,
  refitNode,
  scheduleRefit,
  scheduleInitialFit,
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
export function getLoaderWidgets(node) {
  const find = (name) => (node.widgets || []).find((w) => w.name === name);
  return {
    useInternal: find("use_internal_loaders"),
    unetName: find("unet_name"),
    clipName: find("clip_name"),
    clipType: find("clip_type"),
    vaeName: find("vae_name"),
  };
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
 * write the fully-expanded tree straight back — see this module's doc
 * comment and the frontend skill's "declaring is not writing" trap. Safe to
 * call repeatedly; always re-normalizes from the widget's CURRENT value
 * rather than trusting a cached copy, so it doubles as `restoreGenState`. */
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
// Wired-socket detection (design doc §5a "per-field wired-wins" / §3
// resource sockets). Derived from the LIVE node, refreshed on
// `onConnectionsChange` -- never cached beyond one repaint.
// ---------------------------------------------------------------------------

export function isInputWired(node, name) {
  const inputs = node.inputs || [];
  const input = inputs.find((i) => i && i.name === name);
  return !!(input && input.link != null);
}

export function computeWiredFlags(node) {
  const flags = {};
  for (const name of ["model", "clip", "vae", "latent", ...SAMPLER_FIELDS]) {
    flags[name] = isInputWired(node, name);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Small path helpers for the generic popover field wiring.
// ---------------------------------------------------------------------------

function getPath(obj, path) {
  return path.reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}
function setPath(obj, path, value) {
  let target = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    target = target[path[i]];
  }
  target[path[path.length - 1]] = value;
}

function coerce(kind, rawValue) {
  if (kind === "number") {
    const n = parseFloat(rawValue);
    return Number.isFinite(n) ? n : 0;
  }
  if (kind === "int") {
    const n = parseInt(rawValue, 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (kind === "bool") {
    return rawValue === "true" || rawValue === true;
  }
  return rawValue;
}

/** Builds one settings-tree-bound field (see `render.mjs`'s `buildField`)
 * and wires its `change` -> `setPath` + `onCommit`. `spec` is
 * `{ path:[...], label, kind:"text"|"number"|"int"|"bool"|"select", options }`. */
function fieldFor(doc, root, spec, onCommit) {
  const value = getPath(root, spec.path);
  const displayValue = spec.kind === "bool" ? (value ? "true" : "false") : value;
  const options = spec.kind === "bool" ? ["true", "false"] : spec.options;
  const { root: fieldEl, control } = buildField(doc, spec.label, displayValue, options);
  control.addEventListener("change", () => {
    setPath(root, spec.path, coerce(spec.kind, control.value));
    onCommit();
  });
  return fieldEl;
}

function appendFields(doc, container, root, specs, onCommit) {
  specs.forEach((spec) => container.appendChild(fieldFor(doc, root, spec, onCommit)));
}

/** A wired sampler field's popover row (design doc §5a): renders as
 * `render.mjs`'s `buildDrivenField` (never an editable input the wire would
 * silently override) and, clicking it, actually disconnects the real
 * litegraph link -- `node.disconnectInput` is litegraph's own API; this is
 * a no-op if the node stub doesn't provide it (e.g. this module's own
 * tests, which assert on the call happening rather than needing the real
 * method). `refresh()` re-renders the popover in place afterward, so the
 * field immediately becomes editable without closing/reopening. */
function buildUnwireField(doc, node, field, refresh) {
  const { root, control } = buildDrivenField(doc, field, field);
  control.addEventListener("click", (e) => {
    e.stopPropagation();
    const inputIndex = (node.inputs || []).findIndex((i) => i && i.name === field);
    if (inputIndex >= 0 && typeof node.disconnectInput === "function") {
      node.disconnectInput(inputIndex);
    }
    refresh();
  });
  return root;
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
 * ITS OWN content (used by the sampler/highres/upscale/detailer tabs whose
 * visible fields depend on a flag the popover itself just changed).
 * `onAnyCommit(node, ctx)` runs on EVERY commit inside the popover (persists
 * the widget) — passed in by the caller so this stays generic across the
 * Generator's `generation_settings` and the Preview's `preview_state`.
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
    // Rebuild ONLY the content below the h4 header -- never touches
    // `anchorEl`/the overlay wrapper, so this is safe to call from inside
    // an already-open popover's own field handlers.
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

// ---------------------------------------------------------------------------
// Generator body — sections
// ---------------------------------------------------------------------------

const SAMPLER_SOCKET_TYPES = { seed: "INT", steps: "INT", cfg: "FLOAT", sampler_name: "COMBO", scheduler: "COMBO" };

function buildResourcesSection(doc, node, ctx, state, wired) {
  const frag = el(doc, "div");
  frag.appendChild(sectionLabel(doc, "resources"));

  const loaders = getLoaderWidgets(node);
  const internalOn = !!(loaders.useInternal && loaders.useInternal.value);

  const internalRow = buildClickRow({
    doc, name: "use_internal_loaders", value: internalOn ? "ON" : "off",
    title: "On -> the pickers below are used and the model/clip/vae sockets are ignored.",
  });
  internalRow.root.addEventListener("click", () => {
    closeActiveOverlay();
    if (loaders.useInternal) {
      loaders.useInternal.value = !internalOn;
    }
    repaintGenerator(node, ctx);
  });
  frag.appendChild(internalRow.root);

  frag.appendChild(buildStatusRow(doc, {
    name: "model", type: "MODEL", wired: wired.model && !internalOn, ignored: internalOn,
    title: internalOn ? "Ignored -- use_internal_loaders is on" : "",
  }));
  frag.appendChild(buildStatusRow(doc, {
    name: "clip", type: "CLIP", wired: wired.clip && !internalOn, ignored: internalOn,
    title: internalOn ? "Ignored -- use_internal_loaders is on" : "",
  }));
  frag.appendChild(buildStatusRow(doc, {
    name: "vae", type: "VAE", wired: wired.vae && !internalOn, ignored: internalOn,
    title: internalOn ? "Ignored -- use_internal_loaders is on" : "",
  }));

  if (internalOn) {
    [
      ["unet_name", loaders.unetName, UNET_NAME_CANDIDATES],
      ["clip_name", loaders.clipName, CLIP_NAME_CANDIDATES],
      ["clip_type", loaders.clipType, null],
      ["vae_name", loaders.vaeName, VAE_NAME_CANDIDATES],
    ].forEach(([label, widget, candidates]) => {
      if (!widget) {
        return;
      }
      const options = (widget.options && Array.isArray(widget.options.values)) ? widget.options.values : [];
      // Self-heal an orphaned saved value (a renamed/deleted model file) --
      // NEVER fall through to `options[0]` (the `ce0528f`/`8b5eca6` bug).
      let value = widget.value;
      if (candidates && options.length && !options.includes(value)) {
        value = preferredNameDefault(options, candidates);
        widget.value = value;
      }
      const row = buildClickRow({ doc, name: label, value });
      row.root.addEventListener("click", () => openPickerListPopover(node, ctx, `picker:${label}`, row.root, widget, options));
      frag.appendChild(row.root);
    });

    const latentRow = buildClickRow({
      doc, name: "latent", value: `${state.latent.width} × ${state.latent.height}${state.latent.batch > 1 ? ` ×${state.latent.batch}` : ""}`,
    });
    latentRow.root.addEventListener("click", () => openLatentPopover(node, ctx, latentRow.root));
    frag.appendChild(latentRow.root);

    frag.appendChild(buildLoraSection(doc, node, ctx, state));
  }

  frag.appendChild(buildStatusRow(doc, {
    name: "latent", type: "LATENT", wired: wired.latent && !internalOn, ignored: internalOn,
    title: internalOn ? "Ignored -- inline mode sets size and batch itself" : "Size and batch from the wire",
  }));

  return frag;
}

function openPickerListPopover(node, ctx, key, anchorEl, widget, options) {
  openPopover({
    ctx, node, key, anchorEl, title: "Choose",
    buildContent: () => {
      const doc = ctx.doc;
      const menu = el(doc, "div", "wtn-an-grid");
      if (!options.length) {
        menu.appendChild(buildMissing(doc, "no options installed"));
        return menu;
      }
      options.forEach((opt) => {
        const optRow = buildClickRow({ doc, name: opt === widget.value ? "● " + opt : opt, value: "" });
        optRow.root.addEventListener("click", (e) => {
          e.stopPropagation();
          widget.value = opt;
          closeActiveOverlay();
        });
        menu.appendChild(optRow.root);
      });
      return menu;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

function buildLoraSection(doc, node, ctx, state) {
  const frag = el(doc, "div");
  const activeCount = state.loras.filter((l) => l.strength_model || l.strength_clip).length;
  frag.appendChild(sectionLabel(doc, "loras", `${activeCount} active`));

  if (!state.loras.length) {
    const empty = el(doc, "div", "wtn-an-lora wtn-an-empty");
    empty.textContent = "No LoRAs yet — click + Add LoRA";
    frag.appendChild(empty);
  }

  state.loras.forEach((entry, index) => {
    const muted = !(entry.strength_model || entry.strength_clip);
    const row = el(doc, "div", `wtn-an-lora${muted ? " wtn-an-muted" : ""}`);
    const mute = buildSwitch(doc, !muted, true);
    mute.title = muted ? "Unmute" : "Mute (both strengths to 0)";
    mute.addEventListener("click", (e) => {
      e.stopPropagation();
      closeActiveOverlay();
      toggleMuteLora(entry);
      persistGenState(node);
      repaintGenerator(node, ctx);
    });
    const name = el(doc, "span", "wtn-an-ln");
    name.textContent = entry.name || "(unnamed)";
    name.title = entry.name || "";
    const val = el(doc, "span", "wtn-an-lv");
    val.textContent = Number(entry.strength_model || 0).toFixed(2);
    const gear = buildGear(doc, "LoRA settings");
    gear.addEventListener("click", (e) => {
      e.stopPropagation();
      openLoraItemPopover(node, ctx, index, row);
    });
    row.appendChild(mute);
    row.appendChild(name);
    row.appendChild(val);
    row.appendChild(gear);
    frag.appendChild(row);
  });

  const addBtn = el(doc, "button", "wtn-an-addbtn");
  addBtn.type = "button";
  addBtn.textContent = "+ Add LoRA";
  addBtn.addEventListener("click", () => {
    closeActiveOverlay();
    addLora(state.loras);
    persistGenState(node);
    repaintGenerator(node, ctx);
  });
  frag.appendChild(addBtn);
  return frag;
}

function openLoraItemPopover(node, ctx, index, anchorEl) {
  const key = `lora:${index}`;
  openPopover({
    ctx, node, key, anchorEl, title: "LoRA",
    buildContent: (refresh) => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const entry = state.loras[index];
      if (!entry) {
        return buildMissing(doc, "removed");
      }
      const box = el(doc, "div", "wtn-an-grid");
      box.appendChild(fieldFor(doc, entry, { path: ["name"], label: "name", kind: "text" }, () => {
        persistGenState(node);
      }));
      box.appendChild(fieldFor(doc, entry, { path: ["strength_model"], label: "strength_model", kind: "number" }, () => {
        persistGenState(node);
      }));
      box.appendChild(fieldFor(doc, entry, { path: ["strength_clip"], label: "strength_clip", kind: "number" }, () => {
        persistGenState(node);
      }));

      const passtabs = el(doc, "div", "wtn-an-passtabs");
      const up = el(doc, "button");
      up.type = "button";
      up.textContent = "▲ move up";
      up.disabled = index === 0;
      up.addEventListener("click", (e) => {
        e.stopPropagation();
        moveLora(state.loras, index, -1);
        persistGenState(node);
        closeActiveOverlay();
        repaintGenerator(node, ctx);
      });
      const down = el(doc, "button");
      down.type = "button";
      down.textContent = "▼ move down";
      down.disabled = index === state.loras.length - 1;
      down.addEventListener("click", (e) => {
        e.stopPropagation();
        moveLora(state.loras, index, 1);
        persistGenState(node);
        closeActiveOverlay();
        repaintGenerator(node, ctx);
      });
      passtabs.appendChild(up);
      passtabs.appendChild(down);
      box.appendChild(passtabs);

      const foot = el(doc, "div", "wtn-an-popfoot");
      const remove = el(doc, "button", "wtn-an-pbtn wtn-an-danger");
      remove.type = "button";
      remove.textContent = "Remove LoRA";
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        removeLora(state.loras, index);
        persistGenState(node);
        closeActiveOverlay();
        repaintGenerator(node, ctx);
      });
      foot.appendChild(remove);
      box.appendChild(foot);
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

function openLatentPopover(node, ctx, anchorEl) {
  openPopover({
    ctx, node, key: "latent", anchorEl, title: "Empty latent",
    buildContent: () => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const box = el(doc, "div", "wtn-an-grid");
      appendFields(doc, box, state.latent, [
        { path: ["width"], label: "width", kind: "int" },
        { path: ["height"], label: "height", kind: "int" },
        { path: ["batch"], label: "batch", kind: "int" },
      ], () => {
        persistGenState(node);
      });
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

// ---------------------------------------------------------------------------
// Sampler section (first-pass sockets + summary rows + Mod Guidance)
// ---------------------------------------------------------------------------

function buildSamplerSection(doc, node, ctx, state, wired) {
  const frag = el(doc, "div");
  frag.appendChild(sectionLabel(doc, "sampler", "first pass"));

  SAMPLER_FIELDS.forEach((field) => {
    frag.appendChild(buildStatusRow(doc, {
      name: field, type: SAMPLER_SOCKET_TYPES[field], wired: wired[field],
      title: wired[field] ? "Wired -- this wire drives the value" : "Unwired -- the settings value is used",
    }));
  });

  const sampler = state.sampler;
  const summary = buildClickRow({
    doc, name: `${wired.sampler_name ? "—" : sampler.sampler_name} / ${wired.scheduler ? "—" : sampler.scheduler}`,
    value: `${wired.steps ? "—" : sampler.steps} steps · cfg ${wired.cfg ? "—" : Number(sampler.cfg).toFixed(1)}`,
  });
  summary.root.addEventListener("click", () => openSamplerPopover(node, ctx, summary.root));
  frag.appendChild(summary.root);

  const seedRow = buildClickRow({
    doc, name: "seed",
    value: wired.seed ? "from wire" : (sampler.seed === -1 ? "-1 (random)" : String(sampler.seed)),
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
    buildContent: (refresh) => {
      const doc = ctx.doc;
      const state = node._anGenState;
      const sampler = state.sampler;
      const wired = computeWiredFlags(node);

      const box = el(doc, "div");
      box.appendChild(buildNote(doc, "Wired wins, per field. Each socket that's connected drives its own field; the rest come from here."));

      SAMPLER_FIELDS.forEach((field) => {
        if (wired[field]) {
          box.appendChild(buildUnwireField(doc, node, field, refresh));
        } else if (field === "sampler_name") {
          box.appendChild(fieldFor(doc, sampler, { path: ["sampler_name"], label: "sampler_name", kind: "select", options: SAMPLERS }, () => persistGenState(node)));
        } else if (field === "scheduler") {
          box.appendChild(fieldFor(doc, sampler, { path: ["scheduler"], label: "scheduler", kind: "select", options: SCHEDULERS }, () => persistGenState(node)));
        } else if (field === "cfg") {
          box.appendChild(fieldFor(doc, sampler, { path: ["cfg"], label: "cfg", kind: "number" }, () => persistGenState(node)));
        } else if (field === "steps") {
          box.appendChild(fieldFor(doc, sampler, { path: ["steps"], label: "steps", kind: "int" }, () => persistGenState(node)));
        } else if (field === "seed") {
          box.appendChild(fieldFor(doc, sampler, { path: ["seed"], label: "seed", kind: "int" }, () => persistGenState(node)));
        }
      });

      box.appendChild(fieldFor(doc, sampler, { path: ["denoise"], label: "denoise", kind: "number" }, () => persistGenState(node)));
      box.appendChild(fieldFor(doc, sampler, { path: ["shift"], label: "shift", kind: "number" }, () => persistGenState(node)));
      box.appendChild(buildNote(doc, "shift 3.0 is Anima's recommended default and is always applied. Later stages inherit these unless their own inherit_sampler_settings is off."));
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

const SAMPLERS = ["euler", "euler_ancestral", "er_sde", "dpmpp_2m", "heun", "ddim"];
const SCHEDULERS = ["simple", "sgm_uniform", "karras", "normal", "beta", "exponential"];

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
      const box = el(doc, "div", "wtn-an-grid");
      appendFields(doc, box, mg, [
        { path: ["enabled"], label: "enabled", kind: "bool" },
        { path: ["profile"], label: "profile", kind: "select", options: ["step_i8_skip27", "step_i14", "uniform_w3"] },
        { path: ["mod_w"], label: "mod_w", kind: "number" },
        { path: ["mod_start_layer"], label: "mod_start_layer", kind: "int" },
        { path: ["mod_end_layer"], label: "mod_end_layer", kind: "int" },
      ], () => {
        persistGenState(node);
        refresh();
      });
      box.appendChild(buildSublabel(doc, "quality tags"));
      appendFields(doc, box, mg, [
        { path: ["quality_tags"], label: "positive", kind: "text" },
        { path: ["quality_neg"], label: "negative", kind: "text" },
      ], () => persistGenState(node));
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

  const inheritField = el(doc, "div", "wtn-an-field");
  const label = el(doc, "span");
  label.textContent = "inherit";
  const toggle = el(doc, "span", "wtn-an-driven");
  toggle.textContent = inherit ? "on · cfg/sampler/scheduler from the first pass" : "off · this stage picks its own";
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    stageSettings.inherit_sampler_settings = !inherit;
    onCommit();
    refresh();
  });
  inheritField.appendChild(label);
  inheritField.appendChild(toggle);
  container.appendChild(inheritField);

  const grid = el(doc, "div", "wtn-an-grid");
  grid.appendChild(fieldFor(doc, stageSettings, { path: ["steps"], label: "steps", kind: "int" }, onCommit));
  grid.appendChild(fieldFor(doc, stageSettings, { path: ["denoise"], label: "denoise", kind: "number" }, onCommit));
  if (!inherit) {
    grid.appendChild(fieldFor(doc, stageSettings, { path: ["cfg"], label: "cfg", kind: "number" }, onCommit));
    grid.appendChild(fieldFor(doc, stageSettings, { path: ["sampler_name"], label: "sampler_name", kind: "select", options: SAMPLERS }, onCommit));
    grid.appendChild(fieldFor(doc, stageSettings, { path: ["scheduler"], label: "scheduler", kind: "select", options: SCHEDULERS }, onCommit));
  }
  container.appendChild(grid);

  if (inherit) {
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
      const grid = el(doc, "div", "wtn-an-grid");
      appendFields(doc, grid, h, [
        { path: ["scale_by"], label: "scale_by", kind: "number" },
        { path: ["upscale_method"], label: "upscale_method", kind: "select", options: ["bicubic", "bilinear", "nearest-exact", "area"] },
        { path: ["multiple"], label: "multiple", kind: "text" },
        { path: ["max_long_edge"], label: "max_long_edge", kind: "int" },
      ], () => persistGenState(node));
      box.appendChild(grid);
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
      const grid = el(doc, "div", "wtn-an-grid");
      appendFields(doc, grid, u, [
        { path: ["scale_by"], label: "scale_by", kind: "number" },
      ], () => persistGenState(node));
      appendFields(doc, grid, u.usdu, [
        { path: ["upscale_model_name"], label: "upscale_model", kind: "text" },
        { path: ["mode_type"], label: "mode_type", kind: "select", options: ["Linear", "Chess", "None"] },
        { path: ["seam_fix_mode"], label: "seam_fix_mode", kind: "select", options: ["None", "Band Pass", "Half Tile", "Half Tile + Intersections"] },
        { path: ["seam_fix_denoise"], label: "seam_fix_denoise", kind: "number" },
      ], () => persistGenState(node));
      box.appendChild(grid);
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
      const box = el(doc, "div");
      box.appendChild(buildNote(doc, "The output size cap."));
      const grid = el(doc, "div", "wtn-an-grid");
      appendFields(doc, grid, state.postprocess.fit, [
        { path: ["mode"], label: "mode", kind: "select", options: ["max_long_edge", "megapixels"] },
        { path: ["method"], label: "method", kind: "select", options: ["bicubic", "bilinear", "area"] },
        { path: ["max_long_edge"], label: "max_long_edge", kind: "int" },
        { path: ["max_megapixels"], label: "max_megapixels", kind: "number" },
      ], () => persistGenState(node));
      box.appendChild(grid);
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

      const grid = el(doc, "div", "wtn-an-grid");
      appendFields(doc, grid, block, [
        { path: ["label"], label: "label", kind: "text" },
        { path: ["detect_prompt"], label: "detect_prompt", kind: "text" },
        { path: ["detect_count"], label: "detect_count", kind: "int" },
        { path: ["threshold"], label: "threshold", kind: "number" },
      ], () => {
        persistGenState(node);
        refresh();
      });
      box.appendChild(grid);

      box.appendChild(buildSublabel(doc, "refine"));
      const refineGrid = el(doc, "div", "wtn-an-grid");
      appendFields(doc, refineGrid, block, [
        { path: ["feather"], label: "feather", kind: "int" },
        { path: ["guide_size"], label: "guide_size", kind: "int" },
        { path: ["max_size"], label: "max_size", kind: "int" },
        { path: ["crop_factor"], label: "crop_factor", kind: "number" },
        { path: ["cycle"], label: "cycle", kind: "int" },
        { path: ["guide_size_for"], label: "guide_size_for", kind: "bool" },
        { path: ["noise_mask_feather"], label: "noise_mask_feather", kind: "int" },
      ], () => persistGenState(node));
      box.appendChild(refineGrid);
      box.appendChild(buildNote(doc, "Do not \"fix\" these -- guide_size_for must be false and noise_mask_feather must not be 0.", true));

      appendStageSamplerFields(doc, box, block, state.sampler, () => persistGenState(node), refresh);
      return box;
    },
    onClosed: () => repaintGenerator(node, ctx),
  });
}

// ---------------------------------------------------------------------------
// Outputs section (status rows -- always "wired" since these are real
// outputs; shows which real pass each carries right now via resolve_outputs).
// ---------------------------------------------------------------------------

function buildOutputsSection(doc, node, ctx, state) {
  const have = ctx.havePackages ? ctx.havePackages() : { spectrum: true, usdu: true, impact: true };
  const frag = el(doc, "div");
  frag.appendChild(sectionLabel(doc, "outputs"));
  const outputs = resolveOutputs({
    highresEnabled: state.highres.enabled,
    detailerEnabled: state.detailer.enabled,
    haveImpact: have.impact,
    blocks: state.detailer.blocks,
    upscaleEnabled: state.upscale.enabled,
    haveUsdu: have.usdu,
  });
  [
    ["image", "IMAGE", outputs.image],
    ["image_base", "IMAGE", outputs.image_base],
    ["image_mid", "IMAGE", outputs.image_mid],
    ["latent", "LATENT", null],
    ["metadata_json", "STRING", null],
  ].forEach(([name, type, carries]) => {
    frag.appendChild(buildStatusRow(doc, { name, type, wired: true, title: carries ? `carries: ${carries}` : "" }));
  });
  return frag;
}

// ---------------------------------------------------------------------------
// Generator body root + mount/repaint
// ---------------------------------------------------------------------------

export function buildGeneratorBody(doc, node, ctx) {
  const state = node._anGenState;
  const wired = computeWiredFlags(node);
  const body = el(doc, "div", "wtn-an-body");
  body.appendChild(sectionLabel(doc, "conditioning"));
  body.appendChild(buildStatusRow(doc, { name: "positive", type: "COND", wired: true }));
  body.appendChild(buildStatusRow(doc, { name: "negative", type: "COND", wired: true }));
  body.appendChild(buildResourcesSection(doc, node, ctx, state, wired));
  body.appendChild(buildSamplerSection(doc, node, ctx, state, wired));
  body.appendChild(buildStagesSection(doc, node, ctx, state));
  body.appendChild(buildOutputsSection(doc, node, ctx, state));
  return body;
}

export function mountGeneratorUI(node, ctx) {
  if (node._anRefs) {
    return node._anRefs;
  }
  const doc = ctx.doc;
  injectStyles(doc);
  const root = el(doc, "div", "wtn-an-root wtn");
  ensureGenState(node);
  const body = buildGeneratorBody(doc, node, ctx);
  root.appendChild(body);
  const refs = { doc, root, body };
  node._anRefs = refs;
  return refs;
}

export function repaintGenerator(node, ctx) {
  const refs = mountGeneratorUI(node, ctx);
  const newBody = buildGeneratorBody(refs.doc, node, ctx);
  if (refs.body && refs.body.parentNode) {
    refs.body.parentNode.removeChild(refs.body);
  }
  refs.root.appendChild(newBody);
  refs.body = newBody;
  if (node.setDirtyCanvas) {
    node.setDirtyCanvas(true, true);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Preview node
// ---------------------------------------------------------------------------

const SLOT_TO_SOCKET = { base: "image_a", mid: "image_b", final: "image_c" };

function previewShownStages(node) {
  const wired = {
    image_a: node.inputs && node.inputs.find((i) => i.name === "image_a" && i.link != null),
    image_b: node.inputs && node.inputs.find((i) => i.name === "image_b" && i.link != null),
    image_c: node.inputs && node.inputs.find((i) => i.name === "image_c" && i.link != null),
  };
  return {
    base: !!wired.image_a,
    mid: !!wired.image_b,
    final: !!wired.image_c,
  };
}

export function buildPreviewBody(doc, node, ctx) {
  const state = node._anPreviewState;
  const shown = previewShownStages(node);
  // `node._anPreviewImages`, keyed by stage, set by `handleExecuted` from
  // this node's own `onExecuted` payload (`nodes/anima/preview.py`'s
  // `"ui": {"images": [...]}}`, each entry carrying a `stage` key) --
  // ABSENT until the first run, which is legitimate (pre-run, every layer
  // below just renders empty).
  const previewImages = node._anPreviewImages || {};
  const body = el(doc, "div", "wtn-an-body");

  body.appendChild(buildStatusRow(doc, { name: "image_a", type: "IMAGE", wired: shown.base }));
  body.appendChild(buildStatusRow(doc, { name: "image_b", type: "IMAGE", wired: shown.mid }));
  body.appendChild(buildStatusRow(doc, { name: "image_c", type: "IMAGE", wired: shown.final }));

  const compare = state.compare;
  const wantsDual = !!compare.enabled;
  const haveA = shown[compare.a];
  const haveB = shown[compare.b];
  // Dual-pane wipe only when BOTH named stages are actually wired. A
  // selected `compare.a`/`compare.b` that ISN'T wired can't render its own
  // pane -- degrade to the SAME single-image branch the "compare off" case
  // already uses (below) rather than a broken pane with one permanently
  // blank layer.
  const dualPane = wantsDual && haveA && haveB;
  const wipe = el(doc, "div", `wtn-an-wipe${dualPane ? "" : " wtn-an-single"}`);
  wipe.style.setProperty("--wipe-x", "50%");

  if (!haveA && !haveB) {
    const empty = el(doc, "div", "wtn-an-empty");
    empty.textContent = "nothing wired yet";
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
    // Single-pane: compare off BY CHOICE, or degraded because one of the two
    // named stages isn't wired -- either way, show whichever side actually
    // resolves (prefer `compare.b`, the "current result" side; `haveA ||
    // haveB` is true here, so exactly one of these two branches applies when
    // only one is wired, and `compare.b` wins the tie when both are).
    const soloStage = haveB ? compare.b : compare.a;
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
  const label = el(doc, "span");
  label.textContent = "compare";
  pvbar.appendChild(sw);
  pvbar.appendChild(label);
  body.appendChild(pvbar);

  const saveRow = buildClickRow({
    doc, name: "save",
    value: state.save.enabled ? `${state.save.which} · ${state.save.extension}` : "off",
  });
  saveRow.root.addEventListener("click", () => openSavePopover(node, ctx, saveRow.root));
  body.appendChild(saveRow.root);

  if (wantsDual) {
    const segRow = el(doc, "div", "wtn-an-pvbar");
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
    segRow.appendChild(segA);
    segRow.appendChild(vs);
    segRow.appendChild(segB);
    body.appendChild(segRow);
  }

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
      const grid = el(doc, "div", "wtn-an-grid");
      appendFields(doc, grid, save, [
        { path: ["enabled"], label: "enabled", kind: "bool" },
        { path: ["which"], label: "which", kind: "select", options: SAVE_WHICH_OPTIONS },
        { path: ["extension"], label: "extension", kind: "select", options: ["png", "jpg", "webp"] },
        { path: ["path"], label: "path", kind: "text" },
        { path: ["filename"], label: "filename", kind: "text" },
        { path: ["embed_workflow"], label: "embed workflow", kind: "bool" },
      ], () => {
        persistPreviewState(node);
        refresh();
      });
      box.appendChild(grid);
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
  const root = el(doc, "div", "wtn-an-root wtn");
  ensurePreviewState(node);
  const { body, wipeEl } = buildPreviewBody(doc, node, ctx);
  root.appendChild(body);
  const refs = { doc, root, body, wipeEl };
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
  refs.root.appendChild(body);
  refs.body = body;
  refs.wipeEl = wipeEl;
  wireWipe(node, ctx, refs);
  if (node.setDirtyCanvas) {
    node.setDirtyCanvas(true, true);
  }
  return refs;
}

/**
 * `AnimaPreview`'s `onExecuted` handler -- `index.js` installs the actual
 * litegraph `onExecuted` hook (it's a node-instance/server-message hook, not
 * a `window`/`app`/`LiteGraph` global reference, so it's fine to call
 * straight into this module the same way `onConnectionsChange` already
 * does) and forwards `message` here unchanged. `message.images` is
 * `nodes/anima/preview.py`'s own `"ui": {"images": [...]}}` payload -- see
 * `_preview_helpers.build_preview_ui_images`'s docstring for the exact
 * shape: `{filename, subfolder, type, stage}` per entry, `type` `"output"`
 * or `"temp"`, ALWAYS one entry per wired stage regardless of `save.
 * enabled` (design doc §7/§7a's fix -- this is the frontend half of it).
 *
 * VERIFY-IN-COMFYUI: that `onExecuted`'s `message` argument really is the
 * node's own `ui` dict verbatim (i.e. `message.images` reaches here, not
 * `message.ui.images` or some other wrapping) -- this pack has no live
 * ComfyUI process to confirm against; the shape matches every other node in
 * this repo's `../ComfyUI-Pixaroma` sibling that reads `message.<key>`
 * straight off `onExecuted` (`js/find_replace/index.js`'s
 * `message?.pixaroma_find_replace?.[0]`), and stock `SaveImage`/
 * `PreviewImage` are widely documented to work the same way, but neither is
 * a substitute for confirming live.
 */
export function handleExecuted(node, ctx, message) {
  if (!message || !Array.isArray(message.images)) {
    return;
  }
  // ONE cache-bust token per `executed` message, shared by every stage from
  // THIS run -- see `buildPreviewImageUrl`'s doc comment in render.mjs for
  // why a run-stable (not per-stage-random) value is what's needed here.
  const cacheBust = Date.now();
  const byStage = {};
  for (const entry of message.images) {
    // Map by STAGE, never by array position -- `build_preview_ui_images`
    // orders entries by its own preview-stage order, not a fixed schema, and
    // a batch > 1 stage can carry more than one entry (the FIRST one seen
    // wins; the wipe only ever shows one image per pane).
    if (entry && typeof entry.stage === "string" && !(entry.stage in byStage)) {
      byStage[entry.stage] = { ...entry, _cacheBust: cacheBust };
    }
  }
  node._anPreviewImages = byStage;
  // No `_anMods` check needed here -- `index.js` only ever reaches this
  // function THROUGH `this._anMods.interaction.handleExecuted(...)`, so
  // `_anMods` being truthy is already guaranteed by the caller; testing it
  // again here would just make this function harder to call directly (as
  // this pack's own `test_resize.mjs` does). `mountPreviewUI` is idempotent
  // (returns the cached `node._anRefs` if already mounted, mounts fresh
  // otherwise), so this always ends up painting the stashed image data
  // somewhere, never silently drops it.
  repaintPreview(node, ctx);
}

/** The hover wipe -- design doc §7. `pointermove` with NO button gate is
 * what makes it hover rather than drag; upstream's own comment
 * (`generator_panel_runtime.js:811-816`) is the same shape.
 * `event.stopPropagation()` on both handlers is load-bearing, or litegraph
 * steals the gesture and the divider never moves. */
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
// Wheel-zoom passthrough + teardown (both node types)
// ---------------------------------------------------------------------------

export function installZoomPassthrough(node, ctx) {
  const refs = node._anRefs;
  if (!refs || refs.zoomUninstall) {
    return;
  }
  refs.zoomUninstall = installCanvasZoomPassthrough(refs.root, ctx.getCanvasEl);
}

export function teardownNode(node) {
  closeActiveOverlay();
  const refs = node._anRefs;
  if (refs && refs.zoomUninstall) {
    refs.zoomUninstall();
    refs.zoomUninstall = null;
  }
}

// ---------------------------------------------------------------------------
// Resize wrappers (legacy litegraph primary; see render.mjs's re-exports).
// ---------------------------------------------------------------------------

export { measureMinHeight, refitNode, scheduleRefit, scheduleInitialFit, DEFAULT_H, PREVIEW_DEFAULT_H };
export { closeActiveOverlay };
