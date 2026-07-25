/**
 * render.mjs — DOM UI for the Prompt Combiner node.
 *
 * Builds ONE DOM root (mounted as a single `addDOMWidget`) that presents the
 * whole node UI, styled to match `js/prompt_builder/render.mjs`'s aesthetic:
 * a TEMPLATE section (textarea + "＋ Add Input"), an INPUTS section (one row
 * per real input slot, with a connection-status dot + remove button), and a
 * LIVE PREVIEW section. No token/state math beyond calling into `core.mjs`;
 * event wiring lives in `interaction.mjs`; litegraph slot mutation
 * (`addInput`/`removeInput`) lives in `index.js`/`interaction.mjs`.
 *
 * Unlike Prompt Builder, this node cannot compute its combined output in the
 * browser: input values arrive over connection wires only at execution time.
 * So the LIVE PREVIEW section shows the REAL result returned by the
 * backend's `onExecuted` (`{"ui": {"text": [structured_str]}}`) — the
 * node's primary output is labeled PROSE, one `"<Label>: <value>"` line per
 * non-empty variable (see `nodes/node_prompt_combiner.py`'s `combine`/
 * `build_field_text` — a JSON `{token: value}` document was tried first but
 * proved noisy for a Qwen-style text encoder), so that's exactly what
 * `message.text` already carries; `renderLivePreview` below just
 * escapes+displays it verbatim (no re-formatting needed). Not a structural
 * render of the template. There is deliberately no chip/token rendering
 * here any more.
 *
 * Sizing rule (ComfyUI-Pixaroma find_replace mechanism, matched EXACTLY —
 * see `measureMinHeight`/`refitNode`/`scheduleRefit` below): the DOM widget
 * reports its floor through the legacy `getMinHeight` option (NOT
 * `computeSize`/`getHeight` — those fight `node.setSize` under the legacy
 * canvas renderer) and the Nodes 2.0 `computeLayoutSize` hook, and the node
 * is refit to its DOM content ONLY from inside a `requestAnimationFrame`
 * callback (post-layout, so real `offsetHeight`s are settled under BOTH
 * ComfyUI's legacy canvas renderer and its Nodes 2.0 Vue/DOM renderer), and
 * ONLY on explicit structural triggers wired in `index.js`/`interaction.mjs`
 * (first build, an INPUTS add/remove, `onConfigure` restore, a changed
 * `onExecuted` LIVE PREVIEW) — never synchronously from a plain typing/
 * connection-status event. The node's WIDTH is never touched by this
 * mechanism at all (`setNodeHeight` only ever writes `size[1]`). The LIVE
 * PREVIEW section is the one flexible child (`.wpc-section-preview`): the
 * height floor only ever counts a small `PREVIEW_MIN` toward it (never its
 * real, possibly huge, `offsetHeight` — that would create a feedback loop),
 * so it clips at nothing and instead grows to fill whatever room the node
 * actually has. Mirrors `js/prompt_builder/render.mjs` and
 * `ComfyUI-Pixaroma/js/find_replace/render.mjs`.
 */

import { humanize, getInputNames } from "./core.mjs";

const STYLE_ID = "webtoon-prompt-combiner-css";

// Palette + section layout lifted from js/prompt_builder/render.mjs so the
// two nodes read as one family.
const CSS = `
.wpc-root {
  display: flex;
  flex-direction: column;
  gap: 13px;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 2px 2px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #dddddd;
  /* NO height:100% and NO min-height here - deliberate (the
     ComfyUI-Pixaroma find_replace pattern). In Nodes 2.0 the host wrapper
     gives this root flex:1, so it still fills the node body and the
     preview grows with the node; in legacy ComfyUI sizes the widget
     element. Crucially the root's natural flex min-content height (the
     fixed sections + the preview's PREVIEW_MIN floor) is what
     measureMinHeight measures, so the node can't be dragged small enough
     to clip the bottom - no ResizeObserver/min-height machinery needed. A
     height:100% here would collapse to 0 under that measurement and break
     the floor. */
}
.wpc-root, .wpc-root * { box-sizing: border-box; }
.wpc-section { display: flex; flex-direction: column; }
/* Only LIVE PREVIEW stretches to absorb extra vertical space the DOM
   widget has beyond its natural content height; TEMPLATE and INPUTS keep
   their natural, content-driven heights. A REAL min-height (not 0): this is
   the flex area, so its min-height is what stops the section collapsing
   below a usable size under the resize floor measurement below. It still
   grows to fill extra node height. */
.wpc-section-preview { flex: 1 1 0; min-height: 100px; display: flex; flex-direction: column; }
.wpc-sec-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.wpc-sec-title { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: #8a8f98; font-weight: 700; }
.wpc-sec-title.wpc-green { color: #7fd18f; }
.wpc-sec-note { color: #666666; font-size: 9.5px; }
.wpc-count { color: #f66744; background: rgba(246,103,68,.12); border-radius: 20px; padding: 1px 8px; font-size: 10px; font-weight: 600; margin-left: 6px; }

.wpc-textarea, .wpc-add-name {
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
.wpc-textarea:focus, .wpc-add-name:focus { border-color: #f66744; }
.wpc-textarea::placeholder, .wpc-add-name::placeholder {
  color: rgba(255,255,255,.32); font-style: italic;
}
.wpc-textarea { min-height: 52px; max-height: 52px; resize: none; line-height: 1.5; }

.wpc-add-wrap { margin-top: 8px; }
.wpc-btn-add {
  background: transparent; border: 1px solid #f66744; color: #f66744;
  padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 6px;
  cursor: pointer; transition: background .12s;
}
.wpc-btn-add:hover { background: rgba(246,103,68,.12); }
.wpc-add-row { display: none; gap: 8px; margin-top: 8px; }
.wpc-add-row.wpc-show { display: flex; }
.wpc-add-name { flex: 1 1 auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wpc-btn-primary {
  background: #f66744; border: 1px solid #f66744; color: #fff; font-weight: 600;
  padding: 6px 12px; font-size: 12px; border-radius: 6px; cursor: pointer;
  transition: filter .12s;
}
.wpc-btn-primary:hover { filter: brightness(1.08); }
.wpc-btn-ghost {
  background: #23262d; border: 1px solid #333333; color: #dddddd;
  padding: 5px 10px; font-size: 11.5px; border-radius: 6px; cursor: pointer;
  transition: border-color .12s;
}
.wpc-btn-ghost:hover { border-color: #f66744; }

.wpc-inputs { padding-right: 2px; }
.wpc-inputs-empty { color: #8a8f98; font-size: 12px; font-style: italic; padding: 3px 0; }
.wpc-input-row {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 7px;
}
.wpc-dot {
  width: 8px; height: 8px; min-width: 8px; border-radius: 50%;
  background: #666666; display: inline-block;
}
.wpc-dot-on { background: #7fd18f; }
.wpc-input-name {
  flex: 1 1 auto; color: #cfcfcf; font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wpc-input-token {
  color: #666666; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px; margin-left: 6px;
}
.wpc-btn-remove {
  background: transparent; border: 1px solid #333333; color: #8a8f98;
  width: 20px; height: 20px; line-height: 1; border-radius: 5px; cursor: pointer;
  font-size: 11px; padding: 0; transition: border-color .12s, color .12s;
}
.wpc-btn-remove:hover { border-color: #f66744; color: #f66744; }

.wpc-preview {
  background: #161616; border: 1px solid #2c3a2c; border-radius: 5px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 1.7; color: #cfcfcf;
  white-space: pre-wrap; word-break: break-word;
  flex: 1 1 0;
  min-height: 60px;
  overflow-y: auto;
}
.wpc-preview-empty { color: #8a8f98; font-style: italic; }
`;

/**
 * Inject the Prompt Combiner stylesheet once, guarded by
 * `#webtoon-prompt-combiner-css`. Safe no-op if there's no `document` (e.g.
 * a headless test harness that doesn't stub one out).
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

const PREVIEW_EMPTY_TEXT = "Run to preview the combined prompt";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the single DOM root for the node: TEMPLATE section (textarea + Add
 * Input control), INPUTS section (empty container, populated by
 * `rebuildInputsList`), and LIVE PREVIEW section. Returns a flat `refs`
 * object with references to every element `interaction.mjs`/
 * `rebuildInputsList`/`renderLivePreview` need — no lookups by class name at
 * call time.
 */
export function buildRoot(doc) {
  const d = doc || document;

  const root = d.createElement("div");
  root.className = "wpc-root";

  // ---- Template section ----
  const templateSection = d.createElement("div");
  templateSection.className = "wpc-section";
  const templateHead = d.createElement("div");
  templateHead.className = "wpc-sec-head";
  const templateTitle = d.createElement("span");
  templateTitle.className = "wpc-sec-title";
  templateTitle.textContent = "Template";
  templateHead.appendChild(templateTitle);

  const templateEl = d.createElement("textarea");
  templateEl.className = "wpc-textarea";
  templateEl.setAttribute("spellcheck", "false");

  templateSection.appendChild(templateHead);
  templateSection.appendChild(templateEl);

  // ---- Inputs section (rows, then the "＋ Add Input" control below them —
  // matches playground/prompt_combiner.html's layout) ----
  const inputsSection = d.createElement("div");
  inputsSection.className = "wpc-section";
  const inputsHead = d.createElement("div");
  inputsHead.className = "wpc-sec-head";
  const inputsTitle = d.createElement("span");
  inputsTitle.className = "wpc-sec-title";
  inputsTitle.appendChild(d.createTextNode("Inputs"));
  const inputCountEl = d.createElement("span");
  inputCountEl.className = "wpc-count";
  inputCountEl.textContent = "0";
  inputsTitle.appendChild(inputCountEl);
  inputsHead.appendChild(inputsTitle);

  const inputsEl = d.createElement("div");
  inputsEl.className = "wpc-inputs";

  const addWrap = d.createElement("div");
  addWrap.className = "wpc-add-wrap";
  const addBtn = d.createElement("button");
  addBtn.setAttribute("type", "button");
  addBtn.className = "wpc-btn-add";
  addBtn.textContent = "＋ Add Input";

  const addRow = d.createElement("div");
  addRow.className = "wpc-add-row";
  const addNameInput = d.createElement("input");
  addNameInput.setAttribute("type", "text");
  addNameInput.className = "wpc-add-name";
  addNameInput.setAttribute("placeholder", "input name  e.g. character");
  addNameInput.setAttribute("autocomplete", "off");
  const addConfirmBtn = d.createElement("button");
  addConfirmBtn.setAttribute("type", "button");
  addConfirmBtn.className = "wpc-btn-primary";
  addConfirmBtn.textContent = "Add";
  const addCancelBtn = d.createElement("button");
  addCancelBtn.setAttribute("type", "button");
  addCancelBtn.className = "wpc-btn-ghost";
  addCancelBtn.textContent = "Cancel";
  addRow.appendChild(addNameInput);
  addRow.appendChild(addConfirmBtn);
  addRow.appendChild(addCancelBtn);
  addWrap.appendChild(addBtn);
  addWrap.appendChild(addRow);

  inputsSection.appendChild(inputsHead);
  inputsSection.appendChild(inputsEl);
  inputsSection.appendChild(addWrap);

  // ---- Live preview section ----
  const previewSection = d.createElement("div");
  previewSection.className = "wpc-section wpc-section-preview";
  const previewHead = d.createElement("div");
  previewHead.className = "wpc-sec-head";
  const previewTitle = d.createElement("span");
  previewTitle.className = "wpc-sec-title wpc-green";
  previewTitle.textContent = "Live Preview";
  const previewNote = d.createElement("span");
  previewNote.className = "wpc-sec-note";
  previewNote.textContent = "last run";
  previewHead.appendChild(previewTitle);
  previewHead.appendChild(previewNote);

  const previewEl = d.createElement("div");
  previewEl.className = "wpc-preview";

  previewSection.appendChild(previewHead);
  previewSection.appendChild(previewEl);

  root.appendChild(templateSection);
  root.appendChild(inputsSection);
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
    inputsEl,
    inputCountEl,
    previewEl,
    inputRows: new Map(),
  };
}

// ---- ComfyUI-Pixaroma (find_replace) resize mechanism, matched exactly ----
//
// ComfyUI has TWO renderers that size a DOM widget differently: the legacy
// canvas renderer (drives sizing off the widget's `getMinHeight` option,
// which is the PRIMARY path this build targets — the user runs the legacy
// renderer) and the Nodes 2.0 Vue/DOM renderer (drives sizing off
// `widget.computeLayoutSize`, kept only for forward compatibility). Real
// `offsetHeight`s are only settled AFTER layout under both, so
// `measureMinHeight` must only ever be called from inside a
// `requestAnimationFrame` callback (`scheduleRefit`) — never synchronously
// from an event handler, or it reads stale/zero heights.

// Node chrome (title bar etc.) the DOM widget's own content height doesn't
// account for. Tuned to this node's `.wpc-root` padding + section spacing.
export const CHROME = 60;
export const DEFAULT_W = 320;
export const DEFAULT_H = 200;

// Minimum LIVE PREVIEW block height (head + a couple lines of body). The
// preview flexes to fill any extra node height beyond this floor — see
// `measureMinHeight` below, which substitutes this constant for the
// preview section's real (open-ended) `offsetHeight` so a long combined
// result can never inflate the node's own minimum-height floor (which would
// create a resize feedback loop).
const PREVIEW_MIN = 100;

/**
 * The node's minimum height = the FIXED sections (template + inputs,
 * measured live) + a minimum preview block. NOT the full preview, so the
 * user can drag the node taller and the preview fills the new space (no
 * dead gap) — and so a long LIVE PREVIEW result can never clip the node's
 * bottom (the old bug this replaces: the floor used to sum every child's
 * REAL `offsetHeight`, including the preview's, so a tall preview would
 * itself raise the floor it was supposed to be measured against).
 *
 * Sums `root`'s visible direct children's `offsetHeight` (skipping any
 * whose `offsetParent` is `null` — hidden/detached from layout), except the
 * `.wpc-section-preview` child, which contributes `PREVIEW_MIN` instead of
 * its own `offsetHeight`. Adds the flex `gap` between them and the root's
 * own top+bottom padding (read live via `getComputedStyle`, matching
 * `.wpc-root`'s actual CSS rather than a hardcoded constant). Returns `180`
 * for a missing `root`. Rounds to a 4px grid so sub-pixel/font jitter can't
 * creep `node.size` bigger on every workflow switch. MUST only be called
 * post-layout (from inside a `requestAnimationFrame` callback — see
 * `scheduleRefit`) so `offsetHeight`/`getComputedStyle` report real, settled
 * values under both ComfyUI renderers.
 */
export function measureMinHeight(root) {
  if (!root) {
    return 180;
  }
  let h = 0;
  let count = 0;
  for (const child of root.children) {
    if (child.offsetParent === null) {
      continue;
    }
    count += 1;
    if (child.classList.contains("wpc-section-preview")) {
      h += PREVIEW_MIN;
    } else {
      h += child.offsetHeight;
    }
  }
  const cs = getComputedStyle(root);
  const gap = parseFloat(cs.rowGap || cs.gap) || 0;
  if (count > 1) {
    h += gap * (count - 1);
  }
  h += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  return Math.max(180, Math.round(h / 4) * 4);
}

/**
 * Set `node`'s HEIGHT only — width is always whatever `node.size[0]`
 * currently is, read straight through, never recomputed here. Records the
 * height this settled on as `node._pcAutoH` so a later `refitNode` can tell
 * an auto-fit height apart from a height the user manually dragged past it.
 */
export function setNodeHeight(node, h) {
  node.size[1] = h;
  if (typeof node.setSize === "function") {
    node.setSize([node.size[0], h]);
  }
  node._pcAutoH = h;
}

/**
 * Resize `node` to fit `root`'s real (measured) content height, growing OR
 * shrinking as needed — UNLESS the user has manually dragged the node taller
 * than the last auto-fit height (`node._pcAutoH`), in which case a shrink is
 * suppressed (a grow past that still applies, so content that outgrows even
 * an enlarged node still gets room). No-op if `root` is missing.
 */
export function refitNode(node, root) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const cur = node.size[1];
  const autoH = node._pcAutoH;
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
 * Defer a `refitNode` call to the next `requestAnimationFrame` (post-layout,
 * so `measureMinHeight` reads real settled `offsetHeight`s), then flag
 * the node dirty so LiteGraph redraws at the new size. UNCONDITIONAL —
 * never gated by `node._pcConfigured` — call this only from an explicit,
 * intentional structural trigger that happens well after load (an INPUTS
 * add/remove, a changed `onExecuted` LIVE PREVIEW): those are deliberate
 * growth and must never be suppressed just because the node was originally
 * loaded from a workflow. For the node's very first (mount-time) fit — the
 * one call that could otherwise race a workflow's restored `node.size` — use
 * `scheduleInitialFit` instead.
 */
export function scheduleRefit(node, root) {
  requestAnimationFrame(() => {
    refitNode(node, root);
    if (node.setDirtyCanvas) {
      node.setDirtyCanvas(true, true);
    }
  });
}

/**
 * Schedule the node's INITIAL auto-fit (the one `setupNode`/`onNodeCreated`
 * calls at mount) for the next animation frame, GUARDED by
 * `node._pcConfigured`.
 *
 * `index.js`'s `onConfigure` wrap sets `node._pcConfigured = true` as the
 * very first thing it does, synchronously — and for a node being loaded
 * from a saved workflow, `onNodeCreated` (which schedules this initial fit)
 * always runs BEFORE `onConfigure`, but this callback only actually FIRES
 * later, on the next animation frame, by which point `onConfigure` has
 * already run and litegraph has already restored the saved `node.size`. So
 * checking the flag here — at fire time, not at schedule time — is what
 * lets a loaded node keep its restored size: the callback sees the flag is
 * already `true` and does nothing, instead of clobbering `node.size` with a
 * measured-from-content fit. A genuinely fresh node (no `onConfigure` at
 * all) never has the flag set, so this DOES fit it to its initial content,
 * same as before.
 */
export function scheduleInitialFit(node, root) {
  requestAnimationFrame(() => {
    if (node._pcConfigured) {
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

/**
 * Re-render the LIVE PREVIEW body: `text` is the REAL result (the
 * labeled-prose `"<Label>: <value>"` block) returned by the backend's
 * `onExecuted` (`message.text.join("")`, wired in `index.js`), stored on the
 * node as `node._promptCombinerLastResult` so it
 * survives redraws/re-mounts within the session. Before the node has ever
 * run (`text` is not a string — i.e. `undefined`), shows an italic muted
 * placeholder instead. Never resizes the node.
 */
export function renderLivePreview(refs, text) {
  if (typeof text !== "string") {
    refs.previewEl.innerHTML =
      '<span class="wpc-preview-empty">' + escapeHtml(PREVIEW_EMPTY_TEXT) + "</span>";
    refs.previewEl.wpcRenderedText = undefined;
    return;
  }
  refs.previewEl.innerHTML = escapeHtml(text);
  refs.previewEl.wpcRenderedText = text;
}

/**
 * Update only the connection-status dot for each existing INPUTS row (green
 * `wpc-dot-on` if connected, muted otherwise) from the live `node.inputs`,
 * then re-apply the current LIVE PREVIEW (the last executed result, or the
 * placeholder). Used for non-structural updates (a link connects/
 * disconnects) — never adds/removes rows, never resizes.
 */
export function updateConnectionStatuses(node, refs) {
  const inputs = (node && node.inputs) || [];
  inputs.forEach((input) => {
    if (!input || !input.name) {
      return;
    }
    const entry = refs.inputRows.get(input.name);
    if (!entry) {
      return;
    }
    const connected = input.link !== null && input.link !== undefined;
    entry.dot.classList.toggle("wpc-dot-on", connected);
  });
  renderLivePreview(refs, node && node._promptCombinerLastResult);
}

/**
 * Reconcile the INPUTS section against the live `node.inputs` (the source
 * of truth for the variable list, itself driven by the TEMPLATE — see
 * `interaction.mjs`'s `reconcileInputsFromTemplate`):
 *   - Add a row for every input slot not yet shown.
 *   - Remove rows for slots no longer present.
 *   - Reorder rows to match `node.inputs` order.
 * Never resizes the node itself — that's the caller's job (`scheduleRefit`,
 * wired at each structural-change/first-build/restore/onExecuted trigger in
 * `index.js`/`interaction.mjs`), so this function stays a pure DOM-rows sync
 * and can be called as often as needed (e.g. from `reconcileInputsFromTemplate`
 * even when nothing structural changed) without side effects on sizing.
 * Always ends by re-applying the current LIVE PREVIEW (the last executed
 * result, or the placeholder — never a structural render). `onRemove(name)`
 * is called when a row's remove (✕) button is clicked, with the input's
 * name.
 */
export function rebuildInputsList(node, refs, onRemove) {
  const names = getInputNames(node);
  const nameSet = new Set(names);

  // Drop rows for slots no longer present.
  for (const [name, entry] of Array.from(refs.inputRows.entries())) {
    if (!nameSet.has(name)) {
      if (entry.row.parentNode && typeof entry.row.parentNode.removeChild === "function") {
        entry.row.parentNode.removeChild(entry.row);
      }
      refs.inputRows.delete(name);
    }
  }

  // Create rows for newly-added slots.
  names.forEach((name) => {
    if (!refs.inputRows.has(name)) {
      const row = refs.doc.createElement("div");
      row.className = "wpc-input-row";

      const dot = refs.doc.createElement("span");
      dot.className = "wpc-dot";

      const label = refs.doc.createElement("span");
      label.className = "wpc-input-name";
      label.textContent = humanize(name);
      label.title = "{" + name + "}";

      const removeBtn = refs.doc.createElement("button");
      removeBtn.setAttribute("type", "button");
      removeBtn.className = "wpc-btn-remove";
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove " + name;
      removeBtn.addEventListener("click", () => {
        if (typeof onRemove === "function") {
          onRemove(name);
        }
      });

      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(removeBtn);
      refs.inputRows.set(name, { row, dot, label, removeBtn });
    }
  });

  // Sync dot state + label text for every current row from live node.inputs.
  const inputs = (node && node.inputs) || [];
  inputs.forEach((input) => {
    if (!input || !input.name) {
      return;
    }
    const entry = refs.inputRows.get(input.name);
    if (!entry) {
      return;
    }
    const connected = input.link !== null && input.link !== undefined;
    entry.dot.classList.toggle("wpc-dot-on", connected);
  });

  // Clear + re-append in node.inputs order.
  while (refs.inputsEl.firstChild) {
    refs.inputsEl.removeChild(refs.inputsEl.firstChild);
  }

  if (!names.length) {
    const empty = refs.doc.createElement("div");
    empty.className = "wpc-inputs-empty";
    empty.textContent = "No inputs yet. Add one to create a connection slot.";
    refs.inputsEl.appendChild(empty);
  }
  names.forEach((name) => {
    refs.inputsEl.appendChild(refs.inputRows.get(name).row);
  });

  refs.inputCountEl.textContent = String(names.length);
  refs.inputCount = names.length;

  renderLivePreview(refs, node && node._promptCombinerLastResult);
}
