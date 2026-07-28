"""Plain-script tests for `src/anima/frontend_settings.py` (reads a value the
user picked in ComfyUI's own Settings dialog from Python, via the persisted
`comfy.settings.json` file — no bespoke API route). Covers: a present value,
a missing file, malformed JSON, an unreadable path, the mtime cache NOT
re-reading an unchanged file, and the no-`folder_paths`-installed case (this
dev environment has no live ComfyUI, so that's the REAL behaviour here, not
a simulated one).

Run directly: `python tests/test_anima_frontend_settings.py` (no pytest, per
project convention).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import frontend_settings as fs_mod

_CONSOLE_LOGGING_ID = "AnimaFlow.General.ConsoleLogging"


def _write(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh)


# ---------------------------------------------------------------------------
# Value present.
# ---------------------------------------------------------------------------


def test_get_setting_returns_the_persisted_value_when_present():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "comfy.settings.json")
        _write(path, {_CONSOLE_LOGGING_ID: "debug", "Some.Other.Setting": 42})
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "debug"
        assert fs_mod.get_setting("Some.Other.Setting", 0, path=path) == 42


def test_get_setting_returns_the_default_when_the_key_is_absent():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "comfy.settings.json")
        _write(path, {"Unrelated.Key": "x"})
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "off"


# ---------------------------------------------------------------------------
# File missing / malformed / unreadable -- every failure degrades to the
# caller's own default, never raises.
# ---------------------------------------------------------------------------


def test_get_setting_returns_the_default_when_the_file_is_missing():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "does-not-exist.json")
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "off"
        assert fs_mod.get_setting("anything", "fallback", path=path) == "fallback"


def test_get_setting_returns_the_default_when_the_json_is_malformed():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "comfy.settings.json")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("{not valid json at all")
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "off"


def test_get_setting_returns_the_default_when_the_json_top_level_is_not_an_object():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "comfy.settings.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(["not", "an", "object"], fh)
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "off"


def test_get_setting_returns_the_default_when_the_path_is_unreadable():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        # A DIRECTORY at the exact path -- `open()` raises (IsADirectoryError
        # on POSIX), a portable stand-in for "permission denied" that doesn't
        # depend on chmod actually being honoured (e.g. when run as root).
        path = os.path.join(tmp, "comfy.settings.json")
        os.makedirs(path)
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "off"


def test_get_setting_never_raises_for_any_of_the_above():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        missing = os.path.join(tmp, "missing.json")
        malformed = os.path.join(tmp, "bad.json")
        with open(malformed, "w", encoding="utf-8") as fh:
            fh.write("{{{")
        for p in (missing, malformed, None):
            fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=p)  # must not raise


# ---------------------------------------------------------------------------
# mtime cache -- re-reads only when the file's own mtime has moved.
# ---------------------------------------------------------------------------


def test_get_setting_does_not_re_read_the_file_when_mtime_is_unchanged():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "comfy.settings.json")
        _write(path, {_CONSOLE_LOGGING_ID: "summary"})
        original_mtime = os.path.getmtime(path)

        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "summary"

        # Rewrite the CONTENT but pin the mtime back to its original value --
        # proves the cache is keyed on mtime, not merely "read once ever".
        _write(path, {_CONSOLE_LOGGING_ID: "debug"})
        os.utime(path, (original_mtime, original_mtime))
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "summary", (
            "an unchanged mtime must serve the CACHED value, not re-parse the file"
        )

        # Now actually bump the mtime forward -- the new content must be seen.
        os.utime(path, (original_mtime + 5, original_mtime + 5))
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "debug"


def test_invalidate_cache_forces_a_re_read_regardless_of_mtime():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "comfy.settings.json")
        _write(path, {_CONSOLE_LOGGING_ID: "summary"})
        original_mtime = os.path.getmtime(path)
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "summary"

        _write(path, {_CONSOLE_LOGGING_ID: "debug"})
        os.utime(path, (original_mtime, original_mtime))  # same mtime, different content
        fs_mod.invalidate_cache()
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off", path=path) == "debug"


def test_cache_is_keyed_per_path_not_globally_pinned_to_the_first_path_seen():
    fs_mod.invalidate_cache()
    with tempfile.TemporaryDirectory() as tmp:
        path_a = os.path.join(tmp, "a.json")
        path_b = os.path.join(tmp, "b.json")
        _write(path_a, {_CONSOLE_LOGGING_ID: "off"})
        _write(path_b, {_CONSOLE_LOGGING_ID: "debug"})
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "x", path=path_a) == "off"
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "x", path=path_b) == "debug"
        assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "x", path=path_a) == "off"


# ---------------------------------------------------------------------------
# No `path=` given -- the real, `folder_paths`-resolved path. This dev
# environment has no live ComfyUI installed at all, so `folder_paths` itself
# is not importable -- this IS the real "no ComfyUI" behaviour, not a
# simulated one (mirrors `src/anima/soft_imports.py`'s own "genuinely absent"
# posture).
# ---------------------------------------------------------------------------


def test_get_setting_with_no_path_falls_back_to_the_default_when_folder_paths_is_not_installed():
    fs_mod.invalidate_cache()
    try:
        import folder_paths  # noqa: F401
        installed = True
    except Exception:
        installed = False
    if installed:
        return  # a real ComfyUI env -- this specific "no folder_paths" case doesn't apply here
    assert fs_mod.get_setting(_CONSOLE_LOGGING_ID, "off") == "off"
    assert fs_mod._settings_file_path() is None


ALL_TESTS = [
    test_get_setting_returns_the_persisted_value_when_present,
    test_get_setting_returns_the_default_when_the_key_is_absent,
    test_get_setting_returns_the_default_when_the_file_is_missing,
    test_get_setting_returns_the_default_when_the_json_is_malformed,
    test_get_setting_returns_the_default_when_the_json_top_level_is_not_an_object,
    test_get_setting_returns_the_default_when_the_path_is_unreadable,
    test_get_setting_never_raises_for_any_of_the_above,
    test_get_setting_does_not_re_read_the_file_when_mtime_is_unchanged,
    test_invalidate_cache_forces_a_re_read_regardless_of_mtime,
    test_cache_is_keyed_per_path_not_globally_pinned_to_the_first_path_seen,
    test_get_setting_with_no_path_falls_back_to_the_default_when_folder_paths_is_not_installed,
]


if __name__ == "__main__":
    failures = []
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
