"""Pure output-stage resolution (design doc §5 Outputs, §6, §11 "stage
gating"). No comfy/torch import anywhere in this file — turning the labels
resolved here into real tensors is `pipeline.py`'s job.

Mirrors `playground/generator.html`'s `resolveOutputs()` line for line (the
mockup is the behavioural reference, design doc's header) — given which
stages are enabled/live, which of the real passes does each of the
Generator's three image outputs actually carry right now?
"""
from __future__ import annotations

from typing import Any, Dict

# The real passes an image can come from, in pipeline order (design doc §6:
# first pass -> highres -> detailer -> upscale -> postprocess). "base" is
# always the first-pass result — nothing before it exists to fall back to.
# Postprocess has no label of its own: it only resizes whichever tensor
# `image` already names, it never changes WHICH pass that is (design doc §6
# step 5), so there is no `STAGE_POSTPROCESS`.
STAGE_BASE = "base"
STAGE_HIGHRES = "highres"
STAGE_DETAILER = "mid"
STAGE_UPSCALE = "upscale"


def detailer_is_live(*, detailer_enabled: bool, have_impact: bool, blocks: Any) -> bool:
    """The detailer stage only actually RUNS when three things are all true:
    the stage toggle is on, Impact is installed (`DetailerForEach` +
    `MaskToSEGS` — design doc §4/§6a), and at least one block is
    individually enabled. Any one of those false -> the stage is INERT and
    passes the previous image through untouched, never an error (design doc
    §11 "detailer with every block off, or Impact absent, is inert rather
    than an error").
    """
    if not detailer_enabled or not have_impact:
        return False
    if not isinstance(blocks, dict):
        return False
    return any(
        isinstance(block, dict) and bool(block.get("enabled"))
        for block in blocks.values()
    )


def resolve_outputs(
    *,
    highres_enabled: bool,
    detailer_enabled: bool,
    have_impact: bool,
    blocks: Any,
    upscale_enabled: bool,
    have_usdu: bool,
) -> Dict[str, Any]:
    """-> `{"image_base", "image_mid", "image", "detailer_live"}`, the first
    three each naming which real pass (one of the `STAGE_*` constants above)
    that output actually carries.

    A disabled (or dependency-missing) stage passes the PREVIOUS stage's
    label through rather than advancing — so `image_mid == image_base` is a
    legitimate "no detailer ran" result, not a bug (design doc §5 Outputs
    "A disabled stage's output passes through the previous stage's image").

    `image_base` is always `STAGE_BASE` — defined as "before highres too"
    (design doc §5 Outputs), so nothing upstream of it can ever change what
    it names, regardless of which other stages are on.
    """
    detailer_live = detailer_is_live(
        detailer_enabled=detailer_enabled, have_impact=have_impact, blocks=blocks,
    )
    after_first = STAGE_BASE
    after_highres = STAGE_HIGHRES if highres_enabled else after_first
    after_detailer = STAGE_DETAILER if detailer_live else after_highres
    after_upscale = STAGE_UPSCALE if (upscale_enabled and have_usdu) else after_detailer
    return {
        "image_base": after_first,
        "image_mid": after_detailer,
        "image": after_upscale,
        "detailer_live": detailer_live,
    }
