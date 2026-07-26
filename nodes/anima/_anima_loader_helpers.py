"""Resource-name lookups + the actual load call for `AnimaLoader`.

Pure/testable (no torch/comfy import at module scope, everything guarded):
`get_diffusion_model_names`, `get_vae_names`, `get_text_encoder_names`,
`get_clip_loader_types`, `get_weight_dtype_options` all reach for ComfyUI's
own `folder_paths` module and/or a live core loader class's own
`INPUT_TYPES()` combo (via `_comfy_core_bridge.find_core_node_class` - never
raises), falling back to a small documented placeholder/snapshot list when
neither is reachable - i.e. this repo's own plain-script test suite, which
runs outside a live ComfyUI process. `pick_preferred_name` is plain string
logic with no I/O at all. Only `load_model_clip_vae` actually touches a live
ComfyUI process (via `_comfy_core_bridge.require_core_node_class`, which
raises a clear `RuntimeError` instead of silently degrading, since a loader
call with nothing to load from is a genuine configuration/environment
error, not something to paper over) - matches
`_anima_generator_helpers.py`'s own split of guarded-and-testable name
lookups next to comfy-touching stage functions in one module.

Delegates to ComfyUI's own core `UNETLoader`/`CLIPLoader`/`VAELoader` node
classes for the actual loading - never reimplements that logic (same
rationale as `_comfy_core_bridge`'s own module docstring: bit-identical
results to wiring the same core nodes into a stock workflow, staying correct
automatically as core's internal loading logic changes over time).
"""

from __future__ import annotations

from ._comfy_core_bridge import find_core_node_class, require_core_node_class

# FALLBACK ONLY - single documented placeholder entries used when
# `folder_paths` isn't importable (this repo's own plain-script test suite,
# run outside a live ComfyUI process), so `AnimaLoader.INPUT_TYPES()` still
# returns a valid non-empty dropdown there instead of an empty combo (which
# some ComfyUI widget renderers reject) - same pattern as
# `_anima_generator_helpers.get_upscale_model_names`.
_NO_DIFFUSION_MODELS_FOUND = "(no diffusion_models found)"
_NO_VAE_FOUND = "(no vae found)"
_NO_TEXT_ENCODERS_FOUND = "(no text_encoders found)"

# FALLBACK ONLY - a snapshot of core ComfyUI's own CLIPLoader `type` combo
# (mirrors `../ComfyUI-EasyUseAnima/easyuse_anima/aio/input_defaults.py`'s
# own `ANIMA_CLIP_TYPES`, itself read from a live core CLIPLoader). Used only
# when core's own CLIPLoader class isn't reachable to ask directly - so this
# will not track newly-added core clip types; VERIFY-IN-COMFYUI.
_FALLBACK_CLIP_TYPES = (
    "stable_diffusion",
    "stable_cascade",
    "sd3",
    "stable_audio",
    "mochi",
    "ltxv",
    "pixart",
    "cosmos",
    "lumina2",
    "wan",
    "hidream",
    "chroma",
    "ace",
    "omnigen2",
    "qwen_image",
    "hunyuan_image",
    "flux2",
    "ovis",
    "longcat_image",
    "cogvideox",
    "lens",
    "pixeldit",
    "ideogram4",
)

# FALLBACK ONLY - a snapshot of core ComfyUI's own UNETLoader `weight_dtype`
# combo. Used only when core's own UNETLoader class isn't reachable to ask
# directly. VERIFY-IN-COMFYUI: do not treat as definitive.
_FALLBACK_WEIGHT_DTYPES = ("default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2")

# Anima's text encoder is Qwen-based - the reference EasyUseAnima pack
# defaults `clip_type` to this same value.
DEFAULT_CLIP_TYPE = "qwen_image"
DEFAULT_WEIGHT_DTYPE = "default"


def _folder_path_names(folder_name: str, placeholder: str) -> tuple[str, ...]:
    """`folder_paths.get_filename_list(folder_name)`, or a single documented
    placeholder entry when `folder_paths` isn't importable - never raises."""
    try:
        import folder_paths  # type: ignore

        names = tuple(str(name) for name in folder_paths.get_filename_list(folder_name))
        return names or (placeholder,)
    except Exception:
        return (placeholder,)


def _combo_from_core_loader(node_id: str, field_name: str) -> tuple[str, ...] | None:
    """Best-effort read of `field_name`'s own combo list straight off a live
    core loader class's `INPUT_TYPES()["required"]` - the most current
    possible source (tracks core exactly, including any dtype/type this
    pack doesn't know about yet). Returns `None` (never raises) if the core
    class isn't reachable or its shape doesn't match what's expected, so
    callers can fall back to their own documented snapshot list."""
    loader_cls = find_core_node_class(node_id)
    if loader_cls is None:
        return None
    try:
        required = loader_cls.INPUT_TYPES().get("required", {})
        spec = required.get(field_name)
        names = tuple(str(name) for name in spec[0])
        return names or None
    except Exception:
        return None


def get_diffusion_model_names() -> tuple[str, ...]:
    """Dropdown options for `unet_name` - filenames from ComfyUI's own
    `folder_paths.get_filename_list("diffusion_models")` (exactly what core's
    own `UNETLoader` lists)."""
    return _folder_path_names("diffusion_models", _NO_DIFFUSION_MODELS_FOUND)


def get_vae_names() -> tuple[str, ...]:
    """Dropdown options for `vae_name`. Prefers asking a reachable core
    `VAELoader` class for its own `vae_name` combo directly (core's
    VAELoader adds synthetic entries, e.g. "taesd", on top of the plain
    folder listing - matching the reference pack's own `_comfy_vae_names`);
    falls back to the plain `folder_paths` "vae" listing, then to a
    placeholder."""
    names = _combo_from_core_loader("VAELoader", "vae_name")
    if names:
        return names
    return _folder_path_names("vae", _NO_VAE_FOUND)


def get_text_encoder_names() -> tuple[str, ...]:
    """Dropdown options for `clip_name` - filenames from ComfyUI's own
    `folder_paths.get_filename_list("text_encoders")` (exactly what core's
    own `CLIPLoader` lists)."""
    return _folder_path_names("text_encoders", _NO_TEXT_ENCODERS_FOUND)


def get_clip_loader_types() -> tuple[str, ...]:
    """Dropdown options for `clip_type`. Prefers asking a reachable core
    `CLIPLoader` class for its own `type` combo directly, so this always
    tracks core's actual current list; falls back to `_FALLBACK_CLIP_TYPES`
    (a snapshot of that same list) when core isn't reachable."""
    names = _combo_from_core_loader("CLIPLoader", "type")
    if names:
        return names
    return _FALLBACK_CLIP_TYPES


def get_weight_dtype_options() -> tuple[str, ...]:
    """Dropdown options for `weight_dtype`. Prefers asking a reachable core
    `UNETLoader` class for its own `weight_dtype` combo directly; falls back
    to `_FALLBACK_WEIGHT_DTYPES` (a snapshot of that same list) otherwise."""
    names = _combo_from_core_loader("UNETLoader", "weight_dtype")
    if names:
        return names
    return _FALLBACK_WEIGHT_DTYPES


def pick_preferred_name(names: tuple[str, ...], keyword: str) -> str:
    """Sensible default selection for a name dropdown: the first entry whose
    (lowercased) name contains `keyword` (e.g. "anima" for `unet_name`,
    "qwen" for `vae_name`/`clip_name` - Anima's own VAE/text-encoder are
    Qwen-based, same reasoning as `clip_type`'s own default), else just the
    first entry, else "" if `names` is somehow empty.

    Deliberately simpler than the reference pack's own
    `_preferred_name_default` (no exact-candidate-filename list, no
    path-separator/basename normalization) - a case-insensitive keyword
    match is enough for a convenience default here; the widget itself still
    lets the user pick any other listed file."""
    if not names:
        return ""
    keyword_lower = keyword.lower()
    for name in names:
        if keyword_lower in str(name).lower():
            return name
    return names[0]


def load_model_clip_vae(unet_name: str, vae_name: str, clip_name: str, clip_type: str, weight_dtype: str):
    """Load `(MODEL, CLIP, VAE)` via ComfyUI's own core `UNETLoader` /
    `CLIPLoader` / `VAELoader` node classes - never reimplements their
    loading logic (see module docstring). Each lookup goes through
    `_comfy_core_bridge.require_core_node_class`, which raises a clear,
    actionable `RuntimeError` if that core class genuinely isn't reachable
    (i.e. this is being called outside a live ComfyUI process) rather than
    failing some other, less obvious way."""
    unet_loader_cls = require_core_node_class("UNETLoader")
    model = unet_loader_cls().load_unet(str(unet_name), str(weight_dtype or DEFAULT_WEIGHT_DTYPE))[0]

    clip_loader_cls = require_core_node_class("CLIPLoader")
    clip = clip_loader_cls().load_clip(str(clip_name), str(clip_type or DEFAULT_CLIP_TYPE))[0]

    vae_loader_cls = require_core_node_class("VAELoader")
    vae = vae_loader_cls().load_vae(str(vae_name))[0]

    return model, clip, vae


__all__ = (
    "DEFAULT_CLIP_TYPE",
    "DEFAULT_WEIGHT_DTYPE",
    "get_diffusion_model_names",
    "get_vae_names",
    "get_text_encoder_names",
    "get_clip_loader_types",
    "get_weight_dtype_options",
    "pick_preferred_name",
    "load_model_clip_vae",
)
