/**
 * test_lora_resize.mjs — regression tests for `lora_render.mjs` (DOM/CSS/
 * arithmetic) and `lora_interaction.mjs` (state handshake, row/header event
 * wiring, drag-reorder, and Class A sizing) for `AnimaLoraLoader`. Runs
 * under plain `node` via a small DOM + fake-litegraph-node stub (mirrors
 * `js/controls/test_resize.mjs`'s own pattern) — never imports `index.js`
 * directly (it needs a real `app`/`window.LiteGraph`, which only exist in
 * an actual ComfyUI page).
 *
 * ## Why `node.size` is exercised as BOTH `Array` and `Float64Array`
 *
 * `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`: a real litegraph
 * node's `.size` is a `Float64Array` VIEW over a `Rectangle`, not a plain
 * `Array` — `Array.isArray(node.size)` is `false` live even though it is
 * `true` for the plain-array stub every test would otherwise use. A sizing
 * test that only ever runs against a plain `Array` proves nothing about the
 * real page, so every sizing test below (section F) runs TWICE, once per
 * `SizeCtor` in `[Array, Float64Array]`, via `mkSize`/`makeFakeNode`'s
 * `sizeCtor` option — mirrors `js/controls/test_resize.mjs:345`'s own
 * `mkSize` helper (kept as an independent copy here, not a cross-file
 * import, matching that file's own "tracks stay independent test modules"
 * note about `js/anima/test_resize.mjs`).
 *
 * Covers:
 *   A. `lora_render.mjs` — CSS injection, `buildRoot`/`buildRowElement`'s
 *      DOM shape, `paintRow`/`paintHeader`, `contentHeight` arithmetic.
 *   B. State handshake — `getStateWidget` finds `lora_state` (NOT
 *      `panel_state`), `ensureState` initializes once and writes the
 *      materialized default back for a brand-new node, `restoreStateFromWidget`
 *      force-reparses, `persistState` mirrors into the widget and dirties
 *      the canvas, `hideStateWidget` hides without `serialize = false`.
 *   C. Header interactions through REAL wired DOM (`＋ Add LoRA`, the master
 *      switch's tri-state click rule).
 *   D. Row interactions — strength ▲▼, the on/off switch, and a full
 *      grip-drag-reorder sequence that never recreates the dragged row's
 *      own DOM element (`reorderRows` reuse, non-destructive `syncRows`).
 *   F. Class A sizing — all five layers: the `addDOMWidget`
 *      `getMinHeight`/`getMaxHeight` pin (read LIVE off current row count),
 *      `onResizeLora`, `onDrawForegroundLora`, `wrapSetSizeLora`,
 *      `applyContentHeightLora`, `fitNode`/`scheduleFit`'s load-path guard.
 *
 * MANUAL-IN-COMFYUI CHECKLIST (this headless harness cannot confirm any of
 * this — see `js/controls/test_resize.mjs`'s own checklist for the sibling
 * list; the same caveats apply to a real `addDOMWidget`/legacy-litegraph
 * runtime contract):
 *   [ ] A fresh `AnimaLoraLoader` renders the house theme, `lora_state` is
 *       invisible on the node face but present in the saved workflow JSON.
 *   [ ] Dragging a row's grip visually lifts it and drops it in the new
 *       position with NO node-height flicker (Class A: the node's height
 *       must not move even transiently during the drag).
 *   [ ] Save + reload: rows, on/off state, strengths and the node's WIDTH
 *       all survive; the node does not open the workflow "modified".
 *   [ ] VERIFY-IN-COMFYUI: `index.js`'s `findLoraNodes`/`wireLoraRefresh`
 *       (subgraph recursion over `app.graph`, wired to `js/shared/
 *       refresh.mjs`'s `R`/WebSocket-reconnect signal) -- untestable under
 *       plain `node` (needs a real `app`/`window.LiteGraph`; `index.js` is
 *       never imported by any test file, per this file's own top doc
 *       comment). One-step live check: place an `AnimaLoraLoader` INSIDE a
 *       subgraph (not top-level), mark one of its rows' files missing, press
 *       `R` (or trigger a WebSocket reconnect), and confirm that row's
 *       missing-file mark actually re-checks -- that confirms `findLoraNodes`'
 *       `walk()` recursion into `n.subgraph`/`n.graph`/`n._graph` finds a
 *       nested instance, not just a top-level one.
 */

import assert from "node:assert/strict";

import { defaultState, addRow as addStateRow, setSepStrengths as setStateSepStrengths } from "./lora_state.mjs";

import {
  contentHeight,
  ROW_H,
  ROW_GAP,
  HEADER_H,
  HEADER_GAP,
  BODY_PAD,
  CARD_PAD,
  CARD_BORDER,
  MIN_W,
  MIN_W_SEP,
  DEFAULT_W,
  WIDGETS_START_Y,
  NODE_SLOT_H,
  INPUT_SLOT_COUNT,
  OUTPUT_SLOT_COUNT,
  SLOT_HEADER_H,
  STEPPER_W,
  CTRL_GAP,
  STR_CELL_GAP,
  ADD_MIN_W,
  SPIN_GAP,
  NAME_MIN_W,
  ROW_PAD_L,
  ROW_PAD_R,
  GRIP_W,
  INFO_W,
  SWITCH_W,
  buildRoot,
  buildRowElement,
  buildSettingsPanel,
  paintRow,
  paintHeader,
  injectStyles,
} from "./lora_render.mjs";

// `paintRow`'s missing-file mark (design doc §1a-iii) reads `hasFile("loras",
// ...)` straight from `civitai_api.mjs`'s real module-singleton cache -- the
// dedicated test below primes it via a stubbed `fetch`, same convention as
// `test_civitai_api.mjs`.
import { listModels, invalidateList } from "./civitai_api.mjs";

// EVERY `mountLoraNode` call in this file triggers a `listModels("loras")`
// warm-up fetch (Slice 3's missing-file-mark warm-up) -- the file's many
// pre-existing, fetch-oblivious tests call `mountLoraNode` synchronously,
// back-to-back, with no `await` between most of them, so a REAL native
// `fetch("/wtn/model_browser/list?...")` (which rejects asynchronously --
// there is no live server under `node`, and the URL isn't even absolute) can
// leave a genuinely pending promise dangling across several tests, only
// settling once this file finally hits an `await` point. Stubbing a fast,
// harmless default HERE, once, for the whole file removes that timing
// hazard entirely; the handful of tests below that care about
// `civitai_api.mjs`'s actual cache contents install their OWN override in a
// try/finally and restore this default afterward (never the real fetch).
globalThis.fetch = async () => ({ json: async () => ({ reason: "ok", models: [] }) });

import {
  getStateWidget,
  hideStateWidget,
  ensureState,
  restoreStateFromWidget,
  persistState,
  rowCountOf,
  mountLoraNode,
  syncRows,
  setupLoraNode,
  restoreLoraNode,
  fitNode,
  scheduleFit,
  onResizeLora,
  onDrawForegroundLora,
  wrapSetSizeLora,
  applyContentHeightLora,
  teardownLoraNode,
  captureRowTops,
  flipRows,
  enforceWidthFloor,
} from "./lora_interaction.mjs";
import { SETTING_IDS } from "../shared/settings.mjs";

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
async function asyncTest(name, fn) {
  count += 1;
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

// ---------------------------------------------------------------------------
// Minimal DOM + window stub (mirrors js/controls/test_resize.mjs's
// makeDocStub, independently -- see this file's top doc comment).
// ---------------------------------------------------------------------------

function makeDocStub() {
  let doc;

  function makeElement(tag) {
    const elObj = {
      tagName: tag,
      _listeners: {},
      children: [],
      style: {},
      value: "",
      textContent: "",
      title: "",
      disabled: false,
      type: "",
      parentNode: null,
      dataset: {},
      _attrs: {},
      setAttribute(name, v) {
        elObj._attrs[name] = String(v);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(elObj._attrs, name) ? elObj._attrs[name] : null;
      },
      removeAttribute(name) {
        delete elObj._attrs[name];
      },
      _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 300, height: ROW_H },
      get ownerDocument() {
        return doc;
      },
      // `model_picker.mjs`'s `render()` clears its list host via
      // `list.innerHTML = ""` between repaints (a real re-render, not just
      // an append) -- without a real setter here that assignment would be a
      // no-op plain-property write, leaving stale children (e.g. a "Loading…"
      // placeholder) behind every repaint.
      set innerHTML(_v) {
        elObj.children = [];
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
      addEventListener(t, fn) {
        (elObj._listeners[t] = elObj._listeners[t] || []).push(fn);
      },
      removeEventListener(t, fn) {
        const arr = elObj._listeners[t];
        if (!arr) {
          return;
        }
        const i = arr.indexOf(fn);
        if (i >= 0) {
          arr.splice(i, 1);
        }
      },
      appendChild(child) {
        const idx = elObj.children.indexOf(child);
        if (idx >= 0) {
          elObj.children.splice(idx, 1); // appendChild on an EXISTING child MOVES it -- real DOM semantics
        }
        elObj.children.push(child);
        child.parentNode = elObj;
        return child;
      },
      removeChild(child) {
        const idx = elObj.children.indexOf(child);
        if (idx >= 0) {
          elObj.children.splice(idx, 1);
        }
        child.parentNode = null;
        return child;
      },
      getBoundingClientRect() {
        return elObj._rect;
      },
      setPointerCapture() {},
      focus() {},
      select() {},
      // `js/shared/overlay.mjs`'s outside-click/`closeOverlaysNotAncestorOf`
      // logic needs a real (if trivial) `.contains` -- added here for the
      // row-menu/name-picker wiring tests below, which are the first ones in
      // this file to actually open an overlay through the real
      // `../shared/overlay.mjs` (every earlier test only exercised
      // `lora_render.mjs`/`lora_interaction.mjs`'s own DOM, never a
      // `document.body`-appended overlay).
      contains(node) {
        let cur = node;
        while (cur) {
          if (cur === elObj) {
            return true;
          }
          cur = cur.parentNode;
        }
        return false;
      },
    };
    Object.defineProperty(elObj, "className", {
      get() {
        return [...elObj.classList._set].join(" ");
      },
      set(v) {
        elObj.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
      },
    });
    return elObj;
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
    addEventListener(t, fn) {
      (win._listeners[t] = win._listeners[t] || []).push(fn);
    },
    removeEventListener(t, fn) {
      const arr = win._listeners[t];
      if (!arr) {
        return;
      }
      const i = arr.indexOf(fn);
      if (i >= 0) {
        arr.splice(i, 1);
      }
    },
    // `../shared/overlay.mjs`'s `openOverlay` defers its own outside-click
    // listener attach by one macrotask via `win.setTimeout` -- real
    // `setTimeout`, so the row-menu/name-picker tests below can just await
    // one to let it fire.
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  doc.defaultView = win;
  return win;
}

function fire(elObj, type, overrides = {}) {
  const e = { type, target: elObj, stopPropagation() {}, preventDefault() {}, ...overrides };
  (elObj._listeners[type] || []).forEach((fn) => fn(e));
}

function fireWin(win, type, overrides = {}) {
  const e = { type, stopPropagation() {}, preventDefault() {}, ...overrides };
  (win._listeners[type] || []).slice().forEach((fn) => fn(e));
}

/** Build a `[w, h]`-shaped size using `Ctor` (`Array` or `Float64Array`) --
 * mirrors `js/controls/test_resize.mjs:345`'s identically-named helper
 * (kept as an independent copy — see this file's top doc comment). */
function mkSize(Ctor, w, h) {
  return Ctor === Float64Array ? Float64Array.from([w, h]) : [w, h];
}

function makeCtx(doc, overrides = {}) {
  return {
    doc,
    getCanvasEl: overrides.getCanvasEl || (() => null),
    // BUG 15 -- defaults to scale 1 (unzoomed), matching every pre-existing
    // drag test's own assumption; only the dedicated BUG 15 tests override it.
    getCanvasScale: overrides.getCanvasScale || (() => 1),
    isGraphLoading: overrides.isGraphLoading || (() => false),
  };
}

/** `opts.sizeCtor` (default `Array`) — pass `Float64Array` to make every
 * internal reassignment of `node.size` this stub performs use that shape
 * instead, reproducing the real live shape (see this file's top doc
 * comment). */
function makeFakeNode(initialStateJSON, opts = {}) {
  const sizeCtor = opts.sizeCtor === Float64Array ? Float64Array : Array;
  const node = {
    size: mkSize(sizeCtor, DEFAULT_W, 100),
    properties: {},
    widgets: [{ name: "lora_state", value: initialStateJSON ?? "{}" }],
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
    setSize(size) {
      node.size = mkSize(sizeCtor, size[0], size[1]);
    },
    setDirtyCanvas() {
      node._dirty += 1;
    },
  };
  return node;
}

function stateJSON(rows, extra = {}) {
  return JSON.stringify({ version: 1, rows, cacheMode: "last", sep: ", ", ...extra });
}

function mkStateRow(overrides = {}) {
  return { id: 1, name: "", on: true, sm: 0.8, sc: 0.8, triggers: [], ...overrides };
}

// =========================================================================
// A. lora_render.mjs — CSS injection, DOM shape, arithmetic
// =========================================================================

test("injectStyles: idempotent -- a second call does not append a second <style>", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  injectStyles(doc);
  const styles = doc.head.children.filter((e) => e.tagName === "style");
  assert.equal(styles.length, 1);
});

// BUG 7 (2026-07-29 owner report): the rows-card wrapper adds its own
// border + padding on top of whichever rows-block height applies, and the
// between-ROWS gap is now `ROW_GAP` (4, was 7) while the header-to-card gap
// is the SEPARATE `HEADER_GAP` (7, unchanged) -- see `lora_render.mjs`'s own
// `contentHeight` doc comment for why these are two different constants now.
function cardH(rowsBlockH) {
  return rowsBlockH + CARD_PAD * 2 + CARD_BORDER * 2;
}

// (2026-07-30 owner report, corrected): a prior pass on this file dropped
// the `BODY_PAD * 2` term here, reasoning it was the (now CSS-removed)
// node-edge gap. Live testing showed that was wrong -- the term accounts
// for the rows-CARD's own top+bottom `CARD_PAD`, which is still there; see
// `lora_render.mjs`'s `contentHeight` doc comment for the full correction.
test("contentHeight: pure arithmetic, matches CSS constants, never needs the live DOM", () => {
  assert.equal(contentHeight(0), BODY_PAD * 2 + HEADER_H + HEADER_GAP + cardH(ROW_H)); // empty state occupies one row's worth
  assert.equal(contentHeight(1), BODY_PAD * 2 + HEADER_H + HEADER_GAP + cardH(ROW_H));
  assert.equal(contentHeight(3), BODY_PAD * 2 + HEADER_H + HEADER_GAP + cardH(3 * ROW_H + 2 * ROW_GAP));
  assert.equal(contentHeight(-5), contentHeight(0), "negative row counts must not go negative/NaN");
});

test("buildRoot: header has add/master/count/search/gear refs; rows host + empty state present", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  assert.ok(refs.addBtn);
  assert.ok(refs.master);
  assert.ok(refs.count);
  assert.ok(refs.searchBtn);
  assert.ok(refs.settingsBtn);
  assert.ok(refs.rowsHost);
  assert.ok(refs.empty);
  assert.ok(refs.root.className.includes("wtn-lora-root"));
  assert.ok(refs.root.className.includes("wtn")); // theme.css scoping class
});

// Regression for a review finding (2026-07-29): an earlier draft's CSS
// COMMENT claimed the master switch got `margin-left: auto` while no
// element carried the class and no CSS rule existed -- every header
// control rendered bunched on the left instead of the design's
// `＋ Add LoRA · slack · master switch · N/M · 🔍 · ⚙` layout. This test
// asserts the REAL mechanism (a class on the element AND a matching CSS
// rule), not just that the element exists, so a comment-only "fix" can't
// pass it again.
test("layout: master switch carries wtn-lora-master, and the injected CSS actually pushes it (+ everything after it) right via margin-left: auto", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  const masterClasses = refs.master.className.split(/\s+/).filter(Boolean);
  assert.ok(masterClasses.includes("wtn-lora-master"), "buildRoot must put the wtn-lora-master class on the master switch element");

  injectStyles(doc);
  const styleEl = doc.head.children.find((e) => e.tagName === "style");
  assert.ok(styleEl, "injectStyles must append a <style> element");
  const css = styleEl.textContent;
  assert.match(
    css,
    /\.wtn-lora-master\s*\{[^}]*margin-left:\s*auto/,
    "the slack must be a REAL margin-left: auto CSS rule targeting .wtn-lora-master, not merely a comment describing one",
  );
});

test("layout: '＋ Add LoRA' is capped at 30% of the node and does not flex to fill", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((e) => e.tagName === "style");
  const css = styleEl.textContent;
  assert.match(css, /\.wtn-lora-add\s*\{[^}]*max-width:\s*30%/, "'+ Add LoRA' must be capped at 30% of the node width");
  assert.match(css, /\.wtn-lora-add\s*\{[^}]*flex:\s*0 0 auto/, "'+ Add LoRA' must be content-sized (flex: 0 0 auto), never a flexing spacer");
});

test("buildRowElement: grip / name+caret / strength stepper / info / switch, in that order", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc);
  const order = refs.body.children.map((c) => c.className);
  assert.equal(order.length, 5, "grip, name, strength group, info, switch");
  assert.ok(order[0].includes("wtn-ctl-grip"));
  assert.ok(order[1].includes("wtn-lora-name"));
  assert.ok(order[2].includes("wtn-lora-str"));
  assert.ok(order[3].includes("wtn-lora-icon-info"));
  assert.ok(order[4].includes("wtn-lora-switch"), "switch must be the LAST (rightmost) element in the row");
});

test("paintRow: name falls back to a placeholder when empty; strength formatted to 2 decimals; off dims the row", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc);
  paintRow(refs, mkStateRow({ name: "", sm: 0.8 }));
  assert.equal(refs.nameLabel.textContent, "(pick a LoRA)");
  assert.equal(refs.strVal.value, "0.80");
  assert.equal(refs.root.classList.contains("wtn-lora-off"), false);
  assert.equal(refs.sw.classList.contains("wtn-lora-on"), true);

  paintRow(refs, mkStateRow({ name: "a.safetensors", sm: 1.005, on: false }));
  assert.equal(refs.nameLabel.textContent, "a.safetensors");
  assert.equal(refs.strVal.value, "1.00"); // toFixed(2) formatting, not a raw float string
  assert.equal(refs.root.classList.contains("wtn-lora-off"), true);
  assert.equal(refs.sw.classList.contains("wtn-lora-on"), false);
});

test("paintRow: an UNPICKED row (empty name) is never marked missing, even once a list has resolved", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc);
  paintRow(refs, mkStateRow({ name: "" }));
  assert.equal(refs.nameBtn.classList.contains("wtn-lora-missing"), false);
});

const _origFetchForMissingMark = globalThis.fetch;
await asyncTest(
  "paintRow: a row whose file is absent from a REAL fetched list gets the whole name field marked missing",
  async () => {
    const kind = "loras"; // paintRow always checks the "loras" kind specifically
    globalThis.fetch = async () =>
      ({ json: async () => ({ reason: "ok", models: [{ name: "present.safetensors" }] }) });
    try {
      invalidateList(kind);

      // Before the list has ever resolved: "unknown," never painted red
      // (civitai_api.mjs's own "unknown, not missing, before first load"
      // rule) -- this is the false-alarm-on-page-load bug the rule exists
      // to prevent.
      const doc1 = makeDocStub();
      const refsBeforeLoad = buildRowElement(doc1);
      paintRow(refsBeforeLoad, mkStateRow({ name: "renamed-or-deleted.safetensors" }));
      assert.equal(refsBeforeLoad.nameBtn.classList.contains("wtn-lora-missing"), false);

      await listModels(kind);

      const doc2 = makeDocStub();
      const refsMissing = buildRowElement(doc2);
      paintRow(refsMissing, mkStateRow({ name: "renamed-or-deleted.safetensors" }));
      assert.equal(refsMissing.nameBtn.classList.contains("wtn-lora-missing"), true, "the WHOLE name field, border included, per §1a-iii");
      assert.match(refsMissing.nameBtn.title, /Missing file/);

      const doc3 = makeDocStub();
      const refsPresent = buildRowElement(doc3);
      paintRow(refsPresent, mkStateRow({ name: "present.safetensors" }));
      assert.equal(refsPresent.nameBtn.classList.contains("wtn-lora-missing"), false);
    } finally {
      globalThis.fetch = _origFetchForMissingMark;
      invalidateList(kind);
    }
  },
);

test("paintHeader: N/M counter and master switch on/off", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  paintHeader(refs, [mkStateRow({ id: 1 }), mkStateRow({ id: 2, on: false })], false, 1);
  assert.equal(refs.count.textContent, "1/2");
  assert.equal(refs.master.classList.contains("wtn-lora-on"), false);

  paintHeader(refs, [mkStateRow({ id: 1 })], true, 1);
  assert.equal(refs.count.textContent, "1/1");
  assert.equal(refs.master.classList.contains("wtn-lora-on"), true);

  paintHeader(refs, [], false, 0);
  assert.equal(refs.count.textContent, "—");
});

test("paintRow: sepStrengths (§7b 'Show two strengths per row') reveals the clip cell/tags and paints row.sc independently; off (default) hides them and shows only the model value", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc);

  // Default (sepStrengths omitted/falsy) -- unchanged from every pre-Slice-5 caller.
  paintRow(refs, mkStateRow({ sm: 0.8, sc: 0.5 }));
  assert.equal(refs.strVal.value, "0.80");
  assert.equal(refs.str.classList.contains("wtn-lora-two"), false);

  // sepStrengths true -- BOTH values paint, and the group carries the reveal class.
  paintRow(refs, mkStateRow({ sm: 0.8, sc: 0.5 }), true);
  assert.equal(refs.strVal.value, "0.80");
  assert.equal(refs.strValClip.value, "0.50");
  assert.equal(refs.str.classList.contains("wtn-lora-two"), true);

  // Toggling back off removes the reveal class again (no residual state).
  paintRow(refs, mkStateRow({ sm: 0.8, sc: 0.5 }), false);
  assert.equal(refs.str.classList.contains("wtn-lora-two"), false);
});

test("buildRowElement: the strength GROUP is still exactly one child of body (order[2]), holding a model + clip cell -- clip refs exist but are inert until sepStrengths", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc);
  const order = refs.body.children.map((c) => c.className);
  assert.equal(order.length, 5, "still grip, name, strength GROUP, info, switch");
  assert.ok(order[2].includes("wtn-lora-str"));
  assert.ok(refs.strValClip, "the clip value ref must exist even in single-strength mode");
  assert.ok(refs.upClip);
  assert.ok(refs.downClip);
});

// =========================================================================
// B. State handshake
// =========================================================================

test("getStateWidget: finds `lora_state`, NOT `panel_state`", () => {
  const node = makeFakeNode();
  node.widgets.push({ name: "panel_state", value: "{}" });
  const w = getStateWidget(node);
  assert.equal(w.name, "lora_state");
});

test("hideStateWidget: hidden for rendering, but never serialize = false", () => {
  const node = makeFakeNode();
  const w = getStateWidget(node);
  w.inputEl = { style: {} };
  hideStateWidget(node);
  assert.equal(w.hidden, true);
  assert.deepEqual(w.computeSize(), [0, -4]);
  assert.equal(w.inputEl.style.display, "none");
  assert.notEqual(w.serialize, false, "must NEVER set serialize = false -- it must keep reaching the backend");
});

// Nodes 2.0 reads NEITHER `w.hidden` NOR `computeSize`/`inputEl` -- it
// derives widget visibility purely from `widget.options.hidden`
// (`isWidgetVisible` in the installed `comfyui_frontend_package`'s
// `assets/promotionUtils-*.js`; see this function's own updated doc
// comment for the full derivation). Without this, `lora_state` renders as
// a raw JSON text widget under V2 even though legacy litegraph hides it
// correctly.
test("hideStateWidget: ALSO sets widget.options.hidden = true, so Nodes 2.0 (which ignores w.hidden entirely) hides the raw blob too", () => {
  const node = makeFakeNode();
  const w = getStateWidget(node);
  hideStateWidget(node);
  assert.equal(w.options.hidden, true);
});

test("hideStateWidget: creates widget.options when the widget declared none at all -- never throws on a bare widget", () => {
  const node = makeFakeNode();
  const w = getStateWidget(node);
  delete w.options;
  hideStateWidget(node);
  assert.equal(w.options.hidden, true);
});

test("hideStateWidget: preserves any OTHER existing widget.options keys -- never replaces the options object wholesale", () => {
  const node = makeFakeNode();
  const w = getStateWidget(node);
  w.options = { multiline: true };
  hideStateWidget(node);
  assert.equal(w.options.hidden, true);
  assert.equal(w.options.multiline, true);
});

test("ensureState: a brand-new node (widget value literal '{}') gets a materialized default written BACK to the widget", () => {
  const node = makeFakeNode("{}");
  const ctx = makeCtx(makeDocStub());
  const state = ensureState(node, ctx);
  assert.deepEqual(state.rows, []);
  const w = getStateWidget(node);
  assert.equal(JSON.parse(w.value).cacheMode, "last", "the materialized default must be written back, not left as the literal '{}'");
});

test("ensureState: a deliberately-emptied saved state ({rows: []} explicit) is NOT resurrected", () => {
  const node = makeFakeNode(stateJSON([]));
  const ctx = makeCtx(makeDocStub());
  const w = getStateWidget(node);
  const before = w.value;
  ensureState(node, ctx);
  assert.equal(w.value, before, "an explicit empty rows array must not be rewritten/touched");
});

test("ensureState: initializes ONCE -- row object identity is stable across repeated calls", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 7, name: "a.safetensors" })]));
  const ctx = makeCtx(makeDocStub());
  const s1 = ensureState(node, ctx);
  const s2 = ensureState(node, ctx);
  assert.equal(s1, s2);
  assert.equal(s1.rows[0], s2.rows[0]);
});

test("restoreStateFromWidget: force-reparses even if node.properties already held something else", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "saved.safetensors" })]));
  const ctx = makeCtx(makeDocStub());
  node.properties.loraState = { rows: [{ id: 999, name: "stale-in-memory", on: true, sm: 0.8, sc: 0.8, triggers: [] }] };
  const state = restoreStateFromWidget(node, ctx);
  assert.equal(state.rows[0].name, "saved.safetensors");
});

test("persistState: mirrors the CURRENT state into the widget and dirties the canvas", () => {
  const node = makeFakeNode(stateJSON([]));
  const ctx = makeCtx(makeDocStub());
  const state = ensureState(node, ctx);
  addStateRow(state);
  const before = node._dirty;
  persistState(node, ctx);
  const w = getStateWidget(node);
  assert.equal(JSON.parse(w.value).rows.length, 1);
  assert.ok(node._dirty > before);
});

test("rowCountOf: reads the live row count from state", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 })]));
  const ctx = makeCtx(makeDocStub());
  assert.equal(rowCountOf(node, ctx), 2);
});

// =========================================================================
// C. Header interactions through REAL wired DOM
// =========================================================================

test("mountLoraNode + '+ Add LoRA' click: appends a fresh row and repaints the counter", () => {
  const node = makeFakeNode(stateJSON([]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const refs = node._lrRefs;
  assert.equal(refs.count.textContent, "—");
  fire(refs.addBtn, "click");
  assert.equal(rowCountOf(node, ctx), 1);
  assert.equal(refs.count.textContent, "1/1");
  assert.equal(refs.empty.style.display, "none");
});

test("master switch: mixed -> click turns EVERYTHING on; all-on -> click turns EVERYTHING off", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, on: true }), mkStateRow({ id: 2, on: false })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const refs = node._lrRefs;
  assert.equal(refs.master.classList.contains("wtn-lora-on"), false); // mixed reads OFF
  assert.equal(refs.count.textContent, "1/2");

  fire(refs.master, "click"); // mixed -> all on
  const state = ensureState(node, ctx);
  assert.ok(state.rows.every((r) => r.on));
  assert.equal(refs.master.classList.contains("wtn-lora-on"), true);
  assert.equal(refs.count.textContent, "2/2");

  fire(refs.master, "click"); // all-on -> all off
  assert.ok(state.rows.every((r) => !r.on));
  assert.equal(refs.master.classList.contains("wtn-lora-on"), false);
  assert.equal(refs.count.textContent, "0/2");
});

test("empty state: '+ Add LoRA' visible label; empty line shown only with zero rows", () => {
  const node = makeFakeNode(stateJSON([]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const refs = node._lrRefs;
  assert.equal(refs.empty.style.display, "flex");
  fire(refs.addBtn, "click");
  assert.equal(refs.empty.style.display, "none");
});

// =========================================================================
// C2. The ⚙ settings dialog (design doc §7b, Slice 5)
// =========================================================================

test("⚙: opens the dialog with fields reflecting the CURRENT per-node state; ✕ closes it", () => {
  const node = makeFakeNode(stateJSON([], { cacheMode: "all", sep: " | ", defaultStrength: 1.1, strengthStep: 0.1, sepStrengths: true }));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const refs = node._lrRefs;

  fire(refs.settingsBtn, "click");
  const panel = findAllByClass(doc.body, "wtn-lora-set")[0];
  assert.ok(panel, "the settings panel must be appended to doc.body");

  const defaultStrengthInput = findAllByClass(doc.body, "wtn-lora-set-num")[0];
  assert.equal(defaultStrengthInput.value, "1.10");
  const strengthStepInput = findAllByClass(doc.body, "wtn-lora-set-num")[1];
  assert.equal(strengthStepInput.value, "0.10");
  const sepInput = findAllByClass(doc.body, "wtn-lora-set-text")[0];
  assert.equal(sepInput.value, " | ");
  const seg = findAllByClass(doc.body, "wtn-seg")[0];
  assert.equal(seg.children.find((b) => b.dataset.mode === "all").getAttribute("aria-pressed"), "true");
  const sepStrengthsSwitch = findAllByClass(doc.body, "wtn-lora-switch").find((e) => e.title && /Show a model AND a clip/.test(e.title));
  assert.equal(sepStrengthsSwitch.classList.contains("wtn-lora-on"), true);

  const closeBtn = findAllByClass(doc.body, "wtn-lora-set-close")[0];
  closeBtn._listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
  assert.equal(findAllByClass(doc.body, "wtn-lora-set").length, 0, "✕ must close the panel");
});

test("⚙: Default strength / Strength step edits persist into the state blob immediately", () => {
  const node = makeFakeNode(stateJSON([]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  fire(node._lrRefs.settingsBtn, "click");

  const defaultStrengthInput = findAllByClass(doc.body, "wtn-lora-set-num")[0];
  defaultStrengthInput.value = "1.4";
  defaultStrengthInput._listeners.change.forEach((fn) => fn({}));
  assert.equal(ensureState(node, ctx).defaultStrength, 1.4);
  assert.equal(JSON.parse(getStateWidget(node).value).defaultStrength, 1.4, "must be in the persisted widget value too");

  const strengthStepInput = findAllByClass(doc.body, "wtn-lora-set-num")[1];
  strengthStepInput.value = "0.2";
  strengthStepInput._listeners.change.forEach((fn) => fn({}));
  assert.equal(ensureState(node, ctx).strengthStep, 0.2);
});

test("⚙: 'Separate model / clip strength' toggles state.sepStrengths and immediately repaints rows (clip cell revealed)", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const rowRefs = node._lrRows[0].refs;
  assert.equal(rowRefs.str.classList.contains("wtn-lora-two"), false);

  fire(node._lrRefs.settingsBtn, "click");
  const sw = findAllByClass(doc.body, "wtn-lora-switch").find((e) => e.title && /Show a model AND a clip/.test(e.title));
  assert.ok(sw, "the separate-strengths switch must be findable by its title");
  sw._listeners.click.forEach((fn) => fn({ stopPropagation() {} }));

  assert.equal(ensureState(node, ctx).sepStrengths, true);
  assert.equal(rowRefs.str.classList.contains("wtn-lora-two"), true, "existing rows must repaint immediately, not just on next unrelated sync");
});

test("⚙: Trigger words separator edits persist on 'input', not just 'change'", () => {
  const node = makeFakeNode(stateJSON([]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  fire(node._lrRefs.settingsBtn, "click");
  const sepInput = findAllByClass(doc.body, "wtn-lora-set-text")[0];
  sepInput.value = " / ";
  sepInput._listeners.input.forEach((fn) => fn({}));
  assert.equal(ensureState(node, ctx).sep, " / ");
});

test("⚙: LoRA memory use segmented buttons set cacheMode and reflect aria-pressed", () => {
  const node = makeFakeNode(stateJSON([])); // cacheMode defaults to "last" (Standard)
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  fire(node._lrRefs.settingsBtn, "click");

  const seg = findAllByClass(doc.body, "wtn-seg")[0];
  const btns = seg.children;
  assert.equal(btns.length, 3);
  assert.equal(btns[0].textContent, "Standard");
  assert.equal(btns[1].textContent, "Fast");
  assert.equal(btns[2].textContent, "Lowest");
  assert.equal(btns[0].getAttribute("aria-pressed"), "true");
  assert.equal(btns[1].getAttribute("aria-pressed"), "false");

  btns[1]._listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
  assert.equal(ensureState(node, ctx).cacheMode, "all");
  assert.equal(btns[1].getAttribute("aria-pressed"), "true");
  assert.equal(btns[0].getAttribute("aria-pressed"), "false");
});

test("⚙: Hide file extension / Civitai / Show preview thumbnails write through Settings -> AnimaFlow (setSetting), NEVER the per-node state blob", () => {
  const node = makeFakeNode(stateJSON([]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);

  const written = {};
  globalThis.window = {
    app: {
      extensionManager: {
        setting: {
          get: (id) => (Object.prototype.hasOwnProperty.call(written, id) ? written[id] : undefined),
          set: (id, v) => { written[id] = v; },
        },
      },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  try {
    fire(node._lrRefs.settingsBtn, "click");
    // Hide-extension/Civitai/thumbs switches carry no `title` (only the
    // separate-strengths one does, above) -- there are three of them; grab
    // all and click each in turn.
    const settingsSwitches = findAllByClass(doc.body, "wtn-lora-switch").filter((e) => !e.title);
    assert.equal(settingsSwitches.length, 3, "hide-extension / Civitai / show-thumbnails switches");
    settingsSwitches.forEach((sw) => sw._listeners.click.forEach((fn) => fn({ stopPropagation() {} })));

    assert.equal(written[SETTING_IDS.HIDE_FILE_EXTENSION], true);
    assert.equal(written[SETTING_IDS.CIVITAI_ENABLED], false, "Civitai defaults ON -- one click turns it off");
    assert.equal(written[SETTING_IDS.SHOW_PREVIEW_THUMBNAILS], false, "thumbnails default ON -- one click turns it off");

    // The state blob itself must NEVER have gained these keys (§7b's
    // ownership split -- they are user-wide, not per-node).
    const state = ensureState(node, ctx);
    assert.equal("hideFileExtension" in state, false);
    assert.equal("civitaiEnabled" in state, false);
    assert.equal("showPreviewThumbnails" in state, false);
  } finally {
    delete globalThis.window;
  }
});

test("⚙: toggling Civitai off immediately hides the header's 🔍 (re-runs syncRows, no separate listener needed)", () => {
  const node = makeFakeNode(stateJSON([]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  assert.notEqual(node._lrRefs.searchBtn.style.display, "none");

  const written = {};
  globalThis.window = {
    app: { extensionManager: { setting: {
      get: (id) => (Object.prototype.hasOwnProperty.call(written, id) ? written[id] : undefined),
      set: (id, v) => { written[id] = v; },
    } } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  try {
    fire(node._lrRefs.settingsBtn, "click");
    const settingsSwitches = findAllByClass(doc.body, "wtn-lora-switch").filter((e) => !e.title);
    settingsSwitches[1]._listeners.click.forEach((fn) => fn({ stopPropagation() {} })); // Civitai is the 2nd of the three
    assert.equal(node._lrRefs.searchBtn.style.display, "none");
  } finally {
    delete globalThis.window;
  }
});

test("⚙: toggling Hide file extension immediately repaints every row's own label (task brief, 2026-07-31, part B) -- 'the second part is the one that gets forgotten'", () => {
  const node = makeFakeNode(stateJSON([{ name: "celica_v2.safetensors" }]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const rowRefs = node._lrRows[0].refs;
  assert.equal(rowRefs.nameLabel.textContent, "celica_v2.safetensors", "extension shown by default (setting off)");

  const written = {};
  globalThis.window = {
    app: { extensionManager: { setting: {
      get: (id) => (Object.prototype.hasOwnProperty.call(written, id) ? written[id] : undefined),
      set: (id, v) => { written[id] = v; },
    } } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  try {
    fire(node._lrRefs.settingsBtn, "click");
    const settingsSwitches = findAllByClass(doc.body, "wtn-lora-switch").filter((e) => !e.title);
    settingsSwitches[0]._listeners.click.forEach((fn) => fn({ stopPropagation() {} })); // Hide file extension is the 1st of the three
    assert.equal(written[SETTING_IDS.HIDE_FILE_EXTENSION], true);
    // The row must repaint IMMEDIATELY -- not merely on the next unrelated
    // sync -- because the setting toggle alone does not otherwise touch this
    // row's own DOM.
    assert.equal(rowRefs.nameLabel.textContent, "celica_v2", "extension stripped the moment the setting flips, no further action needed");
    assert.equal(rowRefs.nameLabel.title, "celica_v2.safetensors", "the label's own tooltip still carries the REAL, untruncated name");
    assert.equal(rowRefs.nameBtn.title, "celica_v2.safetensors", "the enclosing button's tooltip is unaffected -- identity, not display");
  } finally {
    delete globalThis.window;
  }
});

test("paintRow: the name label reads the live 'Hide file extension' setting via displayRowName -- row.name (identity) itself never changes", () => {
  globalThis.window = { app: { extensionManager: { setting: { get: (id) => (id === SETTING_IDS.HIDE_FILE_EXTENSION ? true : undefined) } } } };
  try {
    const doc = makeDocStub();
    const refs = buildRowElement(doc);
    const row = mkStateRow({ name: "detail/celica_v2.safetensors" });
    paintRow(refs, row);
    assert.equal(refs.nameLabel.textContent, "detail/celica_v2", "display strips the extension");
    assert.equal(row.name, "detail/celica_v2.safetensors", "identity is untouched by painting");
    assert.equal(refs.nameLabel.title, "detail/celica_v2.safetensors");
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// §1a-vii ("show the CIVITAI name instead of the filename -- a setting"):
// `paintRow`'s name label, gated on SHOW_CIVITAI_NAME, sourced from
// `civitai_api.mjs`'s own `civitaiNameFor("loras", row.name)`.
// ---------------------------------------------------------------------------

const _origFetchForCivitaiNameRow = globalThis.fetch;
await asyncTest(
  "paintRow: shows the Civitai name only when SHOW_CIVITAI_NAME is on, and always falls back to the filename for a MISSING row regardless of the setting",
  async () => {
    const kind = "loras";
    globalThis.fetch = async () => ({
      json: async () => ({
        reason: "ok",
        models: [{ name: "real_skin-step00000200.safetensors", civitai_name: "Realistic Skin Detail" }],
      }),
    });
    try {
      invalidateList(kind);
      // `force: true` -- bypasses BOTH the cache AND the in-flight-promise
      // dedupe, so this genuinely runs THIS stub's fetch rather than
      // possibly reusing an unawaited `listModels("loras")` call some
      // earlier, fetch-oblivious `mountLoraNode` test in this same file left
      // in flight (`civitai_api.mjs`'s own de-dupe-by-kind rule).
      await listModels(kind, true);

      // Setting OFF (default) -- the filename, even though a Civitai name
      // is already known for this exact file.
      const docOff = makeDocStub();
      const refsOff = buildRowElement(docOff);
      paintRow(refsOff, mkStateRow({ name: "real_skin-step00000200.safetensors" }));
      assert.equal(refsOff.nameLabel.textContent, "real_skin-step00000200.safetensors");
      assert.equal(refsOff.nameLabel.title, "real_skin-step00000200.safetensors");

      globalThis.window = { app: { extensionManager: { setting: { get: (id) => (id === SETTING_IDS.SHOW_CIVITAI_NAME ? true : undefined) } } } };
      try {
        // Setting ON, file PRESENT -- the Civitai name, full name also in
        // the label's own tooltip (§1a-vii: these run longer than filenames).
        const docFound = makeDocStub();
        const refsFound = buildRowElement(docFound);
        paintRow(refsFound, mkStateRow({ name: "real_skin-step00000200.safetensors" }));
        assert.equal(refsFound.nameLabel.textContent, "Realistic Skin Detail");
        assert.equal(refsFound.nameLabel.title, "Realistic Skin Detail");
        // The button's own tooltip and the missing-file class are both
        // identity concerns -- unaffected by the display name.
        assert.equal(refsFound.nameBtn.title, "real_skin-step00000200.safetensors");
        assert.equal(refsFound.nameBtn.classList.contains("wtn-lora-missing"), false);

        // Setting ON, file MISSING -- the filename, NEVER the (stale, now
        // meaningless) Civitai name, whatever the setting says (§1a-vii's
        // own carve-out: the red state's whole point is naming the file
        // that's actually gone).
        const docMissing = makeDocStub();
        const refsMissing = buildRowElement(docMissing);
        paintRow(refsMissing, mkStateRow({ name: "renamed-or-deleted-with-civitai-name.safetensors" }));
        assert.equal(refsMissing.nameBtn.classList.contains("wtn-lora-missing"), true);
        assert.equal(refsMissing.nameLabel.textContent, "renamed-or-deleted-with-civitai-name.safetensors");
        assert.equal(refsMissing.nameLabel.title, "renamed-or-deleted-with-civitai-name.safetensors");
      } finally {
        delete globalThis.window;
      }
    } finally {
      globalThis.fetch = _origFetchForCivitaiNameRow;
      invalidateList(kind);
    }
  },
);

test("⚙: is keyed PER NODE -- opening a second node's dialog does not just toggle the first one closed", () => {
  const nodeA = makeFakeNode(stateJSON([]));
  const nodeB = makeFakeNode(stateJSON([]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(nodeA, ctx);
  mountLoraNode(nodeB, ctx);

  fire(nodeA._lrRefs.settingsBtn, "click");
  assert.equal(findAllByClass(doc.body, "wtn-lora-set").length, 1);
  fire(nodeB._lrRefs.settingsBtn, "click");
  assert.equal(findAllByClass(doc.body, "wtn-lora-set").length, 1, "opening node B's dialog must close A's (different overlay), not leave both open");
});

// =========================================================================
// Core-mechanic audit (2026-07-30, owner directive): "after the state has
// been re-parsed from the widget (the load path), an edit driven through
// the node's own wired handler must land in the SERIALIZED widget value."
// Suspected mechanism: `lora_state.mjs`'s `normalizeRow` mints a FRESH `id`
// via `nextUid()` on every parse (never reads a saved row's own `id` back
// out of the JSON), and `wireRow`'s handlers (`bump`, `refs.sw`'s on/off,
// `commitTyped`, ...) close over `rowId`, not the row object -- so if a
// handler wired against one parse's id ever survived a LATER re-parse's
// `syncRows` without being re-wired, its `state.rows.find(r => r.id ===
// rowId)` lookup would silently find nothing and no-op, rather than the
// Control/Loader Panel's "mutates an orphan" symptom.
//
// This does NOT reproduce: `syncRows`'s `existingById` map (keyed by
// `entry.id`) is looked up PER ROW against the CURRENT `state.rows`, and
// since a re-parsed row's id can never match a stale entry's id (ids are
// minted from a monotonic, never-reset, never-reused counter), every row
// surviving a re-parse gets a BRAND-NEW entry + a BRAND-NEW `wireRow(node,
// ctx, row.id, rowRefs)` call bound to the CURRENT id, and the stale entry
// is dropped from the DOM. `restoreLoraNode` (the onConfigure path) calls
// `restoreStateFromWidget` (the forced re-parse) then `mountLoraNode` ->
// `syncRows` SYNCHRONOUSLY, immediately, every time -- there is no window in
// which a re-parse happens without the very next `syncRows` re-binding every
// handler to the ids that re-parse just produced.
// =========================================================================

test("core-mechanic audit: after the two-phase onNodeCreated -> onConfigure reload sequence (a forced lora_state re-parse that mints fresh row ids), bumping a row's strength through its own wired stepper still reaches the SERIALIZED lora_state widget", () => {
  const savedNode = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "my_lora.safetensors", sm: 0.8, sc: 0.8 })]));
  const savedCtx = makeCtx(makeDocStub());
  setupLoraNode(savedNode, savedCtx); // establishes the "saved workflow"

  // Reproduce index.js's real two-phase sequence with ONE ctx reused across
  // BOTH phases (registerLoraNodeType's own `node._lrCtx || buildLoraCtx()`
  // reuse contract) -- mirrors `js/controls/test_resize.mjs`'s identical
  // audit test for the Control/Loader Panel.
  const savedStateJSON = getStateWidget(savedNode).value;
  const reloadedDoc = makeDocStub();
  makeWindowStub(reloadedDoc);
  const reloaded = makeFakeNode(savedStateJSON);
  const reloadedCtx = makeCtx(reloadedDoc);

  setupLoraNode(reloaded, reloadedCtx); // onNodeCreated
  restoreLoraNode(reloaded, reloadedCtx); // onConfigure -- forces the re-parse

  const rowBefore = ensureState(reloaded, reloadedCtx).rows[0];
  const entry = reloaded._lrRows.find((e) => e.id === rowBefore.id);
  assert.ok(entry, "the reloaded row's DOM entry must be wired against the CURRENT (post-re-parse) id");
  assert.equal(entry.refs.strVal.value, "0.80");

  fire(entry.refs.up, "click"); // the row's own wired strength stepper
  assert.equal(entry.refs.strVal.value, "0.85");
  const persistedRows = JSON.parse(getStateWidget(reloaded).value).rows;
  assert.equal(persistedRows.length, 1);
  assert.equal(persistedRows[0].sm, 0.85, "the bump made AFTER a reload's forced re-parse must reach the SERIALIZED widget, not just the on-screen row");
});

// =========================================================================
// D. Row interactions
// =========================================================================

test("strength ▲▼: bumps sm/sc together, persists, and repaints only that row's value", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  fire(entry.refs.up, "click");
  const state = ensureState(node, ctx);
  assert.equal(state.rows[0].sm, 0.85);
  assert.equal(state.rows[0].sc, 0.85);
  assert.equal(entry.refs.strVal.value, "0.85");
  const w = getStateWidget(node);
  assert.equal(JSON.parse(w.value).rows[0].sm, 0.85, "must persist after every mutation");

  fire(entry.refs.down, "click");
  assert.equal(ensureState(node, ctx).rows[0].sm, 0.8);
});

test("strength ▲▼: reads the PER-NODE strengthStep (§7b 'Strength step (arrows)'), not the hardcoded default", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })], { strengthStep: 0.2 }));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  fire(entry.refs.up, "click");
  assert.equal(ensureState(node, ctx).rows[0].sm, 1.0, "bumped by the per-node 0.2 step, not the pack default 0.05");
});

test("strength ▲▼: with sepStrengths on, the model and clip steppers diverge -- only the clicked one moves", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })], { sepStrengths: true }));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];

  fire(entry.refs.up, "click"); // model only
  let state = ensureState(node, ctx);
  assert.equal(state.rows[0].sm, 0.85);
  assert.equal(state.rows[0].sc, 0.8, "sc must not move when the MODEL stepper was clicked, in two-strength mode");
  assert.equal(entry.refs.strValClip.value, "0.80");

  fire(entry.refs.upClip, "click"); // clip only
  state = ensureState(node, ctx);
  assert.equal(state.rows[0].sc, 0.85);
  assert.equal(state.rows[0].sm, 0.85, "sm must not move when the CLIP stepper was clicked");
  assert.equal(entry.refs.strValClip.value, "0.85");

  fire(entry.refs.downClip, "click");
  assert.equal(ensureState(node, ctx).rows[0].sc, 0.8);
  assert.equal(ensureState(node, ctx).rows[0].sm, 0.85);
});

// ---------------------------------------------------------------------------
// BUG 17 (2026-07-29 owner report): the strength value is a real editable
// `<input>` now, commit-on-blur/Enter, Escape reverts, garbage never
// written.
// ---------------------------------------------------------------------------

test("BUG 17: typing a valid value commits on BLUR", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  entry.refs.strVal.value = "0.65";
  fire(entry.refs.strVal, "blur");
  assert.equal(ensureState(node, ctx).rows[0].sm, 0.65);
  const w = getStateWidget(node);
  assert.equal(JSON.parse(w.value).rows[0].sm, 0.65, "must persist -- blur is a real commit");
});

test("BUG 17: typing a valid value and pressing Enter commits immediately (not merely on a later blur)", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  entry.refs.strVal.value = "1.25";
  fire(entry.refs.strVal, "keydown", { key: "Enter" });
  assert.equal(ensureState(node, ctx).rows[0].sm, 1.25);
});

test("BUG 17: Escape reverts to the row's CURRENT value -- discards the edit, never commits it", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  entry.refs.strVal.value = "1.99";
  fire(entry.refs.strVal, "keydown", { key: "Escape" });
  assert.equal(ensureState(node, ctx).rows[0].sm, 0.8, "the state must be untouched");
  assert.equal(entry.refs.strVal.value, "0.80", "the field itself must revert to the stored value, not stay at the discarded text");
});

test("BUG 17: never writes on every keystroke -- an 'input' event alone (no blur/Enter) must not touch state", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  entry.refs.strVal.value = "0.";
  fire(entry.refs.strVal, "input"); // no listener wired for this -- confirms nothing commits from typing alone
  assert.equal(ensureState(node, ctx).rows[0].sm, 0.8, "a half-typed value must never reach the state blob");
});

for (const garbage of ["", "   ", "abc", "--1", "1e999", "NaN", "0.5\nDROP TABLE"]) {
  test(`BUG 17: garbage input (${JSON.stringify(garbage)}) on blur reverts to the row's CURRENT value, never writes NaN or anything else`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    const entry = node._lrRows[0];
    entry.refs.strVal.value = garbage;
    fire(entry.refs.strVal, "blur");
    const sm = ensureState(node, ctx).rows[0].sm;
    assert.equal(sm, 0.8, "must revert to the previous stored value");
    assert.ok(Number.isFinite(sm), "must NEVER end up NaN in the state blob");
    assert.equal(entry.refs.strVal.value, "0.80", "the field must repaint back to the stored value too");
  });
}

test("BUG 17: a typed value and an arrow-bumped value round IDENTICALLY (same clamp/round pipeline)", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  entry.refs.strVal.value = "0.95000001"; // more precision than the 2-decimal round supports
  fire(entry.refs.strVal, "blur");
  assert.equal(ensureState(node, ctx).rows[0].sm, 0.95, "must round to 2 decimals, exactly like bumpRowStrength/clampStrength");
});

test("BUG 17: typed edits stay INDEPENDENT per cell when sepStrengths is on, and LOCKSTEP when it's off", () => {
  // sepStrengths ON -- editing the clip cell must not move the model cell.
  const nodeSep = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })], { sepStrengths: true }));
  const docSep = makeDocStub();
  const ctxSep = makeCtx(docSep);
  mountLoraNode(nodeSep, ctxSep);
  const entrySep = nodeSep._lrRows[0];
  entrySep.refs.strValClip.value = "0.3";
  fire(entrySep.refs.strValClip, "blur");
  assert.equal(ensureState(nodeSep, ctxSep).rows[0].sc, 0.3);
  assert.equal(ensureState(nodeSep, ctxSep).rows[0].sm, 0.8, "sm must not move -- sepStrengths on");

  // sepStrengths OFF (default) -- editing either cell moves BOTH.
  const nodeLock = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
  const docLock = makeDocStub();
  const ctxLock = makeCtx(docLock);
  mountLoraNode(nodeLock, ctxLock);
  const entryLock = nodeLock._lrRows[0];
  entryLock.refs.strVal.value = "1.1";
  fire(entryLock.refs.strVal, "blur");
  assert.equal(ensureState(nodeLock, ctxLock).rows[0].sm, 1.1);
  assert.equal(ensureState(nodeLock, ctxLock).rows[0].sc, 1.1, "sc must follow sm in lockstep -- sepStrengths off");
});

test("BUG 17: the strength input stops propagation on pointerdown/keydown -- litegraph must never see these", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, sm: 0.8, sc: 0.8 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  let pointerdownPropagated = false;
  let keydownPropagated = false;
  entry.refs.body.addEventListener("pointerdown", () => { pointerdownPropagated = true; });
  entry.refs.body.addEventListener("keydown", () => { keydownPropagated = true; });
  // This suite's own `fire` helper calls listeners directly rather than
  // truly bubbling -- so this test instead confirms EACH listener calls
  // `stopPropagation` on the event it receives, which is what actually
  // prevents real-DOM bubbling to an ancestor (litegraph's own canvas-level
  // handlers included).
  let stoppedPointer = false;
  let stoppedKey = false;
  fire(entry.refs.strVal, "pointerdown", { stopPropagation: () => { stoppedPointer = true; } });
  fire(entry.refs.strVal, "keydown", { key: "a", stopPropagation: () => { stoppedKey = true; } });
  assert.ok(stoppedPointer, "pointerdown must call stopPropagation");
  assert.ok(stoppedKey, "keydown must call stopPropagation");
  assert.equal(pointerdownPropagated, false);
  assert.equal(keydownPropagated, false);
});

test("row switch: toggles just that row's `on`, and updates the header counter/master switch", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, on: true }), mkStateRow({ id: 2, on: true })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const refs = node._lrRefs;
  const entry = node._lrRows[0];
  fire(entry.refs.sw, "click");
  assert.equal(ensureState(node, ctx).rows[0].on, false);
  assert.equal(refs.count.textContent, "1/2");
  assert.equal(refs.master.classList.contains("wtn-lora-on"), false);
});

test("row switch: an off row is visibly dimmed via wtn-lora-off on the row root", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, on: true })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];
  fire(entry.refs.sw, "click");
  assert.equal(entry.refs.root.classList.contains("wtn-lora-off"), true);
});

// ---------------------------------------------------------------------------
// Name field -> model picker, and the row's right-click menu (design doc
// §1a-iii/§1a-v, Slice 3). Both open a REAL overlay via `../shared/
// overlay.mjs`, appended to `doc.body` -- `findAllByClass` below walks that
// stub tree the same way `test_model_picker.mjs`'s own `findAll` does.
// ---------------------------------------------------------------------------

function findAllByClass(root, className) {
  const out = [];
  const walk = (e) => {
    if (e && e.classList && e.classList.contains(className)) {
      out.push(e);
    }
    (e && e.children ? e.children : []).forEach(walk);
  };
  walk(root);
  return out;
}

/** ALL text under `root`, recursively -- this suite's doc stub's own
 * `.textContent` is a plain string property (never auto-aggregated from
 * children, unlike a real DOM node), so reading it directly on a container
 * element only ever sees whatever was explicitly assigned to THAT element,
 * never its descendants'. Used wherever a test needs to search a whole
 * subtree's rendered text rather than one specific leaf. */
function collectText(el) {
  let s = el && typeof el.textContent === "string" ? el.textContent : "";
  for (const c of (el && el.children) || []) {
    s += " " + collectText(c);
  }
  return s;
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

const _origFetchForRowWiring = globalThis.fetch;

await asyncTest("row name field: opens the model picker anchored to the row; picking a name persists and repaints", async () => {
  // Every earlier SYNCHRONOUS test's `mountLoraNode` warm-up call triggers
  // its OWN non-forced `listModels("loras")` -- with no `await` between most
  // of those tests, civitai_api.mjs's in-flight-promise dedup means only ONE
  // such call is genuinely pending at a time, built from whatever `fetch`
  // stub was active back when it was first created. `invalidateList` alone
  // only clears the CACHE, not that dedup map -- so a non-forced call here
  // would still be served the STALE pending promise instead of triggering a
  // fresh fetch with this test's own stub. Draining it first (with whatever
  // stub is currently active) empties BOTH the cache and the dedup map, so
  // the fetch stub swap below is what a subsequent call actually observes.
  await flushMicrotasks();
  invalidateList("loras");

  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "ok",
      models: [{ name: "old.safetensors", group: "All", size: 1024, base_model: "SDXL", has_preview: false }, {
        name: "new.safetensors", group: "All", size: 2048, base_model: "Anima", has_preview: false,
      }],
    }),
  });
  try {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "old.safetensors" })]));
    const doc = makeDocStub();
    makeWindowStub(doc);
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    const entry = node._lrRows[0];

    fire(entry.refs.nameBtn, "click");
    await flushMicrotasks();

    const rows = findAllByClass(doc.body, "wtn-mp-row");
    assert.equal(rows.length, 2, "the picker must list both files from the stubbed /list response");
    const pickTarget = rows.find((r) => r.title === "new.safetensors");
    assert.ok(pickTarget, "the row for the file NOT currently picked must be present");
    fire(pickTarget, "click");

    assert.equal(ensureState(node, ctx).rows[0].name, "new.safetensors");
    assert.equal(entry.refs.nameLabel.textContent, "new.safetensors", "repaintOne must run after a pick");
    const w = getStateWidget(node);
    assert.equal(JSON.parse(w.value).rows[0].name, "new.safetensors", "a pick must persist to the widget");
  } finally {
    globalThis.fetch = _origFetchForRowWiring;
    invalidateList("loras");
  }
});

test("row context menu: 'More info' · 'Duplicate' · 'Disable/Enable' (current-state-aware) · 'Remove' -- only the two reorder arrows are dropped (§1a-iii)", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a.safetensors", on: true })]));
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];

  fire(entry.refs.root, "contextmenu");
  const opts = findAllByClass(doc.body, "wtn-ctl-opt");
  assert.equal(opts.length, 4, "exactly four items -- the two reorder arrows are dropped");
  assert.match(opts[0].textContent, /More info/);
  assert.equal(opts[0].classList.contains("wtn-ctl-opt-disabled"), false, "More info is LIVE (Slice 4) -- it must not read as inert");
  assert.match(opts[1].textContent, /Duplicate/);
  assert.match(opts[2].textContent, /Disable/, "the row is ON, so the menu offers 'Disable', never an action already true");
  assert.match(opts[3].textContent, /Remove/);
});

await asyncTest("row context menu: 'More info' opens the ⓘ info panel (Slice 4) and closes the row menu itself", async () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a.safetensors", on: true, triggers: ["existing"] })]));
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ reason: "notfound", offline_reason: null, message: "", data: null }) });
  try {
    fire(entry.refs.root, "contextmenu");
    const info = findAllByClass(doc.body, "wtn-ctl-opt").find((o) => /More info/.test(o.textContent));
    fire(info, "click");

    assert.equal(findAllByClass(doc.body, "wtn-ctl-menu").length, 0, "the row menu itself closes when 'More info' is picked");
    const panels = findAllByClass(doc.body, "wtn-mi-panel");
    assert.equal(panels.length, 1, "the ⓘ info panel opens");
    const chips = findAllByClass(panels[0], "wtn-mi-chip");
    assert.equal(chips.length, 1, "the row's currently-selected trigger word shows as a chip");
  } finally {
    globalThis.fetch = origFetch;
  }
});

await asyncTest("row's own ⓘ button opens the same info panel (Slice 4 -- it's no longer inert)", async () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a.safetensors", on: true })]));
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ reason: "notfound", offline_reason: null, message: "", data: null }) });
  try {
    fire(entry.refs.info, "click");
    assert.equal(findAllByClass(doc.body, "wtn-mi-panel").length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("row context menu: Duplicate adds a row via the pure duplicateRow (real row count grows by one)", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a.safetensors" })]));
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];

  fire(entry.refs.root, "contextmenu");
  const dup = findAllByClass(doc.body, "wtn-ctl-opt").find((o) => /Duplicate/.test(o.textContent));
  fire(dup, "click");

  const state = ensureState(node, ctx);
  assert.equal(state.rows.length, 2);
  assert.equal(state.rows[1].name, "a.safetensors");
  assert.notEqual(state.rows[1].id, state.rows[0].id, "the duplicate must get a FRESH id, never share the original's");
});

test("row context menu: Disable/Enable reads the row's CURRENT state, and toggles it", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a.safetensors", on: true })]));
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];

  fire(entry.refs.root, "contextmenu");
  const toggle1 = findAllByClass(doc.body, "wtn-ctl-opt").find((o) => /Disable|Enable/.test(o.textContent));
  assert.match(toggle1.textContent, /Disable/);
  fire(toggle1, "click");
  assert.equal(ensureState(node, ctx).rows[0].on, false);

  fire(entry.refs.root, "contextmenu");
  const toggle2 = findAllByClass(doc.body, "wtn-ctl-opt").find((o) => /Disable|Enable/.test(o.textContent));
  assert.match(toggle2.textContent, /Enable/, "the menu must never offer 'Disable' on an already-off row");
});

test("row context menu: Remove removes the row via the pure removeRow", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a.safetensors" }), mkStateRow({ id: 2, name: "b.safetensors" })]));
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];

  fire(entry.refs.root, "contextmenu");
  const del = findAllByClass(doc.body, "wtn-ctl-opt").find((o) => /Remove/.test(o.textContent));
  fire(del, "click");

  const state = ensureState(node, ctx);
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].name, "b.safetensors");
});

test("row context menu: right-clicking the SAME row a second time toggles it closed", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a.safetensors" })]));
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const entry = node._lrRows[0];

  fire(entry.refs.root, "contextmenu");
  assert.equal(findAllByClass(doc.body, "wtn-ctl-menu").length, 1);
  fire(entry.refs.root, "contextmenu");
  assert.equal(findAllByClass(doc.body, "wtn-ctl-menu").length, 0);
});

test("grip drag: reorders rows WITHOUT recreating the dragged row's own DOM element", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" }), mkStateRow({ id: 3, name: "c" })]));
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);

  // `normalizeRow` ALWAYS allocates a fresh id (`lora_state.mjs`'s own
  // doc comment: `overrides.id` can never win) -- the ids in the JSON above
  // are just distinct placeholders, not what actually ends up on the row.
  // Read the REAL assigned id back off the live state instead of assuming it.
  const draggedRowId = ensureState(node, ctx).rows[0].id;
  const draggedEntry = node._lrRows[0]; // row "a"
  const draggedEl = draggedEntry.refs.root;
  const step = ROW_H + ROW_GAP;

  fire(draggedEntry.refs.grip, "pointerdown", { clientY: 0 });
  assert.equal(draggedEl.classList.contains("wtn-lora-dragging"), true);

  fireWin(win, "pointermove", { clientY: step * 2 + 1 }); // drag down past both siblings
  assert.deepEqual(ensureState(node, ctx).rows.map((r) => r.name), ["b", "c", "a"]);
  // The SAME element moved -- not a fresh one rebuilt in its place.
  const stillEntry = node._lrRows.find((e) => e.id === draggedRowId);
  assert.equal(stillEntry.refs.root, draggedEl, "syncRows must reuse the existing row element, never rebuild it mid-drag");
  assert.equal(draggedEl.classList.contains("wtn-lora-dragging"), true, "the dragging class must survive the reorder");

  fireWin(win, "pointerup");
  assert.equal(draggedEl.classList.contains("wtn-lora-dragging"), false);
  const w = getStateWidget(node);
  assert.deepEqual(JSON.parse(w.value).rows.map((r) => r.name), ["b", "c", "a"], "persisted only on release");
});

// ---------------------------------------------------------------------------
// BUG 15 (2026-07-29 owner report): "the drag has an issue, it goes over
// multiple rows on a small mouse movement" -- the drag math must convert
// the SCREEN-pixel pointer delta into node space via the canvas zoom scale
// BEFORE dividing by the row pitch, or a zoomed canvas overshoots by
// exactly the zoom factor.
// ---------------------------------------------------------------------------

test("BUG 15: a pointer delta of exactly one row pitch moves exactly ONE position at scale 1", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" }), mkStateRow({ id: 3, name: "c" })]));
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc, { getCanvasScale: () => 1 });
  mountLoraNode(node, ctx);
  const draggedEntry = node._lrRows[0];
  const step = ROW_H + ROW_GAP;

  fire(draggedEntry.refs.grip, "pointerdown", { clientY: 0 });
  fireWin(win, "pointermove", { clientY: step + 1 }); // one row pitch of REAL screen movement
  assert.deepEqual(ensureState(node, ctx).rows.map((r) => r.name), ["b", "a", "c"], "must move exactly ONE position, not two or three");
  fireWin(win, "pointerup");
});

test("BUG 15 (the actual regression guard): the SAME one-row-pitch SCREEN movement moves exactly ONE position at scale 2 too -- not two", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" }), mkStateRow({ id: 3, name: "c" })]));
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc, { getCanvasScale: () => 2 });
  mountLoraNode(node, ctx);
  const draggedEntry = node._lrRows[0];
  const step = ROW_H + ROW_GAP;

  fire(draggedEntry.refs.grip, "pointerdown", { clientY: 0 });
  // At 2x zoom, ONE row of on-screen movement is `step * 2` screen pixels --
  // the pre-fix math (`delta = round(screenDelta / step)`, no scale
  // division) would read this as delta=2 and jump TWO rows instead of one.
  fireWin(win, "pointermove", { clientY: step * 2 + 1 });
  assert.deepEqual(ensureState(node, ctx).rows.map((r) => r.name), ["b", "a", "c"], "must STILL move exactly one position -- the screen delta must be divided by scale before the row-pitch division");
  fireWin(win, "pointerup");
});

test("BUG 15: a sub-pitch movement (at any scale) moves nothing", () => {
  for (const scale of [1, 2, 3]) {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" }), mkStateRow({ id: 3, name: "c" })]));
    const doc = makeDocStub();
    const win = makeWindowStub(doc);
    const ctx = makeCtx(doc, { getCanvasScale: () => scale });
    mountLoraNode(node, ctx);
    const draggedEntry = node._lrRows[0];
    const step = ROW_H + ROW_GAP;

    fire(draggedEntry.refs.grip, "pointerdown", { clientY: 0 });
    // A THIRD of a row pitch's worth of on-screen movement, scaled --
    // unambiguously rounds to zero rows at every scale (avoids the exact
    // half-pitch boundary, where `Math.round` itself rounds up).
    fireWin(win, "pointermove", { clientY: Math.floor((step * scale) / 3) });
    assert.deepEqual(ensureState(node, ctx).rows.map((r) => r.name), ["a", "b", "c"], `must not move at all (scale ${scale})`);
    fireWin(win, "pointerup");
  }
});

test("BUG 15: falls back to scale 1 when ctx.getCanvasScale is absent (older/partial ctx) -- never divides by zero/NaN", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" })]));
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = { doc, getCanvasEl: () => null, isGraphLoading: () => false }; // no getCanvasScale at all
  mountLoraNode(node, ctx);
  const draggedEntry = node._lrRows[0];
  const step = ROW_H + ROW_GAP;

  fire(draggedEntry.refs.grip, "pointerdown", { clientY: 0 });
  fireWin(win, "pointermove", { clientY: step + 1 });
  assert.deepEqual(ensureState(node, ctx).rows.map((r) => r.name), ["b", "a"], "must behave as scale 1 when the accessor is missing");
  fireWin(win, "pointerup");
});

test("BUG 15: the drag's row pitch is derived from the SAME ROW_H/ROW_GAP constants contentHeight() uses -- not a second, hand-kept copy", () => {
  // Pure arithmetic check: if `wireGrip`'s own `step` ever diverged from
  // `ROW_H + ROW_GAP`, this would be the only place that could notice
  // without a live drag -- both this file and lora_interaction.mjs import
  // the SAME two constants from lora_render.mjs, so there is only one
  // place either could be edited.
  assert.equal(ROW_H + ROW_GAP, 34, "sanity: the pitch this suite assumes throughout every drag test above");
  assert.ok(contentHeight(2) - contentHeight(1) === ROW_H + ROW_GAP, "one more row must cost EXACTLY one row pitch -- the same number the drag math divides by");
});

test("FLIP mid-drag: row COUNT (and therefore Class A content height) never changes across a reorder -- verified, not assumed (§1a-iii)", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" }), mkStateRow({ id: 3, name: "c" })]));
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const before = contentHeight(rowCountOf(node, ctx));

  const draggedEntry = node._lrRows[0];
  const step = ROW_H + ROW_GAP;
  fire(draggedEntry.refs.grip, "pointerdown", { clientY: 0 });
  fireWin(win, "pointermove", { clientY: step + 1 });
  assert.equal(contentHeight(rowCountOf(node, ctx)), before, "reordering must never change row count, so the Class A floor stays put");
  fireWin(win, "pointerup");
  assert.equal(contentHeight(rowCountOf(node, ctx)), before);
});

// ---------------------------------------------------------------------------
// FLIP animation helpers -- `captureRowTops`/`flipRows` (design doc §1a-iii,
// Slice 5), exercised directly against a minimal fake-node/fake-row shape
// rather than through a full drag sequence, so the transform math is
// asserted precisely. Mirrors the "no rAF host by default" convention this
// file establishes for `scheduleFit`/`fitNode` -- `requestAnimationFrame` is
// stubbed ONLY where a test needs it, and always restored afterward.
// ---------------------------------------------------------------------------

test("captureRowTops: keyed by row id, reads each mounted row's CURRENT top", () => {
  const doc = makeDocStub();
  const elA = doc.createElement("div");
  const elB = doc.createElement("div");
  elA._rect.top = 5;
  elB._rect.top = 65;
  const node = { _lrRows: [{ id: "x", refs: { root: elA } }, { id: "y", refs: { root: elB } }] };
  const tops = captureRowTops(node);
  assert.equal(tops.get("x"), 5);
  assert.equal(tops.get("y"), 65);
});

test("flipRows: writes each MOVED row's inverse-translate transform immediately, then (next rAF) transitions it to 0 via .wtn-row-flip", () => {
  const doc = makeDocStub();
  const elA = doc.createElement("div");
  const elB = doc.createElement("div");
  elA._rect.top = 0;
  elB._rect.top = 30;
  const node = { _lrRows: [{ id: 1, refs: { root: elA } }, { id: 2, refs: { root: elB } }] };

  const before = captureRowTops(node); // {1: 0, 2: 30}

  // Simulate the reflow syncRows already performed: the two rows swapped places.
  elA._rect.top = 30;
  elB._rect.top = 0;

  const rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => rafQueue.push(cb);
  try {
    flipRows(node, before);
    // Immediately (before any rAF fires): each row shows its OWN inverse
    // delta, and does NOT yet carry the transitioning class -- if it did,
    // the CSS transition would animate the assignment itself, defeating the
    // "instantly at the old position first" half of FLIP.
    assert.equal(elA.style.transform, "translateY(-30px)"); // was 0, now 30 -> dy = -30
    assert.equal(elB.style.transform, "translateY(30px)"); // was 30, now 0 -> dy = 30
    assert.equal(elA.classList.contains("wtn-row-flip"), false);
    assert.equal(elB.classList.contains("wtn-row-flip"), false);

    rafQueue.slice().forEach((cb) => cb());
    assert.equal(elA.style.transform, "", "cleared back to nothing -- the CSS transition animates FROM the inline value TO this");
    assert.equal(elB.style.transform, "");
    assert.equal(elA.classList.contains("wtn-row-flip"), true);
    assert.equal(elB.classList.contains("wtn-row-flip"), true);
  } finally {
    delete globalThis.requestAnimationFrame;
  }
});

test("flipRows: a row whose top did NOT change is left completely untouched -- no transform, no flip class", () => {
  const doc = makeDocStub();
  const el = doc.createElement("div");
  el._rect.top = 10;
  const node = { _lrRows: [{ id: 1, refs: { root: el } }] };
  const before = captureRowTops(node);
  // top unchanged (10 -> 10)
  flipRows(node, before);
  assert.ok(!el.style.transform, "no transform must ever be written for a row that didn't move");
  assert.equal(el.classList.contains("wtn-row-flip"), false);
});

test("flipRows: with no requestAnimationFrame host (this suite's own default), the transform settles IMMEDIATELY -- never stuck mid-transform", () => {
  assert.equal(typeof globalThis.requestAnimationFrame, "undefined", "sanity: no rAF stub installed in this test");
  const doc = makeDocStub();
  const el = doc.createElement("div");
  el._rect.top = 0;
  const node = { _lrRows: [{ id: 1, refs: { root: el } }] };
  const before = captureRowTops(node);
  el._rect.top = 40;
  flipRows(node, before);
  assert.equal(el.style.transform, "", "must settle immediately with no animation-frame host available");
});

test("flipRows: a row id absent from beforeTops (e.g. a brand-new row) is skipped, never throws", () => {
  const doc = makeDocStub();
  const el = doc.createElement("div");
  el._rect.top = 0;
  const node = { _lrRows: [{ id: 999, refs: { root: el } }] };
  assert.doesNotThrow(() => flipRows(node, new Map()));
  assert.ok(!el.style.transform, "a row with no 'before' entry must be left completely alone");
});

test("syncRows: reordering never detaches/reattaches an UNCHANGED row -- listeners on a stationary row survive", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountLoraNode(node, ctx);
  const before = node._lrRows.map((e) => e.refs.root);
  // Bump a value (no structural change) -- syncRows-equivalent path (via a
  // click) must not replace any row's DOM element.
  fire(node._lrRows[0].refs.up, "click");
  const after = node._lrRows.map((e) => e.refs.root);
  assert.deepEqual(after, before);
});

// =========================================================================
// F. Class A sizing -- all five layers, parametrised over [Array, Float64Array]
// (see this file's top doc comment for why both are required).
// =========================================================================

for (const SizeCtor of [Array, Float64Array]) {
  test(`mountLoraNode: addDOMWidget getMinHeight === getMaxHeight, and both read row count LIVE (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    const widget = node._lrWidget;
    assert.equal(widget.options.getMinHeight(), contentHeight(1));
    assert.equal(widget.options.getMaxHeight(), contentHeight(1));
    assert.equal(widget.options.getMinHeight(), widget.options.getMaxHeight(), "min === max is the only real height lock");
    // Add a row -- the SAME live functions must now report the new height,
    // never a value frozen at mount time.
    const state = ensureState(node, ctx);
    addStateRow(state);
    assert.equal(widget.options.getMinHeight(), contentHeight(2));
    assert.equal(widget.options.getMaxHeight(), contentHeight(2));
  });

  test(`onResizeLora: a height drag is a no-op -- node.size[1] snaps back to content height (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 }), mkStateRow({ id: 3 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    const dragged = mkSize(SizeCtor, MIN_W, 900);
    node.size = dragged;
    onResizeLora(node, ctx, dragged);
    // +WIDGETS_START_Y: this bare `makeFakeNode` never gets a real
    // `node.computeSize` (only `setupLoraNode` installs one), so `fitNodeH`
    // takes its arithmetic FALLBACK -- which reserves the SAME fixed
    // output-socket column (BUG 3) `computeLoraSize` does, for the exact
    // reason `lora_interaction.mjs`'s own `fitNodeH` doc comment gives.
    assert.equal(dragged[1], WIDGETS_START_Y + contentHeight(3));
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(3));
  });

  test(`onResizeLora: a width drag works normally, floored at MIN_W (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    const widened = mkSize(SizeCtor, 500, 900);
    node.size = widened;
    onResizeLora(node, ctx, widened);
    assert.equal(widened[0], 500);
    const narrowed = mkSize(SizeCtor, 10, 900);
    node.size = narrowed;
    onResizeLora(node, ctx, narrowed);
    assert.equal(narrowed[0], MIN_W);
  });

  // Every OTHER onResizeLora test above calls it with `size === node.size`
  // (litegraph's own real call shape), which never exercises the
  // `arr !== node.size` mirroring branch (`lora_interaction.mjs`'s own doc
  // comment: "in case a caller ever passes a size that isn't the very same
  // array node.size already is"). A headless test stub CAN pass a different
  // object here even though litegraph itself never does -- prove that path
  // actually mirrors onto node.size rather than only correcting its own arg.
  test(`onResizeLora: size !== node.size -- BOTH the passed-in array and node.size itself get corrected (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, MIN_W, 100); // node.size starts as a DIFFERENT object than `dragged` below
    const dragged = mkSize(SizeCtor, 10, 900);
    assert.notEqual(dragged, node.size, "sanity check: this test's whole point is size !== node.size");
    onResizeLora(node, ctx, dragged);
    assert.equal(dragged[0], MIN_W, "the passed-in size argument itself must be corrected");
    assert.equal(dragged[1], WIDGETS_START_Y + contentHeight(2));
    assert.equal(node.size[0], MIN_W, "node.size must be mirrored to match -- litegraph reads node.size afterward, not the local arg");
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(2));
  });

  test(`onResizeLora: no-ops entirely under Nodes 2.0 (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    const dragged = mkSize(SizeCtor, 10, 900);
    node.size = dragged;
    globalThis.window = { LiteGraph: { vueNodesMode: true } };
    try {
      onResizeLora(node, ctx, dragged);
    } finally {
      delete globalThis.window;
    }
    assert.deepEqual(dragged, mkSize(SizeCtor, 10, 900));
  });

  test(`onDrawForegroundLora: forces size[1] to content height and floors size[0] at MIN_W (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, 10, 900); // simulates a stuck drag onResize never corrected
    onDrawForegroundLora(node, ctx);
    assert.equal(node.size[0], MIN_W);
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(2));
  });

  test(`onDrawForegroundLora: bails during a load (isGraphLoading) -- must not stamp over a still-restoring size (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, { isGraphLoading: () => true });
    node.size = mkSize(SizeCtor, 900, 900);
    onDrawForegroundLora(node, ctx);
    assert.deepEqual([...node.size], [900, 900], "must leave a still-loading node's size completely untouched");
  });

  test(`onDrawForegroundLora: bails on node._lrConfiguring too (second half of the belt-and-braces guard) (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    node._lrConfiguring = true;
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, 900, 900);
    onDrawForegroundLora(node, ctx);
    assert.deepEqual([...node.size], [900, 900]);
  });

  test(`onDrawForegroundLora: no-ops under Nodes 2.0 (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, 10, 900);
    globalThis.window = { LiteGraph: { vueNodesMode: true } };
    try {
      onDrawForegroundLora(node, ctx);
    } finally {
      delete globalThis.window;
    }
    assert.deepEqual([...node.size], [10, 900]);
  });

  test(`wrapSetSizeLora: corrects PRE-PAINT -- the very call that sets the size already carries the locked height (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    wrapSetSizeLora(node, ctx);
    node.setSize([500, 5]); // simulates litegraph's drag handler calling setSize with a too-short/tall value
    assert.equal(node.size[0], 500);
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(2));
  });

  test(`wrapSetSizeLora: floors width at MIN_W too (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    wrapSetSizeLora(node, ctx);
    node.setSize([10, 900]);
    assert.equal(node.size[0], MIN_W);
  });

  test(`wrapSetSizeLora: passes straight through during a load or under Nodes 2.0 -- never fights either (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc, { isGraphLoading: () => true });
    wrapSetSizeLora(node, ctx);
    node.setSize([10, 900]);
    assert.deepEqual([...node.size], [10, 900]);
  });

  test(`applyContentHeightLora: corrects height on the load path, leaves WIDTH completely untouched (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 }), mkStateRow({ id: 3 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, 555, 12); // a stale/hand-edited saved height
    applyContentHeightLora(node, ctx);
    assert.equal(node.size[0], 555, "width must be left EXACTLY as restored");
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(3));
  });

  test(`fitNode/scheduleFit: bail entirely while node._lrConfiguring or ctx.isGraphLoading() is true (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    node._lrConfiguring = true;
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, 900, 900);
    fitNode(node, ctx);
    assert.deepEqual([...node.size], [900, 900]);

    node._lrConfiguring = false;
    const ctx2 = makeCtx(doc, { isGraphLoading: () => true });
    fitNode(node, ctx2);
    assert.deepEqual([...node.size], [900, 900]);
  });

  test(`fitNode: fits width (floored) and height to content when not loading/configuring (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, 10, 10);
    fitNode(node, ctx);
    assert.equal(node.size[0], MIN_W);
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(2));
  });
}

// =========================================================================
// G. Owner bug-fix pass (2026-07-29) -- BUG 3 (header/output-socket
// collision), BUG 4 (Add button truncation), BUG 5 (settings label
// wrapping), BUG 6 (inert-looking Browse button), BUG 7 (row floor +
// sepStrengths-aware width, the rows-card).
// =========================================================================

// -- BUG 3: the fixed output-socket column ----------------------------------

test("BUG 3: SLOT_HEADER_H/WIDGETS_START_Y reserve the REAL socket column -- model+clip in, MODEL/CLIP/triggers out", () => {
  assert.equal(INPUT_SLOT_COUNT, 2, "model (required) + clip (optional)");
  assert.equal(OUTPUT_SLOT_COUNT, 3, "MODEL, CLIP, triggers -- fixed, never per-row (design doc §5)");
  assert.equal(SLOT_HEADER_H, Math.max(INPUT_SLOT_COUNT, OUTPUT_SLOT_COUNT) * NODE_SLOT_H);
  assert.equal(WIDGETS_START_Y, SLOT_HEADER_H + 2, "the '+2' mirrors litegraph's own default gap");
});

test("BUG 3: setupLoraNode sets widgets_start_y to WIDGETS_START_Y, never the flat 2 Control Panel uses", () => {
  const node = makeFakeNode(stateJSON([]));
  const ctx = makeCtx(makeDocStub());
  setupLoraNode(node, ctx);
  assert.equal(node.widgets_start_y, WIDGETS_START_Y);
  assert.notEqual(node.widgets_start_y, 2, "the OLD value put the DOM widget on top of the fixed output sockets");
});

test("BUG 3: restoreLoraNode ALSO sets widgets_start_y to WIDGETS_START_Y (the restore path, not just fresh-node)", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]));
  const ctx = makeCtx(makeDocStub());
  setupLoraNode(node, ctx);
  node.widgets_start_y = 2; // simulate a stale value from an older build's saved behaviour
  restoreLoraNode(node, ctx);
  assert.equal(node.widgets_start_y, WIDGETS_START_Y);
});

test("BUG 3: node.computeSize's height includes WIDGETS_START_Y -- the total node height, not just the widget's own box", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 })]));
  const ctx = makeCtx(makeDocStub());
  setupLoraNode(node, ctx);
  const [, h] = node.computeSize();
  assert.equal(h, WIDGETS_START_Y + contentHeight(2));
});

// -- BUG 4: the '+ Add LoRA' button never truncates at any sane node width --

test("BUG 4: '.wtn-lora-add' carries a min-width ALONGSIDE the 30% cap -- never squeezed unreadable", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  assert.match(css, new RegExp(`\\.wtn-lora-add\\s*\\{[^}]*min-width:\\s*${ADD_MIN_W}px`));
  assert.match(css, /\.wtn-lora-add\s*\{[^}]*max-width:\s*30%/, "the 30% cap must still be there too -- min-width is IN ADDITION, not a replacement");
});

// -- BUG 5: the settings dialog's 'LoRA memory use' row stacks instead of
// squeezing its label against the segmented control -----------------------

test("BUG 5: the 'LoRA memory use' field row carries the stacked layout modifier, and the hint explains all THREE modes", () => {
  const doc = makeDocStub();
  const refs = buildSettingsPanel(doc);
  const rowMode = refs.cacheModeBtns[0].parentNode.parentNode; // btn -> seg -> row
  assert.ok(rowMode.classList.contains("wtn-lora-set-fld-stack"), "the memory-use row must stack (BUG 5)");
  const hintText = collectText(rowMode);
  assert.match(hintText, /Standard/);
  assert.match(hintText, /Fast/);
  assert.match(hintText, /Lowest/);

  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  assert.match(css, /\.wtn-lora-set-fld\.wtn-lora-set-fld-stack\s*\{[^}]*flex-direction:\s*column/);
});

test("BUG 1 audit: the settings dialog no longer renders internal design-doc reasoning (the raw-key subhint, the 'dropped from upstream' paragraph)", () => {
  const doc = makeDocStub();
  const refs = buildSettingsPanel(doc);
  const wholeText = collectText(refs.root);
  assert.doesNotMatch(wholeText, /raw key in state/);
  assert.doesNotMatch(wholeText, /Dropped from upstream/);
});

// -- M2 (docs/lora-loader-design.md §7c): the 🔍 Browse Civitai button is
// LIVE now -- BUG 6's old "visibly disabled" treatment is retired
// (`lora_interaction.mjs`'s `wireHeader` wires a real click handler). -------

test("M2: the header's search/browse button is no longer rendered disabled", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  assert.ok(!refs.searchBtn.classList.contains("wtn-lora-icon-disabled"), "the 🔍 must not carry the retired disabled-look class any more");
  assert.equal(refs.searchBtn.title, "Browse Civitai");
});

// -- BUG 19 (2026-07-29 owner report): the ⚙ is the pack's plain glyph, not a
// second hand-rolled mask SVG (BUG 12's own fix is retired along with it --
// there is no more gear geometry to assert a relationship about) ------------

test("BUG 19: the settings button renders the pack's plain '⚙' textContent glyph, matching js/controls/render.mjs's own row gear -- no mask-image at all", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  assert.equal(refs.settingsBtn.textContent, "⚙");
  assert.ok(refs.settingsBtn.classList.contains("wtn-lora-gear"));

  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  const gearRuleMatch = css.match(/\.wtn-lora-icon\.wtn-lora-gear\s*\{([^}]*)\}/);
  assert.ok(gearRuleMatch, "a plain-glyph rule for '.wtn-lora-icon.wtn-lora-gear' must exist");
  assert.doesNotMatch(gearRuleMatch[1], /mask-image/, "the gear must not be a CSS-mask SVG any more");
});

// -- owner screenshot, 2026-07-31: the ⚙ was visibly smaller than the 🔍
// beside it in the SAME 18px icon box -- a font-size fix (this file's own top
// doc comment), not a box-size or mask-size one; both icons keep sharing
// '.wtn-lora-icon' unchanged. ------------------------------------------------

test("owner screenshot, 2026-07-31: the ⚙ glyph's font-size (18px) now equals the shared 18px icon box, not the old 14px that read smaller than the 🔍 mask icon beside it", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;

  const gearRuleMatch = css.match(/\.wtn-lora-icon\.wtn-lora-gear\s*\{([^}]*)\}/);
  assert.ok(gearRuleMatch, "a plain-glyph rule for '.wtn-lora-icon.wtn-lora-gear' must exist");
  assert.match(gearRuleMatch[1], /font-size:\s*18px/, "bumped from 14px -- the glyph's own heavy internal whitespace read small at the old size next to a mask icon that fills its box");

  const iconBoxMatch = css.match(/\.wtn-lora-icon\s*\{([^}]*)\}/);
  assert.ok(iconBoxMatch, "the shared 🔍/⚙ box rule must still exist");
  assert.match(iconBoxMatch[1], /width:\s*18px/, "the box itself is untouched -- this is a font-size fix, not a box-size one");
  assert.match(iconBoxMatch[1], /height:\s*18px/);

  const searchRuleMatch = css.match(/\.wtn-lora-icon\.wtn-lora-search\s*\{([^}]*)\}/);
  assert.ok(searchRuleMatch, "the 🔍 rule must still exist");
  assert.match(searchRuleMatch[1], /mask-size:\s*contain/, "the 🔍 stays a mask-size:contain glyph -- this fix never touched mask-size either");
});

// -- BUG 7: the row floor, sepStrengths' own higher floor, the rows-card,
// and the M/C letters -> title tooltips --------------------------------------

test("BUG 7: MIN_W_SEP is a REAL amount higher than MIN_W -- exactly one more stepper cell + its gap", () => {
  assert.ok(MIN_W_SEP > MIN_W, "sepStrengths needs a materially higher floor, not the same one");
  assert.equal(MIN_W_SEP - MIN_W, STEPPER_W + CTRL_GAP, "derived from the SAME control widths as the CSS, not guessed");
});

test("BUG 7: the 'M'/'C' letter tags are GONE -- the stepper cell's OWN title carries that naming, fixed order (model first)", () => {
  const doc = makeDocStub();
  const refs = buildRowElement(doc);
  const strGroup = refs.str;
  const [modelCell, clipCell] = strGroup.children;
  assert.equal(modelCell.title, "Model strength");
  assert.equal(clipCell.title, "Clip strength");
  assert.ok(!modelCell.children.some((c) => c.className.includes("wtn-lora-str-tag")), "no letter-tag element must exist any more");
  assert.match(refs.up.title, /model strength/i);
  assert.match(refs.upClip.title, /clip strength/i);
});

test("BUG 7: the rows sit inside a bordered card ('.wtn-lora-rows-card'), border is PLAIN --wtn-line-soft -- never an accent", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc);
  assert.ok(refs.card.classList.contains("wtn-lora-rows-card"));
  assert.equal(refs.card.children.includes(refs.rowsHost), true);
  assert.equal(refs.card.children.includes(refs.empty), true);

  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  const cardRuleMatch = css.match(/\.wtn-lora-rows-card\s*\{([^}]*)\}/);
  assert.ok(cardRuleMatch, "the card rule must exist");
  assert.match(cardRuleMatch[1], /border:\s*1px solid var\(--wtn-line-soft/);
  assert.doesNotMatch(cardRuleMatch[1], /--wtn-accent/, "the card border must never carry the house accent (98d0fe5/a6478f0's own settled conclusion)");
});

test("BUG 7: the row gap between LoRAs is 4px now (was 7) -- the header-to-card gap is UNCHANGED at 7", () => {
  assert.equal(ROW_GAP, 4);
  assert.equal(HEADER_GAP, 7);
  const doc = makeDocStub();
  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  assert.match(css, /\.wtn-lora-rows\s*\{[^}]*gap:\s*4px/);
  assert.match(css, /\.wtn-lora-root\s*\{[^}]*gap:\s*7px/);
});

for (const SizeCtor of [Array, Float64Array]) {
  test(`BUG 7: the width floor is MIN_W_SEP (not MIN_W) once sepStrengths is on -- onResizeLora (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })], { sepStrengths: true }), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    const narrowed = mkSize(SizeCtor, 10, 900);
    node.size = narrowed;
    onResizeLora(node, ctx, narrowed);
    assert.equal(narrowed[0], MIN_W_SEP);
  });

  test(`BUG 7: the width floor is MIN_W_SEP once sepStrengths is on -- onDrawForegroundLora (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })], { sepStrengths: true }), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, 10, 900);
    onDrawForegroundLora(node, ctx);
    assert.equal(node.size[0], MIN_W_SEP);
  });

  test(`BUG 7: the width floor is MIN_W_SEP once sepStrengths is on -- wrapSetSizeLora (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })], { sepStrengths: true }), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    wrapSetSizeLora(node, ctx);
    node.setSize([10, 900]);
    assert.equal(node.size[0], MIN_W_SEP);
  });

  test(`BUG 7: the width floor is MIN_W_SEP once sepStrengths is on -- fitNode (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })], { sepStrengths: true }), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    node.size = mkSize(SizeCtor, 10, 10);
    fitNode(node, ctx);
    assert.equal(node.size[0], MIN_W_SEP);
  });

  test(`BUG 7: enforceWidthFloor WIDENS a too-narrow node up to the CURRENT mode's floor (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })], { sepStrengths: true }), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    wrapSetSizeLora(node, ctx); // installed by setupLoraNode in real life -- enforceWidthFloor relies on it
    node.size = mkSize(SizeCtor, MIN_W, 100); // narrower than MIN_W_SEP
    enforceWidthFloor(node, ctx);
    assert.equal(node.size[0], MIN_W_SEP);
  });

  test(`BUG 7: enforceWidthFloor NEVER shrinks a node the user has already widened (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })], { sepStrengths: false }), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    wrapSetSizeLora(node, ctx);
    node.size = mkSize(SizeCtor, 900, 100); // user-widened, well past either floor
    enforceWidthFloor(node, ctx);
    assert.equal(node.size[0], 900, "must not shrink toward the single-strength floor");
  });
}

await asyncTest("BUG 7: toggling 'Separate model / clip strength' ON widens a too-narrow node to MIN_W_SEP; toggling back OFF does not shrink it", async () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]));
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  setupLoraNode(node, ctx); // installs wrapSetSizeLora -- enforceWidthFloor depends on it
  node.size[0] = MIN_W; // at the single-strength floor exactly

  fire(node._lrRefs.settingsBtn, "click");
  const sw = findAllByClass(doc.body, "wtn-lora-switch").find((e) => e.title && /Show a model AND a clip/.test(e.title));
  fire(sw, "click"); // turn sepStrengths ON
  assert.equal(node.size[0], MIN_W_SEP, "must widen to the NEW, higher floor immediately");

  node.size[0] = 500; // simulate the user manually widening it further
  fire(sw, "click"); // turn sepStrengths back OFF
  assert.equal(node.size[0], 500, "must NOT shrink back down just because the setting turned off");
});

// =========================================================================
// H. Owner bug-fix pass round 2 (2026-07-30) -- BUG 9 (segmented buttons
// don't share width evenly), BUG 10 (rows card flush against the node
// border; floors must account for the new outer/inner chrome).
// =========================================================================

// -- BUG 9: Standard/Fast/Lowest share the row evenly, scoped to THIS dialog -

test("BUG 9: the memory-mode segmented buttons share the row's width evenly, SCOPED to the LoRA settings dialog only", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((e) => e.id === "wtn-lora-style");
  assert.ok(styleEl, "the equal-width rule must live in THIS node's own <style>, never js/shared/theme.css");
  const css = styleEl.textContent;

  assert.match(
    css,
    /\.wtn-lora-set-fld-stack\s+\.wtn-seg\s+button\s*\{[^}]*flex:\s*1 1 0/,
    "the three buttons must share the row's width evenly (equal flex basis)",
  );
  // SCOPED -- '.wtn-seg' is the pack-wide segmented-group class
  // (js/shared/theme.css), also used by the Rule Builder's mode/profile
  // tablists and the autocomplete picker's positive/negative tablist, both
  // of which rely on staying content-sized -- a BARE, unscoped
  // '.wtn-seg button { ... }' rule in THIS file's own stylesheet would be
  // harmless on its own (theme.css is a separate file) but is exactly the
  // kind of rule that's easy to widen-by-accident later, so this asserts
  // the selector is never the start of its own top-level rule.
  const bareRuleCount = (css.match(/(^|\})\s*\.wtn-seg\s+button\s*\{/g) || []).length;
  assert.equal(bareRuleCount, 0, "must never define a bare, unscoped '.wtn-seg button {' rule");
});

// -- 2026-07-30 owner report: the node-edge gap is REMOVED ENTIRELY (root
// carries no padding, the header/card carry no margin) -- BUG 18 had moved
// it from root's own padding to the header's/card's own margin; this is a
// further change, not another move. The CSS removal below stands; the
// arithmetic (`contentHeight`/`OUTER_CHROME_W`) is a SEPARATE matter -- see
// `lora_render.mjs`'s `contentHeight` doc comment for the corrected
// rationale (its `BODY_PAD * 2`/`BODY_PAD` terms were never about this
// gap and are restored below). --

test("BUG 18: '.wtn-lora-root' carries NO padding of its own -- unchanged by the 2026-07-30 gap removal", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  const rootRuleMatch = css.match(/\.wtn-lora-root\s*\{([^}]*)\}/);
  assert.ok(rootRuleMatch, "the root rule must exist");
  assert.doesNotMatch(rootRuleMatch[1], /padding:/, "root must not carry any padding -- BUG 18's fix (owner's own suggestion)");
});

test("2026-07-30 owner report: the header carries NO margin -- the node-edge gap it used to carry (BUG 18) is removed entirely, not moved again", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  const headerRuleMatch = css.match(/\.wtn-lora-header\s*\{([^}]*)\}/);
  assert.ok(headerRuleMatch, "the header rule must exist");
  assert.doesNotMatch(headerRuleMatch[1], /margin:/, "header must not carry any margin -- the node-edge gap is gone entirely");
});

test("2026-07-30 owner report: the rows-card carries NO margin -- the node-edge gap it used to carry (BUG 18) is removed entirely, not moved again", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  const cardRuleMatch = css.match(/\.wtn-lora-rows-card\s*\{([^}]*)\}/);
  assert.ok(cardRuleMatch, "the rows-card rule must exist");
  assert.doesNotMatch(cardRuleMatch[1], /margin:/, "rows-card must not carry any margin -- the node-edge gap is gone entirely");
});

test("BUG 10: the card's OWN inner padding is 8px (confirmed, not lowered further -- it was never larger)", () => {
  assert.equal(CARD_PAD, 8);
  const doc = makeDocStub();
  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  assert.match(css, /\.wtn-lora-rows-card\s*\{[^}]*padding:\s*8px/);
});

test("2026-07-30 owner report, corrected: contentHeight DOES still add BODY_PAD * 2 -- that term was never the (now CSS-removed) node-edge gap, it's the rows-CARD's own top+bottom padding, still present", () => {
  const cardHeight = (rowsBlockH) => rowsBlockH + CARD_PAD * 2 + CARD_BORDER * 2;
  assert.equal(contentHeight(0), BODY_PAD * 2 + HEADER_H + HEADER_GAP + cardHeight(ROW_H));
  assert.equal(contentHeight(3), BODY_PAD * 2 + HEADER_H + HEADER_GAP + cardHeight(3 * ROW_H + 2 * ROW_GAP));
});

test("2026-07-30 owner report, corrected: MIN_W/MIN_W_SEP account for EVERY layer of chrome between the node's edge and the row -- BODY_PAD, card padding, card border, not just the row's own internal padding", () => {
  // Re-derive independently from the exported constants (never a hardcoded
  // number). A prior pass dropped the `2 * BODY_PAD` term here on the theory
  // it was the (now CSS-removed) node-edge gap; live testing corrected that
  // -- the term is restored, in step with `contentHeight`'s own correction.
  const outerChromeW = 2 * BODY_PAD + 2 * CARD_PAD + 2 * CARD_BORDER;
  const singleFixedW = outerChromeW + GRIP_W + CTRL_GAP * 4 + STEPPER_W + INFO_W + SWITCH_W + ROW_PAD_L + ROW_PAD_R;
  assert.equal(MIN_W, NAME_MIN_W + singleFixedW);
  const sepFixedW = singleFixedW + STEPPER_W + CTRL_GAP;
  assert.equal(MIN_W_SEP, NAME_MIN_W + sepFixedW);
});

test("2026-07-30 owner report, corrected: at the MIN_W floor, the row's own content (grip+name+stepper+info+switch) genuinely fits within what's left after ALL outer chrome -- not just an internal-padding check", () => {
  const outerChromeW = 2 * BODY_PAD + 2 * CARD_PAD + 2 * CARD_BORDER;
  const rowAvailableW = MIN_W - outerChromeW; // what's actually left for '.wtn-ctl-row' itself
  const rowOwnFixedW = GRIP_W + CTRL_GAP * 4 + STEPPER_W + INFO_W + SWITCH_W + ROW_PAD_L + ROW_PAD_R;
  assert.ok(rowAvailableW >= rowOwnFixedW + NAME_MIN_W, "the row must fit ENTIRELY inside the space left after card chrome, at the exact floor");
});

// -- BUG 16: the ▲▼ arrows get real breathing room, without touching ROW_H --

test("BUG 16: the ▲▼ arrows are separated by 4-6px (owner's own range), and ROW_H is UNCHANGED -- the spin column comfortably fits within it", () => {
  assert.ok(SPIN_GAP >= 4 && SPIN_GAP <= 6, "must land inside the owner's requested 4-6px range");
  assert.equal(ROW_H, 30, "ROW_H must stay put -- the spin column's own total height (arrow+gap+arrow) is nowhere near it");
  const doc = makeDocStub();
  injectStyles(doc);
  const css = doc.head.children.find((e) => e.tagName === "style").textContent;
  assert.match(css, new RegExp(`\\.wtn-lora-spin\\s*\\{[^}]*gap:\\s*${SPIN_GAP}px`));
});

test("BUG 16: the value<->spin gap (STR_CELL_GAP) is a DIFFERENT number and is untouched", () => {
  assert.equal(STR_CELL_GAP, 5, "the cell's value<->spin gap must not be conflated with the arrow<->arrow gap");
});

// =========================================================================
// I. BUG 14 (2026-07-30 owner report) -- a row-count change (Add/Duplicate/
// Remove) must apply the new node.size[1] SYNCHRONOUSLY, in the same turn
// as the state mutation -- never waiting on a later onDrawForeground/rAF
// tick, which is what let the DOM widget visibly overflow the node's own
// canvas-drawn border until something else (a mouse move) dirtied the
// canvas. Parametrised over [Array, Float64Array] like every other Class A
// test in this file (`.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`).
// =========================================================================

for (const SizeCtor of [Array, Float64Array]) {
  test(`BUG 14: '+ Add LoRA' applies the new node.size[1] SYNCHRONOUSLY -- no await, no rAF tick needed (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    const before = node._dirty;

    fire(node._lrRefs.addBtn, "click");

    // Read node.size[1] IMMEDIATELY, in the same synchronous call stack as
    // the click -- if this were only corrected on a later onDrawForeground/
    // rAF tick, this assertion would see the STALE (pre-add) height.
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(1), "the border must already match the new content height by the time this line runs");
    assert.ok(node._dirty > before, "must dirty the canvas in the same turn too, so the corrected border actually paints on the very next frame");
  });

  test(`BUG 14: row menu 'Duplicate' applies the new height synchronously too (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a.safetensors" })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    makeWindowStub(doc);
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    const entry = node._lrRows[0];

    fire(entry.refs.root, "contextmenu");
    const dup = findAllByClass(doc.body, "wtn-ctl-opt").find((o) => /Duplicate/.test(o.textContent));
    fire(dup, "click");

    assert.equal(ensureState(node, ctx).rows.length, 2);
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(2));
  });

  test(`BUG 14: row menu 'Remove' applies the SHRUNK height synchronously (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    makeWindowStub(doc);
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    const entry = node._lrRows[0];

    fire(entry.refs.root, "contextmenu");
    const del = findAllByClass(doc.body, "wtn-ctl-opt").find((o) => /Remove/.test(o.textContent));
    fire(del, "click");

    assert.equal(ensureState(node, ctx).rows.length, 1);
    assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(1));
  });

  test(`BUG 14: the height LOCK (getMinHeight === getMaxHeight) reports the new content height immediately after a row-count change (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    const widget = node._lrWidget;
    fire(node._lrRefs.addBtn, "click");
    fire(node._lrRefs.addBtn, "click");
    // Both getters are LIVE closures (re-read `rowCountOf` on every call) --
    // this pins that contract so a future change can't silently cache a
    // stale value and re-pin the node to the OLD height (BUG 14's own
    // warning: "a fix that repaints promptly but re-pins the stale height
    // is worse than the current bug").
    assert.equal(widget.options.getMinHeight(), contentHeight(2));
    assert.equal(widget.options.getMaxHeight(), contentHeight(2));
    assert.equal(widget.options.getMinHeight(), widget.options.getMaxHeight());
  });

  test(`BUG 14: reordering (row count UNCHANGED) leaves node.size[1] exactly as it was -- the synchronous apply must not fight the FLIP animation (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "a" }), mkStateRow({ id: 2, name: "b" })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const win = makeWindowStub(doc);
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    const before = node.size[1];
    const draggedEntry = node._lrRows[0];
    fire(draggedEntry.refs.grip, "pointerdown", { clientY: 0 });
    fireWin(win, "pointermove", { clientY: (ROW_H + ROW_GAP) + 1 });
    assert.equal(node.size[1], before, "row count didn't change -- the synchronous apply must be a no-op here");
    fireWin(win, "pointerup");
  });

  test(`BUG 14: syncRows' own synchronous height write bails during a restore in flight (node._lrConfiguring) -- pinned directly, not just through setupLoraNode (size ctor: ${SizeCtor.name})`, () => {
    const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]), { sizeCtor: SizeCtor });
    const doc = makeDocStub();
    const ctx = makeCtx(doc);
    mountLoraNode(node, ctx);
    node.size[0] = 777;
    node.size[1] = 12345; // a deliberately wrong value a concurrent restore might be about to overwrite
    node._lrConfiguring = true;
    const state = ensureState(node, ctx);
    addStateRow(state); // row count DOES change here
    syncRows(node, ctx);
    assert.equal(node.size[1], 12345, "must NOT stamp a synchronous height over a size a restore may still be setting");
  });
}

// =========================================================================
// Lifecycle -- setupLoraNode / restoreLoraNode, idempotency, teardown
// =========================================================================

test("setupLoraNode: idempotent (a second call does not re-mount/re-wire)", () => {
  const node = makeFakeNode(stateJSON([]));
  const ctx = makeCtx(makeDocStub());
  setupLoraNode(node, ctx);
  const refsFirst = node._lrRefs;
  setupLoraNode(node, ctx);
  assert.equal(node._lrRefs, refsFirst);
});

test("setupLoraNode: a fresh node gets floored to DEFAULT_W x content height", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 }), mkStateRow({ id: 2 })]));
  node.size = undefined;
  const ctx = makeCtx(makeDocStub());
  setupLoraNode(node, ctx);
  assert.equal(node.size[0], DEFAULT_W);
  assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(2));
});

test("setupLoraNode: skips the floor entirely while node._lrConfiguring is true (a restore in flight)", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1 })]));
  node._lrConfiguring = true;
  node.size = [999, 999];
  const ctx = makeCtx(makeDocStub());
  setupLoraNode(node, ctx);
  assert.deepEqual(node.size, [999, 999], "must trust a size a concurrent restore may be about to apply");
});

test("restoreLoraNode: force-reparses the widget and applies content height, leaving width untouched", () => {
  const node = makeFakeNode(stateJSON([mkStateRow({ id: 1, name: "saved.safetensors" })]));
  const ctx = makeCtx(makeDocStub());
  setupLoraNode(node, ctx); // onNodeCreated always runs first, per the real litegraph sequence
  node.size[0] = 777; // simulate litegraph having just restored a saved width
  node.size[1] = 1; // and a stale/inconsistent saved height
  restoreLoraNode(node, ctx);
  assert.equal(node.size[0], 777, "restore must never touch width");
  assert.equal(node.size[1], WIDGETS_START_Y + contentHeight(1));
  assert.equal(ensureState(node, ctx).rows[0].name, "saved.safetensors");
});

test("teardownLoraNode: uninstalls the wheel-zoom passthrough without throwing when nothing was ever mounted", () => {
  const node = makeFakeNode(stateJSON([]));
  assert.doesNotThrow(() => teardownLoraNode(node));
  const ctx = makeCtx(makeDocStub());
  mountLoraNode(node, ctx);
  assert.doesNotThrow(() => teardownLoraNode(node));
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
