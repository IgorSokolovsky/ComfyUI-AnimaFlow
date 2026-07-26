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
 *      collapse-state property anymore: `enabledWidget` alone drives
 *      open/closed.
 *   B. `render.mjs` DOM behavior — the outer scroll box (`.wtn-ag-box`) is
 *      the SINGLE parent of every card, card shells (no collapse button on
 *      ANY card; an Enabled checkbox only on optional cards), field-row
 *      construction per kind (missing/boolean/combo/number/text),
 *      full-rebuild `renderCardFields`, `setCardEnabledUI` opening/closing a
 *      card's body, and the CSS this build's box-that-scrolls architecture
 *      depends on: `.wtn-ag-root` fills 100% of the height the DOM widget is
 *      given, `.wtn-ag-box` fills the root and scrolls vertically only
 *      (never horizontally), and `.wtn-ag-card` keeps `flex-shrink: 0` (so a
 *      too-short box scrolls instead of compressing a card's content).
 *   C. `interaction.mjs` — hiding a widget sets `hidden`/`computeSize` but
 *      NEVER `serialize = false` (the regression that would silently break
 *      saved workflows), a widget named in the layout but absent at runtime
 *      is skipped without throwing (and logged exactly once),
 *      `repositionDomWidget` moves the panel above the native textareas,
 *      and — this build's core requirement — toggling a stage's Enabled
 *      checkbox (which also opens/closes that card), collapsing/expanding a
 *      card, and switching the upscale backend all change ONLY what's
 *      inside `.wtn-ag-box`'s scroll region: NONE of them resizes the node
 *      any more (the inverse of the previous revision's STRUCTURAL-vs-VALUE
 *      refit gating, which no longer exists as a concept — see this file's
 *      "no more resize machinery" section below for what was removed and
 *      why). Always-on cards (SAMPLER, PREVIEW) expose no collapse control
 *      and no Enabled checkbox at all, and their bodies are always visible.
 *   D. `index.js` source-level assertions (`app` resolves only inside a real
 *      ComfyUI/browser host) — absolute import, widget-hiding call, legacy +
 *      Nodes 2.0 sizing wiring (now backed by the fixed `HEIGHT_MIN` floor,
 *      not a content measurement), and that neither `setupNode` nor
 *      `restoreNode` contains any resize-scheduling call (there is none left
 *      in this build to make).
 *   E. External-mutation resync (the gap the previous revision's follow-up
 *      fix closed, preserved by this build) — `render.mjs`'s
 *      `updateFieldRowValue` and `interaction.mjs`'s
 *      `refreshFieldValues`/`resyncAllFromWidgets`: a widget value changed
 *      PROGRAMMATICALLY (e.g. `seed` after ComfyUI's own
 *      `control_after_generate`) is picked up by a fresh resync WITHOUT
 *      rebuilding any DOM; a control the user currently has focused is left
 *      alone even while a resync fires; `resyncAllFromWidgets` degrades to a
 *      no-op (never throws) for nodes with no mounted panel or a broken
 *      `refs` shape, and keeps going for the REST of the nodes if one
 *      throws. An externally-changed `*_enabled` value still opens/closes
 *      that card (never resizes anything — there is nothing left to
 *      schedule).
 *   F. Manual-drag width+height clamp (`computeSizeFloor`/`clampNodeSize`/
 *      `createResizeClampHandler`) — the width floor still clamps (`WIDTH_MIN`,
 *      unchanged); the height floor is now a FIXED constant
 *      (`HEIGHT_MIN + CHROME`) rather than a measurement of current
 *      content, so it no longer "tracks content live" the way the previous
 *      revision's `measureMinHeight`-backed floor did (removed test, see
 *      below) — it clamps to the same floor regardless of what's currently
 *      expanded/collapsed, which is the point: a genuine minimum, not "the
 *      node must be exactly this tall".
 *
 * ## What this build removed from the previous revision, and why
 *
 * The previous revision's "grow/shrink the node to exactly fit its content"
 * model (`measureMinHeight`, `setNodeHeight`, `refitNode`, `scheduleRefit`,
 * `scheduleInitialFit`) is gone entirely, replaced by upstream's "one
 * fixed-size box that scrolls" model (see `render.mjs`'s top doc comment for
 * the full account). Every test that exercised those removed functions, or
 * asserted that a structural change (Enabled toggle / collapse / upscale
 * backend switch) SCHEDULED a refit, is deleted below, not left pointing at
 * dead code — the corresponding NEW tests assert the opposite: those same
 * actions do NOT resize the node any more (`makeFakeNode`'s `setSizeCalls`
 * stays empty). The stubbed `requestAnimationFrame`/`rafQueue` machinery the
 * previous revision needed to test rAF-deferred refits is gone too — nothing
 * in this file's resize path uses `requestAnimationFrame` any more (there is
 * no more per-frame content measurement to defer past a layout pass).
 *
 * Run directly: `node js/anima/anima_generator/test_resize.mjs` (plain
 * script, no test framework — matches the project's `python
 * tests/test_x.py` convention).
 *
 * MANUAL-IN-COMFYUI CHECKLIST (cannot be confirmed by this headless harness
 * — the real `addDOMWidget`/LiteGraph runtime contract only exists live):
 *   [ ] The node renders one bordered/themed box containing 7 cards
 *       (Sampler, Highres Fix, Detailer, Upscale, Postprocess, Save,
 *       Preview) instead of a flat widget stack or a pile of separately
 *       floating cards; `positive_text`/`negative_text` render natively
 *       below the panel.
 *   [ ] The box visibly fills the node's current height (drag the node
 *       taller/shorter and confirm the box's bottom edge tracks the node's
 *       bottom edge, not the content's height) and NEVER clips a card mid-
 *       row -- when content is taller than the box, the BOX shows an
 *       internal scrollbar (mouse wheel over the box scrolls its content,
 *       not the graph), and there is no HORIZONTAL scrollbar at any node
 *       width down to WIDTH_MIN.
 *   [ ] When content is shorter than the box (e.g. every optional stage
 *       collapsed), the box shows empty space at the bottom -- this is
 *       correct, matching upstream, not a bug.
 *   [ ] Every number field shows a number box + a slider, both live-synced;
 *       dragging a slider does NOT resize the node.
 *   [ ] SAMPLER and PREVIEW (the two always-on cards) show a plain header
 *       (title only, no chevron, no Enabled checkbox) and their body is
 *       always visible.
 *   [ ] HIGHRES/DETAILER/UPSCALE/POSTPROCESS/SAVE show a header with an
 *       Enabled checkbox and NO separate chevron; unchecking it collapses
 *       the card to just that header row, checking it expands the body --
 *       toggling it does NOT resize the node (only the box's scroll content
 *       changes; drag the node to a height shorter than all-expanded content
 *       first, to make the scrollbar's presence/absence observable).
 *   [ ] Switching the Upscale backend combo rebuilds the card's fields and
 *       does NOT resize the node.
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
 *   [ ] A freshly-dragged-in node lands at a sensible default size
 *       (DEFAULT_W x DEFAULT_H) and can be dragged narrower/shorter down to
 *       WIDTH_MIN / the fixed height floor, but no further -- the resize
 *       handle stops there rather than letting the box collapse to
 *       uselessness.
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
  computeSizeFloor,
  clampNodeSize,
  createResizeClampHandler,
  CHROME,
  DEFAULT_W,
  DEFAULT_H,
  WIDTH_MIN,
  HEIGHT_MIN,
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
// B. render.mjs — DOM behavior + the box-that-scrolls CSS architecture
// =========================================================================

test("buildRoot builds ONE box (.wtn-ag-box) as root's only child, and one card shell per CARD_DEFS entry INSIDE that box, in order", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc, CARD_DEFS);
  assert.equal(refs.root.children.length, 1, "root must have exactly one child: the box");
  assert.equal(refs.root.children[0], refs.box);
  assert.equal(refs.box.children.length, CARD_DEFS.length);
  CARD_DEFS.forEach((c) => assert.ok(refs.cards[c.id], `missing shell for ${c.id}`));
});

test("buildRoot's box is the SINGLE parent of every card (not root directly)", () => {
  const doc = makeDocStub();
  const refs = buildRoot(doc, CARD_DEFS);
  CARD_DEFS.forEach((c) => {
    assert.equal(refs.cards[c.id].root.parentNode, refs.box, `${c.id}'s card root must be parented to the box, not root`);
  });
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

test("render.mjs's .wtn-ag-root CSS rule sets height: 100% (the box-fills-the-widget's-height contract this build introduces)", () => {
  const renderSource = readFileSync(path.join(__dirname, "render.mjs"), "utf8");
  const rootRuleMatch = renderSource.match(/\.wtn-ag-root \{[\s\S]*?\n\}/);
  assert.ok(rootRuleMatch, "could not find the .wtn-ag-root CSS rule in render.mjs");
  assert.match(rootRuleMatch[0], /height:\s*100%/, "the .wtn-ag-root rule must set height: 100%");
});

test("render.mjs's .wtn-ag-box CSS rule fills the root (flex: 1, min-height: 0) and scrolls vertically only (overflow-y: auto, no horizontal scroll)", () => {
  const renderSource = readFileSync(path.join(__dirname, "render.mjs"), "utf8");
  const boxRuleMatch = renderSource.match(/\.wtn-ag-box \{[\s\S]*?\n\}/);
  assert.ok(boxRuleMatch, "could not find the .wtn-ag-box CSS rule in render.mjs");
  const rule = boxRuleMatch[0];
  assert.match(rule, /flex:\s*1/, "the box must be a flex:1 child so it fills the root's height");
  assert.match(rule, /min-height:\s*0/, "the box needs min-height:0 to be allowed to shrink below its content and scroll instead of forcing height");
  assert.match(rule, /overflow-y:\s*auto/, "the box must scroll vertically when content exceeds its height");
  assert.ok(!/overflow-x:\s*(auto|scroll)/.test(rule), "the box must never scroll horizontally");
  assert.match(rule, /overflow-x:\s*hidden/, "the box must explicitly suppress horizontal scroll/overflow");
});

test("render.mjs's .wtn-ag-card CSS rule sets flex-shrink: 0 (so the box's overflow-y scrolls instead of compressing a card's content)", () => {
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
    "the .wtn-ag-card rule must set flex-shrink: 0 so the box's column-flex layout can never compress a card below its content height",
  );
});

test("render.mjs no longer emits the dead 'dim' collapse styling (wtn-ag-card-bd-dim) or a collapse-button rule -- Enabled hides/shows the body directly", () => {
  const renderSource = readFileSync(path.join(__dirname, "render.mjs"), "utf8");
  assert.ok(!/wtn-ag-card-bd-dim/.test(renderSource), "dead dim class must be removed, not left unused");
  assert.ok(!/wtn-ag-collapse-btn/.test(renderSource), "dead collapse-button class must be removed, not left unused");
});

test("render.mjs no longer exports any of the removed auto-fit-to-content machinery (measureMinHeight/setNodeHeight/refitNode/scheduleRefit/scheduleInitialFit)", () => {
  const renderSource = readFileSync(path.join(__dirname, "render.mjs"), "utf8");
  ["measureMinHeight", "setNodeHeight", "refitNode", "scheduleRefit", "scheduleInitialFit"].forEach((name) => {
    assert.ok(!new RegExp(`export function ${name}\\b`).test(renderSource), `${name} must be removed, not left dead`);
  });
});

// =========================================================================
// C. interaction.mjs — hide-and-mirror + "nothing here resizes the node"
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

test("checking a stage's Enabled checkbox OPENS that card and does NOT resize the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();
  const highresEnabledWidget = findWidget(node, "highres_enabled");
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "starts collapsed (fixture default)");

  refs.cards.highres.enabledCheckbox.checked = true;
  fire(refs.cards.highres.enabledCheckbox, "change");

  assert.equal(highresEnabledWidget.value, true, "the REAL native widget must be written, not a parallel object");
  assert.equal(refs.cards.highres.bodyEl.hidden, false, "checking Enabled must EXPAND the body");
  assert.equal(setSizeCalls.length, 0, "opening a card must never resize the node -- it only changes the box's scroll content");
});

test("unchecking a stage's Enabled checkbox COLLAPSES that card to just its header row and does NOT resize the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();
  // Open it first (the fixture defaults every *_enabled widget to false).
  refs.cards.highres.enabledCheckbox.checked = true;
  fire(refs.cards.highres.enabledCheckbox, "change");

  refs.cards.highres.enabledCheckbox.checked = false;
  fire(refs.cards.highres.enabledCheckbox, "change");

  assert.equal(findWidget(node, "highres_enabled").value, false);
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "unchecking Enabled must COLLAPSE the body to just the header row");
  assert.equal(setSizeCalls.length, 0, "collapsing a card must never resize the node either");
});

test("switching the upscale_backend combo rebuilds the card body to the new backend's fields and does NOT resize the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();

  const upscaleShell = refs.cards.upscale;
  const backendSelect = upscaleShell.bodyEl.children[0].children[1].children[0]; // field -> control -> select
  backendSelect.value = "resshift";
  fire(backendSelect, "change");

  assert.equal(findWidget(node, "upscale_backend").value, "resshift");
  assert.equal(upscaleShell.bodyEl.children.length, 1 + UPSCALE_BACKEND_FIELDS.resshift.length);
  assert.equal(setSizeCalls.length, 0, "switching the upscale backend must never resize the node -- only its own card's fields change");
});

test("dragging a number field's slider (value edit) writes the widget and never resizes the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();

  const cfgRow = refs.cards.sampler.bodyEl.children[3]; // seed, control_after_generate, steps, cfg
  const range = cfgRow.children[1].children[0].children[1]; // field -> control -> num-wrap -> range
  range.value = "9";
  fire(range, "input");

  assert.equal(findWidget(node, "cfg").value, 9);
  assert.equal(setSizeCalls.length, 0, "a slider/number edit must never resize the node");
});

test("picking a non-backend combo option writes the widget and never resizes the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();

  const samplerRow = refs.cards.sampler.bodyEl.children[4]; // seed, control_after_generate, steps, cfg, sampler_name
  const select = samplerRow.children[1].children[0];
  select.value = "dpmpp_2m";
  fire(select, "change");

  assert.equal(findWidget(node, "sampler_name").value, "dpmpp_2m");
  assert.equal(setSizeCalls.length, 0);
});

test("editing a text field writes the widget and never resizes the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();

  const savePrefixRow = refs.cards.save.bodyEl.children[0];
  const input = savePrefixRow.children[1].children[0];
  input.value = "Webtoon";
  fire(input, "input");

  assert.equal(findWidget(node, "save_prefix").value, "Webtoon");
  assert.equal(setSizeCalls.length, 0);
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

test("refreshAllCards re-renders every card's fields from current widget values, derives open/closed from the restored Enabled value, and never resizes the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();
  // Simulate onConfigure having restored a different value + a stage's
  // Enabled flag flipping true (the fixture defaults every *_enabled widget
  // to false, so "detailer" here starts collapsed).
  findWidget(node, "cfg").value = 12;
  findWidget(node, "detailer_enabled").value = true;

  refreshAllCards(node, refs);

  const cfgRow = refs.cards.sampler.bodyEl.children[3]; // seed, control_after_generate, steps, cfg
  const numInput = cfgRow.children[1].children[0].children[0];
  assert.equal(numInput.value, "12", "refreshAllCards must reflect the restored widget value");
  assert.equal(refs.cards.detailer.bodyEl.hidden, false, "refreshAllCards must open a card whose restored *_enabled value is true");
  assert.equal(refs.cards.detailer.enabledCheckbox.checked, true);
  assert.equal(setSizeCalls.length, 0, "restore must never resize the node -- trust the saved node.size");
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

test("index.js creates the widget with the legacy getMinHeight option, backed by the FIXED HEIGHT_MIN floor (not a content measurement)", () => {
  assert.match(indexSource, /getMinHeight/);
  assert.match(indexCode, /getMinHeight:\s*\(\)\s*=>\s*HEIGHT_MIN/);
  assert.ok(!/widget\.computeSize\s*=/.test(indexCode), "found a leftover widget.computeSize assignment");
  assert.ok(!/widget\.getHeight\s*=/.test(indexCode), "found a leftover widget.getHeight assignment");
  assert.ok(!/measureMinHeight/.test(indexCode), "index.js's CODE (not its doc comments) must not reference the removed measureMinHeight");
});

test("index.js's widget.computeLayoutSize reports the fixed HEIGHT_MIN + minWidth: 1 for the Nodes 2.0 renderer path", () => {
  assert.match(indexCode, /computeLayoutSize/);
  assert.match(indexCode, /minHeight:\s*HEIGHT_MIN/);
  assert.match(indexCode, /minWidth:\s*1/);
});

test("index.js repositions the DOM widget above the native textareas", () => {
  assert.match(indexCode, /repositionDomWidget\(node,\s*widget\)/);
});

test("index.js's CODE no longer imports or calls any of the removed refit/measurement helpers (scheduleRefit/scheduleInitialFit/measureMinHeight) -- doc comments may still name them when explaining what was removed and why", () => {
  ["scheduleRefit", "scheduleInitialFit", "measureMinHeight"].forEach((name) => {
    assert.ok(!indexCode.includes(name), `index.js's CODE must not reference the removed ${name}`);
  });
});

test("index.js's setupNode mounts the UI and floors a fresh node via ensureInitialFloor -- nothing else", () => {
  const setupIdx = indexCode.indexOf("function setupNode");
  const setupBody = indexCode.slice(setupIdx, indexCode.indexOf("\n}", setupIdx));
  assert.match(setupBody, /mountUI\(node\)/);
  assert.match(setupBody, /ensureInitialFloor\(node\)/);
});

test("index.js's restoreNode only calls mountUI + refreshAllCards -- no resize call of any kind", () => {
  const idx = indexCode.indexOf("function restoreNode");
  const body = indexCode.slice(idx, indexCode.indexOf("\n}", idx));
  assert.match(body, /mountUI\(node\)/);
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

test("index.js wraps nodeType.prototype.onResize with createResizeClampHandler, preserving the previous implementation", () => {
  assert.match(indexCode, /createResizeClampHandler\(nodeType\.prototype\.onResize\)/);
});

// =========================================================================
// E. External-mutation resync (preserved by this build)
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
  // concrete failure this fix targets).
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

test("refreshFieldValues opens/closes a card whose *_enabled widget was mutated externally, and never resizes the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "starts collapsed (fixture default: highres_enabled=false)");
  findWidget(node, "highres_enabled").value = true; // mutated externally, not via this panel's own checkbox

  refreshFieldValues(node, refs);

  assert.equal(refs.cards.highres.bodyEl.hidden, false, "an externally-flipped Enabled widget must open the card");
  assert.equal(refs.cards.highres.enabledCheckbox.checked, true);
  assert.equal(setSizeCalls.length, 0, "an externally-driven open/close must never resize the node either");
});

test("refreshFieldValues handles MULTIPLE cards' *_enabled changes in the same resync pass, none of them resizing the node", () => {
  const { node, refs, setSizeCalls } = makeGeneratorFixture();
  findWidget(node, "highres_enabled").value = true;
  findWidget(node, "detailer_enabled").value = true;

  refreshFieldValues(node, refs);

  assert.equal(refs.cards.highres.bodyEl.hidden, false);
  assert.equal(refs.cards.detailer.bodyEl.hidden, false);
  assert.equal(setSizeCalls.length, 0);
});

test("refreshFieldValues is a no-op for an unchanged *_enabled value -- the common case on every execution-finished event", () => {
  const { node, refs } = makeGeneratorFixture();
  // highres_enabled is already false (fixture default) and this "mutation"
  // sets it to the SAME value -- nothing actually changed.
  findWidget(node, "highres_enabled").value = false;

  assert.doesNotThrow(() => refreshFieldValues(node, refs));
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "must remain collapsed -- nothing changed");
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

test("refreshFieldValues skips the Enabled checkbox while it is the focused element", () => {
  const { node, refs } = makeGeneratorFixture();
  const highresEnabledWidget = findWidget(node, "highres_enabled");
  refs.doc.activeElement = refs.cards.highres.enabledCheckbox;

  highresEnabledWidget.value = true;
  refreshFieldValues(node, refs);

  assert.equal(refs.cards.highres.enabledCheckbox.checked, false, "focused Enabled checkbox must not be clobbered");
  assert.equal(refs.cards.highres.bodyEl.hidden, true, "body must not open either -- the change was never applied");
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
// F. Manual-drag width+height clamp (a FIXED floor now, not content-tracking)
// =========================================================================

test("WIDTH_MIN is a fixed floor at or below DEFAULT_W (unchanged by this build)", () => {
  assert.ok(WIDTH_MIN <= DEFAULT_W, "WIDTH_MIN must never exceed DEFAULT_W");
  assert.equal(WIDTH_MIN, 280);
});

test("HEIGHT_MIN is a fixed, sensible minimum -- well below DEFAULT_H, same relationship WIDTH_MIN has to DEFAULT_W", () => {
  assert.ok(HEIGHT_MIN > 0);
  assert.ok(HEIGHT_MIN < DEFAULT_H, "HEIGHT_MIN must never exceed DEFAULT_H");
});

test("computeSizeFloor returns the FIXED [WIDTH_MIN, HEIGHT_MIN + CHROME] -- no root/content argument at all", () => {
  assert.equal(computeSizeFloor.length, 0, "computeSizeFloor must take no arguments -- the floor no longer depends on measured content");
  const [minW, minH] = computeSizeFloor();
  assert.equal(minW, WIDTH_MIN);
  assert.equal(minH, HEIGHT_MIN + CHROME);
});

test("clampNodeSize raises a too-narrow size[0] up to WIDTH_MIN; leaves a wider size[0] alone", () => {
  const size = [100, 900];
  clampNodeSize({ size: [100, 900] }, size);
  assert.equal(size[0], WIDTH_MIN, "below the floor must clamp up to it");

  const wideSize = [900, 900];
  clampNodeSize({ size: [900, 900] }, wideSize);
  assert.equal(wideSize[0], 900, "above the floor must be left alone -- a floor, never a ceiling");
});

test("clampNodeSize raises a too-short size[1] up to the FIXED HEIGHT_MIN + CHROME floor; leaves a taller size[1] alone", () => {
  const floorH = HEIGHT_MIN + CHROME;

  const shortSize = [WIDTH_MIN, 10];
  clampNodeSize({ size: [WIDTH_MIN, 10] }, shortSize);
  assert.equal(shortSize[1], floorH, "below the fixed floor must clamp up to it");

  const tallSize = [WIDTH_MIN, floorH + 500];
  clampNodeSize({ size: [WIDTH_MIN, floorH + 500] }, tallSize);
  assert.equal(tallSize[1], floorH + 500, "above the floor must be left alone");
});

test("clampNodeSize's height floor is FIXED -- collapsing/expanding cards never changes it (the inverse of the previous revision's content-tracking floor)", () => {
  // The previous revision's floor read measureMinHeight(root), so it shrank
  // when cards collapsed (fewer visible children). This build's floor
  // (HEIGHT_MIN + CHROME) is a plain constant -- it does not change no
  // matter what's currently expanded/collapsed inside the box, because
  // nothing about the box's content is read here at all any more.
  const floorH = HEIGHT_MIN + CHROME;
  const attemptCollapsed = [WIDTH_MIN, floorH - 50];
  const attemptExpanded = [WIDTH_MIN, floorH - 50];
  clampNodeSize({ size: [WIDTH_MIN, floorH - 50] }, attemptCollapsed);
  clampNodeSize({ size: [WIDTH_MIN, floorH - 50] }, attemptExpanded);
  assert.equal(attemptCollapsed[1], floorH);
  assert.equal(attemptExpanded[1], floorH, "the floor is identical regardless of card open/closed state");
});

test("clampNodeSize also clamps node.size directly (belt-and-braces for a host that treats node.size, not the onResize size param, as canonical)", () => {
  const node = { size: [50, 10] };
  clampNodeSize(node, [50, 10]);
  assert.equal(node.size[0], WIDTH_MIN);
  assert.equal(node.size[1], HEIGHT_MIN + CHROME);
});

test("clampNodeSize writes node.min_size to the same fixed floor (best-effort belt-and-braces; harmless if the host never reads it)", () => {
  const node = { size: [500, 900] };
  clampNodeSize(node, [500, 900]);
  assert.deepEqual(node.min_size, [WIDTH_MIN, HEIGHT_MIN + CHROME]);
});

test("clampNodeSize never throws for a missing node/size", () => {
  assert.doesNotThrow(() => clampNodeSize(null, null));
  assert.doesNotThrow(() => clampNodeSize({}, undefined));
  assert.doesNotThrow(() => clampNodeSize({ size: "not-an-array" }, [10, 10]));
});

test("clampNodeSize is a floor only -- never lowers a size that's already above it (never fights the user growing the node)", () => {
  const size = [900, 900];
  const node = { size: [900, 900] };
  clampNodeSize(node, size);
  assert.deepEqual(size, [900, 900]);
  assert.deepEqual(node.size, [900, 900]);
});

test("createResizeClampHandler clamps via the returned handler and calls through to the original onResize with the (possibly clamped) size", () => {
  let originalCalledWith = null;
  const original = function (size) {
    originalCalledWith = size.slice();
    return "original-return-value";
  };
  const handler = createResizeClampHandler(original);
  const node = { size: [50, 10] };

  const result = handler.call(node, [50, 10]);

  assert.equal(node.size[0], WIDTH_MIN, "handler must clamp node.size via clampNodeSize");
  assert.ok(originalCalledWith[0] >= WIDTH_MIN, "the original onResize must see the CLAMPED size, not the raw one");
  assert.equal(result, "original-return-value", "must return the original onResize's return value");
});

test("createResizeClampHandler degrades safely with no original onResize (undefined) -- never throws, returns undefined", () => {
  const handler = createResizeClampHandler(undefined);
  const node = { size: [50, 10] };
  let result;
  assert.doesNotThrow(() => {
    result = handler.call(node, [50, 10]);
  });
  assert.equal(result, undefined);
  assert.equal(node.size[0], WIDTH_MIN, "clamping itself must still happen even with no original onResize to call through to");
});

test("createResizeClampHandler needs nothing but the node instance -- no mounted panel (_agRefs) required, since the floor is a fixed constant now", () => {
  const handler = createResizeClampHandler(undefined);
  const node = { size: [50, 10] }; // deliberately no _agRefs at all
  assert.doesNotThrow(() => handler.call(node, [50, 10]));
  assert.equal(node.size[0], WIDTH_MIN);
  assert.equal(node.size[1], HEIGHT_MIN + CHROME);
});

test("createResizeClampHandler's anti-recursion guard stops a clamp<->resize feedback loop cold -- a stubbed resize counter never runs away", () => {
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
  const node = { size: [50, 10] };

  assert.doesNotThrow(() => wrappedRef.call(node, [50, 10]));
  assert.equal(
    originalCalls,
    1,
    "the guard must stop the reentrant call before it ever reaches `original` again -- proves the loop is actually broken, not just bounded",
  );
  assert.equal(node._agResizeClampGuard, false, "guard must be back to false once the (non-reentrant) top-level call returns");
});

test("createResizeClampHandler's guard flag is reset in a finally -- a throwing clampNodeSize/originalOnResize can't leave clamping permanently disabled", () => {
  const throwingOriginal = function () {
    throw new Error("boom");
  };
  const handler = createResizeClampHandler(throwingOriginal);
  const node = { size: [50, 10] };

  assert.throws(() => handler.call(node, [50, 10]));
  assert.equal(node._agResizeClampGuard, false, "guard must be reset even when the original onResize throws");

  // A second call must still clamp normally -- guard not stuck "true".
  assert.throws(() => handler.call(node, [50, 10]));
  assert.equal(node.size[0], WIDTH_MIN);
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
