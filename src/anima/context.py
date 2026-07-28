"""Pure shape/decision logic for the `ANIMA_CONTEXT` object `AnimaContextBridge`
builds and `AnimaGenerator` consumes (design doc §1's 2026-07-?? reversal —
see `docs/generator-design.md` for the dated note — the pack now bundles
MODEL/CLIP/VAE/CONDITIONING/LATENT plus the five sampler scalars into ONE
socket instead of nine separate ones on the Generator itself).

No comfy/torch import anywhere in this file: the context is a plain dict of
already-received Python values (real objects, or `None`, or plain numbers/
strings) — BUILDING that shape and READING a field back out of it is
arithmetic over already-received values, never a new load/lookup. Compare
`resources.py`'s own docstring, which made the identical argument for the
socket-flag design this supersedes.
"""
from __future__ import annotations

from typing import Any, Dict, Tuple

from .resources import SAMPLER_FIELDS

# ---------------------------------------------------------------------------
# The MISSING sentinel — "this socket was never wired at all", distinct from
# "wired, but the thing on the other end of the wire produced None on
# purpose". A node method's kwarg default of plain `None` cannot tell these
# apart: ComfyUI simply omits an unconnected `optional` socket's kwarg
# entirely when calling the node function, so the Python DEFAULT fires
# either way — if that default is `None`, "never wired" and "wired to None"
# become the exact same observation. `MISSING` is a value nothing upstream
# could ever legitimately hand back (no real MODEL/CLIP/VAE/CONDITIONING/
# LATENT/int/str IS this object), so seeing it in `AnimaContextBridge.
# build()`'s own kwargs is proof the Python default fired, not a real wire.
# ---------------------------------------------------------------------------


class _Missing:
    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid only
        return "<AnimaFlow.MISSING>"


MISSING = _Missing()

# The context's whole field list — MODEL/CLIP/VAE/CONDITIONING/LATENT plus
# the five sampler scalars this task moved off the Generator's own sockets.
# Order is iteration-order only (tests, metadata) — it has no append-only
# obligation the way a node's `INPUT_TYPES` does, since this is a plain dict
# shape, not litegraph widget positions.
CONTEXT_FIELDS: Tuple[str, ...] = (
    "model", "clip", "vae", "positive", "negative", "latent",
    "seed", "steps", "cfg", "sampler_name", "scheduler",
)

# Human-facing socket names for CONTEXT_FIELDS — what a user actually sees
# on `AnimaContextBridge`, reused in the readable errors `AnimaGenerator`
# raises for a field it needs that was never supplied.
CONTEXT_FIELD_SOCKET_NAMES: Dict[str, str] = {
    "model": "MODEL", "clip": "CLIP", "vae": "VAE",
    "positive": "CONDITIONING (positive)", "negative": "CONDITIONING (negative)",
    "latent": "LATENT",
    "seed": "INT (seed)", "steps": "INT (steps)", "cfg": "FLOAT (cfg)",
    "sampler_name": "COMBO (sampler_name)", "scheduler": "COMBO (scheduler)",
}


class ContextFieldMissing(ValueError):
    """A field `AnimaGenerator` needs was never supplied by the wired
    `ANIMA_CONTEXT` — i.e. `AnimaContextBridge`'s matching socket was left
    unwired, not merely wired-to-`None`. Always carries a readable message
    naming the field and pointing at the bridge node — same "the error text
    matters" contract as `resources.ResourceError` (a readable message beats
    an `AttributeError` mid-sample).
    """


def build_context(raw: Dict[str, Any]) -> Dict[str, Any]:
    """`raw` maps each of `CONTEXT_FIELDS` to either `MISSING` (that socket
    was never wired on `AnimaContextBridge`) or the value ComfyUI actually
    handed the bridge node for it (which MAY legitimately be `None`, if
    whatever's wired there produced `None` on purpose) -> the `ANIMA_CONTEXT`
    object itself:

        {"values": {field: value_or_None, ...},
         "supplied": {field: True|False, ...}}

    `supplied[field]` is the one thing a plain `None` can never tell you on
    its own — it's `True` for a wire that legitimately carried `None`
    through, `False` only when the socket was never connected at all. Every
    caller that needs to tell "present but null" apart from "absent" (this
    is exactly `AnimaGenerator`'s field-disabling decision) reads
    `supplied`, never infers it from `values` — see `context_supplied`/
    `require_context_value` below, the only two readers that should ever
    need to.
    """
    values: Dict[str, Any] = {}
    supplied: Dict[str, bool] = {}
    for field in CONTEXT_FIELDS:
        value = raw.get(field, MISSING)
        is_supplied = value is not MISSING
        supplied[field] = is_supplied
        values[field] = value if is_supplied else None
    return {"values": values, "supplied": supplied}


def context_supplied(context: Any, field: str) -> bool:
    """Was `field` actually wired into the `ANIMA_CONTEXT` that produced this
    object? `False` — fails CLOSED, never raises — for anything that isn't a
    real context dict at all (a hand-edited payload wiring something else
    into the socket, or simply `None` because nothing is wired to `context`
    itself)."""
    if not isinstance(context, dict):
        return False
    supplied = context.get("supplied")
    return bool(isinstance(supplied, dict) and supplied.get(field))


def context_value(context: Any, field: str, default: Any = None) -> Any:
    """`field`'s value out of the context, or `default` if the context is
    garbage or doesn't carry that field at all. Deliberately does NOT
    special-case "field was never supplied" here — `build_context` already
    normalizes an unsupplied field's value to `None`, so this function alone
    can never distinguish the two; only `context_supplied` can, and callers
    that need to (`require_context_value`, below) always check that first.
    """
    if not isinstance(context, dict):
        return default
    values = context.get("values")
    if not isinstance(values, dict) or field not in values:
        return default
    return values[field]


def require_context_value(context: Any, field: str) -> Any:
    """`context_value`, but raises a readable `ContextFieldMissing` when
    `field` was never supplied at all (`context_supplied` is `False`) — the
    Generator's "readable error, not an AttributeError mid-sample" contract,
    for the fields it cannot run without (`model`/`clip`/`vae`/`positive`/
    `negative` — see `pipeline.run_generator`). Never used for the context's
    optional fields (`latent` and the five sampler scalars), which the
    Generator falls back to `generation_settings` for instead.
    """
    if not context_supplied(context, field):
        socket_name = CONTEXT_FIELD_SOCKET_NAMES.get(field, field.upper())
        raise ContextFieldMissing(
            f"AnimaGenerator needs '{field}' ({socket_name}), but the wired "
            f"ANIMA_CONTEXT never had it supplied. Wire it into the Anima "
            f"Context Bridge's '{field}' socket, and connect the bridge's "
            f"context output into AnimaGenerator."
        )
    return context_value(context, field)


def build_context_ui_payload(context: Any) -> Dict[str, Any]:
    """The post-run truth `AnimaGenerator` hands the frontend back under its
    `anima_context` `ui` key (`nodes/anima/generator.py`) — the only thing
    that can see a sampler scalar Use Everywhere injected straight into the
    prompt at submit time, since that never travels over a litegraph link
    the frontend can walk at edit time.

        {"supplied": {field: bool, ... for EVERY CONTEXT_FIELDS field},
         "values": {field: value, ... only for a SAMPLER_FIELDS field this
                     context actually had `context_supplied` for}}

    **Only `SAMPLER_FIELDS` (the five JSON-safe scalars) may ever appear in
    `values`.** `model`/`clip`/`vae`/`positive`/`negative`/`latent` are real
    torch objects (or `None`) — putting one in `values` would blow up
    `json.dumps` the instant this payload is serialized into the node's
    `ui` dict, so `supplied` reports on all eleven `CONTEXT_FIELDS` but
    `values` is built from `SAMPLER_FIELDS` alone, never the full set.

    Built entirely from `context_supplied`/`context_value` — both already
    fail closed for a garbage/non-dict/`None` context (every `supplied`
    entry `False`, `context_value` never raises), so a garbage `context`
    here simply produces `{"supplied": {every field: False}, "values": {}}`
    — never a raised exception, matching every other reader in this module.
    A field that's `supplied` but whose wire legitimately carried `None`
    still gets a `values` entry (`None`) rather than being omitted — the
    frontend is the one that decides whether "supplied but no value" falls
    back to a settings value; this function's job is only to report the
    truth it actually has.
    """
    supplied = {field: context_supplied(context, field) for field in CONTEXT_FIELDS}
    values = {
        field: context_value(context, field)
        for field in SAMPLER_FIELDS
        if supplied[field]
    }
    return {"supplied": supplied, "values": values}


__all__ = (
    "MISSING", "CONTEXT_FIELDS", "CONTEXT_FIELD_SOCKET_NAMES",
    "ContextFieldMissing", "build_context", "context_supplied",
    "context_value", "require_context_value", "build_context_ui_payload",
)
