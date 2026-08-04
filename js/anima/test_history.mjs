/**
 * test_history.mjs — regression tests for `history.mjs`, the generation-
 * history panel (owner-requested feature). Pure helpers first
 * (`historyImageUrl`, `formatHistoryTimestamp`, `historySettingsText`,
 * `fetchHistoryEntries`), then a DOM-level integration test of
 * `openHistoryPanel` itself, via a minimal stub DOM mirroring
 * `js/controls/test_model_info.mjs`'s own `makeDocStub` (that file's top doc
 * comment explains why each track keeps its own copy rather than sharing
 * one). Plain `node js/anima/test_history.mjs`.
 */
import assert from "node:assert/strict";

import {
  historyImageUrl,
  formatHistoryTimestamp,
  historySettingsText,
  fetchHistoryEntries,
  openHistoryPanel,
} from "./history.mjs";
import { closeActiveOverlay } from "../shared/overlay.mjs";

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
// historyImageUrl -- never a URL for an entry the server already reported expired
// =========================================================================

test("historyImageUrl: builds the /view URL for a live (non-expired) entry", () => {
  const url = historyImageUrl({ filename: "final_0.png", subfolder: "AnimaFlow", type: "output", expired: false });
  assert.equal(url, "/view?filename=final_0.png&subfolder=AnimaFlow&type=output");
});

test("historyImageUrl: null for an expired entry -- never attempts to load a file that isn't there", () => {
  assert.equal(historyImageUrl({ filename: "gone.png", subfolder: "", type: "temp", expired: true }), null);
});

test("historyImageUrl: null for garbage input", () => {
  assert.equal(historyImageUrl(null), null);
  assert.equal(historyImageUrl(undefined), null);
});

// =========================================================================
// formatHistoryTimestamp -- deterministic given an explicit `nowMs`
// =========================================================================

test("formatHistoryTimestamp: sub-5s reads 'just now'", () => {
  assert.equal(formatHistoryTimestamp(1000, 1000 * 1000 + 2000), "just now");
});

test("formatHistoryTimestamp: seconds/minutes/hours/days each pick the right unit", () => {
  const base = 1_000_000; // seconds
  assert.equal(formatHistoryTimestamp(base, (base + 30) * 1000), "30s ago");
  assert.equal(formatHistoryTimestamp(base, (base + 5 * 60) * 1000), "5m ago");
  assert.equal(formatHistoryTimestamp(base, (base + 3 * 3600) * 1000), "3h ago");
  assert.equal(formatHistoryTimestamp(base, (base + 2 * 86400) * 1000), "2d ago");
});

test("formatHistoryTimestamp: garbage input never throws, degrades to 'unknown time'", () => {
  assert.equal(formatHistoryTimestamp(null), "unknown time");
  assert.equal(formatHistoryTimestamp(undefined), "unknown time");
  assert.equal(formatHistoryTimestamp("not a number"), "unknown time");
  assert.equal(formatHistoryTimestamp(NaN), "unknown time");
});

// =========================================================================
// historySettingsText -- the honest empty state (Pattern 1b) for a recorded-
// with-nothing entry
// =========================================================================

test("historySettingsText: null/undefined settings render the explicit 'not recorded' message, never a blank box", () => {
  assert.equal(historySettingsText(null), "No generation settings were recorded for this entry.");
  assert.equal(historySettingsText(undefined), "No generation settings were recorded for this entry.");
});

test("historySettingsText: a real settings object pretty-prints as JSON", () => {
  const text = historySettingsText({ sampler: { seed: "5", steps: 32 } });
  assert.ok(text.includes('"seed": "5"'));
  assert.ok(text.includes('"steps": 32'));
});

test("historySettingsText: a value JSON.stringify can't handle degrades to a readable message, never throws", () => {
  const circular = {};
  circular.self = circular;
  assert.equal(historySettingsText(circular), "This entry's generation settings couldn't be displayed.");
});

// =========================================================================
// fetchHistoryEntries -- every failure mode degrades to a readable message,
// never throws
// =========================================================================

await asyncTest("fetchHistoryEntries: no fetch implementation at all", async () => {
  const result = await fetchHistoryEntries(undefined);
  assert.equal(result.entries, null);
  assert.match(result.error, /no fetch available/i);
});

await asyncTest("fetchHistoryEntries: the fetch call itself throws (network error)", async () => {
  const result = await fetchHistoryEntries(async () => {
    throw new Error("simulated network failure");
  });
  assert.equal(result.entries, null);
  assert.equal(result.error, "simulated network failure");
});

await asyncTest("fetchHistoryEntries: an ok:false / malformed response reports the server's own error text", async () => {
  const result = await fetchHistoryEntries(async () => ({
    ok: true, json: async () => ({ ok: false, error: "something went wrong server-side" }),
  }));
  assert.equal(result.entries, null);
  assert.equal(result.error, "something went wrong server-side");
});

await asyncTest("fetchHistoryEntries: a successful response returns the entries array", async () => {
  const entries = [{ id: 1, stage: "final" }];
  const result = await fetchHistoryEntries(async () => ({ ok: true, json: async () => ({ ok: true, entries }) }));
  assert.equal(result.error, null);
  assert.deepEqual(result.entries, entries);
});

// =========================================================================
// DOM integration -- openHistoryPanel
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
      click() {
        (e._listeners.click || []).forEach((fn) => fn({ stopPropagation() {}, preventDefault() {} }));
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

async function settle(n = 4) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const liveEntry = {
  id: 2, stage: "final", seed: "999", filename: "final_0.png", subfolder: "AnimaFlow", type: "output",
  timestamp: 1000, width: 1024, height: 1024, settings: { sampler: { seed: "999", steps: 32 } }, expired: false,
};
const expiredEntry = {
  id: 1, stage: "base", seed: "999", filename: "base_temp.png", subfolder: "", type: "temp",
  timestamp: 900, width: 512, height: 512, settings: null, expired: true,
};

await asyncTest("openHistoryPanel: renders a normal entry with a thumbnail and every action enabled", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [liveEntry] }) });
  const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
  await settle();

  const title = findAll(handle.overlay, "wtn-an-hist-title")[0];
  assert.equal(title.textContent, "Generation history");

  const rows = findAll(handle.overlay, "wtn-an-hist-row");
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].classList.contains("wtn-an-hist-row-expired"));

  const thumb = findAll(rows[0], "wtn-an-hist-thumb")[0];
  const img = thumb.children.find((c) => c.tagName === "img");
  assert.ok(img, "expected a thumbnail <img> for a live entry");
  assert.equal(img.src, "/view?filename=final_0.png&subfolder=AnimaFlow&type=output");

  const actionButtons = rows[0].children.find((c) => c.classList.contains("wtn-an-hist-body"))
    .children.find((c) => c.classList.contains("wtn-an-hist-actions")).children;
  assert.equal(actionButtons.length, 4, "Copy seed, Save it now, Settings, Open image");
  for (const btn of actionButtons) {
    assert.equal(btn.disabled, false, `${btn.textContent} must be enabled for a live entry`);
  }
  closeActiveOverlay();
});

await asyncTest("openHistoryPanel: an expired entry shows the explanation, no thumbnail image, and disables Save it now / Open image (with a reason)", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [expiredEntry] }) });
  const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
  await settle();

  const rows = findAll(handle.overlay, "wtn-an-hist-row");
  assert.equal(rows.length, 1);
  assert.ok(rows[0].classList.contains("wtn-an-hist-row-expired"));

  const thumb = findAll(rows[0], "wtn-an-hist-thumb")[0];
  assert.ok(!thumb.children.find((c) => c.tagName === "img"), "no <img> at all for an expired entry -- never a broken-image icon");
  assert.equal(thumb.title, "This file is no longer on disk -- it may have been cleaned up since this ran.");

  const note = findAll(rows[0], "wtn-an-hist-expired-note")[0];
  assert.ok(note.textContent.includes("Expired"));

  const actionButtons = rows[0].children.find((c) => c.classList.contains("wtn-an-hist-body"))
    .children.find((c) => c.classList.contains("wtn-an-hist-actions")).children;
  const byLabel = Object.fromEntries(actionButtons.map((b) => [b.textContent, b]));
  assert.equal(byLabel["Copy seed"].disabled, false, "metadata-only action stays enabled even when expired");
  assert.equal(byLabel["Settings"].disabled, false, "metadata-only action stays enabled even when expired");
  assert.equal(byLabel["Save it now"].disabled, true);
  assert.ok(byLabel["Save it now"].title.toLowerCase().includes("no longer on disk"));
  assert.equal(byLabel["Open image"].disabled, true);
  assert.ok(byLabel["Open image"].title.toLowerCase().includes("no longer on disk"));
  closeActiveOverlay();
});

await asyncTest("openHistoryPanel: an empty history reports why, by name, rather than a bare blank panel", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [] }) });
  const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
  await settle();
  const msg = findAll(handle.overlay, "wtn-an-hist-msg")[0];
  assert.equal(msg.textContent, "No generation history yet -- run the Generator with this Preview wired to start recording.");
  closeActiveOverlay();
});

await asyncTest("openHistoryPanel: a fetch failure renders the server/network's own readable error, not a silent gap", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => {
    throw new Error("simulated offline");
  };
  const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
  await settle();
  const msg = findAll(handle.overlay, "wtn-an-hist-msg")[0];
  assert.equal(msg.textContent, "simulated offline");
  assert.ok(msg.classList.contains("wtn-an-hist-msg-err"));
  closeActiveOverlay();
});

await asyncTest("openHistoryPanel: a second call with the SAME ownerKey toggles the panel closed instead of stacking a second one", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [] }) });
  const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor, ownerKey: "node-1" });
  await settle();
  assert.ok(handle);
  const second = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor, ownerKey: "node-1" });
  assert.equal(second, null, "the second call just closes the already-open panel");
});

await asyncTest("openHistoryPanel: a DIFFERENT ownerKey (a different Preview node's own History button) opens a fresh panel instead of just closing the first one -- the bug a single shared key would cause", async () => {
  const doc = makeDocStub();
  const anchorA = doc.createElement("button");
  const anchorB = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [] }) });
  const handleA = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchorA, ownerKey: "node-A" });
  await settle();
  assert.ok(handleA, "node A's panel opens");

  const handleB = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchorB, ownerKey: "node-B" });
  await settle();
  assert.ok(handleB, "node B's own click must open ITS OWN panel, not just silently close A's");
  assert.notEqual(handleB, handleA);
  // Opening B's closed A's (an unrelated overlay, `closeOverlaysNotAncestorOf`) --
  // confirmed by B's own toggle now closing cleanly on a second click.
  const second = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchorB, ownerKey: "node-B" });
  assert.equal(second, null);
});

await asyncTest("openHistoryPanel: 'Copy seed' writes the entry's seed via navigator.clipboard and reports success", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [liveEntry] }) });
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let written = null;
  // Node's own global `navigator` (present since Node 21) is a getter-only
  // property -- a plain `globalThis.navigator = ...` assignment throws.
  // `defineProperty` replaces the whole descriptor instead, restored below.
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async (text) => { written = text; } } },
    configurable: true,
  });
  try {
    const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
    await settle();
    const row = findAll(handle.overlay, "wtn-an-hist-row")[0];
    const actions = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
      .children.find((c) => c.classList.contains("wtn-an-hist-actions"));
    const copyBtn = actions.children.find((b) => b.textContent === "Copy seed");
    copyBtn._listeners.click[0]({ stopPropagation() {} });
    await settle();
    assert.equal(written, "999");
    const status = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
      .children.find((c) => c.classList.contains("wtn-an-hist-status"));
    assert.equal(status.textContent, "Seed copied.");
    closeActiveOverlay();
  } finally {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

await asyncTest("openHistoryPanel: 'Copy seed' falls back to execCommand when navigator.clipboard is absent entirely -- the actual bug (an insecure origin, e.g. plain http://, never exposes navigator.clipboard at all)", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [liveEntry] }) });
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  // No `navigator` at all -- mirrors an insecure origin exactly, unlike a
  // stub that merely omits `.clipboard` off a present navigator.
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
  const execCommandCalls = [];
  doc.execCommand = (cmd) => {
    execCommandCalls.push(cmd);
    return true;
  };
  try {
    const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
    await settle();
    const row = findAll(handle.overlay, "wtn-an-hist-row")[0];
    const actions = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
      .children.find((c) => c.classList.contains("wtn-an-hist-actions"));
    const copyBtn = actions.children.find((b) => b.textContent === "Copy seed");
    copyBtn._listeners.click[0]({ stopPropagation() {} });
    await settle();
    assert.deepEqual(execCommandCalls, ["copy"]);
    const status = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
      .children.find((c) => c.classList.contains("wtn-an-hist-status"));
    assert.equal(status.textContent, "Seed copied.");
    // The temporary textarea used to stage the selection is gone afterwards,
    // whether the copy succeeded or not.
    assert.ok(!doc.body.children.some((c) => c.tagName === "textarea"));
    closeActiveOverlay();
  } finally {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

await asyncTest("openHistoryPanel: 'Copy seed' reports the readable seed-specific failure when even the execCommand fallback can't copy", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [liveEntry] }) });
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
  doc.execCommand = () => false; // simulates a browser refusing the command
  try {
    const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
    await settle();
    const row = findAll(handle.overlay, "wtn-an-hist-row")[0];
    const actions = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
      .children.find((c) => c.classList.contains("wtn-an-hist-actions"));
    const copyBtn = actions.children.find((b) => b.textContent === "Copy seed");
    copyBtn._listeners.click[0]({ stopPropagation() {} });
    await settle();
    const status = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
      .children.find((c) => c.classList.contains("wtn-an-hist-status"));
    assert.equal(status.textContent, "Couldn't copy automatically -- the seed is 999.");
    assert.ok(status.classList.contains("wtn-an-hist-status-err"));
    assert.ok(!doc.body.children.some((c) => c.tagName === "textarea"));
    closeActiveOverlay();
  } finally {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

await asyncTest("openHistoryPanel: 'Copy seed' falls back to execCommand when writeText rejects (not just when navigator.clipboard is absent)", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [liveEntry] }) });
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => { throw new Error("simulated permission denial"); } } },
    configurable: true,
  });
  const execCommandCalls = [];
  doc.execCommand = (cmd) => {
    execCommandCalls.push(cmd);
    return true;
  };
  try {
    const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
    await settle();
    const row = findAll(handle.overlay, "wtn-an-hist-row")[0];
    const actions = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
      .children.find((c) => c.classList.contains("wtn-an-hist-actions"));
    const copyBtn = actions.children.find((b) => b.textContent === "Copy seed");
    copyBtn._listeners.click[0]({ stopPropagation() {} });
    await settle();
    assert.deepEqual(execCommandCalls, ["copy"]);
    const status = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
      .children.find((c) => c.classList.contains("wtn-an-hist-status"));
    assert.equal(status.textContent, "Seed copied.");
    closeActiveOverlay();
  } finally {
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

await asyncTest("openHistoryPanel: 'Save it now' posts a single-entry stages map (this entry's own stage/filename/subfolder/type) plus the node's preview_state and seed", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  let posted = null;
  // One `fetchImpl`, dispatching on URL -- `openHistoryPanel` itself calls
  // it once for the list (`/history`), and the row's own "Save it now"
  // button calls it again (`/save_now`) when clicked, both through this
  // SAME `ctx.fetchImpl` (never a second, separately-captured fetch).
  const combinedFetch = async (url, opts) => {
    if (String(url).includes("/history")) {
      return { ok: true, json: async () => ({ ok: true, entries: [liveEntry] }) };
    }
    posted = { url, body: JSON.parse(opts.body) };
    return { ok: true, json: async () => ({ ok: true, filename: "final_1.png", subfolder: "AnimaFlow", type: "output", stage: "final" }) };
  };
  const handle = openHistoryPanel({
    ctx: { doc, getCanvasEl: () => null, fetchImpl: combinedFetch }, anchorEl: anchor,
    previewStateJson: '{"save":{"extension":"png"}}',
  });
  await settle();
  const row = findAll(handle.overlay, "wtn-an-hist-row")[0];
  const actions = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
    .children.find((c) => c.classList.contains("wtn-an-hist-actions"));
  const saveBtn = actions.children.find((b) => b.textContent === "Save it now");
  saveBtn._listeners.click[0]();
  await settle();

  assert.equal(posted.url, "/wtn/anima/preview/save_now");
  assert.deepEqual(posted.body.stages, { final: { filename: "final_0.png", subfolder: "AnimaFlow", type: "output" } });
  assert.equal(posted.body.preview_state, '{"save":{"extension":"png"}}');
  assert.equal(posted.body.seed, "999");

  const status = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
    .children.find((c) => c.classList.contains("wtn-an-hist-status"));
  assert.equal(status.textContent, "Saved as final_1.png");
  closeActiveOverlay();
});

await asyncTest("openHistoryPanel: 'Settings' toggles an inline JSON block in place -- no second popover, honest empty state when nothing was recorded", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [liveEntry, expiredEntry] }) });
  const handle = openHistoryPanel({ ctx: { doc, getCanvasEl: () => null, fetchImpl }, anchorEl: anchor });
  await settle();
  const rows = findAll(handle.overlay, "wtn-an-hist-row");

  const liveRow = rows.find((r) => !r.classList.contains("wtn-an-hist-row-expired"));
  const liveActions = liveRow.children.find((c) => c.classList.contains("wtn-an-hist-body"))
    .children.find((c) => c.classList.contains("wtn-an-hist-actions"));
  const liveSettingsBtn = liveActions.children.find((b) => b.textContent === "Settings");
  const liveSettingsBox = liveRow.children.find((c) => c.classList.contains("wtn-an-hist-body")).children
    .find((c) => c.classList.contains("wtn-an-hist-settings"));
  assert.equal(liveSettingsBox.style.display, "none");
  liveSettingsBtn._listeners.click[0]({ stopPropagation() {} });
  assert.equal(liveSettingsBox.style.display, "");
  assert.ok(liveSettingsBox.textContent.includes('"seed": "999"'));
  liveSettingsBtn._listeners.click[0]({ stopPropagation() {} });
  assert.equal(liveSettingsBox.style.display, "none");

  const expiredRow = rows.find((r) => r.classList.contains("wtn-an-hist-row-expired"));
  const expiredActions = expiredRow.children.find((c) => c.classList.contains("wtn-an-hist-body"))
    .children.find((c) => c.classList.contains("wtn-an-hist-actions"));
  const expiredSettingsBtn = expiredActions.children.find((b) => b.textContent === "Settings");
  const expiredSettingsBox = expiredRow.children.find((c) => c.classList.contains("wtn-an-hist-body")).children
    .find((c) => c.classList.contains("wtn-an-hist-settings"));
  expiredSettingsBtn._listeners.click[0]({ stopPropagation() {} });
  assert.equal(expiredSettingsBox.textContent, "No generation settings were recorded for this entry.");
  closeActiveOverlay();
});

await asyncTest("openHistoryPanel: 'Open image' opens the entry's /view URL in a new tab for a live entry", async () => {
  const doc = makeDocStub();
  const anchor = doc.createElement("button");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, entries: [liveEntry] }) });
  let opened = null;
  const fakeWin = { open: (url, target, features) => { opened = { url, target, features }; } };
  const handle = openHistoryPanel({
    ctx: { doc, getCanvasEl: () => null, fetchImpl, getWindow: () => fakeWin }, anchorEl: anchor,
  });
  await settle();
  const row = findAll(handle.overlay, "wtn-an-hist-row")[0];
  const actions = row.children.find((c) => c.classList.contains("wtn-an-hist-body"))
    .children.find((c) => c.classList.contains("wtn-an-hist-actions"));
  const openBtn = actions.children.find((b) => b.textContent === "Open image");
  openBtn._listeners.click[0]({ stopPropagation() {} });
  assert.equal(opened.url, "/view?filename=final_0.png&subfolder=AnimaFlow&type=output");
  assert.equal(opened.target, "_blank");
  closeActiveOverlay();
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exit(1);
}
