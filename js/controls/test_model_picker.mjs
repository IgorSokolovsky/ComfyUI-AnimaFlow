/**
 * test_model_picker.mjs — regression tests for `model_picker.mjs`'s pure
 * grouping/filtering/formatting helpers, a DOM-level integration test of
 * `openModelPicker` itself (via a minimal stub DOM, mirroring
 * `js/controls/test_lora_resize.mjs`'s own `makeDocStub` independently --
 * see that file's top doc comment on why tracks keep their own copy), PLUS
 * the layering guard that keeps `docs/lora-loader-design.md`'s reuse
 * boundary real: `model_picker.mjs`, `civitai_api.mjs`, and (Slice 4)
 * `model_info.mjs` are what `AnimaLoaderPanel` will import unchanged at M3,
 * and none of them may EVER import a `lora_*` module. Precedent:
 * `js/shared/test_field_logic.mjs`'s own layering guard for `js/shared/` vs
 * a track. Plain `node js/controls/test_model_picker.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatFileSize,
  displayModelName,
  filterModelsFlat,
  groupModels,
  metaLineFor,
  categoryOf,
  pickedCategory,
  openModelPicker,
} from "./model_picker.mjs";
import { invalidateList, invalidateInfo, lookupInfo } from "./civitai_api.mjs";

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

// =========================================================================
// formatFileSize
// =========================================================================

test("formatFileSize: bytes, KB, MB, GB thresholds", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(500), "500 B");
  assert.equal(formatFileSize(1024), "1 KB");
  assert.equal(formatFileSize(2048), "2 KB");
  assert.equal(formatFileSize(1536 * 1024), "1.5 MB");
  assert.equal(formatFileSize(150 * 1024 * 1024), "150 MB");
  assert.equal(formatFileSize(2.2 * 1024 * 1024 * 1024), "2.2 GB");
});

test("formatFileSize: garbage/negative/non-finite degrades to an empty string, never throws", () => {
  assert.equal(formatFileSize(-5), "");
  assert.equal(formatFileSize(NaN), "");
  assert.equal(formatFileSize(undefined), "");
  assert.equal(formatFileSize("not a number"), "");
  // `Number(null) === 0` -- a legitimate zero-byte size, not garbage, so this
  // formats normally rather than degrading (unlike `undefined`/a genuine
  // non-numeric string, both of which `Number(...)` turns into `NaN`).
  assert.equal(formatFileSize(null), "0 B");
});

// =========================================================================
// displayModelName
// =========================================================================

test("displayModelName: identity when hideExtension is falsy", () => {
  assert.equal(displayModelName("a.safetensors", false), "a.safetensors");
  assert.equal(displayModelName("detail/a.safetensors"), "detail/a.safetensors");
});

test("displayModelName: strips the extension when hideExtension is true", () => {
  assert.equal(displayModelName("a.safetensors", true), "a");
  assert.equal(displayModelName("detail/a.safetensors", true), "detail/a");
});

test("displayModelName: never strips a dot belonging to a directory segment", () => {
  assert.equal(displayModelName("v1.2/a.safetensors", true), "v1.2/a");
  assert.equal(displayModelName("v1.2/noext", true), "v1.2/noext"); // no dot IN the last segment at all
});

test("displayModelName: a dotfile-shaped name never degrades to an empty string", () => {
  assert.equal(displayModelName(".safetensors", true), ".safetensors");
});

test("displayModelName: non-string/empty name is always an empty string", () => {
  assert.equal(displayModelName(null, true), "");
  assert.equal(displayModelName(undefined, false), "");
  assert.equal(displayModelName("", true), "");
});

// =========================================================================
// filterModelsFlat
// =========================================================================

const SAMPLE = [
  { name: "top.safetensors", group: "All", size: 1024, base_model: "SDXL", has_preview: true },
  { name: "detail/skin.safetensors", group: "detail", size: 2048, base_model: "", has_preview: false },
  { name: "detail/eyes.safetensors", group: "detail", size: 4096, base_model: "Anima", has_preview: true },
  { name: "character/hero.safetensors", group: "character", size: 8192, base_model: "Pony", has_preview: true },
];

test("filterModelsFlat: empty/whitespace term returns every entry unfiltered, in order", () => {
  assert.deepEqual(filterModelsFlat(SAMPLE, ""), SAMPLE);
  assert.deepEqual(filterModelsFlat(SAMPLE, "   "), SAMPLE);
  assert.deepEqual(filterModelsFlat(SAMPLE, undefined), SAMPLE);
});

test("filterModelsFlat: case-insensitive substring match across every file, flat", () => {
  const hits = filterModelsFlat(SAMPLE, "DETAIL");
  assert.deepEqual(hits.map((m) => m.name), ["detail/skin.safetensors", "detail/eyes.safetensors"]);
});

test("filterModelsFlat: no matches yields an empty array, never throws", () => {
  assert.deepEqual(filterModelsFlat(SAMPLE, "nonexistent"), []);
  assert.deepEqual(filterModelsFlat(null, "x"), []);
  assert.deepEqual(filterModelsFlat(undefined, "x"), []);
});

test("filterModelsFlat: tolerates a malformed entry in the list (skips it, never throws)", () => {
  const messy = [...SAMPLE, null, 42, { size: 1 }];
  const hits = filterModelsFlat(messy, "top");
  assert.deepEqual(hits.map((m) => m.name), ["top.safetensors"]);
});

// =========================================================================
// groupModels -- root group is "All", subfolders keep their own header,
// "All" sorts first, everything else alphabetically after it.
// =========================================================================

test("groupModels: root-level files group under 'All', subfolders under their own header", () => {
  const groups = groupModels(SAMPLE);
  assert.deepEqual(
    groups.map((g) => g.group),
    ["All", "character", "detail"],
  );
  assert.deepEqual(groups[0].models.map((m) => m.name), ["top.safetensors"]);
  assert.deepEqual(groups[2].models.map((m) => m.name), ["detail/skin.safetensors", "detail/eyes.safetensors"]);
});

test("groupModels: a missing/empty group field also falls back to 'All'", () => {
  const groups = groupModels([{ name: "a.safetensors" }, { name: "b.safetensors", group: "" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].group, "All");
  assert.equal(groups[0].models.length, 2);
});

test("groupModels: empty input yields an empty group list, never throws", () => {
  assert.deepEqual(groupModels([]), []);
  assert.deepEqual(groupModels(null), []);
});

// =========================================================================
// metaLineFor -- size/base-model second line, or the literal "no preview"
// =========================================================================

test("metaLineFor: size + base model when a preview exists", () => {
  assert.equal(metaLineFor({ has_preview: true, size: 1024 * 1024 * 150, base_model: "SDXL" }), "150 MB · SDXL");
});

test("metaLineFor: base model falls back to the literal 'unknown', never a guess", () => {
  assert.equal(metaLineFor({ has_preview: true, size: 1024, base_model: "" }), "1 KB · unknown");
  assert.equal(metaLineFor({ has_preview: true, size: 1024 }), "1 KB · unknown");
});

test("metaLineFor: the literal 'no preview' when has_preview is false, replacing the whole line", () => {
  assert.equal(metaLineFor({ has_preview: false, size: 1024, base_model: "SDXL" }), "no preview");
});

test("metaLineFor: a missing model never throws", () => {
  assert.equal(metaLineFor(null), "");
  assert.equal(metaLineFor(undefined), "");
});

// =========================================================================
// categoryOf -- §1a-vi "never invent a category": null unless a real
// `category` field is present, which /wtn/model_browser/list never
// populates today (that needs a Civitai sidecar, Slice 4) -- so this is
// always null against real server data this slice, by design.
// =========================================================================

test("categoryOf: null when no category field is present at all", () => {
  assert.equal(categoryOf({ name: "a.safetensors" }), null);
  assert.equal(categoryOf(SAMPLE[0]), null); // real /list-shaped entries never carry one yet
});

test("categoryOf: the trimmed category string when genuinely present", () => {
  assert.equal(categoryOf({ category: "  character  " }), "character");
});

test("categoryOf: a blank/whitespace-only category is treated as absent, not shown", () => {
  assert.equal(categoryOf({ category: "   " }), null);
  assert.equal(categoryOf({ category: "" }), null);
});

// =========================================================================
// pickedCategory -- categoryOf first, then civitai_api.mjs's session-cached
// Civitai tag (Slice 4's "close the Slice 3 seam") -- never a guess, and
// never a fetch of its own.
// =========================================================================

test("pickedCategory: categoryOf wins when a real category field is already present", () => {
  assert.equal(pickedCategory("loras", { name: "a.safetensors", category: "concept" }), "concept");
});

test("pickedCategory: null for a file nobody has looked up this session -- no fetch, no guess", () => {
  const kind = "picker-cat-kind-a";
  invalidateInfo(kind, "never-looked-up.safetensors");
  assert.equal(pickedCategory(kind, { name: "never-looked-up.safetensors" }), null);
});

await asyncTest("pickedCategory: falls back to civitai_api.mjs's cached tag from a PRIOR ⓘ-panel lookup", async () => {
  const kind = "picker-cat-kind-b";
  const name = "looked-up.safetensors";
  invalidateInfo(kind, name);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "found",
      offline_reason: null,
      message: "",
      data: { tags: ["character", "style"] },
    }),
  });
  try {
    await lookupInfo(kind, name);
    assert.equal(pickedCategory(kind, { name }), "character");
  } finally {
    globalThis.fetch = origFetch;
    invalidateInfo(kind, name);
  }
});

test("categoryOf: a non-string category (never invented, never coerced) is absent", () => {
  assert.equal(categoryOf({ category: 42 }), null);
  assert.equal(categoryOf(null), null);
});

// =========================================================================
// openModelPicker -- DOM-level integration, via a minimal stub DOM.
// =========================================================================

function makeDocStub() {
  let doc;
  function makeElement(tag) {
    const e = {
      tagName: tag,
      _listeners: {},
      children: [],
      style: {},
      value: "",
      textContent: "",
      title: "",
      type: "",
      spellcheck: false,
      parentNode: null,
      _rect: { left: 10, top: 10, right: 30, bottom: 40, width: 20, height: 30 },
      get ownerDocument() {
        return doc;
      },
      set innerHTML(_v) {
        e.children = [];
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
        (e._listeners[t] = e._listeners[t] || []).push(fn);
      },
      removeEventListener(t, fn) {
        const arr = e._listeners[t];
        if (!arr) {
          return;
        }
        const i = arr.indexOf(fn);
        if (i >= 0) {
          arr.splice(i, 1);
        }
      },
      appendChild(child) {
        const idx = e.children.indexOf(child);
        if (idx >= 0) {
          e.children.splice(idx, 1);
        }
        e.children.push(child);
        child.parentNode = e;
        return child;
      },
      removeChild(child) {
        const idx = e.children.indexOf(child);
        if (idx >= 0) {
          e.children.splice(idx, 1);
        }
        child.parentNode = null;
        return child;
      },
      getBoundingClientRect() {
        return e._rect;
      },
      focus() {},
      contains(node) {
        let cur = node;
        while (cur) {
          if (cur === e) {
            return true;
          }
          cur = cur.parentNode;
        }
        return false;
      },
    };
    Object.defineProperty(e, "className", {
      get() {
        return [...e.classList._set].join(" ");
      },
      set(v) {
        e.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
      },
    });
    return e;
  }
  const win = {
    _listeners: {},
    innerWidth: 1200,
    innerHeight: 800,
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
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  doc = {
    createElement: makeElement,
    getElementById() {
      return null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
    defaultView: win,
  };
  return doc;
}

function findAll(root, className) {
  const out = [];
  const walk = (e) => {
    if (e.classList && e.classList.contains(className)) {
      out.push(e);
    }
    (e.children || []).forEach(walk);
  };
  walk(root);
  return out;
}

const _origFetchForPicker = globalThis.fetch;
await asyncTest("openModelPicker: renders grouped rows, accents the current selection, and focuses the search box", async () => {
  const kind = "picker-kind-a";
  invalidateList(kind);
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "ok",
      models: [
        { name: "top.safetensors", group: "All", size: 1024, base_model: "SDXL", has_preview: false },
        { name: "detail/eyes.safetensors", group: "detail", size: 2048, base_model: "Anima", has_preview: true },
      ],
    }),
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    // `search.focus()` is called synchronously by `openModelPicker` itself,
    // BEFORE `handle` is even returned -- track it via a spy installed on
    // the stub element PROTOTYPE-lessly, by wrapping `doc.createElement` for
    // just the search input's own construction: simplest is to just assert
    // that SOME element inside the panel exposes a spy-able `focus`, which
    // is trivially true of every stub element -- the real behavioural claim
    // ("takes focus on open," §1a-v) is checked below via a dedicated flag
    // on the FIRST `<input>` element `model_picker.mjs` builds.
    let focusedInput = null;
    const realCreateElement = doc.createElement;
    doc.createElement = (tag) => {
      const e = realCreateElement(tag);
      if (tag === "input") {
        const origFocus = e.focus;
        e.focus = () => {
          focusedInput = e;
          origFocus.call(e);
        };
      }
      return e;
    };

    const handle = openModelPicker({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      currentName: "detail/eyes.safetensors",
      onPick: () => {},
    });

    assert.ok(focusedInput, "the search box must take focus on open (§1a-v)");

    // Let the panel's own `listModels(kind)` promise (and its `.then`
    // repaint) actually resolve before inspecting the rendered rows.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const groupHeaders = findAll(handle.overlay, "wtn-mp-group-hd").map((e) => e.textContent);
    assert.deepEqual(groupHeaders, ["All", "detail"]);

    const rows = findAll(handle.overlay, "wtn-mp-row");
    assert.equal(rows.length, 2);
    const current = findAll(handle.overlay, "wtn-mp-current");
    assert.equal(current.length, 1);
    assert.equal(current[0].title, "detail/eyes.safetensors");
  } finally {
    globalThis.fetch = _origFetchForPicker;
    invalidateList(kind);
  }
});

await asyncTest("openModelPicker: typing collapses group headers to a flat, filtered list; picking closes and calls onPick", async () => {
  const kind = "picker-kind-b";
  invalidateList(kind);
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "ok",
      models: [
        { name: "top.safetensors", group: "All", size: 1024, base_model: "SDXL", has_preview: false },
        { name: "detail/eyes.safetensors", group: "detail", size: 2048, base_model: "Anima", has_preview: true },
      ],
    }),
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    let picked = null;
    const handle = openModelPicker({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      onPick: (name) => {
        picked = name;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const searchEl = findAll(handle.overlay, "wtn-mp-search")[0];
    searchEl.value = "eyes";
    searchEl._listeners.input.forEach((fn) => fn({ target: searchEl }));

    assert.equal(findAll(handle.overlay, "wtn-mp-group-hd").length, 0, "group headers collapse away while filtering");
    const rows = findAll(handle.overlay, "wtn-mp-row");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "detail/eyes.safetensors");

    rows[0]._listeners.click.forEach((fn) => fn({ stopPropagation() {} }));
    assert.equal(picked, "detail/eyes.safetensors");
    assert.equal(handle.overlay.parentNode, null, "picking closes the overlay");
  } finally {
    globalThis.fetch = _origFetchForPicker;
    invalidateList(kind);
  }
});

await asyncTest("openModelPicker: showThumbnails === false suppresses the thumbnail column entirely (§7b 'Show preview thumbnails')", async () => {
  const kind = "picker-kind-thumbs";
  invalidateList(kind);
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "ok",
      models: [{ name: "top.safetensors", group: "All", size: 1024, base_model: "SDXL", has_preview: true }],
    }),
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handleOn = openModelPicker({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      onPick: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(findAll(handleOn.overlay, "wtn-mp-thumb").length, 1, "default (showThumbnails omitted) renders the thumbnail, unchanged from Slice 3");
    handleOn.close();

    const doc2 = makeDocStub();
    const anchor2 = doc2.createElement("button");
    const handleOff = openModelPicker({
      ctx: { doc: doc2, getCanvasEl: () => null },
      anchorEl: anchor2,
      kind,
      showThumbnails: false,
      onPick: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(findAll(handleOff.overlay, "wtn-mp-thumb").length, 0, "showThumbnails: false must render NO thumbnail element at all");
    // The rest of the row is unaffected -- name/meta still render.
    const rows = findAll(handleOff.overlay, "wtn-mp-row");
    assert.equal(rows.length, 1);
    assert.equal(findAll(handleOff.overlay, "wtn-mp-name").length, 1);
  } finally {
    globalThis.fetch = _origFetchForPicker;
    invalidateList(kind);
  }
});

// ---------------------------------------------------------------------------
// Layering guard — docs/lora-loader-design.md's reuse boundary: none of
// model_picker.mjs / civitai_api.mjs / model_info.mjs may ever import a
// `lora_*` module (that's the whole point of the split -- AnimaLoaderPanel
// imports these THREE unchanged at M3, and a `lora_*` import here would mean
// M3 needs an extraction, not an import). Precedent:
// js/shared/test_field_logic.mjs's own layering guard.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const CONTROLS_DIR = path.dirname(__filename);

// `model_info.mjs` landed in Slice 4 -- scanned along with the other two
// unconditionally now; kept resilient to a missing file (a `continue` below)
// only so a future rename/move degrades to "not scanned" rather than a crash.
const GUARDED_FILES = ["model_picker.mjs", "civitai_api.mjs", "model_info.mjs"];

// Matches a relative import of `lora_state.mjs`/`lora_render.mjs`/
// `lora_interaction.mjs` (or any future `lora_*.mjs`) from THIS directory --
// the only direction the guard forbids (a `lora_*` module importing one of
// the three shared ones, e.g. lora_render.mjs's own `hasFile` import from
// civitai_api.mjs, is the ALLOWED direction and must not trip this).
//
// TWO patterns, because a STATIC `import ... from "./lora_x.mjs"` and a
// DYNAMIC `import("./lora_x.mjs")` are different syntax entirely -- a Slice 3
// review proved the static-only regex below catches the first and silently
// MISSES the second (no `from` keyword precedes a dynamic import's string at
// all, so it can never match `FORBIDDEN_STATIC_RE`). Both must be checked;
// neither subsumes the other.
const FORBIDDEN_STATIC_RE = /from\s+["']\.\/(lora_[^"']*)["']/g;
const FORBIDDEN_DYNAMIC_RE = /import\s*\(\s*["']\.\/(lora_[^"']*)["']/g;

test("model_picker.mjs / civitai_api.mjs / model_info.mjs never import a lora_* module (static OR dynamic import)", () => {
  const violations = [];
  let scanned = 0;
  for (const name of GUARDED_FILES) {
    const full = path.join(CONTROLS_DIR, name);
    let source;
    try {
      source = readFileSync(full, "utf8");
    } catch {
      continue; // a guarded file that doesn't exist (yet, or ever) is simply skipped
    }
    scanned += 1;
    for (const re of [FORBIDDEN_STATIC_RE, FORBIDDEN_DYNAMIC_RE]) {
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(source))) {
        violations.push(`${name} imports "./${match[1]}"`);
      }
    }
  }
  assert.ok(scanned >= 3, "sanity check: model_picker.mjs, civitai_api.mjs AND model_info.mjs were actually scanned");
  assert.deepEqual(
    violations,
    [],
    "model_picker.mjs/civitai_api.mjs/model_info.mjs must never import a lora_* module -- " +
      "these three are the reuse boundary AnimaLoaderPanel imports unchanged at M3 " +
      "(docs/lora-loader-design.md); a lora_* import here means M3 needs an extraction, " +
      "not an import. Violations found:\n  " +
      violations.join("\n  "),
  );
});

// Proves the DYNAMIC-import branch actually detects something (the
// false-green-verification skill's own rule: a guard that never catches
// anything on a real fixture hasn't been shown to work). A guard that only
// ever runs against today's clean files never exercises its own positive
// case.
test("regression: a dynamic import(\"./lora_x.mjs\") is flagged exactly like a static one", () => {
  const dynamicOnly = 'export async function bad() { return import("./lora_state.mjs"); }';
  const staticOnly = 'import { x } from "./lora_render.mjs";';
  const clean = 'import { listModels } from "./civitai_api.mjs";\nexport async function ok() { return import("./model_info.mjs"); }';

  function scan(source) {
    const violations = [];
    for (const re of [FORBIDDEN_STATIC_RE, FORBIDDEN_DYNAMIC_RE]) {
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(source))) {
        violations.push(match[1]);
      }
    }
    return violations;
  }

  assert.deepEqual(scan(dynamicOnly), ["lora_state.mjs"], "the dynamic-import regex must catch what the static one alone would miss");
  assert.deepEqual(scan(staticOnly), ["lora_render.mjs"]);
  assert.deepEqual(scan(clean), [], "an allowed import (of a lora_* module OR a static/dynamic import of a non-lora_* one) must never false-positive");
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
