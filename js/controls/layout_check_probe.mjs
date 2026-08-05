/**
 * layout_check_probe.mjs — the BROWSER-SIDE half of `js/controls/layout_check.mjs`
 * (`docs/TODO.md`'s *Now* item 4 -- "a measured-layout check"). Loaded as a
 * real `<script type="module">` by the tiny page `layout_check.mjs` serves to
 * headless Chrome; it imports the ACTUAL production render modules (never a
 * reimplementation of their markup/CSS) and measures the four boxes that
 * regressed on 2026-08-02/03 with a genuine layout engine underneath them --
 * something no `test_*.mjs` anywhere in this pack has (`.claude/skills/css-
 * layout-diagnose-headless/SKILL.md`).
 *
 * ## Why this file is separate from `layout_check.mjs`
 *
 * `layout_check.mjs` runs under plain `node` (spawns Chrome, serves files,
 * parses the result); THIS file runs INSIDE the headless page itself, as a
 * real ES module fetched over the loopback static server `layout_check.mjs`
 * starts -- imports resolve exactly the way they do in a live ComfyUI page
 * (relative specifiers against this file's own URL), never a bundler, never
 * a `node`-side stub DOM. That is the whole point: `test_model_detail_view
 * .mjs`/`test_lora_resize.mjs` already cover the DECLARATION (a class is
 * present, a CSS rule matches a regex) against a doc-stub with zero layout;
 * this file covers the RESULT, against Chrome's real engine.
 *
 * ## The `.wtn` + `theme.css` requirement is baked in, not left to a caller
 *
 * `theme.css:77` scopes `box-sizing: border-box` to `.wtn` DESCENDANTS. Every
 * mount below goes through `mountWtn()`, which appends a `<div class="wtn">`
 * to `document.body` -- the harness's own page shell (`layout_check.mjs`)
 * already links `theme.css`, so no invariant below can forget the ancestor
 * the way two earlier passes did (`docs/TODO.md`'s *Now* item 1's own
 * postmortem: "this has now cost two passes and produced one false bug
 * report on the work board"). `checkBoxSizingSanity()` (below) asserts the
 * scoping actually engaged, so a broken harness fails LOUDLY instead of
 * quietly inventing a bug the way that postmortem describes.
 *
 * ## Why this lives in `js/controls/`, not `js/shared/`
 *
 * The obvious "it's a cross-cutting checking tool" instinct says
 * `js/shared/` -- that was this file's first location, and `js/shared/
 * test_field_logic.mjs`'s own layering guard immediately failed the suite:
 * "js/shared/ must never import from a track (js/anima/ or js/controls/)."
 * This file genuinely needs to import the REAL `model_detail_view.mjs`/
 * `lora_render.mjs` (the whole point -- a reimplementation of their markup
 * would test nothing), so it belongs where those modules live. A future
 * Anima-track probe belongs in `js/anima/` for the identical reason, not
 * here.
 *
 * ## Adding a fifth invariant
 *
 * 1. Write a new `async function checkYourThing() { ... }` below, following
 *    the existing shape: `mountWtn(...)`, build the REAL production element
 *    (import it, don't hand-roll the markup), `await nextFrame()` so layout
 *    has actually run, measure with `getBoundingClientRect()`/
 *    `getComputedStyle()`, and write ONLY plain numbers/strings into
 *    `results.invariants.yourThing` (this object is JSON-serialized whole).
 * 2. Add one line calling it from `run()`, below.
 * 3. Add the matching assertion in `layout_check.mjs`'s `ASSERTIONS` (a
 *    tolerance-based comparison -- "a tolerance is fine; a hardcoded golden
 *    pixel value is not," per this task's own brief, since a legitimate
 *    design change would otherwise permanently red this check).
 * 4. Verify it catches the bug it's for: temporarily revert the CSS fix in
 *    the real production file, rerun `node js/controls/layout_check.mjs`,
 *    confirm THIS invariant goes red (and no other), then restore the file
 *    (`git diff` must come back empty).
 */

import { buildModelDetailView } from "./model_detail_view.mjs";
import { buildRoot, buildRowElement, injectStyles, DEFAULT_W } from "./lora_render.mjs";

const results = { invariants: {}, errors: [], meta: {} };

// A page error or unhandled rejection during ANY scenario invalidates every
// measurement taken after it -- surfaced in `results.errors` so the node
// side can fail loudly instead of grading a partially-run page as green.
window.addEventListener("error", (e) => {
  results.errors.push(`window error: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  results.errors.push(`unhandled rejection: ${reason}`);
});

/** Appends a fresh `<div class="wtn">` to `document.body` -- the ONE place
 * every scenario below gets its required `.wtn` ancestor, so no invariant
 * can individually forget it (this file's own top doc comment). */
function mountWtn(widthPx) {
  const wrap = document.createElement("div");
  wrap.className = "wtn";
  if (widthPx) {
    wrap.style.width = `${widthPx}px`;
  }
  document.body.appendChild(wrap);
  return wrap;
}

/** A plain macrotask delay, deliberately NOT `requestAnimationFrame` --
 * `layout_check.mjs`'s own headless Chrome runs with `--virtual-time-budget`
 * so an async promise chain (this component's own gallery-image attach,
 * `civitai_thumb.mjs`'s `attachThumbCandidate`) can settle before
 * `--dump-dom` fires; virtual time reliably fast-forwards `setTimeout`, but
 * measured on this exact setup, it does NOT reliably drive `rAF` (no
 * compositor frame is ever produced in that mode, so a `rAF`-chained
 * `nextFrame` never resolved at all -- the dumped DOM showed a scenario
 * frozen mid-await). `getBoundingClientRect()`/`getComputedStyle()` force a
 * synchronous layout pass on demand regardless of whether a frame was ever
 * painted, so a plain timer is enough to let pending DOM mutations/promise
 * callbacks flush before the numbers are read. */
function nextFrame() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function fixtureResult(overrides = {}) {
  return {
    model_id: 100,
    name: "Probe Model",
    creator: "probeArtist",
    type: "LORA",
    stats: { downloads: 1000, rating: 4.5 },
    versions: [
      {
        version_id: 1,
        name: "v1.0",
        base_model: "SDXL",
        published_at: "2026-01-01T00:00:00.000Z",
        gated: false,
        file_name: "probe.safetensors",
        download_url: "https://example.invalid/dl",
        size_kb: 1024,
        triggers: [],
        preview_url: null,
        images: [{ url: "/__missing.jpg", nsfw_level: 1, type: "image" }],
      },
    ],
    ...overrides,
  };
}

/** Not an invariant of its own -- a precondition every OTHER invariant relies
 * on. If `boxSizing` isn't `border-box` here, `theme.css`/`.wtn` didn't
 * actually engage and every measurement below is the ~17px-inflated probe
 * artifact this task's own brief names, not a real bug. `layout_check.mjs`
 * fails loudly on this rather than grading the four real invariants. */
async function checkBoxSizingSanity() {
  // `theme.css:77` is `.wtn *, .wtn *::before, .wtn *::after { box-sizing:
  // border-box; }` -- a DESCENDANT selector, so the padded/bordered probe
  // box must be a CHILD of the `.wtn` wrapper, never the wrapper itself
  // (this exact miswiring produced a false "harness is broken" reading
  // while writing this check -- `.wtn` itself carries no box-sizing rule of
  // its own, only its descendants do).
  const wrap = mountWtn(50);
  const probe = document.createElement("div");
  probe.style.width = "50px";
  probe.style.padding = "10px";
  probe.style.border = "1px solid red";
  wrap.appendChild(probe);
  await nextFrame();
  const rect = probe.getBoundingClientRect();
  results.meta.boxSizing = getComputedStyle(probe).boxSizing;
  results.meta.sanityWidthPx = rect.width; // border-box -> 50; content-box -> 50 + 2*10 + 2*1 = 72
  wrap.remove();
}

/**
 * Pins `25b60f1` ("the gallery filmstrip stopped collapsing to zero
 * height"): a flex column (`.wtn-dv-body`) with a tall sibling below the
 * gallery used to let the filmstrip's own `flex-shrink: 1` squash it past
 * its `aspect-ratio`-derived height, down to the 0 its `overflow-y: hidden`
 * then clipped to invisible. Reproduced here the same way the real bug
 * appeared: a bounded-height mount (matches the picker's own scrolling
 * `.wtn-dv-body`) with enough OTHER content (a long model description) that
 * the column's natural content height exceeds the box -- never a hand-
 * crafted "squash" trigger, the same shape production actually hits.
 */
async function checkFilmstripHeight() {
  const outer = mountWtn(420);
  outer.style.display = "flex";
  outer.style.flexDirection = "column";
  outer.style.height = "300px";
  const gallery = Array.from({ length: 8 }, (_, i) => ({ url: `/__missing_g${i}.jpg`, nsfw_level: 1 }));
  let modelDescription = "";
  for (let p = 0; p < 30; p += 1) {
    modelDescription += `Paragraph ${p}: enough filler prose that the scrolling body's natural content height exceeds its bounded mount, so a flex-shrink regression on an EARLIER sibling (the gallery) becomes observable exactly like the live bug. `;
  }
  const dv = buildModelDetailView({
    doc: document,
    galleryTileWidth: 115,
    result: fixtureResult(),
    versionId: 1,
    browsingLevel: 1,
    detail: { status: "loaded", gallery, modelDescription, modelDescriptionChecked: true },
    fetchCommunityImages: async () => ({ reason: "ok", images: [] }),
  });
  outer.appendChild(dv.el);
  await nextFrame();
  const filmstrip = outer.querySelector(".wtn-dv-gallery-filmstrip");
  const tile = filmstrip ? filmstrip.querySelector(".wtn-dv-gimg") : null;
  results.invariants.filmstripHeight = {
    filmstripHeightPx: filmstrip ? filmstrip.getBoundingClientRect().height : null,
    tileHeightPx: tile ? tile.getBoundingClientRect().height : null,
    tileWidthPx: tile ? tile.getBoundingClientRect().width : null,
  };
}

/**
 * Pins `cc36388` ("the LoRA row's caret aligns, and stops being a text
 * glyph"): the owner's own measured failure was caret x at 114.3 / 200.5 /
 * 228.8 across three rows of differing name length, because the name TEXT
 * span (not the button around it) had no `flex` of its own and sized to its
 * own content instead of filling the row. Three deliberately different-
 * length names, one shared row width (`DEFAULT_W`, the node's real default),
 * and the caret's own `x` compared across rows.
 */
async function checkCaretAlignment() {
  const refs = buildRoot(document);
  injectStyles(document);
  refs.root.style.width = `${DEFAULT_W}px`;
  const wrap = mountWtn();
  wrap.appendChild(refs.root);
  const names = ["Edit", "Anima Real Skin Enhancer", "Anima Realistic Portrait Mid"];
  const carets = [];
  for (const name of names) {
    const row = buildRowElement(document);
    row.nameLabel.textContent = name;
    refs.rowsHost.appendChild(row.root);
    carets.push(row.caret);
  }
  await nextFrame();
  const caretX = carets.map((c) => c.getBoundingClientRect().x);
  results.invariants.caretAlignment = {
    names,
    caretX,
    spreadPx: Math.max(...caretX) - Math.min(...caretX),
  };
}

/**
 * Pins `e05f6fd` ("the gallery prompt drawer fits inside its tile"): the
 * owner's own measured failure was a 147px drawer inside a 115px tile, the
 * drawer's top ~23px clipped away since it bottom-anchors and grows upward.
 * One 115px tile (the picker's real size), one prompt long enough that the
 * drawer's natural content (prompt, up to its own 72px cap, plus the params
 * line plus the copy button) exceeds the tile -- the same shape a real
 * generation image's prompt produces.
 */
async function checkDrawerFitsTile() {
  const outer = mountWtn(115);
  const longPrompt = "masterpiece, best quality, extremely detailed background, cinematic lighting, "
    + "a single character standing in a rain-soaked alley at night, neon reflections, dramatic pose, "
    + "intricate clothing details, long flowing hair, volumetric fog, shallow depth of field";
  const dv = buildModelDetailView({
    doc: document,
    galleryTileWidth: 115,
    result: fixtureResult(),
    versionId: 1,
    browsingLevel: 1,
    detail: {
      status: "loaded",
      gallery: [{
        url: "/__missing.jpg",
        nsfw_level: 1,
        prompt: longPrompt,
        params: { sampler: "Euler a", steps: 20, cfg: 7, size: "832x1216" },
      }],
      modelDescriptionChecked: true,
    },
    fetchCommunityImages: async () => ({ reason: "ok", images: [] }),
  });
  outer.appendChild(dv.el);
  await nextFrame();
  const tile = outer.querySelector(".wtn-dv-gimg");
  const drawer = outer.querySelector(".wtn-dv-gdrawer");
  results.invariants.drawerFitsTile = {
    tileHeightPx: tile ? tile.getBoundingClientRect().height : null,
    drawerHeightPx: drawer ? drawer.getBoundingClientRect().height : null,
  };
}

/**
 * Pins the "no page-level horizontal scroll" invariant (task brief) --
 * the owner's own report was "i think we have horizontal issue in the model
 * detail page, see its cut," fixed by `f82d08a`'s `.wtn-flex-bound` (`min-
 * width: 0`) chain up `.wtn-dv`/`.wtn-dv-body`/`.wtn-dv-vdstack`. Mounted at
 * the MODAL's own full-bleed shape (`fixedTopBar: true`, `width: 100%`) --
 * that is the shape the report was about -- with a deliberately long version
 * name (stresses the native `<select>`'s own intrinsic width), a real
 * `buildActionEl` download button, and a filmstrip wide enough that ONLY
 * its own `overflow-x: auto` should ever engage.
 *
 * ## An honest limitation, found while verifying this invariant catches its
 * own bug (this task's own acceptance bar)
 *
 * Reverting `.wtn-dv`'s own `wtn-flex-bound` (root AND `bodyHost`),
 * `.wtn-dv-vdstack`'s `min-width: 0`, `.wtn-dv-topbar`'s `min-width: 0`,
 * `.wtn-dv-version-sel`'s `min-width: 0`, and `.wtn-dv-gallery-filmstrip`'s
 * `min-width: 0` -- individually AND all five together -- never moved this
 * invariant with realistic content. Measured, not assumed: a native
 * `<select>` sized via `flex: 1 1 auto` renders at that computed size and
 * clips its own displayed text regardless of option length (Chrome does not
 * grow it to fit the longest option once any explicit flex sizing applies),
 * and `.wtn-dv-gallery-filmstrip`'s own `overflow-x: auto` already makes its
 * CSS-spec "automatic minimum size" 0 independent of any explicit
 * `min-width: 0` -- so both of this file's genuinely overflow-prone
 * descendants already contain themselves through a DIFFERENT mechanism than
 * the one these five declarations provide. The only way this check was
 * observed to go red was an UNREALISTIC fixture (a repeated, ~280-character
 * unwrapped button label) that also failed with every fix in place -- a
 * false positive, discarded rather than kept to manufacture a red result.
 *
 * Net: this invariant is a legitimate, worthwhile safety net (it WOULD catch
 * a future change that strips several of these layers at once, or adds a
 * genuinely new, unguarded wide element), but unlike the other three, it
 * could not be proven to catch a single realistic production-line revert in
 * THIS file. The most plausible REAL failure mode lives in `civitai_modal
 * .mjs`'s own `.wtn-cm-body`/`.wtn-cm-main` rail+main flex row (a sibling
 * relationship this standalone mount does not reproduce), not in anything
 * `model_detail_view.mjs` alone controls. Report this rather than hide it --
 * see this task's own build report for the full verification log.
 */
async function checkNoPageHorizontalScroll() {
  const outer = mountWtn();
  outer.style.width = "100%";
  const gallery = Array.from({ length: 10 }, (_, i) => ({ url: `/__missing_h${i}.jpg`, nsfw_level: 1 }));
  const longVersionName = "A version name deliberately long enough that a native <select> without "
    + "min-width: 0 up its own flex ancestry would force this whole row wider than the viewport";
  const dv = buildModelDetailView({
    doc: document,
    galleryTileWidth: 200,
    result: fixtureResult({
      versions: [{
        version_id: 1,
        name: longVersionName,
        base_model: "SDXL",
        published_at: "2026-01-01T00:00:00.000Z",
        gated: false,
        file_name: "probe.safetensors",
        download_url: "https://example.invalid/dl",
        size_kb: 1024,
        triggers: [],
        preview_url: null,
        images: [{ url: "/__missing.jpg", nsfw_level: 1, type: "image" }],
      }],
    }),
    versionId: 1,
    browsingLevel: 1,
    fixedTopBar: true,
    detail: { status: "loaded", gallery, modelDescriptionChecked: true },
    fetchCommunityImages: async () => ({ reason: "ok", images: [] }),
    buildActionEl: (doc) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.textContent = "Download";
      return btn;
    },
  });
  outer.appendChild(dv.el);
  await nextFrame();
  results.invariants.noPageHorizontalScroll = {
    docScrollWidthPx: document.documentElement.scrollWidth,
    docClientWidthPx: document.documentElement.clientWidth,
    bodyScrollWidthPx: document.body.scrollWidth,
    bodyClientWidthPx: document.body.clientWidth,
  };
}

async function run() {
  await checkBoxSizingSanity();
  await checkFilmstripHeight();
  await checkCaretAlignment();
  await checkDrawerFitsTile();
  await checkNoPageHorizontalScroll();
}

run()
  .catch((err) => {
    results.fatal = (err && err.stack) || String(err);
  })
  .finally(() => {
    // `layout_check.mjs` reads THIS element out of `--dump-dom`'s output --
    // never console.log (headless Chrome's console is not part of the DOM
    // dump). `display: none`, not removed -- must still serialize.
    const out = document.createElement("pre");
    out.id = "wtn-probe-json";
    out.style.display = "none";
    out.textContent = JSON.stringify(results);
    document.body.appendChild(out);
    document.title = "WTN_PROBE_DONE";
  });
