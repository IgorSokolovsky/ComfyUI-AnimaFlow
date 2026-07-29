# AnimaFlow

**A lightweight, quality-of-life ComfyUI node pack for the [Anima](https://civitai.com/models/932505) model** — and for prompt work in general. Author your character once as declarative rules, build and combine prompts without walls of text, and keep everything consistent across every scene.

> [!NOTE]
> **Beta.** Every node is marked experimental in ComfyUI. Things may change between versions. Feedback and issues are very welcome.

---

## What's inside

Seven nodes across three tracks:

- **🎛️ Rule Builder** — a visual editor for **prompt-transform rules**. Define your character/outfit/scene logic as declarative rules; the engine rewrites your prompt before it's encoded. Works for **Anima labelled-prose** *and* **booru tags**. → [**docs/rule-builder.md**](docs/rule-builder.md)
  *`Prompt Rules`, `Prompt Rules (CLIP)`*
- **🎚️ Control Panel + Loader Panel** — one node holding as many labelled controls as you want (seeds, ints, floats, samplers, schedulers, empty latents; UNET/VAE/CLIP loaders in the Loader variant), each with its own output socket parked on its own row. Drag to reorder, and a fresh row adopts the type, range and name of whatever you first plug it into. → [**docs/control-panel-design.md**](docs/control-panel-design.md)
  *`Anima Control Panel`, `Anima Loader Panel`*
- **🖼️ Generator + Preview** — the whole txt2img pipeline (first pass → highres → detailer → upscale → postprocess) behind one node with inline settings sections, fed by a **Context Bridge** that bundles model/clip/vae/conditioning/sampler settings into one wire. The Preview node compares two stage images with a hover wipe and owns saving, so `base`/`mid`/`final` can be saved under different names. → [**docs/generator-design.md**](docs/generator-design.md)
  *`Anima Context Bridge`, `Anima Generator`, `Anima Preview`*
- **⌨️ Tag autocomplete** — Gelbooru/Danbooru autocomplete wired into text widgets across the pack.

All node UIs share one **house theme** (dark slate + teal) so the pack feels like a single tool — see [**docs/THEME.md**](docs/THEME.md).

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

Nodes appear in the node picker under **`AnimaFlow/…`**, one sub-category per track:

| Group | Nodes |
|---|---|
| `AnimaFlow/Prompt` | Prompt Rules, Prompt Rules (CLIP) |
| `AnimaFlow/Controls` | Anima Control Panel, Anima Loader Panel |
| `AnimaFlow/Anima` | Anima Context Bridge, Anima Generator, Anima Preview |

Seven nodes in total (registered in [`__init__.py`](__init__.py)); all are catalogued with their
inputs and outputs in [**docs/nodes.md**](docs/nodes.md).

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

1. Add a **Prompt Rules** node (text output) or **Prompt Rules (CLIP)** (conditioning output) — category `AnimaFlow/Prompt`.
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
| [**docs/control-panel-design.md**](docs/control-panel-design.md) | The Control Panel + Loader Panel — why one node per many controls, per-row output typing, the design decisions and why several reversed. |
| [**docs/generator-design.md**](docs/generator-design.md) | The Generator + Preview + Context Bridge — stage order, the settings blob, the hover-wipe compare, and where saving lives. |
| [**docs/settings.md**](docs/settings.md) | The **AnimaFlow** section in ComfyUI's Settings dialog — all seven settings, what each one reaches, and why console logging defaults to off. |
| [**docs/THEME.md**](docs/THEME.md) | The house theme: tokens, the `.wtn-*` class vocabulary, and the gotchas of styling a node UI inside ComfyUI. |
| [`src/prompt_rules/schema/SCHEMA.md`](src/prompt_rules/schema/SCHEMA.md) | Deep spec of the ruleset format + Document model (for tinkerers). |

---

## Model-agnostic by design

The prompt tools serve **booru tags** (Illustrious/Pony), **labelled prose** (Anima), and **natural-language** (Flux/Wan). Separators and formatting are profile-driven, so the same rules travel across models. See [docs/rule-builder.md](docs/rule-builder.md).

## Credits & license

AnimaFlow is **MIT** licensed — see [`LICENSE`](LICENSE). It stands on three other projects, in three very different ways:

**[ComfyUI-Pixaroma](https://github.com/pixaroma/ComfyUI-Pixaroma)** (MIT, © 2026 pixaroma) — **the reason this pack's node UIs work at all.** Every custom-DOM node here is built on patterns worked out in that project, ported under its MIT license with thanks to pixaroma: the DOM-widget sizing mechanism our nodes' bodies depend on (from its `find_replace` node), the wildcard-`ANY` output-typing trick and state-in-a-widget shape behind the Control Panel (from `PixaromaSliders`), parking a row's output socket on its own row (`alignOutputsLegacy`, from its `sliders` node), the wheel-zooms-the-canvas-through-a-DOM-widget fix (`js/shared/canvas_zoom.mjs`), and the themed node chrome (from its `note` node). Its `find_replace` node is also this pack's aesthetic reference, and seven rounds of review bugs it already found and fixed are being mined for ours in [`docs/pixaroma-review-rounds-plan.md`](docs/pixaroma-review-rounds-plan.md) — several of those bugs bite any node built this way, and finding them pre-fixed in someone else's working code saved real debugging here.

**[ComfyUI-EasyUseAnima](https://github.com/n0va39/ComfyUI-EasyUseAnima)** (MIT, © 2026 n0va39) — this pack's tag-autocomplete and tag-highlighting/classify service derive from this project, with logic copied and adapted under its MIT license. Thank you to n0va39: the booru-autocomplete approach and the classify logic behind prompt highlighting both originate there. The **Generator + Preview + Context Bridge** line is also re-derived from this upstream — its stage order (detailer *before* upscale, which is not obvious and is right), per-stage sampler overrides, the hover-wipe compare, and its tuned stage defaults. The rest of that line (Conditioning Encode, Detailer Align Hook, Image Scale, Region Mask Editor, Regional Conditioning) is still to be re-derived node by node.

**[ComfyUI-MyOriginalWaifu](https://github.com/Deathspike/ComfyUI-MyOriginalWaifu)** (GPL-3.0) — **concept inspiration only; no code was copied.** The Rule Builder idea comes from here, but AnimaFlow's engine (`src/prompt_rules/core/`) is a **clean-room** implementation written against its own spec, [`src/prompt_rules/schema/SCHEMA.md`](src/prompt_rules/schema/SCHEMA.md), and is architecturally different (a Document tree with profiles and selectors, versus a flat weighted tag list). Since that project is copyleft, this boundary is what keeps AnimaFlow MIT — please don't copy code across it.

Full notices, and a per-file breakdown of what derives from where: [**THIRD_PARTY_NOTICES.md**](THIRD_PARTY_NOTICES.md).
