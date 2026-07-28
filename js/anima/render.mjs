/**
 * render.mjs — DOM building + injected CSS for `AnimaGenerator` /
 * `AnimaPreview` (`docs/generator-design.md` §5/§7). Pure DOM construction
 * and painting only — no event listeners (`interaction.mjs` wires those) and
 * no `node`/`app`/`LiteGraph` reference, so this module is importable by the
 * headless `test_resize.mjs` under plain `node` via a small doc stub,
 * matching every other DOM-widget node in this pack.
 *
 * ## Architecture (2026-07-28 rewrite): ONE scrollable panel, not one DOM
 * widget per section growing without limit
 *
 * The whole body — every section, every stage row — now lives inside a
 * single bordered `.wtn-an-panel` (one child of the DOM widget's root),
 * modelled on upstream's AiO generator panel
 * (`../ComfyUI-EasyUseAnima/web/js/aio/generator_panel_runtime.js`).
 *
 * **2026-07-28 reversal (this dispatch): the panel FILLS the node, the node
 * is the user's to resize.** The original cut here gave the panel a fixed
 * `[PANEL_MIN_H, PANEL_MAX_H]` content range and had the NODE auto-fit to
 * it (`refitNode`/`scheduleRefit`, now deleted). The user asked for the
 * opposite relationship: drag the node taller and the panel gets taller
 * with it; drag it shorter and the panel shrinks and scrolls internally
 * (`overflow-y: auto`, unchanged). So `.wtn-an-panel` is now `flex: 1 1
 * auto` — the sole flex child of `.wtn-an-root`'s column, it stretches to
 * fill whatever height the node (hence the DOM widget's root) currently is
 * — with only a `min-height`/`PANEL_MIN_H` FLOOR, no ceiling at all.
 * `measureMinHeight` below reports that floor to litegraph's `getMinHeight`/
 * `computeLayoutSize` so the node can't be dragged unusably small; it never
 * reports anything else, so there is nothing left in this file that could
 * grow OR shrink `node.size` on a repaint or a workflow load — see this
 * module's "Resize" section for the full mechanism.
 *
 * **2026-07-28, LATER the same day — the Preview's panel carves out an
 * exception to "scrolls internally": it never scrolls at all.** Everything
 * just above is still exactly how `.wtn-an-panel`/`GENERATOR` behaves. For
 * the Preview specifically, `.wtn-an-panel-pv` (a modifier class,
 * `buildPanelShell(doc, {preview: true})` below, applied ONLY by
 * `mountPreviewUI`) overrides BOTH the scrollbar (`overflow: hidden`) and
 * the floor (its own `PREVIEW_PANEL_MIN_H`, not `PANEL_MIN_H`) — see that
 * class's own CSS comment (this file's "Preview node: hover wipe" section)
 * and `PREVIEW_PANEL_MIN_H`'s own doc comment (this file's "Resize"
 * section) for why that's safe: the floor is sized generously enough that
 * there is never anything left to scroll in the first place.
 *
 * The body is still rebuilt in full on every discrete action (see the old
 * version of this file's doc comment, carried forward): toggling a stage,
 * expanding/collapsing a section, editing a field, adding a detailer block
 * all replace `.wtn-an-panel`'s children wholesale via `interaction.mjs`'s
 * `repaintGenerator`/`repaintPreview`.
 *
 * ## 2026-07-28 reversal (inline-sections dispatch, `docs/generator-
 * design.md` §12) — settings expand IN PLACE, no more floating popover
 *
 * This is the FOURTH iteration on where a setting lives: modal → right-side
 * drawer → a popover anchored to the row you clicked → this. The popover
 * (`js/shared/overlay.mjs`'s `openOverlayWithZoom`, a separate DOM subtree
 * appended to `document.body` so a body rebuild never disturbed an open
 * popover — see this section's own history in git blame) is GONE from this
 * track entirely: every section (Sampler, Mod Guidance, Highres, Detailer,
 * Upscale, Postprocess on the Generator; Save on the Preview) is now a
 * clickable HEADER living directly inside `.wtn-an-panel`, and its fields
 * render inline in a `.wtn-an-sbody` directly below that header when
 * expanded — `buildSectionHeader` below is the whole shape (chevron, name,
 * optional muted summary, optional ⓘ, optional enable switch). Because
 * there is no separate floating layer to protect any more, a section
 * toggling open/closed is just another full-body repaint like every other
 * action already was — no `refresh()`-this-popover-only special case is
 * needed (`interaction.mjs` no longer imports `js/shared/overlay.mjs` at
 * all; `js/controls/` is the overlay module's only remaining consumer).
 * `buildPopoverShell`/`buildClickRow` (the popover's chrome + the
 * click-a-row-to-open-it row) and `buildNote` (a text-block explanation,
 * replaced by the ⓘ affordance below) are DELETED, not left unreferenced.
 *
 * ## Context-supplied fields render DISABLED, with a yellow ⓘ, not a
 * separate "driven" row
 *
 * `seed`/`steps`/`cfg`/`sampler_name`/`scheduler` are still each
 * independently overridable (design doc §5a), but there is no more "wired
 * socket on the Generator" to check — the signal is "did the
 * `AnimaContextBridge` upstream of `context` have THAT socket wired"
 * (`interaction.mjs`'s `computeContextSupplied`, walking the real litegraph
 * link). Previously a supplied field rendered as `buildDrivenField` (a
 * static "driven by the Context Bridge" text row with no value at all,
 * `js/shared/fields.mjs`, now deleted) — an editable-LOOKING number that
 * silently discards edits is the exact trap this reversal (and §5a/§6b
 * before it) argue against, so this dispatch goes one step further than
 * "not editable": `buildNumericField`/`buildStepperField` (still `../shared/
 * fields.mjs`, unchanged) already accept a `disabledReason`, which renders
 * the SAME field shape — same value on display, same layout — just
 * genuinely inert (no drag, no cycle) and titled with the reason. This
 * module pairs that with `js/shared/fields.mjs`'s `buildInfoIcon(doc,
 * tooltip, warn)`, `warn: true`, next to the field — the yellow the task
 * asked for is `--wtn-warn`, the theme's own warn token, not invented here.
 * The VALUE shown is this settings tree's own value (`sampler.seed` etc,
 * exactly what an editable render would show) — this frontend cannot see
 * inside the bridge's own execution-time output at graph-edit time (design
 * doc's own admission, unchanged by this dispatch), so rather than
 * guess at whatever node feeds the bridge's wired socket, the tooltip says
 * plainly that the number on screen may be overridden at run time.
 *
 * ## This module owns only small presentational builders — section BODIES
 * (which fields exist, in what order, wired to what) live in
 * `interaction.mjs`
 *
 * Same split as before: `interaction.mjs`'s `buildXSection` functions build
 * a section's inline content using the small field builders THIS module
 * exports (`buildTextField`/`buildBoolField` locally, `js/shared/fields.mjs`'s
 * `buildNumericField`/`buildStepperField`/`buildSwitch`/`buildInfoIcon`
 * re-exported from here). Free-text fields (`detect_prompt`, `filename`,
 * `path`, …) have no Control Panel analogue, so `buildTextField` stays local
 * to this module.
 *
 * ## Wheel: scroll the panel when it has room, zoom the canvas otherwise
 *
 * This is `js/shared/canvas_zoom.mjs`'s job, unchanged — `index.js` installs
 * `installCanvasZoomPassthrough` on the DOM widget's ROOT (not the panel),
 * and that module's `scrollRegionWantsWheel` already walks from the wheel
 * event's target up to the root looking for a genuinely scrollable ancestor
 * with room in the wheel's own direction — `.wtn-an-panel`'s `overflow-y:
 * auto` is exactly such an ancestor whenever its content overflows the
 * panel's own current height. No bespoke "is this scrollable" check is
 * written here.
 *
 * ## Real sockets are litegraph's, never re-drawn in this body
 *
 * `AnimaGenerator` has exactly two real inputs now (`context`,
 * `generation_settings`, the latter hidden) and three outputs (`images`,
 * `latent`, `metadata_json`); `AnimaPreview` has `images`/`metadata_json`
 * (both optional) plus the hidden, non-socket `prompt`/`extra_pnginfo`.
 * Litegraph draws every one of those itself, independent of this DOM
 * widget — this module never re-draws a row per socket name.
 *
 * ## Importing `theme.mjs` — GUARDED dynamic import
 *
 * Same reasoning as every other node's `render.mjs` in this pack: this file
 * is imported directly by the headless `test_resize.mjs`, so a static
 * top-level import of the absolute `/extensions/.../theme.mjs` path would
 * throw `ERR_MODULE_NOT_FOUND` before a single assertion runs. This
 * module's own CSS carries `var(--wtn-x, <hardcoded fallback hex>)`
 * everywhere, so styling is correct whether or not the shared stylesheet
 * import lands in time.
 */

import { MAX_DETAILER_PASSES, isBuiltinDetailerBlock } from "./state.mjs";
import { injectFieldStyles, buildSwitch, buildInfoIcon } from "../shared/fields.mjs";
// Re-exported below (never redefined here) so `index.js` can reach it as
// `mods.render.applyNodeChrome`, matching every other lazily-loaded helper
// it calls -- see `../shared/node_chrome.mjs`'s own doc comment for the full
// constraints (single implementation shared with `js/controls/render.mjs`,
// never-stomp-an-explicit-colour, fresh-node-path-only).
import { applyNodeChrome, CHROME_BODY, CHROME_TITLE } from "../shared/node_chrome.mjs";

const STYLE_ID = "wtn-anima-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly (see this module's doc
// comment for why these are hardcoded fallbacks rather than an import).
const TOKENS = {
  surface: "#151a21",
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

const CSS = `
.wtn-an-root { display: flex; flex-direction: column; gap: 0; width: 100%; box-sizing: border-box;
  padding: 4px 2px 2px; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--wtn-ink, ${TOKENS.ink});
  /* NO height:100% / min-height here -- the ComfyUI-Pixaroma find_replace pattern. */
}
.wtn-an-root, .wtn-an-root * { box-sizing: border-box; }

/* ── the one bordered, scrollable panel -- see this module's top doc
   comment. \`flex: 1 1 auto\` is the fill mechanism: as the sole flex child
   of \`.wtn-an-root\`'s column, this stretches to whatever height the node
   currently is. \`min-height\` is the ONLY bound -- a floor, matched by
   PANEL_MIN_H below (measureMinHeight's deterministic, testable half of the
   same floor) -- deliberately NO max-height: dragging the node taller must
   make this taller too, with no ceiling. Shrink the node below its content
   and this scrolls internally (\`overflow-y: auto\`) rather than spill.
   This is the GENERATOR's behaviour (and the shared default for both node
   types) -- the Preview overrides both the scrollbar and the floor via
   \`.wtn-an-panel-pv\` below (this file's "Preview node: hover wipe"
   section), it does not scroll at all. ── */
.wtn-an-panel { display: flex; flex-direction: column; gap: 4px; padding: 6px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 8px;
  background: var(--wtn-surface, ${TOKENS.surface});
  flex: 1 1 auto; min-height: 220px; overflow-y: auto; overflow-x: hidden; }

.wtn-an-sec { font-family: var(--wtn-font-mono, monospace); font-size: 9px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  margin: 9px 0 4px; display: flex; align-items: center; gap: 7px; }
.wtn-an-sec::after { content: ""; flex: 1; height: 1px; background: var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-an-sec:first-child { margin-top: 2px; }
.wtn-an-sec .wtn-an-cnt { color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

/* ── expandable SECTION header (2026-07-28 inline-sections dispatch) --
   replaces every popover-opening row this track used to have.

   **NO-JUMP INVARIANT (2026-07-28, wheel/header-order dispatch) -- DOM
   order is FIXED: chevron -> switch (if any) -> label -> ⓘ (if any) ->
   summary. Every one of those first four is \`flex: none\` (pinned,
   never resized); the summary is the ONLY element with \`margin-left:
   auto\` + ellipsis (\`overflow: hidden; text-overflow: ellipsis;
   white-space: nowrap; min-width: 0\`), so it is the ONLY thing whose
   width ever varies, and it varies into the empty space on the right --
   nothing else ever shifts position when a section is turned on/off or
   its summary text changes length. Do NOT reorder these back to
   chevron/label/summary/ⓘ/switch (the pre-dispatch order): that let the
   ⓘ and the switch slide left/right depending on whether a summary
   existed, which read as the row jittering every time "enabled" flipped.
   If you add a new header child, decide up front whether it's a FIXED
   affordance (append it before the summary, \`flex: none\`) or content
   that should ellipsize (there should only ever be one of those: the
   summary).**

   As of the inline-sections-expand-is-the-switch's-job dispatch (this same
   day, later), clicking \`.wtn-an-shead\` itself only toggles expand/collapse
   for a SWITCHLESS section (Sampler) -- see \`interaction.mjs\`'s
   \`buildSection\` for the split. The switch's own click (stopPropagation'd)
   now flips BOTH \`enabled\` and expand/collapse together for every section
   that has one. The ⓘ's click is always stopPropagation'd only, on both
   kinds of section -- it never toggles anything. \`.wtn-an-expanded\` is
   purely a hook for the chevron glyph/hover state -- the actual body is a
   SIBLING element (\`.wtn-an-sbody\`) that simply isn't rendered at all while
   collapsed, not a max-height: 0 hide. ── */
.wtn-an-shead { position: relative; display: flex; align-items: center; gap: 8px; height: 27px;
  margin-bottom: 4px; padding: 0 8px; border-radius: 6px; cursor: pointer;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  overflow: hidden; }
.wtn-an-shead:hover { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-an-shead.wtn-an-expanded { border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-shead .wtn-an-chev { flex: none; width: 10px; font-size: 9px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-an-shead .wtn-an-shead-nm { font-size: 11.5px; font-weight: 550; flex: none; white-space: nowrap; }
.wtn-an-shead .wtn-an-shead-sum { margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 9.5px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.wtn-an-shead.wtn-an-dep { border-color: rgba(251,191,36,.35); }

/* ── section body -- rendered only while its header is expanded. Indented
   under the chevron so the nesting reads clearly while the panel scrolls. ── */
.wtn-an-sbody { display: flex; flex-direction: column; gap: 4px; padding: 2px 4px 8px 20px; }

/* ── a field paired with its own ⓘ (context-supplied warning, or a plain
   note) -- see this module's top doc comment. The field itself keeps its
   own bottom margin off (the wrapper owns the spacing) so pairing an icon
   never doubles the gap between rows. ── */
.wtn-an-fieldrow { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.wtn-an-fieldrow > *:first-child { flex: 1; min-width: 0; margin-bottom: 0; }

/* ── free-text field (no Control Panel analogue -- see this module's top
   doc comment) ── */
.wtn-an-field { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin-bottom: 2px; }
.wtn-an-field > span { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); width: 116px; flex: none; }
.wtn-an-field input { flex: 1; min-width: 0; font-family: var(--wtn-font-mono, monospace);
  font-size: 11px; color: var(--wtn-ink, ${TOKENS.ink}); background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 5px; padding: 4px 6px; outline: none; }
.wtn-an-field input:focus { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

/* ── boolean field: label + shared pill switch ── */
.wtn-an-boolfield { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin-bottom: 4px; }
.wtn-an-boolfield > span:first-child { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-an-boolfield > span:last-child { margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 10.5px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }

.wtn-an-sublab { font-family: var(--wtn-font-mono, monospace); font-size: 9px; letter-spacing: .13em; text-transform: uppercase;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin: 12px 0 7px; padding-top: 10px; border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  display: flex; align-items: center; gap: 6px; }
.wtn-an-sublab:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.wtn-an-missing { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  padding: 9px 10px; border-radius: 8px; margin-bottom: 11px; background: rgba(251,191,36,.06); border: 1px solid rgba(251,191,36,.28); }
.wtn-an-passtabs { display: flex; gap: 5px; margin-bottom: 11px; flex-wrap: wrap; }
.wtn-an-passtabs button { font-family: var(--wtn-font-mono, monospace); font-size: 10px; padding: 4px 9px; cursor: pointer;
  border-radius: 6px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); background: var(--wtn-surface-2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); }
.wtn-an-passtabs button.wtn-an-on { background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-passtabs button:disabled { opacity: .4; cursor: default; }

/* ── Preview node: hover wipe ──
   2026-07-28, LATER the same day -- REVERSES the aspect-ratio call this
   file's own panel-fills-the-node dispatch just made a few lines above
   ("the wipe keeps its OWN size... aspect-ratio: 1/1... a node too short
   scrolls, image included"). This IS an image-comparison node -- the
   compare image is the entire point of placing it, everything else (Save,
   the compare picker) is secondary chrome around it -- so the user asked
   for the opposite: the image area fills whatever height the node is, and
   the panel never scrolls it out of view. \`.wtn-an-panel-pv\` (this file's
   panel-shell modifier -- \`buildPanelShell(doc, {preview: true})\`, applied
   ONLY by \`mountPreviewUI\`; the Generator's panel is untouched by any of
   this) carries the reversal: \`.wtn-an-panel-pv .wtn-an-wipe\` cancels the
   \`aspect-ratio: 1/1\` above (\`aspect-ratio: auto\`) and flex-fills
   (\`flex: 1 1 auto\`, floored at \`PREVIEW_IMG_MIN_H\`) whatever height
   \`.wtn-an-panel-pv > .wtn-an-body\` has left once the Save section and the
   compare row below take their own natural height (\`flex: none\`, the
   rule after this one). A non-square wipe does NOT distort either image --
   \`.wtn-an-layer img\`'s \`object-fit: contain\` (below, unchanged) already
   letterboxes each layer to whatever box it's given, square or not -- so
   this costs nothing visually, only gains the image actually using the
   space a resize gave it. \`.wtn-an-panel-pv\` also drops the panel's own
   scrollbar (\`overflow: hidden\`, not \`overflow-y: auto\`) with its OWN,
   much taller floor, \`PREVIEW_PANEL_MIN_H\` (this file's "Resize" section
   has the arithmetic) -- sized so the Save section fully EXPANDED plus the
   compare row plus \`PREVIEW_IMG_MIN_H\` always fit with room to spare, so
   there is never anything left TO scroll; unlike the Generator, this node
   has no "shrink below content, scroll internally" escape hatch at all. */
.wtn-an-wipe { position: relative; width: 100%; aspect-ratio: 1/1; overflow: hidden; border-radius: 8px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); background: var(--wtn-console, ${TOKENS.console});
  cursor: col-resize; touch-action: none; }
.wtn-an-wipe.wtn-an-single { cursor: default; }
.wtn-an-wipe .wtn-an-layer { position: absolute; inset: 0; }
.wtn-an-wipe .wtn-an-layer img { width: 100%; height: 100%; object-fit: contain; display: block; }
.wtn-an-wipe .wtn-an-layer.wtn-an-b { clip-path: inset(0 0 0 var(--wipe-x, 50%)); }
.wtn-an-wipe .wtn-an-divider { position: absolute; top: 0; bottom: 0; left: var(--wipe-x, 50%); width: 1px;
  background: var(--wtn-accent, ${TOKENS.accent}); box-shadow: 0 0 10px rgba(45,212,191,.8); pointer-events: none; }
.wtn-an-wipe .wtn-an-plab { position: absolute; top: 7px; font-family: var(--wtn-font-mono, monospace); font-size: 9px;
  padding: 2px 6px; border-radius: 4px; background: rgba(10,13,18,.82); border: 1px solid var(--wtn-line, ${TOKENS.line});
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); pointer-events: none; }
.wtn-an-wipe .wtn-an-plab.wtn-an-l { left: 7px; }
.wtn-an-wipe .wtn-an-plab.wtn-an-r { right: 7px; }
.wtn-an-wipe .wtn-an-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 11px; }

/* ── Preview-only panel modifier -- see the "Preview node: hover wipe"
   comment above for the reversal this carries. \`.wtn-an-panel\` (two
   classes, for specificity over the shared rule regardless of source
   order) overrides the shared scrollbar/floor; the \`> .wtn-an-body\`
   rule turns the body into its own flex column so the wipe below can
   flex-fill it (\`min-height: 0\` is what lets a flex child shrink below
   its content -- without it the wipe could never give height back to a
   shrinking node); the universal \`> *\` rule floors the Save section and
   the compare row at their natural height, and the more specific
   \`.wtn-an-wipe\` rule after it (same specificity, later in the sheet --
   the tie-break) is what lets the wipe alone override that back to
   flex-fill. ── */
.wtn-an-panel.wtn-an-panel-pv { overflow: hidden; min-height: 400px; }
.wtn-an-panel-pv > .wtn-an-body { display: flex; flex-direction: column; gap: 4px; flex: 1 1 auto; min-height: 0; }
.wtn-an-panel-pv > .wtn-an-body > * { flex: none; }
.wtn-an-panel-pv .wtn-an-wipe { flex: 1 1 auto; min-height: 160px; aspect-ratio: auto; }

.wtn-an-pvbar { display: flex; align-items: center; gap: 6px; margin: 7px 0 0; }
.wtn-an-pvlab { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtn-an-pvbar .wtn-an-segs { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.wtn-an-seg { display: flex; gap: 0; flex: none; }
.wtn-an-seg button { font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; padding: 3px 7px; cursor: pointer;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-right-width: 0; }
.wtn-an-seg button:first-child { border-radius: 5px 0 0 5px; }
.wtn-an-seg button:last-child { border-radius: 0 5px 5px 0; border-right-width: 1px; }
.wtn-an-seg button.wtn-an-on { background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); border-color: var(--wtn-accent, ${TOKENS.accent}); }
`;

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  injectFieldStyles(targetDoc);
  // Guarded dynamic import -- see this module's top doc comment.
  if (typeof document !== "undefined") {
    import(THEME_URL)
      .then((mod) => mod.injectTheme())
      .catch(() => {
        // No live ComfyUI server to serve this route -- non-fatal, this
        // module's own CSS already falls back to hardcoded hex values.
      });
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
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

function text(doc, tag, className, str) {
  const e = el(doc, tag, className);
  e.textContent = str;
  return e;
}

/** The panel shell -- ONE scrollable box (this module's top doc comment).
 * `root` is the DOM widget's actual root (what `index.js`'s `addDOMWidget`
 * mounts and what `installCanvasZoomPassthrough` installs on); `panel` is
 * the single bordered child every section/row lives inside -- scrollable
 * for the Generator, never for the Preview (see below).
 *
 * `{ preview: true }` adds `wtn-an-panel-pv` to `panel` -- the modifier
 * class that drops the scrollbar and swaps in the Preview's own, taller
 * floor (this file's "Preview node: hover wipe" CSS comment for the full
 * reversal). `mountPreviewUI` passes it; `mountGeneratorUI` calls this with
 * no second argument at all, so the Generator's panel is byte-identical to
 * before this option existed. */
export function buildPanelShell(doc, { preview } = {}) {
  const root = el(doc, "div", "wtn-an-root wtn");
  const panel = el(doc, "div", `wtn-an-panel${preview ? " wtn-an-panel-pv" : ""}`);
  root.appendChild(panel);
  return { root, panel };
}

// Re-exported so `interaction.mjs` has one import line for both the shared
// primitives and this module's own presentational builders.
export { buildSwitch, buildInfoIcon };

// ---------------------------------------------------------------------------
// Expandable section header -- 2026-07-28 inline-sections dispatch (this
// module's top doc comment). Purely presentational: `interaction.mjs` wires
// the header's own click (toggle expand) and the switch's own click (toggle
// enabled, `stopPropagation`ed so it never ALSO toggles expand).
// ---------------------------------------------------------------------------

/**
 * `spec`: `{ label, expanded, hasSwitch, switchOn, infoTooltip, infoWarn,
 * summary, dep }`. `dep` (matches the old `stageBlocked` styling) dims the
 * header via `.wtn-an-dep` when a required soft-import package is missing --
 * display only, never disables the switch itself (a user may install the
 * package later; the switch already tolerated this before this dispatch).
 *
 * **DOM child order is fixed: chevron -> switch (if any) -> label -> ⓘ (if
 * any) -> summary (if any)** -- see this file's `.wtn-an-shead` CSS comment
 * for the no-jump invariant this preserves (only the summary's width ever
 * varies, and only into empty space on the right; the other four never move
 * regardless of whether a switch/ⓘ/summary is present or how long the
 * summary text is). Returns `{ root, chev, sumEl, infoEl, switchEl }` -- any
 * of the optional three may be `null`.
 */
export function buildSectionHeader(doc, spec) {
  const { label, expanded, hasSwitch, switchOn, infoTooltip, infoWarn, summary, dep } = spec;
  const header = el(doc, "div", `wtn-an-shead${expanded ? " wtn-an-expanded" : ""}${dep ? " wtn-an-dep" : ""}`);
  const chev = el(doc, "span", "wtn-an-chev");
  chev.textContent = expanded ? "▾" : "▸";
  header.appendChild(chev);
  let switchEl = null;
  if (hasSwitch) {
    switchEl = buildSwitch(doc, !!switchOn);
    header.appendChild(switchEl);
  }
  const nm = el(doc, "span", "wtn-an-shead-nm");
  nm.textContent = label;
  header.appendChild(nm);
  let infoEl = null;
  if (infoTooltip) {
    infoEl = buildInfoIcon(doc, infoTooltip, infoWarn);
    header.appendChild(infoEl);
  }
  let sumEl = null;
  if (summary) {
    sumEl = el(doc, "span", "wtn-an-shead-sum");
    sumEl.textContent = summary;
    header.appendChild(sumEl);
  }
  return { root: header, chev, sumEl, infoEl, switchEl };
}

/** Wraps `fieldRoot` with a `js/shared/fields.mjs` `buildInfoIcon` beside it
 * when `tooltip` is truthy; returns `fieldRoot` UNWRAPPED otherwise, so a
 * field with nothing to say about itself doesn't grow an empty container.
 * `warn` selects the yellow `--wtn-warn` variant (context-supplied fields);
 * omit it for a plain informational note. */
export function withInfoIcon(doc, fieldRoot, tooltip, warn) {
  if (!tooltip) {
    return fieldRoot;
  }
  const wrap = el(doc, "div", "wtn-an-fieldrow");
  wrap.appendChild(fieldRoot);
  wrap.appendChild(buildInfoIcon(doc, tooltip, warn));
  return wrap;
}

// ---------------------------------------------------------------------------
// Preview node -- wipe pane images. `nodes/anima/preview.py`'s
// `"ui": {"anima_stages": [...]}}` payload (`build_preview_ui_images`,
// design doc §7/§7a's fix) is `{filename, subfolder, type, stage}` per
// entry; these two helpers turn ONE such entry into a real `<img>` the wipe
// can show. **The key is `anima_stages`, deliberately not `images`** --
// see `interaction.mjs`'s `handleExecuted` doc comment for why.
// ---------------------------------------------------------------------------

/** ComfyUI's own `/view` endpoint URL for a UI image entry. `cacheBust` is
 * deliberately a PARAMETER, not read from `Date.now()` in here -- this stays
 * a pure, testable function; `interaction.mjs`'s `handleExecuted` is the one
 * place that decides the value (once per `executed` message, shared by every
 * stage from that run). Returns `null` for a missing/malformed entry. */
export function buildPreviewImageUrl(entry, cacheBust) {
  if (!entry || typeof entry.filename !== "string" || !entry.filename) {
    return null;
  }
  const params = new URLSearchParams();
  params.set("filename", entry.filename);
  params.set("subfolder", entry.subfolder || "");
  params.set("type", entry.type || "output");
  if (cacheBust !== undefined && cacheBust !== null) {
    params.set("t", String(cacheBust));
  }
  return `/view?${params.toString()}`;
}

/** One wipe pane: an absolutely positioned `.wtn-an-layer` containing an
 * `<img>` for `stage` IF `previewImages` (`node._anPreviewImages`, keyed by
 * stage) has an entry for it yet. Maps by `stage`, never by array position. */
export function buildWipeLayer(doc, previewImages, stage, extraClass) {
  const layer = el(doc, "div", `wtn-an-layer${extraClass ? ` ${extraClass}` : ""}`);
  const entry = previewImages && previewImages[stage];
  const url = buildPreviewImageUrl(entry, entry && entry._cacheBust);
  if (url) {
    const img = el(doc, "img");
    img.src = url;
    img.alt = stage;
    layer.appendChild(img);
  }
  return layer;
}

export function sectionLabel(doc, label, count) {
  const sec = el(doc, "div", "wtn-an-sec");
  const span = el(doc, "span");
  span.textContent = label;
  sec.appendChild(span);
  if (count) {
    const cnt = el(doc, "span", "wtn-an-cnt");
    cnt.textContent = ` · ${count}`;
    sec.appendChild(cnt);
  }
  return sec;
}

// ---------------------------------------------------------------------------
// Local field builders -- these have no Control Panel analogue (free text)
// or are a trivial label+switch combination not worth its own shared module
// entry (see this module's top doc comment).
// ---------------------------------------------------------------------------

/** A plain labeled text `<input>`. Returns `{ root, control }`. */
export function buildTextField(doc, label, value) {
  const field = el(doc, "div", "wtn-an-field");
  const span = el(doc, "span");
  span.textContent = label;
  field.appendChild(span);
  const control = el(doc, "input");
  control.type = "text";
  control.value = value == null ? "" : String(value);
  field.appendChild(control);
  return { root: field, control };
}

/** A label + `js/shared/fields.mjs` pill switch, with an inline on/off word
 * (mirrors this module's inline-note habit rather than a bare pill with no
 * text). Returns `{ root, switchEl, word }`. */
export function buildBoolField(doc, label, value) {
  const field = el(doc, "div", "wtn-an-boolfield");
  const span = el(doc, "span");
  span.textContent = label;
  const switchEl = buildSwitch(doc, !!value);
  const word = el(doc, "span");
  word.textContent = value ? "on" : "off";
  field.appendChild(span);
  field.appendChild(switchEl);
  field.appendChild(word);
  return { root: field, switchEl, word };
}

/** An uppercase mono group sub-label, optionally carrying its own ⓘ (this
 * module's top doc comment: one consistent affordance for explanatory text
 * instead of a `buildNote` text block eating vertical space). */
export function buildSublabel(doc, str, infoTooltip, infoWarn) {
  const root = el(doc, "div", "wtn-an-sublab");
  const span = el(doc, "span");
  span.textContent = str;
  root.appendChild(span);
  if (infoTooltip) {
    root.appendChild(buildInfoIcon(doc, infoTooltip, infoWarn));
  }
  return root;
}

/** A short "this section is unavailable" status block -- rendered inside an
 * expanded section body when a required soft-import package is absent (the
 * header's own ⓘ already carries the SAME text as its tooltip; this is the
 * body's fuller, always-visible restatement for when the section is open). */
export function buildMissing(doc, str) {
  const m = el(doc, "div", "wtn-an-missing");
  const k = text(doc, "span", "", str);
  m.appendChild(k);
  return m;
}

// ---------------------------------------------------------------------------
// Resize -- 2026-07-28 (this dispatch) reversal from the ComfyUI-Pixaroma
// find_replace grow-biased-refit mechanism `js/prompt_rules/node/render.mjs`
// still uses. THAT mechanism has the NODE auto-fit to the panel's content
// (grow always, shrink only if the user hasn't manually enlarged past the
// last auto height) -- exactly the behaviour the user asked to remove here:
// "don't fight the user's resize". So there is no `refitNode`/`scheduleRefit`/
// `setNodeHeight` in this file at all any more, for either node type -- the
// node's height is the user's to set, full stop.
//
// What's left is ONLY a floor: `measureMinHeight` (wired to legacy
// litegraph's `getMinHeight` and Nodes 2.0's `computeLayoutSize` in
// `index.js`) reports the smallest height this node can sensibly be, so
// litegraph clamps a resize-drag there -- and reports EXACTLY that floor
// every time, never more, regardless of how tall the panel's real (stretched)
// content is. The panel filling anything ABOVE that floor is pure CSS
// (`.wtn-an-panel`'s `flex: 1 1 auto`, this module's CSS block above) --
// nothing here measures or reacts to the node's current size, so nothing
// here can ever rewrite it, on a repaint OR on load. That is what makes a
// manual shrink permanent across a repaint, and a saved size restore exactly
// on load with no resize firing at all: there is no code path left that
// would.
// ---------------------------------------------------------------------------

export const DEFAULT_W = 360;
export const DEFAULT_H = 340;
export const PREVIEW_DEFAULT_H = 420;

// The node-height FLOOR (there is no ceiling any more -- see this section's
// top comment). Mirrored in this module's CSS (`.wtn-an-panel`'s
// `min-height`) and reported to litegraph via `measureMinHeight` below.
// 220px is the common case (sampler summary + mod-guidance row + all four
// stage rows, nothing expanded) with no scrollbar; a node dragged smaller
// than that would clip a stage row, so litegraph refuses to go below it.
// Beyond this floor the panel scrolls internally (a node with several
// detailer blocks, or every stage's summary text at once) rather than the
// node growing to meet it -- the user drags taller instead, if they want to.
export const PANEL_MIN_H = 220;

// Generator floor -- the user asked for a min WIDTH explicitly, same
// treatment as `PREVIEW_MIN_W` below. 320px is the narrowest a stage row
// (switch + name + ellipsizable summary + gear) still reads sensibly at;
// unlike the Preview's compare row, nothing on the Generator's own body
// needs a wider floor than that.
export const GENERATOR_MIN_W = 320;

// Preview-only floor: the compare row carries the switch + "compare" label +
// BOTH `base|mid|final` segmented groups on one line, and that cluster
// measures ~340px, so a narrower node clips it.
export const PREVIEW_MIN_W = 380;

// The wipe's OWN floor -- see this file's "Preview node: hover wipe" CSS
// comment for the reversal this backs (`.wtn-an-panel-pv .wtn-an-wipe`'s
// `min-height`, mirrored here as a constant exactly like `PANEL_MIN_H`
// mirrors `.wtn-an-panel`'s). 160px keeps the compare image legible (both
// wipe layers, the divider, and both `.wtn-an-plab` corner labels) even at
// the Preview's smallest possible height.
export const PREVIEW_IMG_MIN_H = 160;

// The Preview PANEL's own floor (`.wtn-an-panel.wtn-an-panel-pv`'s
// `min-height`, mirrored here exactly like `PANEL_MIN_H` mirrors the base
// `.wtn-an-panel` rule) -- sized so the Save section fully EXPANDED (its
// header + all 5 fields), the compare row, and `PREVIEW_IMG_MIN_H` ALL fit
// inside a `overflow: hidden` panel with room to spare. Sizing for Save
// EXPANDED (not collapsed) is the whole point: it is what lets this panel
// never scroll, ever, with no auto-grow-on-repaint mechanism needed (this
// dispatch deliberately does NOT reintroduce `refitNode`/`scheduleRefit` --
// see this section's own top comment). Arithmetic, read off the CSS above
// and `js/shared/fields.mjs`'s own field heights:
//   Save header (.wtn-an-shead height 27 + margin-bottom 4)            =  31
//   .wtn-an-sbody padding (2 top + 8 bottom)                           =  10
//   .wtn-an-sbody gap (4px x 4 gaps between its 5 fields)              =  16
//   which / extension (.wtn-fld-stepper: height 25 + margin-bottom 4,
//     x2 -- both are buildStepperField rows)                          =  58
//   path (.wtn-an-field: ~25 input + its own margin-bottom 2)          =  27
//   filename (.wtn-an-field wrapped in .wtn-an-fieldrow for its ⓘ --
//     the field's OWN margin is zeroed by
//     ".wtn-an-fieldrow > *:first-child", the fieldrow's margin-bottom 4
//     replaces it: ~25 + 4)                                            =  29
//   embed workflow (.wtn-an-boolfield: ~16 content + margin-bottom 4)  =  20
//   compare row (.wtn-an-pvbar margin-top 7 + ~19 content)             =  26
//   PREVIEW_IMG_MIN_H (the wipe's own floor, above)                    = 160
//   .wtn-an-body's own gap (4px x 2 gaps between its 3 children -- the
//     Save section, the wipe, and the compare row)                    =   8
//   .wtn-an-panel's padding (6 top + 6 bottom)                        =  12
//   .wtn-an-panel's border (1 top + 1 bottom)                         =   2
//                                                             total   = 399
// Rounded up to 400 for headroom (matches measureMinHeight's own
// round-to-4px convention below).
export const PREVIEW_PANEL_MIN_H = 400;

// The Preview NODE-height floor -- `PREVIEW_PANEL_MIN_H` plus the chrome
// the DOM widget itself doesn't cover: the title bar (LiteGraph's default
// NODE_TITLE_HEIGHT, ~30px) + this node's two VISIBLE optional sockets
// (`images`, `metadata_json`, each a standard ~20px litegraph input row
// above the widget area -- the hidden `prompt`/`extra_pnginfo` carry no
// socket dot and cost nothing) + ~10px of widget-area top margin before
// the DOM widget itself begins. 30 + 2*20 + 10 = 80. (Mirrors
// `js/prompt_rules/node/render.mjs`'s `CHROME = 52` title-bar-only
// baseline, extended for the two extra socket rows this node has that that
// one doesn't.)
// VERIFY-IN-COMFYUI: no live litegraph process in this dev environment to
// read NODE_TITLE_HEIGHT/slot spacing off of -- if the real numbers differ,
// widen this constant rather than `PREVIEW_PANEL_MIN_H` itself.
export const PREVIEW_MIN_H = PREVIEW_PANEL_MIN_H + 80;

function clampMinWidth(size, minW) {
  if (!Array.isArray(size) || size.length < 1) {
    return size;
  }
  const w = size[0];
  if (typeof w !== "number" || !Number.isFinite(w) || w < minW) {
    size[0] = minW;
  }
  return size;
}

/** The Preview-only counterpart to `clampMinWidth` -- see `clampPreviewSize`
 * below for why only the Preview needs this (the Generator's panel still
 * scrolls past its own floor, so its node height never needs a matching
 * clamp beyond what litegraph's own `getMinHeight` already enforces). */
function clampMinHeight(size, minH) {
  if (!Array.isArray(size) || size.length < 2) {
    return size;
  }
  const h = size[1];
  if (typeof h !== "number" || !Number.isFinite(h) || h < minH) {
    size[1] = minH;
  }
  return size;
}

/** litegraph's `onResize(size)` contract: mutate `size` IN PLACE. Never
 * touches `size[1]` -- height has no clamp of its own beyond the floor
 * litegraph itself enforces from `getMinHeight`/`computeLayoutSize` (this
 * module's top "Resize" comment: there is no ceiling, and nothing here
 * rewrites height at all). Unlike `clampPreviewSize` below, this is
 * deliberately width-only -- the Generator's panel keeps scrolling past its
 * own floor (`PANEL_MIN_H`), so there is no "never scrolls" contract here
 * that would need a height floor to make safe. */
export function clampGeneratorSize(size) {
  return clampMinWidth(size, GENERATOR_MIN_W);
}

/** `onResize(size)` for the Preview -- clamps BOTH axes, unlike
 * `clampGeneratorSize`. The height half exists specifically so the floor
 * litegraph enforces on a resize-DRAG (`PREVIEW_MIN_H`, wired to
 * `getMinHeight`/`computeLayoutSize` via `measurePreviewMinHeight` in
 * `index.js`) agrees with the floor this function enforces here, rather
 * than the two contradicting each other -- see `PREVIEW_PANEL_MIN_H`'s own
 * doc comment above for why the Preview needs a real height floor at all
 * (its panel has `overflow: hidden`, never scrolls, so there is no shrink-
 * and-scroll fallback below that floor the way the Generator has). */
export function clampPreviewSize(size) {
  clampMinWidth(size, PREVIEW_MIN_W);
  return clampMinHeight(size, PREVIEW_MIN_H);
}

/** The node-height FLOOR litegraph enforces on a resize-drag (legacy
 * `getMinHeight`, Nodes 2.0 `computeLayoutSize` -- `index.js` wires both to
 * this). Sum of `root`'s children's `offsetHeight` (skipping display:none),
 * substituting the FIXED `panelFloor` (`PANEL_MIN_H` by default -- see
 * `measurePreviewMinHeight` below for the Preview's own, taller floor) for
 * the `.wtn-an-panel` child's own contribution instead of its real (CSS
 * `flex: 1 1 auto`-stretched) `offsetHeight` -- the same "a growing/
 * shrinking flex-fill child reports a fixed floor, not its live size"
 * pattern the frontend skill documents (and `../ComfyUI-Pixaroma/js/
 * find_replace/render.mjs`'s `PREVIEW_MIN` substitution mirrors), just with
 * no matching ceiling substitution any more -- there IS no ceiling. Because
 * the panel is this root's only child, this simplifies to a constant in
 * practice, but the general sibling-sum stays in case a fixed-content
 * sibling is ever added alongside the panel. */
export function measureMinHeight(root, panelFloor = PANEL_MIN_H) {
  if (!root) {
    return panelFloor;
  }
  let h = 0;
  let count = 0;
  for (const child of root.children) {
    if (child.offsetParent === null) {
      continue;
    }
    count += 1;
    if (child.classList && child.classList.contains("wtn-an-panel")) {
      h += panelFloor;
    } else {
      h += child.offsetHeight;
    }
  }
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(root) : {};
  const gap = parseFloat(cs.rowGap || cs.gap) || 0;
  if (count > 1) {
    h += gap * (count - 1);
  }
  h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return Math.max(panelFloor, Math.round(h / 4) * 4);
}

/** The Preview's own `measureMinHeight` -- IDENTICAL mechanism (same "NO
 * CEILING, never grows with the panel's real stretched `offsetHeight`"
 * contract, same no-feedback-loop guarantee), just substituting
 * `PREVIEW_PANEL_MIN_H` for `PANEL_MIN_H` so the floor litegraph enforces
 * on a resize-drag (`index.js`'s `getMinHeight`/`computeLayoutSize` for the
 * Preview specifically) agrees with `clampPreviewSize`'s own height clamp
 * above, rather than the two fighting each other. */
export function measurePreviewMinHeight(root) {
  return measureMinHeight(root, PREVIEW_PANEL_MIN_H);
}

// Re-export the shared cap so callers only need one import for both the
// state-mutation helpers (state.mjs) and this display-only constant.
export { MAX_DETAILER_PASSES, isBuiltinDetailerBlock };

// Re-export the shared node-chrome painter (`../shared/node_chrome.mjs`) --
// see this file's top import comment for why it's re-exported rather than
// imported directly by `index.js`.
export { applyNodeChrome, CHROME_BODY, CHROME_TITLE };
