/**
 * index.js — the ONLY auto-loaded `.js` for the Anima track (`.claude/
 * CLAUDE.md`'s JS download budget: this one file registers BOTH
 * `AnimaGenerator` and `AnimaPreview`). This is the file that takes the JS
 * download budget from 4 to 5 — see `.claude/CLAUDE.md`'s own note
 * predicting exactly this.
 *
 * Absolute `/scripts/app.js` import (this file is nested in `js/anima/` —
 * the frontend skill's gotcha #1: a relative `../../scripts/app.js`
 * resolves wrong from a subfolder and silently kills the whole extension).
 * That's the ONLY static import in this file, deliberately.
 *
 * ## `state.mjs`/`render.mjs`/`interaction.mjs` are LAZY, not static
 *
 * `beforeRegisterNodeDef` runs for EVERY node type on EVERY ComfyUI page at
 * startup, whether or not the user ever places one of these two nodes. A
 * static top-level `import` of the three sibling modules here would mean
 * every page pays for fetching+evaluating the whole settings/DOM/CSS/event
 * stack the moment this ONE already-auto-loaded file runs — exactly the
 * "shipped to users who don't need it" cost the JS download budget exists to
 * avoid. So `loadMods()` below only ever runs a guarded dynamic `import()`
 * (cached after the first call, since both node classes share it) the FIRST
 * TIME an actual node INSTANCE of either class is created or restored
 * (`onNodeCreated`/`onConfigure`) — a page with neither node anywhere never
 * fetches them at all. Matches `js/controls/index.js`'s `loadMods` exactly,
 * same reasoning, same trick of costing two node classes one auto-loaded
 * file.
 *
 * ## Widget contract (matches `nodes/anima/*.py`'s declared STRING widgets)
 *
 * `AnimaGenerator.generation_settings` and `AnimaPreview.preview_state` are
 * each hidden for RENDERING only (never `serialize = false` — they must
 * keep reaching the backend) and mirrored from `node._anGenState`/
 * `node._anPreviewState` after every mutation (`interaction.mjs`'s
 * `persistGenState`/`persistPreviewState`). `AnimaGenerator`'s
 * `use_internal_loaders`/`unet_name`/`clip_name`/`clip_type`/`vae_name` are
 * ALSO hidden-and-mirrored (they're real Python-declared widgets carrying
 * real values, not settings-blob data — see `interaction.mjs`'s
 * `getLoaderWidgets` doc comment for why they need the same treatment as
 * `js/prompt_rules/node/index.js`'s `profile` combo).
 */
import { app } from "/scripts/app.js";

const NODE_CLASS_NAMES = ["AnimaGenerator", "AnimaPreview"];

// The three settings-blob-only STRING widgets, hidden-for-rendering-only on
// EVERY node instance (both classes carry `generation_settings`/
// `preview_state`? No -- each carries only its own; `find` below is a no-op
// for the one that doesn't apply). The four internal-loader widgets are
// Generator-only.
const HIDDEN_STATE_WIDGETS = ["generation_settings", "preview_state"];
const HIDDEN_LOADER_WIDGETS = ["use_internal_loaders", "unet_name", "clip_name", "clip_type", "vae_name"];

// ---------------------------------------------------------------------------
// Lazy module loading -- see this file's top doc comment.
// ---------------------------------------------------------------------------

let _modsPromise = null;
function loadMods() {
  if (!_modsPromise) {
    _modsPromise = Promise.all([
      import("./state.mjs"),
      import("./render.mjs"),
      import("./interaction.mjs"),
    ]).then(([state, render, interaction]) => ({ state, render, interaction }));
  }
  return _modsPromise;
}

/** Hide a declared widget from RENDERING only -- it keeps serializing
 * normally (the frontend skill's "hide a declared widget that must still
 * serialize" pattern; matches `js/controls/index.js`'s `hideStateWidget`).
 * Never `w.serialize = false` here. */
function hideWidget(w) {
  if (!w) {
    return;
  }
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (w.inputEl && w.inputEl.style) {
    w.inputEl.style.display = "none";
  }
}

function hideNativeWidgets(node) {
  [...HIDDEN_STATE_WIDGETS, ...HIDDEN_LOADER_WIDGETS].forEach((name) => {
    hideWidget((node.widgets || []).find((w) => w.name === name));
  });
}

// ---------------------------------------------------------------------------
// Soft-import presence -- mirrors `src/anima/soft_imports.py`'s
// `has_mod_guidance`/`has_usdu`/`has_impact_detailer`, read from the live
// LiteGraph node-type registry the same way `js/controls/index.js`'s
// `readKnownLists` reads combo option lists: this is the ONE place this
// whole feature touches `window.LiteGraph`, kept out of `interaction.mjs` so
// it stays testable with a stub.
// ---------------------------------------------------------------------------

let _haveCache = null;
let _haveCacheAt = 0;
const HAVE_CACHE_MS = 1000;

function readHavePackages() {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (_haveCache && now - _haveCacheAt < HAVE_CACHE_MS) {
    return _haveCache;
  }
  const registry = (typeof window !== "undefined" && window.LiteGraph && window.LiteGraph.registered_node_types) || {};
  const have = {
    spectrum: !!registry.AnimaModGuidance,
    usdu: !!registry.UltimateSDUpscale,
    impact: !!(registry.DetailerForEach && registry.MaskToSEGS),
  };
  _haveCache = have;
  _haveCacheAt = now;
  return have;
}

// Wheel-zooms-the-canvas fix (js/shared/canvas_zoom.mjs): the real,
// currently-live LiteGraph canvas element -- read fresh on every call, since
// the canvas can be recreated (matches js/controls/index.js's identical
// `getCanvasEl`).
function getCanvasEl() {
  return (app.canvas && app.canvas.canvas) || null;
}

function buildCtx(mods) {
  return {
    doc: typeof document !== "undefined" ? document : null,
    getCanvasEl,
    havePackages: readHavePackages,
  };
}

// ---------------------------------------------------------------------------
// Legacy litegraph sizing -- per the dynamic-node-frontend skill: this node
// has real litegraph INPUT/OUTPUT sockets (conditioning, resources, sampler
// fields, three image outputs, ...), so `node.widgets_start_y` is left at
// its default (unlike js/controls/, this node's sockets AREN'T parked on
// per-row DOM widgets — see render.mjs's top doc comment) and the DOM
// widget just occupies the body below them, sized via `getMinHeight`
// (legacy, PRIMARY) / `computeLayoutSize` (Nodes 2.0, forward-compat only).
// ---------------------------------------------------------------------------

function mountNode(node, mods, isGenerator) {
  if (node._anMounted) {
    return;
  }
  node._anMounted = true;
  const ctx = buildCtx(mods);
  node._anCtx = ctx;
  node._anMods = mods;

  hideNativeWidgets(node);

  const refs = isGenerator ? mods.interaction.mountGeneratorUI(node, ctx) : mods.interaction.mountPreviewUI(node, ctx);
  mods.interaction.installZoomPassthrough(node, ctx);

  let widget;
  if (typeof node.addDOMWidget === "function") {
    widget = node.addDOMWidget(
      isGenerator ? "anima_generator_ui" : "anima_preview_ui",
      isGenerator ? "anima_generator_ui" : "anima_preview_ui",
      refs.root,
      {
        serialize: false,
        // Legacy canvas renderer sizing path (PRIMARY) -- NOT computeSize/
        // getHeight (those fight node.setSize under the legacy renderer).
        getMinHeight: () => mods.render.measureMinHeight(refs.root),
      },
    );
  } else {
    // Defensive fallback for a host without addDOMWidget; shouldn't occur
    // in ComfyUI's actual runtime.
    widget = { name: "anima_ui", type: "anima_ui", element: refs.root };
    node.widgets = node.widgets || [];
    node.widgets.push(widget);
  }
  widget.serialize = false;
  if (widget.options) {
    widget.options.serialize = false;
  }
  // Nodes 2.0 (Vue/DOM renderer) sizing path -- forward-compat only.
  widget.computeLayoutSize = function () {
    return { minHeight: mods.render.measureMinHeight(refs.root), minWidth: 1 };
  };
  refs.widget = widget;

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

function setupNode(node, mods, isGenerator) {
  mountNode(node, mods, isGenerator);
  const refs = node._anRefs;
  const defaultH = isGenerator ? mods.render.DEFAULT_H : mods.render.PREVIEW_DEFAULT_H;
  // Floor a freshly-created node's size UP (never down) before the guarded
  // initial fit -- mirrors `js/prompt_rules/node/index.js`'s
  // `ensureInitialFloor`.
  const curW = Array.isArray(node.size) && typeof node.size[0] === "number" ? node.size[0] : 0;
  const curH = Array.isArray(node.size) && typeof node.size[1] === "number" ? node.size[1] : 0;
  const w = Math.max(curW, mods.render.DEFAULT_W);
  const h = Math.max(curH, defaultH);
  if (w !== curW || h !== curH) {
    if (typeof node.setSize === "function") {
      node.setSize([w, h]);
    } else if (Array.isArray(node.size)) {
      node.size[0] = w;
      node.size[1] = h;
    }
  }
  // GUARDED initial fit -- a no-op if this node turns out to be loading from
  // a saved workflow (see render.mjs's `scheduleInitialFit` doc comment).
  mods.render.scheduleInitialFit(node, refs.root, "_anConfigured", defaultH);
}

function restoreNode(node, mods, isGenerator) {
  mountNode(node, mods, isGenerator);
  // Deliberately NO scheduleRefit/fitNode here -- trust the size litegraph
  // already restored from the saved workflow (never resize/rewrite on
  // load — a clean workflow must not open "modified").
}

app.registerExtension({
  name: "webtoon.anima",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_CLASS_NAMES.includes(nodeData.name)) {
      return;
    }
    if (nodeType.prototype._wtnAnimaPatched) {
      return; // hot-reload guard
    }
    nodeType.prototype._wtnAnimaPatched = true;
    const isGenerator = nodeData.name === "AnimaGenerator";

    const _created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = _created ? _created.apply(this, args) : undefined;
      const node = this;
      loadMods()
        .then((mods) => setupNode(node, mods, isGenerator))
        .catch((err) => {
          console.error("[AnimaFlow Anima] failed to load js/anima modules:", err);
        });
      return result;
    };

    const _configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      // Set BEFORE anything else (including the async mods load) -- the
      // still-pending initial-fit rAF queued back in onNodeCreated must see
      // this flag by the time it fires (mirrors js/controls/index.js's
      // `_ctrlConfiguring` / js/prompt_rules/node's `_prConfigured`).
      this._anConfigured = true;
      const result = _configure ? _configure.apply(this, args) : undefined;
      const node = this;
      loadMods()
        .then((mods) => restoreNode(node, mods, isGenerator))
        .catch((err) => {
          console.error("[AnimaFlow Anima] failed to load js/anima modules:", err);
        });
      return result;
    };

    // Refresh the sampler-socket "wired" badges (design doc §5a) / the
    // Preview node's image_a/b/c "shown" badges the instant a link is made
    // or broken -- gated on `!_anConfiguring`-equivalent isn't needed here
    // (unlike Controls' auto-row-kind resolution, refreshing a read-only
    // badge on a workflow's own link replay is harmless and correct).
    const _conn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = _conn ? _conn.apply(this, args) : undefined;
      if (this._anMods && this._anRefs) {
        if (isGenerator) {
          this._anMods.interaction.repaintGenerator(this, this._anCtx);
        } else {
          this._anMods.interaction.repaintPreview(this, this._anCtx);
        }
      }
      return result;
    };

    const _removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      if (this._anMods) {
        this._anMods.interaction.teardownNode(this);
      }
      return _removed ? _removed.apply(this, args) : undefined;
    };

    // `AnimaPreview` only -- the hover wipe's actual images (design doc §7/
    // §7a's fix: previewing must not depend on saving being on). `onExecuted`
    // is a node-instance/server-message hook, not a `window`/`app`/
    // `LiteGraph` global reference, so -- like `onConnectionsChange` above --
    // it's fine to call straight into `interaction.mjs`. If `_anMods`/
    // `_anRefs` aren't ready yet (a run finishing improbably fast, before the
    // lazy modules load), the image data is still stashed on the node by
    // `handleExecuted` and simply isn't painted until the next repaint --
    // never a crash, just a one-frame-late paint.
    if (!isGenerator) {
      const _executed = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function (message) {
        const result = _executed ? _executed.apply(this, arguments) : undefined;
        if (this._anMods) {
          this._anMods.interaction.handleExecuted(this, this._anCtx, message);
        }
        return result;
      };
    }
  },
});
