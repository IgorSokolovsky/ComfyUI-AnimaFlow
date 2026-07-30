/**
 * model_picker.mjs — the searchable, kind-parameterised model picker
 * (`docs/lora-loader-design.md` §1a-v, corrected from a reference shot).
 * **Track-agnostic** — see `civitai_api.mjs`'s own top doc comment for the
 * reuse boundary this file is one third of (`AnimaLoaderPanel` imports this
 * unchanged at M3; the layering guard in `test_model_picker.mjs` fails the
 * build if this file ever imports a `lora_*` module).
 *
 * Opened anchored to the row control that owns it (a name field today,
 * a future Loader Panel slot at M3) via the shared, nested-overlay-safe
 * mechanism in `../shared/overlay.mjs` — **not** a hand-rolled scrim (the
 * task brief is explicit about this: this is a node-anchored popover, the
 * same idiom as `js/controls/interaction.mjs`'s own option-list/context-menu
 * overlays, not the Rule Builder's full-bleed work surface).
 *
 * ## What this slice wires, and what it deliberately does not
 *
 * The picker itself, fully: search-on-top (flat filter collapsing group
 * headers), subfolder grouping with a root `All` bucket, the current
 * selection accented, ellipsis-truncated names, a ~30px local-preview
 * thumbnail with a neutral placeholder when none exists, and a size/
 * base-model second line. **Never invents a category** (§1a-vi) — `
 * categoryOf` reads only a genuine `model.category` field (still `null` for
 * every real `/wtn/model_browser/list` entry, since that route doesn't carry
 * Civitai `tags` itself); Slice 4's own, narrower seam is `pickedCategory`,
 * below, which ALSO checks `civitai_api.mjs`'s `cachedCategoryTag` -- the
 * client-side cache a prior, explicit ⓘ-panel lookup (`model_info.mjs`) may
 * already have populated THIS session. That is real information, never a
 * guess, and it costs nothing extra on a picker open (`cachedCategoryTag`
 * never fetches -- see its own doc comment), which is what keeps this
 * picker's open path cheap even though the category chip can now be real.
 * `hideExtension`/`showThumbnails` are real parameters, both wired from
 * Slice 5's ⚙ dialog (`js/shared/settings.mjs`'s `HIDE_FILE_EXTENSION`/
 * `SHOW_PREVIEW_THUMBNAILS`, read by `lora_interaction.mjs`'s
 * `openNamePickerFor` and passed in here as plain data -- this file itself
 * never reaches into `../shared/settings.mjs`, matching `model_info.mjs`'s
 * own `civitaiEnabled` convention).
 *
 * ## Icons are duplicated here, not imported from `lora_render.mjs`
 *
 * `lora_render.mjs` already draws an (unrelated) magnifier glyph for the
 * node header's inert 🔍 placeholder — importing it from here would pull a
 * `lora_*` module into a file the layering guard explicitly forbids that
 * for. Every `render.mjs` in this pack already duplicates its own icon/CSS
 * rather than importing a sibling's (`lora_render.mjs`'s own top doc
 * comment states the same convention for its CSS) — this file follows that,
 * not a new pattern.
 */

import {
  openOverlayWithZoom,
  closeOverlayIfOwnedBy,
  closeOverlaysNotAncestorOf,
  activeOverlayRef,
  computeAnchoredMaxHeight,
} from "../shared/overlay.mjs";
import { listModels, thumbUrl, cachedCategoryTag } from "./civitai_api.mjs";

const STYLE_ID = "wtn-mp-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly -- same "every render module
// keeps its own hardcoded fallback copy" convention as lora_render.mjs's own
// top doc comment states (this module doesn't import theme.mjs's own token
// object, only its CSS-custom-property injector, at runtime).
const TOKENS = {
  surface2: "#1b212a",
  line: "#28303b",
  lineSoft: "#1f2731",
  ink: "#e7ecf3",
  inkDim: "#93a0b1",
  inkFaint: "#5f6c7d",
  console: "#0a0d12",
  accent: "#2dd4bf",
  accentStrong: "#34e5d2",
  accentDeep: "#14b8a6",
};

const SEARCH_ICON_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M11 4a7 7 0 104.418 12.44l4.571 4.571 1.415-1.415-4.572-4.572A7 7 0 0011 4zm-5 7a5 5 0 1110 0 5 5 0 01-10 0z'/%3E%3C/svg%3E";

// Neutral "no preview" glyph -- a plain picture-frame outline with a small
// mountain+sun (the generic "image" pictogram), never a broken-image icon
// and never an emoji (`.claude/CLAUDE.md`).
const IMAGE_PLACEHOLDER_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2H4zm0 2h16v9.59l-3.79-3.8a1 1 0 00-1.42 0L11 15.59l-2.29-2.3a1 1 0 00-1.42 0L4 16.59V6zm4 2a2 2 0 100 4 2 2 0 000-4z'/%3E%3C/svg%3E";

const CSS = `
.wtn-mp-panel {
  width: 316px; max-height: 62vh; display: flex; flex-direction: column; gap: 6px;
  padding: 9px 9px 8px; box-sizing: border-box; border-radius: 10px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  box-shadow: var(--wtn-shadow, 0 20px 46px rgba(0,0,0,.66));
  font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-mp-search-wrap { position: relative; flex: none; }
.wtn-mp-search-icon {
  position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
  width: 12px; height: 12px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-image: url("${SEARCH_ICON_SVG}"); -webkit-mask-image: url("${SEARCH_ICON_SVG}");
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
}
.wtn-mp-search {
  width: 100%; box-sizing: border-box; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-accent-deep, ${TOKENS.accentDeep}); color: var(--wtn-ink, ${TOKENS.ink});
  padding: 6px 8px 6px 24px; border-radius: 6px; font-size: 12px;
}
.wtn-mp-list { overflow-y: auto; display: flex; flex-direction: column; gap: 2px; min-height: 40px; /* keep in sync with MIN_LIST_HEIGHT_PX below */ flex: 1 1 auto; }
.wtn-mp-group-hd {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin: 8px 2px 3px;
}
.wtn-mp-group-hd:first-child { margin-top: 2px; }
.wtn-mp-empty { padding: 14px 6px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); font-size: 12px; text-align: center; }

.wtn-mp-row {
  display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 7px; cursor: pointer;
  border: 1px solid transparent; background: transparent; text-align: left; width: 100%; box-sizing: border-box;
}
.wtn-mp-row:hover { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
/* the row's CURRENT selection -- accented so you can see where you are in a
   long list of near-identical filenames (§1a-v). */
.wtn-mp-row.wtn-mp-current { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-mp-row.wtn-mp-current .wtn-mp-name { color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }

.wtn-mp-thumb {
  flex: none; width: 30px; height: 30px; border-radius: 5px; overflow: hidden;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  display: flex; align-items: center; justify-content: center;
}
.wtn-mp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wtn-mp-thumb-ph {
  width: 14px; height: 14px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-image: url("${IMAGE_PLACEHOLDER_SVG}"); -webkit-mask-image: url("${IMAGE_PLACEHOLDER_SVG}");
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
}

.wtn-mp-main { flex: 1 1 auto; min-width: 0; }
/* long names ellipsis-truncate, NEVER wrap (§1a-v) -- full name lives in the
   row's own title attribute instead. */
.wtn-mp-name {
  font-size: 12px; color: var(--wtn-ink, ${TOKENS.ink});
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wtn-mp-meta {
  font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;
}
.wtn-mp-chip {
  display: inline-block; margin-left: 6px; padding: 0 5px; border-radius: 8px; font-size: 8.5px;
  color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); border: 1px solid var(--wtn-accent-deep, ${TOKENS.accentDeep});
}
`;

/** The list's own floor (same overflow bug/fix as `civitai_search.mjs`'s
 * `MIN_RESULTS_HEIGHT_PX`, owner-reported 2026-07-30) -- matches
 * `.wtn-mp-list`'s own CSS `min-height: 40px` above, so the JS-computed
 * `max-height` never floors the list smaller than the CSS already promises
 * it. */
export const MIN_LIST_HEIGHT_PX = 40;

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  if (typeof document !== "undefined") {
    // Guarded dynamic import -- see lora_render.mjs's identical top doc
    // comment: no live ComfyUI server to serve this route under test, and
    // this file's own CSS already falls back to hardcoded hex values.
    import(THEME_URL)
      .then((mod) => mod.injectTheme())
      .catch(() => {});
  }
  if (typeof targetDoc.getElementById === "function" && targetDoc.getElementById(STYLE_ID)) {
    return;
  }
  const style = targetDoc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  const host = targetDoc.head || targetDoc.body || targetDoc;
  if (host && typeof host.appendChild === "function") {
    host.appendChild(style);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers -- grouping/filtering/formatting. No DOM, no `doc`/`window`
// reference anywhere below, so these are importable and directly testable
// under plain `node` (test_model_picker.mjs).
// ---------------------------------------------------------------------------

/** Human-readable file size (`"144 MB"`, `"500 B"`) -- `""` for anything
 * that isn't a finite, non-negative number (never throws, never shows
 * `NaN`/`undefined`). */
export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) {
    return "";
  }
  if (n < 1024) {
    return `${Math.round(n)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

/** `name` with its extension stripped when `hideExtension` is true (the ⚙
 * setting that flips this is Slice 5 -- this is the parameter it will bind
 * to). Never strips a dot that belongs to a directory segment (a subfolder
 * literally named `v1.2/`), and never returns an empty string for a
 * dotfile-shaped name (falls back to the original). Always the identity
 * function when `hideExtension` is falsy. */
export function displayModelName(name, hideExtension) {
  if (typeof name !== "string" || !name) {
    return "";
  }
  if (!hideExtension) {
    return name;
  }
  const slash = name.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  if (dot <= slash) {
    return name; // no extension in the LAST path segment
  }
  const stripped = name.slice(0, dot);
  return stripped || name;
}

/** Flat, case-insensitive substring filter across every entry's `name` --
 * this is what "typing searches flat across every file, so group headers
 * collapse away while filtering" (§1a-v) means: the CALLER decides whether
 * to group the result (skip grouping when `term` is non-empty), this
 * function only ever filters. An empty/whitespace-only `term` returns every
 * entry, unfiltered, in its original order. */
export function filterModelsFlat(models, term) {
  const list = Array.isArray(models) ? models : [];
  const q = typeof term === "string" ? term.trim().toLowerCase() : "";
  if (!q) {
    return list.slice();
  }
  return list.filter((m) => m && typeof m.name === "string" && m.name.toLowerCase().includes(q));
}

/** Groups `models` by their own `group` field (already computed server-side
 * by `src/model_browser/local.py`'s `list_models` -- root files already
 * carry `group: "All"`, never left header-less, §1a-v). Order: `All` first
 * (when present), then every other group alphabetically -- subfolder order
 * isn't specified beyond "its own header", and alphabetical is the least
 * surprising default. Entries within a group keep their original (server)
 * order. A model with no usable `group` string groups under `All` too, so a
 * malformed/legacy entry never silently vanishes from every group. */
export function groupModels(models) {
  const list = Array.isArray(models) ? models : [];
  const byGroup = new Map();
  for (const m of list) {
    if (!m || typeof m.name !== "string") {
      continue;
    }
    const g = typeof m.group === "string" && m.group ? m.group : "All";
    if (!byGroup.has(g)) {
      byGroup.set(g, []);
    }
    byGroup.get(g).push(m);
  }
  const others = [...byGroup.keys()].filter((g) => g !== "All").sort((a, b) => a.localeCompare(b));
  const ordered = byGroup.has("All") ? ["All", ...others] : others;
  return ordered.map((group) => ({ group, models: byGroup.get(group) }));
}

/** The picker row's second line (§1a-v): `"144 MB · SDXL"` normally, or the
 * literal `"no preview"` when the entry has no local preview image -- the
 * design doc's own exact words ("the second line says `no preview`"), taken
 * as replacing the whole line rather than just one segment of it (the
 * approved mockup additionally appends illustrative `"· unknown · no
 * category"` text to its own no-preview example row; this pack's §1a-vi
 * rule -- "never invent a category, show nothing when we don't know" --
 * argues against literally rendering a "no category" label as if it were
 * real information, so this function follows the doc's written sentence
 * rather than the demo page's extra embellishment). `base_model` falls back
 * to the literal `"unknown"` (an honest placeholder, not a guess) when the
 * file's own metadata didn't carry one. */
export function metaLineFor(model) {
  if (!model) {
    return "";
  }
  if (!model.has_preview) {
    return "no preview";
  }
  const size = formatFileSize(model.size);
  const base = (model.base_model && String(model.base_model).trim()) || "unknown";
  return size ? `${size} · ${base}` : base;
}

/** A genuinely-known Civitai category for `model`, or `null` -- §1a-vi's
 * "never invent a category" rule made literal: this only ever reads a
 * `category` field the caller's data actually carries, it never derives or
 * guesses one. `/wtn/model_browser/list` doesn't populate `category` at all
 * (see `pickedCategory`, below, for the real, session-cached source), so this
 * always returns `null` against a plain `/list` entry -- which is the
 * CORRECT behaviour per the design doc, not a gap: "show nothing when we
 * don't know." */
export function categoryOf(model) {
  return model && typeof model.category === "string" && model.category.trim() ? model.category.trim() : null;
}

/** The category chip to actually SHOW for `(kind, model)` -- `categoryOf`
 * first (a genuine `category` field, were one ever to exist on a `/list`
 * entry), else `cachedCategoryTag(kind, model.name)` (`civitai_api.mjs`):
 * the first Civitai `tag` from a lookup THIS session's ⓘ panel already ran
 * for this exact file (design doc §1a-vi -- "closing the Slice 3 seam").
 * Still `null`, never invented, for a file nobody has looked up yet -- that
 * is real absence of information, not a bug. */
export function pickedCategory(kind, model) {
  return categoryOf(model) || cachedCategoryTag(kind, model && model.name);
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/**
 * `undefined`/anything-but-`false` renders the thumbnail column exactly as
 * before (Slice 3 behaviour, unchanged) -- `showThumbnails === false` is the
 * ONLY thing that suppresses it (the ⚙ dialog's own "Show preview
 * thumbnails" setting, Slice 5: `js/shared/settings.mjs`'s
 * `SHOW_PREVIEW_THUMBNAILS`, read by the CALLER and passed in here as plain
 * data -- same convention as this file's own `hideExtension` parameter,
 * this module's top doc comment).
 */
function buildThumb(doc, kind, model) {
  const thumb = el(doc, "div", "wtn-mp-thumb");
  if (model && model.has_preview) {
    const img = el(doc, "img");
    img.src = thumbUrl(kind, model.name);
    img.alt = "";
    // A stale/removed preview (route 404s) falls back to the SAME neutral
    // placeholder as "never fetched a preview at all" -- never a broken
    // image frame (§1a-v's own "never a broken frame" line).
    img.addEventListener("error", () => {
      thumb.innerHTML = "";
      thumb.appendChild(el(doc, "span", "wtn-mp-thumb-ph"));
    });
    thumb.appendChild(img);
  } else {
    thumb.appendChild(el(doc, "span", "wtn-mp-thumb-ph"));
  }
  return thumb;
}

function buildRow(doc, kind, model, currentName, hideExtension, showThumbnails, onPick) {
  const row = el(doc, "button", "wtn-mp-row");
  row.type = "button";
  row.title = model.name;
  if (model.name === currentName) {
    row.classList.add("wtn-mp-current");
  }
  if (showThumbnails !== false) {
    row.appendChild(buildThumb(doc, kind, model));
  }

  const main = el(doc, "div", "wtn-mp-main");
  const nameEl = el(doc, "div", "wtn-mp-name");
  nameEl.textContent = displayModelName(model.name, hideExtension);
  main.appendChild(nameEl);

  const meta = el(doc, "div", "wtn-mp-meta");
  meta.textContent = metaLineFor(model);
  const category = pickedCategory(kind, model);
  if (category) {
    const chip = el(doc, "span", "wtn-mp-chip");
    chip.textContent = category;
    meta.appendChild(chip);
  }
  main.appendChild(meta);
  row.appendChild(main);

  row.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof onPick === "function") {
      onPick(model.name);
    }
  });
  return row;
}

/**
 * Opens the model picker, anchored to `anchorEl`. Fetches `kind`'s list
 * (via `civitai_api.mjs`'s `listModels`, which caches) and renders it
 * grouped-by-subfolder; typing in the search box (focused immediately on
 * open) switches to a flat, ungrouped filtered list.
 *
 * @param {{ctx: {doc, getCanvasEl}, anchorEl: Element, kind: string,
 *   ownerKey?: string, currentName?: string, hideExtension?: boolean,
 *   showThumbnails?: boolean, onPick?: (name: string) => void,
 *   onClose?: () => void}} opts
 *   `ownerKey` lets a caller with several open-able pickers on the page (one
 *   per row) give each its own toggle identity -- defaults to a bare
 *   `model-picker:<kind>` key, which is enough for a caller (like a single
 *   Loader Panel slot) that only ever has ONE picker open-able at a time.
 * @returns {object|null} the overlay handle, or `null` if this call just
 *   TOGGLED an already-open picker for the same `ownerKey` closed (mirrors
 *   `js/controls/interaction.mjs`'s own toggle convention).
 */
export function openModelPicker({
  ctx,
  anchorEl,
  kind,
  ownerKey,
  currentName = "",
  hideExtension = false,
  showThumbnails = true,
  onPick,
  onClose,
} = {}) {
  const key = ownerKey || `model-picker:${kind}`;
  if (closeOverlayIfOwnedBy(key)) {
    return null; // toggle: this SAME picker was already open -- just close it
  }
  closeOverlaysNotAncestorOf(anchorEl); // a DIFFERENT overlay was open -- close it (and anything nested in it)

  const doc = ctx.doc;
  injectStyles(doc);

  const panel = el(doc, "div", "wtn-mp-panel wtn");
  const searchWrap = el(doc, "div", "wtn-mp-search-wrap");
  searchWrap.appendChild(el(doc, "span", "wtn-mp-search-icon"));
  const search = el(doc, "input", "wtn-mp-search");
  search.type = "text";
  search.placeholder = "Search…";
  search.spellcheck = false;
  searchWrap.appendChild(search);
  panel.appendChild(searchWrap);

  const list = el(doc, "div", "wtn-mp-list");
  panel.appendChild(list);

  let models = [];
  let loading = true;

  function render() {
    list.innerHTML = "";
    if (loading) {
      const msg = el(doc, "div", "wtn-mp-empty");
      msg.textContent = "Loading…";
      list.appendChild(msg);
      return;
    }
    const term = search.value;
    const filtered = filterModelsFlat(models, term);
    if (!filtered.length) {
      const msg = el(doc, "div", "wtn-mp-empty");
      msg.textContent = models.length ? "No matches." : "No files found.";
      list.appendChild(msg);
      return;
    }
    if (term.trim()) {
      // Flat while filtering -- group headers collapse away (§1a-v).
      filtered.forEach((m) => {
        list.appendChild(buildRow(doc, kind, m, currentName, hideExtension, showThumbnails, (name) => {
          if (typeof onPick === "function") {
            onPick(name);
          }
          handle.close();
        }));
      });
      return;
    }
    groupModels(filtered).forEach(({ group, models: groupEntries }) => {
      const hd = el(doc, "div", "wtn-mp-group-hd");
      hd.textContent = group;
      list.appendChild(hd);
      groupEntries.forEach((m) => {
        list.appendChild(buildRow(doc, kind, m, currentName, hideExtension, showThumbnails, (name) => {
          if (typeof onPick === "function") {
            onPick(name);
          }
          handle.close();
        }));
      });
    });
  }

  search.addEventListener("input", render);
  render(); // initial "Loading…" state

  const handle = openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, panel, "below", () => {
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }, "wtn-mp-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;

  // Size the panel for real (owner-reported overflow bug, 2026-07-30): the
  // CSS `max-height: 62vh` fallback above is a fraction of the WHOLE
  // viewport, which says nothing about how much room actually exists below
  // THIS anchor -- a picker opened from a row near the bottom of the screen
  // ran the panel straight off the bottom. Computed from the space actually
  // available below the anchor instead (`../shared/overlay.mjs`'s
  // `computeAnchoredMaxHeight`, the same fix already applied to
  // `civitai_search.mjs`'s panel), then re-run `reposition()` so the
  // above/below flip decision sees the corrected height. A no-op (leaves the
  // CSS fallback in place) with no real live `window` to measure -- every
  // headless test with no `defaultView`.
  const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
  if (win && typeof win.innerHeight === "number") {
    const anchorRect = typeof anchorEl.getBoundingClientRect === "function" ? anchorEl.getBoundingClientRect() : null;
    if (anchorRect) {
      const chromeHeight = searchWrap.getBoundingClientRect().height;
      const maxH = computeAnchoredMaxHeight({
        anchorBottom: anchorRect.bottom,
        viewportHeight: win.innerHeight,
        chromeHeight,
        minContentHeight: MIN_LIST_HEIGHT_PX,
      });
      if (maxH != null) {
        panel.style.maxHeight = `${Math.round(maxH)}px`;
        if (typeof handle.reposition === "function") {
          handle.reposition();
        }
      }
    }
  }

  if (typeof search.focus === "function") {
    search.focus(); // "takes focus on open" (§1a-v)
  }

  listModels(kind).then((fetched) => {
    models = fetched;
    loading = false;
    render();
  });

  return handle;
}
