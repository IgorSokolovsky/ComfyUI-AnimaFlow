/**
 * index.js — the ONLY auto-loaded `.js` for the Anima track (`.claude/
 * CLAUDE.md`'s JS download budget: this one file registers `AnimaGenerator`
 * and `AnimaPreview` in full, plus — for socket self-healing only, see
 * below — `AnimaContextBridge`). This is the file that takes the JS
 * download budget from 4 to 5 — see `.claude/CLAUDE.md`'s own note
 * predicting exactly this; a third class sharing the same one file doesn't
 * change that count.
 *
 * Absolute `/scripts/app.js` import (this file is nested in `js/anima/` —
 * the frontend skill's gotcha #1: a relative `../../scripts/app.js`
 * resolves wrong from a subfolder and silently kills the whole extension).
 * That's the ONLY static import in this file, deliberately.
 *
 * ## Socket self-healing (why `AnimaContextBridge` is in this file at all)
 *
 * `AnimaGenerator`'s Python surface changed under it (`d021c09`, a
 * deliberate breaking change — see `nodes/anima/generator.py`'s own
 * docstring): an already-PLACED node keeps every socket its saved workflow
 * remembers AND gains whatever the CURRENT class declares, since litegraph
 * restores a node's `inputs`/`outputs` arrays verbatim from the workflow
 * file. `interaction.mjs`'s `healNodeSockets` reconciles a restored
 * instance against `nodeData` (the definition `beforeRegisterNodeDef` is
 * handed for that EXACT class, captured in THIS closure — no
 * `window.LiteGraph` registry lookup needed, unlike `js/controls/
 * index.js`'s cross-class `readKnownLists`) and runs for all three classes'
 * `onConfigure`, never `onNodeCreated` (a freshly-placed node is already
 * built correctly by ComfyUI itself). `AnimaContextBridge` has no DOM UI of
 * its own and never will just for this — `mountsUi` below still gates every
 * hook that mounts/paints one. **2026-07-28 (context-forward-repaint
 * dispatch)**: the Bridge DOES get one more hook past healing —
 * `onConnectionsChange`, forwarding to every `AnimaGenerator` downstream of
 * its own "context" output (`interaction.mjs`'s `resolveDownstreamGenerators`)
 * so THEIR "context-supplied" panel repaints when a socket is wired/unwired
 * on the Bridge itself, not just on the Generator's own `context` link. That
 * hook paints nothing on the Bridge — it only reaches into an ALREADY-
 * mounted Generator's own `_anMods`/`_anCtx` — so it doesn't need `mountsUi`
 * either, and it's installed before that gate for exactly that reason.
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
 * (cached after the first call, since all three node classes share it) the
 * FIRST TIME an actual node INSTANCE of any of them is created or restored
 * (`onNodeCreated`/`onConfigure`) — a page with none of the three anywhere
 * never fetches them at all. `AnimaContextBridge`'s own `onConfigure` only
 * ever NEEDS `healNodeSockets` off of `interaction.mjs`, but it rides the
 * same shared import as the other two rather than a separate one — see this
 * file's "Socket self-healing" section above for why that's an acceptable
 * cost, not a budget violation. Matches `js/controls/index.js`'s `loadMods`
 * exactly, same reasoning, same trick of costing multiple node classes one
 * auto-loaded file. **`../shared/graph_loading.mjs` is the one exception** —
 * see its own import comment above for why it has to be eager rather than
 * riding `loadMods()`.
 *
 * ## Widget contract (matches `nodes/anima/*.py`'s declared STRING widgets)
 *
 * `AnimaGenerator.generation_settings` and `AnimaPreview.preview_state` are
 * each hidden for RENDERING only (never `serialize = false` — they must
 * keep reaching the backend) and mirrored from `node._anGenState`/
 * `node._anPreviewState` after every mutation (`interaction.mjs`'s
 * `persistGenState`/`persistPreviewState`). **2026-07-28 (Context Bridge
 * dispatch)**: the internal-loader widgets (`use_internal_loaders`/
 * `unet_name`/`clip_name`/`clip_type`/`vae_name`) are GONE from
 * `AnimaGenerator`'s Python side along with `use_internal_loaders` mode
 * itself (`docs/generator-design.md` §3/§5) — there is nothing left to hide
 * for them here.
 */
import { app } from "/scripts/app.js";
// `isGraphLoading` -- the ONE exception to this file's "everything past
// `/scripts/app.js` is a LAZY dynamic import" rule (this file's own "lazy,
// not static" section below). It has to be a STATIC top-level import,
// deliberately: `app.loadGraphData` must be wrapped BEFORE the very first
// workflow load call happens, and by the time this pack's OWN lazy
// `loadMods()` would resolve (queued from inside `onNodeCreated`, which
// itself fires DURING that same `loadGraphData` call), that call has
// already started -- wrapping it from inside a callback triggered by its
// own execution can never retroactively flag the call already in progress.
// This module is tiny (a single monkey-patch + a getter, no DOM/CSS), so
// the download-budget cost of making it eager is negligible next to what
// making it correct requires. See `setupNode`'s own "Sizing" comment below
// for the actual bug this closes.
import { isGraphLoading } from "../shared/graph_loading.mjs";
// `isSubmitting` -- same "wrap the one funnel, hold a flag for the call plus
// a trailing window" shape as `isGraphLoading` above, for a DIFFERENT churn
// window: cg-use-everywhere (and similar extensions) materialize real
// litegraph links at submit time to build the prompt, then remove them
// again -- see `../shared/submit_guard.mjs`'s own top doc comment for the
// live trace that proved this and why it broke "post-run context-supplied
// values." Eager for the same reason `isGraphLoading` is: the wrap has to
// be in place before the FIRST queue click, not after this pack's own lazy
// `loadMods()` resolves.
import { isSubmitting } from "../shared/submit_guard.mjs";

// `AnimaContextBridge` is included ONLY for socket self-healing (see this
// file's top doc comment) -- `mountsUi` below is what actually gates every
// DOM/UI hook so the Bridge never gets `setupNode`/`restoreNode` treatment.
const CONTEXT_BRIDGE_NAME = "AnimaContextBridge";
const NODE_CLASS_NAMES = ["AnimaGenerator", "AnimaPreview", CONTEXT_BRIDGE_NAME];

// The two settings-blob-only STRING widgets, hidden-for-rendering-only on
// EVERY node instance (each class carries only its own; `find` below is a
// no-op for the one that doesn't apply).
const HIDDEN_STATE_WIDGETS = ["generation_settings", "preview_state"];

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
  HIDDEN_STATE_WIDGETS.forEach((name) => {
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

// ---------------------------------------------------------------------------
// Known model-file lists -- the SAM3 checkpoint (Detailer) and upscale model
// (Upscale) pickers, both previously hardcoded upstream defaults with no
// frontend control at all (this task's whole point). Modelled directly on
// `js/controls/index.js`'s `readKnownLists`/`NODE_DEF_SOURCE` pair: two
// ComfyUI BUILT-IN node classes' own registered combo specs are the source
// of truth for "what's actually installed," so there's no backend route to
// maintain and the lists always track whatever the live install actually
// has. `getComboOptions` itself is `js/controls/rows.mjs`'s (reused via
// `mods.interaction`'s re-export -- see that file's own doc comment for why
// THIS file never statically imports `js/controls/rows.mjs` directly: doing
// so would pull it into the JS download budget for every page, whether or
// not any Anima node is ever placed).
//
// **2026-07-28 (live sampler/scheduler lists)**: `samplers`/`schedulers` ride
// the exact same mechanism, off `KSampler`'s own registered `sampler_name`/
// `scheduler` combo spec -- the SAME pair `js/controls/rows.mjs`'s
// `NODE_DEF_SOURCE` already reads for its own sampler/scheduler picker rows,
// so the two tracks agree on what "the live sampler list" even means. This
// replaces the previously-HARDCODED six-entry `SAMPLERS`/`SCHEDULERS` arrays
// in `interaction.mjs` (versus ComfyUI's real ~30/~10) -- those arrays still
// exist there, but only as the LAST-RESORT fallback for when this registry
// lookup comes back empty (a headless test with no stub, or a `KSampler` def
// that somehow didn't register).
// ---------------------------------------------------------------------------

const MODEL_LIST_SOURCES = {
  checkpoints: { className: "CheckpointLoaderSimple", field: "ckpt_name" },
  upscale_models: { className: "UpscaleModelLoader", field: "model_name" },
  samplers: { className: "KSampler", field: "sampler_name" },
  schedulers: { className: "KSampler", field: "scheduler" },
};

let _listsCache = null;
let _listsCacheAt = 0;
const LISTS_CACHE_MS = 1000; // node defs don't change mid-session; a light cache is still cheap insurance -- same TTL as js/controls/index.js's own readKnownLists.

function readKnownLists(mods) {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (_listsCache && now - _listsCacheAt < LISTS_CACHE_MS) {
    return _listsCache;
  }
  const registry = (typeof window !== "undefined" && window.LiteGraph && window.LiteGraph.registered_node_types) || {};
  const lists = {};
  for (const key of Object.keys(MODEL_LIST_SOURCES)) {
    const src = MODEL_LIST_SOURCES[key];
    lists[key] = mods.interaction.getComboOptions(registry, src.className, src.field);
  }
  _listsCache = lists;
  _listsCacheAt = now;
  return lists;
}

function buildCtx(mods) {
  return {
    doc: typeof document !== "undefined" ? document : null,
    getCanvasEl,
    havePackages: readHavePackages,
    getKnownLists: () => readKnownLists(mods),
  };
}

// ---------------------------------------------------------------------------
// Socket self-healing -- see this file's top doc comment for WHY this hook
// exists and why `AnimaContextBridge` is patched here too. The actual
// reconciliation is `interaction.mjs`'s `healNodeSockets` (pure enough to be
// unit-tested against a fake node/graph); this is just the one place that
// logs it, once per healed node, so a surprised user can see what happened
// rather than guessing why a wire vanished (task brief).
// ---------------------------------------------------------------------------

function logHealedSockets(node, nodeData, summary) {
  const parts = [];
  if (summary.removedInputs.length) {
    parts.push(`removed input(s) [${summary.removedInputs.join(", ")}]`);
  }
  if (summary.removedOutputs.length) {
    parts.push(`removed output(s) [${summary.removedOutputs.join(", ")}]`);
  }
  if (!parts.length) {
    parts.push("reordered its surviving sockets to match the current definition");
  }
  console.info(
    `[AnimaFlow Anima] healed "${nodeData.name}" #${node.id}: ${parts.join("; ")} -- ` +
    "this node's saved sockets were stale against the currently registered definition.",
  );
}

// ---------------------------------------------------------------------------
// Legacy litegraph sizing -- per the dynamic-node-frontend skill: this node
// has real litegraph INPUT/OUTPUT sockets (`context`/`generation_settings`
// on the Generator; `images`/`metadata_json` on the Preview, plus the
// hidden `prompt`/`extra_pnginfo`), so `node.widgets_start_y` is left at its
// default (unlike js/controls/, this node's sockets AREN'T parked on
// per-row DOM widgets — see render.mjs's top doc comment) and the ONE DOM
// widget (a single scrollable panel, not one widget per row/section — see
// render.mjs's top doc comment for the 2026-07-28 rewrite) occupies the
// body below them. `getMinHeight` (legacy, PRIMARY) / `computeLayoutSize`
// (Nodes 2.0, forward-compat only) report ONLY a FLOOR -- everything ABOVE
// that floor is the panel filling whatever height the node is (render.mjs's
// `.wtn-an-panel` CSS, `flex: 1 1 auto`), never something this file
// measures or reacts to. That is deliberate: this dispatch removed the
// grow-biased node-auto-fit (`refitNode`/`scheduleRefit`) that used to fight
// a manual resize -- the node's height is the user's to set, full stop.
//
// The FLOOR itself is `mods.render.measureMinHeight` for the Generator, but
// `mods.render.measurePreviewMinHeight` for the Preview -- a LATER dispatch
// gave the Preview its own, much taller floor (`PREVIEW_PANEL_MIN_H`,
// render.mjs's own doc comment for the arithmetic) so its panel could drop
// its scrollbar entirely; using the wrong one here would report a floor to
// litegraph that CONTRADICTS `clampPreviewSize`'s own height clamp
// (render.mjs), so `measureFloor` below is picked once, per node type, and
// used for both sizing hooks.
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

  // Min-width (and, for the Preview, min-height too) clamp -- the user
  // asked for a min-width explicitly on the Generator too (previously
  // Preview-only), and later a min-HEIGHT on the Preview specifically. Each
  // node type has its own floor (`render.mjs`'s `GENERATOR_MIN_W`/
  // `PREVIEW_MIN_W`/`PREVIEW_MIN_H` doc comments; `clampGeneratorSize`
  // stays width-only, `clampPreviewSize` clamps both axes). Installed here,
  // right after `mods` resolves, so there is no lazy-load race with a user
  // resize. CHAINS any pre-existing `node.onResize` rather than replacing
  // it.
  const prevResize = node.onResize;
  const clampSize = isGenerator ? mods.render.clampGeneratorSize : mods.render.clampPreviewSize;
  node.onResize = function (size) {
    clampSize(size);
    return prevResize ? prevResize.apply(this, arguments) : undefined;
  };

  // The floor-measuring function itself differs by node type -- see this
  // file's "Legacy litegraph sizing" comment above for why using the wrong
  // one would contradict `clampSize`'s own height clamp on the Preview.
  const measureFloor = isGenerator ? mods.render.measureMinHeight : mods.render.measurePreviewMinHeight;

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
        getMinHeight: () => measureFloor(refs.root),
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
    return { minHeight: measureFloor(refs.root), minWidth: 1 };
  };
  refs.widget = widget;

  if (typeof node.setDirtyCanvas === "function") {
    node.setDirtyCanvas(true, true);
  }
}

function setupNode(node, mods, isGenerator) {
  mountNode(node, mods, isGenerator);

  // Paint the node's own litegraph chrome (body/title strip) in our theme --
  // ONLY for a genuinely fresh node, never one being restored from a saved
  // workflow. `setupNode` runs from `onNodeCreated`, which fires for BOTH a
  // brand-new node AND a restored one (this file's top doc comment); the
  // reliable way to tell them apart at this point is `node._anConfiguring`
  // -- `onConfigure`'s wrapper below sets that flag SYNCHRONOUSLY, before
  // queuing its own `loadMods().then(...)`, and litegraph's own
  // node-deserialize loop (construct -> configure, for every node) runs
  // fully synchronously with no `await` in between. So for a node being
  // loaded from a workflow, `onConfigure` has already set the flag by the
  // time this microtask-deferred `setupNode` call actually runs, even
  // though `onNodeCreated` fired first. A truly fresh, user-placed node
  // never has `onConfigure` invoked at all, so the flag stays unset here.
  // Matches `js/controls/index.js`'s identical `_ctrlConfiguring` guard on
  // its own `applyNodeChrome` call site, byte-for-byte reasoning.
  if (!node._anConfiguring) {
    mods.render.applyNodeChrome(node);
  }

  // ---------------------------------------------------------------------
  // Sizing -- GATED on `!isGraphLoading() && !node._anConfiguring` (this is
  // the fix for the pack's most-repeated bug: "the Generator loses its
  // saved size on every refresh / every workflow re-open", live-traced to
  // `[setSize] [360,340] id 747` -- exactly this block's own
  // `DEFAULT_W`/`DEFAULT_H`, stamped over an already-saved node).
  //
  // `node._anConfiguring` ALONE is not enough, even though the comment
  // above this block correctly explains why it protects `applyNodeChrome`:
  // `onNodeCreated` fires for a RESTORED node too (litegraph's construct-
  // then-configure sequence calls `onNodeCreated` BEFORE `onConfigure`, not
  // instead of it), and `app.loadGraphData` -- the thing that eventually
  // calls `configure()` on every restored node -- is itself async. So
  // there is a real window where THIS function's own `loadMods().then(...)`
  // microtask (queued from `onNodeCreated`) resolves and runs before
  // `onConfigure` has had any chance to set `_anConfiguring` at all -- and
  // during that exact window `node.size` still holds litegraph's tiny
  // freshly-CONSTRUCTED default (not yet the workflow's saved one), so
  // flooring up from THAT snaps the node to its fresh-node default instead.
  // `isGraphLoading()` (`js/shared/graph_loading.mjs`, ported from
  // `../ComfyUI-Pixaroma`'s module of the same name -- see
  // `THIRD_PARTY_NOTICES.md`) closes exactly that window: it wraps
  // `app.loadGraphData` itself (the one funnel every workflow open/tab
  // switch/undo goes through) and stays true for the WHOLE call plus a
  // trailing window, independent of any per-node flag's own timing.
  // `node._anConfiguring` is kept as a second, belt-and-braces check (it
  // still covers a hot-reload/edge case `isGraphLoading` might not), not
  // because it alone is suffient -- removing EITHER half of this
  // `||` reintroduces the exact bug this comment describes.
  //
  // `restoreNode` (below) already does no sizing at all, by design; this
  // gate is what makes `setupNode` -- which unlike `restoreNode` DOES run
  // on the restore path, via `onNodeCreated` -- actually honour that same
  // rule instead of quietly violating it whenever the race above fires.
  // ---------------------------------------------------------------------
  if (isGraphLoading() || node._anConfiguring) {
    return;
  }

  // `Math.max(..., PREVIEW_MIN_H)` on the Preview -- its floor (see
  // render.mjs's `PREVIEW_MIN_H` doc comment) is now taller than its own
  // `PREVIEW_DEFAULT_H` (unchanged), and this node's panel is
  // `overflow: hidden` (no scroll fallback), so a fresh node MUST start at
  // or above its own floor or it opens already clipping its Save row.
  // The Generator has no such gap (its panel still scrolls past its floor),
  // so `DEFAULT_H` alone is untouched there.
  const defaultH = isGenerator ? mods.render.DEFAULT_H : Math.max(mods.render.PREVIEW_DEFAULT_H, mods.render.PREVIEW_MIN_H);
  // Floor a freshly-created node's size UP (never down) to a comfortable
  // starting size -- mirrors `js/prompt_rules/node/index.js`'s
  // `ensureInitialFloor`. This is the ONLY sizing this module ever does for
  // a fresh node: there is no follow-up grow-to-content fit (deleted --
  // this file's top "Legacy litegraph sizing" comment). The panel fills
  // whatever height that leaves it (render.mjs's CSS); if the defaults
  // don't fit inside `defaultH` without scrolling, the user drags the node
  // taller, same as any later resize.
  const curW = Array.isArray(node.size) && typeof node.size[0] === "number" ? node.size[0] : 0;
  const curH = Array.isArray(node.size) && typeof node.size[1] === "number" ? node.size[1] : 0;
  // Each node type has its own width floor (render.mjs's `GENERATOR_MIN_W`/
  // `PREVIEW_MIN_W` doc comments) -- Preview's is taller (the compare row's
  // segmented groups need more room than any Generator row does).
  const wFloor = Math.max(mods.render.DEFAULT_W, isGenerator ? mods.render.GENERATOR_MIN_W : mods.render.PREVIEW_MIN_W);
  const w = Math.max(curW, wFloor);
  const h = Math.max(curH, defaultH);
  if (w !== curW || h !== curH) {
    if (typeof node.setSize === "function") {
      node.setSize([w, h]);
    } else if (Array.isArray(node.size)) {
      node.size[0] = w;
      node.size[1] = h;
    }
  }
}

function restoreNode(node, mods, isGenerator) {
  mountNode(node, mods, isGenerator);
  // Deliberately NO sizing call here at all -- trust the size litegraph
  // already restored from the saved workflow (never resize/rewrite on
  // load — a clean workflow must not open "modified"). There is no
  // refit/fitNode left in this module to accidentally call either way (see
  // this file's top "Legacy litegraph sizing" comment).
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
    // `AnimaContextBridge` has no DOM UI (this file's top doc comment) --
    // `mountsUi` is the one gate deciding which hooks below actually do
    // anything beyond the socket-healing `onConfigure` patch every one of
    // the three classes gets.
    const mountsUi = isGenerator || nodeData.name === "AnimaPreview";

    if (mountsUi) {
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
    }

    // Socket self-healing (interaction.mjs's `healNodeSockets` -- see its
    // own top doc comment for the full mechanism) runs for ALL THREE
    // classes here, on the LOAD path only -- never inside `onNodeCreated`
    // above, since a freshly-placed node is already built correctly by
    // ComfyUI itself (task brief). `nodeData` is THIS class's own
    // just-registered definition, captured once in this closure and reused
    // for every instance's restore -- node defs don't change mid-session
    // (same assumption `js/controls/index.js`'s `readKnownLists` cache
    // makes). Deliberately deferred to the SAME `loadMods().then(...)`
    // microtask `restoreNode` already rides, not run synchronously inside
    // `onConfigure` itself -- see `healNodeSockets`'s own doc comment for
    // why that timing matters (the graph's own `links` table isn't
    // assembled yet at the point `onConfigure` synchronously runs).
    const _configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      // Set BEFORE anything else runs (including the original _configure
      // call and the async mods load) -- `setupNode`'s `applyNodeChrome`
      // guard (above) must see this flag for the WHOLE loading window,
      // however long the (one-time, cached) import takes, since
      // `onNodeCreated`'s own `setupNode` call is likewise deferred to a
      // microtask and could otherwise run before this flag lands. Matches
      // `js/controls/index.js`'s identical `_ctrlConfiguring` ordering.
      this._anConfiguring = true;
      const result = _configure ? _configure.apply(this, args) : undefined;
      const node = this;
      loadMods()
        .then((mods) => {
          const summary = mods.interaction.healNodeSockets(node, nodeData);
          if (summary.changed) {
            logHealedSockets(node, nodeData, summary);
          }
          if (mountsUi) {
            restoreNode(node, mods, isGenerator);
          }
        })
        .catch((err) => {
          console.error("[AnimaFlow Anima] failed to load js/anima modules:", err);
        })
        .finally(() => {
          node._anConfiguring = false;
        });
      return result;
    };

    // `AnimaContextBridge` ONLY, and deliberately BEFORE the `!mountsUi`
    // early-out just below -- the Bridge mounts no UI of its own (`mountsUi`
    // is `false` for it) so it never gets the Generator/Preview
    // `onConnectionsChange` repaint hook a few lines down, but a socket
    // wired/unwired HERE is exactly what `computeContextSupplied` reads for
    // every Generator downstream of it. `resolveDownstreamGenerators`
    // (interaction.mjs) walks FORWARD from this node's own "context" output
    // to find them; each one that's ALREADY mounted gets repainted directly
    // through its OWN `_anMods`/`_anCtx` (the Bridge has neither -- it
    // mounts nothing), and its stale `_anContextRun` is cleared first (same
    // "a stale run can't outlive the wiring it described" rule the
    // Generator's own hook below applies to itself). A generator not yet
    // mounted is skipped -- it will build with the CURRENT wiring anyway, so
    // there's nothing stale to fix there.
    //
    // **Gated on `!isSubmitting()` (`../shared/submit_guard.mjs`)** -- a
    // Use-Everywhere-driven prompt submission materializes real links across
    // every UE-fed socket and then removes them again, firing THIS hook
    // roughly a dozen times per run. Without the gate, `clearContextRun`
    // wipes the very `_anContextRun` `handleGeneratorExecuted` just stashed
    // (that IS the bug this guards against -- "post-run context-supplied
    // values never appear," see `submit_guard.mjs`'s own doc comment for the
    // live trace), and the matching repaint is pure churn on top of it. A
    // GENUINE user rewire (dragging a wire in the editor, outside any
    // submission) is never inside this window, so it still clears/repaints
    // exactly as before.
    if (nodeData.name === CONTEXT_BRIDGE_NAME) {
      const _bridgeConn = nodeType.prototype.onConnectionsChange;
      nodeType.prototype.onConnectionsChange = function (...args) {
        const result = _bridgeConn ? _bridgeConn.apply(this, args) : undefined;
        if (isSubmitting()) {
          return result;
        }
        const bridge = this;
        loadMods()
          .then((mods) => {
            if (isSubmitting()) {
              return; // the guard window opened WHILE this microtask was pending
            }
            const generators = mods.interaction.resolveDownstreamGenerators(bridge);
            generators.forEach((gen) => {
              if (gen._anMods) {
                gen._anMods.interaction.clearContextRun(gen);
              }
              if (gen._anMods && gen._anRefs) {
                gen._anMods.interaction.repaintGenerator(gen, gen._anCtx);
              }
            });
          })
          .catch((err) => {
            console.error("[AnimaFlow Anima] failed to repaint downstream generators:", err);
          });
        return result;
      };
    }

    if (!mountsUi) {
      return; // AnimaContextBridge: healing + downstream repaint only -- no UI hooks below.
    }

    // Refresh the Generator's "context-supplied" field badges (design doc
    // §5a -- `computeContextSupplied` walks the real litegraph link, so a
    // link made/broken anywhere upstream of `context` must repaint) / the
    // Preview's own wired-vs-not placeholder, the instant a link is made or
    // broken -- gated on `!_anConfiguring`-equivalent isn't needed here
    // (unlike Controls' auto-row-kind resolution, refreshing a read-only
    // badge on a workflow's own link replay is harmless and correct).
    //
    // **Generator branch ONLY, gated on `!isSubmitting()`** -- same
    // Use-Everywhere submit-churn guard as the Bridge's hook above
    // (`../shared/submit_guard.mjs`'s own doc comment has the live trace:
    // a burst of connect-then-disconnect across every UE-fed socket, firing
    // this hook roughly a dozen times per run). While submitting, skip BOTH
    // the clear and the repaint for the Generator entirely -- clearing here
    // would wipe the very `_anContextRun` `handleGeneratorExecuted` just
    // stashed for this run (the exact bug this guards against), and
    // repainting on top of that is pure churn. The Preview branch below is
    // UNTOUCHED by this gate -- UE's churn is on the Bridge's context-feeding
    // sockets, never the Preview's `images`/`metadata_json`, so there is
    // nothing to protect there.
    const _conn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (...args) {
      const result = _conn ? _conn.apply(this, args) : undefined;
      if (isGenerator) {
        if (isSubmitting()) {
          return result;
        }
        if (this._anMods) {
          // A stale post-run "supplied" must never outlive the wiring it
          // described -- clear it on the Generator's OWN context link
          // changing too, not just the Bridge's forward-walk hook above.
          // Safe to gate on `_anMods` alone (not also `_anRefs`):
          // `_anContextRun` is only EVER set by `handleGeneratorExecuted`,
          // itself gated on `_anMods` being loaded, so it can never hold a
          // stale value while `_anMods` is still unset.
          this._anMods.interaction.clearContextRun(this);
        }
      }
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

    // `AnimaGenerator` only -- the post-run truth for "context-supplied"
    // (this file's top doc comment / `interaction.mjs`'s
    // `computeEffectiveContextSupplied`): `message.anima_context` is the
    // ONLY thing that can see a sampler scalar Use Everywhere injected
    // straight into the prompt at submit time, since that never rides a
    // litegraph link the live wire-walk above can see at all. Same
    // never-ready-yet tolerance as the Preview's own `onExecuted` above --
    // `handleGeneratorExecuted` simply isn't called if `_anMods` hasn't
    // loaded, and there is nothing to paint late in that case (the data
    // isn't stashed anywhere for a next repaint to pick up, unlike the
    // Preview's image cache, but a run finishing before this file's own
    // lazy modules load is exactly as improbable here as it is there).
    if (isGenerator) {
      const _genExecuted = nodeType.prototype.onExecuted;
      nodeType.prototype.onExecuted = function (message) {
        const result = _genExecuted ? _genExecuted.apply(this, arguments) : undefined;
        if (this._anMods) {
          this._anMods.interaction.handleGeneratorExecuted(this, this._anCtx, message);
        }
        return result;
      };
    }
  },
});
