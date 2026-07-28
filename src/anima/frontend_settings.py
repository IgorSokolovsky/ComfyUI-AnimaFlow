"""Reads a value the user picked in ComfyUI's own Settings dialog
(`js/shared/settings.mjs`'s "AnimaFlow" section) from Python, WITHOUT a
bespoke API route — this task's own explicit mechanism: ComfyUI already
persists every setting a user changes to a JSON file on disk
(`folder_paths.get_user_directory()/default/comfy.settings.json`), keyed by
the setting's own id string. Reading that file directly means a value set in
the browser reaches a plain Python function call, survives a server restart,
and still resolves (to its documented default) for an API-only run with no
browser ever attached at all.

**Degrades to the caller's own default on ANY problem** — file missing
(nothing has ever been saved, or this is a fresh install), unreadable
(permissions, or the path is actually a directory), malformed JSON, the
wrong top-level shape (not an object), or the key simply absent — never
raises. A log line (this is exactly what `src/anima/logs.py`'s own
`CONSOLE_LOGGING_SETTING_ID` is read through, via `get_setting`) must never
itself become a reason a run fails.

**Cached by the file's own mtime** (`_load_cached` below) — `pipeline.py`
calls `get_setting` at least once per run, potentially several times if it
resolves the level fresh at each of many log call sites; re-reading and
re-`json.load`ing the file every single time would be silly for a value that
only ever changes when the user actually edits it in the Settings dialog.
`os.path.getmtime` is one cheap `stat()` call; the JSON is only re-parsed
when that number has actually moved since the last read.

**Testable without ComfyUI installed** (this module's own contribution to
`.claude/CLAUDE.md`'s pure/impure rule, extended slightly): the ComfyUI-
dependent half (locating the file at all, via `folder_paths`) is isolated in
`_settings_file_path`, a small function that is ITSELF never called when a
caller passes `path=` explicitly — `get_setting(id, default, path=...)` is
the seam every test in this module's own suite uses, so the file-read/
mtime-cache/JSON-parse logic is fully exercised with a real temp file and no
live ComfyUI process anywhere.
"""
from __future__ import annotations

import json
import os
from typing import Any, Optional

# The one file every Settings-dialog value ends up in, relative to
# `folder_paths.get_user_directory()` — `default` is ComfyUI's own
# always-present user profile; a multi-user ComfyUI install still keeps its
# own `comfy.settings.json` per profile the same way, but this pack (like
# most single-machine custom-node installs) only ever reads the default one.
_SETTINGS_SUBPATH = os.path.join("default", "comfy.settings.json")

# mtime-keyed cache -- see this module's own docstring ("Cached by the
# file's own mtime"). Keyed by the resolved path so a caller that passes a
# DIFFERENT `path=` (every test in this module's own suite) never sees a
# stale value left over from a previous, different path.
_cache_path: Optional[str] = None
_cache_mtime: Optional[float] = None
_cache_data: dict = {}


def _settings_file_path() -> Optional[str]:
    """The real, on-disk `comfy.settings.json` path — lazy `folder_paths`
    import (ComfyUI's own; never at module scope, matching `src/anima/
    soft_imports.py`'s lazy-import convention), returning `None` (never
    raising) if ComfyUI isn't installed/importable, or `get_user_directory`
    itself fails for any reason. Only ever called when `get_setting` isn't
    given an explicit `path=` (i.e. every real, non-test call site).
    """
    try:
        import folder_paths  # ComfyUI's own; lazy -- see module docstring.
    except Exception:
        return None
    try:
        user_dir = folder_paths.get_user_directory()
    except Exception:
        return None
    if not user_dir:
        return None
    return os.path.join(user_dir, _SETTINGS_SUBPATH)


def _read_json_object(path: str) -> dict:
    """The raw file's parsed JSON, as a `dict` — `{}` for ANY failure at all
    (missing, a directory rather than a file, permission-denied, malformed
    JSON, or valid JSON that isn't an object at its top level) rather than
    raising. This is the one place this module actually touches the
    filesystem/`json` module."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _load_cached(path: Optional[str]) -> dict:
    """`path`'s parsed content, re-reading ONLY when the file's own mtime has
    moved since the last read for this exact path (this module's own
    docstring, "Cached by the file's own mtime"). `None`/an unreadable-for-
    `stat` path degrades to `{}` without disturbing whatever's already
    cached for some OTHER path."""
    global _cache_path, _cache_mtime, _cache_data
    if not path:
        return {}
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}  # missing/unreadable right now -- degrade to {}, this call only
    if path == _cache_path and mtime == _cache_mtime:
        return _cache_data
    data = _read_json_object(path)
    _cache_path = path
    _cache_mtime = mtime
    _cache_data = data
    return data


def invalidate_cache() -> None:
    """Test-only: force the next `get_setting` call to re-read from disk
    regardless of mtime. No real (non-test) code path in this pack ever
    calls this."""
    global _cache_path, _cache_mtime, _cache_data
    _cache_path = None
    _cache_mtime = None
    _cache_data = {}


def get_setting(setting_id: str, default: Any = None, *, path: Optional[str] = None) -> Any:
    """`setting_id`'s current value from ComfyUI's own persisted Settings-
    dialog blob, or `default` for anything at all that goes wrong along the
    way (this module's own docstring: missing file, unreadable, malformed,
    wrong shape, the key simply absent, or ComfyUI/`folder_paths` not
    importable) — never raises.

    `path` (keyword-only, optional) overrides the real, `folder_paths`-
    resolved location — the ONE seam this module's own test suite uses to
    exercise the file-read/cache/parse logic against a real temp file with
    no live ComfyUI process at all; every real call site (`pipeline.py`,
    `nodes/anima/preview.py`) omits it and gets the real file.
    """
    resolved_path = path if path is not None else _settings_file_path()
    data = _load_cached(resolved_path)
    try:
        if setting_id in data:
            return data[setting_id]
    except Exception:
        return default
    return default


__all__ = (
    "get_setting",
    "invalidate_cache",
)
