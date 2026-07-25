/**
 * render.mjs — the Anima Preview node's DOM UI.
 *
 * Deliberately small and fixed-ish (per the node's whole reason to exist:
 * an isolated, independently-resizable display panel so the AnimaGenerator
 * node's settings sprawl never has to fight a live-image panel for graph
 * pan/zoom room — see `playground/anima_generator.html`'s `.prev-node`).
 * One `addDOMWidget` root: a CHANNEL field (mirrors the hidden native
 * `channel` widget, same hide-and-mirror pattern as
 * `js/anima_prompt/prompt_combiner/index.js`'s TEMPLATE field), a square preview frame
 * (image + stage-label badge + zoom in/out), and a small thumbnail strip of
 * the last few received frames (`core.mjs`'s `MAX_HISTORY`).
 *
 * Sizing: the preview frame uses a CSS `aspect-ratio: 1 / 1` box, so its
 * height is fully determined by the node's OWN width at layout time — unlike
 * `js/anima_prompt/prompt_combiner`'s open-ended LIVE PREVIEW text block, there is no
 * unbounded-growth child here needing a `PREVIEW_MIN`-style substitution;
 * `measureMinHeight` can just sum every visible child's real (already
 * deterministic) `offsetHeight`. Still follows the same two-renderer
 * contract from the frontend skill: `getMinHeight` (legacy canvas, the
 * PRIMARY path this build targets) + `computeLayoutSize` (Nodes 2.0
 * forward-compat, `minWidth: 1`). Only fit ONCE at mount/restore (see
 * `index.js`'s `scheduleInitialFit` call) — a new incoming frame repaints
 * the image/badge/strip in place and never resizes the node.
 */

import { injectTheme, TOKENS } from "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

const STYLE_ID = "wtn-anima-preview-style";

const CSS = `
.wtn-ap-root {
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 2px 2px;
}
.wtn-ap-root, .wtn-ap-root * { box-sizing: border-box; }

.wtn-ap-channel-row { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 8px; align-items: center; }
.wtn-ap-channel-label {
  font-family: var(--wtn-font-mono, ${TOKENS.console});
  font-size: 10px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-ap-channel-input {
  width: 100%;
  font-family: var(--wtn-font-mono, monospace);
  font-size: 12px;
  color: var(--wtn-ink, ${TOKENS.ink});
  background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: var(--wtn-radius-sm, 7px);
  padding: 6px 8px;
  outline: none;
}
.wtn-ap-channel-input:focus { border-color: var(--wtn-accent, ${TOKENS.accent}); }

.wtn-ap-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: var(--wtn-radius-sm, 7px);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.wtn-ap-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform-origin: center;
  transition: transform .12s ease-out;
}
.wtn-ap-frame.wtn-ap-empty img { display: none; }
.wtn-ap-empty-text {
  display: none;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  font-size: 11px; font-style: italic; text-align: center; padding: 0 14px;
}
.wtn-ap-frame.wtn-ap-empty .wtn-ap-empty-text { display: block; }

.wtn-ap-badge {
  position: absolute; top: 7px; left: 7px;
  display: inline-flex; align-items: center;
  font-family: var(--wtn-font-mono, monospace); font-size: 10px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--wtn-info, ${TOKENS.info});
  color: var(--wtn-info, ${TOKENS.info});
  background: rgba(125, 211, 252, .12);
}
.wtn-ap-frame.wtn-ap-empty .wtn-ap-badge { display: none; }

.wtn-ap-zoom { position: absolute; bottom: 7px; right: 7px; display: flex; gap: 4px; }
.wtn-ap-frame.wtn-ap-empty .wtn-ap-zoom { display: none; }
.wtn-ap-zoom-btn {
  width: 20px; height: 20px; padding: 0; line-height: 1; font-size: 12px; font-weight: 700;
  border-radius: 5px; cursor: pointer;
  background: rgba(10, 13, 18, .7);
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-ap-zoom-btn:hover { border-color: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-accent, ${TOKENS.accent}); }

.wtn-ap-strip { display: flex; gap: 5px; }
.wtn-ap-thumb {
  width: 32px; height: 32px; flex: 0 0 auto;
  border-radius: 5px; object-fit: cover; cursor: pointer;
  background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line});
}
.wtn-ap-thumb.wtn-ap-thumb-active { border-color: var(--wtn-accent, ${TOKENS.accent}); }
`;

/** Injects the house theme once + this node's own rules once, guarded by
 * `#wtn-anima-preview-style`. */
export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  injectTheme();
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

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 2.5;
export const ZOOM_STEP = 0.25;

const EMPTY_TEXT = "Waiting for frames … wire an AnimaGenerator to the same channel.";

export function buildRoot(doc) {
  const d = doc || document;

  const root = d.createElement("div");
  root.className = "wtn-ap-root wtn";

  // ---- Channel field (mirrors the hidden native `channel` widget) ----
  const channelRow = d.createElement("div");
  channelRow.className = "wtn-ap-channel-row";
  const channelLabel = d.createElement("span");
  channelLabel.className = "wtn-ap-channel-label";
  channelLabel.textContent = "Channel";
  const channelInput = d.createElement("input");
  channelInput.type = "text";
  channelInput.className = "wtn-ap-channel-input";
  channelInput.setAttribute("spellcheck", "false");
  channelInput.setAttribute("autocomplete", "off");
  channelInput.placeholder = "default";
  channelInput.title =
    "Must exactly match the AnimaGenerator node's preview_channel field to receive its live frames. Not a wired socket - any number of AnimaPreview nodes can share one channel, or none at all.";
  channelRow.appendChild(channelLabel);
  channelRow.appendChild(channelInput);

  // ---- Preview frame ----
  const frameEl = d.createElement("div");
  frameEl.className = "wtn-ap-frame wtn-ap-empty";

  const imgEl = d.createElement("img");
  imgEl.alt = "Live preview frame";
  frameEl.appendChild(imgEl);

  const emptyTextEl = d.createElement("div");
  emptyTextEl.className = "wtn-ap-empty-text";
  emptyTextEl.textContent = EMPTY_TEXT;
  frameEl.appendChild(emptyTextEl);

  const badgeEl = d.createElement("span");
  badgeEl.className = "wtn-ap-badge";
  frameEl.appendChild(badgeEl);

  const zoomWrap = d.createElement("div");
  zoomWrap.className = "wtn-ap-zoom";
  const zoomOutBtn = d.createElement("button");
  zoomOutBtn.type = "button";
  zoomOutBtn.className = "wtn-ap-zoom-btn";
  zoomOutBtn.textContent = "–";
  zoomOutBtn.title = "Zoom out";
  const zoomInBtn = d.createElement("button");
  zoomInBtn.type = "button";
  zoomInBtn.className = "wtn-ap-zoom-btn";
  zoomInBtn.textContent = "+";
  zoomInBtn.title = "Zoom in";
  zoomWrap.appendChild(zoomOutBtn);
  zoomWrap.appendChild(zoomInBtn);
  frameEl.appendChild(zoomWrap);

  // ---- Thumbnail strip ----
  const stripEl = d.createElement("div");
  stripEl.className = "wtn-ap-strip";

  root.appendChild(channelRow);
  root.appendChild(frameEl);
  root.appendChild(stripEl);

  return {
    doc: d,
    root,
    channelInput,
    frameEl,
    imgEl,
    emptyTextEl,
    badgeEl,
    zoomOutBtn,
    zoomInBtn,
    stripEl,
    zoomLevel: MIN_ZOOM,
    history: [],
    activeIndex: -1,
  };
}

/** Render `frame` (`{stageLabel, imageData}` or `null` for the empty
 * placeholder) as the main displayed image. Never resizes the node. */
export function renderActiveFrame(refs, frame) {
  if (!frame || !frame.imageData) {
    refs.frameEl.classList.add("wtn-ap-empty");
    refs.imgEl.removeAttribute("src");
    refs.badgeEl.textContent = "";
    return;
  }
  refs.frameEl.classList.remove("wtn-ap-empty");
  refs.imgEl.src = `data:image/png;base64,${frame.imageData}`;
  refs.badgeEl.textContent = frame.stageLabel || "";
  refs.badgeEl.title = frame.stageLabel || "";
}

/** Rebuild the thumbnail strip from `history` (oldest first, per
 * `core.mjs`'s `pushFrame`), marking `activeIndex` as the currently-viewed
 * frame. Clicking a thumb is wired by `interaction.mjs`, not here. */
export function renderThumbs(refs, history, activeIndex, onSelect) {
  const strip = refs.stripEl;
  while (strip.firstChild) {
    strip.removeChild(strip.firstChild);
  }
  (history || []).forEach((frame, index) => {
    const thumb = refs.doc.createElement("img");
    thumb.className = "wtn-ap-thumb" + (index === activeIndex ? " wtn-ap-thumb-active" : "");
    thumb.src = `data:image/png;base64,${frame.imageData}`;
    thumb.title = frame.stageLabel || `Frame ${index + 1}`;
    thumb.addEventListener("click", () => {
      if (typeof onSelect === "function") {
        onSelect(index);
      }
    });
    strip.appendChild(thumb);
  });
}

/** Apply `refs.zoomLevel` as a CSS transform on the displayed image (the
 * frame itself stays a fixed `aspect-ratio` box with `overflow: hidden`, so
 * zooming never changes the node's size). */
export function applyZoom(refs) {
  refs.imgEl.style.transform = `scale(${refs.zoomLevel})`;
}

export function clampZoom(level) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, level));
}

// ---- Resize mechanism (matches js/anima_prompt/prompt_combiner's, see that file's doc
// comment for the two-renderer rationale) — kept here since this content's
// height is fully deterministic (fixed aspect-ratio frame + fixed-height
// rows), so, unlike prompt_combiner's open-ended LIVE PREVIEW, no
// substitute-a-floor-constant trick is needed: summing real offsetHeights
// is already stable and non-recursive. ----

export const CHROME = 46;
export const DEFAULT_W = 260;
export const DEFAULT_H = 300;

export function measureMinHeight(root) {
  if (!root) {
    return DEFAULT_H;
  }
  let h = 0;
  let count = 0;
  for (const child of root.children) {
    if (child.offsetParent === null) {
      continue;
    }
    count += 1;
    h += child.offsetHeight;
  }
  const cs = getComputedStyle(root);
  const gap = parseFloat(cs.rowGap || cs.gap) || 0;
  if (count > 1) {
    h += gap * (count - 1);
  }
  h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return Math.max(160, Math.round(h / 4) * 4);
}

export function setNodeHeight(node, h) {
  node.size[1] = h;
  if (typeof node.setSize === "function") {
    node.setSize([node.size[0], h]);
  }
  node._apAutoH = h;
}

export function refitNode(node, root) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const cur = node.size[1];
  const autoH = node._apAutoH;
  const userEnlarged = autoH != null && cur > autoH + 4;
  let target = cur;
  if (want > cur) {
    target = want;
  } else if (!userEnlarged && want < cur) {
    target = want;
  }
  if (target !== cur) {
    setNodeHeight(node, target);
  }
}

export function scheduleInitialFit(node, root) {
  requestAnimationFrame(() => {
    if (node._apConfigured) {
      // Loaded from a saved workflow - trust the restored node.size.
      return;
    }
    refitNode(node, root);
    if (node.setDirtyCanvas) {
      node.setDirtyCanvas(true, true);
    }
  });
}
