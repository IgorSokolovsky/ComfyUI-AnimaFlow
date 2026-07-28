"""Save + compare-resolution logic for `AnimaPreview` (design doc §7/§7a).
Impure (PIL/numpy/folder_paths, all lazy) — kept out of `src/anima/` because
this is node-specific glue for the ONE node that saves, not pipeline
orchestration; mirrors the project's `nodes/<scope>/_*_helpers.py`
convention (`nodes/controls/_loaders_helpers.py`).

INTERIM SOCKET/STAGE CONVENTION (flagged in the build report — there is no
`js/anima/` yet to draw the per-pane "which output is this side" labels
design doc §7 describes, so Python has no OTHER way to know which stage
`image_a`/`image_b`/`image_c` each represent): this module assumes the
Generator's three outputs are wired positionally --
`image_base -> image_a`, `image_mid -> image_b`, `image -> image_c` -- and
`preview_settings.compare.a`/`.b` name a STAGE (`"base"`/`"mid"`/`"final"`),
resolved through `STAGE_TO_SOCKET` below to find the actual wired tensor.
This is a reasonable "usable if ugly" interim wiring convention, not a
documented design decision — the future `js/anima/` slice should either
confirm it (adding real per-socket stage labels) or replace it outright.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

try:
    # Real ComfyUI context: this module lives two package levels below this
    # pack's top-level package (`nodes/anima/` -> pack root) — same
    # convention as `nodes/prompt_rules/_rules_helpers.py`'s import of
    # `src.prompt_rules.core`.
    from ...src.anima.preview_settings import format_filename  # type: ignore
except ImportError:
    # Standalone context (plain-script tests, repo root on `sys.path`).
    from src.anima.preview_settings import format_filename

STAGE_TO_SOCKET = {"base": "image_a", "mid": "image_b", "final": "image_c"}
# The order "shown" falls back to when compare is off and more than one
# socket happens to be wired: prefer the most-finished result.
_SHOWN_PRIORITY = ("final", "mid", "base")


def resolve_shown_stage(compare_settings: Dict[str, Any], wired: Dict[str, Optional[Any]]) -> Optional[str]:
    """Which stage name is "the shown image" right now? If compare is
    enabled, it's `compare.b` (the "after" pane — design doc §7's default
    `base` vs `final` makes `b` the natural "current result" pane). If
    compare is off, or `b`'s socket isn't actually wired, fall back to the
    most-finished wired stage. Returns `None` if nothing at all is wired.
    """
    if isinstance(compare_settings, dict) and compare_settings.get("enabled", True):
        b = compare_settings.get("b")
        if b in STAGE_TO_SOCKET and wired.get(STAGE_TO_SOCKET[b]) is not None:
            return b
    for stage in _SHOWN_PRIORITY:
        if wired.get(STAGE_TO_SOCKET[stage]) is not None:
            return stage
    return None


def resolve_save_stages(
    save_settings: Dict[str, Any], compare_settings: Dict[str, Any], wired: Dict[str, Optional[Any]],
) -> List[str]:
    """`save.which` -> which stage names actually get saved this run, in a
    stable `base, mid, final` order:
      - `"shown"` -> whatever `resolve_shown_stage` names, if wired.
      - `"both compared"` -> `compare.a` + `compare.b`, each only if wired.
      - `"every wired input"` -> every stage whose socket is actually wired.
    Never raises on garbage `which` — falls back to `"shown"`'s behaviour.
    """
    which = save_settings.get("which") if isinstance(save_settings, dict) else None
    order = [s for s in ("base", "mid", "final") if wired.get(STAGE_TO_SOCKET[s]) is not None]

    if which == "every wired input":
        return order
    if which == "both compared":
        wanted = set()
        if isinstance(compare_settings, dict):
            if compare_settings.get("a") in STAGE_TO_SOCKET:
                wanted.add(compare_settings["a"])
            if compare_settings.get("b") in STAGE_TO_SOCKET:
                wanted.add(compare_settings["b"])
        return [s for s in order if s in wanted]

    # Default / "shown" / anything unrecognized.
    shown = resolve_shown_stage(compare_settings, wired)
    return [shown] if shown else []


def _tensor_to_pil_images(image_tensor: Any) -> List[Any]:
    """A batched `IMAGE` tensor -> a list of PIL `Image`s, one per batch
    item — same conversion stock `SaveImage` uses."""
    import numpy as np
    from PIL import Image

    images = []
    for item in image_tensor:
        array = 255.0 * item.cpu().numpy()
        images.append(Image.fromarray(np.clip(array, 0, 255).astype("uint8")))
    return images


def _next_counter(directory: str, static_prefix: str) -> int:
    """The next free `%counter:N%` value for files already on disk sharing
    `static_prefix` (the part of the filename template before its first
    token) — a simplified version of ComfyUI's own
    `folder_paths.get_save_image_path` counter scan.
    """
    import os
    import re

    if not os.path.isdir(directory):
        return 0
    highest = -1
    pattern = re.compile(re.escape(static_prefix) + r"(\d+)")
    for name in os.listdir(directory):
        match = pattern.match(name)
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def extract_seed_from_prompt(prompt: Any) -> Any:
    """Best-effort `%seed%` token value (design doc §7a) — the Preview node
    takes no `seed` input of its own (it's terminal; §7/§8's `preview_state`
    shape has no seed field), so this scans the hidden `PROMPT` payload
    (the whole API-format graph) for an `AnimaGenerator` node's own `seed`
    INPUT VALUE.

    Only works when the Generator's `seed` is a literal widget value, not a
    wired link (ComfyUI represents a wired input as a 2-element
    `[source_node_id, output_index]` list, which carries no literal seed to
    read) — falls back to `0` in every other case (missing/garbage
    `prompt`, no Generator node found, or its seed is a link). This is a
    genuine design-doc gap, not a documented mechanism — see the build
    report.
    """
    if not isinstance(prompt, dict):
        return 0
    for node in prompt.values():
        if not isinstance(node, dict) or node.get("class_type") != "AnimaGenerator":
            continue
        node_inputs = node.get("inputs")
        if not isinstance(node_inputs, dict):
            continue
        seed = node_inputs.get("seed")
        if isinstance(seed, (list, tuple)):
            continue  # a wired link, not a literal value.
        if isinstance(seed, bool) or seed is None:
            continue
        try:
            return int(seed)
        except (TypeError, ValueError):
            continue
    return 0


def save_images(
    *,
    wired: Dict[str, Optional[Any]],
    stages_to_save: List[str],
    preview_settings: Dict[str, Any],
    seed: Any = 0,
    prompt: Any = None,
    extra_pnginfo: Any = None,
) -> List[Dict[str, Any]]:
    """Write every stage in `stages_to_save` to disk — stock-`SaveImage`-
    style PNG writing (§7a "Backend is stock SaveImage, not ComfyUI-Image-
    Saver"), with the workflow/prompt metadata embedded via the hidden
    `PROMPT`/`EXTRA_PNGINFO` this node declares (§9 divergence #3's fix) and
    filenames expanded through `format_filename`'s tokens.

    -> a ComfyUI `"ui": {"images": [...]}`-shaped list, ready to return from
    the node's `save`/`generate` method.

    VERIFY-IN-COMFYUI: exercised by reading stock `SaveImage`'s own
    save-path conventions, not against a live ComfyUI process (none
    installed in this dev environment).
    """
    import os

    import folder_paths  # ComfyUI-only; lazy.
    from PIL.PngImagePlugin import PngInfo

    save_settings = preview_settings.get("save", {}) if isinstance(preview_settings, dict) else {}
    extension = str(save_settings.get("extension") or "png").lstrip(".")
    subfolder = str(save_settings.get("path") or "AnimaFlow")
    template = str(save_settings.get("filename") or "%date:yyyy-MM-dd%_%seed%_%stage%")
    embed_workflow = bool(save_settings.get("embed_workflow", True))

    output_dir = os.path.join(folder_paths.get_output_directory(), subfolder)
    os.makedirs(output_dir, exist_ok=True)

    results: List[Dict[str, Any]] = []
    for stage in stages_to_save:
        image_tensor = wired.get(STAGE_TO_SOCKET[stage])
        if image_tensor is None:
            continue
        pil_images = _tensor_to_pil_images(image_tensor)
        width, height = (pil_images[0].width, pil_images[0].height) if pil_images else (0, 0)

        static_prefix = template.split("%", 1)[0]
        counter = _next_counter(output_dir, static_prefix)
        for batch_index, pil_image in enumerate(pil_images):
            filename_stem = format_filename(
                template, stage=stage, seed=seed, width=width, height=height, counter=counter,
            )
            if len(pil_images) > 1:
                filename_stem = f"{filename_stem}_{batch_index:03}"
            filename = f"{filename_stem}.{extension}"

            metadata = None
            if embed_workflow:
                metadata = PngInfo()
                if prompt is not None:
                    metadata.add_text("prompt", json.dumps(prompt))
                if isinstance(extra_pnginfo, dict):
                    for key, value in extra_pnginfo.items():
                        metadata.add_text(key, json.dumps(value))

            pil_image.save(os.path.join(output_dir, filename), pnginfo=metadata)
            results.append({"filename": filename, "subfolder": subfolder, "type": "output"})
            counter += 1

    return results
