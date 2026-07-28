"""Pure pre-flight check for required model FILES the Detailer/Upscale stages
need, but that ComfyUI has no built-in way to validate before sampling
starts. Live bug this exists to fix: enabling Detailer without the exact
upstream-default SAM3 checkpoint installed raised a bare `FileNotFoundError`
seven frames deep out of `CheckpointLoaderSimple().load_checkpoint(...)`
(`pipeline.py`'s `run_detailer`) — `UpscaleModelLoader.load_model` throws the
identical class of error for the Upscale stage's default. Same problem
`context.ContextFieldMissing`/`resources.ResourceError` already solve for
their own fields: a readable message beats an exception mid-sample.

No comfy/torch import anywhere in this file — `pipeline.py` looks up the
installed-file lists lazily (`folder_paths.get_filename_list`, a ComfyUI
import) and passes them in; this module only ever compares plain strings, so
it stays importable and testable with no ComfyUI installed (the pure/impure
rule, `.claude/CLAUDE.md`: "every decision it acts on is made first by a
pure function it calls").
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

# The exact upstream defaults `pipeline.py`'s `run_detailer`/`run_upscale`
# fall back to when a settings tree doesn't carry its own value — repeated
# here (rather than imported from `pipeline.py`, which this module must
# never import, being pure) so a missing/garbage settings value is checked
# against the SAME string pipeline.py would actually try to load.
DEFAULT_SAM3_CHECKPOINT = "sam3.1_multiplex_fp16.safetensors"
DEFAULT_UPSCALE_MODEL = "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors"


class ModelFileMissing(ValueError):
    """A model FILE a live stage needs isn't in ComfyUI's own folder listing
    for that model type. Always carries a readable message naming the exact
    filename, which folder it belongs in, and which section of the panel
    picks it — same "the error text matters" contract as
    `context.ContextFieldMissing`/`resources.ResourceError` (a readable
    message beats a `FileNotFoundError` seven frames deep mid-sample).
    """


def _sam3_checkpoint_name(detailer_settings: Dict[str, Any]) -> str:
    sam3_settings = detailer_settings.get("sam3") if isinstance(detailer_settings, dict) else None
    sam3_settings = sam3_settings if isinstance(sam3_settings, dict) else {}
    return str(sam3_settings.get("checkpoint") or DEFAULT_SAM3_CHECKPOINT)


def _upscale_model_name(upscale_settings: Dict[str, Any]) -> str:
    usdu_settings = upscale_settings.get("usdu") if isinstance(upscale_settings, dict) else None
    usdu_settings = usdu_settings if isinstance(usdu_settings, dict) else {}
    return str(usdu_settings.get("upscale_model_name") or DEFAULT_UPSCALE_MODEL)


def find_missing_model_files(
    *,
    detailer_settings: Dict[str, Any],
    detailer_live: bool,
    upscale_settings: Dict[str, Any],
    upscale_live: bool,
    checkpoint_files: Optional[List[str]],
    upscale_model_files: Optional[List[str]],
) -> List[Dict[str, str]]:
    """Which required model files are missing, for the stages that are
    ACTUALLY going to run this pass. `detailer_live`/`upscale_live` are the
    same flags `pipeline.run_generator` already computes (via
    `stages.detailer_is_live` / `upscale_settings.get("enabled") and
    have_usdu`) — a stage that's off or inert never gets checked, so a
    disabled stage's hardcoded upstream default is never flagged just
    because the user hasn't installed it (never fail a run for a model a
    disabled stage would have used).

    `checkpoint_files`/`upscale_model_files` are ComfyUI's own installed-file
    listing for the `checkpoints`/`upscale_models` folders
    (`folder_paths.get_filename_list(...)`), or `None` if the caller
    couldn't obtain one at all (no `folder_paths` module, or the lookup call
    itself raised). `None` SKIPS that stage's check entirely rather than
    guessing — an unobtainable list must never block a run. An empty list
    (`[]`) is a real, successfully-obtained answer ("nothing is installed in
    that folder") and DOES fail like any other missing file.

    Returns a list of `{"filename", "folder", "section"}` dicts, one per
    missing file, in stage order (Detailer before Upscale) — empty when
    nothing is missing, including the "live but list unobtainable" case.
    """
    missing: List[Dict[str, str]] = []

    if detailer_live and checkpoint_files is not None:
        checkpoint_name = _sam3_checkpoint_name(detailer_settings)
        if checkpoint_name not in checkpoint_files:
            missing.append({"filename": checkpoint_name, "folder": "checkpoints", "section": "Detailer"})

    if upscale_live and upscale_model_files is not None:
        upscale_model_name = _upscale_model_name(upscale_settings)
        if upscale_model_name not in upscale_model_files:
            missing.append({"filename": upscale_model_name, "folder": "upscale_models", "section": "Upscale"})

    return missing


def raise_if_missing(missing: List[Dict[str, str]]) -> None:
    """Raise a readable `ModelFileMissing` for the FIRST entry in `missing`
    (`find_missing_model_files`'s return), naming the filename, the folder it
    must go in, which section needs it, and that the value is editable there
    now (both the SAM3 checkpoint and the upscale model picker are real
    picker rows in their section, not hardcoded — this task's whole point).
    A no-op on an empty list.
    """
    if not missing:
        return
    first = missing[0]
    raise ModelFileMissing(
        f"AnimaGenerator's {first['section']} stage needs the model file "
        f"'{first['filename']}' in ComfyUI's '{first['folder']}' folder, but "
        f"it isn't installed there. Install the file, or pick a different "
        f"one in the {first['section']} section — that picker is editable "
        f"right there now."
    )


__all__ = (
    "DEFAULT_SAM3_CHECKPOINT", "DEFAULT_UPSCALE_MODEL",
    "ModelFileMissing", "find_missing_model_files", "raise_if_missing",
)
