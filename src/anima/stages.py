"""Pure output-stage resolution (design doc §5/§6/§11 "stage gating"). No
comfy/torch import anywhere in this file — turning the labels resolved here
into real tensors is `pipeline.py`'s job.

**2026-07-28 reversal**: the Generator used to expose three FIXED `IMAGE`
sockets (`image`/`image_base`/`image_mid`), each always populated — a
disabled stage's socket passed the previous stage's tensor through rather
than being empty, purely because there were three fixed sockets to fill.
That's gone: the Generator now returns ONE `images` list
(`OUTPUT_IS_LIST`), and a stage that didn't run is simply OMITTED from it
rather than duplicating the previous entry (`resolve_stage_labels`, below,
replaces the old `resolve_outputs`, whose whole reason to exist was filling
three sockets that no longer exist).
"""
from __future__ import annotations

from typing import Any, Dict, List

# The three labels a run's `images` list can carry, in the order they always
# appear when present (`docs/generator-design.md` §3/§5 reversal notes) --
# "base" is always the first-pass result and always present; "mid"/"final"
# are each present only when something downstream of the previous entry
# actually changed the image.
STAGE_BASE = "base"
STAGE_MID = "mid"
STAGE_FINAL = "final"
STAGE_ORDER = (STAGE_BASE, STAGE_MID, STAGE_FINAL)


def detailer_is_live(*, detailer_enabled: bool, have_impact: bool, blocks: Any) -> bool:
    """The detailer stage only actually RUNS when three things are all true:
    the stage toggle is on, Impact is installed (`DetailerForEach` +
    `MaskToSEGS` — design doc §4/§6a), and at least one block is
    individually enabled. Any one of those false -> the stage is INERT and
    the image it would have produced is identical to what came before it —
    never an error (design doc §11 "detailer with every block off, or
    Impact absent, is inert rather than an error").
    """
    if not detailer_enabled or not have_impact:
        return False
    if not isinstance(blocks, dict):
        return False
    return any(
        isinstance(block, dict) and bool(block.get("enabled"))
        for block in blocks.values()
    )


def resolve_stage_labels(
    *, highres_enabled: bool, detailer_live: bool, upscale_live: bool, postprocess_applied: bool,
) -> List[str]:
    """Which of `base`/`mid`/`final` are genuinely DISTINCT images this run
    produced, in order — the labels `pipeline.run_generator` uses to build
    both the `images` list itself and `metadata_json`'s `stage_labels` (the
    single place a position's meaning is recorded, per this task's brief:
    "keep the label mapping in exactly one pure place" — `AnimaPreview`
    reads THIS SAME field back rather than re-deriving it).

    `base` (the first pass) is always present — nothing runs before it.
    `mid` is present iff something between base and the pre-upscale point
    actually changed the image (highres OR a live detailer pass — either
    alone is enough, matching the old three-socket design's "highres has no
    socket of its own, absorbed into the base->mid span"). `final` is
    present iff something after that point changed the image again (a live
    upscale OR postprocess actually resizing it — postprocess "has no label
    of its own" per the old design, but it DOES change the pixels, so its
    own `applied` flag still counts toward "final differs").

    A run where every stage is off returns just `["base"]` — "one enabled
    stage -> one entry" falls out of this rule for free, it isn't a special
    case.
    """
    stages = [STAGE_BASE]
    if highres_enabled or detailer_live:
        stages.append(STAGE_MID)
    if upscale_live or postprocess_applied:
        stages.append(STAGE_FINAL)
    return stages


__all__ = (
    "STAGE_BASE", "STAGE_MID", "STAGE_FINAL", "STAGE_ORDER",
    "detailer_is_live", "resolve_stage_labels",
)
