"""AnimaPreview — display-only node for the `AnimaGenerator` preview channel.

Pairs with the (not-yet-built, see `nodes/_anima_preview_channel.py`'s
module docstring) `AnimaGenerator` pipeline node: the Generator broadcasts
intermediate-stage frames on a named channel via
`_anima_preview_channel.broadcast_preview` instead of rendering them itself,
and any number of `AnimaPreview` nodes tuned to that same channel name
render the live feed in their own small, independently-resizable DOM widget
(`js/anima/anima_preview/`). This is a deliberate split from the reference pack,
whose single monolithic node embeds the live-preview panel directly in the
same settings-heavy node body, hurting pan/zoom UX on the graph canvas.

No `RETURN_TYPES`/data output on purpose (matches ComfyUI's own
`PreviewImage`-style "preview-only" nodes: empty `RETURN_TYPES`,
`OUTPUT_NODE = True` so it still executes even though nothing is wired to
its output) — its only job is display, driven entirely by the websocket
event the JS extension listens for, not by anything computed at execution
time. `channel` is a plain widget, not a wired socket, by design: any number
of `AnimaPreview` nodes can share one channel, listen to different
channels, or sit idle if nothing broadcasts to their name.
"""

from __future__ import annotations


class AnimaPreview:
    CATEGORY = "AnimaFlow/anima"
    EXPERIMENTAL = True
    FUNCTION = "preview"
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "channel": ("STRING", {
                    "default": "default",
                    "tooltip": (
                        "Name of the preview channel to listen on. Must exactly match the "
                        "AnimaGenerator node's `preview_channel` field to receive its "
                        "in-progress stage frames (first pass / highres / detailer / upscale / "
                        "final). Deliberately a plain name, not a wired socket, so any number of "
                        "AnimaPreview nodes can watch the same channel, watch different channels, "
                        "or sit idle if nothing ever broadcasts to that name."
                    ),
                }),
            },
        }

    def preview(self, channel="default"):
        # Nothing to compute: the live feed is delivered to the frontend
        # entirely over the `webtoon-anima-preview` websocket event (see
        # `_anima_preview_channel.broadcast_preview`), independent of this
        # node's own execution. It still needs to exist as an OUTPUT_NODE so
        # ComfyUI runs it (and therefore keeps its widget/JS mounted) even
        # though nothing is wired to a (nonexistent) output.
        return {}


__all__ = ("AnimaPreview",)
