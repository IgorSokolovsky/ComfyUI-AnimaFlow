"""Shared CONDITIONING-resolution helper for `AnimaGenerator` and
`AnimaConditioningEncode` - both must produce IDENTICAL CONDITIONING for the
same `(clip, text)` pair, so that logic lives in exactly ONE place instead
of being duplicated (and risking drift) per node.

`resolve_conditioning(clip, text, artist_mix_enabled=False, artist_tags="",
artist_mix_strength=1.0)` is the exact function `AnimaConditioningEncode`
imports and wraps directly, not reimplements.

Plain-encode path mirrors core ComfyUI's own `CLIPTextEncode.encode()`
exactly: it calls that SAME core node class when it can be located (see
`_comfy_core_bridge.find_core_node_class`), guaranteeing bit-identical
CONDITIONING to wiring the same text into a stock `CLIPTextEncode` node,
and only falls back to calling `clip.tokenize()` /
`clip.encode_from_tokens_scheduled()` directly - still the exact same two
calls core's own node makes internally - if that class can't be located.

ARTIST MIX - scope decision (see the approved plan's Phase 3 section): the
reference pack's artist-mix system
(`../ComfyUI-EasyUseAnima/easyuse_anima/prompt/artist_mix.py`, ~1500 lines)
supports many exotic blend modes (weighted-average, delta-RMS-restore,
clustered, exact-top-K, hybrid, scheduled). This build deliberately
implements ONLY ONE of those: a straightforward weighted average of the
base positive conditioning and one or more separately-encoded per-artist
conditioning tensors - `artist_mix_enabled=False` (the default) is
UNCHANGED from before this file's Phase 3 extension: a plain CLIP text
encode, byte-identical to a stock `CLIPTextEncode`.

When `artist_mix_enabled=True`:
  1. `artist_tags` (e.g. `"@wlop:1.0, @sakimichan:0.6"`) is parsed by
     `parse_artist_tags` into `(name, weight)` pairs (pure Python, no
     torch - see that function's own docstring for the exact syntax).
  2. If no artists parse out, this silently falls back to a plain encode
     (so `artist_mix_enabled=True` with an empty/unparseable `artist_tags`
     is harmless - this is what pins `AnimaGenerator`'s existing
     `test_resolve_conditioning_artist_mix_enabled_still_plain_encodes`
     test, since it never touches `artist_tags` at all).
  3. Otherwise, the base text and each artist NAME are each CLIP-encoded
     separately (`encode_text_conditioning`), then blended as a weighted
     average of the resulting CONDITIONING tensors: base branch has raw
     weight 1.0, each artist's raw weight is its own listed `:weight` times
     `artist_mix_strength` (so `artist_mix_strength` scales the whole
     artist contingent's overall pull against the base prompt, while each
     artist's own weight only controls its share relative to the OTHER
     listed artists) - all raw weights are then normalized so they sum to
     1.0, giving a true weighted average. `pooled_output` (when present on
     every branch involved) is blended the same way; the base's own
     `pooled_output` is kept unchanged otherwise. Sequence-length
     mismatches between the base and an artist's tensor are padded/
     truncated to the base tensor's own length before blending - the exact
     same pad-shorter/truncate-longer mechanic core ComfyUI's own
     `ConditioningAverage` node (`comfy_extras`) uses for its two-input
     blend, generalized here to N artist branches - so the result stays a
     normal `[[tensor, metadata_dict], ...]` CONDITIONING any core
     `KSampler` can consume without surprises, not a bespoke shape.

This is a genuinely simpler algorithm than the reference pack's (one mode,
not ten), which is the deliberate scope for this pack - see the plan's
"Artist-mix scope" note.
"""

from __future__ import annotations

import logging
import math

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


def parse_artist_tags(raw: str) -> list[tuple[str, float]]:
    """Parse an `artist_tags` widget string into `(name, weight)` pairs.

    Syntax: comma-separated `name` or `name:weight` entries, e.g.
    `"@wlop:1.0, @sakimichan:0.6, greg rutkowski"` - weight is optional and
    defaults to `1.0` when omitted. Chosen over the reference pack's heavier
    bracket/paren artist-mix DSL (`[[tag:weight]]`, `(tag:weight)`,
    `------`-separated blocks, wildcard-substitution) because this build
    implements exactly ONE blend mode (see this module's docstring) - one
    plain, obvious syntax is all that's needed, not a mini-language.

    Rules (pure Python, no torch needed - fully unit-testable):
      - Blank/whitespace-only entries (including an entirely blank/empty
        `raw`) are skipped silently; `parse_artist_tags("")` returns `[]`.
      - The LAST `:` in an entry splits name from weight (so a name may
        itself contain `:` before the final weight, e.g. `"foo:bar:0.5"`
        -> name `"foo:bar"`, weight `0.5`).
      - A present-but-malformed weight (not a finite number, e.g.
        `"wlop:abc"` or a bare trailing `"wlop:"`) does NOT drop the entry
        - it falls back to weight `1.0` for that entry (a slightly-wrong
        weight is more recoverable than silently losing an artist the user
        typed), logged at DEBUG so it's discoverable.
      - A non-positive or non-finite weight (`<= 0`, `NaN`, `inf`) DOES
        drop the entry - a zero/negative/infinite artist weight has no
        defined blend meaning.
      - Duplicate names (exact match after stripping whitespace) have
        their weights SUMMED, first-seen order preserved - mirrors the
        reference pack's own `_coalesce_artist_mix_items` behavior instead
        of silently keeping only one of the two.
    """
    order: list[str] = []
    weights: dict[str, float] = {}

    for raw_entry in str(raw or "").split(","):
        entry = raw_entry.strip()
        if not entry:
            continue

        name = entry
        weight = 1.0

        if ":" in entry:
            candidate_name, _, candidate_weight = entry.rpartition(":")
            candidate_name = candidate_name.strip()
            candidate_weight = candidate_weight.strip()
            if candidate_name:
                name = candidate_name
                try:
                    weight = float(candidate_weight)
                except ValueError:
                    logger.debug(
                        "[AnimaFlow] parse_artist_tags: malformed weight %r for %r, defaulting to 1.0",
                        candidate_weight, candidate_name,
                    )
                    weight = 1.0

        if not math.isfinite(weight) or weight <= 0:
            continue

        if name not in weights:
            order.append(name)
            weights[name] = 0.0
        weights[name] += weight

    return [(name, weights[name]) for name in order]


def _artist_mix_blend_weights(
    artists: list[tuple[str, float]], artist_mix_strength: float
) -> tuple[float, list[float]] | None:
    """Pure weight math for the artist-mix blend - no torch/tensors
    involved, so this is independently unit-testable. Returns
    `(base_weight, artist_weights)`, already normalized so
    `base_weight + sum(artist_weights) == 1.0`, or `None` if the inputs
    don't produce a usable blend (e.g. every artist weight collapsed to
    non-positive after scaling), in which case the caller should fall back
    to a plain encode instead of blending in nothing.

    The base branch always starts at raw weight `1.0`; each artist's raw
    weight is `its own :weight * artist_mix_strength` - see this module's
    docstring for why `artist_mix_strength` is a whole-contingent scale
    rather than a per-artist one.
    """
    base_raw = 1.0
    artist_raw = [max(0.0, float(weight) * float(artist_mix_strength)) for _name, weight in artists]
    total = base_raw + sum(artist_raw)
    if not math.isfinite(total) or total <= 0:
        return None
    return base_raw / total, [raw / total for raw in artist_raw]


def _align_conditioning_tensor_length(tensor, target_tensor):
    """Pad (with zeros) or truncate `tensor` so its sequence dimension
    (dim 1, `[batch, seq, embed]`) matches `target_tensor`'s - the exact
    same pad-shorter/truncate-longer mechanic core ComfyUI's own
    `ConditioningAverage` node uses. Torch is only actually imported (and
    therefore only actually REQUIRED) when the lengths differ - same-length
    tensors (the common case for short artist-name encodes matched against
    a similarly-tokenized base prompt) blend via plain `+`/`*` without ever
    needing torch, which is what lets this repo's own torch-less test
    suite exercise the blend math directly with duck-typed fake tensors."""
    target_length = target_tensor.shape[1]
    current_length = tensor.shape[1]
    if current_length == target_length:
        return tensor

    try:
        import torch  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "[AnimaFlow] artist_mix: torch is required to align a differently-sized artist "
            "conditioning tensor against the base prompt's before blending."
        ) from exc

    if current_length < target_length:
        pad = torch.zeros(
            (tensor.shape[0], target_length - current_length, tensor.shape[2]),
            dtype=tensor.dtype,
            device=tensor.device,
        )
        return torch.cat([tensor, pad], dim=1)
    return tensor[:, :target_length]


def _blend_artist_conditionings(
    base_conditioning,
    artist_conditionings: list,
    base_weight: float,
    artist_weights: list[float],
):
    """Weighted-average tensor blend of `base_conditioning` against one or
    more `artist_conditionings` (each itself a full CONDITIONING list from
    `encode_text_conditioning`). See this module's docstring for the exact
    algorithm; briefly: only the FIRST entry of each artist's own encoded
    conditioning is used (mirroring core ComfyUI's `ConditioningAverage`
    node, which does the exact same thing with its `conditioning_from`
    input - warning rather than erroring if there's more than one), the
    base's OWN entries are all preserved (so a dual-encoder base
    conditioning with 2+ entries still blends correctly, entry by entry).
    """
    for index, conditioning in enumerate(artist_conditionings):
        if len(conditioning) > 1:
            logger.warning(
                "[AnimaFlow] artist_mix: artist #%d's own encoded conditioning has %d entries; "
                "only the first is used (mirrors core ConditioningAverage's own conditioning_from handling).",
                index, len(conditioning),
            )

    blended = []
    for base_tensor, base_meta in base_conditioning:
        combined = base_tensor * base_weight

        base_meta_dict = base_meta if isinstance(base_meta, dict) else {}
        pooled_base = base_meta_dict.get("pooled_output")
        pooled_blend = pooled_base * base_weight if pooled_base is not None else None
        pooled_usable = pooled_base is not None

        for conditioning, artist_weight in zip(artist_conditionings, artist_weights):
            artist_tensor, artist_meta = conditioning[0]
            aligned = _align_conditioning_tensor_length(artist_tensor, base_tensor)
            combined = combined + aligned * artist_weight

            artist_meta_dict = artist_meta if isinstance(artist_meta, dict) else {}
            artist_pooled = artist_meta_dict.get("pooled_output")
            if pooled_usable and artist_pooled is not None:
                pooled_blend = pooled_blend + artist_pooled * artist_weight
            else:
                pooled_usable = False

        metadata = dict(base_meta_dict)
        if pooled_usable and pooled_blend is not None:
            metadata["pooled_output"] = pooled_blend

        blended.append([combined, metadata])
    return blended


def resolve_conditioning(
    clip,
    text,
    artist_mix_enabled: bool = False,
    artist_tags: str = "",
    artist_mix_strength: float = 1.0,
):
    """Resolve a CONDITIONING from `text` via `clip`. See this module's
    docstring for the exact contract `AnimaConditioningEncode` relies on,
    and for the artist-mix algorithm this applies when `artist_mix_enabled`
    is `True` AND `artist_tags` parses to at least one artist.

    `artist_mix_enabled=False` (the default) is a plain CLIP text encode,
    UNCHANGED from before this module's Phase 3 artist-mix extension.

    Raises `ValueError` if `clip` is `None` - defensive: by the time this
    is called from `AnimaGenerator`, its own pane-resolution wrapper
    (`_anima_generator_helpers.resolve_pane_conditioning`) has already
    raised a more specific, pane-labeled error for that case, so this only
    fires for a direct caller (e.g. a bare `AnimaConditioningEncode` call)
    that skips that wrapper.
    """
    if clip is None:
        raise ValueError("resolve_conditioning: clip is required to encode text into a CONDITIONING.")

    base_conditioning = encode_text_conditioning(clip, str(text or ""))

    if not artist_mix_enabled:
        return base_conditioning

    artists = parse_artist_tags(artist_tags)
    if not artists:
        logger.debug(
            "[AnimaFlow] resolve_conditioning: artist_mix_enabled=True but artist_tags parsed to no "
            "artists - falling back to a plain CLIP text encode."
        )
        return base_conditioning

    weights = _artist_mix_blend_weights(artists, artist_mix_strength)
    if weights is None:
        logger.debug(
            "[AnimaFlow] resolve_conditioning: artist_mix_enabled=True but the resulting blend weights "
            "were degenerate (e.g. artist_mix_strength scaled every artist to <= 0) - falling back to a "
            "plain CLIP text encode."
        )
        return base_conditioning
    base_weight, artist_weights = weights

    artist_conditionings = [encode_text_conditioning(clip, name) for name, _weight in artists]
    return _blend_artist_conditionings(base_conditioning, artist_conditionings, base_weight, artist_weights)


__all__ = (
    "encode_text_conditioning",
    "parse_artist_tags",
    "resolve_conditioning",
)
