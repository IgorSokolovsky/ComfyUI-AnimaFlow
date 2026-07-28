/**
 * test_resize.mjs — regression tests for `state.mjs` (pure settings logic),
 * `render.mjs` (DOM/CSS building), and `interaction.mjs` (event wiring +
 * node-level orchestration) for `AnimaGenerator` / `AnimaPreview`, rewritten
 * against the 2026-07-28 Context Bridge contract (`docs/generator-design.md`
 * §1/§3/§5/§7's dated reversal notes). Runs under plain `node` via a small
 * DOM + fake-litegraph-node stub (same pattern as `js/controls/
 * test_resize.mjs`), never imports `index.js` directly (it needs a real
 * `app`/`window.LiteGraph`, which only exist in an actual ComfyUI page).
 *
 * Regenerating the fixtures this file checks the JS normalizer against
 * (only needed if `src/anima/settings.py`/`preview_settings.py`'s DEFAULTS
 * change):
 *   python3 -c "import sys,json;sys.path.insert(0,'.');\
 *     from src.anima.settings import DEFAULT_GENERATION_SETTINGS as D;\
 *     print(json.dumps(D,indent=1))" > /tmp/f.json && python3 -c "\
 *     import json; d=json.load(open('/tmp/f.json'));\
 *     json.dump(d, open('js/anima/fixture_default_generation_settings.json','w'),\
 *     indent=2, sort_keys=True); open('js/anima/fixture_default_generation_settings.json','a').write(chr(10))"
 *
 *   python3 -c "import sys,json;sys.path.insert(0,'.');\
 *     from src.anima.preview_settings import DEFAULT_PREVIEW_SETTINGS as D;\
 *     print(json.dumps(D,indent=1))" > /tmp/f2.json && python3 -c "\
 *     import json; d=json.load(open('/tmp/f2.json'));\
 *     json.dump(d, open('js/anima/fixture_default_preview_settings.json','w'),\
 *     indent=2, sort_keys=True); open('js/anima/fixture_default_preview_settings.json','a').write(chr(10))"
 *
 * Covers (mapped to the dispatch's own "Tests" list):
 *   A. `state.mjs` — the refreshed fixture round-trips and deep-equals
 *      Python's actual output (no `latent`/`loras`); `resolveStageLabels`
 *      matches `src/anima/stages.py`'s `resolve_stage_labels` port
 *      byte-for-byte; `deepMergeDefaults`/`migrateVersion`/detailer-block
 *      mutation edge cases (unaffected by this reversal, kept for
 *      regression).
 *   B. `render.mjs` — 2026-07-28 (this dispatch) reversal: the panel now
 *      FILLS the node's height (CSS `flex: 1 1 auto`, no `max-height`) and
 *      the node is freely resizable; `measureMinHeight` reports ONLY a fixed
 *      `PANEL_MIN_H` floor (never the panel's real, stretched offsetHeight,
 *      so there's no ceiling left anywhere); `refitNode`/`scheduleRefit`/
 *      `scheduleInitialFit`/`setNodeHeight`/`PANEL_MAX_H` are gone entirely
 *      (asserted absent, so nothing can silently reappear and start fighting
 *      a manual resize again); a manual `node.setSize` survives a repaint
 *      unchanged; `GENERATOR_MIN_W`/`PREVIEW_MIN_W` still clamp width on
 *      `onResize`, untouched by this reversal.
 *   C. Wheel scrolls-vs-zooms per direction, exercised against the REAL
 *      built panel DOM (not a bespoke check — `js/shared/canvas_zoom.mjs`'s
 *      own `scrollRegionWantsWheel`).
 *   D. Teardown — `installZoomPassthrough`/`teardownNode` leave no orphaned
 *      wheel listener or open popover after `onRemoved`.
 *   E. Context-supplied fields — `resolveContextBridge`/
 *      `computeContextSupplied` for: `context` unwired; wired straight to a
 *      real `AnimaContextBridge`; wired through a single-input pass-through
 *      (Reroute-shaped) node to a bridge; wired to something that ISN'T a
 *      bridge. A supplied sampler field renders as a static "driven" row: an
 *      unsupplied one renders as an editable numeric/stepper field.
 *   F. State still reaches the SERIALIZED widget after every edit — a
 *      stage toggle, a drag-to-set numeric field, a stepper cycle, a boolean
 *      switch, a detailer block add/remove — never just in-memory state.
 *   G. Preview: `images` is one list input; the wipe compares two entries
 *      from `node._anPreviewImages` (populated by `handleExecuted`, keyed by
 *      the `stage` field Python already resolved); a one-entry run degrades
 *      to a single-image view.
 *
 * MANUAL-IN-COMFYUI CHECKLIST (this headless harness cannot confirm any of
 * this — the real `addDOMWidget`/legacy-litegraph runtime contract, actual
 * screen-space overlay placement, the real litegraph link-table shape
 * (`getInputLink` vs. `graph.links[id]`), and actual CSS flex-fill/
 * `overflow-y` enforcement only exist live):
 *   [ ] A fresh Generator/Preview node renders with the house theme applied
 *       and real litegraph sockets line up sensibly above this DOM body.
 *   [ ] `generation_settings`/`preview_state` widgets are invisible on the
 *       node face but present (and correctly populated) in the saved
 *       workflow JSON / the queued API prompt.
 *   [ ] Dragging the node TALLER makes `.wtn-an-panel` taller with it (no
 *       cap); dragging it SHORTER shrinks the panel and it scrolls
 *       internally rather than spilling; dragging below the floor clamps
 *       there instead of shrinking further.
 *   [ ] A workflow saved at a given size reopens at EXACTLY that size (no
 *       jump on load, no false "modified" workflow indicator).
 *   [ ] `resolveContextBridge`'s `getInputLink`/`graph.links[id]` fallback
 *       chain actually resolves against a real litegraph graph.
 *   [ ] The ⚙ popovers actually appear beside the correct row on screen and
 *       flip to the other side when they'd overflow the viewport.
 *   [ ] The wipe's hover tracks the cursor smoothly with no jitter.
 *   [ ] Mouse wheel over the node body zooms the canvas, except while
 *       hovering the `.wtn-an-panel` itself once its content overflows the
 *       panel's OWN current height, or a popover's own `overflow: auto`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { scrollRegionWantsWheel } from "../shared/canvas_zoom.mjs";

import {
  GENERATION_SETTINGS_SCHEMA,
  MAX_DETAILER_PASSES,
  STAGE_ORDER,
  deepMergeDefaults,
  migrateVersion,
  normalizeGenerationSettings,
  normalizePreviewSettings,
  resolveStageSampler,
  detailerIsLive,
  resolveStageLabels,
  addDetailerBlock,
  removeDetailerBlock,
  moveDetailerBlock,
  isBuiltinDetailerBlock,
} from "./state.mjs";

import * as render from "./render.mjs";
import {
  injectStyles,
  buildSwitch,
  sectionLabel,
  measureMinHeight,
  buildPreviewImageUrl,
  clampGeneratorSize,
  clampPreviewSize,
  DEFAULT_W,
  GENERATOR_MIN_W,
  PREVIEW_MIN_W,
  PANEL_MIN_H,
} from "./render.mjs";

import {
  getGenSettingsWidget,
  getPreviewStateWidget,
  ensureGenState,
  persistGenState,
  resolveContextBridge,
  computeContextSupplied,
  mountGeneratorUI,
  repaintGenerator,
  mountPreviewUI,
  repaintPreview,
  wipeXFromEvent,
  handleExecuted,
  installZoomPassthrough,
  teardownNode,
  closeActiveOverlay,
} from "./interaction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let count = 0;
function test(name, fn) {
  count += 1;
  // `js/shared/overlay.mjs`'s active-overlay slot is a MODULE-LEVEL
  // singleton. Reset it before every test so a popover a PREVIOUS test left
  // open never makes an unrelated later test's `openPopover` treat itself as
  // "already open -- toggle closed".
  closeActiveOverlay();
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
// Stubbed globals (requestAnimationFrame / getComputedStyle) -- same pattern
// as js/prompt_rules/node/test_resize.mjs.
// ---------------------------------------------------------------------------

globalThis.requestAnimationFrame = (cb) => {
  cb();
  return 1;
};
globalThis.getComputedStyle = (elx) => (elx && elx.style) || {};

// ---------------------------------------------------------------------------
// Minimal DOM stub -- mirrors js/controls/test_resize.mjs's makeDocStub.
// ---------------------------------------------------------------------------

function makeDocStub() {
  let doc;

  function makeElement(tag) {
    const style = {};
    style.setProperty = function setProperty(name, val) {
      style[name] = val;
    };
    const elObj = {
      tagName: tag,
      _listeners: {},
      children: [],
      style,
      attributes: {},
      value: "",
      textContent: "",
      title: "",
      disabled: false,
      type: "",
      selected: false,
      parentNode: null,
      offsetHeight: 20,
      scrollHeight: 20,
      scrollTop: 0,
      clientHeight: 20,
      _rect: { left: 0, top: 0, right: 300, bottom: 25, width: 300, height: 25 },
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
        elObj.attributes[name] = val;
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
      insertBefore(child, ref) {
        const idx = elObj.children.indexOf(ref);
        if (idx < 0) {
          elObj.children.push(child);
        } else {
          elObj.children.splice(idx, 0, child);
        }
        child.parentNode = elObj;
        return child;
      },
      contains(other) {
        let n = other;
        while (n) {
          if (n === elObj) {
            return true;
          }
          n = n.parentNode;
        }
        return false;
      },
      closest(selector) {
        const cls = selector.replace(/^\./, "");
        let n = elObj;
        while (n) {
          if (n.classList && n.classList.contains(cls)) {
            return n;
          }
          n = n.parentNode;
        }
        return null;
      },
      getBoundingClientRect() {
        return elObj._rect;
      },
      offsetParent: {},
      focus() {},
    };
    Object.defineProperty(elObj, "className", {
      get() {
        return [...elObj.classList._set].join(" ");
      },
      set(v) {
        elObj.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
      },
    });
    Object.defineProperty(elObj, "firstChild", {
      get() {
        return elObj.children.length ? elObj.children[0] : null;
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

function makeWindowStub(doc, size) {
  const win = {
    _listeners: {},
    innerWidth: (size && size.w) || undefined,
    innerHeight: (size && size.h) || undefined,
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
    setTimeout(fn) {
      fn();
      return 0;
    },
  };
  doc.defaultView = win;
  return win;
}

function fire(elx, t, overrides = {}) {
  const e = { type: t, target: elx, button: 0, clientX: 150, stopPropagation() {}, preventDefault() {}, ...overrides };
  (elx._listeners[t] || []).slice().forEach((fn) => fn(e));
}

// ---------------------------------------------------------------------------
// Query helpers -- interaction.mjs doesn't hand back a per-row refs map (the
// body is fully rebuilt on every action), so tests walk the built DOM tree.
// ---------------------------------------------------------------------------

function queryAll(root, predicate) {
  const out = [];
  (function walk(n) {
    if (!n) {
      return;
    }
    if (predicate(n)) {
      out.push(n);
    }
    (n.children || []).forEach(walk);
  })(root);
  return out;
}
function hasClass(n, cls) {
  return !!(n.classList && n.classList.contains(cls));
}
function findStageRow(root, name) {
  return queryAll(root, (n) => hasClass(n, "wtn-an-stagerow")).find(
    (row) => (row.children.find((c) => hasClass(c, "wtn-an-sn")) || {}).textContent === name,
  );
}
function gearOf(row) {
  return row.children.find((c) => hasClass(c, "wtn-fld-gear"));
}
function switchOf(row) {
  return row.children.find((c) => hasClass(c, "wtn-fld-switch"));
}
function popoverRoot(doc) {
  return queryAll(doc.body, (n) => hasClass(n, "wtn-an-pop")).slice(-1)[0];
}
/** Finds a field container (numeric/stepper/boolean/text -- one of this
 * track's four field shapes) by its own label text, across every field kind
 * this popover UI can render. */
function findFieldByLabel(root, label) {
  const containers = queryAll(root, (n) =>
    hasClass(n, "wtn-fld-num") || hasClass(n, "wtn-fld-stepper") || hasClass(n, "wtn-an-boolfield")
    || hasClass(n, "wtn-an-field") || hasClass(n, "wtn-fld-driven"));
  return containers.find((f) => {
    const nameEl = f.children.find((c) =>
      hasClass(c, "wtn-fld-num-name") || hasClass(c, "wtn-fld-stepper-name") || hasClass(c, "wtn-fld-driven-name"))
      || f.children[0];
    return nameEl && nameEl.textContent === label;
  });
}

// ---------------------------------------------------------------------------
// Fake litegraph nodes -- mirrors nodes/anima/generator.py's/preview.py's
// REAL INPUT_TYPES/RETURN_TYPES (context/generation_settings ->
// images/latent/metadata_json; preview_state + optional images/
// metadata_json), not the deleted socket set.
// ---------------------------------------------------------------------------

function makeGraph(nodesById, links) {
  return {
    getNodeById(id) {
      return nodesById[id] || null;
    },
    links,
  };
}

function makeGeneratorNode({ generation_settings = "{}", contextLink = null, graph = null } = {}) {
  const widgets = [{ name: "generation_settings", value: generation_settings }];
  const inputs = [{ name: "context", type: "ANIMA_CONTEXT", link: contextLink }];
  const outputs = [
    { name: "images", type: "IMAGE" },
    { name: "latent", type: "LATENT" },
    { name: "metadata_json", type: "STRING" },
  ];
  const node = {
    size: [DEFAULT_W, 100],
    widgets,
    inputs,
    outputs,
    graph,
    setSize(s) {
      node.size = s.slice();
    },
    setDirtyCanvas() {},
  };
  return node;
}

function makePreviewNode({ preview_state = "{}", imagesLink = null, metadataLink = null } = {}) {
  const widgets = [{ name: "preview_state", value: preview_state }];
  const inputs = [
    { name: "images", type: "IMAGE", link: imagesLink },
    { name: "metadata_json", type: "STRING", link: metadataLink },
  ];
  const node = {
    size: [396, 420],
    widgets,
    inputs,
    outputs: [], // AnimaPreview is OUTPUT_NODE with RETURN_TYPES ().
    setSize(s) {
      node.size = s.slice();
    },
    setDirtyCanvas() {},
  };
  return node;
}

function makeBridgeNode(id, wiredFields = []) {
  const ALL = ["model", "clip", "vae", "positive", "negative", "latent", "seed", "steps", "cfg", "sampler_name", "scheduler"];
  return {
    id,
    type: "AnimaContextBridge",
    inputs: ALL.map((name) => ({ name, link: wiredFields.includes(name) ? 99 : null })),
  };
}

function makeCtx(doc, overrides = {}) {
  return {
    doc,
    getCanvasEl: overrides.getCanvasEl || (() => null),
    havePackages: overrides.havePackages || (() => ({ spectrum: true, usdu: true, impact: true })),
  };
}

function genState(node) {
  return JSON.parse(getGenSettingsWidget(node).value);
}
function previewState(node) {
  return JSON.parse(getPreviewStateWidget(node).value);
}

// ===========================================================================
// A. state.mjs — pure settings logic
// ===========================================================================

test("normalizeGenerationSettings('{}') deep-equals Python's own DEFAULT_GENERATION_SETTINGS (checked-in fixture, no latent/loras)", () => {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixture_default_generation_settings.json"), "utf8"));
  const got = normalizeGenerationSettings("{}");
  assert.deepEqual(got, fixture);
  assert.ok(!("latent" in got), "the 2026-07-28 reversal deletes generation_settings.latent");
  assert.ok(!("loras" in got), "the 2026-07-28 reversal deletes generation_settings.loras");
});

test("normalizePreviewSettings('{}') deep-equals Python's own DEFAULT_PREVIEW_SETTINGS (checked-in fixture)", () => {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixture_default_preview_settings.json"), "utf8"));
  const got = normalizePreviewSettings("{}");
  assert.deepEqual(got, fixture);
});

test("normalizeGenerationSettings round-trips its own output unchanged (idempotent)", () => {
  const once = normalizeGenerationSettings("{}");
  const twice = normalizeGenerationSettings(JSON.stringify(once));
  assert.deepEqual(twice, once);
});

test("normalizeGenerationSettings: unknown top-level keys survive, missing keys default, garbage JSON never throws; a hand-edited payload that still sets latent/loras is tolerated as inert data", () => {
  const ok = normalizeGenerationSettings(JSON.stringify({ unknown_top: "keep me", sampler: { steps: 99 }, latent: { width: 2048 }, loras: [{ name: "x" }] }));
  assert.equal(ok.unknown_top, "keep me");
  assert.equal(ok.sampler.steps, 99);
  assert.equal(ok.sampler.cfg, 5.0); // missing key -> default
  assert.equal(ok.schema, GENERATION_SETTINGS_SCHEMA);
  // Nothing reads these anymore, but they must not be rejected/crash either.
  assert.deepEqual(ok.latent, { width: 2048 });
  assert.deepEqual(ok.loras, [{ name: "x" }]);
  assert.doesNotThrow(() => normalizeGenerationSettings("{ not json"));
  assert.doesNotThrow(() => normalizeGenerationSettings(null));
  assert.doesNotThrow(() => normalizeGenerationSettings([1, 2, 3]));
});

test("normalizeGenerationSettings: an absent stage block means defaults, disabled", () => {
  const out = normalizeGenerationSettings("{}");
  assert.equal(out.highres.enabled, false);
  assert.equal(out.upscale.enabled, false);
  assert.equal(out.detailer.enabled, false);
  assert.equal(out.postprocess.enabled, false);
});

test("migrateVersion: old/missing version stamps current; a newer version is preserved, never downgraded", () => {
  assert.equal(migrateVersion(undefined, 1), 1);
  assert.equal(migrateVersion(0, 1), 1);
  assert.equal(migrateVersion("garbage", 1), 1);
  assert.equal(migrateVersion(5, 1), 5);
});

test("deepMergeDefaults: dict default + non-dict value falls back to defaults verbatim; list default + list value wins verbatim", () => {
  assert.deepEqual(deepMergeDefaults({ a: 1 }, "not an object"), { a: 1 });
  assert.deepEqual(deepMergeDefaults([1, 2, 3], [9]), [9]);
  assert.deepEqual(deepMergeDefaults([1, 2, 3], "nope"), [1, 2, 3]);
});

test("normalizeGenerationSettings: an unknown detailer block id merges against the FACE template, and MAX_DETAILER_PASSES caps `order`", () => {
  const raw = {
    detailer: {
      enabled: true,
      order: ["face", "custom_9", "eye", "custom_1", "custom_2", "custom_3"],
      blocks: {
        face: { threshold: 0.9 },
        custom_9: { label: "Nine", detect_prompt: "nine" },
        custom_1: {},
        custom_2: {},
        custom_3: {},
      },
    },
  };
  const out = normalizeGenerationSettings(JSON.stringify(raw));
  assert.equal(out.detailer.order.length, MAX_DETAILER_PASSES);
  assert.deepEqual(out.detailer.order, ["face", "custom_9", "eye", "custom_1"]);
  assert.equal(out.detailer.blocks.custom_9.label, "Nine");
  assert.equal(out.detailer.blocks.custom_9.crop_factor, 4.0);
  assert.equal(out.detailer.blocks.face.threshold, 0.9);
  assert.ok(!("custom_2" in out.detailer.blocks));
  assert.ok(!("custom_3" in out.detailer.blocks));
});

test("resolveStageSampler: inherit on takes cfg/sampler_name/scheduler from the first pass, steps/denoise are always the stage's own", () => {
  const base = { cfg: 5.0, sampler_name: "er_sde", scheduler: "simple", steps: 32 };
  const stage = { inherit_sampler_settings: true, steps: 20, denoise: 0.25, cfg: 8.0, sampler_name: "euler", scheduler: "sgm_uniform" };
  const resolved = resolveStageSampler(stage, base);
  assert.equal(resolved.cfg, 5.0);
  assert.equal(resolved.sampler_name, "er_sde");
  assert.equal(resolved.scheduler, "simple");
  assert.equal(resolved.steps, 20);
  assert.equal(resolved.denoise, 0.25);
});

test("resolveStageSampler: inherit off uses the stage's own cfg/sampler_name/scheduler", () => {
  const base = { cfg: 5.0, sampler_name: "er_sde", scheduler: "simple" };
  const stage = { inherit_sampler_settings: false, steps: 20, denoise: 0.25, cfg: 8.0, sampler_name: "euler", scheduler: "sgm_uniform" };
  const resolved = resolveStageSampler(stage, base);
  assert.equal(resolved.cfg, 8.0);
  assert.equal(resolved.sampler_name, "euler");
  assert.equal(resolved.scheduler, "sgm_uniform");
});

// ---------------------------------------------------------------------------
// resolveStageLabels -- the replacement for the deleted resolveOutputs
// (design doc §5's reversal). Mirrors `src/anima/stages.py`'s
// `resolve_stage_labels`/`detailer_is_live` byte-for-byte.
// ---------------------------------------------------------------------------

test("detailerIsLive: off, Impact absent, or every block off -> inert; one enabled block -> live", () => {
  assert.equal(detailerIsLive({ detailerEnabled: false, haveImpact: true, blocks: { face: { enabled: true } } }), false);
  assert.equal(detailerIsLive({ detailerEnabled: true, haveImpact: false, blocks: { face: { enabled: true } } }), false);
  assert.equal(detailerIsLive({ detailerEnabled: true, haveImpact: true, blocks: { face: { enabled: false }, eye: { enabled: false } } }), false);
  assert.equal(detailerIsLive({ detailerEnabled: true, haveImpact: true, blocks: { face: { enabled: false }, eye: { enabled: true } } }), true);
});

test("resolveStageLabels: base is always first and always present, regardless of every other flag", () => {
  const combos = [
    { highresEnabled: false, detailerLive: false, upscaleLive: false, postprocessApplied: false },
    { highresEnabled: true, detailerLive: true, upscaleLive: true, postprocessApplied: true },
    { highresEnabled: false, detailerLive: true, upscaleLive: false, postprocessApplied: true },
  ];
  combos.forEach((c) => assert.equal(resolveStageLabels(c)[0], "base"));
});

test("resolveStageLabels: every stage off -> just [\"base\"] (one enabled stage -> one entry falls out for free)", () => {
  assert.deepEqual(resolveStageLabels({ highresEnabled: false, detailerLive: false, upscaleLive: false, postprocessApplied: false }), ["base"]);
});

test("resolveStageLabels: mid appears iff highres OR a live detailer changed the image -- either alone is enough", () => {
  assert.deepEqual(resolveStageLabels({ highresEnabled: true, detailerLive: false, upscaleLive: false, postprocessApplied: false }), ["base", "mid"]);
  assert.deepEqual(resolveStageLabels({ highresEnabled: false, detailerLive: true, upscaleLive: false, postprocessApplied: false }), ["base", "mid"]);
  assert.deepEqual(resolveStageLabels({ highresEnabled: true, detailerLive: true, upscaleLive: false, postprocessApplied: false }), ["base", "mid"]);
});

test("resolveStageLabels: final appears iff a live upscale OR an applied postprocess resize changed the image again", () => {
  assert.deepEqual(resolveStageLabels({ highresEnabled: false, detailerLive: false, upscaleLive: true, postprocessApplied: false }), ["base", "final"]);
  assert.deepEqual(resolveStageLabels({ highresEnabled: false, detailerLive: false, upscaleLive: false, postprocessApplied: true }), ["base", "final"]);
  assert.deepEqual(resolveStageLabels({ highresEnabled: true, detailerLive: false, upscaleLive: true, postprocessApplied: false }), ["base", "mid", "final"]);
});

test("Detailer block helpers: add respects MAX_DETAILER_PASSES, face/eye are unremovable (unaffected by the reversal)", () => {
  const detailer = normalizeGenerationSettings("{}").detailer;
  assert.equal(removeDetailerBlock(detailer, "face"), false);
  assert.equal(removeDetailerBlock(detailer, "eye"), false);
  assert.ok(isBuiltinDetailerBlock("face") && isBuiltinDetailerBlock("eye"));
  assert.equal(isBuiltinDetailerBlock("custom_1"), false);

  const id1 = addDetailerBlock(detailer);
  const id2 = addDetailerBlock(detailer);
  assert.equal(Object.keys(detailer.blocks).length, MAX_DETAILER_PASSES);
  assert.equal(addDetailerBlock(detailer), null);

  assert.equal(removeDetailerBlock(detailer, id1), true);
  assert.equal(Object.keys(detailer.blocks).length, MAX_DETAILER_PASSES - 1);

  const before = detailer.order.slice();
  moveDetailerBlock(detailer, "eye", -1);
  assert.notDeepEqual(detailer.order, before);
  void id2;
});

// ===========================================================================
// B. render.mjs — panel height FLOOR (no ceiling any more), min width
// ===========================================================================

test("injectStyles is idempotent and guarded against a doc with no createElement", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  injectStyles(doc);
  // Two stylesheets land: this module's own CSS, plus js/shared/fields.mjs's
  // (injectStyles calls injectFieldStyles internally) -- each guarded by its
  // own id, so a second call must not double-inject EITHER one.
  const styleTags = doc.head.children.filter((c) => c.tagName === "style");
  assert.equal(styleTags.length, 2);
  assert.doesNotThrow(() => injectStyles(null));
  assert.doesNotThrow(() => injectStyles({}));
});

// ---------------------------------------------------------------------------
// docs/pixaroma-review-rounds-plan.md Tier 2 item 8 -- ported the same
// defensive backstop to this track's own rows (.wtn-an-row/.wtn-an-stagerow
// here, .wtn-fld-stepper/.wtn-fld-num-name/.wtn-fld-num-val in the shared
// js/shared/fields.mjs primitives these panels are built from). Unlike the
// Control Panel, nothing here has to survive an output dot living outside
// its own box (this track has no per-row litegraph sockets at all -- one
// static DOM widget per node), so overflow: hidden can sit straight on the
// row with no row/body split needed. Same caveat as js/controls/
// test_resize.mjs's equivalent tests: a crude CSS-text guard, not a real
// layout check -- see the build report for the actual headless-Chrome
// measurement this was verified against.
// ---------------------------------------------------------------------------

/** Same helper as js/controls/test_resize.mjs's cssRuleBody -- duplicated
 * rather than imported, matching this pack's existing convention of each
 * test file carrying its own self-contained stub (see this file's own top
 * doc comment). Strips comments first so a preceding doc comment never gets
 * swallowed into the next rule's selector capture. */
function cssRuleBody(cssText, selector) {
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

test("injected CSS: .wtn-an-row and .wtn-an-stagerow both clip their own children (overflow: hidden) -- the same item-8 backstop as the Control Panel, ported to this track", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  for (const selector of [".wtn-an-row", ".wtn-an-stagerow"]) {
    const body = cssRuleBody(cssText, selector);
    assert.ok(body, `expected a ${selector} rule in the injected CSS`);
    assert.ok(body.includes("overflow: hidden"), `${selector} must clip its own children`);
  }
});

test("injected CSS: .wtn-an-row's name (.wtn-an-nm) has no flex-grow (its sibling .wtn-an-val already pushes itself right via margin-left: auto -- a growable name would fight that and stretch across the row instead of hugging the left edge)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  const nm = cssRuleBody(cssText, ".wtn-an-row .wtn-an-nm");
  assert.ok(nm, "expected a .wtn-an-row .wtn-an-nm rule in the injected CSS");
  const flexMatch = nm.match(/flex:\s*(\d+)\s+(\d+)\s+auto/);
  assert.ok(flexMatch, ".wtn-an-nm must declare an explicit flex shorthand");
  assert.equal(Number(flexMatch[1]), 0, "flex-grow must stay 0 -- margin-left: auto on .wtn-an-val owns the push-right job");
  assert.ok(Number(flexMatch[2]) > 1, "flex-shrink should still exceed the default so a long name yields before the value does");
});

test("injected CSS (shared js/shared/fields.mjs primitives): .wtn-fld-stepper clips its own children, and .wtn-fld-stepper-name/.wtn-fld-num-name have no flex-grow either (same margin-left: auto sibling reasoning as .wtn-an-nm)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-fields-style").textContent;
  const stepper = cssRuleBody(cssText, ".wtn-fld-stepper");
  assert.ok(stepper, "expected a .wtn-fld-stepper rule in the injected CSS");
  assert.ok(stepper.includes("overflow: hidden"));
  for (const selector of [".wtn-fld-stepper-name", ".wtn-fld-num-name"]) {
    const body = cssRuleBody(cssText, selector);
    assert.ok(body, `expected a ${selector} rule in the injected CSS`);
    const flexMatch = body.match(/flex:\s*(\d+)\s+(\d+)\s+auto/);
    assert.ok(flexMatch, `${selector} must declare an explicit flex shorthand`);
    assert.equal(Number(flexMatch[1]), 0, `${selector}: flex-grow must stay 0`);
    assert.ok(body.includes("min-width: 0") && body.includes("text-overflow: ellipsis"), `${selector} must be able to shrink to nothing and ellipsize`);
  }
});

test("buildSwitch/sectionLabel render expected text (shared js/shared/fields.mjs primitives)", () => {
  const doc = makeDocStub();
  const on = buildSwitch(doc, true);
  assert.ok(hasClass(on, "wtn-fld-on"));
  const off = buildSwitch(doc, false);
  assert.ok(!hasClass(off, "wtn-fld-on"));

  const sec = sectionLabel(doc, "stages", "2/4 on");
  assert.ok(sec.children.some((c) => c.textContent === "stages"));
  assert.ok(sec.children.some((c) => hasClass(c, "wtn-an-cnt")));
});

test("measureMinHeight floors the whole widget at PANEL_MIN_H even for a nearly-empty panel", () => {
  const root = makeDocStub().createElement("div");
  const panel = makeDocStub().createElement("div");
  panel.className = "wtn-an-panel";
  panel.offsetHeight = 10; // far below PANEL_MIN_H
  root.appendChild(panel);
  assert.equal(measureMinHeight(root), PANEL_MIN_H);
});

test("measureMinHeight: NO CEILING -- a panel with a huge real (stretched) offsetHeight still reports just the PANEL_MIN_H floor, never scaling up with it. This is the 'panel follows the NODE's height, not the content's' contract: the floor this reports to litegraph must never grow just because the content grew, or a resize-drag could get stuck unable to shrink", () => {
  const root = makeDocStub().createElement("div");
  const panel = makeDocStub().createElement("div");
  panel.className = "wtn-an-panel";
  panel.offsetHeight = 5000; // a huge stack of expanded sections/detailer blocks
  root.appendChild(panel);
  assert.equal(measureMinHeight(root), PANEL_MIN_H);
});

test("measureMinHeight is decoupled from the panel's real offsetHeight entirely -- 10px and 300px real heights report the identical floor (the panel is a flex-fill area now, not something whose content height this function tracks)", () => {
  const rootSmall = makeDocStub().createElement("div");
  const panelSmall = makeDocStub().createElement("div");
  panelSmall.className = "wtn-an-panel";
  panelSmall.offsetHeight = 10;
  rootSmall.appendChild(panelSmall);

  const rootBig = makeDocStub().createElement("div");
  const panelBig = makeDocStub().createElement("div");
  panelBig.className = "wtn-an-panel";
  panelBig.offsetHeight = 300;
  rootBig.appendChild(panelBig);

  assert.equal(measureMinHeight(rootSmall), measureMinHeight(rootBig));
  assert.equal(measureMinHeight(rootBig), PANEL_MIN_H);
});

test("injected CSS: .wtn-an-panel fills the node (flex grow, no max-height) with only a min-height floor, and still scrolls internally", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  const body = cssRuleBody(cssText, ".wtn-an-panel");
  assert.ok(body, "expected a .wtn-an-panel rule in the injected CSS");
  assert.match(body, /flex:\s*1\s+1\s+auto/, ".wtn-an-panel must flex-grow to fill the node (flex: 1 1 auto)");
  assert.ok(body.includes(`min-height: ${PANEL_MIN_H}px`), ".wtn-an-panel's CSS floor must match PANEL_MIN_H");
  assert.ok(!body.includes("max-height"), "the ceiling must be gone -- no max-height on .wtn-an-panel any more");
  assert.ok(body.includes("overflow-y: auto"), ".wtn-an-panel must still scroll internally past its own height");
});

test("the grow-biased auto-fit mechanism is gone from render.mjs entirely -- refitNode/scheduleRefit/scheduleInitialFit/setNodeHeight/PANEL_MAX_H no longer exist, so nothing can silently start fighting a manual resize again", () => {
  assert.equal(render.refitNode, undefined);
  assert.equal(render.scheduleRefit, undefined);
  assert.equal(render.scheduleInitialFit, undefined);
  assert.equal(render.setNodeHeight, undefined);
  assert.equal(render.PANEL_MAX_H, undefined);
  assert.equal(render.CHROME, undefined);
});

test("clampGeneratorSize / clampPreviewSize raise size[0] up to each node's own floor, never touch size[1]", () => {
  const size = [10, 999];
  clampGeneratorSize(size);
  assert.equal(size[0], GENERATOR_MIN_W);
  assert.equal(size[1], 999);

  const size2 = [10, 500];
  clampPreviewSize(size2);
  assert.equal(size2[0], PREVIEW_MIN_W);
  assert.equal(size2[1], 500);

  // A width already at/above the floor is left alone.
  const size3 = [GENERATOR_MIN_W + 40, 100];
  clampGeneratorSize(size3);
  assert.equal(size3[0], GENERATOR_MIN_W + 40);

  // Tolerant of a missing/non-numeric size.
  assert.doesNotThrow(() => clampGeneratorSize(null));
  assert.doesNotThrow(() => clampGeneratorSize(["nope"]));
});

// ===========================================================================
// B2. Resize policy -- the panel follows the NODE's height, floors but
//     never caps, and nothing in this module resizes the node on a repaint
//     or a workflow load (the whole point of this dispatch's reversal).
// ===========================================================================

test("mounting a node never touches node.size -- a size litegraph already restored (a stand-in for a saved workflow's size) must come out of mountGeneratorUI/mountPreviewUI byte-identical", () => {
  const genNode = makeGeneratorNode();
  genNode.size = [503, 733]; // an arbitrary "already restored" size
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountGeneratorUI(genNode, ctx);
  assert.deepEqual(genNode.size, [503, 733], "mounting the Generator UI must not resize the node");

  const pvNode = makePreviewNode();
  pvNode.size = [611, 899];
  mountPreviewUI(pvNode, ctx);
  assert.deepEqual(pvNode.size, [611, 899], "mounting the Preview UI must not resize the node");
});

test("a manual resize survives every kind of repaint -- toggling a stage, opening/editing a popover field, and a detailer block add all leave node.size exactly as the user (here, a direct setSize standing in for a manual drag) left it", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  // Simulate the user manually shrinking the node well below whatever this
  // module might otherwise have wanted -- there is no `_anAutoH`/"user
  // enlarged" bookkeeping left anywhere in this module to second-guess this.
  node.setSize([node.size[0], 150]);
  assert.deepEqual(node.size, [DEFAULT_W, 150]);

  const row = findStageRow(refs.body, "Highres");
  fire(switchOf(row), "click"); // toggles a stage -> repaintGenerator internally
  assert.deepEqual(node.size, [DEFAULT_W, 150], "a stage toggle (and its repaint) must not touch node.size");

  const detailerRow = findStageRow(repaintGenerator(node, ctx).body, "Detailer");
  fire(gearOf(detailerRow), "click");
  const pop = popoverRoot(doc);
  const addBtn = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  fire(addBtn, "click"); // adds a detailer block, persists, and refreshes the popover in place
  assert.deepEqual(node.size, [DEFAULT_W, 150], "adding a detailer block must not touch node.size either");

  closeActiveOverlay(); // closing runs onClosed -> repaintGenerator -- must not touch node.size either
  assert.deepEqual(node.size, [DEFAULT_W, 150], "closing the popover (and its repaint) must not touch node.size");
});

test("a manual resize survives a Preview repaint too (save/compare toggles, handleExecuted)", () => {
  const node = makePreviewNode({ imagesLink: 1, metadataLink: 1 });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountPreviewUI(node, ctx);
  node.setSize([node.size[0], 180]);

  handleExecuted(node, ctx, {
    images: [{ filename: "base.png", subfolder: "AnimaFlow", type: "output", stage: "base" }],
  });
  assert.deepEqual(node.size, [396, 180], "a run's onExecuted repaint must not touch node.size");

  repaintPreview(node, ctx);
  assert.deepEqual(node.size, [396, 180], "an explicit repaintPreview call must not touch node.size either");
});

test("index.js: the grow-biased refit call sites are gone -- no scheduleInitialFit/scheduleRefit/refitNode/setNodeHeight/PANEL_MAX_H reference survives in the file that wires up sizing", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.doesNotMatch(indexSource, /scheduleInitialFit\(/);
  assert.doesNotMatch(indexSource, /scheduleRefit\(/);
  assert.doesNotMatch(indexSource, /refitNode\(/);
  assert.doesNotMatch(indexSource, /setNodeHeight\(/);
  assert.doesNotMatch(indexSource, /PANEL_MAX_H/);
  assert.doesNotMatch(indexSource, /_anConfigured/);
  // The floor mechanism itself must still be wired to BOTH renderers.
  assert.match(indexSource, /getMinHeight/);
  assert.match(indexSource, /computeLayoutSize/);
  assert.match(indexSource, /minWidth:\s*1/);
});

// ===========================================================================
// C. Wheel scrolls-vs-zooms per direction -- exercised against the REAL
//    built panel DOM node (not a bespoke re-implementation).
// ===========================================================================

test("wheel: the built .wtn-an-panel wants the wheel when it has scroll room in the wheel's own direction, and passes through once pinned at that end", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  // The test DOM stub doesn't parse injected CSS into computed style, so
  // this test stubs the panel's own scroll state directly -- proving the
  // WIRING (root -> panel is what scrollRegionWantsWheel's walk finds), not
  // the CSS declaration itself (a VERIFY-IN-COMFYUI concern, see this
  // file's own checklist).
  refs.panel.style.overflowY = "auto";
  refs.panel.scrollHeight = 900;
  refs.panel.clientHeight = 300;

  refs.panel.scrollTop = 100; // room both up and down
  assert.ok(scrollRegionWantsWheel(refs.panel, refs.root, 0, 100));
  assert.ok(scrollRegionWantsWheel(refs.panel, refs.root, 0, -100));

  refs.panel.scrollTop = 0; // pinned at the top
  assert.equal(scrollRegionWantsWheel(refs.panel, refs.root, 0, -100), false, "wheel UP at the top must pass through to the canvas");
  assert.ok(scrollRegionWantsWheel(refs.panel, refs.root, 0, 100), "wheel DOWN still scrolls");

  refs.panel.scrollTop = 600; // pinned at the bottom (600+300=900)
  assert.equal(scrollRegionWantsWheel(refs.panel, refs.root, 0, 100), false, "wheel DOWN at the bottom must pass through to the canvas");
  assert.ok(scrollRegionWantsWheel(refs.panel, refs.root, 0, -100), "wheel UP still scrolls");
});

test("wheel: a panel with nothing to scroll (content fits) never wants the wheel, in either direction", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  refs.panel.style.overflowY = "auto";
  refs.panel.scrollHeight = 200;
  refs.panel.clientHeight = 300; // fits -- no scrollbar
  assert.equal(scrollRegionWantsWheel(refs.panel, refs.root, 0, 100), false);
  assert.equal(scrollRegionWantsWheel(refs.panel, refs.root, 0, -100), false);
});

// ===========================================================================
// D. Teardown -- no orphaned wheel listener or open popover survives
//    onRemoved.
// ===========================================================================

test("installZoomPassthrough installs exactly one wheel listener on the DOM widget root; teardownNode removes it", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);
  installZoomPassthrough(node, ctx);
  assert.equal((node._anRefs.root._listeners.wheel || []).length, 1);

  teardownNode(node);
  assert.equal((node._anRefs.root._listeners.wheel || []).length, 0, "no orphaned wheel listener after teardown");
});

test("teardownNode closes an open popover -- no orphan left mounted on document.body", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const row = findStageRow(refs.body, "Highres");
  fire(gearOf(row), "click");
  assert.ok(popoverRoot(doc), "popover must have opened");

  teardownNode(node);
  assert.ok(!popoverRoot(doc), "teardownNode must close any popover this node still owns");
});

// ===========================================================================
// E. Context-supplied fields -- resolveContextBridge/computeContextSupplied
//    for every documented case, plus the resulting field rendering.
// ===========================================================================

test("resolveContextBridge: context unwired -> null", () => {
  const node = makeGeneratorNode({ contextLink: null });
  assert.equal(resolveContextBridge(node), null);
  assert.deepEqual(computeContextSupplied(node), { bridgeFound: false, bridge: null, supplied: {} });
});

test("resolveContextBridge: context wired straight to a real AnimaContextBridge -- resolves, and reports exactly which of ITS sockets are wired", () => {
  const bridge = makeBridgeNode(2, ["seed", "cfg"]);
  const graph = makeGraph({ 2: bridge }, { 1: { origin_id: 2, origin_slot: 0 } });
  const node = makeGeneratorNode({ contextLink: 1, graph });
  assert.equal(resolveContextBridge(node), bridge);
  const { bridgeFound, supplied } = computeContextSupplied(node);
  assert.equal(bridgeFound, true);
  assert.equal(supplied.seed, true);
  assert.equal(supplied.cfg, true);
  assert.equal(supplied.steps, false);
  assert.equal(supplied.sampler_name, false);
});

test("resolveContextBridge: context wired through a single-input pass-through node (Reroute-shaped) to a bridge -- still resolves", () => {
  const bridge = makeBridgeNode(3, ["scheduler"]);
  const reroute = { id: 2, type: "Reroute", inputs: [{ name: "", link: 20 }] };
  const graph = makeGraph({ 2: reroute, 3: bridge }, {
    1: { origin_id: 2, origin_slot: 0 },
    20: { origin_id: 3, origin_slot: 0 },
  });
  // Real litegraph sets `.graph` on every node placed on the canvas -- these
  // plain-object stubs need it set explicitly for the same reason.
  reroute.graph = graph;
  bridge.graph = graph;
  const node = makeGeneratorNode({ contextLink: 1, graph });
  assert.equal(resolveContextBridge(node), bridge);
  assert.equal(computeContextSupplied(node).supplied.scheduler, true);
});

test("resolveContextBridge: context wired to something that ISN'T a bridge -- resolves to nothing, every field editable", () => {
  const notABridge = { id: 2, type: "SomeOtherNode", inputs: [{ name: "a", link: null }, { name: "b", link: null }] };
  const graph = makeGraph({ 2: notABridge }, { 1: { origin_id: 2, origin_slot: 0 } });
  const node = makeGeneratorNode({ contextLink: 1, graph });
  assert.equal(resolveContextBridge(node), null);
  assert.deepEqual(computeContextSupplied(node).supplied, {});
});

test("resolveContextBridge: a cycle (pass-through nodes looping back on themselves) fails closed, never hangs", () => {
  const a = { id: 2, type: "Reroute", inputs: [{ name: "", link: 20 }] };
  const b = { id: 3, type: "Reroute", inputs: [{ name: "", link: 10 }] };
  const graph = makeGraph({ 2: a, 3: b }, {
    1: { origin_id: 2, origin_slot: 0 },
    20: { origin_id: 3, origin_slot: 0 },
    10: { origin_id: 2, origin_slot: 0 }, // b points back to a -- a cycle
  });
  a.graph = graph;
  b.graph = graph;
  const node = makeGeneratorNode({ contextLink: 1, graph });
  assert.equal(resolveContextBridge(node), null);
});

test("a context-supplied sampler field renders as a static driven row; an unsupplied one renders editable", () => {
  const bridge = makeBridgeNode(2, ["seed"]);
  const graph = makeGraph({ 2: bridge }, { 1: { origin_id: 2, origin_slot: 0 } });
  const node = makeGeneratorNode({ contextLink: 1, graph });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  const seedRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))
    .find((r) => (r.children.find((c) => hasClass(c, "wtn-an-nm")) || {}).textContent === "seed");
  fire(seedRow, "click");
  const pop = popoverRoot(doc);

  const seedField = findFieldByLabel(pop, "seed");
  assert.ok(seedField && hasClass(seedField, "wtn-fld-driven"), "seed is context-supplied -- must render as a static driven row");

  const stepsField = findFieldByLabel(pop, "steps");
  assert.ok(stepsField && hasClass(stepsField, "wtn-fld-num"), "steps is NOT context-supplied -- must render as an editable numeric field");
});

test("no Context Bridge resolved -- every sampler field renders editable, and the popover says so", () => {
  const node = makeGeneratorNode({ contextLink: null });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const seedRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))
    .find((r) => (r.children.find((c) => hasClass(c, "wtn-an-nm")) || {}).textContent === "seed");
  fire(seedRow, "click");
  const pop = popoverRoot(doc);
  assert.ok(!queryAll(pop, (n) => hasClass(n, "wtn-fld-driven")).length, "nothing should render as driven with no bridge resolved");
  assert.ok(findFieldByLabel(pop, "seed") && hasClass(findFieldByLabel(pop, "seed"), "wtn-fld-num"));
});

// ===========================================================================
// F. State reaches the SERIALIZED widget after every kind of edit -- never
//    just in-memory state.
// ===========================================================================

test("mountGeneratorUI: brand-new node's generation_settings widget is written with the FULLY EXPANDED defaults, not left at Python's literal '{}'", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);
  const persisted = genState(node);
  assert.equal(persisted.schema, GENERATION_SETTINGS_SCHEMA);
  assert.equal(persisted.sampler.steps, 32);
});

test("toggling a stage switch writes the generation_settings WIDGET, not just in-memory state", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  assert.equal(genState(node).highres.enabled, false);
  const row = findStageRow(refs.body, "Highres");
  fire(switchOf(row), "click");
  assert.equal(genState(node).highres.enabled, true);
});

test("dragging a numeric field (steps) writes the widget on release, live-painting during the drag", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  const summary = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))[0];
  fire(summary, "click");
  let pop = popoverRoot(doc);
  const stepsField = findFieldByLabel(pop, "steps");
  assert.ok(stepsField, "steps must be editable -- nothing is context-supplied on an unwired-context node");

  stepsField._rect = { left: 0, top: 0, right: 300, bottom: 25, width: 300, height: 25 };
  fire(stepsField, "pointerdown", { clientX: 300 }); // drag to the far right -> max
  fire(stepsField, "pointermove", { clientX: 300 });
  // Not yet persisted to the widget until release -- in-memory paint only.
  fire(stepsField, "pointerup", { clientX: 300 });
  const persisted = genState(node);
  assert.equal(persisted.sampler.steps, 150, "dragging to the far right of a [1,150] range commits the max");
});

test("cycling a stepper field (sampler_name) writes the widget immediately (no drag needed)", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const summary = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))[0];
  fire(summary, "click");
  const pop = popoverRoot(doc);
  const samplerField = findFieldByLabel(pop, "sampler_name");
  const before = genState(node).sampler.sampler_name;
  const rightArrow = samplerField.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-right"));
  fire(rightArrow, "click");
  const after = genState(node).sampler.sampler_name;
  assert.notEqual(after, before, "the stepper must cycle AND persist immediately");
});

test("a boolean switch (mod guidance enabled) writes the widget immediately", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const mgRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))
    .find((r) => (r.children.find((c) => hasClass(c, "wtn-an-nm")) || {}).textContent === "mod guidance");
  fire(mgRow, "click");
  const pop = popoverRoot(doc);
  const enabledField = findFieldByLabel(pop, "enabled");
  fire(enabledField.children.find((c) => hasClass(c, "wtn-fld-switch")), "click");
  assert.equal(genState(node).mod_guidance.enabled, true);
});

test("detailer popover: adding respects MAX_DETAILER_PASSES and face/eye stay unremovable, all reaching the widget", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  const row = findStageRow(refs.body, "Detailer");
  fire(gearOf(row), "click");
  let pop = popoverRoot(doc);

  const builtinBtn = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent === "built in");
  assert.ok(builtinBtn && builtinBtn.disabled);

  const addBtn = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  fire(addBtn, "click");
  fire(addBtn, "click");
  let persisted = genState(node);
  assert.equal(Object.keys(persisted.detailer.blocks).length, MAX_DETAILER_PASSES);

  pop = popoverRoot(doc);
  const addBtnAgain = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  assert.ok(addBtnAgain.disabled, "MAX_DETAILER_PASSES reached -- the + button must refuse further adds");
});

test("inherit_sampler_settings toggle (Highres) hides exactly cfg/sampler_name/scheduler, both directions, and persists", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const row = findStageRow(refs.body, "Highres");
  fire(gearOf(row), "click");
  let pop = popoverRoot(doc);
  assert.ok(findFieldByLabel(pop, "steps"));
  assert.ok(findFieldByLabel(pop, "denoise"));
  assert.ok(!findFieldByLabel(pop, "cfg"), "cfg hidden while inherit is ON");
  assert.ok(!findFieldByLabel(pop, "sampler_name"));
  assert.ok(!findFieldByLabel(pop, "scheduler"));

  const inheritField = queryAll(pop, (n) => hasClass(n, "wtn-an-boolfield"))
    .find((f) => (f.children[0] || {}).textContent === "inherit");
  fire(inheritField.children.find((c) => hasClass(c, "wtn-fld-switch")), "click");
  pop = popoverRoot(doc);
  assert.ok(findFieldByLabel(pop, "cfg"), "cfg reappears once inherit is OFF");
  assert.ok(findFieldByLabel(pop, "sampler_name"));
  assert.ok(findFieldByLabel(pop, "scheduler"));
  assert.equal(genState(node).highres.inherit_sampler_settings, false);
});

// ===========================================================================
// G. Preview -- images is one list input; wipe reads node._anPreviewImages
//    (keyed by Python-resolved stage name), degrades to single-image.
// ===========================================================================

test("Preview: no images wired -- placeholder says 'nothing wired yet'", () => {
  const node = makePreviewNode({ imagesLink: null });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const empty = queryAll(refs.body, (n) => hasClass(n, "wtn-an-empty"))[0];
  assert.equal(empty.textContent, "nothing wired yet");
});

test("Preview: images wired but no run yet -- placeholder says so, distinctly from unwired", () => {
  const node = makePreviewNode({ imagesLink: 1 });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const empty = queryAll(refs.body, (n) => hasClass(n, "wtn-an-empty"))[0];
  assert.match(empty.textContent, /run the graph/i);
});

test("Preview: handleExecuted populates node._anPreviewImages keyed by Python-resolved stage, and repaints the dual-pane wipe", () => {
  const node = makePreviewNode({ imagesLink: 1, metadataLink: 1 });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountPreviewUI(node, ctx);

  handleExecuted(node, ctx, {
    images: [
      { filename: "base.png", subfolder: "AnimaFlow", type: "temp", stage: "base" },
      { filename: "final.png", subfolder: "AnimaFlow", type: "output", stage: "final" },
    ],
  });

  assert.ok(node._anPreviewImages.base);
  assert.ok(node._anPreviewImages.final);
  const wipe = node._anRefs.wipeEl;
  assert.ok(!hasClass(wipe, "wtn-an-single"), "both default compare stages (base/final) are present -- dual pane");
});

test("Preview: a ONE-entry run degrades to a single-image view, never a broken dual pane", () => {
  const node = makePreviewNode({ imagesLink: 1, metadataLink: 1 });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountPreviewUI(node, ctx);

  handleExecuted(node, ctx, {
    images: [{ filename: "base.png", subfolder: "AnimaFlow", type: "output", stage: "base" }],
  });

  const wipe = node._anRefs.wipeEl;
  assert.ok(hasClass(wipe, "wtn-an-single"));
  const label = queryAll(wipe, (n) => hasClass(n, "wtn-an-plab")).find((l) => l.textContent === "base");
  assert.ok(label, "the single present stage must be shown regardless of what compare.a/compare.b name");
});

test("Preview: buildPreviewImageUrl builds ComfyUI's /view URL and cache-busts with the provided token; null for a malformed entry", () => {
  const url = buildPreviewImageUrl({ filename: "x.png", subfolder: "AnimaFlow", type: "output" }, 123);
  assert.match(url, /^\/view\?/);
  assert.match(url, /filename=x\.png/);
  assert.match(url, /t=123/);
  assert.equal(buildPreviewImageUrl(null), null);
  assert.equal(buildPreviewImageUrl({}), null);
});

test("wipeXFromEvent clamps to [0,100] and defaults to 50 for a degenerate rect", () => {
  assert.equal(wipeXFromEvent(null, 10), 50);
  assert.equal(wipeXFromEvent({ left: 0, width: 100 }, -50), 0);
  assert.equal(wipeXFromEvent({ left: 0, width: 100 }, 150), 100);
  assert.equal(wipeXFromEvent({ left: 0, width: 100 }, 50), 50);
});

test("Preview: save/compare edits reach the preview_state widget", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const saveRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))[0];
  fire(saveRow, "click");
  const pop = popoverRoot(doc);
  const enabledField = findFieldByLabel(pop, "enabled");
  fire(enabledField.children.find((c) => hasClass(c, "wtn-fld-switch")), "click");
  assert.equal(previewState(node).save.enabled, false);
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
