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

  // Two-phase paint: `paintPlain()` renders `text` immediately with NO
  // color (an empty token list, per `buildSpans(text, [])`'s documented
  // "whole string is one gap span" fallback) so the mirror is NEVER empty
  // or showing stale text between a keystroke and the debounced/networked
  // `/wtn/classify` response. `paintColored()` -- called only from the
  // classifier's resolve callback -- repaints the SAME text with real
  // colors once that response lands. Color is a progressive enhancement
  // layered on top of text that was already fully visible.
  //
  // `paintedText`/`paintedTokenSig` is the repaint-churn guard, split into
  // two parts on purpose:
  //  - `paintedText` -- the text currently on screen, in EITHER phase.
  //  - `paintedTokenSig` -- `null` while that text is only plain-painted;
  //    a token signature (see `tokenSignature()`) once it's been colored.
  // THE TRAP this avoids: if a single "last painted text" guard treated
  // `paintPlain()` as fully satisfying "this text is painted", the
  // subsequent `paintColored()` call for that identical text (the normal
  // case -- classify almost always resolves for text the user has since
  // stopped changing) would be skipped by that same guard, and nothing
  // would ever get colored. Keying the guard on (text, phase) instead lets
  // plain -> colored through for identical text while still suppressing a
  // genuinely redundant repaint (e.g. the classifier's own "identical
  // text" cache re-invoking the resolve callback with the same tokens).
  let paintedText = null;
  let paintedTokenSig = null;

  /** Cheap signature of a resolved token list, used only to tell "the
   * exact same classification result, already painted" apart from "a new
   * (possibly still-empty) classification result for this text" -- see
   * the `paintedTokenSig` note above. Not a security/identity hash, just
   * enough to avoid a no-op re-render.
   */
  function tokenSignature(tokens) {
    if (!Array.isArray(tokens) || !tokens.length) {
      return ""; // a resolved-but-empty classification is still a distinct,
      // real signature -- distinct from `null` ("nothing colored yet").
    }
    return tokens.map((t) => `${t && t.start}:${t && t.end}:${t && t.section}`).join("|");
  }

  function detachedMidFlight() {
    return mirror.isConnected === false; // real DOM only; test stubs leave this `undefined`
  }

  function renderMirror(text, tokens) {
    const spans = buildSpans(text, tokens);
    mirror.innerHTML = renderMirrorHtml(text, spans);
    syncBounds(textarea, mirror);
  }

  /** Paints `text` immediately, uncolored. Synchronous, no network --
   * safe to call on every keystroke and at attach time. Skips the
   * re-render (but still resyncs bounds) when `text` is already on
   * screen, plain or colored, so a same-value `input` event is a no-op.
   */
  function paintPlain(text) {
    if (detachedMidFlight()) {
      return;
    }
    if (paintedText === text) {
      syncBounds(textarea, mirror);
      return;
    }
    renderMirror(text, []);
    paintedText = text;
    paintedTokenSig = null;
  }

  /** Paints `text` colored by the classifier's resolved `tokens` -- the
   * only path that fires `onTokens`. See the guard note above for why
   * this is allowed through even when `paintPlain()` already rendered the
   * same `text` moments earlier, while a truly repeated (text, tokens)
   * pair is still suppressed.
   */
  function paintColored(tokens, text) {
    if (detachedMidFlight()) {
      return;
    }
    const sig = tokenSignature(tokens);
    if (paintedText === text && paintedTokenSig === sig) {
      syncBounds(textarea, mirror);
      return;
    }
    renderMirror(text, tokens);
    paintedText = text;
    paintedTokenSig = sig;
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
      paintColored(tokens, resolvedText);
    });
  }

  function onInput() {
    // Plain-paint the CURRENT text synchronously first -- the user must
    // never see invisible/stale text while the debounced classify request
    // is still in flight. `requestClassification()` below repaints the
    // same text with color once it resolves.
    paintPlain(getText());
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

  // Initial paint -- plain immediately, THEN classify. Without the plain
  // phase, a workflow reload that restores a non-empty saved prompt would
  // show nothing at all in the mirror (transparent real text over an
  // empty/never-painted mirror) until the very first classify response
  // lands -- the same bug, in its worst form.
  paintPlain(getText());
  requestClassification();

  const handle = {
    textarea,
    mirror,
    /** Forces an immediate metric/bounds resync and reclassification (e.g.
     * after a host-driven font-size or width change the observers above
     * didn't catch, or a caller writing `textarea.value` directly --
     * see `js/anima_prompt/prompt_rules/highlight_wiring.mjs`'s
     * `refreshHighlighters`). Same two-phase behaviour as `onInput()`:
     * plain-paints the current text synchronously first, then
     * reclassifies for color. */
    refresh() {
      resyncMetrics();
      paintPlain(getText());
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
