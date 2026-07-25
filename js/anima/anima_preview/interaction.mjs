/**
 * interaction.mjs — event wiring for the Anima Preview node's DOM UI.
 *
 * Owns: mirroring the styled DOM channel input <-> the hidden native
 * `channel` widget (same pattern as `js/anima_prompt/prompt_combiner`'s TEMPLATE
 * mirroring — see that file's `mirrorTemplateToWidget`), zoom in/out button
 * clicks, and thumbnail-strip selection. No litegraph node-lifecycle hooks
 * here (those live in `index.js`); no DOM construction (that's
 * `render.mjs`).
 */

import { clampZoom, applyZoom, renderThumbs, renderActiveFrame, ZOOM_STEP } from "./render.mjs";

/** Copy the DOM channel input's current value into the hidden native
 * `channel` widget so it keeps serializing/persisting normally (the widget
 * itself is never shown - see `index.js`'s `hideChannelWidget`). */
export function mirrorChannelToWidget(refs) {
  if (refs.channelWidget) {
    refs.channelWidget.value = refs.channelInput.value;
  }
}

/** Select `index` from `refs.history` as the actively-displayed frame
 * (clicking an older thumbnail "pins" the view to it; a newly arriving
 * frame still jumps the view back to live — see `index.js`'s frame
 * handler). */
export function selectHistoryIndex(refs, index) {
  const frame = refs.history[index];
  if (!frame) {
    return;
  }
  refs.activeIndex = index;
  renderActiveFrame(refs, frame);
  renderThumbs(refs, refs.history, refs.activeIndex, (i) => selectHistoryIndex(refs, i));
}

export function wireInteractions(node, refs) {
  refs.channelInput.addEventListener("input", () => {
    mirrorChannelToWidget(refs);
  });

  refs.zoomInBtn.addEventListener("click", () => {
    refs.zoomLevel = clampZoom(refs.zoomLevel + ZOOM_STEP);
    applyZoom(refs);
  });
  refs.zoomOutBtn.addEventListener("click", () => {
    refs.zoomLevel = clampZoom(refs.zoomLevel - ZOOM_STEP);
    applyZoom(refs);
  });
}
