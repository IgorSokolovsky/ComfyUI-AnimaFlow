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
 * its own and never will just for this — it only needs the healing hook,
 * so it's patched here with nothing else installed (see `mountsUi` below).
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
 * auto-loaded file.
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

// `AnimaContextBridge` is included ONLY for socket self-healing (see this
// file's top doc comment) -- `mountsUi` below is what actually gates every
// DOM/UI hook so the Bridge never gets `setupNode`/`restoreNode` treatment.
const NODE_CLASS_NAMES = ["AnimaGenerator", "AnimaPreview", "AnimaContextBridge"];

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

function buildCtx(mods) {
  return {
    doc: typeof document !== "undefined" ? document : null,
    getCanvasEl,
    havePackages: readHavePackages,
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
  // `Math.max(..., PREVIEW_MIN_H)` on the Preview -- its floor (`480`, see
  // render.mjs's `PREVIEW_MIN_H` doc comment) is now taller than its own
  // `PREVIEW_DEFAULT_H` (`420`, unchanged), and this node's panel is
  // `overflow: hidden` (no scroll fallback), so a fresh node MUST start at
  // or above its own floor or it opens already clipping its Save section.
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
        });
      return result;
    };

    if (!mountsUi) {
      return; // AnimaContextBridge: healing only -- no UI hooks below.
    }

    // Refresh the Generator's "context-supplied" field badges (design doc
    // §5a -- `computeContextSupplied` walks the real litegraph link, so a
    // link made/broken anywhere upstream of `context` must repaint) / the
    // Preview's own wired-vs-not placeholder, the instant a link is made or
    // broken -- gated on `!_anConfiguring`-equivalent isn't needed here
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
