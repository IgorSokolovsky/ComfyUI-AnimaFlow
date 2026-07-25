/**
 * Rule Builder — extension entry point.
 *
 * Registers a global command ("Webtoon: Rule Builder") that opens the
 * full-screen Rule Builder overlay (`overlay.mjs`), and re-exports
 * `openRuleBuilder(ctx)` so an encode node's "Open Rule Builder" button
 * (Track A — `nodes/prompt_rules.py` + its own `js/` extension) can call it
 * directly with a context object (see `overlay.mjs`'s `RuleBuilderCtx`
 * doc comment) instead of going through the command palette.
 *
 * `app.registerExtension({ commands, keybindings })` is the same
 * cross-renderer mechanism ComfyUI-Pixaroma uses for its own keybound
 * actions (see `js/node_colors/index.js`'s "\\" shortcut) — it works in
 * BOTH the legacy litegraph canvas (this pack's target renderer, per
 * `.claude/CLAUDE.md`) and the newer Vue frontend, surfacing in the command
 * palette / Settings → Keybindings regardless of which renderer is active.
 *
 * VERIFY-IN-COMFYUI: confirm `commands` actually appears somewhere a user
 * will find it in THIS ComfyUI build (command palette / keybinding list) —
 * the best-effort toolbar-button mount below is a Vue-frontend-only nicety
 * (`app.menu.settingsGroup`; see ComfyUI-Pixaroma's `js/align/index.js`) and
 * is expected to silently no-op under legacy litegraph.
 */
import { app } from "/scripts/app.js";
import { openRuleBuilder as openOverlay } from "./overlay.mjs";

const COMMAND_ID = "Webtoon.OpenRuleBuilder";

app.registerExtension({
  name: "webtoon.rule_builder",
  commands: [
    { id: COMMAND_ID, label: "Webtoon: Rule Builder", function: () => openOverlay() },
  ],
});

// Best-effort toolbar button (Vue frontend only — `app.menu` doesn't exist
// under legacy litegraph, so this quietly gives up after a few retries and
// the command-palette entry above remains the reliable way in). Mirrors
// ComfyUI-Pixaroma's `js/align/index.js` toolbar-mount pattern.
function mountToolbarButton(tries = 0) {
  const settingsGroupEl = app.menu?.settingsGroup?.element;
  if (!settingsGroupEl) {
    if (tries > 20) return;
    setTimeout(() => mountToolbarButton(tries + 1), 250);
    return;
  }
  if (document.querySelector('[data-webtoon-rule-builder-btn="1"]')) return;
  const btn = document.createElement("button");
  btn.className = "comfyui-button";
  btn.dataset.webtoonRuleBuilderBtn = "1";
  btn.title = "Open the Webtoon Rule Builder";
  btn.textContent = "Rule Builder";
  btn.addEventListener("click", () => openOverlay());
  settingsGroupEl.before(btn);
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
