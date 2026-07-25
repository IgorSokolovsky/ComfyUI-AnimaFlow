"""Plain-script tests for AnimaDetailerAlignHook's pure logic.

Run directly: `python tests/test_anima_detailer_hook.py` (no pytest, per project
convention). Everything here is plain Python objects/ints - no Impact Pack
needed, since the hook is a pure duck-typed object (see
`_anima_detailer_hook_helpers`'s module docstring): a fake stand-in
`base_hook` is used to verify chaining, exactly as Impact Pack would call
into a real one.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes._anima_detailer_hook_helpers import AnimaAlignedDetailerHook, align_up
from nodes.node_anima_detailer_hook import AnimaDetailerAlignHook


class _FakeBaseHook:
    """Minimal stand-in for a real Impact Pack DETAILER_HOOK, recording
    calls so tests can assert the wrapper actually delegates to it."""

    def __init__(self):
        self.calls = []

    def touch_scaled_size(self, width, height):
        self.calls.append(("touch_scaled_size", width, height))
        return width + 1, height + 1  # nudge so we can tell it ran first

    def post_upscale(self, image, noise_mask):
        self.calls.append(("post_upscale", image, noise_mask))
        return "upscaled:" + str(image)

    def get_skip_sampling(self):
        self.calls.append(("get_skip_sampling",))
        return True

    def pre_ksample(self, model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent, denoise):
        self.calls.append(("pre_ksample", seed))
        return (model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent, denoise)

    def custom_extra_method(self):
        # Not part of the DETAILER_HOOK protocol AnimaAlignedDetailerHook
        # explicitly implements - exercises __getattr__ passthrough.
        return "extra"


def test_align_up_rounds_up_to_multiple():
    assert align_up(100, 64) == 128
    assert align_up(128, 64) == 128
    assert align_up(1, 64) == 64


def test_touch_scaled_size_rounds_up_with_no_base_hook():
    hook = AnimaAlignedDetailerHook(None, 64)
    width, height = hook.touch_scaled_size(100, 200)
    assert (width, height) == (128, 256)


def test_touch_scaled_size_disabled_when_size_multiple_none_or_small():
    hook_none = AnimaAlignedDetailerHook(None, None)
    assert hook_none.touch_scaled_size(100, 200) == (100, 200)

    hook_zero = AnimaAlignedDetailerHook(None, 0)
    assert hook_zero.touch_scaled_size(100, 200) == (100, 200)

    hook_one = AnimaAlignedDetailerHook(None, 1)
    assert hook_one.touch_scaled_size(100, 200) == (100, 200)


def test_touch_scaled_size_chains_to_base_hook_first():
    base = _FakeBaseHook()
    hook = AnimaAlignedDetailerHook(base, 64)
    # base_hook nudges (100,200) -> (101,201) BEFORE this hook rounds up.
    width, height = hook.touch_scaled_size(100, 200)
    assert base.calls == [("touch_scaled_size", 100, 200)]
    assert (width, height) == (align_up(101, 64), align_up(201, 64))


def test_post_upscale_passthrough_without_base_hook():
    hook = AnimaAlignedDetailerHook(None, 64)
    assert hook.post_upscale("img", "mask") == "img"


def test_post_upscale_delegates_to_base_hook():
    base = _FakeBaseHook()
    hook = AnimaAlignedDetailerHook(base, 64)
    assert hook.post_upscale("img", "mask") == "upscaled:img"
    assert base.calls == [("post_upscale", "img", "mask")]


def test_get_skip_sampling_default_false_and_delegates():
    hook = AnimaAlignedDetailerHook(None, 64)
    assert hook.get_skip_sampling() is False

    base = _FakeBaseHook()
    hook_with_base = AnimaAlignedDetailerHook(base, 64)
    assert hook_with_base.get_skip_sampling() is True


def test_pre_ksample_passthrough_and_delegation():
    hook = AnimaAlignedDetailerHook(None, 64)
    args = ("model", 42, 20, 7.0, "euler", "normal", "pos", "neg", "latent", 0.5)
    assert hook.pre_ksample(*args) == args

    base = _FakeBaseHook()
    hook_with_base = AnimaAlignedDetailerHook(base, 64)
    result = hook_with_base.pre_ksample(*args)
    assert result == args
    assert base.calls == [("pre_ksample", 42)]


def test_getattr_falls_through_to_base_hook_for_unknown_methods():
    base = _FakeBaseHook()
    hook = AnimaAlignedDetailerHook(base, 64)
    assert hook.custom_extra_method() == "extra"


def test_getattr_raises_attribute_error_without_base_hook():
    hook = AnimaAlignedDetailerHook(None, 64)
    try:
        hook.custom_extra_method()
        raised = False
    except AttributeError:
        raised = True
    assert raised


def test_node_input_types_contract():
    schema = AnimaDetailerAlignHook.INPUT_TYPES()
    required = schema["required"]
    optional = schema["optional"]
    assert required["size_multiple"][0] == "INT"
    assert required["size_multiple"][1]["default"] == 64
    assert optional["base_hook"][0] == "DETAILER_HOOK"
    for spec in list(required.values()) + list(optional.values()):
        assert "tooltip" in spec[1] and spec[1]["tooltip"]
    assert AnimaDetailerAlignHook.CATEGORY == "AnimaFlow/anima"
    assert AnimaDetailerAlignHook.FUNCTION == "build"
    assert AnimaDetailerAlignHook.RETURN_TYPES == ("DETAILER_HOOK",)
    assert len(AnimaDetailerAlignHook.OUTPUT_TOOLTIPS) == len(AnimaDetailerAlignHook.RETURN_TYPES)


def test_node_build_returns_configured_hook():
    node = AnimaDetailerAlignHook()
    (hook,) = node.build(size_multiple=32, base_hook=None)
    assert isinstance(hook, AnimaAlignedDetailerHook)
    assert hook.touch_scaled_size(10, 10) == (32, 32)


ALL_TESTS = [
    test_align_up_rounds_up_to_multiple,
    test_touch_scaled_size_rounds_up_with_no_base_hook,
    test_touch_scaled_size_disabled_when_size_multiple_none_or_small,
    test_touch_scaled_size_chains_to_base_hook_first,
    test_post_upscale_passthrough_without_base_hook,
    test_post_upscale_delegates_to_base_hook,
    test_get_skip_sampling_default_false_and_delegates,
    test_pre_ksample_passthrough_and_delegation,
    test_getattr_falls_through_to_base_hook_for_unknown_methods,
    test_getattr_raises_attribute_error_without_base_hook,
    test_node_input_types_contract,
    test_node_build_returns_configured_hook,
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
