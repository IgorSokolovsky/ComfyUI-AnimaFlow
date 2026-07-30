"""Plain-script tests for the generation-history recording/listing halves
that live in `nodes/anima/_preview_helpers.py` (impure -- reads a tensor's
own shape, does the on-disk existence check `resolve_history_view` needs)
plus the end-to-end wiring from `AnimaPreview.preview()` itself. The pure
ring (`src/anima/history.py`) has its own test file, `test_anima_history.py`
-- this file only exercises the impure glue around it, per this pack's
pure/impure test split.

Run directly: `python tests/test_anima_preview_history.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima import _preview_helpers as ph
from nodes.anima.preview import AnimaPreview
from src.anima.history import HistoryStore


class _FakeTensor:
    """Stands in for a batched `IMAGE` tensor -- only `.shape` is read
    (`_tensor_size`'s own doc comment: no PIL/numpy/torch needed at all)."""

    def __init__(self, batch, height, width, channels=3):
        self.shape = (batch, height, width, channels)


# ---------------------------------------------------------------------------
# `_tensor_size`
# ---------------------------------------------------------------------------


def test_tensor_size_reads_width_height_from_shape():
    assert ph._tensor_size(_FakeTensor(1, 768, 512)) == (512, 768)


def test_tensor_size_hostile_input_degrades_to_zero_zero():
    assert ph._tensor_size(None) == (0, 0)
    assert ph._tensor_size(object()) == (0, 0)
    assert ph._tensor_size("not a tensor") == (0, 0)


# ---------------------------------------------------------------------------
# `record_history_entries`
# ---------------------------------------------------------------------------


def test_record_history_entries_records_one_per_entry():
    store = HistoryStore()
    entries = [
        {"filename": "base_0.png", "subfolder": "", "type": "temp", "stage": "base"},
        {"filename": "final_0.png", "subfolder": "AnimaFlow", "type": "output", "stage": "final"},
    ]
    wired = {"base": _FakeTensor(1, 1024, 1024), "final": _FakeTensor(1, 2048, 2048)}
    ph.record_history_entries(
        entries, wired=wired, seed="777", settings={"sampler": {"seed": "777"}}, timestamp=42.0, store=store,
    )
    recorded = store.list_entries()
    assert len(recorded) == 2
    # Newest-first: `final` was recorded second, so it's first in the list.
    assert recorded[0]["stage"] == "final"
    assert recorded[0]["filename"] == "final_0.png"
    assert recorded[0]["subfolder"] == "AnimaFlow"
    assert recorded[0]["type"] == "output"
    assert recorded[0]["width"] == 2048 and recorded[0]["height"] == 2048
    assert recorded[0]["seed"] == "777"
    assert recorded[0]["timestamp"] == 42.0
    assert recorded[1]["stage"] == "base"
    assert recorded[1]["width"] == 1024 and recorded[1]["height"] == 1024


def test_record_history_entries_never_raises_on_malformed_input():
    store = HistoryStore()
    # A non-dict item, an entry naming a stage absent from `wired`, and a
    # non-list `entries` altogether must all be swallowed, never raised.
    ph.record_history_entries(
        [{"filename": "a.png", "type": "temp", "stage": "base"}, "not-a-dict", 42],
        wired={}, seed=None, settings=None, timestamp=None, store=store,
    )
    recorded = store.list_entries()
    assert len(recorded) == 1
    assert recorded[0]["width"] == 0 and recorded[0]["height"] == 0

    ph.record_history_entries("not-a-list-either", wired={}, seed=0, settings=None, timestamp=0, store=store)
    assert len(store.list_entries()) == 1  # unchanged -- nothing new recorded, nothing raised


def test_record_history_entries_defaults_to_the_real_singleton_when_no_store_is_injected():
    original = ph._HISTORY_STORE
    fake = HistoryStore()
    try:
        ph._HISTORY_STORE = fake
        ph.record_history_entries(
            [{"filename": "x.png", "type": "temp", "stage": "base"}],
            wired={"base": _FakeTensor(1, 4, 4)}, seed="1", settings=None, timestamp=1.0,
        )
        assert len(fake.list_entries()) == 1
    finally:
        ph._HISTORY_STORE = original


# ---------------------------------------------------------------------------
# `resolve_history_view` -- the expired-entry existence check
# ---------------------------------------------------------------------------


def test_resolve_history_view_marks_a_missing_file_expired_a_present_one_not():
    tmp_output = tempfile.mkdtemp()
    tmp_temp = tempfile.mkdtemp()
    store = HistoryStore()
    # An `output` file that genuinely exists on disk.
    real_path = os.path.join(tmp_output, "AnimaFlow", "still_here.png")
    os.makedirs(os.path.dirname(real_path), exist_ok=True)
    with open(real_path, "wb") as fh:
        fh.write(b"not a real png, existence is all that's checked")
    store.record(
        stage="final", seed="1", filename="still_here.png", subfolder="AnimaFlow", file_type="output",
        timestamp=1.0, width=8, height=8, settings=None,
    )
    # A `temp` file that was never written (or already cleaned up).
    store.record(
        stage="base", seed="1", filename="gone.png", subfolder="", file_type="temp",
        timestamp=2.0, width=8, height=8, settings=None,
    )

    view = ph.resolve_history_view(
        output_dir_fn=lambda: tmp_output, temp_dir_fn=lambda: tmp_temp, store=store,
    )
    by_filename = {e["filename"]: e for e in view}
    assert by_filename["still_here.png"]["expired"] is False
    assert by_filename["gone.png"]["expired"] is True
    # Every original field survives the annotation untouched.
    assert by_filename["still_here.png"]["subfolder"] == "AnimaFlow"
    assert by_filename["still_here.png"]["type"] == "output"


def test_resolve_history_view_checks_only_each_entrys_own_path_never_a_directory_scan():
    store = HistoryStore()
    for i in range(5):
        store.record(
            stage="base", seed="1", filename=f"f{i}.png", subfolder="", file_type="temp",
            timestamp=float(i), width=1, height=1, settings=None,
        )
    calls = []

    def counting_exists(path):
        calls.append(path)
        return True

    view = ph.resolve_history_view(
        output_dir_fn=lambda: "/out", temp_dir_fn=lambda: "/tmp-root", exists_fn=counting_exists, store=store,
    )
    assert len(view) == 5
    # Exactly one existence check per entry -- never an `os.listdir`-style
    # scan of the whole directory (`resolve_history_view`'s own doc comment).
    assert len(calls) == 5
    assert all("f" in c and ".png" in c for c in calls)


def test_resolve_history_view_hostile_exists_fn_reports_expired_not_a_crash():
    store = HistoryStore()
    store.record(
        stage="base", seed="1", filename="x.png", subfolder="", file_type="temp",
        timestamp=1.0, width=1, height=1, settings=None,
    )

    def raising_exists(path):
        raise OSError("simulated filesystem error")

    view = ph.resolve_history_view(
        output_dir_fn=lambda: "/out", temp_dir_fn=lambda: "/tmp-root", exists_fn=raising_exists, store=store,
    )
    assert view[0]["expired"] is True


def test_resolve_history_view_empty_store_yields_empty_list():
    store = HistoryStore()
    assert ph.resolve_history_view(output_dir_fn=lambda: "/o", temp_dir_fn=lambda: "/t", store=store) == []


# ---------------------------------------------------------------------------
# End-to-end: `AnimaPreview.preview()` records both the auto-save AND the
# temp-preview path, same fake-writer convention `test_anima_preview_images.
# py` already uses (no PIL/folder_paths needed).
# ---------------------------------------------------------------------------


def _install_fake_writers():
    originals = {"save": ph.save_images, "temp": ph.write_temp_stage_images}

    def fake_save_images(*, wired, stages_to_save, preview_settings, seed=0, prompt=None, extra_pnginfo=None):
        return [{"filename": f"{s}_out.png", "subfolder": "AnimaFlow", "type": "output", "stage": s} for s in stages_to_save]

    def fake_write_temp(wired, stages):
        return [{"filename": f"{s}_temp.png", "subfolder": "", "type": "temp", "stage": s} for s in stages]

    ph.save_images = fake_save_images
    ph.write_temp_stage_images = fake_write_temp

    def restore():
        ph.save_images = originals["save"]
        ph.write_temp_stage_images = originals["temp"]

    return restore


class _FakeImageTensor:
    def __init__(self, height=64, width=64):
        self.shape = (1, height, width, 3)

    # `preview()` only ever reads `.shape` on these (the history recording
    # path) -- everything else `INPUT_IS_LIST`/`zip` needs is plain list
    # membership, no tensor math happens in this file's own code path.


def test_preview_records_history_entries_for_both_save_and_temp_paths():
    restore_writers = _install_fake_writers()
    fake_store = HistoryStore()
    original_store = ph._HISTORY_STORE
    ph._HISTORY_STORE = fake_store
    try:
        node = AnimaPreview()
        images = [_FakeImageTensor(1024, 1024), _FakeImageTensor(2048, 2048)]
        metadata_json = (
            '{"schema": "x", "version": 1, "stage_labels": ["base", "final"], '
            '"sampler": {"seed": 999, "steps": 20}}'
        )
        preview_state = (
            '{"compare": {"enabled": true, "a": "base", "b": "final"}, '
            '"save": {"enabled": true, "which": "shown"}}'
        )
        prompt = {"1": {"class_type": "AnimaContextBridge", "inputs": {"seed": 999}}}
        result = node.preview(
            preview_state=[preview_state], images=images, metadata_json=[metadata_json],
            prompt=[prompt], extra_pnginfo=[None],
        )
        assert "anima_stages" in result["ui"]  # sanity: the normal contract is untouched

        recorded = fake_store.list_entries()
        assert len(recorded) == 2
        by_stage = {e["stage"]: e for e in recorded}
        # `save.which == "shown"` -> `final` (compare.b, present) is the
        # saved stage; `base` is only compared, so it lands in temp.
        assert by_stage["final"]["type"] == "output"
        assert by_stage["final"]["width"] == 2048 and by_stage["final"]["height"] == 2048
        assert by_stage["base"]["type"] == "temp"
        assert by_stage["base"]["width"] == 1024 and by_stage["base"]["height"] == 1024
        # The resolved seed reaches every entry from this run, as a string.
        assert by_stage["final"]["seed"] == "999"
        assert by_stage["base"]["seed"] == "999"
        # The generation-settings snapshot survived the round trip.
        assert by_stage["final"]["settings"]["sampler"]["steps"] == 20
        assert by_stage["final"]["settings"]["sampler"]["seed"] == "999"  # stringified, never a bare number
    finally:
        ph._HISTORY_STORE = original_store
        restore_writers()


def test_preview_never_raises_when_history_recording_itself_is_broken():
    """A history-recording failure must never be why a generation run
    errors (task brief) -- simulate a broken store (its own `record` raises)
    and confirm `preview()` still returns its normal `ui` payload."""
    restore_writers = _install_fake_writers()

    class _BrokenStore:
        def record(self, **kwargs):
            raise RuntimeError("simulated storage failure")

    original_store = ph._HISTORY_STORE
    ph._HISTORY_STORE = _BrokenStore()
    try:
        node = AnimaPreview()
        images = [_FakeImageTensor()]
        result = node.preview(
            preview_state=["{}"], images=images, metadata_json=[None], prompt=[None], extra_pnginfo=[None],
        )
        assert "anima_stages" in result["ui"]
    finally:
        ph._HISTORY_STORE = original_store
        restore_writers()


ALL_TESTS = [
    test_tensor_size_reads_width_height_from_shape,
    test_tensor_size_hostile_input_degrades_to_zero_zero,
    test_record_history_entries_records_one_per_entry,
    test_record_history_entries_never_raises_on_malformed_input,
    test_record_history_entries_defaults_to_the_real_singleton_when_no_store_is_injected,
    test_resolve_history_view_marks_a_missing_file_expired_a_present_one_not,
    test_resolve_history_view_checks_only_each_entrys_own_path_never_a_directory_scan,
    test_resolve_history_view_hostile_exists_fn_reports_expired_not_a_crash,
    test_resolve_history_view_empty_store_yields_empty_list,
    test_preview_records_history_entries_for_both_save_and_temp_paths,
    test_preview_never_raises_when_history_recording_itself_is_broken,
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
