/**
 * test_resize.mjs — regression tests for `state.mjs` (pure settings logic),
 * `render.mjs` (DOM/CSS building), and `interaction.mjs` (event wiring +
 * node-level orchestration) for `AnimaGenerator` / `AnimaPreview`. Runs
 * under plain `node` via a small DOM + fake-litegraph-node stub (same
 * pattern as `js/controls/test_resize.mjs` / `js/prompt_rules/node/
 * test_resize.mjs`), never imports `index.js` directly (it needs a real
 * `app`/`window.LiteGraph`, which only exist in an actual ComfyUI page).
 *
 * Regenerating the fixtures this file checks the JS normalizer against
 * (only needed if `src/anima/settings.py`/`preview_settings.py`'s DEFAULTS
 * change):
 *   python3 -c "import sys,json; sys.path.insert(0,'.'); \
 *     from src.anima.settings import DEFAULT_GENERATION_SETTINGS as D; \
 *     open('js/anima/fixture_default_generation_settings.json','w')\
 *       .write(json.dumps(D, indent=2, sort_keys=True) + '\n')"
 *   python3 -c "import sys,json; sys.path.insert(0,'.'); \
 *     from src.anima.preview_settings import DEFAULT_PREVIEW_SETTINGS as D; \
 *     open('js/anima/fixture_default_preview_settings.json','w')\
 *       .write(json.dumps(D, indent=2, sort_keys=True) + '\n')"
 *
 * Covers:
 *   A. `state.mjs` — the JS settings normalizer deep-equals Python's own
 *      output for the default case (against the checked-in fixtures above)
 *      and for a non-trivial payload (unknown top-level keys, an unknown
 *      detailer block id merging against the face template, `order`
 *      exceeding `MAX_DETAILER_PASSES`); `deepMergeDefaults`/
 *      `migrateVersion` edge cases; LoRA/detailer-block mutation helpers;
 *      `resolveStageSampler`/`resolveOutputs`; `preferredNameDefault`.
 *   B. `render.mjs` — CSS injection, the small presentational builders.
 *   C. `interaction.mjs` — the widget<->state handshake (every kind of edit
 *      reaches the SERIALIZED widget, not just in-memory state); the
 *      Generator body's inline-mode-only rows (LoRA list, latent row);
 *      stage toggle; LoRA add/remove/reorder/mute (order preserved);
 *      detailer add/remove respecting `MAX_DETAILER_PASSES` and the
 *      face/eye "cannot be removed" rule; the `inherit_sampler_settings`
 *      contract (hides exactly `cfg`/`sampler_name`/`scheduler`, in both
 *      directions, for highres/upscale/a detailer block); the Preview
 *      node's compare/save rows and the wipe divider maths; the popover
 *      close-then-reopen owner-key toggle; wheel-zoom install/teardown; the
 *      unet/clip/vae picker rows never falling back to `options[0]` for an
 *      orphaned saved value.
 *
 * MANUAL-IN-COMFYUI CHECKLIST (this headless harness cannot confirm any of
 * this — the real `addDOMWidget`/legacy-litegraph runtime contract, actual
 * screen-space overlay placement, and actual socket wire behaviour only
 * exist live):
 *   [ ] A fresh Generator/Preview node renders with the house theme applied
 *       (`.wtn` + `injectTheme()` actually landing) and real litegraph
 *       sockets line up sensibly above this DOM body.
 *   [ ] `generation_settings`/`preview_state` widgets are invisible on the
 *       node face but present (and correctly populated) in the saved
 *       workflow JSON / the queued API prompt.
 *   [ ] The ⚙ popovers actually appear beside the correct row on screen and
 *       flip to the other side when they'd overflow the viewport (this
 *       harness only asserts inline style values against a fake
 *       `getBoundingClientRect`/`innerWidth`/`innerHeight`, never real
 *       layout).
 *   [ ] Right-click "Convert widget to input" is not needed for the five
 *       sampler sockets (they're `forceInput`, socket-only) — confirm a
 *       Control Panel row wires directly.
 *   [ ] The wipe's hover tracks the cursor smoothly with no jitter, and
 *       `object-fit: contain` visibly aligns two differently-sized images.
 *   [ ] Mouse wheel over the node body zooms the canvas, except while
 *       hovering a genuinely scrollable popover (`.wtn-an-pop`'s own
 *       `overflow: auto`).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  GENERATION_SETTINGS_SCHEMA,
  PREVIEW_SETTINGS_SCHEMA,
  MAX_DETAILER_PASSES,
  COMPARE_SLOTS,
  SAVE_WHICH_OPTIONS,
  deepMergeDefaults,
  migrateVersion,
  normalizeGenerationSettings,
  normalizePreviewSettings,
  defaultGenerationSettings,
  resolveStageSampler,
  resolveOutputs,
  addLora,
  removeLora,
  moveLora,
  toggleMuteLora,
  addDetailerBlock,
  removeDetailerBlock,
  moveDetailerBlock,
  isBuiltinDetailerBlock,
  preferredNameDefault,
  UNET_NAME_CANDIDATES,
} from "./state.mjs";

import {
  injectStyles,
  buildStatusRow,
  buildSwitch,
  sectionLabel,
  measureMinHeight,
  buildPreviewImageUrl,
  DEFAULT_W,
  DEFAULT_H,
} from "./render.mjs";

import {
  getGenSettingsWidget,
  getPreviewStateWidget,
  ensureGenState,
  persistGenState,
  computeWiredFlags,
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
  // singleton (by design -- only one overlay should ever be open across the
  // whole page). Reset it before every test so a popover a PREVIOUS test
  // left open (deliberately, to inspect it) never makes an unrelated later
  // test's `openPopover` treat itself as "already open -- toggle closed".
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
globalThis.getComputedStyle = (el) => (el && el.style) || {};

// ---------------------------------------------------------------------------
// Minimal DOM stub -- mirrors js/controls/test_resize.mjs's makeDocStub
// exactly (contains/closest/getBoundingClientRect/insertBefore), plus a
// `style.setProperty` (the wipe divider's `--wipe-x` CSS var).
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
      addEventListener(type, fn) {
        (elObj._listeners[type] = elObj._listeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        const arr = elObj._listeners[type];
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
      offsetHeight: 20,
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

function fire(elx, type, overrides = {}) {
  const e = { type, target: elx, button: 0, stopPropagation() {}, preventDefault() {}, ...overrides };
  (elx._listeners[type] || []).slice().forEach((fn) => fn(e));
}

// ---------------------------------------------------------------------------
// Query helpers -- interaction.mjs doesn't hand back a per-row refs map (the
// body is fully rebuilt on every action, see its top doc comment), so tests
// walk the built DOM tree instead, same spirit as asserting rendered HTML.
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
  return row.children.find((c) => hasClass(c, "wtn-an-gear"));
}
function switchOf(row) {
  return row.children.find((c) => hasClass(c, "wtn-an-sw"));
}
function findFieldByLabel(root, label) {
  return queryAll(root, (n) => hasClass(n, "wtn-an-field")).find((f) => (f.children[0] || {}).textContent === label);
}
function popoverRoot(doc) {
  return queryAll(doc.body, (n) => hasClass(n, "wtn-an-pop")).slice(-1)[0];
}

// ---------------------------------------------------------------------------
// Fake litegraph nodes
// ---------------------------------------------------------------------------

function makeGeneratorNode(widgetValues = {}, wiredInputs = {}) {
  const defaults = {
    generation_settings: "{}",
    use_internal_loaders: false,
    unet_name: "anima-base-v1.0.safetensors",
    clip_name: "qwen_3_06b_base.safetensors",
    clip_type: "qwen_image",
    vae_name: "qwen_image_vae.safetensors",
  };
  const values = { ...defaults, ...widgetValues };
  const optionsFor = {
    unet_name: ["anima-base-v1.0.safetensors", "some-other-model.safetensors"],
    clip_name: ["qwen_3_06b_base.safetensors"],
    clip_type: ["stable_diffusion", "qwen_image"],
    vae_name: ["qwen_image_vae.safetensors"],
  };
  const widgets = Object.entries(values).map(([name, value]) => ({
    name,
    value,
    options: optionsFor[name] ? { values: optionsFor[name] } : undefined,
  }));

  const inputNames = ["positive", "negative", "model", "clip", "vae", "latent", "seed", "steps", "cfg", "sampler_name", "scheduler"];
  const inputs = inputNames.map((name) => ({ name, link: wiredInputs[name] ? 1 : null }));

  const node = {
    size: [DEFAULT_W, 100],
    widgets,
    inputs,
    outputs: [],
    setSize(s) {
      node.size = s.slice();
    },
    setDirtyCanvas() {},
    disconnectInput(idx) {
      if (node.inputs[idx]) {
        node.inputs[idx].link = null;
      }
    },
  };
  return node;
}

function makePreviewNode(widgetValues = {}, wiredInputs = {}) {
  const widgets = [{ name: "preview_state", value: widgetValues.preview_state ?? "{}" }];
  const inputNames = ["image_a", "image_b", "image_c"];
  const inputs = inputNames.map((name) => ({ name, link: wiredInputs[name] ? 1 : null }));
  const node = {
    size: [396, 420],
    widgets,
    inputs,
    outputs: [],
    setSize(s) {
      node.size = s.slice();
    },
    setDirtyCanvas() {},
  };
  return node;
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

test("normalizeGenerationSettings('{}') deep-equals Python's own DEFAULT_GENERATION_SETTINGS (checked-in fixture)", () => {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, "fixture_default_generation_settings.json"), "utf8"));
  const got = normalizeGenerationSettings("{}");
  assert.deepEqual(got, fixture);
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

test("normalizeGenerationSettings: unknown top-level keys survive, missing keys default, garbage JSON never throws", () => {
  const out = normalizeGenerationSettings('{"unknown_top": "keep me", "sampler": {"steps": 99} , not json');
  // Garbage JSON (trailing `, not json`) -> parse fails -> full defaults, but
  // the unknown-key/missing-key CONTRACT is what this test is really for,
  // so assert it against valid JSON too.
  const ok = normalizeGenerationSettings(JSON.stringify({ unknown_top: "keep me", sampler: { steps: 99 } }));
  assert.equal(ok.unknown_top, "keep me");
  assert.equal(ok.sampler.steps, 99);
  assert.equal(ok.sampler.cfg, 5.0); // missing key -> default
  assert.equal(ok.schema, GENERATION_SETTINGS_SCHEMA);
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
  assert.equal(out.detailer.blocks.custom_9.detect_prompt, "nine");
  // Merged against the FACE template, not left as a bare partial object --
  // every face-shaped key is present with the face default value.
  assert.equal(out.detailer.blocks.custom_9.crop_factor, 4.0);
  assert.equal(out.detailer.blocks.custom_9.noise_mask_feather, 10);
  assert.equal(out.detailer.blocks.face.threshold, 0.9);
  // custom_2/custom_3 are present but bumped past the cap.
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
  assert.equal(resolved.steps, 20); // the STAGE's own, never the base's 32
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

test("resolveOutputs: a disabled/inert stage passes the previous stage's image through (image_mid == image_base is legitimate)", () => {
  const off = resolveOutputs({ highresEnabled: false, detailerEnabled: false, haveImpact: true, blocks: {}, upscaleEnabled: false, haveUsdu: true });
  assert.equal(off.image_base, "base");
  assert.equal(off.image_mid, "base");
  assert.equal(off.image, "base");

  const detailerNoBlocksOn = resolveOutputs({
    highresEnabled: true, detailerEnabled: true, haveImpact: true,
    blocks: { face: { enabled: false }, eye: { enabled: false } }, upscaleEnabled: true, haveUsdu: true,
  });
  assert.equal(detailerNoBlocksOn.detailerLive, false);
  assert.equal(detailerNoBlocksOn.image_mid, "highres"); // passes highres through, not "mid"
  assert.equal(detailerNoBlocksOn.image, "upscale");

  const allOn = resolveOutputs({
    highresEnabled: true, detailerEnabled: true, haveImpact: true,
    blocks: { face: { enabled: true } }, upscaleEnabled: true, haveUsdu: true,
  });
  assert.equal(allOn.image_mid, "mid");
  assert.equal(allOn.image, "upscale");
});

test("LoRA helpers: add/remove/reorder/mute — order is preserved and mute remembers the strength pair", () => {
  const loras = [];
  addLora(loras);
  addLora(loras);
  loras[0].name = "a";
  loras[1].name = "b";
  moveLora(loras, 0, 1);
  assert.deepEqual(loras.map((l) => l.name), ["b", "a"]);

  toggleMuteLora(loras[0]);
  assert.equal(loras[0].strength_model, 0);
  assert.equal(loras[0].strength_clip, 0);
  toggleMuteLora(loras[0]);
  assert.equal(loras[0].strength_model, 1.0);
  assert.equal(loras[0].strength_clip, 1.0);

  removeLora(loras, 0);
  assert.deepEqual(loras.map((l) => l.name), ["a"]);
});

test("Detailer block helpers: add respects MAX_DETAILER_PASSES, face/eye are unremovable", () => {
  const detailer = normalizeGenerationSettings("{}").detailer; // starts with face+eye
  assert.equal(removeDetailerBlock(detailer, "face"), false);
  assert.equal(removeDetailerBlock(detailer, "eye"), false);
  assert.ok(isBuiltinDetailerBlock("face") && isBuiltinDetailerBlock("eye"));
  assert.equal(isBuiltinDetailerBlock("custom_1"), false);

  const id1 = addDetailerBlock(detailer);
  const id2 = addDetailerBlock(detailer);
  assert.equal(Object.keys(detailer.blocks).length, MAX_DETAILER_PASSES); // face, eye, custom_1, custom_2
  const id3 = addDetailerBlock(detailer); // at the cap -- refused
  assert.equal(id3, null);
  assert.equal(Object.keys(detailer.blocks).length, MAX_DETAILER_PASSES);

  assert.equal(removeDetailerBlock(detailer, id1), true);
  assert.equal(Object.keys(detailer.blocks).length, MAX_DETAILER_PASSES - 1);
  assert.ok(!detailer.order.includes(id1));

  const before = detailer.order.slice();
  moveDetailerBlock(detailer, "eye", -1);
  assert.notDeepEqual(detailer.order, before);
});

test("preferredNameDefault: never falls back to options[0] when a real candidate/heuristic match exists", () => {
  assert.equal(preferredNameDefault(["zzz.safetensors", "anima-base-v1.0.safetensors"], UNET_NAME_CANDIDATES), "anima-base-v1.0.safetensors");
  assert.equal(preferredNameDefault(["zzz.safetensors", "nyaIrisAnima_base1V20.safetensors"], UNET_NAME_CANDIDATES), "nyaIrisAnima_base1V20.safetensors");
  // Animagine XL must NOT match the heuristic (a real, unrelated model).
  assert.equal(preferredNameDefault(["animagineXL31.safetensors", "zzz.safetensors"], UNET_NAME_CANDIDATES), "animagineXL31.safetensors");
  // Only when NOTHING matches at all does it fall through to [0].
  assert.equal(preferredNameDefault([], UNET_NAME_CANDIDATES), UNET_NAME_CANDIDATES[0]);
});

// ===========================================================================
// B. render.mjs — small presentational builders
// ===========================================================================

test("injectStyles is idempotent and guarded against a doc with no createElement", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  injectStyles(doc); // second call must not double-inject
  const styleTags = doc.head.children.filter((c) => c.tagName === "style");
  assert.equal(styleTags.length, 1);
  assert.doesNotThrow(() => injectStyles(null));
  assert.doesNotThrow(() => injectStyles({}));
});

test("buildStatusRow reflects wired/ignored via classes; buildSwitch/sectionLabel render expected text", () => {
  const doc = makeDocStub();
  const wired = buildStatusRow(doc, { name: "model", type: "MODEL", wired: true, ignored: false });
  assert.ok(hasClass(wired, "wtn-an-wired"));
  const ignored = buildStatusRow(doc, { name: "model", type: "MODEL", wired: false, ignored: true });
  assert.ok(hasClass(ignored, "wtn-an-ignored"));

  const on = buildSwitch(doc, true);
  assert.ok(hasClass(on, "wtn-an-on"));
  const off = buildSwitch(doc, false);
  assert.ok(!hasClass(off, "wtn-an-on"));

  const sec = sectionLabel(doc, "stages", "2/4 on");
  assert.ok(sec.children.some((c) => c.textContent === "stages"));
  assert.ok(sec.children.some((c) => hasClass(c, "wtn-an-cnt")));
});

// ===========================================================================
// C. interaction.mjs — Generator body, inline mode, stage toggle, LoRA,
//    detailer blocks. Every assertion reads the SERIALIZED WIDGET (never
//    only the in-memory state object) — the trap this whole track exists to
//    catch.
// ===========================================================================

test("mountGeneratorUI: brand-new node's generation_settings widget is written with the FULLY EXPANDED defaults, not left at Python's literal '{}'", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);
  const persisted = genState(node);
  assert.equal(persisted.schema, GENERATION_SETTINGS_SCHEMA);
  assert.equal(persisted.sampler.steps, 32); // NOT "{}" -- a real, expanded tree
});

test("LoRA list and latent row appear ONLY when use_internal_loaders is on", () => {
  const node = makeGeneratorNode({ use_internal_loaders: false });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  assert.equal(queryAll(refs.body, (n) => hasClass(n, "wtn-an-lora")).length, 0);
  assert.equal(queryAll(refs.body, (n) => hasClass(n, "wtn-an-addbtn")).length, 0);

  // Toggle the row -- clicking the internal-loaders row itself.
  const internalRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))
    .find((r) => (r.children.find((c) => hasClass(c, "wtn-an-nm")) || {}).textContent === "use_internal_loaders");
  fire(internalRow, "click");

  assert.equal(node.widgets.find((w) => w.name === "use_internal_loaders").value, true);
  assert.ok(queryAll(refs.body, (n) => hasClass(n, "wtn-an-addbtn")).length >= 1, "the + Add LoRA button must appear once inline mode is on");
  const latentRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))
    .find((r) => (r.children.find((c) => hasClass(c, "wtn-an-nm")) || {}).textContent === "latent");
  assert.ok(latentRow, "the latent row must appear once inline mode is on");
});

test("toggling a stage switch writes the generation_settings WIDGET, not just in-memory state", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  assert.equal(genState(node).highres.enabled, false);
  const row = findStageRow(refs.body, "Highres");
  fire(switchOf(row), "click");
  assert.equal(genState(node).highres.enabled, true, "the SERIALIZED widget must reflect the toggle");

  const rowAfter = findStageRow(node._anRefs.body, "Highres");
  assert.ok(hasClass(rowAfter, "wtn-an-off") === false);
});

test("adding/removing/reordering/muting a LoRA writes the widget with order preserved", () => {
  const node = makeGeneratorNode({ use_internal_loaders: true });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  let refs = mountGeneratorUI(node, ctx);

  const addBtn = () => queryAll(node._anRefs.body, (n) => hasClass(n, "wtn-an-addbtn"))[0];
  fire(addBtn(), "click");
  fire(addBtn(), "click");
  assert.equal(genState(node).loras.length, 2);

  // Name the two rows via their gear popovers so reordering is checkable.
  function openGearForLoraIndex(i) {
    const row = queryAll(node._anRefs.body, (n) => hasClass(n, "wtn-an-lora") && !hasClass(n, "wtn-an-empty"))[i];
    fire(gearOf(row), "click");
  }
  openGearForLoraIndex(0);
  let pop = popoverRoot(doc);
  let nameField = findFieldByLabel(pop, "name");
  nameField.children[1].value = "first";
  fire(nameField.children[1], "change");
  closeActiveOverlay();

  openGearForLoraIndex(1);
  pop = popoverRoot(doc);
  nameField = findFieldByLabel(pop, "name");
  nameField.children[1].value = "second";
  fire(nameField.children[1], "change");
  closeActiveOverlay();

  assert.deepEqual(genState(node).loras.map((l) => l.name), ["first", "second"]);

  // Mute the first row's switch (in the BODY, not the popover).
  const muteSwitch = () => queryAll(node._anRefs.body, (n) => hasClass(n, "wtn-an-lora") && !hasClass(n, "wtn-an-empty"))[0].children[0];
  fire(muteSwitch(), "click");
  let persisted = genState(node);
  assert.equal(persisted.loras[0].strength_model, 0);
  assert.equal(persisted.loras[0].strength_clip, 0);

  // Reorder via the second LoRA's "move up" button.
  openGearForLoraIndex(1);
  pop = popoverRoot(doc);
  const moveUpBtn = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent.includes("move up"));
  fire(moveUpBtn, "click");
  persisted = genState(node);
  assert.deepEqual(persisted.loras.map((l) => l.name), ["second", "first"], "order IS apply order -- must actually swap");

  // Remove the (now second) entry.
  openGearForLoraIndex(1);
  pop = popoverRoot(doc);
  const removeBtn = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent === "Remove LoRA");
  fire(removeBtn, "click");
  persisted = genState(node);
  assert.equal(persisted.loras.length, 1);
  assert.equal(persisted.loras[0].name, "second");
});

test("detailer popover: adding respects MAX_DETAILER_PASSES and face/eye stay unremovable, all reaching the widget", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);

  const row = findStageRow(refs.body, "Detailer");
  fire(gearOf(row), "click");
  let pop = popoverRoot(doc);

  // face/eye's "remove" is replaced by a disabled "built in" button.
  const builtinBtn = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent === "built in");
  assert.ok(builtinBtn && builtinBtn.disabled);

  const addBtn = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  fire(addBtn, "click"); // custom_1
  fire(addBtn, "click"); // custom_2 -- now at MAX_DETAILER_PASSES (face, eye, custom_1, custom_2)
  let persisted = genState(node);
  assert.equal(Object.keys(persisted.detailer.blocks).length, MAX_DETAILER_PASSES);

  pop = popoverRoot(doc);
  const addBtnAgain = queryAll(pop, (n) => n.tagName === "button").find((b) => b.textContent === "+");
  assert.ok(addBtnAgain.disabled, "MAX_DETAILER_PASSES reached -- the + button must refuse further adds");
  fire(addBtnAgain, "click");
  persisted = genState(node);
  assert.equal(Object.keys(persisted.detailer.blocks).length, MAX_DETAILER_PASSES, "still capped -- a disabled button click must not have added a 5th");
});

// ===========================================================================
// D. inherit_sampler_settings contract -- hides EXACTLY cfg/sampler_name/
//    scheduler, both directions, for highres/upscale/a detailer block.
// ===========================================================================

function assertInheritContract(pop) {
  // ON (default): steps/denoise ARE editable fields; cfg/sampler_name/
  // scheduler are NOT present as fields at all.
  assert.ok(findFieldByLabel(pop, "steps"), "steps must always be visible");
  assert.ok(findFieldByLabel(pop, "denoise"), "denoise must always be visible");
  assert.ok(!findFieldByLabel(pop, "cfg"), "cfg must be hidden while inherit is ON");
  assert.ok(!findFieldByLabel(pop, "sampler_name"), "sampler_name must be hidden while inherit is ON");
  assert.ok(!findFieldByLabel(pop, "scheduler"), "scheduler must be hidden while inherit is ON");
}

function assertInheritOffContract(pop) {
  assert.ok(findFieldByLabel(pop, "steps"));
  assert.ok(findFieldByLabel(pop, "denoise"));
  assert.ok(findFieldByLabel(pop, "cfg"), "cfg must reappear once inherit is OFF");
  assert.ok(findFieldByLabel(pop, "sampler_name"), "sampler_name must reappear once inherit is OFF");
  assert.ok(findFieldByLabel(pop, "scheduler"), "scheduler must reappear once inherit is OFF");
}

function findInheritToggle(pop) {
  return queryAll(pop, (n) => hasClass(n, "wtn-an-field")).find((f) => (f.children[0] || {}).textContent === "inherit").children[1];
}

test("inherit contract — Highres: hides exactly cfg/sampler_name/scheduler, both directions", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const row = findStageRow(refs.body, "Highres");
  fire(gearOf(row), "click");
  let pop = popoverRoot(doc);
  assertInheritContract(pop);

  fire(findInheritToggle(pop), "click"); // toggle inherit off, in place
  pop = popoverRoot(doc); // same overlay, content rebuilt in place
  assertInheritOffContract(pop);
  assert.equal(genState(node).highres.inherit_sampler_settings, false);

  fire(findInheritToggle(pop), "click"); // back on
  pop = popoverRoot(doc);
  assertInheritContract(pop);
  assert.equal(genState(node).highres.inherit_sampler_settings, true);
});

test("inherit contract — Upscale: hides exactly cfg/sampler_name/scheduler, both directions", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const row = findStageRow(refs.body, "Upscale");
  fire(gearOf(row), "click");
  let pop = popoverRoot(doc);
  assertInheritContract(pop);
  fire(findInheritToggle(pop), "click");
  pop = popoverRoot(doc);
  assertInheritOffContract(pop);
  assert.equal(genState(node).upscale.inherit_sampler_settings, false);
});

test("inherit contract — a Detailer block (face): hides exactly cfg/sampler_name/scheduler, both directions", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const row = findStageRow(refs.body, "Detailer");
  fire(gearOf(row), "click");
  let pop = popoverRoot(doc);
  assertInheritContract(pop);
  fire(findInheritToggle(pop), "click");
  pop = popoverRoot(doc);
  assertInheritOffContract(pop);
  assert.equal(genState(node).detailer.blocks.face.inherit_sampler_settings, false);
});

// ===========================================================================
// E. Sampler wired-wins + unet/clip/vae picker self-heal
// ===========================================================================

test("sampler popover: a wired field renders as driven-by-wire, never an editable input that's silently ignored", () => {
  const node = makeGeneratorNode({}, { seed: true });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const seedRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))
    .find((r) => (r.children.find((c) => hasClass(c, "wtn-an-nm")) || {}).textContent.includes("/") === false
      && (r.children.find((c) => hasClass(c, "wtn-an-nm")) || {}).textContent === "seed");
  fire(seedRow, "click");
  const pop = popoverRoot(doc);
  const seedField = findFieldByLabel(pop, "seed");
  assert.ok(hasClass(seedField.children[1], "wtn-an-driven"), "a wired field must render driven-by-wire");
  assert.ok(findFieldByLabel(pop, "cfg"), "an unwired field stays a normal editable input");
});

test("sampler popover: clicking a driven field disconnects the real link and the field becomes editable in place", () => {
  const node = makeGeneratorNode({}, { seed: true });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const seedRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-nm") && n.textContent === "seed")[0].parentNode;
  fire(seedRow, "click");
  let pop = popoverRoot(doc);
  const seedField = findFieldByLabel(pop, "seed");
  fire(seedField.children[1], "click");
  assert.equal(node.inputs.find((i) => i.name === "seed").link, null, "disconnectInput must have run");
  pop = popoverRoot(doc);
  const seedFieldAfter = findFieldByLabel(pop, "seed");
  assert.ok(!hasClass(seedFieldAfter.children[1], "wtn-an-driven"), "must become editable in place, no close/reopen needed");
});

test("internal-loader picker rows never fall back to options[0] for an orphaned saved value", () => {
  const node = makeGeneratorNode({ use_internal_loaders: true, unet_name: "a-deleted-model.safetensors" });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountGeneratorUI(node, ctx);
  const widget = node.widgets.find((w) => w.name === "unet_name");
  // Options are ["anima-base-v1.0.safetensors", "some-other-model.safetensors"]
  // (this file's makeGeneratorNode) -- options[0] would be WRONG here; the
  // heuristic/candidate match must self-heal to the real Anima model.
  assert.equal(widget.value, "anima-base-v1.0.safetensors");
});

// ===========================================================================
// F. Preview node — wipe divider maths, compare/save rows, stage status
// ===========================================================================

test("wipeXFromEvent: maps cursor position across the wipe box to a 0..100 percent, clamped", () => {
  const rect = { left: 0, width: 200 };
  assert.equal(wipeXFromEvent(rect, 0), 0);
  assert.equal(wipeXFromEvent(rect, 200), 100);
  assert.equal(wipeXFromEvent(rect, 100), 50);
  assert.equal(wipeXFromEvent(rect, -50), 0); // clamped
  assert.equal(wipeXFromEvent(rect, 999), 100); // clamped
  assert.equal(wipeXFromEvent(null, 50), 50); // no rect -- safe default, never throws
});

test("Preview: hovering the wipe sets --wipe-x on the wipe element, stopPropagation is called (litegraph-steal guard)", () => {
  const node = makePreviewNode({}, { image_a: true, image_c: true });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  refs.wipeEl._rect = { left: 0, width: 200 };
  let stopped = false;
  fire(refs.wipeEl, "pointermove", { clientX: 150, stopPropagation: () => { stopped = true; } });
  assert.equal(refs.wipeEl.style["--wipe-x"], "75.00%");
  assert.ok(stopped, "stopPropagation must be called or litegraph steals the gesture");
});

test("Preview: compare a/b segmented buttons write the preview_state WIDGET", () => {
  const node = makePreviewNode({}, { image_a: true, image_b: true, image_c: true });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const segButtons = queryAll(refs.body, (n) => hasClass(n, "wtn-an-seg")).flatMap((seg) => seg.children);
  const midBtn = segButtons.find((b) => b.textContent === "mid");
  fire(midBtn, "click");
  assert.equal(previewState(node).compare.a, "mid");
});

test("Preview: save popover fields write the preview_state WIDGET", () => {
  const node = makePreviewNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  const saveRow = queryAll(refs.body, (n) => hasClass(n, "wtn-an-row"))
    .find((r) => (r.children.find((c) => hasClass(c, "wtn-an-nm")) || {}).textContent === "save");
  fire(saveRow, "click");
  const pop = popoverRoot(doc);
  const whichField = findFieldByLabel(pop, "which");
  whichField.children[1].value = "every wired input";
  fire(whichField.children[1], "change");
  assert.equal(previewState(node).save.which, "every wired input");
  assert.ok(SAVE_WHICH_OPTIONS.includes(previewState(node).save.which));
});

// ===========================================================================
// F2. onExecuted -- stage-keyed mapping (never array position), the
//     degrade-to-single-pane contract, and the cache-busting URL builder.
// ===========================================================================

function imgsInWipe(refs) {
  return queryAll(refs.wipeEl, (n) => n.tagName === "img");
}
function layerImgSrc(refs, extraClass) {
  const layer = queryAll(refs.wipeEl, (n) => hasClass(n, "wtn-an-layer") && hasClass(n, extraClass))[0];
  const img = layer && layer.children.find((c) => c.tagName === "img");
  return img ? img.src : undefined;
}

test("buildPreviewImageUrl: builds ComfyUI's /view URL and includes a cache-busting param", () => {
  const url = buildPreviewImageUrl({ filename: "foo.png", subfolder: "AnimaFlow", type: "output" }, 12345);
  assert.ok(url.startsWith("/view?"));
  assert.ok(url.includes("filename=foo.png"));
  assert.ok(url.includes("subfolder=AnimaFlow"));
  assert.ok(url.includes("type=output"));
  assert.ok(url.includes("t=12345"), "must carry a cache-busting param, or a second run's identical filename shows the stale image");

  // A second call with a DIFFERENT cacheBust for the SAME filename must
  // produce a DIFFERENT url -- that's the whole point.
  const urlAgain = buildPreviewImageUrl({ filename: "foo.png", subfolder: "AnimaFlow", type: "output" }, 99999);
  assert.notEqual(url, urlAgain);

  assert.equal(buildPreviewImageUrl(null, 1), null, "a missing entry must never build a broken src");
  assert.equal(buildPreviewImageUrl({ subfolder: "x" }, 1), null, "an entry with no filename must never build a broken src");
});

test("handleExecuted: maps ui.images entries onto panes BY STAGE, never by array position", () => {
  const node = makePreviewNode({}, { image_a: true, image_b: true, image_c: true });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);

  // Scrambled order on purpose -- final first, base last -- to prove the
  // mapping reads `entry.stage`, not `images[0]`/`images[1]`/`images[2]`.
  handleExecuted(node, ctx, {
    images: [
      { filename: "final.png", subfolder: "AnimaFlow", type: "output", stage: "final" },
      { filename: "mid_temp.png", subfolder: "", type: "temp", stage: "mid" },
      { filename: "base_temp.png", subfolder: "", type: "temp", stage: "base" },
    ],
  });

  // default compare is base vs final -- dual pane, each layer showing the
  // stage ITS class names, not array position.
  assert.ok(layerImgSrc(node._anRefs, "wtn-an-a").includes("filename=base_temp.png"));
  assert.ok(layerImgSrc(node._anRefs, "wtn-an-b").includes("filename=final.png"));
});

test("handleExecuted: a batch's SECOND entry for the same stage is ignored -- one image per pane", () => {
  const node = makePreviewNode({}, { image_a: true });
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  mountPreviewUI(node, ctx);
  handleExecuted(node, ctx, {
    images: [
      { filename: "first.png", subfolder: "", type: "temp", stage: "base" },
      { filename: "second.png", subfolder: "", type: "temp", stage: "base" },
    ],
  });
  assert.equal(node._anPreviewImages.base.filename, "first.png");
});

test("Preview: a selected compare stage that isn't wired degrades to a single-image view, not a broken pane", () => {
  // compare.a = "mid" is picked but ONLY image_c (final) is wired -- must
  // NOT render a dual pane with a permanently-blank "mid" side.
  const node = makePreviewNode(
    { preview_state: JSON.stringify({ compare: { enabled: true, a: "mid", b: "final" } }) },
    { image_c: true },
  );
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountPreviewUI(node, ctx);
  handleExecuted(node, ctx, {
    images: [{ filename: "final.png", subfolder: "AnimaFlow", type: "output", stage: "final" }],
  });

  assert.ok(hasClass(node._anRefs.wipeEl, "wtn-an-single"), "must degrade to the single-pane class, not stay dual");
  assert.equal(imgsInWipe(node._anRefs).length, 1, "exactly one image, not a blank second pane");
  assert.ok(imgsInWipe(node._anRefs)[0].src.includes("filename=final.png"));
});

// ===========================================================================
// G. Traps this pack has already been bitten by
// ===========================================================================

test("popover toggle: a second click of the SAME opener closes it (not close-then-reopen)", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const row = findStageRow(refs.body, "Highres");
  const gear = gearOf(row);

  fire(gear, "click");
  assert.equal(doc.body.children.filter((c) => hasClass(c, "wtn-overlay")).length, 1);
  fire(gear, "click"); // second click of the SAME opener
  assert.equal(doc.body.children.filter((c) => hasClass(c, "wtn-overlay")).length, 0, "must actually CLOSE, not close-then-reopen");
});

test("popover switching: opening a DIFFERENT row's gear closes the previous popover, exactly one open at a time", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  fire(gearOf(findStageRow(refs.body, "Highres")), "click");
  assert.equal(doc.body.children.filter((c) => hasClass(c, "wtn-overlay")).length, 1);
  fire(gearOf(findStageRow(node._anRefs.body, "Upscale")), "click");
  assert.equal(doc.body.children.filter((c) => hasClass(c, "wtn-overlay")).length, 1, "exactly one overlay, ever");
});

test("overlay root sets position/left/top/z-index INLINE, so a missing stylesheet can never strand it off-view", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  makeWindowStub(doc);
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  fire(gearOf(findStageRow(refs.body, "Highres")), "click");
  const overlay = doc.body.children.filter((c) => hasClass(c, "wtn-overlay")).slice(-1)[0];
  assert.equal(overlay.style.position, "fixed");
  assert.ok(overlay.style.zIndex);
  assert.ok(typeof overlay.style.left === "string");
  assert.ok(typeof overlay.style.top === "string");
});

test("wheel-zoom passthrough installs on mount and tears down on node removal", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  let uninstallCalled = false;
  refs.root.addEventListener = (function (orig) {
    return function (type, fn, opts) {
      return orig.call(this, type, fn, opts);
    };
  })(refs.root.addEventListener);
  installZoomPassthrough(node, ctx);
  assert.ok(refs.root._listeners.wheel && refs.root._listeners.wheel.length >= 1, "a wheel listener must be installed");
  const originalRemove = refs.root.removeEventListener;
  refs.root.removeEventListener = function (type, fn) {
    if (type === "wheel") {
      uninstallCalled = true;
    }
    return originalRemove.call(this, type, fn);
  };
  teardownNode(node);
  assert.ok(uninstallCalled, "teardownNode must remove the wheel listener, not just close overlays");
});

test("repaintGenerator swaps the body without leaving an orphaned previous generation mounted", () => {
  const node = makeGeneratorNode();
  const doc = makeDocStub();
  const ctx = makeCtx(doc);
  const refs = mountGeneratorUI(node, ctx);
  const firstBody = refs.body;
  repaintGenerator(node, ctx);
  repaintGenerator(node, ctx);
  assert.equal(refs.root.children.length, 1, "exactly one body must be mounted at a time");
  assert.equal(firstBody.parentNode, null, "the torn-down previous body must be detached, not left floating");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
