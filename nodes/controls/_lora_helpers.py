"""Pure(ish) state normalization + trigger assembly for `Anima LoRA Loader`
(docs/lora-loader-design.md §3 "state shape", §1b "provenance rules"). The
apply step (`apply_loras`, and `LoraCache.load`) is the only code here that
touches ComfyUI -- `folder_paths`/`comfy.sd`/`comfy.utils` are imported
LAZILY, inside functions, so the rest of this module (state parsing, trigger
assembly, the memory-mode bookkeeping) stays importable and testable with no
ComfyUI installed (`tests/test_lora_state.py`/`test_lora_apply.py` stub them
via `sys.modules`, the same convention `nodes/controls/_loaders_helpers.py`
already uses).

State shape (§3), matching `panel_state`/`generation_settings`'s own
"declared STRING widget, not a `hidden` + `graphToPrompt` hook" contract:

    {
      "cacheMode": "last" | "all" | "none",
      "sep": ", ",
      "rows": [
        {"id": "...", "name": "my_lora.safetensors", "on": true,
         "sm": 0.8, "sc": 0.8, "triggers": ["word", ...]},
        ...
      ]
    }

Every value here is treated as HOSTILE -- a hand-edited API payload, not
just the node's own JS -- so every read is guarded and coerced rather than
trusted. **Rows are kept as their ORIGINAL dicts, never rebuilt field-by-
field**: this is what makes an unknown key on a row (something a future UI
version adds that this Python doesn't know about yet) survive a parse/
reserialize round trip untouched -- the same "coerce on read, never rewrite
the row" contract `nodes/controls/_rows_helpers.py`'s `parse_state` uses.
The `row_*` accessor functions below are how every actual READ happens;
nothing here ever does `{**row, "sm": ...}`-style reconstruction.

The apply logic (row-order application, triggers from applied rows only,
and the three-mode memory bookkeeping including the `last`-mode fix) is
ported LOGIC, not code, from `../ComfyUI-Pixaroma/nodes/node_lora_loader.py`'s
`apply()` (MIT, THIRD_PARTY_NOTICES.md -- extend it once this lands): the
state key names/shape here are ours (§3's deliberate fork from upstream's
`hidden` + `graphToPrompt` handshake), but the underlying rules -- especially
§1b's "evict the cross-run retained entry only once something has actually
replaced it, never on the run's first applied row" -- are the exact
behaviour upstream's own pre-release review caught and fixed.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Set, Tuple

_VALID_CACHE_MODES = ("last", "all", "none")
_DEFAULT_SEP = ", "

# Same bound `nodes/controls/_rows_helpers.py`'s numeric coercion uses in
# spirit (wide enough for any real strength value, tight enough that a
# hand-edited `1e308` never reaches `comfy.sd.load_lora_for_models`) --
# matches `../ComfyUI-Pixaroma/nodes/_lora_helpers.py`'s own
# `_STATE_MAX_STRENGTH` bound for the same field.
_STRENGTH_CLAMP = 100.0


# ---------------------------------------------------------------------------
# State parsing -- never raises, never rebuilds a row.
# ---------------------------------------------------------------------------


def parse_state(raw: Any) -> Dict[str, Any]:
    """`lora_state` (the raw STRING widget value) -> a normalized
    `{"cacheMode": str, "sep": str, "rows": [dict, ...]}`. Never raises: bad
    JSON, a JSON scalar/array instead of an object, or a non-list `rows` all
    degrade to an empty stack rather than taking the run down.

    Dropped from `rows`: a non-dict entry, or one with no usable string
    `name` (unresolvable to any file, so keeping it around is pointless).
    Every OTHER row survives EXACTLY as given -- see this module's own
    docstring for why that matters (unknown keys surviving a round trip).
    """
    try:
        # RecursionError matters too: deeply nested hand-edited JSON must
        # degrade gracefully rather than take the whole run down.
        state = json.loads(raw) if isinstance(raw, str) else {}
    except (ValueError, TypeError, RecursionError):
        state = {}
    if not isinstance(state, dict):
        state = {}

    cache_mode = state.get("cacheMode")
    if cache_mode not in _VALID_CACHE_MODES:
        cache_mode = "last"

    sep = state.get("sep")
    if not isinstance(sep, str):
        sep = _DEFAULT_SEP

    raw_rows = state.get("rows")
    rows: List[Dict[str, Any]] = []
    if isinstance(raw_rows, list):
        for row in raw_rows:
            if not isinstance(row, dict):
                continue
            name = row.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            rows.append(row)  # kept AS-IS -- unknown keys survive.

    return {"cacheMode": cache_mode, "sep": sep, "rows": rows}


def _clamp_strength(value: Any, default: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    if v != v or v in (float("inf"), float("-inf")):  # NaN / +-inf
        return default
    return max(-_STRENGTH_CLAMP, min(_STRENGTH_CLAMP, v))


def row_name(row: Dict[str, Any]) -> str:
    """A row's file name -- guaranteed non-empty by `parse_state` for every
    row that survives into `rows`, but re-guarded here since a caller could
    hand this function a raw, unfiltered row too."""
    name = row.get("name")
    return name if isinstance(name, str) else ""


def row_is_on(row: Dict[str, Any]) -> bool:
    """A row's switch state -- missing key defaults to ON (`True`), matching
    `../ComfyUI-Pixaroma/nodes/_lora_helpers.py`'s own `parse_state`
    default for the same field."""
    return bool(row.get("on", True))


def row_strengths(row: Dict[str, Any]) -> Tuple[float, float]:
    """A row's `(model_strength, clip_strength)`, clamped to a sane range.
    `sm` defaults to `1.0` when absent; `sc` defaults to WHATEVER `sm`
    resolved to when absent -- a single strength value drives both unless
    the row's own UI splits them (§7b's "Show two strengths per row")."""
    sm = _clamp_strength(row.get("sm", 1.0), 1.0)
    sc = _clamp_strength(row.get("sc", sm), sm)
    return sm, sc


def row_triggers(row: Dict[str, Any]) -> List[str]:
    """A row's picked trigger words -- whatever the ⓘ panel wrote, verbatim
    (already the user's OWN selection, not re-derived from a file here);
    non-list/garbage entries degrade to `[]`."""
    value = row.get("triggers")
    if not isinstance(value, list):
        return []
    out = []
    for word in value:
        text = str(word).strip() if word is not None else ""
        if text:
            out.append(text)
    return out


# ---------------------------------------------------------------------------
# Trigger assembly -- §1b: only rows that ACTUALLY APPLIED contribute.
# ---------------------------------------------------------------------------


def collect_triggers(rows: List[Dict[str, Any]], sep: Any) -> str:
    """Joined, case-insensitively de-duped trigger words from `rows` --
    callers pass ONLY the rows that actually applied (see `apply_loras`
    below); this function itself doesn't re-check `on`. First occurrence
    wins on a case-insensitive duplicate, row order preserved."""
    out: List[str] = []
    seen: Set[str] = set()
    for row in rows:
        for word in row_triggers(row):
            key = word.lower()
            if key not in seen:
                seen.add(key)
                out.append(word)
    sep_str = sep if isinstance(sep, str) else _DEFAULT_SEP
    return sep_str.join(out)


# ---------------------------------------------------------------------------
# Memory cache -- the three modes (§1b), incl. the `last`-mode fix.
# ---------------------------------------------------------------------------


class LoraCache:
    """Per-node-instance cache implementing the three memory modes (§1b).
    Lives on the `AnimaLoraLoader` instance (`self._cache`), NOT at module
    scope, so it survives between runs of the SAME node exactly the way
    ComfyUI's own node-instance lifetime already provides -- mirroring
    `../ComfyUI-Pixaroma/nodes/node_lora_loader.py`'s `self._cache`/
    `self._last_path`.

    Modes (read fresh from the state's own `cacheMode` at the start of every
    run via `begin_run`, so switching it in the settings UI takes effect on
    the very next run):

      - `"all"`  -- keep every entry currently in the stack between runs;
        free anything for a row that's no longer present.
      - `"none"` -- keep NOTHING between runs; also release the PREVIOUS
        entry loaded THIS run the moment the NEXT one applies, so a 10-row
        stack peaks at ~2 files in memory at once, not ten.
      - `"last"` -- behaves like `"none"` DURING the run (same ~2-file
        peak), but ONE entry survives to the NEXT run: whatever loaded most
        recently this run, or -- if nothing loaded this run at all -- the
        entry retained from the PREVIOUS run, as long as it's still part of
        the current stack.

    THE FIX this class exists to get right (§1b, upstream's own pre-release
    regression): `_last_from_previous_run` (the cross-run retained entry)
    is tracked SEPARATELY from `_last_loaded_this_run` (the most recent load
    THIS run), and `load()`'s per-load eviction ONLY ever pops
    `_last_loaded_this_run` -- never `_last_from_previous_run` directly.
    Evicting the previous run's retained entry the moment the CURRENT run's
    first row applied made `"last"` behave exactly like `"none"` for any
    2+ row stack: the warm file was dropped moments before it would have
    been reused. `end_run()` is the only place the previous run's retained
    entry is ever actually superseded.
    """

    def __init__(self) -> None:
        self._entries: Dict[str, Tuple[Any, Any]] = {}
        self._last_from_previous_run: Optional[str] = None
        self._mode: str = "last"
        self._last_loaded_this_run: Optional[str] = None
        self._used_this_run: Set[str] = set()

    def begin_run(self, mode: str) -> None:
        """Reset the THIS-run bookkeeping. Must be called once at the start
        of every `apply_loras` call, before any row is processed."""
        self._mode = mode if mode in _VALID_CACHE_MODES else "last"
        self._last_loaded_this_run = None
        self._used_this_run = set()

    def load(self, path: str) -> Tuple[Any, Any]:
        """The cached `(lora, meta)` for `path`, loading it (via
        `comfy.utils.load_torch_file`) on a cache miss. Also runs the
        "release the previous THIS-run load" step for `"last"`/`"none"`
        modes -- see the class docstring; this happens on EVERY call
        (hit or miss), not just a miss, matching upstream's own placement
        of the equivalent check.
        """
        import comfy.utils  # ComfyUI-only; lazy -- see module docstring.

        cached = self._entries.get(path)
        if cached is None:
            try:
                lora, meta = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
            except TypeError:
                # Older ComfyUI has no `return_metadata` parameter.
                lora, meta = comfy.utils.load_torch_file(path, safe_load=True), None
            self._entries[path] = (lora, meta)
            cached = self._entries[path]

        self._used_this_run.add(path)

        if self._mode != "all":
            prev = self._last_loaded_this_run
            if prev is not None and prev != path:
                self._entries.pop(prev, None)
        self._last_loaded_this_run = path
        return cached

    def note_used(self, path: str) -> None:
        """A strength-0 row: no load happens (nothing to gain from reading
        the file), but the path still counts as "part of this run's stack"
        for `end_run`'s bookkeeping below -- a deliberately zeroed row still
        keeps its cached entry (if any) alive under `"all"` mode."""
        self._used_this_run.add(path)

    def end_run(self) -> None:
        """Prune the cache per the run's memory mode -- called once, at the
        end of `apply_loras`, after every row has been processed."""
        if self._mode == "none":
            self._entries.clear()
            self._last_from_previous_run = None
            return
        if self._mode == "all":
            for path in list(self._entries):
                if path not in self._used_this_run:
                    del self._entries[path]
            return

        # "last": THE FIX (§1b, class docstring) -- only evict the
        # cross-run retained entry when there's an actual REPLACEMENT for
        # it (something loaded this run), or when it's no longer part of
        # the stack at all. If nothing loaded this run AND the previously
        # retained entry is still in use, keep it exactly as it was.
        keep = self._last_loaded_this_run
        if keep is None and self._last_from_previous_run in self._used_this_run:
            keep = self._last_from_previous_run
        for path in list(self._entries):
            if path != keep:
                del self._entries[path]
        self._last_from_previous_run = keep

    def _entry_count_for_tests(self) -> int:
        """Test-only introspection: how many entries the cache is currently
        holding -- used to assert the "peaks at ~2 files, not the whole
        stack" claim without reaching into `_entries` directly."""
        return len(self._entries)


# ---------------------------------------------------------------------------
# Apply -- the one function that walks the row list against real ComfyUI
# objects. `folder_paths`/`comfy.sd` are imported LAZILY, inside it/its
# helper, same convention as `nodes/controls/_loaders_helpers.py`.
# ---------------------------------------------------------------------------


def apply_loras(model: Any, clip: Any, state: Dict[str, Any], cache: LoraCache) -> Tuple[Any, Any, str]:
    """Apply every switched-ON row in `state["rows"]` to `model`/`clip`, in
    row order, using `cache` for the memory-mode bookkeeping. Returns
    `(model, clip, triggers)`.

    Provenance rule (§1b, worth restating here because it's the whole
    reason this function tracks "resolved" separately from merely "on"): a
    row's trigger words reach the output ONLY if the row's LoRA was
    actually applied to the model. A switched-on row whose file is missing,
    unreadable, or fails to load contributes NOTHING, even though the user
    turned it on. A row deliberately parked at strength 0 (BOTH `sm` and
    `sc` exactly zero) DOES still count -- the file resolves (so it's
    genuinely part of the stack) and the user turned it on on purpose; it
    just has zero numeric effect on the model itself.
    """
    import folder_paths  # ComfyUI-only; lazy -- see module docstring.

    cache.begin_run(state.get("cacheMode", "last"))

    resolved_rows: List[Dict[str, Any]] = []
    applied = 0

    for row in state["rows"]:
        if not row_is_on(row):
            continue

        name = row_name(row)
        try:
            path = folder_paths.get_full_path("loras", name)
        except Exception:
            path = None
        if not path or not os.path.isfile(path):
            print(f"[Anima LoRA Loader] skipped (not found): {name}")
            continue

        sm, sc = row_strengths(row)
        if clip is None:
            sc = 0.0  # nothing to apply a clip strength TO.

        if sm == 0 and sc == 0:
            # Deliberate no-op (file present, strengths zero): still counts
            # (§1b) -- no load needed, so no `cache.load` call either.
            resolved_rows.append(row)
            cache.note_used(path)
            continue

        try:
            lora, meta = cache.load(path)
            model, clip = _apply_lora_to_models(model, clip, lora, sm, sc, meta)
        except Exception as exc:  # noqa: BLE001 - one bad file must not kill the run
            print(f"[Anima LoRA Loader] failed to apply {name}: {exc}")
            continue

        applied += 1
        resolved_rows.append(row)

    triggers = collect_triggers(resolved_rows, state.get("sep", _DEFAULT_SEP))
    cache.end_run()
    print(f"[Anima LoRA Loader] applied {applied} LoRA(s).")
    return model, clip, triggers


def _apply_lora_to_models(model: Any, clip: Any, lora: Any, sm: float, sc: float, meta: Any) -> Tuple[Any, Any]:
    import comfy.sd  # ComfyUI-only; lazy -- see module docstring.

    try:
        return comfy.sd.load_lora_for_models(model, clip, lora, sm, sc, lora_metadata=meta)
    except TypeError:
        # Older ComfyUI: no `lora_metadata` parameter -- retry without it so
        # the LoRA still applies instead of silently doing nothing.
        return comfy.sd.load_lora_for_models(model, clip, lora, sm, sc)


__all__ = (
    "parse_state",
    "row_name",
    "row_is_on",
    "row_strengths",
    "row_triggers",
    "collect_triggers",
    "LoraCache",
    "apply_loras",
)
