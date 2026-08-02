"""State parse/validate/coerce for the Control Panel + Loader Panel (contract:
docs/control-panel-design.md §4). Pure logic only -- deliberately NO torch or
comfy.* import anywhere in this file (even lazily), so it -- and
`tests/test_controls_state.py` -- stay importable and runnable without a live
ComfyUI process. `control_panel.py` does its own lazy `import torch` for the
`latent` kind; `_loaders_helpers.py` does its own lazy `import folder_paths`/
`import nodes` for the loader kinds.

State shape (§4):
    {
      "version": 1,
      "rows": [
        {"slot": 1, "kind": "sampler", "name": "sampler name", "value": "euler_ancestral", "opts": {}},
        ...
      ]
    }

Every value here is treated as **hostile** -- it can come from a hand-edited
API payload, not just the panel's own JS -- so every read is guarded and
clamped rather than trusted.
"""
from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# State parsing
# ---------------------------------------------------------------------------


def parse_state(raw: Any) -> Dict[str, Any]:
    """`panel_state` (the raw STRING widget value) -> a normalized
    `{"version": ..., "rows": [...]}` dict. Never raises: any malformed input
    (bad JSON, a JSON scalar/array instead of an object, a non-list `rows`)
    degrades to an empty row list rather than taking the node down.
    """
    try:
        # RecursionError matters too: deeply nested hand-edited JSON would
        # otherwise take the whole run down instead of degrading gracefully.
        state = json.loads(raw) if isinstance(raw, str) else {}
    except (ValueError, TypeError, RecursionError):
        state = {}
    if not isinstance(state, dict):
        state = {}

    rows = state.get("rows")
    if not isinstance(rows, list):
        rows = []

    version = state.get("version", 1)
    return {"version": version, "rows": rows}


def _looks_like_a_panel_row(row: Any) -> bool:
    """Does `row` look like a Control/Loader Panel row at all? The one field
    every real row carries regardless of `kind` (`rows.mjs`'s own state-shape
    doc: `{ id, slot, kind, name, value, opts, ... }`, assigned once at row
    creation and never renumbered) is `slot`, int-coercible -- unlike
    `Anima LoRA Loader`'s own rows (`_lora_helpers.py`'s shape), which never
    carry one at all. A low bar deliberately: `parse_state`/`rows_by_slot`
    are already tolerant of a garbage row past this point; this only needs
    to catch "this clearly isn't shaped like our rows", not validate every
    field.
    """
    if not isinstance(row, dict):
        return False
    try:
        int(row.get("slot"))
    except (TypeError, ValueError):
        return False
    return True


def detect_state_mismatch(raw: Any) -> Optional[str]:
    """Does `panel_state` (the raw STRING widget value, BEFORE `parse_state`
    runs) look like a hijacked value rather than this node's own (possibly
    empty) state? Shared by both `control_panel.py` and `loader_panel.py` --
    they read the identical `panel_state` shape via this same `parse_state`.

    Root cause this exists to catch (2026-07-29 live bug, first caught on
    `AnimaPreview`'s differently-shaped `preview_state` -- see
    `src/anima/settings.detect_schema_mismatch`'s docstring for the full
    story): a same-typed STRING output from an unrelated node getting
    broadcast by another extension (observed: cg-use-everywhere) into a
    `STRING` widget-input it was never meant to feed. `parse_state` already
    tolerates this (any unparseable/wrong-shaped blob degrades to an empty
    row list, by its own contract) -- that tolerance is UNCHANGED here; this
    function only adds the OBSERVATION that degradation happened for a
    reason worth surfacing. Never raises, never affects `parse_state`'s own
    result.

    Unlike `generation_settings`/`preview_state` (which carry an explicit
    `"schema"` field to check verbatim -- see `settings.py`), `panel_state`
    has never had one (`rows.mjs`'s own state-shape doc: `{version, rows}`,
    no schema key), so this uses a STRUCTURAL fingerprint of the shapes it
    could plausibly be confused with instead:

      - `None` for a genuinely absent/fresh value (`None`, `""`, the literal
        empty-object default `"{}"`, or an already-parsed empty dict) --
        every brand-new node's widget looks like this. SILENT.
      - `None` when it parses to a dict that has neither `"cacheMode"` nor
        `"sep"` (both `Anima LoRA Loader`-only top-level keys -- see
        `_lora_helpers.py`'s own state shape) and whose `"rows"` field,
        if present at all, is a list that either is empty or has at least
        one entry that looks like a real panel row (`_looks_like_a_panel_row`
        above). This is deliberately the SAME bar `rows_by_slot` already
        applies (a garbage row silently drops out of the slot map there
        too) -- if not one row would survive that, that IS the silent
        degradation this function exists to surface.
      - a reason string for everything else: invalid JSON, a non-object, a
        dict carrying `"cacheMode"`/`"sep"` (an `Anima LoRA Loader` state
        leaking in -- its rows shape can otherwise look enough like ours to
        pass; this is what actually catches that direction), no `"rows"`
        field at all (the tell for a `generation_settings`/`preview_state`
        blob leaking in -- neither has one either), a non-list `"rows"`, or
        a non-empty `"rows"` where NOT ONE entry looks like a panel row.
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped in ("", "{}"):
            return None
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError, RecursionError):
            return "the value is not valid JSON"
    else:
        parsed = raw
        if parsed == {}:
            return None
    if not isinstance(parsed, dict):
        return f"the value is not a JSON object (got {type(parsed).__name__})"

    if "cacheMode" in parsed or "sep" in parsed:
        return "the value looks like an Anima LoRA Loader's lora_state, not a Control/Loader Panel's own state"

    rows = parsed.get("rows")
    if rows is None:
        return "the value has no 'rows' field at all"
    if not isinstance(rows, list):
        return "its 'rows' field is not a list"
    if not rows:
        return None  # an emptied-out panel is still our own shape.
    if any(_looks_like_a_panel_row(row) for row in rows):
        return None
    return "its 'rows' entries don't look like Control/Loader Panel rows (no usable 'slot')"


def rows_by_slot(rows: List[Any], max_rows: int) -> Dict[int, Dict[str, Any]]:
    """The `rows` array (display order) -> a `{slot: row}` map, keyed by each
    row's OWN `slot` field, not its position in the array -- outputs are
    indexed by slot, never by display order (§4). Rows that aren't a dict,
    whose `slot` isn't int-coercible, or whose slot falls outside
    `[1, max_rows]` are dropped silently (a slot beyond the node's fixed
    `RETURN_TYPES` length has nowhere to go; a garbage `slot` from a
    hand-edited payload is unaddressable).

    If two rows claim the same slot (only possible via a hand-edited
    payload -- the real frontend assigns each row a fresh slot), the LAST one
    in display order wins. This is an arbitrary but deterministic tie-break;
    it is not expected to matter in practice.
    """
    slots: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        slot = row.get("slot")
        try:
            slot_i = int(slot)
        except (TypeError, ValueError):
            continue
        if slot_i < 1 or slot_i > max_rows:
            continue
        slots[slot_i] = row
    return slots


# ---------------------------------------------------------------------------
# Numeric coercion -- mirrors Pixaroma's `PixaromaSliders._value_of` clamp
# shape (nodes/node_sliders.py): guard non-finite, clamp to a wide sane
# range, THEN cast to the target kind.
# ---------------------------------------------------------------------------

# Same bound Pixaroma's `_value_of` uses: wide enough for any real cfg/steps
# value, tight enough that a hand-edited `1e308` never reaches a downstream
# node.
_NUMERIC_CLAMP = 1e12

SEED_MAX = 2**64 - 1  # exceeds JS's MAX_SAFE_INTEGER -- seeds travel as strings.


def _finite_float(value: Any, default: float = 0.0) -> float:
    """Best-effort `float(value)`, guarded against every hostile shape a
    hand-edited API payload could hold: non-numeric strings, `None`,
    arbitrary-precision ints so large `float()` overflows, and both spellings
    of non-finite (`float("inf")`/`float("nan")` and the JSON literals
    `Infinity`/`NaN`, which Python's `json` module accepts by default and
    hands back as actual `inf`/`nan` floats).
    """
    try:
        v = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    if not math.isfinite(v):
        return default
    return max(-_NUMERIC_CLAMP, min(_NUMERIC_CLAMP, v))


def coerce_int(value: Any) -> int:
    """`int` row value -> `int(round(...))`, non-finite-guarded and clamped."""
    return int(round(_finite_float(value, 0.0)))


def coerce_float(value: Any) -> float:
    """`float` row value -> `float`, non-finite-guarded and clamped."""
    return _finite_float(value, 0.0)


def coerce_bool(value: Any) -> bool:
    """`bool` row value -> a REAL Python `bool`, tolerant of every hostile
    shape a hand-edited payload (or an older/foreign save) could hold --
    mirrors `rows.mjs`'s `coerceBoolTolerant` (JS twin, same tolerance
    contract) so the frontend's own normalization and this backend coercion
    never disagree about what a given stored value means.

    A real `bool` passes through unchanged. A number is truthiness (`0`/`0.0`
    -> `False`, anything else finite -> `True`; a non-finite float -- NaN or
    an inf, both valid Python `json` output -- defaults `False` rather than
    raising). A string is matched case-insensitively against a small set of
    common truthy/falsy spellings (`"true"`/`"1"`/`"yes"`/`"on"` vs.
    `"false"`/`"0"`/`"no"`/`"off"`/empty); anything else -- `None`, a dict, a
    list, an unrecognized string -- defaults `False` rather than guessing.
    Never raises.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return False
        return value != 0
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("true", "1", "yes", "on"):
            return True
        return False  # "false"/"0"/"no"/"off"/""/anything else unrecognized
    return False  # None, dict, list, or any other hostile shape


def coerce_seed(value: Any) -> int:
    """Seed row value -> a clamped `int` in `[0, 2**64-1]`.

    The value ARRIVES AS A STRING in state (2**64-1 exceeds JS's
    `MAX_SAFE_INTEGER`, so a JS Number would silently round it at the top of
    the range -- see docs/control-panel-design.md §4). Guards, in order:
      - `bool` is rejected up front (`isinstance(True, int)` is `True` in
        Python, and a stray JSON `true`/`false` is not a seed).
      - A non-finite float (`Infinity`/`NaN`, both valid Python `json` output
        despite not being valid JSON) is guarded via `math.isfinite` before
        `int()` ever sees it -- `int(float("inf"))` raises `OverflowError`
        that we still catch below as a second line of defense.
      - A non-numeric string (including the literal words `"Infinity"` /
        `"NaN"`) raises `ValueError` from `int()`.
      - A 400-digit integer string parses fine (Python ints are
        arbitrary-precision) and is simply clamped down to `SEED_MAX` below,
        rather than treated as an error.
    """
    if isinstance(value, bool):
        return 0
    try:
        if isinstance(value, float):
            if not math.isfinite(value):
                return 0
            n = int(value)
        else:
            n = int(str(value).strip())
    except (TypeError, ValueError, OverflowError):
        return 0
    if n < 0:
        return 0
    if n > SEED_MAX:
        return SEED_MAX
    return n


# ---------------------------------------------------------------------------
# Latent dims -- opts carries {mode, ratio, tier, w, h, batch} but Python only
# needs w/h/batch (§ "Per-kind Python semantics"): ratio/tier are Predefined-
# mode UI bookkeeping for picking w/h in the frontend, and w/h are always the
# authoritative numbers regardless of which mode produced them. A Custom-mode
# pair that matches no ratio at all is legal input -- there's nothing here
# that depends on `ratio`/`tier` being present or consistent.
# ---------------------------------------------------------------------------

DEFAULT_LATENT_W = 512
DEFAULT_LATENT_H = 512
DEFAULT_LATENT_BATCH = 1

# Sane bounds so a hand-edited payload (`"w": 1e9`) can't request an
# allocation that takes the process down. Not from the spec's table --
# the spec's dimensions are all comfortably inside this range.
_LATENT_MIN_DIM = 16
_LATENT_MAX_DIM = 8192
_LATENT_MIN_BATCH = 1
_LATENT_MAX_BATCH = 64


def latent_wh_batch(opts: Any) -> Tuple[int, int, int]:
    """A latent row's `opts` -> `(w, h, batch)`, clamped to sane bounds.
    Missing/garbage fields fall back to ComfyUI's own `EmptyLatentImage`
    defaults (512x512, batch 1).
    """
    if not isinstance(opts, dict):
        opts = {}
    w = _finite_float(opts.get("w"), DEFAULT_LATENT_W)
    h = _finite_float(opts.get("h"), DEFAULT_LATENT_H)
    batch = _finite_float(opts.get("batch"), DEFAULT_LATENT_BATCH)

    w_i = int(max(_LATENT_MIN_DIM, min(_LATENT_MAX_DIM, round(w))))
    h_i = int(max(_LATENT_MIN_DIM, min(_LATENT_MAX_DIM, round(h))))
    batch_i = int(max(_LATENT_MIN_BATCH, min(_LATENT_MAX_BATCH, round(batch))))
    return w_i, h_i, batch_i


# ---------------------------------------------------------------------------
# Per-row value resolution -- the kinds that need no torch/comfy import.
# `latent` (needs a lazy `torch.zeros`) lives in control_panel.py; `unet`/
# `vae`/`clip` (need lazy folder_paths/nodes) live in _loaders_helpers.py.
# ---------------------------------------------------------------------------


def value_for_row(row: Optional[Dict[str, Any]]) -> Any:
    """A control-panel row (any kind except `latent`) -> the Python value its
    output slot should emit. `sampler`/`scheduler` pass their string through
    as-is; `seed`/`int`/`float`/`bool` are coerced per their own function
    above. An unresolved `auto` row -- and any row of an unrecognized/garbage
    kind, which can only arrive via a hand-edited payload -- emits `0`, same
    as an empty slot (see `docs/control-panel-design.md` §4/§6: "Auto ...
    emits 0").
    """
    if not isinstance(row, dict):
        return 0
    kind = row.get("kind")
    if kind in ("sampler", "scheduler"):
        value = row.get("value")
        if isinstance(value, str):
            return value
        return "" if value is None else str(value)
    if kind == "seed":
        return coerce_seed(row.get("value"))
    if kind == "int":
        return coerce_int(row.get("value"))
    if kind == "float":
        return coerce_float(row.get("value"))
    if kind == "bool":
        return coerce_bool(row.get("value"))
    return 0
