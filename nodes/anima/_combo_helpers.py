"""Combo option lists for `AnimaContextBridge`'s `sampler_name`/`scheduler`
sockets — lazily looked up against a live ComfyUI process, falling back to a
small static list when none is running (so `AnimaContextBridge.INPUT_TYPES()`
stays callable from a plain-script test with no ComfyUI installed — see
`tests/test_anima_nodes.py`).

Mirrors `nodes/controls/_loaders_helpers.py`'s lazy `import folder_paths`/
`import nodes` pattern (comfyui-pack-import-structure skill): nothing here
imports ComfyUI at module scope.

Formerly `_generator_helpers.py`, and formerly four functions bigger
(`unet_names`/`clip_names`/`vae_names`/`clip_type_options`, plus their
fallback constants) — those backed `AnimaGenerator`'s own
`unet_name`/`clip_name`/`clip_type`/`vae_name` pickers, which this task
deleted along with `use_internal_loaders` (docs/generator-design.md §3's
whole internal-loader path is gone: resources now arrive exclusively via
`AnimaContextBridge`'s real MODEL/CLIP/VAE sockets, never a name+loader pair
on the Generator itself). Renamed because the two surviving functions are no
longer specific to "the Generator's own pickers" — they back
`AnimaContextBridge`'s sampler COMBO sockets instead.
"""
from __future__ import annotations

from typing import List

# Static fallbacks — only used when no live ComfyUI process backs these
# lookups (a plain-script test, or `INPUT_TYPES()` called outside ComfyUI).
_FALLBACK_SAMPLER_NAMES = ["euler", "euler_ancestral", "er_sde", "dpmpp_2m"]
_FALLBACK_SCHEDULERS = ["simple", "sgm_uniform", "karras", "normal"]


def sampler_name_options() -> List[str]:
    try:
        import comfy.samplers  # ComfyUI-only; lazy.

        return list(comfy.samplers.KSampler.SAMPLERS)
    except Exception:
        return list(_FALLBACK_SAMPLER_NAMES)


def scheduler_options() -> List[str]:
    try:
        import comfy.samplers  # ComfyUI-only; lazy.

        return list(comfy.samplers.KSampler.SCHEDULERS)
    except Exception:
        return list(_FALLBACK_SCHEDULERS)
