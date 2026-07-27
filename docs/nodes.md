# Node catalog

Every node in AnimaFlow, grouped by its node-picker category. All nodes are **Beta**
(marked experimental in ComfyUI). Add them from the picker under **`AnimaFlow/…`**.

> Legend: **In** = key inputs · **Out** = outputs · italics = optional.

---

## `AnimaFlow/Prompt`

Anima-specific prompt authoring — rule-transform prompts, authored via the visual Rule Builder.

### Prompt Rules  ·  Prompt Rules (CLIP)
Apply declarative **prompt-transform rules** (character sheets) to your positive/negative
prompt before encoding. The **text** variant returns strings; the **CLIP** variant also
encodes to conditioning. → full guide: [rule-builder.md](rule-builder.md)
- **In:** `positive`, `negative` (multiline), `profile` (anima / illustrious / flux / raw), `sheets` (which `rules/*.yaml` to apply; `*` = all), *`embedded_rules`* (per-node ruleset from the Rule Builder), *`log_trace`*; CLIP variant also needs `clip`
- **Out:** text → `positive`, `negative` (STRING) · CLIP → `positive`, `negative` (CONDITIONING)
- Buttons: **Open Rule Builder**, **Pick…** (insert a character/outfit/background token)

---

## `AnimaFlow/Controls`

One place for every dial you actually touch. Rows come from a fixed catalog; each row gets its
own output slot, with the dot parked on that row. → design + rationale:
[control-panel-design.md](control-panel-design.md)

### Anima Control Panel
Value rows: **sampler**, **scheduler**, **seed**, **int**, **float**, **empty latent**, plus
**Auto** (a row that decides what it is from the first input you wire it to). Up to 16 rows.
- **In:** `panel_state` (JSON, written by the node's own UI — not meant to be hand-edited)
- **Out:** `value_1` … `value_16`, one per row. Wildcard in Python; the frontend narrows each
  slot's visible type (`INT`, `FLOAT`, `LATENT`, `COMBO`) so a wrong wire is refused at the wire
- Drag the **grip** to reorder rows; **right-click** a row to Rename / Duplicate / Remove;
  **double-click** a label to rename. Drag across an int/float row to set it
- Seed row: the mode button mirrors control-after-generate (`F`/`R`/`I`/`D`); `N` rolls a new
  seed now and holds it fixed
- Latent row's ⚙: **Custom** width/height, or **Predefined** aspect ratio + resolution tier

### Anima Loader Panel
Model rows: **unet**, **vae**, **clip** — each emits a real `MODEL` / `VAE` / `CLIP`. Up to 8 rows.
- **In:** `panel_state` (as above)
- **Out:** `value_1` … `value_8`, narrowed per row to `MODEL` / `VAE` / `CLIP`
- **A row is only loaded if something is wired to it**, so an unused row costs no VRAM. Loaded
  models are cached per row kind and reloaded only when you change the file
- Kept separate from the Control Panel on purpose: ComfyUI caches per *node*, so a seed row in the
  same node as a unet row would reload the model on every seed bump

**Reordering never rewires anything.** A row keeps the output slot it was created with (hover a
dot to see which), so display order and slot order are independent. Deleting a row is the one
operation that frees a slot.

**Using these with Use Everywhere (`cg-use-everywhere`):** UE matches broadcasts by **exact type**.
One row of a given type broadcasts fine, but two rows of the *same* type (two `INT`s, or a
`sampler` and a `scheduler` — both `COMBO`) tie at equal priority, and UE then refuses to send.
Fix it on the UE side: **rename the Anything Everywhere node's input to the destination input's
name** (`seed`, `steps`, `sampler_name`, `scheduler`) — verified working — or use
`Anything Everywhere?` with its `input regex`. UE names its input after the *type* it received, not
after our slot, so this can't be automated from our end.

---

## Tag autocomplete (service, not a node)

A booru **tag autocomplete** popup that attaches automatically to prompt-style text widgets
across the whole pack (name-matched `prompt`/`positive`/`negative`/`_text`/`template`, or any
multiline STRING box). Tiered exact→prefix→substring search over bundled **Gelbooru** (primary)
and **Danbooru** (top-up) data, ranked by popularity. No config — just start typing a tag.
- Route: `GET /wtn/autocomplete?q=&limit=&category=`
