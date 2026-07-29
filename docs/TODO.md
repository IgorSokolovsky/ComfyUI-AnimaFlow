# TODO — the work board

The live queue. **[`BACKLOG.md`](BACKLOG.md) is the other half**: long-horizon reference for the
anima rebuild, organised by upstream feature. This file is organised by *what happens next*.

Two rules, both learned the hard way:

- **A deferred item states WHY.** "Not now" without a reason gets tidied away by the next person, or
  re-litigated. Three things were nearly lost that way (layer 3's location, Controls' gear glyph,
  `usefulRange`).
- **A done item carries its commit.** The board doubles as a changelog, and a claim you can't trace
  to a SHA is a claim you can't check.

Status is only meaningful if it's honest: **"done" means merged and pushed, not "the tests pass"**.
Anything shipped but not yet exercised in a live ComfyUI belongs in *Done (unverified)*.

---

## Now

*Now is empty.*

> ### ✅ Resolved 2026-07-29 — the Class A height bug, on the third attempt
>
> `dd7261a` shipped a height lock that **did not work**, and the reason was only ever findable by
> measuring the running node. On a live 3-row `AnimaControlPanel`, after dragging the height:
> `onResizeCalls: 0`, `onResizeInstalled: true`, `vueNodesMode: false` — correctly wired, not
> self-disabled, **never invoked**. Litegraph does not call `onResize` on that renderer's resize-drag
> path, so every correction hanging off it was dead code on a drag. Fixed in `d9b9106` with a
> per-frame `onDrawForeground` correction, which survives both that and litegraph re-applying a dragged
> size afterwards. `onResizeControls` is kept — it is correct wherever it *does* fire, and the
> reference implementation carries both hooks for exactly this reason.
>
> **The hidden `panel_state` widget was NOT a second cause** — settled by decompiling the installed
> `comfyui_frontend_package` 1.47.10 rather than by argument:
> `getLayoutWidgets(){return this.widgets?.filter(e=>!e.hidden)??[]}`, and `_arrangeWidgets` (which
> assigns each widget's `.y` and sums heights into the node's natural size) iterates **only** that
> filtered list. Our `hideStateWidget` sets `.hidden = true`, so the technique is correct and the
> `y: 166` in the probe was a stale inert value. The 198 was simply where the test drag landed,
> uncorrected. `hideStateWidget` was deliberately left alone: nothing to fix, and it carries the
> serialized `panel_state`.
>
> **Process lesson, and this one cost three passes.** Two diagnoses before this were argued from
> reading source, both survived a review, and both were wrong — the code was correct, it was simply
> never called. A third hypothesis (the hidden widget) was also wrong. `onResizeCalls: 0` is a fact no
> amount of code reading produces. **For a live-behaviour bug, measure the running thing first;** and
> when a reference implementation carries a comment explaining why it needs a second mechanism,
> porting only the first one is a decision that needs a trigger, not a footnote.

## Next

### 🎨 Our own LoRA loader — **needs a spec** (added 2026-07-29)

Wanted: an AnimaFlow LoRA loader, taking Pixaroma's as the starting point because it's the one the
owner actually likes, and **carrying whatever it's missing** — plus spilling some of its capabilities
back into our own Loader Panel (UNET/checkpoint).

**Baseline — what `../ComfyUI-Pixaroma`'s already does**, so we don't rediscover it (MIT © pixaroma;
porting is fine *with attribution*, per `.claude/CLAUDE.md` and `THIRD_PARTY_NOTICES.md`):

| | |
|---|---|
| shape | many LoRAs stacked in one node, one row each; `MODEL` + optional `CLIP` in → `MODEL` + `CLIP` + **`triggers`** (STRING) out |
| per row | model/clip strengths, on/off, drag to reorder |
| triggers | trigger words picked per LoRA, joined as plain text for the prompt — the output that makes it more than a stack |
| picker | searchable/filterable dropdown, **missing-file marks** that re-check on `R` (Refresh Node Definitions) and on websocket reconnect |
| info | a **Civitai** panel — metadata, preview thumbnails |
| memory | three cache modes — `last` (ComfyUI parity), `all` (fast re-runs, GBs), `none` (re-read every run), with entries released between applications so peak stays ~2 files, not the whole stack |

**What's missing (owner, 2026-07-29) — Civitai as a first-class source, not just a metadata peek:**

1. **The author's own description** from Civitai, not only the numeric metadata — the notes that say
   how a LoRA is meant to be used.
2. **Search Civitai from inside the node** — find a LoRA without leaving ComfyUI.
3. **Download to local**, the way the **Civicomfy** custom node does it (installed on the owner's
   Colab box) — pick a result, fetch it into the right `models/` folder, use it immediately.
4. **The same for models**, not just LoRAs — so the UNET/checkpoint side of the Loader Panel gets it
   too. That makes this a **shared Civitai browser** consumed by two nodes, not a LoRA feature.

**Settled (owner, 2026-07-29):**

- ✅ **Licence: Civicomfy is MIT** — [MoonGoblinDev/Civicomfy](https://github.com/MoonGoblinDev/Civicomfy),
  verified on the repo page 2026-07-29. So porting is fine **with attribution**: add its own section
  to `THIRD_PARTY_NOTICES.md` with a per-file derivation table, exactly as the Pixaroma and
  EasyUseAnima entries do, at the moment anything is actually derived from it. (It isn't a sibling
  clone here — pull it locally before porting, and re-verify the licence at that point rather than
  trusting this line.)
- ✅ **No API key required for basic use.** Search and public downloads must work with no key at all.
  When an operation genuinely needs one (gated/early-access files, rate-limit relief), say so
  **in the UI, naming what to do** — never fail with a bare 401 or, worse, silently return nothing.

**Key handling — resolution order, and the one place it must never go:**

1. our own ComfyUI setting (`AnimaFlow.*`, stored server-side in `comfy.settings.json`), then
2. the **`CIVITAI_API_KEY`** environment variable — Civicomfy's own convention, so anyone already
   running it gets ours working with zero extra setup, then
3. no key ⇒ public-only mode, clearly indicated rather than silently degraded.

**NEVER the node settings blob.** That blob is a *serialized STRING widget*, so it lands in the saved
workflow — and the Preview **embeds the workflow into saved PNGs**. A key stored there would leak
into every image the user shares. (This session's Colab notebook shipped a live tunnel token for the
same class of reason: saved UI state is a credential sink, and it's invisible until someone looks.)

**⚠️ Still to settle — this is the pack's first outbound network call.** Everything today is local.
It needs: never blocking a graph run, degrading silently offline (a node must still load and execute
with no network), rate limiting, and downloads done **server-side in Python** — the browser can't
write to `models/`. The Colab launcher already has a model downloader with present/missing
detection; read it for reusable shape before starting fresh.

**Spillover to our Loader Panel** — candidates worth lifting even before the LoRA node exists:
searchable picker, missing-file marks, the Civitai description/metadata panel, the downloader, and
the memory-mode idea (our loader helpers already cache per `(kind, name, dtype)` —
`control-panel-design.md` §2 — but expose no policy).

**Sizing class is already decided for it: Class A** (owner, 2026-07-29) — content-fixed height, width
resizable with a min, exactly like the two existing panels and like Pixaroma's own LoRA loader. The
contract is [`control-panel-design.md`](control-panel-design.md) §7a; **read it before building this
node's frontend**, because retrofitting a sizing class means touching resize, the drag floor and the
load-race guard together.

**Fits our layering:** a row-with-sockets node ⇒ it's a **layer 3** consumer, which would make it
the *third* one and trigger the deferred `js/shared/socket_rows.mjs` move (see Deferred below).
Worth deciding that up front rather than after.

- **Controls' own gear glyph** duplicates `js/shared/fields.mjs`'s `buildGearIcon` — same purpose, two implementations, two sizes/hit-areas. Unifying changes that track's visuals, so it needs its own task and a look.
- **Audit the remaining `VERIFY-IN-COMFYUI` markers** (~30 across the three tracks) now that a live box is available — several predate features that have since shipped.
- **`docs/nodes-and-api.md`** — verified accurate 2026-07-29, but it has no entry for the settings section or the logging channel.

## Deferred — with the reason

| Item | Why it's deferred |
|---|---|
| **Layer 3 (socket rows) moving to `js/shared/`** | Its only two consumers, Control Panel and Loader Panel, already share it by sitting in the same folder. Moving it now buys nothing and touches the most fragile code in the pack (slots, sockets, hole compaction, load-race guards). The *contract* is written down instead — `control-panel-design.md` §6a — so the eventual move is a rename, not an untangling. **Trigger: a third socket-per-row node.** |
| **`usefulRange` staying in `js/controls/rows.mjs`** | Pure enough to qualify for `field_logic.mjs`, but it has exactly one caller and no cross-track consumer. Promoting it now would be speculative generality. **Trigger: a second consumer.** |
| **ResShift as a second Upscale backend** | Needs `ComfyUI-Distilled-ResShift`, which isn't installed. A Mode dropdown offering one usable option is worse than no dropdown. Full detail in [`BACKLOG.md`](BACKLOG.md) §1b-0. |
| **`.claude/` staying out of the repo** | Owner's call (2026-07-29). Consequence to keep in view: the skills — including the ComfyUI findings from that session — live on one machine only and don't travel with a clone. |
| **The reuse-last-seed (↺) button on the Generator** | Control-Panel-only today. Not asked for on the Generator; noted so it isn't mistaken for an oversight. |

## Done (unverified in a live ComfyUI)

Shipped and green, not yet exercised against a running ComfyUI.

| Item | Commit |
|---|---|
| Class A sizing: panel height content-fixed via a **per-frame** `onDrawForeground` correction (plus the `onResize` and load-path hooks) — a 3-row panel should settle at exactly 157 | `dd7261a` → `d9b9106` |
| Class B sizing: `GENERATOR_MIN_H` (356 at the 14px base) + `clampGeneratorSize` clamping both axes, and the fresh-node default guarded against the floor at large font scales | `be6ea69` |
| `Save now` button height matches its card at every font scale (`SAVE_NOW_BTN_H = SHEAD_H`); floors moved to 288/368 | `f620f4b` |
| Hover tint + `cursor: pointer` scoped to genuinely clickable headers (Sampler, Save row) — not switch-bearing sections, not the Compare card | `61716f9` |
| Settings section, seven settings | `b7e66dc` — **confirmed working 2026-07-29** |
| Server-side run logging (stage status, sampler provenance, model files) | `9addec1` |
| `ui` payload must be a list — post-run values/disable reaching the panel at all | `f22b3c0` |
| Chevron + gear visibility, gear pinned right | `dd89b9d` |
| Subgraph boundary crossing for the context walk | `84ec4a5` |
| Seed as a string, text+roll row, `seed_after_generate` implemented | `d1f8942` |
| One seed row; four field builders moved to `js/shared/fields.mjs` | `21ccd1d` |
| `colab/` folder, sanitized notebook, layer 1 extraction + the layering guard test | `a630ae4` |
| `%seed%` in a Save-now filename resolves to the real seed — carried as `anima_seed: [str(seed)]`, string end-to-end, `int` once at `format_filename` | `9874426` |
| Preview Save defaults off, plus a **Save now** button (`POST /wtn/anima/preview/save_now`) | `cec90cd` |

## Done (confirmed by use)

| Item | Commit |
|---|---|
| Nested overlays — a ⚙ menu survives opening a stepper's option list inside it | `cec90cd` |
| Bool switch owns its state; on/off word dropped, switch right-aligned; inherit ⓘ beside its label | `cec90cd` |
| Human field labels via a display-name map (settings paths unchanged) | `cec90cd` |
| Card border carries **no accent at all** — three live rounds: full accent too glaring, `rgba(…,.35)` still too light, now plain `--wtn-line-soft`. Also fixed the missing `TOKENS.lineSoft` (an inert `var(…, undefined)` fallback at 10 sites) | `98d0fe5` → `a6478f0` |
| Field rows painted `--wtn-console`; the old `--wtn-surface-2` look now means **disabled** | `61716f9` |
| Preview body: `Save now` beside the Save card, one-row Compare card, segmented groups → menu pickers | `61716f9` |
| Section body's `23px` left indent dropped — the card border carries the nesting now | `61716f9` |
| `generator-design.md` catches up with `cec90cd` — §7a's Save-off reversal, §8's two stale blob values, §12's stale "overlay.mjs is untouched" retraction, and the "index.js registers both node classes" claim (it covers three) | `1fe13a6` — every claim checked against source, so nothing here is waiting on a live box |
| V3 `NodeOutput` unwrapping — the Detailer runs | `d2b35da` |
| Model pickers + readable pre-flight error for a missing model file | `d2b35da` |
| Node defs in both V1 and V3 combo schemas; live sampler/scheduler lists | `1d3fa41` |
| Accordion cards, ⚙ menus, 14px type, working stepper dropdowns | `60d46e4` |
| Saved node **width** surviving refresh (both tracks) | `60d46e4`, `f9e5c79` — ⚠️ **narrowed 2026-07-29.** This row used to claim "size", which live measurement disproved for HEIGHT on the Controls track (a 3-row panel sat at 198 against a content height of 157 — see Now items 1–2). Width is confirmed; height is a different mechanism entirely and, under the Class A contract, is not meant to be persisted at all. |
| Use Everywhere submit-churn no longer wiping the run report | `60d46e4` |
| Preview: image fills the node, no internal scroll, one preview not two | `f22b3c0`, earlier |
