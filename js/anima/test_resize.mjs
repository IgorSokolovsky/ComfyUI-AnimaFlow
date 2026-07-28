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
 *   E3. Post-run context truth (2026-07-28, Bridge-repaint + Use-Everywhere
 *      dispatch) — `resolveDownstreamGenerators` walks FORWARD from a
 *      bridge's own "context" output: direct bridge -> generator; through
 *      one and through several pass-throughs; fanning out to MULTIPLE
 *      generators from one output; unwired / a dangling link / a cycle all
 *      resolve to `[]`; a real node that's neither a pass-through nor a
 *      generator is simply not followed past. `handleGeneratorExecuted`
 *      stashes `message.anima_context` onto `node._anContextRun` and
 *      repaints; a payload with no `anima_context` key (e.g. one that only
 *      carries `images`) is ignored outright. `computeEffectiveContextSupplied`
 *      merges the live link view with the last run's own report: live-only,
 *      run-only (the Use-Everywhere case — no bridge resolves at all),
 *      both (live wins the TOOLTIP text, the run's own value still shows),
 *      and neither; `clearContextRun` (what both `index.js`
 *      `onConnectionsChange` hooks call on every rewire) wipes it back to
 *      "neither". A run-supplied field's disabled value is the RUN's own
 *      number; a run that reported supplied with no value falls back to
 *      the settings value. `node._anContextRun` never reaches the
 *      serialized `generation_settings` widget.
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
import { applyNodeChrome, CHROME_BODY, CHROME_TITLE } from "../shared/node_chrome.mjs";
import { activeOverlayRef, closeActiveOverlay } from "../shared/overlay.mjs";

import {
  GENERATION_SETTINGS_SCHEMA,
  MAX_DETAILER_PASSES,
  STAGE_ORDER,
  DEFAULT_EXPANDED_GENERATOR_SECTIONS,
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
  BASE_FONT,
  SHEAD_H,
  SHEAD_GAP,
} from "./render.mjs";

import * as interactionModule from "./interaction.mjs";
import {
  getGenSettingsWidget,
  getPreviewStateWidget,
  ensureGenState,
  persistGenState,
  resolveContextBridge,
  computeContextSupplied,
  resolveDownstreamGenerators,
  computeEffectiveContextSupplied,
  clearContextRun,
  mountGeneratorUI,
  repaintGenerator,
  mountPreviewUI,
  repaintPreview,
  wipeXFromEvent,
  handleExecuted,
  handleGeneratorExecuted,
  normalizeAnimaContextPayload,
  normalizeAnimaStagesPayload,
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
  // 2026-07-28 (hybrid essentials/⚙ dispatch): `js/shared/overlay.mjs` is
  // back in this track for anchored MENUS (option lists, ⚙ menus) -- its
  // `activeOverlayRef` singleton is shared with `js/controls/test_resize.mjs`
  // WITHIN THIS PROCESS (same imported module instance), so a test that
  // opens one and doesn't explicitly close it could otherwise leak into the
  // next test in THIS file. Closing before every test (not just after)
  // guarantees each test starts from a clean slate regardless of what the
  // previous one left open.
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
/** A header's own ⚙ (`js/shared/fields.mjs`'s `buildGearIcon`, `.wtn-fld-gear`)
 * -- `null` for a section with none. */
function gearOf(header) {
  return header.children.find((c) => hasClass(c, "wtn-fld-gear"));
}
/** Clicks a header's ⚙ (asserting one exists) and returns the CONTENT box
 * the ⚙'s `openAdvancedMenu` actually built -- `activeOverlayRef.current.
 * overlay` is the fixed-position wrapper `js/shared/overlay.mjs`'s
 * `openOverlay` appends to `doc.body`; its one child is the real
 * `.wtn-an-menu.wtn-an-advmenu` box. A `rebuildMenu()` call (e.g. flipping
 * `inherit_sampler_settings` inside the menu) replaces THAT box's own
 * children in place without ever swapping the box itself or closing the
 * overlay, so re-querying the SAME returned reference after such an edit
 * sees the rebuilt content -- callers don't need to call this twice. */
function openGearMenu(header) {
  const gear = gearOf(header);
  assert.ok(gear, "expected a ⚙ on this header");
  fire(gear, "click");
  assert.ok(activeOverlayRef.current, "expected an overlay to be open after clicking ⚙");
  return activeOverlayRef.current.overlay.children[0];
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

function makeBridgeNode(id, wiredFields = [], outputLinks = []) {
  const ALL = ["model", "clip", "vae", "positive", "negative", "latent", "seed", "steps", "cfg", "sampler_name", "scheduler"];
  return {
    id,
    type: "AnimaContextBridge",
    inputs: ALL.map((name) => ({ name, link: wiredFields.includes(name) ? 99 : null })),
    // The forward walk (`resolveDownstreamGenerators`) reads THIS -- the
    // bridge's own "context" OUTPUT, fanning out across every link id here.
    // Absent/empty by default so every EXISTING backward-walk fixture (none
    // of which cares about outputs) is unaffected.
    outputs: [{ name: "context", type: "ANIMA_CONTEXT", links: outputLinks }],
  };
}

function makeCtx(doc, overrides = {}) {
  return {
    doc,
    getCanvasEl: overrides.getCanvasEl || (() => null),
    havePackages: overrides.havePackages || (() => ({ spectrum: true, usdu: true, impact: true })),
    // Default stub: both installed-file lists are non-empty and contain the
    // exact upstream defaults `state.mjs`'s `DEFAULT_GENERATION_SETTINGS`
    // ships (`sam3.1_multiplex_fp16.safetensors` / `2x-AnimeSharpV4_Fast_
    // RCAN_PU.safetensors`) -- the "happy path" every OTHER Detailer/Upscale
    // test in this suite already exercises, unaffected by this task's own
    // model-file-picker tests overriding it explicitly.
    getKnownLists: overrides.getKnownLists || (() => ({
      checkpoints: ["sam3.1_multiplex_fp16.safetensors"],
      upscale_models: ["2x-AnimeSharpV4_Fast_RCAN_PU.safetensors"],
    })),
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

test("⚙ pin-right mechanism (chevron/gear legibility fix, task item 2): .wtn-an-shead-sum ALSO carries flex: 1 1 auto (not just margin-left: auto) so it actively consumes the row's free space, and .wtn-an-shead .wtn-fld-gear carries its own margin-left: auto -- together these are what put the ⚙ in the exact same spot whether a summary exists or not (see .wtn-an-shead's own CSS comment for the flex-resolution-before-auto-margins reasoning)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;

  const sum = cssRuleBody(cssText, ".wtn-an-shead .wtn-an-shead-sum");
  assert.ok(sum, "expected a .wtn-an-shead .wtn-an-shead-sum rule in the injected CSS");
  assert.match(sum, /flex:\s*1\s+1\s+auto/, ".wtn-an-shead-sum must grow AND shrink to fill the space between the fixed-left group and the ⚙ -- this is what makes the ⚙'s own position independent of the summary's presence/length");

  const gearPin = cssRuleBody(cssText, ".wtn-an-shead .wtn-fld-gear");
  assert.ok(gearPin, "expected a .wtn-an-shead .wtn-fld-gear rule (the header-scoped pin-right, distinct from .wtn-fld-gear's own base rule in js/shared/fields.mjs)");
  assert.match(gearPin, /margin-left:\s*auto/, "the ⚙ must pin itself to the row's right edge when there is no summary to already claim the free space");
});

test("chevron glyph CSS (chevron/gear legibility fix): .wtn-an-chev's font-size matches SHEAD_GLYPH_SIZE (bigger than 14px body text, not merely equal to it) and its colour is no longer --wtn-ink-faint", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  const chev = cssRuleBody(cssText, ".wtn-an-shead .wtn-an-chev");
  assert.ok(chev, "expected a .wtn-an-shead .wtn-an-chev rule in the injected CSS");
  assert.match(chev, new RegExp(`font-size:\\s*${render.SHEAD_GLYPH_SIZE}px`), ".wtn-an-chev's font-size must match SHEAD_GLYPH_SIZE exactly");
  assert.ok(render.SHEAD_GLYPH_SIZE > render.BASE_FONT, "SHEAD_GLYPH_SIZE must be strictly larger than the row's own body font -- the glyph reads smaller than its font-size suggests");
  assert.ok(!/--wtn-ink-faint/.test(chev), ".wtn-an-chev must not use --wtn-ink-faint any more (docs/THEME.md: that token is for placeholders/disabled/idle, not a visible state indicator)");
  assert.match(chev, /--wtn-ink-dim/, ".wtn-an-chev must use --wtn-ink-dim, the token that actually reads against --wtn-surface-2");
});

test("gear glyph CSS (chevron/gear legibility fix, shared js/shared/fields.mjs primitive): .wtn-fld-gear's font-size matches FLD_GEAR_SIZE, its colour is no longer --wtn-ink-faint, and it has a real (>=20px square) hit area sized to FLD_GEAR_HIT", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-fields-style").textContent;
  const gear = cssRuleBody(cssText, ".wtn-fld-gear");
  assert.ok(gear, "expected a .wtn-fld-gear rule in the injected CSS");
  assert.match(gear, new RegExp(`font-size:\\s*${fields.FLD_GEAR_SIZE}px`), ".wtn-fld-gear's font-size must match FLD_GEAR_SIZE exactly");
  assert.ok(fields.FLD_GEAR_SIZE > fields.FLD_FONT, "FLD_GEAR_SIZE must be strictly larger than the row's own body font -- the glyph reads smaller than its font-size suggests");
  assert.ok(!/--wtn-ink-faint/.test(gear), ".wtn-fld-gear must not use --wtn-ink-faint any more");
  assert.match(gear, /--wtn-ink-dim/, ".wtn-fld-gear must use --wtn-ink-dim, matching the chevron's own contrast fix");

  assert.match(gear, new RegExp(`width:\\s*${fields.FLD_GEAR_HIT}px`), ".wtn-fld-gear must declare an explicit hit-area width (FLD_GEAR_HIT)");
  assert.match(gear, new RegExp(`height:\\s*${fields.FLD_GEAR_HIT}px`), ".wtn-fld-gear must declare an explicit hit-area height (FLD_GEAR_HIT)");
  assert.ok(fields.FLD_GEAR_HIT >= 20, "the gear's own hit area must be a comfortable >=20px square");
  assert.ok(fields.FLD_GEAR_HIT < render.SHEAD_H, "the hit area must still fit inside the header's own row height (SHEAD_H) without growing the row");
});

test("injected CSS (shared js/shared/fields.mjs primitives): .wtn-fld-stepper clips its own children, and .wtn-fld-num-name still gives way first (Tier 2 item 8's numeric-row priority, untouched by the stepper-combo overflow fix below)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-fields-style").textContent;
  const stepper = cssRuleBody(cssText, ".wtn-fld-stepper");
  assert.ok(stepper, "expected a .wtn-fld-stepper rule in the injected CSS");
  assert.ok(stepper.includes("overflow: hidden"));

  const numName = cssRuleBody(cssText, ".wtn-fld-num-name");
  const flexMatch = numName.match(/flex:\s*(\d+)\s+(\d+)\s+auto/);
  assert.ok(flexMatch, ".wtn-fld-num-name must declare an explicit flex shorthand");
  assert.equal(Number(flexMatch[1]), 0, ".wtn-fld-num-name: flex-grow must stay 0");
  assert.ok(Number(flexMatch[2]) >= 4, ".wtn-fld-num-name must keep its HEAVY shrink factor -- a numeric row's value is short, so the label gives way first");
  assert.ok(numName.includes("min-width: 0") && numName.includes("text-overflow: ellipsis"), ".wtn-fld-num-name must still be able to shrink to nothing and ellipsize");
});

// ---------------------------------------------------------------------------
// Stepper-combo overflow fix (live-use report, folded into the bigger-type
// dispatch): a long picker value (a checkpoint/upscale-model filename)
// collided with its own label. The label now NEVER shrinks
// (.wtn-fld-stepper-name is flex: none -- every stepper label in this pack
// is one short word); the value gives way instead (.wtn-fld-combo-val gets
// min-width: 0 so its existing ellipsis can actually engage). The numeric
// row's own OPPOSITE priority (tested just above) must be untouched.
// ---------------------------------------------------------------------------

test("stepper-combo overflow fix: .wtn-fld-stepper-name never shrinks (flex: none) -- the LABEL is never the one that gives way in a stepper row, opposite of .wtn-fld-num-name's own priority", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-fields-style").textContent;
  const stepperName = cssRuleBody(cssText, ".wtn-fld-stepper-name");
  assert.ok(stepperName, "expected a .wtn-fld-stepper-name rule");
  assert.match(stepperName, /flex:\s*none/, ".wtn-fld-stepper-name must never shrink -- the label is always short, the VALUE is the one that can be long");
});

test("stepper-combo overflow fix: .wtn-fld-combo-val has min-width: 0 (so its existing overflow:hidden/ellipsis can actually engage) and a shrink-only flex", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-fields-style").textContent;
  const comboVal = cssRuleBody(cssText, ".wtn-fld-combo-val");
  assert.ok(comboVal, "expected a .wtn-fld-combo-val rule");
  assert.ok(comboVal.includes("min-width: 0"), ".wtn-fld-combo-val must declare min-width: 0 -- without it a nowrap text node's automatic minimum IS its full content width, and the ellipsis never fires");
  assert.match(comboVal, /flex:\s*0\s+1\s+auto/, ".wtn-fld-combo-val must be allowed to shrink (flex-shrink 1)");
  assert.ok(comboVal.includes("overflow: hidden") && comboVal.includes("text-overflow: ellipsis"));
});

test("stepper-combo overflow fix: repainting to a long value sets a native title on the value span, for hover-readability once truncated", () => {
  const doc = makeDocStub();
  const built = fields.buildStepperField(doc, {
    label: "checkpoint", value: "short.safetensors", options: ["short.safetensors", "sam3.1_multiplex_fp16.safetensors"],
  }, {});
  built.repaint("sam3.1_multiplex_fp16.safetensors");
  assert.equal(built.val.title, "sam3.1_multiplex_fp16.safetensors");
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
// E3. Post-run context truth -- resolveDownstreamGenerators (forward walk),
//     handleGeneratorExecuted, computeEffectiveContextSupplied/
//     clearContextRun, and the disabled field's/summary's displayed value.
// ===========================================================================

/** A bare litegraph node stub for the forward walk's own fixtures -- unlike
 * `makeGeneratorNode`/`makeBridgeNode` (which carry the real declared
 * socket shape), the walk itself only ever reads `type`/`comfyClass`,
 * `inputs`, `outputs`, and `graph`, so a minimal stub is enough and keeps
 * every fixture below reading as "just the graph shape being tested". */
function stubNode(id, type, { inputs = [], outputs = [] } = {}) {
  return { id, type, inputs, outputs };
}

test("resolveDownstreamGenerators: direct bridge -> generator", () => {
  const bridge = makeBridgeNode(1, [], [10]);
  const gen = stubNode(2, "AnimaGenerator", { inputs: [{ name: "context", link: 10 }] });
  const graph = makeGraph({ 1: bridge, 2: gen }, { 10: { origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 } });
  bridge.graph = graph;
  assert.deepEqual(resolveDownstreamGenerators(bridge), [gen]);
});

test("resolveDownstreamGenerators: through ONE Reroute-shaped pass-through node", () => {
  const bridge = makeBridgeNode(1, [], [10]);
  const reroute = stubNode(2, "Reroute", { inputs: [{ name: "", link: 10 }], outputs: [{ name: "", links: [20] }] });
  const gen = stubNode(3, "AnimaGenerator", { inputs: [{ name: "context", link: 20 }] });
  const graph = makeGraph({ 1: bridge, 2: reroute, 3: gen }, {
    10: { origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 },
    20: { origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0 },
  });
  bridge.graph = graph;
  reroute.graph = graph;
  assert.deepEqual(resolveDownstreamGenerators(bridge), [gen]);
});

test("resolveDownstreamGenerators: through SEVERAL chained pass-through nodes", () => {
  const bridge = makeBridgeNode(1, [], [10]);
  const a = stubNode(2, "Reroute", { inputs: [{ name: "", link: 10 }], outputs: [{ name: "", links: [20] }] });
  const b = stubNode(3, "Reroute", { inputs: [{ name: "", link: 20 }], outputs: [{ name: "", links: [30] }] });
  const gen = stubNode(4, "AnimaGenerator", { inputs: [{ name: "context", link: 30 }] });
  const graph = makeGraph({ 1: bridge, 2: a, 3: b, 4: gen }, {
    10: { origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 },
    20: { origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0 },
    30: { origin_id: 3, origin_slot: 0, target_id: 4, target_slot: 0 },
  });
  bridge.graph = graph;
  a.graph = graph;
  b.graph = graph;
  assert.deepEqual(resolveDownstreamGenerators(bridge), [gen]);
});

test("resolveDownstreamGenerators: fans out to MULTIPLE generators from one output", () => {
  const bridge = makeBridgeNode(1, [], [10, 11]);
  const genA = stubNode(2, "AnimaGenerator", { inputs: [{ name: "context", link: 10 }] });
  const genB = stubNode(3, "AnimaGenerator", { inputs: [{ name: "context", link: 11 }] });
  const graph = makeGraph({ 1: bridge, 2: genA, 3: genB }, {
    10: { origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 },
    11: { origin_id: 1, origin_slot: 0, target_id: 3, target_slot: 0 },
  });
  bridge.graph = graph;
  assert.deepEqual(resolveDownstreamGenerators(bridge), [genA, genB]);
});

test("resolveDownstreamGenerators: unwired / dangling / a cycle / a non-generator dead end all resolve to []", () => {
  assert.deepEqual(resolveDownstreamGenerators(null), [], "a null bridge itself");

  const unwired = makeBridgeNode(1, [], []);
  assert.deepEqual(resolveDownstreamGenerators(unwired), [], "no links on the context output at all");

  const dangling = makeBridgeNode(1, [], [10]);
  dangling.graph = makeGraph({ 1: dangling }, {}); // link 10 isn't in graph.links at all
  assert.deepEqual(resolveDownstreamGenerators(dangling), [], "a dangling link");

  const bridgeCycle = makeBridgeNode(1, [], [10]);
  const a = stubNode(2, "Reroute", { inputs: [{ name: "", link: 10 }], outputs: [{ name: "", links: [20] }] });
  const b = stubNode(3, "Reroute", { inputs: [{ name: "", link: 20 }], outputs: [{ name: "", links: [10] }] }); // b's own output loops back to a's link id
  const cycleGraph = makeGraph({ 1: bridgeCycle, 2: a, 3: b }, {
    10: { origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 },
    20: { origin_id: 2, origin_slot: 0, target_id: 3, target_slot: 0 },
  });
  bridgeCycle.graph = cycleGraph;
  a.graph = cycleGraph;
  b.graph = cycleGraph;
  assert.deepEqual(resolveDownstreamGenerators(bridgeCycle), [], "a cycle -- never hangs");

  const bridgeToOther = makeBridgeNode(1, [], [10]);
  // Two outputs -- neither a pass-through NOR a generator, so this branch
  // simply dead-ends rather than being followed past.
  const other = stubNode(2, "SomeOtherNode", { inputs: [{ name: "in", link: 10 }], outputs: [{ name: "a", links: [] }, { name: "b", links: [] }] });
  bridgeToOther.graph = makeGraph({ 1: bridgeToOther, 2: other }, {
    10: { origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 },
  });
  assert.deepEqual(resolveDownstreamGenerators(bridgeToOther), [], "wired to a real node that's neither a pass-through nor a generator");
});

test("handleGeneratorExecuted: stashes message.anima_context onto node._anContextRun and repaints", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);

  const payload = { supplied: { seed: true }, values: { seed: 42 } };
  handleGeneratorExecuted(node, ctx, { anima_context: payload });
  assert.deepEqual(node._anContextRun, payload);
});

test("handleGeneratorExecuted: a payload with no anima_context key (e.g. only `images`) is ignored outright", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);

  node._anContextRun = { supplied: {}, values: {} };
  const before = node._anContextRun;
  handleGeneratorExecuted(node, ctx, { images: [{ filename: "x.png" }] });
  assert.equal(node._anContextRun, before, "an images-only payload must not touch _anContextRun at all");

  handleGeneratorExecuted(node, ctx, null);
  assert.equal(node._anContextRun, before, "a falsy message is ignored too");
});

// ---------------------------------------------------------------------------
// normalizeAnimaContextPayload -- the shape-tolerant unwrap fixing the
// 2026-07-28 live bug: ComfyUI's executor accumulates a node's `ui` value
// by EXTENDING a list with it, so a bare dict returned under `anima_context`
// arrived flattened to its own key names (`{"anima_context": ["supplied",
// "values"]}`, proven live) -- an `Array.isArray` REJECTION (the original
// guard) discarded the real, correctly-LIST-WRAPPED payload just as badly.
// ---------------------------------------------------------------------------

test("normalizeAnimaContextPayload: a bare object is used as-is", () => {
  const payload = { supplied: { seed: true }, values: { seed: 42 } };
  assert.deepEqual(normalizeAnimaContextPayload(payload), payload);
});

test("normalizeAnimaContextPayload: a single-element array is unwrapped -- THE real-world shape (ComfyUI's list.extend accumulator)", () => {
  const payload = { supplied: { seed: true }, values: { seed: 42 } };
  assert.deepEqual(normalizeAnimaContextPayload([payload]), payload);
});

test("normalizeAnimaContextPayload: a multi-element array -- the LAST entry wins (a later report supersedes an earlier one)", () => {
  const first = { supplied: { seed: true }, values: { seed: 1 } };
  const second = { supplied: { cfg: true }, values: { cfg: 9.5 } };
  assert.deepEqual(normalizeAnimaContextPayload([first, second]), second);
});

test("normalizeAnimaContextPayload: an empty array is ignored", () => {
  assert.equal(normalizeAnimaContextPayload([]), null);
});

test("normalizeAnimaContextPayload: THE PROVEN-LIVE REGRESSION -- a dict flattened to its own key names, [\"supplied\", \"values\"], is ignored, not half-accepted", () => {
  // This exact shape was captured live off a raw `executed`-message probe
  // BEFORE the Python-side fix (nodes/anima/generator.py wrapping the
  // payload in a list): `{"anima_context": ["supplied", "values"]}`. The
  // frontend must never treat the string "values" as if it were the
  // payload object.
  assert.equal(normalizeAnimaContextPayload(["supplied", "values"]), null);
});

test("normalizeAnimaContextPayload: a non-object payload (string/null/number) is ignored", () => {
  assert.equal(normalizeAnimaContextPayload(null), null);
  assert.equal(normalizeAnimaContextPayload(undefined), null);
  assert.equal(normalizeAnimaContextPayload("nope"), null);
  assert.equal(normalizeAnimaContextPayload(42), null);
  assert.equal(normalizeAnimaContextPayload([null]), null, "a single-element array whose element isn't an object");
  assert.equal(normalizeAnimaContextPayload([["nested", "array"]]), null, "a nested array element is still not a plain object");
});

test("handleGeneratorExecuted: THE REGRESSION -- stashes from a LIST-WRAPPED payload ([{supplied, values}]), the shape ComfyUI's executor actually sends", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);

  const payload = { supplied: { seed: true }, values: { seed: 42 } };
  handleGeneratorExecuted(node, ctx, { anima_context: [payload] });
  assert.deepEqual(node._anContextRun, payload, "the OLD Array.isArray-rejecting guard would leave this null -- this must fail against that code");
});

test("handleGeneratorExecuted: a list-wrapped stash makes computeEffectiveContextSupplied report run-supplied fields true, and a numeric sampler field renders disabled with the RUN's value", () => {
  const node = makeGeneratorNode({ contextLink: null }); // no live bridge at all -- run report is the ONLY signal
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);

  const payload = { supplied: { seed: true }, values: { seed: 777 } };
  handleGeneratorExecuted(node, ctx, { anima_context: [payload] });

  const eff = computeEffectiveContextSupplied(node);
  assert.equal(eff.supplied.seed, true, "run-supplied seed must read true off the list-wrapped stash");
  assert.equal(eff.runSupplied.seed, true);
  assert.equal(eff.values.seed, 777);

  const refs = mountGeneratorUI(node, ctx);
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
  const seedField = findFieldByLabel(body, "seed");
  assert.ok(hasClass(seedField, "wtn-fld-disabled"), "run-supplied via a list-wrapped payload -- must render disabled");
  const val = seedField.children.find((c) => hasClass(c, "wtn-fld-num-val"));
  assert.equal(val.textContent, "777", "must show the RUN's own value from the list-wrapped payload");
});

test("computeEffectiveContextSupplied: LIVE-only supplied (bridge wired, no run yet)", () => {
  const bridge = makeBridgeNode(2, ["seed"]);
  const graph = makeGraph({ 2: bridge }, { 1: { origin_id: 2, origin_slot: 0 } });
  const node = makeGeneratorNode({ contextLink: 1, graph });

  const eff = computeEffectiveContextSupplied(node);
  assert.equal(eff.bridgeFound, true);
  assert.equal(eff.supplied.seed, true);
  assert.equal(eff.source.seed, "live");
  assert.equal(eff.runSupplied.seed, false);
  assert.ok(!("seed" in eff.values), "no run value exists yet -- never invented");
  assert.equal(eff.supplied.cfg, false);
});

test("computeEffectiveContextSupplied: RUN-only supplied -- the Use Everywhere case (no bridge resolves at all, no live link)", () => {
  const node = makeGeneratorNode({ contextLink: null });
  node._anContextRun = { supplied: { cfg: true }, values: { cfg: 9.5 } };

  const eff = computeEffectiveContextSupplied(node);
  assert.equal(eff.bridgeFound, false);
  assert.equal(eff.supplied.cfg, true);
  assert.equal(eff.source.cfg, "run");
  assert.equal(eff.runSupplied.cfg, true);
  assert.equal(eff.values.cfg, 9.5);
  // Every other field the run didn't mention stays unsupplied.
  assert.equal(eff.supplied.seed, false);
});

test("computeEffectiveContextSupplied: BOTH live and run agree -- source prefers 'live' for the tooltip, but the run's own value still shows", () => {
  const bridge = makeBridgeNode(2, ["cfg"]);
  const graph = makeGraph({ 2: bridge }, { 1: { origin_id: 2, origin_slot: 0 } });
  const node = makeGeneratorNode({ contextLink: 1, graph });
  node._anContextRun = { supplied: { cfg: true }, values: { cfg: 9.5 } };

  const eff = computeEffectiveContextSupplied(node);
  assert.equal(eff.supplied.cfg, true);
  assert.equal(eff.source.cfg, "live");
  assert.equal(eff.runSupplied.cfg, true);
  assert.equal(eff.values.cfg, 9.5);
});

test("computeEffectiveContextSupplied: NEITHER live nor run -- editable, no values entry at all", () => {
  const node = makeGeneratorNode({ contextLink: null });
  const eff = computeEffectiveContextSupplied(node);
  assert.equal(eff.supplied.cfg, false);
  assert.equal(eff.source.cfg, null);
  assert.ok(!("cfg" in eff.values));
});

test("computeEffectiveContextSupplied: the run reported supplied but carried no value for that field (None) -- runSupplied true, no values entry, settings value must win", () => {
  const node = makeGeneratorNode({ contextLink: null });
  node._anContextRun = { supplied: { cfg: true }, values: { cfg: null } };

  const eff = computeEffectiveContextSupplied(node);
  assert.equal(eff.supplied.cfg, true);
  assert.equal(eff.runSupplied.cfg, true);
  assert.ok(!("cfg" in eff.values), "a None run value must never be invented into a displayed number");
});

test("clearContextRun: wipes node._anContextRun back to 'neither' -- what BOTH index.js onConnectionsChange hooks call on every rewire", () => {
  const node = makeGeneratorNode({ contextLink: null });
  node._anContextRun = { supplied: { cfg: true }, values: { cfg: 9.5 } };
  assert.equal(computeEffectiveContextSupplied(node).supplied.cfg, true);

  clearContextRun(node);
  assert.equal(node._anContextRun, null);
  const eff = computeEffectiveContextSupplied(node);
  assert.equal(eff.supplied.cfg, false);
  assert.equal(eff.source.cfg, null);
  assert.ok(!("cfg" in eff.values));

  assert.doesNotThrow(() => clearContextRun(null), "must never throw for a falsy node");
});

test("a run-supplied sampler field's disabled value is the RUN's own number, not the settings tree's", () => {
  const node = makeGeneratorNode({ contextLink: null });
  node._anContextRun = { supplied: { seed: true }, values: { seed: 777 } };
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
  const seedField = findFieldByLabel(body, "seed");
  assert.ok(hasClass(seedField, "wtn-fld-disabled"), "run-supplied -- must render disabled");
  const val = seedField.children.find((c) => hasClass(c, "wtn-fld-num-val"));
  assert.equal(val.textContent, "777", "must show the RUN's value, not the settings tree's default seed");

  const seedWrap = seedField.parentNode;
  const seedIcon = seedWrap.children.find((c) => hasClass(c, "wtn-fld-info"));
  assert.match(seedIcon.attributes["aria-label"], /supplied at run time/i);
  assert.match(seedIcon.attributes["aria-label"], /Use Everywhere/i);
});

test("a run that reported supplied with NO value falls back to rendering the settings value, and says so in the ⓘ", () => {
  const node = makeGeneratorNode({ contextLink: null });
  node._anContextRun = { supplied: { seed: true }, values: {} }; // supplied, but carried nothing
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  const settingsSeed = genState(node).sampler.seed;
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
  const seedField = findFieldByLabel(body, "seed");
  assert.ok(hasClass(seedField, "wtn-fld-disabled"));
  const val = seedField.children.find((c) => hasClass(c, "wtn-fld-num-val"));
  assert.equal(val.textContent, String(settingsSeed), "no run value -- must show the settings tree's own value, never invent one");

  const seedWrap = seedField.parentNode;
  const seedIcon = seedWrap.children.find((c) => hasClass(c, "wtn-fld-info"));
  assert.match(seedIcon.attributes["aria-label"], /carried no value/i, "the ⓘ must SAY it fell back, not just silently show a stale number");
});

test("node._anContextRun never reaches the serialized generation_settings widget", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);

  handleGeneratorExecuted(node, ctx, { anima_context: { supplied: { cfg: true }, values: { cfg: 9.5 } } });
  assert.ok(node._anContextRun, "sanity: it really did stash something");

  const persistedRaw = getGenSettingsWidget(node).value;
  assert.ok(!persistedRaw.includes("_anContextRun"), "the widget's own serialized JSON must carry no trace of it");
  const persisted = JSON.parse(persistedRaw);
  assert.ok(!("_anContextRun" in persisted) && !("anContextRun" in persisted));
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

test("REGRESSION (live-use report): dragging Steps/CFG in the Sampler section actually MOVES the rendered label/fill mid-drag, not just the persisted state -- buildSamplerField's getValue must be a LIVE read, not a value frozen at build time", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));

  for (const [label, dragToX, expectRendered] of [["steps", 300, "150"], ["cfg", 0, "0.0"]]) {
    const field = findFieldByLabel(body, label);
    assert.ok(field, `${label} must be editable`);
    const valEl = field.children.find((c) => hasClass(c, "wtn-fld-num-val"));
    const before = valEl.textContent;

    field._rect = { left: 0, top: 0, right: 300, bottom: 25, width: 300, height: 25 };
    fire(field, "pointerdown", { clientX: dragToX });
    // The rendered label must already reflect the drag BEFORE release -- a
    // getValue() that returns a value frozen at BUILD time (the exact
    // regression) would leave valEl.textContent unchanged here, since
    // buildNumericField's own repaint() re-reads getValue() on every move.
    assert.equal(valEl.textContent, expectRendered, `${label}'s rendered value must update DURING the drag, not just on the next full rebuild`);
    assert.notEqual(valEl.textContent, before, `${label}'s rendered value must actually have changed from its starting text`);
    fire(field, "pointerup", { clientX: dragToX });
  }
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

// ---------------------------------------------------------------------------
// Model-file pickers -- the SAM3 checkpoint (Detailer) and upscale model
// (Upscale) previously hardcoded upstream defaults with NO frontend control
// at all; now real `buildStepperField` picker rows fed by `ctx.getKnownLists()`.
// ---------------------------------------------------------------------------

test("Detailer section: the SAM3 checkpoint renders as a stepper fed by ctx.getKnownLists().checkpoints, not a text field", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: ["sam3.1_multiplex_fp16.safetensors", "other.safetensors"], upscale_models: [] }) });
  const refs = mountGeneratorUI(node, ctx);

  fire(switchOf(findSectionHeader(refs.body, "Detailer")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Detailer"));

  const field = findFieldByLabel(body, "checkpoint");
  assert.ok(field, "expected a 'checkpoint' field in the Detailer section");
  assert.ok(hasClass(field, "wtn-fld-stepper"), "must be a stepper row, not buildTextField's .wtn-an-field");
  assert.ok(!hasClass(field, "wtn-fld-disabled"), "a non-empty list must render enabled");
  const val = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-combo")).children.find((c) => hasClass(c, "wtn-fld-combo-val"));
  assert.equal(val.textContent, "sam3.1_multiplex_fp16.safetensors");
});

test("Upscale section: the model picker (labeled 'Model', not the over-qualified 'upscale_model_name' -- the section card already scopes it) renders as a stepper fed by ctx.getKnownLists().upscale_models, not a text field", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: [], upscale_models: ["2x-AnimeSharpV4_Fast_RCAN_PU.safetensors", "other.pth"] }) });
  const refs = mountGeneratorUI(node, ctx);

  fire(switchOf(findSectionHeader(refs.body, "Upscale")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Upscale"));

  const field = findFieldByLabel(body, "Model");
  assert.ok(field, "expected a 'Model' field in the Upscale section");
  assert.ok(hasClass(field, "wtn-fld-stepper"), "must be a stepper row, not buildTextField's .wtn-an-field");
  assert.ok(!hasClass(field, "wtn-fld-disabled"));
  const val = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-combo")).children.find((c) => hasClass(c, "wtn-fld-combo-val"));
  assert.equal(val.textContent, "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors");
});

test("Upscale section: the model picker's DISPLAY label changed to 'Model', but the underlying settings path is still upscale.usdu.upscale_model_name -- a state-shape change would break saved workflows", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: [], upscale_models: ["2x-AnimeSharpV4_Fast_RCAN_PU.safetensors", "other.pth"] }) });
  const refs = mountGeneratorUI(node, ctx);

  fire(switchOf(findSectionHeader(refs.body, "Upscale")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Upscale"));
  assert.ok(!findFieldByLabel(body, "upscale_model_name"), "the raw settings-path name must no longer be the DISPLAYED label");

  const field = findFieldByLabel(body, "Model");
  const rightArrow = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-right"));
  fire(rightArrow, "click");
  const persisted = genState(node);
  assert.equal(persisted.upscale.usdu.upscale_model_name, "other.pth", "the settings PATH is unchanged even though the label is");
});

test("Detailer SAM3 checkpoint: an empty/missing list keeps showing the SAVED value, disabled -- never rewrites it, never renders an empty-but-clickable picker; the empty-list REASON is visible in the row ('no options available', NOT an assertion the folder is empty -- getComboOptions can also come back empty for a V3-schema def it couldn't parse), and the folder hint lives ONLY in the tooltip", () => {
  const node = makeGeneratorNode({
    generation_settings: JSON.stringify({ detailer: { sam3: { checkpoint: "a-value-not-in-any-list.safetensors" } } }),
  });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: [], upscale_models: [] }) }); // nothing installed
  const refs = mountGeneratorUI(node, ctx);

  fire(switchOf(findSectionHeader(refs.body, "Detailer")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Detailer"));

  const field = findFieldByLabel(body, "checkpoint");
  assert.ok(hasClass(field, "wtn-fld-disabled"), "an empty list must render the picker disabled, not silently rewrite the value");
  const val = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-combo")).children.find((c) => hasClass(c, "wtn-fld-combo-val"));
  assert.ok(val.textContent.includes("a-value-not-in-any-list.safetensors"), "the saved value must survive, not fall back to list[0] or the upstream default");
  assert.ok(val.textContent.includes("no options available"), "the empty-list reason must be visible in the row itself");
  assert.ok(!val.textContent.includes("models/checkpoints"), "the row text must NOT assert the folder is empty -- an empty list doesn't always mean that");
  assert.ok(field.title && field.title.includes("models/checkpoints"), "the folder hint belongs in the tooltip (root.title, buildStepperField's own disabledReason), as a place to check, not a claim");

  // Disabled means no click handlers were wired at all -- clicking an arrow
  // (if it somehow fired) must not mutate the persisted state either.
  const persisted = genState(node);
  assert.equal(persisted.detailer.sam3.checkpoint, "a-value-not-in-any-list.safetensors");
});

test("Upscale Model picker: a `null` (unobtainable) list ALSO keeps the saved value, disabled, with the same 'no options available' row text (folder hint only in the tooltip)", () => {
  const node = makeGeneratorNode({
    generation_settings: JSON.stringify({ upscale: { usdu: { upscale_model_name: "my-custom-model.pth" } } }),
  });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: [], upscale_models: null }) });
  const refs = mountGeneratorUI(node, ctx);

  fire(switchOf(findSectionHeader(refs.body, "Upscale")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Upscale"));

  const field = findFieldByLabel(body, "Model");
  assert.ok(hasClass(field, "wtn-fld-disabled"));
  const val = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-combo")).children.find((c) => hasClass(c, "wtn-fld-combo-val"));
  assert.ok(val.textContent.includes("my-custom-model.pth"), "the saved value must survive a null list");
  assert.ok(val.textContent.includes("no options available"), "the empty-list reason must be visible in the row itself");
  assert.ok(!val.textContent.includes("models/upscale_models"), "the row text must NOT assert the folder is empty");
  assert.ok(field.title && field.title.includes("models/upscale_models"), "the folder hint belongs in the tooltip only");

  const persisted = genState(node);
  assert.equal(persisted.upscale.usdu.upscale_model_name, "my-custom-model.pth", "an empty/null list must never rewrite the saved value");
});

test("Detailer SAM3 checkpoint: cycling the stepper's arrow writes detailer.sam3.checkpoint (and persists) when the list is non-empty", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: ["sam3.1_multiplex_fp16.safetensors", "second.safetensors"], upscale_models: [] }) });
  const refs = mountGeneratorUI(node, ctx);

  fire(switchOf(findSectionHeader(refs.body, "Detailer")), "click");
  let body = sectionBodyOf(findSectionHeader(refs.body, "Detailer"));
  const field = findFieldByLabel(body, "checkpoint");
  const rightArrow = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-right"));
  fire(rightArrow, "click");

  const persisted = genState(node);
  assert.equal(persisted.detailer.sam3.checkpoint, "second.safetensors");
});

test("Upscale Model picker: cycling the stepper's arrow writes upscale.usdu.upscale_model_name (and persists) when the list is non-empty", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: [], upscale_models: ["2x-AnimeSharpV4_Fast_RCAN_PU.safetensors", "other.pth"] }) });
  const refs = mountGeneratorUI(node, ctx);

  fire(switchOf(findSectionHeader(refs.body, "Upscale")), "click");
  let body = sectionBodyOf(findSectionHeader(refs.body, "Upscale"));
  const field = findFieldByLabel(body, "Model");
  const rightArrow = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-right"));
  fire(rightArrow, "click");

  const persisted = genState(node);
  assert.equal(persisted.upscale.usdu.upscale_model_name, "other.pth");
});

test("index.js: MODEL_LIST_SOURCES/readKnownLists mirrors js/controls/index.js's readKnownLists shape -- CheckpointLoaderSimple.ckpt_name / UpscaleModelLoader.model_name, both ComfyUI built-ins", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(indexSource, /CheckpointLoaderSimple/);
  assert.match(indexSource, /ckpt_name/);
  assert.match(indexSource, /UpscaleModelLoader/);
  assert.match(indexSource, /model_name/);
  // getComboOptions is REUSED (imported/re-exported), never reimplemented.
  assert.doesNotMatch(indexSource, /function getComboOptions/);
});

test("index.js: samplers/schedulers ALSO ride MODEL_LIST_SOURCES/getKnownLists, off KSampler's own registered sampler_name/scheduler combo spec -- task item 1, the same pair js/controls/rows.mjs's NODE_DEF_SOURCE already reads", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(indexSource, /samplers:\s*\{\s*className:\s*"KSampler",\s*field:\s*"sampler_name"/);
  assert.match(indexSource, /schedulers:\s*\{\s*className:\s*"KSampler",\s*field:\s*"scheduler"/);
});

// ---------------------------------------------------------------------------
// Live sampler_name/scheduler option lists (task item 1) -- previously
// hardcoded 6-entry arrays (SAMPLERS/SCHEDULERS in interaction.mjs), versus
// ComfyUI's real ~30/~10. Now read through ctx.getKnownLists().samplers/
// .schedulers, the SAME mechanism the model-file pickers above use --
// falling back to the hardcoded arrays ONLY when the registry is unavailable.
// ---------------------------------------------------------------------------

/** The option-list overlay's own `.wtn-an-opt` entries, opened by clicking
 * `field`'s combo -- shared by every test below that needs to inspect the
 * REAL live option list a stepper was built with (not just its currently
 * displayed value). Closes the overlay again before returning, so a caller
 * that opens a second field's list afterward doesn't collide with an
 * already-open one. */
function optionListTextsFor(field) {
  const combo = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-combo"));
  fire(combo, "click");
  assert.ok(activeOverlayRef.current, "expected the option-list overlay to open");
  const menu = activeOverlayRef.current.overlay.children[0];
  const texts = queryAll(menu, (n) => hasClass(n, "wtn-an-opt")).map((o) => o.textContent);
  closeActiveOverlay();
  return texts;
}

test("Sampler section: sampler_name/scheduler options come from a stubbed ctx.getKnownLists().samplers/.schedulers registry -- a real (>6-entry) live list is used, not the 6-entry hardcoded fallback", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const liveSamplers = ["euler", "euler_ancestral", "euler_cfg_pp", "heun", "heunpp2", "dpm_2", "dpm_2_ancestral", "lms", "dpmpp_2m", "ddim"];
  const liveSchedulers = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta", "linear_quadratic"];
  const ctx = makeCtx(doc, {
    getKnownLists: () => ({
      checkpoints: [], upscale_models: [], samplers: liveSamplers, schedulers: liveSchedulers,
    }),
  });
  const refs = mountGeneratorUI(node, ctx);
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler")); // expanded by default

  const samplerField = findFieldByLabel(body, "sampler_name");
  const schedField = findFieldByLabel(body, "scheduler");
  assert.deepEqual(optionListTextsFor(samplerField), liveSamplers, "must use the LIVE registry list, in its own order");
  assert.deepEqual(optionListTextsFor(schedField), liveSchedulers);
  assert.ok(liveSamplers.length > 6 && liveSchedulers.length > 6, "sanity: the live lists this test feeds are bigger than the hardcoded fallback");
});

test("Sampler section: sampler_name/scheduler fall back to the hardcoded 6-entry arrays ONLY when ctx.getKnownLists() has no samplers/schedulers key at all (registry unavailable, e.g. a headless host or an unregistered KSampler def)", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  // Deliberately the OLD shape (no samplers/schedulers keys) -- same stub
  // shape every OTHER test in this file already uses via makeCtx's default.
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: [], upscale_models: [] }) });
  const refs = mountGeneratorUI(node, ctx);
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));

  const samplerField = findFieldByLabel(body, "sampler_name");
  const schedField = findFieldByLabel(body, "scheduler");
  const samplerOpts = optionListTextsFor(samplerField);
  const schedOpts = optionListTextsFor(schedField);
  assert.equal(samplerOpts.length, 6, "must fall back to the hardcoded (deliberately last-resort) SAMPLERS array");
  assert.equal(schedOpts.length, 6, "must fall back to the hardcoded (deliberately last-resort) SCHEDULERS array");
  assert.deepEqual(samplerOpts, ["euler", "euler_ancestral", "er_sde", "dpmpp_2m", "heun", "ddim"]);
  assert.deepEqual(schedOpts, ["simple", "sgm_uniform", "karras", "normal", "beta", "exponential"]);
});

test("Sampler section: an empty (not missing) samplers/schedulers array ALSO falls back to the hardcoded list -- 'the registry returned nothing usable' and 'the key is absent' must behave identically", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, { getKnownLists: () => ({ checkpoints: [], upscale_models: [], samplers: [], schedulers: null }) });
  const refs = mountGeneratorUI(node, ctx);
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));
  assert.equal(optionListTextsFor(findFieldByLabel(body, "sampler_name")).length, 6);
  assert.equal(optionListTextsFor(findFieldByLabel(body, "scheduler")).length, 6);
});

test("Sampler section: a saved sampler_name/scheduler value ABSENT from the live list still renders (and is never silently rewritten to list[0]) -- ce0528f's lesson, extended to the newly-live sampler/scheduler lists", () => {
  const node = makeGeneratorNode({
    generation_settings: JSON.stringify({ sampler: { sampler_name: "not_in_any_list", scheduler: "also_not_in_any_list" } }),
  });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, {
    getKnownLists: () => ({ checkpoints: [], upscale_models: [], samplers: ["euler", "dpmpp_2m"], schedulers: ["normal", "karras"] }),
  });
  const refs = mountGeneratorUI(node, ctx);
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler"));

  const samplerField = findFieldByLabel(body, "sampler_name");
  const schedField = findFieldByLabel(body, "scheduler");
  const samplerVal = samplerField.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-combo")).children.find((c) => hasClass(c, "wtn-fld-combo-val"));
  const schedVal = schedField.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-combo")).children.find((c) => hasClass(c, "wtn-fld-combo-val"));
  assert.equal(samplerVal.textContent, "not_in_any_list", "the saved value must still render even though the live list doesn't contain it");
  assert.equal(schedVal.textContent, "also_not_in_any_list");

  const persisted = genState(node);
  assert.equal(persisted.sampler.sampler_name, "not_in_any_list", "must never be silently rewritten to list[0]");
  assert.equal(persisted.sampler.scheduler, "also_not_in_any_list");
});

test("interaction.mjs still touches no window/LiteGraph directly -- getKnownLists rides the ctx injection, same contract as getCanvasEl/havePackages (a static source scan, comments stripped)", () => {
  const src = readFileSync(path.join(__dirname, "interaction.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /window\./);
  assert.doesNotMatch(code, /\bLiteGraph\b/);
});

test("inherit_sampler_settings toggle (Highres, now in the ⚙ menu -- task item 3) hides exactly cfg/sampler_name/scheduler, both directions, persists, and REBUILDS the menu in place without closing it", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  // Highres HAS a switch -- expand/collapse is the switch's job now (task 3),
  // not the header's; the header click test below covers the no-op case.
  fire(switchOf(findSectionHeader(refs.body, "Highres")), "click"); // enable

  const header = findSectionHeader(refs.body, "Highres");
  const box = openGearMenu(header);
  assert.ok(findFieldByLabel(box, "inherit"));
  assert.ok(!findFieldByLabel(box, "cfg"), "cfg hidden while inherit is ON");
  assert.ok(!findFieldByLabel(box, "sampler_name"));
  assert.ok(!findFieldByLabel(box, "scheduler"));

  const inheritField = queryAll(box, (n) => hasClass(n, "wtn-an-boolfield"))
    .find((f) => (f.children[0] || {}).textContent === "inherit");
  fire(inheritField.children.find((c) => hasClass(c, "wtn-fld-switch")), "click");

  // The SAME overlay must still be open -- a menu-internal edit rebuilds
  // its own content, it never closes/reopens the overlay wholesale.
  assert.ok(activeOverlayRef.current, "the ⚙ menu must still be open after toggling inherit inside it");
  assert.ok(findFieldByLabel(box, "cfg"), "cfg reappears once inherit is OFF");
  assert.ok(findFieldByLabel(box, "sampler_name"));
  assert.ok(findFieldByLabel(box, "scheduler"));
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
// Header child order -- the no-jump invariant (task 2; reordered again
// 2026-07-28, chevron/gear legibility fix -- the ⚙ moved from before the
// summary to after it, at the row's absolute right end). chevron -> switch
// (if any) -> label -> ⓘ (if any) -> summary (if any) -> ⚙ (if any),
// regardless of which optional pieces are present, so turning a section
// on/off (or a summary appearing/disappearing) never shifts the pinned-left
// group, and the ⚙ never moves either -- see the "⚙ position is stable"
// tests below for that specific regression.
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
    if (hasClass(c, "wtn-fld-gear")) return "gear";
    if (hasClass(c, "wtn-an-shead-sum")) return "summary";
    return "?";
  });
}

test("header child order is chevron -> switch -> label -> ⓘ -> ⚙ (no summary while disabled -- Highres always carries an ⓘ, a switch, AND a ⚙ -- task item 3): with no summary in the DOM at all, the ⚙ is simply the next thing appended after ⓘ, and it's still the LAST child", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const header = findSectionHeader(refs.body, "Highres"); // starts disabled -> summary is null
  assert.deepEqual(headerChildKinds(header), ["chev", "switch", "label", "info", "gear"], "no summary while disabled -- the pinned-left group never moves, and the ⚙ is still the LAST child");
});

test("header child order is chevron -> switch -> label -> ⓘ -> summary -> ⚙ once a summary appears -- enabling only INSERTS the summary BEFORE the ⚙, never reorders the pinned-left group, and the ⚙ is STILL the last child in both cases (the no-jump regression, chevron/gear legibility fix: the ⚙ moved from before the summary to after it)", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  fire(switchOf(findSectionHeader(refs.body, "Highres")), "click"); // enable -> gets a summary
  const header = findSectionHeader(refs.body, "Highres");
  assert.deepEqual(headerChildKinds(header), ["chev", "switch", "label", "info", "summary", "gear"], "chevron/switch/label/ⓘ must be in the EXACT same order as the no-summary case above, the summary now sits between ⓘ and the ⚙, and the ⚙ is still the LAST child either way");
});

test("header child order for a SWITCHLESS section (Sampler): chevron -> label -> ⓘ -> summary -- switch AND ⚙ are simply absent (Sampler isn't in item 3's restructured table), nothing else shifts", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const header = findSectionHeader(refs.body, "Sampler");
  assert.deepEqual(headerChildKinds(header), ["chev", "label", "info", "summary"]);
});

test("header child order for Postprocess (restructuring out of scope, task item 3): chevron -> switch -> label -> ⓘ -> summary -- no ⚙ at all", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const header = findSectionHeader(refs.body, "Postprocess");
  assert.ok(!gearOf(header), "Postprocess must carry no ⚙ -- its field set is unchanged");
  fire(switchOf(header), "click");
  assert.deepEqual(headerChildKinds(findSectionHeader(refs.body, "Postprocess")), ["chev", "switch", "label", "info", "summary"]);
});

test("⚙ click never toggles a section's own expand/collapse -- Highres and Upscale each expose one, and clicking it changes neither ui_expanded nor enabled", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  for (const name of ["Highres", "Upscale"]) {
    const before = JSON.parse(JSON.stringify(genState(node)));
    const header = findSectionHeader(refs.body, name);
    assert.ok(gearOf(header), `${name} must carry a ⚙`);
    fire(gearOf(header), "click");
    const after = genState(node);
    const key = name.toLowerCase();
    assert.equal(after.ui_expanded[key], before.ui_expanded[key], `${name}'s ⚙ click must not touch ui_expanded`);
    assert.equal(after[key].enabled, before[key].enabled, `${name}'s ⚙ click must not touch enabled`);
    assert.ok(!sectionBodyOf(header), `${name} must still be collapsed -- the ⚙ opens a MENU, never the inline body`);
    closeActiveOverlay();
  }
});

test("Detailer's section header carries NO ⚙ of its own (its only section-wide setting, sam3.checkpoint, is already inline) -- only its BLOCKS have one, separately", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const header = findSectionHeader(refs.body, "Detailer");
  assert.ok(!gearOf(header), "Detailer's own SECTION header must carry no ⚙");
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

test("interaction.mjs re-imports js/shared/overlay.mjs (2026-07-28, hybrid essentials/⚙ dispatch) -- for ANCHORED MENUS only (⚙ menus, stepper option lists), not the deleted per-section popover shape (already asserted gone, above)", () => {
  const src = readFileSync(path.join(__dirname, "interaction.mjs"), "utf8");
  assert.match(src, /from\s+"\.\.\/shared\/overlay\.mjs"/, "interaction.mjs must import the shared overlay module again");
  assert.match(src, /openOverlayWithZoom/);
  assert.match(src, /closeActiveOverlay/);
  assert.match(src, /closeOverlayIfOwnedBy/);
  assert.match(src, /activeOverlayRef/);
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

// ---------------------------------------------------------------------------
// normalizeAnimaStagesPayload -- the mirror-image check `handleGeneratorExecuted`'s
// bug prompted (this module's own doc comment): `anima_stages` is SAFE BY
// CONSTRUCTION (`build_preview_ui_images` is always a real list), so these
// are cheap extra tolerance, not a regression fix.
// ---------------------------------------------------------------------------

test("normalizeAnimaStagesPayload: a real array (the normal, safe-by-construction shape) passes through untouched", () => {
  const entries = [{ filename: "base.png", stage: "base" }];
  assert.equal(normalizeAnimaStagesPayload(entries), entries);
});

test("normalizeAnimaStagesPayload: a bare single-entry object is wrapped into a one-element array (cheap extra tolerance, not the shape Python actually sends)", () => {
  const entry = { filename: "base.png", stage: "base" };
  assert.deepEqual(normalizeAnimaStagesPayload(entry), [entry]);
});

test("normalizeAnimaStagesPayload: null/undefined/a string are still rejected -- tolerance doesn't mean 'accept anything'", () => {
  assert.equal(normalizeAnimaStagesPayload(null), null);
  assert.equal(normalizeAnimaStagesPayload(undefined), null);
  assert.equal(normalizeAnimaStagesPayload("nope"), null);
});

test("Preview: handleExecuted also stashes from a bare-object anima_stages payload (mirror-image tolerance)", () => {
  const node = makePreviewNode({ imagesLink: 1, metadataLink: 1 });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountPreviewUI(node, ctx);

  handleExecuted(node, ctx, {
    anima_stages: { filename: "base.png", subfolder: "AnimaFlow", type: "output", stage: "base" },
  });

  assert.ok(node._anPreviewImages && node._anPreviewImages.base, "a bare-object anima_stages entry must still populate node._anPreviewImages");
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

test("Preview: the Save row's own switch reaches the preview_state widget immediately, WITHOUT opening the menu (stopPropagation keeps it a separate control)", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const header = findSectionHeader(refs.body, "Save");
  fire(switchOf(header), "click");
  assert.equal(previewState(node).save.enabled, false);
  assert.equal(activeOverlayRef.current, null, "flipping the switch must never also open the Save menu");
});

test("Preview: Save is NOT an inline accordion any more (task item 2) -- its row carries no chevron and never gains a .wtn-an-sbody, regardless of switch state", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const header = findSectionHeader(refs.body, "Save");
  assert.ok(!header.children.some((c) => hasClass(c, "wtn-an-chev")), "the Save row must carry no chevron at all");
  assert.ok(!sectionBodyOf(header), "no inline body while enabled");
  fire(switchOf(header), "click"); // disable
  assert.ok(!sectionBodyOf(findSectionHeader(refs.body, "Save")), "still no inline body once disabled either");
});

test("Preview: the Save row opens its menu as a placement:\"right\" overlay (task item 2) -- via its own ⚙ AND via a plain click on the row, holding the SAME field set the old inline section had", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  makeWindowStub(doc, { w: 1200, h: 900 });
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const header = findSectionHeader(refs.body, "Save");

  const box = openGearMenu(header);
  assert.equal(activeOverlayRef.current.overlay.className, "wtn-an-overlay wtn");
  for (const label of ["which", "extension", "path", "filename"]) {
    assert.ok(findFieldByLabel(box, label), `expected ${label} in the Save menu`);
  }
  assert.ok(queryAll(box, (n) => hasClass(n, "wtn-an-boolfield")).some((f) => (f.children[0] || {}).textContent === "embed workflow"));
  closeActiveOverlay();

  // Clicking the row itself (not just the ⚙) opens the SAME menu.
  fire(header, "click");
  assert.ok(activeOverlayRef.current, "a plain click on the Save row must also open the menu");
});

test("Preview: editing a field inside the Save menu persists immediately and updates the header's own summary in place, WITHOUT rebuilding the menu or closing it", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const header = findSectionHeader(refs.body, "Save");
  const box = openGearMenu(header);

  const extensionField = findFieldByLabel(box, "extension");
  const rightArrow = extensionField.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-right"));
  fire(rightArrow, "click");

  assert.ok(activeOverlayRef.current, "the menu must still be open after a field edit inside it");
  assert.equal(previewState(node).save.extension, "jpg", "cycling extension must persist immediately");
  const sumEl = header.children.find((c) => hasClass(c, "wtn-an-shead-sum"));
  assert.ok(sumEl.textContent.includes("jpg"), "the header's own summary must reflect the new extension WITHOUT a full repaint");
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
 * happens to pass regardless.
 *
 * `size` defaults to a size that is NOT what `_MOCK_COMPUTED_SIZE` clobbers
 * it to, below -- both `removeInput`/`removeOutput` additionally mimic
 * litegraph's OWN documented `this.size = this.computeSize()` side effect
 * (`healNodeSockets`'s own doc comment, "the reported bug"), overwriting
 * `node.size` with `_MOCK_COMPUTED_SIZE` on every call, exactly like the real
 * API methods are documented to do. This is what lets the size-preserving
 * tests below actually exercise the fix rather than trivially pass because
 * nothing in the stub ever touched `node.size` in the first place. */
const _MOCK_COMPUTED_SIZE = [80, 32];
function makeHealableNode({ id = 1, inputs = [], outputs = [], graph = null, size = [640, 480] } = {}) {
  const node = {
    id,
    graph,
    size: Array.isArray(size) ? size.slice() : size,
    inputs: inputs.map((i) => ({ ...i })),
    outputs: outputs.map((o) => ({ ...o, links: (o.links || []).slice() })),
    setDirtyCanvas() {
      node._dirty = (node._dirty || 0) + 1;
    },
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
      node.size = _MOCK_COMPUTED_SIZE.slice();
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
      node.size = _MOCK_COMPUTED_SIZE.slice();
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

// ---------------------------------------------------------------------------
// Size preserve/restore across a heal -- the "shrinks to min on every
// refresh" bug fix (`healNodeSockets`'s own doc comment). `makeHealableNode`'s
// `removeInput`/`removeOutput` mimic litegraph's documented
// `this.size = this.computeSize()` side effect (`_MOCK_COMPUTED_SIZE`, above)
// -- every case here would fail WITHOUT the fix, since the stub genuinely
// clobbers `node.size` on every remove call, exactly like the real API.
// ---------------------------------------------------------------------------

test("healNodeSockets: preserves the ORIGINAL node.size across a stale-socket heal, even though removeInput/removeOutput clobber it along the way", () => {
  const graph = makeLinkGraph();
  addLink(graph, 1, 100, 0, 1, 0); // context's own link
  const node = makeHealableNode({
    id: 1,
    graph,
    size: [512, 900],
    inputs: [
      { name: "context", type: "ANIMA_CONTEXT", link: 1 },
      { name: "positive", type: "CONDITIONING", link: null }, // stale -- removed
    ],
    outputs: [
      { name: "images", type: "IMAGE", links: [] },
      { name: "latent", type: "LATENT", links: [] },
      { name: "metadata_json", type: "STRING", links: [] },
      { name: "latent", type: "LATENT", links: [] }, // duplicate -- removed
    ],
  });

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.equal(summary.changed, true, "sanity: this case must actually heal something, or the test proves nothing");
  assert.deepEqual(
    node.size,
    [512, 900],
    "healing must restore the node's ORIGINAL saved size, not whatever the socket-mutation side effect clobbered it to",
  );
});

test("healNodeSockets: a too-SMALL pre-existing size survives a heal unchanged -- the fix restores, it does not clamp up to any floor", () => {
  const graph = makeLinkGraph();
  const node = makeHealableNode({
    id: 1,
    graph,
    size: [10, 10],
    inputs: [
      { name: "context", type: "ANIMA_CONTEXT", link: null },
      { name: "stale", type: "STRING", link: null },
    ],
    outputs: [],
  });

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.equal(summary.changed, true);
  assert.deepEqual(node.size, [10, 10], "a tiny saved size must come back exactly as tiny -- healing never clamps it up");
});

test("healNodeSockets: a too-LARGE pre-existing size survives a heal unchanged -- the fix restores, it does not clamp down to any computed size", () => {
  const graph = makeLinkGraph();
  const node = makeHealableNode({
    id: 1,
    graph,
    size: [9000, 9000],
    inputs: [
      { name: "context", type: "ANIMA_CONTEXT", link: null },
      { name: "stale", type: "STRING", link: null },
    ],
    outputs: [],
  });

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.equal(summary.changed, true);
  assert.deepEqual(node.size, [9000, 9000], "a huge saved size must come back exactly as huge -- healing never clamps it down");
});

test("healNodeSockets: a node with nothing to heal never writes node.size at all -- same array reference AND same values, no restore call happens", () => {
  const graph = makeLinkGraph();
  addLink(graph, 1, 10, 0, 1, 0);
  const node = makeHealableNode({
    id: 1,
    graph,
    size: [777, 333],
    inputs: [{ name: "context", type: "ANIMA_CONTEXT", link: 1 }],
    outputs: [
      { name: "images", type: "IMAGE", links: [] },
      { name: "latent", type: "LATENT", links: [] },
      { name: "metadata_json", type: "STRING", links: [] },
    ],
  });
  const originalSize = node.size;

  const summary = healNodeSockets(node, GENERATOR_NODE_DATA);

  assert.equal(summary.changed, false);
  assert.equal(node.size, originalSize, "no-op heal must never even touch the size array reference");
  assert.deepEqual(node.size, [777, 333]);
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

// ===========================================================================
// H2. The "Generator loses its saved size on every refresh" race
//     (`isGraphLoading()`, `js/shared/graph_loading.mjs`, ported from
//     `../ComfyUI-Pixaroma`). Neither `index.js` nor `graph_loading.mjs`
//     itself can be imported directly here (both carry a top-level absolute
//     `/scripts/app.js` import, which 404s under plain `node` -- this file's
//     own top doc comment already states index.js is never imported
//     directly for exactly this reason) -- both are covered by static
//     source scans, the SAME technique this suite already uses for
//     `index.js`'s other un-instantiable wiring (the tests immediately
//     above/below this one).
// ===========================================================================

test("js/shared/graph_loading.mjs: wraps app.loadGraphData exactly once (idempotency guard), holds a flag through the call plus a trailing window, and exports isGraphLoading", () => {
  const src = readFileSync(path.join(__dirname, "..", "shared", "graph_loading.mjs"), "utf8");
  assert.match(src, /app\.loadGraphData\s*=\s*function/, "must wrap app.loadGraphData");
  assert.match(src, /_wtnGraphLoadWrapped/, "must guard against double-wrapping (hot reload)");
  assert.match(src, /setTimeout\(\(\)\s*=>\s*\{\s*_loading\s*=\s*false;?\s*\},\s*300\)/, "must clear the flag after a trailing window, not immediately");
  assert.match(src, /export function isGraphLoading/);
});

test("index.js: setupNode's sizing block is gated on isGraphLoading() || node._anConfiguring -- the fix for the Generator snapping to its fresh-node default (360x340) on every refresh/workflow re-open", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(indexSource, /import\s*\{\s*isGraphLoading\s*\}\s*from\s*"\.\.\/shared\/graph_loading\.mjs"/, "must import isGraphLoading eagerly (not through loadMods())");

  const setupIdx = indexSource.indexOf("function setupNode(");
  const restoreIdx = indexSource.indexOf("function restoreNode(");
  assert.ok(setupIdx >= 0 && restoreIdx > setupIdx, "setupNode must be defined, and restoreNode must follow it");
  const setupBody = indexSource.slice(setupIdx, restoreIdx);

  const gateIdx = setupBody.indexOf("if (isGraphLoading() || node._anConfiguring)");
  assert.ok(gateIdx >= 0, "setupNode must gate on BOTH isGraphLoading() and node._anConfiguring");
  const sizingIdx = setupBody.indexOf("wFloor");
  assert.ok(sizingIdx > gateIdx, "the gate must come BEFORE the actual sizing/Math.max floor logic, not after");

  // restoreNode itself must still do no sizing at all -- the gate above is
  // what makes setupNode (which DOES run on the restore path, unlike
  // restoreNode) honour that same rule instead of quietly violating it.
  const restoreBody = indexSource.slice(restoreIdx, restoreIdx + 400);
  assert.doesNotMatch(restoreBody, /setSize\(/);
});

// ===========================================================================
// H4. The Use-Everywhere submit-churn guard (`js/shared/submit_guard.mjs`'s
//     `isSubmitting()`) -- a connect-then-disconnect burst across every
//     UE-fed socket at prompt-submit time used to wipe the very
//     `_anContextRun` a run had just stashed. Neither `submit_guard.mjs`
//     nor `index.js` can be imported directly here (both carry a top-level
//     absolute `/scripts/app.js` import) -- covered by static source scans,
//     same technique as H2's `isGraphLoading` coverage just above.
// ===========================================================================

test("js/shared/submit_guard.mjs: wraps app.queuePrompt AND app.graphToPrompt (idempotency-guarded), holds a flag through the call plus a GENEROUS trailing window, and exports isSubmitting", () => {
  const src = readFileSync(path.join(__dirname, "..", "shared", "submit_guard.mjs"), "utf8");
  assert.match(src, /app\[fnName\]\s*=\s*function/, "must wrap the submit entry point(s) generically");
  assert.match(src, /wrapSubmitFn\("queuePrompt"\)/, "must wrap app.queuePrompt");
  assert.match(src, /wrapSubmitFn\("graphToPrompt"\)/, "must ALSO wrap app.graphToPrompt (the more likely link-injection point)");
  assert.match(src, /_wtnSubmitWrapped_/, "must guard against double-wrapping (hot reload)");
  assert.match(src, /TRAILING_MS\s*=\s*600/, "the trailing window must be generous (>= graph_loading.mjs's own 300ms), since the executed message and the UE teardown ordering isn't pinned down live");
  assert.match(src, /export function isSubmitting/);
});

test("index.js: BOTH onConnectionsChange hooks (the Bridge's forward-walk one, and the Generator's own) skip clearContextRun AND the repaint entirely while isSubmitting() -- the fix for post-run context-supplied values never appearing", () => {
  const src = readFileSync(path.join(__dirname, "index.js"), "utf8");
  assert.match(src, /import\s*\{\s*isSubmitting\s*\}\s*from\s*"\.\.\/shared\/submit_guard\.mjs"/, "must import isSubmitting eagerly (not through loadMods())");

  const bridgeConnIdx = src.indexOf("nodeType.prototype.onConnectionsChange = function (...args) {\n        const result = _bridgeConn");
  const genConnIdx = src.indexOf("nodeType.prototype.onConnectionsChange = function (...args) {\n      const result = _conn");
  assert.ok(bridgeConnIdx >= 0, "expected the Bridge's own onConnectionsChange hook");
  assert.ok(genConnIdx > bridgeConnIdx, "expected the Generator/Preview onConnectionsChange hook to follow it");

  const bridgeHookBody = src.slice(bridgeConnIdx, genConnIdx);
  assert.match(bridgeHookBody, /if\s*\(isSubmitting\(\)\)\s*\{\s*return result;/, "the Bridge hook must bail out entirely (no clear, no downstream repaint) while submitting");

  const genHookBody = src.slice(genConnIdx, genConnIdx + 1600);
  assert.match(genHookBody, /if\s*\(isSubmitting\(\)\)\s*\{\s*return result;/, "the Generator branch must bail out entirely (no clear, no repaint) while submitting");
  // The Preview branch of the SAME hook must be untouched -- UE's churn is
  // on the Bridge's context sockets, never the Preview's own images/
  // metadata_json, so its repaint must still fire unconditionally.
  assert.match(genHookBody, /repaintPreview\(this, this\._anCtx\)/);
});

// ===========================================================================
// H3. The hybrid essentials/⚙ dispatch (task items 1-4) -- card CSS,
//     stepper option lists, the inline/advanced field split per section, ⚙
//     menu edit persistence vs rebuild, and the type-scale constants.
// ===========================================================================

test("card CSS contract (task item 1): .wtn-an-sbody continues its header's own surface/border and rounds ONLY its bottom corners; the header squares off its OWN bottom corners while expanded", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;

  const bodyRule = cssRuleBody(cssText, ".wtn-an-sbody");
  assert.ok(bodyRule, "expected a .wtn-an-sbody rule");
  assert.ok(bodyRule.includes("background: var(--wtn-surface-2"), ".wtn-an-sbody must share the header's OWN surface token");
  assert.ok(bodyRule.includes("border-top: none"), ".wtn-an-sbody must not double the header's own bottom border into a seam");
  assert.match(bodyRule, /border-radius:\s*0 0 8px 8px/, ".wtn-an-sbody must round ONLY its bottom corners");

  const expandedRule = cssRuleBody(cssText, ".wtn-an-shead.wtn-an-expanded");
  assert.ok(expandedRule, "expected a .wtn-an-shead.wtn-an-expanded rule");
  assert.match(expandedRule, /border-radius:\s*8px 8px 0 0/, "the EXPANDED header must square off its own bottom corners so it joins the body below with no visible seam");
  assert.match(expandedRule, /margin-bottom:\s*0/, "the expanded header must drop its own bottom margin -- zero gap between header and body");
});

test("card CSS contract: a dep (missing-dependency) section's body continues the SAME warn-tinted border its header carries", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const cssText = doc.head.children.find((c) => c.id === "wtn-anima-style").textContent;
  const depHeadRule = cssRuleBody(cssText, ".wtn-an-shead.wtn-an-dep");
  const depBodyRule = cssRuleBody(cssText, ".wtn-an-sbody.wtn-an-dep");
  assert.ok(depHeadRule && depBodyRule, "expected BOTH a header and a body dep rule");
  assert.equal(depHeadRule.match(/border-color:\s*([^;]+);/)[1], depBodyRule.match(/border-color:\s*([^;]+);/)[1], "the body's dep border colour must match the header's own");
});

test("a stepper's onOpenList is wired (task item 2's dead-dropdown fix) -- clicking the value/caret opens an anchored, scrollable option list marking the CURRENT selection, and picking one writes+persists+closes", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, {
    getKnownLists: () => ({
      checkpoints: ["sam3.1_multiplex_fp16.safetensors", "other_checkpoint.safetensors"],
      upscale_models: ["2x-AnimeSharpV4_Fast_RCAN_PU.safetensors"],
    }),
  });
  const refs = mountGeneratorUI(node, ctx);
  // Highres HAS a switch -- enable it to reach its inline body isn't even
  // needed here (upscale_method now lives in the ⚙ menu) -- use the
  // Detailer's inline SAM3 checkpoint picker instead, a stepper that's
  // ALWAYS inline and always has a real option list from ctx.getKnownLists().
  fire(switchOf(findSectionHeader(refs.body, "Detailer")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Detailer"));
  const field = findFieldByLabel(body, "checkpoint");
  assert.ok(field, "expected the SAM3 checkpoint stepper inline");
  const combo = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body")).children.find((c) => hasClass(c, "wtn-fld-combo"));

  fire(combo, "click");
  assert.ok(activeOverlayRef.current, "clicking the combo must open an option-list overlay");
  const menu = activeOverlayRef.current.overlay.children[0];
  assert.ok(hasClass(menu, "wtn-an-optlist"), "the option list must carry the scrollable optlist modifier");
  const opts = queryAll(menu, (n) => hasClass(n, "wtn-an-opt"));
  assert.ok(opts.length >= 2, "the checkpoint list must have real options (ctx.getKnownLists().checkpoints)");
  const current = genState(node).detailer.sam3.checkpoint;
  assert.ok(opts.some((o) => hasClass(o, "wtn-an-opt-sel") && o.textContent === current), "the CURRENT value must be marked selected");

  const other = opts.find((o) => o.textContent !== current);
  fire(other, "click");
  assert.equal(activeOverlayRef.current, null, "picking an option must close the list");
  assert.equal(genState(node).detailer.sam3.checkpoint, other.textContent, "picking an option must write+persist it");

  // A second click on the SAME combo toggles it closed instead of
  // close-then-reopen (js/shared/overlay.mjs's own documented trap).
  fire(combo, "click");
  assert.ok(activeOverlayRef.current);
  fire(combo, "click");
  assert.equal(activeOverlayRef.current, null, "a second click on the SAME opener must close its own list, not reopen it");
});

test("stale-value regression (task item 2): stepping a stepper with an ARROW first, then opening its option list, must highlight the NEW value -- this fails against the old buildAnStepper that captured spec.value at build time", () => {
  const node = makeGeneratorNode({
    generation_settings: JSON.stringify({ sampler: { sampler_name: "euler" } }),
  });
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc, {
    getKnownLists: () => ({ checkpoints: [], upscale_models: [], samplers: ["euler", "dpmpp_2m", "heun"], schedulers: [] }),
  });
  const refs = mountGeneratorUI(node, ctx);
  const body = sectionBodyOf(findSectionHeader(refs.body, "Sampler")); // expanded by default

  const field = findFieldByLabel(body, "sampler_name");
  const stepperBody = field.children.find((c) => hasClass(c, "wtn-fld-stepper-body"));
  const rightArrow = stepperBody.children.find((c) => hasClass(c, "wtn-fld-right"));
  const combo = stepperBody.children.find((c) => hasClass(c, "wtn-fld-combo"));

  fire(rightArrow, "click"); // euler -> dpmpp_2m, in place (no rebuild)
  assert.equal(genState(node).sampler.sampler_name, "dpmpp_2m", "the arrow must have written the new value");

  fire(combo, "click");
  assert.ok(activeOverlayRef.current, "expected the option list to open");
  const menu = activeOverlayRef.current.overlay.children[0];
  const opts = queryAll(menu, (n) => hasClass(n, "wtn-an-opt"));
  const selected = opts.find((o) => hasClass(o, "wtn-an-opt-sel"));
  assert.ok(selected, "expected exactly one option marked selected");
  assert.equal(selected.textContent, "dpmpp_2m", "the NEW (post-arrow) value must be the one marked selected, not the stale build-time value ('euler')");
  closeActiveOverlay();
});

/** Every visible field LABEL (numeric/stepper/bool/text -- the union
 * `findFieldByLabel`'s own predicate already covers) inside `root`, walked
 * recursively -- used to assert an exact inline/advanced split against
 * task item 3's table, both directions. */
function allFieldLabels(root) {
  const containers = queryAll(root, (n) =>
    hasClass(n, "wtn-fld-num") || hasClass(n, "wtn-fld-stepper") || hasClass(n, "wtn-an-boolfield") || hasClass(n, "wtn-an-field"));
  return containers.map((f) => {
    const nameEl = f.children.find((c) => hasClass(c, "wtn-fld-num-name") || hasClass(c, "wtn-fld-stepper-name")) || f.children[0];
    return nameEl && nameEl.textContent;
  }).filter(Boolean);
}

/** Flips a ⚙ menu's own "inherit" boolfield off -- `cfg`/`sampler_name`/
 * `scheduler` only render while inherit is OFF (design doc §6b), so every
 * inline/advanced split test below has to turn it off first to see all
 * three, exactly like a real user opening the menu for the first time
 * would (it defaults ON). */
function toggleInheritOff(box) {
  const inheritField = queryAll(box, (n) => hasClass(n, "wtn-an-boolfield"))
    .find((f) => (f.children[0] || {}).textContent === "inherit");
  assert.ok(inheritField, "expected an 'inherit' boolfield in this menu");
  fire(inheritField.children.find((c) => hasClass(c, "wtn-fld-switch")), "click");
}

test("Highres: the inline field set is EXACTLY {scale_by, steps, denoise} -- every advanced field (inherit, cfg, sampler_name, scheduler, max_long_edge, multiple, upscale_method) is present in the ⚙ menu and ABSENT inline, both directions (task item 3's table)", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  fire(switchOf(findSectionHeader(refs.body, "Highres")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Highres"));
  assert.deepEqual(allFieldLabels(body).sort(), ["denoise", "scale_by", "steps"].sort());

  const box = openGearMenu(findSectionHeader(refs.body, "Highres"));
  toggleInheritOff(box); // reveal cfg/sampler_name/scheduler (hidden by default -- inherit starts ON)
  const advancedLabels = allFieldLabels(box);
  for (const label of ["inherit", "cfg", "sampler_name", "scheduler", "max_long_edge", "multiple", "upscale_method"]) {
    assert.ok(advancedLabels.includes(label), `expected ${label} in Highres's ⚙ menu`);
  }
  for (const label of ["scale_by", "steps", "denoise"]) {
    assert.ok(!advancedLabels.includes(label), `${label} is INLINE, must not ALSO be in the ⚙ menu`);
  }
});

test("Upscale: the inline field set is EXACTLY {Model, scale_by, steps, denoise} -- 'Model' (renamed from the over-qualified 'upscale_model_name', settings path unchanged) plus every USDU tile/seam field and the sampler-inherit block live ONLY in the ⚙ menu (task item 3's table)", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  fire(switchOf(findSectionHeader(refs.body, "Upscale")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Upscale"));
  assert.deepEqual(allFieldLabels(body).sort(), ["Model", "denoise", "scale_by", "steps"].sort());

  const box = openGearMenu(findSectionHeader(refs.body, "Upscale"));
  toggleInheritOff(box);
  const advancedLabels = allFieldLabels(box);
  for (const label of [
    "inherit", "cfg", "sampler_name", "scheduler",
    "auto_tile_size", "mode_type", "auto_tile_target", "auto_tile_min", "auto_tile_max",
    "tile_width", "tile_height", "mask_blur", "tile_padding", "force_uniform_tiles", "batch_size", "tiled_decode",
    "seam_fix_mode", "seam_fix_denoise", "seam_fix_width", "seam_fix_mask_blur", "seam_fix_padding",
  ]) {
    assert.ok(advancedLabels.includes(label), `expected ${label} in Upscale's ⚙ menu`);
  }
  for (const label of ["Model", "scale_by", "steps", "denoise"]) {
    assert.ok(!advancedLabels.includes(label), `${label} is INLINE, must not ALSO be in the ⚙ menu`);
  }
});

test("Detailer block: the inline field set is EXACTLY {label, threshold, steps, denoise} (plus the structural tab/reorder/on-off controls) -- every other field (detect_prompt, wildcard, sampler inherit, crop_factor, guide_size, ...) lives ONLY behind that block's OWN ⚙ (task item 3's table)", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  fire(switchOf(findSectionHeader(refs.body, "Detailer")), "click");
  const body = sectionBodyOf(findSectionHeader(refs.body, "Detailer"));
  // "checkpoint" is the section-level sam3 picker, not a per-block field --
  // excluded from the per-block inline set assertion below by name.
  const inlineLabels = allFieldLabels(body).filter((l) => l !== "checkpoint");
  assert.deepEqual(inlineLabels.sort(), ["denoise", "label", "steps", "threshold"].sort());

  const gear = queryAll(body, (n) => hasClass(n, "wtn-fld-gear"))[0];
  assert.ok(gear, "expected the active block's own ⚙ inside the Detailer body");
  fire(gear, "click");
  const box = activeOverlayRef.current.overlay.children[0];
  toggleInheritOff(box);
  const advancedLabels = allFieldLabels(box);
  for (const label of [
    "detect_prompt", "wildcard", "detect_count", "inherit", "cfg", "sampler_name", "scheduler",
    "crop_factor", "guide_size", "guide_size_for", "max_size", "feather",
    "noise_mask", "noise_mask_feather", "force_inpaint", "inpaint_model", "cycle",
    "refine_iterations", "drop_size", "bbox_fill", "contour_fill", "combined",
    "individual_masks", "alignment", "tiled_decode", "tiled_encode",
  ]) {
    assert.ok(advancedLabels.includes(label), `expected ${label} in the block's ⚙ menu`);
  }
  for (const label of ["label", "threshold", "steps", "denoise"]) {
    assert.ok(!advancedLabels.includes(label), `${label} is INLINE, must not ALSO be in the block's ⚙ menu`);
  }
});

test("⚙ menu: editing a plain VALUE field (that doesn't change what the menu shows) persists immediately and does NOT rebuild the menu -- the SAME DOM node reference survives the edit", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  fire(switchOf(findSectionHeader(refs.body, "Highres")), "click");
  const box = openGearMenu(findSectionHeader(refs.body, "Highres"));

  const maxLongEdgeField = findFieldByLabel(box, "max_long_edge");
  assert.ok(maxLongEdgeField);
  maxLongEdgeField._rect = { left: 0, top: 0, right: 300, bottom: 25, width: 300, height: 25 };
  fire(maxLongEdgeField, "pointerdown", { clientX: 300 });
  fire(maxLongEdgeField, "pointerup", { clientX: 300 });

  assert.ok(activeOverlayRef.current, "the menu must still be open");
  // The identical field element must still be attached to the SAME box --
  // a rebuild would have replaced every child with a freshly-built one.
  assert.ok(findFieldByLabel(box, "max_long_edge") === maxLongEdgeField, "editing a non-shape-changing field must not rebuild the menu's DOM");
  assert.equal(genState(node).highres.max_long_edge, 8192, "the edit must still persist");
});

test("font/height constants (task item 4) are internally consistent: every row/header height and node-size floor scales together, and the litegraph-native chrome constant does NOT", () => {
  // Row/header heights: the header is taller than a plain field row (it
  // carries a chevron/switch/⚙ cluster the field rows don't).
  assert.ok(SHEAD_H > fields.FLD_ROW_H, "SHEAD_H must be taller than a plain field row");
  assert.equal(BASE_FONT, 14, "the base type this whole pass scaled to");
  assert.ok(fields.FLD_FONT < BASE_FONT, "field body type stays slightly smaller than the panel's own base font, matching the pre-existing proportion");

  // Width/height floors must all have grown from their pre-dispatch values
  // (this file's own "Resize" section comments record the "was" numbers).
  assert.ok(DEFAULT_W > 360 && GENERATOR_MIN_W > 320 && PREVIEW_MIN_W > 380);
  assert.ok(PREVIEW_IMG_MIN_H > 160 && PANEL_MIN_H > 220);

  // PREVIEW_PANEL_MIN_H's own recomputed arithmetic (task item 2's second
  // bullet, render.mjs's own comment) sums to within rounding of the
  // exported constant.
  const saveRowH = SHEAD_H + SHEAD_GAP;
  const compareRowH = 8 + 24; // pvbar margin-top + its own segmented-button content
  const bodyGaps = 5 * 2; // 3 children (save row / wipe / compare row) -> 2 gaps
  const panelChrome = 7 * 2 + 1 * 2; // padding top+bottom, border top+bottom
  const sum = saveRowH + compareRowH + PREVIEW_IMG_MIN_H + bodyGaps + panelChrome;
  assert.ok(sum <= PREVIEW_PANEL_MIN_H, "PREVIEW_PANEL_MIN_H must cover the documented arithmetic");
  assert.ok(PREVIEW_PANEL_MIN_H - sum < 4, "rounded up to the nearest 4px grid only, not padded further");

  // The node-chrome constant (title bar + socket rows) is litegraph's OWN
  // native pixel geometry, independent of this file's type scale -- it must
  // NOT have moved just because everything else did.
  assert.equal(PREVIEW_MIN_H - PREVIEW_PANEL_MIN_H, 80, "the node-chrome addend must stay 80 regardless of the type-scale pass");
});

// ===========================================================================
// I. Node chrome (dark body + darker title bar) -- `../shared/node_chrome.mjs`
//    is the single shared implementation (`js/controls/render.mjs` delegates
//    to the same module); these cases cover it directly, mirroring
//    `js/controls/test_resize.mjs`'s own `applyNodeChrome` coverage so the
//    shared module itself -- not just one track's re-export of it -- is
//    under test here too.
// ===========================================================================

test("applyNodeChrome paints bgcolor/color on a fresh Generator node (litegraph's actual undefined default)", () => {
  const node = makeGeneratorNode();
  assert.equal(node.bgcolor, undefined);
  assert.equal(node.color, undefined);
  applyNodeChrome(node);
  assert.equal(node.bgcolor, CHROME_BODY);
  assert.equal(node.color, CHROME_TITLE);
});

test("applyNodeChrome paints bgcolor/color on a fresh Preview node (litegraph's actual undefined default)", () => {
  const node = makePreviewNode();
  assert.equal(node.bgcolor, undefined);
  assert.equal(node.color, undefined);
  applyNodeChrome(node);
  assert.equal(node.bgcolor, CHROME_BODY);
  assert.equal(node.color, CHROME_TITLE);
});

test("applyNodeChrome also paints a fresh node with explicit null (not just undefined)", () => {
  const node = { bgcolor: null, color: null };
  applyNodeChrome(node);
  assert.equal(node.bgcolor, CHROME_BODY);
  assert.equal(node.color, CHROME_TITLE);
});

test("applyNodeChrome NEVER overwrites a node that already has an explicit bgcolor/color -- the user's own right-click Colors pick must survive", () => {
  const node = makeGeneratorNode();
  node.bgcolor = "#ff00ff";
  node.color = "#00ff00";
  applyNodeChrome(node);
  assert.equal(node.bgcolor, "#ff00ff");
  assert.equal(node.color, "#00ff00");
});

test("applyNodeChrome fills in only the ONE still-null field, leaving an explicitly-set sibling alone (the mixed case)", () => {
  const node = { bgcolor: "#ff00ff", color: null };
  applyNodeChrome(node);
  assert.equal(node.bgcolor, "#ff00ff"); // untouched
  assert.equal(node.color, CHROME_TITLE); // filled in

  const node2 = { bgcolor: null, color: "#00ff00" };
  applyNodeChrome(node2);
  assert.equal(node2.bgcolor, CHROME_BODY); // filled in
  assert.equal(node2.color, "#00ff00"); // untouched
});

test("applyNodeChrome is a no-op (never throws) against a null/undefined node", () => {
  assert.doesNotThrow(() => applyNodeChrome(null));
  assert.doesNotThrow(() => applyNodeChrome(undefined));
});

test("index.js: node chrome is painted from the standalone setupNode() function only (the fresh-node path, reached via onNodeCreated), gated on !node._anConfiguring, and never from restoreNode()", () => {
  const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");
  const setupIdx = indexSource.indexOf("function setupNode(node, mods, isGenerator)");
  const restoreIdx = indexSource.indexOf("function restoreNode(node, mods, isGenerator)");
  const afterRestoreIdx = indexSource.indexOf("app.registerExtension({", restoreIdx);
  assert.ok(setupIdx >= 0, "setupNode() must exist");
  assert.ok(restoreIdx > setupIdx, "restoreNode() must be defined after setupNode()");
  assert.ok(afterRestoreIdx > restoreIdx, "app.registerExtension(...) must come after restoreNode()");

  const setupNodeBody = indexSource.slice(setupIdx, restoreIdx);
  const restoreNodeBody = indexSource.slice(restoreIdx, afterRestoreIdx);

  assert.match(setupNodeBody, /applyNodeChrome\(/, "setupNode's fresh-node path must call applyNodeChrome");
  assert.match(setupNodeBody, /!node\._anConfiguring/, "setupNode's chrome call must be gated on !node._anConfiguring");
  assert.doesNotMatch(restoreNodeBody, /applyNodeChrome\(/, "restoreNode (the restore path) must never call applyNodeChrome");

  // The guard flag itself: set at the very TOP of onConfigure, BEFORE the
  // loadMods() promise -- setupNode runs in a deferred microtask (this
  // file's own top doc comment), so a loaded-workflow's onNodeCreated could
  // otherwise run its (also-deferred) setupNode call AFTER onConfigure has
  // already reset the flag, missing the window entirely. Setting it
  // synchronously, before any async gap, guarantees the flag is still true
  // for the whole load window regardless of how long the (one-time, cached)
  // import takes -- matching js/controls/index.js's identical
  // `_ctrlConfiguring` ordering rule.
  const configureIdx = indexSource.indexOf("nodeType.prototype.onConfigure = function");
  assert.ok(configureIdx >= 0, "onConfigure patch must exist");
  const configureFnBody = indexSource.slice(configureIdx, indexSource.indexOf("loadMods()", configureIdx));
  assert.match(configureFnBody, /this\._anConfiguring\s*=\s*true/, "_anConfiguring must be set at the top of onConfigure, before loadMods()");
  assert.match(indexSource, /_anConfiguring\s*=\s*false/, "the restore path must clear _anConfiguring once mods have resolved (or failed)");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
