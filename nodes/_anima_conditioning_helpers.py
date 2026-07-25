"""Shared CONDITIONING-resolution helper for `AnimaGenerator` and (Phase 3)
`AnimaConditioningEncode` - both must produce IDENTICAL CONDITIONING for the
same `(clip, text)` pair, so that logic lives in exactly ONE place instead
of being duplicated (and risking drift) per node.

`resolve_conditioning(clip, text, artist_mix_enabled=False)` is the exact
function Phase 3's `AnimaConditioningEncode` is expected to import and wrap
directly, not reimplement - see the DEVIATION note below for what
`artist_mix_enabled` does (and doesn't yet do) in this build.

Plain-encode path mirrors core ComfyUI's own `CLIPTextEncode.encode()`
exactly: it calls that SAME core node class when it can be located (see
`_comfy_core_bridge.find_core_node_class`), guaranteeing bit-identical
CONDITIONING to wiring the same text into a stock `CLIPTextEncode` node,
and only falls back to calling `clip.tokenize()` /
`clip.encode_from_tokens_scheduled()` directly - still the exact same two
calls core's own node makes internally - if that class can't be located.

DEVIATION - `artist_mix_enabled` is a documented SIMPLIFICATION, not the
full port. The reference pack's artist-mix system
(`../ComfyUI-EasyUseAnima/easyuse_anima/prompt/artist_mix.py`, ~1500 lines)
blends MULTIPLE separately-encoded per-artist CONDITIONING branches at the
tensor level - weighted average / delta-RMS-restore / clustered /
exact-top-K / hybrid modes, each with its own strength-scale and
RMS-energy-restore math - rather than a single plain text encode. That is
a substantial, genuinely separate feature, not a small tweak, and this
build's scope is the `AnimaGenerator` pipeline skeleton (first pass +
highres), not that algorithm. `artist_mix_enabled` is accepted here now so
the call-site signature Phase 3 needs already exists and won't have to
change shape later, but it is currently a documented no-op: this function
always performs a plain CLIP text encode regardless of its value (logged
at DEBUG when `True` is passed, so that's discoverable instead of silently
ignored). Phase 3 (`AnimaConditioningEncode`, which owns the user-facing
artist-mix widgets) is the right place to decide whether/how much of the
full algorithm to port; expanding this function to actually branch on
`artist_mix_enabled` at that point is a contained change localized to this
one module.
"""

from __future__ import annotations

import logging

from ._comfy_core_bridge import find_core_node_class

logger = logging.getLogger("AnimaFlow")


def encode_text_conditioning(clip, text: str):
    """Plain CLIP text encode, mirroring core ComfyUI's own
    `CLIPTextEncode.encode()` call path exactly (see module docstring)."""
    encoder_cls = find_core_node_class("CLIPTextEncode")
    if encoder_cls is not None:
        return encoder_cls().encode(clip, text)[0]

    # Fallback: the exact same calls CLIPTextEncode.encode() itself makes,
    # used only when core's own node class can't be located for some
    # reason (see `_comfy_core_bridge`'s module docstring for when that
    # happens) rather than hard-failing.
    tokens = clip.tokenize(text)
    if hasattr(clip, "encode_from_tokens_scheduled"):
        return clip.encode_from_tokens_scheduled(tokens)
    conditioning, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
    return [[conditioning, {"pooled_output": pooled}]]


def resolve_conditioning(clip, text, artist_mix_enabled: bool = False):
    """Resolve a CONDITIONING from `text` via `clip`. See this module's
    docstring for the exact contract Phase 3's `AnimaConditioningEncode`
    relies on, and the `artist_mix_enabled` simplification/deviation.

    Raises `ValueError` if `clip` is `None` - defensive: by the time this
    is called from `AnimaGenerator`, its own pane-resolution wrapper
    (`_anima_generator_helpers.resolve_pane_conditioning`) has already
    raised a more specific, pane-labeled error for that case, so this only
    fires for a direct caller (e.g. a bare `AnimaConditioningEncode` call)
    that skips that wrapper.
    """
    if clip is None:
        raise ValueError("resolve_conditioning: clip is required to encode text into a CONDITIONING.")
    if artist_mix_enabled:
        logger.debug(
            "[AnimaFlow] resolve_conditioning: artist_mix_enabled=True was requested but "
            "this build only implements the plain-encode path (see this module's DEVIATION note) - "
            "falling back to a plain CLIP text encode."
        )
    return encode_text_conditioning(clip, str(text or ""))


__all__ = ("encode_text_conditioning", "resolve_conditioning")
