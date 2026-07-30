"""Generation history for `AnimaPreview` (owner-requested feature, designed
2026-07-29/30 -- see the build report for the full ruling) -- pure, no
comfy/torch import anywhere in this module, per `.claude/CLAUDE.md`'s
`src/anima/` pure/impure rule. Every filesystem/ComfyUI touch this feature
needs (the existence check that turns a stale entry into "expired", reading
a tensor's own width/height, the actual recording call site) lives in
`nodes/anima/_preview_helpers.py` / `nodes/anima/preview.py` instead -- this
module only holds the ring buffer and its own bookkeeping decisions.

## Why NOT ComfyUI's own `/history` endpoint

Investigated first, per the task brief. ComfyUI's server already exposes
`GET /history` (executed prompts + their `outputs`, keyed by prompt id) --
reusing it would mean no parallel bookkeeping to maintain. Rejected for two
concrete reasons, both named in the brief and confirmed true here:

1. **It has no `stage` label.** Its `outputs` shape is `{node_id: {images:
   [...]}}}` -- exactly the ComfyUI-native `"ui": {"images": [...]}}`
   convention `nodes/anima/preview.py`'s own docstring explains this node
   deliberately does NOT use (returning stage entries under `images` drew a
   second, native preview stacked on top of this node's own hover wipe --
   the whole reason the key is `anima_stages` instead). So `AnimaPreview`'s
   own stage entries never populate ComfyUI's `/history` `outputs` at all --
   there would be nothing there to browse for the un-saved (`temp`) case,
   which is half of what the owner asked for ("both saved images and
   un-saved previews").
2. **It is bounded by ComfyUI's own history size setting and depends on
   internals this pack doesn't control** (queue eviction policy, exactly
   which fields `outputs` carries across a ComfyUI version) -- a parallel,
   pack-owned ring is a small, fully-owned amount of bookkeeping against an
   API this pack already depends on elsewhere (`server.PromptServer`), not a
   new dependency.

So: an in-memory, session-scoped, pack-owned ring, recorded directly by
`AnimaPreview.preview()` at the one point it already knows every stage entry
for both the auto-save AND the temp-preview path (`nodes/anima/preview.py`'s
own `ui_images`) -- never derived from ComfyUI's own history after the fact.

## Shape

Metadata only, **never image bytes** -- `stage`, `seed` (a decimal STRING,
same precision-safe convention `preview.py`'s own `anima_seed` `ui` payload
already uses -- a seed can reach 2**64-1, past `Number.MAX_SAFE_INTEGER`),
`filename`/`subfolder`/`type` (ComfyUI's own `/view` triple, same shape
`build_preview_ui_images` already produces), a `timestamp` SUPPLIED by the
caller (never `time.time()` read in here -- this module stays free of any
wall-clock dependency, matching `preview_settings.format_filename`'s own
"pure given an explicit `now`" convention), `width`/`height`, and `settings`
(the generation-settings snapshot the caller already has -- `preview.py`
parses its own `metadata_json` input for this, see that module's own
comment). Bounded at `MAX_HISTORY_ENTRIES` (a ring: the oldest entry is
evicted once the bound is exceeded) -- generous because this is metadata
only, never a picture. Newest first, both in storage order and in
`list_entries()`'s own return -- there is no separate sort step anywhere
downstream, this is the one place that decides the order.

`HistoryStore` is a plain class (a `threading.Lock`-guarded list), not a
free function + module dict, so a test can construct its own instance
instead of fighting the process-wide singleton; `STORE` below is that
singleton, the one every real caller (`nodes/anima/_preview_helpers.py`)
actually uses. The lock exists because recording happens on ComfyUI's
execution thread while a listing request can be served from an
executor-thread pool (`src/anima/api.py`'s `run_in_executor` wrapping) --
both can genuinely race.
"""
from __future__ import annotations

import copy
import threading
from typing import Any, Dict, List, Optional

# Generous on purpose -- an entry is metadata only (never a picture), so
# keeping 200 of them costs nothing worth trading against "can I still find
# the run from an hour ago". A named constant per the task brief, not a
# magic number at the call site.
MAX_HISTORY_ENTRIES = 200

# The only two file locations `nodes/anima/_preview_helpers.py`'s writers
# ever use (`save_images` -> `"output"`, `write_temp_stage_images` ->
# `"temp"`) -- anything else recorded here is defensively coerced to
# `"temp"` (the more conservative of the two: `resolve_history_view`'s own
# existence check looks in ComfyUI's temp root for that case, which is the
# right guess for "recorded but not recognizably an output").
_VALID_FILE_TYPES = ("output", "temp")


class HistoryStore:
    """A single ring buffer -- newest entry first, bounded at `max_entries`.
    Every method is lock-guarded so a concurrent `record` (the execution
    thread) and `list_entries` (an executor-thread route handler) can never
    observe/mutate the same list unsynchronized.
    """

    def __init__(self, max_entries: int = MAX_HISTORY_ENTRIES) -> None:
        self._max_entries = max_entries
        self._entries: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._next_id = 1

    def record(
        self,
        *,
        stage: Any,
        seed: Any,
        filename: Any,
        subfolder: Any,
        file_type: Any,
        timestamp: Any,
        width: Any,
        height: Any,
        settings: Any,
    ) -> Dict[str, Any]:
        """Append one entry -- always at the front (newest first), evicting
        the oldest once `max_entries` is exceeded. Returns the entry actually
        stored (a fresh dict, own copy of `settings` -- see below). Never
        raises on a hostile field (a `None` filename, a non-numeric width):
        every field is coerced to a safe, JSON-serializable shape rather than
        validated/rejected, since a recording failure must never be the
        reason a generation errors (`nodes/anima/preview.py`'s own "best
        effort" call site is what actually enforces "never raises" end to
        end; this method just never manufactures a new way to fail).
        """
        file_type = file_type if file_type in _VALID_FILE_TYPES else "temp"
        try:
            width_int = int(width)
        except (TypeError, ValueError):
            width_int = 0
        try:
            height_int = int(height)
        except (TypeError, ValueError):
            height_int = 0
        entry = {
            "stage": str(stage) if stage is not None else "",
            # Decimal STRING, never a JSON number -- same precision-safety
            # reasoning as `preview.py`'s own `anima_seed` ui payload (a seed
            # can exceed `Number.MAX_SAFE_INTEGER`); this module never
            # converts it back to an int, that stays exactly ONE conversion
            # point (`preview_settings.resolve_seed_int`), unchanged by this
            # feature.
            "seed": str(seed) if seed is not None else "0",
            "filename": str(filename) if filename is not None else "",
            "subfolder": str(subfolder) if subfolder is not None else "",
            "type": file_type,
            "timestamp": timestamp,
            "width": width_int,
            "height": height_int,
            # A deep copy -- `settings` is typically a dict the caller
            # parsed once and could still mutate afterwards (or reuse across
            # every stage entry from the same run, which `preview.py` does);
            # this store must own its own data, never alias the caller's.
            "settings": copy.deepcopy(settings) if isinstance(settings, (dict, list)) else settings,
        }
        with self._lock:
            entry["id"] = self._next_id
            self._next_id += 1
            self._entries.insert(0, entry)
            if len(self._entries) > self._max_entries:
                del self._entries[self._max_entries:]
            return dict(entry)

    def list_entries(self) -> List[Dict[str, Any]]:
        """Every entry, newest first -- a fresh list of fresh dict copies, so
        a caller (the listing route, an existence-check annotation step)
        can never mutate this store's own internal state by editing what it
        got back."""
        with self._lock:
            return [dict(entry) for entry in self._entries]

    def clear(self) -> None:
        """Test-only reset -- no real caller empties the history on
        purpose; every `tests/test_anima_*.py` that exercises the singleton
        `STORE` calls this first so one test's entries can never leak into
        the next."""
        with self._lock:
            self._entries.clear()
            self._next_id = 1


# The process-wide singleton every real caller uses. Session-scoped by
# construction: it is plain process memory, so it survives a browser
# refresh (settled design decision 1) and is gone the moment the ComfyUI
# process exits -- nothing here ever touches disk.
STORE = HistoryStore()


def reset_history_for_tests() -> None:
    """Thin, discoverable alias for `STORE.clear()` -- named for what test
    code actually wants to say at its own call site."""
    STORE.clear()


__all__ = ("MAX_HISTORY_ENTRIES", "HistoryStore", "STORE", "reset_history_for_tests")
