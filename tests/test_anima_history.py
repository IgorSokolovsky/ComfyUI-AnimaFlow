"""Plain-script tests for `src/anima/history.py` -- the generation-history
ring buffer (owner-requested feature). Every test constructs its OWN
`HistoryStore` instance rather than touching the process-wide `STORE`
singleton, so nothing here needs a reset step between tests.

Run directly: `python tests/test_anima_history.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima.history import MAX_HISTORY_ENTRIES, HistoryStore, STORE, reset_history_for_tests


def _record(store, **overrides):
    defaults = dict(
        stage="final", seed="12345", filename="final_000.png", subfolder="AnimaFlow",
        file_type="output", timestamp=1000.0, width=1024, height=1024, settings={"sampler": {"seed": "12345"}},
    )
    defaults.update(overrides)
    return store.record(**defaults)


def test_record_returns_the_stored_entry_shape():
    store = HistoryStore()
    entry = _record(store)
    assert entry["stage"] == "final"
    assert entry["seed"] == "12345"
    assert entry["filename"] == "final_000.png"
    assert entry["subfolder"] == "AnimaFlow"
    assert entry["type"] == "output"
    assert entry["timestamp"] == 1000.0
    assert entry["width"] == 1024
    assert entry["height"] == 1024
    assert entry["settings"] == {"sampler": {"seed": "12345"}}
    assert entry["id"] == 1


def test_list_entries_is_newest_first():
    store = HistoryStore()
    _record(store, stage="base", filename="a.png")
    _record(store, stage="mid", filename="b.png")
    _record(store, stage="final", filename="c.png")
    entries = store.list_entries()
    assert [e["filename"] for e in entries] == ["c.png", "b.png", "a.png"]
    # ids increase monotonically even though the list itself is newest-first.
    assert [e["id"] for e in entries] == [3, 2, 1]


def test_bounded_ring_evicts_the_oldest():
    store = HistoryStore(max_entries=3)
    for i in range(5):
        _record(store, filename=f"{i}.png")
    entries = store.list_entries()
    assert len(entries) == 3
    # Newest three survive (2, 3, 4); the oldest two (0, 1) were evicted.
    assert [e["filename"] for e in entries] == ["4.png", "3.png", "2.png"]


def test_module_constant_is_the_default_bound():
    store = HistoryStore()
    assert store._max_entries == MAX_HISTORY_ENTRIES  # noqa: SLF001 - white-box on purpose


def test_list_entries_returns_copies_not_live_references():
    store = HistoryStore()
    _record(store)
    entries = store.list_entries()
    entries[0]["filename"] = "tampered.png"
    entries2 = store.list_entries()
    assert entries2[0]["filename"] == "final_000.png"


def test_settings_dict_is_deep_copied_not_aliased():
    store = HistoryStore()
    settings = {"sampler": {"seed": "1"}}
    _record(store, settings=settings)
    settings["sampler"]["seed"] = "MUTATED"
    entries = store.list_entries()
    assert entries[0]["settings"]["sampler"]["seed"] == "1"


def test_hostile_fields_never_raise_and_degrade_safely():
    store = HistoryStore()
    entry = store.record(
        stage=None, seed=None, filename=None, subfolder=None, file_type="not-a-real-type",
        timestamp=None, width="garbage", height=object(), settings="not a dict either",
    )
    assert entry["stage"] == ""
    assert entry["seed"] == "0"
    assert entry["filename"] == ""
    assert entry["subfolder"] == ""
    assert entry["type"] == "temp"  # an unrecognised file_type degrades to the more conservative "temp"
    assert entry["width"] == 0
    assert entry["height"] == 0
    assert entry["settings"] == "not a dict either"


def test_clear_empties_the_store_and_resets_ids():
    store = HistoryStore()
    _record(store)
    _record(store)
    store.clear()
    assert store.list_entries() == []
    entry = _record(store)
    assert entry["id"] == 1


def test_reset_history_for_tests_clears_the_real_singleton():
    _record(STORE)
    assert len(STORE.list_entries()) >= 1
    reset_history_for_tests()
    assert STORE.list_entries() == []


ALL_TESTS = [
    test_record_returns_the_stored_entry_shape,
    test_list_entries_is_newest_first,
    test_bounded_ring_evicts_the_oldest,
    test_module_constant_is_the_default_bound,
    test_list_entries_returns_copies_not_live_references,
    test_settings_dict_is_deep_copied_not_aliased,
    test_hostile_fields_never_raise_and_degrade_safely,
    test_clear_empties_the_store_and_resets_ids,
    test_reset_history_for_tests_clears_the_real_singleton,
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
