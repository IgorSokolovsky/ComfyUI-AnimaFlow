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



# ---------------------------------------------------------------------------
# Preferred internal-loader defaults -- `AnimaGenerator`'s unet_name/clip_name/
# vae_name pickers (design doc §3's "four pickers"). Ported from
# ComfyUI-EasyUseAnima's `easyuse_anima/aio/input_defaults.py:6-15` (candidate
# tuples) and `easyuse_anima/aio/resources.py:114-128` (`_preferred_name_default`)
# -- MIT (c) n0va39, see THIRD_PARTY_NOTICES.md. Without this, ComfyUI's combo
# convention (no explicit `default` -> widget shows list entry `[0]`) silently
# picks whatever sorts first in the user's models folder, which in a real
# install is very unlikely to be an Anima model at all.
# ---------------------------------------------------------------------------

# Each tuple is preference order, NOT alphabetical -- the first entry present
# in the user's folder wins even if a later candidate happens to sort earlier
# in `folder_paths.get_filename_list()`'s own return order.
UNET_NAME_CANDIDATES = (
    "anima-base-v1.0.safetensors",
    # Upstream's own second candidate, verbatim -- a literal backslash
    # subfolder prefix (`ANIMA\anima_baseV10.safetensors`), matching a
    # real-world layout where the file sits inside an `ANIMA\` folder.
    "ANIMA\\anima_baseV10.safetensors",
)
CLIP_NAME_CANDIDATES = ("qwen_3_06b_base.safetensors",)
VAE_NAME_CANDIDATES = ("qwen_image_vae.safetensors",)


def _preferred_name_basename(name: str) -> str:
    """Last path segment, lowercased, tolerant of EITHER slash direction.

    `UNET_NAME_CANDIDATES`'s second entry carries a literal backslash
    (`ANIMA\\anima_baseV10.safetensors`), but `folder_paths.get_filename_list`
    reports subfolder-qualified names using the HOST OS's own separator (a
    forward slash on the Colab/Linux install this pack actually targets), and
    some installs report a bare basename with no subfolder prefix at all.
    Normalizing every name -- both the candidate and the folder entry -- down
    to "final path segment, case-folded" is what lets one candidate list
    match `ANIMA\\anima_baseV10.safetensors`, `ANIMA/anima_baseV10.safetensors`,
    and bare `anima_baseV10.safetensors` alike. This is the exact kind of
    normalization that's easy to skip and then silently never match.
    """
    return str(name).replace("\\", "/").rsplit("/", 1)[-1].lower()


def preferred_name_default(names, candidates):
    """The `default` to hand one of the three pickers' `INPUT_TYPES` tuple.

    Semantics (never crash, never invent a name that isn't installed):
    - Walk `candidates` IN ORDER (candidate-tuple order, not folder-list
      order -- that ordering is the whole point of a preference tuple) and
      return the first one actually present in `names`, exact string match
      first.
    - If no candidate matches exactly, retry basename-insensitively (handles
      a candidate's subfolder prefix not matching the folder list's own
      separator/depth -- see `_preferred_name_basename`).
    - If nothing in `candidates` is present at all, fall back to `names[0]`
      -- some installed model IS a safer, more honest default than `None`.
    - `names == []` (a missing models folder -- `folder_paths` returns `[]`
      rather than raising) falls back to `candidates[0]` if there is one,
      else `""`; there's nothing installed to pick either way.
    """
    if not names:
        return candidates[0] if candidates else ""
    for candidate in candidates:
        if candidate in names:
            return candidate
    by_basename = {_preferred_name_basename(name): name for name in names}
    for candidate in candidates:
        match = by_basename.get(_preferred_name_basename(candidate))
        if match is not None:
            return match
    return names[0]


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
