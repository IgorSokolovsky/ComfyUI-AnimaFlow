"""Pure `inherit_sampler_settings` resolution (design doc §6b), shared by the
three sampling stages that carry the flag: highres, upscale, and each
detailer block. No comfy/torch import.

Matches upstream EXACTLY (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/sampling.py:400-436`,
MIT © n0va39 — THIRD_PARTY_NOTICES.md), minus the backend-dispatch fields we
don't ship (design doc §1). The flag only ever covers THREE fields — `cfg`,
`sampler_name`, `scheduler` — never `steps` or `denoise`, which are always
the stage's own regardless of the flag: a low-denoise refinement pass has to
set both of those for itself no matter what it inherits (`:404`, `:434`).
"That's the whole point of a refinement pass" is also why "inherit
everything" is the realistic bug here, not an edge case — hence the tests
assert the two un-inherited fields explicitly, not just the three that move.
"""
from __future__ import annotations

from typing import Any, Dict

# Fields the flag actually governs — see module docstring. `steps`/`denoise`
# are deliberately absent from this tuple.
INHERITED_FIELDS = ("cfg", "sampler_name", "scheduler")

# Fields that are ALWAYS the stage's own, regardless of the flag.
OWN_FIELDS = ("steps", "denoise")


def resolve_stage_sampler(stage_settings: Dict[str, Any], base_sampler: Dict[str, Any]) -> Dict[str, Any]:
    """A stage's own settings dict (must carry `inherit_sampler_settings`,
    `steps`, `denoise`, and its own `cfg`/`sampler_name`/`scheduler`) plus the
    first pass's resolved sampler dict -> the stage's EFFECTIVE sampler
    values.

    Pure passthrough of whatever's already in the dicts — coercion to real
    numbers/strings happens where these values are actually consumed
    (`pipeline.py`), mirroring `_rows_helpers.py`'s split between shape
    (here) and value coercion (at the point of use).
    """
    if not isinstance(stage_settings, dict):
        stage_settings = {}
    if not isinstance(base_sampler, dict):
        base_sampler = {}

    inherit = bool(stage_settings.get("inherit_sampler_settings", True))
    resolved: Dict[str, Any] = {
        "inherit_sampler_settings": inherit,
        "steps": stage_settings.get("steps"),
        "denoise": stage_settings.get("denoise"),
    }
    for field in INHERITED_FIELDS:
        resolved[field] = base_sampler.get(field) if inherit else stage_settings.get(field)
    return resolved
