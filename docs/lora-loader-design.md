# LoRA Loader + Civitai browser — design

**Status (2026-07-31): M1, M2 and M2b's first slice are BUILT.** §9's network policy is settled and in
force. See §0e for what M1 shipped; the milestone list in §0c is the plan, this is where it actually got to.

| | state |
|---|---|
| **M1** — node, rows, picker, ⓘ panel, sizing, drag + FLIP, ⚙, hash lookup | ✅ built, owner-confirmed |
| **M2** — search + download in the anchored panel, thumbnails, per-version picker, browsing level, sidecar | ✅ built; search + level owner-confirmed, the rest awaiting a restart |
| **M2b slice 1** — toolbar button, 90% modal, filter rail, result grid, download | ✅ built, unverified |
| **M2b slice 2** — the detail **swap** + multi-column community gallery + copy-prompt | ❌ **not built** |
| **§7c-ii** — the *picker's* vertical info panel (version selector, description, single-column gallery) | ❌ **not built** — the one part of M2 still outstanding |
| **§1a-vii** — show the Civitai name instead of the filename, behind a setting | ✅ built, unverified |
| **ⓘ backfill saves the preview image** (§7c-iv) | ✅ built (`6ce43de` route, wired `99e24c5`) |
| **`notfound`'s search-by-name link** | ✅ wired `99e24c5` |
| **Remove an installed model** (decisions taken 2026-07-30, `docs/TODO.md`) | ✅ route `6ce43de`, type-to-confirm UI `99e24c5` |
| **Installed-by-kind section in the modal** (owner, 2026-07-30) | ❌ **not built** |
| **M3** — Loader Panel reuse, checkpoints + UNET | ❌ **not built** |

> ⚠️ This header previously read *"M2 and M2b remain spec-only"* long after both shipped, and §7c-iv
> still carried "SPEC, not yet built" after it was built and confirmed. **A status line is the first
> thing read and the last thing updated** — if you ship a milestone here, change this table in the same
> commit.

Originally written 2026-07-29 from a full read of the upstream reference. Three
things the board listed as open are **settled here by investigation** (§2b, §5, §6); one genuinely
open decision remains (§9). Read this before writing any code for this track — like
[`control-panel-design.md`](control-panel-design.md) and [`generator-design.md`](generator-design.md),
it is a contract, not notes, and several entries record why an obvious approach is rejected.

Wanted: an AnimaFlow LoRA loader taking Pixaroma's as the starting point (the one the owner actually
uses), **plus the two things it doesn't have** — Civitai search and download — built as a *shared*
browser so the Loader Panel's UNET/checkpoint side gets them too.

---

## 0. START HERE — status, decisions, and the build plan

**Nothing is built.** This doc plus [`playground/lora-loader.html`](../playground/lora-loader.html) are
the whole artefact. The mockup is **interactive and is the behavioural reference** — open it before
writing code; drag a row, toggle the master switch, add a custom trigger word, flip the Civitai setting
off, open the modal and click a result card.

### 0a. Everything settled (owner decisions, all 2026-07-29)

| # | decision | where |
|---|---|---|
| 1 | **The node ships FIRST**, Civitai feature under it; Loader Panel reuses later | §9a |
| 2 | Civitai **metadata needs NO API key** — hash → public endpoint, sidecar-cached | §2b |
| 3 | **NOT** a layer-3 socket-rows consumer; that deferral stands | §5 |
| 4 | `AnimaFlow/Controls` + `js/controls/` — **zero new auto-loaded `.js`** | §4a |
| 5 | State is a **declared serialized STRING widget**, never `hidden` + `graphToPrompt` | §3 |
| 6 | **Sizing Class A** — content height, width resizable; four enforcement layers | §6 |
| 7 | Library is **kind-parameterised from commit one**, only `loras` wired; `kind` whitelisted server-side | §7a |
| 8 | **Three surfaces**: two kind-locked pickers + one unscoped toolbar modal | §7c |
| 9 | **All three get the full filter set**; only `type` is locked. Filters remembered user-wide | §7c-i |
| 10 | Modal rail: **`<select>` adds a removable chip**, not Civitai's 19-chip grid | §7c-i |
| 11 | In the modal, card click → **detail swap** (filter rail stays): version selector, description, **community gallery with prompt on hover + copy** | "The detail view" |
| 12 | **One header row**: `＋ Add LoRA` (content+padding, **max 30%**) · master switch · `N/M` · 🔍 · ⚙ | §1a-ii |
| 13 | Master switch **on only when all on**; mixed shows off, counter carries it; click = all on | §1a-ii |
| 14 | Row order: **name · strength · ⓘ · switch(right)**; off row dimmed; missing = whole field red | §1a-ii |
| 15 | **Drag-to-reorder with FLIP animation** (the *animation* is new; plain drag-reorder already ships — see §1a-iii's correction); menu drops to **Duplicate / Remove** | §1a-iii |
| 16 | ⓘ panel: identity → `<hr>` → triggers → `<hr>` → author's notes (collapsible) | §1a-i |
| 17 | `all`/`none` is an **ACTION segment** — never latches | §1a-i |
| 18 | Custom trigger words allowed; **only user-authored chips get an `✕`** | §1a-i |
| 19 | ⚙: **8 settings**; dropped Highlight colour + the three footer buttons | §7b |
| 20 | The **Civitai** setting hides **every** network affordance (🔍 + ⓘ lookup) ⇒ provably offline | §7b |
| 21 | Node picker card click → **a new VERTICAL info panel** (sibling of the ⓘ panel), single-column gallery; **not** the modal, **not** an in-panel swap | §7c-ii |
| 22 | **EVERY per-model info surface carries `View on Civitai ↗`** — the ⓘ panel, the modal detail, and the Loader Panel's model info | §7d |
| 23 | Row menu keeps **four of six**: `More info` · `Duplicate` · `Disable/Enable` · `Remove` (only the arrows go) | §1a-iii |
| 24 | The four lookup states each get **icon + cause + the one useful action**; `notfound` offers **search by name** and explains the hash | §7e |
| 25 | Picker: root group **`All`**, subfolders their own; **current LoRA accented**; **ellipsis-truncated**; small **local-preview thumbnail** + size/base-model line | §1a-v |
| 26 | Category: **subfolder grouping by default**, optional **group-by-Civitai-`tags`** (our parser must KEEP tags — upstream drops them); **never guess a category** | §1a-vi |

### 0e. What M1 shipped, and two decisions taken during the build (2026-07-29)

M1 is built across five reviewed slices. Suites at completion: **Python 647, JS 1093, 5 auto-loaded
`.js`, 8 registered nodes.** Everything in §0c's M1 list landed. Two decisions were taken during
implementation that the 26-row table does not cover, both recorded here so they don't read as drift:

- **D — the Python package is `src/model_browser/`, not `src/civitai/`.** It holds the local-file
  services too (per-kind listing, safetensors header-only metadata, preview discovery, the `kind`
  whitelist), which the Loader Panel needs at M3 and which have nothing to do with Civitai. Civitai is
  one *source* inside a model browser, not the package's subject. Routes are `/wtn/model_browser/*`.
- **E — the reuse boundary is enforced by a test, not by intent.** `js/controls/model_picker.mjs`,
  `model_info.mjs` and `civitai_api.mjs` are the three track-agnostic modules `AnimaLoaderPanel` imports
  at M3; a layering guard fails the suite if any of them imports a `lora_*` module, via **static or
  dynamic** `import()`. That is what keeps M3 an import rather than an extraction.

**§7d's "cached sidecar info still displays" is implemented as a server-side guarantee, not a client
promise.** `lookup_model_info(..., cached_only=True)` (`src/model_browser/lookup.py`) returns from the
sidecar and, on a cache miss, returns **before** `hashing.sha256_file` or `civitai_client.lookup_by_hash`
are reachable at all. So decision 20's "no path left from which a request could originate" is literally
true — the fetch code is unreachable, not merely unused — while cached notes and trigger words still
display with Civitai off. Tests poison both network functions to raise if reached.

### 0b. The ONE thing still open

**§9 — the outbound-network policy.** It does **not block M1**, which is entirely offline apart from the
hash lookup (no key, cacheable, and hideable by decision 20). Settle it before M2.

### 0c. Build plan

> Decisions are cited as **d1–d26**, matching §0a. Four are framing rather than work items and so appear
> nowhere below: **d1** (node ships first), **d2** (metadata needs no key), **d3** (not a layer-3
> consumer), **d8** (three surfaces).

**M1 — the node, offline-capable.** No network policy needed; the only remote call is the hash lookup,
which needs no key, caches to a sidecar, and is hideable (d20).

- `AnimaLoraLoader` — `nodes/controls/`, `AnimaFlow/Controls`, registered from the existing
  `js/controls/index.js` (d4). Declared `lora_state` widget, tolerant normalization (d5, §3).
- **Header row** (d12): `＋ Add LoRA` ≤30% · master switch with `N/M` (d13) · 🔍 · ⚙.
- **Rows** (d14): name · strength · ⓘ · switch right; off row dimmed; missing = whole field red.
  **Animated FLIP drag-reorder** (d15) — build it here, port to `js/controls/rows.mjs` after.
  **Row menu** = `More info · Duplicate · Disable/Enable · Remove` (d23).
- **Picker** (d25, d26): search on top, **local-preview thumbnail** + size/base-model line, current LoRA
  accented, ellipsis-truncated, **group by subfolder** with optional group-by-category and a category chip
  where Civitai `tags` are known — **our parser must keep `tags`** (upstream drops them).
- **ⓘ panel** (d16–d18, d22): identity → `<hr>` → triggers (`all`/`none` **action** segment that never latches — d17, custom words with `✕`) → `<hr>` → collapsible author's notes; `View on Civitai ↗`.
- **The four lookup states** (d24): searching / found / notfound / offline, each *icon + cause + the one
  useful action*. `notfound` explains the hash and offers search-by-name — **that link lands in M2**, so in
  M1 it is either disabled with a note or omitted.
- **⚙ dialog** (d19): the eight settings, with the per-node vs Settings→AnimaFlow split (§7b). The
  **Civitai** switch hides every network affordance (d20).
- **Class A sizing** (d6, §6) — four layers; **read the sizing skill first**.
- Python: apply in row order, `triggers` **from applied rows only**, three memory modes including the
  `last`-mode fix (§1b).
- Tests per §10, **including `Float64Array` size tests**.

**M2 — search + download.** Needs §9's policy. Kind-parameterised routes with a **whitelisted `kind`**
(d7), the full filter set as pills with `type` locked (d9), server-side streamed download with progress and
a destination derived from `kind`, the key ladder and public-only mode (§8). Plus the **vertical Civitai
info panel** the picker opens on a card click (d21) — version selector, description, single-column
community gallery with prompt-on-hover and copy, `View on Civitai ↗`. Completes `notfound`'s
search-by-name link from M1.

**M2b — the toolbar modal.** Purely additive; M2 does not depend on it (§7c-ii). Icon button mounted from
`js/controls/index.js` with a lazy `import()`; 90% modal; filter rail with **`<select>`-adds-a-chip** (d10);
result grid; detail **swap** keeping the rail, with the multi-column gallery (d11).

**M3 — Loader Panel reuse**, scoped to **checkpoints + UNET only**.

### 0d. Read these before touching code

- `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md` — **mandatory** for anything sizing. `node.size`
  is a `Float64Array`; `Array.isArray` guards are dead code.
- `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` — the state handshake §3 depends on.
- `.claude/skills/animaflow-shared-fields/SKILL.md` — and note `js/controls/` does **not** currently
  import `js/shared/fields.mjs`.
- [`control-panel-design.md`](control-panel-design.md) §7a — the Class A contract.

> **Section order note:** the `1a-*` and `7*` sub-sections are not in numeric order — they were appended
> as decisions arrived. The table in §0a is the index; follow it rather than reading top-to-bottom.

---

## 1. The upstream reference — read it, it is good

`../ComfyUI-Pixaroma/js/lora_loader/` + `nodes/node_lora_loader.py` + `nodes/_lora_helpers.py`.
**MIT © pixaroma**, so porting is fine **with attribution** — cite the upstream `file:line` in a
comment and extend [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) with a per-file derivation
row, the moment anything is actually derived.

Shape: **frontend-driven, thin Python** — ~2,250 lines of JS across 8 modules against 183 lines of
node plus 445 lines of pure helpers.

| module | lines | job |
|---|---|---|
| `info_panel.mjs` | 518 | the ⓘ panel — trigger-word picking + Civitai lookup |
| `index.js` | 313 | extension entry, sizing, refresh hooks |
| `settings.mjs` | 302 | the ⚙ dialog |
| `render.mjs` | 289 | rows, strengths, missing-file marks |
| `core.mjs` | 262 | state (add / remove / move / duplicate / patch) |
| `dropdown.mjs` | 238 | the searchable picker |
| `interaction.mjs` | 209 | row context menu |
| `api.mjs` | 118 | fetch + client-side caching |

### 1a. What it already does — the baseline, so we don't rediscover it

- **Per row:** searchable name picker (grouped by subfolder; typing searches *flat* across every
  LoRA), on/off, model + clip strength with ▲▼ steppers, an ⓘ button, and a right-click menu.

### 1a-v. The picker dropdown — corrected from a reference shot (2026-07-29)

Four details a source read did not give me:

- **Group headers, and the root group is labelled `All`.** Subfolders get their own header
  (`detail/`); files sitting at the top of `models/loras` are grouped under `All` rather than left
  header-less.
- **The row's CURRENT LoRA is accent-coloured** in the list, so you can see where you are in a long
  list of near-identical filenames — which is what a real `models/loras` looks like.
- **Long names truncate with an ellipsis, never wrap.** Every row stays one line, so the list scans
  vertically; the full name goes in a `title`.
- **Extensions are shown** (`.safetensors`) — subject to the ⚙'s *Hide file extension* setting (§7b).
- **Each entry carries a small thumbnail on the left** (~30px) plus a second line with file size and
  base model (owner, 2026-07-29 — richer than upstream's plain text list). The thumbnail comes from the
  **preview file sitting next to the LoRA** (upstream's `find_preview_path` / `/lora/thumb`), so the
  picker stays **fully offline** — no Civitai involved. A LoRA with no preview gets a neutral placeholder
  rather than a broken frame, and the second line says `no preview`. This is the fastest way to identify a
  LoRA: filenames in a real `models/loras` are near-identical, and a picture is not.
- The search field lives **inside** the panel at the top, with a magnifier glyph, and takes focus on
  open. Typing searches **flat across every LoRA**, so the group headers collapse away while filtering
  (they only mean anything in the unfiltered tree).

### 1a-vi. Can we know a LoRA's CATEGORY? Yes — from exactly one place (investigated 2026-07-29)

Asked by the owner, and worth answering precisely because the obvious assumption (it's in the file) is
wrong.

**The file's own safetensors metadata has NO category field.** What it does carry, all readable offline:

| available in the file | key |
|---|---|
| base-model family | `modelspec.architecture`, `ss_base_model_version`, `ss_sd_model_name` |
| network type (LoRA / LyCORIS …) | `ss_network_module` |
| rank / alpha | `ss_network_dim`, `ss_network_alpha` |
| training-image count, date | `ss_num_train_images`, `modelspec.date` |
| trigger phrase | `modelspec.trigger_phrase`, `ss_trigger_words` |
| **training tag frequencies** | `ss_tag_frequency` |

No `category`. Nothing standard says "this is a character LoRA".

**A real category exists on Civitai, as the model's `tags`** — `character`, `style`, `concept`,
`clothing`, `poses`, and so on. Two things to know:

- ⚠️ **Upstream's parser discards them.** `parse_civitai_modelversion` keeps
  `{name, type, base_model, triggers, thumbnail, model_id, version_id}` — and its `type` is the *model
  type* (LoRA / LyCORIS / Checkpoint), **not** a category. **Our parser must keep `tags`.**
- The **raw** Civitai response is already cached in the `<base>.civitai.info` sidecar, so tags can be
  extracted for anything already looked up — **no re-fetch, and no network** once the sidecar exists.

So, honestly:

| source | coverage | needs network? |
|---|---|---|
| **subfolder** (`loras/character/…`) | only if the user organises that way — but many do | no |
| **Civitai `tags`** | only after a successful hash lookup; absent for local, merged, re-saved or unpublished LoRAs | once, then cached |
| ~~`ss_tag_frequency` heuristics~~ | **rejected** — see below | no |

**Decision: group by subfolder by DEFAULT, offer "group by category" when tags are known, and show a
category chip on an entry that has one.** Subfolder is the only grouping that always works and needs
nothing; category is strictly better when present, so it is an option rather than the default.

**Explicitly rejected: guessing a category from `ss_tag_frequency`.** A LoRA whose top training tags are a
character name is *probably* a character LoRA — and "probably" is the problem. A wrong category is worse
than none, because a user filtering by it would silently not see LoRAs that are actually there. **Never
invent a category; show nothing when we don't know.** (`no preview` sets the same precedent, §1a-v.)

### 1a-vii. Show the CIVITAI name instead of the filename — a setting (owner, 2026-07-31) — BUILT 2026-08-01

Owner: *"in the select lora we should show the name in civitai (e.g. the one we downloaded and not the
filename), this should be configuration that user can change."*

Today the picker row renders `displayModelName(model.name, hideExtension)` (`model_picker.mjs:378`) —
the **filename**, optionally minus its extension. A file called `real_skin-step00000200.safetensors`
tells you much less than *"Realistic Skin Detail"*.

> ### ⚠️ The one non-negotiable: this is a DISPLAY change only
>
> The filename is the **identity** — it is what the node state persists, what the picker returns on
> pick, what `resolve_model_path` resolves, and what a saved workflow carries to another machine. A
> display name must never reach any of those. If a workflow ever starts storing *"Realistic Skin Detail"*
> where `real_skin-step00000200.safetensors` belongs, it breaks on every machine including its own, and it
> breaks quietly. Change the label; change nothing else.

**Where the name comes from.** The Civitai record for a local file lives in its `<base>.civitai.info`
sidecar — the raw model-version response, from which `parse_model_version` already extracts a display
name (§7c-iv's second correction: the sidecar holds raw, parsing happens on read). The ⓘ panel already
prefers it: `model_info.mjs`'s `renderIdentity` does `civitaiName || prettyTitle(name)`. So the rule
exists and is proven; the picker simply has no access to it.

**It needs a backend field, not just a client cache.** `list_models_impl` returns filename entries only.
`civitai_api.mjs`'s `cachedCategoryTag` shows the client-cache route is viable and cheap, but that cache
is per-session and populated only for models whose ⓘ panel has been opened — a picker where a handful of
rows show real names and the rest show filenames reads as broken, not as progressive. Add the name to the
**list route**, read from each model's sidecar, so coverage is "every model that has ever been looked up
or downloaded" and is stable across sessions. Sidecar reads are local and already on the executor; if the
cost shows up on a large folder, cache per `(kind, mtime)` rather than dropping the feature.

**A download already knows the name — no lookup, no hashing** (owner: *"we get name with the search, when
downloading we can save it to the info json and use it, if it exist if not fallback to the filename"*).
This is not just true, it is **already written**: `civitai_parse.civitai_shape_from_search_meta:565-567`
maps the search result's own `name` into `model.name` in the sidecar shape, and that shape is read back
through the exact same `parse_model_version` a live by-hash lookup goes through. The code has simply never
run, because the frontend has never sent `civitai_meta` on `/download/start` — the wiring being added
alongside this makes it live.

So the population story is much better than "wait until the user opens ⓘ": **anything downloaded through
our browser gets its real name immediately and for free**, on the same request that fetches the file.

**Opening ⓘ backfills the rest** (owner: *"once someone click info for lora then we can update and apply
our setup in case it was not exist before"*). A model that arrived any other way — a manual copy, another
downloader, a file predating all of this — has no sidecar. Opening its ⓘ panel already runs the full
hash → fetch → **`sidecar.write_sidecar`** path (`lookup.py:243`), so the name lands on disk as a side
effect of something the user was doing anyway. **The backfill mechanism is already built; only the
refresh is missing.**

> **The one thing to add: invalidate the list cache after a lookup writes a sidecar.**
> `civitai_api.mjs` caches the model list per kind (`_listCache`, `:96`) and already exports
> `invalidateList(kind)` (`:156`). Without that call the newly-known name sits on disk, unused, until
> something else happens to refetch the list — so the feature would look broken in exactly the case the
> user just took an action to fix, which is the worst possible moment for it to look broken.

So the two population paths cover different populations, and together they compound: **downloads seed
names automatically; opening ⓘ backfills anything else, one model at a time, permanently.** A folder
therefore gets *better* the more it is used, with no scan step and no bulk job.

Deliberately **not** proposed: a background "scan the whole folder" pass. Each backfill costs a SHA256 of
a multi-hundred-MB file plus a network round trip, and doing that unprompted across a folder is exactly
the kind of thing §9's network policy exists to prevent. Keep it user-initiated. If bulk is ever wanted it
should be an explicit, cancellable, visibly-progressing action — a separate decision, not a default.

**Coverage is still partial, and the fallback must be silent.** Until a model has been downloaded through
the browser or had its ⓘ opened, it has no name. Fall back to the existing `displayModelName` with no
marker, no placeholder, no "unknown": the row must look intentional, not degraded. A user with a mixed
folder should not be able to tell which rows "failed".

**The setting.** A boolean in Settings → AnimaFlow → Controls, alongside the existing `Hide file
extension` it composes with, defaulting to **off** (filenames — today's behaviour, and the thing that
matches what is on disk). It should govern **every** name display in the Controls track, not the picker
alone: the picker row, the LoRA row's name field, and the ⓘ panel's title. One setting, one rule —
otherwise the same model reads by two different names on two surfaces, which is worse than either choice.

Two details worth settling while building rather than after: the row's name field is **ellipsis-truncated
at a fixed width**, and Civitai names are frequently longer than filenames, so check the truncation still
reads well and keep the full name in a `title` tooltip. And a **missing-file** row is rendered red by
filename (§1a-ii) — that state must keep showing the filename regardless of this setting, because the
whole point of that state is telling the user *which file on disk* is gone.

### 1a-iii. Reordering is DRAG; the menu keeps four of its six items (owner, 2026-07-29)

> ⚠️ **Correction (2026-07-29, found while building M1).** This section originally said the pack had no
> drag-to-reorder. **It does.** `wireGrip` (`js/controls/interaction.mjs:1019`) implements the gesture,
> `reorderRows` (`js/controls/rows.mjs:859`) is the pure array move, and `applyReorderLive`
> (`js/controls/interaction.mjs:1082`) reorders widgets **without touching row DOM** — which is what keeps
> the dragged row's pointer capture alive mid-gesture. Only the **FLIP animation** was genuinely new.
> M1 reuses `reorderRows` rather than writing a second array move.

Upstream's row menu, read off a reference shot, is **six** items — a source grep had shown me only four:

`ⓘ More info` · `↑ Move up` · `↓ Move down` · `⧉ Duplicate` · `◉ Disable` · `⌫ Remove`

**Drop only the two arrows.** Rows reorder by **drag-and-drop**, so ours is:

`ⓘ More info` · `⧉ Duplicate` · `◉ Disable / Enable` · `⌫ Remove`

**Why `More info` and `Disable` stay even though each duplicates a visible control** (the `i` button and
the row switch) — the distinction matters, because I nearly cut them by the same argument that removed the
arrows: a context menu is *the complete list of what you can do to this row*, and one that omits the
obvious actions reads as broken. The arrows are different: they were not omitted, they were **superseded**
by a better mechanism. Duplication of a *control* is fine; two competing *mechanisms* for reordering is
not.

`Disable`/`Enable` reads the row's current state rather than being a fixed label, so the menu never offers
an action that is already true.

What "animated" means concretely:

- the dragged row **lifts** — shadow, slight scale, reduced opacity — so it reads as detached;
- the other rows **slide** to open a gap, rather than teleporting (FLIP: measure, reorder, then
  transition `transform` from the old position to the new);
- on release the row **settles** into place instead of snapping;
- **animate `transform` only**, never layout properties — this is a DOM widget composited over a
  canvas, and layout thrash there is visible.

Three constraints, each already learned the hard way elsewhere in this pack:

1. **`stopPropagation` on the pointer handlers is load-bearing.** Without it litegraph steals the
   gesture and the drag never starts — exactly the lesson `generator-design.md` §7 records for the
   Preview's hover-wipe.
2. **Respect `prefers-reduced-motion`** ([`THEME.md`](THEME.md)) — reorder instantly, no transition,
   when it is set.
3. **The per-frame size correction must not fight the animation.** Class A rewrites `node.size[1]`
   every frame (`control-panel-design.md` §7a); a drag that changes row count mid-gesture, or a
   transition that briefly overlaps rows, must not cause a size oscillation. Row count does not change
   during a reorder, so the floor should be stable — but verify rather than assume.

> **Build the animation HERE first, and this is the reason:** the Control/Loader panels park each row's
> **output socket** at that row's Y (`vacantSlotY`/`alignOutputsLegacy`), so an animated reorder there
> must either move the sockets in step or freeze them until drop — sockets live on the node canvas, not
> inside the animating DOM. **This node has no per-row sockets (§5)**, so it can prove the animation
> with none of that risk, and the socket question becomes a separate, well-scoped port.
- **Missing files** turn the **whole name field red**, border included — re-checked on `R` (Refresh
  Node Definitions) **and on WebSocket reconnect** — the same moments native combos refresh —
  repainting every LoRA node, including ones inside subgraphs.

### 1a-ii. The header strip and row layout — corrected from a reference shot (2026-07-29)

Another case where reading the source under-described the UI. The corrected target is in the mockup:

- **ONE header row** (owner, 2026-07-29): `＋ Add LoRA` · master switch · `N/M` · ⚙. An earlier draft
  split this across two rows (full-width Add above, a switch strip below) — collapsed to one, because
  two rows of chrome above the first LoRA is a lot of vertical cost in a node whose height is
  content-driven (§6).
- **`＋ Add LoRA` is sized to its content plus padding, capped at 30% of the node width** — it does
  **not** flex to fill. The switch, counter and gear sit at the right, with the slack between them
  deliberately empty. Two reasons this matters more than it looks: a full-width primary button reads as
  the node's main action when the main action is actually *using* the LoRAs below it, and the node is
  **width-resizable** (§6), so a flexing button would grow without limit while the controls it shares a
  row with stay fixed. Cap it, and the row keeps its proportions at any width.
- **The counter is `2/3`, with no "on" word.** The switch beside it already says what the number is
  about; the label was redundant. It is also the only text in that row, so it stays compact.
- The switch reads **on only when EVERY row is on**; a mixed state shows it **off** with the counter
  carrying the truth. Clicking it when mixed *or* all-off turns **everything on** — the action you
  almost always want — and only turns everything off when everything already is. Without the counter,
  mixed would be indistinguishable from all-off, which is exactly why the count sits beside the switch
  rather than in a tooltip.
- **The row's on/off switch is on the RIGHT**, after the ⓘ — not leading the row. Order:
  **name ▾ · strength ▲▼ · ⓘ · switch**.
- **An off row is visibly dimmed** (name, strength, ⓘ recede) so a glance says what is actually
  contributing, with no need to read switch positions.

House-theme note: upstream's accent is red/orange, ours is teal (`THEME.md`). The mockup is teal
deliberately — only the *layout* is being copied, not the palette.
- **⚙ settings:** default strength, *"Show two strengths per row"* (collapse model/clip to one),
  trigger-words separator, **"LoRA memory use"** (`last` / `all` / `none`), and *"Set as default"*.
- **ⓘ panel:** trigger words read **straight from the safetensors metadata** (works offline); tick
  which words feed the `triggers` output, persisted per row; the **optional** Civitai lookup with
  four explicit states (searching / found / notfound / offline); toggle between file-derived and
  Civitai word sets with your *selections* surviving the switch; preview thumbnail; base-model
  family; delete the cached Civitai data to revert to the file's own words.
- **Outputs `triggers`** as plain text — the thing that makes it more than a stack.

### 1a-i. The ⓘ panel's real layout — four things a source read missed

Corrected from a live reference shot (owner, 2026-07-29). The first pass of this doc under-described
this panel; the layout is the approved target, in [`playground/lora-loader.html`](../playground/lora-loader.html).

Top to bottom: a **small inline thumbnail** (~58px) beside the **title**, with the **base-model family**
and the **full filename** stacked under it, then a **"View on Civitai ↗"** link, then the trigger-words
block, then the add-your-own field, then a **`Done` / `↻ Civitai`** footer.

**Three sections, separated by rules** (owner, 2026-07-29): a `<hr>` after the identity header and
another before `AUTHOR'S NOTES`. They are doing real work rather than decorating — the panel stacks
three things with genuinely different jobs (*what this LoRA is* · *what you're sending to the prompt* ·
*what the author says about it*), and the middle one is the only interactive one. Without the rules the
`from file` pill and the notes' `from Civitai` pill read as belonging to the same group, which is exactly
the confusion to avoid given they describe different sources. Style them `--wtn-line-soft`, matching the
card borders, so they separate without drawing attention.

The four features a source read did not surface, all worth keeping:

1. **The user can ADD their own trigger words** — a text field plus `Add`. This is the important one:
   the `triggers` output is **not** limited to what the file or Civitai provide. Custom words are part
   of the row's `triggers[]` like any other, so they persist with the workflow.

   **Chip affordances differ by origin, and the rule is a principle worth keeping** (owner reference
   shots, 2026-07-29): a **user-authored** chip carries an inline **`✕`** to delete it; a **file- or
   Civitai-derived** chip does **not**. You may delete what you wrote; the file's and Civitai's words
   are *candidates to select*, not data you own — deleting one would imply an edit to a source we don't
   control. Selection is additionally marked with a **`✓`** inside the chip, so selected-ness doesn't
   rest on colour alone. The `✕` must `stopPropagation` or clicking it also toggles the chip.

   Implementation note: a custom word is arbitrary user text, so write it with `textContent`, never
   `innerHTML`.
2. **`all` / `none` quick-select** beside the section label, as a **segmented button group** (owner,
   2026-07-29) rather than the text links upstream uses — it matches the pack's own segment vocabulary
   (`js/shared/fields.mjs`), and two adjacent bare links read as navigation.
   ⚠️ **It is an ACTION segment, not a mode segment**: neither button ever latches "on". Every other
   segment in this pack (memory mode, base model, sort, period) represents a *current selection* and
   keeps one button lit; this one fires and returns. Style it momentary — accent on `:active` only —
   or it will look like a state that has stopped responding.
3. **A source pill** (`from file` / `from Civitai`) rather than a segmented toggle — it states where the
   candidate words came from and switches the view, while *selections* survive the switch.
4. **The provenance rule is stated in the UI**: *"Tap the ones you want. Only these, and only if the
   LoRA is on, reach the triggers output."* That is §1b's rule surfaced where it matters instead of
   left as a surprise. Keep the wording close.

Empty state carries its own honest line — *"No trigger words in this file — add your own below, or try
Civitai"* — which names both remedies instead of just reporting nothing.

**Our addition: an `AUTHOR'S NOTES` section**, the §2 item 3 ask. Placed **after** the trigger-words
block and **collapsible**, for a specific reason: notes are reference material and can run long, so
putting them above the controls would push the actionable part off-panel, while a scrollable collapsed
block keeps the panel compact. It carries its own `from Civitai` pill, because unlike file-derived
trigger words the notes have exactly one source and the panel should not imply otherwise.

**The `↻ Civitai` footer button is the thing §7b's "Civitai lookup button" setting hides.** With that
setting off, this button does not render and the panel is fully offline — which is what makes offline a
posture rather than a failure.

### 1b. Two pieces of its Python worth copying for the reasoning, not just the code

- **Trigger words come only from rows that ACTUALLY APPLIED.** A missing, renamed, or corrupt file
  contributes nothing, so `triggers` can never claim words for a LoRA that isn't in the model.
  **Reversal, owner decision 2026-07-30:** this used to carve out an exception for a row
  deliberately parked at strength 0 (both `sm`/`sc` exactly zero) — the file resolved, so it was
  treated as "genuinely part of the stack" and its triggers counted, without a `cache.load` call
  (a real VRAM saving on a tight-memory box, since nothing was ever read off disk). The owner
  deleted that carve-out: **the switch alone decides whether a LoRA is applied.** A switched-on
  row is now always loaded and applied, whatever its strength — zero included — and only a
  missing file or a load/apply failure still contributes nothing. The tradeoff this reintroduces
  is explicit and accepted: a zero-strength row now reads its file from disk and holds it in the
  cache for a mathematically-unchanged (zero-weight) result.
- **The memory modes are subtler than they look.** In `last`/`none`, each entry loaded this run is
  released right after the *next* one applies, so a 10-row stack peaks at ~2 files rather than 10.
  Their own pre-release review caught `last` behaving like `none` for any 2+ row stack, because
  evicting the cross-run retained entry when the run's *first* row applied dropped the warm file
  moments before it would have been reused. Port the fix, not just the feature.

---

## 2. What it does NOT have — this is our actual work

Confirmed by enumerating its routes: `list`, `info`, `thumb`, `civitai`, `civitai_delete`. **There is
no search and no download.** So the owner's two headline asks are genuinely ours to build:

1. **Search Civitai from inside the node** — find a LoRA without leaving ComfyUI.
2. **Download to local**, the way **Civicomfy** does it — pick a result, fetch it into the right
   `models/` folder, use it immediately. ([MoonGoblinDev/Civicomfy](https://github.com/MoonGoblinDev/Civicomfy),
   **MIT**, verified 2026-07-29. Not a sibling clone here — pull it locally before porting and
   re-verify the licence at that point rather than trusting this line.)
3. **The author's own description**, not only numeric metadata — the notes saying how a LoRA is meant
   to be used. (Upstream's parsed record may already carry this; check `parse_civitai_modelversion`
   in `_lora_helpers.py` before building anything.)
4. **The same for models, not just LoRAs** — which is what makes this a **shared Civitai browser**
   consumed by two nodes rather than a LoRA feature.

### 2b. SETTLED: the Civitai metadata lookup needs NO API key

The board carried a key-resolution ladder as a prerequisite. For **metadata and previews it is not
needed at all.** Upstream's lookup is:

```
SHA256 the file  ->  GET https://<host>/api/v1/model-versions/by-hash/<sha>  ->  cache as a
                     <base>.civitai.info sidecar next to the LoRA
```

A public endpoint, no auth. Details worth copying verbatim:

- **Always answers HTTP 200**, with a `reason` of `found` / `notfound` / `offline`, so the frontend
  picks a card instead of parsing error codes.
- **Two hosts with fallback**, but a `404` returns immediately — it is definitive, and the backup
  host serves the same catalogue, so retrying is a pointless round trip. A non-200 *does* fall
  through (rate limit / maintenance are transient).
- **30s timeout, not 12s** — Civitai is regularly slow under load, and an early give-up reads to the
  user as "it doesn't work". The hash is already computed by then, so the budget is purely HTTP.
- **4 MB body cap** so a malfunctioning endpoint can't spike memory.
- **Distinct failure reasons preserved** — timeout vs DNS/TLS refusal vs an unreadable block page.
  Collapsing them into one generic line defeats the point of showing a reason.
- **A 200 with a usable record is FOUND even with no `trainedWords` and no `model.name`** — plenty of
  versions have neither. Requiring them threw away genuine hits *and* skipped the sidecar write, so
  every later click re-hashed the whole file and re-fetched.

**The key ladder therefore applies only to search and gated downloads** (§8).

---

## 3. State — a declared serialized STRING widget, NOT upstream's handshake

**This is the one place we deliberately fork from the node we're copying, and it is not a style
preference.**

Upstream declares `"hidden": {"LoraLoaderState": ("STRING", {"default": "{}"})}`, keeps state on
`node.properties`, and injects it into the prompt with a `graphToPrompt` hook. **This pack forbids
that pattern** — `.claude/skills/comfyui-dynamic-node-frontend/SKILL.md` §2 records it silently
failing in a real deployment: the on-node preview (computed client-side) looked correct while the
backend received the default `"{}"`.

**Why that failure mode is the worst possible one here:** the UI reads `node.properties`, so the node
renders your whole stack perfectly. Only Python sees `"{}"`. You would get rows on screen, an empty
`triggers` output, no LoRA applied, and no error — the only symptom being images that look slightly
off. It is exactly cause **C** in `comfyui-node-renders-but-dead`, filed there as *"the most
dangerous of the three, because nothing looks wrong on screen."*

Four concrete fragilities in the injection approach:

1. **The hook must survive.** Any extension replacing `app.graphToPrompt` without chaining silently
   removes yours. Order-dependent, no error.
2. **Prompt-ID matching is hard** — upstream maintains composite ids (`"5:"`-prefixed for subgraphs)
   plus a bare-id first-write-wins fallback, with a comment naming a real fix it needed. That
   machinery exists because the matching has already broken.
3. **Two sources of truth** — `node.properties` is what litegraph saves; the prompt value is
   *synthesized at submit*. They can diverge, and Python only ever sees one.
4. **API and headless runs get nothing.** POST a saved workflow to `/prompt` and there is no browser
   to run `graphToPrompt`, so every row is lost and the node returns the untouched model. This one
   matters here: the owner runs on Colab, and anything scripted or queued outside the browser would
   silently lose the whole stack.

**Their stated justification survives the change.** Their docstring argues that because the state is
part of the node's inputs, editing a row changes the cache signature so a run always picks up the new
value with no `IS_CHANGED`. That is true of a **declared widget too** — its value is part of the
prompt. Same benefit, none of the delivery risk; the `hidden` variant is strictly worse.

So, matching `panel_state` and `generation_settings`:

```python
"required": { "lora_state": ("STRING", {"default": "{}", "tooltip": "..."}) }
```

hidden for **rendering only** by the frontend, written after every mutation. Three consequences:

- **Widget order is append-only** (`9388cf9` broke this once) — `lora_state` holds a position.
- **Hiding is a JS responsibility.** If the JS dies the raw blob shows on the node — ugly but honest,
  and a genuinely useful failure signal (that is how a dead extension was spotted in one glance on
  2026-07-29).
- **The blob is definitely in the saved workflow.** Which is exactly why §8's rule that an API key
  must never live in it is load-bearing: the Preview embeds the workflow into saved PNGs, so a key
  there leaks into every shared image.

**The state SHAPE is worth adopting as-is** — per row `{id, name, on, sm, sc, triggers[]}`, plus
`cacheMode` and `sep` at the top level. Normalization must be tolerant and additive (unknown keys
pass through, missing keys default), same contract as `_rows_helpers.py`'s `parse_state`.

---

## 4. Node surface

| | name | type | notes |
|---|---|---|---|
| required | `model` | `MODEL` | every switched-on LoRA is applied to it |
| required | `lora_state` | `STRING` | §3 — hidden for rendering, natively serialized |
| optional | `clip` | `CLIP` | **must be `optional`** — a required socket hard-fails the queue when unwired |

Outputs: `MODEL`, `CLIP`, `triggers` (`STRING`). CLIP passes through unchanged when unwired.

**The subtle wiring trap, worth putting in the node's DESCRIPTION:** route the **patched** `CLIP`
onward to your text encode, not the loader's raw one. Wire the raw one and the LoRA's *model* effect
still lands while its *CLIP* effect vanishes — no error, just a weaker result and trigger words that
read differently than intended. (Same warning as `generator-design.md` §5b.)

### 4a. Category and file placement — no new auto-loaded `.js`

**`AnimaFlow/Controls`**, with the frontend in **`js/controls/`** and the node in
**`nodes/controls/`**. Reasoning:

- It is a sibling of `AnimaLoaderPanel` — both are "pick model files and hand them downstream".
- A fifth picker topic would be an invention; `generator-design.md` §5 rejected `Generate` for
  exactly that reason, and `AnimaFlow/Panel` is reserved for the deleted webtoon line.
- **It costs zero against the 5-auto-loaded-`.js` ceiling**: `js/controls/index.js` already registers
  two node classes and would register a third. The shared Civitai browser is then a `.mjs` both this
  node and the Loader Panel import — which is also why putting them in the same folder is convenient
  rather than merely tidy.

---

## 5. SETTLED: this is NOT a layer-3 socket-rows consumer

The board assumed a row-based node would be the **third** consumer of the socket-per-row mechanism and
would therefore trigger the deferred `js/shared/socket_rows.mjs` move. **It does not.**

Upstream's node has **three fixed outputs** (`MODEL`, `CLIP`, `triggers`). Rows are plain list
entries with **no socket of their own** — nothing to park, no per-row slot, no hole compaction. Ours
mirrors that.

So: **the layer-3 trigger does not fire, and that deferral stands untouched.** Do not restructure
`js/controls/rows.mjs` for this node. (If a future design ever wants a per-LoRA output socket, *then*
the trigger fires — but nothing here asks for one, and no upstream node emits a `LORA_STACK` object
anyway; see `generator-design.md` §5b.)

---

## 6. Sizing — Class A, but for a different reason than the panels

Per [`control-panel-design.md`](control-panel-design.md) **§7a**: content-fixed height, width
resizable with a min. Same as the two panels and the same as upstream, which the owner confirmed by
inspection ("they don't give option to change height").

**Be precise about why**, because §7a's justification does not apply here: the panels are Class A
because each row parks its output socket at that row's Y, so a scrolling body would slide rows off
their sockets. **This node has no per-row sockets (§5), so it *could* scroll** — Class A is the
owner's preference for a row-list node, not a structural necessity. Recording the distinction so
nobody "corrects" it later by pointing at the socket argument and finding it absent.

⚠️ **Read `.claude/skills/comfyui-litegraph-node-sizing/SKILL.md` before writing a line of sizing
code.** Class A takes **four** layers, and getting one of them wrong fails silently — that cost five
wrong diagnoses on 2026-07-29. In particular: `node.size` is a **`Float64Array`**, so `Array.isArray`
guards are dead code; `onResize` is never called on the drag path; and `getMaxHeight === getMinHeight`
via `addDOMWidget` is the only real height lock.

---

## 7. The shared Civitai browser

**Ships under THIS node (owner, 2026-07-29 — see §9).** The Loader Panel reuses it afterwards, scoped
to **checkpoints/models and UNET only** for that first reuse pass.

A `.mjs` library plus its aiohttp routes. Not a LoRA feature — that is the whole point of item 4 in §2.

### 7a. Parameterise by KIND on day one, wire only `loras`

Shipping under one node while planning reuse has exactly one trap: building the library
LoRA-shaped and refactoring later. **Don't.** Take a `kind` from the start — `loras`,
`checkpoints`, `unet` — and wire only `loras` in this milestone. Cheap now, expensive to retrofit,
because *every* layer varies by kind:

| varies by kind | why |
|---|---|
| the ComfyUI folder key | `folder_paths.get_full_path("loras" \| "checkpoints" \| "diffusion_models", …)` — not the same string, and `unet`/`diffusion_models` has changed name across versions |
| the download destination | `models/loras/` vs `models/checkpoints/` vs `models/unet/` |
| sidecar location | `<base>.civitai.info` sits next to the file, so it follows the folder |
| the Civitai `type` filter | the search request must ask for LoRA vs Checkpoint |
| plausible file size | a LoRA is tens of MB, a checkpoint is single-digit GB — progress UI, timeouts and disk-space checks all differ in scale |

> 🔒 **The `kind` must be validated against a whitelist server-side, never used raw.** These routes
> resolve paths and (for download) **write files**, so a client-supplied folder key is a directory
> traversal waiting to happen. Map `kind → folder key` from a fixed dict and reject anything else,
> and keep upstream's path-guard-to-the-known-model-dirs check on every resolve.

`hasLora()`-style presence checks become `hasFile(kind, name)`. Upstream's client-side caching shape
(`invalidateInfo` / `invalidateList` / the "unknown, not missing, before first load" rule that stops
false ⚠ marks) generalises unchanged — just keyed by `(kind, name)`.

Surface, mirroring upstream's client-side caching (`api.mjs`'s `invalidateInfo` / `invalidateList` /
`hasLora` shape, which exists to avoid false "missing" marks before the first load):

| operation | key needed | notes |
|---|---|---|
| local file list | — | with missing-file marks, re-checked on `R` and on WS reconnect |
| metadata + preview by hash | **no** (§2b) | sidecar-cached, offline-capable |
| **search** | maybe (§8) | new; not in upstream |
| **download** | maybe (§8) | new; server-side Python only — the browser cannot write to `models/` |

**Spillover into the Loader Panel**, worth lifting even before this node exists: the searchable
picker, missing-file marks, the description/metadata panel, the downloader, and the memory-mode idea.

> ⚠️ **Correction (2026-07-29, found while building M1).** This paragraph used to say "our loader helpers
> already cache per `(kind, name, dtype)`". They do **not**. `_CACHE`
> (`nodes/controls/_loaders_helpers.py:48`) holds **exactly one entry per kind** — changing a name
> *overwrites* that kind's single slot — and that is a deliberate anti-VRAM-leak choice, with the
> rationale at `:15-27`. There is no LRU to build on, so the LoRA memory modes implement their own
> policy rather than layering onto an existing one.

---

## 7c. THREE surfaces, one library (owner, 2026-07-29)

The browser is mounted three times with different **scope** and different **intent**. Scope is a
parameter, never a fork — §7a's `kind` plumbing is what makes this cheap.

| surface | scope | intent | primary action |
|---|---|---|---|
| **LoRA Loader** node | `loras` **only** | "fill this row" | download **and select into the row that opened it** |
| **Loader Panel** | **models only** (checkpoint / UNET) | "fill this loader" | download **and select into that slot** |
| **Toolbar modal** — NEW | **unscoped** | "browse Civitai" | download to the correct folder, derived from the result's own type |

The distinction that matters: the two **node-embedded** surfaces are *pickers* — kind-locked, and they
return a value to the caller. The **modal** is a *browser* — it answers to nobody and its result lands
on disk, with the destination folder taken from the result's type rather than from whoever opened it.
Build the picker path first (it is what milestone 2 needs); the modal is milestone 2b.

### 7c-i. All three get the FULL filter set (owner, 2026-07-29)

An earlier draft of this section called the pickers "narrow", which wrongly implied fewer features.
**It does not.** Search, filters and results are the same everywhere — the differences are only *scope*
and *outcome*:

| filter | picker (node) | modal |
|---|---|---|
| **type** | **locked** to the caller's kind, shown but not changeable | free |
| base model (SD1.5 / SDXL / Pony / Flux / Illustrious …) | ✅ | ✅ |
| sort (Relevancy / Most downloaded / Highest rated / Newest) | ✅ | ✅ |
| period (Day / Week / Month / Year / All time) | ✅ | ✅ |
| ~~NSFW~~ → **maximum browsing level** (PG / PG-13 / R / X / XXX) | ✅ | ✅ |

> The NSFW **checkbox** is superseded by a five-level selector — see **§7c-iv**, which also explains why
> the level cannot be a server-side filter and what that forces. The row above is the only change to
> this table.

So exactly **one** filter behaves differently, and it is the one implied by the mount point: a LoRA
Loader's picker cannot search checkpoints, because it could not do anything with the result.

**Layout differs, feature set does not.** The modal has room for a filter **rail** (~216px). A node
panel is ~340px wide, so the same filters render as a **compact row of dropdown pills** — a rail there
would eat the results. Do not drop filters to fit; change their presentation.

#### An explicit `Search` button, not a debounce (owner, 2026-07-31) — SPEC, not built

Owner: *"add delay to user search before searching — even better I would add a button next to the search
field 'Search' which will only then execute search, and if value didn't change since last time search
it's disable state."*

Today typing re-searches on a debounce, so a ten-character query can cost several round trips to Civitai,
each one burning §9's rate limiter and returning results nobody read. Replace it with an explicit action:

- **A `Search` button beside the field.** Nothing fires from typing at all — not on a timer, not on
  blur. **Enter in the field runs the same action** (an explicit button that keyboard users cannot reach
  is a downgrade for them).
- **Disabled when the query text is unchanged since the last executed search**, so the control states
  "there is nothing new to fetch" rather than letting the user re-spend a request on the same thing.
  Disabled is also the resting state on open once the initial search has run.
- **Filters keep searching immediately on change.** A filter is one discrete choice, not a keystroke
  sequence — there is no burst to suppress, and making sort/period/level need a second click would be
  worse than what we have. Each filter-triggered search **updates the last-searched query text**, so the
  button correctly settles back to disabled afterwards.
- **Pagination is untouched** — loading page two is not a new search and must not depend on the button.

Applies to **both** surfaces, the anchored panel and the modal, from one implementation.

Note this makes the debounce timer redundant on the query path; remove it rather than leaving a dead
timer that still fires.

#### The modal's filter rail — select-adds-a-chip, NOT a chip grid (owner, 2026-07-29)

Civitai's own rail is the reference for *structure* — collapsible sections, `Sort models by` /
`Filter by Base Model` / `Filter by Model Type` — but **not for the model-type control**, which they
render as a grid of ~19 always-visible chips (Aesthetic Gradient, Checkpoint, Controlnet, Detection,
DoRA, Hypernetwork, LoRA, LyCORIS, Motion, Other, Poses, Text Encoder, Embedding, UNet, Upscaler, VAE,
VLM, Wildcards, Workflows).

> ⚠️ **That chip list is UI LABELS, not API values — read off a screenshot of the rail, not a live
> request — and two of them are wrong as literal `types=` values (caught building M2b, verified live
> 2026-07-31).** `LyCORIS` isn't a real API enum value at all (the API's own value for that model
> family is `LoCon`); `VLM` should be `VisionLanguage`. Civitai's actual `types` enum (22 values,
> verified via the 400 `ZodError` body an invalid `types=` query returns — that response enumerates
> every accepted value, and is how to re-verify this the next time it drifts, rather than
> transcribing the rail again) is: `Checkpoint, TextualInversion, Hypernetwork, AestheticGradient,
> LORA, LoCon, DoRA, Controlnet, Upscaler, MotionModule, VAE, TextEncoder, UNet, CLIPVision, Poses,
> Wildcards, Workflows, Detection, VisionLanguage, CLIP, LLM, Other` — see
> `src/model_browser/civitai_search.py`'s `VALID_CIVITAI_TYPES` (the validated whitelist a client-
> supplied `types` value is checked against) for where this list actually lives and is tested. Whoever
> wires the modal's `<select>` options should use THAT list's values on the wire, with this section's
> chip labels only as display text.

**Ours: a `<select>` per multi-value filter, and choosing an option appends a removable chip directly
under that section.** The reason to diverge is that a 19-chip grid *dominates the rail* and, worse,
leaves no way to see what is actually **applied** at a glance — every chip is present whether or not it
is active, so "on" is carried only by highlight. A select keeps the long list collapsed and the chips
below it show **only the active filters**, so the rail reads as *what am I filtering by right now*.

| filter | control | multi-value? |
|---|---|---|
| Sort models by | plain `<select>` | no — single choice, no chips |
| Period | plain `<select>` | no |
| Filter by Base Model | `<select>` → chips | **yes** |
| Filter by Model Type | `<select>` → chips | **yes** |
| Maximum browsing level | plain `<select>` (PG → XXX) | no — single choice, no chips (§7c-iv) |

Details worth fixing now: selecting resets the `<select>` to its "Add a …" placeholder so it reads as an
*action* rather than a current value, and a duplicate selection is a no-op.

> **REVERSED 2026-07-31, owner, from the built rail.** This previously required *"an empty group shows a
> faint `any` so 'no filter' is stated rather than blank."* It does not: the `<select>` directly above
> already reads *"Add a base model…"*, so `any` restates the control and costs a second line of text per
> section for nothing. **An empty group renders nothing.** Three further corrections from the same look:
> **no card/box chrome per section** — five bordered panels stacked read as five widgets rather than one
> rail, so headings and spacing do the separating; **the open `<select>` shows a `✓` against
> already-selected values** (a prefix on the option's own text — a native `<select>` cannot render markup
> — so the dropdown states current selection instead of making the user read it off the chips); and **no
> header subtitle** on the modal (`unscoped — every supported type` is dropped; the title suffices).

**Every filter chip carries an `✕`**, which is consistent with §1a-i rather than contradicting it: there,
the `✕` marks a word *you* authored versus one the file supplied. In the rail **every** chip is user-put,
so they all get one. The rule is the same — the `✕` means "you put this here" — it is just that the rail
has no other kind of chip.

**Filter choices are remembered user-wide, in Settings → AnimaFlow — not in the node's state blob.**
They are a browsing preference, not node behaviour, and per §7b that is the boundary. It also means the
picker and the modal open with the same remembered filters, which is the behaviour you want: it is one
browser with three mounts, not three browsers.

### 7c-ii. The node's picker opens a VERTICAL info panel (owner, 2026-07-29)

Clicking a result in the node's 🔍 picker opens **a new panel showing that model's information, laid out
vertically** — a sibling of the ⓘ panel, in the same narrow floating-panel idiom the node already uses.

**Not** an in-panel swap (drafted, rejected) and **not** the 90% modal (drafted, also rejected). The rule
that falls out of it, and the reason this is worth stating as a principle:

> **The node's surfaces are narrow vertical panels. The toolbar modal is the only wide surface.**

That is why a wide layout does not belong here: everything a user opens *from the node* — the picker, the
ⓘ panel, the ⚙ dialog, and now this — is a panel beside the node, so a fourth one should read the same
way. Sending a click from a node panel into a 90% modal is a much larger context jump than the action
warrants.

Layout, top to bottom, in the ⓘ panel's own idiom (§1a-i):

```
thumbnail + title + creator          identity
View on Civitai ↗                    §7d
──────────────────────────────────   <hr>
Version  [ v3.0 — 144 MB      ▾ ]
[ ↓ Download & use in this row ]     primary action -- returns to the row (§7c)
author's description
──────────────────────────────────   <hr>
COMMUNITY IMAGES                     ONE column, stacked; prompt on hover + copy
  [ image ]
  [ image ]
  ← back to results
```

**The gallery is a single stacked column here**, which is the point of "vertical": in a narrow panel one
image at readable width beats two cramped ones, and the prompt overlay has room to be legible. The
**modal's** detail keeps its multi-column grid (decision 11) — same data, same component, two layouts
chosen by which surface is hosting it.

`← back to results` returns to the picker's result list, with the query and filters intact.

**Milestone note (supersedes the earlier dependency warning):** because this panel is *not* the modal,
**M2 no longer depends on M2b.** The node's search, results and detail are all self-contained in M2; the
toolbar modal remains purely additive.
### 7c-iii. A search result card has FOUR states (owner, 2026-07-30)

Read off [`playground/lora-loader.html`](../playground/lora-loader.html) — the mockup specifies all four,
in both the node's picker and the toolbar modal. Same states, same labels, two layouts.

| state | mockup renders | **our label** |
|---|---|---|
| already on disk | `✓ have`, no download button | **`✓ installed`** — owner, 2026-07-30: "have" is vague, "installed" says what it means |
| in flight | progress bar + `downloading 38%` + cancel | unchanged |
| available | `↓ get` | **`↓ Download`** — owner, 2026-07-30: "get" is coy; name the action |
| gated | padlock + `needs an API key` + an **amber** `key required` button | unchanged |

Three things this table is load-bearing for:

- **The gated state is a first-class outcome, not an error path** (§8). A result must be known to be gated
  **before** the user clicks, so the card renders `key required` up front rather than discovering it on a
  failed download. The search response therefore has to carry that flag, and a key-less download attempt
  must return a *distinct* machine-readable reason rather than folding into a generic failure — the same
  discipline `civitai_client.py` already applies to timeout / DNS / unreadable / 429.
- **`installed` is driven by the presence check**, which is why the downloader's `.part`-then-atomic-rename
  rule is not merely tidy: a partial download that registered as present would label a truncated,
  unusable file `installed`.
- The mockup also shows **`No API key set — public results only.`** above the results, and the modal
  carries a `public mode` badge — the public-only posture is stated, never silently degraded (§8).

> ⚠️ I initially reported that the mockup did not specify an already-present state. **It does** — `✓ have`,
> on the first result card. Read the mockup before claiming it is silent on something; grepping it for the
> word you expect is not the same as looking at it.

### 7c-iv. Browsing LEVEL replaces the NSFW checkbox (owner, 2026-07-31) — BUILT, owner-confirmed

**Supersedes** the `NSFW ✅` row in §7c-i's filter table and the `Show NSFW | switch` row in the modal
rail table. Everything else in §7c-i stands.

#### What went wrong, and what the API actually allows

Owner: *"we got some lora (NSFW with no thumbnail) but when turning on nsfw thumbnail exist… lets check
why nsfw is false."* Two separate findings, both **measured live against `civitai.com/api/v1/models`**
on 2026-07-31, not inferred:

**1. Civitai's model-level `nsfw` boolean is not an adult flag.** Twelve LoRAs from one query all
reported `nsfw: False` while carrying `nsfwLevel` values of 15, 23 and 31. The bool is legacy;
**`nsfwLevel` is the real signal** — a bitmask: `1 PG · 2 PG-13 · 4 R · 8 X · 16 XXX` (`32 Blocked`,
never browsable). We parse `item.get("nsfw")` at `civitai_search.py:341` and **discard `nsfwLevel`
entirely**, at both model and image level. That is the root gap.

**2. The `nsfw` request parameter is binary, and there is no level parameter.** Measured:

| request | images returned |
|---|---|
| `nsfw=false`, or the parameter omitted | levels `[1]` only |
| `nsfw=true` | levels `[1, 2, 4, 8, 16]` |
| `browsingLevel=31` · `nsfw=16` · `nsfw=X` | **HTTP 400** |

So `nsfw=false` does **not** hide adult models — it returns them with the gallery *trimmed to level 1*.
A model with no level-1 image therefore arrives with an **empty gallery**, and gets no thumbnail. Flip
the checkbox on, its level-2 images come back, our own filter accepts those, and a thumbnail appears.
That is exactly the reported behaviour, and it is Civitai's doing, not a bug in our parsing.

**The consequence that decides the design: a level selector cannot be a server-side filter.** It must be
client-side, which requires fetching the full gallery first. The owner's two proposals ("switch to a
level selector" and "always fetch everything, lock what's above") are therefore not alternatives —
the first *requires* the second.

#### The design

**One setting replaces the checkbox: `Maximum browsing level`**, five choices, remembered user-wide in
Settings → AnimaFlow like every other filter (§7c-i's last paragraph).

| level | request sent | filtering |
|---|---|---|
| **PG** (default) | `nsfw=false` | none needed — the server never sends adult content |
| PG-13 · R · X · XXX | `nsfw=true` | client-side, to the chosen maximum |

**The lowest setting is a genuine server-side guarantee, not a cosmetic one.** That asymmetry is
deliberate: at PG we never ask for adult content at all, rather than downloading it and choosing not to
render it. Above PG, precision the API cannot give us is worth the trade.

**State the trade honestly:** at any level above PG, explicit image **URLs and model titles** arrive in
the payload even when browsing at R. No explicit image is ever *fetched* — the browser only requests
bytes for a URL we put in `src`, and we never do for an over-level image. But **titles must be filtered
client-side by the model's `nsfwLevel`**, or an XXX model's name appears in an R-level list.

#### Thumbnail selection, and where the thumbnail comes from

Unchanged mechanism, newly level-aware.

**We use the URL Civitai gives us — we do not build one.** Every gallery entry in
`modelVersions[].images[]` carries a `url`, and we take it verbatim. The only change is a **single
path-segment substitution** on that string: `_thumb_url` (`civitai_parse.py:221`) rewrites
`/original=true/` to `/width=256/`, asking the CDN for a smaller rendition of the same image. The hash,
UUID and filename are never parsed or reassembled, and a URL not matching that pattern passes through
untouched.

```
from response : https://image.civitai.com/<hash>/<uuid>/original=true/1917130.jpeg
after rewrite : https://image.civitai.com/<hash>/<uuid>/width=256/1917130.jpeg
```

**Measured live 2026-07-31** (one real LoRA gallery image, both HTTP 200):

| | Content-Type | bytes |
|---|---|---|
| `original=true` | `image/png` | **4,192,036** |
| `width=256` | `image/jpeg` | **20,522** |

That is **204×**, well beyond the ~1.5 MB → ~55 KB Pixaroma measured — `original=true` returns the
uploader's source file, so it can be arbitrarily large. Two consequences:

- **The rewrite is load-bearing, not an optimisation.** A results page of 20 cards at original size
  would be ~80 MB.
- ⚠️ **Revisit what the download-time preview sidecar saves.** `preview_url` currently keeps the
  *untransformed* URL, so a saved preview can be a 4 MB PNG per model. That was specified when the cost
  was assumed to be ~1.5 MB. A mid-size transform (`width=450`, say) is very likely the right choice for
  a file kept on disk — **owner's call**, and it is the same open question as "does the sidecar follow
  the browsing level".

We depend on the CDN continuing to honour `/width=<n>/`. If that ever changed, the rewritten URL 404s
and `buildThumb`'s `onerror` falls back to the placeholder — degraded, not broken, but **silently**, so
it would present as "thumbnails stopped working" with no error.

The selection rule becomes: **the first image whose `nsfwLevel` is at or below the user's chosen
maximum**, rewritten to width 256. This replaces `pick_gallery_image_url`'s current two-tier
"explicitly safe, then merely not-adult" fallback, whose hardcoded level-4 cutoff becomes the level
selector's job.

- `pick_gallery_image_url` is also used for the **download-time preview sidecar**. Decide explicitly
  whether that one follows the browsing level or always takes the best available image; they are
  different questions (one is display, one is a file the user keeps).

#### ⚠️ Why some thumbnails fail today: VIDEO entries — and the one-parameter fix (measured 2026-07-31)

Owner: *"some fail to load… this url return 301 and we don't show thumbnail… maybe there is a different
issue and my direction is just a workaround."* Correct on the last point. **Two plausible causes were
measured and both are dead ends — do not re-investigate them:**

- **The 301 is normal.** Every `image.civitai.com` transform URL 301s to
  `image-b2.civitai.com/file/civitai-media-cache/…`. Following it yields `200 image/jpeg`. `<img>`
  follows 301 transparently. The reported URL works.
- **`referrerpolicy="no-referrer"` is not hotlink-blocked.** Identical `200`/byte count with no
  `Referer`, with `civitai.com`, and with `localhost:8188`.

**The real cause: a gallery entry can be a VIDEO.** A burst of 20 thumbnail requests failed
**1/20, identically in all three trials** — not a flaky network, one specific entry. It is
`type: "video"`, an `.mp4`, on a WAN-style LoRA. Applying `width=256` to an mp4 makes the CDN transcode
*video* (`200 video/mp4`, 1.66 MB, often timing out), and an `<img>` cannot render that anyway. **A
retry does not help** — measured: 0 of the failures recovered on a second attempt, which is exactly how
a permanently-unusable entry differs from a flaky one.

> An earlier note in this section called the video case hypothetical, on the strength of a 252-image
> sample that was 100% `type: "image"`. That sample was LoRA/Newest and simply contained no
> video-preview models. **It is real, and it is the bug.**

**The fix is one parameter: put `anim=false` in the transform.** Measured on the failing mp4 and on a
still image:

| URL | result |
|---|---|
| `…/width=256/135268953.mp4` | `200 video/mp4` · 1,663,240 bytes · unrenderable in `<img>` |
| `…/anim=false,width=256/135268953.mp4` | **`200 image/jpeg` · 64,550 bytes — a poster frame** |
| `…/anim=false,width=256/<still>.jpeg` | `200 image/jpeg` · 28,370 bytes — byte-identical to without it |

So `anim=false` is a **no-op on stills and a poster-frame extractor on videos**. `_thumb_url` should
emit `/anim=false,width=256/`, and video entries then get a real thumbnail instead of being skipped.

#### The level governs the ⓘ panel too — a THIRD consumer, on a different path (owner, 2026-07-31)

Owner: *"our NSFW config should affect the lora info too."* Correct, and it is not the same code path,
so it does not come for free.

There are **three** independent image-selection sites, and it is worth naming all three because two of
them are easy to forget:

| surface | picks via | level-aware? |
|---|---|---|
| search result card | the new `images` candidate list | ✅ this task |
| **ⓘ info panel** (58px thumb) | ⚠️ **the LOCAL preview file** — `thumbUrl(kind, name)`, `model_info.mjs:701` — see the correction below | ✅ **this section** |
| **download-time preview sidecar** | `pick_gallery_image_url` (untransformed) | ✅ **owner decided 2026-07-31: "all 3 should be level aware"** |

##### The setting is GLOBAL, and must be named that way (owner, 2026-07-31)

Owner: *"lets add the NSFW level to our settings (so it will be global settings for all places that load
images)."* It already is one — `d1274a4` registered it in Settings → AnimaFlow → Controls and the panel's
own dropdown reads and writes that same value, so there is no per-surface copy. But two things about it
are now wrong and should be fixed together:

- **The id and label say "search".** `AnimaFlow.Controls.CivitaiSearchLevel` / *"Civitai search: maximum
  browsing level"* was accurate when only the search panel used it. It now governs the ⓘ panel and the
  saved preview as well, and by owner intent **every surface that loads an image**. Rename to a
  scope-neutral id and label, and say in the tooltip that it applies everywhere.
- **The dead `Civitai search: show NSFW` boolean is still rendered** in the dialog, with a tooltip
  admitting it does nothing. A visible control that does nothing is worse than no control: keep the id
  and default registered so an already-saved value is not discarded, but **drop its dialog entry** so it
  stops being offered.

Renaming the id orphans any saved value, so the level resets to its PG default once. That is acceptable
**only because the setting is a single commit old**; the same rename in a month would not be. Settings
ids are otherwise append-only, for the same reason widget order is.

Restating the boundary this setting does *not* cross, since "global" invites the mistake: it governs what
we **fetch and show from Civitai**. It never filters a file already on the user's disk — see the
four-source table above.

##### The sidecar's level applies at SAVE time, not display time

These are not in tension with the "never filter what the user already has on disk" rule below — they are
the two halves of it. **Choosing which image to download is a fetch, and fetches obey the level. Once the
file is written it is a local file and is shown unconditionally.**

Two consequences, both deliberate:

- Download at PG and later raise the level, and the saved preview stays the PG one. **Do not re-fetch it**
  — the user has the file; silently replacing it later would be worse than leaving it.
- If **no** candidate passes the level, **no preview is saved.** A missing preview is correct here, never
  a fallback to an over-level image.

##### The ⓘ backfill must save the image too, not just the metadata (owner, 2026-07-31)

Owner: *"are we saving the image (thumbnail in full size) together with the lora (with `.preview.jpeg`)?
if not we should (instead of hitting the civitai all the time)."*

**One of the two paths does; the other does not.**

| path | sidecar | preview image |
|---|---|---|
| download through our browser | ✅ | ✅ `download.py:874` writes `<base>.preview.<ext>` from a Content-Type map (`:776-778`) landing on exactly `find_preview_path`'s first-priority extensions |
| **ⓘ lookup / backfill** | ✅ | ❌ **`lookup.py` contains zero references to preview or image saving** |

So a model backfilled by opening ⓘ gets its metadata cached and then **re-fetches its image from Civitai
on every single render, forever**. This is also the direct cause of the owner-reported 404 on
`/wtn/model_browser/thumb?kind=loras&name=…`: that route serves the *local* preview file, and nothing had
ever written one.

**Fix: the backfill saves the image the same way a download does** — whatever `civitai_parse.
saved_preview_url` resolves to (⚠️ superseded below: as of 2026-07-31 that's the untransformed original for
a still, deliberately no longer the ~4 MB source's `width=450` shrink this paragraph originally specced —
downscaling for the small on-screen box moved to `/thumb`'s serve-time step instead), same `.preview.<ext>`
naming so `find_preview_path` picks it up with no changes.

**Which image, and who chooses.** The same rule the download already uses: **the frontend sends the URL of
the candidate it is displaying**, which is level-filtered by construction. Do *not* teach `lookup.py` what
a browsing level is — one rule, one place, and the server stays level-agnostic. So this is a small
explicit "save this preview" step the frontend issues after a lookup resolves, mirroring the download
payload exactly, rather than something the lookup route decides on its own.

Four constraints:
- **Never overwrite an existing preview.** A file already on disk is the user's, whatever wrote it.
- **A failed image fetch must not fail the lookup.** The metadata is the valuable part; the image is an
  optimisation. Log and move on.
- **No candidate passes the level ⇒ save nothing.** Same rule as the download path.
- **§9 holds:** this is user-initiated (they clicked ⓘ), one extra request, never blocking a graph run.

This closes the precedence chain properly: **local preview → Civitai candidates → `locked` → placeholder.**
Once a model has been opened once, every later render hits the local file and Civitai is never contacted
for that image again — which is the whole point of the request, and also makes the ⓘ panel work offline
for anything previously viewed.

##### SUPERSEDED (owner, 2026-07-31, later the same day): the saved preview is `anim=false,width=450`

> ### ⚠️ SUPERSEDED (owner, 2026-07-31) — "save the ORIGINAL image on disk, downscale when SERVING it"
>
> The "SETTLED" call directly below shipped in `58a1749`, and lasted less than a day. The owner's later
> decision reverses it: **save the ORIGINAL image on disk** (a future in-pack browser wants to display it
> at full size — a pre-shrunk `width=450` copy can't serve that), **and downscale it when serving it to
> a small UI box instead**. So the `width=450` transform below is no longer what gets fetched at download
> time for a still image; `civitai_parse.saved_preview_url` now fetches `original=true` for a still,
> and `/wtn/model_browser/thumb` (the route this same section already names as the panel's real thumbnail
> source) downscales on the way OUT — never rewriting the file on disk.
>
> **One thing below still holds, unchanged: the VIDEO case.** `original=true` on a video-preview entry
> returns the actual `video/mp4` (measured below, 2,768,985 B) — unusable as a preview image regardless of
> which half of this reversal is in effect. A video candidate still needs `anim=false` **plus a width** to
> get a poster frame out of the CDN at all (`anim=false` alone, no width, still returns `video/mp4` —
> measured separately, not in the table below). So `saved_preview_url` is now **type-conditional**: a still
> gets `original=true`; a video gets `anim=false,width=256` (the width number is a formality once
> `anim=false` is present — see the byte table two paragraphs down, extended: identical at width=256, 450,
> 1024 and 4096).
>
> The measurements immediately below (still 115× smaller at `width=450`, the video-as-preview bug, the
> poster-frame byte count) are **unaffected by the reversal** — they're what motivated fixing the video
> case in the first place, and that fix is exactly what survives. Only the STILL row's chosen transform
> changed, from `anim=false,width=450` to `original=true`.
>
> Implemented in `src/model_browser/civitai_parse.py` (`saved_preview_url`, `SAVED_PREVIEW_VIDEO_
> TRANSFORM`) and `src/model_browser/api.py` (`downscale_thumb_bytes`/`thumb_bytes_impl`, the new
> serve-time downscale behind `/wtn/model_browser/thumb`, lazily importing Pillow — which ships with
> ComfyUI — and falling back to the untouched original bytes if it isn't installed).

`preview_url` was the untransformed `original=true` URL, kept that way "because fidelity matters" — a
trade struck when the cost was assumed to be ~1.5 MB. Measured, on the same two URLs used throughout
this section:

| | `original=true` | **`anim=false,width=450`** |
|---|---|---|
| still image | `image/png` · 4,192,036 B | `image/jpeg` · **36,481 B** |
| video entry | **`video/mp4`** · 2,768,985 B | `image/jpeg` · **64,550 B** (poster frame) |

**115× smaller on the still**, and the video row is the important one: today a video-preview model saves
**2.77 MB of `video/mp4` as its preview image**, under whatever extension the preview writer chose. That
is a live bug in the current sidecar path, not merely a size concern — it has simply never been reported,
because nothing renders that file inside this pack. `anim=false` fixes it at the same time.

(A video's poster frame comes back at 64,550 B for both `width=450` and `width=256` — the CDN appears to
serve one stored still regardless of the requested width. Harmless, just don't expect the width parameter
to change video output.)

So there are now **three** transforms, and they should be named as such rather than left as scattered
literals: `width=256` for live thumbnails, `width=450` for the saved preview, and untransformed only where
something genuinely needs the source file. All three carry `anim=false`.

⚠️ **The `width=450` saved-preview transform above is itself superseded** — see the callout immediately
above this subsection's heading. A still now saves untransformed (`original=true`); `width=450` survives
only as the (now unused) historical measurement of "a mid-size still", and the actually-live third
transform is `SAVED_PREVIEW_VIDEO_TRANSFORM` (`anim=false,width=256`), used for a video candidate only.

> ### ⚠️ CORRECTION (2026-07-31) — this section originally described the ⓘ panel's thumbnail wrongly
>
> It claimed the panel renders `parse_model_version`'s `thumbnail` key. **It does not.**
> `model_info.mjs:701` calls `thumbUrl(kind, name)` — the **local** `/wtn/model_browser/thumb` route,
> which serves a preview image file sitting next to the model on disk. Grepping the frontend confirms
> **nothing has ever read the sidecar's `thumbnail` key**; it has been written and never displayed.
>
> Found when the owner reported the panel *"still shows 18+ image"* after the search half shipped. The
> obvious reading was "the level fix hasn't reached this surface yet". The real one is that the image
> is a **local file on their disk** — which, by this section's own four-source rule, is deliberately
> *not* level-filtered. The symptom was real; my explanation of it was not.
>
> So this is not a *conversion* of a Civitai-backed thumbnail — it is **adding a second source**:
>
> **local preview → Civitai candidates (level-filtered) → `locked` → placeholder**
>
> The local file stays preferred and unfiltered. The Civitai candidate list is the fallback, and in
> practice it is what users will see, because the local route 404s for nearly every model today (our own
> preview-saving path has never been wired — see below).
>
> ### ⚠️ SECOND CORRECTION — "the cache bakes in the level" was also wrong
>
> This section claimed *"`lookup.py` writes `parse_model_version`'s output — including one already-chosen
> `thumbnail` string — to `<base>.civitai.info`"*, and built the argument for render-time picking on top of
> that. **It writes `result["data"]` — the RAW Civitai response** (`lookup.py:243`, and `cached` on the
> cache-hit branch at `:189`). `parse_model_version` runs on *read*.
>
> So nothing was ever baked in: the sidecar has always held the full `images` array with every
> `nsfwLevel`, and a render-time pick had all the data it needed from the start. The conclusion —
> candidates, picked at render time — is still right, but it was already achievable and the urgency was
> imagined. The legacy single-`thumbnail` migration is therefore **defensive only**: it cannot arise from
> our own write path (verified back to `815c286`), and survives only to tolerate a hand-edited or
> externally-authored `.civitai.info`.
>
> **Both corrections in this section are the same mistake**: I specced this subsystem from the design
> doc's own description of it instead of reading the code, and asserted where data comes from and goes
> without grepping either end. Both were caught downstream rather than by me. When writing a contract for
> an *existing* subsystem, every claim about data flow — what is stored, what is rendered, what reads
> which key — has to be checked against the source, because such a claim reads as authoritative
> afterwards and the next person builds on it.

The ⓘ panel **already inherits the `anim=false` video fix for free**, since it shares `_thumb_url`.
Only the *level* is missing.

⚠️ **The blocker is the cache, not the picking.** `lookup.py` writes `parse_model_version`'s output —
including one already-chosen `thumbnail` **string** — to `<base>.civitai.info`. So the level in force at
*write* time is baked into the cached record: raise the level later and a cached panel keeps showing the
old pick, with no re-fetch to correct it. Picking at render time is therefore not an optimisation here,
it is the only thing that actually works.

**The fix mirrors the search one:** store the ordered `[{url, nsfw_level, type}]` candidates in the
sidecar and pick at render time, exactly as the card does — same retry-then-advance rule, same `locked`
state, same "unknown level counts as 16".

**Legacy sidecars migrate without a re-fetch.** Existing files carry only the single `thumbnail` key. It
is tempting to treat that as unknown-level and therefore hide it, but that is wrong and needlessly
destructive: the *old* selection rule only ever accepted `nsfwLevel` in `(None, 0, 1, 2)` or a
`not _is_adult_image` fallback (`level < 4`), and since the real levels are `1, 2, 4, 8, 16`, **a legacy
`thumbnail` is always level ≤ 2**. So grandfather it as **level 2 (PG-13)**, which is provable from the
rule that produced it rather than assumed. Bump the sidecar's schema marker so the two shapes stay
tellable apart.

**Where the URLs go** (owner: *"we can save image urls to the lora info json or our json attached to the
lora"* — yes, and it is ours to change): `<base>.civitai.info`, written by `sidecar.write_sidecar`, which
holds `parse_model_version`'s output. Add the candidate list there as its own key, replacing the single
`thumbnail` string. **Only image URLs — never image bytes.** Four sources end up in that panel, and only
two of them need level logic:

| source | file | level-aware? |
|---|---|---|
| our sidecar, new shape | `<base>.civitai.info` with candidates | ✅ pick at render time |
| our sidecar, legacy shape | `<base>.civitai.info` with one `thumbnail` | ✅ grandfathered as level 2, above |
| **Civicomfy interop** | `<base>.cminfo.json` | ➖ **nothing to do** — it stores no gallery images at all (`interop.py:105-110`); its preview is a local file |
| **a local preview file** | `<base>.png`/`.jpeg` next to the model, via `local.find_preview_path` | ➖ **nothing to do** — it is already on the user's disk, deliberately |

That last row is the general rule and worth stating once: **the browsing level governs what we fetch and
show from Civitai, never what the user already has locally.** A file on disk was an explicit act.

Forward note: §7c-ii's community **gallery** in the info panel (not in M2) must honour the level too when
it lands — same candidate list, same rule. And the level is **orthogonal** to §7b's `Show preview
thumbnails` on/off switch: that one decides whether a thumbnail element is built at all, this one decides
*which image* goes in it.

#### Send the CANDIDATES to the frontend, not one pre-chosen URL

Owner's proposal, and it is right — and it is not a workaround, because **§7c-iv needs it anyway**:
once the level is a user setting, picking an image *is* a frontend decision, so the backend must hand
over the candidates rather than choosing one.

Each version carries an ordered list of `{url, nsfwLevel, type}` (already thumbnail-rewritten), and the
frontend picks the first at or below the chosen level, falling forward on failure.

**But `<img>.onerror` carries no status code** — a timeout, a 404 and a transcode failure are
indistinguishable from the error event. So the fallback rule must cover both shapes without knowing
which it hit:

> **Retry the same URL once with a short backoff, then advance to the next candidate at or below the
> level.** Exhaust the candidates → placeholder.

Today `onerror` swaps in the placeholder **immediately and permanently**, so one bad entry means a grey
square until the next re-render. With `anim=false` in place the video case stops arising at all; the
retry-then-advance rule is the safety net for whatever is left, not the primary mechanism.

#### A fifth card state: `locked`

§7c-iii settles four card states — installed / downloading / available / gated. This adds one, and it is
about the **thumbnail box only**, never the action:

> **`locked`** — the model has images, but every one of them is above the chosen level. Show a lock in
> the 40px thumb box with a tooltip naming the reason (*"Preview hidden — above your browsing level"*),
> **not** the grey `no image` placeholder.

That distinction is the whole point of the feature: today a missing thumbnail conflates *explicit
gallery*, *no gallery at all*, and *fetch failed* into one grey square that reads as a bug. Keep the
existing placeholder for genuinely-imageless models, so the two stay tellable apart.

The `gated` padlock (§7c-iii) is a **different** lock with a different meaning — that one is "needs an
API key". Two padlocks in one UI is a real ambiguity: give `locked` a distinct glyph or clearly
different tooltip, and if a card is somehow both, `gated` wins (it blocks the action; `locked` only
hides a picture).

#### Build notes

- **Parse `nsfwLevel` at both levels** — on the model (`_parse_search_item`) and on each image. Keep the
  legacy `nsfw` bool parsed for now, but nothing should *decide* anything from it.
- The pure/impure split holds: level filtering is pure and offline-testable. `_is_adult_image`'s
  hardcoded thresholds go away in favour of a level comparison.
- Test with recorded payloads exercising each level, a model whose gallery is entirely above the level
  (⇒ `locked`), a model with no images at all (⇒ placeholder), and a `nsfwLevel: 32` entry (never shown
  at any setting).
- **Existing `.civitai.info` sidecars and any cached search results predate `nsfwLevel`.** Treat a
  missing level as unknown, and decide whether unknown is shown or locked — the safe default is to
  treat it as PG-only-if-the-image-says-so rather than assuming safe.

### 7d-i. TWO descriptions, labelled — never collapsed into one (owner, 2026-07-30)

Civitai carries **two** distinct pieces of prose, and the first cut of the lookup picked one and threw the
other away. Both must be shown, each under its own label, **on every per-model info surface** — the LoRA
ⓘ panel, the toolbar browser, and (M3) the Loader Panel's model info. This is not LoRA-specific; it holds
for checkpoints and UNET too.

| label | source | what it is |
|---|---|---|
| **Model Description** | `/api/v1/models/{id}` → `description` | the author's overall write-up: what the model is for, how to prompt it, recommended settings |
| **Version Description** | the model-version object's own `description` | a per-version note — usually a short changelog (`Trained on preview3.`) |

Why the distinction earns two labels rather than a merge: they answer different questions, and a reader
who sees only "Trained on preview3." under a generic *Author's notes* heading reasonably concludes the
author wrote nothing useful — when in fact the real write-up exists one endpoint away. That exact
confusion is what surfaced this (owner, 2026-07-30).

Rules:

- **Render each only when present**, and never invent a heading for an empty one. A model with no version
  note shows just *Model Description*.
- **Distinguish "absent" from "not fetched yet"** — the same rule §7e applies to the lookup states. Saying
  a model has no description when we simply have not asked is a lie the UI has already told once.
- **Both are cached in the sidecar** so the second open costs nothing, and both are governed by the
  Civitai setting.
- Both are **untrusted HTML**: convert to plain text and write with `textContent`, never `innerHTML`.

**The wire shape** (built 2026-07-30; `lookup_model_info(...)["data"]`, keys present only when known):

| key | meaning |
|---|---|
| `model_description` | the author's write-up. **Absent ≠ empty** — absent means not known |
| `version_description` | the per-version note. Known synchronously, so absent genuinely means none |
| `model_description_checked` | **always present.** `True` = nothing further could ever be learned (already have it, a fetch reached a definitive answer, or there is no `model_id` to ask by). `False` = a fetch that could answer it hasn't happened — `cached_only` skipped it, or a transient failure. `version_description` needs no equivalent, since it never requires a second call |

> **Why the split is structural, not cosmetic.** The earlier bug — a present *version* description
> suppressing the fetch that gets the real write-up — is now **unable to recur**, because
> `_augment_with_model_description` gates solely on `model_description`. There is no shared key left for
> the two to collide on. That is a stronger guarantee than the regression test beside it.

### The modal

**90% of the viewport**, centred, over a scrim. Full features: search, **filters** (type, base model,
sort, period, NSFW), a result grid with **preview images**, per-result detail with the author's
description, and download with progress.

#### The detail view — master→detail swap, with a community gallery (owner, 2026-07-29)

> ### ⚠️ MEASURED BEFORE BUILDING (2026-08-01): the prompts are NOT on the community images
>
> This section's gallery rests on one claim — *"the **prompt** is the part you can actually reuse; that
> is the real reason someone browses Civitai instead of a filename list. Copy-prompt is therefore a
> first-class action, not a nicety."* Measured against the live API, that claim holds, but **not for the
> source this section names**:
>
> | source | sampled | carrying a prompt |
> |---|---|---|
> | `/api/v1/images?modelVersionId=…` — the **community** images | 40 | **0** (`meta` is `{}` on every one) |
> | `/api/v1/model-versions/{id}` — the **author's** gallery | 20 | **18**, with full generation params (`seed`, `steps`, `sampler`, `Size`, `Model`) |
>
> So the two halves of the rationale point in opposite directions. *"What it looks like in other people's
> hands"* is available **without** prompts; *"the prompt you can actually reuse"* is available **only** on
> the author's own images. By this section's own test — a gallery without reusable prompts is decoration —
> **the gallery should be built from the author's images**, and `copy-prompt` stays first-class because
> that source actually has something to copy.
>
> Unverified possibility, deliberately not designed around: an API key may unlock `meta` on the community
> endpoint (Civitai gates generation data in places). All probing here was unauthenticated. If a keyed
> request turns out to populate it, revisit — but **design for what is measurable**, not for a maybe.
>
> Everything else in this section stands: the version selector, the descriptions, `View on Civitai ↗`, the
> three constraints below, and the master→detail swap.


**Clicking a result card opens its detail**, and it does so by **swapping the results area** while the
filter rail **stays put**. Not a nested modal, and not a hidden rail: your filters are the context you
came from, and keeping them visible is what makes `← results` read as a step back rather than a new
place. A nested modal over a 90% modal also has nowhere to go.

Contents:

- **A version selector.** A Civitai model has *many* versions and they differ in file size, base model
  and trained words — and the by-hash lookup (§2b) is **per version**, so "download this model" is
  meaningless without one. Downloads target the selected version explicitly.
- Creator, type/base-model badges, stats, last-updated, and the author's description in full (this is
  the same text §2 item 3 wants surfaced in the node's ⓘ panel — one parser, two presentations).
- **A community-images gallery: the images users actually made with it, each showing its PROMPT on
  hover**, plus the generation parameters (sampler, steps, cfg, size) and a **copy-prompt** action.

**Why the gallery earns its place rather than being decoration:** a LoRA's own preview is the author's
best shot. The community grid is what it looks like in other people's hands, and the *prompt* is the part
you can actually reuse — that is the real reason someone browses Civitai instead of a filename list.
Copy-prompt is therefore a first-class action, not a nicety.

Three constraints:

- **The rail's NSFW toggle governs the gallery too.** Community images are the most likely NSFW surface
  in the whole feature. With it off they are blurred behind a click-to-reveal, not silently dropped —
  hiding them entirely would misrepresent what the LoRA is used for.
- **Prompts are untrusted text** — render with `textContent`, and remember a prompt legitimately contains
  `<lora:name:0.8>` sequences that must not be interpreted as markup.
- **Lazy-load thumbnails** and cap how many load at once; a gallery is the one place in this feature that
  can pull a lot of bytes, and §9's "never block a run" applies to bandwidth as much as to the event loop.

⚠️ **It is deliberately NOT the Rule Builder's overlay geometry.** That one is
`position: fixed; inset: 0; z-index: 10000` — genuinely full-bleed, because the Rule Builder is a work
surface you *live in* while authoring. A browser is a "look something up, take it, come back" surface,
so 90% with the graph visible at the edges keeps you oriented. Follow its *mechanism* (own overlay
root, scrim, Escape, focus handling), not its dimensions.

#### Destination for an unscoped download — deferred, deliberately (owner, 2026-07-31)

The modal has no caller to take its kind from, so a download's folder is derived from **the result's own
Civitai type**. Civitai has roughly 19 types; `KIND_TO_FOLDER` has **three** (`loras`, `checkpoints`,
`unet`). Owner: *"about destination we will align on it afterwards, i think most of them has a place, and
for those that we don't need will be removed from the option to search, we will see when we get to it."*

So the settled direction is **trim the searchable Model Type options to the types we can place**, rather
than showing results the user cannot act on. Two consequences for anything built before that lands:

- **`kind: null` for an unmapped type stays, and must never be guessed.** It is the guard that stops a
  Workflow JSON being written into `models/loras/`. Keep it, keep it tested — but keep the UI for it
  minimal, because it is on its way to being rare rather than load-bearing.
- **The type→kind table and the rail's type options are each ONE list, in one place.** Both are going to
  grow and be trimmed respectively. Neither should be inlined into logic, and nothing anywhere may encode
  "there are exactly three kinds" — `KIND_TO_FOLDER` and `ACTIVE_KINDS` remain the only sources of truth.

`LoCon`/`LyCORIS` → `loras` is the first judgement call of this kind (LoRA-family, and ComfyUI loads them
from that folder). Whatever is decided, the reasoning belongs in the comment, because it sets the standard
for every type added later.

### Where the button goes, and the budget constraint that shapes it

Beside the **Rule Builder's** toolbar button, following the same pattern its `index.js` already
documents as lifted from `../ComfyUI-Pixaroma/js/align/index.js`: an **icon-only toolbar button**, plus
an `app.registerExtension({ commands: [...] })` entry so it is also reachable from the command palette
and bindable to a key.

> 🚧 **A new `js/civitai/index.js` would be a SIXTH auto-loaded `.js` and is therefore forbidden** —
> `.claude/CLAUDE.md` caps the pack at 5, and that ceiling is about what ComfyUI ships to every user on
> every page load. **Mount the toolbar button from `js/controls/index.js`** — the entry point that
> already registers this track's node classes and will register the LoRA loader too — and have it
> **lazily `import()` the modal `.mjs`** only when the button is actually clicked. Same trick
> `docs/settings.md` records for the settings section, which faced this exact choice and resolved it the
> same way.

### Two things to verify while in there

- The Rule Builder's own `index.js` carries a **`VERIFY-IN-COMFYUI`** doubting whether its `commands`
  entry surfaces anywhere a user can reach. Now that a live box is available, settle it — and if
  `commands` is unreachable, the toolbar button is the *only* affordance and this new one must not rely
  on `commands` either.
- **Stale naming, user-visible:** that command's label reads **`"Webtoon: Rule Builder"`** and its CSS
  classes are `webtoon-rb-*`, left from the deleted webtoon line. The pack is AnimaFlow. Worth fixing
  in the same pass rather than adding a second, correctly-named button beside a wrong one — but it is a
  rename of user-visible strings, so it is the owner's call, not a silent tidy-up.

---

## 7b. The ⚙ dialog — what we take, and the two things we drop

Upstream's dialog, read off a live screenshot (owner, 2026-07-29) — richer than its source grep
suggested:

| setting | ours? | notes |
|---|---|---|
| Default strength (new LoRAs) | ✅ | |
| **Strength step (arrows)** | ✅ | missed on the first read; a real convenience |
| Separate model / clip strength | ✅ | "Show two strengths per row" |
| Trigger words separator | ✅ | |
| LoRA memory use | ✅ | **labels `Standard` / `Fast` / `Lowest`, stored as `last` / `all` / `none`** |
| **Hide file extension** | ✅ | "Show the name without `.safetensors`" |
| **Civitai lookup button** | ✅ | see below — this is our offline-only switch |
| Show preview thumbnails | ✅ | bandwidth + clutter control |
| Highlight colour | ❌ | **dropped** |
| Set as default · Every Pixaroma node · Done | ❌ | **dropped** |

**The memory-mode labels confirm a decision we already made.** Human labels over raw keys is exactly
`cec90cd`'s display-name map (`Mode`, not `mode_type`), with the settings *path* untouched. Same rule
here: the UI says `Standard`, the state stores `last`.

**"Civitai lookup button" is more important for us than for them, and it governs MORE than theirs
does.** Upstream's toggle hides one thing: the lookup inside the info panel. **Ours hides every network
affordance on the node** — the ⓘ panel's `↻ Civitai` *and* the 🔍 browse button (below). One switch,
and the node is provably offline: there is no path left from which a request could originate.

That turns §9's "degrade silently offline" into a **user-selectable posture** rather than only a failure
path — worth having on day one even though search and download are milestone 2, and cheap, because each
affordance either renders or it doesn't. Name the setting **Civitai** rather than "Civitai lookup
button", since it now governs the whole capability rather than one button.

### Where the node's Browse button goes (owner, 2026-07-29)

**An icon-only button immediately beside the ⚙**, in the single header row (§1a-ii) — *not* a
full-width labelled button on its own row, which is what an earlier draft had. Reasons: the header
already carries the node's controls so a browse action belongs with them rather than claiming a row of
its own, and in a Class A node (§6) every row of chrome is permanent height that cannot be scrolled
away.

Header row, final: `＋ Add LoRA` · *(slack)* · master switch · `N/M` · **🔍** · **⚙**.

> 🎨 **Use an inline SVG or CSS-drawn icon, not an emoji.** The mockup uses 🔍 as a placeholder;
> emoji render inconsistently across platforms and clash with a dark theme. This pack ships no icon
> assets, which is exactly why the Rule Builder's toolbar button draws its own icon in CSS — its
> `index.js` says so explicitly, contrasting itself with Pixaroma's `/pixaroma/assets/icons/...`.
> Follow that precedent.

### Why the two drops

- **Highlight colour** — the pack has exactly one house accent ([`THEME.md`](THEME.md)), and today's
  three-round border saga was about *removing* accent from places it didn't belong. A per-node colour
  override would reintroduce that inconsistency deliberately. If a user wants a different accent it
  belongs in the theme, once, for the whole pack.
- **The three footer buttons** — they exist to paper over a dialog that mixes *per-node* and *global*
  state: "Set as default" persists your choices, "Every Pixaroma node" pushes them across nodes.
  **We already solved that split**: user-wide preferences live in **Settings → AnimaFlow**
  (`comfy.settings.json`, [`settings.md`](settings.md)), which survives a restart and works for
  API-only runs with no browser. So cross-node defaults go there and this dialog stays strictly
  per-node, edits applying immediately with ✕ to close. Fewer buttons *and* a cleaner boundary.

**Which layer owns what** — keep this split when implementing:

| lives in | what |
|---|---|
| the node's ⚙ (state blob) | anything that changes *this node's* behaviour: memory mode, separator, separate-strengths, per-node strength defaults |
| **Settings → AnimaFlow** | user-wide display/posture prefs: hide file extension, show the Civitai button, show thumbnails |

Remember the settings-id namespace is **append-only** (`settings.md`) — renaming an id silently
abandons whatever the user had set.

---

## 7e. The four Civitai lookup states — dead ends are where UI quality shows

Upstream has four (searching / found / notfound / offline) and renders them as a status strip. **Ours
gives each one the same three-part shape**, because two of the four are failures and a bare "not found" is
a dead end:

> **icon + headline · one line of cause-and-consequence · the one action that could change it**

| state | headline | says | action |
|---|---|---|---|
| **searching** | `Checking Civitai…` | (spinner) | `Cancel` |
| **found** | `Matched on Civitai` | cached next to the file — instant and offline from now on | `Re-fetch` · `Forget cached` |
| **notfound** | `This exact file isn't on Civitai` | **re-saving, merging or quantising a LoRA changes its hash**, so a LoRA that *is* published won't match once the file has been altered. Your file's own trigger words are still shown. | **`Search Civitai by name →`** |
| **offline** | the *specific* reason — `Civitai timed out` / `Couldn't reach Civitai (DNS)` / `Civitai sent an unreadable reply (a login or block page?)` / `Civitai returned 429` | nothing was lost: the file's own words are shown | `Retry` — and for `429`, name the key ladder (§8), since a key relieves rate limits |

Three things this buys that a status strip does not:

1. **`notfound` stops being terminal.** By-hash failed, but **by-name might work** — and we have search
   (M2). Turning the dead end into the feature we already built is the single best move available here,
   and it is the *common* case: a merged or re-saved LoRA is very often on Civitai under a name.
2. **The hash explanation prevents a wrong conclusion.** Without it, "not on Civitai" reads as *this LoRA
   is unknown*, when the truth is usually *this exact file has been modified*. Users otherwise conclude
   the lookup is broken.
3. **`offline` keeps upstream's distinct reasons instead of flattening them.** Their route already
   separates timeout / DNS / unreadable-reply / rate-limit and their code comment explains why
   (collapsing them "defeats the point of showing the user a reason at all"). Surface that difference —
   a timeout wants `Retry`, a block page wants a look at the network, a 429 wants a key.

**Every state also says what still works.** The file-derived trigger words never depended on Civitai, so
no failure state should imply the panel is useless — that is the difference between an error and a
degradation.

---

## 7d. `View on Civitai ↗` on every per-model info surface (owner, 2026-07-29)

The ⓘ panel already has it (§1a-i). **It belongs on every surface that shows one model's information**:

| surface | milestone |
|---|---|
| the node's ⓘ panel | M1 |
| the modal's detail view (which is also the picker's, §7c-ii) | M2b |
| the Loader Panel's model info | M3 |

**Why it is a rule rather than three separate buttons:** whatever we render is a *curated subset* of
someone else's page. Civitai always has more — comments, the full image gallery, other versions'
changelogs, the licence terms. An info surface with no way out is a dead end that quietly implies we
showed you everything. One link keeps us honest about being a convenience layer over their catalogue.

It also has to link to the **specific version** being viewed, not the model's landing page, since the
detail view has a version selector (§"The detail view") and the trigger words and file size shown belong
to *that* version.

**Governed by the Civitai setting (decision 20).** With it off, this link is hidden too — even though
opening a link is technically the *user's* network call and not the node's. Rationale: someone who turned
Civitai off wants no Civitai, and "off means off everywhere" is a rule you can reason about, whereas
"off, except the links" is one you have to remember. Cached sidecar info still displays; only the way out
disappears.

---

## 8. API key handling — resolution order, and the one place it must never go

1. our own ComfyUI setting (`AnimaFlow.*`, stored server-side in `comfy.settings.json`), then
2. the **`CIVITAI_API_KEY`** environment variable — Civicomfy's own convention, so anyone already
   running it gets ours working with zero setup, then
3. no key ⇒ **public-only mode, clearly indicated** rather than silently degraded.

**Never the node state blob.** It is a serialized STRING widget, so it lands in the saved workflow —
and the Preview embeds the workflow into saved PNGs. A key there leaks into every image the user
shares. (This is not hypothetical: a Colab notebook in this repo shipped a live tunnel token for the
same class of reason — saved UI state is a credential sink, and it is invisible until someone looks.)

When an operation genuinely needs a key (gated/early-access files, rate-limit relief), **say so in the
UI naming what to do** — never a bare 401, and never silently return nothing.

---

## 9. THE open decision — the outbound-network policy

Everything in this pack today is local. This is its **first outbound network call**, and the policy
needs settling before code, because it shapes the route design rather than decorating it:

- **Never block a graph run.** A LoRA that applies must not wait on Civitai. Upstream's lookup is
  *only* on an explicit click, and that is the shape to keep.
- **Degrade silently offline** — a node must still load and execute with no network at all.
- **Rate limiting** — ours, not just Civitai's, since a stack of rows could fan out.
- **Downloads are server-side Python**, streamed, resumable if cheap, with progress reported to the
  UI and a hard cap. The Colab launcher already has a model downloader with present/missing
  detection — read it for reusable shape before starting fresh.
- **Where files land**, and what happens on a name collision or a partial download.

### 9a. SETTLED — order of work (owner, 2026-07-29)

**The node ships first, and the Civitai feature ships under it.** The Loader Panel reuses the same
library afterwards, and that first reuse pass is scoped to **checkpoints/models and UNET only**.

Consequences, all deliberate:

- The library is **kind-parameterised from the first commit** but only `loras` is wired — §7a, which is
  the one thing that must not be deferred, since retrofitting `kind` touches folder resolution, the
  download destination, sidecar paths, the search filter and the path guard all at once.
- **Milestone 1 can be genuinely useful with no network policy resolved at all**: rows + picker +
  missing marks + file-derived trigger words + the hash lookup, which per §2b needs no key and caches
  offline. Search and download can land in milestone 2 once §9's policy is settled — so the open
  decision below **does not block starting**.
- The Loader Panel gets nothing until milestone 3. Accepted; it already works today.

---

## 10. Tests

Plain-script, no pytest (`python3 tests/test_x.py` from repo root), and `node js/**/test_*.mjs`.

- **State normalization**: unknown keys survive, missing keys default, a hostile blob never raises.
- **`triggers` provenance**: words come only from rows that actually applied; a missing/corrupt file
  contributes none; a switched-on row at strength 0 is loaded and applied like any other and counts
  the same way (§1b, reversed 2026-07-30 — strength no longer carves out an exception).
- **Memory modes**: `last` keeps exactly one entry across a run and does **not** evict the retained
  entry on the first row of a multi-row stack (upstream's own regression); `all` frees entries for
  removed rows; `none` clears.
- **Civitai parsing is pure and offline-testable** — feed recorded JSON, including the
  no-`trainedWords`/no-`model.name` case that must still count as FOUND (§2b).
- **Route behaviour**: always 200 with a `reason`; a 404 does not try the backup host; an oversized
  body is rejected.
- **Sizing**: per §6's skill — and **size tests must run against a `Float64Array`**, not only a plain
  array, or they prove nothing.
- **Widget order frozen** in a regression test, `lora_state` included.
