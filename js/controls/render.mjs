/**
 * render.mjs — DOM building + injected CSS for the Control Panel / Loader
 * Panel row UI. Pure DOM construction and painting only — no event
 * listeners (`interaction.mjs` wires those) and no `node`/`app`/`LiteGraph`
 * reference, so this module is importable by the headless `test_resize.mjs`
 * under plain `node` via a small doc stub (matching every other DOM-widget
 * node in this pack, e.g. `js/prompt_rules/node/render.mjs`).
 *
 * ## Architecture: one `addDOMWidget` PER ROW, not one root for the node
 *
 * Unlike `js/prompt_rules/node` (one static DOM widget for the whole body),
 * this node's rows are dynamic (add/remove/reorder/duplicate) and each row
 * needs its OWN output dot parked on its OWN Y — the exact mechanic
 * `docs/control-panel-design.md` §1 says to keep from ComfyUI-Pixaroma's
 * `js/sliders/` (`alignOutputsLegacy`): legacy litegraph reads
 * `output.pos` verbatim, so each row is its own `addDOMWidget`, and
 * `interaction.mjs`'s `alignOutputsLegacy` parks each row's output at that
 * ROW WIDGET's own `.y`. A single wrapping root would only have one `.y` to
 * align every dot against.
 *
 * ## Row height is FIXED per kind — no measuring needed for resize
 *
 * A row's on-canvas height never changes after creation (menus/popovers are
 * separate overlays appended to `document.body`, positioned off the row's
 * `getBoundingClientRect()` — see `openOverlay` below — so they never add
 * to the row's own flow height). That means `bodyHeight` is pure arithmetic
 * on the ROW COUNT (mirrors ComfyUI-Pixaroma's `js/sliders/index.js`
 * `bodyHeight`), not a DOM measurement — much simpler than the
 * `measureMinHeight`-walks-the-tree pattern `js/prompt_rules/node/render.mjs`
 * needs for its free-form textarea body.
 *
 * ## Why overlays (option list / ⚙ popover / right-click menu) live on
 * `document.body`, not inside the row
 *
 * `docs/control-panel-design.md`'s "traps already paid for" section: anchor
 * menus to the ROW BOX (never a text run inside it, never the node itself —
 * the node is `position: static`, so `left`/`top` would resolve against an
 * arbitrary ancestor). A DOM-widget row's own container may also clip
 * overflow inside the node's rendered area. Appending to `document.body` and
 * positioning with the row's REAL `getBoundingClientRect()` (already correct
 * screen coordinates in both renderers — no `ds.scale`/zoom math needed,
 * unlike a menu anchored to a canvas-drawn NODE box) sidesteps both problems
 * at once, and matches this pack's proven pattern
 * (`js/prompt_rules/node/picker.mjs`'s scrim).
 *
 * ## Importing `theme.mjs` — GUARDED dynamic import
 *
 * Same reasoning as every other node's `render.mjs` in this pack: this file
 * is imported directly by the headless `test_resize.mjs`, so a static
 * top-level import of the absolute `/extensions/.../theme.mjs` path would
 * throw `ERR_MODULE_NOT_FOUND` before a single assertion runs. This
 * module's own CSS below carries `var(--wtn-x, <hardcoded fallback hex>)`
 * everywhere, so styling is correct whether or not the shared stylesheet
 * import lands in time.
 */

import { AFTER_LETTER, formatLatentValue, formatNumericValue, isPickerKind, numericPercent } from "./rows.mjs";
import { openOverlay as sharedOpenOverlay } from "../shared/overlay.mjs";
import { applyNodeChrome as sharedApplyNodeChrome } from "../shared/node_chrome.mjs";
import { Z_PANEL } from "../shared/z_layers.mjs";
// `displayRowName` is the settings-aware "Hide file extension" display seam
// (task brief, 2026-07-31, part B: "check the Loader/Control Panel row
// labels for the same gap"). A picker-kind row's own combo VALUE
// (`unet`/`vae`/`clip` -- the only ones that are ever real filenames;
// `sampler`/`scheduler` values have no extension, so this is a harmless
// no-op for them) painted the raw filename verbatim, with no HIDE_FILE_
// EXTENSION reference anywhere in this file -- same gap `lora_render.mjs`'s
// `paintRow` had, same fix: reuse the ONE settings-aware display function
// (`model_picker.mjs`'s own doc comment) rather than re-reading the setting
// here directly.
import { displayRowName } from "./model_picker.mjs";
// `buildSwitch`/`injectFieldStyles` -- the pack's ONE pill-switch
// implementation (`js/shared/fields.mjs`), reused here rather than a fifth
// `.wtn-ctl-switch` reimplementation (task brief, 2026-08-02, "bool row"):
// this pack already carried FOUR independent switch implementations before
// this one (`fields.mjs`'s own `buildSwitch`, `lora_render.mjs`'s
// `.wtn-lora-switch`, `js/prompt_rules/node/render.mjs`'s `.wtn-pr-switch`,
// plus `js/anima/render.mjs`'s own use of this same `buildSwitch`) -- a bool
// ROW is exactly `.claude/skills/animaflow-shared-fields/SKILL.md`'s rule 1
// case (the control already exists in the shared library; use it, don't
// rebuild it).
//
// NOTE, though: as of this change `js/controls/` did NOT already import
// `js/shared/fields.mjs` anywhere -- `lora_render.mjs` explicitly does NOT
// (see that file's own "Vocabulary" doc comment, citing `docs/lora-loader-
// design.md` §0d: "`js/shared/fields.mjs` is deliberately NOT used ... this
// pack's field vocabulary here is `.wtn-ctl-*`"), and `fields.mjs`'s own top
// doc comment states the same thing from the other side ("`js/controls/`
// does not import this module at all (confirmed by grep...)"). This IS the
// first such import, made deliberately for this one row kind per this
// task's explicit instruction -- see `docs/control-panel-design.md`'s own
// "bool" row entry (§3) for the full discrepancy against this task's own
// premise (that `lora_render.mjs` already imports `fields.mjs` -- it does
// not). Only `buildSwitch`/`injectFieldStyles` are imported here, nothing
// track-shaped, so this does not retroactively migrate `lora_render.mjs`'s
// own `.wtn-lora-switch` -- that stays a separate, unscheduled decision.
import { buildSwitch, injectFieldStyles } from "../shared/fields.mjs";

const STYLE_ID = "wtn-controls-style";
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
  bad: "#f87171",
};

const CSS = `
/* ── row = OUTER, unclipped, positioning context for the output dot only ──
   .wtn-ctl-body = INNER, the actual visible rounded box (background/border/
   padding/flex layout all live here now, not on .wtn-ctl-row) --
   docs/pixaroma-review-rounds-plan.md Tier 2 item 8 ("rows overflow at
   minimum node width"): the naive port of Pixaroma's fix -- overflow:
   hidden straight on the row -- was VERIFIED (headless-Chrome measurement,
   see js/controls/test_resize.mjs's "clips content, never the dot" tests)
   to also clip .wtn-ctl-dot, since the dot is deliberately positioned
   OUTSIDE the row's own box (right: -15px -- see that rule's own comment)
   to sit in the socket gutter between the row and the node's real edge.
   overflow: hidden on an element clips ANY descendant that visually
   overflows its box, absolutely-positioned ones included, with no
   exception for "but this one's on purpose" -- so clipping the escaping
   furniture (mini buttons / gear) and preserving the dot are two different
   elements' job, not one rule wearing both hats. .wtn-ctl-row stays exactly
   the box every other module already depends on (same width/height, same
   position: relative, same class name for state -- .wtn-ctl-open/-dragging/
   -auto/-disabled/-slider toggle here unchanged, interaction.mjs untouched)
   -- only .wtn-ctl-body is new. */
.wtn-ctl-row {
  position: relative; width: 100%; height: 30px; box-sizing: border-box;
}
.wtn-ctl-body {
  position: relative; display: flex; align-items: center; gap: 8px;
  width: 100%; height: 100%; box-sizing: border-box; padding: 0 8px 0 10px;
  border-radius: 7px; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--wtn-ink, ${TOKENS.ink});
  /* The actual clip -- see this block's own doc comment above. */
  overflow: hidden;
}
.wtn-ctl-row.wtn-ctl-open .wtn-ctl-body { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-ctl-row.wtn-ctl-dragging { opacity: .5; }
.wtn-ctl-row.wtn-ctl-dragging .wtn-ctl-body { border-color: var(--wtn-accent, ${TOKENS.accent}); }
/* FLIP settle (drag-reorder animation, ported from the LoRA loader --
   js/shared/flip.mjs's own top doc comment has the full mechanic + why this
   track needs an extra one-frame defer that lora_render.mjs's identical rule
   doesn't). interaction.mjs's flipRows writes each surviving row's OWN
   inverse-translate as an inline transform the instant the reorder actually
   repaints, then -- one animation frame later -- adds THIS class and clears
   that inline style back to nothing, which is what turns "already there"
   into "glides there". transform is the ONLY property this rule ever
   touches -- never a layout property (this is a DOM widget composited over
   a canvas; animating layout there is visibly thrashy) -- and never the
   ComfyUI DOM-widget host's OWN wrapper element (which owns 'transform' for
   canvas-zoom scale), only this row's own '.wtn-ctl-row' (a plain child of
   that wrapper, mounted once and never touched again -- see
   js/shared/flip.mjs's doc comment for how that was confirmed). prefers-
   reduced-motion is handled ENTIRELY by the media query below -- with the
   transition removed, the exact same set-transform-then-clear sequence
   simply snaps instead of gliding, so no JS branch is needed to honour it.
   Byte-for-byte the SAME rule as lora_render.mjs's -- both tracks share one
   class ('wtn-row-flip', track-neutral on purpose) from one shared JS core,
   so a Control Panel with no LoRA loader node on the canvas still gets this
   rule. */
.wtn-ctl-row.wtn-row-flip { transition: transform .18s cubic-bezier(.2, .7, .3, 1); }
@media (prefers-reduced-motion: reduce) {
  .wtn-ctl-row.wtn-row-flip { transition: none; }
}
.wtn-ctl-row.wtn-ctl-auto .wtn-ctl-body { border-style: dashed; border-color: #2c3644; }
.wtn-ctl-row.wtn-ctl-auto .wtn-ctl-name { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; }
.wtn-ctl-row.wtn-ctl-disabled { opacity: .55; }

/* .wtn-ctl-name / .wtn-ctl-val are the row's two VARIABLE-width parts (every
   grip/mini-button/gear sibling is flex: none -- fixed furniture, asserted
   by test_resize.mjs). Between the two, THE VALUE IS PREFERRED -- a row's
   value is the thing the user is actually looking at (a seed, a resolution,
   a picked file); the name is usually its unchanged default ("seed",
   "latent"...) and only occasionally hand-renamed.

   flex-shrink: 4 here (vs. .wtn-ctl-val's un-set, default 1) is what makes
   that real, not just true "on average": flexbox distributes a width
   deficit across shrinkable siblings WEIGHTED by shrink-factor * basis
   size, all in ONE pass -- with equal shrink factors, a name that's
   ARTIFICIALLY LONGER than the value (a long hand-typed rename sitting next
   to a short value) would give up MORE absolute pixels than the value
   despite both losing the same fraction of their own size, which reads as
   "the value barely moved, the rename got hammered" -- backwards from the
   design intent. Biasing name's shrink factor to 4x means name absorbs the
   large majority of any deficit FIRST, hits its own min-width FLOOR
   (54px) quickly, and only THEN (flexbox's own min-violation resolution:
   an item pinned at its floor drops out and the remaining deficit
   redistributes among what's left) does the rest of the deficit fall to
   value -- verified with a headless-Chrome measurement of exactly this
   adversarial case (a long rename NEXT TO a 20-digit seed at the panel's
   MIN_W), not just reasoned about. A long RENAMED name still can't push
   the gear out either: it ellipsizes at that same 54px floor rather than
   growing past it. */
.wtn-ctl-name {
  font-size: 12px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; flex: 1 4 auto; min-width: 54px;
}
/* Rename edit box -- swapped in for .wtn-ctl-name while a row's label is
   being renamed (double-click the label, or the row's right-click ->
   Rename). Same box (flex/min-width/font-size) as the label it replaces so
   the row layout doesn't jump, but themed as a real editable field (accent
   border + surface fill) rather than the plain label -- it should read as
   the label BECOMING editable, not as a foreign form field appearing. */
.wtn-ctl-name-edit {
  font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--wtn-ink, ${TOKENS.ink}); flex: 1 1 auto; min-width: 54px; width: 100%;
  box-sizing: border-box; background: var(--wtn-surface-2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-accent, ${TOKENS.accent}); border-radius: 4px;
  padding: 1px 5px; outline: none;
}
.wtn-ctl-val {
  font-family: var(--wtn-font-mono, monospace); font-size: 12px; font-weight: 640;
  color: var(--wtn-ink, ${TOKENS.ink}); white-space: nowrap;
  /* min-width: 0 is the actual fix (see item 8 above) -- without it a
     nowrap text node refuses to shrink below its own content width no
     matter what flex-shrink says, which is exactly how a 20-digit seed
     pushed the seed row's mode/N/reuse buttons + gear past the border.
     overflow/text-overflow give the shrunk state an ellipsis instead of a
     hard cut (belt-and-suspenders under .wtn-ctl-body's own overflow:
     hidden, which would otherwise just guillotine the text with no "..."). */
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.wtn-ctl-val .wtn-ctl-dim { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-weight: 500; margin-left: 4px; }

/* output dot -- namespaced BY TYPE (t-*), never a bare socket-type class:
   docs/control-panel-design.md's "traps already paid for" -- a bare
   .combo here would collide with litegraph's own .combo WIDGET class
   and inherit position:relative;display:flex, knocking the dot out of
   absolute flow and eating ~19px of row width.

   Positioned relative to .wtn-ctl-row (the OUTER, unclipped element --
   buildRowElement appends the dot straight to rowEl, a SIBLING of
   .wtn-ctl-body, never a descendant of it) precisely so .wtn-ctl-body's
   overflow: hidden (item 8's fix, above) clips escaping row furniture
   without also clipping this deliberately-outside-the-box element. */
.wtn-ctl-dot {
  /* width/height/right below are EYEBALLED against the real litegraph
     output socket in a live ComfyUI (alignOutputsLegacy parks that socket
     at node.size[0] on this row's Y) -- empirical, don't "round" them.
     right: -15px is the LIVE-VERIFIED value (checked against the real
     socket in a live ComfyUI session, 2026-07-28) -- don't re-derive it. */
  position: absolute; right: -15px; top: 50%; transform: translateY(-50%);
  width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid #0b0e13;
  /* This element is a purely visual stand-in for the REAL output socket
     litegraph itself draws on the canvas underneath it (alignOutputsLegacy
     parks the actual output.pos at this exact spot) -- it owns none of
     the socket's interactivity. Without pointer-events: none this DOM
     dot sits in front of the canvas and intercepts the click/drag that is
     supposed to start a wire, making the node's primary interaction
     unreliable. Every pointer event here belongs to the canvas below. */
  pointer-events: none;
}
.wtn-ctl-dot.t-int { background: #7dd3fc; }
.wtn-ctl-dot.t-float { background: #4ade80; }
.wtn-ctl-dot.t-boolean { background: #fb923c; }
.wtn-ctl-dot.t-combo { background: #9ca3af; }
.wtn-ctl-dot.t-latent { background: #ff9cf9; }
.wtn-ctl-dot.t-model { background: #b39ddb; }
.wtn-ctl-dot.t-clip { background: #ffd500; }
.wtn-ctl-dot.t-vae { background: #ff6e6e; }
.wtn-ctl-dot.t-any { background: transparent; border: 1.5px dashed var(--wtn-ink-faint, ${TOKENS.inkFaint}); }

/* ── list rows: ◀ [ value ▾ ] ▶ ── */
/* Content-sized, shrink-only -- NOT flex-grow. .wtn-ctl-name is the only
   row child with flex-grow, so it alone absorbs slack when the value is
   short; these two only give up width (never gain it) once the label has
   already hit its own min-width floor. Growing here reproduces the bug this
   guards against: value+caret hug the LEFT of a stretched box, leaving a
   dead gap before the trailing arrow at the row's right edge. min-width: 0
   must stay so a long value can still ellipsize instead of blowing out the
   row's width. */
.wtn-ctl-stepper { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 0 1 auto; }
/* DRAWN triangles, never text glyphs -- a glyph's side bearing means
   padding can't ever render as an exact px value, and sizes vary by
   platform font. A border triangle's box IS the triangle. */
.wtn-ctl-arrow { width: 0; height: 0; flex: none; cursor: pointer; opacity: .92;
  border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
.wtn-ctl-arrow.wtn-ctl-left { border-right: 8px solid var(--wtn-accent, ${TOKENS.accent}); }
.wtn-ctl-arrow.wtn-ctl-right { border-left: 8px solid var(--wtn-accent, ${TOKENS.accent}); }
.wtn-ctl-arrow:hover.wtn-ctl-left { border-right-color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-ctl-arrow:hover.wtn-ctl-right { border-left-color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-ctl-combo { position: relative; display: flex; align-items: center; gap: 5px; min-width: 0; cursor: pointer; flex: 0 1 auto; }
.wtn-ctl-combo .wtn-ctl-val { overflow: hidden; text-overflow: ellipsis; }
/* caret is grey in EVERY state -- teal is reserved for the steppers, which
   DO something on click; the caret is only an affordance. */
.wtn-ctl-caret { width: 0; height: 0; flex: none; transform: translateY(1px);
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-ctl-combo:hover .wtn-ctl-val { color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-ctl-combo:hover .wtn-ctl-caret { border-top-color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }

/* ── seed row ── */
.wtn-ctl-mini {
  font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; font-weight: 700;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); background: var(--wtn-surface-2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 5px;
  padding: 2px 5px; cursor: pointer; line-height: 1.35; flex: none;
}
.wtn-ctl-mini:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-ctl-mini.wtn-ctl-on { color: var(--wtn-on-accent, ${TOKENS.onAccent}); background: var(--wtn-accent, ${TOKENS.accent}); border-color: var(--wtn-accent, ${TOKENS.accent}); }
/* ↺ reuse-last-seed: HIDDEN (not merely disabled) whenever there's nothing
   yet to reuse -- see paintRow's seed branch for the exact condition. */
.wtn-ctl-mini.wtn-ctl-hidden { display: none; }

/* ── numeric row: drag the row to set, inline fill shows range position ──
   No overflow: hidden here any more -- .wtn-ctl-body's own rule already
   clips every row, numeric ones included (previously THIS rule was the
   row's only clip, which -- being on .wtn-ctl-row itself, before the
   row/body split above -- silently clipped the numeric row's own output
   dot too; verified live via the same headless-Chrome measurement as item
   8's fix, not merely inferred). */
.wtn-ctl-row.wtn-ctl-slider { cursor: ew-resize; }
.wtn-ctl-fill {
  position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px 0 0 6px;
  background: linear-gradient(90deg, rgba(45,212,191,.30), rgba(45,212,191,.16));
  border-right: 1px solid var(--wtn-accent-deep, ${TOKENS.accentDeep}); pointer-events: none;
}
.wtn-ctl-row.wtn-ctl-slider .wtn-ctl-name,
.wtn-ctl-row.wtn-ctl-slider .wtn-ctl-val,
.wtn-ctl-row.wtn-ctl-slider .wtn-ctl-gear { position: relative; z-index: 1; }

/* ── reorder grip (Control Panel only) ── */
.wtn-ctl-grip {
  flex: none; width: 9px; height: 15px; cursor: grab; margin-left: -3px;
  background-image: radial-gradient(circle, var(--wtn-ink-faint, ${TOKENS.inkFaint}) 1.1px, transparent 1.3px);
  background-size: 4px 4px; opacity: .5; touch-action: none;
}
.wtn-ctl-grip:hover { opacity: 1; }

/* ⚙ is ALWAYS the rightmost element: border -> 8px -> ⚙ -> 8px -> ▶. A row
   with no settings simply ends at its ▶, 8px from the border -- no reserved
   slot, so the two kinds of row don't visually line up with each other. */
.wtn-ctl-gear { font-size: 14px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); cursor: pointer; flex: none; width: 18px; text-align: center; }
.wtn-ctl-gear:hover, .wtn-ctl-gear.wtn-ctl-active { color: var(--wtn-accent, ${TOKENS.accent}); }

/* ── "+ Add" row ── */
.wtn-ctl-add {
  height: 28px; width: 100%; box-sizing: border-box; border-radius: 7px; cursor: pointer;
  border: 1px dashed #2c3644; background: transparent; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  font: 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.wtn-ctl-add:hover { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-ctl-add.wtn-ctl-full { opacity: .5; cursor: default; }
.wtn-ctl-add.wtn-ctl-full:hover { border-color: #2c3644; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }

/* ── overlays: option list / ⚙ popover / right-click menu -- all appended
   to document.body, positioned from the anchor row's own bounding rect
   (see this module's top doc comment for why). ── */
.wtn-ctl-overlay { position: fixed; z-index: ${Z_PANEL}; }
.wtn-ctl-menu {
  max-height: 264px; overflow-y: auto; padding: 4px; border-radius: 8px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); background: var(--wtn-surface-2, ${TOKENS.surface2});
  box-shadow: var(--wtn-shadow, 0 20px 44px rgba(0,0,0,.7));
}
.wtn-ctl-opt {
  font-family: var(--wtn-font-mono, monospace); font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  padding: 5px 6px; border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wtn-ctl-opt:hover { background: var(--wtn-console, ${TOKENS.console}); color: var(--wtn-ink, ${TOKENS.ink}); }
.wtn-ctl-opt.wtn-ctl-sel { background: #2b3440; color: var(--wtn-ink, ${TOKENS.ink}); font-weight: 650; }
.wtn-ctl-mhead {
  font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; letter-spacing: .13em; text-transform: uppercase;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); padding: 4px 6px 6px;
}
.wtn-ctl-opt .wtn-ctl-hint { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 10.5px; margin-left: 6px; }

.wtn-ctl-pop {
  width: 240px; padding: 12px; border-radius: 11px; border: 1px solid var(--wtn-line, ${TOKENS.line});
  background: var(--wtn-surface-2, ${TOKENS.surface2}); box-shadow: var(--wtn-shadow, 0 20px 46px rgba(0,0,0,.66));
}
.wtn-ctl-pop.wtn-ctl-wide { width: 272px; }
.wtn-ctl-pop h4 {
  margin: 0 0 10px; font-family: var(--wtn-font-mono, monospace); font-size: 10px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-weight: 600;
}
.wtn-ctl-field { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.wtn-ctl-field span { font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); width: 58px; flex: none; }
.wtn-ctl-field input, .wtn-ctl-field select {
  font-family: var(--wtn-font-mono, monospace); font-size: 11.5px; color: var(--wtn-ink, ${TOKENS.ink}); width: 100%;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 6px; padding: 5px 7px;
}
.wtn-ctl-field input:focus, .wtn-ctl-field select:focus { outline: none; border-color: var(--wtn-accent, ${TOKENS.accent}); }
/* Owner-reported (2026-08-01): "on the select field we need to show cursor
   pointer on hover and border teal color (not shiny)" -- \`--wtn-accent-deep\`
   (muted teal), never \`--wtn-accent\`/\`--wtn-accent-strong\` (both brighter --
   "not shiny" is the point). \`select\` only, not \`input\` -- declared on
   this shared descendant selector (every ⚙ popover's own \`<select>\` --
   \`afterSel\`/\`sel\`/\`typeSel\`/\`devSel\` in interaction.mjs, all built inside
   a \`.wtn-ctl-field\` -- inherits it by construction), the same "one rule,
   not per-surface" fix \`js/shared/theme.css\`'s own \`.wtn-select:not(:disabled):hover\`
   doc comment names for the other tracks' selects. Only the border changes
   -- no glow, no box-shadow, no background shift. No \`:not(:disabled)\`
   guard here -- unlike \`model_detail_view.mjs\`'s own version select, none
   of this popover's four selects (\`afterSel\`/\`sel\`/\`typeSel\`/\`devSel\`) is
   ever disabled. */
.wtn-ctl-field select:hover { cursor: pointer; border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

.wtn-ctl-seg { display: flex; gap: 3px; padding: 3px; margin-bottom: 11px;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 8px; }
.wtn-ctl-seg button { flex: 1; font: 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); background: transparent; border: none; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
.wtn-ctl-seg button:hover { color: var(--wtn-ink, ${TOKENS.ink}); }
.wtn-ctl-seg button.wtn-ctl-on { background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); font-weight: 620; }

.wtn-ctl-wh { display: flex; gap: 8px; }
.wtn-ctl-wh label { flex: 1; display: flex; flex-direction: column; gap: 5px;
  font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-ctl-wh input { font-family: var(--wtn-font-mono, monospace); font-size: 12px; color: var(--wtn-ink, ${TOKENS.ink}); width: 100%;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 6px; padding: 6px 7px; }
.wtn-ctl-wh input:focus { outline: none; border-color: var(--wtn-accent, ${TOKENS.accent}); }

.wtn-ctl-ratios { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-bottom: 10px; }
.wtn-ctl-rbtn { display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;
  font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 6px; padding: 6px 4px; }
.wtn-ctl-rbtn:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-ctl-rbtn.wtn-ctl-on { background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); font-weight: 650; border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-ctl-rbtn .wtn-ctl-ic { border: 1.4px solid currentColor; border-radius: 2px; flex: none; }

.wtn-ctl-reslist { max-height: 152px; overflow-y: auto; padding: 3px;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 7px; }
.wtn-ctl-res { font-family: var(--wtn-font-mono, monospace); font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  text-align: center; padding: 5px; border-radius: 5px; cursor: pointer; }
.wtn-ctl-res:hover { background: var(--wtn-surface-2, ${TOKENS.surface2}); color: var(--wtn-ink, ${TOKENS.ink}); }
.wtn-ctl-res.wtn-ctl-on { background: rgba(45,212,191,.14); color: var(--wtn-accent, ${TOKENS.accent}); font-weight: 650; }

.wtn-ctl-popfoot { display: flex; gap: 7px; margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-ctl-pbtn { font: 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; cursor: pointer; flex: 1;
  background: transparent; border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 7px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); padding: 5px 8px; }
.wtn-ctl-pbtn:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-ctl-pbtn.wtn-ctl-danger:hover { color: var(--wtn-bad, ${TOKENS.bad}); border-color: var(--wtn-bad, ${TOKENS.bad}); }
`;

/**
 * Paints the LEGACY LITEGRAPH NODE ITSELF (body + title-bar strip) in our
 * theme, so the dark DOM rows sit on our own dark surface instead of
 * ComfyUI's lighter default node chrome. Re-exported here (rather than
 * defined here) as a thin delegation to `../shared/node_chrome.mjs` -- see
 * that module's own top doc comment for the full constraints (litegraph
 * SERIALIZES `node.color`/`node.bgcolor` the moment either is set, so this
 * must NEVER overwrite an already-set value; the Pixaroma attribution; the
 * palette decision) now that Controls and Anima share exactly ONE
 * implementation instead of each carrying its own copy.
 *
 * Called from `index.js`'s `setupNode` ONLY, and only when
 * `!node._ctrlConfiguring` -- i.e. a genuinely fresh node, never one being
 * restored from a saved workflow (see index.js's call site for why that
 * flag reliably distinguishes the two, and why the restore path
 * deliberately never touches colour at all).
 */
export function applyNodeChrome(node) {
  return sharedApplyNodeChrome(node);
}

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  // `.wtn-fld-switch` (a bool row's own switch, `buildSwitch` above) needs
  // `js/shared/fields.mjs`'s OWN stylesheet, which this file's `STYLE_ID`
  // guard below has nothing to do with -- run it unconditionally, on every
  // call, same as `js/anima/render.mjs`'s identical call site. Cheap: the
  // shared module owns its own separate style-id guard, so a call after the
  // first is a no-op.
  injectFieldStyles(targetDoc);
  // Guarded dynamic import -- see this module's top doc comment.
  if (typeof document !== "undefined") {
    import(THEME_URL)
      .then((mod) => mod.injectTheme())
      .catch(() => {
        // No live ComfyUI server to serve this route -- non-fatal, this
        // file's own CSS already falls back to hardcoded hex values.
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
// Row DOM construction
// ---------------------------------------------------------------------------

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

/** Builds ONE row's static skeleton (grip / name / kind-specific body / gear
 * / output dot) and returns `{ el, refs }` -- `refs` holds every element
 * `interaction.mjs` needs to wire events onto or `paintRow` needs to update.
 * The body's exact children differ by `row.kind` (a list stepper, the seed
 * mode/N buttons, a numeric fill, or a plain latent value span) -- built
 * once here; a KIND CHANGE (auto -> resolved) is handled by building a
 * fresh row element rather than mutating this structure in place (see
 * `interaction.mjs`'s `syncRows`).
 */
export function buildRowElement(doc, row, kindMeta, panelConfig) {
  const rowEl = el(doc, "div", "wtn-ctl-row wtn");
  // .wtn-ctl-body is the clipped, visibly-bordered box -- every child that
  // must never escape the row's rounded border (grip/name/value area/mini
  // buttons/gear) is appended to BODY, never to rowEl directly. The dot is
  // the one deliberate exception: appended straight to rowEl below, so
  // .wtn-ctl-body's overflow: hidden (this module's CSS, item 8's fix)
  // clips escaping furniture without also clipping the dot, which is
  // positioned OUTSIDE the visible box on purpose (see .wtn-ctl-dot's own
  // CSS comment). See this module's top CSS block comment for the full
  // reasoning and the live-Chrome measurement that proves the naive
  // "overflow: hidden straight on the row" fix would have killed the dot
  // on every single row, not just seed's.
  const body = el(doc, "div", "wtn-ctl-body");
  rowEl.appendChild(body);
  if (row.kind === "auto") {
    rowEl.classList.add("wtn-ctl-auto");
  }

  const refs = { root: rowEl, body, row, kindMeta };

  if (panelConfig && panelConfig.reorder) {
    const grip = el(doc, "span", "wtn-ctl-grip");
    grip.title = "Drag to reorder -- does not move the output slot";
    body.appendChild(grip);
    refs.grip = grip;
  }

  const name = el(doc, "div", "wtn-ctl-name");
  name.textContent = row.name || row.kind;
  body.appendChild(name);
  refs.name = name;

  if (row.kind === "auto") {
    // No value area at all -- an unresolved row has nothing to show yet.
  } else if (isPickerKind(kindMeta)) {
    const stepper = el(doc, "div", "wtn-ctl-stepper");
    const left = el(doc, "span", "wtn-ctl-arrow wtn-ctl-left");
    const combo = el(doc, "div", "wtn-ctl-combo");
    const val = el(doc, "span", "wtn-ctl-val");
    const caret = el(doc, "span", "wtn-ctl-caret");
    combo.appendChild(val);
    combo.appendChild(caret);
    const right = el(doc, "span", "wtn-ctl-arrow wtn-ctl-right");
    stepper.appendChild(left);
    stepper.appendChild(combo);
    stepper.appendChild(right);
    body.appendChild(stepper);
    Object.assign(refs, { stepLeft: left, stepRight: right, combo, val, caret });
  } else if (row.kind === "seed") {
    const val = el(doc, "span", "wtn-ctl-val");
    const mode = el(doc, "span", "wtn-ctl-mini");
    const newBtn = el(doc, "span", "wtn-ctl-mini");
    newBtn.textContent = "N";
    newBtn.title = "New seed now, then hold it fixed";
    // ↺ reuse-last-seed -- deliberately BETWEEN newBtn and the (possible)
    // ⚙ gear, appended below, so ⚙ stays the RIGHTMOST element before the
    // dot (render.mjs's own CSS comment on `.wtn-ctl-gear`, docs/control-
    // panel-design.md). Starts hidden -- paintRow decides visibility on
    // every repaint (this row has nothing to reuse until its first run).
    const reuseBtn = el(doc, "span", "wtn-ctl-mini wtn-ctl-hidden");
    reuseBtn.textContent = "↺";
    reuseBtn.title = "Reuse the last used seed and hold it fixed";
    body.appendChild(val);
    body.appendChild(mode);
    body.appendChild(newBtn);
    body.appendChild(reuseBtn);
    Object.assign(refs, { val, modeBtn: mode, newBtn, reuseBtn });
  } else if (row.kind === "int" || row.kind === "float") {
    rowEl.classList.add("wtn-ctl-slider");
    const fill = el(doc, "div", "wtn-ctl-fill");
    body.insertBefore(fill, name); // fill sits BEHIND name/value (z-index below via source order)
    const val = el(doc, "span", "wtn-ctl-val");
    body.appendChild(val);
    Object.assign(refs, { fill, val });
  } else if (row.kind === "bool") {
    // The pack's ONE shared switch (`js/shared/fields.mjs`'s `buildSwitch`,
    // see this module's own import comment) -- non-`small` (30x16): this
    // row's own `.wtn-ctl-body` is 30px tall (`ROW_H`, this module's own
    // Resize section), and the seed row's `.wtn-ctl-mini` buttons -- the
    // closest existing furniture at this same row height -- already sit
    // around ~17px tall (9.5px font + 2px padding top/bottom), so the
    // switch's full 16px height reads as the SAME scale as everything else
    // already living in a Control Panel row; the `small` (13px) variant
    // would look undersized next to it. No label of its own here -- the
    // row's OWN `.wtn-ctl-name` (built above, every kind shares it) already
    // is this row's label, so this is the row's entire value area.
    const switchEl = buildSwitch(doc, !!row.value, false);
    body.appendChild(switchEl);
    refs.switchEl = switchEl;
  } else if (row.kind === "latent") {
    const val = el(doc, "span", "wtn-ctl-val");
    const dim = el(doc, "span", "wtn-ctl-dim");
    val.appendChild(dim);
    body.appendChild(val);
    Object.assign(refs, { val, dim });
  } else {
    // Every catalog kind is handled above (picker kinds -- sampler/scheduler/
    // unet/vae/clip -- via isPickerKind, seed/int/float/latent by name), so
    // this only fires for a genuinely unexpected kind -- keep a safe fallback
    // so that never crashes render.
    const val = el(doc, "span", "wtn-ctl-val");
    body.appendChild(val);
    refs.val = val;
  }

  if (kindMeta && kindMeta.hasGear) {
    const gear = el(doc, "span", "wtn-ctl-gear");
    gear.textContent = "⚙";
    gear.title = `${(kindMeta.menu || row.kind)} settings`;
    body.appendChild(gear);
    refs.gear = gear;
  }

  // Direct child of rowEl (a SIBLING of body, never inside it) -- see this
  // function's opening comment.
  const dot = el(doc, "div", "wtn-ctl-dot");
  rowEl.appendChild(dot);
  refs.dot = dot;

  return refs;
}

/** Repaint `refs` from the CURRENT `row`/`optionList`/`disabledReason` --
 * cheap, called on every value edit (drag frame, list pick, seed roll…)
 * WITHOUT rebuilding any DOM structure, so an open overlay anchored to this
 * row stays valid. */
export function paintRow(refs, row, optionList, disabledReason) {
  const { root, name, kindMeta } = refs;
  name.textContent = row.name || row.kind;
  root.title = disabledReason || "";
  root.classList.toggle("wtn-ctl-disabled", !!disabledReason);

  if (row.kind === "auto") {
    return;
  }

  if (isPickerKind(kindMeta)) {
    const list = Array.isArray(optionList) ? optionList : [];
    const idx = Math.max(0, list.indexOf(row.value));
    const value = list.length ? String(list[idx] ?? list[0]) : "";
    // The picker's DISPLAY VALUE (`unet`/`vae`/`clip` rows are real
    // filenames; `sampler`/`scheduler` values have no extension, so this is
    // a no-op for them) -- `row.value`/`list` above are the wire IDENTITY and
    // are never touched.
    refs.val.textContent = value ? displayRowName(value) : (disabledReason ? "unavailable" : "");
    refs.val.title = value || "";
  } else if (row.kind === "seed") {
    // "-1" is the "you won't know until it runs" convention (mirrors stock
    // ComfyUI's own randomize-seed widget display) -- ONLY for `randomize`.
    // The STORED value underneath stays the real number (still reachable by
    // the ⚙ popover's `value` field -- `interaction.mjs`'s
    // `buildSeedPopover` reads `row.value` directly and is never told about
    // this display substitution -- and still what actually reaches the
    // backend through `panel_state`), so the row's label is the only thing
    // that shows "intent" instead of "truth"; every other mode paints the
    // real number, same as before.
    refs.val.textContent = row.opts.after === "randomize" ? "-1" : row.value;
    const on = row.opts.after !== "fixed";
    refs.modeBtn.textContent = AFTER_LETTER[row.opts.after] || "R";
    refs.modeBtn.classList.toggle("wtn-ctl-on", on);
    refs.modeBtn.title = `After each run: ${row.opts.after} -- click to ${on ? "hold it fixed" : `resume ${row.opts.lastMode}`}`;
    // ↺ reuse-last-seed: shown whenever there IS a `lastUsed` to go back to
    // -- full stop, regardless of the current mode. Deliberately NOT also
    // gated on `after !== "fixed"` (the old rule): that made the button
    // vanish out from under the cursor the instant it was clicked, since the
    // click itself pins `after = "fixed"`, which then hid the very button
    // that was just pressed. A no-op restore while already `fixed` (value
    // already equals `lastUsed`) is harmless -- one rule, "there is a
    // last-used seed to go back to," is easier to reason about than one that
    // also depends on the mode. `N` (roll a new seed now) stays the
    // always-available control for every mode; `↺` is specifically "go back
    // to what the last run used." Hidden, not merely disabled, when there's
    // nothing yet to reuse -- see this module's `.wtn-ctl-hidden` CSS.
    if (refs.reuseBtn) {
      const showReuse = row.opts.lastUsed != null;
      refs.reuseBtn.classList.toggle("wtn-ctl-hidden", !showReuse);
    }
  } else if (row.kind === "int" || row.kind === "float") {
    refs.fill.style.width = `${numericPercent(row)}%`;
    refs.val.textContent = formatNumericValue(row);
  } else if (row.kind === "bool") {
    // Toggle the switch's own `wtn-fld-on` class straight -- `buildSwitch`
    // (`js/shared/fields.mjs`) returns a bare element with no `setValue`
    // helper of its own (unlike `buildBoolField`, which this row does NOT
    // use -- see this module's import comment: a Control Panel row already
    // carries its own `.wtn-ctl-name` label, so wrapping in a second,
    // label-carrying field would duplicate it).
    if (refs.switchEl && refs.switchEl.classList && typeof refs.switchEl.classList.toggle === "function") {
      refs.switchEl.classList.toggle("wtn-fld-on", !!row.value);
    }
  } else if (row.kind === "latent") {
    const { main, dim } = formatLatentValue(row);
    refs.val.firstChild ? (refs.val.firstChild.textContent = "") : null; // no-op guard for stub doms
    refs.val.textContent = main + " ";
    refs.val.appendChild(refs.dim);
    refs.dim.textContent = dim;
  } else if (refs.val) {
    refs.val.textContent = row.value == null ? (disabledReason ? "unavailable" : "") : String(row.value);
  }
}

/** Builds the "+ Add control" / "+ Add loader" strip. */
export function buildAddRow(doc, label) {
  const btn = el(doc, "button", "wtn-ctl-add wtn");
  btn.type = "button";
  btn.textContent = label;
  return { root: btn, btn };
}

/** Builds a rename `<input>` for swapping in place of a row's `.wtn-ctl-name`
 * label, pre-filled with `value` -- pure DOM construction only, per this
 * module's split; `interaction.mjs` owns the actual swap-in/swap-out and the
 * commit/cancel/blur event wiring (`beginRename`). */
export function buildNameInput(doc, value) {
  const input = el(doc, "input", "wtn-ctl-name-edit wtn");
  input.type = "text";
  input.value = value;
  return input;
}

// ---------------------------------------------------------------------------
// Overlays: option list menu / ⚙ popover / right-click menu -- all appended
// to document.body and positioned from an anchor element's own
// getBoundingClientRect(). See this module's top doc comment.
// ---------------------------------------------------------------------------

/**
 * Opens a themed overlay anchored to `anchorEl`. `placement` is `"below"`
 * (option list: drops below the row, at the row's own width) or `"right"`
 * (⚙ popover / context menu: opens beside the row). Returns `{ overlay,
 * close }`; `close()` removes it and detaches its own outside-click/Escape
 * listeners. Only ONE overlay is ever open at a time (closing any previous
 * one first) -- mirrors `js/prompt_rules/node/picker.mjs`'s single-instance
 * pattern.
 *
 * A thin wrapper over `js/shared/overlay.mjs`'s `openOverlay` — the actual
 * anchoring/dismiss/viewport-flip mechanism was EXTRACTED there while
 * building `js/anima/` (`docs/generator-design.md` §12: "reuse the Control
 * Panel's overlay helper ... do not reimplement the anchoring"), so this
 * pack has exactly one implementation, not a fork. Only the CSS hook
 * (`"wtn-ctl-overlay wtn"`, asserted by this file's own `test_resize.mjs`)
 * stays Controls-specific.
 */
export function openOverlay(doc, anchorEl, contentEl, placement, onClose) {
  return sharedOpenOverlay(doc, anchorEl, contentEl, placement, onClose, "wtn-ctl-overlay wtn");
}

// ---------------------------------------------------------------------------
// Resize (legacy litegraph primary; Nodes 2.0 forward-compat kept minimal --
// see index.js). Body height is PURE ARITHMETIC on row count -- no DOM
// measurement needed (see this module's top doc comment).
// ---------------------------------------------------------------------------

export const ROW_H = 30;
export const ROW_GAP = 7;
export const ADD_H = 28;
export const BODY_PAD = 9;
export const MIN_W = 300;
export const DEFAULT_W = 328;

/** Total body height for `rowCount` rows -- rows + gaps + the "+ Add" strip
 * + its own gap + top/bottom body padding. Never needs the live DOM. */
export function bodyHeight(rowCount) {
  const n = Math.max(0, rowCount);
  return BODY_PAD * 2 + n * (ROW_H + ROW_GAP) + ADD_H;
}
