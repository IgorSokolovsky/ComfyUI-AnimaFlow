"""Anima Loader Panel -- unet/vae/clip rows, each wired out to its own fixed
output slot (contract: docs/control-panel-design.md §2/§3).

Split out from the Control Panel deliberately: ComfyUI's cache signature is
per NODE and propagates to everything downstream of ANY of its outputs, so a
seed row and a unet row sharing one node would reload the model on every
seed bump. This node only holds the rarely-changing rows (unet/vae/clip);
`control_panel.py` holds the constantly-changing ones.

Same state-widget contract as the Control Panel: a declared, natively-
serialized STRING (`panel_state`), not a `hidden` input, no `graphToPrompt`
dependency. Loading itself -- including the model-loader cache and the
filename-validation error -- lives in `_loaders_helpers.py`.

A row only loads when its output slot is actually wired to something (§2
"third consequence" in the design doc): loading a row means pulling a real
MODEL/VAE/CLIP onto the GPU, and a Colab-class user with tight VRAM pays for
every row present in state whether or not anything downstream consumes it.
`run()` declares hidden `prompt`/`unique_id` inputs (unrelated to
`panel_state`, which remains the only `required` input) purely to scan which
of our own output slots the graph actually references
(`_loaders_helpers.referenced_slots`) and skips loading -- emitting the same
`0` an absent row already emits -- for every slot nothing points at.

VERIFIED (not assumed) that adding these hidden inputs does NOT pull the
whole workflow into this node's cache signature -- i.e. an unrelated edit
anywhere else in the graph does NOT invalidate this node and force a
reload. Read directly from ComfyUI's own source
(github.com/comfyanonymous/ComfyUI, `master` branch, fetched 2026-07-27):
  - `comfy_execution/caching.py`,
    `CacheKeySetInputSignature.get_immediate_node_signature()` builds the
    per-node cache signature ONLY from `node["inputs"]` -- the node's own
    declared required/optional inputs as serialized in the prompt JSON --
    plus the `IS_CHANGED` result and (only when the class's hidden dict
    contains `"UNIQUE_ID"`, which ours now does) this node's OWN `node_id`.
    It never reads any OTHER node's `inputs`, so nothing elsewhere in the
    graph can appear in our signature.
  - `execution.py`'s `get_input_data()` is where hidden values (`PROMPT`,
    `UNIQUE_ID`, ...) actually get resolved into real objects -- and it does
    so from its own `unique_id`/`dynprompt` PARAMETERS, entirely separate
    from the `node["inputs"]` dict the signature above reads. Hidden values
    are never written into `node["inputs"]` in the first place.
  - `execution.py`'s `IsChangedCache.get()` only calls a node's `IS_CHANGED`
    at all if the class defines one (`hasattr(class_def, "IS_CHANGED")`).
    This class deliberately does NOT define `IS_CHANGED`, so that path is a
    no-op here regardless.
So: this node's cache key is `(class_type, False, this_node_id, ("panel_state", <value>))`
-- the whole-graph `prompt` never enters it. No `IS_CHANGED` override was
needed as a mitigation; if a future ComfyUI version changes this, an
`IS_CHANGED` hashing only `(panel_state, sorted(referenced slots))` would be
the fallback (mark any such change `VERIFY-IN-COMFYUI:` before relying on it
again).

NOT mirrored on `AnimaControlPanel`: see that file's docstring for why.

**Diagnostic logging (task brief: "the owner suspects `AnimaLoaderPanel`
loads the WRONG model -- not the one the row asked for")** -- reuses the
pack's existing `AnimaFlow.General.ConsoleLogging` off/summary/debug control
(`src/anima/logs.py`), the SAME setting `pipeline.py`/`nodes/anima/
preview.py` already read, via the same `frontend_settings.get_setting` +
`logs.effective_log_level` pattern `nodes/anima/preview.py`'s own
`_should_log` uses -- no second toggle. `off` never even builds an event
list (`_log_level()` is checked before any per-slot bookkeeping happens), so
it stays genuinely silent with zero extra work. `summary` prints one line
(loaded/skipped/empty counts, plus a duplicate-slot-collision count if any).
`debug` adds one line PER OUTPUT SLOT -- slot number, the row's OWN display
index side by side (so a slot/display-order divergence is visible, not
inferred), kind, the name asked for, the resolved absolute path actually
opened (the decisive field), loaded/skipped/why, and cache hit/miss + key --
plus one line per duplicate-slot collision actually found. Every formatter
is pure (`_loader_log_helpers.py`); this module builds the event dicts (the
one impure step: it calls `_loaders_helpers.cache_probe`/`resolve_full_path`,
both read-only) and is the sole `_logger.info(...)` call site, wrapped so a
logging bug can never fail a run (`_emit_loader_log`, below).
"""
from __future__ import annotations

import logging
import os

from ._loader_log_helpers import (
    detect_duplicate_slots,
    format_duplicate_slot_line,
    format_loader_run_summary,
    format_loader_slot_line,
)
from ._loaders_helpers import (
    LoaderCache,
    LoaderRowError,
    cache_probe,
    load_row_model,
    referenced_slots,
    resolve_full_path,
)
from ._rows_helpers import detect_state_mismatch, parse_state, rows_by_slot
from ._type_helpers import ANY

try:
    # Real ComfyUI context -- same convention as `nodes/anima/preview.py`'s
    # import of `src.anima.{frontend_settings,logs}`.
    from ...src.anima import frontend_settings as frontend_settings_mod  # type: ignore
    from ...src.anima import logs as logs_mod  # type: ignore
except ImportError:
    # Standalone context (plain-script tests, repo root on `sys.path`).
    from src.anima import frontend_settings as frontend_settings_mod
    from src.anima import logs as logs_mod

# See control_panel.py's CATEGORY comment: Title Case in the picker, the
# folder underneath (`nodes/controls/`, `js/controls/`) stays snake_case.
CATEGORY = "AnimaFlow/Controls"

# Fixed output-slot budget -- smaller than the Control Panel's because a
# loader row is one of exactly three fixed kinds (unet/vae/clip), not an
# open-ended catalog. May grow later, must NEVER shrink (see
# control_panel.MAX_ROWS's comment -- the same slot-stability rule applies).
MAX_ROWS = 8

# Same shared logger name every Anima-track module logs under
# (`src/anima/logs.py`'s own docstring: one name so ComfyUI's console groups
# every AnimaFlow line together; the `[AnimaFlow]` prefix still lives in the
# message text itself).
_logger = logging.getLogger(logs_mod.LOGGER_NAME)

# The kinds `_loaders_helpers.cache_probe`/`resolve_full_path` know how to
# read a cache key / resolved path for -- the three real loader kinds a row
# can be; anything else (an empty/unrecognized row) has neither.
_LOADABLE_KINDS = ("unet", "vae", "clip")


def _log_level() -> str:
    """Same off/summary/debug resolution `pipeline.py`'s own `_log_level`
    and `nodes/anima/preview.py`'s own `_should_log` use -- `ANIMAFLOW_DEBUG`
    forces `"debug"`; otherwise the "Console logging" Settings-dialog value,
    defaulting to `logs.DEFAULT_LOG_LEVEL` ("off")."""
    setting_value = frontend_settings_mod.get_setting(
        logs_mod.CONSOLE_LOGGING_SETTING_ID, logs_mod.DEFAULT_LOG_LEVEL,
    )
    return logs_mod.effective_log_level(os.environ, setting_value)


def _emit_loader_log(
    log_level: str, events, duplicate_collisions,
) -> None:
    """Print this run's diagnostic at the resolved verbosity -- wrapped so a
    formatting/logging bug can NEVER fail a graph run (task brief:
    "Logging must never fail a run"). `log_level == "off"` is also checked
    by the caller before `events` is even built, so this is a second,
    belt-and-braces guard, not the only one."""
    try:
        if log_level == "off":
            return
        loaded = sum(1 for e in events if e.get("status") == "loaded")
        empty = sum(1 for e in events if e.get("skip_reason") == "empty row")
        skipped = len(events) - loaded - empty
        _logger.info(format_loader_run_summary(
            loaded_count=loaded, skipped_count=skipped, empty_count=empty,
            duplicate_count=len(duplicate_collisions),
        ))
        if log_level == "debug":
            # Skip a per-slot line for a genuinely empty slot (no row at
            # all) -- the run summary's own "N slot(s) empty" count already
            # covers those, so printing one "(no row) -- skipped (empty
            # row)" line per unused slot (5 of them on a typical 3-row
            # panel, since MAX_ROWS is a fixed 8) is pure noise that buries
            # the lines that actually carry information (owner feedback,
            # 2026-07-30: "why do we have empty slots when the UI doesn't
            # have it"). A slot that HAS a row -- loaded, skipped for any
            # other reason, or errored -- still gets its own line.
            for event in events:
                if event.get("skip_reason") == "empty row":
                    continue
                _logger.info(format_loader_slot_line(event))
            for collision in duplicate_collisions:
                _logger.info(format_duplicate_slot_line(**collision))
    except Exception:  # noqa: BLE001 - a log line must never break a run.
        pass


class AnimaLoaderPanel:
    """`Anima Loader Panel` -- unet/vae/clip rows, each emitting a real
    MODEL/VAE/CLIP object from its own fixed output slot. A row only loads
    (and only then touches VRAM) when its output slot is actually wired to
    something downstream; an unwired row's slot emits `0`, same as an empty
    slot."""

    DESCRIPTION = (
        "Holds unet/vae/clip loader rows, each with its own real "
        "MODEL/VAE/CLIP output socket. A row only loads -- and only then "
        "touches VRAM -- when its socket is actually wired to something "
        "downstream, so an unused row costs "
        "nothing. Kept separate from the Control Panel on purpose: sharing "
        "one node with a fast-changing row like seed would reload every "
        "model on every bump."
    )

    CATEGORY = CATEGORY
    FUNCTION = "run"
    RETURN_TYPES = (ANY,) * MAX_ROWS
    RETURN_NAMES = tuple(f"value_{i + 1}" for i in range(MAX_ROWS))
    OUTPUT_TOOLTIPS = tuple(
        (
            f"Loader row output slot {i + 1}. Emits the real MODEL/VAE/CLIP "
            "object loaded by the row currently occupying this slot (reused "
            "from a per-row-kind cache when the row's name/options haven't "
            "changed since the last load) -- but ONLY if this slot is "
            "actually wired to something; an unwired row is never loaded at "
            "all, to avoid pulling an unused model onto the GPU. Emits 0 if "
            "no row currently occupies this slot, or if this slot isn't "
            "wired to anything. Wildcard-typed in Python; the frontend "
            "narrows the visible wire type per row."
        )
        for i in range(MAX_ROWS)
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "panel_state": (
                    "STRING",
                    {
                        "default": "{}",
                        "tooltip": (
                            "Serialized Loader Panel state (JSON): its unet/vae/"
                            "clip rows, each row's picked filename and options "
                            "(weight_dtype/type/device). Written by the panel's "
                            "own frontend widget after every edit -- hidden for "
                            "rendering only, not meant to be hand-edited."
                        ),
                    },
                ),
            },
            # Used ONLY to work out which output slots are actually wired
            # (`_loaders_helpers.referenced_slots`), so an unwired row's
            # model is never loaded -- see this module's docstring for why
            # this is safe with respect to ComfyUI's cache signature.
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    def __init__(self) -> None:
        # Per-node-instance model cache (kind -> (cache_key, loaded_object),
        # ONE entry per kind -- see `_loaders_helpers.py`'s own docstring for
        # why) -- lives here, not at module scope, so two Loader Panel
        # instances holding different models never evict each other, while
        # still surviving between runs of THIS node the way ComfyUI already
        # keeps node instances alive between queue executions (same pattern
        # `lora_loader.py`'s own `__init__`/`LoraCache` uses). Passed
        # explicitly into `load_row_model`/`cache_probe` below -- neither
        # function reaches for a shared global.
        self._cache: LoaderCache = {}

    def run(self, panel_state: str = "{}", prompt=None, unique_id=None):
        # LOUD, unconditional -- deliberately NOT gated behind `_log_level()`
        # (unlike `_emit_loader_log` below): a hijacked `panel_state` input
        # (2026-07-29 live bug -- `detect_state_mismatch`'s own docstring in
        # `_rows_helpers.py` has the full story) silently replaces the user's
        # ENTIRE row list with something else's STRING output, and
        # `parse_state` below already degrades that to an empty row list with
        # ZERO signal -- that must surface regardless of whether "Console
        # logging" is even turned on. This only OBSERVES it -- it never
        # changes what `parse_state` returns, and stays silent for the two
        # non-noteworthy cases (genuinely absent/first-run, or a value that
        # IS this node's own shape).
        mismatch_reason = detect_state_mismatch(panel_state)
        if mismatch_reason:
            _logger.warning(
                "[AnimaFlow] Anima Loader Panel: panel_state did not arrive as "
                "this node's own saved state (%s). Another extension appears "
                "to have wired something into this node's state input -- a "
                "same-typed STRING output getting broadcast here by something "
                "like cg-use-everywhere is a common cause. Falling back to "
                "default rows for this run.",
                mismatch_reason,
            )

        state = parse_state(panel_state)
        rows = state["rows"]
        slots = rows_by_slot(rows, MAX_ROWS)

        # `None` means "couldn't tell which slots are wired" -- fail OPEN
        # and load everything, exactly the old (pre-scan) behaviour, rather
        # than risk silently starving a row the graph actually needs.
        wanted = referenced_slots(prompt, unique_id, MAX_ROWS)

        # `None` (not an empty list) at `"off"` means "don't even bother
        # building the bookkeeping" -- `off` must stay genuinely silent AND
        # genuinely free, not just silent at the print step.
        log_level = _log_level()
        events = [] if log_level != "off" else None
        display_index_by_id = None
        if events is not None and isinstance(rows, list):
            # A row's position in DISPLAY order, 1-based -- side by side with
            # its `slot` in every event line below is the whole point (task
            # brief: "the second row I see" and "output slot 2" are not the
            # same thing). Keyed by `id()`: `rows_by_slot` hands back the
            # SAME dict objects (never copies), so identity is a safe key
            # for one `run()` call's lifetime.
            display_index_by_id = {
                id(row): i + 1 for i, row in enumerate(rows) if isinstance(row, dict)
            }

        out = []
        for slot in range(1, MAX_ROWS + 1):
            row = slots.get(slot)

            if row is None:
                out.append(0)
                if events is not None:
                    events.append({"slot": slot, "display_index": None, "status": "skipped", "skip_reason": "empty row"})
                continue

            display_index = display_index_by_id.get(id(row)) if display_index_by_id is not None else None
            kind = row.get("kind") if isinstance(row, dict) else None
            name = row.get("value") if isinstance(row, dict) else None

            if wanted is not None and slot not in wanted:
                out.append(0)
                if events is not None:
                    events.append({
                        "slot": slot, "display_index": display_index, "kind": kind, "name": name,
                        "status": "skipped", "skip_reason": "not referenced by anything downstream",
                    })
                continue

            # Diagnostic-only reads (never affect the real load below):
            # would this exact row hit the per-kind cache, and what absolute
            # path does its name actually resolve to right now?
            cache_key = cache_hit = resolved_path = None
            if events is not None and isinstance(kind, str) and kind in _LOADABLE_KINDS:
                opts = row.get("opts") if isinstance(row.get("opts"), dict) else {}
                try:
                    probe = cache_probe(kind, name, opts, self._cache) if isinstance(name, str) else None
                    if probe is not None:
                        cache_key, cache_hit = probe["cache_key"], probe["hit"]
                except Exception:  # noqa: BLE001 - diagnostic read, never fatal.
                    pass
                try:
                    resolved_path = resolve_full_path(kind, name)
                except Exception:  # noqa: BLE001 - diagnostic read, never fatal.
                    resolved_path = None

            try:
                obj = load_row_model(row, self._cache)
            except LoaderRowError as exc:
                if events is not None:
                    events.append({
                        "slot": slot, "display_index": display_index, "kind": kind, "name": name,
                        "status": "error", "skip_reason": f"missing file -- {exc}",
                    })
                    _emit_loader_log(log_level, events, detect_duplicate_slots(rows, MAX_ROWS))
                raise

            out.append(obj)
            if events is not None:
                events.append({
                    "slot": slot, "display_index": display_index, "kind": kind, "name": name,
                    "status": "loaded", "resolved_path": resolved_path,
                    "cache_hit": cache_hit, "cache_key": cache_key,
                })

        if events is not None:
            _emit_loader_log(log_level, events, detect_duplicate_slots(rows, MAX_ROWS))

        return tuple(out)


NODE_CLASS_MAPPINGS = {"AnimaLoaderPanel": AnimaLoaderPanel}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaLoaderPanel": "Anima Loader Panel"}
