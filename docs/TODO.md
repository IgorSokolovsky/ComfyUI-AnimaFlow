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

*Now is empty.* The `%seed%` follow-up shipped — see Done below.

> ### ⚠️ Deployment lesson, 2026-07-29 — the board's SHAs are mostly unreachable from `origin/master`
>
> Two `cec90cd` fixes were reported missing in a live ComfyUI. Neither was broken: **the Colab box's
> `git pull` had been failing** with `fatal: Not possible to fast-forward`, so the files on disk were
> months of commits stale while GitHub had everything. The box's `master` carried **pre-rewrite twins**
> of three commits (`c5cb2cc`/`b921df6`/`717feaa`), content-identical to their post-rewrite counterparts
> (`2a124cd`/`b7e66dc`/`d1f8942`) but with different SHAs — the 2026-07-29 history rewrite renumbered
> them, and a checkout that predates it can never fast-forward again. Fixed with
> `git reset --hard origin/master` (untracked user data such as `rules/*.yaml` survives that; only
> `git clean` would remove it).
>
> **Consequence this board has to own: 10 of the 15 SHAs cited below are NOT reachable from
> `origin/master`** — they are pre-rewrite SHAs that resolve only in a clone old enough to still hold
> the objects. `10f8708`, `717feaa`, `885410b`, `8de4d18`, `b921df6`, `c2a0f1c`, `ca8f145`, `d4918bf`,
> `dc44d75`, `f0d2309`. That directly breaks this file's own rule — *"a claim you can't trace to a SHA
> is a claim you can't check"* — for anyone on a fresh clone. Each has a same-subject, same-tree twin
> that IS reachable, so the mapping is mechanical; **not yet applied.**
>
> **Two rules earned here:** never conclude a feature is broken live before confirming what the box's
> own `git log` actually says (an ancestor of `origin/master` proves it is on *GitHub*, not deployed),
> and after any history rewrite, re-point every SHA the docs cite.

> **`.claude/CLAUDE.md` had two countable claims wrong** and they were fixed on 2026-07-29 in the same
> pass as `1fe13a6`: **7** registered nodes, not 6 (it omitted `AnimaContextBridge` from both the count
> and the per-track table), and **322** `tests/test_anima_*.py` assertions, not 129. Its JS-budget
> paragraph also said `js/anima/` registers "both" node classes; it covers **three**.
> **Those edits are not in this repo and cannot be** — `.claude/` is excluded via `.git/info/exclude`,
> which is *machine-local*, so they live on one machine only (the same consequence the Deferred row
> below already flags). Anyone cloning this repo gets a CLAUDE.md without them.

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
| Settings section, seven settings | `b921df6` — **confirmed working 2026-07-29** |
| Server-side run logging (stage status, sampler provenance, model files) | `8de4d18` |
| `ui` payload must be a list — post-run values/disable reaching the panel at all | `885410b` |
| Chevron + gear visibility, gear pinned right | `f0d2309` |
| Subgraph boundary crossing for the context walk | `10f8708` |
| Seed as a string, text+roll row, `seed_after_generate` implemented | `717feaa` |
| One seed row; four field builders moved to `js/shared/fields.mjs` | `21ccd1d` |
| `colab/` folder, sanitized notebook, layer 1 extraction + the layering guard test | `a630ae4` |
| `%seed%` in a Save-now filename resolves to the real seed — carried as `anima_seed: [str(seed)]`, string end-to-end, `int` once at `format_filename` | `9874426` |
| Enabled section card border keeps **no accent at all** (`--wtn-line-soft`, identical on/off) — round 3, after full accent and `.35` both read too light live. Also adds the missing `TOKENS.lineSoft`, fixing an inert `var(…, undefined)` fallback at 10 sites | `a6478f0` |
| Enabled section card border dimmed to `rgba(45,212,191,.35)`, the warn border's own restraint level — superseded same day by the row above | `98d0fe5` |
| Bool switch owns its state; word dropped, switch right-aligned; inherit ⓘ next to its label | `cec90cd` |
| Nested overlays — a ⚙ menu survives opening a stepper's option list inside it | `cec90cd` |
| Human field labels via a display-name map (settings paths unchanged) | `cec90cd` |
| Preview Save defaults off, plus a **Save now** button (`POST /wtn/anima/preview/save_now`) | `cec90cd` |

## Done (confirmed by use)

| Item | Commit |
|---|---|
| `generator-design.md` catches up with `cec90cd` — §7a's Save-off reversal, §8's two stale blob values, §12's stale "overlay.mjs is untouched" retraction, and the "index.js registers both node classes" claim (it covers three) | `1fe13a6` — every claim checked against source, so nothing here is waiting on a live box |
| V3 `NodeOutput` unwrapping — the Detailer runs | `d4918bf` |
| Model pickers + readable pre-flight error for a missing model file | `d4918bf` |
| Node defs in both V1 and V3 combo schemas; live sampler/scheduler lists | `c2a0f1c` |
| Accordion cards, ⚙ menus, 14px type, working stepper dropdowns | `dc44d75` |
| Saved node size surviving refresh (both tracks) | `dc44d75`, `ca8f145` |
| Use Everywhere submit-churn no longer wiping the run report | `dc44d75` |
| Preview: image fills the node, no internal scroll, one preview not two | `885410b`, earlier |
