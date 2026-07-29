/**
 * Rule Builder — extension entry point.
 *
 * Registers a global command ("AnimaFlow: Rule Builder") that opens the
 * full-screen Rule Builder overlay (`overlay.mjs`), and re-exports
 * `openRuleBuilder(ctx)` so an encode node's "Open Rule Builder" button
 * (Track A — `nodes/prompt_rules.py` + its own `js/` extension) can call it
 * directly with a context object (see `overlay.mjs`'s `RuleBuilderCtx`
 * doc comment) instead of going through the command palette.
 *
 * `app.registerExtension({ commands, keybindings })` is the same
 * cross-renderer mechanism ComfyUI-Pixaroma uses for its own keybound
 * actions (see `js/node_colors/index.js`'s "\\" shortcut) — it works in
 * BOTH the legacy litegraph canvas (this pack's target renderer) and the
 * newer Vue frontend, surfacing in the command
 * palette / Settings → Keybindings regardless of which renderer is active.
 *
 * VERIFY-IN-COMFYUI (Slice 5, 2026-07-29 — sharpened from a vaguer note,
 * not resolved; still cannot be confirmed headlessly): in a LIVE ComfyUI
 * running this pack, do exactly this ONE check — open the command palette
 * (default binding, or Settings → Keybindings, and search for
 * "AnimaFlow: Rule Builder"). Two possible outcomes:
 *   - It appears and running it opens the overlay → `commands` is reachable;
 *     nothing further to do, this marker can finally be deleted.
 *   - It does NOT appear anywhere (this ComfyUI build's command palette
 *     doesn't surface `commands`-registered entries at all, or only the
 *     Vue frontend's palette does and this install is on legacy litegraph)
 *     → `commands`/`keybindings` below are latent, unreachable dead code,
 *     and the toolbar button `mountToolbarButton` installs (below) is the
 *     ONLY affordance a user actually has to open the Rule Builder. In that
 *     case, say so when this marker is finally addressed, and prefer
 *     DELETING the `commands` registration over leaving unreachable code
 *     around — don't just leave this comment as permanent lore.
 */
import { app } from "/scripts/app.js";
import { openRuleBuilder as openOverlay } from "./overlay.mjs";

// Renamed from "Webtoon.OpenRuleBuilder" (Slice 5, owner-approved rename of
// every user-visible "Webtoon" leftover in this file). This id is a
// PERSISTENCE KEY -- ComfyUI stores a user's keybinding against it in
// Settings → Keybindings, the same hazard `docs/settings.md` documents for
// a settings id. Renaming it means any keybinding a user already bound to
// the OLD id is silently dropped (they'd need to re-bind it to this new
// one) -- accepted deliberately here since the owner wants the stale name
// gone, but recording it so this isn't rediscovered as a "regression" later.
const COMMAND_ID = "AnimaFlow.OpenRuleBuilder";

app.registerExtension({
  // `name` is DELIBERATELY left as "webtoon.rule_builder" -- every entry
  // point in this pack shares this exact "webtoon.<track>" extension-name
  // convention (`js/anima/index.js`, `js/autocomplete/index.js`,
  // `js/controls/index.js`, `js/prompt_rules/node/index.js` all do the
  // same), and it's a SEPARATE persistence key from `COMMAND_ID` above (a
  // user's per-extension enable/disable choice in ComfyUI keys off THIS
  // string). Renaming just this one track's name would both break that
  // pack-wide consistency and silently reset anyone who had disabled this
  // extension specifically -- out of scope for this rename, which the task
  // brief scoped to the user-visible command label + CSS classes + the
  // command id, not this.
  name: "webtoon.rule_builder",
  commands: [
    { id: COMMAND_ID, label: "AnimaFlow: Rule Builder", function: () => openOverlay() },
  ],
});

// Icon-only glyph for the toolbar button — a "checklist" (list-with-checks)
// outline, rendered as a CSS mask so it tints with the button's `color`
// (see `injectToolbarCSS` below). No server asset route exists in this pack
// (unlike ComfyUI-Pixaroma's `/pixaroma/assets/icons/...`), so this is an
// inline data URI instead of a served file — `<`/`>` are percent-encoded
// (`%3C`/`%3E`) so the URL survives being embedded in a CSS `url(...)`.
// Verified parseable: `new URL(...)` succeeds and `decodeURIComponent` of the
// payload round-trips to well-formed, balanced-tag SVG markup.
const TOOLBAR_ICON_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M9 6h11M9 12h11M9 18h11'/%3E%3Cpath d='M4 6l1.5 1.5L8 5'/%3E%3Cpath d='M4 12l1.5 1.5L8 11'/%3E%3Cpath d='M4 18l1.5 1.5L8 17'/%3E%3C/svg%3E";

const TOOLBAR_CSS_ID = "wtn-rb-toolbar-css";
// Local, scoped CSS for this one toolbar button — deliberately NOT routed
// through `js/shared/theme.css` (that stylesheet's `--wtn-*` custom
// properties are scoped under a `.wtn` root class, which this button — a
// child of ComfyUI's own top action bar — never gets). Colors below are the
// house teal accent, hardcoded to match `--wtn-accent` (#2dd4bf) /
// `--wtn-accent-deep` (#14b8a6) so it still reads as "ours" without leaking
// theme.css into ComfyUI's toolbar DOM. Mirrors the local
// `injectToolbarCSS()` + `<style id>` guard pattern this file already uses
// (see `overlay.mjs`'s `injectOverlayCss` for the sibling convention).
function injectToolbarCSS() {
  if (document.getElementById(TOOLBAR_CSS_ID)) return;
  const style = document.createElement("style");
  style.id = TOOLBAR_CSS_ID;
  style.textContent = `
    .wtn-rb-toolbar-btn .wtn-rb-toolbar-icon {
      display: inline-block;
      width: 18px;
      height: 18px;
      background-color: currentColor;
      mask-image: url("${TOOLBAR_ICON_SVG}");
      -webkit-mask-image: url("${TOOLBAR_ICON_SVG}");
      mask-size: contain;
      -webkit-mask-size: contain;
      mask-repeat: no-repeat;
      -webkit-mask-repeat: no-repeat;
      mask-position: center;
      -webkit-mask-position: center;
      pointer-events: none;
    }
    .wtn-rb-toolbar-btn:hover,
    .wtn-rb-toolbar-btn:focus-visible {
      background-color: rgba(45, 212, 191, 0.16) !important;
      color: #2dd4bf !important;
      border-color: #14b8a6 !important;
    }
    .wtn-rb-toolbar-btn:focus-visible {
      outline: 2px solid #2dd4bf;
      outline-offset: 1px;
    }
  `;
  document.head.appendChild(style);
}

// Best-effort toolbar button (Vue frontend only — `app.menu` doesn't exist
// under legacy litegraph, so this quietly gives up after a few retries and
// the command-palette entry above remains the reliable way in). Mirrors
// ComfyUI-Pixaroma's `js/align/index.js` toolbar-mount pattern: an icon-only
// button (tooltip via `title`/`aria-label`, house teal instead of Pixaroma's
// orange) wrapped in its own `.comfyui-button-group`, inserted before the
// settings group so it sits flush with the native/rgthree toolbar groups.
function mountToolbarButton(tries = 0) {
  const settingsGroupEl = app.menu?.settingsGroup?.element;
  if (!settingsGroupEl) {
    if (tries > 20) return;
    setTimeout(() => mountToolbarButton(tries + 1), 250);
    return;
  }
  // The dedupe guard queries for the BUTTON's own attribute, not the group
  // wrapper — the button is now nested one level deeper inside a
  // `.comfyui-button-group` div.
  if (document.querySelector('[data-wtn-rb-toolbar-btn="1"]')) return;

  injectToolbarCSS();

  const btn = document.createElement("button");
  btn.className = "comfyui-button wtn-rb-toolbar-btn";
  btn.dataset.wtnRbToolbarBtn = "1";
  btn.title = "Open the AnimaFlow Rule Builder";
  btn.setAttribute("aria-label", "Open the AnimaFlow Rule Builder");
  btn.innerHTML = '<span class="wtn-rb-toolbar-icon"></span>';
  btn.addEventListener("click", () => openOverlay());

  const group = document.createElement("div");
  group.className = "comfyui-button-group wtn-rb-toolbar-group";
  group.appendChild(btn);

  settingsGroupEl.before(group);
}
mountToolbarButton();

/**
 * Opens the Rule Builder overlay. See `overlay.mjs`'s `RuleBuilderCtx` doc
 * comment for the optional `ctx` shape (sheet vs embedded mode, initial
 * profile/prompts, `onApply`/`onClose` callbacks).
 *
 * @param {import("./overlay.mjs").RuleBuilderCtx} [ctx]
 */
export function openRuleBuilder(ctx) {
  return openOverlay(ctx);
}
