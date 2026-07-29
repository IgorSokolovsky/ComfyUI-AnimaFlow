# Control Panel + Loader Panel — design

**Status: being built** (approved 2026-07-27) — this doc is the contract, and the interactive
mockup at [`playground/control-panel.html`](../playground/control-panel.html) is the approved
behavioural reference. The Python backend (`nodes/controls/`) is implemented and tested; the
frontend (`js/controls/`) follows. Opens a second track alongside the Rule Builder line.

A single node that keeps every dial you actually touch — sampler, scheduler, seed, steps, cfg,
resolution — in one place, and wires each one out to the graph. Same idea as Pixaroma's panel,
but rows come from a **fixed catalog of control kinds** instead of being generic numbers.

---

## 1. The upstream reference

`../ComfyUI-Pixaroma` at `5036814` (v1.4.62, pulled 2026-07-27). **The "Control Panel Pixaroma" node
in the screenshot that prompted this line *is* `PixaromaSliders`** — `NODE_DISPLAY_NAME_MAPPINGS =
{"PixaromaSliders": "Control Panel Pixaroma"}` (`nodes/node_sliders.py:112`). Class name unchanged,
display name changed.

> **Correction, 2026-07-27.** Earlier revisions of this section claimed the clone "has no Control
> Panel node" and that the screenshot came from an unreleased version. That was a **false negative**:
> both greps looked at class names and filenames and never at the display-name mapping. There was
> never a missing node. Nothing downstream changes — this doc already treats `PixaromaSliders` as the
> thing being ported, and the kept/not-copied lists below are unaffected — but the lesson is worth
> keeping: in a ComfyUI pack, **the name a user sees is in `NODE_DISPLAY_NAME_MAPPINGS`, not in the
> class**, so a search for a node by its UI title must grep that mapping. Its direct ancestor in the clone is
**`PixaromaSliders`** (`nodes/node_sliders.py`, `js/sliders/{index.js,core.mjs,ui.mjs,settings.mjs}`),
which already carries the whole mechanic. Pixaroma is MIT © Pixaroma — porting patterns from it is
fine **with attribution in `THIRD_PARTY_NOTICES.md`**.

**Kept from it:**

- One DOM row per control; **one output slot per row, its dot parked on that row's Y**
  (`alignOutputsLegacy`) rather than in a slot column.
- Python declares a **fixed** `RETURN_TYPES = (ANY,) * MAX_ROWS`; the frontend shows only as many
  slots as there are rows and **narrows each slot's visible type** so a wrong wire is refused at the
  wire, before it can fail mid-run. `MAX_ROWS` may grow, never shrink.
- **Auto-resolve on first connection**: a fresh row adopts the type, range, step, current value and
  name of the input it is first plugged into (`resolveAutoType`).
- `widgets_start_y = 2` — without it, widget Y depends on slot bounds which depend on widget Y, and
  the node walks taller every frame.
- Strip `output.pos` on serialize; label slots with a zero-width space so litegraph doesn't paint
  `value_1` on top of the row.
- Load-path gating (`isGraphLoading()` + a configuring flag) so link replay never rewrites saved
  state, and never fit/resize during load or a clean workflow opens "modified".

**Deliberately NOT copied:**

- **Their state handshake.** Pixaroma injects a `hidden` input via a `graphToPrompt` wrapper. This
  pack forbids that — see `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` §2: it silently
  delivered the default `"{}"` to the backend in a real deployment while the on-node preview looked
  correct. Use a **declared, natively-serialized STRING widget**, hidden for rendering only.
- Their orange accent. Rows paint `--wtn-accent` teal.

---

## 2. Why two nodes

ComfyUI caches at **node granularity**, and a node's cache signature propagates to everything
downstream of *any* of its outputs. One panel holding both a seed row and a unet row means **every
seed bump reloads the UNET** — 10s+ per tweak. Splitting by change frequency is the fix, and it is
the whole reason for two nodes rather than one.

| | **Anima Control Panel** | **Anima Loader Panel** |
|---|---|---|
| Rows | sampler, scheduler, seed, int, float, empty latent | unet, vae, clip |
| Changes | constantly | rarely |
| Emits | values (+ one real `LATENT`) | real `MODEL` / `VAE` / `CLIP` |
| `MAX_ROWS` | 16 | 8 |

**The rule to document for users:** one panel = one change-frequency tier. Two Control Panels is a
normal thing to do (a "tweak these" panel and a "set once" panel).

**Residual coupling, inside the Loader Panel:** changing the VAE row still re-executes the UNET row's
load. Mitigate with a module-level cache in the loader helpers keyed by `(kind, name, dtype)`, LRU
of 1 per row kind, so a re-execution returns the same object without re-reading from disk. Note the
tradeoff in the code: holding the reference keeps the model resident, so the cache must be a single
entry per row and must drop on name change.

**A third consequence, and its fix — don't load a row nothing is wired to.** Node-granularity
execution means the Loader Panel's `run()` is called once and must return a value for every row
present in state, whether or not anything downstream actually consumes it — a panel holding
unet+vae+clip rows pulls all three onto the GPU even if only the unet output is wired to
anything. On a Colab-class GPU with tight VRAM this is a real cost, not a micro-optimization, so
`AnimaLoaderPanel` declares hidden `prompt`/`unique_id` inputs and scans the prompt graph
(`_loaders_helpers.referenced_slots`) to work out which of its own output slots are actually
referenced by a link anywhere in the graph, then skips `load_row_model` for every other slot
(the same `0` an absent row already emits). The scan fails **open** — any prompt shape it can't
confidently parse (missing, not a dict, or a node id it can't even locate itself under) makes it
load everything, the pre-existing behaviour, rather than risk silently starving a row the graph
actually needs.

This is deliberately **not** mirrored on the Control Panel: every one of its rows is cheap
regardless of whether it's wired (a string pass-through, a numeric clamp, at worst a
`torch.zeros` for a latent), so the scan would add real complexity for no VRAM saved.

Adding a hidden `PROMPT` input to a node is exactly the kind of change that risks reintroducing
the node-granularity problem this section opens with — a naive implementation could pull the
*whole* prompt into the node's own cache signature, so that any unrelated edit anywhere else in
the graph invalidates the Loader Panel and reloads every model. This was verified against
ComfyUI's own source rather than assumed: `comfy_execution/caching.py`'s
`CacheKeySetInputSignature.get_immediate_node_signature()` builds a node's cache key only from
its own declared `inputs` (`panel_state`) plus the `IS_CHANGED` result and, only because the
class also declares `UNIQUE_ID`, its own node id — never from any other node's `inputs`, and
never from the hidden `PROMPT` payload itself (hidden values are resolved separately, in
`execution.py`'s `get_input_data()`, and never written into the serialized `inputs` the
signature reads). `AnimaLoaderPanel` deliberately does not define an `IS_CHANGED`, so that path
is a no-op here too. Net effect: the whole-graph `prompt` never enters the cache key, and an
edit anywhere else in the graph does not force the Loader Panel to re-execute.

---

## 3. Row catalog

Every row is `kind` + `name` + `value` + `opts`. The ⚙ column is the popover that opens when the
row kind needs more than one field (modeled on `js/prompt_rules/node/picker.mjs`).

### Control Panel

| kind | body | slot type | option list from | ⚙ popover |
|---|---|---|---|---|
| `sampler` | `◀ [ value ▾ ] ▶` | `COMBO` → see §5 | `KSampler.input.required.sampler_name[0]` | — |
| `scheduler` | `◀ [ value ▾ ] ▶` | `COMBO` → see §5 | `KSampler.input.required.scheduler[0]` | — |
| `seed` | number field + mode button + `N` | `INT` | — | control-after-generate + exact value |
| `int` | number field + inline slider fill | `INT` | — | **none** |
| `float` | same, decimals from step | `FLOAT` | — | **none** |
| `latent` | `W × H (ratio)` + batch | `LATENT` | — | Custom / Predefined — see §3a |

**No ⚙ on `int` / `float`.** Their range, step and starting value are adopted from the first input
they're wired to (§6), so a settings panel would have nothing left to own. Drag across the row to set
the value; the fill shows where you are in the range.

**The seed row's mode button mirrors control-after-generate** — `F` fixed, `R` randomize, `I`
increment, `D` decrement. Pick decrement in the ⚙ and the button reads `D`. Clicking it toggles to
`fixed` and back to *the mode that was chosen* — keep a `lastMode` for that, or the toggle silently
downgrades a decrement row to randomize. `N` is separate: roll a new seed now and park the mode at
`fixed`. One control, one truth — there is no second place to read the mode from.

**Every row has a right-click menu**: *Duplicate* and *Remove row*. This is the only removal path for
rows without a ⚙, so it isn't optional. A duplicate takes a **new slot** — it is a new output and
cannot inherit the original's wires — and removal frees its slot number for reuse, so a long
add/remove session doesn't leak the fixed `MAX_ROWS` budget.

Control Panel rows carry a **drag grip** on the left for reordering (see §4 — it moves the row, not
its slot). Loader rows don't: three fixed loaders have no ordering worth dragging.

### 3a. The latent ⚙ — three parts

A segmented **Custom | Predefined** switch, content that swaps with it, and `batch` underneath
(shared by both modes).

- **Custom** — `WIDTH` and `HEIGHT` fields, side by side. Nothing else.
- **Predefined** — a 3×3 ratio grid, then the resolution list for the chosen ratio:

  | | | |
  |---|---|---|
  | `1:1` 1024×1024 | `16:9` 1344×768 | `9:16` 768×1344 |
  | `2:1` 1408×704 | `3:2` 1216×832 | `2:3` 832×1216 |
  | `4:3` 1152×896 | `3:4` 896×1152 | `4:5` 912×1152 |

  Each chip carries an orientation glyph (square / landscape / portrait) drawn from `currentColor`,
  so it inverts along with the selected state.

**Dimensions come from a pinned table, not an area formula.** Every pair above is the canonical one
at the **1024 tier**; other tiers scale that pair by `tier / 1024` and snap to 16. Tiers:
`512, 768, 1024, 1280, 1328, 1408, 1536, 2048`. Deriving from an area formula is more elegant and was
tried first — it puts 2:3 at 832×1248, which reads as wrong to anyone who knows the SDXL/Anima
buckets. Pin the table.

**Changing ratio preserves the tier.** Picking 16:9 while on the 1328 tier gives 1744×992, not a snap
back to 1024.

**The row shows the ratio only in Predefined mode** — `832 × 1216 (2:3)`, with ratio and batch in a
dimmed span so the dimensions stay primary. In Custom the numbers are whatever the user typed, so
naming a ratio would assert a choice they never made.

### Loader Panel

| kind | body | slot type | option list from | ⚙ popover |
|---|---|---|---|---|
| `unet` | combo of diffusion models | `MODEL` | `UNETLoader.input.required.unet_name[0]` | `weight_dtype` |
| `vae` | combo of VAEs | `VAE` | `VAELoader.input.required.vae_name[0]` | — |
| `clip` | combo of CLIPs | `CLIP` | `CLIPLoader.input.required.clip_name[0]` | `type`, `device` |

**Option lists need no backend route.** They are already in the node defs the frontend holds —
read them from `app` at row-render time and the lists auto-track whatever is installed. If a def is
missing (node pack absent), render the row disabled with the reason rather than an empty combo.

The Loader Panel's Python side still needs `folder_paths.get_filename_list(...)` to validate the
saved name and raise a legible error when a model has been moved, since its state is just a string.

### 3b. There is no `lora` row — decided, don't add one

**Considered and rejected 2026-07-27.** A `lora` row was briefly specified here (the Generator needs
a `LORA_STACK` and nothing in this pack emitted one). Dropped on the user's call: they use
**Pixaroma's LoRA stacker**, which already does the job well, and a second implementation of it earns
nothing.

Recorded because the reasoning is not obvious from the code, and because the row *would* have been a
natural-looking addition:

- A `LORA_STACK` is a list, so N lora rows would have had to collapse into **one shared output** —
  breaking this panel's one-row-one-slot invariant, the thing every other row kind depends on. That
  is a real structural cost for a feature an existing node already covers.
- Pixaroma's node turned out not to need one at all: `PixaromaLoraLoader` emits patched
  **`MODEL`/`CLIP`**, not a `LORA_STACK`, so LoRAs reach the Generator already applied. Only its
  inline-loaders mode needs a LoRA list of its own (`generator-design.md` §5b).

So: **`LOADER_CATALOG` stays `unet` / `vae` / `clip`.** If a lora row is ever revisited, the shared-slot
problem above is the design question to answer first, not an implementation detail to discover.

---

## 4. State shape

One JSON blob, live copy on `node.properties.<panel>State`, mirrored into a declared STRING widget
`panel_state` after **every** mutation. Persistence rides the widget (`widgets_values`); restore by
parsing it back in `onConfigure` *after* the original runs.

```jsonc
{
  "version": 1,
  "rows": [
    { "slot": 1, "kind": "sampler",  "name": "sampler name", "value": "euler_ancestral" },
    { "slot": 2, "kind": "seed",     "name": "seed",  "value": "1000000000000", "opts": { "after": "decrement", "lastMode": "decrement" } },
    { "slot": 3, "kind": "int",      "name": "steps", "value": 30, "opts": { "min": 1, "max": 120, "step": 1 } },
    { "slot": 4, "kind": "float",    "name": "cfg",   "value": 5.0, "opts": { "min": 0, "max": 20, "step": 0.1 } },
    { "slot": 5, "kind": "latent",   "name": "empty latent", "opts": { "mode": "predefined", "ratio": "2:3", "tier": 1024, "w": 832, "h": 1216, "batch": 1 } },
    { "slot": 6, "kind": "auto",     "name": "Value 6" }
  ]
}
```

- **`seed` is a STRING in state.** Seeds run to 2^64−1, past JS's `MAX_SAFE_INTEGER` (2^53−1); a
  numeric seed silently rounds at the top of the range. Python does `int()` and clamps to
  `[0, 2**64-1]`, guarding `ValueError` / `OverflowError` on a hand-edited API file.
- **Display order and slot order are SEPARATE.** Each row carries a `slot`, assigned once at
  creation (lowest free number) and never renumbered; the `rows` array is display order only.
  `RETURN_NAMES` stays positional *by slot*. This is what makes drag-to-reorder free: dragging a row
  rearranges the panel without touching a single wire. If the two were the same thing — the obvious
  first implementation, and Pixaroma's — every drag would silently rewire the graph.
- **Deletion is still the disturbing case.** Dropping a row frees its slot; Pixaroma just calls
  `removeOutput(index)`. Do the same, but **confirm first when the deleted row has a link**, and
  prefer reusing the freed slot number for the next added row over renumbering anything.
- **A freed slot below the highest used one is an interior "hole", and it gets a stray output
  dot** (diagnosed live, fixed 2026-07-28) — `assignSlot` always hands out the *lowest* free slot
  to a new/duplicated row, but a later removal can free a slot *below* one still in use, and
  nothing before this fix ever closed that gap back up. `js/controls/rows.mjs`'s
  `planHoleCompaction` is the pure planner: repeatedly find the highest interior hole under the
  current highest **used** slot, and if the row currently occupying that highest slot is
  **unwired**, move it down into the hole (cascades collapse to one `{from, to}` move per row);
  stop the moment that row is wired, since it's the only candidate for every remaining hole too.
  **Never renumbers a wired row** — that's the whole reason it's safe to run automatically,
  since renumbering a wired row's slot would retarget someone's link out from under them (this
  section's own "display order and slot order are separate" invariant). `interaction.mjs`'s
  `compactHoles` is the only caller, applying the plan on a genuine **user action**
  (add/remove/edit a row) and never while `node._ctrlConfiguring` — a saved workflow's own
  interior hole is part of its last-saved shape and must be reproduced exactly on load, not
  "fixed" on the way in.
- `Number.isFinite` + range clamp on every read, on both sides. A hand-edited `1e308` must not reach
  a downstream node.

---

## 4a. `js/shared/graph_loading.mjs` — the load-race sizing guard

**Landed 2026-07-28**, ported from `../ComfyUI-Pixaroma/js/shared/graph_loading.mjs` (MIT ©
pixaroma, credited in `THIRD_PARTY_NOTICES.md`) after this pack's own `js/anima/index.js` hit the
exact bug it exists to fix: a fresh page load or workflow re-open snapped `AnimaGenerator` back to
its hardcoded default size instead of the saved one.

**Why the per-node `_ctrlConfiguring`/`_anConfiguring` flag above isn't enough by itself.** That
flag is set synchronously inside `onConfigure`, which correctly marks "a restore is in progress"
for anything running synchronously inside that same call — but this pack's actual sizing logic
runs from `onNodeCreated`'s own deferred `loadMods().then(setupNode)`, and `onNodeCreated` fires
for a *restored* node too (litegraph's construct-then-configure order calls it before
`onConfigure`, not instead of it). Because `app.loadGraphData` is itself async, there's a real
window where `onNodeCreated`'s microtask resolves and runs *before* `onConfigure` has had any
chance to set its own flag — during that window `node.size` still holds litegraph's tiny
freshly-constructed default, and any code that floors the size up from THAT stamps the fresh-node
floor over whatever the saved workflow was about to restore.

**The fix**: wrap `app.loadGraphData` once (idempotent via `app._wtnGraphLoadWrapped`, so a
hot-reload doesn't re-wrap it) and hold a flag true for the whole call plus a short (300ms)
trailing window — the graph-level link/state restore settles a tick after the promise itself
does. `isGraphLoading()` is the resulting single, load-order-independent signal, gating alongside
whichever per-node flag a module already has (the two cover different windows — one covers
*before* `onConfigure` even runs, the other covers *during/after* it — and both are needed for
belt-and-braces coverage). Shared by `js/controls/` (§1's "Load-path gating" bullet, §6's Auto-row
gate) and `js/anima/` alike; no `node`/`LiteGraph` reference beyond `app` itself, so it's a plain
lazily-imported library, not one of the pack's 5 auto-loaded `.js` entry points.

---

> ### ⚠️ `row.id` is NOT stable across parses — never key durable state off it
>
> `id` is serialized into `panel_state` and *looks* durable. It isn't: `normalizeRow` never reads it
> back, so every parse mints a fresh one from a module counter. The same row emerges as `id: 1` from
> one parse and `id: 2` from the next.
>
> That matters because the load path parses **twice** — `onNodeCreated` materializes state, then
> `onConfigure`'s `restoreStateFromWidget` force-re-parses the restored widget value. Any per-node
> bookkeeping keyed on `row.id` therefore looks like it's describing different rows across those two
> phases.
>
> This cost a real bug (found live 2026-07-28): slot-label ownership was tracked in a session
> `Map` keyed by `row.id`, so a socket the user renamed via litegraph's Rename Slot dialog had its
> ownership silently forgotten on **every** workflow load, and the next sync overwrote the name with
> the row's default. The fix was to put ownership in the serialized row (`slotLabelOwned`) — a fact,
> not an inference. `renamed` already worked this way for the row's display name.
>
> **Rule:** anything that must survive a reload goes in the serialized row state. `row.id` is a
> within-parse handle for pairing DOM to rows, nothing more.

---

## 5. Output typing — SETTLED (2026-07-27)

Python is wildcard for every slot (`ANY` = a `str` subclass whose `__ne__` returns `False`; Pixaroma
keeps it in `nodes/_type_helpers.py`, we'd add `nodes/controls/_type_helpers.py`). The frontend then
sets `output.type` per row so litegraph refuses bad wires: `INT`, `FLOAT`, `LATENT`, `MODEL`, `VAE`,
`CLIP` are all plain strings and behave.

**Combo rows were the open question — now answered: `output.type = "COMBO"` works.** Verified in a
live ComfyUI on 2026-07-27: sampler and scheduler rows wire to a KSampler and pass the correct value.
`COMBO_TYPE_STRATEGY` in `js/controls/rows.mjs` stays on `"COMBO"`; the two fallbacks below remain
implemented in case a future frontend version needs them, but **do not flip the constant while
combos are working**.

1. **`"COMBO"` — confirmed correct, the shipped default.**
2. The literal list, joined — what older legacy widget-inputs carry.
3. `"*"`, permissive: connects anywhere, Python coerces. Always works, loses the wire-time guard.

Community reports also mention a Python-side `RETURN_TYPES = ("COMBO,STRING",)` (note the trailing
`,STRING`) for nodes emitting combo values. **We did not need it** — the frontend narrowing alone was
sufficient. Noted only so the next person doesn't reach for it unnecessarily.

**Slot labels also settled.** `SLOT_LABEL_MODE = "row-name"` was the other live unknown: a real
(non-zero-width) label could in principle have been painted by litegraph on top of our row DOM.
Verified 2026-07-27 — **no bleed**, because litegraph paints slot text on the canvas while our rows
are opaque DOM layered above it. The `"hidden"` mode remains as an escape hatch; nothing needs it.

**UX caveat worth stating in the docs:** on **legacy litegraph** (this pack's target renderer) a
KSampler's `sampler_name` is a canvas widget, not a socket — the user must right-click → *Convert
widget to input* before a panel row can be wired to it. Newer frontends surface widget-sockets on
hover. This applies to the whole node concept, not just combo rows.

---

## 6. Auto rows — keeping Pixaroma's best trick

A new row is `kind: "auto"` and resolves on its **first user connection** by inspecting the target
input and the widget behind it:

| target input | becomes | also adopts |
|---|---|---|
| `INT` named `seed` / `noise_seed` | `seed` | current value |
| `INT` | `int` | name, `min`, `max`, `step2`, current value |
| `FLOAT` | `float` | same |
| `COMBO` whose list **is** `sampler_name`'s | `sampler` | current value |
| `COMBO` whose list **is** `scheduler`'s | `scheduler` | current value |
| `LATENT` | `latent` | — |
| `MODEL` / `VAE` / `CLIP` | rejected on the Control Panel, resolves on the Loader Panel | — |

Match combos by **comparing the option list**, not by input name — `sampler_name` is not a reliable
name across packs. Adopt the target's *current* value so connecting never changes the number the
workflow was already running with, and keep Pixaroma's `usefulRange` heuristic (a `1..10000` steps
input becomes a draggable `1..4×current`, not a useless 40-steps-per-pixel slider). Only adopt
range/name when the row is still untouched — adopting over a user's own edit is a stomp.

Gate on `!isGraphLoading() && !configuring`, or loading a workflow rewrites saved kinds.

---

## 6a. The row mechanism is capability-scoped, not this track's property (contract, 2026-07-29)

The pack's node UIs are layered by **what a thing knows about**, not by which track wrote it:

1. **field logic** — pure maths/normalizers, no DOM, no litegraph (`rangeOf`, `clampNumeric`,
   `formatNumericValue`, `numericPercent`, `clampSeedString`, `randomSeedString`,
   `applyAfterGenerate`, `getComboOptions`). Belongs in `js/shared/`; several of these still sit in
   this track's `rows.mjs`, which is why `js/shared/fields.mjs` currently imports *downward* from
   `js/controls/` — an inversion being corrected.
2. **fields** (`js/shared/fields.mjs`) — the controls themselves. DOM + layer 1, never litegraph.
   Every node UI composes from here; see `.claude/skills/animaflow-shared-fields/`.
3. **socket rows** — *this* mechanism: one litegraph output socket per row, `alignOutputsLegacy`
   parking each dot on its own Y, slot assignment (`assignSlot`, positional and append-only), hole
   compaction, `syncOutputs`. Needed only by nodes that expose a socket per row — today
   `AnimaControlPanel` and `AnimaLoaderPanel`, which already share it.

**The contract:** layer 3 may depend on layers 1–2 and on litegraph, and must **never** depend on
Control-Panel-specific state — not `KIND_META`, not the row catalogue, not this node's settings blob.
Hold that and moving it to `js/shared/socket_rows.mjs` for a third consumer is a file rename; break it
and the move becomes an untangling of the most fragile code in the pack.

It stays in `js/controls/` for now **deliberately**: no third socket-per-row node exists, and the two
that do already share it by sitting here. That is a deferral, not an accident — don't relocate it
speculatively, and don't read its location as licence to couple it to this track. The Generator
composes layer 2 only and has no rows at all, which is the point: the Anima panel has no per-row
sockets to park.

## 7. Layout, sizing, theming

Legacy litegraph is the target; the legacy path must work standalone, with `computeLayoutSize` +
`minWidth: 1` kept only for Nodes 2.0 forward-compat. Both from
`.claude/skills/comfyui-dynamic-node-frontend/SKILL.md`:

- `computeSize = () => [MIN_W, bodyHeight(node)]` — return `MIN_W`, never the live width, or the node
  can only ever grow.
- `bodyHeight` counts **our rows only**; without the override, legacy reserves a 20px slot row *per
  output* above the body.
- Re-run `arrange()` after `alignOutputsLegacy()` so slots re-measure with our positions in place.
- Grow/shrink on **user actions only**, never on load.

Theme per `.claude/skills/animaflow-node-theme/SKILL.md`: one `addDOMWidget` body, `injectTheme()`,
`.wtn` on the root, `var(--wtn-*, #fallback)` pairs everywhere. Guarded dynamic import of
`theme.mjs` in `render.mjs`, because `test_resize.mjs` imports it headlessly. Component mapping:
rows are bordered surface blocks, steppers are `.wtn-btn--icon`, `R`/`N` are `.wtn-btn--ghost`,
the footer is a dashed ghost button, the ⚙ popover follows `picker.mjs`.

---

## 8. Placement, and two repo rules this breaks

```
nodes/controls/{__init__.py, control_panel.py, loader_panel.py,
                _rows_helpers.py, _loaders_helpers.py, _type_helpers.py}
js/controls/{index.js, rows.mjs, render.mjs, interaction.mjs, settings.mjs,
             control_panel.mjs, loader_panel.mjs, test_resize.mjs}
```

- **`CATEGORY = "AnimaFlow/Controls"`.** The theme skill fixes the category list at three snake_case
  topics (`anima`, `anima_prompt`, `panel`) — this needs a fourth, and picker topics moved to
  human-readable Title Case at the same time (`anima_prompt` → **`Prompt`**, decided 2026-07-27).
  **Do not** call it `Panel`: that topic is reserved for the deleted webtoon panel pipeline (Scene
  Creator, Panel Parser) and would collide on its rebuild. Folder names stay lowercase
  (`nodes/controls/`, `js/controls/`) because Python packages must be importable — so "folder and
  category agree" now means *case-insensitively*. The skill needs both changes when this lands.
- **JS download budget.** `.claude/CLAUDE.md` says exactly **3** auto-loaded `.js` files. Two more
  index files would make 5. Instead ship **one `js/controls/index.js`** that registers both
  extensions and lazily `import()`s the per-node `.mjs` — the two nodes share the row-rendering
  library anyway, so the budget goes 3 → **4**, and CLAUDE.md's count gets updated to 4 with the
  reason.
- The theme skill still cites `js/anima_prompt/...` paths, which became `js/prompt_rules/...` in
  `e936a36`. Worth fixing while in there.

`EXPERIMENTAL = True` on both classes; tooltips on every input and every return.

---

## 9. Tests

- `tests/test_controls_state.py` — state parse/clamp round-trip, seed overflow (2^64−1 string, a
  400-digit integer, `Infinity`, `NaN`), missing/extra rows against `MAX_ROWS`, a hand-edited API
  payload, and latent dims that don't match any ratio (Custom mode is legal input).
- `js/controls/test_resize.mjs` — legacy `bodyHeight` math, grow-and-shrink, no jitter.
- Headless test for the pure row-kind resolver in `rows.mjs` (auto → kind, given a fake target def)
  and for `dimsFor(ratio, tier)` — assert the canonical pairs at 1024 exactly (832×1216, 1344×768,
  1152×896), the 16-snap at other tiers, and that changing ratio preserves the tier.
- Slot invariants: reorder never renumbers slots; duplicate takes a fresh one; a freed slot is reused
  before any number above the current maximum.
- Keep latent creation's `torch` import **inside the node function**, so the helpers and tests stay
  torch-free.

## 10. Deferred

- A `checkpoint` row (one file → MODEL/CLIP/VAE) — three outputs from one row breaks the
  one-row-one-slot invariant; needs its own thought.
- Multi-CLIP (dual/triple) loaders.
- Per-panel accent override, as Pixaroma's settings panel has.
