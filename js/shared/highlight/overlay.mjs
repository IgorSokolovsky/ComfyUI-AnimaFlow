/**
 * overlay.mjs — the mirror-`<div>`-under-a-transparent-textarea technique:
 * a same-parent SIBLING element (never a reparent/replace of the textarea
 * itself — `js/autocomplete/` binds directly to these same elements and
 * must keep working) painted with colored `<span>`s, kept pixel-exact under
 * the real, still-interactive, still-focusable textarea by copying its
 * font/box metrics and mirroring its scroll position.
 *
 * Adapted, with attribution, from the overlay/metric-sync technique in
 * `../ComfyUI-EasyUseAnima/web/js/prompt_studio/highlight_overlay_core.js`
 * (MIT © n0va39; this pack credits it in README/THIRD_PARTY_NOTICES) — in
 * particular its `HIGHLIGHT_TEXT_METRIC_PROPERTIES` list, which is the part
 * that actually matters: an incomplete copy of it is exactly how the
 * colored text drifts out from under the real caret.
 */

import { SECTIONS, sectionTokenCss, sectionVarsCss } from "./colors.mjs";

const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";
const STYLE_ID = "wtn-hl-style";
const MIRROR_MARKER = "__wtnHighlightMirror";
const ORIGINAL_STYLE_MARKER = "__wtnHighlightOriginalStyle";

/**
 * The font/box metrics that must match between the textarea and its mirror
 * or wrapped text drifts out from under the caret. This is the crux of the
 * whole technique (see the EasyUseAnima reference's own comment on the
 * equivalent list) — keep it in sync with any future textarea styling
 * change, don't trim it "for tidiness".
 */
export const METRIC_PROPERTIES = [
  "font",
  "fontFamily",
  "fontSize",
  "fontSizeAdjust",
  "fontStretch",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontKerning",
  "fontFeatureSettings",
  "fontVariationSettings",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textAlign",
  "textTransform",
  "textRendering",
  "direction",
  "tabSize",
  "whiteSpace",
  "overflowWrap",
  "wordWrap",
  "wordBreak",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "border",
  "borderRadius",
  "boxSizing",
];

/** Copies every property in `METRIC_PROPERTIES` from `sourceStyle` (a
 * `CSSStyleDeclaration`, e.g. `getComputedStyle(textarea)`, or a plain
 * stub object in tests) onto `targetEl.style`. Skips a property the source
 * doesn't have (`undefined`) rather than writing the literal string
 * `"undefined"`, and skips a no-op write (value already matches).
 */
export function copyTextMetrics(sourceStyle, targetEl) {
  if (!sourceStyle || !targetEl || !targetEl.style) {
    return;
  }
  for (const prop of METRIC_PROPERTIES) {
    const value = sourceStyle[prop];
    if (value === undefined || value === null) {
      continue;
    }
    if (targetEl.style[prop] !== value) {
      targetEl.style[prop] = value;
    }
  }
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function spanHtml(span) {
  if (span.gap || !span.section) {
    return escapeHtml(span.text);
  }
  const attrs = [`class="wtn-hl-tok"`, `data-section="${escapeAttr(span.section)}"`];
  if (span.weighted) {
    attrs.push('data-weighted="true"');
  }
  const title = span.label || span.section;
  if (title) {
    attrs.push(`title="${escapeAttr(title)}"`);
  }
  return `<span ${attrs.join(" ")}>${escapeHtml(span.text)}</span>`;
}

/**
 * Renders `spans` (from `classify.mjs`'s `buildSpans`) into the mirror's
 * `innerHTML` for `text`. Handles two classic bugs directly:
 *  - empty text -> empty string (caller decides whether to show a
 *    placeholder; this module doesn't know the textarea's `placeholder`).
 *  - a TRAILING newline -> without help, a trailing `\n` collapses to an
 *    empty final visual line whose height the mirror doesn't reserve (a
 *    `<pre>`/`white-space:pre-wrap` block doesn't render height for a
 *    dangling empty last line the same way a textarea does), so every line
 *    above it silently drifts out of alignment. Appending one literal space
 *    after the rendered HTML gives that last line real content and fixes
 *    the drift — same trick the EasyUseAnima reference uses.
 */
export function renderMirrorHtml(text, spans) {
  const value = String(text ?? "");
  if (!value) {
    return "";
  }
  const html = (spans || []).map(spanHtml).join("");
  return value.endsWith("\n") ? `${html} ` : html;
}

/** Injects this module's stylesheet (section colors + mirror base rules)
 * once, and defensively re-attempts the shared house theme (only inside a
 * real browser `document` — see the `animaflow-node-theme` skill's guarded
 * dynamic-import rule) in case the host node embeds this module before its
 * own `injectTheme()` call. Every rule below also has its own hardcoded
 * fallback, so styling is correct even if that theme import never lands.
 */
export function injectHighlightStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc) {
    return;
  }
  if (typeof document !== "undefined" && targetDoc === document) {
    import(THEME_URL)
      .then((m) => m.injectTheme())
      .catch(() => {
        // No live ComfyUI server to serve the route (e.g. a bare test
        // page) -- non-fatal, every rule below has a hex fallback.
      });
  }
  if (targetDoc.getElementById(STYLE_ID)) {
    return;
  }
  const style = targetDoc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
${sectionVarsCss()}

.wtn-hl-mirror {
  position: absolute;
  box-sizing: border-box;
  margin: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: normal;
  background: var(--wtn-console, #0a0d12);
  color: var(--wtn-ink, #e7ecf3);
}

${sectionTokenCss()}

.wtn-hl-legend { font-family: var(--wtn-font-ui, system-ui); }
.wtn-hl-legend-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 16px;
}
.wtn-hl-legend-item { display: flex; align-items: center; gap: 8px; min-width: 0; }
.wtn-hl-legend-swatch {
  width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto;
  background: var(--wtn-hl-unknown, #e7ecf3);
}
${SECTION_SWATCH_CSS}
.wtn-hl-legend-label {
  font-size: 11.5px; color: var(--wtn-ink-dim, #93a0b1);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
`;
  targetDoc.head.appendChild(style);
}

// Per-section swatch background rules -- colors.mjs's SECTIONS table stays
// the single source of truth for hues; this just points each swatch at the
// same `--wtn-hl-*` var (+ fallback) the token paint rules use.
const SECTION_SWATCH_CSS = SECTIONS.map(
  (section) => `.wtn-hl-legend-swatch[data-section="${section.id}"] { background: var(${section.varName}, ${section.hex}); }`,
).join("\n");

function ensureRelativePositioning(doc, parent) {
  const style = typeof window !== "undefined" && window.getComputedStyle
    ? window.getComputedStyle(parent)
    : parent.style || {};
  if (!style.position || style.position === "static" || style.position === "") {
    parent.style.position = "relative";
  }
}

/** Applies the "transparent text, visible caret" treatment to `textarea`
 * (stashing its original inline styles so `restoreTextareaStyles` can put
 * them back on detach). Selection still reads correctly: a browser paints
 * the selection background regardless of the (transparent) text color, and
 * `caretColor` keeps the caret itself visible.
 */
export function applyTextareaOverlayStyles(textarea) {
  if (textarea[ORIGINAL_STYLE_MARKER]) {
    return; // already applied -- idempotent
  }
  textarea[ORIGINAL_STYLE_MARKER] = {
    color: textarea.style.color,
    background: textarea.style.background,
    caretColor: textarea.style.caretColor,
    webkitTextFillColor: textarea.style.webkitTextFillColor,
    whiteSpace: textarea.style.whiteSpace,
    overflowWrap: textarea.style.overflowWrap,
    wordBreak: textarea.style.wordBreak,
    position: textarea.style.position,
  };
  textarea.style.color = "transparent";
  textarea.style.background = "transparent";
  textarea.style.caretColor = "var(--wtn-ink, #e7ecf3)";
  textarea.style.webkitTextFillColor = "transparent";
  textarea.style.whiteSpace = "pre-wrap";
  textarea.style.overflowWrap = "break-word";
  textarea.style.wordBreak = "normal";
  textarea.style.position = textarea.style.position || "relative";
  textarea.style.zIndex = "1";
  textarea.spellcheck = false;
  textarea.setAttribute?.("autocomplete", "off");
  textarea.setAttribute?.("autocorrect", "off");
  textarea.setAttribute?.("autocapitalize", "off");
}

/** Restores whatever inline styles `applyTextareaOverlayStyles` overwrote. */
export function restoreTextareaStyles(textarea) {
  const original = textarea[ORIGINAL_STYLE_MARKER];
  if (!original) {
    return;
  }
  textarea.style.color = original.color;
  textarea.style.background = original.background;
  textarea.style.caretColor = original.caretColor;
  textarea.style.webkitTextFillColor = original.webkitTextFillColor;
  textarea.style.whiteSpace = original.whiteSpace;
  textarea.style.overflowWrap = original.overflowWrap;
  textarea.style.wordBreak = original.wordBreak;
  textarea.style.position = original.position;
  delete textarea[ORIGINAL_STYLE_MARKER];
}

/**
 * Creates (or returns the existing) mirror for `textarea`, inserted as a
 * SIBLING immediately before it in `textarea`'s own parent -- the parent is
 * never touched beyond (if needed) switching `position: static` to
 * `relative` so the mirror's `position: absolute` lands correctly, and the
 * textarea itself is never reparented, removed, or replaced. This is what
 * keeps `js/autocomplete/`'s own binding to this exact element intact.
 */
export function ensureOverlay(doc, textarea) {
  if (!textarea) {
    return null;
  }
  const targetDoc = doc || textarea.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!targetDoc) {
    return null;
  }
  const existing = textarea[MIRROR_MARKER];
  if (existing && existing.parentNode === textarea.parentNode) {
    return existing;
  }

  const parent = textarea.parentNode;
  if (!parent) {
    return null;
  }
  ensureRelativePositioning(targetDoc, parent);

  injectHighlightStyles(targetDoc);

  const mirror = targetDoc.createElement("div");
  mirror.className = "wtn-hl-mirror wtn-hl";
  mirror.setAttribute("aria-hidden", "true");
  parent.insertBefore(mirror, textarea);

  applyTextareaOverlayStyles(textarea);
  const sourceStyle = typeof window !== "undefined" && window.getComputedStyle
    ? window.getComputedStyle(textarea)
    : textarea.style || {};
  copyTextMetrics(sourceStyle, mirror);
  syncBounds(textarea, mirror);

  textarea[MIRROR_MARKER] = mirror;
  return mirror;
}

/** Copies position/size from `textarea` onto `mirror` (`offsetLeft/Top/
 * Width/Height`, matching the reference's `overlayBounds`) and mirrors
 * scroll position both ways aren't needed -- only textarea -> mirror,
 * since the mirror is never independently scrollable by the user.
 */
export function syncBounds(textarea, mirror) {
  if (!textarea || !mirror || !mirror.style) {
    return;
  }
  const left = `${textarea.offsetLeft || 0}px`;
  const top = `${textarea.offsetTop || 0}px`;
  const width = `${textarea.offsetWidth || 0}px`;
  const height = `${textarea.offsetHeight || 0}px`;
  if (mirror.style.left !== left) mirror.style.left = left;
  if (mirror.style.top !== top) mirror.style.top = top;
  if (mirror.style.width !== width) mirror.style.width = width;
  if (mirror.style.height !== height) mirror.style.height = height;
  if (mirror.scrollTop !== textarea.scrollTop) mirror.scrollTop = textarea.scrollTop;
  if (mirror.scrollLeft !== textarea.scrollLeft) mirror.scrollLeft = textarea.scrollLeft;
}

/** Removes the mirror and restores the textarea's original inline styles
 * (the `detach()` counterpart to `ensureOverlay` + `applyTextareaOverlayStyles`).
 */
export function removeOverlay(textarea) {
  if (!textarea) {
    return;
  }
  const mirror = textarea[MIRROR_MARKER];
  if (mirror && mirror.parentNode) {
    mirror.parentNode.removeChild(mirror);
  }
  delete textarea[MIRROR_MARKER];
  restoreTextareaStyles(textarea);
}
