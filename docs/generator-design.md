# Generator + Preview — design

**Status: specified, awaiting mockup sign-off** (design decisions taken 2026-07-27). No node code
exists yet. Interactive mockup: [`playground/generator.html`](../playground/generator.html) — it
is the behavioural reference and the approval gate. Opens the third track, after the Rule Builder
line and the Controls line. Read alongside
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
  (`aio/generation_defaults.py:163-168`, `:207-212`). Highres and upscale each get their own
  `steps`/`cfg`/`sampler_name`/`scheduler`, and inherit the first pass unless told otherwise.
- **The upstream stage defaults**, verbatim where we ship the stage at all — they are tuned and
  we have no better numbers. See §9 for the three the old port got wrong.
- **The hover-wipe compare** (`web/js/aio/generator_panel_runtime.js:788-829`) — two absolutely
  positioned layers plus a divider, driven by one CSS var from cursor position. See §7.
- **Per-block detection via `detect_prompt`** — `SAM3_Detect` → `MaskToSEGS` → `DetailerForEach`
  (`easyuse_anima/image/sam3.py:46-121`). `SAM3_Detect` is a ComfyUI built-in, so this costs no
  dependency beyond the Impact that `DetailerForEach` already requires. See §6a.

**Deliberately NOT copied:**

- **The `EASY_USE_ANIMA_INPUT` context socket** (`nodes/aio_nodes.py:67-126`). Upstream bundles
  prompt data + resource *names* into a custom dict socket, then loads MODEL/CLIP/VAE inside
  the generator. Plain `MODEL`/`CLIP`/`VAE` sockets are better: they compose with every other
  node in ComfyUI, including our own Loader Panel. See §3.
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
| Does | runs the pipeline | compares two images |
| Emits | `IMAGE ×3`, `LATENT`, `STRING` | nothing (terminal) |
| Cost when unused | — | zero; it isn't in the graph |

**Why the preview is not a live feed.** Upstream streams stage images over a websocket event
(`easyuse-anima-aio-preview`, `aio/preview.py:15-27`) keyed by `unique_id`. A separate node
cannot receive those over a wire mid-execution, so a live split would have to couple the two
nodes through the event bus and an id handshake. Decided against: **stage images arrive as
ordinary IMAGE outputs at the end of the run.** No event bus, no id linkage, and the Preview
node becomes a plain node that happens to draw two images. The cost is that you don't watch it
progress — accepted deliberately.

---

## 3. Resources — sockets, or the internal loaders, by flag

The Generator takes `MODEL` / `CLIP` / `VAE` as **`optional`** sockets, plus a
`use_internal_loaders` boolean. On → the node's own `unet_name`/`clip_name`/`clip_type`/`vae_name`
pickers are used and the sockets are ignored. Off → the sockets are used and the pickers hide.

Three constraints, each load-bearing:

- **The sockets must be `optional`, never `required`.** ComfyUI validates required inputs before
  the node's code runs, so a required `MODEL` would hard-fail the queue whenever the flag is on
  and nothing is wired. Optional sockets + a runtime check that raises a readable error
  (`use_internal_loaders is off but no MODEL is connected`) is the only shape that works.
- **The pickers hide in JS but keep serializing** — the same hidden-for-rendering-only treatment
  `panel_state` gets (`js/controls/index.js`'s `hideStateWidget`, and the frontend skill's
  "hide a declared widget that must still serialize"). Never `serialize = false`. Toggling the
  flag back and forth must not lose your picks.
- **Widget order is append-only** (`BACKLOG.md` §4). The flag and the four pickers go at the end
  of `required` and never move. This already bit the pack once in `42336c0`.

`clip_type` defaults to `qwen_image` — the pickers exist to serve Anima
(`nodes/aio_nodes.py:113`). Everything else in the pack stays format-agnostic per
`.claude/CLAUDE.md`; this one default is about which *loader* Anima needs, not about prompt
format.

LoRAs split the same way, but not via a stack socket: externally they arrive already baked into
`MODEL`/`CLIP` by Pixaroma's loader; inline mode gets its own LoRA list because there is no wire for
that node to sit on (§5b).

**Overlap with the Loader Panel is intentional, not redundant.** `AnimaLoaderPanel` already is
a unet/vae/clip picker with real `MODEL`/`VAE`/`CLIP` outputs, and wiring it in is the better
setup — it caches separately, so a seed bump doesn't reload the UNET. The internal pickers exist
for the one-node case: a scratch graph where a second node isn't worth it.

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

Grouped as the node body groups them — **resources**, **sampler**, **detailer passes** — because a
socket's neighbours are how a user works out what it is for. (An earlier draft filed `latent` and
`lora_stack` under a "detail targets" heading with the `SEGS` inputs, which made all three unreadable.)

| | Name | Type | Notes |
|---|---|---|---|
| required | `positive` | `CONDITIONING` | |
| required | `negative` | `CONDITIONING` | |
| required | `generation_settings` | `STRING` | hidden-for-rendering, natively serialized; the whole settings tree |
| required | `use_internal_loaders` | `BOOLEAN` | §3 |
| required | `unet_name` / `clip_name` / `clip_type` / `vae_name` | combo | §3; hidden when the flag is off |
| optional | `model` / `clip` / `vae` | `MODEL`/`CLIP`/`VAE` | §3 |
| optional | `lora_stack` | `LORA_STACK` | secondary path only — Pixaroma's loader patches `MODEL`/`CLIP` instead. Ignored in inline mode. §5b |
| optional | `latent` | `LATENT` | size and batch; else from `settings.latent` |
| optional | `seed` / `steps` / `cfg` | `INT`/`INT`/`FLOAT` | §5a — wired wins, per field |
| optional | `sampler_name` / `scheduler` | `COMBO` | §5a |
| optional | `segs_1` … `segs_N` | `SEGS` | one per detailer block, revealed as blocks are added. **Override** — wired replaces that block's internal detection (§6a) |
| hidden | `prompt` / `extra_pnginfo` / `unique_id` | `PROMPT`/`EXTRA_PNGINFO`/`UNIQUE_ID` | §9 — non-negotiable |

Prompt text is **not** an input. Conditioning comes in already encoded, so prompt editing stays
upstream in the Rule Builder / Prompt Studio line. Upstream made the same call and it is right.

### 5a. Sampler values — five sockets, wired wins, no flag

`seed`, `steps`, `cfg`, `sampler_name` and `scheduler` are each an `optional` socket. **If a socket
is wired the wire drives that field; if it isn't, the `generation_settings.sampler` value is used.**
Per field, independently — no `use_internal_sampler` flag.

Deliberately *not* the loaders' flag pattern, and the difference is justified: the five are
independent, and the realistic setup wires only `seed` from a Control Panel row while steps and cfg
stay internal. A global flag forces all-or-nothing on values that have no reason to move together.
The loaders keep their flag because `MODEL`/`CLIP`/`VAE` genuinely do travel together — they are one
decision about which checkpoint you are running.

**The overlay must show a wired field as driven by the wire**, not as an editable number that is
silently ignored. That is the whole risk of wired-wins: two plausible sources and no indication of
which is live. The socket's connected state is the single source of truth for that badge.

`sampler_name` / `scheduler` arrive as **`COMBO`** — settled and verified live on 2026-07-27
(`control-panel-design.md` §5): a Control Panel combo row sets `output.type = "COMBO"` and wires to a
KSampler correctly. So the panel can drive all five, not just the numerics.

> **Legacy-litegraph caveat, inherited from the Control Panel** (`control-panel-design.md` §5): on
> the target renderer a plain declared widget is a canvas widget, not a socket. Declaring these five
> as socket-only `optional` inputs (`forceInput`) sidesteps the "right-click → Convert widget to
> input" dance entirely — their internal counterparts live in the settings JSON, not as widgets, so
> there is nothing to convert and no widget-order exposure (`BACKLOG.md` §4).

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

**So the primary LoRA path needs nothing from us.** The LoRAs are already baked into `MODEL`/`CLIP`
before this node ever sees them:

```
Loader Panel ──MODEL──> Pixaroma LoRA Loader ──MODEL──────────> Generator.model
             ──CLIP───>                       ──CLIP──> Text Encode ──COND──> Generator.positive
                                              ──triggers──> (into your prompt text)
```

> **The subtle part, and it fails silently.** Route the **patched** `CLIP` onward to your text encode,
> not the Loader Panel's raw one. Wire the raw `CLIP` to the encoder and the LoRA's *model* effect
> still lands (via `MODEL`) while its *CLIP* effect vanishes — no error, just a weaker result and
> trigger words that read differently than intended. That is exactly why their node takes `CLIP` at
> all, and why it sits **before** the text encode rather than just before the generator.

**`lora_stack` stays as an optional socket, demoted.** Pixaroma's path doesn't use it, but
`LORA_STACK` is a real cross-pack interchange type (efficiency-nodes, rgthree, Impact all emit one),
and an unused optional socket costs nothing. It is the secondary path, not the documented one.

**The inline list is the one case we must handle ourselves** — and this is now its whole
justification. With `use_internal_loaders` **on**, the node loads its own unet/clip internally, so
there is no `MODEL`/`CLIP` wire for Pixaroma's node to sit on and no way to get LoRAs in from
outside. Hence: inline mode gets an inline LoRA list, and it is the only mode that needs one.

- Stored in `generation_settings.loras` as an ordered array of
  `{name, strength_model, strength_clip}`. **Order is application order**, matching how their node
  applies rows.
- **Uncapped** — settings-blob entries, not sockets, so they cost no slots. (Contrast
  `MAX_DETAILER_PASSES`, capped precisely because each pass *is* a socket.)
- Editor is a LoRA tab in the overlay, present only while inline mode is on.
- Both strengths `0` ⇒ skipped when building, per upstream Anima
  (`aio/model_preparation.py:236`). The entry stays, muted rather than deleted.

Port upstream's `_normalize_aio_lora_stack` (`aio/model_preparation.py:164-199`) for the inline list
*and* the demoted socket. It is deliberately promiscuous about shape — `{"__value__": …}` envelopes,
JSON strings, `dict` items under several key spellings (`name`/`lora`/`lora_name`,
`strength_model`/`model_strength`/`strength`, `strength_clip`/`clip_strength`/`strengthTwo`),
`list`/`tuple` items — and drops entries named empty or `"none"`. **Widen one case:** it requires
`len(item) >= 3`, so a producer emitting 2-tuples `(name, strength)` has every entry *silently
dropped*. Accept `len >= 2`, defaulting `strength_clip` to `strength_model`.

#### Two things in their node we deliberately don't copy

- **Its state handshake.** `LoraLoaderState` is declared in **`hidden` `INPUT_TYPES`**
  (`node_lora_loader.py:48`) and injected at `graphToPrompt` time. This pack forbids that pattern —
  `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` §2 records it delivering the default `"{}"`
  to a backend in a real deployment while the on-node preview looked correct. Same rule as
  `control-panel-design.md` §1: a declared, natively-serialized STRING widget, hidden for rendering
  only.
- **Its zero-strength semantics.** They keep a zeroed row's trigger words (`apply()`: "the user
  turned it on on purpose"). Upstream Anima skips zeroed entries outright. We follow **upstream
  Anima** — we have no trigger-word output for a zeroed LoRA to contribute to, so keeping it would
  mean applying nothing and claiming something.

### Outputs

| Name | Type | Content |
|---|---|---|
| `image` | `IMAGE` | final, after every enabled stage |
| `image_base` | `IMAGE` | first-pass output — **before highres too** |
| `image_mid` | `IMAGE` | after detailer, before upscale |
| `latent` | `LATENT` | final latent |
| `metadata_json` | `STRING` | per-stage metadata for debugging |

**Fixed set, not dynamic-per-enabled-stage.** Dynamic outputs break wires whenever a stage is
toggled. Unwired outputs cost nothing — the pipeline already computed those tensors.

**Highres has no socket of its own**, absorbed into the base→mid span. If highres-specific A/B
is ever wanted that is a fourth output, appended.

**A disabled stage's output passes through the previous stage's image.** A dead socket mid-chain
is worse than a duplicate image when the entire point is comparison. This must be documented on
the node — `image_mid == image_base` is a legitimate result meaning "no detailer ran", not a bug.

`OUTPUT_NODE = True` (it saves), which also means it runs without anything wired downstream.

---

## 6. Stages

Order is upstream's (`aio/generation_pipeline.py:10-17`), each stage independently enabled.

1. **First pass** — Mod Guidance patch (if enabled and Spectrum present) → `KSampler` → VAE
   decode. Size from the `latent` socket if wired, else `settings.latent`.
2. **Highres** — latent upscale by `scale_by` (default 1.5), resample, re-sample at
   `denoise` 0.25. Inherits the first-pass sampler unless `inherit_sampler_settings` is off.
3. **Detailer** — **N blocks, each detecting for itself.** Per block:
   `SAM3_Detect` (built-in, driven by the block's `detect_prompt`) → `MaskToSEGS` →
   `DetailerForEach`, or, when that block's `segs_N` socket is wired, straight to `DetailerForEach`
   with your regions. Defaults from upstream's **face** block, the conservative one
   (`generation_defaults.py:292-357`). Requires Impact. See §6a.

### 6a. Detailer — internal detection, with a `SEGS` override

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

**And a `segs_N` socket per block that overrides it when wired.** Same shape as the resources flag
(§3) and the sampler fields (§5a) — internal by default, wire to override — which is now the house
pattern for this node three times over. Wire Impact's Ultralytics bbox detectors, a custom SAM
chain, or a hand-built mask, and that block uses your regions and skips `SAM3_Detect` entirely.
Unwired blocks detect for themselves. That is strictly more capable than either design alone, for
one branch per block.

Per-block settings matter and must not be collapsed: upstream ships `noise_mask_feather` **10 for
face, 20 for eye** (`:321`, `:387`), and different `denoise` per target. That difference is the
entire argument for blocks over one global pass.

**`MAX_DETAILER_PASSES = 4`** (settled 2026-07-27). Upstream is effectively uncapped, but every pass
is a full re-sample. May grow later, never shrink. The dynamic-socket half reuses the Control Panel's
mechanism — declare a fixed maximum and reveal only as many as there are blocks
(`control-panel-design.md` §1, §5); see the frontend skill's `ContainsAnyDict` note for the backend
half.

4. **Upscale** — USDU only, with seam-fix and tile controls exposed (upstream's `seam_fix_mode`
   was hardcoded to `"None"` in the old port, making seam repair unreachable; `29ac56d` fixed
   that and the work is recoverable from git). `mode_type` (Linear/Chess/None) is tile **order**;
   `tiled_decode` is an unrelated VAE flag — do not conflate them.
5. **Postprocess** — the output size cap (`max_long_edge` / `max_megapixels`,
   `aio/postprocess.py:42-86`). The old port only ever rounded *up*, leaving final size
   unbounded. This is the fix.
6. **Save** — stock `SaveImage`, plus the hidden inputs from §9.

### First-pass cache — the biggest workflow win

Upstream keys a small LRU on resources + file revisions + prompt data + sampler + patches + size
(`aio/first_pass_cache.py`: 2 entries, 512 MB, 300 s TTL). It means tweaking only
highres/detailer/upscale **skips re-sampling the base** — which is exactly the loop the three
image outputs are for. Never built in the old port. Build it here; the three-output compare
design makes it more valuable than it was upstream.

---

## 7. The Preview node

Terminal node, `AnimaFlow/Anima`, one DOM widget.

- **Two IMAGE inputs** (`image_a`, `image_b`), both `optional`, plus an optional third so all
  three generator outputs can be wired at once and any two chosen.
- **A picker for which two to compare.** Default `base` vs `final` — the comparison actually
  wanted most of the time.
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

Sizing follows the DOM-widget mechanism the pack already uses (rAF-timed
`measureContentHeight`, width-passthrough `setSize`, grow-biased `refitNode`; legacy
`computeSize`/`getHeight` with `computeLayoutSize` kept only for Nodes 2.0 forward-compat).
**Target renderer is legacy litegraph** — the legacy path must work standalone.

---

## 8. State shape

`generation_settings`, one versioned JSON object in a declared STRING widget, hidden for
rendering only. Trimmed from upstream's tree (`aio/generation_defaults.py:39-455`) to the stages
we ship:

```
{ schema, version,
  sampler:      { seed, seed_after_generate, steps: 32, cfg: 5.0,
                  sampler_name: "er_sde", scheduler: "simple", denoise: 1.0, shift: 3.0 },
  mod_guidance: { mode, profile, quality_tags, quality_neg, mod_w, mod_start_layer,
                  mod_end_layer, ... },
  latent:       { width, height, batch },
  loras:        [ { name, strength_model, strength_clip } ],   // inline mode only; order = apply order
  highres:      { enabled: false, scale_by: 1.5, upscale_method, multiple, max_long_edge,
                  steps: 20, inherit_sampler_settings: true, cfg, sampler_name, scheduler,
                  denoise: 0.25 },
  detailer:     { enabled: false, ...upstream face defaults },
  upscale:      { enabled: false, scale_by: 2.0, steps: 20, inherit_sampler_settings: true,
                  cfg, sampler_name, scheduler, denoise: 0.2, usdu: {...} },
  postprocess:  { enabled: false, fit: { mode, max_long_edge: 2048, max_megapixels: 4.0, method } },
  save:         { enabled: true, filename, path, extension },
  preview:      { compare_enabled: true, compare_a: "base", compare_b: "final" } }
```

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
`e1080e4` / `29ac56d` rather than assuming anything current has them.

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
   passing them through is the whole fix, and it is also why we don't need Image-Saver.

---

## 10. Repo rules this touches

- **The JS budget goes 4 → 5.** One `js/anima/index.js` registers *both* node classes and
  lazily imports their per-node `.mjs`, so two nodes cost one auto-loaded file — the same trick
  `js/controls/index.js` uses. Update the count and the reason in `.claude/CLAUDE.md` when built.
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
- **Stage gating**: each stage disabled ⇒ its output passes the previous image through; detailer
  with no `segs` ⇒ inert, not an error.
- **Resource resolution**: flag on ⇒ pickers win and sockets are ignored; flag off with no
  `MODEL` ⇒ a readable error, not an `AttributeError` mid-sample.
- **Soft imports**: Spectrum/USDU absent ⇒ that section disabled, generation otherwise
  unchanged. Test with the pack genuinely absent, and in a **subprocess** — a repo-root-on-
  `sys.path` shim masks exactly this class of bug (see the `comfyui-pack-import-structure` skill).
- **Postprocess fit maths** and **USDU tile planning** are pure functions; test them directly.
- Frontend: `node js/anima/test_*.mjs` for the wipe geometry and settings round-trip. Mark
  what only a browser can confirm with `VERIFY-IN-COMFYUI:`.

---

## 12. Open questions and deferred

**Open — needs a decision before building:**

- Which Spectrum repo actually ships `AnimaModGuidance` (§4).
- Whether the popup settings dialogs are one tabbed overlay or one per stage. Upstream ships
  one dialog per stage (`web/js/aio/{sampler,detailer,save,postprocess,stage}_settings_dialog.js`)
  — ~130k of JS across them, which is a lot to lazily import. **The mockup implements the single
  tabbed overlay**, with a lit dot per enabled stage on the tab strip so "what's on" is readable
  without opening anything. Confirm from the mockup.
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

**Next step:** an interactive mockup at `playground/generator.html`, the way
`playground/control-panel.html` preceded the Controls build. The mockup is the approval gate —
no `nodes/anima/` or `js/anima/` code before it is signed off.
