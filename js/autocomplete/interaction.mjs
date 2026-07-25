/**
 * interaction.mjs — event wiring for one attached text control. Debounced
 * fetch from the `/wtn/autocomplete` API route (see `autocomplete/api.py`),
 * ArrowUp/Down navigation, Enter/Tab to commit, Escape/blur/outside-click
 * to hide. No element creation lives here — that's `render.mjs`'s job.
 */

import { commitToken, currentToken, debounce, tagToPromptText } from "./core.mjs";
import { caretCoords, ensurePopup, hidePopup, renderItems, showPopup } from "./render.mjs";

const DEBOUNCE_MS = 180;
const MIN_QUERY_LENGTH = 1;
const RESULT_LIMIT = 20;

async function fetchSuggestions(query) {
  const url = `/wtn/autocomplete?q=${encodeURIComponent(query)}&limit=${RESULT_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Attach the shared autocomplete popup to one text control (`<textarea>`
 * or `<input type=text>`). Callers (`index.js`) are responsible for
 * de-duplicating attach calls per element — this function always wires
 * fresh listeners, so it must only ever run once per element.
 */
export function attachAutocomplete(el) {
  const popup = ensurePopup();
  const state = { items: [], activeIndex: -1, tokenStart: 0, tokenEnd: 0, open: false };

  function position() {
    const rect = el.getBoundingClientRect();
    const caret = caretCoords(el, el.selectionStart || 0);
    showPopup(popup, rect.left + caret.x, rect.top + caret.y + (caret.lineHeight || 16));
  }

  function open() {
    state.open = true;
    renderItems(popup, state.items, state.activeIndex);
    position();
    document.addEventListener("mousedown", onDocMousedown, true);
    popup.addEventListener("mousedown", onPopupMousedown);
  }

  function close() {
    if (!state.open) {
      return;
    }
    state.open = false;
    hidePopup(popup);
    document.removeEventListener("mousedown", onDocMousedown, true);
    popup.removeEventListener("mousedown", onPopupMousedown);
  }

  const runSearch = debounce(async (query) => {
    if (!query || query.length < MIN_QUERY_LENGTH) {
      close();
      return;
    }
    let payload;
    try {
      payload = await fetchSuggestions(query);
    } catch {
      // Route unreachable (dev preview outside a live ComfyUI process, or a
      // transient network hiccup) -- fail silent, no popup rather than an
      // error toast for what's meant to be a lightweight QoL feature.
      close();
      return;
    }
    if (document.activeElement !== el) {
      return; // user moved on while the request was in flight
    }
    state.items = (payload && payload.results) || [];
    state.activeIndex = state.items.length ? 0 : -1;
    if (!state.items.length) {
      close();
      return;
    }
    open();
  }, DEBOUNCE_MS);

  function commitSelected(index) {
    const item = state.items[index];
    if (!item) {
      return;
    }
    // `item.tag` is the CANONICAL booru tag name (underscores, unescaped
    // parens) -- fine for display (render.mjs) and for the search API, but
    // not safe to insert verbatim into the prompt: `tagToPromptText` turns
    // it into insertable text (spaces, escaped parens) without touching
    // `commitToken`'s own separator/trailing-comma behavior.
    const replacement = tagToPromptText(item.tag);
    const { text, caretPos } = commitToken(el.value, state.tokenStart, state.tokenEnd, replacement);
    el.value = text;
    if (typeof el.setSelectionRange === "function") {
      el.setSelectionRange(caretPos, caretPos);
    }
    // Let whatever mirrors this control's value into a hidden serialized
    // widget (e.g. PromptBuilder's `input` listener) see the change too.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    el.focus();
  }

  function onInput() {
    const { query, start, end } = currentToken(el.value, el.selectionStart || 0);
    state.tokenStart = start;
    state.tokenEnd = end;
    runSearch(query);
  }

  function onKeydown(event) {
    if (!state.open) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.activeIndex = (state.activeIndex + 1) % state.items.length;
      renderItems(popup, state.items, state.activeIndex);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      state.activeIndex = (state.activeIndex - 1 + state.items.length) % state.items.length;
      renderItems(popup, state.items, state.activeIndex);
    } else if (event.key === "Enter" || event.key === "Tab") {
      if (state.activeIndex >= 0) {
        event.preventDefault();
        commitSelected(state.activeIndex);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      runSearch.cancel();
      close();
    }
  }

  function onBlur() {
    // Defer so a mousedown on the popup (which blurs `el` first) still
    // registers as a commit before we tear the popup down.
    setTimeout(() => {
      if (!popup.contains(document.activeElement)) {
        close();
      }
    }, 120);
  }

  function onDocMousedown(event) {
    if (popup.contains(event.target) || event.target === el) {
      return;
    }
    close();
  }

  function onPopupMousedown(event) {
    const item = event.target.closest(".wtn-ac-item");
    if (!item) {
      return;
    }
    event.preventDefault(); // keep focus on `el` instead of the popup
    commitSelected(Number(item.dataset.index));
  }

  el.addEventListener("input", onInput);
  el.addEventListener("keydown", onKeydown);
  el.addEventListener("blur", onBlur);
}
