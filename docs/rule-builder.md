# Rule Builder

Define your character once, and let the engine rewrite your prompt for you — adding her
hair and eyes, swapping outfits by context, stripping tags that don't belong — every time,
consistently. You write **rules**; they transform your prompt *before* it's encoded.

Works for **Anima labelled-prose** *and* **booru tags** (and Flux/Wan prose) — same rules,
different profile.

---

## The pieces

| Piece | What it is |
|---|---|
| **Prompt Rules** / **Prompt Rules (CLIP)** nodes | Where rules get applied. Text variant → strings; CLIP variant → conditioning. |
| **Open Rule Builder** button | Opens the full **overlay** to author rules visually — card editor, live preview, trace. |
| **Pick…** button | A quick popover to insert a character/outfit/background **token** without memorizing names. |
| **Character sheets** | Your rules, saved. Reusable **files** (`rules/*.yaml`) and/or **embedded** per-workflow. |

Also available as a global **Rule Builder** menu command (not tied to a node).

---

## Quick start

1. Add a **Prompt Rules** node → click **Open Rule Builder**.
2. Start from the sample `celica` sheet (or **+ Rule**).
3. Type a test prompt in the preview's **Input**; watch the **Output** and **trace** update live.
4. **Save** the sheet, or apply it as the node's embedded ruleset.
5. Back on the node, put your character's activation word in the prompt (or use **Pick…**), and generate.

---

## Every rule is four ideas

- **`when`** — the condition that *gates* the rule (e.g. `any_of: celica`). `always` = no condition.
- **`into`** — *where* added tags go: a section like `clothes`, or `*` for the single tag list.
- **mutation** — *what* it does: `add`, `add_negative`, `remove`, `set`, `tmp`.
- Rules run **top → bottom**; groups and switches nest.

---

## Rule types

| Type | Behavior |
|---|---|
| **tag** | The everyday rule — add / remove / set tags. |
| **group** | Runs **all** child rules under one shared `when` + `into`. Keeps related rules together. |
| **switch** | Runs the **first** matching child, else the `default`. Mutually-exclusive — perfect for picking one outfit. |
| **swap** | Replaces a placeholder tag with expanded tags in its place. |

## Conditions (`when`)

| | fires when… |
|---|---|
| `any_of` | at least one listed tag is in the prompt |
| `all_of` | all are present |
| `none_of` | none are present |
| `always` | no condition — always fires |

Conditions read the **positive** prompt by default. Removed/temporary tags stay *visible* to
later conditions (they just don't render) — so a `remove` earlier doesn't hide a tag from a
later `none_of`.

## Mutations

| | effect |
|---|---|
| `add` | append to the positive prompt — **deduped**, never doubles a tag |
| `add_negative` | append to the negative prompt |
| `remove` | drop a tag — still visible to later rules, gone from output |
| `set` | overwrite a whole **section** (Anima mode) |
| `tmp` | temporary tag: visible to later rules, **not** rendered |

## Targets & sections

- **Anima (prose):** `into` / `set`'s **section** write into labelled sections
  (`appearance`, `clothes`, `action`, `focus`, …) or a character block (`character:celica/clothes`).
- **Booru (tags):** everything collapses to one tag list — use `*`.

## Reading the trace

The trace shows *exactly* what fired and why — the engine's most useful feature:

```
> group (celica)
  ? any_of(celica) = true
  = set [clothes] black leather jacket
  + add [appearance] blue eyes
  - remove celica
```

`>` group/switch · `?` condition · `+` add · `-` remove · `=` set · `~` tmp · `x` skipped.

---

## Character sheets: files vs embedded

- **Files** (`rules/celica.yaml`, …) — reusable across workflows, hot-reloaded, selected per node
  via the `sheets` input (`*` = all, or a comma list). The Rule Builder can load/save them.
- **Embedded** — a ruleset stored on the node itself (travels with the workflow `.json`), applied
  **after** the file sheets as per-workflow overrides.

Resolution order: selected file sheets (in order) → embedded.

## Profiles

A profile carries the format conventions (separators, sections, weights) so the *same* rules
behave correctly per model family:

| profile | for | shape |
|---|---|---|
| `anima` | Anima | labelled prose sections, newline-joined |
| `illustrious` / `pony` | Illustrious/Pony | booru tags, comma-joined |
| `flux` / `wan` | Flux/Wan | natural-language prose |
| `raw` | anything | one tag list, no labels |

---

## Worked example — celica

```yaml
- name: celica
  any_of: celica          # fire when the prompt mentions "celica"
  into: "character:celica" # children write into her block
  type: group
  children:
    - remove: celica                                   # the model doesn't know her name
    - set: { section: appearance, to: "short black hair, pixie cut" }
    - none_of: closed eyes
      add: { section: appearance, value: "blue eyes" } # unless her eyes are closed
    - type: switch                                     # pick exactly one outfit
      children:
        - any_of: jacket
          set: { section: clothes, to: "black leather jacket" }
        - any_of: shirt
          set: { section: clothes, to: "black t-shirt" }
        - default: true
          set: { section: clothes, to: "black camisole" }
    - add_negative: "blurry, low quality"
```

Prompt `… celica, jacket …` → celica's appearance filled in, the jacket branch chosen, her
name stripped, quality guards added to negative. The same logic in **booru** mode uses plain
`add`/`into: "*"` instead of sections — see `src/prompt_rules/schema/examples/celica.booru.yaml`.

---

## Beta limitations (v1)

- **Anchors** (`after`/`before` a specific phrase) parse but currently **append** to the
  target block/section instead of slotting in at the phrase. Section targeting is the
  recommended way to place tags precisely.
- **Weights** like `(tag:1.2)` are treated as opaque text (kept, not recombined).
- New sections are appended rather than inserted in a canonical order.

These are planned enhancements. The full format spec — including the parts the card UI doesn't
surface (regex conditions, raw selectors, nested boolean trees) — is in
[`src/prompt_rules/schema/SCHEMA.md`](../src/prompt_rules/schema/SCHEMA.md); a compact reference is
[rules-reference.md](rules-reference.md).
