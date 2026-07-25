/**
 * Prompt Rules — the "Pick…" popover (contract: `docs/nodes-and-api.md` §3
 * "Picker popover").
 *
 * A compact modal (house theme, `.wtn` + a scoped `.wtn-pk-*` layout built
 * purely from the existing `--wtn-*` tokens -- no new colors, matching
 * `js/rule_builder/overlay.mjs`'s own "layout-only additions" rule) that:
 *   - fetches `GET /wtn/rules/characters` (`js/shared/api.mjs`'s
 *     `getCharacters()`),
 *   - groups entries by `kind` (`character` / `outfit` / `background` /
 *     `pose` -- `docs/nodes-and-api.md` §2's `/characters` shape),
 *   - lets the user search/filter and pick a `positive`/`negative` insert
 *     target,
 *   - and on a row click, inserts that entry's `token` into the calling
 *     encode node's `positive` or `negative` text widget.
 *
 * Absolute imports for cross-folder modules -- see `./index.js`'s doc
 * comment and `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md`.
 * VERIFY-IN-COMFYUI: assumes this pack is installed as
 * `custom_nodes/ComfyUI-AnimaFlow` -- see `./index.js`'s matching note.
 */
import { injectTheme } from "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";
import { getCharacters } from "/extensions/ComfyUI-AnimaFlow/shared/api.mjs";

// `docs/nodes-and-api.md` §2's `/wtn/rules/characters` kind vocabulary, in
// display order. An entry with any other/missing `kind` still renders --
// see `groupEntries` below -- just outside this preferred ordering, so a
// future server-side kind doesn't silently vanish from the popover.
const KIND_ORDER = ["character", "outfit", "background", "pose"];
const KIND_LABEL = {
  character: "Characters",
  outfit: "Outfits",
  background: "Backgrounds",
  pose: "Poses",
};

// Only one picker instance at a time (mirrors `js/rule_builder/overlay.mjs`'s
// `activeOverlay` singleton).
let activePicker = null;

const CSS_ID = "wtn-pk-css";
function injectPickerCss() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement("style");
  style.id = CSS_ID;
  style.textContent = `
.wtn-pk-scrim {
  position: fixed; inset: 0; z-index: 10001;
  background: rgba(6, 8, 11, 0.66);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 14vh 16px 16px; overflow-y: auto;
}
.wtn-pk-panel {
  width: min(360px, 100%); max-height: 70vh; background: var(--wtn-bg);
  border: 1px solid var(--wtn-line); border-radius: var(--wtn-radius-lg);
  box-shadow: var(--wtn-shadow); padding: 12px; display: flex; flex-direction: column; gap: 9px;
}
.wtn-pk-hd { display: flex; align-items: center; gap: 8px; }
.wtn-pk-title { font-size: 13px; font-weight: 650; margin-right: auto; }
.wtn-pk-search { width: 100%; }
.wtn-pk-list { overflow-y: auto; display: flex; flex-direction: column; gap: 10px; min-height: 40px; }
.wtn-pk-group { display: flex; flex-direction: column; gap: 4px; }
.wtn-pk-group-hd { font-family: var(--wtn-font-mono); font-size: 10.5px; text-transform: uppercase;
  letter-spacing: .07em; color: var(--wtn-ink-faint); padding: 0 2px; }
.wtn-pk-row { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
  background: var(--wtn-surface-2); border: 1px solid var(--wtn-line); border-radius: 8px;
  padding: 7px 10px; cursor: pointer; font-family: var(--wtn-font-ui); color: var(--wtn-ink); }
.wtn-pk-row:hover { border-color: var(--wtn-accent); }
.wtn-pk-row-name { font-size: 12.5px; font-weight: 600; }
.wtn-pk-row-token { margin-left: auto; font-family: var(--wtn-font-mono); font-size: 11px;
  color: var(--wtn-ink-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%; }
.wtn-pk-row-from { font-family: var(--wtn-font-mono); font-size: 10.5px; color: var(--wtn-ink-faint); }
.wtn-pk-empty { padding: 14px 6px; color: var(--wtn-ink-dim); font-size: 12.5px; text-align: center; }
`;
  document.head.appendChild(style);
}

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

/** Groups `entries` by `kind` (defaulting an entry with no/unknown `kind` to
 * `"character"`, the one kind `api/rules_api.py`'s `characters_impl` emits
 * today), keyed in `KIND_ORDER` order first, then any other kinds a future
 * server addition might introduce. */
function groupEntries(entries) {
  const byKind = new Map();
  entries.forEach((entry) => {
    const kind = (entry && entry.kind) || "character";
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(entry);
  });
  const orderedKinds = [
    ...KIND_ORDER.filter((k) => byKind.has(k)),
    ...[...byKind.keys()].filter((k) => !KIND_ORDER.includes(k)),
  ];
  return orderedKinds.map((kind) => ({ kind, entries: byKind.get(kind) }));
}

function matchesSearch(entry, term) {
  if (!term) return true;
  const hay = `${entry.name || ""} ${entry.character || ""} ${entry.token || ""}`.toLowerCase();
  return hay.includes(term);
}

/**
 * Opens the picker popover.
 *
 * @param {{node?: object, getPositiveWidget?: () => object|undefined,
 *   getNegativeWidget?: () => object|undefined, onClose?: () => void}} opts
 *   `node` is only used for `node.setDirtyCanvas` after an insert (so the
 *   node's on-canvas widget repaints its now-changed text immediately);
 *   `getPositiveWidget`/`getNegativeWidget` are re-invoked on every insert
 *   (not read once) so the picker keeps working even if the caller's widget
 *   references were captured before the node fully finished mounting.
 */
export function openPicker({ node, getPositiveWidget, getNegativeWidget, onClose } = {}) {
  if (activePicker) activePicker.close();

  injectTheme();
  injectPickerCss();

  const scrim = document.createElement("div");
  scrim.className = "wtn wtn-pk wtn-pk-scrim";
  const panel = document.createElement("div");
  panel.className = "wtn-pk-panel";
  panel.innerHTML = `
    <div class="wtn-pk-hd">
      <div class="wtn-pk-title">Pick…</div>
      <div class="wtn-seg" data-role="target" role="tablist">
        <button type="button" data-target="positive" aria-pressed="true">positive</button>
        <button type="button" data-target="negative" aria-pressed="false">negative</button>
      </div>
      <button type="button" class="wtn-btn wtn-btn--icon" data-role="close" title="Close (Esc)" style="font-size:16px">✕</button>
    </div>
    <input class="wtn-input wtn-pk-search" data-role="search" placeholder="search characters, outfits…" spellcheck="false">
    <div class="wtn-pk-list" data-role="list"></div>
  `;
  scrim.appendChild(panel);
  document.body.appendChild(scrim);

  const q = (role) => panel.querySelector(`[data-role="${role}"]`);
  const closeBtn = q("close");
  const searchInput = q("search");
  const listEl = q("list");
  const targetSeg = panel.querySelector('[data-role="target"]');

  // ── state ────────────────────────────────────────────────────────────
  let target = "positive"; // or "negative" -- which text widget an insert targets
  let entries = [];
  let loading = true;
  let loadFailed = false;

  function insertToken(entry) {
    const getWidget = target === "negative" ? getNegativeWidget : getPositiveWidget;
    const widget = typeof getWidget === "function" ? getWidget() : null;
    const token = entry && entry.token;
    if (!widget || !token) return;
    const current = String(widget.value || "");
    const trimmedEnd = current.replace(/\s+$/, "");
    // Lightweight insert heuristic (NOT a formal join -- see
    // `.claude/CLAUDE.md`'s prompt-format-agnostic rule, which governs
    // composing-node OUTPUT joins, not this quick single-token convenience
    // insert): append on a fresh line if the text already ends with one
    // (prose profiles' section-per-line convention), otherwise with a
    // comma -- matching Anima/tag-style prompts, and harmless for prose,
    // where a trailing comma-separated activation word still parses fine.
    let next;
    if (!trimmedEnd) next = token;
    else if (/\n$/.test(current)) next = current + token;
    else if (/[,\n]\s*$/.test(trimmedEnd)) next = `${trimmedEnd} ${token}`;
    else next = `${trimmedEnd}, ${token}`;
    widget.value = next;
    if (node && typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  }

  function render() {
    listEl.innerHTML = "";
    if (loading) {
      const msg = el("div", "wtn-pk-empty");
      msg.textContent = "Loading…";
      listEl.appendChild(msg);
      return;
    }
    if (loadFailed) {
      const msg = el("div", "wtn-pk-empty");
      msg.textContent = "Character list unavailable — open the Rule Builder to create one.";
      listEl.appendChild(msg);
      return;
    }
    const term = searchInput.value.trim().toLowerCase();
    const filtered = entries.filter((e) => matchesSearch(e, term));
    if (!filtered.length) {
      const msg = el("div", "wtn-pk-empty");
      msg.textContent = entries.length
        ? "No matches."
        : "No character sheets yet — open the Rule Builder to create one.";
      listEl.appendChild(msg);
      return;
    }
    groupEntries(filtered).forEach(({ kind, entries: kindEntries }) => {
      const group = el("div", "wtn-pk-group");
      const hd = el("div", "wtn-pk-group-hd");
      hd.textContent = KIND_LABEL[kind] || kind;
      group.appendChild(hd);
      kindEntries.forEach((entry) => {
        const row = el("button", "wtn-pk-row");
        row.type = "button";
        const name = el("span", "wtn-pk-row-name");
        name.textContent = entry.name || entry.character || entry.token || "?";
        row.appendChild(name);
        if (entry.token) {
          const token = el("span", "wtn-pk-row-token");
          token.textContent = entry.token;
          row.appendChild(token);
        }
        if (entry.from) row.title = `from ${entry.from}`;
        row.addEventListener("click", () => {
          insertToken(entry);
          close();
        });
        group.appendChild(row);
      });
      listEl.appendChild(group);
    });
  }

  searchInput.addEventListener("input", render);

  targetSeg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      target = btn.dataset.target;
      targetSeg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    });
  });

  closeBtn.addEventListener("click", () => close());

  function onKeydown(e) {
    if (e.key === "Escape") close();
  }
  function onScrimClick(e) {
    if (e.target === scrim) close();
  }
  document.addEventListener("keydown", onKeydown);
  scrim.addEventListener("mousedown", onScrimClick);

  function close() {
    document.removeEventListener("keydown", onKeydown);
    scrim.removeEventListener("mousedown", onScrimClick);
    scrim.remove();
    if (activePicker === handle) activePicker = null;
    if (typeof onClose === "function") onClose();
  }

  const handle = { close, panel };
  activePicker = handle;

  render(); // initial "Loading…" state
  searchInput.focus();

  getCharacters()
    .then((list) => {
      entries = Array.isArray(list) ? list : [];
      loading = false;
      render();
    })
    .catch(() => {
      loading = false;
      loadFailed = true;
      render();
    });

  return handle;
}
