/**
 * Rule Builder — live preview + trace.
 *
 * Primary path: `POST /wtn/rules/preview` (see `docs/nodes-and-api.md` §2 /
 * `api/rules_api.py`, Track A). Offline fallback: a faithful port of the
 * simplified engine embedded in `playground/rule-builder.html`'s
 * `<script>` — it is NOT the real clean-room engine (`core/`), just enough
 * to make the builder demo-able / usable before Track A lands. Whichever
 * path ran, the caller can tell from the returned `engine` field
 * (`"server"` | `"offline"`).
 *
 * Absolute import for the cross-folder shared module — see
 * `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` and
 * `docs/nodes-and-api.md` §3 ("State & imports").
 * VERIFY-IN-COMFYUI: this assumes the custom-node package is installed under
 * `custom_nodes/ComfyUI-AnimaFlow` (this repo's own folder name), since
 * ComfyUI mounts a pack's `WEB_DIRECTORY` at `/extensions/<that folder name>`.
 * If the deployed folder is ever renamed, this path (and the matching one in
 * `overlay.mjs`) must be updated to match.
 */
import * as api from "/extensions/ComfyUI-AnimaFlow/shared/api.mjs";
import { profileFamily } from "./cards.mjs";

// ── ported offline engine (Document = [{label, items:[{text,enabled}]}]) ──
function splitItems(s) {
  return (s || "")
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => ({ text: t, enabled: true }));
}

function parseDoc(text, family) {
  if (family !== "prose") return [{ label: "", items: splitItems(text) }];
  const blocks = [];
  const base = { label: "", items: [] };
  (text || "").split("\n").forEach((line) => {
    const m = line.match(/^\s*([\w][\w :\-]*?):\s*(.*)$/);
    if (m) blocks.push({ label: m[1].trim(), items: splitItems(m[2]) });
    else base.items.push(...splitItems(line));
  });
  return [base, ...blocks];
}

function renderDoc(doc, family) {
  if (family !== "prose") {
    return doc.flatMap((b) => b.items).filter((i) => i.enabled).map((i) => i.text).join(", ");
  }
  return doc
    .map((b) => {
      const items = b.items.filter((i) => i.enabled).map((i) => i.text);
      if (!items.length) return null;
      return b.label ? `${b.label}: ${items.join(", ")}` : items.join(", ");
    })
    .filter(Boolean)
    .join("\n");
}

const lastSeg = (s) => (s || "").split("/").filter(Boolean).pop() || "";

function findBlock(doc, label, create) {
  const l = lastSeg(label);
  if (!l || l === "*") return doc[0];
  let b = doc.find((x) => x.label === l);
  if (!b && create) { b = { label: l, items: [] }; doc.push(b); }
  return b;
}

const norm = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();

function mentions(doc, phrase) {
  const p = norm(phrase);
  if (!p) return false;
  const hay = " " + doc.flatMap((b) => b.items).map((i) => norm(i.text)).join(" , ") + " ";
  return new RegExp("(^|[ ,])" + p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([ ,]|$)").test(hay);
}

function condTags(s) {
  return (s || "").split(",").map((t) => t.trim()).filter(Boolean);
}

function evalCond(cond, doc, T) {
  if (cond.mode === "always") return true;
  const tags = condTags(cond.tags);
  let r;
  if (cond.mode === "any_of") r = tags.some((t) => mentions(doc, t));
  else if (cond.mode === "all_of") r = tags.every((t) => mentions(doc, t));
  else r = !tags.some((t) => mentions(doc, t)); // none_of
  T("cond", `${cond.mode}(${cond.tags}) = ${r}`);
  return r;
}

function addItems(block, value, disabled) {
  splitItems(value).forEach(({ text }) => {
    const ex = block.items.find((i) => norm(i.text) === norm(text));
    if (ex) { if (!disabled) ex.enabled = true; }
    else block.items.push({ text, enabled: !disabled });
  });
}

function removeItems(doc, value) {
  splitItems(value).forEach(({ text }) =>
    doc.forEach((b) => b.items.forEach((i) => { if (norm(i.text) === norm(text)) i.enabled = false; })));
}

function makeTracer(lines) {
  let depth = 0;
  const T = (kind, text) => lines.push({ depth, kind, text });
  T.child = (fn) => { depth += 1; try { fn(); } finally { depth -= 1; } };
  return T;
}

function runBody(rule, pos, neg, into, T) {
  (rule.muts || []).forEach((m) => {
    if (!m.value && m.op !== "remove") return;
    const target = m.section || into;
    if (m.op === "add") {
      addItems(findBlock(pos, target, true), m.value, false);
      T("add", `[${lastSeg(target) || "*"}] ${m.value}`);
    } else if (m.op === "add_negative") {
      addItems(findBlock(neg, target, true), m.value, false);
      T("add", `negative [${lastSeg(target) || "*"}] ${m.value}`);
    } else if (m.op === "remove") {
      removeItems(pos, m.value);
      T("remove", m.value);
    } else if (m.op === "set") {
      const b = findBlock(pos, target, true);
      b.items = [];
      addItems(b, m.value, false);
      T("set", `[${lastSeg(target) || "*"}] ${m.value}`);
    } else if (m.op === "tmp") {
      addItems(findBlock(pos, target, true), m.value, true);
      addItems(findBlock(neg, target, true), m.value, true);
      T("tmp", m.value);
    }
  });
}

function runRule(rule, pos, neg, intoInherit, T) {
  const into = rule.into || intoInherit || "";
  if (!evalCond(rule.cond, pos, T)) { T("skip", "skipped"); return false; }

  if (rule.type === "group") {
    T("group", `group${rule.name ? ` (${rule.name})` : ""}`);
    rule.children.forEach((c) => T.child(() => runRule(c, pos, neg, into, T)));
    return true;
  }
  if (rule.type === "switch") {
    T("group", `switch${rule.name ? ` (${rule.name})` : ""}`);
    const def = rule.children.find((c) => c.isDefault);
    for (const c of rule.children) {
      if (c.isDefault) continue;
      let hit = false;
      T.child(() => {
        if (evalCond(c.cond, pos, T)) { hit = true; runBody(c, pos, neg, into, T); }
        else T("skip", "skipped");
      });
      if (hit) return true;
    }
    if (def) T.child(() => { T("tag", "default"); runBody(def, pos, neg, into, T); });
    return true;
  }
  if (rule.type === "swap") {
    const hit = condTags(rule.match).find((t) => mentions(pos, t));
    T("tag", `swap${rule.name ? ` (${rule.name})` : ""} match(${rule.match}) = ${hit || "—"}`);
    if (!hit) { T("skip", "no match"); return false; }
    removeItems(pos, hit);
    if (rule.addv) { addItems(findBlock(pos, into, true), rule.addv, false); T("add", rule.addv); }
    return true;
  }
  // tag
  T("tag", `tag${rule.name ? ` (${rule.name})` : ""}`);
  runBody(rule, pos, neg, into, T);
  return true;
}

/** Runs the offline (approximate) engine over `rules`, returning the same
 * shape the server route would: `{positive, negative, trace, errors}` plus
 * `engine:"offline"`. `trace` entries are `{depth, kind, text}` — see
 * `prompt-rules/SCHEMA.md` §8 for the kind vocabulary this maps onto
 * (`group|tag|cond|add|remove|set|tmp|skip|anchor`); a few offline-only
 * markers (e.g. a fired switch-default) are approximated onto the nearest
 * kind since they don't have a dedicated one. */
export function runOffline(rules, profile, positiveText, negativeText) {
  const family = profileFamily(profile);
  const pos = parseDoc(positiveText, family);
  const neg = parseDoc(negativeText, family);
  const lines = [];
  const T = makeTracer(lines);
  (rules || []).forEach((r) => runRule(r, pos, neg, "", T));
  return {
    positive: renderDoc(pos, family),
    negative: renderDoc(neg, family),
    trace: lines,
    errors: [],
    engine: "offline",
  };
}

/**
 * Tries the real `/wtn/rules/preview` route first; on any failure (network
 * error, non-2xx, or the route not existing yet) falls back to the offline
 * engine and tags the result so the caller can show the
 * "engine offline · preview approximate" badge.
 *
 * @param {{rules:object[], profile:string, positive:string, negative:string,
 *   sheets?:string[], embedded?:object}} args
 */
export async function runPreview({ rules, profile, positive, negative, sheets, embedded }) {
  // Preview isolation (docs/nodes-and-api.md §3, Track A/B seam): the
  // builder's ONLY caller (`overlay.mjs`) is always previewing the ruleset
  // currently under edit in the card tree -- whether that ruleset will end
  // up saved as a file sheet or applied as an encode node's `embedded_rules`
  // -- never the already-saved file sheets on disk. Sending an explicit
  // empty `sheets` list tells the server "skip file sheets entirely" (see
  // `api/rules_api.py`'s `_sheets_payload_to_selector`: `None`/absent instead
  // defaults to "all enabled file sheets", which would stack every saved
  // sheet on top of the ruleset under edit and produce a misleading preview
  // -- e.g. editing a brand-new sheet would still show OTHER characters'
  // rules firing). `embedded !== undefined` is how a preview-of-the-current-
  // ruleset call is distinguished from a hypothetical future caller that
  // legitimately wants the real file-sheet stack (which would omit
  // `embedded` and pass its own `sheets` through untouched).
  const sheetsForPreview = embedded !== undefined ? [] : sheets;
  try {
    const res = await api.preview({ positive, negative, profile, sheets: sheetsForPreview, embedded });
    return { positive: "", negative: "", trace: [], errors: [], ...res, engine: "server" };
  } catch (err) {
    const offline = runOffline(rules, profile, positive, negative);
    return { ...offline, offlineReason: err && err.message ? err.message : String(err) };
  }
}

// ── trace rendering (into a `.wtn-log` element; see docs/THEME.md's log/trace
// component and its `.is-*` line classes) ──────────────────────────────────
const KIND_CLASS = {
  group: "is-info", tag: "is-accent", cond: "is-dim", add: "is-ok",
  remove: "is-bad", set: "is-warn", tmp: "is-tmp", skip: "is-dim", anchor: "is-warn",
};
const KIND_MARK = {
  group: ">", tag: "$", cond: "?", add: "+", remove: "-", set: "=", tmp: "~", skip: "x", anchor: "=",
};
// `core/engine.py`'s real `emit(depth, kind, text)` calls (Track A, verified
// via `grep emit(` there) use a slightly different -- and larger -- kind
// vocabulary than the ORIGINAL offline-engine port above and the guide's
// legend in `overlay.mjs` (`condition`/`switch`/`swap` where the offline
// engine + legend say `cond`/`group`/`tag`). Rather than rename anything in
// `core` (out of scope here) or duplicate the KIND_CLASS/KIND_MARK tables,
// alias the real kinds onto their nearest already-styled/legend-matching
// entry above: `overlay.mjs`'s trace legend already groups "group / switch"
// under the same info dot and "tag / swap" under the same accent dot (a
// switch IS a kind of group; a swap IS a kind of tag-level mutation), and
// `condition` is just this file's `cond` under its real name. Anything not
// listed here (group/tag/add/remove/set/tmp/skip/anchor) already matches
// KIND_CLASS/KIND_MARK directly and needs no alias.
const KIND_ALIAS = {
  condition: "cond",
  switch: "group",
  swap: "tag",
};

/** Renders a trace array (see `runOffline`/`runPreview`) into `container`
 * (expected to carry the `.wtn-log` class already). */
export function renderTrace(container, traceEntries) {
  container.innerHTML = "";
  if (!traceEntries || !traceEntries.length) {
    const empty = document.createElement("div");
    empty.className = "is-dim";
    empty.textContent = "— no rules —";
    container.appendChild(empty);
    return;
  }
  traceEntries.forEach((entry) => {
    const kind = KIND_ALIAS[entry.kind] || entry.kind;
    const line = document.createElement("div");
    line.className = KIND_CLASS[kind] || "is-dim";
    const mark = KIND_MARK[kind] || "·";
    const indent = "  ".repeat(Math.max(0, entry.depth || 0));
    line.textContent = `${indent}${mark} ${entry.text}`;
    container.appendChild(line);
  });
}

/** Renders `/validate`-style errors (`[{path, message}]`) into a `.wtn-log`
 * container, one `.is-bad` line each. */
export function renderErrors(container, errors) {
  container.innerHTML = "";
  if (!errors || !errors.length) return;
  errors.forEach((e) => {
    const line = document.createElement("div");
    line.className = "is-bad";
    line.textContent = e && e.path ? `${e.path} — ${e.message}` : String(e && e.message ? e.message : e);
    container.appendChild(line);
  });
}

/** Debounces `fn` (default 250ms, matching `docs/nodes-and-api.md` §3's
 * "debounced" preview requirement). `.cancel()` clears a pending call;
 * `.flush(...)` runs immediately (used on e.g. an explicit "Preview now"
 * click, or before closing the overlay). */
export function createDebounced(fn, delay = 250) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => clearTimeout(timer);
  debounced.flush = (...args) => { clearTimeout(timer); fn(...args); };
  return debounced;
}
