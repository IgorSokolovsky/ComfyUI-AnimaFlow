/**
 * test_model_detail_view.mjs — regression tests for `model_detail_view.mjs`,
 * the ONE model/version detail-view component mounted twice (`docs/lora-
 * loader-design.md` §7c-ii / "The detail view" / §7d-i / §7d). Plain
 * `node js/controls/test_model_detail_view.mjs`.
 *
 * Covers: the pure version-label/date/description/gallery-level/load-gate
 * helpers, and a DOM-level integration test of `buildModelDetailView` itself
 * (via a minimal stub DOM, mirroring `test_civitai_search.mjs`'s own
 * `makeDocStub`) proving -- per the task brief -- that this is genuinely ONE
 * component rendering in both layouts, a version switch changes which
 * version's data/download target is shown, both descriptions are labelled
 * and never invent one from the other, `View on Civitai ↗` points at the
 * selected version, the gallery is level-filtered (with `locked` where
 * appropriate), a hostile prompt renders as inert text, copy-prompt copies
 * the real prompt, a meta-less image shows no hover overlay, and the
 * gallery's own load gate genuinely caps concurrency (not just claims to).
 */

import assert from "node:assert/strict";

import {
  versionOptionLabel,
  formatDateLabel,
  detailDescriptionsView,
  visibleGalleryEntries,
  galleryState,
  galleryParamsLabel,
  createLoadGate,
  buildModelDetailView,
  injectStyles,
} from "./model_detail_view.mjs";

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

// ---------------------------------------------------------------------------
// A minimal stub DOM -- same shape as test_civitai_search.mjs's own
// makeDocStub, duplicated per this file's own convention (every render
// module's test file in this pack builds its own).
// ---------------------------------------------------------------------------

function makeDocStub() {
  let doc;
  function makeElement(tag) {
    const e = {
      tagName: String(tag).toLowerCase(),
      _listeners: {},
      children: [],
      style: {},
      value: "",
      textContent: "",
      title: "",
      type: "",
      href: "",
      target: "",
      rel: "",
      disabled: false,
      selected: false,
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
        return { left: 10, top: 10, right: 30, bottom: 40, width: 20, height: 30 };
      },
      focus() {},
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
  doc = {
    createElement: makeElement,
    getElementById() {
      return null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
    defaultView: { innerWidth: 1200, innerHeight: 800 },
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
  if (!e) {
    return "";
  }
  if (e.children && e.children.length) {
    return e.children.map(textOf).join("");
  }
  return e.textContent || "";
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

test("versionOptionLabel: name + size when both known", () => {
  assert.equal(versionOptionLabel({ name: "v3.0", version_id: 3, size_kb: 144 * 1024 }), "v3.0 — 144 MB");
});

test("versionOptionLabel: falls back to #id, omits size when unknown", () => {
  assert.equal(versionOptionLabel({ version_id: 7 }), "#7");
});

test("versionOptionLabel: garbage input never throws", () => {
  assert.equal(versionOptionLabel(null), "");
  assert.equal(versionOptionLabel("not-an-object"), "");
});

test("formatDateLabel: ISO datetime -> stable YYYY-MM-DD, locale-independent", () => {
  assert.equal(formatDateLabel("2026-07-29T10:00:00.000Z"), "2026-07-29");
});

test("formatDateLabel: garbage/unusable input is empty string, never throws", () => {
  assert.equal(formatDateLabel(""), "");
  assert.equal(formatDateLabel(null), "");
  assert.equal(formatDateLabel("not-a-date"), "");
});

test("detailDescriptionsView: both present -- returned distinctly, never merged", () => {
  const view = detailDescriptionsView({ modelDescription: "Model write-up.", versionDescription: "Trained on preview3." });
  assert.equal(view.model, "Model write-up.");
  assert.equal(view.version, "Trained on preview3.");
  assert.equal(view.emptyMessage, null);
});

test("detailDescriptionsView: only model description present never invents a version one", () => {
  const view = detailDescriptionsView({ modelDescription: "Model write-up.", versionDescription: null });
  assert.equal(view.model, "Model write-up.");
  assert.equal(view.version, null);
  assert.equal(view.emptyMessage, null);
});

test("detailDescriptionsView: only version description present never invents a model one", () => {
  const view = detailDescriptionsView({ modelDescription: null, versionDescription: "Trained on preview3." });
  assert.equal(view.model, null);
  assert.equal(view.version, "Trained on preview3.");
});

test("detailDescriptionsView: neither present, loading -> a loading message, no invented content", () => {
  const view = detailDescriptionsView({ modelDescription: null, versionDescription: null, loading: true });
  assert.equal(view.model, null);
  assert.equal(view.version, null);
  assert.match(view.emptyMessage, /loading/i);
});

test("detailDescriptionsView: neither present, checked -- an honest 'none' line", () => {
  const view = detailDescriptionsView({ modelDescriptionChecked: true });
  assert.match(view.emptyMessage, /no description/i);
});

test("detailDescriptionsView: neither present, not checked -- invites a retry, never claims 'none'", () => {
  const view = detailDescriptionsView({ modelDescriptionChecked: false });
  assert.doesNotMatch(view.emptyMessage, /no description/i);
});

test("visibleGalleryEntries: filters by the entry's own nsfw_level, same rule as pickThumbCandidates", () => {
  const gallery = [
    { url: "a.jpg", nsfw_level: 1 },
    { url: "b.jpg", nsfw_level: 8 },
    { url: "c.jpg" }, // absent -- treated as 16, never leaks
  ];
  assert.deepEqual(visibleGalleryEntries(gallery, 1).map((e) => e.url), ["a.jpg"]);
  assert.deepEqual(visibleGalleryEntries(gallery, 8).map((e) => e.url), ["a.jpg", "b.jpg"]);
});

test("visibleGalleryEntries: garbage input degrades to empty, never throws", () => {
  assert.deepEqual(visibleGalleryEntries(null, 1), []);
  assert.deepEqual(visibleGalleryEntries("not-a-list", 1), []);
});

test("galleryState: locked when every entry is above the chosen level", () => {
  const gallery = [{ url: "a.jpg", nsfw_level: 16 }];
  assert.equal(galleryState(gallery, 1, null), "locked");
});

test("galleryState: image when at least one entry passes", () => {
  const gallery = [{ url: "a.jpg", nsfw_level: 1 }, { url: "b.jpg", nsfw_level: 16 }];
  assert.equal(galleryState(gallery, 1, null), "image");
});

test("galleryState: placeholder for a genuinely empty gallery with no known nsfw_level union", () => {
  assert.equal(galleryState([], 1, null), "placeholder");
});

test("galleryState: an empty gallery with a model-level nsfw_level above the ceiling is locked, not placeholder", () => {
  // Same §7c-iv trap `thumbState` itself guards against -- an empty `images`
  // list can mean "server trimmed the gallery to nothing at this level",
  // not "genuinely no gallery".
  assert.equal(galleryState([], 1, 16), "locked");
});

test("galleryParamsLabel: only the fields actually present, never an invented placeholder", () => {
  assert.equal(galleryParamsLabel({ sampler: "Euler a", steps: 20, cfg: 7, size: "832x1216" }), "Euler a · 20 steps · CFG 7 · 832x1216");
  assert.equal(galleryParamsLabel({ sampler: "Euler a" }), "Euler a");
  assert.equal(galleryParamsLabel({}), "");
  assert.equal(galleryParamsLabel(null), "");
});

// ---------------------------------------------------------------------------
// createLoadGate -- proves the cap is REAL, not merely claimed (the false-
// green-verification skill's own rule: exercise the actual gating behaviour,
// not just that the function exists).
// ---------------------------------------------------------------------------

test("createLoadGate: never runs more than maxConcurrent tasks at once", () => {
  const gate = createLoadGate(2);
  const releases = [];
  for (let i = 0; i < 5; i += 1) {
    gate.schedule((release) => {
      releases.push(release);
    });
  }
  assert.equal(gate.activeCount, 2, "only 2 of 5 tasks should have started");
  assert.equal(gate.pendingCount, 3);
  releases[0](); // free one slot
  assert.equal(gate.activeCount, 2, "a freed slot is immediately re-filled by the next queued task");
  assert.equal(gate.pendingCount, 2);
  assert.equal(releases.length, 3, "the 3rd task should have started the instant a slot freed");
});

test("createLoadGate: releasing every task eventually drains the queue", () => {
  const gate = createLoadGate(1);
  const releases = [];
  for (let i = 0; i < 3; i += 1) {
    gate.schedule((release) => releases.push(release));
  }
  assert.equal(gate.activeCount, 1);
  releases[0]();
  assert.equal(releases.length, 2);
  releases[1]();
  assert.equal(releases.length, 3);
  releases[2]();
  assert.equal(gate.activeCount, 0);
  assert.equal(gate.pendingCount, 0);
});

test("createLoadGate: a garbage/zero maxConcurrent degrades to 1, never hangs", () => {
  const gate = createLoadGate(0);
  let started = 0;
  gate.schedule(() => { started += 1; });
  assert.equal(started, 1);
});

// ---------------------------------------------------------------------------
// buildModelDetailView -- DOM integration.
// ---------------------------------------------------------------------------

function makeTwoVersionResult() {
  return {
    model_id: 100,
    name: "Realistic Skin Detail",
    creator: "someartist",
    type: "LORA",
    tags: ["character"],
    nsfw_level: null,
    stats: { downloads: 12400, favorites: 300, rating: 4.8 },
    versions: [
      {
        version_id: 3, name: "v3.0", base_model: "SDXL", published_at: "2026-07-29T00:00:00.000Z",
        gated: false, file_name: "skin_v3.safetensors", download_url: "https://civitai.com/dl/v3", size_kb: 144 * 1024,
        triggers: [], preview_url: null, images: [{ url: "v3.jpg", nsfw_level: 1, type: "image" }],
      },
      {
        version_id: 2, name: "v2.0", base_model: "SD1.5", published_at: "2026-06-01T00:00:00.000Z",
        gated: false, file_name: "skin_v2.safetensors", download_url: "https://civitai.com/dl/v2", size_kb: 100 * 1024,
        triggers: [], preview_url: null, images: [{ url: "v2.jpg", nsfw_level: 1, type: "image" }],
      },
    ],
  };
}

test("buildModelDetailView: the SAME component renders in BOTH layouts (one component, mounted twice)", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const detail = { status: "loaded", gallery: [{ url: "a.jpg", nsfw_level: 1 }], modelDescriptionChecked: true };
  const vertical = buildModelDetailView({ doc, layout: "vertical", result, versionId: 3, browsingLevel: 1, detail });
  const grid = buildModelDetailView({ doc, layout: "grid", result, versionId: 3, browsingLevel: 1, detail });
  assert.equal(findAll(vertical.el, "wtn-dv-title").length, 1);
  assert.equal(findAll(grid.el, "wtn-dv-title").length, 1);
  assert.equal(textOf(findAll(vertical.el, "wtn-dv-title")[0]), textOf(findAll(grid.el, "wtn-dv-title")[0]));
  // The only real difference is the gallery container's own layout class.
  assert.equal(findAll(vertical.el, "wtn-dv-gallery-vertical").length, 1);
  assert.equal(findAll(grid.el, "wtn-dv-gallery-grid").length, 1);
});

test("buildModelDetailView: version selector lists every version and switching calls onVersionChange", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  let changedTo = null;
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    onVersionChange: (id) => { changedTo = id; },
  });
  const sel = findAllByTag(el, "select").find((s) => s.classList.contains("wtn-dv-version-sel"));
  assert.ok(sel, "a version <select> must be present");
  assert.equal(sel.children.length, 2);
  sel.value = "2";
  sel.dispatch("change", { stopPropagation() {} });
  assert.equal(changedTo, 2);
});

test("buildModelDetailView: switching versions changes the download target (buildActionEl's own view)", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const seenFileNames = [];
  const opts = (versionId) => ({
    doc, result, versionId, browsingLevel: 1,
    buildActionEl: (d, view) => {
      seenFileNames.push(view.file_name);
      return d.createElement("div");
    },
  });
  buildModelDetailView(opts(3));
  buildModelDetailView(opts(2));
  assert.deepEqual(seenFileNames, ["skin_v3.safetensors", "skin_v2.safetensors"]);
});

test("buildModelDetailView: 'View on Civitai ↗' points at the SELECTED version, not the model's bare page", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const v3 = buildModelDetailView({ doc, result, versionId: 3, browsingLevel: 1 });
  const v2 = buildModelDetailView({ doc, result, versionId: 2, browsingLevel: 1 });
  const link3 = findAll(v3.el, "wtn-dv-civlink")[0];
  const link2 = findAll(v2.el, "wtn-dv-civlink")[0];
  assert.match(link3.href, /modelVersionId=3/);
  assert.match(link2.href, /modelVersionId=2/);
  assert.match(link3.href, /civitai\.com\/models\/100/);
});

test("buildModelDetailView: both descriptions render under their OWN label; only one present never invents the other", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", modelDescription: "The author's write-up.", versionDescription: null, modelDescriptionChecked: true, gallery: [] },
  });
  const headings = findAll(el, "wtn-dv-sechead").map(textOf);
  assert.ok(headings.includes("Model Description"));
  assert.ok(!headings.includes("Version Description"));
  const bodies = findAll(el, "wtn-dv-desc").map(textOf);
  assert.deepEqual(bodies, ["The author's write-up."]);
});

test("buildModelDetailView: the gallery is level-filtered, and shows 'locked' where appropriate", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = [{ url: "explicit.jpg", nsfw_level: 16 }];
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1, // PG
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  assert.equal(findAll(el, "wtn-dv-gallery-locked").length, 1);
  assert.equal(findAll(el, "wtn-dv-gimg").length, 0, "an above-level image must never render into the grid");
});

test("buildModelDetailView: a hostile prompt (raw HTML + a lora tag) renders as INERT plain text", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const hostilePrompt = "1girl <lora:example:0.8>, <script>alert(1)</script>";
  const gallery = [{ url: "a.jpg", nsfw_level: 1, prompt: hostilePrompt }];
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  const promptEl = findAll(el, "wtn-dv-gprompt")[0];
  assert.ok(promptEl, "a prompt-carrying entry must render a prompt element");
  assert.equal(promptEl.textContent, hostilePrompt, "the raw string must survive VERBATIM as textContent");
  assert.equal(promptEl.children.length, 0, "textContent must never be parsed into child elements (never innerHTML)");
});

test("buildModelDetailView: copy-prompt copies the ACTUAL prompt text", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = [{ url: "a.jpg", nsfw_level: 1, prompt: "1girl, masterpiece" }];
  let copied = null;
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
    onCopyPrompt: (text) => { copied = text; },
  });
  const copyBtn = findAll(el, "wtn-dv-gcopy")[0];
  assert.ok(copyBtn, "a prompt-carrying entry must render a copy-prompt button");
  copyBtn.dispatch("click", { stopPropagation() {} });
  assert.equal(copied, "1girl, masterpiece");
});

test("buildModelDetailView: an image with no meta degrades cleanly -- no hover overlay at all, never an empty one", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = [{ url: "a.jpg", nsfw_level: 1 }]; // no `prompt` key -- the community-shaped `meta: {}` case
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  assert.equal(findAll(el, "wtn-dv-gimg").length, 1, "the image itself must still render");
  assert.equal(findAll(el, "wtn-dv-goverlay").length, 0, "no overlay element at all for a meta-less image");
});

test("buildModelDetailView: the gallery lazy-loads through a REAL concurrency gate (not merely claimed)", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = Array.from({ length: 6 }, (_, i) => ({ url: `img${i}.jpg`, nsfw_level: 1 }));
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1, galleryConcurrency: 2,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  const boxes = findAll(el, "wtn-dv-gbox");
  assert.equal(boxes.length, 6);
  const withImg = () => boxes.filter((b) => findAllByTag(b, "img").length > 0);
  assert.equal(withImg().length, 2, "only maxConcurrent images should have started loading");
  // Simulate the FIRST attached image finishing (onload) -- a slot frees and
  // a third image should start.
  const firstImg = findAllByTag(boxes[0], "img")[0];
  assert.ok(firstImg, "the first box should already have an <img> attached");
  firstImg.onload();
  assert.equal(withImg().length, 3, "a freed slot must let the next queued image start immediately");
});

// =========================================================================
// Owner-reported bug (2026-08-01): "the details panel is not scrollable
// (didn't it should show also gallery?)" -- the gallery WAS built, just
// unreachable. There is no real CSS layout engine in a plain-`node` test (no
// jsdom here), so a bounded scroll box can't be measured directly -- these
// assert the SHAPE that makes one possible instead: the pinned/scrolling
// split actually exists in the DOM (not merely in the stylesheet text), AND
// -- the coordinator's own warning, verbatim -- every ancestor in the chain
// carries the `min-height: 0` a flex child needs to ever shrink below its
// content, not just the leaf's `overflow-y: auto` (a test asserting ONLY
// that property would pass with the bug fully present, since a flex child's
// default `min-height: auto` silently defeats it further up the chain).
// =========================================================================

test("buildModelDetailView: identity/civlink/version-selector/download action are pinned in .wtn-dv-header; descriptions/gallery/back are in the scrolling .wtn-dv-body -- not one flat column", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery: [{ url: "v3.jpg", nsfw_level: 1 }], modelDescription: "Model write-up.", modelDescriptionChecked: true },
    buildActionEl: (d) => {
      const b = d.createElement("button");
      b.className = "wtn-cs-action";
      return b;
    },
    onBack: () => {},
  });
  const header = findAll(el, "wtn-dv-header")[0];
  const body = findAll(el, "wtn-dv-body")[0];
  assert.ok(header, "a pinned header region must exist");
  assert.ok(body, "a scrolling body region must exist");
  // Root's only two children are these two regions, in this order -- header
  // first (pinned, always visible), body second (the part that scrolls).
  assert.deepEqual(el.children.map((c) => c.className), ["wtn-dv-header", "wtn-dv-body"]);

  // The pinned set, verbatim (task brief): identity, View on Civitai, the
  // version selector, the download action.
  assert.equal(findAll(header, "wtn-dv-title").length, 1, "identity belongs in the header");
  assert.equal(findAll(header, "wtn-dv-civlink").length, 1, "View on Civitai belongs in the header");
  assert.equal(findAll(header, "wtn-dv-version-sel").length, 1, "the version selector belongs in the header");
  assert.equal(findAll(header, "wtn-cs-action").length, 1, "the download action belongs in the header");

  // Everything that can grow unboundedly (a long description, a big
  // gallery) belongs in the SCROLLING body, never the pinned header.
  assert.equal(findAll(body, "wtn-dv-desc").length, 1, "descriptions belong in the scrolling body");
  assert.equal(findAll(body, "wtn-dv-gimg").length, 1, "the gallery belongs in the scrolling body");
  assert.equal(findAll(body, "wtn-dv-back").length, 1, "the back affordance belongs in the scrolling body");
  assert.equal(findAll(header, "wtn-dv-desc").length, 0, "a description must never leak into the pinned header");
  assert.equal(findAll(header, "wtn-dv-gimg").length, 0, "the gallery must never leak into the pinned header");
});

test("BUG (owner, 2026-08-01): every ancestor in the scroll chain carries min-height: 0, not just .wtn-dv-body's own overflow-y -- the exact trap that silently defeats it", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  assert.ok(styleEl, "injectStyles must append a <style> tag to <head>");
  const css = styleEl.textContent;

  // The leaf: bounded AND scrollable. Asserting `overflow-y: auto` ALONE
  // here is exactly the insufficient test the task brief warns about --
  // paired with `min-height: 0` and `flex: 1 1 auto` so it actually has a
  // bounded box to scroll inside of.
  assert.match(
    css,
    /\.wtn-dv-body\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;?/,
    "the scrolling body must be flex: 1 1 auto + min-height: 0 + overflow-y: auto together",
  );
  // The header must never grow/shrink and steal the body's space.
  assert.match(css, /\.wtn-dv-header\s*\{[^}]*flex:\s*none;?/, "the pinned header must be flex: none");
  // The root itself -- the ancestor a step above BOTH -- must also carry
  // min-height: 0, or a bounded mount (the picker's own capped panel) could
  // never hand a bounded box down to `.wtn-dv-body` in the first place.
  assert.match(
    css,
    /\.wtn-dv\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;?/,
    "the root itself must also be min-height: 0 so a bounded mount can actually constrain it",
  );
});

// =========================================================================
// Owner-reported (2026-08-01): the gallery's prompt-on-hover overlay should
// read as a DRAWER sitting over the image (a semi-transparent black scrim +
// a top border), not text floating on a gradient.
// =========================================================================

test("owner-reported (2026-08-01): the gallery prompt/params/copy sit inside ONE drawer surface -- a dark, legible scrim with a top border, not the old gradient", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = [{ url: "v3.jpg", nsfw_level: 1, prompt: "1girl, forest" }];
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  const drawer = findAll(el, "wtn-dv-gdrawer")[0];
  assert.ok(drawer, "the prompt/params/copy must be wrapped in a single drawer element");
  // Everything that used to sit loose in the overlay now lives INSIDE the drawer.
  assert.equal(findAll(drawer, "wtn-dv-gprompt").length, 1);
  assert.equal(findAll(drawer, "wtn-dv-gcopy").length, 1);

  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const css = styleEl.textContent;
  const drawerRule = css.match(/\.wtn-dv-gdrawer\s*\{([^}]*)\}/)[1];
  // A legible, near-opaque scrim -- NOT the owner's own suggested .1-.2
  // (a screenshot showed that range is illegible over a busy image); a black
  // background whose alpha channel is comfortably above .5.
  const alphaMatch = drawerRule.match(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/);
  assert.ok(alphaMatch, "the drawer's background must be a black rgba(...) scrim");
  assert.ok(Number(alphaMatch[1]) >= 0.5, "the scrim must be well above the owner's own suggested .1-.2 -- that range is illegible over a bright/busy image");
  // A top border, matching this pack's own line-colour vocabulary
  // (js/shared/theme.css's --wtn-line), never an invented colour.
  assert.match(drawerRule, /border-top:\s*1px solid var\(--wtn-line,/, "the drawer edge must use this pack's own --wtn-line token");
});

test("owner-reported (2026-08-01): an image with no meta still shows no drawer at all -- the fix must not force one onto every image", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = [{ url: "a.jpg", nsfw_level: 1 }]; // no `prompt` key
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  assert.equal(findAll(el, "wtn-dv-gdrawer").length, 0, "no prompt means no drawer, exactly like no overlay before this fix");
});

// =========================================================================
// Owner-reported (2026-08-01), corrected same day to modal-only: "back to
// results ... should be in the top navigation bar, which should be fixed
// position, which should also show the download button and the version
// selection." `fixedTopBar: true` is the MODAL's own shape -- `← results` +
// version selector + download, pinned together on one row, everything else
// (identity, View on Civitai, descriptions, gallery) scrolls beneath. The
// picker's default (`fixedTopBar` omitted/false) keeps the ORIGINAL header
// shape, covered by the "identity/civlink/version-selector/download action
// are pinned in .wtn-dv-header" test above -- unchanged by this.
// =========================================================================

test("buildModelDetailView: fixedTopBar -- '← results', the version selector and the download action are ALL pinned together in .wtn-dv-topbar, on one row, reachable without scrolling; everything else (identity, View on Civitai, descriptions, gallery) is in the scrolling body", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1, fixedTopBar: true,
    detail: { status: "loaded", gallery: [{ url: "v3.jpg", nsfw_level: 1 }], modelDescription: "Model write-up.", modelDescriptionChecked: true },
    buildActionEl: (d) => {
      const b = d.createElement("button");
      b.className = "wtn-cs-action";
      return b;
    },
    onBack: () => {},
  });
  const topbar = findAll(el, "wtn-dv-topbar")[0];
  const body = findAll(el, "wtn-dv-body")[0];
  assert.ok(topbar, "a fixed top bar must exist when fixedTopBar is true");
  assert.ok(body, "a scrolling body region must still exist");
  assert.deepEqual(el.children.map((c) => c.className), ["wtn-dv-topbar", "wtn-dv-body"], "the topbar is the FIRST child, pinned above the scrolling body");

  // All three controls, reachable without ever touching the scrolling body.
  assert.equal(findAll(topbar, "wtn-dv-back").length, 1, "'← results' belongs in the fixed topbar, not the scroll");
  assert.equal(findAll(topbar, "wtn-dv-version-sel").length, 1, "the version selector belongs in the fixed topbar");
  assert.equal(findAll(topbar, "wtn-cs-action").length, 1, "the download action belongs in the fixed topbar");
  // Order, per the task brief: back, then version, then download.
  const topbarClasses = topbar.children.map((c) => c.className);
  assert.deepEqual(topbarClasses, ["wtn-dv-back", "wtn-dv-versionrow", "wtn-dv-actionhost"]);

  // Identity/View on Civitai/descriptions/gallery all moved INTO the
  // scrolling body -- the modal's actual complaint was scrolling past a
  // whole description just to reach '← results', so none of these three
  // controls may be duplicated or left behind in the body either.
  assert.equal(findAll(body, "wtn-dv-title").length, 1, "identity now scrolls, in the topbar shape");
  assert.equal(findAll(body, "wtn-dv-desc").length, 1, "descriptions scroll, as before");
  assert.equal(findAll(body, "wtn-dv-gimg").length, 1, "the gallery scrolls, as before");
  assert.equal(findAll(body, "wtn-dv-back").length, 0, "'← results' must not ALSO appear in the scrolling body");
  assert.equal(findAll(body, "wtn-dv-version-sel").length, 0, "the version selector must not ALSO appear in the scrolling body");
  assert.equal(findAll(body, "wtn-cs-action").length, 0, "the download action must not ALSO appear in the scrolling body");
});

test("buildModelDetailView: fixedTopBar without onBack simply omits '← results' -- never a dead/disabled button", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({ doc, result, versionId: 3, browsingLevel: 1, fixedTopBar: true });
  assert.equal(findAll(el, "wtn-dv-back").length, 0);
});

test("BUG (owner, 2026-08-01, modal-only): .wtn-dv-topbar is pinned (flex: none) and its version selector gets the flexible width -- the buttons keep their intrinsic size", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const css = styleEl.textContent;
  assert.match(css, /\.wtn-dv-topbar\s*\{[^}]*flex:\s*none;?/, "the fixed bar itself must never grow/shrink");
  assert.match(
    css,
    /\.wtn-dv-topbar \.wtn-dv-versionrow\s*\{[^}]*flex:\s*1 1 auto;?/,
    "the version selector's own row must be the ONE flexible-width element in the bar",
  );
  assert.match(
    css,
    /\.wtn-dv-topbar \.wtn-dv-actionhost\s*\{[^}]*flex:\s*none;?/,
    "the download action must keep its intrinsic size, not stretch",
  );
  assert.match(
    css,
    /\.wtn-dv-topbar \.wtn-dv-back\s*\{[^}]*flex:\s*none;?/,
    "'← results' must keep its intrinsic size, not stretch",
  );
});

const total = count;
const passed = total - failures;
console.log(`\n${passed}/${total} tests passed`);
if (failures > 0) {
  process.exitCode = 1;
}
