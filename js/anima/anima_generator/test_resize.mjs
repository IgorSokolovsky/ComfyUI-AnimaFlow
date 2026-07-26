/**
 * test_resize.mjs — regression tests for the AnimaGenerator sectioned-panel
 * frontend:
 *
 *   A. `core.mjs` pure card-layout model — the widget->card mapping is
 *      COMPLETE (every one of AnimaGenerator's real widgets is claimed by
 *      exactly one card, no duplicates, `positive_text`/`negative_text`
 *      excluded), the upscale-backend field filtering returns only the
 *      selected backend's fields, widget-kind classification + numeric
 *      coercion + label prettifying are all correct. There is no UI-only
 *      collapse-state property anymore (removed this build -- see the
 *      report): `enabledWidget` alone drives open/closed.
 *   B. `render.mjs` DOM behavior — card shells (no collapse button on ANY
 *      card; an Enabled checkbox only on optional cards), field-row
 *      construction per kind (missing/boolean/combo/number/text),
 *      full-rebuild `renderCardFields`, `setCardEnabledUI` opening/closing a
 *      card's body, the `.wtn-ag-card` CSS getting `flex-shrink: 0` (the fix
 *      for the "cards clipped mid-row" bug), and the resize mechanism
 *      (mirrors `js/anima_prompt/anima_prompt_studio/test_resize.mjs`'s copy of
 *      the same ComfyUI-Pixaroma find_replace mechanism).
 *   C. `interaction.mjs` — hiding a widget sets `hidden`/`computeSize` but
 *      NEVER `serialize = false` (the regression that would silently break
 *      saved workflows), a widget named in the layout but absent at runtime
 *      is skipped without throwing (and logged exactly once),
 *      `repositionDomWidget` moves the panel above the native textareas,
 *      and the STRUCTURAL-vs-VALUE refit gating that is this build's core
 *      requirement: toggling a stage's Enabled checkbox (which now ALSO
 *      opens/closes that card) and an upscale-backend switch each schedule
 *      exactly one refit; a slider/number/other-combo/text value change
 *      never does. Always-on cards (SAMPLER, PREVIEW) expose no collapse
 *      control and no Enabled checkbox at all, and their bodies are always
 *      visible.
 *   D. `index.js` source-level assertions (same reason as
 *      `js/anima_prompt/anima_prompt_studio/test_resize.mjs`: `app` resolves only inside a
 *      real ComfyUI/browser host) — absolute import, widget-hiding call,
 *      legacy + Nodes 2.0 sizing wiring, the guarded initial fit vs.
 *      unconditional refit split, and that `restoreNode` never resizes.
 *   E. `measureMinHeight`/`computeLayoutSize` never read `node.size` (no
 *      feedback loop) — asserted both behaviorally (call with no `node`
 *      argument at all) and via a source-level check of the function body.
 *   F. External-mutation resync (the gap this build's follow-up fix closes)
 *      — `render.mjs`'s `updateFieldRowValue` and `interaction.mjs`'s
 *      `refreshFieldValues`/`resyncAllFromWidgets`: a widget value changed
 *      PROGRAMMATICALLY (e.g. `seed` after ComfyUI's own
 *      `control_after_generate`) is picked up by a fresh resync WITHOUT
 *      rebuilding any DOM and WITHOUT calling `scheduleRefit` for a plain
 *      value change; a control the user currently has focused is left alone
 *      even while a resync fires; `resyncAllFromWidgets` degrades to a no-op
 *      (never throws) for nodes with no mounted panel or a broken `refs`
 *      shape, and keeps going for the REST of the nodes if one throws. An
 *      externally-changed `*_enabled` value DOES open/close that card and
 *      schedule exactly one refit for the whole resync pass -- but only when
 *      it actually differs from what's currently displayed, never on an
 *      unrelated resync where nothing changed.
 *
 * Run directly: `node js/anima/anima_generator/test_resize.mjs` (plain
 * script, no test framework — matches the project's `python
 * tests/test_x.py` convention).
 *
 * MANUAL-IN-COMFYUI CHECKLIST (cannot be confirmed by this headless harness
 * — the real `addDOMWidget`/LiteGraph runtime contract only exists live):
 *   [ ] The node renders 7 cards (Sampler, Highres Fix, Detailer, Upscale,
 *       Postprocess, Save, Preview) instead of a flat widget stack;
 *       `positive_text`/`negative_text` render natively below the panel.
 *   [ ] No card's body is clipped mid-row regardless of how short the node
 *       is dragged/loaded (the flex-shrink fix) -- SAMPLER/HIGHRES/
 *       DETAILER/UPSCALE all show their FULL body, never sliced.
 *   [ ] Every number field shows a number box + a slider, both live-synced;
 *       dragging a slider does NOT resize the node.
 *   [ ] SAMPLER and PREVIEW (the two always-on cards) show a plain header
 *       (title only, no chevron, no Enabled checkbox) and their body is
 *       always visible.
 *   [ ] HIGHRES/DETAILER/UPSCALE/POSTPROCESS/SAVE show a header with an
 *       Enabled checkbox and NO separate chevron; unchecking it collapses
 *       the card to just that header row, checking it expands the body --
 *       toggling it resizes the node (grow or shrink to fit).
 *   [ ] Switching the Upscale backend combo resizes the node; a plain value
 *       edit (typing a number, dragging a slider, picking a non-backend
 *       combo option) never does.
 *   [ ] `control_after_generate` is absent from the SAMPLER card (this
 *       node's `seed` widget doesn't declare `control_after_generate:
 *       True`) and shows the "(unavailable)" placeholder instead of
 *       throwing or blanking the node -- confirm exactly one console
 *       warning for it, not one per re-render.
 *   [ ] Tag autocomplete (`js/autocomplete`) still attaches to
 *       `positive_text`/`negative_text` by widget name.
 *   [ ] Saving a workflow with some optional stages enabled and some
 *       disabled, then reloading the page, restores the same open/closed
 *       state (derived from each `*_enabled` value) and every field's
 *       value, at the saved node size (no auto-resize-on-reload).
 *   [ ] Queueing the node still runs `generate()` correctly (every hidden
 *       widget's value still reaches Python via the normal
 *       `widgets_values` path -- nothing about this build changes
 *       execution semantics).
 *   [ ] Set `seed`'s auto-injected `control_after_generate` to "randomize",
 *       queue a run, and watch the panel's Seed field update to the NEW
 *       value once the run finishes -- no reload/undo needed, and it must
 *       not happen while you're mid-typing in a DIFFERENT field on the same
 *       node (that field's edit must survive).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CARD_DEFS,
  DEFAULT_UPSCALE_BACKEND,
  UPSCALE_BACKEND_FIELDS,
  getUpscaleBackendFields,
  getCardFieldNames,
  getCardAllPossibleFieldNames,
  getAllLayoutWidgetNames,
  widgetKind,
  coerceNumberValue,
  prettyFieldLabel,
  partitionFieldsByPresence,
} from "./core.mjs";

import {
  buildRoot,
  buildCardShell,
  buildFieldRow,
  renderCardFields,
  updateFieldRowValue,
  setCardEnabledUI,
  measureMinHeight,
  setNodeHeight,
  refitNode,
  scheduleRefit,
  scheduleInitialFit,
  computeSizeFloor,
  clampNodeSize,
  createResizeClampHandler,
  CHROME,
  DEFAULT_W,
  DEFAULT_H,
  WIDTH_MIN,
} from "./render.mjs";

import {
  findWidget,
  hideWidget,
  hideLayoutWidgets,
  getUpscaleBackendValue,
  logMissingOnce,
  resetLoggedMissing,
  repositionDomWidget,
  renderCard,
  mountAllCards,
  refreshAllCards,
  refreshFieldValues,
  resyncAllFromWidgets,
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

// ---- Stubbed requestAnimationFrame ------------------------------------

let rafQueue = [];
globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
function flushRAF() {
  const pending = rafQueue;
  rafQueue = [];
  pending.forEach((cb) => cb());
}
function resetRAF() {
  rafQueue = [];
}

globalThis.getComputedStyle = (el) => (el && el.style) || {};

// ---- Minimal DOM stub (mirrors js/anima_prompt/anima_prompt_studio/test_resize.mjs's) ---

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
      checked: false,
      textContent: "",
      innerHTML: "",
      title: "",
      disabled: false,
      hidden: false,
      parentNode: null,
      get ownerDocument() {
        return doc;
      },
      classList: {
        _set: new Set(),
        add(c) {
          this._set.add(c);
        },
        remove(c) {
          this._set.delete(c);
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
      getAttribute(name) {
        return el.attributes[name];
      },
      addEventListener(type, fn) {
        (el._listeners[type] = el._listeners[type] || []).push(fn);
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
      focus() {},
    };
    Object.defineProperty(el, "className", {
      get() {
        return el._className || "";
      },
      set(v) {
        el._className = v;
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
    createTextNode(text) {
      return { nodeType: 3, textContent: text, parentNode: null };
    },
    getElementById() {
      return null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
    // Plain mutable stand-in for the real DOM's `document.activeElement` --
    // tests simulate "the user is currently focused in this control" by
    // setting `refs.doc.activeElement = someInputEl` directly (this stub's
    // elements' `focus()` is a no-op, so nothing does this automatically).
    activeElement: null,
  };
  return doc;
}

function fire(el, type) {
  (el._listeners[type] || []).forEach((fn) => fn());
}

function makeFakeNode(initialSize, widgets) {
  const setSizeCalls = [];
  const node = {
    size: initialSize.slice(),
    properties: {},
    widgets: widgets || [],
    setSize(size) {
      setSizeCalls.push(size.slice());
      node.size = size.slice();
    },
    setDirtyCanvas() {},
  };
  return { node, setSizeCalls };
}

function makeWidget(name, value, options) {
  return { name, value, options: options || {} };
}

// =========================================================================
// A. core.mjs — widget->card mapping completeness + backend filtering
// =========================================================================

// Hand-mirrored 1:1 from `nodes/anima/node_anima_generator.py`'s INPUT_TYPES
// (every REQUIRED widget, i.e. excluding the `model`/`vae` sockets, which
// aren't widgets at all) -- kept in sync by hand, same convention as
// render.mjs's TOKENS mirror of js/shared/theme.mjs.
const REAL_ANIMA_GENERATOR_WIDGET_NAMES = [
  "shift",
  "seed",
  "steps",
  "cfg",
  "sampler_name",
  "scheduler",
  "denoise",
  "width",
  "height",
  "highres_enabled",
  "highres_scale_by",
  "highres_multiple",
  "highres_max_long_edge",
  "highres_denoise",
  "preview_channel",
  "detailer_enabled",
  "detailer_guide_size",
  "detailer_max_size",
  "detailer_denoise",
  "upscale_enabled",
  "upscale_backend",
  "upscale_usdu_model_name",
  "upscale_usdu_scale_by",
  "upscale_usdu_tile_size",
  "upscale_usdu_denoise",
  "upscale_resshift_scale",
  "upscale_resshift_chop",
  "upscale_resshift_overlap",
  "upscale_resshift_tile_batch",
  "postprocess_resize_enabled",
  "postprocess_multiple",
  "save_output",
  "save_prefix",
  // Appended in the USDU seam-fix + tile-control port (docs/backlog.md
  // §2.3) — declared LAST in Python's INPUT_TYPES (append-only), listed
  // here in that same declaration order for easy hand-sync, independent of
  // core.mjs's own (purely presentational) UPSCALE_BACKEND_FIELDS.usdu order.
  "upscale_usdu_seam_fix_mode",
  "upscale_usdu_seam_fix_denoise",
  "upscale_usdu_seam_fix_width",
  "upscale_usdu_seam_fix_mask_blur",
  "upscale_usdu_seam_fix_padding",
  "upscale_usdu_mask_blur",
  "upscale_usdu_tile_padding",
  "upscale_usdu_mode_type",
  "upscale_usdu_auto_tile",
];

test("CARD_DEFS has the 7 expected cards in order", () => {
  assert.deepEqual(
    CARD_DEFS.map((c) => c.id),
    ["sampler", "highres", "detailer", "upscale", "postprocess", "save", "preview"],
  );
});

test("getAllLayoutWidgetNames has no duplicates", () => {
  const names = getAllLayoutWidgetNames();
  assert.equal(names.length, new Set(names).size, "duplicate widget name across cards");
});

test("getAllLayoutWidgetNames covers every real AnimaGenerator widget exactly once, plus control_after_generate", () => {
  const names = new Set(getAllLayoutWidgetNames());
  for (const real of REAL_ANIMA_GENERATOR_WIDGET_NAMES) {
    assert.ok(names.has(real), `missing widget "${real}" from the layout`);
  }
  assert.ok(names.has("control_after_generate"), "control_after_generate must still be in the layout (see core.mjs doc comment)");
  assert.equal(names.size, REAL_ANIMA_GENERATOR_WIDGET_NAMES.length + 1);
});

test("getAllLayoutWidgetNames excludes positive_text/negative_text (kept native)", () => {
  const names = new Set(getAllLayoutWidgetNames());
  assert.ok(!names.has("positive_text"));
  assert.ok(!names.has("negative_text"));
});

test("getUpscaleBackendFields returns only the requested backend's fields", () => {
  assert.deepEqual(getUpscaleBackendFields("usdu"), UPSCALE_BACKEND_FIELDS.usdu);
  assert.deepEqual(getUpscaleBackendFields("resshift"), UPSCALE_BACKEND_FIELDS.resshift);
});

test("getUpscaleBackendFields falls back to the default backend for an unrecognized value", () => {
  assert.deepEqual(getUpscaleBackendFields("nope"), UPSCALE_BACKEND_FIELDS[DEFAULT_UPSCALE_BACKEND]);
  assert.deepEqual(getUpscaleBackendFields(undefined), UPSCALE_BACKEND_FIELDS[DEFAULT_UPSCALE_BACKEND]);
});

test("getCardFieldNames on the upscale card returns ONLY the selected backend's fields, not both", () => {
  const upscaleCard = CARD_DEFS.find((c) => c.id === "upscale");
  const usduFields = getCardFieldNames(upscaleCard, "usdu");
  const resshiftFields = getCardFieldNames(upscaleCard, "resshift");

  assert.deepEqual(usduFields, ["upscale_backend", ...UPSCALE_BACKEND_FIELDS.usdu]);
  assert.deepEqual(resshiftFields, ["upscale_backend", ...UPSCALE_BACKEND_FIELDS.resshift]);
  UPSCALE_BACKEND_FIELDS.resshift.forEach((f) => assert.ok(!usduFields.includes(f), `${f} leaked into usdu view`));
  UPSCALE_BACKEND_FIELDS.usdu.forEach((f) => assert.ok(!resshiftFields.includes(f), `${f} leaked into resshift view`));
});

test("getCardFieldNames on a non-upscale card ignores the backend argument entirely", () => {
  const highresCard = CARD_DEFS.find((c) => c.id === "highres");
  assert.deepEqual(getCardFieldNames(highresCard, "resshift"), highresCard.fields.slice());
});

test("getCardAllPossibleFieldNames on the upscale card unions both backend variants", () => {
  const upscaleCard = CARD_DEFS.find((c) => c.id === "upscale");
  const all = getCardAllPossibleFieldNames(upscaleCard);
  assert.deepEqual(all, ["upscale_backend", ...UPSCALE_BACKEND_FIELDS.usdu, ...UPSCALE_BACKEND_FIELDS.resshift]);
});

test("widgetKind classifies combo/boolean/number/text/missing correctly", () => {
  assert.equal(widgetKind(null), "missing");
  assert.equal(widgetKind(makeWidget("x", true)), "boolean");
  assert.equal(widgetKind(makeWidget("x", "usdu", { values: ["usdu", "resshift"] })), "combo");
  assert.equal(widgetKind(makeWidget("x", 5, { min: 0, max: 10, step: 1 })), "number");
  assert.equal(widgetKind(makeWidget("x", "hello")), "text");
});

test("coerceNumberValue clamps to min/max", () => {
  const w = makeWidget("x", 5, { min: 0, max: 10 });
  assert.equal(coerceNumberValue(w, 999), 10);
  assert.equal(coerceNumberValue(w, -5), 0);
  assert.equal(coerceNumberValue(w, 4), 4);
});

test("coerceNumberValue rounds to an integer when options.precision is 0", () => {
  const w = makeWidget("x", 5, { min: 0, max: 100, precision: 0 });
  assert.equal(coerceNumberValue(w, 4.7), 5);
});

test("coerceNumberValue falls back to the widget's current value for a non-finite input", () => {
  const w = makeWidget("x", 7, { min: 0, max: 100 });
  assert.equal(coerceNumberValue(w, "not a number"), 7);
  assert.equal(coerceNumberValue(w, undefined), 7);
});

test("prettyFieldLabel strips the card-scoped prefix and title-cases the rest", () => {
  assert.equal(prettyFieldLabel("highres_scale_by"), "Scale By");
  assert.equal(prettyFieldLabel("upscale_usdu_tile_size"), "Tile Size");
  assert.equal(prettyFieldLabel("upscale_resshift_chop"), "Chop");
  assert.equal(prettyFieldLabel("upscale_backend"), "Backend");
  assert.equal(prettyFieldLabel("seed"), "Seed");
  assert.equal(prettyFieldLabel("control_after_generate"), "Control After Generate");
});

test("partitionFieldsByPresence splits present vs missing", () => {
  const { present, missing } = partitionFieldsByPresence(
    ["seed", "control_after_generate", "steps"],
    ["seed", "steps"],
  );
  assert.deepEqual(present, ["seed", "steps"]);
  assert.deepEqual(missing, ["control_after_generate"]);
});

test("CARD_DEFS' enabledWidget is null for exactly the two always-on cards (sampler, preview)", () => {
  const alwaysOn = CARD_DEFS.filter((c) => c.enabledWidget === null).map((c) => c.id);
  const optional = CARD_DEFS.filter((c) => c.enabledWidget).map((c) => c.id);
  assert.deepEqual(alwaysOn, ["sampler", "preview"]);
  assert.deepEqual(optional, ["highres", "detailer", "upscale", "postprocess", "save"]);
});

// =========================================================================
// B. render.mjs — DOM behavior
// =========================================================================

test("buildRoot builds one card shell per CARD_DEFS entry, in order", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc, CARD_DEFS);
  assert.equal(refs.root.children.length, CARD_DEFS.length);
  CARD_DEFS.forEach((c) => assert.ok(refs.cards[c.id], `missing shell for ${c.id}`));
});

test("buildCardShell only creates an Enabled checkbox for cards with an enabledWidget", () => {
  const doc = makeDocStub();
  const samplerShell = buildCardShell(doc, CARD_DEFS.find((c) => c.id === "sampler"));
  const highresShell = buildCardShell(doc, CARD_DEFS.find((c) => c.id === "highres"));
  assert.equal(samplerShell.enabledCheckbox, null);
  assert.ok(highresShell.enabledCheckbox);
});

test("buildCardShell never creates a collapse button/chevron for ANY card -- Enabled is the only open/closed control an optional card gets, and an always-on card gets no control at all", () => {
  const doc = makeDocStub();
  CARD_DEFS.forEach((cardDef) => {
    const shell = buildCardShell(doc, cardDef);
    assert.equal(shell.collapseBtn, undefined, `${cardDef.id} must not have a collapseBtn ref`);
    // The header (hd) must contain ONLY the title + spacer for an always-on
    // card, or title + spacer + the Enabled <label> for an optional one --
    // never a third/fourth element that could be a leftover chevron button.
    const expectedHeaderChildren = cardDef.enabledWidget ? 3 : 2;
    assert.equal(
      shell.hd.children.length,
      expectedHeaderChildren,
      `${cardDef.id} header should have exactly ${expectedHeaderChildren} children (title, spacer${cardDef.enabledWidget ? ", Enabled label" : ""})`,
    );
  });
});

test("always-on cards (sampler, preview) have no enabledCheckbox and their body is never hidden by setCardEnabledUI (it is simply never called for them)", () => {
  const doc = makeDocStub();
  ["sampler", "preview"].forEach((id) => {
    const shell = buildCardShell(doc, CARD_DEFS.find((c) => c.id === id));
    assert.equal(shell.enabledCheckbox, null, `${id} must not have an Enabled checkbox`);
    assert.equal(shell.bodyEl.hidden, false, `${id}'s body must start visible`);
  });
});

test("buildFieldRow renders an '(unavailable)' placeholder for a missing widget, never throws", () => {
  const doc = makeDocStub();
  const rowRefs = buildFieldRow(doc, "control_after_generate", null, () => {
    throw new Error("onChange must never fire for a missing widget");
  });
  assert.equal(rowRefs.kind, "missing");
  assert.match(rowRefs.row.children[1].children[0].textContent, /unavailable/);
});

test("buildFieldRow (boolean) mirrors the widget's initial value and calls onChange on toggle", () => {
  const doc = makeDocStub();
  const widget = makeWidget("highres_enabled", false, { tooltip: "toggle it" });
  let seen = null;
  const rowRefs = buildFieldRow(doc, "highres_enabled", widget, (v) => (seen = v));
  assert.equal(rowRefs.input.checked, false);
  assert.equal(rowRefs.input.title, "toggle it");
  rowRefs.input.checked = true;
  fire(rowRefs.input, "change");
  assert.equal(seen, true);
});

test("buildFieldRow (combo) populates <option>s from widget.options.values and calls onChange with the picked value", () => {
  const doc = makeDocStub();
  const widget = makeWidget("upscale_backend", "usdu", { values: ["usdu", "resshift"], tooltip: "pick one" });
  let seen = null;
  const rowRefs = buildFieldRow(doc, "upscale_backend", widget, (v) => (seen = v));
  assert.equal(rowRefs.input.children.length, 2);
  assert.equal(rowRefs.input.value, "usdu");
  rowRefs.input.value = "resshift";
  fire(rowRefs.input, "change");
  assert.equal(seen, "resshift");
});

test("buildFieldRow (number) builds a synced number+range pair and coerces via the widget's own min/max", () => {
  const doc = makeDocStub();
  const widget = makeWidget("cfg", 5, { min: 0, max: 100, step: 0.1, tooltip: "cfg scale" });
  let seen = null;
  const rowRefs = buildFieldRow(doc, "cfg", widget, (v) => (seen = v));
  assert.equal(rowRefs.input.value, "5");
  assert.equal(rowRefs.range.value, "5");

  rowRefs.input.value = "999";
  fire(rowRefs.input, "input");
  assert.equal(seen, 100, "clamped to max");
  assert.equal(rowRefs.range.value, "100", "slider stays synced with the number box");

  rowRefs.range.value = "-50";
  fire(rowRefs.range, "input");
  assert.equal(seen, 0, "clamped to min");
  assert.equal(rowRefs.input.value, "0", "number box stays synced with the slider");
});

test("buildFieldRow (text) mirrors the widget's string value and calls onChange on input", () => {
  const doc = makeDocStub();
  const widget = makeWidget("save_prefix", "Anima", { tooltip: "prefix" });
  let seen = null;
  const rowRefs = buildFieldRow(doc, "save_prefix", widget, (v) => (seen = v));
  assert.equal(rowRefs.input.value, "Anima");
  rowRefs.input.value = "Webtoon";
  fire(rowRefs.input, "input");
  assert.equal(seen, "Webtoon");
});

test("renderCardFields fully rebuilds the body (old rows removed) and preserves field order", () => {
  const doc = makeDocStub();
  const bodyEl = doc.createElement("div");
  const widgets = { seed: makeWidget("seed", 1, { min: 0, max: 100 }), steps: makeWidget("steps", 20, { min: 1, max: 100 }) };
  renderCardFields(doc, bodyEl, ["seed", "steps"], (n) => widgets[n], () => {}, () => {});
  assert.equal(bodyEl.children.length, 2);

  renderCardFields(doc, bodyEl, ["steps"], (n) => widgets[n], () => {}, () => {});
  assert.equal(bodyEl.children.length, 1, "stale row from the previous render must be gone");
});

test("setCardEnabledUI HIDES the body when disabled (collapsed to just the header row) and shows it when enabled, syncing the checkbox both ways", () => {
  const doc = makeDocStub();
  const shell = buildCardShell(doc, CARD_DEFS.find((c) => c.id === "highres"));
  setCardEnabledUI(shell, false);
  assert.equal(shell.bodyEl.hidden, true, "unchecked Enabled must collapse the body to just the header");
  assert.equal(shell.enabledCheckbox.checked, false);
  setCardEnabledUI(shell, true);
  assert.equal(shell.bodyEl.hidden, false, "checked Enabled must expand the body");
  assert.equal(shell.enabledCheckbox.checked, true);
});

test("setCardEnabledUI is a no-op (never throws) for a falsy shellRefs", () => {
  assert.doesNotThrow(() => setCardEnabledUI(null, true));
  assert.doesNotThrow(() => setCardEnabledUI(undefined, false));
});

test("measureMinHeight returns the floor for a missing root", () => {
  assert.equal(measureMinHeight(null), 220);
});

test("measureMinHeight sums visible children + gap + padding, floors at 220, rounds to 4px", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  root.style.rowGap = "10px";
  root.style.paddingTop = "3px";
  root.style.paddingBottom = "3px";
  const a = doc.createElement("div");
  a.offsetHeight = 100;
  a.offsetParent = {};
  const b = doc.createElement("div");
  b.offsetHeight = 100;
  b.offsetParent = {};
  root.appendChild(a);
  root.appendChild(b);
  assert.equal(measureMinHeight(root), 220);
});

test("measureMinHeight skips children whose offsetParent is null", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const visible = doc.createElement("div");
  visible.offsetHeight = 300;
  visible.offsetParent = {};
  const hidden = doc.createElement("div");
  hidden.offsetHeight = 9999;
  hidden.offsetParent = null;
  root.appendChild(visible);
  root.appendChild(hidden);
  assert.equal(measureMinHeight(root), 300);
});

test("measureMinHeight sums each child's FULL offsetHeight even when the root's own (container) height is set much shorter -- the clipping bug's 'under-report' half, ruled out", () => {
  // measureMinHeight never reads the root's own height/size at all -- it
  // only sums children's offsetHeight. In a real browser this is exactly
  // why the .wtn-ag-card flex-shrink:0 fix (see the CSS source-level test
  // below) is sufficient on its own: a card that CANNOT be compressed by
  // its column-flex container always reports its true, uncompressed
  // offsetHeight here, regardless of how short the DOM-widget container
  // currently is -- so refitNode can never under-measure and get stuck in
  // a "too small to ever grow" feedback loop.
  const doc = makeDocStub();
  const root = doc.createElement("div");
  root.style.height = "10px"; // simulate a much-too-short DOM-widget container
  const cardA = doc.createElement("div");
  cardA.offsetHeight = 400; // a card's full, uncompressed height
  cardA.offsetParent = {};
  const cardB = doc.createElement("div");
  cardB.offsetHeight = 300;
  cardB.offsetParent = {};
  root.appendChild(cardA);
  root.appendChild(cardB);
  assert.equal(
    measureMinHeight(root),
    700,
    "must read children's full offsetHeight -- never scaled down by the container's own (short) height",
  );
});

test("render.mjs's .wtn-ag-card CSS rule sets flex-shrink: 0 (the fix for cards clipping mid-row under a short DOM-widget container)", () => {
  const renderSource = readFileSync(path.join(__dirname, "render.mjs"), "utf8");
  // NOT a naive `[^}]*` -- this file's CSS is a JS template literal, so a
  // `${TOKENS.x}` interpolation's own closing `}` (mid-line) would terminate
  // a `[^}]*` match early, before ever reaching flex-shrink. Every actual
  // CSS rule in this template literal closes with a `}` at the START of its
  // own line, so match up to the first "\n}" instead.
  const cardRuleMatch = renderSource.match(/\.wtn-ag-card \{[\s\S]*?\n\}/);
  assert.ok(cardRuleMatch, "could not find the .wtn-ag-card CSS rule in render.mjs");
  assert.match(
    cardRuleMatch[0],
    /flex-shrink:\s*0/,
    "the .wtn-ag-card rule must set flex-shrink: 0 so the column-flex root can never compress a card below its content height",
  );
});

test("render.mjs no longer emits the dead 'dim' collapse styling (wtn-ag-card-bd-dim) or a collapse-button rule -- Enabled hides/shows the body directly now", () => {
  const renderSource = readFileSync(path.join(__dirname, "render.mjs"), "utf8");
  assert.ok(!/wtn-ag-card-bd-dim/.test(renderSource), "dead dim class must be removed, not left unused");
  assert.ok(!/wtn-ag-collapse-btn/.test(renderSource), "dead collapse-button class must be removed, not left unused");
});

test("setNodeHeight sets height only, preserves width, records _agAutoH", () => {
  const { node, setSizeCalls } = makeFakeNode([460, 300], []);
  setNodeHeight(node, 700);
  assert.equal(node.size[0], 460);
  assert.equal(node.size[1], 700);
  assert.equal(node._agAutoH, 700);
  assert.deepEqual(setSizeCalls[0], [460, 700]);
});

test("refitNode grows the node when measured content + CHROME exceeds current height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 1200;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 300], []);

  refitNode(node, root);

  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  assert.ok(want > 300);
  assert.equal(setSizeCalls.length, 1);
  assert.equal(node.size[1], want);
});

test("refitNode does not shrink a node the user manually enlarged past the last auto-fit height", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 5;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 1200], []);
  node._agAutoH = 600;

  refitNode(node, root);

  assert.equal(setSizeCalls.length, 0);
});

test("scheduleRefit defers through requestAnimationFrame -- never resizes synchronously", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 300], []);

  scheduleRefit(node, root);
  assert.equal(setSizeCalls.length, 0);
  assert.equal(rafQueue.length, 1);
  flushRAF();
  assert.equal(setSizeCalls.length, 1);
});

test("scheduleInitialFit does not resize when node._agConfigured is true (loaded node keeps saved size)", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 260], []);
  node._agConfigured = true;

  scheduleInitialFit(node, root);
  flushRAF();

  assert.equal(setSizeCalls.length, 0);
  assert.equal(node.size[1], 260);
});

test("scheduleInitialFit DOES fit a genuinely fresh node", () => {
  resetRAF();
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 900;
  child.offsetParent = {};
  root.appendChild(child);
  const { node, setSizeCalls } = makeFakeNode([460, 100], []);

  scheduleInitialFit(node, root);
  flushRAF();

  assert.equal(setSizeCalls.length, 1);
});

// =========================================================================
// C. interaction.mjs — hide-and-mirror + structural-vs-value gating
// =========================================================================

test("hideWidget sets hidden + collapses computeSize, but NEVER sets serialize = false", () => {
  const widget = { name: "seed", value: 0, options: {}, inputEl: { style: {} } };
  hideWidget(widget);
  assert.equal(widget.hidden, true);
  assert.equal(typeof widget.computeSize, "function");
  assert.deepEqual(widget.computeSize(), [0, -4]);
  assert.equal(widget.inputEl.style.display, "none");
  assert.equal(
    Object.prototype.hasOwnProperty.call(widget, "serialize"),
    false,
    "hideWidget must never touch widget.serialize -- that would break saved workflows",
  );
});

test("hideLayoutWidgets hides every present layout widget and silently skips absent ones", () => {
  const seedWidget = makeWidget("seed", 0, {});
  const { node } = makeFakeNode([460, 560], [seedWidget]);
  // control_after_generate is intentionally absent (see core.mjs doc comment).
  hideLayoutWidgets(node, ["seed", "control_after_generate"]);
  assert.equal(seedWidget.hidden, true);
});

test("getUpscaleBackendValue defaults to usdu when the widget is missing", () => {
  const { node } = makeFakeNode([460, 560], []);
  assert.equal(getUpscaleBackendValue(node), "usdu");
});

test("getUpscaleBackendValue reads the live widget value when present", () => {
  const { node } = makeFakeNode([460, 560], [makeWidget("upscale_backend", "resshift", { values: ["usdu", "resshift"] })]);
  assert.equal(getUpscaleBackendValue(node), "resshift");
});

test("logMissingOnce warns exactly once per (card, widget) pair", () => {
  resetLoggedMissing();
  const calls = [];
  const originalWarn = console.warn;
  console.warn = (...args) => calls.push(args);
  try {
    logMissingOnce("sampler", "control_after_generate");
    logMissingOnce("sampler", "control_after_generate");
    logMissingOnce("sampler", "control_after_generate");
    logMissingOnce("highres", "control_after_generate");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.length, 2, "one warning per DISTINCT (card, name) pair, not per call");
});

test("renderCard skips a missing widget's row without throwing and logs once", () => {
  resetLoggedMissing();
  const doc = makeDocStub();
  const refs = buildRoot(doc, CARD_DEFS);
  const seedWidget = makeWidget("seed", 0, { min: 0, max: 100 });
  // Deliberately no control_after_generate widget on this fake node.
  const widgets = [
    seedWidget,
    makeWidget("steps", 20, { min: 1, max: 100 }),
    makeWidget("cfg", 5, { min: 0, max: 100 }),
    makeWidget("sampler_name", "euler", { values: ["euler"] }),
    makeWidget("scheduler", "normal", { values: ["normal"] }),
    makeWidget("denoise", 1, { min: 0, max: 1 }),
    makeWidget("shift", 3, { min: 0, max: 10 }),
    makeWidget("width", 1024, { min: 64, max: 8192 }),
    makeWidget("height", 1024, { min: 64, max: 8192 }),
  ];
  const { node } = makeFakeNode([460, 560], widgets);
  assert.doesNotThrow(() => renderCard(node, refs, CARD_DEFS.find((c) => c.id === "sampler")));

  const samplerBody = refs.cards.sampler.bodyEl;
  assert.equal(samplerBody.children.length, 10, "one row per field, including the missing control_after_generate placeholder");
});

test("repositionDomWidget moves the DOM widget to just before positive_text/negative_text", () => {
  const positiveTextWidget = makeWidget("positive_text", "", {});
  const negativeTextWidget = makeWidget("negative_text", "", {});
  const seedWidget = makeWidget("seed", 0, {});
  const domWidget = { name: "ag_panel" };
  const { node } = makeFakeNode(
    [460, 560],
    [seedWidget, positiveTextWidget, negativeTextWidget, domWidget], // addDOMWidget pushed it to the end
  );

  repositionDomWidget(node, domWidget);

  const names = node.widgets.map((w) => w.name);
  assert.deepEqual(names, ["seed", "ag_panel", "positive_text", "negative_text"]);
});

test("repositionDomWidget is a no-op if neither textarea widget exists", () => {
  const domWidget = { name: "ag_panel" };
  const { node } = makeFakeNode([460, 560], [makeWidget("seed", 0, {}), domWidget]);
  repositionDomWidget(node, domWidget);
  assert.deepEqual(node.widgets.map((w) => w.name), ["seed", "ag_panel"]);
});

function makeGeneratorFixture() {
  resetRAF();
  resetLoggedMissing();
  const doc = makeDocStub();
  const refs = buildRoot(doc, CARD_DEFS);
  const widgets = [
    makeWidget("seed", 0, { min: 0, max: 100 }),
    makeWidget("steps", 20, { min: 1, max: 100 }),
    makeWidget("cfg", 5, { min: 0, max: 100 }),
    makeWidget("sampler_name", "euler", { values: ["euler", "dpmpp_2m"] }),
    makeWidget("scheduler", "normal", { values: ["normal", "karras"] }),
    makeWidget("denoise", 1, { min: 0, max: 1 }),
    makeWidget("shift", 3, { min: 0, max: 10 }),
    makeWidget("width", 1024, { min: 64, max: 8192 }),
    makeWidget("height", 1024, { min: 64, max: 8192 }),
    makeWidget("highres_enabled", false, {}),
    makeWidget("highres_scale_by", 1.5, { min: 0.01, max: 8 }),
    makeWidget("highres_multiple", 64, { min: 1, max: 1024 }),
    makeWidget("highres_max_long_edge", 0, { min: 0, max: 16384 }),
    makeWidget("highres_denoise", 0.4, { min: 0, max: 1 }),
    makeWidget("detailer_enabled", false, {}),
    makeWidget("detailer_guide_size", 512, { min: 64, max: 8192 }),
    makeWidget("detailer_max_size", 1024, { min: 64, max: 8192 }),
    makeWidget("detailer_denoise", 0.5, { min: 0, max: 1 }),
    makeWidget("upscale_enabled", false, {}),
    makeWidget("upscale_backend", "usdu", { values: ["usdu", "resshift"] }),
    makeWidget("upscale_usdu_model_name", "model.pth", { values: ["model.pth"] }),
    makeWidget("upscale_usdu_scale_by", 2, { min: 1, max: 8 }),
    makeWidget("upscale_usdu_tile_size", 512, { min: 64, max: 4096 }),
    makeWidget("upscale_usdu_denoise", 0.2, { min: 0, max: 1 }),
    makeWidget("upscale_resshift_scale", "x2", {}),
    makeWidget("upscale_resshift_chop", 512, { min: 64, max: 4096 }),
    makeWidget("upscale_resshift_overlap", 64, { min: 0, max: 1024 }),
    makeWidget("upscale_resshift_tile_batch", 4, { min: 1, max: 64 }),
    makeWidget("postprocess_resize_enabled", false, {}),
    makeWidget("postprocess_multiple", 0, { min: 0, max: 1024 }),
    makeWidget("save_output", false, {}),
    makeWidget("save_prefix", "Anima", {}),
    makeWidget("preview_channel", "default", {}),
    // USDU seam-fix + tile-control port (docs/backlog.md §2.3).
    makeWidget("upscale_usdu_seam_fix_mode", "None", { values: ["None", "Band Pass", "Half Tile", "Half Tile + Intersections"] }),
    makeWidget("upscale_usdu_seam_fix_denoise", 1.0, { min: 0, max: 1, step: 0.001 }),
    makeWidget("upscale_usdu_seam_fix_width", 64, { min: 0, max: 4096 }),
    makeWidget("upscale_usdu_seam_fix_mask_blur", 8, { min: 0, max: 64 }),
    makeWidget("upscale_usdu_seam_fix_padding", 16, { min: 0, max: 512 }),
    makeWidget("upscale_usdu_mask_blur", 8, { min: 0, max: 64 }),
    makeWidget("upscale_usdu_tile_padding", 32, { min: 0, max: 512 }),
    makeWidget("upscale_usdu_mode_type", "Linear", { values: ["Linear", "Chess", "None"] }),
    makeWidget("upscale_usdu_auto_tile", true, {}),
  ];
  const { node, setSizeCalls } = makeFakeNode([460, 560], widgets);
  mountAllCards(node, refs);
  return { node, refs, setSizeCalls };
}

test("mountAllCards derives each optional card's initial open/closed state from its restored Enabled widget value; always-on cards are always visible", () => {
  const { refs } = makeGeneratorFixture();
  // Every `*_enabled` widget in this fixture defaults to false -- so every
  // OPTIONAL card must start collapsed (body hidden); the two always-on
  // cards (no enabledWidget at all -- sampler, preview) are always visible
  // regardless, since setCardEnabledUI is never even called for them.
  ["highres", "detailer", "upscale", "postprocess", "save"].forEach((id) => {
    assert.equal(refs.cards[id].bodyEl.hidden, true, `${id} must start collapsed (its *_enabled widget is false)`);
  });
  ["sampler", "preview"].forEach((id) => {
    assert.equal(refs.cards[id].bodyEl.hidden, false, `${id} (always-on) must always be visible`);
  });
  assert.equal(refs.cards.sampler.bodyEl.children.length, 10);
  assert.equal(refs.cards.upscale.bodyEl.children.length, 1 + UPSCALE_BACKEND_FIELDS.usdu.length);
});

test("mountAllCards opens an optional card whose restored Enabled widget is true", () => {
  resetRAF();
  resetLoggedMissing();
  const doc = makeDocStub();
  const refs = buildRoot(doc, CARD_DEFS);
  const widgets = [
    makeWidget("seed", 0, { min: 0, max: 100 }),
    makeWidget("highres_enabled", true, {}),
    makeWidget("highres_scale_by", 1.5, { min: 0.01, max: 8 }),
    makeWidget("highres_multiple", 64, { min: 1, max: 1024 }),
    makeWidget("highres_max_long_edge", 0, { min: 0, max: 16384 }),
    makeWidget("highres_denoise", 0.4, { min: 0, max: 1 }),
  ];
  const { node } = makeFakeNode([460, 560], widgets);
  mountAllCards(node, refs);
  assert.equal(refs.cards.highres.bodyEl.hidden, false, "a restored Enabled=true must open the card at mount, not just at edit time");
  assert.equal(refs.cards.highres.enabledCheckbox.checked, true);
});

test("checking a stage's Enabled checkbox OPENS that card and is STRUCTURAL: writes the native widget, schedules exactly one refit", () => {
  const { node, refs } = makeGeneratorFixture();
  const highresEnabledWidget = findWidget(node, "highres_enabled");
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "starts collapsed (fixture default)");
  resetRAF();

  refs.cards.highres.enabledCheckbox.checked = true;
  fire(refs.cards.highres.enabledCheckbox, "change");

  assert.equal(highresEnabledWidget.value, true, "the REAL native widget must be written, not a parallel object");
  assert.equal(refs.cards.highres.bodyEl.hidden, false, "checking Enabled must EXPAND the body");
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
});

test("unchecking a stage's Enabled checkbox COLLAPSES that card to just its header row and is STRUCTURAL: exactly one refit", () => {
  const { node, refs } = makeGeneratorFixture();
  // Open it first (the fixture defaults every *_enabled widget to false).
  refs.cards.highres.enabledCheckbox.checked = true;
  fire(refs.cards.highres.enabledCheckbox, "change");
  flushRAF();
  resetRAF();

  refs.cards.highres.enabledCheckbox.checked = false;
  fire(refs.cards.highres.enabledCheckbox, "change");

  assert.equal(findWidget(node, "highres_enabled").value, false);
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "unchecking Enabled must COLLAPSE the body to just the header row");
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled");
  flushRAF();
});

test("switching the upscale_backend combo is STRUCTURAL: rebuilds the card body to the new backend's fields, schedules exactly one refit", () => {
  const { node, refs } = makeGeneratorFixture();
  resetRAF();

  const upscaleShell = refs.cards.upscale;
  const backendSelect = upscaleShell.bodyEl.children[0].children[1].children[0]; // field -> control -> select
  backendSelect.value = "resshift";
  fire(backendSelect, "change");

  assert.equal(findWidget(node, "upscale_backend").value, "resshift");
  assert.equal(upscaleShell.bodyEl.children.length, 1 + UPSCALE_BACKEND_FIELDS.resshift.length);
  assert.equal(rafQueue.length, 1, "expected exactly one refit scheduled for the backend switch");
  flushRAF();
});

test("dragging a number field's slider (value edit) is NOT structural: writes the widget, no refit", () => {
  const { node, refs } = makeGeneratorFixture();
  resetRAF();

  const cfgRow = refs.cards.sampler.bodyEl.children[3]; // seed, control_after_generate, steps, cfg
  const range = cfgRow.children[1].children[0].children[1]; // field -> control -> num-wrap -> range
  range.value = "9";
  fire(range, "input");

  assert.equal(findWidget(node, "cfg").value, 9);
  assert.equal(rafQueue.length, 0, "a slider/number edit must never schedule a refit");
});

test("picking a non-backend combo option (value edit) is NOT structural: no refit", () => {
  const { node, refs } = makeGeneratorFixture();
  resetRAF();

  const samplerRow = refs.cards.sampler.bodyEl.children[4]; // seed, control_after_generate, steps, cfg, sampler_name
  const select = samplerRow.children[1].children[0];
  select.value = "dpmpp_2m";
  fire(select, "change");

  assert.equal(findWidget(node, "sampler_name").value, "dpmpp_2m");
  assert.equal(rafQueue.length, 0);
});

test("editing a text field (value edit) is NOT structural: no refit", () => {
  const { node, refs } = makeGeneratorFixture();
  resetRAF();

  const savePrefixRow = refs.cards.save.bodyEl.children[0];
  const input = savePrefixRow.children[1].children[0];
  input.value = "Webtoon";
  fire(input, "input");

  assert.equal(findWidget(node, "save_prefix").value, "Webtoon");
  assert.equal(rafQueue.length, 0);
});

test("a widget's callback is called (if present) after a value edit, so litegraph stays consistent", () => {
  const { node, refs } = makeGeneratorFixture();
  const stepsWidget = findWidget(node, "steps");
  let calledWith = null;
  stepsWidget.callback = (v) => (calledWith = v);

  const stepsRow = refs.cards.sampler.bodyEl.children[2]; // seed, control_after_generate, steps
  const numInput = stepsRow.children[1].children[0].children[0];
  numInput.value = "40";
  fire(numInput, "input");

  assert.equal(calledWith, 40);
});

test("refreshAllCards re-renders every card's fields from current widget values, derives open/closed from the restored Enabled value, and never schedules a refit", () => {
  const { node, refs } = makeGeneratorFixture();
  // Simulate onConfigure having restored a different value + a stage's
  // Enabled flag flipping true (the fixture defaults every *_enabled widget
  // to false, so "detailer" here starts collapsed).
  findWidget(node, "cfg").value = 12;
  findWidget(node, "detailer_enabled").value = true;
  resetRAF();

  refreshAllCards(node, refs);

  const cfgRow = refs.cards.sampler.bodyEl.children[3]; // seed, control_after_generate, steps, cfg
  const numInput = cfgRow.children[1].children[0].children[0];
  assert.equal(numInput.value, "12", "refreshAllCards must reflect the restored widget value");
  assert.equal(refs.cards.detailer.bodyEl.hidden, false, "refreshAllCards must open a card whose restored *_enabled value is true");
  assert.equal(refs.cards.detailer.enabledCheckbox.checked, true);
  assert.equal(rafQueue.length, 0, "restore must never schedule a refit -- trust the saved node.size");
});

// =========================================================================
// D. index.js — source-level assertions
// =========================================================================

const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
const indexCode = stripComments(indexSource);

test("index.js imports app from the absolute /scripts/app.js path", () => {
  assert.match(indexSource, /from\s+"\/scripts\/app\.js"/);
});

test("index.js hides every card-layout widget via hideLayoutWidgets before mounting the panel", () => {
  assert.match(indexCode, /hideLayoutWidgets\(node,\s*getAllLayoutWidgetNames\(\)\)/);
});

test("index.js creates the widget with the legacy getMinHeight option, backed by measureMinHeight", () => {
  assert.match(indexSource, /getMinHeight/);
  assert.match(indexSource, /measureMinHeight/);
  assert.ok(!/widget\.computeSize\s*=/.test(indexCode), "found a leftover widget.computeSize assignment");
  assert.ok(!/widget\.getHeight\s*=/.test(indexCode), "found a leftover widget.getHeight assignment");
});

test("index.js's widget.computeLayoutSize reports minWidth: 1 for the Nodes 2.0 renderer path", () => {
  assert.match(indexCode, /computeLayoutSize/);
  assert.match(indexCode, /minWidth:\s*1/);
});

test("index.js repositions the DOM widget above the native textareas", () => {
  assert.match(indexCode, /repositionDomWidget\(node,\s*widget\)/);
});

test("index.js schedules the guarded initial fit in setupNode, never scheduleRefit there", () => {
  const setupIdx = indexCode.indexOf("function setupNode");
  const setupBody = indexCode.slice(setupIdx, indexCode.indexOf("\n}", setupIdx));
  assert.match(setupBody, /scheduleInitialFit\(/);
  assert.ok(!/scheduleRefit\(/.test(setupBody), "setupNode must use the GUARDED initial fit, not scheduleRefit");
});

test("index.js's restoreNode never calls scheduleRefit or scheduleInitialFit", () => {
  const idx = indexCode.indexOf("function restoreNode");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.ok(!/scheduleRefit\(/.test(body));
  assert.ok(!/scheduleInitialFit\(/.test(body));
  assert.match(body, /refreshAllCards\(/);
});

test("index.js's onConfigure wrap sets _agConfigured = true BEFORE calling the original onConfigure or restoreNode", () => {
  const idx = indexCode.indexOf("nodeType.prototype.onConfigure = function");
  const body = indexCode.slice(idx, indexCode.indexOf("};", idx));
  const flagIdx = body.indexOf("_agConfigured = true");
  const origIdx = body.indexOf("originalOnConfigure.apply");
  const restoreIdx = body.indexOf("restoreNode(this)");
  assert.ok(flagIdx >= 0);
  assert.ok(origIdx > flagIdx);
  assert.ok(restoreIdx > flagIdx);
});

test("index.js's only serialize=false assignments are the DOM panel widget's own two (never a hidden native widget)", () => {
  const matches = indexCode.match(/serialize\s*=\s*false/g) || [];
  assert.equal(
    matches.length,
    2,
    "expected exactly the DOM panel widget's own `widget.serialize = false` + `widget.options.serialize = false`",
  );
});

// =========================================================================
// E. measureMinHeight / computeLayoutSize never read node.size (no
// feedback loop)
// =========================================================================

test("measureMinHeight's signature takes only `root` -- it cannot read node.size because it never receives node", () => {
  assert.equal(measureMinHeight.length, 1);
  // Behavioral proof: call it with a real root and confirm no `node` needs
  // to exist anywhere in scope for this call to work.
  const doc = makeDocStub();
  const root = doc.createElement("div");
  assert.equal(typeof measureMinHeight(root), "number");
});

test("render.mjs's measureMinHeight function body never references node.size", () => {
  const renderSource = readFileSync(path.join(__dirname, "render.mjs"), "utf8");
  const start = renderSource.indexOf("export function measureMinHeight");
  const end = renderSource.indexOf("\n}", start);
  const body = renderSource.slice(start, end);
  assert.ok(!/node\.size/.test(body), "measureMinHeight must never read node.size (no feedback loop)");
});

test("index.js's computeLayoutSize function body never references node.size", () => {
  const start = indexCode.indexOf("widget.computeLayoutSize = function");
  const end = indexCode.indexOf("};", start);
  const body = indexCode.slice(start, end);
  assert.ok(!/node\.size/.test(body), "computeLayoutSize must never read node.size (no feedback loop)");
});

// =========================================================================
// F. External-mutation resync (the gap this build's follow-up fix closes)
// =========================================================================

test("updateFieldRowValue (number) mirrors an externally-changed widget value into both the number box and its slider", () => {
  const doc = makeDocStub();
  const widget = makeWidget("cfg", 5, { min: 0, max: 100, step: 0.1 });
  const rowRefs = buildFieldRow(doc, "cfg", widget, () => {});
  widget.value = 42; // changed by something other than this row's own onChange
  updateFieldRowValue(rowRefs, widget, undefined);
  assert.equal(rowRefs.input.value, "42");
  assert.equal(rowRefs.range.value, "42");
});

test("updateFieldRowValue (number) skips BOTH the number box and slider if either is the active element", () => {
  const doc = makeDocStub();
  const widget = makeWidget("cfg", 5, { min: 0, max: 100, step: 0.1 });
  const rowRefs = buildFieldRow(doc, "cfg", widget, () => {});
  rowRefs.input.value = "12"; // simulate a partial in-progress edit
  widget.value = 42;

  updateFieldRowValue(rowRefs, widget, rowRefs.input);
  assert.equal(rowRefs.input.value, "12", "the focused number box must not be clobbered");
  assert.equal(rowRefs.range.value, "5", "its paired slider must not be desynced from it either");

  updateFieldRowValue(rowRefs, widget, rowRefs.range);
  assert.equal(rowRefs.input.value, "12", "still untouched while the SLIDER has focus instead");
});

test("updateFieldRowValue (text/combo/boolean) skips the control when it is the active element, applies otherwise", () => {
  const doc = makeDocStub();

  const textWidget = makeWidget("save_prefix", "Anima", {});
  const textRow = buildFieldRow(doc, "save_prefix", textWidget, () => {});
  textWidget.value = "Changed";
  updateFieldRowValue(textRow, textWidget, textRow.input);
  assert.equal(textRow.input.value, "Anima", "focused text control must not be clobbered");
  updateFieldRowValue(textRow, textWidget, undefined);
  assert.equal(textRow.input.value, "Changed");

  const comboWidget = makeWidget("upscale_backend", "usdu", { values: ["usdu", "resshift"] });
  const comboRow = buildFieldRow(doc, "upscale_backend", comboWidget, () => {});
  comboWidget.value = "resshift";
  updateFieldRowValue(comboRow, comboWidget, comboRow.input);
  assert.equal(comboRow.input.value, "usdu", "focused combo must not be clobbered");
  updateFieldRowValue(comboRow, comboWidget, undefined);
  assert.equal(comboRow.input.value, "resshift");

  const boolWidget = makeWidget("highres_enabled", false, {});
  const boolRow = buildFieldRow(doc, "highres_enabled", boolWidget, () => {});
  boolWidget.value = true;
  updateFieldRowValue(boolRow, boolWidget, boolRow.input);
  assert.equal(boolRow.input.checked, false, "focused checkbox must not be clobbered");
  updateFieldRowValue(boolRow, boolWidget, undefined);
  assert.equal(boolRow.input.checked, true);
});

test("updateFieldRowValue never throws for a missing row/widget (a 'missing' kind row has no control at all)", () => {
  assert.doesNotThrow(() => updateFieldRowValue(null, { value: 1 }, undefined));
  assert.doesNotThrow(() => updateFieldRowValue({ kind: "missing" }, undefined, undefined));
  const doc = makeDocStub();
  const missingRow = buildFieldRow(doc, "control_after_generate", null, () => {});
  assert.doesNotThrow(() => updateFieldRowValue(missingRow, { value: 1 }, undefined));
});

test("refreshFieldValues resyncs an externally-mutated widget's value into its rendered row, without rebuilding any DOM", () => {
  const { node, refs } = makeGeneratorFixture();
  const seedRow = refs.cards.sampler.bodyEl.children[0]; // seed, control_after_generate, steps, cfg...
  const seedNumInputBefore = seedRow.children[1].children[0].children[0];
  const seedRangeBefore = seedRow.children[1].children[0].children[1];

  // Simulate ComfyUI's own control_after_generate rewriting `seed` after a
  // queued run finishes -- entirely outside this panel's own edit path (the
  // concrete failure this build's fix targets).
  findWidget(node, "seed").value = 4242;

  refreshFieldValues(node, refs);

  assert.equal(seedNumInputBefore.value, "4242");
  assert.equal(seedRangeBefore.value, "4242");
  // Same row/element identities afterward -- proves no teardown/rebuild
  // happened (renderCardFields, which DOES rebuild, would replace every
  // child of bodyEl with brand-new elements).
  assert.equal(refs.cards.sampler.bodyEl.children[0], seedRow, "row element identity must be unchanged (no rebuild)");
  assert.equal(
    refs.cards.sampler.bodyEl.children[0].children[1].children[0].children[0],
    seedNumInputBefore,
    "number-box element identity must be unchanged (no rebuild)",
  );
});

test("refreshFieldValues never schedules a refit for a plain VALUE-only change (no *_enabled change) -- a value-only change can never affect layout", () => {
  const { node, refs } = makeGeneratorFixture();
  findWidget(node, "seed").value = 777;
  findWidget(node, "cfg").value = 11;
  resetRAF();

  refreshFieldValues(node, refs);

  assert.equal(rafQueue.length, 0, "refreshFieldValues must never call scheduleRefit for a value-only change");
});

test("refreshFieldValues opens/closes a card whose *_enabled widget was mutated externally, and schedules exactly ONE refit", () => {
  const { node, refs } = makeGeneratorFixture();
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "starts collapsed (fixture default: highres_enabled=false)");
  findWidget(node, "highres_enabled").value = true; // mutated externally, not via this panel's own checkbox
  resetRAF();

  refreshFieldValues(node, refs);

  assert.equal(refs.cards.highres.bodyEl.hidden, false, "an externally-flipped Enabled widget must open the card");
  assert.equal(refs.cards.highres.enabledCheckbox.checked, true);
  assert.equal(rafQueue.length, 1, "an actual open/close change is a structural consequence -- exactly one refit");
  flushRAF();
});

test("refreshFieldValues coalesces MULTIPLE cards' *_enabled changes in the same resync pass into exactly ONE refit", () => {
  const { node, refs } = makeGeneratorFixture();
  findWidget(node, "highres_enabled").value = true;
  findWidget(node, "detailer_enabled").value = true;
  resetRAF();

  refreshFieldValues(node, refs);

  assert.equal(refs.cards.highres.bodyEl.hidden, false);
  assert.equal(refs.cards.detailer.bodyEl.hidden, false);
  assert.equal(rafQueue.length, 1, "must coalesce into exactly one refit, not one per changed card");
  flushRAF();
});

test("refreshFieldValues does NOT schedule a refit when a *_enabled widget's value is unchanged -- the common case on every execution-finished event, when nothing actually changed", () => {
  const { node, refs } = makeGeneratorFixture();
  // highres_enabled is already false (fixture default) and this "mutation"
  // sets it to the SAME value -- nothing actually changed.
  findWidget(node, "highres_enabled").value = false;
  resetRAF();

  refreshFieldValues(node, refs);

  assert.equal(rafQueue.length, 0, "an unchanged *_enabled value must never trigger a refit, even though refreshFieldValues runs on every execution-finished event");
});

test("refreshFieldValues does not overwrite a control the user currently has focus in, but resyncs it once focus clears", () => {
  const { node, refs } = makeGeneratorFixture();
  const seedRow = refs.cards.sampler.bodyEl.children[0];
  const seedNumInput = seedRow.children[1].children[0].children[0];
  const seedRange = seedRow.children[1].children[0].children[1];

  refs.doc.activeElement = seedNumInput;
  seedNumInput.value = "123"; // a partially-typed in-progress edit
  findWidget(node, "seed").value = 999; // external mutation arrives mid-edit

  refreshFieldValues(node, refs);

  assert.equal(seedNumInput.value, "123", "must not clobber the field the user is actively editing");
  assert.equal(seedRange.value, "0", "paired slider must not desync from the focused number box either (still its original rendered value)");

  // Once focus clears, the next resync applies normally.
  refs.doc.activeElement = null;
  refreshFieldValues(node, refs);
  assert.equal(seedNumInput.value, "999");
  assert.equal(seedRange.value, "999");
});

test("refreshFieldValues skips the Enabled checkbox while it is the focused element -- and never refits from a change it didn't apply", () => {
  const { node, refs } = makeGeneratorFixture();
  const highresEnabledWidget = findWidget(node, "highres_enabled");
  refs.doc.activeElement = refs.cards.highres.enabledCheckbox;
  resetRAF();

  highresEnabledWidget.value = true;
  refreshFieldValues(node, refs);

  assert.equal(refs.cards.highres.enabledCheckbox.checked, false, "focused Enabled checkbox must not be clobbered");
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "body must not open either -- the change was never applied");
  assert.equal(rafQueue.length, 0, "a change skipped because the checkbox is focused must never schedule a refit");
});

test("refreshFieldValues is a no-op (never throws) for refs with no cards / no fieldRows yet", () => {
  const { node } = makeGeneratorFixture();
  assert.doesNotThrow(() => refreshFieldValues(node, null));
  assert.doesNotThrow(() => refreshFieldValues(node, {}));
  assert.doesNotThrow(() => refreshFieldValues(node, { cards: {} }));
});

test("resyncAllFromWidgets resyncs every live node with a mounted panel", () => {
  const a = makeGeneratorFixture();
  const b = makeGeneratorFixture();
  a.node._agRefs = a.refs;
  b.node._agRefs = b.refs;
  findWidget(a.node, "seed").value = 111;
  findWidget(b.node, "seed").value = 222;

  resyncAllFromWidgets([a.node, b.node]);

  const seedInput = (refs) => refs.cards.sampler.bodyEl.children[0].children[1].children[0].children[0];
  assert.equal(seedInput(a.refs).value, "111");
  assert.equal(seedInput(b.refs).value, "222");
});

test("resyncAllFromWidgets skips nodes with no mounted panel (_agRefs unset) and never throws", () => {
  assert.doesNotThrow(() => resyncAllFromWidgets([null, undefined, {}, { _agRefs: null }]));
  assert.doesNotThrow(() => resyncAllFromWidgets([]));
  assert.doesNotThrow(() => resyncAllFromWidgets(undefined));
});

test("resyncAllFromWidgets swallows one node's resync failure and still resyncs the rest", () => {
  const { node: goodNode, refs: goodRefs } = makeGeneratorFixture();
  goodNode._agRefs = goodRefs;
  findWidget(goodNode, "seed").value = 555;

  // A node whose refs throw the moment `refreshFieldValues` reads `.cards`
  // -- simulates a corrupted/unexpected refs shape on some OTHER node.
  const throwingNode = {
    _agRefs: {
      get cards() {
        throw new Error("boom");
      },
    },
  };

  assert.doesNotThrow(() => resyncAllFromWidgets([throwingNode, goodNode]));

  const seedInput = goodRefs.cards.sampler.bodyEl.children[0].children[1].children[0].children[0];
  assert.equal(seedInput.value, "555", "the good node must still be resynced despite the other node's failure");
});

test("index.js imports api from the absolute /scripts/api.js path", () => {
  assert.match(indexSource, /from\s+"\/scripts\/api\.js"/);
});

test("index.js subscribes to execution_success/execution_error/execution_interrupted, not onExecuted (this node never emits the ui-data 'executed' message -- see this file's top doc comment)", () => {
  assert.match(indexCode, /"execution_success"/);
  assert.match(indexCode, /"execution_error"/);
  assert.match(indexCode, /"execution_interrupted"/);
  assert.ok(!/onExecuted/.test(indexCode), "must not rely on onExecuted -- AnimaGenerator.generate() never returns ui data, so it would never fire");
});

test("index.js's setup() guards the api-listener registration in a try/catch and checks addEventListener exists (degrades to a no-op instead of throwing)", () => {
  const idx = indexCode.indexOf("async setup()");
  const body = indexCode.slice(idx, indexCode.indexOf("\n  },", idx));
  assert.match(body, /try\s*{/);
  assert.match(body, /typeof api\.addEventListener\s*===\s*"function"/);
});

test("index.js's setup() only attaches the api listener once (apiListenerAttached guard), mirroring anima_preview's own precedent", () => {
  assert.match(indexCode, /apiListenerAttached/);
});

test("index.js's handleExternalExecutionEvent delegates to resyncAllFromWidgets(findAnimaGeneratorNodes())", () => {
  const idx = indexCode.indexOf("function handleExternalExecutionEvent");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.match(body, /resyncAllFromWidgets\(findAnimaGeneratorNodes\(\)\)/);
});

test("index.js's findAnimaGeneratorNodes uses the public findNodesByType API (not the private _nodes array) and never throws", () => {
  const idx = indexCode.indexOf("function findAnimaGeneratorNodes");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.match(body, /findNodesByType/);
  assert.ok(!/_nodes\b/.test(body), "must not reach into the private app.graph._nodes array");
  assert.match(body, /try\s*{/);
});

// =========================================================================
// G. Manual-drag width+height clamp (this build's fix -- the node can no
//    longer be dragged into an unusable state)
// =========================================================================

test("WIDTH_MIN is a fixed floor at or below DEFAULT_W", () => {
  assert.ok(WIDTH_MIN <= DEFAULT_W, "WIDTH_MIN must never exceed DEFAULT_W");
  assert.equal(WIDTH_MIN, 280);
});

test("computeSizeFloor returns [WIDTH_MIN, measureMinHeight(root) + CHROME] for a real root", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 400;
  child.offsetParent = {};
  root.appendChild(child);
  const [minW, minH] = computeSizeFloor(root);
  assert.equal(minW, WIDTH_MIN);
  assert.equal(minH, measureMinHeight(root) + CHROME);
});

test("computeSizeFloor falls back to DEFAULT_H for a missing root (never throws)", () => {
  const [minW, minH] = computeSizeFloor(null);
  assert.equal(minW, WIDTH_MIN);
  assert.equal(minH, DEFAULT_H);
});

test("clampNodeSize raises a too-narrow size[0] up to WIDTH_MIN; leaves a wider size[0] alone", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const size = [100, 900];
  clampNodeSize({ size: [100, 900] }, root, size);
  assert.equal(size[0], WIDTH_MIN, "below the floor must clamp up to it");

  const wideSize = [900, 900];
  clampNodeSize({ size: [900, 900] }, root, wideSize);
  assert.equal(wideSize[0], 900, "above the floor must be left alone -- a floor, never a ceiling");
});

test("clampNodeSize raises a too-short size[1] up to the LIVE measureMinHeight(root) + CHROME; leaves a taller size[1] alone", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const child = doc.createElement("div");
  child.offsetHeight = 1000;
  child.offsetParent = {};
  root.appendChild(child);
  const floorH = measureMinHeight(root) + CHROME;

  const shortSize = [WIDTH_MIN, 10];
  clampNodeSize({ size: [WIDTH_MIN, 10] }, root, shortSize);
  assert.equal(shortSize[1], floorH, "below the live content floor must clamp up to it");

  const tallSize = [WIDTH_MIN, floorH + 500];
  clampNodeSize({ size: [WIDTH_MIN, floorH + 500] }, root, tallSize);
  assert.equal(tallSize[1], floorH + 500, "above the floor must be left alone");
});

test("clampNodeSize's height floor tracks content LIVE: fewer visible children (stages disabled) shrinks the floor, allowing a size that was previously clamped away", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const cardA = doc.createElement("div");
  cardA.offsetHeight = 400;
  cardA.offsetParent = {};
  const cardB = doc.createElement("div");
  cardB.offsetHeight = 400;
  cardB.offsetParent = {};
  root.appendChild(cardA);
  root.appendChild(cardB);

  const bigFloor = measureMinHeight(root) + CHROME;
  const attempt = [WIDTH_MIN, bigFloor - 50];
  clampNodeSize({ size: [WIDTH_MIN, bigFloor - 50] }, root, attempt);
  assert.equal(attempt[1], bigFloor, "with both cards visible, a size just below the floor is clamped up");

  // Simulate a stage's Enabled toggle collapsing cardB's body (setCardEnabledUI
  // hides it) -- measureMinHeight skips offsetParent === null children, so the
  // live floor shrinks with NO caching required.
  cardB.offsetParent = null;
  const smallFloor = measureMinHeight(root) + CHROME;
  assert.ok(smallFloor < bigFloor, "collapsing a card must shrink the live floor");

  const nowAllowed = [WIDTH_MIN, bigFloor - 50];
  clampNodeSize({ size: [WIDTH_MIN, bigFloor - 50] }, root, nowAllowed);
  assert.equal(
    nowAllowed[1],
    bigFloor - 50,
    "a height that was clamped away when both cards were visible must now be ALLOWED once the smaller floor no longer requires clamping it",
  );
});

test("clampNodeSize also clamps node.size directly (belt-and-braces for a host that treats node.size, not the onResize size param, as canonical)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const node = { size: [50, 10] };
  clampNodeSize(node, root, [50, 10]);
  assert.equal(node.size[0], WIDTH_MIN);
  assert.equal(node.size[1], measureMinHeight(root) + CHROME);
});

test("clampNodeSize writes node.min_size to the same live floor (best-effort belt-and-braces; harmless if the host never reads it)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const node = { size: [500, 900] };
  clampNodeSize(node, root, [500, 900]);
  assert.deepEqual(node.min_size, [WIDTH_MIN, measureMinHeight(root) + CHROME]);
});

test("clampNodeSize never throws for a missing node/root/size", () => {
  assert.doesNotThrow(() => clampNodeSize(null, null, null));
  assert.doesNotThrow(() => clampNodeSize({}, null, undefined));
  assert.doesNotThrow(() => clampNodeSize({ size: "not-an-array" }, null, [10, 10]));
});

test("clampNodeSize is a floor only -- never lowers a size that's already above it (never fights the user growing the node)", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const size = [900, 900];
  const node = { size: [900, 900] };
  clampNodeSize(node, root, size);
  assert.deepEqual(size, [900, 900]);
  assert.deepEqual(node.size, [900, 900]);
});

test("createResizeClampHandler clamps via the returned handler and calls through to the original onResize with the (possibly clamped) size", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  let originalCalledWith = null;
  const original = function (size) {
    originalCalledWith = size.slice();
    return "original-return-value";
  };
  const handler = createResizeClampHandler(original);
  const node = { size: [50, 10], _agRefs: { root } };

  const result = handler.call(node, [50, 10]);

  assert.equal(node.size[0], WIDTH_MIN, "handler must clamp node.size via clampNodeSize");
  assert.ok(originalCalledWith[0] >= WIDTH_MIN, "the original onResize must see the CLAMPED size, not the raw one");
  assert.equal(result, "original-return-value", "must return the original onResize's return value");
});

test("createResizeClampHandler degrades safely with no original onResize (undefined) -- never throws, returns undefined", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const handler = createResizeClampHandler(undefined);
  const node = { size: [50, 10], _agRefs: { root } };
  let result;
  assert.doesNotThrow(() => {
    result = handler.call(node, [50, 10]);
  });
  assert.equal(result, undefined);
  assert.equal(node.size[0], WIDTH_MIN, "clamping itself must still happen even with no original onResize to call through to");
});

test("createResizeClampHandler degrades safely when the node has no mounted panel yet (_agRefs unset) -- falls back to DEFAULT_H, never throws", () => {
  const handler = createResizeClampHandler(undefined);
  const node = { size: [50, 10] };
  assert.doesNotThrow(() => handler.call(node, [50, 10]));
  assert.equal(node.size[0], WIDTH_MIN);
  assert.equal(node.size[1], DEFAULT_H);
});

test("createResizeClampHandler's anti-recursion guard stops a clamp<->resize feedback loop cold -- a stubbed resize counter never runs away", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  let originalCalls = 0;
  // An original onResize that (pathologically) tries to call the SAME
  // wrapped onResize again synchronously, unconditionally -- the exact
  // feedback-loop shape the guard must stop. Without the guard this
  // recurses until a stack overflow (originalCalls would run away
  // unbounded); with the guard, the reentrant wrappedRef.call is a same-tick
  // no-op, so originalCalls can only ever be exactly 1.
  let wrappedRef;
  const original = function (size) {
    originalCalls += 1;
    wrappedRef.call(this, size); // always tries to recurse -- no artificial limiter
    return undefined;
  };
  wrappedRef = createResizeClampHandler(original);
  const node = { size: [50, 10], _agRefs: { root } };

  assert.doesNotThrow(() => wrappedRef.call(node, [50, 10]));
  assert.equal(
    originalCalls,
    1,
    "the guard must stop the reentrant call before it ever reaches `original` again -- proves the loop is actually broken, not just bounded",
  );
  assert.equal(node._agResizeClampGuard, false, "guard must be back to false once the (non-reentrant) top-level call returns");
});

test("createResizeClampHandler's guard flag is reset in a finally -- a throwing clampNodeSize/originalOnResize can't leave clamping permanently disabled", () => {
  const doc = makeDocStub();
  const root = doc.createElement("div");
  const throwingOriginal = function () {
    throw new Error("boom");
  };
  const handler = createResizeClampHandler(throwingOriginal);
  const node = { size: [50, 10], _agRefs: { root } };

  assert.throws(() => handler.call(node, [50, 10]));
  assert.equal(node._agResizeClampGuard, false, "guard must be reset even when the original onResize throws");

  // A second call must still clamp normally -- guard not stuck "true".
  assert.throws(() => handler.call(node, [50, 10]));
  assert.equal(node.size[0], WIDTH_MIN);
});

test("index.js wraps nodeType.prototype.onResize with createResizeClampHandler, preserving the previous implementation", () => {
  assert.match(indexCode, /createResizeClampHandler\(nodeType\.prototype\.onResize\)/);
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
