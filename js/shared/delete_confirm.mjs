/**
 * delete_confirm.mjs — the type-to-confirm dialog behind "Remove an
 * installed model" (`docs/TODO.md`, owner decisions taken 2026-07-30): the
 * first UI in this pack that destroys user data, so a mis-click must never
 * be able to lose a multi-hundred-MB file. Shared between the ⓘ panel
 * (`js/controls/model_info.mjs`) and the search panel's own "installed" card
 * (`js/controls/civitai_search.mjs`) rather than grown twice.
 *
 * ## Why type-to-confirm, not a yes/no
 *
 * The dialog names the exact FILENAME, its SIZE and its FOLDER -- that part
 * carries the real weight now (below) -- and the Delete button stays
 * disabled until the typed text is the word `delete` (case-insensitive,
 * whitespace-trimmed) -- that is the whole reason this design was chosen
 * over a plain confirm: a mis-click cannot fire it, and typing something
 * forces a deliberate second action before the file goes.
 *
 * **The confirm word is `delete`, not the filename** (owner, simplifying an
 * earlier "type the exact filename" design while keeping the mechanic
 * itself): a long/hard-to-type filename made the safeguard annoying rather
 * than reassuring, and the actual reviewable information -- which file, how
 * big, which folder -- was ALREADY carried by the dialog's own name/size/
 * folder lines above the input, never by the act of retyping the name. That
 * naming is still the part doing the real work; the typed word is only the
 * "are you sure, deliberately" gate. `delete` is a fixed English word rather
 * than a filename, so accepting it case-insensitively (`DELETE`/`Delete`/
 * `delete` all enable the button) is a deliberate, defensible choice --
 * accepting a mis-cased FILENAME would not have been, since a real filename's
 * exact case is part of its identity on most filesystems.
 *
 * ## No network call of its own
 *
 * `deleteFn` (`(kind, name) => Promise<{reason, message, removed}>`) is
 * injected by the caller -- every real caller passes `civitai_api.mjs`'s
 * `deleteModel` -- so this module has no opinion on which track/kind is
 * deleting and stays testable with a plain stub function. A `write_error` (or
 * any non-`"ok"` reason) surfaces its own `message` INSIDE the dialog and
 * re-enables the button rather than closing -- a failed delete must never
 * look like a silent success.
 *
 * ## Untrusted text -- textContent, never innerHTML
 *
 * The filename and any route-supplied `message` are user/local-disk-derived
 * strings, written via `textContent` only, matching every other panel in
 * this pack (`model_info.mjs`'s own top doc comment).
 */

import { Z_CONFIRM } from "./z_layers.mjs";

const STYLE_ID = "wtn-dc-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly -- same "every render module
// keeps its own hardcoded fallback copy" convention as every sibling in the
// Civitai reuse boundary (`model_info.mjs`/`civitai_search.mjs`'s own top doc
// comments).
const TOKENS = {
  surface2: "#1b212a",
  line: "#28303b",
  lineSoft: "#1f2731",
  ink: "#e7ecf3",
  inkDim: "#93a0b1",
  inkFaint: "#5f6c7d",
  console: "#0a0d12",
  accentDeep: "#14b8a6",
  onAccent: "#062420",
  bad: "#f87171",
  badStrong: "#fca5a5",
};

const CSS = `
.wtn-dc-scrim {
  position: fixed; inset: 0; z-index: ${Z_CONFIRM};
  background: rgba(6, 8, 11, 0.72);
  display: flex; align-items: center; justify-content: center;
}
.wtn-dc-dialog {
  width: 360px; max-width: 90vw; box-sizing: border-box;
  padding: 16px 16px 14px; border-radius: 10px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  box-shadow: var(--wtn-shadow, 0 24px 60px rgba(0,0,0,.66));
  font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-dc-title { font-size: 14px; font-weight: 650; margin-bottom: 8px; }
.wtn-dc-file {
  font-family: var(--wtn-font-mono, monospace); font-size: 11.5px; word-break: break-all;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  border-radius: 6px; padding: 6px 8px; margin-bottom: 6px;
}
.wtn-dc-meta { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); font-size: 11px; margin-bottom: 10px; }
.wtn-dc-warn { color: var(--wtn-bad, ${TOKENS.bad}); font-size: 11.5px; line-height: 1.4; margin-bottom: 12px; }
.wtn-dc-label { display: block; font-size: 11px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); margin-bottom: 4px; }
.wtn-dc-input {
  width: 100%; box-sizing: border-box; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink, ${TOKENS.ink});
  font: 11.5px var(--wtn-font-mono, monospace); padding: 6px 8px; border-radius: 6px; margin-bottom: 6px;
}
.wtn-dc-error { color: var(--wtn-bad-strong, ${TOKENS.badStrong}); font-size: 11px; margin-bottom: 6px; }
.wtn-dc-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.wtn-dc-cancel {
  height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); border: 1px dashed var(--wtn-line, ${TOKENS.line});
}
.wtn-dc-cancel:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-dc-confirm {
  height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px;
  background: var(--wtn-bad, ${TOKENS.bad}); color: #2a0d0d; border: 1px solid var(--wtn-bad, ${TOKENS.bad});
}
.wtn-dc-confirm:disabled { opacity: .45; cursor: default; }
`;

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

export function injectDeleteConfirmStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  if (typeof document !== "undefined") {
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
// Pure helpers -- no DOM, no `doc`/`window` reference anywhere below.
// ---------------------------------------------------------------------------

// The fixed confirm word (this module's own top doc comment: "simplifying
// ... while keeping the mechanic itself"). A constant, not a literal
// sprinkled through this file/its callers, so the label/placeholder below
// and the check itself can never drift apart.
export const DELETE_CONFIRM_WORD = "delete";

/** Whether the Delete button should be enabled: the typed text (trimmed --
 * only whitespace is forgiven -- and lower-cased) equals `DELETE_CONFIRM_WORD`
 * -- CASE-INSENSITIVE (`DELETE`/`Delete`/`delete` all enable it), unlike the
 * exact-match-only filename check this replaced -- see this module's own top
 * doc comment for why that distinction is deliberate. `filename` is no longer
 * what's being MATCHED against, but it's still required (a garbage/empty one
 * means there is nothing real to confirm against, so this refuses to enable
 * regardless of what was typed) -- callers keep passing it unchanged. `false`
 * for a non-string `typedText`. Never throws. */
export function deleteConfirmEnabled(typedText, filename) {
  if (typeof filename !== "string" || !filename) {
    return false;
  }
  if (typeof typedText !== "string") {
    return false;
  }
  return typedText.trim().toLowerCase() === DELETE_CONFIRM_WORD;
}

/** A human-readable file size (`"12.3 MB"`, `"820 KB"`, `"512 B"`) -- mirrors
 * `js/controls/model_picker.mjs`'s own `formatFileSize` algorithm exactly (a
 * duplicated copy, per this pack's "every render module keeps its own"
 * convention). `""` for garbage/negative input, never throws -- callers show
 * their own "unknown size" fallback for that case. */
export function formatDeleteFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) {
    return "";
  }
  if (n < 1024) {
    return `${Math.round(n)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}

// `kind` -> the root folder it lives under -- same three kinds every other
// Civitai-track module already whitelists (`js/controls/civitai_search.mjs`'s
// own `DEFAULT_ROOT_DISPLAY`, duplicated rather than imported so this shared
// module carries no dependency on a track file).
//
// Fixed 2026-08-05 -- `unet` used to say `"models/unet"`, the SAME wrong
// folder `civitai_search.mjs`'s own `DEFAULT_ROOT_DISPLAY` had before a973001
// fixed it there (`unet`'s real folder is `models/diffusion_models`,
// `src/model_browser/kinds.py`'s own `KIND_TO_FOLDER["unet"]` -- ComfyUI
// renamed the folder_paths key across versions; `diffusion_models` is
// current). This copy is WORSE than that one was: it names the folder in a
// DESTRUCTIVE confirmation dialog, whose entire point is telling the user
// exactly what is about to be deleted -- a wrong folder there is not cosmetic
// noise, it's a false statement at the one moment accuracy matters most.
// `test_delete_confirm.mjs` pins this against `civitai_search.mjs`'s own
// `DEFAULT_ROOT_DISPLAY` directly (a cross-file agreement test, not just a
// hardcoded expected string) so the two copies can never silently diverge
// again -- kept as two copies rather than one shared export/import, per this
// comment's own "no dependency on a track file" reasoning above; a test can
// import both without creating that dependency in the shipped module.
const ROOT_FOR_KIND = { loras: "models/loras", checkpoints: "models/checkpoints", unet: "models/diffusion_models" };

/** The folder line the confirm dialog shows -- the kind's own root, plus any
 * subfolder prefix carried in `name` itself (`folder_paths`' own convention:
 * a listed model's `name` already includes it, e.g.
 * `"detail/my_lora.safetensors"`). Never throws; degrades to the bare root
 * for a garbage/rootless `name`. */
export function folderLabelFor(kind, name) {
  const root = ROOT_FOR_KIND[kind] || (kind ? `models/${kind}` : "models");
  if (typeof name !== "string" || !name) {
    return root;
  }
  const clean = name.replace(/\\/g, "/");
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) {
    return root;
  }
  return `${root}/${clean.slice(0, idx)}`;
}

/** A readable summary of a successful delete's own `removed` list
 * (`"model"`/`"sidecar"`/`"preview"`, `src/model_browser/remove.py`'s own
 * doc comment) -- `"model"` alone reads as `"model"`; more than one joins
 * with `" + "` (`"model + sidecar"`). `"nothing"` for a garbage/empty list
 * (should never happen on a genuine `"ok"`, which always includes at least
 * `"model"` -- defensive only). Never throws. */
export function removedSummary(removed) {
  const list = Array.isArray(removed) ? removed.filter((r) => typeof r === "string" && r) : [];
  if (!list.length) {
    return "nothing";
  }
  return list.join(" + ");
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/**
 * Opens the type-to-confirm delete dialog, as a centred scrim modal (not an
 * anchored popover -- this can be triggered from inside an already-open
 * anchored panel, e.g. the ⓘ panel or a search result card, so it needs its
 * own stacking context rather than `../shared/overlay.mjs`'s anchored
 * mechanism). Mirrors `js/controls/civitai_modal.mjs`'s own lifecycle
 * mechanism (scrim, Escape-to-close, scrim-click-to-close, focus restore) --
 * none of which `overlay.mjs` provides for this shape.
 *
 * @param {object} opts
 * @param {Document} [opts.doc] - injectable for testing; real callers omit it.
 * @param {string} opts.kind
 * @param {string} opts.name - the exact filename the user must type.
 * @param {number} [opts.sizeBytes] - the file's size, for the confirm line.
 * @param {(kind: string, name: string) => Promise<{reason: string, message?: string, removed?: string[]}>} opts.deleteFn
 * @param {(result: object) => void} [opts.onDeleted] - called once, after a genuine `reason === "ok"`, BEFORE the dialog closes.
 * @param {() => void} [opts.onClose] - called when the dialog closes for ANY reason (cancel, Escape, scrim click, or after a successful delete).
 * @returns {{close: () => void, scrim: Element, dialog: Element}|null}
 */
export function openDeleteConfirm({ doc, kind, name, sizeBytes, deleteFn, onDeleted, onClose } = {}) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return null;
  }
  injectDeleteConfirmStyles(targetDoc);

  const previouslyFocused = targetDoc.activeElement || null;

  const scrim = el(targetDoc, "div", "wtn wtn-dc-scrim");
  const dialog = el(targetDoc, "div", "wtn-dc-dialog");
  scrim.appendChild(dialog);

  const title = el(targetDoc, "div", "wtn-dc-title");
  title.textContent = "Delete this model?";
  dialog.appendChild(title);

  const fileLine = el(targetDoc, "div", "wtn-dc-file");
  fileLine.textContent = name || "";
  dialog.appendChild(fileLine);

  const metaLine = el(targetDoc, "div", "wtn-dc-meta");
  const sizeLabel = formatDeleteFileSize(sizeBytes) || "unknown size";
  metaLine.textContent = `${sizeLabel} — ${folderLabelFor(kind, name)}`;
  dialog.appendChild(metaLine);

  const warn = el(targetDoc, "div", "wtn-dc-warn");
  warn.textContent = "This permanently deletes the file from disk. This cannot be undone.";
  dialog.appendChild(warn);

  const label = el(targetDoc, "label", "wtn-dc-label");
  label.textContent = `Type "${DELETE_CONFIRM_WORD}" to confirm:`;
  dialog.appendChild(label);

  const input = el(targetDoc, "input", "wtn-dc-input");
  input.type = "text";
  input.spellcheck = false;
  input.placeholder = DELETE_CONFIRM_WORD;
  input.addEventListener("click", (e) => e.stopPropagation());
  dialog.appendChild(input);

  const errorLine = el(targetDoc, "div", "wtn-dc-error");
  errorLine.style.display = "none";
  dialog.appendChild(errorLine);

  const footer = el(targetDoc, "div", "wtn-dc-footer");
  const cancelBtn = el(targetDoc, "button", "wtn-dc-cancel");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  footer.appendChild(cancelBtn);
  const confirmBtn = el(targetDoc, "button", "wtn-dc-confirm");
  confirmBtn.type = "button";
  confirmBtn.textContent = "Delete";
  confirmBtn.disabled = true;
  footer.appendChild(confirmBtn);
  dialog.appendChild(footer);

  const listenWin = targetDoc.defaultView || (typeof window !== "undefined" ? window : null);
  let closed = false;
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    if (listenWin && typeof listenWin.removeEventListener === "function") {
      listenWin.removeEventListener("keydown", onKeydown);
    }
    if (scrim.parentNode && typeof scrim.parentNode.removeChild === "function") {
      scrim.parentNode.removeChild(scrim);
    }
    if (previouslyFocused && typeof previouslyFocused.focus === "function") {
      try {
        previouslyFocused.focus();
      } catch {
        // Best-effort -- never let a focus restore crash the close path.
      }
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }

  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) {
      close();
    }
  });
  function onKeydown(e) {
    if (e.key === "Escape") {
      close();
    }
  }
  if (listenWin && typeof listenWin.addEventListener === "function") {
    listenWin.addEventListener("keydown", onKeydown);
  }

  input.addEventListener("input", () => {
    confirmBtn.disabled = !deleteConfirmEnabled(input.value, name);
  });

  let busy = false;
  confirmBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (busy || confirmBtn.disabled || typeof deleteFn !== "function") {
      return;
    }
    busy = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Deleting…";
    errorLine.style.display = "none";
    errorLine.textContent = "";
    let result;
    try {
      result = await deleteFn(kind, name);
    } catch (err) {
      result = { reason: "offline", message: err && err.message ? err.message : String(err), removed: [] };
    }
    if (closed) {
      return; // cancelled while the request was in flight -- nothing left to update
    }
    if (result && result.reason === "ok") {
      if (typeof onDeleted === "function") {
        onDeleted(result);
      }
      close();
      return;
    }
    // Not "ok" (`write_error`/`not_found`/`offline`/anything else) -- a
    // failure must surface readably and stay open, never close silently.
    busy = false;
    confirmBtn.textContent = "Delete";
    confirmBtn.disabled = !deleteConfirmEnabled(input.value, name);
    errorLine.textContent = (result && result.message) || "Could not delete the file.";
    errorLine.style.display = "";
  });

  const body = targetDoc.body || targetDoc;
  body.appendChild(scrim);

  if (typeof input.focus === "function") {
    input.focus();
  }

  return { close, scrim, dialog };
}
