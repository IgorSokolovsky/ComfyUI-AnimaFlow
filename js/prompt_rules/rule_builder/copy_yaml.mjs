/**
 * copy_yaml.mjs — the Export YAML pane's "Copy" button wiring, split out of
 * `overlay.mjs` into its own tiny module so it's plain-`node` testable.
 *
 * `overlay.mjs` itself imports `theme.mjs`/`api.mjs` via absolute
 * `/extensions/ComfyUI-AnimaFlow/...` paths that only resolve inside a
 * running ComfyUI page (see that file's own "VERIFY-IN-COMFYUI" doc
 * comment) -- importing `overlay.mjs` at all from a plain-`node` test
 * throws `ERR_MODULE_NOT_FOUND` before a single test runs, which is why no
 * rule-builder test suite existed before this. This module has no such
 * import (only a relative one into `js/shared/clipboard.mjs`), so it's
 * importable and testable standalone; `test_overlay.mjs` covers it.
 *
 * ## Why this exists (owner-reported, 2026-08-04)
 *
 * "Copy seed" (`js/anima/history.mjs`) failed silently on an insecure
 * origin (plain `http://`, e.g. a pinggy tunnel or a bare LAN IP) --
 * `navigator.clipboard` doesn't exist there at all. This pane's own "Copy
 * YAML" button had the SAME root cause, but worse: its `catch` block
 * silently swallowed the failure, so a failed copy looked IDENTICAL to a
 * successful one -- the worst of this pack's three hand-rolled copy paths.
 * Goes through the shared `js/shared/clipboard.mjs` helper now, which adds
 * the insecure-origin textarea/`execCommand` fallback that fixes the actual
 * bug, and always reports which outcome happened.
 */
import { copyToClipboard } from "../../shared/clipboard.mjs";

/**
 * Copies `yamlText` and reports the outcome directly on `copyBtn`'s own
 * text -- this pane has no separate status/toast area, so it reuses the
 * button's pre-existing "Copied ✓" -> revert-after-timeout idiom for BOTH
 * outcomes, rather than inventing a new one. Returns the `{ok, message}`
 * result too, for a caller (or test) that wants it directly.
 */
export async function copyYamlToClipboard(copyBtn, yamlText, doc) {
  const result = await copyToClipboard(yamlText, doc);
  if (result.ok) {
    copyBtn.textContent = "Copied ✓";
    copyBtn.title = "";
  } else {
    copyBtn.textContent = "Copy failed";
    copyBtn.title = result.message || "Couldn't copy automatically.";
  }
  setTimeout(() => {
    copyBtn.textContent = "Copy";
    copyBtn.title = "";
  }, 1400);
  return result;
}
