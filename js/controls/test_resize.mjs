/**
 * test_resize.mjs — regression tests for `render.mjs` (DOM building/CSS/
 * resize) and `interaction.mjs` (event wiring + node-level orchestration)
 * for the Control Panel / Loader Panel nodes. Runs under plain `node` via a
 * small DOM + fake-litegraph-node stub (same pattern as
 * `js/prompt_rules/node/test_resize.mjs`), never imports `index.js`
 * directly (it needs a real `app`/`window.LiteGraph`, which only exist in
 * an actual ComfyUI page).
 *
 * Covers:
 *   A. render.mjs — CSS injection, `buildRowElement`'s per-kind DOM shape,
 *      `paintRow`, `buildAddRow`, `bodyHeight` arithmetic, `openOverlay`'s
 *      row-anchored positioning + outside-click/Escape close.
 *   B. interaction.mjs's state <-> hidden-widget handshake — `ensureState`
 *      initializes from the widget's current value (or defaults), never
 *      re-parses on a second call (row identity stability);
 *      `restoreStateFromWidget` force-reparses (the `onConfigure` path);
 *      `persistState` mirrors into the widget and never elsewhere.
 *   C. `syncRows`/`syncOutputs`/`alignOutputsLegacy` — row DOM widgets
 *      created 1:1 with state rows, output slots sized to the HIGHEST slot
 *      in use (not `rows.length`), types narrowed per row, dots parked at
 *      each row widget's own Y.
 *   D. Structural mutations — `addRowAndSync`/`duplicateRowAndSync`/
 *      `removeRowAndSync` (slot reuse, confirm-before-remove-a-linked-row,
 *      MAX_ROWS refusal) and `resolveAutoOnConnect` (auto -> resolved kind
 *      on first connection, gated by the caller on `_ctrlConfiguring`).
 *   E. End-to-end row interaction through REAL wired DOM elements (fired
 *      via a stub `fire()`) — the combo stepper/list, the seed mode/N
 *      buttons, the numeric drag, the latent ⚙ popover's ratio/tier grid,
 *      the row context menu, and a full grip drag-reorder sequence that
 *      never rebuilds the dragged row's own DOM mid-drag.
 *   F. Resize — `fitNode`/`scheduleFit` size the node from `bodyHeight`
 *      (row count only, never a DOM measurement), gated off during
 *      `_ctrlConfiguring`.
 *
 * MANUAL-IN-COMFYUI CHECKLIST (this headless harness cannot confirm any of
 * this — the real `addDOMWidget`/legacy-litegraph runtime contract, actual
 * screen-space overlay placement, and actual socket-type wire refusal only
 * exist live):
 *   [ ] A fresh Control Panel / Loader Panel node renders with the house
 *       theme applied (`.wtn` + `injectTheme()` actually landing).
 *   [ ] `panel_state` widget is invisible on the node face but its value is
 *       present in the saved workflow JSON / the queued API prompt.
 *   [ ] Dragging a row by its grip visually reorders it with NO wire
 *       jumping to a different input; the output dot's tooltip slot number
 *       matches before and after the drag.
 *   [ ] The ⚙ popover / option-list menu / context menu actually appear
 *       beside/below the correct row on screen (not just at the coordinates
 *       this test asserts against a fake `getBoundingClientRect`).
 *   [ ] Combo output type ("COMBO" vs the joined list vs "*") actually lets
 *       a wire land on a KSampler's converted `sampler_name` input — see
 *       `rows.mjs`'s `COMBO_TYPE_STRATEGY`, VERIFY-IN-COMFYUI.
 *   [ ] A freed slot's inert output gap renders acceptably (falls back to
 *       litegraph's default corner-stacking) rather than looking broken.
 */

import assert from "node:assert/strict";

import {
  KIND_META,
  MAX_ROWS,
  ZW,
  mkRow,
  assignSlot,
} from "./rows.mjs";

import {
  injectStyles,
  buildRowElement,
  buildAddRow,
  paintRow,
  openOverlay,
  bodyHeight,
  ROW_H,
  ROW_GAP,
  ADD_H,
  MIN_W,
  DEFAULT_W,
} from "./render.mjs";

import {
  getStateWidget,
  ensureState,
  restoreStateFromWidget,
  persistState,
  rowCountOf,
  syncRows,
  syncOutputs,
  alignOutputsLegacy,
  fitNode,
  scheduleFit,
  addRowAndSync,
  duplicateRowAndSync,
  removeRowAndSync,
  resolveAutoOnConnect,
  closeActiveOverlay,
} from "./interaction.mjs";

let failures = 0;
let count = 0;
function test(name, fn) {
  count += 1;
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

// ---------------------------------------------------------------------------
// Minimal DOM + window stub (mirrors js/prompt_rules/node/test_resize.mjs's
// makeDocStub, extended with getBoundingClientRect/closest/contains/
// insertBefore -- everything this feature's overlays/drag/click wiring uses).
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
      _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 240, height: ROW_H },
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
    // Deferred-to-immediate: this test never depends on the real ordering
    // openOverlay's setTimeout(0) is there for (avoiding the SAME click that
    // opened an overlay from also closing it) -- tests close overlays
    // explicitly via handle.close() instead of simulating that race.
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

function fireWin(win, type, evtOverrides = {}) {
  const e = { type, stopPropagation() {}, preventDefault() {}, ...evtOverrides };
  (win._listeners[type] || []).slice().forEach((fn) => fn(e));
}

// ---------------------------------------------------------------------------
// Fake litegraph node
// ---------------------------------------------------------------------------

function makeFakeNode(initialStateJSON) {
  const node = {
    size: [DEFAULT_W, 100],
    properties: {},
    widgets: [{ name: "panel_state", value: initialStateJSON ?? "{}" }],
    outputs: [],
    _dirty: 0,
    addDOMWidget(name, type, element) {
      const w = { name, type, element, options: {}, serialize: true, y: undefined, margin: 10 };
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
      node.size = size.slice();
    },
    setDirtyCanvas() {
      node._dirty += 1;
    },
  };
  return node;
}

/** Assign each row widget a `.y` as if litegraph had already laid out the
 * body top-to-bottom (index * (ROW_H+ROW_GAP)) -- mirrors what a real
 * `arrange()` pass would produce, so `alignOutputsLegacy` has something
 * real to read. */
function fakeArrange(node) {
  (node._ctrlRows || []).forEach((entry, i) => {
    if (entry.widget) {
      entry.widget.y = i * (ROW_H + ROW_GAP);
    }
  });
}

function makeCtx(doc, panelConfig, overrides = {}) {
  return {
    panelConfig,
    doc,
    getKnownLists: overrides.getKnownLists || (() => ({})),
    describeLinkTarget: overrides.describeLinkTarget || (() => null),
    confirmRemove: overrides.confirmRemove || (() => true),
  };
}

const CONTROL_PANEL_CONFIG = {
  key: "control",
  stateProp: "controlPanelState",
  catalog: ["sampler", "scheduler", "seed", "int", "float", "latent"],
  allowAuto: true,
  reorder: true,
  addLabel: "+ Add control",
};

const LOADER_PANEL_CONFIG = {
  key: "loader",
  stateProp: "loaderPanelState",
  catalog: ["unet", "vae", "clip"],
  allowAuto: false,
  reorder: false,
  addLabel: "+ Add loader",
};

// =========================================================================
// A. render.mjs
// =========================================================================

test("injectStyles is idempotent and safe against a doc with no head", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  injectStyles(doc);
  assert.equal(doc.head.children.filter((c) => c.id === "wtn-controls-style").length, 1);
});

test("buildRowElement: a combo row (sampler) gets a stepper + combo + caret + gear? no gear + dot", () => {
  const doc = makeDocStub();
  const row = mkRow("sampler", { value: "euler" });
  const refs = buildRowElement(doc, row, KIND_META.sampler, CONTROL_PANEL_CONFIG);
  assert.ok(refs.stepLeft && refs.stepRight && refs.combo && refs.val && refs.caret);
  assert.equal(refs.gear, undefined); // sampler has hasGear:false
  assert.ok(refs.grip); // control panel has reorder:true
  assert.ok(refs.dot);
});

test("buildRowElement: a seed row gets val + mode button + N button + gear", () => {
  const doc = makeDocStub();
  const row = mkRow("seed");
  const refs = buildRowElement(doc, row, KIND_META.seed, CONTROL_PANEL_CONFIG);
  assert.ok(refs.val && refs.modeBtn && refs.newBtn && refs.gear);
});

test("buildRowElement: an int row gets a fill + val, no gear", () => {
  const doc = makeDocStub();
  const row = mkRow("int");
  const refs = buildRowElement(doc, row, KIND_META.int, CONTROL_PANEL_CONFIG);
  assert.ok(refs.fill && refs.val);
  assert.equal(refs.gear, undefined);
  assert.ok(refs.root.classList.contains("wtn-ctl-slider"));
});

test("buildRowElement: an auto row has no value area at all", () => {
  const doc = makeDocStub();
  const row = mkRow("auto");
  const refs = buildRowElement(doc, row, KIND_META.auto, CONTROL_PANEL_CONFIG);
  assert.equal(refs.val, undefined);
  assert.ok(refs.root.classList.contains("wtn-ctl-auto"));
});

test("buildRowElement: the Loader Panel (reorder:false) never builds a grip", () => {
  const doc = makeDocStub();
  const row = mkRow("unet");
  const refs = buildRowElement(doc, row, KIND_META.unet, LOADER_PANEL_CONFIG);
  assert.equal(refs.grip, undefined);
  assert.ok(refs.gear); // unet HAS a gear (weight_dtype)
});

test("paintRow: combo row shows the current value from the option list", () => {
  const doc = makeDocStub();
  const row = mkRow("sampler", { value: "dpmpp_2m" });
  const refs = buildRowElement(doc, row, KIND_META.sampler, CONTROL_PANEL_CONFIG);
  paintRow(refs, row, ["euler", "dpmpp_2m"], null);
  assert.equal(refs.val.textContent, "dpmpp_2m");
});

test("paintRow: a disabled (def-missing) combo row shows 'unavailable' and sets the disabled reason", () => {
  const doc = makeDocStub();
  const row = mkRow("unet");
  const refs = buildRowElement(doc, row, KIND_META.unet, LOADER_PANEL_CONFIG);
  paintRow(refs, row, null, "UNETLoader not installed");
  assert.equal(refs.val.textContent, "unavailable");
  assert.ok(refs.root.classList.contains("wtn-ctl-disabled"));
});

test("paintRow: numeric row's fill width reflects numericPercent", () => {
  const doc = makeDocStub();
  const row = mkRow("int", { value: 25, opts: { min: 0, max: 100, step: 1 } });
  const refs = buildRowElement(doc, row, KIND_META.int, CONTROL_PANEL_CONFIG);
  paintRow(refs, row, null, null);
  assert.equal(refs.fill.style.width, "25%");
  assert.equal(refs.val.textContent, "25");
});

test("paintRow: seed row reflects the mode letter and 'on' state", () => {
  const doc = makeDocStub();
  const row = mkRow("seed", { value: "42", opts: { after: "decrement", lastMode: "decrement" } });
  const refs = buildRowElement(doc, row, KIND_META.seed, CONTROL_PANEL_CONFIG);
  paintRow(refs, row, null, null);
  assert.equal(refs.modeBtn.textContent, "D");
  assert.ok(refs.modeBtn.classList.contains("wtn-ctl-on"));
});

test("paintRow: latent row's dim span shows the ratio only in predefined mode", () => {
  const doc = makeDocStub();
  const row = mkRow("latent", { opts: { mode: "predefined", ratio: "2:3", tier: 1024, w: 832, h: 1216, batch: 1 } });
  const refs = buildRowElement(doc, row, KIND_META.latent, CONTROL_PANEL_CONFIG);
  paintRow(refs, row, null, null);
  assert.equal(refs.dim.textContent, "(2:3)");
});

test("buildAddRow builds a themed button with the given label", () => {
  const doc = makeDocStub();
  const { root } = buildAddRow(doc, "+ Add control");
  assert.equal(root.textContent, "+ Add control");
  assert.ok(root.className.includes("wtn-ctl-add"));
});

test("bodyHeight is pure arithmetic on row count (no DOM needed)", () => {
  assert.equal(bodyHeight(0), 9 * 2 + ADD_H);
  assert.equal(bodyHeight(3), 9 * 2 + 3 * (ROW_H + ROW_GAP) + ADD_H);
  assert.ok(bodyHeight(3) > bodyHeight(2)); // strictly grows with row count
});

test("openOverlay positions BELOW the anchor at its own width, and RIGHT of it for a popover", () => {
  const doc = makeDocStub();
  makeWindowStub(doc);
  const anchor = doc.createElement("div");
  anchor._rect = { left: 10, top: 20, right: 250, bottom: 50, width: 240, height: 30 };
  const content = doc.createElement("div");
  const handle = openOverlay(doc, anchor, content, "below");
  assert.equal(handle.overlay.style.left, "10px");
  assert.equal(handle.overlay.style.top, "56px"); // bottom + 6
  assert.equal(handle.overlay.style.width, "240px");
  handle.close();

  const content2 = doc.createElement("div");
  const handle2 = openOverlay(doc, anchor, content2, "right");
  assert.equal(handle2.overlay.style.left, "260px"); // right + 10
  assert.equal(handle2.overlay.style.top, "20px");
  handle2.close();
});

test("openOverlay closes on an outside pointerdown and never on a click inside itself", () => {
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const anchor = doc.createElement("div");
  const content = doc.createElement("div");
  let closed = 0;
  const handle = openOverlay(doc, anchor, content, "below", () => {
    closed += 1;
  });
  fireWin(win, "pointerdown", { target: content }); // inside -- must NOT close
  assert.equal(closed, 0);
  const outside = doc.createElement("div");
  fireWin(win, "pointerdown", { target: outside });
  assert.equal(closed, 1);
});

test("openOverlay closes on Escape", () => {
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const anchor = doc.createElement("div");
  const content = doc.createElement("div");
  let closed = 0;
  openOverlay(doc, anchor, content, "below", () => {
    closed += 1;
  });
  fireWin(win, "keydown", { key: "Escape" });
  assert.equal(closed, 1);
});

// =========================================================================
// B. interaction.mjs -- state <-> hidden widget handshake
// =========================================================================

test("ensureState initializes from the widget's current JSON the first time, then caches the SAME object", () => {
  const node = makeFakeNode(JSON.stringify({ version: 1, rows: [{ slot: 1, kind: "int", value: 5, opts: { min: 0, max: 10, step: 1 } }] }));
  const ctx = makeCtx(makeDocStub(), CONTROL_PANEL_CONFIG);
  const first = ensureState(node, ctx);
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].kind, "int");
  const second = ensureState(node, ctx);
  assert.equal(second, first); // same object -- no re-parse
});

test("ensureState defaults to a valid empty control-panel state for garbage/empty widget value", () => {
  const node = makeFakeNode("{}");
  const ctx = makeCtx(makeDocStub(), CONTROL_PANEL_CONFIG);
  assert.deepEqual(ensureState(node, ctx).rows, []);
});

test("restoreStateFromWidget FORCES a fresh parse (the onConfigure path) even if properties already held something else", () => {
  const node = makeFakeNode(JSON.stringify({ version: 1, rows: [{ slot: 1, kind: "seed", value: "9", opts: { after: "fixed", lastMode: "fixed" } }] }));
  const ctx = makeCtx(makeDocStub(), CONTROL_PANEL_CONFIG);
  node.properties.controlPanelState = { version: 1, rows: [] }; // stale/wrong prior state
  const restored = restoreStateFromWidget(node, ctx);
  assert.equal(restored.rows.length, 1);
  assert.equal(restored.rows[0].kind, "seed");
});

test("persistState writes the CURRENT state JSON into the panel_state widget and marks the canvas dirty", () => {
  const node = makeFakeNode("{}");
  const ctx = makeCtx(makeDocStub(), CONTROL_PANEL_CONFIG);
  const state = ensureState(node, ctx);
  state.rows.push({ id: 1, slot: 1, kind: "int", name: "steps", value: 5, opts: { min: 0, max: 10, step: 1 } });
  persistState(node, ctx);
  const parsed = JSON.parse(getStateWidget(node).value);
  assert.equal(parsed.rows[0].kind, "int");
  assert.ok(node._dirty > 0);
});

// =========================================================================
// C. syncRows / syncOutputs / alignOutputsLegacy
// =========================================================================

test("syncRows builds one DOM row widget per state row PLUS the add-row widget", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // defaultState(loader) = unet+vae+clip
  assert.equal(node._ctrlRows.length, 3);
  assert.equal(node._ctrlAddWidget.element.textContent, "+ Add loader");
  // widgets array holds: panel_state + 3 rows + add
  assert.equal(node.widgets.length, 5);
});

test("syncOutputs sizes node.outputs to the HIGHEST slot in use, not to rows.length", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const state = ensureState(node, ctx);
  state.rows.push({ id: 1, slot: 1, kind: "int", name: "a", value: 1, opts: { min: 0, max: 10, step: 1 } });
  state.rows.push({ id: 2, slot: 5, kind: "float", name: "b", value: 1, opts: { min: 0, max: 10, step: 1 } }); // a gap at 2/3/4
  persistState(node, ctx);
  syncRows(node, ctx);
  assert.equal(node.outputs.length, 5);
  assert.equal(node.outputs[0].type, "INT"); // slot 1
  assert.equal(node.outputs[4].type, "FLOAT"); // slot 5
  assert.equal(node.outputs[0].name, ZW);
});

test("syncOutputs narrows types per kind, and 'auto' stays '*'", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  addRowAndSync(node, ctx, "latent");
  addRowAndSync(node, ctx, "sampler");
  addRowAndSync(node, ctx, "auto");
  const state = ensureState(node, ctx);
  assert.equal(node.outputs[state.rows[0].slot - 1].type, "LATENT");
  assert.equal(node.outputs[state.rows[1].slot - 1].type, "COMBO");
  assert.equal(node.outputs[state.rows[2].slot - 1].type, "*");
});

test("alignOutputsLegacy parks each row's dot at its OWN widget's Y, offset by margin + half a row", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // unet/vae/clip, slots 1/2/3
  fakeArrange(node);
  alignOutputsLegacy(node);
  node._ctrlRows.forEach((entry, i) => {
    const out = node.outputs[entry.refs.row.slot - 1];
    assert.equal(out.pos[1], i * (ROW_H + ROW_GAP) + 10 + ROW_H * 0.5);
    assert.equal(out.pos[0], node.size[0]);
  });
});

// =========================================================================
// D. Structural mutations
// =========================================================================

test("addRowAndSync appends a row, refuses past MAX_ROWS", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows already (unet/vae/clip)
  for (let i = 0; i < MAX_ROWS.loader - 3; i += 1) {
    assert.ok(addRowAndSync(node, ctx, "unet"));
  }
  assert.equal(ensureState(node, ctx).rows.length, MAX_ROWS.loader);
  assert.equal(addRowAndSync(node, ctx, "unet"), null);
});

test("duplicateRowAndSync inserts a copy right after the original with a fresh slot, and its own DOM widget", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "int");
  const copy = duplicateRowAndSync(node, ctx, row.id);
  assert.ok(copy);
  assert.notEqual(copy.slot, row.slot);
  assert.equal(node._ctrlRows.length, 2);
  assert.equal(node.outputs.length, 2);
});

test("removeRowAndSync frees the slot and rebuilds the widget list", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const a = addRowAndSync(node, ctx, "int");
  addRowAndSync(node, ctx, "float");
  assert.ok(removeRowAndSync(node, ctx, a.id));
  assert.equal(node._ctrlRows.length, 1);
  const nextRow = addRowAndSync(node, ctx, "int");
  assert.equal(nextRow.slot, a.slot); // reused, not a new high number
});

test("removeRowAndSync asks ctx.confirmRemove before dropping a row with a live link, and respects a 'no'", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  let asked = false;
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, {
    confirmRemove: () => {
      asked = true;
      return false;
    },
  });
  const row = addRowAndSync(node, ctx, "int");
  node.outputs[row.slot - 1].links = [123]; // pretend something is wired
  const result = removeRowAndSync(node, ctx, row.id);
  assert.equal(result, false);
  assert.ok(asked);
  assert.equal(node._ctrlRows.length, 1); // still there
});

test("resolveAutoOnConnect resolves an auto row via ctx.describeLinkTarget and rebuilds its DOM", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, {
    describeLinkTarget: () => ({ type: "INT", name: "steps", min: 1, max: 100, step2: 1, value: 20 }),
  });
  const row = addRowAndSync(node, ctx, "auto");
  const ok = resolveAutoOnConnect(node, ctx, row.slot - 1, { target_id: 1, target_slot: 0 });
  assert.ok(ok);
  assert.equal(ensureState(node, ctx).rows[0].kind, "int");
  // The DOM widget for that row was rebuilt to match the new kind (has a fill now).
  assert.ok(node._ctrlRows[0].refs.fill);
});

test("resolveAutoOnConnect is a no-op if the row isn't 'auto' or describeLinkTarget returns null", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG); // default describeLinkTarget -> null
  const row = addRowAndSync(node, ctx, "int");
  assert.equal(resolveAutoOnConnect(node, ctx, row.slot - 1, {}), false);
});

// =========================================================================
// E. End-to-end row interaction through real wired DOM
// =========================================================================

test("combo row: clicking the steppers cycles the value and persists it", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m", "ddim"] }) });
  addRowAndSync(node, ctx, "sampler");
  const refs = node._ctrlRows[0].refs;
  const row = refs.row;
  assert.equal(row.value, "euler");
  fire(refs.stepRight, "click");
  assert.equal(row.value, "dpmpp_2m");
  fire(refs.stepLeft, "click");
  assert.equal(row.value, "euler");
  assert.equal(JSON.parse(getStateWidget(node).value).rows[0].value, "euler");
});

test("combo row: clicking the value opens the option list, and picking one closes it and updates the row", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ scheduler: ["normal", "karras"] }) });
  addRowAndSync(node, ctx, "scheduler");
  const refs = node._ctrlRows[0].refs;
  fire(refs.combo, "click");
  const menu = doc.body.children[doc.body.children.length - 1];
  assert.ok(menu.className.includes("wtn-ctl-overlay"));
  const opts = menu.children[0].children.filter((c) => c.className.includes("wtn-ctl-opt"));
  assert.equal(opts.length, 2);
  fire(opts[1], "click");
  assert.equal(refs.row.value, "karras");
  closeActiveOverlay();
});

test("seed row: mode button toggles to fixed and back to lastMode; N rolls a new seed and parks at fixed", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "seed");
  const refs = node._ctrlRows[0].refs;
  const row = refs.row;
  row.opts.after = "decrement";
  row.opts.lastMode = "decrement";
  fire(refs.modeBtn, "click");
  assert.equal(row.opts.after, "fixed");
  fire(refs.modeBtn, "click");
  assert.equal(row.opts.after, "decrement"); // back to lastMode, not randomize
  const before = row.value;
  fire(refs.newBtn, "click");
  assert.notEqual(row.value, before);
  assert.equal(row.opts.after, "fixed");
  assert.equal(row.opts.lastMode, "decrement");
});

test("numeric row: dragging across the row sets the value proportionally and persists on release", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  const refs = node._ctrlRows[0].refs;
  refs.row.opts = { min: 0, max: 100, step: 1 };
  refs.root._rect = { left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30 };
  fire(refs.root, "pointerdown", { clientX: 100, button: 0 }); // 50%
  assert.equal(refs.row.value, 50);
  fire(refs.root, "pointermove", { clientX: 20 }); // 10%
  assert.equal(refs.row.value, 10);
  fire(refs.root, "pointerup");
  assert.equal(JSON.parse(getStateWidget(node).value).rows[0].value, 10);
});

test("numeric row: a pointerdown starting on the gear never starts a drag (int/float have none, but guard is generic)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "float");
  const refs = node._ctrlRows[0].refs;
  const gearLike = doc.createElement("span");
  gearLike.className = "wtn-ctl-gear";
  refs.root.appendChild(gearLike);
  const before = refs.row.value;
  fire(refs.root, "pointerdown", { clientX: 999, target: gearLike });
  assert.equal(refs.row.value, before); // unchanged -- drag never started
});

test("latent ⚙ popover: picking a ratio updates dims and preserves the current tier", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "latent");
  const refs = node._ctrlRows[0].refs;
  refs.row.opts.tier = 1328;
  fire(refs.gear, "click");
  const pop = doc.body.children[doc.body.children.length - 1].children[0];
  // pop.children = [h4, seg, mid, batchField, popfoot] -- the ratio grid
  // lives INSIDE `mid` (index 2), swapped in/out by Custom/Predefined.
  const mid = pop.children[2];
  const ratioGrid = mid.children.find((c) => c.className && c.className.includes("wtn-ctl-ratios"));
  assert.ok(ratioGrid, "expected a ratio grid in predefined mode");
  const sixteenNine = ratioGrid.children.find((b) => b.children.some((c) => c.textContent === "16:9"));
  fire(sixteenNine, "click");
  assert.equal(refs.row.opts.ratio, "16:9");
  assert.equal(refs.row.opts.tier, 1328); // tier preserved across a ratio change
  closeActiveOverlay();
});

test("latent ⚙ popover: switching to Custom shows width/height inputs that write straight into opts", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "latent");
  const refs = node._ctrlRows[0].refs;
  fire(refs.gear, "click");
  const pop = doc.body.children[doc.body.children.length - 1].children[0];
  const seg = pop.children.find((c) => c.className && c.className.includes("wtn-ctl-seg"));
  const [customBtn] = seg.children;
  fire(customBtn, "click");
  assert.equal(refs.row.opts.mode, "custom");
  const mid = pop.children[2]; // pop.children = [h4, seg, mid, batchField, popfoot]
  const wh = mid.children.find((c) => c.className && c.className.includes("wtn-ctl-wh"));
  assert.ok(wh, "expected width/height fields in custom mode");
  const widthInput = wh.children[0].children[0];
  widthInput.value = "900";
  fire(widthInput, "change");
  assert.equal(refs.row.opts.w, 896); // snap16(900)
  closeActiveOverlay();
});

test("context menu: Duplicate and Remove row both work from the row's right-click menu", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "int");
  let refs = node._ctrlRows[0].refs;
  fire(refs.root, "contextmenu");
  const menu = doc.body.children[doc.body.children.length - 1].children[0];
  const dup = menu.children.find((c) => c.textContent && c.textContent.startsWith("Duplicate"));
  fire(dup, "click");
  assert.equal(node._ctrlRows.length, 2);

  refs = node._ctrlRows[1].refs;
  fire(refs.root, "contextmenu");
  const menu2 = doc.body.children[doc.body.children.length - 1].children[0];
  const del = menu2.children.find((c) => c.textContent === "Remove row");
  fire(del, "click");
  assert.equal(node._ctrlRows.length, 1);
});

test("grip drag-reorder: a full pointer sequence reorders rows WITHOUT rebuilding the dragged row's DOM", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  addRowAndSync(node, ctx, "float");
  addRowAndSync(node, ctx, "seed");
  fakeArrange(node);
  const originalIds = node._ctrlRows.map((e) => e.id);
  const draggedRefs = node._ctrlRows[0].refs; // the "int" row
  const draggedWidget = node._ctrlRows[0].widget;

  fire(draggedRefs.grip, "pointerdown", { clientY: 0 });
  assert.ok(draggedRefs.root.classList.contains("wtn-ctl-dragging"));
  // Move down two rows' worth -- STEP = ROW_H + ROW_GAP (see interaction.mjs).
  fireWin(win, "pointermove", { clientY: 2 * (ROW_H + ROW_GAP) });
  fireWin(win, "pointerup");

  assert.ok(!draggedRefs.root.classList.contains("wtn-ctl-dragging"));
  const newIds = node._ctrlRows.map((e) => e.id);
  assert.deepEqual(newIds, [originalIds[1], originalIds[2], originalIds[0]]);
  // The dragged row's DOM widget instance is UNCHANGED (no rebuild happened).
  assert.equal(node._ctrlRows[2].widget, draggedWidget);
  // Slots never moved with the row -- still 1/2/3, now just in a new order.
  assert.deepEqual(
    node._ctrlRows.map((e) => e.refs.row.slot).sort(),
    [1, 2, 3],
  );
  // State was persisted in the new order.
  const persisted = JSON.parse(getStateWidget(node).value);
  assert.deepEqual(persisted.rows.map((r) => r.id), newIds);
});

// =========================================================================
// F. Resize
// =========================================================================

test("fitNode sizes the node from bodyHeight(rows.length), width floored at MIN_W", () => {
  const node = makeFakeNode();
  node.size = [10, 10]; // narrower than MIN_W
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  fitNode(node, ctx);
  assert.equal(node.size[0], MIN_W);
  assert.equal(node.size[1], bodyHeight(3));
});

test("scheduleFit skips fitting while _ctrlConfiguring is set (never resize during a workflow load)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
  node._ctrlConfiguring = true;
  const before = node.size.slice();
  scheduleFit(node, ctx);
  rafQueue.forEach((cb) => cb());
  assert.deepEqual(node.size, before);
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
