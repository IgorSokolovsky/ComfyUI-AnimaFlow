"""`AnimaPreview`'s own settings blob (design doc §8: compare + save), same
hidden-serialized-STRING pattern and same tolerant/additive normalization
contract as `settings.py` — kept in its own module since it belongs to a
different node's state, not the Generator's `generation_settings`. Reuses
`settings.py`'s pure `_deep_merge_defaults`/`migrate_version` rather than
duplicating them.

**2026-07-28 reversal**: the Generator's `image`/`image_base`/`image_mid`
sockets are gone, replaced by one `images` LIST plus `metadata_json`'s
`stage_labels` (`stages.py`, `pipeline.py`). `AnimaPreview` now receives
`images` as a genuine `INPUT_IS_LIST` list and reconstructs a `{stage:
tensor}` dict by zipping it against `resolve_run_stage_labels`'s output,
rather than three fixed named sockets — so every function below that used
to translate a STAGE name to a SOCKET name (the old `STAGE_TO_SOCKET`) now
just uses the stage name as the dict key directly. That map is deleted, not
kept for compatibility, since nothing calls it with a socket name anymore.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional

from .settings import _deep_merge_defaults, detect_schema_mismatch, migrate_version, resolve_seed_int
from .stages import STAGE_ORDER

# `resolve_seed_int` is re-exported here (not used directly in this module)
# purely so `nodes/anima/_preview_helpers.py`'s `save_now` can reach it
# through this module's own single import line, matching how it already
# reaches every other pure decision here rather than importing
# `src.anima.settings` separately. It's the "Save now" seed's ONE
# int-conversion point (the same "convert once at the boundary" pure
# function `pipeline.py` already uses for the settings-tree seed) -- see
# `_preview_helpers.save_now`'s own doc comment for why it belongs there and
# not in `format_filename` itself.

# `detect_schema_mismatch` is likewise re-exported (not used directly in this
# module) so `nodes/anima/preview.py` reaches it through this module's own
# single import line, called with `PREVIEW_SETTINGS_SCHEMA` (below) as its
# `expected_schema` -- see that function's own docstring in `settings.py` for
# the shared "hijacked STRING widget-input" contract both settings blobs use.

PREVIEW_SETTINGS_SCHEMA = "animaflow.anima_preview.preview_state"
PREVIEW_SETTINGS_VERSION = 1

# design doc §8's `compare`/`save` shapes verbatim, plus §7a's filename-token
# list (`%stage%` is the one that justifies putting save on THIS node at all
# — §2/§7a) and `which` values (`"shown"` / `"both compared"` / `"every
# wired input"`).
DEFAULT_PREVIEW_SETTINGS: Dict[str, Any] = {
    "schema": PREVIEW_SETTINGS_SCHEMA,
    "version": PREVIEW_SETTINGS_VERSION,
    "compare": {"enabled": True, "a": "base", "b": "final"},
    "save": {
        # Off by default (task item 6, flipped 2026-07-29) -- a brand-new
        # Preview node no longer writes into the user's output folder just
        # by existing. This is a DEFAULT change only: `_deep_merge_defaults`
        # only fills in a key ABSENT from the raw blob, so a workflow that
        # already saved an explicit `true` keeps it verbatim on every future
        # `normalize_preview_settings` call -- never rewritten back toward
        # this new default. `js/anima/state.mjs`'s own
        # `DEFAULT_PREVIEW_SETTINGS` mirrors this flip exactly, and the
        # Preview's new "Save now" button (`js/anima/interaction.mjs`'s
        # `buildSaveRow`, `nodes/anima/_preview_helpers.py`'s `save_now`) is
        # what buys back on-demand saving without leaving it permanently on.
        "enabled": False,
        "which": "shown",
        "extension": "png",
        "path": "AnimaFlow",
        "filename": "%date:yyyy-MM-dd%_%seed%_%stage%",
        "embed_workflow": True,
    },
}

# `compare.a`/`compare.b` and `save.which` are free-standing enums the
# frontend (`js/anima/`) presents as pickers; kept here so `pipeline`/node
# code has one place to validate against.
COMPARE_SLOTS = STAGE_ORDER
SAVE_WHICH_OPTIONS = ("shown", "both compared", "every wired input")

# ---------------------------------------------------------------------------
# Stage routing -- PURE (no comfy/torch import anywhere in this section).
# Moved here from `nodes/anima/_preview_helpers.py` per `.claude/CLAUDE.md`'s
# pure/impure rule ("keep every pure decision in src/anima/... only the
# actual file writing touches comfy"): which stages are present this run,
# and which get SAVED vs. PREVIEWED, are decisions, not I/O, so they belong
# here where they're importable/testable without ComfyUI or PIL installed.
#
# Every function below is keyed directly by STAGE NAME now (`"base"`/
# `"mid"`/`"final"`), not by a socket name -- there IS no socket name
# anymore (2026-07-28 reversal, module docstring): `AnimaPreview` builds its
# own `{stage: tensor}` dict by zipping the received `images` list against
# `resolve_run_stage_labels`'s output, and everything past that point reads
# stage names directly.
# ---------------------------------------------------------------------------

# The order "shown" falls back to when compare is off and more than one
# stage happens to be present: prefer the most-finished result.
_SHOWN_PRIORITY = ("final", "mid", "base")


def resolve_run_stage_labels(image_count: int, metadata_json: Any) -> List[str]:
    """Position -> stage label for THIS RUN's `images` list -- the ONE place
    both `AnimaPreview` and everything else in this module reads that
    mapping from (task brief: "keep the label mapping in exactly one pure
    place"). Prefers `metadata_json`'s own `stage_labels` (written by
    `pipeline.run_generator`, the authoritative record of what each position
    actually is) whenever it parses AND its length matches `image_count`.
    Falls back to `STAGE_ORDER`'s first `image_count` entries (`base, mid,
    final`, truncated) on anything else -- missing/garbage `metadata_json`,
    a producer that isn't `AnimaGenerator`, or a version skew must never
    crash the Preview, only degrade to the positional default.
    """
    if isinstance(metadata_json, str) and metadata_json:
        try:
            parsed = json.loads(metadata_json)
        except (ValueError, TypeError, RecursionError):
            parsed = None
        if isinstance(parsed, dict):
            candidate = parsed.get("stage_labels")
            if (
                isinstance(candidate, list)
                and len(candidate) == image_count
                and all(isinstance(label, str) for label in candidate)
            ):
                return list(candidate)

    labels = list(STAGE_ORDER[:image_count])
    while len(labels) < image_count:
        # More images than known stage names (shouldn't happen with the
        # current 3-stage pipeline) -- keep every entry addressable rather
        # than silently dropping one.
        labels.append(f"stage_{len(labels)}")
    return labels


def resolve_history_settings_snapshot(metadata_json: Any) -> Optional[Dict[str, Any]]:
    """The generation-settings snapshot a history entry stores (owner-
    requested feature) -- parses the Generator's own `metadata_json` (the
    SAME string `resolve_run_stage_labels` above already parses for
    `stage_labels`; this is the "keep the label mapping in exactly one pure
    place" module's other read of that string, not a second copy of ITS
    parsing -- both simply call `json.loads` on their own, since neither
    needs the other's result). Returns `None` for anything that doesn't
    parse to a JSON object (missing/garbage `metadata_json`, a producer
    that isn't `AnimaGenerator`) -- a history entry with no settings snapshot
    is a normal, honestly-reported state (`js/anima/`'s panel shows "not
    available"), never a crash.

    **Defensively re-stringifies `sampler.seed` if present.** `pipeline.
    run_generator`'s own `metadata` dict stores the RESOLVED seed as a
    Python `int` (arbitrary precision) before `json.dumps`-ing it -- fine
    for a same-process read, but this snapshot is stored here for a LATER
    trip through a JSON HTTP response and a browser's own `JSON.parse`,
    which loses precision past `Number.MAX_SAFE_INTEGER` for a real 20-digit
    seed. Converting it to a decimal STRING before it ever reaches that
    boundary is the same "seed is a string on the wire" discipline design
    doc §8 already applies to `generation_settings.sampler.seed` and
    `preview.py`'s own `anima_seed` ui payload -- applied here too, on a
    COPY (never mutates a dict some other caller might still hold).
    """
    if not isinstance(metadata_json, str) or not metadata_json:
        return None
    try:
        parsed = json.loads(metadata_json)
    except (ValueError, TypeError, RecursionError):
        return None
    if not isinstance(parsed, dict):
        return None

    snapshot = dict(parsed)
    sampler = snapshot.get("sampler")
    if isinstance(sampler, dict) and "seed" in sampler:
        sampler = dict(sampler)
        sampler["seed"] = str(sampler["seed"]) if sampler["seed"] is not None else None
        snapshot["sampler"] = sampler
    return snapshot


def resolve_preview_seed_from_metadata(metadata_json: Any) -> Optional[int]:
    """The RESOLVED seed, as an `int`, read straight off the Generator's own
    `metadata_json` (`pipeline.run_generator`'s `sampler.seed` — the value
    that actually ran this pass, not the `-1` "random" sentinel, since
    `pipeline.py` already collapses that through `settings.resolve_seed_int`
    before it's ever written into `metadata`; see that module's own comment
    at the call site).

    **This is the fix for the 2026-08-03 owner report**: "Preview's history
    shows seed 0 while the settings JSON on that same entry shows the real
    seed." `nodes/anima/_preview_helpers.py`'s `extract_seed_from_prompt`
    (this function's now-secondary fallback, called by that module's own
    `resolve_preview_seed`) can only ever read a LITERAL `seed` widget value
    off the queued graph, and `AnimaContextBridge` declares `seed` with
    `forceInput=True` — always a wired link in practice, which the API-format
    graph represents as a 2-element `[source_node_id, output_index]` list, no
    literal to scan. `metadata_json` carries the already-RESOLVED value
    regardless of how `seed` got there, so reading it here closes that gap
    for the common (wired) case.

    Returns `None` — "not available," never `0` — for anything that can't be
    trusted: a non-string/empty `metadata_json`, something that doesn't parse
    to a JSON object, a missing/non-dict `sampler` block, or a missing/`None`/
    boolean/non-numeric `seed`. Deliberately `None` rather than `0` even
    though `0` is itself a perfectly valid seed a user could have set
    literally — collapsing "unavailable" into `0` would make a genuine
    all-zeros seed indistinguishable from the very bug this function exists
    to fix, and would silently defeat the "fall back, never replace" contract
    `resolve_preview_seed` depends on (its caller only falls back to the
    prompt scan when this returns `None`). A negative value (shouldn't happen
    given `pipeline.py`'s own resolution, but a hand-edited/garbage
    `metadata_json` is not this function's to trust) is likewise treated as
    unavailable, not coerced to `0` — better to fall back to the prompt scan
    than to hand a nonsensical seed forward as if it were real.

    Pure: only `json.loads` + dict/int coercion, no comfy/torch import, never
    raises.
    """
    if not isinstance(metadata_json, str) or not metadata_json:
        return None
    try:
        parsed = json.loads(metadata_json)
    except (ValueError, TypeError, RecursionError):
        return None
    if not isinstance(parsed, dict):
        return None

    sampler = parsed.get("sampler")
    if not isinstance(sampler, dict):
        return None

    seed = sampler.get("seed")
    if isinstance(seed, bool) or seed is None:
        return None
    try:
        value = int(seed)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def resolve_wired_stages(wired: Dict[str, Any]) -> List[str]:
    """Every stage actually present in `wired` (a `{stage: tensor}` dict,
    already built from this run's `images` list + its stage labels), in
    stable `base, mid, final` order. THIS is the PREVIEW set the node always
    shows -- every present stage, unconditionally, because the hover wipe
    needs whichever two the user picks in `compare.a`/`compare.b` regardless
    of what `save.which` scopes for saving. Conflating "what to preview"
    with "what to save" is exactly how the "saving off means the wipe shows
    nothing" bug happened (see `nodes/anima/preview.py`'s own comment) --
    keep the two questions answered by two different functions, this one and
    `resolve_save_stages`.
    """
    return [stage for stage in STAGE_ORDER if wired.get(stage) is not None]


def resolve_shown_stage(compare_settings: Dict[str, Any], wired: Dict[str, Any]) -> Optional[str]:
    """Which stage name is "the shown image" right now? If compare is
    enabled, it's `compare.b` (the "after" pane — design doc §7's default
    `base` vs `final` makes `b` the natural "current result" pane). If
    compare is off, or `b` isn't actually present this run, fall back to the
    most-finished present stage. Returns `None` if nothing at all is
    present -- and if only ONE stage is present, that one stage always wins
    here regardless of what `compare` names, since `_SHOWN_PRIORITY` just
    finds it (task brief: "a one-entry list degrades to single-image").
    """
    if isinstance(compare_settings, dict) and compare_settings.get("enabled", True):
        b = compare_settings.get("b")
        if b in STAGE_ORDER and wired.get(b) is not None:
            return b
    for stage in _SHOWN_PRIORITY:
        if wired.get(stage) is not None:
            return stage
    return None


class SaveNowError(ValueError):
    """Raised by the "Save now" button's flow (task item 6) when there is
    nothing to save yet -- caught by `src/anima/api.py`'s aiohttp handler and
    turned into a readable 400, never a bare traceback. A `ValueError`
    subclass so a caller that only catches that (or `Exception`) still works,
    while `src/anima/api.py`/tests can catch this specific class to tell
    "nothing to save" apart from a genuine bug.
    """


def resolve_save_now_stage(available_stages: List[str]) -> Optional[str]:
    """The stage `Save now` writes when clicked (task item 6): `final` ->
    `mid` -> `base`, whichever is present first in `available_stages` (the
    stage names the frontend's `node._anPreviewImages` currently holds --
    every stage the last run's `anima_stages` payload reported, saved or
    not). Reuses `_SHOWN_PRIORITY` (the same "prefer the most-finished
    result" order `resolve_shown_stage` already uses for the compare wipe's
    own single-image fallback) rather than inventing a second ranking.
    `None` if `available_stages` is empty -- the caller's own "nothing to
    save yet" case (`SaveNowError`, above), never guessed at here.
    """
    present = set(available_stages) if available_stages else set()
    for stage in _SHOWN_PRIORITY:
        if stage in present:
            return stage
    return None


def resolve_save_stages(save_settings: Dict[str, Any], compare_settings: Dict[str, Any], wired: Dict[str, Any]) -> List[str]:
    """`save.which` -> which stage names actually get SAVED this run, in a
    stable `base, mid, final` order:
      - `"shown"` -> whatever `resolve_shown_stage` names, if present.
      - `"both compared"` -> `compare.a` + `compare.b`, each only if present.
      - `"every wired input"` -> every stage present this run.
    Never raises on garbage `which` — falls back to `"shown"`'s behaviour.
    This is the SAVE set, not the preview set -- see `resolve_wired_stages`'s
    docstring for why those are deliberately two different questions.
    """
    which = save_settings.get("which") if isinstance(save_settings, dict) else None
    order = resolve_wired_stages(wired)

    if which == "every wired input":
        return order
    if which == "both compared":
        wanted = set()
        if isinstance(compare_settings, dict):
            if compare_settings.get("a") in STAGE_ORDER:
                wanted.add(compare_settings["a"])
            if compare_settings.get("b") in STAGE_ORDER:
                wanted.add(compare_settings["b"])
        return [s for s in order if s in wanted]

    # Default / "shown" / anything unrecognized.
    shown = resolve_shown_stage(compare_settings, wired)
    return [shown] if shown else []


def split_preview_stages(preview_stages: List[str], stages_to_save: List[str]) -> Dict[str, List[str]]:
    """The PURE routing decision behind every UI entry `AnimaPreview` emits:
    for each stage in the (always-every-wired) preview set, does it get a
    real OUTPUT file (it's also in `stages_to_save`) or an ephemeral TEMP one
    (wired for compare but not this run's save scope -- e.g. `save.which ==
    "shown"` while two stages are being compared)? Exactly one of the two,
    never both, per stage -- one run must not produce two files for the same
    stage. Order of each returned list follows `preview_stages`' own order.
    """
    save_set = set(stages_to_save)
    return {
        "output": [stage for stage in preview_stages if stage in save_set],
        "temp": [stage for stage in preview_stages if stage not in save_set],
    }


def normalize_preview_settings(raw: Any) -> Dict[str, Any]:
    """Same hostile-input contract as `settings.normalize_generation_settings`:
    never raises, unknown keys pass through, missing keys default, a version
    bump migrates forward.
    """
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError, RecursionError):
        parsed = None
    if not isinstance(parsed, dict):
        parsed = {}

    merged = _deep_merge_defaults(DEFAULT_PREVIEW_SETTINGS, parsed)
    compare = merged.get("compare")
    if isinstance(compare, dict):
        if compare.get("a") not in COMPARE_SLOTS:
            compare["a"] = "base"
        if compare.get("b") not in COMPARE_SLOTS:
            compare["b"] = "final"
    save = merged.get("save")
    if isinstance(save, dict) and save.get("which") not in SAVE_WHICH_OPTIONS:
        save["which"] = "shown"

    merged["schema"] = PREVIEW_SETTINGS_SCHEMA
    merged["version"] = migrate_version(parsed.get("version"), PREVIEW_SETTINGS_VERSION)
    return merged


# Matches BOTH `%counter%` and `%counter:N%` on the RAW, unsubstituted
# template -- shared by `template_has_counter_token` (below) and
# `format_filename`'s own substitution so the two can never disagree about
# what counts as "a counter token". Case-sensitive, matching every other
# token `format_filename` recognizes (`%stage%`/`%seed%`/`%width%`/
# `%height%` are plain `str.replace` calls, and `%date:FMT%`'s own regex is
# likewise exact-case) -- no token in this pack has ever been matched
# case-insensitively, so inventing that rule here would be new, not
# "matching the others".
_COUNTER_TOKEN_RE = re.compile(r"%counter(?::(\d+))?%")


def template_has_counter_token(template: Any) -> bool:
    """Does `template` (the RAW filename template, BEFORE `format_filename`
    substitutes anything) contain a `%counter%` or `%counter:N%` token?
    Checked pre-substitution deliberately -- afterward a counter is just
    digits, indistinguishable from any other number the user happened to
    type (task: 2026-08-03).

    This is the "does the user manage their own numbering" decision:
    `nodes/anima/_preview_helpers.py`'s `save_images`/`save_now` both call
    this on their own `save.filename` template and, when it's `True`, pass
    `omit_at_zero=True` to `collision_suffixed_filename` (via
    `write_without_overwriting`'s own `omit_suffix_at_zero` parameter) so the
    automatic `_00001` collision suffix does not double up with the user's
    own counter. Hostile input (`None`, a non-string) never raises --
    coerced to `str` first, same tolerance every other function in this
    module gives a template/settings value.
    """
    return bool(_COUNTER_TOKEN_RE.search(str(template or "")))


def collision_suffixed_filename(filename: str, attempt: int, *, omit_at_zero: bool = False) -> str:
    """The `attempt`-th candidate name in the "every saved image gets a
    counter" naming scheme (owner, 2026-08-02: "the save name is good but
    lets make sure by default we save with `<name>_00001`") -- a REVERSAL of
    this function's own earlier behaviour (`40b3c9d`, same day): that commit
    deliberately kept "the first file at a given name keeps its plain name,
    unsuffixed" as a separate, untouched decision; the owner then changed
    that decision (`fd15d39`) so the early-return this docstring used to
    describe was gone, not special-cased around.

    **2026-08-03: that early-return is BACK, but opt-in per call
    (`omit_at_zero`), not unconditional.** Owner: "about the counter we
    should manage it -- if `%counter%` provided, ignore our `_00001`
    management." A template with its OWN `%counter%`/`%counter:N%` token
    (`template_has_counter_token`, above) means the user is numbering the
    file themselves, so doubling that with our own suffix produces two
    counters in one name (`shot_0007_00001.png`) -- the bug this reversal
    fixes. `omit_at_zero` is a parameter on THIS function (not a second
    function, not a template lookup here) because this function is
    deliberately template-blind (its own long-standing docstring: "pure
    given `(filename, attempt)`, cannot see the template") -- the caller,
    which DOES know the template (`nodes/anima/_preview_helpers.py`'s
    `save_images`/`save_now`, both already computing the template string
    right where they call `write_without_overwriting`), decides the flag
    once per save and threads it through unchanged. Both call sites must
    pass it, or the two save paths would disagree -- see the task brief.

    - `omit_at_zero=False` (the default -- every EXISTING call site that
      doesn't opt in keeps today's behaviour verbatim): EVERY `attempt`
      inserts a zero-padded 5-digit counter BEFORE the extension, equal to
      `attempt + 1` (1-indexed): `attempt=0` -> `name_00001.ext`,
      `attempt=1` -> `name_00002.ext`, and so on.
    - `omit_at_zero=True`: `attempt=0` returns `filename` completely
      unchanged -- no suffix at all, so a template with its own counter gets
      exactly the name the user's own token produced. `attempt >= 1` still
      inserts the same zero-padded 5-digit suffix, equal to `attempt` itself
      (1-indexed off the first REAL collision, not off `attempt=0`):
      `attempt=1` -> `name_00001.ext`, `attempt=2` -> `name_00002.ext`. This
      is what keeps the never-overwrite guarantee alive under the opt-out --
      `write_without_overwriting`'s loop still walks `attempt=0,1,2,...`
      expecting each candidate to differ, and it does: only attempt 0 is
      ever unsuffixed, so a genuine collision on attempt 0 still finds a
      free name on attempt 1 rather than generating 10,000 identical
      candidates and raising `FilenameCollisionExhausted`.

    Extension-preserving via `os.path.splitext`, so a dotted stem
    (`my.file.png`) only has its LAST extension treated as one --
    `my.file_00001.png`, never `my.file.png_00001`. `os.path` is pure
    string manipulation (no filesystem access), so this stays a pure
    function: no I/O, callable from a plain-script test with no directory
    on disk at all. The actual collision LOOP (deciding which `attempt` is
    free, and enforcing that atomically against a real directory) is
    impure and lives in `nodes/anima/_preview_helpers.py`, which calls this
    for each candidate in turn -- this function only ever answers "what
    would attempt N look like", never "is attempt N free".

    `_MAX_COLLISION_ATTEMPTS` (`nodes/anima/_preview_helpers.py`) is
    `10_000`, so the loop's last `attempt` is `9999`, whose suffix here is
    `_10000` -- still exactly 5 digits (`:05d` only pads UP to a minimum
    width, it never truncates a longer number), so the field still fits with
    no widening needed; see `tests/test_anima_preview_settings.py`'s
    top-of-range test for the pin.
    """
    if omit_at_zero and attempt <= 0:
        return filename

    import os.path

    stem, ext = os.path.splitext(filename)
    suffix_number = attempt if omit_at_zero else attempt + 1
    return f"{stem}_{suffix_number:05d}{ext}"


def format_filename(
    template: str, *, stage: str, seed: Any, width: int, height: int, counter: int, now: Any = None,
) -> str:
    """Expand the design doc §7a filename tokens: `%stage%` (`base`/`mid`/
    `final` — the one that justifies putting save on the Preview node at
    all, §2/§7a), `%seed%`, `%date:FMT%`, `%counter:N%`/`%counter%`,
    `%width%`, `%height%`. Pure given an explicit `now` — callers pass the
    real current time; tests pass a fixed one for determinism. No comfy/torch
    import.

    **The BARE `%counter%` form (no `:N%` width) is substituted too
    (2026-08-03 fix)** — it used to survive literally into the filename
    (`shot_%counter%` -> `shot_%counter%_00001.png`), tolerable only while
    the auto-suffix guaranteed uniqueness regardless. Once a template
    containing ANY counter form opts out of that auto-suffix
    (`template_has_counter_token`, `collision_suffixed_filename`'s own
    `omit_at_zero`), an un-substituted bare token would make every save
    produce the identical literal name, defeating the very opt-out the user
    asked for — so the two fixes ship together. The bare form's default
    width is **5 digits**, matching this pack's own collision suffix
    (`collision_suffixed_filename`) — `docs/generator-design.md` §7a names
    the token (`%counter:N%`) but not a bare-form default, so there was
    nothing there to defer to.
    """
    import datetime as _dt

    if now is None:
        now = _dt.datetime.now()

    def _date_token(match: "re.Match[str]") -> str:
        fmt = match.group(1)
        # A small yyyy/MM/dd/HH/mm/ss token set (translated to strftime)
        # rather than raw strftime codes, matching how these read elsewhere
        # in the pack's design docs.
        py_fmt = (
            fmt.replace("yyyy", "%Y").replace("MM", "%m").replace("dd", "%d")
            .replace("HH", "%H").replace("mm", "%M").replace("ss", "%S")
        )
        try:
            return now.strftime(py_fmt)
        except ValueError:
            return now.strftime("%Y-%m-%d-%H%M%S")

    def _counter_token(match: "re.Match[str]") -> str:
        digits = match.group(1)
        if digits is None:
            # Bare `%counter%` -- no explicit width given; default to 5,
            # matching `collision_suffixed_filename`'s own suffix width
            # (this function's own docstring explains why).
            pad = 5
        else:
            try:
                pad = int(digits)
            except (TypeError, ValueError):
                pad = 5
        return str(max(0, int(counter))).zfill(max(1, pad))

    result = str(template or "")
    result = re.sub(r"%date:([^%]*)%", _date_token, result)
    result = _COUNTER_TOKEN_RE.sub(_counter_token, result)
    result = result.replace("%stage%", str(stage))
    result = result.replace("%seed%", str(seed))
    result = result.replace("%width%", str(int(width)))
    result = result.replace("%height%", str(int(height)))
    return result
