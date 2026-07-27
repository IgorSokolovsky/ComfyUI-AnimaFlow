# Rules reference

Compact reference for writing character-sheet YAML by hand. For the full data model
(Document IR, selectors, evaluation semantics), see
[`src/prompt_rules/schema/SCHEMA.md`](../src/prompt_rules/schema/SCHEMA.md).

A sheet is a **list of rules**, evaluated top → bottom:

```yaml
version: 1
profile: anima          # optional default (node's profile input can override)
options:
  boundary: word        # "word" (default) | "substring" for `mentions`
  caseSensitive: false
rules:
  - …                   # rule objects (below)
```

---

## Common rule fields

| field | meaning |
|---|---|
| `name` | optional label — appears in the trace and error paths |
| `type` | `tag` (default) · `group` · `switch` · `swap` |
| `when` | structured condition (see below) |
| `any_of` / `all_of` / `none_of` | sugar → `when`; value is a tag or comma list |
| `into` | target selector for this rule (and, on group/switch, its children) |

## Selectors (`into`, condition `in`, `set.target`)

```
"*"                          the whole document (default)
"clothes"                    a block labelled "clothes"
"character:celica/clothes"   path: child of a container
"character:*"                glob
"#id"                        by block id
"@negative"                  the negative document
```

## Conditions (`when`)

```yaml
when: { mentions: "celica", in: "*" }        # word-boundary (or substring), scoped
when: { matches: "cel.*", in: "focus" }      # regex
when: { all:  [ {mentions: a}, {mentions: b} ] }
when: { any:  [ … ] }
when: { none: [ … ] }
when: { not:  { mentions: x } }
```

Sugar: `any_of: "a, b"` ≡ `when: {any: [{mentions: a}, {mentions: b}]}` (each phrase its own
node); `all_of` → `all`; `none_of` → `none`. Multiple sugar keys AND together.

---

## `tag` rule — mutations

```yaml
- add: "blue eyes"                                  # string, or list
- add: { value: "blue eyes", into: "appearance" }   # object form
- add: { section: appearance, value: "blue eyes" }  # shorthand: child <section> under `into`
- add_negative: "blurry"
- remove: "celica"                                  # or { value: celica, from: "*" }
- set: { section: clothes, to: "black leather jacket" }   # overwrite a section
- set: { target: "character:celica/clothes", to: "…" }    # explicit target
- tmp: "thighhighs"                                 # temporary (visible to later rules, not rendered)
```

A tag rule needs at least one mutation. Add-object extras: `at: start|end`,
`after`/`before` *(parsed; v1 appends — see Beta limitations)*, `weight` *(v1: opaque)*.

## `group` rule

```yaml
- type: group
  when: { … }           # if false, children are skipped
  into: "character:celica"
  children: [ … ]       # every child evaluated in order under the shared when/into
```

## `switch` rule

```yaml
- type: switch
  children:
    - any_of: jacket           # non-default children MUST have a condition
      set: { section: clothes, to: "black leather jacket" }
    - default: true            # optional, at most one; MUST NOT have conditions
      set: { section: clothes, to: "black camisole" }
```

Runs the **first** matching child; falls back to `default`.

## `swap` rule

```yaml
- type: swap
  match: "thighhighs"          # required: first matched positive tag is removed…
  into: "*"                    # …and mutations inserted at its position
  add: "black thighhighs"
  add_negative: "…"
```

---

## Validation

Sheets are validated before they run; errors carry a precise path:

```
Error at celica.yaml -> rules[0](celica).children[1].type, '<x>' is not supported
```

Common causes: a misspelled `type`, a `group`/`switch` missing `children`, a `default`
child that also has a condition, `mentions` + `matches` on one condition, `after` + `before`
on one add, or a bad `matches` regex.

## Profiles

`anima` (prose sections) · `illustrious` / `pony` (booru tags) · `flux` / `wan` (NL prose) ·
`raw` (one tag list). Profiles set separators, section handling, and weight mode — so the same
rules travel across models.
