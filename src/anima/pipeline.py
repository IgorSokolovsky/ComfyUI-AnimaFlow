"""Thin adapter layer over `src/anima`'s pure helpers (design doc §5-§6):
first pass -> highres -> detailer -> upscale -> postprocess. Every DECISION
(which stage runs, what its resolved sampler/tile/fit values are, which real
pass each output names) is made by a pure function in `settings.py`/
`stages.py`/`sampler.py`/`resources.py`/`loras.py`/`postprocess.py`/
`usdu.py`; this module ONLY calls ComfyUI/torch/third-party node classes
with the results, per this task's brief ("every comfy/torch touch is lazy
and looked up, never a top-level import").

VERIFY-IN-COMFYUI: every actual comfy/torch/Impact/USDU/Spectrum call in this
file is written from reading upstream's own call sites
(`../ComfyUI-EasyUseAnima`, cited per function) rather than exercised
against a live ComfyUI process — none is installed in this dev environment,
and that is expected (this task built the Python side only; see the build
report for exactly what a live run would need to confirm). The pure modules
this file calls into ARE fully unit-tested without ComfyUI; this file's own
job is narrow by design — translate resolved values into real node calls.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from . import loras as loras_mod
from . import postprocess as postprocess_mod
from . import resources as resources_mod
from . import sampler as sampler_mod
from . import settings as settings_mod
from . import soft_imports
from . import stages as stages_mod
from . import usdu as usdu_mod
from .resources import ResourceError

# ---------------------------------------------------------------------------
# Lazy comfy lookups + small call-shape helpers
# ---------------------------------------------------------------------------


def _comfy_node(class_name: str):
    """A CORE ComfyUI node class — lazy `import nodes` (ComfyUI's own; never
    this pack's `nodes/` package). A core node missing means a broken/
    ancient ComfyUI install, not an optional dependency, so this raises
    rather than degrading.
    """
    import nodes as comfy_nodes  # ComfyUI's own; lazy — see module docstring.

    cls = getattr(comfy_nodes, class_name, None)
    if cls is None:
        mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
        cls = mappings.get(class_name)
    if cls is None:
        raise RuntimeError(f"[AnimaFlow] Missing required core ComfyUI node '{class_name}'.")
    return cls


def _output0(result: Any) -> Any:
    """Every ComfyUI node call returns a tuple; take the first item, with a
    readable error on the (never-expected) empty case instead of an
    `IndexError`."""
    if not isinstance(result, tuple) or not result:
        raise RuntimeError("[AnimaFlow] a ComfyUI node call returned no outputs.")
    return result[0]


def _image_size(image: Any) -> Tuple[int, int]:
    """An `IMAGE` tensor's `(width, height)` — ComfyUI's own layout is
    `[batch, height, width, channels]`."""
    return int(image.shape[2]), int(image.shape[1])


# ---------------------------------------------------------------------------
# Resource loading (§3) — the internal pickers, only used when
# `use_internal_loaders` is on. Mirrors
# `nodes/controls/_loaders_helpers.py`'s delegation to ComfyUI's OWN loader
# nodes rather than reimplementing `comfy.sd` plumbing.
# ---------------------------------------------------------------------------


def load_internal_model(unet_name: str, weight_dtype: str = "default") -> Any:
    return _output0(_comfy_node("UNETLoader")().load_unet(unet_name, weight_dtype))


def load_internal_vae(vae_name: str) -> Any:
    return _output0(_comfy_node("VAELoader")().load_vae(vae_name))


def load_internal_clip(clip_name: str, clip_type: str = "qwen_image", device: str = "default") -> Any:
    return _output0(_comfy_node("CLIPLoader")().load_clip(clip_name, clip_type, device))


def resolve_resources(
    *,
    use_internal_loaders: bool,
    unet_name: str,
    clip_name: str,
    clip_type: str,
    vae_name: str,
    model: Any = None,
    clip: Any = None,
    vae: Any = None,
) -> Tuple[Any, Any, Any]:
    """§3: pickers win when the flag is on, sockets are used (and required)
    otherwise. Raises `ResourceError` (a readable message — see
    `resources.py`) rather than an `AttributeError` mid-sample when the flag
    is off and a required socket is missing.
    """
    sources = resources_mod.resolve_loader_resources(
        use_internal_loaders, model=model, clip=clip, vae=vae,
    )
    resolved_model = load_internal_model(unet_name) if sources["model"] == "internal" else model
    resolved_clip = load_internal_clip(clip_name, clip_type) if sources["clip"] == "internal" else clip
    resolved_vae = load_internal_vae(vae_name) if sources["vae"] == "internal" else vae
    return resolved_model, resolved_clip, resolved_vae


# ---------------------------------------------------------------------------
# LoRA application (§5b) — inline mode only; the socket path arrives with
# LoRAs already baked into MODEL/CLIP upstream of this node (design doc §5b).
# ---------------------------------------------------------------------------


def _resolve_lora_name(name: str) -> str:
    """Best-effort absolute->relative resolution against ComfyUI's `loras`
    folder, mirroring upstream's `_lora_stack_name`
    (`../ComfyUre-EasyUseAnima/easyuse_anima/lora/metadata.py:61-`, MIT ©
    n0va39). Falls back to the bare (stripped) name on any lookup failure —
    `LoraLoader` itself is the actual source of truth for whether a name
    resolves, so this is a best-effort convenience, not a validation gate.
    """
    value = str(name or "").strip()
    if not value:
        return value
    try:
        import os

        import folder_paths  # ComfyUI-only; lazy.

        absolute_value = os.path.abspath(value)
        for root in folder_paths.get_folder_paths("loras"):
            absolute_root = os.path.abspath(root)
            try:
                relative = os.path.relpath(absolute_value, absolute_root)
            except ValueError:
                continue
            if relative not in (".", "..") and not relative.startswith(f"..{os.sep}"):
                return relative
    except Exception:
        pass
    return value


def apply_lora_stack(model: Any, clip: Any, entries: List[Dict[str, Any]]) -> Tuple[Any, Any, List[Dict[str, Any]]]:
    """`loras.entries_to_apply(...)`'s already-filtered entries -> patched
    `(model, clip)` plus the list actually applied (for `metadata_json`).
    Applies in ORDER (§5b "order is application order"), each row through
    ComfyUI's own core `LoraLoader`.
    """
    entries = loras_mod.entries_to_apply(entries)
    if not entries:
        return model, clip, []

    loader_cls = _comfy_node("LoraLoader")
    loader = loader_cls()
    patched_model, patched_clip = model, clip
    applied: List[Dict[str, Any]] = []
    for entry in entries:
        name = _resolve_lora_name(entry["name"])
        result = loader.load_lora(
            patched_model, patched_clip, name,
            float(entry["strength_model"]), float(entry["strength_clip"]),
        )
        if not isinstance(result, tuple) or len(result) < 2:
            raise RuntimeError("[AnimaFlow] LoraLoader returned no MODEL/CLIP pair.")
        patched_model, patched_clip = result[0], result[1]
        applied.append(dict(entry))
    return patched_model, patched_clip, applied


# ---------------------------------------------------------------------------
# Model patches applied before the first pass — shift (always) and Mod
# Guidance (soft, §4).
# ---------------------------------------------------------------------------


def patch_shift(model: Any, shift: float) -> Any:
    """Anima's recommended `ModelSamplingAuraFlow` shift — always applied, a
    CORE ComfyUI node, not a dependency (design doc §8)."""
    return _output0(_comfy_node("ModelSamplingAuraFlow")().patch_aura(model, float(shift)))


def apply_mod_guidance(
    model: Any, clip: Any, positive: Any, negative: Any, mod_guidance_settings: Dict[str, Any],
) -> Any:
    """Spectrum's `AnimaModGuidance`, if enabled AND installed (design doc
    §4 — the one dependency this pack takes; absence disables this section,
    never a hard failure). Ported call shape from upstream's
    `_apply_spectrum_anima_mod_guidance`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/prompt/conditioning.py:85-138`),
    including its defensive old-vs-new `patch()` signature probe (some
    installed versions of `AnimaModGuidance.patch()` don't accept a separate
    `quality_neg` argument yet).
    """
    if not isinstance(mod_guidance_settings, dict) or not mod_guidance_settings.get("enabled"):
        return model
    patcher_cls = soft_imports.find_node_class("AnimaModGuidance")
    if patcher_cls is None:
        return model  # soft dependency absent -> section disabled, unchanged generation (§4).

    import inspect

    patcher = patcher_cls()
    patch = getattr(patcher, "patch", None)
    if patch is None:
        return model
    quality_tags = str(mod_guidance_settings.get("quality_tags") or "")
    quality_neg = str(mod_guidance_settings.get("quality_neg") or "")
    profile = str(mod_guidance_settings.get("profile") or "step_i8_skip27")

    parameters = list(inspect.signature(patch).parameters.values())
    positional_count = sum(
        1 for p in parameters
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    )
    accepts_quality_neg = (
        any(p.name in ("quality_neg", "quality_negative", "negative_quality_tags") for p in parameters)
        or any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in parameters)
        or positional_count >= 7
    )
    if accepts_quality_neg:
        result = patch(model, clip, quality_tags, quality_neg, profile, positive, negative)
    else:
        result = patch(model, clip, quality_tags, profile, positive, negative)
    return _output0(result)


# ---------------------------------------------------------------------------
# Sampling primitives
# ---------------------------------------------------------------------------


def run_ksampler(
    model: Any, positive: Any, negative: Any, latent: Dict[str, Any],
    *, seed: int, steps: int, cfg: float, sampler_name: str, scheduler: str, denoise: float,
) -> Dict[str, Any]:
    result = _comfy_node("KSampler")().sample(
        model, int(seed), int(steps), float(cfg), str(sampler_name), str(scheduler),
        positive, negative, latent, denoise=float(denoise),
    )
    return _output0(result)


def vae_decode(vae: Any, samples: Dict[str, Any]) -> Any:
    return _output0(_comfy_node("VAEDecode")().decode(vae, samples))


def vae_encode(vae: Any, image: Any) -> Dict[str, Any]:
    return _output0(_comfy_node("VAEEncode")().encode(vae, image))


def empty_latent(width: int, height: int, batch: int) -> Dict[str, Any]:
    return _output0(_comfy_node("EmptyLatentImage")().generate(int(width), int(height), int(batch)))


def latent_upscale_by(samples: Dict[str, Any], upscale_method: str, scale_by: float) -> Dict[str, Any]:
    return _output0(_comfy_node("LatentUpscaleBy")().upscale(samples, str(upscale_method), float(scale_by)))


def resize_image(image: Any, target_width: int, target_height: int, method: str = "bicubic") -> Any:
    """Postprocess's final downscale — ComfyUI's own `ImageScale` core node,
    same idea as upstream's `_resize_image_to_size_if_needed`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/postprocess.py:17-39`), just
    delegated to a core node instead of reimplementing the interpolate call.
    """
    result = _comfy_node("ImageScale")().upscale(
        image, str(method), int(target_width), int(target_height), "disabled",
    )
    return _output0(result)


# ---------------------------------------------------------------------------
# Stage 1 — first pass
# ---------------------------------------------------------------------------


def run_first_pass(
    *, model: Any, clip: Any, positive: Any, negative: Any, latent: Optional[Dict[str, Any]],
    settings: Dict[str, Any], wired_sampler: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """-> `(sampled_latent, resolved_sampler)`. The input latent is the
    socket's if wired (§5 "Size from the `latent` socket if wired, else
    `settings.latent`"), otherwise a fresh empty latent from
    `settings.latent`. `resolved_sampler` is returned so later stages'
    `inherit_sampler_settings` (§6b) has a base to inherit from.
    """
    resolved_sampler = resources_mod.resolve_sampler_inputs(settings.get("sampler", {}), wired_sampler)
    resolved_sampler = dict(resolved_sampler)
    seed = resolved_sampler.get("seed")
    if not isinstance(seed, int) or seed < 0:
        # VERIFY-IN-COMFYUI: -1 ("random") resolution -- ComfyUI's own
        # frontend normally resolves a random seed into a concrete int
        # BEFORE the prompt reaches the node (control_after_generate), so in
        # practice this node should never actually see -1. Falling back to 0
        # here rather than raising keeps a hand-edited API payload alive.
        seed = 0

    patched_model = patch_shift(model, settings.get("sampler", {}).get("shift", 3.0))
    patched_model = apply_mod_guidance(patched_model, clip, positive, negative, settings.get("mod_guidance", {}))

    latent_settings = settings.get("latent", {}) if isinstance(settings.get("latent"), dict) else {}
    resolved_latent = latent if latent is not None else empty_latent(
        latent_settings.get("width", 1024), latent_settings.get("height", 1024), latent_settings.get("batch", 1),
    )

    sampled = run_ksampler(
        patched_model, positive, negative, resolved_latent,
        seed=seed,
        steps=resolved_sampler.get("steps", 32),
        cfg=resolved_sampler.get("cfg", 5.0),
        sampler_name=resolved_sampler.get("sampler_name", "er_sde"),
        scheduler=resolved_sampler.get("scheduler", "simple"),
        denoise=resolved_sampler.get("denoise", 1.0),
    )
    return sampled, resolved_sampler


# ---------------------------------------------------------------------------
# Stage 2 — highres
# ---------------------------------------------------------------------------


def run_highres(
    *, model: Any, positive: Any, negative: Any, samples: Dict[str, Any],
    highres_settings: Dict[str, Any], base_sampler: Dict[str, Any],
) -> Dict[str, Any]:
    if not isinstance(highres_settings, dict) or not highres_settings.get("enabled"):
        return samples
    stage_sampler = sampler_mod.resolve_stage_sampler(highres_settings, base_sampler)
    upscaled = latent_upscale_by(
        samples, highres_settings.get("upscale_method", "bicubic"), highres_settings.get("scale_by", 1.5),
    )
    return run_ksampler(
        model, positive, negative, upscaled,
        seed=base_sampler.get("seed", 0),
        steps=stage_sampler.get("steps", 20),
        cfg=stage_sampler.get("cfg", 8.0),
        sampler_name=stage_sampler.get("sampler_name", "euler"),
        scheduler=stage_sampler.get("scheduler", "simple"),
        denoise=stage_sampler.get("denoise", 0.25),
    )


# ---------------------------------------------------------------------------
# Stage 3 — detailer (§6a: N blocks, detection internal, no SEGS sockets)
# ---------------------------------------------------------------------------


def _format_sam3_detection_prompt(detect_prompt: str, detect_count: int) -> str:
    """`"face, hands"` + count 2 -> `"face:2, hands:2"`; a part that already
    carries its own `:count` is left alone. Ported verbatim from upstream
    `_format_sam3_detection_prompt`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/image/sam3.py:127-138`)."""
    import re

    max_det = max(1, int(detect_count))
    parts = [part.strip() for part in re.split(r"[,\n]+", detect_prompt) if part.strip()]
    formatted = []
    for part in parts:
        if re.search(r":\s*[\d.]+\s*$", part):
            formatted.append(part)
        else:
            formatted.append(f"{part}:{max_det}")
    return ", ".join(formatted)


def _run_detailer_block(
    *, image: Any, model: Any, clip: Any, vae: Any, positive: Any, negative: Any,
    block: Dict[str, Any], base_sampler: Dict[str, Any], sam3_model: Any, sam3_clip: Any,
) -> Any:
    """One block's `SAM3_Detect -> MaskToSEGS -> DetailerForEach` chain
    (design doc §6a). Call shapes ported from upstream's internal adapters
    (`../ComfyUI-EasyUseAnima/easyuse_anima/nodes/sam3_nodes.py:255-284`,
    `impact_detailer_nodes.py:223-263`, MIT © n0va39): `SAM3_Detect.execute`
    takes a SAM3 MODEL + the target IMAGE + a CLIP-encoded text CONDITIONING
    (the block's own `detect_prompt`, formatted `"prompt:count"` per
    upstream's `_format_sam3_detection_prompt`), not a raw string.

    VERIFY-IN-COMFYUI: `comfy_extras.nodes_sam3.SAM3_Detect`'s exact
    `execute()` signature was not independently confirmed against a live
    ComfyUI build in this task — see the build report.
    """
    if not block.get("enabled"):
        return image

    detect_prompt = str(block.get("detect_prompt") or "").strip()
    detect_count = max(1, int(block.get("detect_count", 1) or 1))
    if not detect_prompt:
        return image  # nothing to detect for; inert rather than an error.
    formatted_prompt = _format_sam3_detection_prompt(detect_prompt, detect_count)

    tokens = sam3_clip.tokenize(formatted_prompt)
    conditioning, pooled = sam3_clip.encode_from_tokens(tokens, return_pooled=True)
    conditioning = [[conditioning, {"pooled_output": pooled}]]

    sam3_cls = soft_imports.find_sam3_detect_class()
    if sam3_cls is None:
        return image  # built-in absent (old ComfyUI) -> inert, not an error.
    mask = _output0(sam3_cls().execute(
        model=sam3_model, image=image, conditioning=conditioning,
        threshold=float(block.get("threshold", 0.5)),
        refine_iterations=int(block.get("refine_iterations", 2)),
        individual_masks=bool(block.get("individual_masks", True)),
    ))

    mask_to_segs_cls = soft_imports.find_node_class("MaskToSEGS")
    if mask_to_segs_cls is None:
        return image  # Impact absent -> inert (§11).
    segs = _output0(mask_to_segs_cls().doit(
        mask, bool(block.get("combined", False)), float(block.get("crop_factor", 4.0)),
        bool(block.get("bbox_fill", False)), int(block.get("drop_size", 100)),
        bool(block.get("contour_fill", True)),
    ))
    if not segs or not segs[1]:
        return image  # nothing detected -> pass through, not an error.

    detailer_cls = soft_imports.find_node_class("DetailerForEach")
    if detailer_cls is None:
        return image  # Impact absent -> inert (§11).

    stage_sampler = sampler_mod.resolve_stage_sampler(block, base_sampler)
    kwargs: Dict[str, Any] = dict(
        image=image, segs=segs, model=model, clip=clip, vae=vae,
        guide_size=float(block.get("guide_size", 1024)),
        guide_size_for=bool(block.get("guide_size_for", False)),
        max_size=float(block.get("max_size", 2048)),
        seed=base_sampler.get("seed", 0),
        steps=stage_sampler.get("steps", 20),
        cfg=stage_sampler.get("cfg", 8.0),
        sampler_name=stage_sampler.get("sampler_name", "euler"),
        scheduler=stage_sampler.get("scheduler", "sgm_uniform"),
        positive=positive, negative=negative,
        denoise=stage_sampler.get("denoise", 0.33),
        feather=int(block.get("feather", 5)),
        noise_mask=bool(block.get("noise_mask", True)),
        force_inpaint=bool(block.get("force_inpaint", True)),
        wildcard=str(block.get("wildcard") or ""),
        cycle=int(block.get("cycle", 1)),
        inpaint_model=bool(block.get("inpaint_model", False)),
        noise_mask_feather=int(block.get("noise_mask_feather", 10)),
        tiled_encode=bool(block.get("tiled_encode", False)),
        tiled_decode=bool(block.get("tiled_decode", False)),
    )
    # Defensive kwargs-filtering to whatever this Impact version's `doit`
    # actually accepts — same technique upstream's own `_call_impact_detailer`
    # uses (`../ComfyUI-EasyUseAnima/easyuse_anima/image/sam3.py:174-183`),
    # since Impact's exact parameter set has drifted across releases.
    import inspect

    detailer = detailer_cls()
    method = getattr(detailer, "doit")
    signature = inspect.signature(method)
    accepts_var_kwargs = any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in signature.parameters.values()
    )
    call_kwargs = kwargs if accepts_var_kwargs else {
        key: value for key, value in kwargs.items() if key in signature.parameters
    }
    result = method(**call_kwargs)
    if isinstance(result, dict) and isinstance(result.get("result"), tuple) and result["result"]:
        return result["result"][0]
    if isinstance(result, tuple) and result:
        return result[0]
    raise RuntimeError("[AnimaFlow] Impact DetailerForEach returned no image.")


def run_detailer(
    *, image: Any, model: Any, clip: Any, vae: Any, positive: Any, negative: Any,
    detailer_settings: Dict[str, Any], base_sampler: Dict[str, Any],
) -> Any:
    """§6a: every enabled block runs in `order`, each detecting for itself.
    Loading a dedicated SAM3 checkpoint (model+CLIP) mirrors upstream's own
    `ctx_SAM3` (design doc gap — see build report: neither §5's input table
    nor §8's settings example says where the SAM3 model comes from; this
    borrows upstream's `sam3.checkpoint` default,
    `generation_defaults.py:288-291`).
    """
    have_impact = soft_imports.has_impact_detailer()
    blocks = detailer_settings.get("blocks") if isinstance(detailer_settings, dict) else None
    live = stages_mod.detailer_is_live(
        detailer_enabled=bool(detailer_settings.get("enabled")) if isinstance(detailer_settings, dict) else False,
        have_impact=have_impact, blocks=blocks,
    )
    if not live:
        return image

    sam3_settings = detailer_settings.get("sam3") if isinstance(detailer_settings.get("sam3"), dict) else {}
    checkpoint_name = str(sam3_settings.get("checkpoint") or "sam3.1_multiplex_fp16.safetensors")
    sam3_model, sam3_clip, _sam3_vae = _output0_multi(
        _comfy_node("CheckpointLoaderSimple")().load_checkpoint(checkpoint_name)
    )

    order = detailer_settings.get("order") if isinstance(detailer_settings.get("order"), list) else list(blocks)
    result = image
    for block_id in order:
        block = blocks.get(block_id) if isinstance(blocks, dict) else None
        if not isinstance(block, dict):
            continue
        result = _run_detailer_block(
            image=result, model=model, clip=clip, vae=vae, positive=positive, negative=negative,
            block=block, base_sampler=base_sampler, sam3_model=sam3_model, sam3_clip=sam3_clip,
        )
    return result


def _output0_multi(result: Any) -> Tuple[Any, Any, Any]:
    if not isinstance(result, tuple) or len(result) < 3:
        raise RuntimeError("[AnimaFlow] CheckpointLoaderSimple returned fewer than 3 outputs.")
    return result[0], result[1], result[2]


# ---------------------------------------------------------------------------
# Stage 4 — upscale (USDU only, §4/§6)
# ---------------------------------------------------------------------------


def run_upscale(
    *, image: Any, model: Any, clip: Any, vae: Any, positive: Any, negative: Any,
    upscale_settings: Dict[str, Any], base_sampler: Dict[str, Any],
) -> Any:
    if not isinstance(upscale_settings, dict) or not upscale_settings.get("enabled"):
        return image
    usdu_cls = soft_imports.find_node_class("UltimateSDUpscale")
    if usdu_cls is None:
        return image  # soft dependency absent -> inert, not an error (§4/§11).

    usdu_settings = upscale_settings.get("usdu") if isinstance(upscale_settings.get("usdu"), dict) else {}
    width, height = _image_size(image)
    tile_plan = usdu_mod.plan_usdu_tiles(width, height, upscale_settings.get("scale_by", 2.0), usdu_settings)
    stage_sampler = sampler_mod.resolve_stage_sampler(upscale_settings, base_sampler)

    upscale_model_cls = soft_imports.find_node_class("UpscaleModelLoader") or _comfy_node("UpscaleModelLoader")
    upscale_model = _output0(upscale_model_cls().load_model(
        str(usdu_settings.get("upscale_model_name") or "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors")
    ))

    result = usdu_cls().upscale(
        image=image, model=model, positive=positive, negative=negative, vae=vae,
        upscale_by=float(upscale_settings.get("scale_by", 2.0)),
        seed=base_sampler.get("seed", 0),
        steps=stage_sampler.get("steps", 20),
        cfg=stage_sampler.get("cfg", 8.0),
        sampler_name=stage_sampler.get("sampler_name", "euler"),
        scheduler=stage_sampler.get("scheduler", "simple"),
        denoise=stage_sampler.get("denoise", 0.2),
        upscale_model=upscale_model,
        mode_type=str(usdu_settings.get("mode_type") or "Linear"),
        tile_width=tile_plan["tile_width"], tile_height=tile_plan["tile_height"],
        mask_blur=int(usdu_settings.get("mask_blur", 8)),
        tile_padding=int(usdu_settings.get("tile_padding", 32)),
        seam_fix_mode=str(usdu_settings.get("seam_fix_mode") or "None"),
        seam_fix_denoise=float(usdu_settings.get("seam_fix_denoise", 1.0)),
        seam_fix_mask_blur=int(usdu_settings.get("seam_fix_mask_blur", 8)),
        seam_fix_width=int(usdu_settings.get("seam_fix_width", 64)),
        seam_fix_padding=int(usdu_settings.get("seam_fix_padding", 16)),
        force_uniform_tiles=bool(usdu_settings.get("force_uniform_tiles", True)),
        # `tiled_decode` is an UNRELATED VAE flag, NOT tile order (§6a) — kept
        # spelled out here rather than folded into `tile_plan` so the two
        # never look coupled by accident.
        tiled_decode=bool(usdu_settings.get("tiled_decode", False)),
        batch_size=int(usdu_settings.get("batch_size", 1)),
    )
    return _output0(result)


# ---------------------------------------------------------------------------
# Stage 5 — postprocess (fit cap only, §6 step 5, §9)
# ---------------------------------------------------------------------------


def run_postprocess(image: Any, postprocess_settings: Dict[str, Any]) -> Tuple[Any, Dict[str, Any]]:
    width, height = _image_size(image)
    metadata = postprocess_mod.run_postprocess(width, height, postprocess_settings)
    if not metadata["applied"]:
        return image, metadata
    fit_settings = postprocess_settings.get("fit", {}) if isinstance(postprocess_settings, dict) else {}
    resized = resize_image(
        image, metadata["target_width"], metadata["target_height"],
        str(fit_settings.get("method") or "bicubic") if isinstance(fit_settings, dict) else "bicubic",
    )
    return resized, metadata


# ---------------------------------------------------------------------------
# Top-level orchestration — what `nodes/anima/generator.py` actually calls.
# ---------------------------------------------------------------------------


def run_generator(
    *,
    positive: Any,
    negative: Any,
    generation_settings: str,
    use_internal_loaders: bool,
    unet_name: str,
    clip_name: str,
    clip_type: str,
    vae_name: str,
    model: Any = None,
    clip: Any = None,
    vae: Any = None,
    latent: Optional[Dict[str, Any]] = None,
    seed: Optional[int] = None,
    steps: Optional[int] = None,
    cfg: Optional[float] = None,
    sampler_name: Optional[str] = None,
    scheduler: Optional[str] = None,
) -> Tuple[Any, Any, Any, Dict[str, Any], str]:
    """The whole pipeline, front to back: resources -> inline LoRAs -> first
    pass -> highres -> detailer -> upscale -> postprocess. -> `(image,
    image_base, image_mid, latent, metadata_json)`, the Generator's exact
    fixed output set (design doc §5 Outputs).

    Detailer and upscale both operate in PIXEL space (Impact's
    `DetailerForEach` and USDU both take/return `IMAGE`, matching upstream),
    so the `latent` output — "final latent" — necessarily means the last
    real diffusion latent this run produced, i.e. the HIGHRES stage's latent
    (or the first pass's, if highres is off). Neither design-doc §5's output
    table nor §8 says explicitly which stage's latent "final" means once
    detailer/upscale/postprocess have pushed the pipeline into pixel space
    after it — flagged in the build report as an assumption, not a
    documented decision.
    """
    settings = settings_mod.normalize_generation_settings(generation_settings)

    resolved_model, resolved_clip, resolved_vae = resolve_resources(
        use_internal_loaders=use_internal_loaders,
        unet_name=unet_name, clip_name=clip_name, clip_type=clip_type, vae_name=vae_name,
        model=model, clip=clip, vae=vae,
    )

    applied_loras: List[Dict[str, Any]] = []
    if use_internal_loaders:
        # Inline mode is the only mode that needs an inline LoRA list — the
        # socket path arrives with LoRAs already baked into MODEL/CLIP
        # upstream of this node (design doc §5b).
        entries = loras_mod.normalize_lora_stack(settings.get("loras"))
        resolved_model, resolved_clip, applied_loras = apply_lora_stack(resolved_model, resolved_clip, entries)

    wired_sampler = {
        "seed": seed, "steps": steps, "cfg": cfg,
        "sampler_name": sampler_name, "scheduler": scheduler,
    }
    base_latent, resolved_sampler = run_first_pass(
        model=resolved_model, clip=resolved_clip, positive=positive, negative=negative,
        latent=latent, settings=settings, wired_sampler=wired_sampler,
    )
    image_base = vae_decode(resolved_vae, base_latent)

    highres_settings = settings.get("highres", {})
    highres_latent = run_highres(
        model=resolved_model, positive=positive, negative=negative, samples=base_latent,
        highres_settings=highres_settings, base_sampler=resolved_sampler,
    )
    image_after_highres = (
        vae_decode(resolved_vae, highres_latent) if highres_settings.get("enabled") else image_base
    )
    final_latent = highres_latent

    have_impact = soft_imports.has_impact_detailer()
    detailer_settings = settings.get("detailer", {})
    outputs = stages_mod.resolve_outputs(
        highres_enabled=bool(highres_settings.get("enabled")),
        detailer_enabled=bool(detailer_settings.get("enabled")),
        have_impact=have_impact,
        blocks=detailer_settings.get("blocks"),
        upscale_enabled=bool(settings.get("upscale", {}).get("enabled")),
        have_usdu=soft_imports.has_usdu(),
    )

    image_after_detailer = run_detailer(
        image=image_after_highres, model=resolved_model, clip=resolved_clip, vae=resolved_vae,
        positive=positive, negative=negative, detailer_settings=detailer_settings,
        base_sampler=resolved_sampler,
    )
    image_mid = image_after_detailer  # design doc §5: "after detailer, before upscale"

    image_after_upscale = run_upscale(
        image=image_after_detailer, model=resolved_model, clip=resolved_clip, vae=resolved_vae,
        positive=positive, negative=negative, upscale_settings=settings.get("upscale", {}),
        base_sampler=resolved_sampler,
    )

    final_image, postprocess_metadata = run_postprocess(image_after_upscale, settings.get("postprocess", {}))

    metadata = {
        "schema": settings.get("schema"),
        "version": settings.get("version"),
        "resources": {
            "use_internal_loaders": bool(use_internal_loaders),
        },
        "loras": applied_loras,
        "sampler": resolved_sampler,
        "stages": outputs,
        "postprocess": postprocess_metadata,
    }
    return final_image, image_base, image_mid, final_latent, json.dumps(metadata)


__all__ = (
    "resolve_resources", "apply_lora_stack", "patch_shift", "apply_mod_guidance",
    "run_ksampler", "vae_decode", "vae_encode", "empty_latent", "latent_upscale_by",
    "resize_image", "run_first_pass", "run_highres", "run_detailer", "run_upscale",
    "run_postprocess", "run_generator", "ResourceError",
)
