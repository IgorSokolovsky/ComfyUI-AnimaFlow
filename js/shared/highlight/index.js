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
 * - `colors.mjs` — the 16-section color/background/weight/label table shared
 *   by the overlay and the legend.
 * - `legend.mjs` — the collapsible legend UI.
 * - `name_cache.mjs` / `optimistic.mjs` — the two-tier paint's tier 1 (see
 *   below): a module-level tag-name cache and the small client-side
 *   approximate splitter that consults it.
 *
 * ## Two-tier paint (optimistic, then authoritative)
 *
 * Coloring a prompt requires the backend's `/wtn/classify` response, which
 * is debounced and networked -- it cannot land on every keystroke. Painting
 * with ZERO color while it's in flight (the old `paintPlain()` behavior)
 * meant the user watched every keystroke drop all color, then have it flood
 * back ~200ms after they stopped typing -- worse than not highlighting at
 * all. Adopted from the reference pack's approach (its
 * `highlight_core.js`'s `renderHighlightedText` keys tokens by normalized
 * NAME via a `byBase` map, not by offset, so it can recolor instantly from
 * whatever it already knows):
 *
 *  - **Tier 1 -- optimistic, synchronous, every keystroke.**
 *    `paintOptimistic()` calls `optimistic.mjs`'s `buildOptimisticSpans()`,
 *    which splits the text client-side (approximate: comma/newline/paren
 *    aware, NOT the real classifier) and colors each piece from
 *    `name_cache.mjs`'s persistent `normalizedTag -> {section, label}`
 *    cache. A tag the user is re-typing (the common case when editing an
 *    existing prompt) is very likely already in that cache, so it recolors
 *    immediately with no visible flicker. An unfamiliar tag just renders
 *    plain, same as before -- no regression, only improvement.
 *  - **Tier 2 -- authoritative, debounced.** The existing `/wtn/classify`
 *    round-trip still runs on the same debounce as before. When it
 *    resolves, `paintColored()` repaints from the REAL offsets (not the
 *    approximate split) and calls `name_cache.mjs`'s `rememberTokens()` to
 *    teach the cache anything new -- this is what keeps tier 1's
 *    predictions honest over time. Tier 2 remains the sole source of truth;
 *    tier 1 is a prediction that's corrected within one debounce window.
 *
 * See the "paint kind" note on `paintedKind` below for how the repaint-churn
 * guard tells an optimistic paint apart from an authoritative one, so the
 * authoritative pass can still replace an optimistic paint of IDENTICAL
 * text (the same trap `paintPlain -> paintColored` had to avoid before).
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
import { buildOptimisticSpans } from "./optimistic.mjs";
import { rememberTokens } from "./name_cache.mjs";

export { createLegend } from "./legend.mjs";
export { SECTIONS, sectionInfo, sectionLabel } from "./colors.mjs";
export { buildSpans } from "./classify.mjs";
export { buildOptimisticSpans } from "./optimistic.mjs";
export { rememberToken, rememberTokens, lookupTagName, clearNameCache, nameCacheSize, NAME_CACHEABLE_SECTIONS } from "./name_cache.mjs";

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

  // Two-tier paint (see this file's docstring): `paintOptimistic()` renders
  // `text` immediately from the client-side approximate split + name cache
  // (colored where the cache already knows a tag, plain where it doesn't)
  // so the mirror is NEVER empty/stale AND never drops color the user
  // already had. `paintColored()` -- called only from the classifier's
  // resolve callback -- repaints the SAME text with the REAL, offset-exact
  // colors once that response lands, and teaches the cache anything new.
  //
  // `paintedText`/`paintedKind`/`paintedTokenSig` is the repaint-churn
  // guard, split into parts on purpose:
  //  - `paintedText` -- the text currently on screen, in EITHER paint kind.
  //  - `paintedKind` -- `null` (nothing painted yet), `"optimistic"`, or
  //    `"authoritative"` -- WHICH kind of paint is currently on screen.
  //  - `paintedTokenSig` -- only meaningful when `paintedKind ===
  //    "authoritative"`: a token signature (see `tokenSignature()`) of the
  //    exact classify result currently painted.
  // THE TRAP this avoids (same shape as the old plain/colored one, now with
  // a third kind in the mix): if a single "last painted text" guard treated
  // an OPTIMISTIC paint as fully satisfying "this text is painted", the
  // subsequent AUTHORITATIVE paint for that identical text (the normal
  // case -- classify usually resolves for text the user has since stopped
  // changing) would be skipped by that same guard, and the real, offset-
  // exact colors would never replace the guess. Keying the guard on (text,
  // kind[, sig]) instead lets optimistic -> authoritative through for
  // identical text while still suppressing two kinds of genuinely
  // redundant repaint: an optimistic repaint of text already on screen
  // (in EITHER kind -- optimistic must never downgrade an already-
  // authoritative paint back to a guess), and an authoritative repaint
  // whose (text, tokens) exactly match what's already painted (e.g. the
  // classifier's own "identical text" cache re-invoking the resolve
  // callback with the same tokens).
  let paintedText = null;
  let paintedKind = null; // null | "optimistic" | "authoritative"
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

  function renderMirrorFromSpans(text, spans) {
    mirror.innerHTML = renderMirrorHtml(text, spans);
    syncBounds(textarea, mirror);
  }

  /** Tier 1 -- paints `text` immediately from the client-side approximate
   * split + `name_cache.mjs`'s lookup (colored where the cache already
   * recognizes a tag, plain elsewhere). Synchronous, no network -- safe to
   * call on every keystroke and at attach time. Skips the re-render (but
   * still resyncs bounds) when `text` is already on screen in EITHER paint
   * kind, so a same-value `input` event is a no-op AND an optimistic guess
   * never overwrites an already-authoritative render of the same text.
   */
  function paintOptimistic(text) {
    if (detachedMidFlight()) {
      return;
    }
    if (paintedText === text && paintedKind !== null) {
      syncBounds(textarea, mirror);
      return;
    }
    renderMirrorFromSpans(text, buildOptimisticSpans(text));
    paintedText = text;
    paintedKind = "optimistic";
    paintedTokenSig = null;
  }

  /** Tier 2 -- paints `text` colored by the classifier's resolved, offset-
   * exact `tokens` -- the only path that fires `onTokens`, and the only
   * path that teaches `name_cache.mjs` anything new (`rememberTokens()`).
   * See the guard note above for why this is allowed through even when
   * `paintOptimistic()` already rendered the same `text` moments earlier,
   * while a truly repeated (text, tokens) pair is still suppressed.
   */
  function paintColored(tokens, text) {
    if (detachedMidFlight()) {
      return;
    }
    rememberTokens(tokens);
    const sig = tokenSignature(tokens);
    if (paintedText === text && paintedKind === "authoritative" && paintedTokenSig === sig) {
      syncBounds(textarea, mirror);
      return;
    }
    renderMirrorFromSpans(text, buildSpans(text, tokens));
    paintedText = text;
    paintedKind = "authoritative";
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
    // Optimistically paint the CURRENT text synchronously first -- the
    // user must never see invisible/stale/de-colored text while the
    // debounced classify request is still in flight. `requestClassification()`
    // below repaints the same text with the real, offset-exact colors once
    // it resolves.
    paintOptimistic(getText());
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

  // Initial paint -- optimistic immediately, THEN classify. Without that
  // immediate paint, a workflow reload that restores a non-empty saved
  // prompt would show nothing at all in the mirror (transparent real text
  // over an empty/never-painted mirror) until the very first classify
  // response lands -- the same bug, in its worst form. Optimistic (rather
  // than plain) additionally means: if the name cache already knows any of
  // these tags (e.g. this is the SECOND textarea attached this session, or
  // a previous `attachHighlighter` on this same node already classified
  // this text), it comes up colored immediately instead of waiting.
  paintOptimistic(getText());
  requestClassification();

  const handle = {
    textarea,
    mirror,
    /** Forces an immediate metric/bounds resync and reclassification (e.g.
     * after a host-driven font-size or width change the observers above
     * didn't catch, or a caller writing `textarea.value` directly --
     * see `js/anima_prompt/prompt_rules/highlight_wiring.mjs`'s
     * `refreshHighlighters`). Same two-tier behaviour as `onInput()`:
     * paints the current text optimistically first, then reclassifies for
     * the authoritative colors. */
    refresh() {
      resyncMetrics();
      paintOptimistic(getText());
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
