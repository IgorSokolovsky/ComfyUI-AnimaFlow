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

- **Only the OWNER closes an item.** *Done (confirmed by use)* requires **Igor saying it works from
  the UI**, in his own words — for a bug fix, a feature, a capability, anything. Green suites, a
  passing review and a successful push are **never** sufficient, and no assistant or sub-agent may
  promote an item on its own judgement. (Rule stated 2026-07-30, immediately after eight commits were
  self-certified into *confirmed* — one of which, the popover clamp, he then reported as still broken
  from another direction. Corrected in the same pass.) A change with genuinely no UI surface — docs,
  an internal refactor — says so explicitly instead of claiming a confirmation nobody gave.
  Record WHAT he validated, not just that he did: *"same result as `PixaromaLoraLoader`"* is worth
  more later than *"works"*.

---

## Now

### 🧹 Four housekeeping items, all small and all with a named cause (2026-08-03)

None needs a decision; each exists because something else was fixed and left a trace.

1. ~~**`max-height: 100%` may resolve against `content-box`.**~~ **NOT A BUG — retracted 2026-08-03,
   measured.** `theme.css:77` is `.wtn *, .wtn *::before, .wtn *::after { box-sizing: border-box; }`
   and the detail view's root carries the bare `wtn` class (`model_detail_view.mjs:1569`), so every
   descendant including the drawer is border-box in production and the cap holds:

   ```
   production (.wtn ancestor):  box-sizing=border-box   tile 115  drawer 115  within cap
   probe shape (no .wtn):       box-sizing=content-box  tile 115  drawer 132  17px over
   ```

   > **The process failure is the part worth keeping.** Two builders measured the same 17px and drew
   > opposite conclusions: the first correctly called it a probe artifact from not loading
   > `theme.css`; the second, a pass later, reported it as a real pre-existing defect. **I did not
   > reconcile them and put the second on this board as fact.** When two reports disagree about the
   > same number, that is the signal to measure a third time — not to take the more recent one.
   > `verify-the-instrument-first`'s own "when two tools disagree, believe neither until a third
   > settles it" applies to two *sub-agents* just as well as to two shells.
   >
   > Standing consequence: **a standalone CSS probe of this pack must load `js/shared/theme.css` AND
   > put the element under an ancestor with the bare `wtn` class.** Without it every box measures
   > ~17px large and invents a bug. That has now cost two passes.

2. **`js/anima/render.mjs:795` hand-writes `.wtn-an-panel-pv > .wtn-an-body > * { flex: none; }`** —
   a fourth independent copy of the same fix `.wtn-flex-fixed` was created for (`25b60f1`). The class
   exists specifically to stop a fifth; this one predates it and should adopt it.
3. **`.claude/skills/animaflow-shared-fields/SKILL.md` is now stale, and we are what made it stale.**
   It states `grep -rn "shared/fields.mjs" js/controls/` returns **nothing**. That was TRUE and
   correctly measured — until `c26d180` added `js/controls/render.mjs:97`'s real import of
   `buildSwitch`. Update the "Current state" table and say what changed, since that section's whole
   point is being measured rather than assumed.
   > Worth recording alongside it: a brief in that same pass asserted the import already existed,
   > based on a substring match that hit a doc comment saying the OPPOSITE. The builder measured,
   > refused to edit the skill to fit the claim, and reported the discrepancy. That is the behaviour
   > that caught it.
4. **Nothing in this pack's ~1,900 JS assertions has a layout engine.** Four layout bugs on
   2026-08-02–03 — the filmstrip collapsing to zero height, both halves of the caret misalignment, and
   the clipped prompt drawer — were each invisible to a green suite and each settled by one headless
   measurement. The suites can pin a *declaration*; they cannot pin a *result*. A small measured-layout
   check (the `css-layout-diagnose-headless` harness, run over a couple of known-fragile boxes) is the
   only thing that would have caught any of them.

### 📋 Owner's check — what happens to a download when the browser is closed? (owner asked 2026-07-30)

*"did we cover if the download is in progress and we close the menu/browser what will be the
behaviour?"* — good question, and the code answers half of it. **Closing does NOT cancel**: the close
handler only unsubscribes the UI, clears timers and removes listeners; the job lives in a module-level
`_activeDownload` singleton whose own comment says it exists "so a job survives the panel that started
it closing", and the transfer runs server-side.

What is NOT confirmed, and needs a live check:
1. **Reopen the panel mid-download** — does it re-attach and show live progress again?
   (`subscribeDownloadState` should re-subscribe.)
2. **Reload the page mid-download** — module state dies, so the UI forgets. The file should still land
   correctly via the `.part`-then-rename path, but nothing will tell you it did.

### 📋 Owner's check — does a LoRA Loader inside a **subgraph** still self-heal? (open 2026-07-30)

ComfyUI lets you select nodes and collapse them into a reusable **subgraph** node. Those nodes then
live in a *nested* graph — they are **not** in `app.graph._nodes`, which `findLoraNodes()` walks
directly. So a LoRA Loader hidden inside a subgraph may be invisible to our refresh hook.

**Check** (the owner asked what "break a file" meant — it just means make the row's file unreachable):
put an `AnimaLoraLoader` inside a subgraph → point one row at a model file → **rename or move that
`.safetensors` in `models/loras`** so the row's saved name no longer resolves → press `R` (refresh
node definitions) → the row's red missing-file mark must appear. Rename it back afterwards. If the
mark stays stale, `findLoraNodes` needs to recurse into subgraph children.

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

### 🏛️ **Shells and Core Mechanics** — one shared chassis, per-node logic on top (owner, 2026-07-31, *"a very important thing"*)

Owner's framing: **"we need to create Shells and Core Mechanics so it's reused, and not different across
nodes, while the underlying logic of the node can be different based on the node."**

The split is the whole point. A node's **logic** — what a LoRA row applies to a `MODEL`, what a Control
Panel row emits on a socket, what the Generator does with a seed — is legitimately per-node and should
stay that way. Its **shell and mechanics** — how a row is dragged, how a popover is placed, how state is
persisted, how a node is sized — are the same problem every time, and today each track solves it again.

**This is not a hypothesis. Every item below was observed, most of them today:**

| duplicated mechanic | what actually happened |
|---|---|
| **Re-place a popover when its content grows** | Three panels, three treatments: `model_info.mjs` grew a local `repositionAfterChange`, `model_picker.mjs:522` and `civitai_search.mjs:1693` had nothing. Owner reported all three overflowing, separately. Being fixed once in `overlay.mjs` — but only after shipping a per-panel fix first |
| **Detached row objects / stale closures** | Fixed in the Loader Panel, then **shipped again** in the Control Panel — `4e2c3ac`'s own note reads *"same detached-row-object bug as the Loader Panel"*. The same bug twice because the row-wiring mechanic wasn't shared |
| **Drag-reorder FLIP animation** | Exists only in `lora_interaction.mjs`. Owner: *"our Control Panel drag doesn't have animation like our Loras"* |
| **The row entry's own shape** | LoRA rows use `entry.refs.root`, Control Panel rows use `entry.refs.row` — the same concept under two names, which is why the shared FLIP helper has to be parameterised over an accessor instead of just taking a list |
| **CSS class ownership** | `.wtn-ctl-row.wtn-lora-flip` — a `wtn-lora-` class applied to a Control Panel row, because the rule was written for one track and reached by the other. **Fixed 2026-07-31**: renamed to the track-neutral `.wtn-row-flip` when the FLIP core was extracted |
| **Class A node sizing** | Five separate layers (`getMaxHeight`/`setSize`/per-frame/load-path/`onResize`), re-implemented per track. The `Array.isArray(node.size)` bug defeated **five** of them at once precisely because there was no single place to get it right |

**What exists already** (the boundary is real, just incomplete): `js/shared/` has `overlay.mjs`,
`size.mjs`, `settings.mjs`, `node_chrome.mjs`, `graph_loading.mjs`, `canvas_zoom.mjs`, `theme.css`,
`fields.mjs`/`field_logic.mjs`, `refresh.mjs`, `api.mjs`. The gap is not "no shared code" — it's that
**the row/panel chassis itself was never named as a thing**, so each track grew its own.

**Roughly what a shell would own** (to be designed, not settled here): the row list and its entry
contract (one `refs` shape, one id rule), drag-reorder + FLIP, the state handshake
(hidden widget → `properties` → persist), the sizing class, the popover/menu vocabulary, and the
`syncRows`/`repaint` split. What it must **not** own: what a row means, what it emits, or what it
applies.

**Two hard constraints** any design must respect, both learned the expensive way:
- **The tracks are genuinely different where it counts.** The Control Panel is one `addDOMWidget` **per
  row** (each row parks an output socket at its own `.y`, and legacy litegraph reads `output.pos`
  verbatim); the LoRA loader is **one** widget for the whole body. A shell that assumes either shape
  breaks the other — see `render.mjs:9-19` and `lora_render.mjs:10-27`, which each explain their choice.
- **The 5-auto-loaded-`.js` ceiling.** A shared chassis must live in `.mjs` modules, lazily imported.

**Sequencing.** This is refactor-under-load: three tracks ship and the owner is testing daily. Do it
**incrementally, behind live use** — extract one mechanic at a time, at the moment a second track needs
it (which is exactly how `overlay.mjs`'s auto-reposition and `js/shared/flip.mjs` are being extracted
right now), rather than one big restructuring pass. Nothing here justifies a freeze.

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

### 🎨 LoRA loader / Civitai browser — two of the five remain (owner queued 2026-07-31, updated 2026-08-01)

Owner asked for five, sequenced by dependency. **Three are done and confirmed** — §1a-vii's Civitai-name
display (`a5f32b4` + `9139d7b`), the detail view as ONE component with two mounts (`f40c981`, owner:
*"so far perfect"*), and the delete affordance underneath both. The **community gallery** half of item 2
was specced and not built; it is tracked in *Now* with the rest of the Civitai frontend work rather than
here, so it doesn't sit in two places.

**1. Installed-by-kind in the browser** (owner, 2026-07-30). Group what is already on disk, by kind, in
the modal. `list_models` already answers per kind and all three kinds are active as of `a6bc45b`; this is
presentation plus the delete affordance that has now shipped.

**2. M3 — Loader Panel reuse, checkpoints + UNET.** Deliberately last: it should be an **import, not an
extraction**. The layering guard (`test_model_picker.mjs`'s `GUARDED_FILES`) already fails the suite if a
shared module imports anything `lora_*`, which is what keeps this a wiring job. If M3 turns out to need
real extraction, that is a signal the guard was not doing its job.

Everything above is specced in [`lora-loader-design.md`](lora-loader-design.md); none of it needs a new
decision from the owner.

### 🎨 LoRA loader — original spec framing (2026-07-29)

**M1 shipped** across five reviewed slices — the node, the picker, the ⓘ panel + Civitai hash lookup,
the ⚙ dialog, FLIP drag-reorder. It is in *Done (unverified)* below with the exact checks to run.
**What remains here is M2 onward**, and §9's network policy still gates it.

#### What M2 still owes — asked for live 2026-07-30, and NOT previously on this board

Both were specified in the design doc and simply never built. The owner found them by using the panel,
which is the point: a spec entry is not a queue entry, and neither of these had one.

- **Result thumbnails in the search panel.** Cards render a placeholder glyph today, and
  `civitai_search.mjs:903-908` says why — the search parser carries no image URL. **This is about to
  get cheap:** the download-sidecar work adds a per-version `preview_url` to
  `civitai_search.py`'s parse for the preview-image download, so the same field feeds the card. Note
  `civitai_parse._pick_thumbnail` already exists and rewrites to a 256px variant for exactly this
  in-browser use — the untransformed URL is the one saved to disk; the card wants the rewrite. Doing
  this AFTER the sidecar work lands avoids two people editing the same parser.
- **The version selector.** Decision 11 and §"The detail view" (`lora-loader-design.md:826`): *"A
  Civitai model has many versions and they differ in file size, base model…"* — so picking one
  matters, and today we always take the primary. Part of the **M2 detail panel**, still unbuilt.

#### Remove an installed model — owner decisions taken 2026-07-30

The first code in this pack that would **destroy user data**. Decisions:
**type-to-confirm** (a dialog naming the file, its size and its folder — not a yes/no, precisely so a
mis-click cannot delete gigabytes) · buttons in **the ⓘ panel AND the search menu now**, the global
browser when it is built · **all kinds**, not just LoRA (checkpoint, unet, vae, clip…).

Not started; it was blocked on a concurrent builder holding `src/model_browser/`. Four things the
brief must pin down:
1. **The path guard is the entire security story.** A delete route turns a client-supplied name into
   `os.remove`. It must reuse `kinds.py`'s folder whitelist and `local._is_path_under`'s
   realpath-then-containment check — the same guards `resolve_model_path` applies — and must never
   build a path any other way.
2. **Sidecar and preview go with the model**, or the picker and ⓘ panel will keep describing a file
   that no longer exists.
3. **A LoRA row still pointing at the deleted file** must fall into the existing red missing-file
   state, not vanish or throw. That path exists; delete just has to trigger the re-check.
4. Size and folder in the confirm dialog — that is the whole reason type-to-confirm was chosen.

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

Six of these were found on 2026-07-30 by builders instructed to **report, not fix**, so the owner keeps
the call on scope. They are small; none is forgotten, none was done by assumption.

| Item | Why it's deferred |
|---|---|
| **`STRENGTH_STEP_MAX` is still `1`** (`js/controls/lora_state.mjs:113`) | Its justification was "`1` is the whole usable range in one bump" — true when strength was `[0, 2]`, meaningless now the range is `[-10, 10]`. The comment is corrected; the VALUE is the owner's call, since a faster ▲▼ step is a feel decision, not a correctness one. **Trigger: the arrows feeling too slow at the wider range.** |
| **The strength input is 34px wide** (`lora_render.mjs:274`, `STR_VAL_W`) | Sized for `0.80`. `-10.00` is a longer string and may read tight. Cosmetic only, and it sits in sizing code that this pack treats as read-the-skill-first territory. **Trigger: it actually looking wrong with a negative value on screen.** |
| **A downloaded result card's `installed` flag is sticky** (`js/controls/civitai_search.mjs:1287`) | After a download completes the client sets `finishedResult.installed = true` directly, so the card flips without waiting for a re-query. Nothing clears it if the file later leaves disk. A fresh search re-derives it correctly from the server (which checks the real filesystem per request), so this only affects an already-rendered card. Investigated 2026-07-30 on a suspected sighting that turned out to be a false alarm. **Trigger: a card disagreeing with disk in practice.** |
| **We cannot tell a model is gated before the first download attempt** | `civitai_search.py:277` sets `gated = bool(v.get("earlyAccessEndsAt"))` — early access is the only gating flag Civitai publishes. A login-required model looks identical to a free one in the search response. This is not fixable from search data; the field does not exist. Mitigated instead by `_sessionGatedKeys`, which learns from a live failure and marks that card gated for the session — now fed by `d70942b`'s `key_required` classification too. **Trigger: Civitai exposing an auth-required flag.** |
| **`LoraCache.note_used` is dead code** (`nodes/controls/_lora_helpers.py`) | Its only caller was the strength-0 shortcut `542a911` deleted. Left in place with a docstring saying so rather than removed, because the removal was not what was asked for. **Trigger: any pass through that class.** |
| **The `web_cache` middleware reads files synchronously** (`src/web_cache/api.py`) | Deliberate parity with upstream Pixaroma's own middleware, which does the same. Our `.mjs` files are KB-scale, so the blocking read is negligible — but it diverges from this pack's `run_in_executor` convention in `src/anima/api.py` and `src/model_browser/api.py`. **Trigger: a measurable stall, or the served tree growing large.** |
| **Layer 3 (socket rows) moving to `js/shared/`** | Its only two consumers, Control Panel and Loader Panel, already share it by sitting in the same folder. Moving it now buys nothing and touches the most fragile code in the pack (slots, sockets, hole compaction, load-race guards). The *contract* is written down instead — `control-panel-design.md` §6a — so the eventual move is a rename, not an untangling. **Trigger: a third socket-per-row node.** |
| **`usefulRange` staying in `js/controls/rows.mjs`** | Pure enough to qualify for `field_logic.mjs`, but it has exactly one caller and no cross-track consumer. Promoting it now would be speculative generality. **Trigger: a second consumer.** |
| **ResShift as a second Upscale backend** | Needs `ComfyUI-Distilled-ResShift`, which isn't installed. A Mode dropdown offering one usable option is worse than no dropdown. Full detail in [`BACKLOG.md`](BACKLOG.md) §1b-0. |
| **`.claude/` staying out of the repo** | Owner's call (2026-07-29). Consequence to keep in view: the skills — including the ComfyUI findings from that session — live on one machine only and don't travel with a clone. |
| **The reuse-last-seed (↺) button on the Generator** | Control-Panel-only today. Not asked for on the Generator; noted so it isn't mistaken for an oversight. |
| **Renaming `offline_reason: "civitai_disabled"`** (`src/model_browser/lookup.py`) | The name is stale — since BUG 13 it is returned on **every** cache-miss open, not only when the Civitai setting is off, because `cached_only` is driven by `!force` rather than the setting. But it is **not** a private label: `js/controls/model_info.mjs:1087` branches on the exact literal to pick the "not checked yet" UI state, so the value crosses the HTTP boundary as live control flow. A reviewer called it "not user-facing, a doc nit"; that was true of the `message` text and wrong about the *value*, and a Python-only rename would silently break that detection. **Trigger: a coordinated Python + JS + tests pass** — cheap, but it must move `lookup.py`, `model_info.mjs`, `civitai_api.mjs`'s doc comment and both test files together. No user-visible impact until something else renders that reason. |

## Done (unverified in a live ComfyUI)

Shipped and green, **not yet confirmed by the owner from the UI**. Nothing leaves this section on an
assistant's or a reviewer's judgement — see the rule at the top.

### 2026-08-05 — pushed, awaiting the owner's own check

| Item | Commit |
|---|---|
| **A Checkpoint result can be sent to `models/diffusion_models/` instead.** Owner report: Anima, Qwen- and Flux-family models are typed `Checkpoint` on Civitai while shipping UNet-only weights, so they landed where no UNet loader could see them — **including our own** Loader Panel, whose `unet` row resolves through `diffusion_models`. Civitai has no field distinguishing the two, and a heuristic (base-model name, file size) would be silently wrong sometimes, so it's an explicit per-download choice defaulting to the derived kind. `Checkpoint → checkpoints` remains the default — this is an override, not a new mapping. Two things had to come with it: the **installed badge** counts either folder for that ambiguous pair, or a model sent to `unet` reads as not-installed on its own card and offers a redundant second download; and `DEFAULT_ROOT_DISPLAY.unet` said `models/unet`, **a folder that has never existed** | `a973001` |
| **…and the selector reaches the grid card, which is the path people actually use.** `a973001` scoped it to the detail view, reasoning that was the only surface showing a destination — the card's caption having been removed as noise on 2026-08-01. It missed that the card's own Download button calls the backend directly, so *search → click Download* kept the old behaviour intact. Ambiguous cards only; a LoRA card is pixel-identical. Card→detail reconciles one way; the reverse doesn't propagate and needn't, since each surface always shows the folder it will write to. Same commit fixes `models/unet` in **`delete_confirm.mjs`**, where it was worse — a destructive confirmation naming a folder that doesn't exist — and whose test **asserted the wrong value**, so a green suite was defending it | `01a3fc2` |

### 2026-08-03/04 — pushed, awaiting the owner's own check

| Item | Commit |
|---|---|
| **An Installed card opens the detail view; the ⓘ button is gone.** Needed a backend change that was not obvious from the ask: `/list` carried no Civitai ids, so the card had nothing to open a detail view with. A file with no sidecar runs the by-hash lookup on click and reuses `model_info.mjs`'s own found/notfound/offline wording | `58c9ea7` |
| **M3 — the Loader Panel gets the picker and ⓘ, plus a `checkpoint` row** (MODEL only; the CLIP/VAE gap is recorded in `control-panel-design.md` §3c, not closed). "An import, not an extraction" held: `model_picker.mjs`/`model_info.mjs` are byte-untouched and the layering guard still passes | `3121d12` |
| **An Installed tab in the browser modal**, grouped by kind, rail per tab. Exposed a real z-index defect the scale caught: an ⓘ panel opened from inside the modal would have painted behind it, so `Z_MODAL_PANEL` joined the scale rather than a hand-picked literal | `f90b136` |
| **The Preview panel's flex rule joins the shared vocabulary** — a fourth hand-written copy of `flex: none` now names `.wtn-flex-fixed`, pinned by a cross-file test. CSS value verified byte-identical; the 16 added lines are all comment | `26d152c` |

### 2026-08-02/03 — pushed, awaiting the owner's own check

| Item | Commit |
|---|---|
| **Community images carry their prompts.** `fb949a8` built that grid with no prompt and deliberately no copy affordance, on a real measurement: `/api/v1/images` returns `meta: {}` on every image (600+ sampled, re-verified). Still true — but Civitai's Meili `images_v6` carries `prompt` top-level, and `id` IS filterable there, so the same two-call shape as search recovers them (20/20 on the owner's own version). **The measurement was right about the endpoint and wrong about the data**, which is what made the conclusion so credible. `hideMeta` is honoured — a prompt its uploader hid stays hidden. Enrichment is best-effort: a failed lookup returns every image with `prompt: null`, never an empty gallery | `a7cd6cd` |
| **A `%counter%` in the template opts out of our automatic suffix**, so a user numbering their own files gets one counter, not two. Attempt ≥1 still suffixes, or `write_without_overwriting` would emit 10,000 identical candidates and die instead of finding a free name. Shipped with the fix it could not go without: a bare `%counter%` was never substituted at all, which was harmless only while the suffix guaranteed uniqueness | `c31f1d2` |
| **The prompt drawer fits its tile.** My own regression from `c25b9bc`: removing the tile's hover `overflow: visible` was right (it could never escape the filmstrip's clip) but it was also the only thing letting the drawer exceed its tile — measured 147px of drawer in a 115px tile, prompt clipped 23px above it. Capped at the tile; the prompt is the only child that shrinks | `e05f6fd` |
| **Opening the ⓘ panel stopped wiping every row's Civitai name.** A lookup called `invalidateList` intending to refresh the name, but invalidation only clears and nothing refetched — so the call meant to improve the name erased it, on all rows. Adds the missing refetch (the correct pattern already existed 20 lines away) and makes `civitaiNameFor` tri-state like `hasFile`, so a row can hold what it had instead of flipping to the filename mid-window | `d255da3` |
| **A boolean (switch) row kind for the Control Panel** — real Python `bool` on a `BOOLEAN` socket, tolerant coercion on both sides, `auto` rows resolve onto it. First use of the shared `buildSwitch` from Controls (see housekeeping item 3) | `c26d180` |
| **Every save carries a counter from `_00001`** — reverses the "first file keeps its plain name" rule `40b3c9d` had preserved | `fd15d39` |
| **The LoRA row's caret aligns and stopped being a text glyph.** Measured across three rows: caret x was 114.3/200.5/228.8, now 225.2 on all three. Drawn as a triangle matching the stepper arrows' own geometry, since a glyph's side bearing can never align with a drawn shape | `cc36388` |

### 2026-07-30 — pushed, awaiting the owner's own check

| Item | Commit | What would confirm it |
|---|---|---|
| A short download was renamed over the real filename — `Content-Length` was read and used ONLY for the progress bar, so a dropped connection produced a truncated file reported as `ok`. Two gates now run before the rename | `68a2998` | An interrupted download leaves NO file behind, and reports "ended early" rather than succeeding. **The `corrupt` half IS confirmed** (via `d70942b` below); only the LENGTH gate is untested |
| The loader model cache was module-level, so two Loader Panels with different UNETs evicted each other every run | `12625c0` | Two Loader Panels, different UNETs, both stay warm across runs. Only worth checking if that setup is ever actually run |
| A state input receiving foreign data now says so, loudly, on all five stateful nodes | `205d9fd` | It has never actually fired in the owner's console — unproven in the wild, and hopefully stays that way |
| Sidecar + preview image written on download — **BACKEND HALF ONLY** | `4965389` | *Nothing to test yet: no frontend sends `civitai_meta`/`preview_url`, so downloads behave exactly as before. Do not report it as broken.* |
| `docs/settings.md` documented 10 of 15 settings; README undercounted nodes and omitted `AnimaLoraLoader` | `8d3aa8d` | *No UI surface — docs only. Nothing to confirm.* |

### Older

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
| **The last four hand-picked z-index literals joined the scale — and one ordering was backwards.** `js/anima/render.mjs` had claimed `10020` since it was written while `overlay.mjs` set `10010` **inline**, so that number was never once applied. The Rule Builder overlay (`10000`) and the encode node's picker (`10001`) were a deliberate pair resting on "they can never coexist" — they can, in exactly one direction: the Rule Builder is a global command with a keybinding and a toolbar button, and the picker's `keydown` acts only on `Escape` and never calls `stopPropagation`, so the command fires while the picker is open. Under the old numbers that put the Rule Builder **behind** the picker's scrim — summoned, invisible, unusable. Now reversed. The guard test covers ten consumers, so a fifth hand-picked value fails the suite. **To confirm — keyboard only, no click can reach it:** open the picker on an encode node, then invoke *AnimaFlow: Rule Builder* from the command palette; the Rule Builder must render **above** the picker's scrim | `91a9f21` |
| **The Save-now status line says WHERE.** `save_now` has returned an absolute path since `e23e31d`; the client read only `data.filename`. Now `Saved final as AnimaFlow/anima_00007.png`, with the full path in the `title` on hover. One line deliberately — that row already caused one sizing bug, since `PREVIEW_PANEL_MIN_H` is static rather than measured. **To confirm:** click Save now and read the folder off the status line — this is also the instrument for the open Save-now bug in *Now* | `f31a83f` |
| **The ⓘ panel stops re-placing itself** — `repositionAfterChange` deleted, all **ten** call sites unwrapped (the board said seven; each was checked individually, since a mutation that moves the panel without changing its observed height would NOT be covered by the shared observer and would have had to stay). **To confirm:** open ⓘ on a LoRA near the bottom of the screen and let the Civitai lookup land — the panel must still re-place and stay on screen | `d1141a4` |
| **`fetch_model_detail` returns `files`** — the deleted-model `Download` had no target and rendered no button. `_parse_files` moved to `civitai_parse.parse_files` with a drift-guard test asserting both call paths produce byte-identical output for the same raw input | `7169733` |
| **The model/version detail view** — one component, two mounts (picker panel + modal master→detail swap): version selector, badges, both labelled descriptions, `View on Civitai ↗` to the *selected version*, and the author's gallery with prompt-on-hover and copy-prompt | `f40c981` — owner: **"so far perfect"** (2026-08-01, after a long iteration on its layout) |
| **Delete an installed model** — type-to-confirm on the word `delete`, naming the file, size and folder; sidecar and preview go with it; the row falls into the existing red missing-file state | `6ce43de` route + `99e24c5` UI + `9139d7b` — owner confirmed the flow, then the UX refinements |
| **An explicit `Search` button** replacing the debounce — Enter-equivalent, disabled while the query is unchanged, filters still immediate, pagination independent | `99e24c5` |
| **Show the Civitai name instead of the filename**, behind a setting (default off), in the Settings dialog *and* the node's ⚙ popover. Display only — the filename stays the identity everywhere it is persisted | `a5f32b4` + `9139d7b` |
| **`/thumb` had no cache validators at all** — no `ETag`, no `Cache-Control`, so it re-downloaded on every render. ETag over `(mtime, size, max_edge)`, `304` on `If-None-Match`, `private` because it serves the user's own files through a tunnel | `90888de` |
| **The flex `min-*: 0` trap, named.** Three occurrences in two days — the detail view's vertical scroll, the filmstrip, and the modal's own chain (which was clipping the description *and* hiding the Download button). Now `.wtn-flex-bound` | `f82d08a` |
| **Shared vocabulary for values that must agree across surfaces** — card hover elevation, panel width delta, and the select control height, each previously re-declared per surface and each having produced a visible bug | `5e4c0b3` + `f82d08a` + `25329fb` |
| **The global Civitai browser** — toolbar button, 90% modal, filter rail, result grid, downloads routed by the result's own type. Unscoped search + the corrected 22-value type enum underneath it | `68f7316` + `a6bc45b` — owner: **"toolbar button confirmed"**, **"global browser search working"** |
| **Control Panel drag settles with a FLIP animation**, core shared with the LoRA track. The Control Panel needed a one-frame defer the LoRA track does not, because its rows are per-row DOM widgets repositioned by ComfyUI's draw cycle rather than by the reorder itself | `bedeae4` — owner: **"control panel drag - confirmed"** |
| **Previews saved at ORIGINAL size and downscaled on serve** — type-conditional, since `original=true` on a video returns the video; Pillow lazily imported with a silent no-Pillow fallback | `2baed3e` — owner: **"original size confirmed, confirm downgraded on serve"** |
| **A download writes a real preview file** — the sidecar path had been dead code since `4965389` because the frontend never sent `civitai_meta`/`preview_url` | `58a1749` — owner: **"preview save (i see the jpeg)"** |
| **The Settings dialog stops offering things that do nothing** — a raw i18n key as a combo option, the dead NSFW toggle the owner had switched ON, and the modal rail's two internal chip-state fields. All keep their ids and defaults; only the dialog entries go | `261ca21` — owner: **"setting clean"**, **"no settings NSFW"** |
| Class B sizing: `GENERATOR_MIN_H` (356 at the 14px base) + `clampGeneratorSize` clamping both axes, and the fresh-node default guarded against the floor at large font scales | `be6ea69` |
| Hover tint + `cursor: pointer` scoped to genuinely clickable headers (Sampler, Save row) — not switch-bearing sections, not the Compare card | `61716f9` |
| `colab/` folder, sanitized notebook, layer 1 extraction + the layering guard test | `a630ae4` |

## Done (confirmed by use)

**Suites as of 2026-07-30: Python 907 (1 skip), JS 1380, 5 auto-loaded `.js`, 8 nodes.** These only
ever grow — re-count rather than trusting the number.

> ### ✅ Local previews render again, end to end (owner, 2026-08-05)
>
> `3e02428` · `0489628` · `f0f421b` · `4d04ce8` · `e71b534`. Confirmed on the **Loader Panel's ⓘ**
> (the browser modal's detail view was confirmed a step earlier in the same session).
>
> **One symptom, four defects, each hiding the next** — which is why three of the fixes shipped green
> and changed nothing the owner could see:
> 1. **Written truncated.** `HTTPResponse.read(n)` returns UP TO n bytes; on a chunked response it
>    returns what is available, and we wrote that partial buffer as a finished file. Measured on the
>    owner's server: 2,048,000 bytes against a RIFF header declaring 5,584,420. The correct loop
>    already existed twelve lines up in `stream_download`. Same commit: the extension came from a
>    `Content-Type` that lied (WebP bytes under `image/jpeg`), now sniffed from magic bytes.
> 2. **Served broken.** An undecodable preview now 404s like an absent one, so the frontend's
>    candidate chain falls through to Civitai. **Pillow-missing still serves the original** — that
>    branch cannot tell good bytes from bad.
> 3. **Cached broken.** The `If-None-Match` check ran BEFORE the decode, so a 304 handed back the bad
>    image forever. Every test had warmed the cache first, so (2) was provably dead code until this
>    landed.
> 4. **Never repaired.** `save_preview` returned `already_present` for any existing file, so a
>    pre-`3e02428` truncation was permanent and that model re-fetched from Civitai on every render.
>    It may now replace a preview it can **prove** is undecodable — `is_preview_provably_corrupt`
>    is deliberately tri-state (`None` when Pillow is absent), because inverting it would delete good
>    previews on every install without Pillow.
>
> Two things worth keeping:
> - **A green suite asserted the broken behaviour three separate times here.** The preview fake
>   returned the whole body in one `read()`; every conditional-GET test warmed the cache first. Since
>   this thread, builders falsify their own tests — stash the fix, confirm red — before reporting.
> - **The repaired file being decodable is what proves (1)**, since the replacement is written through
>   the same fixed `fetch_preview_image` loop. There was no other live confirmation of the write path.
>
> Open, minor, on the record: if a replacement sniffs a different extension than the corrupt original
> (`.png` → `.webp`), the old file is shadowed rather than deleted. It is never served.

> ### ✅ The LoRA Loader really does change the image (owner, 2026-07-30)
>
> The last behavioural gap in the LoRA track, and it was closed the strongest way available: **an A/B
> against `PixaromaLoraLoader`**, two full chains (`LoRA → Bridge → Generator → Preview`) sharing one
> latent, one seed and one model, differing only in which loader applied the LoRA. **Same result.**
> Not "it looks like it works" — it matches a known-good reference implementation.
>
> Everything M1 shipped is now confirmed by use. The remaining LoRA items are M2 onward.
>
> Two things learned while getting here, both worth keeping:
> - **`applied N LoRA(s)` proves only that `load_lora_for_models` returned.** ComfyUI's own
>   `comfy/sd.py` never raises when a LoRA's keys don't match the model — it returns a clone with zero
>   patches and logs `NOT LOADED <key>` per key. So an SDXL/Illustrious LoRA on a Qwen-based Anima
>   model applies nothing while our log says success. **Triage a no-effect LoRA by grepping the console
>   for `NOT LOADED` first**, and check the ⓘ panel's base model before blaming the node.
> - Two Generators can safely share ONE latent: `run_ksampler` (`src/anima/pipeline.py:248`) hands it
>   to stock `KSampler`, which copies rather than mutates. Sharing the seed row too is what makes an
>   A/B meaningful — the value is read at queue time, so both chains get the identical seed in one run.

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
| **The browser modal — Installed tab, and a card that opens the detail view.** Grouped by kind with a per-tab rail; the ⓘ button removed in favour of the card body opening the same master→detail swap Search uses. Needed a backend addition that was not obvious from the ask: `/list` carried no Civitai ids, so a card had nothing to open a detail view with. A file with no sidecar runs the by-hash lookup on click and reuses `model_info.mjs`'s own found/notfound/offline wording | `f90b136` + `58c9ea7` — owner: **"for the browser model so far so good working"** |
| **An undecodable preview serves 404**, so the frontend's candidate chain falls through to the Civitai image and files truncated before `3e02428` self-heal visually without being deleted. Pillow-missing still serves the original, since that branch cannot tell good bytes from bad | `0489628` — owner confirmed the ⓘ panel thumbnail returned |
| **The Preview's seed comes from `metadata_json`, not the prompt scan.** The history showed seed 0 while the settings JSON on the same entry displayed the real seed. `extract_seed_from_prompt` scans for a LITERAL seed on the Bridge node, but the Bridge declares `seed` with `forceInput=True` — always a wired link, serialised as `[node_id, slot]`, no value to read. Its own docstring already conceded this. One variable fed three consumers, so the history line, `%seed%` in auto-saved filenames and Save-now's `%seed%` were all 0 | `ba83a2c` — owner: **"seed copy works"**, showing `254321339072737489` |
| **Search runs on Meilisearch, with v1 supplying the details.** `/api/v1/models` forces `sort: id:desc` when a query is present so its cursor pagination works, discarding relevance and returning the twenty NEWEST matches; filtering that page then empties it. Upstream knows (`civitai#2214`, open since April) and the fix was closed unmerged | `dac7af1` — owner: **"search confirm works great now"** |
| **The gallery filmstrip stopped collapsing to zero height** — a flex item defaults to `flex-shrink: 1`, so the community grid added below it squashed it. Measured, not read: `strip h=4.0, gimg h=0.0` against `gbox h=115.0` | `25b60f1` — owner: **"gallary fixed"** |
| **A named z-index scale, because four hand-picked values had inverted.** The delete confirm rendered *behind* the ⓘ panel that opened it, with its warning clipped and **Cancel unreachable** — the worst failure mode a destructive-action dialog has. Nothing tied the four numbers together, so whichever file picked the bigger one won; raising one would only have held until the next surface picked bigger still. A scale, not a bump: the next surface picks a **name** | `fa27ca1` — owner: **"confirm delete dialog is over the lora info panel"** (2026-08-01) |
| **An empty LoRA row no longer shows the ⓘ.** Not a wrong condition — `paintRow` repaints the name, strengths, off-state and switch but never touched the icon, so no code path could ever have hidden it. `visibility: hidden` rather than `display: none`, because `INFO_W` is a reserved column and dropping it out of flow would widen an empty row's name field out of alignment with the rows around it; `pointer-events: none` on the same rule is what makes the existing click binding inert, so there is no second "is a LoRA picked" guard that could drift out of step. The row menu's `More info` follows the same rule | `24fa594` — owner: **"hide icon confirm fixed"** |
| **Popovers are clamped inside the viewport on all four sides.** `reposition()` had NO horizontal handling for `"below"` at all, and the overlay box is not the visible box — the panels set their own wider fixed width on the CONTENT element, so anything measuring only the overlay measures the wrong rectangle | `eea739b` — owner: **"Fixed on all except lora info"** (that one was `b92eff0`, below) |
| **The ⓘ info panel grew after opening and overflowed** — the only popover placed against a near-empty box and then populated asynchronously from the Civitai lookup. Re-measures and re-places when the content lands | `b92eff0` — owner: **"lora info expand overflow fixed"**. Turned out to be *one instance* of the systemic gap below |
| **Every async-populated popover overflowed** — three panels, one cause: `reposition()` is called once at open, while the content is still a short "Loading…" placeholder, and the height cap (the thing that makes the inner `overflow-y: auto` engage) only applies when the content doesn't fit *at that moment*. `openOverlay` now watches `contentEl` with a `ResizeObserver` and re-places on a real height change — **no panel needed a single line**, and every future one inherits it. Converging is the actual work: the comparison height is the one `reposition()` last *placed at*, recorded after its own cap | `0a53398` — owner: **"overflow fixed"** |
| **Search results carry a per-version picker** — the parser always kept every version, but only `versions[0]`'s download fields were ever computed, so any other version had nothing to download. Every version now gets them, and the card-level flatten reads `versions[0]`'s copy rather than recomputing. Moved above the Download button in its own column after the first look at it live | `cd04e97` + `f4a883c` — owner: **"version selector fix confirmed"**. The uniform *"No downloadable file for this version"* on first look was frontend-ahead-of-backend, cleared by a restart, not a bug |
| **Our `.mjs` modules were never cache-busted.** Core's no-store middleware tests `path.endswith(".js")`, which never matches `.mjs` — so every `.mjs` in this pack was served from cache indefinitely. Two layers ported from Pixaroma | `31aaf90` — owner: **"cach fixed"** (2026-07-31, first plain `R` with no Disable-cache after a restart). Open since 2026-07-30 |
| **Adding an API key could not un-gate a card, and the "key required" chip lit up on hover.** `_sessionGatedKeys` learned correctly from a live failure but nothing ever re-evaluated it; the only thing that cleared it was a test-only helper, and the button is `disabled`, so there was no retry either | `030b579` — owner: **"fixed"** |
| **Civitai's login page was saved as the model** — a gated download answers with HTML and a genuine `200`, and the length gate was structurally incapable because the page's own `Content-Length` was correct. `Content-Type` is now parsed before a single byte is read | `d70942b` — owner: **"Works"** |
| **The Control Panel dropped edits after a reload** — same detached-row-object bug as the Loader Panel, masked for months because a random seed changed the payload every run anyway | `4e2c3ac` — owner: **"works"** (steps/cfg changed after a reload, no structural edit) |
| **`AnimaControlPanel` left beta** — second graduation, on interface stability once the drag-zoom defect shipped | `92249fe` — owner: **"gone"** from the picker |
| The socket-healing notice ignored the Console logging setting | `0948e0d` — owner: **"works"** (silent at `off`) |
| LoRA strength was capped at `[0, 2]`; now `[-10, 10]`. The `0` floor was never a decision — inherited from upstream Pixaroma. Python's own `±100` clamp is deliberately NOT harmonised: it guards a hand-edited API payload, not the UI | `0d86075` — owner: **"range works"** |
| The switch alone decides whether a LoRA applies; a switched-on row at strength 0 is now loaded and applied like any other. Costs a disk read for a mathematically identical image — the tradeoff is stated, not hidden | `542a911` — owner: **"0 strength still aplied works"** |
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
