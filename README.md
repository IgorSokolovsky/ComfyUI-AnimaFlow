# AnimaFlow

**A lightweight, quality-of-life ComfyUI node pack for the [Anima](https://civitai.com/models/932505) model** — and for prompt work in general. Author your character once as declarative rules, build and combine prompts without walls of text, and keep everything consistent across every scene.

> [!NOTE]
> **Beta.** Every node is marked experimental in ComfyUI. Things may change between versions. Feedback and issues are very welcome.

---

## What's inside

- **🎛️ Rule Builder** — a visual editor for **prompt-transform rules**. Define your character/outfit/scene logic as declarative rules; the engine rewrites your prompt before it's encoded. Works for **Anima labelled-prose** *and* **booru tags**. → [**docs/rule-builder.md**](docs/rule-builder.md)
- **✍️ Prompt tools** — Prompt Builder (templated `{wildcards}` → live fields) and Prompt Combiner (named sockets → one prompt).
- **🎬 Scene & panel tools** — Scene Creator, LLM Panels, Panel Parser, Save Panel (metadata) — a small webtoon/comic pipeline.
- **🌸 Anima helpers** — Anima Generator, Detailer Align Hook, Image Scale, Preview.
- **⌨️ Tag autocomplete** — Danbooru/e621 autocomplete wired into text widgets across the pack.

All node UIs share one **house theme** (dark slate + teal) so the pack feels like a single tool.

---

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/IgorSokolovsky/ComfyUI-AnimaFlow
cd ComfyUI-AnimaFlow
pip install -r requirements.txt
# restart ComfyUI
```

> [!IMPORTANT]
> The custom-node folder **must be named `ComfyUI-AnimaFlow`** — the frontend loads its assets from `/extensions/ComfyUI-AnimaFlow/…`. If you rename it, the Rule Builder overlay and pickers won't load. (Cloning as above gives the right name automatically.)

Nodes appear in the node picker under a single **`AnimaFlow`** category (grouped: `prompt`, `scene`, `panel`, `anima`, `io`, `llm`, `rules`).

---

## Quick start — the Rule Builder

1. Add a **Prompt Rules** node (text output) or **Prompt Rules (CLIP)** (conditioning output) — category `AnimaFlow/prompt`.
2. Click **Open Rule Builder** on the node → the overlay opens.
3. Edit rules visually (or start from the sample `celica` sheet); the **live preview** shows the transformed prompt + a **trace** of exactly what fired.
4. Click **Pick…** to insert a character/outfit/background token without memorizing names.
5. Wire the node into your graph and generate.

Character sheets live as `rules/*.yaml` files (reusable) and/or embedded per-workflow. Full walkthrough: [**docs/rule-builder.md**](docs/rule-builder.md).

---

## Documentation

| Guide | What's in it |
|---|---|
| [**docs/rule-builder.md**](docs/rule-builder.md) | The Rule Builder + prompt-rules engine — concepts, the overlay, the picker, character sheets, worked examples. |
| [**docs/rules-reference.md**](docs/rules-reference.md) | Complete rule reference — every rule type, condition, target, and profile. |
| [**docs/nodes.md**](docs/nodes.md) | Catalog of every node: inputs, outputs, and what it's for. |
| [`prompt-rules/SCHEMA.md`](prompt-rules/SCHEMA.md) | Deep spec of the ruleset format + Document model (for tinkerers). |

---

## Model-agnostic by design

The prompt tools serve **booru tags** (Illustrious/Pony), **labelled prose** (Anima), and **natural-language** (Flux/Wan). Separators and formatting are profile-driven, so the same rules travel across models. See [docs/rule-builder.md](docs/rule-builder.md).

## Credits & license

The Rule Builder's *concept* was inspired by [ComfyUI-MyOriginalWaifu](https://github.com/Deathspike/ComfyUI-MyOriginalWaifu); AnimaFlow's engine is a **clean-room** reimplementation from its own spec (`prompt-rules/SCHEMA.md`) — no code was copied.

License: see [`LICENSE`](LICENSE).
