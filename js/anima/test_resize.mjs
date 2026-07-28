/**
 * test_resize.mjs — regression tests for `state.mjs` (pure settings logic),
 * `render.mjs` (DOM/CSS building), and `interaction.mjs` (event wiring +
 * node-level orchestration) for `AnimaGenerator` / `AnimaPreview`, rewritten
 * against the 2026-07-28 Context Bridge contract AND (this dispatch) the
 * inline-sections reversal (`docs/generator-design.md` §1/§3/§5/§7/§12's
 * dated reversal notes — §12 records the modal → drawer → row-anchored
 * popover → inline-section history). Runs under plain `node` via a small
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
 *      wheel listener after `onRemoved` (there is no more popover to close).
 *   E. Context-supplied fields — `resolveContextBridge`/
 *      `computeContextSupplied` for: `context` unwired; wired straight to a
 *      real `AnimaContextBridge`; wired through a single-input pass-through
 *      (Reroute-shaped) node to a bridge (both a dead end and one that
 *      resolves); wired to something that ISN'T a bridge; a cycle. A
 *      supplied sampler field renders as the SAME editable field shape,
 *      genuinely DISABLED, with a yellow (`--wtn-warn`) ⓘ beside it; an
 *      unsupplied one renders fully editable with no ⓘ at all.
 *   E2. Inline sections (this dispatch) — a section's header click toggles
 *      `.wtn-an-sbody` existing/not-existing (never a floating overlay); that
 *      `ui_expanded` flag persists across a repaint AND across a fresh mount
 *      off the same (saved) widget value; the deleted popover mechanism
 *      (`buildPopoverShell`/`buildClickRow`/`buildNote`, every `openXPopover`,
 *      `closeActiveOverlay`) has no surviving export anywhere in `js/anima/`.
 *   F. State still reaches the SERIALIZED widget after every edit — a
 *      stage toggle, a drag-to-set numeric field, a stepper cycle, a boolean
 *      switch, a detailer block add/remove — never just in-memory state.
 *   G. Preview: `images` is one list input; the wipe compares two entries
 *      from `node._anPreviewImages` (populated by `handleExecuted`, keyed by
 *      the `stage` field Python already resolved); a one-entry run degrades
 *      to a single-image view.
 *   H. Socket self-healing — `computeNodeDefinition`/`healNodeSockets`
 *      reconcile a restored instance's stale `inputs`/`outputs` against the
 *      current `nodeData`: the real-world stale `AnimaGenerator` shape (11
 *      dead inputs + duplicated outputs) heals to `[context]` /
 *      `[images, latent, metadata_json]`; a link on a surviving socket is
 *      retargeted (never dropped); a link on a removed socket is torn down;
 *      survivors land in definition order (`AnimaContextBridge`); an
 *      already-correct instance is left byte-identical (`changed: false`,
 *      same array references, `removeInput`/`removeOutput` never even
 *      called); missing/malformed `nodeData` never mutates anything; and a
 *      static scan of `index.js` confirms healing is wired into
 *      `onConfigure` only, never `onNodeCreated`.
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
 *   [ ] A section genuinely expands/collapses in place inside the scrolling
 *       panel (no jitter, no layout jump) and a ⓘ's tooltip actually shows
 *       on hover, positioned sensibly near the cursor.
 *   [ ] The wipe's hover tracks the cursor smoothly with no jitter.
 *   [ ] Mouse wheel over the node body zooms the canvas, except while
 *       hovering the `.wtn-an-panel` itself once its content overflows the
 *       panel's OWN current height.
 *   [ ] VERIFY-IN-COMFYUI: the actual `beforeRegisterNodeDef` `nodeData`
 *       shape for `AnimaGenerator`/`AnimaPreview`/`AnimaContextBridge` (this
 *       file's `GENERATOR_NODE_DATA`/`PREVIEW_NODE_DATA`/`BRIDGE_NODE_DATA`
 *       fixtures are hand-derived from the Python `INPUT_TYPES`/
 *       `RETURN_TYPES`, not read off a live process); that `node.graph.links`
 *       really is a plain `{id: LLink}` map at the point `onConfigure`'s
 *       deferred callback runs; and that `removeInput`/`removeOutput` really
 *       do shift a later slot's `target_slot`/`origin_slot` down by one the
 *       way `healNodeSockets` assumes (this suite's own fake node
 *       reimplements that contract to test against it, it doesn't observe
 *       the real one).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { scrollRegionWantsWheel } from "../shared/canvas_zoom.mjs";
import * as fields from "../shared/fields.mjs";

import {
  GENERATION_SETTINGS_SCHEMA,
  MAX_DETAILER_PASSES,
  STAGE_ORDER,
  DEFAULT_EXPANDED_GENERATOR_SECTIONS,
  DEFAULT_EXPANDED_PREVIEW_SECTIONS,
  deepMergeDefaults,
  migrateVersion,
  normalizeGenerationSettings,
  normalizePreviewSettings,
  normalizeExpandedSections,
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
  buildPanelShell,
  measureMinHeight,
  measurePreviewMinHeight,
  buildPreviewImageUrl,
  clampGeneratorSize,
  clampPreviewSize,
  DEFAULT_W,
  GENERATOR_MIN_W,
  PREVIEW_MIN_W,
  PANEL_MIN_H,
  PREVIEW_IMG_MIN_H,
  PREVIEW_PANEL_MIN_H,
  PREVIEW_MIN_H,
} from "./render.mjs";

import * as interactionModule from "./interaction.mjs";
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
  computeNodeDefinition,
  healNodeSockets,
} from "./interaction.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let count = 0;
function test(name, fn) {
  count += 1;
  // 2026-07-28 (inline-sections dispatch): there is no more `js/shared/
  // overlay.mjs` module-level singleton to reset between tests -- js/anima/
  // no longer imports it at all (this file's own top doc comment).
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
/** Finds an expandable SECTION's own header (`.wtn-an-shead`, this
 * dispatch's replacement for the popover-opening row/stage-row) by its own
 * name text (`.wtn-an-shead-nm`). */
function findSectionHeader(root, name) {
  return queryAll(root, (n) => hasClass(n, "wtn-an-shead")).find(
    (h) => (h.children.find((c) => hasClass(c, "wtn-an-shead-nm")) || {}).textContent === name,
  );
}
/** A section header's own `.wtn-an-sbody` -- a SIBLING element (not a
 * child), appended right after the header inside their shared
 * `.wtn-an-section` wrapper only while that section is expanded. `null`
 * while collapsed -- this IS the "no floating overlay, no popover" contract
 * this dispatch introduces: there is nothing else to find. */
function sectionBodyOf(header) {
  if (!header || !header.parentNode) {
    return null;
  }
  return header.parentNode.children.find((c) => hasClass(c, "wtn-an-sbody")) || null;
}
function switchOf(row) {
  return row.children.find((c) => hasClass(c, "wtn-fld-switch"));
}
/** Finds a field container (numeric/stepper/boolean/text -- one of this
 * track's four field shapes) by its own label text, across every field kind
 * a section body can render -- regardless of whether it's wrapped in a
 * `.wtn-an-fieldrow` alongside its own ⓘ (`queryAll`'s recursive walk finds
 * it at any depth either way). */
function findFieldByLabel(root, label) {
  const containers = queryAll(root, (n) =>
    hasClass(n, "wtn-fld-num") || hasClass(n, "wtn-fld-stepper") || hasClass(n, "wtn-an-boolfield")
    || hasClass(n, "wtn-an-field"));
  return containers.find((f) => {
    const nameEl = f.children.find((c) =>
      hasClass(c, "wtn-fld-num-name") || hasClass(c, "wtn-fld-stepper-name"))
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
// defensive backstop to this track's own section header (.wtn-an-shead --
// 2026-07-28 inline-sections dispatch's replacement for the deleted
// .wtn-an-row/.wtn-an-stagerow, here; .wtn-fld-stepper/.wtn-fld-num-name/
// .wtn-fld-num-val in the shared js/shared/fields.mjs primitives these
// panels are built from). Unlike the Control Panel, nothing here has to
// survive an output dot living outside its own box (this track has no
// per-row litegraph sockets at all -- one static DOM widget per node), so
// overflow: hidden can sit straight on the row with no row/body split
// needed. Same caveat as js/controls/test_resize.mjs's equivalent tests: a
// crude CSS-text guard, not a real layout check -- see the build report for
// the actual headless-Chrome measurement this was verified against.
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

test("injected CSS: .wtn-an-shead (the section header -- this dispatch's replacement for the popover-opening row) clips its own children (overflow: hidden), the same item-8 backstop as the Control Panel", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  const body = cssRuleBody(cssText, ".wtn-an-shead");
  assert.ok(body, "expected a .wtn-an-shead rule in the injected CSS");
  assert.ok(body.includes("overflow: hidden"), ".wtn-an-shead must clip its own children");
});

test("injected CSS: .wtn-an-shead's own name (.wtn-an-shead-nm) never shrinks or grows (flex: none) -- it's the section's identity, never truncated; its muted summary (.wtn-an-shead-sum) is the one pushed right (margin-left: auto) and able to ellipsize", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  const nm = cssRuleBody(cssText, ".wtn-an-shead .wtn-an-shead-nm");
  assert.ok(nm, "expected a .wtn-an-shead .wtn-an-shead-nm rule in the injected CSS");
  assert.ok(nm.includes("flex: none"), ".wtn-an-shead-nm must never shrink or grow");

  const sum = cssRuleBody(cssText, ".wtn-an-shead .wtn-an-shead-sum");
  assert.ok(sum, "expected a .wtn-an-shead .wtn-an-shead-sum rule in the injected CSS");
  assert.match(sum, /margin-left:\s*auto/, ".wtn-an-shead-sum pushes itself right -- the name never grows to meet it");
  assert.ok(sum.includes("min-width: 0") && sum.includes("text-overflow: ellipsis"), ".wtn-an-shead-sum must be able to shrink to nothing and ellipsize");
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

test("buildPanelShell: the Preview's panel carries wtn-an-panel-pv; the Generator's (no-arg call site) does not", () => {
  const doc = makeDocStub();
  const { panel: pvPanel } = buildPanelShell(doc, { preview: true });
  assert.ok(hasClass(pvPanel, "wtn-an-panel"));
  assert.ok(hasClass(pvPanel, "wtn-an-panel-pv"), "the Preview's panel must carry the modifier class");

  const { panel: genPanel } = buildPanelShell(doc);
  assert.ok(hasClass(genPanel, "wtn-an-panel"));
  assert.ok(!hasClass(genPanel, "wtn-an-panel-pv"), "the Generator's panel (no second argument) must NOT carry it");

  // `mountGeneratorUI`/`mountPreviewUI` themselves must agree with this --
  // not just buildPanelShell in isolation.
  const ctx = makeCtx(doc);
  const genRefs = mountGeneratorUI(makeGeneratorNode(), ctx);
  assert.ok(!hasClass(genRefs.panel, "wtn-an-panel-pv"));
  const pvRefs = mountPreviewUI(makePreviewNode(), makeCtx(makeDocStub()));
  assert.ok(hasClass(pvRefs.panel, "wtn-an-panel-pv"));
});

test("injected CSS: .wtn-an-panel.wtn-an-panel-pv drops the shared scrollbar (overflow: hidden) and swaps in the Preview's own, taller floor (PREVIEW_PANEL_MIN_H)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  const body = cssRuleBody(cssText, ".wtn-an-panel.wtn-an-panel-pv");
  assert.ok(body, "expected a .wtn-an-panel.wtn-an-panel-pv rule in the injected CSS");
  assert.ok(body.includes("overflow: hidden"), ".wtn-an-panel-pv must drop the shared panel's scrollbar entirely");
  assert.ok(body.includes(`min-height: ${PREVIEW_PANEL_MIN_H}px`), ".wtn-an-panel-pv's floor must match PREVIEW_PANEL_MIN_H, not the shared PANEL_MIN_H");
});

test("injected CSS: .wtn-an-panel-pv .wtn-an-wipe cancels the shared aspect-ratio: 1/1 and flex-fills the body instead, floored at PREVIEW_IMG_MIN_H", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  const body = cssRuleBody(cssText, ".wtn-an-panel-pv .wtn-an-wipe");
  assert.ok(body, "expected a .wtn-an-panel-pv .wtn-an-wipe rule in the injected CSS");
  assert.match(body, /flex:\s*1\s+1\s+auto/, "the preview wipe must flex-fill its container");
  assert.ok(body.includes("aspect-ratio: auto"), "the preview wipe must cancel the shared aspect-ratio: 1/1");
  assert.ok(body.includes(`min-height: ${PREVIEW_IMG_MIN_H}px`), "the preview wipe's own floor must match PREVIEW_IMG_MIN_H");
});

test("measurePreviewMinHeight floors the Preview's widget at PREVIEW_PANEL_MIN_H, with the SAME no-ceiling contract as measureMinHeight (never scales up with the panel's real, stretched offsetHeight)", () => {
  const root = makeDocStub().createElement("div");
  const panel = makeDocStub().createElement("div");
  panel.className = "wtn-an-panel wtn-an-panel-pv";
  panel.offsetHeight = 10; // far below PREVIEW_PANEL_MIN_H
  root.appendChild(panel);
  assert.equal(measurePreviewMinHeight(root), PREVIEW_PANEL_MIN_H);

  panel.offsetHeight = 5000; // a huge stretched height -- still just the floor
  assert.equal(measurePreviewMinHeight(root), PREVIEW_PANEL_MIN_H);

  // The Generator's own measureMinHeight is UNCHANGED by this -- still
  // PANEL_MIN_H, not PREVIEW_PANEL_MIN_H, when called with no second arg.
  assert.equal(measureMinHeight(root), PANEL_MIN_H);
});

test("index.js wires the Preview's widget floor to PREVIEW_PANEL_MIN_H (via measurePreviewMinHeight), agreeing with clampPreviewSize's own height clamp rather than contradicting it", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(indexSource, /measurePreviewMinHeight/, "index.js must reference measurePreviewMinHeight for the Preview's own floor");
});

test("the grow-biased auto-fit mechanism is gone from render.mjs entirely -- refitNode/scheduleRefit/scheduleInitialFit/setNodeHeight/PANEL_MAX_H no longer exist, so nothing can silently start fighting a manual resize again", () => {
  assert.equal(render.refitNode, undefined);
  assert.equal(render.scheduleRefit, undefined);
  assert.equal(render.scheduleInitialFit, undefined);
  assert.equal(render.setNodeHeight, undefined);
  assert.equal(render.PANEL_MAX_H, undefined);
  assert.equal(render.CHROME, undefined);
});

test("clampGeneratorSize raises size[0] up to GENERATOR_MIN_W, and NEVER touches size[1] -- the Generator's panel still scrolls past its own floor, so its node height has no clamp of its own", () => {
  const size = [10, 999];
  clampGeneratorSize(size);
  assert.equal(size[0], GENERATOR_MIN_W);
  assert.equal(size[1], 999, "clampGeneratorSize must leave height completely untouched, even far below any floor");

  // A width already at/above the floor is left alone.
  const size2 = [GENERATOR_MIN_W + 40, 100];
  clampGeneratorSize(size2);
  assert.equal(size2[0], GENERATOR_MIN_W + 40);
  assert.equal(size2[1], 100);

  // Tolerant of a missing/non-numeric size.
  assert.doesNotThrow(() => clampGeneratorSize(null));
  assert.doesNotThrow(() => clampGeneratorSize(["nope"]));
});

test("clampPreviewSize raises size[0] up to PREVIEW_MIN_W AND size[1] up to PREVIEW_MIN_H -- unlike the Generator, the Preview's panel never scrolls (overflow: hidden), so its node height needs a real floor too", () => {
  // Below the floor on BOTH axes -- both get raised.
  const size = [10, 10];
  clampPreviewSize(size);
  assert.equal(size[0], PREVIEW_MIN_W);
  assert.equal(size[1], PREVIEW_MIN_H);

  // Width below, height already above -- only width moves.
  const size2 = [10, PREVIEW_MIN_H + 500];
  clampPreviewSize(size2);
  assert.equal(size2[0], PREVIEW_MIN_W);
  assert.equal(size2[1], PREVIEW_MIN_H + 500);

  // Both already at/above the floor -- neither moves.
  const size3 = [PREVIEW_MIN_W + 40, PREVIEW_MIN_H + 40];
  clampPreviewSize(size3);
  assert.deepEqual(size3, [PREVIEW_MIN_W + 40, PREVIEW_MIN_H + 40]);

  // Tolerant of a missing/non-numeric size, on either axis.
  assert.doesNotThrow(() => clampPreviewSize(null));
  assert.doesNotThrow(() => clampPreviewSize(["nope"]));
  assert.doesNotThrow(() => clampPreviewSize([100]));
});

test("PREVIEW_MIN_H >= PREVIEW_PANEL_MIN_H -- the node floor must always be at least as tall as the panel floor it wraps, plus whatever node chrome sits above the DOM widget", () => {
  assert.ok(PREVIEW_MIN_H >= PREVIEW_PANEL_MIN_H);
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

test("a manual resize survives every kind of repaint -- toggling a stage, expanding a section, editing a field inline, and a detailer block add all leave node.size exactly as the user (here, a direct setSize standing in for a manual drag) left it", () => {
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

  const highresHeader = findSectionHeader(refs.body, "Highres");
  fire(switchOf(highresHeader), "click"); // toggles a stage -> repaintGenerator internally
  assert.deepEqual(node.size, [DEFAULT_W, 150], "a stage toggle (and its repaint) must not touch node.size");

  fire(switchOf(findSectionHeader(refs.body, "Detailer")), "click"); // expand -> repaintGenerator internally (Detailer has a switch -- task 3)
  assert.deepEqual(node.size, [DEFAULT_W, 150], "expanding a section must not touch node.size");

  const detailerBody = sectionBodyOf(findSectionHeader(refs.body, "Detailer"));
  const addBtn = queryAll(detailerBody, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  fire(addBtn, "click"); // adds a detailer block, persists, and repaints in place
  assert.deepEqual(node.size, [DEFAULT_W, 150], "adding a detailer block must not touch node.size either");

  fire(switchOf(findSectionHeader(refs.body, "Detailer")), "click"); // collapse -> repaintGenerator internally
  assert.deepEqual(node.size, [DEFAULT_W, 150], "collapsing the section (and its repaint) must not touch node.size");
});

test("a manual resize survives a Preview repaint too (save/compare toggles, handleExecuted)", () => {
  const node = makePreviewNode({ imagesLink: 1, metadataLink: 1 });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountPreviewUI(node, ctx);
  node.setSize([node.size[0], 180]);

  handleExecuted(node, ctx, {
    anima_stages: [{ filename: "base.png", subfolder: "AnimaFlow", type: "output", stage: "base" }],
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

test("teardownNode is safe to call on a node with a section left expanded -- there is no popover left to leak, and the zoom listener still comes off", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  installZoomPassthrough(node, ctx);
  fire(switchOf(findSectionHeader(refs.body, "Highres")), "click"); // leave a section expanded (Highres has a switch -- task 3)
  assert.ok(sectionBodyOf(findSectionHeader(node._anRefs.body, "Highres")));

  assert.doesNotThrow(() => teardownNode(node));
  assert.equal((node._anRefs.root._listeners.wheel || []).length, 0, "the zoom listener must still come off");
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

test("a context-supplied sampler field renders as the SAME field shape, genuinely DISABLED, with a yellow warn ⓘ beside it naming the Context Bridge; an unsupplied one renders fully editable with no ⓘ at all", () => {
  const bridge = makeBridgeNode(2, ["seed"]);
  const graph = makeGraph({ 2: bridge }, { 1: { origin_id: 2, origin_slot: 0 } });
  const node = makeGeneratorNode({ contextLink: 1, graph });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  // Sampler starts EXPANDED by default (DEFAULT_EXPANDED_GENERATOR_SECTIONS
  // -- it's the one section with no enable switch, always relevant), so
  // there's nothing to click open here.
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
  assert.ok(body, "Sampler must be expanded by default");

  const seedField = findFieldByLabel(body, "seed");
  assert.ok(seedField && hasClass(seedField, "wtn-fld-num") && hasClass(seedField, "wtn-fld-disabled"),
    "seed is context-supplied -- must render as the SAME numeric field shape, genuinely disabled");
  const seedWrap = seedField.parentNode;
  assert.ok(hasClass(seedWrap, "wtn-an-fieldrow"), "a disabled field is paired with its ⓘ inside a .wtn-an-fieldrow wrapper");
  const seedIcon = seedWrap.children.find((c) => hasClass(c, "wtn-fld-info"));
  assert.ok(seedIcon && hasClass(seedIcon, "wtn-fld-info-warn"), "the ⓘ beside a context-supplied field must be the YELLOW warn variant");
  // The tooltip lives in `aria-label` now, NOT the native `title` attribute
  // -- js/shared/fields.mjs's `buildInfoIcon` doc comment (the native
  // tooltip's browser-controlled delay is what this whole dispatch replaces).
  assert.equal(seedIcon.title, "", "buildInfoIcon must set no `title` -- the native tooltip would double up with the themed one");
  assert.match(seedIcon.attributes["aria-label"], /Context Bridge/, "the ⓘ's tooltip must say WHERE the value comes from");
  assert.match(seedIcon.attributes["aria-label"], /disconnect that socket/i, "the tooltip must say how to get it back, not just that it's disabled");

  const stepsField = findFieldByLabel(body, "steps");
  assert.ok(stepsField && hasClass(stepsField, "wtn-fld-num") && !hasClass(stepsField, "wtn-fld-disabled"),
    "steps is NOT context-supplied -- must render as an editable numeric field");
  assert.ok(!hasClass(stepsField.parentNode, "wtn-an-fieldrow"), "an unsupplied field carries no ⓘ wrapper at all");
});

test("no Context Bridge resolved -- every sampler field renders editable, and the SECTION's own ⓘ (not a text block) says so", () => {
  const node = makeGeneratorNode({ contextLink: null });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  // Sampler starts EXPANDED by default -- nothing to click open here.
  const header = findSectionHeader(refs.body, "Sampler");
  const icon = header.children.find((c) => hasClass(c, "wtn-fld-info"));
  assert.ok(icon && !hasClass(icon, "wtn-fld-info-warn"), "no bridge resolved is the normal case -- the section's ⓘ is informational, not a warning");
  assert.equal(icon.title, "", "buildInfoIcon must set no `title`");
  assert.match(icon.attributes["aria-label"], /No Anima Context Bridge resolved/);

  const body = sectionBodyOf(header);
  assert.ok(!queryAll(body, (n) => hasClass(n, "wtn-fld-disabled")).length, "nothing should render disabled with no bridge resolved");
  const seedField = findFieldByLabel(body, "seed");
  assert.ok(seedField && hasClass(seedField, "wtn-fld-num") && !hasClass(seedField, "wtn-fld-disabled"));
});

test("fail-closed cases (context unwired, wired to a non-bridge, wired through a Reroute-shaped dead end, a cycle) all render every sampler field editable; even when a Reroute DOES resolve to a real bridge, a field the bridge itself doesn't wire stays editable", () => {
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);

  function assertAllEditable(node, label) {
    const refs = mountGeneratorUI(node, ctx);
    // Sampler starts EXPANDED by default -- nothing to click open here.
    const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
    for (const fieldLabel of ["seed", "steps", "cfg", "sampler_name", "scheduler"]) {
      const field = findFieldByLabel(body, fieldLabel);
      assert.ok(field, `${label}: ${fieldLabel} field must exist`);
      assert.ok(!hasClass(field, "wtn-fld-disabled"), `${label}: ${fieldLabel} must render editable`);
    }
  }

  assertAllEditable(makeGeneratorNode({ contextLink: null }), "context unwired");

  {
    const notABridge = { id: 2, type: "SomeOtherNode", inputs: [] };
    const graph = makeGraph({ 2: notABridge }, { 1: { origin_id: 2, origin_slot: 0 } });
    assertAllEditable(makeGeneratorNode({ contextLink: 1, graph }), "wired to a non-bridge");
  }

  {
    // A Reroute-shaped pass-through that never reaches anything -- a dead
    // end, distinct from the SUCCESSFUL Reroute-to-bridge case exercised
    // separately below.
    const dead = { id: 2, type: "Reroute", inputs: [{ name: "", link: null }] };
    const graph = makeGraph({ 2: dead }, { 1: { origin_id: 2, origin_slot: 0 } });
    dead.graph = graph;
    assertAllEditable(makeGeneratorNode({ contextLink: 1, graph }), "Reroute dead end");
  }

  {
    const a = { id: 2, type: "Reroute", inputs: [{ name: "", link: 20 }] };
    const b = { id: 3, type: "Reroute", inputs: [{ name: "", link: 10 }] };
    const graph = makeGraph({ 2: a, 3: b }, {
      1: { origin_id: 2, origin_slot: 0 },
      20: { origin_id: 3, origin_slot: 0 },
      10: { origin_id: 2, origin_slot: 0 }, // a cycle
    });
    a.graph = graph;
    b.graph = graph;
    assertAllEditable(makeGeneratorNode({ contextLink: 1, graph }), "a cycle");
  }

  {
    // The Reroute DOES resolve, to a REAL bridge -- but that bridge only
    // wires `scheduler`, so every OTHER sampler field must still be
    // editable; only `scheduler` itself renders disabled.
    const bridge = makeBridgeNode(3, ["scheduler"]);
    const reroute = { id: 2, type: "Reroute", inputs: [{ name: "", link: 20 }] };
    const graph = makeGraph({ 2: reroute, 3: bridge }, {
      1: { origin_id: 2, origin_slot: 0 },
      20: { origin_id: 3, origin_slot: 0 },
    });
    reroute.graph = graph;
    bridge.graph = graph;
    const node = makeGeneratorNode({ contextLink: 1, graph });
    const refs = mountGeneratorUI(node, ctx);
    const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
    for (const label of ["seed", "steps", "cfg", "sampler_name"]) {
      const field = findFieldByLabel(body, label);
      assert.ok(!hasClass(field, "wtn-fld-disabled"), `${label} isn't wired by the bridge -- must stay editable`);
    }
    const schedField = findFieldByLabel(body, "scheduler");
    assert.ok(hasClass(schedField, "wtn-fld-disabled"), "scheduler IS wired by the bridge -- must render disabled");
  }
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

test("toggling a stage switch (on the section HEADER itself) writes the generation_settings WIDGET, not just in-memory state", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  assert.equal(genState(node).highres.enabled, false);
  const header = findSectionHeader(refs.body, "Highres");
  fire(switchOf(header), "click");
  assert.equal(genState(node).highres.enabled, true);
});

test("dragging a numeric field (steps) INSIDE an expanded Sampler section writes the widget on release, live-painting during the drag", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  // Sampler starts EXPANDED by default -- nothing to click open here.
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
  const stepsField = findFieldByLabel(body, "steps");
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
  // Sampler starts EXPANDED by default -- nothing to click open here.
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
  const samplerField = findFieldByLabel(body, "sampler_name");
  const before = genState(node).sampler.sampler_name;
  const rightArrow = samplerField.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-right"));
  fire(rightArrow, "click");
  const after = genState(node).sampler.sampler_name;
  assert.notEqual(after, before, "the stepper must cycle AND persist immediately");
});

test("a boolean switch (mod guidance enabled -- now the SECTION HEADER's own switch, not a redundant field inside the body) writes the widget immediately", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const header = findSectionHeader(refs.body, "Mod Guidance");
  fire(switchOf(header), "click");
  assert.equal(genState(node).mod_guidance.enabled, true);
});

test("detailer section: adding respects MAX_DETAILER_PASSES and face/eye stay unremovable, all reaching the widget", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  fire(switchOf(findSectionHeader(refs.body, "Detailer")), "click"); // Detailer has a switch -- expand via it (task 3)
  let body = sectionBodyOf(findSectionHeader(refs.body, "Detailer"));

  const builtinBtn = queryAll(body, (n) => n.tagName === "button").find((b) => b.textContent === "built in");
  assert.ok(builtinBtn && builtinBtn.disabled);

  let addBtn = queryAll(body, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  fire(addBtn, "click");
  body = sectionBodyOf(findSectionHeader(refs.body, "Detailer")); // the whole body was rebuilt
  addBtn = queryAll(body, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  fire(addBtn, "click");
  let persisted = genState(node);
  assert.equal(Object.keys(persisted.detailer.blocks).length, MAX_DETAILER_PASSES);

  body = sectionBodyOf(findSectionHeader(refs.body, "Detailer"));
  const addBtnAgain = queryAll(body, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  assert.ok(addBtnAgain.disabled, "MAX_DETAILER_PASSES reached -- the + button must refuse further adds");
});

test("inherit_sampler_settings toggle (Highres) hides exactly cfg/sampler_name/scheduler, both directions, and persists", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  // Highres HAS a switch -- expand/collapse is the switch's job now (task 3),
  // not the header's; the header click test below covers the no-op case.
  fire(switchOf(findSectionHeader(refs.body, "Highres")), "click"); // expand -- inline, no popover
  let body = sectionBodyOf(findSectionHeader(refs.body, "Highres"));
  assert.ok(findFieldByLabel(body, "steps"));
  assert.ok(findFieldByLabel(body, "denoise"));
  assert.ok(!findFieldByLabel(body, "cfg"), "cfg hidden while inherit is ON");
  assert.ok(!findFieldByLabel(body, "sampler_name"));
  assert.ok(!findFieldByLabel(body, "scheduler"));

  const inheritField = queryAll(body, (n) => hasClass(n, "wtn-an-boolfield"))
    .find((f) => (f.children[0] || {}).textContent === "inherit");
  fire(inheritField.children.find((c) => hasClass(c, "wtn-fld-switch")), "click");
  body = sectionBodyOf(findSectionHeader(refs.body, "Highres"));
  assert.ok(findFieldByLabel(body, "cfg"), "cfg reappears once inherit is OFF");
  assert.ok(findFieldByLabel(body, "sampler_name"));
  assert.ok(findFieldByLabel(body, "scheduler"));
  assert.equal(genState(node).highres.inherit_sampler_settings, false);
});

// ===========================================================================
// E2. Inline sections -- expand/collapse, its persistence, and proof the
//     popover mechanism is genuinely gone (not just unreferenced by luck).
// ===========================================================================

test("a switched section's expand/collapse state (driven by its SWITCH, not its header -- task 3) persists across a rebuild, and reaches the serialized generation_settings widget", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  assert.equal(genState(node).ui_expanded.highres, false, "Highres starts collapsed by default");
  assert.ok(!sectionBodyOf(findSectionHeader(refs.body, "Highres")), "collapsed -- no body rendered at all");

  fire(switchOf(findSectionHeader(refs.body, "Highres")), "click");
  assert.equal(genState(node).ui_expanded.highres, true, "flipping the switch on must reach the serialized widget as expanded");
  assert.equal(genState(node).highres.enabled, true, "the SAME click also flips enabled -- the switch's whole point");
  assert.ok(sectionBodyOf(findSectionHeader(refs.body, "Highres")), "expanded -- the body actually renders");

  // A REBUILD (repaintGenerator, standing in for a fresh mount off the same
  // widget value) must come out expanded again -- this is what makes the
  // state genuinely persistent rather than a one-off in-memory flag.
  const rebuilt = repaintGenerator(node, ctx);
  assert.ok(sectionBodyOf(findSectionHeader(rebuilt.body, "Highres")), "still expanded after a repaint");

  fire(switchOf(findSectionHeader(rebuilt.body, "Highres")), "click");
  assert.equal(genState(node).ui_expanded.highres, false, "switching off must collapse (reach the widget) too");
  assert.equal(genState(node).highres.enabled, false);
  assert.ok(!sectionBodyOf(findSectionHeader(node._anRefs.body, "Highres")), "collapsed again -- no body rendered");
});

test("a switched section's HEADER click does nothing at all -- neither ui_expanded nor enabled changes, and no body appears", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  const before = JSON.parse(JSON.stringify(genState(node)));
  fire(findSectionHeader(refs.body, "Highres"), "click");
  const after = genState(node);
  assert.equal(after.ui_expanded.highres, before.ui_expanded.highres, "a switched section's header click must not touch ui_expanded");
  assert.equal(after.highres.enabled, before.highres.enabled, "a switched section's header click must not touch enabled either");
  assert.ok(!sectionBodyOf(findSectionHeader(refs.body, "Highres")), "still collapsed -- the header click is a genuine no-op for a switched section");
});

test("a SWITCHLESS section (Sampler) still expands/collapses on a header click -- the required carve-out, or its body would be unreachable", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  // Sampler starts expanded by default; collapse it via the header first.
  assert.ok(sectionBodyOf(findSectionHeader(refs.body, "Sampler")), "Sampler starts expanded by default");
  fire(findSectionHeader(refs.body, "Sampler"), "click");
  assert.equal(genState(node).ui_expanded.sampler, false, "Sampler's own header click must still toggle ui_expanded (no switch exists to do it instead)");
  assert.ok(!sectionBodyOf(findSectionHeader(refs.body, "Sampler")), "collapsed after the header click");

  fire(findSectionHeader(refs.body, "Sampler"), "click");
  assert.equal(genState(node).ui_expanded.sampler, true);
  assert.ok(sectionBodyOf(findSectionHeader(refs.body, "Sampler")), "re-expands on a second header click");
});

// ===========================================================================
// Header child order -- the no-jump invariant (task 2). chevron -> switch
// (if any) -> label -> ⓘ (if any) -> summary (if any), regardless of which
// optional pieces are present, so turning a section on/off never shifts
// anything but the summary itself.
// ===========================================================================

/** The real ORDER of a header's own direct children, as short class-derived
 * tags -- "chev"/"switch"/"label"/"info"/"summary" -- so a test can assert
 * on sequence without hand-walking `.children` at every call site. */
function headerChildKinds(header) {
  return header.children.map((c) => {
    if (hasClass(c, "wtn-an-chev")) return "chev";
    if (hasClass(c, "wtn-fld-switch")) return "switch";
    if (hasClass(c, "wtn-an-shead-nm")) return "label";
    if (hasClass(c, "wtn-fld-info")) return "info";
    if (hasClass(c, "wtn-an-shead-sum")) return "summary";
    return "?";
  });
}

test("header child order is chevron -> switch -> label -> ⓘ (no summary while disabled -- Highres always carries an ⓘ AND a switch)", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const header = findSectionHeader(refs.body, "Highres"); // starts disabled -> summary is null
  assert.deepEqual(headerChildKinds(header), ["chev", "switch", "label", "info"], "no summary while disabled -- but the first four never move");
});

test("header child order is the SAME (chevron -> switch -> label -> ⓘ) once a summary appears -- enabling only APPENDS the summary, never reorders anything else", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  fire(switchOf(findSectionHeader(refs.body, "Highres")), "click"); // enable -> gets a summary
  const header = findSectionHeader(refs.body, "Highres");
  assert.deepEqual(headerChildKinds(header), ["chev", "switch", "label", "info", "summary"], "chevron/switch/label/ⓘ must be in the EXACT same order as the disabled case above, with the summary appended at the end");
});

test("header child order for a SWITCHLESS section (Sampler): chevron -> label -> ⓘ -> summary -- switch is simply absent, nothing else shifts", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const header = findSectionHeader(refs.body, "Sampler");
  assert.deepEqual(headerChildKinds(header), ["chev", "label", "info", "summary"]);
});

// ===========================================================================
// ⓘ hover tooltip -- task 4. Delay constant, no native `title`, `aria-label`
// carries the text instead, and hide/cleanup actually removes the element
// from `doc.body` (never orphaned).
// ===========================================================================

test("INFO_TIP_DELAY_MS is exported and is 250", () => {
  assert.equal(fields.INFO_TIP_DELAY_MS, 250);
});

test("buildInfoIcon sets no native `title` (would double up with the themed tooltip) -- it sets `aria-label` instead", () => {
  const doc = makeDocStub();
  const icon = fields.buildInfoIcon(doc, "hello there");
  assert.equal(icon.title, "", "no native title attribute");
  assert.equal(icon.attributes["aria-label"], "hello there");
});

test("buildInfoIcon with no tooltip text sets neither title nor aria-label, and wires no hover behaviour", () => {
  const doc = makeDocStub();
  const icon = fields.buildInfoIcon(doc, "");
  assert.equal(icon.title, "");
  assert.equal(icon.attributes["aria-label"], undefined);
});

test("ⓘ hover tooltip: shows after the delay (mouseenter, driven by the stub window's synchronous setTimeout), appended to doc.body, and mouseleave removes it completely -- no orphan left behind", () => {
  const doc = makeDocStub();
  const win = makeWindowStub(doc);
  const icon = fields.buildInfoIcon(doc, "explains the field");
  assert.equal(doc.body.children.length, 0, "nothing shown before any hover");

  fire(icon, "mouseenter");
  assert.equal(doc.body.children.length, 1, "the tip mounts onto doc.body, not inside the icon's own tree");
  const tip = doc.body.children[0];
  assert.ok(hasClass(tip, "wtn-tip") && hasClass(tip, "wtn-fld-tip"));
  // `wtn` itself is REQUIRED, not decorative -- this element is appended to
  // doc.body, OUTSIDE any node's own `.wtn`-classed subtree, so without this
  // class theme.css's custom properties never resolve on it at all (a
  // live-only bug the headless stub can't otherwise catch, since jsdom-less
  // `getComputedStyle` here never evaluates `var()` at all).
  assert.ok(hasClass(tip, "wtn"), "the tip element must carry the `wtn` class itself so theme.css's custom properties resolve on it");
  assert.equal(tip.textContent, "explains the field");

  fire(icon, "mouseleave");
  assert.equal(doc.body.children.length, 0, "mouseleave must remove the tip element from doc.body entirely");
});

test("the shipped CSS's tooltip rule is the TWO-CLASS compound `.wtn-tip.wtn-fld-tip` (specificity 0-2-0), not `.wtn-fld-tip` alone -- that's what keeps this module's fallback colours/z-index winning over theme.css's un-fallback'd, later-injected `.wtn-tip` rule regardless of load order", () => {
  const doc = makeDocStub();
  fields.injectFieldStyles(doc);
  const style = doc.getElementById("wtn-fields-style");
  assert.ok(style, "js/shared/fields.mjs's own stylesheet must be injected");
  assert.match(style.textContent, /\.wtn-tip\.wtn-fld-tip\s*\{/, "the base rule must be the two-class compound selector");
  assert.match(style.textContent, /\.wtn-tip\.wtn-fld-tip\.show\s*\{/, "the .show rule must be the three-class compound selector too");
  // The regression this guards: a bare `.wtn-fld-tip` selector has the SAME
  // specificity (0-1-0) as theme.css's own `.wtn-tip` rule, so whichever
  // stylesheet lands LAST in document order would silently win -- and
  // theme.css's own dynamic `import()` always lands after this module's
  // synchronous injection.
  assert.ok(!/(^|[^.\w-])\.wtn-fld-tip\s*\{/.test(style.textContent), "must not ALSO ship a single-class `.wtn-fld-tip { ... }` rule that could out-order the compound one");
});

test("ⓘ hover tooltip: pointerdown and Escape both hide it too, and hiding twice is safe (no throw, no double-remove)", () => {
  const doc = makeDocStub();
  makeWindowStub(doc);
  const iconA = fields.buildInfoIcon(doc, "tip A");
  fire(iconA, "mouseenter");
  assert.equal(doc.body.children.length, 1);
  fire(iconA, "pointerdown");
  assert.equal(doc.body.children.length, 0);

  const iconB = fields.buildInfoIcon(doc, "tip B");
  fire(iconB, "mouseenter");
  assert.equal(doc.body.children.length, 1);
  assert.doesNotThrow(() => fire(iconB, "mouseleave"));
  assert.doesNotThrow(() => fire(iconB, "mouseleave")); // a second hide must be a safe no-op
  assert.equal(doc.body.children.length, 0);
});

test("hideActiveInfoTip closes whatever tip is currently showing -- the safety valve a full-body repaint calls before discarding its old icons (js/anima/interaction.mjs's repaintGenerator/repaintPreview/teardownNode)", () => {
  const doc = makeDocStub();
  makeWindowStub(doc);
  const icon = fields.buildInfoIcon(doc, "won't be orphaned");
  fire(icon, "mouseenter");
  assert.equal(doc.body.children.length, 1, "showing before the repaint-equivalent cleanup runs");
  fields.hideActiveInfoTip();
  assert.equal(doc.body.children.length, 0, "the old icon is about to be discarded -- its tip must not be left attached to doc.body");
  assert.doesNotThrow(() => fields.hideActiveInfoTip()); // nothing showing -- must still be a safe no-op
});

test("only one ⓘ tooltip is ever shown pack-wide at a time -- hovering a second icon closes the first icon's tip", () => {
  const doc = makeDocStub();
  makeWindowStub(doc);
  const iconA = fields.buildInfoIcon(doc, "tip A");
  const iconB = fields.buildInfoIcon(doc, "tip B");
  fire(iconA, "mouseenter");
  assert.equal(doc.body.children.length, 1);
  fire(iconB, "mouseenter");
  assert.equal(doc.body.children.length, 1, "still exactly one tip element -- A's own was closed, not left behind alongside B's");
  assert.equal(doc.body.children[0].textContent, "tip B");
});

test("repaintGenerator hides an active ⓘ tooltip before rebuilding the body -- the exact orphan case this dispatch guards against", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  // Sampler's header ⓘ is always present (bridge-found or not-found text,
  // never null) -- unlike Mod Guidance's, which is only shown when its
  // package is missing.
  const icon = findSectionHeader(refs.body, "Sampler").children.find((c) => hasClass(c, "wtn-fld-info"));
  fire(icon, "mouseenter");
  assert.equal(doc.body.children.length, 1, "tip showing on the OLD Sampler header, right before its body is discarded");
  repaintGenerator(node, ctx);
  assert.equal(doc.body.children.length, 0, "repaintGenerator must have closed it -- otherwise it's now orphaned, since the old icon is gone");
});

test("ui_expanded round-trips through a FRESH mount off a saved widget value -- a workflow reopens with the same sections expanded it was saved with", () => {
  const saved = normalizeGenerationSettings("{}");
  saved.ui_expanded = { sampler: false, mod_guidance: false, highres: true, detailer: false, upscale: false, postprocess: false };
  const node = makeGeneratorNode({ generation_settings: JSON.stringify(saved) });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  assert.ok(sectionBodyOf(findSectionHeader(refs.body, "Highres")), "Highres reopens expanded, as saved");
  assert.ok(!sectionBodyOf(findSectionHeader(refs.body, "Sampler")), "Sampler reopens collapsed, as saved");
});

test("normalizeExpandedSections: an unknown/garbage ui_expanded value falls back to defaults per-key, never throws; an unknown SECTION key inside it is dropped, not carried forward", () => {
  assert.deepEqual(normalizeExpandedSections(undefined, DEFAULT_EXPANDED_GENERATOR_SECTIONS), DEFAULT_EXPANDED_GENERATOR_SECTIONS);
  assert.deepEqual(normalizeExpandedSections("not an object", DEFAULT_EXPANDED_GENERATOR_SECTIONS), DEFAULT_EXPANDED_GENERATOR_SECTIONS);
  const out = normalizeExpandedSections({ highres: true, sampler: "not a bool", stale_key: true }, DEFAULT_EXPANDED_GENERATOR_SECTIONS);
  assert.equal(out.highres, true);
  assert.equal(out.sampler, DEFAULT_EXPANDED_GENERATOR_SECTIONS.sampler, "a non-boolean value falls back to the default");
  assert.ok(!("stale_key" in out), "an unknown section key never survives into the normalized result");
  assert.deepEqual(Object.keys(out).sort(), Object.keys(DEFAULT_EXPANDED_GENERATOR_SECTIONS).sort());
});

test("Python's own tolerant normalizer contract (src/anima/settings.py's _deep_merge_defaults) is what makes ui_expanded safe to keep OUT of DEFAULT_GENERATION_SETTINGS -- this JS side's OWN unknown-top-level-key passthrough (the same code path Python's `_deep_merge_defaults` port shares the contract with) round-trips ui_expanded exactly as written", () => {
  const raw = JSON.stringify({ ui_expanded: { highres: true, made_up_field: true } });
  const out = normalizeGenerationSettings(raw);
  assert.deepEqual(out.ui_expanded, { highres: true, made_up_field: true }, "an unknown top-level key (ui_expanded, and whatever's inside it) survives normalizeGenerationSettings verbatim -- ensureGenState is the ONLY place that later reshapes it via normalizeExpandedSections");
});

test("the popover mechanism is gone from js/anima/ entirely -- render.mjs's buildPopoverShell/buildClickRow/buildNote, interaction.mjs's closeActiveOverlay, and js/shared/fields.mjs's buildGear/buildDrivenField have no surviving export (matches the previous dispatch's pattern of asserting a deleted mechanism's exports are undefined)", () => {
  assert.equal(render.buildPopoverShell, undefined);
  assert.equal(render.buildClickRow, undefined);
  assert.equal(render.buildNote, undefined);
  assert.equal(interactionModule.closeActiveOverlay, undefined);
  assert.equal(interactionModule.openSamplerPopover, undefined);
  assert.equal(interactionModule.openModGuidancePopover, undefined);
  assert.equal(interactionModule.openHighresPopover, undefined);
  assert.equal(interactionModule.openUpscalePopover, undefined);
  assert.equal(interactionModule.openPostprocessPopover, undefined);
  assert.equal(interactionModule.openDetailerPopover, undefined);
  assert.equal(interactionModule.openSavePopover, undefined);
  assert.equal(fields.buildGear, undefined);
  assert.equal(fields.buildDrivenField, undefined);
  // The new inline-section shape IS exported, so this isn't "everything's gone".
  assert.equal(typeof render.buildSectionHeader, "function");
  assert.equal(typeof fields.buildInfoIcon, "function");
});

test("interaction.mjs no longer imports js/shared/overlay.mjs at all -- a static source scan (comments stripped, so this file's OWN doc comments discussing the deletion don't trip the check) mirroring how the previous dispatch proved a deleted call site never survives in index.js", () => {
  const src = readFileSync(path.join(__dirname, "interaction.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /overlay\.mjs/);
  assert.doesNotMatch(code, /openOverlayWithZoom/);
  assert.doesNotMatch(code, /activeOverlayRef/);
  assert.doesNotMatch(code, /closeOverlayIfOwnedBy/);
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
    anima_stages: [
      { filename: "base.png", subfolder: "AnimaFlow", type: "temp", stage: "base" },
      { filename: "final.png", subfolder: "AnimaFlow", type: "output", stage: "final" },
    ],
  });

  assert.ok(node._anPreviewImages.base);
  assert.ok(node._anPreviewImages.final);
  const wipe = node._anRefs.wipeEl;
  assert.ok(!hasClass(wipe, "wtn-an-single"), "both default compare stages (base/final) are present -- dual pane");
});

test("Preview: handleExecuted IGNORES a legacy message.images payload -- only message.anima_stages populates node._anPreviewImages, no dual-key fallback", () => {
  const node = makePreviewNode({ imagesLink: 1, metadataLink: 1 });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountPreviewUI(node, ctx);

  handleExecuted(node, ctx, {
    images: [
      { filename: "base.png", subfolder: "AnimaFlow", type: "output", stage: "base" },
      { filename: "final.png", subfolder: "AnimaFlow", type: "output", stage: "final" },
    ],
  });

  assert.ok(!node._anPreviewImages, "a legacy 'images' key must never populate node._anPreviewImages (handleExecuted bails out entirely -- no anima_stages, no repaint)");
  const wipe = node._anRefs.wipeEl;
  const empty = queryAll(wipe, (n) => hasClass(n, "wtn-an-empty"))[0];
  assert.ok(empty, "with nothing under anima_stages, the wipe stays on its placeholder rather than reviving the double-preview bug");
});

test("Preview: a ONE-entry run degrades to a single-image view, never a broken dual pane", () => {
  const node = makePreviewNode({ imagesLink: 1, metadataLink: 1 });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountPreviewUI(node, ctx);

  handleExecuted(node, ctx, {
    anima_stages: [{ filename: "base.png", subfolder: "AnimaFlow", type: "output", stage: "base" }],
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

test("Preview: the Save section's own header switch reaches the preview_state widget immediately", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const header = findSectionHeader(refs.body, "Save");
  fire(switchOf(header), "click");
  assert.equal(previewState(node).save.enabled, false);
});

test("Preview: ui_expanded.save (driven by the Save section's own SWITCH, not its header) persists across a repaint and reaches the serialized preview_state widget, same contract as the Generator's sections", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);

  assert.equal(previewState(node).ui_expanded.save, false);
  // Save HAS a switch -- a header click is a no-op for it (task 3); flip
  // the switch instead. `makePreviewNode`'s default state has save.enabled
  // already true, so this first click turns it OFF (and collapses it);
  // click again to land on enabled+expanded.
  fire(switchOf(findSectionHeader(refs.body, "Save")), "click");
  fire(switchOf(findSectionHeader(refs.body, "Save")), "click");
  assert.equal(previewState(node).ui_expanded.save, true);
  assert.equal(previewState(node).save.enabled, true);
  assert.ok(sectionBodyOf(findSectionHeader(refs.body, "Save")));

  const rebuilt = repaintPreview(node, ctx);
  assert.ok(sectionBodyOf(findSectionHeader(rebuilt.body, "Save")), "still expanded after a repaint");
});

test("Preview: the Save section's HEADER click does nothing -- neither ui_expanded nor enabled changes, and no body appears", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);

  const before = JSON.parse(JSON.stringify(previewState(node)));
  fire(findSectionHeader(refs.body, "Save"), "click");
  const after = previewState(node);
  assert.equal(after.ui_expanded.save, before.ui_expanded.save);
  assert.equal(after.save.enabled, before.save.enabled);
  assert.ok(!sectionBodyOf(findSectionHeader(refs.body, "Save")), "still collapsed -- header click is a no-op");
});

test("normalizeExpandedSections applied against DEFAULT_EXPANDED_PREVIEW_SECTIONS (the Preview's own defaults, distinct from the Generator's) defaults 'save' to collapsed", () => {
  assert.deepEqual(normalizeExpandedSections(undefined, DEFAULT_EXPANDED_PREVIEW_SECTIONS), { save: false });
  assert.deepEqual(DEFAULT_EXPANDED_PREVIEW_SECTIONS, { save: false });
});

// ===========================================================================
// H. Socket self-healing -- `interaction.mjs`'s `healNodeSockets`/
//    `computeNodeDefinition` reconcile an already-restored node's `inputs`/
//    `outputs` against the CURRENT `nodeData` for its class. Never touches
//    `window.LiteGraph` (`nodeData` IS the definition, captured directly in
//    `beforeRegisterNodeDef`'s own closure -- see index.js), so no registry
//    stub is needed here at all -- just the real `INPUT_TYPES`/
//    `RETURN_TYPES` shape ComfyUI would hand it, mirrored below from
//    `nodes/anima/generator.py`/`preview.py`/`context_bridge.py`.
// ===========================================================================

// Real `nodeData` shapes -- mirrors the CURRENT `INPUT_TYPES`/`RETURN_TYPES`
// exactly (never the eleven-socket surface `d021c09` deleted).
const GENERATOR_NODE_DATA = {
  name: "AnimaGenerator",
  input: {
    required: {
      context: ["ANIMA_CONTEXT", {}],
      generation_settings: ["STRING", { default: "{}" }],
    },
    optional: {},
    hidden: { unique_id: "UNIQUE_ID" },
  },
  output: ["IMAGE", "LATENT", "STRING"],
  output_name: ["images", "latent", "metadata_json"],
};

const PREVIEW_NODE_DATA = {
  name: "AnimaPreview",
  input: {
    required: {
      preview_state: ["STRING", { default: "{}" }],
    },
    optional: {
      images: ["IMAGE", {}],
      metadata_json: ["STRING", { default: "" }],
    },
    hidden: { prompt: "PROMPT", extra_pnginfo: "EXTRA_PNGINFO" },
  },
  output: [],
  output_name: [],
};

const BRIDGE_NODE_DATA = {
  name: "AnimaContextBridge",
  input: {
    required: {},
    optional: {
      model: ["MODEL", {}],
      clip: ["CLIP", {}],
      vae: ["VAE", {}],
      positive: ["CONDITIONING", {}],
      negative: ["CONDITIONING", {}],
      latent: ["LATENT", {}],
      seed: ["INT", { forceInput: true }],
      steps: ["INT", { forceInput: true }],
      cfg: ["FLOAT", { forceInput: true }],
      sampler_name: [["euler", "euler_ancestral"], { forceInput: true }],
      scheduler: [["simple", "karras"], { forceInput: true }],
    },
  },
  output: ["ANIMA_CONTEXT"],
  output_name: ["context"],
};

/** A real-enough fake litegraph graph -- just the one thing
 * `healNodeSockets`/`retargetSlot` actually reads: a plain `{id: LLink}`
 * map. */
function makeLinkGraph() {
  return { links: {} };
}
function addLink(graph, id, originId, originSlot, targetId, targetSlot) {
  graph.links[id] = { id, origin_id: originId, origin_slot: originSlot, target_id: targetId, target_slot: targetSlot };
  return graph.links[id];
}

/** A fake node whose `removeInput`/`removeOutput` mirror litegraph's OWN
 * documented bookkeeping (tear down the removed slot's own link(s); shift
 * every LATER slot's `target_slot`/`origin_slot` down by one) rather than a
 * bare splice -- so these tests actually exercise the "prefer the API
 * methods" contract `healNodeSockets` is built around, not a stand-in that
 * happens to pass regardless. */
function makeHealableNode({ id = 1, inputs = [], outputs = [], graph = null } = {}) {
  const node = {
    id,
    graph,
    inputs: inputs.map((i) => ({ ...i })),
    outputs: outputs.map((o) => ({ ...o, links: (o.links || []).slice() })),
    removeInput(idx) {
      const removed = node.inputs[idx];
      if (removed && removed.link != null && node.graph) {
        delete node.graph.links[removed.link];
      }
      node.inputs.splice(idx, 1);
      node.inputs.forEach((inp, i) => {
        if (i < idx) {
          return;
        }
        if (inp.link != null && node.graph && node.graph.links[inp.link]) {
          node.graph.links[inp.link].target_slot = i;
        }
      });
    },
    removeOutput(idx) {
      const removed = node.outputs[idx];
      if (removed && node.graph) {
        (removed.links || []).forEach((lid) => delete node.graph.links[lid]);
      }
      node.outputs.splice(idx, 1);
      node.outputs.forEach((out, i) => {
        if (i < idx) {
          return;
        }
        (out.links || []).forEach((lid) => {
          if (node.graph && node.graph.links[lid]) {
            node.graph.links[lid].origin_slot = i;
          }
        });
      });
    },
  };
  return node;
}

test("computeNodeDefinition: the real AnimaGenerator/AnimaPreview/AnimaContextBridge nodeData shapes resolve to their exact expected order", () => {
  assert.deepEqual(computeNodeDefinition(GENERATOR_NODE_DATA), {
    inputOrder: ["context", "generation_settings"],
    outputs: [
      { name: "images", type: "IMAGE" },
      { name: "latent", type: "LATENT" },
      { name: "metadata_json", type: "STRING" },
    ],
  });
  assert.deepEqual(computeNodeDefinition(PREVIEW_NODE_DATA), {
    inputOrder: ["preview_state", "images", "metadata_json"],
    outputs: [],
  });
  assert.deepEqual(computeNodeDefinition(BRIDGE_NODE_DATA), {
    inputOrder: ["model", "clip", "vae", "positive", "negative", "latent", "seed", "steps", "cfg", "sampler_name", "scheduler"],
    outputs: [{ name: "context", type: "ANIMA_CONTEXT" }],
  });
});

test("computeNodeDefinition: missing/empty/malformed nodeData all resolve to null -- never a definition to heal against", () => {
  assert.equal(computeNodeDefinition(undefined), null);
  assert.equal(computeNodeDefinition(null), null);
  assert.equal(computeNodeDefinition("AnimaGenerator"), null);
  assert.equal(computeNodeDefinition({}), null);
  assert.equal(computeNodeDefinition({ input: {}, output: [] }), null, "both input keys AND output empty -- indistinguishable from broken, must not heal");
  assert.equal(computeNodeDefinition({ input: { required: "not-an-object" }, output: [] }), null);
  assert.equal(computeNodeDefinition({ input: { required: {}, optional: [] }, output: [] }), null);
  assert.equal(computeNodeDefinition({ input: {}, output: "not-an-array" }), null);
  assert.equal(computeNodeDefinition({ input: {}, output: [], output_name: "nope" }), null);
  // A REAL, non-empty definition with only inputs (AnimaPreview's own
  // RETURN_TYPES == ()) or only outputs must NOT be refused.
  assert.notEqual(computeNodeDefinition(PREVIEW_NODE_DATA), null);
});

test("healNodeSockets: missing/malformed nodeData leaves inputs/outputs completely untouched -- same array reference, same contents, changed:false", () => {
  const graph = makeLinkGraph();
  addLink(graph, 5, 10, 0, 1, 0);
  const node = makeHealableNode({
    id: 1,
    graph,
    inputs: [
      { name: "context", type: "ANIMA_CONTEXT", link: 5 },
      { name: "positive", type: "CONDITIONING", link: null },
    ],
    outputs: [{ name: "images", type: "IMAGE", links: [] }],
  });
  const originalInputs = node.inputs;
  const originalOutputs = node.outputs;

  [undefined, null, {}, { input: {}, output: [] }, "AnimaGenerator"].forEach((badNodeData) => {
    const summary = healNodeSockets(node, badNodeData);
    assert.equal(summary.changed, false);
    assert.equal(node.inputs, originalInputs, "inputs array reference must be untouched");
    assert.equal(node.outputs, originalOutputs, "outputs array reference must be untouched");
  });
  assert.deepEqual(node.inputs.map((i) => i.name), ["context", "positive"]);
});

test("healNodeSockets: the real-world stale AnimaGenerator shape (context + the eleven deleted sockets; images/latent/metadata_json each duplicated) heals to [context] / [images, latent, metadata_json]", () => {
  const graph = makeLinkGraph();
  addLink(graph, 1, 100, 0, 1, 0); // context's own link
  addLink(graph, 2, 1, 0, 200, 0); // images' own link
  const node = makeHealableNode({
    id: 1,
    graph,
    inputs: [
      { name: "context", type: "ANIMA_CONTEXT", link: 1 },
      { name: "positive", type: "CONDITIONING", link: null },
      { name: "negative", type: "CONDITIONING", link: null },
      { name: "model", type: "MODEL", link: null },
      { name: "clip", type: "CLIP", link: null },
      { name: "vae", type: "VAE", link: null },
      { name: "latent", type: "LATENT", link: null },
      { name: "seed", type: "INT", link: null },
      { name: "steps", type: "INT", link: null },
      { name: "cfg", type: "FLOAT", link: null },
      { name: "sampler_name", type: "COMBO", link: null },
      { name: "scheduler", type: "COMBO", link: null },
    ],
    outputs: [
      { name: "images", type: "IMAGE", links: [2] },
      { name: "latent", type: "LATENT", links: [] },
      { name: "metadata_json", type: "STRING", links: [] },
      { name: "latent", type: "LATENT", links: [] },
      { name: "metadata_json", type: "STRING", links: [] },
    ],
  });

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.equal(summary.changed, true);
  assert.deepEqual(node.inputs.map((i) => i.name), ["context"]);
  assert.deepEqual(node.outputs.map((o) => o.name), ["images", "latent", "metadata_json"]);
  assert.deepEqual(summary.removedInputs, [
    "positive", "negative", "model", "clip", "vae", "latent", "seed", "steps", "cfg", "sampler_name", "scheduler",
  ]);
  assert.deepEqual(summary.removedOutputs, ["latent", "metadata_json"]);

  // The surviving `context` input's link is untouched (still slot 0).
  assert.equal(node.inputs[0].link, 1);
  assert.equal(graph.links[1].target_slot, 0);
  // The surviving `images` output's link is untouched (still slot 0).
  assert.deepEqual(node.outputs[0].links, [2]);
  assert.equal(graph.links[2].origin_slot, 0);
});

test("healNodeSockets: duplicate outputs collapse to exactly one each, keeping the FIRST occurrence and its own link -- the duplicate's link is torn down, not left dangling", () => {
  const graph = makeLinkGraph();
  addLink(graph, 10, 1, 1, 50, 0); // the FIRST "latent" output's own link
  addLink(graph, 11, 1, 3, 51, 0); // the DUPLICATE "latent" output's own (different) link
  const node = makeHealableNode({
    id: 1,
    graph,
    inputs: [{ name: "context", type: "ANIMA_CONTEXT", link: null }],
    outputs: [
      { name: "images", type: "IMAGE", links: [] },
      { name: "latent", type: "LATENT", links: [10] },
      { name: "metadata_json", type: "STRING", links: [] },
      { name: "latent", type: "LATENT", links: [11] },
    ],
  });

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.deepEqual(node.outputs.map((o) => o.name), ["images", "latent", "metadata_json"]);
  assert.deepEqual(summary.removedOutputs, ["latent"]);
  assert.deepEqual(node.outputs[1].links, [10], "the FIRST occurrence's own link survives");
  assert.equal(graph.links[10].origin_slot, 1);
  assert.equal(graph.links[11], undefined, "the duplicate's own link must be gone, not left dangling");
});

test("healNodeSockets: a link on a SURVIVING input is preserved and retargeted to its new slot index; a link on a REMOVED input is gone from the graph's own links table", () => {
  const graph = makeLinkGraph();
  addLink(graph, 1, 5, 0, 1, 1); // stale "positive" input, wired
  addLink(graph, 2, 6, 0, 1, 0); // "context" input, wired
  const node = makeHealableNode({
    id: 1,
    graph,
    inputs: [
      { name: "context", type: "ANIMA_CONTEXT", link: 2 },
      { name: "positive", type: "CONDITIONING", link: 1 },
    ],
    outputs: [],
  });

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.deepEqual(node.inputs.map((i) => i.name), ["context"]);
  assert.equal(node.inputs[0].link, 2, "the surviving context input keeps its own link id");
  assert.equal(graph.links[2].target_slot, 0, "and that link is retargeted to context's own (unchanged) index");
  assert.equal(graph.links[1], undefined, "the removed positive input's own link must be gone");
  assert.deepEqual(summary.removedInputs, ["positive"]);
});

test("healNodeSockets: surviving AnimaContextBridge inputs are reordered to the definition's own order, and every surviving link is RETARGETED to match (never left pointing at the old index)", () => {
  const graph = makeLinkGraph();
  addLink(graph, 1, 10, 0, 1, 0); // "scheduler"'s own link, wired while scheduler sits at index 0
  addLink(graph, 2, 11, 0, 1, 1); // "model"'s own link, wired while model sits at index 1
  const node = makeHealableNode({
    id: 1,
    graph,
    // Deliberately out of order versus OPTIONAL_KEY_ORDER (model, clip, vae,
    // positive, negative, latent, seed, steps, cfg, sampler_name, scheduler).
    inputs: [
      { name: "scheduler", type: "COMBO", link: 1 },
      { name: "model", type: "MODEL", link: 2 },
      { name: "clip", type: "CLIP", link: null },
    ],
    outputs: [{ name: "context", type: "ANIMA_CONTEXT", links: [] }],
  });

  const summary = healNodeSockets(node, BRIDGE_NODE_DATA);

  assert.deepEqual(node.inputs.map((i) => i.name), ["model", "clip", "scheduler"]);
  assert.equal(summary.changed, true);
  assert.deepEqual(summary.removedInputs, [], "nothing dead or duplicate here -- purely a reorder");
  assert.equal(node.inputs[0].link, 2);
  assert.equal(graph.links[2].target_slot, 0, "model is now index 0");
  assert.equal(node.inputs[2].link, 1);
  assert.equal(graph.links[1].target_slot, 2, "scheduler is now index 2, not the index it used to have");
});

test("healNodeSockets: an already-correct instance is left byte-identical -- same array references, same objects, changed:false, and removeInput/removeOutput are never even called", () => {
  const graph = makeLinkGraph();
  addLink(graph, 1, 10, 0, 1, 0);
  const node = makeHealableNode({
    id: 1,
    graph,
    inputs: [{ name: "context", type: "ANIMA_CONTEXT", link: 1 }],
    outputs: [
      { name: "images", type: "IMAGE", links: [] },
      { name: "latent", type: "LATENT", links: [] },
      { name: "metadata_json", type: "STRING", links: [] },
    ],
  });
  const originalInputs = node.inputs;
  const originalOutputs = node.outputs;
  const originalInputObj = node.inputs[0];
  let removeInputCalled = false;
  let removeOutputCalled = false;
  const realRemoveInput = node.removeInput;
  const realRemoveOutput = node.removeOutput;
  node.removeInput = (...a) => {
    removeInputCalled = true;
    return realRemoveInput.apply(node, a);
  };
  node.removeOutput = (...a) => {
    removeOutputCalled = true;
    return realRemoveOutput.apply(node, a);
  };

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.equal(summary.changed, false);
  assert.equal(node.inputs, originalInputs);
  assert.equal(node.outputs, originalOutputs);
  assert.equal(node.inputs[0], originalInputObj);
  assert.equal(removeInputCalled, false);
  assert.equal(removeOutputCalled, false);
  assert.deepEqual(summary.removedInputs, []);
  assert.deepEqual(summary.removedOutputs, []);
});

test("healNodeSockets: the fallback removal path (a node with no removeInput/removeOutput methods at all) still tears down the removed link and reindexes the survivor", () => {
  const graph = makeLinkGraph();
  addLink(graph, 1, 10, 0, 1, 0); // context, wired
  addLink(graph, 2, 11, 0, 1, 1); // stale positive, wired
  const node = {
    id: 1,
    graph,
    inputs: [
      { name: "positive", type: "CONDITIONING", link: 2 },
      { name: "context", type: "ANIMA_CONTEXT", link: 1 },
    ],
    outputs: [],
  }; // deliberately no removeInput/removeOutput -- exercises the fallback branch

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.deepEqual(node.inputs.map((i) => i.name), ["context"]);
  assert.equal(node.inputs[0].link, 1);
  assert.equal(graph.links[1].target_slot, 0);
  assert.equal(graph.links[2], undefined, "the removed positive input's own link must be gone");
  assert.deepEqual(summary.removedInputs, ["positive"]);
});

test("index.js: socket healing (healNodeSockets) is wired into onConfigure only -- never onNodeCreated, so a freshly-created node is never healed (only a restored one)", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const createdIdx = indexSource.indexOf("nodeType.prototype.onNodeCreated = function");
  const configureIdx = indexSource.indexOf("nodeType.prototype.onConfigure = function");
  const afterConfigureIdx = indexSource.indexOf("if (!mountsUi)", configureIdx);
  assert.ok(createdIdx >= 0, "onNodeCreated patch must exist");
  assert.ok(configureIdx > createdIdx, "onConfigure patch must come after onNodeCreated");
  assert.ok(afterConfigureIdx > configureIdx, "the mountsUi-only-hooks guard must come after onConfigure");

  const onNodeCreatedBlock = indexSource.slice(createdIdx, configureIdx);
  const onConfigureBlock = indexSource.slice(configureIdx, afterConfigureIdx);
  // Match the actual CALL SITE (`healNodeSockets(`), not just the bare
  // identifier -- the doc comment directly above `onConfigure` (still
  // inside `onNodeCreatedBlock`, since that slice runs up to the next
  // assignment) legitimately mentions `healNodeSockets` by name while
  // explaining why it is NOT called from `onNodeCreated`.
  assert.doesNotMatch(onNodeCreatedBlock, /healNodeSockets\(/, "onNodeCreated must never heal -- a fresh node is already correct");
  assert.match(onConfigureBlock, /healNodeSockets\(/, "onConfigure must be the one place healing runs");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
