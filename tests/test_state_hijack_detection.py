"""Plain-script tests for the "state input hijacked by another extension"
detection added to every node with a serialized-state widget --
`AnimaControlPanel`/`AnimaLoaderPanel` (`nodes/controls/_rows_helpers.
detect_state_mismatch`), `AnimaLoraLoader` (`nodes/controls/_lora_helpers.
detect_state_mismatch`), and `AnimaGenerator`/`AnimaPreview`
(`src/anima/settings.detect_schema_mismatch`, reused by `preview_settings.py`).

Root cause (2026-07-29, caught live by a queue probe): cg-use-everywhere
broadcasts a same-typed `STRING` output (observed: `AnimaGenerator`'s
`metadata_json`) into a `STRING` widget-input it was never meant to feed --
silently replacing a node's ENTIRE saved state on every run. The existing
`parse_state`/`normalize_*_settings` functions already tolerate this (any
unparseable/wrong-shaped blob degrades to defaults, by their own documented
contract) -- that tolerance is UNCHANGED by this task. What's new is the
OBSERVATION: every node above now notices when its state input did NOT
arrive as its own shape and says so where the user will see it (a
`print()`/`_logger.warning(...)`, unconditional -- NOT gated behind the
"Console logging" off/summary/debug setting, since this is a correctness
signal, not a debug nicety), while staying silent for a genuinely
absent/first-run value and for a value that genuinely IS its own state.

Covers, per node, the three cases the task names:
  - a state input carrying a non-schema/foreign-shaped value produces the
    loud observation AND still degrades to defaults (never raises, never
    changes behaviour beyond the new print/log line);
  - a genuinely absent value (`None`/`""`/the declared `"{}"` widget
    default) stays silent;
  - a valid value (this node's own shape) is unaffected -- silent, and
    normalizes/parses exactly as before.
Plus: the pure detectors' own hostile-input tolerance (never raises,
regardless of how garbage the input is), and the underlying
`parse_state`/`normalize_*_settings` never-raises contract still holds for
every hostile shape already covered by their own test files (re-asserted
here specifically for the shapes THIS task's detectors newly reason about --
`test_controls_state.py`/`test_lora_state.py`/`test_anima_settings.py`/
`test_anima_preview_settings.py` remain the authority for the rest).

Run directly: `python tests/test_state_hijack_detection.py` (no pytest, per
project convention).
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import pipeline as pipeline_mod
from src.anima import preview_settings as preview_settings_mod
from src.anima import settings as settings_mod
from src.anima.context import ContextFieldMissing, build_context

from nodes.anima.generator import AnimaGenerator
from nodes.anima import preview as preview_mod
from nodes.anima.preview import AnimaPreview

from nodes.controls import _lora_helpers as lora_helpers_mod
from nodes.controls import _rows_helpers as rows_helpers_mod
from nodes.controls import control_panel as control_panel_mod
from nodes.controls import loader_panel as loader_panel_mod
from nodes.controls import lora_loader as lora_loader_mod
from nodes.controls.control_panel import AnimaControlPanel
from nodes.controls.loader_panel import AnimaLoaderPanel
from nodes.controls.lora_loader import AnimaLoraLoader

# Real fixture shapes for each of the four OTHER state kinds -- used to
# simulate "node X's state input got hijacked by node Y's STRING output",
# matching the actual bug (a real `AnimaGenerator.metadata_json` value
# landing in `AnimaPreview.preview_state`).
_GENERATION_SETTINGS_LIKE = json.dumps({
    "schema": settings_mod.GENERATION_SETTINGS_SCHEMA, "version": 1,
    "sampler": {"seed": "-1"}, "detailer": {"enabled": False},
})
_PREVIEW_STATE_LIKE = json.dumps({
    "schema": preview_settings_mod.PREVIEW_SETTINGS_SCHEMA, "version": 1,
    "compare": {"enabled": True, "a": "base", "b": "final"},
    "save": {"enabled": False},
})
_PANEL_STATE_LIKE = json.dumps({
    "version": 1,
    "rows": [{"slot": 1, "kind": "sampler", "name": "sampler name", "value": "euler_ancestral", "opts": {}}],
})
_LORA_STATE_LIKE = json.dumps({
    "cacheMode": "all", "sep": " | ",
    "rows": [{"id": "r1", "name": "a.safetensors", "on": True, "sm": 0.8, "sc": 0.6, "triggers": ["foo"]}],
})

_ABSENT_VALUES = (None, "", "{}", {})
_HOSTILE_BLOBS = ("{not json", "null", "42", "[1,2,3]", None, 123, ["a", "list"], True, 3.14)


@contextlib.contextmanager
def _capture_stdout():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        yield buf


@contextlib.contextmanager
def _capture_logger_warning(mod):
    """Monkeypatch `mod._logger.warning` to record calls instead of actually
    logging, restoring the original in `finally` -- same pattern
    `tests/test_anima_pipeline_logging.py` already uses for
    `frontend_settings_mod.get_setting`. NOTE: `pipeline.py` and
    `nodes/anima/preview.py` both create their `_logger` via
    `logging.getLogger(logs_mod.LOGGER_NAME)` with the SAME name, so they are
    literally the same `Logger` object -- patching one patches both; each
    test still restores in its own `finally`.
    """
    calls = []
    original = mod._logger.warning
    mod._logger.warning = lambda *args, **kwargs: calls.append((args, kwargs))
    try:
        yield calls
    finally:
        mod._logger.warning = original


def _install_fake_folder_paths():
    """A minimal `folder_paths` stub -- only needed so `_lora_helpers.
    apply_loras`'s unconditional (not lazy-per-row) `import folder_paths`
    at its own top doesn't raise `ModuleNotFoundError` in this dev
    environment with no ComfyUI installed. Never actually called here since
    every LoRA-loader test below degrades to an EMPTY row list before the
    apply loop ever reaches a row. Returns a restore callable."""
    previous = sys.modules.get("folder_paths")
    fake = types.ModuleType("folder_paths")
    fake.get_full_path = lambda folder, name: None
    sys.modules["folder_paths"] = fake

    def restore():
        if previous is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = previous

    return restore


# ---------------------------------------------------------------------------
# Pure detector: src/anima/settings.detect_schema_mismatch
# (generation_settings's own schema-bearing shape; reused verbatim by
# preview_settings.py for preview_state's differently-named schema).
# ---------------------------------------------------------------------------


def test_detect_schema_mismatch_absent_is_silent():
    for absent in _ABSENT_VALUES:
        assert settings_mod.detect_schema_mismatch(absent, settings_mod.GENERATION_SETTINGS_SCHEMA) is None, absent


def test_detect_schema_mismatch_own_schema_is_silent_any_version():
    raw = json.dumps({"schema": settings_mod.GENERATION_SETTINGS_SCHEMA, "version": 1})
    assert settings_mod.detect_schema_mismatch(raw, settings_mod.GENERATION_SETTINGS_SCHEMA) is None
    raw_old = json.dumps({"schema": settings_mod.GENERATION_SETTINGS_SCHEMA, "version": 0})
    assert settings_mod.detect_schema_mismatch(raw_old, settings_mod.GENERATION_SETTINGS_SCHEMA) is None


def test_detect_schema_mismatch_foreign_schema_is_loud():
    reason = settings_mod.detect_schema_mismatch(_PREVIEW_STATE_LIKE, settings_mod.GENERATION_SETTINGS_SCHEMA)
    assert reason is not None
    assert preview_settings_mod.PREVIEW_SETTINGS_SCHEMA in reason


def test_detect_schema_mismatch_missing_schema_field_is_loud():
    reason = settings_mod.detect_schema_mismatch(json.dumps({"foo": "bar"}), settings_mod.GENERATION_SETTINGS_SCHEMA)
    assert reason == "the value has no 'schema' field at all"


def test_detect_schema_mismatch_never_raises_on_hostile_blobs():
    for bad in _HOSTILE_BLOBS:
        reason = settings_mod.detect_schema_mismatch(bad, settings_mod.GENERATION_SETTINGS_SCHEMA)
        assert reason is None or isinstance(reason, str), (bad, reason)


def test_preview_settings_reuses_the_same_detector_function():
    assert preview_settings_mod.detect_schema_mismatch is settings_mod.detect_schema_mismatch


def test_preview_settings_detect_schema_mismatch_own_vs_foreign():
    own = json.dumps({"schema": preview_settings_mod.PREVIEW_SETTINGS_SCHEMA, "version": 1})
    assert preview_settings_mod.detect_schema_mismatch(own, preview_settings_mod.PREVIEW_SETTINGS_SCHEMA) is None
    reason = preview_settings_mod.detect_schema_mismatch(
        _GENERATION_SETTINGS_LIKE, preview_settings_mod.PREVIEW_SETTINGS_SCHEMA,
    )
    assert reason is not None
    assert settings_mod.GENERATION_SETTINGS_SCHEMA in reason


# ---------------------------------------------------------------------------
# Pure detector: nodes/controls/_rows_helpers.detect_state_mismatch
# (panel_state -- Control Panel + Loader Panel's shared shape).
# ---------------------------------------------------------------------------


def test_panel_detect_absent_is_silent():
    for absent in _ABSENT_VALUES:
        assert rows_helpers_mod.detect_state_mismatch(absent) is None, absent


def test_panel_detect_own_shape_is_silent():
    assert rows_helpers_mod.detect_state_mismatch(_PANEL_STATE_LIKE) is None
    assert rows_helpers_mod.detect_state_mismatch(json.dumps({"version": 1, "rows": []})) is None


def test_panel_detect_lora_state_hijack_is_loud():
    reason = rows_helpers_mod.detect_state_mismatch(_LORA_STATE_LIKE)
    assert reason is not None
    assert "LoRA Loader" in reason


def test_panel_detect_generation_settings_hijack_is_loud():
    reason = rows_helpers_mod.detect_state_mismatch(_GENERATION_SETTINGS_LIKE)
    assert reason == "the value has no 'rows' field at all"


def test_panel_detect_preview_state_hijack_is_loud():
    reason = rows_helpers_mod.detect_state_mismatch(_PREVIEW_STATE_LIKE)
    assert reason == "the value has no 'rows' field at all"


def test_panel_detect_rows_not_a_list_is_loud():
    reason = rows_helpers_mod.detect_state_mismatch(json.dumps({"version": 1, "rows": "oops"}))
    assert reason == "its 'rows' field is not a list"


def test_panel_detect_garbage_rows_is_loud():
    reason = rows_helpers_mod.detect_state_mismatch(json.dumps({"version": 1, "rows": [{"foo": "bar"}]}))
    assert reason is not None and "slot" in reason


def test_panel_detect_never_raises_on_hostile_blobs():
    for bad in _HOSTILE_BLOBS:
        reason = rows_helpers_mod.detect_state_mismatch(bad)
        assert reason is None or isinstance(reason, str), (bad, reason)


# ---------------------------------------------------------------------------
# Pure detector: nodes/controls/_lora_helpers.detect_state_mismatch
# (lora_state -- Anima LoRA Loader's own shape).
# ---------------------------------------------------------------------------


def test_lora_detect_absent_is_silent():
    for absent in _ABSENT_VALUES:
        assert lora_helpers_mod.detect_state_mismatch(absent) is None, absent


def test_lora_detect_own_shape_is_silent():
    assert lora_helpers_mod.detect_state_mismatch(_LORA_STATE_LIKE) is None
    assert lora_helpers_mod.detect_state_mismatch(json.dumps({"cacheMode": "last", "sep": ", ", "rows": []})) is None


def test_lora_detect_panel_state_hijack_is_loud():
    reason = lora_helpers_mod.detect_state_mismatch(_PANEL_STATE_LIKE)
    assert reason is not None
    assert "Panel" in reason


def test_lora_detect_generation_settings_hijack_is_loud():
    reason = lora_helpers_mod.detect_state_mismatch(_GENERATION_SETTINGS_LIKE)
    assert reason == "the value has no recognizable Anima LoRA Loader fields (no 'rows', 'cacheMode', or 'sep')"


def test_lora_detect_rows_not_a_list_is_loud():
    reason = lora_helpers_mod.detect_state_mismatch(json.dumps({"rows": "oops"}))
    assert reason == "its 'rows' field is not a list"


def test_lora_detect_garbage_rows_is_loud():
    reason = lora_helpers_mod.detect_state_mismatch(json.dumps({"rows": [{"foo": "bar"}]}))
    assert reason is not None and "name" in reason


def test_lora_detect_never_raises_on_hostile_blobs():
    for bad in _HOSTILE_BLOBS:
        reason = lora_helpers_mod.detect_state_mismatch(bad)
        assert reason is None or isinstance(reason, str), (bad, reason)


# ---------------------------------------------------------------------------
# Integration: AnimaControlPanel.run() -- print(), no console-logging gate.
# ---------------------------------------------------------------------------


def test_control_panel_run_hijack_prints_loud_and_still_degrades_to_zeros():
    with _capture_stdout() as buf:
        out = AnimaControlPanel().run(panel_state=_LORA_STATE_LIKE)
    text = buf.getvalue()
    assert "Anima Control Panel" in text
    assert "did not arrive as this node's own saved state" in text
    assert out == tuple(0 for _ in range(control_panel_mod.MAX_ROWS))


def test_control_panel_run_absent_state_is_silent():
    with _capture_stdout() as buf:
        AnimaControlPanel().run(panel_state="{}")
    assert buf.getvalue() == ""


def test_control_panel_run_valid_state_is_silent_and_unaffected():
    raw = json.dumps({"version": 1, "rows": [{"slot": 1, "kind": "int", "name": "steps", "value": 30, "opts": {}}]})
    with _capture_stdout() as buf:
        out = AnimaControlPanel().run(panel_state=raw)
    assert buf.getvalue() == ""
    assert out[0] == 30


# ---------------------------------------------------------------------------
# Integration: AnimaLoaderPanel.run() -- _logger.warning(...), unconditional
# (NOT gated behind this node's own off/summary/debug diagnostic logging).
# ---------------------------------------------------------------------------


def test_loader_panel_run_hijack_logs_loud_and_still_degrades_to_zeros():
    with _capture_logger_warning(loader_panel_mod) as calls:
        out = AnimaLoaderPanel().run(panel_state=_GENERATION_SETTINGS_LIKE)
    assert len(calls) == 1
    message = calls[0][0][0]
    assert "Anima Loader Panel" in message
    assert out == tuple(0 for _ in range(loader_panel_mod.MAX_ROWS))


def test_loader_panel_run_absent_state_is_silent():
    with _capture_logger_warning(loader_panel_mod) as calls:
        AnimaLoaderPanel().run(panel_state="{}")
    assert calls == []


def test_loader_panel_run_valid_empty_state_is_silent():
    with _capture_logger_warning(loader_panel_mod) as calls:
        out = AnimaLoaderPanel().run(panel_state=json.dumps({"version": 1, "rows": []}))
    assert calls == []
    assert out == tuple(0 for _ in range(loader_panel_mod.MAX_ROWS))


# ---------------------------------------------------------------------------
# Integration: AnimaLoraLoader.apply() -- print(), no console-logging gate.
# ---------------------------------------------------------------------------


def test_lora_loader_apply_hijack_prints_loud_and_still_degrades_to_empty_stack():
    restore = _install_fake_folder_paths()
    try:
        with _capture_stdout() as buf:
            model, clip, triggers = AnimaLoraLoader().apply(model="FAKE_MODEL", lora_state=_PANEL_STATE_LIKE, clip=None)
    finally:
        restore()
    text = buf.getvalue()
    assert "Anima LoRA Loader" in text
    assert "did not arrive as this node's own saved state" in text
    assert model == "FAKE_MODEL"
    assert triggers == ""


def test_lora_loader_apply_absent_state_is_silent():
    # NOTE: `apply_loras` itself already prints an unrelated, pre-existing
    # "applied N LoRA(s)" summary line unconditionally (`_lora_helpers.py`) --
    # this test asserts the NEW hijack-detection line specifically stays
    # silent, not that the buffer is empty.
    restore = _install_fake_folder_paths()
    try:
        with _capture_stdout() as buf:
            AnimaLoraLoader().apply(model="FAKE_MODEL", lora_state="{}", clip=None)
    finally:
        restore()
    assert "did not arrive as this node's own saved state" not in buf.getvalue()


def test_lora_loader_apply_valid_empty_state_is_silent():
    restore = _install_fake_folder_paths()
    try:
        with _capture_stdout() as buf:
            model, clip, triggers = AnimaLoraLoader().apply(
                model="FAKE_MODEL", lora_state=json.dumps({"cacheMode": "last", "sep": ", ", "rows": []}), clip=None,
            )
    finally:
        restore()
    assert "did not arrive as this node's own saved state" not in buf.getvalue()
    assert model == "FAKE_MODEL"
    assert triggers == ""


# ---------------------------------------------------------------------------
# Integration: AnimaGenerator.generate() -> pipeline.run_generator() --
# _logger.warning(...), unconditional (NOT gated behind `_should_log()`).
# ---------------------------------------------------------------------------


def test_generator_generate_hijack_logs_loud_and_still_raises_readable_missing_context():
    empty_context = build_context({})
    with _capture_logger_warning(pipeline_mod) as calls:
        try:
            AnimaGenerator().generate(context=empty_context, generation_settings=_PREVIEW_STATE_LIKE)
            assert False, "expected ContextFieldMissing"
        except ContextFieldMissing:
            pass
    assert len(calls) == 1
    assert "Anima Generator" in calls[0][0][0]


def test_generator_generate_absent_settings_is_silent():
    empty_context = build_context({})
    with _capture_logger_warning(pipeline_mod) as calls:
        try:
            AnimaGenerator().generate(context=empty_context, generation_settings="{}")
        except ContextFieldMissing:
            pass
    assert calls == []


def test_generator_generate_own_schema_settings_is_silent():
    empty_context = build_context({})
    own = json.dumps({"schema": settings_mod.GENERATION_SETTINGS_SCHEMA, "version": 1})
    with _capture_logger_warning(pipeline_mod) as calls:
        try:
            AnimaGenerator().generate(context=empty_context, generation_settings=own)
        except ContextFieldMissing:
            pass
    assert calls == []


# ---------------------------------------------------------------------------
# Integration: AnimaPreview.preview() -- _logger.warning(...), unconditional
# (same shared `LOGGER_NAME` logger as pipeline.py -- see
# `_capture_logger_warning`'s own docstring).
# ---------------------------------------------------------------------------


def _run_preview(preview_state):
    # `INPUT_IS_LIST = True` wraps every input in a one-element list except
    # `images` itself -- see `nodes/anima/preview.py`'s own module docstring.
    return AnimaPreview().preview(
        preview_state=[preview_state], images=[], metadata_json=[None], prompt=[None], extra_pnginfo=[None],
    )


def test_preview_preview_hijack_logs_loud_and_still_degrades_to_defaults():
    with _capture_logger_warning(preview_mod) as calls:
        result = _run_preview(_GENERATION_SETTINGS_LIKE)
    assert len(calls) == 1
    assert "Anima Preview" in calls[0][0][0]
    assert result["ui"]["anima_stages"] == []


def test_preview_preview_absent_state_is_silent():
    with _capture_logger_warning(preview_mod) as calls:
        _run_preview("{}")
    assert calls == []


def test_preview_preview_own_schema_state_is_silent():
    own = json.dumps({"schema": preview_settings_mod.PREVIEW_SETTINGS_SCHEMA, "version": 1})
    with _capture_logger_warning(preview_mod) as calls:
        _run_preview(own)
    assert calls == []


ALL_TESTS = [
    test_detect_schema_mismatch_absent_is_silent,
    test_detect_schema_mismatch_own_schema_is_silent_any_version,
    test_detect_schema_mismatch_foreign_schema_is_loud,
    test_detect_schema_mismatch_missing_schema_field_is_loud,
    test_detect_schema_mismatch_never_raises_on_hostile_blobs,
    test_preview_settings_reuses_the_same_detector_function,
    test_preview_settings_detect_schema_mismatch_own_vs_foreign,
    test_panel_detect_absent_is_silent,
    test_panel_detect_own_shape_is_silent,
    test_panel_detect_lora_state_hijack_is_loud,
    test_panel_detect_generation_settings_hijack_is_loud,
    test_panel_detect_preview_state_hijack_is_loud,
    test_panel_detect_rows_not_a_list_is_loud,
    test_panel_detect_garbage_rows_is_loud,
    test_panel_detect_never_raises_on_hostile_blobs,
    test_lora_detect_absent_is_silent,
    test_lora_detect_own_shape_is_silent,
    test_lora_detect_panel_state_hijack_is_loud,
    test_lora_detect_generation_settings_hijack_is_loud,
    test_lora_detect_rows_not_a_list_is_loud,
    test_lora_detect_garbage_rows_is_loud,
    test_lora_detect_never_raises_on_hostile_blobs,
    test_control_panel_run_hijack_prints_loud_and_still_degrades_to_zeros,
    test_control_panel_run_absent_state_is_silent,
    test_control_panel_run_valid_state_is_silent_and_unaffected,
    test_loader_panel_run_hijack_logs_loud_and_still_degrades_to_zeros,
    test_loader_panel_run_absent_state_is_silent,
    test_loader_panel_run_valid_empty_state_is_silent,
    test_lora_loader_apply_hijack_prints_loud_and_still_degrades_to_empty_stack,
    test_lora_loader_apply_absent_state_is_silent,
    test_lora_loader_apply_valid_empty_state_is_silent,
    test_generator_generate_hijack_logs_loud_and_still_raises_readable_missing_context,
    test_generator_generate_absent_settings_is_silent,
    test_generator_generate_own_schema_settings_is_silent,
    test_preview_preview_hijack_logs_loud_and_still_degrades_to_defaults,
    test_preview_preview_absent_state_is_silent,
    test_preview_preview_own_schema_state_is_silent,
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
