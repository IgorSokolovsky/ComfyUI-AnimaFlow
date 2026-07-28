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
 * (`../ComfyUI-EasyUseAnima/web/js/aio/generator_panel_runtime.js`): a fixed
 * `min-height`/`max-height` with `overflow-y: auto`, so the NODE stops
 * growing once the panel hits its ceiling and the panel scrolls internally
 * instead. `measureMinHeight` below enforces the same `[PANEL_MIN_H,
 * PANEL_MAX_H]` range in JS (not just via the CSS declaration), so the cap
 * is deterministic under this file's own headless test (no real layout
 * engine to enforce a CSS `max-height` there) and not just a hope that the
 * browser's computed `offsetHeight` happens to agree.
 *
 * The body is still rebuilt in full on every discrete action (see the old
 * version of this file's doc comment, carried forward): toggling a stage,
 * editing a field, adding a detailer block all replace `.wtn-an-panel`'s
 * children wholesale via `interaction.mjs`'s `repaintGenerator`/
 * `repaintPreview`. Popovers are a SEPARATE DOM subtree (appended to
 * `document.body`, per `js/shared/overlay.mjs`), so a body rebuild never
 * disturbs an open popover.
 *
 * ## Wheel: scroll the panel when it has room, zoom the canvas otherwise
 *
 * This is `js/shared/canvas_zoom.mjs`'s job, unchanged — `index.js` installs
 * `installCanvasZoomPassthrough` on the DOM widget's ROOT (not the panel),
 * and that module's `scrollRegionWantsWheel` already walks from the wheel
 * event's target up to the root looking for a genuinely scrollable ancestor
 * with room in the wheel's own direction — `.wtn-an-panel`'s `overflow-y:
 * auto` is exactly such an ancestor once its content overflows
 * `PANEL_MAX_H`. No bespoke "is this scrollable" check is written here —
 * that duplication is exactly what the design brief warned against.
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
 * ## Context-supplied fields render disabled, with the reason visible
 *
 * `seed`/`steps`/`cfg`/`sampler_name`/`scheduler` are still each
 * independently overridable (design doc §5a), but there is no more "wired
 * socket on the Generator" to check — the signal is now "did the
 * `AnimaContextBridge` upstream of `context` have THAT socket wired"
 * (`interaction.mjs`'s `computeContextSupplied`, walking the real litegraph
 * link). A supplied field renders via `js/shared/fields.mjs`'s
 * `buildDrivenField` (a static "driven by the Context Bridge" row, no drag/
 * click to edit) rather than an editable control a wire would silently
 * override.
 *
 * ## This module owns only small presentational builders — popovers
 * themselves live in `interaction.mjs`
 *
 * `interaction.mjs`'s `openXPopover(doc, state, view)` functions build each
 * popover's CONTENT (never open it — `openOverlayWithZoom` there does that)
 * out of the small field builders THIS module exports: `buildTextField`/
 * `buildBoolField` locally, and `js/shared/fields.mjs`'s
 * `buildNumericField`/`buildStepperField`/`buildSwitch` re-exported from
 * here (design brief: "use our existing fields from the control panel
 * instead of creating new fields" — see that module's own doc comment for
 * exactly what's reused and why the DOM/CSS itself is new rather than
 * importing `js/controls/render.mjs` directly). Free-text fields
 * (`detect_prompt`, `filename`, `path`, …) have no Control Panel analogue
 * (that track has none), so `buildTextField` stays local to this module.
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
import { injectFieldStyles, buildSwitch, buildGear, buildDrivenField } from "../shared/fields.mjs";

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
   comment. min-height/max-height here are the visual/live-browser half of
   the cap; measureMinHeight below is the deterministic, testable half. ── */
.wtn-an-panel { display: flex; flex-direction: column; gap: 4px; padding: 6px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 8px;
  background: var(--wtn-surface, ${TOKENS.surface});
  min-height: 220px; max-height: 480px; overflow-y: auto; overflow-x: hidden; }

.wtn-an-sec { font-family: var(--wtn-font-mono, monospace); font-size: 9px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  margin: 9px 0 4px; display: flex; align-items: center; gap: 7px; }
.wtn-an-sec::after { content: ""; flex: 1; height: 1px; background: var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-an-sec:first-child { margin-top: 2px; }
.wtn-an-sec .wtn-an-cnt { color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

/* ── generic clickable row ──
   overflow: hidden here (and on .wtn-an-stagerow below) is the same
   defensive backstop as js/controls/render.mjs's .wtn-ctl-body (Tier 2
   item 8, docs/pixaroma-review-rounds-plan.md) -- these rows have no
   litegraph output dot living outside their own box (unlike a Control
   Panel row: this track's nodes are single-DOM-widget panels, no
   per-row addOutput/dot), so unlike THAT fix, no row/body split is
   needed here -- overflow: hidden can go straight on the row. .wtn-an-nm
   additionally gets min-width: 0 + ellipsis so a long hand-typed name
   can't push .wtn-an-val (already shrinkable) or a trailing gear out
   past the rounded border either. */
.wtn-an-row { position: relative; display: flex; align-items: center; gap: 8px;
  height: 25px; margin-bottom: 4px; padding: 0 8px; border-radius: 6px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font-size: 11.5px; cursor: pointer; overflow: hidden; }
.wtn-an-row:hover { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-an-row:hover .wtn-an-val { color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-an-row.wtn-an-open { border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-row .wtn-an-nm { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap;
  flex: 0 4 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.wtn-an-row .wtn-an-val { margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 11px;
  color: var(--wtn-ink, ${TOKENS.ink}); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 0 1 auto; }

/* ── stage row: toggle + name + summary + gear -- same backstop as
   .wtn-an-row above (no dot to protect against clipping here either). ── */
.wtn-an-stagerow { position: relative; display: flex; align-items: center; gap: 9px; height: 27px;
  margin-bottom: 4px; padding: 0 8px; border-radius: 6px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  overflow: hidden; }
.wtn-an-stagerow.wtn-an-off { opacity: .5; }
.wtn-an-stagerow.wtn-an-dep { border-color: rgba(251,191,36,.35); }
.wtn-an-stagerow .wtn-an-sn { font-size: 11.5px; font-weight: 550; flex: none; white-space: nowrap; }
.wtn-an-stagerow .wtn-an-ss { margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 9.5px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── popover content (shares the overlay shell from js/shared/overlay.mjs) ──
   width/max-height/box-sizing below are the signed-off mockup's OWN numbers
   (playground/generator.html:247/:252 -- \`.pop\`'s \`width: 344px\` /
   \`max-height: 460px\`). \`box-sizing: border-box\` matters here specifically
   because popovers are appended to \`document.body\` (js/shared/overlay.mjs),
   not under \`.wtn-an-root\`. */
.wtn-an-pop { box-sizing: border-box; width: 344px; padding: 12px 13px; border-radius: 10px;
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  background: var(--wtn-surface, ${TOKENS.surface}); box-shadow: var(--wtn-shadow, 0 18px 46px rgba(0,0,0,.66));
  max-height: 460px; overflow: auto; }
.wtn-an-pop h4 { margin: 0 0 10px; font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--wtn-accent, ${TOKENS.accent}); font-weight: 500; display: flex; align-items: center; gap: 7px; }
.wtn-an-pop h4 .wtn-an-x { margin-left: auto; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 12px; }
.wtn-an-pop h4 .wtn-an-x:hover { color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-an-grid { display: flex; flex-direction: column; gap: 4px; }

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
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin: 12px 0 7px; padding-top: 10px; border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-an-sublab:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.wtn-an-dnote { font-size: 11px; line-height: 1.55; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); margin: 0 0 11px;
  padding: 8px 10px; border-radius: 8px; background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); border-left: 2px solid var(--wtn-info, ${TOKENS.info}); }
.wtn-an-dnote.wtn-an-warn { border-left-color: var(--wtn-warn, ${TOKENS.warn}); }
.wtn-an-missing { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
  padding: 9px 10px; border-radius: 8px; margin-bottom: 11px; background: rgba(251,191,36,.06); border: 1px solid rgba(251,191,36,.28); }
.wtn-an-passtabs { display: flex; gap: 5px; margin-bottom: 11px; flex-wrap: wrap; }
.wtn-an-passtabs button { font-family: var(--wtn-font-mono, monospace); font-size: 10px; padding: 4px 9px; cursor: pointer;
  border-radius: 6px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); background: var(--wtn-surface-2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); }
.wtn-an-passtabs button.wtn-an-on { background: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-on-accent, ${TOKENS.onAccent}); border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-passtabs button:disabled { opacity: .4; cursor: default; }
.wtn-an-popfoot { display: flex; gap: 7px; margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-an-pbtn { font-size: 11.5px; cursor: pointer; flex: 1; background: transparent; border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: 7px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); padding: 5px 8px; }
.wtn-an-pbtn:hover { color: var(--wtn-ink, ${TOKENS.ink}); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-an-pbtn.wtn-an-danger:hover { color: var(--wtn-bad, ${TOKENS.bad}); border-color: var(--wtn-bad, ${TOKENS.bad}); }

/* ── Preview node: hover wipe ── */
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
 * the single bordered, scrollable child every section/row lives inside. */
export function buildPanelShell(doc) {
  const root = el(doc, "div", "wtn-an-root wtn");
  const panel = el(doc, "div", "wtn-an-panel");
  root.appendChild(panel);
  return { root, panel };
}

/** A themed clickable row (opens a popover, or a plain toggle -- caller
 * wires the listener). Returns `{ root, val }`. */
export function buildClickRow({ doc, name, value, title }) {
  const row = el(doc, "div", "wtn-an-row");
  if (title) {
    row.title = title;
  }
  const nm = el(doc, "span", "wtn-an-nm");
  nm.textContent = name;
  const val = el(doc, "span", "wtn-an-val");
  val.textContent = value == null ? "" : String(value);
  row.appendChild(nm);
  row.appendChild(val);
  return { root: row, val };
}

// Re-exported so `interaction.mjs` has one import line for both the shared
// primitives and this module's own presentational builders.
export { buildSwitch, buildGear, buildDrivenField };

// ---------------------------------------------------------------------------
// Preview node -- wipe pane images. `nodes/anima/preview.py`'s
// `"ui": {"images": [...]}}` payload (`build_preview_ui_images`, design doc
// §7/§7a's fix) is `{filename, subfolder, type, stage}` per entry; these two
// helpers turn ONE such entry into a real `<img>` the wipe can show.
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
 * (mirrors `.wtn-an-driven`'s inline-note habit rather than a bare pill with
 * no text). Returns `{ root, switchEl }`. */
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

export function buildSublabel(doc, str) {
  return text(doc, "div", "wtn-an-sublab", str);
}

export function buildNote(doc, str, warn) {
  return text(doc, "div", `wtn-an-dnote${warn ? " wtn-an-warn" : ""}`, str);
}

export function buildMissing(doc, str) {
  const m = el(doc, "div", "wtn-an-missing");
  const k = text(doc, "span", "", str);
  m.appendChild(k);
  return m;
}

export function buildPopoverShell(doc, title) {
  const root = el(doc, "div", "wtn-an-pop wtn");
  const h = el(doc, "h4");
  const t = el(doc, "span");
  t.textContent = title;
  const x = el(doc, "span", "wtn-an-x");
  x.textContent = "✕";
  h.appendChild(t);
  h.appendChild(x);
  root.appendChild(h);
  return { root, closeBtn: x };
}

// ---------------------------------------------------------------------------
// Resize (ComfyUI-Pixaroma find_replace mechanism -- matches
// `js/prompt_rules/node/render.mjs`; see the frontend skill's "DOM-widget
// resize mechanism" and that module's own doc comment for the full
// two-renderer rationale). 2026-07-28: `measureMinHeight` now also enforces
// `PANEL_MAX_H` as a ceiling, not just a floor -- see this module's top doc
// comment.
// ---------------------------------------------------------------------------

export const CHROME = 40;
export const DEFAULT_W = 360;
export const DEFAULT_H = 340;
export const PREVIEW_DEFAULT_H = 420;

// The panel's own content-height range (excludes root padding/CHROME) --
// mirrored in this module's CSS (`.wtn-an-panel`'s `min-height`/
// `max-height`). Chosen so the COMMON case (sampler summary + mod-guidance
// row + all four stage rows, nothing expanded) fits with no scrollbar
// (~230px), while a node with several detailer blocks added, or every
// stage's summary text at once, caps out at a size that still leaves most
// of a crowded graph visible rather than growing without limit.
export const PANEL_MIN_H = 220;
export const PANEL_MAX_H = 480;

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

/** litegraph's `onResize(size)` contract: mutate `size` IN PLACE. Never
 * touches `size[1]` (height stays owned by `getMinHeight`/`refitNode`). */
export function clampGeneratorSize(size) {
  return clampMinWidth(size, GENERATOR_MIN_W);
}

export function clampPreviewSize(size) {
  return clampMinWidth(size, PREVIEW_MIN_W);
}

/** Sum of `root`'s children's `offsetHeight` (skipping display:none),
 * clamping the `.wtn-an-panel` child's OWN contribution to `[PANEL_MIN_H,
 * PANEL_MAX_H]` -- the same "substitute a fixed min/max for a growing
 * child's real offsetHeight" pattern the frontend skill documents for a
 * flex-fill preview child, generalized to a ceiling as well as a floor. This
 * is what makes the cap deterministic under this file's own headless test
 * (no real layout engine there to enforce the CSS `max-height` declaration)
 * as well as correct in a live browser (where the two agree). */
export function measureMinHeight(root) {
  if (!root) {
    return PANEL_MIN_H;
  }
  let h = 0;
  let count = 0;
  for (const child of root.children) {
    if (child.offsetParent === null) {
      continue;
    }
    count += 1;
    if (child.classList && child.classList.contains("wtn-an-panel")) {
      h += Math.max(PANEL_MIN_H, Math.min(PANEL_MAX_H, child.offsetHeight));
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
  return Math.max(PANEL_MIN_H, Math.round(h / 4) * 4);
}

export function setNodeHeight(node, h) {
  node.size[1] = h;
  if (typeof node.setSize === "function") {
    node.setSize([node.size[0], h]);
  }
  node._anAutoH = h;
}

export function refitNode(node, root, defaultH) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, defaultH || DEFAULT_H);
  const cur = node.size[1];
  const autoH = node._anAutoH;
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

export function scheduleRefit(node, root, defaultH) {
  requestAnimationFrame(() => {
    refitNode(node, root, defaultH);
    if (node.setDirtyCanvas) {
      node.setDirtyCanvas(true, true);
    }
  });
}

export function scheduleInitialFit(node, root, configuredFlag, defaultH) {
  requestAnimationFrame(() => {
    if (node[configuredFlag]) {
      // Loaded from a saved workflow -- onConfigure already restored
      // node.size; trust it, don't grow/shrink to content.
      return;
    }
    refitNode(node, root, defaultH);
    if (node.setDirtyCanvas) {
      node.setDirtyCanvas(true, true);
    }
  });
}

// Re-export the shared cap so callers only need one import for both the
// state-mutation helpers (state.mjs) and this display-only constant.
export { MAX_DETAILER_PASSES, isBuiltinDetailerBlock };
