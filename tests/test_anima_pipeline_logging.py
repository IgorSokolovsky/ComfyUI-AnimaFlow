"""Plain-script tests for `src/anima/pipeline.py`'s own console-logging
gating (`_log_level`/`_should_log`/`_debug_enabled`) -- the three private
functions every `_logger.info(...)` call site in that module is now gated
behind (module docstring's "Verbosity contract"). `pipeline.py` itself is
importable with no ComfyUI installed (every real comfy/torch touch inside it
is a LAZY, function-body-local import — `.claude/CLAUDE.md`'s pure/impure
rule; this module's own top-level imports are all sibling `src.anima.*`
modules plus stdlib), so these are exercised directly against the real
module, not a stand-in — the ONE seam these tests use is monkeypatching
`pipeline_mod.frontend_settings_mod.get_setting` (a plain function-object
rebind on that already-imported module, restored in a `finally`), which
avoids ever touching a real `comfy.settings.json` file or requiring
`folder_paths`/ComfyUI to be installed.

`run()` itself (the actual per-run orchestration these three functions
gate) is NOT exercised end-to-end here -- it calls real ComfyUI/torch node
classes (`KSampler`, `VAEDecode`, ...) that don't exist in this dev
environment, so "off genuinely silences the per-run lines" is confirmed at
the level of the gating PREDICATE itself (`_should_log()`/`_debug_enabled()`
returning `False` for every input that should mean "off") plus a direct
source-scan confirming every `_logger.info(...)` call site in `pipeline.py`
is reached only through one of these two predicates -- the same
combination of "test the pure decision, source-scan the wiring" this
project's JS suites already use for `index.js`-only logic that can't be
unit-tested directly either.

Run directly: `python tests/test_anima_pipeline_logging.py` (no pytest, per
project convention).
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import pipeline as pipeline_mod
from src.anima import logs as logs_mod

_PIPELINE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "anima", "pipeline.py")


class _patched_get_setting:
    """Context manager: temporarily rebind `pipeline_mod.frontend_settings_mod.
    get_setting` to a fixed stand-in, restoring the original in `__exit__`
    even if the test body raises. `value` is returned regardless of the
    `(setting_id, default)` arguments passed -- these tests only ever care
    about ONE setting id (`logs_mod.CONSOLE_LOGGING_SETTING_ID`), so a
    fixed-return stub is enough."""

    def __init__(self, value):
        self.value = value
        self._original = None

    def __enter__(self):
        self._original = pipeline_mod.frontend_settings_mod.get_setting
        pipeline_mod.frontend_settings_mod.get_setting = lambda *args, **kwargs: self.value
        return self

    def __exit__(self, *exc_info):
        pipeline_mod.frontend_settings_mod.get_setting = self._original
        return False


def _without_env_var():
    """Context manager-like helper: temporarily remove `ANIMAFLOW_DEBUG`
    from `os.environ` (if present), restoring it afterward."""
    class _Ctx:
        def __enter__(self):
            self._had = "ANIMAFLOW_DEBUG" in os.environ
            self._old = os.environ.pop("ANIMAFLOW_DEBUG", None)
            return self

        def __exit__(self, *exc_info):
            if self._had:
                os.environ["ANIMAFLOW_DEBUG"] = self._old
            return False
    return _Ctx()


# ---------------------------------------------------------------------------
# _log_level / _should_log / _debug_enabled -- composition of the Settings-
# dialog value (stubbed) and the real os.environ.
# ---------------------------------------------------------------------------


def test_log_level_off_by_default_with_no_env_and_the_documented_off_setting():
    with _without_env_var(), _patched_get_setting(logs_mod.DEFAULT_LOG_LEVEL):
        assert pipeline_mod._log_level() == "off"
        assert pipeline_mod._should_log() is False
        assert pipeline_mod._debug_enabled() is False


def test_log_level_summary_prints_summary_lines_but_not_debug_ones():
    with _without_env_var(), _patched_get_setting("summary"):
        assert pipeline_mod._log_level() == "summary"
        assert pipeline_mod._should_log() is True
        assert pipeline_mod._debug_enabled() is False


def test_log_level_debug_setting_enables_both():
    with _without_env_var(), _patched_get_setting("debug"):
        assert pipeline_mod._log_level() == "debug"
        assert pipeline_mod._should_log() is True
        assert pipeline_mod._debug_enabled() is True


def test_env_var_forces_debug_even_when_the_setting_says_off():
    os.environ["ANIMAFLOW_DEBUG"] = "1"
    try:
        with _patched_get_setting("off"):
            assert pipeline_mod._log_level() == "debug"
            assert pipeline_mod._should_log() is True
            assert pipeline_mod._debug_enabled() is True
    finally:
        del os.environ["ANIMAFLOW_DEBUG"]


def test_env_var_falsy_does_not_override_the_setting():
    os.environ["ANIMAFLOW_DEBUG"] = "0"
    try:
        with _patched_get_setting("off"):
            assert pipeline_mod._log_level() == "off"
        with _patched_get_setting("summary"):
            assert pipeline_mod._log_level() == "summary"
    finally:
        del os.environ["ANIMAFLOW_DEBUG"]


def test_garbage_setting_value_falls_back_to_off():
    with _without_env_var(), _patched_get_setting("not-a-real-level"):
        assert pipeline_mod._log_level() == "off"
        assert pipeline_mod._should_log() is False


def test_log_level_reads_the_correct_setting_id():
    seen_ids = []
    original = pipeline_mod.frontend_settings_mod.get_setting

    def _spy(setting_id, default=None, **kwargs):
        seen_ids.append(setting_id)
        return default

    pipeline_mod.frontend_settings_mod.get_setting = _spy
    try:
        with _without_env_var():
            pipeline_mod._log_level()
    finally:
        pipeline_mod.frontend_settings_mod.get_setting = original
    assert seen_ids == [logs_mod.CONSOLE_LOGGING_SETTING_ID]


# ---------------------------------------------------------------------------
# Source scan: every `_logger.info(...)` call site in `run()`/`run_detailer`/
# `run_highres`/`run_upscale` is reached only through `should_log`/`debug`
# (this module's own top doc comment: the "off genuinely silences every
# per-run line" half this dev environment can't exercise end-to-end).
# ---------------------------------------------------------------------------


def test_every_logger_info_call_in_pipeline_is_gated_behind_should_log_or_debug():
    with open(_PIPELINE_PATH, "r", encoding="utf-8") as fh:
        source = fh.read()

    # Every REAL `_logger.info(` call site -- anchored to the start of a
    # (possibly indented) line via re.MULTILINE, so a docstring's own PROSE
    # mention of "`_logger.info(...)`" (several exist in this file, inline
    # in backticks) is never mistaken for actual code.
    call_positions = [m.start() for m in re.finditer(r"^[ \t]*_logger\.info\(", source, re.MULTILINE)]
    assert len(call_positions) >= 8, "expected at least the run-header/model-files/sampler-provenance/per-stage/detailer-block/debug lines"

    for pos in call_positions:
        window = source[max(0, pos - 400):pos]
        assert re.search(r"if\s+(should_log|debug|_debug_enabled\(\))\s*:", window), (
            f"_logger.info( call at byte offset {pos} is not visibly gated behind "
            f"should_log/debug/_debug_enabled() -- nearby source:\n{window[-200:]}"
        )


def test_should_log_and_debug_functions_are_computed_once_near_the_top_of_run():
    with open(_PIPELINE_PATH, "r", encoding="utf-8") as fh:
        source = fh.read()
    assert "should_log = _should_log()" in source
    assert "debug = _debug_enabled()" in source


ALL_TESTS = [
    test_log_level_off_by_default_with_no_env_and_the_documented_off_setting,
    test_log_level_summary_prints_summary_lines_but_not_debug_ones,
    test_log_level_debug_setting_enables_both,
    test_env_var_forces_debug_even_when_the_setting_says_off,
    test_env_var_falsy_does_not_override_the_setting,
    test_garbage_setting_value_falls_back_to_off,
    test_log_level_reads_the_correct_setting_id,
    test_every_logger_info_call_in_pipeline_is_gated_behind_should_log_or_debug,
    test_should_log_and_debug_functions_are_computed_once_near_the_top_of_run,
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
