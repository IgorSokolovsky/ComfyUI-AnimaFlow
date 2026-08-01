/**
 * test_civitai_modal.mjs — regression tests for `civitai_modal.mjs`, the
 * M2b toolbar modal (`docs/lora-loader-design.md` §7c/§7c-i/"The modal").
 * Covers the pure filter/kind/list helpers, a DOM-level integration test of
 * `openCivitaiModal` itself (via a minimal stub DOM, mirroring
 * `test_civitai_search.mjs`'s own `makeDocStub`), the `kind: null` safety
 * net, the rail's select-adds-a-chip mechanics, and the "still exactly 5
 * auto-loaded `.js`" ceiling. Plain `node js/controls/test_civitai_modal.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_TYPE_OPTIONS,
  NOT_INSTALLABLE_MESSAGE,
  resultKind,
  destinationLabelForKind,
  addFilterValue,
  removeFilterValue,
  parseStoredList,
  serializeList,
  injectModalStyles,
  openCivitaiModal,
  _resetModalForTests,
} from "./civitai_modal.mjs";
import { _resetDownloadStateForTests, sessionGatedKeys, injectStyles as injectSearchStyles } from "./civitai_search.mjs";
import { invalidateModelDetail } from "./civitai_api.mjs";
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

const _origFetch = globalThis.fetch;
function stubFetch(handler) {
  globalThis.fetch = handler;
}
function restoreFetch() {
  globalThis.fetch = _origFetch;
}
function jsonResponse(body) {
  return { json: async () => body };
}
async function settle(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// =========================================================================
// MODEL_TYPE_OPTIONS -- swappable in ONE place (owner direction, 2026-07-31).
// =========================================================================

test("MODEL_TYPE_OPTIONS: a non-empty array of plain strings", () => {
  assert.ok(Array.isArray(MODEL_TYPE_OPTIONS));
  assert.ok(MODEL_TYPE_OPTIONS.length > 0);
  for (const v of MODEL_TYPE_OPTIONS) {
    assert.equal(typeof v, "string");
    assert.ok(v.length > 0);
  }
  assert.equal(new Set(MODEL_TYPE_OPTIONS).size, MODEL_TYPE_OPTIONS.length, "no duplicate entries");
});

// =========================================================================
// resultKind -- the backend's derived "our folder, or null" per result.
// =========================================================================

test("resultKind: a non-empty string kind passes through", () => {
  assert.equal(resultKind({ kind: "loras" }), "loras");
  assert.equal(resultKind({ kind: "checkpoints" }), "checkpoints");
});

test("resultKind: null/absent/garbage all mean 'never guess a folder'", () => {
  assert.equal(resultKind({ kind: null }), null);
  assert.equal(resultKind({}), null);
  assert.equal(resultKind(null), null);
  assert.equal(resultKind(undefined), null);
  assert.equal(resultKind({ kind: 42 }), null);
  assert.equal(resultKind({ kind: "" }), null);
});

// =========================================================================
// destinationLabelForKind
// =========================================================================

test("destinationLabelForKind: shows the kind's own default root", () => {
  assert.equal(destinationLabelForKind("loras"), "→ models/loras/");
  assert.equal(destinationLabelForKind("checkpoints"), "→ models/checkpoints/");
  assert.equal(destinationLabelForKind("unet"), "→ models/unet/");
});

test("destinationLabelForKind: empty for a falsy kind (never rendered anyway)", () => {
  assert.equal(destinationLabelForKind(null), "");
  assert.equal(destinationLabelForKind(""), "");
});

test("destinationLabelForKind: an unmapped-but-truthy kind still produces a plausible label rather than throwing", () => {
  assert.equal(destinationLabelForKind("future_kind"), "→ models/future_kind/");
});

// =========================================================================
// addFilterValue / removeFilterValue -- the rail's "select adds a chip"
// mechanics (§7c-i): dedupe (a duplicate selection is a no-op), never
// mutate, never throw.
// =========================================================================

test("addFilterValue: appends a new value", () => {
  assert.deepEqual(addFilterValue([], "SDXL 1.0"), ["SDXL 1.0"]);
  assert.deepEqual(addFilterValue(["SDXL 1.0"], "Pony"), ["SDXL 1.0", "Pony"]);
});

test("addFilterValue: a duplicate selection is a no-op", () => {
  assert.deepEqual(addFilterValue(["SDXL 1.0"], "SDXL 1.0"), ["SDXL 1.0"]);
});

test("addFilterValue: a blank/placeholder value ('') never becomes a chip", () => {
  assert.deepEqual(addFilterValue(["SDXL 1.0"], ""), ["SDXL 1.0"]);
  assert.deepEqual(addFilterValue([], "   "), []);
});

test("addFilterValue: never mutates the input array", () => {
  const list = ["SDXL 1.0"];
  const out = addFilterValue(list, "Pony");
  assert.equal(list.length, 1);
  assert.equal(out.length, 2);
});

test("addFilterValue: garbage list degrades to treating it as empty, never throws", () => {
  assert.deepEqual(addFilterValue(null, "Pony"), ["Pony"]);
  assert.deepEqual(addFilterValue(undefined, "Pony"), ["Pony"]);
  assert.deepEqual(addFilterValue("not an array", "Pony"), ["Pony"]);
});

test("removeFilterValue: removes exactly the named value", () => {
  assert.deepEqual(removeFilterValue(["SDXL 1.0", "Pony"], "Pony"), ["SDXL 1.0"]);
});

test("removeFilterValue: never mutates the input array", () => {
  const list = ["SDXL 1.0", "Pony"];
  const out = removeFilterValue(list, "Pony");
  assert.equal(list.length, 2);
  assert.equal(out.length, 1);
});

test("removeFilterValue: a value not present, or a garbage list, degrades harmlessly", () => {
  assert.deepEqual(removeFilterValue(["SDXL 1.0"], "Nope"), ["SDXL 1.0"]);
  assert.deepEqual(removeFilterValue(null, "Nope"), []);
});

// =========================================================================
// parseStoredList / serializeList -- the JSON-array-string settings shape.
// =========================================================================

test("serializeList / parseStoredList round-trip", () => {
  const list = ["SDXL 1.0", "Pony"];
  const stored = serializeList(list);
  assert.equal(typeof stored, "string");
  assert.deepEqual(parseStoredList(stored), list);
});

test("parseStoredList: an empty/garbage/unparseable stored value degrades to [], never throws", () => {
  assert.deepEqual(parseStoredList(""), []);
  assert.deepEqual(parseStoredList(null), []);
  assert.deepEqual(parseStoredList(undefined), []);
  assert.deepEqual(parseStoredList("not json"), []);
  assert.deepEqual(parseStoredList("{}"), [], "valid JSON that isn't an array still degrades to []");
  assert.deepEqual(parseStoredList("[1, 2, null, \"ok\"]"), ["ok"], "non-string entries are filtered out");
});

test("parseStoredList: tolerates an already-parsed array (not just the stored string form)", () => {
  assert.deepEqual(parseStoredList(["A", "B"]), ["A", "B"]);
});

test("serializeList: filters non-string/empty entries, never throws on garbage", () => {
  assert.equal(serializeList(null), "[]");
  assert.equal(serializeList(["A", "", 42, null, "B"]), JSON.stringify(["A", "B"]));
});

// =========================================================================
// injectModalStyles -- degrades to a no-op with no real document.
// =========================================================================

test("injectModalStyles: a no-op (never throws) with no doc and no global document", () => {
  injectModalStyles(null);
});

// =========================================================================
// D1/D5 -- the rail's own section chrome (owner, 2026-07-31): D1 first
// reset the shared '.wtn-collapse' class SCOPED to the rail only (never an
// edit to that class itself -- every other consumer, e.g. the Rule Builder,
// keeps it unchanged); D5 then replaced the <details>/<summary> mechanism
// entirely with a plain heading -- see civitai_modal.mjs's own CSS doc
// comment for why this is a second, independent reversal, not a revert of
// D1's own conclusion.
// =========================================================================

test("D5: the rail no longer targets '.wtn-collapse' at all -- D1's own scoped reset has nothing left to reset", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "civitai_modal.mjs"), "utf8");
  assert.doesNotMatch(src, /\.wtn-cm-rail \.wtn-collapse/, "the rail must not reference '.wtn-collapse' in any form once it stops using <details>");
});

test("D4: the '.wtn-cm-badge' CSS rule itself is gone (not merely the element)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "civitai_modal.mjs"), "utf8");
  assert.doesNotMatch(src, /\.wtn-cm-badge/);
});

test("owner-reported (2026-08-01): 'i think we have horizontal issue in the model detail page, see its cut' -- .wtn-cm-main and .wtn-cm-detailhost both carry the shared wtn-flex-bound min-width fix (also why the Download button read as missing: it was clipped off the right edge, not absent)", () => {
  const doc = makeDocStub();
  injectModalStyles(doc);
  const modalCss = doc.head.children.find((c) => c.tagName === "style").textContent;
  // min-height: 0 already existed on both -- pinned here too so a later
  // edit can't quietly drop it while "fixing" the width half.
  assert.match(modalCss, /\.wtn-cm-main\s*\{[^}]*min-height:\s*0;?/);
  assert.match(modalCss, /\.wtn-cm-detailhost\s*\{[^}]*min-height:\s*0;?/);
});

await asyncTest("owner-reported (2026-08-01): .wtn-cm-main and .wtn-cm-detailhost both carry the wtn-flex-bound CLASS (js/shared/theme.css's shared min-width/min-height: 0 fix), not a hand-written min-width copy in this file", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    const main = findAll(handle.scrim, "wtn-cm-main")[0];
    const detailHost = findAll(handle.scrim, "wtn-cm-detailhost")[0];
    assert.ok(main.classList.contains("wtn-flex-bound"), ".wtn-cm-main must carry wtn-flex-bound");
    assert.ok(detailHost.classList.contains("wtn-flex-bound"), ".wtn-cm-detailhost must carry wtn-flex-bound");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

test("BUG (owner, 2026-08-01): in the detail view's fixed top bar, this action's own height matches the OTHER two controls (model_detail_view.mjs's own .wtn-dv-back/.wtn-dv-version-sel, 26px) -- one shared number across two files' CSS", () => {
  const doc = makeDocStub();
  injectModalStyles(doc);
  const modalCss = doc.head.children.find((c) => c.tagName === "style").textContent;
  const actionRule = modalCss.match(/\.wtn-dv-topbar \.wtn-cm-action\s*\{([^}]*)\}/)[1];
  const actionHeight = actionRule.match(/height:\s*(\d+)px/)[1];

  // model_detail_view.mjs's own stylesheet holds the OTHER two controls'
  // height (that file's own test asserts the two match each other) -- read
  // its raw source here just to compare the one number against THIS file's.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dvSrc = fs.readFileSync(path.join(here, "model_detail_view.mjs"), "utf8");
  const backHeight = dvSrc.match(/\.wtn-dv-topbar \.wtn-dv-back\s*\{[^}]*height:\s*(\d+)px/)[1];
  assert.equal(actionHeight, backHeight, "the action's height must match the topbar's other controls exactly");
});

// =========================================================================
// Owner-reported (2026-08-01): "in the browser modal the cards should also
// have shadow elevate and cursor pointer on hover" -- same treatment as
// civitai_search.mjs's own .wtn-cs-card, reusing the identical shared
// shadow value rather than a second hand-tuned one.
// =========================================================================

test("owner-reported (2026-08-01): a grid card signals it opens the detail view -- cursor: pointer, plus a hover elevation", () => {
  const doc = makeDocStub();
  injectModalStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  assert.ok(styleEl, "injectModalStyles must append a <style> tag to <head>");
  assert.match(
    styleEl.textContent,
    /\.wtn-cm-card\s*\{[^}]*cursor:\s*pointer;?/,
    "the card must show a pointer cursor -- it is a real click target (decision 11)",
  );
  assert.match(
    styleEl.textContent,
    /\.wtn-cm-card:hover\s*\{\s*box-shadow:[^;]+;?\s*\}/,
    "hovering the card must apply a shadow elevation",
  );
});

test("owner-reported (2026-08-01): the modal grid card and the search panel card resolve to the SAME hover shadow value -- one shared token, not two hand-tuned rgba()s that can silently drift apart", () => {
  const modalDoc = makeDocStub();
  injectModalStyles(modalDoc);
  const modalCss = modalDoc.head.children.find((c) => c.tagName === "style").textContent;
  const modalShadow = modalCss.match(/\.wtn-cm-card:hover\s*\{\s*box-shadow:\s*([^;]+);?\s*\}/)[1].trim();

  const searchDoc = makeDocStub();
  injectSearchStyles(searchDoc);
  const searchCss = searchDoc.head.children.find((c) => c.tagName === "style").textContent;
  const searchShadow = searchCss.match(/\.wtn-cs-card:hover\s*\{\s*box-shadow:\s*([^;]+);?\s*\}/)[1].trim();

  assert.equal(modalShadow, searchShadow, "both cards must resolve to the exact same box-shadow declaration");
  assert.match(modalShadow, /var\(--wtn-row-shadow,/, "both must read the shared --wtn-row-shadow token, not a private literal");
});

// A `kind: null` card's own click-still-opens-detail behaviour is already
// covered end-to-end by "the detail view's own download targets the
// result's DERIVED kind..." further down (it clicks exactly such a card and
// asserts the detail view's honest not-installable line) -- not re-proven
// here, so `.wtn-cm-card`'s uniform cursor:pointer/hover treatment above has
// no genuinely inert card to special-case.

// =========================================================================
// openCivitaiModal -- DOM-level integration, via a minimal stub DOM
// (independently reimplemented, matching test_civitai_search.mjs's own
// `makeDocStub` -- see that file's top doc comment on why tracks keep their
// own copy).
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
      disabled: false,
      spellcheck: false,
      open: false,
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      parentNode: null,
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
      dispatch(t, evt) {
        (e._listeners[t] || []).forEach((fn) => fn(evt || { target: e, stopPropagation() {} }));
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
        return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
      },
      focus() {
        e._focused = true;
      },
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
    innerWidth: 1400,
    innerHeight: 900,
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
    dispatch(t, evt) {
      (win._listeners[t] || []).forEach((fn) => fn(evt));
    },
  };
  const toolbarButton = makeElement("button");
  doc = {
    createElement: makeElement,
    getElementById() {
      return null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
    defaultView: win,
    activeElement: toolbarButton,
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

function findAllByTag(root, tagName) {
  const out = [];
  const walk = (e) => {
    if (e.tagName === tagName) {
      out.push(e);
    }
    (e.children || []).forEach(walk);
  };
  walk(root);
  return out;
}

function makeResult({
  modelId, versionId, name, kind = "loras", type = "LORA", installed = false, gated = false, baseModel = "SDXL",
  downloads = 0, images = [], nsfwLevel,
} = {}) {
  const result = {
    model_id: modelId,
    name,
    kind,
    type,
    creator: "someone",
    tags: [],
    nsfw: false,
    stats: { downloads, favorites: 0, rating: null },
    base_model: baseModel,
    primary_version_id: versionId,
    file_name: `${name}.safetensors`,
    download_url: "https://civitai.com/api/download/models/1",
    size_kb: 1000,
    gated,
    installed,
    triggers: [],
    images,
  };
  if (nsfwLevel !== undefined) {
    // The MODEL's own top-level `nsfw_level` -- a bitmask UNION across its
    // whole gallery (`civitai_search.py`'s `_parse_search_item`), distinct
    // from any per-image level inside `images[]` (§7c-iv).
    result.nsfw_level = nsfwLevel;
  }
  return result;
}

await asyncTest("openCivitaiModal: 90%-viewport shell (scrim + panel, NOT full-bleed), focused search box, renders results", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [
    makeResult({ modelId: 1, versionId: 1, name: "Installed One", installed: true }),
    makeResult({ modelId: 2, versionId: 2, name: "Available One", downloads: 12400 }),
  ];
  stubFetch(async (url) => {
    assert.ok(String(url).startsWith("/wtn/model_browser/search?"));
    const params = new URL(String(url), "http://x").searchParams;
    assert.equal(params.get("kind"), null, "the modal must never lock a kind");
    return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    assert.ok(handle, "openCivitaiModal returns a handle");
    await settle();

    const scrimEls = findAll(handle.scrim, "wtn-cm-scrim");
    assert.ok(handle.scrim.classList.contains("wtn-cm-scrim"));
    const panelEls = findAll(handle.scrim, "wtn-cm-panel");
    assert.equal(panelEls.length, 1);

    const cards = findAll(handle.scrim, "wtn-cm-card");
    assert.equal(cards.length, 2);

    const installedBadge = findAll(handle.scrim, "wtn-cm-action-installed")[0];
    assert.equal(installedBadge.textContent, "✓ installed");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: Escape closes it and restores focus to the previously-focused element", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const previouslyFocused = doc.activeElement;
    let closed = false;
    const handle = openCivitaiModal({ doc, onClose: () => { closed = true; } });
    await settle();
    assert.ok(doc.body.contains(handle.scrim), "the scrim is attached to the document body while open");

    doc.defaultView.dispatch("keydown", { key: "Escape" });
    assert.ok(closed, "Escape must close the modal");
    assert.ok(!doc.body.contains(handle.scrim), "the scrim is detached from the document on close");
    assert.ok(previouslyFocused._focused, "focus must be restored to the element that had it before opening");
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: a click on the scrim itself closes it; a click INSIDE the panel does not", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    let closeCount = 0;
    const handle = openCivitaiModal({ doc, onClose: () => { closeCount += 1; } });
    await settle();

    // A click that bubbles up from something INSIDE the panel -- `target`
    // is the panel, not the scrim -- must NOT close it.
    handle.scrim.dispatch("mousedown", { target: handle.panel, stopPropagation() {} });
    assert.equal(closeCount, 0, "a click inside the panel must not close the modal");

    handle.scrim.dispatch("mousedown", { target: handle.scrim, stopPropagation() {} });
    assert.equal(closeCount, 1, "a click on the scrim itself must close the modal");
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: closing a second time (or closing twice) never throws or double-fires onClose", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    let closeCount = 0;
    const handle = openCivitaiModal({ doc, onClose: () => { closeCount += 1; } });
    await settle();
    handle.close();
    handle.close();
    assert.equal(closeCount, 1);
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: opening a second time closes the first instance (single modal at a time)", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    let firstClosed = false;
    const first = openCivitaiModal({ doc, onClose: () => { firstClosed = true; } });
    await settle();
    const second = openCivitaiModal({ doc });
    await settle();
    assert.ok(firstClosed, "opening a second modal must close the first");
    assert.notEqual(first, second);
    second.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: a kind: null result shows NO download button, just the honest quiet line -- and results are never client-side filtered by kind", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [
    makeResult({ modelId: 1, versionId: 1, name: "Unmappable Type", kind: null, type: "Wildcards" }),
    makeResult({ modelId: 2, versionId: 2, name: "A Real LoRA", kind: "loras" }),
  ];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const cards = findAll(handle.scrim, "wtn-cm-card");
    assert.equal(cards.length, 2, "a kind:null result is still RENDERED, never dropped client-side");

    const nokindLines = findAll(handle.scrim, "wtn-cm-nokind");
    assert.equal(nokindLines.length, 1);
    assert.equal(nokindLines[0].textContent, NOT_INSTALLABLE_MESSAGE);

    // The unmappable card must carry no download button/destination label at all.
    const unmappableCard = cards.find((c) => findAllByTag(c, "div").some((d) => d.textContent === "Unmappable Type"));
    assert.ok(unmappableCard);
    assert.equal(findAll(unmappableCard, "wtn-cm-dest").length, 0, "no destination label without a real kind");
    const buttonsInUnmappable = findAllByTag(unmappableCard, "button").filter((b) => b.textContent === "↓ Download");
    assert.equal(buttonsInUnmappable.length, 0, "no download button for a kind:null result");

    const downloadButtons = findAll(handle.scrim, "wtn-cm-action").filter((e) => e.textContent === "↓ Download");
    assert.equal(downloadButtons.length, 1, "the mappable result still gets exactly one Download button");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("owner-reported (2026-08-01): 'remove the -> models/checkpoints/ caption' -- a downloadable grid card renders NO destination line at all (repeated on every card it was noise; the destination is already stated by the 'Save to:' field elsewhere)", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 1, versionId: 1, name: "Lands Somewhere", kind: "checkpoints" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    assert.equal(findAll(handle.scrim, "wtn-cm-dest").length, 0, "the grid card must never render a destination caption");
    // The download button itself is unaffected -- only the caption is gone.
    const downloadBtn = findAll(handle.scrim, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    assert.ok(downloadBtn, "the Download button must still render");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

function makeMultiVersionResult({ modelId, name, kind = "loras" } = {}) {
  const result = makeResult({ modelId, versionId: 10, name, kind });
  result.versions = [
    {
      version_id: 10, name: "v2.0", base_model: "SDXL", published_at: "2026-07-01T00:00:00.000Z",
      gated: false, file_name: "v2.safetensors", download_url: "https://civitai.com/dl/v2", size_kb: 500 * 1024,
      triggers: [], preview_url: null, images: [],
    },
    {
      version_id: 9, name: "v1.0", base_model: "SD1.5", published_at: "2026-01-01T00:00:00.000Z",
      gated: false, file_name: "v1.safetensors", download_url: "https://civitai.com/dl/v1", size_kb: 400 * 1024,
      triggers: [], preview_url: null, images: [],
    },
  ];
  return result;
}

await asyncTest("owner-reported (2026-08-01): a grid card with more than one version renders a version <select> above the Download button, reusing resolveVersionView -- switching it changes the download target", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeMultiVersionResult({ modelId: 5, name: "Multi Version" })];
  let downloadBody = null;
  stubFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes("/download/start")) {
      downloadBody = JSON.parse(opts.body);
      return jsonResponse({ reason: "started", message: "", job_id: "job-5" });
    }
    if (u.includes("/download/progress")) {
      return jsonResponse({ reason: "ok", status: "downloading", bytes: 0, total: null, message: "" });
    }
    return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const sel = findAll(handle.scrim, "wtn-cm-version-sel")[0];
    assert.ok(sel, "a multi-version card must render a version <select>");
    assert.equal(sel.children.length, 2);

    sel.value = "9";
    sel.dispatch("change", { stopPropagation() {} });
    await settle();

    const downloadBtn = findAll(handle.scrim, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.equal(downloadBody.filename, "v1.safetensors", "switching the card's own version select must change which version Download actually fetches");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("a single-version card never renders a version select at all", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 1, versionId: 1, name: "Only One Version" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    assert.equal(findAll(handle.scrim, "wtn-cm-version-sel").length, 0);
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: clicking Download posts the result's OWN derived kind, not a guessed one", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 9, versionId: 9, name: "Post This Kind", kind: "unet" })];
  let downloadBody = null;
  stubFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes("/download/start")) {
      downloadBody = JSON.parse(opts.body);
      return jsonResponse({ reason: "started", message: "", job_id: "job-9" });
    }
    if (u.includes("/download/progress")) {
      return jsonResponse({ reason: "ok", status: "downloading", bytes: 0, total: null, message: "" });
    }
    return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc, pollIntervalMs: 5000 });
    await settle();
    const btn = findAll(handle.scrim, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    assert.ok(btn);
    btn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.ok(downloadBody, "the download route must have been called");
    assert.equal(downloadBody.kind, "unet");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

// =========================================================================
// C/E (task brief, 2026-07-31) -- search issued/result count and download
// start/finish route through `js/shared/console_log.mjs`'s level-aware
// helper, tagged "Civitai browser" (this surface's own tag, distinct from
// the node-embedded picker's own "LoRA search").
// =========================================================================

await asyncTest("openCivitaiModal: at 'debug', a search issued and its result count are both logged, tagged 'Civitai browser'; a download logs start then finish", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 43, versionId: 43, name: "Logged Modal Result", kind: "unet" })];
  const savedSettings = { [SETTING_IDS.CONSOLE_LOGGING]: "debug" };
  globalThis.window = { app: { extensionManager: { setting: { get: (id) => savedSettings[id] } } } };
  const logCalls = [];
  const origLog = console.log;
  console.log = (...args) => logCalls.push(args);
  let progressCalls = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-log-modal" });
    }
    if (u.includes("/download/progress")) {
      progressCalls += 1;
      return jsonResponse({ reason: "ok", status: progressCalls === 1 ? "downloading" : "ok", bytes: progressCalls === 1 ? 40 : 100, total: 100, message: "" });
    }
    return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc, pollIntervalMs: 10 });
    await settle();

    assert.ok(logCalls.every((c) => c[0] === "[AnimaFlow Civitai browser]"), "every logged line is tagged with this surface's own tag");
    assert.ok(logCalls.some((c) => c.join(" ").includes("issuing search")), "a search issue is logged");
    assert.ok(logCalls.some((c) => c.join(" ").includes("-> 1 result(s)")), "the result count is logged");

    const btn = findAll(handle.scrim, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    btn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.ok(logCalls.some((c) => c.join(" ").includes("download started:")), "download start is logged");

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(logCalls.some((c) => c.join(" ").includes("download finished:") && c.join(" ").includes("(ok)")), "download finish is logged");

    handle.close();
  } finally {
    console.log = origLog;
    delete globalThis.window;
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: at 'off' (the default), nothing is logged at all", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const logCalls = [];
  const origLog = console.log;
  console.log = (...args) => logCalls.push(args);
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    assert.equal(logCalls.length, 0, "no live app/setting reachable -- defaults to 'off', genuinely silent");
    handle.close();
  } finally {
    console.log = origLog;
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: the rail's chip filters add, dedupe, and remove, and persist to the SAME settings a fresh open re-reads", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const savedSettings = {};
  const fakeApp = {
    extensionManager: {
      setting: {
        get: (id) => savedSettings[id],
        set: (id, v) => { savedSettings[id] = v; },
      },
    },
  };
  const queries = [];
  stubFetch(async (url) => {
    const u = new URL(String(url), "http://x");
    queries.push(Object.fromEntries(u.searchParams.entries()));
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  globalThis.window = { app: fakeApp };
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const selects = findAllByTag(handle.scrim, "select");
    // sort, period, level, base-model-adder, model-type-adder -- in that order.
    const baseModelSel = selects[3];
    const modelTypeSel = selects[4];

    baseModelSel.value = "Pony";
    baseModelSel.dispatch("change", { stopPropagation() {} });
    await settle();
    assert.deepEqual(JSON.parse(savedSettings[SETTING_IDS.CIVITAI_MODAL_BASE_MODELS]), ["Pony"]);
    assert.equal(baseModelSel.value, "", "the select resets to its placeholder after adding a chip (reads as an action)");

    // Selecting the SAME value again must be a no-op (§7c-i).
    baseModelSel.value = "Pony";
    baseModelSel.dispatch("change", { stopPropagation() {} });
    await settle();
    assert.deepEqual(JSON.parse(savedSettings[SETTING_IDS.CIVITAI_MODAL_BASE_MODELS]), ["Pony"], "a duplicate selection must not add a second chip");

    let chips = findAll(handle.scrim, "wtn-cm-chip");
    assert.equal(chips.length, 1);

    modelTypeSel.value = MODEL_TYPE_OPTIONS[0];
    modelTypeSel.dispatch("change", { stopPropagation() {} });
    await settle();
    assert.deepEqual(JSON.parse(savedSettings[SETTING_IDS.CIVITAI_MODAL_MODEL_TYPES]), [MODEL_TYPE_OPTIONS[0]]);

    const lastQuery = queries[queries.length - 1];
    // `searchUnscoped` sends `base_model` (singular -- the same key the
    // anchored panel uses), never an invented `base_models` plural; a
    // single chip is a one-element repeated-param list, which
    // `Object.fromEntries` above collapses to its lone value.
    assert.equal(lastQuery.base_model, "Pony");
    assert.equal(lastQuery.types, MODEL_TYPE_OPTIONS[0]);

    // Remove the base-model chip via its own ✕.
    chips = findAll(handle.scrim, "wtn-cm-chip");
    const chipX = findAll(chips[0], "wtn-cm-chip-x")[0];
    chipX.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.deepEqual(JSON.parse(savedSettings[SETTING_IDS.CIVITAI_MODAL_BASE_MODELS]), []);

    handle.close();

    // A FRESH open re-reads the same settings -- "the picker and the modal
    // open with the same remembered filters" (§7c-i).
    const doc2 = makeDocStub();
    const handle2 = openCivitaiModal({ doc: doc2 });
    await settle();
    const chips2 = findAll(handle2.scrim, "wtn-cm-chip");
    assert.equal(chips2.length, 1, "the model-type chip persisted across a close/reopen");
    handle2.close();
  } finally {
    delete globalThis.window;
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

// D2 (REVERSED 2026-07-31, owner, from the built rail): an empty filter
// group used to show a faint "any" line -- it now renders NOTHING at all,
// since the select directly above already reads "Add a ..." and a second
// line restating that adds nothing. Do NOT "restore" the old 'any' line as
// a regression fix -- this reversal is deliberate (docs/lora-loader-
// design.md's own §7c-i records the same correction).
await asyncTest("openCivitaiModal: an empty filter group renders NOTHING (D2 -- reverses the old faint 'any' line)", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    const chipsHosts = findAll(handle.scrim, "wtn-cm-chips");
    assert.equal(chipsHosts.length, 2, "both multi-value sections (base model, model type) still have a chips host");
    for (const host of chipsHosts) {
      assert.equal(host.children.length, 0, "an empty group's chips host has NO children at all -- no 'any' line, no placeholder");
    }
    assert.equal(findAll(handle.scrim, "wtn-cm-chip-any").length, 0, "the old 'any' class must never render");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: D3 -- the open <select> shows a checkmark against already-selected values, never mutating the underlying value", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const savedSettings = {};
  const fakeApp = { extensionManager: { setting: { get: (id) => savedSettings[id], set: (id, v) => { savedSettings[id] = v; } } } };
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  globalThis.window = { app: fakeApp };
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const selects = findAllByTag(handle.scrim, "select");
    const baseModelSel = selects[3]; // sort, period, level, base-model-adder, model-type-adder

    // Nothing selected yet -- no option carries the checkmark.
    let opts = baseModelSel.children.filter((c) => c.tagName === "option");
    assert.ok(opts.every((o) => !o.textContent.startsWith("✓")), "no checkmark before anything is added");

    baseModelSel.value = "Pony";
    baseModelSel.dispatch("change", { stopPropagation() {} });
    await settle();

    opts = baseModelSel.children.filter((c) => c.tagName === "option");
    const ponyOpt = opts.find((o) => o.value === "Pony");
    assert.equal(ponyOpt.textContent, "✓ Pony", "the selected option's own text is prefixed with a checkmark");
    assert.equal(ponyOpt.value, "Pony", "the underlying VALUE is untouched -- only the text label carries the checkmark");
    const otherOpt = opts.find((o) => o.value && o.value !== "Pony");
    assert.equal(otherOpt.textContent, otherOpt.value, "every OTHER option stays plain");

    handle.close();
  } finally {
    delete globalThis.window;
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: D4 -- no header subtitle badge; the title alone renders", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    assert.equal(findAll(handle.scrim, "wtn-cm-badge").length, 0, "the subtitle badge element must be gone entirely");
    const headSpans = findAllByTag(handle.scrim, "span").filter((e) => e.textContent === "Browse Civitai");
    assert.equal(headSpans.length, 1, "the title itself still renders");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: D5 -- rail sections are plain headings, never a collapsible <details>/<summary>", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    assert.equal(findAllByTag(handle.scrim, "details").length, 0, "the rail must never use <details> any more -- D5 reverses D1's collapsible mechanism, not just its chrome");
    assert.equal(findAllByTag(handle.scrim, "summary").length, 0, "no disclosure triangle left to render");
    const headings = findAll(handle.scrim, "wtn-cm-rail-heading");
    assert.equal(headings.length, 5, "one plain heading per rail section: sort, period, level, base model, model type");
    const labels = headings.map((h) => h.textContent);
    assert.deepEqual(labels, ["Sort models by", "Period", "Maximum browsing level", "Filter by Base Model", "Filter by Model Type"]);

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

// =========================================================================
// §7c-iv thumbnails -- an empty `images` list is "locked" (hidden images
// PROVEN by the model's own `nsfw_level` bitmask), never the bare placeholder,
// and the placeholder itself now actually paints an icon (owner-reported,
// 2026-07-31: "why some images are not shown?" / "near-invisible in the
// modal's large box").
// =========================================================================

test("'.wtn-cm-thumb-ph' actually paints an icon -- it used to be a bare, invisible <span> with only color/font-size and no glyph at all", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "civitai_modal.mjs"), "utf8");
  const idx = src.indexOf(".wtn-cm-thumb-ph {");
  assert.ok(idx !== -1, "the rule must exist");
  // A bounded window, not `[^}]*` up to the rule's own closing brace -- this
  // file's `${TOKENS...}` template interpolations contain a literal `}`
  // themselves, which would terminate `[^}]*` long before the rule's real
  // closing brace and produce a false negative.
  assert.match(src.slice(idx, idx + 400), /mask-image:/, "the placeholder must render an actual icon, sized for this box, not the 40px card's");
});

await asyncTest("openCivitaiModal: an empty images list with an nsfw_level bit ABOVE the chosen level renders 'locked', not the blank placeholder", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [
    // Default browsing level is PG (1) -- a model whose OWN union has an XXX
    // (16) bit set has provably-hidden pictures even though its trimmed
    // `images` arrived empty.
    makeResult({ modelId: 6, versionId: 6, name: "Hidden Gallery", images: [], nsfwLevel: 1 | 16 }),
  ];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    assert.equal(findAllByTag(handle.scrim, "img").length, 0, "a locked card never renders an <img>");
    assert.equal(findAll(handle.scrim, "wtn-cm-thumb-ph").length, 0, "locked must win over the plain placeholder once nsfw_level proves hidden images exist");
    const locked = findAll(handle.scrim, "wtn-cm-thumb-locked")[0];
    assert.ok(locked, "the locked glyph must render");
    assert.match(locked.title, /above your browsing level/i);

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: an empty images list with NO nsfw_level bit above the chosen level (or no nsfw_level at all) keeps the honest placeholder", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [
    makeResult({ modelId: 7, versionId: 7, name: "Genuinely No Gallery", images: [], nsfwLevel: 1 }), // only PG in the union -- nothing hidden at the default PG setting
    makeResult({ modelId: 8, versionId: 8, name: "No Level Reported", images: [] }), // no nsfw_level at all -- an older backend build, or genuinely absent
  ];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    assert.equal(findAll(handle.scrim, "wtn-cm-thumb-locked").length, 0, "no bit above PG is set for either card -- must never claim 'locked' without proof");
    assert.equal(findAll(handle.scrim, "wtn-cm-thumb-ph").length, 2, "both cards fall back to the honest placeholder");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: sessionGatedKeys() learning is shared with civitai_search.mjs's own singleton", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 5, versionId: 5, name: "Learns Gated", kind: "loras" })];
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-5" });
    }
    if (u.includes("/download/progress")) {
      return jsonResponse({ reason: "ok", status: "key_required", bytes: 0, total: null, message: "" });
    }
    return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc, pollIntervalMs: 5 });
    await settle();
    const btn = findAll(handle.scrim, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    btn.dispatch("click", { stopPropagation() {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(sessionGatedKeys().has("5:5"), "a live key_required must be learned into the SHARED session-gated set");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

// =========================================================================
// The 5-auto-loaded-.js ceiling (`.claude/CLAUDE.md`) -- this feature adds
// zero new auto-loaded `.js` files; the modal is a lazily-imported `.mjs`.
// =========================================================================

test("still exactly 5 auto-loaded .js files in js/ (the pack-wide ceiling)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jsRoot = path.resolve(here, "..");
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        found.push(full);
      }
    }
  };
  walk(jsRoot);
  assert.equal(found.length, 5, `expected exactly 5 auto-loaded .js files, found ${found.length}: ${found.join(", ")}`);
});

test("civitai_modal.mjs itself is NOT one of the 5 auto-loaded .js files", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.ok(fs.existsSync(path.join(here, "civitai_modal.mjs")));
  assert.ok(!fs.existsSync(path.join(here, "civitai_modal.js")));
});

// =========================================================================
// §7c-i -- the explicit `Search` button, shared behaviour with
// civitai_search.mjs's own panel ("one implementation").
// =========================================================================

await asyncTest("openCivitaiModal: typing alone fires nothing; the Search button (and Enter) run the search, and it settles back to disabled", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const queries = [];
  stubFetch(async (url) => {
    const u = new URL(String(url), "http://x");
    queries.push(Object.fromEntries(u.searchParams.entries()));
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    assert.equal(queries.length, 1, "opening the modal runs one initial search");

    const search = findAll(handle.panel, "wtn-cm-search")[0];
    const searchBtn = findAll(handle.panel, "wtn-cm-search-btn")[0];
    assert.equal(searchBtn.disabled, true, "must start disabled -- the initial search already ran");

    search.value = "skin";
    search.dispatch("input");
    assert.equal(searchBtn.disabled, false, "typing something new enables the button");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(queries.length, 1, "typing must never fire a search on its own, no matter how long we wait -- no debounce left running");

    searchBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.equal(queries.length, 2, "the button click issues exactly one search");
    assert.equal(queries[1].query, "skin");
    assert.equal(searchBtn.disabled, true, "settles back to disabled once that search has executed");

    search.value = "detail";
    search.dispatch("input");
    search.dispatch("keydown", { key: "Enter", preventDefault() {} });
    await settle();
    assert.equal(queries.length, 3, "Enter runs the SAME action as the button");
    assert.equal(queries[2].query, "detail");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: a filter change re-searches immediately and updates the last-searched text, settling the button back to disabled", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const queries = [];
  stubFetch(async (url) => {
    const u = new URL(String(url), "http://x");
    queries.push(Object.fromEntries(u.searchParams.entries()));
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    const search = findAll(handle.panel, "wtn-cm-search")[0];
    const searchBtn = findAll(handle.panel, "wtn-cm-search-btn")[0];
    search.value = "skin";
    search.dispatch("input");
    assert.equal(searchBtn.disabled, false);

    const selects = findAllByTag(handle.scrim, "select");
    const sortSel = selects[0];
    sortSel.value = "Newest";
    sortSel.dispatch("change", { stopPropagation() {} });
    await settle();
    assert.equal(queries.length, 2, "changing a filter re-searches immediately");
    assert.equal(searchBtn.disabled, true, "a filter-triggered search updates the last-searched text too");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

// =========================================================================
// The master→detail swap (decision 11) -- one component (`model_detail_view
// .mjs`), this modal's own mount of it. See `test_civitai_search.mjs`'s own
// "§7c-ii" section for the PICKER's mount of the identical component.
// =========================================================================

await asyncTest("openCivitaiModal: a card click swaps the results area for the detail view, keeping the RAIL visible", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 60, versionId: 6, name: "Swap Test" })];
  invalidateModelDetail(60, 6);
  const detailCalls = [];
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
    }
    if (u.includes("/model_detail")) {
      detailCalls.push(u);
      return jsonResponse({
        reason: "found", message: "", offline_reason: null,
        model_description: "Write-up.", model_description_checked: true,
        version_description: null, gallery: [{ url: "g.jpg", nsfw_level: 1, prompt: "a prompt" }],
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const railBefore = findAll(handle.panel, "wtn-cm-rail")[0];
    assert.ok(railBefore, "the rail must exist before opening detail");

    const card = findAll(handle.scrim, "wtn-cm-card")[0];
    card.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.ok(detailCalls.some((u) => u.includes("model_id=60") && u.includes("version_id=6")));

    const rail = findAll(handle.panel, "wtn-cm-rail")[0];
    assert.ok(rail && rail.parentNode, "the filter rail must STAY visible while the detail view is shown");
    assert.notEqual(rail.style.display, "none");

    const searchbar = findAll(handle.panel, "wtn-cm-searchbar")[0];
    assert.equal(searchbar.style.display, "none", "the search bar hides while the detail view is shown");

    const title = findAll(handle.panel, "wtn-dv-title")[0];
    assert.ok(title, "the swapped-in detail view must render");
    assert.equal(title.textContent, "Swap Test");

    const stripImg = findAll(handle.panel, "wtn-dv-gallery-filmstrip")[0];
    assert.ok(stripImg, "the modal's own mount uses the FILMSTRIP layout (renamed 2026-08-01 from 'grid'), not the picker's twoCol one");

    // Owner, 2026-08-01: the gallery moved above the descriptions -- real
    // integration proof on the MODAL's own mount, not just the shared
    // component in isolation.
    const headings = findAll(handle.panel, "wtn-dv-sechead").map((h) => h.textContent);
    assert.deepEqual(headings, ["Gallery", "Model Description"], "the modal's own mount must render the gallery BEFORE the description, in DOM order");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: '← back to results' swaps back to the grid, with the rail untouched throughout", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 61, versionId: 7, name: "Back Test" })];
  invalidateModelDetail(61, 7);
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
    }
    if (u.includes("/model_detail")) {
      return jsonResponse({
        reason: "found", message: "", offline_reason: null,
        model_description: null, model_description_checked: true, version_description: null, gallery: [],
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const card = findAll(handle.scrim, "wtn-cm-card")[0];
    card.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.ok(findAll(handle.panel, "wtn-dv-title")[0], "detail view is showing");

    const backBtn = findAll(handle.panel, "wtn-dv-back")[0];
    assert.ok(backBtn);
    // The modal's topbar shape keeps '← back to results' -- it genuinely
    // swaps the grid back into view, unlike the picker's sibling-overlay
    // close. It must never ALSO show the picker's own ✕ close affordance
    // (owner, 2026-08-01: the two mounts want different controls here).
    assert.equal(findAll(handle.panel, "wtn-dv-close").length, 0, "the modal must never render the picker's own ✕ close affordance");
    backBtn.dispatch("click", { stopPropagation() {} });

    assert.equal(findAll(handle.panel, "wtn-dv-title").length, 0, "the detail view must be gone after 'back'");
    const gridWrapEl = findAll(handle.panel, "wtn-cm-gridwrap")[0];
    assert.notEqual(gridWrapEl.style.display, "none", "the grid must be visible again");
    assert.equal(findAll(handle.scrim, "wtn-cm-card").length, 1, "the original result card is still there");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: the detail view's own download targets the result's DERIVED kind, never a guessed one, and a null kind shows the honest line instead of a button", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const installable = makeResult({ modelId: 62, versionId: 8, name: "Installable", kind: "checkpoints", type: "Checkpoint" });
  const notInstallable = { ...makeResult({ modelId: 63, versionId: 9, name: "Not Installable", type: "Workflows" }), kind: null };
  const results = [installable, notInstallable];
  invalidateModelDetail(62, 8);
  invalidateModelDetail(63, 9);
  let startedKind = null;
  stubFetch(async (url, init) => {
    const u = String(url);
    if (u.includes("/search")) {
      return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
    }
    if (u.includes("/model_detail")) {
      return jsonResponse({
        reason: "found", message: "", offline_reason: null,
        model_description: null, model_description_checked: true, version_description: null, gallery: [],
      });
    }
    if (u.includes("/download/start")) {
      const payload = JSON.parse(init.body);
      startedKind = payload.kind;
      return jsonResponse({ reason: "started", message: "", job_id: "job-detail" });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const cards = findAll(handle.scrim, "wtn-cm-card");
    cards[0].dispatch("click", { stopPropagation() {} });
    await settle();
    const downloadBtn = findAll(handle.panel, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    assert.ok(downloadBtn, "the installable result's detail view must show a Download button");

    // Owner-reported, with a screenshot (2026-08-01): "→ models/checkpoints/"
    // sat ABOVE the Download button -- it's a caption FOR that button, so it
    // must render UNDERNEATH it in DOM order, not above. Scoped to the
    // DETAIL HOST specifically -- the (hidden, not removed) grid behind it
    // also has its own `.wtn-cm-actioncol` per card, unrelated to this fix.
    const detailHostForOrder = findAll(handle.panel, "wtn-cm-detailhost")[0];
    const actionCol = findAll(detailHostForOrder, "wtn-cm-actioncol")[0];
    const destCaption = findAll(actionCol, "wtn-cm-dest")[0];
    assert.ok(destCaption, "the detail view's own action must show the destination caption");
    assert.ok(
      actionCol.children.indexOf(downloadBtn) < actionCol.children.indexOf(destCaption),
      "the destination caption must render AFTER (below) the Download button in DOM order",
    );

    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.equal(startedKind, "checkpoints", "the download must target the result's own DERIVED kind");

    const backBtn = findAll(handle.panel, "wtn-dv-back")[0];
    backBtn.dispatch("click", { stopPropagation() {} });

    cards[1].dispatch("click", { stopPropagation() {} });
    await settle();
    const detailHostEl = findAll(handle.panel, "wtn-cm-detailhost")[0];
    assert.equal(findAll(detailHostEl, "wtn-cm-nokind").length, 1, "a null-kind result's detail view shows the honest line");
    assert.equal(findAll(detailHostEl, "wtn-cm-action").filter((e) => e.textContent.includes("Download")).length, 0);

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
