"""Pure message builders for the Anima track's server-side run log
(task brief: "an entire debugging session was spent pasting browser-console
probes to answer questions the server could simply have printed"). Every
function here takes plain dicts/values and returns a `str` — no `logging`
call, no comfy/torch import, nothing impure at all, matching every other
module in `src/anima/` (`.claude/CLAUDE.md`'s pure/impure rule: only
`pipeline.py` (and, for one preview-only line, `nodes/anima/preview.py`)
actually calls `logging.getLogger(...).info(...)` with what these functions
return).

**Verbosity contract, in THREE levels (`off`/`summary`/`debug` — the
"Console logging" Settings-dialog combo, `js/shared/settings.mjs`)**:
`summary` is exactly four kinds of line — `format_run_header` (which stages
are live vs. off, dependency-missing distinguished from plainly-disabled),
`format_sampler_provenance` (the five sampler scalars, context vs. settings
— "the single most valuable line"), `format_model_files_line` (the resolved
SAM3/upscale-model filenames the pre-flight check already verified), and one
`format_stage_result`/`format_detailer_block_line` line per stage/block.
`debug` adds the finer-grained lines (the full eleven-field context-supplied
report, a stage's own resolved steps/cfg/sampler/scheduler/denoise). `off`
silences ALL of it — callers check the resolved level themselves (`pipeline.
py`'s `_log_level`/`_should_log`/`_debug_enabled`) and skip every call
entirely when it says not to, rather than this module deciding what to print
internally; this module's own job stays "build the string", never "decide
whether to print it".

**Two ways to set the level, with a documented precedence**:

1. **`ANIMAFLOW_DEBUG`** — set this env var to `1`/`true`/`yes`/`on`
   (case-insensitive) to force the `debug` level, REGARDLESS of the
   Settings-dialog value — the escape hatch for a headless run with no
   browser attached (there is no `comfy.settings.json` to read a frontend
   choice from in that case, and even if there were, an operator running
   `ANIMAFLOW_DEBUG=1 python ...` clearly wants debug output). Read via
   `is_debug_enabled`, which takes a plain mapping (never reads `os.environ`
   itself) so it stays exactly as testable as everything else here.
2. **The "Console logging" Settings-dialog value** (`src/anima/
   frontend_settings.py` reads it from ComfyUI's own persisted
   `comfy.settings.json`) — used whenever the env var ISN'T truthy. Defaults
   to `off` if the file is missing/unreadable/malformed or the key was never
   set (this module never touches that file itself; the caller passes the
   already-resolved raw value in).

`effective_log_level(env, setting_value)` below is the ONE function that
combines these two into a single `"off"|"summary"|"debug"` result — the only
thing every caller (`pipeline.py`'s `_log_level`, `preview.py`'s own copy)
actually needs to call each time it wants to know "should I log, and how
much". `normalize_log_level` is its pure "coerce whatever the settings file
handed back into one of the three legal strings" half, exported separately
so it's independently testable against garbage.

**Fail-safe by construction**: every public function is wrapped (`_safe`,
below) so a genuinely hostile/garbage input — the wrong type, a missing key,
`None` where a number is expected — produces a short fallback string instead
of raising. A log line must never be worth an exception mid-sample (task
brief) — this is what makes that true even for a caller that hands one of
these a value it never validated.

**Never log anything large or sensitive** (task brief): no prompt text, no
tensors, no full settings-blob dumps — every function below only ever
touches counts, names, dimensions, and provenance flags, by construction (no
function here even accepts a "the whole settings tree" argument).

**2026-07-31: the level core moved to `src/console_logging.py`.**
`CONSOLE_LOGGING_SETTING_ID`, `LOG_LEVELS`, `DEFAULT_LOG_LEVEL`,
`normalize_log_level`, `effective_log_level`, `is_debug_enabled`, and the
`_safe` decorator used to be DEFINED here; `src/model_browser/logs.py` (the
Civitai browser's own console log, wired to this SAME "Console logging"
Settings-dialog control) needed the identical vocabulary, and copying it a
second time -- or having one feature import the other's internals -- would
have been exactly the coupling `.claude/CLAUDE.md`'s `src/<feature>/` rule
exists to prevent. So that generic half moved out to a small, feature-
agnostic sibling module (`src/console_logging.py`'s own docstring has the
full reasoning), and this module now just RE-EXPORTS it below -- a move,
not a redesign: every name still resolves through `logs_mod.<name>` exactly
as before, `pipeline.py`/`nodes/anima/preview.py`/this module's own test
suite (`tests/test_anima_logs.py`) are unmodified, and behaviour (including
the `ANIMAFLOW_DEBUG` precedence) is byte-identical to before this move.
Everything BELOW this re-export block is unchanged: the anima-specific
message builders this module still owns.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..console_logging import (
    CONSOLE_LOGGING_SETTING_ID,
    DEFAULT_LOG_LEVEL,
    LOG_LEVELS,
    _safe,
    effective_log_level,
    is_debug_enabled,
    normalize_log_level,
)

# The shared logger name `pipeline.py`/`nodes/anima/preview.py` both create
# via `logging.getLogger(LOGGER_NAME)` — one name for the whole track, so
# ComfyUI's console (and `user/comfyui.log`) groups every Anima run line
# under it. The `[AnimaFlow]` prefix still lives in the MESSAGE TEXT itself
# (matching this pack's existing error convention — `ContextFieldMissing`,
# `ModelFileMissing`), not just the logger name, since a lot of ComfyUI
# console formatters don't print the logger name at all.
LOGGER_NAME = "AnimaFlow.anima"


# ---------------------------------------------------------------------------
# Run header — which stages are live/off, dependency-missing distinguished
# from plainly-disabled.
# ---------------------------------------------------------------------------


def _stage_status_text_impl(
    *,
    enabled: bool,
    live: bool,
    dependency_missing: bool = False,
    dependency_label: str = "",
    not_live_reason: str = "",
) -> str:
    if not enabled:
        return "off"
    if dependency_missing:
        return f"off (needs {dependency_label})" if dependency_label else "off (missing dependency)"
    if not live:
        return f"off ({not_live_reason})" if not_live_reason else "off"
    return "on"


stage_status_text = _safe(_stage_status_text_impl)


def _format_run_header_impl(
    *,
    mod_guidance_status: str,
    highres_status: str,
    detailer_status: str,
    upscale_status: str,
    postprocess_status: str,
) -> str:
    return (
        "[AnimaFlow] Anima Generator run - stages: "
        f"mod_guidance={mod_guidance_status}, highres={highres_status}, "
        f"detailer={detailer_status}, upscale={upscale_status}, "
        f"postprocess={postprocess_status}"
    )


format_run_header = _safe(_format_run_header_impl)


# ---------------------------------------------------------------------------
# Sampler provenance — the single most valuable line (task brief).
# ---------------------------------------------------------------------------

# The five context-wireable sampler scalars, in the order they're reported —
# matches `resources.SAMPLER_FIELDS`'s own order (kept as a literal tuple
# here, not imported, so this module stays free of every OTHER `src/anima/`
# module — pure presentation shouldn't need to import a resolution module to
# know its own field list; both are frozen strings, so drifting apart is not
# a realistic risk).
_SAMPLER_PROVENANCE_FIELDS = ("seed", "steps", "cfg", "sampler_name", "scheduler")


def _format_sampler_provenance_impl(
    resolved_sampler: Dict[str, Any], supplied: Dict[str, bool],
) -> str:
    resolved_sampler = resolved_sampler if isinstance(resolved_sampler, dict) else {}
    supplied = supplied if isinstance(supplied, dict) else {}
    parts = []
    for field in _SAMPLER_PROVENANCE_FIELDS:
        value = resolved_sampler.get(field)
        source = "context" if supplied.get(field) else "settings"
        parts.append(f"{field}={value!r} ({source})")
    return "[AnimaFlow] Sampler resolved: " + ", ".join(parts)


format_sampler_provenance = _safe(_format_sampler_provenance_impl)


# ---------------------------------------------------------------------------
# Model files — the resolved SAM3/upscale-model filenames the pre-flight
# check already verified are installed (`model_files.raise_if_missing` has
# already run by the time `pipeline.py` builds this line — see that
# module's own docstring).
# ---------------------------------------------------------------------------


def _format_model_files_line_impl(
    *,
    detailer_live: bool,
    sam3_checkpoint: Optional[str],
    upscale_live: bool,
    upscale_model: Optional[str],
) -> str:
    if detailer_live and sam3_checkpoint:
        detailer_text = f"SAM3 checkpoint '{sam3_checkpoint}' (verified installed)"
    else:
        detailer_text = "not needed (stage off)"
    if upscale_live and upscale_model:
        upscale_text = f"upscale model '{upscale_model}' (verified installed)"
    else:
        upscale_text = "not needed (stage off)"
    return f"[AnimaFlow] Model files - detailer: {detailer_text}; upscale: {upscale_text}"


format_model_files_line = _safe(_format_model_files_line_impl)


# ---------------------------------------------------------------------------
# Per-stage result lines — one per stage, image dimensions when it actually
# produced one, so a size surprise is visible (task brief).
# ---------------------------------------------------------------------------


def _format_stage_result_impl(
    stage: str, status_text: str, width: Optional[int] = None, height: Optional[int] = None,
) -> str:
    dims = ""
    if width is not None and height is not None:
        dims = f" -> {int(width)}x{int(height)}"
    return f"[AnimaFlow] Stage '{stage}': {status_text}{dims}"


format_stage_result = _safe(_format_stage_result_impl)


def _format_postprocess_status_impl(*, enabled: bool, applied: bool) -> str:
    if not enabled:
        return "off"
    if applied:
        return "on"
    return "no-op (already within target size)"


format_postprocess_status = _safe(_format_postprocess_status_impl)


def _format_detailer_block_line_impl(block_id: str, *, enabled: bool, changed: bool) -> str:
    if not enabled:
        status = "disabled"
    elif changed:
        status = "ran"
    else:
        status = "unchanged (nothing detected, or a soft dependency is unavailable)"
    return f"[AnimaFlow] Detailer block '{block_id}': {status}"


format_detailer_block_line = _safe(_format_detailer_block_line_impl)


# ---------------------------------------------------------------------------
# ANIMAFLOW_DEBUG-gated detail — full context-supplied report, and a stage's
# own resolved sampler values (steps/cfg/sampler_name/scheduler/denoise).
# ---------------------------------------------------------------------------


def _format_context_supplied_debug_impl(supplied: Dict[str, bool]) -> str:
    supplied = supplied if isinstance(supplied, dict) else {}
    present = [field for field, value in supplied.items() if value]
    absent = [field for field, value in supplied.items() if not value]
    return (
        "[AnimaFlow] Context fields supplied: "
        f"[{', '.join(present) if present else '(none)'}]; "
        f"not supplied: [{', '.join(absent) if absent else '(none)'}]"
    )


format_context_supplied_debug = _safe(_format_context_supplied_debug_impl)


def _format_stage_sampler_debug_impl(stage: str, resolved: Dict[str, Any]) -> str:
    resolved = resolved if isinstance(resolved, dict) else {}
    fields = ("steps", "cfg", "sampler_name", "scheduler", "denoise")
    parts = [f"{field}={resolved.get(field)!r}" for field in fields]
    return f"[AnimaFlow] Stage '{stage}' sampler: " + ", ".join(parts)


format_stage_sampler_debug = _safe(_format_stage_sampler_debug_impl)


# ---------------------------------------------------------------------------
# AnimaPreview's own per-run line — how many images arrived, the stage
# labels resolved for them, and for each stage whether it was saved (and to
# what path) or written to temp for preview only (task brief).
# ---------------------------------------------------------------------------


def _describe_preview_entries(stage: str, entries: List[Dict[str, Any]]) -> str:
    if not entries:
        return f"{stage}: not written"
    first = entries[0]
    first = first if isinstance(first, dict) else {}
    if first.get("type") == "output":
        subfolder = str(first.get("subfolder") or "").strip("/")
        filename = str(first.get("filename") or "?")
        path = f"{subfolder}/{filename}" if subfolder else filename
        extra = f" (+{len(entries) - 1} more)" if len(entries) > 1 else ""
        return f"{stage}: saved -> {path}{extra}"
    return f"{stage}: temp only (preview, not saved)"


def _format_preview_run_line_impl(
    *, image_count: int, stage_labels: List[str], entries: List[Dict[str, Any]],
) -> str:
    stage_labels = stage_labels if isinstance(stage_labels, list) else []
    entries = entries if isinstance(entries, list) else []

    by_stage: Dict[str, List[Dict[str, Any]]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        by_stage.setdefault(str(entry.get("stage", "?")), []).append(entry)

    labels_text = ", ".join(str(label) for label in stage_labels) if stage_labels else "(none)"
    per_stage = [_describe_preview_entries(label, by_stage.get(label, [])) for label in stage_labels]
    per_stage_text = "; ".join(per_stage) if per_stage else "(no stages present)"

    return (
        f"[AnimaFlow] Anima Preview run: {int(image_count)} image(s) arrived, "
        f"stages=[{labels_text}]; {per_stage_text}"
    )


format_preview_run_line = _safe(_format_preview_run_line_impl)


__all__ = (
    "LOGGER_NAME",
    "CONSOLE_LOGGING_SETTING_ID",
    "LOG_LEVELS",
    "DEFAULT_LOG_LEVEL",
    "is_debug_enabled",
    "normalize_log_level",
    "effective_log_level",
    "stage_status_text",
    "format_run_header",
    "format_sampler_provenance",
    "format_model_files_line",
    "format_stage_result",
    "format_postprocess_status",
    "format_detailer_block_line",
    "format_context_supplied_debug",
    "format_stage_sampler_debug",
    "format_preview_run_line",
)
