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
.wtn-ctl-row {
  position: relative; display: flex; align-items: center; gap: 8px;
  width: 100%; height: 30px; box-sizing: border-box; padding: 0 8px 0 10px;
  border-radius: 7px; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-ctl-row.wtn-ctl-open { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-ctl-row.wtn-ctl-dragging { opacity: .5; border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-ctl-row.wtn-ctl-auto { border-style: dashed; border-color: #2c3644; }
.wtn-ctl-row.wtn-ctl-auto .wtn-ctl-name { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; }
.wtn-ctl-row.wtn-ctl-disabled { opacity: .55; }

.wtn-ctl-name {
  font-size: 12px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 54px;
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
}
.wtn-ctl-val .wtn-ctl-dim { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-weight: 500; margin-left: 4px; }

/* output dot -- namespaced BY TYPE (t-*), never a bare socket-type class:
   docs/control-panel-design.md's "traps already paid for" -- a bare
   .combo here would collide with litegraph's own .combo WIDGET class
   and inherit position:relative;display:flex, knocking the dot out of
   absolute flow and eating ~19px of row width. */
.wtn-ctl-dot {
  /* width/height/right below are EYEBALLED against the real litegraph
     output socket in a live ComfyUI (alignOutputsLegacy parks that socket
     at node.size[0] on this row's Y) -- empirical, don't "round" them. */
  position: absolute; right: -16px; top: 50%; transform: translateY(-50%);
  width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid #0b0e13;
}
.wtn-ctl-dot.t-int { background: #7dd3fc; }
.wtn-ctl-dot.t-float { background: #4ade80; }
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

/* ── numeric row: drag the row to set, inline fill shows range position ── */
.wtn-ctl-row.wtn-ctl-slider { overflow: hidden; cursor: ew-resize; }
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
.wtn-ctl-overlay { position: fixed; z-index: 10020; }
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
 * ComfyUI's lighter default node chrome. Mirrors
 * `../ComfyUI-Pixaroma/js/note/render.mjs`'s `renderContent` (see its top
 * doc comment, lines ~66-113, for the exact reasoning this ports): litegraph
 * SERIALIZES `node.color`/`node.bgcolor` into the saved workflow the moment
 * either is set (by us, OR by the user's own right-click -> Colors pick), so
 * this only ever fills in a still-null value -- it must NEVER overwrite one
 * that's already set, or it would silently clobber a user's explicit choice
 * every time it runs.
 *
 * `TOKENS.surface`/`TOKENS.surface2` (this module's single source of truth
 * for the palette, mirroring `js/shared/theme.mjs`) are used directly rather
 * than a third hardcoded pair of hexes.
 *
 * Called from `index.js`'s `setupNode` ONLY, and only when
 * `!node._ctrlConfiguring` -- i.e. a genuinely fresh node, never one being
 * restored from a saved workflow (see index.js's call site for why that
 * flag reliably distinguishes the two, and why the restore path
 * deliberately never touches colour at all).
 */
export function applyNodeChrome(node) {
  if (!node) {
    return;
  }
  if (node.bgcolor == null) {
    node.bgcolor = TOKENS.surface;
  }
  if (node.color == null) {
    node.color = TOKENS.surface2;
  }
}

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
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
  if (row.kind === "auto") {
    rowEl.classList.add("wtn-ctl-auto");
  }

  const refs = { root: rowEl, row, kindMeta };

  if (panelConfig && panelConfig.reorder) {
    const grip = el(doc, "span", "wtn-ctl-grip");
    grip.title = "Drag to reorder -- does not move the output slot";
    rowEl.appendChild(grip);
    refs.grip = grip;
  }

  const name = el(doc, "div", "wtn-ctl-name");
  name.textContent = row.name || row.kind;
  rowEl.appendChild(name);
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
    rowEl.appendChild(stepper);
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
    rowEl.appendChild(val);
    rowEl.appendChild(mode);
    rowEl.appendChild(newBtn);
    rowEl.appendChild(reuseBtn);
    Object.assign(refs, { val, modeBtn: mode, newBtn, reuseBtn });
  } else if (row.kind === "int" || row.kind === "float") {
    rowEl.classList.add("wtn-ctl-slider");
    const fill = el(doc, "div", "wtn-ctl-fill");
    rowEl.insertBefore(fill, name); // fill sits BEHIND name/value (z-index below via source order)
    const val = el(doc, "span", "wtn-ctl-val");
    rowEl.appendChild(val);
    Object.assign(refs, { fill, val });
  } else if (row.kind === "latent") {
    const val = el(doc, "span", "wtn-ctl-val");
    const dim = el(doc, "span", "wtn-ctl-dim");
    val.appendChild(dim);
    rowEl.appendChild(val);
    Object.assign(refs, { val, dim });
  } else {
    // Every catalog kind is handled above (picker kinds -- sampler/scheduler/
    // unet/vae/clip -- via isPickerKind, seed/int/float/latent by name), so
    // this only fires for a genuinely unexpected kind -- keep a safe fallback
    // so that never crashes render.
    const val = el(doc, "span", "wtn-ctl-val");
    rowEl.appendChild(val);
    refs.val = val;
  }

  if (kindMeta && kindMeta.hasGear) {
    const gear = el(doc, "span", "wtn-ctl-gear");
    gear.textContent = "⚙";
    gear.title = `${(kindMeta.menu || row.kind)} settings`;
    rowEl.appendChild(gear);
    refs.gear = gear;
  }

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
    refs.val.textContent = list.length ? String(list[idx] ?? list[0]) : (disabledReason ? "unavailable" : "");
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
 */
export function openOverlay(doc, anchorEl, contentEl, placement, onClose) {
  const win = (doc && doc.defaultView) || (typeof window !== "undefined" ? window : null);
  const overlay = el(doc, "div", "wtn-ctl-overlay wtn");
  // Belt-and-suspenders: `.wtn-ctl-overlay`'s `position: fixed` normally
  // comes from the injected stylesheet, but if that injection is ever
  // missing/late/fails, a `position: static` overlay lays out as a block at
  // the very bottom of the page -- invisible, not merely unstyled, and every
  // click on it silently does nothing a user can see (exactly what made
  // "+ Add control" look dead before `injectStyles` was wired up). Setting
  // it inline here means a stylesheet failure can never hide a menu again.
  overlay.style.position = "fixed";
  overlay.style.zIndex = "10020";
  overlay.appendChild(contentEl);
  const body = doc.body || doc;
  body.appendChild(overlay);

  const reposition = () => {
    const rect = typeof anchorEl.getBoundingClientRect === "function"
      ? anchorEl.getBoundingClientRect()
      : { left: 0, top: 0, right: 0, bottom: 0, width: 240 };
    if (placement === "below") {
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.bottom + 6}px`;
      overlay.style.width = `${Math.max(120, rect.width)}px`;
    } else {
      overlay.style.left = `${rect.right + 10}px`;
      overlay.style.top = `${rect.top}px`;
    }
  };
  reposition();

  function onDocPointerDown(e) {
    if (overlay.contains(e.target) || (anchorEl && anchorEl.contains && anchorEl.contains(e.target))) {
      return;
    }
    close();
  }
  function onKeydown(e) {
    if (e.key === "Escape") {
      close();
    }
  }
  let closed = false;
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    if (win) {
      win.removeEventListener("pointerdown", onDocPointerDown, true);
      win.removeEventListener("keydown", onKeydown, true);
    }
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    if (typeof onClose === "function") {
      onClose();
    }
  }
  if (win) {
    // Deferred so the SAME click that opened this overlay doesn't also
    // immediately close it via the outside-click listener.
    win.setTimeout(() => {
      win.addEventListener("pointerdown", onDocPointerDown, true);
      win.addEventListener("keydown", onKeydown, true);
    }, 0);
  }

  return { overlay, close, reposition };
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
