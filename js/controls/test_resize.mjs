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
  MAX_ROW_NAME_LEN,
  ZW,
  mkRow,
  assignSlot,
  isPickerKind,
  outputTypeForRow,
  SLOT_LABEL_MODE,
  stripZeroWidthEdges,
  defaultSlotLabel,
  ROW_PRESETS,
  applyResolvedKind,
} from "./rows.mjs";

import {
  injectStyles,
  buildRowElement,
  buildAddRow,
  paintRow,
  openOverlay,
  bodyHeight,
  applyNodeChrome,
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
  teardownAllZoomPassthrough,
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
    // Mirrors the real ComfyUI/litegraph DOM-widget host: a live page mounts
    // every `addDOMWidget` element into ITS OWN DOM tree, separate from
    // `node.widgets` -- and the ONLY thing that ever detaches it again is
    // that widget's own `.onRemove()` (see ComfyUI-Pixaroma's `js/sliders/
    // ui.mjs` / `js/switch/vue_list.mjs`'s `w.onRemove?.()` convention).
    // Splicing a widget out of `node.widgets` (bookkeeping only) does NOT
    // shrink `_domHost` by itself -- exactly the gap that shipped the
    // "orphaned row widget" bug this stub exists to catch.
    _domHost: [],
    addDOMWidget(name, type, element) {
      node._domHost.push(element);
      const w = {
        name,
        type,
        element,
        options: {},
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
  // Mirrors index.js's PANEL_CONFIGS.control.menuCatalog -- presets before
  // the bare int/float they shortcut.
  menuCatalog: ["sampler", "scheduler", "seed", "steps", "cfg", "denoise", "int", "float", "latent"],
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

test("injectStyles's injected CSS is a real, non-empty stylesheet -- guards against a stray backtick inside the CSS template literal silently truncating/breaking it (that bug passes `node --check` and only breaks on actual module load)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.id === "wtn-controls-style");
  assert.ok(styleEl, "expected an injected <style> element");
  assert.ok(styleEl.textContent.length > 500, "injected CSS looks truncated");
  assert.ok(styleEl.textContent.includes(".wtn-ctl-stepper"), "expected selector missing from injected CSS");
  assert.ok(styleEl.textContent.includes(".wtn-ctl-name"), "expected selector missing from injected CSS");
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

// Driven off KIND_META/isPickerKind itself (not a hardcoded kind list) so a
// newly added picker kind is automatically covered here -- this is the exact
// class of bug that shipped: unet/vae/clip have `pickerList` set but their
// `outputType` is a plain socket type (MODEL/VAE/CLIP), not the "combo"
// sentinel, so a check against `outputType` alone silently skips them and
// they fall through to a bare, non-interactive value span.
for (const kind of Object.keys(KIND_META)) {
  const meta = KIND_META[kind];
  if (!isPickerKind(meta)) {
    continue;
  }
  test(`buildRowElement/paintRow: picker kind "${kind}" gets a real stepper + caret + non-empty value (not just a bare span)`, () => {
    const doc = makeDocStub();
    const panelConfig = meta.panel === "loader" ? LOADER_PANEL_CONFIG : CONTROL_PANEL_CONFIG;
    const row = mkRow(kind, { value: "installed_option" });
    const refs = buildRowElement(doc, row, meta, panelConfig);
    assert.ok(refs.stepLeft && refs.stepRight, `${kind}: missing steppers`);
    assert.ok(refs.combo && refs.caret, `${kind}: missing combo/caret`);
    assert.ok(refs.val, `${kind}: missing value span`);
    paintRow(refs, row, ["installed_option", "other_option"], null);
    assert.equal(refs.val.textContent, "installed_option", `${kind}: value not painted`);
  });
}

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

// TOKENS.surface/TOKENS.surface2 aren't exported from render.mjs (single
// source of truth stays internal to that module -- see its own doc
// comment); mirrored here as literals, matching this pack's existing
// convention of a hardcoded fallback pair (e.g. this same file's CSS
// `var(--wtn-x, #fallback)` strings).
const CHROME_BODY = "#151a21";
const CHROME_HEADER = "#1b212a";

test("applyNodeChrome paints bgcolor/color on a fresh node (both null)", () => {
  const node = { bgcolor: null, color: null };
  applyNodeChrome(node);
  assert.equal(node.bgcolor, CHROME_BODY);
  assert.equal(node.color, CHROME_HEADER);
});

test("applyNodeChrome paints bgcolor/color on a fresh node (both undefined -- litegraph's actual default)", () => {
  const node = {};
  applyNodeChrome(node);
  assert.equal(node.bgcolor, CHROME_BODY);
  assert.equal(node.color, CHROME_HEADER);
});

test("applyNodeChrome NEVER overwrites a node that already has an explicit bgcolor/color -- the stomp case", () => {
  const node = { bgcolor: "#ff00ff", color: "#00ff00" };
  applyNodeChrome(node);
  assert.equal(node.bgcolor, "#ff00ff");
  assert.equal(node.color, "#00ff00");
});

test("applyNodeChrome fills in only the ONE still-null field, leaving an explicitly-set sibling alone", () => {
  const node = { bgcolor: "#ff00ff", color: null };
  applyNodeChrome(node);
  assert.equal(node.bgcolor, "#ff00ff"); // untouched
  assert.equal(node.color, CHROME_HEADER); // filled in

  const node2 = { bgcolor: null, color: "#00ff00" };
  applyNodeChrome(node2);
  assert.equal(node2.bgcolor, CHROME_BODY); // filled in
  assert.equal(node2.color, "#00ff00"); // untouched
});

test("applyNodeChrome is a no-op (never throws) against a null/undefined node", () => {
  assert.doesNotThrow(() => applyNodeChrome(null));
  assert.doesNotThrow(() => applyNodeChrome(undefined));
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

// This is the actual mount path (`index.js`'s setupNode/restoreNode both
// call syncRows) -- asserting through it, rather than calling
// `injectStyles`/`paintRow` directly, is what would have caught both the
// missing CSS injection AND the loader-row picker-predicate bug: the
// original 41 assertions all called these building blocks directly with
// correct-by-construction args and never actually exercised the mount path.

test("syncRows (the mount path) actually injects the stylesheet -- would have caught Bug 1", () => {
  const node = makeFakeNode();
  const doc = makeDocStub(); // freshly made -- injectStyles NOT pre-called
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  assert.equal(doc.getElementById("wtn-controls-style"), null);
  syncRows(node, ctx);
  assert.ok(doc.getElementById("wtn-controls-style"), "mount path never injected the stylesheet");
});

test("syncRows (mount path): every Loader Panel row builds a real picker (stepper), not a bare value span -- would have caught Bug 2", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, {
    getKnownLists: () => ({ unet: ["flux_unet.safetensors"], vae: ["ae.safetensors"], clip: ["clip_l.safetensors"] }),
  });
  syncRows(node, ctx);
  node._ctrlRows.forEach((entry) => {
    assert.ok(entry.refs.stepLeft && entry.refs.combo, `${entry.kind}: no picker built`);
    assert.notEqual(entry.refs.val.textContent, "", `${entry.kind}: value area is empty`);
  });
});

test("syncRows (mount path): a Loader Panel row whose class isn't installed shows 'unavailable', never a blank value -- would have caught Bug 2", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, { getKnownLists: () => ({}) }); // nothing installed
  syncRows(node, ctx);
  node._ctrlRows.forEach((entry) => {
    assert.equal(entry.refs.val.textContent, "unavailable", `${entry.kind}: expected 'unavailable', got empty/blank`);
    assert.ok(entry.refs.root.classList.contains("wtn-ctl-disabled"));
  });
});

test("syncRows (mount path): the panel_state WIDGET (not just node.properties) reflects the rows actually built -- would have caught Bug 3", () => {
  const node = makeFakeNode(); // widget starts at Python's literal default "{}"
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  assert.equal(getStateWidget(node).value, "{}");
  syncRows(node, ctx);
  const persisted = JSON.parse(getStateWidget(node).value);
  assert.equal(persisted.rows.length, 3);
  assert.deepEqual(persisted.rows.map((r) => r.kind).sort(), ["clip", "unet", "vae"]);
});

test("syncRows (mount path): an explicitly emptied panel (rows:[]) is NOT resurrected by the widget-persist fix", () => {
  const node = makeFakeNode(JSON.stringify({ version: 1, rows: [] }));
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx);
  assert.equal(node._ctrlRows.length, 0);
  assert.deepEqual(JSON.parse(getStateWidget(node).value).rows, []);
});

test("syncOutputs: a Loader Panel row's narrowed output type is the plain MODEL/VAE/CLIP socket type, never the COMBO strategy value", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, {
    getKnownLists: () => ({ unet: ["a"], vae: ["b"], clip: ["c"] }),
  });
  syncRows(node, ctx);
  const state = ensureState(node, ctx);
  state.rows.forEach((row) => {
    const t = node.outputs[row.slot - 1].type;
    assert.equal(t, outputTypeForRow(row, ctx.getKnownLists()));
    assert.notEqual(t, "COMBO");
    assert.ok(["MODEL", "VAE", "CLIP"].includes(t), `unexpected output type ${t} for kind ${row.kind}`);
  });
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
  assert.equal(node.outputs[0].name, "value_1"); // matches Python's RETURN_NAMES, never the ZW
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

test("syncOutputs: every OCCUPIED slot's name is exactly value_${slot} (matching Python's RETURN_NAMES), never the ZW, while a still-owned label defaults to the row's OWN name (SLOT_LABEL_MODE=\"row-name\") -- driven off whatever slot numbers the rows actually hold, including a non-contiguous gap, not hardcoded to slot 1", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const a = addRowAndSync(node, ctx, "int"); // slot 1
  addRowAndSync(node, ctx, "float"); // slot 2
  addRowAndSync(node, ctx, "seed"); // slot 3
  removeRowAndSync(node, ctx, a.id); // frees slot 1 -- a real gap below the max
  addRowAndSync(node, ctx, "sampler"); // reuses slot 1
  addRowAndSync(node, ctx, "latent"); // slot 4 -- a real slot ABOVE 3, not the lowest

  const state = ensureState(node, ctx);
  assert.ok(state.rows.length >= 4, "test setup expected at least 4 live rows");
  state.rows.forEach((row) => {
    const out = node.outputs[row.slot - 1];
    assert.ok(out, `no output object at slot ${row.slot}`);
    assert.equal(out.name, `value_${row.slot}`, `slot ${row.slot}: name must match RETURN_NAMES exactly`);
    assert.notEqual(out.name, ZW, `slot ${row.slot}: name must never be the ZW`);
    assert.equal(out.label, row.name, `slot ${row.slot}: a still-owned label must default to the row's own name`);
    assert.notEqual(out.label, ZW, `slot ${row.slot}: label must not be the bare ZW sentinel in "row-name" mode`);
  });
});

test("syncOutputs is diff-gated: a second call against UNCHANGED state writes to none of name/label/type on any occupied output -- protects the clean-workflow-modified behavior (docs/control-panel-design.md §7)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  addRowAndSync(node, ctx, "int");
  addRowAndSync(node, ctx, "sampler");
  addRowAndSync(node, ctx, "latent");
  const state = ensureState(node, ctx);

  // Replace each occupied output with a write-counting shadow of itself --
  // a real property (not a fresh object) so `syncOutputs`'s own `out.name`/
  // `out.label`/`out.type` reads still see the exact current value; only
  // ASSIGNMENT is what must not happen again.
  const writes = { name: 0, label: 0, type: 0 };
  state.rows.forEach((row) => {
    const out = node.outputs[row.slot - 1];
    let { name, label, type } = out;
    Object.defineProperty(out, "name", {
      get: () => name,
      set: (v) => {
        writes.name += 1;
        name = v;
      },
    });
    Object.defineProperty(out, "label", {
      get: () => label,
      set: (v) => {
        writes.label += 1;
        label = v;
      },
    });
    Object.defineProperty(out, "type", {
      get: () => type,
      set: (v) => {
        writes.type += 1;
        type = v;
      },
    });
  });

  syncOutputs(node, ctx);

  assert.deepEqual(writes, { name: 0, label: 0, type: 0 }, "syncOutputs re-wrote an already-correct output field");
});

// ---------------------------------------------------------------------------
// C1. Slot label ownership -- cg-use-everywhere ("UE") interop regression.
// UE disambiguates same-typed broadcasting outputs (two COMBO rows: sampler
// + scheduler) by NAME/LABEL. The original bug: `syncOutputs` unconditionally
// stomped `out.label` back to the bare ZW sentinel on every sync, so (a) a
// user's litegraph rename of the slot silently reverted, and (b) litegraph's
// rename dialog pre-fills with the CURRENT (ZW) label, so the user's typed
// text landed as `${ZW}typed`, which even a surviving rename couldn't match
// by exact name. `SLOT_LABEL_MODE` defaults to `"row-name"` (assert that, so
// a future default flip doesn't silently invalidate these tests' premise).
// ---------------------------------------------------------------------------

test("SLOT_LABEL_MODE defaults to \"row-name\"", () => {
  assert.equal(SLOT_LABEL_MODE, "row-name");
});

test("a user-renamed slot label survives an arbitrary number of subsequent syncOutputs calls (add a row, remove a row, repaint)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "sampler");
  const out = node.outputs[row.slot - 1];
  assert.equal(out.label, "sampler"); // still-owned default

  // Simulate litegraph's own rename-slot dialog writing directly onto the
  // socket -- never through our code.
  out.label = "sampler_name";

  syncOutputs(node, ctx); // a bare repaint-equivalent call
  assert.equal(out.label, "sampler_name");

  const second = addRowAndSync(node, ctx, "int"); // add -- a full structural resync
  assert.equal(out.label, "sampler_name");

  removeRowAndSync(node, ctx, second.id); // remove -- another full resync
  assert.equal(out.label, "sampler_name");

  syncOutputs(node, ctx);
  assert.equal(out.label, "sampler_name");
});

test("a zero-width-prefixed label (${ZW}sampler_name -- litegraph's rename dialog pre-filling with the old ZW label) is normalised to a clean value on the next sync", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "sampler");
  const out = node.outputs[row.slot - 1];

  out.label = `${ZW}sampler_name`; // exactly what a live dump confirmed
  syncOutputs(node, ctx);
  assert.equal(out.label, "sampler_name");
  assert.equal(stripZeroWidthEdges(out.label), out.label); // idempotent

  // And it stays healed/owned-by-the-user across a further sync.
  syncOutputs(node, ctx);
  assert.equal(out.label, "sampler_name");
});

test('SLOT_LABEL_MODE="row-name": a row named "sampler" yields label "sampler"; renaming the ROW updates the slot label too, as long as the user never set the socket label directly', () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "sampler");
  const out = node.outputs[row.slot - 1];
  assert.equal(out.label, "sampler");

  // Rename the ROW via our own UI (never the socket) -- the label should
  // track it, since nothing has claimed ownership of this label yet.
  const entry = node._ctrlRows.find((e) => e.id === row.id);
  fire(entry.refs.name, "dblclick");
  entry.refs.nameInput.value = "denoise";
  fire(entry.refs.nameInput, "keydown", { key: "Enter" });
  assert.equal(node.outputs[row.slot - 1].label, "denoise");
});

test("a slot label the user set DIRECTLY ON THE SOCKET is never overridden by a later row rename", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "sampler");
  const out = node.outputs[row.slot - 1];

  out.label = "custom_socket_name"; // the user's own litegraph rename
  syncOutputs(node, ctx); // acknowledge/adopt ownership of it

  const entry = node._ctrlRows.find((e) => e.id === row.id);
  fire(entry.refs.name, "dblclick");
  entry.refs.nameInput.value = "denoise";
  fire(entry.refs.nameInput, "keydown", { key: "Enter" });

  assert.equal(node._ctrlRows.find((e) => e.id === row.id).refs.row.name, "denoise"); // the ROW did rename
  assert.equal(node.outputs[row.slot - 1].label, "custom_socket_name"); // the SOCKET label did not
});

test('a fresh output with no label at all defaults to defaultSlotLabel(row) (row-name mode: the row\'s own name)', () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "float");
  assert.equal(node.outputs[row.slot - 1].label, defaultSlotLabel(row));
  assert.equal(defaultSlotLabel(row), "float");
});

test("a slot number freed by one removed row and reused by a DIFFERENT new row gets that new row's own default label, never the vacated row's leftover text (label ownership must be keyed by slot, not row id)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const intRow = addRowAndSync(node, ctx, "int"); // slot 1, label "int"
  addRowAndSync(node, ctx, "float"); // slot 2
  addRowAndSync(node, ctx, "seed"); // slot 3
  assert.equal(node.outputs[intRow.slot - 1].label, "int");

  removeRowAndSync(node, ctx, intRow.id); // frees slot 1; its output's label is untouched leftover text
  const samplerRow = addRowAndSync(node, ctx, "sampler"); // reuses slot 1 -- a BRAND NEW row id
  assert.equal(samplerRow.slot, intRow.slot, "test setup expected the freed slot to be reused");
  assert.equal(node.outputs[samplerRow.slot - 1].label, "sampler", "reused slot must adopt the NEW occupant's own label, not the old row's");
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

// ---------------------------------------------------------------------------
// D0. Row presets -- steps/cfg/denoise (pre-configured int/float rows, NOT
// new kinds; see rows.mjs's ROW_PRESETS doc comment).
// ---------------------------------------------------------------------------

test("each preset appears in the Control Panel's \"+ Add control\" menu (before the bare Int/Float entries), and NONE appear in the Loader Panel's \"+ Add loader\" menu", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  syncRows(node, ctx);
  fire(node._ctrlAddWidget.element, "click");
  const menu = doc.body.children[doc.body.children.length - 1].children[0];
  const labels = menu.children.filter((c) => c.className.includes("wtn-ctl-opt")).map((c) => c.textContent);
  assert.deepEqual(
    labels,
    ["Sampler", "Scheduler", "Seed", "Steps", "CFG", "Denoise", "Int", "Float", "Empty latent", "Auto"],
    "presets must appear, and BEFORE the bare Int/Float entries",
  );
  closeActiveOverlay();

  const loaderNode = makeFakeNode();
  const loaderDoc = makeDocStub();
  makeWindowStub(loaderDoc);
  const loaderCtx = makeCtx(loaderDoc, LOADER_PANEL_CONFIG);
  syncRows(loaderNode, loaderCtx);
  fire(loaderNode._ctrlAddWidget.element, "click");
  const loaderMenu = loaderDoc.body.children[loaderDoc.body.children.length - 1].children[0];
  const loaderLabels = loaderMenu.children.filter((c) => c.className.includes("wtn-ctl-opt")).map((c) => c.textContent);
  assert.deepEqual(loaderLabels, ["UNET loader", "VAE loader", "CLIP loader"]);
  assert.ok(!loaderLabels.some((t) => t.startsWith("Steps") || t.startsWith("CFG") || t.startsWith("Denoise")));
  closeActiveOverlay();
});

for (const [id, preset] of Object.entries(ROW_PRESETS)) {
  test(`addRowAndSync("${id}") produces a row with exactly the preset's kind/name/value/min/max/step, and the RIGHT slot type`, () => {
    const node = makeFakeNode();
    const doc = makeDocStub();
    const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
    const row = addRowAndSync(node, ctx, id);
    assert.equal(row.kind, preset.kind);
    assert.equal(row.name, preset.name);
    assert.equal(row.value, preset.value);
    assert.deepEqual(row.opts, preset.opts);

    const out = node.outputs[row.slot - 1];
    assert.equal(out.type, preset.kind === "int" ? "INT" : "FLOAT");

    // The panel_state WIDGET (not just node.properties) reflects the new row.
    const persisted = JSON.parse(getStateWidget(node).value).rows[0];
    assert.equal(persisted.kind, preset.kind);
    assert.equal(persisted.name, preset.name);
    assert.equal(persisted.value, preset.value);
    assert.deepEqual(persisted.opts, preset.opts);
  });
}

test("a preset row's name survives the same name-adopt mechanism a first connection would use (applyResolvedKind), while min/max/step/value still adopt -- resolveAutoOnConnect itself never runs for an already-resolved row (only \"auto\" ones), so this exercises the protection at the level that actually provides it", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "denoise");
  const liveRow = ensureState(node, ctx).rows.find((r) => r.id === row.id);
  assert.equal(liveRow.renamed, true, "a preset row must already carry the same protection a manual rename sets");

  applyResolvedKind(liveRow, { kind: "float", name: "some_widget", value: 0.75, opts: { min: 0, max: 2, step: 0.05 } });
  persistState(node, ctx);
  syncRows(node, ctx); // propagate to the DOM + panel_state widget, same as afterEdit would

  assert.equal(liveRow.name, "denoise"); // protected -- never "some_widget"
  assert.equal(liveRow.value, 0.75); // still adopted
  assert.equal(liveRow.opts.max, 2); // still adopted

  const entry = node._ctrlRows.find((e) => e.id === row.id);
  assert.equal(entry.refs.name.textContent, "denoise"); // the rendered label agrees
  const persisted = JSON.parse(getStateWidget(node).value).rows[0];
  assert.equal(persisted.name, "denoise");
  assert.equal(persisted.value, 0.75);
});

test("drag behaviour works on a preset row (denoise, step 0.01 -- the finest grid, most likely to expose a rounding bug)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "denoise");
  const refs = node._ctrlRows[0].refs;
  refs.root._rect = { left: 0, top: 0, right: 200, bottom: 30, width: 200, height: 30 };
  fire(refs.root, "pointerdown", { clientX: 48, button: 0 }); // 24% of [0,1] -> 0.24, exactly on the 0.01 grid
  assert.equal(refs.row.value, 0.24);
  assert.equal(refs.row.value.toString(), "0.24"); // never float-drift like 0.24000000000000002
  fire(refs.root, "pointerup");
  assert.equal(JSON.parse(getStateWidget(node).value).rows[0].value, 0.24);
});

// ---------------------------------------------------------------------------
// D1. Row-removal state-machine regression: an earlier build spliced a torn-
// down row/add widget out of `node.widgets` (bookkeeping) but never called
// its own `.onRemove()` (DOM teardown) -- since `rebuildRowWidgets` tears
// down and recreates EVERY row widget on every structural change (not just
// the removed one), that orphaned the WHOLE previous generation of row/add
// elements on every add/remove/duplicate. A removal shrinks `bodyHeight`,
// shifting every row below the removed one upward, so an orphan's frozen Y
// lands on top of a CURRENT row further down the list -- and `.wtn-ctl-add`'s
// `background: transparent` means an orphaned "+ Add control" strip frozen
// over a live row shows THROUGH it rather than hiding it. `makeFakeNode`'s
// `_domHost` (above) models the real DOM-widget host a live page mounts
// `addDOMWidget` elements into, separate from `node.widgets` -- these tests
// assert against THAT, which the widgets-array-only assertions elsewhere in
// this file could not have caught (see the repro script this bug was
// diagnosed with: `node.widgets`/`node._ctrlRows` were already correct).
// ---------------------------------------------------------------------------

/** Every currently-live widget (every entry in `node.widgets` except
 * `panel_state`, which is a real litegraph STRING widget, never a DOM one)
 * must have its `.element` mounted in `_domHost`, and `_domHost` must hold
 * NOTHING ELSE -- no orphan from a torn-down generation. */
function assertNoOrphanedDomWidgets(node) {
  const liveElements = node.widgets.filter((w) => w.name !== "panel_state").map((w) => w.element);
  assert.equal(node._domHost.length, liveElements.length, "orphaned DOM widget(s) left mounted in the host");
  liveElements.forEach((el) => {
    assert.ok(node._domHost.includes(el), "a live widget's element is missing from the DOM host");
  });
}

/** Build the exact repro from the live bug report: sampler, seed, int, int. */
function buildRepro4(node, ctx) {
  const sampler = addRowAndSync(node, ctx, "sampler");
  const seed = addRowAndSync(node, ctx, "seed");
  const intA = addRowAndSync(node, ctx, "int");
  const intB = addRowAndSync(node, ctx, "int");
  return { sampler, seed, intA, intB };
}

test("removeRowAndSync: removing one of two identical 'int' rows from [sampler, seed, int, int] leaves node.widgets as exactly panel_state + remaining rows + one add widget, in order", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const { sampler, seed, intA, intB } = buildRepro4(node, ctx);

  removeRowAndSync(node, ctx, intA.id);

  assert.deepEqual(
    node.widgets.map((w) => w.name),
    ["panel_state", `ctrl_row_${sampler.id}`, `ctrl_row_${seed.id}`, `ctrl_row_${intB.id}`, "ctrl_add_row"],
  );
  assertNoOrphanedDomWidgets(node);

  // The surviving int row's DOM shows ITS OWN kind's controls -- a numeric
  // fill + value -- never the add button's text/markup.
  const survivor = node._ctrlRows.find((e) => e.id === intB.id);
  assert.ok(survivor.refs.fill && survivor.refs.val, "surviving int row lost its numeric controls");
  assert.notEqual(survivor.refs.root.textContent, "+ Add control");
  assert.notEqual(survivor.refs.val.textContent, "+ Add control");

  // node.outputs matches the remaining rows' slots exactly.
  const state = ensureState(node, ctx);
  assert.equal(state.rows.length, 3);
  state.rows.forEach((row) => {
    assert.ok(node.outputs[row.slot - 1], `no output at slot ${row.slot}`);
  });

  // panel_state WIDGET (not just node.properties) parses to exactly the
  // remaining rows.
  const persisted = JSON.parse(getStateWidget(node).value);
  assert.deepEqual(persisted.rows.map((r) => r.id), [sampler.id, seed.id, intB.id]);
});

for (const which of ["first", "middle", "last"]) {
  test(`removeRowAndSync: removing the ${which.toUpperCase()} row of four leaves no orphaned DOM widgets and a correctly-ordered widget list`, () => {
    const node = makeFakeNode();
    const doc = makeDocStub();
    const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
    const rows = [
      addRowAndSync(node, ctx, "sampler"),
      addRowAndSync(node, ctx, "seed"),
      addRowAndSync(node, ctx, "int"),
      addRowAndSync(node, ctx, "float"),
    ];
    const idxToRemove = { first: 0, middle: 2, last: 3 }[which];
    const removed = rows[idxToRemove];
    const remaining = rows.filter((_, i) => i !== idxToRemove);

    removeRowAndSync(node, ctx, removed.id);

    assert.deepEqual(
      node.widgets.map((w) => w.name),
      ["panel_state", ...remaining.map((r) => `ctrl_row_${r.id}`), "ctrl_add_row"],
    );
    assertNoOrphanedDomWidgets(node);

    const persisted = JSON.parse(getStateWidget(node).value);
    assert.deepEqual(persisted.rows.map((r) => r.id), remaining.map((r) => r.id));

    const state = ensureState(node, ctx);
    state.rows.forEach((row) => {
      assert.ok(node.outputs[row.slot - 1], `no output at slot ${row.slot}`);
    });
  });
}

test("removeRowAndSync: removing rows down to zero and adding back up never accumulates orphaned DOM widgets", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const rows = [
    addRowAndSync(node, ctx, "int"),
    addRowAndSync(node, ctx, "float"),
    addRowAndSync(node, ctx, "seed"),
  ];
  rows.forEach((r) => {
    removeRowAndSync(node, ctx, r.id);
    assertNoOrphanedDomWidgets(node);
  });

  assert.equal(ensureState(node, ctx).rows.length, 0);
  assert.deepEqual(JSON.parse(getStateWidget(node).value).rows, []);
  assert.deepEqual(node.widgets.map((w) => w.name), ["panel_state", "ctrl_add_row"]);
  assertNoOrphanedDomWidgets(node);

  // Back up: add three more, and repaint-only edits in between (never a
  // structural change on their own) must not disturb the host either.
  const rebuilt = [addRowAndSync(node, ctx, "seed"), addRowAndSync(node, ctx, "int"), addRowAndSync(node, ctx, "float")];
  assertNoOrphanedDomWidgets(node);
  assert.deepEqual(
    node.widgets.map((w) => w.name),
    ["panel_state", ...rebuilt.map((r) => `ctrl_row_${r.id}`), "ctrl_add_row"],
  );
});

test("removeRowAndSync: the panel_state WIDGET value parses to exactly the remaining rows after every removal in a multi-step sequence", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const rows = [
    addRowAndSync(node, ctx, "sampler"),
    addRowAndSync(node, ctx, "seed"),
    addRowAndSync(node, ctx, "int"),
    addRowAndSync(node, ctx, "int"),
  ];
  const remaining = rows.slice();

  // Remove middle, then first, then what's left.
  for (const idx of [2, 0, 0]) {
    const [removed] = remaining.splice(idx, 1);
    removeRowAndSync(node, ctx, removed.id);
    const persisted = JSON.parse(getStateWidget(node).value);
    assert.deepEqual(persisted.rows.map((r) => r.id), remaining.map((r) => r.id));
    assertNoOrphanedDomWidgets(node);
  }
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

test("resolveAutoOnConnect: an un-renamed 'auto' row still adopts the target's name (no regression)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, {
    describeLinkTarget: () => ({ type: "FLOAT", name: "cfg", min: 0, max: 20, step2: 0.1, value: 7.5 }),
  });
  const row = addRowAndSync(node, ctx, "auto");
  const ok = resolveAutoOnConnect(node, ctx, row.slot - 1, {});
  assert.ok(ok);
  assert.equal(ensureState(node, ctx).rows[0].name, "cfg");
  assert.equal(ensureState(node, ctx).rows[0].value, 7.5);
});

test("resolveAutoOnConnect: a row renamed by hand WHILE STILL 'auto' keeps that name on first connection, but still adopts min/max/step/value", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const describeLinkTarget = () => ({ type: "FLOAT", name: "cfg", min: 0, max: 20, step2: 0.1, value: 7.5 });
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { describeLinkTarget });
  addRowAndSync(node, ctx, "auto");

  // Rename the still-unresolved "auto" row by hand before it's ever wired.
  fire(node._ctrlRows[0].refs.name, "dblclick");
  node._ctrlRows[0].refs.nameInput.value = "denoise";
  fire(node._ctrlRows[0].refs.nameInput, "keydown", { key: "Enter" });
  assert.equal(node._ctrlRows[0].refs.row.name, "denoise");
  assert.equal(node._ctrlRows[0].refs.row.renamed, true);

  const slot = node._ctrlRows[0].refs.row.slot;
  const ok = resolveAutoOnConnect(node, ctx, slot - 1, {});
  assert.ok(ok);
  // Rename commits via the cheap repaint path (kind unchanged), but
  // resolving "auto" -> "float" changes the id:kind signature, so syncRows
  // rebuilds -- re-fetch node._ctrlRows[0] fresh rather than reusing the
  // pre-resolve entry/refs.
  const row = node._ctrlRows[0].refs.row;
  assert.equal(row.kind, "float");
  assert.equal(row.name, "denoise"); // kept -- NOT overwritten by the target's "cfg"
  assert.equal(row.value, 7.5); // still adopted
  assert.equal(row.opts.max, 20); // still adopted
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

test("Loader Panel row (unet): clicking the steppers cycles the value and persists it -- the exact interaction that was dead before the picker-predicate fix", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, {
    getKnownLists: () => ({ unet: ["flux1-dev.safetensors", "sdxl_base.safetensors"] }),
  });
  syncRows(node, ctx); // default loader rows: unet/vae/clip
  const unetEntry = node._ctrlRows.find((e) => e.kind === "unet");
  assert.ok(unetEntry.refs.stepRight, "no stepper wired for the unet row");
  const before = unetEntry.refs.row.value;
  fire(unetEntry.refs.stepRight, "click");
  assert.notEqual(unetEntry.refs.row.value, before);
  assert.ok(["flux1-dev.safetensors", "sdxl_base.safetensors"].includes(unetEntry.refs.row.value));
  assert.equal(JSON.parse(getStateWidget(node).value).rows.find((r) => r.kind === "unet").value, unetEntry.refs.row.value);
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

test("context menu offers Rename for every row kind, and it opens the same inline edit as a double-click", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "sampler"); // a picker kind, not int/float -- rename must not be int/float-only
  const refs = node._ctrlRows[0].refs;
  fire(refs.root, "contextmenu");
  const menu = doc.body.children[doc.body.children.length - 1].children[0];
  const rename = menu.children.find((c) => c.textContent === "Rename");
  assert.ok(rename, "expected a Rename item in the row's context menu");
  fire(rename, "click");
  assert.ok(refs.nameInput, "expected the rename edit box to open");
});

test("rename: double-click the label opens an edit box; Enter commits, trims, and updates the panel_state WIDGET (not just node.properties)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  const entry = node._ctrlRows[0];
  fire(entry.refs.name, "dblclick");
  assert.ok(entry.refs.nameInput, "expected a rename input to be swapped in for the label");
  entry.refs.nameInput.value = "  steps  ";
  fire(entry.refs.nameInput, "keydown", { key: "Enter" });

  assert.equal(entry.refs.row.name, "steps");
  assert.equal(entry.refs.row.renamed, true);
  assert.equal(entry.refs.nameInput, null); // edit box torn down
  assert.equal(entry.refs.name.textContent, "steps"); // label swapped back in, repainted

  const widgetState = JSON.parse(getStateWidget(node).value);
  assert.equal(widgetState.rows[0].name, "steps");
  assert.equal(widgetState.rows[0].renamed, true);
});

test("rename: blur commits, same as Enter", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  const entry = node._ctrlRows[0];
  fire(entry.refs.name, "dblclick");
  entry.refs.nameInput.value = "steps";
  fire(entry.refs.nameInput, "blur");
  assert.equal(entry.refs.row.name, "steps");
  assert.equal(entry.refs.row.renamed, true);
});

test("rename: committing an empty/whitespace-only name falls back to the row's default (kind) label, never leaves it blank", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "float");
  const entry = node._ctrlRows[0];
  fire(entry.refs.name, "dblclick");
  entry.refs.nameInput.value = "   ";
  fire(entry.refs.nameInput, "keydown", { key: "Enter" });
  assert.equal(entry.refs.row.name, "float");
  assert.equal(entry.refs.name.textContent, "float");
});

test("rename: a pasted essay is capped at MAX_ROW_NAME_LEN characters", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  const entry = node._ctrlRows[0];
  fire(entry.refs.name, "dblclick");
  entry.refs.nameInput.value = "x".repeat(200);
  fire(entry.refs.nameInput, "keydown", { key: "Enter" });
  assert.equal(entry.refs.row.name.length, MAX_ROW_NAME_LEN);
  assert.equal(entry.refs.row.name, "x".repeat(MAX_ROW_NAME_LEN));
});

test("rename: Escape cancels without persisting -- name/renamed and the whole state stay untouched", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  const entry = node._ctrlRows[0];
  const before = JSON.stringify(ensureState(node, ctx));
  fire(entry.refs.name, "dblclick");
  entry.refs.nameInput.value = "should not stick";
  fire(entry.refs.nameInput, "keydown", { key: "Escape" });

  assert.equal(entry.refs.nameInput, null); // edit box torn down
  assert.equal(entry.refs.name.textContent, "int"); // label reverted
  assert.equal(entry.refs.row.name, "int");
  assert.equal(entry.refs.row.renamed, false);
  assert.equal(JSON.stringify(ensureState(node, ctx)), before);
});

test("rename: a second double-click while already editing is a no-op (doesn't stack a second input)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  const entry = node._ctrlRows[0];
  fire(entry.refs.name, "dblclick");
  const firstInput = entry.refs.nameInput;
  fire(entry.refs.name, "dblclick"); // refs.name is detached now, but the row-level entry ref is the same object
  assert.equal(entry.refs.nameInput, firstInput);
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
// G. Wheel-zoom passthrough (js/shared/canvas_zoom.mjs) integration -- the
// generic per-direction scroll matrix is covered exhaustively in
// js/shared/test_canvas_zoom.mjs; these just prove the helper is actually
// WIRED into every DOM surface this node owns.
// =========================================================================

test("every row root and the add strip get a non-passive wheel listener installed", () => {
  // (The non-passive REGISTRATION itself is exhaustively covered by
  // js/shared/test_canvas_zoom.mjs; this doc stub's addEventListener
  // doesn't retain the options object, so this test only proves WIRING --
  // that a listener actually landed on each root -- not the passive flag.)
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  const rowRoot = node._ctrlRows[0].refs.root;
  assert.equal(rowRoot._listeners.wheel.length, 1);

  const addRoot = node._ctrlAddWidget.element;
  assert.equal(addRoot._listeners.wheel.length, 1);
});

test("removing a row tears down its own wheel listener (no leaked listener on the removed row's element)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "int");
  const rowRoot = node._ctrlRows[0].refs.root;
  removeRowAndSync(node, ctx, row.id);
  assert.equal((rowRoot._listeners.wheel || []).length, 0);
});

test("teardownAllZoomPassthrough removes every live row/add-strip wheel listener without touching node.widgets/_ctrlRows", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  addRowAndSync(node, ctx, "float");
  const roots = node._ctrlRows.map((e) => e.refs.root);
  const addRoot = node._ctrlAddWidget.element;

  teardownAllZoomPassthrough(node);

  roots.forEach((root) => assert.equal((root._listeners.wheel || []).length, 0));
  assert.equal((addRoot._listeners.wheel || []).length, 0);
  assert.equal(node._ctrlRows.length, 2); // bookkeeping untouched
});

test("an opened overlay (option list) gets a non-passive wheel listener, torn down when it closes", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m"] }) });
  addRowAndSync(node, ctx, "sampler");
  const refs = node._ctrlRows[0].refs;
  fire(refs.combo, "click");
  const overlay = doc.body.children[doc.body.children.length - 1];
  assert.ok(overlay.className.includes("wtn-ctl-overlay"));
  assert.equal(overlay._listeners.wheel.length, 1);
  closeActiveOverlay();
  assert.equal((overlay._listeners.wheel || []).length, 0);
});

test("an opened ⚙ popover overlay also gets a non-passive wheel listener, torn down when it closes", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "latent");
  const refs = node._ctrlRows[0].refs;
  fire(refs.gear, "click");
  const overlay = doc.body.children[doc.body.children.length - 1];
  assert.equal(overlay._listeners.wheel.length, 1);
  closeActiveOverlay();
  assert.equal((overlay._listeners.wheel || []).length, 0);
});

// =========================================================================
// H. Overlay toggle -- second click of the SAME field closes its own
// overlay (option list / ⚙ popover / right-click menu) instead of silently
// closing-then-reopening (the reported bug: visually "nothing happens").
// The document-level outside-click/Escape dismiss listener (render.mjs's
// `openOverlay`) already correctly ignores a pointerdown/click whose target
// is inside the anchor row, so it was never the cause of the reopen race --
// the toggle has to be decided by the OPENER itself (`ownerKey` /
// `closeOverlayIfOwnedBy` in interaction.mjs).
// =========================================================================

function countOpenOverlays(doc) {
  return doc.body.children.filter((c) => c.className && c.className.includes("wtn-ctl-overlay")).length;
}

test("option list: click the field -> opens; click the SAME field again -> closes (a true toggle, not close-then-reopen)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m"] }) });
  addRowAndSync(node, ctx, "sampler");
  const refs = node._ctrlRows[0].refs;

  fire(refs.combo, "click");
  assert.equal(countOpenOverlays(doc), 1);
  assert.ok(refs.root.classList.contains("wtn-ctl-open"));

  fire(refs.combo, "click");
  assert.equal(countOpenOverlays(doc), 0, "a second click on the same field must CLOSE it");
  assert.ok(!refs.root.classList.contains("wtn-ctl-open"));
});

test("option list: click field A -> opens A; click field B -> B opens and A closes, exactly one menu ever in the DOM", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, {
    getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m"], scheduler: ["normal", "karras"] }),
  });
  addRowAndSync(node, ctx, "sampler");
  addRowAndSync(node, ctx, "scheduler");
  const [rowA, rowB] = node._ctrlRows.map((e) => e.refs);

  fire(rowA.combo, "click");
  assert.equal(countOpenOverlays(doc), 1);
  assert.ok(rowA.root.classList.contains("wtn-ctl-open"));

  fire(rowB.combo, "click");
  assert.equal(countOpenOverlays(doc), 1, "switching fields must never leave two menus open");
  assert.ok(!rowA.root.classList.contains("wtn-ctl-open"), "row A's own overlay-open class must clear");
  assert.ok(rowB.root.classList.contains("wtn-ctl-open"));
});

test("option list closed: clicking ◀/▶ steps the value and never opens the menu", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m", "ddim"] }) });
  addRowAndSync(node, ctx, "sampler");
  const refs = node._ctrlRows[0].refs;

  fire(refs.stepRight, "click");
  assert.equal(refs.row.value, "dpmpp_2m");
  assert.equal(countOpenOverlays(doc), 0);
  fire(refs.stepLeft, "click");
  assert.equal(refs.row.value, "euler");
  assert.equal(countOpenOverlays(doc), 0);
});

test("option list open: clicking an arrow steps the value AND closes the menu", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m", "ddim"] }) });
  addRowAndSync(node, ctx, "sampler");
  const refs = node._ctrlRows[0].refs;

  fire(refs.combo, "click");
  assert.equal(countOpenOverlays(doc), 1);
  fire(refs.stepRight, "click");
  assert.equal(refs.row.value, "dpmpp_2m");
  assert.equal(countOpenOverlays(doc), 0, "an arrow click while the menu is open must close it");
});

test("option list: Escape and an outside click still close it (regression)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m"] }) });
  addRowAndSync(node, ctx, "sampler");
  const refs = node._ctrlRows[0].refs;

  fire(refs.combo, "click");
  assert.equal(countOpenOverlays(doc), 1);
  fireWin(win, "keydown", { key: "Escape" });
  assert.equal(countOpenOverlays(doc), 0);

  fire(refs.combo, "click");
  assert.equal(countOpenOverlays(doc), 1);
  const outside = doc.createElement("div");
  fireWin(win, "pointerdown", { target: outside });
  assert.equal(countOpenOverlays(doc), 0);
});

test("⚙ popover: click the gear -> opens; click the SAME gear again -> closes", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "seed");
  const refs = node._ctrlRows[0].refs;

  fire(refs.gear, "click");
  assert.equal(countOpenOverlays(doc), 1);
  assert.ok(refs.gear.classList.contains("wtn-ctl-active"));

  fire(refs.gear, "click");
  assert.equal(countOpenOverlays(doc), 0, "a second click on the same gear must CLOSE its popover");
  assert.ok(!refs.gear.classList.contains("wtn-ctl-active"));
});

test("⚙ popover: switching between two rows' gears leaves exactly one popover open", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "seed");
  addRowAndSync(node, ctx, "latent");
  const [rowA, rowB] = node._ctrlRows.map((e) => e.refs);

  fire(rowA.gear, "click");
  assert.equal(countOpenOverlays(doc), 1);
  fire(rowB.gear, "click");
  assert.equal(countOpenOverlays(doc), 1, "switching gears must never leave two popovers open");
  assert.ok(!rowA.gear.classList.contains("wtn-ctl-active"));
  assert.ok(rowB.gear.classList.contains("wtn-ctl-active"));
});

test("mixed overlay switching: opening a field's option list while a DIFFERENT row's ⚙ popover is open closes the popover, and vice versa -- only one overlay of ours open at a time", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m"] }) });
  addRowAndSync(node, ctx, "seed"); // has a gear
  addRowAndSync(node, ctx, "sampler"); // has a picker, no gear
  const [seedRefs, samplerRefs] = node._ctrlRows.map((e) => e.refs);

  fire(seedRefs.gear, "click");
  assert.equal(countOpenOverlays(doc), 1);
  fire(samplerRefs.combo, "click");
  assert.equal(countOpenOverlays(doc), 1, "opening the option list must close the other row's gear popover");
  assert.ok(!seedRefs.gear.classList.contains("wtn-ctl-active"));

  fire(seedRefs.gear, "click");
  assert.equal(countOpenOverlays(doc), 1, "opening the gear must close the other row's option list");
  assert.ok(!samplerRefs.root.classList.contains("wtn-ctl-open"), "the sampler row's overlay-open class must clear");
  assert.ok(seedRefs.gear.classList.contains("wtn-ctl-active"));
});

test("right-click menu: a second right-click of the SAME row closes it (already shared the same close-then-reopen bug)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  const refs = node._ctrlRows[0].refs;

  fire(refs.root, "contextmenu");
  assert.equal(countOpenOverlays(doc), 1);
  fire(refs.root, "contextmenu");
  assert.equal(countOpenOverlays(doc), 0, "a second right-click on the same row must CLOSE its context menu");
});

test("right-click menu: right-clicking a DIFFERENT row switches the open menu, exactly one ever open", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  addRowAndSync(node, ctx, "float");
  const [rowA, rowB] = node._ctrlRows.map((e) => e.refs);

  fire(rowA.root, "contextmenu");
  assert.equal(countOpenOverlays(doc), 1);
  fire(rowB.root, "contextmenu");
  assert.equal(countOpenOverlays(doc), 1, "switching rows must never leave two context menus open");
});

// ---------------------------------------------------------------------------
// "+ Add control" / "+ Add loader" catalog menu -- shared the exact same
// unconditional close-then-reopen bug as the three overlays above (a second
// click closed whatever was open, itself included, then immediately reopened
// a fresh menu -- visibly "nothing happens"), left out of scope in the round
// that fixed the option list / ⚙ popover / right-click menu. Same toggle
// contract (`ownerKey` / `closeOverlayIfOwnedBy`), keyed off the add button
// element itself (there's exactly one per node, so its identity IS the key).
// ---------------------------------------------------------------------------

test("add menu: click '+ Add control' -> opens; click it again -> closes (a true toggle, not close-then-reopen)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  syncRows(node, ctx);
  const addBtn = node._ctrlAddWidget.element;

  fire(addBtn, "click");
  assert.equal(countOpenOverlays(doc), 1);

  fire(addBtn, "click");
  assert.equal(countOpenOverlays(doc), 0, "a second click on the add button must CLOSE its menu");
});

test("add menu: opening it while a row's option list is open closes the list, and vice versa -- only one of our overlays open at a time", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m"] }) });
  addRowAndSync(node, ctx, "sampler");
  const refs = node._ctrlRows[0].refs;
  const addBtn = node._ctrlAddWidget.element;

  fire(refs.combo, "click");
  assert.equal(countOpenOverlays(doc), 1);

  fire(addBtn, "click");
  assert.equal(countOpenOverlays(doc), 1, "opening the add menu must close the other row's option list");
  assert.ok(!refs.root.classList.contains("wtn-ctl-open"), "the option list's own open class must clear");

  fire(refs.combo, "click");
  assert.equal(countOpenOverlays(doc), 1, "opening the option list must close the add menu");
});

test("add menu: opening it while a row's ⚙ popover is open closes the popover, and vice versa -- only one of our overlays open at a time", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "seed");
  const refs = node._ctrlRows[0].refs;
  const addBtn = node._ctrlAddWidget.element;

  fire(refs.gear, "click");
  assert.equal(countOpenOverlays(doc), 1);

  fire(addBtn, "click");
  assert.equal(countOpenOverlays(doc), 1, "opening the add menu must close the other row's gear popover");
  assert.ok(!refs.gear.classList.contains("wtn-ctl-active"), "the gear's own active class must clear");

  fire(refs.gear, "click");
  assert.equal(countOpenOverlays(doc), 1, "opening the gear popover must close the add menu");
});

test("add menu: Escape and an outside click still close it (regression)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  syncRows(node, ctx);
  const addBtn = node._ctrlAddWidget.element;

  fire(addBtn, "click");
  assert.equal(countOpenOverlays(doc), 1);
  fireWin(win, "keydown", { key: "Escape" });
  assert.equal(countOpenOverlays(doc), 0);

  fire(addBtn, "click");
  assert.equal(countOpenOverlays(doc), 1);
  const outside = doc.createElement("div");
  fireWin(win, "pointerdown", { target: outside });
  assert.equal(countOpenOverlays(doc), 0);
});

test("add menu: picking a kind from the menu still adds that row and closes the menu (regression -- don't break the actual feature)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  syncRows(node, ctx); // starts empty (no defaultState rows for the control panel)
  const before = node._ctrlRows.length;
  const addBtn = node._ctrlAddWidget.element;

  fire(addBtn, "click");
  const menu = doc.body.children[doc.body.children.length - 1].children[0];
  const intOpt = menu.children.find((c) => c.textContent === "Int");
  assert.ok(intOpt, "expected an 'Int' entry in the add menu");
  fire(intOpt, "click");

  assert.equal(node._ctrlRows.length, before + 1, "picking a kind must add a row");
  assert.equal(node._ctrlRows[node._ctrlRows.length - 1].kind, "int");
  assert.equal(countOpenOverlays(doc), 0, "picking a kind must close the menu");
});

test("add menu: exactly one add-menu element in the DOM at a time; no orphan left behind when switching between overlays", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler", "dpmpp_2m"] }) });
  addRowAndSync(node, ctx, "sampler");
  addRowAndSync(node, ctx, "seed");
  const [samplerRefs, seedRefs] = node._ctrlRows.map((e) => e.refs);
  const addBtn = node._ctrlAddWidget.element;

  fire(addBtn, "click");
  fire(samplerRefs.combo, "click");
  fire(seedRefs.gear, "click");
  fire(addBtn, "click");
  fire(addBtn, "click"); // close it again

  assert.equal(countOpenOverlays(doc), 0);
  assert.equal(
    doc.body.children.filter((c) => c.className && c.className.includes("wtn-ctl-menu")).length,
    0,
    "no orphan add-menu (or other menu) element left in the DOM",
  );
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
