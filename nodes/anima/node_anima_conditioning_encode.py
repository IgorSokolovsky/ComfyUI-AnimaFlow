"""AnimaConditioningEncode — artist-mix-aware CLIP text encode.

Takes plain `STRING` positive/negative text (not a custom prompt type), so
it works with ANY prompt source in this pack or elsewhere — not just
`AnimaPromptStudio`. All actual encode/blend logic lives in the shared
`_anima_conditioning_helpers.resolve_conditioning`, the SAME function
`AnimaGenerator`'s STRING+CLIP fallback path calls — so wiring the same
text/clip/artist settings into either node produces identical CONDITIONING.
This module only assembles `INPUT_TYPES`/tooltips and calls that helper
once per pane. No JS: default widgets only.

Artist mix is a POSITIVE-prompt-only concept here (matching the reference
pack's own conceptual model: `easyuse_anima/prompt/artist_mix.py` only ever
mixes into the POSITIVE branch's conditioning — nothing in that module
touches a negative prompt at all). The `negative` pane is therefore always
a plain encode via the shared helper, with `artist_mix_enabled` left at its
default `False` — never blended, regardless of the positive pane's widgets.
"""

from __future__ import annotations

from ._anima_conditioning_helpers import resolve_conditioning


class AnimaConditioningEncode:
    CATEGORY = "AnimaFlow/anima"
    EXPERIMENTAL = True
    FUNCTION = "encode"
    RETURN_TYPES = ("CONDITIONING", "CONDITIONING")
    RETURN_NAMES = ("positive", "negative")
    OUTPUT_TOOLTIPS = (
        "The encoded positive CONDITIONING — a plain CLIP text encode of `positive`, or (if artist_mix_enabled and artist_tags parses to at least one artist) a weighted blend of that encode with one or more separately-encoded artist conditionings.",
        "The encoded negative CONDITIONING — always a plain CLIP text encode of `negative`; artist mix never applies to the negative pane.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {
                    "tooltip": "The CLIP model used to encode both positive and negative text (and, if artist_mix_enabled, each listed artist name) into CONDITIONING.",
                }),
                "positive": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "The main positive prompt text to encode.",
                }),
                "negative": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "tooltip": "The main negative prompt text to encode — always a plain encode, never affected by artist mix.",
                }),
                "artist_mix_enabled": ("BOOLEAN", {
                    "default": False,
                    "tooltip": (
                        "Blends one or more separately-encoded, separately-weighted \"artist\" "
                        "CONDITIONING branches into the positive prompt's own CONDITIONING at the "
                        "tensor level, instead of just concatenating artist tags into the prompt "
                        "text — plain text concatenation can get diluted or ignored by the text "
                        "encoder once mixed in with a lot of other tokens, whereas a tensor-level "
                        "blend keeps each artist's own influence intact. Off by default (positive is "
                        "then just a plain encode of `positive` as typed, byte-identical to a stock "
                        "CLIPTextEncode). Has no effect on `negative` — artist mix is positive-only."
                    ),
                }),
                "artist_tags": ("STRING", {
                    "default": "",
                    "tooltip": (
                        "Only used if artist_mix_enabled: comma-separated `name` or `name:weight` "
                        "entries listing which artists to blend in, e.g. "
                        "\"@wlop:1.0, @sakimichan:0.6, greg rutkowski\" — weight is optional and "
                        "defaults to 1.0 when omitted. Each listed artist's NAME is CLIP-encoded on "
                        "its own (separately from `positive`), then blended into the positive "
                        "CONDITIONING at its given weight, scaled overall by artist_mix_strength. "
                        "Left empty (or with no valid entries), artist mix silently falls back to a "
                        "plain encode even if artist_mix_enabled is on."
                    ),
                }),
                "artist_mix_strength": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.0,
                    "max": 5.0,
                    "step": 0.05,
                    "tooltip": (
                        "Only used if artist_mix_enabled and artist_tags parses to at least one "
                        "artist: overall blend strength of the WHOLE combined artist contingent "
                        "against the base positive conditioning — 0.0 blends in none of the artists "
                        "(same as a plain encode), 1.0 (default) is a balanced blend, higher values "
                        "push the result further toward the artists' own style at the base prompt's "
                        "expense. Each artist's own `:weight` in artist_tags only controls its share "
                        "relative to the OTHER listed artists, not its pull against the base prompt — "
                        "that's what this widget controls."
                    ),
                }),
            },
        }

    def encode(self, clip, positive, negative, artist_mix_enabled=False, artist_tags="", artist_mix_strength=1.0):
        positive_cond = resolve_conditioning(
            clip, positive,
            artist_mix_enabled=artist_mix_enabled,
            artist_tags=artist_tags,
            artist_mix_strength=artist_mix_strength,
        )
        # Negative is always a plain encode - artist mix is a positive-prompt
        # concept only (see module docstring), so artist_mix_enabled is
        # deliberately NOT forwarded here regardless of the positive pane's
        # widgets.
        negative_cond = resolve_conditioning(clip, negative)
        return (positive_cond, negative_cond)


__all__ = ("AnimaConditioningEncode",)
