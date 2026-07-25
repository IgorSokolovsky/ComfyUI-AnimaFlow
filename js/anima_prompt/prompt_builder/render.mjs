/**
 * render.mjs — DOM UI for the Prompt Builder node.
 *
 * Builds ONE DOM root (mounted as a single `addDOMWidget`) that presents the
 * whole node UI, styled to match `playground/prompt_builder.html`: a
 * TEMPLATE section (textarea + "＋ Add Wildcard"), a FIELDS section (one
 * row per token), and a LIVE PREVIEW section. No token/state math lives
 * here beyond calling into `core.mjs`; event wiring lives in
 * `interaction.mjs`.
 *
 * Sizing rule (measured, not deterministic — matches ComfyUI-Pixaroma's
 * `find_replace` node exactly, which has to work across BOTH the legacy
 * litegraph canvas renderer and the Nodes 2.0 (Vue/DOM) renderer): DOM
 * measurement before layout has happened returns 0, so height is never
 * computed synchronously. Instead `measureMinHeight` sums the root's
 * *visible* children's `offsetHeight` (never `scrollHeight`) — substituting
 * a fixed `PREVIEW_MIN` floor for the LIVE PREVIEW section instead of its
 * real (flexible) `offsetHeight`, so the node's minimum height never grows
 * to swallow the preview's own flex slack — plus row-gap and vertical
 * padding, and is only ever called from inside a `requestAnimationFrame`
 * callback (`scheduleRefit`/`refitNode`), i.e. after the browser has had a
 * chance to lay the DOM out. `refitNode` GROWS the node when the measured
 * content no longer fits, and only SHRINKS it back down when the user
 * hasn't manually dragged it taller than the last auto-fit height
 * (`node._pbAutoH`) — so a user-enlarged node never gets snapped back. The
 * node's WIDTH is never touched by this mechanism at all; `setNodeHeight`
 * always passes `node.size[0]` straight through. See
 * `measureMinHeight`/`setNodeHeight`/`refitNode`/`scheduleRefit` below, and
 * `index.js`, which wires the DOM widget's `computeLayoutSize` (Nodes 2.0)
 * and `getMinHeight` (legacy) hooks plus the onNodeCreated/onConfigure/
 * structural-change triggers that call `scheduleRefit`.
 */

import { parseTokens, humanize, buildFieldText, ensureState, syncStateWidget } from "./core.mjs";

const STYLE_ID = "webtoon-prompt-builder-css";

// Palette + layout lifted straight from playground/prompt_builder.html so the
// embedded node UI matches the approved visual spec exactly.
const CSS = `
.wpb-root {
  display: flex;
  flex-direction: column;
  gap: 13px;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 2px 2px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #dddddd;
  /* NO height:100% and NO min-height here - deliberate (ComfyUI-Pixaroma's
     find_replace pattern). In Nodes 2.0 the host wrapper gives this root
     flex:1, so it still fills the node body and the preview grows with the
     node; in legacy ComfyUI sizes the widget element. Crucially the root's
     natural flex min-content height (the fixed sections + the preview
     section's own min-height) is what the Nodes 2.0 resize floor
     measurement reads, so the node can't be dragged small enough to
     overflow - no JS needed. A height:100% here would collapse to 0 under
     that measurement and break the floor. */
}
.wpb-root, .wpb-root * { box-sizing: border-box; }
.wpb-section { display: flex; flex-direction: column; }
.wpb-sec-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.wpb-sec-title { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: #8a8f98; font-weight: 700; }
.wpb-sec-title.wpb-green { color: #7fd18f; }
.wpb-sec-note { color: #666666; font-size: 9.5px; }
.wpb-count { color: #f66744; background: rgba(246,103,68,.12); border-radius: 20px; padding: 1px 8px; font-size: 10px; font-weight: 600; margin-left: 6px; }

.wpb-textarea, .wpb-field-input, .wpb-add-name {
  width: 100%;
  background: #1d1d1d;
  color: #cfcfcf;
  border: 1px solid #333333;
  border-radius: 6px;
  padding: 7px 9px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  outline: none;
  transition: border-color .12s;
}
.wpb-textarea:focus, .wpb-field-input:focus, .wpb-add-name:focus { border-color: #f66744; }
.wpb-textarea::placeholder, .wpb-field-input::placeholder, .wpb-add-name::placeholder {
  color: rgba(255,255,255,.32); font-style: italic;
}
.wpb-textarea { min-height: 62px; max-height: 62px; resize: none; line-height: 1.5; }

.wpb-add-wrap { margin-top: 8px; }
.wpb-btn-add {
  background: transparent; border: 1px solid #f66744; color: #f66744;
  padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 6px;
  cursor: pointer; transition: background .12s;
}
.wpb-btn-add:hover { background: rgba(246,103,68,.12); }
.wpb-add-row { display: none; gap: 8px; margin-top: 8px; }
.wpb-add-row.wpb-show { display: flex; }
.wpb-add-name { flex: 1 1 auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wpb-btn-primary {
  background: #f66744; border: 1px solid #f66744; color: #fff; font-weight: 600;
  padding: 6px 12px; font-size: 12px; border-radius: 6px; cursor: pointer;
  transition: filter .12s;
}
.wpb-btn-primary:hover { filter: brightness(1.08); }
.wpb-btn-ghost {
  background: #23262d; border: 1px solid #333333; color: #dddddd;
  padding: 5px 10px; font-size: 11.5px; border-radius: 6px; cursor: pointer;
  transition: border-color .12s;
}
.wpb-btn-ghost:hover { border-color: #f66744; }

.wpb-fields { padding-right: 2px; }
.wpb-fields-empty { color: #8a8f98; font-size: 12px; font-style: italic; padding: 3px 0; }
.wpb-field-row {
  display: grid; grid-template-columns: 108px minmax(0,1fr); gap: 10px;
  align-items: center; margin-bottom: 7px;
}
.wpb-field-row label {
  color: #8a8f98; font-size: 12px; text-align: right; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.wpb-field-input { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

.wpb-section-preview {
  /* This is the FLEX area of .wpb-root: it's the one section allowed to
     grow, so dragging the node taller feeds the extra height straight into
     the preview box below instead of leaving a dead gap. A REAL min-height
     (not 0) is what stops the root collapsing below its content under the
     resize-floor measurement (see measureMinHeight's PREVIEW_MIN). */
  flex: 1 1 0;
  min-height: 100px;
}
.wpb-preview {
  background: #161616; border: 1px solid #2c3a2c; border-radius: 5px;
  padding: 8px 10px; min-height: 60px; overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 1.55; color: #cfcfcf;
  white-space: pre-wrap; word-break: break-word;
  /* flex:1 1 0 fills whatever extra height .wpb-section-preview has
     beyond its head (title + note), so a taller node grows THIS box, not
     the empty space around it - no JS/ResizeObserver needed. */
  flex: 1 1 0;
}
.wpb-preview-empty { color: #8a8f98; font-style: italic; }
`;

/**
 * Inject the Prompt Builder stylesheet once, guarded by `#webtoon-prompt-builder-css`.
 * Safe no-op if there's no `document` (e.g. a headless test harness that
 * doesn't stub one out).
 */
export function injectStyles(doc) {
  const targetDoc = doc || (typeof document !== "undefined" ? document : null);
  if (!targetDoc || typeof targetDoc.createElement !== "function") {
    return;
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

const PREVIEW_EMPTY_TEXT = "Fill in fields to see the prompt…";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the single DOM root for the node: TEMPLATE section (textarea + Add
 * Wildcard control), FIELDS section (empty container, populated by
 * `rebuildFields`), and LIVE PREVIEW section. Returns a flat `refs` object
 * with references to every element `interaction.mjs`/`rebuildFields`/
 * `updatePreview` need — no lookups by class name at call time.
 */
export function buildRoot(doc) {
  const d = doc || document;

  const root = d.createElement("div");
  root.className = "wpb-root";

  // ---- Template section ----
  const templateSection = d.createElement("div");
  templateSection.className = "wpb-section";
  const templateHead = d.createElement("div");
  templateHead.className = "wpb-sec-head";
  const templateTitle = d.createElement("span");
  templateTitle.className = "wpb-sec-title";
  templateTitle.textContent = "Template";
  templateHead.appendChild(templateTitle);

  const templateEl = d.createElement("textarea");
  templateEl.className = "wpb-textarea";
  templateEl.setAttribute("spellcheck", "false");

  const addWrap = d.createElement("div");
  addWrap.className = "wpb-add-wrap";
  const addBtn = d.createElement("button");
  addBtn.setAttribute("type", "button");
  addBtn.className = "wpb-btn-add";
  addBtn.textContent = "＋ Add Wildcard";

  const addRow = d.createElement("div");
  addRow.className = "wpb-add-row";
  const addNameInput = d.createElement("input");
  addNameInput.setAttribute("type", "text");
  addNameInput.className = "wpb-add-name";
  addNameInput.setAttribute("placeholder", "wildcard name  e.g. outfit");
  addNameInput.setAttribute("autocomplete", "off");
  const addConfirmBtn = d.createElement("button");
  addConfirmBtn.setAttribute("type", "button");
  addConfirmBtn.className = "wpb-btn-primary";
  addConfirmBtn.textContent = "Add";
  const addCancelBtn = d.createElement("button");
  addCancelBtn.setAttribute("type", "button");
  addCancelBtn.className = "wpb-btn-ghost";
  addCancelBtn.textContent = "Cancel";
  addRow.appendChild(addNameInput);
  addRow.appendChild(addConfirmBtn);
  addRow.appendChild(addCancelBtn);
  addWrap.appendChild(addBtn);
  addWrap.appendChild(addRow);

  templateSection.appendChild(templateHead);
  templateSection.appendChild(templateEl);
  templateSection.appendChild(addWrap);

  // ---- Fields section ----
  const fieldsSection = d.createElement("div");
  fieldsSection.className = "wpb-section";
  const fieldsHead = d.createElement("div");
  fieldsHead.className = "wpb-sec-head";
  const fieldsTitle = d.createElement("span");
  fieldsTitle.className = "wpb-sec-title";
  fieldsTitle.appendChild(d.createTextNode("Fields"));
  const fieldCountEl = d.createElement("span");
  fieldCountEl.className = "wpb-count";
  fieldCountEl.textContent = "0";
  fieldsTitle.appendChild(fieldCountEl);
  fieldsHead.appendChild(fieldsTitle);

  const fieldsEl = d.createElement("div");
  fieldsEl.className = "wpb-fields";

  fieldsSection.appendChild(fieldsHead);
  fieldsSection.appendChild(fieldsEl);

  // ---- Live preview section ----
  const previewSection = d.createElement("div");
  // `wpb-section-preview`: the STABLE class `measureMinHeight` (below) keys
  // off to substitute `PREVIEW_MIN` for this section's real `offsetHeight`,
  // and the class the CSS above uses to give this section (and only this
  // section) `flex: 1 1 0` — so it's the one part of the node that ABSORBS
  // extra dragged height into the scrollable `.wpb-preview` box below,
  // instead of leaving dead empty space when the node is taller than its
  // content.
  previewSection.className = "wpb-section wpb-section-preview";
  const previewHead = d.createElement("div");
  previewHead.className = "wpb-sec-head";
  const previewTitle = d.createElement("span");
  previewTitle.className = "wpb-sec-title wpb-green";
  previewTitle.textContent = "Live Preview";
  const previewNote = d.createElement("span");
  previewNote.className = "wpb-sec-note";
  previewNote.textContent = "updates as you type";
  previewHead.appendChild(previewTitle);
  previewHead.appendChild(previewNote);

  const previewEl = d.createElement("div");
  previewEl.className = "wpb-preview";

  previewSection.appendChild(previewHead);
  previewSection.appendChild(previewEl);

  root.appendChild(templateSection);
  root.appendChild(fieldsSection);
  root.appendChild(previewSection);

  return {
    doc: d,
    root,
    templateEl,
    addBtn,
    addRow,
    addNameInput,
    addConfirmBtn,
    addCancelBtn,
    fieldsEl,
    fieldCountEl,
    previewEl,
    fieldRows: new Map(),
  };
}

// ---- Measured resize mechanism (ComfyUI-Pixaroma `find_replace` approach) ----
//
// ComfyUI has two renderers that size DOM widgets very differently: the
// LEGACY litegraph canvas renderer (the one the user actually runs — the
// primary, must-work-standalone path here) and the newer Nodes 2.0
// (Vue/DOM) renderer. Measuring the DOM synchronously (e.g. at widget
// construction time, or via `scrollHeight`) returns 0 before the browser has
// laid the element out, which is what caused the node to snap tiny. The fix:
// only ever measure inside a `requestAnimationFrame` callback (after
// layout), and drive the legacy renderer's own resize path — `addDOMWidget`'s
// `getMinHeight` option + `node.setSize` — directly rather than relying on
// Nodes 2.0-only hooks.
//
// `CHROME` accounts for the node title bar / frame / output-row overhead
// above the DOM widget itself that `measureMinHeight` (which only sees
// `.wpb-root`'s children) can't see; `DEFAULT_W`/`DEFAULT_H` are sane floors
// for a freshly-created node.
export const CHROME = 60;
export const DEFAULT_W = 320;
export const DEFAULT_H = 200;

// Minimum LIVE PREVIEW block height (head + a couple lines of body). The
// preview section flexes to fill any extra node height beyond this floor
// (see `.wpb-section-preview`'s `flex: 1 1 0` above).
export const PREVIEW_MIN = 100;

function getComputedStyleSafe(el) {
  if (!el) {
    return null;
  }
  if (typeof getComputedStyle === "function") {
    try {
      return getComputedStyle(el);
    } catch (err) {
      // fall through to the ownerDocument lookup below
    }
  }
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (view && typeof view.getComputedStyle === "function") {
    return view.getComputedStyle(el);
  }
  return null;
}

/**
 * The node's minimum height = the FIXED sections (template + fields,
 * measured live) + a minimum preview block, NOT the full (flexible) preview
 * — so the user can drag the node taller and the preview fills the new
 * space instead of leaving a dead gap below it (bug #2), while a value that
 * accounted for the preview's REAL height would under-report the floor and
 * let the node be dragged short enough to clip the preview (bug #1).
 *
 * Sums `root`'s *visible* direct children's `offsetHeight` (never
 * `scrollHeight` — that reflects the element's own current size, not what
 * it takes to fit its content, and behaves inconsistently before layout),
 * substituting `PREVIEW_MIN` for the `.wpb-section-preview` child instead of
 * its real `offsetHeight` (so a huge/empty preview can never feed back into
 * the floor and grow it — no feedback loop), plus the flex row-gap between
 * children and the root's own vertical padding. Children hidden via
 * `display: none` (`offsetParent === null`) don't count. Only meaningful
 * when called after layout has happened — i.e. from inside a
 * `requestAnimationFrame` callback (see `scheduleRefit` below); called any
 * earlier it will under-report (0 for an unlaid-out DOM). Rounded to a 4px
 * grid so sub-pixel/font jitter can't creep `node.size` bigger on every
 * workflow switch (`getMinHeight`/`computeLayoutSize` feed grow-to-content,
 * which is grow-only and accumulates).
 */
export function measureMinHeight(root) {
  if (!root || !root.children) {
    return 180;
  }
  let h = 0;
  let count = 0;
  for (const child of root.children) {
    if (child.offsetParent === null) {
      continue;
    }
    count += 1;
    if (child.classList && child.classList.contains("wpb-section-preview")) {
      h += PREVIEW_MIN;
    } else {
      h += typeof child.offsetHeight === "number" ? child.offsetHeight : 0;
    }
  }
  const cs = getComputedStyleSafe(root);
  const gap = cs ? parseFloat(cs.rowGap || cs.gap) || 0 : 0;
  if (count > 1) {
    h += gap * (count - 1);
  }
  const padTop = cs ? parseFloat(cs.paddingTop) || 0 : 0;
  const padBottom = cs ? parseFloat(cs.paddingBottom) || 0 : 0;
  h += padTop + padBottom;
  return Math.max(180, Math.round(h / 4) * 4);
}

/**
 * Set the node's height to exactly `h`, preserving its current WIDTH
 * (`node.size[0]`) unconditionally — this function never touches width.
 * Records `h` on `node._pbAutoH` so `refitNode` can tell later whether the
 * user has since dragged the node taller than the last auto-fit height.
 */
export function setNodeHeight(node, h) {
  if (!node.size) {
    node.size = [DEFAULT_W, h];
  }
  node.size[1] = h;
  if (typeof node.setSize === "function") {
    // Passing `node.size[0]` straight through is what makes this safe: it
    // never asks `setSize` to touch width at all, only height, so the
    // node's current width always round-trips unchanged.
    node.setSize([node.size[0], h]);
  }
  node._pbAutoH = h;
}

/**
 * Recompute the node's desired height from `root`'s measured content and
 * resize if needed. GROWS whenever the content no longer fits (`want >
 * cur`). Only SHRINKS back down to fit when the user hasn't manually
 * dragged the node taller than the last auto-fit height recorded in
 * `node._pbAutoH` (`userEnlarged`) — so a user-enlarged node is never
 * snapped back by a later, smaller measurement. Must be called from inside
 * a `requestAnimationFrame` callback (see `scheduleRefit`) so `root`'s
 * children have real, laid-out `offsetHeight` values.
 */
export function refitNode(node, root) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const cur =
    node.size && typeof node.size[1] === "number" ? node.size[1] : DEFAULT_H;
  const autoH = node._pbAutoH;
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

/**
 * Schedule a `refitNode` pass for the next animation frame (i.e. after the
 * browser has laid the DOM out) and mark the node dirty afterwards so
 * litegraph repaints at the new size. Call this after ANY DOM change that
 * was caused by an explicit, intentional user action: a structural FIELDS
 * add/remove (see `rebuildFields` below). UNCONDITIONAL — never gated by
 * `node._pbConfigured` — because these happen long after load and are
 * always meant to grow/shrink the node. For the very first build's fit (the
 * one call that could otherwise race a workflow's restored `node.size`), use
 * `scheduleInitialFit` instead.
 */
export function scheduleRefit(node, root) {
  if (!root) {
    return;
  }
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  if (typeof raf !== "function") {
    // No rAF available (shouldn't happen inside a real browser host) — fit
    // immediately rather than silently doing nothing.
    refitNode(node, root);
    if (typeof node.setDirtyCanvas === "function") {
      node.setDirtyCanvas(true, true);
    }
    return;
  }
  raf(() => {
    refitNode(node, root);
    if (typeof node.setDirtyCanvas === "function") {
      node.setDirtyCanvas(true, true);
    }
  });
}

/**
 * Schedule the node's INITIAL auto-fit (the very first `rebuildFields`
 * call only) for the next animation frame, GUARDED by `node._pbConfigured`.
 *
 * `index.js`'s `onConfigure` wrap sets `node._pbConfigured = true` as the
 * very first thing it does, synchronously — and for a node being loaded
 * from a saved workflow, `onNodeCreated` (which schedules this initial fit)
 * always runs BEFORE `onConfigure`, but this callback only actually FIRES
 * later, on the next animation frame, by which point `onConfigure` has
 * already run and litegraph has already restored the saved `node.size`. So
 * checking the flag here — at fire time, not at schedule time — is what
 * lets a loaded node keep its restored size: the callback sees the flag is
 * already `true` and does nothing, instead of clobbering `node.size` with a
 * measured-from-content fit. A genuinely fresh node (no `onConfigure` at
 * all, e.g. a plain drag-and-drop placement) never has the flag set, so
 * this DOES fit it to its initial content, same as before.
 *
 * Only ever call this for the very first build. Every later structural
 * change (a FIELDS add/remove after the node already exists) must go
 * through the unconditional `scheduleRefit` above instead — those are
 * deliberate, user-driven growth and must not be suppressed just because
 * the node was originally loaded from a workflow.
 */
export function scheduleInitialFit(node, root) {
  if (!root) {
    return;
  }
  const run = () => {
    if (node._pbConfigured) {
      // Loaded from a saved workflow — onConfigure already restored
      // node.size; trust it, don't grow/shrink to content.
      return;
    }
    refitNode(node, root);
    if (typeof node.setDirtyCanvas === "function") {
      node.setDirtyCanvas(true, true);
    }
  };
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  if (typeof raf !== "function") {
    run();
    return;
  }
  raf(run);
}

/**
 * Reconcile the FIELDS section against the current template text (read
 * from `refs.templateEl.value`):
 *   - Add a row for every new token (seeding its value from
 *     `properties.promptBuilderState.fields[token]`, or "").
 *   - Remove rows for tokens no longer present (the cached value in
 *     `state.fields` is left untouched so re-adding the token later
 *     restores it).
 *   - Reorder rows into first-appearance order.
 * All FIELDS rows are shown at once now (no internal scroll — see
 * `.wpb-fields` CSS). The very first call for this `refs` schedules the
 * GUARDED initial fit (`scheduleInitialFit`, see above — a no-op for a node
 * being loaded from a workflow, so it never clobbers the just-restored
 * `node.size`); a LATER structural change (a token added/removed) schedules
 * the unconditional `scheduleRefit` instead, since that's always a
 * deliberate user action. Neither ever resizes synchronously, and neither
 * ever derives height from a deterministic token-count formula. A field
 * VALUE edit or a template edit that doesn't change the token set never
 * schedules anything. Always ends by re-rendering the preview.
 *
 * `opts.silent` (used ONLY by `index.js`'s `onConfigure` restore path)
 * suppresses BOTH triggers entirely — the restore path rebuilds rows to
 * match the just-restored template/state but must never resize the node
 * itself (Vue Compat #18 / false-dirty-on-load guard); by the time it runs,
 * `refs._rebuiltOnce` is already `true` (set by `onNodeCreated`'s earlier
 * call), so only the structural-change branch could otherwise fire.
 */
export function rebuildFields(node, refs, opts) {
  const state = ensureState(node);
  const tokens = parseTokens(refs.templateEl.value);
  const tokenSet = new Set(tokens);
  const isFirstBuild = !refs._rebuiltOnce;
  refs._rebuiltOnce = true;
  let structuralChange = false;

  // Drop rows for tokens no longer in the template. Cached values stay in
  // state.fields untouched.
  for (const [token, entry] of Array.from(refs.fieldRows.entries())) {
    if (!tokenSet.has(token)) {
      if (entry.row.parentNode && typeof entry.row.parentNode.removeChild === "function") {
        entry.row.parentNode.removeChild(entry.row);
      }
      refs.fieldRows.delete(token);
      structuralChange = true;
    }
  }

  // Seed state + create rows for newly-added tokens.
  tokens.forEach((token) => {
    if (!(token in state.fields)) {
      state.fields[token] = "";
    }
    if (!refs.fieldRows.has(token)) {
      const row = refs.doc.createElement("div");
      row.className = "wpb-field-row";
      const label = refs.doc.createElement("label");
      label.textContent = humanize(token);
      label.title = "{" + token + "}";
      const input = refs.doc.createElement("input");
      input.setAttribute("type", "text");
      input.className = "wpb-field-input";
      input.value = state.fields[token] || "";
      input.setAttribute("placeholder", "…");
      input.addEventListener("input", () => {
        // Field edit: write value + sync the (hidden, serialized)
        // prompt_builder_state widget + refresh preview ONLY. Never rebuild
        // rows or resize the node.
        state.fields[token] = input.value;
        syncStateWidget(node);
        updatePreview(node, refs);
      });
      row.appendChild(label);
      row.appendChild(input);
      refs.fieldRows.set(token, { row, label, input });
      structuralChange = true;
    }
  });

  // Sync every row's displayed value from state.fields. This is what makes
  // restore-on-load correct: `onNodeCreated` builds rows (seeded "") before
  // `onConfigure` has restored `properties.promptBuilderState` from the
  // saved workflow, so an existing row's on-screen value can be stale
  // relative to state at the point `rebuildFields` is (re)run. Harmless
  // no-op for untouched tokens mid-typing (their input already equals
  // state.fields[token]).
  tokens.forEach((token) => {
    const entry = refs.fieldRows.get(token);
    const value = state.fields[token] || "";
    if (entry.input.value !== value) {
      entry.input.value = value;
    }
  });

  // Clear + re-append in first-appearance order (cheap; no field input is
  // focused while the template textarea is being edited, so this never
  // steals focus from the user).
  while (refs.fieldsEl.firstChild) {
    refs.fieldsEl.removeChild(refs.fieldsEl.firstChild);
  }

  if (!tokens.length) {
    const empty = refs.doc.createElement("div");
    empty.className = "wpb-fields-empty";
    empty.textContent = "No {wildcards} in the template yet.";
    refs.fieldsEl.appendChild(empty);
  }
  tokens.forEach((token) => {
    refs.fieldsEl.appendChild(refs.fieldRows.get(token).row);
  });

  refs.fieldCountEl.textContent = String(tokens.length);
  refs.tokenCount = tokens.length;

  // Any add/remove wildcard (structural token change) or template edit that
  // reseeds a field's default ("") in `state.fields` above is a mutation of
  // `promptBuilderState` — sync it to the (hidden, serialized)
  // prompt_builder_state widget unconditionally, even on a non-structural
  // rebuild (harmless no-op re-write when nothing actually changed).
  syncStateWidget(node);

  updatePreview(node, refs);

  if (!(opts && opts.silent)) {
    if (isFirstBuild) {
      scheduleInitialFit(node, refs.root);
    } else if (structuralChange) {
      scheduleRefit(node, refs.root);
    }
  }
}

/**
 * Re-render the LIVE PREVIEW body from the current template text and
 * `properties.promptBuilderState.fields`: the labeled-prose text (one
 * `"<Label>: <value>"` line per non-empty field) that `buildFieldText`
 * produces — mirroring the backend's primary output (`build_field_text`) —
 * or the italic muted placeholder when every field is still empty
 * (`buildFieldText` returns `""` in that case).
 */
export function updatePreview(node, refs) {
  const state = ensureState(node);
  const tokens = parseTokens(refs.templateEl.value);
  const rendered = buildFieldText(tokens, state.fields);
  if (rendered === "") {
    refs.previewEl.innerHTML =
      '<span class="wpb-preview-empty">' + escapeHtml(PREVIEW_EMPTY_TEXT) + "</span>";
  } else {
    refs.previewEl.innerHTML = escapeHtml(rendered);
  }
  // Plain-text mirror (a plain expando property, not `.dataset` — which has
  // no setter on a real DOM element) for anything that reads rendered text
  // directly (e.g. tests) without parsing the (escaped) HTML.
  refs.previewEl.wpbRenderedText = rendered;
}
