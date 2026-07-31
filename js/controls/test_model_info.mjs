/**
 * test_model_info.mjs — regression tests for `model_info.mjs`: the pure
 * helpers (`civitaiModelUrl`, `visibleChips`, `emptyStateMessage`,
 * `lookupStateView`'s four Civitai lookup states, `descriptionsView`'s two
 * labelled Civitai descriptions -- §7d-i) PLUS a DOM-level integration test
 * of `openModelInfo` itself, via a minimal stub DOM mirroring
 * `test_model_picker.mjs`'s own `makeDocStub` (that file's top doc comment
 * explains why each track keeps its own copy rather than sharing one).
 * Plain `node js/controls/test_model_info.mjs`.
 */

import assert from "node:assert/strict";

import {
  civitaiModelUrl,
  visibleChips,
  emptyStateMessage,
  lookupStateView,
  descriptionsView,
  openModelInfo,
} from "./model_info.mjs";
import { invalidateInfo, thumbUrl } from "./civitai_api.mjs";
import { THUMB_SKELETON_CLASS } from "../shared/civitai_thumb.mjs";
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
// civitaiModelUrl -- always the SPECIFIC VERSION, not the model landing page
// (§7d), when a version id is usable.
// =========================================================================

test("civitaiModelUrl: model + version when both are usable", () => {
  assert.equal(civitaiModelUrl(123, 456), "https://civitai.com/models/123?modelVersionId=456");
});

test("civitaiModelUrl: digit-only STRING ids are accepted too (a hand-edited sidecar)", () => {
  assert.equal(civitaiModelUrl("123", "456"), "https://civitai.com/models/123?modelVersionId=456");
});

test("civitaiModelUrl: falls back to the model landing page when versionId isn't usable", () => {
  assert.equal(civitaiModelUrl(123, null), "https://civitai.com/models/123");
  assert.equal(civitaiModelUrl(123, "not-a-number"), "https://civitai.com/models/123");
});

test("civitaiModelUrl: null when modelId itself isn't usable -- nothing to link to", () => {
  assert.equal(civitaiModelUrl(null, 456), null);
  assert.equal(civitaiModelUrl(undefined, undefined), null);
  assert.equal(civitaiModelUrl("nope", 456), null);
  assert.equal(civitaiModelUrl(-5, 456), null);
});

// =========================================================================
// visibleChips -- candidates from the ACTIVE source (never deletable) ∪
// custom words (always deletable), deduped case-insensitively, selection
// read from the caller's own Set.
// =========================================================================

test("visibleChips: file source shows file candidates + custom words, civitai candidates hidden", () => {
  const chips = visibleChips({
    source: "file",
    fileTriggers: ["alpha", "beta"],
    civitaiTriggers: ["gamma"],
    customTriggers: ["delta"],
    selected: new Set(["alpha", "delta"]),
  });
  assert.deepEqual(chips.map((c) => c.word), ["alpha", "beta", "delta"]);
  assert.deepEqual(chips.map((c) => c.custom), [false, false, true]);
  assert.deepEqual(chips.map((c) => c.selected), [true, false, true]);
});

test("visibleChips: civitai source shows civitai candidates instead, custom words still present", () => {
  const chips = visibleChips({
    source: "civitai",
    fileTriggers: ["alpha"],
    civitaiTriggers: ["gamma", "delta-word"],
    customTriggers: ["custom-one"],
    selected: new Set(),
  });
  assert.deepEqual(chips.map((c) => c.word), ["gamma", "delta-word", "custom-one"]);
});

test("visibleChips: a custom word matching a candidate case-insensitively is NOT duplicated", () => {
  const chips = visibleChips({
    source: "file",
    fileTriggers: ["Alpha"],
    civitaiTriggers: [],
    customTriggers: ["alpha", "beta"],
    selected: new Set(),
  });
  assert.deepEqual(chips.map((c) => c.word), ["Alpha", "beta"]);
  assert.equal(chips[0].custom, false); // the CANDIDATE wins, never deletable
});

test("visibleChips: garbage input degrades to [], never throws", () => {
  assert.deepEqual(visibleChips(), []);
  assert.deepEqual(visibleChips({ source: "file", fileTriggers: "nope", customTriggers: null }), []);
});

test("visibleChips: `selected` also accepts a plain array, not just a Set", () => {
  const chips = visibleChips({ source: "file", fileTriggers: ["a"], selected: ["a"] });
  assert.equal(chips[0].selected, true);
});

// =========================================================================
// emptyStateMessage -- names both remedies, exact wording for the file case
// (design doc §1a-i).
// =========================================================================

test("emptyStateMessage: exact file-empty wording from the design doc", () => {
  assert.equal(emptyStateMessage("file"), "No trigger words in this file — add your own below, or try Civitai");
});

test("emptyStateMessage: a distinct, honest line for the civitai-empty case", () => {
  assert.notEqual(emptyStateMessage("civitai"), emptyStateMessage("file"));
  assert.match(emptyStateMessage("civitai"), /civitai/i);
});

// =========================================================================
// descriptionsView -- the two labelled Civitai descriptions (§7d-i, owner
// report 2026-07-30). Render each only when it has content; distinguish
// "absent" from "not yet checked" for `model_description` ONLY --
// `version_description` never needs that treatment.
// =========================================================================

test("descriptionsView: BOTH present -- two independent sections, no empty message", () => {
  const view = descriptionsView({
    modelDescription: "The full write-up.",
    versionDescription: "Trained on preview3.",
    modelDescriptionChecked: true,
    civitaiEnabled: true,
  });
  assert.equal(view.model, "The full write-up.");
  assert.equal(view.version, "Trained on preview3.");
  assert.equal(view.emptyMessage, null);
});

test("descriptionsView: only VERSION present -- MODEL renders nothing, no empty message either (never invents a heading for the other)", () => {
  const view = descriptionsView({
    modelDescription: undefined,
    versionDescription: "Trained on preview3.",
    modelDescriptionChecked: false, // even unchecked -- the other field having content wins, no separate empty state
    civitaiEnabled: true,
  });
  assert.equal(view.model, null);
  assert.equal(view.version, "Trained on preview3.");
  assert.equal(view.emptyMessage, null);
});

test("descriptionsView: only MODEL present -- VERSION renders nothing", () => {
  const view = descriptionsView({ modelDescription: "The full write-up.", versionDescription: "", modelDescriptionChecked: true });
  assert.equal(view.model, "The full write-up.");
  assert.equal(view.version, null);
  assert.equal(view.emptyMessage, null);
});

test("descriptionsView: NEITHER present, modelDescriptionChecked TRUE -- an honest 'none' state, not a promise of anything", () => {
  const view = descriptionsView({ modelDescriptionChecked: true, civitaiEnabled: true });
  assert.equal(view.model, null);
  assert.equal(view.version, null);
  assert.equal(view.emptyMessage, "This LoRA has no author's notes on Civitai.");
});

test("descriptionsView: NEITHER present, modelDescriptionChecked FALSE, Civitai ON -- 'not looked up yet', names the EXISTING ↻ Civitai action, never claims absence", () => {
  const view = descriptionsView({ modelDescriptionChecked: false, civitaiEnabled: true });
  assert.match(view.emptyMessage, /not looked up yet/i);
  assert.match(view.emptyMessage, /↻ Civitai/);
  assert.doesNotMatch(view.emptyMessage, /no author's notes|has no description/i);
});

test("descriptionsView: NEITHER present, no record at all (modelDescriptionChecked undefined) -- treated the SAME as an explicit false, never as confirmed-none", () => {
  const view = descriptionsView({ civitaiEnabled: true });
  assert.match(view.emptyMessage, /not looked up yet/i);
});

test("descriptionsView: NEITHER present, unchecked, Civitai OFF -- never names the ↻ Civitai button (it doesn't render then)", () => {
  const view = descriptionsView({ modelDescriptionChecked: false, civitaiEnabled: false });
  assert.doesNotMatch(view.emptyMessage, /↻ Civitai/, "the footer button this would point at is hidden with the setting off");
  assert.match(view.emptyMessage, /turn the Civitai setting on/);
});

test("descriptionsView: garbage/whitespace-only input degrades safely, never throws", () => {
  assert.doesNotThrow(() => descriptionsView());
  const view = descriptionsView({ modelDescription: "   ", versionDescription: 42, modelDescriptionChecked: "yes" });
  assert.equal(view.model, null);
  assert.equal(view.version, null);
  // `modelDescriptionChecked: "yes"` is not the literal boolean `true` -- must not be treated as confirmed-checked.
  assert.match(view.emptyMessage, /not looked up yet/i);
});

// =========================================================================
// lookupStateView -- the four Civitai lookup states (§7e), each icon +
// headline + one line + the one useful action; every non-idle state also
// says what still works.
// =========================================================================

test("lookupStateView: null for idle/missing -- nothing to render", () => {
  assert.equal(lookupStateView(null), null);
  assert.equal(lookupStateView({ phase: "idle" }), null);
});

test("lookupStateView: searching -- spinner + Cancel", () => {
  const view = lookupStateView({ phase: "searching" });
  assert.equal(view.cssState, "searching");
  assert.equal(view.headline, "Checking Civitai…");
  assert.deepEqual(view.actions.map((a) => a.id), ["cancel"]);
});

test("lookupStateView: found -- Clear cache ONLY (BUG 8: Re-fetch dropped, it duplicated the footer's own ↻ Civitai)", () => {
  const view = lookupStateView({ phase: "result", response: { reason: "found", data: {} } });
  assert.equal(view.cssState, "found");
  assert.deepEqual(view.actions.map((a) => a.id), ["forget"]);
  assert.equal(view.actions[0].label, "Clear cache", "owner: 'more like clear cache' -- renamed from 'Forget cached'");
});

test("lookupStateView: notfound -- explains the hash, offers search-by-name DISABLED (M2 doesn't exist)", () => {
  const view = lookupStateView({ phase: "result", response: { reason: "notfound" } });
  assert.equal(view.cssState, "notfound");
  assert.match(view.why, /changes its hash/);
  assert.match(view.why, /file's own trigger words are still shown/);
  assert.equal(view.actions.length, 1);
  assert.equal(view.actions[0].disabled, true);
});

test("lookupStateView: offline -- each offline_reason gets its OWN distinct headline, never collapsed", () => {
  const cases = [
    ["timeout", "Civitai timed out"],
    ["dns_tls", "Couldn't reach Civitai (DNS)"],
    ["unreadable", "Civitai sent an unreadable reply (a login or block page?)"],
    ["rate_limited", "Civitai returned 429"],
    ["unknown", "Could not reach Civitai"],
    ["something-never-seen", "Could not reach Civitai"],
  ];
  const seen = new Set();
  for (const [reason, headline] of cases) {
    const view = lookupStateView({ phase: "result", response: { reason: "offline", offline_reason: reason } });
    assert.equal(view.cssState, "offline");
    assert.equal(view.headline, headline);
    assert.match(view.why, /file's own words are still shown/);
    seen.add(view.headline);
  }
  assert.ok(seen.size >= 5, "offline reasons must not collapse into one generic message");
});

test("lookupStateView: rate_limited names the key ladder", () => {
  const view = lookupStateView({ phase: "result", response: { reason: "offline", offline_reason: "rate_limited" } });
  assert.match(view.why, /API key/);
});

test("lookupStateView: unchecked (BUG 13) -- 'Not checked yet', one action ('check' -> ↻ Civitai), distinct from notfound/searching", () => {
  const view = lookupStateView({ phase: "unchecked" });
  assert.equal(view.cssState, "unchecked");
  assert.equal(view.headline, "Not checked yet");
  assert.deepEqual(view.actions.map((a) => a.id), ["check"]);
  assert.equal(view.actions[0].label, "↻ Civitai");
});

test("lookupStateView: missing_file -- a distinct, honest 'nothing to hash' message, no action", () => {
  const view = lookupStateView({ phase: "result", response: { reason: "offline", offline_reason: "missing_file" } });
  assert.equal(view.headline, "Can't check Civitai");
  assert.deepEqual(view.actions, []);
});

// =========================================================================
// openModelInfo -- DOM-level integration, via a minimal stub DOM.
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

async function settle(n = 3) {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const _origFetch = globalThis.fetch;

await asyncTest("openModelInfo: renders identity + file trigger chips, auto-looks-up Civitai, and shows the link once found", async () => {
  const kind = "loras";
  const name = "info-dom-a.safetensors";
  invalidateInfo(kind, name);
  let lookupCalls = 0;
  globalThis.fetch = async (url, opts) => {
    lookupCalls += 1;
    const body = JSON.parse(opts.body);
    assert.equal(body.kind, kind);
    assert.equal(body.name, name);
    return {
      json: async () => ({
        reason: "found",
        offline_reason: null,
        message: "",
        data: {
          name: "Skin Detail XL",
          base_model: "SDXL",
          triggers: ["detailed skin"],
          tags: ["character"],
          model_description: "The full write-up.",
          version_description: "Works best at 0.6-0.8.",
          model_description_checked: true,
          model_id: 111,
          version_id: 222,
        },
      }),
    };
  };
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    let lastSelected = null;
    let lastCustom = null;
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      baseModel: "Anima",
      fileTriggers: ["file-word-a", "file-word-b"],
      customTriggers: [],
      selectedTriggers: ["file-word-a"],
      civitaiEnabled: true,
      onChange: (sel, custom) => {
        lastSelected = sel;
        lastCustom = custom;
      },
    });

    // Identity header, filename -- BEFORE the lookup resolves the title is
    // just the prettified filename (no Civitai name known yet).
    const titleEl = findAll(handle.overlay, "wtn-mi-title")[0];
    assert.equal(titleEl.textContent, "info dom a");
    const fileEl = findAll(handle.overlay, "wtn-mi-file")[0];
    assert.equal(fileEl.textContent, name);
    const baseEl = findAll(handle.overlay, "wtn-mi-base")[0];
    assert.equal(baseEl.textContent, "Anima");

    // File-derived chips render immediately, no need to wait on Civitai.
    let chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.deepEqual(chips.map((c) => c.children[1].textContent), ["file-word-a", "file-word-b"]);
    assert.ok(chips[0].classList.contains("wtn-mi-chip-on"), "the initially-selected word must show selected");
    assert.equal(chips[0].children.length, 2, "a FILE candidate chip must carry NO delete control");

    await settle();
    assert.equal(lookupCalls, 1, "opening the panel triggers exactly one lookup");

    const link = findAll(handle.overlay, "wtn-mi-civlink")[0];
    assert.ok(link, "View on Civitai must appear once a version is found");
    assert.equal(link.href, "https://civitai.com/models/111?modelVersionId=222");

    // The title upgrades to Civitai's own display name once found.
    assert.equal(findAll(handle.overlay, "wtn-mi-title")[0].textContent, "Skin Detail XL");

    // §7d-i: TWO labelled sections, never merged -- each field's own text
    // under its OWN heading.
    const modelHead = findAll(handle.overlay, "wtn-mi-desc-model-head")[0];
    assert.equal(modelHead.children[1].textContent, "MODEL DESCRIPTION");
    const modelBody = findAll(handle.overlay, "wtn-mi-desc-model-body")[0];
    assert.equal(modelBody.textContent, "The full write-up.");
    const versionHead = findAll(handle.overlay, "wtn-mi-desc-version-head")[0];
    assert.equal(versionHead.children[1].textContent, "VERSION DESCRIPTION");
    const versionBody = findAll(handle.overlay, "wtn-mi-desc-version-body")[0];
    assert.equal(versionBody.textContent, "Works best at 0.6-0.8.");
    assert.equal(findAll(handle.overlay, "wtn-mi-desc-empty").length, 0, "both present -- no empty state");

    // Toggle a chip -- selection change reaches the caller via onChange.
    chips = findAll(handle.overlay, "wtn-mi-chip");
    chips[1].click(); // "file-word-b"
    assert.ok(lastSelected.includes("file-word-b"));
    assert.ok(lastSelected.includes("file-word-a"));
    assert.deepEqual(lastCustom, []);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: BOTH descriptions containing raw HTML / a literal '<lora:name:0.8>' reach the DOM as TEXT, never interpreted as markup", async () => {
  const kind = "loras";
  const name = "info-dom-untrusted-html.safetensors";
  invalidateInfo(kind, name);
  const modelText = "<script>alert(1)</script> Use <lora:name:0.8> for best results. <b>bold</b> not rendered.";
  const versionText = "Trained with <lora:other:1.0> baked in -- <i>not</i> a tag.";
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "found",
      offline_reason: null,
      message: "",
      data: {
        model_description: modelText,
        version_description: versionText,
        model_description_checked: true,
      },
    }),
  });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();

    // Exact string, unaltered -- if the implementation had used `innerHTML`
    // instead of `textContent`, this stub's `innerHTML` setter wipes
    // `children` without ever touching `textContent`, so the assertion below
    // would fail rather than silently pass (same proxy-check convention this
    // file already uses for custom trigger-word chip labels).
    assert.equal(findAll(handle.overlay, "wtn-mi-desc-model-body")[0].textContent, modelText);
    assert.equal(findAll(handle.overlay, "wtn-mi-desc-version-body")[0].textContent, versionText);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

// ---------------------------------------------------------------------------
// ALSO CHECK (owner brief, 2026-07-29): with a Civitai match that DOES carry
// trainedWords, does the 'from file'/'from Civitai' source pill actually
// switch the candidate list, with selections surviving the switch (§1a-i
// item 3)? Verified here -- both the initial pill click (auto-switch is
// gated on `sourceTouched`, and only fires when the FILE has nothing at
// all, so a non-empty fileTriggers fixture like this one genuinely
// exercises the manual pill click, not the auto-switch) and a round trip
// back.
// ---------------------------------------------------------------------------

await asyncTest("openModelInfo: the source pill switches the candidate list, and SELECTIONS survive the switch in both directions", async () => {
  const kind = "loras";
  const name = "info-source-pill.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "found",
      offline_reason: null,
      message: "",
      data: { name: "X", triggers: ["civ-word-a", "civ-word-b"] },
    }),
  });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      fileTriggers: ["file-word-a", "file-word-b"], // non-empty -- the auto-switch to civitai never fires
      selectedTriggers: ["file-word-a"],
      civitaiEnabled: true,
    });
    await settle(); // let the civitai lookup resolve

    // Still showing the FILE list (fileTriggers non-empty -- no auto-switch).
    let chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.deepEqual(chips.map((c) => c.children[1].textContent), ["file-word-a", "file-word-b"]);
    assert.ok(chips[0].classList.contains("wtn-mi-chip-on"), "file-word-a starts selected");

    const pill = findAll(handle.overlay, "wtn-mi-pill").find((p) => !p.classList.contains("wtn-mi-pill-static"));
    assert.equal(pill.textContent, "from file");

    pill.click(); // manual switch -> civitai
    assert.equal(pill.textContent, "from Civitai");
    chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.deepEqual(chips.map((c) => c.children[1].textContent), ["civ-word-a", "civ-word-b"], "the candidate LIST switched");
    assert.equal(chips[0].classList.contains("wtn-mi-chip-on"), false, "civ-word-a was never selected");

    chips[1].click(); // select "civ-word-b" while viewing the civitai list
    chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.ok(chips[1].classList.contains("wtn-mi-chip-on"));

    pill.click(); // switch BACK to file
    assert.equal(pill.textContent, "from file");
    chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.deepEqual(chips.map((c) => c.children[1].textContent), ["file-word-a", "file-word-b"]);
    assert.ok(chips[0].classList.contains("wtn-mi-chip-on"), "file-word-a's selection survived the round trip");

    pill.click(); // switch to civitai ONE more time -- civ-word-b's selection must ALSO have survived
    chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.ok(chips[1].classList.contains("wtn-mi-chip-on"), "civ-word-b's selection survived the switch away and back");

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: showThumbnails === false renders NO thumbnail element at all (§7b 'Show preview thumbnails')", async () => {
  const kind = "loras";
  const name = "info-dom-thumbs.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({ reason: "notfound", offline_reason: null, message: "", data: null }),
  });
  try {
    const docOn = makeDocStub();
    const handleOn = openModelInfo({
      ctx: { doc: docOn, getCanvasEl: () => null },
      anchorEl: docOn.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(findAll(handleOn.overlay, "wtn-mi-thumb").length, 1, "default (omitted) renders the thumbnail, unchanged from Slice 4");
    handleOn.close();
    invalidateInfo(kind, name);

    const docOff = makeDocStub();
    const handleOff = openModelInfo({
      ctx: { doc: docOff, getCanvasEl: () => null },
      anchorEl: docOff.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
      showThumbnails: false,
    });
    await settle();
    assert.equal(findAll(handleOff.overlay, "wtn-mi-thumb").length, 0, "showThumbnails: false must render NO thumbnail element at all");
    assert.equal(findAll(handleOff.overlay, THUMB_SKELETON_CLASS).length, 0, "showThumbnails: false must not resurrect the loading skeleton either");
    // The rest of the identity block is unaffected.
    assert.equal(findAll(handleOff.overlay, "wtn-mi-title").length, 1);
    handleOff.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

// =========================================================================
// §7c-iv -- "the level governs the ⓘ panel too". The identity thumb tries
// the LOCAL on-disk preview first (never level-filtered), falls through to
// the level-aware Civitai candidates on failure, and shows the shared
// loading skeleton for whichever candidate is currently in flight.
// =========================================================================

await asyncTest("openModelInfo: the identity thumb tries the LOCAL preview first, shows the loading skeleton while it's in flight, and clears it on a genuine load", async () => {
  const kind = "loras";
  const name = "info-dom-thumb-local.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({ reason: "notfound", offline_reason: null, message: "", data: null }),
  });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
    });
    await settle();

    const img = findAllByTag(handle.overlay, "img")[0];
    assert.ok(img, "the local preview must be attempted first, even with no Civitai record at all");
    assert.equal(img.src, thumbUrl(kind, name));
    assert.equal(findAll(handle.overlay, THUMB_SKELETON_CLASS).length, 1, "the skeleton must show while the local preview is in flight");

    img.onload(); // the local preview genuinely renders
    assert.equal(findAll(handle.overlay, THUMB_SKELETON_CLASS).length, 0, "a genuine load must clear the skeleton");
    assert.equal(findAll(handle.overlay, "wtn-mi-thumb-ph").length, 0);
    assert.equal(findAll(handle.overlay, "wtn-mi-thumb-locked").length, 0);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: once the LOCAL preview fails (retried, then exhausted), falls through to the level-aware Civitai candidates -- same retry-then-advance chain as the search card", async () => {
  const kind = "loras";
  const name = "info-dom-thumb-fallback.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "found",
      offline_reason: null,
      message: "",
      data: { name: "Fallback Test", images: [{ url: "https://image.civitai.com/pg.jpg", nsfw_level: 1, type: "image" }] },
    }),
  });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      thumbRetryBackoffMs: 10,
    });
    await settle();

    const localImg = findAllByTag(handle.overlay, "img")[0];
    assert.equal(localImg.src, thumbUrl(kind, name), "still tries the local preview first even once a Civitai record is known");
    assert.equal(findAll(handle.overlay, THUMB_SKELETON_CLASS).length, 1);

    localImg.onerror(); // 1st failure -- queues the retry
    assert.equal(findAll(handle.overlay, THUMB_SKELETON_CLASS).length, 1, "the skeleton survives the local preview's own retry");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const retriedImg = findAllByTag(handle.overlay, "img")[0];
    assert.equal(retriedImg.src, thumbUrl(kind, name), "the retry uses the SAME local url");

    retriedImg.onerror(); // 2nd failure of the local candidate -- advances (no backoff) to the Civitai candidate
    const civitaiImg = findAllByTag(handle.overlay, "img")[0];
    assert.ok(civitaiImg, "must fall through to the Civitai candidate once the local preview is exhausted");
    assert.equal(civitaiImg.src, "https://image.civitai.com/pg.jpg");
    assert.equal(findAll(handle.overlay, THUMB_SKELETON_CLASS).length, 1, "the skeleton must survive the fall-through too");

    civitaiImg.onload();
    assert.equal(findAll(handle.overlay, THUMB_SKELETON_CLASS).length, 0);
    assert.equal(findAll(handle.overlay, "wtn-mi-thumb-ph").length, 0);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: 'locked' -- once the local preview fails, Civitai has images but every one is above the chosen level", async () => {
  const kind = "loras";
  const name = "info-dom-thumb-locked.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "found",
      offline_reason: null,
      message: "",
      data: { name: "Locked Test", images: [{ url: "https://image.civitai.com/xxx.jpg", nsfw_level: 16, type: "image" }] },
    }),
  });
  try {
    const doc = makeDocStub();
    // Default browsingLevel is "PG" (1) -- an XXX-only (16) gallery must lock.
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      thumbRetryBackoffMs: 10,
    });
    await settle();

    const localImg = findAllByTag(handle.overlay, "img")[0];
    localImg.onerror();
    await new Promise((resolve) => setTimeout(resolve, 40));
    findAllByTag(handle.overlay, "img")[0].onerror(); // exhausts the local candidate -- no Civitai candidate passes the level either

    assert.equal(findAll(handle.overlay, THUMB_SKELETON_CLASS).length, 0, "exhaustion must clear the skeleton");
    assert.equal(findAllByTag(handle.overlay, "img").length, 0, "a locked thumb never renders an <img>");
    assert.equal(findAll(handle.overlay, "wtn-mi-thumb-ph").length, 0, "locked is distinct from the plain placeholder");
    const locked = findAll(handle.overlay, "wtn-mi-thumb-locked")[0];
    assert.ok(locked, "the locked glyph must render");
    assert.match(locked.title, /above your browsing level/i);
    assert.equal(locked.textContent, "\u{1F648}", "must use the SAME glyph as the search card's own locked state -- no third glyph");

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: a re-render mid-retry (e.g. a forced ↻ Civitai lookup landing while the local preview's own retry is still pending) leaves no stale timer writing into a detached thumb", async () => {
  const kind = "loras";
  const name = "info-dom-thumb-stale.safetensors";
  invalidateInfo(kind, name);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      json: async () => ({ reason: "notfound", offline_reason: null, message: "", data: null }),
    };
  };
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
      thumbRetryBackoffMs: 40,
    });
    await settle();

    const firstImg = findAllByTag(handle.overlay, "img")[0];
    firstImg.onerror(); // queues a retry ~40ms out, against THIS render generation

    // A forced re-lookup (`↻ Civitai`) re-renders the identity block --
    // including the thumb -- WHILE that retry timer is still pending.
    const refetchBtn = findAll(handle.overlay, "wtn-mi-refetch")[0];
    refetchBtn.click();
    await settle();

    const rebuiltImg = findAllByTag(handle.overlay, "img")[0];
    assert.ok(rebuiltImg, "the re-render must build its own fresh <img> for the local candidate");
    assert.equal(fetchCalls, 2, "the forced refetch must have actually happened");

    // Let the ORIGINAL (now-stale) retry timer fire.
    await new Promise((resolve) => setTimeout(resolve, 70));

    assert.equal(findAllByTag(handle.overlay, "img").length, 1, "the stale timer must not duplicate/replace the new render's own <img>");
    assert.equal(findAll(handle.overlay, "wtn-mi-thumb-ph").length, 0, "the stale timer must not append a placeholder into the current render either");

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: a selected word with NO matching candidate is never silently lost -- it renders as a deletable chip", async () => {
  const kind = "loras";
  const name = "info-dom-orphan.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({ reason: "notfound", offline_reason: null, message: "", data: null }),
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      fileTriggers: [], // the file no longer carries this word (e.g. re-saved)
      customTriggers: [],
      selectedTriggers: ["orphaned word"], // but it's still what the row applies
      civitaiEnabled: true,
    });
    await settle();

    const chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.equal(chips.length, 1);
    assert.equal(chips[0].children[1].textContent, "orphaned word");
    assert.ok(chips[0].classList.contains("wtn-mi-chip-on"), "still selected");
    assert.equal(chips[0].children.length, 3, "no known origin -- rendered deletable, never just vanished");

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: adding a custom word selects it and gives it a ✕; deleting it never toggles it first", async () => {
  const kind = "loras";
  const name = "info-dom-b.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({ reason: "notfound", offline_reason: null, message: "", data: null }),
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    let lastCustom = null;
    let lastSelected = null;
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      fileTriggers: [],
      customTriggers: [],
      selectedTriggers: [],
      civitaiEnabled: true,
      onChange: (sel, custom) => {
        lastSelected = sel;
        lastCustom = custom;
      },
    });
    await settle();

    const input = findAll(handle.overlay, "wtn-mi-add-input")[0];
    const addBtn = findAll(handle.overlay, "wtn-mi-add-btn")[0];
    input.value = "elf ears";
    addBtn.click();

    assert.deepEqual(lastCustom, ["elf ears"]);
    assert.ok(lastSelected.includes("elf ears"), "a freshly-added custom word starts SELECTED");

    let chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.equal(chips.length, 1);
    assert.equal(chips[0].children.length, 3, "a CUSTOM chip must carry a delete (✕) control");

    // Clicking the ✕ must delete, not merely toggle -- and must not ALSO
    // fire the chip's own toggle handler (stopPropagation).
    const delEl = chips[0].children[2];
    delEl.click();
    assert.deepEqual(lastCustom, []);
    assert.deepEqual(lastSelected, []);
    chips = findAll(handle.overlay, "wtn-mi-chip");
    assert.equal(chips.length, 0);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: all/none act on the CURRENTLY VISIBLE chips only, and never latch", async () => {
  const kind = "loras";
  const name = "info-dom-c.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({ reason: "notfound", offline_reason: null, message: "", data: null }),
  });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    let lastSelected = [];
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      fileTriggers: ["a", "b", "c"],
      customTriggers: [],
      selectedTriggers: [],
      civitaiEnabled: true,
      onChange: (sel) => {
        lastSelected = sel;
      },
    });
    await settle();

    const [allBtn, noneBtn] = findAll(handle.overlay, "wtn-mi-seg-act")[0].children;
    allBtn.click();
    assert.deepEqual(lastSelected.sort(), ["a", "b", "c"]);
    noneBtn.click();
    assert.deepEqual(lastSelected, []);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: civitaiEnabled=false always requests cached_only:true, and renders no LIVE network affordance", async () => {
  const kind = "loras";
  const name = "info-dom-d.safetensors";
  invalidateInfo(kind, name);
  let lastBody = null;
  globalThis.fetch = async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    // A real server, with the setting off, would answer offline/civitai_disabled
    // on a cache miss (lookup.py's own cached_only contract) -- reproduced here
    // rather than "found", so this test can't accidentally pass by the panel
    // just happening to render nothing either way.
    return { json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) };
  };
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      fileTriggers: ["a"],
      civitaiEnabled: false,
    });
    await settle();

    assert.ok(lastBody, "the panel DOES call the lookup route even with the setting off");
    assert.equal(lastBody.cached_only, true, "it must ask for cached_only -- never a live lookup -- while the setting is off");
    assert.equal(findAll(handle.overlay, "wtn-mi-status").length, 0, "no lookup status block -- it would misrepresent a cached-only read as a live one");
    assert.equal(findAll(handle.overlay, "wtn-mi-civlink").length, 0, "no View on Civitai link -- the 'way out' still disappears (§7d)");
    assert.equal(findAll(handle.overlay, "wtn-mi-refetch").length, 0, "no ↻ Civitai footer button -- it would force a LIVE lookup");
    // File-derived words still work -- the whole point of "degradation, not failure".
    assert.equal(findAll(handle.overlay, "wtn-mi-chip").length, 1);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

// ---------------------------------------------------------------------------
// BUG 13 (2026-07-29 owner report, HIGH PRIORITY): opening the ⓘ panel used
// to hash the whole file and hit Civitai over the network EVERY time,
// whenever Civitai was ON (the default) -- exactly the §9 violation the
// owner caught. Opening must ALWAYS be cached_only:true regardless of the
// setting; only an explicit '↻ Civitai' click may ever send cached_only:false.
// ---------------------------------------------------------------------------

await asyncTest("BUG 13: opening the panel with Civitai ON still sends cached_only:true -- fails loudly if runLookup ever reverts to cachedOnly:!civitaiEnabled", async () => {
  const kind = "loras";
  const name = "info-bug13-open-on.safetensors";
  invalidateInfo(kind, name);
  let lastBody = null;
  globalThis.fetch = async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    return { json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) };
  };
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true, // the previous bug ONLY manifested here -- Civitai ON is the default
    });
    await settle();

    assert.ok(lastBody, "opening the panel does call the lookup route");
    assert.equal(lastBody.cached_only, true, "opening must ALWAYS be cached_only:true -- civitaiEnabled must never flip this to false");
    assert.equal(lastBody.force_refresh, false, "opening must never pass force_refresh either");

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("BUG 13: a cache MISS on open renders the 'unchecked' resting state -- never 'searching', never notfound's hash-changed explanation", async () => {
  const kind = "loras";
  const name = "info-bug13-unchecked.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }),
  });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();

    const box = findAll(handle.overlay, "wtn-mi-status")[0];
    assert.ok(box, "the unchecked state DOES render a status box");
    assert.ok(box.classList.contains("wtn-mi-status-unchecked"), "must carry the unchecked cssState, not notfound/offline/searching");
    assert.equal(box.classList.contains("wtn-mi-status-notfound"), false, "must NOT read as notfound -- we never asked Civitai anything");
    assert.equal(box.classList.contains("wtn-mi-status-searching"), false);
    const headRow = findAll(box, "wtn-mi-status-head")[0];
    const headline = headRow.children[1]; // [icon, <b>headline]
    assert.equal(headline.textContent, "Not checked yet");
    const actionBtn = findAll(box, "wtn-mi-status-actions")[0].children[0];
    assert.equal(actionBtn.textContent, "↻ Civitai");

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("BUG 13: clicking the unchecked state's own '↻ Civitai' action performs a REAL forced lookup (cached_only:false), and transitions to found", async () => {
  const kind = "loras";
  const name = "info-bug13-check-click.safetensors";
  invalidateInfo(kind, name);
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (!body.force_refresh) {
      return { json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) };
    }
    return { json: async () => ({ reason: "found", offline_reason: null, message: "", data: { name: "X", model_id: 1, version_id: 2 } }) };
  };
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].cached_only, true, "the OPEN call stays cached_only:true");

    const box = findAll(handle.overlay, "wtn-mi-status")[0];
    const checkBtn = findAll(box, "wtn-mi-status-actions")[0].children[0];
    checkBtn.click();
    await settle();

    assert.equal(bodies.length, 2, "the click must issue a SECOND request");
    assert.equal(bodies[1].cached_only, false, "the explicit click is the ONLY thing allowed to send cached_only:false");
    assert.equal(bodies[1].force_refresh, true);

    // Transitioned to found -- the compact row (BUG 8), not the unchecked box.
    assert.equal(findAll(handle.overlay, "wtn-mi-status-unchecked").length, 0);
    assert.equal(findAll(handle.overlay, "wtn-mi-status-compact").length, 1);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

// ---------------------------------------------------------------------------
// BUG 20 (2026-07-29 owner report): "lookup still fires when the lora info
// menu is open" -- traced to a real request (BUG 13's cached_only:true read
// of the SERVER's own sidecar, never Civitai) firing on EVERY open of the
// SAME (kind, name), even when this session had already asked. Owner's
// chosen fix: read the sidecar at most ONCE per (kind, name) per session,
// then serve from the client-side (civitai_api.mjs) cache -- memoization,
// not removal (cached notes/triggers must still appear immediately on open).
// ---------------------------------------------------------------------------

await asyncTest("BUG 20: opening the SAME LoRA's panel twice issues exactly ONE request -- the second open renders instantly from the client cache", async () => {
  const kind = "loras";
  const name = "info-bug20-twice.safetensors";
  invalidateInfo(kind, name);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      json: async () => ({
        reason: "found",
        offline_reason: null,
        message: "",
        data: { name: "Bug20 Twice", triggers: ["bug20-word"], model_id: 1, version_id: 2 },
      }),
    };
  };
  try {
    const doc = makeDocStub();
    const handle1 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(fetchCalls, 1, "the first open issues exactly one request");
    assert.equal(findAll(handle1.overlay, "wtn-mi-title")[0].textContent, "Bug20 Twice");
    handle1.close();

    const handle2 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(fetchCalls, 1, "the SECOND open of the same (kind, name) must issue NO new request");
    // Cached notes/triggers still appear immediately -- memoization, not removal.
    assert.equal(findAll(handle2.overlay, "wtn-mi-title")[0].textContent, "Bug20 Twice");
    assert.equal(findAll(handle2.overlay, "wtn-mi-status-compact").length, 1, "the found compact row renders straight from cache");
    handle2.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

// =========================================================================
// C/E (task brief, 2026-07-31) -- lookup outcome / cache hit vs fetch /
// forget route through `js/shared/console_log.mjs`'s level-aware helper,
// tagged "LoRA info" (this surface's own tag).
// =========================================================================

await asyncTest("openModelInfo: at 'debug', a fresh lookup logs a fetch + its outcome; a SECOND open logs a cache hit; 'Clear cache' logs the forget", async () => {
  const kind = "loras";
  const name = "info-logging.safetensors";
  invalidateInfo(kind, name);
  const savedSettings = { [SETTING_IDS.CONSOLE_LOGGING]: "debug" };
  globalThis.window = { app: { extensionManager: { setting: { get: (id) => savedSettings[id] } } } };
  const logCalls = [];
  const origLog = console.log;
  console.log = (...args) => logCalls.push(args);
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "found", offline_reason: null, message: "",
      data: { name: "Logged LoRA", triggers: [], model_id: 1, version_id: 2 },
    }),
  });
  try {
    const doc = makeDocStub();
    const handle1 = openModelInfo({ ctx: { doc, getCanvasEl: () => null }, anchorEl: doc.createElement("button"), kind, name, civitaiEnabled: true });
    await settle();
    assert.ok(logCalls.every((c) => c[0] === "[AnimaFlow LoRA info]"), "every logged line is tagged with this surface's own tag");
    assert.ok(logCalls.some((c) => c.join(" ").includes("fetching (cache miss)")), "the first open logs a real fetch");
    assert.ok(logCalls.some((c) => c.join(" ").includes("lookup outcome = found")), "the outcome is logged");
    handle1.close();

    logCalls.length = 0;
    const handle2 = openModelInfo({ ctx: { doc, getCanvasEl: () => null }, anchorEl: doc.createElement("button"), kind, name, civitaiEnabled: true });
    await settle();
    assert.ok(logCalls.some((c) => c.join(" ").includes("cache hit (found)")), "the second open logs a cache hit, not a fetch");

    logCalls.length = 0;
    const clearBtn = findAll(handle2.overlay, "wtn-mi-status-compact-btn").find((b) => b.textContent === "Clear cache");
    assert.ok(clearBtn);
    clearBtn.click();
    await settle();
    assert.ok(logCalls.some((c) => c.join(" ").includes("forgot cached Civitai info")), "'Clear cache' logs the forget");
    handle2.close();
  } finally {
    console.log = origLog;
    delete globalThis.window;
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: at 'off' (the default), nothing is logged at all", async () => {
  const kind = "loras";
  const name = "info-logging-silent.safetensors";
  invalidateInfo(kind, name);
  const logCalls = [];
  const origLog = console.log;
  console.log = (...args) => logCalls.push(args);
  globalThis.fetch = async () => ({ json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({ ctx: { doc, getCanvasEl: () => null }, anchorEl: doc.createElement("button"), kind, name, civitaiEnabled: true });
    await settle();
    assert.equal(logCalls.length, 0, "no live app/setting reachable -- defaults to 'off', genuinely silent");
    handle.close();
  } finally {
    console.log = origLog;
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("BUG 20: a cache-MISS LoRA also issues exactly ONE request across repeated opens -- the 'nothing cached' answer is remembered too, not just a hit", async () => {
  const kind = "loras";
  const name = "info-bug20-miss.safetensors";
  invalidateInfo(kind, name);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) };
  };
  try {
    const doc = makeDocStub();
    const handle1 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(fetchCalls, 1);
    assert.ok(findAll(handle1.overlay, "wtn-mi-status-unchecked").length, "renders the unchecked resting state");
    handle1.close();

    const handle2 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(fetchCalls, 1, "a remembered MISS must not re-request on a later open either -- that was the worse case in the owner's own report");
    assert.ok(findAll(handle2.overlay, "wtn-mi-status-unchecked").length, "still reads as unchecked, replayed from the client cache");
    handle2.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("BUG 20: '↻ Civitai' always forces a REAL request (cached_only:false) even with a cached record already in hand, and the fresh record is what a later open replays", async () => {
  const kind = "loras";
  const name = "info-bug20-refetch.safetensors";
  invalidateInfo(kind, name);
  const bodies = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if (!body.force_refresh) {
      return { json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) };
    }
    return { json: async () => ({ reason: "found", offline_reason: null, message: "", data: { name: "Refetched", model_id: 9, version_id: 9 } }) };
  };
  try {
    const doc = makeDocStub();
    const handle1 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].cached_only, true, "the open call is still cache-only");

    const checkBtn = findAll(findAll(handle1.overlay, "wtn-mi-status")[0], "wtn-mi-status-actions")[0].children[0];
    checkBtn.click();
    await settle();
    assert.equal(bodies.length, 2, "the explicit click must force a SECOND, real request");
    assert.equal(bodies[1].cached_only, false, "the explicit click is the ONLY thing allowed to send cached_only:false");
    assert.equal(bodies[1].force_refresh, true);
    assert.equal(findAll(handle1.overlay, "wtn-mi-title")[0].textContent, "Refetched");
    handle1.close();

    // A later open replays the FRESH record -- no third request, and no
    // stale "unchecked" left over from before the click.
    const handle2 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(bodies.length, 2, "the later open must reuse the record the forced click just cached -- no third request");
    assert.equal(findAll(handle2.overlay, "wtn-mi-title")[0].textContent, "Refetched");
    handle2.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("BUG 20: 'Clear cache' evicts the CLIENT-side record too -- a subsequent open re-asks the server rather than keep showing the deleted data", async () => {
  const kind = "loras";
  const name = "info-bug20-clear.safetensors";
  invalidateInfo(kind, name);
  let fetchCalls = 0;
  let deleted = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/forget")) {
      deleted = true;
      return { json: async () => ({ reason: "ok", deleted: true }) };
    }
    fetchCalls += 1;
    // Simulates the sidecar genuinely being gone the SECOND time this is
    // actually asked (post-delete) -- if the client cache were NOT evicted,
    // this branch would never be reached at all, since the stale "found"
    // record would keep answering opens with no request whatsoever.
    if (deleted) {
      return { json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) };
    }
    return { json: async () => ({ reason: "found", offline_reason: null, message: "", data: { model_id: 1, version_id: 2 } }) };
  };
  try {
    const doc = makeDocStub();
    const handle1 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(fetchCalls, 1);
    const clearBtn = findAll(handle1.overlay, "wtn-mi-status-compact-btn").find((b) => b.textContent === "Clear cache");
    assert.ok(clearBtn);
    clearBtn.click();
    await settle();
    assert.ok(deleted, "Clear cache must call the /forget route");
    handle1.close();

    const handle2 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.equal(fetchCalls, 2, "a subsequent open must re-ask the server -- the client-side record was evicted along with the sidecar");
    assert.equal(findAll(handle2.overlay, "wtn-mi-status-compact").length, 0, "must NOT keep showing the just-deleted 'found' record");
    assert.ok(findAll(handle2.overlay, "wtn-mi-status-unchecked").length, "reflects the deletion -- reads as unchecked, not stale found");
    handle2.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: civitaiEnabled=false but a sidecar IS cached -- notes/title/Civitai trigger candidates still display (§7d)", async () => {
  const kind = "loras";
  const name = "info-dom-cached-off.safetensors";
  invalidateInfo(kind, name);
  let lastBody = null;
  globalThis.fetch = async (url, opts) => {
    lastBody = JSON.parse(opts.body);
    return {
      json: async () => ({
        reason: "found",
        offline_reason: null,
        message: "",
        data: {
          name: "Cached Display Name",
          triggers: ["cached civitai word"],
          model_description: "Cached author notes.",
          model_description_checked: true,
          model_id: 1,
          version_id: 2,
        },
        source: "sidecar",
      }),
    };
  };
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      fileTriggers: [],
      civitaiEnabled: false,
    });
    await settle();

    assert.equal(lastBody.cached_only, true);
    // Cached data displays...
    assert.equal(findAll(handle.overlay, "wtn-mi-title")[0].textContent, "Cached Display Name");
    assert.equal(findAll(handle.overlay, "wtn-mi-desc-model-body")[0].textContent, "Cached author notes.");
    assert.equal(findAll(handle.overlay, "wtn-mi-desc-version-body").length, 0, "no version note in this fixture -- no heading for it");
    // ...but the "way out" and any LIVE-lookup affordance stay hidden regardless.
    assert.equal(findAll(handle.overlay, "wtn-mi-civlink").length, 0);
    assert.equal(findAll(handle.overlay, "wtn-mi-status").length, 0);
    assert.equal(findAll(handle.overlay, "wtn-mi-refetch").length, 0);

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: descriptions' 'turn Civitai on' message shows ONLY when genuinely nothing is cached yet -- never merely because the setting is off", async () => {
  const kind = "loras";
  const nameNoCache = "info-notes-no-cache.safetensors";
  const nameCachedNoDesc = "info-notes-cached-no-desc.safetensors";
  invalidateInfo(kind, nameNoCache);
  invalidateInfo(kind, nameCachedNoDesc);

  // Case 1: off, and the cache genuinely misses -- no civitaiRecord at all,
  // so `descriptionsView` treats it exactly like `modelDescriptionChecked:
  // false` (its own doc comment).
  globalThis.fetch = async () => ({ json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name: nameNoCache,
      civitaiEnabled: false,
    });
    await settle();
    assert.equal(findAll(handle.overlay, "wtn-mi-desc-model-head").length, 0, "no confirmed heading -- nothing was ever found");
    assert.match(findAll(handle.overlay, "wtn-mi-desc-empty")[0].textContent, /turn the Civitai setting on/);
    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, nameNoCache);
  }

  // Case 2: off, but SOMETHING is cached (just no description in it,
  // `model_description_checked: false` -- BUG 2/§7d-i, 2026-07-29/30 owner
  // reports): this must read as "haven't been checked yet", NOT "this LoRA
  // has no notes" -- with Civitai off, `lookup.py`'s
  // `_augment_with_model_description` model-id fallback (the thing that
  // actually supplies the model's own description most of the time, since
  // the by-hash endpoint's embedded `model` object almost never carries one)
  // is exactly the network step this setting disables, so `checked: false`
  // is the literal, honest wire value here -- turning it on and re-checking
  // genuinely COULD reveal one.
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "found",
      offline_reason: null,
      message: "",
      data: { name: "X", model_description_checked: false },
      source: "sidecar",
    }),
  });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name: nameCachedNoDesc,
      civitaiEnabled: false,
    });
    await settle();
    const emptyText = findAll(handle.overlay, "wtn-mi-desc-empty")[0].textContent;
    assert.match(emptyText, /haven't been checked yet/);
    assert.match(emptyText, /turn the Civitai setting on/);
    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, nameCachedNoDesc);
  }
});

await asyncTest("openModelInfo: neither description, Civitai ENABLED, not yet checked -- points at the EXISTING ↻ Civitai footer button, never claims 'no description'", async () => {
  const kind = "loras";
  const name = "info-notes-unchecked-enabled.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({
      reason: "found",
      offline_reason: null,
      message: "",
      data: { name: "X", model_description_checked: false },
    }),
  });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    const emptyText = findAll(handle.overlay, "wtn-mi-desc-empty")[0].textContent;
    assert.match(emptyText, /Not looked up yet/);
    assert.match(emptyText, /↻ Civitai/, "points at the EXISTING footer button rather than inventing a new one");
    assert.doesNotMatch(emptyText, /no author's notes/i, "must never claim absence when we simply haven't asked");
    // The footer button it names really does exist (Pattern 1b: an empty
    // state that promises behaviour is a spec).
    assert.equal(findAll(handle.overlay, "wtn-mi-refetch").length, 1);
    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: found + Civitai ON + genuinely no description -- confirmed-absent wording, not 'haven't fetched yet'", async () => {
  const kind = "loras";
  const name = "info-notes-confirmed-empty.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({
    json: async () => ({ reason: "found", offline_reason: null, message: "", data: { name: "X", model_description_checked: true } }),
  });
  try {
    const doc = makeDocStub();
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: doc.createElement("button"),
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    const notesText = findAll(handle.overlay, "wtn-mi-desc-empty")[0].textContent;
    assert.match(notesText, /has no author's notes on Civitai/);
    assert.doesNotMatch(notesText, /haven't been checked/);
    assert.doesNotMatch(notesText, /not looked up yet/i);
    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: found state renders the COMPACT row (BUG 8), not the full status box, and 'Clear cache' posts /forget and returns the panel to a clean, un-found state", async () => {
  const kind = "loras";
  const name = "info-dom-e.safetensors";
  invalidateInfo(kind, name);
  let forgetCalled = false;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/forget")) {
      forgetCalled = true;
      return { json: async () => ({ reason: "ok", deleted: true }) };
    }
    return { json: async () => ({ reason: "found", offline_reason: null, message: "", data: { model_id: 1, version_id: 2 } }) };
  };
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();
    assert.ok(findAll(handle.overlay, "wtn-mi-civlink").length, "sanity: found a version before forgetting");

    // BUG 8: the `found` state is the COMPACT row, not the full status box --
    // no `wtn-mi-status`/`wtn-mi-status-actions` at all for this state.
    assert.equal(findAll(handle.overlay, "wtn-mi-status").length, 0, "found must not render the full status box");
    const compactRows = findAll(handle.overlay, "wtn-mi-status-compact");
    assert.equal(compactRows.length, 1, "found renders exactly one compact row");
    const compactLabel = findAll(handle.overlay, "wtn-mi-status-compact-label")[0];
    assert.equal(compactLabel.children[0].textContent, "Matched on Civitai");

    const forgetBtn = findAll(handle.overlay, "wtn-mi-status-compact-btn").find((b) => b.textContent === "Clear cache");
    assert.ok(forgetBtn, "found state must offer 'Clear cache' (renamed from 'Forget cached')");
    assert.equal(
      findAll(handle.overlay, "wtn-mi-status-compact-btn").find((b) => b.textContent === "Re-fetch"),
      undefined,
      "'Re-fetch' must be GONE from the compact row -- the footer's own ↻ Civitai already does this",
    );
    forgetBtn.click();
    await settle();

    assert.ok(forgetCalled);
    assert.equal(findAll(handle.overlay, "wtn-mi-civlink").length, 0, "the link disappears once forgotten");
    assert.equal(findAll(handle.overlay, "wtn-mi-status-compact").length, 0, "the compact row disappears once forgotten (state reverts to idle)");

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("openModelInfo: a second call with the SAME ownerKey toggles the panel closed", async () => {
  const kind = "loras";
  const name = "toggle.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async () => ({ json: async () => ({ reason: "offline", offline_reason: "civitai_disabled", message: "", data: null }) });
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle1 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      ownerKey: "test-toggle-key",
      civitaiEnabled: false,
    });
    assert.ok(handle1);
    const handle2 = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      ownerKey: "test-toggle-key",
      civitaiEnabled: false,
    });
    assert.equal(handle2, null, "opening the SAME panel a second time just closes it");
    await settle(); // let the first (now-cancelled) lookup's promise resolve harmlessly
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

// ---------------------------------------------------------------------------
// Owner-reported bug (2026-07-30): "fixed on all except lora info as its
// shown correctly but after info loaded it expand and then overflows" -- the
// ⓘ panel is the one popover whose content changes ASYNCHRONOUSLY, well
// after `openOverlay`'s own initial placement already ran against a
// near-empty box, and nothing used to tell the overlay to look again once
// the real (taller) content landed.
//
// `makeGrowableDocStub`/`makeGrowableElement`, below, are a SEPARATE stub
// family from `makeDocStub` above -- same "each track/test keeps its own
// minimal doc stub" convention this file's own top doc comment already
// follows, and the same two-stub-per-file split `js/shared/test_overlay.mjs`
// uses (`makeElement`+`makeDocStub` for wheel tests, `makeLayoutElement`+
// `makeLayoutDocStub` for geometry tests) -- `makeDocStub`'s own
// `getBoundingClientRect` returns the SAME fixed rect for every element
// regardless of content, which is exactly right for every OTHER test in this
// file (none of them ever assert real pixel placement) but useless for a
// test that must observe whether the panel's OWN measured height actually
// grew and whether `reposition()` reacted to that. `makeGrowableElement`'s
// height is instead `BASE_HEIGHT + (recursive descendant count) *
// PER_NODE_HEIGHT` -- i.e. it grows exactly when the SUT actually appends
// more real DOM nodes (a status box, two description sections, more trigger
// chips), the same mechanism a real browser's layout would react to, without
// this test file needing to hand-roll a full box model. Its `left`/`top` sum
// the real `parentNode` chain (mirrors `makeLayoutElement` in
// `test_overlay.mjs`), so the PANEL's own rect reflects wherever
// `reposition()` most recently placed the OVERLAY that wraps it.
// ---------------------------------------------------------------------------

const GROWABLE_BASE_HEIGHT = 40;
const GROWABLE_PER_NODE_HEIGHT = 6;
const GROWABLE_PANEL_WIDTH = 336;

function countDescendants(e) {
  let n = 0;
  for (const c of e.children || []) {
    n += 1 + countDescendants(c);
  }
  return n;
}

function makeGrowableDocStub() {
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
        // Absolute position: sum this element's own chain of ancestor
        // `style.left`/`style.top` -- only the overlay div itself ever gets
        // an explicit one (from `reposition()`), everything inside it
        // (including this panel) sits unstyled, exactly like the real DOM.
        let left = 0;
        let top = 0;
        let node = e;
        while (node) {
          left += parseFloat(node.style && node.style.left) || 0;
          top += parseFloat(node.style && node.style.top) || 0;
          node = node.parentNode;
        }
        const width = e.style.width ? parseFloat(e.style.width) : GROWABLE_PANEL_WIDTH;
        const height = GROWABLE_BASE_HEIGHT + countDescendants(e) * GROWABLE_PER_NODE_HEIGHT;
        return { left, top, right: left + width, bottom: top + height, width, height };
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
    // Synchronous, like every other stub timer in this pack's tests (e.g.
    // `test_overlay.mjs`'s own `setTimeout: (fn) => fn()`) -- there's no real
    // paint to wait for under `node`, so `repositionAfterChange`'s own
    // "one frame later" re-measure happens on the very next microtask/tick
    // instead, which is enough to prove the SEQUENCING (measure -> mutate ->
    // re-measure -> reposition) without a real render loop.
    requestAnimationFrame: (cb) => cb(),
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

await asyncTest("THE reported bug: async Civitai content landing after open grows the panel, and it is re-clamped so its bottom edge stays inside the viewport", async () => {
  const kind = "loras";
  const name = "info-growth-bug.safetensors";
  invalidateInfo(kind, name);
  let resolveFetch;
  const pending = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  globalThis.fetch = async () => pending;
  try {
    const doc = makeGrowableDocStub();
    // Anchored low in an 800px-tall viewport -- exactly the case the owner
    // hit: a small/placeholder panel fits there, a grown one does not
    // unless something re-clamps it.
    const anchor = doc.createElement("button");
    anchor.getBoundingClientRect = () => ({ left: 900, top: 620, right: 1050, bottom: 650, width: 150, height: 30 });
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      fileTriggers: [],
      civitaiEnabled: true,
    });
    await settle(2);

    const panel = findAll(handle.overlay, "wtn-mi-panel")[0];
    const viewportBottomLimit = 800 - 4; // OVERLAY_EDGE_MARGIN_PX
    const beforeRect = panel.getBoundingClientRect();
    assert.ok(beforeRect.bottom <= viewportBottomLimit, "sanity: the SMALL/placeholder panel is already placed correctly on open (the owner's own 'shown correctly' half)");

    // The Civitai lookup resolves asynchronously, well after open, with a
    // much taller body: a found record, several trigger words, and BOTH
    // description sections.
    resolveFetch({
      json: async () => ({
        reason: "found",
        offline_reason: null,
        message: "",
        data: {
          name: "Grown Model",
          triggers: ["alpha", "beta", "gamma", "delta", "epsilon"],
          model_description: "A".repeat(400),
          version_description: "B".repeat(400),
          model_description_checked: true,
          model_id: 1,
          version_id: 2,
        },
      }),
    });
    await settle(5);

    const afterRect = panel.getBoundingClientRect();
    assert.ok(afterRect.height > beforeRect.height, "sanity: the panel's own content genuinely grew");
    assert.ok(
      afterRect.bottom <= viewportBottomLimit,
      `the panel's visible bottom edge (${afterRect.bottom}) must stay inside the viewport (<= ${viewportBottomLimit}) after growing`,
    );

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("the async lookup resolving AFTER the panel was closed does not throw and never repositions a detached panel", async () => {
  const kind = "loras";
  const name = "info-growth-closed.safetensors";
  invalidateInfo(kind, name);
  let resolveForget;
  const pendingForget = new Promise((resolve) => {
    resolveForget = resolve;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes("/forget")) {
      return pendingForget;
    }
    return { json: async () => ({ reason: "found", offline_reason: null, message: "", data: { model_id: 1, version_id: 2 } }) };
  };
  try {
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();

    // Spy on `reposition` -- `repositionAfterChange` reads `handle.
    // reposition` fresh at call time, so replacing it here intercepts every
    // future call the same way a real caller's own instrumentation would.
    let repositionCalls = 0;
    const origReposition = handle.reposition;
    handle.reposition = (...args) => {
      repositionCalls += 1;
      return origReposition(...args);
    };

    // "Clear cache" starts a forget request that won't resolve until this
    // test says so -- long enough to close the panel while it's in flight.
    const forgetBtn = findAll(handle.overlay, "wtn-mi-status-compact-btn").find((b) => b.textContent === "Clear cache");
    assert.ok(forgetBtn, "sanity: the found state's Clear cache button exists");
    forgetBtn.click();

    handle.close();
    assert.equal(handle.overlay.parentNode, null, "sanity: close() really did detach the overlay");

    // NOW the async forget resolves, well after the user already dismissed
    // the popover -- this must not throw, and must not reposition a panel
    // that's no longer attached to anything.
    assert.doesNotThrow(() => resolveForget({ json: async () => ({ reason: "ok", deleted: true }) }));
    await settle();

    assert.equal(repositionCalls, 0, "a closed/detached panel must never be repositioned");
    assert.equal(handle.overlay.parentNode, null, "still detached -- nothing re-attached it");
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

await asyncTest("content that does NOT change size does not cause a spurious re-place", async () => {
  const kind = "loras";
  const name = "info-growth-nochange.safetensors";
  invalidateInfo(kind, name);
  globalThis.fetch = async (url) => {
    if (String(url).includes("/forget")) {
      return { json: async () => ({ reason: "ok", deleted: true }) };
    }
    return { json: async () => ({ reason: "found", offline_reason: null, message: "", data: { model_id: 1, version_id: 2 } }) };
  };
  try {
    // The plain, fixed-rect `makeDocStub` -- every element (including the
    // panel) reports the SAME height regardless of content, so this is
    // "content that does not change size" by construction: any wrapped
    // call site that fires here has nothing to react to.
    const doc = makeDocStub();
    const anchor = doc.createElement("button");
    const handle = openModelInfo({
      ctx: { doc, getCanvasEl: () => null },
      anchorEl: anchor,
      kind,
      name,
      civitaiEnabled: true,
    });
    await settle();

    let repositionCalls = 0;
    const origReposition = handle.reposition;
    handle.reposition = (...args) => {
      repositionCalls += 1;
      return origReposition(...args);
    };

    // "Clear cache" -> runForget() -> renderStatus/renderIdentity/
    // renderTriggers/renderDescriptions all re-run, but the (fixed-rect)
    // panel measures identically before and after.
    const forgetBtn = findAll(handle.overlay, "wtn-mi-status-compact-btn").find((b) => b.textContent === "Clear cache");
    assert.ok(forgetBtn);
    forgetBtn.click();
    await settle();

    assert.equal(repositionCalls, 0, "same-size content must never trigger a spurious reposition() call");

    handle.close();
  } finally {
    globalThis.fetch = _origFetch;
    invalidateInfo(kind, name);
  }
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
