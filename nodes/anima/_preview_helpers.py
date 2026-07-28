"""Save + preview-image-writing logic for `AnimaPreview` (design doc §7/§7a).
Impure (PIL/numpy/folder_paths, all lazy) — kept out of `src/anima/` because
this is node-specific glue for the ONE node that saves, not pipeline
orchestration; mirrors the project's `nodes/<scope>/_*_helpers.py`
convention (`nodes/controls/_loaders_helpers.py`).

Every PURE decision this node needs (which stages are wired, which map to
which socket, which get saved vs. previewed) now lives in
`src/anima/preview_settings.py` (moved there per `.claude/CLAUDE.md`'s
pure/impure rule) — this module only does the actual file I/O, driven by
that module's decisions. `build_preview_ui_images` is the one entry point
`nodes/anima/preview.py` calls; its `save_fn`/`temp_fn` params are
dependency-injected specifically so `tests/test_anima_preview_images.py`
can fake the writers and assert the routing/shape contract without PIL,
numpy, or a real ComfyUI install (per the project's "file writing must be
faked/injected, not actually performed" test convention).

INTERIM SOCKET/STAGE CONVENTION (flagged in the build report — there is no
`js/anima/` yet to draw the per-pane "which output is this side" labels
design doc §7 describes, so Python has no OTHER way to know which stage
`image_a`/`image_b`/`image_c` each represent): this module assumes the
Generator's three outputs are wired positionally --
`image_base -> image_a`, `image_mid -> image_b`, `image -> image_c` -- and
`preview_settings.compare.a`/`.b` name a STAGE (`"base"`/`"mid"`/`"final"`),
resolved through `STAGE_TO_SOCKET` (now in `preview_settings.py`) to find the
actual wired tensor. This is a reasonable "usable if ugly" interim wiring
convention, not a documented design decision — the future `js/anima/` slice
should either confirm it (adding real per-socket stage labels) or replace it
outright.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

try:
    # Real ComfyUI context: this module lives two package levels below this
    # pack's top-level package (`nodes/anima/` -> pack root) — same
    # convention as `nodes/prompt_rules/_rules_helpers.py`'s import of
    # `src.prompt_rules.core`.
    from ...src.anima.preview_settings import (  # type: ignore
        STAGE_TO_SOCKET,
        format_filename,
        resolve_save_stages,
        resolve_wired_stages,
        split_preview_stages,
    )
except ImportError:
    # Standalone context (plain-script tests, repo root on `sys.path`).
    from src.anima.preview_settings import (
        STAGE_TO_SOCKET,
        format_filename,
        resolve_save_stages,
        resolve_wired_stages,
        split_preview_stages,
    )

# `resolve_save_stages`/`resolve_wired_stages` are re-exported (unused
# directly in THIS module -- `build_preview_ui_images` below only needs
# `split_preview_stages`) purely so `nodes/anima/preview.py` can pull every
# pure decision it needs through this module's single import line, matching
# how it already reaches `extract_seed_from_prompt`/`build_preview_ui_images`
# here rather than reaching into `src/anima/` directly itself.
__all__ = [
    "STAGE_TO_SOCKET",
    "build_preview_ui_images",
    "extract_seed_from_prompt",
    "resolve_save_stages",
    "resolve_wired_stages",
    "save_images",
    "write_temp_stage_images",
]


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
            results.append({"filename": filename, "subfolder": subfolder, "type": "output", "stage": stage})
            counter += 1

    return results


def write_temp_stage_images(wired: Dict[str, Optional[Any]], stages: List[str]) -> List[Dict[str, Any]]:
    """Write each of `stages`' wired `IMAGE` tensors into ComfyUI's own TEMP
    directory (never the user's output tree) -- exactly what stock
    `nodes.PreviewImage` does for a preview-only render: `folder_paths.
    get_temp_directory()` + `folder_paths.get_save_image_path` (the SAME
    counter/subfolder mechanism `SaveImage` itself uses, just pointed at the
    temp root), a random per-call prefix suffix so two previews running
    concurrently never fight over one counter. Ported from `ComfyUI-
    EasyUseAnima`'s `easyuse_anima/aio/preview.py`'s
    `_save_aio_temp_preview_image` (MIT © n0va39 -- see
    `THIRD_PARTY_NOTICES.md`), simplified to plain PNG since this node has no
    equivalent to that pack's WebP preview-cache format.

    This is what runs for a stage that's wired but NOT in this run's saved
    set -- either because `save.enabled` is false (every wired stage lands
    here) or because `save.which` scoped saving to a DIFFERENT stage while
    this one is still needed for the compare wipe (design doc gap noted in
    the build report: §7a never anticipated "compare two stages, only one
    gets saved" needing an ephemeral copy of the other).

    VERIFY-IN-COMFYUI: exercised by reading stock `PreviewImage`'s own
    save-path conventions, not against a live ComfyUI process (none
    installed in this dev environment).
    """
    import os
    import random

    import folder_paths  # ComfyUI-only; lazy.

    if not stages:
        return []

    temp_dir = folder_paths.get_temp_directory()
    results: List[Dict[str, Any]] = []
    for stage in stages:
        image_tensor = wired.get(STAGE_TO_SOCKET[stage])
        if image_tensor is None:
            continue
        pil_images = _tensor_to_pil_images(image_tensor)
        width, height = (pil_images[0].width, pil_images[0].height) if pil_images else (0, 0)

        suffix = "".join(random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(5))
        prefix = f"AnimaPreview_{stage}_temp_{suffix}"
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            prefix, temp_dir, width, height,
        )
        for pil_image in pil_images:
            file = f"{filename}_{counter:05}_.png"
            pil_image.save(os.path.join(full_output_folder, file), compress_level=1)
            results.append({"filename": file, "subfolder": subfolder, "type": "temp", "stage": stage})
            counter += 1

    return results


def build_preview_ui_images(
    *,
    wired: Dict[str, Optional[Any]],
    preview_stages: List[str],
    stages_to_save: List[str],
    preview_settings: Dict[str, Any],
    seed: Any = 0,
    prompt: Any = None,
    extra_pnginfo: Any = None,
    save_fn: Optional[Callable[..., List[Dict[str, Any]]]] = None,
    temp_fn: Optional[Callable[..., List[Dict[str, Any]]]] = None,
) -> List[Dict[str, Any]]:
    """The ONE thing `nodes/anima/preview.py`'s `preview()` calls to get its
    `"ui": {"images": [...]}}` payload. Routes each stage in `preview_stages`
    (the always-every-wired PREVIEW set -- see `src/anima/preview_settings.
    py`'s `resolve_wired_stages`) through `split_preview_stages` (the PURE
    decision) to exactly one writer: `stages_to_save` -> a real output file
    (`save_fn`, default `save_images`); everything else -> an ephemeral temp
    file (`temp_fn`, default `write_temp_stage_images`). Never both for the
    same stage in the same run.

    `save_fn`/`temp_fn` are dependency-injected (not just module-level calls)
    so `tests/test_anima_preview_images.py` can fake them (either by passing
    them here directly, or by monkeypatching `save_images`/
    `write_temp_stage_images` at the module level and calling through
    `AnimaPreview.preview()` end-to-end) and assert the routing/shape
    contract -- which stage got which `type`, that every entry carries its
    `stage`, that an unsaved-but-wired stage still gets exactly one entry --
    without PIL, numpy, or `folder_paths` needing to exist.
    """
    save_fn = save_fn if save_fn is not None else save_images
    temp_fn = temp_fn if temp_fn is not None else write_temp_stage_images

    routing = split_preview_stages(preview_stages, stages_to_save)

    saved_entries = (
        save_fn(
            wired=wired, stages_to_save=routing["output"], preview_settings=preview_settings,
            seed=seed, prompt=prompt, extra_pnginfo=extra_pnginfo,
        )
        if routing["output"]
        else []
    )
    temp_entries = temp_fn(wired, routing["temp"]) if routing["temp"] else []

    # Recombine in `preview_stages`' own order -- deterministic, and keeps a
    # stage's entries adjacent when there's more than one (a batch > 1).
    by_stage: Dict[str, List[Dict[str, Any]]] = {}
    for entry in [*saved_entries, *temp_entries]:
        by_stage.setdefault(entry["stage"], []).append(entry)

    ordered: List[Dict[str, Any]] = []
    for stage in preview_stages:
        ordered.extend(by_stage.get(stage, []))
    return ordered
