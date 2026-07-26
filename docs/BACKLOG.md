# Backlog — known gaps and planned work

Cross-session coordination doc. Two Claude Code sessions work this repo in parallel, so
anything one session finds but doesn't fix lands here rather than in a session-local task
list the other can't see.

Every claim below was verified by reading both sources at the cited lines — line numbers
were correct as of commit `0ad756b`. Re-check before trusting them; the files move.

> Scope note: `../ComfyUI-EasyUseAnima` is **MIT © n0va39** and already credited in
> [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), so porting code from it is fine
> **with attribution**. `../ComfyUI-MyOriginalWaifu` is **GPL-3.0** — concept only,
> clean-room, never copy. That boundary is what keeps this pack MIT.

---

## 1. AnimaGenerator — three verified divergences from upstream

Small fixes, but each one changes output today. These read as porting slips rather than
deliberate scope calls, so they're listed as defects.

### 1.1 `guide_size_for` is inverted
`nodes/anima/_anima_generator_helpers.py:666` hardcodes `"guide_size_for": True`.
Upstream ships **`False`** for *both* detailer targets
(`easyuse_anima/aio/generation_defaults.py:306` face, `:372` eye).

This flag decides whether Impact measures `guide_size` against the tight bbox (`True`) or
the padded crop region (`False`). Same `guide_size` therefore resamples at a **different
scale** than upstream — a silent quality divergence, not just a missing knob.

### 1.2 `noise_mask_feather` is 0
`nodes/anima/_anima_generator_helpers.py:683` hardcodes `"noise_mask_feather": 0`.
Upstream ships **`10`** (face, `generation_defaults.py:321`) and **`20`** (eye, `:387`).

This feathers the *noise* mask inside the detail crop and is the main control against
visible detailer seams. Upstream never ships `0`. If a single fix is worth doing, it's
this one.

### 1.3 Saved images carry no workflow or prompt metadata
`nodes/anima/_anima_generator_helpers.py:953-966` calls
`SaveImage.save_images(image, prefix)` with no metadata, and the node declares no hidden
`PROMPT` / `EXTRA_PNGINFO` inputs.

Net effect: **dragging a saved PNG back into ComfyUI restores nothing** — strictly worse
than stock `SaveImage`, which does embed the workflow. The docstring calls this
deliberate; recommend reversing it. Declaring the two hidden inputs and passing them
through is the whole fix.

**Verify all three against a real generation, not just the test suite** — these are
visual/behavioural, and the tests don't currently pin them.

---

## 2. AnimaGenerator — four upstream features worth porting

Ranked. All four need **no new third-party dependency**, which is what separates them from
the ~150 settings we're deliberately skipping (see §3).

### 2.1 First-pass cache — biggest workflow win
Upstream caches the first-pass result keyed on resources + file revisions of
unet/vae/clip/loras + prompt data + sampler + patches + size, so tweaking *only*
highres/detailer/upscale skips re-sampling the base image entirely. We re-sample from
scratch on every run.

Reference: `easyuse_anima/aio/first_pass_cache.py` (LRU: 2 entries, 512 MB total,
256 MB per entry, 300 s TTL, tensors cloned to CPU).

### 2.2 Per-stage sampler overrides
Upstream gives highres / detailer / upscale their own `steps`, `cfg`, `sampler_name`,
`scheduler`, plus an `inherit_sampler_settings` flag (defaults 20 steps, cfg 8.0, euler;
the detailer uses `sgm_uniform` from Impact's own scheduler list, not core's).

We reuse the first pass's values everywhere — typically ~3× more compute than needed in
the detailer, with the wrong scheduler for it.

Reference: `easyuse_anima/aio/sampling.py:378-452`.

### 2.3 USDU seam fixing and tile control
We hardcode `seam_fix_mode="None"`, so **seam repair is unreachable**. Also missing: auto
tile planning (computes tile dims from the expected output so tiles divide evenly, aligned
to 64 and clamped), `Chess` traversal (reduces neighbour-tile contamination), `mask_blur`,
and `tile_padding`. Tiled upscales will show seams upstream can fix.

Ours: `nodes/anima/_anima_generator_helpers.py:784-796`.
Reference: `easyuse_anima/aio/usdu.py:12-89` and `legacy_generation.py:467-508`.

### 2.4 Output size cap
Upstream's postprocess is a **downscale-to-fit** (`max_long_edge` or `max_megapixels`,
downscale-only). Ours only rounds *up* to a multiple. There is currently **no way to bound
final output size** — at a high `highres_scale_by` that matters.

Reference: `easyuse_anima/aio/postprocess.py:42-86`.

---

## 3. Deliberately NOT porting

Recorded so nobody re-litigates it. The pack "trades breadth for decoupling"
([`README.md`](../README.md) credits section); these follow from that.

- **Anything gated behind a third-party pack**: Spectrum-KSampler (Spectrum forecast, DiT
  corrections, SPD sampler, **Anima Mod Guidance**), KJNodes (sage attention,
  torch.compile, fp16 accumulation), Anima-DAVE, Anima-Safe-PAG, and ComfyUI-Image-Saver
  (Civitai hashes, webp/jpeg, embed options). That's roughly 150 of upstream's ~250
  settings. We keep only USDU / ResShift / Impact, all soft-imported.
  - ⚠️ The one that genuinely costs us is **Anima Mod Guidance**
    (`easyuse_anima/prompt/conditioning.py:86-140`) — the model-specific quality-tag
    steering the reference pack is built around. It's the largest *image-quality* gap on
    Anima specifically. Needs Spectrum, so it's a real fork, not an oversight. Revisit if
    users ask.
- **Bundled context object** (`EASY_USE_ANIMA_INPUT` / `PROMPT_DATA`) → we take plain
  `MODEL`/`CLIP`/`VAE`/`CONDITIONING`. Consequence: `usdu.prompt_mode="no_general"` and
  prompt-data-driven width/height are structurally unreachable. Fine.
- **Artist mix**: one blend mode instead of ten, and it lives on `AnimaConditioningEncode`
  rather than the generator.
- **Preview split into its own node** → no `compare_previous`, `image_feed`, node-mounted
  `ui.images`.
- **SAM3-specific detection replaced by a generic `SEGS` socket** — arguably better
  (detector-agnostic), but it costs the ordered multi-target detailer chain.

---

## 4. Prompt tag highlighting — in progress

Landed in `0ad756b`, **not yet wired into any node** (so it's inert in ComfyUI right now).

- Backend: `POST /wtn/classify` (`autocomplete/classify.py` + `autocomplete/api.py`) —
  classifies prompt spans into 16 sections, reusing the existing ~1M-tag dataset.
- Frontend: `js/shared/highlight/` — mirror-overlay painter + collapsible legend.
- Remaining: wire into **Prompt Rules** (in progress), then **Anima Prompt Studio**.

> ### ⚠️ If you touch either side, read this first
> Offsets in the `/wtn/classify` payload are **Unicode code-point** offsets, *not* UTF-16
> code units. Python counts code points; JS counts UTF-16 units — so one emoji makes every
> later token drift by one, silently, and only in prompts containing astral characters.
>
> The frontend owns the correction: `js/shared/highlight/classify.mjs` indexes via
> `Array.from(text)`. **Do not also "fix" this on the Python side** — two corrections
> double-apply and drift the other way. The contract is documented in `classify.py`,
> `api.py`, and `classify.mjs`; keep those comments intact.

---

## 5. Whole-pack

- **No live-ComfyUI verification story.** Much of `js/` is headless-tested only; the code
  is littered with `VERIFY-IN-COMFYUI:` markers for things only a real browser can confirm
  (litegraph resize contracts, autocomplete popups, overlay alignment). Worth a written
  manual pass checklist.
- **No settings migrations.** Node widgets are positional, so inserting a widget mid-list
  silently shifts values in already-saved workflows. Upstream versions its settings blob
  and migrates (`easyuse_anima/aio/generation_migrations.py`). Cheap insurance would be
  appending new widgets at the end only — worth agreeing on as a rule.
