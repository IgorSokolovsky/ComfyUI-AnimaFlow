"""AnimaLoader — plain-socket unet/vae/clip loader for Anima.

Picks `unet_name`/`vae_name`/`clip_name`/`clip_type`/`weight_dtype` in one
node and outputs plain, standard `MODEL`/`CLIP`/`VAE` sockets — the useful
half of the reference pack's `EasyUseAnimaInput`
(`../ComfyUI-EasyUseAnima/easyuse_anima/nodes/aio_nodes.py`) without either
of its two deliberately-rejected traits: it does NOT bundle those names into
a single proprietary blob socket (that pack's own docstring explains why:
"the AiO Generator loads MODEL, CLIP, and VAE at execution time so model
patches and Torch compile do not live inside a custom dict socket" — this
node returns standard sockets directly, so that concern doesn't apply here
either), and it takes NO prompt-data input at all — loading resources has no
structural reason to be coupled to a prompt format. See the approved plan
(`frolicking-doodling-hummingbird.md`)'s "Explicitly OUT of scope" section,
which lists the proprietary bundling node itself (not this convenience
loader) as rejected.

Thin node: all actual name-lookup/loading logic lives in
`_anima_loader_helpers.py` (guarded `folder_paths`/core-loader-combo lookups
plus the real `UNETLoader`/`CLIPLoader`/`VAELoader` calls). No JS: default
widgets only.
"""

from __future__ import annotations

from ._anima_loader_helpers import (
    DEFAULT_CLIP_TYPE,
    DEFAULT_WEIGHT_DTYPE,
    get_clip_loader_types,
    get_diffusion_model_names,
    get_text_encoder_names,
    get_vae_names,
    get_weight_dtype_options,
    load_model_clip_vae,
    pick_preferred_name,
)


class AnimaLoader:
    CATEGORY = "AnimaFlow/anima"
    EXPERIMENTAL = True
    FUNCTION = "load"
    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("model", "clip", "vae")
    OUTPUT_TOOLTIPS = (
        "The loaded diffusion MODEL, via core ComfyUI's own UNETLoader — wire into AnimaGenerator, KSampler, or any other MODEL input.",
        "The loaded text-encoder CLIP, via core ComfyUI's own CLIPLoader — wire into AnimaConditioningEncode, CLIPTextEncode, or any other CLIP input.",
        "The loaded VAE, via core ComfyUI's own VAELoader — wire into AnimaGenerator or any other VAE input.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        unet_names = get_diffusion_model_names()
        vae_names = get_vae_names()
        clip_names = get_text_encoder_names()
        clip_types = get_clip_loader_types()
        weight_dtypes = get_weight_dtype_options()

        return {
            "required": {
                "unet_name": (unet_names, {
                    "default": pick_preferred_name(unet_names, "anima"),
                    "tooltip": "The Anima diffusion model file (from ComfyUI's models/diffusion_models directory) loaded via core's own UNETLoader.",
                }),
                "vae_name": (vae_names, {
                    "default": pick_preferred_name(vae_names, "qwen"),
                    "tooltip": "The VAE file (from ComfyUI's models/vae directory) loaded via core's own VAELoader — Anima uses the Qwen-Image VAE.",
                }),
                "clip_name": (clip_names, {
                    "default": pick_preferred_name(clip_names, "qwen"),
                    "tooltip": "The text-encoder file (from ComfyUI's models/text_encoders directory) loaded via core's own CLIPLoader — Anima uses a Qwen-based text encoder.",
                }),
                "clip_type": (clip_types, {
                    "default": DEFAULT_CLIP_TYPE if DEFAULT_CLIP_TYPE in clip_types else clip_types[0],
                    "tooltip": (
                        "Text-encoder architecture passed to core's own CLIPLoader `type` widget — "
                        "defaults to \"qwen_image\" because Anima's text encoder is Qwen-based (the "
                        "reference EasyUseAnima pack defaults its own equivalent field the same way)."
                    ),
                }),
                "weight_dtype": (weight_dtypes, {
                    "default": DEFAULT_WEIGHT_DTYPE if DEFAULT_WEIGHT_DTYPE in weight_dtypes else weight_dtypes[0],
                    "tooltip": "Precision core's own UNETLoader loads unet_name's weights at — \"default\" keeps the checkpoint's own stored precision; the fp8_* options trade some quality for lower VRAM use.",
                }),
            },
        }

    def load(self, unet_name, vae_name, clip_name, clip_type=DEFAULT_CLIP_TYPE, weight_dtype=DEFAULT_WEIGHT_DTYPE):
        model, clip, vae = load_model_clip_vae(unet_name, vae_name, clip_name, clip_type, weight_dtype)
        return (model, clip, vae)


__all__ = ("AnimaLoader",)
