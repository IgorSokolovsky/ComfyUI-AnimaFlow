# Node catalog

Every node in AnimaFlow, grouped by its node-picker category. All nodes are **Beta**
(marked experimental in ComfyUI). Add them from the picker under **`AnimaFlow/…`**.

> Legend: **In** = key inputs · **Out** = outputs · italics = optional.

---

## `AnimaFlow/prompt`

### Prompt Builder
Template-driven prompt authoring. Write a template with `{token}` placeholders and fill
each token's value in per-field widgets; good as the single-node base prompt authoring tool.
- **In:** `template` (multiline), `prompt_builder_state` (serialized field values, hidden by the UI)
- **Out:** `prompt` (STRING — labelled prose), `data` (PROMPT_DATA; flat string on `data.prompt`)

### Prompt Combiner
Merges several **named connection inputs** (character, background, style, …) into one prompt
via a template. Use it to fuse outputs of multiple upstream prompt/scene nodes.
- **In:** `template` (multiline, e.g. `{character}, {background}`) + dynamic named sockets (the template's `{tokens}` become inputs; accept STRING or PROMPT_DATA)
- **Out:** `prompt` (STRING), `data` (PROMPT_DATA) · also shows the combined text live on the node

### Prompt Rules  ·  Prompt Rules (CLIP)
Apply declarative **prompt-transform rules** (character sheets) to your positive/negative
prompt before encoding. The **text** variant returns strings; the **CLIP** variant also
encodes to conditioning. → full guide: [rule-builder.md](rule-builder.md)
- **In:** `positive`, `negative` (multiline), `profile` (anima / illustrious / flux / raw), `sheets` (which `rules/*.yaml` to apply; `*` = all), *`embedded_rules`* (per-node ruleset from the Rule Builder), *`log_trace`*; CLIP variant also needs `clip`
- **Out:** text → `positive`, `negative` (STRING) · CLIP → `positive`, `negative` (CONDITIONING)
- Buttons: **Open Rule Builder**, **Pick…** (insert a character/outfit/background token)

---

## `AnimaFlow/scene`

### Scene Creator
Deterministic multi-character **scene** composer: a template with `{wildcards}` plus reserved
`{characters}` and `{backgrounds}` tokens filled from enabled per-item state. Assembles a
structured scene into a labelled-prose document.
- **In:** `template` (multiline), `scene_state` (per-item state, hidden by the UI) + dynamic wired sockets (incl. per-character outfit overrides)
- **Out:** `scene` (STRING — labelled prose), `data` (PROMPT_DATA) · shows composed text + resolved slots on the node

---

## `AnimaFlow/llm`

### LLM Panels
Turns a story/scene **brief** into multi-panel labelled-prose text via an OpenAI-compatible
chat endpoint (OpenRouter by default). Generates the panel script that feeds Panel Parser;
supports story continuation across runs.
- **In:** `brief` (multiline), `api_key`, `model` · *`target_panels`, `base_url`, `system_prompt`, `character_bible`, `previous_panels`, `synopsis`, `temperature`, `max_tokens`, `seed`*
- **Out:** `panels_text`, `synopsis` (STRING)
- Note: makes an outbound HTTPS call (stdlib `urllib`, 120 s timeout); raises with detail on error.

---

## `AnimaFlow/panel`

### Panel Parser (Batch)
Splits multi-panel labelled-prose text into a **per-panel list**, driving a once-per-panel
CLIP → KSampler → Save run in one queue. Pairs downstream of LLM Panels.
- **In:** `panels_text` (multiline) · *`delimiter_regex`, `story_delimiter_regex`, `start_index`*
- **Out:** `panel`, `story`, `panel_index` (per-panel lists), `count` (INT) — `OUTPUT_IS_LIST`

---

## `AnimaFlow/io`

### Save Panel (metadata)
Saves a rendered panel PNG with the **prompt/story embedded as PNG metadata** (never drawn on
the image). Pairs with Panel Parser (runs once per panel). Honors `--disable-metadata`.
- **In:** `images` (IMAGE), `filename_prefix` · *`prompt_text`, `story_text`, `panel_index`*
- **Out:** none (output node — writes files to ComfyUI's output dir)

---

## `AnimaFlow/anima`

### Anima Generator
A **decoupled sampler**: standard ComfyUI sockets in, a first sampling pass + optional
highres-fix pass out. Broadcasts intermediate frames to **Anima Preview** over a named channel
instead of drawing its own preview. *(Beta scope: first pass + highres only; detailer/upscale/
post/save stages are deferred.)*
- **In:** `model`, `vae`, `seed`, `steps`, `cfg`, `denoise`, `sampler_name`, `scheduler`, `width`, `height`, highres controls, `preview_channel` · *`clip`, `positive`/`negative` (COND or `*_text`), `latent`, `lora_stack`*
- **Out:** `image` (IMAGE), `latent` (LATENT), `metadata` (STRING — JSON of settings)

### Anima Preview
Display-only node that renders the **live feed** broadcast by Anima Generator on a matching
channel, in its own resizable widget. Watch in-progress frames separate from the generator.
- **In:** `channel` (STRING) · **Out:** none (output node; live feed arrives over a websocket event)

### Anima Image Scale By Multiple
Highres-fix scaling utility: rounds an image **up** to the nearest aspect-preserving,
multiple-aligned size (optionally capped by `max_long_edge`) so dimensions stay latent-safe.
- **In:** `image` (IMAGE), `multiple` (INT, def 64), `max_long_edge` (0 = off), `upscale_method`
- **Out:** `image`, `width`, `height`, `scale_factor`

### Anima Detailer Align Hook
Builds an Impact-Pack-compatible `DETAILER_HOOK` that rounds the detailer's crop-sampling size
**up** to a multiple (keeps detail crops latent-safe). Wire into any Impact Pack
DetailerForEach `detailer_hook` input. Soft dependency — loads with or without Impact Pack.
- **In:** `size_multiple` (INT, def 64; 0 disables) · *`base_hook` (chain onto)* · **Out:** `detailer_hook`

---

## Tag autocomplete (service, not a node)

A booru **tag autocomplete** popup that attaches automatically to prompt-style text widgets
across the whole pack (name-matched `prompt`/`positive`/`negative`/`_text`/`template`, or any
multiline STRING box — including DOM-widget nodes like Prompt Builder). Tiered
exact→prefix→substring search over bundled Danbooru/e621 data (Gelbooru-primary, Danbooru
top-up), ranked by popularity. No config — just start typing a tag.
- Route: `GET /wtn/autocomplete?q=&limit=&category=`
