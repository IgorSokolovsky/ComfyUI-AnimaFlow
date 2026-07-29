/**
 * ## Module contract (2026-07-29, seed-row/field-library dispatch)
 *
 * **This is the pack's field library.** Every node UI in this repo composes
 * its body out of the builders exported below (a pill switch, a numeric drag
 * row, a stepper, a seed row, a plain text field, a bool field, a sub-label,
 * a "section unavailable" block, the ⓘ/⚙ glyphs) rather than hand-rolling an
 * equivalent locally. **A track that needs a new field adds it HERE** (or
 * reuses an existing export) — never as a local variant sitting only in that
 * track's own `render.mjs`. This is the concrete lesson of the seed field:
 * an earlier dispatch built a fresh `buildSeedField` here while `js/
 * controls/` already had a complete seed affordance, AND laid the Generator's
 * seed out as two stacked rows (value, then a separate mode stepper) instead
 * of matching the Control Panel's one-row-plus-gear shape — both mistakes
 * this comment exists to stop from recurring.
 *
 * **What does NOT belong here: rows, sockets, slots.** A Controls *row*
 * (`js/controls/render.mjs`'s `buildRowElement`) is a different thing from a
 * FIELD — it's the OUTER, unclipped positioning context for a litegraph
 * output socket, a slot, and drag-to-reorder (that file's own top doc
 * comment). Nothing with socket/slot/output-dot bookkeeping ever moves into
 * this module; only the field-level content a row or a section body wraps
 * around. `js/controls/rows.mjs`'s PURE maths (`clampNumeric`/`rangeOf`/
 * `clampSeedString`/etc) is a separate, one-directional import INTO this
 * file (see below) — that stays as-is, it's the reused arithmetic, not a
 * DOM shape.
 *
 * fields.mjs — small themed field primitives shared across tracks: a pill
 * switch, an info glyph, a drag-to-set numeric row with an inline fill, and a
 * `◀ [ value ] ▶` stepper row. Extracted while building `js/anima/`
 * (`docs/generator-design.md`'s frontend dispatch: "use our existing fields
 * from the control panel instead of creating new fields").
 *
 * **2026-07-28 (inline-sections dispatch)**: `buildGear`/`buildDrivenField`
 * are DELETED — both existed only to serve the row-anchored-popover design
 * (`docs/generator-design.md` §12's now-superseded entry): a gear opened a
 * popover, and a "driven" row showed a context-supplied value as static text
 * instead of a real (disabled) control. Neither has a second caller outside
 * `js/anima/`, and that track no longer needs either shape — sections expand
 * inline behind their own header (no gear to click), and a context-supplied
 * field renders as a genuinely disabled `buildNumericField`/
 * `buildStepperField` (both already accept `disabledReason`) rather than a
 * bespoke read-only row. `buildInfoIcon` is new: the one consistent ⓘ
 * affordance both a context-supplied field (yellow, `--wtn-warn`) and a
 * section's own explanatory note (default, `--wtn-info`) now share.
 *
 * ## What's genuinely reused from `js/controls/`, and what isn't
 *
 * `js/controls/rows.mjs` already owns the PURE maths behind a numeric drag
 * row (`rangeOf`/`clampNumeric`/`decimalsOf`/`numericPercent`/
 * `formatNumericValue`) — this module imports those functions directly
 * rather than re-deriving them, so the drag/clamp/format behaviour is
 * byte-identical to the Control Panel's own numeric rows. That import is
 * ONE-DIRECTIONAL (`shared` -> `controls/rows.mjs`) rather than the reverse:
 * `js/controls/render.mjs`'s DOM builders (`buildRowElement`/`paintRow`) are
 * inseparable from that track's per-row `addDOMWidget`-per-row architecture
 * and its output-socket-per-row bookkeeping (see that file's own top doc
 * comment) — refactoring THAT to sit on top of this module would be a
 * behavioural change to a track this task was told not to touch ("if reuse
 * would require changing Control Panel behaviour, don't; report it
 * instead"). So the DOM/CSS below is new, built to the same visual/
 * interaction language (drag-to-set with a fill, a stepper, a pill switch)
 * but decoupled from `row`/`opts`-shaped state and litegraph output
 * dots — callers bind it to whatever value they own via plain `getValue`/
 * `setValue` callbacks. `js/controls/` is completely unmodified by this file
 * (import-only, one direction) and keeps passing its own test suites
 * unchanged.
 *
 * No `node`/`app`/`LiteGraph` reference anywhere in this file — importable
 * under plain `node` (`js/anima/test_resize.mjs` does exactly that), same
 * convention as every other `render.mjs` in this pack.
 *
 * ## 2026-07-28 (bigger-type dispatch) — this module scales freely; `js/
 * controls/` never sees it
 *
 * `js/anima/`'s panel read too small at ~11.5-12px, so this file's base type
 * moved to 14px and every row height/glyph size scales with it (proportional
 * pass, not a font-size search-and-replace — see `js/anima/render.mjs`'s own
 * "Resize"-section doc comment for the derived constants this feeds:
 * `PANEL_MIN_H`/`PREVIEW_PANEL_MIN_H`/etc all recompute from the SAME row
 * heights this file now exports). The scale factor is `FLD_SCALE` below
 * (`14/12`), applied then rounded to a clean pixel — every row height this
 * file hands out is exported as a named constant for exactly that reason:
 * so a derived floor elsewhere in the pack can cite the real number rather
 * than a second hardcoded guess.
 *
 * This is safe to do UNSCOPED (no per-track CSS custom property, no class
 * gate) because `injectFieldStyles` — the only thing that ever puts this
 * file's CSS on the page — has exactly ONE caller anywhere in this repo:
 * `js/anima/render.mjs`'s `injectStyles`. Confirmed by grep, not assumed:
 * `js/controls/` never imports this module's CSS at all (it has its own,
 * separate `render.mjs`/`rows.mjs` styling and only ever reaches into this
 * file for the two exported BUILDERS it doesn't otherwise duplicate... which
 * is currently zero — `js/controls/` does not import this module at all).
 * So bumping every pixel value here changes exactly one rendered surface:
 * `js/anima/`'s. If a second track ever starts importing this file's CSS,
 * that importer becomes the one that needs scoping (a class on ITS root,
 * `--wtn-fld-*` custom properties) — not a reason to hold this file back.
 *
 * ## 2026-07-28 (stepper combo overflow fix, live-use report)
 *
 * The SAM3 checkpoint / upscale-model-name pickers (long filenames, e.g.
 * `sam3.1_multiplex_fp16.safetensors`) collided with their own label: `.wtn-
 * fld-combo-val` had `overflow:hidden`/`text-overflow:ellipsis` but no
 * `min-width: 0`, and a flex item's automatic minimum size is its own
 * `min-content` (the WHOLE string, for `white-space: nowrap` text) unless
 * something overrides it — so the ellipsis never actually engaged and the
 * value spilled left over the label instead of truncating. Paired with
 * `.wtn-fld-stepper-name`'s `flex: 0 4 auto` (tuned for `.wtn-fld-num`-style
 * rows, where the LABEL should give way first because the value is a short
 * number) the label lost the fight too — wrong priority for a row whose
 * VALUE, not its label, is the long free-form string.
 *
 * Fix, scoped to the STEPPER row only (`.wtn-fld-num`'s own shrink priority —
 * `docs/pixaroma-review-rounds-plan.md` Tier 2 item 8 — is untouched, and has
 * its own regression test): `.wtn-fld-stepper-name` no longer shrinks at all
 * (`flex: none` — every stepper label in this pack is one short word, so
 * "never truncate the label" costs nothing), and `.wtn-fld-combo-val` gets
 * `flex: 0 1 auto; min-width: 0` so it's the side that gives way and its
 * existing ellipsis rule finally has room to apply. The full value is also
 * set as a native `title` on the value span (not the themed `.wtn-tip`
 * mechanism — that's `buildInfoIcon`'s ⓘ, a different element; a native
 * `title` here doesn't compete with it) so a truncated filename is still
 * readable on hover.
 *
 * ## `buildInfoIcon`'s ⓘ — a real hover tooltip, not the native `title`
 *
 * The native `title` attribute's tooltip delay is the BROWSER's own
 * (~1s+) and isn't adjustable, so it read as "too slow" in live use.
 * `buildInfoIcon` no longer sets `title` at all (it sets `aria-label`
 * instead, so the text is still exposed to assistive tech) — it wires a
 * themed `.wtn-tip` element (the same component `js/shared/theme.css`
 * already defines) that shows after `INFO_TIP_DELAY_MS` of hover, hides
 * immediately on `mouseleave`/`pointerdown`/Escape, and is appended to
 * `doc.body` (never inside the icon's own node/panel — the Preview's panel
 * is `overflow: hidden` and would clip a tip mounted inside it).
 * `hideActiveInfoTip` (exported below) is the safety valve every full-body
 * repaint in this pack MUST call before replacing a body wholesale (`js/
 * anima/interaction.mjs`'s `repaintGenerator`/`repaintPreview`/
 * `teardownNode` do exactly that) — see `wireInfoTip`'s own doc comment for
 * why a rebuilt body would otherwise orphan a currently-showing tip
 * permanently on `document.body` (the old icon is discarded, but nothing
 * else would ever remove the tip it left behind).
 *
 * ## Importing `theme.mjs` — GUARDED dynamic import
 *
 * Same reasoning as every other themed module in this pack: this file is
 * imported by a headless test, so a static top-level import of the absolute
 * `/extensions/.../theme.mjs` path would throw before a single assertion
 * runs. This module's own CSS carries `var(--wtn-x, <fallback hex>)`
 * everywhere.
 */

import { rangeOf, clampNumeric, decimalsOf, numericPercent, formatNumericValue } from "../controls/rows.mjs";
import { getSetting, SETTING_IDS, SETTING_DEFAULTS } from "./settings.mjs";

const STYLE_ID = "wtn-fields-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly (see this module's doc
// comment for why these are hardcoded fallbacks rather than an import).
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
  info: "#7dd3fc",
  warn: "#fbbf24",
};

// Proportional-scale constants (bigger-type dispatch, this file's top doc
// comment) -- every row height/glyph size the CSS below uses is DERIVED from
// one of these, and each is exported so a consumer elsewhere in the pack
// (`js/anima/render.mjs`'s `PANEL_MIN_H`/`PREVIEW_PANEL_MIN_H`/etc arithmetic
// comments, this file's own test suite) cites the real number instead of a
// second hardcoded guess. `FLD_SCALE` is `14/12` -- base type moved from
// ~12px to 14px -- applied to the OLD value then rounded to a clean pixel;
// nothing here is derived by rounding-in-code (that would make the exported
// constant a moving target across a refactor), each is just written as the
// concrete pixel this dispatch settled on.
export const FLD_SCALE = 14 / 12;
export let FLD_FONT = 13.5; // base field font (was 11.5)
export let FLD_MONO = 13; // monospace value font (was 11)
export let FLD_ROW_H = 29; // .wtn-fld-num / .wtn-fld-stepper height (was 25)
export let FLD_ROW_GAP = 5; // row margin-bottom (was 4)
export let FLD_SWITCH_W = 30; // pill switch width (was 26)
export let FLD_SWITCH_H = 16; // pill switch height (was 14)
export let FLD_INFO_SIZE = 13; // ⓘ glyph font-size (was 11)

// Frozen at their 14px-baseline values (the numbers immediately above, as
// literals) -- `applyFieldFontScale` below always multiplies FROM these,
// never from its own previous output, so calling it twice with the same
// input is idempotent (no compounding) and calling it with a DIFFERENT input
// later fully replaces the previous scale rather than stacking on it.
const _FLD_BASE_PX = 14; // the "Node panel type size" setting's own default/baseline
const _FLD_DEFAULTS = {
  FLD_FONT: 13.5, FLD_MONO: 13, FLD_ROW_H: 29, FLD_ROW_GAP: 5,
  FLD_SWITCH_W: 30, FLD_SWITCH_H: 16, FLD_INFO_SIZE: 13,
};

function roundToHalf(x) {
  return Math.round(x * 2) / 2;
}

// **2026-07-28 (chevron/gear legibility fix, live bug report: "like a midget
// in a grass field")** -- the ⚙ used to share `FLD_INFO_SIZE` (13px) with the
// ⓘ, but the ⚙/▸ glyphs both render with heavy internal whitespace inside
// their own em box, so matching body text still read as tiny -- they need to
// sit noticeably ABOVE the row's 14px body text, not merely equal to it.
// `FLD_GEAR_SIZE` is derived from this file's own `FLD_FONT` (its 14px-scale
// counterpart) rather than a fourth independent guess, so it moves in step
// if the type scale ever changes again. `js/anima/render.mjs`'s own
// `SHEAD_GLYPH_SIZE` (the chevron's matching constant, derived from ITS base,
// `BASE_FONT`) intentionally lands on the SAME 17px -- see that file's own
// comment for why the two glyphs must read as one consistent size even
// though they're derived from two different files' base constants.
export let FLD_GEAR_SIZE = Math.round(FLD_FONT * 1.26); // 17
// The gear is also a click target (unlike the chevron) -- `FLD_GEAR_HIT` is
// the box the click actually lands in, deliberately bigger than the glyph
// needs to look (a comfortable >=20px square, this dispatch's own ask),
// built via `display:inline-flex` + explicit width/height rather than
// padding so the (still small) glyph centers exactly inside it. Derived from
// `FLD_GEAR_SIZE` itself rather than a fifth independent guess. It fits
// inside `js/anima/render.mjs`'s own `SHEAD_H` (32px header row) with room
// to spare, so growing the hit area does not grow the row.
export let FLD_GEAR_HIT = Math.round(FLD_GEAR_SIZE * 1.3); // 22

/**
 * Recompute every `FLD_*` constant above for a "Node panel type size (px)"
 * setting value of `px` — the SAME proportional pass this dispatch's own
 * doc comment describes ("every row height/glyph size scales with it"),
 * just made re-runnable instead of hand-settled once. `ratio = px /
 * _FLD_BASE_PX` (14, this file's own historical baseline); at `px === 14`
 * (the setting's documented default, or anything unset/garbage — see the
 * clamp below) every constant recomputes to EXACTLY its original literal
 * above, so calling this is a no-op in the common case. Always derives from
 * the FROZEN `_FLD_DEFAULTS`/`_FLD_BASE_PX` — never from the current (
 * possibly already-scaled) value of the constant itself — so repeated calls
 * are idempotent rather than compounding.
 *
 * `FLD_FONT`/`FLD_MONO` round to the nearest 0.5px (their own defaults, 13.5
 * and 13, aren't whole numbers); everything else rounds to the nearest
 * whole pixel. `FLD_GEAR_SIZE`/`FLD_GEAR_HIT` are NOT independently scaled —
 * they're recomputed from the (now-scaled) `FLD_FONT`/`FLD_GEAR_SIZE` via
 * their own existing formulas immediately above, so they never drift out of
 * the ratio those formulas already encode.
 *
 * Called from `js/anima/render.mjs`'s `injectStyles` (which also owns the
 * PANEL-side constants, `BASE_FONT`/`SHEAD_H`/the `*_MIN_H` floors) — see
 * that module's own "type scale" doc comment for why this whole pass only
 * ever runs once per page, atomically with the actual CSS build, rather
 * than being re-applied live.
 */
export function applyFieldFontScale(px) {
  const n = Number(px);
  const safePx = Number.isFinite(n) && n > 0 ? n : _FLD_BASE_PX;
  const ratio = safePx / _FLD_BASE_PX;
  FLD_FONT = roundToHalf(_FLD_DEFAULTS.FLD_FONT * ratio);
  FLD_MONO = roundToHalf(_FLD_DEFAULTS.FLD_MONO * ratio);
  FLD_ROW_H = Math.round(_FLD_DEFAULTS.FLD_ROW_H * ratio);
  FLD_ROW_GAP = Math.round(_FLD_DEFAULTS.FLD_ROW_GAP * ratio);
  FLD_SWITCH_W = Math.round(_FLD_DEFAULTS.FLD_SWITCH_W * ratio);
  FLD_SWITCH_H = Math.round(_FLD_DEFAULTS.FLD_SWITCH_H * ratio);
  FLD_INFO_SIZE = Math.round(_FLD_DEFAULTS.FLD_INFO_SIZE * ratio);
  FLD_GEAR_SIZE = Math.round(FLD_FONT * 1.26);
  FLD_GEAR_HIT = Math.round(FLD_GEAR_SIZE * 1.3);
  return ratio;
}

// A FUNCTION, not a module-level const string -- `applyFieldFontScale` (just
// above) mutates the `FLD_*`/`TOKENS`-adjacent constants this template
// interpolates, so the CSS text must be built AFTER that scale is applied
// (`injectFieldStyles` below does exactly that), not frozen at whatever
// values happened to hold at module-evaluation time.
function buildCss() {
  return `
/* ── pill switch ── */
.wtn-fld-switch { position: relative; width: ${FLD_SWITCH_W}px; height: ${FLD_SWITCH_H}px; flex: none; cursor: pointer;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 9px;
  transition: background .12s, border-color .12s; }
.wtn-fld-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px;
  border-radius: 50%; background: var(--wtn-ink-faint, ${TOKENS.inkFaint}); transition: transform .12s, background .12s; }
.wtn-fld-switch.wtn-fld-on { background: rgba(45,212,191,.22); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-fld-switch.wtn-fld-on::after { transform: translateX(14px); background: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-fld-switch.wtn-fld-sm { width: 23px; height: 13px; }
.wtn-fld-switch.wtn-fld-sm::after { width: 7px; height: 7px; top: 2px; left: 2px; }
.wtn-fld-switch.wtn-fld-sm.wtn-fld-on::after { transform: translateX(10px); }

/* ── info icon -- the one consistent ⓘ affordance (section-level help AND a
   context-supplied field's "why is this disabled" note). Default colour is
   the theme's neutral info token; .wtn-fld-info-warn swaps it for
   --wtn-warn -- reserved for "this value comes from somewhere else",
   never used for a plain explanatory note. ── */
.wtn-fld-info { flex: none; font-size: ${FLD_INFO_SIZE}px; line-height: 1; cursor: help;
  color: var(--wtn-info, ${TOKENS.info}); }
.wtn-fld-info-warn { color: var(--wtn-warn, ${TOKENS.warn}); }

/* ── ⚙ gear icon -- the ⓘ's sibling affordance for the long-tail "advanced
   fields" menu (task item 3 / \`js/anima/render.mjs\`'s \`buildSectionHeader\`).
   Same click-stops-propagation contract as \`buildInfoIcon\` (never toggles
   the header it lives in).

   **2026-07-28 (chevron/gear legibility fix)**: this used to sit at
   \`FLD_INFO_SIZE\` (13px, matching the ⓘ) on \`--wtn-ink-faint\` -- both too
   small AND too dim next to 14px body text (live bug report). Two changes,
   see \`FLD_GEAR_SIZE\`/\`FLD_GEAR_HIT\`'s own doc comments above for the
   sizing rationale: (1) the glyph itself grows to \`FLD_GEAR_SIZE\`, larger
   than body text on purpose; (2) the colour moves off \`--wtn-ink-faint\`
   (\`docs/THEME.md\`: "placeholders, disabled, idle" -- the wrong vocabulary
   for a live click target) onto \`--wtn-ink-dim\` ("secondary text, labels"
   -- the token that actually reads against \`--wtn-surface-2\`), the same
   swap \`js/anima/render.mjs\`'s \`.wtn-an-chev\` gets for the same reason.
   The click box itself is now \`FLD_GEAR_HIT\`, built via
   \`display:inline-flex\` + explicit width/height (not padding) so the glyph
   centers exactly inside a box bigger than it needs to look; a subtle hover
   background (mirrors \`js/shared/theme.css\`'s own \`.wtn-btn--icon:hover\`
   convention) makes that bigger hit area itself perceptible on hover, not
   just the glyph's own colour change. ── */
.wtn-fld-gear { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: ${FLD_GEAR_HIT}px; height: ${FLD_GEAR_HIT}px; border-radius: 6px;
  font-size: ${FLD_GEAR_SIZE}px; line-height: 1; cursor: pointer;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-fld-gear:hover, .wtn-fld-gear.wtn-fld-gear-active { color: var(--wtn-accent, ${TOKENS.accent});
  background: rgba(45,212,191,.12); }
/* 2026-07-29 (seed-row/field-library dispatch) -- a gear can disable
   coherently with the field it belongs to (the seed row's own ⚙: nothing to
   advance once the context supplies \`seed\` itself). \`pointer-events: none\`
   is the actual disable (no click reaches the handler at all, same as
   \`.wtn-fld-seed.wtn-fld-disabled .wtn-fld-seed-roll\`'s own rule); the
   opacity/cursor match every other \`.wtn-fld-disabled\` treatment in this
   file so a disabled gear reads the same dimmed way a disabled field does. */
.wtn-fld-gear.wtn-fld-disabled { opacity: .4; cursor: default; pointer-events: none; }

/* ── ⓘ hover tooltip -- this module's own fallback for js/shared/theme.css's
   \`.wtn-tip\` (this pack's convention: theme.css may not have landed). The
   tip element is appended to \`doc.body\` directly (see \`wireInfoTip\`'s doc
   comment), so it sits OUTSIDE any node's own \`.wtn\`-classed subtree and
   would never see that stylesheet's custom properties (they're scoped to
   \`.wtn\` itself) -- \`wireInfoTip\` gives the element the \`wtn\` class
   directly for exactly this reason (same fix \`js/anima/render.mjs\`'s old
   popover shell used for its own \`document.body\`-mounted element,
   \`"wtn-an-pop wtn"\`).

   Keeping BOTH \`wtn-tip\` (the house vocabulary -- theme.css's own rule, if
   it's landed, still applies) and \`wtn-fld-tip\` (this module's own
   fallback) on the same element is a cascade hazard on its own: theme.css's
   \`.wtn-tip\` rule has no hardcoded fallbacks and is injected via a LATER
   async \`import()\` (this file's own \`injectFieldStyles\`, below, runs its
   own CSS synchronously first), so at EQUAL specificity theme.css's rule
   wins by injection order and this module's fallbacks/10030 z-index never
   apply. The selector below is deliberately the TWO-CLASS compound
   \`.wtn-tip.wtn-fld-tip\` (specificity 0-2-0) rather than \`.wtn-fld-tip\`
   alone (0-1-0) -- that beats theme.css's single-class \`.wtn-tip\` (0-1-0)
   regardless of injection order, so the fallback hex values and the 10030
   z-index (js/controls/'s own overlays sit at 10020 -- a tooltip must sit
   above that) hold whether or not theme.css ever lands. Do NOT relax this
   back to \`.wtn-fld-tip\` alone -- that's exactly the invisible-until-live
   regression this comment exists to prevent. ── */
.wtn-tip.wtn-fld-tip { position: fixed; z-index: 10030; max-width: 260px; pointer-events: none;
  background: var(--wtn-console, ${TOKENS.console}); color: var(--wtn-ink, ${TOKENS.ink});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 8px; padding: 9px 11px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px; line-height: 1.45; box-shadow: 0 10px 28px rgba(0,0,0,.55);
  opacity: 0; transition: opacity .12s; }
.wtn-tip.wtn-fld-tip.show { opacity: 1; }

/* ── numeric drag row (Control Panel's own drag-to-set-by-dragging-the-row
   maths, ported behaviour -- see rangeOf/clampNumeric/numericPercent
   imported above) ── */
.wtn-fld-num { position: relative; display: flex; align-items: center; gap: 9px; height: ${FLD_ROW_H}px;
  padding: 0 9px; border-radius: 6px; overflow: hidden; cursor: ew-resize; margin-bottom: ${FLD_ROW_GAP}px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font-size: ${FLD_FONT}px; }
.wtn-fld-num.wtn-fld-disabled { cursor: default; opacity: .55; }
.wtn-fld-num-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 6px 0 0 6px;
  background: linear-gradient(90deg, rgba(45,212,191,.30), rgba(45,212,191,.16));
  border-right: 1px solid var(--wtn-accent-deep, ${TOKENS.accentDeep}); pointer-events: none; }
/* Same shrink-priority convention as js/controls/render.mjs's
   .wtn-ctl-name/.wtn-ctl-val (Tier 2 item 8, docs/pixaroma-review-rounds-
   plan.md, extended to this track): the name gets a heavier shrink factor
   so it gives way toward its min-width FIRST, the value is preferred.
   .wtn-fld-num's own container already carries overflow: hidden (a few
   lines up) as the backstop, and there's no output dot to protect here
   (this track has no per-row litegraph sockets) -- no row/body split
   needed, unlike the Control Panel's fix. UNCHANGED by the stepper-combo
   fix below -- this row's value is always a short number, so the label
   giving way first is still the right call, and its own test asserts this
   priority explicitly so the stepper fix below can never regress it. */
.wtn-fld-num-name { position: relative; z-index: 1; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap;
  flex: 0 4 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.wtn-fld-num-val { position: relative; z-index: 1; margin-left: auto; font-family: var(--wtn-font-mono, monospace);
  font-size: ${FLD_MONO}px; color: var(--wtn-ink, ${TOKENS.ink}); white-space: nowrap;
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* ── ◀ [ value ▾ ] ▶ stepper row ── */
.wtn-fld-stepper { position: relative; display: flex; align-items: center; gap: 9px; height: ${FLD_ROW_H}px;
  padding: 0 9px; border-radius: 6px; margin-bottom: ${FLD_ROW_GAP}px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font-size: ${FLD_FONT}px; overflow: hidden; }
.wtn-fld-stepper.wtn-fld-disabled { opacity: .55; }
/* 2026-07-28 (stepper combo overflow fix, this file's top doc comment) --
   the label NEVER shrinks here (every stepper label in this pack is one
   short word) -- it's the value (a picker's value can be a long filename)
   that has to give way, so the priority is the OPPOSITE of .wtn-fld-num-name
   just above, deliberately. */
.wtn-fld-stepper-name { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap; flex: none; }
.wtn-fld-stepper-body { margin-left: auto; display: flex; align-items: center; gap: 7px; min-width: 0; }
.wtn-fld-arrow { width: 0; height: 0; flex: none; cursor: pointer; opacity: .92;
  border-top: 6px solid transparent; border-bottom: 6px solid transparent; }
.wtn-fld-arrow.wtn-fld-left { border-right: 9px solid var(--wtn-accent, ${TOKENS.accent}); }
.wtn-fld-arrow.wtn-fld-right { border-left: 9px solid var(--wtn-accent, ${TOKENS.accent}); }
.wtn-fld-arrow:hover.wtn-fld-left { border-right-color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-fld-arrow:hover.wtn-fld-right { border-left-color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-fld-combo { position: relative; display: flex; align-items: center; gap: 6px; min-width: 0; cursor: pointer; flex: 1 1 auto; }
/* The overflow fix itself: flex: 0 1 auto + min-width: 0 is what lets the
   existing overflow:hidden/text-overflow:ellipsis below actually engage --
   without min-width:0 a nowrap text node's automatic flex-basis IS its full
   min-content width, so it never shrinks and the ellipsis never fires (the
   bug report this fixes). */
.wtn-fld-combo-val { font-family: var(--wtn-font-mono, monospace); font-size: ${FLD_MONO}px; color: var(--wtn-ink, ${TOKENS.ink});
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 0 1 auto; min-width: 0; }
.wtn-fld-caret { width: 0; height: 0; flex: none; transform: translateY(1px);
  border-left: 5px solid transparent; border-right: 5px solid transparent;
  border-top: 6px solid var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-fld-combo:hover .wtn-fld-combo-val { color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-fld-combo:hover .wtn-fld-caret { border-top-color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }

/* ── seed row: text entry + roll -- NOT a drag row (a seed runs to
   2**64-1; a slider over that range is unusable, and holding it as a JS
   number rounds past Number.MAX_SAFE_INTEGER -- see js/anima/state.mjs's
   own doc comment). Same box/height/font as .wtn-fld-num so it sits flush
   with every other row in the same section, but the interaction is direct
   text entry (clamped on commit by the CALLER -- this module has no
   opinion on the -1 "random" sentinel) plus a roll button, never a drag. ── */
.wtn-fld-seed { position: relative; display: flex; align-items: center; gap: 9px; height: ${FLD_ROW_H}px;
  padding: 0 9px; border-radius: 6px; margin-bottom: ${FLD_ROW_GAP}px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font-size: ${FLD_FONT}px; }
.wtn-fld-seed.wtn-fld-disabled { opacity: .55; }
.wtn-fld-seed-name { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap; flex: none; }
/* min-width: 0 -- same reasoning as .wtn-fld-num-val: a 20-digit seed must
   be free to shrink/scroll inside the box rather than blowing out the row. */
.wtn-fld-seed-input { flex: 1 1 auto; min-width: 0; margin-left: auto; text-align: right;
  font-family: var(--wtn-font-mono, monospace); font-size: ${FLD_MONO}px; color: var(--wtn-ink, ${TOKENS.ink});
  background: transparent; border: none; outline: none; padding: 0; }
.wtn-fld-seed-input::placeholder { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-fld-seed.wtn-fld-disabled .wtn-fld-seed-input { pointer-events: none; }
.wtn-fld-seed-roll { flex: none; cursor: pointer; font-size: ${FLD_MONO}px; line-height: 1;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-fld-seed-roll:hover { color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-fld-seed.wtn-fld-disabled .wtn-fld-seed-roll { pointer-events: none; cursor: default; }

/* ── the four builders below this file's "Local field builders, moved from
   js/anima/render.mjs" section -- CSS moved here VERBATIM (2026-07-29,
   seed-row/field-library dispatch) along with the JS. Class names are
   UNCHANGED (\`wtn-an-field\`/\`wtn-an-boolfield\`/\`wtn-an-sublab\`/
   \`wtn-an-missing\`, still \`an\`-prefixed) even though the builders now
   live in a shared module -- \`js/anima/test_resize.mjs\` asserts on these
   exact class names in dozens of places, and this is a pure relocation, not
   a rename; renaming would be its own (untested-by-this-dispatch) churn for
   no behavioural gain. If a SECOND track ever reuses these builders, that's
   the point to revisit the naming -- not before. ── */
.wtn-an-field { display: flex; align-items: center; gap: 9px; font-size: 13.5px; margin-bottom: 2px; }
.wtn-an-field > span { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); width: 135px; flex: none; }
.wtn-an-field input { flex: 1; min-width: 0; font-family: var(--wtn-font-mono, monospace);
  font-size: 13px; color: var(--wtn-ink, ${TOKENS.ink}); background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 5px; padding: 5px 7px; outline: none; }
.wtn-an-field input:focus { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

.wtn-an-boolfield { display: flex; align-items: center; gap: 9px; font-size: 13.5px; margin-bottom: 5px; }
.wtn-an-boolfield > span:first-child { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-an-boolfield > span:last-child { margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 12px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }

.wtn-an-sublab { font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; letter-spacing: .13em; text-transform: uppercase;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin: 14px 0 8px; padding-top: 12px; border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  display: flex; align-items: center; gap: 7px; }
.wtn-an-sublab:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.wtn-an-missing { display: flex; align-items: center; gap: 9px; font-size: 13px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  padding: 11px 12px; border-radius: 8px; margin-bottom: 12px; background: rgba(251,191,36,.06); border: 1px solid rgba(251,191,36,.28); }
`;
}

/**
 * `fontPx` (optional) — the "Node panel type size (px)" setting value to
 * scale every `FLD_*` constant to (`applyFieldFontScale`, above). Omit it to
 * have this function resolve the live setting itself (`getSetting`) — the
 * path any caller OTHER than `js/anima/render.mjs`'s `injectStyles` takes;
 * that one caller already resolved the setting itself (so both modules
 * agree on the exact same px value) and passes it straight through instead.
 * Applied atomically with the CSS text built below, guarded by the SAME
 * `STYLE_ID`-existence check that already made this function idempotent —
 * see `applyFieldFontScale`'s own doc comment for why a later, per-call
 * re-read would let the JS-side `FLD_*` constants and the already-injected
 * stylesheet disagree.
 */
export function injectFieldStyles(doc, fontPx) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
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
  const resolvedFontPx = fontPx !== undefined
    ? fontPx
    : getSetting(SETTING_IDS.NODE_PANEL_FONT_SIZE, SETTING_DEFAULTS[SETTING_IDS.NODE_PANEL_FONT_SIZE]);
  applyFieldFontScale(resolvedFontPx);
  const style = targetDoc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = buildCss();
  const host = targetDoc.head || targetDoc.body || targetDoc;
  if (host && typeof host.appendChild === "function") {
    host.appendChild(style);
  }
}

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

// ---------------------------------------------------------------------------
// Switch / info icon
// ---------------------------------------------------------------------------

export function buildSwitch(doc, on, small) {
  return el(doc, "span", `wtn-fld-switch${small ? " wtn-fld-sm" : ""}${on ? " wtn-fld-on" : ""}`);
}

/** Default delay (ms) between a hover starting and the ⓘ's tooltip actually
 * appearing -- see this module's top doc comment for why this replaces the
 * native `title` attribute's unadjustable browser delay. Exported so it's
 * still directly referenceable (tests, the "Tooltip delay (ms)" Settings-
 * dialog default); the LIVE value `wireInfoTip` actually schedules its
 * timer with is `resolveInfoTipDelayMs()` below, which reads the Settings-
 * dialog value fresh on every hover (never captured once at module load —
 * a genuinely live setting, unlike "Node panel type size"). */
export const INFO_TIP_DELAY_MS = 250;

/** The delay `wireInfoTip`'s hover timer actually uses -- `getSetting` read
 * live on every call, falling back to `INFO_TIP_DELAY_MS` for anything
 * unset/garbage. */
function resolveInfoTipDelayMs() {
  const value = getSetting(SETTING_IDS.TOOLTIP_DELAY_MS, SETTING_DEFAULTS[SETTING_IDS.TOOLTIP_DELAY_MS]);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : INFO_TIP_DELAY_MS;
}

function winOf(doc) {
  return (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
}

/** Only one ⓘ tooltip is ever shown pack-wide at a time (mirrors
 * `js/shared/overlay.mjs`'s `activeOverlayRef` singleton, same reasoning:
 * only one such floating thing should ever be open across the whole page).
 * Holds the CURRENTLY showing tip's own `hide` closure, or `null`. */
let activeTipHide = null;

/** The safety valve every full-body repaint MUST call before tearing down
 * the DOM subtree an open tooltip's icon lives in -- see `wireInfoTip`'s own
 * doc comment for the orphan this prevents. A no-op when nothing is
 * showing. */
export function hideActiveInfoTip() {
  if (activeTipHide) {
    activeTipHide();
  }
}

/** Clamp a `{left, top}` tooltip position so it never runs off the
 * right/bottom edge of the viewport -- same flip-if-off-screen idea as
 * `js/shared/overlay.mjs`'s own `reposition()`, reused here in miniature
 * (that module's own clamp is entangled with its "below"/"right" placement
 * modes and outside-click teardown, so this re-derives just the clamp
 * arithmetic rather than importing something shaped for a different job).
 * `null` viewport width/height (every existing headless test, and any host
 * with no live `window`) means never clamp -- same "no real viewport, don't
 * guess" contract `overlay.mjs`'s `viewportSize` uses. */
function clampTipPosition(doc, anchorRect, tipRect) {
  const win = winOf(doc);
  const vw = win && typeof win.innerWidth === "number" ? win.innerWidth : null;
  const vh = win && typeof win.innerHeight === "number" ? win.innerHeight : null;
  const w = (tipRect && tipRect.width) || 0;
  const h = (tipRect && tipRect.height) || 0;
  let left = anchorRect.left;
  let top = anchorRect.bottom + 6;
  if (vw != null && w && left + w > vw) {
    left = vw - w - 4; // clamp off the right edge
  }
  if (vh != null && h && top + h > vh) {
    top = anchorRect.top - h - 6; // flip: open ABOVE the icon instead
  }
  if (vw != null) {
    left = Math.max(4, Math.min(left, vw - 4));
  }
  if (vh != null) {
    top = Math.max(4, Math.min(top, vh - 4));
  }
  return { left, top };
}

/** Wires the real hover tooltip behind one ⓘ icon -- see this module's top
 * doc comment. One tip element per icon, created lazily on the FIRST show
 * and torn down completely (removed from `doc.body`, its own keydown
 * listener detached) on every hide, never left around hidden-but-attached.
 *
 * **Why a rebuilt body can't orphan this**: this track (`js/anima/`)
 * replaces its ENTIRE body on every repaint, discarding the old icon
 * element outright -- if that icon's tip happened to be showing at that
 * exact moment, nothing would ever fire `mouseleave` on the now-detached
 * icon to clean it up, and the tip (appended to `doc.body`, NOT inside the
 * body being replaced) would sit there forever. `activeTipHide`/
 * `hideActiveInfoTip` above is the fix: a caller that's about to replace a
 * body calls `hideActiveInfoTip()` FIRST, which closes whatever tip is
 * currently showing (there is only ever at most one, pack-wide) before the
 * icon that owns it is discarded. */
function wireInfoTip(doc, icon, tooltip) {
  const win = winOf(doc);
  let tipEl = null;
  let pendingToken = null;

  function onKeydown(e) {
    if (e && e.key === "Escape") {
      hide();
    }
  }

  function hide() {
    pendingToken = null;
    if (tipEl) {
      if (tipEl.parentNode && typeof tipEl.parentNode.removeChild === "function") {
        tipEl.parentNode.removeChild(tipEl);
      }
      tipEl = null;
      if (win) {
        win.removeEventListener("keydown", onKeydown, true);
      }
    }
    if (activeTipHide === hide) {
      activeTipHide = null;
    }
  }

  function show() {
    if (tipEl || !doc.body || typeof doc.body.appendChild !== "function") {
      return;
    }
    if (activeTipHide && activeTipHide !== hide) {
      activeTipHide(); // only one tip visible pack-wide at a time
    }
    activeTipHide = hide;
    // `wtn` is REQUIRED here, not decorative -- this element is appended to
    // `doc.body`, outside any node's own `.wtn`-classed subtree, so without
    // it theme.css's custom properties (`--wtn-console`/`--wtn-ink`/etc,
    // scoped to `.wtn`) never resolve on it at all. See this file's CSS
    // comment on `.wtn-tip.wtn-fld-tip` for the matching specificity fix.
    tipEl = el(doc, "div", "wtn-tip wtn-fld-tip wtn");
    tipEl.textContent = tooltip;
    doc.body.appendChild(tipEl);
    const rect = typeof icon.getBoundingClientRect === "function"
      ? icon.getBoundingClientRect()
      : { left: 0, top: 0, right: 0, bottom: 0 };
    const tipRect = typeof tipEl.getBoundingClientRect === "function" ? tipEl.getBoundingClientRect() : null;
    const { left, top } = clampTipPosition(doc, rect, tipRect);
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
    if (tipEl.classList && typeof tipEl.classList.add === "function") {
      tipEl.classList.add("show");
    }
    if (win) {
      win.addEventListener("keydown", onKeydown, true);
    }
  }

  icon.addEventListener("mouseenter", () => {
    const token = {};
    pendingToken = token;
    if (win && typeof win.setTimeout === "function") {
      win.setTimeout(() => {
        if (pendingToken === token) {
          pendingToken = null;
          show();
        }
      }, resolveInfoTipDelayMs());
    } else {
      pendingToken = null;
      show();
    }
  });
  // A pointer leaving before the delay elapses cancels the pending show
  // (the `pendingToken` guard inside the timer callback above); a pointer
  // leaving AFTER the tip is already showing hides it immediately -- same
  // handler covers both, `hide()` is a no-op if nothing is showing yet.
  icon.addEventListener("mouseleave", hide);
  icon.addEventListener("pointerdown", hide);
}

/** The one ⓘ affordance this pack's `js/anima/` sections use for BOTH
 * section-level help (default, `--wtn-info`) and "this value is driven from
 * somewhere else" (`warn: true`, `--wtn-warn` -- the yellow the Context
 * Bridge dispatch specifically asked for, never invented). `tooltip` is
 * exposed via `aria-label` (assistive tech still gets the text) rather than
 * the native `title` attribute -- see this module's top doc comment for why
 * (the browser's own tooltip delay isn't adjustable, and setting BOTH would
 * show two tooltips at once). This glyph has no click behaviour of its own
 * beyond `stopPropagation`, so a click never bubbles into a section
 * header's own expand/collapse toggle if a caller nests this INSIDE a
 * clickable header. */
export function buildInfoIcon(doc, tooltip, warn) {
  const icon = el(doc, "span", `wtn-fld-info${warn ? " wtn-fld-info-warn" : ""}`);
  icon.textContent = "ⓘ";
  if (tooltip) {
    icon.setAttribute("aria-label", tooltip);
    wireInfoTip(doc, icon, tooltip);
  }
  icon.addEventListener("click", (e) => {
    if (typeof e.stopPropagation === "function") {
      e.stopPropagation();
    }
  });
  return icon;
}

/** The ⚙ affordance behind `docs/generator-design.md` §12's HYBRID reversal
 * (`js/anima/render.mjs`'s top doc comment carries the full rationale):
 * essentials stay inline, the long tail of a section's fields lives behind
 * this glyph instead. Deliberately just the glyph + the SAME `stopPropagation`
 * contract `buildInfoIcon` already has -- the actual menu it opens (anchored,
 * `placement: "right"`) is `js/anima/interaction.mjs`'s job, since opening one
 * needs `ctx`/overlay-ownership machinery this pure-DOM module doesn't carry.
 * `onClick(event)` is the caller's own handler; this function does not open
 * anything itself. `active` toggles `.wtn-fld-gear-active` (matches `js/
 * controls/render.mjs`'s own `.wtn-ctl-gear.wtn-ctl-active` convention) so a
 * caller can highlight the gear while ITS OWN menu is the one currently open. */
export function buildGearIcon(doc, tooltip, onClick, active) {
  const icon = el(doc, "span", `wtn-fld-gear${active ? " wtn-fld-gear-active" : ""}`);
  icon.textContent = "⚙";
  if (tooltip) {
    icon.setAttribute("aria-label", tooltip);
  }
  icon.addEventListener("click", (e) => {
    if (typeof e.stopPropagation === "function") {
      e.stopPropagation();
    }
    if (typeof onClick === "function") {
      onClick(e);
    }
  });
  return icon;
}

// ---------------------------------------------------------------------------
// Numeric drag row -- ported behaviour from `js/controls/interaction.mjs`'s
// `wireNumericRow` (drag-across-the-row-to-set, live paint on every move,
// `onCommit` only at release) over `js/controls/rows.mjs`'s pure maths.
// `getValue`/`setValue` bind this to whatever field the caller owns (a path
// in a settings tree here, `row.value` there) -- this module never holds the
// value itself.
// ---------------------------------------------------------------------------

/**
 * `spec`: `{ label, kind: "int"|"float", opts: {min,max,step}, getValue,
 * setValue, disabledReason }`. `onCommit(value)` fires once per drag
 * (pointerup/cancel) and once for a fresh build (so a caller that persists
 * on commit doesn't need a separate initial-persist path). Returns
 * `{ root, val, fill, repaint() }`.
 */
export function buildNumericField(doc, spec, onCommit) {
  const { label, kind, opts, getValue, setValue, disabledReason } = spec;
  const root = el(doc, "div", `wtn-fld-num${disabledReason ? " wtn-fld-disabled" : ""}`);
  if (disabledReason) {
    root.title = disabledReason;
  }
  const fill = el(doc, "div", "wtn-fld-num-fill");
  const name = el(doc, "span", "wtn-fld-num-name");
  name.textContent = label;
  const val = el(doc, "span", "wtn-fld-num-val");
  root.appendChild(fill);
  root.appendChild(name);
  root.appendChild(val);

  const repaint = () => {
    const row = { value: getValue(), opts };
    fill.style.width = `${numericPercent(row)}%`;
    val.textContent = formatNumericValue(row);
  };
  repaint();

  if (!disabledReason) {
    let dragging = false;
    const setFromClientX = (clientX) => {
      const rect = typeof root.getBoundingClientRect === "function" ? root.getBoundingClientRect() : null;
      if (!rect || !Number.isFinite(rect.width) || rect.width <= 0) {
        return;
      }
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const [min, max] = rangeOf(opts);
      setValue(clampNumeric(kind, min + pct * (max - min), opts));
      repaint();
    };
    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      dragging = true;
      if (typeof root.setPointerCapture === "function") {
        root.setPointerCapture(e.pointerId);
      }
      setFromClientX(e.clientX);
    });
    root.addEventListener("pointermove", (e) => {
      if (dragging) {
        setFromClientX(e.clientX);
      }
    });
    const stop = () => {
      if (dragging) {
        dragging = false;
        if (typeof onCommit === "function") {
          onCommit(getValue());
        }
      }
    };
    root.addEventListener("pointerup", stop);
    root.addEventListener("pointercancel", stop);
  }

  return { root, val, fill, repaint };
}

// ---------------------------------------------------------------------------
// Stepper row -- ported behaviour from `wireComboRow`: arrows cycle through
// `options` immediately; clicking the value itself is left to the caller
// (`onOpenList`), since opening a themed overlay list needs the caller's own
// `ctx`/ownership-toggle machinery (`js/shared/overlay.mjs`).
// ---------------------------------------------------------------------------

/** `spec`: `{ label, value, options: string[], disabledReason }`.
 * `onChange(nextValue)` fires when an arrow cycles the value; `onOpenList
 * (comboEl, currentValue)` fires when the value/caret itself is clicked.
 * Returns `{ root, val, comboEl, repaint(value), getValue() }`.
 *
 * **`currentValue`/`getValue()` — the stale-captured-value fix (third
 * instance of the same defect family in one dispatch: a captured snapshot
 * where a live read was needed).** The arrows cycle the displayed value via
 * `repaint()` WITHOUT rebuilding this field, so a caller that captured
 * `spec.value` at build time (as `js/anima/interaction.mjs`'s `buildAnStepper`
 * used to, passing it straight through to `onOpenList`) goes stale the moment
 * an arrow moves the value: opening the option list after that highlights the
 * OLD entry. This module now OWNS the current value (`currentValue`, updated
 * by every `repaint()` call, arrow-driven or caller-driven) and hands it to
 * `onOpenList` itself, so no caller needs its own bookkeeping to stay
 * correct — and `getValue()` is exposed on the returned ref too, for a caller
 * that needs a live read outside the `onOpenList` callback (mirrors
 * `buildNumericField`'s own `getValue`-not-a-captured-constant contract). */
export function buildStepperField(doc, spec, { onChange, onOpenList } = {}) {
  const { label, value, options, disabledReason } = spec;
  const root = el(doc, "div", `wtn-fld-stepper${disabledReason ? " wtn-fld-disabled" : ""}`);
  if (disabledReason) {
    root.title = disabledReason;
  }
  const name = el(doc, "span", "wtn-fld-stepper-name");
  name.textContent = label;
  root.appendChild(name);

  const body = el(doc, "div", "wtn-fld-stepper-body");
  const left = el(doc, "span", "wtn-fld-arrow wtn-fld-left");
  const combo = el(doc, "div", "wtn-fld-combo");
  const val = el(doc, "span", "wtn-fld-combo-val");
  const caret = el(doc, "span", "wtn-fld-caret");
  combo.appendChild(val);
  combo.appendChild(caret);
  const right = el(doc, "span", "wtn-fld-arrow wtn-fld-right");
  body.appendChild(left);
  body.appendChild(combo);
  body.appendChild(right);
  root.appendChild(body);

  let currentValue = value;

  // `val.title` (native, not the themed `.wtn-tip` mechanism -- that's
  // `buildInfoIcon`'s ⓘ, a different element, never doubled up on this one)
  // is the stepper-combo-overflow fix's own readability half: a long value
  // (a picker's filename) still reads on hover even once the ellipsis
  // above has truncated it on screen.
  const repaint = (v) => {
    currentValue = v;
    const text = v == null ? "" : String(v);
    val.textContent = text;
    val.title = text;
  };
  repaint(value);

  if (!disabledReason) {
    const list = Array.isArray(options) ? options : [];
    const cycle = (dir) => {
      if (!list.length) {
        return;
      }
      const idx = Math.max(0, list.indexOf(val.textContent));
      const next = list[(idx + dir + list.length) % list.length];
      repaint(next);
      if (typeof onChange === "function") {
        onChange(next);
      }
    };
    left.addEventListener("click", (e) => {
      e.stopPropagation();
      cycle(-1);
    });
    right.addEventListener("click", (e) => {
      e.stopPropagation();
      cycle(1);
    });
    combo.addEventListener("click", (e) => {
      e.stopPropagation();
      if (typeof onOpenList === "function") {
        onOpenList(combo, currentValue);
      }
    });
  }

  return { root, val, comboEl: combo, repaint, getValue: () => currentValue };
}

// ---------------------------------------------------------------------------
// Seed row -- text entry + roll, replacing a drag-to-set numeric row for a
// value that runs to 2**64-1 (`js/anima/state.mjs`'s own doc comment has the
// full "why": a slider over that range is unusable, and holding it as a JS
// number rounds past `Number.MAX_SAFE_INTEGER`). This module stays agnostic
// of Anima's own `-1` "random" sentinel -- `onCommit` receives the RAW typed
// text and the CALLER clamps it (`js/anima/state.mjs`'s `normalizeSeed`),
// same split of responsibility `buildNumericField`/`buildStepperField` above
// already have (this module owns DOM + wiring, the caller owns value
// semantics).
// ---------------------------------------------------------------------------

/**
 * `spec`: `{ label, value, disabledReason }`. `value` is stringified as-is
 * for display (a seed is already a string in state by the time this is
 * called — `js/anima/state.mjs`'s own contract — but this accepts a number
 * too, so a run-reported value can be handed straight through without the
 * caller stringifying it first). `onCommit(rawTypedText)` fires on `change`
 * (native blur-with-a-different-value) and on Enter; `onRoll()` fires when
 * the roll glyph is clicked. Returns `{ root, input, roll, repaint(value) }`.
 */
export function buildSeedField(doc, spec, { onCommit, onRoll } = {}) {
  const { label, value, disabledReason } = spec;
  const root = el(doc, "div", `wtn-fld-seed${disabledReason ? " wtn-fld-disabled" : ""}`);
  if (disabledReason) {
    root.title = disabledReason;
  }
  const name = el(doc, "span", "wtn-fld-seed-name");
  name.textContent = label;
  root.appendChild(name);

  const input = el(doc, "input", "wtn-fld-seed-input");
  input.type = "text";
  if (typeof input.setAttribute === "function") {
    input.setAttribute("inputmode", "numeric");
  }
  input.value = value == null ? "" : String(value);
  input.disabled = !!disabledReason;
  root.appendChild(input);

  // A roll button, not letter-glyph text -- ⟳ reads as "generate a fresh
  // one" without needing its own label; `aria-label` carries the same
  // meaning for assistive tech.
  const roll = el(doc, "span", "wtn-fld-seed-roll");
  roll.textContent = "⟳";
  roll.setAttribute("role", "button");
  roll.setAttribute("aria-label", "Roll a new seed");
  root.appendChild(roll);

  const repaint = (v) => {
    input.value = v == null ? "" : String(v);
  };

  if (!disabledReason) {
    const commit = () => {
      if (typeof onCommit === "function") {
        onCommit(input.value);
      }
    };
    input.addEventListener("change", commit);
    // Enter commits immediately rather than waiting for a blur that may
    // never come (the field can stay focused) -- `preventDefault` guards
    // against a host page treating Enter as a form submission.
    input.addEventListener("keydown", (e) => {
      if (e && e.key === "Enter") {
        if (typeof e.preventDefault === "function") {
          e.preventDefault();
        }
        commit();
      }
    });
    roll.addEventListener("click", (e) => {
      if (typeof e.stopPropagation === "function") {
        e.stopPropagation();
      }
      if (typeof onRoll === "function") {
        onRoll();
      }
    });
  }

  return { root, input, roll, repaint };
}

// ---------------------------------------------------------------------------
// Local field builders, moved from js/anima/render.mjs (2026-07-29,
// seed-row/field-library dispatch). All four were already generic templates
// with no Anima-specific behaviour -- a plain labeled text input, a label +
// pill switch, an uppercase mono sub-label, and a "this section is
// unavailable" status block -- so they belong in the shared library this
// module's own top doc comment describes, not duplicated per track.
// `js/anima/render.mjs` re-exports every one of these under its OWN name
// (`export { buildTextField, buildBoolField, buildSublabel, buildMissing }
// from "../shared/fields.mjs"`) so no call site in that track (or its own
// test file) had to change. Class names are unchanged -- see this file's
// matching CSS comment, just above `buildCss`'s closing backtick, for why.
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

/** A label + this module's own pill switch (`buildSwitch`, above), with an
 * inline on/off word (mirrors this pack's inline-note habit rather than a
 * bare pill with no text). Returns `{ root, switchEl, word }`. */
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
 * pack's convention for a group-level explanatory note instead of a text
 * block eating vertical space). */
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
 * expanded section body when a required soft-import package is absent (a
 * section header's own ⓘ already carries the SAME text as its tooltip; this
 * is the body's fuller, always-visible restatement for when the section is
 * open). */
export function buildMissing(doc, str) {
  const m = el(doc, "div", "wtn-an-missing");
  const k = el(doc, "span");
  k.textContent = str;
  m.appendChild(k);
  return m;
}

