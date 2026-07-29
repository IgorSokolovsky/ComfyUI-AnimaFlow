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

| # | Item | Notes |
|---|---|---|
| 1 | **Bool switch never updates its own visual** | `buildBoolFieldInto` flips `field.word` but never the switch's `wtn-fld-on` class, so the switch looks stuck while the word changes. Affects every menu in Generator + Preview. Fix by making the component own its state — same defect family as the stepper's stale value. |
| 2 | **Bool row layout: switch right, no on/off word** | The switch *is* the label; the word is redundant and is the thing that desyncs. Where the word carried real information (the `inherit_sampler_settings` description), move it into the ⓘ. |
| 3 | **A stepper inside a ⚙ menu closes the menu and lands top-left** | Opening the option list calls `closeActiveOverlay()` (single-active-overlay), which detaches the anchor, so `getBoundingClientRect()` returns zeros and the list renders at 0,0. Needs nested overlays (a stack), not one slot. |
| 4 | **Field labels are raw Python keys** | `mode_type` → *Mode*, `auto_tile_target` → *Auto tile*, and so on, inline and in menus. A display-name map beside the settings tree; the settings paths never change. |
| 5 | **ⓘ position on the inherit row** | Should sit immediately right of the label, not far right — and only when the flag is on. |
| 6 | **Preview: Save defaults to ON** | Should default **off**. Reverses `generator-design.md` §7a's "on by default, since it's the only node that saves" — record the reversal there. |
| 7 | **Preview: a Save button for when Save is off** | Saves the best available image, preferring `final → mid → base`, through the existing filename template and output path. Needs a route: the stage images are temp files, and saving on demand happens outside a graph run. |

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

**❓ Open — the whole point of the task: what's missing?** The owner has it in mind; without it this
entry is just "clone Pixaroma's". Until that's captured, this can't start.

**Spillover to our Loader Panel** — candidates worth lifting even before the LoRA node exists:
searchable picker, missing-file marks, the Civitai/metadata info panel, and the memory-mode idea
(our loader helpers already cache per `(kind, name, dtype)` — `control-panel-design.md` §2 —
but expose no policy).

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

## Done (confirmed by use)

| Item | Commit |
|---|---|
| V3 `NodeOutput` unwrapping — the Detailer runs | `d4918bf` |
| Model pickers + readable pre-flight error for a missing model file | `d4918bf` |
| Node defs in both V1 and V3 combo schemas; live sampler/scheduler lists | `c2a0f1c` |
| Accordion cards, ⚙ menus, 14px type, working stepper dropdowns | `dc44d75` |
| Saved node size surviving refresh (both tracks) | `dc44d75`, `ca8f145` |
| Use Everywhere submit-churn no longer wiping the run report | `dc44d75` |
| Preview: image fills the node, no internal scroll, one preview not two | `885410b`, earlier |
