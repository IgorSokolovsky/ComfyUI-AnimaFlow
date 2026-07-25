/**
 * render.mjs — DOM UI for the Anima Prompt Studio node.
 *
 * Builds ONE DOM root (mounted as a single `addDOMWidget`), styled with the
 * shared house theme (`injectTheme()` + `.wtn-*` classes from
 * `js/shared/theme.{mjs,css}`) instead of re-implementing
 * `playground/anima_prompt_studio.html`'s inline palette verbatim — the
 * playground is a visual/interaction reference only. Layout/interactions
 * are modeled on that mockup: a top bar (Rules correction toggle), two
 * panes (positive/negative) of block cards with per-row tool icons, and a
 * LIVE PREVIEW strip.
 *
 * ## Resize mechanism (the hard part — see the plan + the frontend skill)
 *
 * Unlike this pack's existing DOM-widget nodes (which only grow while
 * typing, e.g. `js/anima_prompt/prompt_combiner`'s LIVE PREVIEW), THIS node's dominant
 * variable-height content is the BLOCK LIST itself: the number of rows in
 * either pane changes on add/remove/reorder. So the same
 * `measureMinHeight`/`refitNode`/`scheduleRefit` mechanism from
 * `js/anima_prompt/prompt_combiner/render.mjs` (ComfyUI-Pixaroma `find_replace`
 * mechanism, matched exactly: legacy `getMinHeight` + Nodes 2.0
 * `computeLayoutSize`, post-layout `requestAnimationFrame` measurement,
 * grow-biased refit with a user-enlarge guard, height-only `setSize`) is
 * used here, but `index.js` wires `scheduleRefit` to fire on every
 * STRUCTURAL block-list mutation (add/remove/reorder — see
 * `interaction.mjs`), never on a plain textarea edit or an enable/pin
 * toggle (those only update in place, see `updateBlockRow`).
 *
 * The LIVE PREVIEW strip does NOT need a `PREVIEW_MIN`-substitution trick
 * like `prompt_combiner`'s (that trick exists specifically to stop an
 * open-ended flex-filled child from inflating its own measurement floor):
 * here the preview boxes are given a bounded `max-height` +
 * `overflow-y:auto` instead (see `.wtn-aps-outbox` below), so
 * `measureMinHeight` can just sum every visible child's real `offsetHeight`
 * — no feedback loop possible, no special-casing needed.
 *
 * Per-block textareas auto-grow their OWN height on typing (a bounded
 * `autoGrowTextarea`, min/max clamped with internal scroll past the max) —
 * this is a per-element, synchronous adjustment (safe: reading a single
 * element's `scrollHeight` right after an `input` event does not suffer
 * the pre-layout-read problem that the NODE-level `measureMinHeight` guards
 * against with `requestAnimationFrame`, because it's the browser's own
 * synchronous reflow for that isolated element, not a measurement of
 * content that other elements' layout depends on) — and never triggers
 * `scheduleRefit` itself, matching "typing grows a field, not the node".
 *
 * ## Why `injectTheme` is a GUARDED DYNAMIC import, not a static one
 *
 * Every other DOM-widget node importing the shared theme (`js/anima/anima_preview`,
 * `js/anima_prompt/rule_builder`, `js/anima_prompt/prompt_rules`) does `import { injectTheme } from
 * "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs"` at the top of the file —
 * but none of THOSE modules have a headless `test_resize.mjs` exercising
 * them directly under plain `node` (only ComfyUI's own server rewrites that
 * absolute `/extensions/...` path; a static top-level import of it makes
 * the whole module fail to even LOAD outside a live ComfyUI/browser host,
 * with `ERR_MODULE_NOT_FOUND`). This node needs both: the shared theme in
 * production AND a headless-testable `render.mjs` per the project's
 * `test_*.mjs` convention. Fix: `injectStyles` (below) only ever attempts
 * the theme import via a dynamic `import()`, and only when a real global
 * `document` exists (i.e. inside an actual browser) — so under `node
 * js/anima_prompt/anima_prompt_studio/test_resize.mjs` (no global `document`) the import
 * is never attempted at all, while a real ComfyUI page still gets the
 * shared stylesheet exactly as before. This module's own CSS below uses the
 * same `var(--wtn-x, <hardcoded fallback hex>)` pattern every other node's
 * CSS already uses (see e.g. `js/anima/anima_preview/render.mjs`), so styling is
 * correct whether or not the theme import lands in time — the literal hex
 * values here are copied from `js/shared/theme.mjs`'s `TOKENS` (kept in
 * sync by hand, same as that module's own doc comment already asks of
 * every consumer).
 */

import { TYPE_LABELS, assembleBothPanesPreview } from "./core.mjs";

const STYLE_ID = "wtn-anima-prompt-studio-style";
const THEME_URL = "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";

// Mirrors js/shared/theme.mjs's TOKENS exactly — see this module's doc
// comment above for why these are hardcoded fallbacks rather than an
// imported reference.
const TOKENS = {
  surface: "#151a21",
  surface2: "#1b212a",
  line: "#28303b",
  ink: "#e7ecf3",
  inkDim: "#93a0b1",
  inkFaint: "#5f6c7d",
  console: "#0a0d12",
  accent: "#2dd4bf",
  ok: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  info: "#7dd3fc",
  tmp: "#c4b5fd",
};

const TYPE_ACCENT = {
  quality: TOKENS.info,
  artist: TOKENS.tmp,
  trigger: TOKENS.warn,
  general: TOKENS.inkDim,
};

const CSS = `
.wtn-aps-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 2px 2px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  /* NO height:100% / min-height here (the ComfyUI-Pixaroma find_replace
     pattern) -- see render.mjs's own doc comment + js/anima_prompt/prompt_combiner's. */
}
.wtn-aps-root, .wtn-aps-root * { box-sizing: border-box; }

.wtn-aps-topbar {
  display: flex; align-items: center; gap: 10px;
  padding-bottom: 9px; margin-bottom: 2px;
  border-bottom: 1px solid var(--wtn-line, ${TOKENS.line});
}
.wtn-aps-topbar-label {
  font-family: var(--wtn-font-mono, monospace); font-size: 10.5px;
  text-transform: uppercase; letter-spacing: .07em;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-aps-topbar-spacer { flex: 1 1 auto; }
.wtn-aps-chip {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-aps-chip.wtn-aps-chip-on { color: var(--wtn-ok, ${TOKENS.ok}); border-color: var(--wtn-ok, ${TOKENS.ok}); }
.wtn-aps-switch {
  width: 32px; height: 18px; border-radius: 999px; flex: 0 0 auto; cursor: pointer;
  background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  position: relative;
}
.wtn-aps-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%;
  background: var(--wtn-ink-faint, ${TOKENS.inkFaint}); transition: left .12s, background .12s;
}
.wtn-aps-switch.wtn-aps-switch-on { border-color: var(--wtn-accent, ${TOKENS.accent}); background: rgba(45,212,191,.16); }
.wtn-aps-switch.wtn-aps-switch-on .wtn-aps-switch-knob { left: 16px; background: var(--wtn-accent, ${TOKENS.accent}); }

.wtn-aps-panes { display: flex; gap: 14px; flex-wrap: wrap; }
.wtn-aps-pane { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; }
.wtn-aps-pane-hd { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
.wtn-aps-pane-hd .wtn-aps-dot { width: 8px; height: 8px; border-radius: 50%; }
.wtn-aps-pane-hd.wtn-aps-pane-positive .wtn-aps-dot { background: var(--wtn-ok, ${TOKENS.ok}); }
.wtn-aps-pane-hd.wtn-aps-pane-negative .wtn-aps-dot { background: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-aps-pane-hd .wtn-aps-pane-title {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-aps-pane-hd .wtn-aps-pane-count {
  margin-left: auto; font-family: var(--wtn-font-mono, monospace); font-size: 10px;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
}

.wtn-aps-blocks-empty {
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-size: 11.5px; font-style: italic; padding: 4px 0 8px;
}

.wtn-aps-block {
  background: var(--wtn-surface-2, ${TOKENS.surface2});
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: var(--wtn-radius, 10px);
  margin-bottom: 8px; overflow: hidden;
}
.wtn-aps-block.wtn-aps-block-disabled { opacity: .45; }
.wtn-aps-block.wtn-aps-block-pinned { border-color: var(--wtn-warn, ${TOKENS.warn}); }
.wtn-aps-block-hd {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  background: var(--wtn-surface, ${TOKENS.surface});
  border-bottom: 1px solid var(--wtn-line-soft, ${TOKENS.line});
}
.wtn-aps-badge {
  font-family: var(--wtn-font-mono, monospace); font-size: 9px; padding: 2px 6px; border-radius: 999px;
  border: 1px solid var(--wtn-line, ${TOKENS.line}); flex: 0 0 auto; text-transform: uppercase;
}
.wtn-aps-label-input {
  flex: 1 1 auto; min-width: 0; background: transparent; border: 1px solid transparent;
  color: var(--wtn-ink, ${TOKENS.ink}); font-size: 11.5px; font-weight: 600;
  border-radius: 5px; padding: 2px 4px; outline: none;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wtn-aps-label-input:hover, .wtn-aps-label-input:focus { border-color: var(--wtn-line, ${TOKENS.line}); background: var(--wtn-console, ${TOKENS.console}); }
.wtn-aps-tools { display: flex; gap: 1px; align-items: center; flex: 0 0 auto; }
.wtn-aps-tool {
  background: transparent; border: none; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
  padding: 2px 5px; font-size: 12px; border-radius: 5px; cursor: pointer; line-height: 1.4;
}
.wtn-aps-tool:hover { color: var(--wtn-accent, ${TOKENS.accent}); background: rgba(45,212,191,.12); }
.wtn-aps-tool.wtn-aps-tool-active { color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-aps-tool.wtn-aps-tool-danger:hover { color: var(--wtn-bad, ${TOKENS.bad}); background: rgba(248,113,113,.14); }
.wtn-aps-tool:disabled { opacity: .3; cursor: default; }
.wtn-aps-block-bd { padding: 8px; }
.wtn-aps-textarea {
  width: 100%; font-family: var(--wtn-font-mono, monospace); font-size: 11.5px;
  color: var(--wtn-ink, ${TOKENS.ink}); background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: var(--wtn-radius-sm, 7px);
  padding: 6px 8px; outline: none; resize: vertical; line-height: 1.5;
  min-height: 44px; max-height: 160px; overflow-y: auto;
}
.wtn-aps-textarea:focus { border-color: var(--wtn-accent, ${TOKENS.accent}); }

.wtn-aps-addrow { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; margin-bottom: 4px; }
.wtn-aps-addbtn {
  font-family: var(--wtn-font-ui, inherit); font-size: 11px; font-weight: 600; cursor: pointer;
  border-radius: 7px; padding: 4px 9px; border: 1px solid var(--wtn-line, ${TOKENS.line});
  background: transparent; color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-aps-addbtn:hover { border-color: var(--wtn-accent, ${TOKENS.accent}); color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-aps-addbtn:disabled { opacity: .35; cursor: default; }

.wtn-aps-preview { padding-top: 10px; border-top: 1px solid var(--wtn-line, ${TOKENS.line}); }
.wtn-aps-preview-title {
  font-size: 10px; text-transform: uppercase; letter-spacing: .09em; font-weight: 700;
  color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); margin: 0 0 6px;
}
.wtn-aps-preview-title .wtn-aps-uncorrected-note { color: var(--wtn-warn, ${TOKENS.warn}); text-transform: none; font-weight: 600; letter-spacing: 0; }
.wtn-aps-outbox {
  background: var(--wtn-surface, ${TOKENS.surface}); border: 1px solid var(--wtn-line, ${TOKENS.line});
  border-radius: 7px; padding: 7px 9px; font-family: var(--wtn-font-mono, monospace); font-size: 11px;
  line-height: 1.6; white-space: pre-wrap; word-break: break-word; margin-bottom: 7px;
  max-height: 140px; overflow-y: auto;
}
.wtn-aps-outbox.wtn-aps-outbox-pos { color: var(--wtn-ok, ${TOKENS.ok}); }
.wtn-aps-outbox.wtn-aps-outbox-neg { color: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-aps-outbox-empty { color: var(--wtn-ink-faint, ${TOKENS.inkFaint}); font-style: italic; }
`;

export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
  }
  // Guarded dynamic import — see this module's top doc comment for why
  // this can't be a static import. `typeof document !== "undefined"` (the
  // real GLOBAL, not the possibly-stubbed `doc` param) is only true inside
  // an actual browser host, where the absolute `/extensions/...` path
  // actually resolves; a headless test run never attempts it.
  if (typeof document !== "undefined") {
    import(THEME_URL)
      .then((mod) => mod.injectTheme())
      .catch(() => {
        // No live ComfyUI server to serve this route (or some other
        // load failure) — non-fatal, this module's own CSS below already
        // falls back to hardcoded hex values via `var(--wtn-x, #hex)`.
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

const PANE_ADD_TYPES = {
  positive: ["quality", "artist", "trigger", "general"],
  negative: ["general"],
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPane(doc, pane) {
  const root = doc.createElement("div");
  root.className = "wtn-aps-pane";

  const hd = doc.createElement("div");
  hd.className = "wtn-aps-pane-hd wtn-aps-pane-" + pane;
  const dot = doc.createElement("span");
  dot.className = "wtn-aps-dot";
  const title = doc.createElement("span");
  title.className = "wtn-aps-pane-title";
  title.textContent = pane === "positive" ? "Positive" : "Negative";
  const count = doc.createElement("span");
  count.className = "wtn-aps-pane-count";
  hd.appendChild(dot);
  hd.appendChild(title);
  hd.appendChild(count);

  const blocksEl = doc.createElement("div");
  blocksEl.className = "wtn-aps-blocks";

  const addRow = doc.createElement("div");
  addRow.className = "wtn-aps-addrow";
  const addButtons = {};
  PANE_ADD_TYPES[pane].forEach((type) => {
    const btn = doc.createElement("button");
    btn.setAttribute("type", "button");
    btn.className = "wtn-aps-addbtn";
    btn.textContent = "+ " + type;
    btn.title = "Add a new \"" + type + "\" block to the " + pane + " pane.";
    addRow.appendChild(btn);
    addButtons[type] = btn;
  });

  root.appendChild(hd);
  root.appendChild(blocksEl);
  root.appendChild(addRow);

  return { root, countEl: count, blocksEl, addButtons, rows: new Map() };
}

/**
 * Build the whole node UI: top bar (Rules correction switch), positive +
 * negative panes, LIVE PREVIEW strip. Returns a flat `refs` object every
 * other function in this module / `interaction.mjs` / `index.js` reads
 * from — no re-querying by class name at call time.
 */
export function buildRoot(doc) {
  const d = doc || document;

  const root = d.createElement("div");
  root.className = "wtn-aps-root wtn";

  // ---- Top bar: Rules correction toggle ----
  const topbar = d.createElement("div");
  topbar.className = "wtn-aps-topbar";
  const topbarLabel = d.createElement("span");
  topbarLabel.className = "wtn-aps-topbar-label";
  topbarLabel.textContent = "Rules correction";
  topbarLabel.title =
    "When off, block text is just concatenated with the separator widget's value -- no reordering. " +
    "When on, each pane's non-pinned block text is run through the in-repo Prompt Rules engine as a " +
    "single pass before assembly (pinned blocks are always skipped -- see each block's pin tool).";
  const spacer = d.createElement("span");
  spacer.className = "wtn-aps-topbar-spacer";
  const chip = d.createElement("span");
  chip.className = "wtn-aps-chip";
  chip.textContent = "Rules: off";
  const switchEl = d.createElement("div");
  switchEl.className = "wtn-aps-switch";
  switchEl.setAttribute("role", "switch");
  switchEl.setAttribute("tabindex", "0");
  switchEl.title = "Toggle Prompt Rules engine correction for both panes' non-pinned text.";
  const knob = d.createElement("div");
  knob.className = "wtn-aps-switch-knob";
  switchEl.appendChild(knob);
  topbar.appendChild(topbarLabel);
  topbar.appendChild(spacer);
  topbar.appendChild(chip);
  topbar.appendChild(switchEl);

  // ---- Panes ----
  const panesEl = d.createElement("div");
  panesEl.className = "wtn-aps-panes";
  const positivePane = buildPane(d, "positive");
  const negativePane = buildPane(d, "negative");
  panesEl.appendChild(positivePane.root);
  panesEl.appendChild(negativePane.root);

  // ---- Live preview strip ----
  const previewSection = d.createElement("div");
  previewSection.className = "wtn-aps-preview";
  const previewTitle = d.createElement("div");
  previewTitle.className = "wtn-aps-preview-title";
  previewTitle.textContent = "Live preview (assembled from enabled blocks, in pane order)";
  const posOut = d.createElement("div");
  posOut.className = "wtn-aps-outbox wtn-aps-outbox-pos";
  const negOut = d.createElement("div");
  negOut.className = "wtn-aps-outbox wtn-aps-outbox-neg";
  previewSection.appendChild(previewTitle);
  previewSection.appendChild(posOut);
  previewSection.appendChild(negOut);

  root.appendChild(topbar);
  root.appendChild(panesEl);
  root.appendChild(previewSection);

  return {
    doc: d,
    root,
    switchEl,
    knob,
    chip,
    panes: { positive: positivePane, negative: negativePane },
    previewTitleEl: previewTitle,
    posOutEl: posOut,
    negOutEl: negOut,
  };
}

// ---------------------------------------------------------------------------
// Per-textarea auto-grow (content-growth only, never resizes the node)
// ---------------------------------------------------------------------------

const TEXTAREA_MIN_H = 44;
const TEXTAREA_MAX_H = 160;

/** Grow (or shrink back down to) `ta`'s own height to fit its content,
 * clamped to `[TEXTAREA_MIN_H, TEXTAREA_MAX_H]` — past the max it scrolls
 * internally (`overflow-y: auto`, set in CSS) instead of growing further.
 * A synchronous per-element adjustment (safe — see this module's doc
 * comment for why this differs from the node-level `measureMinHeight`,
 * which must only run inside `requestAnimationFrame`). Never calls
 * `scheduleRefit` — typing must never force a structural node resize. */
export function autoGrowTextarea(ta) {
  if (!ta || !ta.style) {
    return;
  }
  ta.style.height = "auto";
  const scrollH = ta.scrollHeight || 0;
  const clamped = Math.max(TEXTAREA_MIN_H, Math.min(TEXTAREA_MAX_H, scrollH));
  ta.style.height = clamped + "px";
}

// ---------------------------------------------------------------------------
// Block row rendering
// ---------------------------------------------------------------------------

const TOOL_TIPS = {
  toggle: (block) => (block.enabled ? "Disable this block (excluded from assembly + preview)" : "Enable this block"),
  pin: () =>
    "Pin: bypass Rules correction entirely -- this block's text is kept verbatim at its own position " +
    "(for LoRA trigger words or anything else that must never be reordered/rewritten).",
  up: "Move this block up",
  down: "Move this block down",
  del: "Delete this block",
};

function buildBlockRow(doc, pane, block, handlers) {
  const row = doc.createElement("div");
  row.className = "wtn-aps-block";

  const hd = doc.createElement("div");
  hd.className = "wtn-aps-block-hd";

  const badge = doc.createElement("span");
  badge.className = "wtn-aps-badge";
  badge.style.color = TYPE_ACCENT[block.type] || TOKENS.inkDim;
  badge.style.borderColor = TYPE_ACCENT[block.type] || TOKENS.line;
  badge.textContent = block.type;

  const labelInput = doc.createElement("input");
  labelInput.type = "text";
  labelInput.className = "wtn-aps-label-input";
  labelInput.setAttribute("spellcheck", "false");
  labelInput.value = block.label;
  labelInput.title = block.label;

  const tools = doc.createElement("span");
  tools.className = "wtn-aps-tools";

  const toggleBtn = doc.createElement("button");
  toggleBtn.setAttribute("type", "button");
  toggleBtn.className = "wtn-aps-tool" + (block.enabled ? " wtn-aps-tool-active" : "");
  toggleBtn.textContent = block.enabled ? "●" : "○";
  toggleBtn.title = TOOL_TIPS.toggle(block);
  toggleBtn.setAttribute("aria-label", "Toggle enabled");

  const pinBtn = doc.createElement("button");
  pinBtn.setAttribute("type", "button");
  pinBtn.className = "wtn-aps-tool" + (block.pin ? " wtn-aps-tool-active" : "");
  pinBtn.textContent = "📌";
  pinBtn.title = TOOL_TIPS.pin();
  pinBtn.setAttribute("aria-label", "Pin (bypass Rules correction)");

  const upBtn = doc.createElement("button");
  upBtn.setAttribute("type", "button");
  upBtn.className = "wtn-aps-tool";
  upBtn.textContent = "↑";
  upBtn.title = TOOL_TIPS.up;
  upBtn.setAttribute("aria-label", "Move block up");

  const downBtn = doc.createElement("button");
  downBtn.setAttribute("type", "button");
  downBtn.className = "wtn-aps-tool";
  downBtn.textContent = "↓";
  downBtn.title = TOOL_TIPS.down;
  downBtn.setAttribute("aria-label", "Move block down");

  const delBtn = doc.createElement("button");
  delBtn.setAttribute("type", "button");
  delBtn.className = "wtn-aps-tool wtn-aps-tool-danger";
  delBtn.textContent = "✕";
  delBtn.title = TOOL_TIPS.del;
  delBtn.setAttribute("aria-label", "Delete block");

  tools.appendChild(toggleBtn);
  tools.appendChild(pinBtn);
  tools.appendChild(upBtn);
  tools.appendChild(downBtn);
  tools.appendChild(delBtn);

  hd.appendChild(badge);
  hd.appendChild(labelInput);
  hd.appendChild(tools);

  const bd = doc.createElement("div");
  bd.className = "wtn-aps-block-bd";
  const textarea = doc.createElement("textarea");
  textarea.className = "wtn-aps-textarea";
  textarea.setAttribute("spellcheck", "false");
  textarea.value = block.text;
  textarea.title = "Block text -- joined into the pane's output by the separator widget.";
  bd.appendChild(textarea);

  row.appendChild(hd);
  row.appendChild(bd);

  const entry = { row, badge, labelInput, toggleBtn, pinBtn, upBtn, downBtn, delBtn, textarea };

  if (handlers) {
    toggleBtn.addEventListener("click", () => handlers.onToggleEnabled(pane, block.id));
    pinBtn.addEventListener("click", () => handlers.onTogglePin(pane, block.id));
    upBtn.addEventListener("click", () => handlers.onMove(pane, block.id, "up"));
    downBtn.addEventListener("click", () => handlers.onMove(pane, block.id, "down"));
    delBtn.addEventListener("click", () => handlers.onDelete(pane, block.id));
    labelInput.addEventListener("input", () => {
      labelInput.title = labelInput.value;
      handlers.onLabelChange(pane, block.id, labelInput.value);
    });
    textarea.addEventListener("input", () => {
      autoGrowTextarea(textarea);
      handlers.onTextChange(pane, block.id, textarea.value);
    });
  }

  return entry;
}

/**
 * Fully tear down and rebuild `pane`'s block-list DOM from `state[pane]`
 * (the STRUCTURAL rebuild path — used for the initial mount, every add/
 * remove/reorder, and `onConfigure` restore). Wires each row's controls via
 * `handlers` (`{onToggleEnabled, onTogglePin, onMove, onDelete,
 * onLabelChange, onTextChange}`, all `(pane, id[, extra]) => void`). Updates
 * the pane's row count + the one-trigger-per-pane add-button guard. Does
 * NOT itself call `scheduleRefit` — that's the caller's job (`index.js`/
 * `interaction.mjs`), fired at the explicit structural triggers.
 */
export function renderPane(refs, pane, state, handlers) {
  const paneRefs = refs.panes[pane];
  const blocks = (state && state[pane]) || [];

  while (paneRefs.blocksEl.firstChild) {
    paneRefs.blocksEl.removeChild(paneRefs.blocksEl.firstChild);
  }
  paneRefs.rows.clear();

  if (!blocks.length) {
    const empty = refs.doc.createElement("div");
    empty.className = "wtn-aps-blocks-empty";
    empty.textContent = "No blocks yet. Add one below.";
    paneRefs.blocksEl.appendChild(empty);
  }

  blocks.forEach((block) => {
    const entry = buildBlockRow(refs.doc, pane, block, handlers);
    entry.row.classList.toggle("wtn-aps-block-disabled", !block.enabled);
    entry.row.classList.toggle("wtn-aps-block-pinned", !!block.pin);
    autoGrowTextarea(entry.textarea);
    paneRefs.rows.set(block.id, entry);
    paneRefs.blocksEl.appendChild(entry.row);
  });

  paneRefs.countEl.textContent = blocks.length + (blocks.length === 1 ? " block" : " blocks");

  // One-trigger-per-pane UI guard (nicety only — never enforced backend-
  // side; see `core.mjs`'s `hasTriggerBlock` doc comment).
  const triggerBtn = paneRefs.addButtons.trigger;
  if (triggerBtn) {
    const hasTrigger = blocks.some((b) => b.type === "trigger");
    triggerBtn.disabled = hasTrigger;
    triggerBtn.title = hasTrigger
      ? "Only one trigger block per pane -- delete the existing one first."
      : 'Add a new "trigger" block to the ' + pane + " pane.";
  }
}

/**
 * Update ONE existing row's visual state in place (no teardown/rebuild) —
 * used for toggle-enable/toggle-pin, which are NOT structural mutations
 * (row count/order never changes). No-op if the row isn't currently
 * rendered (e.g. stale callback after a rebuild already dropped it).
 */
export function updateBlockRow(refs, pane, block) {
  const entry = refs.panes[pane].rows.get(block.id);
  if (!entry) {
    return;
  }
  entry.row.classList.toggle("wtn-aps-block-disabled", !block.enabled);
  entry.row.classList.toggle("wtn-aps-block-pinned", !!block.pin);
  entry.toggleBtn.classList.toggle("wtn-aps-tool-active", !!block.enabled);
  entry.toggleBtn.textContent = block.enabled ? "●" : "○";
  entry.toggleBtn.title = TOOL_TIPS.toggle(block);
  entry.pinBtn.classList.toggle("wtn-aps-tool-active", !!block.pin);
}

// ---------------------------------------------------------------------------
// Rules-correction toggle UI
// ---------------------------------------------------------------------------

export function setRulesToggleUI(refs, on) {
  refs.switchEl.classList.toggle("wtn-aps-switch-on", !!on);
  refs.chip.textContent = "Rules: " + (on ? "on" : "off");
  refs.chip.classList.toggle("wtn-aps-chip-on", !!on);
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

const PREVIEW_EMPTY = "(empty)";

/**
 * Re-render the LIVE PREVIEW strip from `state` — ALWAYS the uncorrected
 * client-side assembly (see `core.mjs`'s doc comment for why). When
 * `rulesCorrectionEnabled` is true, the section title gets an explicit
 * "(uncorrected)" note so nobody mistakes this for the real, engine-
 * corrected output the node actually produces on run. Never resizes the
 * node — safe to call on every keystroke.
 */
export function renderPreview(refs, state, separator, rulesCorrectionEnabled) {
  const { positive, negative } = assembleBothPanesPreview(state, separator || ", ");

  refs.previewTitleEl.innerHTML = rulesCorrectionEnabled
    ? "Live preview (assembled from enabled blocks) " +
      '<span class="wtn-aps-uncorrected-note">-- shown BEFORE Rules correction, the real run output will differ</span>'
    : "Live preview (assembled from enabled blocks, in pane order)";

  refs.posOutEl.innerHTML = positive
    ? escapeHtml(positive)
    : '<span class="wtn-aps-outbox-empty">' + PREVIEW_EMPTY + "</span>";
  refs.negOutEl.innerHTML = negative
    ? escapeHtml(negative)
    : '<span class="wtn-aps-outbox-empty">' + PREVIEW_EMPTY + "</span>";
}

// ---------------------------------------------------------------------------
// Resize (ComfyUI-Pixaroma find_replace mechanism, matched exactly — see
// js/anima_prompt/prompt_combiner/render.mjs's own doc comment for the full two-renderer
// rationale; summarized in this module's top doc comment)
// ---------------------------------------------------------------------------

export const CHROME = 60;
export const DEFAULT_W = 420;
export const DEFAULT_H = 360;

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
  node._apsAutoH = h;
}

export function refitNode(node, root) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const cur = node.size[1];
  const autoH = node._apsAutoH;
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
    if (node._apsConfigured) {
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
