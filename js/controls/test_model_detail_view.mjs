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
  hiddenGalleryCount,
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

test("buildModelDetailView: the SAME component renders in BOTH layouts (one component, mounted twice) -- 'twoCol' (the picker) vs 'filmstrip' (the modal), renamed 2026-08-01 from 'vertical'/'grid'", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const detail = { status: "loaded", gallery: [{ url: "a.jpg", nsfw_level: 1 }], modelDescriptionChecked: true };
  const twoCol = buildModelDetailView({ doc, layout: "twoCol", result, versionId: 3, browsingLevel: 1, detail });
  const filmstrip = buildModelDetailView({ doc, layout: "filmstrip", result, versionId: 3, browsingLevel: 1, detail });
  assert.equal(findAll(twoCol.el, "wtn-dv-title").length, 1);
  assert.equal(findAll(filmstrip.el, "wtn-dv-title").length, 1);
  assert.equal(textOf(findAll(twoCol.el, "wtn-dv-title")[0]), textOf(findAll(filmstrip.el, "wtn-dv-title")[0]));
  // The only real difference is the gallery container's own layout class.
  assert.equal(findAll(twoCol.el, "wtn-dv-gallery-twocol").length, 1);
  assert.equal(findAll(filmstrip.el, "wtn-dv-gallery-filmstrip").length, 1);
});

test("buildModelDetailView: layout defaults to 'twoCol' when omitted (the picker's own default)", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const detail = { status: "loaded", gallery: [{ url: "a.jpg", nsfw_level: 1 }], modelDescriptionChecked: true };
  const { el } = buildModelDetailView({ doc, result, versionId: 3, browsingLevel: 1, detail });
  assert.equal(findAll(el, "wtn-dv-gallery-twocol").length, 1);
  assert.equal(findAll(el, "wtn-dv-gallery-filmstrip").length, 0);
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

// =========================================================================
// Owner, 2026-08-01 ("if its the author gallery it should be at the top,
// before the model description ... fastest answer to what does this LoRA
// actually do"): the gallery moved above BOTH descriptions, and the
// description order itself flipped (version before model).
// =========================================================================

test("buildModelDetailView: the gallery renders BEFORE both descriptions in DOM order, in both mounts", () => {
  const result = makeTwoVersionResult();
  const detail = {
    status: "loaded",
    modelDescription: "Model write-up.",
    versionDescription: "Version write-up.",
    modelDescriptionChecked: true,
    gallery: [{ url: "a.jpg", nsfw_level: 1 }],
  };
  for (const layout of ["twoCol", "filmstrip"]) {
    const { el } = buildModelDetailView({ doc: makeDocStub(), result, versionId: 3, browsingLevel: 1, detail, layout });
    const headings = findAll(el, "wtn-dv-sechead").map(textOf);
    assert.deepEqual(headings, ["Gallery", "Version Description", "Model Description"], `layout=${layout}`);
  }
});

test("buildModelDetailView: descriptions render VERSION before MODEL when both are present", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: {
      status: "loaded", modelDescription: "Model write-up.", versionDescription: "Version write-up.",
      modelDescriptionChecked: true, gallery: [],
    },
  });
  const bodies = findAll(el, "wtn-dv-desc").map(textOf);
  assert.deepEqual(bodies, ["Version write-up.", "Model write-up."]);
});

// =========================================================================
// Owner, 2026-08-01: "why does the gallery show only 6 images" --
// `visibleGalleryEntries` silently drops over-level entries; state the
// omission instead.
// =========================================================================

test("hiddenGalleryCount: counts entries the level filter is dropping, never negative", () => {
  const gallery = [
    { url: "a.jpg", nsfw_level: 1 },
    { url: "b.jpg", nsfw_level: 8 },
    { url: "c.jpg", nsfw_level: 16 },
    { url: "d.jpg", nsfw_level: 16 },
  ];
  assert.equal(hiddenGalleryCount(gallery, 1), 3);
  assert.equal(hiddenGalleryCount(gallery, 8), 2);
  assert.equal(hiddenGalleryCount(gallery, 16), 0);
});

test("hiddenGalleryCount: garbage input degrades to 0, never throws", () => {
  assert.equal(hiddenGalleryCount(null, 1), 0);
  assert.equal(hiddenGalleryCount("not-a-list", 1), 0);
});

test("buildModelDetailView: the hidden-count line appears, with the REAL count, when the level filter drops some (but not all) images", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = [
    { url: "a.jpg", nsfw_level: 1 },
    { url: "b.jpg", nsfw_level: 16 },
    { url: "c.jpg", nsfw_level: 16 },
  ];
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  const hidden = findAll(el, "wtn-dv-gallery-hidden")[0];
  assert.ok(hidden, "a hidden-count line must render when some images are filtered out");
  assert.equal(hidden.textContent, "2 images hidden by your browsing level.");
});

test("buildModelDetailView: NO hidden-count line when nothing is hidden (all visible, or the level is already at its maximum)", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = [{ url: "a.jpg", nsfw_level: 1 }, { url: "b.jpg", nsfw_level: 1 }];
  const allVisible = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  assert.equal(findAll(allVisible.el, "wtn-dv-gallery-hidden").length, 0, "nothing is hidden -- no line");

  const highLevelGallery = [{ url: "a.jpg", nsfw_level: 16 }, { url: "b.jpg", nsfw_level: 1 }];
  const atMaxLevel = buildModelDetailView({
    doc: makeDocStub(), result, versionId: 3, browsingLevel: 16, // the maximum -- nothing can be ABOVE it
    detail: { status: "loaded", gallery: highLevelGallery, modelDescriptionChecked: true },
  });
  assert.equal(findAll(atMaxLevel.el, "wtn-dv-gallery-hidden").length, 0, "at the maximum level, nothing is filtered -- the line must never falsely appear");
});

test("buildModelDetailView: NO hidden-count line in the 'locked' state (a distinct message already covers it) or when the gallery is genuinely empty", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const lockedGallery = [{ url: "a.jpg", nsfw_level: 16 }];
  const locked = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery: lockedGallery, modelDescriptionChecked: true },
  });
  assert.equal(findAll(locked.el, "wtn-dv-gallery-hidden").length, 0);

  const empty = buildModelDetailView({
    doc: makeDocStub(), result, versionId: 3, browsingLevel: 1,
    detail: { status: "loaded", gallery: [], modelDescriptionChecked: true },
  });
  assert.equal(findAll(empty.el, "wtn-dv-gallery-hidden").length, 0);
});

// =========================================================================
// Owner, 2026-08-01: two mounts, two gallery SHAPES -- "twoCol" (the
// picker, a small 2-column grid, vertical scroll only) vs "filmstrip" (the
// modal, a single horizontally-scrolling row).
// =========================================================================

test("buildModelDetailView: 'twoCol' is a plain 2-column grid with NO horizontal scroll of its own", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = Array.from({ length: 4 }, (_, i) => ({ url: `img${i}.jpg`, nsfw_level: 1 }));
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1, layout: "twoCol",
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  const grid = findAll(el, "wtn-dv-gallery-twocol")[0];
  assert.ok(grid, "the twoCol grid container must render");
  assert.equal(findAll(grid, "wtn-dv-gimg").length, 4);

  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const rule = styleEl.textContent.match(/\.wtn-dv-gallery-twocol\s*\{([^}]*)\}/)[1];
  assert.match(rule, /grid-template-columns:\s*repeat\(2,\s*1fr\)/, "exactly two columns");
  assert.doesNotMatch(rule, /overflow-x/, "the twoCol shape must never set its own horizontal scroll");
});

test("buildModelDetailView: 'filmstrip' is a single horizontally-scrolling row, contained to itself (min-width: 0, the exact mirror of .wtn-dv-body's own min-height: 0 fix)", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = Array.from({ length: 4 }, (_, i) => ({ url: `img${i}.jpg`, nsfw_level: 1 }));
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1, layout: "filmstrip",
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  const strip = findAll(el, "wtn-dv-gallery-filmstrip")[0];
  assert.ok(strip, "the filmstrip container must render");
  assert.equal(findAll(strip, "wtn-dv-gimg").length, 4);

  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const css = styleEl.textContent;
  const stripRule = css.match(/\.wtn-dv-gallery-filmstrip\s*\{([^}]*)\}/)[1];
  assert.match(stripRule, /flex-direction:\s*row/, "a single row");
  assert.match(stripRule, /overflow-x:\s*auto/, "scrolls horizontally");
  assert.match(stripRule, /min-width:\s*0/, "must not refuse to shrink below its tiles' total width -- the exact mirror of the vertical min-height: 0 trap");
  // Tiles never shrink to fit (flex: none) -- that's what actually forces
  // the overflow rather than everyone cramming into the available width.
  assert.match(css, /\.wtn-dv-gallery-filmstrip \.wtn-dv-gimg\s*\{[^}]*flex:\s*none;?/);

  // The body itself must NEVER scroll horizontally -- only the strip does.
  const bodyRule = css.match(/\.wtn-dv-body\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(bodyRule, /overflow-x/, "the scrolling body must not gain its own horizontal scrollbar");
});

test("buildModelDetailView: the prompt drawer still renders over a filmstrip tile", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const gallery = [{ url: "a.jpg", nsfw_level: 1, prompt: "1girl, forest" }];
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1, layout: "filmstrip",
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
  });
  const strip = findAll(el, "wtn-dv-gallery-filmstrip")[0];
  assert.equal(findAll(strip, "wtn-dv-gdrawer").length, 1);
  assert.equal(findAll(strip, "wtn-dv-gprompt")[0].textContent, "1girl, forest");
});

// =========================================================================
// Owner, 2026-08-01: "GALLERY"/"VERSION DESCRIPTION"/"MODEL DESCRIPTION"
// too small to read as section separators -- size only, same letter-
// spacing/uppercase, and identical across all three.
// =========================================================================

test("BUG (owner, 2026-08-01): the three section headings share ONE (larger) font-size", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const rule = styleEl.textContent.match(/\.wtn-dv-sechead\s*\{([^}]*)\}/)[1];
  const sizeMatch = rule.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
  assert.ok(sizeMatch, "wtn-dv-sechead must declare an explicit font-size");
  assert.ok(Number(sizeMatch[1]) > 10, "must be larger than the old 10px");
  // Style, not just size, is unchanged -- same letter-spacing/uppercase.
  assert.match(rule, /letter-spacing:\s*\.08em/);
  assert.match(rule, /text-transform:\s*uppercase/);
});

test("buildModelDetailView: GALLERY/VERSION DESCRIPTION/MODEL DESCRIPTION all share the identical .wtn-dv-sechead class -- one font-size for all three by construction", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1,
    detail: {
      status: "loaded", modelDescription: "M.", versionDescription: "V.", modelDescriptionChecked: true,
      gallery: [{ url: "a.jpg", nsfw_level: 1 }],
    },
  });
  const headings = findAll(el, "wtn-dv-sechead");
  assert.equal(headings.length, 3);
  for (const h of headings) {
    assert.ok(h.classList.contains("wtn-dv-sechead"));
  }
});

// =========================================================================
// Owner-reported, with a screenshot (2026-08-01): the modal's fixed top bar
// -- '← back to results' reads shorter than the version <select>, and the
// select's own dropdown arrow sits flush against its right border.
// =========================================================================

test("BUG (owner, 2026-08-01): the topbar's three controls (back / version select / action host's child) share ONE explicit height", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const css = styleEl.textContent;
  const backRule = css.match(/\.wtn-dv-topbar \.wtn-dv-back\s*\{([^}]*)\}/)[1];
  const selRule = css.match(/\.wtn-dv-topbar \.wtn-dv-version-sel\s*\{([^}]*)\}/)[1];
  const backHeight = backRule.match(/height:\s*(\d+)px/)[1];
  const selHeight = selRule.match(/height:\s*(\d+)px/)[1];
  assert.equal(backHeight, selHeight, "the back button and the version select must share one explicit height");
  assert.match(backRule, /box-sizing:\s*border-box/, "an explicit height only measures the full box with border-box");
  assert.match(selRule, /box-sizing:\s*border-box/);
});

test("BUG (owner, 2026-08-01): the topbar's version select has right padding so its dropdown arrow clears the border, not flush against it", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const rule = styleEl.textContent.match(/\.wtn-dv-topbar \.wtn-dv-version-sel\s*\{([^}]*)\}/)[1];
  const paddingMatch = rule.match(/padding:\s*0\s+(\d+)px\s+0\s+(\d+)px/);
  assert.ok(paddingMatch, "the topbar version select must declare explicit top/right/bottom/left padding");
  assert.ok(Number(paddingMatch[1]) >= 16, "the right padding must clear a native <select>'s own dropdown arrow, not sit flush against the border");
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

test("buildModelDetailView: identity/civlink/version-selector/download action are pinned in .wtn-dv-header; descriptions/gallery are in the scrolling .wtn-dv-body -- not one flat column", () => {
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
    onClose: () => {},
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
  assert.equal(findAll(header, "wtn-dv-desc").length, 0, "a description must never leak into the pinned header");
  assert.equal(findAll(header, "wtn-dv-gimg").length, 0, "the gallery must never leak into the pinned header");
});

// =========================================================================
// Owner-reported (2026-08-01): "why do we have a back button in this menu?"
// -- the picker's detail view is a SIBLING overlay, not a swap back to a
// list, so leaving it is "close", not "back". `onBack` no longer has any
// effect in the header shape at all; `onClose` renders a ✕ pinned to
// `.wtn-dv-header`'s own corner instead.
// =========================================================================

test("buildModelDetailView: header shape (picker) with onClose renders a working ✕ close affordance pinned in the header, never a '← back to results' button anywhere", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  let closed = false;
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1, onClose: () => { closed = true; },
  });
  const header = findAll(el, "wtn-dv-header")[0];
  const closeBtn = findAll(header, "wtn-dv-close")[0];
  assert.ok(closeBtn, "the header must render a close affordance");
  assert.equal(closeBtn.textContent, "✕");
  closeBtn.dispatch("click", { stopPropagation() {} });
  assert.ok(closed, "clicking the close affordance must invoke onClose");
  assert.equal(findAll(el, "wtn-dv-back").length, 0, "the header shape must never render '← back to results', with or without onClose");
});

test("buildModelDetailView: header shape (picker) without onClose simply omits the ✕ -- never a dead/disabled button", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({ doc, result, versionId: 3, browsingLevel: 1 });
  assert.equal(findAll(el, "wtn-dv-close").length, 0);
});

test("buildModelDetailView: header shape (picker) ignores onBack entirely -- passing it renders neither a back button nor a close button on its own", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({ doc, result, versionId: 3, browsingLevel: 1, onBack: () => {} });
  assert.equal(findAll(el, "wtn-dv-back").length, 0, "onBack must have no effect in the header shape");
  assert.equal(findAll(el, "wtn-dv-close").length, 0, "onBack must not accidentally render a close button either");
});

test("buildModelDetailView: topbar shape (modal) ignores onClose entirely -- never renders a stray ✕, even when onClose is passed alongside onBack", () => {
  const doc = makeDocStub();
  const result = makeTwoVersionResult();
  const { el } = buildModelDetailView({
    doc, result, versionId: 3, browsingLevel: 1, fixedTopBar: true, onBack: () => {}, onClose: () => {},
  });
  assert.equal(findAll(el, "wtn-dv-close").length, 0, "the topbar shape must never render the header's close affordance");
  assert.equal(findAll(el, "wtn-dv-back").length, 1, "the topbar shape's own '← back to results' is unaffected by onClose being passed");
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
// Owner-reported (2026-08-01): "the detail panel should have padding, see
// how the content is tight to the border of the panel" -- neither pinned
// region nor the scrolling body had any padding at all.
// =========================================================================

test("BUG (owner, 2026-08-01): the scrolling body carries its OWN padding (on the element with overflow-y: auto itself, not an ancestor), matching civitai_search.mjs's own .wtn-cs-body rhythm", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const css = styleEl.textContent;
  assert.match(
    css,
    /\.wtn-dv-body\s*\{[^}]*overflow-y:\s*auto;[^}]*padding:\s*9px 10px 10px;?/,
    "the scrolling body itself must carry the padding, alongside its own overflow-y: auto",
  );
});

test("BUG (owner, 2026-08-01): both pinned regions (the picker's .wtn-dv-header and the modal's .wtn-dv-topbar) carry padding too, not just the scrolling body", () => {
  const doc = makeDocStub();
  injectStyles(doc);
  const styleEl = doc.head.children.find((c) => c.tagName === "style");
  const css = styleEl.textContent;
  const headerRule = css.match(/\.wtn-dv-header\s*\{([^}]*)\}/)[1];
  assert.match(headerRule, /padding:\s*9px 28px 0 10px;?/, "the picker's pinned header must have padding");
  const topbarRule = css.match(/\.wtn-dv-topbar\s*\{([^}]*)\}/)[1];
  assert.match(topbarRule, /padding:\s*8px 10px 8px;?/, "the modal's pinned topbar must have padding");
});

// =========================================================================
// Task brief: "verify both mounts render every section" -- the owner
// compared two screenshots and worried a section (description or gallery)
// was being dropped in one shape and not the other; this proves the two
// SHAPES (`fixedTopBar` false/true) build the identical SET of sections,
// merely relocated between the pinned region and the scrolling body.
// =========================================================================

test("buildModelDetailView: both mounts (picker header vs. modal topbar) build the exact same set of sections -- identity, both descriptions, and the gallery, never dropped in one shape and not the other", () => {
  const result = makeTwoVersionResult();
  const detail = {
    status: "loaded",
    modelDescription: "Model write-up.",
    versionDescription: "Version write-up.",
    modelDescriptionChecked: true,
    gallery: [{ url: "v3.jpg", nsfw_level: 1 }],
  };
  const buildActionEl = (d) => {
    const b = d.createElement("button");
    b.className = "wtn-cs-action";
    return b;
  };

  const picker = buildModelDetailView({
    doc: makeDocStub(), result, versionId: 3, browsingLevel: 1, detail, buildActionEl,
    fixedTopBar: false, onClose: () => {},
  });
  const modal = buildModelDetailView({
    doc: makeDocStub(), result, versionId: 3, browsingLevel: 1, detail, buildActionEl,
    fixedTopBar: true, onBack: () => {},
  });

  const sectionClasses = ["wtn-dv-title", "wtn-dv-civlink", "wtn-dv-version-sel", "wtn-cs-action", "wtn-dv-desc", "wtn-dv-gimg"];
  for (const cls of sectionClasses) {
    const pickerCount = findAll(picker.el, cls).length;
    const modalCount = findAll(modal.el, cls).length;
    assert.ok(pickerCount > 0, `the picker shape must render at least one .${cls}`);
    assert.equal(pickerCount, modalCount, `.${cls} count must match between the picker and modal shapes (picker=${pickerCount}, modal=${modalCount})`);
  }
  // Both descriptions AND the gallery heading, present in both shapes.
  const pickerHeadings = findAll(picker.el, "wtn-dv-sechead").map(textOf).sort();
  const modalHeadings = findAll(modal.el, "wtn-dv-sechead").map(textOf).sort();
  assert.deepEqual(pickerHeadings, ["Gallery", "Model Description", "Version Description"].sort());
  assert.deepEqual(pickerHeadings, modalHeadings, "the exact same set of section headings must render in both shapes");
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
