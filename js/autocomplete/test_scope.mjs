/**
 * test_scope.mjs — regression tests for the tag-autocomplete PACK-SCOPING
 * fix: this extension's `nodeCreated` hook used to fire (and attach) for
 * EVERY node on the graph, from every installed custom-node pack and every
 * core ComfyUI node, as long as one of its widgets rendered a `<textarea>`.
 * It must now attach ONLY to AnimaFlow's own nodes -- ownership derived from
 * each node's Python `CATEGORY = "AnimaFlow/<topic>"`, never a hardcoded
 * node-name list.
 *
 * `core.mjs`'s `isOwnedCategory`/`resolveOwnership` are the PURE decision
 * functions (no DOM, importable directly, like the rest of that module) --
 * exercised here directly with plain objects.
 *
 * `index.js` itself statically imports `app` from the absolute ComfyUI host
 * path `/scripts/app.js` (and transitively, via `render.mjs`, the absolute
 * `/extensions/.../theme.mjs` route), which only resolve inside a real
 * ComfyUI/browser host -- exactly the constraint `test_tag_insert.mjs`
 * already documents for `interaction.mjs`. So, matching that file's (and
 * every sibling `test_resize.mjs`'s) established technique:
 *
 *   1. The pure ownership predicates are imported from `core.mjs` and
 *      exercised for real (not re-derived) with representative
 *      class-name/category combinations (our own nodes, another pack's
 *      node, a core ComfyUI node).
 *   2. A local harness (`localNodeCreated`/`localScanNode`/
 *      `localMaybeAttachWidget`, defined below) mirrors `index.js`'s own
 *      private `nodeCreated`/`scanNode`/`maybeAttachWidget` control flow
 *      EXACTLY (same guard-first-then-scan shape, same
 *      `_wtnAutocompleteAttached` idempotency marker, same two attach
 *      criteria), built out of the REAL exported `isEligibleWidget`/
 *      `isOwnedCategory`/`resolveOwnership` functions -- so the only thing
 *      not literally the shipped code is the DOM-touching parts of
 *      `attachAutocomplete` itself, replaced with a plain spy. This lets
 *      the "does a foreign node's textarea get the marker" question be
 *      answered by actually running the algorithm against fake node/widget
 *      graphs, headlessly.
 *   3. Source-text assertions on `index.js` (used elsewhere in this repo
 *      for exactly this reason) then prove the local harness's shape
 *      matches the real file: the same guard, the same Set, the same
 *      idempotency checks, the same import of the pure functions from
 *      `core.mjs` rather than a reimplementation or a hardcoded name list.
 *
 * Run directly: `node js/autocomplete/test_scope.mjs` (plain script, no test
 * framework -- matches the project's `python tests/test_x.py` convention and
 * this pack's own `js/**\/test_resize.mjs` files).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isEligibleWidget, isOwnedCategory, resolveOwnership, OWNED_CATEGORY_PREFIX } from "./core.mjs";

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

// =========================================================================
// core.mjs — isOwnedCategory (pure)
// =========================================================================

test("isOwnedCategory is true for every AnimaFlow topic prefix", () => {
  assert.equal(OWNED_CATEGORY_PREFIX, "AnimaFlow/");
  assert.equal(isOwnedCategory("AnimaFlow/gallery"), true);
  assert.equal(isOwnedCategory("AnimaFlow/anima_prompt"), true);
  // Prefix match, not a lookup against a fixed topic list -- any future
  // `AnimaFlow/<topic>` group is owned too.
  assert.equal(isOwnedCategory("AnimaFlow/some_future_topic"), true);
});

test("isOwnedCategory is false for another pack's category", () => {
  assert.equal(isOwnedCategory("Pixaroma/Text"), false);
});

test("isOwnedCategory is false for a core ComfyUI category", () => {
  assert.equal(isOwnedCategory("conditioning"), false);
});

test("isOwnedCategory never throws on null/undefined/non-string input", () => {
  assert.equal(isOwnedCategory(null), false);
  assert.equal(isOwnedCategory(undefined), false);
  assert.equal(isOwnedCategory(42), false);
  assert.equal(isOwnedCategory(""), false);
});

test("isOwnedCategory does not match a foreign category that merely CONTAINS the prefix mid-string", () => {
  assert.equal(isOwnedCategory("Something/AnimaFlow/fake"), false);
});

// =========================================================================
// core.mjs — resolveOwnership (pure)
// =========================================================================

test("resolveOwnership is true via the PRIMARY signal: className present in ownedNames", () => {
  const owned = new Set(["PromptRulesText", "GalleryPicker"]);
  assert.equal(resolveOwnership({ className: "PromptRulesText", category: "who knows" }, owned), true);
});

test("resolveOwnership is true via the FALLBACK signal when className isn't in the set but the category is ours", () => {
  const owned = new Set(); // simulates nodeData.category having been unreadable at registration
  assert.equal(resolveOwnership({ className: "SomeNewNode", category: "AnimaFlow/gallery" }, owned), true);
});

test("resolveOwnership is false for a foreign node: name not in the set AND category not ours", () => {
  const owned = new Set(["PromptRulesText"]);
  assert.equal(resolveOwnership({ className: "PixaromaNote", category: "Pixaroma/Text" }, owned), false);
});

test("resolveOwnership is false for a core ComfyUI node", () => {
  const owned = new Set(["PromptRulesText"]);
  assert.equal(resolveOwnership({ className: "CLIPTextEncode", category: "conditioning" }, owned), false);
});

test("resolveOwnership never throws when ownedNames/className/category are missing", () => {
  assert.equal(resolveOwnership({}, new Set()), false);
  assert.equal(resolveOwnership({ className: "X" }, undefined), false);
  assert.equal(resolveOwnership(null, new Set(["X"])), false);
});

// =========================================================================
// Local harness mirroring index.js's nodeCreated/scanNode/maybeAttachWidget
// control flow (see the module doc comment above for why this, rather than
// importing index.js directly, is this repo's established technique) --
// exercised against fake node/widget graphs, then checked against the real
// file's source text below.
// =========================================================================

function localIsOwnNode(node, ownedNames) {
  if (!node) {
    return false;
  }
  const className = node.comfyClass || node.type || (node.constructor && node.constructor.comfyClass);
  const category = node.constructor && node.constructor.category;
  return resolveOwnership({ className, category }, ownedNames);
}

function localMaybeAttachWidget(widget, attachSpy) {
  if (!widget) {
    return;
  }
  const el = widget.inputEl;
  if (el && !el._wtnAutocompleteAttached && isEligibleWidget(widget)) {
    el._wtnAutocompleteAttached = true;
    attachSpy(el);
    return;
  }
  const root = widget.element;
  if (root && typeof root.querySelectorAll === "function") {
    root.querySelectorAll("textarea").forEach((textarea) => {
      if (textarea._wtnAutocompleteAttached) {
        return;
      }
      textarea._wtnAutocompleteAttached = true;
      attachSpy(textarea);
    });
  }
}

function localScanNode(node, attachSpy) {
  for (const widget of node.widgets || []) {
    localMaybeAttachWidget(widget, attachSpy);
  }
}

/** Returns whether the node was scanned at all (i.e. did NOT bail). */
function localNodeCreated(node, ownedNames, attachSpy) {
  if (!localIsOwnNode(node, ownedNames)) {
    return false;
  }
  localScanNode(node, attachSpy);
  return true;
}

function makeTextarea() {
  return { tagName: "TEXTAREA" };
}

/** A fake DOM-widget root exposing just enough of `querySelectorAll` to
 * drive the "scan a custom node's own rendered markup" attach criterion.
 */
function makeDomWidgetRoot(textareas) {
  return {
    querySelectorAll(selector) {
      return selector === "textarea" ? textareas : [];
    },
  };
}

// ---- beforeRegisterNodeDef simulation: populating ownedNames -----------

test("simulated beforeRegisterNodeDef populates ownedNames from AnimaFlow-categoried nodeData only", () => {
  const ownedNames = new Set();
  const registry = [
    { name: "PromptRulesText", category: "AnimaFlow/anima_prompt" },
    { name: "GalleryPicker", category: "AnimaFlow/gallery" },
    { name: "PixaromaNote", category: "Pixaroma/Text" },
    { name: "CLIPTextEncode", category: "conditioning" },
  ];
  for (const nodeData of registry) {
    // Mirrors index.js's beforeRegisterNodeDef body exactly (asserted below).
    if (nodeData && isOwnedCategory(nodeData.category)) {
      ownedNames.add(nodeData.name);
    }
  }
  assert.deepEqual(
    Array.from(ownedNames).sort(),
    ["GalleryPicker", "PromptRulesText"],
  );
});

// ---- Our own node: DOES get attached (DOM-widget-root textarea scan) ----

test("a node whose category is AnimaFlow/anima_prompt IS attached to (DOM-widget-root textarea)", () => {
  const ownedNames = new Set(["PromptRulesText"]);
  const textarea = makeTextarea();
  const node = {
    comfyClass: "PromptRulesText",
    constructor: { category: "AnimaFlow/anima_prompt" },
    widgets: [{ name: "template_dom", element: makeDomWidgetRoot([textarea]) }],
  };
  const attached = [];

  const scanned = localNodeCreated(node, ownedNames, (el) => attached.push(el));

  assert.equal(scanned, true, "our own node must not be bailed out on");
  assert.equal(textarea._wtnAutocompleteAttached, true, "the textarea under its DOM root must get the marker");
  assert.equal(attached.length, 1);
});

// ---- Our own node: DOES get attached (native <textarea> widget) --------

test("a node whose category is AnimaFlow/gallery IS attached to (native textarea widget)", () => {
  const ownedNames = new Set(["GalleryPicker"]);
  const inputEl = makeTextarea();
  const node = {
    comfyClass: "GalleryPicker",
    constructor: { category: "AnimaFlow/gallery" },
    widgets: [{ name: "positive", inputEl }],
  };
  const attached = [];

  const scanned = localNodeCreated(node, ownedNames, (el) => attached.push(el));

  assert.equal(scanned, true);
  assert.equal(inputEl._wtnAutocompleteAttached, true);
  assert.equal(attached.length, 1);
});

// ---- Another pack's node: does NOT get attached -------------------------

test("a node from another pack (PixaromaNote, category Pixaroma/Text) is NOT attached to", () => {
  const ownedNames = new Set(["PromptRulesText"]); // PixaromaNote never registers into this
  const textarea = makeTextarea();
  const node = {
    comfyClass: "PixaromaNote",
    constructor: { category: "Pixaroma/Text" },
    widgets: [{ name: "markdown", element: makeDomWidgetRoot([textarea]) }],
  };
  const attached = [];

  const scanned = localNodeCreated(node, ownedNames, (el) => attached.push(el));

  assert.equal(scanned, false, "a foreign-pack node must be bailed out on before any scan");
  assert.equal(textarea._wtnAutocompleteAttached, undefined, "its textarea must NOT get the marker");
  assert.equal(attached.length, 0, "attachAutocomplete must never be called for a foreign node");
});

// ---- A core ComfyUI node: does NOT get attached -------------------------

test("a core ComfyUI node (CLIPTextEncode, category conditioning) is NOT attached to", () => {
  const ownedNames = new Set(["PromptRulesText"]);
  const inputEl = makeTextarea();
  const node = {
    comfyClass: "CLIPTextEncode",
    type: "CLIPTextEncode",
    constructor: { category: "conditioning" },
    widgets: [{ name: "text", inputEl }],
  };
  const attached = [];

  const scanned = localNodeCreated(node, ownedNames, (el) => attached.push(el));

  assert.equal(scanned, false, "core nodes are a deliberate, known trade-off -- no autocomplete on CLIPTextEncode");
  assert.equal(inputEl._wtnAutocompleteAttached, undefined);
  assert.equal(attached.length, 0);
});

// ---- Idempotency: a rescan of one of OUR nodes never double-attaches ----

test("idempotency holds for our own nodes: rescanning (the 50ms rescan) does not double-attach", () => {
  const ownedNames = new Set(["PromptRulesText"]);
  const textarea = makeTextarea();
  const node = {
    comfyClass: "PromptRulesText",
    constructor: { category: "AnimaFlow/anima_prompt" },
    widgets: [{ name: "template_dom", element: makeDomWidgetRoot([textarea]) }],
  };
  const attached = [];
  const attachSpy = (el) => attached.push(el);

  localNodeCreated(node, ownedNames, attachSpy); // the initial scan in nodeCreated
  localScanNode(node, attachSpy); // the setTimeout(..., 50) rescan

  assert.equal(attached.length, 1, "the rescan must not attach a second time");
});

// =========================================================================
// index.js — source-text assertions proving the real file matches the
// shape exercised above (same technique test_tag_insert.mjs uses for
// interaction.mjs, for the same reason: index.js can't be imported headless
// because of its absolute /scripts/app.js import).
// =========================================================================

const indexSource = readFileSync(path.join(__dirname, "index.js"), "utf8");

test("index.js imports isOwnedCategory and resolveOwnership from core.mjs (no hardcoded name-list reimplementation)", () => {
  assert.match(indexSource, /import\s*\{[^}]*\bisOwnedCategory\b[^}]*\}\s*from\s*"\.\/core\.mjs"/);
  assert.match(indexSource, /import\s*\{[^}]*\bresolveOwnership\b[^}]*\}\s*from\s*"\.\/core\.mjs"/);
});

test("index.js's beforeRegisterNodeDef populates ownedNodeNames from nodeData.category, gated by isOwnedCategory", () => {
  const idx = indexSource.indexOf("async beforeRegisterNodeDef");
  assert.ok(idx >= 0, "expected a beforeRegisterNodeDef hook");
  const body = indexSource.slice(idx, indexSource.indexOf("},", idx));
  assert.match(body, /isOwnedCategory\(nodeData\.category\)/);
  assert.match(body, /ownedNodeNames\.add\(nodeData\.name\)/);
});

test("index.js's nodeCreated bails via isOwnNode(node) BEFORE scanning or injecting styles", () => {
  const idx = indexSource.indexOf("async nodeCreated");
  assert.ok(idx >= 0, "expected a nodeCreated hook");
  const body = indexSource.slice(idx, indexSource.indexOf("\n});", idx));
  const guardIdx = body.search(/if\s*\(\s*!isOwnNode\(node\)\s*\)\s*\{\s*return;/);
  assert.ok(guardIdx >= 0, "expected an early `if (!isOwnNode(node)) { return; }` guard");
  const scanIdx = body.indexOf("scanNode(node)");
  const stylesIdx = body.indexOf("injectStyles()");
  assert.ok(scanIdx > guardIdx, "scanNode must run strictly after the ownership guard");
  assert.ok(stylesIdx > guardIdx, "injectStyles must run strictly after the ownership guard");
});

test("index.js's isOwnNode delegates to resolveOwnership with a className/category identity, not a hardcoded list", () => {
  const idx = indexSource.indexOf("function isOwnNode");
  assert.ok(idx >= 0);
  const body = indexSource.slice(idx, indexSource.indexOf("\n}", idx));
  assert.match(body, /node\.comfyClass/);
  assert.match(body, /node\.constructor\?\.category/);
  assert.match(body, /resolveOwnership\(\s*\{\s*className,\s*category\s*\}\s*,\s*ownedNodeNames\s*\)/);
});

test("index.js's maybeAttachWidget still guards BOTH attach criteria with the _wtnAutocompleteAttached marker (unchanged idempotency)", () => {
  const idx = indexSource.indexOf("function maybeAttachWidget");
  assert.ok(idx >= 0);
  const body = indexSource.slice(idx, indexSource.indexOf("\nfunction scanNode", idx));
  assert.match(body, /el\._wtnAutocompleteAttached/);
  assert.match(body, /textarea\._wtnAutocompleteAttached/);
  assert.match(body, /root\.querySelectorAll\("textarea"\)/);
});

test("index.js's top doc comment states the pack-scoped contract, not the old graph-wide claim", () => {
  assert.doesNotMatch(
    indexSource,
    /this is NOT owned by one node type; it's a pack-wide extension, the one intentional exception/,
    "the old 'pack-wide, graph-wide' framing must be gone",
  );
  assert.match(indexSource, /CATEGORY = "AnimaFlow\/\.\.\."/, "must explain the AnimaFlow/ ownership gate");
  assert.match(
    indexSource,
    /pythongosssss/i,
    "must explain the reason (fighting another pack's own autocomplete) per the plan",
  );
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
}
