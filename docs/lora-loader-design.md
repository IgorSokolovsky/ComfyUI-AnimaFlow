# LoRA Loader + Civitai browser — design

**Status: SPEC, nothing built.** Written 2026-07-29 from a full read of the upstream reference. Three
things the board listed as open are **settled here by investigation** (§2b, §5, §6); one genuinely
open decision remains (§9). Read this before writing any code for this track — like
[`control-panel-design.md`](control-panel-design.md) and [`generator-design.md`](generator-design.md),
it is a contract, not notes, and several entries record why an obvious approach is rejected.

Wanted: an AnimaFlow LoRA loader taking Pixaroma's as the starting point (the one the owner actually
uses), **plus the two things it doesn't have** — Civitai search and download — built as a *shared*
browser so the Loader Panel's UNET/checkpoint side gets them too.

---

## 0. START HERE — status, decisions, and the build plan

**Nothing is built.** This doc plus [`playground/lora-loader.html`](../playground/lora-loader.html) are
the whole artefact. The mockup is **interactive and is the behavioural reference** — open it before
writing code; drag a row, toggle the master switch, add a custom trigger word, flip the Civitai setting
off, open the modal and click a result card.

### 0a. Everything settled (owner decisions, all 2026-07-29)

| # | decision | where |
|---|---|---|
| 1 | **The node ships FIRST**, Civitai feature under it; Loader Panel reuses later | §9a |
| 2 | Civitai **metadata needs NO API key** — hash → public endpoint, sidecar-cached | §2b |
| 3 | **NOT** a layer-3 socket-rows consumer; that deferral stands | §5 |
| 4 | `AnimaFlow/Controls` + `js/controls/` — **zero new auto-loaded `.js`** | §4a |
| 5 | State is a **declared serialized STRING widget**, never `hidden` + `graphToPrompt` | §3 |
| 6 | **Sizing Class A** — content height, width resizable; four enforcement layers | §6 |
| 7 | Library is **kind-parameterised from commit one**, only `loras` wired; `kind` whitelisted server-side | §7a |
| 8 | **Three surfaces**: two kind-locked pickers + one unscoped toolbar modal | §7c |
| 9 | **All three get the full filter set**; only `type` is locked. Filters remembered user-wide | §7c-i |
| 10 | Modal rail: **`<select>` adds a removable chip**, not Civitai's 19-chip grid | §7c-i |
| 11 | In the modal, card click → **detail swap** (filter rail stays): version selector, description, **community gallery with prompt on hover + copy** | "The detail view" |
| 12 | **One header row**: `＋ Add LoRA` (content+padding, **max 30%**) · master switch · `N/M` · 🔍 · ⚙ | §1a-ii |
| 13 | Master switch **on only when all on**; mixed shows off, counter carries it; click = all on | §1a-ii |
| 14 | Row order: **name · strength · ⓘ · switch(right)**; off row dimmed; missing = whole field red | §1a-ii |
| 15 | **Drag-to-reorder with FLIP animation** (pack has none today); menu drops to **Duplicate / Remove** | §1a-iii |
| 16 | ⓘ panel: identity → `<hr>` → triggers → `<hr>` → author's notes (collapsible) | §1a-i |
| 17 | `all`/`none` is an **ACTION segment** — never latches | §1a-i |
| 18 | Custom trigger words allowed; **only user-authored chips get an `✕`** | §1a-i |
| 19 | ⚙: **8 settings**; dropped Highlight colour + the three footer buttons | §7b |
| 20 | The **Civitai** setting hides **every** network affordance (🔍 + ⓘ lookup) ⇒ provably offline | §7b |
| 21 | Node picker card click → **a new VERTICAL info panel** (sibling of the ⓘ panel), single-column gallery; **not** the modal, **not** an in-panel swap | §7c-ii |
| 22 | **EVERY per-model info surface carries `View on Civitai ↗`** — the ⓘ panel, the modal detail, and the Loader Panel's model info | §7d |
| 23 | Row menu keeps **four of six**: `More info` · `Duplicate` · `Disable/Enable` · `Remove` (only the arrows go) | §1a-iii |
| 24 | The four lookup states each get **icon + cause + the one useful action**; `notfound` offers **search by name** and explains the hash | §7e |
| 25 | Picker: root group labelled **`All`**, subfolders their own; **current LoRA accent-coloured**; names **ellipsis-truncated**, never wrapped | §1a-v |

### 0b. The ONE thing still open

**§9 — the outbound-network policy.** It does **not block M1**, which is entirely offline apart from the
hash lookup (no key, cacheable, and hideable by decision 20). Settle it before M2.

### 0c. Build plan

**M1 — the node, offline-capable.** `AnimaLoraLoader` (`nodes/controls/`, `AnimaFlow/Controls`,
registered from the existing `js/controls/index.js`). Declared `lora_state` widget with tolerant
normalization (§3). Rows, searchable subfolder-grouped picker, strengths, missing marks, the header row,
animated drag-reorder, the ⓘ panel, the ⚙ dialog, Class A sizing. Python: apply in row order, `triggers`
from **applied rows only**, three memory modes (port the `last`-mode fix, §1b). Hash lookup + sidecar.
Tests per §10 — **including `Float64Array` size tests**.

**M2 — search + download.** Needs §9. Kind-parameterised routes with a whitelisted `kind`, the full
filter set (pills in the node picker, `type` locked), server-side streamed download with progress and a
destination derived from `kind`, the key ladder and public-only mode (§8).

**M2b — the toolbar modal.** Purely additive — M2 does not depend on it (§7c-ii). Icon button mounted from `js/controls/index.js` with a lazy `import()`; 90%
modal; filter rail; result grid; detail view with version selector and community gallery.

**M3 — Loader Panel reuse**, scoped to **checkpoints + UNET only**.

### 0d. Read these before touching code

- `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md` — **mandatory** for anything sizing. `node.size`
  is a `Float64Array`; `Array.isArray` guards are dead code.
- `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` — the state handshake §3 depends on.
- `.claude/skills/animaflow-shared-fields/SKILL.md` — and note `js/controls/` does **not** currently
  import `js/shared/fields.mjs`.
- [`control-panel-design.md`](control-panel-design.md) §7a — the Class A contract.

> **Section order note:** the `1a-*` and `7*` sub-sections are not in numeric order — they were appended
> as decisions arrived. The table in §0a is the index; follow it rather than reading top-to-bottom.

---

## 1. The upstream reference — read it, it is good

`../ComfyUI-Pixaroma/js/lora_loader/` + `nodes/node_lora_loader.py` + `nodes/_lora_helpers.py`.
**MIT © pixaroma**, so porting is fine **with attribution** — cite the upstream `file:line` in a
comment and extend [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) with a per-file derivation
row, the moment anything is actually derived.

Shape: **frontend-driven, thin Python** — ~2,250 lines of JS across 8 modules against 183 lines of
node plus 445 lines of pure helpers.

| module | lines | job |
|---|---|---|
| `info_panel.mjs` | 518 | the ⓘ panel — trigger-word picking + Civitai lookup |
| `index.js` | 313 | extension entry, sizing, refresh hooks |
| `settings.mjs` | 302 | the ⚙ dialog |
| `render.mjs` | 289 | rows, strengths, missing-file marks |
| `core.mjs` | 262 | state (add / remove / move / duplicate / patch) |
| `dropdown.mjs` | 238 | the searchable picker |
| `interaction.mjs` | 209 | row context menu |
| `api.mjs` | 118 | fetch + client-side caching |

### 1a. What it already does — the baseline, so we don't rediscover it

- **Per row:** searchable name picker (grouped by subfolder; typing searches *flat* across every
  LoRA), on/off, model + clip strength with ▲▼ steppers, an ⓘ button, and a right-click menu.

### 1a-v. The picker dropdown — corrected from a reference shot (2026-07-29)

Four details a source read did not give me:

- **Group headers, and the root group is labelled `All`.** Subfolders get their own header
  (`detail/`); files sitting at the top of `models/loras` are grouped under `All` rather than left
  header-less.
- **The row's CURRENT LoRA is accent-coloured** in the list, so you can see where you are in a long
  list of near-identical filenames — which is what a real `models/loras` looks like.
- **Long names truncate with an ellipsis, never wrap.** Every row stays one line, so the list scans
  vertically; the full name goes in a `title`.
- **Extensions are shown** (`.safetensors`) — subject to the ⚙'s *Hide file extension* setting (§7b).
- **Each entry carries a small thumbnail on the left** (~30px) plus a second line with file size and
  base model (owner, 2026-07-29 — richer than upstream's plain text list). The thumbnail comes from the
  **preview file sitting next to the LoRA** (upstream's `find_preview_path` / `/lora/thumb`), so the
  picker stays **fully offline** — no Civitai involved. A LoRA with no preview gets a neutral placeholder
  rather than a broken frame, and the second line says `no preview`. This is the fastest way to identify a
  LoRA: filenames in a real `models/loras` are near-identical, and a picture is not.
- The search field lives **inside** the panel at the top, with a magnifier glyph, and takes focus on
  open. Typing searches **flat across every LoRA**, so the group headers collapse away while filtering
  (they only mean anything in the unfiltered tree).

### 1a-iii. Reordering is DRAG; the menu keeps four of its six items (owner, 2026-07-29)

Upstream's row menu, read off a reference shot, is **six** items — a source grep had shown me only four:

`ⓘ More info` · `↑ Move up` · `↓ Move down` · `⧉ Duplicate` · `◉ Disable` · `⌫ Remove`

**Drop only the two arrows.** Rows reorder by **drag-and-drop**, so ours is:

`ⓘ More info` · `⧉ Duplicate` · `◉ Disable / Enable` · `⌫ Remove`

**Why `More info` and `Disable` stay even though each duplicates a visible control** (the `i` button and
the row switch) — the distinction matters, because I nearly cut them by the same argument that removed the
arrows: a context menu is *the complete list of what you can do to this row*, and one that omits the
obvious actions reads as broken. The arrows are different: they were not omitted, they were **superseded**
by a better mechanism. Duplication of a *control* is fine; two competing *mechanisms* for reordering is
not.

`Disable`/`Enable` reads the row's current state rather than being a fixed label, so the menu never offers
an action that is already true.

What "animated" means concretely:

- the dragged row **lifts** — shadow, slight scale, reduced opacity — so it reads as detached;
- the other rows **slide** to open a gap, rather than teleporting (FLIP: measure, reorder, then
  transition `transform` from the old position to the new);
- on release the row **settles** into place instead of snapping;
- **animate `transform` only**, never layout properties — this is a DOM widget composited over a
  canvas, and layout thrash there is visible.

Three constraints, each already learned the hard way elsewhere in this pack:

1. **`stopPropagation` on the pointer handlers is load-bearing.** Without it litegraph steals the
   gesture and the drag never starts — exactly the lesson `generator-design.md` §7 records for the
   Preview's hover-wipe.
2. **Respect `prefers-reduced-motion`** ([`THEME.md`](THEME.md)) — reorder instantly, no transition,
   when it is set.
3. **The per-frame size correction must not fight the animation.** Class A rewrites `node.size[1]`
   every frame (`control-panel-design.md` §7a); a drag that changes row count mid-gesture, or a
   transition that briefly overlaps rows, must not cause a size oscillation. Row count does not change
   during a reorder, so the floor should be stable — but verify rather than assume.

> **Build the animation HERE first, and this is the reason:** the Control/Loader panels park each row's
> **output socket** at that row's Y (`vacantSlotY`/`alignOutputsLegacy`), so an animated reorder there
> must either move the sockets in step or freeze them until drop — sockets live on the node canvas, not
> inside the animating DOM. **This node has no per-row sockets (§5)**, so it can prove the animation
> with none of that risk, and the socket question becomes a separate, well-scoped port.
- **Missing files** turn the **whole name field red**, border included — re-checked on `R` (Refresh
  Node Definitions) **and on WebSocket reconnect** — the same moments native combos refresh —
  repainting every LoRA node, including ones inside subgraphs.

### 1a-ii. The header strip and row layout — corrected from a reference shot (2026-07-29)

Another case where reading the source under-described the UI. The corrected target is in the mockup:

- **ONE header row** (owner, 2026-07-29): `＋ Add LoRA` · master switch · `N/M` · ⚙. An earlier draft
  split this across two rows (full-width Add above, a switch strip below) — collapsed to one, because
  two rows of chrome above the first LoRA is a lot of vertical cost in a node whose height is
  content-driven (§6).
- **`＋ Add LoRA` is sized to its content plus padding, capped at 30% of the node width** — it does
  **not** flex to fill. The switch, counter and gear sit at the right, with the slack between them
  deliberately empty. Two reasons this matters more than it looks: a full-width primary button reads as
  the node's main action when the main action is actually *using* the LoRAs below it, and the node is
  **width-resizable** (§6), so a flexing button would grow without limit while the controls it shares a
  row with stay fixed. Cap it, and the row keeps its proportions at any width.
- **The counter is `2/3`, with no "on" word.** The switch beside it already says what the number is
  about; the label was redundant. It is also the only text in that row, so it stays compact.
- The switch reads **on only when EVERY row is on**; a mixed state shows it **off** with the counter
  carrying the truth. Clicking it when mixed *or* all-off turns **everything on** — the action you
  almost always want — and only turns everything off when everything already is. Without the counter,
  mixed would be indistinguishable from all-off, which is exactly why the count sits beside the switch
  rather than in a tooltip.
- **The row's on/off switch is on the RIGHT**, after the ⓘ — not leading the row. Order:
  **name ▾ · strength ▲▼ · ⓘ · switch**.
- **An off row is visibly dimmed** (name, strength, ⓘ recede) so a glance says what is actually
  contributing, with no need to read switch positions.

House-theme note: upstream's accent is red/orange, ours is teal (`THEME.md`). The mockup is teal
deliberately — only the *layout* is being copied, not the palette.
- **⚙ settings:** default strength, *"Show two strengths per row"* (collapse model/clip to one),
  trigger-words separator, **"LoRA memory use"** (`last` / `all` / `none`), and *"Set as default"*.
- **ⓘ panel:** trigger words read **straight from the safetensors metadata** (works offline); tick
  which words feed the `triggers` output, persisted per row; the **optional** Civitai lookup with
  four explicit states (searching / found / notfound / offline); toggle between file-derived and
  Civitai word sets with your *selections* surviving the switch; preview thumbnail; base-model
  family; delete the cached Civitai data to revert to the file's own words.
- **Outputs `triggers`** as plain text — the thing that makes it more than a stack.

### 1a-i. The ⓘ panel's real layout — four things a source read missed

Corrected from a live reference shot (owner, 2026-07-29). The first pass of this doc under-described
this panel; the layout is the approved target, in [`playground/lora-loader.html`](../playground/lora-loader.html).

Top to bottom: a **small inline thumbnail** (~58px) beside the **title**, with the **base-model family**
and the **full filename** stacked under it, then a **"View on Civitai ↗"** link, then the trigger-words
block, then the add-your-own field, then a **`Done` / `↻ Civitai`** footer.

**Three sections, separated by rules** (owner, 2026-07-29): a `<hr>` after the identity header and
another before `AUTHOR'S NOTES`. They are doing real work rather than decorating — the panel stacks
three things with genuinely different jobs (*what this LoRA is* · *what you're sending to the prompt* ·
*what the author says about it*), and the middle one is the only interactive one. Without the rules the
`from file` pill and the notes' `from Civitai` pill read as belonging to the same group, which is exactly
the confusion to avoid given they describe different sources. Style them `--wtn-line-soft`, matching the
card borders, so they separate without drawing attention.

The four features a source read did not surface, all worth keeping:

1. **The user can ADD their own trigger words** — a text field plus `Add`. This is the important one:
   the `triggers` output is **not** limited to what the file or Civitai provide. Custom words are part
   of the row's `triggers[]` like any other, so they persist with the workflow.

   **Chip affordances differ by origin, and the rule is a principle worth keeping** (owner reference
   shots, 2026-07-29): a **user-authored** chip carries an inline **`✕`** to delete it; a **file- or
   Civitai-derived** chip does **not**. You may delete what you wrote; the file's and Civitai's words
   are *candidates to select*, not data you own — deleting one would imply an edit to a source we don't
   control. Selection is additionally marked with a **`✓`** inside the chip, so selected-ness doesn't
   rest on colour alone. The `✕` must `stopPropagation` or clicking it also toggles the chip.

   Implementation note: a custom word is arbitrary user text, so write it with `textContent`, never
   `innerHTML`.
2. **`all` / `none` quick-select** beside the section label, as a **segmented button group** (owner,
   2026-07-29) rather than the text links upstream uses — it matches the pack's own segment vocabulary
   (`js/shared/fields.mjs`), and two adjacent bare links read as navigation.
   ⚠️ **It is an ACTION segment, not a mode segment**: neither button ever latches "on". Every other
   segment in this pack (memory mode, base model, sort, period) represents a *current selection* and
   keeps one button lit; this one fires and returns. Style it momentary — accent on `:active` only —
   or it will look like a state that has stopped responding.
3. **A source pill** (`from file` / `from Civitai`) rather than a segmented toggle — it states where the
   candidate words came from and switches the view, while *selections* survive the switch.
4. **The provenance rule is stated in the UI**: *"Tap the ones you want. Only these, and only if the
   LoRA is on, reach the triggers output."* That is §1b's rule surfaced where it matters instead of
   left as a surprise. Keep the wording close.

Empty state carries its own honest line — *"No trigger words in this file — add your own below, or try
Civitai"* — which names both remedies instead of just reporting nothing.

**Our addition: an `AUTHOR'S NOTES` section**, the §2 item 3 ask. Placed **after** the trigger-words
block and **collapsible**, for a specific reason: notes are reference material and can run long, so
putting them above the controls would push the actionable part off-panel, while a scrollable collapsed
block keeps the panel compact. It carries its own `from Civitai` pill, because unlike file-derived
trigger words the notes have exactly one source and the panel should not imply otherwise.

**The `↻ Civitai` footer button is the thing §7b's "Civitai lookup button" setting hides.** With that
setting off, this button does not render and the panel is fully offline — which is what makes offline a
posture rather than a failure.

### 1b. Two pieces of its Python worth copying for the reasoning, not just the code

- **Trigger words come only from rows that ACTUALLY APPLIED.** A missing, renamed, or corrupt file
  contributes nothing, so `triggers` can never claim words for a LoRA that isn't in the model. A row
  deliberately parked at strength 0 *does* count (the user turned it on on purpose).
- **The memory modes are subtler than they look.** In `last`/`none`, each entry loaded this run is
  released right after the *next* one applies, so a 10-row stack peaks at ~2 files rather than 10.
  Their own pre-release review caught `last` behaving like `none` for any 2+ row stack, because
  evicting the cross-run retained entry when the run's *first* row applied dropped the warm file
  moments before it would have been reused. Port the fix, not just the feature.

---

## 2. What it does NOT have — this is our actual work

Confirmed by enumerating its routes: `list`, `info`, `thumb`, `civitai`, `civitai_delete`. **There is
no search and no download.** So the owner's two headline asks are genuinely ours to build:

1. **Search Civitai from inside the node** — find a LoRA without leaving ComfyUI.
2. **Download to local**, the way **Civicomfy** does it — pick a result, fetch it into the right
   `models/` folder, use it immediately. ([MoonGoblinDev/Civicomfy](https://github.com/MoonGoblinDev/Civicomfy),
   **MIT**, verified 2026-07-29. Not a sibling clone here — pull it locally before porting and
   re-verify the licence at that point rather than trusting this line.)
3. **The author's own description**, not only numeric metadata — the notes saying how a LoRA is meant
   to be used. (Upstream's parsed record may already carry this; check `parse_civitai_modelversion`
   in `_lora_helpers.py` before building anything.)
4. **The same for models, not just LoRAs** — which is what makes this a **shared Civitai browser**
   consumed by two nodes rather than a LoRA feature.

### 2b. SETTLED: the Civitai metadata lookup needs NO API key

The board carried a key-resolution ladder as a prerequisite. For **metadata and previews it is not
needed at all.** Upstream's lookup is:

```
SHA256 the file  ->  GET https://<host>/api/v1/model-versions/by-hash/<sha>  ->  cache as a
                     <base>.civitai.info sidecar next to the LoRA
```

A public endpoint, no auth. Details worth copying verbatim:

- **Always answers HTTP 200**, with a `reason` of `found` / `notfound` / `offline`, so the frontend
  picks a card instead of parsing error codes.
- **Two hosts with fallback**, but a `404` returns immediately — it is definitive, and the backup
  host serves the same catalogue, so retrying is a pointless round trip. A non-200 *does* fall
  through (rate limit / maintenance are transient).
- **30s timeout, not 12s** — Civitai is regularly slow under load, and an early give-up reads to the
  user as "it doesn't work". The hash is already computed by then, so the budget is purely HTTP.
- **4 MB body cap** so a malfunctioning endpoint can't spike memory.
- **Distinct failure reasons preserved** — timeout vs DNS/TLS refusal vs an unreadable block page.
  Collapsing them into one generic line defeats the point of showing a reason.
- **A 200 with a usable record is FOUND even with no `trainedWords` and no `model.name`** — plenty of
  versions have neither. Requiring them threw away genuine hits *and* skipped the sidecar write, so
  every later click re-hashed the whole file and re-fetched.

**The key ladder therefore applies only to search and gated downloads** (§8).

---

## 3. State — a declared serialized STRING widget, NOT upstream's handshake

**This is the one place we deliberately fork from the node we're copying, and it is not a style
preference.**

Upstream declares `"hidden": {"LoraLoaderState": ("STRING", {"default": "{}"})}`, keeps state on
`node.properties`, and injects it into the prompt with a `graphToPrompt` hook. **This pack forbids
that pattern** — `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` §2 records it silently
failing in a real deployment: the on-node preview (computed client-side) looked correct while the
backend received the default `"{}"`.

**Why that failure mode is the worst possible one here:** the UI reads `node.properties`, so the node
renders your whole stack perfectly. Only Python sees `"{}"`. You would get rows on screen, an empty
`triggers` output, no LoRA applied, and no error — the only symptom being images that look slightly
off. It is exactly cause **C** in `comfyui-node-renders-but-dead`, filed there as *"the most
dangerous of the three, because nothing looks wrong on screen."*

Four concrete fragilities in the injection approach:

1. **The hook must survive.** Any extension replacing `app.graphToPrompt` without chaining silently
   removes yours. Order-dependent, no error.
2. **Prompt-ID matching is hard** — upstream maintains composite ids (`"5:"`-prefixed for subgraphs)
   plus a bare-id first-write-wins fallback, with a comment naming a real fix it needed. That
   machinery exists because the matching has already broken.
3. **Two sources of truth** — `node.properties` is what litegraph saves; the prompt value is
   *synthesized at submit*. They can diverge, and Python only ever sees one.
4. **API and headless runs get nothing.** POST a saved workflow to `/prompt` and there is no browser
   to run `graphToPrompt`, so every row is lost and the node returns the untouched model. This one
   matters here: the owner runs on Colab, and anything scripted or queued outside the browser would
   silently lose the whole stack.

**Their stated justification survives the change.** Their docstring argues that because the state is
part of the node's inputs, editing a row changes the cache signature so a run always picks up the new
value with no `IS_CHANGED`. That is true of a **declared widget too** — its value is part of the
prompt. Same benefit, none of the delivery risk; the `hidden` variant is strictly worse.

So, matching `panel_state` and `generation_settings`:

```python
"required": { "lora_state": ("STRING", {"default": "{}", "tooltip": "..."}) }
```

hidden for **rendering only** by the frontend, written after every mutation. Three consequences:

- **Widget order is append-only** (`9388cf9` broke this once) — `lora_state` holds a position.
- **Hiding is a JS responsibility.** If the JS dies the raw blob shows on the node — ugly but honest,
  and a genuinely useful failure signal (that is how a dead extension was spotted in one glance on
  2026-07-29).
- **The blob is definitely in the saved workflow.** Which is exactly why §8's rule that an API key
  must never live in it is load-bearing: the Preview embeds the workflow into saved PNGs, so a key
  there leaks into every shared image.

**The state SHAPE is worth adopting as-is** — per row `{id, name, on, sm, sc, triggers[]}`, plus
`cacheMode` and `sep` at the top level. Normalization must be tolerant and additive (unknown keys
pass through, missing keys default), same contract as `_rows_helpers.py`'s `parse_state`.

---

## 4. Node surface

| | name | type | notes |
|---|---|---|---|
| required | `model` | `MODEL` | every switched-on LoRA is applied to it |
| required | `lora_state` | `STRING` | §3 — hidden for rendering, natively serialized |
| optional | `clip` | `CLIP` | **must be `optional`** — a required socket hard-fails the queue when unwired |

Outputs: `MODEL`, `CLIP`, `triggers` (`STRING`). CLIP passes through unchanged when unwired.

**The subtle wiring trap, worth putting in the node's DESCRIPTION:** route the **patched** `CLIP`
onward to your text encode, not the loader's raw one. Wire the raw one and the LoRA's *model* effect
still lands while its *CLIP* effect vanishes — no error, just a weaker result and trigger words that
read differently than intended. (Same warning as `generator-design.md` §5b.)

### 4a. Category and file placement — no new auto-loaded `.js`

**`AnimaFlow/Controls`**, with the frontend in **`js/controls/`** and the node in
**`nodes/controls/`**. Reasoning:

- It is a sibling of `AnimaLoaderPanel` — both are "pick model files and hand them downstream".
- A fifth picker topic would be an invention; `generator-design.md` §5 rejected `Generate` for
  exactly that reason, and `AnimaFlow/Panel` is reserved for the deleted webtoon line.
- **It costs zero against the 5-auto-loaded-`.js` ceiling**: `js/controls/index.js` already registers
  two node classes and would register a third. The shared Civitai browser is then a `.mjs` both this
  node and the Loader Panel import — which is also why putting them in the same folder is convenient
  rather than merely tidy.

---

## 5. SETTLED: this is NOT a layer-3 socket-rows consumer

The board assumed a row-based node would be the **third** consumer of the socket-per-row mechanism and
would therefore trigger the deferred `js/shared/socket_rows.mjs` move. **It does not.**

Upstream's node has **three fixed outputs** (`MODEL`, `CLIP`, `triggers`). Rows are plain list
entries with **no socket of their own** — nothing to park, no per-row slot, no hole compaction. Ours
mirrors that.

So: **the layer-3 trigger does not fire, and that deferral stands untouched.** Do not restructure
`js/controls/rows.mjs` for this node. (If a future design ever wants a per-LoRA output socket, *then*
the trigger fires — but nothing here asks for one, and no upstream node emits a `LORA_STACK` object
anyway; see `generator-design.md` §5b.)

---

## 6. Sizing — Class A, but for a different reason than the panels

Per [`control-panel-design.md`](control-panel-design.md) **§7a**: content-fixed height, width
resizable with a min. Same as the two panels and the same as upstream, which the owner confirmed by
inspection ("they don't give option to change height").

**Be precise about why**, because §7a's justification does not apply here: the panels are Class A
because each row parks its output socket at that row's Y, so a scrolling body would slide rows off
their sockets. **This node has no per-row sockets (§5), so it *could* scroll** — Class A is the
owner's preference for a row-list node, not a structural necessity. Recording the distinction so
nobody "corrects" it later by pointing at the socket argument and finding it absent.

⚠️ **Read `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md` before writing a line of sizing
code.** Class A takes **four** layers, and getting one of them wrong fails silently — that cost five
wrong diagnoses on 2026-07-29. In particular: `node.size` is a **`Float64Array`**, so `Array.isArray`
guards are dead code; `onResize` is never called on the drag path; and `getMaxHeight === getMinHeight`
via `addDOMWidget` is the only real height lock.

---

## 7. The shared Civitai browser

**Ships under THIS node (owner, 2026-07-29 — see §9).** The Loader Panel reuses it afterwards, scoped
to **checkpoints/models and UNET only** for that first reuse pass.

A `.mjs` library plus its aiohttp routes. Not a LoRA feature — that is the whole point of item 4 in §2.

### 7a. Parameterise by KIND on day one, wire only `loras`

Shipping under one node while planning reuse has exactly one trap: building the library
LoRA-shaped and refactoring later. **Don't.** Take a `kind` from the start — `loras`,
`checkpoints`, `unet` — and wire only `loras` in this milestone. Cheap now, expensive to retrofit,
because *every* layer varies by kind:

| varies by kind | why |
|---|---|
| the ComfyUI folder key | `folder_paths.get_full_path("loras" \| "checkpoints" \| "diffusion_models", …)` — not the same string, and `unet`/`diffusion_models` has changed name across versions |
| the download destination | `models/loras/` vs `models/checkpoints/` vs `models/unet/` |
| sidecar location | `<base>.civitai.info` sits next to the file, so it follows the folder |
| the Civitai `type` filter | the search request must ask for LoRA vs Checkpoint |
| plausible file size | a LoRA is tens of MB, a checkpoint is single-digit GB — progress UI, timeouts and disk-space checks all differ in scale |

> 🔒 **The `kind` must be validated against a whitelist server-side, never used raw.** These routes
> resolve paths and (for download) **write files**, so a client-supplied folder key is a directory
> traversal waiting to happen. Map `kind → folder key` from a fixed dict and reject anything else,
> and keep upstream's path-guard-to-the-known-model-dirs check on every resolve.

`hasLora()`-style presence checks become `hasFile(kind, name)`. Upstream's client-side caching shape
(`invalidateInfo` / `invalidateList` / the "unknown, not missing, before first load" rule that stops
false ⚠ marks) generalises unchanged — just keyed by `(kind, name)`.

Surface, mirroring upstream's client-side caching (`api.mjs`'s `invalidateInfo` / `invalidateList` /
`hasLora` shape, which exists to avoid false "missing" marks before the first load):

| operation | key needed | notes |
|---|---|---|
| local file list | — | with missing-file marks, re-checked on `R` and on WS reconnect |
| metadata + preview by hash | **no** (§2b) | sidecar-cached, offline-capable |
| **search** | maybe (§8) | new; not in upstream |
| **download** | maybe (§8) | new; server-side Python only — the browser cannot write to `models/` |

**Spillover into the Loader Panel**, worth lifting even before this node exists: the searchable
picker, missing-file marks, the description/metadata panel, the downloader, and the memory-mode idea
(our loader helpers already cache per `(kind, name, dtype)` — `control-panel-design.md` §2 — but
expose no policy).

---

## 7c. THREE surfaces, one library (owner, 2026-07-29)

The browser is mounted three times with different **scope** and different **intent**. Scope is a
parameter, never a fork — §7a's `kind` plumbing is what makes this cheap.

| surface | scope | intent | primary action |
|---|---|---|---|
| **LoRA Loader** node | `loras` **only** | "fill this row" | download **and select into the row that opened it** |
| **Loader Panel** | **models only** (checkpoint / UNET) | "fill this loader" | download **and select into that slot** |
| **Toolbar modal** — NEW | **unscoped** | "browse Civitai" | download to the correct folder, derived from the result's own type |

The distinction that matters: the two **node-embedded** surfaces are *pickers* — kind-locked, and they
return a value to the caller. The **modal** is a *browser* — it answers to nobody and its result lands
on disk, with the destination folder taken from the result's type rather than from whoever opened it.
Build the picker path first (it is what milestone 2 needs); the modal is milestone 2b.

### 7c-i. All three get the FULL filter set (owner, 2026-07-29)

An earlier draft of this section called the pickers "narrow", which wrongly implied fewer features.
**It does not.** Search, filters and results are the same everywhere — the differences are only *scope*
and *outcome*:

| filter | picker (node) | modal |
|---|---|---|
| **type** | **locked** to the caller's kind, shown but not changeable | free |
| base model (SD1.5 / SDXL / Pony / Flux / Illustrious …) | ✅ | ✅ |
| sort (Relevancy / Most downloaded / Highest rated / Newest) | ✅ | ✅ |
| period (Day / Week / Month / Year / All time) | ✅ | ✅ |
| NSFW | ✅ | ✅ |

So exactly **one** filter behaves differently, and it is the one implied by the mount point: a LoRA
Loader's picker cannot search checkpoints, because it could not do anything with the result.

**Layout differs, feature set does not.** The modal has room for a filter **rail** (~216px). A node
panel is ~340px wide, so the same filters render as a **compact row of dropdown pills** — a rail there
would eat the results. Do not drop filters to fit; change their presentation.

#### The modal's filter rail — select-adds-a-chip, NOT a chip grid (owner, 2026-07-29)

Civitai's own rail is the reference for *structure* — collapsible sections, `Sort models by` /
`Filter by Base Model` / `Filter by Model Type` — but **not for the model-type control**, which they
render as a grid of ~19 always-visible chips (Aesthetic Gradient, Checkpoint, Controlnet, Detection,
DoRA, Hypernetwork, LoRA, LyCORIS, Motion, Other, Poses, Text Encoder, Embedding, UNet, Upscaler, VAE,
VLM, Wildcards, Workflows).

**Ours: a `<select>` per multi-value filter, and choosing an option appends a removable chip directly
under that section.** The reason to diverge is that a 19-chip grid *dominates the rail* and, worse,
leaves no way to see what is actually **applied** at a glance — every chip is present whether or not it
is active, so "on" is carried only by highlight. A select keeps the long list collapsed and the chips
below it show **only the active filters**, so the rail reads as *what am I filtering by right now*.

| filter | control | multi-value? |
|---|---|---|
| Sort models by | plain `<select>` | no — single choice, no chips |
| Period | plain `<select>` | no |
| Filter by Base Model | `<select>` → chips | **yes** |
| Filter by Model Type | `<select>` → chips | **yes** |
| Show NSFW | switch | no |

Details worth fixing now: selecting resets the `<select>` to its "Add a …" placeholder so it reads as an
*action* rather than a current value; a duplicate selection is a no-op; and an empty group shows a faint
`any` so "no filter" is stated rather than blank.

**Every filter chip carries an `✕`**, which is consistent with §1a-i rather than contradicting it: there,
the `✕` marks a word *you* authored versus one the file supplied. In the rail **every** chip is user-put,
so they all get one. The rule is the same — the `✕` means "you put this here" — it is just that the rail
has no other kind of chip.

**Filter choices are remembered user-wide, in Settings → AnimaFlow — not in the node's state blob.**
They are a browsing preference, not node behaviour, and per §7b that is the boundary. It also means the
picker and the modal open with the same remembered filters, which is the behaviour you want: it is one
browser with three mounts, not three browsers.

### 7c-ii. The node's picker opens a VERTICAL info panel (owner, 2026-07-29)

Clicking a result in the node's 🔍 picker opens **a new panel showing that model's information, laid out
vertically** — a sibling of the ⓘ panel, in the same narrow floating-panel idiom the node already uses.

**Not** an in-panel swap (drafted, rejected) and **not** the 90% modal (drafted, also rejected). The rule
that falls out of it, and the reason this is worth stating as a principle:

> **The node's surfaces are narrow vertical panels. The toolbar modal is the only wide surface.**

That is why a wide layout does not belong here: everything a user opens *from the node* — the picker, the
ⓘ panel, the ⚙ dialog, and now this — is a panel beside the node, so a fourth one should read the same
way. Sending a click from a node panel into a 90% modal is a much larger context jump than the action
warrants.

Layout, top to bottom, in the ⓘ panel's own idiom (§1a-i):

```
thumbnail + title + creator          identity
View on Civitai ↗                    §7d
──────────────────────────────────   <hr>
Version  [ v3.0 — 144 MB      ▾ ]
[ ↓ Download & use in this row ]     primary action -- returns to the row (§7c)
author's description
──────────────────────────────────   <hr>
COMMUNITY IMAGES                     ONE column, stacked; prompt on hover + copy
  [ image ]
  [ image ]
  ← back to results
```

**The gallery is a single stacked column here**, which is the point of "vertical": in a narrow panel one
image at readable width beats two cramped ones, and the prompt overlay has room to be legible. The
**modal's** detail keeps its multi-column grid (decision 11) — same data, same component, two layouts
chosen by which surface is hosting it.

`← back to results` returns to the picker's result list, with the query and filters intact.

**Milestone note (supersedes the earlier dependency warning):** because this panel is *not* the modal,
**M2 no longer depends on M2b.** The node's search, results and detail are all self-contained in M2; the
toolbar modal remains purely additive.
### The modal

**90% of the viewport**, centred, over a scrim. Full features: search, **filters** (type, base model,
sort, period, NSFW), a result grid with **preview images**, per-result detail with the author's
description, and download with progress.

#### The detail view — master→detail swap, with a community gallery (owner, 2026-07-29)

**Clicking a result card opens its detail**, and it does so by **swapping the results area** while the
filter rail **stays put**. Not a nested modal, and not a hidden rail: your filters are the context you
came from, and keeping them visible is what makes `← results` read as a step back rather than a new
place. A nested modal over a 90% modal also has nowhere to go.

Contents:

- **A version selector.** A Civitai model has *many* versions and they differ in file size, base model
  and trained words — and the by-hash lookup (§2b) is **per version**, so "download this model" is
  meaningless without one. Downloads target the selected version explicitly.
- Creator, type/base-model badges, stats, last-updated, and the author's description in full (this is
  the same text §2 item 3 wants surfaced in the node's ⓘ panel — one parser, two presentations).
- **A community-images gallery: the images users actually made with it, each showing its PROMPT on
  hover**, plus the generation parameters (sampler, steps, cfg, size) and a **copy-prompt** action.

**Why the gallery earns its place rather than being decoration:** a LoRA's own preview is the author's
best shot. The community grid is what it looks like in other people's hands, and the *prompt* is the part
you can actually reuse — that is the real reason someone browses Civitai instead of a filename list.
Copy-prompt is therefore a first-class action, not a nicety.

Three constraints:

- **The rail's NSFW toggle governs the gallery too.** Community images are the most likely NSFW surface
  in the whole feature. With it off they are blurred behind a click-to-reveal, not silently dropped —
  hiding them entirely would misrepresent what the LoRA is used for.
- **Prompts are untrusted text** — render with `textContent`, and remember a prompt legitimately contains
  `<lora:name:0.8>` sequences that must not be interpreted as markup.
- **Lazy-load thumbnails** and cap how many load at once; a gallery is the one place in this feature that
  can pull a lot of bytes, and §9's "never block a run" applies to bandwidth as much as to the event loop.

⚠️ **It is deliberately NOT the Rule Builder's overlay geometry.** That one is
`position: fixed; inset: 0; z-index: 10000` — genuinely full-bleed, because the Rule Builder is a work
surface you *live in* while authoring. A browser is a "look something up, take it, come back" surface,
so 90% with the graph visible at the edges keeps you oriented. Follow its *mechanism* (own overlay
root, scrim, Escape, focus handling), not its dimensions.

### Where the button goes, and the budget constraint that shapes it

Beside the **Rule Builder's** toolbar button, following the same pattern its `index.js` already
documents as lifted from `../ComfyUI-Pixaroma/js/align/index.js`: an **icon-only toolbar button**, plus
an `app.registerExtension({ commands: [...] })` entry so it is also reachable from the command palette
and bindable to a key.

> 🚧 **A new `js/civitai/index.js` would be a SIXTH auto-loaded `.js` and is therefore forbidden** —
> `.claude/CLAUDE.md` caps the pack at 5, and that ceiling is about what ComfyUI ships to every user on
> every page load. **Mount the toolbar button from `js/controls/index.js`** — the entry point that
> already registers this track's node classes and will register the LoRA loader too — and have it
> **lazily `import()` the modal `.mjs`** only when the button is actually clicked. Same trick
> `docs/settings.md` records for the settings section, which faced this exact choice and resolved it the
> same way.

### Two things to verify while in there

- The Rule Builder's own `index.js` carries a **`VERIFY-IN-COMFYUI`** doubting whether its `commands`
  entry surfaces anywhere a user can reach. Now that a live box is available, settle it — and if
  `commands` is unreachable, the toolbar button is the *only* affordance and this new one must not rely
  on `commands` either.
- **Stale naming, user-visible:** that command's label reads **`"Webtoon: Rule Builder"`** and its CSS
  classes are `webtoon-rb-*`, left from the deleted webtoon line. The pack is AnimaFlow. Worth fixing
  in the same pass rather than adding a second, correctly-named button beside a wrong one — but it is a
  rename of user-visible strings, so it is the owner's call, not a silent tidy-up.

---

## 7b. The ⚙ dialog — what we take, and the two things we drop

Upstream's dialog, read off a live screenshot (owner, 2026-07-29) — richer than its source grep
suggested:

| setting | ours? | notes |
|---|---|---|
| Default strength (new LoRAs) | ✅ | |
| **Strength step (arrows)** | ✅ | missed on the first read; a real convenience |
| Separate model / clip strength | ✅ | "Show two strengths per row" |
| Trigger words separator | ✅ | |
| LoRA memory use | ✅ | **labels `Standard` / `Fast` / `Lowest`, stored as `last` / `all` / `none`** |
| **Hide file extension** | ✅ | "Show the name without `.safetensors`" |
| **Civitai lookup button** | ✅ | see below — this is our offline-only switch |
| Show preview thumbnails | ✅ | bandwidth + clutter control |
| Highlight colour | ❌ | **dropped** |
| Set as default · Every Pixaroma node · Done | ❌ | **dropped** |

**The memory-mode labels confirm a decision we already made.** Human labels over raw keys is exactly
`cec90cd`'s display-name map (`Mode`, not `mode_type`), with the settings *path* untouched. Same rule
here: the UI says `Standard`, the state stores `last`.

**"Civitai lookup button" is more important for us than for them, and it governs MORE than theirs
does.** Upstream's toggle hides one thing: the lookup inside the info panel. **Ours hides every network
affordance on the node** — the ⓘ panel's `↻ Civitai` *and* the 🔍 browse button (below). One switch,
and the node is provably offline: there is no path left from which a request could originate.

That turns §9's "degrade silently offline" into a **user-selectable posture** rather than only a failure
path — worth having on day one even though search and download are milestone 2, and cheap, because each
affordance either renders or it doesn't. Name the setting **Civitai** rather than "Civitai lookup
button", since it now governs the whole capability rather than one button.

### Where the node's Browse button goes (owner, 2026-07-29)

**An icon-only button immediately beside the ⚙**, in the single header row (§1a-ii) — *not* a
full-width labelled button on its own row, which is what an earlier draft had. Reasons: the header
already carries the node's controls so a browse action belongs with them rather than claiming a row of
its own, and in a Class A node (§6) every row of chrome is permanent height that cannot be scrolled
away.

Header row, final: `＋ Add LoRA` · *(slack)* · master switch · `N/M` · **🔍** · **⚙**.

> 🎨 **Use an inline SVG or CSS-drawn icon, not an emoji.** The mockup uses 🔍 as a placeholder;
> emoji render inconsistently across platforms and clash with a dark theme. This pack ships no icon
> assets, which is exactly why the Rule Builder's toolbar button draws its own icon in CSS — its
> `index.js` says so explicitly, contrasting itself with Pixaroma's `/pixaroma/assets/icons/...`.
> Follow that precedent.

### Why the two drops

- **Highlight colour** — the pack has exactly one house accent ([`THEME.md`](THEME.md)), and today's
  three-round border saga was about *removing* accent from places it didn't belong. A per-node colour
  override would reintroduce that inconsistency deliberately. If a user wants a different accent it
  belongs in the theme, once, for the whole pack.
- **The three footer buttons** — they exist to paper over a dialog that mixes *per-node* and *global*
  state: "Set as default" persists your choices, "Every Pixaroma node" pushes them across nodes.
  **We already solved that split**: user-wide preferences live in **Settings → AnimaFlow**
  (`comfy.settings.json`, [`settings.md`](settings.md)), which survives a restart and works for
  API-only runs with no browser. So cross-node defaults go there and this dialog stays strictly
  per-node, edits applying immediately with ✕ to close. Fewer buttons *and* a cleaner boundary.

**Which layer owns what** — keep this split when implementing:

| lives in | what |
|---|---|
| the node's ⚙ (state blob) | anything that changes *this node's* behaviour: memory mode, separator, separate-strengths, per-node strength defaults |
| **Settings → AnimaFlow** | user-wide display/posture prefs: hide file extension, show the Civitai button, show thumbnails |

Remember the settings-id namespace is **append-only** (`settings.md`) — renaming an id silently
abandons whatever the user had set.

---

## 7e. The four Civitai lookup states — dead ends are where UI quality shows

Upstream has four (searching / found / notfound / offline) and renders them as a status strip. **Ours
gives each one the same three-part shape**, because two of the four are failures and a bare "not found" is
a dead end:

> **icon + headline · one line of cause-and-consequence · the one action that could change it**

| state | headline | says | action |
|---|---|---|---|
| **searching** | `Checking Civitai…` | (spinner) | `Cancel` |
| **found** | `Matched on Civitai` | cached next to the file — instant and offline from now on | `Re-fetch` · `Forget cached` |
| **notfound** | `This exact file isn't on Civitai` | **re-saving, merging or quantising a LoRA changes its hash**, so a LoRA that *is* published won't match once the file has been altered. Your file's own trigger words are still shown. | **`Search Civitai by name →`** |
| **offline** | the *specific* reason — `Civitai timed out` / `Couldn't reach Civitai (DNS)` / `Civitai sent an unreadable reply (a login or block page?)` / `Civitai returned 429` | nothing was lost: the file's own words are shown | `Retry` — and for `429`, name the key ladder (§8), since a key relieves rate limits |

Three things this buys that a status strip does not:

1. **`notfound` stops being terminal.** By-hash failed, but **by-name might work** — and we have search
   (M2). Turning the dead end into the feature we already built is the single best move available here,
   and it is the *common* case: a merged or re-saved LoRA is very often on Civitai under a name.
2. **The hash explanation prevents a wrong conclusion.** Without it, "not on Civitai" reads as *this LoRA
   is unknown*, when the truth is usually *this exact file has been modified*. Users otherwise conclude
   the lookup is broken.
3. **`offline` keeps upstream's distinct reasons instead of flattening them.** Their route already
   separates timeout / DNS / unreadable-reply / rate-limit and their code comment explains why
   (collapsing them "defeats the point of showing the user a reason at all"). Surface that difference —
   a timeout wants `Retry`, a block page wants a look at the network, a 429 wants a key.

**Every state also says what still works.** The file-derived trigger words never depended on Civitai, so
no failure state should imply the panel is useless — that is the difference between an error and a
degradation.

---

## 7d. `View on Civitai ↗` on every per-model info surface (owner, 2026-07-29)

The ⓘ panel already has it (§1a-i). **It belongs on every surface that shows one model's information**:

| surface | milestone |
|---|---|
| the node's ⓘ panel | M1 |
| the modal's detail view (which is also the picker's, §7c-ii) | M2b |
| the Loader Panel's model info | M3 |

**Why it is a rule rather than three separate buttons:** whatever we render is a *curated subset* of
someone else's page. Civitai always has more — comments, the full image gallery, other versions'
changelogs, the licence terms. An info surface with no way out is a dead end that quietly implies we
showed you everything. One link keeps us honest about being a convenience layer over their catalogue.

It also has to link to the **specific version** being viewed, not the model's landing page, since the
detail view has a version selector (§"The detail view") and the trigger words and file size shown belong
to *that* version.

**Governed by the Civitai setting (decision 20).** With it off, this link is hidden too — even though
opening a link is technically the *user's* network call and not the node's. Rationale: someone who turned
Civitai off wants no Civitai, and "off means off everywhere" is a rule you can reason about, whereas
"off, except the links" is one you have to remember. Cached sidecar info still displays; only the way out
disappears.

---

## 8. API key handling — resolution order, and the one place it must never go

1. our own ComfyUI setting (`AnimaFlow.*`, stored server-side in `comfy.settings.json`), then
2. the **`CIVITAI_API_KEY`** environment variable — Civicomfy's own convention, so anyone already
   running it gets ours working with zero setup, then
3. no key ⇒ **public-only mode, clearly indicated** rather than silently degraded.

**Never the node state blob.** It is a serialized STRING widget, so it lands in the saved workflow —
and the Preview embeds the workflow into saved PNGs. A key there leaks into every image the user
shares. (This is not hypothetical: a Colab notebook in this repo shipped a live tunnel token for the
same class of reason — saved UI state is a credential sink, and it is invisible until someone looks.)

When an operation genuinely needs a key (gated/early-access files, rate-limit relief), **say so in the
UI naming what to do** — never a bare 401, and never silently return nothing.

---

## 9. THE open decision — the outbound-network policy

Everything in this pack today is local. This is its **first outbound network call**, and the policy
needs settling before code, because it shapes the route design rather than decorating it:

- **Never block a graph run.** A LoRA that applies must not wait on Civitai. Upstream's lookup is
  *only* on an explicit click, and that is the shape to keep.
- **Degrade silently offline** — a node must still load and execute with no network at all.
- **Rate limiting** — ours, not just Civitai's, since a stack of rows could fan out.
- **Downloads are server-side Python**, streamed, resumable if cheap, with progress reported to the
  UI and a hard cap. The Colab launcher already has a model downloader with present/missing
  detection — read it for reusable shape before starting fresh.
- **Where files land**, and what happens on a name collision or a partial download.

### 9a. SETTLED — order of work (owner, 2026-07-29)

**The node ships first, and the Civitai feature ships under it.** The Loader Panel reuses the same
library afterwards, and that first reuse pass is scoped to **checkpoints/models and UNET only**.

Consequences, all deliberate:

- The library is **kind-parameterised from the first commit** but only `loras` is wired — §7a, which is
  the one thing that must not be deferred, since retrofitting `kind` touches folder resolution, the
  download destination, sidecar paths, the search filter and the path guard all at once.
- **Milestone 1 can be genuinely useful with no network policy resolved at all**: rows + picker +
  missing marks + file-derived trigger words + the hash lookup, which per §2b needs no key and caches
  offline. Search and download can land in milestone 2 once §9's policy is settled — so the open
  decision below **does not block starting**.
- The Loader Panel gets nothing until milestone 3. Accepted; it already works today.

---

## 10. Tests

Plain-script, no pytest (`python3 tests/test_x.py` from repo root), and `node js/**/test_*.mjs`.

- **State normalization**: unknown keys survive, missing keys default, a hostile blob never raises.
- **`triggers` provenance**: words come only from rows that actually applied; a missing/corrupt file
  contributes none; a strength-0 row still counts (§1b).
- **Memory modes**: `last` keeps exactly one entry across a run and does **not** evict the retained
  entry on the first row of a multi-row stack (upstream's own regression); `all` frees entries for
  removed rows; `none` clears.
- **Civitai parsing is pure and offline-testable** — feed recorded JSON, including the
  no-`trainedWords`/no-`model.name` case that must still count as FOUND (§2b).
- **Route behaviour**: always 200 with a `reason`; a 404 does not try the backup host; an oversized
  body is rejected.
- **Sizing**: per §6's skill — and **size tests must run against a `Float64Array`**, not only a plain
  array, or they prove nothing.
- **Widget order frozen** in a regression test, `lora_state` included.
