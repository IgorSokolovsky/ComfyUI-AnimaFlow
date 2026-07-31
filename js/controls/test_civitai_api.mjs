/**
 * test_civitai_api.mjs — regression tests for `civitai_api.mjs`'s client-
 * side fetch + cache layer: the per-kind list cache (including the "keep
 * the stale copy on a failed/errored fetch" rule), the "unknown, not
 * missing, before first load" contract for `hasFile`, `invalidateList`, the
 * still-empty-but-real `invalidateInfo` seam, and `thumbUrl`'s query-string
 * shape. Plain `node js/controls/test_civitai_api.mjs` -- stubs
 * `globalThis.fetch` rather than hitting a real server (this module has no
 * DOM dependency at all, only `fetch`).
 */

import assert from "node:assert/strict";

import {
  listModels,
  invalidateList,
  hasFile,
  cachedList,
  invalidateInfo,
  lookupInfo,
  forgetInfo,
  cachedInfo,
  cachedCategoryTag,
  thumbUrl,
  searchModels,
  startDownload,
} from "./civitai_api.mjs";

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

// =========================================================================
// hasFile -- "unknown, not missing, before first load"
// =========================================================================

test("hasFile: null (unknown) for a kind that has never been fetched", () => {
  assert.equal(hasFile("kind-never-fetched-1", "a.safetensors"), null);
});

test("hasFile: null for a missing kind/name argument, never throws", () => {
  assert.equal(hasFile(null, "a.safetensors"), null);
  assert.equal(hasFile("loras", null), null);
  assert.equal(hasFile("", ""), null);
});

// =========================================================================
// listModels / hasFile -- the real fetch + cache round trip
// =========================================================================

await asyncTest("listModels: fetches once, caches, and hasFile flips from null to a real boolean", async () => {
  const kind = "kind-a";
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return jsonResponse({ reason: "ok", models: [{ name: "a.safetensors" }, { name: "b.safetensors" }] });
  });
  try {
    assert.equal(hasFile(kind, "a.safetensors"), null); // before first load

    const models = await listModels(kind);
    assert.equal(models.length, 2);
    assert.equal(calls, 1);

    assert.equal(hasFile(kind, "a.safetensors"), true);
    assert.equal(hasFile(kind, "does-not-exist.safetensors"), false);

    // Second call -- served from cache, no second fetch.
    const again = await listModels(kind);
    assert.equal(again, models); // same cached array reference
    assert.equal(calls, 1);
  } finally {
    restoreFetch();
  }
});

await asyncTest("listModels: concurrent non-forced calls for the SAME kind de-dupe to one fetch", async () => {
  const kind = "kind-b";
  let calls = 0;
  let resolveFetch;
  const gate = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  stubFetch(async () => {
    calls += 1;
    await gate;
    return jsonResponse({ reason: "ok", models: [{ name: "x.safetensors" }] });
  });
  try {
    const p1 = listModels(kind);
    const p2 = listModels(kind);
    resolveFetch();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(calls, 1);
    assert.deepEqual(r1, r2);
  } finally {
    restoreFetch();
  }
});

await asyncTest("listModels: a network failure keeps the PREVIOUSLY cached list, never wipes it to []", async () => {
  const kind = "kind-c";
  stubFetch(async () => jsonResponse({ reason: "ok", models: [{ name: "keep-me.safetensors" }] }));
  try {
    await listModels(kind);
    assert.equal(hasFile(kind, "keep-me.safetensors"), true);
  } finally {
    restoreFetch();
  }

  stubFetch(async () => {
    throw new Error("network is down");
  });
  try {
    const models = await listModels(kind, true); // force -- must still degrade gracefully
    assert.equal(models.length, 1);
    assert.equal(models[0].name, "keep-me.safetensors");
    // The stale cache is what a caller MUST still see -- a transient failure
    // must never false-flag a row as missing.
    assert.equal(hasFile(kind, "keep-me.safetensors"), true);
  } finally {
    restoreFetch();
  }
});

await asyncTest("listModels: a non-'ok' reason (e.g. a server-side scan failure) also keeps the stale list", async () => {
  const kind = "kind-d";
  stubFetch(async () => jsonResponse({ reason: "ok", models: [{ name: "still-here.safetensors" }] }));
  try {
    await listModels(kind);
  } finally {
    restoreFetch();
  }

  stubFetch(async () => jsonResponse({ reason: "invalid_kind", models: [] }));
  try {
    const models = await listModels(kind, true);
    assert.equal(models.length, 1);
    assert.equal(models[0].name, "still-here.safetensors");
  } finally {
    restoreFetch();
  }
});

test("invalidateList: drops a single kind's cache without touching another kind's", () => {
  // Populate two kinds via the module's internal state indirectly (through
  // a prior listModels call would need an async fetch; here we only need to
  // prove invalidateList(kind) is scoped, so seed via listModels is done in
  // the async test above for kind-a/kind-c/kind-d -- this test just re-checks
  // kind-a specifically, which the first async test already populated).
  assert.equal(hasFile("kind-a", "a.safetensors"), true);
  invalidateList("kind-a");
  assert.equal(hasFile("kind-a", "a.safetensors"), null); // back to "unknown"
  // A sibling kind populated earlier must be untouched.
  assert.equal(hasFile("kind-c", "keep-me.safetensors"), true);
});

test("invalidateList: with no kind argument clears every kind's cache", () => {
  invalidateList();
  assert.equal(hasFile("kind-c", "keep-me.safetensors"), null);
  assert.equal(hasFile("kind-d", "still-here.safetensors"), null);
});

// =========================================================================
// cachedList -- the sync, no-network counterpart to listModels
// =========================================================================

test("cachedList: [] for a kind that has never resolved, or a missing kind", () => {
  assert.deepEqual(cachedList("kind-never-fetched-cl"), []);
  assert.deepEqual(cachedList(null), []);
  assert.deepEqual(cachedList(""), []);
});

await asyncTest("cachedList: the SAME array listModels already cached, with no fetch of its own", async () => {
  const kind = "kind-cl";
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return jsonResponse({ reason: "ok", models: [{ name: "a.safetensors" }] });
  });
  try {
    const fetched = await listModels(kind);
    assert.equal(calls, 1);
    assert.equal(cachedList(kind), fetched); // same reference
    assert.equal(calls, 1); // cachedList triggered NO fetch
  } finally {
    restoreFetch();
  }
});

// =========================================================================
// invalidateInfo -- a real, callable seam.
// =========================================================================

test("invalidateInfo: never throws, even for a name that was never cached", () => {
  invalidateInfo("loras", "never-cached.safetensors");
  invalidateInfo(null, null);
});

// =========================================================================
// lookupInfo / forgetInfo / cachedInfo / cachedCategoryTag -- the remote
// Civitai lookup (docs/lora-loader-design.md §2b/§7e) + its client-side,
// no-network-of-its-own read seam.
// =========================================================================

test("lookupInfo: never even calls fetch for a missing kind/name -- degrades to offline/missing_file", async () => {
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return jsonResponse({ reason: "found" });
  });
  try {
    const r1 = await lookupInfo(null, "a.safetensors");
    const r2 = await lookupInfo("loras", null);
    assert.equal(r1.reason, "offline");
    assert.equal(r1.offline_reason, "missing_file");
    assert.equal(r2.reason, "offline");
    assert.equal(calls, 0);
  } finally {
    restoreFetch();
  }
});

await asyncTest("lookupInfo: posts {kind, name, force_refresh} and caches a 'found' response", async () => {
  const kind = "loras";
  const name = "info-a.safetensors";
  let lastBody = null;
  stubFetch(async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    return jsonResponse({
      reason: "found",
      offline_reason: null,
      message: "",
      data: { name: "Skin Detail XL", base_model: "SDXL", triggers: ["detailed skin"], tags: ["character", "style"] },
      source: "civitai",
    });
  });
  try {
    const result = await lookupInfo(kind, name);
    assert.equal(lastBody.kind, kind);
    assert.equal(lastBody.name, name);
    assert.equal(lastBody.force_refresh, false);
    assert.equal(lastBody.cached_only, false, "cached_only defaults to false when not requested");
    assert.equal(result.reason, "found");
    assert.equal(cachedInfo(kind, name), result); // written to the client cache
    assert.equal(cachedCategoryTag(kind, name), "character"); // first tag
  } finally {
    restoreFetch();
  }
});

await asyncTest("lookupInfo: cachedOnly=true posts cached_only:true (docs/lora-loader-design.md §7d/decision 20)", async () => {
  const kind = "loras";
  const name = "info-cached-only.safetensors";
  let lastBody = null;
  stubFetch(async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    return jsonResponse({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null });
  });
  try {
    const result = await lookupInfo(kind, name, { cachedOnly: true });
    assert.equal(lastBody.cached_only, true);
    assert.equal(result.reason, "offline");
    assert.equal(result.offline_reason, "civitai_disabled");
  } finally {
    restoreFetch();
  }
});

await asyncTest("lookupInfo: force=true sets force_refresh AND bypasses the concurrent-call dedupe", async () => {
  const kind = "loras";
  const name = "info-b.safetensors";
  let calls = 0;
  stubFetch(async (url, opts) => {
    calls += 1;
    const body = JSON.parse(opts.body);
    return jsonResponse({ reason: "notfound", offline_reason: null, message: "", data: null, _forced: body.force_refresh });
  });
  try {
    const p1 = lookupInfo(kind, name);
    const p2 = lookupInfo(kind, name, { force: true }); // must NOT reuse p1's in-flight slot
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(calls, 2);
    assert.equal(r1.reason, "notfound");
    assert.equal(r2._forced, true);
  } finally {
    restoreFetch();
  }
});

await asyncTest("lookupInfo: concurrent NON-forced calls for the same (kind, name) de-dupe to one fetch", async () => {
  const kind = "loras";
  const name = "info-c.safetensors";
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return jsonResponse({ reason: "found", offline_reason: null, message: "", data: {} });
  });
  try {
    const [r1, r2] = await Promise.all([lookupInfo(kind, name), lookupInfo(kind, name)]);
    assert.equal(calls, 1);
    assert.deepEqual(r1, r2);
  } finally {
    restoreFetch();
  }
});

await asyncTest("lookupInfo: a thrown fetch degrades to a well-shaped offline response, never rejects", async () => {
  stubFetch(async () => {
    throw new Error("network is down");
  });
  try {
    const r = await lookupInfo("loras", "info-d.safetensors");
    assert.equal(r.reason, "offline");
    assert.equal(r.offline_reason, "unknown");
    assert.ok(typeof r.message === "string" && r.message.length > 0);
  } finally {
    restoreFetch();
  }
});

await asyncTest("lookupInfo: a response with no usable 'reason' string also degrades to offline", async () => {
  stubFetch(async () => jsonResponse({ nonsense: true }));
  try {
    const r = await lookupInfo("loras", "info-e.safetensors");
    assert.equal(r.reason, "offline");
    assert.equal(r.offline_reason, "unreadable");
  } finally {
    restoreFetch();
  }
});

await asyncTest("forgetInfo: posts {kind, name}, invalidates the client cache, and returns the route's reply", async () => {
  const kind = "loras";
  const name = "info-forget.safetensors";
  stubFetch(async () => jsonResponse({ reason: "found", offline_reason: null, message: "", data: {} }));
  try {
    await lookupInfo(kind, name);
    assert.ok(cachedInfo(kind, name));
  } finally {
    restoreFetch();
  }

  let lastBody = null;
  stubFetch(async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    return jsonResponse({ reason: "ok", deleted: true });
  });
  try {
    const result = await forgetInfo(kind, name);
    assert.equal(lastBody.kind, kind);
    assert.equal(lastBody.name, name);
    assert.equal(result.deleted, true);
    assert.equal(cachedInfo(kind, name), null); // the cache is gone too
  } finally {
    restoreFetch();
  }
});

await asyncTest("forgetInfo: a missing kind/name never calls fetch", async () => {
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return jsonResponse({ reason: "ok", deleted: false });
  });
  try {
    const r = await forgetInfo(null, "x.safetensors");
    assert.equal(r.reason, "invalid_kind");
    assert.equal(calls, 0);
  } finally {
    restoreFetch();
  }
});

test("cachedInfo/cachedCategoryTag: null for anything never looked up -- and NEVER trigger a fetch themselves", () => {
  let calls = 0;
  stubFetch(async () => {
    calls += 1;
    return jsonResponse({ reason: "found", data: {} });
  });
  try {
    assert.equal(cachedInfo("loras", "never-looked-up.safetensors"), null);
    assert.equal(cachedCategoryTag("loras", "never-looked-up.safetensors"), null);
    assert.equal(calls, 0);
  } finally {
    restoreFetch();
  }
});

await asyncTest("cachedCategoryTag: null when the cached result isn't a 'found' one, or carries no usable tags", async () => {
  const kind = "loras";
  stubFetch(async () => jsonResponse({ reason: "notfound", offline_reason: null, message: "", data: null }));
  try {
    await lookupInfo(kind, "no-tags-a.safetensors");
    assert.equal(cachedCategoryTag(kind, "no-tags-a.safetensors"), null);
  } finally {
    restoreFetch();
  }

  stubFetch(async () => jsonResponse({ reason: "found", offline_reason: null, message: "", data: { tags: ["", "  ", 42] } }));
  try {
    await lookupInfo(kind, "no-tags-b.safetensors");
    assert.equal(cachedCategoryTag(kind, "no-tags-b.safetensors"), null); // no USABLE string tag
  } finally {
    restoreFetch();
  }
});

// =========================================================================
// thumbUrl
// =========================================================================

test("thumbUrl: builds the query string with both params encoded", () => {
  assert.equal(
    thumbUrl("loras", "detail/skin xl.safetensors"),
    "/wtn/model_browser/thumb?kind=loras&name=detail%2Fskin%20xl.safetensors",
  );
});

test("thumbUrl: null for a missing kind or name", () => {
  assert.equal(thumbUrl(null, "a.safetensors"), null);
  assert.equal(thumbUrl("loras", null), null);
  assert.equal(thumbUrl("", ""), null);
});

// =========================================================================
// searchModels -- §7c-iv replaced the boolean `nsfw` request parameter with
// the numeric `level` (Civitai's own bitmask value).
// =========================================================================

await asyncTest("searchModels: sends `level` (not `nsfw`) as a plain numeric string, always -- never conditionally", async () => {
  let capturedUrl = null;
  stubFetch(async (url) => {
    capturedUrl = String(url);
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  try {
    await searchModels("loras", { level: 8 });
    const params = new URL(capturedUrl, "http://x").searchParams;
    assert.equal(params.get("level"), "8");
    assert.equal(params.get("nsfw"), null, "the old boolean parameter must never be sent");
  } finally {
    restoreFetch();
  }
});

await asyncTest("searchModels: defaults to level=1 (PG) when omitted, and degrades a garbage level to 1 rather than sending NaN", async () => {
  const captured = [];
  stubFetch(async (url) => {
    captured.push(String(url));
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  try {
    await searchModels("loras", {});
    await searchModels("loras", { level: NaN });
    await searchModels("loras", { level: "not-a-number" });
    for (const url of captured) {
      assert.equal(new URL(url, "http://x").searchParams.get("level"), "1");
    }
  } finally {
    restoreFetch();
  }
});

// =========================================================================
// startDownload -- the sidecar-seeding fields (task brief: "the whole
// sidecar feature is dead code today", `civitai_meta`/`preview_url`).
// =========================================================================

await asyncTest("startDownload: sends civitai_meta and preview_url on the wire when both are supplied", async () => {
  let capturedBody = null;
  stubFetch(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return jsonResponse({ reason: "started", message: "", job_id: "abc" });
  });
  try {
    const civitaiMeta = { model_id: 1, version_id: 2, name: "N", type: "LORA", base_model: "SDXL", tags: ["character"], triggers: ["tw"] };
    await startDownload({
      kind: "loras", subfolder: "", filename: "a.safetensors", downloadUrl: "https://civitai.com/api/download/models/2", sizeKb: 100,
      civitaiMeta, previewUrl: "https://image.civitai.com/pg.jpg",
    });
    assert.deepEqual(capturedBody.civitai_meta, civitaiMeta);
    assert.equal(capturedBody.preview_url, "https://image.civitai.com/pg.jpg");
  } finally {
    restoreFetch();
  }
});

await asyncTest("startDownload: omits civitai_meta/preview_url entirely when not supplied -- never sends a null/undefined placeholder", async () => {
  let capturedBody = null;
  stubFetch(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return jsonResponse({ reason: "started", message: "", job_id: "abc" });
  });
  try {
    await startDownload({ kind: "loras", subfolder: "", filename: "a.safetensors", downloadUrl: "https://civitai.com/api/download/models/2", sizeKb: 100 });
    assert.equal("civitai_meta" in capturedBody, false, "must OMIT the key, not send civitai_meta: null");
    assert.equal("preview_url" in capturedBody, false, "must OMIT the key when nothing passed the level -- the backend then saves no preview (specified behaviour, not a failure)");
  } finally {
    restoreFetch();
  }
});

await asyncTest("startDownload: a garbage civitaiMeta/previewUrl is dropped rather than sent as-is", async () => {
  let capturedBody = null;
  stubFetch(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return jsonResponse({ reason: "started", message: "", job_id: "abc" });
  });
  try {
    await startDownload({
      kind: "loras", subfolder: "", filename: "a.safetensors", downloadUrl: "https://civitai.com/api/download/models/2", sizeKb: 100,
      civitaiMeta: "not-an-object", previewUrl: "",
    });
    assert.equal("civitai_meta" in capturedBody, false);
    assert.equal("preview_url" in capturedBody, false);
  } finally {
    restoreFetch();
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
