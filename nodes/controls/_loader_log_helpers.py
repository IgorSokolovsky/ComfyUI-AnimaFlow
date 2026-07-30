"""Pure message builders + pure data-shaping for `AnimaLoaderPanel`'s per-run
diagnostic ("the owner suspects `AnimaLoaderPanel` loads the WRONG model --
not the one the row asked for"). No `logging` call and no comfy/torch/
folder_paths import anywhere in this file -- matching `src/anima/logs.py`'s
own `_..._impl`/`_safe` split (that module's docstring explains the fail-safe
contract this mirrors). `loader_panel.py` is the ONLY impure caller: it
builds the per-slot event dicts (using real `_loaders_helpers.cache_probe`/
`resolve_full_path` reads) and is the sole `logging.getLogger(...).info(...)`
call site, exactly the split `pipeline.py`/`nodes/anima/preview.py` already
use for `src/anima/logs.py`'s own formatters.

Lives in `nodes/controls/` (not `src/anima/`) because this is Loader-Panel-
specific presentation -- nothing here is a decision `src/anima/pipeline.py`
or any other Anima-track module needs; it belongs next to the node it
describes (`.claude/CLAUDE.md`'s "put logic in `src/<feature>/` or a sibling
`_*_helpers.py`", read for `nodes/controls/` rather than `src/anima/`).

**Why the whole mapping, not just a name** (task brief): printing "loading
X" only confirms the name already in doubt. Every event dict below carries
BOTH the row's own `slot` and its `display_index` (position in the panel's
`rows` array, i.e. what the user sees top-to-bottom) side by side, precisely
so a divergence between "the row I see" and "the output slot that fired" is
visible on sight, not inferred -- see `js/controls/rows.mjs`'s "Slot vs.
display order" section and `_rows_helpers.rows_by_slot`'s own docstring for
why the two numbers can differ at all.

**Verbosity contract -- reuses `src/anima/logs.py`'s existing three levels,
no second toggle**: `summary` is exactly ONE line
(`format_loader_run_summary`) -- loaded/skipped/empty counts, plus a
duplicate-slot-collision COUNT folded into that same line so a collision is
never silent even at `summary`, without breaking the "at most one line at
summary" contract. `debug` adds one `format_loader_slot_line` per slot (the
full per-slot mapping: slot, display index, kind, name, resolved path,
loaded/skipped/why, cache hit/miss + key) plus one
`format_duplicate_slot_line` per actual collision (the specific rows
involved and which one wins). `off` -- the caller simply never calls any of
these; this module has no opinion on whether to log, only how to phrase it
(same division of labour as `src/anima/logs.py`).
"""
from __future__ import annotations

import functools
from typing import Any, Callable, Dict, List


def _safe(fn: Callable[..., str]) -> Callable[..., str]:
    """Same fail-safe wrapper as `src/anima/logs.py`'s own `_safe`: any
    exception a formatter raises degrades to a short fallback string instead
    of propagating -- a log line must never be worth failing a run over."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> str:
        try:
            return fn(*args, **kwargs)
        except Exception:  # noqa: BLE001 - a log line must never raise.
            return f"[AnimaFlow] (log message unavailable: {fn.__name__})"

    return wrapper


# ---------------------------------------------------------------------------
# Duplicate-slot detection -- pure, and DELIBERATELY separate from
# `_rows_helpers.rows_by_slot` (which only reports the WINNER): this reports
# every collision the winner-only map would otherwise hide entirely, without
# changing what `rows_by_slot` itself does or returns.
# ---------------------------------------------------------------------------


def detect_duplicate_slots(rows: Any, max_rows: int) -> List[Dict[str, Any]]:
    """Which slot numbers are claimed by MORE than one row in `rows`
    (display order), and -- per `rows_by_slot`'s own documented tie-break --
    which row (by 1-based display index) ends up winning. Mirrors
    `rows_by_slot`'s own slot-parsing rules exactly (non-dict rows, a
    non-int-coercible `slot`, and a `slot` outside `[1, max_rows]` are all
    ignored the same way) so this reports collisions against the SAME
    candidate set `rows_by_slot` itself considers -- never a different one.

    Returns a list of `{"slot": int, "display_indexes": [1-based, in display
    order], "winner_display_index": int}`, one entry per colliding slot,
    sorted by slot number. An empty list means no collision at all (the
    overwhelmingly common case). Never raises: any non-list `rows` is
    treated as empty.
    """
    if not isinstance(rows, list):
        return []

    by_slot: Dict[int, List[int]] = {}
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        try:
            slot_i = int(row.get("slot"))
        except (TypeError, ValueError):
            continue
        if slot_i < 1 or slot_i > max_rows:
            continue
        by_slot.setdefault(slot_i, []).append(i + 1)

    collisions = [
        {
            "slot": slot_i,
            "display_indexes": display_indexes,
            # Last in display order wins -- `rows_by_slot`'s own documented
            # tie-break (`slots[slot_i] = row` inside a plain `for` loop).
            "winner_display_index": display_indexes[-1],
        }
        for slot_i, display_indexes in by_slot.items()
        if len(display_indexes) > 1
    ]
    collisions.sort(key=lambda c: c["slot"])
    return collisions


# ---------------------------------------------------------------------------
# Per-slot line -- the full mapping, one line per output slot.
# ---------------------------------------------------------------------------


def _format_loader_slot_line_impl(event: Dict[str, Any]) -> str:
    event = event if isinstance(event, dict) else {}
    slot = event.get("slot")
    display_index = event.get("display_index")
    kind = event.get("kind")
    name = event.get("name")

    if display_index is None:
        who = "(no row)"
    elif kind:
        who = f"row #{display_index} ({kind} '{name}')"
    else:
        who = f"row #{display_index}"

    status = event.get("status", "skipped")
    if status == "loaded":
        cache_key = event.get("cache_key")
        cache_text = "HIT" if event.get("cache_hit") else "MISS"
        path = event.get("resolved_path") or "(path not resolved)"
        detail = f"loaded <- {path} (cache {cache_text}, key={cache_key!r})"
    elif status == "error":
        detail = f"FAILED to load -- {event.get('skip_reason') or 'unknown error'}"
    else:
        detail = f"skipped ({event.get('skip_reason') or 'unknown reason'})"

    return f"[AnimaFlow] Loader Panel slot {slot}: {who} -- {detail}"


format_loader_slot_line = _safe(_format_loader_slot_line_impl)


# ---------------------------------------------------------------------------
# Duplicate-slot collision line -- loud, one per actual collision, debug-only
# (the collision COUNT still reaches `summary` via the run-summary line).
# ---------------------------------------------------------------------------


def _format_duplicate_slot_line_impl(
    *, slot: int, display_indexes: List[int], winner_display_index: int,
) -> str:
    claimants = ", ".join(f"#{i}" for i in display_indexes)
    return (
        f"[AnimaFlow] Loader Panel slot {slot}: DUPLICATE SLOT -- rows {claimants} "
        f"all claim it; row #{winner_display_index} (last in display order) wins "
        f"per rows_by_slot's documented tie-break, the rest are silently dropped"
    )


format_duplicate_slot_line = _safe(_format_duplicate_slot_line_impl)


# ---------------------------------------------------------------------------
# Run summary -- exactly one line, the only thing `summary` level prints.
# ---------------------------------------------------------------------------


def _format_loader_run_summary_impl(
    *, loaded_count: int, skipped_count: int, empty_count: int, duplicate_count: int,
) -> str:
    dup_text = (
        f", {duplicate_count} duplicate-slot collision(s) (see debug log for detail)"
        if duplicate_count
        else ""
    )
    return (
        f"[AnimaFlow] Loader Panel run: {loaded_count} loaded, {skipped_count} skipped, "
        f"{empty_count} slot(s) empty{dup_text}"
    )


format_loader_run_summary = _safe(_format_loader_run_summary_impl)


__all__ = (
    "detect_duplicate_slots",
    "format_loader_slot_line",
    "format_duplicate_slot_line",
    "format_loader_run_summary",
)
