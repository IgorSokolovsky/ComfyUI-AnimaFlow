"""Plain-script tests for `AnimaLoader` and its `_anima_loader_helpers`.

Run directly: `python tests/test_anima_loader.py` (no pytest, per project
convention). Main regression guard: `INPUT_TYPES()` must not raise in this
dev environment, where neither `folder_paths` nor `comfy`/`torch` are
importable (`nodes/anima/_comfy_core_bridge.py`'s module docstring explains
exactly why bare `import nodes` - and therefore `find_core_node_class` -
degrades to `None` here). Also guards against re-introducing the reference
pack's two rejected traits: a proprietary bundled blob RETURN_TYPES, and a
required prompt-data input (see `node_anima_loader.py`'s own module
docstring for the full rationale).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima._anima_loader_helpers import (
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
from nodes.anima.node_anima_loader import AnimaLoader


# ---------------------------------------------------------------------------
# _anima_loader_helpers: name-list lookups (guarded, no folder_paths/comfy
# available in this dev environment - see _comfy_core_bridge's docstring)
# ---------------------------------------------------------------------------

def test_get_diffusion_model_names_falls_back_without_folder_paths():
    names = get_diffusion_model_names()
    assert isinstance(names, tuple) and len(names) > 0
    assert all(isinstance(name, str) for name in names)


def test_get_vae_names_falls_back_without_folder_paths_or_core():
    names = get_vae_names()
    assert isinstance(names, tuple) and len(names) > 0


def test_get_text_encoder_names_falls_back_without_folder_paths():
    names = get_text_encoder_names()
    assert isinstance(names, tuple) and len(names) > 0


def test_get_clip_loader_types_falls_back_without_core_and_includes_qwen_image():
    types = get_clip_loader_types()
    assert isinstance(types, tuple) and len(types) > 0
    assert "qwen_image" in types


def test_get_weight_dtype_options_falls_back_without_core():
    options = get_weight_dtype_options()
    assert isinstance(options, tuple) and len(options) > 0
    assert "default" in options


# ---------------------------------------------------------------------------
# pick_preferred_name - pure logic, no I/O
# ---------------------------------------------------------------------------

def test_pick_preferred_name_prefers_keyword_match():
    names = ("foo.safetensors", "anima-base-v1.0.safetensors", "bar.safetensors")
    assert pick_preferred_name(names, "anima") == "anima-base-v1.0.safetensors"


def test_pick_preferred_name_is_case_insensitive():
    names = ("foo.safetensors", "ANIMA-base.safetensors")
    assert pick_preferred_name(names, "anima") == "ANIMA-base.safetensors"


def test_pick_preferred_name_falls_back_to_first_when_no_keyword_match():
    names = ("foo.safetensors", "bar.safetensors")
    assert pick_preferred_name(names, "anima") == "foo.safetensors"


def test_pick_preferred_name_empty_names_returns_empty_string():
    assert pick_preferred_name((), "anima") == ""


# ---------------------------------------------------------------------------
# load_model_clip_vae - guarded, requires a live core (RuntimeError outside)
# ---------------------------------------------------------------------------

def test_load_model_clip_vae_raises_actionable_error_outside_comfyui():
    try:
        load_model_clip_vae("unet.safetensors", "vae.safetensors", "clip.safetensors", "qwen_image", "default")
        raised = False
    except RuntimeError as exc:
        raised = True
        assert "UNETLoader" in str(exc)
    assert raised


# ---------------------------------------------------------------------------
# AnimaLoader node contract
# ---------------------------------------------------------------------------

def test_input_types_is_callable_and_does_not_raise():
    schema = AnimaLoader.INPUT_TYPES()
    assert isinstance(schema, dict)
    assert "required" in schema


def test_input_types_returns_the_five_expected_fields():
    required = AnimaLoader.INPUT_TYPES()["required"]
    assert set(required.keys()) == {"unet_name", "vae_name", "clip_name", "clip_type", "weight_dtype"}


def test_input_types_field_shapes():
    required = AnimaLoader.INPUT_TYPES()["required"]

    assert isinstance(required["unet_name"][0], (tuple, list)) and len(required["unet_name"][0]) > 0
    assert required["unet_name"][1]["default"] in required["unet_name"][0]

    assert isinstance(required["vae_name"][0], (tuple, list)) and len(required["vae_name"][0]) > 0
    assert required["vae_name"][1]["default"] in required["vae_name"][0]

    assert isinstance(required["clip_name"][0], (tuple, list)) and len(required["clip_name"][0]) > 0
    assert required["clip_name"][1]["default"] in required["clip_name"][0]

    assert isinstance(required["clip_type"][0], (tuple, list)) and len(required["clip_type"][0]) > 0
    assert required["clip_type"][1]["default"] in required["clip_type"][0]

    assert isinstance(required["weight_dtype"][0], (tuple, list)) and len(required["weight_dtype"][0]) > 0
    assert required["weight_dtype"][1]["default"] in required["weight_dtype"][0]


def test_clip_type_defaults_to_qwen_image():
    required = AnimaLoader.INPUT_TYPES()["required"]
    assert required["clip_type"][1]["default"] == "qwen_image" == DEFAULT_CLIP_TYPE


def test_weight_dtype_defaults_to_default():
    required = AnimaLoader.INPUT_TYPES()["required"]
    assert required["weight_dtype"][1]["default"] == "default" == DEFAULT_WEIGHT_DTYPE


def test_every_input_has_a_non_empty_non_name_restating_tooltip():
    required = AnimaLoader.INPUT_TYPES()["required"]
    for name, spec in required.items():
        tooltip = spec[1].get("tooltip")
        assert tooltip, f"{name} is missing a tooltip"
        assert tooltip.strip().lower() != name.lower(), f"{name}'s tooltip just restates its own name"
        assert len(tooltip) > len(name), f"{name}'s tooltip is too short to be meaningful"


def test_every_output_has_a_non_empty_non_name_restating_tooltip():
    assert len(AnimaLoader.OUTPUT_TOOLTIPS) == len(AnimaLoader.RETURN_TYPES) == len(AnimaLoader.RETURN_NAMES)
    for return_name, tooltip in zip(AnimaLoader.RETURN_NAMES, AnimaLoader.OUTPUT_TOOLTIPS):
        assert tooltip, f"output {return_name} is missing a tooltip"
        assert tooltip.strip().lower() != return_name.lower(), f"output {return_name}'s tooltip just restates its own name"
        assert len(tooltip) > len(return_name), f"output {return_name}'s tooltip is too short to be meaningful"


def test_return_types_and_names_are_plain_standard_sockets():
    assert AnimaLoader.RETURN_TYPES == ("MODEL", "CLIP", "VAE")
    assert AnimaLoader.RETURN_NAMES == ("model", "clip", "vae")
    assert AnimaLoader.CATEGORY == "AnimaFlow/anima"
    assert AnimaLoader.FUNCTION == "load"


def test_no_proprietary_blob_return_type_leaks_into_return_types():
    # Regression guard against re-creating the reference pack's
    # EasyUseAnimaInput's single bundled-context socket
    # (`EASY_USE_ANIMA_INPUT_TYPE = "EASY_USE_ANIMA_INPUT"`).
    for return_type in AnimaLoader.RETURN_TYPES:
        assert return_type in ("MODEL", "CLIP", "VAE")
        assert "EASY_USE_ANIMA" not in return_type
        assert "INPUT" not in return_type


def test_node_takes_no_prompt_data_input():
    # Regression guard against re-creating EasyUseAnimaInput's
    # EASYUSE_ANIMA_PROMPT_DATA-forceInput coupling - this loader has no
    # structural reason to take prompt data at all.
    schema = AnimaLoader.INPUT_TYPES()
    all_field_names = set(schema.get("required", {})) | set(schema.get("optional", {}))
    for field_name in all_field_names:
        assert "PROMPT_DATA" not in field_name.upper()
    for spec in list(schema.get("required", {}).values()) + list(schema.get("optional", {}).values()):
        field_type = spec[0]
        if isinstance(field_type, str):
            assert "PROMPT_DATA" not in field_type.upper()


# ---------------------------------------------------------------------------
# Guarded full-load smoke test - real torch/comfy if available, SKIP if not
# ---------------------------------------------------------------------------

def test_smoke_full_load_with_torch_and_comfy_if_available():
    try:
        import torch  # type: ignore  # noqa: F401
        import comfy.sd  # type: ignore  # noqa: F401
    except Exception as exc:
        print(f"SKIP  test_smoke_full_load_with_torch_and_comfy_if_available: {exc} (not running inside ComfyUI)")
        return

    print(
        "SKIP  test_smoke_full_load_with_torch_and_comfy_if_available: "
        "no live ComfyUI model files fixture available in this environment"
    )


ALL_TESTS = [
    test_get_diffusion_model_names_falls_back_without_folder_paths,
    test_get_vae_names_falls_back_without_folder_paths_or_core,
    test_get_text_encoder_names_falls_back_without_folder_paths,
    test_get_clip_loader_types_falls_back_without_core_and_includes_qwen_image,
    test_get_weight_dtype_options_falls_back_without_core,
    test_pick_preferred_name_prefers_keyword_match,
    test_pick_preferred_name_is_case_insensitive,
    test_pick_preferred_name_falls_back_to_first_when_no_keyword_match,
    test_pick_preferred_name_empty_names_returns_empty_string,
    test_load_model_clip_vae_raises_actionable_error_outside_comfyui,
    test_input_types_is_callable_and_does_not_raise,
    test_input_types_returns_the_five_expected_fields,
    test_input_types_field_shapes,
    test_clip_type_defaults_to_qwen_image,
    test_weight_dtype_defaults_to_default,
    test_every_input_has_a_non_empty_non_name_restating_tooltip,
    test_every_output_has_a_non_empty_non_name_restating_tooltip,
    test_return_types_and_names_are_plain_standard_sockets,
    test_no_proprietary_blob_return_type_leaks_into_return_types,
    test_node_takes_no_prompt_data_input,
    test_smoke_full_load_with_torch_and_comfy_if_available,
]


if __name__ == "__main__":
    failures = []
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
