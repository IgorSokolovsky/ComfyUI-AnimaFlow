"""Pure output-size-cap maths (design doc §6 step 5, §9's fourth item, §1b
item 4). Ported from upstream `_aio_final_fit_size`
(`../ComfyUI-EasyUseAnima/easyuse_anima/aio/postprocess.py:42-86`, MIT ©
n0va39 — THIRD_PARTY_NOTICES.md). The OLD (deleted) port only ever rounded
size *up*, leaving the final image unbounded — this module is the fix.

Operates on plain width/height ints, not an image tensor, so it stays
torch-free; `pipeline.py` reads `image.shape` and calls back in with plain
ints, then does the actual resize.
"""
from __future__ import annotations

from math import sqrt
from typing import Any, Dict, Tuple

MODE_MAX_LONG_EDGE = "max_long_edge"
MODE_MEGAPIXELS = "megapixels"

# Matches the numeric value upstream's own final-fit rounding uses
# (`naia/client.py`'s `LATENT_ALIGN = 8`) — coincidence of value, not of
# meaning: this isn't the same "8x latent" alignment as sampling, just the
# same rounding grain upstream picked for this stage too.
DEFAULT_ALIGN = 8


def fit_size(
    width: int,
    height: int,
    *,
    enabled: bool,
    mode: str = MODE_MAX_LONG_EDGE,
    max_long_edge: int = 2048,
    max_megapixels: float = 4.0,
    align: int = DEFAULT_ALIGN,
) -> Tuple[int, int, float]:
    """-> `(target_width, target_height, scale)`.

    `scale` is `1.0` (a no-op) whenever the cap is off or the image already
    fits — callers should treat `scale >= 1.0` as "nothing to do" rather than
    resizing to the same size. This function can never produce a `scale`
    above `1.0`, which is precisely the old bug's fix: rounding up past the
    cap can no longer happen because there is no code path here that ever
    enlarges.
    """
    try:
        width = max(1, int(width))
    except (TypeError, ValueError):
        width = 1
    try:
        height = max(1, int(height))
    except (TypeError, ValueError):
        height = 1
    if not enabled:
        return width, height, 1.0

    scale = 1.0
    if mode == MODE_MEGAPIXELS:
        max_pixels = max(1.0, float(max_megapixels) * 1_000_000.0)
        pixels = float(width * height)
        if pixels > max_pixels:
            scale = sqrt(max_pixels / pixels)
    else:
        long_edge = max(width, height)
        cap = max(1, int(max_long_edge))
        if long_edge > cap:
            scale = cap / long_edge

    if scale >= 1.0:
        return width, height, 1.0

    align = max(1, int(align))
    target_width = max(align, (round(width * scale) // align) * align)
    target_height = max(align, (round(height * scale) // align) * align)
    return target_width, target_height, scale


def run_postprocess(width: int, height: int, postprocess_settings: Any) -> Dict[str, Any]:
    """`generation_settings.postprocess` (already shape-normalized by
    `settings.py`) plus the pre-stage width/height -> a metadata dict
    describing what the fit maths would do — for `pipeline.py` to act on and
    for the Generator's `metadata_json` output to report. Never touches an
    actual image tensor — see module docstring.
    """
    if not isinstance(postprocess_settings, dict):
        postprocess_settings = {}
    enabled = bool(postprocess_settings.get("enabled", False))
    fit_settings = postprocess_settings.get("fit")
    if not isinstance(fit_settings, dict):
        fit_settings = {}

    mode = str(fit_settings.get("mode") or MODE_MAX_LONG_EDGE)
    try:
        max_long_edge = int(fit_settings.get("max_long_edge", 2048))
    except (TypeError, ValueError):
        max_long_edge = 2048
    try:
        max_megapixels = float(fit_settings.get("max_megapixels", 4.0))
    except (TypeError, ValueError):
        max_megapixels = 4.0

    target_width, target_height, scale = fit_size(
        width, height, enabled=enabled, mode=mode,
        max_long_edge=max_long_edge, max_megapixels=max_megapixels,
    )
    return {
        "enabled": enabled,
        "mode": mode,
        "max_long_edge": max_long_edge,
        "max_megapixels": max_megapixels,
        "method": str(fit_settings.get("method") or "bicubic"),
        "input_width": width,
        "input_height": height,
        "target_width": target_width,
        "target_height": target_height,
        "scale": scale,
        "applied": scale < 1.0,
    }
