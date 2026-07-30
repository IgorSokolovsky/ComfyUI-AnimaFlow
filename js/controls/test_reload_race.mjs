/**
 * test_reload_race.mjs — reproduces the OWNER's exact recipe for the
 * stale-model bug (2026-07-30 course correction, superseding the earlier
 * "manual `graphToPrompt` makes it work" framing):
 *
 *   1. Hard refresh the page.
 *   2. Change a Loader Panel row's model. Queue. -> STALE model used.
 *   3. Make ANY structural mutation (add a row, remove a row -- anything
 *      that mutates the panel).
 *   4. Change the model again. Queue. -> works from then on.
 *
 * `js/controls/test_resize.mjs`'s own "core-mechanic audit" (2026-07-30,
 * search that file for the section by that name) tested a two-phase
 * `ensureState -> syncRows -> restoreStateFromWidget -> syncRows` sequence,
 * but called all four calls SYNCHRONOUSLY, back to back, with zero gap
 * between them. That is NOT `index.js`'s real shape: `onNodeCreated` and
 * `onConfigure` each register their OWN callback against `loadMods()`'s
 * SHARED, CACHED promise, and on an actual hard refresh (no warm module
 * cache) that promise resolves after a genuine dynamic `import()` -- a real
 * network fetch, not a same-tick resolution. `simulateAsyncReload` below
 * reproduces THAT shape instead: a real Promise gap, closed by an actual
 * `setTimeout` (a macrotask, not just a microtask tick) between
 * `onConfigure`'s SYNCHRONOUS restore (litegraph's own `configure()`, which
 * restores BOTH `widgets_values` AND `properties` from the saved workflow
 * file before any of this pack's async code ever runs) and the async
 * setupNode/restoreNode pair that follows once the shared promise settles.
 *
 * This file also directly measures three of the four candidates named in
 * the course-correction brief (the fourth -- "does litegraph ever REPLACE
 * `node.widgets` during/after `onConfigure`" -- is explicitly OUT OF REACH
 * of this headless harness; see that test's own comment for why).
 *
 * A separate, dedicated file rather than an addition to
 * `test_resize.mjs`: these are the first ASYNC (`await`-ing real
 * `setTimeout`) tests in this track, needing a `test()` that tolerates a
 * thenable `fn()` return value -- `js/anima/test_resize.mjs` already
 * carries that exact pattern (`pendingAsync`) for its own first async test
 * ("Save now"); copied here rather than changing `test_resize.mjs`'s
 * `test()` (already relied on synchronously by ~400 existing tests there).
 * The DOM/node/ctx stubs below are an independent copy of
 * `test_resize.mjs`'s own (mirroring that file's own "tracks stay
 * independent test modules" note about its relationship to
 * `test_lora_resize.mjs`/`js/anima/test_resize.mjs`) -- kept minimal (only
 * what this file's own tests actually touch).
 */

import assert from "node:assert/strict";

import { DEFAULT_W } from "./render.mjs";
import { getStateWidget, ensureState, restoreStateFromWidget, syncRows, closeActiveOverlay } from "./interaction.mjs";

// ---------------------------------------------------------------------------
// Test harness -- tolerates an async `fn()` (mirrors js/anima/test_resize.mjs's
// own `pendingAsync` pattern, independently copied per this file's own top
// doc comment).
// ---------------------------------------------------------------------------

const pendingAsync = [];
let failures = 0;
let count = 0;
function test(name, fn) {
  count += 1;
  closeActiveOverlay();
  const onFail = (err) => {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      pendingAsync.push(result.then(() => console.log(`ok - ${name}`), onFail));
      return;
    }
    console.log(`ok - ${name}`);
  } catch (err) {
    onFail(err);
  }
}

// ---------------------------------------------------------------------------
// Minimal DOM + fake-node stub (independent copy of test_resize.mjs's own --
// see this file's top doc comment).
// ---------------------------------------------------------------------------

function makeDocStub() {
  let doc;

  function makeElement(tag) {
    const el = {
      tagName: tag,
      _listeners: {},
      children: [],
      style: {},
      attributes: {},
      value: "",
      textContent: "",
      title: "",
      disabled: false,
      type: "",
      selected: false,
      parentNode: null,
      _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 240, height: 28 },
      get ownerDocument() {
        return doc;
      },
      classList: {
        _set: new Set(),
        add(...cls) {
          cls.forEach((c) => this._set.add(c));
        },
        remove(...cls) {
          cls.forEach((c) => this._set.delete(c));
        },
        contains(c) {
          return this._set.has(c);
        },
        toggle(c, force) {
          const on = force === undefined ? !this._set.has(c) : !!force;
          if (on) {
            this._set.add(c);
          } else {
            this._set.delete(c);
          }
          return on;
        },
      },
      setAttribute(name, val) {
        el.attributes[name] = val;
      },
      addEventListener(type, fn) {
        (el._listeners[type] = el._listeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = el._listeners[type];
        if (!arr) {
          return;
        }
        const i = arr.indexOf(fn);
        if (i >= 0) {
          arr.splice(i, 1);
        }
      },
      appendChild(child) {
        el.children.push(child);
        child.parentNode = el;
        return child;
      },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx >= 0) {
          el.children.splice(idx, 1);
        }
        child.parentNode = null;
        return child;
      },
      insertBefore(child, ref) {
        const idx = el.children.indexOf(ref);
        if (idx < 0) {
          el.children.push(child);
        } else {
          el.children.splice(idx, 0, child);
        }
        child.parentNode = el;
        return child;
      },
      contains(other) {
        let n = other;
        while (n) {
          if (n === el) {
            return true;
          }
          n = n.parentNode;
        }
        return false;
      },
      closest(selector) {
        const cls = selector.replace(/^\./, "");
        let n = el;
        while (n) {
          if (n.classList && n.classList.contains(cls)) {
            return n;
          }
          n = n.parentNode;
        }
        return null;
      },
      getBoundingClientRect() {
        return el._rect;
      },
      setPointerCapture() {},
      focus() {},
      select() {},
    };
    Object.defineProperty(el, "className", {
      get() {
        return [...el.classList._set].join(" ");
      },
      set(v) {
        el.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
      },
    });
    Object.defineProperty(el, "firstChild", {
      get() {
        return el.children.length ? el.children[0] : null;
      },
    });
    return el;
  }

  doc = {
    createElement: makeElement,
    getElementById(id) {
      return [...doc.head.children, ...doc.body.children].find((e) => e.id === id) || null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
  };
  return doc;
}

function makeWindowStub(doc) {
  const win = {
    _listeners: {},
    addEventListener(type, fn) {
      (win._listeners[type] = win._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = win._listeners[type];
      if (!arr) {
        return;
      }
      const i = arr.indexOf(fn);
      if (i >= 0) {
        arr.splice(i, 1);
      }
    },
    setTimeout(fn) {
      fn();
      return 0;
    },
  };
  doc.defaultView = win;
  return win;
}

function fire(el, type, evtOverrides = {}) {
  const e = {
    type,
    target: el,
    button: 0,
    stopPropagation() {},
    preventDefault() {},
    ...evtOverrides,
  };
  (el._listeners[type] || []).forEach((fn) => fn(e));
}

function makeFakeNode(initialStateJSON) {
  const node = {
    size: [DEFAULT_W, 100],
    properties: {},
    widgets: [{ name: "panel_state", value: initialStateJSON ?? "{}" }],
    outputs: [],
    _dirty: 0,
    _domHost: [],
    addDOMWidget(name, type, element, options) {
      node._domHost.push(element);
      const w = {
        name,
        type,
        element,
        options: { ...(options || {}) },
        serialize: true,
        y: undefined,
        margin: 10,
        onRemove() {
          const idx = node._domHost.indexOf(element);
          if (idx >= 0) {
            node._domHost.splice(idx, 1);
          }
        },
      };
      node.widgets.push(w);
      return w;
    },
    addOutput(name, type) {
      const out = { name, type, links: [] };
      node.outputs.push(out);
      return out;
    },
    removeOutput(idx) {
      node.outputs.splice(idx, 1);
    },
    setSize(size) {
      node.size = [size[0], size[1]];
    },
    setDirtyCanvas() {
      node._dirty += 1;
    },
  };
  return node;
}

function makeCtx(doc, panelConfig, overrides = {}) {
  return {
    panelConfig,
    doc,
    getKnownLists: overrides.getKnownLists || (() => ({})),
    describeLinkTarget: overrides.describeLinkTarget || (() => null),
    confirmRemove: overrides.confirmRemove || (() => true),
    isGraphLoading: overrides.isGraphLoading,
    getCanvasScale: overrides.getCanvasScale,
  };
}

const LOADER_PANEL_CONFIG = {
  key: "loader",
  stateProp: "loaderPanelState",
  catalog: ["unet", "vae", "clip"],
  allowAuto: false,
  reorder: false,
  addLabel: "+ Add loader",
};

// ---------------------------------------------------------------------------
// simulateAsyncReload -- `index.js`'s REAL onNodeCreated/onConfigure shape,
// with a genuine Promise gap closed by a real `setTimeout` (a macrotask).
// ---------------------------------------------------------------------------

/**
 * `savedProperties`, if given, is copied onto the fresh node's
 * `.properties` BEFORE either async callback runs -- modelling litegraph's
 * own synchronous `configure(info)`, which restores `node.properties`
 * straight from the saved workflow file's own `properties` blob (a plain
 * data copy, entirely independent of `widgets_values`) BEFORE any of this
 * pack's async code ever executes. Omit it to model a node whose saved
 * workflow never wrote a `properties` blob for this panel at all (an older
 * save, or the very first save of a freshly-placed node).
 *
 * The two `.then()` chains below are queued in the EXACT order and shape
 * `index.js` uses: `onNodeCreated`'s callback (`setupPromise`) is
 * registered FIRST (onNodeCreated always fires before onConfigure, per the
 * dynamic-node-frontend skill), and `_ctrlConfiguring` clears off
 * `restorePromise`'s OWN `.finally()` alone -- NEVER `Promise.all([setup,
 * restore]).finally()` -- matching `index.js`'s literal
 * `loadMods().then(restoreNode).catch(...).finally(() => configuring =
 * false)` chain, which never even references `setupPromise`.
 */
function simulateAsyncReload({ savedStateJSON, savedProperties, overrides, delayMs }) {
  const doc = makeDocStub();
  const node = makeFakeNode(savedStateJSON);
  if (savedProperties) {
    node.properties = JSON.parse(JSON.stringify(savedProperties));
  }
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, overrides);

  let resolveMods;
  const modsPromise = new Promise((resolve) => {
    resolveMods = resolve;
  });

  // onNodeCreated -- queued FIRST.
  const setupPromise = modsPromise.then(() => {
    ensureState(node, ctx);
    syncRows(node, ctx);
  });

  // onConfigure -- flag set SYNCHRONOUSLY (before either .then() body ever
  // runs), queued SECOND, clears independently of setupPromise.
  node._ctrlConfiguring = true;
  const restorePromise = modsPromise
    .then(() => {
      restoreStateFromWidget(node, ctx);
      syncRows(node, ctx);
    })
    .finally(() => {
      node._ctrlConfiguring = false;
    });

  // A real macrotask delay -- a cold dynamic import is a network fetch, not
  // a same-tick/microtask resolution. The exact delay shouldn't matter (see
  // the "delay-length-independence" test below) since nothing else is
  // scheduled to run concurrently in this single-node harness; several
  // delays are exercised anyway rather than assumed.
  setTimeout(resolveMods, delayMs ?? 5);

  return Promise.all([setupPromise, restorePromise]).then(() => ({ node, ctx, doc }));
}

// ---------------------------------------------------------------------------
// The repro itself.
// ---------------------------------------------------------------------------

function buildSavedLoaderPanel(overrides) {
  const savedDoc = makeDocStub();
  const saved = makeFakeNode();
  syncRows(saved, makeCtx(savedDoc, LOADER_PANEL_CONFIG, overrides));
  return { savedStateJSON: getStateWidget(saved).value, savedProperties: saved.properties };
}

async function runReproOnce(delayMs) {
  const overrides = {
    getKnownLists: () => ({
      unet: ["waiANIMA_v10Base10.safetensors", "nyaIrisAnima_base1V20.safetensors"],
      vae: ["v.safetensors"],
      clip: ["c.safetensors"],
    }),
  };
  const { savedStateJSON, savedProperties } = buildSavedLoaderPanel(overrides);

  const { node, ctx, doc } = await simulateAsyncReload({ savedStateJSON, savedProperties, overrides, delayMs });
  makeWindowStub(doc);

  const unetEntry = node._ctrlRows.find((e) => e.kind === "unet");
  assert.ok(unetEntry, "the restored panel must have a unet row to click on");
  assert.equal(unetEntry.refs.row.value, "waiANIMA_v10Base10.safetensors", "sanity: the restored row starts on the OLD model");

  fire(unetEntry.refs.combo, "click");
  const menu = doc.body.children[doc.body.children.length - 1];
  assert.ok(menu && menu.className.includes("wtn-ctl-overlay"), "the option-list menu must actually open");
  const opts = menu.children[0].children.filter((c) => c.className.includes("wtn-ctl-opt"));
  const target = opts.find((o) => o.textContent === "nyaIrisAnima_base1V20.safetensors");
  assert.ok(target, "the newly-picked model must actually be an option in the row's own list");
  fire(target, "click");

  const onScreenValue = unetEntry.refs.row.value;
  const persistedUnet = JSON.parse(getStateWidget(node).value).rows.find((r) => r.kind === "unet");
  closeActiveOverlay();
  return { onScreenValue, persistedValue: persistedUnet && persistedUnet.value, ctx };
}

test("ASYNC repro (delayMs=5): the FIRST edit after a REAL, setTimeout-delayed loadMods() gap -- modelling a hard refresh's cold dynamic import, not the previous audit's synchronous back-to-back sequence", async () => {
  const { onScreenValue, persistedValue } = await runReproOnce(5);
  assert.equal(onScreenValue, "nyaIrisAnima_base1V20.safetensors", "the owner's own observation: 'the row shows it'");
  assert.equal(
    persistedValue,
    "nyaIrisAnima_base1V20.safetensors",
    "the FIRST edit after the real async reload gap must reach the SERIALIZED panel_state widget -- this is the owner's actual repro target",
  );
});

test("ASYNC repro, delay-length-independence: a 0ms, 5ms, and 50ms loadMods() gap all behave IDENTICALLY -- nothing else is scheduled concurrently in this single-node harness, so if the race were timing-sensitive this would show it", async () => {
  for (const delayMs of [0, 5, 50]) {
    const { onScreenValue, persistedValue } = await runReproOnce(delayMs);
    assert.equal(onScreenValue, "nyaIrisAnima_base1V20.safetensors", `delayMs=${delayMs}`);
    assert.equal(persistedValue, "nyaIrisAnima_base1V20.safetensors", `delayMs=${delayMs}`);
  }
});

// ---------------------------------------------------------------------------
// The four candidates named in the course-correction brief, measured
// directly (not re-derived from the repro above).
// ---------------------------------------------------------------------------

test("candidate 1: no row DOM exists AT ALL until loadMods() resolves -- there is nothing to click DURING the async gap in the first place (the user's first possible edit is necessarily AFTER both callbacks have already run)", async () => {
  const overrides = { getKnownLists: () => ({ unet: ["a.safetensors"], vae: ["v.safetensors"], clip: ["c.safetensors"] }) };
  const doc = makeDocStub();
  const node = makeFakeNode();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, overrides);

  let resolveMods;
  const modsPromise = new Promise((resolve) => {
    resolveMods = resolve;
  });
  node._ctrlConfiguring = true;
  const done = modsPromise.then(() => {
    ensureState(node, ctx);
    syncRows(node, ctx);
  });

  assert.equal(node._ctrlRows, undefined, "no rows exist yet during the gap");
  assert.equal(node._domHost.length, 0, "no DOM-widget elements mounted yet during the gap -- nothing renders, so nothing is clickable");

  resolveMods();
  await done;
  assert.ok(node._ctrlRows && node._ctrlRows.length > 0, "sanity check: rows DO exist once the promise actually resolves");
});

test("candidate 2: _ctrlConfiguring is ALWAYS false by the time the restored DOM exists (and therefore before the first possible user interaction) -- never fails to clear, never clears late", async () => {
  const overrides = {
    getKnownLists: () => ({ unet: ["a.safetensors"], vae: ["v.safetensors"], clip: ["c.safetensors"] }),
  };
  const { savedStateJSON, savedProperties } = buildSavedLoaderPanel(overrides);
  const { node } = await simulateAsyncReload({ savedStateJSON, savedProperties, overrides, delayMs: 5 });
  // This assertion runs AFTER `simulateAsyncReload`'s own returned promise
  // resolves, which itself only resolves after restorePromise's `.finally()`
  // (the one place `_ctrlConfiguring` is ever cleared) has already run.
  assert.equal(node._ctrlConfiguring, false);
});

test("candidate 3: the widget object OUR code holds after the restore is the SAME object present from construction (never replaced by anything in THIS pack's own JS) -- LIMITATION: this only proves our own code never swaps node.widgets; it cannot observe whether the REAL litegraph/ComfyUI runtime ever does, since that lives entirely outside this headless harness's reach", async () => {
  const overrides = { getKnownLists: () => ({ unet: ["a.safetensors"], vae: ["v.safetensors"], clip: ["c.safetensors"] }) };
  const { savedStateJSON, savedProperties } = buildSavedLoaderPanel(overrides);

  const doc = makeDocStub();
  const node = makeFakeNode(savedStateJSON);
  if (savedProperties) {
    node.properties = JSON.parse(JSON.stringify(savedProperties));
  }
  const widgetAtConstruction = node.widgets[0];
  assert.equal(widgetAtConstruction.name, "panel_state");

  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, overrides);
  let resolveMods;
  const modsPromise = new Promise((resolve) => {
    resolveMods = resolve;
  });
  const setupPromise = modsPromise.then(() => {
    ensureState(node, ctx);
    syncRows(node, ctx);
  });
  node._ctrlConfiguring = true;
  const restorePromise = modsPromise
    .then(() => {
      restoreStateFromWidget(node, ctx);
      syncRows(node, ctx);
    })
    .finally(() => {
      node._ctrlConfiguring = false;
    });
  setTimeout(resolveMods, 5);
  await Promise.all([setupPromise, restorePromise]);

  assert.equal(getStateWidget(node), widgetAtConstruction, "getStateWidget must still return the SAME widget object after the full async restore sequence");
});

test("candidate 4: exactly one 'panel_state' widget exists after the full async restore sequence -- our own ensureState/restoreStateFromWidget/syncRows code never creates a duplicate (graphToPrompt's 'last one wins while .find() returns the first' failure mode requires a duplicate to exist at all)", async () => {
  const overrides = { getKnownLists: () => ({ unet: ["a.safetensors"], vae: ["v.safetensors"], clip: ["c.safetensors"] }) };
  const { savedStateJSON, savedProperties } = buildSavedLoaderPanel(overrides);
  const { node } = await simulateAsyncReload({ savedStateJSON, savedProperties, overrides, delayMs: 5 });
  const panelStateWidgets = node.widgets.filter((w) => w.name === "panel_state");
  assert.equal(panelStateWidgets.length, 1);
});

await Promise.all(pendingAsync);

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
