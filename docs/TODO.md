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

### 📋 Owner's check — does the LoRA Loader actually change the image? (open 2026-07-30)

**The only behavioural gap left in the LoRA track.** Every live check so far has been UI — the picker,
the ⓘ panel, the ⚙ dialog, the search panel, all confirmed. Nothing has confirmed the node affects a
generation at all.

Two things, one pass:

1. Add a LoRA with an obvious visual effect at strength 1.0. Same seed, row on vs row off — the image
   must change.
2. Wire the node's **own `CLIP` output** onward, not the raw CLIP from the Loader Panel. With the raw
   one the model effect still lands while the **CLIP effect silently vanishes** — no error, just a
   weaker result (design doc §4). That is the failure mode most likely to go unnoticed, so check it
   deliberately rather than assuming the wire is right.

### 📋 Owner's check — does a LoRA Loader inside a **subgraph** still self-heal? (open 2026-07-30)

ComfyUI lets you select nodes and collapse them into a reusable **subgraph** node. Those nodes then
live in a *nested* graph — they are **not** in `app.graph._nodes`, which `findLoraNodes()` walks
directly. So a LoRA Loader hidden inside a subgraph may be invisible to our refresh hook.

**Check:** put an `AnimaLoraLoader` inside a subgraph → point one row at a model file → delete or
rename that file on disk → press `R` (refresh node definitions). The row's red missing-file mark must
update. If it stays stale, `findLoraNodes` needs to recurse into subgraph children.

No headless test can reach this — the walk is over the live graph object — which is why it sits here
rather than in a suite.

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

### ✍️ Revisit the Prompt track — Rule Builder fixes + UI changes, and the Prompt Builder (owner, 2026-07-30)

Owner wants to come back to the prompt side: **fix some things and change some UI**. Two distinct
pieces of work, deliberately named separately because they are not the same kind of task:

- **Rule Builder** (`PromptRulesText` / `PromptRulesClip`, `js/prompt_rules/`) — **exists and ships.**
  This is a change pass on a working feature: specific fixes plus UI changes, both **still to be
  specified**. Read [`rule-builder.md`](rule-builder.md) and
  [`rules-reference.md`](rules-reference.md) before touching it, and note the overlay and the node UI
  are separate surfaces (`js/prompt_rules/rule_builder/` vs `js/prompt_rules/node/`).
- **Prompt Builder** — **deleted, deliberately** (see `.claude/CLAUDE.md`'s "Deleted, deliberately"
  list, alongside Prompt Combiner and the whole `AnimaFlow/panel` group). Bringing it back is a
  **re-specification, not a restore** — the owner said at deletion time they would re-specify on need,
  and this is that need. Do not reconstruct it from git history and assume the old shape was wanted.

**Nothing is specified yet** — this entry exists so the intent isn't lost, not as a ready brief. The
memories worth loading first: Anima's structured prompt format is **labelled PROSE sections, not
JSON** (JSON tested worse), and every composing node must stay **prompt-format-agnostic** — booru tags
*and* natural-language prose, configurable separator, no comma-splitting assumptions.

### 🎨 LoRA loader — **M1 BUILT, awaiting live verification** · M2 / M2b / M3 still spec (2026-07-29)

**M1 shipped** across five reviewed slices — the node, the picker, the ⓘ panel + Civitai hash lookup,
the ⚙ dialog, FLIP drag-reorder. It is in *Done (unverified)* below with the exact checks to run.
**What remains here is M2 onward**, and §9's network policy still gates it.

The rest of this section is the original spec framing, still accurate for M2/M2b/M3:

**→ [`lora-loader-design.md`](lora-loader-design.md) — read its §0 first.** It carries the status, a
20-row decisions table, the build plan, and the required-reading list. **→
[`playground/lora-loader.html`](../playground/lora-loader.html)** is the interactive behavioural
reference (drag a row, toggle the master switch, add a custom trigger word, flip the Civitai setting off,
open the modal and click a card).

Everything that was open here on the morning of 2026-07-29 is settled in that doc — 20 owner decisions
taken across a design session, several of them reversing what reading the upstream source suggested.
The four that most change the shape of the work:

- **Civitai metadata needs NO API key** (hash → public endpoint, sidecar-cached), so the key ladder only
  ever applied to search and gated downloads.
- **Not a layer-3 socket-rows consumer** — that deferral below stands untouched.
- **Zero new auto-loaded `.js`** — it registers from `js/controls/index.js`, and the toolbar modal
  lazily imports.
- **Three surfaces, one kind-parameterised library**: two kind-locked pickers plus an unscoped 90%
  toolbar modal with a community-image gallery.

**Milestones:** M1 the node (offline-capable, needs no network policy) · M2 search + download (needs the
policy) · M2b the toolbar modal · M3 Loader Panel reuse for checkpoints + UNET.

**The one thing still open: §9's outbound-network policy** — the pack's first network call. It does
**not** block M1.

~~Two unrelated things to settle while in `js/controls/index.js`~~ — **the label/CSS rename is DONE**
(owner-approved, M1 slice 5: `"AnimaFlow: Rule Builder"`, `webtoon-rb-*` → `wtn-rb-*`, `COMMAND_ID` →
`AnimaFlow.OpenRuleBuilder`). The **`VERIFY-IN-COMFYUI` about whether `commands` is reachable at all is
still open** — it cannot be settled headlessly, so it was *sharpened* into a one-step live check rather
than deleted. See the verification list below.

**Left deliberately:** `app.registerExtension({ name: "webtoon.<track>" })` in all **five** entry points.
It is a shared convention and a per-extension enable/disable persistence key; renaming one of five would
create the inconsistency the rename was meant to remove, and would silently reset that choice. **Trigger:
rename all five together, or not at all.**

### 🧩 Nodes 2.0 (V2) — our DOM UI should render there too (owner, deferred 2026-07-30)

Owner enabled V2 and found the node **works but falls back**: every DOM/sizing path bails on
`isVueNodes()`, so ComfyUI's native widgets take over — combo pickers per row, a plain `+ Add loader`.
Functional, but none of our UI. **Owner wants real V2 support, explicitly deferred to later.**

Being honest about the size: this is a milestone, not a fix. Everything the Controls and Anima tracks do
visually is legacy-litegraph-specific — the four Class A sizing layers, `getMaxHeight` as the only real
height lock, `onResize` never firing on the drag path, `node.size` being a `Float64Array`, the DOM-widget
mount, drag-reorder, the overlay/anchor mechanism. `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`
is a catalogue of **measured legacy behaviour**; under Vue rendering essentially none of it transfers, and
`computeLayoutSize`/`minWidth:1` (kept for forward-compat) has never been exercised.

**Done meanwhile:** the raw `panel_state` blob no longer renders in V2 — that leak made the fallback look
broken rather than degraded.

**Trigger:** the owner switching to V2 as their daily renderer, or ComfyUI defaulting to it.

## Deferred — with the reason

| Item | Why it's deferred |
|---|---|
| **Layer 3 (socket rows) moving to `js/shared/`** | Its only two consumers, Control Panel and Loader Panel, already share it by sitting in the same folder. Moving it now buys nothing and touches the most fragile code in the pack (slots, sockets, hole compaction, load-race guards). The *contract* is written down instead — `control-panel-design.md` §6a — so the eventual move is a rename, not an untangling. **Trigger: a third socket-per-row node.** |
| **`usefulRange` staying in `js/controls/rows.mjs`** | Pure enough to qualify for `field_logic.mjs`, but it has exactly one caller and no cross-track consumer. Promoting it now would be speculative generality. **Trigger: a second consumer.** |
| **ResShift as a second Upscale backend** | Needs `ComfyUI-Distilled-ResShift`, which isn't installed. A Mode dropdown offering one usable option is worse than no dropdown. Full detail in [`BACKLOG.md`](BACKLOG.md) §1b-0. |
| **`.claude/` staying out of the repo** | Owner's call (2026-07-29). Consequence to keep in view: the skills — including the ComfyUI findings from that session — live on one machine only and don't travel with a clone. |
| **The reuse-last-seed (↺) button on the Generator** | Control-Panel-only today. Not asked for on the Generator; noted so it isn't mistaken for an oversight. |
| **Renaming `offline_reason: "civitai_disabled"`** (`src/model_browser/lookup.py`) | The name is stale — since BUG 13 it is returned on **every** cache-miss open, not only when the Civitai setting is off, because `cached_only` is driven by `!force` rather than the setting. But it is **not** a private label: `js/controls/model_info.mjs:1087` branches on the exact literal to pick the "not checked yet" UI state, so the value crosses the HTTP boundary as live control flow. A reviewer called it "not user-facing, a doc nit"; that was true of the `message` text and wrong about the *value*, and a Python-only rename would silently break that detection. **Trigger: a coordinated Python + JS + tests pass** — cheap, but it must move `lookup.py`, `model_info.mjs`, `civitai_api.mjs`'s doc comment and both test files together. No user-visible impact until something else renders that reason. |

## Done (unverified in a live ComfyUI)

Shipped and green, not yet exercised against a running ComfyUI.

> ### 🎨 LoRA Loader M1 — `815c286` · `0ed9bd0` · `9a3b132` · `ae7cd38`, **partly confirmed live**
>
> Built 2026-07-29, exercised in a real ComfyUI 2026-07-30. That session found **17 bugs in two rounds**
> — every one by *using* the node, none by the suites, which stayed green throughout. Worth remembering
> when weighing a test count against a live pass.
>
> **Confirmed working by use (2026-07-30):** the node loads and appears under `AnimaFlow/Controls`; the
> picker (groups, local thumbnails, size/base-model line); the ⓘ panel and the Civitai by-hash lookup
> reaching `found` with a sidecar; the ⚙ dialog and its settings; per-node `DESCRIPTION` in the picker.
>
> **Fixed after live report, NOT yet re-tested** (`ae7cd38`): the lookup no longer fires on panel open
> (a genuine §9 violation — every open hashed the whole file and hit the network); drag no longer
> overshoots on a zoomed canvas; a new row no longer overflows the node until the mouse leaves; author's
> notes fetch the real model description and render as text not raw HTML; the gear reads as a gear;
> strength is typeable.
>
> **What shipped:** `AnimaLoraLoader` (8th node) · `src/model_browser/` (kind whitelist, chunked SHA256,
> safetensors header-only metadata, Civitai client on stdlib `urllib`, sidecar cache, guarded
> executor-offloaded routes) · the picker · the ⓘ panel + the four lookup states · the ⚙ dialog's eight
> settings · FLIP drag-reorder · the Rule Builder rename.
> **Suites at the time of that build: Python 672, JS 1182, 5 auto-loaded `.js`, 8 nodes.** (Current
> totals live at the top of *Done (confirmed by use)* — re-count rather than trusting either number.)
>
> **✅ Confirmed live by the owner, 2026-07-30** — four of the six then-open checks:
> - **Drag a row and the node height does not move, even transiently.** This closes the last open
>   Class A behaviour from the 2026-07-29 sizing work, now with a FLIP animation over it.
> - **Save + reload** keeps rows, trigger selections and node **width**; a clean workflow does not
>   open as "modified".
> - **`notfound`** explains the hash instead of dead-ending.
> - **Civitai off** renders no network affordance anywhere, **while already-cached notes and trigger
>   words still display** — that combination is the whole point of §7d.
>
> **STILL UNVERIFIED:**
> 1. **The image actually changes.** Promoted to *Now* above — the only behavioural gap left.
> 2. **Subgraph recursion.** ComfyUI lets you collapse selected nodes into a reusable **subgraph**
>    node; those nodes then live in a nested graph, NOT in `app.graph._nodes`. `findLoraNodes()` walks
>    `app.graph` directly, so it may never see them. **Check:** put an `AnimaLoraLoader` inside a
>    subgraph, point one row at a file you then delete or rename, press `R` (refresh node
>    definitions) — the row's red missing-file mark must update. If it doesn't, `findLoraNodes` needs
>    to recurse into subgraph children. No headless test can reach this.
> **✅ The `VERIFY-IN-COMFYUI` on `commands` is SETTLED (owner, 2026-07-30): it is there and it
> works.** The command palette does surface extension-registered commands, so `"AnimaFlow: Rule
> Builder"` (`js/prompt_rules/rule_builder/index.js:62`) is a real, reachable affordance — **keep the
> `commands` registration**; it is not dead code. Two consequences worth knowing: a `commands` entry
> is the thing a keyboard shortcut can point at, so a shortcut can be bound in **Settings →
> Keybinding**; and the earlier `Webtoon.* → AnimaFlow.OpenRuleBuilder` id rename dropped any binding
> that existed against the old id.

| Item | Commit |
|---|---|
| Class B sizing: `GENERATOR_MIN_H` (356 at the 14px base) + `clampGeneratorSize` clamping both axes, and the fresh-node default guarded against the floor at large font scales | `be6ea69` |
| Hover tint + `cursor: pointer` scoped to genuinely clickable headers (Sampler, Save row) — not switch-bearing sections, not the Compare card | `61716f9` |
| `colab/` folder, sanitized notebook, layer 1 extraction + the layering guard test | `a630ae4` |

## Done (confirmed by use)

**Suites as of 2026-07-30: Python 867 (1 skip), JS 1373, 5 auto-loaded `.js`, 8 nodes.** These only
ever grow — re-count rather than trusting the number.

> ### 🐛 ROOT CAUSE — the Loader Panel loaded the wrong model (`4e2c3ac`, confirmed live 2026-07-30)
>
> A whole session, **ten** dead hypotheses. The node kept using the previously loaded UNET after the
> owner picked a different one, and it always started working after "add a row, run, remove it, run".
>
> **What it was:** the row DOM held row objects that were no longer the ones `persistState`
> serialized. Measured on the live node, not argued — after picking a new unet:
> `domRow.value="JANIMA_v10"`, `liveState.value="animayume_v10BaseFinal"`, `sameObject=false`,
> `idInLiveState=true`, ids **preserved** (7/8/9). A combo click set `row.value` on the detached
> object; `repaintRows` read `entry.refs.row` so the UI looked right; `persistState` wrote
> `node.properties[stateProp]`, so `panel_state` never changed; ComfyUI's cache signature therefore
> never changed (`caching.py`'s `get_immediate_node_signature` appends `(key, inputs[key])` verbatim
> for every input, with no exclusion list); `run()` was never called — proven by **zero** loader log
> lines on a run where console logging was demonstrably on — and the previous MODEL was reused.
>
> **Fix:** every row handler now captures only `row.id` and re-resolves the row from `ensureState` at
> the moment it fires, mirroring `lora_interaction.mjs`, which was already immune for exactly this
> reason. `repaintRows` also rebinds a diverged `entry.refs.row`.
>
> **Two lessons worth more than the fix:**
> - **"widget == payload" proves the two mirrors agree, not that either is right.** The queue probe
>   reported MATCH on every failing run and was telling the truth — nothing compared either side
>   against *the value the owner had actually picked*. That one missing comparison kept nine
>   hypotheses alive.
> - **A disproof can be locally sound and still wrong.** `normalizeRow` mints a fresh `id: nextUid()`
>   on every parse, so two parses cannot collide — correct, and it retired the wrong mechanism while
>   the detachment was real. The ids here were **preserved**, so the second object was a *copy*, never
>   a parse. **The swap site is still unidentified** (most plausibly litegraph serializing
>   `node.properties`); the fix is immune to it by construction, which is why it was not chased.
>
> **Control Panel shares this code path**, so seed/sampler/int/float edits were being dropped after a
> reload too — masked by a random seed changing the payload every run anyway.

| Item | Commit |
|---|---|
| A hidden state input refuses a dropped wire. `preview_state` (STRING, index 0) was beating `metadata_json` (STRING, index 2) in `findInputByType`'s first-free-match scan, so the Generator's metadata wire landed on an invisible input. Vetoed via `onConnectInput`; graph load never routes through `connectSlots`, so saved workflows still load | `de3dc23` — probe now reads `0 mismatch(es)` |
| A state input receiving foreign data says so, loudly, on all five stateful nodes — absent (silent) / own state (silent) / present-but-foreign (names the node and the likely cause). Deliberately **not** gated behind Console logging: it is a correctness signal | `205d9fd` |
| The loader model cache belongs to the node, not the module. `_CACHE` was module-level, so two Loader Panels with different UNETs evicted each other every run. One-entry-per-kind (the anti-VRAM-leak choice) preserved | `12625c0` |
| The socket-healing notice respects Console logging — silent at `off`, emitted at `summary`/`debug`. The refused-link warning stays unconditional: a silently refused wire is worse than the noise | `0948e0d` |
| Civitai rejected our User-Agent (401) and we reported it as `key_required` — a wrong diagnosis shown to the user | `892b643` |
| Menus consume the wheel instead of zooming the canvas behind them, across every overlay | `24f171c` |
| Preview silently overwrote images with a colliding filename | `caf7c93` |
| Control Panel drag-reorder no longer overshoots on a zoomed canvas (`getCanvasScale` reaches `buildCtx`, not just `buildLoraCtx`) — it had been reordering `z` rows at zoom `z` since it shipped | `d5088d3` |
| **ROOT CAUSE of five failed sizing fixes: `node.size` is a `Float64Array` view over a `Rectangle`, so every `Array.isArray` size guard was dead code.** One shared `isSizeLike` predicate now gates all 15 size/pos sites in both tracks. This is what makes the Class A height lock, both tracks' saved-size restore, AND every min width/height (`GENERATOR_MIN_H`, `PREVIEW_MIN_W`, `PREVIEW_MIN_H`) actually take effect — they were all decorative before | `d57cfc4` — **confirmed live 2026-07-29** |
| Class A sizing: panel height content-fixed. **Four layers**, primary being `getMaxHeight === getMinHeight` on every mounted DOM widget (the only real lock — litegraph's drag min-clamps both axes with NO maximum), plus a `setSize` wrap (pre-paint), the per-frame draw hook, and the load-path correction. Confirmed live: self-sizes on row change, height ends at content. **Still to confirm: that a height drag no longer moves it even transiently.** | `dd7261a` → `d9b9106` → `09121bb` → **`d57cfc4`** (the four layers only began executing at all with this one) — **confirmed live 2026-07-29** |
| `Save now` button height matches its card at every font scale (`SAVE_NOW_BTN_H = SHEAD_H`); floors moved to 288/368 | `f620f4b` — owner confirmed directly |
| Settings section, seven settings | `b7e66dc` — **confirmed working 2026-07-29** |
| Chevron + gear visibility, gear pinned right | `dd89b9d` — entailed: the nested-⚙-menu check requires an open gear menu |
| One seed row; four field builders moved to `js/shared/fields.mjs` | `21ccd1d` — entailed: the `seed_after_generate` check exercises the seed row |
| Preview Save defaults off, plus a **Save now** button (`POST /wtn/anima/preview/save_now`) | `cec90cd` — entailed: the `%seed%` check requires clicking **Save now** |
| Server-side run logging (stage status, sampler provenance, model files) | `9addec1` |
| `ui` payload must be a list — post-run values/disable reaching the panel at all | `f22b3c0` |
| Subgraph boundary crossing for the context walk | `84ec4a5` |
| Seed as a string, text+roll row, `seed_after_generate` implemented | `d1f8942` |
| `%seed%` in a Save-now filename resolves to the real seed — carried as `anima_seed: [str(seed)]`, string end-to-end, `int` once at `format_filename` | `9874426` |
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
