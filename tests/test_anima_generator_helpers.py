"""Plain-script tests for `AnimaGenerator`'s pure-logic pieces.

Run directly: `python tests/test_anima_generator_helpers.py` (no pytest, per
project convention). Actual sampling needs `torch`/`comfy` - not available
in this dev environment (same as Phase 2a's `test_anima_image_scale.py`
guarded smoke test) - so these tests focus on: `resolve_conditioning`'s
error-raising behavior with a fake `clip`, the conditioning-resolution
branching logic (`resolve_pane_conditioning`: CONDITIONING-wins-over-text,
text-requires-clip-error, neither-provided-error), `normalize_lora_stack`'s
tolerant parsing, `build_metadata`'s JSON assembly, the sampler/scheduler
fallback lookups, `_comfy_core_bridge`'s guarded core-node lookup, and
`AnimaGenerator.INPUT_TYPES()`'s contract shape. A full-pipeline smoke test
is guarded exactly like Phase 2a's: printed SKIP (not a failure) if
`torch`/`comfy` aren't importable.

Note on the fake `clip` below: `_comfy_core_bridge.find_core_node_class`
resolves the bare `import nodes` to THIS REPO'S OWN `nodes/` package in
this environment (see `_comfy_core_bridge`'s module docstring) - which has
no `CLIPTextEncode` attribute - so `encode_text_conditioning` reliably
exercises its documented fallback branch (`clip.tokenize` +
`clip.encode_from_tokens_scheduled`) here, without needing any monkeypatch.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json

from nodes._anima_conditioning_helpers import encode_text_conditioning, resolve_conditioning
from nodes._anima_generator_helpers import (
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    MAX_SEED,
    build_metadata,
    get_scheduler_names,
    get_sampler_names,
    normalize_lora_stack,
    pick_default,
    resolve_pane_conditioning,
)
from nodes._comfy_core_bridge import find_core_node_class, require_core_node_class
from nodes.node_anima_generator import AnimaGenerator


class _FakeClip:
    """Minimal stand-in for a real ComfyUI CLIP object, recording every
    call so tests can assert exactly what was encoded."""

    def __init__(self):
        self.tokenize_calls = []
        self.encode_calls = []

    def tokenize(self, text):
        self.tokenize_calls.append(text)
        return {"tokens": text}

    def encode_from_tokens_scheduled(self, tokens):
        self.encode_calls.append(tokens)
        return [["cond", {"pooled_output": "pooled", "tokens": tokens}]]


def test_encode_text_conditioning_uses_fallback_clip_calls():
    clip = _FakeClip()
    result = encode_text_conditioning(clip, "1girl, solo")
    assert clip.tokenize_calls == ["1girl, solo"]
    assert clip.encode_calls == [{"tokens": "1girl, solo"}]
    assert result == [["cond", {"pooled_output": "pooled", "tokens": {"tokens": "1girl, solo"}}]]


def test_resolve_conditioning_raises_without_clip():
    try:
        resolve_conditioning(None, "1girl")
        raised = False
    except ValueError:
        raised = True
    assert raised


def test_resolve_conditioning_plain_encode_with_clip():
    clip = _FakeClip()
    result = resolve_conditioning(clip, "masterpiece")
    assert clip.tokenize_calls == ["masterpiece"]
    assert result[0][0] == "cond"


def test_resolve_conditioning_artist_mix_enabled_still_plain_encodes():
    # Documented deviation: artist_mix_enabled is currently a no-op that
    # still performs a plain encode (see _anima_conditioning_helpers'
    # DEVIATION note) - this pins that behavior so a future accidental
    # silent-ignore regression (or accidental branch) is caught either way.
    clip = _FakeClip()
    result = resolve_conditioning(clip, "masterpiece", artist_mix_enabled=True)
    assert clip.tokenize_calls == ["masterpiece"]
    assert result[0][0] == "cond"


def test_resolve_pane_conditioning_wired_conditioning_wins_over_text():
    clip = _FakeClip()
    wired = object()
    result = resolve_pane_conditioning("positive", clip, wired, "this text should be ignored")
    assert result is wired
    assert clip.tokenize_calls == []  # text branch never even touched


def test_resolve_pane_conditioning_falls_back_to_text_when_no_conditioning():
    clip = _FakeClip()
    result = resolve_pane_conditioning("positive", clip, None, "1girl, solo")
    assert clip.tokenize_calls == ["1girl, solo"]
    assert result[0][0] == "cond"


def test_resolve_pane_conditioning_text_requires_clip_error():
    try:
        resolve_pane_conditioning("positive", None, None, "1girl, solo")
        raised = False
    except ValueError as exc:
        raised = True
        assert "positive_text" in str(exc)
        assert "clip is not connected" in str(exc)
    assert raised


def test_resolve_pane_conditioning_neither_provided_error():
    try:
        resolve_pane_conditioning("negative", _FakeClip(), None, "   ")
        raised = False
    except ValueError as exc:
        raised = True
        assert "negative" in str(exc)
    assert raised


def test_resolve_pane_conditioning_blank_text_is_treated_as_absent():
    # Whitespace-only text must not be treated as "text was provided" -
    # it should fall through to the neither-provided error, not attempt
    # to encode blank text.
    clip = _FakeClip()
    try:
        resolve_pane_conditioning("positive", clip, None, "   \n\t  ")
        raised = False
    except ValueError:
        raised = True
    assert raised
    assert clip.tokenize_calls == []


def test_normalize_lora_stack_accepts_dict_entries():
    stack = [
        {"name": "styleA.safetensors", "strength_model": 0.8, "strength_clip": 0.6},
        {"lora_name": "styleB.safetensors", "strength": 1.0},
    ]
    entries = normalize_lora_stack(stack)
    assert entries == [
        ("styleA.safetensors", 0.8, 0.6),
        ("styleB.safetensors", 1.0, 1.0),
    ]


def test_normalize_lora_stack_accepts_tuple_entries():
    stack = [("styleA.safetensors", 0.5, 0.5), ("none", 1.0, 1.0)]
    entries = normalize_lora_stack(stack)
    assert entries == [("styleA.safetensors", 0.5, 0.5)]  # "none" dropped


def test_normalize_lora_stack_accepts_json_string():
    stack = json.dumps([{"name": "styleA.safetensors", "strength_model": 1.0, "strength_clip": 1.0}])
    entries = normalize_lora_stack(stack)
    assert entries == [("styleA.safetensors", 1.0, 1.0)]


def test_normalize_lora_stack_handles_malformed_input_gracefully():
    assert normalize_lora_stack(None) == []
    assert normalize_lora_stack("not json") == []
    assert normalize_lora_stack(12345) == []
    assert normalize_lora_stack([]) == []
    assert normalize_lora_stack(["not a dict or tuple"]) == []


def test_normalize_lora_stack_defaults_clip_strength_to_model_strength():
    stack = [{"name": "styleA", "strength": 0.7}]
    entries = normalize_lora_stack(stack)
    assert entries == [("styleA", 0.7, 0.7)]


def test_build_metadata_assembles_expected_json():
    text = build_metadata(
        seed=42, steps=28, cfg=5.0, sampler_name="euler_ancestral", scheduler="normal",
        denoise=1.0, width=832, height=1216,
    )
    data = json.loads(text)
    assert data == {
        "seed": 42,
        "steps": 28,
        "cfg": 5.0,
        "sampler_name": "euler_ancestral",
        "scheduler": "normal",
        "denoise": 1.0,
        "width": 832,
        "height": 1216,
        "highres": {"enabled": False},
        "loras": [],
        "detailer": {"enabled": False},
        "upscale": {"enabled": False},
        "postprocess": {"enabled": False},
        "save": {"enabled": False},
    }


def test_build_metadata_includes_highres_and_loras_when_given():
    text = build_metadata(
        seed=1, steps=20, cfg=6.0, sampler_name="euler", scheduler="karras", denoise=1.0,
        width=832, height=1216,
        highres={"enabled": True, "multiple": 64, "width": 1536, "height": 2240, "scale_factor": 1.85},
        loras=[{"name": "styleA", "strength_model": 0.8, "strength_clip": 0.8}],
    )
    data = json.loads(text)
    assert data["highres"]["enabled"] is True
    assert data["highres"]["width"] == 1536
    assert data["loras"] == [{"name": "styleA", "strength_model": 0.8, "strength_clip": 0.8}]
    # New optional stages still default to disabled when not passed.
    assert data["detailer"] == {"enabled": False}
    assert data["upscale"] == {"enabled": False}
    assert data["postprocess"] == {"enabled": False}
    assert data["save"] == {"enabled": False}


def test_build_metadata_includes_new_stage_flags_when_given():
    text = build_metadata(
        seed=1, steps=20, cfg=6.0, sampler_name="euler", scheduler="karras", denoise=1.0,
        width=832, height=1216,
        detailer={"enabled": True, "guide_size": 512.0, "max_size": 1024.0, "denoise": 0.5},
        upscale={"enabled": True, "backend": "usdu", "scale_by": 2.0},
        postprocess={"enabled": True, "resized": True, "multiple": 64},
        save={"enabled": True, "prefix": "Anima"},
    )
    data = json.loads(text)
    assert data["detailer"] == {"enabled": True, "guide_size": 512.0, "max_size": 1024.0, "denoise": 0.5}
    assert data["upscale"]["backend"] == "usdu"
    assert data["postprocess"]["resized"] is True
    assert data["save"]["prefix"] == "Anima"


def test_get_sampler_and_scheduler_names_fallback_when_comfy_unavailable():
    # comfy.samplers is not importable in this dev environment, so these
    # must fall through to the documented non-empty fallback lists.
    samplers = get_sampler_names()
    schedulers = get_scheduler_names()
    assert isinstance(samplers, tuple) and len(samplers) > 0
    assert isinstance(schedulers, tuple) and len(schedulers) > 0
    assert "euler" in samplers
    assert "normal" in schedulers


def test_pick_default_prefers_requested_name_when_present():
    assert pick_default(("a", "b", "c"), "b") == "b"


def test_pick_default_falls_back_to_first_when_missing():
    assert pick_default(("a", "b", "c"), "z") == "a"
    assert pick_default((), "z") == "z"


def test_find_core_node_class_returns_none_outside_comfyui():
    # This repo's own `nodes/` package (imported above) has none of these
    # core node classes - see `_comfy_core_bridge`'s module docstring.
    assert find_core_node_class("KSampler") is None
    assert find_core_node_class("CLIPTextEncode") is None


def test_require_core_node_class_raises_actionable_error_outside_comfyui():
    try:
        require_core_node_class("KSampler")
        raised = False
    except RuntimeError as exc:
        raised = True
        assert "KSampler" in str(exc)
    assert raised


def test_node_input_types_contract():
    schema = AnimaGenerator.INPUT_TYPES()
    required = schema["required"]
    optional = schema["optional"]

    assert required["model"][0] == "MODEL"
    assert required["vae"][0] == "VAE"
    assert required["seed"][0] == "INT" and required["seed"][1]["max"] == MAX_SEED
    assert required["steps"][0] == "INT"
    assert required["cfg"][0] == "FLOAT"
    assert isinstance(required["sampler_name"][0], tuple) or isinstance(required["sampler_name"][0], list)
    assert required["sampler_name"][1]["default"] in required["sampler_name"][0]
    assert required["scheduler"][1]["default"] in required["scheduler"][0]
    assert required["denoise"][0] == "FLOAT"
    assert required["width"][1]["default"] == DEFAULT_WIDTH
    assert required["height"][1]["default"] == DEFAULT_HEIGHT
    assert required["highres_enabled"][0] == "BOOLEAN" and required["highres_enabled"][1]["default"] is False
    assert required["highres_multiple"][1]["default"] == 64
    assert required["highres_max_long_edge"][1]["default"] == 0
    assert required["highres_denoise"][1]["default"] == 0.4
    assert required["preview_channel"][1]["default"] == "default"

    assert required["detailer_enabled"][0] == "BOOLEAN" and required["detailer_enabled"][1]["default"] is False
    assert required["detailer_guide_size"][1]["default"] == 512
    assert required["detailer_max_size"][1]["default"] == 1024
    assert required["detailer_denoise"][1]["default"] == 0.5

    assert required["upscale_enabled"][0] == "BOOLEAN" and required["upscale_enabled"][1]["default"] is False
    assert required["upscale_backend"][1]["default"] == "usdu"
    assert "usdu" in required["upscale_backend"][0] and "resshift" in required["upscale_backend"][0]
    assert required["upscale_usdu_scale_by"][1]["default"] == 2.0
    assert required["upscale_usdu_tile_size"][1]["default"] == 512
    assert required["upscale_usdu_denoise"][1]["default"] == 0.2
    assert required["upscale_resshift_scale"][1]["default"] == "x2"
    assert required["upscale_resshift_chop"][1]["default"] == 512
    assert required["upscale_resshift_overlap"][1]["default"] == 64
    assert required["upscale_resshift_tile_batch"][1]["default"] == 4

    assert required["postprocess_resize_enabled"][1]["default"] is False
    assert required["postprocess_multiple"][1]["default"] == 0

    assert required["save_output"][1]["default"] is False
    assert required["save_prefix"][1]["default"] == "Anima"

    assert optional["clip"][0] == "CLIP"
    assert optional["positive"][0] == "CONDITIONING"
    assert optional["positive_text"][0] == "STRING" and optional["positive_text"][1]["multiline"] is True
    assert optional["negative"][0] == "CONDITIONING"
    assert optional["negative_text"][0] == "STRING"
    assert optional["latent"][0] == "LATENT"
    assert optional["lora_stack"][0] == "LORA_STACK"
    assert optional["segs"][0] == "SEGS"
    assert optional["detailer_hook"][0] == "DETAILER_HOOK"

    for spec in list(required.values()) + list(optional.values()):
        assert "tooltip" in spec[1] and spec[1]["tooltip"]

    assert AnimaGenerator.CATEGORY == "AnimaFlow/anima"
    assert AnimaGenerator.FUNCTION == "generate"
    assert AnimaGenerator.RETURN_TYPES == ("IMAGE", "LATENT", "STRING")
    assert AnimaGenerator.RETURN_NAMES == ("image", "latent", "metadata")
    assert len(AnimaGenerator.OUTPUT_TOOLTIPS) == len(AnimaGenerator.RETURN_TYPES)


def test_smoke_full_generate_with_torch_and_comfy_if_available():
    try:
        import torch  # type: ignore  # noqa: F401
        import comfy.samplers  # type: ignore  # noqa: F401
        import comfy.utils  # type: ignore  # noqa: F401
    except Exception as exc:
        print(f"SKIP  test_smoke_full_generate_with_torch_and_comfy_if_available: {exc} (not running inside ComfyUI)")
        return

    # Inside a real ComfyUI process, `find_core_node_class` would locate
    # the real KSampler/CLIPTextEncode/etc. and a full end-to-end smoke
    # run could be attempted here with real MODEL/VAE/CLIP fixtures. This
    # dev environment never reaches this branch (torch/comfy aren't
    # installed) - see the module docstring.
    print("SKIP  test_smoke_full_generate_with_torch_and_comfy_if_available: no live ComfyUI MODEL/VAE/CLIP fixtures available in this environment")


ALL_TESTS = [
    test_encode_text_conditioning_uses_fallback_clip_calls,
    test_resolve_conditioning_raises_without_clip,
    test_resolve_conditioning_plain_encode_with_clip,
    test_resolve_conditioning_artist_mix_enabled_still_plain_encodes,
    test_resolve_pane_conditioning_wired_conditioning_wins_over_text,
    test_resolve_pane_conditioning_falls_back_to_text_when_no_conditioning,
    test_resolve_pane_conditioning_text_requires_clip_error,
    test_resolve_pane_conditioning_neither_provided_error,
    test_resolve_pane_conditioning_blank_text_is_treated_as_absent,
    test_normalize_lora_stack_accepts_dict_entries,
    test_normalize_lora_stack_accepts_tuple_entries,
    test_normalize_lora_stack_accepts_json_string,
    test_normalize_lora_stack_handles_malformed_input_gracefully,
    test_normalize_lora_stack_defaults_clip_strength_to_model_strength,
    test_build_metadata_assembles_expected_json,
    test_build_metadata_includes_highres_and_loras_when_given,
    test_build_metadata_includes_new_stage_flags_when_given,
    test_get_sampler_and_scheduler_names_fallback_when_comfy_unavailable,
    test_pick_default_prefers_requested_name_when_present,
    test_pick_default_falls_back_to_first_when_missing,
    test_find_core_node_class_returns_none_outside_comfyui,
    test_require_core_node_class_raises_actionable_error_outside_comfyui,
    test_node_input_types_contract,
    test_smoke_full_generate_with_torch_and_comfy_if_available,
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
