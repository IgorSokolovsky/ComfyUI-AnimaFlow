/**
 * history.mjs — the generation-history panel for `AnimaPreview` (owner-
 * requested feature, designed 2026-07-29/30). Lazily imported (never one of
 * this pack's five auto-loaded `.js` entry points, per `.claude/CLAUDE.md`'s
 * JS download budget) — `interaction.mjs` dynamic-`import()`s this module
 * the first time a Preview node's "History" button is clicked, same
 * lazy-loading convention every other `.mjs` in this track already follows.
 *
 * ## Surface: a panel opened from the node, in this pack's floating-panel
 * idiom
 *
 * Same mechanism as the LoRA ⓘ info panel (`js/controls/model_info.mjs`) and
 * the model picker: `js/shared/overlay.mjs`'s `openOverlayWithZoom`, no
 * hand-rolled scrim, `closeOverlayIfOwnedBy`/`closeOverlaysNotAncestorOf` for
 * the same toggle-closes / doesn't-steal-a-sibling's-overlay contract every
 * other opener in this pack already has. Every class name here is this
 * track's own `.wtn-an-*` vocabulary (`render.mjs`'s prefix), not Controls'
 * `.wtn-mi-*` — a different track, its own namespace, same idiom.
 *
 * ## Server-side truth: `expired` is never guessed at here
 *
 * `GET /wtn/anima/preview/history` (`src/anima/api.py`) already annotates
 * every entry with `expired` (`nodes/anima/_preview_helpers.
 * resolve_history_view`'s own on-disk existence check) — this module never
 * re-derives that itself, and never renders an `<img>` for an entry the
 * server already reported expired (belt-and-suspenders: `historyImageUrl`
 * below returns `null` for one, and the one place this module DOES still
 * attempt an image load — a non-expired entry's own thumbnail — has an
 * `onerror` handler that swaps to the SAME "expired" placeholder rather than
 * ever leaving a broken-image icon on screen, covering the race where a
 * `temp` file is cleaned up in the gap between this list request and the
 * browser's own image fetch).
 *
 * ## The four actions, and why the two disabled-when-expired ones differ
 * from the two that stay live
 *
 * "Copy the seed" and "Show its generation settings" read fields this
 * module ALREADY HAS off the entry itself (metadata only) — they work on an
 * expired entry exactly as well as a live one. "Save it now" and "Open the
 * full image" both need the actual file bytes, which an expired entry no
 * longer has — both render disabled, with a `title` naming why, rather than
 * being omitted (an action that silently isn't there reads as "this feature
 * doesn't exist here"; a visibly disabled one reads as "not available right
 * now, and here's why").
 *
 * "Save it now" posts to the SAME `/wtn/anima/preview/save_now` route the
 * node's own Save-now button already uses (`interaction.mjs`'s
 * `buildSaveNowRow`) — confirmed by reading `_preview_helpers.save_now`
 * before writing this: it accepts an arbitrary `{stage: {filename,
 * subfolder, type}}` map, not "the current run's" specifically, so a single
 * historical entry already fits its contract with no server change (see the
 * build report). This module builds that one-entry map itself; it is not a
 * second copy of `save_now`'s own stage-preference/filename logic, which
 * stays entirely server-side.
 */

import { buildPreviewImageUrl } from "./render.mjs";
import {
  openOverlayWithZoom,
  closeOverlayIfOwnedBy,
  closeOverlaysNotAncestorOf,
  activeOverlayRef,
} from "../shared/overlay.mjs";

const STYLE_ID = "wtn-an-hist-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";
const HISTORY_URL = "/wtn/anima/preview/history";
const SAVE_NOW_URL = "/wtn/anima/preview/save_now";

// Mirrors `render.mjs`'s own TOKENS exactly (that module's own doc comment
// explains why every render module keeps a hardcoded fallback copy rather
// than a shared import: no live ComfyUI server to serve `theme.mjs` under a
// headless test).
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
};

const EXPIRED_EXPLANATION = "This file is no longer on disk -- it may have been cleaned up since this ran.";
const EXPIRED_ACTION_TITLE = "Not available: " + EXPIRED_EXPLANATION;

const CSS = `
.wtn-an-hist-panel {
  width: 360px; max-height: 78vh; overflow-y: auto; box-sizing: border-box;
  padding: 11px 12px 12px; border-radius: 10px; display: flex; flex-direction: column;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  box-shadow: var(--wtn-shadow, 0 20px 46px rgba(0,0,0,.66));
  font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-an-hist-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.wtn-an-hist-title { font-size: 13px; font-weight: 600; flex: 1 1 auto; }
.wtn-an-hist-close { flex: none; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 13px; }
.wtn-an-hist-close:hover { color: var(--wtn-ink, ${TOKENS.ink}); }

.wtn-an-hist-msg { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 11.5px; font-style: italic; padding: 10px 2px; }
.wtn-an-hist-msg.wtn-an-hist-msg-err { color: var(--wtn-bad, ${TOKENS.bad}); font-style: normal; }

.wtn-an-hist-list { display: flex; flex-direction: column; gap: 7px; }
.wtn-an-hist-row {
  display: flex; gap: 9px; padding: 7px 8px; border-radius: 7px;
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); background: var(--wtn-console, ${TOKENS.console});
}
.wtn-an-hist-row.wtn-an-hist-row-expired { opacity: .62; }

.wtn-an-hist-thumb {
  width: 44px; height: 44px; flex: none; border-radius: 6px; overflow: hidden;
  background: #06080b; border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  display: flex; align-items: center; justify-content: center; font-size: 15px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
}
.wtn-an-hist-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }

.wtn-an-hist-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.wtn-an-hist-line1 { display: flex; align-items: baseline; gap: 6px; }
.wtn-an-hist-stage { font-family: var(--wtn-font-mono, monospace); font-size: 11.5px; font-weight: 700; color: var(--wtn-accent, ${TOKENS.accent}); text-transform: uppercase; }
.wtn-an-hist-dims { font-size: 11px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-an-hist-when { margin-left: auto; font-size: 10.5px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); flex: none; }
.wtn-an-hist-seed { font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtn-an-hist-expired-note { font-size: 11px; color: var(--wtn-warn, ${TOKENS.warn}); }

.wtn-an-hist-actions { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 3px; }
.wtn-an-hist-actions button {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px; padding: 3px 7px; border-radius: 5px;
  cursor: pointer; background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  border: 1px dashed var(--wtn-line, ${TOKENS.line});
}
.wtn-an-hist-actions button:hover:not(:disabled) { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-an-hist-actions button:disabled { opacity: .45; cursor: default; }

.wtn-an-hist-status { font-size: 10.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); margin-top: 3px; }
.wtn-an-hist-status.wtn-an-hist-status-err { color: var(--wtn-bad, ${TOKENS.bad}); }

.wtn-an-hist-settings {
  font-size: 10.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); background: #06080b;
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); border-radius: 5px; padding: 6px 7px;
  margin-top: 5px; max-height: 160px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
`;

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  if (typeof document !== "undefined") {
    // Guarded dynamic import -- same reasoning as every other render module
    // in this pack (no live ComfyUI server to serve this route under test).
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
// Pure helpers -- no DOM, no `doc`/`window` reference, directly testable
// under plain `node` (`test_history.mjs`).
// ---------------------------------------------------------------------------

/** A history entry's own `/view` URL, or `null` for one the server already
 * reported `expired` (never attempt to load a file that isn't there --
 * this module's own top doc comment). Reuses `render.mjs`'s
 * `buildPreviewImageUrl` (same `{filename, subfolder, type}` shape a
 * history entry already carries) rather than a second copy of that
 * URL-building logic. */
export function historyImageUrl(entry, cacheBust) {
  if (!entry || entry.expired) {
    return null;
  }
  return buildPreviewImageUrl(entry, cacheBust);
}

/** A short, deterministic "how long ago" label given an explicit `nowMs`
 * (never reads `Date.now()` itself when a caller passes one -- same "pure
 * given an explicit now" convention `preview_settings.format_filename`
 * already uses on the Python side) -- falls back to a real `Date.now()`
 * only when `nowMs` is omitted (the one non-test call site). `timestampSeconds`
 * is the entry's own `timestamp` field (epoch seconds, as recorded by
 * `nodes/anima/preview.py`'s `time.time()`). Never throws on a garbage
 * timestamp -- degrades to `"unknown time"`. */
export function formatHistoryTimestamp(timestampSeconds, nowMs) {
  if (typeof timestampSeconds !== "number" || !Number.isFinite(timestampSeconds)) {
    return "unknown time";
  }
  const then = timestampSeconds * 1000;
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const diffSec = Math.max(0, Math.round((now - then) / 1000));
  if (diffSec < 5) {
    return "just now";
  }
  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) {
    return `${diffH}h ago`;
  }
  const diffDay = Math.round(diffH / 24);
  return `${diffDay}d ago`;
}

/** The "Show its generation settings" body text -- the honest empty state
 * (Pattern 1b, `false-green-verification` skill) for an entry recorded with
 * no snapshot at all (`resolve_history_settings_snapshot` returned `None`,
 * e.g. the Generator's `metadata_json` wasn't wired), never a blank box. */
export function historySettingsText(settings) {
  if (settings === null || settings === undefined) {
    return "No generation settings were recorded for this entry.";
  }
  try {
    return JSON.stringify(settings, null, 2);
  } catch {
    return "This entry's generation settings couldn't be displayed.";
  }
}

/** Server response -> a plain `{ entries, error }` the caller can render
 * directly, regardless of which of the many ways this fetch can fail
 * (network error, no `fetch` at all, a non-OK response, a malformed body).
 * Never throws. */
export async function fetchHistoryEntries(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    return { entries: null, error: "History needs a live ComfyUI page (no fetch available here)." };
  }
  let res;
  try {
    res = await fetchImpl(HISTORY_URL);
  } catch (err) {
    return { entries: null, error: (err && err.message) || "Couldn't reach the server." };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { entries: null, error: "The server sent an unreadable reply." };
  }
  if (!res || !res.ok || !data || data.ok !== true || !Array.isArray(data.entries)) {
    return { entries: null, error: (data && data.error) || "Couldn't load history." };
  }
  return { entries: data.entries, error: null };
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

async function copySeedToClipboard(seed) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(String(seed));
      return { ok: true };
    }
  } catch {
    // fall through to the readable failure below
  }
  return { ok: false, message: `Couldn't copy automatically -- the seed is ${seed}.` };
}

function buildRow(doc, ctx, entry) {
  const row = el(doc, "div", `wtn-an-hist-row${entry.expired ? " wtn-an-hist-row-expired" : ""}`);

  const thumb = el(doc, "div", "wtn-an-hist-thumb");
  const url = historyImageUrl(entry);
  if (url) {
    const img = el(doc, "img");
    img.src = url;
    img.alt = "";
    img.addEventListener("error", () => {
      // Belt-and-suspenders (this module's top doc comment): the server
      // said this entry wasn't expired at LIST time, but the file could
      // have been cleaned up in the gap before this image request landed.
      // Swap to the SAME honest placeholder `expired` already gets --
      // never leave a native broken-image icon on screen.
      thumb.innerHTML = "";
      thumb.textContent = "⌀";
      thumb.title = EXPIRED_EXPLANATION;
    });
    thumb.appendChild(img);
  } else {
    thumb.textContent = "⌀";
    thumb.title = EXPIRED_EXPLANATION;
  }
  row.appendChild(thumb);

  const body = el(doc, "div", "wtn-an-hist-body");

  const line1 = el(doc, "div", "wtn-an-hist-line1");
  const stageEl = el(doc, "span", "wtn-an-hist-stage");
  stageEl.textContent = entry.stage || "?";
  line1.appendChild(stageEl);
  const dims = el(doc, "span", "wtn-an-hist-dims");
  dims.textContent = entry.width && entry.height ? `${entry.width}x${entry.height}` : "";
  line1.appendChild(dims);
  const when = el(doc, "span", "wtn-an-hist-when");
  when.textContent = formatHistoryTimestamp(entry.timestamp);
  line1.appendChild(when);
  body.appendChild(line1);

  const seedLine = el(doc, "div", "wtn-an-hist-seed");
  seedLine.textContent = `seed ${entry.seed != null ? entry.seed : "?"}`;
  body.appendChild(seedLine);

  if (entry.expired) {
    const note = el(doc, "div", "wtn-an-hist-expired-note");
    note.textContent = "Expired -- " + EXPIRED_EXPLANATION;
    body.appendChild(note);
  }

  const actions = el(doc, "div", "wtn-an-hist-actions");
  const status = el(doc, "div", "wtn-an-hist-status");
  const setStatus = (text, isError) => {
    status.textContent = text || "";
    if (status.classList && typeof status.classList.toggle === "function") {
      status.classList.toggle("wtn-an-hist-status-err", !!isError);
    }
  };

  // 1. Copy the seed -- metadata only, works on an expired entry too.
  const copyBtn = el(doc, "button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy seed";
  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const result = await copySeedToClipboard(entry.seed);
    setStatus(result.ok ? "Seed copied." : result.message, !result.ok);
  });
  actions.appendChild(copyBtn);

  // 2. Save it now -- disabled when expired (no file left to copy).
  const saveBtn = el(doc, "button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save it now";
  if (entry.expired) {
    saveBtn.disabled = true;
    saveBtn.title = EXPIRED_ACTION_TITLE;
  } else {
    saveBtn.addEventListener("click", () => {
      const doFetch = (ctx && typeof ctx.fetchImpl === "function")
        ? ctx.fetchImpl
        : (typeof fetch === "function" ? fetch : null);
      if (!doFetch) {
        setStatus("Save now needs a live ComfyUI page (no fetch available here).", true);
        return;
      }
      saveBtn.disabled = true;
      setStatus("Saving…", false);
      const previewState = (ctx && ctx.previewStateJson) || "{}";
      Promise.resolve(doFetch(SAVE_NOW_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stages: { [entry.stage]: { filename: entry.filename, subfolder: entry.subfolder, type: entry.type } },
          preview_state: previewState,
          seed: entry.seed,
        }),
      }))
        .then((res) => Promise.resolve(res.json()).then((data) => ({ ok: !!(res && res.ok), data })))
        .then(({ data }) => {
          saveBtn.disabled = false;
          if (data && data.ok) {
            setStatus(`Saved as ${data.filename}`, false);
          } else {
            setStatus((data && data.error) || "Save failed.", true);
          }
        })
        .catch((err) => {
          saveBtn.disabled = false;
          setStatus((err && err.message) || "Save failed.", true);
        });
    });
  }
  actions.appendChild(saveBtn);

  // 3. Show its generation settings -- expand IN PLACE (this track's own
  // idiom, `docs/generator-design.md` §12 -- never a second popover).
  const settingsBtn = el(doc, "button");
  settingsBtn.type = "button";
  settingsBtn.textContent = "Settings";
  const settingsBox = el(doc, "pre", "wtn-an-hist-settings");
  settingsBox.style.display = "none";
  let settingsOpen = false;
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsOpen = !settingsOpen;
    settingsBox.style.display = settingsOpen ? "" : "none";
    if (settingsOpen && !settingsBox.textContent) {
      settingsBox.textContent = historySettingsText(entry.settings);
    }
  });
  actions.appendChild(settingsBtn);

  // 4. Open the full image -- disabled when expired (nothing to open).
  const openBtn = el(doc, "button");
  openBtn.type = "button";
  openBtn.textContent = "Open image";
  if (entry.expired || !url) {
    openBtn.disabled = true;
    openBtn.title = EXPIRED_ACTION_TITLE;
  } else {
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const win = (ctx && ctx.getWindow && ctx.getWindow()) || (typeof window !== "undefined" ? window : null);
      if (win && typeof win.open === "function") {
        win.open(url, "_blank", "noopener,noreferrer");
      } else {
        setStatus("Can't open a new tab here.", true);
      }
    });
  }
  actions.appendChild(openBtn);

  body.appendChild(actions);
  body.appendChild(status);
  body.appendChild(settingsBox);
  row.appendChild(body);
  return row;
}

/**
 * Opens the generation-history panel, anchored to `anchorEl`.
 *
 * @param {object} opts
 * @param {{doc, getCanvasEl, fetchImpl?, getWindow?}} opts.ctx
 * @param {Element} opts.anchorEl
 * @param {string} [opts.ownerKey] - identifies THIS anchor/opener, same
 *   toggle contract every overlay opener in this pack shares
 *   (`closeOverlayIfOwnedBy`): a second click on the SAME button closes its
 *   own panel; a click somewhere else opens a fresh one (closing the first
 *   via `closeOverlaysNotAncestorOf`). `interaction.mjs`'s real caller
 *   (`buildHistoryButton`) always passes a node-specific key
 *   (`` `anima-history:${node.id}` ``) -- see that function's own doc
 *   comment for why a single SHARED key across every Preview node would be
 *   wrong here even though the panel's CONTENT is the same session-wide
 *   list regardless of which node's button opened it. Defaults to the bare
 *   `"anima-history"` only for a caller (a test, say) that doesn't supply
 *   one.
 * @param {string} [opts.previewStateJson] - the node's current
 *   `preview_state` (serialized), threaded through to "Save it now" so a
 *   historical save uses the SAME configured extension/path/filename
 *   template as the node's own Save-now button, not a hardcoded default.
 * @returns {object|null} the overlay handle, or `null` if this call just
 *   toggled an already-open panel closed.
 */
export function openHistoryPanel({ ctx, anchorEl, ownerKey, previewStateJson } = {}) {
  const key = ownerKey || "anima-history";
  if (closeOverlayIfOwnedBy(key)) {
    return null; // toggle: the panel was already open -- just close it
  }
  closeOverlaysNotAncestorOf(anchorEl);

  const doc = ctx.doc;
  injectStyles(doc);

  const panel = el(doc, "div", "wtn-an-hist-panel wtn");
  const head = el(doc, "div", "wtn-an-hist-head");
  const title = el(doc, "div", "wtn-an-hist-title");
  title.textContent = "Generation history";
  head.appendChild(title);
  const closeBtn = el(doc, "span", "wtn-an-hist-close");
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handle.close();
  });
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const bodyHost = el(doc, "div");
  panel.appendChild(bodyHost);

  const rowCtx = { fetchImpl: ctx.fetchImpl, getWindow: ctx.getWindow, previewStateJson };

  function renderMessage(text, isError) {
    bodyHost.innerHTML = "";
    const msg = el(doc, "div", `wtn-an-hist-msg${isError ? " wtn-an-hist-msg-err" : ""}`);
    msg.textContent = text;
    bodyHost.appendChild(msg);
  }

  renderMessage("Loading history…", false);

  const doFetch = typeof ctx.fetchImpl === "function" ? ctx.fetchImpl : (typeof fetch === "function" ? fetch : null);
  fetchHistoryEntries(doFetch).then(({ entries, error }) => {
    if (error) {
      renderMessage(error, true);
      return;
    }
    if (!entries.length) {
      // Pattern 1b (`false-green-verification` skill): name the actual
      // trigger, not just "nothing here" -- this panel really does start
      // empty for a brand-new session, and this line is the answer to
      // "why is there nothing to browse yet".
      renderMessage("No generation history yet -- run the Generator with this Preview wired to start recording.", false);
      return;
    }
    bodyHost.innerHTML = "";
    const list = el(doc, "div", "wtn-an-hist-list");
    for (const entry of entries) {
      list.appendChild(buildRow(doc, rowCtx, entry));
    }
    bodyHost.appendChild(list);
  });

  const handle = openOverlayWithZoom(ctx.getCanvasEl, doc, anchorEl, panel, "right", () => {
    if (activeOverlayRef.current === handle) {
      activeOverlayRef.current = null;
    }
  }, "wtn-an-hist-overlay wtn");
  handle.ownerKey = key;
  activeOverlayRef.current = handle;
  return handle;
}
