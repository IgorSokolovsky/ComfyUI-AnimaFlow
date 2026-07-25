/**
 * Rule Builder — rule model, recursive card renderer, and the ruleset
 * serializer (JSON ruleset + a convenience YAML view).
 *
 * Ported from `playground/rule-builder.html`'s in-page `<script>` (the
 * approved UX), restyled onto the shared `.wtn-*` component vocabulary
 * (`js/shared/theme.{css,mjs}` — see THEME.md) instead of the playground's
 * inline palette. Layout-only additions specific to this overlay live under
 * the `.wtn-rb-*` classes injected by `overlay.mjs` (no new colors — every
 * `--rb-tone` below is one of the existing `--wtn-*` tokens).
 *
 * This module owns the UI's internal rule representation (a plain object
 * tree, NOT the wire-format Ruleset from `prompt-rules/SCHEMA.md`) plus:
 *   - `mkRule` / `seedRuleset` — build/seed rows for the builder pane.
 *   - `renderRuleList` — the recursive card renderer.
 *   - `toRuleset` — serializes the internal model to the REAL schema shape
 *     (`prompt-rules/SCHEMA.md` §3 / `ruleset.schema.json`) for
 *     `POST /wtn/rules/{preview,validate,sheet}`.
 *   - `fromRuleset` — the (best-effort) inverse, for `GET /wtn/rules/sheet`
 *     and an encode node's existing `embedded_rules`: loads the SUBSET of the
 *     schema this card UI can represent (sugar `any_of`/`all_of`/`none_of`
 *     conditions, `section`-based `set`, plain/`{value}`-form mutations,
 *     `switch` + `default:true` children) — exactly what `toRuleset` itself
 *     emits, and what both worked examples in `prompt-rules/examples/` use.
 *     A richer hand-authored ruleset (explicit `target` selectors, nested
 *     boolean condition trees, `after`/`before` anchors) has no card
 *     representation; those rules load with their condition dropped to
 *     "always" and a console warning — edit such rules as YAML instead.
 *   - `toYAML` — a human-readable YAML rendering of that same ruleset, for
 *     the "Export YAML" pane.
 *
 * Internal rule shape (mirrors the playground exactly):
 *   {
 *     id, type: "tag"|"group"|"switch"|"swap", name,
 *     cond: { mode: "always"|"any_of"|"all_of"|"none_of", tags: "a, b" },
 *     into: "clothes" | "character:celica" | "" ,
 *     muts: [{ op: "add"|"add_negative"|"remove"|"set"|"tmp", value, section }],
 *     children: Rule[] | null,   // group / switch only
 *     isDefault: bool,           // switch children only
 *     match, addv,               // swap only
 *   }
 */

// ── id generator ──────────────────────────────────────────────────────────
let _idCounter = 0;
export function nextRuleId() {
  _idCounter += 1;
  return `r${_idCounter}`;
}

// ── profile → document "family" (prose vs flat tags) ───────────────────────
// The real family/parsing conventions live server-side in a profile's
// `parse`/`render` block (SCHEMA.md §6) — this is only a client-side
// heuristic used by (a) the `into`/`section` datalist suggestions below and
// (b) `preview.mjs`'s OFFLINE fallback engine, which has to parse/render text
// itself when `/wtn/rules/preview` is unreachable. It is intentionally
// approximate; the server (once Track A's `api/rules_api.py` lands) is the
// source of truth. The four ids below match BOTH `docs/nodes-and-api.md` §2's
// `/wtn/rules/profiles` example AND Track A's already-shipped
// `nodes/_rules_helpers.PROFILE_CHOICES` — the curated node-facing subset of
// `core/profiles.py`'s six engine profiles (which also has `pony`/`wan`;
// those aren't node-selectable, so they're omitted here too). `pony`/`wan`
// are still handled gracefully (fall back to their nearest family) in case
// the server ever exposes them.
const PROFILE_FAMILY = {
  anima: "prose", flux: "prose", wan: "prose",
  illustrious: "tags", pony: "tags", raw: "tags",
};
export function profileFamily(profile) {
  return PROFILE_FAMILY[profile] || "tags";
}

export const TARGETS = {
  prose: ["", "*", "appearance", "clothes", "action", "focus", "quality", "global"],
  tags: ["", "*"],
};
export function targetsForProfile(profile) {
  return TARGETS[profileFamily(profile)] || TARGETS.tags;
}

// ── rule model ───────────────────────────────────────────────────────────
export function mkRule(type) {
  return {
    id: nextRuleId(),
    type,
    name: "",
    cond: { mode: "always", tags: "" },
    into: "",
    muts: type === "tag" ? [{ op: "add", value: "", section: "" }] : [],
    children: type === "group" || type === "switch" ? [] : null,
    isDefault: false,
    match: "",
    addv: "",
  };
}

export function countRules(rules) {
  return (rules || []).reduce((n, r) => n + 1 + (r.children ? countRules(r.children) : 0), 0);
}

/**
 * The "celica" example from the playground/SCHEMA worked example — used to
 * seed a fresh builder (embedded mode with nothing saved yet, or the demo
 * default when opened standalone from the menu command) so the overlay is
 * demo-able / has something non-trivial to look at before Track A's real
 * sheets exist.
 */
export function seedRuleset() {
  return [
    {
      id: nextRuleId(),
      type: "group",
      name: "celica",
      cond: { mode: "any_of", tags: "celica" },
      into: "character:celica",
      muts: [],
      isDefault: false,
      children: [
        {
          id: nextRuleId(), type: "tag", name: "remove-activation",
          cond: { mode: "always", tags: "" }, into: "",
          muts: [{ op: "remove", value: "celica", section: "" }], children: null,
        },
        {
          id: nextRuleId(), type: "tag", name: "appearance",
          cond: { mode: "always", tags: "" }, into: "",
          muts: [{ op: "set", value: "short black hair, pixie cut", section: "appearance" }], children: null,
        },
        {
          id: nextRuleId(), type: "tag", name: "eyes",
          cond: { mode: "none_of", tags: "closed eyes, eyes out of frame" }, into: "",
          muts: [{ op: "add", value: "blue eyes", section: "appearance" }], children: null,
        },
        {
          id: nextRuleId(), type: "switch", name: "outfit",
          cond: { mode: "always", tags: "" }, into: "", muts: [],
          children: [
            {
              id: nextRuleId(), type: "tag", name: "", isDefault: false,
              cond: { mode: "any_of", tags: "jacket" }, into: "",
              muts: [{ op: "set", value: "black leather jacket", section: "clothes" }], children: null,
            },
            {
              id: nextRuleId(), type: "tag", name: "", isDefault: false,
              cond: { mode: "any_of", tags: "shirt" }, into: "",
              muts: [{ op: "set", value: "black t-shirt", section: "clothes" }], children: null,
            },
            {
              id: nextRuleId(), type: "tag", name: "", isDefault: true,
              cond: { mode: "always", tags: "" }, into: "",
              muts: [{ op: "set", value: "black camisole", section: "clothes" }], children: null,
            },
          ],
        },
        {
          id: nextRuleId(), type: "tag", name: "quality-guard",
          cond: { mode: "always", tags: "" }, into: "",
          muts: [{ op: "add_negative", value: "blurry, low quality, extra fingers", section: "" }], children: null,
        },
      ],
    },
  ];
}

// ── tooltips (text only; the actual popup element/lifecycle is owned by
// overlay.mjs, which delegates on any `[data-tip]` element regardless of
// which module produced it) ────────────────────────────────────────────────
export const TIP = {
  type: {
    tag: "<b>Tag rule</b> — add, remove, or set tags. The everyday rule.",
    group: "<b>Group</b> — runs ALL child rules under this rule's condition + target.",
    switch: "<b>Switch</b> — runs the FIRST child whose condition matches, else the default. Mutually-exclusive, like picking an outfit.",
    swap: "<b>Swap</b> — removes a placeholder tag and inserts expanded tags in its place.",
  },
  when: "Condition that <b>gates</b> this rule. 'always' = no condition.",
  condTags: "Tags to test (comma-separated), matched against the positive prompt.",
  into: "<b>Where</b> added tags go — a section like 'clothes', or '*' for the single tag list.",
  name: "Optional label — shows up in the trace and error messages.",
  def: "<b>Default</b> child — used when no other branch matches. Can't have a condition.",
  matchF: "Placeholder tag to find and remove.",
  addF: "Tags to insert where the placeholder was.",
  section: "Section to overwrite (e.g. appearance, clothes).",
  value: "Tags / text for this mutation, comma-separated.",
  removeVal: "Tag to drop from the prompt (still visible to later rules).",
  mut: {
    add: "Append to the <b>positive</b> prompt — deduped, never doubles a tag.",
    add_negative: "Append to the <b>negative</b> prompt.",
    remove: "Drop a tag — stays visible to later rules, gone from output.",
    set: "Overwrite a <b>whole section</b> with these tags.",
    tmp: "Temporary tag: visible to later rules, <b>not</b> rendered.",
  },
};

// ── small DOM widget helpers ────────────────────────────────────────────
function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function inp(val, ph, on, cls, tip) {
  const e = el("input", `wtn-input ${cls || ""}`.trim());
  e.value = val || "";
  e.placeholder = ph;
  e.spellcheck = false;
  e.oninput = () => on(e.value);
  if (tip) e.dataset.tip = tip;
  return e;
}

function datalistInp(val, ph, opts, on, tip) {
  const wrap = el("span");
  wrap.style.display = "contents";
  const e = inp(val, ph, on, "wtn-rb-grow", tip);
  const id = "wtn-rb-dl-" + nextRuleId();
  const dl = el("datalist");
  dl.id = id;
  opts.forEach((o) => {
    const op = el("option");
    op.value = o;
    dl.appendChild(op);
  });
  e.setAttribute("list", id);
  wrap.append(e, dl);
  return wrap;
}

function sel(opts, val, on, tip) {
  const e = el("select", "wtn-select");
  opts.forEach((o) => {
    const op = el("option");
    op.value = o;
    op.textContent = o;
    if (o === val) op.selected = true;
    e.appendChild(op);
  });
  e.onchange = () => on(e.value);
  if (tip) e.dataset.tip = tip;
  return e;
}

function iconBtn(txt, title, on) {
  const b = el("button", "wtn-btn wtn-btn--icon");
  b.type = "button";
  b.textContent = txt;
  b.title = title || "";
  b.onclick = on;
  return b;
}

function addInline(txt, on, tip) {
  const b = el("button", "wtn-rb-add-inline");
  b.type = "button";
  b.textContent = txt;
  b.onclick = on;
  if (tip) b.dataset.tip = tip;
  return b;
}

// ── recursive card renderer ─────────────────────────────────────────────
/**
 * Renders `rules` (an array of internal Rule objects) as a tree of cards
 * into `host`, replacing its current contents. `opts`:
 *   - profile: current profile id (drives the `into`/`section` datalist)
 *   - onChange(kind): kind is "value" (a plain text edit — re-run preview
 *     only, no DOM rebuild, so the field doesn't lose focus mid-type) or
 *     "structural" (add/remove/type/condition-mode/default-toggle — the
 *     caller should treat this as "state changed shape", though this
 *     function itself already re-renders the tree for those cases).
 */
export function renderRuleList(host, rules, opts) {
  const { profile, onChange } = opts;
  const rerender = () => renderRuleList(host, rules, opts);
  const notifyValue = () => onChange && onChange("value");
  const notifyStructural = () => {
    rerender();
    onChange && onChange("structural");
  };

  host.innerHTML = "";
  rules.forEach((r, i) => host.appendChild(renderRule(r, rules, i, false, profile, rerender, notifyValue, notifyStructural)));
  return rerender;
}

function renderRule(rule, arr, idx, isSwitchChild, profile, rerenderTree, notifyValue, notifyStructural) {
  const targets = targetsForProfile(profile);
  const wrap = el("div", "wtn-rb-rule");
  wrap.dataset.type = rule.type;
  wrap.dataset.cond = String(rule.cond.mode !== "always");

  // header
  const hd = el("div", "wtn-rb-rule-hd");
  const pill = el("span", "wtn-rb-type-pill");
  pill.textContent = rule.type;
  pill.dataset.tip = TIP.type[rule.type];
  hd.appendChild(pill);

  const nameInput = inp(rule.name, "name (optional)", (v) => { rule.name = v; notifyValue(); }, "wtn-rb-name-input", TIP.name);
  nameInput.classList.remove("wtn-input");
  nameInput.classList.add("wtn-rb-name-input");
  hd.appendChild(nameInput);

  if (isSwitchChild) {
    const toggle = el("label", "wtn-rb-default-toggle");
    toggle.dataset.tip = TIP.def;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = rule.isDefault;
    cb.onchange = () => {
      arr.forEach((c) => { c.isDefault = false; });
      rule.isDefault = cb.checked;
      notifyStructural();
    };
    toggle.append(cb, document.createTextNode("default"));
    hd.appendChild(toggle);
  }
  hd.appendChild(iconBtn("✕", "Remove this rule", () => { arr.splice(idx, 1); notifyStructural(); }));
  wrap.appendChild(hd);

  const body = el("div", "wtn-rb-rule-body");

  // condition (hidden for a switch's default child — it can't have one)
  if (!(isSwitchChild && rule.isDefault)) {
    const condRow = el("div", "wtn-rb-row");
    const lbl = el("span", "wtn-label");
    lbl.textContent = "when";
    condRow.appendChild(lbl);
    condRow.appendChild(sel(["always", "any_of", "all_of", "none_of"], rule.cond.mode, (v) => {
      rule.cond.mode = v;
      notifyStructural();
    }, TIP.when));
    if (rule.cond.mode !== "always") {
      condRow.appendChild(inp(rule.cond.tags, "tags, comma, separated", (v) => { rule.cond.tags = v; notifyValue(); }, "wtn-rb-grow", TIP.condTags));
    }
    body.appendChild(condRow);
  }

  // into (every type)
  const intoRow = el("div", "wtn-rb-row");
  const intoLbl = el("span", "wtn-label");
  intoLbl.textContent = "into";
  intoRow.appendChild(intoLbl);
  intoRow.appendChild(datalistInp(rule.into, "target (blank = inherit)", targets, (v) => { rule.into = v; notifyValue(); }, TIP.into));
  body.appendChild(intoRow);

  if (rule.type === "tag") {
    (rule.muts || []).forEach((m, mi) => body.appendChild(renderMut(m, rule.muts, mi, profile, notifyValue, notifyStructural)));
    body.appendChild(addInline("+ mutation", () => {
      rule.muts.push({ op: "add", value: "", section: "" });
      notifyStructural();
    }, "Add another action (add / remove / set / tmp) to this rule."));
  } else if (rule.type === "swap") {
    const r1 = el("div", "wtn-rb-row");
    const l1 = el("span", "wtn-label"); l1.textContent = "match"; r1.appendChild(l1);
    r1.appendChild(inp(rule.match, "placeholder tag", (v) => { rule.match = v; notifyValue(); }, "wtn-rb-grow", TIP.matchF));
    const r2 = el("div", "wtn-rb-row");
    const l2 = el("span", "wtn-label"); l2.textContent = "add"; r2.appendChild(l2);
    r2.appendChild(inp(rule.addv, "expanded tags", (v) => { rule.addv = v; notifyValue(); }, "wtn-rb-grow", TIP.addF));
    body.append(r1, r2);
  } else {
    // group / switch
    const kids = el("div", "wtn-rb-children");
    rule.children.forEach((c, ci) => kids.appendChild(renderRule(c, rule.children, ci, rule.type === "switch", profile, rerenderTree, notifyValue, notifyStructural)));
    body.appendChild(kids);

    const addRow = el("div", "wtn-rb-row wtn-rb-add-row");
    ["tag", "group", "switch", "swap"].forEach((t) => {
      addRow.appendChild(addInline("+ " + t, () => {
        rule.children.push(mkRule(t));
        notifyStructural();
      }, TIP.type[t]));
    });
    body.appendChild(addRow);
  }

  wrap.appendChild(body);
  return wrap;
}

function renderMut(m, arr, idx, profile, notifyValue, notifyStructural) {
  const targets = targetsForProfile(profile);
  const row = el("div", "wtn-rb-row wtn-rb-mut");
  row.appendChild(sel(["add", "add_negative", "remove", "set", "tmp"], m.op, (v) => { m.op = v; notifyStructural(); }, TIP.mut[m.op]));
  if (m.op === "set") {
    row.appendChild(datalistInp(m.section, "section", targets, (v) => { m.section = v; notifyValue(); }, TIP.section));
  }
  row.appendChild(inp(
    m.value,
    m.op === "remove" ? "tag to remove" : "value",
    (v) => { m.value = v; notifyValue(); },
    "wtn-rb-grow",
    m.op === "remove" ? TIP.removeVal : TIP.value,
  ));
  row.appendChild(iconBtn("✕", "Remove this mutation", () => { arr.splice(idx, 1); notifyStructural(); }));
  return row;
}

// ── serialization: internal model -> real Ruleset (SCHEMA.md §3) ───────────
function resolveInto(rule, intoInherit) {
  return rule.into || intoInherit || "";
}

function condFields(cond) {
  if (!cond || cond.mode === "always" || !cond.tags) return {};
  return { [cond.mode]: cond.tags };
}

function appendField(existing, entry) {
  if (existing === undefined) return entry;
  return Array.isArray(existing) ? [...existing, entry] : [existing, entry];
}

/**
 * Serializes one tag rule's (or a switch-default child's) `muts` array into
 * the schema's `add`/`add_negative`/`remove`/`set`/`tmp` fields, merging
 * repeated ops into arrays. `add`/`add_negative`/`remove`/`tmp` are always
 * emitted as the PLAIN string form (never the `{value, into|from}` object
 * form) — this UI has no per-mutation target override, so the mutation
 * simply targets the rule's own (already-serialized) `into`, exactly like
 * the worked examples in `prompt-rules/examples/` (their scalar
 * `add_negative: "..."` rules carry no `into` of their own at all). `set`
 * always needs an explicit target: `{section, to}` if a section was given,
 * else `{target: resolvedInto, to}` — SCHEMA.md §3.2's `SetOp` has no bare
 * string form. */
function serializeMutations(muts, resolvedInto) {
  const out = {};
  (muts || []).forEach((m) => {
    if (!m.value && m.op !== "remove") return;
    if (m.op === "set") {
      const entry = m.section ? { section: m.section, to: m.value } : { target: resolvedInto || "*", to: m.value };
      out.set = appendField(out.set, entry);
    } else if (m.op === "add" || m.op === "add_negative" || m.op === "remove" || m.op === "tmp") {
      out[m.op] = appendField(out[m.op], m.value);
    }
  });
  return out;
}

function serializeRule(rule, intoInherit) {
  const ownInto = rule.into || "";
  const into = resolveInto(rule, intoInherit);
  const base = {};
  if (rule.name) base.name = rule.name;
  Object.assign(base, condFields(rule.cond));
  if (rule.type !== "tag") base.type = rule.type;
  // Only emit `into` when THIS rule actually overrides it — an inherited
  // value is left implicit (matches the worked examples, where children
  // never repeat their group/switch's `into`).
  if (ownInto) base.into = ownInto;

  if (rule.type === "tag") {
    Object.assign(base, serializeMutations(rule.muts, into));
    return base;
  }
  if (rule.type === "swap") {
    if (rule.match) base.match = rule.match;
    if (rule.addv) base.add = rule.addv;
    return base;
  }
  // group / switch
  base.children = (rule.children || []).map((c) => {
    if (rule.type === "switch" && c.isDefault) {
      const childInto = resolveInto(c, into);
      return { default: true, ...serializeMutations(c.muts, childInto) };
    }
    return serializeRule(c, into);
  });
  return base;
}

/** Converts the builder's internal rule tree into a real Ruleset object
 * (`prompt-rules/SCHEMA.md` §3 / `ruleset.schema.json`) — this is what gets
 * sent as `embedded`/`ruleset` to `/wtn/rules/{preview,validate,sheet}`. */
export function toRuleset(rules, profile) {
  return {
    version: 1,
    profile,
    rules: (rules || []).map((r) => serializeRule(r, "")),
  };
}

// ── deserialization: real Ruleset -> internal model (best-effort inverse) ──
function asEntryArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Normalizes one mutation/removal/set entry (string, or one of the object
 * forms from SCHEMA.md §3.2) into `{value, section}` for a UI mutation row.
 * A per-mutation `into`/`from` override (object form) has no dedicated field
 * in this UI — it is dropped (the row falls back to the rule's own `into`),
 * matching this function's documented "best-effort inverse of toRuleset()"
 * scope. */
function normalizeMutEntry(entry) {
  if (typeof entry === "string") return { value: entry, section: "" };
  if (entry && typeof entry === "object") {
    if ("to" in entry) {
      const value = Array.isArray(entry.to) ? entry.to.join(", ") : entry.to;
      return { value, section: entry.section || "" };
    }
    const value = Array.isArray(entry.value) ? entry.value.join(", ") : entry.value;
    return { value: value || "", section: "" };
  }
  return { value: "", section: "" };
}

function buildMutsFromFields(raw) {
  const muts = [];
  const push = (op, entries) => entries.forEach((e) => {
    const n = normalizeMutEntry(e);
    muts.push({ op, value: n.value, section: op === "set" ? n.section : "" });
  });
  push("add", asEntryArray(raw.add));
  push("add_negative", asEntryArray(raw.add_negative));
  push("remove", asEntryArray(raw.remove));
  push("tmp", asEntryArray(raw.tmp));
  push("set", asEntryArray(raw.set));
  return muts;
}

/** Best-effort: maps the sugar `any_of`/`all_of`/`none_of` fields, or a
 * single-leaf `when: {any|all|none: [{mentions}]}`, onto the card UI's
 * `{mode, tags}`. Anything richer (nested trees, `matches`, explicit `in`
 * scoping, `not`) can't be represented — dropped to "always" with a console
 * warning so it never silently mutates a hand-authored rule on save. */
function condFromRaw(raw) {
  for (const mode of ["any_of", "all_of", "none_of"]) {
    if (raw[mode] !== undefined) {
      const v = raw[mode];
      return { mode, tags: Array.isArray(v) ? v.join(", ") : String(v) };
    }
  }
  if (raw.when) {
    const tryLeaf = (key, mode) => {
      const arr = raw.when[key];
      if (Array.isArray(arr) && arr.length === 1 && arr[0] && arr[0].mentions !== undefined) {
        const v = arr[0].mentions;
        return { mode, tags: Array.isArray(v) ? v.join(", ") : String(v) };
      }
      return null;
    };
    const mapped = tryLeaf("any", "any_of") || tryLeaf("all", "all_of") || tryLeaf("none", "none_of");
    if (mapped) return mapped;
    console.warn(
      "Rule Builder: a rule's `when` condition is too complex for the card UI (dropped to \"always\"); " +
        "edit this ruleset as YAML instead if you need to keep it.",
      raw,
    );
  }
  return { mode: "always", tags: "" };
}

function ruleFromRaw(raw) {
  const type = raw.type || "tag";
  const base = {
    id: nextRuleId(),
    type,
    name: raw.name || "",
    cond: condFromRaw(raw),
    into: raw.into || "",
    muts: type === "tag" ? buildMutsFromFields(raw) : [],
    children: null,
    isDefault: false,
    match: "",
    addv: "",
  };
  if (type === "swap") {
    base.match = Array.isArray(raw.match) ? raw.match.join(", ") : raw.match || "";
    const addEntries = asEntryArray(raw.add);
    base.addv = addEntries.length ? normalizeMutEntry(addEntries[0]).value : "";
  } else if (type === "group" || type === "switch") {
    base.children = (raw.children || []).map((c) => {
      if (c && c.default) {
        return {
          id: nextRuleId(), type: "tag", name: "", isDefault: true,
          cond: { mode: "always", tags: "" }, into: c.into || "",
          muts: buildMutsFromFields(c), children: null, match: "", addv: "",
        };
      }
      return ruleFromRaw(c);
    });
  }
  return base;
}

/** Best-effort inverse of `toRuleset` — see the module doc comment for the
 * supported subset. Returns `[]` for a missing/malformed ruleset (caller
 * should treat that as "nothing to load" and fall back to `seedRuleset()`
 * or an empty builder, not a hard error). */
export function fromRuleset(ruleset) {
  if (!ruleset || !Array.isArray(ruleset.rules)) return [];
  return ruleset.rules.map((r) => ruleFromRaw(r));
}

// ── minimal YAML emitter (Export YAML pane only — not a general-purpose
// YAML library; tailored to the plain-object/array/scalar shape toRuleset()
// always produces) ─────────────────────────────────────────────────────────
function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function yamlScalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  const needsQuote =
    s === "" ||
    /^[\[{*&!|>'"%@`#]/.test(s) ||
    /: (|$)/.test(s) ||
    /^\s|\s$/.test(s) ||
    /^(true|false|null|yes|no)$/i.test(s);
  return needsQuote ? JSON.stringify(s) : s;
}

function yamlMappingLines(obj, indent) {
  const pad = "  ".repeat(indent);
  const lines = [];
  Object.entries(obj).forEach(([key, v]) => {
    if (v === undefined) return;
    if (isPlainObject(v)) {
      const sub = yamlMappingLines(v, indent + 1);
      if (!sub.length) { lines.push(`${pad}${key}: {}`); return; }
      lines.push(`${pad}${key}:`, ...sub);
    } else if (Array.isArray(v)) {
      if (!v.length) { lines.push(`${pad}${key}: []`); return; }
      lines.push(`${pad}${key}:`, ...yamlSequenceLines(v, indent + 1));
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(v)}`);
    }
  });
  return lines;
}

function yamlSequenceLines(arr, indent) {
  const pad = "  ".repeat(indent);
  const lines = [];
  arr.forEach((item) => {
    if (isPlainObject(item)) {
      const sub = yamlMappingLines(item, indent + 1);
      if (!sub.length) { lines.push(`${pad}- {}`); return; }
      lines.push(`${pad}- ${sub[0].trim()}`, ...sub.slice(1));
    } else if (Array.isArray(item)) {
      lines.push(`${pad}- ${JSON.stringify(item)}`);
    } else {
      lines.push(`${pad}- ${yamlScalar(item)}`);
    }
  });
  return lines;
}

/** Renders the ruleset (see `toRuleset`) as YAML text for the Export pane. */
export function toYAML(rules, profile) {
  return yamlMappingLines(toRuleset(rules, profile), 0).join("\n");
}
