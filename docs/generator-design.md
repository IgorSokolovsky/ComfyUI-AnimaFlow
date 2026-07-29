# Generator + Preview — design

**Status: mockup signed off; Python AND frontend both built** (design decisions 2026-07-27, mockup
approved and Python landed 2026-07-28; `js/anima/` landed the same day — see `.claude/CLAUDE.md`'s
per-track table). `src/anima/` + `nodes/anima/` + `js/anima/` all exist and are registered; the
one `.js` entry point (`js/anima/index.js`) registers both node classes and lazily imports
`render.mjs`/`interaction.mjs`/`state.mjs`, same trick `js/controls/index.js` already uses.
Interactive mockup: [`playground/generator.html`](../playground/generator.html) — still
the behavioural reference for the frontend slice, though several sections below (§7's body order,
§12's inline-sections dispatch) already record where the shipped frontend diverged from it. Opens
the third track, after the Rule Builder line and the Controls line. Read alongside
[`control-panel-design.md`](control-panel-design.md) — this doc reuses its conventions
(house theme, DOM-widget sizing, hidden-serialized-STRING state) rather than restating them.

Two nodes: a **Generator** that runs the whole txt2img pipeline (first pass → highres →
detailer → upscale → postprocess) behind one node with popup settings, and a **Preview** that
compares two of its image outputs with a hover wipe.

---

## 1. The upstream reference

`../ComfyUI-EasyUseAnima` — **MIT © n0va39**, credited in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). Porting from it is fine **with
attribution**. Its AiO generator is the thing being re-derived: `easyuse_anima/aio/` (~30
modules), `easyuse_anima/nodes/aio_nodes.py`, `web/js/aio/` (~25 files).

`docs/BACKLOG.md` §1 is the standing record of what to carry over and what not to repeat. It is
the input to this doc, not a duplicate of it — where the two disagree, this doc wins and
BACKLOG should be updated.

**Kept from it:**

- The **stage order** (`aio/generation_pipeline.py:10-17`): `first_pass → highres → detailer →
  upscale → postprocess → save`. It is the right order and it is not obvious — in particular
  detailer runs *before* upscale, so faces are fixed at generation resolution and then
  enlarged, rather than the detailer chasing an already-upscaled image.
- **One versioned JSON settings blob** in a hidden-but-serialized STRING widget, with popup
  dialogs editing it. ~250 settings cannot be widgets; this is the only workable shape, and it
  is the same pattern the Controls line already uses for `panel_state`.
- **Per-stage sampler overrides** with an `inherit_sampler_settings` flag
  (`aio/generation_defaults.py:163-168`, `:207-212`), semantics unchanged from upstream. See §6b for
  exactly which fields it covers — it is not all of them.
- **The upstream stage defaults**, verbatim where we ship the stage at all — they are tuned and
  we have no better numbers. See §9 for the three the old port got wrong.
- **The hover-wipe compare** (`web/js/aio/generator_panel_runtime.js:788-829`) — two absolutely
  positioned layers plus a divider, driven by one CSS var from cursor position. See §7.
- **Per-block detection via `detect_prompt`** — `SAM3_Detect` → `MaskToSEGS` → `DetailerForEach`
  (`easyuse_anima/image/sam3.py:46-121`). `SAM3_Detect` is a ComfyUI built-in, so this costs no
  dependency beyond the Impact that `DetailerForEach` already requires. See §6a.

**Deliberately NOT copied:**

- ~~The `EASY_USE_ANIMA_INPUT` context socket~~ — **reversed 2026-07-28: we now ship a context
  socket too, `ANIMA_CONTEXT`.** This entry originally argued plain `MODEL`/`CLIP`/`VAE` sockets on
  the Generator itself were better than upstream's bundled dict socket (`nodes/aio_nodes.py:67-126`)
  because they compose with every other node in ComfyUI. That's still true of the sockets — they
  didn't go away, they moved. Building the actual Generator surface in ComfyUI made nine separate
  sockets (`model`/`clip`/`vae`/`positive`/`negative`/`latent`/`seed`/`steps`/`cfg`/`sampler_name`/
  `scheduler`) visibly worse to work with than upstream's one dict, for a reason upstream's own
  design already had a chance to teach us: a graph with nine wires into one node is harder to read
  than a graph with one. The fix keeps upstream's mistake (loading resources *by name inside the
  generator*) out of the picture while taking its actual insight (bundle it): a new node,
  `AnimaContextBridge`, takes the nine sockets and emits ONE `ANIMA_CONTEXT` carrying real objects,
  never names — so composition doesn't move backward into the generator the way upstream's did, it
  just moves one node upstream, onto a node whose only job is composing. See §3 and §5.
- *(Nothing here about detection. An earlier draft listed upstream's SAM3 detection as
  not-copied; that was reversed — we adopt the per-block `detect_prompt` and add an optional `SEGS`
  override on top. See §6a.)*
- **~150 of upstream's ~250 settings** — everything behind a dependency we're not taking. See §4.
- **Their sampler-mode dispatch.** Three modes (`comfy_ksampler` /
  `spectrum_mod_guidance_advanced` / `spectrum_spd_speed`) is why `aio/sampling.py` is 15k of
  signature-filtering. We ship one path: ComfyUI's `KSampler`, with Mod Guidance applied as a
  model patch before it.

---

## 2. Why two nodes

Same reasoning as the Controls line, different axis. Here it is not cache granularity but
**optionality**: a preview UI you cannot remove is a preview UI you resent. Splitting means "I
don't want preview" is expressed by not wiring it.

| | **Anima Generator** | **Anima Preview** |
|---|---|---|
| Does | runs the pipeline | compares images, **and saves them** |
| Emits | `IMAGE` list (§5 Outputs, reversed 2026-07-28), `LATENT`, `STRING` | nothing — terminal |
| `OUTPUT_NODE` | **no** | **yes** |

**Saving lives on the Preview node, not the Generator** (decided 2026-07-27). Upstream puts Save
Options inside the generator; we don't, for one concrete reason: the node holding all three stage
images is the only place they can be saved *under different names*, which is the entire point of
having three. A `%stage%` filename token turns a comparison run into `base`/`mid`/`final` files you
can tell apart.

Two consequences, both deliberate:

- **The Generator is pure compute and is not an `OUTPUT_NODE`.** A graph with no Preview wired runs
  nothing at all. That is the intended behaviour, not an oversight — there is no output to produce.
- **The hidden `PROMPT` / `EXTRA_PNGINFO` inputs live on the Preview node**, because that is where
  embed-workflow happens. See §9.

So "I don't want preview" now means "I don't want output either". If a save-without-preview case ever
turns up, the answer is the Preview node's compare toggle set off — it is still the saver.

**"Saves them" is a capability, not a default (2026-07-29).** Being the only node that *can* save
does not mean it saves unasked: `save.enabled` ships **off**, with a **Save now** button for the
one-off case. §7a has the reversal and why the original "on by default, since it's the only saver"
reasoning didn't survive live use.

**Why the preview is not a live feed.** Upstream streams stage images over a websocket event
(`easyuse-anima-aio-preview`, `aio/preview.py:15-27`) keyed by `unique_id`. A separate node
cannot receive those over a wire mid-execution, so a live split would have to couple the two
nodes through the event bus and an id handshake. Decided against: **stage images arrive as
ordinary IMAGE outputs at the end of the run.** No event bus, no id linkage, and the Preview
node becomes a plain node that happens to draw two images. The cost is that you don't watch it
progress — accepted deliberately.

---

## 3. Resources — one `ANIMA_CONTEXT` socket, built by `AnimaContextBridge`

**Reversed 2026-07-28** (see §1's dated note on the `EASY_USE_ANIMA_INPUT` entry — this section is
the "how" of that reversal). The Generator used to take `MODEL`/`CLIP`/`VAE` as `optional` sockets
plus a `use_internal_loaders` flag switching in the node's own `unet_name`/`clip_name`/`clip_type`/
`vae_name` pickers. **All of that is gone.** There is no internal-loader mode anymore, no pickers,
no flag. A new node, `AnimaContextBridge` (`nodes/anima/context_bridge.py`, `AnimaFlow/Anima`,
display name **"Anima Context Bridge"**), takes eleven `optional` sockets — `model` / `clip` /
`vae` / `positive` / `negative` / `latent` / `seed` / `steps` / `cfg` / `sampler_name` /
`scheduler` — and emits ONE socket, a custom type `ANIMA_CONTEXT` named `context`, which is now the
Generator's **entire** `required` input alongside `generation_settings`.

Why bundle rather than keep the sockets loose on the Generator: nine-plus separate wires into one
node reads worse than one, and the bridge is where composition happens now instead of on the
generator itself — see §1. Why a *separate node* rather than, say, collapsing the Generator's own
nine sockets down to a dict-typed input the Generator builds itself: the whole point is that the
bridge composes with **every other node that already emits these types** — `AnimaLoaderPanel`'s
real `MODEL`/`VAE`/`CLIP`, a Control Panel row's `COMBO` sampler value, Pixaroma's LoRA loader's
patched `MODEL`/`CLIP` — the same way the deleted sockets always did, just gathered in one place
immediately before the Generator instead of scattered across it.

Three constraints, carried over from the flag design because they're still load-bearing on the new
one:

- **Every socket on `AnimaContextBridge` is `optional`, never `required`** — there is no
  `required` list on this node at all. ComfyUI validates required inputs before the node's code
  runs, so a required `MODEL` would hard-fail the queue for anyone not wiring every single field.
  An unwired socket simply contributes nothing to the context (see `src/anima/context.py`'s
  `build_context`) — it's `AnimaGenerator`, the *consumer*, that decides at run time what a
  particular pipeline configuration actually needs and raises a readable error for whatever's
  missing (`ContextFieldMissing`, naming the field and pointing back at the bridge).
- **The context must distinguish "never wired" from "wired to a value that happens to be
  `None`".** A field the bridge never received at all and a field whose wired producer
  legitimately emitted `None` both look like `None` if you only look at the value — that's exactly
  the ambiguity `build_context`'s `supplied` map exists to resolve, and it's why the bridge's own
  kwarg defaults are a `MISSING` sentinel, not plain `None` (`context.py`'s own docstring has the
  mechanism). Nothing downstream should ever need to guess.
- **`AnimaContextBridge`'s own socket order is append-only**, same reasoning as the flag-era
  pickers (`BACKLOG.md` §4, `9388cf9`) — a new context field goes at the end of `OPTIONAL_KEY_ORDER`,
  never inserted.

**LoRAs still need no socket of their own** — this is UNCHANGED by the reversal, just moved one
node over: externally they arrive already baked into `MODEL`/`CLIP` by Pixaroma's loader, upstream
of the bridge instead of upstream of the Generator (§5b). The inline LoRA list that used to exist
for `use_internal_loaders`'s "on" case is gone along with that flag — there is no more internal-
loader mode for an inline list to serve, so `generation_settings.loras` was deleted too (§8).
`src/anima/loras.py` still serves nothing on the wire; it's now genuinely dead code (no caller left
at all), kept in place rather than deleted because a pure module that still round-trips correctly
wasn't this task's problem to remove.

**An unwired `latent` no longer falls back to an inline-mode settings block** (there is no more
inline mode) — `pipeline.py` falls back to a FIXED default size (1024×1024, batch 1) instead. This
was a real decision, not an oversight: every context field is optional by design, so an unwired
`latent` has to degrade the same predictable way every other unwired field does, not become the one
field that hard-fails a run. A readable error was considered and rejected for exactly that reason.

**The overlap with the Loader Panel is still intentional, not redundant.** `AnimaLoaderPanel` is a
unet/vae/clip picker with real `MODEL`/`VAE`/`CLIP` outputs, and wiring it into the bridge is the
normal setup — it caches separately, so a seed bump doesn't reload the UNET. There is no more
one-node "scratch graph" case the way the old internal pickers served — a scratch graph now needs
the bridge node too, which is the cost of collapsing nine sockets onto one that composes.

---

## 4. Dependencies — one soft, two conditional, four skipped

Every dependency is **soft-imported**: absent pack ⇒ that section is disabled and generation is
otherwise unchanged. Never a hard requirement, never in `requirements.txt` (these are
custom-node deps, not Python deps — see upstream's `README.en.md:193-196` for the same
reasoning).

| Pack | What we use | Verdict |
|---|---|---|
| **Spectrum-KSampler** | `AnimaModGuidance` only | **Take it** |
| **UltimateSDUpscale** | `UltimateSDUpscale` | Conditional — the upscale stage |
| **Impact-Pack** | `DetailerForEach`, `MaskToSEGS` | Conditional — **required by the detailer stage** |
| KJNodes | — | Skip |
| Anima-DAVE | — | Skip |
| Anima Safe PAG | — | Skip |
| Distilled-ResShift | — | Skip |
| Image-Saver | — | Skip |

**Spectrum, for `AnimaModGuidance` and nothing else.** A model patch that injects quality tags
as a modulation signal through transformer layers 8–27 weighted by `mod_w` (default 3.0), with
profiles `step_i8_skip27` / `step_i14` / `uniform_w3`
(`easyuse_anima/prompt/conditioning.py:86-140`). It is Anima-specific steering that does not
consume prompt tokens, and it is the largest image-quality gap between us and upstream. Approved
in `BACKLOG.md` §1c. We skip Spectrum's other four features (the forecast sampler, SPD/SPEED,
and the DCW/SMC/CFG++/FSG correction bundle) — all speed or off-by-default polish, and each
drags in a sampler dispatch path.

> **Repo-URL discrepancy to settle before writing an install hint.** Upstream's code says
> `blepping/ComfyUI-Spectrum-KSampler` (`aio/sampling.py:131`) while its README says
> `sorryhyun/ComfyUI-Spectrum-KSampler` (`README.en.md:199`). Verify which actually ships
> `AnimaModGuidance`.

**KJNodes skipped** — `ModelPatchTorchSettings`, `PathchSageAttentionKJ`,
`TorchCompileModelAdvanced` (`aio/model_preparation.py:82-131`) are speed/VRAM only, zero
image-quality contribution, all ship OFF, and are the most fragile thing in the list on Colab
(Triton/CUDA stack mismatches). Purely additive if ever wanted.

**DAVE skipped** — `patch(model, mask="dave_alpha.npz", strength=0.30, tau=0.10)`
(`aio/model_preparation.py:255-274`), upstream-described as a diversity patch. Off by default,
needs an extra downloaded asset, and seed diversity is not the bottleneck.

**Safe PAG skipped for v1, worth a later experiment.** Perturbed-Attention Guidance, Anima-tuned
(`aio/model_preparation.py:279-303`): a second prediction with attention degraded in chosen
blocks, steered away from, with `rescale=0.2` to stop the oversaturation plain PAG causes. Real
anatomy/structure story, but roughly an extra model eval per step. The one skip with a genuine
quality argument.

**Image-Saver skipped.** What it is actually wanted for is workflow-reload-on-drag, and stock
`SaveImage` plus declared hidden `PROMPT` / `EXTRA_PNGINFO` gives that for free — see §9.

---

## 5. The Generator node

**Category `AnimaFlow/Anima`**, folder `nodes/anima/` + `js/anima/` (Title Case in the picker,
lowercase snake_case on disk — Python packages must be importable, so the two agree
case-insensitively).

`Anima` is the topic `.claude/skills/animaflow-node-theme/SKILL.md` already reserves for "the
Anima model pipeline/encoding, not yet rebuilt" — which is precisely this pair. A fifth topic
would be an invention; **`Generate` was considered and rejected** for that reason. **Not**
`AnimaFlow/Panel` either: that's reserved for the deleted webtoon panel pipeline and would
collide on its rebuild.

### Inputs

**Reversed 2026-07-28** (§1/§3): the Generator's whole input surface collapsed to two `required`
keys. Everything that used to be a separate socket or a picker widget on THIS node now lives on
`AnimaContextBridge` instead (§3) — the table below is deliberately short.

| | Name | Type | Notes |
|---|---|---|---|
| required | `context` | `ANIMA_CONTEXT` | from `AnimaContextBridge` (§3). Carries MODEL/CLIP/VAE/positive/negative/latent + the five sampler scalars |
| required | `generation_settings` | `STRING` | hidden-for-rendering, natively serialized; the whole settings tree |
| hidden | `unique_id` | `UNIQUE_ID` | `PROMPT`/`EXTRA_PNGINFO` live on the **Preview** node now — §7, §9 |

Deleted from this node entirely: `use_internal_loaders`, `unet_name`/`clip_name`/`clip_type`/
`vae_name`, and the `model`/`clip`/`vae`/`latent`/`seed`/`steps`/`cfg`/`sampler_name`/`scheduler`
sockets. None of them are "hidden now" or "moved to optional" on the Generator — they don't exist
on this node's `INPUT_TYPES` at all anymore. **This is a documented breaking change to already-
saved workflows**, not an oversight: removing widgets (unlike inserting one mid-list, which is what
the append-only rule actually guards against) unavoidably shifts every positional value after the
cut point. Accepted because these nodes are days old and still `EXPERIMENTAL`.

Prompt text is **not** an input, unaffected by this reversal. Conditioning comes in already
encoded (now via the context's `positive`/`negative` fields), so prompt editing stays upstream in
the Rule Builder / Prompt Studio line. Upstream made the same call and it is right.

### 5a-0. What the frontend can and cannot see about a supplied field (probed live 2026-07-28)

The panel greys out a sampler field the context supplies. Three separate mechanisms feed that, with
genuinely different reach — worth stating plainly, because two of them were mistaken for bugs:

1. **The edit-time link walk** (`resolveContextBridge`) follows real litegraph links from `context`
   back to the Bridge, tolerating single-input pass-throughs. Cheap, instant, and blind to anything
   that isn't a real link.
2. **The post-run report** (`{"ui": {"anima_context": [payload]}}` → `handleGeneratorExecuted`) is the
   authoritative one: the backend knows exactly which fields arrived, however they arrived. It's keyed
   by node id, so it is **boundary-agnostic** — it works across subgraphs where the walk can't. It
   only exists after an execution, and a **cached** node emits nothing, so "no report this run" is a
   normal state, not a failure.
3. **Use Everywhere is invisible to (1) and visible to (2).** UE materializes real links only at
   submit time and removes them again, so at edit time `input.link` is null while the backend still
   receives the value. Server-side truth and frontend-visible truth genuinely disagree, and only the
   run report closes the gap.

**Subgraphs (the boundary case).** With the Bridge inside a subgraph and the Generator outside, the
`context` link's origin is the **subgraph node**, not the Bridge: `isVirtualNode: true`, a `subgraph`
property, and `type` set to the subgraph's UUID rather than a class name. Its `inputs` are the Bridge's
own sockets **promoted to the boundary** (`clip, model, vae, latent, seed, steps, cfg, sampler_name,
scheduler`), with names matching `CONTEXT_FIELDS` — so the wiring state is readable straight off the
boundary node; descending into the subgraph is only needed to confirm a real Bridge is in there (which
is what makes the section ⓘ's wording honest). The harder half is the repaint TRIGGER: wiring a
promoted input from outside fires `onConnectionsChange` on the subgraph node, and a subgraph node's
type is a per-instance UUID, so it can't be patched through `beforeRegisterNodeDef` — it needs an
instance-level hook installed when the walk first resolves that boundary. Failing OPEN (nothing
disabled) stays the rule whenever any of this can't be determined: a wrong grey-out is worse than none.

**The boundary node's full shape, all probed live on frontend 1.45.21** — don't re-derive these:

| what | value |
|---|---|
| identity | `isVirtualNode === true` **and** a `subgraph` property. Match on **both**; other virtual nodes exist, and `type` is a per-subgraph **UUID**, never a class name |
| promoted inputs | `["clip","model","vae","latent","seed","steps","cfg","sampler_name","scheduler"]` — the Bridge's own sockets, names matching `CONTEXT_FIELDS`, so `supplied` reads straight off them |
| promoted outputs | `["context"]` — **same-named**, which is what lets the FORWARD walk cross the boundary |
| inner node list | **`subgraph._nodes`** (underscore), with `_nodes_by_id` alongside; also `inputNode`/`outputNode` for the inside-facing IO nodes, and `_nodes_in_order`/`_nodes_executable` |

The inner list is what makes `bridgeConfirmed` resolvable — without it the code can only report
"boundary found, Bridge unconfirmed". `inputNode`/`outputNode` are the handles to use if traversal
ever needs to run from *inside* a subgraph outward, which nothing does yet.

### 5a. Sampler values — still per-field wins, now via the context

`seed`, `steps`, `cfg`, `sampler_name` and `scheduler` are still each independently overridable,
same reasoning as before this reversal — the realistic setup wires only `seed` from a Control Panel
row while steps and cfg stay internal, so a global flag would force all-or-nothing on values that
have no reason to move together. What changed is WHERE the override comes from: there is no more
"wired socket on the Generator" to check — the check is now **"did the context supply this field"**
(`src/anima/context.py`'s `context_supplied`), read off `AnimaContextBridge`'s own sockets one node
upstream. **If the context supplied a field, it drives that field; if it didn't, the
`generation_settings.sampler` value is used.** Per field, independently — still no
`use_internal_sampler` flag, and still a different pattern from the resources' now-deleted flag for
the same reason as before: `MODEL`/`CLIP`/`VAE` genuinely travel together as one checkpoint
decision; these five scalars don't.

**The overlay must show a field driven by the context as driven by the context**, not as an
editable number that's silently ignored — same risk as before, just re-anchored to "the context
supplied it" instead of "the socket is wired". Whichever frontend slice reads this: the bridge's
own connected-socket state is still the single source of truth for that badge, it's just one hop
further upstream than it used to be.

`sampler_name` / `scheduler` still arrive as **`COMBO`**, now on `AnimaContextBridge` rather than
the Generator — settled and verified live on 2026-07-27 (`control-panel-design.md` §5): a Control
Panel combo row sets `output.type = "COMBO"` and wires to a KSampler correctly. So the panel can
still drive all five, just by wiring into the bridge instead of the generator.

> **Legacy-litegraph caveat, inherited from the Control Panel** (`control-panel-design.md` §5): on
> the target renderer a plain declared widget is a canvas widget, not a socket. Declaring these five
> as socket-only `optional` inputs (`forceInput`) on `AnimaContextBridge` sidesteps the "right-click
> → Convert widget to input" dance entirely — their internal counterparts live in the settings JSON,
> not as widgets, so there is nothing to convert and no widget-order exposure (`BACKLOG.md` §4).

### 5b. LoRA — Pixaroma's node patches `MODEL`/`CLIP`; we only handle the inline case

**Verified against `../ComfyUI-Pixaroma` at `5036814` (v1.4.62)** — pulled 2026-07-27 specifically to
check this, because the previously-cloned `afd0d05` (v1.4.44) predated the node.

`PixaromaLoraLoader` — display name **"LoRA Loader Pixaroma"** (`nodes/node_lora_loader.py:26`):

| | |
|---|---|
| in | `model` (required `MODEL`), `clip` (optional `CLIP`) |
| out | `MODEL`, `CLIP`, `triggers` (`STRING`) |

**It absolutely does stack** — its own description is "Stack as many LoRAs as you want in one node",
each row with an on/off switch and strength, applied in row order, and several nodes chain. The
distinction that matters here is narrower, and an earlier revision of this section put it badly by
calling it "not a stacker":

> **It stacks internally and hands back patched `MODEL`/`CLIP`. It does not emit a `LORA_STACK`
> object** for some later node to apply. Nothing in that pack emits one.

That is the only thing this design turns on: there is no stack-shaped output to plug into a
`lora_stack` socket, so the socket is not how LoRAs get here.

**So the LoRA path needs nothing from us.** The LoRAs are already baked into `MODEL`/`CLIP` before
either the bridge or the Generator ever sees them:

```
Loader Panel ──MODEL──> Pixaroma LoRA Loader ──MODEL──────────> Context Bridge.model
             ──CLIP───>                       ──CLIP──> Text Encode ──COND──> Context Bridge.positive
                                              ──triggers──> (into your prompt text)
```

(§3's reversal moved this diagram's endpoint from `Generator.model`/`Generator.positive` to
`Context Bridge.model`/`Context Bridge.positive` — the LoRA reasoning underneath is unchanged.)

> **The subtle part, and it fails silently.** Route the **patched** `CLIP` onward to your text encode,
> not the Loader Panel's raw one. Wire the raw `CLIP` to the encoder and the LoRA's *model* effect
> still lands (via `MODEL`) while its *CLIP* effect vanishes — no error, just a weaker result and
> trigger words that read differently than intended. That is exactly why their node takes `CLIP` at
> all, and why it sits **before** the text encode rather than just before the bridge.

**There is no `lora_stack` socket, and there is no inline LoRA list either anymore.**

The `lora_stack` socket was never built — dropped 2026-07-27 as speculative compatibility for packs
that *do* emit a `LORA_STACK`-shaped output (efficiency-nodes, rgthree, Impact) in a pack built for
a setup that doesn't need it.

The **inline LoRA list, on the other hand, WAS built and is now deleted (2026-07-28)** — this is a
genuine reversal, not a "never built" like the stack socket. It existed for exactly one reason:
with `use_internal_loaders` **on** (§3, now also deleted), the Generator loaded its own unet/clip
internally, so there was no `MODEL`/`CLIP` wire for Pixaroma's LoRA loader to sit on, and the inline
list was the only way to get LoRAs in at all in that mode. Deleting `use_internal_loaders` deletes
that mode entirely, and with it the inline list's whole justification — `generation_settings.loras`
is gone from the settings tree (§8), and `apply_lora_stack`/`_resolve_lora_name` are gone from
`pipeline.py`. **There is now exactly ONE way LoRAs arrive: already applied to `MODEL`/`CLIP`,
upstream of `AnimaContextBridge`.** `src/anima/loras.py`'s pure normalization functions
(`normalize_lora_stack`/`entries_to_apply`, ported from upstream's `_normalize_aio_lora_stack`) are
consequently dead code with no caller anywhere in this pack — kept in place, unedited, rather than
deleted, since removing a pure module that still round-trips correctly wasn't in scope for the task
that reversed the mode using it.

Appending an optional LoRA-stack socket to `AnimaContextBridge` later is still safe under the
append-only rule, so nothing is foreclosed if a pack that emits one ever becomes worth supporting.

#### One thing in their node we deliberately don't copy

- **Its state handshake.** `LoraLoaderState` is declared in **`hidden` `INPUT_TYPES`**
  (`node_lora_loader.py:48`) and injected at `graphToPrompt` time. This pack forbids that pattern —
  `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` §2 records it delivering the default `"{}"`
  to a backend in a real deployment while the on-node preview looked correct. Same rule as
  `control-panel-design.md` §1: a declared, natively-serialized STRING widget, hidden for rendering
  only.

(A second "thing we don't copy" used to live here — their zero-strength semantics for a *zeroed
inline LoRA row*. Moot now that the inline list itself is gone; upstream's zero-strength choice
only ever mattered for code we no longer have.)

### Outputs

**Reversed 2026-07-28.** The three fixed `IMAGE` sockets below (`image`/`image_base`/`image_mid`)
and the pass-through rule that justified them are BOTH gone, replaced by one `IMAGE` LIST:

| Name | Type | Content |
|---|---|---|
| `images` | `IMAGE` (`OUTPUT_IS_LIST`) | this run's produced images, ordered `base, mid, final` |
| `latent` | `LATENT` | final latent |
| `metadata_json` | `STRING` | per-stage metadata for debugging, including `stage_labels` |

Why the reversal: a ComfyUI `IMAGE` is one tensor `[B, H, W, C]`, so a single BATCHED output can't
hold `base`/`mid`/`final` together once a later stage changes resolution (base 1024, upscaled
2048) — three separate FIXED sockets were the fix for that, each always populated. Filling all
three unconditionally is exactly what forced the old pass-through rule: with three sockets to fill
and no dynamic-output machinery, a disabled stage had nothing to hand back except the previous
stage's tensor, so `image_mid == image_base` became a *documented*, not incidental, "no detailer
ran" signal.

`OUTPUT_IS_LIST = (True, False, False)` removes the reason for that rule to exist at all: `images`
is now a genuine Python list `AnimaGenerator.generate()` returns for that slot, and a stage that
didn't produce a genuinely different image is **OMITTED from the list**, never duplicated
(`src/anima/stages.resolve_stage_labels`). A run where every optional stage is off returns a
length-1 list (`["base"]` worth of tensors) instead of three identical images. Order is always
`base` (present unconditionally — always the first pass), then `mid` (present iff highres or a
live detailer pass changed the image), then `final` (present iff a live upscale or an applied
postprocess resize changed it again).

**The list itself carries no labels — `metadata_json.stage_labels` is now the ONLY way anything
downstream can tell the positions apart.** It's an ordered list of strings (`"base"`/`"mid"`/
`"final"`) the same length as `images`, index-aligned: position `i` of `images` is stage
`stage_labels[i]`. `AnimaPreview` reads this back rather than re-deriving it — see §7's own
reversal note and `src/anima/preview_settings.resolve_run_stage_labels`, "keep the label mapping in
exactly one pure place" is the whole design constraint here.

**Highres still has no socket of its own**, absorbed into the base→mid span exactly as before this
reversal — that part of the old design didn't change, only the SHAPE that "absorbed into the span"
takes (a possibly-omitted list entry, not a duplicated fixed socket).

**VERIFY-IN-COMFYUI**: this was built and reasoned from ComfyUI's documented `OUTPUT_IS_LIST`
execution contract, not exercised against a live process (none installed in this dev environment).
Expected downstream behaviour: a node wired to `images` that does NOT itself declare
`INPUT_IS_LIST` is invoked ONCE PER ITEM in the list (every other, non-list input held constant
across those calls); a node that DOES declare `INPUT_IS_LIST` (`AnimaPreview`, §7) receives the
whole list in one call instead.

**Not** an `OUTPUT_NODE` — it doesn't save (§2). Nothing runs unless a Preview is wired.

---

## 6. Stages

Order is upstream's (`aio/generation_pipeline.py:10-17`) minus its `save_output`, each stage
independently enabled. **Five stages, not six.**

1. **First pass** — Mod Guidance patch (if enabled and Spectrum present) → `KSampler` → VAE
   decode. Size from the context's `latent` field if supplied, else a fixed default
   (1024×1024, batch 1 — reversed 2026-07-28, §3: there is no more `settings.latent` block to
   fall back to, since inline mode and its only consumer are both gone).
2. **Highres** — latent upscale by `scale_by` (default 1.5), resample, re-sample at
   `denoise` 0.25. Inherits the first-pass sampler unless `inherit_sampler_settings` is off.
3. **Detailer** — **N blocks, each detecting for itself.** Per block:
   `SAM3_Detect` (built-in, driven by the block's `detect_prompt`) → `MaskToSEGS` →
   `DetailerForEach`. No `SEGS` sockets. Defaults from upstream's **face** block, the conservative one
   (`generation_defaults.py:292-357`). Requires Impact. See §6a.

### 6a. Detailer — N blocks, detection internal, no sockets

**Upstream is N user-addable blocks.** `face` and `eye` are two *built-in* blocks; beyond them the
dialog's `+ Add block` creates unbounded `custom_1`, `custom_2`, … each inheriting the face defaults
and enabled on creation (`web/js/aio/detailer_settings_dialog.js:357-368`,
`easyuse_anima_aio.js:3331-3341` — the name generator loops to 1000, so there is no practical cap).
Every tab **renames** and **reorders** via `<` `>` buttons that mutate `detailer.order` (`:320-337`).
Custom blocks can be removed; `face`/`eye` cannot (`:342-344`). The backend mirrors this:
`_is_aio_detailer_target_name` accepts `face`, `eye`, or `^custom_\d+$`
(`aio/generation_normalization.py:97-101`).

So a **Face / Eye / Hands** tab strip is exactly what upstream looks like in use — "Hands" being an
added block, renamed, with its `detect_prompt` set to `hands`.

**Each block owns its detection.** The per-block chain is
`SAM3_Detect` → `MaskToSEGS` → `DetailerForEach` (`easyuse_anima/image/sam3.py:46-121`), driven by
the block's free-text `detect_prompt` (`generation_defaults.py:295`) plus `detect_count` and
`threshold`. *The block is the detection request*, which is what makes N blocks coherent: a block
named Hands asks for hands and refines what came back, all in one place.

**We keep that, internal.** An earlier draft of this section had the node take `SEGS` as its only
input and let the user's own detector produce regions. That was wrong on both counts it claimed:

- It did **not** avoid Impact. `DetailerForEach` is an Impact node, so the stage needs Impact either
  way; SEGS-only avoided just `MaskToSEGS`.
- It did **not** come for free. Detection via `SAM3_Detect` is a **ComfyUI built-in** — zero
  additional dependency — so pushing it out of the node bought nothing and cost the user a
  hand-wired detector chain per block, in the one node whose whole point is not having to wire a
  pipeline by hand.

So: **`detect_prompt` per block, detection internal, exactly like upstream.**

**And no `SEGS` sockets.** An override socket per block was specified and then dropped on the same
grounds as `lora_stack` (§5b): speculative wiring for a case nobody has, in a node whose point is not
having to wire a pipeline. Detection is internal, period. Adding optional sockets later is safe under
the append-only rule, so this forecloses nothing — but the default must be that the node just
works.

Per-block settings matter and must not be collapsed: upstream ships `noise_mask_feather` **10 for
face, 20 for eye** (`:321`, `:387`), and different `denoise` per target. That difference is the
entire argument for blocks over one global pass.

**`MAX_DETAILER_PASSES = 4`** (settled 2026-07-27). Upstream is effectively uncapped; the cap is
purely about compute, since every pass is a full re-sample. Note the reason **changed**: it was
originally justified by each pass costing a socket, which stopped being true when the `SEGS` inputs
went away. Blocks are now plain settings-blob entries like the inline LoRAs — the difference is that
LoRAs are cheap to add and detailer passes are not. May grow later, never shrink; no dynamic-socket
machinery is needed at all.

4. **Upscale** — USDU only, with seam-fix and tile controls exposed (upstream's `seam_fix_mode`
   was hardcoded to `"None"` in the old port, making seam repair unreachable; `7ca9a1c` fixed
   that and the work is recoverable from git). `mode_type` (Linear/Chess/None) is tile **order**;
   `tiled_decode` is an unrelated VAE flag — do not conflate them.
5. **Postprocess** — the output size cap (`max_long_edge` / `max_megapixels`,
   `aio/postprocess.py:42-86`). The old port only ever rounded *up*, leaving final size
   unbounded. This is the fix.
**No save stage.** Saving is the Preview node's job (§2, §7).

### 6b. `inherit_sampler_settings` — what it covers, and what the UI does about it

**Matches upstream exactly** (`aio/sampling.py:400-436`). The flag covers three fields; two are always
the stage's own:

| field | inherit on | inherit off |
|---|---|---|
| `steps` | **stage's own** | stage's own |
| `denoise` | **stage's own** | stage's own |
| `cfg` | from the first pass | stage's own |
| `sampler_name` | from the first pass | stage's own |
| `scheduler` | from the first pass | stage's own |

`steps` and `denoise` are never inherited in either implementation (`:404`, `:434`) — and rightly so:
they are precisely the two a low-denoise refinement pass has to set for itself.

**The UI contribution is to hide the three inherited fields while the flag is on**, and to name the
values actually in force instead. An editable control whose value is silently ignored is the same trap
as §5a's wired-field badge — the fix is the same, show where the value is really coming from.

That also cleans up a real snag in upstream's UI: it ships highres `cfg: 8.0` *together with*
`inherit_sampler_settings: True` (`generation_defaults.py:163-168`), so that `8.0` sits in the dialog
looking editable while being unreachable until you turn inherit off. Same data, no confusion, purely
by not drawing it.

Applies to all three sampling stages — highres, upscale, detailer — each with its own flag.

### First-pass cache — the biggest workflow win

Upstream keys a small LRU on resources + file revisions + prompt data + sampler + patches + size
(`aio/first_pass_cache.py`: 2 entries, 512 MB, 300 s TTL). It means tweaking only
highres/detailer/upscale **skips re-sampling the base** — which is exactly the loop the three
image outputs are for. Never built in the old port. Build it here; the three-output compare
design makes it more valuable than it was upstream.

---

## 7. The Preview node

Terminal node, `AnimaFlow/Anima`, one DOM widget.

**Reversed 2026-07-28**: `image_a`/`image_b`/`image_c` are gone, replaced by one `images` input
wired straight to the Generator's own `images` list output (§5's reversal), plus `metadata_json`
(wired to the Generator's `metadata_json`) so this node can recover which list position is which
stage. This node now declares `INPUT_IS_LIST = True` — the WHOLE node, not just `images`: every
declared input, including the hidden `prompt`/`extra_pnginfo`, arrives wrapped in a list, so
`preview()` unwraps each single-valued one explicitly (see `nodes/anima/preview.py`'s own comment
for why this is worth spelling out — it's an easy thing to get subtly wrong). `images` is the one
input that must NOT be unwrapped to its first element, since staying the full list is its entire
point. Compare is now **within the current run**: the wipe picks two entries from the received
list by stage name, resolved through `src/anima/preview_settings.resolve_run_stage_labels` — "keep
the label mapping in exactly one pure place" (§5's own note) means this function, and only this
function, decides which position is which stage; `AnimaPreview` never re-derives it.

- **One `images` input** (`optional`, `IMAGE`, the whole list) plus `metadata_json` (`optional`,
  `STRING`) for the label mapping above.
- **A picker for which two stages to compare.** Default `base` vs `final` — the comparison
  actually wanted most of the time. If only one stage is present this run (e.g. every optional
  stage was off), the compare degrades to a plain single-image view automatically —
  `resolve_shown_stage` just finds the one stage that exists, regardless of what the picker names.
- **An enable/disable toggle for the wipe.** Off → plain single-image view. The compare must
  never be something to work around.
- **Hover wipe, not drag.** Upstream attaches `pointermove` without gating on button state
  (`generator_panel_runtime.js:811-816`), so the divider tracks the cursor; `pointerdown` is
  only there so a click also snaps it. Two absolutely positioned layers + a `.divider`, driven
  by one CSS var `--wipe-x`. **`event.stopPropagation()` on both handlers is load-bearing** —
  without it litegraph steals the gesture and the divider never moves.
- **Both panes need `object-fit: contain` into a shared box sized by the larger image.** Stage
  images have different resolutions (base 1024 → upscaled 2048); a naive two-layer overlay
  misaligns, and the wipe must cross the same framing on both sides.
- Per-pane labels naming which output each side is, so a wipe is never ambiguous.

**Body order (revised 2026-07-28, supersedes `playground/generator.html`'s three-row stack).** The
mockup put the image box first, then the compare switch, then the `save` row, then the
`base|mid|final` **vs** `base|mid|final` pickers on a *fourth* row. Built and used, that read wrong
twice over: `save` is the node's one *setting* and belongs above the thing it acts on rather than
buried under it, and a whole row spent on two segmented groups pushed the switch that enables them
away from them. That 2026-07-28 order was **Save section → image box → one compare row**, with the
compare row carrying `[switch] compare` and both pickers right-aligned via `.wtn-an-segs`.

**Revised again 2026-07-29 (owner, from live use) — three stacked blocks, and the compare row became
a card.** Shipped order is now:

```
[ Save now ] [ Save card ]      <- ONE row: button left, card takes the remaining width
[ Compare card ]                <- one row: switch + label + both pickers, right-aligned
[ image box ]                   <- flex-fills whatever height is left
```

Three changes, each with its own reason:

- **`Save now` sits beside the Save card, not below it.** It is absent (never merely disabled) while
  `save.enabled` is true — an enabled run already saves itself (§7a) — and the card then takes the
  **full** width with no leftover gap.
- **Compare is a card**, a sibling of the Save card rather than a bare strip at the bottom, so the two
  settings surfaces read as the same kind of thing. It is deliberately **one row with no expandable
  body**, which is why §12's "the switch owns expand/collapse" rule does *not* apply to it — there is
  nothing to expand into. The switch keeps its exact prior meaning: on ⇒ hover-wipe, off ⇒ single image.
- **The two `base|mid|final` segmented groups became single menu buttons** (`buildComboButton`, opening
  the same option-list overlay a stepper's combo uses — reused, not reimplemented). `.wtn-an-seg*` and
  `.wtn-an-pvbar` are deleted. **The pickers stay visible regardless of the switch** (they used to
  render only while `compare.enabled`) — owner-approved 2026-07-29, so you can line up which two stages
  to compare *before* turning compare on. Do not "fix" this back.

**Sizing numbers live in `render.mjs`, not here.** This section previously asserted a min width of
`380px` while the code had said `444` and now says `320`; restating a bare number just resets a clock
that drifts. The floors are **derived from the panel font-size setting** (`_PANEL_DEFAULTS` × the scale
ratio, `roundTo4`), so `_PANEL_DEFAULTS` is the single source of truth and the values below are only
its 14px-base defaults. As of 2026-07-29: `PREVIEW_MIN_W` **320** (it fell from 444 precisely because
two combo buttons are far narrower than two 3-button groups), `PREVIEW_IMG_MIN_H` **188**. (The `save` *row*
became the `Save` *section* in §12's inline-sections dispatch; its position in this order didn't
change. Any older note here about popover geometry is void — **settings** are never a popover on this
track any more. The overlay mechanism itself did return on 2026-07-29, for anchored ⚙ menus and option
lists only; §12 carries that distinction.)

**The image fills the node, and this panel never scrolls — reverses §12's call, for this node
only (2026-07-28, later the same day).** §12's dispatch gave both nodes one `.wtn-an-panel` that
flex-fills the node's height and scrolls internally when the content doesn't fit, and decided the
wipe should keep `aspect-ratio: 1/1` inside it — so a too-short node scrolled the image out of
view. Wrong for *this* node: the compare image is the entire reason the node is on the canvas, and
everything else is chrome around it. So `.wtn-an-panel-pv` (a modifier class applied only by
`mountPreviewUI`) drops the scrollbar (`overflow: hidden`) and the wipe flex-fills whatever height
is left (`aspect-ratio: auto`, floored at `PREVIEW_IMG_MIN_H`). The layers' `object-fit: contain`
already letterboxes each image into whatever box it's given, so a non-square node distorts nothing.
**The Generator's panel is untouched — it still scrolls.**

> **Both nodes on this track are sizing Class B** — freely resizable on *both* axes, each floored at a
> real minimum. That is the pack-wide contract in
> [`control-panel-design.md`](control-panel-design.md) §7a, which also covers Class A (the Control/Loader
> panels and the future LoRA loader, whose height is content-fixed and not draggable at all). The
> distinction is not stylistic: a Class B body scrolls (Generator) or flex-fills (Preview), so a taller
> node genuinely shows more, whereas a Class A body is a list of rows whose sockets are parked per row.
> **The Generator gained its height floor on 2026-07-29** (owner policy) — it previously had none, since
> its panel scrolls; internal scrolling is unchanged, the floor only stops an absurdly short drag.

Removing the scroll means the floor has to be honest, which is where the **min height** comes from:
`PREVIEW_PANEL_MIN_H` is sized so the Save row + the Compare card + `PREVIEW_IMG_MIN_H` all fit with no
scrollbar, and `PREVIEW_MIN_H` adds the title bar and the two socket rows on top
(`PREVIEW_PANEL_MIN_H + _PREVIEW_CHROME_ADDEND`). **14px-base defaults as of 2026-07-29: 292 and 372** —
re-derived when the Compare card was added, since the body gained a third block. This section used to
claim 400 and 480; both were stale, and the numbers are font-scale-derived anyway, so treat
`_PANEL_DEFAULTS` in `render.mjs` as authoritative and these as illustrative. `clampPreviewSize` clamps
**both** axes, and the Preview's
`getMinHeight` reports `PREVIEW_PANEL_MIN_H` so litegraph's drag floor agrees with the clamp instead
of contradicting it. Sizing for Save-expanded is what makes this work with **no auto-grow-on-repaint
mechanism** — §12 deliberately deleted `refitNode`/`scheduleRefit`, and this does not bring them
back.

**The preview payload key is `anima_stages`, never `images` (2026-07-28).** `{"ui": {"images":
[...]}}` is ComfyUI's own trigger for drawing a *native* image preview inside the node — so
returning the stage entries under `images` while this node also draws its own wipe rendered the run
**twice**, our wipe stacked above ComfyUI's native preview and its `1024 × 1024` caption. Fixed at
the source by renaming the channel (`nodes/anima/preview.py` → `handleExecuted`, no dual-key
fallback), rather than nulling `node.imgs` after the fact the way
`../ComfyUI-Pixaroma/js/paint/index.js:44` does — that pattern suits a node whose images arrive
once at creation, not an `OUTPUT_NODE` the frontend re-populates on every run. Accepted cost: the
entries no longer appear in ComfyUI's outputs sidebar / queue-history thumbnails, which key off the
same native mechanism. Cheap here — an unsaved stage was only ever a `temp` file, and a saved one is
on disk under its `%stage%` name.

### 7a. Save — this node owns it

`OUTPUT_NODE = True`, and the hidden **`PROMPT` / `EXTRA_PNGINFO`** inputs are declared *here*
because this is where embed-workflow happens (§9's third divergence — the deleted port never declared
them anywhere, making its saves worse than stock `SaveImage`).

- **OFF by default — reversed 2026-07-29 (`cec90cd`).** This entry used to read "**On** by default,
  since it is the only node in the pair that saves", and that reasoning was wrong in a way only live
  use showed: being the only saver argues that saving must be *reachable*, not that it must be *on*.
  Default-on meant a brand-new Preview node started writing into the user's output folder the moment
  it was dropped on the canvas, for a comparison they were still setting up. Now `save.enabled`
  defaults `false` in **both** twins (`src/anima/preview_settings.py`'s
  `DEFAULT_PREVIEW_SETTINGS`, `js/anima/state.mjs`'s), and the **Save now** button below is what buys
  the reachability back. **This is a DEFAULT change only** — normalization fills in a key only when
  it is *absent* from the raw blob, so a workflow that already saved an explicit `true` keeps it
  verbatim on every future load and is never rewritten toward the new default.
- **A `Save now` button, shown only while `save.enabled` is off** (`cec90cd`). Saves the single best
  available image on click — `final` → `mid` → `base`, whichever is present — through the *same*
  filename template and output path an enabled save would use. With save already on, the button is
  absent rather than disabled: an enabled run saves on its own, so a second manual trigger would just
  duplicate it (`js/anima/test_resize.mjs` asserts the absence).
  - **It needs an aiohttp route**, `POST /wtn/anima/preview/save_now` (`src/anima/api.py`,
    registered from `__init__.py` following `rules_api.py`'s precedent). Unavoidable: the stage images
    are `temp` files and the click happens *outside* a graph execution, so there is no node run to
    write them.
  - **Every decision stays pure and server-side** — `resolve_save_now_stage` (which stage wins) and
    `format_filename` (what it's called) live in `src/anima/preview_settings.py`, unit-tested with no
    ComfyUI. `js/anima/interaction.mjs` is the fetch call plus a one-line status readout, never a
    second copy of that logic. `resolve_save_now_stage` deliberately reuses `resolve_shown_stage`'s
    `_SHOWN_PRIORITY` rather than inventing a second "most-finished result" ranking.
  - **One honest limit, in the code comments rather than hidden.** Outside a run there is no
    `PROMPT`/`EXTRA_PNGINFO`, so a Save-now file **cannot embed workflow metadata**
    (`save.embed_workflow` is silently not honoured on this path).
  - **`%seed%` resolves to the real seed (fixed 2026-07-29).** It used to always be `0`, and the cause
    was not a missing feature but a discarded value: the seed *was* computed during the run
    (`preview.py`'s `extract_seed_from_prompt`) and then thrown away, because the `ui` payload carried
    only `anima_stages` — so the frontend had nothing to post and `src/anima/api.py`'s
    `payload.get("seed", 0)` always took its fallback. The run now ships it as
    **`anima_seed: [str(seed)]`** and Save-now echoes it back verbatim. Two of this pack's own past
    bugs constrain that one line: a `ui` value **must be a list** or it flattens to its keys
    (`f22b3c0`/`f22b3c0`), and the seed **must travel as a decimal string** — past
    `Number.MAX_SAFE_INTEGER` a JS number silently corrupts it, the same reason `sampler.seed` became a
    STRING in §8. It is converted to `int` **exactly once**, at `format_filename`'s call site via
    `resolve_seed_int`, mirroring `pipeline.py`'s convert-once-at-the-KSampler-boundary discipline.
    **The remaining gap, deliberately not papered over:** a **cached** Preview node emits no `ui`
    payload at all for that queue, so nothing populates its seed and the next Save-now click correctly
    falls back to `0`. Same class as §5a-0's "a cached node emits no report" — a normal state, not a
    failure. Reading the Generator's `sampler.seed` instead was considered and **rejected**: that value
    is frequently the `-1` random sentinel, and it is the *resolved* seed that belongs in a filename.
- `which`: the shown image / both compared / **every wired input** (`SAVE_WHICH_OPTIONS`, default
  `"shown"`). The last is the interesting one — it lands a whole comparison set in one run.
- Filename tokens: **`%stage%`** (`base`/`mid`/`final`) is the one that justifies putting save here at
  all, plus `%seed%`, `%date:FMT%`, `%counter:N%`, `%width%`, `%height%`.
- Backend is stock `SaveImage`, not ComfyUI-Image-Saver (§4).

Sizing follows the DOM-widget mechanism the pack already uses (rAF-timed
`measureContentHeight`, width-passthrough `setSize`, grow-biased `refitNode`; legacy
`computeSize`/`getHeight` with `computeLayoutSize` kept only for Nodes 2.0 forward-compat).
**Target renderer is legacy litegraph** — the legacy path must work standalone.

---

## 8. State shape

**`sampler.seed` is a STRING (2026-07-29).** Same decision, and the same reason, as
[`control-panel-design.md`](control-panel-design.md) §4's own "seed is a STRING in state" note — and
the Generator shipped without it. A seed can reach 2^64-1; JS numbers lose precision past
`Number.MAX_SAFE_INTEGER` (9007199254740991), and the frontend re-serialises the whole settings blob
on **every edit**, so a real 20-digit seed (`16963467365598029952`, from an actual run) was being
silently corrupted on a round trip. Canonical form is a decimal string clamped to `[0, 2^64-1]`, with
**`-1` preserved as the "random" sentinel** (resolving it stays `pipeline.py`'s job, per its own
long-standing note). Existing saved workflows hold ints and migrate on load —
`src/anima/settings.py`'s `normalize_seed` and `js/anima/state.mjs`'s `normalizeSeed` are twins and
must stay in exact agreement (there is a parity test over a shared table; they diverged once on
negative-but-not-`-1` input and that was treated as a bug, not a quirk). `pipeline.py` converts to
`int` **once**, at the KSampler boundary, where Python's arbitrary precision loses nothing.

**`seed_after_generate` is implemented (2026-07-29).** It had been declared in three places
(`settings.py`, `state.mjs`, the fixture) and implemented nowhere — a control offering "fixed" that
could do nothing else. It now advances once per queued prompt via an `app.queuePrompt` wrap that
*composes with* `js/shared/submit_guard.mjs`'s rather than replacing it, reusing
`js/controls/rows.mjs`'s already-tested `applyAfterGenerate` and its own mode list. Stock ComfyUI
semantics: the value present **at queue time** is the one that ran, then it advances.

The seed's UI is one row — value + roll, with the mode behind that row's ⚙ — matching the Control
Panel's shape rather than stacking a second row. See `.claude/skills/animaflow-shared-fields/` for
the general rule that produced that correction: fields are shared and composed, never rebuilt per
track.

`generation_settings`, one versioned JSON object in a declared STRING widget, hidden for
rendering only. Trimmed from upstream's tree (`aio/generation_defaults.py:39-455`) to the stages
we ship:

```
{ schema, version,
  sampler:      { seed, seed_after_generate, steps: 32, cfg: 5.0,
                  sampler_name: "er_sde", scheduler: "simple", denoise: 1.0, shift: 3.0 },
  mod_guidance: { mode, profile, quality_tags, quality_neg, mod_w, mod_start_layer,
                  mod_end_layer, ... },
  highres:      { enabled: false, scale_by: 1.5, upscale_method, multiple, max_long_edge,
                  steps: 20, denoise: 0.25,                     // always this stage's own
                  inherit_sampler_settings: true,               // governs the three below
                  cfg: 8.0, sampler_name, scheduler },
  upscale:      { enabled: false, scale_by: 2.0, steps: 20, inherit_sampler_settings: true,
                  cfg, sampler_name, scheduler, denoise: 0.2, usdu: {...} },
  postprocess:  { enabled: false, fit: { mode, max_long_edge: 2048, max_megapixels: 4.0, method } },
  detailer:     { enabled: false, sam3: { checkpoint }, order: [ ...ids ],
                  blocks: { face: {...}, eye: {...}, [custom_id]: {...} } } }
                                                  // NO save block -- that's the Preview node's state
```

**Reversed 2026-07-28: `latent` and `loras` are DELETED from this tree** (§3's reversal —
`use_internal_loaders`'s inline mode was their only consumer, and that mode no longer exists).
Resources — MODEL/CLIP/VAE, LoRAs already baked in, and the starting LATENT — now arrive
exclusively through `AnimaContextBridge`'s `ANIMA_CONTEXT` (§3); an unwired `latent` falls back to
a fixed default size in `pipeline.py` itself, not to a settings block. A hand-edited payload that
still sets either key isn't rejected (unknown keys always pass through, per this section's own
tolerant/additive contract below) — it's simply inert data nothing reads anymore.

The Preview node keeps its **own** settings blob, same hidden-serialized-STRING pattern:

```
{ schema, version,
  compare: { enabled: true,  a: "base", b: "final" },
  save:    { enabled: false,                 // OFF -- reversed 2026-07-29, §7a
             which: "shown", extension: "png",
             path: "AnimaFlow", filename: "%date:yyyy-MM-dd%_%seed%_%stage%",
             embed_workflow: true } }
```

(`save.enabled` and `save.which` above are the shipped values —
`src/anima/preview_settings.DEFAULT_PREVIEW_SETTINGS` and its `js/anima/state.mjs` twin, with
`js/anima/fixture_default_preview_settings.json` pinning them in the JS suite. An earlier revision of
this block showed `enabled: true, which: "every wired input"`; both were stale. There is **no**
`ui_expanded` key in either fixture-tested defaults tree — see §12.)

`shift = 3.0` is Anima's recommended default and is always applied
(`ModelSamplingAuraFlow.patch_aura`, `aio/model_preparation.py:60-77`) — a core ComfyUI node, not
a dependency.

**Normalization must be tolerant and additive**: unknown keys pass through, missing keys take
defaults, and a stage block absent entirely means "defaults, disabled". Same contract as
`nodes/controls/_rows_helpers.py`'s `parse_state`, which is why `renamed` round-trips there with
zero Python changes. Version bumps migrate forward, never reject.

---

## 9. Three divergences the old port had — do not reintroduce

From `BACKLOG.md` §1a. All three were in files that no longer exist; recover the fixes from
`45e7691` / `7ca9a1c` rather than assuming anything current has them.

1. **`guide_size_for` must be `False`.** The old port shipped `True`; upstream ships `False` for
   both detailer targets (`generation_defaults.py:306`, `:372`). It decides whether Impact
   measures `guide_size` against the tight bbox or the padded crop — the same `guide_size`
   resampled at a different scale.
2. **`noise_mask_feather` must not be `0`.** Upstream ships `10` (face, `:321`) / `20` (eye,
   `:387`); the old port shipped `0`. It feathers the noise mask inside the detail crop and is
   the main control against visible detailer seams. Upstream never ships `0`. Our single generic
   pass takes the conservative `10`.
3. **Saved images must carry workflow + prompt metadata.** The old port declared no hidden
   `PROMPT` / `EXTRA_PNGINFO`, making its saves *worse than stock `SaveImage`* — dragging a saved
   PNG back into ComfyUI restored nothing. **Never fixed.** Declaring the two hidden inputs and
   passing them through is the whole fix, and it is also why we don't need Image-Saver. **They belong
   on the Preview node**, since that is where saving lives now (§2, §7a) — putting them on the
   Generator would be declaring them where nothing writes a file.

---

## 10. Repo rules this touches

- **The JS budget goes 4 → 5.** One `js/anima/index.js` covers *all three* of this track's node
  classes and lazily imports the per-node `.mjs`, so three nodes cost one auto-loaded file — the same
  trick `js/controls/index.js` uses. (Written when the track was two nodes; the Bridge, added by §3's
  reversal, is patched in the same file for socket self-healing and cost no sixth `.js`.) `5` is the
  ceiling, and `.claude/CLAUDE.md` carries the count.
- **`THIRD_PARTY_NOTICES.md`** already credits EasyUseAnima (MIT © n0va39) at §1. Confirm the
  entry covers the generator port specifically when the first file lands — the existing text was
  written for the deleted line.
- **`EXPERIMENTAL = True`** on both node classes while the pack is Beta, per the theme skill.
- **Picker category** — no skill update needed: `Anima` is already one of the theme skill's four
  topics. (That skill does still need its `Controls` entry corrected and its stale
  `js/anima_prompt/...` paths fixed — unrelated, tracked in `BACKLOG.md` §3.)
- **`../ComfyUI-MyOriginalWaifu` is GPL-3.0** — concept only, clean-room, never copy. That
  boundary is what keeps this pack MIT.

---

## 11. Tests

Plain-script, no pytest (`python tests/test_x.py` from repo root, each file carrying the
`sys.path` shim).

- **Settings normalization**: unknown keys survive, missing keys default, absent stage blocks
  mean disabled-with-defaults, a version bump migrates forward.
- **Freeze the `required` key order** in a regression test, as the old
  `test_anima_generator_helpers.py` did — this is the append-only rule made enforceable.
  **Reversed 2026-07-28**: the Generator's own frozen order shrank from eight keys to two
  (`context`, `generation_settings`) — a documented EXCEPTION to append-only (removal, not
  insertion), not a violation of it; the test asserts the new two-key tuple, not the old one.
- **Context building** (`test_anima_context.py`, new 2026-07-28): which of `CONTEXT_FIELDS` are
  recorded as supplied vs. absent; a field supplied as `None` is distinguishable from one that was
  never supplied at all; hostile/garbage context objects fail closed rather than raising.
- **Stage labelling**: `resolve_stage_labels` (replaces the deleted `resolve_outputs` — 2026-07-28)
  — `base` is always present; `mid`/`final` are each present only when something actually changed
  the image, never duplicated as a pass-through; every combination of the four transform flags
  keeps `base` first; one enabled stage ⇒ one entry. Detailer gating itself
  (`detailer_is_live`) is unaffected by this reversal: every block off, or Impact absent, ⇒ inert,
  not an error.
- **Missing context fields**: `AnimaGenerator` given a context missing `model`/`clip`/`vae`/
  `positive`/`negative` raises a readable `ContextFieldMissing` naming the field and the bridge
  node, never an `AttributeError` mid-sample.
- **Soft imports**: Spectrum/USDU absent ⇒ that section disabled, generation otherwise
  unchanged. Test with the pack genuinely absent, and in a **subprocess** — a repo-root-on-
  `sys.path` shim masks exactly this class of bug (see the `comfyui-pack-import-structure` skill).
- **Postprocess fit maths** and **USDU tile planning** are pure functions; test them directly.
- **`inherit_sampler_settings` resolution** (§6b, unaffected by this task's reversal): with the flag
  on, a stage's `cfg`, `sampler_name` and `scheduler` come from the first pass while its `steps` and
  `denoise` never do. Assert both directions for all three stages, and assert the two *un*inherited
  fields explicitly — "inherit everything" is the intuitive reading and the wrong one.
- **Preview's `INPUT_IS_LIST` unwrapping** (2026-07-28): every declared input — including the
  hidden `prompt`/`extra_pnginfo` — arrives wrapped in a one-element list and must be unwrapped
  explicitly, EXCEPT `images` itself, which stays the real multi-item list; a run's position →
  stage-label mapping (`resolve_run_stage_labels`) prefers `metadata_json.stage_labels` and falls
  back to positional `base, mid, final` on anything hostile; a one-entry `images` list degrades to
  a single-image view, not a broken compare.
- **Save now** (2026-07-29, `tests/test_anima_api.py` + `tests/test_anima_preview_images.py`):
  `resolve_save_now_stage` picks `final` → `mid` → `base` and returns `None` — not a guess — on an
  empty stage set, which is the route's "nothing to save yet" case (`SaveNowError`); the resolved
  filename comes from the same `format_filename` an enabled save uses. On the JS side, the button is
  **absent** while `save.enabled` is true, and posts `{stages, preview_state}` while it's false.
- Frontend: `node js/anima/test_*.mjs` for the wipe geometry and settings round-trip. Mark
  what only a browser can confirm with `VERIFY-IN-COMFYUI:`. **The stale-suite gap this section
  used to flag is closed**: `js/anima/test_resize.mjs` now tests `resolveStageLabels` (the
  replacement for the deleted `resolveOutputs`'s pass-through rule) rather than the removed
  `image_a`/`image_b`/`image_c`/`use_internal_loaders` surface, and the checked-in
  `fixture_default_generation_settings.json` carries no `latent`/`loras` keys, agreeing with
  `src/anima/settings.DEFAULT_GENERATION_SETTINGS`. Nothing in the JS suite cross-checks against
  live Python at test time, though — that gap (fixture/mock-driven only) is a standing property
  of this suite, not specific to this reversal.

---

## 12. Open questions and deferred

**Open — needs a decision before building:**

- ~~Which Spectrum repo ships `AnimaModGuidance`~~ — **settled: `blepping/ComfyUI-Spectrum-KSampler`.**
  Upstream's *code* cites it twice (`aio/sampling.py:131`, `:257`); only its README says `sorryhyun`.
  The code wins — it is what actually runs.
- ~~one tabbed overlay or one dialog per stage~~ — **settled 2026-07-27: neither.** Settings were a
  **popover anchored to the row you clicked**, which is what the Control Panel already does
  (`openOverlayWithZoom(..., "below")`). It went modal → right-side drawer → row popover across three
  review passes: the modal covered the graph being tuned, and the drawer still put the controls far
  from the thing they belong to. The popover also deleted the "which stage am I editing" problem, so
  there was no tab strip. **Reuse the Control Panel's overlay helper**, including its viewport-flip
  logic — do not reimplement the anchoring.

  **Reversed 2026-07-28 (inline-sections dispatch) — the FOURTH iteration: the popover is gone too,
  settings expand IN PLACE.** Click a section's header (Sampler, Mod Guidance, Highres, Detailer,
  Upscale, Postprocess on the Generator; Save on the Preview) and its fields appear directly below
  it, inside the SAME scrolling `.wtn-an-panel` the header itself lives in; the panel scrolls, there
  is no second surface. Full history now: modal → right-side drawer → row-anchored popover →
  inline section. Why inline wins over the popover the row before it just settled on: an anchored
  popover is still a floating DOM subtree that has to be positioned relative to its anchor, flipped
  to the other side when it would overflow the viewport, and explicitly closed before the panel can
  safely rebuild underneath it (`js/anima/render.mjs`'s deleted "never rebuild the panel while a
  popover it doesn't own is open" rule) — an expand/collapse toggle inside ONE surface has none of
  that machinery to get right, and it is what the upstream reference implementation
  (`../ComfyUI-EasyUseAnima/web/js/aio/generator_panel_runtime.js`) actually does for its own
  always-on-panel fields (its `*_settings_dialog.js` siblings are real MODAL dialogs for a few
  advanced/rare controls, a different pattern this pack didn't adopt — everything routine stays
  inline here instead). "Reuse the Control Panel's overlay helper" was RETRACTED for `js/anima/` at
  this point — and **that retraction has since been un-done: as of 2026-07-29 the overlay is back in
  this track, for anchored MENUS only.** `js/anima/interaction.mjs:137` imports
  `openOverlayWithZoom` / `closeActiveOverlay` / `closeOverlayIfOwnedBy` /
  `closeOverlaysNotAncestorOf` / `activeOverlayRef` from `../shared/overlay.mjs` — the exact same five
  `js/controls/interaction.mjs` uses, sharing the SAME singleton bookkeeping rather than a second
  instance of it, so only one overlay is ever open across the page regardless of which track owns the
  click. What stayed dead is the popover as a *settings surface*: stage settings still expand inline,
  and the ⚙ menus / option lists that now use the overlay are the "hybrid essentials/⚙ dispatch" this
  module's top doc comment describes, not a return to the row popover. `js/shared/overlay.mjs` is
  therefore also no longer "untouched" — see the 2026-07-29 amendment below, which rewrote its
  single-slot core into a stack. A section's expand/collapse state
  persists in the settings blob itself, under a UI-only `ui_expanded` key kept OUT of the two
  fixture-tested defaults trees (`js/anima/state.mjs`'s own top doc comment) — so a workflow reopens
  with the same sections expanded it was saved with, same as any other setting. A context-supplied
  sampler field (§5a) is now a genuinely DISABLED control (not a separate "driven" text row) with a
  yellow ⓘ beside it, and that same ⓘ affordance replaces every explanatory text block the popover
  bodies used to carry (e.g. the "shift 3.0 is Anima's recommended default" note) — one consistent
  hover-for-more-detail glyph instead of prose eating vertical space in a surface that now has to fit
  everything at once.

  **Amended later the same day, from live use — the switch owns expand/collapse, and the header
  never jumps.** Three corrections to the paragraph above, all from actually clicking it:
    - **The header row is no longer a click target.** For a section that HAS an enable switch, the
      switch is the only control: flipping it on enables the stage *and* expands it; flipping it off
      disables and collapses. Clicking anywhere else on the header does nothing. Consequence, and
      accepted: an enabled section can't be collapsed while it stays enabled. **A switchless section
      (Sampler) keeps the header-click toggle** — it has no switch to drive it, so without that its
      body would be unreachable.
    - **Header child order is fixed: chevron → switch → label → ⓘ → summary.** Everything but the
      summary is `flex: none`, pinned left; the summary alone takes `margin-left: auto` and
      ellipsizes into the space on the right. The old order (chevron → label → summary → ⓘ → switch)
      let the ⓘ *and* the switch slide horizontally by however long the summary happened to be, so
      the row visibly jittered every time a stage was toggled. Only the summary's width may vary.
    - **The ⓘ is a real tooltip now, not the native `title` attribute** — `title` gave the browser's
      own ~1s delay, which nothing can tune. It's the house `.wtn-tip` component, shown after
      `INFO_TIP_DELAY_MS` (250ms), mounted on `document.body` so a panel with `overflow: hidden`
      (§7's Preview) can't clip it, viewport-clamped, and torn down by `hideActiveInfoTip()` on every
      repaint so a rebuilt body can't orphan one. It carries the `wtn` class itself and its rule is
      two-class (`.wtn-tip.wtn-fld-tip`) — a `document.body`-mounted element sits outside every
      `.wtn` subtree, so without both it loses the theme's custom properties to `theme.css`'s own
      fallback-free `.wtn-tip` rule and renders unstyled.

  **Wheel handling got a quiet period at the same time** (`js/shared/canvas_zoom.mjs`, so
  `js/controls/` benefits too): reaching either end of a scrollable region used to hand the *same
  continuing* gesture straight to the canvas, which suddenly zoomed the graph mid-scroll. A wheel
  event consumed by an internal scroll region now arms a per-node lock, and an unconsumed one inside
  `WHEEL_LOCK_MS` (450) is dropped rather than dispatched — the canvas only starts zooming again once
  wheeling has actually stopped for that long.

  **Amended again 2026-07-29 (`cec90cd`), all three from live use.** These are corrections to the
  dispatch above, not a fifth iteration of it — the inline-sections shape is unchanged:
    - **A bool row's switch IS its state; the on/off word is gone and the switch is right-aligned.**
      The word was a second rendering of one value, and `buildBoolFieldInto` updated only the word,
      never the switch's `wtn-fld-on` class — so the switch looked frozen while the word changed. Two
      fixes, deliberately both: `buildBoolField` now returns a `setValue` that owns *both* halves
      (this was the **third** "the component doesn't own its state" bug on this track, after `getValue`
      capturing a snapshot and the stepper's `spec.value` — hence fixing it in the shared builder
      rather than at the call site), and deleting the word removes the element that could desync at
      all. The switch sits right via `.wtn-an-boolfield .wtn-fld-switch { margin-left: auto; }`
      (`js/shared/fields.mjs`). **Where the word carried real information it moved into that row's ⓘ**
      — the inherit row's "on · cfg/sampler/scheduler from the first pass" (§6b) is the case that
      mattered — and a row's ⓘ now sits **next to its label**, not at the row's end. (Distinct from
      the section-*header* order frozen above; this is the field row.)
    - **`js/shared/overlay.mjs` keeps a real STACK, so a ⚙ menu survives opening a stepper inside
      it.** It had ONE active-overlay slot, so opening a nested option list closed its own parent —
      which detached the anchor, so `getBoundingClientRect()` returned zeros and the list positioned
      at the screen's top-left. The contract now: **a child never closes its parent; closing a parent
      closes everything nested inside it; outside-click and Escape reach only the innermost.**
      `activeOverlayRef.current` is kept as a get/set *property* precisely so the existing call sites
      that write it directly keep working against the stack unchanged. `js/controls/` only ever opens
      one level, so it is unaffected — a stack of depth one behaves exactly like the old single slot,
      which is what let that track's suite stay green at 164/164 with no edits.
    - **Field labels are human, via a display-name map with a documented prettify fallback**
      (`js/anima/state.mjs`'s `fieldLabel`, next to the settings tree). Rows read `Mode`, not
      `mode_type` / `auto_tile_target` / `force_uniform_tiles`. **Display only — the settings PATH is
      untouched**, and there is a test asserting exactly that, because a label map that quietly
      became a key map would corrupt saved blobs. Single-word keys were deliberately left out of the
      map rather than churning dozens of already-fine labels; the fallback means a newly added field
      is never *worse* than it is today.

  **Amended a third time, later on 2026-07-29 (owner, live review) — the card border now carries the
  whole nesting signal, and affordances must not lie.**
    - **The section body's left indent is gone.** `.wtn-an-sbody` was `padding: 3px 5px 10px 23px`, and
      that `23px` was deliberate — its comment read "indented under the chevron so the nesting still
      reads clearly while the panel scrolls." **Reversed:** once the body became a real bordered card
      attached to its header, the border communicates the nesting on its own, so the indent was
      redundant and merely ate horizontal width. Left padding now matches the other sides (`5px`), and
      field rows align with the card's own edge.
    - **Card borders carry NO accent at rest** — see the border's own three-round history in
      `render.mjs` (full accent → `rgba(45,212,191,.35)` → plain `--wtn-line-soft`, identical
      collapsed and expanded). Enabled/expanded is cued by the chevron, the switch, and the body simply
      being visible.
    - **Field rows are dark; the OLD look now means disabled.** The `.wtn-fld-num`/`-stepper`/`-seed`
      rows painted `--wtn-surface-2` — *the same colour as the card containing them* — so a field read
      as a flat label rather than something you type into. They now paint `--wtn-console` (`#0a0d12`),
      matching what the Control Panel has always used for its own inputs, and the three
      `.wtn-fld-disabled` variants took over `--wtn-surface-2`. The swap is the point: an editable field
      should read as an inset well, a disabled one should recede into its card. `docs/THEME.md`'s token
      table was corrected to match (`--wtn-surface-2` had been described as "inputs' chrome").
      **This lives in `js/shared/fields.mjs` but affects the Anima track ONLY** — `js/controls/` does
      not import that module (verified 2026-07-29; it takes only `field_logic.mjs`'s pure maths from
      `shared/`), so the two tracks still carry duplicate field implementations.
    - **The hover tint and `cursor: pointer` apply ONLY to headers that are genuinely click targets**,
      via a `wtn-an-clickable` marker class added *at the same site the click listener is attached* —
      that co-location is the invariant, so the two can't drift. Clickable: a **switchless** section
      (Sampler, whose header-click is its only way to expand) and the **Save row** (its row-click opens
      the ⚙ menu by design — "the gear is the discoverable affordance; the row-click is the forgiving
      one"). Not clickable, therefore no tint and no pointer: every **switch-bearing** section, whose
      header stopped being a click target in the first 2026-07-29 amendment above, and the **Compare
      card**, which has no header listener at all.
      > ⚠️ **Keep the hover selector at `0-2-0` and BEFORE the `.wtn-an-expanded` rule.** Both are
      > `0-2-0` and the expanded rule wins purely on **source order** — that is what stops an expanded
      > header tinting on hover. Writing `.wtn-an-shead.wtn-an-clickable:hover` (`0-3-0`) would beat it
      > and silently reintroduce the tint. There is a test asserting the single-class form and the
      > ordering; do not weaken it.
- Nothing left on the detailer: `MAX_DETAILER_PASSES = 4` and internal-detection-with-`SEGS`-override
  are both settled (§6a).

**Deferred, deliberately:**

- Safe PAG as an experiment (§4).
- KJNodes optimizations as one additive section (§4).
- A highres-specific fourth image output (§5).
- img2img / inpaint modes. Upstream's own stages assert `mode == "txt2img"`
  (`aio/generation_highres.py:57-60`); ours ships txt2img only.
- Generation profiles (upstream's Normal/Turbo/Optimized snapshots). Useful, but they only earn
  their keep once the settings tree is stable.

**`js/anima/` has since shipped** — one auto-loaded `index.js` and lazy
`render.mjs`/`interaction.mjs`/`state.mjs`, built against the mockup with §7's body-order
reversal and §12's inline-sections dispatch (the "row/popover UI" this note used to call the
missing piece is superseded by that dispatch — settings are not a popover here; §12's 2026-07-29
correction covers the anchored menus that do use the overlay). That one file patches **three** node
classes, not two: `AnimaGenerator` and `AnimaPreview` in full, plus `AnimaContextBridge` for **socket
self-healing only** — the Bridge has no DOM UI of its own, but it needs `onConnectionsChange`
forwarding so every downstream Generator repaints its context-supplied badges (§5a-0's mechanism 1).
Current work on the frontend is narrower and dated at the point it lands: see §8's
`seed_after_generate` / seed-row-shape note and §12's 2026-07-29 amendment.
