# Backlog — known gaps and planned work

Cross-session coordination doc. Two sessions work this repo in parallel, so anything one
session finds but doesn't fix lands here rather than in a session-local task list the
other can't see.

> ## ⚠️ Scope reset — 2026-07-27
>
> The pack was deliberately stripped to the **Rule Builder line only**: two nodes
> (`Prompt Rules`, `Prompt Rules (CLIP)`), the `src/prompt_rules/core/` engine, `rules/*.yaml`, the Rule
> Builder overlay, and the tag autocomplete + highlighting services.
>
> The entire `AnimaFlow/anima` node line and `AnimaPromptStudio` were **deleted**, to be
> re-derived node-by-node from upstream later.
>
> **Section 1 is therefore reference material for that rebuild, not a to-do list.** Every
> `nodes/anima/...` path it cites is gone from `HEAD`. Items marked ✅ below were genuinely
> fixed at the time, but in files that no longer exist — recover them from git history
> (`e1080e4`, `29ac56d`) rather than assuming current code has them.

> Licensing: `../ComfyUI-EasyUseAnima` is **MIT © n0va39**, credited in
> [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) — porting from it is fine **with
> attribution**. `../ComfyUI-MyOriginalWaifu` is **GPL-3.0** — concept only, clean-room,
> never copy. That boundary is what keeps this pack MIT.

---

## 1. Reference for rebuilding the anima line

Upstream line numbers were correct as of `0ad756b`. **Re-verify before trusting them.**

> **The generator rebuild is now specified: [`generator-design.md`](generator-design.md)**
> (2026-07-27). It supersedes this section for the Generator + Preview pair — dependency
> verdicts, the resource flag, the three image outputs, and the stage list all live there, and
> §9 of it carries 1a's three divergences forward. This section stays authoritative for the rest
> of the deleted anima line (Conditioning Encode, Image Scale, Region Mask Editor, Regional
> Conditioning), which is still unspecified.

### 1a. Three divergences the old port had — don't reintroduce them

- **`guide_size_for` was `True`; upstream ships `False`** for both detailer targets
  (`easyuse_anima/aio/generation_defaults.py:306`, `:372`). Decides whether Impact measures
  `guide_size` against the tight bbox or the padded crop region — same `guide_size`
  resampled at a different scale. *(was fixed in `e1080e4`)*
- **`noise_mask_feather` was `0`; upstream ships `10`** (face, `:321`) **/ `20`** (eye,
  `:387`). Feathers the noise mask inside the detail crop; the main control against visible
  detailer seams. Upstream never ships `0`. *(was fixed in `e1080e4` — set to `10`, since
  our stage was one generic pass over any `SEGS` rather than separate face/eye targets, so
  the conservative face value was chosen)*
- **Saved images carried no workflow or prompt metadata** — the node declared no hidden
  `PROMPT` / `EXTRA_PNGINFO`, making saves *worse than stock `SaveImage`*: dragging a saved
  PNG back into ComfyUI restored nothing. **Never fixed.** Declaring the two hidden inputs
  and passing them through is the whole fix.

### 1b. Four upstream features worth having — none need a new dependency

1. **First-pass cache** — biggest workflow win. Keys on resources + file revisions + prompt
   data + sampler + patches + size, so tweaking only highres/detailer/upscale skips
   re-sampling the base. Ref: `aio/first_pass_cache.py` (LRU, 2 entries, 512 MB, 300 s TTL).
   **Never built.**
2. **Per-stage sampler overrides** — own `steps`/`cfg`/`sampler_name`/`scheduler` +
   `inherit_sampler_settings` per stage (20 steps, cfg 8.0, euler; `sgm_uniform` for the
   detailer). Ref: `aio/sampling.py:378-452`. **Never built.**
3. **USDU seam fixing + tile control** — the old port hardcoded `seam_fix_mode="None"`,
   making seam repair unreachable. *(was built in `29ac56d`: nine widgets incl. seam-fix
   mode/denoise/width/blur/padding, tile blur/padding, `mode_type`, `auto_tile`, plus a pure
   `plan_usdu_tiles`. Note `mode_type` — Linear/Chess/None — is tile **order**; `tiled_decode`
   is an unrelated VAE flag. Ground truth was `generation_defaults.py:458-464`, `:246-266`
   and `legacy_generation.py:440-528`.)*
4. **Output size cap** — upstream's postprocess downscales to fit (`max_long_edge` /
   `max_megapixels`); the old port only rounded *up*, leaving final size unbounded.
   Ref: `aio/postprocess.py:42-86`. **Never built.**

### 1c. Scope decisions to re-apply

Not ported: everything gated behind a third-party pack — KJNodes, Anima-DAVE,
Anima-Safe-PAG, ComfyUI-Image-Saver — plus the bundled `EASY_USE_ANIMA_INPUT` context object
(plain `MODEL`/`CLIP`/`VAE`/`CONDITIONING` sockets are better) and SAM3-specific detection
(a generic `SEGS` socket is detector-agnostic). Together ~150 of upstream's ~250 settings.

🔄 **Exception the user approved: take the Spectrum dependency.** Quality parity with
upstream was judged worth it, which brings **Anima Mod Guidance**
(`easyuse_anima/prompt/conditioning.py:86-140`) — the model-specific quality-tag steering the
reference pack is built around, and the largest image-quality gap on Anima specifically.
Soft-import `comfyui-spectrum-ksampler` the way USDU/ResShift/Impact were (absent pack ⇒
unchanged behaviour, never a hard dependency). **Top quality item when the line is rebuilt.**

---

## 2. Prompt tag highlighting — live

Wired into both Prompt Rules panes via `js/prompt_rules/node/highlight_wiring.mjs`.

- Backend: `POST /wtn/classify` (`src/autocomplete/classify.py` + `src/autocomplete/api.py`) — 16
  sections, reusing the ~1M-tag autocomplete dataset.
- Frontend: `js/shared/highlight/` — mirror-overlay painter, two-tier optimistic/authoritative
  paint, collapsible legend.

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

## 3. Control Panel + Loader Panel — designed, not built

New track approved 2026-07-27. Full spec: [`control-panel-design.md`](control-panel-design.md);
mockup: [`../playground/control-panel.html`](../playground/control-panel.html). **No code exists yet.**

Two nodes (`AnimaFlow/Controls`): a value panel (sampler, scheduler, seed, int, float, empty latent)
and a loader panel (unet, vae, clip), each row carrying its own output dot. Ported from Pixaroma's
`PixaromaSliders` — MIT, needs a `THIRD_PARTY_NOTICES.md` entry when built.

Three things it changes pack-wide, so they land here rather than only in the spec:

- **Picker topics are now Title Case** (decided 2026-07-27): `anima_prompt` → **`Prompt`**, and the
  new pair is **`AnimaFlow/Controls`**. Folder names stay lowercase — Python packages must be
  importable — so "folder and category agree" means case-insensitively now.
  `.claude/skills/animaflow-node-theme/SKILL.md` fixes the list at three snake_case topics
  (`anima` / `anima_prompt` / `panel`) and needs both changes. **Not** `Panel` for the new one:
  that's reserved for the deleted webtoon panel pipeline and would collide on its rebuild.
- **The JS budget goes 3 → 4.** One `js/controls/index.js` registers *both* extensions and lazily
  imports the per-node `.mjs`, so two new nodes cost one auto-loaded file. Update the count in
  `.claude/CLAUDE.md` with that reason when built.
- The theme skill still cites `js/anima_prompt/...` paths that became `js/prompt_rules/...` in
  `e703dd2` — worth fixing while in there.

Open question that only a live ComfyUI settles (spec §5): what `output.type` a combo row must carry
for legacy litegraph to accept a wire — `"COMBO"`, the joined option list, or fall back to `"*"`.

---

## 3b. Pixaroma's seven Control Panel review rounds — unmined

The clone was pulled `afd0d05` (v1.4.44) → `5036814` (v1.4.62) on 2026-07-27. Their Control Panel
gained **+1360 lines** in between, including seven numbered review rounds of real bug fixes on the
same mechanic ours is ported from — plus a Seed R/N control, a combo control and a wheel-zoom fix,
all built independently of ours.

Concrete plan with per-item reproduction notes: **[`pixaroma-review-rounds-plan.md`](pixaroma-review-rounds-plan.md)**.
The highest-value item is a **litegraph fact, not their bug**: on disconnect, the event reports the
origin output slot as `0` for the input-side and `removeLink` paths — only `disconnectOutput` reports
it correctly. Trust `link.origin_slot`, never `slotIndex`.

---

## 4. Whole-pack

- **Widget order is append-only.** New widgets go at the end of `required` (or into
  `optional`), never inserted. Node widgets are positional, so inserting mid-list silently
  shifts every later value in already-saved workflows — and it fails *quietly*, because
  litegraph coerces or falls back, so the node loads looking fine with wrong settings.
  - **This already bit us once:** `42336c0` inserted `shift` as the first widget and
    `highres_scale_by` mid-group, misaligning every slot for workflows saved before it
    (`shift`←seed, `seed`←steps, `cfg`←the sampler *string*). Never repaired, deliberately —
    the user had no saved workflows worth migrating.
  - Applies to the rebuilt anima line too. Consider freezing the required-key order in a
    regression test, as the old `test_anima_generator_helpers.py` did.
- **No live-ComfyUI verification story.** Much of `js/` is headless-tested only, and the code
  carries `VERIFY-IN-COMFYUI:` markers for what only a real browser can confirm (litegraph
  resize contracts, autocomplete popups, overlay caret alignment). Worth a written manual
  checklist.
- **Per-node CSS isn't nested under `.wtn`.** Selectors are uniquely prefixed so nothing
  leaks *out*, but they sit at single-class specificity, so a higher-specificity ComfyUI rule
  could bleed *in*. No evidence of it happening — revisit only if it does.
