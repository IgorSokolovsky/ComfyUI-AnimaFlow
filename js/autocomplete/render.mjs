/**
 * render.mjs — the autocomplete popup's DOM: built ONCE (a module-level
 * singleton, reused/repositioned for every attached widget and every
 * query — see `ensurePopup`), appended to `document.body` so it floats
 * above the litegraph canvas instead of being confined to one node's
 * bounds, styled with the house dark-slate/teal theme (`js/shared/theme.*`).
 */

import { injectTheme, TOKENS } from "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";
import { Z_PANEL } from "../shared/z_layers.mjs";

const STYLE_ID = "wtn-autocomplete-style";

// `Z_PANEL` (`js/shared/z_layers.mjs`), not the bare `10000` this used to
// say: this popup is anchored over a node's own widget (`attachAutocomplete`
// is only ever called from `./index.js`'s `maybeAttachWidget`/`scanNode`,
// i.e. over a node's textarea/text widget -- it never attaches inside the
// Rule Builder overlay, which isn't a node widget), so it's a canvas-level
// anchored popover, the SAME tier every other popover/menu this pack opens
// through `openOverlay`/`openOverlayWithZoom` already uses -- never the
// tooltip tier (it's a real interactive list, not a hover hint) and never a
// full modal (it never covers the whole viewport).
const CSS = `
.wtn-ac-popup {
  position: fixed; z-index: ${Z_PANEL}; display: none;
  min-width: 220px; max-width: 380px; max-height: 260px; overflow-y: auto;
  background: var(--wtn-surface, ${TOKENS.surface});
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: var(--wtn-radius-sm, 7px);
  box-shadow: var(--wtn-shadow, 0 10px 28px rgba(0,0,0,.55));
  font-family: var(--wtn-font-ui, system-ui);
  padding: 4px;
}
.wtn-ac-popup.wtn-ac-show { display: block; }
.wtn-ac-list { list-style: none; margin: 0; padding: 0; }
.wtn-ac-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px;
  cursor: pointer; font-family: var(--wtn-font-mono, monospace); font-size: 12.5px;
  color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-ac-item:hover, .wtn-ac-item.wtn-ac-active {
  background: var(--wtn-surface-2, ${TOKENS.surface2}); color: var(--wtn-accent, ${TOKENS.accent});
}
.wtn-ac-tag { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtn-ac-badge {
  font-family: var(--wtn-font-ui, system-ui); font-size: 9.5px; text-transform: uppercase;
  letter-spacing: .04em; padding: 1px 6px; border-radius: 999px; flex: 0 0 auto;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); border: 1px solid var(--wtn-line, ${TOKENS.line});
}
.wtn-ac-badge[data-category="artist"] { color: var(--wtn-tmp, ${TOKENS.tmp}); }
.wtn-ac-badge[data-category="character"] { color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-ac-badge[data-category="copyright"] { color: var(--wtn-info, ${TOKENS.info}); }
.wtn-ac-badge[data-category="meta"] { color: var(--wtn-warn, ${TOKENS.warn}); }
.wtn-ac-count, .wtn-ac-source {
  flex: 0 0 auto; font-family: var(--wtn-font-mono, monospace);
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 10.5px;
}
.wtn-ac-empty { padding: 8px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 12px; font-style: italic; }
`;

/** Injects both the house theme stylesheet and this popup's own rules,
 * each guarded by an id check so repeated calls (once per attached widget)
 * are safe no-ops after the first.
 */
export function injectStyles(doc = document) {
  injectTheme();
  if (doc.getElementById(STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

// Hover text for the category badge -- explains what the badge means for
// anyone unfamiliar with booru tag categories (per the plan's tooltip note:
// no INPUT_TYPES tooltips apply here since there's no node, so this is the
// equivalent "explain what this UI element shows" affordance).
const CATEGORY_TITLES = {
  general: "General tag — describes the scene/subject itself.",
  artist: "Artist tag — the drawing style/creator, not scene content.",
  character: "Character name tag.",
  copyright: "Series / copyright tag (the work this character/setting is from).",
  meta: "Meta tag — image quality/format info (e.g. resolution), not depicted content.",
};

let popupEl = null;

/** Build (once) the single shared popup element, appended to
 * `document.body`. Safe to call repeatedly — returns the existing element
 * once built (re-creates it if it was ever removed from the DOM).
 */
export function ensurePopup() {
  if (popupEl && popupEl.isConnected) {
    return popupEl;
  }
  popupEl = document.createElement("div");
  popupEl.className = "wtn-ac-popup wtn";
  const list = document.createElement("ul");
  list.className = "wtn-ac-list";
  popupEl.appendChild(list);
  document.body.appendChild(popupEl);
  return popupEl;
}

function formatCount(count) {
  const value = Number(count) || 0;
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

/** Re-render the suggestion list (`items`, each `{tag, category, count,
 * source}`) into `popup`, highlighting `activeIndex` for keyboard nav.
 */
export function renderItems(popup, items, activeIndex) {
  const list = popup.querySelector(".wtn-ac-list");
  list.innerHTML = "";

  if (!items || items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "wtn-ac-empty";
    empty.textContent = "No matching tags";
    list.appendChild(empty);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "wtn-ac-item" + (index === activeIndex ? " wtn-ac-active" : "");
    li.dataset.index = String(index);

    const tagEl = document.createElement("span");
    tagEl.className = "wtn-ac-tag";
    tagEl.textContent = item.tag;
    li.appendChild(tagEl);

    const badge = document.createElement("span");
    badge.className = "wtn-ac-badge";
    badge.dataset.category = item.category;
    badge.textContent = item.category;
    badge.title = CATEGORY_TITLES[item.category] || "Tag category.";
    li.appendChild(badge);

    const count = document.createElement("span");
    count.className = "wtn-ac-count";
    count.textContent = formatCount(item.count);
    count.title = `${(Number(item.count) || 0).toLocaleString()} posts`;
    li.appendChild(count);

    const source = document.createElement("span");
    source.className = "wtn-ac-source";
    source.textContent = item.source === "danbooru" ? "DB" : "GB";
    source.title =
      item.source === "danbooru" ? "Danbooru (fallback source)" : "Gelbooru (primary source)";
    li.appendChild(source);

    list.appendChild(li);
  });
}

/** Show `popup` at page coordinates `(x, y)`, clamped into the viewport
 * (mirrors ComfyUI-Pixaroma's color-picker popup clamping).
 */
export function showPopup(popup, x, y) {
  popup.classList.add("wtn-ac-show");
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;

  const rect = popup.getBoundingClientRect();
  const vpad = 8;
  if (rect.right > window.innerWidth - vpad) {
    popup.style.left = `${Math.max(vpad, window.innerWidth - rect.width - vpad)}px`;
  }
  if (rect.bottom > window.innerHeight - vpad) {
    // Flip above the caret line instead of spilling off the bottom edge.
    popup.style.top = `${Math.max(vpad, y - rect.height - 20)}px`;
  }
}

export function hidePopup(popup) {
  popup.classList.remove("wtn-ac-show");
}

// ---------------------------------------------------------------------
// Caret coordinate measurement — the standard "textarea caret position"
// technique: a hidden mirror element copies the control's box + font
// metrics and is positioned exactly over it, so a marker span inserted at
// the caret's offset lands at the real caret's on-screen position. This is
// the one thing here that genuinely needs real font metrics (per the
// plan), so it's a small local implementation rather than a dependency.
// ---------------------------------------------------------------------

const MIRROR_STYLE_PROPS = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontSize",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textIndent",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
];

let mirrorEl = null;

function getMirror() {
  if (!mirrorEl || !mirrorEl.isConnected) {
    mirrorEl = document.createElement("div");
    mirrorEl.setAttribute("aria-hidden", "true");
    mirrorEl.style.position = "absolute";
    mirrorEl.style.visibility = "hidden";
    mirrorEl.style.zIndex = "-1";
    mirrorEl.style.overflow = "hidden";
    document.body.appendChild(mirrorEl);
  }
  return mirrorEl;
}

/**
 * Page (viewport) coordinates of the caret inside `el` (a `<textarea>` or
 * text `<input>`) at `caretPos`, RELATIVE to `el`'s own top-left corner
 * (i.e. add `el.getBoundingClientRect().left/top` to get page coordinates —
 * callers do this, keeping this function testable without a real
 * bounding-rect-having element). Best-effort: close enough for popup
 * placement, not pixel-perfect typography.
 */
export function caretCoords(el, caretPos) {
  const style = window.getComputedStyle(el);
  const mirror = getMirror();
  const rect = el.getBoundingClientRect();
  mirror.style.width = rect.width ? `${rect.width}px` : style.width;
  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style[prop] = style[prop];
  }
  const isTextarea = el.tagName && el.tagName.toLowerCase() === "textarea";
  mirror.style.whiteSpace = isTextarea ? "pre-wrap" : "pre";
  mirror.style.wordWrap = "break-word";

  const value = el.value || "";
  const pos = Math.max(0, Math.min(caretPos == null ? value.length : caretPos, value.length));

  mirror.textContent = "";
  mirror.appendChild(document.createTextNode(value.slice(0, pos)));
  const marker = document.createElement("span");
  marker.textContent = "​"; // needs a glyph to have a measurable box
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(value.slice(pos) || "​"));

  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const scrollTop = el.scrollTop || 0;
  const scrollLeft = el.scrollLeft || 0;

  return {
    x: markerRect.left - mirrorRect.left - scrollLeft,
    y: markerRect.top - mirrorRect.top - scrollTop,
    lineHeight: parseFloat(style.lineHeight) || markerRect.height || 16,
  };
}
