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


def collision_suffixed_filename(filename: str, attempt: int) -> str:
    """The `attempt`-th candidate name in the "never overwrite" collision
    loop (data-loss bug fix: `AnimaPreview` was silently clobbering an
    existing file that happened to resolve to the same templated name --
    e.g. the same seed run twice on the same day at the same stage, the
    default filename template has no `%counter%` token). `attempt == 0` is
    the plain `filename` unchanged -- the FIRST file at a given name always
    keeps its plain name, per the owner's spec; a suffix only appears once
    there is an actual collision. `attempt >= 1` inserts a zero-padded
    6-digit counter BEFORE the extension: `name_000000.ext`,
    `name_000001.ext`, ... so `attempt=1` is the first collision's name
    (`_000000`), matching the spec's own example numbering exactly (its
    `_000000`/`_000001` are 1-indexed off `attempt`, not 0-indexed).

    Extension-preserving via `os.path.splitext`, so a dotted stem
    (`my.file.png`) only has its LAST extension treated as one --
    `my.file_000000.png`, never `my.file.png_000000`. `os.path` is pure
    string manipulation (no filesystem access), so this stays a pure
    function: no I/O, callable from a plain-script test with no directory
    on disk at all. The actual collision LOOP (deciding which `attempt` is
    free, and enforcing that atomically against a real directory) is
    impure and lives in `nodes/anima/_preview_helpers.py`, which calls this
    for each candidate in turn -- this function only ever answers "what
    would attempt N look like", never "is attempt N free".
    """
    if attempt <= 0:
        return filename
    import os.path

    stem, ext = os.path.splitext(filename)
    return f"{stem}_{attempt - 1:06d}{ext}"


def format_filename(
    template: str, *, stage: str, seed: Any, width: int, height: int, counter: int, now: Any = None,
) -> str:
    """Expand the design doc §7a filename tokens: `%stage%` (`base`/`mid`/
    `final` — the one that justifies putting save on the Preview node at
    all, §2/§7a), `%seed%`, `%date:FMT%`, `%counter:N%`, `%width%`,
    `%height%`. Pure given an explicit `now` — callers pass the real current
    time; tests pass a fixed one for determinism. No comfy/torch import.
    """
    import datetime as _dt
    import re

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
        try:
            pad = int(match.group(1))
        except (TypeError, ValueError):
            pad = 4
        return str(max(0, int(counter))).zfill(max(1, pad))

    result = str(template or "")
    result = re.sub(r"%date:([^%]*)%", _date_token, result)
    result = re.sub(r"%counter:(\d+)%", _counter_token, result)
    result = result.replace("%stage%", str(stage))
    result = result.replace("%seed%", str(seed))
    result = result.replace("%width%", str(int(width)))
    result = result.replace("%height%", str(int(height)))
    return result
