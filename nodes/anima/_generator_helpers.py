"""Combo option lists for `AnimaGenerator`'s internal-loader pickers and
sampler sockets — all lazily looked up against a live ComfyUI process,
falling back to a small static list when none is running (so
`AnimaGenerator.INPUT_TYPES()` stays callable from a plain-script test with
no ComfyUI installed — see `tests/test_anima_nodes.py`).

Mirrors `nodes/controls/_loaders_helpers.py`'s lazy `import folder_paths`/
`import nodes` pattern (comfyui-pack-import-structure skill): nothing here
imports ComfyUI at module scope.
"""
from __future__ import annotations

from typing import List

# Static fallbacks — only used when no live ComfyUI process backs these
# lookups (a plain-script test, or `INPUT_TYPES()` called outside ComfyUI).
_FALLBACK_MODEL_NAMES = ["(no diffusion models found)"]
_FALLBACK_CLIP_NAMES = ["(no CLIP/text encoders found)"]
_FALLBACK_VAE_NAMES = ["(no VAEs found)"]
_FALLBACK_CLIP_TYPES = ["stable_diffusion", "qwen_image"]
_FALLBACK_SAMPLER_NAMES = ["euler", "euler_ancestral", "er_sde", "dpmpp_2m"]
_FALLBACK_SCHEDULERS = ["simple", "sgm_uniform", "karras", "normal"]


def _folder_names(folder: str, fallback: List[str]) -> List[str]:
    try:
        import folder_paths  # ComfyUI-only; lazy.

        names = folder_paths.get_filename_list(folder)
    except Exception:
        names = []
    return list(names) if names else list(fallback)


def unet_names() -> List[str]:
    return _folder_names("diffusion_models", _FALLBACK_MODEL_NAMES)


def clip_names() -> List[str]:
    return _folder_names("text_encoders", _FALLBACK_CLIP_NAMES)


def vae_names() -> List[str]:
    return _folder_names("vae", _FALLBACK_VAE_NAMES)


def clip_type_options() -> List[str]:
    try:
        import nodes as comfy_nodes  # ComfyUI's own; lazy.

        cls = comfy_nodes.NODE_CLASS_MAPPINGS.get("CLIPLoader")
        options = cls.INPUT_TYPES()["required"]["type"][0]
        return list(options)
    except Exception:
        return list(_FALLBACK_CLIP_TYPES)


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
