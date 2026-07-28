"""`Anima Generator` — runs the whole txt2img pipeline (first pass -> highres
-> detailer -> upscale -> postprocess) behind one node (contract:
docs/generator-design.md §5). Thin: every real decision (resource
resolution, stage gating, sampler inheritance, LoRA/tile/fit maths) is made
by a pure function in `src/anima/`; this class only wires up ComfyUI's
`INPUT_TYPES`/`RETURN_TYPES` and calls `src/anima/pipeline.run_generator`.

Not an `OUTPUT_NODE` — it doesn't save (design doc §2). A graph with no
Preview wired runs nothing at all; that's the intended behaviour, not an
oversight, since there is no output to produce without a consumer.

**`image_mid == image_base` is a legitimate "no detailer ran" result, not a
bug** (design doc §5 Outputs) — a disabled stage (or one whose dependency,
Impact Pack, is absent, or whose blocks are all off) passes the previous
stage's image through untouched rather than leaving a dead socket, since the
entire point of the three outputs is comparison.
"""
from __future__ import annotations

from ._generator_helpers import (
    clip_names,
    clip_type_options,
    sampler_name_options,
    scheduler_options,
    unet_names,
    vae_names,
)

# Picker category is Title Case; the folder underneath stays snake_case
# (`nodes/anima/`, `js/anima/`) — same "agree case-insensitively" convention
# as every other track in this pack.
CATEGORY = "AnimaFlow/Anima"

# Frozen for `tests/test_anima_nodes.py`'s required-key-order regression
# (design doc §10, BACKLOG.md §4: widget order is append-only — `42336c0`
# already broke saved workflows once by inserting mid-list). `positive`/
# `negative` first (conditioning), then the settings blob, then the flag +
# four pickers LAST, exactly matching design doc §5's input table and its
# §3 note ("The flag and the four pickers go at the end of `required` and
# never move").
REQUIRED_KEY_ORDER = (
    "positive",
    "negative",
    "generation_settings",
    "use_internal_loaders",
    "unet_name",
    "clip_name",
    "clip_type",
    "vae_name",
)


class AnimaGenerator:
    """`Anima Generator` — the whole txt2img pipeline behind one node, with
    popup settings (not yet built — see `docs/generator-design.md` §12; this
    node works, if plainly, with ComfyUI's raw widgets until the `js/anima/`
    slice lands)."""

    CATEGORY = CATEGORY
    EXPERIMENTAL = True
    FUNCTION = "generate"
    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE", "LATENT", "STRING")
    RETURN_NAMES = ("image", "image_base", "image_mid", "latent", "metadata_json")
    OUTPUT_TOOLTIPS = (
        "Final image, after every enabled stage (highres -> detailer -> "
        "upscale -> postprocess). Equals image_base if every stage is "
        "disabled or its dependency is absent.",
        "First-pass output -- before highres too. Always the same real "
        "pass regardless of which later stages are enabled.",
        "Image after the detailer stage, before upscale. Equals image_base "
        "(or the highres result) when the detailer is off, has no enabled "
        "blocks, or Impact Pack isn't installed -- a legitimate 'no "
        "detailer ran' result, not a bug.",
        "Final latent -- the last real diffusion latent this run produced "
        "(the highres stage's, or the first pass's if highres is off; "
        "detailer/upscale/postprocess all operate on pixels, not latents).",
        "Per-stage metadata (JSON) for debugging: resolved sampler values, "
        "which stage each output actually carries, applied LoRAs, and the "
        "postprocess fit result.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        try:
            # Same real-ComfyUI-vs-plain-script-test import dance as
            # `generate()` below (see its comment) -- `INPUT_TYPES` is a
            # classmethod, but the two-context problem is identical.
            from ...src.anima.resources import (
                CLIP_NAME_CANDIDATES,
                UNET_NAME_CANDIDATES,
                VAE_NAME_CANDIDATES,
                preferred_name_default,
            )
        except ImportError:
            from src.anima.resources import (
                CLIP_NAME_CANDIDATES,
                UNET_NAME_CANDIDATES,
                VAE_NAME_CANDIDATES,
                preferred_name_default,
            )

        # Resolved once so the SAME list backs both the picker's options and
        # its computed `default` -- `clip_type` already gets a fixed default
        # ("qwen_image") because its options are a small static enum; these
        # three don't have that luxury, since the option list itself is the
        # user's live models folder (BACKLOG-worthy gap this task exists to
        # close: no `default` here means ComfyUI's combo convention silently
        # picks list entry `[0]`, i.e. whatever sorts first on disk).
        unet_list = unet_names()
        clip_list = clip_names()
        vae_list = vae_names()
        return {
            "required": {
                "positive": ("CONDITIONING", {"tooltip": "Positive conditioning, already encoded upstream (e.g. by Prompt Rules (CLIP))."}),
                "negative": ("CONDITIONING", {"tooltip": "Negative conditioning, already encoded upstream."}),
                "generation_settings": (
                    "STRING",
                    {
                        "default": "{}",
                        "tooltip": (
                            "Serialized generation settings (JSON): sampler, mod "
                            "guidance, latent, inline LoRAs, and per-stage highres/"
                            "detailer/upscale/postprocess settings. Hidden for "
                            "rendering only, not meant to be hand-edited -- see "
                            "docs/generator-design.md §8."
                        ),
                    },
                ),
                # The flag + four pickers below are APPEND-ONLY at the end of
                # `required` -- see `REQUIRED_KEY_ORDER`'s comment.
                "use_internal_loaders": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": (
                            "On -> the unet_name/clip_name/clip_type/vae_name "
                            "pickers below are used and the model/clip/vae sockets "
                            "are ignored. Off -> the sockets are used, and must be "
                            "wired (design doc §3)."
                        ),
                    },
                ),
                "unet_name": (unet_list, {"default": preferred_name_default(unet_list, UNET_NAME_CANDIDATES), "tooltip": "Diffusion model to load internally. Only used when use_internal_loaders is on."}),
                "clip_name": (clip_list, {"default": preferred_name_default(clip_list, CLIP_NAME_CANDIDATES), "tooltip": "CLIP/text encoder to load internally. Only used when use_internal_loaders is on."}),
                "clip_type": (clip_type_options(), {"default": "qwen_image", "tooltip": "CLIP type for the internal CLIP loader -- defaults to qwen_image for Anima. Only used when use_internal_loaders is on."}),
                "vae_name": (vae_list, {"default": preferred_name_default(vae_list, VAE_NAME_CANDIDATES), "tooltip": "VAE to load internally. Only used when use_internal_loaders is on."}),
            },
            "optional": {
                "model": ("MODEL", {"tooltip": "Diffusion model. Required when use_internal_loaders is off; ignored when it's on."}),
                "clip": ("CLIP", {"tooltip": "CLIP. Required when use_internal_loaders is off (and needed for Mod Guidance/inline LoRAs); ignored when it's on."}),
                "vae": ("VAE", {"tooltip": "VAE for decode/encode. Required when use_internal_loaders is off; ignored when it's on."}),
                "latent": ("LATENT", {"tooltip": "Starting latent -- size and batch. Ignored in inline mode (use_internal_loaders on), which owns the latent via generation_settings.latent instead."}),
                "seed": ("INT", {"forceInput": True, "tooltip": "Wired seed -- wins over generation_settings.sampler.seed when connected (design doc §5a: wired-wins, per field, no flag)."}),
                "steps": ("INT", {"forceInput": True, "tooltip": "Wired step count -- wins over generation_settings.sampler.steps when connected."}),
                "cfg": ("FLOAT", {"forceInput": True, "tooltip": "Wired CFG -- wins over generation_settings.sampler.cfg when connected."}),
                "sampler_name": (sampler_name_options(), {"forceInput": True, "tooltip": "Wired sampler name -- wins over generation_settings.sampler.sampler_name when connected."}),
                "scheduler": (scheduler_options(), {"forceInput": True, "tooltip": "Wired scheduler -- wins over generation_settings.sampler.scheduler when connected."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def generate(
        self,
        positive,
        negative,
        generation_settings="{}",
        use_internal_loaders=False,
        unet_name=None,
        clip_name=None,
        clip_type="qwen_image",
        vae_name=None,
        model=None,
        clip=None,
        vae=None,
        latent=None,
        seed=None,
        steps=None,
        cfg=None,
        sampler_name=None,
        scheduler=None,
        unique_id=None,
    ):
        try:
            # Real ComfyUI context: this module lives two package levels
            # below this pack's top-level package (`nodes/anima/` -> pack
            # root), so a relative import up to the pack's own
            # `src.anima.pipeline` is correct here -- same convention as
            # `nodes/prompt_rules/_rules_helpers.py`'s import of
            # `src.prompt_rules.core`.
            from ...src.anima import pipeline  # type: ignore
        except ImportError:
            # Standalone context (plain-script tests, repo root on
            # `sys.path`): fall back to the bare form.
            from src.anima import pipeline

        image, image_base, image_mid, latent_out, metadata_json = pipeline.run_generator(
            positive=positive,
            negative=negative,
            generation_settings=generation_settings,
            use_internal_loaders=bool(use_internal_loaders),
            unet_name=unet_name,
            clip_name=clip_name,
            clip_type=clip_type,
            vae_name=vae_name,
            model=model,
            clip=clip,
            vae=vae,
            latent=latent,
            seed=seed,
            steps=steps,
            cfg=cfg,
            sampler_name=sampler_name,
            scheduler=scheduler,
        )
        return (image, image_base, image_mid, latent_out, metadata_json)


NODE_CLASS_MAPPINGS = {"AnimaGenerator": AnimaGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaGenerator": "Anima Generator"}
