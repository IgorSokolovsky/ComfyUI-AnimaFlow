# Prompt Rules — Schema & Data Model (v1)

A **decoupled** declarative rule system that rewrites prompts before encoding.
It is deliberately independent of any host: the engine only knows two things —
a **Document IR** (the parsed prompt) and a **Ruleset** (the rules) — both pure
data. You can run it standalone (parse text → apply rules → render text) or
integrate it (write two adapter functions to/from your own prompt type, e.g.
`PROMPT_DATA`). The rule schema and engine are identical either way.

Prose-aware and tag-aware from one model: booru tags and labelled prose
(Anima/Flux/Wan) are the same Document, in different *shapes*.

---

## 1. Layers & decoupling boundary

```
            ┌── standalone ──┐        ┌── integrated ──┐
  text ──► parse(text,profile) │      │ adaptIn(PROMPT_DATA) ──► 
            └────────┬─────────┘      └─────────┬────────┘
                     ▼                          ▼
             ╔══════════════════ Document IR (pure data) ══════════════════╗
             ║   Bundle{ positive: Document, negative: Document }           ║
             ╚══════════════════════════════╤══════════════════════════════╝
                                             ▼
                       applyRuleset(bundle, ruleset)  ── pure, host-free ──►  { bundle, trace }
                                             ▼
            ┌──────────┴──────────┐      ┌──────────┴──────────┐
  render(doc,profile) ──► text          adaptOut(doc) ──► PROMPT_DATA
```

**The contract (host-agnostic):**

| Function | Purpose |
|---|---|
| `parse(text, profile) → Document` | standalone input |
| `render(doc, profile) → text` | standalone output |
| `adaptIn(external) → Document` / `adaptOut(doc) → external` | integration (optional) |
| `applyRuleset({positive,negative}, ruleset, profile) → {positive, negative, trace}` | the engine (pure) |
| `validate(ruleset, profile) → {ok, errors[]}` | schema + semantic validation |

To **integrate**: implement `adaptIn`/`adaptOut`. To go **standalone**: use
`parse`/`render`. Nothing else changes. The engine never imports the host.

---

## 2. Document IR

The Document is a **tree of Blocks**. A block is either a **container** (has
`children`) or a **leaf** (has `items`). Both tags and prose phrases are the same
atom — an **Item** — differing only by separator and whether weights render.

```jsonc
// Bundle passed to the engine
{
  "positive": Document,
  "negative": Document
}

Document {
  "version": 1,
  "profile": "anima",          // profile id (defaults + parsing conventions)
  "root": Block                // a container block
}

Block {
  "id": "b3",                  // stable, unique within a Document (engine fills if absent)
  "label": "clothes",          // semantic label; may be pathy, e.g. "character:celica"
  "kind": "container" | "leaf",

  // leaf only:
  "items": Item[],             // ordered
  "sep": ", ",                 // how items join on render
  "weights": "preserve" | "strip",

  // container only:
  "children": Block[],

  // render hints (optional):
  "render": { "labelStyle": "none" | "prefix", "prefix": "clothes: " }
}

Item {
  "text": "blue eyes",
  "weight": 1.0,               // default 1.0
  "enabled": true              // false = removed/tmp: visible to later rules, NOT rendered
}
```

**Shapes:**
- **Booru** → `root` container with **one leaf** (`kind:"leaf"`, `sep:", "`, `weights:"preserve"`).
- **Prose (Anima)** → `root` → `[ quality(leaf), character:celica(container → appearance/clothes/action leaves), global(leaf) ]`.
- The engine does not care which; rules address blocks by **selector**.

### Selectors (how rules address blocks)

```
"*"                     the whole document (default scope)
"clothes"               any block whose label == "clothes" (or glob-matches)
"character:*"           glob on labels
"character:celica/clothes"   path by labels (container → child)
"#b3"                   by block id
"@negative"             the negative document's root (in conditions/targets)
```

Matching is on `label`. Globs use `*`. Paths use `/`. Unknown target + a profile
`blockOrder` → the block is **created** in canonical position (see §6).

---

## 3. Ruleset

```jsonc
Ruleset {
  "version": 1,
  "profile": "anima",          // optional default; host/CLI may override
  "options": {
    "conditionScope": "*",     // where conditions look by default (positive doc)
    "caseSensitive": false,
    "boundary": "word"         // "word" (default) | "substring" for `mentions`
  },
  "rules": Rule[]              // evaluated top → bottom
}
```

### 3.1 Rule (common fields)

Every rule shares these; `type` selects the variant (default `"tag"`).

```jsonc
{
  "name": "celica",            // optional; appears in errors + trace
  "type": "tag"|"group"|"switch"|"swap",   // default "tag"
  "when": Condition,           // optional gate (see §4)
  "into": Selector             // optional target scope; for group/switch it becomes
                               // the default target/anchor for children
}
```

Sugar (Deathspike-compatible): `any_of`, `all_of`, `none_of` may be given at the
rule level as `string | string[]`; they compile to `when` (see §4).

### 3.2 `tag` rule — mutations

```jsonc
{
  "type": "tag",
  "add":            Mutation | Mutation[],   // → positive
  "add_negative":   Mutation | Mutation[],   // → negative
  "remove":         Removal  | Removal[],    // → positive
  "remove_negative":Removal  | Removal[],    // → negative
  "tmp":            Mutation | Mutation[],   // add disabled (visible, not rendered) to both
  "set":            SetOp    | SetOp[]       // overwrite a block's items
}

// NEGATIVE-TARGETING OPS DO NOT INHERIT `into`.
// An enclosing group/switch's `into` describes a POSITIVE-document location (e.g.
// `character:celica` — which character's block to write to). The negative document has
// no such structure, so `add_negative`, `remove_negative`, and `tmp`'s negative half
// ignore the inherited `into` and default to the negative document's own flat/default
// scope (equivalently `"*"` for removals). An explicit `into`/`section`/`from` on the
// mutation or removal ITSELF is still honored. Positive-side ops (`add`, `remove`,
// `set`, `tmp`'s positive half) do inherit `into` as described in §3.1/§5.3.
//
// Why this is called out: letting a positive-shaped selector leak into the negative
// document both CREATES a spuriously labelled negative block (which then renders its
// label as literal prompt text under `sectionLabelStyle:"prefix"`) and silently scopes
// `remove_negative` to a block the user's negative tags are not in, making bare
// removals no-ops.

Mutation :=
   "blue eyes"                                  // string → add to `into` (or scope), at end
 | ["blue eyes", "smile"]                        // list
 | { "value": "blue eyes",                       // object form
     "into":   Selector,                         //   override target block
     "section":"appearance",                     //   shorthand: child block labelled <section> under `into`
     "at":     "start" | "end",                  //   default "end"
     "after":  string | string[],               //   insert right after first matched phrase
     "before": string | string[],               //   insert right before first matched phrase
     "weight": 1.2 }                             //   optional (respected only if weights=preserve)

Removal :=
   "celica" | ["celica","sketch"]                // remove phrase(s) from `into`/scope
 | { "value": "celica", "from": Selector }

SetOp :=
   { "target": Selector, "to": string|string[] } // explicit
 | { "section": "clothes", "to": "black leather jacket" }  // shorthand: child labelled
                                                            // "clothes" under current `into`
```

### 3.3 `group` rule — run all matching children under a shared scope

```jsonc
{
  "type": "group",
  "when":  Condition,          // if false, children are skipped
  "into":  Selector,           // default target/anchor for every child
  "children": Rule[]           // each evaluated in order; each may add its own when/into
}
```

### 3.4 `switch` rule — first matching child, or default

```jsonc
{
  "type": "switch",
  "when":  Condition,
  "into":  Selector,
  "children": [
    { "when": {...}, ...mutations },   // non-default children MUST have `when`
    { "when": {...}, ...mutations },
    { "default": true, ...mutations }  // optional; MUST NOT have conditions; at most one
  ]
}
```

### 3.5 `swap` rule — placeholder expansion

```jsonc
{
  "type": "swap",
  "match": string | string[],  // required; first matched positive phrase is removed…
  "into":  Selector,           // …and mutations are inserted at its position
  "add":          Mutation | Mutation[],
  "add_negative": Mutation | Mutation[]
}
```

---

## 4. Conditions (`when`)

A boolean tree. Leaves match text; nodes combine.

```jsonc
Condition :=
   { "mentions": string | string[], "in": Selector }   // word-boundary, case per options
 | { "matches":  "regex", "in": Selector, "flags": "i" }
 | { "all":  Condition[] }
 | { "any":  Condition[] }
 | { "none": Condition[] }
 | { "not":  Condition }
```

- Default scope (`in`) is `options.conditionScope` (normally the **positive** doc).
- Use `"in": "@negative"` to test the negative prompt, or `"in": "character:celica/clothes"` to scope to a section.
- `mentions` honours `options.boundary` (`word` = whole-word, `substring` = anywhere) and `options.caseSensitive`.
- **Sugar:** `any_of`/`all_of`/`none_of` compile to `when` by expanding **each phrase
  into its own `{mentions: phrase}` node** inside the combinator — e.g.
  `all_of: "a, b"` ≡ `{all: [{mentions:"a"}, {mentions:"b"}]}`, `any_of` → `{any: […]}`,
  `none_of` → `{none: […]}`. Multiple sugar keys on one rule are AND-ed.

**Removed/tmp items are still visible to conditions** (they carry `enabled:false`
but keep their text), matching Deathspike's "visible to future rules" behaviour.

---

## 5. Evaluation semantics

1. Rules run **top → bottom**; groups/switches recurse.
2. Two documents: **positive** and **negative**. Conditions read positive by default.
3. **`into` / anchors** resolve a target block, then a position: `after`/`before` a
   phrase inside that block; else `at` (`start`/`end`, default `end`). Unresolved
   anchor → fall back to `at`. `into` on a group/switch is inherited by children
   unless a child overrides it — **except by negative-targeting ops**
   (`add_negative`, `remove_negative`, `tmp`'s negative half), which never inherit it
   because `into` names a positive-document location; see the note in §3.2.
4. **Dedup on add:** if an item with the same normalised `text` already exists in
   the target block, it is re-enabled and (if `weights:"preserve"`) upgraded to the
   **stronger** weight — never duplicated.
5. **`remove` / `tmp`** set `enabled:false` (kept for later conditions, dropped on render).
6. **`set`** replaces the target block's items wholesale (respecting `into`/`section`).
7. **Weights:** governed by the target block's `weights` (from profile). `preserve`
   keeps/echoes `(text:weight)`; `strip` ignores weights on input and output.
8. **Determinism:** same Document + same Ruleset ⇒ same output (host may cache on a
   hash of both — see §9).

---

## 6. Profiles (format defaults — pure data)

A profile bundles parsing + rendering conventions so the same ruleset behaves
correctly per model family. Profiles are data; ship a few, let users add more.

```jsonc
Profile {
  "id": "anima",
  "parse": {
    "split": "commas" | "lines" | "sentences" | "none",
    "labels": {                       // how to detect labelled blocks when parsing text
      "container": "^\\[character:(.+)\\]$",
      "section":   "^(appearance|clothes|action|focus):\\s*(.*)$",
      "leaf":      "^\\[(quality|global)\\]"
    }
  },
  "blockOrder": ["quality","character:*","global"],   // canonical order; see note below
  "defaults":  { "sep": ", ", "weights": "strip" },
  "perLabelSep": { "__sections__": "\n", "clothes": ", " },
  "render": { "sectionLabelStyle": "prefix" }         // "clothes: ..." on output
}
```

Reference profiles to ship:
- `raw` — one leaf, `sep:", "`, `weights:"preserve"`, no labels.
- `illustrious` / `pony` — booru tags; `weights:"preserve"`; ordered leaf.
- `anima` — labelled prose; per-character sections; `weights:"strip"`; section order aware (`[[anima-prompt-structure]]`, `[[anima-structured-prompt-format]]`).
- `flux` / `wan` — natural-language prose; `sep:". "`; `weights:"strip"`.

> The engine reads only Document + Ruleset; **profiles affect `parse`/`render` and
> block creation, not rule evaluation.** That keeps rules portable across models.

**`parse.labels` are LINE-PREFIX patterns — do not `$`-anchor them.** All three are
matched against the start of a line, and any trailing text on the same line is
consumed as that block's content: for `leaf`, the remainder after the bracket becomes
the block's separator-split items (so `[quality] masterpiece, best quality` is one
`quality` leaf with two items); `section`'s own regex captures the remainder as its
2nd group. Anchoring `leaf` with `$` makes it match only a bare `[quality]` line, so
any line carrying inline content silently falls through to the unlabelled-leaf
fallback and its bracket text survives verbatim into the rendered prompt.

**`blockOrder` is a render-time ordering of the document root's top-level blocks**,
applied non-destructively (the Document itself is never reordered, so rules that
address blocks by label/id are unaffected). Entries match a block's label exactly, or
as a prefix when written with a trailing `*` (`character:*`). Blocks matching the same
entry keep their authored relative order (stable), and blocks matching no entry keep
their relative order and are rendered last. Nested blocks are never reordered — a
`character:*` container's own sections render in authored order. A profile with an
empty/absent `blockOrder` is not reordered at all.

---

## 7. Serialization

`render(doc, profile)`:
- A **leaf** joins its `enabled` items with `sep`; `weights:"preserve"` re-emits
  `(text:weight)` (nesting/`:` syntax) — `strip` emits plain text.
- A **container** joins children; `render.labelStyle:"prefix"` prepends `label + ": "`
  (or the profile's section style). `perLabelSep.__sections__` sets the join between
  sections (e.g. newline for Anima).
- Empty (all-disabled) leaves and empty containers are omitted; trailing separators
  are cleaned. Multi-region (`BREAK`) is a top-level container per region joined by
  ` BREAK ` (optional, profile-gated).

`parse(text, profile)` is the inverse using `profile.parse`; `split:"none"` makes
the whole text a single one-item leaf (rules can still `mentions`/`add`/`remove`).

---

## 8. Errors & trace

**Validation errors** carry a precise path (adopt Deathspike's style):
```
Error at celica.yaml → rules[0](celica).children[1].when.any[0], 'mentons' is not a valid condition
```

**Execution trace** (returned by `applyRuleset`, and printable as a tree) records
every decision so a UI can show *why* a rule fired:
```
> rules[0] {group} (celica)
  ? any(mentions "celica") = true
  → into: character:celica
  $ children[0] {tag}
    = set clothes: "black leather jacket"
  > children[1] {switch}
    x children[0]  ? mentions "jacket" = false
    ✓ children[1]  ? mentions "shirt"  = true
      + add clothes: "black t-shirt"  (after "collar")
  $ children[2] {tag}
    - remove appearance: "celica"
```

Trace node prefixes: `>` group/switch · `$` tag/swap · `?` condition · `→` target ·
`+` add · `~` tmp · `-` remove · `=` set/swap · `✓/x` chosen/skipped.

---

## 9. Host integration notes

- **Caching:** hash `render(input) + serialize(ruleset) + profile.id`; re-run only on
  change (mirrors Deathspike's `IS_CHANGED`).
- **Ruleset transport:** a Ruleset is plain JSON — embed it in a node's serialized
  state, ship it in a `.json`/`.yaml` file, or paste it. Selectable per node ⇒ no
  forced-global behaviour.
- **PROMPT_DATA bridge:** `adaptIn` maps your structured type's sections → labelled
  Blocks (1:1 if it's already sectioned — no re-parse); `adaptOut` the reverse.
  When only a `STRING` is available, use `parse`/`render` with the chosen profile.

---

## 10. Versioning

- `Ruleset.version` and `Document.version` are integers. Engines accept `version <= supported`.
- Unknown rule `type` or condition key ⇒ **hard validation error** (never silently ignored).
- Additive fields bump minor behaviour but keep `version`; breaking changes bump it.

See `ruleset.schema.json` (JSON Schema, draft 2020-12) for machine validation and
editor autocomplete. Worked examples: `examples/celica.anima.yaml` (prose) and
`examples/celica.booru.yaml` (tags) — **same logic, two profiles**.
