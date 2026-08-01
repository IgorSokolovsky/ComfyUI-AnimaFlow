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
 *   [ Delete|Download ]   [ Done ]   [ ↻ Civitai ]  (only when civitaiEnabled)
 *
 *   The leftmost footer action reflects whether the file is still ON DISK
 *   (`hasFile(kind, name)`, the SAME missing-file check a LoRA row itself
 *   uses -- `lora_render.mjs`'s own `missing` -- so this panel never
 *   disagrees with the row it was opened from): present (or unknown, before
 *   this session's model list has ever loaded) shows `Delete`, unchanged;
 *   gone shows `Download` -- opening this model's own Civitai VERSION page
 *   (`civitaiModelUrl`, the same URL "View on Civitai ↗" above already
 *   computes) in a new tab, but ONLY when a `civitaiRecord` is actually known
 *   (this session's cache, or a fresh lookup) -- a missing file with no
 *   known Civitai record renders NEITHER (owner, "a dead button is worse
 *   than none"). Never both at once.
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

import {
  lookupInfo, forgetInfo, thumbUrl, cachedInfo, invalidateInfo, invalidateList, deleteModel, savePreview, hasFile,
  fetchModelDetail, cachedModelDetail,
} from "./civitai_api.mjs";
// "Remove an installed model" (`docs/TODO.md`) -- the type-to-confirm
// dialog is shared with `civitai_search.mjs`'s own "installed" card rather
// than grown twice; see that module's own top doc comment for the full
// contract.
import { openDeleteConfirm, removedSummary } from "../shared/delete_confirm.mjs";
// The DOWNLOAD JOB itself (task: "the Download button should actually
// download, not just link to Civitai") -- reused, not reimplemented: this
// module-level singleton (`civitai_search.mjs`'s own top doc comment, "The
// download job is a MODULE-LEVEL singleton") already serialises every
// download in this pack to one-at-a-time, server-side, polled, never
// blocking a run (§9) -- the exact contract this button must also honour.
// Importing FROM `civitai_search.mjs` here is the allowed direction (this
// file's own top doc comment on why it stays track-agnostic is about
// `lora_*` imports specifically; `civitai_search.mjs` is itself one of the
// SAME reuse-boundary files this file already belongs to, and
// `civitai_modal.mjs` already imports this exact set from it -- see that
// file's own top doc comment). `resultKey` is reused so a download started
// from THIS panel and one started from the search card for the SAME
// (model_id, version_id) are recognised as the SAME job everywhere, not two
// independently-tracked ones.
import {
  startDownloadJob, subscribeDownloadState, getActiveDownloadState, cancelActiveDownloadJob, downloadPercent, resultKey,
} from "./civitai_search.mjs";
import {
  openOverlayWithZoom,
  closeOverlayIfOwnedBy,
  closeOverlaysNotAncestorOf,
  activeOverlayRef,
} from "../shared/overlay.mjs";
// The level-aware thumbnail-candidate mechanism (`docs/lora-loader-design.md`
// §7c-iv, "the level governs the ⓘ panel too") -- moved out of
// `civitai_search.mjs` into a shared module precisely so this file could
// import the SAME retry-then-advance/locked-state machinery the search card
// uses, rather than a second copy (see that module's own top doc comment).
import {
  levelLabelToInt,
  pickThumbCandidates,
  attachThumbCandidate,
  THUMB_RETRY_BACKOFF_MS,
  THUMB_SKELETON_CLASS,
  THUMB_SKELETON_CSS,
} from "../shared/civitai_thumb.mjs";
// C/E (task brief, 2026-07-31): route this surface's own diagnostic output
// (lookup outcome, cache hit vs fetch, forget) through the pack-wide
// "Console logging" level -- see that module's own top doc comment. "LoRA
// info" is this surface's own tag (task brief: "make each line identify
// which surface it came from").
import { logSummary, logDebug } from "../shared/console_log.mjs";

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
/* Owner, 2026-08-01: widened alongside \`civitai_search.mjs\`'s own
   \`.wtn-cs-panel\` ("also the lora info panel width too") -- SAME shared
   delta, \`--wtn-panel-width-boost\` (\`js/shared/theme.css\`), so the two
   panels move by the identical amount rather than two independently-tuned
   numbers. This panel's own pre-existing 336px base (already 10px narrower
   than \`.wtn-cs-panel\`'s 346px, predating this change) is unchanged --
   only the boost is added, preserving that gap rather than forcing the two
   to a common width they were never given for the same reason. */
.wtn-mi-panel {
  width: calc(336px + var(--wtn-panel-width-boost, 50px)); max-height: 78vh; overflow-y: auto; box-sizing: border-box;
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
  /* \`position: relative\` is what lets the shared "loading" skeleton
     (\`../shared/civitai_thumb.mjs\`'s \`THUMB_SKELETON_CSS\`, spliced in
     below) overlay this box via \`position: absolute; inset: 0\` without
     taking a flex slot of its own -- see that constant's own doc comment. */
  position: relative;
}
.wtn-mi-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
${THUMB_SKELETON_CSS}
.wtn-mi-thumb-ph {
  width: 22px; height: 22px; background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-image: url("${IMAGE_PLACEHOLDER_SVG}"); -webkit-mask-image: url("${IMAGE_PLACEHOLDER_SVG}");
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
}
/* §7c-iv's "locked" state, ported here from the search card
   (\`civitai_search.mjs\`'s own \`.wtn-cs-thumb-locked\`) -- the SAME 🙈 glyph,
   so the two surfaces agree on what "hidden by your browsing level" looks
   like (task brief: "do not introduce a third glyph"). This panel has no
   \`gated\` concept of its own (no download button here), so there is only
   ever one lock glyph in this file. */
.wtn-mi-thumb-locked { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 20px; }
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
/* "Remove an installed model" (docs/TODO.md) -- the ⓘ panel's own delete
   affordance, always offered (a local disk operation, unrelated to the
   Civitai setting) -- styled like \`.wtn-mi-refetch\` but in the bad/red hue
   so it reads as destructive without shouting, matching the search card's
   own \`.wtn-cs-action-delete\` (\`civitai_search.mjs\`). */
.wtn-mi-delete {
  flex: none; height: 30px; padding: 0 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  background: transparent; color: var(--wtn-bad, ${TOKENS.bad}); border: 1px dashed rgba(248,113,113,.4);
}
.wtn-mi-delete:hover { border-color: var(--wtn-bad, ${TOKENS.bad}); }
/* The missing-file footer's own action (task: "show download instead of
   delete"). 2026-08-01: a \`<button>\`, no longer an \`<a>\` -- it now starts
   a real server-side download job (this file's own \`renderFooterAction\`
   doc comment) rather than navigating to Civitai, so it needs a click
   handler, not an \`href\`. \`font-family: inherit\` is the one thing a
   \`<button>\` needs that an \`<a>\` never did (browsers don't inherit font
   onto native form controls by default) -- everything else matches
   \`.wtn-mi-delete\`'s box (height/padding/radius) exactly so the swap never
   shifts the footer's layout, but in the info hue (never the bad/red one --
   this is not a destructive action). */
.wtn-mi-download {
  flex: none; box-sizing: border-box; height: 30px; padding: 0 12px; border-radius: 6px; cursor: pointer;
  font-size: 12px; font-family: inherit; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--wtn-info, ${TOKENS.info}); border: 1px dashed rgba(125,211,252,.4);
}
.wtn-mi-download:hover { border-color: var(--wtn-info, ${TOKENS.info}); }
.wtn-mi-download:disabled { opacity: .6; cursor: default; }
/* The in-progress state of that SAME download (task: "the same download job
   the search cards use ... progress reported") -- a compact readout, not
   the search card's own full progress bar, since this footer is a single
   30px-tall row shared with Done/↻ Civitai, not a whole card. */
.wtn-mi-dl-progress {
  flex: none; display: flex; align-items: center; gap: 8px; height: 30px;
  font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-mi-dl-cancel {
  flex: none; height: 24px; padding: 0 10px; border-radius: 6px; cursor: pointer; font-size: 11.5px; font-family: inherit;
  background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); border: 1px dashed var(--wtn-line, ${TOKENS.line});
}
.wtn-mi-dl-cancel:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
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

/**
 * The single BEST file to actually download for a deleted model's own
 * re-download (task: "the Download button should actually download"), from
 * a `fetchModelDetail`/`GET /wtn/model_browser/model_detail` response's own
 * `files` list -- `[{name, download_url, size_kb, primary, gated, sha256}]`,
 * the SAME per-file shape `src/model_browser/civitai_search.py`'s own
 * `_parse_files` already produces for a search result's own versions. Mirrors
 * that module's own `pick_primary_file` byte for byte (a file flagged
 * `primary: true`, else the first file in the list), so a deleted model's
 * own re-download picks the exact same file the ORIGINAL install would have.
 *
 * `null` for a garbage/empty `files` list, or when the chosen entry carries
 * no usable `name`/`download_url` -- never throws. The caller renders NO
 * Download button at all in that case (owner: "a dead button is worse than
 * none"), matching every other missing-record fallback in this panel.
 */
export function pickPrimaryDownloadFile(files) {
  const usable = Array.isArray(files) ? files.filter((f) => f && typeof f === "object") : [];
  if (!usable.length) {
    return null;
  }
  const primary = usable.find((f) => f.primary === true) || usable[0];
  const filename = typeof primary.name === "string" && primary.name ? primary.name : null;
  const downloadUrl = typeof primary.download_url === "string" && primary.download_url ? primary.download_url : null;
  if (!filename || !downloadUrl) {
    return null;
  }
  const sizeKb = Number.isFinite(primary.size_kb) ? primary.size_kb : null;
  return { filename, downloadUrl, sizeKb };
}

/** The folder a re-download should land in -- everything before the last
 * `/` in `name` (the on-disk name this model USED to have, sidecar/list-
 * derived), or `""` for a rootless/garbage name -- so a re-download after
 * delete lands back in the same subfolder it came from rather than the
 * kind's bare root. Mirrors `delete_confirm.mjs`'s own `folderLabelFor`
 * path-splitting (a duplicated copy, per this pack's "every module keeps
 * its own" convention). Never throws. */
export function subfolderFromName(name) {
  if (typeof name !== "string" || !name) {
    return "";
  }
  const clean = name.replace(/\\/g, "/");
  const idx = clean.lastIndexOf("/");
  return idx > 0 ? clean.slice(0, idx) : "";
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
      // M2 shipped search, so this is no longer the disabled stub M1 left
      // (`docs/TODO.md`) -- by-hash failing is the COMMON case, so this
      // turns the most frequent dead end into the feature already built.
      actions: [{
        id: "search-by-name",
        label: "Search Civitai by name →",
        title: "Search Civitai using this model's name instead of its hash.",
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
 * @param {string} [opts.browsingLevel] - the "Maximum browsing level" ⚙/Settings switch's CURRENT value (§7c-iv, one of `CIVITAI_SEARCH_LEVEL_OPTIONS` -- `"PG".."XXX"`), read by the CALLER the same way `civitaiEnabled`/`showThumbnails` already are -- this file never reaches into `../shared/settings.mjs` itself. Governs ONLY the Civitai-sourced fallback thumbnail (below) -- the local on-disk preview (`thumbUrl`) is never level-filtered (§7c-iv: "never what the user already has locally -- a file on disk was an explicit act"). Defaults to `"PG"`, the setting's own default.
 * @param {boolean} [opts.showCivitaiName] - the "Show Civitai name instead of filename" ⚙/Settings switch's CURRENT value (§1a-vii), read by the CALLER the same way as every other setting above -- this file never reaches into `../shared/settings.mjs` itself. Governs ONLY whether `renderIdentity`'s title prefers a known Civitai name over the file-derived `prettyTitle(name)`; defaults to `false` (filenames), matching that setting's own default.
 * @param {number} [opts.thumbRetryBackoffMs] - test-only override for the identity thumb's retry backoff (default `THUMB_RETRY_BACKOFF_MS`, ~400ms in real use), matching `civitai_search.mjs`'s own `openCivitaiSearch` convention so a test can drive the retry chain deterministically instead of waiting on a real timer.
 * @param {number} [opts.downloadPollIntervalMs] - test-only override for the missing-file "↓ Download" button's own job-progress poll interval (default 800ms in real use, `civitai_search.mjs`'s own `startDownloadJob` default) -- same test-only-override convention as `thumbRetryBackoffMs`, forwarded to `startDownloadJob` unchanged.
 * @param {number} [opts.sizeBytes] - the file's size on disk, for the "Remove an installed model" confirm dialog only.
 * @param {(nextSelected: string[], nextCustom: string[]) => void} [opts.onChange]
 * @param {() => void} [opts.onClose]
 * @param {(kind: string, name: string) => void} [opts.onDeleted] - called after a successful delete, BEFORE this panel closes -- the caller's own re-check/re-render hook (`docs/TODO.md`: "the row still pointing at that file must fall into the existing red missing-file state").
 * @param {(name: string) => void} [opts.onSearchByName] - `notfound`'s "Search Civitai by name →" action (§7e) -- called with this model's own file name; the CALLER opens the actual search surface (this file never imports `civitai_search.mjs`, staying track-agnostic).
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
  browsingLevel = "PG",
  showCivitaiName = false,
  thumbRetryBackoffMs = THUMB_RETRY_BACKOFF_MS,
  downloadPollIntervalMs,
  sizeBytes,
  onChange,
  onClose,
  onDeleted,
  onSearchByName,
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
  // §7c-iv's own "make sure a card that re-renders mid-retry doesn't leave a
  // stale timer writing to a detached element" -- the SAME `renderGeneration`
  // convention `civitai_search.mjs` uses, ported here because this panel ALSO
  // re-renders (`renderThumb`, from `renderIdentity`) while a thumbnail retry
  // is still pending -- e.g. clicking `↻ Civitai` while the local preview's
  // own onerror/retry chain hasn't settled yet.
  let thumbGeneration = 0;
  // Owner, 2026-07-31, measured live: "/wtn/model_browser/thumb?... is
  // called each 1-2 sec." A signature of exactly the inputs `renderThumb`'s
  // own decision reads (the full candidate URL list, in order, plus the
  // locked flag) as of the LAST render that actually proceeded past its own
  // idempotency guard (never touched by a render the guard skipped) -- see
  // that guard's own doc comment, at `renderThumb`'s call site, for why an
  // unchanged signature ALONE is not enough on its own (a stale closure
  // silently dropping a newly-available fallback candidate) and must be
  // paired with "the box is currently showing a REAL `<img>`, not mid-retry
  // or a terminal glyph." `null` until the first real render.
  let lastThumbSignature = null;
  // The resolved download target for a MISSING file's own "↓ Download"
  // (task: "the Download button should actually download"). Keyed by
  // `"<model_id>:<version_id>"` so a later real lookup that changes
  // `civitaiRecord` (e.g. `unchecked` -> `found` while this panel is
  // already open) is recognised as a NEW target to resolve, not the stale
  // one. `undefined` = never resolved for the CURRENT key yet (still
  // fetching, or nothing to resolve from); `null` = resolved, but no usable
  // file (`pickPrimaryDownloadFile` came back empty) -- render no button
  // either way, same "no dead button" rule as everywhere else in this file.
  let downloadTarget;
  let downloadTargetKey = null;
  // Unsubscribes this panel from the shared download-job singleton
  // (`civitai_search.mjs`) -- set once, right after `handle` exists, and
  // called from `handle`'s own `onClose` below so a closed panel never
  // leaves a dangling listener on a job it can no longer render progress
  // for (the exact leak `overlay.mjs`'s own resize-observer teardown
  // guards against, same principle, different mechanism).
  let unsubscribeDownload = null;

  /**
   * Resolves (and caches, per the `(model_id, version_id)` key above) the
   * ONE file a missing model's own "↓ Download" would fetch -- a synchronous
   * `cachedModelDetail` hit if this session already asked Civitai's detail
   * route for this exact version (no network), else kicks off `fetchModelDetail`
   * (already de-duped/cached client-side, `civitai_api.mjs`'s own doc
   * comment) and re-renders the footer once it resolves. Returns the
   * CURRENTLY known answer immediately (`undefined` while a fetch is still
   * in flight) rather than a Promise -- `renderFooterAction` is synchronous,
   * matching every other dynamic subtree in this file.
   */
  function ensureDownloadTarget() {
    if (!civitaiRecord) {
      return null;
    }
    const recordKey = `${civitaiRecord.model_id}:${civitaiRecord.version_id}`;
    if (recordKey === downloadTargetKey) {
      return downloadTarget === undefined ? null : downloadTarget;
    }
    downloadTargetKey = recordKey;
    downloadTarget = undefined;
    const cached = cachedModelDetail(civitaiRecord.model_id, civitaiRecord.version_id);
    if (cached) {
      downloadTarget = pickPrimaryDownloadFile(cached.files);
      return downloadTarget;
    }
    fetchModelDetail(civitaiRecord.model_id, civitaiRecord.version_id).then((detail) => {
      if (recordKey !== downloadTargetKey || !handle.overlay || !handle.overlay.parentNode) {
        return; // superseded by a later record, or the panel closed while this was in flight
      }
      downloadTarget = pickPrimaryDownloadFile(detail && detail.files);
      renderFooterAction();
    });
    return null; // not resolved yet this render -- footer renders no button until the fetch above lands
  }

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
  // for the identical setting. This is ORTHOGONAL to §7c-iv's browsing level
  // (task brief): this switch decides whether a thumbnail element is built
  // at all; the level decides which image goes in one, below.
  //
  // `thumbHost`'s CONTENTS are rebuilt by `renderThumb()` (a dynamic subtree,
  // same "static shell + dynamic host" convention as `chipsHost`/`statusHost`/
  // `descHost`) rather than built once here -- unlike Slice 4, the Civitai
  // fallback candidates below aren't known until `civitaiRecord` resolves,
  // which happens AFTER this static shell is built.
  const thumbHost = showThumbnails !== false ? el(doc, "div", "wtn-mi-thumb") : null;
  if (thumbHost) {
    head.appendChild(thumbHost);
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
  // The leftmost footer action -- `renderFooterAction`, below -- is a
  // DYNAMIC subtree (same "dynamic subtree, static shell" convention as
  // `chipsHost`/`statusHost`/`descHost` above), not built once here, because
  // it depends on `civitaiRecord`, which isn't known until a lookup resolves
  // (well after this static shell is built). Leftmost so `Done` (flex: 1 1
  // auto) still fills the row, exactly as the single static `Delete` button
  // it replaces already did.
  const footerActionHost = el(doc, "div");
  footer.appendChild(footerActionHost);
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

  // Re-placing the overlay after this panel's own content changes post-open
  // (the async Civitai lookup replacing a near-empty box, a collapsible
  // description toggling, ...) used to be this file's OWN job
  // (`repositionAfterChange`, since deleted) -- `../shared/overlay.mjs`'s
  // `openOverlay` now does this for every caller via a `ResizeObserver` on
  // `contentEl` (this panel's own `panel` element, this file's top doc
  // comment / that module's "A THIRD layer, 2026-07-31"), so every mutation
  // below that used to be wrapped just runs directly -- the shared mechanism
  // re-places on its own the moment `panel`'s observed height actually
  // changes, with the same "no spurious re-place for an unchanged size"
  // guard `repositionAfterChange` used to provide locally.

  function buildPlaceholderGlyph() {
    return el(doc, "span", "wtn-mi-thumb-ph");
  }

  function buildLockedGlyph() {
    // Same 🙈 glyph + wording as the search card's own "locked" state
    // (`civitai_search.mjs`'s `buildThumb`) -- task brief: "do not introduce
    // a third glyph."
    const lock = el(doc, "span", "wtn-mi-thumb-locked");
    lock.textContent = "\u{1F648}"; // 🙈
    lock.title = "Preview hidden — above your browsing level";
    return lock;
  }

  /**
   * Rebuilds the identity thumbnail (§7c-iv, "the level governs the ⓘ panel
   * too"). Precedence, per the design doc's own four-source table and the
   * owner's 2026-07-31 correction to this task's brief:
   *
   *   1. the LOCAL on-disk preview (`thumbUrl`) -- always tried first,
   *      NEVER level-filtered ("never what the user already has locally --
   *      a file on disk was an explicit act");
   *   2. once that fails to load (or there's no `name`/`kind` to resolve one
   *      at all), the Civitai lookup's own `images` candidates, filtered to
   *      the caller's `browsingLevel` and walked with the SAME
   *      retry-then-advance chain the search card uses
   *      (`attachThumbCandidate`, shared);
   *   3. `"locked"` (a DIFFERENT glyph than a plain "no image") when Civitai
   *      has images for this model but every one is above the chosen level;
   *   4. the plain placeholder otherwise -- no local file, no Civitai record
   *      (yet), or Civitai genuinely has no gallery at all.
   *
   * While ANY candidate in that chain is in flight (owner request,
   * 2026-07-31), the box shows the shared `THUMB_SKELETON_CLASS` shimmer
   * instead of sitting blank -- built once, before candidate 0 is even
   * tried, and cleared only on the chain's own terminal outcome (a genuine
   * load, or every candidate including its own retry exhausted), so it
   * survives the local preview failing AND the fall-through into the
   * Civitai candidates without flashing on and off in between.
   *
   * Rebuilt (not built once) because `civitaiRecord` isn't known until the
   * lookup resolves, which happens AFTER this panel's static shell -- called
   * from `renderIdentity`, which already re-runs on every lookup/forget
   * outcome. `thumbGeneration` is this function's own render-generation guard
   * (this file's top-of-closure doc comment) so a retry/advance timer queued
   * under an EARLIER call never writes into a thumb box a LATER call has
   * already cleared.
   */
  function renderThumb() {
    if (!thumbHost) {
      return; // showThumbnails === false (§7b) -- no element exists to fill
    }

    const localUrl = thumbUrl(kind, name);
    const civitaiImages = civitaiRecord && Array.isArray(civitaiRecord.images) ? civitaiRecord.images : [];
    const levelInt = levelLabelToInt(browsingLevel);
    const civitaiCandidates = pickThumbCandidates(civitaiImages, levelInt);
    const candidates = localUrl ? [localUrl, ...civitaiCandidates] : civitaiCandidates;
    // A PRE-CHECK decision (`civitai_thumb.mjs`'s own doc comment on this
    // exact split), computed once up front -- independent of whether the
    // local file (or a level-passing Civitai candidate) subsequently fails
    // to LOAD.
    const locked = civitaiImages.length > 0 && civitaiCandidates.length === 0;

    // Idempotency guard (owner-reported, 2026-07-31, measured live:
    // "/wtn/model_browser/thumb?... is called each 1-2 sec"). A full
    // `thumbHost.innerHTML = ""` teardown always builds a BRAND NEW `<img>`,
    // which re-requests its `src` even when the URL string is byte-identical
    // to the one already showing -- nothing about the ELEMENT itself is
    // reused across a rebuild. Skip the rebuild when BOTH:
    //
    //   1. this render's OWN signature (the full candidate list + locked
    //      flag -- `lastThumbSignature`'s own doc comment) is unchanged from
    //      the last render that actually proceeded, AND
    //   2. `thumbHost`'s LAST child is a genuine `<img>` (never a `<span>`
    //      skeleton/placeholder/locked glyph) whose `src` already matches
    //      `candidates[0]` -- the box is showing (loaded, or already
    //      in-flight) exactly what a fresh render would hand
    //      `attachThumbCandidate` as its very first attempt anyway.
    //
    // BOTH conditions matter, not just one: (1) alone would wrongly skip a
    // render whose CANDIDATE LIST changed but whose first entry happens to
    // be unchanged (the local file failed, a NEW Civitai fallback just
    // became available, but `candidates[0]` -- the local url -- is still
    // the same one already showing; skipping would leave the OLD, shorter
    // candidate list live in the existing retry chain's own closure,
    // silently dropping that fallback the next time it fails -- confirmed
    // against this file's own "falls through to Civitai" regression test).
    // (2) alone would wrongly skip a render caught mid-retry, where the
    // in-flight attempt just failed and `attachThumbCandidate`'s own
    // `onerror` already REMOVED the `<img>` (only the skeleton remains) --
    // that is exactly the case an EXPLICIT "↻ Civitai" refetch must still be
    // free to restart from scratch, confirmed against this file's own
    // "leaves no stale timer" regression test.
    const signature = `${locked ? "L" : ""}|${candidates.join(" ")}`;
    const kids = thumbHost.children || [];
    const currentImg = kids[kids.length - 1];
    if (signature === lastThumbSignature && candidates[0] && currentImg && currentImg.tagName === "img" && currentImg.src === candidates[0]) {
      return;
    }
    lastThumbSignature = signature;

    thumbHost.innerHTML = "";
    thumbGeneration += 1;
    const gen = thumbGeneration;
    const isStale = () => gen !== thumbGeneration;

    if (candidates.length === 0) {
      thumbHost.appendChild(locked ? buildLockedGlyph() : buildPlaceholderGlyph());
      return;
    }
    // The shared "loading" skeleton (owner request, 2026-07-31) -- built
    // ONCE, before the local preview (candidate 0) is even tried, and
    // removed only on the chain's own terminal outcome (`onLoaded`/
    // `onExhausted` below), so it survives the local file failing AND the
    // fall-through into the level-aware Civitai candidates, exactly as it
    // does on the search card (`civitai_search.mjs`'s own `buildThumb`).
    const skeleton = el(doc, "span", THUMB_SKELETON_CLASS);
    thumbHost.appendChild(skeleton);
    const clearSkeleton = (t) => {
      if (skeleton.parentNode === t && typeof t.removeChild === "function") {
        t.removeChild(skeleton);
      }
    };
    attachThumbCandidate(doc, thumbHost, candidates, { index: 0, retried: false }, isStale, thumbRetryBackoffMs, (d, t) => {
      clearSkeleton(t);
      t.appendChild(locked ? buildLockedGlyph() : buildPlaceholderGlyph());
    }, (d, t) => {
      clearSkeleton(t);
    });
  }

  /**
   * The footer's leftmost action (task: "in case we deleted and opened the
   * lora info we should show download instead of delete now"). `missing`
   * mirrors `lora_render.mjs`'s own row-level check byte for byte
   * (`hasFile(kind, name) === false`) -- the SAME missing-file check the row
   * itself uses, so this panel can never disagree with the row it was
   * opened from. `null`/`true` (unknown -- this kind's list hasn't resolved
   * yet this session -- or genuinely present) both keep the existing
   * `Delete` behaviour unchanged; only a confirmed `false` swaps it.
   *
   * ## Download ACTUALLY downloads now (2026-08-01 spec correction)
   *
   * A missing file used to swap to a `Download` that just opened this
   * model's own Civitai VERSION page in a new tab -- a second control doing
   * exactly what the ⓘ panel's own `View on Civitai ↗` already does, a few
   * rows above, labelled differently. That was a spec error (the brief
   * said "link to it"), not a build error: this button now goes through the
   * SAME server-side download job every other surface in this pack uses
   * (`civitai_search.mjs`'s module-level singleton, `startDownloadJob`/
   * `subscribeDownloadState`/`getActiveDownloadState`/
   * `cancelActiveDownloadJob` -- imported, never reimplemented, this file's
   * own top doc comment) -- one at a time, server-side, progress reported,
   * never blocking a run (§9).
   *
   * The identifiers are already in hand -- `civitaiRecord.model_id`/
   * `version_id`, the SAME fields "View on Civitai ↗" already builds its own
   * URL from -- and `fetchModelDetail`/`cachedModelDetail` (this file's own
   * top import comment) resolve the version's actual downloadable FILE from
   * them; `pickPrimaryDownloadFile` (above) is the pure pick. No second
   * lookup: `ensureDownloadTarget` reuses the SAME cached/in-flight
   * `fetchModelDetail` call this pack already makes for the model/version
   * detail view, never issuing its own.
   *
   * Three states, once `missing && civitaiEnabled`:
   *
   *   1. A download for THIS exact (model_id, version_id) is already
   *      running (`getActiveDownloadState()`, keyed via the SAME `resultKey`
   *      the search card uses) -- a compact progress readout + Cancel,
   *      subscribed via `subscribeDownloadState` so it updates live without
   *      this panel polling anything itself.
   *   2. A real download target has resolved (`ensureDownloadTarget()`) --
   *      a `↓ Download` BUTTON (never an `<a>` -- it starts a job, it
   *      doesn't navigate) that calls `startDownloadJob`.
   *   3. Neither -- renders NO button at all, same "a dead button is worse
   *      than none" rule this panel already follows for the no-record case
   *      (`View on Civitai ↗`, a few rows above, is still there regardless).
   *
   * A dynamic subtree (`footerActionHost`), not a static shell -- rebuilt
   * every time `renderIdentity` is (this function is called FIRST thing
   * inside it, ahead of that function's own early returns, so it never gets
   * skipped) AND every time the shared download job changes state (this
   * file's own `subscribeDownloadState` wiring, near `handle`'s own
   * creation): `civitaiRecord`/the download target/the job's own progress
   * all resolve well after the footer's static shell is first built.
   */
  function renderFooterAction() {
    footerActionHost.innerHTML = "";
    const missing = !!kind && !!name && hasFile(kind, name) === false;
    if (!missing) {
      const deleteBtn = el(doc, "button", "wtn-mi-delete");
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.title = "Remove this file from disk.";
      deleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openDeleteConfirm({
          doc,
          kind,
          name,
          sizeBytes,
          deleteFn: deleteModel,
          onDeleted: (delResult) => {
            logSummary("LoRA info", `${kind}/${name}: deleted (${removedSummary(delResult.removed)})`);
            invalidateList(kind);
            if (typeof onDeleted === "function") {
              onDeleted(kind, name);
            }
            handle.close();
          },
        });
      });
      footerActionHost.appendChild(deleteBtn);
      return;
    }
    if (!civitaiEnabled) {
      return; // no network affordance at all when the setting is off (§7b decision 20) -- same as every other one in this panel
    }
    const rowKey = civitaiRecord ? resultKey({ model_id: civitaiRecord.model_id, primary_version_id: civitaiRecord.version_id }) : "";
    const job = getActiveDownloadState();
    if (job && rowKey && job.key === rowKey) {
      // Case 1 -- a job for THIS exact version is already running (started
      // from here, or from any OTHER surface in this pack -- `resultKey`
      // recognises the same one everywhere).
      const row = el(doc, "div", "wtn-mi-dl-progress");
      const pct = downloadPercent(job.bytes, job.total);
      const label = el(doc, "span");
      label.textContent = pct == null ? "Downloading…" : `Downloading… ${pct}%`;
      row.appendChild(label);
      const cancelBtn = el(doc, "button", "wtn-mi-dl-cancel");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        cancelActiveDownloadJob();
      });
      row.appendChild(cancelBtn);
      footerActionHost.appendChild(row);
      return;
    }
    const target = ensureDownloadTarget();
    if (!target) {
      return; // no known download target yet (or ever) -- neither action, never a dead button
    }
    const downloadBtn = el(doc, "button", "wtn-mi-download");
    downloadBtn.type = "button";
    downloadBtn.textContent = "Download";
    downloadBtn.title = "This file is gone from disk -- download it again from Civitai.";
    downloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      downloadBtn.disabled = true;
      startDownloadJob({
        kind,
        subfolder: subfolderFromName(name),
        filename: target.filename,
        downloadUrl: target.downloadUrl,
        sizeKb: target.sizeKb,
        key: rowKey,
      }, downloadPollIntervalMs).then((resp) => {
        if (resp.reason !== "started") {
          logSummary("LoRA info", `${kind}/${name}: download NOT started (${resp.reason})`);
        } else {
          logSummary("LoRA info", `${kind}/${name}: download started (${target.filename})`);
        }
        // `subscribeDownloadState` (below) already re-renders this footer
        // on every state change, including this very "started" transition
        // -- but a `resp.reason !== "started"` (e.g. `busy`) never fires
        // that notification at all, so re-render here too, unconditionally,
        // rather than leave a `disabled` button stuck if nothing else ever
        // repaints it.
        renderFooterAction();
      });
    });
    footerActionHost.appendChild(downloadBtn);
  }

  function renderIdentity() {
    renderFooterAction();
    renderThumb();

    // The header TITLE prefers Civitai's own model name (a real display
    // name, e.g. "Skin Detail XL") over the prettified filename -- but ONLY
    // when `showCivitaiName` (§1a-vii) is on: "one setting, one rule" means
    // this surface must agree with the picker row and the LoRA row's own
    // name field, not run its own independent preference. A filename
    // transform is the fallback for "the setting is off / nothing's known
    // yet / Civitai is off", never the placeholder. Still textContent only
    // (`civitaiRecord.name` is Civitai-supplied text) -- see this file's top
    // doc comment.
    const civitaiName = showCivitaiName && civitaiRecord && typeof civitaiRecord.name === "string"
      ? civitaiRecord.name.trim()
      : "";
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
    if (id === "search-by-name") {
      // §7e: hand off to the CALLER, which opens the actual Civitai search
      // surface (this file stays track-agnostic -- it never imports
      // `civitai_search.mjs` itself). Close this panel first -- the search
      // panel is the next thing the user actually wants to look at.
      if (typeof onSearchByName === "function") {
        handle.close();
        onSearchByName(name);
      }
      return;
    }
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
          renderDescriptions();
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
          renderDescriptions();
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
        logDebug("LoRA info", `${kind}/${name}: cache hit (${cached.reason})`);
        applyLookupResponse(cached);
        renderStatus();
        renderIdentity();
        renderTriggers();
        renderDescriptions();
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
      renderStatus();
    }
    logDebug("LoRA info", `${kind}/${name}: ${force ? "forced re-fetch" : "fetching (cache miss)"}`);
    const response = await lookupInfo(kind, name, { force: !!force, cachedOnly: !force });
    if (cancelled) {
      return;
    }
    applyLookupResponse(response);
    const outcome = response.reason === "offline" ? `offline (${response.offline_reason})` : response.reason;
    logSummary("LoRA info", `${kind}/${name}: lookup outcome = ${outcome}`);
    if (response.reason === "found") {
      // A real lookup just resolved "found" -- the server-side sidecar was
      // written (or refreshed) by THIS call (`lookup.py`'s own doc comment:
      // a sidecar write only ever happens on a "found" reason). Two things
      // that were dead code until this call reached them:
      //
      //  1. invalidateList(kind) -- so a freshly-known name (§1a-vii) or
      //     preview doesn't sit on disk unused until something else
      //     happens to refetch the picker's list.
      //  2. save_preview -- hand back the URL of whichever CANDIDATE this
      //     panel is already displaying (level-filtered by construction,
      //     `pickThumbCandidates`) so the local preview is saved too
      //     (§7c-iv). No candidate passes ⇒ send nothing at all -- correct,
      //     not a failure. A failure from the route itself must never
      //     disturb this panel (`savePreview` already never rejects).
      invalidateList(kind);
      const images = response.data && Array.isArray(response.data.images) ? response.data.images : [];
      const civitaiCandidates = pickThumbCandidates(images, levelLabelToInt(browsingLevel));
      if (civitaiCandidates.length > 0) {
        savePreview(kind, name, civitaiCandidates[0])
          .then((saveResult) => {
            if (saveResult && saveResult.reason === "ok" && saveResult.saved) {
              logSummary("LoRA info", `${kind}/${name}: saved preview image`);
            }
          })
          .catch(() => {}); // must never disturb the panel
      }
    }
    renderStatus();
    renderIdentity();
    renderTriggers();
    renderDescriptions();
  }

  async function runForget() {
    if (!civitaiEnabled) {
      return;
    }
    await forgetInfo(kind, name);
    logSummary("LoRA info", `${kind}/${name}: forgot cached Civitai info`);
    civitaiRecord = null;
    civitaiTriggers = [];
    status = { phase: "idle" };
    renderStatus();
    renderIdentity();
    renderTriggers();
    renderDescriptions();
  }

  // Initial paint.
  renderIdentity();
  renderStatus();
  renderTriggers();
  renderDescriptions();

  const handle = openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, panel, "right", () => {
    cancelled = true;
    if (unsubscribeDownload) {
      // Never leave this panel's listener on the shared download-job
      // singleton after it's gone -- the job itself keeps running/polling
      // regardless (civitai_search.mjs's own top doc comment), this just
      // stops a CLOSED panel from being notified about it.
      unsubscribeDownload();
      unsubscribeDownload = null;
    }
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }, "wtn-mi-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;

  // Re-renders the footer the moment the shared download job's own state
  // changes (started elsewhere, progress, finished/cancelled/failed) --
  // this is what keeps a "↓ Download" click's own progress live without
  // this panel polling anything itself, and what flips a stuck `disabled`
  // button back once a `busy`/failure response is known (this file's own
  // `renderFooterAction` doc comment).
  unsubscribeDownload = subscribeDownloadState(() => {
    renderFooterAction();
  });

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
