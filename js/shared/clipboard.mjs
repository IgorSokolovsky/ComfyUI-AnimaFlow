/**
 * clipboard.mjs — the ONE copy-to-clipboard helper every track in this pack
 * calls, instead of each hand-rolling its own `navigator.clipboard` guard.
 *
 * ## Why this exists (owner-reported, 2026-08-04)
 *
 * "Copy seed" reported *"Couldn't copy automatically -- the seed is
 * 254321339072737489."* The owner reaches ComfyUI over plain `http://` (a
 * pinggy tunnel, not `localhost`) — that's an INSECURE context, and a
 * browser does not expose `navigator.clipboard` AT ALL there, secure or not.
 * Before this module, three call sites each guarded on
 * `navigator.clipboard` and simply gave up when it was absent:
 * `js/anima/history.mjs`'s `copySeedToClipboard` (at least surfaced a
 * readable message), `js/prompt_rules/rule_builder/overlay.mjs`'s
 * "Copy YAML" (silently did nothing — the worst of the three, since the
 * user can't tell a failed copy from a successful one), and
 * `js/controls/model_detail_view.mjs`'s `defaultCopyToClipboard` (out of
 * scope here — a concurrent build may still be touching that file).
 *
 * Switching to `https://` fixes it for the owner specifically, but anyone
 * reaching ComfyUI at `http://192.168.x.x:8188` on a LAN — a completely
 * ordinary way to run it — hits the exact same gap. Hence a real fallback,
 * not just a better error message.
 *
 * ## The fallback: a temporary, off-screen `<textarea>` + `execCommand`
 *
 * `document.execCommand("copy")` is deprecated, but it is the ONLY
 * synchronous copy mechanism that still works on an insecure origin — that
 * is the entire reason this fallback exists, so don't "modernise" it away.
 * Mechanics that matter here (each one is a real bug this module avoids):
 *
 * - **Off-screen positioning (`position: fixed; left: -9999px`), never
 *   `display: none`** — a hidden element can't be `select()`ed, and
 *   `execCommand("copy")` copies whatever's currently selected.
 * - **Removed in a `finally`**, so a throwing `execCommand` (some browsers
 *   throw rather than return `false` when the command isn't supported)
 *   never leaves the temporary element stuck in the DOM.
 * - **Restores whatever selection/focus the user had** before this ran —
 *   copying a seed is a side effect of a click, not something that should
 *   steal the user's place in a text field they were editing.
 *
 * ## The `{ok, message}` return shape
 *
 * Never throws — every caller gets back `{ok: true}` or `{ok: false,
 * message}` and decides what to do with a failure itself (an inline status
 * line, a toast, or building a richer message of its own, e.g.
 * `history.mjs`'s "the seed is <seed>" wording, which this module has no way
 * to know about).
 *
 * `doc` is an optional explicit `Document` (mirrors `js/shared/overlay.mjs`'s
 * own `doc` parameter convention) — defaults to the global `document` when
 * omitted, and lets tests exercise the fallback path with a plain object
 * stub instead of a real browser DOM.
 */

const FALLBACK_UNAVAILABLE_MESSAGE = "Clipboard access isn't available in this browser context.";

/**
 * Copy `text` to the clipboard. Tries the modern `navigator.clipboard.
 * writeText` first; if it's absent (insecure origin) or it rejects, falls
 * back to the legacy textarea/`execCommand` path. Returns `{ok: true}` on
 * success or `{ok: false, message}` on failure — never throws.
 */
export async function copyToClipboard(text, doc) {
  const str = String(text);
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(str);
      return { ok: true };
    }
  } catch {
    // Modern API present but rejected (permission denied, browser quirk) --
    // fall through to the legacy path below rather than giving up.
  }
  return legacyCopy(str, doc);
}

function legacyCopy(str, doc) {
  const d = doc || (typeof document !== "undefined" ? document : null);
  if (!d || typeof d.createElement !== "function" || !d.body || typeof d.body.appendChild !== "function") {
    return { ok: false, message: FALLBACK_UNAVAILABLE_MESSAGE };
  }

  const win = d.defaultView || (typeof window !== "undefined" ? window : null);
  const previousActive = d.activeElement && typeof d.activeElement.focus === "function" ? d.activeElement : null;
  const sel = win && typeof win.getSelection === "function" ? win.getSelection() : null;
  const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;

  const textarea = d.createElement("textarea");
  textarea.value = str;
  if (typeof textarea.setAttribute === "function") {
    textarea.setAttribute("readonly", "");
  }
  // Off-screen, not `display: none` -- see this module's top doc comment:
  // a hidden element can't be select()ed, which execCommand("copy") needs.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  d.body.appendChild(textarea);

  let ok = false;
  try {
    if (typeof textarea.focus === "function") {
      textarea.focus();
    }
    if (typeof textarea.select === "function") {
      textarea.select();
    }
    if (typeof textarea.setSelectionRange === "function") {
      textarea.setSelectionRange(0, str.length);
    }
    // Deprecated, but the only copy mechanism that works on an insecure
    // origin -- `navigator.clipboard` doesn't exist there at all, which is
    // precisely the case this fallback is for. Don't replace this call.
    ok = typeof d.execCommand === "function" && !!d.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    if (typeof textarea.remove === "function") {
      textarea.remove();
    } else if (typeof d.body.removeChild === "function") {
      d.body.removeChild(textarea);
    }
    if (previousActive) {
      previousActive.focus();
    }
    if (sel && savedRange) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }

  return ok ? { ok: true } : { ok: false, message: FALLBACK_UNAVAILABLE_MESSAGE };
}
