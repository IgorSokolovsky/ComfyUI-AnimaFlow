"""Plain-script tests for the `AnimaContextBridge`/`AnimaGenerator`/
`AnimaPreview` node classes' structural contract (design doc §1/§3/§5/§7,
BACKLOG.md §4): the frozen `required` key order (append-only -- `42336c0`
already broke saved workflows once by inserting mid-list; THIS commit's own
Generator shrink is a documented EXCEPTION to that rule, not a violation --
see `generator.py`'s own module docstring), `optional`/`hidden` shape,
`OUTPUT_NODE`/`OUTPUT_IS_LIST`/`INPUT_IS_LIST`/`EXPERIMENTAL`/`CATEGORY`, and
that every `INPUT_TYPES` entry and every `RETURN_TYPES` entry carries a
tooltip (theme-skill requirement).

Run directly: `python tests/test_anima_nodes.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima.context_bridge import OPTIONAL_KEY_ORDER, AnimaContextBridge
from nodes.anima.generator import REQUIRED_KEY_ORDER, AnimaGenerator
from nodes.anima.preview import AnimaPreview

# ---------------------------------------------------------------------------
# AnimaContextBridge
# ---------------------------------------------------------------------------


def test_bridge_has_no_required_inputs_at_all():
    # design doc §1/§3: "nothing is required -- an unwired socket simply
    # contributes nothing".
    input_types = AnimaContextBridge.INPUT_TYPES()
    assert input_types["required"] == {}


def test_bridge_optional_key_order_is_frozen():
    input_types = AnimaContextBridge.INPUT_TYPES()
    assert tuple(input_types["optional"].keys()) == OPTIONAL_KEY_ORDER
    assert OPTIONAL_KEY_ORDER == (
        "model", "clip", "vae", "positive", "negative", "latent",
        "seed", "steps", "cfg", "sampler_name", "scheduler",
    )


def test_bridge_five_sampler_scalars_are_forceinput():
    input_types = AnimaContextBridge.INPUT_TYPES()
    for name in ("seed", "steps", "cfg", "sampler_name", "scheduler"):
        assert input_types["optional"][name][1].get("forceInput") is True, name


def test_bridge_has_no_hidden_inputs():
    assert AnimaContextBridge.INPUT_TYPES().get("hidden", {}) == {}


def test_bridge_is_experimental_and_correct_category():
    assert AnimaContextBridge.EXPERIMENTAL is True
    assert AnimaContextBridge.CATEGORY == "AnimaFlow/Anima"


def test_bridge_single_output_is_a_context_socket_named_context():
    assert AnimaContextBridge.RETURN_TYPES == ("ANIMA_CONTEXT",)
    assert AnimaContextBridge.RETURN_NAMES == ("context",)


def test_bridge_every_input_and_output_has_a_tooltip():
    input_types = AnimaContextBridge.INPUT_TYPES()
    for name, spec in input_types["optional"].items():
        opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        assert "tooltip" in opts, name
    assert len(AnimaContextBridge.OUTPUT_TOOLTIPS) == len(AnimaContextBridge.RETURN_TYPES)


def test_bridge_build_returns_a_context_object_recording_supplied_fields():
    node = AnimaContextBridge()
    (context,) = node.build(model="M", positive="POS")
    assert context["values"]["model"] == "M"
    assert context["values"]["positive"] == "POS"
    assert context["supplied"]["model"] is True
    assert context["supplied"]["positive"] is True
    # Everything else genuinely never passed -- absent, not "supplied as None".
    assert context["supplied"]["clip"] is False
    assert context["values"]["clip"] is None


def test_bridge_build_with_nothing_wired_supplies_nothing():
    node = AnimaContextBridge()
    (context,) = node.build()
    assert all(v is False for v in context["supplied"].values())
    assert all(v is None for v in context["values"].values())


# ---------------------------------------------------------------------------
# AnimaGenerator
# ---------------------------------------------------------------------------


def test_generator_required_key_order_is_frozen():
    # THE regression this test exists for: widget order is append-only --
    # this Generator shrink is this repo's one documented EXCEPTION (see
    # generator.py's module docstring), not a silent violation. A future
    # ADDITION to this tuple must still go at the end, never inserted.
    input_types = AnimaGenerator.INPUT_TYPES()
    assert tuple(input_types["required"].keys()) == REQUIRED_KEY_ORDER
    assert REQUIRED_KEY_ORDER == ("context", "generation_settings")


def test_generator_has_no_optional_inputs_left():
    # Every socket except context/generation_settings was deleted this task
    # (design doc §1/§3/§5 reversal): use_internal_loaders, the four
    # pickers, and model/clip/vae/latent/seed/steps/cfg/sampler_name/
    # scheduler are all gone, replaced by the single `context` input.
    input_types = AnimaGenerator.INPUT_TYPES()
    assert input_types["optional"] == {}


def test_generator_context_is_the_custom_anima_context_type():
    input_types = AnimaGenerator.INPUT_TYPES()
    assert input_types["required"]["context"][0] == "ANIMA_CONTEXT"


def test_generator_hidden_is_unique_id_only():
    input_types = AnimaGenerator.INPUT_TYPES()
    assert input_types["hidden"] == {"unique_id": "UNIQUE_ID"}


def test_generator_is_not_an_output_node():
    assert getattr(AnimaGenerator, "OUTPUT_NODE", False) is False


def test_generator_is_experimental_and_correct_category():
    assert AnimaGenerator.EXPERIMENTAL is True
    assert AnimaGenerator.CATEGORY == "AnimaFlow/Anima"


def test_generator_images_output_is_a_list_latent_and_metadata_are_not():
    # design doc §3 reversal: images (index 0) is OUTPUT_IS_LIST; latent and
    # metadata_json are single values.
    assert AnimaGenerator.RETURN_TYPES == ("IMAGE", "LATENT", "STRING")
    assert AnimaGenerator.RETURN_NAMES == ("images", "latent", "metadata_json")
    assert AnimaGenerator.OUTPUT_IS_LIST == (True, False, False)


def test_generator_every_input_has_a_tooltip():
    input_types = AnimaGenerator.INPUT_TYPES()
    for section in ("required", "optional"):
        for name, spec in input_types[section].items():
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            assert "tooltip" in opts, f"{section}.{name} has no tooltip"


def test_generator_every_output_has_a_tooltip():
    assert len(AnimaGenerator.OUTPUT_TOOLTIPS) == len(AnimaGenerator.RETURN_TYPES)
    assert all(isinstance(t, str) and t for t in AnimaGenerator.OUTPUT_TOOLTIPS)


def test_generator_generation_settings_is_a_real_string_widget_not_hidden():
    # Same contract as the Control Panel's panel_state -- a declared,
    # natively-serialized STRING widget, never a `hidden` INPUT_TYPES entry.
    input_types = AnimaGenerator.INPUT_TYPES()
    assert input_types["required"]["generation_settings"][0] == "STRING"
    assert input_types["required"]["generation_settings"][1]["default"] == "{}"
    assert "generation_settings" not in input_types.get("hidden", {})


def _fake_run_generator_result():
    return (["IMG_BASE"], {"samples": "LATENT"}, "{}")


def _with_faked_pipeline(fn):
    """Monkeypatches `src.anima.pipeline.run_generator` at the MODULE level
    (same convention as `test_anima_preview_images.py`'s writer fakes) so
    `AnimaGenerator.generate()` can be exercised end-to-end -- shape only --
    without a real ComfyUI/torch environment to actually sample in. Restores
    the original unconditionally, `fn` raising or not."""
    from src.anima import pipeline as pipeline_mod

    original = pipeline_mod.run_generator
    pipeline_mod.run_generator = lambda **kwargs: _fake_run_generator_result()
    try:
        fn()
    finally:
        pipeline_mod.run_generator = original


def test_generator_generate_returns_a_ui_result_dict_not_a_bare_tuple():
    # `AnimaGenerator` is NOT an OUTPUT_NODE (still asserted below) --
    # ComfyUI's documented shape for an ordinary node to ALSO emit a `ui`
    # payload is `{"ui": ..., "result": (...)}`, not a bare tuple.
    from src.anima.context import build_context

    def run():
        node = AnimaGenerator()
        context = build_context({"model": "M", "seed": 7})
        payload = node.generate(context=context, generation_settings="{}")
        assert isinstance(payload, dict)
        assert set(payload) == {"ui", "result"}
        assert "anima_context" in payload["ui"]
        assert "images" not in payload["ui"]  # never the native-preview trigger key
        result = payload["result"]
        assert isinstance(result, tuple)
        assert result == _fake_run_generator_result()

    _with_faked_pipeline(run)


def test_generator_ui_context_payload_matches_build_context_ui_payload():
    from src.anima.context import build_context, build_context_ui_payload

    def run():
        node = AnimaGenerator()
        context = build_context({"model": "M", "seed": 7, "cfg": 6.0})
        payload = node.generate(context=context, generation_settings="{}")
        # `payload["ui"]["anima_context"]` is a ONE-ELEMENT LIST wrapping the
        # dict, not the dict itself -- see
        # `test_generator_ui_context_payload_is_a_list_not_a_bare_dict` below
        # for why this wrapping is load-bearing, not incidental.
        assert payload["ui"]["anima_context"] == [build_context_ui_payload(context)]

    _with_faked_pipeline(run)


def test_generator_ui_context_payload_is_a_list_not_a_bare_dict():
    # THE REGRESSION GUARD (2026-07-28 live bug): ComfyUI's executor
    # accumulates each node's OWN `ui` dict values by EXTENDING an
    # accumulator list with them -- i.e. `list.extend(value)`, which
    # REQUIRES `value` to already be a list. Handing it a bare dict makes
    # the executor iterate the dict, which yields its KEY NAMES -- proven
    # live via a raw `executed`-message probe:
    # `{"anima_context": ["supplied", "values"]}`. The frontend received
    # only the two key strings, never the payload, on every single run.
    # This test must FAIL against the pre-fix code (a bare dict, not a
    # one-element list).
    from src.anima.context import build_context, build_context_ui_payload

    def run():
        node = AnimaGenerator()
        context = build_context({"model": "M", "seed": 7, "cfg": 6.0})
        payload = node.generate(context=context, generation_settings="{}")
        ui_value = payload["ui"]["anima_context"]
        assert isinstance(ui_value, list), (
            "anima_context must be a LIST (ComfyUI's ui-value contract), "
            "never a bare dict -- a bare dict gets flattened to its own "
            "key names by the executor's list.extend accumulator"
        )
        assert len(ui_value) == 1
        assert ui_value[0] == build_context_ui_payload(context)

    _with_faked_pipeline(run)


def test_generator_missing_context_field_raises_readable_error_not_attributeerror():
    from src.anima.context import ContextFieldMissing, build_context

    node = AnimaGenerator()
    empty_context = build_context({})
    try:
        node.generate(context=empty_context, generation_settings="{}")
        assert False, "expected ContextFieldMissing"
    except ContextFieldMissing as exc:
        assert "model" in str(exc)
        assert "Anima Context Bridge" in str(exc)
    except AttributeError:
        assert False, "must raise a readable error, not an AttributeError"


# ---------------------------------------------------------------------------
# AnimaPreview
# ---------------------------------------------------------------------------


def test_preview_is_an_output_node():
    assert AnimaPreview.OUTPUT_NODE is True


def test_preview_declares_input_is_list():
    # design doc reversal: images arrives as a real list, and the whole
    # node (including the hidden inputs) is wrapped as a result.
    assert AnimaPreview.INPUT_IS_LIST is True


def test_preview_is_experimental_and_correct_category():
    assert AnimaPreview.EXPERIMENTAL is True
    assert AnimaPreview.CATEGORY == "AnimaFlow/Anima"


def test_preview_hidden_is_prompt_and_extra_pnginfo():
    # design doc §7a/§9: these live HERE, not on the Generator.
    input_types = AnimaPreview.INPUT_TYPES()
    assert input_types["hidden"] == {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}


def test_preview_images_and_metadata_json_are_optional():
    input_types = AnimaPreview.INPUT_TYPES()
    for name in ("images", "metadata_json"):
        assert name in input_types["optional"], name
        assert name not in input_types.get("required", {}), name


def test_preview_no_more_image_a_b_c_sockets():
    input_types = AnimaPreview.INPUT_TYPES()
    for name in ("image_a", "image_b", "image_c"):
        assert name not in input_types["optional"]
        assert name not in input_types.get("required", {})


def test_preview_state_is_a_real_string_widget_not_hidden():
    input_types = AnimaPreview.INPUT_TYPES()
    assert input_types["required"]["preview_state"][0] == "STRING"
    assert input_types["required"]["preview_state"][1]["default"] == "{}"
    assert "preview_state" not in input_types.get("hidden", {})


def test_preview_has_no_declared_outputs():
    assert AnimaPreview.RETURN_TYPES == ()


def test_preview_every_input_has_a_tooltip():
    input_types = AnimaPreview.INPUT_TYPES()
    for section in ("required", "optional"):
        for name, spec in input_types[section].items():
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            assert "tooltip" in opts, f"{section}.{name} has no tooltip"


ALL_TESTS = [
    test_bridge_has_no_required_inputs_at_all,
    test_bridge_optional_key_order_is_frozen,
    test_bridge_five_sampler_scalars_are_forceinput,
    test_bridge_has_no_hidden_inputs,
    test_bridge_is_experimental_and_correct_category,
    test_bridge_single_output_is_a_context_socket_named_context,
    test_bridge_every_input_and_output_has_a_tooltip,
    test_bridge_build_returns_a_context_object_recording_supplied_fields,
    test_bridge_build_with_nothing_wired_supplies_nothing,
    test_generator_required_key_order_is_frozen,
    test_generator_has_no_optional_inputs_left,
    test_generator_context_is_the_custom_anima_context_type,
    test_generator_hidden_is_unique_id_only,
    test_generator_is_not_an_output_node,
    test_generator_is_experimental_and_correct_category,
    test_generator_images_output_is_a_list_latent_and_metadata_are_not,
    test_generator_every_input_has_a_tooltip,
    test_generator_every_output_has_a_tooltip,
    test_generator_generation_settings_is_a_real_string_widget_not_hidden,
    test_generator_generate_returns_a_ui_result_dict_not_a_bare_tuple,
    test_generator_ui_context_payload_matches_build_context_ui_payload,
    test_generator_ui_context_payload_is_a_list_not_a_bare_dict,
    test_generator_missing_context_field_raises_readable_error_not_attributeerror,
    test_preview_is_an_output_node,
    test_preview_declares_input_is_list,
    test_preview_is_experimental_and_correct_category,
    test_preview_hidden_is_prompt_and_extra_pnginfo,
    test_preview_images_and_metadata_json_are_optional,
    test_preview_no_more_image_a_b_c_sockets,
    test_preview_state_is_a_real_string_widget_not_hidden,
    test_preview_has_no_declared_outputs,
    test_preview_every_input_has_a_tooltip,
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
