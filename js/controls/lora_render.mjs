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
 * (`ROW_H`/`ROW_GAP`/`HEADER_H`/`BODY_PAD`) byte-for-byte, so
 * `lora_interaction.mjs`'s Class A sizing never has to read the live DOM.
 *
 * ## Icons: CSS-mask glyphs, not emoji (`.claude/CLAUDE.md`,
 * `js/prompt_rules/rule_builder/index.js:44-92`'s precedent)
 *
 * The header's 🔍/⚙ placeholders (inert this slice — Slice 3/5 wire them)
 * are drawn as `mask-image` data-URI SVGs tinted via `currentColor`,
 * matching the Rule Builder's own toolbar-icon technique, rather than the
 * literal emoji characters the mockup uses as placeholders. Hand-rolled
 * geometry (a ring+handle for search, a hub+8 teeth for the gear) — not
 * lifted from a named icon set, so there is nothing to attribute.
 */

import { applyNodeChrome as sharedApplyNodeChrome } from "../shared/node_chrome.mjs";
// `hasFile` is the "unknown, not missing, before first load" cache read
// (`civitai_api.mjs`'s own top doc comment) -- track-agnostic, so importing
// it here does NOT violate the model_picker/civitai_api/model_info layering
// guard (that guard forbids the OPPOSITE direction: those three files must
// never import a `lora_*` module; a `lora_*` module importing THEM is the
// intended, allowed direction).
import { hasFile } from "./civitai_api.mjs";
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
// fallback copy rather than importing one).
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
// Icons — CSS mask-image data URIs (see this module's top doc comment).
// `<`/`>` percent-encoded (`%3C`/`%3E`) so the URL survives being embedded in
// a CSS `url(...)`, matching `js/prompt_rules/rule_builder/index.js`'s own
// `TOOLBAR_ICON_SVG` convention. Default SVG fill is black -- opaque enough
// for a mask (only alpha matters), no `fill=` attribute needed anywhere.
// ---------------------------------------------------------------------------

const SEARCH_ICON_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M11 4a7 7 0 104.418 12.44l4.571 4.571 1.415-1.415-4.572-4.572A7 7 0 0011 4zm-5 7a5 5 0 1110 0 5 5 0 01-10 0z'/%3E%3C/svg%3E";

const GEAR_ICON_SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M12 8.4a3.6 3.6 0 100 7.2 3.6 3.6 0 000-7.2zm-1.8 3.6a1.8 1.8 0 113.6 0 1.8 1.8 0 01-3.6 0z'/%3E%3Crect x='11' y='1' width='2' height='3.6' rx='1'/%3E%3Crect x='11' y='1' width='2' height='3.6' rx='1' transform='rotate(45 12 12)'/%3E%3Crect x='11' y='1' width='2' height='3.6' rx='1' transform='rotate(90 12 12)'/%3E%3Crect x='11' y='1' width='2' height='3.6' rx='1' transform='rotate(135 12 12)'/%3E%3Crect x='11' y='1' width='2' height='3.6' rx='1' transform='rotate(180 12 12)'/%3E%3Crect x='11' y='1' width='2' height='3.6' rx='1' transform='rotate(225 12 12)'/%3E%3Crect x='11' y='1' width='2' height='3.6' rx='1' transform='rotate(270 12 12)'/%3E%3Crect x='11' y='1' width='2' height='3.6' rx='1' transform='rotate(315 12 12)'/%3E%3C/svg%3E";

const CSS = `
.wtn-lora-root {
  display: flex; flex-direction: column; gap: 7px; width: 100%; box-sizing: border-box;
  padding: 9px 9px 10px; font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--wtn-ink, ${TOKENS.ink});
}

/* ── header strip: ＋ Add LoRA · slack · master switch · N/M · 🔍 · ⚙ ──
   the slack itself is .wtn-lora-master's own margin-left: auto rule,
   below -- this row is a plain flex container with no justify-content. */
.wtn-lora-header { display: flex; align-items: center; gap: 8px; height: 30px; flex: none; }

/* Content + padding, capped at 30% of the node -- must NOT flex, or it grows
   without limit on a wide node while the switch/counter/icons stay fixed
   (design doc §1a-ii's whole reasoning for the cap). */
.wtn-lora-add {
  flex: 0 0 auto; max-width: 30%; height: 30px; box-sizing: border-box;
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

/* 🔍 / ⚙ placeholders -- CSS-mask glyphs (see this module's top doc
   comment), inert this slice. Reuses '.wtn-ctl-gear''s box (18px, centered,
   ink-faint -> accent on hover) so the two eventual icon buttons sit in the
   exact same slot a Control/Loader Panel row's own ⚙ would. */
.wtn-lora-icon {
  flex: none; width: 18px; height: 18px; cursor: pointer;
  background-color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  mask-size: contain; -webkit-mask-size: contain; mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
  mask-position: center; -webkit-mask-position: center;
}
.wtn-lora-icon:hover { background-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-lora-icon.wtn-lora-search { mask-image: url("${SEARCH_ICON_SVG}"); -webkit-mask-image: url("${SEARCH_ICON_SVG}"); }
.wtn-lora-icon.wtn-lora-gear { mask-image: url("${GEAR_ICON_SVG}"); -webkit-mask-image: url("${GEAR_ICON_SVG}"); }

/* ── rows host + empty state ── */
.wtn-lora-rows { display: flex; flex-direction: column; gap: 7px; }
.wtn-lora-empty {
  height: 30px; display: flex; align-items: center; justify-content: center;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 11.5px; font-style: italic;
}

/* ── a LoRA row -- reuses .wtn-ctl-row/.wtn-ctl-body from js/controls/
   render.mjs's own vocabulary (see this module's top doc comment) ── */
.wtn-ctl-row { position: relative; width: 100%; height: 30px; box-sizing: border-box; }
.wtn-ctl-body {
  position: relative; display: flex; align-items: center; gap: 8px;
  width: 100%; height: 100%; box-sizing: border-box; padding: 0 8px 0 10px;
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
/* FLIP settle (§1a-iii, Slice 5): lora_interaction.mjs's flipRows writes
   each surviving row's OWN inverse-translate as an inline transform the
   instant the new order paints, then -- one animation frame later -- adds
   THIS class and clears that inline style back to nothing, which is what
   turns "already there" into "glides there". transform is the ONLY
   property this rule ever touches -- never a layout property (this is a DOM
   widget composited over a canvas; animating layout there is visibly
   thrashy). prefers-reduced-motion is handled ENTIRELY by the media query
   below -- with the transition removed, the exact same
   set-transform-then-clear sequence simply snaps instead of gliding, so no
   JS branch is needed to honour it (matches the approved
   playground/lora-loader.html mockup's own .row.flip/@media pair
   verbatim). */
.wtn-ctl-row.wtn-lora-flip { transition: transform .18s cubic-bezier(.2, .7, .3, 1); }
@media (prefers-reduced-motion: reduce) {
  .wtn-ctl-row.wtn-lora-flip { transition: none; }
}
/* an OFF row recedes -- name/strength/info dim, the switch itself (still the
   ONE thing that must stay fully legible) does not (design doc §1a-ii). */
.wtn-ctl-row.wtn-lora-off .wtn-ctl-name,
.wtn-ctl-row.wtn-lora-off .wtn-lora-str,
.wtn-ctl-row.wtn-lora-off .wtn-lora-icon-info { opacity: .45; }

.wtn-ctl-grip {
  flex: none; width: 9px; height: 15px; cursor: grab; touch-action: none;
  background-image: radial-gradient(circle, var(--wtn-ink-faint, ${TOKENS.inkFaint}) 1.1px, transparent 1.3px);
  background-size: 4px 4px; opacity: .5;
}
.wtn-ctl-grip:hover { opacity: 1; }
.wtn-ctl-grip:active { cursor: grabbing; }

/* Name button -- content area 1: the LoRA's own name (or a placeholder), a
   trailing ▾ caret hinting the picker (Slice 3). Plain <button>, no
   .wtn-ctl-* box styling of its own beyond what render.mjs's '.wtn-ctl-name'
   already gives text layout -- background/border come from the shared
   '.wtn-ctl-body' it sits inside. */
.wtn-ctl-name.wtn-lora-name {
  background: transparent; border: none; padding: 0; text-align: left; cursor: pointer;
  font: inherit; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-ctl-name.wtn-lora-name:hover { color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-lora-caret {
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 9px; margin-left: 4px;
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
   '.wtn-lora-str' group holds TWO cells (model, clip) -- the clip one, and
   both 'M'/'C' tags, are hidden by default (single-strength mode, the
   default) and shown only when the ⚙ dialog's "Show two strengths per row"
   is on (§7b, Slice 5) -- paintRow's own sepStrengths parameter toggles
   '.wtn-lora-two' on the group. This keeps the SAME single top-level '.str'
   child the row's fixed grip/name/str/info/switch order already asserts
   (test_lora_resize.mjs's own "in that order" test) -- only its INSIDES
   change shape. */
.wtn-lora-str { display: flex; align-items: center; gap: 8px; flex: none; }
.wtn-lora-str-cell { display: flex; align-items: center; gap: 5px; }
.wtn-lora-str-tag {
  display: none; font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; font-weight: 700;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
}
.wtn-lora-str.wtn-lora-two .wtn-lora-str-tag { display: inline; }
.wtn-lora-str-clip { display: none; }
.wtn-lora-str.wtn-lora-two .wtn-lora-str-clip { display: flex; }
.wtn-lora-str-val {
  font-family: var(--wtn-font-mono, monospace); font-size: 11.5px; font-weight: 640;
  color: var(--wtn-ink, ${TOKENS.ink}); width: 34px; text-align: right;
}
.wtn-lora-spin { display: flex; flex-direction: column; gap: 1px; }
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
.wtn-lora-set-subhint { margin: -5px 0 9px; }
.wtn-lora-set-dropped {
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 10.5px; line-height: 1.4;
  border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); padding-top: 8px; margin-top: 3px;
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
 * Builds the WHOLE node body once: header strip + rows host + empty-state
 * line. Returns every ref `lora_interaction.mjs` needs to wire events onto
 * or repaint. This is the element handed to the node's single
 * `addDOMWidget` call (`lora_interaction.mjs`'s `setupLoraNode`).
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
  const searchBtn = el(doc, "span", "wtn-lora-icon wtn-lora-search");
  searchBtn.title = "Browse Civitai (LoRAs)";
  const settingsBtn = el(doc, "span", "wtn-lora-icon wtn-lora-gear");
  settingsBtn.title = "LoRA Loader settings";
  header.appendChild(addBtn);
  header.appendChild(master);
  header.appendChild(count);
  header.appendChild(searchBtn);
  header.appendChild(settingsBtn);

  const rowsHost = el(doc, "div", "wtn-lora-rows");
  const empty = el(doc, "div", "wtn-lora-empty");
  empty.textContent = "No LoRAs yet — click ＋ Add LoRA.";

  root.appendChild(header);
  root.appendChild(rowsHost);
  root.appendChild(empty);

  return { root, header, addBtn, master, count, searchBtn, settingsBtn, rowsHost, empty };
}

/** Builds ONE strength cell (a tag + value + ▲▼ stepper) -- shared shape for
 * the model ("M") and clip ("C") cells `buildRowElement` builds below. Tags
 * are hidden by default (single-strength mode); `.wtn-lora-str.wtn-lora-two`
 * (toggled by `paintRow`) reveals them, and `.wtn-lora-str-clip` additionally
 * gates the CLIP cell's own visibility. */
function buildStrCell(doc, tagText, extraClass, upTitle, downTitle) {
  const cell = el(doc, "div", `wtn-lora-str-cell${extraClass ? ` ${extraClass}` : ""}`);
  const tag = el(doc, "span", "wtn-lora-str-tag");
  tag.textContent = tagText;
  const val = el(doc, "span", "wtn-lora-str-val");
  const spin = el(doc, "div", "wtn-lora-spin");
  const up = el(doc, "span", "wtn-lora-arrow wtn-lora-up");
  up.title = upTitle;
  const down = el(doc, "span", "wtn-lora-arrow wtn-lora-down");
  down.title = downTitle;
  spin.appendChild(up);
  spin.appendChild(down);
  cell.appendChild(tag);
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
 * cells inside now (model + clip), the clip one hidden unless the ⚙
 * dialog's "Show two strengths per row" (§7b) is on.
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
  const model = buildStrCell(doc, "M", "wtn-lora-str-model", "Increase model strength", "Decrease model strength");
  const clip = buildStrCell(doc, "C", "wtn-lora-str-clip", "Increase clip strength", "Decrease clip strength");
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
 * cell/tags via CSS (`lora_render.mjs`'s own CSS, above) -- defaults to
 * falsy (single-strength mode), unchanged from every pre-Slice-5 caller.
 *
 * Missing-file mark (design doc §1a-iii, "the WHOLE name field red, border
 * included"): `hasFile("loras", row.name)` is `null` until the list has
 * resolved at least once (`civitai_api.mjs`'s "unknown, not missing" rule)
 * -- an empty/unpicked row name (`row.name` falsy) is likewise never
 * "missing," it's simply unpicked. Only an EXPLICIT `false` (a real,
 * fetched list that genuinely doesn't contain this name) paints red. */
export function paintRow(refs, row, sepStrengths) {
  refs.nameLabel.textContent = row.name || "(pick a LoRA)";
  const missing = !!row.name && hasFile("loras", row.name) === false;
  refs.nameBtn.title = missing
    ? `Missing file: ${row.name} -- pick another LoRA`
    : row.name || "Click to pick a LoRA";
  refs.nameBtn.classList.toggle("wtn-lora-missing", missing);
  refs.strVal.textContent = row.sm.toFixed(2);
  if (refs.strValClip) {
    refs.strValClip.textContent = Number.isFinite(row.sc) ? row.sc.toFixed(2) : row.sm.toFixed(2);
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
 * Dropped from upstream (documented in the panel itself, `dropped` below,
 * matching the mockup verbatim): Highlight colour, and the
 * Set-as-default/Every-Pixaroma-node/Done footer -- no footer buttons here
 * at all; edits apply immediately, ✕ closes.
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
  const rowMode = fieldRow(doc, "LoRA memory use", "Keeps the last used LoRA in memory, like ComfyUI");
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
  const modeSubHint = el(doc, "div", "wtn-lora-set-hint wtn-lora-set-subhint");
  modeSubHint.textContent = "stored as last / all / none — human label, raw key in state";
  body.appendChild(modeSubHint);

  // -- Hide file extension (Settings -> AnimaFlow) --------------------------
  const rowHideExt = fieldRow(doc, "Hide file extension", "Show the name without .safetensors");
  const hideExtSwitch = el(doc, "div", "wtn-lora-switch");
  rowHideExt.appendChild(hideExtSwitch);
  body.appendChild(rowHideExt);

  // -- Civitai (Settings -> AnimaFlow) ---------------------------------------
  const rowCivitai = fieldRow(doc, "Civitai", "Show the lookup in the info panel and the header's Browse Civitai button");
  const civitaiSwitch = el(doc, "div", "wtn-lora-switch");
  rowCivitai.appendChild(civitaiSwitch);
  body.appendChild(rowCivitai);
  const civitaiHint = el(doc, "div", "wtn-lora-set-hint");
  civitaiHint.textContent = "Off hides EVERY network affordance on this node -- provably offline.";
  body.appendChild(civitaiHint);

  // -- Show preview thumbnails (Settings -> AnimaFlow) -----------------------
  const rowThumbs = fieldRow(doc, "Show preview thumbnails", "In the picker and the ⓘ info panel");
  const thumbsSwitch = el(doc, "div", "wtn-lora-switch");
  rowThumbs.appendChild(thumbsSwitch);
  body.appendChild(rowThumbs);

  // -- Dropped-from-upstream note (documentation, matches the mockup) -------
  const dropped = el(doc, "div", "wtn-lora-set-dropped");
  dropped.textContent =
    "Dropped from upstream's dialog: Highlight colour (this pack has one house accent, THEME.md) and "
    + "the Set as default / Every Pixaroma node / Done footer (cross-node defaults live in Settings -> "
    + "AnimaFlow instead). Edits here apply immediately; ✕ closes.";
  body.appendChild(dropped);

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

export const ROW_H = 30;
export const ROW_GAP = 7;
export const HEADER_H = 30;
export const BODY_PAD = 9;
export const MIN_W = 300;
export const DEFAULT_W = 340;

/** Total node-body height for `rowCount` rows: top/bottom padding + the
 * header + one inter-block gap + either the rows themselves or the single
 * empty-state line (which occupies exactly one row's height, so the
 * arithmetic never branches on a DIFFERENT constant for the empty case). */
export function contentHeight(rowCount) {
  const n = Math.max(0, rowCount);
  const rowsBlockH = n > 0 ? n * ROW_H + (n - 1) * ROW_GAP : ROW_H;
  return BODY_PAD * 2 + HEADER_H + ROW_GAP + rowsBlockH;
}
