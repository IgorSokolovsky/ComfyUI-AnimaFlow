# AnimaFlow

**A lightweight, quality-of-life ComfyUI node pack for the [Anima](https://civitai.com/models/932505) model** — and for prompt work in general. Author your character once as declarative rules, build and combine prompts without walls of text, and keep everything consistent across every scene.

> [!NOTE]
> **Beta.** Every node is marked experimental in ComfyUI. Things may change between versions. Feedback and issues are very welcome.

---

## What's inside

- **🎛️ Rule Builder** — a visual editor for **prompt-transform rules**. Define your character/outfit/scene logic as declarative rules; the engine rewrites your prompt before it's encoded. Works for **Anima labelled-prose** *and* **booru tags**. → [**docs/rule-builder.md**](docs/rule-builder.md)
- **⌨️ Tag autocomplete** — Gelbooru/Danbooru autocomplete wired into text widgets across the pack.

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

Nodes appear in the node picker under a single **`AnimaFlow`** category:

| Group | Nodes |
|---|---|
| `AnimaFlow/anima_prompt` | Prompt Rules, Prompt Rules (CLIP) |

Two nodes in total; both are catalogued with their inputs and outputs in [**docs/nodes.md**](docs/nodes.md).

---

## Run on Google Colab

If you run ComfyUI on Colab rather than locally, the repo ships a **launcher control panel** — an
ipywidgets UI that replaces the usual stack of setup cells with one form: pick node packs, install
deps, download models, start the server, and watch the live log.

**Files:** [`playground/colab_launcher_cells.py`](playground/colab_launcher_cells.py) (the real
cells — copy/paste into Colab) and [`playground/colab-launcher.html`](playground/colab-launcher.html)
(a static preview of the UI you can open in a browser first).

**Setup** — paste each of the three marked blocks into its own Colab cell, in order:

| Cell | What it does |
|---|---|
| **1 — Drive mount** | Mounts Google Drive and creates the folder tree under `MyDrive/ComfyUI`. Kept separate because it needs Google auth. |
| **2 — Backend** | Defines the launcher logic. Run once per runtime. |
| **3 — Control panel** | Renders the UI. |

Set cells 2 & 3 to **Form view** (⋮ → *Form* → *Hide code*) to get the clean, code-hidden panel.

**What the panel gives you:** environment setup (clone/symlink ComfyUI against Drive) · node-pack
checklist with add-your-own-repo · extra pip packages · model downloader with present/missing
detection · launch + [pinggy](https://pinggy.io) tunnel for a public URL · live server log · config editor.

> [!TIP]
> **Everything persists across runtimes.** Panel state lives in `MyDrive/ComfyUI/launcher_config.json`,
> and node dependencies install into a version-tagged `MyDrive/ComfyUI/py_deps/pyX.Y` folder that's
> re-registered each session — so you install a pack's requirements *once*, not every time Colab
> wipes the VM.

> [!NOTE]
> The launcher is **general-purpose ComfyUI-on-Colab tooling**, not AnimaFlow-specific — it manages
> whatever packs you list (AnimaFlow is enabled in the default list). It lives under `playground/`
> and is offered as-is; the node pack itself does not depend on it.

---

## Quick start — the Rule Builder

1. Add a **Prompt Rules** node (text output) or **Prompt Rules (CLIP)** (conditioning output) — category `AnimaFlow/anima_prompt`.
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
| [`src/prompt_rules/schema/SCHEMA.md`](src/prompt_rules/schema/SCHEMA.md) | Deep spec of the ruleset format + Document model (for tinkerers). |

---

## Model-agnostic by design

The prompt tools serve **booru tags** (Illustrious/Pony), **labelled prose** (Anima), and **natural-language** (Flux/Wan). Separators and formatting are profile-driven, so the same rules travel across models. See [docs/rule-builder.md](docs/rule-builder.md).

## Credits & license

AnimaFlow is **MIT** licensed — see [`LICENSE`](LICENSE). It stands on two other projects, in two very different ways:

**[ComfyUI-EasyUseAnima](https://github.com/n0va39/ComfyUI-EasyUseAnima)** (MIT, © 2026 n0va39) — this pack's tag-autocomplete and tag-highlighting/classify service derive from this project, with logic copied and adapted under its MIT license. Thank you to n0va39: the booru-autocomplete approach and the classify logic behind prompt highlighting both originate there. (AnimaFlow previously also carried a leaner port of this pack's generation/conditioning node line; that line has been removed for now and will be re-derived node-by-node from this same upstream in a future build.)

**[ComfyUI-MyOriginalWaifu](https://github.com/Deathspike/ComfyUI-MyOriginalWaifu)** (GPL-3.0) — **concept inspiration only; no code was copied.** The Rule Builder idea comes from here, but AnimaFlow's engine (`src/prompt_rules/core/`) is a **clean-room** implementation written against its own spec, [`src/prompt_rules/schema/SCHEMA.md`](src/prompt_rules/schema/SCHEMA.md), and is architecturally different (a Document tree with profiles and selectors, versus a flat weighted tag list). Since that project is copyleft, this boundary is what keeps AnimaFlow MIT — please don't copy code across it.

Full notices, and a per-file breakdown of what derives from where: [**THIRD_PARTY_NOTICES.md**](THIRD_PARTY_NOTICES.md).
