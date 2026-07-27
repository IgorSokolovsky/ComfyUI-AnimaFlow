"""Plain-script tests for the autocomplete dataset loader's pure logic.

Run directly: `python tests/test_autocomplete_dataset.py` (no pytest, per project
convention).
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.autocomplete.dataset import (
    CATEGORY_NAMES,
    DANBOORU_CSV,
    GELBOORU_CSV,
    load_dataset,
    load_danbooru,
    load_gelbooru,
    normalize_tag_key,
    parse_rows,
)


def test_gelbooru_loads_non_trivial_entry_count():
    entries = load_gelbooru()
    assert len(entries) > 100_000, len(entries)
    assert all(e.source == "gelbooru" for e in entries[:100])


def test_danbooru_loads_non_trivial_entry_count():
    entries = load_danbooru()
    assert len(entries) > 100_000, len(entries)
    assert all(e.source == "danbooru" for e in entries[:100])


def test_category_parsing_produces_expected_category_set():
    expected = {"general", "artist", "copyright", "character", "meta"}
    assert set(CATEGORY_NAMES.values()) == expected

    entries = load_gelbooru()
    categories = {e.category for e in entries}
    # Every category the mapping knows about actually shows up in the data.
    assert expected.issubset(categories)


def test_known_tags_map_to_expected_categories():
    by_tag = {e.tag: e for e in load_gelbooru()}
    assert by_tag["1girl"].category == "general"
    assert by_tag["highres"].category == "meta"
    assert by_tag["hatsune_miku"].category == "character"
    assert by_tag["original"].category == "copyright"


def test_normalize_tag_key_unifies_spacing_and_case():
    assert normalize_tag_key("1girl") == "1girl"
    assert normalize_tag_key("1 Girl") == "1_girl"
    assert normalize_tag_key("  Long_Hair  ") == "long_hair"


def test_parse_rows_skips_blank_and_malformed_rows():
    rows = [
        ["1girl", "0", "9259271", ""],
        [],
        ["", "0", "5", ""],
        ["highres", "5", "8728981", ""],
        ["weird_count", "0", "not_a_number", ""],
    ]
    entries = parse_rows(rows, source="test")
    tags = [e.tag for e in entries]
    assert tags == ["1girl", "highres", "weird_count"]
    weird = entries[-1]
    assert weird.count == 0  # unparsable count falls back to 0, doesn't raise


def test_parse_rows_handles_unknown_category_code():
    rows = [["mystery_tag", "99", "1", ""]]
    entries = parse_rows(rows, source="test")
    assert entries[0].category == "general"  # unknown code -> safe fallback


def test_cache_invalidates_on_mtime_and_size_change(tmp_path=None):
    import tempfile

    with tempfile.TemporaryDirectory() as tmp_dir:
        path = os.path.join(tmp_dir, "fake.csv")
        with open(path, "w", encoding="utf-8") as f:
            f.write("tag_one,0,10,\n")

        first = load_dataset(path, source="fake")
        assert [e.tag for e in first] == ["tag_one"]

        # Cache hit: same mtime/size -> same list object served back.
        second = load_dataset(path, source="fake")
        assert second is first

        # Force a distinct mtime (some filesystems have coarse mtime
        # resolution) and change the size/content -> must invalidate.
        time.sleep(0.01)
        with open(path, "w", encoding="utf-8") as f:
            f.write("tag_one,0,10,\ntag_two,4,20,\n")
        os.utime(path, None)

        third = load_dataset(path, source="fake")
        assert [e.tag for e in third] == ["tag_one", "tag_two"]
        assert third is not first


def test_gelbooru_and_danbooru_csvs_are_bundled_files():
    assert GELBOORU_CSV.exists()
    assert DANBOORU_CSV.exists()


ALL_TESTS = [
    test_gelbooru_loads_non_trivial_entry_count,
    test_danbooru_loads_non_trivial_entry_count,
    test_category_parsing_produces_expected_category_set,
    test_known_tags_map_to_expected_categories,
    test_normalize_tag_key_unifies_spacing_and_case,
    test_parse_rows_skips_blank_and_malformed_rows,
    test_parse_rows_handles_unknown_category_code,
    test_cache_invalidates_on_mtime_and_size_change,
    test_gelbooru_and_danbooru_csvs_are_bundled_files,
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

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
