"""AnimaDetailerAlignHook — Impact-Pack-compatible `DETAILER_HOOK` builder.

Near-verbatim port of the reference pack's `EasyUseAnimaDetailerAlignHook`
(`../ComfyUI-EasyUseAnima/easyuse_anima/nodes/image_nodes.py`). Produces a
hook object (`_anima_detailer_hook_helpers.AnimaAlignedDetailerHook`) that
Impact Pack's `DetailerForEach`-family nodes can wire into their
`detailer_hook` input — soft dependency only: this module never imports
anything from Impact Pack itself (the object just structurally matches the
method names Impact Pack calls into), so the whole pack loads and this node
works standalone with or without Impact Pack installed.
"""

from __future__ import annotations

from ._anima_detailer_hook_helpers import AnimaAlignedDetailerHook


class AnimaDetailerAlignHook:
    CATEGORY = "AnimaFlow/anima"
    EXPERIMENTAL = True
    FUNCTION = "build"
    RETURN_TYPES = ("DETAILER_HOOK",)
    RETURN_NAMES = ("detailer_hook",)
    OUTPUT_TOOLTIPS = (
        "Impact Pack compatible DETAILER_HOOK. Wire into any Impact Pack DetailerForEach-family node's detailer_hook input.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "size_multiple": ("INT", {
                    "default": 64,
                    "min": 0,
                    "max": 1024,
                    "step": 1,
                    "tooltip": (
                        "Rounds Impact Pack's detailer crop-sampling size UP to a multiple of "
                        "this value before it samples, so cropped detail regions stay latent-safe "
                        "(divisible by the VAE/model's required factor) exactly like "
                        "AnimaImageScaleByMultiple does for a whole image. Set to 0 to disable "
                        "rounding and pass Impact Pack's own crop size through unchanged."
                    ),
                }),
            },
            "optional": {
                "base_hook": ("DETAILER_HOOK", {
                    "tooltip": (
                        "Existing DETAILER_HOOK to chain onto. Its methods run FIRST; this hook's "
                        "size rounding is then applied on top of whatever it returns — so you can "
                        "stack this alignment on top of any other hook's own behavior instead of "
                        "replacing it."
                    ),
                }),
            },
        }

    def build(self, size_multiple=64, base_hook=None):
        return (AnimaAlignedDetailerHook(base_hook, size_multiple),)
