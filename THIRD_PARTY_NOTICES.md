# Third-party notices

AnimaFlow is MIT-licensed (see [`LICENSE`](LICENSE)). It includes work derived from
the projects below, whose notices are reproduced here as their licenses require.

---

## ComfyUI-EasyUseAnima

- **Upstream:** https://github.com/n0va39/ComfyUI-EasyUseAnima
- **License:** MIT
- **Relationship:** AnimaFlow's tag-autocomplete service derives from this pack's
  booru-autocomplete approach. Logic was directly copied and adapted under the MIT
  license. (An earlier `AnimaFlow/anima` node line — a leaner port of this pack's
  generation/conditioning pipeline — has since been removed from this repo; it will be
  re-derived node-by-node from this same upstream in a future build, at which point its
  rows will return here.)

**What is derived from it** (individual files carry their own more specific notes):

| AnimaFlow | Derived from |
|---|---|
| `src/autocomplete/`, `js/autocomplete/` | its booru tag-autocomplete approach and the tag-name → prompt-text normalization intent (`anima_prompt/normalize.py`) |
| `src/autocomplete/classify.py` | `/wtn/classify` tag-highlighting classifier, ported from `autocomplete_dataset.py`'s `classify_prompt_text()`/`_token_section()` and `anima_prompt/ordering.py`'s builtin ANIMA vocab (`QUALITY_TAGS` etc.) — re-labeled in English and rewritten to track exact character offsets into the original text instead of upstream's destructive pre-normalization |

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
