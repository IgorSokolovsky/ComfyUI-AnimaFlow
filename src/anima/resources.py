"""Pure resource-resolution rules (design doc §3 `use_internal_loaders`, §5a
per-field sampler wired-wins). No comfy/torch import — resolving WHICH
MODEL/CLIP/VAE object or which sampler value to use is arithmetic over
already-received Python values; actually loading a picker's model, or
reading a socket's real wired value, happens in `pipeline.py`.
"""
from __future__ import annotations

from typing import Any, Dict, Optional


class ResourceError(ValueError):
    """A resource can't be resolved. Always carries a READABLE, user-facing
    message — design doc §3: "the error text matters" (`use_internal_loaders
    is off but no MODEL is connected` beats an `AttributeError` mid-sample) —
    never a bare crash.
    """


# ComfyUI's own type-name spelling for each socket — used verbatim in the
# error text so it reads like the port name the user actually sees.
_SOCKET_TYPE_NAMES = {"model": "MODEL", "clip": "CLIP", "vae": "VAE"}


def resolve_loader_socket(kind: str, use_internal_loaders: bool, value: Any) -> str:
    """-> `"internal"` (the node's own picker) or `"socket"` (the wired
    value), for one of `model`/`clip`/`vae`. Raises `ResourceError` only in
    the one case that's actually a mistake: the flag is off (sockets should
    drive) and nothing is wired.
    """
    if use_internal_loaders:
        return "internal"
    if value is None:
        type_name = _SOCKET_TYPE_NAMES.get(kind, str(kind).upper())
        raise ResourceError(f"use_internal_loaders is off but no {type_name} is connected")
    return "socket"


def resolve_loader_resources(
    use_internal_loaders: bool,
    *,
    model: Any = None,
    clip: Any = None,
    vae: Any = None,
) -> Dict[str, str]:
    """All three loader resources at once -> `{"model": "internal"|"socket",
    "clip": ..., "vae": ...}`. Raises on the FIRST missing required socket,
    in `model`/`clip`/`vae` order — deterministic, so the same hand-edited
    payload always reports the same first problem rather than a set whose
    iteration order isn't guaranteed to match across runs.
    """
    return {
        "model": resolve_loader_socket("model", use_internal_loaders, model),
        "clip": resolve_loader_socket("clip", use_internal_loaders, clip),
        "vae": resolve_loader_socket("vae", use_internal_loaders, vae),
    }


# The five sampler sockets that are wired-wins independently, per field, with
# NO flag (design doc §5a) — deliberately not the loaders' all-or-nothing
# pattern; the design doc explains why the two are justified differently
# (MODEL/CLIP/VAE genuinely travel together as one checkpoint decision; the
# five sampler fields don't).
SAMPLER_FIELDS = ("seed", "steps", "cfg", "sampler_name", "scheduler")


def resolve_sampler_inputs(
    settings_sampler: Dict[str, Any],
    wired: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """`generation_settings.sampler` plus whatever of the five sockets is
    actually wired -> the resolved sampler dict the first pass runs with.
    Every OTHER key in `settings_sampler` (`denoise`, `shift`,
    `seed_after_generate`, ...) passes through untouched — only the five
    fields in `SAMPLER_FIELDS` are wire-eligible at all.

    A field counts as "wired" when its value is not `None` — ComfyUI hands an
    unconnected `optional` socket to the node as `None`, so `None` IS the
    "nothing wired" signal here, never a real seed/steps/cfg/sampler/
    scheduler value a wire would actually carry.
    """
    if not isinstance(settings_sampler, dict):
        settings_sampler = {}
    if not isinstance(wired, dict):
        wired = {}

    resolved = dict(settings_sampler)
    for field in SAMPLER_FIELDS:
        wired_value = wired.get(field)
        if wired_value is not None:
            resolved[field] = wired_value
    return resolved
