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

## `AnimaFlow/Anima`

The generation pipeline: a **Context Bridge** that bundles resources + sampler scalars into one
wire, a **Generator** that runs the whole txt2img pipeline behind that one input, and a
**Preview** that compares stage images with a hover wipe and owns saving. → design + rationale:
[generator-design.md](generator-design.md)

### Anima Context Bridge
Bundles real `MODEL`/`CLIP`/`VAE`/`CONDITIONING`/`LATENT` objects plus the five sampler scalars
into one `ANIMA_CONTEXT` socket for the Generator. Composes with `AnimaLoaderPanel`'s real
`MODEL`/`VAE`/`CLIP` outputs and with Pixaroma's LoRA loader (LoRAs arrive already baked into
`MODEL`/`CLIP`, upstream of this node).
- **In (all *optional* — nothing is required):** `model` (MODEL), `clip` (CLIP), `vae` (VAE),
  `positive`/`negative` (CONDITIONING, already encoded upstream), `latent` (starting latent —
  falls back to a fixed 1024×1024 default if unwired), `seed`/`steps`/`cfg` (INT/INT/FLOAT,
  `forceInput`), `sampler_name`/`scheduler` (COMBO, `forceInput`)
- **Out:** `context` (`ANIMA_CONTEXT`) — records which fields were actually wired, distinctly
  from a wired field that legitimately produced `None`, so the Generator can report exactly
  what's missing

### Anima Generator
Runs the whole pipeline — first pass → highres → detailer → upscale → postprocess — behind one
node, driven by one `generation_settings` JSON blob edited via expand-in-place sections (Sampler,
Mod Guidance, Highres, Detailer, Upscale, Postprocess — see generator-design.md §12). **Not an
`OUTPUT_NODE`** — a graph with no Preview wired runs nothing at all, since there's no output to
produce without a consumer.
- **In:** `context` (`ANIMA_CONTEXT`, from an Anima Context Bridge), `generation_settings`
  (STRING, hidden-for-rendering, default `"{}"`)
- **Out:** `images` — this run's produced images as a **LIST** (`OUTPUT_IS_LIST`), ordered
  `base, mid, final`, omitting any stage that didn't produce a genuinely different image (so
  length 1–3 depending on which stages ran) · `latent` — the final diffusion latent · `metadata_json`
  — per-stage metadata (resolved sampler values, postprocess fit result, and `stage_labels`,
  the position → stage-name map `AnimaPreview` reads back)

### Anima Preview
Terminal node (`OUTPUT_NODE = True`) — compares two stage images with a hover wipe and **owns
saving**; a graph with no Preview wired therefore runs nothing at all. The hidden `PROMPT` /
`EXTRA_PNGINFO` inputs live here (not on the Generator) so saved images embed workflow + prompt
metadata.
- **In:** `preview_state` (STRING, hidden-for-rendering, default `"{}"` — the compare picker and
  save settings), *`images`* (the Generator's `images` list, wired directly), *`metadata_json`*
  (the Generator's `metadata_json`, so this node can tell which list position is which stage —
  without it, positions fall back to `base`/`mid`/`final` order)
- **Out:** none
- Compare picker defaults to `base` vs `final`; degrades to a plain single-image view if only one
  stage is present this run. Save `which`: the shown image / both compared / every wired input,
  with a `%stage%` filename token so `base`/`mid`/`final` can be saved under different names.

---

## Tag autocomplete (service, not a node)

A booru **tag autocomplete** popup that attaches automatically to prompt-style text widgets
across the whole pack (name-matched `prompt`/`positive`/`negative`/`_text`/`template`, or any
multiline STRING box). Tiered exact→prefix→substring search over bundled **Gelbooru** (primary)
and **Danbooru** (top-up) data, ranked by popularity. No config — just start typing a tag.
- Route: `GET /wtn/autocomplete?q=&limit=&category=`
