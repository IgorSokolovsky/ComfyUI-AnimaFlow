# Third-party notices

AnimaFlow is MIT-licensed (see [`LICENSE`](LICENSE)). It includes work derived from
the projects below, whose notices are reproduced here as their licenses require.

---

## ComfyUI-EasyUseAnima

- **Upstream:** https://github.com/n0va39/ComfyUI-EasyUseAnima
- **License:** MIT
- **Relationship:** AnimaFlow's tag-autocomplete service derives from this pack's
  booru-autocomplete approach. Logic was directly copied and adapted under the MIT
  license. An earlier `AnimaFlow/anima` node line — a leaner port of this pack's
  generation/conditioning pipeline — was removed from this repo and has now been
  re-derived, node-by-node, as the **Anima Generator + Anima Preview** pair
  (`src/anima/`, `nodes/anima/`; contract: `docs/generator-design.md`) — the rows below
  cover that rebuild specifically.

**What is derived from it** (individual files carry their own more specific notes):

| AnimaFlow | Derived from |
|---|---|
| `src/autocomplete/`, `js/autocomplete/` | its booru tag-autocomplete approach and the tag-name → prompt-text normalization intent (`anima_prompt/normalize.py`) |
| `src/autocomplete/classify.py` | `/wtn/classify` tag-highlighting classifier, ported from `autocomplete_dataset.py`'s `classify_prompt_text()`/`_token_section()` and `anima_prompt/ordering.py`'s builtin ANIMA vocab (`QUALITY_TAGS` etc.) — re-labeled in English and rewritten to track exact character offsets into the original text instead of upstream's destructive pre-normalization |
| `src/anima/loras.py` | `easyuse_anima/aio/model_preparation.py:164-236`'s `_normalize_aio_lora_stack`/zero-strength-skip policy — widened to accept 2-element list/tuple entries (upstream requires >= 3), defaulting `strength_clip` to `strength_model` |
| `src/anima/postprocess.py` | `easyuse_anima/aio/postprocess.py:42-86`'s `_aio_final_fit_size` output-size-cap maths (the old deleted port's "only ever rounds up" bug, fixed here) |
| `src/anima/usdu.py` | `easyuse_anima/aio/usdu.py`'s `_aio_usdu_auto_tile_dimension`/`_aio_usdu_tile_plan` USDU tile-planning maths |
| `src/anima/settings.py` (defaults tree) | `easyuse_anima/aio/generation_defaults.py`'s `AIO_GENERATION_DEFAULT_SETTINGS`, trimmed to the five stages this pack ships, with the two `guide_size_for`/`noise_mask_feather` divergences already fixed in the defaults themselves |
| `src/anima/sampler.py` | `easyuse_anima/aio/sampling.py:378-436`'s `inherit_sampler_settings` field-coverage semantics |
| `src/anima/pipeline.py` | call shapes read from `easyuse_anima/aio/model_preparation.py` (`ModelSamplingAuraFlow`/`LoraLoader` invocation), `easyuse_anima/prompt/conditioning.py:85-138` (`AnimaModGuidance.patch()`'s defensive old/new-signature probe), and `easyuse_anima/image/sam3.py` + `easyuse_anima/nodes/{sam3_nodes,impact_detailer_nodes}.py` (the per-block `SAM3_Detect` -> `MaskToSEGS` -> `DetailerForEach` chain, including the `_call_impact_detailer`-style kwargs-filtering call) |
| `nodes/anima/_preview_helpers.py`'s `write_temp_stage_images` | `easyuse_anima/aio/preview.py`'s `_save_aio_temp_preview_image` -- the `folder_paths.get_temp_directory()` + `folder_paths.get_save_image_path()` + random-suffixed prefix mechanism for writing an ephemeral preview copy of a stage that isn't being saved this run, simplified to plain PNG (that pack's WebP preview-cache format has no equivalent here) |
| `src/anima/resources.py` (`UNET_NAME_CANDIDATES`/`CLIP_NAME_CANDIDATES`/`VAE_NAME_CANDIDATES`, `preferred_name_default`) | `easyuse_anima/aio/input_defaults.py:6-15`'s candidate tuples, verbatim, and `easyuse_anima/aio/resources.py:114-128`'s `_preferred_name_default` semantics (exact match, then basename-insensitive fallback, then `names[0]`) -- reimplemented rather than copy-pasted, normalizing basenames toward forward slash instead of upstream's backslash, same net effect |

```
MIT License

Copyright (c) 2026 n0va39

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ComfyUI-Pixaroma

- **Upstream:** local clone at `../ComfyUI-Pixaroma`
- **License:** MIT
- **Relationship:** the Control Panel + Loader Panel nodes (`nodes/controls/`) port two
  specific patterns from `PixaromaSliders` (`nodes/node_sliders.py`, `nodes/
  _type_helpers.py`), per the approved design (`docs/control-panel-design.md` §1): the
  wildcard-`ANY` output-typing trick (a fixed `RETURN_TYPES = (ANY,) * MAX_ROWS`, letting a
  single Python output slot accept/emit any wire type while the frontend narrows the
  *visible* slot type per row) and the state-in-a-widget shape (one JSON blob describing
  every row, read back out in `run()` and mapped onto the fixed output tuple). The state
  *handshake* itself (how the JSON gets from the browser into Python) is deliberately NOT
  copied -- see the design doc §1 "Deliberately NOT copied" for why Pixaroma's
  `graphToPrompt`-injected `hidden` input was replaced with a declared, natively-serialized
  STRING widget here.

**What is derived from it:**

| AnimaFlow | Derived from |
|---|---|
| `nodes/controls/_type_helpers.py` | `nodes/_type_helpers.py`'s `AnyType`/`ANY` |
| `nodes/controls/control_panel.py`, `nodes/controls/loader_panel.py` (fixed `MAX_ROWS`, `RETURN_TYPES`/`RETURN_NAMES` built from it, per-slot value resolution over a parsed JSON state) | `node_sliders.py`'s `PixaromaSliders` (`MAX_SLIDERS`, its `RETURN_TYPES`/`RETURN_NAMES` construction, and its `_value_of`-style non-finite-guarded numeric clamp, adapted in `nodes/controls/_rows_helpers.py`) |
| `js/shared/canvas_zoom.mjs` (mouse-wheel-zooms-the-canvas-through-a-DOM-widget fix, wired into `js/controls/`, `js/prompt_rules/node/` and `js/anima/`) | `js/shared/canvas_zoom.mjs`'s `installCanvasZoomPassthrough`/`scrollRegionWantsWheel` — same rationale and the identical per-direction scroll-vs-zoom logic, adapted to read the live `app`/canvas via an injectable getter instead of a static `/scripts/app.js` import (so the ported file stays importable under this pack's plain-`node` test suite). The quiet-period lock on top of it (a consumed wheel suppresses canvas zoom for `WHEEL_LOCK_MS`, so reaching the end of a scroll region mid-gesture doesn't lurch into zooming) is ours, not upstream's |
| The **DOM-widget sizing mechanism** every custom-UI node here uses: `getMinHeight` for the legacy canvas renderer + `computeLayoutSize`/`minWidth: 1` for Nodes 2.0, the rAF-timed content measure, the grow-biased refit with a user-enlarge guard, and substituting a FIXED floor for a flex-fill child instead of its stretched `offsetHeight` (`js/prompt_rules/node/render.mjs`, `js/anima/render.mjs`, `js/controls/render.mjs`) | `js/find_replace/{index.js,render.mjs}` — the reference implementation this pack's sizing is modeled on. `find_replace` is also this pack's aesthetic reference (`.claude/CLAUDE.md`) |
| `js/controls/interaction.mjs`'s `alignOutputsLegacy` (parking each row's output socket dot on that row's own Y, rather than in litegraph's slot column) | `js/sliders/ui.mjs`'s `alignOutputsLegacy` — same `output.pos`-verbatim approach and the same `DEFAULT_MARGIN` inset correction, re-keyed here by `row.slot - 1` instead of positional index so reordering a row moves only its dot's Y, never which `node.outputs` entry it owns |
| `js/shared/node_chrome.mjs` (`applyNodeChrome` — painting the litegraph node body + title strip in the house theme, fill-only-if-still-null so a user's own right-click → Colors pick is never clobbered) | `js/note/render.mjs`'s `renderContent` — same reasoning, including that litegraph *serializes* `node.color`/`bgcolor` the moment either is set |
| [`docs/pixaroma-review-rounds-plan.md`](docs/pixaroma-review-rounds-plan.md) — a checklist of already-diagnosed bugs to audit our `js/controls/` against | Seven rounds of review fixes pixaroma made to `PixaromaSliders` between our port point and v1.4.62 (+1360 lines on that node). No code copied — the *findings* are mined, because several of them bite any node built the way ours is |
| `js/shared/graph_loading.mjs` (`isGraphLoading()` — the shared "a workflow is currently being loaded" guard, wired into `js/anima/index.js`'s `setupNode` so it never floors a RESTORED node's size up to its fresh-node default) | `js/shared/graph_loading.mjs`'s `isGraphLoading()` — same `app.loadGraphData` wrap-once + trailing-window approach, ported near-verbatim (renamed the wrap guard to this pack's own `app._wtnGraphLoadWrapped`) |

```
MIT License

Copyright (c) 2026 pixaroma

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## ComfyUI-MyOriginalWaifu

- **Upstream:** https://github.com/Deathspike/ComfyUI-MyOriginalWaifu
- **License:** GPL-3.0
- **Relationship:** **concept inspiration only — no code was copied.** AnimaFlow's
  prompt-rules engine (`src/prompt_rules/core/`) is a clean-room implementation written
  against its own spec, [`src/prompt_rules/schema/SCHEMA.md`](src/prompt_rules/schema/SCHEMA.md), and is architecturally
  distinct (a `Document`/`Block`/`Item` tree with profiles and selectors, versus a flat
  weighted tag list). The rule *vocabulary* is kept broadly compatible
  (`any_of`/`all_of`/`none_of`, `tag`/`group`/`switch`/`swap`) so authors familiar with
  that format can transfer, but the implementation shares no source.

> [!IMPORTANT]
> This distinction is deliberate and load-bearing. GPL-3.0 is a copyleft license:
> deriving from that code would require AnimaFlow to be GPL-3.0 as well. Because the
> engine is an independent implementation rather than a derivative work, AnimaFlow
> remains MIT. Please preserve that boundary — do not copy code from that project into
> this one.
