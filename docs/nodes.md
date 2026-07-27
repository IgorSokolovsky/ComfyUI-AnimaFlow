# Node catalog

Every node in AnimaFlow, grouped by its node-picker category. All nodes are **Beta**
(marked experimental in ComfyUI). Add them from the picker under **`AnimaFlow/…`**.

> Legend: **In** = key inputs · **Out** = outputs · italics = optional.

---

## `AnimaFlow/anima_prompt`

Anima-specific prompt authoring — rule-transform prompts, authored via the visual Rule Builder.

### Prompt Rules  ·  Prompt Rules (CLIP)
Apply declarative **prompt-transform rules** (character sheets) to your positive/negative
prompt before encoding. The **text** variant returns strings; the **CLIP** variant also
encodes to conditioning. → full guide: [rule-builder.md](rule-builder.md)
- **In:** `positive`, `negative` (multiline), `profile` (anima / illustrious / flux / raw), `sheets` (which `rules/*.yaml` to apply; `*` = all), *`embedded_rules`* (per-node ruleset from the Rule Builder), *`log_trace`*; CLIP variant also needs `clip`
- **Out:** text → `positive`, `negative` (STRING) · CLIP → `positive`, `negative` (CONDITIONING)
- Buttons: **Open Rule Builder**, **Pick…** (insert a character/outfit/background token)

---

## Tag autocomplete (service, not a node)

A booru **tag autocomplete** popup that attaches automatically to prompt-style text widgets
across the whole pack (name-matched `prompt`/`positive`/`negative`/`_text`/`template`, or any
multiline STRING box). Tiered exact→prefix→substring search over bundled **Gelbooru** (primary)
and **Danbooru** (top-up) data, ranked by popularity. No config — just start typing a tag.
- Route: `GET /wtn/autocomplete?q=&limit=&category=`
