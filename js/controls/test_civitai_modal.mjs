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
  downloadKindChoices,
  resolveDownloadKind,
  addFilterValue,
  removeFilterValue,
  parseStoredList,
  serializeList,
  injectModalStyles,
  openCivitaiModal,
  _resetModalForTests,
  INSTALLED_KIND_ORDER,
  INSTALLED_KIND_LABELS,
  sortInstalledModels,
  installedSections,
} from "./civitai_modal.mjs";
import { _resetDownloadStateForTests, sessionGatedKeys, injectStyles as injectSearchStyles, queryFromModelName } from "./civitai_search.mjs";
import { invalidateModelDetail, invalidateList, thumbUrl } from "./civitai_api.mjs";
import { SETTING_IDS } from "../shared/settings.mjs";

// `js/shared/theme.css`'s raw text -- the shared `.wtn-select` height fix
// (2026-08-01) lives THERE, not in this module's own injected CSS, so a
// cross-file read is the only way to pin it.
const themeCss = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "shared", "theme.css"),
  "utf8",
);

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
  // Fixed 2026-08-05 -- `DEFAULT_ROOT_DISPLAY.unet` used to say
  // "models/unet" (never the real folder -- `kinds.KIND_TO_FOLDER["unet"]`
  // is `diffusion_models`), harmless while `unet` was never a chosen
  // destination but a visible lie the moment it becomes one (the download-
  // kind selector, below).
  assert.equal(destinationLabelForKind("unet"), "→ models/diffusion_models/");
});

test("destinationLabelForKind: empty for a falsy kind (never rendered anyway)", () => {
  assert.equal(destinationLabelForKind(null), "");
  assert.equal(destinationLabelForKind(""), "");
});

test("destinationLabelForKind: an unmapped-but-truthy kind still produces a plausible label rather than throwing", () => {
  assert.equal(destinationLabelForKind("future_kind"), "→ models/future_kind/");
});

// =========================================================================
// downloadKindChoices / resolveDownloadKind -- the Checkpoint/UNet
// ambiguity's per-download override (docs/lora-loader-design.md's own
// "no reliable API field" subsection).
// =========================================================================

test("downloadKindChoices: offers both checkpoints and unet, symmetrically, for EITHER derived kind", () => {
  assert.deepEqual(downloadKindChoices("checkpoints"), ["checkpoints", "unet"]);
  assert.deepEqual(downloadKindChoices("unet"), ["checkpoints", "unet"]);
});

test("downloadKindChoices: null for a loras result, or any falsy/unmapped kind -- no ambiguity there", () => {
  assert.equal(downloadKindChoices("loras"), null);
  assert.equal(downloadKindChoices(null), null);
  assert.equal(downloadKindChoices(""), null);
  assert.equal(downloadKindChoices("future_kind"), null);
});

test("resolveDownloadKind: with nothing chosen yet, the derived kind is the default", () => {
  assert.equal(resolveDownloadKind("checkpoints", null), "checkpoints");
  assert.equal(resolveDownloadKind("unet", null), "unet");
  assert.equal(resolveDownloadKind("loras", null), "loras");
});

test("resolveDownloadKind: an explicit choice among THIS result's own offered choices wins", () => {
  assert.equal(resolveDownloadKind("checkpoints", "unet"), "unet");
  assert.equal(resolveDownloadKind("unet", "checkpoints"), "checkpoints");
});

test("resolveDownloadKind: a chosen kind that isn't one of this result's own choices falls back to the derived kind (e.g. a stale choice from a DIFFERENT result)", () => {
  assert.equal(resolveDownloadKind("checkpoints", "loras"), "checkpoints");
  assert.equal(resolveDownloadKind("loras", "unet"), "loras"); // loras has no choices at all -- always itself
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
// Owner-reported, with a screenshot (2026-08-01): "the select field in the
// browser modal preview height should be lower -- same height as the
// download button" -- the modal GRID CARD's own version select
// (.wtn-cm-version-sel, distinct from the topbar test above) read visibly
// taller than the `↓ Download` button beneath it.
// =========================================================================

test("BUG (owner, with a screenshot, 2026-08-01): the modal grid card's version select and its Download button resolve to the SAME height, read from the ONE shared rule each depends on -- not two hand-tuned numbers happening to agree", () => {
  const modalSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "civitai_modal.mjs"),
    "utf8",
  );

  // The select's own per-surface rule must declare no height of its own --
  // it inherits one, from `.wtn-select`, via the OTHER class the element
  // carries (`buildCard`'s own "wtn-select wtn-cm-version-sel").
  const cardSelRule = modalSrc.match(/\.wtn-cm-version-sel\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(
    cardSelRule,
    /height:/,
    ".wtn-cm-version-sel must not declare its own height -- that is exactly the per-surface duplicate this bug came from",
  );

  // The Download button's own base rule (unscoped -- NOT the .wtn-dv-topbar
  // override, which is a different mount) must declare an explicit height,
  // for the same reason `civitai_search.mjs`'s own `.wtn-cs-action` does --
  // a native <button>'s box does not size the same way a native <select>'s
  // does from equal padding, so nothing can be "confirmed equal" unless both
  // sides are pinned numbers rather than assumed-close ones.
  const cardActionRule = modalSrc.match(/(?<!\.wtn-dv-topbar )\.wtn-cm-action\s*\{([^}]*)\}/)[1];
  const actionHeightMatch = cardActionRule.match(/height:\s*(\d+)px/);
  assert.ok(actionHeightMatch, "the base .wtn-cm-action rule must pin an explicit height, not leave it to content/line-height");

  const sharedSelRule = themeCss.match(/\.wtn-select\s*\{([^}]*)\}/)[1];
  const selHeightMatch = sharedSelRule.match(/height:\s*(\d+)px/);
  assert.ok(selHeightMatch, "the shared .wtn-select base (js/shared/theme.css) must pin the height every select in the track inherits");

  assert.equal(
    selHeightMatch[1],
    actionHeightMatch[1],
    "the modal card's select (via the shared .wtn-select base) and its Download button must resolve to the identical height",
  );
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
    // `style.setProperty` -- real DOM elements have it; a plain `{}` doesn't.
    // Needed now that `model_detail_view.mjs`'s `buildModelDetailView` (this
    // file's own detail-view mount) sets the gallery's own tile width as a
    // CSS custom property rather than a per-call inline class.
    const style = {};
    style.setProperty = function setProperty(name, val) {
      style[name] = val;
    };
    const e = {
      tagName: tag,
      _listeners: {},
      children: [],
      style,
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
        // Real DOM's two-arg `toggle(name, force)` -- `setActiveTab`'s own
        // tab-active bookkeeping uses it (mirrors `lora_render.mjs`'s/
        // `render.mjs`'s own unguarded `classList.toggle` call sites).
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

await asyncTest("owner-reported (2026-08-01): 'remove the -> models/checkpoints/ caption' -- a NON-AMBIGUOUS (loras) grid card renders NO destination line at all (repeated on every card it was noise; the destination is already stated by the 'Save to:' field elsewhere)", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  // `kind: "loras"` specifically -- 2026-08-05 gave a `checkpoints`/`unet`
  // card its own actionable selector (below), which ALSO carries the
  // `wtn-cm-dest` class, so this must stay scoped to the one kind that has
  // no ambiguity to resolve, or it would assert against the new feature.
  const results = [makeResult({ modelId: 1, versionId: 1, name: "Lands Somewhere", kind: "loras" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    assert.equal(findAll(handle.scrim, "wtn-cm-dest").length, 0, "a loras card must never render a destination caption or selector");
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

await asyncTest("2026-08-05 (follow-up to a973001): a checkpoints-derived GRID CARD (not just the detail view) renders the Checkpoint/UNet destination selector above its Download button, defaulting to the derived kind and driving what /download/start actually receives", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 80, versionId: 1, name: "Ambiguous On The Card", kind: "checkpoints", type: "Checkpoint" })];
  let startedKind = null;
  stubFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes("/download/start")) {
      startedKind = JSON.parse(opts.body).kind;
      return jsonResponse({ reason: "started", message: "", job_id: "job-80" });
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

    const card = findAll(handle.scrim, "wtn-cm-card")[0];
    const sel = findAll(card, "wtn-cm-dest-select")[0];
    assert.ok(sel, "an ambiguous grid card must render the destination selector");
    assert.equal(sel.value, "checkpoints", "defaults to the DERIVED kind");
    // "above the Download button" -- DOM order controls read order in this
    // pack's own flex-column action columns (`buildDetailAction`'s own doc
    // comment makes the identical point for the detail view).
    const actionCol = sel.parentNode;
    const btn = findAll(actionCol, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    assert.ok(actionCol.children.indexOf(sel) < actionCol.children.indexOf(btn), "the selector must sit ABOVE the Download button");

    sel.value = "unet";
    sel.dispatch("change", { stopPropagation() {} });
    await settle();

    const cardAfter = findAll(handle.scrim, "wtn-cm-card")[0];
    const selAfter = findAll(cardAfter, "wtn-cm-dest-select")[0];
    assert.equal(selAfter.value, "unet", "the card's own choice is retained across its re-render");

    const downloadBtn = findAll(cardAfter, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.equal(startedKind, "unet", "/download/start must carry the CARD's chosen kind, not the original derived one");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("2026-08-05: a unet-derived grid card ALSO renders the selector (symmetric), defaulting to unet", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 81, versionId: 1, name: "Ambiguous UNet On The Card", kind: "unet", type: "UNet" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    const card = findAll(handle.scrim, "wtn-cm-card")[0];
    const sel = findAll(card, "wtn-cm-dest-select")[0];
    assert.ok(sel, "a unet-derived grid card must ALSO render the destination selector");
    assert.equal(sel.value, "unet", "defaults to the DERIVED kind");
    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("2026-08-05: choosing UNet on the grid card, then opening that model's detail view, keeps the choice -- it does not silently revert to the derived kind", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 82, versionId: 1, name: "Reconciled", kind: "checkpoints", type: "Checkpoint" })];
  invalidateModelDetail(82, 1);
  let startedKind = null;
  stubFetch(async (url, opts) => {
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
      startedKind = JSON.parse(opts.body).kind;
      return jsonResponse({ reason: "started", message: "", job_id: "job-82" });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const card = findAll(handle.scrim, "wtn-cm-card")[0];
    const cardSel = findAll(card, "wtn-cm-dest-select")[0];
    cardSel.value = "unet";
    cardSel.dispatch("change", { stopPropagation() {} });
    await settle();

    // Open the detail view -- via the re-rendered card's own body, NOT its
    // selector (which stopPropagation's its own click).
    findAll(handle.scrim, "wtn-cm-card")[0].dispatch("click", { stopPropagation() {} });
    await settle();

    const detailHostEl = findAll(handle.panel, "wtn-cm-detailhost")[0];
    const detailSel = findAll(detailHostEl, "wtn-cm-dest-select")[0];
    assert.equal(detailSel.value, "unet", "opening the detail view must carry the CARD's own choice forward, not reset to the derived kind");

    const downloadBtn = findAll(detailHostEl, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.equal(startedKind, "unet", "downloading from the detail view must still target the reconciled (card-chosen) kind");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("2026-08-05: a fresh search clears the grid card's own destination choice -- it is per-download, never a stored preference", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 83, versionId: 1, name: "Not Sticky Card", kind: "checkpoints", type: "Checkpoint" })];
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    let card = findAll(handle.scrim, "wtn-cm-card")[0];
    let sel = findAll(card, "wtn-cm-dest-select")[0];
    sel.value = "unet";
    sel.dispatch("change", { stopPropagation() {} });
    await settle();
    card = findAll(handle.scrim, "wtn-cm-card")[0];
    sel = findAll(card, "wtn-cm-dest-select")[0];
    assert.equal(sel.value, "unet");

    // Re-run the SAME search (Search button -- a resetCursor:true search),
    // and the SAME model_id reappears (the stub always returns the same
    // `results`) -- its own choice must not have carried over.
    // `.wtn-cm-search-btn` specifically -- NOT a plain textContent match on
    // "Search": the head's own Search/Installed TAB button carries the
    // identical label, and a `button` tag-scan would find that one first.
    const searchBtn = findAll(handle.panel, "wtn-cm-search-btn")[0];
    searchBtn.disabled = false; // same text as before is normally disabled -- force it for this test
    searchBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    card = findAll(handle.scrim, "wtn-cm-card")[0];
    sel = findAll(card, "wtn-cm-dest-select")[0];
    assert.equal(sel.value, "checkpoints", "a fresh search must reset the card's own choice back to the derived kind");

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

await asyncTest("openCivitaiModal: D4 -- no header subtitle badge; the head shows the Search/Installed tabs instead of a bare title", async () => {
  // The Installed tab (docs/lora-loader-design.md "Installed-by-kind
  // section") replaced the old bare "Browse Civitai" title with the tab
  // pair itself -- this test now pins THAT shape rather than the title text
  // it superseded.
  _resetDownloadStateForTests();
  _resetModalForTests();
  stubFetch(async () => jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false }));
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    assert.equal(findAll(handle.scrim, "wtn-cm-badge").length, 0, "the subtitle badge element must be gone entirely");
    const tabs = findAll(handle.scrim, "wtn-cm-tab");
    const tabLabels = tabs.map((t) => t.textContent);
    assert.ok(tabLabels.includes("Search"), "the Search tab renders");
    assert.ok(tabLabels.includes("Installed"), "the Installed tab renders");
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
    // Scoped to the SEARCH rail specifically (`findAll(..., "wtn-cm-rail")[0]`
    // -- the search rail is built, and appended to `body`, before the
    // Installed tab's own rail) -- the Installed tab now contributes two
    // MORE `.wtn-cm-rail-heading` elements of its own ("Kind"/"Sort"), which
    // this test must not count: it is pinning the SEARCH rail's own five
    // sections, unaffected by anything Installed adds alongside it.
    const searchRail = findAll(handle.scrim, "wtn-cm-rail")[0];
    const headings = findAll(searchRail, "wtn-cm-rail-heading");
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
    assert.ok(stripImg, "the modal's own mount renders the (now single-shape) gallery filmstrip");
    assert.equal(stripImg.style["--wtn-dv-gallery-tile"], "200px", "the modal's own default tile width, wider than the picker's ~115px");

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

await asyncTest("openCivitaiModal: a checkpoints-derived result's detail view renders the Checkpoint/UNet selector, defaulting to checkpoints, and NOT a plain static caption", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 70, versionId: 1, name: "Ambiguous Checkpoint", kind: "checkpoints", type: "Checkpoint" })];
  invalidateModelDetail(70, 1);
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
    findAll(handle.scrim, "wtn-cm-card")[0].dispatch("click", { stopPropagation() {} });
    await settle();

    const sel = findAll(handle.panel, "wtn-cm-dest-select")[0];
    assert.ok(sel, "a checkpoints-derived result must render the destination SELECTOR");
    assert.equal(sel.tagName, "select");
    assert.equal(sel.value, "checkpoints", "defaults to the DERIVED kind");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: a unet-derived result's detail view ALSO renders the selector (symmetric), defaulting to unet", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 71, versionId: 1, name: "Ambiguous UNet", kind: "unet", type: "UNet" })];
  invalidateModelDetail(71, 1);
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
    findAll(handle.scrim, "wtn-cm-card")[0].dispatch("click", { stopPropagation() {} });
    await settle();

    const sel = findAll(handle.panel, "wtn-cm-dest-select")[0];
    assert.ok(sel, "a unet-derived result must ALSO render the destination selector -- the ambiguity runs both ways");
    assert.equal(sel.value, "unet", "defaults to the DERIVED kind");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: a loras-derived result's detail view keeps the plain static caption -- NO selector", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 72, versionId: 1, name: "A LoRA", kind: "loras", type: "LORA" })];
  invalidateModelDetail(72, 1);
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
    findAll(handle.scrim, "wtn-cm-card")[0].dispatch("click", { stopPropagation() {} });
    await settle();

    assert.equal(findAll(handle.panel, "wtn-cm-dest-select").length, 0, "a loras result must never get the ambiguity selector");
    const caption = findAll(handle.panel, "wtn-cm-dest")[0];
    assert.ok(caption, "the plain static caption must still render");
    assert.equal(caption.tagName, "div");
    assert.equal(caption.textContent, "→ models/loras/");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: changing the Checkpoint/UNet selector updates the displayed path AND the kind sent to /download/start", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 73, versionId: 1, name: "Switchable", kind: "checkpoints", type: "Checkpoint" })];
  invalidateModelDetail(73, 1);
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
      startedKind = JSON.parse(init.body).kind;
      return jsonResponse({ reason: "started", message: "", job_id: "job-73" });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    findAll(handle.scrim, "wtn-cm-card")[0].dispatch("click", { stopPropagation() {} });
    await settle();

    // Scoped to the detail host specifically -- the (hidden, not removed)
    // grid behind it still has its own card with its OWN, unrelated
    // "↓ Download" button (fixed to the derived kind, no selector there),
    // so an unscoped query could silently grab the wrong one.
    let detailHostEl = findAll(handle.panel, "wtn-cm-detailhost")[0];
    let sel = findAll(detailHostEl, "wtn-cm-dest-select")[0];
    assert.equal(sel.value, "checkpoints");
    const selectedOptionBefore = sel.children.find((o) => o.value === sel.value);
    assert.equal(selectedOptionBefore.textContent, "→ models/checkpoints/", "the displayed path starts at the derived kind's own folder");

    // Switch the selection to unet.
    sel.value = "unet";
    sel.dispatch("change", { stopPropagation() {} });
    await settle();

    detailHostEl = findAll(handle.panel, "wtn-cm-detailhost")[0];
    sel = findAll(detailHostEl, "wtn-cm-dest-select")[0];
    assert.equal(sel.value, "unet", "the selection change is retained across the re-render");
    const selectedOptionAfter = sel.children.find((o) => o.value === sel.value);
    assert.equal(selectedOptionAfter.textContent, "→ models/diffusion_models/", "the displayed path updates LIVE to the newly chosen folder");

    const downloadBtn = findAll(detailHostEl, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();
    assert.equal(startedKind, "unet", "the /download/start payload must carry the CHOSEN kind, not the original derived one");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

await asyncTest("openCivitaiModal: the Checkpoint/UNet choice is per-download, not persisted -- re-opening the SAME result's detail view resets to the derived kind", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  const results = [makeResult({ modelId: 74, versionId: 1, name: "Not Sticky", kind: "checkpoints", type: "Checkpoint" })];
  invalidateModelDetail(74, 1);
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
    findAll(handle.scrim, "wtn-cm-card")[0].dispatch("click", { stopPropagation() {} });
    await settle();

    // Scoped to the detail host specifically -- the (hidden, not removed)
    // grid behind it now has its OWN destination selector too (2026-08-05,
    // the grid card follow-up), so an unscoped `handle.panel` query could
    // silently grab that one instead (see the 2026-08-01 test just above
    // this one, which already made the identical point for a different
    // reason).
    let detailHostEl = findAll(handle.panel, "wtn-cm-detailhost")[0];
    let sel = findAll(detailHostEl, "wtn-cm-dest-select")[0];
    sel.value = "unet";
    sel.dispatch("change", { stopPropagation() {} });
    await settle();
    detailHostEl = findAll(handle.panel, "wtn-cm-detailhost")[0];
    sel = findAll(detailHostEl, "wtn-cm-dest-select")[0];
    assert.equal(sel.value, "unet");

    const backBtn = findAll(detailHostEl, "wtn-dv-back")[0];
    backBtn.dispatch("click", { stopPropagation() {} });
    // Re-opening the SAME (single) card -- this stub has no real event
    // bubbling, so the click must dispatch on the card element itself
    // (which carries its own listener), not a child of it.
    findAll(handle.scrim, "wtn-cm-card")[0].dispatch("click", { stopPropagation() {} });
    await settle();

    detailHostEl = findAll(handle.panel, "wtn-cm-detailhost")[0];
    sel = findAll(detailHostEl, "wtn-cm-dest-select")[0];
    assert.equal(sel.value, "checkpoints", "re-opening the detail view must reset to the DERIVED kind, never remember the earlier choice (the card's own selector was never touched in this test)");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
  }
});

// =========================================================================
// The Installed tab (owner, 2026-07-30; placement settled 2026-08-02/03,
// docs/lora-loader-design.md "Installed-by-kind section") -- pure helpers
// first, then the DOM integration tests the task brief itself enumerates.
// =========================================================================

test("INSTALLED_KIND_ORDER: exactly the three kinds this pack can install, in the mockup's own order", () => {
  assert.deepEqual(INSTALLED_KIND_ORDER, ["loras", "checkpoints", "unet"]);
});

test("INSTALLED_KIND_LABELS: a display label for every kind in INSTALLED_KIND_ORDER", () => {
  for (const kind of INSTALLED_KIND_ORDER) {
    assert.equal(typeof INSTALLED_KIND_LABELS[kind], "string");
    assert.ok(INSTALLED_KIND_LABELS[kind].length > 0);
  }
});

test("sortInstalledModels: 'name' sorts case-insensitively A->Z, never mutating the input", () => {
  const models = [{ name: "Zeta.safetensors" }, { name: "alpha.safetensors" }, { name: "Mid.safetensors" }];
  const sorted = sortInstalledModels(models, "name");
  assert.deepEqual(sorted.map((m) => m.name), ["alpha.safetensors", "Mid.safetensors", "Zeta.safetensors"]);
  assert.equal(models[0].name, "Zeta.safetensors", "the input array itself is never reordered");
});

test("sortInstalledModels: 'size' sorts largest first; a missing/garbage size sorts as if it were 0", () => {
  const models = [{ name: "a", size: 10 }, { name: "b", size: 1000 }, { name: "c" }];
  const sorted = sortInstalledModels(models, "size");
  assert.deepEqual(sorted.map((m) => m.name), ["b", "a", "c"]);
});

test("sortInstalledModels: garbage input degrades to [], never throws", () => {
  assert.deepEqual(sortInstalledModels(null, "name"), []);
  assert.deepEqual(sortInstalledModels(undefined, "size"), []);
  assert.deepEqual(sortInstalledModels("not an array", "name"), []);
});

test("installedSections: an unchecked kind's whole section is omitted outright", () => {
  const sections = installedSections(
    { loras: [{ name: "a" }], checkpoints: [{ name: "b" }], unet: [{ name: "c" }] },
    ["loras"],
    "name",
  );
  assert.deepEqual(sections.map((s) => s.kind), ["loras"]);
});

test("installedSections: a kind with zero files still appears (loaded, count 0) -- 'you have none' is real information", () => {
  const sections = installedSections({ loras: [], checkpoints: undefined, unet: undefined }, INSTALLED_KIND_ORDER, "name");
  const loras = sections.find((s) => s.kind === "loras");
  assert.equal(loras.loaded, true);
  assert.equal(loras.count, 0);
  assert.deepEqual(loras.models, []);
});

test("installedSections: a kind whose fetch hasn't resolved yet is 'loaded: false' -- never a false 'no files'", () => {
  const sections = installedSections({}, INSTALLED_KIND_ORDER, "name");
  for (const s of sections) {
    assert.equal(s.loaded, false, `${s.kind} must not claim to be loaded before its /list fetch has resolved`);
    assert.equal(s.count, 0);
  }
});

test("installedSections: sections always render in INSTALLED_KIND_ORDER, regardless of enabledKinds' own order", () => {
  const sections = installedSections({ loras: [], checkpoints: [], unet: [] }, ["unet", "loras", "checkpoints"], "name");
  assert.deepEqual(sections.map((s) => s.kind), ["loras", "checkpoints", "unet"]);
});

test("installedSections: garbage modelsByKind/enabledKinds degrades to [], never throws", () => {
  assert.deepEqual(installedSections(null, null, "name"), []);
  assert.deepEqual(installedSections(undefined, undefined, "size"), []);
  assert.deepEqual(installedSections("garbage", "garbage", "name"), []);
});

// -------------------------------------------------------------------------
// DOM integration -- a stub DOM, mirroring every other openCivitaiModal test
// above. `invalidateList` (civitai_api.mjs) resets the REAL "loras"/
// "checkpoints"/"unet" kinds before and after each test, since the Installed
// tab -- unlike model_picker.mjs's own tests -- always fetches these three
// fixed kind strings rather than a per-test fake one.
// -------------------------------------------------------------------------

function resetInstalledListCache() {
  invalidateList("loras");
  invalidateList("checkpoints");
  invalidateList("unet");
}

function stubFetchForInstalled({ listByKind = {}, onDelete } = {}) {
  stubFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes("/wtn/model_browser/list")) {
      const kind = new URL(u, "http://x").searchParams.get("kind");
      return jsonResponse({ reason: "ok", models: listByKind[kind] || [] });
    }
    if (u.includes("/wtn/model_browser/delete")) {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (typeof onDelete === "function") {
        onDelete(body);
      }
      return jsonResponse({ reason: "ok", message: "", removed: ["model"] });
    }
    if (u.includes("/wtn/model_browser/thumb")) {
      return jsonResponse({});
    }
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
}

function installedTabBtnOf(root) {
  return findAll(root, "wtn-cm-tab").find((t) => t.textContent === "Installed");
}
function searchTabBtnOf(root) {
  return findAll(root, "wtn-cm-tab").find((t) => t.textContent === "Search");
}

await asyncTest("openCivitaiModal: the default tab is Search (both rails exist; only Search's is visible), and its own behaviour is untouched", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetchForInstalled({});
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    const rails = findAll(handle.scrim, "wtn-cm-rail");
    assert.equal(rails.length, 2, "Search's own rail and the Installed tab's own rail both exist in the DOM");
    // Search's own rail never has its `display` touched at all until a tab
    // switch happens (only the Installed pair starts with an explicit
    // `"none"`), so its untouched default is `undefined`, not the string
    // `""` -- either way, "not none" is the actual behavioural claim here.
    assert.notEqual(rails[0].style.display, "none", "Search's own rail is visible by default");
    assert.equal(rails[1].style.display, "none", "the Installed tab's own rail starts hidden");

    const mains = findAll(handle.scrim, "wtn-cm-main");
    assert.notEqual(mains[0].style.display, "none", "Search's own main column is visible by default");
    assert.equal(mains[1].style.display, "none", "the Installed tab's own main column starts hidden");

    assert.ok(searchTabBtnOf(handle.scrim).classList.contains("wtn-cm-tab-active"), "the Search tab starts active");
    assert.ok(!installedTabBtnOf(handle.scrim).classList.contains("wtn-cm-tab-active"));

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: switching to Installed swaps BOTH the rail and the grid; switching back restores Search's own", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetchForInstalled({
    listByKind: {
      loras: [{ name: "a.safetensors", size: 1024, base_model: "SDXL", has_preview: false, triggers: [] }],
      checkpoints: [],
      unet: [],
    },
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();

    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const rails = findAll(handle.scrim, "wtn-cm-rail");
    const mains = findAll(handle.scrim, "wtn-cm-main");
    assert.equal(rails[0].style.display, "none", "Search's own rail hides");
    assert.equal(rails[1].style.display, "", "the Installed tab's own rail shows");
    assert.equal(mains[0].style.display, "none", "Search's own main column hides");
    assert.equal(mains[1].style.display, "", "the Installed tab's own main column shows");
    assert.ok(installedTabBtnOf(handle.scrim).classList.contains("wtn-cm-tab-active"));
    assert.ok(!searchTabBtnOf(handle.scrim).classList.contains("wtn-cm-tab-active"));

    const headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.deepEqual(headings, ["LoRAs (1)", "Checkpoints (0)", "UNet (0)"], "one heading per kind, in order, each with its own count");

    searchTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    assert.equal(rails[0].style.display, "", "Search's own rail is restored");
    assert.equal(mains[0].style.display, "", "Search's own main column is restored");
    assert.equal(rails[1].style.display, "none");
    assert.equal(mains[1].style.display, "none");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: a kind with zero files still shows its heading and a quiet empty line -- never a silently missing section", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetchForInstalled({ listByKind: { loras: [], checkpoints: [], unet: [] } });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.deepEqual(headings, ["LoRAs (0)", "Checkpoints (0)", "UNet (0)"]);
    const emptyLines = findAll(handle.scrim, "wtn-cm-empty").filter((e) => e.textContent === "No files.");
    assert.equal(emptyLines.length, 3, "every empty kind gets its own quiet empty line");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: the Kind checkboxes filter which sections render", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetchForInstalled({
    listByKind: {
      loras: [{ name: "a.safetensors", size: 10, has_preview: false }],
      checkpoints: [{ name: "b.safetensors", size: 10, has_preview: false }],
      unet: [{ name: "c.safetensors", size: 10, has_preview: false }],
    },
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    let headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.deepEqual(headings, ["LoRAs (1)", "Checkpoints (1)", "UNet (1)"]);

    const kindChecks = findAll(handle.scrim, "wtn-cm-kind-check");
    const loraCheck = kindChecks.find((l) => l.children[1] && l.children[1].textContent === "LoRAs");
    assert.ok(loraCheck, "a Kind checkbox row exists for LoRAs");
    const loraCheckbox = loraCheck.children[0];
    loraCheckbox.checked = false;
    loraCheckbox.dispatch("change", { stopPropagation() {} });

    headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.deepEqual(headings, ["Checkpoints (1)", "UNet (1)"], "unchecking a kind removes its WHOLE section, not just its cards");

    loraCheckbox.checked = true;
    loraCheckbox.dispatch("change", { stopPropagation() {} });
    headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.deepEqual(headings, ["LoRAs (1)", "Checkpoints (1)", "UNet (1)"], "re-checking restores the section");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: a card with has_preview:false gets the shared placeholder; has_preview:true attempts the /thumb image", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/wtn/model_browser/list")) {
      const kind = new URL(u, "http://x").searchParams.get("kind");
      const byKind = {
        loras: [
          { name: "no-preview.safetensors", size: 100, base_model: "SDXL", has_preview: false, triggers: [] },
          { name: "has-preview.safetensors", size: 200, base_model: "SDXL", has_preview: true, triggers: [] },
        ],
        checkpoints: [],
        unet: [],
      };
      return jsonResponse({ reason: "ok", models: byKind[kind] || [] });
    }
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const cards = findAll(handle.scrim, "wtn-cm-inst-card");
    assert.equal(cards.length, 2);
    const noPreviewCard = cards.find((c) => findAll(c, "wtn-cm-title").some((t) => t.title === "no-preview.safetensors"));
    const hasPreviewCard = cards.find((c) => findAll(c, "wtn-cm-title").some((t) => t.title === "has-preview.safetensors"));

    assert.equal(findAll(noPreviewCard, "wtn-cm-thumb-ph").length, 1, "has_preview:false renders the SAME placeholder the picker uses");
    assert.equal(findAllByTag(noPreviewCard, "img").length, 0, "no <img> is ever attempted for a preview-less file");

    // Loading a thumbnail is a plain `<img src>`, never a `fetch()` call
    // (that's how a real browser resolves it; nothing here should assert a
    // fetch stub was hit) -- the actual behavioural claim is that the
    // element attempts the SAME `/thumb` URL `civitai_api.mjs`'s `thumbUrl`
    // produces, no second URL scheme invented for this tab.
    const previewImgs = findAllByTag(hasPreviewCard, "img");
    assert.equal(previewImgs.length, 1, "has_preview:true attempts a real <img>");
    assert.equal(previewImgs[0].src, thumbUrl("loras", "has-preview.safetensors"));

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: Delete on an Installed card invalidates AND refetches, then re-renders -- invalidate alone is not enough (d255da3's own half-fix)", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  let lorasModels = [{ name: "a.safetensors", size: 100, base_model: "SDXL", has_preview: false, triggers: [] }];
  let listFetchCount = 0;
  let deleteBody = null;
  stubFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes("/wtn/model_browser/list")) {
      const kind = new URL(u, "http://x").searchParams.get("kind");
      if (kind === "loras") {
        listFetchCount += 1;
      }
      const byKind = { loras: lorasModels, checkpoints: [], unet: [] };
      return jsonResponse({ reason: "ok", models: byKind[kind] || [] });
    }
    if (u.includes("/wtn/model_browser/delete")) {
      deleteBody = JSON.parse(opts.body);
      lorasModels = []; // the file is genuinely gone server-side now
      return jsonResponse({ reason: "ok", message: "", removed: ["model"] });
    }
    return jsonResponse({ reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    assert.equal(listFetchCount, 1, "the initial switch to Installed fetches loras' list exactly once");
    let headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.ok(headings.includes("LoRAs (1)"));

    const deleteBtn = findAll(handle.scrim, "wtn-cm-action-delete")[0];
    assert.ok(deleteBtn, "the card renders a Delete action");
    deleteBtn.dispatch("click", { stopPropagation() {} });

    const confirmInput = findAllByTag(doc.body, "input").find((e) => e.placeholder === "delete");
    assert.ok(confirmInput, "the type-to-confirm dialog opened");
    confirmInput.value = "delete";
    confirmInput.dispatch("input", {});
    const confirmBtn = findAll(doc.body, "wtn-dc-confirm")[0];
    assert.ok(!confirmBtn.disabled, "typing the confirm word enables Delete");
    confirmBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.deepEqual(deleteBody, { kind: "loras", name: "a.safetensors" });
    assert.equal(listFetchCount, 2, "delete must be followed by a REAL refetch -- invalidate alone would never bump this count");

    headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.ok(headings.includes("LoRAs (0)"), "the tab re-renders with the file gone, not left showing a stale card");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: switching tabs preserves the search query/results, and an in-flight download keeps updating while Installed is showing", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  const results = [makeResult({ modelId: 61, versionId: 61, name: "Preserve Me", kind: "loras" })];
  let progressCalls = 0;
  stubFetch(async (url) => {
    const u = String(url);
    if (u.includes("/download/start")) {
      return jsonResponse({ reason: "started", message: "", job_id: "job-preserve" });
    }
    if (u.includes("/download/progress")) {
      progressCalls += 1;
      return jsonResponse({ reason: "ok", status: "downloading", bytes: progressCalls * 10, total: 100, message: "" });
    }
    if (u.includes("/wtn/model_browser/list")) {
      return jsonResponse({ reason: "ok", models: [] });
    }
    return jsonResponse({ reason: "ok", message: "", results, next_cursor: null, public_only: false });
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc, pollIntervalMs: 10 });
    await settle();

    const searchInput = findAll(handle.scrim, "wtn-cm-search")[0];
    searchInput.value = "preserve me"; // never dispatched -- just a value that must survive the round trip

    const downloadBtn = findAll(handle.scrim, "wtn-cm-action").find((e) => e.textContent === "↓ Download");
    downloadBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(progressCalls > 0, "the download's own poll keeps running while the Installed tab is showing, not paused");

    searchTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });

    assert.equal(searchInput.value, "preserve me", "the typed query text survives the round trip through Installed");
    const cardsAfter = findAll(handle.scrim, "wtn-cm-card").filter((c) => !c.classList.contains("wtn-cm-inst-card"));
    assert.equal(cardsAfter.length, 1, "the search results are still there, unchanged");
    // This download was started from the search card that's STILL in
    // `results` (never removed by a tab switch), so `renderActive`'s own
    // "the card itself already shows this job's progress" guard means the
    // separate `.wtn-cm-active` banner correctly renders NOTHING here (its
    // own doc comment) -- the live progress instead shows on the CARD:
    // percent text + a Cancel button, in its `state === "downloading"`
    // branch. That is what must have survived the round trip through
    // Installed, not a banner this scenario was never going to show.
    const cancelBtns = findAll(handle.scrim, "wtn-cm-action-cancel");
    assert.ok(cancelBtns.length >= 1, "the search card's own live 'downloading' state (with its Cancel button) survives the round trip through Installed");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

// -------------------------------------------------------------------------
// 2026-08-03 -- "an Installed card opens the detail view on click; the ⓘ
// button goes." No ⓘ button any more; a card click (outside Delete) opens
// the SAME master->detail swap Search cards already use; a card with no
// sidecar (no `model_id`/`version_id` on its `/list` row) runs a by-hash
// lookup first and renders found/notfound/offline.
// -------------------------------------------------------------------------

function stubFetchForInstalledDetail({
  listByKind = {}, lookupResponses, modelDetailResponse, searchResponse,
} = {}) {
  let lookupCallCount = 0;
  const lookupCalls = [];
  const modelDetailCalls = [];
  stubFetch(async (url, opts) => {
    const u = String(url);
    if (u.includes("/wtn/model_browser/list")) {
      const kind = new URL(u, "http://x").searchParams.get("kind");
      return jsonResponse({ reason: "ok", models: listByKind[kind] || [] });
    }
    if (u.includes("/wtn/model_browser/lookup")) {
      lookupCalls.push(opts && opts.body ? JSON.parse(opts.body) : {});
      const responses = Array.isArray(lookupResponses) ? lookupResponses : [lookupResponses];
      const resp = responses[Math.min(lookupCallCount, responses.length - 1)] || { reason: "notfound", message: "" };
      lookupCallCount += 1;
      return jsonResponse(resp);
    }
    if (u.includes("/wtn/model_browser/model_detail")) {
      modelDetailCalls.push(u);
      return jsonResponse(modelDetailResponse || {
        reason: "notfound", message: "", model_description: null,
        model_description_checked: true, version_description: null, gallery: [],
      });
    }
    if (u.includes("/wtn/model_browser/thumb")) {
      return jsonResponse({});
    }
    return jsonResponse(searchResponse || { reason: "ok", message: "", results: [], next_cursor: null, public_only: false });
  });
  return { lookupCalls, modelDetailCalls, get lookupCallCount() { return lookupCallCount; } };
}

function installedCardFor(root, name) {
  return findAll(root, "wtn-cm-inst-card").find((c) => findAll(c, "wtn-cm-title").some((t) => t.title === name));
}

await asyncTest("openCivitaiModal: an Installed card renders NO ⓘ button any more -- Delete is the only action left", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetchForInstalledDetail({
    listByKind: { loras: [{ name: "a.safetensors", size: 10, has_preview: false, base_model: "SDXL", triggers: [] }], checkpoints: [], unet: [] },
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const card = installedCardFor(handle.scrim, "a.safetensors");
    assert.ok(card, "the card renders");
    const buttons = findAllByTag(card, "button");
    assert.ok(!buttons.some((b) => b.textContent === "ⓘ"), "no ⓘ button renders on an Installed card any more");
    assert.ok(buttons.some((b) => b.textContent === "Delete"), "Delete is still there");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: a card click with known ids (already on its /list row) opens the detail view directly -- no lookup call needed", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  const stubs = stubFetchForInstalledDetail({
    listByKind: {
      loras: [{ name: "known.safetensors", size: 10, has_preview: false, base_model: "SDXL", triggers: [], model_id: 1, version_id: 2, civitai_name: "Known Model" }],
      checkpoints: [], unet: [],
    },
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const card = installedCardFor(handle.scrim, "known.safetensors");
    assert.ok(card, "the card renders");
    card.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.equal(stubs.lookupCalls.length, 0, "known ids skip the by-hash lookup entirely");
    const title = findAll(handle.scrim, "wtn-dv-title")[0];
    assert.ok(title, "the detail view opened");
    assert.equal(title.textContent, "Known Model");
    assert.ok(findAll(handle.scrim, "wtn-cm-action-installed").length > 0, "an installed model's detail action shows the same installed badge a Search card would");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: clicking Delete never opens the detail view", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetchForInstalledDetail({
    listByKind: { loras: [{ name: "d.safetensors", size: 10, has_preview: false, base_model: "SDXL", triggers: [], model_id: 1, version_id: 2 }], checkpoints: [], unet: [] },
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const card = installedCardFor(handle.scrim, "d.safetensors");
    const deleteBtn = findAll(card, "wtn-cm-action-delete")[0];
    assert.ok(deleteBtn, "the card has a Delete button");
    deleteBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.equal(findAll(handle.scrim, "wtn-dv-title").length, 0, "Delete's own click never opened the detail view");
    const confirmInput = findAllByTag(doc.body, "input").find((e) => e.placeholder === "delete");
    assert.ok(confirmInput, "Delete's OWN action (the type-to-confirm dialog) still opened");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: a card with no sidecar runs a by-hash lookup, then opens the detail view once it resolves 'found'", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  const stubs = stubFetchForInstalledDetail({
    listByKind: { loras: [{ name: "unknown.safetensors", size: 10, has_preview: false, base_model: "", triggers: [] }], checkpoints: [], unet: [] },
    lookupResponses: [{
      reason: "found",
      data: { model_id: 9, version_id: 10, name: "Resolved By Hash", base_model: "Illustrious", triggers: ["t1"], images: [] },
    }],
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const card = installedCardFor(handle.scrim, "unknown.safetensors");
    card.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.equal(stubs.lookupCalls.length, 1, "no ids on the /list row -- exactly one by-hash lookup runs");
    assert.deepEqual(stubs.lookupCalls[0], { kind: "loras", name: "unknown.safetensors", force_refresh: false, cached_only: false });
    const title = findAll(handle.scrim, "wtn-dv-title")[0];
    assert.ok(title, "the detail view opened once the lookup resolved");
    assert.equal(title.textContent, "Resolved By Hash");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: a card with no sidecar, lookup 'notfound' -- renders model_info.mjs's own wording + 'Search Civitai by name →', which switches to Search pre-filled", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetchForInstalledDetail({
    listByKind: { loras: [{ name: "my_character-v2.safetensors", size: 10, has_preview: false, base_model: "", triggers: [] }], checkpoints: [], unet: [] },
    lookupResponses: [{ reason: "notfound", message: "" }],
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const card = installedCardFor(handle.scrim, "my_character-v2.safetensors");
    card.dispatch("click", { stopPropagation() {} });
    await settle();

    const headline = findAll(handle.scrim, "wtn-cm-lookup-headline")[0];
    assert.ok(headline, "the notfound state renders");
    assert.ok(headline.textContent.includes("This exact file isn't on Civitai"), "reuses model_info.mjs's own headline wording verbatim");
    const searchByNameBtn = findAllByTag(handle.scrim, "button").find((b) => b.textContent === "Search Civitai by name →");
    assert.ok(searchByNameBtn, "reuses model_info.mjs's own 'Search Civitai by name →' action label verbatim");

    searchByNameBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.ok(searchTabBtnOf(handle.scrim).classList.contains("wtn-cm-tab-active"), "switches to the Search tab");
    const searchInput = findAllByTag(handle.scrim, "input").find((i) => i.type === "text");
    assert.equal(searchInput.value, queryFromModelName("my_character-v2.safetensors"), "pre-fills the SAME cheap name-guess lora_interaction.mjs's own onSearchByName already uses");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: a card with no sidecar, lookup 'offline' -- renders the offline wording with a Retry action that re-runs the lookup", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  const stubs = stubFetchForInstalledDetail({
    listByKind: { loras: [{ name: "flaky.safetensors", size: 10, has_preview: false, base_model: "", triggers: [] }], checkpoints: [], unet: [] },
    lookupResponses: [
      { reason: "offline", offline_reason: "timeout", message: "" },
      { reason: "found", data: { model_id: 3, version_id: 4, name: "Recovered" } },
    ],
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    const card = installedCardFor(handle.scrim, "flaky.safetensors");
    card.dispatch("click", { stopPropagation() {} });
    await settle();

    const headline = findAll(handle.scrim, "wtn-cm-lookup-headline")[0];
    assert.ok(headline.textContent.includes("Civitai timed out"), "reuses model_info.mjs's own offline headline for this offline_reason");
    const retryBtn = findAllByTag(handle.scrim, "button").find((b) => b.textContent === "Retry");
    assert.ok(retryBtn, "the offline state's own Retry action renders");

    retryBtn.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.equal(stubs.lookupCalls.length, 2, "Retry re-runs the SAME lookup, not a no-op");
    const title = findAll(handle.scrim, "wtn-dv-title")[0];
    assert.ok(title, "the second, successful lookup opens the detail view");
    assert.equal(title.textContent, "Recovered");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

await asyncTest("openCivitaiModal: '← back to results' from an Installed card's detail view lands back on Installed, with its Kind filters and Sort intact -- never on Search", async () => {
  _resetDownloadStateForTests();
  _resetModalForTests();
  resetInstalledListCache();
  stubFetchForInstalledDetail({
    listByKind: {
      loras: [{ name: "known.safetensors", size: 10, has_preview: false, base_model: "SDXL", triggers: [], model_id: 1, version_id: 2 }],
      checkpoints: [{ name: "b.safetensors", size: 10, has_preview: false }],
      unet: [],
    },
  });
  try {
    const doc = makeDocStub();
    const handle = openCivitaiModal({ doc });
    await settle();
    installedTabBtnOf(handle.scrim).dispatch("click", { stopPropagation() {} });
    await settle();

    // Uncheck Checkpoints, and switch Sort to Size -- the state that must
    // still hold after the round trip through the detail view.
    const kindChecks = findAll(handle.scrim, "wtn-cm-kind-check");
    const checkpointsCheck = kindChecks.find((l) => l.children[1] && l.children[1].textContent === "Checkpoints");
    checkpointsCheck.children[0].checked = false;
    checkpointsCheck.children[0].dispatch("change", { stopPropagation() {} });

    const sortSelects = findAllByTag(handle.scrim, "select");
    const installedSortSel = sortSelects.find((s) => s.children.some((o) => o.value === "size"));
    installedSortSel.value = "size";
    installedSortSel.dispatch("change", { stopPropagation() {} });

    let headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.deepEqual(headings, ["LoRAs (1)", "UNet (0)"], "Checkpoints' whole section is gone, per the unchecked Kind filter");

    const card = installedCardFor(handle.scrim, "known.safetensors");
    card.dispatch("click", { stopPropagation() {} });
    await settle();

    assert.ok(findAll(handle.scrim, "wtn-dv-title")[0], "the detail view opened");
    assert.ok(installedTabBtnOf(handle.scrim).classList.contains("wtn-cm-tab-active"), "the Installed tab is still the active one while its own detail view shows");

    const backBtn = findAll(handle.scrim, "wtn-dv-back")[0];
    assert.ok(backBtn, "the modal's own fixed-topbar '← back to results' renders for the Installed tab's detail view too");
    backBtn.dispatch("click", { stopPropagation() {} });

    assert.equal(findAll(handle.scrim, "wtn-dv-title").length, 0, "the detail view is gone after 'back'");
    assert.ok(installedTabBtnOf(handle.scrim).classList.contains("wtn-cm-tab-active"), "lands back on Installed, never Search");
    assert.ok(!searchTabBtnOf(handle.scrim).classList.contains("wtn-cm-tab-active"));

    headings = findAll(handle.scrim, "wtn-cm-inst-heading").map((h) => h.textContent);
    assert.deepEqual(headings, ["LoRAs (1)", "UNet (0)"], "the Kind filter (Checkpoints unchecked) is still in effect after the round trip");
    assert.equal(installedSortSel.value, "size", "the Sort choice is still in effect after the round trip");

    handle.close();
  } finally {
    restoreFetch();
    _resetDownloadStateForTests();
    _resetModalForTests();
    resetInstalledListCache();
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
