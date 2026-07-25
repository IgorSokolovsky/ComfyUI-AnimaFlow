# Rule Builder — ComfyUI integration contract

How the clean-room engine (`core/`) surfaces in ComfyUI: the encode **nodes**, the
**API routes** the frontend calls, and the **frontend** surfaces (Rule Builder overlay
+ picker popovers). This is the shared interface — nodes (Python) and frontend (JS) are
built against it in parallel; they touch disjoint files.

Namespace placeholder: **`wtn`** (routes `/wtn/rules/*`, CSS `.wtn`, event prefixes) —
renamed once with the pack. House theme + `injectTheme()` from `js/shared/theme.mjs`.

---

## 1. Nodes (keep the original's two variants)

Both apply rulesets, then diverge only on output type.

### `Prompt Rules (CLIP)` → `("CONDITIONING","CONDITIONING")` (positive, negative)
### `Prompt Rules` (text) → `("STRING","STRING")` (positive, negative)

**INPUT_TYPES (required):**
| input | type | notes |
|---|---|---|
| `clip` | `CLIP` | CLIP node only |
| `positive` | `STRING` multiline, dynamicPrompts | |
| `negative` | `STRING` multiline, dynamicPrompts | |
| `profile` | combo | from `core.profiles` — `anima`, `illustrious`, `flux`, `raw` |
| `sheets` | `STRING` | which `rules/*.yaml` sheets to apply; `*` = all enabled, or comma list; default `*` |

**Hidden / widget state:**
- `embedded_rules` — serialized JSON ruleset authored via the builder (the reliable
  serialized-STRING state pattern from the dynamic-node-frontend skill). Applied **after**
  file sheets (per-workflow overrides). Empty = none.
- Button widgets (JS-added): **Open Rule Builder**, **Pick…** (character/outfit/background).

**Resolution order:** selected file sheets (in listed order) → `embedded_rules`. Each is a
ruleset; the engine applies them sequentially to the same document bundle.

**FUNCTION `process`:**
1. `pos, neg = parse(positive, profile), parse(negative, profile)` (or build a bundle).
2. For each resolved ruleset: `apply_ruleset(bundle, ruleset, profile)`.
3. `pos_text, neg_text = render(...)`.
4. CLIP variant: encode both → CONDITIONINGs. Text variant: return the strings.
5. Print the trace to console (opt-in via a boolean `log_trace`, default on) — the
   original's killer feature.

**`IS_CHANGED`** = `sha256(positive + negative + profile + selected-sheet digests + embedded_rules)`
→ re-encode only on real change + free hot-reload of edited sheets (mirrors the original).

Thin nodes: all resolution/loading logic in `nodes/anima_prompt/_rules_helpers.py`; engine stays in `core/`.

---

## 2. API routes (aiohttp via `PromptServer.instance.routes`, registered on import)

All JSON. Prefix `/wtn/rules`. These power the builder + pickers; the engine is called
server-side (no need to reimplement it in JS — the playground's JS engine was only for the
standalone mock; the real overlay prefers these routes and keeps the JS engine as an
offline fallback).

| Method · path | body / query | returns |
|---|---|---|
| `GET /wtn/rules/profiles` | — | `["anima","illustrious","flux","raw"]` |
| `GET /wtn/rules/sheets` | — | `[{name, character?, rules, mtime, size}]` — list of `rules/*.yaml` |
| `GET /wtn/rules/sheet` | `?name=celica` | `{name, ruleset}` (parsed ruleset for editing) |
| `POST /wtn/rules/sheet` | `{name, ruleset}` | validates then writes `rules/<name>.yaml`; `{ok}` or `{ok:false, errors:[{path,message}]}` |
| `DELETE /wtn/rules/sheet` | `?name=celica` | `{ok}` |
| `POST /wtn/rules/validate` | `{ruleset, profile}` | `{ok, errors:[{path,message}]}` |
| `POST /wtn/rules/preview` | `{positive, negative, profile, sheets?[], embedded?}` | `{positive, negative, trace, errors}` — **live preview** for builder + node |
| `GET /wtn/rules/characters` | — | picker data: `[{token, name, character, kind:"character\|outfit\|background\|pose", from}]` derived from sheet metadata |

`trace` shape (matches SCHEMA.md §8): `[{depth:int, kind:"group\|tag\|cond\|add\|remove\|set\|tmp\|skip\|anchor", text:str}]`.
Validation `errors`: `[{path:"celica.yaml -> rules[0](celica).type", message:"…"}]`.

Route handlers live in `api/rules_api.py`, importing `core` + `_rules_helpers`.

---

## 3. Frontend surfaces (house theme, shared classes)

### Rule Builder overlay — `js/anima_prompt/rule_builder/`
Port of `playground/rule-builder.html`, but styled with the shared `.wtn-*` classes
(drop the playground's inline palette; keep only overlay-specific layout). Full-screen
modal over the canvas.
- **Open via both:** a global menu command `Rule Builder` (registered in `index.js` via
  `app.registerExtension` + a menu/command entry) **and** an **Open Rule Builder** button
  on the encode nodes.
- **Two modes:** edit a **file sheet** (load via `GET /sheet`, save via `POST /sheet`) or
  edit the node's **embedded** ruleset (read/write the node's `embedded_rules` widget).
- **Live preview:** on any edit, `POST /preview` with current inputs → render output +
  trace (debounced). Offline fallback: the ported JS engine (from the playground) if the
  route is unreachable, badge "engine offline · preview approximate".
- **Validation:** surfaced inline from `/validate` (or the `errors` in `/preview`).
- Keep the guide + hover tooltips from the playground.

Suggested modules: `index.js` (registerExtension, menu command, `openRuleBuilder(ctx)`),
`overlay.mjs` (modal shell), `cards.mjs` (rule model + card render, ported), `preview.mjs`
(preview + trace render). Shared: `js/shared/api.mjs` (fetch wrappers for the routes),
`js/shared/theme.mjs` (`injectTheme`).

### Picker popover — `js/anima_prompt/prompt_rules/`
Lighter overlay opened by **Pick…** on an encode node. Loads `GET /characters`, groups by
kind, click inserts the `token(s)` into the node's `positive` (or `negative`) text widget.
Modules: `index.js` (adds the two buttons to the node), `picker.mjs` (the popover).

### State & imports
- Node state via the serialized hidden-STRING pattern (skill). Absolute imports for
  subfolder JS (`/scripts/app.js`, `/extensions/<pack>/shared/…`) per the skill's gotcha.
- Legacy litegraph target; DOM-widget resize per the skill.

---

## 4. File layout

```
core/                      # engine (built)
nodes/anima_prompt/prompt_rules.py      # 2 node classes (thin)
nodes/anima_prompt/_rules_helpers.py    # resolve sheets+embedded, call core, digests for IS_CHANGED
api/rules_api.py           # aiohttp routes
rules/                     # character-sheet files (*.yaml)
js/shared/theme.{css,mjs}  # house theme (built)
js/shared/api.mjs          # fetch wrappers
js/anima_prompt/rule_builder/{index.js,overlay.mjs,cards.mjs,preview.mjs}
js/anima_prompt/prompt_rules/{index.js,picker.mjs}
__init__.py                # register nodes + WEB_DIRECTORY="./js"
```

---

## 5. Parallelization (disjoint files → safe concurrency)

- **Track A · Python** (after engine verified): `nodes/`, `api/`, `rules/`, `__init__.py`.
  Imports `core`.
- **Track B · JS** (can start now): `js/anima_prompt/rule_builder/`, `js/anima_prompt/prompt_rules/`, `js/shared/api.mjs`.
  Builds against §2/§3; uses the ported JS engine as offline fallback so the overlay is
  demo-able before Track A lands.

The two tracks share only THIS document, not files.
