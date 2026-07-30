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
 *   [ ] A freed slot's inert hole (`markSlotVacant`, `interaction.mjs`)
 *       actually renders with NO visible dot and NO painted label on a real
 *       page — this harness can only assert the underlying `node.outputs`
 *       fields (`name`/`label`/`type`/no `.pos`), never the canvas pixels.
 *   [ ] Dragging a wire from a row's dot reliably starts the drag on the
 *       first attempt (Bug 2: `.wtn-ctl-dot` previously had no
 *       `pointer-events: none` and could intercept the pointerdown meant
 *       for litegraph's real socket underneath).
 *   [ ] Attempting to drag a NEW wire onto a known-vacant hole is refused —
 *       both by `VACANT_SLOT_TYPE` (a normally-typed target) and by the
 *       `onConnectOutput` guard in `index.js` (a wildcard-typed target);
 *       this harness cannot exercise litegraph's actual connect() gate.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  KIND_META,
  MAX_ROWS,
  MAX_ROW_NAME_LEN,
  ZW,
  VACANT_SLOT_TYPE,
  mkRow,
  assignSlot,
  isPickerKind,
  outputTypeForRow,
  SLOT_LABEL_MODE,
  stripZeroWidthEdges,
  defaultSlotLabel,
  ROW_PRESETS,
  applyResolvedKind,
  planHoleCompaction,
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
  onResizeControls,
  onDrawForegroundControls,
  wrapSetSizeControls,
  applyContentHeight,
  addRowAndSync,
  duplicateRowAndSync,
  removeRowAndSync,
  resolveAutoOnConnect,
  closeActiveOverlay,
  teardownAllZoomPassthrough,
} from "./interaction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// A "small computed" size, distinct from any size a test explicitly sets --
// used only by the `clobberSizeOnOutputChange` opt-in below, to mimic
// litegraph's own documented `this.size = this.computeSize()` side effect on
// `removeOutput`/`addOutput` (see `syncOutputs`'s own doc comment in
// `interaction.mjs` for the full "shrinks to min on every refresh" mechanism
// this proves the fix against; matches `js/anima/test_resize.mjs`'s own
// `_MOCK_COMPUTED_SIZE` in spirit, kept as an independent constant here).
const _MOCK_COMPUTED_SIZE = [80, 32];

/** Build a `[w, h]`-shaped size using `Ctor` (`Array` or `Float64Array`) --
 * the one helper every Float64Array-parametrised test below uses instead of
 * a bare `[w, h]` literal, so a test can assert against either shape without
 * duplicating the values. Mirrors `js/anima/test_resize.mjs`'s identically-
 * named helper (kept as an independent copy, not a cross-track import --
 * this pack's tracks stay independent test modules, same as their own
 * `captureNodeSize`/`restoreNodeSize` duplication). */
function mkSize(Ctor, w, h) {
  return Ctor === Float64Array ? Float64Array.from([w, h]) : [w, h];
}

/** `opts.clobberSizeOnOutputChange` (default `false`, so every EXISTING
 * caller of `makeFakeNode()` is unaffected) makes `addOutput`/`removeOutput`
 * additionally overwrite `node.size` with `_MOCK_COMPUTED_SIZE`, mimicking
 * litegraph's own real API methods -- opt-in rather than the default so this
 * doesn't change behaviour for the ~150 other tests in this file that build
 * a node with rows/outputs but never touch `node.size` at all.
 *
 * `opts.sizeCtor` (default `Array`) -- the 2026-07-29 Float64Array fix's own
 * regression coverage: pass `Float64Array` to make EVERY internal
 * reassignment of `node.size` this stub performs (the initial value,
 * `setSize`, and the `clobberSizeOnOutputChange` mock) use that shape
 * instead of a plain array -- reproducing the actual live shape
 * (`node.size` is a Float64Array VIEW over a Rectangle on a real litegraph
 * node, NOT a plain Array; see `../shared/size.mjs`'s own top doc comment).
 * Every EXISTING caller that doesn't pass this stays a plain array,
 * byte-identical to before this option existed. */
function makeFakeNode(initialStateJSON, opts = {}) {
  const sizeCtor = opts.sizeCtor === Float64Array ? Float64Array : Array;
  const node = {
    size: mkSize(sizeCtor, DEFAULT_W, 100),
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
    addDOMWidget(name, type, element, options) {
      node._domHost.push(element);
      const w = {
        name,
        type,
        element,
        // Mirrors the real `addDOMWidget(name, type, element, options)`
        // contract -- the 4th argument (`getMinHeight`/`getMaxHeight`/
        // `serialize`/`margin`/...) lands on `w.options`, not just gets
        // dropped. Needed so a test can assert `getMinHeight`/`getMaxHeight`
        // were actually passed (the min==max height-pin fix) rather than
        // only ever seeing an empty `{}` regardless of what the real code
        // called `addDOMWidget` with.
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
      if (opts.clobberSizeOnOutputChange) {
        node.size = mkSize(sizeCtor, _MOCK_COMPUTED_SIZE[0], _MOCK_COMPUTED_SIZE[1]);
      }
      return out;
    },
    removeOutput(idx) {
      node.outputs.splice(idx, 1);
      if (opts.clobberSizeOnOutputChange) {
        node.size = mkSize(sizeCtor, _MOCK_COMPUTED_SIZE[0], _MOCK_COMPUTED_SIZE[1]);
      }
    },
    setSize(size) {
      node.size = mkSize(sizeCtor, size[0], size[1]);
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
    // Injected by index.js's buildCtx in the real extension (this file's
    // own "Load-race sizing guard" section, below) -- left undefined by
    // default so the ~150 other tests that never pass it get the exact
    // pre-existing behaviour (`scheduleFit`'s guard treats a non-function
    // `ctx.isGraphLoading` as "not loading").
    isGraphLoading: overrides.isGraphLoading,
    // BUG 15's own scale accessor (`index.js`'s `getCanvasScale`, now wired
    // into `buildCtx` too) -- left undefined by default, same reasoning as
    // `isGraphLoading` above: `wireGrip`'s own fallback treats a missing/
    // non-function `ctx.getCanvasScale` as scale 1, so every pre-existing
    // drag test (which never passes this) keeps its exact prior behaviour.
    // Only the dedicated BUG 15 tests below override it.
    getCanvasScale: overrides.getCanvasScale,
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

// ---------------------------------------------------------------------------
// docs/pixaroma-review-rounds-plan.md Tier 2 item 8 -- "rows overflow at
// minimum node width". This harness has no real layout engine (a stub DOM,
// per this file's own top doc comment), so it CANNOT catch the actual
// visual overflow -- that was verified separately with a real headless-
// Chrome render (measuring getBoundingClientRect() against the row's own
// box; see the build report for that run's numbers). What it CAN pin down
// forever, cheaply: the CSS text still carries the exact declarations the
// fix depends on (a crude guard -- it fails if someone deletes them, it
// can't verify layout), and the DOM shape those declarations assume never
// regresses (the dot as a SIBLING of the clipped body, never inside it;
// every fixed-furniture element still tagged flex: none).
// ---------------------------------------------------------------------------

/** The body text of `cssText`'s rule whose selector list has an entry that
 * is EXACTLY `selector` (nothing else -- no descendant combinator, no
 * compound class, no pseudo-class), or `null`. A naive "does `selector {`
 * appear anywhere in the text" check is NOT enough: `.wtn-ctl-gear` is also
 * the tail end of a comma-separated multi-selector rule
 * (`.wtn-ctl-row.wtn-ctl-slider .wtn-ctl-val,\n.wtn-ctl-row.wtn-ctl-slider
 * .wtn-ctl-gear { position: relative; z-index: 1; }`) that appears EARLIER
 * in the stylesheet than this class's own base rule -- a substring match
 * would silently grab that unrelated rule's body instead (caught by this
 * very test file wrongly failing against a correct fix, while writing it). */
function cssRuleBody(cssText, selector) {
  // Strip /* ... */ comments first -- this codebase's CSS is heavily
  // commented (a doc comment precedes nearly every rule), and a comment has
  // no braces of its own, so left in place it gets swallowed into the NEXT
  // rule's "selector" capture below, and a selector-list of "<giant comment
  // text> .wtn-ctl-row" never exactly-equals ".wtn-ctl-row".
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, " ");
  const ruleRe = /([^{}]+)\{([^}]*)\}/g;
  let match;
  while ((match = ruleRe.exec(stripped))) {
    const [, selectorList, body] = match;
    const selectors = selectorList.split(",").map((s) => s.replace(/\s+/g, " ").trim());
    if (selectors.includes(selector)) {
      return body;
    }
  }
  return null;
}

test("injected CSS: .wtn-ctl-body (the clipped furniture box) carries overflow: hidden -- the actual item 8 fix", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-controls-style").textContent;
  const body = cssRuleBody(cssText, ".wtn-ctl-body");
  assert.ok(body, "expected a .wtn-ctl-body rule in the injected CSS");
  assert.ok(body.includes("overflow: hidden"), ".wtn-ctl-body must clip its own children");
});

test("injected CSS: .wtn-ctl-row itself carries NO overflow: hidden -- that would also clip .wtn-ctl-dot, which sits OUTSIDE .wtn-ctl-body on purpose (verified live: this is what the naive port of Pixaroma's fix would have broken)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-controls-style").textContent;
  const row = cssRuleBody(cssText, ".wtn-ctl-row");
  assert.ok(row, "expected a .wtn-ctl-row rule in the injected CSS");
  assert.ok(!row.includes("overflow"), ".wtn-ctl-row must not clip -- that lives on .wtn-ctl-body instead");
});

test("injected CSS: .wtn-ctl-val can shrink all the way to nothing (min-width: 0) and ellipsizes instead of a hard cut", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-controls-style").textContent;
  const val = cssRuleBody(cssText, ".wtn-ctl-val");
  assert.ok(val, "expected a .wtn-ctl-val rule in the injected CSS");
  assert.ok(val.includes("min-width: 0"), ".wtn-ctl-val must have no content-based shrink floor");
  assert.ok(val.includes("overflow: hidden") && val.includes("text-overflow: ellipsis"));
});

test("injected CSS: .wtn-ctl-name keeps its 54px floor and shrinks MORE eagerly than .wtn-ctl-val (value preferred, per this module's own CSS comment)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-controls-style").textContent;
  const name = cssRuleBody(cssText, ".wtn-ctl-name");
  assert.ok(name, "expected a .wtn-ctl-name rule in the injected CSS");
  assert.ok(name.includes("min-width: 54px"));
  const nameShrinkMatch = name.match(/flex:\s*(\d+)\s+(\d+)\s+auto/);
  assert.ok(nameShrinkMatch, ".wtn-ctl-name must declare an explicit flex shorthand");
  const nameShrink = Number(nameShrinkMatch[2]);
  assert.ok(nameShrink > 1, `.wtn-ctl-name's shrink factor (${nameShrink}) must exceed the default so it gives way before .wtn-ctl-val does`);
});

test("buildRowElement: .wtn-ctl-row has exactly two children -- .wtn-ctl-body and .wtn-ctl-dot, the dot a SIBLING of body, never nested inside it (this is what lets .wtn-ctl-body clip furniture without clipping the dot)", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc, mkRow("seed"), KIND_META.seed, CONTROL_PANEL_CONFIG);
  assert.equal(refs.root.children.length, 2);
  assert.equal(refs.root.children[0], refs.body);
  assert.equal(refs.root.children[1], refs.dot);
  assert.equal(refs.dot.parentNode, refs.root);
  assert.notEqual(refs.dot.parentNode, refs.body);
  assert.ok(refs.body.classList.contains("wtn-ctl-body"));
});

test("buildRowElement: every seed-row child that must never escape the border (grip/name/val/mode/N/reuse/gear) lives inside .wtn-ctl-body, none directly on .wtn-ctl-row", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc, mkRow("seed"), KIND_META.seed, CONTROL_PANEL_CONFIG);
  for (const key of ["grip", "name", "val", "modeBtn", "newBtn", "reuseBtn", "gear"]) {
    assert.equal(refs[key].parentNode, refs.body, `refs.${key} must be a child of .wtn-ctl-body`);
  }
});

test("buildRowElement: a numeric (int/float) row's .wtn-ctl-fill is inserted into .wtn-ctl-body (not .wtn-ctl-row), so it stays inset within the clipped box exactly as before the row/body split", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc, mkRow("int"), KIND_META.int, CONTROL_PANEL_CONFIG);
  assert.equal(refs.fill.parentNode, refs.body);
  assert.equal(refs.val.parentNode, refs.body);
  // fill precedes name/val in source order (paints behind them, per render.mjs's
  // own comment on this insertBefore call) -- still true one level deeper,
  // inside body, regardless of whether a reorder grip sits before it too.
  const children = refs.body.children;
  assert.ok(children.indexOf(refs.fill) < children.indexOf(refs.name));
  assert.ok(children.indexOf(refs.fill) < children.indexOf(refs.val));
});

test("buildRowElement: the fixed furniture (grip/mini buttons/gear) is genuinely flex: none in the injected CSS -- the whole shrink-priority scheme depends on ONLY .wtn-ctl-name/.wtn-ctl-val being flexible", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-controls-style").textContent;
  for (const selector of [".wtn-ctl-grip", ".wtn-ctl-mini", ".wtn-ctl-gear"]) {
    const body = cssRuleBody(cssText, selector);
    assert.ok(body, `expected a ${selector} rule in the injected CSS`);
    assert.ok(body.includes("flex: none"), `${selector} must be flex: none -- fixed furniture, never squeezed`);
  }
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

test("buildRowElement: a seed row gets val + mode button + N button + reuse button + gear, reuse button starts hidden", () => {
  const doc = makeDocStub();
  const row = mkRow("seed");
  const refs = buildRowElement(doc, row, KIND_META.seed, CONTROL_PANEL_CONFIG);
  assert.ok(refs.val && refs.modeBtn && refs.newBtn && refs.reuseBtn && refs.gear);
  assert.ok(refs.reuseBtn.classList.contains("wtn-ctl-hidden"));
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

// TOKENS.surface/TOKENS.console aren't exported from render.mjs (single
// source of truth stays internal to that module -- see its own doc
// comment); mirrored here as literals, matching this pack's existing
// convention of a hardcoded fallback pair (e.g. this same file's CSS
// `var(--wtn-x, #fallback)` strings). The title-bar is TOKENS.console (the
// same inset "field background" token as the DOM rows' own fields), not
// TOKENS.surface2 -- it reads as the darkest band on the node.
const CHROME_BODY = "#151a21";
const CHROME_HEADER = "#0a0d12";

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
  // Pre-seed `node.outputs` as if a real reload had already restored them
  // (litegraph configures `node.outputs`/`.links` wholesale from the saved
  // workflow BEFORE this pack's own JS ever runs) -- with slot 5's own
  // output WIRED, so `compactHoles` (rows.mjs's `planHoleCompaction`)
  // leaves this gap alone and this test keeps testing "sizes to highest
  // slot," not the separate hole-compaction behaviour (covered in its own
  // section below).
  node.outputs = [
    { name: "value_1", type: "*" },
    { name: "value_2", type: "*" },
    { name: "value_3", type: "*" },
    { name: "value_4", type: "*" },
    { name: "value_5", type: "*", links: [999] },
  ];
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
  const c = addRowAndSync(node, ctx, "seed"); // slot 3
  node.outputs[c.slot - 1].links = [123]; // wired -- keep slot 1's gap genuinely open below it, not auto-compacted
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
// C0b. Interior holes left by a row removal (Bug 1 regression). Removing a
// row frees its SLOT NUMBER without shrinking `node.outputs` past the
// current max (slot is a durable output-array index, never renumbered --
// rows.mjs's module doc comment). Before the fix, `syncOutputs` never
// revisited an index no row claims, so it kept whatever `.name`/`.label`/
// `.pos` the vacated row last left there -- a real dot, with the removed
// row's own display text, floating wherever that row's widget last sat
// (typically over the "+ Add control" strip, since a removed row is
// usually the last one added). `markSlotVacant` is what these tests pin
// down: EVERY index no row owns must have a blank label, a connection-
// refusing type, and a hidden/parked (never stale) `.pos`, on every single
// sync -- not just the one right after a removal.
//
// `compactHoles` (`rows.mjs`'s `planHoleCompaction`) now tries to CLOSE a
// hole outright before any of that even applies -- so every test below that
// wants a hole to actually SURVIVE (to exercise `markSlotVacant`/
// `parkVacantSlot`) must WIRE the row above it first, exactly the
// precondition that blocks compaction. Tests that want to see compaction
// actually happen live in their own section, "C0c" below.
// ---------------------------------------------------------------------------

/** Assert output index `idx` (0-based) is a fully inert, SURVIVING hole (one
 * `compactHoles` could not close because the row that would have filled it
 * is wired): contract-correct name, blank label, a type that refuses every
 * connection, `hidden`, and a DELIBERATELY PARKED `.pos` sitting below every
 * live row's own dot -- never simply absent (see `interaction.mjs`'s
 * `markSlotVacant`/`parkVacantSlot` doc comments for why `delete out.pos`
 * stopped being enough: it handed the slot to litegraph's own default
 * output stacking, which parks it at the TOP of the node, beside the
 * title). */
function assertSlotIsVacant(node, idx, msgSuffix = "") {
  const out = node.outputs[idx];
  assert.ok(out, `expected an output object at index ${idx}${msgSuffix}`);
  assert.equal(out.name, `value_${idx + 1}`, `vacant slot ${idx + 1} name must still match RETURN_NAMES${msgSuffix}`);
  assert.equal(out.label, ZW, `vacant slot ${idx + 1} label must be blanked to ZW${msgSuffix}`);
  assert.equal(out.type, VACANT_SLOT_TYPE, `vacant slot ${idx + 1} type must refuse connections${msgSuffix}`);
  assert.notEqual(out.type, "*", `vacant slot ${idx + 1} must never be wildcard-typed (accepts any wire)${msgSuffix}`);
  assert.equal(out.hidden, true, `vacant slot ${idx + 1} must be hidden${msgSuffix}`);
  assert.ok(
    Array.isArray(out.pos) && out.pos.length === 2 && Number.isFinite(out.pos[1]),
    `vacant slot ${idx + 1} must have a real, parked .pos, not merely absent${msgSuffix}`,
  );
  const liveYs = node.outputs
    .filter((o) => o && o !== out && o.type !== VACANT_SLOT_TYPE && Array.isArray(o.pos))
    .map((o) => o.pos[1]);
  liveYs.forEach((y) => {
    assert.ok(
      out.pos[1] > y,
      `vacant slot ${idx + 1}'s parked dot (y=${out.pos[1]}) must sit BELOW every live row's own dot (y=${y})${msgSuffix}`,
    );
  });
}

test("removeRowAndSync: removing the FIRST of several rows leaves an inert hole at slot 1, not an orphan label/dot", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const first = addRowAndSync(node, ctx, "int"); // slot 1
  addRowAndSync(node, ctx, "float"); // slot 2
  const seed = addRowAndSync(node, ctx, "seed"); // slot 3
  node.outputs[seed.slot - 1].links = [999]; // wired -- keep this a genuinely un-closable hole

  removeRowAndSync(node, ctx, first.id);

  assert.equal(node.outputs.length, 3, "node.outputs must NOT shrink past the highest surviving slot");
  assertSlotIsVacant(node, 0, " (removed FIRST row)");
});

test("removeRowAndSync: removing a MIDDLE row of several leaves an inert hole, rows above and below keep their own output objects and links", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const a = addRowAndSync(node, ctx, "int"); // slot 1
  const b = addRowAndSync(node, ctx, "float"); // slot 2
  const c = addRowAndSync(node, ctx, "seed"); // slot 3

  const outA = node.outputs[a.slot - 1];
  const outC = node.outputs[c.slot - 1];
  // Simulate a real wire on the rows that must survive the removal.
  outA.links = [111];
  outC.links = [222];

  removeRowAndSync(node, ctx, b.id);

  assert.equal(node.outputs.length, 3, "node.outputs must NOT shrink past slot 3");
  assertSlotIsVacant(node, b.slot - 1, " (removed MIDDLE row)");
  // Renumbering would have shifted slot 3's output down to index 1 -- assert
  // it did NOT move, and its wire survived untouched.
  assert.equal(node.outputs[a.slot - 1], outA, "row above the removed one must keep its OWN output object");
  assert.equal(node.outputs[c.slot - 1], outC, "row below the removed one must keep its OWN output object");
  assert.deepEqual(node.outputs[a.slot - 1].links, [111], "the row above must keep its wire");
  assert.deepEqual(node.outputs[c.slot - 1].links, [222], "the row below must keep its wire (this is what renumbering would break)");
});

test("removeRowAndSync: removing the LAST row shrinks node.outputs cleanly -- no hole, nothing to blank", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  addRowAndSync(node, ctx, "int"); // slot 1
  addRowAndSync(node, ctx, "float"); // slot 2
  const last = addRowAndSync(node, ctx, "seed"); // slot 3

  removeRowAndSync(node, ctx, last.id);

  assert.equal(node.outputs.length, 2, "the trailing slot must be removed outright, not left as a hole");
  node.outputs.forEach((out, idx) => {
    assert.notEqual(out.type, VACANT_SLOT_TYPE, `slot ${idx + 1} is still owned -- must not be marked vacant`);
  });
});

test("removeRowAndSync: a hole is re-blanked on EVERY subsequent sync, not just the removal that created it", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const a = addRowAndSync(node, ctx, "int"); // slot 1
  const b = addRowAndSync(node, ctx, "float"); // slot 2
  node.outputs[b.slot - 1].links = [999]; // wired -- keep this a genuinely un-closable hole
  removeRowAndSync(node, ctx, a.id); // slot 1 becomes a hole
  assertSlotIsVacant(node, 0);

  // Simulate whatever the pre-fix bug left behind (a stale pos/label/type
  // parked from a previous session) landing on the hole again, then a
  // plain repaint-equivalent resync (no structural mutation at all) --
  // the invariant must hold on EVERY call, not only immediately after the
  // row that vacated the slot was removed.
  const hole = node.outputs[0];
  hole.pos = [123, 456];
  hole.label = "stale leftover text";
  hole.type = "*";

  syncOutputs(node, ctx);

  assertSlotIsVacant(node, 0, " (after a forced-stale repaint resync)");
});

test("addRowAndSync: adding a row after removing one reuses the freed slot and renders as a normal owned slot again", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const a = addRowAndSync(node, ctx, "int"); // slot 1
  const removedSlot = a.slot;
  const b = addRowAndSync(node, ctx, "float"); // slot 2
  node.outputs[b.slot - 1].links = [999]; // wired -- keep the freed slot below it genuinely open, not auto-compacted away
  removeRowAndSync(node, ctx, a.id); // frees slot 1
  assertSlotIsVacant(node, removedSlot - 1);

  const reused = addRowAndSync(node, ctx, "seed");
  assert.equal(reused.slot, removedSlot, "assignSlot must hand the freed slot to the next new row before any number above the max");

  const out = node.outputs[reused.slot - 1];
  assert.equal(out.name, `value_${reused.slot}`);
  assert.equal(out.label, reused.name, "the reused slot's label must be the NEW row's own name, not still blank/vacant");
  assert.notEqual(out.type, VACANT_SLOT_TYPE, "a reused slot must no longer refuse connections");
});

test("removeRowAndSync: removing every row down to zero leaves a clean node -- no holes, no outputs at all", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const a = addRowAndSync(node, ctx, "int");
  const b = addRowAndSync(node, ctx, "float");
  const c = addRowAndSync(node, ctx, "seed");

  removeRowAndSync(node, ctx, a.id);
  removeRowAndSync(node, ctx, b.id);
  removeRowAndSync(node, ctx, c.id);

  assert.equal(node.outputs.length, 0, "a fully emptied panel must leave zero outputs, not lingering vacant holes");
});

// ---------------------------------------------------------------------------
// C0c. planHoleCompaction (rows.mjs) -- the actual stray-output-dot fix.
// Diagnosed live on a real graph: add a row (takes slot 6), remove it ->
// slot 6 becomes an interior hole while slot 7 is still live. Before this
// fix, `markSlotVacant` blanked the hole but `delete out.pos` handed it to
// litegraph's own default output stacking, which parks an unpositioned
// output at the TOP of the node, beside the title -- the reported bug.
// `planHoleCompaction` is the pure planner; these tests exercise it
// directly (no node/litegraph involved at all), and the end-to-end block
// right after exercises the whole pipeline through a stubbed node.
// ---------------------------------------------------------------------------

// The exact probe layout from the live bug report: live slots 1,2,3,4,5,7,
// hole at 6.
const PROBE_SLOTS = [1, 2, 3, 4, 5, 7];

function slotsRows(slots) {
  return slots.map((slot) => ({ slot }));
}

test("planHoleCompaction: the live-bug-report probe layout (1,2,3,4,5,7 + hole at 6), slot 7 unwired -> moves 7 into 6", () => {
  const plan = planHoleCompaction(slotsRows(PROBE_SLOTS), () => false);
  assert.deepEqual(plan, [{ from: 7, to: 6 }]);
});

test("planHoleCompaction: the exact same probe layout, slot 7 WIRED -> empty plan (never renumber a wired row)", () => {
  const plan = planHoleCompaction(slotsRows(PROBE_SLOTS), (slot) => slot === 7);
  assert.deepEqual(plan, []);
});

test("planHoleCompaction: several holes (1,2,4,6,8 -- holes at 3,5,7) with everything unwired collapses fully to 1..5", () => {
  const plan = planHoleCompaction(slotsRows([1, 2, 4, 6, 8]), () => false);
  assert.deepEqual(plan, [
    { from: 6, to: 3 },
    { from: 8, to: 5 },
  ]);
});

test("planHoleCompaction: several holes, but the row that would have to move to reach the LOWEST hole is wired -- partial compaction, one hole survives", () => {
  // Same layout as above, but slot 6's own row (the one that would have to
  // move to close hole 3, per the cascade) is wired -- so hole 3 must
  // survive even though slot 8's row (unwired) still closes hole 5.
  const plan = planHoleCompaction(slotsRows([1, 2, 4, 6, 8]), (slot) => slot === 6);
  assert.deepEqual(plan, [{ from: 8, to: 5 }]);
});

test("planHoleCompaction: no holes at all -> empty plan", () => {
  const plan = planHoleCompaction(slotsRows([1, 2, 3]), () => false);
  assert.deepEqual(plan, []);
});

test("planHoleCompaction: a hole with nothing above it (the removed row WAS the top slot) is not interior -- empty plan, the existing trailing trim already handles it", () => {
  // Rows as they stand AFTER removing what used to be slot 4 (the max) --
  // there is no slot above 3 for this function to even consider a hole
  // under, so it must not manufacture one.
  const plan = planHoleCompaction(slotsRows([1, 2, 3]), () => false);
  assert.deepEqual(plan, []);
});

test("planHoleCompaction: no rows at all -> empty plan (nothing to compact)", () => {
  assert.deepEqual(planHoleCompaction([], () => false), []);
});

test("planHoleCompaction: never mutates the rows it was given -- pure planner", () => {
  const rows = slotsRows(PROBE_SLOTS);
  const snapshot = JSON.parse(JSON.stringify(rows));
  planHoleCompaction(rows, () => false);
  assert.deepEqual(rows, snapshot, "planHoleCompaction must not rewrite row.slot itself -- that's compactHoles's job");
});

test("end-to-end (stubbed node): add-then-remove reproducing the user's exact sequence leaves NO __wtn_ctl_vacant__ entry when the row above the hole is unwired", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });

  // sampler, scheduler, int, int, float, latent -- slots 1..6, matching the
  // probe's kinds/order (COMBO, COMBO, INT, INT, FLOAT, LATENT).
  addRowAndSync(node, ctx, "sampler"); // slot 1
  addRowAndSync(node, ctx, "scheduler"); // slot 2
  addRowAndSync(node, ctx, "int"); // slot 3
  addRowAndSync(node, ctx, "int"); // slot 4
  addRowAndSync(node, ctx, "float"); // slot 5
  const extra = addRowAndSync(node, ctx, "latent"); // slot 6 -- "add a row (it takes slot 6)"
  assert.equal(extra.slot, 6, "test setup expected the new row to take slot 6, per the live bug report");
  const seventh = addRowAndSync(node, ctx, "int"); // slot 7 -- still live, per the probe
  assert.equal(seventh.slot, 7);

  removeRowAndSync(node, ctx, extra.id); // "remove it -> slot 6 becomes an interior hole"

  assert.equal(node.outputs.length, 6, "compaction should have closed the hole and let the trailing trim shrink past the old top slot");
  node.outputs.forEach((out, idx) => {
    assert.notEqual(out.type, VACANT_SLOT_TYPE, `slot ${idx + 1} must not be a __wtn_ctl_vacant__ hole -- compaction should have closed it`);
  });
  const state = ensureState(node, ctx);
  assert.equal(state.rows.find((r) => r.id === seventh.id).slot, 6, "the row that was at slot 7 must have moved down into the closed hole");
});

test("end-to-end (stubbed node): the SAME sequence, but the row above the hole is wired, leaves ONE surviving __wtn_ctl_vacant__ entry, parked below the live rows -- never beside the title", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });

  addRowAndSync(node, ctx, "sampler"); // slot 1
  addRowAndSync(node, ctx, "scheduler"); // slot 2
  addRowAndSync(node, ctx, "int"); // slot 3
  addRowAndSync(node, ctx, "int"); // slot 4
  addRowAndSync(node, ctx, "float"); // slot 5
  const extra = addRowAndSync(node, ctx, "latent"); // slot 6
  const seventh = addRowAndSync(node, ctx, "int"); // slot 7
  node.outputs[seventh.slot - 1].links = [999]; // wired -- the graph really is using this one

  removeRowAndSync(node, ctx, extra.id);
  // `removeRowAndSync` rebuilds row DOM (row count changed), which mints
  // fresh widgets with no `.y` yet -- `fakeArrange` + a bare repaint mirror
  // what a real litegraph `arrange()` pass would already have done before
  // `alignOutputsLegacy`/`parkVacantSlot` ever run (see this file's own
  // `fakeArrange` doc comment / the "alignOutputsLegacy parks..." test).
  fakeArrange(node);
  syncOutputs(node, ctx);

  assert.equal(node.outputs.length, 7, "node.outputs must NOT shrink past the wired slot 7");
  const vacant = node.outputs.filter((out) => out.type === VACANT_SLOT_TYPE);
  assert.equal(vacant.length, 1, "exactly one surviving __wtn_ctl_vacant__ hole");
  assertSlotIsVacant(node, 5, " (surviving hole at slot 6)"); // asserts hidden + parked pos below every live row
  // Never beside the title: the title sits above every row, i.e. above the
  // FIRST live row's own y -- the parked hole must be well below that.
  const firstLiveY = node.outputs[0].pos[1];
  assert.ok(vacant[0].pos[1] > firstLiveY, "the surviving hole's dot must never land up near the title");
});

test("a surviving vacant slot is hidden, has a real parked .pos, and that .pos sits below every live row's own dot -- never beside the title, never over '+ Add control'", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const a = addRowAndSync(node, ctx, "int"); // slot 1
  const b = addRowAndSync(node, ctx, "float"); // slot 2
  node.outputs[b.slot - 1].links = [999]; // wired -- forces the hole below it to survive

  removeRowAndSync(node, ctx, a.id);
  fakeArrange(node); // see the previous test's comment
  syncOutputs(node, ctx);

  const hole = node.outputs[0];
  assert.equal(hole.hidden, true);
  assert.ok(Array.isArray(hole.pos) && Number.isFinite(hole.pos[1]));
  assert.ok(hole.pos[1] > node.outputs[b.slot - 1].pos[1], "the hole's dot must sit below the surviving live row's own dot");
});

// ---------------------------------------------------------------------------
// C0d. Load-path regression: `syncOutputs` must skip `compactHoles` entirely
// while `node._ctrlConfiguring` is truthy (index.js's own restore-vs-create
// flag -- `restoreNode`/`setupNode` both call `syncRows` -> `syncOutputs`
// while it's set for a node being loaded from a saved workflow). A saved
// hole is that workflow's own last-saved shape; loading it must reproduce it
// unchanged, never "fix" it by renumbering a row and calling `removeOutput`
// the way a genuine user-driven remove/add would. Same probe layout as the
// C0c end-to-end tests above (live slots 1,2,3,4,5,7, hole at 6, slot 7
// unwired) so this is a direct paired comparison against "today's" behavior.
// ---------------------------------------------------------------------------

function buildProbeLayout(node, ctx) {
  addRowAndSync(node, ctx, "sampler"); // slot 1
  addRowAndSync(node, ctx, "scheduler"); // slot 2
  addRowAndSync(node, ctx, "int"); // slot 3
  addRowAndSync(node, ctx, "int"); // slot 4
  addRowAndSync(node, ctx, "float"); // slot 5
  const extra = addRowAndSync(node, ctx, "latent"); // slot 6
  const seventh = addRowAndSync(node, ctx, "int"); // slot 7
  assert.equal(extra.slot, 6, "test setup expected the new row to take slot 6");
  assert.equal(seventh.slot, 7, "test setup expected the probe's trailing row to take slot 7");
  return { extra, seventh };
}

test("syncOutputs: _ctrlConfiguring=true (simulated workflow restore) keeps the probe layout's hole intact -- never renumbers slot 7's row into it", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const { extra, seventh } = buildProbeLayout(node, ctx);

  node._ctrlConfiguring = true; // a workflow load is "in flight" for this node
  removeRowAndSync(node, ctx, extra.id); // frees slot 6 -- an interior hole, per the probe

  assert.equal(node.outputs.length, 7, "a restore must never shrink node.outputs past slot 7, which a live row still occupies");
  assert.equal(node.outputs[5].type, VACANT_SLOT_TYPE, "the hole at slot 6 must survive a restore untouched, not get closed");
  const state = ensureState(node, ctx);
  assert.equal(state.rows.find((r) => r.id === seventh.id).slot, 7, "slot 7's row must NOT be renumbered while _ctrlConfiguring is set");
});

test("syncOutputs: the IDENTICAL probe layout with _ctrlConfiguring unset compacts exactly as it does today -- the hole closes and slot 7's row moves down into it", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  const { extra, seventh } = buildProbeLayout(node, ctx);

  // node._ctrlConfiguring deliberately left unset -- a genuine user-driven
  // remove, mid-session.
  removeRowAndSync(node, ctx, extra.id);

  assert.equal(node.outputs.length, 6, "compaction should have closed the hole and let the trailing trim shrink past the old top slot");
  node.outputs.forEach((out, idx) => {
    assert.notEqual(out.type, VACANT_SLOT_TYPE, `slot ${idx + 1} must not be a __wtn_ctl_vacant__ hole -- compaction should have closed it`);
  });
  const state = ensureState(node, ctx);
  assert.equal(state.rows.find((r) => r.id === seventh.id).slot, 6, "the row that was at slot 7 must have moved down into the closed hole");
});

test("syncOutputs: the trailing-slot trim still runs while _ctrlConfiguring is set -- only compactHoles is gated, not the trim/grow loop", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getKnownLists: () => ({ sampler: ["euler"], scheduler: ["normal"] }) });
  addRowAndSync(node, ctx, "sampler"); // slot 1
  addRowAndSync(node, ctx, "scheduler"); // slot 2
  const last = addRowAndSync(node, ctx, "int"); // slot 3 -- the current top slot, nothing above it

  node._ctrlConfiguring = true;
  removeRowAndSync(node, ctx, last.id); // frees the TOP slot -- a trailing hole, not an interior one

  assert.equal(node.outputs.length, 2, "the trailing slot must still be trimmed outright during a simulated restore, exactly as mid-session");
  node.outputs.forEach((out) => assert.notEqual(out.type, VACANT_SLOT_TYPE, "no lingering vacant hole should exist after a trailing trim"));
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
  const seedRow = addRowAndSync(node, ctx, "seed"); // slot 3
  node.outputs[seedRow.slot - 1].links = [999]; // wired -- keep slot 1's hole genuinely open below it
  assert.equal(node.outputs[intRow.slot - 1].label, "int");

  removeRowAndSync(node, ctx, intRow.id); // frees slot 1; its output's label is untouched leftover text
  const samplerRow = addRowAndSync(node, ctx, "sampler"); // reuses slot 1 -- a BRAND NEW row id
  assert.equal(samplerRow.slot, intRow.slot, "test setup expected the freed slot to be reused");
  assert.equal(node.outputs[samplerRow.slot - 1].label, "sampler", "reused slot must adopt the NEW occupant's own label, not the old row's");
});

// ---------------------------------------------------------------------------
// C2. Slot label ownership survives a RELOAD -- live bug report: a socket
// renamed via litegraph's own Rename Slot dialog reverted (either to the
// row's own name or to a zero-width blank) on the very first sync after a
// page/workflow reload. Root cause (confirmed by the repro below, BEFORE the
// fix): `index.js` runs `ensureState`+`syncRows` from `onNodeCreated`
// (`setupNode`) and THEN, for a node restored from a saved workflow,
// `restoreStateFromWidget`+`syncRows` AGAIN from `onConfigure`
// (`restoreNode`) -- per that file's own top doc comment, by the time either
// async `.then()` callback actually runs, litegraph's synchronous
// `onConfigure` has ALREADY restored the widget's real saved value, so BOTH
// calls parse the exact same saved JSON. `rows.mjs`'s `normalizeRow` mints a
// BRAND-NEW `row.id` on EVERY parse, so the second parse's rows disagree on
// `id` with the first parse's even though they describe the same logical
// rows. The OLD `syncSlotLabel` tracked ownership in slot-keyed session Maps
// keyed partly by `row.id` (`_ctrlSlotRowId`) and treated that id mismatch as
// "this slot was just handed to a genuinely different row" -- a hard reset
// that unconditionally overwrote `out.label` with the row's own default,
// stomping the user's real rename. The fix moves ownership onto the ROW
// itself (`rows.mjs`'s `slotLabelOwned`, a durable, SERIALIZED field), so it
// no longer matters which `id` generation a row happens to carry this sync.
// ---------------------------------------------------------------------------

/** Reproduces index.js's real two-phase restore sequence against a FRESH
 * node object (mirrors an actual page reload -- never the live node from
 * before "save"). `node.outputs` is seeded from a deep-cloned snapshot of
 * what litegraph would have restored on its own, independently of
 * `panel_state` (a real workflow save serializes `node.outputs`, including
 * `.label`, by itself -- never through this pack's widget at all). Returns
 * the reloaded `{ node, ctx, doc }` after BOTH phases have run, i.e. exactly
 * where a real page would be immediately after load. */
function simulateReload(savedNode, panelConfig) {
  const savedStateJSON = getStateWidget(savedNode).value;
  const doc = makeDocStub();
  const node = makeFakeNode(savedStateJSON);
  node.outputs = savedNode.outputs.map((o) => ({ ...o }));
  const ctx = makeCtx(doc, panelConfig);

  // Phase 1 -- onNodeCreated's setupNode.
  ensureState(node, ctx);
  syncRows(node, ctx);

  // Phase 2 -- onConfigure's restoreNode: forces a SECOND, independent parse
  // of the identical saved JSON (restoreStateFromWidget's whole documented
  // purpose), then syncs again. This is the moment the old session-Map
  // heuristic saw every slot as "reassigned to a different row."
  restoreStateFromWidget(node, ctx);
  syncRows(node, ctx);

  return { node, ctx, doc };
}

test("a slot label set directly on the socket, acknowledged before save, is written into the SERIALIZED panel_state (not just an in-memory session Map) and survives the two-phase reload sequence", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "sampler");
  const out = node.outputs[row.slot - 1];
  assert.equal(out.label, "sampler"); // still-owned default before any user edit

  out.label = "custom_socket_name"; // the user's own litegraph rename
  syncOutputs(node, ctx); // acknowledge/claim ownership -- must persist the claim, per the fix

  const savedRow = JSON.parse(getStateWidget(node).value).rows[0];
  assert.equal(savedRow.slotLabelOwned, true, "the socket rename must be a durable, SERIALIZED fact, not merely a session Map entry");

  const { node: reloaded } = simulateReload(node, CONTROL_PANEL_CONFIG);
  assert.equal(reloaded.outputs[row.slot - 1].label, "custom_socket_name", "the user's socket rename must survive the two-phase onNodeCreated -> onConfigure reload sequence");
});

test("a socket rename that was NEVER acknowledged by a sync before save (still ZW-prefixed, exactly what a live litegraph dump showed) still heals and claims ownership on the FIRST post-reload sync", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "sampler");
  const out = node.outputs[row.slot - 1];

  // The user renames the socket via litegraph's dialog and the workflow is
  // saved in EXACTLY this state -- no intervening sync of ours ever runs in
  // this session (a real ComfyUI serialize doesn't call our code at all).
  out.label = `${ZW}sampler_name`;

  const { node: reloaded } = simulateReload(node, CONTROL_PANEL_CONFIG);
  assert.equal(reloaded.outputs[row.slot - 1].label, "sampler_name", "must heal AND stop reverting on the very first post-reload sync");
  const savedRow = JSON.parse(getStateWidget(reloaded).value).rows[0];
  assert.equal(savedRow.slotLabelOwned, true);
});

test("a user-renamed socket survives an arbitrary number of subsequent syncs, a row add, a row remove, and a ROW rename -- all AFTER a reload", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "sampler");
  const out = node.outputs[row.slot - 1];
  out.label = "custom_socket_name";
  syncOutputs(node, ctx);

  const { node: reloaded, ctx: reloadedCtx, doc: reloadedDoc } = simulateReload(node, CONTROL_PANEL_CONFIG);
  const reloadedRow = ensureState(reloaded, reloadedCtx).rows[0];
  const idx = reloadedRow.slot - 1;
  assert.equal(reloaded.outputs[idx].label, "custom_socket_name");

  syncOutputs(reloaded, reloadedCtx); // a bare repaint-equivalent call
  assert.equal(reloaded.outputs[idx].label, "custom_socket_name");

  const second = addRowAndSync(reloaded, reloadedCtx, "int"); // add -- a full structural resync
  assert.equal(reloaded.outputs[idx].label, "custom_socket_name");

  removeRowAndSync(reloaded, reloadedCtx, second.id); // remove -- another full resync
  assert.equal(reloaded.outputs[idx].label, "custom_socket_name");

  // Rename the ROW itself -- the socket label must still win (existing
  // pre-reload contract at test line ~1235, now proven to also hold once
  // `id` has churned across a reload).
  makeWindowStub(reloadedDoc);
  const entry = reloaded._ctrlRows.find((e) => e.id === reloadedRow.id);
  fire(entry.refs.name, "dblclick");
  entry.refs.nameInput.value = "renamed_row";
  fire(entry.refs.nameInput, "keydown", { key: "Enter" });
  assert.equal(entry.refs.row.name, "renamed_row"); // the ROW did rename
  assert.equal(reloaded.outputs[idx].label, "custom_socket_name", "the SOCKET label must still win over a post-reload row rename");
});

test("a slot the user never touched still follows its row's name across a reload (id churn alone must not falsely claim ownership)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  const row = addRowAndSync(node, ctx, "float"); // never socket-renamed
  assert.equal(node.outputs[row.slot - 1].label, "float");

  const { node: reloaded, ctx: reloadedCtx, doc: reloadedDoc } = simulateReload(node, CONTROL_PANEL_CONFIG);
  const reloadedRow = ensureState(reloaded, reloadedCtx).rows[0];
  const idx = reloadedRow.slot - 1;
  assert.equal(reloaded.outputs[idx].label, "float", "an untouched slot's label must survive the reload unchanged");

  // A row rename must still propagate to the label post-reload -- proves the
  // `raw === want` fallback (needed because the session `_ctrlLastLabel`
  // cache is legitimately empty right after a reload) doesn't accidentally
  // freeze a never-owned slot instead.
  makeWindowStub(reloadedDoc);
  const entry = reloaded._ctrlRows.find((e) => e.id === reloadedRow.id);
  fire(entry.refs.name, "dblclick");
  entry.refs.nameInput.value = "denoise";
  fire(entry.refs.nameInput, "keydown", { key: "Enter" });
  assert.equal(reloaded.outputs[idx].label, "denoise");
});

test("AnimaLoaderPanel shares the exact same fix -- a socket rename on a loader row survives the two-phase reload sequence too", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // unet/vae/clip, slots 1/2/3 -- defaultState(loader)
  const unetRow = ensureState(node, ctx).rows.find((r) => r.kind === "unet");
  const out = node.outputs[unetRow.slot - 1];
  assert.equal(out.label, "unet");

  out.label = "base_model"; // the user's own litegraph rename
  syncOutputs(node, ctx); // acknowledge/claim + persist

  const savedRow = JSON.parse(getStateWidget(node).value).rows.find((r) => r.kind === "unet");
  assert.equal(savedRow.slotLabelOwned, true);

  const { node: reloaded } = simulateReload(node, LOADER_PANEL_CONFIG);
  assert.equal(reloaded.outputs[unetRow.slot - 1].label, "base_model", "AnimaLoaderPanel must not revert a socket rename on reload either -- same syncOutputs/syncSlotLabel code path as the Control Panel");
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

// ---------------------------------------------------------------------------
// C2. Size preserve/restore around syncOutputs's trim/grow loops -- the SAME
// "shrinks to min on every refresh" trap `js/anima/interaction.mjs`'s
// `healNodeSockets` fix covers, audited onto this track too. `node.outputs`
// is set up here to deliberately MISMATCH the saved rows' own highest slot
// -- simulating a workflow saved by an older build (before some now-fixed
// hole/compaction bug) or a hand-edited one -- which is the one case
// `syncOutputs`'s own doc comment identifies as still reaching
// `removeOutput`/`addOutput` on the LOAD path (`_ctrlConfiguring` true,
// nothing downstream to fix a clobbered size back up). `clobberSizeOnOutputChange`
// makes the fake node's `removeOutput`/`addOutput` mimic litegraph's own
// documented `this.size = this.computeSize()` side effect, so these cases
// would fail WITHOUT the fix.
// ---------------------------------------------------------------------------

// Parametrised over BOTH a plain-Array and a Float64Array `node.size` -- the
// private `captureNodeSize`/`restoreNodeSize` pair this exercises is exactly
// what the 2026-07-29 Float64Array fix touched (see `../shared/size.mjs`'s
// own top doc comment): before that fix, `Array.isArray(node.size)` was
// `false` for a Float64Array, so `captureNodeSize` silently returned `null`
// and `restoreNodeSize` never ran -- the clobbered (mocked-computed) size
// would have SURVIVED, permanently, exactly the live bug.
for (const SizeCtor of [Array, Float64Array]) {
  test(`syncOutputs preserves the ORIGINAL node.size across a load-time output-count mismatch, even though removeOutput clobbers it along the way (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(
      JSON.stringify({
        version: 1,
        rows: [
          { slot: 1, kind: "int", value: 5, opts: { min: 0, max: 10, step: 1 } },
          { slot: 2, kind: "float", value: 1, opts: { min: 0, max: 10, step: 0.1 } },
        ],
      }),
      { clobberSizeOnOutputChange: true, sizeCtor: SizeCtor },
    );
    // The saved rows only ever own slots 1/2 -- but `node.outputs` (as
    // litegraph would have restored it from an older/hand-edited save) still
    // carries four. This is the mismatch this fix guards against.
    node.outputs = [
      { name: "value_1", type: "*", links: [] },
      { name: "value_2", type: "*", links: [] },
      { name: "value_3", type: "*", links: [] },
      { name: "value_4", type: "*", links: [] },
    ];
    node.size = mkSize(SizeCtor, 512, 900);
    const ctx = makeCtx(makeDocStub(), CONTROL_PANEL_CONFIG);
    node._ctrlConfiguring = true; // the load path -- compactHoles is skipped, trim/grow are not

    syncOutputs(node, ctx);

    assert.equal(node.outputs.length, 2, "sanity: the mismatch must actually get trimmed, or this test proves nothing");
    assert.deepEqual(node.size, mkSize(SizeCtor, 512, 900), "syncOutputs must restore the node's ORIGINAL saved size, not whatever removeOutput clobbered it to");
  });

  test(`syncOutputs: a too-SMALL pre-existing size survives a load-time mismatch fix unchanged -- the fix restores, it does not clamp up to any floor (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(
      JSON.stringify({ version: 1, rows: [{ slot: 1, kind: "int", value: 5, opts: { min: 0, max: 10, step: 1 } }] }),
      { clobberSizeOnOutputChange: true, sizeCtor: SizeCtor },
    );
    node.outputs = [
      { name: "value_1", type: "*", links: [] },
      { name: "value_2", type: "*", links: [] },
    ];
    node.size = mkSize(SizeCtor, 10, 10);
    const ctx = makeCtx(makeDocStub(), CONTROL_PANEL_CONFIG);
    node._ctrlConfiguring = true;

    syncOutputs(node, ctx);

    assert.equal(node.outputs.length, 1);
    assert.deepEqual(node.size, mkSize(SizeCtor, 10, 10), "a tiny saved size must come back exactly as tiny -- the fix never clamps it up");
  });

  test(`syncOutputs: a too-LARGE pre-existing size survives a load-time mismatch fix unchanged -- the fix restores, it does not clamp down to the mocked computed size (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(
      JSON.stringify({ version: 1, rows: [{ slot: 1, kind: "int", value: 5, opts: { min: 0, max: 10, step: 1 } }] }),
      { clobberSizeOnOutputChange: true, sizeCtor: SizeCtor },
    );
    node.outputs = [
      { name: "value_1", type: "*", links: [] },
      { name: "value_2", type: "*", links: [] },
    ];
    node.size = mkSize(SizeCtor, 9000, 9000);
    const ctx = makeCtx(makeDocStub(), CONTROL_PANEL_CONFIG);
    node._ctrlConfiguring = true;

    syncOutputs(node, ctx);

    assert.equal(node.outputs.length, 1);
    assert.deepEqual(node.size, mkSize(SizeCtor, 9000, 9000), "a huge saved size must come back exactly as huge -- the fix never clamps it down");
  });
}

test("syncOutputs never touches node.size at all when node.outputs already matches the saved rows -- same array reference AND same values, and addOutput/removeOutput are never even called", () => {
  const node = makeFakeNode(
    JSON.stringify({ version: 1, rows: [{ slot: 1, kind: "int", value: 5, opts: { min: 0, max: 10, step: 1 } }] }),
    { clobberSizeOnOutputChange: true },
  );
  node.outputs = [{ name: "value_1", type: "*", links: [] }];
  node.size = [777, 333];
  const originalSize = node.size;
  let addCalled = false;
  let removeCalled = false;
  const realAdd = node.addOutput;
  const realRemove = node.removeOutput;
  node.addOutput = (...a) => {
    addCalled = true;
    return realAdd.apply(node, a);
  };
  node.removeOutput = (...a) => {
    removeCalled = true;
    return realRemove.apply(node, a);
  };
  const ctx = makeCtx(makeDocStub(), CONTROL_PANEL_CONFIG);
  node._ctrlConfiguring = true;

  syncOutputs(node, ctx);

  assert.equal(addCalled, false, "already-consistent load must never call addOutput");
  assert.equal(removeCalled, false, "already-consistent load must never call removeOutput");
  assert.equal(node.size, originalSize, "no-op sync must never even touch the size array reference");
  assert.deepEqual(node.size, [777, 333]);
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
  const b = addRowAndSync(node, ctx, "float");
  node.outputs[b.slot - 1].links = [999]; // wired -- keep a's freed slot open for the next add to reuse
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
// index.js's OWN `confirmRemove` -- the "Confirm before removing a row"
// setting (js/shared/settings.mjs, default ON). `index.js` carries a
// top-level `/scripts/app.js` import (this file's own top doc comment), so
// this is a source-level check, the same technique this file's own H2-style
// section already uses for other un-instantiable `index.js` internals.
// `interaction.mjs`'s own `removeRowAndSync`/`ctx.confirmRemove` contract is
// UNCHANGED -- the two tests just above still cover it byte-for-byte; this
// only asserts `index.js`'s `confirmRemove` gates on the LIVE setting before
// ever reaching `window.confirm`.
// ---------------------------------------------------------------------------

test("index.js: confirmRemove reads the LIVE 'Confirm before removing a row' setting, via getSetting, BEFORE ever consulting window.confirm", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /import\s*\{\s*getSetting,\s*SETTING_IDS,\s*SETTING_DEFAULTS,\s*registerAnimaFlowSettings\s*\}\s*from\s*"\.\.\/shared\/settings\.mjs"/,
    "must import getSetting/SETTING_IDS/SETTING_DEFAULTS/registerAnimaFlowSettings eagerly (not through loadMods())",
  );

  const fnIdx = indexSource.indexOf("function confirmRemove(row)");
  assert.ok(fnIdx >= 0, "confirmRemove must exist");
  const nextFnIdx = indexSource.indexOf("function ", fnIdx + 1);
  const fnBody = indexSource.slice(fnIdx, nextFnIdx > fnIdx ? nextFnIdx : undefined);

  const settingCheckIdx = fnBody.indexOf("getSetting(SETTING_IDS.CONFIRM_REMOVE_ROW");
  assert.ok(settingCheckIdx >= 0, "confirmRemove must read the CONFIRM_REMOVE_ROW setting");
  const confirmCallIdx = fnBody.indexOf("window.confirm(");
  assert.ok(confirmCallIdx > settingCheckIdx, "the setting must be checked BEFORE window.confirm is ever reached");
});

test("index.js: registerAnimaFlowSettings is called from beforeRegisterNodeDef, unconditionally (like installQueuePromptHook)", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const beforeIdx = indexSource.indexOf("beforeRegisterNodeDef(nodeType, nodeData) {");
  assert.ok(beforeIdx >= 0);
  const panelConfigIdx = indexSource.indexOf("const panelConfig = CLASS_TO_PANEL[nodeData.name];", beforeIdx);
  assert.ok(panelConfigIdx > beforeIdx, "panelConfig lookup (the class-specific gate) must come after the top of the function");
  const preamble = indexSource.slice(beforeIdx, panelConfigIdx);
  assert.match(preamble, /registerAnimaFlowSettings\(app\)/, "registerAnimaFlowSettings must be called BEFORE the class-specific gate, so it runs for every node type");
});

test("index.js/interaction.mjs: the Wheel quiet period setting is wired into BOTH installCanvasZoomPassthrough call sites via a live getLockMs, not a static lockMs", () => {
  const src = readFileSync(path.join(__dirname, "interaction.mjs"), "utf8");
  assert.match(
    src,
    /import\s*\{\s*getSetting,\s*SETTING_IDS,\s*SETTING_DEFAULTS\s*\}\s*from\s*"\.\.\/shared\/settings\.mjs"/,
    "interaction.mjs must import getSetting/SETTING_IDS/SETTING_DEFAULTS",
  );
  assert.match(src, /getLockMs:\s*\(\)\s*=>\s*getSetting\(SETTING_IDS\.WHEEL_QUIET_PERIOD_MS/, "must resolve the lock ms live, via a getLockMs closure");
  const installCalls = [...src.matchAll(/installCanvasZoomPassthrough\([^)]*\)/g)].map((m) => m[0]);
  assert.ok(installCalls.length >= 2, "there are two installCanvasZoomPassthrough call sites (per-row and the add-row strip)");
  for (const call of installCalls) {
    assert.match(call, /WHEEL_LOCK_OPTIONS/, `every installCanvasZoomPassthrough call site must pass WHEEL_LOCK_OPTIONS: ${call}`);
  }
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

// Bug report (2026-07-30, owner-confirmed live): "picked nyaIrisAnima from
// the unet row's own OPTION-LIST menu, the row visibly shows it, but the
// next run's log has no Loader Panel lines at all -- generation used the
// OLD model." The stepper path above was already covered; the LIST-CLICK
// path (`interaction.mjs`'s `openListMenuFor`, a SEPARATE code path from
// `wireComboRow`'s `cycle`) was not -- this closes that gap. Both this test
// and the stepper one above PASS against the current code (the persist
// chain itself -- `afterEdit` -> `persistState` -> `writeStateToWidget` --
// is correct for both paths in this harness), which is exactly why the
// live bug, if it reproduces at all, has to be something this headless
// harness's node/widget stub cannot model (see the build report).
test("Loader Panel row (unet): picking a NEW model from the option-list menu (not the steppers) changes the SERIALIZED panel_state widget, not just the on-screen row", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, {
    getKnownLists: () => ({
      unet: ["waiANIMA_v10Base10.safetensors", "nyaIrisAnima_base1V20.safetensors"],
      vae: ["v.safetensors"],
      clip: ["c.safetensors"],
    }),
  });
  syncRows(node, ctx); // default loader rows: unet/vae/clip
  const unetEntry = node._ctrlRows.find((e) => e.kind === "unet");
  assert.equal(unetEntry.refs.row.value, "waiANIMA_v10Base10.safetensors");
  assert.equal(JSON.parse(getStateWidget(node).value).rows.find((r) => r.kind === "unet").value, "waiANIMA_v10Base10.safetensors");

  fire(unetEntry.refs.combo, "click");
  const menu = doc.body.children[doc.body.children.length - 1];
  assert.ok(menu.className.includes("wtn-ctl-overlay"));
  const opts = menu.children[0].children.filter((c) => c.className.includes("wtn-ctl-opt"));
  const target = opts.find((o) => o.textContent === "nyaIrisAnima_base1V20.safetensors");
  assert.ok(target, "the newly-picked model must actually be an option in the row's own list");
  fire(target, "click");

  // Row display -- the part the owner could SEE was already right.
  assert.equal(unetEntry.refs.row.value, "nyaIrisAnima_base1V20.safetensors");
  // The part the owner could NOT see, and the part the backend actually
  // reads (per `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` --
  // "test the widget, not node.properties"): the SERIALIZED panel_state.
  const persistedUnet = JSON.parse(getStateWidget(node).value).rows.find((r) => r.kind === "unet");
  assert.equal(persistedUnet.value, "nyaIrisAnima_base1V20.safetensors");
  // node.properties too, since that's the OTHER half of the handshake this
  // pack's skill file documents.
  assert.equal(node.properties.loaderPanelState.rows.find((r) => r.kind === "unet").value, "nyaIrisAnima_base1V20.safetensors");
  closeActiveOverlay();
});

// =========================================================================
// Bug 2 -- a fresh/orphaned `unet` row must adopt an Anima-looking file over
// optionList[0], via rows.mjs's `preferredNameDefault`
// (mirrors src/anima/resources.py's `preferred_name_default`). Asserting the
// SERIALIZED panel_state WIDGET, not just the live row object, is the
// habit that would have caught the "adoptedDefault never persists" class of
// bug (see the syncRows/panel_state widget test above, "would have caught
// Bug 3").
// =========================================================================

test("repaintRows (mount path): a brand-new unet row picks an Anima-looking file over optionList[0], and persists it to the panel_state widget", () => {
  const node = makeFakeNode(); // fresh node -- default loader state, unet row's value starts undefined
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, {
    // "sdxl_checkpoint.safetensors" sorts first -- optionList[0] would be
    // WRONG for Anima. The real Anima file sorts last.
    getKnownLists: () => ({ unet: ["sdxl_checkpoint.safetensors", "nyaIrisAnima_base1V20.safetensors"], vae: ["v"], clip: ["c"] }),
  });
  syncRows(node, ctx); // rebuildRowWidgets -> repaintRows, since the unet row's value is unset
  const unetEntry = node._ctrlRows.find((e) => e.kind === "unet");
  assert.equal(unetEntry.refs.row.value, "nyaIrisAnima_base1V20.safetensors");
  assert.notEqual(unetEntry.refs.row.value, "sdxl_checkpoint.safetensors");
  // The dangerous version of this bug is a live row that LOOKS right but
  // never reached the widget the backend actually reads -- assert the
  // SERIALIZED panel_state, not node.properties.
  const persistedUnet = JSON.parse(getStateWidget(node).value).rows.find((r) => r.kind === "unet");
  assert.equal(persistedUnet.value, "nyaIrisAnima_base1V20.safetensors");
});

test("repaintRows (mount path): the Animagine XL false positive is rejected for a fresh unet row -- falls through to optionList[0]", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, {
    getKnownLists: () => ({ unet: ["aaa-unrelated.safetensors", "animagineXL31.safetensors"], vae: ["v"], clip: ["c"] }),
  });
  syncRows(node, ctx);
  const unetEntry = node._ctrlRows.find((e) => e.kind === "unet");
  assert.equal(unetEntry.refs.row.value, "aaa-unrelated.safetensors");
  assert.notEqual(unetEntry.refs.row.value, "animagineXL31.safetensors");
  const persistedUnet = JSON.parse(getStateWidget(node).value).rows.find((r) => r.kind === "unet");
  assert.equal(persistedUnet.value, "aaa-unrelated.safetensors");
});

test("repaintRows (mount path): a non-unet picker row (vae) still adopts plain optionList[0] -- the heuristic is unet-only", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, {
    getKnownLists: () => ({ unet: ["nyaIrisAnima_base1V20.safetensors"], vae: ["vae_a.safetensors", "vae_b.safetensors"], clip: ["c"] }),
  });
  syncRows(node, ctx);
  const vaeEntry = node._ctrlRows.find((e) => e.kind === "vae");
  assert.equal(vaeEntry.refs.row.value, "vae_a.safetensors");
});

test("repaintRows (mount path): an orphaned unet row (saved value no longer installed) re-adopts via the heuristic too, not just a brand-new one", () => {
  const node = makeFakeNode(
    JSON.stringify({
      version: 1,
      rows: [
        { slot: 1, kind: "unet", name: "unet", value: "a-model-that-was-deleted.safetensors", opts: { weight_dtype: "default" } },
        { slot: 2, kind: "vae", name: "vae", value: "v.safetensors", opts: {} },
        { slot: 3, kind: "clip", name: "clip", value: "c.safetensors", opts: { type: "qwen_image", device: "default" } },
      ],
    })
  );
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, {
    getKnownLists: () => ({ unet: ["sdxl_checkpoint.safetensors", "nyaIrisAnima_base1V20.safetensors"], vae: ["v.safetensors"], clip: ["c.safetensors"] }),
  });
  syncRows(node, ctx);
  const unetEntry = node._ctrlRows.find((e) => e.kind === "unet");
  assert.equal(unetEntry.refs.row.value, "nyaIrisAnima_base1V20.safetensors");
});

test("Bug 1 (mount path): a brand-new node's clip row persists opts.type 'qwen_image' to the panel_state WIDGET, not 'stable_diffusion'", () => {
  const node = makeFakeNode(); // Python's literal "{}" default -- a genuinely fresh node
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx);
  const persistedClip = JSON.parse(getStateWidget(node).value).rows.find((r) => r.kind === "clip");
  assert.equal(persistedClip.opts.type, "qwen_image");
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

test("seed row: paintRow shows '-1' while randomize, but the REAL number once lastUsed exists and mode is fixed/increment/decrement", () => {
  const doc = makeDocStub();
  const row = mkRow("seed", { value: "777", opts: { after: "randomize", lastMode: "randomize" } });
  const refs = buildRowElement(doc, row, KIND_META.seed, CONTROL_PANEL_CONFIG);
  paintRow(refs, row, null, null);
  assert.equal(refs.val.textContent, "-1"); // intent, not truth -- see render.mjs's seed branch
  row.opts.after = "fixed";
  paintRow(refs, row, null, null);
  assert.equal(refs.val.textContent, "777"); // fixed always shows the real number
  row.opts.after = "increment";
  paintRow(refs, row, null, null);
  assert.equal(refs.val.textContent, "777");
});

test("seed row: the ↺ reuse button is hidden until there's a lastUsed, and STAYS visible on fixed too (the click-hides-itself bug this replaces)", () => {
  const doc = makeDocStub();
  const row = mkRow("seed", { value: "1", opts: { after: "increment", lastMode: "increment" } });
  const refs = buildRowElement(doc, row, KIND_META.seed, CONTROL_PANEL_CONFIG);
  paintRow(refs, row, null, null);
  assert.ok(refs.reuseBtn.classList.contains("wtn-ctl-hidden"), "no lastUsed yet -- must stay hidden");

  row.opts.lastUsed = "999";
  paintRow(refs, row, null, null);
  assert.ok(!refs.reuseBtn.classList.contains("wtn-ctl-hidden"), "lastUsed exists -- must show");

  // The old rule ALSO hid this on fixed, which made the button vanish out
  // from under the cursor the instant it was clicked (the click itself pins
  // `after = "fixed"`). The new rule is mode-independent: as long as there's
  // a `lastUsed` to go back to, it stays visible, fixed included.
  row.opts.after = "fixed";
  paintRow(refs, row, null, null);
  assert.ok(!refs.reuseBtn.classList.contains("wtn-ctl-hidden"), "fixed with a lastUsed present -- must still show");
});

test("seed row: clicking ↺ adopts lastUsed as the value and pins the mode to fixed (recording lastMode first)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "seed");
  const refs = node._ctrlRows[0].refs;
  const row = refs.row;
  row.value = "55";
  row.opts.after = "increment";
  row.opts.lastMode = "increment";
  row.opts.lastUsed = "999";
  fire(refs.reuseBtn, "click");
  assert.equal(row.value, "999");
  assert.equal(row.opts.after, "fixed");
  assert.equal(row.opts.lastMode, "increment");
  // persisted -- the panel_state widget reflects the reused value + mode.
  const persisted = JSON.parse(getStateWidget(node).value).rows[0];
  assert.equal(persisted.value, "999");
  assert.equal(persisted.opts.after, "fixed");
});

test("seed row: clicking ↺ with no lastUsed at all is a harmless no-op (defensive guard, mirrors paintRow hiding it)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "seed");
  const refs = node._ctrlRows[0].refs;
  const row = refs.row;
  const before = row.value;
  fire(refs.reuseBtn, "click");
  assert.equal(row.value, before);
  assert.equal(row.opts.after, "randomize"); // untouched -- mkRow's default
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

// ---------------------------------------------------------------------------
// BUG 15 (2026-07-29 owner report): "the drag has an issue, it goes over
// multiple rows on a small mouse movement" -- the Control Panel's `wireGrip`
// had the identical defect `lora_interaction.mjs`'s own `wireGrip` was fixed
// for first (`ae7cd38`): the drag math must convert the SCREEN-pixel pointer
// delta into node space via the canvas zoom scale BEFORE dividing by the row
// pitch, or a zoomed canvas overshoots by exactly the zoom factor. Mirrors
// `test_lora_resize.mjs`'s own BUG 15 suite.
// ---------------------------------------------------------------------------

test("BUG 15: a pointer delta of exactly one row pitch moves exactly ONE position at scale 1", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getCanvasScale: () => 1 });
  addRowAndSync(node, ctx, "int");
  addRowAndSync(node, ctx, "float");
  addRowAndSync(node, ctx, "seed");
  fakeArrange(node);
  const draggedRefs = node._ctrlRows[0].refs;

  fire(draggedRefs.grip, "pointerdown", { clientY: 0 });
  fireWin(win, "pointermove", { clientY: ROW_H + ROW_GAP }); // one row pitch of REAL screen movement
  fireWin(win, "pointerup");

  assert.deepEqual(
    node._ctrlRows.map((e) => e.refs.row.kind),
    ["float", "int", "seed"],
    "must move exactly ONE position, not two or three",
  );
});

test("BUG 15 (the actual regression guard): the SAME one-row-pitch SCREEN movement moves exactly ONE position at scale 2 too -- not two", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getCanvasScale: () => 2 });
  addRowAndSync(node, ctx, "int");
  addRowAndSync(node, ctx, "float");
  addRowAndSync(node, ctx, "seed");
  fakeArrange(node);
  const draggedRefs = node._ctrlRows[0].refs;

  fire(draggedRefs.grip, "pointerdown", { clientY: 0 });
  // At 2x zoom, ONE row of on-screen movement is `step * 2` screen pixels --
  // the pre-fix math (`delta = round(screenDelta / step)`, no scale
  // division) would read this as delta=2 and jump TWO rows instead of one.
  fireWin(win, "pointermove", { clientY: 2 * (ROW_H + ROW_GAP) });
  fireWin(win, "pointerup");

  assert.deepEqual(
    node._ctrlRows.map((e) => e.refs.row.kind),
    ["float", "int", "seed"],
    "must STILL move exactly one position -- the screen delta must be divided by scale before the row-pitch division",
  );
});

test("BUG 15: a sub-pitch movement (at any scale) moves nothing", () => {
  for (const scale of [1, 2, 3]) {
    const node = makeFakeNode();
    const doc = makeDocStub();
    const win = makeWindowStub(doc);
    const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { getCanvasScale: () => scale });
    addRowAndSync(node, ctx, "int");
    addRowAndSync(node, ctx, "float");
    addRowAndSync(node, ctx, "seed");
    fakeArrange(node);
    const draggedRefs = node._ctrlRows[0].refs;
    const step = ROW_H + ROW_GAP;

    fire(draggedRefs.grip, "pointerdown", { clientY: 0 });
    // A THIRD of a row pitch's worth of on-screen movement, scaled --
    // unambiguously rounds to zero rows at every scale (avoids the exact
    // half-pitch boundary, where `Math.round` itself rounds up).
    fireWin(win, "pointermove", { clientY: Math.floor((step * scale) / 3) });
    assert.deepEqual(
      node._ctrlRows.map((e) => e.refs.row.kind),
      ["int", "float", "seed"],
      `must not move at all (scale ${scale})`,
    );
    fireWin(win, "pointerup");
  }
});

test("BUG 15: falls back to scale 1 when ctx.getCanvasScale is absent (older/partial ctx) -- never divides by zero/NaN", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  // No getCanvasScale at all on this ctx -- default `makeCtx` behaviour.
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  addRowAndSync(node, ctx, "int");
  addRowAndSync(node, ctx, "float");
  fakeArrange(node);
  const draggedRefs = node._ctrlRows[0].refs;

  fire(draggedRefs.grip, "pointerdown", { clientY: 0 });
  fireWin(win, "pointermove", { clientY: ROW_H + ROW_GAP });
  fireWin(win, "pointerup");

  assert.deepEqual(
    node._ctrlRows.map((e) => e.refs.row.kind),
    ["float", "int"],
    "must behave as scale 1 when the accessor is missing",
  );
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

// ---------------------------------------------------------------------------
// F1. `node.computeSize()` is the ONE authority for height (ported from
// ComfyUI-Pixaroma's `js/lora_loader/index.js` `fitNodeH` -- see
// interaction.mjs's own "Resize" section doc comment for the full bug this
// fixes: `bodyHeight` used to be a second, independent formula racing
// LiteGraph's own widget-summing total). This file's own `makeFakeNode` stub
// never installs `computeSize` (that only happens in `index.js`'s
// `setupNode`, which this headless suite never runs -- its own top doc
// comment: "never imports index.js directly, it needs a real app/
// window.LiteGraph") -- so EVERY OTHER test in this file exercises the
// FALLBACK arithmetic path only. These tests attach a `computeSize` by hand
// to exercise the PRIMARY path explicitly, and confirm the fallback engages
// only when computeSize is genuinely unusable.
// ---------------------------------------------------------------------------

test("fitNode: node.computeSize() is used verbatim when it reports a usable height, NOT recomputed from bodyHeight", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows -- bodyHeight(3) would give a smaller number than this
  const distinctHeight = bodyHeight(3) + 123; // deliberately NOT what bodyHeight(3) would return
  node.computeSize = () => [MIN_W, distinctHeight];
  fitNode(node, ctx);
  assert.equal(node.size[1], distinctHeight, "fitNode must take its height from computeSize(), not bodyHeight(rows.length)");
});

test("fitNode: falls back to bodyHeight(rows.length) when node.computeSize is not a function at all (this file's own stub shape -- every other test in this suite exercises exactly this path)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  assert.equal(typeof node.computeSize, "undefined", "sanity check: this stub really has no computeSize");
  fitNode(node, ctx);
  assert.equal(node.size[1], bodyHeight(3));
});

test("fitNode: falls back to bodyHeight(rows.length) when computeSize() throws", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  node.computeSize = () => {
    throw new Error("boom");
  };
  fitNode(node, ctx);
  assert.equal(node.size[1], bodyHeight(3), "a throwing computeSize must demote to the fallback, not blow up the fit");
});

test("fitNode: falls back to bodyHeight(rows.length) when computeSize() reports a non-finite/zero/negative height", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  for (const bogus of [0, -5, NaN, undefined, null]) {
    node.computeSize = () => [MIN_W, bogus];
    node.size = [MIN_W, 10];
    fitNode(node, ctx);
    assert.equal(node.size[1], bodyHeight(3), `computeSize()[1] = ${bogus} must fall back to bodyHeight`);
  }
});

// ---------------------------------------------------------------------------
// F2. Grow AND shrink to content -- ComfyUI-Pixaroma's `js/lora_loader/
// index.js` decision 1: height is never user-owned, so "remove a row =>
// smaller node" is not a special case, it's the only behaviour. Direct
// `fitNode` calls (not `scheduleFit`, which only fires through a real/
// stubbed `requestAnimationFrame`) so this is unconditional regardless of
// whether an earlier test in this file leaked a stale rAF stub onto
// `globalThis` (see this file's own "requestAnimationFrame" tests above).
// ---------------------------------------------------------------------------

test("fitNode: adding rows grows the node, removing rows shrinks it back down to content -- never stuck at the taller size", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  syncRows(node, ctx); // 0 rows to start (Control Panel has no default rows)
  fitNode(node, ctx);
  const height0 = node.size[1];
  assert.equal(height0, bodyHeight(0));

  const a = addRowAndSync(node, ctx, "int");
  const b = addRowAndSync(node, ctx, "float");
  const c = addRowAndSync(node, ctx, "seed");
  fitNode(node, ctx);
  const height3 = node.size[1];
  assert.equal(height3, bodyHeight(3));
  assert.ok(height3 > height0, "adding rows must grow the node");

  removeRowAndSync(node, ctx, b.id);
  fitNode(node, ctx);
  const height2 = node.size[1];
  assert.equal(height2, bodyHeight(2));
  assert.ok(height2 < height3, "removing a row must shrink the node back down, not leave it at the taller size");

  removeRowAndSync(node, ctx, a.id);
  removeRowAndSync(node, ctx, c.id);
  fitNode(node, ctx);
  assert.equal(node.size[1], bodyHeight(0), "removing every row returns the node to the empty-panel height, not the tallest size it ever reached");
});

// ---------------------------------------------------------------------------
// F3. `fitNode` itself is a no-op on the load path -- the guard now lives
// INSIDE `fitNode` (moved off `scheduleFit`'s rAF callback, this section's
// own doc comment) precisely so a DIRECT call, bypassing `scheduleFit`
// entirely, is covered too. These two tests call `fitNode` directly, never
// `scheduleFit` -- the pre-existing "scheduleFit's rAF early-returns..."
// tests below already cover the scheduleFit-mediated path.
// ---------------------------------------------------------------------------

test("fitNode is a no-op while node._ctrlConfiguring is true, called DIRECTLY (not through scheduleFit)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  node.size = [900, 900]; // deliberately far from bodyHeight(3)/MIN_W
  const before = node.size.slice();
  node._ctrlConfiguring = true;
  fitNode(node, ctx);
  assert.deepEqual(node.size, before, "fitNode must not touch node.size while node._ctrlConfiguring is true");
});

test("fitNode is a no-op while ctx.isGraphLoading() is true, called DIRECTLY (not through scheduleFit)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, { isGraphLoading: () => true });
  syncRows(node, ctx); // 3 rows
  node.size = [900, 900]; // deliberately far from bodyHeight(3)/MIN_W
  const before = node.size.slice();
  fitNode(node, ctx);
  assert.deepEqual(node.size, before, "fitNode must not touch node.size while ctx.isGraphLoading() reports true");
});

// ---------------------------------------------------------------------------
// F4. Row socket Y geometry must not shift because of THIS fix -- fitNode
// only ever writes `node.size`, never a row widget's own `.y` (which
// `alignOutputsLegacy` derives from, independent of node.size entirely) --
// see the task's own "hole compaction ... Row Y geometry must not shift"
// warning. Exercises BOTH the computeSize-primary path and the
// bodyHeight-fallback path to prove neither one disturbs socket geometry.
// ---------------------------------------------------------------------------

test("fitNode never moves a row's output dot position, regardless of which height source (computeSize vs. bodyHeight fallback) it used", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  fakeArrange(node);
  alignOutputsLegacy(node);
  const before = node.outputs.map((o) => (o.pos ? o.pos.slice() : null));

  // Fallback path (no computeSize).
  fitNode(node, ctx);
  alignOutputsLegacy(node);
  assert.deepEqual(
    node.outputs.map((o) => (o.pos ? o.pos.slice() : null)),
    before,
    "the bodyHeight-fallback fit must not move any row's socket Y",
  );

  // Primary path (computeSize reports something else entirely).
  node.computeSize = () => [MIN_W, bodyHeight(3) + 500];
  fitNode(node, ctx);
  alignOutputsLegacy(node);
  assert.deepEqual(
    node.outputs.map((o) => (o.pos ? o.pos.slice() : null)),
    before,
    "the computeSize-primary fit must not move any row's socket Y either -- only node.size[1] changes, never widget.y",
  );
});

// ---------------------------------------------------------------------------
// F5. Class A sizing lock -- `onResizeControls` (the live resize-drag hook,
// wired as `nodeType.prototype.onResize` in `index.js`) and
// `applyContentHeight` (the load-path counterpart). `makeFakeNode` never
// installs `computeSize` (this file's own F1 doc comment), so every test
// below that does NOT attach one by hand exercises the `bodyHeight`
// FALLBACK path through `fitNodeH`; the two that attach `node.computeSize`
// by hand exercise the PRIMARY path explicitly, same split as F1.
// ---------------------------------------------------------------------------

// Every test below runs against BOTH a plain-Array `node.size` AND a
// Float64Array one -- the 2026-07-29 fix's own regression coverage.
// `node.size` on a real litegraph node is a Float64Array VIEW over a
// Rectangle, NOT a plain Array (measured live -- `../shared/size.mjs`'s own
// top doc comment), so every `Array.isArray(node.size)` guard silently did
// nothing on the actual object even while every one of these tests passed
// against a plain-array stub. Looping both shapes here is what makes a
// future regression (someone reintroducing `Array.isArray`) fail immediately
// instead of passing quietly again.
for (const SizeCtor of [Array, Float64Array]) {
  test(`onResizeControls: a height drag is a no-op -- node.size[1] snaps back to content height regardless of what the drag set it to (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    const dragged = mkSize(SizeCtor, MIN_W, 900); // simulates litegraph writing the drag's own size before calling onResize
    node.size = dragged;
    onResizeControls(node, ctx, dragged);
    assert.equal(dragged[1], bodyHeight(3), "the dragged array itself must be corrected back to content height");
    assert.equal(node.size[1], bodyHeight(3), "node.size must agree (same array in this call)");
  });

  test(`onResizeControls: a width drag works normally, and is floored at MIN_W (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows

    // A width drag well above MIN_W must be left exactly as dragged.
    const widened = mkSize(SizeCtor, 500, 900);
    node.size = widened;
    onResizeControls(node, ctx, widened);
    assert.equal(widened[0], 500, "a width above MIN_W must pass through untouched");
    assert.equal(widened[1], bodyHeight(3));

    // A width drag below MIN_W must be floored, not left narrower.
    const narrowed = mkSize(SizeCtor, 10, 900);
    node.size = narrowed;
    onResizeControls(node, ctx, narrowed);
    assert.equal(narrowed[0], MIN_W, "a width below MIN_W must be floored");
    assert.equal(narrowed[1], bodyHeight(3));
  });

  test(`onResizeControls: node.computeSize() is the authority for the locked height, same as fitNode -- never a second bodyHeight formula (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    const distinctHeight = bodyHeight(3) + 77; // deliberately NOT what bodyHeight(3) alone would give
    node.computeSize = () => [MIN_W, distinctHeight];
    const dragged = mkSize(SizeCtor, MIN_W, 5);
    node.size = dragged;
    onResizeControls(node, ctx, dragged);
    assert.equal(dragged[1], distinctHeight, "onResizeControls must take its height from computeSize(), not bodyHeight(rows.length)");
  });

  test(`onResizeControls: falls back to bodyHeight(rows.length) when node.computeSize is not a function (this file's own stub shape) (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    assert.equal(typeof node.computeSize, "undefined", "sanity check: this stub really has no computeSize");
    const dragged = mkSize(SizeCtor, MIN_W, 5);
    node.size = dragged;
    onResizeControls(node, ctx, dragged);
    assert.equal(dragged[1], bodyHeight(3));
  });

  test(`onResizeControls: no-ops entirely under Nodes 2.0 (isVueNodes() true) -- neither axis is touched, so it can never fight computeLayoutSize's own layout store (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    const dragged = mkSize(SizeCtor, 10, 900); // both axes deliberately "wrong" by legacy's own rules
    node.size = dragged;
    globalThis.window = { LiteGraph: { vueNodesMode: true } };
    try {
      onResizeControls(node, ctx, dragged);
    } finally {
      delete globalThis.window;
    }
    assert.deepEqual(dragged, mkSize(SizeCtor, 10, 900), "under Nodes 2.0, onResizeControls must leave size completely untouched -- v2 owns sizing via computeLayoutSize");
  });

  test(`onResizeControls never moves a row's output dot position -- it only ever writes node.size, never a row widget's own .y (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    fakeArrange(node);
    alignOutputsLegacy(node);
    const before = node.outputs.map((o) => (o.pos ? o.pos.slice() : null));

    // Keep width exactly as it already was (`node.size[0]`) so this isolates
    // the HEIGHT-only rewrite -- a width change legitimately moves a dot's X
    // (the socket gutter sits relative to the right edge), which is not what
    // this test is checking; F4's "fitNode never moves a row's output dot"
    // test above isolates the same way, for the same reason.
    const dragged = mkSize(SizeCtor, node.size[0], 900);
    node.size = dragged;
    onResizeControls(node, ctx, dragged);
    alignOutputsLegacy(node);
    assert.deepEqual(
      node.outputs.map((o) => (o.pos ? o.pos.slice() : null)),
      before,
      "onResizeControls must not move any row's socket Y",
    );
  });
}

// ---------------------------------------------------------------------------
// F5a. Draw-time correction -- `onDrawForegroundControls`, wired as
// `nodeType.prototype.onDrawForeground` in `index.js`. Ported alongside
// `onResizeControls` for the reason a LIVE ComfyUI measurement forced: a
// height-resize-drag on a real `AnimaControlPanel` (3 rows) never called
// `onResize` at all (`onResizeCalls: 0`), so `onDrawForeground` -- which
// fires on every paint regardless of which resize mechanism did or didn't
// run -- is the hook that actually enforces Class A in practice.
// ---------------------------------------------------------------------------

// Same Float64Array-vs-plain-Array parametrization as F5's own loop above --
// see that loop's own comment for why.
for (const SizeCtor of [Array, Float64Array]) {
  test(`onDrawForegroundControls: forces node.size[1] to content height and floors node.size[0] at MIN_W, exactly like a drag-corrected size would be (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    // Simulate a drag that stuck (onResize never fired to correct it -- the
    // exact live symptom this hook exists to catch every frame regardless).
    node.size = mkSize(SizeCtor, 10, 198);
    onDrawForegroundControls(node, ctx);
    assert.equal(node.size[0], MIN_W, "width below MIN_W must be floored");
    assert.equal(node.size[1], bodyHeight(3), "height must be forced back to content height");
  });

  test(`onDrawForegroundControls: node.computeSize() is the authority for the locked height, same as fitNode/onResizeControls -- never a second bodyHeight formula (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    const distinctHeight = bodyHeight(3) + 41; // deliberately NOT what bodyHeight(3) alone would give
    node.computeSize = () => [MIN_W, distinctHeight];
    node.size = mkSize(SizeCtor, MIN_W, 5);
    onDrawForegroundControls(node, ctx);
    assert.equal(node.size[1], distinctHeight, "onDrawForegroundControls must take its height from computeSize(), not bodyHeight(rows.length)");
  });

  test(`onDrawForegroundControls no-ops while node._ctrlConfiguring is true (a load may still be settling) (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    node.size = mkSize(SizeCtor, 900, 900); // deliberately far from bodyHeight(3)/MIN_W
    const before = node.size.slice();
    const dirtyBefore = node._dirty;
    node._ctrlConfiguring = true;
    onDrawForegroundControls(node, ctx);
    assert.deepEqual(node.size, before, "must not touch node.size while node._ctrlConfiguring is true");
    assert.equal(node._dirty, dirtyBefore);
  });

  test(`onDrawForegroundControls no-ops while ctx.isGraphLoading() reports true (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, { isGraphLoading: () => true });
    syncRows(node, ctx); // 3 rows
    node.size = mkSize(SizeCtor, 900, 900);
    const before = node.size.slice();
    const dirtyBefore = node._dirty;
    onDrawForegroundControls(node, ctx);
    assert.deepEqual(node.size, before, "must not touch node.size while ctx.isGraphLoading() is true");
    assert.equal(node._dirty, dirtyBefore);
  });

  test(`onDrawForegroundControls no-ops entirely under Nodes 2.0 (isVueNodes() true) -- neither axis is touched (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    node.size = mkSize(SizeCtor, 10, 900); // both axes deliberately "wrong" by legacy's own rules
    const before = node.size.slice();
    globalThis.window = { LiteGraph: { vueNodesMode: true } };
    try {
      onDrawForegroundControls(node, ctx);
    } finally {
      delete globalThis.window;
    }
    assert.deepEqual(node.size, before, "under Nodes 2.0, onDrawForegroundControls must leave size completely untouched");
  });

  test(`onDrawForegroundControls never moves a row's output dot position -- it only ever writes node.size, never a row widget's own .y (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    fakeArrange(node);
    alignOutputsLegacy(node);
    const before = node.outputs.map((o) => (o.pos ? o.pos.slice() : null));

    node.size = mkSize(SizeCtor, node.size[0], 900); // height-only drift, width untouched (same isolation F5's dot test uses)
    onDrawForegroundControls(node, ctx);
    alignOutputsLegacy(node);
    assert.deepEqual(
      node.outputs.map((o) => (o.pos ? o.pos.slice() : null)),
      before,
      "onDrawForegroundControls must not move any row's socket Y",
    );
  });
}

// These two are deliberately OUTSIDE the loop above: detecting "was node.size
// actually WRITTEN to" (as opposed to merely "does it end up holding the same
// values") needs a `Proxy`, and wrapping a real `Float64Array` in a `Proxy`
// hits an unrelated JS-engine brand check --
// `TypedArray.prototype.length`'s getter throws `TypeError: incompatible
// receiver` when `this` is a `Proxy` around a typed array rather than the
// typed array itself, because a `Proxy`'s default `get` trap forwards with
// the PROXY as the receiver, and that getter's internal slot check rejects
// anything that isn't a genuine `Float64Array` instance. This is a real
// litegraph node's `node.size` is NEVER further wrapped in a `Proxy` (it's a
// raw `Float64Array` view straight onto its `Rectangle`, per this file's own
// `../shared/size.mjs` top doc comment) -- so this is purely a test-harness
// limitation of the write-COUNTING mechanism, not a live shape. The
// Float64Array variant below proves the same "genuine no-op" property a
// different way: capture the exact reference identity and a value snapshot,
// call the hook, and assert BOTH the reference and the values are
// unchanged -- which is everything "no write happened" can mean for a
// Float64Array without hitting that brand check.
test("onDrawForegroundControls is a genuine no-op when the node is already the right size -- no write to node.size at all, and setDirtyCanvas is never called", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  const target = [DEFAULT_W, bodyHeight(3)];
  let writes = 0;
  node.size = new Proxy(target, {
    set(t, prop, value) {
      writes += 1;
      t[prop] = value;
      return true;
    },
  });
  const dirtyBefore = node._dirty;
  onDrawForegroundControls(node, ctx);
  assert.equal(writes, 0, "an already-correct node.size must not be written to at all");
  assert.equal(
    node._dirty,
    dirtyBefore,
    "must never call setDirtyCanvas -- doing so from a draw hook is an infinite repaint loop",
  );
});

test("onDrawForegroundControls is a genuine no-op when the node is already the right size, with node.size a Float64Array (the live shape) -- the SAME reference survives untouched, not merely equal values", () => {
  const node = makeFakeNode(undefined, { sizeCtor: Float64Array });
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  node.size = Float64Array.from([DEFAULT_W, bodyHeight(3)]);
  const sameReference = node.size;
  const before = node.size.slice();
  const dirtyBefore = node._dirty;
  onDrawForegroundControls(node, ctx);
  assert.equal(node.size, sameReference, "must be the SAME Float64Array reference -- never replaced with a new array/view");
  assert.deepEqual(node.size, before, "an already-correct Float64Array node.size must end with the exact same values");
  assert.equal(
    node._dirty,
    dirtyBefore,
    "must never call setDirtyCanvas -- doing so from a draw hook is an infinite repaint loop",
  );
});

// ---------------------------------------------------------------------------
// F5b. DOM widget height cap -- `getMaxHeight === getMinHeight` pins every
// row/add-strip widget's own height so litegraph's DOM-widget
// `computeLayoutSize` can never grow it past ROW_H/28 in the first place.
// Ported from ComfyUI-Pixaroma's `js/lora_loader/index.js:93-101` (MIT, see
// THIRD_PARTY_NOTICES.md) -- the min==max pin the reference node actually
// uses, confirmed live (the owner reports that node genuinely cannot be
// stretched taller). This is the NATIVE mechanism, ahead of (not instead of)
// the `setSize` wrap (F5c, below) and the per-frame draw hook (F5a, above).
//
// Driven off `node.widgets` itself, not a single named widget -- so a
// FUTURE DOM widget this track mounts without the cap fails this test too.
// ---------------------------------------------------------------------------

test("every DOM widget this track mounts (row widgets + the add-strip) declares getMaxHeight === getMinHeight -- driven off the widget list, not a named widget", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  // LOADER_PANEL_CONFIG (not CONTROL_PANEL_CONFIG) -- same choice every other
  // F5 test in this file makes: the Loader Panel's default 3 rows (unet/vae/
  // clip) build without needing a `getKnownLists` override, unlike the
  // Control Panel's default sampler/scheduler rows (see line ~997's own
  // override for that case).
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows + the add-strip

  const domWidgets = node.widgets.filter((w) => w.options && typeof w.options.getMinHeight === "function");
  assert.ok(domWidgets.length >= 4, "sanity check: at least the 3 row widgets + the add-strip must be in this list");
  for (const w of domWidgets) {
    assert.equal(typeof w.options.getMaxHeight, "function", `${w.name} must declare getMaxHeight alongside getMinHeight`);
    assert.equal(
      w.options.getMaxHeight(),
      w.options.getMinHeight(),
      `${w.name}'s getMaxHeight() must equal its getMinHeight() -- that's the pin`,
    );
  }
});

test("every DOM widget's computeLayoutSize also carries a matching maxHeight -- an explicit computeLayoutSize override never bypasses the option", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx);

  const domWidgets = node.widgets.filter((w) => typeof w.computeLayoutSize === "function");
  assert.ok(domWidgets.length >= 4);
  for (const w of domWidgets) {
    const layout = w.computeLayoutSize();
    assert.equal(layout.maxHeight, layout.minHeight, `${w.name}'s computeLayoutSize must carry maxHeight === minHeight`);
  }
});

test("the per-widget height cap does not fight SHRINKING -- removing rows still shrinks the node via fitNode/fitNodeH, and surviving rows' own cap stays exactly ROW_H (unaffected by row count)", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  node.size = [DEFAULT_W, bodyHeight(3)];
  const [a, b] = node._ctrlRows.map((e) => e.refs.row);

  removeRowAndSync(node, ctx, a.id);
  fitNode(node, ctx);
  assert.equal(node.size[1], bodyHeight(2), "the node must still shrink to content height after a row is removed");

  const surviving = node._ctrlRows.find((e) => e.refs.row.id === b.id);
  assert.equal(surviving.widget.options.getMinHeight(), ROW_H, "a surviving row's own min height is unaffected by total row count");
  assert.equal(surviving.widget.options.getMaxHeight(), ROW_H, "...and neither is its max -- the cap is per-widget, the shrink is per-COUNT (fewer widgets), not a per-widget height change");
});

// ---------------------------------------------------------------------------
// F5c. setSize wrap -- the THIRD Class A hook, closing the pre-paint gap
// `onResizeControls`/`onDrawForegroundControls` cannot: litegraph calls
// `node.setSize(c.size)` on every drag frame BEFORE `this._dirty()`, so
// correcting height right there stops the visible mid-drag stretch instead
// of merely snapping it back a frame late. See `wrapSetSizeControls`'s own
// doc comment in interaction.mjs for the full derivation (decompiled
// `comfyui_frontend_package` 1.47.10 drag handler).
// ---------------------------------------------------------------------------

// Same Float64Array-vs-plain-Array parametrization as F5/F5a's own loops
// above -- see F5's own comment for why. `spiedArg`/comparisons use `mkSize`
// throughout so a Float64Array-shaped drag argument compares against a
// Float64Array-shaped expectation (a plain-array literal never deep-equals a
// Float64Array of the same values -- Node's `assert.deepEqual` treats the
// two constructors as distinct).
for (const SizeCtor of [Array, Float64Array]) {
  test(`wrapSetSizeControls: a too-tall height is clamped to content height, and the ORIGINAL (spied) setSize is still invoked with the corrected size (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows

    let spyCalls = 0;
    let spiedArg = null;
    const realSetSize = node.setSize.bind(node);
    node.setSize = function (size) {
      spyCalls += 1;
      spiedArg = size.slice();
      return realSetSize(size);
    };
    wrapSetSizeControls(node, ctx);

    node.setSize(mkSize(SizeCtor, MIN_W, 900)); // a drag that stretched the node way past content
    assert.equal(spyCalls, 1, "the original (spied) setSize must still run exactly once");
    assert.deepEqual(spiedArg, mkSize(SizeCtor, MIN_W, bodyHeight(3)), "the original must receive the CORRECTED size, not the raw dragged one");
    assert.equal(node.size[1], bodyHeight(3), "node.size must end at content height, never the dragged height");
  });

  test(`wrapSetSizeControls: a too-narrow width is floored at MIN_W (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    wrapSetSizeControls(node, ctx);

    node.setSize(mkSize(SizeCtor, 10, 900));
    assert.equal(node.size[0], MIN_W, "width below MIN_W must be floored");
    assert.equal(node.size[1], bodyHeight(3));
  });

  test(`wrapSetSizeControls: a legitimate width ABOVE MIN_W is preserved exactly (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    wrapSetSizeControls(node, ctx);

    node.setSize(mkSize(SizeCtor, 500, 900));
    assert.equal(node.size[0], 500, "a width above MIN_W must pass through untouched");
    assert.equal(node.size[1], bodyHeight(3));
  });

  test(`wrapSetSizeControls: passes straight through, UNCLAMPED, under isVueNodes() (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    wrapSetSizeControls(node, ctx);

    globalThis.window = { LiteGraph: { vueNodesMode: true } };
    try {
      node.setSize(mkSize(SizeCtor, 10, 900));
    } finally {
      delete globalThis.window;
    }
    assert.deepEqual(node.size, mkSize(SizeCtor, 10, 900), "under Nodes 2.0, setSize must be left completely unclamped -- v2 owns sizing via computeLayoutSize");
  });

  test(`wrapSetSizeControls: passes straight through, UNCLAMPED, while node._ctrlConfiguring is true (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    wrapSetSizeControls(node, ctx);

    node._ctrlConfiguring = true;
    node.setSize(mkSize(SizeCtor, 10, 900));
    assert.deepEqual(node.size, mkSize(SizeCtor, 10, 900), "a workflow load in flight must never be fought");
  });

  test(`wrapSetSizeControls: passes straight through, UNCLAMPED, while ctx.isGraphLoading() reports true (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, { isGraphLoading: () => true });
    syncRows(node, ctx); // 3 rows
    wrapSetSizeControls(node, ctx);

    node.setSize(mkSize(SizeCtor, 10, 900));
    assert.deepEqual(node.size, mkSize(SizeCtor, 10, 900), "a workflow load in flight (via ctx.isGraphLoading()) must never be fought");
  });

  test(`wrapSetSizeControls: fitNode's own node.setSize([w, h]) call is a genuine no-op through the wrapped path -- no double correction, no recursion (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    let spyCalls = 0;
    const realSetSize = node.setSize.bind(node);
    node.setSize = function (size) {
      spyCalls += 1;
      return realSetSize(size);
    };
    wrapSetSizeControls(node, ctx);

    node.size = mkSize(SizeCtor, 10, 5); // deliberately wrong on both axes
    fitNode(node, ctx);
    assert.equal(spyCalls, 1, "fitNode must still call setSize exactly once through the wrap -- no recursive re-entry");
    assert.equal(node.size[0], MIN_W, "fitNode's own width floor and the wrap's clamp must agree exactly (10 -> MIN_W either way)");
    assert.equal(node.size[1], bodyHeight(3), "fitNode's own answer and the wrap's clamp must agree exactly -- no double correction");
  });

  test(`wrapSetSizeControls never moves a row's output dot position -- it only ever writes node.size, never a row widget's own .y (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(undefined, { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
    syncRows(node, ctx); // 3 rows
    fakeArrange(node);
    alignOutputsLegacy(node);
    const before = node.outputs.map((o) => (o.pos ? o.pos.slice() : null));

    wrapSetSizeControls(node, ctx);
    node.setSize(mkSize(SizeCtor, node.size[0], 900)); // height-only drift, width untouched (F5's own isolation)
    alignOutputsLegacy(node);
    assert.deepEqual(
      node.outputs.map((o) => (o.pos ? o.pos.slice() : null)),
      before,
      "wrapSetSizeControls must not move any row's socket Y",
    );
  });
}

test("wrapSetSizeControls is a no-op install when node.setSize is not a function at all -- must not fabricate one", () => {
  const node = makeFakeNode();
  delete node.setSize;
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx);
  wrapSetSizeControls(node, ctx); // must not throw
  assert.equal(typeof node.setSize, "undefined", "must not fabricate a setSize where none existed");
});

test("index.js: setupNode wraps setSize via mods.interaction.wrapSetSizeControls, installed once per node alongside computeSize", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const setupIdx = indexSource.indexOf("function setupNode(node, panelConfig, mods)");
  const restoreIdx = indexSource.indexOf("function restoreNode(");
  assert.ok(setupIdx >= 0 && restoreIdx > setupIdx);
  const setupBody = indexSource.slice(setupIdx, restoreIdx);
  assert.match(
    setupBody,
    /mods\.interaction\.wrapSetSizeControls\(node, ctx\);/,
    "setupNode must call mods.interaction.wrapSetSizeControls(node, ctx)",
  );
});

test("applyContentHeight: after a simulated load, node.size[1] is content height regardless of the saved value, and node.size[0] (width) is left completely untouched", () => {
  const savedStateJSON = JSON.stringify({
    version: 1,
    rows: [
      { slot: 1, kind: "int", name: "a", value: 1, opts: { min: 0, max: 10, step: 1 } },
      { slot: 2, kind: "int", name: "b", value: 2, opts: { min: 0, max: 10, step: 1 } },
      { slot: 3, kind: "int", name: "c", value: 3, opts: { min: 0, max: 10, step: 1 } },
    ],
  });
  const node = makeFakeNode(savedStateJSON);
  // A bogus/stale saved height (e.g. from a workflow saved before this fix,
  // or hand-edited) alongside a genuinely user-chosen saved width.
  node.size = [555, 999];
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG);
  restoreStateFromWidget(node, ctx); // mirrors restoreNode's own force-reparse
  syncRows(node, ctx); // 3 rows
  applyContentHeight(node, ctx);
  assert.equal(node.size[1], bodyHeight(3), "height must be content height regardless of what was saved");
  assert.equal(node.size[0], 555, "width must be left exactly as the workflow saved it");
});

test("applyContentHeight is a genuine no-op on an already-consistent node -- assigns node.size[1] its own current value, same as fitNodeH would report live", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG);
  syncRows(node, ctx); // 3 rows
  node.size = [DEFAULT_W, bodyHeight(3)];
  const before = node.size.slice();
  applyContentHeight(node, ctx);
  assert.deepEqual(node.size, before);
});

test("index.js: nodeType.prototype.onResize is wired to call mods.interaction.onResizeControls, chaining any pre-existing handler", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /const _resize = nodeType\.prototype\.onResize;/,
    "must capture any pre-existing onResize before overwriting it",
  );
  const hookIdx = indexSource.indexOf("nodeType.prototype.onResize = function (size) {");
  assert.ok(hookIdx >= 0, "onResize must be installed on the prototype");
  const hookBody = indexSource.slice(hookIdx, indexSource.indexOf("};", hookIdx));
  assert.match(
    hookBody,
    /this\._ctrlMods\.interaction\.onResizeControls\(this, this\._ctrlCtx, size\)/,
    "onResize must delegate to mods.interaction.onResizeControls, gated on this._ctrlMods like every other hook",
  );
  assert.match(hookBody, /return _resize \? _resize\.apply\(this, arguments\) : undefined;/, "must chain the pre-existing handler, never silently replace it");
});

test("index.js: nodeType.prototype.onDrawForeground is wired to call mods.interaction.onDrawForegroundControls, chaining any pre-existing handler", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /const _drawFg = nodeType\.prototype\.onDrawForeground;/,
    "must capture any pre-existing onDrawForeground before overwriting it",
  );
  const hookIdx = indexSource.indexOf("nodeType.prototype.onDrawForeground = function (canvasCtx) {");
  assert.ok(hookIdx >= 0, "onDrawForeground must be installed on the prototype");
  const hookBody = indexSource.slice(hookIdx, indexSource.indexOf("};", hookIdx));
  assert.match(
    hookBody,
    /this\._ctrlMods\.interaction\.onDrawForegroundControls\(this, this\._ctrlCtx\)/,
    "onDrawForeground must delegate to mods.interaction.onDrawForegroundControls, gated on this._ctrlMods like every other hook",
  );
  assert.match(
    hookBody,
    /return _drawFg \? _drawFg\.apply\(this, arguments\) : undefined;/,
    "must chain the pre-existing handler, never silently replace it",
  );
});

test("index.js: restoreNode calls mods.interaction.applyContentHeight AFTER syncRows, so height reflects the just-restored row count", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const restoreIdx = indexSource.indexOf("function restoreNode(");
  const nextFnIdx = indexSource.indexOf("app.registerExtension({");
  assert.ok(restoreIdx >= 0 && nextFnIdx > restoreIdx, "restoreNode must be defined before app.registerExtension");
  const restoreBody = indexSource.slice(restoreIdx, nextFnIdx);
  const syncIdx = restoreBody.indexOf("mods.interaction.syncRows(node, ctx);");
  const heightIdx = restoreBody.indexOf("mods.interaction.applyContentHeight(node, ctx);");
  assert.ok(syncIdx >= 0, "restoreNode must call syncRows");
  assert.ok(heightIdx > syncIdx, "applyContentHeight must run AFTER syncRows, so row count is current when it measures content height");
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
// H. Load-race sizing guard (`isGraphLoading`, `js/shared/graph_loading.mjs`)
// -- ported from the identical fix already landed for `js/anima/index.js`
// (see that file's own top doc comment / its `test_resize.mjs`'s "H2"
// section for the live trace: `[setSize] [360,340] id 747`, a saved
// Generator snapped back to its fresh-node default on refresh). The Controls
// line hits the SAME race, just with a worse symptom -- `rowCountOf` can
// also still read 0 mid-restore, so an unguarded floor collapses the HEIGHT
// too, not just the width (an already-saved 8-row panel can come back both
// narrow AND short).
//
// `index.js` itself carries a top-level absolute `/scripts/app.js` import
// (this file's own top doc comment: "never imports `index.js` directly, it
// needs a real `app`/`window.LiteGraph`") -- so `setupNode`'s own gate is
// covered by a static source scan, the SAME technique `js/anima/
// test_resize.mjs`'s "H2" section uses for its un-instantiable equivalent.
// `scheduleFit`'s OWN gate lives in `interaction.mjs` (directly importable,
// no `/scripts/app.js` anywhere in it), so those two are real behavioural
// tests against the actual exported function instead.
// =========================================================================

test("index.js: setupNode's sizing block is gated on `!isGraphLoading() && !node._ctrlConfiguring` -- while a load is in flight, NEITHER node.size[0] NOR node.size[1] is written", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /import\s*\{\s*isGraphLoading\s*\}\s*from\s*"\.\.\/shared\/graph_loading\.mjs"/,
    "must import isGraphLoading eagerly (not through loadMods())",
  );

  const setupIdx = indexSource.indexOf("function setupNode(node, panelConfig, mods)");
  const restoreIdx = indexSource.indexOf("function restoreNode(");
  assert.ok(setupIdx >= 0 && restoreIdx > setupIdx, "setupNode must be defined, and restoreNode must follow it");
  const setupBody = indexSource.slice(setupIdx, restoreIdx);

  const gateIdx = setupBody.indexOf("if (!isGraphLoading() && !node._ctrlConfiguring) {");
  assert.ok(gateIdx >= 0, "setupNode must gate the sizing block on BOTH isGraphLoading() and node._ctrlConfiguring");

  const widthWriteIdx = setupBody.indexOf("node.size[0] = mods.render.DEFAULT_W;");
  const heightWriteIdx = setupBody.indexOf("node.size[1] = mods.render.bodyHeight(mods.interaction.rowCountOf(node, ctx));");
  assert.ok(widthWriteIdx > gateIdx, "the width write must be INSIDE the gate, not before it");
  assert.ok(heightWriteIdx > gateIdx, "the height write must ALSO be inside the gate -- this is the part that collapses when rowCountOf reads 0 mid-restore");

  // Both writes must close before computeSize/scheduleFit run again --
  // i.e. there is exactly one gated block, not the gate wrapping only the
  // width line while the height line escapes it (or vice versa).
  const closeGateIdx = setupBody.indexOf("\n  }\n\n  mods.interaction.syncRows(node, ctx);");
  assert.ok(closeGateIdx > heightWriteIdx, "both the width and height writes must be inside the SAME gated block, not split across it");
});

test("index.js: setupNode's sizing block still applies the ORIGINAL fresh-node floor once isGraphLoading()/_ctrlConfiguring are both false -- the gate only skips the block during a load, it does not remove the floor logic itself", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const setupIdx = indexSource.indexOf("function setupNode(node, panelConfig, mods)");
  const restoreIdx = indexSource.indexOf("function restoreNode(");
  const setupBody = indexSource.slice(setupIdx, restoreIdx);

  // The pre-existing "is this node already at/above the floor" condition is
  // untouched -- unchanged from before this dispatch, just now living
  // one level deeper inside the isGraphLoading()/_ctrlConfiguring gate.
  assert.match(setupBody, /if \(!node\.size \|\| node\.size\[0\] < mods\.render\.MIN_W\) \{/, "the original floor condition must still be present, unchanged");
  assert.match(setupBody, /node\.size = node\.size \|\| \[0, 0\];/);
  assert.match(setupBody, /node\.size\[0\] = mods\.render\.DEFAULT_W;/);
  assert.match(setupBody, /node\.size\[1\] = mods\.render\.bodyHeight\(mods\.interaction\.rowCountOf\(node, ctx\)\);/);
});

test("scheduleFit's rAF early-returns while ctx.isGraphLoading() is true, even with node._ctrlConfiguring ALREADY cleared -- the leaky-clear-before-rAF race `_ctrlConfiguring` alone cannot cover", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, CONTROL_PANEL_CONFIG, { isGraphLoading: () => true });
  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
  node._ctrlConfiguring = false; // already cleared, as it plausibly is by the time this rAF actually fires
  const before = node.size.slice();
  scheduleFit(node, ctx);
  rafQueue.forEach((cb) => cb());
  assert.deepEqual(node.size, before, "fitNode must NOT have run while ctx.isGraphLoading() reports true");
});

test("scheduleFit: a saved size ABOVE the floor is never touched on load (isGraphLoading() true) -- fitNode would otherwise recompute a SMALLER size from bodyHeight(rows.length) and clobber a user's saved, enlarged panel", () => {
  const node = makeFakeNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, { isGraphLoading: () => true });
  syncRows(node, ctx); // 3 rows -- bodyHeight(3) is well below the size set just below
  const savedSize = [900, 900]; // deliberately far ABOVE both MIN_W and bodyHeight(3)
  node.size = savedSize.slice();
  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
  scheduleFit(node, ctx);
  rafQueue.forEach((cb) => cb());
  assert.deepEqual(node.size, savedSize, "the saved, above-floor size must survive untouched while isGraphLoading() is true");
});

test("scheduleFit still fits exactly as before once isGraphLoading() is false and _ctrlConfiguring is unset -- no behaviour change to the ordinary user-action resize path", () => {
  const node = makeFakeNode();
  node.size = [10, 10]; // narrower than MIN_W
  const doc = makeDocStub();
  const ctx = makeCtx(doc, LOADER_PANEL_CONFIG, { isGraphLoading: () => false });
  syncRows(node, ctx); // 3 rows
  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
  scheduleFit(node, ctx);
  rafQueue.forEach((cb) => cb());
  assert.equal(node.size[0], MIN_W);
  assert.equal(node.size[1], bodyHeight(3));
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
// Stale-state diagnostic wiring ("AnimaLoaderPanel generates with a stale
// model" investigation) -- `index.js` itself can't be imported directly
// here (top-level absolute `/scripts/app.js` import), so this is a static
// source scan, same technique as this file's other `index.js:`-prefixed
// tests above. The pure half (`state_diagnostic.mjs`) has its own dedicated
// suite, `test_state_diagnostic.mjs`.
// =========================================================================

test("index.js: imports onGraphToPromptResult from ../shared/submit_guard.mjs (extending the EXISTING wrap, never a second one) and the pure state_diagnostic.mjs module, both eagerly", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(
    indexSource,
    /import\s*\{\s*onGraphToPromptResult\s*\}\s*from\s*"\.\.\/shared\/submit_guard\.mjs"/,
    "must import onGraphToPromptResult eagerly (not through loadMods())",
  );
  assert.match(
    indexSource,
    /import\s*\*\s*as\s*stateDiagnostic\s*from\s*"\.\/state_diagnostic\.mjs"/,
    "must import the pure diagnostic module eagerly",
  );
});

test("index.js: installStateDiagnosticHook() is called from beforeRegisterNodeDef, alongside installQueuePromptHook()/registerAnimaFlowSettings(app), and is idempotent (module-level guard)", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const beforeIdx = indexSource.indexOf("beforeRegisterNodeDef(nodeType, nodeData) {");
  assert.ok(beforeIdx >= 0, "expected beforeRegisterNodeDef");
  const bodyEnd = indexSource.indexOf("if (nodeData.name === \"AnimaLoraLoader\")", beforeIdx);
  const body = indexSource.slice(beforeIdx, bodyEnd);
  assert.match(body, /installQueuePromptHook\(\);/);
  assert.match(body, /registerAnimaFlowSettings\(app\);/);
  assert.match(body, /installStateDiagnosticHook\(\);/, "must install the diagnostic hook from the same unconditional, every-node-type call site");

  assert.match(indexSource, /let _stateDiagnosticWrapped = false;/, "must guard against double-registration (hot reload)");
  const fnIdx = indexSource.indexOf("function installStateDiagnosticHook()");
  assert.ok(fnIdx >= 0);
  const fnBody = indexSource.slice(fnIdx, indexSource.indexOf("\n}", fnIdx));
  assert.match(fnBody, /if \(_stateDiagnosticWrapped\) \{\s*return;/, "must bail out on a second call");
  assert.match(fnBody, /onGraphToPromptResult\(runStateDiagnostic\);/, "must register runStateDiagnostic on submit_guard's tap");
});

test("index.js: runStateDiagnostic is gated on the LIVE 'Console logging' setting being exactly 'debug' -- 'off'/'summary' must stay silent -- checked BEFORE the graph walk", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const fnIdx = indexSource.indexOf("function runStateDiagnostic(resolved)");
  assert.ok(fnIdx >= 0);
  const nextFnIdx = indexSource.indexOf("let _stateDiagnosticWrapped", fnIdx);
  const fnBody = indexSource.slice(fnIdx, nextFnIdx);
  const levelIdx = fnBody.indexOf("getSetting(SETTING_IDS.CONSOLE_LOGGING");
  const walkIdx = fnBody.indexOf("findDiagnosticNodes()");
  assert.ok(levelIdx >= 0 && walkIdx > levelIdx, "the debug-level check must run BEFORE the graph walk");
  assert.match(fnBody, /if \(level !== "debug"\) \{\s*return;/, "must stay silent for anything other than exactly 'debug'");
});

test("index.js: runStateDiagnostic's entire body is wrapped in a top-level try/catch (belt-and-braces alongside submit_guard.mjs's own per-listener catch) -- a diagnostic bug must never be able to prevent a queue", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const fnIdx = indexSource.indexOf("function runStateDiagnostic(resolved) {");
  assert.ok(fnIdx >= 0);
  const bodyAfterBrace = indexSource.slice(fnIdx + "function runStateDiagnostic(resolved) {".length, fnIdx + 400);
  assert.match(bodyAfterBrace.trimStart(), /^try \{/, "the function body must open with a try immediately");
  const nextFnIdx = indexSource.indexOf("let _stateDiagnosticWrapped", fnIdx);
  const fnBody = indexSource.slice(fnIdx, nextFnIdx);
  assert.match(fnBody, /\} catch \(err\) \{\s*console\.error\("\[AnimaFlow\] state-diagnostic top-level failure \(ignored\):", err\);\s*\}/, "must catch and swallow any top-level error");
  // Per-node work is ALSO individually try/caught, so one bad node can't stop
  // the rest from being reported.
  assert.match(fnBody, /for \(const node of nodes\) \{\s*try \{/, "each node's own comparison must be individually try/caught");
});

test("index.js: findDiagnosticNodes walks app.graph (and subgraphs) filtering on stateDiagnostic.STATE_WIDGET_NAME_BY_CLASS -- the same class set as the pure module, never a second hardcoded list", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const fnIdx = indexSource.indexOf("function findDiagnosticNodes()");
  assert.ok(fnIdx >= 0);
  const fnBody = indexSource.slice(fnIdx, indexSource.indexOf("function runStateDiagnostic", fnIdx));
  assert.match(fnBody, /stateDiagnostic\.STATE_WIDGET_NAME_BY_CLASS\[className\]/, "must key off the pure module's own class->widget map, not a second copy");
  assert.match(fnBody, /walk\(app\.graph\)/);
});

test("index.js: runStateDiagnostic bails out via stateDiagnostic.hasComparablePayload BEFORE the per-node loop -- a rejected/failed graphToPrompt still fires the listener with `undefined`, which must never be reported as every node 'missing' its input", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const fnIdx = indexSource.indexOf("function runStateDiagnostic(resolved) {");
  assert.ok(fnIdx >= 0);
  const nextFnIdx = indexSource.indexOf("let _stateDiagnosticWrapped", fnIdx);
  const fnBody = indexSource.slice(fnIdx, nextFnIdx);
  const guardIdx = fnBody.indexOf("stateDiagnostic.hasComparablePayload(output)");
  const loopIdx = fnBody.indexOf("for (const node of nodes)");
  assert.ok(guardIdx >= 0, "must call stateDiagnostic.hasComparablePayload(output)");
  assert.ok(loopIdx > guardIdx, "the payload-shape guard must run BEFORE the per-node loop");
  assert.match(fnBody, /console\.warn\(stateDiagnostic\.formatNoPayloadLine\(\)\);/, "the no-payload case must print loudly (console.warn), via the pure formatter");
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
