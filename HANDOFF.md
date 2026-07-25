# Anima node-pack build — handoff / continuation notes

This file exists because the repo was renamed mid-build (`webtoon-generator` →
`ComfyUI-AnimaFlow`), which orphaned the previous Claude Code session's
`builder`/`reviewer` subagent registry (resolved from the old path at session
start). Once a new session starts in **this** folder
(`/Users/igorsokolovsky/Desktop/private/comfyui/ComfyUI-AnimaFlow`), those
subagent types will resolve correctly again (their definitions already live
at `.claude/agents/builder.md` / `.claude/agents/reviewer.md` here).

**Delete this file once Phase 4 ships** — it's a one-time handoff note, not
ongoing project documentation.

## Where the full plan lives

`/Users/igorsokolovsky/.claude/plans/frolicking-doodling-hummingbird.md` —
this path is OUTSIDE the repo and unaffected by the rename. Read it in full
before doing anything else; it has the complete Context, explicitly-out-of-
scope list, the tooltip requirement, the full node table, and all 4 phases.
It already contains a "Naming update (mid-build)" note recording the
AnimaFlow rename (repo folder, `CATEGORY = "AnimaFlow/anima"` for every new
node, JS `/extensions/ComfyUI-AnimaFlow/...` import paths).

## Status: Phase 1 ✅ + Phase 2 ✅ done and reviewed-passing. Phase 3/4 not started.

### Phase 1 — Autocomplete: DONE, reviewed PASS
`autocomplete/` package (Gelbooru-primary/Danbooru-fallback CSVs, tiered
search, aiohttp route at `/wtn/autocomplete`) + `js/autocomplete/` (generic
attach-to-any-textarea popup). No node — cross-cutting service.

### Phase 2 — AnimaGenerator + AnimaPreview + utilities: DONE, reviewed PASS (3 builder sub-calls)
All registered in root `__init__.py`, all `CATEGORY = "AnimaFlow/anima"`:
- **`AnimaImageScaleByMultiple`** (`nodes/node_anima_image_scale.py` +
  `nodes/_anima_image_scale_helpers.py`) — exposes
  `compute_scale_by_multiple(width, height, multiple, max_long_edge=0) ->
  (new_width, new_height, scale_factor)`, pure, no torch import. Reused by
  the Generator's highres AND postprocess-resize stages.
- **`AnimaDetailerAlignHook`** (`nodes/node_anima_detailer_hook.py` +
  `nodes/_anima_detailer_hook_helpers.py`) — duck-typed Impact-Pack
  `DETAILER_HOOK`, no hard Impact Pack import.
- **`AnimaPreview`** (`nodes/node_anima_preview.py` +
  `nodes/_anima_preview_channel.py` + `js/anima_preview/`) — display-only
  node (`RETURN_TYPES=()`, `OUTPUT_NODE=True`). Shared helper:
  `broadcast_preview(channel: str, image, stage_label: str) -> bool`, never
  raises, safe to call repeatedly mid-pipeline.
- **`AnimaGenerator`** (`nodes/node_anima_generator.py` +
  `nodes/_anima_generator_helpers.py`) — the full decoupled pipeline: plain
  `MODEL`/`VAE`/optional `CLIP`/`CONDITIONING`×2/`STRING`×2 (positive_text/
  negative_text)/`LATENT`/`LORA_STACK` in →
  first-pass → highres → detailer (optional, soft Impact Pack via SEGS +
  optional `detailer_hook`) → upscale (optional, soft USDU or ResShift,
  user's choice) → postprocess-resize (optional) → save (optional, off by
  default) → `(IMAGE, LATENT, STRING metadata)` out. Broadcasts each stage's
  frame via `broadcast_preview` on the `preview_channel` field — does not
  render its own UI.
- **`nodes/_comfy_core_bridge.py`** — `require_core_node_class(node_id)` /
  `find_core_node_class(node_id)`: looks up ComfyUI's OWN core node classes
  (`KSampler`, `CLIPTextEncode`, `EmptyLatentImage`, `VAEEncode`,
  `VAEDecode`, `LoraLoader`, `SaveImage`, `UpscaleModelLoader`) via a bare
  `import nodes` — **verified safe** by a rigorous review (sandbox-simulated
  ComfyUI's real custom-node loader; this repo's own `nodes/` package does
  NOT collide with core `nodes.py` in a live ComfyUI process). Read this
  module's docstring before touching anything that calls core nodes.
- **`nodes/_optional_pack_bridge.py`** — `require_optional_node_class(node_id,
  pack_name)` / `find_optional_node_class(node_id)`: looks up SEPARATELY
  INSTALLED packs (Impact Pack's `"DetailerForEach"`, USDU's
  `"UltimateSDUpscale"`, ResShift's `"ResShiftLoader"`/`"ResShiftUpscale"`)
  via `nodes.NODE_CLASS_MAPPINGS` dict lookup (different mechanism than the
  core bridge above — core nodes are module attributes, external-pack nodes
  only exist in that dict after ComfyUI's `init_extra_nodes()` loader runs).
- **`nodes/_anima_conditioning_helpers.py`** — `encode_text_conditioning(clip,
  text)` (plain encode) and **`resolve_conditioning(clip, text,
  artist_mix_enabled=False)`** — currently a documented NO-OP passthrough
  for artist mix (deliberately deferred to Phase 3, see below). Used
  internally by `AnimaGenerator`'s STRING+CLIP fallback path.

Test suite: 15 files, 304 tests, all green (`for f in test_*.py; do python3
"$f"; done` from repo root). Every torch/comfy-touching function is
guarded/SKIP-printed in this dev environment (no `torch`/`comfy` installed
here) — this is consistent across the whole build, not a gap specific to
one phase. A real-ComfyUI manual smoke test (per the plan's Verification
section) is still owed before calling this pack production-ready.

## NOT started: Phase 3 — AnimaPromptStudio + AnimaConditioningEncode

Plan recap (see plan file's Phase 3 section for full detail): a dynamic
add/remove/reorder prompt-block editor (`AnimaPromptStudio`, pane grouping
positive/negative, types quality/artist/trigger/general, pin bypasses
correction) outputting **plain `STRING`×2** (not a custom type) — this is
the highest-JS-effort phase in the whole plan (structural resize, not just
content-growth resize). Its correction step is pluggable, pointed at the
in-repo Prompt Rules engine (`prompt-rules/`, being built in a parallel
session) rather than a hardcoded Danbooru correction. No width/height, no
Mod Guidance, no wildcard support on this node.

`AnimaConditioningEncode` is the plain (no-JS) companion node: `CLIP` +
`STRING`×2 + artist-mix widgets → `CONDITIONING`×2, wrapping the SAME
`resolve_conditioning` helper `AnimaGenerator` already calls (extend that
function, don't duplicate it — see the ready-to-launch prompt below).

**I had already drafted the full builder prompt for the first sub-step
(`AnimaConditioningEncode`) and was about to dispatch it when the rename cut
off the agent registry.** Paste it into a new `Agent` tool call with
`subagent_type: "builder"` once you're in a fresh session in this folder —
it's fully self-contained and doesn't need anything from the old session:

<details>
<summary>Ready-to-launch builder prompt for Phase 3a (AnimaConditioningEncode)</summary>

```
You're implementing part of Phase 3 of a 4-phase Anima node-pack build in the ComfyUI custom-node repo at /Users/igorsokolovsky/Desktop/private/comfyui/ComfyUI-AnimaFlow. Read the full approved plan first: /Users/igorsokolovsky/.claude/plans/frolicking-doodling-hummingbird.md (Context — including the "Naming update (mid-build)" note — Explicitly-out-of-scope, Cross-cutting tooltip requirement, Phase 3 section).

This call builds ONLY `AnimaConditioningEncode` (the plain node, no custom JS). `AnimaPromptStudio` (the dynamic block editor with heavy JS) is a SEPARATE, later builder call — do not build it now.

## Context: what already exists

Phase 2 already built a shared helper you must reuse, not duplicate:

- `nodes/_anima_conditioning_helpers.py` — already has `encode_text_conditioning(clip, text)` (plain CLIP encode, mirrors core `CLIPTextEncode`) and `resolve_conditioning(clip, text, artist_mix_enabled=False)` (currently a documented no-op passthrough for artist mix — Phase 2 deliberately deferred the real artist-mix algorithm to THIS phase, since `AnimaConditioningEncode` is meant to be the node that owns the user-facing artist-mix widgets). Read this file in full first.
- `nodes/_comfy_core_bridge.py` — `require_core_node_class(node_id)` for looking up core ComfyUI node classes (e.g. `CLIPTextEncode`) via a verified-safe bare `import nodes` (already reviewed and confirmed safe in this pack — see the module's own docstring for why).
- `AnimaGenerator` (`nodes/node_anima_generator.py`) already calls `resolve_conditioning` internally for its STRING+CLIP fallback path when no CONDITIONING socket is wired — whatever artist-mix logic you add to `resolve_conditioning` in this call will automatically also apply to `AnimaGenerator`'s fallback path, so keep the function's existing signature/behavior for the `artist_mix_enabled=False` case unchanged (default OFF must still be a byte-identical plain encode, don't change default behavior).

## What to build

`nodes/node_anima_conditioning_encode.py` — thin node, `CATEGORY = "AnimaFlow/anima"`, `FUNCTION`, tooltips on every field.

**Inputs:**
- `clip` (CLIP, required).
- `positive` (STRING, multiline, required) — tooltip: the main prompt text to encode.
- `negative` (STRING, multiline, required) — same for negative.
- `artist_mix_enabled` (BOOLEAN, default False) — tooltip explaining this blends one or more separately-weighted "artist" conditioning branches into the main prompt's conditioning, rather than just concatenating artist tags into the text (which can get diluted/ignored by the text encoder when mixed with a lot of other tokens).
- `artist_tags` (STRING, optional, e.g. `"@wlop:1.0, @sakimichan:0.6"` or similar simple `name:weight` comma-separated syntax — pick a simple, clearly-documented syntax) — tooltip explaining the format and that each listed artist is encoded separately then blended in at its given weight.
- `artist_mix_strength` (FLOAT, default 1.0) — tooltip: overall blend strength of the combined artist branches against the base positive conditioning.

**Output**: `RETURN_TYPES = ("CONDITIONING", "CONDITIONING")`, `RETURN_NAMES = ("positive", "negative")`.

## Artist-mix scope (read carefully — this is a deliberate scope decision, not a place to over-engineer)

The reference pack's real artist-mix system (`../ComfyUI-EasyUseAnima/easyuse_anima/prompt/artist_mix.py` or wherever it lives — check `easyuse_anima/nodes/prompt_advanced_nodes.py` for how it's invoked) supports multiple exotic blend modes (weighted-average, delta-RMS, clustered, exact-top-K, hybrid, dominant-isolation). **Do NOT port all of that.** This pack is deliberately leaner. Implement ONE simple, well-understood mode: parse `artist_tags` into a list of `(name, weight)` pairs, CLIP-encode each artist name as its own short conditioning, then blend them into the base positive conditioning as a straightforward weighted average of the conditioning tensors (base weight = `1.0`, each artist weight scaled by `artist_mix_strength`, normalize so weights sum sensibly — read how core ComfyUI's own conditioning-combine mechanics work, e.g. `ConditioningCombine`/`ConditioningAverage` nodes in core if they exist, and mirror that exact tensor-blend approach rather than inventing your own, so the result is something core KSampler can consume without surprises).

Put this in `_anima_conditioning_helpers.py`'s `resolve_conditioning` (extend it — this is the function `AnimaGenerator` also calls, so both nodes get the same capability for free): add the artist-mix branch when `artist_mix_enabled=True`, keep the existing plain-encode path completely unchanged when `False`. Add a new pure-logic helper (e.g. `parse_artist_tags(raw: str) -> list[tuple[str, float]]`) for the parsing, fully unit-testable without torch.

`AnimaConditioningEncode.encode()` calls `resolve_conditioning` for the positive pane (passing `artist_mix_enabled`/`artist_tags`/`artist_mix_strength`) and calls it again (or calls `encode_text_conditioning` directly) for the negative pane WITHOUT artist mix (artist mix is a positive-prompt-only concept — negative doesn't get artist blending, confirm this matches how the reference conceptually treats artist mix before assuming, but this is the sane default if uncertain).

## Repo conventions (same as prior phases)
- Thin node + `_helpers.py`, `CATEGORY = "AnimaFlow/anima"`, tooltips on every INPUT_TYPES/RETURN_TYPES entry, plain-script `test_*.py` (bare assert, `ALL_TESTS`, PASS/FAIL, `SystemExit(1)`).
- Register in root `__init__.py`.
- No JS for this node.

## Tests

`test_anima_conditioning_encode.py` — cover: `parse_artist_tags` (valid syntax, malformed entries, empty string, whitespace, duplicate names, weight defaults when omitted), `resolve_conditioning`'s artist-mix branch using a fake/mock `clip` object (record calls, return deterministic fake tensors — no real torch needed to verify the BLENDING LOGIC's weight math, only the actual tensor operations need a guarded torch-optional path), the node's `INPUT_TYPES` contract (every field has a tooltip), and a guarded full-encode smoke test (SKIP-print if `torch`/`comfy` unavailable, matching prior phases' pattern). Also re-run and confirm `test_anima_generator_helpers.py`'s existing `resolve_conditioning` tests STILL PASS UNCHANGED (since you're extending, not replacing, that function) — this is important, don't break Phase 2's behavior.

## When done

Run the new test file, then the FULL existing suite (`for f in test_*.py; do python3 "$f"; done`), confirm all green including that no Phase 2 test regressed. Report: files created/modified, the `parse_artist_tags` syntax you chose and why, how the tensor blend is implemented, test results, and any deviations with reasoning.
```

</details>

After that builder call passes review (dispatch `reviewer` the same way prior
phases did — see any prior phase's review prompt structure in this
conversation's history for the shape, or just ask for a review against the
plan's Phase 3 section + the acceptance points above), move to
**Phase 3b: `AnimaPromptStudio`** (the block editor itself — see the plan
file's Phase 3 section for the full field/pane/pin spec; playground mockup
already exists at `playground/anima_prompt_studio.html` for the intended
look, model the JS on it).

## NOT started: Phase 4 — Regional Prompting

`AnimaRegionMaskEditor` (canvas rect/ellipse authoring → up to 6 numbered
`MASK` outputs, rasterized to real tensors before leaving the node) +
`AnimaRegionalConditioning` (global `CONDITIONING`×2 + up to 6 optional
numbered `MASK`+`CONDITIONING` pairs + `mask_strength` → `CONDITIONING`×2,
attaching native ComfyUI conditioning-mask metadata). Playground mockup
already exists at `playground/anima_region_mask_editor.html`. See the plan
file's Phase 4 section for full detail — no dependency on Phase 3's output,
this can start any time after Phase 2.

## Workflow reminder (per `.claude/CLAUDE.md` + the plan)

Every phase/sub-phase: delegate the actual build to the `builder` subagent
(never write `nodes/`/`js/`/`autocomplete/` source directly as the main
agent — enforced by the `guard-delegate-to-builder` hook; playground/docs
edits ARE exempt from this and can be done directly), then get an
independent `reviewer` pass before moving on. Use `TaskCreate`/`TaskUpdate`
to track phase progress in the new session (the old session's task list
#5-#8 doesn't carry over). Playground mockups for Phase 3/4 are already
built — no new playground work needed unless something in the plan changes.
