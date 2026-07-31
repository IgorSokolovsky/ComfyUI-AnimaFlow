"""Deletes an installed model + its sidecars -- "Remove an installed model"
(docs/TODO.md, owner decisions taken 2026-07-30): **all kinds**, not just
`loras`; the frontend's type-to-confirm dialog (naming the file, its size
and its folder) is what makes a mis-click survivable, but the security
story is entirely server-side, here.

🔒 THIS IS THE FIRST CODE IN THIS PACK THAT DESTROYS USER DATA -- `os.remove`,
no undo. A delete route turns a client-supplied `(kind, name)` pair into a
filesystem write of the most dangerous kind, so the path guard is the whole
feature:

  - `kind` goes through the SAME whitelist every other route in this
    package already enforces (`kinds.folder_for_kind`, via
    `local.resolve_model_path`) -- an unwhitelisted kind never reaches
    `folder_paths` at all.
  - `name` is resolved through `local.resolve_model_path`, the SAME
    realpath-then-containment guard (`local._is_path_under`) every other
    client-supplied model path in this package already uses -- a traversal
    attempt, an absolute path, a Windows-separator name, a directory (which
    never satisfies `os.path.isfile`), or a symlink whose REAL target
    escapes the kind's configured directories are all refused there, before
    this module ever sees a resolved path.
  - The sidecar (`sidecar.sidecar_path`) and preview (`local.
    find_preview_path`) paths are both DERIVED from the already-resolved
    model path -- but this module does not trust that derivation blindly:
    each is independently re-verified against the SAME containment check
    (`_remove_if_present_and_contained` below) before it is ever removed.
    Belt-and-suspenders, not a formality -- a delete route is exactly the
    place "should be unreachable given the guard upstream" isn't good
    enough to rely on alone.

Resolve first, verify containment second, delete third -- in that order,
every time, for the model file itself and for each sidecar.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List

from . import local
from . import logs as logs_mod
from . import sidecar as sidecar_mod
from .kinds import folder_for_kind

# `local._is_path_under`/`local._model_dirs` are accessed via the qualified
# module (never `from .local import _is_path_under`) -- the SAME convention
# `download.py` already uses for these exact two "private" helpers, so
# there's one way this package reaches into `local`'s internals, not two.

# One logger for the whole feature (`logs.py`'s own docstring).
_logger = logging.getLogger(logs_mod.LOGGER_NAME)


def _not_found_result() -> Dict[str, Any]:
    return {
        "reason": "not_found",
        "message": "That model file could not be found locally.",
        "removed": [],
    }


def _remove_if_present_and_contained(path: Any, roots: List[str]) -> bool:
    """Removes `path` and reports whether it was actually deleted just now.

    `False` (never an error, never raised) for: `path` being `None` or not
    an existing file (nothing to delete -- a missing sidecar/preview is not
    a failure, the model is what matters), a path that fails the SAME
    realpath-then-containment re-verification `resolve_model_path` already
    ran for the model file itself, or a genuine `os.remove` failure
    (permissions, a read-only filesystem, ...).

    `True` only when `path` existed, passed containment, and is now gone.
    """
    if not isinstance(path, str) or not path or not os.path.isfile(path):
        return False
    if not local._is_path_under(path, *roots):
        return False
    try:
        os.remove(path)
        return True
    except OSError:
        return False


def delete_model(kind: object, name: Any) -> Dict[str, Any]:
    """Deletes the model `(kind, name)` resolves to, plus its `.civitai.info`
    sidecar and local preview image if either exists -- ALWAYS returns a
    dict carrying a `reason`, never raises.

      - `not_found`    -- `(kind, name)` doesn't resolve to a real, guarded
        local file at all: an unwhitelisted `kind` (via `folder_for_kind`,
        never touches `folder_paths`), a traversal/absolute/Windows-
        separator `name`, a directory (never satisfies `os.path.isfile`),
        or a symlink whose real target sits outside every configured
        directory for this kind -- every one of these is `local.
        resolve_model_path`'s own existing guard, re-verified here a second
        time (`roots`/`_is_path_under`) before the actual `os.remove`.
      - `write_error`  -- the model file resolved and passed every guard,
        but the actual deletion failed (permissions, a read-only
        filesystem, a race where something else removed it between the
        check and the call, ...). Nothing is reported as removed; the
        sidecar/preview are never touched on this path, since deleting
        metadata for a model that is still actually on disk would be
        actively misleading.
      - `ok`           -- the model file is gone. `removed` names exactly
        which of `"model"` / `"sidecar"` / `"preview"` were ACTUALLY present
        and deleted just now -- a sidecar or preview that never existed is
        simply absent from the list, not an error (task: "a missing sidecar
        is not an error -- the model is what matters").

    The model file is deleted FIRST, sidecars second: if the model itself
    can't be removed, nothing else is touched, so a failed delete never
    leaves a model on disk with its metadata already gone.
    """
    model_path = local.resolve_model_path(kind, name)
    if model_path is None:
        logs_mod.log_summary(
            _logger, logs_mod.format_delete_summary, kind=kind, name=name, reason="not_found", removed=[],
        )
        return _not_found_result()

    folder = folder_for_kind(kind)
    roots = local._model_dirs(folder)
    # Belt-and-suspenders re-verification (this module's own top docstring):
    # `resolve_model_path` already guaranteed this, but a delete route is
    # exactly the place that guarantee is worth re-checking rather than
    # trusting by inspection alone.
    if not roots or not local._is_path_under(model_path, *roots) or not os.path.isfile(model_path):
        logs_mod.log_summary(
            _logger, logs_mod.format_delete_summary, kind=kind, name=name, reason="not_found", removed=[],
        )
        return _not_found_result()

    try:
        os.remove(model_path)
    except OSError as exc:
        logs_mod.log_summary(
            _logger, logs_mod.format_delete_summary, kind=kind, name=name, reason="write_error", removed=[],
        )
        return {
            "reason": "write_error",
            "message": f"Could not delete the model file: {exc}",
            "removed": [],
        }

    removed: List[str] = ["model"]

    sidecar_path = sidecar_mod.sidecar_path(model_path)
    if _remove_if_present_and_contained(sidecar_path, roots):
        removed.append("sidecar")

    # `find_preview_path` only ever inspects other files sitting next to
    # `model_path` on disk -- it never requires the model file itself to
    # still exist, so calling it after the model's own removal is fine.
    preview_path = local.find_preview_path(model_path)
    if _remove_if_present_and_contained(preview_path, roots):
        removed.append("preview")

    logs_mod.log_summary(
        _logger, logs_mod.format_delete_summary, kind=kind, name=name, reason="ok", removed=removed,
    )
    return {"reason": "ok", "message": "", "removed": removed}


__all__ = ("delete_model",)
