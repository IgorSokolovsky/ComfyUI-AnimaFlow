/**
 * lora_render.mjs — DOM building + injected CSS for `AnimaLoraLoader`
 * (`docs/lora-loader-design.md` §1a-ii, §1a-v, §6). Pure DOM construction
 * and painting only — no event listeners (`lora_interaction.mjs` wires
 * those) and no `node`/`app`/`LiteGraph` reference, so this module is
 * importable by the headless `test_lora_resize.mjs` under plain `node`
 * (mirrors `js/controls/render.mjs`'s own split, and its top doc comment's
 * reasoning for keeping DOM/CSS separate from event wiring).
 *
 * ## ONE `addDOMWidget` for the WHOLE node body, not one per row
 *
 * `js/controls/render.mjs`'s own top doc comment explains why the Control /
 * Loader Panels need one `addDOMWidget` PER ROW: each row parks its own
 * output socket at that row's Y, and legacy litegraph reads `output.pos`
 * verbatim, so each row needs its own `.y` to align against. **This node has
 * no per-row output sockets at all** (design doc §5: "this is NOT a layer-3
 * socket-rows consumer" — the three outputs are fixed `MODEL`/`CLIP`/
 * `triggers`, never one per LoRA) — so there is nothing for a per-row widget
 * to buy here, and one `addDOMWidget` hosting the header + every row (a
 * single flex-column root) is both simpler and cheaper: no per-row
 * `addDOMWidget` bookkeeping, no `node.widgets` splicing on reorder, and
 * `bodyHeight`-style arithmetic (below) still applies unchanged, since a
 * row's on-canvas height never varies after creation (same "no measuring
 * needed" property `render.mjs`'s own top doc comment states for the exact
 * same reason: overlays/popovers, once this track gets them in Slice 3/4,
 * are separate `document.body` overlays, never part of this root's own
 * flow height).
 *
 * ## BUG 3 (2026-07-29 owner report) — the header collided with the fixed
 * output sockets, and why
 *
 * `MODEL`/`CLIP`/`triggers` are three FIXED outputs at the node's top-right
 * (unlike Control/Loader Panel rows, which park their own socket at the
 * widget's own `.y` — see the doc comment above). Legacy litegraph reserves
 * a fixed vertical band above any widget for its slot column
 * (`max(inputCount, outputCount) * NODE_SLOT_HEIGHT`, decompiled from the
 * installed `comfyui_frontend_package` bundle per
 * `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`) — UNLESS
 * `node.widgets_start_y` is explicitly set, in which case that reservation is
 * bypassed entirely and the widget starts painting at exactly that Y,
 * regardless of the slot column. `lora_interaction.mjs` had copied Control
 * Panel's `node.widgets_start_y = 2` verbatim — correct THERE (Control parks
 * its own outputs at each row's widget `.y`, so nothing is lost), wrong HERE
 * (this node's outputs are drawn at their own native slot positions, which
 * `widgets_start_y = 2` then paints straight over). `SLOT_HEADER_H`/
 * `WIDGETS_START_Y` below are the fix: reserve the real slot-column height
 * (`INPUT_SLOT_COUNT`/`OUTPUT_SLOT_COUNT` below, matching
 * `nodes/controls/lora_loader.py`'s actual socket counts) before the widget
 * ever starts, mirroring litegraph's own default "+2" gap. See
 * `lora_interaction.mjs`'s own top doc comment for where these are consumed.
 *
 * ## Vocabulary: `.wtn-ctl-*` (owner's decision, 2026-07-29)
 *
 * This file reuses the `.wtn-ctl-row` / `.wtn-ctl-body` / `.wtn-ctl-name` /
 * `.wtn-ctl-grip` / `.wtn-ctl-gear` / `.wtn-ctl-val` selectors from
 * `js/controls/render.mjs` so a LoRA row reads as a sibling of a Control/
 * Loader Panel row, not a fourth, differently-themed row shape. Per that
 * file's own precedent (and `js/anima/render.mjs`'s identical choice), the
 * CSS is DUPLICATED here under this module's OWN `STYLE_ID`/TOKENS rather
 * than imported — every `render.mjs` in this pack injects its own
 * self-contained stylesheet (this is not new coupling; two independent
 * `<style>` blocks defining the same selector identically is harmless, and
 * keeps this module importable/testable with zero dependency on whether a
 * Control/Loader Panel node happens to exist on the same page). New,
 * genuinely LoRA-specific chrome (the header strip, the on/off switch, the
 * `N/M` counter, the strength stepper) gets its own `wtn-lora-*` names —
 * `js/shared/fields.mjs` is deliberately NOT used (design doc §0d, task
 * brief): this pack's field vocabulary here is `.wtn-ctl-*`.
 *
 * ## Row height is FIXED — no DOM measurement needed for resize
 *
 * Exactly like `render.mjs`'s `bodyHeight`: `contentHeight` below is pure
 * arithmetic on the row COUNT, matching this file's own CSS constants
 * (`ROW_H`/`ROW_GAP`/`HEADER_H`/`BODY_PAD`, plus the rows-card's own
 * `CARD_PAD`/`CARD_BORDER` — BUG 7, below) byte-for-byte, so
 * `lora_interaction.mjs`'s Class A sizing never has to read the live DOM.
 *
 * ## BUG 7 (2026-07-29 owner report) — the row floor, and the rows-card
 *
 * Two owner reports drove the width/layout constants below:
 *
 *   - At the shipped floor, `sepStrengths` on (two strength steppers per
 *     row) truncated names to ~6 characters and clipped the on/off switch
 *     under the node's right edge. The "M"/"C" letter tags that used to sit
 *     in each stepper cell are GONE now (their naming moved to a `title`
 *     tooltip — "Model strength"/"Clip strength" — on the stepper cell
 *     itself; fixed order, model always first), and every remaining control
 *     width below (`GRIP_W`/`INFO_W`/`SWITCH_W`/`STEPPER_W`) is a REAL CSS
 *     box size from this file's own CSS, not a guess — `MIN_W`/`MIN_W_SEP`
 *     are a straight sum of them plus `NAME_MIN_W` (the one deliberately
 *     chosen number here — see its own comment). `sepStrengths` therefore
 *     gets its OWN, higher floor (`MIN_W_SEP`) — `lora_interaction.mjs`'s
 *     `enforceWidthFloor` widens a too-narrow node up to whichever floor is
 *     current the moment the setting is toggled ON, and never shrinks one
 *     the user has already widened.
 *   - The owner also asked for the row list to sit in a bordered "card"
 *     (`js/shared/theme.css`'s `.wtn-card` idiom), with the row gap tightened
 *     to 4px — `ROW_GAP` below (was 7; `HEADER_GAP`, a NEW separate constant,
 *     keeps the header-to-card gap at the old 7, since that one is not "the
 *     gap between one row and the next"). Per `98d0fe5`/`a6478f0`'s own
 *     hard-won lesson (three live rounds on the Control Panel's own enabled-
 *     section border), the card's border is plain `--wtn-line-soft` — no
 *     accent at any alpha, full-strength or dimmed; the "own house style"
 *     conclusion from that saga generalizes here rather than being
 *     re-litigated per node.
 *
 * ## Icons: 🔍 is a CSS-mask glyph, ⚙ is the pack's plain glyph (BUG 19,
 * 2026-07-29 owner report)
 *
 * `🔍` is still drawn as a `mask-image` data-URI SVG tinted via `currentColor`
 * (`.claude/CLAUDE.md`, `js/prompt_rules/rule_builder/index.js:44-92`'s
 * precedent) — hand-rolled ring+handle geometry, not lifted from a named icon
 * set, so there is nothing to attribute. It is rendered **visibly disabled**
 * (BUG 6, 2026-07-29 owner report: it "looks live but does nothing") —
 * dimmed, `cursor: default`, and a `title` naming search as a later milestone
 * — because M2 (Civitai search) hasn't landed yet, and a normal-looking,
 * silently-inert button reads as broken rather than "not yet available".
 *
 * `⚙` used to be a SECOND hand-rolled mask SVG (`GEAR_ICON_SVG`, BUG 12) —
 * owner, 2026-07-29: "the settings icon is not good, it's not the same one we
 * use in our rows and other nodes." The actual problem BUG 12 didn't fix was
 * maintaining a second gear at all: the pack already has one, the plain `⚙`
 * textContent glyph `js/controls/render.mjs`'s own `.wtn-ctl-gear` (row
 * settings) and `js/shared/fields.mjs:822`'s `buildGearIcon` (Anima track)
 * both use. `js/controls/` deliberately does not import `js/shared/
 * fields.mjs` (an established layering rule for this track — see this file's
 * "Vocabulary" doc comment above for the matching `.wtn-ctl-*` rule), so this
 * header's `.wtn-lora-gear` matches `render.mjs`'s OWN plain-glyph CSS
 * directly (`icon.textContent = "⚙"` + font-size/color, no mask, no SVG)
 * rather than importing that dependency. `js/shared/fields.mjs:240-241`'s own
 * comment is why the size differs from the ⓘ/body text at all: the ⚙ glyph
 * renders with heavy internal whitespace inside its own em box, so a size
 * that reads correctly for other text reads "small" for this one glyph —
 * `render.mjs`'s row gear answers that at 14px in an 18px box; this header's
 * `.wtn-lora-icon` box is the SAME 18px used by the 🔍 beside it, so the gear
 * reuses that box rather than a new size, differing from `render.mjs` only
 * in needing explicit `display:flex`/centering (a row's gear is centred by
 * its OWN row's `align-items: center`; this header icon has no such parent
 * rule, so it centres itself).
 *
 * ## BUG (owner screenshot, 2026-07-31): the ⚙ is visibly smaller than the 🔍
 * beside it, in the SAME 18px `.wtn-lora-icon` box
 *
 * Diagnosed by comparing the two icons' own sizing MECHANISM, not by nudging
 * a number until it looked right: 🔍 is an SVG `mask-image` sized via
 * `mask-size: contain`, so its ink fills essentially the whole 18px box (the
 * search glyph's own bounding box already covers ~75%×63% of its 24×24
 * viewBox, and `contain` scales that viewBox to fill the box exactly). ⚙,
 * by contrast, is a plain-text glyph sized via `font-size` — and per this
 * file's OWN doc comment two paragraphs up (echoing `fields.mjs`'s "chevron/
 * gear legibility fix"), the Unicode gear symbol renders with heavy internal
 * whitespace inside its own em-square, so a `font-size` that LOOKS like it
 * should match a same-size mask icon renders visibly smaller in practice —
 * this was a font-size problem, not a box size (both icons already share the
 * same 18px `.wtn-lora-icon`) or a mask-size one (⚙ was never a mask at all,
 * so there was no `mask-size` to be wrong). The 14px this file previously
 * used was only a mild boost over the 12px body font it was set alongside
 * (`.wtn-lora-root`'s own `font: 12px/1 ...`) — nowhere near enough once
 * sitting directly beside a mask icon that fills its box. Fixed by applying
 * this SAME codebase's own already-validated correction ratio
 * (`fields.mjs`'s `FLD_GEAR_SIZE = Math.round(FLD_FONT * 1.26)`) to this
 * icon's own prior size rather than guessing fresh: `Math.round(14 * 1.26)`
 * = 18, which conveniently lands exactly on the shared icon box's own
 * height — see `.wtn-lora-icon.wtn-lora-gear`'s own `font-size` below.
 */

import { applyNodeChrome as sharedApplyNodeChrome } from "../shared/node_chrome.mjs";
// `hasFile` is the "unknown, not missing, before first load" cache read
// (`civitai_api.mjs`'s own top doc comment) -- track-agnostic, so importing
// it here does NOT violate the model_picker/civitai_api/model_info layering
// guard (that guard forbids the OPPOSITE direction: those three files must
// never import a `lora_*` module; a `lora_*` module importing THEM is the
// intended, allowed direction).
import { hasFile } from "./civitai_api.mjs";
// `displayRowName` is the settings-aware "hide file extension" seam (task
// brief, 2026-07-31, part B) -- see its own doc comment in `model_picker.mjs`
// for why importing it here is the allowed direction (that file's own top
// doc comment), and why it's the ONE place this row's label reads the live
// setting rather than `paintRow` reaching into `../shared/settings.mjs`
// itself.
import { displayRowName } from "./model_picker.mjs";
// `lora_state.mjs` is this node's OWN (non-track-agnostic) state model --
// importing it from here is unrestricted (the layering guard only forbids
// `model_picker.mjs`/`civitai_api.mjs`/`model_info.mjs` importing a `lora_*`
// module, never the reverse). Pulled in for Slice 5's ⚙ dialog: the strength
// bounds it validates its own numeric fields against, and the memory-mode
// label map its segmented buttons render.
import {
  STRENGTH_MIN,
  STRENGTH_MAX,
  STRENGTH_STEP_MIN,
  STRENGTH_STEP_MAX,
  CACHE_MODE_ORDER,
  CACHE_MODE_LABELS,
} from "./lora_state.mjs";

const STYLE_ID = "wtn-lora-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly (see this module's top doc
// comment for why every render.mjs in this pack keeps its own hardcoded
// fallback copy rather than importing one). `lineSoft` in particular is
// worth double-checking resolves (a missing token here left an inert
// `var(..., undefined)` at ten sites elsewhere in this pack, `a6478f0`) --
// it's present, below.
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

// ---------------------------------------------------------------------------
// Sizing / layout constants -- declared BEFORE the `CSS` template literal
// below so they can be interpolated straight into it (the one true source
// for both the painted CSS and the pure-arithmetic `contentHeight`/floor
// math -- no second, hand-kept-in-sync copy of any of these numbers).
// ---------------------------------------------------------------------------

export const ROW_H = 30;
// Vertical gap between ONE LORA ROW AND THE NEXT (owner, 2026-07-29 -- was
// 7). Distinct from `HEADER_GAP` below, which is a different gap (header
// strip -> rows-card) the owner did NOT ask to change.
export const ROW_GAP = 4;
export const HEADER_H = 30;
// BUG 10 (2026-07-29 owner report) established this as "the gap between the
// node's border and the card's border, 8px on all sides" -- but BUG 18
// (2026-07-29 owner report, screenshots) found BUG 10's own mechanism wrong:
// putting this on `.wtn-lora-root` AS PADDING meant left/right came out
// "roughly double" (root's own padding stacking with something else giving
// the card an additional offset) while the BOTTOM came out flush (0, not 8)
// against the node's own border. BUG 18's own fix moved it to a MARGIN on
// the header (top+left+right) and the card (left+right+bottom) instead --
// still 8px of node-edge gap, just carried differently.
//
// (2026-07-30 owner report): the node-edge gap itself is now REMOVED
// ENTIRELY, not moved again -- root carries no padding (unchanged since BUG
// 18) AND the header/card now carry no margin either, so no CSS rule below
// spends this constant as a node-edge inset anymore.
//
// (2026-07-30 owner report, corrected): a prior pass on this file also
// dropped this constant's own `* 2` term from `contentHeight()` and
// `OUTER_CHROME_W`, reasoning it was that same (now-removed) node-edge gap.
// Live testing showed that reasoning wrong: the term was accounting for the
// rows-CARD's own 8px padding (`.wtn-lora-rows-card`'s `CARD_PAD`, top+
// bottom for `contentHeight`, left+right for `OUTER_CHROME_W`) -- padding
// that is still very much there -- not for any root padding or margin. Both
// terms are restored (see each function's own comment); `BODY_PAD` itself
// still spends nothing in the CSS below, but the arithmetic needs it again.
export const BODY_PAD = 8;
// The gap between the header row and the rows-card below it (BUG 7's new
// card wrapper) -- kept at the ORIGINAL 7px `ROW_GAP` used to share with
// `ROW_GAP` above before the owner asked for the between-rows gap
// specifically to tighten to 4.
export const HEADER_GAP = 7;

// -- BUG 7/10: the rows-card wrapper -----------------------------------------
// Plain `--wtn-line-soft` border, per `98d0fe5`/`a6478f0`'s own hard-won
// conclusion (three live rounds on the Control Panel's enabled-section
// border: full accent too glaring, a dimmed accent still too light, plain
// `--wtn-line-soft` was the answer that stuck) -- this card never needed its
// own round of that argument because that lesson already generalizes.
export const CARD_BORDER = 1;
// BUG 10: "8px padding inside the card" -- already 8 (unchanged; confirmed,
// not lowered, since it was never larger than that in the first place).
export const CARD_PAD = 8;

// -- BUG 3: the fixed output-socket column ----------------------------------
// `NODE_SLOT_H` is litegraph's own `NODE_SLOT_HEIGHT` (decompiled from the
// installed `comfyui_frontend_package` bundle, 2026-07-29 --
// `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`'s own citation
// method: `grep NODE_SLOT_HEIGHT` in the bundle's `assets/*.js`). Litegraph
// reserves `max(inputCount, outputCount) * NODE_SLOT_H` above any widget by
// default; `nodes/controls/lora_loader.py`'s actual socket counts --
// `model`+`clip` (2 inputs), `MODEL`/`CLIP`/`triggers` (3 outputs, FIXED,
// never per-row -- design doc §5) -- are what `SLOT_HEADER_H` reserves here,
// explicitly, since `lora_interaction.mjs` sets `node.widgets_start_y`
// (which bypasses litegraph's own reservation entirely -- see this file's
// top doc comment for the decompiled formula that proves it).
export const NODE_SLOT_H = 20;
export const INPUT_SLOT_COUNT = 2; // model (required), clip (optional)
export const OUTPUT_SLOT_COUNT = 3; // MODEL, CLIP, triggers
export const SLOT_HEADER_H = Math.max(INPUT_SLOT_COUNT, OUTPUT_SLOT_COUNT) * NODE_SLOT_H; // 60
// "+2" mirrors litegraph's OWN default gap when `widgets_start_y` is left
// unset (`this.widgets_start_y ?? (this.widgets_up ? 0 : slotBottom) + 2` --
// see `lora_interaction.mjs`'s own top doc comment for the exact decompiled
// line) -- explicit here rather than measured, since the socket counts above
// are fixed and never vary per row.
export const WIDGETS_START_Y = SLOT_HEADER_H + 2; // 62

// -- BUG 7: row control widths -- every one of these matches a REAL CSS box
// size below; re-deriving MIN_W/MIN_W_SEP after a future CSS change is a
// matter of re-running this same sum, never eyeballing a new number.
export const GRIP_W = 9;
export const INFO_W = 18;
export const SWITCH_W = 30;
export const STR_VAL_W = 34;
export const STR_SPIN_W = 9;
// BUG 16 (2026-07-29 owner report): the vertical gap BETWEEN the ▲ and ▼
// glyphs themselves -- was 1px, read as cramped and made them an easy
// mis-tap (two adjacent click targets nearly flush). Owner's own range was
// 4-6px; 5 is the middle of it. Vertical-only, and comfortably clear of
// `ROW_H` (the spin column's own total height only grows from 11px to
// 15px -- arrow(5) + gap(5) + arrow(5) -- against a 30px row), so `ROW_H`/
// `contentHeight`/the width floors/BUG 15's drag pitch are all UNCHANGED --
// none of them derive from this number. The extra space goes entirely to
// separation between the two triangles -- their own border-drawn size
// (5px tall each) is untouched, so this doesn't shrink either click target.
export const SPIN_GAP = 5;
// Gap INSIDE one stepper cell, between its value and its ▲▼ -- the "M"/"C"
// tag that used to occupy this slot is GONE (BUG 7); the cell's `title`
// ("Model strength"/"Clip strength") carries that naming now.
export const STR_CELL_GAP = 5;
// `.wtn-ctl-body`'s own gap, AND `.wtn-lora-str`'s internal gap between the
// model/clip cells -- deliberately UNCHANGED (owner correction, 2026-07-29:
// intra-row control spacing was NOT part of the 4px change; only the
// between-ROWS gap, `ROW_GAP` above, was).
export const CTRL_GAP = 8;
export const ROW_PAD_L = 10;
// Bumped from 8 -- BUG 3/7's "reserve room for the socket column" applied to
// the row too, not just the header (the header's own fix is the vertical
// `WIDGETS_START_Y` above; this is the row's own defensive breathing room
// from the node's right edge).
export const ROW_PAD_R = 12;
// The one NUMBER in this whole derivation that's a deliberate choice rather
// than a measured CSS box size: picked to show roughly 16-18 characters of a
// real LoRA filename at 12px -- a straight improvement over the ~6 the BUG 7
// screenshot showed, without being so generous the floor balloons.
// VERIFY-IN-COMFYUI: real glyph metrics can't be rendered in this headless
// environment; eyeball against `playground/lora-loader.html` once landed.
export const NAME_MIN_W = 130;
// One stepper cell, no tag: value + gap + spinner.
export const STEPPER_W = STR_VAL_W + STR_CELL_GAP + STR_SPIN_W; // 48

// BUG 10 fix to BUG 7's own derivation, RE-DERIVED again for BUG 18: the
// row's available width is the node's width MINUS every layer of chrome
// between the node's outer edge and the row itself: `BODY_PAD` (per side),
// then the CARD's own left+right padding (`CARD_PAD`) AND its left+right
// border (`CARD_BORDER`).
//
// (2026-07-30 owner report, corrected): a prior pass on this file dropped
// the `BODY_PAD` term here on the theory that it double-counted the CSS
// margin BUG 18 had put on the header/card (since removed entirely). That
// was wrong -- see `BODY_PAD`'s own comment above for the live-tested
// correction: this term isn't the node-edge inset at all, it's part of the
// same accounting the height formula (`contentHeight`) restores for the
// same reason. Restored, in step with that fix -- `MIN_W`/`MIN_W_SEP`
// return to 323/379.
const OUTER_CHROME_W = 2 * BODY_PAD + 2 * CARD_PAD + 2 * CARD_BORDER;

// grip · gap · name · gap · ONE stepper · gap · ⓘ · gap · switch, plus the
// row's own left/right padding (4 gaps total between 5 children), plus
// every layer of surrounding chrome above.
const SINGLE_FIXED_W = OUTER_CHROME_W + GRIP_W + CTRL_GAP * 4 + STEPPER_W + INFO_W + SWITCH_W + ROW_PAD_L + ROW_PAD_R;
export const MIN_W = NAME_MIN_W + SINGLE_FIXED_W;

// `sepStrengths` on (§7b "Show two strengths per row") adds a SECOND
// stepper cell plus the gap between the two -- BUG 7's "two floors, not
// one".
const SEP_FIXED_W = SINGLE_FIXED_W + STEPPER_W + CTRL_GAP;
export const MIN_W_SEP = NAME_MIN_W + SEP_FIXED_W;

export const DEFAULT_W = 340;

// -- BUG 4: the '+ Add LoRA' button ------------------------------------------
// Content ("＋ Add LoRA", 12px/600) plus its own 11px-each-side padding --
// alongside (never instead of) the existing `max-width: 30%` cap, so the
// button never truncates at any width the header's OTHER controls
// (master/count/search/gear, comfortably under half of MIN_W together) leave
// room for. CSS `min-width` legitimately wins over a smaller `max-width` at
// very narrow widths (spec behaviour) -- that's the intended outcome here:
// readable over exactly-30%.
export const ADD_MIN_W = 112;

// ---------------------------------------------------------------------------
// Icons — CSS mask-image data URI (see this module's top doc comment; ⚙ is
// no longer one of these, BUG 19 -- it's the pack's plain textContent glyph,
// styled in the CSS below next to `.wtn-lora-search`).
// `<`/`>` percent-encoded (`%3C`/`%3E`) so the URL survives being embedded in
// a CSS `url(...)`, matching `js/prompt_rules/rule_builder/index.js`'s own
// `TOOLBAR_ICON_SVG` convention. Default SVG fill is black -- opaque enough
// for a mask (only alpha matters), no `fill=` attribute needed anywhere.
// ---------------------------------------------------------------------------

const SEARCH_ICON_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M11 4a7 7 0 104.418 12.44l4.571 4.571 1.415-1.415-4.572-4.572A7 7 0 0011 4zm-5 7a5 5 0 1110 0 5 5 0 01-10 0z'/%3E%3C/svg%3E";

const CSS = `
/* BUG 18 (2026-07-29 owner report): NO padding here anymore -- see
   'BODY_PAD''s own comment above for why root's own padding was the wrong
   place for "gap from the node's border" (it doubled left/right, went flush
   at the bottom). 'gap' stays -- that's the header-to-card gap
   ('HEADER_GAP'), never the node-edge one, so it is unaffected by this fix. */
.wtn-lora-root {
  display: flex; flex-direction: column; gap: ${HEADER_GAP}px; width: 100%; box-sizing: border-box;
  font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--wtn-ink, ${TOKENS.ink});
}

/* ── header strip: ＋ Add LoRA · slack · master switch · N/M · 🔍 · ⚙ ──
   the slack itself is .wtn-lora-master's own margin-left: auto rule,
   below -- this row is a plain flex container with no justify-content.
   (2026-07-30 owner report): NO margin here either, matching root's own "no
   padding" (BUG 18) -- the node-edge gap that used to live here (first as
   root padding, then as this margin, BUG 18) is REMOVED ENTIRELY now, not
   moved a third time; the owner tested this live and confirmed the node
   looks correct flush against its own border. */
.wtn-lora-header {
  display: flex; align-items: center; gap: 8px; height: 30px; flex: none;
}

/* Content + padding, capped at 30% of the node -- must NOT flex, or it grows
   without limit on a wide node while the switch/counter/icons stay fixed
   (design doc §1a-ii's whole reasoning for the cap). 'min-width' (BUG 4,
   2026-07-29 owner report: "+ Add Lo...", truncated even at the default
   width) is the OTHER half -- see this file's own 'ADD_MIN_W' comment for
   why the two co-exist rather than one replacing the other. */
.wtn-lora-add {
  flex: 0 0 auto; max-width: 30%; min-width: ${ADD_MIN_W}px; height: 30px; box-sizing: border-box;
  padding: 0 11px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent});
  border: 1px solid var(--wtn-accent, ${TOKENS.accent});
}
.wtn-lora-add:hover { background: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }

/* THE slack: pushes the master switch (and everything after it in DOM
   order -- count/search/gear, none of which carry their own auto-margin)
   flush against the header's right edge, leaving the deliberately-empty
   gap between '.wtn-lora-add' and here (design doc §1a-ii; matches
   'playground/lora-loader.html''s master-switch element,
   'style="flex:none;margin-left:auto"', verbatim). This is the ONE rule
   that actually creates the slack -- 'buildRoot' must put this class on the
   master element itself, or this rule has nothing to match. */
.wtn-lora-master { margin-left: auto; }

/* ── on/off switch -- shared shape for the master switch AND every row's
   own switch (design doc: row switch on the RIGHT, header switch reads
   "on" only when every row is on). ── */
.wtn-lora-switch {
  flex: none; width: 30px; height: 16px; border-radius: 9px; cursor: pointer; position: relative;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line});
}
.wtn-lora-switch::after {
  content: ""; position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--wtn-ink-faint, ${TOKENS.inkFaint}); transition: transform .12s;
}
.wtn-lora-switch.wtn-lora-on {
  background: rgba(45, 212, 191, .22); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep});
}
.wtn-lora-switch.wtn-lora-on::after { transform: translateX(14px); background: var(--wtn-accent, ${TOKENS.accent}); }

/* "2/3", no "on" word -- the switch beside it already says what the number
   means (design doc §1a-ii). */
.wtn-lora-count {
  flex: none; min-width: 26px; text-align: center; font-family: var(--wtn-font-mono, monospace);
  font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}

/* 🔍 / ⚙ -- shared 18px box only (this module's top doc comment: 🔍 stays a
   CSS-mask glyph, ⚙ is now the pack's plain '⚙' textContent glyph, BUG 19 --
   so the two no longer share a single "mask, tinted via background-color"
   rule; each gets its OWN look below, in the SAME box). */
.wtn-lora-icon { flex: none; width: 18px; height: 18px; cursor: pointer; }

/* 🔍 -- CSS-mask glyph, tinted via background-color (only alpha survives a
   mask, so "colour" here means "which solid colour paints the shape"). */
.wtn-lora-icon.wtn-lora-search {
  background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
  mask-position: center; -webkit-mask-position: center;
  mask-image: url("${SEARCH_ICON_SVG}"); -webkit-mask-image: url("${SEARCH_ICON_SVG}");
}
.wtn-lora-icon.wtn-lora-search:hover { background-color: var(--wtn-accent, ${TOKENS.accent}); }
/* Retired by M2 (docs/lora-loader-design.md §7c): BUG 6 (2026-07-29 owner
   report) used to render the 🔍 VISIBLY disabled via this class, because
   search/browse was unbuilt. It's live now (lora_interaction.mjs's
   wireHeader opens civitai_search.mjs on click) -- kept, unused, only in
   case a future "temporarily inert" affordance wants the same look; no
   element in this file carries it any more. */
.wtn-lora-icon.wtn-lora-icon-disabled { cursor: default; opacity: .45; }
.wtn-lora-icon.wtn-lora-icon-disabled:hover { background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }

/* ⚙ -- BUG 19 (2026-07-29 owner report: "the settings icon is not good,
   it's not the same one we use in our rows and other nodes") -- the pack's
   plain '⚙' textContent glyph, matching 'js/controls/render.mjs''s own
   '.wtn-ctl-gear' colour/hover treatment exactly (ink-faint -> accent),
   rather than importing 'js/shared/fields.mjs''s 'buildGearIcon' (this
   track deliberately does not depend on that file -- see this module's top
   doc comment). 'display:flex' + centering is the one thing this header's
   version needs that a row's gear doesn't: a row centres its gear via the
   ROW's own 'align-items: center'; this icon has no such parent rule of its
   own, so it centres itself in its 18px box instead -- same glyph, same
   size, only the centering mechanism differs (this file's own top doc
   comment: "adjust the sizing, not the glyph"). */
.wtn-lora-icon.wtn-lora-gear {
  display: flex; align-items: center; justify-content: center;
  /* 18px, not 14px (owner screenshot, 2026-07-31: "the ⚙ is smaller than the
     🔍") -- this file's own top doc comment has the full diagnosis: a
     font-size bump, not a box or mask-size change (14 * 1.26, the same
     ratio fields.mjs already validated for this exact glyph, rounds to 18,
     which happens to equal the shared icon box's own height). */
  font-size: 18px; line-height: 1; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
}
.wtn-lora-icon.wtn-lora-gear:hover { color: var(--wtn-accent, ${TOKENS.accent}); }

/* ── rows-CARD (BUG 7, owner request, 2026-07-29): wraps the rows host +
   empty state in the pack's '.wtn-card' idiom ('js/shared/theme.css'), but
   with a PLAIN '--wtn-line-soft' border, never an accent -- see this file's
   top doc comment for why that's settled rather than a fresh choice.
   (2026-07-30 owner report): NO margin either -- the node-edge gap this
   card's margin used to carry (BUG 18) is REMOVED ENTIRELY now, matching
   the header's own removal above; 'padding' below is the card's OWN inside
   and is unaffected by that removal. ── */
.wtn-lora-rows-card {
  border: ${CARD_BORDER}px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  border-radius: var(--wtn-radius, 10px); background: var(--wtn-surface, ${TOKENS.surface});
  padding: ${CARD_PAD}px; box-sizing: border-box;
}

/* ── rows host + empty state ── */
.wtn-lora-rows { display: flex; flex-direction: column; gap: ${ROW_GAP}px; }
.wtn-lora-empty {
  height: 30px; display: flex; align-items: center; justify-content: center;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 11.5px; font-style: italic;
}

/* ── a LoRA row -- reuses .wtn-ctl-row/.wtn-ctl-body from js/controls/
   render.mjs's own vocabulary (see this module's top doc comment) ── */
.wtn-ctl-row { position: relative; width: 100%; height: 30px; box-sizing: border-box; }
.wtn-ctl-body {
  position: relative; display: flex; align-items: center; gap: ${CTRL_GAP}px;
  width: 100%; height: 100%; box-sizing: border-box; padding: 0 ${ROW_PAD_R}px 0 ${ROW_PAD_L}px;
  border-radius: 7px; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); overflow: hidden;
  font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--wtn-ink, ${TOKENS.ink});
}
/* dragged row lifts -- transform/opacity/shadow only, matches the mockup's
   '.row.dragging' -- slight scale in ADDITION to opacity/shadow (design doc
   §1a-iii: "shadow, slight scale, reduced opacity"). */
.wtn-ctl-row.wtn-lora-dragging { opacity: .9; z-index: 5; transform: scale(1.015); }
.wtn-ctl-row.wtn-lora-dragging .wtn-ctl-body {
  border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); box-shadow: 0 8px 20px rgba(0,0,0,.5);
}
/* FLIP settle (§1a-iii, Slice 5): lora_interaction.mjs's flipRows (a thin
   wrapper over js/shared/flip.mjs's track-agnostic core -- see that
   module's own top doc comment) writes each surviving row's OWN
   inverse-translate as an inline transform the instant the new order
   paints, then -- one animation frame later -- adds THIS class and clears
   that inline style back to nothing, which is what turns "already there"
   into "glides there". transform is the ONLY property this rule ever
   touches -- never a layout property (this is a DOM widget composited over
   a canvas; animating layout there is visibly thrashy). prefers-reduced-
   motion is handled ENTIRELY by the media query below -- with the
   transition removed, the exact same set-transform-then-clear sequence
   simply snaps instead of gliding, so no JS branch is needed to honour it
   (matches the approved playground/lora-loader.html mockup's own
   .row.flip/@media pair verbatim). Class name is TRACK-NEUTRAL
   ('wtn-row-flip', not the old 'wtn-lora-flip') -- render.mjs (Control
   Panel) carries the byte-for-byte identical rule so both tracks share one
   class, one animation, from one shared JS core. */
.wtn-ctl-row.wtn-row-flip { transition: transform .18s cubic-bezier(.2, .7, .3, 1); }
@media (prefers-reduced-motion: reduce) {
  .wtn-ctl-row.wtn-row-flip { transition: none; }
}
/* an OFF row recedes -- name/strength/info dim, the switch itself (still the
   ONE thing that must stay fully legible) does not (design doc §1a-ii). */
.wtn-ctl-row.wtn-lora-off .wtn-ctl-name,
.wtn-ctl-row.wtn-lora-off .wtn-lora-str,
.wtn-ctl-row.wtn-lora-off .wtn-lora-icon-info { opacity: .45; }

.wtn-ctl-grip {
  flex: none; width: ${GRIP_W}px; height: 15px; cursor: grab; touch-action: none;
  background-image: radial-gradient(circle, var(--wtn-ink-faint, ${TOKENS.inkFaint}) 1.1px, transparent 1.3px);
  background-size: 4px 4px; opacity: .5;
}
.wtn-ctl-grip:hover { opacity: 1; }
.wtn-ctl-grip:active { cursor: grabbing; }

/* Name button -- content area 1: the LoRA's own name (or a placeholder), a
   trailing ▾ caret hinting the picker (Slice 3). 'flex: 1 1 auto' + 'min-
   width: 0' (BUG 7: "the name field takes the remaining space") is what
   actually lets it ellipsize under pressure -- a flex item's default min-
   width is its OWN content size, which defeats 'text-overflow: ellipsis'
   entirely until overridden. */
.wtn-ctl-name.wtn-lora-name {
  background: transparent; border: none; padding: 0; text-align: left; cursor: pointer;
  font: inherit; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 2px;
  overflow: hidden;
}
.wtn-ctl-name.wtn-lora-name:hover { color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-lora-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtn-lora-caret {
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 9px; margin-left: 4px; flex: none;
}
/* Missing-file mark (design doc §1a-iii): the WHOLE name field turns red,
   border included -- not just the text, so it reads at a glance even in a
   row scanned quickly. */
.wtn-ctl-name.wtn-lora-name.wtn-lora-missing {
  color: var(--wtn-bad, ${TOKENS.bad}); border: 1px solid var(--wtn-bad, ${TOKENS.bad});
  border-radius: 5px; padding: 0 4px; background: rgba(248, 113, 113, .08);
}
.wtn-ctl-name.wtn-lora-name.wtn-lora-missing:hover { color: var(--wtn-bad, ${TOKENS.bad}); }

/* Strength stepper -- value + stacked ▲▼, DRAWN triangles per this pack's
   own convention (render.mjs's '.wtn-ctl-arrow' comment: "a glyph's side
   bearing means padding can't ever render as an exact px value"). One
   '.wtn-lora-str' group holds TWO cells (model, clip) -- the clip one is
   hidden by default (single-strength mode, the default) and shown only when
   the ⚙ dialog's "Show two strengths per row" is on (§7b, Slice 5) --
   paintRow's own sepStrengths parameter toggles '.wtn-lora-two' on the
   group. BUG 7 (2026-07-29): the "M"/"C" letter tag each cell used to carry
   is GONE -- naming moved to the cell's own 'title' ("Model
   strength"/"Clip strength"), and the model cell is ALWAYS first, never
   reordered, since position is now the only thing telling the two apart.
   This keeps the SAME single top-level '.str' child the row's fixed
   grip/name/str/info/switch order already asserts (test_lora_resize.mjs's
   own "in that order" test) -- only its INSIDES change shape. */
.wtn-lora-str { display: flex; align-items: center; gap: ${CTRL_GAP}px; flex: none; }
.wtn-lora-str-cell { display: flex; align-items: center; gap: ${STR_CELL_GAP}px; }
.wtn-lora-str-clip { display: none; }
.wtn-lora-str.wtn-lora-two .wtn-lora-str-clip { display: flex; }
/* BUG 17 (2026-07-29 owner report): the strength value is now a real
   editable '<input>', not a static span -- the ▲▼ arrows alone meant
   changing 0.80 to 0.65 took seven clicks. 'box-sizing: border-box' keeps
   the OUTER width at the same ${STR_VAL_W}px the arithmetic in this file's
   own MIN_W/MIN_W_SEP derivation already assumes -- border+padding eat into
   the box's OWN content area, they don't add to its footprint, so neither
   floor needs to move. Blends in as plain text at rest (transparent
   background, transparent border) and only reveals itself as editable on
   hover/focus, so the row's at-rest look is unchanged from the old span. */
.wtn-lora-str-val {
  font-family: var(--wtn-font-mono, monospace); font-size: 11.5px; font-weight: 640;
  color: var(--wtn-ink, ${TOKENS.ink}); width: ${STR_VAL_W}px; text-align: right;
  box-sizing: border-box; background: transparent; border: 1px solid transparent;
  border-radius: 3px; padding: 0 2px; cursor: text; outline: none;
}
.wtn-lora-str-val:hover, .wtn-lora-str-val:focus {
  border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); background: var(--wtn-console, ${TOKENS.console});
}
.wtn-lora-spin { display: flex; flex-direction: column; gap: ${SPIN_GAP}px; width: ${STR_SPIN_W}px; align-items: center; }
.wtn-lora-arrow { width: 0; height: 0; cursor: pointer; opacity: .85; }
.wtn-lora-arrow:hover { opacity: 1; }
.wtn-lora-arrow.wtn-lora-up {
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-bottom: 5px solid var(--wtn-accent, ${TOKENS.accent});
}
.wtn-lora-arrow.wtn-lora-down {
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid var(--wtn-accent, ${TOKENS.accent});
}

/* ⓘ -- opens the info panel (Slice 4, model_info.mjs). Reuses the same
   slot .wtn-ctl-gear already defines. */
.wtn-ctl-gear.wtn-lora-icon-info { font-style: italic; font-weight: 700; }

/* ── row context menu (design doc §1a-iii, decision 23: "More info ·
   Duplicate · Disable/Enable · Remove") -- DUPLICATES js/controls/
   render.mjs's own .wtn-ctl-overlay/.wtn-ctl-menu/.wtn-ctl-opt/.wtn-ctl-mhead/
   .wtn-ctl-hint selectors byte-for-byte (this module's own top doc comment:
   every render.mjs in this pack injects its own self-contained stylesheet
   rather than importing a sibling's). .wtn-ctl-opt-disabled is new here --
   render.mjs has no "inert menu entry" concept, since none of its own rows
   have one; this node's "More info" (Slice 4) needs it. ── */
.wtn-ctl-overlay { position: fixed; z-index: 10020; }
.wtn-ctl-menu {
  max-height: 264px; overflow-y: auto; padding: 4px; border-radius: 8px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); background: var(--wtn-surface2, ${TOKENS.surface2});
  box-shadow: var(--wtn-shadow, 0 20px 44px rgba(0,0,0,.7));
}
.wtn-ctl-opt {
  font-family: var(--wtn-font-mono, monospace); font-size: 11.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  padding: 5px 6px; border-radius: 5px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wtn-ctl-opt:hover { background: var(--wtn-console, ${TOKENS.console}); color: var(--wtn-ink, ${TOKENS.ink}); }
.wtn-ctl-opt.wtn-ctl-opt-disabled { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); cursor: default; }
.wtn-ctl-opt.wtn-ctl-opt-disabled:hover { background: transparent; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-ctl-opt.wtn-ctl-opt-danger:hover { color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-ctl-mhead {
  font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; letter-spacing: .13em; text-transform: uppercase;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); padding: 4px 6px 6px;
}
.wtn-ctl-opt .wtn-ctl-hint { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 10.5px; margin-left: 6px; }

/* ── ⚙ settings dialog (design doc §7b, Slice 5) -- own 'wtn-lora-set-*'
   vocabulary (genuinely new chrome, not a .wtn-ctl-* row -- this file's own
   top doc comment's naming rule). Opened anchored to the header's ⚙ icon via
   the same 'openOverlayWithZoom' every other floating panel in this node
   uses; ✕ closes, no footer buttons (§7b: "edits apply immediately"). ── */
.wtn-lora-set {
  width: 300px; max-height: 78vh; overflow-y: auto; box-sizing: border-box;
  border-radius: 10px; background: var(--wtn-surface2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); box-shadow: var(--wtn-shadow, 0 20px 46px rgba(0,0,0,.66));
  font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-lora-set-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 11px; font-size: 12.5px; font-weight: 600;
  border-bottom: 1px solid var(--wtn-line, ${TOKENS.line});
}
.wtn-lora-set-title { flex: 1 1 auto; }
.wtn-lora-set-close { flex: none; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 13px; }
.wtn-lora-set-close:hover { color: var(--wtn-ink, ${TOKENS.ink}); }
.wtn-lora-set-body { padding: 10px 11px 11px; }
.wtn-lora-set-fld { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; }
/* BUG 5 (2026-07-29 owner report): "LoRA memory use" wrapped onto three
   lines because the label shared a horizontal row with the Standard/Fast/
   Lowest segmented control. This modifier stacks label-then-control
   instead, so the label gets the row's FULL width to lay out in. */
.wtn-lora-set-fld.wtn-lora-set-fld-stack { flex-direction: column; align-items: stretch; gap: 5px; }
/* BUG 9 (2026-07-29 owner report): with the stacked layout above, '.wtn-seg'
   itself already stretches to the row's full width ('align-items: stretch'
   on the row, no width of its own) -- but the THREE BUTTONS inside kept
   their own content widths (theme.css's shared '.wtn-seg button' rule is
   content-sized, by design -- see below), so "Standard" read wide, "Fast"/
   "Lowest" narrow, with dead space at the right. 'flex: 1 1 0' makes the
   three share the group's width evenly, so it reads as ONE control.
   SCOPED to this dialog's memory-mode row only ('.wtn-lora-set-fld-stack
   .wtn-seg', never a bare '.wtn-seg' rule) -- '.wtn-seg' is the pack's
   SHARED segmented-group class ('js/shared/theme.css'), also used by the
   Rule Builder's mode/profile tablists and the autocomplete picker's
   positive/negative tablist ('js/prompt_rules/rule_builder/overlay.mjs',
   'js/prompt_rules/node/picker.mjs') -- both of THOSE sit inline in a
   header row next to a title/other controls and rely on staying
   content-sized; changing the shared rule globally would have stretched
   them too. */
.wtn-lora-set-fld-stack .wtn-seg { display: flex; }
.wtn-lora-set-fld-stack .wtn-seg button { flex: 1 1 0; text-align: center; }
.wtn-lora-set-label { flex: 1 1 auto; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-lora-set-hint { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 10.5px; margin-top: 1px; line-height: 1.35; }
.wtn-lora-set-num {
  width: 62px; box-sizing: border-box; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink, ${TOKENS.ink});
  font: 11.5px var(--wtn-font-mono, monospace); padding: 4px 6px; border-radius: 5px; text-align: right;
}
.wtn-lora-set-text {
  width: 62px; box-sizing: border-box; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); color: var(--wtn-ink, ${TOKENS.ink});
  font: 11.5px var(--wtn-font-mono, monospace); padding: 4px 6px; border-radius: 5px;
}
`;

/**
 * Paints the legacy litegraph NODE ITSELF (body + title-bar strip) in our
 * theme -- thin delegation to `../shared/node_chrome.mjs`, same as
 * `js/controls/render.mjs`'s own `applyNodeChrome` (see that module's doc
 * comment for the full constraints: never overwrites an already-set
 * `node.color`/`node.bgcolor`, fresh-node path only).
 */
export function applyNodeChrome(node) {
  return sharedApplyNodeChrome(node);
}

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  // Guarded dynamic import -- same reasoning as every other render.mjs in
  // this pack (js/controls/render.mjs's own top doc comment): this file is
  // imported directly by the headless test suite, so a static top-level
  // import of the absolute `/extensions/.../theme.mjs` route would throw
  // before a single assertion runs.
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
// DOM construction
// ---------------------------------------------------------------------------

function el(doc, tag, className) {
  const e = doc.createElement(tag);
  if (className) {
    e.className = className;
  }
  return e;
}

/**
 * Builds the WHOLE node body once: header strip + rows-card (holding the
 * rows host + empty-state line, BUG 7). Returns every ref
 * `lora_interaction.mjs` needs to wire events onto or repaint. This is the
 * element handed to the node's single `addDOMWidget` call
 * (`lora_interaction.mjs`'s `setupLoraNode`).
 */
export function buildRoot(doc) {
  const root = el(doc, "div", "wtn-lora-root wtn");

  const header = el(doc, "div", "wtn-lora-header");
  const addBtn = el(doc, "button", "wtn-lora-add");
  addBtn.type = "button";
  addBtn.textContent = "＋ Add LoRA"; // fullwidth plus -- not an emoji
  addBtn.title = "Add a LoRA row";
  // `.wtn-lora-master` (in ADDITION to the shared `.wtn-lora-switch` shape)
  // is what actually carries `margin-left: auto` (see this module's CSS,
  // below) -- without this second class on the element itself, the CSS
  // rule has nothing to match and every header control bunches up on the
  // left. (Caught by review 2026-07-29: an earlier draft's CSS *comment*
  // claimed this mechanism existed while no element and no rule actually
  // did -- `buildRoot`/`.wtn-lora-header` regression tests below assert
  // both the class and the rule now, so that gap can't recur silently.)
  const master = el(doc, "div", "wtn-lora-switch wtn-lora-master");
  master.title = "Turn every LoRA on or off";
  const count = el(doc, "span", "wtn-lora-count");
  // BUG 6 (2026-07-29 owner report): "civitai icon button doesnt open" --
  // it WAS inert by design pre-M2 (visibly disabled via the now-removed
  // `wtn-lora-icon-disabled` class). M2 (docs/lora-loader-design.md §7c)
  // makes it live: `lora_interaction.mjs`'s `wireHeader` opens
  // `civitai_search.mjs`'s search panel on click. Its VISIBILITY (not its
  // enabled-ness) is still governed by the Civitai setting -- `syncRows`
  // hides it entirely when that setting is off (§7b decision 20), same as
  // before.
  const searchBtn = el(doc, "span", "wtn-lora-icon wtn-lora-search");
  searchBtn.title = "Browse Civitai";
  const settingsBtn = el(doc, "span", "wtn-lora-icon wtn-lora-gear");
  // BUG 19 (2026-07-29 owner report): the pack's own plain '⚙' glyph, not a
  // second hand-rolled mask SVG -- see this file's top doc comment.
  settingsBtn.textContent = "⚙";
  settingsBtn.title = "LoRA Loader settings";
  header.appendChild(addBtn);
  header.appendChild(master);
  header.appendChild(count);
  header.appendChild(searchBtn);
  header.appendChild(settingsBtn);

  // BUG 7 (owner request): the rows list sits in a bordered card, matching
  // the pack's own `.wtn-card` idiom -- see this file's top doc comment.
  const card = el(doc, "div", "wtn-lora-rows-card");
  const rowsHost = el(doc, "div", "wtn-lora-rows");
  const empty = el(doc, "div", "wtn-lora-empty");
  empty.textContent = "No LoRAs yet — click ＋ Add LoRA.";
  card.appendChild(rowsHost);
  card.appendChild(empty);

  root.appendChild(header);
  root.appendChild(card);

  return { root, header, addBtn, master, count, searchBtn, settingsBtn, card, rowsHost, empty };
}

/** Builds ONE strength cell (an editable value + ▲▼ stepper) -- shared
 * shape for the model and clip cells `buildRowElement` builds below.
 * `cellTitle` ("Model strength"/"Clip strength") is the cell's OWN identity
 * now that the "M"/"C" letter tag is gone (BUG 7, 2026-07-29) -- the
 * up/down arrows carry their own, more specific titles too ("Increase/
 * decrease model strength" etc), so hovering ANY part of the control names
 * what it does. The clip cell is hidden by default (single-strength mode);
 * `.wtn-lora-str.wtn-lora-two` (toggled by `paintRow`) reveals it.
 *
 * BUG 17 (2026-07-29 owner report): `val` is a real `<input>` now, not a
 * static span -- `lora_interaction.mjs`'s `wireRow` owns commit-on-blur/
 * Enter, Escape-to-revert, and `stopPropagation` (this module builds DOM
 * only, no listeners -- see this file's own top doc comment). `type="text"`
 * deliberately, not `type="number"`: a native number input can hide the RAW
 * typed string from JS entirely (browsers keep `.value` empty for genuinely
 * invalid text, so "abc"/"--1" would never even reach our own validation),
 * and this pack's own garbage-input contract (`lora_state.mjs`'s
 * `parseTypedStrength`) needs to see and handle that text itself rather
 * than trusting native number-input coercion. `inputmode="decimal"` still
 * hints a numeric keyboard on mobile/tablet despite `type="text"`. */
function buildStrCell(doc, cellTitle, extraClass, upTitle, downTitle) {
  const cell = el(doc, "div", `wtn-lora-str-cell${extraClass ? ` ${extraClass}` : ""}`);
  cell.title = cellTitle;
  const val = el(doc, "input", "wtn-lora-str-val");
  val.type = "text";
  val.inputMode = "decimal";
  val.spellcheck = false;
  val.title = cellTitle;
  const spin = el(doc, "div", "wtn-lora-spin");
  const up = el(doc, "span", "wtn-lora-arrow wtn-lora-up");
  up.title = upTitle;
  const down = el(doc, "span", "wtn-lora-arrow wtn-lora-down");
  down.title = downTitle;
  spin.appendChild(up);
  spin.appendChild(down);
  cell.appendChild(val);
  cell.appendChild(spin);
  return { cell, val, up, down };
}

/**
 * Builds ONE row's DOM: grip · name (▾) · strength stepper · ⓘ · switch
 * (design doc §1a-ii's row order). Pure construction, no listeners --
 * `lora_interaction.mjs`'s `wireRow` owns those.
 *
 * The strength "group" (`order[2]` in `test_lora_resize.mjs`'s own "in that
 * order" test) is still exactly ONE child of `body` -- `.wtn-lora-str` --
 * matching every pre-Slice-5 assertion about row shape; it just holds TWO
 * cells inside now (model + clip, model ALWAYS first -- BUG 7), the clip
 * one hidden unless the ⚙ dialog's "Show two strengths per row" (§7b) is on.
 */
export function buildRowElement(doc) {
  const rowEl = el(doc, "div", "wtn-ctl-row wtn");
  const body = el(doc, "div", "wtn-ctl-body");
  rowEl.appendChild(body);

  const grip = el(doc, "span", "wtn-ctl-grip");
  grip.title = "Drag to reorder";
  body.appendChild(grip);

  const nameBtn = el(doc, "button", "wtn-ctl-name wtn-lora-name");
  nameBtn.type = "button";
  const nameLabel = el(doc, "span", "wtn-lora-name-text");
  const caret = el(doc, "span", "wtn-lora-caret");
  caret.textContent = "▾"; // ▾ -- picker affordance, inert until Slice 3
  nameBtn.appendChild(nameLabel);
  nameBtn.appendChild(caret);
  body.appendChild(nameBtn);

  const str = el(doc, "div", "wtn-lora-str");
  // Fixed order: model strength FIRST, then clip -- ALWAYS (BUG 7). With the
  // "M"/"C" letters gone, position is the only thing distinguishing the two,
  // so this order must never vary between rows or modes.
  const model = buildStrCell(doc, "Model strength", "wtn-lora-str-model", "Increase model strength", "Decrease model strength");
  const clip = buildStrCell(doc, "Clip strength", "wtn-lora-str-clip", "Increase clip strength", "Decrease clip strength");
  str.appendChild(model.cell);
  str.appendChild(clip.cell);
  body.appendChild(str);

  const info = el(doc, "span", "wtn-ctl-gear wtn-lora-icon-info");
  info.textContent = "ⓘ"; // ⓘ -- not an emoji, a plain circled-letter glyph
  info.title = "LoRA info (coming soon)";
  body.appendChild(info);

  const sw = el(doc, "div", "wtn-lora-switch");
  sw.title = "Enable or disable this LoRA";
  body.appendChild(sw);

  return {
    root: rowEl,
    body,
    grip,
    nameBtn,
    nameLabel,
    caret,
    str,
    strVal: model.val,
    up: model.up,
    down: model.down,
    strValClip: clip.val,
    upClip: clip.up,
    downClip: clip.down,
    info,
    sw,
  };
}

/** Repaint one row's refs from the current `row` -- cheap, called on every
 * value edit (strength bump, on/off toggle) without touching DOM structure.
 * `sepStrengths` (§7b "Show two strengths per row", Slice 5) toggles
 * `.wtn-lora-two` on the strength group, which is what reveals the clip
 * cell via CSS (`lora_render.mjs`'s own CSS, above) -- defaults to falsy
 * (single-strength mode), unchanged from every pre-Slice-5 caller.
 *
 * Missing-file mark (design doc §1a-iii, "the WHOLE name field red, border
 * included"): `hasFile("loras", row.name)` is `null` until the list has
 * resolved at least once (`civitai_api.mjs`'s "unknown, not missing" rule)
 * -- an empty/unpicked row name (`row.name` falsy) is likewise never
 * "missing," it's simply unpicked. Only an EXPLICIT `false` (a real,
 * fetched list that genuinely doesn't contain this name) paints red.
 *
 * The label is DISPLAY, `row.name` is IDENTITY, and must never change (task
 * brief, 2026-07-31, part B) -- `displayRowName` (`model_picker.mjs`) is what
 * turns identity into what actually paints, reading the live "Hide file
 * extension" setting itself so this function never has to. The row's own
 * `title` tooltip always carries the REAL, untruncated/unstripped `row.name`
 * regardless of what the label shows, so hovering a hidden extension still
 * reveals it. */
export function paintRow(refs, row, sepStrengths) {
  refs.nameLabel.textContent = (row.name && displayRowName(row.name)) || "(pick a LoRA)";
  const missing = !!row.name && hasFile("loras", row.name) === false;
  refs.nameBtn.title = missing
    ? `Missing file: ${row.name} -- pick another LoRA`
    : row.name || "Click to pick a LoRA";
  // The label's OWN tooltip (in addition to the button's, above) -- always
  // the real, untruncated/unstripped name, so hovering it directly still
  // reveals the extension even when the display strips it.
  refs.nameLabel.title = row.name || "";
  refs.nameBtn.classList.toggle("wtn-lora-missing", missing);
  // BUG 17: `.value`, not `.textContent` -- the stepper's value is a real
  // `<input>` now. Repainting overwrites whatever the user may be mid-typing
  // (matches every other Class A repaint in this pack, e.g. the ⚙ dialog's
  // own numeric inputs -- there is no dedicated guard for "don't clobber a
  // focused field" anywhere else in this file either); a genuinely
  // mid-edit field is only ever repainted by an UNRELATED action elsewhere
  // triggering a full `syncRows`, not by anything the edit itself does
  // (typing never calls this function -- only commit/blur/Enter/Escape do).
  refs.strVal.value = row.sm.toFixed(2);
  if (refs.strValClip) {
    refs.strValClip.value = Number.isFinite(row.sc) ? row.sc.toFixed(2) : row.sm.toFixed(2);
  }
  if (refs.str && refs.str.classList) {
    refs.str.classList.toggle("wtn-lora-two", !!sepStrengths);
  }
  refs.root.classList.toggle("wtn-lora-off", !row.on);
  refs.sw.classList.toggle("wtn-lora-on", !!row.on);
}

/** Repaint the header from the current state's rows -- master switch on/off
 * + the `N/M` counter (design doc §1a-ii, decision 13). */
export function paintHeader(refs, rows, allOn, onCount) {
  refs.master.classList.toggle("wtn-lora-on", allOn);
  refs.count.textContent = rows.length ? `${onCount}/${rows.length}` : "—"; // em dash, no rows yet
}

// ---------------------------------------------------------------------------
// ⚙ settings dialog (design doc §7b, Slice 5) -- pure DOM construction only,
// same split as everything else in this file: `lora_interaction.mjs`'s
// `openLoraSettings` owns reading/writing state and wiring every listener.
// ---------------------------------------------------------------------------

function fieldRow(doc, labelText, hintText) {
  const row = el(doc, "div", "wtn-lora-set-fld");
  const label = el(doc, "div", "wtn-lora-set-label");
  const labelHead = el(doc, "span");
  labelHead.textContent = labelText;
  label.appendChild(labelHead);
  if (hintText) {
    const hint = el(doc, "div", "wtn-lora-set-hint");
    hint.textContent = hintText;
    label.appendChild(hint);
  }
  row.appendChild(label);
  return row;
}

/**
 * Builds the ⚙ dialog's DOM: the eight settings from §7b (Default strength ·
 * Strength step · Separate model/clip strength · Trigger words separator ·
 * LoRA memory use · Hide file extension · Civitai · Show preview
 * thumbnails), in that order, matching the approved
 * `playground/lora-loader.html` mockup's own gear panel. Per-node fields
 * (the first five) get a plain input/switch/segmented-group; the last three
 * (Hide file extension / Civitai / Show preview thumbnails) get an
 * IDENTICAL-looking `.wtn-lora-switch` even though `lora_interaction.mjs`'s
 * `openLoraSettings` wires them to `../shared/settings.mjs` instead of the
 * state blob (§7b's ownership split is invisible in the UI on purpose -- the
 * dialog reads as ONE list of eight settings, not two).
 *
 * BUG 1 (2026-07-29 owner report): this dialog used to also render two
 * strings of pure internal/design-doc reasoning -- "stored as last / all /
 * none — human label, raw key in state" under the memory-use row, and a
 * whole paragraph naming what was DROPPED from upstream Pixaroma's dialog
 * and why. Neither is information a user who has never read the design doc
 * can act on; both are gone. What replaced the first is a hint that
 * actually explains the three choices (see `rowMode` below); the second had
 * nothing user-facing to replace it with at all -- there is no user-facing
 * fact "we dropped a button" states.
 */
export function buildSettingsPanel(doc) {
  const root = el(doc, "div", "wtn-lora-set wtn");

  const head = el(doc, "div", "wtn-lora-set-head");
  const title = el(doc, "span", "wtn-lora-set-title");
  title.textContent = "LoRA Loader settings";
  const closeBtn = el(doc, "span", "wtn-lora-set-close");
  closeBtn.textContent = "✕";
  closeBtn.title = "Close";
  head.appendChild(title);
  head.appendChild(closeBtn);
  root.appendChild(head);

  const body = el(doc, "div", "wtn-lora-set-body");
  root.appendChild(body);

  // -- Default strength --------------------------------------------------
  const rowDefault = fieldRow(doc, "Default strength", "New LoRAs start at this value");
  const defaultStrengthInput = el(doc, "input", "wtn-lora-set-num");
  defaultStrengthInput.type = "number";
  defaultStrengthInput.step = "0.05";
  defaultStrengthInput.min = String(STRENGTH_MIN);
  defaultStrengthInput.max = String(STRENGTH_MAX);
  rowDefault.appendChild(defaultStrengthInput);
  body.appendChild(rowDefault);

  // -- Strength step (arrows) ---------------------------------------------
  const rowStep = fieldRow(doc, "Strength step", "▲▼ arrows move by this much");
  const strengthStepInput = el(doc, "input", "wtn-lora-set-num");
  strengthStepInput.type = "number";
  strengthStepInput.step = "0.01";
  strengthStepInput.min = String(STRENGTH_STEP_MIN);
  strengthStepInput.max = String(STRENGTH_STEP_MAX);
  rowStep.appendChild(strengthStepInput);
  body.appendChild(rowStep);

  // -- Separate model / clip strength --------------------------------------
  const rowSepStrengths = fieldRow(doc, "Separate model / clip strength", "Show two strengths per row");
  const sepStrengthsSwitch = el(doc, "div", "wtn-lora-switch");
  sepStrengthsSwitch.title = "Show a model AND a clip strength stepper per row, instead of one shared control";
  rowSepStrengths.appendChild(sepStrengthsSwitch);
  body.appendChild(rowSepStrengths);

  // -- Trigger words separator ---------------------------------------------
  const rowSep = fieldRow(doc, "Trigger words separator");
  const sepInput = el(doc, "input", "wtn-lora-set-text");
  sepInput.type = "text";
  rowSep.appendChild(sepInput);
  body.appendChild(rowSep);

  // -- LoRA memory use (segmented, human labels over raw keys) -------------
  // BUG 1 audit: the hint used to describe ONLY "Standard" ("Keeps the last
  // used LoRA in memory, like ComfyUI"), leaving "Fast"/"Lowest" completely
  // unexplained next to a 3-way control a first-time user has to choose
  // between blind. Now names the actual memory/speed trade-off for all
  // three. Stacked layout (BUG 5): see `.wtn-lora-set-fld-stack`'s own CSS
  // comment for why.
  const rowMode = fieldRow(
    doc,
    "LoRA memory use",
    "Standard keeps only the most-recently-used LoRA loaded (like ComfyUI's own caching). "
      + "Fast keeps every LoRA loaded at once — quicker re-runs, more memory. "
      + "Lowest frees each one right away — least memory, slower re-runs.",
  );
  rowMode.classList.add("wtn-lora-set-fld-stack");
  const seg = el(doc, "span", "wtn-seg");
  const cacheModeBtns = CACHE_MODE_ORDER.map((mode) => {
    const btn = el(doc, "button", "");
    btn.type = "button";
    btn.textContent = CACHE_MODE_LABELS[mode];
    btn.dataset.mode = mode;
    seg.appendChild(btn);
    return btn;
  });
  rowMode.appendChild(seg);
  body.appendChild(rowMode);

  // -- Hide file extension (Settings -> AnimaFlow) --------------------------
  const rowHideExt = fieldRow(doc, "Hide file extension", "Show the name without .safetensors");
  const hideExtSwitch = el(doc, "div", "wtn-lora-switch");
  rowHideExt.appendChild(hideExtSwitch);
  body.appendChild(rowHideExt);

  // -- Civitai (Settings -> AnimaFlow) ---------------------------------------
  // BUG 1 audit: reworded to name the SPECIFIC controls it governs in plain
  // terms (a user has no reason to know what "the header's Browse Civitai
  // button" looks like before ever having noticed it) and to say search
  // isn't built yet, matching BUG 6's own header-icon tooltip wording.
  const rowCivitai = fieldRow(
    doc,
    "Civitai",
    "Turns on every Civitai feature on this node: the ⓘ panel's lookup and re-fetch, "
      + "and the header's Browse button (search arrives in a later update).",
  );
  const civitaiSwitch = el(doc, "div", "wtn-lora-switch");
  rowCivitai.appendChild(civitaiSwitch);
  body.appendChild(rowCivitai);
  const civitaiHint = el(doc, "div", "wtn-lora-set-hint");
  civitaiHint.textContent = "Off hides every Civitai-related control on this node, so it never makes a network request.";
  body.appendChild(civitaiHint);

  // -- Show preview thumbnails (Settings -> AnimaFlow) -----------------------
  const rowThumbs = fieldRow(doc, "Show preview thumbnails", "In the picker and the ⓘ info panel");
  const thumbsSwitch = el(doc, "div", "wtn-lora-switch");
  rowThumbs.appendChild(thumbsSwitch);
  body.appendChild(rowThumbs);

  return {
    root,
    closeBtn,
    defaultStrengthInput,
    strengthStepInput,
    sepStrengthsSwitch,
    sepInput,
    cacheModeBtns,
    hideExtSwitch,
    civitaiSwitch,
    thumbsSwitch,
  };
}

// ---------------------------------------------------------------------------
// Resize (legacy litegraph primary; Nodes 2.0 forward-compat kept minimal --
// see lora_interaction.mjs). Pure arithmetic on row count -- see this
// module's top doc comment.
// ---------------------------------------------------------------------------

/** Total node-body height for `rowCount` rows: `BODY_PAD * 2` + the header +
 * one inter-block gap + the rows-CARD (BUG 7: border + padding on both axes)
 * wrapping either the rows themselves or the single empty-state line (which
 * occupies exactly one row's height, so the arithmetic never branches on a
 * DIFFERENT constant for the empty case).
 *
 * (2026-07-30 owner report, corrected): a prior pass on this file read
 * `BODY_PAD * 2` here as the top+bottom node-edge gap and dropped it when
 * that gap's own CSS (root padding, then BUG 18's header/card margin) was
 * removed. That was wrong -- live testing showed the term was never about
 * the node edge at all; it was accounting for the rows-CARD's own `CARD_PAD`
 * top+bottom, which is a real, still-present `.wtn-lora-rows-card` padding
 * (see this file's CSS, below) and always has been. Dropping the term left
 * the widget's (locked) height 16px short of the real DOM height, which is
 * what actually produced the "flush against the bottom border" symptom --
 * not excess chrome, missing chrome. Restored. `.wtn-lora-root` itself has
 * no padding and never should again (that removal is correct and stays);
 * this term has nothing to do with root.
 *
 * This is the WIDGET's own box height -- it deliberately does NOT include
 * `WIDGETS_START_Y` (the fixed output-socket column reserved above the
 * widget, BUG 3): that offset belongs to the NODE's total height
 * (`lora_interaction.mjs`'s `computeLoraSize`/`fitNodeH`), not to this
 * widget's own `getMinHeight`/`getMaxHeight` -- see this file's top doc
 * comment.
 */
export function contentHeight(rowCount) {
  const n = Math.max(0, rowCount);
  const rowsBlockH = n > 0 ? n * ROW_H + (n - 1) * ROW_GAP : ROW_H;
  const cardH = rowsBlockH + CARD_PAD * 2 + CARD_BORDER * 2;
  return BODY_PAD * 2 + HEADER_H + HEADER_GAP + cardH;
}
