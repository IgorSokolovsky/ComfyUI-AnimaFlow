# Third-party notices

AnimaFlow is MIT-licensed (see [`LICENSE`](LICENSE)). It includes work derived from
the projects below, whose notices are reproduced here as their licenses require.

---

## ComfyUI-EasyUseAnima

- **Upstream:** https://github.com/n0va39/ComfyUI-EasyUseAnima
- **License:** MIT
- **Relationship:** AnimaFlow's `AnimaFlow/anima` node line is a **deliberately leaner
  port** of this pack. Logic was directly copied and adapted under the MIT license.

**What is derived from it** (individual files carry their own more specific notes):

| AnimaFlow | Derived from |
|---|---|
| `nodes/anima/node_anima_image_scale.py`, `_anima_image_scale_helpers.py` | its image-scaling utility, incl. the aspect-preserving nearest-valid-ratio search (`easyuse_anima/image/{scaling,geometry}.py`) |
| `nodes/anima/node_anima_detailer_hook.py`, `_anima_detailer_hook_helpers.py` | its Impact-Pack-compatible detailer hook |
| `nodes/anima/node_anima_generator.py`, `_anima_generator_helpers.py` | the staged AiO pipeline (first pass → highres → detailer → upscale → postprocess → save) and the AuraFlow model-sampling shift default |
| `nodes/anima/node_anima_conditioning_encode.py`, `_anima_conditioning_helpers.py` | its artist-mix conditioning concept (reduced here to a single weighted-average blend mode) |
| `nodes/anima/node_anima_regional_conditioning.py`, `node_anima_region_mask_editor.py` (+ helpers) | its regional-conditioning and mask-editor approach, incl. the `MASK` tensor convention |
| `autocomplete/`, `js/autocomplete/` | its booru tag-autocomplete approach and the tag-name → prompt-text normalization intent (`anima_prompt/normalize.py`) |

Not ported (deliberately): the bundled input-context node, the embedded live-preview
widget, the JSON settings-profile system, the multi-mode artist-mix system, the
SAM3-specific detector wrapper, the wildcard engine, NAIA integration, the
translation layer, the seed-reservation service, and the global settings substrate.

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

## ComfyUI-MyOriginalWaifu

- **Upstream:** https://github.com/Deathspike/ComfyUI-MyOriginalWaifu
- **License:** GPL-3.0
- **Relationship:** **concept inspiration only — no code was copied.** AnimaFlow's
  prompt-rules engine (`core/`) is a clean-room implementation written against its own
  spec, [`prompt-rules/SCHEMA.md`](prompt-rules/SCHEMA.md), and is architecturally
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
