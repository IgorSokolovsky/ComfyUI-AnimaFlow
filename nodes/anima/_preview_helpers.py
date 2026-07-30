"""Save + preview-image-writing logic for `AnimaPreview` (design doc §7/§7a).
Impure (PIL/numpy/folder_paths, all lazy) — kept out of `src/anima/` because
this is node-specific glue for the ONE node that saves, not pipeline
orchestration; mirrors the project's `nodes/<scope>/_*_helpers.py`
convention (`nodes/controls/_loaders_helpers.py`).

Every PURE decision this node needs (which stages are present, which get
saved vs. previewed, and — as of this task — the position->stage-label
mapping itself) lives in `src/anima/preview_settings.py` (moved there per
`.claude/CLAUDE.md`'s pure/impure rule) — this module only does the actual
file I/O, driven by that module's decisions. `build_preview_ui_images` is
the one entry point `nodes/anima/preview.py` calls; its `save_fn`/`temp_fn`
params are dependency-injected specifically so
`tests/test_anima_preview_images.py` can fake the writers and assert the
routing/shape contract without PIL, numpy, or a real ComfyUI install (per
the project's "file writing must be faked/injected, not actually performed"
test convention).

**2026-07-28 reversal**: the old "positional socket convention"
(`image_a`/`image_b`/`image_c` standing in for `base`/`mid`/`final` — this
docstring used to flag it as interim, ugly-but-usable) is GONE along with
those three sockets. `AnimaPreview` now receives one `images` list plus
`metadata_json`, and builds a real `{stage: tensor}` dict from
`preview_settings.resolve_run_stage_labels` — every function below is keyed
directly by stage name, never a socket name, because there is no socket
name left to be keyed by.
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
        SaveNowError,
        collision_suffixed_filename,
        format_filename,
        resolve_run_stage_labels,
        resolve_save_now_stage,
        resolve_save_stages,
        resolve_seed_int,
        resolve_wired_stages,
        split_preview_stages,
    )
except ImportError:
    # Standalone context (plain-script tests, repo root on `sys.path`).
    from src.anima.preview_settings import (
        SaveNowError,
        collision_suffixed_filename,
        format_filename,
        resolve_run_stage_labels,
        resolve_save_now_stage,
        resolve_save_stages,
        resolve_seed_int,
        resolve_wired_stages,
        split_preview_stages,
    )

# `resolve_save_stages`/`resolve_wired_stages`/`resolve_run_stage_labels` are
# re-exported (unused directly in THIS module -- `build_preview_ui_images`
# below only needs `split_preview_stages`) purely so `nodes/anima/preview.py`
# can pull every pure decision it needs through this module's single import
# line, matching how it already reaches
# `extract_seed_from_prompt`/`build_preview_ui_images` here rather than
# reaching into `src/anima/` directly itself.
__all__ = [
    "FilenameCollisionExhausted",
    "SaveNowError",
    "build_preview_ui_images",
    "extract_seed_from_prompt",
    "resolve_run_stage_labels",
    "resolve_save_now_stage",
    "resolve_save_stages",
    "resolve_seed_int",
    "resolve_wired_stages",
    "save_images",
    "save_now",
    "write_temp_stage_images",
    "write_without_overwriting",
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


# ---------------------------------------------------------------------------
# Never-overwrite collision handling (data-loss bug fix). The PURE decision
# ("what would candidate N look like") is `collision_suffixed_filename`
# (`src/anima/preview_settings.py`); everything below is the impure half --
# actually reserving a name against a real directory, one candidate at a
# time, with the filesystem itself arbitrating so two concurrent saves can
# never both win the same name (the bug we're fixing, wearing a race-
# condition hat).
# ---------------------------------------------------------------------------

# An arbitrary but generous bound -- no real workflow saves the same
# stage/seed/day combination this many times. Existing purely so a
# pathological directory (or a bug) can't spin forever; a bound-hit is
# reported as a readable error, never silently overwrites and never hangs.
_MAX_COLLISION_ATTEMPTS = 10_000


class FilenameCollisionExhausted(RuntimeError):
    """Raised when `_MAX_COLLISION_ATTEMPTS` candidate filenames in a row
    were all already taken. Deliberately a plain `RuntimeError` (not
    `SaveNowError`) at this layer -- `save_now` below catches it and
    re-raises as `SaveNowError` so it flows through `src/anima/api.py`'s
    existing "readable error, not a traceback" handling; the auto-save path
    (`save_images`) has no such wrapper, so it propagates as-is and ComfyUI's
    own node-execution error surface (which prints the exception message) is
    what makes it readable there.
    """


def write_without_overwriting(directory: str, filename: str, writer: Callable[[str], None]) -> str:
    """Call `writer(full_path)` at the first collision-free candidate name
    under `directory` for `filename` -- try `filename` itself first
    (`collision_suffixed_filename`'s `attempt=0`, the "no collision" case),
    then its `_000000`/`_000001`/... suffixed forms, up to
    `_MAX_COLLISION_ATTEMPTS`. Returns the actual (base, not full-path)
    filename `writer` was called with.

    **Closes the race, doesn't just avoid it**: this does NOT `os.path.
    exists` check then write -- `writer` itself is required to use
    EXCLUSIVE creation (`os.O_EXCL`, e.g. `_write_pil_image_exclusive`
    below) and raise `FileExistsError` when its candidate path is already
    taken, so the filesystem is what arbitrates a genuine collision between
    two concurrent saves, not a check this process performed a moment
    earlier and might already be stale by the time it writes.
    """
    import os

    for attempt in range(_MAX_COLLISION_ATTEMPTS):
        candidate = collision_suffixed_filename(filename, attempt)
        full_path = os.path.join(directory, candidate)
        try:
            writer(full_path)
        except FileExistsError:
            continue
        return candidate

    raise FilenameCollisionExhausted(
        f"Could not find a free filename for {filename!r} in {directory!r} "
        f"after {_MAX_COLLISION_ATTEMPTS} attempts -- giving up rather than "
        "overwriting an existing file or spinning forever."
    )


# `png`/`jpg`/`jpeg`/`webp` cover every `save.extension` choice this pack's
# frontend actually offers (`js/anima/`'s save-settings picker); anything
# else (a hand-edited workflow's custom extension) falls back to upper-casing
# the extension itself, which is what PIL's own format name is for the
# common remaining cases (`"bmp"` -> `"BMP"`, etc).
_PIL_FORMAT_BY_EXTENSION = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}


def _pil_format_for_extension(extension: str) -> str:
    """A file EXTENSION (no leading dot, e.g. `"png"`) -> the PIL `format=`
    name `Image.save` needs when handed an open file HANDLE instead of a
    path string (a handle carries no filename for PIL to sniff a format
    from, unlike `Image.save(path)`). Pure string mapping, no I/O -- kept
    here rather than in `src/anima/preview_settings.py` because it's a PIL
    implementation detail of THIS module's writers, not a decision anything
    else in the pack needs.
    """
    return _PIL_FORMAT_BY_EXTENSION.get(extension.lower(), extension.upper())


def _write_pil_image_exclusive(pil_image: Any, full_path: str, *, pil_format: str, pnginfo: Any = None) -> None:
    """Write `pil_image` to `full_path` via EXCLUSIVE creation
    (`os.O_CREAT | os.O_EXCL`) -- raises `FileExistsError` if `full_path`
    already exists, which is exactly the signal `write_without_overwriting`
    needs to try the next candidate, and is what actually closes the race
    (the filesystem itself refuses a second exclusive create of the same
    name, however close two concurrent saves land). PIL is handed the open
    handle directly (not the path string) so there is no separate
    check-then-write step in between -- `format=` is required in that case
    since a handle carries no filename to sniff a format from.
    """
    import os

    fd = os.open(full_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    try:
        with os.fdopen(fd, "wb") as fh:
            pil_image.save(fh, format=pil_format, pnginfo=pnginfo)
    except Exception:
        # The exclusive create already claimed `full_path`; if the actual
        # encode/write after that failed partway, don't leave a corrupt
        # reservation behind blocking every future save under this name.
        try:
            os.remove(full_path)
        except OSError:
            pass
        raise


def extract_seed_from_prompt(prompt: Any) -> Any:
    """Best-effort `%seed%` token value (design doc §7a) — the Preview node
    takes no `seed` input of its own (it's terminal; §7/§8's `preview_state`
    shape has no seed field), so this scans the hidden `PROMPT` payload
    (the whole API-format graph) for an `AnimaContextBridge` node's own
    `seed` INPUT VALUE.

    **2026-07-28 reversal**: `seed` moved off `AnimaGenerator` entirely onto
    `AnimaContextBridge` (this task's whole point) — so the scan target
    changed to match. This does NOT close the underlying gap this function
    always had, and arguably makes it a hair narrower: `AnimaContextBridge`
    declares `seed` with `forceInput=True` (no widget), so in practice its
    `inputs.seed` in the API-format graph is almost always a wired LINK
    (typically from a Primitive INT node this function does not trace back
    through), not a literal — meaning this still falls back to `0` in the
    common case. Only works when the Bridge's `seed` is a literal widget
    value, not a wired link (ComfyUI represents a wired input as a
    2-element `[source_node_id, output_index]` list, which carries no
    literal seed to read) — falls back to `0` in every other case
    (missing/garbage `prompt`, no Bridge node found, or its seed is a
    link). A genuine design gap, not a documented mechanism — see the build
    report.
    """
    if not isinstance(prompt, dict):
        return 0
    for node in prompt.values():
        if not isinstance(node, dict) or node.get("class_type") != "AnimaContextBridge":
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

    -> a list of `{filename, subfolder, type, stage}` entries, shaped like
    (but NOT returned under) ComfyUI's own `"ui": {"images": [...]}}`
    convention -- `build_preview_ui_images` below is what actually nests
    these under `nodes/anima/preview.py`'s real key, `anima_stages`, NOT
    `images` (see that module's own docstring for why the key itself is
    deliberately not `images`).

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
        image_tensor = wired.get(stage)
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

            pil_format = _pil_format_for_extension(extension)
            written_filename = write_without_overwriting(
                output_dir,
                filename,
                lambda full_path, _img=pil_image, _fmt=pil_format, _meta=metadata: _write_pil_image_exclusive(
                    _img, full_path, pil_format=_fmt, pnginfo=_meta,
                ),
            )
            results.append({"filename": written_filename, "subfolder": subfolder, "type": "output", "stage": stage})
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
        image_tensor = wired.get(stage)
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
    """The ONE thing `nodes/anima/preview.py`'s `preview()` calls to get the
    list it nests under its own `"ui": {"anima_stages": [...]}}` payload --
    deliberately NOT `"images"`: this node draws its own DOM preview
    (`js/anima/`'s hover wipe), and `"ui": {"images": [...]}}` is ComfyUI's
    OWN frontend trigger for drawing a SECOND, native image preview inside
    the node, which is exactly the duplicate-preview bug the rename fixes
    (see `nodes/anima/preview.py`'s `preview()` for the full rationale and
    its accepted cost). This function itself returns a plain list, agnostic
    to whatever key its caller nests it under -- the rename lives entirely
    in `preview.py`'s return statement, not here.

    Routes each stage in `preview_stages` (the always-every-wired PREVIEW
    set -- see `src/anima/preview_settings.py`'s `resolve_wired_stages`)
    through `split_preview_stages` (the PURE decision) to exactly one
    writer: `stages_to_save` -> a real output file (`save_fn`, default
    `save_images`); everything else -> an ephemeral temp file (`temp_fn`,
    default `write_temp_stage_images`). Never both for the same stage in
    the same run.

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


# ---------------------------------------------------------------------------
# "Save now" (task item 6) -- the Preview's on-demand save button, for when
# `preview.save.enabled` is off (its new default). The stage-preference
# decision (`final` -> `mid` -> `base`) is `resolve_save_now_stage`
# (`src/anima/preview_settings.py`, pure, no comfy/torch/PIL import) --
# EVERYTHING below is the impure half: locating the already-written stage
# image (a temp file if it was only previewed, an output file if that
# particular stage happened to be saved already), and copying/re-encoding it
# into the configured save path under the SAME filename template
# `save_images` uses for a normal enabled save. This runs OUTSIDE a graph
# run (no fresh PROMPT/EXTRA_PNGINFO available), so unlike `save_images` it
# cannot embed workflow metadata -- see `save_now`'s own docstring for that
# accepted gap.
# ---------------------------------------------------------------------------

def _real_output_dir() -> str:
    import folder_paths  # ComfyUI-only; lazy.

    return folder_paths.get_output_directory()


def _real_temp_dir() -> str:
    import folder_paths  # ComfyUI-only; lazy.

    return folder_paths.get_temp_directory()


def _default_probe_image_size(source_path: str):
    from PIL import Image

    with Image.open(source_path) as im:
        return im.width, im.height


def _default_write_image_copy(source_path: str, dest_path: str) -> None:
    """The default `write_fn`: re-encode `source_path` (a temp preview or an
    already-saved output, per `save_now`'s own docstring) into `dest_path`.

    **Collision-safe by EXCLUSIVE creation**, same discipline as
    `_write_pil_image_exclusive` -- `dest_path` is opened with `os.O_CREAT |
    os.O_EXCL`, so if it already exists (another save landed on the exact
    same name in the meantime -- `save_now`'s own `write_without_overwriting`
    call below assumed it was free a moment earlier, but only the filesystem
    can actually arbitrate that) this raises `FileExistsError`, which is
    exactly the signal that caller needs to try the next `_NNNNNN`-suffixed
    candidate instead of clobbering the file that's already there.
    """
    import os

    from PIL import Image

    with Image.open(source_path) as im:
        im.load()
        if dest_path.lower().endswith((".jpg", ".jpeg")) and im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        pil_format = _pil_format_for_extension(os.path.splitext(dest_path)[1].lstrip("."))
        fd = os.open(dest_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            with os.fdopen(fd, "wb") as fh:
                im.save(fh, format=pil_format)
        except Exception:
            try:
                os.remove(dest_path)
            except OSError:
                pass
            raise


def save_now(
    *,
    stage_entries: Dict[str, Dict[str, Any]],
    preview_settings: Dict[str, Any],
    seed: Any = 0,
    output_dir_fn: Optional[Callable[[], str]] = None,
    temp_dir_fn: Optional[Callable[[], str]] = None,
    exists_fn: Optional[Callable[[str], bool]] = None,
    probe_fn: Optional[Callable[[str], Any]] = None,
    write_fn: Optional[Callable[[str, str], None]] = None,
) -> Dict[str, Any]:
    """`src/anima/api.py`'s `/wtn/anima/preview/save_now` handler calls this
    directly. `stage_entries` is `js/anima/interaction.mjs`'s own
    `node._anPreviewImages` shape, sent verbatim by the frontend: `{stage:
    {filename, subfolder, type, ...}}` for every stage the last run's
    `anima_stages` payload reported (whichever the wipe currently has,
    whether or not any of them were actually saved that run).

    Picks the winning stage via `resolve_save_now_stage` (pure, `final` ->
    `mid` -> `base`); raises `SaveNowError` -- a readable message, no bare
    traceback -- if `stage_entries` is empty/has nothing usable, if that
    stage's own entry carries no filename, or if the source file named
    there is no longer on disk (a temp file cleaned up since the last run,
    say). The winning stage's own already-written file (temp or output,
    per its own `type`) is then copied through the SAME `format_filename`
    template + `save.extension`/`save.path` a normal enabled save uses, so
    the result is indistinguishable from "this stage had been saved all
    along."

    `output_dir_fn`/`temp_dir_fn`/`exists_fn`/`probe_fn`/`write_fn` are all
    dependency-injected (this module's own "fake the writer, don't perform
    it" test convention, matching `build_preview_ui_images`'s `save_fn`/
    `temp_fn`) so a test can drive this with real temp directories but fake
    image probing/writing, never needing PIL or a live `folder_paths`.

    **`seed` fixes the `%seed%` -> `0` bug** (`docs/TODO.md`'s last Now item):
    `src/anima/api.py`'s route now forwards whatever the frontend posted
    (`node._anSeed`, stashed from `nodes/anima/preview.py`'s own `anima_seed`
    `ui` payload) straight through, UNCONVERTED -- this is attacker-shaped
    data from the browser's point of view (absent, `None`, `""`, a
    non-numeric string, a negative number, a float, a 40-digit number, a
    dict), so it is converted to a real `int` in exactly ONE place, HERE, at
    the `format_filename` call site below, via `resolve_seed_int` (the same
    pure "convert once at the boundary" function `pipeline.py` already uses
    for the settings-tree seed, reused rather than re-invented) -- never
    raises on any of the hostile shapes above, degrading to `0` for anything
    it can't make sense of. `format_filename` itself is never handed the raw
    posted value.

    **Cannot embed workflow metadata** (unlike `save_images`): this runs
    from a button click, outside a graph run, so there is no fresh
    `PROMPT`/`EXTRA_PNGINFO` to write into the PNG the way an enabled save
    does -- `save.embed_workflow` is silently not honoured here. A
    documented gap, not a silent one; see the build report.
    """
    available = stage_entries if isinstance(stage_entries, dict) else {}
    stage = resolve_save_now_stage(list(available.keys()))
    if stage is None:
        raise SaveNowError("Nothing to save yet -- run the Generator first, then click Save now again.")

    entry = available.get(stage) or {}
    filename = entry.get("filename") if isinstance(entry, dict) else None
    if not filename:
        raise SaveNowError(f"The '{stage}' stage has no file recorded to save.")
    subfolder = str(entry.get("subfolder") or "")
    kind = entry.get("type") or "temp"

    import os

    get_output_dir = output_dir_fn if output_dir_fn is not None else _real_output_dir
    get_temp_dir = temp_dir_fn if temp_dir_fn is not None else _real_temp_dir
    exists = exists_fn if exists_fn is not None else os.path.isfile
    probe = probe_fn if probe_fn is not None else _default_probe_image_size
    write = write_fn if write_fn is not None else _default_write_image_copy

    source_root = get_output_dir() if kind == "output" else get_temp_dir()
    source_path = os.path.join(source_root, subfolder, filename)
    if not exists(source_path):
        raise SaveNowError(f"The '{stage}' stage's file is no longer on disk -- generate again, then click Save now.")

    width, height = probe(source_path)

    save_settings = preview_settings.get("save", {}) if isinstance(preview_settings, dict) else {}
    extension = str(save_settings.get("extension") or "png").lstrip(".")
    out_subfolder = str(save_settings.get("path") or "AnimaFlow")
    template = str(save_settings.get("filename") or "%date:yyyy-MM-dd%_%seed%_%stage%")

    output_dir = os.path.join(get_output_dir(), out_subfolder)
    os.makedirs(output_dir, exist_ok=True)
    static_prefix = template.split("%", 1)[0]
    counter = _next_counter(output_dir, static_prefix)
    # `resolve_seed_int` -- the ONE conversion point (this function's own doc
    # comment above): the posted `seed` is hostile-shaped data (a decimal
    # STRING on the happy path, per design doc §8's "never a JSON number"
    # rule, but possibly `None`/garbage/a dict from a hand-crafted request),
    # and this never raises regardless -- anything it can't parse degrades to
    # `0`, matching `src/anima/api.py`'s own documented fallback.
    filename_stem = format_filename(
        template, stage=stage, seed=resolve_seed_int(seed), width=width, height=height, counter=counter,
    )
    out_filename = f"{filename_stem}.{extension}"
    # Never-overwrite (same fix as `save_images`): try `out_filename` itself
    # first, then its `_000000`/`_000001`/... suffixed forms, until one
    # writes cleanly. `write` (the default `_default_write_image_copy`, or
    # an injected `write_fn`) is responsible for the actual exclusivity --
    # this loop only supplies candidates and reacts to `FileExistsError`.
    try:
        out_filename = write_without_overwriting(
            output_dir, out_filename, lambda full_path: write(source_path, full_path),
        )
    except FilenameCollisionExhausted as exc:
        # Same "readable error, not a bare traceback" contract as every
        # other `SaveNowError` this function raises -- `src/anima/api.py`'s
        # `save_now_impl` already catches exactly this class.
        raise SaveNowError(str(exc)) from exc

    return {"filename": out_filename, "subfolder": out_subfolder, "type": "output", "stage": stage}
