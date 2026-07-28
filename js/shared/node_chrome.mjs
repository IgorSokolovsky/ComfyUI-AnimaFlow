/**
 * node_chrome.mjs — the single "paint this litegraph NODE ITSELF (body +
 * title-bar strip) in our theme" mechanism shared by every track that wants
 * the dark DOM panel/rows to sit on our own dark node chrome instead of
 * ComfyUI's lighter default. Extracted from `js/controls/render.mjs`'s
 * `applyNodeChrome` while wiring up `js/anima/` — same reasoning
 * `js/shared/overlay.mjs`'s top doc comment gives for its own extraction:
 * one implementation, not a fork, so the palette decision can't drift
 * between tracks. Controls keeps using it via a thin re-export in its own
 * `render.mjs` (see that file), so there is exactly one place this logic
 * lives.
 *
 * Mirrors `../ComfyUI-Pixaroma/js/note/render.mjs`'s `renderContent` (see
 * its top doc comment, lines ~66-113, for the exact reasoning this ports):
 * litegraph SERIALIZES `node.color`/`node.bgcolor` into the saved workflow
 * the moment either is set (by us, OR by the user's own right-click ->
 * Colors pick), so `applyNodeChrome` below only ever fills in a still-null
 * value — it must NEVER overwrite one that's already set, or it would
 * silently clobber a user's explicit choice every time it runs.
 *
 * `TOKENS.surface`/`TOKENS.console` (this module's single source of truth
 * for the palette, mirroring `js/shared/theme.mjs`, which this module
 * imports directly — no hardcoded-fallback mirror needed here since, unlike
 * `render.mjs`'s CSS strings, nothing here needs a `var(--wtn-x, #fallback)`
 * shape or an absolute cross-package import path) are exported as
 * `CHROME_BODY`/`CHROME_TITLE` for anything that wants the raw hex without
 * pulling in a whole node/DOM stub. The title-bar uses `TOKENS.console` (the
 * same inset "field background" token as every DOM-widget row's own
 * fields), not `TOKENS.surface2` — the header reads as the darkest band on
 * the node, matching the field background, rather than the brightest.
 *
 * Callers must apply this ONLY from the fresh-node path (`onNodeCreated`),
 * never the restore path (`onConfigure`) — loading a clean, unmodified
 * workflow must never come up looking "modified". See each track's own
 * `index.js` call site (`js/controls/index.js`'s `!node._ctrlConfiguring`
 * guard, `js/anima/index.js`'s `!node._anConfiguring` guard) for how that
 * distinction is actually made at the call site; this module itself has no
 * opinion on fresh-vs-restore, it just paints unconditionally whenever
 * it's called.
 */
import { TOKENS } from "./theme.mjs";

export const CHROME_BODY = TOKENS.surface;
export const CHROME_TITLE = TOKENS.console;

export function applyNodeChrome(node) {
  if (!node) {
    return;
  }
  if (node.bgcolor == null) {
    node.bgcolor = CHROME_BODY;
  }
  if (node.color == null) {
    node.color = CHROME_TITLE;
  }
}
