/**
 * render.mjs — DOM building + injected CSS for `AnimaGenerator` /
 * `AnimaPreview` (`docs/generator-design.md` §5/§7, ported from the signed-
 * off `playground/generator.html`). Pure DOM construction and painting only
 * — no event listeners (`interaction.mjs` wires those) and no `node`/`app`/
 * `LiteGraph` reference, so this module is importable by the headless
 * `test_resize.mjs` under plain `node` via a small doc stub, matching every
 * other DOM-widget node in this pack.
 *
 * ## Architecture: full-body REBUILD on every discrete action, not a diff
 *
 * Unlike `js/controls/render.mjs` (one `addDOMWidget` PER ROW, a fixed row
 * height, and an incremental `syncRows` diff) or `js/prompt_rules/node/
 * render.mjs` (one static body, never restructured), this node's body
 * genuinely restructures on almost every action: toggling
 * `use_internal_loaders` shows/hides five rows plus the LoRA list; adding a
 * LoRA or a detailer block changes row counts; toggling a stage changes its
 * summary text. Diffing that incrementally buys little here (the body is a
 * few dozen elements, not hundreds) and risks exactly the class of bug
 * `comfyui-node-renders-but-dead` catalogues (a stale ref pointing at a
 * detached element). So `buildGeneratorBody`/`buildPreviewBody` below each
 * build the ENTIRE body fresh from the current settings object every time
 * `interaction.mjs`'s `repaintGenerator`/`repaintPreview` runs (after every
 * toggle/add/remove/commit) — cheap, and it can never drift from the state
 * it was built from. Popovers are a SEPARATE DOM subtree (appended to
 * `document.body`, per `js/shared/overlay.mjs`), so rebuilding the node body
 * never disturbs an open popover's own inputs or scroll position; typing in
 * a popover field only ever triggers a BODY rebuild (to update a row's
 * summary text), never a popover rebuild, unless the edit itself is the kind
 * that changes what the popover should show (e.g. flipping
 * `inherit_sampler_settings` -- `interaction.mjs` handles that by re-running
 * the popover's own content builder in place when needed).
 *
 * ## Real sockets vs. this body's own "status rows"
 *
 * `AnimaGenerator` has real litegraph INPUT sockets (`positive`, `negative`,
 * `model`/`clip`/`vae`/`latent`, `seed`/`steps`/`cfg`/`sampler_name`/
 * `scheduler`) and real OUTPUT sockets (`image`/`image_base`/`image_mid`/
 * `latent`/`metadata_json`) — those are litegraph's own dots, drawn at their
 * usual fixed position, completely independent of this DOM widget. The rows
 * this module builds for them (`buildStatusRow`) are informational ONLY: a
 * label plus a computed wired/ignored badge, so a socket that's ignored in
 * the current mode LOOKS ignored (design doc's "rows that are ignored must
 * look ignored") even though the real dot for it sits elsewhere on the node.
 * They are never interactive and never draw a fake socket dot of their own.
 *
 * ## Popover content builders live here too
 *
 * `buildXPopover(doc, state, view)` functions build a popover's CONTENT
 * (never open it — `openOverlayWithZoom`, in `interaction.mjs`, does that)
 * from small declarative field tables (`FIELD.text/number/select`) so the
 * ~10 tabs (sampler/mod/lora/highres/detailer/upscale/postprocess/latent/
 * preview/save) don't each hand-roll DOM. `interaction.mjs` wires every
 * field's `change` (text/number/select — committed on blur/Enter, not
 * per-keystroke, to avoid rebuilding the node body while someone is mid-type)
 * by reading the SAME field spec back.
 *
 * ## Importing `theme.mjs` — GUARDED dynamic import
 *
 * Same reasoning as every other node's `render.mjs` in this pack (see e.g.
 * `js/controls/render.mjs`'s identical doc comment): this file is imported
 * directly by the headless `test_resize.mjs`, so a static top-level import
 * of the absolute `/extensions/.../theme.mjs` path would throw
 * `ERR_MODULE_NOT_FOUND` before a single assertion runs. This module's own
 * CSS carries `var(--wtn-x, <hardcoded fallback hex>)` everywhere, so
 * styling is correct whether or not the shared stylesheet import lands in
 * time.
 */

import { MAX_DETAILER_PASSES, isBuiltinDetailerBlock } from "./state.mjs";

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
.wtn-an-body { display: flex; flex-direction: column; gap: 4px; }

.wtn-an-sec { font-family: var(--wtn-font-mono, monospace); font-size: 9px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  margin: 9px 0 4px; display: flex; align-items: center; gap: 7px; }
.wtn-an-sec::after { content: ""; flex: 1; height: 1px; background: var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-an-sec:first-child { margin-top: 2px; }
.wtn-an-sec .wtn-an-cnt { color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }

/* ── status rows: informational only, mirror a REAL litegraph socket ── */
.wtn-an-status { display: flex; align-items: center; gap: 8px; height: 20px;
  font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; color: var(--wtn-ink-dim, ${TOKENS.inkDim}); }
.wtn-an-status .wtn-an-dot { width: 8px; height: 8px; border-radius: 50%; flex: none;
  border: 1.5px solid var(--wtn-line, ${TOKENS.line}); background: var(--wtn-console, ${TOKENS.console}); }
.wtn-an-status.wtn-an-wired .wtn-an-dot { background: var(--wtn-accent, ${TOKENS.accent}); border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-status.wtn-an-ignored { opacity: .4; }
.wtn-an-status .wtn-an-ty { margin-left: auto; font-size: 8.5px; letter-spacing: .08em; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); border-radius: 3px; padding: 0 3px; }

/* ── generic clickable row ── */
.wtn-an-row { position: relative; display: flex; align-items: center; gap: 8px;
  height: 25px; margin-bottom: 4px; padding: 0 8px; border-radius: 6px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft});
  font-size: 11.5px; cursor: pointer; }
.wtn-an-row:hover { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-an-row:hover .wtn-an-val { color: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }
.wtn-an-row.wtn-an-open { border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-row .wtn-an-nm { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); white-space: nowrap; }
.wtn-an-row .wtn-an-val { margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 11px;
  color: var(--wtn-ink, ${TOKENS.ink}); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ── stage row: toggle + name + summary + gear ── */
.wtn-an-stagerow { position: relative; display: flex; align-items: center; gap: 9px; height: 27px;
  margin-bottom: 4px; padding: 0 8px; border-radius: 6px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-an-stagerow.wtn-an-off { opacity: .5; }
.wtn-an-stagerow.wtn-an-dep { border-color: rgba(251,191,36,.35); }
.wtn-an-sw { position: relative; width: 26px; height: 14px; flex: none; cursor: pointer;
  background: var(--wtn-console, ${TOKENS.console}); border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 8px;
  transition: background .12s, border-color .12s; }
.wtn-an-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 8px; height: 8px;
  border-radius: 50%; background: var(--wtn-ink-faint, ${TOKENS.inkFaint}); transition: transform .12s, background .12s; }
.wtn-an-sw.wtn-an-on { background: rgba(45,212,191,.22); border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-an-sw.wtn-an-on::after { transform: translateX(12px); background: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-sw.wtn-an-sm { width: 20px; height: 11px; }
.wtn-an-sw.wtn-an-sm::after { width: 6px; height: 6px; top: 1.5px; left: 1.5px; }
.wtn-an-sw.wtn-an-sm.wtn-an-on::after { transform: translateX(9px); }
.wtn-an-stagerow .wtn-an-sn { font-size: 11.5px; font-weight: 550; }
.wtn-an-stagerow .wtn-an-ss { margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 9.5px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wtn-an-gear { flex: none; font-size: 11px; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); cursor: pointer; line-height: 1; padding: 2px; }
.wtn-an-gear:hover, .wtn-an-gear.wtn-an-active { color: var(--wtn-accent, ${TOKENS.accent}); }

/* ── LoRA rows (in the node body -- these get touched constantly) ── */
.wtn-an-lora { position: relative; display: flex; align-items: center; gap: 7px; height: 24px; margin-bottom: 4px;
  padding: 0 8px; border-radius: 6px; font-size: 11px;
  background: var(--wtn-surface-2, ${TOKENS.surface2}); border: 1px solid var(--wtn-line-soft, ${TOKENS.lineSoft}); }
.wtn-an-lora.wtn-an-muted { opacity: .45; }
.wtn-an-lora.wtn-an-empty { justify-content: center; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 10.5px;
  border-style: dashed; background: none; height: 30px; }
.wtn-an-lora .wtn-an-ln { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim}); font-family: var(--wtn-font-mono, monospace); font-size: 10px; cursor: pointer; }
.wtn-an-lora .wtn-an-lv { font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; color: var(--wtn-ink, ${TOKENS.ink}); flex: none; }
.wtn-an-addbtn { display: block; width: 100%; margin-top: 2px; padding: 6px; cursor: pointer;
  font-size: 11px; font-weight: 550; border-radius: 6px; color: var(--wtn-on-accent, ${TOKENS.onAccent});
  background: var(--wtn-accent, ${TOKENS.accent}); border: 1px solid var(--wtn-accent, ${TOKENS.accent}); }
.wtn-an-addbtn:hover { background: var(--wtn-accent-strong, ${TOKENS.accentStrong}); }

/* ── popover content (shares the overlay shell from js/shared/overlay.mjs) ── */
.wtn-an-pop { width: 268px; padding: 12px 13px; border-radius: 10px; border: 1px solid var(--wtn-line, ${TOKENS.line});
  background: var(--wtn-surface, ${TOKENS.surface}); box-shadow: var(--wtn-shadow, 0 18px 46px rgba(0,0,0,.66));
  max-height: 420px; overflow: auto; }
.wtn-an-pop h4 { margin: 0 0 10px; font-family: var(--wtn-font-mono, monospace); font-size: 9.5px; letter-spacing: .13em;
  text-transform: uppercase; color: var(--wtn-accent, ${TOKENS.accent}); font-weight: 500; display: flex; align-items: center; gap: 7px; }
.wtn-an-pop h4 .wtn-an-x { margin-left: auto; cursor: pointer; color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 12px; }
.wtn-an-pop h4 .wtn-an-x:hover { color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-an-grid { display: grid; grid-template-columns: 1fr; gap: 7px 10px; }
.wtn-an-field { display: flex; align-items: center; gap: 8px; font-size: 11.5px; margin-bottom: 2px; }
.wtn-an-field > span { color: var(--wtn-ink-dim, ${TOKENS.inkDim}); width: 108px; flex: none; }
.wtn-an-field input, .wtn-an-field select { flex: 1; min-width: 0; font-family: var(--wtn-font-mono, monospace);
  font-size: 11px; color: var(--wtn-ink, ${TOKENS.ink}); background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: 5px; padding: 4px 6px; outline: none; }
.wtn-an-field input:focus, .wtn-an-field select:focus { border-color: var(--wtn-accent-deep, ${TOKENS.accentDeep}); }
.wtn-an-driven { flex: 1; min-width: 0; font-family: var(--wtn-font-mono, monospace); font-size: 10.5px; cursor: pointer;
  color: var(--wtn-accent, ${TOKENS.accent}); background: rgba(45,212,191,.07); padding: 4px 6px; border-radius: 5px;
  border: 1px solid var(--wtn-accent-deep, ${TOKENS.accentDeep}); border-style: dashed; }
.wtn-an-driven:hover { background: rgba(45,212,191,.14); }
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
.wtn-an-seg { display: flex; gap: 0; }
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

/** Non-interactive socket status row -- see this module's top doc comment
 * for why this is informational only, never a fake socket. */
export function buildStatusRow(doc, { name, type, wired, ignored, title }) {
  const row = el(doc, "div", `wtn-an-status${wired ? " wtn-an-wired" : ""}${ignored ? " wtn-an-ignored" : ""}`);
  if (title) {
    row.title = title;
  }
  const dot = el(doc, "span", "wtn-an-dot");
  const label = el(doc, "span");
  label.textContent = name;
  const ty = el(doc, "span", "wtn-an-ty");
  ty.textContent = type;
  row.appendChild(dot);
  row.appendChild(label);
  row.appendChild(ty);
  return row;
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

export function buildSwitch(doc, on, small) {
  return el(doc, "span", `wtn-an-sw${small ? " wtn-an-sm" : ""}${on ? " wtn-an-on" : ""}`);
}

export function buildGear(doc, title) {
  const gear = el(doc, "span", "wtn-an-gear");
  gear.textContent = "⚙";
  if (title) {
    gear.title = title;
  }
  return gear;
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
// Generic popover field builders -- shared by every settings tab.
// ---------------------------------------------------------------------------

/** Builds one labeled field: `<input type=text>` (number/text) or `<select>`
 * (enum). Returns `{ root, control }` -- `interaction.mjs` wires `change`. */
export function buildField(doc, label, value, options) {
  const field = el(doc, "div", "wtn-an-field");
  const span = el(doc, "span");
  span.textContent = label;
  field.appendChild(span);
  let control;
  if (Array.isArray(options)) {
    control = el(doc, "select");
    options.forEach((opt) => {
      const o = el(doc, "option");
      o.value = String(opt);
      o.textContent = String(opt);
      if (String(opt) === String(value)) {
        o.selected = true;
      }
      control.appendChild(o);
    });
  } else {
    control = el(doc, "input");
    control.type = "text";
    control.value = value == null ? "" : String(value);
  }
  field.appendChild(control);
  return { root: field, control };
}

/** A field whose value is driven by a wire -- design doc §5a. Click target
 * is returned as `root` itself (a clickable "unwire" affordance). */
export function buildDrivenField(doc, label, socketName) {
  const field = el(doc, "div", "wtn-an-field");
  const span = el(doc, "span");
  span.textContent = label;
  field.appendChild(span);
  const driven = el(doc, "span", "wtn-an-driven");
  driven.title = "This value comes from the wired socket. Click to disconnect it.";
  const prefix = el(doc, "span");
  prefix.textContent = "driven by wire · ";
  const b = el(doc, "b");
  b.textContent = socketName;
  driven.appendChild(prefix);
  driven.appendChild(b);
  field.appendChild(driven);
  return { root: field, control: driven };
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
// `js/prompt_rules/node/render.mjs` exactly; see the frontend skill's
// "DOM-widget resize mechanism" and that module's own doc comment for the
// full two-renderer rationale).
// ---------------------------------------------------------------------------

export const CHROME = 40;
export const DEFAULT_W = 360;
export const DEFAULT_H = 420;
export const PREVIEW_DEFAULT_H = 420;

export function measureMinHeight(root, floor) {
  if (!root) {
    return floor || 220;
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
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(root) : {};
  const gap = parseFloat(cs.rowGap || cs.gap) || 0;
  if (count > 1) {
    h += gap * (count - 1);
  }
  h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return Math.max(floor || 220, Math.round(h / 4) * 4);
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
