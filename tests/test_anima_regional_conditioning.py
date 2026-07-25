"""Plain-script tests for `AnimaRegionalConditioning`'s logic.

Run directly: `python tests/test_anima_regional_conditioning.py` (no
pytest, per project convention). Every function under test here
(`collect_region_pairs`, `set_conditioning_values`/`attach_region_mask`,
`combine_regional_conditioning`'s pure fallback path) is fully torch-free —
they never inspect `mask`/conditioning-tensor CONTENT, only dict/list/tuple
STRUCTURE — so this suite uses plain fake conditioning structures (nested
lists/dicts, no torch) throughout, including for the non-mutation
assertion, which is a real UNGUARDED test (not SKIP-printed) per the plan.
Anything that would need a real torch MASK tensor or a live ComfyUI
`ConditioningSetMask` class is guarded/SKIP-printed, matching every prior
phase's convention.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nodes.anima._anima_regional_conditioning_helpers as regional_conditioning_helpers
from nodes.anima._anima_regional_conditioning_helpers import (
    AREA_MODE_DEFAULT,
    AREA_MODE_MASK_BOUNDS,
    AREA_MODES,
    area_mode_to_set_area_to_bounds,
    attach_region_mask,
    collect_region_pairs,
    combine_regional_conditioning,
    normalize_area_mode,
    set_conditioning_values,
)
from nodes.anima.node_anima_regional_conditioning import AnimaRegionalConditioning, MAX_REGIONS


def fake_cond(tag):
    """A minimal fake CONDITIONING *entry*: `[cond_tensor_stub, metadata_dict]`
    -- exactly the shape `set_conditioning_values` inspects, with a plain
    string standing in for a real torch tensor (never touched as a tensor
    by any function under test here)."""
    return [f"tensor:{tag}", {"tag": tag}]


def fake_conditioning(tag):
    """A minimal fake CONDITIONING *value*: a one-entry list of `fake_cond`
    entries -- real ComfyUI CONDITIONING is always a LIST of `[tensor,
    dict]` entries (never a bare entry), which is what every `cond_i`/
    `positive`/`negative` input actually is."""
    return [fake_cond(tag)]


# ---------------------------------------------------------------------------
# normalize_area_mode / area_mode_to_set_area_to_bounds
# ---------------------------------------------------------------------------


def test_normalize_area_mode_valid_passthrough():
    assert normalize_area_mode("mask bounds") == AREA_MODE_MASK_BOUNDS
    assert normalize_area_mode("default") == AREA_MODE_DEFAULT


def test_normalize_area_mode_invalid_defaults_to_mask_bounds():
    assert normalize_area_mode("bogus") == AREA_MODE_MASK_BOUNDS
    assert normalize_area_mode(None) == AREA_MODE_MASK_BOUNDS
    assert normalize_area_mode("") == AREA_MODE_MASK_BOUNDS


def test_area_mode_to_set_area_to_bounds():
    assert area_mode_to_set_area_to_bounds("mask bounds") is True
    assert area_mode_to_set_area_to_bounds("default") is False
    assert area_mode_to_set_area_to_bounds("anything else") is True


# ---------------------------------------------------------------------------
# collect_region_pairs
# ---------------------------------------------------------------------------


def test_collect_region_pairs_no_pairs():
    assert collect_region_pairs([]) == []
    assert collect_region_pairs(None) == []


def test_collect_region_pairs_only_mask_wired_is_inactive():
    pairs = [(object(), None)]
    assert collect_region_pairs(pairs) == []


def test_collect_region_pairs_only_cond_wired_is_inactive():
    pairs = [(None, object())]
    assert collect_region_pairs(pairs) == []


def test_collect_region_pairs_both_wired_is_active():
    mask, cond = object(), object()
    result = collect_region_pairs([(mask, cond)])
    assert result == [(1, mask, cond)]


def test_collect_region_pairs_sparse_non_contiguous_preserves_index_and_order():
    mask2, cond2 = object(), object()
    mask5, cond5 = object(), object()
    pairs = [
        (None, None),          # 1: inactive
        (mask2, cond2),        # 2: active
        (object(), None),      # 3: inactive
        (None, object()),      # 4: inactive
        (mask5, cond5),        # 5: active
        (None, None),          # 6: inactive
    ]
    result = collect_region_pairs(pairs)
    assert [entry[0] for entry in result] == [2, 5]
    assert result[0] == (2, mask2, cond2)
    assert result[1] == (5, mask5, cond5)


def test_collect_region_pairs_all_six_active():
    pairs = [(object(), object()) for _ in range(6)]
    result = collect_region_pairs(pairs)
    assert [entry[0] for entry in result] == [1, 2, 3, 4, 5, 6]


# ---------------------------------------------------------------------------
# Non-mutation property (unguarded — plain fakes, no torch needed)
# ---------------------------------------------------------------------------


def test_set_conditioning_values_does_not_mutate_input_dicts():
    original_metadata = {"existing": "value"}
    entry = ["tensor-stub", original_metadata]
    conditioning = [entry]

    result = set_conditioning_values(conditioning, {"mask": "mask-stub", "mask_strength": 0.7})

    # The ORIGINAL dict object must be untouched -- a shared upstream
    # conditioning's metadata dict must survive this call unmutated so
    # other graph branches holding the same reference aren't corrupted.
    assert original_metadata == {"existing": "value"}
    assert "mask" not in original_metadata
    # The result carries a NEW dict with both the old and new keys.
    assert result[0][1] == {"existing": "value", "mask": "mask-stub", "mask_strength": 0.7}
    assert result[0][1] is not original_metadata


def test_set_conditioning_values_passes_through_malformed_entries_untouched():
    weird_entry = "not-a-pair"
    result = set_conditioning_values([weird_entry], {"mask": "x"})
    assert result == [weird_entry]


def test_attach_region_mask_sets_exactly_the_three_native_keys():
    conditioning = [fake_cond("a")]
    result = attach_region_mask(conditioning, "mask-stub", 0.8, "mask bounds")
    metadata = result[0][1]
    assert metadata["mask"] == "mask-stub"
    assert metadata["mask_strength"] == 0.8
    assert metadata["set_area_to_bounds"] is True
    assert "area" not in metadata  # no hand-computed area bounding box -- see helper docstring
    assert metadata["tag"] == "a"  # original metadata preserved alongside the new keys


def test_attach_region_mask_default_area_mode_sets_set_area_to_bounds_false():
    result = attach_region_mask([fake_cond("a")], "mask-stub", 1.0, "default")
    assert result[0][1]["set_area_to_bounds"] is False


def test_attach_region_mask_does_not_mutate_input():
    original = {"tag": "a"}
    conditioning = [["tensor", original]]
    attach_region_mask(conditioning, "mask-stub", 1.0, "mask bounds")
    assert original == {"tag": "a"}


# ---------------------------------------------------------------------------
# combine_regional_conditioning (pure fallback path, core_cls=None)
# ---------------------------------------------------------------------------


def test_combine_regional_conditioning_no_active_pairs_returns_global_unchanged():
    positive = [fake_cond("global")]
    pairs = [(None, None)] * 6
    result = combine_regional_conditioning(positive, pairs, 1.0, "mask bounds")
    assert result == positive
    assert result is not positive  # a fresh list -- not the same object


def test_combine_regional_conditioning_appends_active_regions_after_global_in_order():
    positive = [fake_cond("global")]
    mask1, cond1 = "mask1", fake_conditioning("region1")
    mask3, cond3 = "mask3", fake_conditioning("region3")
    pairs = [
        (mask1, cond1),
        (None, None),
        (mask3, cond3),
        (None, None),
        (None, None),
        (None, None),
    ]
    result = combine_regional_conditioning(positive, pairs, 0.5, "mask bounds")

    assert len(result) == 3
    assert result[0] == fake_cond("global")  # global entry untouched
    assert result[1][1]["tag"] == "region1"
    assert result[1][1]["mask"] == "mask1"
    assert result[1][1]["mask_strength"] == 0.5
    assert result[1][1]["set_area_to_bounds"] is True
    assert result[2][1]["tag"] == "region3"
    assert result[2][1]["mask"] == "mask3"


def test_combine_regional_conditioning_area_mode_default_disables_bounds():
    positive = []
    pairs = [("mask1", fake_conditioning("r"))] + [(None, None)] * 5
    result = combine_regional_conditioning(positive, pairs, 1.0, "default")
    assert result[0][1]["set_area_to_bounds"] is False


def test_combine_regional_conditioning_does_not_mutate_global_positive_entries():
    original_metadata = {"tag": "global"}
    global_entry = ["tensor-global", original_metadata]
    positive = [global_entry]
    pairs = [("mask1", fake_conditioning("r"))] + [(None, None)] * 5

    result = combine_regional_conditioning(positive, pairs, 1.0, "mask bounds")

    assert original_metadata == {"tag": "global"}
    assert result[0] is global_entry  # global entries pass through by reference, untouched


def test_combine_regional_conditioning_delegates_to_core_class_when_given():
    calls = []

    class FakeConditioningSetMask:
        def append(self, cond, mask, set_cond_area, strength):
            calls.append((cond, mask, set_cond_area, strength))
            return ([["core-produced", {"mask": mask, "set_area_to_bounds": set_cond_area != "default", "mask_strength": strength}]],)

    positive = [fake_cond("global")]
    pairs = [("mask1", fake_conditioning("r"))] + [(None, None)] * 5
    result = combine_regional_conditioning(
        positive, pairs, 0.9, "mask bounds", core_conditioning_set_mask_cls=FakeConditioningSetMask,
    )
    assert len(calls) == 1
    assert calls[0][1] == "mask1"
    assert calls[0][2] == "mask bounds"
    assert calls[0][3] == 0.9
    assert result[1][0] == "core-produced"


# ---------------------------------------------------------------------------
# combine_regional_conditioning -- core delegation failure degrades safely
# (the MAJOR review finding this suite section pins: any exception raised by
# `core_conditioning_set_mask_cls().append(...)` -- a signature mismatch, a
# renamed parameter, a changed return shape, or anything else -- must fall
# through to the pure `attach_region_mask` fallback rather than propagating
# into the caller's graph). `_warned_core_conditioning_set_mask_failed` is
# reset before each test that exercises the failure path so the module-level
# "already warned" flag from one test doesn't affect another's ability to
# exercise the warning branch.
# ---------------------------------------------------------------------------


def _reset_core_conditioning_set_mask_warned_flag():
    regional_conditioning_helpers._warned_core_conditioning_set_mask_failed = False


def test_combine_regional_conditioning_core_type_error_falls_back_safely():
    """A `TypeError` from `.append(...)` (the shape a real signature
    mismatch would raise) must not propagate -- the result must be
    IDENTICAL to what the pure fallback alone produces for the same
    inputs."""
    _reset_core_conditioning_set_mask_warned_flag()

    class FakeConditioningSetMaskSignatureMismatch:
        def append(self, *args, **kwargs):
            raise TypeError("append() takes 3 positional arguments but 5 were given")

    positive = [fake_cond("global")]
    pairs = [("mask1", fake_conditioning("r"))] + [(None, None)] * 5

    result_with_broken_core = combine_regional_conditioning(
        positive, pairs, 0.9, "mask bounds",
        core_conditioning_set_mask_cls=FakeConditioningSetMaskSignatureMismatch,
    )
    result_pure_fallback = combine_regional_conditioning(
        positive, pairs, 0.9, "mask bounds", core_conditioning_set_mask_cls=None,
    )
    assert result_with_broken_core == result_pure_fallback


def test_combine_regional_conditioning_core_arbitrary_exception_falls_back_safely():
    """Not just `TypeError` -- ANY exception (e.g. a plain `RuntimeError`,
    standing in for a missing method / changed return shape / anything
    else) must degrade safely too, since `except Exception` is broad by
    design."""
    _reset_core_conditioning_set_mask_warned_flag()

    class FakeConditioningSetMaskArbitraryFailure:
        def append(self, *args, **kwargs):
            raise RuntimeError("unexpected return shape")

    positive = [fake_cond("global")]
    pairs = [("mask1", fake_conditioning("r"))] + [(None, None)] * 5

    result_with_broken_core = combine_regional_conditioning(
        positive, pairs, 0.9, "mask bounds",
        core_conditioning_set_mask_cls=FakeConditioningSetMaskArbitraryFailure,
    )
    result_pure_fallback = combine_regional_conditioning(
        positive, pairs, 0.9, "mask bounds", core_conditioning_set_mask_cls=None,
    )
    assert result_with_broken_core == result_pure_fallback


def test_combine_regional_conditioning_core_success_is_genuinely_used():
    """Pins the happy path against future regressions: if the code ever
    silently stopped delegating (e.g. an errant blanket try/except that
    swallows even the success case, or a bug that always falls back), this
    assertion on `calls` -- not just the returned shape -- would catch it,
    since a fallback-produced result could otherwise coincidentally look
    similar."""
    _reset_core_conditioning_set_mask_warned_flag()
    calls = []

    class FakeConditioningSetMaskSucceeds:
        def append(self, cond, mask, set_cond_area, strength):
            calls.append((cond, mask, set_cond_area, strength))
            return ([["core-produced-2", {"mask": mask, "mask_strength": strength}]],)

    positive = [fake_cond("global")]
    pairs = [("mask1", fake_conditioning("r"))] + [(None, None)] * 5
    result = combine_regional_conditioning(
        positive, pairs, 0.6, "mask bounds", core_conditioning_set_mask_cls=FakeConditioningSetMaskSucceeds,
    )
    assert len(calls) == 1  # the fake was genuinely invoked -- not silently skipped
    assert result[1][0] == "core-produced-2"


def test_combine_regional_conditioning_core_failure_does_not_mutate_global_positive():
    """The non-mutation property must hold even through the
    exception-then-fallback path: a core-class failure partway through must
    not leave the global `positive` entries' metadata dicts touched."""
    _reset_core_conditioning_set_mask_warned_flag()

    class FakeConditioningSetMaskRaises:
        def append(self, *args, **kwargs):
            raise TypeError("signature mismatch")

    original_metadata = {"tag": "global"}
    global_entry = ["tensor-global", original_metadata]
    positive = [global_entry]
    pairs = [("mask1", fake_conditioning("r"))] + [(None, None)] * 5

    result = combine_regional_conditioning(
        positive, pairs, 1.0, "mask bounds", core_conditioning_set_mask_cls=FakeConditioningSetMaskRaises,
    )

    assert original_metadata == {"tag": "global"}
    assert result[0] is global_entry  # global entry passes through by reference, untouched
    # The region entry, having fallen back to attach_region_mask, must also
    # not mutate ITS OWN input conditioning's metadata dict.
    region_cond = pairs[0][1]
    assert region_cond[0][1] == {"tag": "r"}


# ---------------------------------------------------------------------------
# INPUT_TYPES / RETURN_TYPES contract
# ---------------------------------------------------------------------------


def test_node_input_types_all_six_pairs_present_and_optional():
    schema = AnimaRegionalConditioning.INPUT_TYPES()
    required = schema["required"]
    optional = schema["optional"]
    assert set(required.keys()) == {"positive", "negative", "mask_strength", "area_mode"}
    for i in range(1, MAX_REGIONS + 1):
        assert f"mask_{i}" in optional
        assert f"cond_{i}" in optional
        assert optional[f"mask_{i}"][0] == "MASK"
        assert optional[f"cond_{i}"][0] == "CONDITIONING"


def test_node_input_types_every_field_has_tooltip():
    schema = AnimaRegionalConditioning.INPUT_TYPES()
    for section in ("required", "optional"):
        for name, spec in schema[section].items():
            assert "tooltip" in spec[1] and spec[1]["tooltip"], f"{name} missing a tooltip"


def test_node_return_types_and_tooltips():
    assert AnimaRegionalConditioning.RETURN_TYPES == ("CONDITIONING", "CONDITIONING")
    assert AnimaRegionalConditioning.RETURN_NAMES == ("positive", "negative")
    assert len(AnimaRegionalConditioning.OUTPUT_TOOLTIPS) == 2
    for tooltip in AnimaRegionalConditioning.OUTPUT_TOOLTIPS:
        assert isinstance(tooltip, str) and tooltip
    assert AnimaRegionalConditioning.CATEGORY == "AnimaFlow/anima"
    assert AnimaRegionalConditioning.FUNCTION == "encode"


def test_node_area_mode_combo_values():
    schema = AnimaRegionalConditioning.INPUT_TYPES()
    assert schema["required"]["area_mode"][0] == list(AREA_MODES)
    assert schema["required"]["area_mode"][1]["default"] == AREA_MODE_MASK_BOUNDS


# ---------------------------------------------------------------------------
# Node-level smoke tests (no torch needed -- the node's own encode() only
# ever touches STRUCTURE, same as the helpers, in this repo's dev/test
# environment where find_core_node_class always returns None)
# ---------------------------------------------------------------------------


def test_node_encode_no_regions_wired_passes_positive_negative_through():
    node = AnimaRegionalConditioning()
    positive = [fake_cond("global-pos")]
    negative = [fake_cond("global-neg")]
    out_positive, out_negative = node.encode(positive, negative)
    assert out_positive == positive
    assert out_negative is negative


def test_node_encode_with_one_active_region_pair():
    node = AnimaRegionalConditioning()
    positive = [fake_cond("global-pos")]
    negative = [fake_cond("global-neg")]
    out_positive, out_negative = node.encode(
        positive,
        negative,
        mask_strength=1.0,
        area_mode="mask bounds",
        mask_1="mask-stub",
        cond_1=fake_conditioning("region1"),
    )
    assert len(out_positive) == 2
    assert out_positive[1][1]["mask"] == "mask-stub"
    assert out_negative is negative


def test_node_encode_guarded_smoke_with_real_comfy_core_class():
    # If this dev environment somehow HAD a live ComfyUI's `nodes.py`
    # importable (never true here -- see _comfy_core_bridge.py's
    # docstring), this would exercise the REAL core-class delegation path
    # instead of the pure fallback. SKIP-printed since it never applies
    # outside a live ComfyUI process.
    try:
        import nodes as core_nodes  # type: ignore

        if not hasattr(core_nodes, "ConditioningSetMask"):
            raise ImportError("no live ComfyUI core nodes.py on this path")
    except Exception as exc:
        print(f"SKIP  test_node_encode_guarded_smoke_with_real_comfy_core_class: {exc} (not running inside ComfyUI)")
        return

    raise AssertionError("this repo's own nodes/ package should never expose ConditioningSetMask")


ALL_TESTS = [
    test_normalize_area_mode_valid_passthrough,
    test_normalize_area_mode_invalid_defaults_to_mask_bounds,
    test_area_mode_to_set_area_to_bounds,
    test_collect_region_pairs_no_pairs,
    test_collect_region_pairs_only_mask_wired_is_inactive,
    test_collect_region_pairs_only_cond_wired_is_inactive,
    test_collect_region_pairs_both_wired_is_active,
    test_collect_region_pairs_sparse_non_contiguous_preserves_index_and_order,
    test_collect_region_pairs_all_six_active,
    test_set_conditioning_values_does_not_mutate_input_dicts,
    test_set_conditioning_values_passes_through_malformed_entries_untouched,
    test_attach_region_mask_sets_exactly_the_three_native_keys,
    test_attach_region_mask_default_area_mode_sets_set_area_to_bounds_false,
    test_attach_region_mask_does_not_mutate_input,
    test_combine_regional_conditioning_no_active_pairs_returns_global_unchanged,
    test_combine_regional_conditioning_appends_active_regions_after_global_in_order,
    test_combine_regional_conditioning_area_mode_default_disables_bounds,
    test_combine_regional_conditioning_does_not_mutate_global_positive_entries,
    test_combine_regional_conditioning_delegates_to_core_class_when_given,
    test_combine_regional_conditioning_core_type_error_falls_back_safely,
    test_combine_regional_conditioning_core_arbitrary_exception_falls_back_safely,
    test_combine_regional_conditioning_core_success_is_genuinely_used,
    test_combine_regional_conditioning_core_failure_does_not_mutate_global_positive,
    test_node_input_types_all_six_pairs_present_and_optional,
    test_node_input_types_every_field_has_tooltip,
    test_node_return_types_and_tooltips,
    test_node_area_mode_combo_values,
    test_node_encode_no_regions_wired_passes_positive_negative_through,
    test_node_encode_with_one_active_region_pair,
    test_node_encode_guarded_smoke_with_real_comfy_core_class,
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
