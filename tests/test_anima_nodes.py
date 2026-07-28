"""Plain-script tests for the `AnimaGenerator`/`AnimaPreview` node classes'
structural contract (design doc §5/§7, BACKLOG.md §4): the frozen `required`
key order (append-only -- `42336c0` already broke saved workflows once by
inserting mid-list), `optional`/`hidden` shape, `OUTPUT_NODE`/`EXPERIMENTAL`/
`CATEGORY`, and that every `INPUT_TYPES` entry and every `RETURN_TYPES` entry
carries a tooltip (theme-skill requirement).

Run directly: `python tests/test_anima_nodes.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima.generator import REQUIRED_KEY_ORDER, AnimaGenerator
from nodes.anima.preview import AnimaPreview

# ---------------------------------------------------------------------------
# AnimaGenerator
# ---------------------------------------------------------------------------


def test_generator_required_key_order_is_frozen():
    # THE regression this test exists for: widget order is append-only.
    # If this ever fails because someone inserted a new key mid-list, the
    # fix is to append it at the end of `required` (or move it to
    # `optional`), NEVER to update this frozen tuple to match new code.
    input_types = AnimaGenerator.INPUT_TYPES()
    assert tuple(input_types["required"].keys()) == REQUIRED_KEY_ORDER
    assert REQUIRED_KEY_ORDER == (
        "positive", "negative", "generation_settings", "use_internal_loaders",
        "unet_name", "clip_name", "clip_type", "vae_name",
    )


def test_generator_the_four_pickers_and_flag_are_last():
    # design doc §3: "The flag and the four pickers go at the end of
    # `required` and never move."
    assert REQUIRED_KEY_ORDER[-5:] == (
        "use_internal_loaders", "unet_name", "clip_name", "clip_type", "vae_name",
    )


def test_generator_resource_and_sampler_sockets_are_optional_not_required():
    # design doc §3: a required MODEL would hard-fail the queue whenever the
    # flag is on and nothing is wired -- these MUST be optional.
    input_types = AnimaGenerator.INPUT_TYPES()
    for name in ("model", "clip", "vae", "latent", "seed", "steps", "cfg", "sampler_name", "scheduler"):
        assert name in input_types["optional"], name
        assert name not in input_types["required"], name


def test_generator_five_sampler_sockets_are_forceinput():
    # design doc §5a's legacy-litegraph caveat: forceInput sidesteps the
    # "convert widget to input" dance for these five.
    input_types = AnimaGenerator.INPUT_TYPES()
    for name in ("seed", "steps", "cfg", "sampler_name", "scheduler"):
        assert input_types["optional"][name][1].get("forceInput") is True, name


def test_generator_hidden_is_unique_id_only():
    # design doc §5: "hidden: unique_id | UNIQUE_ID | PROMPT/EXTRA_PNGINFO
    # live on the Preview node now."
    input_types = AnimaGenerator.INPUT_TYPES()
    assert input_types["hidden"] == {"unique_id": "UNIQUE_ID"}


def test_generator_is_not_an_output_node():
    assert getattr(AnimaGenerator, "OUTPUT_NODE", False) is False


def test_generator_is_experimental_and_correct_category():
    assert AnimaGenerator.EXPERIMENTAL is True
    assert AnimaGenerator.CATEGORY == "AnimaFlow/Anima"


def test_generator_fixed_output_set():
    assert AnimaGenerator.RETURN_TYPES == ("IMAGE", "IMAGE", "IMAGE", "LATENT", "STRING")
    assert AnimaGenerator.RETURN_NAMES == ("image", "image_base", "image_mid", "latent", "metadata_json")


def test_generator_every_input_has_a_tooltip():
    input_types = AnimaGenerator.INPUT_TYPES()
    for section in ("required", "optional"):
        for name, spec in input_types[section].items():
            if name == "generation_settings":
                continue  # STRING widget config; checked separately below.
            opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
            assert "tooltip" in opts, f"{section}.{name} has no tooltip"
    assert "tooltip" in input_types["required"]["generation_settings"][1]


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


# ---------------------------------------------------------------------------
# AnimaPreview
# ---------------------------------------------------------------------------


def test_preview_is_an_output_node():
    assert AnimaPreview.OUTPUT_NODE is True


def test_preview_is_experimental_and_correct_category():
    assert AnimaPreview.EXPERIMENTAL is True
    assert AnimaPreview.CATEGORY == "AnimaFlow/Anima"


def test_preview_hidden_is_prompt_and_extra_pnginfo():
    # design doc §7a/§9: these live HERE, not on the Generator.
    input_types = AnimaPreview.INPUT_TYPES()
    assert input_types["hidden"] == {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"}


def test_preview_image_inputs_are_all_optional():
    input_types = AnimaPreview.INPUT_TYPES()
    for name in ("image_a", "image_b", "image_c"):
        assert name in input_types["optional"], name
        assert name not in input_types.get("required", {}), name


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
    test_generator_required_key_order_is_frozen,
    test_generator_the_four_pickers_and_flag_are_last,
    test_generator_resource_and_sampler_sockets_are_optional_not_required,
    test_generator_five_sampler_sockets_are_forceinput,
    test_generator_hidden_is_unique_id_only,
    test_generator_is_not_an_output_node,
    test_generator_is_experimental_and_correct_category,
    test_generator_fixed_output_set,
    test_generator_every_input_has_a_tooltip,
    test_generator_every_output_has_a_tooltip,
    test_generator_generation_settings_is_a_real_string_widget_not_hidden,
    test_preview_is_an_output_node,
    test_preview_is_experimental_and_correct_category,
    test_preview_hidden_is_prompt_and_extra_pnginfo,
    test_preview_image_inputs_are_all_optional,
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
