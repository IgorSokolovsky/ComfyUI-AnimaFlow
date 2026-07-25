"""Shared preview-broadcast channel used by `AnimaPreview` and (in a later
build) `AnimaGenerator`.

Design: `AnimaGenerator`'s pipeline stages call `broadcast_preview(channel,
image, stage_label)` mid-execution to push an intermediate frame (first
pass / highres / detailer / upscale / final) over a websocket event, tagged
with the channel name it was told to broadcast on (its `preview_channel`
widget). Any number of `AnimaPreview` nodes can have their own `channel`
widget set to that same string to receive the frames — this is a pub/sub
name match, not a wired graph socket, so the Generator's settings-heavy node
body never needs to embed a live-image DOM widget itself (see
`nodes/node_anima_preview.py` / `js/anima_preview/`).

Payload shape sent over the wire: `{"channel": str, "stage_label": str,
"image_data": <base64 PNG, no data-URI prefix>}`. This deliberately departs
from the reference pack's approach (`../ComfyUI-EasyUseAnima/easyuse_anima/
aio/preview.py`, `_send_aio_preview_event`), which saves each preview frame
to ComfyUI's temp directory via `folder_paths`/PIL and sends back file
references (`{filename, subfolder, type}`) for the frontend to fetch through
ComfyUI's own `/view` route. That approach is more bandwidth-efficient for
large/many frames, but pulls in a `folder_paths` dependency and leaves temp
files on disk that something has to clean up — overkill for this channel,
whose whole point is a small number of small in-progress preview frames
shown live and then discarded. An inline base64 PNG keeps this module
self-contained (no disk I/O, nothing to garbage-collect) at the cost of a
larger websocket payload per frame; if that tradeoff turns out wrong at
real usage scale, swapping to the file-ref approach is a contained change
localized to this module + `js/anima_preview`'s frame-consuming code.

Guarded exactly like `autocomplete/api.py`: everything that requires a live
ComfyUI process (`from server import PromptServer`) — and everything that
requires `numpy`/`PIL` to encode the frame — is wrapped so a failure to
import either degrades to a silent no-op (logged at DEBUG) instead of
raising. `broadcast_preview` never raises, so a pipeline node can call it
freely mid-run without wrapping every call in its own try/except.
"""

from __future__ import annotations

import base64
import io
import logging

logger = logging.getLogger("AnimaFlow")

# This pack's own websocket event namespace — deliberately NOT the reference
# pack's `"easyuse-anima-aio-preview"` name, so the two packs' frontends
# never collide if both happen to be installed side by side.
PREVIEW_EVENT = "webtoon-anima-preview"

DEFAULT_CHANNEL = "default"


def normalize_channel(channel) -> str:
    """Sanitize a `channel` widget value: strips whitespace, falls back to
    `DEFAULT_CHANNEL` for `None`/empty/blank input so an unset Preview node
    and an unset Generator node still find each other on `"default"`."""
    text = str(channel or "").strip()
    return text or DEFAULT_CHANNEL


def build_preview_payload(channel: str, stage_label: str, image_data: str) -> dict:
    """Pure assembly of the websocket payload dict — split out from
    `broadcast_preview` so the message shape itself is testable without any
    PromptServer/PIL dependency at all."""
    return {
        "channel": normalize_channel(channel),
        "stage_label": str(stage_label or ""),
        "image_data": image_data,
    }


def _encode_frame_to_png_base64(image):
    """Encode the FIRST frame of an IMAGE tensor/array (float 0..1, shape
    `[B, H, W, C]` or `[H, W, C]`) as a base64 PNG string (no
    `data:image/png;base64,` prefix — the frontend adds that when it builds
    an `<img src>`). Returns `None` (never raises) if `numpy`/`PIL` aren't
    importable or the frame can't be encoded for any other reason — this is
    a soft dependency exactly like the rest of this module, so calling this
    outside a ComfyUI/torch environment (e.g. the plain-script test suite)
    is a safe, silent no-op.

    Only encodes the first frame in the batch: `AnimaPreview` shows one
    representative frame per broadcast call/stage, not a whole batch.
    """
    try:
        import numpy as np  # type: ignore
        from PIL import Image  # type: ignore
    except Exception as exc:
        logger.debug("[AnimaFlow] preview channel: numpy/PIL unavailable: %s", exc)
        return None

    try:
        frame = image
        detach = getattr(frame, "detach", None)
        if callable(detach):
            frame = detach()
        cpu = getattr(frame, "cpu", None)
        if callable(cpu):
            frame = cpu()
        to_numpy = getattr(frame, "numpy", None)
        array = to_numpy() if callable(to_numpy) else np.asarray(frame)
        if array.ndim == 4:
            array = array[0]
        pixels = np.clip(255.0 * array, 0, 255).astype("uint8")
        pil_image = Image.fromarray(pixels)
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception as exc:
        logger.debug("[AnimaFlow] preview channel: failed to encode frame: %s", exc)
        return None


def broadcast_preview(channel: str, image, stage_label: str) -> bool:
    """Broadcast one preview frame to every `AnimaPreview` node listening on
    `channel`, over the `PREVIEW_EVENT` websocket event.

    Returns `True` if a message was actually sent, `False` if this no-op'd
    (no live `PromptServer` instance — e.g. running outside ComfyUI, or in
    the plain-script test suite — or the frame couldn't be encoded, e.g.
    `numpy`/`PIL` aren't installed).

    NEVER raises: the entire body is one guarded block, so a pipeline node
    (`AnimaGenerator`) can call this freely mid-run without wrapping every
    call in its own try/except — a broadcast failure degrades to a no-op,
    logged at DEBUG, not a crashed generation.
    """
    try:
        image_data = _encode_frame_to_png_base64(image)
        if image_data is None:
            return False

        payload = build_preview_payload(channel, stage_label, image_data)

        from server import PromptServer  # type: ignore

        prompt_server = getattr(PromptServer, "instance", None)
        send_sync = getattr(prompt_server, "send_sync", None)
        if prompt_server is None or send_sync is None:
            return False
        client_id = getattr(prompt_server, "client_id", None)
        send_sync(PREVIEW_EVENT, payload, client_id)
        return True
    except Exception as exc:
        # VERIFY-IN-COMFYUI: this branch is what actually fires outside a
        # live ComfyUI process (no `server` module at all — see
        # `test_anima_preview_channel.py`), and is the same guarded-import
        # shape as `autocomplete/api.py`'s route registration.
        logger.debug("[AnimaFlow] preview channel: failed to send preview event: %s", exc)
        return False


__all__ = (
    "DEFAULT_CHANNEL",
    "PREVIEW_EVENT",
    "broadcast_preview",
    "build_preview_payload",
    "normalize_channel",
)
