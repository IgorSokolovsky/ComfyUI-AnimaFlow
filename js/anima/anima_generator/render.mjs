/**
 * render.mjs — DOM UI for the AnimaGenerator sectioned panel.
 *
 * Builds ONE DOM root (mounted as a single `addDOMWidget`) containing one
 * card per `core.mjs`'s `CARD_DEFS` entry: a header (title, optional Enabled
 * checkbox) and a body of field rows. There is no separate collapse
 * control — for a card with an `enabledWidget`, that checkbox IS the
 * open/closed control (unchecked collapses the body to just the header
 * row); a card with `enabledWidget: null` (SAMPLER, PREVIEW) has no header
 * control at all and its body is always visible. Every field row is
 * built directly from a REAL native widget object (`{value, options}`) — no
 * parallel state, no JSON blob (see `index.js`'s top doc comment for the
 * full "drive the existing widgets" rationale). This module itself never
 * touches `node.widgets`/`node.properties`/litegraph — that orchestration
 * (which widget backs which row, structural-vs-value refit gating) lives in
 * `interaction.mjs`; this module only knows how to turn a `{value,
 * options}`-shaped widget into DOM and back out again via a caller-supplied
 * `onChange` callback.
 *
 * ## Resize mechanism (ComfyUI-Pixaroma find_replace mechanism, matched
 * exactly — mirrors `js/anima_prompt/anima_prompt_studio/render.mjs`'s own copy 1:1)
 *
 * This node's dominant variable-height content is CARDS OPENING/CLOSING
 * (driven entirely by each stage's Enabled checkbox) and the DYNAMIC
 * upscale-backend field swap, not typing — so `index.js`/`interaction.mjs`
 * fire `scheduleRefit` on every STRUCTURAL change (toggle a stage's Enabled
 * checkbox, switch `upscale_backend`) and NEVER on a plain value edit
 * (typing in a number box, dragging a slider, picking a non-upscale-backend
 * combo option) — see `interaction.mjs`'s doc comment for the exact gating
 * rule.
 *
 * ## Why `injectStyles` is a GUARDED DYNAMIC theme import, not a static one
 *
 * Same reasoning as `js/anima_prompt/anima_prompt_studio/render.mjs` (copied verbatim):
 * a static top-level import of the shared theme module's absolute
 * `/extensions/...` path would 404 under plain `node
 * js/anima/anima_generator/test_resize.mjs` (no live ComfyUI server rewriting that
 * path), killing this file's own headless test run. `injectStyles` only
 * ever attempts the theme import via a dynamic `import()`, gated on a real
 * global `document` existing (true only inside an actual browser). This
 * module's own CSS below falls back to hardcoded hex values (mirroring
 * `js/shared/theme.mjs`'s `TOKENS`, kept in sync by hand) via the same
 * `var(--wtn-x, <hex>)` pattern every other node's CSS in this pack uses.
 */

import { widgetKind, coerceNumberValue, prettyFieldLabel } from "./core.mjs";

const STYLE_ID = "wtn-anima-generator-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly — see this module's doc
// comment for why these are hardcoded fallbacks rather than an imported
// reference.
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
  radius: "10px",
  radiusSm: "7px",
};

const CSS = `
.wtn-ag-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 2px 2px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  /* NO height:100% / min-height here (the ComfyUI-Pixaroma find_replace
     pattern) -- see this module's doc comment. */
}
.wtn-ag-root, .wtn-ag-root * { box-sizing: border-box; }

.wtn-ag-card {
  background: var(--wtn-surface-2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: var(--wtn-radius, ${TOKENS.radius});
  overflow: hidden;
  /* The root is a column flexbox (see .wtn-ag-root above) -- flex-shrink
     defaults to 1, which lets every card compress proportionally whenever
     the DOM-widget container is shorter than the content needs, and this
     card's own overflow:hidden then silently slices the body mid-row (the
     "cards clipped mid-row" bug). flex-shrink:0 makes a card's height
     content-driven ONLY, never squeezed by its column-flex container, so
     measureMinHeight (below) always reads each card's true, uncompressed
     offsetHeight regardless of the node's current (possibly too-small)
     size. */
  flex-shrink: 0;
}
.wtn-ag-card-hd {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  background: var(--wtn-surface, ${TOKENS.surface});
  border-bottom: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
}
.wtn-ag-card-title {
  font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
  color: var(--wtn-ink, ${TOKENS.ink});
}
.wtn-ag-card-spacer { flex: 1 1 auto; }
.wtn-ag-enabled-label {
  display: flex; align-items: center; gap: 5px; font-size: 10.5px;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); cursor: pointer; user-select: none;
}
.wtn-ag-card-bd { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.wtn-ag-card-bd[hidden] { display: none; }

.wtn-ag-field { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.wtn-ag-field-label {
  flex: 0 0 36%; min-width: 0; font-size: 11px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wtn-ag-field-control { flex: 1 1 auto; min-width: 0; display: flex; }
.wtn-ag-field-missing-note {
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; font-size: 10.5px;
}

.wtn-ag-num-wrap { display: flex; align-items: center; gap: 6px; width: 100%; }
.wtn-ag-num {
  width: 66px; flex: 0 0 auto; font-family: var(--wtn-font-mono, monospace); font-size: 11px;
  color: var(--wtn-ink, ${TOKENS.ink}); background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 5px; padding: 3px 5px;
}
.wtn-ag-range { flex: 1 1 auto; min-width: 0; accent-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-ag-select, .wtn-ag-text {
  width: 100%; font-size: 11px; color: var(--wtn-ink, ${TOKENS.ink});
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: 5px; padding: 3px 6px;
}
.wtn-ag-checkbox { accent-color: var(--wtn-accent, ${TOKENS.accent}); }
`;

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  // Guarded dynamic import — see this module's top doc comment for why this
  // can't be a static import.
  if (typeof document !== "undefined") {
    import(THEME_URL)
      .then((mod) => mod.injectTheme())
      .catch(() => {
        // No live ComfyUI server to serve this route -- non-fatal, this
        // module's own CSS above already falls back to hardcoded hex values.
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
// Card shell (header + body container) — one per CARD_DEFS entry
// ---------------------------------------------------------------------------

/** Build one card's static shell: header (title, optional Enabled
 * checkbox) + an empty body container `renderCardFields` (below) fills in.
 * There is no collapse button — for an optional card (`cardDef.enabledWidget`
 * truthy) the Enabled checkbox IS the open/closed control; an always-on card
 * (`enabledWidget: null` — SAMPLER, PREVIEW) gets no header control at all,
 * per the plan: a chevron on a card with no Enabled widget would be
 * meaningless since it always runs. Returns the refs `interaction.mjs` wires
 * listeners onto and `index.js`/`interaction.mjs` read for enabled UI sync. */
export function buildCardShell(doc, cardDef) {
  const root = doc.createElement("div");
  root.className = "wtn-ag-card";
  if (typeof root.setAttribute === "function") {
    root.setAttribute("data-card", cardDef.id);
  }

  const hd = doc.createElement("div");
  hd.className = "wtn-ag-card-hd";

  const titleEl = doc.createElement("span");
  titleEl.className = "wtn-ag-card-title";
  titleEl.textContent = cardDef.title;

  const spacer = doc.createElement("span");
  spacer.className = "wtn-ag-card-spacer";

  hd.appendChild(titleEl);
  hd.appendChild(spacer);

  let enabledCheckbox = null;
  if (cardDef.enabledWidget) {
    const label = doc.createElement("label");
    label.className = "wtn-ag-enabled-label";
    enabledCheckbox = doc.createElement("input");
    enabledCheckbox.type = "checkbox";
    enabledCheckbox.className = "wtn-ag-enabled-checkbox";
    enabledCheckbox.setAttribute("aria-label", cardDef.title + " enabled");
    const span = doc.createElement("span");
    span.textContent = "Enabled";
    label.appendChild(enabledCheckbox);
    label.appendChild(span);
    hd.appendChild(label);
  }

  const bodyEl = doc.createElement("div");
  bodyEl.className = "wtn-ag-card-bd";

  root.appendChild(hd);
  root.appendChild(bodyEl);

  return { root, hd, titleEl, enabledCheckbox, bodyEl };
}

/** Build the whole node UI: one card shell per `cardDefs` entry, in order.
 * Returns `{doc, root, cards}` (`cards` keyed by card id) — the flat refs
 * object every other function in this module / `interaction.mjs` /
 * `index.js` reads from, no re-querying by class name at call time. */
export function buildRoot(doc, cardDefs) {
  const d = doc || document;
  const root = d.createElement("div");
  root.className = "wtn-ag-root wtn";

  const cards = {};
  (cardDefs || []).forEach((cardDef) => {
    const shell = buildCardShell(d, cardDef);
    cards[cardDef.id] = shell;
    root.appendChild(shell.root);
  });

  return { doc: d, root, cards };
}

/** The single open/closed control for an optional card: Enabled drives it
 * directly (upstream's behavior, replacing this build's earlier "expanded
 * but dimmed" judgement call) — unchecked HIDES the body (collapsed to just
 * the header row), checked shows it. Also mirrors `enabled` into the
 * checkbox itself, so this is the one function both `renderCard` (mount/
 * `onConfigure`/upscale-backend rebuild) and the Enabled checkbox's own
 * `change` handler need to call. Never called for an always-on card (no
 * `enabledWidget`, no `enabledCheckbox` to mirror into) — its body has no
 * `hidden` toggling at all and stays permanently visible. */
export function setCardEnabledUI(shellRefs, enabled) {
  if (!shellRefs) {
    return;
  }
  shellRefs.bodyEl.hidden = !enabled;
  if (shellRefs.enabledCheckbox) {
    shellRefs.enabledCheckbox.checked = !!enabled;
  }
}

// ---------------------------------------------------------------------------
// Field rows — one native widget in, one DOM control out
// ---------------------------------------------------------------------------

/** Build ONE field row for `name`, mirroring `widget` (a real litegraph
 * widget, or a `{value, options}`-shaped stub in tests). `widget.options.tooltip`
 * (the Python-declared tooltip — see `node_anima_generator.py`'s
 * `INPUT_TYPES`) backs both the row's and control's `title`, per the plan's
 * "reuse the Python tooltip text" requirement. `onChange(value)` fires on
 * every user edit; callers decide what that does (write the widget, call
 * its callback, whether to refit) — this module never touches `node`.
 *
 * `widget` may be `null`/`undefined` (the widget doesn't exist on this node
 * right now, e.g. `control_after_generate` — see `core.mjs`'s doc comment):
 * renders a small "(unavailable)" placeholder row instead of throwing. */
export function buildFieldRow(doc, name, widget, onChange) {
  const label = prettyFieldLabel(name);
  const tooltip = (widget && widget.options && widget.options.tooltip) || "";
  const kind = widgetKind(widget);

  const row = doc.createElement("div");
  row.className = "wtn-ag-field";
  row.title = tooltip;

  const labelEl = doc.createElement("span");
  labelEl.className = "wtn-ag-field-label";
  labelEl.textContent = label;
  labelEl.title = tooltip;
  row.appendChild(labelEl);

  const controlWrap = doc.createElement("div");
  controlWrap.className = "wtn-ag-field-control";
  row.appendChild(controlWrap);

  const refs = { row, kind, name };

  if (kind === "missing") {
    row.classList.add("wtn-ag-field-missing");
    const note = doc.createElement("span");
    note.className = "wtn-ag-field-missing-note";
    note.textContent = "(unavailable)";
    controlWrap.appendChild(note);
    return refs;
  }

  if (kind === "boolean") {
    const input = doc.createElement("input");
    input.type = "checkbox";
    input.className = "wtn-ag-checkbox";
    input.checked = !!widget.value;
    input.title = tooltip;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => onChange(input.checked));
    controlWrap.appendChild(input);
    refs.input = input;
    return refs;
  }

  if (kind === "combo") {
    const select = doc.createElement("select");
    select.className = "wtn-ag-select";
    select.title = tooltip;
    select.setAttribute("aria-label", label);
    const values = (widget.options && widget.options.values) || [];
    values.forEach((v) => {
      const option = doc.createElement("option");
      option.value = String(v);
      option.textContent = String(v);
      select.appendChild(option);
    });
    select.value = String(widget.value);
    select.addEventListener("change", () => onChange(select.value));
    controlWrap.appendChild(select);
    refs.input = select;
    return refs;
  }

  if (kind === "number") {
    const opts = widget.options || {};
    const min = typeof opts.min === "number" ? opts.min : 0;
    const fallbackMax = Math.max(min + 1, Number(widget.value) || 0);
    const max = typeof opts.max === "number" ? opts.max : fallbackMax;
    const step = typeof opts.step === "number" ? opts.step : 1;

    const wrap = doc.createElement("div");
    wrap.className = "wtn-ag-num-wrap";

    const numInput = doc.createElement("input");
    numInput.type = "number";
    numInput.className = "wtn-ag-num";
    numInput.min = String(min);
    numInput.max = String(max);
    numInput.step = String(step);
    numInput.value = String(widget.value);
    numInput.title = tooltip;
    numInput.setAttribute("aria-label", label);

    const range = doc.createElement("input");
    range.type = "range";
    range.className = "wtn-ag-range";
    range.min = String(min);
    range.max = String(max);
    range.step = String(step);
    range.value = String(widget.value);
    range.title = tooltip;
    range.setAttribute("aria-label", label + " slider");

    const sync = (raw) => {
      const v = coerceNumberValue(widget, raw);
      numInput.value = String(v);
      range.value = String(v);
      onChange(v);
    };
    numInput.addEventListener("input", () => sync(numInput.value));
    range.addEventListener("input", () => sync(range.value));

    wrap.appendChild(numInput);
    wrap.appendChild(range);
    controlWrap.appendChild(wrap);
    refs.input = numInput;
    refs.range = range;
    return refs;
  }

  // "text" — plain single-line STRING widget (save_prefix, preview_channel,
  // upscale_resshift_scale).
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "wtn-ag-text";
  input.value = widget.value != null ? String(widget.value) : "";
  input.title = tooltip;
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => onChange(input.value));
  controlWrap.appendChild(input);
  refs.input = input;
  return refs;
}

/**
 * (Re)build `bodyEl`'s field rows from scratch for `fieldNames`, in order.
 * `resolveWidget(name)` looks up the real widget (or returns a falsy value
 * if it doesn't exist — see `buildFieldRow`'s doc comment); `onChange(name,
 * widget, value)` fires per edit; `onMissing(name)` fires once per absent
 * widget (the caller, `interaction.mjs`, dedupes the console warning). Full
 * teardown/rebuild on every call (mirrors `anima_prompt_studio`'s
 * `renderPane`) — used at mount, at `onConfigure` restore, and whenever the
 * upscale backend combo changes (the one case this rebuild is itself
 * "structural" and needs `scheduleRefit` — the caller's job, not this
 * function's).
 *
 * Returns a `{ [name]: rowRefs }` map of every row just built (the same
 * `rowRefs` shape `buildFieldRow` returns) — `interaction.mjs`'s `renderCard`
 * stashes this on the card's shell so a later CHEAP, value-only resync
 * (`updateFieldRowValue` below, driven by `interaction.mjs`'s
 * `refreshFieldValues`) can update each control WITHOUT tearing this DOM back
 * down again.
 */
export function renderCardFields(doc, bodyEl, fieldNames, resolveWidget, onChange, onMissing) {
  while (bodyEl.firstChild) {
    bodyEl.removeChild(bodyEl.firstChild);
  }
  const fieldRows = {};
  (fieldNames || []).forEach((name) => {
    const widget = resolveWidget(name);
    if (!widget) {
      if (typeof onMissing === "function") {
        onMissing(name);
      }
      const rowRefs = buildFieldRow(doc, name, null, () => {});
      bodyEl.appendChild(rowRefs.row);
      fieldRows[name] = rowRefs;
      return;
    }
    const rowRefs = buildFieldRow(doc, name, widget, (value) => onChange(name, widget, value));
    bodyEl.appendChild(rowRefs.row);
    fieldRows[name] = rowRefs;
  });
  return fieldRows;
}

/**
 * Re-sync ONE already-rendered field row's DOM control(s) from `widget`'s
 * CURRENT value — no DOM teardown/rebuild (reuses the exact elements
 * `renderCardFields` built), and never overwrites whichever element is
 * `activeEl` (typically the hosting document's `activeElement`) so a resync
 * firing while the user is mid-typing/mid-dragging that exact control can't
 * yank the caret or discard a partial edit. A "number" row mirrors its value
 * into TWO elements (the number box + its paired range slider); if EITHER is
 * `activeEl` both are left alone (they always mirror each other, so touching
 * one without the other would desync them). A "missing" row has no control
 * at all — silent no-op, same as everywhere else in this module. Never
 * throws: a falsy `rowRefs`/`widget` is a silent no-op too (this is called
 * from an execution-event handler — see `interaction.mjs`'s
 * `resyncAllFromWidgets` — that must never be the thing that breaks
 * queueing).
 */
export function updateFieldRowValue(rowRefs, widget, activeEl) {
  if (!rowRefs || !widget) {
    return;
  }
  if (rowRefs.kind === "boolean") {
    if (rowRefs.input && rowRefs.input !== activeEl) {
      rowRefs.input.checked = !!widget.value;
    }
    return;
  }
  if (rowRefs.kind === "combo") {
    if (rowRefs.input && rowRefs.input !== activeEl) {
      rowRefs.input.value = String(widget.value);
    }
    return;
  }
  if (rowRefs.kind === "number") {
    if (rowRefs.input === activeEl || rowRefs.range === activeEl) {
      return;
    }
    const v = String(widget.value);
    if (rowRefs.input) {
      rowRefs.input.value = v;
    }
    if (rowRefs.range) {
      rowRefs.range.value = v;
    }
    return;
  }
  if (rowRefs.kind === "text") {
    if (rowRefs.input && rowRefs.input !== activeEl) {
      rowRefs.input.value = widget.value != null ? String(widget.value) : "";
    }
  }
  // "missing" -- no control rendered, nothing to update.
}

// ---------------------------------------------------------------------------
// Resize (ComfyUI-Pixaroma find_replace mechanism, matched exactly — see
// this module's top doc comment for the rationale; mirrors
// js/anima_prompt/anima_prompt_studio/render.mjs's own copy)
// ---------------------------------------------------------------------------

export const CHROME = 60;
export const DEFAULT_W = 460;
export const DEFAULT_H = 560;

/**
 * The narrowest width at which a field row (`.wtn-ag-field` in this module's
 * CSS) stays USABLE -- derived from the exact CSS pixel/percentage values
 * above, not guessed:
 *
 *   row width R splits into `.wtn-ag-field-label` (flex-basis 36%) +
 *   `.wtn-ag-field` gap (8px) + `.wtn-ag-field-control` (the remainder,
 *   `0.64*R - 8`). The control itself is a number+slider pair
 *   (`.wtn-ag-num-wrap`): a 66px fixed number box (`.wtn-ag-num`) + its 6px
 *   gap + the range slider (`.wtn-ag-range`). A slider narrower than ~60px
 *   stops being meaningfully draggable (not enough track either side of a
 *   ~14px thumb) -- that's this floor's SLIDER_MIN.
 *
 *   CONTROL_MIN = 66 + 6 + 60 = 132px
 *   0.64*R - 8 >= 132  =>  R >= 218.75  =>  R_MIN = 220px (row content width)
 *
 *   Add back what sits outside the row: `.wtn-ag-card-bd` padding (8px 10px
 *   -> 20px horizontal), `.wtn-ag-card`'s 1px border (2px), and
 *   `.wtn-ag-root`'s padding (4px 2px 2px -> 4px horizontal):
 *   220 + 20 + 2 + 4 = 246px of DOM-widget content width.
 *
 *   Litegraph itself insets a DOM widget from the node's own left/right edge
 *   (title-bar-width chrome, ~10px each side here, matching this module's
 *   own CHROME-for-vertical-chrome convention above) -- add 20px:
 *   246 + 20 = 266px node width, the true minimum.
 *
 *   WIDTH_MIN below is rounded up from that (280px) for headroom rather than
 *   shipping the bare minimum -- and it stays well below DEFAULT_W (460,
 *   ~61% of it), which is the point: DEFAULT_W is a comfortable initial
 *   width, WIDTH_MIN is only the floor a user can never drag narrower than
 *   without crushing the slider.
 */
export const WIDTH_MIN = 280;

/**
 * The live width+height floor for THIS node right now: `[WIDTH_MIN,
 * measureMinHeight(root) + CHROME]` -- the same content-height-plus-chrome
 * sum `refitNode` uses as its own auto-fit "want" (below), just without that
 * function's extra `Math.max(..., DEFAULT_H)` -- a MANUAL drag floor must
 * only ever forbid what actually clips content, never impose the "nice
 * default" height as a floor too (that would defeat "with stages disabled,
 * a size that was previously clamped is now allowed" -- the floor must
 * legitimately shrink as cards collapse). Always recomputed from `root`
 * fresh (never cached) so a stage's Enabled toggle changing the measured
 * content immediately changes this floor on the very next resize.
 */
export function computeSizeFloor(root) {
  return [WIDTH_MIN, root ? measureMinHeight(root) + CHROME : DEFAULT_H];
}

/**
 * Raise `size` (litegraph's in-flight resize-target array, if present) AND
 * `node.size` (if present) UP to the live floor from `computeSizeFloor` --
 * NEVER down: every write here is `if (x < floor) x = floor`, so a node the
 * user is growing is completely untouched (a floor, never a ceiling). Both
 * are clamped independently (not "make node.size match size") because
 * different litegraph forks are known to treat the `onResize(size)`
 * parameter vs. `node.size` itself as the canonical value at different
 * points in the drag (mirrors ComfyUI-Pixaroma find_replace's identical
 * belt-and-braces double-write in its own `onResize` hook).
 *
 * Also (best-effort) writes `node.min_size` to the same floor: some
 * litegraph forks clamp a manual resize against `node.min_size` themselves,
 * possibly before ever calling `onResize` -- see `createResizeClampHandler`
 * below for the primary, verified-in-this-pack mechanism (every other
 * DOM-widget node in this repo's Pixaroma reference clamps via `onResize`;
 * none of them use `min_size` at all, so it isn't confirmed to do anything
 * in this ComfyUI version -- this is a harmless "if the host happens to
 * read it" extra, not the thing being relied on). Never throws: a
 * missing/malformed `node`/`size` degrades to a silent no-op, since this
 * can run on every mouse-move of a resize drag.
 */
export function clampNodeSize(node, root, size) {
  if (!node) {
    return;
  }
  try {
    const [minW, minH] = computeSizeFloor(root);
    if (Array.isArray(size)) {
      if (typeof size[0] === "number" && size[0] < minW) {
        size[0] = minW;
      }
      if (typeof size[1] === "number" && size[1] < minH) {
        size[1] = minH;
      }
    }
    if (Array.isArray(node.size)) {
      if (typeof node.size[0] === "number" && node.size[0] < minW) {
        node.size[0] = minW;
      }
      if (typeof node.size[1] === "number" && node.size[1] < minH) {
        node.size[1] = minH;
      }
    }
    try {
      node.min_size = [minW, minH];
    } catch (err) {
      // Some host may expose min_size as read-only -- this is a best-effort
      // extra, never the thing that should break the clamp above.
    }
  } catch (err) {
    // Never let a malformed node/root/size break a live resize drag.
  }
}

/**
 * Wrap `originalOnResize` (may be undefined) with the width+height floor
 * above -- THE mechanism (see this build's report for why `onResize`, not
 * `min_size`, is primary): legacy litegraph's manual-resize-handle drag
 * calls `node.onResize(newSize)` on every mouse-move, which is the one place
 * a user-driven resize is observable at all in this renderer (matches every
 * existing DOM-widget node's own `onResize` wrap in the ComfyUI-Pixaroma
 * reference this pack is modeled on -- `find_replace`, `seed`, `switch_wh`,
 * `switch_source`, `xy_plot`, `image_info`, `load_image_mini` all wrap
 * `onResize` for exactly this floor; none of them rely on `min_size`).
 *
 * Returns a plain function meant to be assigned to `nodeType.prototype
 * .onResize` (called with `this` bound to the node instance by litegraph) --
 * deliberately a plain function, not an arrow, and deliberately exported
 * from this host-agnostic module rather than written inline in `index.js`,
 * so the whole guard+clamp+call-through contract is unit-testable with a
 * plain `.call(fakeNode, size)` (no real `nodeType`/`app` needed) — mirrors
 * this node's own `resyncAllFromWidgets` precedent for "host-agnostic logic,
 * host wiring kept separate."
 *
 * Anti-recursion guard: `node._agResizeClampGuard`. `clampNodeSize` itself
 * never calls `setSize`/anything that could re-invoke `onResize` -- but IF
 * some host's resize-drag code (or a future `originalOnResize`) did loop
 * back into this SAME node's `onResize` synchronously, the guard covers the
 * WHOLE handler body (clamp AND the call-through to `originalOnResize`, not
 * just the clamp step) so a reentrant call is a same-tick no-op: it neither
 * re-clamps nor calls `originalOnResize` again, which is what actually
 * stops a clamp→resize→clamp chain rather than merely bounding it. Reset in
 * a `finally` so a throwing `clampNodeSize`/`originalOnResize` can never
 * leave the guard stuck "true" and silently disable clamping for the rest
 * of the node's life.
 */
export function createResizeClampHandler(originalOnResize) {
  return function (size) {
    if (this && this._agResizeClampGuard) {
      // Reentrant call for this SAME node while a clamp pass is already on
      // the stack -- never re-clamp, never call through again either: doing
      // either here IS the resize feedback loop this guard exists to stop.
      return undefined;
    }
    if (this) {
      this._agResizeClampGuard = true;
    }
    try {
      const refs = this && this._agRefs;
      clampNodeSize(this, refs && refs.root, size);
      return originalOnResize ? originalOnResize.apply(this, arguments) : undefined;
    } finally {
      if (this) {
        this._agResizeClampGuard = false;
      }
    }
  };
}

/** Post-layout content measurement — sums every visible child's
 * `offsetHeight` + row gaps + root padding, rounded to a 4px grid, floored
 * at 220. Takes ONLY `root`; never reads `node`/`node.size` (no feedback
 * loop possible — see the plan's explicit requirement). Must only be called
 * from inside `requestAnimationFrame` (a sync read before layout settles
 * returns 0 and snaps the node tiny) — enforced by every caller here, never
 * by this function itself. */
export function measureMinHeight(root) {
  if (!root) {
    return 220;
  }
  let h = 0;
  let count = 0;
  for (const child of root.children) {
    if (child.offsetParent === null) {
      continue;
    }
    count += 1;
    h += child.offsetHeight;
  }
  const cs = getComputedStyle(root);
  const gap = parseFloat(cs.rowGap || cs.gap) || 0;
  if (count > 1) {
    h += gap * (count - 1);
  }
  h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return Math.max(220, Math.round(h / 4) * 4);
}

export function setNodeHeight(node, h) {
  node.size[1] = h;
  if (typeof node.setSize === "function") {
    node.setSize([node.size[0], h]);
  }
  node._agAutoH = h;
}

export function refitNode(node, root) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const cur = node.size[1];
  const autoH = node._agAutoH;
  const userEnlarged = autoH != null && cur > autoH + 4;
  let target = cur;
  if (want > cur) {
    target = want;
  } else if (!userEnlarged && want < cur) {
    target = want;
  }
  if (target !== cur) {
    setNodeHeight(node, target);
  }
}

export function scheduleRefit(node, root) {
  requestAnimationFrame(() => {
    refitNode(node, root);
    if (node.setDirtyCanvas) {
      node.setDirtyCanvas(true, true);
    }
  });
}

export function scheduleInitialFit(node, root) {
  requestAnimationFrame(() => {
    if (node._agConfigured) {
      // Loaded from a saved workflow — onConfigure already restored
      // node.size; trust it, don't grow/shrink to content.
      return;
    }
    refitNode(node, root);
    if (node.setDirtyCanvas) {
      node.setDirtyCanvas(true, true);
    }
  });
}
