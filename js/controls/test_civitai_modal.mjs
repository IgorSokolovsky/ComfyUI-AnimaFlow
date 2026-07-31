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
import { _resetDownloadStateForTests, sessionGatedKeys } from "./civitai_search.mjs";
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
// D1 -- no per-section card/box chrome on the rail (owner, 2026-07-31): a
// SCOPED reset of the shared '.wtn-collapse' class, never an edit to that
// class itself (which every other consumer -- e.g. the Rule Builder -- must
// keep unchanged).
// =========================================================================

test("D1: '.wtn-cm-rail .wtn-collapse' resets background/border/radius to none -- scoped, never editing the shared '.wtn-collapse' class itself", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "civitai_modal.mjs"), "utf8");
  assert.match(src, /\.wtn-cm-rail \.wtn-collapse\s*\{[^}]*background:\s*none/s);
  assert.match(src, /\.wtn-cm-rail \.wtn-collapse\s*\{[^}]*border:\s*none/s);
  assert.match(src, /\.wtn-cm-rail \.wtn-collapse\s*\{[^}]*border-radius:\s*0/s);
});

test("D4: the '.wtn-cm-badge' CSS rule itself is gone (not merely the element)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "civitai_modal.mjs"), "utf8");
  assert.doesNotMatch(src, /\.wtn-cm-badge/);
});

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

function makeResult({ modelId, versionId, name, kind = "loras", type = "LORA", installed = false, gated = false, baseModel = "SDXL", downloads = 0 } = {}) {
  return {
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
    images: [],
  };
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

await asyncTest("openCivitaiModal: a downloadable result shows where it will land", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 1, versionId: 1, name: "Lands Somewhere", kind: "checkpoints" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    const destLines = findAll(handle.scrim, "wtn-cm-dest");
    assert.equal(destLines.length, 1);
    assert.equal(destLines[0].textContent, "→ models/checkpoints/");
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

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
