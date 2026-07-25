/**
 * render.mjs — DOM UI for the Scene Creator node.
 *
 * Builds ONE DOM root (mounted as a single `addDOMWidget`) that presents the
 * whole node UI, styled to match `playground/scene_creator.html`: a
 * TEMPLATE section (textarea + "＋ Add Scene Field"), a SCENE FIELDS section
 * (one row per non-reserved token), a BACKGROUNDS section (one card per
 * background + "＋ Add Background"), a CHARACTERS section (one card per
 * character, each with a nested addable OUTFITS list, + "＋ Add Character"),
 * and a LIVE PREVIEW section. No token/state math lives here beyond calling
 * into `core.mjs`; litegraph slot mutation (`addInput`/`removeInput`) lives
 * in `interaction.mjs`.
 *
 * Unlike Prompt Combiner, this node CAN approximate its rendered scene in the
 * browser between runs: `core.mjs`'s `assembleCharacters`/
 * `assembleBackgroundBlock`/`buildSceneText` mirror the backend's assembly
 * byte-for-byte, falling back to each character/background/outfit's own
 * text field when its socket has never resolved (`node._sceneSlots` is `{}`
 * before any run) — see `computeClientSceneText`/`updateComputedPreview`
 * below. That CLIENT-SIDE computed preview is what every field/character/
 * background edit refreshes, exactly like Prompt Builder's live preview.
 * The REAL rendered scene returned by the backend's `onExecuted`
 * (`{"ui": {"text": [scene], "slots": {...}}}`) is still the AUTHORITATIVE
 * preview immediately after a run — editing anything again afterward
 * recomputes and shows the client-side preview once more. `onExecuted`'s
 * `slots` map (socket name -> resolved value) is what drives the
 * wired-outfit "🔗 wired" chips and the character/background resolved-value
 * hints (see `refreshOutfitWireState`/`refreshIdentityHints` below), AND is
 * fed back into `computeClientSceneText` as the "last known" wired value for
 * any subsequent client-side recompute. The preview is LABELED PROSE (one
 * paragraph per character, `"Label: value"` scene lines) — NOT JSON; a JSON
 * `{token: value}` document was tried first but proved noisy for a
 * Qwen-style text encoder (Anima), where braces/quotes read as literal
 * tokens rather than structure.
 *
 * Sizing rule (ComfyUI-Pixaroma `find_replace` mechanism, matched EXACTLY —
 * see `js/anima_prompt/prompt_builder/render.mjs`'s / `js/anima_prompt/prompt_combiner/render.mjs`'s
 * identical module header for the full rationale): the DOM widget reports
 * its floor through the legacy `getMinHeight` option (NOT `computeSize`/
 * `getHeight`) and the Nodes 2.0 `computeLayoutSize` hook, and the node is
 * refit to its DOM content ONLY from inside a `requestAnimationFrame`
 * callback, ONLY on explicit structural triggers wired in `index.js`/
 * `interaction.mjs` (first build, a SCENE FIELD/BACKGROUND/CHARACTER/OUTFIT
 * add/remove, `onConfigure` restore, a changed `onExecuted` LIVE PREVIEW) —
 * never synchronously from a plain typing/toggle/connection-status event.
 * The node's WIDTH is never touched by this mechanism (`setNodeHeight` only
 * ever writes `size[1]`). The LIVE PREVIEW section is the one flexible child
 * (`.wsc-section-preview`): the height floor only ever counts a small
 * `PREVIEW_MIN` toward it (never its real, possibly huge, `offsetHeight` —
 * that would create a feedback loop).
 */

import {
  humanize,
  sceneFieldTokens,
  ensureState,
  toggleCharacterEnabled,
  toggleBackgroundEnabled,
  toggleOutfitEnabled,
  setCharacterField,
  setBackgroundText,
  setOutfitText,
  syncStateWidget,
  assembleCharacters,
  assembleBackgroundBlock,
  buildSceneText,
} from "./core.mjs";

const STYLE_ID = "webtoon-scene-creator-css";

// Palette + section layout lifted from js/anima_prompt/prompt_builder & js/anima_prompt/prompt_combiner
// so all three nodes read as one family; card/outfit styling lifted from
// playground/scene_creator.html's `.card`/`.sock`/`.toggle`/`.cf`/`.outfits`/
// `.outfit-row` rules.
const CSS = `
.wsc-root {
  display: flex;
  flex-direction: column;
  gap: 13px;
  width: 100%;
  box-sizing: border-box;
  padding: 4px 2px 2px;
  font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #dddddd;
  /* NO height:100% and NO min-height here - deliberate (ComfyUI-Pixaroma
     find_replace pattern; see js/anima_prompt/prompt_builder/render.mjs's header for the
     full rationale). */
}
.wsc-root, .wsc-root * { box-sizing: border-box; }
.wsc-section { display: flex; flex-direction: column; }
.wsc-section-preview { flex: 1 1 0; min-height: 100px; display: flex; flex-direction: column; }
.wsc-sec-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.wsc-sec-title { font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: #8a8f98; font-weight: 700; }
.wsc-sec-title.wsc-green { color: #7fd18f; }
.wsc-sec-note { color: #666666; font-size: 9.5px; }
.wsc-count { color: #f66744; background: rgba(246,103,68,.12); border-radius: 20px; padding: 1px 8px; font-size: 10px; font-weight: 600; margin-left: 6px; }

.wsc-textarea, .wsc-field-input, .wsc-add-name {
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
.wsc-textarea:focus, .wsc-field-input:focus, .wsc-add-name:focus { border-color: #f66744; }
.wsc-textarea::placeholder, .wsc-field-input::placeholder, .wsc-add-name::placeholder {
  color: rgba(255,255,255,.32); font-style: italic;
}
.wsc-textarea { min-height: 52px; max-height: 52px; resize: none; line-height: 1.5; }

.wsc-add-wrap { margin-top: 8px; }
.wsc-btn-add {
  background: transparent; border: 1px solid #f66744; color: #f66744;
  padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 6px;
  cursor: pointer; transition: background .12s;
}
.wsc-btn-add:hover { background: rgba(246,103,68,.12); }
.wsc-add-row { display: none; gap: 8px; margin-top: 8px; }
.wsc-add-row.wsc-show { display: flex; }
.wsc-add-name { flex: 1 1 auto; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wsc-btn-primary {
  background: #f66744; border: 1px solid #f66744; color: #fff; font-weight: 600;
  padding: 6px 12px; font-size: 12px; border-radius: 6px; cursor: pointer;
  transition: filter .12s;
}
.wsc-btn-primary:hover { filter: brightness(1.08); }
.wsc-btn-ghost {
  background: #23262d; border: 1px solid #333333; color: #dddddd;
  padding: 5px 10px; font-size: 11.5px; border-radius: 6px; cursor: pointer;
  transition: border-color .12s;
}
.wsc-btn-ghost:hover { border-color: #f66744; }

.wsc-fields { padding-right: 2px; }
.wsc-fields-empty { color: #8a8f98; font-size: 12px; font-style: italic; padding: 3px 0; }
.wsc-field-row {
  display: grid; grid-template-columns: 104px minmax(0,1fr); gap: 10px;
  align-items: center; margin-bottom: 7px;
}
.wsc-field-row label {
  color: #8a8f98; font-size: 12px; text-align: right; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
.wsc-field-input { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }

/* ---- Character / Background cards (playground/scene_creator.html's
   .card family) — shared look, .wsc-char/.wsc-bg are both cards ---- */
.wsc-bgs, .wsc-chars { padding-right: 2px; }
.wsc-bgs-empty, .wsc-chars-empty { color: #8a8f98; font-size: 12px; font-style: italic; padding: 3px 0; }
.wsc-char, .wsc-bg {
  border: 1px solid #30343c; border-radius: 8px; padding: 10px;
  margin-bottom: 9px; background: #1a1d22; transition: opacity .12s;
}
.wsc-char-off { opacity: .5; }
.wsc-char-head { display: flex; align-items: center; gap: 9px; margin-bottom: 8px; }
.wsc-dot {
  width: 11px; height: 11px; min-width: 11px; border-radius: 50%;
  border: 2px solid #3a3f48; background: #20242b; display: inline-block;
}
.wsc-dot-on { background: #7fd18f; border-color: #7fd18f; box-shadow: 0 0 8px rgba(127,209,143,.55); }
.wsc-char-name {
  font-weight: 600; font-size: 13px; flex: 1 1 auto; color: #dddddd;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wsc-toggle {
  font-size: 10px; font-weight: 700; letter-spacing: .06em; padding: 3px 9px;
  border-radius: 20px; border: 1px solid #333333; cursor: pointer;
  user-select: none; background: #23262d; color: #8a8f98;
}
.wsc-char-on .wsc-toggle { color: #7fd18f; border-color: #2c3a2c; background: rgba(127,209,143,.1); }
.wsc-btn-remove {
  background: transparent; border: 1px solid transparent; color: #8a8f98;
  border-radius: 5px; padding: 2px 7px; cursor: pointer; font-size: 12px;
}
.wsc-btn-remove:hover { color: #f66744; background: rgba(246,103,68,.12); }
.wsc-cf { display: grid; grid-template-columns: 70px minmax(0,1fr); gap: 8px; align-items: center; margin-bottom: 6px; }
.wsc-cf:last-child { margin-bottom: 0; }
.wsc-cf label { color: #8a8f98; font-size: 11px; text-align: right; }
.wsc-cf input {
  width: 100%; background: #1d1d1d; color: #cfcfcf; border: 1px solid #333333;
  border-radius: 6px; padding: 6px 8px; font-size: 11.5px; outline: none;
  transition: border-color .12s;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.wsc-cf input:focus { border-color: #f66744; }
.wsc-cf input::placeholder { color: rgba(255,255,255,.32); font-style: italic; }

/* Resolved-value hint under a character/background's name, filled from the
   last onExecuted's slots map — hidden until there's something to show. */
.wsc-hint {
  color: #666666; font-size: 10.5px; font-style: italic;
  margin: -4px 0 7px 20px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- Outfits (playground's .outfits/.outfit-row family) ---- */
.wsc-outfits {
  margin: 6px 0 0; padding: 7px 8px; border: 1px dashed #333333;
  border-radius: 6px; background: #15181d;
}
.wsc-oh {
  font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em;
  color: #666666; margin-bottom: 6px; font-weight: 700;
}
.wsc-outfit-row {
  display: grid; grid-template-columns: 14px minmax(0,1fr) 46px 22px;
  gap: 6px; align-items: center; margin-bottom: 6px;
}
.wsc-outfit-row:last-child { margin-bottom: 0; }
.wsc-odot { width: 8px; height: 8px; border-radius: 50%; background: #3a5f43; }
.wsc-outfit-off { opacity: .45; }
.wsc-outfit-field { position: relative; min-width: 0; }
.wsc-outfit-input {
  width: 100%; background: #1d1d1d; color: #cfcfcf; border: 1px solid #333333;
  border-radius: 6px; padding: 5px 7px; font-size: 11px; outline: none;
  transition: border-color .12s;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.wsc-outfit-input:focus { border-color: #f66744; }
.wsc-outfit-input::placeholder { color: rgba(255,255,255,.32); font-style: italic; }
.wsc-wired-chip {
  display: block; width: 100%; padding: 5px 7px; border-radius: 6px;
  border: 1px dashed #3a5f43; background: rgba(127,209,143,.08);
  color: #7fd18f; font-size: 11px; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wsc-otog {
  font-size: 9px; font-weight: 700; padding: 2px 5px; border-radius: 20px;
  border: 1px solid #333333; cursor: pointer; background: #23262d;
  color: #8a8f98; text-align: center; user-select: none;
}
.wsc-outfit-row.wsc-outfit-on .wsc-otog { color: #7fd18f; border-color: #2c3a2c; background: rgba(127,209,143,.1); }
.wsc-btn-mini {
  background: transparent; border: 1px dashed #3a5f43; color: #7fd18f;
  padding: 3px 9px; font-size: 10.5px; font-weight: 600; border-radius: 6px;
  cursor: pointer; margin-top: 2px;
}
.wsc-btn-mini:hover { background: rgba(127,209,143,.08); }

.wsc-preview {
  background: #161616; border: 1px solid #2c3a2c; border-radius: 5px;
  padding: 8px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; line-height: 1.55; color: #cfcfcf;
  white-space: pre-wrap; word-break: break-word;
  flex: 1 1 0;
  min-height: 60px;
  overflow-y: auto;
}
.wsc-preview-empty { color: #8a8f98; font-style: italic; }
`;

/**
 * Inject the Scene Creator stylesheet once, guarded by
 * `#webtoon-scene-creator-css`. Safe no-op if there's no `document`.
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

const PREVIEW_EMPTY_TEXT = "Run to preview the scene";

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build one "＋ Add X" control: a ghost/accent button that reveals a
 * name-input row (Add/Cancel + Enter/Escape), matching the TEMPLATE
 * section's "＋ Add Scene Field" control. Returns the wrap + every element
 * the caller needs to wire.
 */
function buildAddControl(d, buttonClass, buttonLabel, placeholder) {
  const wrap = d.createElement("div");
  wrap.className = "wsc-add-wrap";
  const btn = d.createElement("button");
  btn.setAttribute("type", "button");
  btn.className = buttonClass;
  btn.textContent = buttonLabel;

  const row = d.createElement("div");
  row.className = "wsc-add-row";
  const nameInput = d.createElement("input");
  nameInput.setAttribute("type", "text");
  nameInput.className = "wsc-add-name";
  nameInput.setAttribute("placeholder", placeholder);
  nameInput.setAttribute("autocomplete", "off");
  const confirmBtn = d.createElement("button");
  confirmBtn.setAttribute("type", "button");
  confirmBtn.className = "wsc-btn-primary";
  confirmBtn.textContent = "Add";
  const cancelBtn = d.createElement("button");
  cancelBtn.setAttribute("type", "button");
  cancelBtn.className = "wsc-btn-ghost";
  cancelBtn.textContent = "Cancel";
  row.appendChild(nameInput);
  row.appendChild(confirmBtn);
  row.appendChild(cancelBtn);
  wrap.appendChild(btn);
  wrap.appendChild(row);

  return { wrap, btn, row, nameInput, confirmBtn, cancelBtn };
}

/**
 * Build the single DOM root for the node: TEMPLATE section (textarea + Add
 * Scene Field control), SCENE FIELDS section (empty container, populated by
 * `rebuildFields`), BACKGROUNDS section (empty container + Add Background
 * control, populated by `rebuildBackgrounds`), CHARACTERS section (empty
 * container + Add Character control, populated by `rebuildCharacters`), and
 * LIVE PREVIEW section. Returns a flat `refs` object with references to
 * every element `interaction.mjs`/the `rebuild*` functions need — no
 * lookups by class name at call time.
 */
export function buildRoot(doc) {
  const d = doc || document;

  const root = d.createElement("div");
  root.className = "wsc-root";

  // ---- Template section ----
  const templateSection = d.createElement("div");
  templateSection.className = "wsc-section";
  const templateHead = d.createElement("div");
  templateHead.className = "wsc-sec-head";
  const templateTitle = d.createElement("span");
  templateTitle.className = "wsc-sec-title";
  templateTitle.textContent = "Template";
  templateHead.appendChild(templateTitle);

  const templateEl = d.createElement("textarea");
  templateEl.className = "wsc-textarea";
  templateEl.setAttribute("spellcheck", "false");

  const addField = buildAddControl(d, "wsc-btn-add", "＋ Add Scene Field", "field name  e.g. weather");

  templateSection.appendChild(templateHead);
  templateSection.appendChild(templateEl);
  templateSection.appendChild(addField.wrap);

  // ---- Scene fields section ----
  const fieldsSection = d.createElement("div");
  fieldsSection.className = "wsc-section";
  const fieldsHead = d.createElement("div");
  fieldsHead.className = "wsc-sec-head";
  const fieldsTitle = d.createElement("span");
  fieldsTitle.className = "wsc-sec-title";
  fieldsTitle.appendChild(d.createTextNode("Scene Fields"));
  const fieldCountEl = d.createElement("span");
  fieldCountEl.className = "wsc-count";
  fieldCountEl.textContent = "0";
  fieldsTitle.appendChild(fieldCountEl);
  fieldsHead.appendChild(fieldsTitle);

  const fieldsEl = d.createElement("div");
  fieldsEl.className = "wsc-fields";

  fieldsSection.appendChild(fieldsHead);
  fieldsSection.appendChild(fieldsEl);

  // ---- Backgrounds section ----
  const bgsSection = d.createElement("div");
  bgsSection.className = "wsc-section";
  const bgsHead = d.createElement("div");
  bgsHead.className = "wsc-sec-head";
  const bgsTitle = d.createElement("span");
  bgsTitle.className = "wsc-sec-title";
  bgsTitle.appendChild(d.createTextNode("Backgrounds"));
  const bgCountEl = d.createElement("span");
  bgCountEl.className = "wsc-count";
  bgCountEl.textContent = "0";
  bgsTitle.appendChild(bgCountEl);
  bgsHead.appendChild(bgsTitle);

  const bgsEl = d.createElement("div");
  bgsEl.className = "wsc-bgs";

  const addBg = buildAddControl(d, "wsc-btn-add", "＋ Add Background", "background name  e.g. Bedroom");

  bgsSection.appendChild(bgsHead);
  bgsSection.appendChild(bgsEl);
  bgsSection.appendChild(addBg.wrap);

  // ---- Characters section ----
  const charsSection = d.createElement("div");
  charsSection.className = "wsc-section";
  const charsHead = d.createElement("div");
  charsHead.className = "wsc-sec-head";
  const charsTitle = d.createElement("span");
  charsTitle.className = "wsc-sec-title";
  charsTitle.appendChild(d.createTextNode("Characters"));
  const charCountEl = d.createElement("span");
  charCountEl.className = "wsc-count";
  charCountEl.textContent = "0";
  charsTitle.appendChild(charCountEl);
  charsHead.appendChild(charsTitle);

  const charsEl = d.createElement("div");
  charsEl.className = "wsc-chars";

  const addChar = buildAddControl(d, "wsc-btn-add", "＋ Add Character", "character name  e.g. Yuna");

  charsSection.appendChild(charsHead);
  charsSection.appendChild(charsEl);
  charsSection.appendChild(addChar.wrap);

  // ---- Live preview section ----
  const previewSection = d.createElement("div");
  previewSection.className = "wsc-section wsc-section-preview";
  const previewHead = d.createElement("div");
  previewHead.className = "wsc-sec-head";
  const previewTitle = d.createElement("span");
  previewTitle.className = "wsc-sec-title wsc-green";
  previewTitle.textContent = "Live Preview";
  const previewNote = d.createElement("span");
  previewNote.className = "wsc-sec-note";
  previewNote.textContent = "on-run";
  previewHead.appendChild(previewTitle);
  previewHead.appendChild(previewNote);

  const previewEl = d.createElement("div");
  previewEl.className = "wsc-preview";

  previewSection.appendChild(previewHead);
  previewSection.appendChild(previewEl);

  root.appendChild(templateSection);
  root.appendChild(fieldsSection);
  root.appendChild(bgsSection);
  root.appendChild(charsSection);
  root.appendChild(previewSection);

  return {
    doc: d,
    root,
    templateEl,
    addFieldBtn: addField.btn,
    addFieldRow: addField.row,
    addFieldNameInput: addField.nameInput,
    addFieldConfirmBtn: addField.confirmBtn,
    addFieldCancelBtn: addField.cancelBtn,
    fieldsEl,
    fieldCountEl,
    fieldRows: new Map(),
    bgsEl,
    bgCountEl,
    addBgBtn: addBg.btn,
    addBgRow: addBg.row,
    addBgNameInput: addBg.nameInput,
    addBgConfirmBtn: addBg.confirmBtn,
    addBgCancelBtn: addBg.cancelBtn,
    bgCards: new Map(),
    charsEl,
    charCountEl,
    addCharBtn: addChar.btn,
    addCharRow: addChar.row,
    addCharNameInput: addChar.nameInput,
    addCharConfirmBtn: addChar.confirmBtn,
    addCharCancelBtn: addChar.cancelBtn,
    charCards: new Map(),
    previewEl,
  };
}

// ---- Measured resize mechanism (ComfyUI-Pixaroma `find_replace` approach,
// copied verbatim from js/anima_prompt/prompt_builder/render.mjs & js/anima_prompt/prompt_combiner/
// render.mjs — see either module's header for the full rationale) ----

export const CHROME = 60;
export const DEFAULT_W = 320;
export const DEFAULT_H = 260;

// Minimum LIVE PREVIEW block height (head + a couple lines of body). The
// preview section flexes to fill any extra node height beyond this floor.
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
 * The node's minimum height = the FIXED sections (template + scene fields +
 * backgrounds + characters, measured live) + a minimum preview block, NOT
 * the full (flexible) preview. Sums `root`'s *visible* direct children's
 * `offsetHeight` (never `scrollHeight`), substituting `PREVIEW_MIN` for the
 * `.wsc-section-preview` child instead of its real `offsetHeight`, plus the
 * flex row-gap between children and the root's own vertical padding.
 * Children hidden via `display: none` (`offsetParent === null`) don't count.
 * Only meaningful when called after layout has happened (from inside a
 * `requestAnimationFrame` callback — see `scheduleRefit` below). Rounded to a
 * 4px grid.
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
    if (child.classList && child.classList.contains("wsc-section-preview")) {
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
 * (`node.size[0]`) unconditionally. Records `h` on `node._scAutoH` so
 * `refitNode` can tell later whether the user has since dragged the node
 * taller than the last auto-fit height.
 */
export function setNodeHeight(node, h) {
  if (!node.size) {
    node.size = [DEFAULT_W, h];
  }
  node.size[1] = h;
  if (typeof node.setSize === "function") {
    node.setSize([node.size[0], h]);
  }
  node._scAutoH = h;
}

/**
 * Recompute the node's desired height from `root`'s measured content and
 * resize if needed. GROWS whenever the content no longer fits. Only SHRINKS
 * back down to fit when the user hasn't manually dragged the node taller
 * than the last auto-fit height recorded in `node._scAutoH`.
 */
export function refitNode(node, root) {
  if (!root) {
    return;
  }
  const want = Math.max(measureMinHeight(root) + CHROME, DEFAULT_H);
  const cur =
    node.size && typeof node.size[1] === "number" ? node.size[1] : DEFAULT_H;
  const autoH = node._scAutoH;
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
 * was caused by an explicit, intentional user action: a structural SCENE
 * FIELD / BACKGROUND / CHARACTER / OUTFIT add/remove, or a changed LIVE
 * PREVIEW. UNCONDITIONAL — never gated by `node._scConfigured` — because
 * these happen long after load and are always meant to grow/shrink the node.
 * For the very first build's fit (the one call that could otherwise race a
 * workflow's restored `node.size`), use `scheduleInitialFit` instead.
 */
export function scheduleRefit(node, root) {
  if (!root) {
    return;
  }
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
  if (typeof raf !== "function") {
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
 * call only) for the next animation frame, GUARDED by `node._scConfigured`.
 *
 * `index.js`'s `onConfigure` wrap sets `node._scConfigured = true` as the
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
 *
 * Only ever call this for the very first build. Every later structural
 * change (a SCENE FIELD/BACKGROUND/CHARACTER/OUTFIT add/remove after the
 * node already exists) must go through the unconditional `scheduleRefit`
 * above instead.
 */
export function scheduleInitialFit(node, root) {
  if (!root) {
    return;
  }
  const run = () => {
    if (node._scConfigured) {
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
 * Reconcile the SCENE FIELDS section against the current template text
 * (read from `refs.templateEl.value`), EXCLUDING the two reserved tokens
 * (see `sceneFieldTokens`):
 *   - Add a row for every new token (seeding its value from
 *     `properties.sceneState.fields[token]`, or "").
 *   - Remove rows for tokens no longer present (the cached value in
 *     `state.fields` is left untouched so re-adding the token later
 *     restores it).
 *   - Reorder rows into first-appearance order.
 * The very first call for this `refs` schedules the GUARDED initial fit
 * (`scheduleInitialFit` — a no-op for a node being loaded from a workflow,
 * so it never clobbers the just-restored `node.size`); a LATER structural
 * change (a token added/removed) schedules the unconditional `scheduleRefit`
 * instead, since that's always a deliberate user action. Neither ever
 * resizes synchronously.
 *
 * `opts.silent` (used ONLY by `index.js`'s `onConfigure` restore path)
 * suppresses BOTH triggers entirely — the restore path rebuilds rows to
 * match the just-restored template/state but must never resize the node
 * itself; by the time it runs, `refs._fieldsBuiltOnce` is already `true`
 * (set by `onNodeCreated`'s earlier call), so only the structural-change
 * branch could otherwise fire.
 *
 * Always calls `syncStateWidget(node)` before returning (whether or not
 * `opts.silent` is set) so the `scene_state` widget mirrors any field this
 * call seeded/removed from `state.fields`.
 */
export function rebuildFields(node, refs, opts) {
  const state = ensureState(node);
  const tokens = sceneFieldTokens(refs.templateEl.value);
  const tokenSet = new Set(tokens);
  const isFirstBuild = !refs._fieldsBuiltOnce;
  refs._fieldsBuiltOnce = true;
  let structuralChange = false;

  for (const [token, entry] of Array.from(refs.fieldRows.entries())) {
    if (!tokenSet.has(token)) {
      if (entry.row.parentNode && typeof entry.row.parentNode.removeChild === "function") {
        entry.row.parentNode.removeChild(entry.row);
      }
      refs.fieldRows.delete(token);
      structuralChange = true;
    }
  }

  tokens.forEach((token) => {
    if (!(token in state.fields)) {
      state.fields[token] = "";
    }
    if (!refs.fieldRows.has(token)) {
      const row = refs.doc.createElement("div");
      row.className = "wsc-field-row";
      const label = refs.doc.createElement("label");
      label.textContent = humanize(token);
      label.title = "{" + token + "}";
      const input = refs.doc.createElement("input");
      input.setAttribute("type", "text");
      input.className = "wsc-field-input";
      input.value = state.fields[token] || "";
      input.setAttribute("placeholder", "…");
      input.addEventListener("input", () => {
        // Field edit: write value + refresh the client-side preview. Never
        // rebuild rows or resize.
        state.fields[token] = input.value;
        syncStateWidget(node);
        updateComputedPreview(node, refs);
      });
      row.appendChild(label);
      row.appendChild(input);
      refs.fieldRows.set(token, { row, label, input });
      structuralChange = true;
    }
  });

  tokens.forEach((token) => {
    const entry = refs.fieldRows.get(token);
    const value = state.fields[token] || "";
    if (entry.input.value !== value) {
      entry.input.value = value;
    }
  });

  while (refs.fieldsEl.firstChild) {
    refs.fieldsEl.removeChild(refs.fieldsEl.firstChild);
  }

  if (!tokens.length) {
    const empty = refs.doc.createElement("div");
    empty.className = "wsc-fields-empty";
    empty.textContent = "No scene fields in the template yet.";
    refs.fieldsEl.appendChild(empty);
  }
  tokens.forEach((token) => {
    refs.fieldsEl.appendChild(refs.fieldRows.get(token).row);
  });

  refs.fieldCountEl.textContent = String(tokens.length);
  refs.fieldTokenCount = tokens.length;

  syncStateWidget(node);
  updateComputedPreview(node, refs);

  if (!(opts && opts.silent)) {
    if (isFirstBuild) {
      scheduleInitialFit(node, refs.root);
    } else if (structuralChange) {
      scheduleRefit(node, refs.root);
    }
  }
}

/**
 * Whether litegraph's `node.inputs` currently has a CONNECTED slot named
 * `socket` (a real wire, not just a declared-but-unconnected slot).
 */
export function isSocketConnected(node, socket) {
  const inputs = (node && node.inputs) || [];
  const input = inputs.find((i) => i && i.name === socket);
  return !!input && input.link !== null && input.link !== undefined;
}

/**
 * Update ONLY the connection-status dot for each existing CHARACTER and
 * BACKGROUND card (green `wsc-dot-on` if its identity socket is wired, muted
 * otherwise) from the live `node.inputs`. Used for non-structural updates (a
 * link connects/disconnects) — never adds/removes cards, never resizes.
 */
export function refreshConnectionDots(node, refs) {
  refs.charCards.forEach((entry, socket) => {
    entry.dot.classList.toggle("wsc-dot-on", isSocketConnected(node, socket));
  });
  refs.bgCards.forEach((entry, socket) => {
    entry.dot.classList.toggle("wsc-dot-on", isSocketConnected(node, socket));
  });
}

/**
 * Toggle a single outfit row between its text input (socket disconnected)
 * and its "🔗 wired" chip (socket connected). `resolvedValue` — read from
 * `node._sceneSlots[outfit.socket]` by the caller — is shown in the chip in
 * place of the generic "wired" label once a run has actually resolved it.
 */
export function applyOutfitWireDisplay(entry, connected, resolvedValue) {
  entry.row.classList.toggle("wsc-outfit-wired", !!connected);
  if (connected) {
    entry.textInput.style.display = "none";
    entry.chipEl.style.display = "";
    entry.chipEl.textContent = resolvedValue ? "🔗 " + resolvedValue : "🔗 wired";
  } else {
    entry.textInput.style.display = "";
    entry.chipEl.style.display = "none";
  }
}

/**
 * Refresh EVERY outfit row's text-vs-chip display across all CHARACTER
 * cards, from the live `node.inputs` connection state and (if a run has
 * happened) `node._sceneSlots`. Used both for non-structural updates (a link
 * connects/disconnects — no rebuild, no resize) and after `onExecuted`
 * stores fresh `node._sceneSlots`.
 */
export function refreshOutfitWireState(node, refs) {
  const slots = node._sceneSlots || {};
  refs.charCards.forEach((entry) => {
    entry.outfitRows.forEach((rowEntry, socket) => {
      applyOutfitWireDisplay(rowEntry, isSocketConnected(node, socket), slots[socket]);
    });
  });
}

/**
 * Show/hide a character/background card's resolved-value hint (the small
 * muted line under its name) from `resolvedValue` (read from
 * `node._sceneSlots[socket]` by the caller). Hidden entirely when there's no
 * resolved value yet (before the first run, or the socket isn't wired).
 */
export function applyIdentityHint(entry, resolvedValue) {
  if (!entry || !entry.hintEl) {
    return;
  }
  if (resolvedValue) {
    entry.hintEl.textContent = resolvedValue;
    entry.hintEl.style.display = "";
  } else {
    entry.hintEl.textContent = "";
    entry.hintEl.style.display = "none";
  }
}

/**
 * Refresh every CHARACTER's and BACKGROUND's resolved-value hint from
 * `node._sceneSlots` (populated by `onExecuted`).
 */
export function refreshIdentityHints(node, refs) {
  const slots = node._sceneSlots || {};
  refs.charCards.forEach((entry, socket) => applyIdentityHint(entry, slots[socket]));
  refs.bgCards.forEach((entry, socket) => applyIdentityHint(entry, slots[socket]));
}

/**
 * Build one labeled text-input row (`.wsc-cf`: label + input), matching the
 * CHARACTER/BACKGROUND card's Expression/Details fields. The caller wires
 * the `input` event itself.
 */
function makeLabeledInput(doc, label, value, placeholder) {
  const row = doc.createElement("div");
  row.className = "wsc-cf";
  const labelEl = doc.createElement("label");
  labelEl.textContent = label;
  const input = doc.createElement("input");
  input.setAttribute("type", "text");
  input.value = value || "";
  input.setAttribute("placeholder", placeholder);
  row.appendChild(labelEl);
  row.appendChild(input);
  return { row, input };
}

/**
 * Build one OUTFIT row's DOM + wire its interactive controls (text edit,
 * ON/OFF toggle, ✕ remove). The row always has BOTH the text input and the
 * "🔗 wired" chip in the DOM — `applyOutfitWireDisplay` (called right after,
 * from `syncOutfitRows`) picks which one is actually shown based on the
 * outfit socket's current connection state, so the row starts in the
 * correct mode immediately.
 */
function bindOutfitRow(node, refs, character, outfit, handlers) {
  const state = ensureState(node);
  const doc = refs.doc;

  const row = doc.createElement("div");
  row.className = "wsc-outfit-row";

  const dot = doc.createElement("span");
  dot.className = "wsc-odot";

  const fieldWrap = doc.createElement("div");
  fieldWrap.className = "wsc-outfit-field";
  const textInput = doc.createElement("input");
  textInput.setAttribute("type", "text");
  textInput.className = "wsc-outfit-input";
  textInput.value = outfit.text || "";
  textInput.setAttribute("placeholder", "outfit piece");
  textInput.addEventListener("input", () => {
    setOutfitText(state, character.socket, outfit.socket, textInput.value);
    syncStateWidget(node);
    updateComputedPreview(node, refs);
  });
  const chipEl = doc.createElement("span");
  chipEl.className = "wsc-wired-chip";
  chipEl.textContent = "🔗 wired";
  chipEl.style.display = "none";
  fieldWrap.appendChild(textInput);
  fieldWrap.appendChild(chipEl);

  const toggleBtn = doc.createElement("span");
  toggleBtn.className = "wsc-otog";
  toggleBtn.textContent = outfit.enabled ? "ON" : "OFF";
  toggleBtn.addEventListener("click", () => {
    const enabled = toggleOutfitEnabled(state, character.socket, outfit.socket);
    row.classList.toggle("wsc-outfit-on", !!enabled);
    row.classList.toggle("wsc-outfit-off", !enabled);
    toggleBtn.textContent = enabled ? "ON" : "OFF";
    syncStateWidget(node);
    updateComputedPreview(node, refs);
  });

  const removeBtn = doc.createElement("button");
  removeBtn.setAttribute("type", "button");
  removeBtn.className = "wsc-btn-remove";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove outfit";
  removeBtn.addEventListener("click", () => {
    if (handlers && typeof handlers.onRemoveOutfit === "function") {
      handlers.onRemoveOutfit(character.socket, outfit.socket);
    }
  });

  row.appendChild(dot);
  row.appendChild(fieldWrap);
  row.appendChild(toggleBtn);
  row.appendChild(removeBtn);

  row.classList.toggle("wsc-outfit-on", !!outfit.enabled);
  row.classList.toggle("wsc-outfit-off", !outfit.enabled);

  return { row, dot, textInput, chipEl, toggleBtn, removeBtn };
}

/**
 * Reconcile one CHARACTER card's nested OUTFITS rows against
 * `character.outfits` (add missing, remove stale, sync values/order) —
 * mirrors the CHARACTERS-section-level reconcile below but one level down.
 * Never resizes itself (the caller — `addOutfit`/`removeOutfit` in
 * `interaction.mjs` — schedules the ONE refit this causes).
 */
function syncOutfitRows(node, refs, cardEntry, character, handlers) {
  const outfits = character.outfits || [];
  const socketSet = new Set(outfits.map((o) => o.socket));

  for (const [socket, rowEntry] of Array.from(cardEntry.outfitRows.entries())) {
    if (!socketSet.has(socket)) {
      if (rowEntry.row.parentNode) {
        rowEntry.row.parentNode.removeChild(rowEntry.row);
      }
      cardEntry.outfitRows.delete(socket);
    }
  }

  outfits.forEach((outfit) => {
    if (!cardEntry.outfitRows.has(outfit.socket)) {
      const rowEntry = bindOutfitRow(node, refs, character, outfit, handlers);
      cardEntry.outfitRows.set(outfit.socket, rowEntry);
    }
  });

  outfits.forEach((outfit) => {
    const rowEntry = cardEntry.outfitRows.get(outfit.socket);
    if (!rowEntry) {
      return;
    }
    const text = outfit.text || "";
    if (rowEntry.textInput.value !== text) {
      rowEntry.textInput.value = text;
    }
    rowEntry.toggleBtn.textContent = outfit.enabled ? "ON" : "OFF";
    rowEntry.row.classList.toggle("wsc-outfit-on", !!outfit.enabled);
    rowEntry.row.classList.toggle("wsc-outfit-off", !outfit.enabled);
    applyOutfitWireDisplay(rowEntry, isSocketConnected(node, outfit.socket), (node._sceneSlots || {})[outfit.socket]);
  });

  while (cardEntry.outfitsListEl.firstChild) {
    cardEntry.outfitsListEl.removeChild(cardEntry.outfitsListEl.firstChild);
  }
  outfits.forEach((outfit) => {
    const rowEntry = cardEntry.outfitRows.get(outfit.socket);
    if (rowEntry) {
      cardEntry.outfitsListEl.appendChild(rowEntry.row);
    }
  });
}

/**
 * Build one CHARACTER card's DOM + wire its interactive controls (toggle,
 * appearance, outfits, action, focus, remove, ＋ outfit) and populate its
 * nested OUTFITS rows. Field order matches the canonical shape: Appearance,
 * then Outfits, then Action, then Focus. Toggle/field/outfit edits mutate
 * `state` DIRECTLY, refresh the client-side LIVE PREVIEW, and update only
 * their own card's/row's DOM — no rebuild, no resize (mirrors the SCENE
 * FIELDS row-level `input` handler). The card's ✕ defers to
 * `handlers.onRemove(socket)`; a row's ✕ defers to
 * `handlers.onRemoveOutfit(characterSocket, outfitSocket)`; "＋ outfit"
 * defers to `handlers.onAddOutfit(characterSocket)` — all three (plus the
 * litegraph `addInput`/`removeInput` + state mutation + rebuild + refit)
 * live in `interaction.mjs`.
 */
function bindCharacterCard(node, refs, character, handlers) {
  const state = ensureState(node);
  const doc = refs.doc;

  const card = doc.createElement("div");
  card.className = "wsc-char";

  const head = doc.createElement("div");
  head.className = "wsc-char-head";

  const dot = doc.createElement("span");
  dot.className = "wsc-dot";

  const nameEl = doc.createElement("span");
  nameEl.className = "wsc-char-name";
  nameEl.textContent = character.name;

  const toggleBtn = doc.createElement("span");
  toggleBtn.className = "wsc-toggle";
  toggleBtn.textContent = character.enabled ? "ON" : "OFF";
  toggleBtn.addEventListener("click", () => {
    const enabled = toggleCharacterEnabled(state, character.socket);
    card.classList.toggle("wsc-char-on", !!enabled);
    card.classList.toggle("wsc-char-off", !enabled);
    toggleBtn.textContent = enabled ? "ON" : "OFF";
    syncStateWidget(node);
    updateComputedPreview(node, refs);
  });

  const removeBtn = doc.createElement("button");
  removeBtn.setAttribute("type", "button");
  removeBtn.className = "wsc-btn-remove";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove " + character.name;
  removeBtn.addEventListener("click", () => {
    if (handlers && typeof handlers.onRemove === "function") {
      handlers.onRemove(character.socket);
    }
  });

  head.appendChild(dot);
  head.appendChild(nameEl);
  head.appendChild(toggleBtn);
  head.appendChild(removeBtn);
  card.appendChild(head);

  const hintEl = doc.createElement("div");
  hintEl.className = "wsc-hint";
  hintEl.style.display = "none";
  card.appendChild(hintEl);

  const appearanceField = makeLabeledInput(doc, "Appearance", character.appearance, "…");
  appearanceField.input.addEventListener("input", () => {
    setCharacterField(state, character.socket, "appearance", appearanceField.input.value);
    syncStateWidget(node);
    updateComputedPreview(node, refs);
  });
  card.appendChild(appearanceField.row);

  const outfitsBox = doc.createElement("div");
  outfitsBox.className = "wsc-outfits";
  const outfitsHead = doc.createElement("div");
  outfitsHead.className = "wsc-oh";
  outfitsHead.textContent = "Outfits";
  const outfitsListEl = doc.createElement("div");
  outfitsListEl.className = "wsc-outfits-list";
  const addOutfitBtn = doc.createElement("button");
  addOutfitBtn.setAttribute("type", "button");
  addOutfitBtn.className = "wsc-btn-mini";
  addOutfitBtn.textContent = "＋ outfit";
  addOutfitBtn.addEventListener("click", () => {
    if (handlers && typeof handlers.onAddOutfit === "function") {
      handlers.onAddOutfit(character.socket);
    }
  });
  outfitsBox.appendChild(outfitsHead);
  outfitsBox.appendChild(outfitsListEl);
  outfitsBox.appendChild(addOutfitBtn);
  card.appendChild(outfitsBox);

  const actionField = makeLabeledInput(doc, "Action", character.action, "…");
  actionField.input.addEventListener("input", () => {
    setCharacterField(state, character.socket, "action", actionField.input.value);
    syncStateWidget(node);
    updateComputedPreview(node, refs);
  });
  card.appendChild(actionField.row);

  const focusField = makeLabeledInput(doc, "Focus", character.focus, "…");
  focusField.input.addEventListener("input", () => {
    setCharacterField(state, character.socket, "focus", focusField.input.value);
    syncStateWidget(node);
    updateComputedPreview(node, refs);
  });
  card.appendChild(focusField.row);

  card.classList.toggle("wsc-char-on", !!character.enabled);
  card.classList.toggle("wsc-char-off", !character.enabled);

  const entry = {
    card,
    dot,
    nameEl,
    hintEl,
    toggleBtn,
    appearanceInput: appearanceField.input,
    actionInput: actionField.input,
    focusInput: focusField.input,
    removeBtn,
    outfitsListEl,
    addOutfitBtn,
    outfitRows: new Map(),
  };
  syncOutfitRows(node, refs, entry, character, handlers);
  return entry;
}

/**
 * Reconcile the CHARACTERS section against `node.properties.sceneState.
 * characters` (the source of truth for identity/order — litegraph
 * `node.inputs` mirrors it 1:1 by socket name, mutated in `interaction.mjs`):
 *   - Add a card for every character entry not yet shown.
 *   - Remove cards for entries no longer present.
 *   - Reorder cards to match `state.characters` order.
 *   - Sync every existing card's displayed name/enabled/appearance/action/
 *     focus from state, AND reconcile its nested OUTFITS rows (covers
 *     `onConfigure` restore, where cards are rebuilt fresh from
 *     just-restored state).
 * Never resizes the node itself — that's the caller's job (`scheduleRefit`
 * in `interaction.mjs`) — always ends by refreshing the connection dots,
 * outfit wire/chip state, and resolved-value hints.
 */
export function rebuildCharacters(node, refs, handlers) {
  const state = ensureState(node);
  const characters = state.characters || [];
  const socketSet = new Set(characters.map((c) => c.socket));

  for (const [socket, entry] of Array.from(refs.charCards.entries())) {
    if (!socketSet.has(socket)) {
      if (entry.card.parentNode && typeof entry.card.parentNode.removeChild === "function") {
        entry.card.parentNode.removeChild(entry.card);
      }
      refs.charCards.delete(socket);
    }
  }

  characters.forEach((character) => {
    if (!refs.charCards.has(character.socket)) {
      const entry = bindCharacterCard(node, refs, character, handlers);
      refs.charCards.set(character.socket, entry);
    }
  });

  characters.forEach((character) => {
    const entry = refs.charCards.get(character.socket);
    if (!entry) {
      return;
    }
    if (entry.nameEl.textContent !== character.name) {
      entry.nameEl.textContent = character.name;
    }
    entry.card.classList.toggle("wsc-char-on", !!character.enabled);
    entry.card.classList.toggle("wsc-char-off", !character.enabled);
    entry.toggleBtn.textContent = character.enabled ? "ON" : "OFF";
    const appearance = character.appearance || "";
    if (entry.appearanceInput.value !== appearance) {
      entry.appearanceInput.value = appearance;
    }
    const action = character.action || "";
    if (entry.actionInput.value !== action) {
      entry.actionInput.value = action;
    }
    const focus = character.focus || "";
    if (entry.focusInput.value !== focus) {
      entry.focusInput.value = focus;
    }
    syncOutfitRows(node, refs, entry, character, handlers);
  });

  while (refs.charsEl.firstChild) {
    refs.charsEl.removeChild(refs.charsEl.firstChild);
  }

  if (!characters.length) {
    const empty = refs.doc.createElement("div");
    empty.className = "wsc-chars-empty";
    empty.textContent = "No characters yet. Add one to create a connection slot.";
    refs.charsEl.appendChild(empty);
  }
  characters.forEach((character) => {
    const entry = refs.charCards.get(character.socket);
    if (entry) {
      refs.charsEl.appendChild(entry.card);
    }
  });

  refs.charCountEl.textContent = String(characters.length);
  refs.charCount = characters.length;

  syncStateWidget(node);
  updateComputedPreview(node, refs);

  refreshConnectionDots(node, refs);
  refreshOutfitWireState(node, refs);
  refreshIdentityHints(node, refs);
}

/**
 * Build one BACKGROUND card's DOM + wire its interactive controls (toggle,
 * Details text, remove). Mirrors `bindCharacterCard` minus the nested
 * OUTFITS box (backgrounds have no outfits).
 */
function bindBackgroundCard(node, refs, background, handlers) {
  const state = ensureState(node);
  const doc = refs.doc;

  const card = doc.createElement("div");
  card.className = "wsc-bg";

  const head = doc.createElement("div");
  head.className = "wsc-char-head";

  const dot = doc.createElement("span");
  dot.className = "wsc-dot";

  const nameEl = doc.createElement("span");
  nameEl.className = "wsc-char-name";
  nameEl.textContent = background.name;

  const toggleBtn = doc.createElement("span");
  toggleBtn.className = "wsc-toggle";
  toggleBtn.textContent = background.enabled ? "ON" : "OFF";
  toggleBtn.addEventListener("click", () => {
    const enabled = toggleBackgroundEnabled(state, background.socket);
    card.classList.toggle("wsc-char-on", !!enabled);
    card.classList.toggle("wsc-char-off", !enabled);
    toggleBtn.textContent = enabled ? "ON" : "OFF";
    syncStateWidget(node);
    updateComputedPreview(node, refs);
  });

  const removeBtn = doc.createElement("button");
  removeBtn.setAttribute("type", "button");
  removeBtn.className = "wsc-btn-remove";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove " + background.name;
  removeBtn.addEventListener("click", () => {
    if (handlers && typeof handlers.onRemove === "function") {
      handlers.onRemove(background.socket);
    }
  });

  head.appendChild(dot);
  head.appendChild(nameEl);
  head.appendChild(toggleBtn);
  head.appendChild(removeBtn);
  card.appendChild(head);

  const hintEl = doc.createElement("div");
  hintEl.className = "wsc-hint";
  hintEl.style.display = "none";
  card.appendChild(hintEl);

  const detailsField = makeLabeledInput(doc, "Details", background.text, "…");
  detailsField.input.addEventListener("input", () => {
    setBackgroundText(state, background.socket, detailsField.input.value);
    syncStateWidget(node);
    updateComputedPreview(node, refs);
  });
  card.appendChild(detailsField.row);

  card.classList.toggle("wsc-char-on", !!background.enabled);
  card.classList.toggle("wsc-char-off", !background.enabled);

  return {
    card,
    dot,
    nameEl,
    hintEl,
    toggleBtn,
    textInput: detailsField.input,
    removeBtn,
  };
}

/**
 * Reconcile the BACKGROUNDS section against
 * `node.properties.sceneState.backgrounds` — mirrors `rebuildCharacters`
 * one level simpler (no nested outfits). Never resizes the node itself.
 */
export function rebuildBackgrounds(node, refs, handlers) {
  const state = ensureState(node);
  const backgrounds = state.backgrounds || [];
  const socketSet = new Set(backgrounds.map((b) => b.socket));

  for (const [socket, entry] of Array.from(refs.bgCards.entries())) {
    if (!socketSet.has(socket)) {
      if (entry.card.parentNode && typeof entry.card.parentNode.removeChild === "function") {
        entry.card.parentNode.removeChild(entry.card);
      }
      refs.bgCards.delete(socket);
    }
  }

  backgrounds.forEach((background) => {
    if (!refs.bgCards.has(background.socket)) {
      const entry = bindBackgroundCard(node, refs, background, handlers);
      refs.bgCards.set(background.socket, entry);
    }
  });

  backgrounds.forEach((background) => {
    const entry = refs.bgCards.get(background.socket);
    if (!entry) {
      return;
    }
    if (entry.nameEl.textContent !== background.name) {
      entry.nameEl.textContent = background.name;
    }
    entry.card.classList.toggle("wsc-char-on", !!background.enabled);
    entry.card.classList.toggle("wsc-char-off", !background.enabled);
    entry.toggleBtn.textContent = background.enabled ? "ON" : "OFF";
    const text = background.text || "";
    if (entry.textInput.value !== text) {
      entry.textInput.value = text;
    }
  });

  while (refs.bgsEl.firstChild) {
    refs.bgsEl.removeChild(refs.bgsEl.firstChild);
  }

  if (!backgrounds.length) {
    const empty = refs.doc.createElement("div");
    empty.className = "wsc-bgs-empty";
    empty.textContent = "No backgrounds yet. Add one to create a connection slot.";
    refs.bgsEl.appendChild(empty);
  }
  backgrounds.forEach((background) => {
    const entry = refs.bgCards.get(background.socket);
    if (entry) {
      refs.bgsEl.appendChild(entry.card);
    }
  });

  refs.bgCountEl.textContent = String(backgrounds.length);
  refs.bgCount = backgrounds.length;

  syncStateWidget(node);
  updateComputedPreview(node, refs);

  refreshConnectionDots(node, refs);
  refreshIdentityHints(node, refs);
}

/**
 * Re-render the LIVE PREVIEW body: `text` is the REAL rendered scene string
 * returned by the backend's `onExecuted` (`message.text.join("")`, wired in
 * `index.js`). Before the node has ever run (`text` is not a string), shows
 * the italic muted placeholder instead. Never resizes the node.
 */
export function renderLivePreview(refs, text) {
  if (typeof text !== "string") {
    refs.previewEl.innerHTML =
      '<span class="wsc-preview-empty">' + escapeHtml(PREVIEW_EMPTY_TEXT) + "</span>";
    refs.previewEl.wscRenderedText = undefined;
    return;
  }
  refs.previewEl.innerHTML = escapeHtml(text);
  refs.previewEl.wscRenderedText = text;
}

/**
 * Compute the CLIENT-SIDE scene prose preview from the node's current
 * state: mirrors the backend's `build_scene_text` (via `core.mjs`'s
 * `assembleCharacters`/`assembleBackgroundBlock`/`buildSceneText`)
 * byte-for-byte, using `node._sceneSlots` (populated by the last
 * `onExecuted`; `{}` before any run) as the wired-socket values — so a
 * character/background/outfit whose socket has never resolved falls back to
 * its own appearance/text field, same as a fresh run would render it before
 * any upstream node has ever executed.
 */
export function computeClientSceneText(node, refs) {
  const state = ensureState(node);
  const wired = node._sceneSlots || {};
  const charactersList = assembleCharacters(state.characters, wired);
  const backgroundBlock = assembleBackgroundBlock(state.backgrounds, wired);
  return buildSceneText(refs.templateEl.value, state.fields, charactersList, backgroundBlock);
}

/**
 * Re-render the LIVE PREVIEW from the CLIENT-SIDE computed scene prose
 * (`computeClientSceneText`) — call this after every field/character/
 * background edit so the preview stays live like Prompt Builder's, instead
 * of frozen at the placeholder until the node is actually run. An empty
 * result (`""` — no non-empty scene fields/characters/background yet) shows
 * the placeholder. Never resizes the node. The REAL executed result
 * (`onExecuted`'s `message.text`, wired in `index.js`) always overwrites
 * this immediately after a run; editing anything again afterward recomputes
 * and shows this client-side preview once more.
 */
export function updateComputedPreview(node, refs) {
  const text = computeClientSceneText(node, refs);
  renderLivePreview(refs, text === "" ? undefined : text);
}
