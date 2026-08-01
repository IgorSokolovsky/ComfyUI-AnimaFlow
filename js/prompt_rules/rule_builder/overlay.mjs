/**
 * Rule Builder — the full-screen overlay shell.
 *
 * A scrim + panel modal over the ComfyUI canvas (Esc or a scrim click
 * closes it), housing: the topbar (brand, mode/profile toggles, sheet
 * name, Export YAML), the guide, the two-pane builder (rule cards +
 * live preview/trace), and the Export YAML pane. Ported from
 * `playground/rule-builder.html`, restyled onto the shared `.wtn-*`
 * component vocabulary (see docs/THEME.md); only genuinely overlay-specific
 * LAYOUT is added here, scoped under `.wtn-rb-*` and built purely from
 * existing `--wtn-*` tokens (no new colors).
 *
 * Absolute imports for cross-folder modules — see
 * `docs/nodes-and-api.md` §3 ("State & imports").
 * VERIFY-IN-COMFYUI: assumes this pack is installed as
 * `custom_nodes/ComfyUI-AnimaFlow` (this repo's own folder name) — ComfyUI
 * mounts a pack's `WEB_DIRECTORY` at `/extensions/<that folder name>`. If
 * ever deployed under a different folder name, update this import (and the
 * matching one in `preview.mjs`) to match.
 */
import { injectTheme } from "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";
import * as api from "/extensions/ComfyUI-AnimaFlow/shared/api.mjs";
import { Z_MODAL } from "../../shared/z_layers.mjs";
import {
  mkRule,
  seedRuleset,
  countRules,
  renderRuleList,
  toRuleset,
  fromRuleset,
  toYAML,
} from "./cards.mjs";
import { runPreview, renderTrace, renderErrors, createDebounced } from "./preview.mjs";

// Used only until `GET /wtn/rules/profiles` answers (see `renderProfileSeg`
// below) — matches `docs/nodes-and-api.md` §2's example AND Track A's
// already-shipped `nodes/_rules_helpers.PROFILE_CHOICES` (the node-facing
// subset of `src/prompt_rules/core/profiles.py`'s six engine profiles).
const DEFAULT_PROFILES = ["anima", "illustrious", "flux", "raw"];
const PROFILE_LABEL = {
  anima: "anima · prose",
  illustrious: "illustrious · tags",
  pony: "pony · tags",
  flux: "flux · prose",
  wan: "wan · prose",
  raw: "raw · tags",
};

// Only one Rule Builder instance at a time.
let activeOverlay = null;

const CSS_ID = "wtn-rb-css";
function injectOverlayCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
/* \`Z_MODAL\` (\`js/shared/z_layers.mjs\`), not the bare \`10000\` this used to
   say -- a full-bleed scrim modal, the same tier \`civitai_modal.mjs\` uses.

   Why NOT tied to \`js/prompt_rules/node/picker.mjs\`'s own scrim (was
   \`10001\`, deliberately one above this file's old \`10000\`): that pairing
   assumed the two could never actually coexist, but they can. Both this
   overlay and the picker are reachable INDEPENDENTLY of each other --
   ./index.js registers "AnimaFlow: Rule Builder" as a global \`commands\`
   entry AND mounts a ComfyUI toolbar button (neither gated on any specific
   node), while the picker only opens from a "Pick…" button embedded in one
   encode node's own widget UI -- and NEITHER singleton closes the other
   (\`openRuleBuilder\`'s \`activeOverlay.close()\` only ever closes a previous
   RULE BUILDER instance; \`picker.mjs\`'s own \`activePicker.close()\` is the
   same, self-only). The picker's own \`document.addEventListener("keydown",
   onKeydown)\` only acts on \`Escape\` -- it never calls \`stopPropagation\` --
   so a global keybinding (or the command palette, Settings → Keybindings)
   bound to this overlay's command still fires and opens THIS overlay while
   the picker is already open, with nothing in either file to prevent it.
   That is genuinely reachable, unlike the reverse (this overlay's own
   full-bleed scrim already covers -- and physically blocks clicks on -- the
   very node whose "Pick…" button would be needed to open the picker while
   THIS overlay is open first).

   So they need to sit at DIFFERENT rungs, and this overlay -- the heavier,
   globally-reachable editing surface -- must win: \`Z_MODAL\` here,
   \`Z_PANEL\` on the picker (see that file's own matching comment). Neither
   \`Z_TOOLTIP\` nor \`Z_CONFIRM\` fits either surface (not a hover hint, not a
   destructive confirm), so this is the smallest arrangement available from
   the EXISTING four rungs -- no fifth constant invented. */
.wtn-rb-scrim {
  position: fixed; inset: 0; z-index: ${Z_MODAL};
  background: rgba(6, 8, 11, 0.72);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 26px 16px; overflow-y: auto;
}
.wtn-rb-panel {
  width: min(1240px, 100%); background: var(--wtn-bg);
  border: 1px solid var(--wtn-line); border-radius: var(--wtn-radius-lg);
  box-shadow: var(--wtn-shadow); padding: 16px; display: flex; flex-direction: column; gap: 14px;
}
.wtn-rb-topbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 16px; background: linear-gradient(180deg, var(--wtn-surface-2), var(--wtn-surface));
  border: 1px solid var(--wtn-line); border-radius: var(--wtn-radius-lg); }
.wtn-rb-brand { display: flex; align-items: center; gap: 10px; margin-right: auto; }
.wtn-rb-glyph { width: 26px; height: 26px; border-radius: 8px; flex: none;
  background: radial-gradient(circle at 30% 30%, var(--wtn-accent), var(--wtn-accent-deep));
  box-shadow: 0 0 16px rgba(45,212,191,.35); }
.wtn-rb-brand h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -.02em; }
.wtn-rb-brand .wtn-rb-sub { font-size: 11.5px; color: var(--wtn-ink-dim); }
.wtn-rb-sheet-name { width: 150px; }

.wtn-rb-sheetbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 2px; }
.wtn-rb-sheetbar select { max-width: 220px; }
.wtn-rb-status { min-height: 18px; }

.wtn-rb-panes { display: grid; grid-template-columns: 1.15fr .85fr; gap: 14px; align-items: start; }
@media (max-width: 900px) { .wtn-rb-panes { grid-template-columns: 1fr; } }

.wtn-rb-rules { display: flex; flex-direction: column; gap: 10px; }
.wtn-rb-rule { background: var(--wtn-surface-2); border: 1px solid var(--wtn-line);
  border-radius: 11px; border-left: 3px solid var(--rb-tone, var(--wtn-ink-faint)); }
.wtn-rb-rule[data-type="group"]  { --rb-tone: var(--wtn-info); }
.wtn-rb-rule[data-type="switch"] { --rb-tone: var(--wtn-tmp); }
.wtn-rb-rule[data-type="swap"]   { --rb-tone: var(--wtn-warn); }
.wtn-rb-rule[data-type="tag"]    { --rb-tone: var(--wtn-accent); }
.wtn-rb-rule-hd { display: flex; align-items: center; gap: 8px; padding: 9px 11px; flex-wrap: wrap; }
.wtn-rb-rule-body { padding: 0 11px 11px; display: flex; flex-direction: column; gap: 8px; }
.wtn-rb-children { margin: 2px 0 0 10px; padding-left: 11px; border-left: 1px dashed var(--wtn-line);
  display: flex; flex-direction: column; gap: 9px; }
.wtn-rb-type-pill { font-family: var(--wtn-font-mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .07em; color: var(--rb-tone, var(--wtn-ink-faint)); border: 1px solid var(--rb-tone, var(--wtn-line));
  opacity: .85; border-radius: 999px; padding: 2px 7px; flex: none; }
.wtn-rb-name-input { flex: 1; min-width: 40px; background: transparent; border: none; color: var(--wtn-ink);
  font-family: var(--wtn-font-ui); font-weight: 600; font-size: 13px; padding: 4px; }
.wtn-rb-name-input::placeholder { color: var(--wtn-ink-faint); font-weight: 400; }
.wtn-rb-name-input:focus { outline: none; }
.wtn-rb-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wtn-rb-row .wtn-label { width: 46px; flex: none; }
.wtn-rb-mut select { width: 116px; flex: none; }
.wtn-rb-grow { flex: 1; min-width: 0; }
.wtn-rb-add-inline { align-self: flex-start; font-family: var(--wtn-font-ui); font-size: 12px;
  color: var(--wtn-ink-dim); background: transparent; border: 1px dashed var(--wtn-line);
  border-radius: 7px; padding: 5px 10px; cursor: pointer; }
.wtn-rb-add-inline:hover { border-color: var(--wtn-accent); color: var(--wtn-accent); }
.wtn-rb-default-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--wtn-ink-dim); }
.wtn-rb-default-toggle input { accent-color: var(--wtn-tmp); }
.wtn-rb-add-row { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }

.wtn-rb-stack { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.wtn-rb-out { font-family: var(--wtn-font-mono); font-size: 12.5px; line-height: 1.6; white-space: pre-wrap;
  word-break: break-word; background: var(--wtn-console); border: 1px solid var(--wtn-line);
  border-radius: var(--wtn-radius-sm); padding: 10px 12px; min-height: 24px; }
.wtn-rb-out:empty::before { content: "— empty —"; color: var(--wtn-ink-faint); }
.wtn-rb-out--pos { border-color: rgba(74,222,128,.3); }
.wtn-rb-out--neg { border-color: rgba(248,113,113,.3); }
.wtn-rb-errors:empty { display: none; }

.wtn-rb-guide { max-width: 780px; }
.wtn-rb-guide h3 { color: var(--wtn-ink); font-size: 13px; margin: 16px 0 6px; letter-spacing: .02em;
  text-transform: uppercase; font-family: var(--wtn-font-mono); }
.wtn-rb-guide p { margin: 6px 0; }
.wtn-rb-guide table { border-collapse: collapse; width: 100%; margin: 8px 0; }
.wtn-rb-guide td { border-top: 1px solid var(--wtn-line); padding: 7px 10px; vertical-align: top; font-size: 12.5px; }
.wtn-rb-guide td:first-child { font-family: var(--wtn-font-mono); color: var(--wtn-accent); white-space: nowrap; width: 84px; }
.wtn-rb-guide ol, .wtn-rb-guide ul { margin: 6px 0; padding-left: 20px; }
.wtn-rb-guide li { margin: 5px 0; }
.wtn-rb-legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 7px 18px; margin: 10px 0; }
.wtn-rb-legend span { font-family: var(--wtn-font-mono); font-size: 12px; display: flex; align-items: center; gap: 9px; color: var(--wtn-ink); }
.wtn-rb-dot { width: 10px; height: 10px; border-radius: 3px; flex: none; display: inline-block; }

.wtn-rb-export-actions { display: flex; align-items: center; gap: 8px; }
`;
  document.head.appendChild(style);
}

// ── guide content (ported from playground/rule-builder.html) ──────────────
function guideHTML() {
  return `
<details class="wtn-collapse">
  <summary>How to use this <span style="margin-left:auto;font-family:var(--wtn-font-mono);font-size:11px;color:var(--wtn-ink-faint);font-weight:400">new here? start here</span></summary>
  <div class="wtn-collapse__bd wtn-rb-guide">
    <p>You write <b>rules</b> that rewrite a prompt <i>before</i> it's encoded. Define your
    character once — her hair, eyes, outfits, the conditions they appear under — and the engine
    transforms a short prompt into the full one, every time.</p>

    <h3>Quick start</h3>
    <ol>
      <li>Pick a <b>profile</b> (top bar) — which model family this ruleset targets.</li>
      <li>Edit the <b>rules</b> on the left — the seeded <code>celica</code> example is a working start.</li>
      <li>Type a test prompt in <b>Input · positive</b>; the <b>Output</b> and <b>trace</b> update live.</li>
      <li>Hit <b>Export YAML</b>, or <b>Save</b> a file sheet — that's what the ComfyUI node loads.</li>
    </ol>

    <h3>Every rule is four ideas</h3>
    <ul>
      <li><code>when</code> — the condition that <b>gates</b> the rule (e.g. <code>any_of: celica</code>). <code>always</code> = no condition.</li>
      <li><code>into</code> — <b>where</b> new tags go: a section like <code>clothes</code>, or <code>*</code> for the single tag list.</li>
      <li><b>mutation</b> — <b>what</b> it does: <code>add</code>, <code>add_negative</code>, <code>remove</code>, <code>set</code>, <code>tmp</code>.</li>
      <li>Rules run <b>top → bottom</b>; groups and switches nest.</li>
    </ul>

    <h3>Rule types</h3>
    <table>
      <tr><td>tag</td><td>Add / remove / set tags. The everyday rule.</td></tr>
      <tr><td>group</td><td>Run <b>all</b> child rules under one shared <code>when</code> + <code>into</code>. Keeps related rules together.</td></tr>
      <tr><td>switch</td><td>Run the <b>first</b> matching child, else the <code>default</code>. Mutually-exclusive — perfect for picking an outfit.</td></tr>
      <tr><td>swap</td><td>Replace a placeholder tag with expanded tags at its position.</td></tr>
    </table>

    <h3>Conditions (when)</h3>
    <table>
      <tr><td>any_of</td><td>fires if <b>at least one</b> listed tag is in the prompt</td></tr>
      <tr><td>all_of</td><td>fires only if <b>all</b> are present</td></tr>
      <tr><td>none_of</td><td>fires only if <b>none</b> are present</td></tr>
      <tr><td>always</td><td>no condition — always fires</td></tr>
    </table>

    <h3>Mutations</h3>
    <table>
      <tr><td>add</td><td>append to the positive prompt (<b>deduped</b> — never doubles a tag)</td></tr>
      <tr><td>add_negative</td><td>append to the negative prompt</td></tr>
      <tr><td>remove</td><td>drop a tag — stays visible to later rules, gone from output</td></tr>
      <tr><td>set</td><td>overwrite a whole section (prose profiles)</td></tr>
      <tr><td>tmp</td><td>temporary tag: visible to later rules, not rendered</td></tr>
    </table>

    <h3>Reading the trace</h3>
    <p>The trace shows <i>exactly</i> what fired and why — the engine's killer feature:</p>
    <div class="wtn-rb-legend">
      <span><i class="wtn-rb-dot" style="background:var(--wtn-info)"></i>&gt; group / switch</span>
      <span><i class="wtn-rb-dot" style="background:var(--wtn-accent)"></i>$ tag / swap</span>
      <span><i class="wtn-rb-dot" style="background:var(--wtn-ink-faint)"></i>? condition result</span>
      <span><i class="wtn-rb-dot" style="background:var(--wtn-ok)"></i>+ added</span>
      <span><i class="wtn-rb-dot" style="background:var(--wtn-bad)"></i>- removed</span>
      <span><i class="wtn-rb-dot" style="background:var(--wtn-warn)"></i>= set</span>
      <span><i class="wtn-rb-dot" style="background:var(--wtn-tmp)"></i>~ temporary</span>
      <span><i class="wtn-rb-dot" style="background:var(--wtn-ink-faint)"></i>x skipped</span>
    </div>

    <h3>Pro tip</h3>
    <p>Put your character's <b>activation word</b> (e.g. <code>celica</code>) in the prompt to fire her
    rules — then add a <code>remove: celica</code> rule so the name never reaches the model. A
    <b>Pick…</b> button on the encode node inserts that word for you.</p>
  </div>
</details>`;
}

function panelSkeleton() {
  return `
<div class="wtn-rb-topbar">
  <div class="wtn-rb-brand">
    <div class="wtn-rb-glyph"></div>
    <div>
      <h2>Rule Builder</h2>
      <div class="wtn-rb-sub">character sheet → prompt transform</div>
    </div>
  </div>
  <div class="wtn-seg" data-role="mode" role="tablist">
    <button type="button" data-mode="sheet" aria-pressed="true">File sheet</button>
    <button type="button" data-mode="embedded" aria-pressed="false">Embedded</button>
  </div>
  <input class="wtn-input wtn-rb-sheet-name" data-role="sheet-name" placeholder="sheet name" spellcheck="false">
  <div class="wtn-seg" data-role="profile" role="tablist"></div>
  <button type="button" class="wtn-btn" data-role="export-btn">Export YAML</button>
  <button type="button" class="wtn-btn wtn-btn--icon" data-role="close" title="Close (Esc)" style="font-size:18px">✕</button>
</div>

<div class="wtn-rb-row wtn-rb-sheetbar" data-role="sheetbar">
  <select class="wtn-select" data-role="sheet-select"></select>
  <button type="button" class="wtn-btn wtn-btn--icon" data-role="refresh-sheets" title="Refresh sheet list">↻</button>
  <button type="button" class="wtn-btn" data-role="load-sheet">Load</button>
  <button type="button" class="wtn-btn wtn-btn--primary" data-role="save-sheet">Save</button>
  <span class="wtn-chip wtn-rb-status" data-role="sheet-status"></span>
</div>
<div class="wtn-rb-row" data-role="embeddedbar" style="display:none">
  <button type="button" class="wtn-btn wtn-btn--primary" data-role="apply-embedded">Apply to node</button>
  <span class="wtn-chip wtn-rb-status" data-role="embedded-status"></span>
</div>

${guideHTML()}

<div class="wtn-rb-panes">
  <div class="wtn-card">
    <div class="wtn-card__hd"><h3>Rules</h3><span class="meta" data-role="rule-count"></span></div>
    <div class="wtn-card__bd">
      <div class="wtn-rb-rules" data-role="rules-host"></div>
      <div class="wtn-rb-add-row">
        <button type="button" class="wtn-btn wtn-btn--primary" data-add="tag">+ Rule</button>
        <button type="button" class="wtn-btn" data-add="group">+ Group</button>
        <button type="button" class="wtn-btn" data-add="switch">+ Switch</button>
        <button type="button" class="wtn-btn" data-add="swap">+ Swap</button>
      </div>
    </div>
  </div>

  <div class="wtn-card">
    <div class="wtn-card__hd"><h3>Live preview</h3><span class="meta" data-role="engine-badge"></span></div>
    <div class="wtn-card__bd">
      <div class="wtn-rb-stack">
        <div class="wtn-label">Input · positive</div>
        <textarea class="wtn-textarea" rows="2" data-role="in-pos" spellcheck="false">1girl, celica, jacket, smile</textarea>
        <div class="wtn-label">Input · negative</div>
        <textarea class="wtn-textarea" rows="1" data-role="in-neg" spellcheck="false">sketch</textarea>
      </div>
      <div class="wtn-rb-stack">
        <div class="wtn-label">Output · positive</div>
        <div class="wtn-rb-out wtn-rb-out--pos" data-role="out-pos"></div>
        <div class="wtn-label">Output · negative</div>
        <div class="wtn-rb-out wtn-rb-out--neg" data-role="out-neg"></div>
      </div>
      <div class="wtn-log wtn-rb-errors" data-role="errors"></div>
      <details class="wtn-collapse" open>
        <summary>trace — why each rule fired</summary>
        <div class="wtn-collapse__bd wtn-log" data-role="trace"></div>
      </details>
    </div>
  </div>
</div>

<div class="wtn-card" data-role="export-pane" style="display:none">
  <div class="wtn-card__hd">
    <h3>Ruleset · YAML</h3>
    <div class="wtn-rb-export-actions" style="margin-left:auto">
      <button type="button" class="wtn-btn" data-role="copy-yaml">Copy</button>
      <button type="button" class="wtn-btn wtn-btn--icon" data-role="close-export" style="font-size:18px">✕</button>
    </div>
  </div>
  <div class="wtn-card__bd"><div class="wtn-rb-out" data-role="export-out" style="white-space:pre; overflow-x:auto"></div></div>
</div>`;
}

// ── tooltip controller (generic — delegates on any [data-tip], regardless
// of which module produced it; see cards.mjs's TIP dict) ───────────────────
function installTooltip(root) {
  const tip = document.createElement("div");
  tip.className = "wtn-tip";
  document.body.appendChild(tip);

  const show = (el) => {
    tip.innerHTML = el.dataset.tip;
    tip.classList.add("show");
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    let left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
    let top = r.top - t.height - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const hide = () => tip.classList.remove("show");
  const onOver = (e) => { const el = e.target.closest("[data-tip]"); if (el) show(el); };
  const onOut = (e) => { if (e.target.closest("[data-tip]")) hide(); };
  const onScroll = () => hide();

  root.addEventListener("mouseover", onOver);
  root.addEventListener("mouseout", onOut);
  document.addEventListener("scroll", onScroll, true);

  return () => {
    root.removeEventListener("mouseover", onOver);
    root.removeEventListener("mouseout", onOut);
    document.removeEventListener("scroll", onScroll, true);
    tip.remove();
  };
}

/**
 * @typedef {Object} RuleBuilderCtx
 * @property {"sheet"|"embedded"} [mode] - which mode to open in (default:
 *   "embedded" if `embedded` is given, else "sheet")
 * @property {string} [sheetName] - initial file-sheet name (sheet mode)
 * @property {object|string} [embedded] - initial embedded ruleset (a real
 *   Ruleset object, or its JSON-stringified form — matches an encode node's
 *   `embedded_rules` STRING-widget value) (embedded mode)
 * @property {string} [profile] - initial profile id
 * @property {string} [positive] - initial positive test prompt
 * @property {string} [negative] - initial negative test prompt
 * @property {(ruleset: object) => void} [onApply] - called with the current
 *   ruleset (see `cards.mjs`'s `toRuleset`) when the user clicks
 *   "Apply to node" in embedded mode. This is how a future encode node
 *   (Track A) writes the result back into its `embedded_rules` widget; not
 *   called in sheet mode (sheets persist via Save, not Apply).
 * @property {() => void} [onClose] - called when the overlay closes.
 */

/** Opens the Rule Builder overlay. Closes any already-open instance first
 * (single overlay at a time). See `RuleBuilderCtx` above for `ctx`. */
export function openRuleBuilder(ctx = {}) {
  if (activeOverlay) activeOverlay.close();

  injectTheme();
  injectOverlayCss();

  const scrim = document.createElement("div");
  scrim.className = "wtn wtn-rb wtn-rb-scrim";
  const panel = document.createElement("div");
  panel.className = "wtn-rb-panel";
  panel.innerHTML = panelSkeleton();
  scrim.appendChild(panel);
  document.body.appendChild(scrim);

  const q = (role) => panel.querySelector(`[data-role="${role}"]`);
  const closeBtn = q("close");
  const modeSeg = panel.querySelector('[data-role="mode"]');
  const profileSeg = q("profile");
  const sheetNameInput = q("sheet-name");
  const sheetbar = q("sheetbar");
  const embeddedbar = q("embeddedbar");
  const sheetSelect = q("sheet-select");
  const sheetStatus = q("sheet-status");
  const embeddedStatus = q("embedded-status");
  const rulesHost = q("rules-host");
  const ruleCountEl = q("rule-count");
  const inPos = q("in-pos");
  const inNeg = q("in-neg");
  const outPos = q("out-pos");
  const outNeg = q("out-neg");
  const errorsEl = q("errors");
  const traceEl = q("trace");
  const engineBadge = q("engine-badge");
  const exportBtn = q("export-btn");
  const exportPane = q("export-pane");
  const exportOut = q("export-out");

  // ── state ─────────────────────────────────────────────────────────────
  let initialEmbedded = ctx.embedded;
  if (typeof initialEmbedded === "string") {
    try { initialEmbedded = JSON.parse(initialEmbedded); } catch { initialEmbedded = null; }
  }
  const initialRules = initialEmbedded ? fromRuleset(initialEmbedded) : [];

  const state = {
    mode: ctx.mode || (initialEmbedded ? "embedded" : "sheet"),
    sheetName: ctx.sheetName || "",
    profile: ctx.profile || DEFAULT_PROFILES[0],
    rules: initialRules.length ? initialRules : seedRuleset(),
    positive: ctx.positive != null ? ctx.positive : inPos.value,
    negative: ctx.negative != null ? ctx.negative : inNeg.value,
  };
  sheetNameInput.value = state.sheetName;
  inPos.value = state.positive;
  inNeg.value = state.negative;

  // ── rule tree ─────────────────────────────────────────────────────────
  // `renderRuleList` itself re-invokes its OWN closure (`rerender`, from
  // cards.mjs) on a structural change — `rebuildRulesTree` is only needed
  // here for a change that isn't a card-tree edit at all (profile switch,
  // sheet load, add-rule-row buttons), so `onChange` below never calls it
  // again itself (that would double-render every structural card edit).
  function rebuildRulesTree() {
    renderRuleList(rulesHost, state.rules, {
      profile: state.profile,
      onChange: () => {
        ruleCountEl.textContent = `${countRules(state.rules)} rules`;
        schedulePreview();
      },
    });
    ruleCountEl.textContent = `${countRules(state.rules)} rules`;
  }

  panel.querySelectorAll("[data-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.rules.push(mkRule(btn.dataset.add));
      rebuildRulesTree();
      schedulePreview();
    });
  });

  // ── live preview ──────────────────────────────────────────────────────
  async function runPreviewNow() {
    const result = await runPreview({
      rules: state.rules,
      profile: state.profile,
      positive: inPos.value,
      negative: inNeg.value,
      embedded: toRuleset(state.rules, state.profile),
    });
    outPos.textContent = result.positive || "";
    outNeg.textContent = result.negative || "";
    renderTrace(traceEl, result.trace);
    renderErrors(errorsEl, result.errors);
    if (result.engine === "offline") {
      engineBadge.innerHTML = '<span class="wtn-chip wtn-chip--warn">engine offline · preview approximate</span>';
    } else {
      engineBadge.textContent = "";
    }
    if (exportPane.style.display !== "none") exportOut.textContent = toYAML(state.rules, state.profile);
  }
  const schedulePreview = createDebounced(runPreviewNow, 250);

  inPos.addEventListener("input", () => { state.positive = inPos.value; schedulePreview(); });
  inNeg.addEventListener("input", () => { state.negative = inNeg.value; schedulePreview(); });

  // ── profile toggle ────────────────────────────────────────────────────
  function renderProfileSeg(profiles) {
    profileSeg.innerHTML = "";
    profiles.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.p = p;
      btn.setAttribute("aria-pressed", String(p === state.profile));
      btn.textContent = PROFILE_LABEL[p] || p;
      btn.addEventListener("click", () => {
        state.profile = p;
        profileSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        rebuildRulesTree();
        schedulePreview.flush();
      });
      profileSeg.appendChild(btn);
    });
  }
  renderProfileSeg(DEFAULT_PROFILES);
  api.getProfiles().then((list) => {
    if (Array.isArray(list) && list.length) renderProfileSeg(list);
  }).catch(() => { /* keep the default list — profiles route not up yet */ });

  // ── mode toggle (file sheet vs embedded) ────────────────────────────────
  function applyModeVisibility() {
    modeSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode)));
    const isSheet = state.mode === "sheet";
    sheetNameInput.style.display = isSheet ? "" : "none";
    sheetbar.style.display = isSheet ? "" : "none";
    embeddedbar.style.display = isSheet ? "none" : "";
  }
  modeSeg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => { state.mode = btn.dataset.mode; applyModeVisibility(); });
  });
  applyModeVisibility();
  if (!ctx.onApply) {
    const applyBtn = q("apply-embedded");
    applyBtn.disabled = true;
    applyBtn.title = "No node context — open this via an encode node's \"Open Rule Builder\" button to apply.";
  }
  q("apply-embedded").addEventListener("click", () => {
    if (!ctx.onApply) return;
    ctx.onApply(toRuleset(state.rules, state.profile));
    embeddedStatus.textContent = "Applied ✓";
    embeddedStatus.className = "wtn-chip wtn-rb-status wtn-chip--ok";
  });

  // ── file sheets (degrades gracefully if the route isn't up yet) ────────
  function setSheetStatus(text, kind) {
    sheetStatus.textContent = text || "";
    sheetStatus.className = `wtn-chip wtn-rb-status${kind ? ` wtn-chip--${kind}` : ""}`;
  }
  async function refreshSheetsList() {
    try {
      const sheets = await api.listSheets();
      sheetSelect.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = sheets && sheets.length ? "Load existing…" : "No sheets yet";
      sheetSelect.appendChild(placeholder);
      (sheets || []).forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.name;
        opt.textContent = s.character ? `${s.name} (${s.character})` : s.name;
        sheetSelect.appendChild(opt);
      });
      sheetSelect.disabled = false;
      setSheetStatus("");
    } catch {
      sheetSelect.innerHTML = '<option value="">sheets unavailable</option>';
      sheetSelect.disabled = true;
      setSheetStatus("sheets API offline", "warn");
    }
  }
  async function loadSheetByName(name) {
    if (!name) return;
    try {
      const res = await api.getSheet(name);
      const loaded = fromRuleset(res && res.ruleset);
      state.rules = loaded.length ? loaded : seedRuleset();
      state.sheetName = res && res.name ? res.name : name;
      sheetNameInput.value = state.sheetName;
      rebuildRulesTree();
      schedulePreview.flush();
      setSheetStatus("Loaded ✓", "ok");
    } catch (err) {
      setSheetStatus(`load failed: ${err && err.message ? err.message : err}`, "bad");
    }
  }
  q("refresh-sheets").addEventListener("click", () => refreshSheetsList());
  sheetSelect.addEventListener("change", () => { if (sheetSelect.value) loadSheetByName(sheetSelect.value); });
  q("load-sheet").addEventListener("click", () => loadSheetByName(sheetNameInput.value.trim()));
  q("save-sheet").addEventListener("click", async () => {
    const name = sheetNameInput.value.trim();
    if (!name) { setSheetStatus("name a sheet first", "warn"); return; }
    try {
      const res = await api.saveSheet(name, toRuleset(state.rules, state.profile));
      if (res && res.ok) {
        setSheetStatus("Saved ✓", "ok");
        state.sheetName = name;
        refreshSheetsList();
      } else {
        const first = res && res.errors && res.errors[0];
        setSheetStatus(first ? `${first.path}: ${first.message}` : "save rejected", "bad");
        renderErrors(errorsEl, res && res.errors);
      }
    } catch (err) {
      setSheetStatus(`save failed: ${err && err.message ? err.message : err}`, "bad");
    }
  });
  refreshSheetsList();
  if (state.sheetName) loadSheetByName(state.sheetName);

  // ── export YAML pane ─────────────────────────────────────────────────
  exportBtn.addEventListener("click", () => {
    exportPane.style.display = "block";
    exportOut.textContent = toYAML(state.rules, state.profile);
    exportPane.scrollIntoView({ behavior: "smooth" });
  });
  q("close-export").addEventListener("click", () => { exportPane.style.display = "none"; });
  q("copy-yaml").addEventListener("click", async () => {
    const copyBtn = q("copy-yaml");
    try {
      await navigator.clipboard.writeText(toYAML(state.rules, state.profile));
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1400);
    } catch { /* clipboard not available — silently ignore, matches playground */ }
  });

  // ── close / lifecycle ────────────────────────────────────────────────
  const uninstallTooltip = installTooltip(panel);
  function onKeydown(e) {
    if (e.key === "Escape") close();
  }
  function onScrimClick(e) {
    if (e.target === scrim) close();
  }
  document.addEventListener("keydown", onKeydown);
  scrim.addEventListener("mousedown", onScrimClick);
  closeBtn.addEventListener("click", () => close());

  function close() {
    schedulePreview.cancel();
    document.removeEventListener("keydown", onKeydown);
    scrim.removeEventListener("mousedown", onScrimClick);
    uninstallTooltip();
    scrim.remove();
    if (activeOverlay === handle) activeOverlay = null;
    if (typeof ctx.onClose === "function") ctx.onClose();
  }

  const handle = { close, panel, state };
  activeOverlay = handle;

  rebuildRulesTree();
  schedulePreview.flush();

  return handle;
}
