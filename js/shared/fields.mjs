/**
 * fields.mjs — small themed field primitives shared across tracks: a pill
 * switch, a gear glyph, a drag-to-set numeric row with an inline fill, and a
 * `◀ [ value ] ▶` stepper row. Extracted while building `js/anima/`
 * (`docs/generator-design.md`'s frontend dispatch: "use our existing fields
 * from the control panel instead of creating new fields").
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
 * interaction language (drag-to-set with a fill, a stepper, a pill switch, a
 * gear) but decoupled from `row`/`opts`-shaped state and litegraph output
 * dots — callers bind it to whatever value they own via plain `getValue`/
 * `setValue` callbacks. `js/controls/` is completely unmodified by this file
 * (import-only, one direction) and keeps passing its own test suites
 * unchanged.
 *
 * No `node`/`app`/`LiteGraph` reference anywhere in this file — importable
 * under plain `node` (`js/anima/test_resize.mjs` does exactly that), same
 * convention as every other `render.mjs` in this pack.
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
};

const CSS = `
/* ── pill switch ── */
.wtn-fld-switch { position: relative; width: 26px; height: 14px; flex: none; cursor: pointer;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 8px;
  transition: background .12s, border-color .12s; }
.wtn-fld-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px;
  border-radius: 50%; background: var(--wtn-ink-faint, ${TOKENS.inkFaint}); transition: transform .12s, background .12s; }
.wtn-fld-switch.wtn-fld-on { background: rgba(45,212,191,.22); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-fld-switch.wtn-fld-on::after { transform: translateX(12px); background: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-fld-switch.wtn-fld-sm { width: 20px; height: 11px; }
.wtn-fld-switch.wtn-fld-sm::after { width: 6px; height: 6px; top: 1.5px; left: 1.5px; }
.wtn-fld-switch.wtn-fld-sm.wtn-fld-on::after { transform: translateX(9px); }

/* ── gear ── */
.wtn-fld-gear { flex: none; font-size: 11px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); cursor: pointer;
  line-height: 1; padding: 2px; }
.wtn-fld-gear:hover, .wtn-fld-gear.wtn-fld-active { color: var(--wtn-accent, ${TOKENS.accent}); }

/* ── numeric drag row (Control Panel's own drag-to-set-by-dragging-the-row
   maths, ported behaviour -- see rangeOf/clampNumeric/numericPercent
   imported above) ── */
.wtn-fld-num { position: relative; display: flex; align-items: center; gap: 8px; height: 25px;
  padding: 0 8px; border-radius: 6px; overflow: hidden; cursor: ew-resize; margin-bottom: 4px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font-size: 11.5px; }
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
   needed, unlike the Control Panel's fix. */
.wtn-fld-num-name { position: relative; z-index: 1; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap;
  flex: 0 4 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.wtn-fld-num-val { position: relative; z-index: 1; margin-left: auto; font-family: var(--wtn-font-mono, monospace);
  font-size: 11px; color: var(--wtn-ink, ${TOKENS.ink}); white-space: nowrap;
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* ── ◀ [ value ▾ ] ▶ stepper row ── */
.wtn-fld-stepper { position: relative; display: flex; align-items: center; gap: 8px; height: 25px;
  padding: 0 8px; border-radius: 6px; margin-bottom: 4px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font-size: 11.5px; overflow: hidden; }
.wtn-fld-stepper.wtn-fld-disabled { opacity: .55; }
.wtn-fld-stepper-name { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap;
  flex: 0 4 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.wtn-fld-stepper-body { margin-left: auto; display: flex; align-items: center; gap: 6px; min-width: 0; }
.wtn-fld-arrow { width: 0; height: 0; flex: none; cursor: pointer; opacity: .92;
  border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
.wtn-fld-arrow.wtn-fld-left { border-right: 8px solid var(--wtn-accent, ${TOKENS.accent}); }
.wtn-fld-arrow.wtn-fld-right { border-left: 8px solid var(--wtn-accent, ${TOKENS.accent}); }
.wtn-fld-arrow:hover.wtn-fld-left { border-right-color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-fld-arrow:hover.wtn-fld-right { border-left-color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-fld-combo { position: relative; display: flex; align-items: center; gap: 5px; min-width: 0; cursor: pointer; }
.wtn-fld-combo-val { font-family: var(--wtn-font-mono, monospace); font-size: 11px; color: var(--wtn-ink, ${TOKENS.ink});
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wtn-fld-caret { width: 0; height: 0; flex: none; transform: translateY(1px);
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid var(--wtn-ink-faint, ${TOKENS.inkFaint}); }
.wtn-fld-combo:hover .wtn-fld-combo-val { color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-fld-combo:hover .wtn-fld-caret { border-top-color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }

/* ── disabled/"driven elsewhere" field row -- e.g. a value the Anima
   Context Bridge supplied ── */
.wtn-fld-driven { display: flex; align-items: center; gap: 8px; height: 25px; padding: 0 8px;
  border-radius: 6px; margin-bottom: 4px; font-size: 11.5px; cursor: default;
  color: var(--wtn-accent, ${TOKENS.accent}); background: rgba(45,212,191,.07);
  border: 1px dashed var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-fld-driven-name { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-fld-driven-val { margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 10.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;

export function injectFieldStyles(doc) {
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
  const style = targetDoc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
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
// Switch / gear
// ---------------------------------------------------------------------------

export function buildSwitch(doc, on, small) {
  return el(doc, "span", `wtn-fld-switch${small ? " wtn-fld-sm" : ""}${on ? " wtn-fld-on" : ""}`);
}

export function buildGear(doc, title) {
  const gear = el(doc, "span", "wtn-fld-gear");
  gear.textContent = "⚙";
  if (title) {
    gear.title = title;
  }
  return gear;
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
 * `onChange(nextValue)` fires when an arrow cycles the value; `onOpenList()`
 * fires when the value/caret itself is clicked. Returns `{ root, val,
 * comboEl, repaint(value) }`. */
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

  const repaint = (v) => {
    val.textContent = v == null ? "" : String(v);
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
        onOpenList(combo);
      }
    });
  }

  return { root, val, comboEl: combo, repaint };
}

// ---------------------------------------------------------------------------
// "Driven elsewhere" row -- e.g. a Generator field the Anima Context Bridge
// supplied (design doc §5a: "must show a field driven by the context as
// driven by the context, not as an editable number that's silently
// ignored"). Purely presentational; no click wiring of its own.
// ---------------------------------------------------------------------------

export function buildDrivenField(doc, label, sourceText) {
  const root = el(doc, "div", "wtn-fld-driven");
  const name = el(doc, "span", "wtn-fld-driven-name");
  name.textContent = label;
  const val = el(doc, "span", "wtn-fld-driven-val");
  val.textContent = sourceText;
  root.appendChild(name);
  root.appendChild(val);
  return { root, val };
}
