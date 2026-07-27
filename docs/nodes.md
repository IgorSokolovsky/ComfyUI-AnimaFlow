# Node catalog

Every node in AnimaFlow, grouped by its node-picker category. All nodes are **Beta**
(marked experimental in ComfyUI). Add them from the picker under **`AnimaFlow/…`**.

> Legend: **In** = key inputs · **Out** = outputs · italics = optional.

---

## `AnimaFlow/anima_prompt`

Anima-specific prompt authoring — rule-transform and block-compose prompts.

### Prompt Rules  ·  Prompt Rules (CLIP)
Apply declarative **prompt-transform rules** (character sheets) to your positive/negative
prompt before encoding. The **text** variant returns strings; the **CLIP** variant also
encodes to conditioning. → full guide: [rule-builder.md](rule-builder.md)
- **In:** `positive`, `negative` (multiline), `profile` (anima / illustrious / flux / raw), `sheets` (which `rules/*.yaml` to apply; `*` = all), *`embedded_rules`* (per-node ruleset from the Rule Builder), *`log_trace`*; CLIP variant also needs `clip`
- **Out:** text → `positive`, `negative` (STRING) · CLIP → `positive`, `negative` (CONDITIONING)
- Buttons: **Open Rule Builder**, **Pick…** (insert a character/outfit/background token)

### Anima Prompt Studio
A **block editor** for prompts: add/remove/reorder labelled blocks (quality / artist /
trigger / general) in two panes (positive, negative), each independently enable-able. Outputs
plain STRING, so it wires into core `CLIPTextEncode`, **Anima Conditioning Encode**, or any
other pack's text node.
- **Pin** a block to bypass rule correction and keep its text **verbatim at its own position**
  — intended for LoRA trigger words that must not be reordered. Non-pinned blocks are joined
  and (optionally) passed through the Prompt Rules engine as one unit.
- **In:** `blocks_state` (serialized block list, authored by the UI), `separator` (def `", "` — use `" "`/`". "`/newline for prose models), `rules_correction_enabled` (def off), *`rules_profile`*, *`rules_sheets`*
- **Out:** `positive`, `negative` (STRING)

---

## `AnimaFlow/anima`

### Anima Loader
Picks the unet / vae / text-encoder in one node and outputs **plain `MODEL`/`CLIP`/`VAE`
sockets** — no bundled context blob, no prompt-data coupling. Defaults are pre-selected for
Anima (an `anima*` diffusion model, the Qwen-Image VAE, a Qwen text encoder). Loading is
delegated to core's own `UNETLoader`/`CLIPLoader`/`VAELoader`.
- **In:** `unet_name`, `vae_name`, `clip_name`, `clip_type` (def `qwen_image` — Anima's text
  encoder is Qwen-based), `weight_dtype`
- **Out:** `model` (MODEL), `clip` (CLIP), `vae` (VAE)

### Anima Generator
A **decoupled sampler**: standard ComfyUI sockets in, a staged pipeline out. Broadcasts
intermediate frames to **Anima Preview** over a named channel instead of drawing its own
preview. Six stages, each independently toggleable: **first pass → highres → detailer →
upscale → postprocess-resize → save**. The detailer stage soft-imports Impact Pack (wire any
detector's `segs`); the upscale stage soft-imports USDU or ResShift (your choice) — both load
fine with or without those packs installed.
- **In:** `model`, `vae`, `seed`, `steps`, `cfg`, `denoise`, `sampler_name`, `scheduler`, `width`, `height`, `shift`, `preview_channel`, plus per-stage controls (`highres_*`, `detailer_*`, `upscale_*`, `postprocess_*`, `save_*`) · *`clip`, `positive`/`negative` (COND or `*_text`), `latent`, `lora_stack`, `segs`, `detailer_hook`*
- **Out:** `image` (IMAGE), `latent` (LATENT), `metadata` (STRING — JSON of settings)
- `shift` (def **3.0**) applies **`ModelSamplingAuraFlow`** to the incoming model — Anima is an
  AuraFlow-architecture model and expects this. Set `shift` to **0.0** to skip it if you already
  wire a `ModelSamplingAuraFlow` node upstream, otherwise it gets applied twice.
- `highres_scale_by` (def **1.5**) is the real highres multiplier. Sizes are aligned to
  `highres_multiple`, targeting the requested scale as closely as alignment allows — so a
  ratio that can't hit it exactly drifts the aspect slightly (<2%) rather than overshooting
  (e.g. 832×1216 → 1280×1856, 1.53×).

### Anima Preview
Display-only node that renders the **live feed** broadcast by Anima Generator on a matching
channel, in its own resizable widget. Watch in-progress frames separate from the generator.
- **In:** `channel` (STRING) · **Out:** none (output node; live feed arrives over a websocket event)

### Anima Image Scale By Multiple
Highres-fix scaling utility: enlarges an image by `scale_by` and aligns both dimensions to
`multiple` (optionally capped by `max_long_edge`) so sizes stay latent-safe.
- **In:** `image` (IMAGE), `scale_by` (FLOAT, def 1.5), `multiple` (INT, def 64), `max_long_edge` (0 = off), `upscale_method`
- **Out:** `image`, `width`, `height`, `scale_factor`
- `scale_by` **1.0** means *align only, don't enlarge* (exact aspect ratio, round up to the
  next aligned size). Above 1.0 it targets that scale as closely as alignment permits,
  accepting <2% aspect drift instead of overshooting to the next exact-ratio multiple.

### Anima Detailer Align Hook
Builds an Impact-Pack-compatible `DETAILER_HOOK` that rounds the detailer's crop-sampling size
**up** to a multiple (keeps detail crops latent-safe). Wire into any Impact Pack
DetailerForEach `detailer_hook` input. Soft dependency — loads with or without Impact Pack.
- **In:** `size_multiple` (INT, def 64; 0 disables) · *`base_hook` (chain onto)* · **Out:** `detailer_hook`

### Anima Conditioning Encode
CLIP-encodes a positive/negative prompt pair, with optional **artist mix**: instead of just
concatenating artist tags into the text (where they get diluted among many other tokens), each
listed artist is encoded as its own conditioning and blended into the positive conditioning as
a weighted average. Takes plain strings, so it works with any prompt source.
- Artist mix is **positive-only** (the negative pane is always a plain encode). Off by default,
  in which case the result is a plain encode identical to core `CLIPTextEncode`.
- **In:** `clip`, `positive`, `negative` (multiline), `artist_mix_enabled` (def off), *`artist_tags`* (`name:weight` comma list, e.g. `@wlop:1.0, @sakimichan:0.6`; weight optional, defaults 1.0), *`artist_mix_strength`* (def 1.0 — scales the whole artist contingent against the base prompt)
- **Out:** `positive`, `negative` (CONDITIONING)

### Anima Region Mask Editor
Draw **rect / ellipse regions** on a canvas (drag to move, corner handle to resize) and get
real `MASK` tensors out — up to 6. Regions are stored as normalized 0..1 coordinates and
rasterized at the configured canvas size **inside the node**, so no geometry ever crosses the
wire; downstream nodes only ever see tensors.
- All 6 outputs always exist: slots with no authored region return a valid **all-zeros** mask
  (never `None`), so wiring never breaks as you add or remove regions.
- **In:** `canvas_width`, `canvas_height` (INT, def 1024, 64–8192 — match the latent/image size the masks will be used against), `regions` (serialized geometry, authored by the canvas UI)
- **Out:** `mask_1` … `mask_6` (MASK)

### Anima Regional Conditioning
Applies per-region prompts on top of a global one, by attaching ComfyUI's **native**
conditioning-mask metadata (`mask`, `mask_strength`, `set_area_to_bounds`) per region. Masks
arrive pre-rasterized, so this node does no rasterization itself — and it works with masks and
conditioning from **any** source, not just the two nodes above.
- A region pair only takes effect when **both** its `mask_i` and `cond_i` are wired; a
  half-wired pair is silently ignored, so partial wiring is always safe.
- **In:** `positive`, `negative` (CONDITIONING — the global prompt), `mask_strength` (def 1.0, 0–10 — how strongly a region's conditioning overrides the global one inside its mask; 0 disables regional override), `area_mode` (`mask bounds` = restrict attention to each mask's bounding box, cheaper · `default` = soft per-pixel weight over the full canvas), *`mask_1`…`mask_6`* (MASK) + *`cond_1`…`cond_6`* (CONDITIONING)
- **Out:** `positive`, `negative` (CONDITIONING)

---

## Tag autocomplete (service, not a node)

A booru **tag autocomplete** popup that attaches automatically to prompt-style text widgets
across the whole pack (name-matched `prompt`/`positive`/`negative`/`_text`/`template`, or any
multiline STRING box — including DOM-widget nodes like Anima Prompt Studio). Tiered
exact→prefix→substring search over bundled **Gelbooru** (primary) and **Danbooru** (top-up)
data, ranked by popularity. No config — just start typing a tag.
- Route: `GET /wtn/autocomplete?q=&limit=&category=`
