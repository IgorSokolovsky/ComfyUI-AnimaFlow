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
  resolveVersionView,
  resultCardState,
  resultBaseModel,
  resultSubtitle,
  gatedSubtitle,
  subfolderFromDestinationField,
  searchReasonMessage,
  downloadStartMessage,
  downloadTerminalMessage,
  appendDedupedResults,
  markResultGated,
  apiKeySignature,
  reconcileGatedKeysOnApiKeySignature,
  subscribeDownloadState,
  getActiveDownloadState,
  startDownloadJob,
  cancelActiveDownloadJob,
  _resetDownloadStateForTests,
  computeSearchPanelMaxHeight,
  MIN_RESULTS_HEIGHT_PX,
  PANEL_ANCHOR_GAP_PX,
  PANEL_VIEWPORT_MARGIN_PX,
  SCROLL_LOAD_MORE_THRESHOLD_PX,
  injectStyles,
  openCivitaiSearch,
} from "./civitai_search.mjs";
import { invalidateList, hasFile, listModels } from "./civitai_api.mjs";
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

test("resultCardState: BUG F -- a session-known-gated key overrides the up-front (wrong) 'gated: false' guess", () => {
  const result = { model_id: 7, primary_version_id: 8, installed: false, gated: false };
  const sessionGatedKeys = new Set([resultKey(result)]);
  assert.equal(resultCardState(result, null, sessionGatedKeys), "gated");
});

test("resultCardState: BUG F -- installed still wins over a session-known-gated flag (the file DID end up on disk)", () => {
  const result = { model_id: 7, primary_version_id: 8, installed: true, gated: false };
  const sessionGatedKeys = new Set([resultKey(result)]);
  assert.equal(resultCardState(result, null, sessionGatedKeys), "installed");
});

test("resultCardState: BUG F -- an in-flight download still wins over a session-known-gated flag (a retry after adding a key)", () => {
  const result = { model_id: 7, primary_version_id: 8, installed: false, gated: false };
  const job = { key: resultKey(result) };
  const sessionGatedKeys = new Set([resultKey(result)]);
  assert.equal(resultCardState(result, job, sessionGatedKeys), "downloading");
});

test("resultCardState: BUG F -- a session-gated set that doesn't contain this key changes nothing", () => {
  const result = { model_id: 1, primary_version_id: 2, installed: false, gated: false };
  const sessionGatedKeys = new Set(["9:9"]);
  assert.equal(resultCardState(result, null, sessionGatedKeys), "available");
});

test("resultCardState: a garbage/missing sessionGatedKeys argument is tolerated (backward compatible, never throws)", () => {
  const result = { model_id: 1, primary_version_id: 2, installed: false, gated: true };
  assert.equal(resultCardState(result, null, undefined), "gated");
  assert.equal(resultCardState(result, null, null), "gated");
  assert.equal(resultCardState(result, null, "not a set"), "gated");
});

// =========================================================================
// appendDedupedResults -- BUG G's pagination dedupe.
// =========================================================================

test("appendDedupedResults: dedupes on resultKey -- a page can legitimately repeat an entry across pages", () => {
  const a = { model_id: 1, primary_version_id: 1, name: "A" };
  const b = { model_id: 2, primary_version_id: 2, name: "B" };
  const bAgain = { model_id: 2, primary_version_id: 2, name: "B (repeated on page 2)" };
  const c = { model_id: 3, primary_version_id: 3, name: "C" };
  const out = appendDedupedResults([a, b], [bAgain, c]);
  assert.deepEqual(out.map((r) => r.name), ["A", "B", "C"], "the FIRST-seen entry for a key wins; a later repeat is skipped, a genuinely new one is appended");
});

test("appendDedupedResults: never mutates either input array", () => {
  const existing = [{ model_id: 1, primary_version_id: 1, name: "A" }];
  const incoming = [{ model_id: 2, primary_version_id: 2, name: "B" }];
  const existingLengthBefore = existing.length;
  const incomingLengthBefore = incoming.length;
  const out = appendDedupedResults(existing, incoming);
  assert.equal(existing.length, existingLengthBefore);
  assert.equal(incoming.length, incomingLengthBefore);
  assert.equal(out.length, 2);
});

test("appendDedupedResults: garbage/non-array input on either side degrades to the other side rather than throwing", () => {
  const b = { model_id: 2, primary_version_id: 2, name: "B" };
  assert.deepEqual(appendDedupedResults(null, [b]).map((r) => r.name), ["B"]);
  assert.deepEqual(appendDedupedResults([b], null).map((r) => r.name), ["B"]);
  assert.deepEqual(appendDedupedResults(null, null), []);
  assert.deepEqual(appendDedupedResults(undefined, undefined), []);
});

test("resultSubtitle: just the compact download count -- the base model moved to its own chip (owner, 2026-07-30)", () => {
  assert.equal(resultSubtitle({ base_model: "SDXL", stats: { downloads: 12400 } }), "12.4k ↓");
  assert.equal(resultSubtitle({ base_model: "", stats: { downloads: 0 } }), "0 ↓");
  assert.equal(resultSubtitle({ stats: {} }), "0 ↓");
});

test("resultSubtitle: a missing result never throws", () => {
  assert.equal(resultSubtitle(null), "");
});

test("resultBaseModel: the base model, standalone (feeds the chip, never the subtitle)", () => {
  assert.equal(resultBaseModel({ base_model: "SDXL 1.0" }), "SDXL 1.0");
});

test("resultBaseModel: '' when genuinely absent -- never a placeholder like 'Unknown' (§1a-vi)", () => {
  assert.equal(resultBaseModel({ base_model: "" }), "");
  assert.equal(resultBaseModel({ base_model: "   " }), "");
  assert.equal(resultBaseModel({}), "");
  assert.equal(resultBaseModel(null), "");
});

test("gatedSubtitle: always the bare line -- no base model, no separator (it now lives in the same chip every other card state uses)", () => {
  assert.equal(gatedSubtitle(), "needs an API key");
});

// =========================================================================
// resolveVersionView -- the version-picker's own pure core (docs task
// 2026-07-31).
// =========================================================================

function makeMultiVersionResult() {
  return {
    model_id: 100,
    name: "Multi Version LoRA",
    stats: { downloads: 5, favorites: 0, rating: null },
    // Top-level convenience fields flattened from versions[0] (the shape
    // `api.py`'s `_annotate_search_results` produces) -- present so a test
    // can prove `resolveVersionView` picks the SELECTED version's own copy
    // of these, not the top-level (primary-only) ones, once a non-primary
    // version is chosen.
    base_model: "SDXL",
    primary_version_id: 1,
    file_name: "primary.safetensors",
    download_url: "https://civitai.com/primary",
    size_kb: 111,
    gated: false,
    installed: false,
    triggers: ["from-primary"],
    preview_url: "https://image.civitai.com/primary.jpg",
    thumb_url: "https://image.civitai.com/width=256/primary.jpg",
    versions: [
      {
        version_id: 1, name: "v1.0", base_model: "SDXL",
        file_name: "primary.safetensors", download_url: "https://civitai.com/primary",
        size_kb: 111, gated: false, installed: false,
        triggers: ["from-primary"], preview_url: "https://image.civitai.com/primary.jpg",
        thumb_url: "https://image.civitai.com/width=256/primary.jpg",
      },
      {
        version_id: 2, name: "v2.0 (Pony)", base_model: "Pony",
        file_name: "second.safetensors", download_url: "https://civitai.com/second",
        size_kb: 222, gated: true, installed: true,
        triggers: ["from-second"], preview_url: "https://image.civitai.com/second.jpg",
        thumb_url: "https://image.civitai.com/width=256/second.jpg",
      },
      {
        // A version with NO downloadable file at all -- `pick_primary_file`
        // was `None` server-side.
        version_id: 3, name: "v3.0 (no file)", base_model: "SD 1.5",
        file_name: null, download_url: null, size_kb: null,
        gated: false, installed: false, triggers: [], preview_url: null, thumb_url: null,
      },
    ],
  };
}

test("resolveVersionView: the FOUND case -- a selected non-primary version's own fields win, primary_version_id follows the selection", () => {
  const result = makeMultiVersionResult();
  const view = resolveVersionView(result, 2);
  assert.equal(view.file_name, "second.safetensors");
  assert.equal(view.download_url, "https://civitai.com/second");
  assert.equal(view.size_kb, 222);
  assert.equal(view.gated, true);
  assert.equal(view.installed, true);
  assert.equal(view.base_model, "Pony");
  assert.equal(view.thumb_url, "https://image.civitai.com/width=256/second.jpg");
  assert.deepEqual(view.triggers, ["from-second"]);
  assert.equal(view.preview_url, "https://image.civitai.com/second.jpg");
  assert.equal(view.primary_version_id, 2, "resultKey must follow the SELECTED version, not result's own primary");
  // Fields the version doesn't carry (name, stats, model_id) pass through
  // from the raw result unchanged.
  assert.equal(view.name, "Multi Version LoRA");
  assert.equal(view.model_id, 100);
});

test("resolveVersionView: an UNKNOWN selected id falls back to versions[0] (including the common 'nothing picked yet' -- undefined)", () => {
  const result = makeMultiVersionResult();
  const viewUndefined = resolveVersionView(result, undefined);
  assert.equal(viewUndefined.primary_version_id, 1);
  assert.equal(viewUndefined.file_name, "primary.safetensors");

  const viewUnknown = resolveVersionView(result, 999);
  assert.equal(viewUnknown.primary_version_id, 1);
  assert.equal(viewUnknown.file_name, "primary.safetensors");
});

test("resolveVersionView: NO versions (missing/non-array/empty) returns the result UNCHANGED -- a flat legacy/test-fixture result keeps working", () => {
  const flat = { model_id: 1, primary_version_id: 1, name: "Flat", file_name: "a.safetensors" };
  assert.equal(resolveVersionView(flat, 1), flat, "no versions key at all -- the exact same object, not a copy");

  const withNullVersions = { ...flat, versions: null };
  assert.equal(resolveVersionView(withNullVersions, 1), withNullVersions);

  const withEmptyVersions = { ...flat, versions: [] };
  assert.equal(resolveVersionView(withEmptyVersions, 1), withEmptyVersions);

  const withGarbageVersions = { ...flat, versions: "not-an-array" };
  assert.equal(resolveVersionView(withGarbageVersions, 1), withGarbageVersions);
});

test("resolveVersionView: a garbage/missing result never throws", () => {
  assert.equal(resolveVersionView(null, 1), null);
  assert.equal(resolveVersionView(undefined, 1), undefined);
});

test("resolveVersionView: a selected version whose pick_primary_file was None -- file_name/download_url are null, never invented", () => {
  const result = makeMultiVersionResult();
  const view = resolveVersionView(result, 3);
  assert.equal(view.file_name, null);
  assert.equal(view.download_url, null);
  assert.equal(view.size_kb, null);
  assert.equal(view.primary_version_id, 3);
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
// BUG E -- an installed card (no action at all) must never show a hover
// state. There is no CSSOM in a plain-`node` test, so this asserts against
// the injected `<style>` tag's own textContent -- the same technique any
// pure-JS suite has for a CSS-only behaviour.
// =========================================================================

test("BUG E: the CSS defines an explicit .wtn-cs-action-installed:hover override (never the generic .wtn-cs-action:hover accent)", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  assert.ok(styleEl, "injectStyles must append a <style> tag to <head>");
  assert.match(
    styleEl.textContent,
    /\.wtn-cs-action-installed:hover\s*\{\s*background:\s*transparent;?\s*\}/,
    "an explicit hover override must neutralise the generic .wtn-cs-action:hover accent background for the installed badge",
  );
});

test("BUG (owner, 2026-07-30): the CSS defines an explicit .wtn-cs-action-gated:hover override -- the gated 'key required' badge is disabled and must never light up on hover", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  assert.ok(styleEl, "injectStyles must append a <style> tag to <head>");
  assert.match(
    styleEl.textContent,
    /\.wtn-cs-action-gated:hover\s*\{\s*background:\s*transparent;?\s*\}/,
    "an explicit hover override must neutralise the generic .wtn-cs-action:hover accent background for the disabled gated badge",
  );
});

// =========================================================================
// apiKeySignature / reconcileGatedKeysOnApiKeySignature -- the "un-gate on
// key change" fix (owner, 2026-07-30): "i entered key but it still say key
// required (and i cant redownload it)".
// =========================================================================

test("apiKeySignature: same string -> same signature; a different string (even same length) -> a different signature; never returns the key itself", () => {
  const a = apiKeySignature("sk-aaaaaaaa");
  const b = apiKeySignature("sk-aaaaaaaa");
  const c = apiKeySignature("sk-bbbbbbbb"); // same length, different value
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.doesNotMatch(a, /sk-a/, "the signature must never contain the raw key");
  assert.doesNotMatch(c, /sk-b/, "the signature must never contain the raw key");
});

test("apiKeySignature: garbage/missing input degrades to the empty-string signature, never throws", () => {
  assert.equal(apiKeySignature(""), apiKeySignature(undefined));
  assert.equal(apiKeySignature(""), apiKeySignature(null));
});

test("reconcileGatedKeysOnApiKeySignature: THE REPORTED BUG -- learned-gated with no key, then the key setting becomes non-empty, clears the set", () => {
  _resetDownloadStateForTests();
  const gated = new Set(["1:1"]);
  // First check ever establishes the baseline (no key) -- must not clear.
  reconcileGatedKeysOnApiKeySignature(apiKeySignature(""), gated);
  assert.ok(gated.has("1:1"), "nothing changed yet -- the baseline check alone must not clear a real learned-gated entry");
  // The user adds a key -- this is the reported case.
  reconcileGatedKeysOnApiKeySignature(apiKeySignature("sk-real-key"), gated);
  assert.equal(gated.size, 0, "adding an API key must clear the learned-gated set (this is the bug being fixed)");
});

test("reconcileGatedKeysOnApiKeySignature: a result learned-gated stays gated while the key setting is unchanged", () => {
  _resetDownloadStateForTests();
  const gated = new Set(["1:1"]);
  reconcileGatedKeysOnApiKeySignature(apiKeySignature(""), gated);
  reconcileGatedKeysOnApiKeySignature(apiKeySignature(""), gated); // same value again
  assert.ok(gated.has("1:1"), "the key setting never moved -- a real learned-gated entry must survive");
});

test("reconcileGatedKeysOnApiKeySignature: changing the key from one non-empty value to a DIFFERENT one also clears it", () => {
  _resetDownloadStateForTests();
  const gated = new Set(["1:1"]);
  reconcileGatedKeysOnApiKeySignature(apiKeySignature("sk-old-key"), gated);
  assert.ok(gated.has("1:1"));
  reconcileGatedKeysOnApiKeySignature(apiKeySignature("sk-new-key"), gated);
  assert.equal(gated.size, 0, "swapping to a different key is also a change that must clear the stale learning");
});

test("reconcileGatedKeysOnApiKeySignature: clearing the key (non-empty -> empty) does not throw and clears the learned set (treated the same as any other change)", () => {
  _resetDownloadStateForTests();
  const gated = new Set(["1:1"]);
  reconcileGatedKeysOnApiKeySignature(apiKeySignature("sk-had-one"), gated);
  assert.ok(gated.has("1:1"));
  assert.doesNotThrow(() => reconcileGatedKeysOnApiKeySignature(apiKeySignature(""), gated));
  assert.equal(gated.size, 0, "removing the key is still a signature change -- the stale learning is cleared, not resurrected");
});

test("reconcileGatedKeysOnApiKeySignature: a garbage/missing sessionGatedKeys argument is tolerated, never throws", () => {
  _resetDownloadStateForTests();
  assert.doesNotThrow(() => reconcileGatedKeysOnApiKeySignature(apiKeySignature("x"), undefined));
  assert.doesNotThrow(() => reconcileGatedKeysOnApiKeySignature(apiKeySignature("y"), null));
  assert.doesNotThrow(() => reconcileGatedKeysOnApiKeySignature(apiKeySignature("z"), "not a set"));
});

test("resultCardState: the server's own gated:true (early access) is honoured regardless of the API key -- reconciling the key never weakens it", () => {
  _resetDownloadStateForTests();
  const gatedKeys = new Set(); // deliberately NOT session-learned -- this is the up-front server flag path
  reconcileGatedKeysOnApiKeySignature(apiKeySignature(""), gatedKeys);
  reconcileGatedKeysOnApiKeySignature(apiKeySignature("sk-now-has-a-key"), gatedKeys); // a key change, elsewhere clears session learning
  const result = { model_id: 9, primary_version_id: 9, installed: false, gated: true };
  assert.equal(resultCardState(result, null, gatedKeys), "gated", "the server's own early-access flag must still gate the card even after a key change reconciled session-learned entries");
});

// =========================================================================
// computeSearchPanelMaxHeight -- BUG A: computed from the space actually
// available BELOW the anchor, never a fixed vh/px constant.
// =========================================================================

test("computeSearchPanelMaxHeight: plenty of room below the anchor -- the available space, not a fixed cap", () => {
  // A 100px-tall header sits near the TOP of an 800px-tall viewport --
  // anchorBottom=140 leaves 800-140-gap-margin of headroom below it.
  const maxH = computeSearchPanelMaxHeight({ anchorBottom: 140, viewportHeight: 800, chromeHeight: 150 });
  assert.equal(maxH, 800 - 140 - PANEL_ANCHOR_GAP_PX - PANEL_VIEWPORT_MARGIN_PX);
});

test("computeSearchPanelMaxHeight: an anchor near the BOTTOM edge still reserves the results floor (never a sliver)", () => {
  // Only 40px below the anchor before the viewport ends -- far less than
  // even the chrome alone, let alone chrome + a usable results area.
  const maxH = computeSearchPanelMaxHeight({ anchorBottom: 760, viewportHeight: 800, chromeHeight: 200 });
  assert.equal(maxH, 200 + MIN_RESULTS_HEIGHT_PX, "floors to chromeHeight + MIN_RESULTS_HEIGHT_PX rather than the (smaller) available space");
  assert.ok(maxH > 800 - 760, "this floor deliberately exceeds the true available space -- overlay.mjs's own flip is what handles that, not this function");
});

test("computeSearchPanelMaxHeight: garbage/missing chromeHeight degrades to 0 rather than throwing or going negative", () => {
  const maxH = computeSearchPanelMaxHeight({ anchorBottom: 100, viewportHeight: 800, chromeHeight: null });
  assert.equal(maxH, Math.max(MIN_RESULTS_HEIGHT_PX, 800 - 100 - PANEL_ANCHOR_GAP_PX - PANEL_VIEWPORT_MARGIN_PX));
});

test("computeSearchPanelMaxHeight: null when no real viewport size is available -- caller keeps its CSS fallback untouched", () => {
  assert.equal(computeSearchPanelMaxHeight({ anchorBottom: 100, viewportHeight: null, chromeHeight: 100 }), null);
  assert.equal(computeSearchPanelMaxHeight({ anchorBottom: null, viewportHeight: 800, chromeHeight: 100 }), null);
  assert.equal(computeSearchPanelMaxHeight({ anchorBottom: 100, viewportHeight: 0, chromeHeight: 100 }), null);
  assert.equal(computeSearchPanelMaxHeight({ anchorBottom: NaN, viewportHeight: 800, chromeHeight: 100 }), null);
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
      // BUG G's infinite-scroll trigger reads these three off `.wtn-cs-
      // scroll` -- a plain stub has no real layout engine, so a test drives
      // "near the bottom" by setting these directly before dispatching a
      // "scroll" event.
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
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

function makeResult({ modelId, versionId, name, installed = false, gated = false, baseModel = "SDXL", downloads = 0, thumbUrl } = {}) {
  const result = {
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
  if (thumbUrl !== undefined) {
    result.thumb_url = thumbUrl;
  }
  return result;
}

/** A multi-version result shaped exactly like `api.py`'s `_annotate_search_
 * results` output -- every version carries its own `file_name`/
 * `download_url`/`size_kb`/`gated`/`installed`/`thumb_url`. */
function makeMultiVersionSearchResult({ modelId, name = "Multi Version" } = {}) {
  return {
    model_id: modelId,
    name,
    creator: "someone",
    tags: [],
    nsfw: false,
    stats: { downloads: 10, favorites: 0, rating: null },
    base_model: "SDXL",
    primary_version_id: 1,
    file_name: "v1.safetensors",
    download_url: "https://civitai.com/v1",
    size_kb: 100,
    gated: false,
    installed: false,
    thumb_url: "https://image.civitai.com/width=256/v1.jpg",
    versions: [
      {
        version_id: 1, name: "v1.0", base_model: "SDXL",
        file_name: "v1.safetensors", download_url: "https://civitai.com/v1",
        size_kb: 100, gated: false, installed: false,
        thumb_url: "https://image.civitai.com/width=256/v1.jpg",
      },
      {
        version_id: 2, name: "v2.0", base_model: "Pony",
        file_name: "v2.safetensors", download_url: "https://civitai.com/v2",
        size_kb: 200, gated: false, installed: true,
        thumb_url: "https://image.civitai.com/width=256/v2.jpg",
      },
    ],
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

await asyncTest("openCivitaiSearch: the base model renders as its own chip, omitted when unknown, and never duplicated in the subtitle", async () => {
  _resetDownloadStateForTests();
  const results = [
    makeResult({ modelId: 10, versionId: 10, name: "Has Base Model", baseModel: "SDXL 1.0", downloads: 12400 }),
    makeResult({ modelId: 11, versionId: 11, name: "No Base Model", baseModel: "", downloads: 5 }),
  ];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const cards = findAll(handle.overlay, "wtn-cs-card");
    assert.equal(cards.length, 2);

    const chips = findAll(handle.overlay, "wtn-chip--accent");
    assert.equal(chips.length, 1, "only the result WITH a known base model gets a chip");
    assert.equal(chips[0].textContent, "SDXL 1.0");

    const subs = findAll(handle.overlay, "wtn-cs-sub");
    for (const sub of subs) {
      assert.doesNotMatch(sub.textContent, /SDXL/, "the subtitle must never duplicate the base model the chip already shows");
    }
    assert.match(textOf(cards[0]), /12\.4k ↓/);
    assert.match(textOf(cards[1]), /5 ↓/);

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

await asyncTest("openCivitaiSearch: BUG F -- a key_required download failure flips THAT card to gated (amber, no Download button), and it survives a brand-new search/panel this session", async () => {
  _resetDownloadStateForTests();
  // Deliberately `gated: false` -- the up-front guess (Civitai's own
  // `earlyAccessEndsAt`) got this one wrong; the download itself is what
  // will discover the truth.
  const result = makeResult({ modelId: 77, versionId: 88, name: "Early Access LoRA", gated: false });
  let searchCalls = 0;
  let progressCalls = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      searchCalls += 1;
      return jsonResponse({ reason: "ok", message: "", results: [result], next_cursor: null, public_only: false });
    }
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-key-req" });
    }
    if (u.includes("/download/progress")) {
      progressCalls += 1;
      if (progressCalls === 1) {
        return jsonResponse({ reason: "ok", status: "downloading", bytes: 10, total: 100, message: "" });
      }
      return jsonResponse({ reason: "ok", status: "key_required", bytes: 10, total: 100, message: "" });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras", pollIntervalMs: 10 });
    await settle();
    const downloadBtn = findAll(handle.overlay, "wtn-cs-action").find((e) => e.textContent === "↓ Download");
    assert.ok(downloadBtn, "the card must start as plain 'available' -- the up-front guess said gated: false");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 60)); // let the (test-shortened) poll loop reach the terminal key_required

    assert.equal(findAll(handle.overlay, "wtn-cs-action-gated").length, 1, "the card must flip to gated once the download itself reports key_required");
    assert.equal(
      findAll(handle.overlay, "wtn-cs-action").filter((e) => e.textContent === "↓ Download").length,
      0,
      "no Download button must remain on a card that just failed with key_required (this is the bug being fixed)",
    );

    // A brand-new panel + a REPEAT search against the SAME server response
    // (gated: false, the up-front guess never changes on its own) must still
    // render this result gated -- the client learned better from the real
    // failure, session-wide, not just for this one already-open panel.
    searchCalls = 0;
    handle.close();
    const doc2 = makeDocStub();
    const anchor2 = doc2.createElement("button");
    const handle2 = openCivitaiSearch({ ctx: { doc: doc2, getCanvasEl: () => null }, anchorEl: anchor2, kind: "loras" });
    await settle();
    assert.equal(searchCalls, 1);
    assert.equal(findAll(handle2.overlay, "wtn-cs-action-gated").length, 1, "the session-learned gated state survives a brand-new panel/search, not just a re-render of the same one");
    assert.equal(findAll(handle2.overlay, "wtn-cs-action").filter((e) => e.textContent === "↓ Download").length, 0);
    handle2.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: THE REPORTED BUG -- learned-gated with no key, then entering an API key un-gates the card and offers a download again on the next search", async () => {
  _resetDownloadStateForTests();
  let progressCalls = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      // A FRESH result object every fetch -- exactly like a real server
      // round-trip, which never sees this client's own earlier in-memory
      // mutation (`onDownloadStateChange`'s `finishedResult.gated = true`,
      // below) -- reusing the SAME object across calls would make a later
      // search "still gated" for the wrong reason (a stale local mutation)
      // rather than the one this test exists to prove (`_sessionGatedKeys`).
      return jsonResponse({
        reason: "ok", message: "",
        results: [makeResult({ modelId: 55, versionId: 66, name: "Needs A Key", gated: false })],
        next_cursor: null, public_only: false,
      });
    }
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-key-req-2" });
    }
    if (u.includes("/download/progress")) {
      progressCalls += 1;
      if (progressCalls === 1) {
        return jsonResponse({ reason: "ok", status: "downloading", bytes: 10, total: 100, message: "" });
      }
      return jsonResponse({ reason: "ok", status: "key_required", bytes: 10, total: 100, message: "" });
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
    await new Promise((resolve) => setTimeout(resolve, 60)); // let the poll loop reach the terminal key_required

    assert.equal(findAll(handle.overlay, "wtn-cs-action-gated").length, 1, "the card must be learned-gated after the key_required failure -- the premise this whole test exercises");

    // The owner's own words: "i entered key but it still say key required
    // (and i cant redownload it)" -- simulate exactly that: no page reload,
    // just the API key setting now holding a real value.
    globalThis.window = { app: { extensionManager: { setting: { get: (id) => (id === SETTING_IDS.CIVITAI_API_KEY ? "sk-the-users-real-key" : undefined) } } } };
    try {
      // A brand-new search against the SAME (still gated:false) server
      // response is the natural re-check point (`runSearch`'s own top).
      const search = findAll(handle.overlay, "wtn-cs-search")[0];
      search.value = "needs";
      search.dispatch("input");
      await new Promise((resolve) => setTimeout(resolve, 450)); // clear the debounce timer
      await settle();

      assert.equal(
        findAll(handle.overlay, "wtn-cs-action-gated").length,
        0,
        "adding the API key must un-gate the card -- this is the reported bug",
      );
      assert.equal(
        findAll(handle.overlay, "wtn-cs-action").filter((e) => e.textContent === "↓ Download").length,
        1,
        "the card must offer a Download button again once un-gated -- the reported 'and i cant redownload it' half of the bug",
      );
    } finally {
      delete globalThis.window;
    }
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

await asyncTest("openCivitaiSearch: only .wtn-cs-scroll wraps the results list -- search field, filters and destination stay in .wtn-cs-pinned", async () => {
  _resetDownloadStateForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const pinned = findAll(handle.overlay, "wtn-cs-pinned")[0];
    assert.ok(pinned, "a pinned (non-scrolling) region must exist");
    assert.equal(findAll(pinned, "wtn-cs-search").length, 1, "the search field is pinned");
    assert.equal(findAll(pinned, "wtn-cs-filters").length, 1, "the filter pills are pinned");
    assert.equal(findAll(pinned, "wtn-cs-dest").length, 1, "the destination field is pinned");

    const scrollArea = findAll(handle.overlay, "wtn-cs-scroll")[0];
    assert.ok(scrollArea, "a scrolling results region must exist");
    assert.equal(findAll(scrollArea, "wtn-cs-list").length, 1, "the results list lives inside the scroll area");
    assert.equal(findAll(pinned, "wtn-cs-list").length, 0, "the results list must NOT be inside the pinned region");

    const allHints = findAll(handle.overlay, "wtn-cs-hint");
    const footerHint = allHints.find((e) => e.textContent.includes("Downloads run server-side"));
    assert.ok(footerHint, "the footer hint must exist");
    assert.ok(!scrollArea.contains(footerHint), "the footer hint stays pinned below the scroll area, not inside it");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

// ---------------------------------------------------------------------------
// Side + height are ONE decision now, owned by `overlay.mjs`'s own
// `reposition()` (owner-reported bug, 2026-07-30: sizing the panel to fit
// BELOW the anchor first silently decided the side, so a search panel opened
// low on screen never got the chance to flip ABOVE, the way the ⚙ settings
// dialog already does). This stub's `getBoundingClientRect()` returns a
// fixed `_rect` regardless of style (mirrors every sibling doc stub in this
// pack), so a test that wants to control what `reposition()` measures as the
// panel's OWN natural height overrides `panel._rect` directly, then fires
// the SAME window-resize listener `openCivitaiSearch` already registers to
// force a fresh recompute against it.
// ---------------------------------------------------------------------------

await asyncTest("openCivitaiSearch: a real computed pixel max-height only when the (real, natural) content actually needs one, recomputes on window resize, and the listener is removed on close", async () => {
  _resetDownloadStateForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const panel = findAll(handle.overlay, "wtn-cs-panel")[0];
    const listenersBeforeClose = doc.defaultView._listeners.resize.length;
    assert.ok(listenersBeforeClose >= 1, "opening the panel must register its own resize listener");

    // Real content taller than the room actually available below the
    // default (near-top) anchor at the stub's 800px viewport height (742px)
    // -- forces a genuine cap, rather than staying naturally uncapped the
    // way a short result list would (that case is covered by the "flips
    // above" test below).
    panel._rect = { left: 10, top: 10, right: 356, bottom: 1010, width: 346, height: 1000 };
    doc.defaultView._listeners.resize.forEach((fn) => fn());
    const initialMaxHeight = panel.style.maxHeight;
    assert.match(initialMaxHeight, /^\d+px$/, "a real computed pixel max-height, not the CSS 76vh fallback string");

    // Shrink the viewport -- the panel's own max-height must shrink to match.
    doc.defaultView.innerHeight = 300;
    doc.defaultView._listeners.resize.forEach((fn) => fn());
    assert.notEqual(panel.style.maxHeight, initialMaxHeight, "resizing the window must recompute the max-height");
    const shrunkPx = Number(panel.style.maxHeight.replace("px", ""));
    assert.ok(shrunkPx < Number(initialMaxHeight.replace("px", "")), "a smaller viewport must yield a smaller computed max-height");

    handle.close();
    assert.equal(doc.defaultView._listeners.resize.length, listenersBeforeClose - 1, "closing the panel must remove its own resize listener");
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: an anchor pinned near the bottom edge FLIPS ABOVE, uncapped, when the panel's real content fits there (THE reported bug)", async () => {
  _resetDownloadStateForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    // Anchor sits almost at the bottom of an 800px viewport -- almost no
    // room below it at all, plenty of room above.
    anchor._rect = { left: 10, top: 770, right: 240, bottom: 790, width: 230, height: 20 };
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    const panel = findAll(handle.overlay, "wtn-cs-panel")[0];
    // The panel's own real content height -- taller than a sliver, but still
    // comfortably shorter than the room ABOVE this low anchor.
    panel._rect = { left: 10, top: 10, right: 356, bottom: 310, width: 346, height: 300 };
    doc.defaultView._listeners.resize.forEach((fn) => fn());
    assert.equal(panel.style.maxHeight, "", "fits above uncapped -- must NOT be squashed to whatever sliver was left below (the reported bug)");
    assert.equal(handle.overlay.style.top, "464px", "770(anchor top) - 300(natural height) - 6(gap)");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: neither side has room for the real content -- capped to whichever side has MORE room, never below the results floor", async () => {
  _resetDownloadStateForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    // An unusually tall anchor straddling most of the viewport -- both above
    // and below it have LESS room (100px / 182px) than the results floor
    // (head+pinned+footerHint's own default 30px each, +MIN_RESULTS_HEIGHT_PX
    // = 210px).
    anchor._rect = { left: 10, top: 200, right: 240, bottom: 682, width: 230, height: 482 };
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    const panel = findAll(handle.overlay, "wtn-cs-panel")[0];
    panel._rect = { left: 10, top: 10, right: 356, bottom: 1010, width: 346, height: 1000 };
    doc.defaultView._listeners.resize.forEach((fn) => fn());
    assert.equal(panel.style.maxHeight, "210px", "floored to the results area's own minimum, not the smaller raw available room (182px above)");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

// =========================================================================
// BUG G -- infinite scroll: scrolling near the bottom of .wtn-cs-scroll
// fetches the next page via `next_cursor`, appends (never replaces, deduped
// on a stable key), stops when `next_cursor` is null/absent, never runs two
// page-fetches at once, and resets cleanly on a new search/filter change.
// =========================================================================

await asyncTest("openCivitaiSearch: BUG G -- scrolling near the bottom appends the next page (deduped), and stops once next_cursor is null", async () => {
  _resetDownloadStateForTests();
  const page1 = [
    makeResult({ modelId: 1, versionId: 1, name: "One" }),
    makeResult({ modelId: 2, versionId: 2, name: "Two" }),
  ];
  const page2 = [
    makeResult({ modelId: 2, versionId: 2, name: "Two (repeated by Civitai on page 2)" }),
    makeResult({ modelId: 3, versionId: 3, name: "Three" }),
  ];
  const cursorsRequested = [];
  stubFetch(async (url) => {
    const u = new URL(String(url), "http://x");
    const cursor = u.searchParams.get("cursor") || "";
    cursorsRequested.push(cursor);
    if (!cursor) {
      return jsonResponse({ reason: "ok", message: "", results: page1, next_cursor: "cursor-2", public_only: false });
    }
    if (cursor === "cursor-2") {
      return jsonResponse({ reason: "ok", message: "", results: page2, next_cursor: null, public_only: false });
    }
    throw new Error(`unexpected cursor: ${cursor}`);
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    assert.equal(cursorsRequested.length, 1, "the initial search fires with no cursor");
    assert.equal(findAll(handle.overlay, "wtn-cs-card").length, 2);

    const scrollArea = findAll(handle.overlay, "wtn-cs-scroll")[0];
    scrollArea.scrollHeight = 500;
    scrollArea.clientHeight = 200;
    scrollArea.scrollTop = 500 - 200 - (SCROLL_LOAD_MORE_THRESHOLD_PX - 10); // just inside the trigger threshold
    scrollArea.dispatch("scroll");
    await settle();

    assert.equal(cursorsRequested.length, 2, "scrolling near the bottom fetches the next page");
    assert.equal(cursorsRequested[1], "cursor-2", "the second page's request carries the FIRST page's own next_cursor");
    const cardsAfterPage2 = findAll(handle.overlay, "wtn-cs-card");
    assert.equal(cardsAfterPage2.length, 3, "appended, never replaced -- and the entry repeated across pages is deduped, not doubled");
    assert.equal(cardsAfterPage2.filter((c) => textOf(c).includes("Two")).length, 1, "the model repeated on page 2 renders exactly once");
    assert.ok(textOf(handle.overlay).includes("One"), "page one's own results survive the append");

    // next_cursor is now null -- scrolling again must not fire a further request.
    scrollArea.dispatch("scroll");
    await settle();
    assert.equal(cursorsRequested.length, 2, "no further request once next_cursor is null/absent");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: BUG G -- a scroll well above the threshold does nothing; only one page-fetch runs at a time even with a burst of scroll events", async () => {
  _resetDownloadStateForTests();
  let searchCalls = 0;
  let resolveSecondPage;
  stubFetch(async (url) => {
    const u = new URL(String(url), "http://x");
    const cursor = u.searchParams.get("cursor") || "";
    searchCalls += 1;
    if (!cursor) {
      return jsonResponse({ reason: "ok", message: "", results: [makeResult({ modelId: 1, versionId: 1, name: "One" })], next_cursor: "cursor-2", public_only: false });
    }
    // The second page's own fetch hangs until the test releases it -- a
    // burst of scroll events while it's in flight must not fire a second
    // request (task brief: "one request in flight at a time").
    return new Promise((resolve) => {
      resolveSecondPage = () => resolve(jsonResponse({
        reason: "ok", message: "", results: [makeResult({ modelId: 2, versionId: 2, name: "Two" })], next_cursor: null, public_only: false,
      }));
    });
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    assert.equal(searchCalls, 1);

    const scrollArea = findAll(handle.overlay, "wtn-cs-scroll")[0];
    scrollArea.scrollHeight = 1000;
    scrollArea.clientHeight = 200;
    scrollArea.scrollTop = 0; // far from the bottom -- 800px remaining, well past the threshold
    scrollArea.dispatch("scroll");
    await settle();
    assert.equal(searchCalls, 1, "a scroll far from the bottom must never fetch a page");

    scrollArea.scrollTop = 1000 - 200 - (SCROLL_LOAD_MORE_THRESHOLD_PX - 10); // now inside the threshold
    scrollArea.dispatch("scroll");
    scrollArea.dispatch("scroll");
    scrollArea.dispatch("scroll");
    await settle();
    assert.equal(searchCalls, 2, "a burst of scroll events while a page-fetch is in flight must only ever start ONE request");
    assert.equal(findAll(handle.overlay, "wtn-cs-loading-more").length, 1, "a loading affordance shows while the next page is in flight");

    resolveSecondPage();
    await settle();
    assert.equal(findAll(handle.overlay, "wtn-cs-loading-more").length, 0, "the loading affordance clears once the page resolves");
    assert.equal(findAll(handle.overlay, "wtn-cs-card").length, 2);

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: BUG G -- changing a filter resets paging; a stale cursor from the old query never leaks onto the new one", async () => {
  _resetDownloadStateForTests();
  const queries = [];
  stubFetch(async (url) => {
    const u = new URL(String(url), "http://x");
    queries.push({ cursor: u.searchParams.get("cursor") || "", sort: u.searchParams.get("sort") || "" });
    if (queries.length === 1) {
      return jsonResponse({ reason: "ok", message: "", results: [makeResult({ modelId: 1, versionId: 1, name: "One" })], next_cursor: "cursor-2", public_only: false });
    }
    return jsonResponse({ reason: "ok", message: "", results: [makeResult({ modelId: 9, versionId: 9, name: "Nine" })], next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    assert.equal(queries.length, 1);
    assert.equal(queries[0].cursor, "");

    const selects = [];
    const walk = (e) => {
      if (e.tagName === "select") {
        selects.push(e);
      }
      (e.children || []).forEach(walk);
    };
    walk(handle.overlay);
    const sortSel = selects[1];
    sortSel.value = "Newest";
    sortSel.dispatch("change", { stopPropagation() {} });
    await settle();

    assert.equal(queries.length, 2, "changing the filter re-searches");
    assert.equal(queries[1].cursor, "", "the new query must NOT carry the previous query's next_cursor");

    // The results list itself must be the NEW query's alone -- the old
    // query's results must not still be sitting there with the new one
    // appended onto them.
    const cards = findAll(handle.overlay, "wtn-cs-card");
    assert.equal(cards.length, 1);
    assert.match(textOf(cards[0]), /Nine/);

    // And a scroll that would have paged the OLD query must now be a no-op
    // (there is no next_cursor for the new, single-result query).
    const scrollArea = findAll(handle.overlay, "wtn-cs-scroll")[0];
    scrollArea.scrollHeight = 500;
    scrollArea.clientHeight = 200;
    scrollArea.scrollTop = 500 - 200 - (SCROLL_LOAD_MORE_THRESHOLD_PX - 10);
    scrollArea.dispatch("scroll");
    await settle();
    assert.equal(queries.length, 2, "no stale-cursor page fetch fires after a filter change");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: BUG G -- rate_limited on a page-two fetch is calm and never wipes the already-rendered first page", async () => {
  _resetDownloadStateForTests();
  stubFetch(async (url) => {
    const u = new URL(String(url), "http://x");
    const cursor = u.searchParams.get("cursor") || "";
    if (!cursor) {
      return jsonResponse({ reason: "ok", message: "", results: [makeResult({ modelId: 1, versionId: 1, name: "One" })], next_cursor: "cursor-2", public_only: false });
    }
    return jsonResponse({ reason: "rate_limited", message: "Searching too quickly", results: [], next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const scrollArea = findAll(handle.overlay, "wtn-cs-scroll")[0];
    scrollArea.scrollHeight = 500;
    scrollArea.clientHeight = 200;
    scrollArea.scrollTop = 500 - 200 - (SCROLL_LOAD_MORE_THRESHOLD_PX - 10);
    scrollArea.dispatch("scroll");
    await settle();

    assert.equal(findAll(handle.overlay, "wtn-cs-card").length, 1, "a page-two failure must not wipe the already-rendered first page");
    assert.equal(findAll(handle.overlay, "wtn-cs-bad").length, 0, "rate_limited stays calm on page two too -- never the error colour");
    assert.equal(findAll(handle.overlay, "wtn-cs-info").length, 1);
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: BUG G -- closing the panel removes its own scroll listener (no leaked handler on a since-discarded node)", async () => {
  _resetDownloadStateForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [makeResult({ modelId: 1, versionId: 1, name: "One" })], next_cursor: "cursor-2", public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    const scrollArea = findAll(handle.overlay, "wtn-cs-scroll")[0];
    assert.ok((scrollArea._listeners.scroll || []).length >= 1, "opening the panel must register its own scroll listener");
    handle.close();
    assert.equal((scrollArea._listeners.scroll || []).length, 0, "closing the panel must remove its own scroll listener");
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

// =========================================================================
// Thumbnails + the version picker (docs task 2026-07-31).
// =========================================================================

await asyncTest("openCivitaiSearch: a result with a thumb_url renders an <img>; one with none renders the placeholder", async () => {
  _resetDownloadStateForTests();
  const results = [
    makeResult({ modelId: 1, versionId: 1, name: "Has Thumb", thumbUrl: "https://image.civitai.com/width=256/x.jpg" }),
    makeResult({ modelId: 2, versionId: 2, name: "No Thumb" }),
  ];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const imgs = findAllByTag(handle.overlay, "img");
    assert.equal(imgs.length, 1, "only the result WITH a thumb_url renders an <img>");
    assert.equal(imgs[0].src, "https://image.civitai.com/width=256/x.jpg");
    assert.equal(imgs[0].loading, "lazy");
    assert.equal(imgs[0].referrerPolicy, "no-referrer");
    assert.equal(imgs[0].alt, "");

    const placeholders = findAll(handle.overlay, "wtn-cs-thumb-ph");
    assert.equal(placeholders.length, 1, "the result with no thumb_url gets the neutral placeholder");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: a thumbnail <img> that fails to load swaps in the placeholder, never a broken-image icon", async () => {
  _resetDownloadStateForTests();
  const results = [makeResult({ modelId: 1, versionId: 1, name: "Junk Thumb", thumbUrl: "https://image.civitai.com/404.jpg" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const img = findAllByTag(handle.overlay, "img")[0];
    assert.ok(img, "the <img> must be present before it errors");
    assert.equal(findAll(handle.overlay, "wtn-cs-thumb-ph").length, 0, "no placeholder yet -- the image hasn't failed");

    img.onerror();
    assert.equal(findAllByTag(handle.overlay, "img").length, 0, "the broken <img> must be removed");
    assert.equal(findAll(handle.overlay, "wtn-cs-thumb-ph").length, 1, "the placeholder takes its place");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: a GATED card keeps the padlock and shows no thumbnail even when thumb_url is present", async () => {
  _resetDownloadStateForTests();
  const results = [makeResult({ modelId: 1, versionId: 1, name: "Gated With Thumb", gated: true, thumbUrl: "https://image.civitai.com/width=256/x.jpg" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    assert.equal(findAllByTag(handle.overlay, "img").length, 0, "a gated card must never render the thumbnail image");
    assert.equal(findAll(handle.overlay, "wtn-cs-thumb-gated").length, 1, "the padlock must still render");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: the version <select> appears ONLY for a multi-version result, never for a single-version one", async () => {
  _resetDownloadStateForTests();
  const results = [
    makeMultiVersionSearchResult({ modelId: 1, name: "Multi" }),
    makeResult({ modelId: 2, versionId: 20, name: "Single" }),
  ];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const versionSelects = findAll(handle.overlay, "wtn-cs-version-sel");
    assert.equal(versionSelects.length, 1, "exactly one card (the multi-version one) gets a version <select>");

    const options = versionSelects[0].children.filter((c) => c.tagName === "option");
    assert.equal(options.length, 2);
    assert.equal(options[0].textContent, "v1.0");
    assert.equal(options[1].textContent, "v2.0");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: a version with no name falls back to '#<version_id>' as its option label", async () => {
  _resetDownloadStateForTests();
  const result = makeMultiVersionSearchResult({ modelId: 5 });
  result.versions[1].name = "";
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [result], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();
    const versionSelect = findAll(handle.overlay, "wtn-cs-version-sel")[0];
    const options = versionSelect.children.filter((c) => c.tagName === "option");
    assert.equal(options[1].textContent, "#2");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: switching versions flips the card to installed (and back), never disturbs a different card's in-flight job, and stopPropagation guards the select", async () => {
  _resetDownloadStateForTests();
  const multi = makeMultiVersionSearchResult({ modelId: 1, name: "Multi" });
  const other = makeResult({ modelId: 9, versionId: 90, name: "Other" });
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      return jsonResponse({ reason: "ok", message: "", results: [multi, other], next_cursor: null, public_only: false });
    }
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-other" });
    }
    // Keep the OTHER card's job parked on "downloading" throughout.
    return jsonResponse({ reason: "ok", status: "downloading", bytes: 1, total: 100, message: "" });
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras", pollIntervalMs: 10000 });
    await settle();

    // Start the OTHER card's download first.
    const cards = findAll(handle.overlay, "wtn-cs-card");
    const otherCard = cards.find((c) => textOf(c).includes("Other"));
    const otherDownloadBtn = findAll(otherCard, "wtn-cs-action").find((e) => e.textContent === "↓ Download");
    otherDownloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.ok(findAll(handle.overlay, "wtn-cs-action-cancel").length >= 1, "the other card's job must be in flight");

    // Initially version v1.0 (not installed) is selected on the multi card.
    const multiCardBefore = findAll(handle.overlay, "wtn-cs-card").find((c) => textOf(c).includes("Multi"));
    assert.ok(findAll(multiCardBefore, "wtn-cs-action").some((e) => e.textContent === "↓ Download"), "v1.0 starts as available");

    const versionSelect = findAll(handle.overlay, "wtn-cs-version-sel")[0];
    let clickPropagated = false;
    versionSelect.dispatch("click", { stopPropagation: () => { clickPropagated = true; } });
    assert.ok(clickPropagated, "the version select must stopPropagation on click (litegraph gesture guard)");

    versionSelect.value = "2";
    versionSelect.dispatch("change", { stopPropagation() {} });
    await settle();

    // Switched to v2.0, which is installed=true in the fixture.
    const multiCardAfter = findAll(handle.overlay, "wtn-cs-card").find((c) => textOf(c).includes("Multi"));
    assert.equal(findAll(multiCardAfter, "wtn-cs-action-installed").length, 1, "switching to an installed version flips the card to installed");

    // The OTHER card's job must be completely undisturbed by the switch.
    assert.ok(findAll(handle.overlay, "wtn-cs-action-cancel").length >= 1, "the other card's in-flight job must still be running");

    // Switch back to v1.0 -- flips back to available.
    const versionSelectAfter = findAll(handle.overlay, "wtn-cs-version-sel")[0];
    versionSelectAfter.value = "1";
    versionSelectAfter.dispatch("change", { stopPropagation() {} });
    await settle();
    const multiCardFinal = findAll(handle.overlay, "wtn-cs-card").find((c) => textOf(c).includes("Multi"));
    assert.ok(findAll(multiCardFinal, "wtn-cs-action").some((e) => e.textContent === "↓ Download"), "switching back to v1.0 restores the available state");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: switching THIS SAME card's own dropdown away from the version currently downloading keeps the job visible+cancelable via the banner (regression, 2026-07-31), and switching back resumes the inline display", async () => {
  _resetDownloadStateForTests();
  const multi = makeMultiVersionSearchResult({ modelId: 5, name: "Same Card Switch" });
  // Neither version installed -- isolates this regression from the
  // switch-to-an-installed-version behaviour the test above already covers.
  multi.versions[1].installed = false;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      return jsonResponse({ reason: "ok", message: "", results: [multi], next_cursor: null, public_only: false });
    }
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-same-card" });
    }
    // Keep the job parked on "downloading" throughout -- this regression is
    // about the DISPLAY, not the job's own lifecycle.
    return jsonResponse({ reason: "ok", status: "downloading", bytes: 1, total: 100, message: "" });
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras", pollIntervalMs: 10000 });
    await settle();

    // Start v1 (the card's primary/selected version) downloading.
    const downloadBtn = findAll(handle.overlay, "wtn-cs-action").find((e) => e.textContent === "↓ Download");
    assert.ok(downloadBtn, "v1 must start as available");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.ok(findAll(handle.overlay, "wtn-cs-action-cancel").length >= 1, "the card itself must show downloading+cancel for v1");
    assert.equal(findAll(handle.overlay, "wtn-cs-active").length, 0, "no banner needed while the downloading version is the one displayed");

    // Switch THIS SAME card's dropdown to v2, mid-flight -- the regression
    // under test.
    const versionSelect = findAll(handle.overlay, "wtn-cs-version-sel")[0];
    versionSelect.value = "2";
    versionSelect.dispatch("change", { stopPropagation() {} });
    await settle();

    // The card no longer displays v1's progress (it's showing v2 now), but
    // the job itself must still be visible and cancelable -- via the
    // persistent banner.
    const activeRows = findAll(handle.overlay, "wtn-cs-active");
    assert.equal(activeRows.length, 1, "the banner must appear once the card stops displaying the in-flight version");
    assert.ok(findAll(activeRows[0], "wtn-cs-action-cancel").length >= 1, "the banner must still offer a way to cancel");

    // Switch back to v1 -- the card resumes showing it inline, and the
    // banner steps aside again.
    const versionSelectAfter = findAll(handle.overlay, "wtn-cs-version-sel")[0];
    versionSelectAfter.value = "1";
    versionSelectAfter.dispatch("change", { stopPropagation() {} });
    await settle();

    assert.equal(findAll(handle.overlay, "wtn-cs-active").length, 0, "the banner must step aside once the card resumes showing the job inline");
    assert.ok(findAll(handle.overlay, "wtn-cs-action-cancel").length >= 1, "the card itself must show the downloading state (with cancel) again for v1");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: a selected version with no downloadable file disables Download and shows a readable reason, never firing filename: null", async () => {
  _resetDownloadStateForTests();
  const result = makeMultiVersionSearchResult({ modelId: 3, name: "No File Version" });
  result.versions.push({
    version_id: 3, name: "v3.0 (broken)", base_model: "SD 1.5",
    file_name: null, download_url: null, size_kb: null,
    gated: false, installed: false, thumb_url: null,
  });
  let startCalls = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      return jsonResponse({ reason: "ok", message: "", results: [result], next_cursor: null, public_only: false });
    }
    if (u.includes("/download/start")) {
      startCalls += 1;
      return jsonResponse({ reason: "started", message: "", job_id: "job-x" });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const versionSelect = findAll(handle.overlay, "wtn-cs-version-sel")[0];
    versionSelect.value = "3";
    versionSelect.dispatch("change", { stopPropagation() {} });
    await settle();

    const card = findAll(handle.overlay, "wtn-cs-card")[0];
    const downloadBtn = findAll(card, "wtn-cs-action").find((e) => e.textContent === "↓ Download");
    assert.ok(downloadBtn, "a Download button still renders, just disabled");
    assert.equal(downloadBtn.disabled, true);
    assert.match(textOf(card), /No downloadable file for this version/);

    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.equal(startCalls, 0, "clicking a disabled/no-file Download must never fire /download/start");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: the version <select> and the card's action element are siblings in the same right-hand action column, select first, and the metarow no longer holds it (owner, 2026-07-31: 'version should be above the download button')", async () => {
  _resetDownloadStateForTests();
  const results = [makeMultiVersionSearchResult({ modelId: 40, name: "Column Test" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras" });
    await settle();

    const versionSelect = findAll(handle.overlay, "wtn-cs-version-sel")[0];
    const downloadBtn = findAll(handle.overlay, "wtn-cs-action").find((e) => e.textContent === "↓ Download");
    assert.ok(versionSelect, "the multi-version card must render a version select");
    assert.ok(downloadBtn, "the multi-version card must render its own action element (Download, in this default state)");

    const col = versionSelect.parentNode;
    assert.equal(col.className, "wtn-cs-actioncol", "the version select must live in the new right-hand action column, not the metarow");
    assert.equal(downloadBtn.parentNode, col, "the select and the action element must be siblings in that same column");
    assert.equal(col.children.indexOf(versionSelect), 0, "the version select must come first, above the action element");
    assert.equal(col.children.indexOf(downloadBtn), 1, "the action element must be the very next (and only other) child, stacked below the select");

    // Confirms the move actually happened, not just that a NEW column
    // happens to exist alongside the old placement.
    const metarow = findAll(handle.overlay, "wtn-cs-metarow")[0];
    assert.equal(findAll(metarow, "wtn-cs-version-sel").length, 0, "the metarow must no longer hold the version select");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
  }
});

await asyncTest("openCivitaiSearch: the downloading state's %+Cancel pair renders as one row inside the same action column, stacked below the version select", async () => {
  _resetDownloadStateForTests();
  const result = makeMultiVersionSearchResult({ modelId: 41, name: "Downloading Column" });
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/search")) {
      return jsonResponse({ reason: "ok", message: "", results: [result], next_cursor: null, public_only: false });
    }
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-column" });
    }
    return jsonResponse({ reason: "ok", status: "downloading", bytes: 10, total: 100, message: "" });
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openCivitaiSearch({ ctx: { doc, getCanvasEl: () => null }, anchorEl: anchor, kind: "loras", pollIntervalMs: 10000 });
    await settle();

    const downloadBtn = findAll(handle.overlay, "wtn-cs-action").find((e) => e.textContent === "↓ Download");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    const versionSelect = findAll(handle.overlay, "wtn-cs-version-sel")[0];
    const cancelBtn = findAll(handle.overlay, "wtn-cs-action-cancel")[0];
    assert.ok(versionSelect, "the select must still render while this card's own version is downloading");
    assert.ok(cancelBtn, "this card's own Cancel must render (its own job, not the module-level persistent banner)");

    const col = versionSelect.parentNode;
    assert.equal(col.className, "wtn-cs-actioncol");
    const row = cancelBtn.parentNode;
    assert.equal(row.className, "wtn-cs-actioncol-row", "the %+Cancel pair must be wrapped in its own row, not two loose siblings");
    assert.equal(row.parentNode, col, "that row must itself be a child of the same action column as the select");
    assert.equal(col.children.indexOf(versionSelect), 0, "the select comes first");
    assert.equal(col.children.indexOf(row), 1, "the %+Cancel row is stacked directly below it");

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
