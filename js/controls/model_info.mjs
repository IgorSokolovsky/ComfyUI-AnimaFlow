/**
 * model_info.mjs — the ⓘ info panel (`docs/lora-loader-design.md` §1a-i /
 * §7e), the third and last file in the track-agnostic reuse boundary
 * `civitai_api.mjs`'s own top doc comment names (`AnimaLoaderPanel` imports
 * all three, unchanged, at M3 — see that file's doc comment for the full
 * layering contract, and `test_model_picker.mjs`'s guard, which now scans
 * THIS file too the moment it exists).
 *
 * **Track-agnostic, no LoRA-row assumptions.** This module has never heard
 * of `lora_state.mjs`'s row shape (`{id, name, on, sm, sc, triggers,
 * customTriggers}`) — `openModelInfo` below takes plain `kind`/`name` plus
 * whatever candidate/selected/custom word arrays the CALLER already has, and
 * calls back with the new selected/custom lists on every change. Bridging
 * those callbacks to an actual row (`ensureState`/`persistState`) is
 * `lora_interaction.mjs`'s job, not this file's — exactly the same split
 * `model_picker.mjs` already keeps for `onPick`.
 *
 * ## Layout, top to bottom (§1a-i, corrected from a live reference shot)
 *
 *   thumbnail(58px) + title + base-model + filename         identity
 *   View on Civitai ↗                                       §7d (governed by `civitaiEnabled`)
 *   ── <hr> ──
 *   TRIGGER WORDS   [all|none]              [from file/Civitai pill]
 *   "Tap the ones you want. Only these ..."                 the provenance rule, stated
 *   (the four lookup states, §7e — only when civitaiEnabled)
 *   chips (candidates for the active source, ∪ custom words)
 *   [ add your own… ] [Add]
 *   ── <hr> ──
 *   ▾ AUTHOR'S NOTES                        [from Civitai pill]
 *   (collapsible)
 *   ── footer ──
 *   [ Done ]   [ ↻ Civitai ]  (only when civitaiEnabled)
 *
 * Three sections, separated by rules (identity / triggers / notes) — see the
 * design doc's own reasoning for why that's real structure, not decoration.
 *
 * ## The Civitai setting is READ BY THE CALLER, not by this file
 *
 * `civitaiEnabled` arrives as a plain boolean parameter (matching
 * `model_picker.mjs`'s own `hideExtension` convention: a track-agnostic file
 * takes settings as data, it doesn't reach into `../shared/settings.mjs`
 * itself).
 *
 * With it `false`, this panel still calls `lookupInfo`, but with
 * `{ cachedOnly: true }` -- never a bare skip. `civitai_api.mjs`'s
 * `lookupInfo`/`src/model_browser/lookup.py`'s `lookup_model_info` make that
 * flag's cache-miss path return `offline`/`civitai_disabled` from server-side
 * control flow that NEVER reaches `hashing.sha256_file`/
 * `civitai_client.lookup_by_hash` at all (see either function's own doc
 * comment) -- so calling this at all with the setting off does not violate
 * §7b decision 20's "no path left from which a request could originate": the
 * network-reaching code is unreachable for this call, not merely unused.
 * That is what makes §7d's "cached sidecar info still displays" true
 * simultaneously with decision 20 rather than in tension with it (the design
 * doc states both as its final word on the subject, not as a contradiction
 * to pick one side of) -- a cache HIT still populates the identity title,
 * the author's notes, and the Civitai trigger candidates exactly as if the
 * setting were on. What genuinely disappears with the setting off is only
 * "the way out" (§7d's own words): the lookup STATUS block (searching/found/
 * notfound/offline messaging, which would misrepresent a cached-only read as
 * a live one), the `View on Civitai ↗` link, and the `↻ Civitai` footer
 * button (which would force a real, live lookup) -- `renderStatus`/
 * `renderIdentity`'s own `civitaiEnabled` guards below render none of those
 * regardless of what the cached-only call found.
 *
 * ## ⚠ Untrusted text — textContent, never innerHTML
 *
 * A custom trigger word is arbitrary user text, and a Civitai description
 * can legitimately contain `<lora:name:0.8>`-shaped substrings. EVERY piece
 * of user/Civitai-supplied text in this file (chip labels, the author's
 * notes body, the identity title/filename) is written with `textContent` —
 * never string-concatenated into `innerHTML`. This file's only `innerHTML`
 * writes are `= ""` clears (rebuilding a dynamic subtree from scratch before
 * repainting it); every piece of actual content, ours or theirs, goes
 * through `el`/`textContent` instead, so there is no templated-HTML seam
 * where the two could ever be confused.
 */

import { lookupInfo, forgetInfo, thumbUrl } from "./civitai_api.mjs";
import {
  openOverlayWithZoom,
  closeOverlayIfOwnedBy,
  closeOverlaysNotAncestorOf,
  activeOverlayRef,
} from "../shared/overlay.mjs";

const STYLE_ID = "wtn-mi-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly -- same "every render module
// keeps its own hardcoded fallback copy" convention as lora_render.mjs's own
// top doc comment states.
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
  onAccent: "#062420",
  ok: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  info: "#7dd3fc",
};

// Neutral "no preview" glyph -- same pictogram as model_picker.mjs's own
// IMAGE_PLACEHOLDER_SVG (duplicated rather than imported, per this pack's
// "every render module keeps its own copy" convention -- see that module's
// top doc comment on why icons aren't shared across these three files).
const IMAGE_PLACEHOLDER_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2H4zm0 2h16v9.59l-3.79-3.8a1 1 0 00-1.42 0L11 15.59l-2.29-2.3a1 1 0 00-1.42 0L4 16.59V6zm4 2a2 2 0 100 4 2 2 0 000-4z'/%3E%3C/svg%3E";

const CSS = `
.wtn-mi-panel {
  width: 336px; max-height: 78vh; overflow-y: auto; box-sizing: border-box;
  padding: 11px 12px 12px; border-radius: 10px; display: flex; flex-direction: column;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  box-shadow: var(--wtn-shadow, 0 20px 46px rgba(0,0,0,.66));
  font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink});
}

/* ── identity header ── */
.wtn-mi-head { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px; }
.wtn-mi-thumb {
  width: 58px; height: 58px; flex: none; border-radius: 7px; overflow: hidden;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  display: flex; align-items: center; justify-content: center;
}
.wtn-mi-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.wtn-mi-thumb-ph {
  width: 22px; height: 22px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-image: url("${IMAGE_PLACEHOLDER_SVG}"); -webkit-mask-image: url("${IMAGE_PLACEHOLDER_SVG}");
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
}
.wtn-mi-identity { flex: 1 1 auto; min-width: 0; }
.wtn-mi-title {
  font-size: 14px; font-weight: 600; line-height: 1.25;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wtn-mi-base { font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); margin-top: 2px; }
.wtn-mi-file {
  font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  word-break: break-all; margin-top: 1px;
}
.wtn-mi-close {
  flex: none; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 13px; line-height: 1;
}
.wtn-mi-close:hover { color: var(--wtn-ink, ${TOKENS.ink}); }

.wtn-mi-civlink {
  display: inline-block; margin: 2px 0 0; color: var(--wtn-info, ${TOKENS.info}); font-size: 12px; text-decoration: none;
}
.wtn-mi-civlink:hover { text-decoration: underline; }

.wtn-mi-sep { border: 0; border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); margin: 11px 0; flex: none; }

/* ── section headers ── */
.wtn-mi-sechead { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.wtn-mi-seclabel {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--wtn-accent, ${TOKENS.accent});
}
.wtn-mi-hint { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 11px; margin: -1px 0 7px; line-height: 1.35; }

/* ── all/none: an ACTION segment, never a mode -- momentary, accent on
   :active only (design doc §1a-i item 2). ── */
.wtn-mi-seg-act { display: flex; }
.wtn-mi-seg-act button {
  font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; padding: 2px 7px;
  background: var(--wtn-console, ${TOKENS.console}); color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); border-right: 0; cursor: pointer;
}
.wtn-mi-seg-act button:first-child { border-radius: 5px 0 0 5px; }
.wtn-mi-seg-act button:last-child { border-radius: 0 5px 5px 0; border-right: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-mi-seg-act button:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-mi-seg-act button:active {
  background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent});
  border-color: var(--wtn-accent, ${TOKENS.accent});
}

/* ── source pill: states where the candidates came from, switches the view;
   selections survive the switch (design doc §1a-i item 3). ── */
.wtn-mi-pill {
  margin-left: auto; flex: none; font-size: 10.5px; padding: 2px 8px; border-radius: 9px;
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  cursor: pointer; white-space: nowrap; background: transparent;
}
.wtn-mi-pill:hover { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); color: var(--wtn-ink, ${TOKENS.ink}); }
/* the AUTHOR'S NOTES pill states a source, it doesn't switch one -- static,
   never interactive, so it must not borrow the source pill's hover/pointer. */
.wtn-mi-pill.wtn-mi-pill-static { cursor: default; }
.wtn-mi-pill.wtn-mi-pill-static:hover { border-color: var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }

/* ── the four lookup states (§7e) -- icon + headline, one line, one action row ── */
.wtn-mi-status {
  display: flex; flex-direction: column; gap: 5px; font-size: 11px; padding: 7px 8px; border-radius: 6px;
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); background: var(--wtn-console, ${TOKENS.console});
  margin-bottom: 8px;
}
.wtn-mi-status-head { display: flex; align-items: center; gap: 6px; font-family: var(--wtn-font-mono, monospace); }
.wtn-mi-status-icon { font-size: 13px; line-height: 1; }
.wtn-mi-status-searching .wtn-mi-status-icon { color: var(--wtn-info, ${TOKENS.info}); }
.wtn-mi-status-found .wtn-mi-status-icon { color: var(--wtn-ok, ${TOKENS.ok}); }
.wtn-mi-status-notfound .wtn-mi-status-icon { color: var(--wtn-warn, ${TOKENS.warn}); }
.wtn-mi-status-offline .wtn-mi-status-icon { color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-mi-status-why { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); line-height: 1.4; }
.wtn-mi-status-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.wtn-mi-status-actions button {
  font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; padding: 3px 8px; border-radius: 5px;
  cursor: pointer; background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  border: 1px dashed var(--wtn-line, ${TOKENS.line});
}
.wtn-mi-status-actions button:hover:not(:disabled) { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-mi-status-actions button:disabled { opacity: .5; cursor: default; }

/* ── trigger-word chips ── */
.wtn-mi-chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 120px; overflow-y: auto; padding: 2px 0 6px; }
.wtn-mi-chip {
  font-family: var(--wtn-font-mono, monospace); font-size: 11px; padding: 3px 8px; border-radius: 11px;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
}
.wtn-mi-chip.wtn-mi-chip-on {
  background: rgba(45, 212, 191, .16); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep});
  color: var(--wtn-accent-strong, ${TOKENS.accentStrong});
}
/* the ✓ exists ONLY on a selected chip, so selectedness never rests on colour alone */
.wtn-mi-chip-tick { display: none; font-size: 9px; }
.wtn-mi-chip.wtn-mi-chip-on .wtn-mi-chip-tick { display: inline; }
/* ✕ exists ONLY on a user-authored chip -- candidates from the file/Civitai
   are never deletable, only selectable (design doc §1a-i item 1). */
.wtn-mi-chip-del { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 10px; padding: 0 1px; border-radius: 3px; }
.wtn-mi-chip-del:hover { color: var(--wtn-bad, ${TOKENS.bad}); background: rgba(248, 113, 113, .12); }

.wtn-mi-empty { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 11.5px; font-style: italic; padding: 4px 2px 8px; }

.wtn-mi-addrow { display: flex; align-items: center; gap: 8px; margin: 2px 0 2px; }
.wtn-mi-add-input {
  flex: 1 1 auto; width: auto; box-sizing: border-box; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink, ${TOKENS.ink});
  font-size: 12px; padding: 5px 7px; border-radius: 6px;
}
.wtn-mi-add-btn {
  flex: none; height: 26px; padding: 0 10px; border-radius: 6px; cursor: pointer;
  background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); border: 1px dashed var(--wtn-line, ${TOKENS.line});
  font-size: 11.5px;
}
.wtn-mi-add-btn:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

/* ── author's notes (collapsible) ── */
.wtn-mi-notes-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; cursor: pointer; }
.wtn-mi-notes-caret { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 9px; flex: none; }
.wtn-mi-notes {
  font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); border-radius: 6px; padding: 7px 8px;
  max-height: 128px; overflow-y: auto; white-space: pre-wrap;
}

/* ── the compact "found" row (BUG 8, 2026-07-29 owner report) -- sits
   directly ABOVE the footer's ↻ Civitai, replacing the full status box for
   the ONE state that's a success rather than a degradation (§7e's other
   three states keep the full box -- see 'renderStatus''s own comment). ── */
.wtn-mi-status-compact {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 11px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); margin-top: 8px;
}
.wtn-mi-status-compact-label { display: flex; align-items: center; gap: 5px; }
.wtn-mi-status-compact-label b { color: var(--wtn-ok, ${TOKENS.ok}); font-weight: 600; }
.wtn-mi-status-compact-btn {
  flex: none; font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; padding: 3px 8px;
  border-radius: 5px; cursor: pointer; background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  border: 1px dashed var(--wtn-line, ${TOKENS.line});
}
.wtn-mi-status-compact-btn:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

/* ── footer ── */
.wtn-mi-footer { display: flex; gap: 8px; margin-top: 11px; flex: none; }
.wtn-mi-done {
  flex: 1 1 auto; height: 30px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px;
  background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent});
  border: 1px solid var(--wtn-accent, ${TOKENS.accent});
}
.wtn-mi-done:hover { background: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-mi-refetch {
  flex: none; height: 30px; padding: 0 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); border: 1px dashed var(--wtn-line, ${TOKENS.line});
}
.wtn-mi-refetch:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
`;

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  if (typeof document !== "undefined") {
    // Guarded dynamic import -- same reasoning as every other render module
    // in this pack (`model_picker.mjs`'s own top doc comment): no live
    // ComfyUI server to serve this route under test, and this file's own CSS
    // already falls back to hardcoded hex values.
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
// Pure helpers -- no DOM, no `doc`/`window` reference anywhere below, so
// these are importable and directly testable under plain `node`
// (test_model_info.mjs).
// ---------------------------------------------------------------------------

/** The Civitai URL for a specific model VERSION (§7d: "must link to the
 * specific version, not the model landing page"), or `null` if `modelId`
 * isn't a usable id at all (nothing to link to). A `versionId` that isn't
 * usable degrades to the model's own landing page rather than refusing to
 * link at all -- still strictly more useful than nothing. Accepts either a
 * real number or a digit-only string (Civitai's own ids, and a hand-edited
 * sidecar, are both plausible sources). */
export function civitaiModelUrl(modelId, versionId) {
  const mid = _cleanId(modelId);
  if (mid == null) {
    return null;
  }
  const vid = _cleanId(versionId);
  return vid != null ? `https://civitai.com/models/${mid}?modelVersionId=${vid}` : `https://civitai.com/models/${mid}`;
}

function _cleanId(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

/** The chips to render for the CURRENTLY active `source` ("file" |
 * "civitai"): that source's candidates first (never deletable — no `✕`),
 * then every custom word not ALREADY equal (case-insensitively) to one of
 * them (deletable — `✕`), each carrying whether `selected` (from the
 * caller's own selection Set, checked by exact string) already has it. Never
 * throws on garbage input; every list defaults to `[]`. */
export function visibleChips({ source, fileTriggers, civitaiTriggers, customTriggers, selected } = {}) {
  const candidates = source === "civitai" ? civitaiTriggers : fileTriggers;
  const sel = selected instanceof Set ? selected : new Set(Array.isArray(selected) ? selected : []);
  const seen = new Set();
  const out = [];
  for (const w of Array.isArray(candidates) ? candidates : []) {
    if (typeof w !== "string" || !w || seen.has(w.toLowerCase())) {
      continue;
    }
    seen.add(w.toLowerCase());
    out.push({ word: w, custom: false, selected: sel.has(w) });
  }
  for (const w of Array.isArray(customTriggers) ? customTriggers : []) {
    if (typeof w !== "string" || !w || seen.has(w.toLowerCase())) {
      continue;
    }
    seen.add(w.toLowerCase());
    out.push({ word: w, custom: true, selected: sel.has(w) });
  }
  return out;
}

/** The honest empty-state line for the active `source` -- names both
 * remedies rather than just reporting nothing (design doc §1a-i, exact
 * wording for the file case). */
export function emptyStateMessage(source) {
  return source === "civitai"
    ? "No trigger words from Civitai for this version — add your own below."
    : "No trigger words in this file — add your own below, or try Civitai";
}

const OFFLINE_HEADLINES = {
  timeout: "Civitai timed out",
  dns_tls: "Couldn't reach Civitai (DNS)",
  unreadable: "Civitai sent an unreadable reply (a login or block page?)",
  rate_limited: "Civitai returned 429",
};

/**
 * The four Civitai lookup states (§7e), each reduced to `icon + headline ·
 * one line of cause-and-consequence · the one action that could change it`.
 * `status` is `null`/`{phase:"idle"}` (nothing attempted -- renders nothing:
 * the CALLER decides whether that's reachable at all), `{phase:"searching"}`,
 * or `{phase:"result", response}` where `response` is `lookupInfo`'s own
 * `{reason, offline_reason, message, data}` shape. Returns `null` for the
 * idle phase (nothing to render); otherwise `{cssState, icon, headline, why,
 * actions: [{id, label, disabled?, title?}]}`.
 *
 * Every non-idle state's `why` explicitly says the file's own words are
 * still shown (design doc: "every state also says what still works") --
 * that's what turns a failure into a degradation instead of a dead end.
 */
export function lookupStateView(status) {
  if (!status || status.phase === "idle") {
    return null;
  }
  if (status.phase === "searching") {
    return {
      cssState: "searching",
      icon: "◌",
      headline: "Checking Civitai…",
      why: "Hashing the file, then one request to Civitai.",
      actions: [{ id: "cancel", label: "Cancel" }],
    };
  }

  const r = (status.response && typeof status.response === "object") ? status.response : {};

  if (r.reason === "found") {
    // BUG 8 (2026-07-29 owner report): `Re-fetch` used to sit here too, but
    // it does exactly what the footer's `↻ Civitai` already does -- dropped,
    // not merely relabeled. `Forget cached` -> `Clear cache` (owner: "more
    // like clear cache" -- reads as an action on stored data, not a
    // preference). This is also the ONE state `renderStatus` renders as a
    // compact single line rather than the full box -- see that function's
    // own comment for why only `found` gets that treatment.
    return {
      cssState: "found",
      icon: "✓",
      headline: "Matched on Civitai",
      why: "Cached next to the file — instant and offline from now on.",
      actions: [{ id: "forget", label: "Clear cache" }],
    };
  }

  if (r.reason === "notfound") {
    return {
      cssState: "notfound",
      icon: "⌀",
      headline: "This exact file isn't on Civitai",
      why: "Re-saving, merging or quantising a LoRA changes its hash, so a published LoRA won't "
        + "match once the file has been altered. Your file's own trigger words are still shown.",
      actions: [{
        id: "search-by-name",
        label: "Search Civitai by name →",
        disabled: true,
        title: "Search-by-name lands with the Civitai browser (a later milestone) — not built yet.",
      }],
    };
  }

  // "offline" (including a defensive fallback for any other/garbage reason).
  const reason = r.offline_reason;
  if (reason === "missing_file") {
    return {
      cssState: "offline",
      icon: "⚠",
      headline: "Can't check Civitai",
      why: "This file isn't on disk locally, so there's nothing to hash.",
      actions: [],
    };
  }
  const headline = OFFLINE_HEADLINES[reason] || "Could not reach Civitai";
  let why = "Nothing was lost — the file's own words are still shown.";
  if (reason === "rate_limited") {
    why = "An API key relieves rate limits (Settings → AnimaFlow, once key support lands). " + why;
  }
  return { cssState: "offline", icon: "⚠", headline, why, actions: [{ id: "retry", label: "Retry" }] };
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

function prettyTitle(name) {
  if (typeof name !== "string" || !name) {
    return "(no LoRA picked)";
  }
  const base = name.split("/").pop().replace(/\.[^./]+$/, "");
  return base.replace(/[_-]+/g, " ").trim() || name;
}

/**
 * Opens the ⓘ info panel, anchored to `anchorEl`. Track-agnostic (this
 * module's top doc comment) -- every piece of LoRA-row-specific bookkeeping
 * is the CALLER's job via `onChange`.
 *
 * @param {object} opts
 * @param {{doc, getCanvasEl}} opts.ctx
 * @param {Element} opts.anchorEl
 * @param {string} opts.kind
 * @param {string} opts.name - the model's file name (identity + thumbnail + lookup key).
 * @param {string} [opts.ownerKey] - defaults to `model-info:<kind>:<name>`.
 * @param {string} [opts.baseModel] - file-derived base-model family (identity line).
 * @param {string[]} [opts.fileTriggers] - candidate words read from the file's own metadata.
 * @param {string[]} [opts.customTriggers] - every word the user has ever typed in "add your own" for this row.
 * @param {string[]} [opts.selectedTriggers] - the currently-selected subset (from ANY source) that reaches the output.
 * @param {boolean} [opts.civitaiEnabled] - the "Civitai" ⚙/Settings switch's CURRENT value (§7b decision 20).
 * @param {boolean} [opts.showThumbnails] - the "Show preview thumbnails" ⚙/Settings switch's CURRENT value (§7b, Slice 5) -- `false` renders NO thumbnail element at all; defaults to `true`, same convention as `civitaiEnabled`.
 * @param {(nextSelected: string[], nextCustom: string[]) => void} [opts.onChange]
 * @param {() => void} [opts.onClose]
 * @returns {object|null} the overlay handle, or `null` if this call just toggled an already-open panel closed.
 */
export function openModelInfo({
  ctx,
  anchorEl,
  kind,
  name,
  ownerKey,
  baseModel = "",
  fileTriggers = [],
  customTriggers = [],
  selectedTriggers = [],
  civitaiEnabled = true,
  showThumbnails = true,
  onChange,
  onClose,
} = {}) {
  const key = ownerKey || `model-info:${kind}:${name}`;
  if (closeOverlayIfOwnedBy(key)) {
    return null; // toggle: this SAME panel was already open -- just close it
  }
  closeOverlaysNotAncestorOf(anchorEl);

  const doc = ctx.doc;
  injectStyles(doc);

  // ---- mutable panel state -------------------------------------------------
  let selected = new Set(Array.isArray(selectedTriggers) ? selectedTriggers.filter((t) => typeof t === "string") : []);
  let custom = Array.isArray(customTriggers) ? customTriggers.filter((t) => typeof t === "string") : [];
  // A previously-selected word that isn't among the file's own candidates
  // (or already in `custom`) has no OTHER home to render a chip in yet --
  // Civitai's own candidates aren't known until the lookup below resolves.
  // Fold it into `custom` so it's never silently lost from view (still
  // fully deletable, since its provenance genuinely isn't the file); once a
  // Civitai lookup DOES confirm it as a real candidate, `visibleChips`'s own
  // candidate-wins dedupe (see its doc comment) renders it non-deletable
  // again whenever that source is the one being viewed.
  const fileSet = new Set((Array.isArray(fileTriggers) ? fileTriggers : []).map((w) => (typeof w === "string" ? w.toLowerCase() : "")));
  for (const w of selected) {
    const already = fileSet.has(w.toLowerCase()) || custom.some((c) => c.toLowerCase() === w.toLowerCase());
    if (!already) {
      custom.push(w);
    }
  }
  let source = "file";
  let sourceTouched = false; // did the USER click the pill? gates the one-time auto-switch below.
  let civitaiTriggers = [];
  let civitaiRecord = null; // last "found" response's `data`
  // Always "searching" at construction -- `runLookup` is always called
  // (below), cached-only or not; `renderStatus`'s own `civitaiEnabled` guard
  // is what actually keeps this invisible while the setting is off.
  let status = { phase: "searching" };
  let cancelled = false;
  let notesOpen = true;

  function notify() {
    if (typeof onChange === "function") {
      onChange(Array.from(selected), custom.slice());
    }
  }

  // ---- static shell ---------------------------------------------------------
  const panel = el(doc, "div", "wtn-mi-panel wtn");

  const head = el(doc, "div", "wtn-mi-head");
  // `showThumbnails === false` (§7b "Show preview thumbnails", Slice 5) skips
  // building the thumbnail element ENTIRELY -- not merely hiding it -- same
  // "no element at all" contract `model_picker.mjs`'s own `buildRow` follows
  // for the identical setting.
  if (showThumbnails !== false) {
    const thumb = el(doc, "div", "wtn-mi-thumb");
    const url = thumbUrl(kind, name);
    if (url) {
      const img = el(doc, "img");
      img.src = url;
      img.alt = "";
      img.addEventListener("error", () => {
        thumb.innerHTML = "";
        thumb.appendChild(el(doc, "span", "wtn-mi-thumb-ph"));
      });
      thumb.appendChild(img);
    } else {
      thumb.appendChild(el(doc, "span", "wtn-mi-thumb-ph"));
    }
    head.appendChild(thumb);
  }

  const identity = el(doc, "div", "wtn-mi-identity");
  const title = el(doc, "div", "wtn-mi-title");
  title.textContent = prettyTitle(name); // file-derived, but still via textContent -- never innerHTML
  title.title = name || "";
  identity.appendChild(title);
  const baseLine = el(doc, "div", "wtn-mi-base");
  baseLine.textContent = baseModel || "unknown";
  identity.appendChild(baseLine);
  const fileLine = el(doc, "div", "wtn-mi-file");
  fileLine.textContent = name || "";
  identity.appendChild(fileLine);
  head.appendChild(identity);

  const closeBtn = el(doc, "span", "wtn-mi-close");
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handle.close();
  });
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const civLinkRow = el(doc, "div");
  panel.appendChild(civLinkRow);

  panel.appendChild(el(doc, "hr", "wtn-mi-sep"));

  // ---- trigger words section -------------------------------------------------
  const trigHead = el(doc, "div", "wtn-mi-sechead");
  const trigLabel = el(doc, "span", "wtn-mi-seclabel");
  trigLabel.textContent = "TRIGGER WORDS";
  trigHead.appendChild(trigLabel);

  const segAct = el(doc, "span", "wtn-mi-seg-act");
  const allBtn = el(doc, "button");
  allBtn.type = "button";
  allBtn.textContent = "all";
  allBtn.title = "Select every word currently shown";
  const noneBtn = el(doc, "button");
  noneBtn.type = "button";
  noneBtn.textContent = "none";
  noneBtn.title = "Deselect every word currently shown";
  segAct.appendChild(allBtn);
  segAct.appendChild(noneBtn);
  trigHead.appendChild(segAct);

  const pill = el(doc, "span", "wtn-mi-pill");
  pill.addEventListener("click", (e) => {
    e.stopPropagation();
    sourceTouched = true;
    source = source === "file" ? "civitai" : "file";
    renderTriggers();
  });
  trigHead.appendChild(pill);
  panel.appendChild(trigHead);

  const hint = el(doc, "div", "wtn-mi-hint");
  hint.textContent = "Tap the ones you want. Only these, and only if the LoRA is on, reach the triggers output.";
  panel.appendChild(hint);

  const statusHost = el(doc, "div");
  panel.appendChild(statusHost);

  const chipsHost = el(doc, "div");
  panel.appendChild(chipsHost);

  const addRow = el(doc, "div", "wtn-mi-addrow");
  const addInput = el(doc, "input", "wtn-mi-add-input");
  addInput.type = "text";
  addInput.placeholder = "add your own trigger word…";
  const addBtn = el(doc, "button", "wtn-mi-add-btn");
  addBtn.type = "button";
  addBtn.textContent = "Add";
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  panel.appendChild(addRow);

  function addCustomWord() {
    const w = (addInput.value || "").trim();
    if (!w) {
      return;
    }
    if (!custom.some((c) => c.toLowerCase() === w.toLowerCase())) {
      custom.push(w);
    }
    selected.add(w);
    addInput.value = "";
    notify();
    renderTriggers();
  }
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    addCustomWord();
  });
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addCustomWord();
    }
  });
  addInput.addEventListener("click", (e) => e.stopPropagation());

  panel.appendChild(el(doc, "hr", "wtn-mi-sep"));

  // ---- author's notes (collapsible) ----------------------------------------
  const notesHead = el(doc, "div", "wtn-mi-notes-head");
  const notesCaret = el(doc, "span", "wtn-mi-notes-caret");
  const notesLabel = el(doc, "span", "wtn-mi-seclabel");
  notesLabel.textContent = "AUTHOR'S NOTES";
  const notesPill = el(doc, "span", "wtn-mi-pill wtn-mi-pill-static");
  notesPill.textContent = "from Civitai";
  notesHead.appendChild(notesCaret);
  notesHead.appendChild(notesLabel);
  notesHead.appendChild(notesPill);
  notesHead.addEventListener("click", (e) => {
    e.stopPropagation();
    notesOpen = !notesOpen;
    renderNotes();
  });
  panel.appendChild(notesHead);

  const notesBody = el(doc, "div", "wtn-mi-notes");
  panel.appendChild(notesBody);

  panel.appendChild(el(doc, "hr", "wtn-mi-sep"));

  // BUG 8 (2026-07-29 owner report): the `found` state's compact single-line
  // row lives HERE -- directly above the footer's `↻ Civitai` -- rather than
  // in `statusHost`'s own position near the top; see `renderStatus`'s own
  // comment for the split.
  const foundHost = el(doc, "div");
  panel.appendChild(foundHost);

  // ---- footer ---------------------------------------------------------------
  const footer = el(doc, "div", "wtn-mi-footer");
  const doneBtn = el(doc, "button", "wtn-mi-done");
  doneBtn.type = "button";
  doneBtn.textContent = "Done";
  doneBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handle.close();
  });
  footer.appendChild(doneBtn);
  const refetchBtn = el(doc, "button", "wtn-mi-refetch");
  refetchBtn.type = "button";
  refetchBtn.textContent = "↻ Civitai";
  refetchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    runLookup(true);
  });
  if (civitaiEnabled) {
    footer.appendChild(refetchBtn);
  }
  panel.appendChild(footer);

  // ---------------------------------------------------------------------
  // Rendering -- dynamic subtrees are rebuilt on every call (mirrors
  // model_picker.mjs's own render() convention); static shell above is
  // built once.
  // ---------------------------------------------------------------------

  function renderIdentity() {
    // The header TITLE prefers Civitai's own model name (a real display
    // name, e.g. "Skin Detail XL") over the prettified filename the moment
    // one is known -- a filename transform is a fallback for "we don't know
    // yet / Civitai is off", not the preferred source. Still textContent
    // only (`civitaiRecord.name` is Civitai-supplied text) -- see this
    // file's top doc comment.
    const civitaiName = civitaiRecord && typeof civitaiRecord.name === "string" ? civitaiRecord.name.trim() : "";
    title.textContent = civitaiName || prettyTitle(name);

    civLinkRow.innerHTML = "";
    if (!civitaiEnabled || !civitaiRecord) {
      return; // §7d: the link disappears entirely when Civitai is off, or nothing's been found yet
    }
    const href = civitaiModelUrl(civitaiRecord.model_id, civitaiRecord.version_id);
    if (!href) {
      return;
    }
    const a = el(doc, "a", "wtn-mi-civlink");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "View on Civitai ↗";
    a.addEventListener("click", (e) => e.stopPropagation());
    civLinkRow.appendChild(a);
  }

  /**
   * BUG 8 (2026-07-29 owner report): the `found` state renders as ONE
   * compact line (label + a single small button) sitting directly above the
   * footer's `↻ Civitai`, in `foundHost` -- it's the SUCCESS state, so it
   * needs the least explaining. The other three (`searching`/`notfound`/
   * `offline`) keep the full icon+headline+cause+action box in
   * `statusHost`, near the top -- §7e's whole point is that two of those
   * three are failures and a bare status line is a dead end for them; only
   * `found` earns the lighter treatment. Both hosts are always cleared
   * first, so whichever state is current, exactly one of them ever has
   * content.
   */
  function renderStatus() {
    statusHost.innerHTML = "";
    foundHost.innerHTML = "";
    if (!civitaiEnabled) {
      return; // no network affordance at all when the setting is off (§7b decision 20)
    }
    const view = lookupStateView(status);
    if (!view) {
      return;
    }
    if (view.cssState === "found") {
      const row = el(doc, "div", "wtn-mi-status-compact");
      const label = el(doc, "span", "wtn-mi-status-compact-label");
      const headline = el(doc, "b");
      headline.textContent = view.headline;
      label.appendChild(headline);
      row.appendChild(label);
      for (const action of view.actions) {
        const btn = el(doc, "button", "wtn-mi-status-compact-btn");
        btn.type = "button";
        btn.textContent = action.label;
        if (action.title) {
          btn.title = action.title;
        }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          onStatusAction(action.id);
        });
        row.appendChild(btn);
      }
      foundHost.appendChild(row);
      return;
    }
    const box = el(doc, "div", `wtn-mi-status wtn-mi-status-${view.cssState}`);
    const headRow = el(doc, "div", "wtn-mi-status-head");
    const icon = el(doc, "span", "wtn-mi-status-icon");
    icon.textContent = view.icon;
    const headline = el(doc, "b");
    headline.textContent = view.headline;
    headRow.appendChild(icon);
    headRow.appendChild(headline);
    box.appendChild(headRow);
    const why = el(doc, "div", "wtn-mi-status-why");
    why.textContent = view.why;
    box.appendChild(why);
    if (view.actions.length) {
      const actions = el(doc, "div", "wtn-mi-status-actions");
      for (const action of view.actions) {
        const btn = el(doc, "button");
        btn.type = "button";
        btn.textContent = action.label;
        if (action.disabled) {
          btn.disabled = true;
        }
        if (action.title) {
          btn.title = action.title;
        }
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          onStatusAction(action.id);
        });
        actions.appendChild(btn);
      }
      box.appendChild(actions);
    }
    statusHost.appendChild(box);
  }

  function onStatusAction(id) {
    if (id === "cancel") {
      cancelled = true;
      status = civitaiRecord
        ? { phase: "result", response: { reason: "found", data: civitaiRecord } }
        : { phase: "idle" };
      renderStatus();
      return;
    }
    if (id === "refetch" || id === "retry") {
      runLookup(true);
      return;
    }
    if (id === "forget") {
      runForget();
      return;
    }
    // "search-by-name" is rendered disabled (M2 doesn't exist yet) -- no-op.
  }

  function renderTriggers() {
    pill.textContent = source === "civitai" ? "from Civitai" : "from file";
    pill.title = "Switch which candidate list is shown -- your selections survive the switch.";

    chipsHost.innerHTML = "";
    const chips = visibleChips({ source, fileTriggers, civitaiTriggers, customTriggers: custom, selected });
    if (!chips.length) {
      const empty = el(doc, "div", "wtn-mi-empty");
      empty.textContent = emptyStateMessage(source);
      chipsHost.appendChild(empty);
      return;
    }
    const box = el(doc, "div", "wtn-mi-chips");
    for (const chip of chips) {
      const chipEl = el(doc, "div", `wtn-mi-chip${chip.selected ? " wtn-mi-chip-on" : ""}`);
      const tick = el(doc, "span", "wtn-mi-chip-tick");
      tick.textContent = "✓";
      chipEl.appendChild(tick);
      const label = el(doc, "span");
      label.textContent = chip.word; // candidate OR custom -- always textContent, never innerHTML
      chipEl.appendChild(label);
      if (chip.custom) {
        const del = el(doc, "span", "wtn-mi-chip-del");
        del.textContent = "✕";
        del.title = "Delete this word you added";
        del.addEventListener("click", (e) => {
          e.stopPropagation(); // must not ALSO toggle the chip -- see this file's top doc comment
          custom = custom.filter((w) => w.toLowerCase() !== chip.word.toLowerCase());
          selected.delete(chip.word);
          notify();
          renderTriggers();
        });
        chipEl.appendChild(del);
      }
      chipEl.addEventListener("click", () => {
        if (selected.has(chip.word)) {
          selected.delete(chip.word);
        } else {
          selected.add(chip.word);
        }
        notify();
        renderTriggers();
      });
      box.appendChild(chipEl);
    }
    chipsHost.appendChild(box);
  }

  allBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    for (const chip of visibleChips({ source, fileTriggers, civitaiTriggers, customTriggers: custom, selected })) {
      selected.add(chip.word);
    }
    notify();
    renderTriggers();
  });
  noneBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    for (const chip of visibleChips({ source, fileTriggers, civitaiTriggers, customTriggers: custom, selected })) {
      selected.delete(chip.word);
    }
    notify();
    renderTriggers();
  });

  /**
   * A cached record (found via a normal OR cached-only lookup -- both
   * populate `civitaiRecord` identically, see `applyFoundRecord`) shows its
   * real notes regardless of `civitaiEnabled` (§7d: cached data still
   * displays). The "turn Civitai on" line is shown ONLY when there is
   * genuinely nothing cached yet AND the setting is off -- i.e. we
   * actually don't know, not merely "the switch happens to be off right
   * now".
   *
   * BUG 2 (2026-07-29 owner report): a LoRA that DID match on Civitai and
   * genuinely HAS an author description used to show "No author's notes
   * yet" regardless -- the root cause was Python reading only the per-
   * VERSION `description` (`src/model_browser/civitai_parse.py`), never the
   * MODEL's own write-up. That's fixed server-side now (`parse_model_version`
   * prefers `model.description`, and `lookup.py`'s `_augment_with_model_
   * description` fetches `/api/v1/models/{id}` once when neither is present
   * and caches the result) -- so by the time `civitaiRecord` reflects a
   * `found` result from a live-or-cached lookup that was actually ALLOWED to
   * run the network step, a missing `description` here means "genuinely has
   * none," not "haven't tried yet." The one case that's STILL "haven't tried
   * yet" rather than "confirmed absent" is a cached record read with
   * Civitai OFF (`cached_only`) -- the augmentation fetch is exactly the
   * network step that setting disables, so this function says so instead
   * of implying the LoRA has no notes.
   */
  function renderNotes() {
    notesCaret.textContent = notesOpen ? "▾" : "▸";
    notesBody.style.display = notesOpen ? "" : "none";
    notesBody.textContent = ""; // clear, then set via textContent below -- never innerHTML
    const description = civitaiRecord && typeof civitaiRecord.description === "string" ? civitaiRecord.description.trim() : "";
    if (description) {
      notesBody.textContent = description;
      return;
    }
    if (!civitaiEnabled) {
      notesBody.textContent = civitaiRecord
        ? "Author's notes haven't been checked yet — turn the Civitai setting on and re-check to see them."
        : "Author's notes come from Civitai — turn the Civitai setting on to see them (nothing is cached for this file yet).";
      return;
    }
    notesBody.textContent = "This LoRA has no author's notes on Civitai.";
  }

  function applyFoundRecord(data) {
    civitaiRecord = data && typeof data === "object" ? data : {};
    civitaiTriggers = Array.isArray(civitaiRecord.triggers) ? civitaiRecord.triggers.filter((t) => typeof t === "string") : [];
    // Auto-switch to the Civitai view ONLY if the file has nothing and the
    // user hasn't already touched the pill themselves -- see this file's
    // top doc comment / openModelInfo's own state block.
    if (!sourceTouched && (!Array.isArray(fileTriggers) || fileTriggers.length === 0) && civitaiTriggers.length > 0) {
      source = "civitai";
    }
  }

  /**
   * ALWAYS calls `lookupInfo` -- with `cachedOnly: true` whenever
   * `civitaiEnabled` is `false` (this file's own top doc comment explains why
   * that's safe: the flag makes the network-reaching code unreachable
   * server-side, not merely skipped here). `force` (an explicit "Re-fetch"/
   * "Retry" click) is only ever passed `true` from the status block's own
   * actions, which render only when `civitaiEnabled` -- so `force && !
   * civitaiEnabled` can't actually happen through this panel's own UI, and
   * `cachedOnly` wins over it regardless (matching `lookup.py`'s own
   * `cached_only` docs).
   */
  async function runLookup(force) {
    cancelled = false;
    status = { phase: "searching" };
    renderStatus(); // no-op while !civitaiEnabled -- see that function's own guard
    const response = await lookupInfo(kind, name, { force: !!force, cachedOnly: !civitaiEnabled });
    if (cancelled) {
      return;
    }
    if (response.reason === "found" && response.data) {
      applyFoundRecord(response.data);
    }
    status = { phase: "result", response };
    renderStatus();
    renderIdentity();
    renderTriggers();
    renderNotes();
  }

  async function runForget() {
    if (!civitaiEnabled) {
      return;
    }
    await forgetInfo(kind, name);
    civitaiRecord = null;
    civitaiTriggers = [];
    status = { phase: "idle" };
    renderStatus();
    renderIdentity();
    renderTriggers();
    renderNotes();
  }

  // Initial paint.
  renderIdentity();
  renderStatus();
  renderTriggers();
  renderNotes();

  const handle = openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, panel, "right", () => {
    cancelled = true;
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }, "wtn-mi-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;

  // The lookup itself is triggered by OPENING this panel -- an explicit user
  // click (the ⓘ button/"More info"), matching §9's "only on an explicit
  // click" rule; never called from anywhere that isn't a direct response to
  // that click. ALWAYS called, even with Civitai off -- `runLookup`'s own
  // doc comment explains why that's still §7b decision 20-safe (`cachedOnly`
  // makes the network path unreachable, not merely unused).
  runLookup(false);

  return handle;
}
