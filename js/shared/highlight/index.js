/**
 * js/shared/highlight/index.js — node-agnostic prompt tag-highlighting.
 * Paints classifier-driven category colors onto ANY `<textarea>` (one call
 * per element) via a mirror overlay, with an optional color legend a node
 * can place anywhere. Every node in this pack that wants highlighting opts
 * in with a few lines; nothing here mounts itself automatically, and no
 * node is wired to it yet (that's a separate step, done after this API is
 * reviewed).
 *
 * Usage (from a node's `render.mjs`/`interaction.mjs`, after the textarea
 * exists in the DOM):
 *
 *   import { attachHighlighter, createLegend } from
 *     "/extensions/ComfyUI-AnimaFlow/shared/highlight/index.js";
 *
 *   const highlighter = attachHighlighter(textarea);   // paints as the user types
 *   root.appendChild(createLegend().el);                // optional, collapsed by default
 *   // later, e.g. on node removal: highlighter.detach();
 *
 * ## Design
 *
 * - `classify.mjs` — pure token math (`buildSpans`, offsets straight from
 *   the backend, never re-tokenized here) + the debounced / cached /
 *   last-write-wins fetch wrapper (`createClassifier`) calling
 *   `POST /wtn/classify`.
 * - `overlay.mjs` — the mirror-`<div>` DOM technique: font/box metric
 *   sync, scroll sync, the transparent-text/visible-caret textarea
 *   treatment. Adapted with attribution from
 *   `../ComfyUI-EasyUseAnima/web/js/prompt_studio/highlight_overlay_core.js`
 *   (MIT © n0va39).
 * - `colors.mjs` — the 16-section color/label table shared by the overlay
 *   and the legend.
 * - `legend.mjs` — the collapsible legend UI.
 *
 * ## Degradation
 *
 * Any failure anywhere in the classify round-trip (network error, a 404
 * from an older install missing the route, malformed/out-of-range JSON)
 * degrades to `tokens: []`, which paints the whole prompt as plain,
 * unhighlighted text -- never throws, never breaks the node. See
 * `classify.mjs`'s docstring for the exact contract.
 *
 * ## Coexistence with `js/autocomplete/`
 *
 * `js/autocomplete/` binds directly to the SAME `<textarea>` elements (it
 * scans a node's rendered DOM for any `<textarea>`). This module never
 * reparents, removes, or replaces the textarea -- the mirror is inserted as
 * a plain DOM sibling before it (see `overlay.mjs`'s `ensureOverlay`) -- and
 * never touches focus or intercepts `keydown`/`keyup`/`click` (autocomplete
 * owns those; this module only listens for `input`/`scroll` to resync
 * painting). The autocomplete popup itself is a SEPARATE element appended
 * straight to `document.body` with `position: fixed` and a very high
 * `z-index` (`js/autocomplete/render.mjs`'s `ensurePopup`), entirely outside
 * this module's mirror's stacking context, so it always paints above the
 * mirror without any z-index coordination needed here.
 */

import { buildSpans, createClassifier } from "./classify.mjs";
import {
  ensureOverlay,
  removeOverlay,
  renderMirrorHtml,
  syncBounds,
  copyTextMetrics,
} from "./overlay.mjs";

export { createLegend } from "./legend.mjs";
export { SECTIONS, sectionInfo, sectionLabel } from "./colors.mjs";
export { buildSpans } from "./classify.mjs";

const HANDLE_MARKER = "__wtnHighlighterHandle";

/**
 * Attaches the highlighter to `textarea`. Idempotent: a second call on the
 * same element returns the existing handle rather than double-attaching.
 *
 * Options:
 *  - `classifyUrl` (default `"/wtn/classify"`)
 *  - `limit` (default `500`) — forwarded to the classify request.
 *  - `debounceMs` (default `200`) — input-quiet debounce before refetching.
 *  - `getText` (default `() => textarea.value`) — override for a node whose
 *    "live" text isn't just the raw element value.
 *  - `onTokens(tokens, text)` — optional callback fired after every repaint.
 *  - `doc`, `fetchImpl`, `setTimeoutImpl`, `clearTimeoutImpl` — test/host
 *    overrides threaded through to `overlay.mjs`/`classify.mjs`.
 *
 * Returns a handle: `{ textarea, mirror, refresh(), detach() }`.
 */
export function attachHighlighter(textarea, opts = {}) {
  if (!textarea) {
    return null;
  }
  if (textarea[HANDLE_MARKER]) {
    return textarea[HANDLE_MARKER];
  }

  const {
    classifyUrl = "/wtn/classify",
    limit = 500,
    debounceMs = 200,
    getText = () => textarea.value,
    onTokens = null,
    doc = textarea.ownerDocument || (typeof document !== "undefined" ? document : null),
    fetchImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
  } = opts;

  const mirror = ensureOverlay(doc, textarea);
  if (!mirror) {
    return null;
  }

  const classifier = createClassifier({
    classifyUrl,
    limit,
    debounceMs,
    fetchImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
  });

  let paintedText = null; // "last painted text" guard -- avoids repaint churn

  function paint(tokens, text) {
    if (!mirror.isConnected && mirror.isConnected !== undefined) {
      return; // detached mid-flight
    }
    if (text === paintedText) {
      syncBounds(textarea, mirror);
      return;
    }
    const spans = buildSpans(text, tokens);
    mirror.innerHTML = renderMirrorHtml(text, spans);
    paintedText = text;
    syncBounds(textarea, mirror);
    onTokens?.(tokens, text);
  }

  function requestClassification() {
    const text = getText();
    classifier.schedule(text, (tokens, resolvedText) => {
      // A newer edit may have landed while this request/cache-hit resolved;
      // if so, the input handler that made it stale already scheduled its
      // own follow-up, so just drop this one instead of painting over it.
      if (resolvedText !== getText()) {
        return;
      }
      paint(tokens, resolvedText);
    });
  }

  function onInput() {
    syncBounds(textarea, mirror);
    requestClassification();
  }

  function onScroll() {
    syncBounds(textarea, mirror);
  }

  function resyncMetrics() {
    const win = doc && doc.defaultView ? doc.defaultView : (typeof window !== "undefined" ? window : null);
    const style = win && win.getComputedStyle ? win.getComputedStyle(textarea) : textarea.style;
    copyTextMetrics(style, mirror);
    syncBounds(textarea, mirror);
  }

  textarea.addEventListener("input", onInput);
  textarea.addEventListener("scroll", onScroll, { passive: true });

  let resizeObserver = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => resyncMetrics());
    resizeObserver.observe(textarea);
  }

  let fontsReadyHandled = false;
  if (doc && doc.fonts && typeof doc.fonts.ready?.then === "function" && !fontsReadyHandled) {
    fontsReadyHandled = true;
    doc.fonts.ready.then(() => resyncMetrics()).catch(() => {});
  }

  // Initial paint.
  requestClassification();

  const handle = {
    textarea,
    mirror,
    /** Forces an immediate metric/bounds resync and reclassification (e.g.
     * after a host-driven font-size or width change the observers above
     * didn't catch). */
    refresh() {
      resyncMetrics();
      requestClassification();
    },
    detach() {
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("scroll", onScroll);
      resizeObserver?.disconnect();
      classifier.cancel();
      removeOverlay(textarea);
      delete textarea[HANDLE_MARKER];
    },
  };
  textarea[HANDLE_MARKER] = handle;
  return handle;
}

/** Detaches a handle returned by `attachHighlighter` (a thin, symmetrical
 * alias for `handle.detach()` -- convenient when a caller only kept the
 * handle around, not the original textarea reference).
 */
export function detach(handle) {
  handle?.detach?.();
}
