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

> ### 🎨 LoRA Loader M1 — `815c286`, built and pushed 2026-07-29, **NOT yet run in a live ComfyUI**
>
> Pushed, so a `git pull` + restart will pick it up. **Everything below is unverified against a running
> ComfyUI** — that is what keeps this in *unverified* rather than *confirmed by use*.
>
> **What shipped:** `AnimaLoraLoader` (8th node) · `src/model_browser/` (kind whitelist, chunked SHA256,
> safetensors header-only metadata, Civitai client on stdlib `urllib`, sidecar cache, four guarded
> executor-offloaded routes) · the picker · the ⓘ panel + the four lookup states · the ⚙ dialog's eight
> settings · FLIP drag-reorder · the Rule Builder rename.
> **Suites at completion: Python 647, JS 1093, 5 auto-loaded `.js`, 8 nodes.** Five slices, each
> built → independently reviewed → fixed → re-verified; three reviews returned NEEDS_CHANGES.
>
> **Verify in a live ComfyUI, in this order — nothing below is confirmed:**
> 1. Restart. Node appears under `AnimaFlow/Controls`. Add it, add 3 LoRAs.
> 2. **The image actually changes**, and routing the **patched** CLIP onward matters (wire the raw one
>    and the model effect still lands while the CLIP effect silently vanishes — §4).
> 3. **Drag a row: the node height must not move, even transiently.** This is the one Class A behaviour
>    still unconfirmed from the 2026-07-29 sizing work, and now there's a FLIP animation over it.
> 4. Save + reload: rows, trigger selections and node **width** survive; a clean workflow does not open
>    as "modified".
> 5. ⓘ on a LoRA that IS on Civitai (expect `found` + sidecar), and one that isn't (expect `notfound`
>    explaining the hash — not a bare dead end).
> 6. Turn **Settings → AnimaFlow → Civitai** off: no network affordance renders anywhere, **and
>    already-cached notes/trigger words still display** (that combination is the whole point of §7d).
> 7. **Subgraph recursion** (the one gap no headless test can reach): put an `AnimaLoraLoader` **inside
>    a subgraph**, make one row's file missing, press `R` — the red mark must re-check. `findLoraNodes`
>    walks `app.graph` directly, so it is only verifiable live.
> 8. **The open `VERIFY-IN-COMFYUI`:** search the command palette for **"AnimaFlow: Rule Builder"**.
>    Reachable ⇒ keep `commands`. Not reachable ⇒ delete the `commands` entry and let the toolbar button
>    be the sole affordance. (Note: renaming `COMMAND_ID` **dropped any keybinding** you had for it.)

| Item | Commit |
|---|---|
| Class B sizing: `GENERATOR_MIN_H` (356 at the 14px base) + `clampGeneratorSize` clamping both axes, and the fresh-node default guarded against the floor at large font scales | `be6ea69` |
| Hover tint + `cursor: pointer` scoped to genuinely clickable headers (Sampler, Save row) — not switch-bearing sections, not the Compare card | `61716f9` |
| `colab/` folder, sanitized notebook, layer 1 extraction + the layering guard test | `a630ae4` |

## Done (confirmed by use)

| Item | Commit |
|---|---|
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
