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
  LoRA), on/off, model + clip strength with ▲▼ steppers, an ⓘ button, and a right-click menu —
  **↑ / ↓ / Duplicate / Remove**.
- **Missing files** turn the **whole name field red**, border included — re-checked on `R` (Refresh
  Node Definitions) **and on WebSocket reconnect** — the same moments native combos refresh —
  repainting every LoRA node, including ones inside subgraphs.

### 1a-ii. The header strip and row layout — corrected from a reference shot (2026-07-29)

Another case where reading the source under-described the UI. The corrected target is in the mockup:

- **A master all/none switch with an `N / M on` counter**, on a strip under a prominent full-width
  `＋ Add LoRA`, with the ⚙ at its right. The switch reads **on only when EVERY row is on**; a mixed
  state shows it **off** with the count carrying the truth (`2 / 3 on`). Clicking it when mixed *or*
  all-off turns **everything on** — the action you almost always want — and only turns everything off
  when everything already is. Without the counter, mixed would be indistinguishable from all-off, which
  is exactly why the count sits beside the switch rather than in a tooltip.
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
2. **`all` / `none` quick-select** beside the section label.
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

The distinction that matters: the two **node-embedded** surfaces are *pickers* — narrow, kind-locked,
and they return a value to the caller. The **modal** is a *browser* — it answers to nobody and its
result lands on disk, with the destination folder taken from the result's type rather than from whoever
opened it. Build the picker path first (it is what milestone 2 needs); the modal is milestone 2b.

### The modal

**90% of the viewport**, centred, over a scrim. Full features: search, **filters** (type, base model,
sort, period, NSFW), a result grid with **preview images**, per-result detail with the author's
description, and download with progress.

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

**"Civitai lookup button" is more important for us than for them.** Turning it off means the node
*never makes a network call* — so §9's "degrade silently offline" becomes a **user-selectable posture**
rather than only a failure path. That is worth having on day one even though search/download land in
milestone 2, and it is cheap: the button either renders or it doesn't.

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
