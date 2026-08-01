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
 * ## 2026-07-28 (hybrid essentials/⚙ dispatch) — §12's "settings expand IN
 * PLACE" call is amended, not reversed a fifth time
 *
 * Live use surfaced the actual cost of the inline-sections dispatch above:
 * the Detailer alone has 31 fields per block, and putting every one of them
 * inline buries the handful that matter (`enabled`, `threshold`, `steps`,
 * `denoise`) under a wall of rarely-touched controls. The fix is a
 * deliberate HYBRID, not a fifth reversal of §12's "no more floating
 * popover" call: a section's ESSENTIALS still expand inline exactly as
 * described above (the chevron/switch/`.wtn-an-sbody` mechanism is
 * unchanged) — what moves is the section's own LONG TAIL of rarely-touched
 * fields, which now lives behind a ⚙ that opens a small, genuinely-anchored
 * overlay (`js/shared/overlay.mjs`'s `openOverlayWithZoom`, imported back
 * into this track — see `interaction.mjs`'s own top doc comment for the
 * full mechanism and why re-importing it does NOT contradict §12).
 *
 * Two consequences worth stating plainly:
 *   - §12's retraction of `js/shared/overlay.mjs` stands for SETTINGS
 *     SURFACES specifically — a section's inline body is still the one true
 *     home for its essentials, never a popover again. An option list (a
 *     stepper's `◀ [ value ▾ ] ▶`) and a ⚙'s advanced-fields menu are a
 *     DIFFERENT thing: both are inherently anchored, transient overlays (a
 *     list of options to pick ONE from; a batch of fields you open, edit,
 *     and close), and both genuinely need real anchoring machinery — a
 *     stepper's own `onOpenList` callback existed in `js/shared/fields.mjs`
 *     since this track's very first dispatch and was simply never wired to
 *     anything (`grep -rn "onOpenList" js/` found only the definition before
 *     this dispatch), which is the concrete bug this amendment also fixes.
 *   - The Detailer's per-INLINE-field split (this file's own
 *     `buildSectionHeader`/`interaction.mjs`'s per-section body builders) is
 *     the user's own field-by-field call, not a heuristic — see
 *     `interaction.mjs`'s top doc comment for the exact inline/advanced
 *     table per section.
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
 * re-exports from `js/shared/fields.mjs` (`buildNumericField`/
 * `buildStepperField`/`buildSwitch`/`buildInfoIcon`, and — 2026-07-29,
 * seed-row/field-library dispatch — `buildTextField`/`buildBoolField`/
 * `buildSublabel`/`buildMissing`, moved there from this file verbatim: all
 * four were generic templates with no Anima-specific behaviour, so they
 * belong in the pack's one shared field library rather than duplicated per
 * track. This module keeps re-exporting them under their own names so no
 * call site here (or in `interaction.mjs`, or this file's own
 * `test_resize.mjs`) had to change.
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
import {
  injectFieldStyles, buildSwitch, buildInfoIcon, buildGearIcon, buildComboButton,
  buildTextField, buildBoolField, buildSublabel, buildMissing,
  FLD_ROW_H, FLD_ROW_GAP, applyFieldFontScale,
} from "../shared/fields.mjs";
// Re-exported below (never redefined here) so `index.js` can reach it as
// `mods.render.applyNodeChrome`, matching every other lazily-loaded helper
// it calls -- see `../shared/node_chrome.mjs`'s own doc comment for the full
// constraints (single implementation shared with `js/controls/render.mjs`,
// never-stomp-an-explicit-colour, fresh-node-path-only).
import { applyNodeChrome, CHROME_BODY, CHROME_TITLE } from "../shared/node_chrome.mjs";
// Duck-typed size-pair check -- `node.size` (and any `size` array litegraph
// hands `onResize`) on a live node is a Float64Array VIEW over a Rectangle,
// NOT a plain Array (`Array.isArray(node.size) === false`, measured live);
// `clampMinWidth`/`clampMinHeight` below use this instead of `Array.isArray`
// so the clamp actually fires on the real object. See `../shared/size.mjs`'s
// own top doc comment for the full story.
import { isSizeLike } from "../shared/size.mjs";
import { getSetting, SETTING_IDS, SETTING_DEFAULTS } from "../shared/settings.mjs";
import { Z_PANEL } from "../shared/z_layers.mjs";

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

// Proportional-scale constants (bigger-type dispatch, task item 4) -- base
// panel type moved from ~12px to 14px, and every size below is DERIVED from
// these rather than a second independent guess. This module's own "Resize"
// section further down (`PANEL_MIN_H`/`PREVIEW_PANEL_MIN_H`/`GENERATOR_MIN_W`/
// etc) is written FROM these same numbers too, so the exported constant and
// the CSS floor it's supposed to match can never drift apart. `FLD_ROW_H`/
// `FLD_ROW_GAP` (imported above) are `js/shared/fields.mjs`'s OWN already-
// scaled row height/gap for `.wtn-fld-num`/`.wtn-fld-stepper` -- reused here
// (not re-derived) for the same arithmetic reason.
export let BASE_FONT = 14; // was ~12
export let SHEAD_H = 32; // .wtn-an-shead height (was 27)
export const SHEAD_GAP = 5; // header-to-next-section spacing (was 4) -- NOT part of the "Node panel type size" setting's scope (task brief names row heights/SHEAD_H/the *_MIN_H floors/FLD_*, not inter-row spacing), so this stays a fixed gap regardless of the chosen font size.

// **2026-07-28 (chevron/gear legibility fix, live bug report: "like a
// midget in a grass field")** -- the chevron used to sit at 10.5px (this
// file's unrelated `.wtn-an-sec` micro-label size, never meant for a glyph
// carrying this much visual weight) on `--wtn-ink-faint`, both too small AND
// too dim next to `SHEAD_H`'s own 13.5px `.wtn-an-shead-nm` label. `▸`/`▾`
// carry heavy internal whitespace inside their own em box, so matching body
// text still reads tiny -- this needs to sit noticeably ABOVE it. Derived
// from `BASE_FONT` (this file's own type-scale anchor) rather than a fourth
// independent guess. `js/shared/fields.mjs`'s `FLD_GEAR_SIZE` (the gear's
// matching constant, derived from ITS OWN base, `FLD_FONT`) intentionally
// lands on the SAME 17px -- both header glyphs read as one consistent size
// even though they're derived from two different files' base constants.
export let SHEAD_GLYPH_SIZE = Math.round(BASE_FONT * 1.21); // 17

// A FUNCTION, not a module-level const string -- `applyPanelFontScale` (this
// file's "Resize" section, further down) mutates `BASE_FONT`/`SHEAD_H`/
// `SHEAD_GLYPH_SIZE`/the `*_MIN_H` floors this template interpolates, so the
// CSS text must be built AFTER that scale is applied (`injectStyles` below
// does exactly that), not frozen at whatever values happened to hold at
// module-evaluation time.
function buildCss() {
  return `
.wtn-an-root { display: flex; flex-direction: column; gap: 0; width: 100%; box-sizing: border-box;
  padding: 5px 2px 2px; font: ${BASE_FONT}px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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
.wtn-an-panel { display: flex; flex-direction: column; gap: 5px; padding: 7px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 8px;
  background: var(--wtn-surface, ${TOKENS.surface});
  flex: 1 1 auto; min-height: ${PANEL_MIN_H}px; overflow-y: auto; overflow-x: hidden; }

.wtn-an-sec { font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  margin: 10px 0 5px; display: flex; align-items: center; gap: 8px; }
.wtn-an-sec::after { content: ""; flex: 1; height: 1px; background: var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-an-sec:first-child { margin-top: 2px; }
.wtn-an-sec .wtn-an-cnt { color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

/* ── expandable SECTION header (2026-07-28 inline-sections dispatch) --
   replaces every popover-opening row this track used to have.

   **NO-JUMP INVARIANT (2026-07-28, wheel/header-order dispatch; reordered
   again 2026-07-28, chevron/gear legibility fix) -- DOM order is FIXED:
   chevron -> switch (if any) -> label -> ⓘ (if any) -> summary (if any) ->
   ⚙ (if any). The first four are \`flex: none\` (pinned, never resized) and
   never move. The summary is the one flexible middle: \`flex: 1 1 auto\`
   (it grows to fill whatever space is left, so it never needs its own
   content width to reach the ⚙) PLUS ellipsis (\`overflow: hidden;
   text-overflow: ellipsis; white-space: nowrap; min-width: 0\`) so it's the
   ONLY thing whose CONTENT ever varies, shrinking/growing into the space
   between the fixed-left group and the ⚙. The ⚙ is \`flex: none\` like the
   left group, but pinned to the row's absolute right edge via its own
   \`margin-left: auto\` (\`.wtn-an-shead .wtn-fld-gear\` below) -- **that
   margin only ever does work when the summary is ABSENT**: whenever the
   summary exists, its own \`flex: 1 1 auto\` already consumes every pixel of
   free space during flex resolution (CSS flexbox: flexible-length
   resolution happens before auto-margin distribution), so the ⚙'s auto
   margin has nothing left to absorb and it simply sits flush against the
   summary's own (space-filling) box -- which itself sits flush against the
   container's right edge. Either way the ⚙ lands in the exact same spot:
   its position is provably identical whether the summary is present,
   absent, or any length in between -- see this file's own
   \`buildSectionHeader\` doc comment and \`js/anima/test_resize.mjs\`'s
   header-order tests for the regression this specifically guards. Do NOT
   reorder these back to chevron/label/summary/ⓘ/switch (the pre-dispatch
   order): that let the ⓘ and the switch slide left/right depending on
   whether a summary existed, which read as the row jittering every time
   "enabled" flipped. If you add a new header child, decide up front
   whether it's a FIXED affordance pinned to the LEFT (append it before the
   summary, \`flex: none\`), a FIXED affordance pinned to the RIGHT (append
   it after the summary, \`flex: none\` + its own \`margin-left: auto\` so it
   still lands in the same spot with or without a summary, exactly like the
   ⚙), or content that should ellipsize (there should only ever be one of
   those: the summary). **2026-07-28 (hybrid essentials/⚙ dispatch): the ⚙
   is the one such right-pinned slot, present only on sections that carry
   one (Highres/Upscale/Detailer; not Sampler/Mod Guidance/Postprocess) --
   never shifts the left group or the summary's own ellipsis behaviour
   either way.**

   As of the inline-sections-expand-is-the-switch's-job dispatch (this same
   day, later), clicking \`.wtn-an-shead\` itself only toggles expand/collapse
   for a SWITCHLESS section (Sampler) -- see \`interaction.mjs\`'s
   \`buildSection\` for the split. The switch's own click (stopPropagation'd)
   now flips BOTH \`enabled\` and expand/collapse together for every section
   that has one. The ⓘ's and ⚙'s clicks are always stopPropagation'd only,
   on both kinds of section -- NEITHER ever toggles expand/collapse; the ⚙
   opens its own anchored menu instead (\`interaction.mjs\`'s
   \`openAdvancedMenu\`), a DIFFERENT surface from this header's own inline
   body. \`.wtn-an-expanded\` is purely a hook for the chevron glyph/hover
   state PLUS (2026-07-28, card-attachment dispatch, next comment) the
   header's own bottom-corner/border/margin -- the actual body is a SIBLING
   element (\`.wtn-an-sbody\`) that simply isn't rendered at all while
   collapsed, not a max-height: 0 hide. ── */
.wtn-an-shead { position: relative; display: flex; align-items: center; gap: 9px; height: ${SHEAD_H}px;
  margin-bottom: ${SHEAD_GAP}px; padding: 0 9px; border-radius: 8px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  overflow: hidden; }
/* ── \`cursor: pointer\` scoped to CLICKABLE headers only (cursor-scoping
   correction, 2026-07-29, same dispatch as the hover-tint fix directly
   below -- the owner's approved principle, "the affordance applies exactly
   to headers that are real click targets, and nowhere else", covers this
   property too: a non-clickable header (Mod Guidance, Highres, Detailer,
   Upscale, Postprocess, the Compare card) used to show a pointer cursor
   despite doing nothing on click, the same misleading affordance the hover
   tint used to be. Lives on the SAME \`.wtn-an-clickable\` marker class the
   hover-tint rule below already uses -- one class, one condition, both
   properties -- rather than a second selector that could drift out of sync
   with it. Every interactive CHILD of a header (the switch, the ⓘ, the ⚙,
   the Compare card's two pickers) sets its own cursor already
   (\`js/shared/fields.mjs\`'s \`.wtn-fld-switch\` / \`.wtn-fld-info\` (\`cursor:
   help\`, deliberately not \`pointer\` -- it's an info tooltip, not a click
   target) / \`.wtn-fld-gear\` / \`.wtn-fld-combobtn\` (the Compare card's own
   pickers, via \`buildComboButton\`), all already \`cursor: pointer\`/\`help\`
   on THEMSELVES, verified by grep rather than assumed -- see this rule's own
   build report), so removing the header's blanket declaration does not
   leave any of them looking dead with an inherited \`cursor: default\`. ── */
.wtn-an-clickable { cursor: pointer; }
/* ── hover tint, CLICKABLE headers only (hover-tint-scoping dispatch,
   2026-07-29 -- follows the owner's own accent-removed-from-card-borders
   call, \`a6478f0\`, which this rule used to fight: hovering ANY header used
   to bring teal right back). Scoped to \`.wtn-an-clickable\`, a marker class
   added in the exact same statement group that attaches a header's real
   click listener -- \`interaction.mjs\`'s \`buildSection\` does it for the
   switchless-section/Sampler \`if (!hasSwitch) { ... }\` case, and
   \`buildSaveRow\` does it right next to its own \`head.root.addEventListener
   ("click", () => openSaveMenu())\` (correction, same day: an earlier pass
   here wrongly excluded the Save row, see that function's own comment) --
   never inferred from \`hasSwitch\`/\`dep\`/anything else a second time here,
   so the class and the handler describe the exact same condition and can
   never disagree. Every switch-bearing section (Mod Guidance, Highres,
   Detailer, Upscale, Postprocess) is driven ONLY by its own switch per §12
   -- clicking elsewhere on those headers does nothing, so they never carry
   this class and never tint. The Compare card has no \`head.root\` listener
   at all (only its switch and its two pickers do), so it was already
   excluded without any special-casing.
   Specificity is the whole reason this stays a ONE class + one pseudo-class
   selector: \`.wtn-an-clickable:hover\` is 0-2-0, matching (not beating)
   \`.wtn-an-shead.wtn-an-expanded\` below (also 0-2-0) -- see that rule's own
   comment for why. A two-class form like \`.wtn-an-shead.wtn-an-clickable:hover\`
   would be 0-3-0 and would newly BEAT \`.wtn-an-expanded\` regardless of
   source order, tinting an EXPANDED header on hover -- a regression this
   rule must not reintroduce. This rule also stays BEFORE \`.wtn-an-expanded\`
   in source order, exactly where the old \`.wtn-an-shead:hover\` rule sat, so
   the tie-break below still favours \`.wtn-an-expanded\` for the one header
   that's both clickable and expanded (Sampler, expanded -- no tint, matching
   today's behaviour verbatim). ── */
.wtn-an-clickable:hover { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
/* ── card attachment (task item 1): while expanded, the header SQUARES OFF
   its own bottom corners and drops its own bottom margin to zero, so
   \`.wtn-an-sbody\` right below it (this file's next CSS block) reads as ONE
   joined shape instead of a header floating disconnected from its body.
   The border colour this rule sets is what \`.wtn-an-sbody\`'s own border
   colour continues below -- see that block's own comment.
   Accent history: full-strength \`--wtn-accent\` here read as too glaring for
   a merely-enabled/expanded stage (round 1, 2026-07-29); dimmed to
   \`rgba(45,212,191,.35)\` still read as too light once seen in a live
   ComfyUI (round 2, same day, owner review). As of round 2 the card border
   carries NO accent at all -- back to the exact same \`--wtn-line-soft\` the
   collapsed header uses. The enabled/expanded state is now cued entirely by
   the chevron, the switch, and the body simply being visible, never by the
   border colour.
   \`border-color\` STAYS explicitly declared here even though its value now
   equals \`.wtn-an-shead\`'s own base rule above -- this redundancy is
   deliberate and load-bearing, not an oversight: \`.wtn-an-clickable:hover\`
   (above) has the SAME specificity (0-2-0) as this rule and currently
   loses only on source order (this rule sits later in the stylesheet) --
   true for the one header that is both clickable and expanded (Sampler).
   Delete this declaration and let it inherit, and \`:hover\` would have
   nothing left to lose to on an expanded, clickable card -- newly tinting
   it teal on hover, the exact opposite of what this rule exists to
   prevent. Keep the explicit declaration even though the value looks
   like a no-op. ── */
.wtn-an-shead.wtn-an-expanded { border-color: var(--wtn-line-soft, ${TOKENS.lineSoft});
  border-radius: 8px 8px 0 0; margin-bottom: 0; }
/* Pure state indicator, never a click target of its own (the whole header
   is), so it gets NO hit-area treatment -- just size + contrast, matching
   \`js/shared/fields.mjs\`'s \`FLD_GEAR_SIZE\` (see \`SHEAD_GLYPH_SIZE\`'s own
   doc comment above for why both glyphs land on the same 17px). \`text-align:
   center\` keeps the glyph centred inside its own fixed width regardless of
   which of \`▸\`/\`▾\` is showing. Colour moved off \`--wtn-ink-faint\`
   ("placeholders, disabled, idle" per \`docs/THEME.md\` -- the wrong
   vocabulary for a live state indicator) onto \`--wtn-ink-dim\` ("secondary
   text, labels" -- the token that actually reads against \`--wtn-surface-2\`),
   the same swap \`js/shared/fields.mjs\`'s \`.wtn-fld-gear\` gets for the same
   reason. */
.wtn-an-shead .wtn-an-chev { flex: none; width: ${SHEAD_GLYPH_SIZE}px; text-align: center;
  font-size: ${SHEAD_GLYPH_SIZE}px; line-height: 1; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-an-shead .wtn-an-shead-nm { font-size: 13.5px; font-weight: 550; flex: none; white-space: nowrap; }
/* \`flex: 1 1 auto\` is the 2026-07-28 (chevron/gear legibility fix) addition
   -- see this file's \`.wtn-an-shead\` CSS comment above for why the summary
   now needs to actively CONSUME the row's free space (not just get pushed
   into it via \`margin-left: auto\` alone) for the ⚙'s own pin-right margin
   (below) to land in the same spot whether a summary exists or not.
   \`margin-left: auto\` stays too -- harmless once \`flex: 1 1 auto\` already
   claims the free space, and it's what keeps this element flush right on
   its OWN when no ⚙ follows it (Sampler, Mod Guidance, Postprocess). */
.wtn-an-shead .wtn-an-shead-sum { flex: 1 1 auto; margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 11px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/* The ⚙'s pin-right -- scoped to THIS header context only (a descendant
   selector on the shared \`.wtn-fld-gear\` class, not a change to that
   class's own base rule in \`js/shared/fields.mjs\`), because the Detailer
   BLOCK's own ⚙ (\`interaction.mjs\`'s per-block \`.wtn-an-passtabs\` row, a
   completely different layout) must not be pushed to that row's far right
   -- see this file's \`.wtn-an-shead\` CSS comment above for why this margin
   only ever does real work when there is no summary; when there is one,
   the summary's own \`flex: 1 1 auto\` has already consumed the free space
   this margin would otherwise absorb. */
.wtn-an-shead .wtn-fld-gear { margin-left: auto; }
.wtn-an-shead.wtn-an-dep { border-color: rgba(251,191,36,.35); }

/* ── section body -- CARD treatment attached to its own header (task item 1,
   2026-07-28). Rendered only while its header is expanded, so it only ever
   needs to continue an EXPANDED header's own look: same surface as
   the header (\`--wtn-surface-2\`), the SAME border colour continued
   (\`border-top: none\` is what removes the seam -- the header's own bottom
   border and this element's own top edge would otherwise double up into a
   visible line between them), rounded ONLY on the bottom (the header kept
   its own top corners rounded, squared its bottom -- see \`.wtn-an-expanded\`
   above), and \`margin-top: 0\` (no gap at all between the two -- spacing to
   the NEXT section instead comes from this element's own margin-bottom,
   matching \`SHEAD_GAP\`, the same spacing a COLLAPSED header's own
   margin-bottom already provides). \`.wtn-an-dep\` mirrors the header's own
   warn-tinted border so a missing-dependency section reads coherently
   whether it's the header or the body catching your eye (see this rule's
   OWN left-padding note below for how the nesting itself now reads, since
   this dispatch retired the indent that used to carry that job).
   Accent history (see \`.wtn-an-expanded\` above for the full account):
   full-strength accent (round 1) then \`rgba(45,212,191,.35)\` (round 2) both
   read wrong once seen live, so as of round 2 this border carries NO accent
   at all -- plain \`--wtn-line-soft\`, matching the header it continues, so
   the header/body seam still reads as ONE continuous outline (now simply an
   uncoloured one). The \`.wtn-an-dep\` warn override right below still wins
   by source order either way -- with the accent gone, that amber is now the
   ONLY coloured border in the panel, which is a feature: it reads as an
   unambiguous "something needs attention" signal.
   Left padding matches every other side (2026-07-29, live review) --
   this used to be indented 23px "under the chevron so the nesting still
   reads clearly while the panel scrolls" (this rule's own history), back
   when the body was a plain indented block with no border of its own. Now
   that the body is a real bordered CARD attached to its header (this same
   comment, above), the card's own left border already communicates the
   nesting -- the extra 18px of indent past the other sides' 5px was
   therefore redundant and just ate horizontal width fields could have
   used. Do not restore the indent: the border is what carries the
   "nested under this header" signal now, not the padding. ── */
.wtn-an-sbody { display: flex; flex-direction: column; gap: 5px; padding: 3px 5px 10px;
  margin-top: 0; margin-bottom: ${SHEAD_GAP}px;
  background: var(--wtn-surface-2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); border-top: none;
  border-radius: 0 0 8px 8px; }
.wtn-an-sbody.wtn-an-dep { border-color: rgba(251,191,36,.35); }

/* ── a field paired with its own ⓘ (context-supplied warning, or a plain
   note) -- see this module's top doc comment. The field itself keeps its
   own bottom margin off (the wrapper owns the spacing) so pairing an icon
   never doubles the gap between rows. ── */
.wtn-an-fieldrow { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.wtn-an-fieldrow > *:first-child { flex: 1; min-width: 0; margin-bottom: 0; }

/* ── .wtn-an-field / .wtn-an-boolfield / .wtn-an-sublab / .wtn-an-missing --
   MOVED to js/shared/fields.mjs's own injected stylesheet (2026-07-29,
   seed-row/field-library dispatch), alongside the JS builders that use them
   (\`buildTextField\`/\`buildBoolField\`/\`buildSublabel\`/\`buildMissing\`, now
   re-exported from there -- this file's own top import). \`injectStyles\`
   below already calls \`injectFieldStyles\` first, so these rules are on the
   page before this function's own <style> tag lands; removing them from
   here is not a behaviour change, just following the CSS to where its JS
   now lives. ── */
.wtn-an-passtabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.wtn-an-passtabs button { font-family: var(--wtn-font-mono, monospace); font-size: 12px; padding: 5px 11px; cursor: pointer;
  border-radius: 6px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); background: var(--wtn-surface-2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); }
.wtn-an-passtabs button.wtn-an-on { background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-passtabs button:disabled { opacity: .4; cursor: default; }

/* ── the Preview's Save ROW (task item 2, 2026-07-28) -- a \`buildSectionHeader\`
   with NO chevron and NO body: it never expands in place, it just opens
   \`interaction.mjs\`'s \`openAdvancedMenu\` (placement "right") anchored to
   itself, same mechanism as a stage's own ⚙ menu. Both the row's own ⚙ (the
   discoverable affordance, consistent with every other advanced menu in
   this track) AND a click anywhere else on the row (the forgiving target)
   open the SAME menu -- only the switch's own click is carved out
   (\`stopPropagation\`'d), so flipping \`enabled\` can never also pop the
   menu open. Because \`expanded\` is always false for this row, it never
   gains \`.wtn-an-expanded\`'s squared-bottom-corner/card treatment either
   -- correct, since there is no \`.wtn-an-sbody\` for it to attach to any
   more. \`.wtn-an-menurow\` only exists so a click handler can tell "this
   is a menu-only header" apart from an accordion one without inspecting
   \`expanded\` -- purely a hook, no rules of its own (its own cursor comes
   from \`.wtn-an-clickable\`, below, which \`buildSaveRow\` also adds at the
   same site as this row's click listener -- see that rule's own doc
   comment for why a header being a real click target is what earns the
   pointer cursor now, not "is this a menu row"). ── */

/* ── the Preview's Save ROW WRAPPER (2026-07-29, Save-now-beside-the-card
   dispatch) -- ONE flex row: \`buildSaveNowRow\`'s button on the LEFT, the
   Save card (the \`.wtn-an-shead.wtn-an-menurow\` above) taking the
   REMAINING width on the right. Replaces the old stacked layout (Save card
   as its own full-width body child, "Save now" as a second, separate
   full-width row below it). \`.wtn-an-savenow\` keeps its own flex:none/
   min-width:0 so its "Save now" button's own intrinsic (non-shrinking)
   width is the one thing this row can't compress past. The Save card gets
   \`flex: 1 1 auto\` so it fills 100% of the row on its own whenever the
   button is ABSENT (\`save.enabled: true\` -- interaction.mjs's own
   conditional) -- a single flex child with flex-grow already claims the
   whole row, no separate "full width when alone" rule needed.
   \`margin-bottom: 0\` on the nested card overrides \`.wtn-an-shead\`'s own
   default (this file's CSS above) -- the WRAPPER carries that spacing
   instead (\`margin-bottom: SHEAD_GAP\` below), so nesting the card doesn't
   double it up inside the row.

   **2026-08-01 (status-own-line dispatch): the Save-now STATUS text no
   longer lives in this row at all.** It used to sit inside \`.wtn-an-savenow\`
   beside the button, squeezed between the button's own intrinsic width and
   this card's \`flex: 1 1 auto\` neighbor with nowhere left to grow --
   permanently truncated (owner report, with screenshot: "Saved base a…").
   \`.wtn-an-savenow-status\` (below) is now a SIBLING of this whole row --
   \`interaction.mjs\`'s \`buildPreviewBody\` appends it straight to
   \`.wtn-an-body\`, right after this wrapper -- so it gets the full panel
   width to read on instead of a shrinking sliver. ── */
.wtn-an-saverow { display: flex; align-items: center; gap: 8px; margin-bottom: ${SHEAD_GAP}px; }
.wtn-an-saverow > .wtn-an-shead { flex: 1 1 auto; min-width: 0; margin-bottom: 0; }

/* ── "Save now" (task item 6) -- rendered only while save.enabled is off
   (interaction.mjs's buildSaveNowRow); \`.wtn-btn\`/\`.wtn-btn--primary\` are
   the house button classes theme.css already defines (js/shared/theme.mjs's
   own \`injectTheme\`), so this row needs no LAYOUT-independent button
   styling of its own beyond the height override just below -- just layout.
   Sits INSIDE \`.wtn-an-saverow\` (beside the Save card, not below it) --
   \`flex: 0 1 auto\`/\`min-width: 0\` let the wrapper shrink toward the
   button's own intrinsic content width rather than force the card out of
   the row entirely; the button's own text never wraps/shrinks (a native
   \`<button>\`'s own intrinsic content width), so that's the real floor this
   row can't compress past. \`margin\` dropped its old \`2px 0 10px\` (that
   was this row's OWN vertical spacing back when it was a standalone body
   child below the Save card) -- the wrapper above now owns that spacing for
   the row as a whole. As of the status-own-line dispatch (this rule's own
   doc comment just above) this wrapper holds ONLY the button -- \`gap\` is
   inert with one child but stays harmless if a second ever returns. ── */
.wtn-an-savenow { display: flex; align-items: center; gap: 10px; flex: 0 1 auto; min-width: 0; }

/* ── the "Save now" BUTTON's own height, pinned to \`SAVE_NOW_BTN_H\` (===
   \`SHEAD_H\`, see that constant's own doc comment) -- the bug this fixes:
   \`.wtn-btn\`'s shared \`padding: 9px 15px\` (theme.css, a LOCKED shared file
   -- see this track's own house-theme skill) renders at its own intrinsic
   height regardless of \`SHEAD_H\`, so a bare \`height\` override here would
   still overflow unless the vertical padding is zeroed too. Two classes
   (\`.wtn-btn.wtn-an-savenow-btn\`) rather than one, so this rule's
   specificity (0,2,0) beats the shared \`.wtn-btn\` rule (0,1,0) regardless
   of which stylesheet lands in the page first -- \`theme.css\` and this
   file's own injected \`<style>\` have no guaranteed relative order (see this
   file's own top doc comment on \`theme.mjs\`'s guarded dynamic import).
   \`box-sizing: border-box\` is already the pack-wide default (\`.wtn *\` in
   theme.css), so \`height\` here already includes the border/padding box,
   not just the content box -- flex-centering the label is what keeps the
   text from clipping against the top/bottom now that vertical padding is
   gone. ── */
.wtn-an-savenow-btn.wtn-btn { height: ${SAVE_NOW_BTN_H}px; padding-top: 0; padding-bottom: 0;
  display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; }

/* ── the Save-now STATUS line (2026-08-01, status-own-line dispatch) -- now
   a direct \`.wtn-an-body\` child in its own right, a SIBLING of
   \`.wtn-an-saverow\`, not nested inside it (this file's own
   \`.wtn-an-saverow\` doc comment above has the "why": squeezed to
   illegibility between two neighbors when it lived there). Built (never
   appended) by \`interaction.mjs\`'s \`buildSaveNowRow\`, which starts it at
   \`display: none\` -- an unclicked "Save now" reads as truly EMPTY, not a
   blank reserved line, and \`.wtn-an-panel-pv > .wtn-an-body > *\`'s shared
   \`flex: none\` (this file's "Preview node: hover wipe" section) means a
   \`display: none\` row also drops out of that flex column's own \`gap\`
   entirely -- no phantom spacing either side of it while it's hidden.
   \`PREVIEW_PANEL_MIN_H\`'s own doc comment covers why the node's height
   FLOOR still has to assume this line is showing (the worst case) even
   though the common case is hidden -- a floor is a minimum, so the extra
   headroom the empty case doesn't need simply flows into the wipe's own
   flex-fill instead of ever look like a gap. \`line-height\` is explicit
   (rather than inherited from \`.wtn-an-root\`'s own font shorthand) so this
   rule's own single-line height is a fixed, documented number the
   \`PREVIEW_PANEL_MIN_H\` arithmetic can cite directly, not something that
   would silently drift if that shorthand's ratio ever changed. \`overflow\`/
   \`text-overflow\`/\`white-space\` stay as a safety net for a genuinely long
   message, not a load-bearing squeeze -- full body width is normally room
   enough that this never actually engages (unlike its old cramped home). ── */
.wtn-an-savenow-status { display: block; font-size: 12px; line-height: 1.4; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  margin-bottom: ${SHEAD_GAP}px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtn-an-savenow-status.wtn-an-savenow-err { color: var(--wtn-bad, ${TOKENS.bad}); }

/* ── the "History" button (owner-requested generation-history feature) --
   the THIRD child of \`.wtn-an-saverow\` (\`interaction.mjs\`'s
   \`buildHistoryButton\`, appended after the Save card): always visible
   (not conditioned on \`save.enabled\`, unlike "Save now"), \`flex: none\`
   like "Save now" itself, so \`.wtn-an-saverow > .wtn-an-shead\`'s own
   \`flex: 1 1 auto\` (the Save card) is the only thing in the row that
   grows -- this button and "Save now" both keep their own intrinsic
   button width and end up pinned at the row's two ends. Same
   height-pinning trick as \`.wtn-an-savenow-btn\` right above (\`SHEAD_H\`
   via \`SAVE_NOW_BTN_H\`, \`.wtn-btn\`'s shared vertical padding zeroed so
   the override actually lands) -- reuses the SAME constant rather than a
   second one, since both buttons live in the same row and must match its
   height exactly. \`.wtn-btn--ghost\` (theme.css) is the plain outlined
   variant -- this is a secondary action beside "Save now"'s primary CTA,
   not a second primary button competing for attention. ── */
.wtn-an-histbtn.wtn-btn { height: ${SAVE_NOW_BTN_H}px; padding-top: 0; padding-bottom: 0;
  display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; flex: none; }

/* ── the Compare CARD (2026-07-29, replaces the old bottom \`.wtn-an-pvbar\`
   row entirely) -- SAME chrome as a section card: it's a plain
   \`.wtn-an-shead\` (\`buildSectionHeader({hasChevron: false, hasGear: false,
   ...})\`, this file's \`.wtn-an-shead\` base rule above already gives it
   \`--wtn-surface-2\` background, \`--wtn-line-soft\` border, 8px radius, AND
   its own \`margin-bottom: SHEAD_GAP\` -- no override needed here, unlike the
   Save ROW above (that one nests a \`.wtn-an-shead\` inside a flex WRAPPER
   alongside the button, which is what forces re-homing the margin there;
   this card has no such wrapper, it's a direct \`.wtn-an-body\` child on its
   own). \`.wtn-an-comparecard\` only exists as a hook (no rules of its own)
   so a test/caller can tell this header apart from the Save one without
   inspecting its label text. ONE row, no expandable body -- the "switch
   owns expand/collapse" rule from §12 does not apply here: this card has no
   body to expand INTO. The switch keeps its pre-existing meaning verbatim
   (on => hover-wipe compare, off => plain single-image view); only its
   HOUSING changed. \`.wtn-an-comparepix\` (appended after the header's own
   label, since \`buildSectionHeader\` has no slot for "two pickers + vs" --
   there's no \`hasGear\`/summary content shape that fits) is the right-pinned
   group: \`margin-left: auto\` claims the header's free space exactly the way
   the ⚙ does on a section header that HAS one (\`.wtn-an-shead .wtn-fld-gear\`'s
   own CSS comment above covers why that only ever does work when nothing
   else already consumed the space -- here nothing does, since this card has
   no summary). ── */
.wtn-an-comparepix { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: none; }
.wtn-an-comparepix .wtn-an-vs { font-family: var(--wtn-font-mono, monospace); font-size: 11px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); flex: none; }

/* ── the overlay WRAPPER itself (\`js/shared/overlay.mjs\`'s \`openOverlay\`
   appends this, \`interaction.mjs\`'s \`openOverlayForCtx\` passes this class
   name) -- mirrors \`js/controls/render.mjs\`'s own \`.wtn-ctl-overlay\` rule.
   Belt-and-suspenders, same reasoning as that file's: \`openOverlay\` ALSO
   sets \`position: fixed\`/\`z-index\` inline (its own doc comment), so this
   rule is redundant in practice, but keeping it means a late/failed
   stylesheet injection still can't hide a menu (\`comfyui-node-renders-but-
   dead\` skill's root cause A). \`Z_PANEL\` (\`js/shared/z_layers.mjs\`), not
   the \`10020\` this used to say: \`overlay.mjs:267\` already sets
   \`overlay.style.zIndex = String(Z_PANEL)\` INLINE, and inline beats a
   stylesheet rule, so this file's own \`10020\` was already dead as written
   (every anchored overlay this pack opens through \`openOverlay\` -- the ⓘ
   panel, the search panel, option lists, ⚙ popovers, row context menus --
   is \`Z_PANEL\`, never a full modal). Migrating removes a false statement,
   not a behaviour. ── */
.wtn-an-overlay { position: fixed; z-index: ${Z_PANEL}; }

/* ── ⚙ menu content -- the long tail behind a section's own gear (task
   item 3) or the Preview's Save row (task item 2). Mirrors \`js/controls/
   render.mjs\`'s \`.wtn-ctl-menu\`/\`.wtn-ctl-opt\`/\`.wtn-ctl-mhead\` (the SAME
   overlay mechanism, \`js/shared/overlay.mjs\`, is what mounts this), scaled
   to this file's own type. \`.wtn-an-opt\`/\`.wtn-an-mhead\` are the stepper's
   OWN option list (\`interaction.mjs\`'s \`openStepperOptionList\`, \`placement:
   "below"\`, scrollable for a long list like samplers/checkpoints);
   \`.wtn-an-advmenu\` is the ⚙'s wider field-column menu (\`placement:
   "right"\`), built from the SAME field builders the inline rows use. ── */
.wtn-an-menu { border-radius: 8px; border: 1px solid var(--wtn-line, ${TOKENS.line});
  background: var(--wtn-surface-2, ${TOKENS.surface2}); box-shadow: var(--wtn-shadow, 0 20px 44px rgba(0,0,0,.7)); }
.wtn-an-menu.wtn-an-optlist { max-height: 280px; overflow-y: auto; padding: 5px; }
.wtn-an-opt { font-family: var(--wtn-font-mono, monospace); font-size: 13px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  padding: 6px 7px; border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wtn-an-opt:hover { background: var(--wtn-console, ${TOKENS.console}); color: var(--wtn-ink, ${TOKENS.ink}); }
.wtn-an-opt.wtn-an-opt-sel { background: #2b3440; color: var(--wtn-ink, ${TOKENS.ink}); font-weight: 650; }
.wtn-an-mhead { font-family: var(--wtn-font-mono, monospace); font-size: 11px; letter-spacing: .13em; text-transform: uppercase;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); padding: 5px 7px 7px; }
.wtn-an-advmenu { width: 264px; max-height: 60vh; overflow-y: auto; padding: 12px; }
.wtn-an-advmenu > * { margin-bottom: 0 !important; }
.wtn-an-advmenu > * + * { margin-top: 5px; }

/* ── Preview node: hover wipe ──
   2026-07-28, LATER the same day -- REVERSES the aspect-ratio call this
   file's own panel-fills-the-node dispatch just made a few lines above
   ("the wipe keeps its OWN size... aspect-ratio: 1/1... a node too short
   scrolls, image included"). This IS an image-comparison node -- the
   compare image is the entire point of placing it, everything else (the
   Save row, the Compare card) is secondary chrome around it -- so the user
   asked for the opposite: the image area fills whatever height the node
   is, and the panel never scrolls it out of view. \`.wtn-an-panel-pv\` (this
   file's panel-shell modifier -- \`buildPanelShell(doc, {preview: true})\`,
   applied ONLY by \`mountPreviewUI\`; the Generator's panel is untouched by
   any of this) carries the reversal: \`.wtn-an-panel-pv .wtn-an-wipe\`
   cancels the \`aspect-ratio: 1/1\` above (\`aspect-ratio: auto\`) and
   flex-fills (\`flex: 1 1 auto\`, floored at \`PREVIEW_IMG_MIN_H\`) whatever
   height \`.wtn-an-panel-pv > .wtn-an-body\` has left once the Save row
   (2026-07-29: \`.wtn-an-saverow\`, the button + Save card), the Save-now
   status line below it (2026-08-01, present only while non-empty -- that
   rule's own doc comment), and the Compare card take their own natural
   height (\`flex: none\`, the rule after this one). A non-square wipe does
   NOT distort either image --
   \`.wtn-an-layer img\`'s \`object-fit: contain\` (below, unchanged) already
   letterboxes each layer to whatever box it's given, square or not -- so
   this costs nothing visually, only gains the image actually using the
   space a resize gave it. \`.wtn-an-panel-pv\` also drops the panel's own
   scrollbar (\`overflow: hidden\`, not \`overflow-y: auto\`) with its OWN,
   much taller floor, \`PREVIEW_PANEL_MIN_H\` (this file's "Resize" section
   has the arithmetic) -- sized so the Save row, the Compare card, and
   \`PREVIEW_IMG_MIN_H\` always fit with room to spare, so there is never
   anything left TO scroll; unlike the Generator, this node has no "shrink
   below content, scroll internally" escape hatch at all. */
.wtn-an-wipe { position: relative; width: 100%; aspect-ratio: 1/1; overflow: hidden; border-radius: 8px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); background: var(--wtn-console, ${TOKENS.console});
  cursor: col-resize; touch-action: none; }
.wtn-an-wipe.wtn-an-single { cursor: default; }
.wtn-an-wipe .wtn-an-layer { position: absolute; inset: 0; }
.wtn-an-wipe .wtn-an-layer img { width: 100%; height: 100%; object-fit: contain; display: block; }
.wtn-an-wipe .wtn-an-layer.wtn-an-b { clip-path: inset(0 0 0 var(--wipe-x, 50%)); }
.wtn-an-wipe .wtn-an-divider { position: absolute; top: 0; bottom: 0; left: var(--wipe-x, 50%); width: 1px;
  background: var(--wtn-accent, ${TOKENS.accent}); box-shadow: 0 0 10px rgba(45,212,191,.8); pointer-events: none; }
.wtn-an-wipe .wtn-an-plab { position: absolute; top: 8px; font-family: var(--wtn-font-mono, monospace); font-size: 10.5px;
  padding: 3px 7px; border-radius: 4px; background: rgba(10,13,18,.82); border: 1px solid var(--wtn-line, ${TOKENS.line});
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); pointer-events: none; }
.wtn-an-wipe .wtn-an-plab.wtn-an-l { left: 8px; }
.wtn-an-wipe .wtn-an-plab.wtn-an-r { right: 8px; }
.wtn-an-wipe .wtn-an-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 13px; }

/* ── Preview-only panel modifier -- see the "Preview node: hover wipe"
   comment above for the reversal this carries. \`.wtn-an-panel\` (two
   classes, for specificity over the shared rule regardless of source
   order) overrides the shared scrollbar/floor; the \`> .wtn-an-body\`
   rule turns the body into its own flex column so the wipe below can
   flex-fill it (\`min-height: 0\` is what lets a flex child shrink below
   its content -- without it the wipe could never give height back to a
   shrinking node); the universal \`> *\` rule floors EVERY direct child at
   its own natural height -- as of 2026-07-29 (Save-now-beside-the-card
   dispatch) that's the \`.wtn-an-saverow\` wrapper (button + Save card) and
   the Compare card, replacing the old bare Save-header + bottom
   \`.wtn-an-pvbar\` pairing -- and the more specific \`.wtn-an-wipe\` rule
   after it (same specificity, later in the sheet -- the tie-break) is what
   lets the wipe alone override that back to flex-fill. \`min-height\`/
   \`PREVIEW_IMG_MIN_H\` below and \`PREVIEW_PANEL_MIN_H\` above are recomputed
   for this shape (saverow / save-now-status (2026-08-01, conditional -- see
   \`.wtn-an-savenow-status\`'s own doc comment) / comparecard / wipe) -- see
   \`PREVIEW_PANEL_MIN_H\`'s own arithmetic comment in this file's "Resize"
   section for the exact sum. ── */
.wtn-an-panel.wtn-an-panel-pv { overflow: hidden; min-height: ${PREVIEW_PANEL_MIN_H}px; }
.wtn-an-panel-pv > .wtn-an-body { display: flex; flex-direction: column; gap: 5px; flex: 1 1 auto; min-height: 0; }
.wtn-an-panel-pv > .wtn-an-body > * { flex: none; }
.wtn-an-panel-pv .wtn-an-wipe { flex: 1 1 auto; min-height: ${PREVIEW_IMG_MIN_H}px; aspect-ratio: auto; }
`;
}

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  const alreadyInjected = typeof targetDoc.getElementById === "function" && !!targetDoc.getElementById(STYLE_ID);
  if (!alreadyInjected) {
    // Node panel type size (Settings dialog, `js/shared/settings.mjs`) --
    // applied HERE, atomically with the CSS text built below, exactly once
    // per page (this `alreadyInjected` guard) -- see `applyPanelFontScale`'s
    // own doc comment (this file's "Resize" section) for why a later,
    // per-mount re-read would let the JS-side floor constants and the
    // already-injected stylesheet disagree ("half-applying" the setting). A
    // change to this setting needs a page refresh to take effect -- the
    // escape hatch the task itself allows for exactly this constant.
    const fontPx = getSetting(SETTING_IDS.NODE_PANEL_FONT_SIZE, SETTING_DEFAULTS[SETTING_IDS.NODE_PANEL_FONT_SIZE]);
    applyPanelFontScale(fontPx);
    // Same fontPx handed straight through -- both files' scale must agree,
    // and this avoids a second (redundant) getSetting call.
    injectFieldStyles(targetDoc, fontPx);
  } else {
    injectFieldStyles(targetDoc); // still idempotent/cheap -- fields.mjs owns its own STYLE_ID guard
  }
  // Guarded dynamic import -- see this module's top doc comment.
  if (typeof document !== "undefined") {
    import(THEME_URL)
      .then((mod) => mod.injectTheme())
      .catch(() => {
        // No live ComfyUI server to serve this route -- non-fatal, this
        // module's own CSS already falls back to hardcoded hex values.
      });
  }
  if (alreadyInjected) {
    return;
  }
  const style = targetDoc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = buildCss();
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
export { buildSwitch, buildInfoIcon, buildGearIcon, buildComboButton };

// ---------------------------------------------------------------------------
// Expandable section header -- 2026-07-28 inline-sections dispatch (this
// module's top doc comment). Purely presentational: `interaction.mjs` wires
// the header's own click (toggle expand) and the switch's own click (toggle
// enabled, `stopPropagation`ed so it never ALSO toggles expand).
// ---------------------------------------------------------------------------

/**
 * `spec`: `{ label, expanded, hasSwitch, switchOn, infoTooltip, infoWarn,
 * summary, dep, hasChevron = true, hasGear, gearTooltip, gearActive }`.
 * `dep` (matches the old `stageBlocked` styling) dims the header via
 * `.wtn-an-dep` when a required soft-import package is missing -- display
 * only, never disables the switch itself (a user may install the package
 * later; the switch already tolerated this before this dispatch).
 * `hasChevron: false` (the Preview's Save ROW, task item 2 -- a menu row,
 * never an accordion) omits the chevron entirely and never gains
 * `.wtn-an-expanded` (there is no body for it to attach to); every other
 * caller keeps the default.
 *
 * **DOM child order is fixed: chevron (if any) -> switch (if any) -> label
 * -> ⓘ (if any) -> summary (if any) -> ⚙ (if any)** (reordered 2026-07-28,
 * chevron/gear legibility fix -- the ⚙ used to sit before the summary; the
 * user asked for it at the row's absolute right end instead) -- see this
 * file's `.wtn-an-shead` CSS comment for the no-jump invariant this
 * preserves. The first four never move (`flex: none`). The summary is the
 * one CONTENT-flexible child (`flex: 1 1 auto` + ellipsis) -- it grows to
 * fill whatever space sits between the fixed-left group and the ⚙, so its
 * own width is deterministic (bounded by that space), only its ellipsized
 * CONTENT varies. The ⚙ is `flex: none` like the left group, pinned to the
 * row's absolute right edge via its own `margin-left: auto` -- provably in
 * the SAME spot whether the summary is present, absent, or any length,
 * because whichever of the two is first to claim the row's free space
 * (the summary's `flex: 1 1 auto` if it exists, otherwise the ⚙'s own auto
 * margin) ends up consuming all of it either way. Returns `{ root, chev,
 * sumEl, infoEl, switchEl, gearEl }` -- any of the optional ones may be
 * `null`. The gear's own click handler is the CALLER's job (`interaction.mjs`'s
 * `openAdvancedMenu`) -- this function only builds the icon
 * (`js/shared/fields.mjs`'s `buildGearIcon`, already `stopPropagation`'d so
 * it never ALSO toggles the header's own expand/collapse).
 */
export function buildSectionHeader(doc, spec) {
  const {
    label, expanded, hasSwitch, switchOn, infoTooltip, infoWarn, summary, dep,
    hasChevron = true, hasGear, gearTooltip, gearActive, onGearClick,
  } = spec;
  const header = el(doc, "div", `wtn-an-shead${expanded ? " wtn-an-expanded" : ""}${dep ? " wtn-an-dep" : ""}`);
  let chev = null;
  if (hasChevron) {
    chev = el(doc, "span", "wtn-an-chev");
    chev.textContent = expanded ? "▾" : "▸";
    header.appendChild(chev);
  }
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
  // Right-pinned, appended LAST -- see this function's own doc comment above
  // for why it always lands in the same spot regardless of whether `sumEl`
  // exists.
  let gearEl = null;
  if (hasGear) {
    gearEl = buildGearIcon(doc, gearTooltip, onGearClick, gearActive);
    header.appendChild(gearEl);
  }
  return { root: header, chev, sumEl, infoEl, switchEl, gearEl };
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

// buildTextField / buildBoolField / buildSublabel / buildMissing used to be
// defined here (a plain labeled text input, a label+switch combo, an
// uppercase sub-label, and a "section unavailable" block) -- all four were
// generic templates with no Anima-specific behaviour, so they MOVED to
// `js/shared/fields.mjs` (2026-07-29, seed-row/field-library dispatch) and
// are re-exported below (imported at this file's own top) so every call
// site here, in `interaction.mjs`, and in this file's own `test_resize.mjs`
// keeps working unchanged.
export { buildTextField, buildBoolField, buildSublabel, buildMissing };

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

// Every constant below is scaled from its pre-bigger-type value by roughly
// the same ratio as the type itself (`BASE_FONT`/`FLD_SCALE`, ~14/12 ≈
// 1.167) and then rounded to a clean pixel -- task item 4's "every derived
// constant... scales with it" requirement. None of these are computed IN
// CODE from the ratio (that would make the exported number a moving target
// across an unrelated refactor); each is the concrete pixel this dispatch
// settled on, same convention as `js/shared/fields.mjs`'s own `FLD_*`
// constants.
export const DEFAULT_W = 420; // was 360
export const DEFAULT_H = 400; // was 340
export const PREVIEW_DEFAULT_H = 490; // was 420

// The node-height FLOOR (there is no ceiling any more -- see this section's
// top comment). Mirrored in this module's CSS (`.wtn-an-panel`'s
// `min-height`) and reported to litegraph via `measureMinHeight` below.
// 256px is the common case (sampler summary + mod-guidance row + all four
// stage rows, nothing expanded) with no scrollbar; a node dragged smaller
// than that would clip a stage row, so litegraph refuses to go below it.
// Beyond this floor the panel scrolls internally (a node with several
// detailer blocks, or every stage's summary text at once) rather than the
// node growing to meet it -- the user drags taller instead, if they want to.
export let PANEL_MIN_H = 256; // was 220

// Generator floor -- the user asked for a min WIDTH explicitly, same
// treatment as `PREVIEW_MIN_W` below. 374px is the narrowest a stage row
// (chevron + switch + name + ⓘ + ⚙ + ellipsizable summary) still reads
// sensibly at now that the row also carries a ⚙ (task item 3); unlike the
// Preview's compare row, nothing on the Generator's own body needs a wider
// floor than that.
export const GENERATOR_MIN_W = 374; // was 320

// The Generator NODE-height floor -- **owner-approved policy change,
// 2026-07-29**. Until this dispatch the Generator had NO height clamp at
// all (`clampGeneratorSize` was width-only) -- reasoned as safe because its
// panel scrolls internally past `PANEL_MIN_H` rather than clipping, so a
// short node never cut anything off. The owner reversed that from live use:
// a floor stops the node being dragged absurdly SHORT regardless of whether
// the panel can absorb it, matching the Class-B contract the Preview
// already has (both axes, each with a minimum) rather than leaving the
// Generator's height totally unclamped. Internal scrolling is UNCHANGED by
// this -- `.wtn-an-panel`'s own `overflow-y: auto` still applies once the
// node is taller than this floor and the content doesn't fit; this only
// raises the floor itself, it does not add a "never scrolls" contract the
// way the Preview's `PREVIEW_PANEL_MIN_H` does.
//
// Derived the same way `PREVIEW_MIN_H` turns `PREVIEW_PANEL_MIN_H` (a panel
// floor) into a node floor: `PANEL_MIN_H` (256, above) plus the chrome the
// DOM widget itself doesn't cover -- the title bar (LiteGraph's default
// NODE_TITLE_HEIGHT, ~30px) + this node's own socket rows above the widget
// area + ~10px of widget-area top margin before the DOM widget begins.
// RE-DERIVED here rather than reusing the Preview's 80, because the
// Generator's own socket count differs: ONE visible input (`context` --
// `generation_settings` is a native STRING widget hidden via `hideWidget`,
// not a socket, so it costs nothing) versus THREE outputs (`images`/
// `latent`/`metadata_json`). Litegraph lays inputs and outputs out in
// parallel columns, so the TALLER side sets the row count: max(1, 3) = 3
// rows @ ~20px each = 60. 30 + 60 + 10 = 100.
// VERIFY-IN-COMFYUI: no live litegraph process in this dev environment to
// read NODE_TITLE_HEIGHT/slot spacing off of -- if the real numbers differ,
// widen `_GENERATOR_CHROME_ADDEND` (below) rather than `PANEL_MIN_H` itself.
export let GENERATOR_MIN_H = PANEL_MIN_H + 100; // PANEL_MIN_H(256) + 100

// Preview-only floor -- RE-DERIVED (2026-07-29, Compare-card dispatch),
// and it dropped A LOT: 444 -> ~300, rounded up to 320 for headroom. The
// old 444 was set by the compare row's TWO `base|mid|final` SEGMENTED
// GROUPS (six buttons total) sharing a line with the switch + label; those
// are gone (§7's own reversal, `docs/generator-design.md`) -- each picker
// is now ONE compact combo button (`buildComboButton`, `js/shared/
// fields.mjs`), showing just the current stage name + a caret, no
// arrows, no per-option buttons. Read off the Compare card's own content
// (`.wtn-an-shead`'s `padding: 0 9px` + `gap: 9px` between its top-level
// children, this file's CSS above):
//   switch (FLD_SWITCH_W, js/shared/fields.mjs)                           =  30
//   "Compare" label (~7 chars, .wtn-an-shead-nm's 13.5px sans-serif)      = ~55
//   picker group (.wtn-an-comparepix, gap: 8px):
//     "base" combo (4-char FLD_MONO value ~31 + 6 gap + 10px caret)       = ~47
//     "vs" (mono, ~2 chars)                                               = ~16
//     "final" combo (5-char FLD_MONO value ~39 + 6 gap + 10px caret)      = ~55
//     2 gaps between those three (8px each)                              =  16
//   header's own gap (9px x 2, between switch/label/picker-group)         =  18
//   header padding (9 left + 9 right)                                    =  18
//   header border (1 left + 1 right)                                     =   2
//                                                         content total   = 257
// Rounded up to 320 -- comfortable headroom over the ~257 estimate (font
// metrics above are read off the CSS, not measured in a live browser --
// VERIFY-IN-COMFYUI if this ever clips) while staying well under the old
// 444, matching "two compact combo buttons are much narrower."
export const PREVIEW_MIN_W = 320; // was 444

// The wipe's OWN floor -- see this file's "Preview node: hover wipe" CSS
// comment for the reversal this backs (`.wtn-an-panel-pv .wtn-an-wipe`'s
// `min-height`, mirrored here as a constant exactly like `PANEL_MIN_H`
// mirrors `.wtn-an-panel`'s). 188px keeps the compare image legible (both
// wipe layers, the divider, and both `.wtn-an-plab` corner labels) even at
// the Preview's smallest possible height.
export let PREVIEW_IMG_MIN_H = 188; // was 160

// **Bug fix, live-use report (owner): "Save now" was TALLER than the Save
// card beside it in \`.wtn-an-saverow\`.** This constant used to be its own
// literal (36 -- a native \`.wtn-btn\`'s intrinsic height: 13px line box +
// 2*9px padding + 2*1px border, rounded), reasoned as "theme-native
// geometry, not this file's own type scale" -- which was true but beside
// the point: \`SHEAD_H\` (the card's height) DOES scale with the "Node
// panel type size" setting while a bare 36 never did, so the two only ever
// matched by coincidence at the 14px baseline (36 vs 32, a 4px miss) and
// diverge further at any other scale (e.g. doubled: 36 vs 64, the button
// dramatically SHORTER than the card). The fix is definitional, not a
// bigger literal: this button's height IS \`SHEAD_H\`, always, by
// construction -- see \`applyPanelFontScale\` below, which keeps this in
// lockstep with \`SHEAD_H\` the same way every other floor in this section
// is kept in lockstep with its own \`_PANEL_DEFAULTS\` base. Kept as its own
// named export (rather than inlining \`SHEAD_H\` at the one CSS call site)
// purely for readability -- \`.wtn-an-savenow-btn\`'s CSS rule below reads
// "the save-now button's height" rather than a bare \`SHEAD_H\` reference
// that says nothing about WHY a button has a header's height.
// \`.wtn-btn\`'s own \`padding: 9px 15px\` (theme.css, a locked shared file)
// would otherwise push the rendered box past this -- the CSS rule below
// zeroes the VERTICAL padding and flex-centers the label instead, on the
// track-local \`.wtn-an-savenow-btn\` class rather than editing the shared
// button.
export let SAVE_NOW_BTN_H = SHEAD_H;

// The Preview PANEL's own floor (`.wtn-an-panel.wtn-an-panel-pv`'s
// `min-height`, mirrored here exactly like `PANEL_MIN_H` mirrors the base
// `.wtn-an-panel` rule).
//
// **Recomputed again (2026-08-01, status-own-line dispatch)** -- 288 -> 316,
// now that the Save-now STATUS line (`.wtn-an-savenow-status`) is its own
// full-width row, a SIBLING of `.wtn-an-saverow` rather than squeezed inside
// it (`.wtn-an-saverow`'s own doc comment above has the "why": owner report,
// with screenshot, that the status read as permanently truncated). This
// floor has to assume that row is SHOWING -- the worst case across all four
// states this can be in (`save.enabled` on/off crossed with the status
// empty/populated) -- even though the common case is empty and the row
// itself is `display: none` then (`.wtn-an-savenow-status`'s own doc
// comment, above): a floor is a MINIMUM, so overshooting it in the empty
// case just means the wipe's own flex-fill (`.wtn-an-panel-pv .wtn-an-wipe`,
// below) claims a few extra pixels it didn't strictly need -- it does NOT
// leave a visible gap, because there is no reserved box for an absent row to
// leave a gap around. Getting this floor too SMALL is the real risk: with
// `.wtn-an-panel-pv` locked to `overflow: hidden` and the wipe already at
// its own floor (`PREVIEW_IMG_MIN_H`) whenever the node sits at ITS floor,
// there is zero slack for a populated status line to grow into without
// clipping something. Arithmetic, read off the CSS above and
// `js/shared/fields.mjs`'s own field heights (`SHEAD_H`/`FLD_ROW_H` etc,
// this file's/that file's own exported constants):
//   Save ROW (.wtn-an-saverow: max(SHEAD_H 32, SAVE_NOW_BTN_H 32) = 32,
//     + the wrapper's own margin-bottom SHEAD_GAP 5)                      =  37
//   Save-now STATUS line (.wtn-an-savenow-status: one line at its own
//     explicit 12px/1.4 line-height = 16.8, rounded up to 17,
//     + its own margin-bottom SHEAD_GAP 5) -- WORST CASE, assumed always
//     showing even though the common case is `display: none` (see this
//     constant's own doc comment above)                                  =  22
//   Compare CARD (.wtn-an-shead height SHEAD_H 32 + margin-bottom
//     SHEAD_GAP 5, same shape as the Save card)                          =  37
//   PREVIEW_IMG_MIN_H (the wipe's own floor, above)                      = 188
//   .wtn-an-body's own gap (5px x 3 gaps between its 4 children in the
//     worst case -- the Save row, the status line, the Compare card, and
//     the wipe; only 2 gaps -- 10 -- whenever the status line is absent,
//     but this floor always assumes the taller case)                     =  15
//   .wtn-an-panel's padding (7 top + 7 bottom)                          =  14
//   .wtn-an-panel's border (1 top + 1 bottom)                          =   2
//                                                               total   = 315
// Rounded up to 316 -- the nearest 4px grid above the 315 estimate (matches
// measureMinHeight's own round-to-4px convention below), 1px of headroom.
export let PREVIEW_PANEL_MIN_H = 316; // was 288

// The Preview NODE-height floor -- `PREVIEW_PANEL_MIN_H` plus the chrome
// the DOM widget itself doesn't cover: the title bar (LiteGraph's default
// NODE_TITLE_HEIGHT, ~30px) + this node's two VISIBLE optional sockets
// (`images`, `metadata_json`, each a standard ~20px litegraph input row
// above the widget area -- the hidden `prompt`/`extra_pnginfo` carry no
// socket dot and cost nothing) + ~10px of widget-area top margin before
// the DOM widget itself begins. 30 + 2*20 + 10 = 80 -- this chrome is
// litegraph's OWN native pixel geometry, independent of this file's own
// type scale, so it is deliberately NOT scaled the way every constant
// above it is. (Mirrors `js/prompt_rules/node/render.mjs`'s `CHROME = 52`
// title-bar-only baseline, extended for the two extra socket rows this
// node has that that one doesn't.)
// VERIFY-IN-COMFYUI: no live litegraph process in this dev environment to
// read NODE_TITLE_HEIGHT/slot spacing off of -- if the real numbers differ,
// widen this constant rather than `PREVIEW_PANEL_MIN_H` itself.
export let PREVIEW_MIN_H = PREVIEW_PANEL_MIN_H + 80; // was PREVIEW_PANEL_MIN_H(288) + 80 = 368, now 316 + 80 = 396

// The litegraph-native chrome addend just above (80) -- frozen, NEVER
// scaled by `applyPanelFontScale` (this constant's own doc comment).
const _PREVIEW_CHROME_ADDEND = 80;

// The Generator's own litegraph-native chrome addend (100) -- frozen, NEVER
// scaled by `applyPanelFontScale`, same treatment as `_PREVIEW_CHROME_ADDEND`
// just above but re-derived for the Generator's own (different) socket
// count -- see `GENERATOR_MIN_H`'s own doc comment above for the arithmetic.
const _GENERATOR_CHROME_ADDEND = 100;

// Frozen at their 14px-baseline values (this file's own `PANEL_MIN_H`/
// `PREVIEW_IMG_MIN_H`/`PREVIEW_PANEL_MIN_H` literals above) --
// `applyPanelFontScale` below always multiplies FROM these, never from a
// constant's own (possibly already-scaled) current value, matching
// `js/shared/fields.mjs`'s identical `applyFieldFontScale` contract
// (idempotent, never compounding).
const _PANEL_BASE_PX = 14;
const _PANEL_DEFAULTS = {
  BASE_FONT: 14, SHEAD_H: 32, PANEL_MIN_H: 256, PREVIEW_IMG_MIN_H: 188, PREVIEW_PANEL_MIN_H: 316,
};

/** Round `x` to the nearest 4px -- matches `measureMinHeight`'s own
 * round-to-4px convention (this file's "Resize" section), so a scaled floor
 * lands on the same grid the un-scaled ones already do. */
function roundTo4(x) {
  return Math.round(x / 4) * 4;
}

/**
 * Recompute `BASE_FONT`/`SHEAD_H`/`SHEAD_GLYPH_SIZE`/`SAVE_NOW_BTN_H` and
 * the `*_MIN_H` floors (`PANEL_MIN_H`/`PREVIEW_IMG_MIN_H`/
 * `PREVIEW_PANEL_MIN_H`/`PREVIEW_MIN_H`/`GENERATOR_MIN_H`) for a "Node
 * panel type size (px)"
 * setting value of `px` — the task's own explicit scope ("row heights,
 * SHEAD_H, the *_MIN_H floors... in fields.mjs" — this is the render.mjs
 * half; `applyFieldFontScale` in `js/shared/fields.mjs` is the other).
 * `SHEAD_GAP`/`DEFAULT_W`/`DEFAULT_H`/`PREVIEW_DEFAULT_H`/`GENERATOR_MIN_W`/
 * `PREVIEW_MIN_W` are deliberately OUTSIDE this scope (spacing and
 * fresh-node/width floors, not named by the task) and stay fixed regardless
 * of this setting. `GENERATOR_MIN_H` joined this scope 2026-07-29 (owner
 * policy change, `GENERATOR_MIN_H`'s own doc comment above) -- it is a
 * height floor derived from `PANEL_MIN_H`, exactly like the pre-existing
 * `PREVIEW_MIN_H`/`PREVIEW_PANEL_MIN_H` pair, so it scales the same way.
 *
 * `SAVE_NOW_BTN_H` is not its own row in `_PANEL_DEFAULTS` -- it has no
 * independent default to scale FROM, it is simply re-pinned to the
 * freshly-scaled `SHEAD_H` (its own doc comment above explains why a
 * separate literal was the bug in the first place).
 *
 * Same idempotent-by-construction contract as `applyFieldFontScale`: always
 * derives from the frozen `_PANEL_DEFAULTS`/`_PANEL_BASE_PX`, so calling
 * this twice with the same `px` (or never calling it at all) leaves every
 * constant at exactly its original literal. `PREVIEW_MIN_H` re-adds the
 * FIXED `_PREVIEW_CHROME_ADDEND` (80, litegraph's own native chrome — never
 * scaled, see that constant's own doc comment) to the freshly-scaled
 * `PREVIEW_PANEL_MIN_H`, never to a stale previous value; `GENERATOR_MIN_H`
 * does the identical thing with its own `_GENERATOR_CHROME_ADDEND` (100)
 * added to the freshly-scaled `PANEL_MIN_H`.
 *
 * See `injectStyles`'s own doc comment for WHY this only ever runs once per
 * page, atomically with the actual CSS build, rather than being re-applied
 * on every mount.
 */
export function applyPanelFontScale(px) {
  const n = Number(px);
  const safePx = Number.isFinite(n) && n > 0 ? n : _PANEL_BASE_PX;
  const ratio = safePx / _PANEL_BASE_PX;
  BASE_FONT = Math.round(_PANEL_DEFAULTS.BASE_FONT * ratio);
  SHEAD_H = Math.round(_PANEL_DEFAULTS.SHEAD_H * ratio);
  SHEAD_GLYPH_SIZE = Math.round(BASE_FONT * 1.21);
  SAVE_NOW_BTN_H = SHEAD_H; // always equal, at every scale -- see this constant's own doc comment

  PANEL_MIN_H = roundTo4(_PANEL_DEFAULTS.PANEL_MIN_H * ratio);
  PREVIEW_IMG_MIN_H = roundTo4(_PANEL_DEFAULTS.PREVIEW_IMG_MIN_H * ratio);
  PREVIEW_PANEL_MIN_H = roundTo4(_PANEL_DEFAULTS.PREVIEW_PANEL_MIN_H * ratio);
  PREVIEW_MIN_H = PREVIEW_PANEL_MIN_H + _PREVIEW_CHROME_ADDEND;
  GENERATOR_MIN_H = PANEL_MIN_H + _GENERATOR_CHROME_ADDEND;
  return ratio;
}

function clampMinWidth(size, minW) {
  if (!isSizeLike(size, 1)) {
    return size; // not shaped like a real [w, ...] -- nothing sane to floor
  }
  // isSizeLike already guarantees size[0] is a finite number, so the only
  // thing left to decide is whether it's below the floor.
  if (size[0] < minW) {
    size[0] = minW;
  }
  return size;
}

/** The height-clamp counterpart to `clampMinWidth`, shared by BOTH
 * `clampGeneratorSize` and `clampPreviewSize` (owner policy change,
 * 2026-07-29: every node on this track is now Class B, both axes clamped
 * with a minimum -- see `GENERATOR_MIN_H`'s own doc comment for why the
 * Generator joined the Preview here). Each caller passes its own floor
 * (`GENERATOR_MIN_H`/`PREVIEW_MIN_H`) -- this function itself doesn't care
 * which node it's clamping, same as `clampMinWidth` above. */
function clampMinHeight(size, minH) {
  if (!isSizeLike(size)) {
    return size; // not shaped like a real [w, h] -- nothing sane to floor
  }
  // isSizeLike already guarantees size[1] is a finite number, so the only
  // thing left to decide is whether it's below the floor.
  if (size[1] < minH) {
    size[1] = minH;
  }
  return size;
}

/** litegraph's `onResize(size)` contract: mutate `size` IN PLACE. Clamps
 * BOTH axes as of 2026-07-29 (owner policy change, `GENERATOR_MIN_H`'s own
 * doc comment above): width up to `GENERATOR_MIN_W` same as always, height
 * up to `GENERATOR_MIN_H` so the node can't be dragged absurdly short. This
 * used to be width-only -- the Generator's panel keeps scrolling past its
 * own floor (`PANEL_MIN_H`), and that reasoning is UNCHANGED, but "the panel
 * can absorb it by scrolling" turned out not to be a reason the NODE itself
 * should have no floor at all: the owner wants a floor on every node on
 * this track regardless of whether its panel scrolls or not. Internal
 * scrolling past `GENERATOR_MIN_H` is unaffected -- this only stops a
 * resize-drag going shorter than that floor in the first place. */
export function clampGeneratorSize(size) {
  clampMinWidth(size, GENERATOR_MIN_W);
  return clampMinHeight(size, GENERATOR_MIN_H);
}

/** `onResize(size)` for the Preview -- clamps BOTH axes, same shape as
 * `clampGeneratorSize` above (both nodes on this track are Class B: both
 * axes user-resizable, each with a minimum -- owner policy, 2026-07-29).
 * The height half exists specifically so the floor litegraph enforces on a
 * resize-DRAG (`PREVIEW_MIN_H`, wired to `getMinHeight`/`computeLayoutSize`
 * via `measurePreviewMinHeight` in `index.js`) agrees with the floor this
 * function enforces here, rather than the two contradicting each other --
 * see `PREVIEW_PANEL_MIN_H`'s own doc comment above for why the Preview
 * needs a real height floor at all (its panel has `overflow: hidden`, never
 * scrolls, so there is no shrink-and-scroll fallback below that floor the
 * way the Generator's still does). */
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

// Re-export `js/shared/fields.mjs`'s own font-scale applier so `index.js`
// can reach BOTH halves of the "Node panel type size" pass
// (`mods.render.applyPanelFontScale`/`mods.render.applyFieldFontScale`)
// through the one lazily-loaded module it already holds, without a second
// static import of `fields.mjs` (`index.js` never imports it directly).
export { applyFieldFontScale };
