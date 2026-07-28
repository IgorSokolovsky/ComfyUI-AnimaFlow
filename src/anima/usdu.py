"""Pure Ultimate SD Upscale tile-planning maths (design doc §6 step 4, §6a's
`mode_type`-vs-`tiled_decode` note, §1b item 3). Ported from upstream
`_aio_usdu_auto_tile_dimension`/`_aio_usdu_tile_plan`
(`../ComfyUI-EasyUseAnima/easyuse_anima/aio/usdu.py`, MIT © n0va39 —
THIRD_PARTY_NOTICES.md). Operates on plain ints, not an image tensor — same
reasoning as `postprocess.py`'s module docstring.

`mode_type` (`"Linear"`/`"Chess"`/`"None"`) is tile ORDER — which sequence
tiles are processed in — and is a completely different axis from
`tiled_decode`, an unrelated VAE memory-saving flag. The two are easy to
conflate because they sit next to each other in the same `usdu` settings
dict; ground truth is upstream `generation_defaults.py:246-266` and
`legacy_generation.py:440-528`. This module deliberately never reads
`tiled_decode` at all — it belongs to the VAE-decode call in `pipeline.py`,
not to tile planning.
"""
from __future__ import annotations

from math import ceil
from typing import Any, Dict


def _align_nearest(value: int, alignment: int) -> int:
    value = max(1, int(value))
    alignment = max(1, int(alignment))
    lower = max(alignment, (value // alignment) * alignment)
    upper = max(alignment, ((value + alignment - 1) // alignment) * alignment)
    return lower if (value - lower) < (upper - value) else upper


def auto_tile_dimension(
    target_size: int,
    preferred_size: int = 1024,
    min_size: int = 512,
    max_size: int = 2048,
) -> int:
    """One axis's auto tile size: how many `preferred_size`-ish tiles does
    `target_size` split into, then what tile size makes that split even —
    clamped to `[min_size, max_size]` and aligned to 64 (USDU's own tile
    grid).
    """
    target_size = max(1, int(target_size))
    min_size = max(64, int(min_size))
    max_size = max(min_size, int(max_size))
    preferred = max(min_size, min(max_size, int(preferred_size)))
    tile_count = max(1, ceil(target_size / preferred))
    tile_size = ceil(target_size / tile_count)
    tile_size = _align_nearest(tile_size, 64)
    return max(min_size, min(max_size, tile_size))


def plan_usdu_tiles(width: int, height: int, scale_by: Any, usdu_settings: Any) -> Dict[str, Any]:
    """The pre-upscale image size plus `generation_settings.upscale.usdu` ->
    the tile plan USDU actually runs with.

    `auto_tile_size` off returns the settings' own fixed `tile_width`/
    `tile_height` untouched; on (the default) computes even tiles per axis
    via `auto_tile_dimension`, against the POST-scale target size — matching
    upstream: tiles are sized against where the image is GOING, not where it
    started.
    """
    if not isinstance(usdu_settings, dict):
        usdu_settings = {}
    try:
        width = max(1, int(width))
    except (TypeError, ValueError):
        width = 1
    try:
        height = max(1, int(height))
    except (TypeError, ValueError):
        height = 1
    try:
        scale = float(scale_by) if scale_by is not None else 1.0
    except (TypeError, ValueError):
        scale = 1.0
    scale = max(0.05, scale)
    target_width = max(1, round(width * scale))
    target_height = max(1, round(height * scale))

    auto_tile = bool(usdu_settings.get("auto_tile_size", True))
    if not auto_tile:
        try:
            tile_width = int(usdu_settings.get("tile_width", 512) or 512)
        except (TypeError, ValueError):
            tile_width = 512
        try:
            tile_height = int(usdu_settings.get("tile_height", 512) or 512)
        except (TypeError, ValueError):
            tile_height = 512
        return {
            "auto": False,
            "input_width": width,
            "input_height": height,
            "target_width": target_width,
            "target_height": target_height,
            "tile_width": tile_width,
            "tile_height": tile_height,
        }

    try:
        preferred = int(usdu_settings.get("auto_tile_target", 1024) or 1024)
    except (TypeError, ValueError):
        preferred = 1024
    try:
        min_size = int(usdu_settings.get("auto_tile_min", 512) or 512)
    except (TypeError, ValueError):
        min_size = 512
    try:
        max_size = int(usdu_settings.get("auto_tile_max", 2048) or 2048)
    except (TypeError, ValueError):
        max_size = 2048

    return {
        "auto": True,
        "input_width": width,
        "input_height": height,
        "target_width": target_width,
        "target_height": target_height,
        "preferred": preferred,
        "min": min_size,
        "max": max_size,
        "tile_width": auto_tile_dimension(target_width, preferred, min_size, max_size),
        "tile_height": auto_tile_dimension(target_height, preferred, min_size, max_size),
    }
