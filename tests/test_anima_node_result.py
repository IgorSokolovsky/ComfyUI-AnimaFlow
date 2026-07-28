"""Plain-script tests for `src/anima/node_result.py` (the pure normalizer for
a CORE ComfyUI node call's return value) and for `src/anima/pipeline.py`'s
`_output0`/`_output0_multi`, which now run every result through it.

Live bug this covers: `comfy_extras.nodes_sam3.SAM3_Detect` on ComfyUI 0.28.3
returns ComfyUI's V3 `NodeOutput` shape (outputs on a `.result` attribute,
not the return value itself) from `_run_detailer_block`'s `sam3_cls().
execute(...)` call — the old `_output0` required a bare tuple and rejected
it outright. These tests use a hand-rolled stub class for the V3 shape,
never importing anything from ComfyUI itself, matching the pure/impure rule
(`.claude/CLAUDE.md`) both `node_result.py` and this test file live under.

Run directly: `python tests/test_anima_node_result.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import node_result as nr
from src.anima import pipeline as pipeline_mod


class _FakeNodeOutput:
    """A hand-rolled stand-in for ComfyUI's V3 `comfy_api`/`io.NodeOutput` --
    deliberately NOT imported from anywhere ComfyUI-related; only its shape
    (a `.result` attribute) matters to `normalize_node_result`, which must
    duck-type on that shape rather than isinstance-ing any real V3 class."""

    def __init__(self, result):
        self.result = result


class _Unrecognized:
    """Something structurally unlike any of the three recognised shapes --
    no `.result` attribute, not a tuple/list/dict."""


# ---------------------------------------------------------------------------
# node_result.normalize_node_result -- the pure normalizer
# ---------------------------------------------------------------------------


def test_v2_tuple_used_as_is():
    normalized = nr.normalize_node_result((1, 2, 3))
    assert normalized.outputs == (1, 2, 3)
    assert normalized.unrecognized_type is None


def test_v2_list_converted_to_tuple():
    normalized = nr.normalize_node_result([1, 2, 3])
    assert normalized.outputs == (1, 2, 3)
    assert normalized.unrecognized_type is None


def test_v3_node_output_stub_unwrapped_via_result_attribute():
    normalized = nr.normalize_node_result(_FakeNodeOutput((7,)))
    assert normalized.outputs == (7,)
    assert normalized.unrecognized_type is None


def test_v3_node_output_stub_with_list_result():
    normalized = nr.normalize_node_result(_FakeNodeOutput([7, 8]))
    assert normalized.outputs == (7, 8)
    assert normalized.unrecognized_type is None


def test_ui_result_dict_shape_unwrapped():
    normalized = nr.normalize_node_result({"ui": {"images": []}, "result": (9,)})
    assert normalized.outputs == (9,)
    assert normalized.unrecognized_type is None


def test_ui_result_dict_shape_with_list_result():
    normalized = nr.normalize_node_result({"ui": {}, "result": [9, 10]})
    assert normalized.outputs == (9, 10)
    assert normalized.unrecognized_type is None


def test_empty_tuple_is_recognised_but_empty():
    normalized = nr.normalize_node_result(())
    assert normalized.outputs == ()
    assert normalized.unrecognized_type is None


def test_empty_result_attribute_is_recognised_but_empty():
    normalized = nr.normalize_node_result(_FakeNodeOutput(()))
    assert normalized.outputs == ()
    assert normalized.unrecognized_type is None


def test_empty_dict_result_is_recognised_but_empty():
    normalized = nr.normalize_node_result({"result": ()})
    assert normalized.outputs == ()
    assert normalized.unrecognized_type is None


def test_none_is_unrecognized():
    normalized = nr.normalize_node_result(None)
    assert normalized.outputs is None
    assert normalized.unrecognized_type == "NoneType"


def test_unrecognized_object_reports_its_own_type_name():
    normalized = nr.normalize_node_result(_Unrecognized())
    assert normalized.outputs is None
    assert normalized.unrecognized_type == "_Unrecognized"


def test_dict_without_a_result_key_is_unrecognized():
    normalized = nr.normalize_node_result({"ui": {"images": []}})
    assert normalized.outputs is None
    assert normalized.unrecognized_type == "dict"


def test_result_attribute_that_is_not_a_tuple_or_list_falls_through_to_unrecognized():
    # e.g. a `.result` that's a bare string rather than a real outputs tuple.
    normalized = nr.normalize_node_result(_FakeNodeOutput("not a tuple"))
    assert normalized.outputs is None
    assert normalized.unrecognized_type == "_FakeNodeOutput"


def test_order_of_preference_tuple_wins_over_dict_shape():
    # A tuple is never mistaken for the dict shape just because SOMETHING
    # downstream might duck-type similarly -- tuple/list always wins first.
    normalized = nr.normalize_node_result((1,))
    assert normalized.outputs == (1,)


# ---------------------------------------------------------------------------
# pipeline._output0 -- through the normalizer, V2 and fake-V3 shapes
# ---------------------------------------------------------------------------


def test_output0_v2_tuple():
    assert pipeline_mod._output0((42,), node_name="Foo", method_name="bar") == 42


def test_output0_v3_node_output_stub():
    assert pipeline_mod._output0(_FakeNodeOutput((42,)), node_name="Foo", method_name="bar") == 42


def test_output0_ui_result_dict():
    assert pipeline_mod._output0({"ui": {}, "result": (42,)}, node_name="Foo", method_name="bar") == 42


def test_output0_empty_recognised_shape_names_node_and_method():
    try:
        pipeline_mod._output0((), node_name="SAM3_Detect", method_name="execute")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        message = str(exc)
        assert "SAM3_Detect" in message
        assert "execute" in message
        assert "no outputs" in message


def test_output0_unrecognized_shape_names_node_method_and_type():
    try:
        pipeline_mod._output0(_FakeNodeOutput("nope"), node_name="SAM3_Detect", method_name="execute")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        message = str(exc)
        assert "SAM3_Detect" in message
        assert "execute" in message
        assert "_FakeNodeOutput" in message


def test_output0_unrecognized_none_names_nonetype():
    try:
        pipeline_mod._output0(None, node_name="KSampler", method_name="sample")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        message = str(exc)
        assert "KSampler" in message
        assert "sample" in message
        assert "NoneType" in message


def test_output0_default_context_still_readable_when_omitted():
    # Backward-compatible defaults -- a call site that doesn't pass context
    # still gets a real error, just a generic one, instead of an AttributeError.
    try:
        pipeline_mod._output0(())
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "no outputs" in str(exc)


# ---------------------------------------------------------------------------
# pipeline._output0_multi -- through the normalizer, V2 and fake-V3 shapes
# ---------------------------------------------------------------------------


def test_output0_multi_v2_tuple():
    model, clip, vae = pipeline_mod._output0_multi(
        ("model", "clip", "vae"), node_name="CheckpointLoaderSimple", method_name="load_checkpoint",
    )
    assert (model, clip, vae) == ("model", "clip", "vae")


def test_output0_multi_v3_node_output_stub():
    model, clip, vae = pipeline_mod._output0_multi(
        _FakeNodeOutput(("model", "clip", "vae")),
        node_name="CheckpointLoaderSimple", method_name="load_checkpoint",
    )
    assert (model, clip, vae) == ("model", "clip", "vae")


def test_output0_multi_ui_result_dict():
    model, clip, vae = pipeline_mod._output0_multi(
        {"ui": {}, "result": ("model", "clip", "vae")},
        node_name="CheckpointLoaderSimple", method_name="load_checkpoint",
    )
    assert (model, clip, vae) == ("model", "clip", "vae")


def test_output0_multi_too_few_outputs_names_node_method_and_count():
    try:
        pipeline_mod._output0_multi(
            ("model", "clip"), node_name="CheckpointLoaderSimple", method_name="load_checkpoint",
        )
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        message = str(exc)
        assert "CheckpointLoaderSimple" in message
        assert "load_checkpoint" in message
        assert "2" in message
        assert "3" in message


def test_output0_multi_unrecognized_shape_names_node_method_and_type():
    try:
        pipeline_mod._output0_multi(
            _Unrecognized(), node_name="CheckpointLoaderSimple", method_name="load_checkpoint",
        )
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        message = str(exc)
        assert "CheckpointLoaderSimple" in message
        assert "load_checkpoint" in message
        assert "_Unrecognized" in message


ALL_TESTS = [
    test_v2_tuple_used_as_is,
    test_v2_list_converted_to_tuple,
    test_v3_node_output_stub_unwrapped_via_result_attribute,
    test_v3_node_output_stub_with_list_result,
    test_ui_result_dict_shape_unwrapped,
    test_ui_result_dict_shape_with_list_result,
    test_empty_tuple_is_recognised_but_empty,
    test_empty_result_attribute_is_recognised_but_empty,
    test_empty_dict_result_is_recognised_but_empty,
    test_none_is_unrecognized,
    test_unrecognized_object_reports_its_own_type_name,
    test_dict_without_a_result_key_is_unrecognized,
    test_result_attribute_that_is_not_a_tuple_or_list_falls_through_to_unrecognized,
    test_order_of_preference_tuple_wins_over_dict_shape,
    test_output0_v2_tuple,
    test_output0_v3_node_output_stub,
    test_output0_ui_result_dict,
    test_output0_empty_recognised_shape_names_node_and_method,
    test_output0_unrecognized_shape_names_node_method_and_type,
    test_output0_unrecognized_none_names_nonetype,
    test_output0_default_context_still_readable_when_omitted,
    test_output0_multi_v2_tuple,
    test_output0_multi_v3_node_output_stub,
    test_output0_multi_ui_result_dict,
    test_output0_multi_too_few_outputs_names_node_method_and_count,
    test_output0_multi_unrecognized_shape_names_node_method_and_type,
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
        except Exception as exc:  # noqa: BLE001
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
