"""AnimaGenerator - the decoupled replacement for the reference pack's
monolithic AiO Generator+Input pair.

Takes plain, standard ComfyUI sockets directly (`MODEL`, `VAE`, optional
`CLIP`/`CONDITIONING`/`LATENT`/`LORA_STACK`/`SEGS`/`DETAILER_HOOK`) - no
proprietary bundled "Input" context object - so it's independently wireable
into any workflow, not just ones built entirely from this pack's own nodes.
It does NOT render its own live preview UI: that is the separate
`AnimaPreview` node (`nodes/node_anima_preview.py`); this node only
broadcasts intermediate frames over a named channel via
`_anima_preview_channel.broadcast_preview`.

Full pipeline (per the approved plan): first pass -> optional highres ->
optional detailer (soft-depends on Impact Pack, generic `SEGS` detection
input - not tied to one detector) -> optional upscale (soft-depends on
EITHER ComfyUI_UltimateSDUpscale OR ComfyUI-Distilled-ResShift, user's
choice) -> optional postprocess resize -> optional save (via core's own
`SaveImage`). See `nodes/_anima_generator_helpers.py`'s module docstring for
the detailed per-stage design notes/deviations.

Thin node: all actual pipeline logic lives in `_anima_generator_helpers.py`
(torch/comfy-touching stages) and `_anima_conditioning_helpers.py` (the
CLIP-encode helper shared with Phase 3's `AnimaConditioningEncode`). This
module only assembles `INPUT_TYPES`/tooltips and sequences the calls.
"""

from __future__ import annotations

from ._anima_generator_helpers import (
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    MAX_SEED,
    apply_lora_stack,
    build_empty_latent,
    build_metadata,
    decode_latent,
    encode_image_to_latent,
    get_sampler_names,
    get_scheduler_names,
    get_upscale_model_names,
    pick_default,
    resolve_pane_conditioning,
    run_detailer_stage,
    run_highres_pass,
    run_postprocess_resize,
    run_save_output_stage,
    run_upscale_stage,
    sample_latent,
)
from ._anima_preview_channel import DEFAULT_CHANNEL, broadcast_preview


class AnimaGenerator:
    CATEGORY = "AnimaFlow/anima"
    EXPERIMENTAL = True
    FUNCTION = "generate"
    RETURN_TYPES = ("IMAGE", "LATENT", "STRING")
    RETURN_NAMES = ("image", "latent", "metadata")
    OUTPUT_TOOLTIPS = (
        "The final generated image - the result of the LAST stage that actually ran this pass (postprocess resize > upscale > detailer > highres > first pass, in that priority order).",
        "The matching LATENT for the returned image (before VAE decode) - re-encoded via VAE after any stage that changed the image's pixels, so it's always in sync with the image output. Wire onward into further latent-space nodes without a redundant VAE re-encode.",
        "Small JSON blob recording the settings actually used this run (seed, steps, cfg, sampler, scheduler, highres/detailer/upscale/postprocess/save settings, applied LoRAs) - for logging/debugging or feeding into a save/metadata node.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        sampler_names = tuple(get_sampler_names())
        scheduler_names = tuple(get_scheduler_names())
        default_sampler = pick_default(sampler_names, "euler_ancestral")
        default_scheduler = pick_default(scheduler_names, "normal")

        return {
            "required": {
                "model": ("MODEL", {
                    "tooltip": "The diffusion model to sample with, for both the first pass and (if enabled) the highres pass.",
                }),
                "vae": ("VAE", {
                    "tooltip": (
                        "Used to decode sampled latents to pixel-space IMAGE, and (only if "
                        "highres_enabled) to re-encode the upscaled highres image back to a "
                        "latent before its second sampling pass."
                    ),
                }),
                "seed": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": MAX_SEED,
                    "tooltip": "Noise seed for the first pass (and, since this v1 has no separate highres seed, the highres pass too).",
                }),
                "steps": ("INT", {
                    "default": 28,
                    "min": 1,
                    "max": 10000,
                    "tooltip": "Sampling steps for the first pass (and the highres pass, which has no separate steps widget in this v1).",
                }),
                "cfg": ("FLOAT", {
                    "default": 5.0,
                    "min": 0.0,
                    "max": 100.0,
                    "step": 0.1,
                    "tooltip": "Classifier-free guidance scale - how strongly the sampler follows the positive/negative conditioning.",
                }),
                "sampler_name": (sampler_names, {
                    "default": default_sampler,
                    "tooltip": "Sampling algorithm, matching core KSampler's own options list.",
                }),
                "scheduler": (scheduler_names, {
                    "default": default_scheduler,
                    "tooltip": "Noise schedule, matching core KSampler's own options list.",
                }),
                "denoise": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "tooltip": "First-pass denoise strength - 1.0 for a fresh txt2img latent; lower values only make sense when an img2img `latent` input is wired.",
                }),
                "width": ("INT", {
                    "default": DEFAULT_WIDTH,
                    "min": 64,
                    "max": 8192,
                    "step": 8,
                    "tooltip": "Width of a freshly-generated latent - ignored if a `latent` input is wired instead.",
                }),
                "height": ("INT", {
                    "default": DEFAULT_HEIGHT,
                    "min": 64,
                    "max": 8192,
                    "step": 8,
                    "tooltip": "Height of a freshly-generated latent - ignored if a `latent` input is wired instead.",
                }),
                "highres_enabled": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Runs a second, higher-resolution sampling pass on the first pass's result (a classic highres-fix). Off by default (first-pass-only generator).",
                }),
                "highres_multiple": ("INT", {
                    "default": 64,
                    "min": 1,
                    "max": 1024,
                    "tooltip": "Only used if highres_enabled: the highres target size is rounded UP to this multiple (aspect-preserving), via the same math AnimaImageScaleByMultiple uses, so the upscaled latent stays safe to VAE-encode/sample.",
                }),
                "highres_max_long_edge": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 16384,
                    "step": 8,
                    "tooltip": "Only used if highres_enabled: caps the highres pass's longer output dimension to this many pixels. 0 disables the cap.",
                }),
                "highres_denoise": ("FLOAT", {
                    "default": 0.4,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "tooltip": "Only used if highres_enabled: partial-denoise strength for the highres pass - lower keeps more of the first pass's composition, higher adds more new detail/risk of drift.",
                }),
                "preview_channel": ("STRING", {
                    "default": DEFAULT_CHANNEL,
                    "tooltip": (
                        "Name of the preview channel this run's in-progress frames (first pass, "
                        "highres, detailer, upscale) are broadcast on. Must exactly match an "
                        "AnimaPreview node's own `channel` field to be shown there - deliberately a "
                        "plain name, not a wired socket, so any number of AnimaPreview nodes (or "
                        "none) can listen."
                    ),
                }),
                "detailer_enabled": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "Runs Impact Pack's own DetailerForEach on the regions given by the segs "
                        "input, re-sampling each detected region at higher fidelity (a classic "
                        "face/eye detail fix). Requires Impact Pack (ComfyUI-Impact-Pack) to be "
                        "installed AND a segs input actually wired with detections - if segs is "
                        "empty/unwired this stage silently no-ops even when this is on, so leaving "
                        "it enabled without a detector wired this run is harmless."
                    ),
                }),
                "detailer_guide_size": ("FLOAT", {
                    "default": 512,
                    "min": 64,
                    "max": 8192,
                    "step": 8,
                    "tooltip": "Only used if detailer_enabled and segs has detections: target guide size Impact Pack's DetailerForEach resamples each detected region to before its own internal upscale/downscale.",
                }),
                "detailer_max_size": ("FLOAT", {
                    "default": 1024,
                    "min": 64,
                    "max": 8192,
                    "step": 8,
                    "tooltip": "Only used if detailer_enabled and segs has detections: the maximum crop size Impact Pack's DetailerForEach will sample a detected region at, capping guide_size's effect.",
                }),
                "detailer_denoise": ("FLOAT", {
                    "default": 0.5,
                    "min": 0.0001,
                    "max": 1.0,
                    "step": 0.01,
                    "tooltip": "Only used if detailer_enabled and segs has detections: partial-denoise strength for each detailed region - lower keeps more of the original crop, higher adds more new detail/risk of drift.",
                }),
                "upscale_enabled": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Runs a final tiled/single-pass upscale on the result via upscale_backend, after any detailer stage. Off by default.",
                }),
                "upscale_backend": (["usdu", "resshift"], {
                    "default": "usdu",
                    "tooltip": (
                        "Only used if upscale_enabled: which optional pack performs the upscale. "
                        "\"usdu\" = ComfyUI_UltimateSDUpscale's tiled img2img upscale (needs an "
                        "upscale model + the upscale_usdu_* widgets); \"resshift\" = "
                        "ComfyUI-Distilled-ResShift's single-pass diffusion upscale (needs the "
                        "upscale_resshift_* widgets). Each requires its own pack to be installed."
                    ),
                }),
                "upscale_usdu_model_name": (get_upscale_model_names(), {
                    "tooltip": "Only used if upscale_enabled and upscale_backend is \"usdu\": the upscale model (from ComfyUI's models/upscale_models) UltimateSDUpscale applies before its tiled sampling pass.",
                }),
                "upscale_usdu_scale_by": ("FLOAT", {
                    "default": 2.0,
                    "min": 1.0,
                    "max": 8.0,
                    "step": 0.05,
                    "tooltip": "Only used if upscale_enabled and upscale_backend is \"usdu\": the output scale factor relative to the input image's current size.",
                }),
                "upscale_usdu_tile_size": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 4096,
                    "step": 8,
                    "tooltip": "Only used if upscale_enabled and upscale_backend is \"usdu\": tile width and height UltimateSDUpscale samples at (smaller tiles use less VRAM but take longer / can show more seams).",
                }),
                "upscale_usdu_denoise": ("FLOAT", {
                    "default": 0.2,
                    "min": 0.0,
                    "max": 1.0,
                    "step": 0.01,
                    "tooltip": "Only used if upscale_enabled and upscale_backend is \"usdu\": partial-denoise strength for each upscaled tile's resample pass - low values (the default) mostly just add fine detail without changing the composition.",
                }),
                "upscale_resshift_scale": ("STRING", {
                    "default": "x2",
                    "tooltip": "Only used if upscale_enabled and upscale_backend is \"resshift\": the scale factor string ResShiftLoader.load() expects (e.g. \"x2\", \"x4\" - whichever your installed ResShift model set supports).",
                }),
                "upscale_resshift_chop": ("INT", {
                    "default": 512,
                    "min": 64,
                    "max": 4096,
                    "step": 8,
                    "tooltip": "Only used if upscale_enabled and upscale_backend is \"resshift\": tile size ResShiftUpscale processes the image in.",
                }),
                "upscale_resshift_overlap": ("INT", {
                    "default": 64,
                    "min": 0,
                    "max": 1024,
                    "step": 8,
                    "tooltip": "Only used if upscale_enabled and upscale_backend is \"resshift\": pixel overlap between adjacent ResShift tiles, to avoid visible seams.",
                }),
                "upscale_resshift_tile_batch": ("INT", {
                    "default": 4,
                    "min": 1,
                    "max": 64,
                    "tooltip": "Only used if upscale_enabled and upscale_backend is \"resshift\": how many tiles ResShiftUpscale processes per batch (higher uses more VRAM but can be faster).",
                }),
                "postprocess_resize_enabled": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Runs one final resize pass (no re-sampling) on the result so it lands on an exact multiple of postprocess_multiple, aspect-preserving. Off by default.",
                }),
                "postprocess_multiple": ("INT", {
                    "default": 0,
                    "min": 0,
                    "max": 1024,
                    "tooltip": "Only used if postprocess_resize_enabled: the final image's width/height are rounded to the nearest multiple of this value (same math AnimaImageScaleByMultiple uses), via a plain resize, no re-sampling. 0 disables this stage regardless of the toggle above.",
                }),
                "save_output": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "Saves the final image via ComfyUI's own SaveImage node, landing in the "
                        "normal output directory with a normal preview. Off by default - the "
                        "decoupled default is to wire the image output to your own save node "
                        "instead; turn this on only if you want this node to save directly."
                    ),
                }),
                "save_prefix": ("STRING", {
                    "default": "Anima",
                    "tooltip": "Only used if save_output: the filename prefix passed to SaveImage (same convention as core SaveImage's own filename_prefix widget - can include a subfolder, e.g. \"webtoon/panel\").",
                }),
            },
            "optional": {
                "clip": ("CLIP", {
                    "tooltip": "Only needed if positive_text/negative_text is used instead of a wired CONDITIONING - can stay unconnected if both CONDITIONING sockets are wired directly.",
                }),
                "positive": ("CONDITIONING", {
                    "tooltip": "An already-encoded positive conditioning (from core CLIPTextEncode, AnimaConditioningEncode, or any other source) - used as-is if wired, taking priority over positive_text.",
                }),
                "positive_text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "Used only if positive isn't wired - requires clip to be connected. Internally encoded via the same helper AnimaConditioningEncode (a later phase's node) will use, so both paths produce identical conditioning.",
                }),
                "negative": ("CONDITIONING", {
                    "tooltip": "An already-encoded negative conditioning - used as-is if wired, taking priority over negative_text.",
                }),
                "negative_text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "Used only if negative isn't wired - requires clip to be connected, encoded via the same shared helper as positive_text.",
                }),
                "latent": ("LATENT", {
                    "tooltip": "An existing latent to sample from (img2img-style) instead of generating a fresh empty one sized width x height.",
                }),
                "lora_stack": ("LORA_STACK", {
                    "tooltip": "A stack of LoRAs (from core LoraLoader-compatible stack nodes) applied to model/clip before conditioning is resolved and before sampling.",
                }),
                "segs": ("SEGS", {
                    "tooltip": (
                        "Detection regions from ANY detector node (SAM, SAM2, SAM3, BBox, "
                        "GroundingDINO, whatever Impact Pack workflow you already use) - not tied "
                        "to one detection method. Only used if detailer_enabled; if left unwired "
                        "(or the detector found nothing), the detailer stage silently no-ops."
                    ),
                }),
                "detailer_hook": ("DETAILER_HOOK", {
                    "tooltip": "Wire an Anima Detailer Align Hook (or any Impact-compatible DETAILER_HOOK) here to keep crop sizes latent-safe during detailing. Only used if detailer_enabled and segs has detections.",
                }),
            },
        }

    def generate(
        self,
        model,
        vae,
        seed,
        steps,
        cfg,
        sampler_name,
        scheduler,
        denoise,
        width,
        height,
        highres_enabled,
        highres_multiple,
        highres_max_long_edge,
        highres_denoise,
        detailer_enabled,
        detailer_guide_size,
        detailer_max_size,
        detailer_denoise,
        upscale_enabled,
        upscale_backend,
        upscale_usdu_model_name,
        upscale_usdu_scale_by,
        upscale_usdu_tile_size,
        upscale_usdu_denoise,
        upscale_resshift_scale,
        upscale_resshift_chop,
        upscale_resshift_overlap,
        upscale_resshift_tile_batch,
        postprocess_resize_enabled,
        postprocess_multiple,
        save_output,
        save_prefix,
        preview_channel=DEFAULT_CHANNEL,
        clip=None,
        positive=None,
        positive_text="",
        negative=None,
        negative_text="",
        latent=None,
        lora_stack=None,
        segs=None,
        detailer_hook=None,
    ):
        # LoRAs are applied BEFORE conditioning is resolved: a LoRA can
        # patch clip's text embeddings too (trigger words etc.), so the
        # text-encode branch below must see the LoRA-patched clip, exactly
        # like a standard "Load LoRA -> CLIPTextEncode -> KSampler" chain.
        model, clip, applied_loras = apply_lora_stack(model, clip, lora_stack)

        positive_cond = resolve_pane_conditioning("positive", clip, positive, positive_text)
        negative_cond = resolve_pane_conditioning("negative", clip, negative, negative_text)

        first_latent = latent if latent is not None else build_empty_latent(width, height)

        sampled = sample_latent(
            model, seed, steps, cfg, sampler_name, scheduler,
            positive_cond, negative_cond, first_latent, denoise,
        )
        image = decode_latent(vae, sampled)
        broadcast_preview(preview_channel, image, "first_pass")

        result_latent, result_image = sampled, image
        highres_metadata = {"enabled": bool(highres_enabled)}

        if highres_enabled:
            current_height = int(image.shape[1])
            current_width = int(image.shape[2])
            hi_image, hi_latent, hi_width, hi_height, hi_scale = run_highres_pass(
                model, vae, positive_cond, negative_cond, image,
                current_width, current_height,
                highres_multiple, highres_max_long_edge,
                seed, steps, cfg, sampler_name, scheduler, highres_denoise,
            )
            broadcast_preview(preview_channel, hi_image, "highres")
            result_latent, result_image = hi_latent, hi_image
            highres_metadata.update({
                "multiple": int(highres_multiple),
                "max_long_edge": int(highres_max_long_edge),
                "denoise": float(highres_denoise),
                "width": hi_width,
                "height": hi_height,
                "scale_factor": hi_scale,
            })

        # Detailer stage: the toggle gates whether this stage is even
        # attempted at all (skipping straight past the optional-pack lookup
        # when the feature isn't wanted this run); `run_detailer_stage`
        # itself additionally no-ops (no error) if `segs` turns out to be
        # unwired/empty, so leaving detailer_enabled on without a detector
        # wired this particular run is harmless - see its own docstring.
        detailer_metadata = {"enabled": False}
        if detailer_enabled:
            result_image, detailer_metadata = run_detailer_stage(
                result_image, segs, model, clip, vae, positive_cond, negative_cond,
                seed, steps, cfg, sampler_name, scheduler,
                detailer_guide_size, detailer_max_size, detailer_denoise,
                preview_channel, hook=detailer_hook,
            )
            if detailer_metadata.get("enabled"):
                # Detailing changed the image's pixels - keep `latent`
                # (this node's second output) in sync via a fresh VAE
                # encode, exactly like the highres stage above does.
                result_latent = encode_image_to_latent(vae, result_image)

        # Upscale stage: `upscale_enabled` alone gates whether this runs -
        # unlike the detailer stage, there's no equivalent "optional
        # per-run data" to additionally gate on.
        upscale_metadata = {"enabled": False}
        if upscale_enabled:
            result_image, upscale_metadata = run_upscale_stage(
                result_image, model, positive_cond, negative_cond, vae, upscale_backend,
                seed, steps, cfg, sampler_name, scheduler, preview_channel,
                upscale_usdu_denoise, upscale_usdu_scale_by, upscale_usdu_tile_size, upscale_usdu_model_name,
                upscale_resshift_scale, upscale_resshift_chop, upscale_resshift_overlap, upscale_resshift_tile_batch,
            )
            result_latent = encode_image_to_latent(vae, result_image)

        # Postprocess resize: a plain, no-resample resize pass - only
        # touches `latent` if it actually resized something (multiple <= 0,
        # or the image already landed on that multiple, are both no-ops).
        postprocess_metadata = {"enabled": False}
        if postprocess_resize_enabled:
            result_image, postprocess_metadata = run_postprocess_resize(result_image, postprocess_multiple)
            if postprocess_metadata.get("resized"):
                result_latent = encode_image_to_latent(vae, result_image)

        # Save: decoupled, agnostic default is OFF - the user is expected to
        # wire `image` to their own save node unless this is explicitly on.
        save_metadata = {"enabled": False}
        if save_output:
            run_save_output_stage(result_image, save_prefix)
            save_metadata = {"enabled": True, "prefix": str(save_prefix or "Anima")}

        metadata = build_metadata(
            seed=seed, steps=steps, cfg=cfg, sampler_name=sampler_name, scheduler=scheduler,
            denoise=denoise, width=width, height=height,
            highres=highres_metadata, loras=applied_loras,
            detailer=detailer_metadata, upscale=upscale_metadata,
            postprocess=postprocess_metadata, save=save_metadata,
        )
        return (result_image, result_latent, metadata)


__all__ = ("AnimaGenerator",)
