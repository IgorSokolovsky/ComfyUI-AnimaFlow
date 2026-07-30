"""Plain-script tests for the Anima Loader Panel's "which model did we
actually load" diagnostic (`nodes/controls/_loader_log_helpers.py`'s pure
formatters/`detect_duplicate_slots`, plus `loader_panel.py`'s wiring of them
behind the pack's existing `AnimaFlow.General.ConsoleLogging` off/summary/
debug control). Task brief: "the owner suspects `AnimaLoaderPanel` loads the
WRONG model -- not the one the row asked for".

Two halves, mirroring `tests/test_anima_pipeline_logging.py`'s own split:
  - Pure formatter/data-shaping tests (no comfy stub needed at all).
  - An integration half exercising `AnimaLoaderPanel().run()` end to end
    with the fake `folder_paths`/`nodes` from `tests/test_controls_loaders.py`,
    monkeypatching `loader_panel.frontend_settings_mod.get_setting` (same
    seam `test_anima_pipeline_logging.py` uses for `pipeline_mod`) and
    capturing real `logging` records against `logs_mod.LOGGER_NAME` -- proof
    that `"off"` is genuinely silent and `"debug"` genuinely prints the full
    per-slot mapping, not just that the pure predicates would say so.

Run directly: `python tests/test_controls_loader_log.py` (no pytest, per
project convention).
"""
from __future__ import annotations

import json
import logging
import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.controls import _loader_log_helpers as llh
from nodes.controls import _loaders_helpers as lh
from nodes.controls import loader_panel as lp
from nodes.controls.loader_panel import AnimaLoaderPanel
from src.anima import logs as logs_mod


# ---------------------------------------------------------------------------
# detect_duplicate_slots -- pure, mirrors rows_by_slot's own slot parsing.
# ---------------------------------------------------------------------------


def test_detect_duplicate_slots_no_collision():
    rows = [
        {"slot": 1, "kind": "unet", "value": "a"},
        {"slot": 2, "kind": "vae", "value": "b"},
    ]
    assert llh.detect_duplicate_slots(rows, 8) == []


def test_detect_duplicate_slots_one_collision_last_wins():
    rows = [
        {"slot": 1, "kind": "unet", "value": "a"},   # display #1
        {"slot": 2, "kind": "vae", "value": "b"},    # display #2, claims slot 2
        {"slot": 2, "kind": "clip", "value": "c"},   # display #3, ALSO claims slot 2
    ]
    collisions = llh.detect_duplicate_slots(rows, 8)
    assert collisions == [{"slot": 2, "display_indexes": [2, 3], "winner_display_index": 3}]


def test_detect_duplicate_slots_matches_rows_by_slots_own_parsing_rules():
    # Non-dict row, non-int-coercible slot, out-of-range slot -- all ignored
    # the same way `rows_by_slot` ignores them, so a collision report never
    # disagrees with what `rows_by_slot` itself actually considered.
    rows = [
        "not-a-dict",
        {"slot": "garbage", "kind": "unet", "value": "a"},
        {"slot": 99, "kind": "unet", "value": "a"},  # beyond max_rows=8
        {"slot": 1, "kind": "unet", "value": "a"},
        {"slot": 1, "kind": "vae", "value": "b"},
    ]
    collisions = llh.detect_duplicate_slots(rows, 8)
    assert collisions == [{"slot": 1, "display_indexes": [4, 5], "winner_display_index": 5}]


def test_detect_duplicate_slots_tolerates_non_list_rows():
    assert llh.detect_duplicate_slots(None, 8) == []
    assert llh.detect_duplicate_slots("garbage", 8) == []
    assert llh.detect_duplicate_slots(42, 8) == []


def test_detect_duplicate_slots_multiple_independent_collisions_both_reported():
    rows = [
        {"slot": 1, "kind": "unet", "value": "a"},
        {"slot": 1, "kind": "unet", "value": "a2"},
        {"slot": 3, "kind": "clip", "value": "c"},
        {"slot": 3, "kind": "clip", "value": "c2"},
    ]
    collisions = llh.detect_duplicate_slots(rows, 8)
    assert collisions == [
        {"slot": 1, "display_indexes": [1, 2], "winner_display_index": 2},
        {"slot": 3, "display_indexes": [3, 4], "winner_display_index": 4},
    ]


# ---------------------------------------------------------------------------
# format_loader_slot_line -- a normal loaded row, a skipped row (both
# reasons), a cache hit, and a missing-file/error row.
# ---------------------------------------------------------------------------


def test_format_slot_line_loaded_row_shows_slot_display_index_kind_name_path_and_cache():
    line = llh.format_loader_slot_line({
        "slot": 3, "display_index": 1, "kind": "unet", "name": "unetA.safetensors",
        "status": "loaded", "resolved_path": "/models/diffusion_models/unetA.safetensors",
        "cache_hit": False, "cache_key": ("unetA.safetensors", "default"),
    })
    assert "slot 3" in line
    assert "row #1" in line
    assert "unet" in line and "unetA.safetensors" in line
    assert "/models/diffusion_models/unetA.safetensors" in line
    assert "MISS" in line
    assert "loaded" in line
    # This is the divergence the whole feature exists to surface: slot 3,
    # but display position #1 -- both numbers on the SAME line.
    assert line.index("slot 3") < line.index("row #1")


def test_format_slot_line_cache_hit_says_hit_and_shows_key():
    line = llh.format_loader_slot_line({
        "slot": 1, "display_index": 1, "kind": "vae", "name": "vaeA.safetensors",
        "status": "loaded", "resolved_path": "/models/vae/vaeA.safetensors",
        "cache_hit": True, "cache_key": ("vaeA.safetensors",),
    })
    assert "HIT" in line
    assert "vaeA.safetensors" in line


def test_format_slot_line_empty_slot():
    line = llh.format_loader_slot_line({
        "slot": 5, "display_index": None, "status": "skipped", "skip_reason": "empty row",
    })
    assert "slot 5" in line
    assert "(no row)" in line
    assert "empty row" in line


def test_format_slot_line_skipped_not_wired():
    line = llh.format_loader_slot_line({
        "slot": 2, "display_index": 2, "kind": "vae", "name": "vaeA.safetensors",
        "status": "skipped", "skip_reason": "not referenced by anything downstream",
    })
    assert "row #2" in line
    assert "not referenced by anything downstream" in line


def test_format_slot_line_missing_file_error():
    line = llh.format_loader_slot_line({
        "slot": 4, "display_index": 4, "kind": "clip", "name": "ghost.safetensors",
        "status": "error", "skip_reason": "missing file -- ghost.safetensors not found",
    })
    assert "FAILED" in line
    assert "ghost.safetensors not found" in line


def test_format_slot_line_never_raises_on_garbage():
    for garbage in (None, "not-a-dict", 42, {}):
        line = llh.format_loader_slot_line(garbage)
        assert isinstance(line, str) and line


# ---------------------------------------------------------------------------
# format_duplicate_slot_line
# ---------------------------------------------------------------------------


def test_format_duplicate_slot_line_names_every_claimant_and_the_winner():
    line = llh.format_duplicate_slot_line(slot=2, display_indexes=[2, 3], winner_display_index=3)
    assert "slot 2" in line
    assert "DUPLICATE" in line
    assert "#2" in line and "#3" in line
    assert "row #3" in line and "wins" in line


# ---------------------------------------------------------------------------
# format_loader_run_summary -- the one line `summary` prints.
# ---------------------------------------------------------------------------


def test_format_run_summary_no_duplicates_is_one_clean_line():
    line = llh.format_loader_run_summary(loaded_count=2, skipped_count=1, empty_count=5, duplicate_count=0)
    assert "2 loaded" in line
    assert "1 skipped" in line
    assert "5 slot(s) empty" in line
    assert "duplicate" not in line.lower()
    assert "\n" not in line


def test_format_run_summary_duplicate_count_is_loud_even_at_summary_level():
    line = llh.format_loader_run_summary(loaded_count=1, skipped_count=0, empty_count=6, duplicate_count=1)
    assert "1 duplicate-slot collision" in line
    assert "\n" not in line, "summary level must stay a single line even with a collision"


def test_formatters_never_raise_on_garbage():
    assert isinstance(llh.format_loader_run_summary(loaded_count="x", skipped_count=None, empty_count=[], duplicate_count="y"), str)
    assert isinstance(llh.format_duplicate_slot_line(slot=None, display_indexes=None, winner_display_index=None), str)


# ---------------------------------------------------------------------------
# Integration -- AnimaLoaderPanel().run() itself, gated behind the reused
# AnimaFlow.General.ConsoleLogging setting. Same fake folder_paths/nodes
# install as tests/test_controls_loaders.py.
# ---------------------------------------------------------------------------


class _FakeModel:
    def __init__(self, tag):
        self.tag = tag


def _install_fake_comfy(*, known_files=None):
    known_files = known_files or {
        "diffusion_models": ["unetA.safetensors"],
        "vae": ["vaeA.safetensors"],
        "text_encoders": ["clipA.safetensors"],
    }
    fake_folder_paths = types.ModuleType("folder_paths")
    fake_folder_paths.get_filename_list = lambda folder: known_files.get(folder, [])
    fake_folder_paths.get_full_path = lambda folder, name: f"/models/{folder}/{name}" if name in known_files.get(folder, []) else None

    fake_nodes = types.ModuleType("nodes")

    class UNETLoader:
        def load_unet(self, unet_name, weight_dtype):
            return (_FakeModel(f"unet:{unet_name}:{weight_dtype}"),)

    class VAELoader:
        def load_vae(self, vae_name):
            return (_FakeModel(f"vae:{vae_name}"),)

    class CLIPLoader:
        def load_clip(self, clip_name, type, device):
            return (_FakeModel(f"clip:{clip_name}:{type}:{device}"),)

    fake_nodes.UNETLoader = UNETLoader
    fake_nodes.VAELoader = VAELoader
    fake_nodes.CLIPLoader = CLIPLoader

    previous = {"folder_paths": sys.modules.get("folder_paths"), "nodes": sys.modules.get("nodes")}
    sys.modules["folder_paths"] = fake_folder_paths
    sys.modules["nodes"] = fake_nodes

    def restore():
        for name, mod in previous.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod

    return restore


class _patched_get_setting:
    """Same seam `tests/test_anima_pipeline_logging.py` uses for
    `pipeline_mod` -- here rebinding `loader_panel.frontend_settings_mod.
    get_setting`."""

    def __init__(self, value):
        self.value = value
        self._original = None

    def __enter__(self):
        self._original = lp.frontend_settings_mod.get_setting
        lp.frontend_settings_mod.get_setting = lambda *args, **kwargs: self.value
        return self

    def __exit__(self, *exc_info):
        lp.frontend_settings_mod.get_setting = self._original
        return False


def _without_env_var():
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


class _CaptureLogs:
    """Attaches a real `logging.Handler` to `logs_mod.LOGGER_NAME` for the
    duration of the block and records every formatted message."""

    def __init__(self):
        self.records = []
        self._handler = None
        self._logger = logging.getLogger(logs_mod.LOGGER_NAME)
        self._old_level = None

    def __enter__(self):
        class _Handler(logging.Handler):
            def emit(_self, record):
                self.records.append(record.getMessage())

        self._handler = _Handler()
        self._old_level = self._logger.level
        self._logger.setLevel(logging.INFO)
        self._logger.addHandler(self._handler)
        return self

    def __exit__(self, *exc_info):
        self._logger.removeHandler(self._handler)
        self._logger.setLevel(self._old_level)
        return False


def _panel_state(rows):
    return json.dumps({"version": 1, "rows": rows})


def test_off_produces_no_log_output_at_all():
    restore = _install_fake_comfy()
    lh._reset_cache_for_tests()
    try:
        state = _panel_state([{"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}}])
        prompt = {
            "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": state}},
            "1": {"class_type": "KSampler", "inputs": {"model": ["7", 0]}},
        }
        with _without_env_var(), _patched_get_setting("off"), _CaptureLogs() as cap:
            out = AnimaLoaderPanel().run(state, prompt=prompt, unique_id="7")
        assert out[0] != 0
        assert cap.records == [], f"'off' must be genuinely silent, saw: {cap.records}"
    finally:
        restore()


def test_debug_shows_slot_vs_display_index_divergence_and_cache_hit_then_miss():
    # Three rows, but slot assignment does NOT follow display order -- the
    # exact scenario the task brief describes ("the second row I see" vs
    # "output slot 2" are not the same thing).
    restore = _install_fake_comfy()
    lh._reset_cache_for_tests()
    try:
        rows = [
            {"slot": 3, "kind": "unet", "value": "unetA.safetensors", "opts": {}},  # display #1, slot 3
            {"slot": 1, "kind": "vae", "value": "vaeA.safetensors", "opts": {}},    # display #2, slot 1
            {"slot": 2, "kind": "clip", "value": "clipA.safetensors", "opts": {}},  # display #3, slot 2
        ]
        state = _panel_state(rows)
        # No prompt/unique_id -- fails open, loads every row (simplest way to
        # exercise all three "loaded" events without hand-building a prompt
        # that wires all three slots).
        with _without_env_var(), _patched_get_setting("debug"), _CaptureLogs() as cap:
            out = AnimaLoaderPanel().run(state)
        assert all(o != 0 for o in out[:3])

        summary = cap.records[0]
        assert "3 loaded" in summary

        # The unet row: slot 3, display #1 -- both present on ONE line.
        unet_line = next(l for l in cap.records if "unet" in l and "unetA.safetensors" in l)
        assert "slot 3" in unet_line
        assert "row #1" in unet_line
        assert "/models/diffusion_models/unetA.safetensors" in unet_line
        assert "MISS" in unet_line  # first-ever load of this kind this test

        # Re-run with the SAME state -- second run should hit cache for every kind.
        with _without_env_var(), _patched_get_setting("debug"), _CaptureLogs() as cap2:
            AnimaLoaderPanel().run(state)
        unet_line_2 = next(l for l in cap2.records if "unet" in l and "unetA.safetensors" in l)
        assert "HIT" in unet_line_2
    finally:
        restore()


def test_debug_shows_missing_file_before_the_error_propagates():
    restore = _install_fake_comfy()
    lh._reset_cache_for_tests()
    try:
        state = _panel_state([{"slot": 1, "kind": "unet", "value": "does-not-exist.safetensors", "opts": {}}])
        with _without_env_var(), _patched_get_setting("debug"), _CaptureLogs() as cap:
            raised = False
            try:
                AnimaLoaderPanel().run(state)
            except lh.LoaderRowError:
                raised = True
        assert raised, "the underlying error must still propagate -- no behaviour change"
        error_line = next(l for l in cap.records if "does-not-exist.safetensors" in l and "FAILED" in l)
        assert "missing file" in error_line
    finally:
        restore()


def test_debug_shows_duplicate_slot_collision_from_a_hand_edited_payload():
    restore = _install_fake_comfy()
    lh._reset_cache_for_tests()
    try:
        rows = [
            {"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}},
            {"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}},  # duplicate slot
        ]
        state = _panel_state(rows)
        with _without_env_var(), _patched_get_setting("debug"), _CaptureLogs() as cap:
            AnimaLoaderPanel().run(state)
        assert "1 duplicate-slot collision" in cap.records[0]
        dup_line = next(l for l in cap.records if "DUPLICATE" in l)
        assert "#1" in dup_line and "#2" in dup_line
        assert "row #2" in dup_line and "wins" in dup_line
    finally:
        restore()


def test_debug_never_prints_a_per_slot_line_for_a_genuinely_empty_slot():
    # A 3-row panel leaves 5 of MAX_ROWS's 8 slots empty -- debug must print
    # exactly one line per slot that HAS a row (3 here), never one per empty
    # slot too (owner feedback, 2026-07-30: "why do we have empty slots when
    # the UI doesn't have it" -- 5 "(no row) -- skipped (empty row)" lines
    # buried the 3 that mattered). The run summary's own "N slot(s) empty"
    # count still covers the rest.
    restore = _install_fake_comfy()
    lh._reset_cache_for_tests()
    try:
        rows = [
            {"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}},
            {"slot": 2, "kind": "vae", "value": "vaeA.safetensors", "opts": {}},
            {"slot": 3, "kind": "clip", "value": "clipA.safetensors", "opts": {}},
        ]
        state = _panel_state(rows)
        with _without_env_var(), _patched_get_setting("debug"), _CaptureLogs() as cap:
            AnimaLoaderPanel().run(state)

        assert "5 slot(s) empty" in cap.records[0], cap.records[0]
        empty_slot_lines = [l for l in cap.records if "(no row)" in l]
        assert empty_slot_lines == [], f"expected zero per-slot lines for empty slots, saw: {empty_slot_lines}"
        # The 3 real rows still each get their own line -- summary + 3, no more.
        assert len(cap.records) == 4, cap.records
    finally:
        restore()


def test_summary_level_prints_exactly_one_line_even_with_a_collision():
    restore = _install_fake_comfy()
    lh._reset_cache_for_tests()
    try:
        rows = [
            {"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}},
            {"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}},
        ]
        state = _panel_state(rows)
        with _without_env_var(), _patched_get_setting("summary"), _CaptureLogs() as cap:
            AnimaLoaderPanel().run(state)
        assert len(cap.records) == 1, cap.records
        assert "duplicate-slot collision" in cap.records[0]
    finally:
        restore()


ALL_TESTS = [
    test_detect_duplicate_slots_no_collision,
    test_detect_duplicate_slots_one_collision_last_wins,
    test_detect_duplicate_slots_matches_rows_by_slots_own_parsing_rules,
    test_detect_duplicate_slots_tolerates_non_list_rows,
    test_detect_duplicate_slots_multiple_independent_collisions_both_reported,
    test_format_slot_line_loaded_row_shows_slot_display_index_kind_name_path_and_cache,
    test_format_slot_line_cache_hit_says_hit_and_shows_key,
    test_format_slot_line_empty_slot,
    test_format_slot_line_skipped_not_wired,
    test_format_slot_line_missing_file_error,
    test_format_slot_line_never_raises_on_garbage,
    test_format_duplicate_slot_line_names_every_claimant_and_the_winner,
    test_format_run_summary_no_duplicates_is_one_clean_line,
    test_format_run_summary_duplicate_count_is_loud_even_at_summary_level,
    test_formatters_never_raise_on_garbage,
    test_off_produces_no_log_output_at_all,
    test_debug_shows_slot_vs_display_index_divergence_and_cache_hit_then_miss,
    test_debug_shows_missing_file_before_the_error_propagates,
    test_debug_shows_duplicate_slot_collision_from_a_hand_edited_payload,
    test_debug_never_prints_a_per_slot_line_for_a_genuinely_empty_slot,
    test_summary_level_prints_exactly_one_line_even_with_a_collision,
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
