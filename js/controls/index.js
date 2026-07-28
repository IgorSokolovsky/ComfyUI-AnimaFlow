/**
 * index.js — the ONLY auto-loaded `.js` for the Controls line (`.claude/
 * CLAUDE.md`'s JS download budget: this one file registers BOTH
 * `AnimaControlPanel` and `AnimaLoaderPanel`).
 *
 * Absolute `/scripts/app.js` import (this file is nested in `js/controls/`
 * — the frontend skill's gotcha #1: a relative `../../scripts/app.js`
 * resolves wrong from a subfolder and silently kills the whole extension).
 * That's the ONLY static import in this file, deliberately.
 *
 * ## `rows.mjs`/`render.mjs`/`interaction.mjs` are LAZY, not static
 *
 * `beforeRegisterNodeDef` runs for EVERY node type on EVERY ComfyUI page at
 * startup, whether or not the user ever places one of ours. A static
 * top-level `import` of the three sibling modules here would mean every
 * page pays for fetching+evaluating the whole row-catalog/DOM/CSS/event
 * stack the moment this ONE already-auto-loaded file runs — exactly the
 * "shipped to users who don't need it" cost `.claude/CLAUDE.md`'s JS
 * download budget exists to avoid. So `loadMods()` below only ever runs a
 * guarded dynamic `import()` (cached after the first call, since both node
 * classes share it) the FIRST TIME an actual node INSTANCE of either class
 * is created or restored (`onNodeCreated`/`onConfigure`) — a page with zero
 * Control/Loader Panel nodes anywhere never fetches them at all.
 *
 * A loaded workflow node runs `onNodeCreated` THEN `onConfigure` (per the
 * dynamic-node-frontend skill) — both kick off `loadMods()`, which resolves
 * once and services both `.then()` callbacks in that same order. Since
 * litegraph's OWN (synchronous, un-wrapped) `onConfigure` has already
 * restored every widget's real saved value (including `panel_state`)
 * before either callback fires, `setupNode` and `restoreNode` both end up
 * reading the SAME correctly-restored state regardless of how long the
 * import takes — the async gap only delays when the DOM rows actually
 * appear, never which state they show once they do.
 *
 * ## What lives here vs. in `interaction.mjs`
 *
 * Everything ComfyUI-runtime-specific and NOT unit-testable under plain
 * `node` lives here: reading `window.LiteGraph.registered_node_types` for
 * the live `sampler_name`/`scheduler`/`unet_name`/`vae_name`/`clip_name`
 * option lists (`getKnownLists`), inspecting a link's actual target
 * node/widget (`describeLinkTarget`), the litegraph lifecycle hooks
 * (`onNodeCreated`/`onConfigure`/`onConnectionsChange`/`arrange`/
 * `serialize`/`onRemoved`), and `window.confirm` for the "this row has a
 * live link" guard. Every actual row/state/output mutation is delegated to
 * `interaction.mjs`, which stays testable with a fake registry/graph.
 *
 * ## Widget contract (matches `nodes/controls/*.py`'s declared
 * `panel_state` STRING widget, `default: "{}"` — verified against the
 * actual sibling build, per `docs/control-panel-design.md` §4)
 *
 * `panel_state` is hidden for RENDERING only (never `serialize = false` —
 * it must keep reaching the backend) and mirrored from
 * `node.properties.<stateProp>` after every mutation
 * (`interaction.mjs`'s `persistState`).
 */
import { app } from "/scripts/app.js";
// `isGraphLoading` -- the ONE exception to this file's "everything past
// `/scripts/app.js` is a LAZY dynamic import" rule (this file's own "lazy,
// not static" doc comment above). It has to be a STATIC top-level import,
// deliberately: `app.loadGraphData` must be wrapped BEFORE the very first
// workflow load call happens, and by the time this pack's OWN lazy
// `loadMods()` would resolve (queued from inside `onNodeCreated`, which
// itself fires DURING that same `loadGraphData` call), that call has
// already started -- wrapping it from inside a callback triggered by its
// own execution can never retroactively flag the call already in progress.
// This module is tiny (a single monkey-patch + a getter, no DOM/CSS), so the
// download-budget cost of making it eager is negligible next to what making
// it correct requires. Ported to `js/anima/index.js` first (its own
// identical top-of-file comment has the live trace: `[setSize] [360,340] id
// 747`, a saved Generator snapped back to its fresh-node default); see
// `setupNode`'s own "Sizing" comment below for why the Controls line hits
// the exact same race, just with a worse symptom (a collapsed row count
// makes the HEIGHT collapse too, not just the width).
import { isGraphLoading } from "../shared/graph_loading.mjs";

// CATEGORY is Title Case ("AnimaFlow/Controls") on the Python side; nothing
// here needs to know that string, only the two class names.
const PANEL_CONFIGS = {
  control: {
    className: "AnimaControlPanel",
    key: "control",
    stateProp: "controlPanelState",
    catalog: ["sampler", "scheduler", "seed", "int", "float", "latent"],
    // The "+ Add control" menu's OWN order -- includes rows.mjs's `steps`/
    // `cfg`/`denoise` presets (still real `int`/`float` rows under the hood;
    // see `rows.mjs`'s `ROW_PRESETS` doc comment), placed BEFORE the bare
    // `int`/`float` escape hatches they shortcut, since a preset is what a
    // user wants most of the time. `catalog` above stays the plain KIND list
    // (used for `resolveAutoOnConnect`'s allowedKinds, unrelated to the menu).
    menuCatalog: ["sampler", "scheduler", "seed", "steps", "cfg", "denoise", "int", "float", "latent"],
    allowAuto: true,
    reorder: true,
    addLabel: "+ Add control",
  },
  loader: {
    className: "AnimaLoaderPanel",
    key: "loader",
    stateProp: "loaderPanelState",
    catalog: ["unet", "vae", "clip"],
    allowAuto: false,
    reorder: false,
    addLabel: "+ Add loader",
  },
};

const CLASS_TO_PANEL = Object.fromEntries(Object.values(PANEL_CONFIGS).map((p) => [p.className, p]));

// ---------------------------------------------------------------------------
// Lazy module loading -- see this file's top doc comment.
// ---------------------------------------------------------------------------

let _modsPromise = null;
function loadMods() {
  if (!_modsPromise) {
    _modsPromise = Promise.all([
      import("./rows.mjs"),
      import("./render.mjs"),
      import("./interaction.mjs"),
    ]).then(([rows, render, interaction]) => ({ rows, render, interaction }));
  }
  return _modsPromise;
}

/** Hide `panel_state` from RENDERING only -- it keeps serializing normally
 * (dynamic-node-frontend skill's "hide a declared widget that must still
 * serialize" pattern). Never `w.serialize = false` here. */
function hideStateWidget(node, mods) {
  const w = mods.interaction.getStateWidget(node);
  if (!w) {
    return;
  }
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (w.inputEl && w.inputEl.style) {
    w.inputEl.style.display = "none";
  }
}

// ---------------------------------------------------------------------------
// Reading ComfyUI's own node defs -- the only place this whole feature
// touches `window.LiteGraph` (rows.mjs's `getComboOptions` itself takes an
// injectable registry so IT stays testable; only the actual global read
// happens here).
// ---------------------------------------------------------------------------

let _listsCache = null;
let _listsCacheAt = 0;
const LISTS_CACHE_MS = 1000; // node defs don't change mid-session; a light cache is still cheap insurance

function readKnownLists(mods) {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (_listsCache && now - _listsCacheAt < LISTS_CACHE_MS) {
    return _listsCache;
  }
  const registry = (typeof window !== "undefined" && window.LiteGraph && window.LiteGraph.registered_node_types) || {};
  const lists = {};
  for (const kind of Object.keys(mods.rows.NODE_DEF_SOURCE)) {
    const src = mods.rows.NODE_DEF_SOURCE[kind];
    lists[kind] = mods.rows.getComboOptions(registry, src.className, src.field);
  }
  _listsCache = lists;
  _listsCacheAt = now;
  return lists;
}

/**
 * Inspect a just-made link's TARGET input (and the widget behind it, for a
 * widget-backed input) and describe it in the shape `rows.mjs`'s
 * `resolveAutoKind` expects. Returns `null` for anything it can't safely
 * describe (missing target/graph, etc.) -- `resolveAutoOnConnect` treats
 * that as "leave the row auto".
 *
 * VERIFY-IN-COMFYUI: on legacy litegraph a widget-backed input (e.g.
 * KSampler's `sampler_name`) only becomes a real link TARGET after the
 * user right-clicks it -> "Convert widget to input" (design doc §5's UX
 * caveat) -- this function only ever runs for an ACTUAL link, so that
 * conversion is assumed to have already happened by the time it's called.
 */
function describeLinkTarget(link) {
  try {
    const targetNode = app.graph && typeof app.graph.getNodeById === "function" ? app.graph.getNodeById(link.target_id) : null;
    const inp = targetNode && targetNode.inputs && targetNode.inputs[link.target_slot];
    if (!inp) {
      return null;
    }
    const type = String(inp.type || "").toUpperCase();
    const wname = (inp.widget && inp.widget.name) || inp.name;
    const widget = (targetNode.widgets || []).find((w) => w.name === wname);
    const options = (widget && widget.options) || {};
    let comboValues = options.values;
    if (typeof comboValues === "function") {
      try {
        comboValues = comboValues();
      } catch {
        comboValues = null;
      }
    }
    return {
      type,
      name: wname || inp.name,
      min: options.min,
      max: options.max,
      step2: options.step2,
      value: widget ? widget.value : undefined,
      comboValues: Array.isArray(comboValues) ? comboValues : null,
    };
  } catch {
    return null;
  }
}

function confirmRemove(row) {
  if (typeof window === "undefined" || typeof window.confirm !== "function") {
    return true; // no confirm surface available (e.g. under test) -- don't block removal
  }
  return window.confirm(`"${row.name || row.kind}" is wired to something. Remove this row and its link?`);
}

// Wheel-zooms-the-canvas fix (js/shared/canvas_zoom.mjs): the real,
// currently-live LiteGraph canvas element -- read fresh on every call
// (never cached here either), since `installCanvasZoomPassthrough` itself
// re-reads this on every wheel event and the canvas can be recreated.
function getCanvasEl() {
  return (app.canvas && app.canvas.canvas) || null;
}

function buildCtx(panelConfig, mods) {
  return {
    panelConfig,
    doc: typeof document !== "undefined" ? document : null,
    getKnownLists: () => readKnownLists(mods),
    describeLinkTarget,
    confirmRemove,
    getCanvasEl,
    // Injectable, same reason `getCanvasEl` is (`js/shared/canvas_zoom.mjs`'s
    // own doc comment on that pattern): `interaction.mjs`'s `scheduleFit`
    // needs `isGraphLoading` too (this file's own eager top-level import),
    // but `interaction.mjs` itself has no `/scripts/app.js` import of its
    // own and must stay importable under plain `node` (`test_resize.mjs`
    // imports it directly) -- so the LIVE function is handed through `ctx`
    // rather than `interaction.mjs` importing `graph_loading.mjs` statically
    // (which would 404 under that headless suite).
    isGraphLoading,
  };
}

// ---------------------------------------------------------------------------
// Legacy litegraph sizing -- per the dynamic-node-frontend skill / design
// doc §7: computeSize returns MIN_W (never the live width, or the node can
// only ever grow), bodyHeight counts our rows only (else legacy reserves a
// 20px slot row PER OUTPUT above the body), and arrange() is re-run after
// alignOutputsLegacy so slots re-measure with our positions in place.
// ---------------------------------------------------------------------------

function setupNode(node, panelConfig, mods) {
  if (node._ctrlSetup) {
    return;
  }
  node._ctrlSetup = true;
  node._ctrlMods = mods;
  const ctx = buildCtx(panelConfig, mods);
  node._ctrlCtx = ctx;

  hideStateWidget(node, mods);
  mods.interaction.ensureState(node, ctx);

  // Paint the node's own litegraph chrome (body/title strip) in our theme --
  // ONLY for a genuinely fresh node, never one being restored from a saved
  // workflow. `setupNode` runs from `onNodeCreated`, which fires for BOTH a
  // brand-new node AND a restored one (this file's top doc comment); the
  // reliable way to tell them apart at this point is `node._ctrlConfiguring`
  // -- `onConfigure`'s wrapper below sets that flag SYNCHRONOUSLY, before
  // queuing its own `loadMods().then(restoreNode)`, and litegraph's own
  // node-deserialize loop (construct -> configure, for every node) runs
  // fully synchronously with no `await` in between. So for a node being
  // loaded from a workflow, `onConfigure` has already set the flag by the
  // time this microtask-deferred `setupNode` call actually runs, even though
  // `onNodeCreated` fired first. A truly fresh, user-placed node never has
  // `onConfigure` invoked at all, so the flag stays unset here.
  //
  // This is the conservative pick between the two options the task called
  // out: colour is applied on node CREATION only, never on the restore
  // path, matching this file's existing "never resize/rewrite on load" rule
  // for `restoreNode` (see its own doc comment) -- deliberately avoided
  // relying on any assumption about whether a plain `node.bgcolor =`
  // mutation during `onConfigure` would flag a clean loaded workflow as
  // modified, since that can only be confirmed in a live ComfyUI browser
  // session, not from this headless repo.
  if (!node._ctrlConfiguring) {
    mods.render.applyNodeChrome(node);
  }

  // Without this, widget Y depends on slot bounds which depend on widget Y
  // -- the node walks taller every frame (ComfyUI-Pixaroma's
  // `js/sliders/index.js` doc comment; same trap here since our outputs are
  // parked ON row widgets too).
  node.widgets_start_y = 2;

  node.computeSize = function computeControlsSize() {
    return [mods.render.MIN_W, mods.render.bodyHeight(mods.interaction.rowCountOf(this, ctx))];
  };

  // ---------------------------------------------------------------------
  // Sizing -- GATED on `!isGraphLoading() && !node._ctrlConfiguring` (the
  // exact same fix `js/anima/index.js`'s `setupNode` already carries for
  // `AnimaGenerator`/`AnimaPreview`, ported here for `AnimaControlPanel`/
  // `AnimaLoaderPanel` -- see that file's own "Sizing" comment for the full
  // derivation this one only summarizes).
  //
  // `node._ctrlConfiguring` ALONE is not enough, even though it correctly
  // guards `applyNodeChrome` just above: `setupNode` runs from
  // `onNodeCreated`'s own deferred `loadMods().then(...)` microtask, and
  // `onNodeCreated` fires for a RESTORED node too (litegraph's construct-
  // then-configure sequence calls `onNodeCreated` BEFORE `onConfigure`, not
  // instead of it). `app.loadGraphData` -- the thing that eventually calls
  // `configure()` on every restored node -- is itself async, so there is a
  // real window where THIS function's own microtask resolves and runs
  // BEFORE `onConfigure` has had any chance to set `_ctrlConfiguring` at
  // all. During that exact window `node.size` still holds litegraph's tiny
  // freshly-CONSTRUCTED default (not yet the workflow's saved one) -- and
  // WORSE than the Anima track's version of this race, `rowCountOf` can
  // ALSO still read zero rows here (the state widget's saved value hasn't
  // been parsed into `node._ctrlRows` yet either), so an unguarded floor
  // doesn't just widen the node, it can also collapse its HEIGHT to a
  // near-empty single-row body over an already-saved 8-row panel.
  // `isGraphLoading()` (`js/shared/graph_loading.mjs`, ported from
  // `../ComfyUI-Pixaroma` -- see `THIRD_PARTY_NOTICES.md`) closes exactly
  // that window: it wraps `app.loadGraphData` itself (the one funnel every
  // workflow open/tab switch/undo goes through) and stays true for the
  // WHOLE call plus a trailing window, independent of any per-node flag's
  // own timing. `node._ctrlConfiguring` is kept as a second, belt-and-
  // braces check (it still covers a hot-reload/edge case `isGraphLoading`
  // might not), not because it alone is sufficient -- removing EITHER half
  // of this `||` reintroduces the exact "loses its saved size on refresh"
  // bug this comment describes.
  // ---------------------------------------------------------------------
  if (!isGraphLoading() && !node._ctrlConfiguring) {
    if (!node.size || node.size[0] < mods.render.MIN_W) {
      node.size = node.size || [0, 0];
      node.size[0] = mods.render.DEFAULT_W;
      node.size[1] = mods.render.bodyHeight(mods.interaction.rowCountOf(node, ctx));
    }
  }

  mods.interaction.syncRows(node, ctx);
  mods.interaction.scheduleFit(node, ctx);
}

// ---------------------------------------------------------------------------
// Queue hook: advance every AnimaControlPanel seed row's value AFTER a run
// (`rows.mjs`'s `applyAfterGenerate` — stock-ComfyUI semantics: the value
// present AT QUEUE TIME is the one that was actually used, THEN it advances
// for next time). This is the ONE place `app.queuePrompt` itself is ever
// touched — everything else in this feature stays inside `interaction.mjs`/
// `rows.mjs`.
// ---------------------------------------------------------------------------

// Module-level flag (not a per-node/per-registration one): `beforeRegisterNodeDef`
// runs once per NODE TYPE (twice here — control, then loader), but this hook
// only ever needs installing ONCE for the whole page, and must survive a
// hot-reload the same way `_wtnControlsPatched` does on the prototype above.
let _queuePromptWrapped = false;

/** Every live `AnimaControlPanel` node currently on the graph — checks BOTH
 * `comfyClass` and `.type` (ComfyUI graph internals vary across frontend
 * versions/builds; matching either is strictly more defensive than either
 * alone) and tolerates a missing/mid-construction graph entirely. */
function findControlPanelNodes() {
  const nodes = (app.graph && app.graph._nodes) || [];
  return nodes.filter((n) => n && (n.comfyClass === "AnimaControlPanel" || n.type === "AnimaControlPanel"));
}

/**
 * Advance every seed row on every live Control Panel node, then persist +
 * repaint each node that actually changed. A no-op if `loadMods()` has never
 * even been kicked off (`_modsPromise` still null) — if nothing has ever
 * called `loadMods()`, no Control/Loader Panel node instance has ever run
 * `onNodeCreated`/`onConfigure` either, so there is provably nothing on the
 * graph to advance; forcing the (page-wide-cost) import here purely to
 * discover "still nothing to do" is exactly what the lazy-load contract
 * (this file's top doc comment) exists to avoid. Once `_modsPromise` exists
 * it's already resolved-or-resolving from that earlier real usage, so
 * awaiting it here costs nothing extra.
 */
function advanceSeedsAfterRun() {
  if (!_modsPromise) {
    return;
  }
  loadMods()
    .then((mods) => {
      for (const node of findControlPanelNodes()) {
        try {
          const ctx = node._ctrlCtx;
          const nodeMods = node._ctrlMods;
          if (!ctx || !nodeMods) {
            continue; // this node's own setupNode/restoreNode hasn't run yet
          }
          const state = nodeMods.interaction.ensureState(node, ctx);
          let changed = false;
          for (const row of state.rows) {
            if (row.kind === "seed" && mods.rows.applyAfterGenerate(row)) {
              changed = true;
            }
          }
          if (changed) {
            nodeMods.interaction.persistState(node, ctx);
            // `syncRows` (never a direct DOM poke) -- the row's kind/count/
            // order haven't changed, so this takes the CHEAP repaint-only
            // path (interaction.mjs's own contract), it's just the only
            // exported entry point that repaints.
            nodeMods.interaction.syncRows(node, ctx);
          }
        } catch (err) {
          console.error(`[AnimaFlow Controls] failed to advance seed(s) for node ${node.id}:`, err);
        }
      }
    })
    .catch((err) => {
      console.error("[AnimaFlow Controls] failed to load js/controls modules for seed advance:", err);
    });
}

/**
 * Wrap `app.queuePrompt` exactly once, AFTER the original resolves — so the
 * seed a queued prompt actually carried is guaranteed to be the one
 * `applyAfterGenerate` records as `lastUsed` before advancing it for next
 * time. Never wraps if `app.queuePrompt` isn't a function (a frontend build
 * that renamed/removed it) — the original is simply left alone rather than
 * throwing.
 *
 * The original's own return value/rejection is passed straight back to
 * whatever called `queuePrompt` UNMODIFIED — our advance step runs off a
 * SEPARATE `.then()` chain on a copy of that promise, with its own
 * try/catch (inside `advanceSeedsAfterRun`) and its own `.catch()` here, so
 * neither a queue failure nor a bug in our own advance step can ever surface
 * as (or suppress) an error from the real queuePrompt call.
 *
 * VERIFY-IN-COMFYUI: confirm this actually fires on the live frontend build
 * — this repo's test suite is headless (no real `app`/`app.queuePrompt`
 * exists under plain `node`), so "does wrapping `app.queuePrompt` here
 * actually intercept a real Queue Prompt click" can only be confirmed in a
 * live ComfyUI page.
 */
function installQueuePromptHook() {
  if (_queuePromptWrapped) {
    return;
  }
  if (typeof app.queuePrompt !== "function") {
    return;
  }
  _queuePromptWrapped = true;
  const original = app.queuePrompt;
  app.queuePrompt = function (...args) {
    const result = original.apply(this, args);
    Promise.resolve(result)
      .then(() => {
        advanceSeedsAfterRun();
      })
      .catch(() => {
        // The original queuePrompt's own rejection already reached the real
        // caller via `result` above -- this catch exists solely so a failed
        // queue never also runs the advance step, and never produces an
        // unhandled-rejection warning of its own doing so.
      });
    return result;
  };
}

function restoreNode(node, panelConfig, mods) {
  node._ctrlMods = mods;
  const ctx = node._ctrlCtx || buildCtx(panelConfig, mods);
  node._ctrlCtx = ctx;
  hideStateWidget(node, mods);
  mods.interaction.restoreStateFromWidget(node, ctx);
  node.widgets_start_y = 2;
  mods.interaction.syncRows(node, ctx);
  // Deliberately NO scheduleFit/fitNode here -- trust the size litegraph
  // already restored from the saved workflow (skill's "never resize on
  // load" rule; a clean workflow must not open "modified").
}

app.registerExtension({
  name: "webtoon.controls",

  beforeRegisterNodeDef(nodeType, nodeData) {
    // Cheap + internally guarded (installQueuePromptHook's own
    // `_queuePromptWrapped` flag) -- called on EVERY node type's
    // registration, not just ours, so it only actually installs once, the
    // first time `beforeRegisterNodeDef` runs for anything at all after
    // `app.queuePrompt` exists.
    installQueuePromptHook();

    const panelConfig = CLASS_TO_PANEL[nodeData.name];
    if (!panelConfig) {
      return;
    }
    if (nodeType.prototype._wtnControlsPatched) {
      return; // hot-reload guard
    }
    nodeType.prototype._wtnControlsPatched = true;

    const _created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = _created ? _created.apply(this, args) : undefined;
      const node = this;
      loadMods()
        .then((mods) => setupNode(node, panelConfig, mods))
        .catch((err) => {
          console.error("[AnimaFlow Controls] failed to load js/controls modules:", err);
        });
      return result;
    };

    const _configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      // Set BEFORE anything else runs (including the async mods load) --
      // `resolveAutoOnConnect`'s caller (onConnectionsChange, below) and
      // `scheduleFit`'s queued rAF must see this flag for the WHOLE loading
      // window, however long the (one-time, cached) import takes.
      this._ctrlConfiguring = true;
      const result = _configure ? _configure.apply(this, args) : undefined;
      const node = this;
      loadMods()
        .then((mods) => {
          restoreNode(node, panelConfig, mods);
        })
        .catch((err) => {
          console.error("[AnimaFlow Controls] failed to load js/controls modules:", err);
        })
        .finally(() => {
          node._ctrlConfiguring = false;
        });
      return result;
    };

    // Auto rows resolve on first user connection ONLY -- gated on
    // `!_ctrlConfiguring` so a workflow's link replay on load can never
    // rewrite a saved kind (design doc §6). Also a no-op if `mods` haven't
    // finished loading yet (an exceedingly narrow window right after node
    // creation) -- the row simply stays "auto" until the user reconnects.
    const _conn = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (type, slotIndex, isConnected, link) {
      if (type === 2 /* LiteGraph.OUTPUT */ && isConnected && !this._ctrlConfiguring && link && this._ctrlMods) {
        this._ctrlMods.interaction.resolveAutoOnConnect(this, this._ctrlCtx, slotIndex, link);
      }
      return _conn ? _conn.apply(this, arguments) : undefined;
    };

    // Second, type-independent line of defense against wiring into an
    // interior "hole" (a slot no row currently owns -- `interaction.mjs`'s
    // `syncOutputs`/`markSlotVacant`). `VACANT_SLOT_TYPE` already refuses
    // this at the engine level via `LiteGraph.isValidConnection` for any
    // NORMALLY-typed target, but litegraph (like this pack's own Python
    // `ANY` type) treats a wildcard-typed input as "connects to anything,
    // regardless of the output's type" -- so a community node with a "*"
    // input would otherwise still be able to bind a wire to a slot with no
    // row behind it. This hook asks the pack's own row state directly,
    // bypassing type matching altogether: a hole refuses a connection no
    // matter what the other end declares. A no-op (falls through to the
    // previous handler, or `true`) until `_ctrlMods` has loaded, same as
    // every other hook here.
    //
    // VERIFY-IN-COMFYUI: this pack has no local litegraph source to confirm
    // `onConnectOutput`'s exact call signature/return-value contract
    // against (the (outputIndex, inputType, inputSlot, inputNode,
    // inputIndex) shape and "return false to refuse" are the documented
    // convention this reasoning relies on) -- only a live drag-to-connect
    // attempt onto a known-vacant hole can confirm the connection is
    // actually refused, not just that `VACANT_SLOT_TYPE` blocks typed
    // targets.
    const _connectOutput = nodeType.prototype.onConnectOutput;
    nodeType.prototype.onConnectOutput = function (outputIndex, inputType, inputSlot, inputNode, inputIndex) {
      if (this._ctrlMods) {
        const state = this._ctrlMods.interaction.ensureState(this, this._ctrlCtx);
        const owned = state.rows.some((r) => r.slot === outputIndex + 1);
        if (!owned) {
          return false;
        }
      }
      return _connectOutput ? _connectOutput.apply(this, arguments) : true;
    };

    // Legacy: park each output dot at its OWN row widget's Y. arrange()
    // computes widget.y, so re-run it once positions are set -- the second
    // pass re-measures the slots with our pos in place (ComfyUI-Pixaroma's
    // `js/sliders/index.js` does the identical double-arrange for the same
    // reason). No-op until `mods` has loaded (nothing to align yet).
    const _arrange = nodeType.prototype.arrange;
    nodeType.prototype.arrange = function (...args) {
      const result = _arrange ? _arrange.apply(this, args) : undefined;
      if (this._ctrlMods) {
        this._ctrlMods.interaction.alignOutputsLegacy(this);
        if (_arrange) {
          _arrange.apply(this, args);
        }
      }
      return result;
    };

    // Strip render-time slot geometry before it lands in the saved
    // workflow -- meaningless in a different renderer, and rebuilt on
    // every arrange anyway (ComfyUI-Pixaroma's identical `serialize` patch).
    const _serialize = nodeType.prototype.serialize;
    nodeType.prototype.serialize = function (...args) {
      const o = _serialize ? _serialize.apply(this, args) : undefined;
      if (o && o.outputs) {
        for (const out of o.outputs) {
          if (out && out.pos) {
            delete out.pos;
          }
        }
      }
      return o;
    };

    const _removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      if (this._ctrlMods) {
        this._ctrlMods.interaction.closeActiveOverlay();
        // Explicit wheel-zoom-passthrough teardown rather than relying on
        // element garbage collection alone (js/shared/canvas_zoom.mjs's own
        // doc comment says GC is enough, but interaction.mjs's row-removal
        // teardown convention already does this explicitly for a rebuild,
        // so outright node deletion gets the same treatment for consistency).
        this._ctrlMods.interaction.teardownAllZoomPassthrough(this);
      }
      return _removed ? _removed.apply(this, args) : undefined;
    };
  },

  // Right-click "+ Add …" is already in-body (a themed dashed strip, not a
  // node menu item); the row-level Duplicate/Remove menu is a genuine
  // right-click ON the row, wired by interaction.mjs. No extension-level
  // getNodeMenuItems needed for this build.
});
