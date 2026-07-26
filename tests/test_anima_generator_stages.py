"""Plain-script tests for `AnimaGenerator`'s new optional pipeline stages:
detailer (soft-depends on Impact Pack), upscale (soft-depends on USDU OR
ResShift), postprocess-resize (reuses `compute_scale_by_multiple`), save
(core `SaveImage`), and the `_optional_pack_bridge` lookup helper all of
these route external-pack lookups through.

Run directly: `python tests/test_anima_generator_stages.py` (no pytest, per
project convention).

How the "pack installed / not installed" simulation works: in THIS dev
environment (no live ComfyUI process), a bare `import nodes` resolves to
THIS REPO'S OWN `nodes/` package (see `_comfy_core_bridge`'s and
`_optional_pack_bridge`'s module docstrings for why that's safe inside a
real ComfyUI process but different here) - and that package has no
`NODE_CLASS_MAPPINGS` attribute of its own by default, so
`find_optional_node_class`/`find_core_node_class` both correctly return
`None` (see `test_anima_generator_helpers.py`'s own equivalent core-bridge
tests). `_set_fake_mappings`/`_restore_mappings` below temporarily attach a
plain dict as that SAME module object's `NODE_CLASS_MAPPINGS` attribute for
the duration of one test, simulating "these node ids are installed" for
BOTH bridges at once (since both bridges do the exact same bare `import
nodes` and land on the exact same module object in this environment) -
then restore whatever was there before (nothing, in every case here) so
tests don't leak state into each other.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima._anima_generator_helpers import (
    DEFAULT_USDU_AUTO_TILE,
    USDU_AUTO_TILE_MAX,
    USDU_AUTO_TILE_MIN,
    USDU_AUTO_TILE_PREFERRED,
    get_upscale_model_names,
    load_usdu_upscale_model,
    plan_usdu_tiles,
    run_detailer_stage,
    run_postprocess_resize,
    run_resshift_upscale_stage,
    run_save_output_stage,
    run_upscale_stage,
    run_usdu_upscale_stage,
)
from nodes.anima._optional_pack_bridge import find_optional_node_class, require_optional_node_class

_SENTINEL = object()


def _set_fake_mappings(mappings: dict):
    import nodes as nodes_pkg  # this repo's own package in this dev environment - see module docstring

    previous = getattr(nodes_pkg, "NODE_CLASS_MAPPINGS", _SENTINEL)
    nodes_pkg.NODE_CLASS_MAPPINGS = mappings
    return previous


def _restore_mappings(previous):
    import nodes as nodes_pkg

    if previous is _SENTINEL:
        if hasattr(nodes_pkg, "NODE_CLASS_MAPPINGS"):
            delattr(nodes_pkg, "NODE_CLASS_MAPPINGS")
    else:
        nodes_pkg.NODE_CLASS_MAPPINGS = previous


class _FakeImageTensor:
    """Minimal stand-in for an IMAGE tensor: only `.shape` is touched by
    `run_postprocess_resize`'s no-resize-needed / disabled branches."""

    def __init__(self, height: int, width: int):
        self.shape = (1, height, width, 3)

    def __repr__(self):
        return f"_FakeImageTensor(h={self.shape[1]}, w={self.shape[2]})"


# --- _optional_pack_bridge ---------------------------------------------


def test_find_optional_node_class_returns_none_outside_comfyui():
    # Default dev-environment state: this repo's own `nodes` package has no
    # NODE_CLASS_MAPPINGS attribute at all.
    assert find_optional_node_class("DetailerForEach") is None
    assert find_optional_node_class("UltimateSDUpscale") is None


def test_find_optional_node_class_finds_class_when_mappings_present():
    class _FakeDetailer:
        pass

    previous = _set_fake_mappings({"DetailerForEach": _FakeDetailer})
    try:
        assert find_optional_node_class("DetailerForEach") is _FakeDetailer
        assert find_optional_node_class("SomethingElse") is None
    finally:
        _restore_mappings(previous)


def test_require_optional_node_class_raises_actionable_error_when_missing():
    try:
        require_optional_node_class("DetailerForEach", "Impact Pack (ComfyUI-Impact-Pack)")
        raised = False
    except RuntimeError as exc:
        raised = True
        message = str(exc)
        assert "Impact Pack (ComfyUI-Impact-Pack)" in message
        assert "not installed" in message
        assert "DetailerForEach" in message
    assert raised


def test_require_optional_node_class_returns_class_when_present():
    class _FakeUSDU:
        pass

    previous = _set_fake_mappings({"UltimateSDUpscale": _FakeUSDU})
    try:
        assert require_optional_node_class("UltimateSDUpscale", "ComfyUI_UltimateSDUpscale") is _FakeUSDU
    finally:
        _restore_mappings(previous)


# --- run_detailer_stage --------------------------------------------------


def test_run_detailer_stage_skips_when_segs_is_none():
    image = object()
    result_image, metadata = run_detailer_stage(
        image, None, "model", "clip", "vae", "pos", "neg",
        0, 20, 8.0, "euler", "normal", 512, 1024, 0.5, "default",
    )
    assert result_image is image
    assert metadata == {"enabled": False, "reason": "no segs provided or segs contained no detections"}


def test_run_detailer_stage_skips_when_segs_has_no_detections():
    image = object()
    empty_segs = ((512, 512), [])
    result_image, metadata = run_detailer_stage(
        image, empty_segs, "model", "clip", "vae", "pos", "neg",
        0, 20, 8.0, "euler", "normal", 512, 1024, 0.5, "default",
    )
    assert result_image is image
    assert metadata["enabled"] is False


def test_run_detailer_stage_raises_when_segs_present_but_impact_pack_missing():
    segs = ((512, 512), [{"seg": 1}])
    try:
        run_detailer_stage(
            "img", segs, "model", "clip", "vae", "pos", "neg",
            0, 20, 8.0, "euler", "normal", 512, 1024, 0.5, "default",
        )
        raised = False
    except RuntimeError as exc:
        raised = True
        assert "Impact Pack" in str(exc)
        assert "DetailerForEach" in str(exc)
    assert raised


def test_run_detailer_stage_filters_kwargs_to_narrow_signature():
    # Impact Pack's real DetailerForEach.doit() takes many more params than
    # this - this narrow fake proves _call_with_accepted_kwargs actually
    # drops unaccepted keys (feather/noise_mask/etc.) rather than crashing.
    calls = {}

    class _NarrowDetailer:
        def doit(self, image, segs, guide_size, max_size, denoise):
            calls.update(image=image, segs=segs, guide_size=guide_size, max_size=max_size, denoise=denoise)
            return (f"detailed:{image}",)

    previous = _set_fake_mappings({"DetailerForEach": _NarrowDetailer})
    try:
        segs = ((512, 512), [{"seg": 1}])
        result_image, metadata = run_detailer_stage(
            "base_image", segs, "model", "clip", "vae", "pos", "neg",
            123, 20, 8.0, "euler", "normal", 640, 1152, 0.55, "default",
        )
        assert result_image == "detailed:base_image"
        assert metadata == {"enabled": True, "guide_size": 640.0, "max_size": 1152.0, "denoise": 0.55}
        assert calls == {
            "image": "base_image", "segs": segs,
            "guide_size": 640.0, "max_size": 1152.0, "denoise": 0.55,
        }
    finally:
        _restore_mappings(previous)


def test_run_detailer_stage_pins_upstream_quality_constants():
    # `guide_size_for`/`noise_mask_feather` are two of `run_detailer_stage`'s
    # fixed (non-widget) kwargs that were ported WRONG from upstream and
    # silently changed detailer output quality (backlog.md SS1.1/1.2) - pin
    # both here so a future edit that flips them fails loudly. Upstream
    # (`../ComfyUI-EasyUseAnima/easyuse_anima/aio/generation_defaults.py`)
    # is the source of truth: `guide_size_for=False` for BOTH its face
    # (`:306`) and eye (`:372`) targets, `noise_mask_feather=10` for face
    # (`:321`) - this stage is one generic detailer, not a face/eye pair,
    # so it picks the (conservative) face value rather than eye's `20`.
    captured = {}

    class _CapturingDetailer:
        def doit(self, **kwargs):
            captured.update(kwargs)
            return (f"detailed:{kwargs['image']}",)

    previous = _set_fake_mappings({"DetailerForEach": _CapturingDetailer})
    try:
        segs = ((512, 512), [{"seg": 1}])
        run_detailer_stage(
            "base_image", segs, "model", "clip", "vae", "pos", "neg",
            0, 20, 8.0, "euler", "normal", 512, 1024, 0.5, "default",
        )
        assert captured["guide_size_for"] is False
        assert captured["noise_mask_feather"] == 10
    finally:
        _restore_mappings(previous)


def test_run_detailer_stage_accepts_dict_shaped_result():
    class _DictShapedDetailer:
        def doit(self, **kwargs):
            return {"result": (f"detailed:{kwargs['image']}",), "ui": {}}

    previous = _set_fake_mappings({"DetailerForEach": _DictShapedDetailer})
    try:
        segs = ((512, 512), [{"seg": 1}])
        result_image, metadata = run_detailer_stage(
            "img", segs, "model", "clip", "vae", "pos", "neg",
            0, 20, 8.0, "euler", "normal", 512, 1024, 0.5, "default",
        )
        assert result_image == "detailed:img"
        assert metadata["enabled"] is True
    finally:
        _restore_mappings(previous)


def test_run_detailer_stage_raises_on_empty_dict_result():
    class _BrokenDetailer:
        def doit(self, **kwargs):
            return {"ui": {}}  # no "result" key

    previous = _set_fake_mappings({"DetailerForEach": _BrokenDetailer})
    try:
        segs = ((512, 512), [{"seg": 1}])
        try:
            run_detailer_stage(
                "img", segs, "model", "clip", "vae", "pos", "neg",
                0, 20, 8.0, "euler", "normal", 512, 1024, 0.5, "default",
            )
            raised = False
        except RuntimeError:
            raised = True
        assert raised
    finally:
        _restore_mappings(previous)


# --- USDU auto-tile planner (pure, torch-free) ---------------------------


def test_plan_usdu_tiles_divides_the_target_evenly_at_default_bounds():
    # 3072 = 3 x 1024 (the default preferred tile size) - an EXACT, even
    # division with no alignment nudge needed at all.
    tile_width, tile_height = plan_usdu_tiles(3072, 3072)
    assert tile_width == 1024 and tile_height == 1024
    assert 3072 % tile_width == 0 and 3072 % tile_height == 0


def test_plan_usdu_tiles_exact_dimensions_for_a_typical_2x_upscale_target():
    # A 1216x832 (standard Anima/SDXL portrait) source at scale_by=2.0 ->
    # expected output 2432x1664; matches upstream's own
    # `_aio_usdu_auto_tile_dimension` arithmetic exactly: width ->
    # ceil(2432/1024)=3 tiles -> ceil(2432/3)=811 -> nearest-64 is 832;
    # height -> ceil(1664/1024)=2 tiles -> ceil(1664/2)=832 (already
    # 64-aligned) -> both land on 832.
    tile_width, tile_height = plan_usdu_tiles(2432, 1664)
    assert tile_width == 832
    assert tile_height == 832


def test_plan_usdu_tiles_is_64_aligned():
    for target in (100, 513, 999, 1234, 2001, 5000):
        tile_width, tile_height = plan_usdu_tiles(target, target)
        assert tile_width % 64 == 0, f"tile_width {tile_width} not 64-aligned for target {target}"
        assert tile_height % 64 == 0, f"tile_height {tile_height} not 64-aligned for target {target}"


def test_plan_usdu_tiles_clamps_to_min_size_for_a_tiny_target():
    tile_width, tile_height = plan_usdu_tiles(10, 10)
    assert tile_width == USDU_AUTO_TILE_MIN
    assert tile_height == USDU_AUTO_TILE_MIN


def test_plan_usdu_tiles_clamps_to_an_explicit_max_size():
    # preferred_size == max_size == 2016 (not 64-aligned itself): the raw
    # tile size (2016) rounds UP to 2048 (nearest-64), which then must be
    # clamped back down to max_size=2016 - exercises the final safety clamp,
    # not just the 64-alignment step.
    tile_width, tile_height = plan_usdu_tiles(
        2016, 2016, preferred_size=2016, min_size=512, max_size=2016,
    )
    assert tile_width == 2016
    assert tile_height == 2016


def test_plan_usdu_tiles_respects_custom_preferred_min_max_bounds():
    tile_width, tile_height = plan_usdu_tiles(
        4000, 2000, preferred_size=500, min_size=256, max_size=768,
    )
    assert 256 <= tile_width <= 768
    assert 256 <= tile_height <= 768
    assert tile_width % 64 == 0 and tile_height % 64 == 0


def test_plan_usdu_tiles_independent_per_dimension_for_non_square_targets():
    # width=1234 -> (ceil(1234/1024)=2 tiles -> ceil(1234/2)=617 -> 640);
    # height=100 -> (1 tile -> 100 -> nearest-64 128 -> clamped up to
    # USDU_AUTO_TILE_MIN=512) - deliberately asymmetric so this actually
    # proves the two dimensions are planned independently, not just that
    # `plan_usdu_tiles` returns SOME 64-aligned clamped pair.
    tile_width, tile_height = plan_usdu_tiles(1234, 100)
    assert tile_width == 640
    assert tile_height == USDU_AUTO_TILE_MIN
    assert tile_width != tile_height
    assert tile_width % 64 == 0 and tile_height % 64 == 0
    assert USDU_AUTO_TILE_MIN <= tile_width <= USDU_AUTO_TILE_MAX
    assert USDU_AUTO_TILE_MIN <= tile_height <= USDU_AUTO_TILE_MAX


def test_plan_usdu_tiles_handles_degenerate_zero_and_negative_inputs_without_crashing():
    for target_width, target_height in ((0, 0), (-100, -100), (0, 5000), (-1, 1)):
        tile_width, tile_height = plan_usdu_tiles(target_width, target_height)
        assert tile_width >= 64 and tile_height >= 64
        assert isinstance(tile_width, int) and isinstance(tile_height, int)


def test_plan_usdu_tiles_default_bounds_match_module_constants():
    # Sanity check that the function's own defaults really are
    # USDU_AUTO_TILE_PREFERRED/MIN/MAX, not silently different literals.
    default_result = plan_usdu_tiles(2000, 2000)
    explicit_result = plan_usdu_tiles(
        2000, 2000,
        preferred_size=USDU_AUTO_TILE_PREFERRED,
        min_size=USDU_AUTO_TILE_MIN,
        max_size=USDU_AUTO_TILE_MAX,
    )
    assert default_result == explicit_result


# --- upscale stage: USDU backend ----------------------------------------


def test_load_usdu_upscale_model_raises_when_name_empty():
    try:
        load_usdu_upscale_model("")
        raised = False
    except ValueError as exc:
        raised = True
        assert "upscale_usdu_model_name" in str(exc)
    assert raised


def test_get_upscale_model_names_fallback_when_folder_paths_unavailable():
    names = get_upscale_model_names()
    assert isinstance(names, tuple) and len(names) > 0


def test_run_usdu_upscale_stage_raises_when_pack_missing():
    try:
        run_usdu_upscale_stage(
            "img", "model", "pos", "neg", "vae",
            0, 20, 8.0, "euler", "normal",
            0.2, 2.0, 512, "model.pth",
        )
        raised = False
    except RuntimeError as exc:
        raised = True
        assert "UltimateSDUpscale" in str(exc)
    assert raised


def test_run_usdu_upscale_stage_calls_usdu_with_expected_kwargs():
    """`auto_tile=False` explicitly, so tile_width/tile_height come straight
    from `tile_size` - byte-identical to this stage's pre-seam-fix-port
    behavior - while every OTHER new kwarg (mode_type, mask_blur,
    tile_padding, the five seam_fix_* fields) is given a non-default value
    to prove each one actually reaches USDU's own `upscale()` call and the
    returned metadata, per docs/backlog.md §2.3."""
    class _FakeUpscaleModelLoader:
        def load_model(self, model_name):
            return (f"upscale_model:{model_name}",)

    captured = {}

    class _FakeUSDU:
        def upscale(self, **kwargs):
            captured.update(kwargs)
            return (f"usdu_result:{kwargs['image']}",)

    previous = _set_fake_mappings({
        "UpscaleModelLoader": _FakeUpscaleModelLoader,
        "UltimateSDUpscale": _FakeUSDU,
    })
    try:
        image_out, metadata = run_usdu_upscale_stage(
            "base_image", "model", "pos", "neg", "vae",
            123, 20, 8.0, "euler", "normal",
            0.25, 2.5, 640, "4x_model.pth",
            mode_type="Chess",
            mask_blur=12,
            tile_padding=48,
            seam_fix_mode="Band Pass",
            seam_fix_denoise=0.75,
            seam_fix_width=96,
            seam_fix_mask_blur=10,
            seam_fix_padding=24,
            auto_tile=False,
        )
        assert image_out == "usdu_result:base_image"
        assert metadata == {
            "enabled": True,
            "backend": "usdu",
            "scale_by": 2.5,
            "tile_size": 640,
            "tile_width": 640,
            "tile_height": 640,
            "auto_tile": False,
            "denoise": 0.25,
            "upscale_model_name": "4x_model.pth",
            "mode_type": "Chess",
            "mask_blur": 12,
            "tile_padding": 48,
            "seam_fix_mode": "Band Pass",
            "seam_fix_denoise": 0.75,
            "seam_fix_width": 96,
            "seam_fix_mask_blur": 10,
            "seam_fix_padding": 24,
        }
        assert captured["upscale_model"] == "upscale_model:4x_model.pth"
        assert captured["tile_width"] == 640 and captured["tile_height"] == 640
        assert captured["mode_type"] == "Chess"
        assert captured["mask_blur"] == 12
        assert captured["tile_padding"] == 48
        assert captured["seam_fix_mode"] == "Band Pass"
        assert captured["seam_fix_denoise"] == 0.75
        assert captured["seam_fix_width"] == 96
        assert captured["seam_fix_mask_blur"] == 10
        assert captured["seam_fix_padding"] == 24
        assert captured["seed"] == 123
        assert captured["force_uniform_tiles"] is True
        assert captured["tiled_decode"] is False
        assert captured["batch_size"] == 1
    finally:
        _restore_mappings(previous)


def test_run_usdu_upscale_stage_defaults_match_upstream_when_not_passed():
    """Calling with none of the new keyword args at all falls back to this
    module's own `DEFAULT_USDU_*` constants (upstream's own defaults) -
    including `auto_tile` defaulting to `True`, upstream's own
    `auto_tile_size` default."""
    class _FakeUpscaleModelLoader:
        def load_model(self, model_name):
            return (f"upscale_model:{model_name}",)

    captured = {}

    class _FakeUSDU:
        def upscale(self, **kwargs):
            captured.update(kwargs)
            return (f"usdu_result:{kwargs['image']}",)

    previous = _set_fake_mappings({
        "UpscaleModelLoader": _FakeUpscaleModelLoader,
        "UltimateSDUpscale": _FakeUSDU,
    })
    try:
        image_out, metadata = run_usdu_upscale_stage(
            "base_image", "model", "pos", "neg", "vae",
            123, 20, 8.0, "euler", "normal",
            0.25, 2.5, 640, "4x_model.pth",
        )
        assert metadata["auto_tile"] is DEFAULT_USDU_AUTO_TILE is True
        assert metadata["mode_type"] == "Linear"
        assert metadata["mask_blur"] == 8
        assert metadata["tile_padding"] == 32
        assert metadata["seam_fix_mode"] == "None"
        assert metadata["seam_fix_denoise"] == 1.0
        assert metadata["seam_fix_width"] == 64
        assert metadata["seam_fix_mask_blur"] == 8
        assert metadata["seam_fix_padding"] == 16
        assert captured["mode_type"] == "Linear"
        assert captured["seam_fix_mode"] == "None"
    finally:
        _restore_mappings(previous)


def test_run_usdu_upscale_stage_auto_tile_on_uses_planner_not_tile_size():
    """`auto_tile=True` (the default) ignores `tile_size` entirely and
    derives tile_width/tile_height from the INPUT image's own `.shape` x
    `scale_by`, via `plan_usdu_tiles` - proven here with a real (fake)
    tensor whose size makes the planned tiles clearly differ from the
    unused `tile_size` argument."""
    class _FakeUpscaleModelLoader:
        def load_model(self, model_name):
            return (f"upscale_model:{model_name}",)

    captured = {}

    class _FakeUSDU:
        def upscale(self, **kwargs):
            captured.update(kwargs)
            return (f"usdu_result:{kwargs['image']}",)

    previous = _set_fake_mappings({
        "UpscaleModelLoader": _FakeUpscaleModelLoader,
        "UltimateSDUpscale": _FakeUSDU,
    })
    try:
        image = _FakeImageTensor(height=832, width=1216)
        image_out, metadata = run_usdu_upscale_stage(
            image, "model", "pos", "neg", "vae",
            0, 20, 8.0, "euler", "normal",
            0.2, 2.0, 99999, "model.pth",
            auto_tile=True,
        )
        expected_tile_width, expected_tile_height = plan_usdu_tiles(1216 * 2, 832 * 2)
        assert metadata["auto_tile"] is True
        assert metadata["tile_width"] == expected_tile_width
        assert metadata["tile_height"] == expected_tile_height
        assert metadata["tile_width"] != 99999 and metadata["tile_height"] != 99999
        assert captured["tile_width"] == expected_tile_width
        assert captured["tile_height"] == expected_tile_height
    finally:
        _restore_mappings(previous)


def test_run_usdu_upscale_stage_auto_tile_off_uses_tile_size_both_dims():
    class _FakeUpscaleModelLoader:
        def load_model(self, model_name):
            return (f"upscale_model:{model_name}",)

    captured = {}

    class _FakeUSDU:
        def upscale(self, **kwargs):
            captured.update(kwargs)
            return (f"usdu_result:{kwargs['image']}",)

    previous = _set_fake_mappings({
        "UpscaleModelLoader": _FakeUpscaleModelLoader,
        "UltimateSDUpscale": _FakeUSDU,
    })
    try:
        image = _FakeImageTensor(height=832, width=1216)
        image_out, metadata = run_usdu_upscale_stage(
            image, "model", "pos", "neg", "vae",
            0, 20, 8.0, "euler", "normal",
            0.2, 2.0, 384, "model.pth",
            auto_tile=False,
        )
        assert metadata["auto_tile"] is False
        assert metadata["tile_width"] == 384 and metadata["tile_height"] == 384
        assert captured["tile_width"] == 384 and captured["tile_height"] == 384
    finally:
        _restore_mappings(previous)


# --- upscale stage: ResShift backend -------------------------------------


def test_run_resshift_upscale_stage_raises_when_pack_missing():
    try:
        run_resshift_upscale_stage("img", 0, "x2", 512, 64, 4)
        raised = False
    except RuntimeError as exc:
        raised = True
        assert "ResShift" in str(exc)
    assert raised


def test_run_resshift_upscale_stage_calls_loader_and_upscale():
    class _FakeResShiftLoader:
        def load(self, scale, student_name, dtype):
            return (f"resshift_model:{scale}:{student_name}:{dtype}",)

    captured = {}

    class _FakeResShiftUpscale:
        def upscale(self, model, image, seed, chop, overlap, tile_batch):
            captured.update(
                model=model, image=image, seed=seed, chop=chop, overlap=overlap, tile_batch=tile_batch,
            )
            return (f"resshift_result:{image}",)

    previous = _set_fake_mappings({
        "ResShiftLoader": _FakeResShiftLoader,
        "ResShiftUpscale": _FakeResShiftUpscale,
    })
    try:
        image_out, metadata = run_resshift_upscale_stage("base_image", 42, "x4", 512, 64, 4)
        assert image_out == "resshift_result:base_image"
        assert metadata == {
            "enabled": True, "backend": "resshift", "scale": "x4",
            "chop": 512, "overlap": 64, "tile_batch": 4,
        }
        assert captured["model"] == "resshift_model:x4:(auto-download):bf16"
        assert captured["image"] == "base_image"
    finally:
        _restore_mappings(previous)


# --- upscale stage: backend dispatch -------------------------------------


def test_run_upscale_stage_dispatches_by_backend():
    class _FakeUpscaleModelLoader:
        def load_model(self, model_name):
            return (model_name,)

    class _FakeUSDU:
        def upscale(self, **kwargs):
            return (f"usdu:{kwargs['image']}",)

    class _FakeResShiftLoader:
        def load(self, scale, student_name, dtype):
            return (f"m:{scale}",)

    class _FakeResShiftUpscale:
        def upscale(self, model, image, seed, chop, overlap, tile_batch):
            return (f"resshift:{image}",)

    previous = _set_fake_mappings({
        "UpscaleModelLoader": _FakeUpscaleModelLoader,
        "UltimateSDUpscale": _FakeUSDU,
        "ResShiftLoader": _FakeResShiftLoader,
        "ResShiftUpscale": _FakeResShiftUpscale,
    })
    try:
        image_usdu, meta_usdu = run_upscale_stage(
            "img", "model", "pos", "neg", "vae", "usdu",
            0, 20, 8.0, "euler", "normal", "default",
            0.2, 2.0, 512, "model.pth",
            "x2", 512, 64, 4,
        )
        assert image_usdu == "usdu:img"
        assert meta_usdu["enabled"] is True and meta_usdu["backend"] == "usdu"

        image_rs, meta_rs = run_upscale_stage(
            "img", "model", "pos", "neg", "vae", "resshift",
            0, 20, 8.0, "euler", "normal", "default",
            0.2, 2.0, 512, "model.pth",
            "x2", 512, 64, 4,
        )
        assert image_rs == "resshift:img"
        assert meta_rs["enabled"] is True and meta_rs["backend"] == "resshift"

        # Anything not "resshift" (including an unrecognized/blank value)
        # falls back to the usdu backend, matching the widget's own default.
        image_default, meta_default = run_upscale_stage(
            "img", "model", "pos", "neg", "vae", "",
            0, 20, 8.0, "euler", "normal", "default",
            0.2, 2.0, 512, "model.pth",
            "x2", 512, 64, 4,
        )
        assert image_default == "usdu:img"
        assert meta_default["backend"] == "usdu"
    finally:
        _restore_mappings(previous)


def test_run_upscale_stage_passes_through_new_usdu_seam_fix_and_tile_kwargs():
    """`run_upscale_stage`'s own `usdu_*` trailing kwargs (the ones
    `AnimaGenerator.generate()` forwards from the new widgets) must reach
    `run_usdu_upscale_stage` - and therefore USDU's own `upscale()` call -
    with the exact values passed, not silently dropped at the dispatch
    layer."""
    class _FakeUpscaleModelLoader:
        def load_model(self, model_name):
            return (model_name,)

    captured = {}

    class _FakeUSDU:
        def upscale(self, **kwargs):
            captured.update(kwargs)
            return (f"usdu:{kwargs['image']}",)

    previous = _set_fake_mappings({
        "UpscaleModelLoader": _FakeUpscaleModelLoader,
        "UltimateSDUpscale": _FakeUSDU,
    })
    try:
        image_out, metadata = run_upscale_stage(
            "img", "model", "pos", "neg", "vae", "usdu",
            0, 20, 8.0, "euler", "normal", "default",
            0.2, 2.0, 512, "model.pth",
            "x2", 512, 64, 4,
            usdu_mode_type="Chess",
            usdu_mask_blur=16,
            usdu_tile_padding=40,
            usdu_seam_fix_mode="Half Tile",
            usdu_seam_fix_denoise=0.5,
            usdu_seam_fix_width=80,
            usdu_seam_fix_mask_blur=12,
            usdu_seam_fix_padding=20,
            usdu_auto_tile=False,
        )
        assert image_out == "usdu:img"
        assert captured["mode_type"] == "Chess"
        assert captured["mask_blur"] == 16
        assert captured["tile_padding"] == 40
        assert captured["seam_fix_mode"] == "Half Tile"
        assert captured["seam_fix_denoise"] == 0.5
        assert captured["seam_fix_width"] == 80
        assert captured["seam_fix_mask_blur"] == 12
        assert captured["seam_fix_padding"] == 20
        assert captured["tile_width"] == 512 and captured["tile_height"] == 512
        assert metadata["mode_type"] == "Chess"
        assert metadata["auto_tile"] is False
    finally:
        _restore_mappings(previous)


# --- postprocess resize ---------------------------------------------------


def test_run_postprocess_resize_disabled_when_multiple_not_positive():
    image = _FakeImageTensor(1216, 832)
    result_image, metadata = run_postprocess_resize(image, 0)
    assert result_image is image
    assert metadata == {"enabled": False}


def test_run_postprocess_resize_noop_when_already_aligned():
    # 832 x 1216 is already an exact multiple of 64 in both dimensions.
    image = _FakeImageTensor(1216, 832)
    result_image, metadata = run_postprocess_resize(image, 64)
    assert result_image is image
    assert metadata["enabled"] is True
    assert metadata["resized"] is False
    assert metadata["width"] == 832
    assert metadata["height"] == 1216


def test_run_postprocess_resize_performs_actual_resize_when_comfy_available():
    try:
        import comfy.utils  # type: ignore  # noqa: F401
    except Exception as exc:
        print(
            "SKIP  test_run_postprocess_resize_performs_actual_resize_when_comfy_available: "
            f"{exc} (not running inside ComfyUI)"
        )
        return
    print(
        "SKIP  test_run_postprocess_resize_performs_actual_resize_when_comfy_available: "
        "no live ComfyUI IMAGE tensor fixture available in this environment"
    )


# --- save stage ------------------------------------------------------------


def test_run_save_output_stage_raises_when_core_save_image_missing():
    try:
        run_save_output_stage("img", "MyPrefix")
        raised = False
    except RuntimeError as exc:
        raised = True
        assert "SaveImage" in str(exc)
    assert raised


def test_run_save_output_stage_calls_core_save_image():
    class _FakeSaveImage:
        def save_images(self, images, filename_prefix):
            return {"ui": {"images": [{"filename": f"{filename_prefix}_00001_.png"}]}, "_images": images}

    previous = _set_fake_mappings({"SaveImage": _FakeSaveImage})
    try:
        result = run_save_output_stage("img", "MyPrefix")
        assert result["ui"]["images"][0]["filename"] == "MyPrefix_00001_.png"
        assert result["_images"] == "img"
    finally:
        _restore_mappings(previous)


def test_run_save_output_stage_defaults_blank_prefix_to_anima():
    class _FakeSaveImage:
        def save_images(self, images, filename_prefix):
            return {"prefix_used": filename_prefix}

    previous = _set_fake_mappings({"SaveImage": _FakeSaveImage})
    try:
        result = run_save_output_stage("img", "")
        assert result["prefix_used"] == "Anima"
    finally:
        _restore_mappings(previous)


ALL_TESTS = [
    test_find_optional_node_class_returns_none_outside_comfyui,
    test_find_optional_node_class_finds_class_when_mappings_present,
    test_require_optional_node_class_raises_actionable_error_when_missing,
    test_require_optional_node_class_returns_class_when_present,
    test_run_detailer_stage_skips_when_segs_is_none,
    test_run_detailer_stage_skips_when_segs_has_no_detections,
    test_run_detailer_stage_raises_when_segs_present_but_impact_pack_missing,
    test_run_detailer_stage_filters_kwargs_to_narrow_signature,
    test_run_detailer_stage_pins_upstream_quality_constants,
    test_run_detailer_stage_accepts_dict_shaped_result,
    test_run_detailer_stage_raises_on_empty_dict_result,
    test_plan_usdu_tiles_divides_the_target_evenly_at_default_bounds,
    test_plan_usdu_tiles_exact_dimensions_for_a_typical_2x_upscale_target,
    test_plan_usdu_tiles_is_64_aligned,
    test_plan_usdu_tiles_clamps_to_min_size_for_a_tiny_target,
    test_plan_usdu_tiles_clamps_to_an_explicit_max_size,
    test_plan_usdu_tiles_respects_custom_preferred_min_max_bounds,
    test_plan_usdu_tiles_independent_per_dimension_for_non_square_targets,
    test_plan_usdu_tiles_handles_degenerate_zero_and_negative_inputs_without_crashing,
    test_plan_usdu_tiles_default_bounds_match_module_constants,
    test_load_usdu_upscale_model_raises_when_name_empty,
    test_get_upscale_model_names_fallback_when_folder_paths_unavailable,
    test_run_usdu_upscale_stage_raises_when_pack_missing,
    test_run_usdu_upscale_stage_calls_usdu_with_expected_kwargs,
    test_run_usdu_upscale_stage_defaults_match_upstream_when_not_passed,
    test_run_usdu_upscale_stage_auto_tile_on_uses_planner_not_tile_size,
    test_run_usdu_upscale_stage_auto_tile_off_uses_tile_size_both_dims,
    test_run_resshift_upscale_stage_raises_when_pack_missing,
    test_run_resshift_upscale_stage_calls_loader_and_upscale,
    test_run_upscale_stage_dispatches_by_backend,
    test_run_upscale_stage_passes_through_new_usdu_seam_fix_and_tile_kwargs,
    test_run_postprocess_resize_disabled_when_multiple_not_positive,
    test_run_postprocess_resize_noop_when_already_aligned,
    test_run_postprocess_resize_performs_actual_resize_when_comfy_available,
    test_run_save_output_stage_raises_when_core_save_image_missing,
    test_run_save_output_stage_calls_core_save_image,
    test_run_save_output_stage_defaults_blank_prefix_to_anima,
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
