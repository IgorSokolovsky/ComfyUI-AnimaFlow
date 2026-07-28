"""Thin adapter layer over `src/anima`'s pure helpers (design doc §5-§6):
first pass -> highres -> detailer -> upscale -> postprocess. Every DECISION
(which stage runs, what its resolved sampler/tile/fit values are, which real
pass each output names) is made by a pure function in `settings.py`/
`stages.py`/`sampler.py`/`resources.py`/`context.py`/`postprocess.py`/
`usdu.py`; this module ONLY calls ComfyUI/torch/third-party node classes
with the results, per this task's brief ("every comfy/torch touch is lazy
and looked up, never a top-level import").

**2026-07-28 reversal**: resource loading (§3's `use_internal_loaders` +
internal unet/clip/vae pickers) and the inline LoRA stack (§5b's
`generation_settings.loras`) are BOTH gone. `AnimaGenerator` now takes
exactly one input — a wired `ANIMA_CONTEXT` from `AnimaContextBridge` — that
already carries real MODEL/CLIP/VAE objects (LoRAs baked in upstream of the
bridge, same as they always were upstream of the Generator's own sockets;
see `context_bridge.py`'s own docstring). `src/anima/loras.py` is
consequently dead code with no caller left in this file at all — kept
in place, unedited, per this task's own instruction, since deleting a pure
module that still round-trips correctly is out of this task's scope.

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

from . import context as context_mod
from . import model_files as model_files_mod
from . import node_result as node_result_mod
from . import postprocess as postprocess_mod
from . import resources as resources_mod
from . import sampler as sampler_mod
from . import settings as settings_mod
from . import soft_imports
from . import stages as stages_mod
from . import usdu as usdu_mod

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


def _unrecognized_shape_error(node_name: str, method_name: str, unrecognized_type: str) -> RuntimeError:
    return RuntimeError(
        f"[AnimaFlow] {node_name}.{method_name}() returned a result shape "
        f"this pack doesn't recognise ({unrecognized_type}). Expected a "
        f"tuple/list of outputs (ComfyUI's V2 node shape), an object with a "
        f"'.result' tuple (the V3 NodeOutput shape), or a "
        f"{{'ui': ..., 'result': (...)}} dict — got a bare {unrecognized_type} "
        f"instead. This usually means {node_name}'s call signature or return "
        f"shape has changed upstream."
    )


def _output0(result: Any, *, node_name: str = "a ComfyUI node", method_name: str = "call") -> Any:
    """Every CORE ComfyUI node call's first output — tolerant of ComfyUI's
    three legal return shapes (V2 tuple/list, V3 `NodeOutput`-with-`.result`,
    or a `{"ui": ..., "result": ...}` dict; see `node_result.
    normalize_node_result`, the pure function that tells them apart, for why
    this exists at all: ComfyUI 0.28.3's `execution.py` gained `v3_data`
    support, and `comfy_extras.nodes_sam3.SAM3_Detect`'s `execute()` returns
    the V3 shape, not the bare tuple this function used to require).

    Two DISTINCT readable errors instead of one shared "returned no
    outputs" message, both naming `node_name`/`method_name`:

    - a RECOGNISED shape whose outputs are genuinely EMPTY (e.g. a detector
      that found nothing this run);
    - an UNRECOGNISED shape entirely — names `type(result).__name__` too, so
      the next person sees e.g. `NodeOutput` in the message instead of
      guessing at ComfyUI's internals.

    `node_name`/`method_name` default to a generic phrase so this stays
    backward compatible for any future call site that doesn't pass real
    context — every call site in this file DOES pass its own, though.
    """
    normalized = node_result_mod.normalize_node_result(result)
    if normalized.unrecognized_type is not None:
        raise _unrecognized_shape_error(node_name, method_name, normalized.unrecognized_type)
    if not normalized.outputs:
        raise RuntimeError(f"[AnimaFlow] {node_name}.{method_name}() returned no outputs.")
    return normalized.outputs[0]


def _image_size(image: Any) -> Tuple[int, int]:
    """An `IMAGE` tensor's `(width, height)` — ComfyUI's own layout is
    `[batch, height, width, channels]`."""
    return int(image.shape[2]), int(image.shape[1])


def _lookup_filename_list(folder_name: str) -> Optional[List[str]]:
    """ComfyUI's own installed-file listing for `folder_name`
    (`folder_paths.get_filename_list`), or `None` if it can't be obtained at
    all — no `folder_paths` module (a bare unit-test environment with no
    ComfyUI installed) or the call itself raising both degrade to `None`
    rather than guessing (`model_files.find_missing_model_files`'s own
    contract: `None` SKIPS that folder's check entirely — never block a run
    because we couldn't enumerate)."""
    try:
        import folder_paths  # ComfyUI's own; lazy -- see module docstring.

        return folder_paths.get_filename_list(folder_name)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Model patches applied before the first pass — shift (always) and Mod
# Guidance (soft, §4).
# ---------------------------------------------------------------------------


def patch_shift(model: Any, shift: float) -> Any:
    """Anima's recommended `ModelSamplingAuraFlow` shift — always applied, a
    CORE ComfyUI node, not a dependency (design doc §8)."""
    return _output0(
        _comfy_node("ModelSamplingAuraFlow")().patch_aura(model, float(shift)),
        node_name="ModelSamplingAuraFlow", method_name="patch_aura",
    )


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
    return _output0(result, node_name="AnimaModGuidance", method_name="patch")


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
    return _output0(result, node_name="KSampler", method_name="sample")


def vae_decode(vae: Any, samples: Dict[str, Any]) -> Any:
    return _output0(
        _comfy_node("VAEDecode")().decode(vae, samples),
        node_name="VAEDecode", method_name="decode",
    )


def vae_encode(vae: Any, image: Any) -> Dict[str, Any]:
    return _output0(
        _comfy_node("VAEEncode")().encode(vae, image),
        node_name="VAEEncode", method_name="encode",
    )


def empty_latent(width: int, height: int, batch: int) -> Dict[str, Any]:
    return _output0(
        _comfy_node("EmptyLatentImage")().generate(int(width), int(height), int(batch)),
        node_name="EmptyLatentImage", method_name="generate",
    )


def latent_upscale_by(samples: Dict[str, Any], upscale_method: str, scale_by: float) -> Dict[str, Any]:
    return _output0(
        _comfy_node("LatentUpscaleBy")().upscale(samples, str(upscale_method), float(scale_by)),
        node_name="LatentUpscaleBy", method_name="upscale",
    )


def resize_image(image: Any, target_width: int, target_height: int, method: str = "bicubic") -> Any:
    """Postprocess's final downscale — ComfyUI's own `ImageScale` core node,
    same idea as upstream's `_resize_image_to_size_if_needed`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/postprocess.py:17-39`), just
    delegated to a core node instead of reimplementing the interpolate call.
    """
    result = _comfy_node("ImageScale")().upscale(
        image, str(method), int(target_width), int(target_height), "disabled",
    )
    return _output0(result, node_name="ImageScale", method_name="upscale")


# ---------------------------------------------------------------------------
# Stage 1 — first pass
# ---------------------------------------------------------------------------

# The fallback latent size when the context's `latent` socket is unwired
# (2026-07-28 reversal: `generation_settings.latent` is GONE — see
# `settings.py`'s own dated note — so there is no settings block left to
# read a fallback size from). A fixed default, not a readable error, because
# EVERY `ANIMA_CONTEXT` field is optional by design
# (`context_bridge.py`'s own docstring: "an unwired socket simply
# contributes nothing") — an unwired latent must degrade the same
# predictable way every other unwired context field does, not become the
# one field that hard-fails a run. 1024x1024, batch 1 matches the just-
# removed `generation_settings.latent` block's own defaults, so a workflow
# that never wired `latent` at all keeps behaving exactly like it used to.
_DEFAULT_LATENT_WIDTH = 1024
_DEFAULT_LATENT_HEIGHT = 1024
_DEFAULT_LATENT_BATCH = 1


def run_first_pass(
    *, model: Any, clip: Any, positive: Any, negative: Any, latent: Optional[Dict[str, Any]],
    settings: Dict[str, Any], wired_sampler: Optional[Dict[str, Any]],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """-> `(sampled_latent, resolved_sampler)`. The input latent is the
    context's `latent` field if supplied, otherwise a fresh empty latent at
    the fixed default size above (see that constant block's own comment for
    why a default beats an error here). `resolved_sampler` is returned so
    later stages' `inherit_sampler_settings` (§6b) has a base to inherit
    from.
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

    resolved_latent = latent if latent is not None else empty_latent(
        _DEFAULT_LATENT_WIDTH, _DEFAULT_LATENT_HEIGHT, _DEFAULT_LATENT_BATCH,
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

    CONFIRMED against a live ComfyUI 0.28.3 build (2026-07-28): the SAM3
    checkpoint loads fine and `SAM3_Detect.execute()` IS reached with these
    kwargs — the only thing that was ever actually wrong was this file's own
    result-unwrapping, not the call shape above. `execute()` is a live
    reproduction of exactly the failure `node_result.normalize_node_result`
    exists to fix: 0.28.3's `execution.py` carries `v3_data`, i.e. it
    supports the V3 node schema, and `SAM3_Detect` being a recent built-in
    is very likely V3 — its `execute()` returning a `comfy_api`/`io.
    NodeOutput` (outputs on `.result`, not the return value itself) rather
    than a bare tuple is the working hypothesis for why the old
    `isinstance(result, tuple)` check in `_output0` rejected it. That
    hypothesis is exactly what `_output0` now handles either way — V2 tuple
    or V3 `NodeOutput` — via `node_result.normalize_node_result`, so this call
    site needs no further change regardless of which shape `SAM3_Detect`
    actually returns on a given build.
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
    mask = _output0(
        sam3_cls().execute(
            model=sam3_model, image=image, conditioning=conditioning,
            threshold=float(block.get("threshold", 0.5)),
            refine_iterations=int(block.get("refine_iterations", 2)),
            individual_masks=bool(block.get("individual_masks", True)),
        ),
        node_name="SAM3_Detect", method_name="execute",
    )

    mask_to_segs_cls = soft_imports.find_node_class("MaskToSEGS")
    if mask_to_segs_cls is None:
        return image  # Impact absent -> inert (§11).
    segs = _output0(
        mask_to_segs_cls().doit(
            mask, bool(block.get("combined", False)), float(block.get("crop_factor", 4.0)),
            bool(block.get("bbox_fill", False)), int(block.get("drop_size", 100)),
            bool(block.get("contour_fill", True)),
        ),
        node_name="MaskToSEGS", method_name="doit",
    )
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
    return _output0(result, node_name="DetailerForEach", method_name="doit")


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
        _comfy_node("CheckpointLoaderSimple")().load_checkpoint(checkpoint_name),
        node_name="CheckpointLoaderSimple", method_name="load_checkpoint",
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


def _output0_multi(
    result: Any, *, node_name: str = "a ComfyUI node", method_name: str = "call",
) -> Tuple[Any, Any, Any]:
    """Like `_output0`, but for `CheckpointLoaderSimple.load_checkpoint`'s
    MODEL/CLIP/VAE triple — the pipeline's only three-output-needed core
    call. Same shape-normalization + two distinct readable errors as
    `_output0` (see its own docstring): an unrecognised shape names
    `type(result).__name__`; a recognised-but-short one names how many
    outputs actually came back."""
    normalized = node_result_mod.normalize_node_result(result)
    if normalized.unrecognized_type is not None:
        raise _unrecognized_shape_error(node_name, method_name, normalized.unrecognized_type)
    outputs = normalized.outputs
    got = 0 if outputs is None else len(outputs)
    if outputs is None or got < 3:
        raise RuntimeError(
            f"[AnimaFlow] {node_name}.{method_name}() returned {got} output(s), "
            f"fewer than the 3 (MODEL, CLIP, VAE) required."
        )
    return outputs[0], outputs[1], outputs[2]


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
    upscale_model = _output0(
        upscale_model_cls().load_model(
            str(usdu_settings.get("upscale_model_name") or "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors")
        ),
        node_name="UpscaleModelLoader", method_name="load_model",
    )

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
    return _output0(result, node_name="UltimateSDUpscale", method_name="upscale")


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


def run_generator(*, context: Dict[str, Any], generation_settings: str) -> Tuple[List[Any], Dict[str, Any], str]:
    """The whole pipeline, front to back: first pass -> highres -> detailer
    -> upscale -> postprocess, EVERY resource (MODEL/CLIP/VAE/CONDITIONING/
    LATENT/sampler scalars) read from the single wired `ANIMA_CONTEXT`
    (2026-07-28 reversal — see this module's own docstring and
    `context.py`). -> `(images, latent, metadata_json)`:

      - `images`: a Python LIST of `IMAGE` tensors, ordered `base, mid,
        final`, one per stage that actually produced a DISTINCT image this
        run — a stage that didn't run (or didn't change anything) is
        OMITTED, never duplicated (design doc §5/§6 reversal — the old
        "pass the previous stage's tensor through" rule existed only to
        fill three now-deleted fixed sockets). This is the Generator's
        `OUTPUT_IS_LIST[0] = True` slot.
      - `latent`: the final latent this run produced. Detailer and upscale
        both operate in PIXEL space (Impact's `DetailerForEach` and USDU
        both take/return `IMAGE`, matching upstream), so this necessarily
        means the last real diffusion latent, i.e. the highres stage's
        latent (or the first pass's, if highres is off) — flagged in the
        original build report as an assumption, not a documented decision,
        and unaffected by this task.
      - `metadata_json`: per-stage metadata for debugging, INCLUDING
        `stage_labels` — the ordered list of labels naming what each
        position in `images` actually is. This is now the ONLY way anything
        downstream (chiefly `AnimaPreview`) can tell the positions apart,
        since the list itself carries no labels of its own.

    Every context field this pipeline cannot run without
    (`model`/`clip`/`vae`/`positive`/`negative`) is read via
    `context.require_context_value`, which raises a readable
    `ContextFieldMissing` — never an `AttributeError` mid-sample — naming
    exactly which `AnimaContextBridge` socket needs wiring. `clip` is
    required unconditionally even though only Mod Guidance and a live
    detailer pass actually consume it: requiring it up front keeps the
    missing-context error surface small and predictable, and a text-to-
    image graph with no CLIP encoder wired anywhere upstream is already a
    broken graph regardless of which stages happen to be enabled.
    """
    settings = settings_mod.normalize_generation_settings(generation_settings)

    # Model-file pre-flight (readable error instead of a `FileNotFoundError`
    # seven frames deep mid-sample) — needs `detailer_live`/`upscale_live`
    # computed BEFORE the first pass even runs, so a missing SAM3 checkpoint
    # or upscale model surfaces before any real sampling happens, not after
    # a (possibly expensive) first pass/highres/detailer has already run.
    # `have_impact`/`have_usdu`/`detailer_settings`/`upscale_settings`/
    # `detailer_live`/`upscale_live` computed here are reused UNCHANGED at
    # their original call sites further down — nothing here is recomputed.
    have_impact = soft_imports.has_impact_detailer()
    detailer_settings = settings.get("detailer", {})
    detailer_live = stages_mod.detailer_is_live(
        detailer_enabled=bool(detailer_settings.get("enabled")),
        have_impact=have_impact, blocks=detailer_settings.get("blocks"),
    )
    upscale_settings = settings.get("upscale", {})
    have_usdu = soft_imports.has_usdu()
    upscale_live = bool(upscale_settings.get("enabled")) and have_usdu
    model_files_mod.raise_if_missing(model_files_mod.find_missing_model_files(
        detailer_settings=detailer_settings, detailer_live=detailer_live,
        upscale_settings=upscale_settings, upscale_live=upscale_live,
        checkpoint_files=_lookup_filename_list("checkpoints"),
        upscale_model_files=_lookup_filename_list("upscale_models"),
    ))

    model = context_mod.require_context_value(context, "model")
    clip = context_mod.require_context_value(context, "clip")
    vae = context_mod.require_context_value(context, "vae")
    positive = context_mod.require_context_value(context, "positive")
    negative = context_mod.require_context_value(context, "negative")
    # `latent` and the five sampler fields are genuinely OPTIONAL context
    # fields (design doc §1: "nothing is required") — an absent one falls
    # back to `generation_settings`/a fixed default rather than erroring;
    # see `run_first_pass`'s own default-latent comment.
    latent = context_mod.context_value(context, "latent")
    wired_sampler = {
        field: context_mod.context_value(context, field)
        for field in resources_mod.SAMPLER_FIELDS
    }

    base_latent, resolved_sampler = run_first_pass(
        model=model, clip=clip, positive=positive, negative=negative,
        latent=latent, settings=settings, wired_sampler=wired_sampler,
    )
    image_base = vae_decode(vae, base_latent)

    highres_settings = settings.get("highres", {})
    highres_enabled = bool(highres_settings.get("enabled"))
    highres_latent = run_highres(
        model=model, positive=positive, negative=negative, samples=base_latent,
        highres_settings=highres_settings, base_sampler=resolved_sampler,
    )
    image_after_highres = vae_decode(vae, highres_latent) if highres_enabled else image_base
    final_latent = highres_latent

    # `have_impact`/`detailer_settings`/`detailer_live` and
    # `upscale_settings`/`have_usdu`/`upscale_live` were already computed
    # above (before the model-file pre-flight check) — reused unchanged here.
    image_after_detailer = run_detailer(
        image=image_after_highres, model=model, clip=clip, vae=vae,
        positive=positive, negative=negative, detailer_settings=detailer_settings,
        base_sampler=resolved_sampler,
    )
    image_mid = image_after_detailer  # design doc §5: "after detailer, before upscale"

    image_after_upscale = run_upscale(
        image=image_after_detailer, model=model, clip=clip, vae=vae,
        positive=positive, negative=negative, upscale_settings=upscale_settings,
        base_sampler=resolved_sampler,
    )

    final_image, postprocess_metadata = run_postprocess(image_after_upscale, settings.get("postprocess", {}))

    stage_labels = stages_mod.resolve_stage_labels(
        highres_enabled=highres_enabled, detailer_live=detailer_live,
        upscale_live=upscale_live, postprocess_applied=bool(postprocess_metadata["applied"]),
    )
    stage_tensors = {
        stages_mod.STAGE_BASE: image_base,
        stages_mod.STAGE_MID: image_mid,
        stages_mod.STAGE_FINAL: final_image,
    }
    images = [stage_tensors[label] for label in stage_labels]

    metadata = {
        "schema": settings.get("schema"),
        "version": settings.get("version"),
        "sampler": resolved_sampler,
        # The single source of truth for "which position in `images` is
        # which stage" — `AnimaPreview` reads THIS list back rather than
        # re-deriving it (task brief: "keep the label mapping in exactly
        # one pure place").
        "stage_labels": stage_labels,
        "stages": {
            "highres_enabled": highres_enabled,
            "detailer_live": detailer_live,
            "upscale_live": upscale_live,
        },
        "postprocess": postprocess_metadata,
    }
    return images, final_latent, json.dumps(metadata)


__all__ = (
    "patch_shift", "apply_mod_guidance",
    "run_ksampler", "vae_decode", "vae_encode", "empty_latent", "latent_upscale_by",
    "resize_image", "run_first_pass", "run_highres", "run_detailer", "run_upscale",
    "run_postprocess", "run_generator",
)
