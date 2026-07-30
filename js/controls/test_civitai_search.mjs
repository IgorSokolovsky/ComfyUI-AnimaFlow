/**
 * test_civitai_search.mjs — regression tests for `civitai_search.mjs`'s pure
 * helpers (compact counts, download percentage, the four §7c-iii card
 * states, the destination-field subfolder resolution, and the readable
 * search/download reason messages), the module-level download-job
 * orchestration (`startDownloadJob`/`subscribeDownloadState`/
 * `getActiveDownloadState`/`cancelActiveDownloadJob`), a DOM-level
 * integration test of `openCivitaiSearch` itself (via a minimal stub DOM,
 * mirroring `test_model_picker.mjs`'s/`test_model_info.mjs`'s own
 * `makeDocStub` independently -- see either file's top doc comment on why
 * tracks keep their own copy), and the layering-guard scan already covers
 * this file too (`test_model_picker.mjs`'s `GUARDED_FILES`). Plain
 * `node js/controls/test_civitai_search.mjs`.
 */

import assert from "node:assert/strict";

import {
  DEFAULT_ROOT_DISPLAY,
  TYPE_LABEL_FOR_KIND,
  formatCompactCount,
  downloadPercent,
  resultKey,
  resultCardState,
  resultSubtitle,
  gatedSubtitle,
  subfolderFromDestinationField,
  searchReasonMessage,
  downloadStartMessage,
  downloadTerminalMessage,
  subscribeDownloadState,
  getActiveDownloadState,
  startDownloadJob,
  cancelActiveDownloadJob,
  _resetDownloadStateForTests,
  openCivitaiSearch,
} from "./civitai_search.mjs";
import { invalidateList, hasFile, listModels } from "./civitai_api.mjs";

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
// formatCompactCount
// =========================================================================

test("formatCompactCount: thresholds -- plain integers under 1000, k/M/B above", () => {
  assert.equal(formatCompactCount(0), "0");
  assert.equal(formatCompactCount(42), "42");
  assert.equal(formatCompactCount(999), "999");
  assert.equal(formatCompactCount(1000), "1k");
  assert.equal(formatCompactCount(12400), "12.4k");
  assert.equal(formatCompactCount(890), "890");
  assert.equal(formatCompactCount(2_500_000), "2.5M");
  assert.equal(formatCompactCount(1_000_000_000), "1B");
});

test("formatCompactCount: garbage/negative/non-finite degrades to '0', never throws", () => {
  assert.equal(formatCompactCount(-5), "0");
  assert.equal(formatCompactCount(NaN), "0");
  assert.equal(formatCompactCount(undefined), "0");
  assert.equal(formatCompactCount("not a number"), "0");
});

// =========================================================================
// downloadPercent
// =========================================================================

test("downloadPercent: whole-number 0-100, clamped", () => {
  assert.equal(downloadPercent(0, 100), 0);
  assert.equal(downloadPercent(50, 100), 50);
  assert.equal(downloadPercent(100, 100), 100);
  assert.equal(downloadPercent(38, 100), 38);
  assert.equal(downloadPercent(150, 100), 100, "never exceeds 100 even if bytes > total (a lying content-length)");
});

test("downloadPercent: null (indeterminate) when total is missing/zero/non-finite -- never NaN", () => {
  assert.equal(downloadPercent(10, null), null);
  assert.equal(downloadPercent(10, 0), null);
  assert.equal(downloadPercent(10, undefined), null);
  assert.equal(downloadPercent(NaN, 100), null);
});

// =========================================================================
// resultKey / resultCardState / resultSubtitle
// =========================================================================

test("resultKey: model_id:primary_version_id, '' for garbage", () => {
  assert.equal(resultKey({ model_id: 111, primary_version_id: 222 }), "111:222");
  assert.equal(resultKey(null), "");
  assert.equal(resultKey(undefined), "");
});

test("resultCardState: an in-flight job for THIS result wins over installed/gated", () => {
  const result = { model_id: 1, primary_version_id: 2, installed: true, gated: true };
  const job = { key: resultKey(result) };
  assert.equal(resultCardState(result, job), "downloading");
});

test("resultCardState: installed wins over gated (installed is the more useful, final truth)", () => {
  assert.equal(resultCardState({ model_id: 1, primary_version_id: 2, installed: true, gated: true }, null), "installed");
});

test("resultCardState: gated when neither installed nor an active job", () => {
  assert.equal(resultCardState({ model_id: 1, primary_version_id: 2, installed: false, gated: true }, null), "gated");
});

test("resultCardState: available is the default", () => {
  assert.equal(resultCardState({ model_id: 1, primary_version_id: 2, installed: false, gated: false }, null), "available");
  assert.equal(resultCardState(null, null), "available");
});

test("resultCardState: a job for a DIFFERENT result never marks this one downloading", () => {
  const result = { model_id: 1, primary_version_id: 2, installed: false, gated: false };
  const job = { key: "9:9" };
  assert.equal(resultCardState(result, job), "available");
});

test("resultSubtitle: base model + compact download count, joined", () => {
  assert.equal(resultSubtitle({ base_model: "SDXL", stats: { downloads: 12400 } }), "SDXL · 12.4k ↓");
});

test("resultSubtitle: omits the base-model segment when genuinely absent (never 'unknown')", () => {
  assert.equal(resultSubtitle({ base_model: "", stats: { downloads: 0 } }), "0 ↓");
  assert.equal(resultSubtitle({ stats: {} }), "0 ↓");
});

test("resultSubtitle: a missing result never throws", () => {
  assert.equal(resultSubtitle(null), "");
});

test("gatedSubtitle: base model + 'needs an API key', or the bare line with no stray separator when base model is unknown", () => {
  assert.equal(gatedSubtitle({ base_model: "SDXL" }), "SDXL · needs an API key");
  assert.equal(gatedSubtitle({ base_model: "" }), "needs an API key");
  assert.equal(gatedSubtitle(null), "needs an API key");
});

// =========================================================================
// subfolderFromDestinationField
// =========================================================================

test("subfolderFromDestinationField: the untouched default root -> '' (write to the kind's own root)", () => {
  assert.equal(subfolderFromDestinationField("models/loras", "loras"), "");
  assert.equal(subfolderFromDestinationField("models/loras/", "loras"), "");
});

test("subfolderFromDestinationField: a nested path under the default root strips the root prefix", () => {
  assert.equal(subfolderFromDestinationField("models/loras/characters", "loras"), "characters");
  assert.equal(subfolderFromDestinationField("models/loras/characters/xl", "loras"), "characters/xl");
});

test("subfolderFromDestinationField: a bare subfolder name (no root prefix) is used as-is", () => {
  assert.equal(subfolderFromDestinationField("characters", "loras"), "characters");
});

test("subfolderFromDestinationField: empty/whitespace-only -> '' ", () => {
  assert.equal(subfolderFromDestinationField("", "loras"), "");
  assert.equal(subfolderFromDestinationField("   ", "loras"), "");
  assert.equal(subfolderFromDestinationField(null, "loras"), "");
});

test("subfolderFromDestinationField: an unknown kind has no root to strip -- the value passes through", () => {
  assert.equal(subfolderFromDestinationField("anything", "some-future-kind"), "anything");
});

// =========================================================================
// DEFAULT_ROOT_DISPLAY / TYPE_LABEL_FOR_KIND
// =========================================================================

test("DEFAULT_ROOT_DISPLAY / TYPE_LABEL_FOR_KIND: loras is the only wired kind, per §7a", () => {
  assert.equal(DEFAULT_ROOT_DISPLAY.loras, "models/loras");
  assert.equal(TYPE_LABEL_FOR_KIND.loras, "LoRA");
});

// =========================================================================
// searchReasonMessage / downloadStartMessage / downloadTerminalMessage
// =========================================================================

test("searchReasonMessage: rate_limited reads as a CALM 'slow down' line, never phrased as an error", () => {
  const msg = searchReasonMessage({ reason: "rate_limited" });
  assert.match(msg, /slow|wait a moment/i);
  assert.doesNotMatch(msg, /error|fail/i);
});

test("searchReasonMessage: '' for 'ok' or an unrecognised reason", () => {
  assert.equal(searchReasonMessage({ reason: "ok" }), "");
  assert.equal(searchReasonMessage({ reason: "something-else" }), "");
  assert.equal(searchReasonMessage(null), "");
});

test("searchReasonMessage: offline degrades to the specific offline_reason headline", () => {
  assert.match(searchReasonMessage({ reason: "offline", offline_reason: "timeout" }), /timed out/i);
  assert.match(searchReasonMessage({ reason: "offline", offline_reason: "dns_tls" }), /DNS/);
  assert.match(searchReasonMessage({ reason: "offline", offline_reason: "unreadable" }), /unreadable/i);
});

test("downloadStartMessage: every documented reason gets a readable line", () => {
  assert.match(downloadStartMessage({ reason: "already_installed" }), /already/i);
  assert.match(downloadStartMessage({ reason: "invalid_destination" }), /destination/i);
  assert.match(downloadStartMessage({ reason: "too_large", message: "This file exceeds the cap." }), /cap/i);
  assert.match(downloadStartMessage({ reason: "busy" }), /already running/i);
  assert.match(downloadStartMessage({ reason: "key_required" }), /API key/i);
});

test("downloadTerminalMessage: every terminal status gets a readable line", () => {
  assert.equal(downloadTerminalMessage("ok"), "Downloaded.");
  assert.equal(downloadTerminalMessage("cancelled"), "Cancelled.");
  assert.match(downloadTerminalMessage("key_required"), /API key/i);
  assert.match(downloadTerminalMessage("write_error", { message: "disk full" }), /disk full/);
});

// =========================================================================
// The download-job singleton -- startDownloadJob / subscribeDownloadState /
// getActiveDownloadState / cancelActiveDownloadJob.
// =========================================================================

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

await asyncTest("startDownloadJob: posts download/start, tracks the job, and notifies subscribers", async () => {
  _resetDownloadStateForTests();
  let startCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes("/download/start")) {
      startCalls += 1;
      return jsonResponse({ reason: "started", message: "", job_id: "job-1" });
    }
    // progress -- never resolves during this test (kept "downloading" throughout)
    return jsonResponse({ reason: "ok", status: "downloading", bytes: 10, total: 100, message: "" });
  });
  try {
    let notified = 0;
    const unsub = subscribeDownloadState(() => {
      notified += 1;
    });
    const resp = await startDownloadJob(
      { kind: "loras", filename: "a.safetensors", downloadUrl: "https://civitai.com/x", key: "1:1" },
      5,
    );
    assert.equal(resp.reason, "started");
    assert.equal(startCalls, 1);
    assert.ok(notified >= 1, "starting a job must notify subscribers immediately");
    const state = getActiveDownloadState();
    assert.ok(state);
    assert.equal(state.jobId, "job-1");
    assert.equal(state.key, "1:1");
    assert.equal(state.status, "downloading");
    unsub();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("startDownloadJob: a SECOND call while one is already running answers 'busy' LOCALLY -- no second network call", async () => {
  _resetDownloadStateForTests();
  let startCalls = 0;
  stubFetch(async (url) => {
    if (String(url).includes("/download/start")) {
      startCalls += 1;
      return jsonResponse({ reason: "started", message: "", job_id: "job-2" });
    }
    return jsonResponse({ reason: "ok", status: "downloading", bytes: 0, total: null, message: "" });
  });
  try {
    await startDownloadJob({ kind: "loras", filename: "a.safetensors", downloadUrl: "https://civitai.com/x", key: "1:1" }, 5);
    assert.equal(startCalls, 1);
    const second = await startDownloadJob({ kind: "loras", filename: "b.safetensors", downloadUrl: "https://civitai.com/y", key: "2:2" }, 5);
    assert.equal(second.reason, "busy");
    assert.equal(startCalls, 1, "the second call must never even reach the network -- answered locally");
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("startDownloadJob -> poll loop -> 'ok' clears the job AND invalidates the client list cache (task brief, deliverable 4)", async () => {
  _resetDownloadStateForTests();
  const kind = "download-complete-kind";
  invalidateList(kind);
  await listModels(kind).catch(() => {}); // ensure a clean slate; ignore any real fetch attempt below

  let progressCalls = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-3" });
    }
    if (u.includes("/download/progress")) {
      progressCalls += 1;
      if (progressCalls === 1) {
        return jsonResponse({ reason: "ok", status: "downloading", bytes: 50, total: 100, message: "" });
      }
      return jsonResponse({ reason: "ok", status: "ok", bytes: 100, total: 100, message: "" });
    }
    if (u.includes("/list")) {
      return jsonResponse({ reason: "ok", models: [{ name: "seed.safetensors" }] });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    // Seed the list cache so we have something to observe being invalidated.
    invalidateList(kind);
    await listModels(kind);
    assert.notEqual(hasFile(kind, "seed.safetensors"), null, "the list cache must be populated before the download completes");

    let updates = [];
    const unsub = subscribeDownloadState(() => updates.push(getActiveDownloadState()));
    await startDownloadJob({ kind, filename: "new.safetensors", downloadUrl: "https://civitai.com/z", key: "3:3" }, 5);

    // Wait for the poll loop to observe the terminal "ok" (two polls, 5ms apart).
    await new Promise((resolve) => setTimeout(resolve, 60));
    unsub();

    assert.equal(getActiveDownloadState(), null, "the job must clear once it reaches a terminal status");
    assert.equal(hasFile(kind, "seed.safetensors"), null, "invalidateList must have been called -- the cache is back to 'unknown'");
    assert.ok(updates.some((u) => u && u.status === "downloading"));
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    invalidateList(kind);
  }
});

await asyncTest("cancelActiveDownloadJob: posts /download/cancel for the active job; a no-op (never fetches) with nothing running", async () => {
  _resetDownloadStateForTests();
  let cancelCalls = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-4" });
    }
    if (u.includes("/download/cancel")) {
      cancelCalls += 1;
      return jsonResponse({ reason: "cancelling", message: "" });
    }
    // Keep the poll loop parked on "downloading" so it never clears the job during this test.
    return jsonResponse({ reason: "ok", status: "downloading", bytes: 0, total: null, message: "" });
  });
  try {
    await cancelActiveDownloadJob(); // nothing running -- must not throw, must not fetch
    assert.equal(cancelCalls, 0);

    await startDownloadJob({ kind: "loras", filename: "a.safetensors", downloadUrl: "https://civitai.com/x", key: "1:1" }, 5000);
    await cancelActiveDownloadJob();
    assert.equal(cancelCalls, 1);
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

// =========================================================================
// openCivitaiSearch -- DOM-level integration, via a minimal stub DOM.
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
      href: "",
      disabled: false,
      checked: false,
      spellcheck: false,
      selected: false,
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

function textOf(e) {
  const parts = [];
  const walk = (n) => {
    if (n.textContent) {
      parts.push(n.textContent);
    }
    (n.children || []).forEach(walk);
  };
  walk(e);
  return parts.join(" ");
}

function makeResult({ modelId, versionId, name, installed = false, gated = false, baseModel = "SDXL", downloads = 0 } = {}) {
  return {
    model_id: modelId,
    name,
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
  };
}

async function settle(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

await asyncTest("openCivitaiSearch: renders the exact §7c-iii labels for installed / available / gated, and focuses the search box", async () => {
  _resetDownloadStateForTests();
  const results = [
    makeResult({ modelId: 1, versionId: 1, name: "Installed One", installed: true }),
    makeResult({ modelId: 2, versionId: 2, name: "Available One", downloads: 12400 }),
    makeResult({ modelId: 3, versionId: 3, name: "Gated One", gated: true }),
  ];
  stubFetch(async (url) => {
    assert.ok(String(url).startsWith("/wtn/model_browser/search?"));
    return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    let focusedInput = null;
    const realCreateElement = doc.createElement;
    doc.createElement = (tag) => {
      const e = realCreateElement(tag);
      if (tag === "input") {
        const origFocus = e.focus;
        e.focus = () => {
          if (e.type === "text" && e.placeholder === "Search Civitai…") {
            focusedInput = e;
          }
          origFocus.call(e);
        };
      }
      return e;
    };

    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    assert.ok(focusedInput, "the search box must take focus on open");
    await settle();

    const cards = findAll(handle.overlay, "wtn-cs-card");
    assert.equal(cards.length, 3);

    const installedBadge = findAll(handle.overlay, "wtn-cs-action-installed")[0];
    assert.equal(installedBadge.textContent, "✓ installed", "installed label is exactly '✓ installed', not the mockup's 'have'");

    const downloadBtns = findAll(handle.overlay, "wtn-cs-action").filter((e) => e.textContent === "↓ Download");
    assert.equal(downloadBtns.length, 1, "available label is exactly '↓ Download', not the mockup's 'get'");

    const gatedBtn = findAll(handle.overlay, "wtn-cs-action-gated")[0];
    assert.equal(gatedBtn.textContent, "key required");
    assert.equal(gatedBtn.disabled, true);
    assert.match(textOf(handle.overlay), /needs an API key/);

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: 'No API key set — public results only.' shows exactly when the response says public_only", async () => {
  _resetDownloadStateForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: true }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    assert.match(textOf(handle.overlay), /No API key set — public results only\./);
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: rate_limited renders as a CALM line (wtn-cs-info), never the error colour (wtn-cs-bad)", async () => {
  _resetDownloadStateForTests();
  stubFetch(async () => jsonResponse({ reason: "rate_limited", message: "Searching too quickly", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    assert.equal(findAll(handle.overlay, "wtn-cs-bad").length, 0, "rate-limited must never use the error/bad styling");
    assert.equal(findAll(handle.overlay, "wtn-cs-info").length, 1);
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: the destination field defaults to models/<kind>, editable", async () => {
  _resetDownloadStateForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    const inputs = [];
    const walk = (e) => {
      if (e.tagName === "input" && e.type === "text" && e !== undefined) {
        inputs.push(e);
      }
      (e.children || []).forEach(walk);
    };
    walk(handle.overlay);
    const dest = inputs.find((i) => i.value === "models/loras");
    assert.ok(dest, "the destination field must default to 'models/loras' for kind=loras");
    dest.value = "models/loras/characters";
    assert.equal(dest.value, "models/loras/characters", "the field must be editable (a plain text input, not read-only)");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: clicking Download starts a job; the card shows progress+cancel while it runs, then flips to installed on success", async () => {
  _resetDownloadStateForTests();
  const result = makeResult({ modelId: 9, versionId: 9, name: "Detail LoRA" });
  let searchCalls = 0;
  let progressCalls = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      searchCalls += 1;
      return jsonResponse({ reason: "ok", message: "", results: [result], next_cursor: null, public_only: false });
    }
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-dom-1" });
    }
    if (u.includes("/download/progress")) {
      progressCalls += 1;
      if (progressCalls === 1) {
        return jsonResponse({ reason: "ok", status: "downloading", bytes: 40, total: 100, message: "" });
      }
      return jsonResponse({ reason: "ok", status: "ok", bytes: 100, total: 100, message: "" });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras", pollIntervalMs: 10 });
    await settle();
    assert.equal(searchCalls, 1);

    const downloadBtn = findAll(handle.overlay, "wtn-cs-action").find((e) => e.textContent === "↓ Download");
    assert.ok(downloadBtn);
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    // Mid-flight: a percentage label + a Cancel button on the card, per
    // §7c-iii's "downloading" state.
    assert.ok(findAll(handle.overlay, "wtn-cs-action-cancel").length >= 1);
    assert.match(textOf(handle.overlay), /40%/);

    // Let the (test-shortened) poll loop resolve the second poll's terminal "ok".
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(findAll(handle.overlay, "wtn-cs-action-installed").length, 1, "the card must flip to installed once the job completes");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: a download/start failure (e.g. 'busy') shows a readable message under the card, never a silent no-op", async () => {
  _resetDownloadStateForTests();
  const result = makeResult({ modelId: 5, versionId: 5, name: "Busy LoRA" });
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      return jsonResponse({ reason: "ok", message: "", results: [result], next_cursor: null, public_only: false });
    }
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "busy", message: "Another download is already in progress.", job_id: null });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras", pollIntervalMs: 10 });
    await settle();
    const downloadBtn = findAll(handle.overlay, "wtn-cs-action").find((e) => e.textContent === "↓ Download");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.match(textOf(handle.overlay), /already running/i);
    assert.equal(getActiveDownloadState(), null, "a failed start must never leave a phantom active job behind");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: changing a filter <select> re-searches with the new value, and the search input is debounced", async () => {
  _resetDownloadStateForTests();
  const queries = [];
  stubFetch(async (url) => {
    const u = new URL(String(url), "http://x");
    queries.push(Object.fromEntries(u.searchParams.entries()));
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras", pollIntervalMs: 10 });
    await settle();
    assert.equal(queries.length, 1, "opening the panel runs one initial search");

    const selects = [];
    const walk = (e) => {
      if (e.tagName === "select") {
        selects.push(e);
      }
      (e.children || []).forEach(walk);
    };
    walk(handle.overlay);
    assert.equal(selects.length, 3, "base model, sort, and period each get their own <select> pill");
    const sortSel = selects[1];
    sortSel.value = "Newest";
    sortSel.dispatch("change", { stopPropagation() {} });
    await settle();
    assert.equal(queries.length, 2, "changing a filter re-searches immediately, without debounce");
    assert.equal(queries[1].sort, "Newest");

    // The free-text search box IS debounced -- rapid keystrokes must not
    // fire one request per keystroke.
    const search = findAll(handle.overlay, "wtn-cs-search")[0];
    search.value = "s";
    search.dispatch("input");
    search.value = "sk";
    search.dispatch("input");
    search.value = "skin";
    search.dispatch("input");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(queries.length, 2, "mid-debounce keystrokes must not have fired yet");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(queries.length, 3, "exactly one debounced search fires after typing settles");
    assert.equal(queries[2].query, "skin");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

// =========================================================================

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
