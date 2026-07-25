"""Pipeline-stage logic for `AnimaGenerator`: conditioning-pane resolution,
LoRA-stack application, first-pass sampling, optional highres, optional
detailer/upscale/postprocess-resize/save, and metadata assembly.

SCOPE: first pass + highres shipped in the prior build; this build adds the
detailer stage (soft-depends on Impact Pack's `DetailerForEach`, takes a
generic `SEGS` detection input rather than being tied to one detector), the
upscale stage (soft-depends on EITHER ComfyUI_UltimateSDUpscale's
`UltimateSDUpscale` OR ComfyUI-Distilled-ResShift's
`ResShiftLoader`/`ResShiftUpscale`, user's choice via `upscale_backend`), a
lightweight postprocess-resize pass (reuses `compute_scale_by_multiple` - no
separate resize math), and an optional save via core's own `SaveImage`.
Deliberately NOT ported: the reference pack's full AiO JSON settings-profile
system and its much larger per-stage settings surface
(spectrum/mod-guidance/wildcard/DiT-corrections/etc.) - see the plan's
"Explicitly OUT of scope" section; only the minimal set of controls
structurally required to call each external node is exposed as a widget,
everything else is a fixed, documented constant. See the reference pack's
`generation_detailer*.py` / `generation_upscale_stage.py` /
`generation_postprocess_stage.py` / `generation_save_output_stage.py`
(`../ComfyUI-EasyUseAnima/easyuse_anima/aio/`) plus
`../ComfyUI-EasyUseAnima/easyuse_anima/image/sam3.py` and
`.../nodes/impact_detailer_nodes.py` (the exact Impact `DetailerForEach.doit()`
call shape) for what was read to derive this build's simplified versions.

Pure logic (`resolve_pane_conditioning`, `normalize_lora_stack`,
`build_metadata`, the sampler/scheduler name lookups, `INPUT_TYPES`'s own
shape) needs no torch/comfy import and is fully unit-tested in
`test_anima_generator_helpers.py`. Everything that touches an actual
tensor or a live ComfyUI core node (`build_empty_latent`, `apply_lora_stack`,
`sample_latent`, `decode_latent`, `encode_image_to_latent`,
`run_highres_pass`, and the new `run_detailer_stage`/`run_upscale_stage`/
`run_postprocess_resize`/`run_save_output_stage`) lazily imports what it
needs / goes through `_comfy_core_bridge.require_core_node_class` (core
nodes: `SaveImage`, `UpscaleModelLoader` - both ship with ComfyUI itself) or
`_optional_pack_bridge.require_optional_node_class` (external packs:
Impact Pack, USDU, ResShift - each a separately-installed custom-node pack)
inside the function body - never at module import time - exactly like
`_anima_image_scale_helpers`'s own `comfy.utils` usage, so this module
itself stays importable (and its pure functions testable) outside a live
ComfyUI process.
"""

from __future__ import annotations

import inspect
import json
import logging
from typing import Any

from ._anima_conditioning_helpers import resolve_conditioning
from ._comfy_core_bridge import find_core_node_class, require_core_node_class
from ._optional_pack_bridge import require_optional_node_class
from ._anima_image_scale_helpers import (
    DEFAULT_UPSCALE_METHOD,
    compute_scale_by_multiple,
    normalize_upscale_method,
)
from ._anima_preview_channel import broadcast_preview

logger = logging.getLogger("AnimaFlow")

# Matches core ComfyUI's own KSampler seed widget bounds
# (`"max": 0xffffffffffffffff`) - mirrored here rather than re-derived so
# this node's seed widget accepts exactly the same range core's own does.
MAX_SEED = 0xFFFFFFFFFFFFFFFF

# Anima-friendly portrait default (matches the tall-panel webtoon framing
# this pack targets), only used when no `latent` input is wired.
DEFAULT_WIDTH = 832
DEFAULT_HEIGHT = 1216

# FALLBACK ONLY - see `get_sampler_names`/`get_scheduler_names`: the live
# ComfyUI process always supplies the current, authoritative list via
# `comfy.samplers.KSampler.SAMPLERS`/`.SCHEDULERS`. These conservative,
# long-stable subsets exist purely so `AnimaGenerator.INPUT_TYPES()` still
# returns a valid (non-empty) dropdown when `comfy.samplers` isn't
# importable - i.e. this repo's own plain-script test suite, which runs
# outside ComfyUI. VERIFY-IN-COMFYUI: do not treat this as the definitive
# sampler/scheduler list; it will not track newly-added core samplers.
_FALLBACK_SAMPLER_NAMES = (
    "euler",
    "euler_ancestral",
    "heun",
    "heunpp2",
    "dpm_2",
    "dpm_2_ancestral",
    "lms",
    "dpm_fast",
    "dpm_adaptive",
    "dpmpp_2s_ancestral",
    "dpmpp_sde",
    "dpmpp_sde_gpu",
    "dpmpp_2m",
    "dpmpp_2m_sde",
    "dpmpp_2m_sde_gpu",
    "dpmpp_3m_sde",
    "dpmpp_3m_sde_gpu",
    "ddpm",
    "lcm",
    "ddim",
    "uni_pc",
    "uni_pc_bh2",
)
_FALLBACK_SCHEDULER_NAMES = (
    "normal",
    "karras",
    "exponential",
    "sgm_uniform",
    "simple",
    "ddim_uniform",
    "beta",
)

# Anima is an AuraFlow-architecture model; the reference pack applies
# `ModelSamplingAuraFlow.patch_aura(model, shift)` UNCONDITIONALLY with this
# same default (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/
# generation_defaults.py`). This pack instead exposes `shift` as an opt-out-
# able widget - see `apply_aura_flow_shift` below.
DEFAULT_AURA_FLOW_SHIFT = 3.0

# The documented "skip patching entirely" value for `shift` - see
# `apply_aura_flow_shift`'s own docstring for why this exists (double-
# patching prevention for users who already wire `ModelSamplingAuraFlow`
# upstream themselves).
AURA_FLOW_SHIFT_SKIP_VALUE = 0.0

# Set the first time `apply_aura_flow_shift`'s live-core `patch_aura` call
# raises, so the fallback warning fires once per process instead of once
# per run - matches `_anima_regional_conditioning_helpers.py`'s own
# `_warned_core_conditioning_set_mask_failed` pattern.
_warned_aura_flow_shift_unreachable = False
_warned_aura_flow_shift_failed = False


def get_sampler_names() -> tuple[str, ...]:
    """The dropdown options for `sampler_name`, matching core's own
    `comfy.samplers.KSampler.SAMPLERS` when comfy is importable (i.e.
    always, inside a live ComfyUI process); see `_FALLBACK_SAMPLER_NAMES`
    for the outside-ComfyUI fallback."""
    try:
        import comfy.samplers  # type: ignore

        names = tuple(comfy.samplers.KSampler.SAMPLERS)
        return names or _FALLBACK_SAMPLER_NAMES
    except Exception:
        return _FALLBACK_SAMPLER_NAMES


def get_scheduler_names() -> tuple[str, ...]:
    """The dropdown options for `scheduler`, matching core's own
    `comfy.samplers.KSampler.SCHEDULERS` when comfy is importable; see
    `_FALLBACK_SCHEDULER_NAMES` for the outside-ComfyUI fallback."""
    try:
        import comfy.samplers  # type: ignore

        names = tuple(comfy.samplers.KSampler.SCHEDULERS)
        return names or _FALLBACK_SCHEDULER_NAMES
    except Exception:
        return _FALLBACK_SCHEDULER_NAMES


def pick_default(names: tuple[str, ...], preferred: str) -> str:
    """`preferred` if it's one of `names`, else the first entry (or
    `preferred` itself if `names` is somehow empty) - used to pick a
    sane widget default regardless of whether the real or fallback
    sampler/scheduler list is in effect."""
    if preferred in names:
        return preferred
    return names[0] if names else preferred


def resolve_pane_conditioning(pane_name: str, clip, conditioning, text) -> Any:
    """Resolve ONE pane's (positive/negative) CONDITIONING per the plan's
    branching rule: a wired `CONDITIONING` input always wins; otherwise a
    non-empty `text` is encoded via `clip` (requiring it be connected);
    otherwise this pane has nothing to sample with, which is a clear
    configuration error, not a silent empty prompt.

    Raises `ValueError` with an actionable message identifying exactly
    which pane and which fix (wire CONDITIONING, or fill `text` AND
    connect `clip`) applies.
    """
    if conditioning is not None:
        return conditioning

    text_value = str(text or "").strip()
    if text_value:
        if clip is None:
            raise ValueError(
                f"{pane_name}_text was provided but clip is not connected. Wire a CLIP "
                f"input (e.g. from a checkpoint loader) so {pane_name}_text can be encoded, "
                f"or wire a {pane_name} CONDITIONING input directly instead."
            )
        return resolve_conditioning(clip, text_value)

    raise ValueError(
        f"No conditioning was provided for '{pane_name}': wire a {pane_name} CONDITIONING "
        f"input, or fill {pane_name}_text and connect clip."
    )


def normalize_lora_stack(lora_stack) -> list[tuple[str, float, float]]:
    """Normalize a `LORA_STACK` input down to a plain list of
    `(name, strength_model, strength_clip)` tuples, tolerating the several
    shapes stack-producing nodes in the wild emit (list of dicts, list of
    3+ tuples, or a JSON-encoded string of either) - mirrors the reference
    pack's own `_normalize_aio_lora_stack`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/model_preparation.py`).
    Entries named "" or "none" (case-insensitive) are dropped, matching
    the common "no LoRA in this slot" convention stack nodes use. Never
    raises - malformed input degrades to an empty stack (no LoRAs
    applied) rather than crashing the whole generation.
    """
    if lora_stack is None:
        return []

    if isinstance(lora_stack, dict) and "__value__" in lora_stack:
        lora_stack = lora_stack["__value__"]

    if isinstance(lora_stack, str):
        try:
            lora_stack = json.loads(lora_stack or "[]")
        except (json.JSONDecodeError, TypeError):
            return []

    if not isinstance(lora_stack, (list, tuple)):
        return []

    entries: list[tuple[str, float, float]] = []
    for item in lora_stack:
        if isinstance(item, dict):
            raw_name = item.get("name", item.get("lora", item.get("lora_name", "")))
            model_strength = item.get(
                "strength_model", item.get("model_strength", item.get("strength", 1.0))
            )
            clip_strength = item.get(
                "strength_clip", item.get("clip_strength", model_strength)
            )
        elif isinstance(item, (list, tuple)) and len(item) >= 3:
            raw_name, model_strength, clip_strength = item[0], item[1], item[2]
        else:
            continue

        name = str(raw_name or "").strip()
        if not name or name.lower() == "none":
            continue

        try:
            model_strength = float(model_strength)
        except (TypeError, ValueError):
            model_strength = 1.0
        try:
            clip_strength = float(clip_strength)
        except (TypeError, ValueError):
            clip_strength = model_strength

        entries.append((name, model_strength, clip_strength))
    return entries


def apply_lora_stack(model, clip, lora_stack):
    """Apply every entry of `lora_stack` (see `normalize_lora_stack`) in
    order, via core's own `LoraLoader.load_lora()` - mirrors the reference
    pack's own `_apply_aio_lora_stack`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/model_preparation.py`).

    Returns `(patched_model, patched_clip, applied)` where `applied` is a
    list of `{"name", "strength_model", "strength_clip"}` dicts actually
    applied (for the metadata output) - entries whose BOTH strengths are
    zero are skipped (a no-op LoRA), matching core's own `LoraLoader`
    short-circuit. If `lora_stack` normalizes to nothing, `model`/`clip`
    are returned unchanged and `applied` is empty - no core node lookup
    happens at all in that case, so this is a true no-op when no LoRAs are
    wired.
    """
    entries = normalize_lora_stack(lora_stack)
    if not entries:
        return model, clip, []

    loader_cls = require_core_node_class("LoraLoader")
    patched_model, patched_clip = model, clip
    applied: list[dict[str, Any]] = []
    for name, strength_model, strength_clip in entries:
        if strength_model == 0 and strength_clip == 0:
            continue
        loader = loader_cls()
        result = loader.load_lora(patched_model, patched_clip, name, strength_model, strength_clip)
        patched_model, patched_clip = result[0], result[1]
        applied.append({
            "name": name,
            "strength_model": strength_model,
            "strength_clip": strength_clip,
        })
    return patched_model, patched_clip, applied


def apply_aura_flow_shift(model, shift: float) -> tuple[Any, dict[str, Any]]:
    """Apply core ComfyUI's `ModelSamplingAuraFlow.patch_aura(model, shift)`
    to `model` - Anima is an AuraFlow-architecture model, and the reference
    pack's own AiO pipeline applies this patch UNCONDITIONALLY with a
    default `shift` of 3.0 (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/
    model_preparation.py`'s `_patch_model_sampling_aura_flow`,
    `.../generation_defaults.py`'s `"shift": 3.0`). Before this fix,
    `AnimaGenerator` applied no such patch at all and had no `shift` widget,
    so a user wiring `MODEL` straight from a checkpoint loader silently got
    different (worse) results than the reference pack - see the R2
    regression report.

    Called right after `apply_lora_stack` and before conditioning is
    resolved/sampling starts, matching the reference pipeline's own stage
    order (LoRA application, THEN model-sampling patches, in
    `../ComfyUI-EasyUseAnima/easyuse_anima/aio/legacy_generation.py`).

    Unlike the reference, this is SOFT and provides an explicit OPT-OUT:

    - `shift == AURA_FLOW_SHIFT_SKIP_VALUE` (0.0) skips patching entirely -
      no core node lookup at all - for users who already wire their own
      `ModelSamplingAuraFlow` node upstream (e.g. between a checkpoint
      loader and this node's `model` input) and would otherwise get the
      shift applied TWICE.
    - Otherwise, this looks up core's `ModelSamplingAuraFlow` via
      `_comfy_core_bridge.find_core_node_class` (deliberately NOT
      `require_core_node_class` - a missing/unreachable core class here
      must never raise) and calls its own `.patch_aura(model, shift)`,
      mirroring the guarded-delegation SHAPE of
      `_anima_regional_conditioning_helpers.combine_regional_conditioning`
      (try the live core class; on ANY failure - class unreachable, or the
      call itself raising - log a one-time warning via this module's own
      `logger` and fall through UNPATCHED rather than raising into the
      user's graph). A soft, best-effort model-sampling tweak is never
      worth failing an entire generation over.

    VERIFY-IN-COMFYUI: the exact `ModelSamplingAuraFlow().patch_aura(model,
    shift)` call signature assumed here (mirroring the reference pack's own
    call) has not been exercised against a real ComfyUI install in this dev
    environment - `_comfy_core_bridge.find_core_node_class` always returns
    `None` here (see that module's own docstring for why), so this always
    takes the "unreachable, falls through unpatched" branch in this repo's
    own test suite.

    Returns `(patched_or_original_model, metadata)` where `metadata` is
    `{"enabled": False, "shift": 0.0, "reason": ...}` when skipped (opt-out,
    unreachable, or failed), or `{"enabled": True, "shift": <float>}` when
    the patch actually applied - fed into this node's own `metadata` JSON
    output.
    """
    global _warned_aura_flow_shift_unreachable, _warned_aura_flow_shift_failed

    shift = float(shift)
    if shift == AURA_FLOW_SHIFT_SKIP_VALUE:
        return model, {
            "enabled": False,
            "shift": AURA_FLOW_SHIFT_SKIP_VALUE,
            "reason": "shift is the documented skip value (0.0) - patching intentionally skipped",
        }

    aura_cls = find_core_node_class("ModelSamplingAuraFlow")
    if aura_cls is None:
        if not _warned_aura_flow_shift_unreachable:
            logger.warning(
                "[AnimaGenerator] ModelSamplingAuraFlow core node is not reachable in this "
                "environment - continuing UNPATCHED (shift=%.3f was requested but not applied). "
                "This is expected outside a live ComfyUI process; if you see this warning while "
                "actually running ComfyUI, your ComfyUI build may be missing this core node.",
                shift,
            )
            _warned_aura_flow_shift_unreachable = True
        return model, {
            "enabled": False,
            "shift": shift,
            "reason": "ModelSamplingAuraFlow core node not reachable",
        }

    try:
        patcher = aura_cls()
        # VERIFY-IN-COMFYUI: see this function's own docstring.
        result = patcher.patch_aura(model, shift)
        patched_model = result[0] if isinstance(result, (tuple, list)) else result
        if patched_model is None:
            raise RuntimeError("ModelSamplingAuraFlow.patch_aura returned no MODEL.")
    except Exception as exc:
        if not _warned_aura_flow_shift_failed:
            logger.warning(
                "[AnimaGenerator] ModelSamplingAuraFlow.patch_aura(shift=%.3f) failed (%s) - "
                "continuing UNPATCHED.",
                shift, exc,
            )
            _warned_aura_flow_shift_failed = True
        return model, {"enabled": False, "shift": shift, "reason": f"patch_aura failed: {exc}"}

    return patched_model, {"enabled": True, "shift": shift}


def build_empty_latent(width: int, height: int, batch_size: int = 1):
    """A fresh `LATENT` sized `width` x `height`, via core's own
    `EmptyLatentImage.generate()` - so this node never has to guess at
    (and risk getting wrong/out of date) the per-model latent channel
    count/device placement logic core's own node already handles."""
    latent_cls = require_core_node_class("EmptyLatentImage")
    return latent_cls().generate(max(8, int(width)), max(8, int(height)), max(1, int(batch_size)))[0]


def sample_latent(model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent, denoise):
    """Sample `latent` via core's own `KSampler.sample()` - the exact call
    path a stock `KSampler` node wired the same way would take, per the
    plan's "don't hand-roll a different sampling call path" requirement."""
    sampler_cls = require_core_node_class("KSampler")
    return sampler_cls().sample(
        model,
        int(seed) & MAX_SEED,
        max(1, int(steps)),
        float(cfg),
        str(sampler_name),
        str(scheduler),
        positive,
        negative,
        latent,
        float(denoise),
    )[0]


def decode_latent(vae, samples):
    """Decode `samples` to an `IMAGE` via core's own `VAEDecode.decode()`."""
    decoder_cls = require_core_node_class("VAEDecode")
    return decoder_cls().decode(vae, samples)[0]


def encode_image_to_latent(vae, image):
    """Encode `image` to a `LATENT` via core's own `VAEEncode.encode()` -
    used by the highres stage's re-encode step."""
    encoder_cls = require_core_node_class("VAEEncode")
    return encoder_cls().encode(vae, image)[0]


def run_highres_pass(
    model,
    vae,
    positive,
    negative,
    image,
    current_width: int,
    current_height: int,
    multiple: int,
    max_long_edge: int,
    seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    denoise,
    upscale_method: str = DEFAULT_UPSCALE_METHOD,
    scale_by: float = 1.5,
):
    """The highres-fix stage: rescale the first pass's decoded `image` up
    to the size `compute_scale_by_multiple` (from
    `_anima_image_scale_helpers` - the SAME math `AnimaImageScaleByMultiple`
    itself uses, imported and reused rather than reimplemented) computes
    from its actual current size and `scale_by`, VAE-encode it back to a
    latent, sample again at partial `denoise` (same seed/steps/cfg/sampler/
    scheduler as the first pass - this v1 has no separate highres sampler-
    override widgets, matching the plan's field list), then VAE-decode.

    `scale_by` (threaded through from `AnimaGenerator`'s `highres_scale_by`
    widget, default 1.5) is what makes this an actual highres-FIX rather
    than a same-resolution second pass - see the R1 regression fix's build
    report / `_anima_image_scale_helpers`'s own module docstring for why
    this parameter had to be added: every standard SDXL/Anima resolution is
    already 64-aligned, so without a scale_by, `compute_scale_by_multiple`
    silently no-ops (target size == current size) and this whole stage was
    burning a full extra img2img pass for zero resolution gain.

    Reuses `positive`/`negative` as-is (no re-encode) - a standard
    highres-fix workflow's second pass conditions on the same prompt, not
    a re-resolved one.

    Returns `(image, latent, width, height, scale_factor)`.
    """
    upscale_method = normalize_upscale_method(upscale_method)
    target_width, target_height, scale_factor = compute_scale_by_multiple(
        current_width, current_height, multiple, max_long_edge, scale_by
    )

    import comfy.utils  # lazy: matches AnimaImageScaleByMultiple.scale()'s own pattern

    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(
        samples, target_width, target_height, upscale_method, "disabled"
    ).movedim(1, -1)

    latent = encode_image_to_latent(vae, resized)
    sampled = sample_latent(
        model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent, denoise
    )
    decoded = decode_latent(vae, sampled)
    return decoded, sampled, target_width, target_height, scale_factor


def build_metadata(
    *,
    seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    denoise,
    width,
    height,
    highres: dict[str, Any] | None = None,
    loras: list[dict[str, Any]] | None = None,
    detailer: dict[str, Any] | None = None,
    upscale: dict[str, Any] | None = None,
    postprocess: dict[str, Any] | None = None,
    save: dict[str, Any] | None = None,
    aura_flow: dict[str, Any] | None = None,
) -> str:
    """Assemble the small JSON metadata blob this node's `metadata` output
    returns: first-pass sampler settings, requested first-pass size,
    whatever highres/detailer/upscale/postprocess/save settings were
    actually used this run (each `{"enabled": False}` if that stage was
    skipped), the AuraFlow model-sampling shift patch's own outcome (see
    `apply_aura_flow_shift`), and the LoRA stack actually applied."""
    payload = {
        "seed": int(seed),
        "steps": int(steps),
        "cfg": float(cfg),
        "sampler_name": str(sampler_name),
        "scheduler": str(scheduler),
        "denoise": float(denoise),
        "width": int(width),
        "height": int(height),
        "highres": highres if highres is not None else {"enabled": False},
        "loras": loras if loras is not None else [],
        "detailer": detailer if detailer is not None else {"enabled": False},
        "upscale": upscale if upscale is not None else {"enabled": False},
        "postprocess": postprocess if postprocess is not None else {"enabled": False},
        "save": save if save is not None else {"enabled": False},
        "aura_flow": aura_flow if aura_flow is not None else {"enabled": False},
    }
    return json.dumps(payload)


def _segs_has_items(segs) -> bool:
    """True if `segs` (an Impact-Pack-shaped `SEGS` value:
    `(image_size, [seg_items])`) actually contains at least one detected
    region. Mirrors the reference pack's own `_segs_has_items`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/image/sam3.py`) - tolerant of
    `None`/malformed input (never raises), since the detection input can
    come from ANY detector node (SAM, SAM2, SAM3, BBox, GroundingDINO, ...)
    and this pack has no control over what shape a broken/empty one takes.
    """
    if segs is None:
        return False
    try:
        return len(segs[1]) > 0
    except Exception:
        return False


def _call_with_accepted_kwargs(method, kwargs: dict[str, Any]):
    """Call `method(**kwargs)`, first dropping any key `method` doesn't
    declare as a parameter (unless it accepts `**kwargs` itself). Impact
    Pack's own `DetailerForEach.doit()` signature has drifted across
    versions (extra optional params added over time), so this defensively
    adapts instead of hard-coding one exact parameter list - mirrors the
    reference pack's own `_call_impact_detailer`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/image/sam3.py`)."""
    signature = inspect.signature(method)
    parameters = signature.parameters
    accepts_var_kwargs = any(
        param.kind == inspect.Parameter.VAR_KEYWORD for param in parameters.values()
    )
    call_kwargs = kwargs if accepts_var_kwargs else {
        key: value for key, value in kwargs.items() if key in parameters
    }
    return method(**call_kwargs)


def _first_output(result, error_label: str):
    """Extract the first output value from whatever an external pack's node
    method returned. Impact Pack's `doit()` may return a plain tuple, or a
    dict shaped `{"result": (...), "ui": {...}}` depending on version;
    USDU's/ResShift's own node methods always return a plain tuple. Raises
    `RuntimeError` (naming `error_label`) if nothing usable was found - a
    stage that ran but returned nothing is a real bug, not a silent skip."""
    if isinstance(result, dict):
        value = result.get("result")
        if isinstance(value, (tuple, list)) and value:
            return value[0]
        raise RuntimeError(f"[AnimaGenerator] {error_label} returned no usable result.")
    if isinstance(result, (tuple, list)):
        if not result:
            raise RuntimeError(f"[AnimaGenerator] {error_label} returned an empty tuple.")
        return result[0]
    return result


def run_detailer_stage(
    image,
    segs,
    model,
    clip,
    vae,
    positive,
    negative,
    seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    guide_size,
    max_size,
    denoise,
    preview_channel: str,
    hook=None,
) -> tuple[Any, dict[str, Any]]:
    """The detailer stage: runs Impact Pack's own `DetailerForEach.doit()`
    against `image` using `segs` - detection regions from ANY detector node
    (SAM, SAM2, SAM3, BBox, GroundingDINO, whatever Impact Pack workflow the
    user already has), not tied to one detection method, unlike the
    reference pack's SAM3-specific wrapper (a deliberate agnostic
    improvement, see the plan's "Explicitly OUT of scope" section).

    Opt-in PER RUN based on whether `segs` actually contains detections, not
    just a toggle: if `segs` is `None`/empty, this stage is silently
    skipped (returns `image` unchanged, `{"enabled": False, ...}`), no error -
    a user who left detailing on but forgot to wire/run a detector this time
    gets a normal result, not a crash. Only once `segs` actually has
    detections does a missing Impact Pack install raise the actionable
    `require_optional_node_class` error - so the error only ever fires when
    detailing would otherwise really happen.

    `guide_size`/`max_size`/`denoise` are the only per-run sampler-shape
    controls exposed as widgets (the minimal set structurally required
    beyond what `AnimaGenerator` already has - model/clip/vae/seed/steps/
    cfg/sampler_name/scheduler/positive/negative are reused as-is, matching
    the highres stage's own "no separate sampler-override widgets"
    precedent); every other required-by-`doit()` argument
    (`feather`, `noise_mask`, `force_inpaint`, `wildcard`, `cycle`,
    `inpaint_model`, `noise_mask_feather`, `scheduler_func_opt`,
    `tiled_encode`, `tiled_decode`) is passed as a fixed constant matching
    Impact Pack's own node defaults (see
    `../ComfyUI-EasyUseAnima/easyuse_anima/nodes/impact_detailer_nodes.py`),
    not exposed as a widget - keeping this pack's own settings surface
    minimal per the plan, not replicating Impact Pack's entire options list.
    `hook` (a `DETAILER_HOOK`, e.g. this pack's own `AnimaDetailerAlignHook`)
    is passed straight through if wired, `None` otherwise.
    """
    if not _segs_has_items(segs):
        logger.debug(
            "[AnimaGenerator] detailer stage: no segs provided/detected - skipping (image unchanged)."
        )
        return image, {"enabled": False, "reason": "no segs provided or segs contained no detections"}

    detailer_cls = require_optional_node_class(
        "DetailerForEach", "Impact Pack (ComfyUI-Impact-Pack)"
    )
    detailer = detailer_cls()
    kwargs = {
        "image": image,
        "segs": segs,
        "model": model,
        "clip": clip,
        "vae": vae,
        "guide_size": float(guide_size),
        "guide_size_for": True,
        "max_size": float(max_size),
        "seed": int(seed) & MAX_SEED,
        "steps": max(1, int(steps)),
        "cfg": float(cfg),
        "sampler_name": str(sampler_name),
        "scheduler": str(scheduler),
        "positive": positive,
        "negative": negative,
        "denoise": float(denoise),
        "feather": 5,
        "noise_mask": True,
        "force_inpaint": True,
        "wildcard": "",
        "cycle": 1,
        "detailer_hook": hook,
        "inpaint_model": False,
        "noise_mask_feather": 0,
        "scheduler_func_opt": None,
        "tiled_encode": False,
        "tiled_decode": False,
    }
    result = _call_with_accepted_kwargs(detailer.doit, kwargs)
    detailed_image = _first_output(result, "Impact DetailerForEach")
    broadcast_preview(preview_channel, detailed_image, "detailer")
    return detailed_image, {
        "enabled": True,
        "guide_size": float(guide_size),
        "max_size": float(max_size),
        "denoise": float(denoise),
    }


def get_upscale_model_names() -> tuple[str, ...]:
    """Dropdown options for `upscale_usdu_model_name` - the upscale-model
    filenames ComfyUI's own `folder_paths.get_filename_list("upscale_models")`
    reports (exactly what core's own `UpscaleModelLoader` node lists).
    Falls back to a single documented placeholder entry when `folder_paths`
    isn't importable (this repo's own plain-script test suite) so
    `AnimaGenerator.INPUT_TYPES()` still returns a valid non-empty dropdown
    outside a live ComfyUI process."""
    try:
        import folder_paths  # type: ignore

        names = tuple(folder_paths.get_filename_list("upscale_models"))
        return names or ("(no upscale_models found)",)
    except Exception:
        return ("(no upscale_models found)",)


def load_usdu_upscale_model(model_name: str):
    """Load `model_name` (a filename under ComfyUI's `models/upscale_models/`)
    into an `UPSCALE_MODEL`, via core's own `UpscaleModelLoader` node.
    `UpscaleModelLoader` ships with ComfyUI itself (defined in
    `comfy_extras`, merged into core's own `NODE_CLASS_MAPPINGS` at
    startup) - NOT a separately-installed optional pack - so this goes
    through `_comfy_core_bridge`, not `_optional_pack_bridge`."""
    model_name = str(model_name or "").strip()
    if not model_name or model_name == "(no upscale_models found)":
        raise ValueError(
            "upscale_usdu_model_name is required for the USDU upscale backend - "
            "choose a model from ComfyUI's models/upscale_models directory."
        )
    loader_cls = require_core_node_class("UpscaleModelLoader")
    return loader_cls().load_model(model_name)[0]


def run_usdu_upscale_stage(
    image,
    model,
    positive,
    negative,
    vae,
    seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    denoise,
    scale_by,
    tile_size,
    model_name,
) -> tuple[Any, dict[str, Any]]:
    """USDU (Ultimate SD Upscale) backend of the upscale stage: tiled
    img2img upscale via the optional `ComfyUI_UltimateSDUpscale` pack's own
    `UltimateSDUpscale.upscale()`, called the same way the reference pack's
    `_run_aio_usdu_upscale_stage`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/legacy_generation.py` +
    `.../aio/usdu.py`) does, with this build's non-widget fields fixed to
    that reference's own defaults (`mode_type="Linear"`, `mask_blur=8`,
    `tile_padding=32`, `seam_fix_mode="None"`, `seam_fix_denoise=1.0`,
    `seam_fix_mask_blur=8`, `seam_fix_width=64`, `seam_fix_padding=16`,
    `force_uniform_tiles=True`, `tiled_decode=False`, `batch_size=1`) rather
    than exposed as widgets - the plan's "keep this minimal" scoping.
    `seed`/`steps`/`cfg`/`sampler_name`/`scheduler` are reused from the main
    generator widgets (only `denoise` is a separate per-stage widget),
    matching the highres stage's own "no separate sampler-override widgets"
    precedent.
    """
    usdu_cls = require_optional_node_class(
        "UltimateSDUpscale", "ComfyUI_UltimateSDUpscale (Ultimate SD Upscale)"
    )
    upscale_model = load_usdu_upscale_model(model_name)
    tile_size = max(64, int(tile_size))
    result = usdu_cls().upscale(
        image=image,
        model=model,
        positive=positive,
        negative=negative,
        vae=vae,
        upscale_by=float(scale_by),
        seed=int(seed) & MAX_SEED,
        steps=max(1, int(steps)),
        cfg=float(cfg),
        sampler_name=str(sampler_name),
        scheduler=str(scheduler),
        denoise=float(denoise),
        upscale_model=upscale_model,
        mode_type="Linear",
        tile_width=tile_size,
        tile_height=tile_size,
        mask_blur=8,
        tile_padding=32,
        seam_fix_mode="None",
        seam_fix_denoise=1.0,
        seam_fix_mask_blur=8,
        seam_fix_width=64,
        seam_fix_padding=16,
        force_uniform_tiles=True,
        tiled_decode=False,
        batch_size=1,
    )
    image_out = _first_output(result, "UltimateSDUpscale")
    return image_out, {
        "enabled": True,
        "backend": "usdu",
        "scale_by": float(scale_by),
        "tile_size": tile_size,
        "denoise": float(denoise),
        "upscale_model_name": str(model_name),
    }


def run_resshift_upscale_stage(
    image,
    seed,
    scale,
    chop,
    overlap,
    tile_batch,
) -> tuple[Any, dict[str, Any]]:
    """ResShift backend of the upscale stage: single-pass diffusion
    upscale via the optional `ComfyUI-Distilled-ResShift` pack's own
    `ResShiftLoader.load()` + `ResShiftUpscale.upscale()`, called the same
    way the reference pack's `_run_aio_resshift_upscale_stage`
    (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/legacy_generation.py`) does.
    `student_name`/`dtype` are fixed to that reference's own defaults
    (`"(auto-download)"`/`"bf16"`) rather than exposed as widgets - a rarely
    -tuned pair of fields, kept as a documented constant per the plan's
    "keep this minimal" scoping. No `model`/`clip`/`vae`/conditioning is
    needed at all for this backend - it's a plain image-to-image upscale,
    not a sampling pass."""
    loader_cls = require_optional_node_class("ResShiftLoader", "ComfyUI-Distilled-ResShift")
    upscale_cls = require_optional_node_class("ResShiftUpscale", "ComfyUI-Distilled-ResShift")
    loader = loader_cls()
    resshift_model = _first_output(
        loader.load(str(scale or "x2"), "(auto-download)", "bf16"), "ResShiftLoader"
    )
    upscaler = upscale_cls()
    result = upscaler.upscale(
        resshift_model,
        image,
        int(seed) & MAX_SEED,
        max(64, int(chop)),
        max(0, int(overlap)),
        max(1, int(tile_batch)),
    )
    image_out = _first_output(result, "ResShiftUpscale")
    return image_out, {
        "enabled": True,
        "backend": "resshift",
        "scale": str(scale or "x2"),
        "chop": int(chop),
        "overlap": int(overlap),
        "tile_batch": int(tile_batch),
    }


def run_upscale_stage(
    image,
    model,
    positive,
    negative,
    vae,
    backend: str,
    seed,
    steps,
    cfg,
    sampler_name,
    scheduler,
    preview_channel: str,
    usdu_denoise,
    usdu_scale_by,
    usdu_tile_size,
    usdu_model_name,
    resshift_scale,
    resshift_chop,
    resshift_overlap,
    resshift_tile_batch,
) -> tuple[Any, dict[str, Any]]:
    """The upscale stage: dispatches to whichever backend `backend` selects
    (`"usdu"` -> `run_usdu_upscale_stage`, `"resshift"` ->
    `run_resshift_upscale_stage`) - the user's choice of soft-dependency,
    exactly like the reference pack offers both. Broadcasts the result on
    `preview_channel` under the `"upscale"` stage label, same as the
    detailer stage does under `"detailer"`."""
    backend = str(backend or "usdu").strip().lower()
    if backend == "resshift":
        image_out, metadata = run_resshift_upscale_stage(
            image, seed, resshift_scale, resshift_chop, resshift_overlap, resshift_tile_batch,
        )
    else:
        image_out, metadata = run_usdu_upscale_stage(
            image, model, positive, negative, vae,
            seed, steps, cfg, sampler_name, scheduler,
            usdu_denoise, usdu_scale_by, usdu_tile_size, usdu_model_name,
        )
    broadcast_preview(preview_channel, image_out, "upscale")
    return image_out, metadata


def run_postprocess_resize(
    image,
    multiple: int,
    upscale_method: str = DEFAULT_UPSCALE_METHOD,
) -> tuple[Any, dict[str, Any]]:
    """The postprocess stage: ONE final resize pass (no re-sampling), so
    the final image lands on an exact multiple of `multiple` (aspect
    -preserving) - reuses `compute_scale_by_multiple` (the SAME math
    `AnimaImageScaleByMultiple`/the highres stage already use, imported
    rather than reimplemented) with no `max_long_edge` cap (this stage has
    no such widget - the plan's minimal field list is just
    `postprocess_resize_enabled` + `postprocess_multiple`). `multiple <= 0`
    means "disabled" and is a pure no-op (the caller is expected to pass 0
    when `postprocess_resize_enabled` is False, matching every other
    stage's own enabled-toggle-gates-the-call convention)."""
    multiple = int(multiple)
    if multiple <= 0:
        return image, {"enabled": False}

    current_height = int(image.shape[1])
    current_width = int(image.shape[2])
    # scale_by is deliberately OMITTED here (keeping the function's own
    # neutral default, 1.0) - this stage genuinely wants pure alignment, not
    # enlargement; see `_anima_image_scale_helpers`'s module docstring and
    # the R1 fix's build report for why that default had to stay 1.0.
    target_width, target_height, scale_factor = compute_scale_by_multiple(
        current_width, current_height, multiple, 0
    )

    if target_width == current_width and target_height == current_height:
        return image, {
            "enabled": True,
            "resized": False,
            "multiple": multiple,
            "width": current_width,
            "height": current_height,
        }

    import comfy.utils  # lazy: matches run_highres_pass's / AnimaImageScaleByMultiple.scale()'s own pattern

    method = normalize_upscale_method(upscale_method)
    samples = image.movedim(-1, 1)
    resized = comfy.utils.common_upscale(
        samples, target_width, target_height, method, "disabled"
    ).movedim(1, -1)
    return resized, {
        "enabled": True,
        "resized": True,
        "multiple": multiple,
        "width": target_width,
        "height": target_height,
        "scale_factor": scale_factor,
    }


def run_save_output_stage(image, save_prefix: str):
    """Save `image` via core's own `SaveImage.save_images()` - files land
    in ComfyUI's normal output directory with normal previews, exactly like
    wiring `image` into a stock `SaveImage` node. Core node (ships with
    ComfyUI itself), so this goes through `_comfy_core_bridge`, not
    `_optional_pack_bridge`. Returns whatever `SaveImage.save_images()`
    itself returns (a UI-only `{"ui": {"images": [...]}}` payload).

    This node doesn't declare hidden `prompt`/`extra_pnginfo` inputs, so no
    workflow gets embedded in the saved PNGs - a deliberate, documented
    simplification (the decoupled, agnostic default per the plan: if
    `save_output` is off, the user is expected to wire `image` to their own
    save node instead, e.g. one that does embed workflow metadata)."""
    saver_cls = require_core_node_class("SaveImage")
    return saver_cls().save_images(image, str(save_prefix or "Anima"))


__all__ = (
    "AURA_FLOW_SHIFT_SKIP_VALUE",
    "DEFAULT_AURA_FLOW_SHIFT",
    "DEFAULT_HEIGHT",
    "DEFAULT_WIDTH",
    "MAX_SEED",
    "apply_aura_flow_shift",
    "apply_lora_stack",
    "build_empty_latent",
    "build_metadata",
    "decode_latent",
    "encode_image_to_latent",
    "get_sampler_names",
    "get_scheduler_names",
    "get_upscale_model_names",
    "load_usdu_upscale_model",
    "normalize_lora_stack",
    "pick_default",
    "resolve_pane_conditioning",
    "run_detailer_stage",
    "run_highres_pass",
    "run_postprocess_resize",
    "run_resshift_upscale_stage",
    "run_save_output_stage",
    "run_upscale_stage",
    "run_usdu_upscale_stage",
    "sample_latent",
)
