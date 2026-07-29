# Plan — mine Pixaroma's seven Control Panel review rounds

**Status: in progress.** A backlog of concrete, already-found bugs to check our `js/controls/`
against. Nothing here is speculative — every item is a bug someone else already hit, diagnosed, and
fixed in a node that works the same way ours does. Tier 2 items **8** and **9** below are fixed
(2026-07-28), and item **10**'s base wheel-zoom passthrough predates this file (`6ccbf9c`) — its
own "do the audit" follow-up is still open. Tier 1 items **1–5** are still open: reproduced-against
or written-off findings, not yet fixes.

## Why this exists

Our Controls line was ported from `../ComfyUI-Pixaroma` at **`afd0d05` (v1.4.44)**. The clone was
pulled to **`5036814` (v1.4.62)** on 2026-07-27, and their Control Panel gained **+1360 lines** in
between — including **seven numbered review rounds** of bug fixes, several found only by live testing.

They also independently built the same three things we did: a **Seed control with `R`/`N`**, a
**combo/dropdown control**, and a **wheel-zoom passthrough fix**. So this is the closest thing to a
free QA pass our node will ever get: same mechanic, same renderer, same class of bug.

> **Licence.** Pixaroma is **MIT © pixaroma**, already credited in
> [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) §2. Porting fixes is fine **with
> attribution** — extend that entry when a fix lands. Read their diffs; don't paste wholesale
> without checking it fits our state shape.

## How to run this

Per item: **reproduce against our code first.** Several will not apply — our architecture differs in
ways that make some bugs structurally impossible, and "fixing" a non-bug adds risk for nothing. Only
after a live reproduction should a fix land. Work top-down; the ordering is by expected value.

```bash
cd ../ComfyUI-Pixaroma
git log --oneline afd0d05..5036814 -- nodes/node_sliders.py js/sliders/
git show <sha>                    # the reasoning is in the commit bodies, and it is good
```

---

## Tier 1 — likely to apply to us, high impact

### 1. Unwire targets the wrong row (`81aa3ad`, found by live testing only)

> "unwiring a NON-FIRST control row reset row 0's type instead of the row actually unwired. The
> disconnect event reports the origin output slot as **0** for the input-side / removeLink unwire
> paths (only `disconnectOutput` reports it right); the fix trusts `link.origin_slot`."

**This is a litegraph fact, not a Pixaroma bug** — it will bite anything reading `slotIndex` on
disconnect. Ours: `js/controls/index.js`'s `onConnectionsChange(type, slotIndex, isConnected, link)`
currently acts **only on `isConnected`**, so we may be immune by omission. **Check:** do we ever key
anything off `slotIndex` for a disconnect? If we add disconnect handling later, trust
`link.origin_slot`, never `slotIndex`. Worth a comment at that call site either way so it is never
introduced.

### 2. Corrupt row aborts the whole-graph value loop (`04c570d`)

> "A null/non-object row in a hand-edited or corrupt state crashed `normalizeSliders` on load AND
> **aborted the whole-graph value-injection loop, silently skipping OTHER Control Panel nodes**."

The severity is the cross-node blast radius: one bad node breaks every panel on the canvas. Ours:
`rows.mjs:610-614` filters `r && typeof r === "object" && allowedKinds.has(r.kind)`. That *does* drop
nulls, and an array row is dropped too (an array has no valid `.kind`) — **verify that reasoning with
a test rather than trusting it**, since `typeof [] === "object"` is exactly the hole they missed in
round 4 and only closed in round 6 (`c125e5a`). Also check our Python `parse_state`
(`nodes/controls/_rows_helpers.py`) survives the same inputs.

### 3. In-place heal, don't splice (`bc51698`)

> "The corrupt-row heal dropped a bad row and **shifted the array**, which could re-pair a wired
> output with the wrong row's data when the bad row was in the middle. Now it replaces the row in
> place, keeping position and count."

Directly relevant: our slot↔row pairing is the whole design. Our `normalizeState` **filters**, which
shifts. If a corrupt row sits mid-list, does slot pairing survive? **Write the test:** three rows,
middle one corrupted, assert rows 1 and 3 keep their slots.

### 4. Value loss on unplug/replug (`30110c0`, "major, reproduced")

> "disconnecting reset a row to `auto`, so re-wiring to the SAME kind ran a fresh conversion that
> overwrote the value... Now `resetRowOnDisconnect` remembers the kind in a **runtime** map
> (`node._pixWasType`, never serialized)."

Ours has **no disconnect reset at all** (grep found none), so this specific bug is likely absent —
but that means our resolved rows *never* free up, which is their `c25d04e` fix ("free a row on
disconnect so it can be re-wired to a new type") in reverse. **Decide deliberately:** do we want
re-wire-to-a-different-type to re-adopt? If yes, we inherit this whole bug family and should copy
their runtime-map approach, including *never serializing it*.

### 5. Pass-through inputs get severed (`30110c0`)

> "`isValueTarget` refused a `*` target, so wiring a control through a **Reroute / Set / PreviewAny**
> got auto-disconnected. `*`/empty targets are now allowed."

Ours: `describeLinkTarget` in `index.js`. **Check** we accept `"*"` and empty target types. Reroute
nodes are common enough that refusing them reads as "the panel is broken".

---

## Tier 2 — check, probably cheap

### 6. Seed: randomize-off should lock in the seed that just ran (`bc51698`)

> "turning randomize OFF reverted to the old stored seed instead of the one that just ran. It now
> locks in the last rolled value (**matches native ComfyUI**)."

We shipped seed after-generate in `596ff98`. Ours: the `F/R/I/D` button flips to `fixed` and keeps
`row.value` — which after our queue hook is the **next** seed, not the one that ran (that's
`opts.lastUsed`). So we have their bug, with the fix already sitting in `applyAfterGenerate`.
**Likely fix:** switching to `fixed` sets `value = lastUsed`. That is exactly what our `↺` button
does, which suggests the mode toggle should do it too — and if so, `↺` may become redundant.

### 7. A hand-typed seed must be capped where Python caps (`30110c0`, `701295d`)

> "the face showed a different number than what ran, and reopening re-clamped + dirtied the file."

Ours clamps to `2^64-1` in `clampSeedString`, and Python clamps to `SEED_MAX` in
`coerce_seed` — **the same bound, so we're probably fine.** Verify the two agree exactly, including
the gear popover's typed path (`commitSeed` was their miss).

### 8. Rows overflow at minimum node width (`c125e5a`) — **FIXED 2026-07-28**

> "Combo and Seed rows could spill past their rounded border when the node is dragged toward its
> minimum width (their fixed parts exceed it). Added `overflow:hidden` to the row containers and let
> the value shrink/ellipsize."

**Confirmed live before being fixed** — a real screenshot showed the seed row's ⚙ gear pushed past
the row's rounded right edge, overlapping the area where litegraph draws the real output dot,
triggered by a 20-digit seed (`16911058666109724423`, legitimate — seeds are `[0, 2^64-1]` strings)
plus the row's `F/N/↺` mini buttons. Reproduced exactly with a headless-Chrome render of the real
`buildRowElement` DOM against the real injected CSS at `MIN_W` (300px) before touching anything, and
re-rendered after the fix to confirm it actually closes (both in the build report, not just reasoned
about).

**The naive fix (`overflow: hidden` straight on `.wtn-ctl-row`) would have been a worse regression**
than the bug it fixed: the SAME headless-Chrome measurement showed it also clips `.wtn-ctl-dot`,
which is deliberately positioned *outside* the row's own box (`right: -16px`) in the socket gutter
between the row and the node's real edge — `overflow: hidden` clips absolutely-positioned descendants
with no exception for "but this one's on purpose." Worse, this ALSO turned out to already be a live
bug: `.wtn-ctl-row.wtn-ctl-slider` (the numeric int/float rows) already carried `overflow: hidden`
pre-fix, and the same measurement confirmed their output dot has been invisible in every real
ComfyUI page all along — a second, previously-unknown bug this investigation caught as a side effect.

**The actual fix**: split each row into an OUTER `.wtn-ctl-row` (unclipped, position: relative, holds
only the body + the dot) and an INNER `.wtn-ctl-body` (the visibly-bordered, `overflow: hidden` box —
background/border/padding/flex layout all moved here) — the dot stays a sibling of body, never a
descendant, so body's clip protects the border without touching the dot. `.wtn-ctl-val` gained
`min-width: 0` + `overflow: hidden` + `text-overflow: ellipsis` (the actual missing piece — it
already had `flex-shrink: 1` by default, but a `white-space: nowrap` text node with no
content-based-minimum override refuses to shrink below its own content width regardless of
flex-shrink). `.wtn-ctl-name` keeps its existing 54px floor but now shrinks 4x as eagerly
(`flex: 1 4 auto`) so it gives way toward that floor before the value loses any width — value
preferred, per this file's own design question, verified against the adversarial case of a long
hand-rename sitting next to a 20-digit seed, not just the common "short default name" case. Ported
the same `overflow: hidden` backstop (no dot to protect there — this track has no per-row litegraph
sockets) to `js/anima/`'s own rows (`.wtn-an-row`/`.wtn-an-stagerow`) and the shared
`js/shared/fields.mjs` primitives they're built from (`.wtn-fld-stepper`/`.wtn-fld-num-*`) — see
`js/controls/render.mjs`'s CSS comments for the full reasoning, and `js/controls/test_resize.mjs`/
`js/anima/test_resize.mjs` for the regression tests (CSS-text + DOM-structure assertions; a stub-DOM
harness can't assert real layout, so it can't replace the headless-Chrome measurement above — see
those tests' own doc comments).

### 9. `-0.00` from float drift (`c125e5a`) — **FIXED 2026-07-28**

A slider whose range crosses zero can display `-0.00`. Ours: `formatNumericValue` in `rows.mjs`.
Confirmed present (`formatNumericValue({value: -0.00001, opts: {step: 0.01}})` → `"-0.00"`, and a
literal `-0` reproduces it too, since `Number("-0.00")` really is a negative zero). Fixed by checking
whether the FORMATTED string is numerically zero and, if so, re-formatting from a plain `0` instead
of the original (possibly negative-signed) number — covers both a true `-0` and any tiny negative
drift that merely rounds to all-zeros at the step's own decimal count. Unit-tested directly in
`js/controls/test_rows.mjs` (genuinely testable with no DOM at all).

### 10. Wheel-zoom passthrough on *every* DOM node (`f6ef861`)

> "Audit of every node with a DOM panel found **7** built after the fix that never called
> `installCanvasZoomPassthrough`... **Nothing failed loudly, which is why they were missed.**"

We fixed ours in `6ccbf9c`. The transferable part is the **audit habit**: they added a CLAUDE.md
convention with an audit command so a new DOM node can't quietly reintroduce it. **Do the same before
the Generator/Preview nodes ship** — they are exactly the "new DOM-widget node" case, and
`generator-design.md` should carry the requirement.

---

## Tier 3 — features, not fixes

Judge on merit; we may not want them.

- **`c816f1a`** Seed control with R/N — **we have this.** Compare semantics, especially item 6.
- **`91d6323`** Dropdown control that learns a picker's options **and filters them** — we have the
  combo row; the *filter* is new to us. Their round-1 fix is instructive: narrowing a filter silently
  swapped the running value; keep the value if it's still a valid option, filtered-out or not.
- **`00c8be8`** Text-field control — we have no text row. Would we want one?
- **`a258cd9`, `14e7031`** Lock a wired row's type, re-adopt on re-wire to a different input. Related
  to item 4; decide together.
- **`701295d`** A "Reset values" action — and the bug it caused: sending *every* non-toggle row to
  `(min+max)/2` wiped text to `"0.5"`, zeroed seeds, knocked dropdowns off their default. If we ever
  add Reset, per-kind behaviour from day one.
- **`e3ef61e`** A re-wire re-adopts the target's name **unless the user set it** — we have `renamed`
  for exactly this (`rows.mjs`'s doc comment). Worth comparing.

---

## Process notes worth stealing

Independent of any single fix:

- **They ran 3-agent reviews, then reviewed the review's code** — rounds 3, 4 and 5 are each a review
  *of the previous round's fixes*. Round 5 found that round 4's heal had introduced the slot-repair
  bug in item 3.
- **Live end-to-end testing found what no code read did.** Round 7's headline bug (item 1) was
  pre-existing and invisible to review; it took running all five control types through real
  execution. Our `VERIFY-IN-COMFYUI:` markers are the same admission — this is the argument for
  actually working through them rather than leaving them as comments.
- **Several fixes are removals.** Round 1 deleted an `onConfigure` heal because "the sizing bug never
  shipped, so no saved workflow needs it, and it could shrink + dirty a user-resized node on load."
  Worth auditing our own defensive code for heals that protect against states that never existed.

## Definition of done

- Every Tier 1 item either **fixed** or **written off with the reason** (in this file, not a commit
  message that scrolls away).
- A regression test for each fix that lands, in the existing `js/controls/test_*.mjs` style.
- `THIRD_PARTY_NOTICES.md` §2 extended if any fix was derived from their code.
- This file updated in place — it is the record of what was checked, not a to-do that gets deleted.
