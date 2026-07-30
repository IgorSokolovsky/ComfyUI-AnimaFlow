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
 *   ▾ MODEL DESCRIPTION                     [from Civitai pill]   (§7d-i)
 *   (collapsible; rendered only when there's a model write-up)
 *   ▾ VERSION DESCRIPTION                   [from Civitai pill]   (§7d-i)
 *   (collapsible; rendered only when there's a version note)
 *   (an honest "none"/"not looked up yet" line when NEITHER exists — §7d-i)
 *   ── footer ──
 *   [ Done ]   [ ↻ Civitai ]  (only when civitaiEnabled)
 *
 * Three sections, separated by rules (identity / triggers / descriptions) —
 * see the design doc's own reasoning for why that's real structure, not
 * decoration. **The two descriptions (§7d-i, 2026-07-30) replaced a single
 * merged "AUTHOR'S NOTES" block** that collapsed Civitai's two genuinely
 * different pieces of prose into one heading — a LoRA whose only text was a
 * one-line version changelog then read as "the author wrote nothing useful,"
 * when the real write-up existed one endpoint away. See `descriptionsView`'s
 * own doc comment for the exact per-field rules.
 *
 * ## The Civitai setting is READ BY THE CALLER, not by this file
 *
 * `civitaiEnabled` arrives as a plain boolean parameter (matching
 * `model_picker.mjs`'s own `hideExtension` convention: a track-agnostic file
 * takes settings as data, it doesn't reach into `../shared/settings.mjs`
 * itself).
 *
 * With it `false`, the ⚙/Settings switch hides every network AFFORDANCE
 * (`View on Civitai ↗`, the `↻ Civitai` footer button, and the whole lookup
 * status block) -- `renderStatus`/`renderIdentity`'s own `civitaiEnabled`
 * guards below. Cached sidecar info still displays regardless (§7d) --
 * identity title, author's notes, and Civitai trigger candidates, exactly
 * as if the setting were on.
 *
 * **BUG 13 (2026-07-29 owner report, HIGH PRIORITY) settled where the ACTUAL
 * network boundary is, and it is NOT `civitaiEnabled` any more.** OPENING
 * this panel is ALWAYS a cache-only read now, regardless of the setting --
 * see `runLookup`'s own doc comment for the full "why" and the §9 violation
 * it fixes (merely opening the panel used to hash the whole file and hit
 * Civitai over the network on every open, whenever Civitai was on -- the
 * default). The ONLY thing that ever performs a REAL lookup is an explicit
 * click: the footer's `↻ Civitai` button, or the `unchecked`/`offline`
 * status block's own action. `civitaiEnabled` still governs everything it
 * did before (whether those clickable affordances render at all), it just
 * no longer governs whether OPENING reaches the network -- opening never
 * does, either way.
 *
 * **BUG 20 (2026-07-29 owner report) found the request BUG 13 left behind.**
 * BUG 13 made opening this panel a `cached_only` read of the ComfyUI SERVER's
 * OWN `.civitai.info` sidecar (never Civitai itself) -- correct, but every
 * open still POSTed to that route again, even for a `(kind, name)` this
 * session had already asked. `runLookup(false)` now checks
 * `civitai_api.mjs`'s own client-side `cachedInfo(kind, name)` FIRST: a hit
 * (found OR a remembered "nothing cached" miss -- both are real answers, see
 * `cachedInfo`'s own doc comment) renders straight from it with no request at
 * all; only a genuine miss (nothing asked yet, this session) reaches
 * `lookupInfo` at all. `lookupInfo` already writes every resolved response
 * (a `found`, a `notfound`, or the `cached_only` miss's own `offline`/
 * `civitai_disabled` shape) into that same cache, so there is nothing new to
 * maintain here -- reusing it is the whole fix, not a second, parallel memo.
 *
 * `runLookup(true)` (`↻ Civitai`/`Retry`/`check`, the ONLY path that ever
 * performs a real Civitai lookup) explicitly `invalidateInfo`s first, ahead
 * of the fetch, so a forced re-fetch always REPLACES whatever this session
 * already believed, even on a failure `lookupInfo`'s own catch block would
 * otherwise leave silently in place (belt-and-braces: a successful response
 * already overwrites the cache on its own, this just makes "force always
 * replaces" true regardless of how the fetch resolves).
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

import { lookupInfo, forgetInfo, thumbUrl, cachedInfo, invalidateInfo } from "./civitai_api.mjs";
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
/* each description section's pill states a source, it doesn't switch one --
   static, never interactive, so it must not borrow the source pill's
   hover/pointer. */
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
/* BUG 13: a resting "not looked up yet" state -- deliberately NEUTRAL, not a
   warning or a failure colour (this isn't an error, nothing was even
   attempted). */
.wtn-mi-status-unchecked .wtn-mi-status-icon { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
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

/**
 * The two Civitai description sections (design doc §7d-i, owner report
 * 2026-07-30): `model`/`version` are that section's own trimmed TEXT, or
 * `null` when there is nothing to show — a caller renders NO heading at all
 * for a `null` field ("render each only when it has content... never emit a
 * heading for an empty one"). Never throws on garbage input.
 *
 * `emptyMessage` is set ONLY when BOTH are `null`, and is the one place the
 * two fields are treated asymmetrically, matching the wire contract exactly:
 *
 *   - `version_description` needs no "checked" treatment at all — absent
 *     always just means absent, so an empty `version` alone never produces
 *     any message on its own (see the "only one present" case below).
 *   - `model_description`'s absence is genuinely ambiguous without
 *     `modelDescriptionChecked` (always present on any `found` result,
 *     §7d-i): `true` means "we asked and there truly is none" (an honest
 *     "none" line); anything else (`false`, or no record at all yet — which
 *     is at least as unchecked as an explicit `false`) means a fetch that
 *     COULD answer this hasn't happened, so the honest line is "not looked
 *     up yet," never "no description" — that exact false claim is what
 *     prompted this section's redesign (see this file's top doc comment).
 *
 * The "not looked up yet" wording points at the **existing** `↻ Civitai`
 * footer button rather than inventing a second affordance, and only does so
 * when `civitaiEnabled` — with the setting off that button doesn't render at
 * all (§7b decision 20), so naming it would be a lie (a promised behaviour
 * with nothing behind it).
 *
 * **"Only one present" never produces an empty-side message for the other**
 * — a model with only a version note (or only a model write-up) shows just
 * that one heading; the checked/unchecked distinction only ever surfaces
 * when there is truly nothing else to show.
 */
export function descriptionsView({
  modelDescription,
  versionDescription,
  modelDescriptionChecked,
  civitaiEnabled = true,
} = {}) {
  const model = typeof modelDescription === "string" && modelDescription.trim() ? modelDescription.trim() : null;
  const version = typeof versionDescription === "string" && versionDescription.trim() ? versionDescription.trim() : null;
  if (model || version) {
    return { model, version, emptyMessage: null };
  }
  let emptyMessage;
  if (modelDescriptionChecked === true) {
    emptyMessage = "This LoRA has no author's notes on Civitai.";
  } else if (civitaiEnabled) {
    emptyMessage = "Not looked up yet — use ↻ Civitai below to check.";
  } else {
    emptyMessage = "Author's notes haven't been checked yet — turn the Civitai setting on and re-check to see them.";
  }
  return { model: null, version: null, emptyMessage };
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
  // BUG 13 (2026-07-29 owner report): opening the panel is now ALWAYS a
  // cache-only read (`runLookup`'s own doc comment) -- a miss on THAT read
  // is a resting state, not a failure and not `notfound` (both of those
  // would imply Civitai was actually asked something). This is the ONLY
  // state whose single action performs the first REAL network lookup.
  if (status.phase === "unchecked") {
    return {
      cssState: "unchecked",
      icon: "○",
      headline: "Not checked yet",
      why: "Opening this panel never contacts Civitai on its own — click to check. Your file's own words are still shown.",
      actions: [{ id: "check", label: "↻ Civitai" }],
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
  // BUG 13 (2026-07-29 owner report): OPENING this panel never means
  // "checking is in progress" any more -- it's a fast, LOCAL, cache-only
  // read (see `runLookup`'s own doc comment), so there is nothing to show
  // as "searching" until the user actually clicks `↻ Civitai`. Starts idle
  // (renders nothing); `runLookup(false)`'s own result updates it to
  // `found` or `unchecked` before the panel's first real render, so a user
  // watching the open never sees a "searching…" flash for a call that was
  // never going anywhere near Civitai.
  let status = { phase: "idle" };
  let cancelled = false;
  // Independent collapse state per description section (§7d-i) -- both
  // default open, matching the single AUTHOR'S NOTES section's own default.
  let modelNotesOpen = true;
  let versionNotesOpen = true;

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

  // ---- the two Civitai description sections (§7d-i) -------------------------
  // A single dynamic host, rebuilt by `renderDescriptions()` on every change
  // -- same "dynamic subtree, static shell" convention as `chipsHost`/
  // `statusHost` above (this file's own doc comment).
  const descHost = el(doc, "div");
  panel.appendChild(descHost);

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

  /**
   * Re-places/re-clamps the panel after its OWN content changes post-open --
   * the owner-reported bug (2026-07-30): "fixed on all except lora info as
   * its shown correctly but after info loaded it expand and then
   * overflows". Every OTHER popover in this pack builds its content
   * synchronously before `openOverlay`'s own initial `reposition()` call
   * ever runs, so that first placement already sees the final size. This
   * panel is the one exception (`runLookup`'s own doc comment, above): the
   * Civitai lookup resolves asynchronously, well after the panel is already
   * open and placed against a near-empty box, and nothing ever told the
   * overlay to look again once the real content landed.
   *
   * `mutate` performs whichever render call(s) actually change the
   * content -- every call site that can add/remove a whole SECTION (the
   * status box, the two description sections) after open routes through
   * this, not just the Civitai lookup itself: a state transition between
   * the four lookup states (`onStatusAction("cancel")`, the `searching`
   * phase), a `"↻ Civitai"` re-fetch, `runForget`'s "Clear cache", and the
   * author's-notes collapsible expanding/collapsing all go through it too.
   * (Chip/pill/add-word changes do NOT -- `.wtn-mi-chips`/`.wtn-mi-notes`
   * both scroll internally at a fixed max-height, so those never grow the
   * PANEL's own outer box; only whole sections appearing/disappearing do.)
   *
   * Steps: (1) measure the panel's height BEFORE the mutation, (2) run the
   * mutation, (3) re-measure ONE ANIMATION FRAME later -- measuring
   * synchronously, right after the mutation, would read the pre-paint box
   * (`.claude/skills/comfyui-litegraph-node-sizing`'s own lesson: a
   * same-tick measurement is stale), (4) call `handle.reposition()` -- but
   * ONLY if the height actually changed (never a spurious re-place for a
   * same-size re-render) AND ONLY if the panel is still open
   * (`handle.overlay.parentNode` -- `null` once `close()`'s own
   * `removeChild` has run, the same attached-check `close()` itself uses).
   * A detached/closed panel is a silent no-op here, never a throw -- the
   * lookup this exists for is asynchronous, so it can resolve well after
   * the user already dismissed the popover.
   *
   * `"right"` placement (the only one this panel ever opens with) needs no
   * extra treatment beyond re-running the EXISTING `reposition()`: unlike
   * `"below"`, `"right"` has no side-flip/height-cap decision of its own to
   * redo for a purely vertical content change -- it only recomputes the
   * horizontal flip (unaffected here) and then re-runs
   * `clampOverlayToViewport`, which already measures the CURRENT (grown)
   * box on every call. Re-running that same clamp against the real, grown
   * box is the whole fix; there is nothing for `overlay.mjs` itself to
   * learn or change.
   */
  function repositionAfterChange(mutate) {
    const beforeBox = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null;
    const beforeH = beforeBox ? beforeBox.height : null;
    mutate();
    const win = (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
    const run = () => {
      if (!handle.overlay || !handle.overlay.parentNode) {
        return; // closed/detached while this was pending -- silent no-op, never a throw
      }
      const afterBox = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null;
      const afterH = afterBox ? afterBox.height : null;
      if (beforeH != null && afterH != null && Math.abs(afterH - beforeH) < 0.5) {
        return; // unchanged size -- don't fight the user with a spurious re-place
      }
      handle.reposition();
    };
    if (win && typeof win.requestAnimationFrame === "function") {
      win.requestAnimationFrame(run);
    } else {
      run();
    }
  }

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
      repositionAfterChange(() => renderStatus());
      return;
    }
    if (id === "refetch" || id === "retry" || id === "check") {
      // "check" is the `unchecked` resting state's own action (BUG 13) --
      // same real, forced lookup as `retry`/the footer's `↻ Civitai`.
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
   * §7d-i (owner report, 2026-07-30): replaces the old single `renderNotes`
   * -- which collapsed BOTH of Civitai's descriptions into one `description`
   * key (a field the backend no longer even sends, `src/model_browser/
   * civitai_parse.py`'s own doc comment) -- with two independent sections,
   * each built via `buildDescSection` below and driven by the pure
   * `descriptionsView` helper (its own doc comment has the full state
   * table). A `found` result (live OR cached-only, `applyFoundRecord`) is
   * what populates `civitaiRecord.model_description`/`version_description`/
   * `model_description_checked` in the first place; with no `civitaiRecord`
   * at all yet, `descriptionsView` treats that exactly like `checked:
   * false` -- "not looked up yet" is at least as true when nothing has been
   * found as when a found record explicitly says so.
   */
  function renderDescriptions() {
    descHost.innerHTML = ""; // clear -- rebuild is the whole subtree, never a diff
    const view = descriptionsView({
      modelDescription: civitaiRecord ? civitaiRecord.model_description : undefined,
      versionDescription: civitaiRecord ? civitaiRecord.version_description : undefined,
      modelDescriptionChecked: civitaiRecord ? civitaiRecord.model_description_checked : undefined,
      civitaiEnabled,
    });
    if (!view.model && !view.version) {
      const empty = el(doc, "div", "wtn-mi-empty wtn-mi-desc-empty");
      empty.textContent = view.emptyMessage; // honest "none"/"not looked up yet" -- see descriptionsView's own doc comment
      descHost.appendChild(empty);
      return;
    }
    if (view.model) {
      const [head, body] = buildDescSection({
        label: "MODEL DESCRIPTION",
        text: view.model,
        open: modelNotesOpen,
        headClass: "wtn-mi-desc-model-head",
        bodyClass: "wtn-mi-desc-model-body",
        toggle: () => {
          modelNotesOpen = !modelNotesOpen;
          repositionAfterChange(() => renderDescriptions());
        },
      });
      descHost.appendChild(head);
      descHost.appendChild(body);
    }
    if (view.version) {
      const [head, body] = buildDescSection({
        label: "VERSION DESCRIPTION",
        text: view.version,
        open: versionNotesOpen,
        headClass: "wtn-mi-desc-version-head",
        bodyClass: "wtn-mi-desc-version-body",
        toggle: () => {
          versionNotesOpen = !versionNotesOpen;
          repositionAfterChange(() => renderDescriptions());
        },
      });
      descHost.appendChild(head);
      descHost.appendChild(body);
    }
  }

  /** One collapsible description section's head+body pair -- same DOM shape
   * (and same `from Civitai` static pill, §1a-i item 3) the old single
   * AUTHOR'S NOTES section used, just parameterised so `renderDescriptions`
   * above can build either (or both) without duplicating the DOM wiring.
   * `headClass`/`bodyClass` are extra, field-specific classes ADDED to the
   * shared `wtn-mi-notes-head`/`wtn-mi-notes` ones -- so existing CSS still
   * applies, and a test (or future caller) can still select one specific
   * section without relying on DOM order. */
  function buildDescSection({ label, text, open, toggle, headClass, bodyClass }) {
    const head = el(doc, "div", `wtn-mi-notes-head wtn-mi-desc-head ${headClass}`);
    const caret = el(doc, "span", "wtn-mi-notes-caret");
    caret.textContent = open ? "▾" : "▸";
    const lbl = el(doc, "span", "wtn-mi-seclabel");
    lbl.textContent = label;
    const pillEl = el(doc, "span", "wtn-mi-pill wtn-mi-pill-static");
    pillEl.textContent = "from Civitai";
    head.appendChild(caret);
    head.appendChild(lbl);
    head.appendChild(pillEl);
    head.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });
    const body = el(doc, "div", `wtn-mi-notes wtn-mi-desc-body ${bodyClass}`);
    body.style.display = open ? "" : "none";
    body.textContent = text; // Civitai-supplied text -- textContent only, never innerHTML (this file's top doc comment)
    return [head, body];
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
   * BUG 13 (2026-07-29 owner report, HIGH PRIORITY): "each time i open the
   * lora info there is a lookup request to Civitai, it should happen only
   * if we click on the Civitai button" -- correct, and the previous shape
   * (Slice 4) was a real §9 violation: it called `cachedOnly: !civitaiEnabled`,
   * so with Civitai on (the default) merely OPENING this panel hashed the
   * whole file and hit Civitai over the network, every single time.
   *
   * `cachedOnly` is now `!force`, full stop -- `civitaiEnabled` never enters
   * this decision at all. Opening the panel (`force` unset/false) is ALWAYS
   * a cache-only read: `src/model_browser/lookup.py`'s `lookup_model_info(
   * cached_only=True)` makes `hashing.sha256_file`/`civitai_client.
   * lookup_by_hash` UNREACHABLE from its own control flow (see that
   * function's own doc comment) -- a server-side guarantee, not a frontend
   * promise, so this is airtight even if a caller ever passed the wrong
   * `civitaiEnabled`. The ONLY way to reach a real network call from this
   * panel is `force: true`, which only ever comes from an explicit click:
   * the footer's `↻ Civitai` button, or the `unchecked`/`offline` status
   * actions below (`retry`/`check`) -- never from opening the panel itself.
   * BUG 11's model-id description fallback is gated the SAME way
   * server-side (`_augment_with_model_description` bails on `cached_only`),
   * so it inherits this fix for free: it cannot fire on open either.
   *
   * A cache MISS on a cache-only read is NOT `notfound` -- `notfound` means
   * "we asked Civitai and this hash isn't there", and asserting that when
   * we never asked would be a lie (and would show §7e's hash-changed
   * explanation for a question that was never posed). It resolves to the
   * `unchecked` phase instead -- "not looked up yet", whose one action is
   * `↻ Civitai` -- mirroring the same "not checked yet" vs "confirmed
   * absent" distinction `descriptionsView` (§7d-i) already draws for the
   * MODEL DESCRIPTION section's own wording.
   *
   * The `searching` phase is ONLY ever shown for a real, forced lookup now
   * -- there is nothing to "search" during a local cache read, so showing
   * it there would itself be a small version of the same lie.
   *
   * BUG 20 (2026-07-29 owner report): `!force` no longer means "always ask
   * the cached_only route" -- it means "ask it AT MOST ONCE per `(kind,
   * name)` per session." `civitai_api.mjs`'s `cachedInfo` is checked FIRST
   * (see this file's top doc comment); only a genuine miss reaches
   * `lookupInfo` at all.
   */
  function applyLookupResponse(response) {
    if (response.reason === "found" && response.data) {
      applyFoundRecord(response.data);
    }
    if (response.reason === "offline" && response.offline_reason === "civitai_disabled") {
      // A cache-only read that found nothing -- never actually asked
      // Civitai anything, so this is the resting "not looked up yet" state,
      // not a failure and not `notfound`. This shape ONLY ever comes from a
      // `cached_only` request (`src/model_browser/lookup.py`'s own doc
      // comment), whether that request happened just now or in an earlier
      // open this session (a replayed `cachedInfo` hit) -- so checking the
      // response's OWN shape here, rather than threading a separate
      // "was this call cache-only" flag through, is enough either way.
      status = { phase: "unchecked" };
    } else {
      status = { phase: "result", response };
    }
  }

  async function runLookup(force) {
    cancelled = false;
    if (!force) {
      // BUG 20: a hit here -- found OR a remembered miss -- answers this
      // open with NO request at all (see this file's top doc comment).
      const cached = cachedInfo(kind, name);
      if (cached) {
        applyLookupResponse(cached);
        repositionAfterChange(() => {
          renderStatus();
          renderIdentity();
          renderTriggers();
          renderDescriptions();
        });
        return;
      }
    } else {
      // An explicit refetch/retry/check MUST replace whatever this session
      // already believed, even across a fetch that then fails -- see this
      // file's top doc comment for why this is belt-and-braces rather than
      // load-bearing on the success path (which already overwrites the
      // cache on its own via `lookupInfo`).
      invalidateInfo(kind, name);
      status = { phase: "searching" };
      repositionAfterChange(() => renderStatus());
    }
    const response = await lookupInfo(kind, name, { force: !!force, cachedOnly: !force });
    if (cancelled) {
      return;
    }
    applyLookupResponse(response);
    repositionAfterChange(() => {
      renderStatus();
      renderIdentity();
      renderTriggers();
      renderDescriptions();
    });
  }

  async function runForget() {
    if (!civitaiEnabled) {
      return;
    }
    await forgetInfo(kind, name);
    civitaiRecord = null;
    civitaiTriggers = [];
    status = { phase: "idle" };
    repositionAfterChange(() => {
      renderStatus();
      renderIdentity();
      renderTriggers();
      renderDescriptions();
    });
  }

  // Initial paint.
  renderIdentity();
  renderStatus();
  renderTriggers();
  renderDescriptions();

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

  // BUG 13: this is a CACHE-ONLY read (`force` unset -> `cachedOnly: true`
  // inside `runLookup`), never a real Civitai lookup -- opening the panel is
  // an explicit user action (the ⓘ button/"More info"), but per §9 that
  // only licenses a REAL network call on an explicit click of `↻ Civitai`
  // itself, not on opening the panel that contains it. Always called
  // (`civitaiEnabled` on or off) -- `runLookup`'s own doc comment covers why
  // that's always safe: `cached_only` makes the network path unreachable in
  // `lookup.py`'s own control flow, not merely unused here.
  runLookup(false);

  return handle;
}
