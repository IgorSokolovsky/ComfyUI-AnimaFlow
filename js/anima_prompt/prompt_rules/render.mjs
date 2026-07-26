/**
 * render.mjs — themed DOM UI for the Prompt Rules nodes (`PromptRulesText`
 * / `PromptRulesClip`, `nodes/anima_prompt/prompt_rules.py`).
 *
 * Builds ONE DOM root (mounted as a single `addDOMWidget`, per the
 * dynamic-node-frontend skill), styled with the shared house theme
 * (`injectTheme()` + `.wtn-*` classes from `js/shared/theme.{mjs,css}`) —
 * modeled closely on `js/anima_prompt/anima_prompt_studio/render.mjs` (the reference
 * implementation this build was asked to mirror): a top bar (PROFILE
 * selector + SHEETS field), two labeled panes (POSITIVE/NEGATIVE, each a
 * status-dot header over a themed textarea, with the `log_trace` switch in
 * the NEGATIVE header row), and an action row using the shared
 * `.wtn-btn`/`.wtn-btn--primary`/`.wtn-btn--ghost` classes for "Open Rule
 * Builder" / "Pick…" (`js/shared/theme.css` already defines these — no new
 * button styling is invented here).
 *
 * This node has no dynamic/repeating rows (unlike Prompt Studio's block
 * list) — its layout is static, so there is no "structural mutation"
 * concept here at all: the only automatic node resize is the ONE guarded
 * initial fit at mount/placement (`scheduleInitialFit`, wired from
 * `index.js`), sized from `measureMinHeight` AFTER the two textareas have
 * already been given their real (possibly restored) content and
 * auto-grown once (see `interaction.mjs`'s `refreshFromWidgets`). Typing in
 * either textarea only grows THAT textarea, clamped
 * `[TEXTAREA_MIN_H, TEXTAREA_MAX_H]` (past the max it scrolls internally
 * instead) — a synchronous per-element adjustment, safe for the same
 * reason `anima_prompt_studio/render.mjs`'s own `autoGrowTextarea` doc
 * comment explains — and NEVER touches the node's own size, so there is no
 * keystroke jitter. `scheduleRefit`/`refitNode` are still exported (and
 * exercised the same way as every sibling DOM-widget node) purely so a
 * future structural addition to this node's UI has the mechanism ready
 * without reinventing it — nothing in `index.js`/`interaction.mjs`
 * currently calls `scheduleRefit` outside the guarded initial fit.
 *
 * ## Why `injectStyles` is a GUARDED DYNAMIC import, not a static one
 *
 * Same reasoning as `anima_prompt_studio/render.mjs`'s own doc comment:
 * this module needs to be importable by a headless `test_resize.mjs` under
 * plain `node` (no global `document`, so ComfyUI's own static-file rewrite
 * of `/extensions/...` never applies) AND by a real ComfyUI page. A static
 * top-level `import ... from "/extensions/.../theme.mjs"` would make the
 * whole module fail to even load outside a live browser host. Fix:
 * `injectStyles` only ever attempts the theme import via a dynamic
 * `import()`, gated on a real global `document` existing. This module's own
 * CSS below uses the same `var(--wtn-x, <hardcoded fallback hex>)` pattern
 * every other node's CSS uses, so styling is correct whether or not the
 * shared stylesheet import lands in time.
 */

const STYLE_ID = "wtn-prompt-rules-style";
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
};

const CSS = `
.wtn-pr-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 2px 2px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  /* NO height:100% / min-height here (the ComfyUI-Pixaroma find_replace
     pattern) -- see render.mjs's own doc comment + anima_prompt_studio's. */
}
.wtn-pr-root, .wtn-pr-root * { box-sizing: border-box; }

.wtn-pr-topbar {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  padding-bottom: 9px; margin-bottom: 2px;
  border-bottom: 1px solid var(--wtn-line, ${TOKENS.line});
}
.wtn-pr-field { display: flex; align-items: center; gap: 6px; }
.wtn-pr-field-label {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px;
  text-transform: uppercase; letter-spacing: .07em;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-pr-select, .wtn-pr-input {
  font-family: var(--wtn-font-mono, monospace); font-size: 11.5px;
  color: var(--wtn-ink, ${TOKENS.ink}); background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: var(--wtn-radius-sm, 7px);
  padding: 4px 7px; outline: none;
}
.wtn-pr-select:focus, .wtn-pr-input:focus { border-color: var(--wtn-accent, ${TOKENS.accent}); }
.wtn-pr-input { width: 88px; }
.wtn-pr-topbar-spacer { flex: 1 1 auto; }
.wtn-pr-beta {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px; font-weight: 700;
  padding: 2px 8px; border-radius: 999px; letter-spacing: .04em;
  border: 1px solid var(--wtn-warn, ${TOKENS.warn}); color: var(--wtn-warn, ${TOKENS.warn});
}

.wtn-pr-pane { display: flex; flex-direction: column; gap: 6px; }
.wtn-pr-pane-hd { display: flex; align-items: center; gap: 7px; }
.wtn-pr-pane-hd .wtn-pr-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.wtn-pr-pane-hd.wtn-pr-pane-positive .wtn-pr-dot { background: var(--wtn-ok, ${TOKENS.ok}); }
.wtn-pr-pane-hd.wtn-pr-pane-negative .wtn-pr-dot { background: var(--wtn-bad, ${TOKENS.bad}); }
.wtn-pr-pane-title {
  font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700;
  color: var(--wtn-ink-dim, ${TOKENS.inkDim});
}
.wtn-pr-pane-spacer { flex: 1 1 auto; }
.wtn-pr-trace-label {
  font-family: var(--wtn-font-mono, monospace); font-size: 10px;
  text-transform: uppercase; letter-spacing: .06em; color: var(--wtn-ink-faint, ${TOKENS.inkFaint});
}
.wtn-pr-textarea {
  width: 100%; font-family: var(--wtn-font-mono, monospace); font-size: 11.5px;
  color: var(--wtn-ink, ${TOKENS.ink}); background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line}); border-radius: var(--wtn-radius-sm, 7px);
  padding: 8px 9px; outline: none; resize: vertical; line-height: 1.5;
  min-height: 90px; max-height: 280px; overflow-y: auto;
}
.wtn-pr-textarea:focus { border-color: var(--wtn-accent, ${TOKENS.accent}); }

.wtn-pr-switch {
  width: 30px; height: 17px; border-radius: 999px; flex: 0 0 auto; cursor: pointer;
  background: var(--wtn-console, ${TOKENS.console});
  border: 1px solid var(--wtn-line, ${TOKENS.line});
  position: relative;
}
.wtn-pr-switch-knob {
  position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%;
  background: var(--wtn-ink-faint, ${TOKENS.inkFaint}); transition: left .12s, background .12s;
}
.wtn-pr-switch.wtn-pr-switch-on { border-color: var(--wtn-accent, ${TOKENS.accent}); background: rgba(45,212,191,.16); }
.wtn-pr-switch.wtn-pr-switch-on .wtn-pr-switch-knob { left: 15px; background: var(--wtn-accent, ${TOKENS.accent}); }

.wtn-pr-actions { display: flex; gap: 8px; padding-top: 4px; border-top: 1px solid var(--wtn-line, ${TOKENS.line}); }

/* Highlight color-legend slot (js/shared/highlight/legend.mjs's <details>
   lands here, wired from js/anima_prompt/prompt_rules/highlight_wiring.mjs).
   :empty means "no legend attached" (attach failed / no document) -- the
   flex column's row gap only applies BETWEEN existing children, so a
   display:none slot contributes nothing to layout, and measureMinHeight
   below already skips it via the offsetParent===null check. */
.wtn-pr-legend-slot:empty { display: none; }
.wtn-pr-legend-slot .wtn-hl-legend { font-size: 11px; }
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

/**
 * Build the whole node UI: top bar (PROFILE selector + SHEETS field + BETA
 * chip), POSITIVE pane, NEGATIVE pane (with the `log_trace` switch in its
 * header), action row. Returns a flat `refs` object every other function in
 * this module / `interaction.mjs` / `index.js` reads from — no re-querying
 * by class name at call time (same convention as
 * `anima_prompt_studio/render.mjs`'s `buildRoot`).
 */
export function buildRoot(doc) {
  const d = doc || document;

  const root = d.createElement("div");
  root.className = "wtn-pr-root wtn";

  // ---- Top bar: PROFILE + SHEETS + BETA ----
  const topbar = d.createElement("div");
  topbar.className = "wtn-pr-topbar";

  const profileField = d.createElement("div");
  profileField.className = "wtn-pr-field";
  const profileLabel = d.createElement("span");
  profileLabel.className = "wtn-pr-field-label";
  profileLabel.textContent = "Profile";
  const profileSelect = d.createElement("select");
  profileSelect.className = "wtn-pr-select";
  profileField.appendChild(profileLabel);
  profileField.appendChild(profileSelect);

  const sheetsField = d.createElement("div");
  sheetsField.className = "wtn-pr-field";
  const sheetsLabel = d.createElement("span");
  sheetsLabel.className = "wtn-pr-field-label";
  sheetsLabel.textContent = "Sheets";
  const sheetsInput = d.createElement("input");
  sheetsInput.type = "text";
  sheetsInput.className = "wtn-pr-input";
  sheetsInput.setAttribute("spellcheck", "false");
  sheetsInput.title = '"*" = all sheets, "" = none, or a comma list of sheet names.';
  sheetsField.appendChild(sheetsLabel);
  sheetsField.appendChild(sheetsInput);

  const topbarSpacer = d.createElement("span");
  topbarSpacer.className = "wtn-pr-topbar-spacer";

  const betaChip = d.createElement("span");
  betaChip.className = "wtn-pr-beta";
  betaChip.textContent = "BETA";
  betaChip.title = "Prompt Rules is experimental (EXPERIMENTAL=True).";

  topbar.appendChild(profileField);
  topbar.appendChild(sheetsField);
  topbar.appendChild(topbarSpacer);
  topbar.appendChild(betaChip);

  // ---- POSITIVE pane ----
  const positivePane = d.createElement("div");
  positivePane.className = "wtn-pr-pane";
  const positiveHd = d.createElement("div");
  positiveHd.className = "wtn-pr-pane-hd wtn-pr-pane-positive";
  const positiveDot = d.createElement("span");
  positiveDot.className = "wtn-pr-dot";
  const positiveTitle = d.createElement("span");
  positiveTitle.className = "wtn-pr-pane-title";
  positiveTitle.textContent = "Positive";
  positiveHd.appendChild(positiveDot);
  positiveHd.appendChild(positiveTitle);
  const positiveTextarea = d.createElement("textarea");
  positiveTextarea.className = "wtn-pr-textarea";
  positiveTextarea.setAttribute("spellcheck", "false");
  positiveTextarea.title = "Positive prompt text — mirrors the node's positive widget.";
  positivePane.appendChild(positiveHd);
  positivePane.appendChild(positiveTextarea);

  // ---- NEGATIVE pane (log_trace switch lives in this header row) ----
  const negativePane = d.createElement("div");
  negativePane.className = "wtn-pr-pane";
  const negativeHd = d.createElement("div");
  negativeHd.className = "wtn-pr-pane-hd wtn-pr-pane-negative";
  const negativeDot = d.createElement("span");
  negativeDot.className = "wtn-pr-dot";
  const negativeTitle = d.createElement("span");
  negativeTitle.className = "wtn-pr-pane-title";
  negativeTitle.textContent = "Negative";
  const negativeSpacer = d.createElement("span");
  negativeSpacer.className = "wtn-pr-pane-spacer";
  const traceLabel = d.createElement("span");
  traceLabel.className = "wtn-pr-trace-label";
  traceLabel.textContent = "trace";
  const traceSwitch = d.createElement("div");
  traceSwitch.className = "wtn-pr-switch";
  traceSwitch.setAttribute("role", "switch");
  traceSwitch.setAttribute("tabindex", "0");
  traceSwitch.title = "Toggle log_trace — print the Prompt Rules engine's trace to the console on run.";
  const traceKnob = d.createElement("div");
  traceKnob.className = "wtn-pr-switch-knob";
  traceSwitch.appendChild(traceKnob);
  negativeHd.appendChild(negativeDot);
  negativeHd.appendChild(negativeTitle);
  negativeHd.appendChild(negativeSpacer);
  negativeHd.appendChild(traceLabel);
  negativeHd.appendChild(traceSwitch);
  const negativeTextarea = d.createElement("textarea");
  negativeTextarea.className = "wtn-pr-textarea";
  negativeTextarea.setAttribute("spellcheck", "false");
  negativeTextarea.title = "Negative prompt text — mirrors the node's negative widget.";
  negativePane.appendChild(negativeHd);
  negativePane.appendChild(negativeTextarea);

  // ---- Action row ----
  const actions = d.createElement("div");
  actions.className = "wtn-pr-actions";
  const ruleBuilderBtn = d.createElement("button");
  ruleBuilderBtn.setAttribute("type", "button");
  ruleBuilderBtn.className = "wtn-btn wtn-btn--primary";
  ruleBuilderBtn.textContent = "Open Rule Builder";
  ruleBuilderBtn.title = "Edit this node's embedded ruleset in the Rule Builder overlay.";
  const pickBtn = d.createElement("button");
  pickBtn.setAttribute("type", "button");
  pickBtn.className = "wtn-btn wtn-btn--ghost";
  pickBtn.textContent = "Pick…";
  pickBtn.title = "Insert a character/outfit/background/pose token into positive or negative.";
  actions.appendChild(ruleBuilderBtn);
  actions.appendChild(pickBtn);

  // ---- Highlight legend slot (below the action row) ----
  // Empty at build time -- `highlight_wiring.mjs`'s `attachHighlighting`
  // appends the shared module's `createLegend().root` (a collapsed
  // `<details>`) into this exact container once it's wired, keeping legend
  // placement a `render.mjs` concern while the highlighter itself stays
  // dependency-injected (see `highlight_wiring.mjs`'s doc comment for why).
  const legendSlot = d.createElement("div");
  legendSlot.className = "wtn-pr-legend-slot";

  root.appendChild(topbar);
  root.appendChild(positivePane);
  root.appendChild(negativePane);
  root.appendChild(actions);
  root.appendChild(legendSlot);

  return {
    doc: d,
    root,
    profileSelect,
    sheetsInput,
    positiveTextarea,
    negativeTextarea,
    traceSwitch,
    traceKnob,
    traceLabel,
    ruleBuilderBtn,
    pickBtn,
    legendSlot,
  };
}

/**
 * Rebuild the PROFILE `<select>`'s options from `values` (the combo
 * widget's live `options.values`, per `core.mjs`'s `readProfileValues`) and
 * select `current` — if `current` isn't itself among `values` (an
 * off-list/legacy value in a hand-edited or older workflow), it's appended
 * as an extra option rather than silently discarded, so refreshing the
 * selector never clobbers a real widget value it doesn't yet recognize.
 */
export function setProfileOptions(refs, values, current) {
  const doc = refs.doc || (typeof document !== "undefined" ? document : null);
  const select = refs.profileSelect;
  while (select.firstChild) {
    select.removeChild(select.firstChild);
  }
  const opts = Array.isArray(values) ? values.slice() : [];
  const currentStr = current == null ? "" : String(current);
  if (currentStr && !opts.includes(currentStr)) {
    opts.push(currentStr);
  }
  opts.forEach((value) => {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
  select.value = currentStr || opts[0] || "";
}

/** Reflect `on` into the `log_trace` switch's visual state. */
export function setLogTraceUI(refs, on) {
  refs.traceSwitch.classList.toggle("wtn-pr-switch-on", !!on);
}

// ---------------------------------------------------------------------------
// Per-textarea auto-grow (content-growth only, never resizes the node)
// ---------------------------------------------------------------------------

const TEXTAREA_MIN_H = 90;
const TEXTAREA_MAX_H = 280;

/** Grow (or shrink back down to) `ta`'s own height to fit its content,
 * clamped to `[TEXTAREA_MIN_H, TEXTAREA_MAX_H]` — past the max it scrolls
 * internally (`overflow-y: auto`, set in CSS) instead of growing further.
 * Mirrors `anima_prompt_studio/render.mjs`'s `autoGrowTextarea` exactly (see
 * that module's doc comment for why this synchronous per-element read is
 * safe, unlike the node-level `measureMinHeight`). Never calls
 * `scheduleRefit` — typing must never force a node resize. */
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
// Resize (ComfyUI-Pixaroma find_replace mechanism, matched exactly — see
// anima_prompt_studio/render.mjs's own doc comment for the full two-renderer
// rationale; summarized in this module's top doc comment)
// ---------------------------------------------------------------------------

export const CHROME = 52;
export const DEFAULT_W = 380;
export const DEFAULT_H = 380;

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
  node._prAutoH = h;
}

export function refitNode(node, root) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const cur = node.size[1];
  const autoH = node._prAutoH;
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
    if (node._prConfigured) {
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
