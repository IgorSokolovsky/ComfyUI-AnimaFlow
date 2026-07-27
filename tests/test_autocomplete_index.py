"""Plain-script tests for the autocomplete search tiering/dedupe logic.

Run directly: `python tests/test_autocomplete_index.py` (no pytest, per project
convention). Uses small in-memory fixture datasets (not the full bundled
CSVs) so the gelbooru-first/danbooru-fallback tiering is fast and
deterministic.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.autocomplete.dataset import AutocompleteEntry
from src.autocomplete.index import search


def entry(tag, category="general", count=0, source="gelbooru"):
    from src.autocomplete.dataset import normalize_tag_key

    return AutocompleteEntry(tag=tag, tag_key=normalize_tag_key(tag), category=category, count=count, source=source)


GELBOORU_FIXTURE = [
    entry("1girl", count=9_000_000, source="gelbooru"),
    entry("1girl_only", count=10, source="gelbooru"),
    entry("1girls", count=5, source="gelbooru"),
    entry("hatsune_miku", category="character", count=100_000, source="gelbooru"),
]

DANBOORU_FIXTURE = [
    entry("1girl", count=6_000_000, source="danbooru"),  # duplicate of gelbooru's "1girl"
    entry("1girl_variant", count=2_000, source="danbooru"),
    entry("1girl_rare", count=50, source="danbooru"),
    entry("solo", count=1_000_000, source="danbooru"),
]


def test_exact_match_ranks_first():
    results = search("1girl", limit=10, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    assert results[0].tag == "1girl"
    assert results[0].source == "gelbooru"  # gelbooru's copy wins the dedupe


def test_prefix_search_matches_and_ranks_by_count():
    results = search("1girl_", limit=10, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    tags = [r.tag for r in results]
    assert "1girl_only" in tags
    assert "1girls" not in tags  # "1girls" doesn't start with "1girl_"


def test_substring_search_matches_mid_word():
    results = search("miku", limit=10, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    assert any(r.tag == "hatsune_miku" for r in results)


def test_gelbooru_alone_satisfies_limit_without_danbooru():
    # Query matches 4 gelbooru entries and only 1 shared/duplicate danbooru
    # entry ("1girl") -- asking for fewer results than gelbooru alone has
    # must not need danbooru at all.
    results = search("1girl", limit=2, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    assert len(results) == 2
    assert all(r.source == "gelbooru" for r in results)


def test_danbooru_tops_up_when_gelbooru_is_short():
    # "1girl" prefix matches only 3 gelbooru entries (1girl, 1girl_only,
    # 1girls) but we ask for 6 -- danbooru must top up the remainder.
    results = search("1girl", limit=6, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    sources = {r.source for r in results}
    assert "danbooru" in sources
    tags = [r.tag for r in results]
    assert "1girl_variant" in tags or "1girl_rare" in tags


def test_dedupe_by_tag_key_across_sources():
    results = search("1girl", limit=20, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    tag_keys = [r.tag_key for r in results]
    assert len(tag_keys) == len(set(tag_keys))  # no tag_key repeated
    # The duplicated "1girl" tag appears exactly once, sourced from gelbooru.
    matches = [r for r in results if r.tag_key == "1girl"]
    assert len(matches) == 1
    assert matches[0].source == "gelbooru"


def test_category_filter_restricts_results():
    results = search(
        "",
        limit=10,
        category="character",
        gelbooru_entries=GELBOORU_FIXTURE,
        danbooru_entries=DANBOORU_FIXTURE,
    )
    assert all(r.category == "character" for r in results)
    assert any(r.tag == "hatsune_miku" for r in results)


def test_limit_is_clamped_between_one_and_fifty():
    results = search("1girl", limit=1000, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    assert len(results) <= 50
    results_zero = search("1girl", limit=0, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    assert len(results_zero) == 1


def test_no_match_returns_empty_list():
    results = search("zzz_no_such_tag_zzz", limit=10, gelbooru_entries=GELBOORU_FIXTURE, danbooru_entries=DANBOORU_FIXTURE)
    assert results == []


ALL_TESTS = [
    test_exact_match_ranks_first,
    test_prefix_search_matches_and_ranks_by_count,
    test_substring_search_matches_mid_word,
    test_gelbooru_alone_satisfies_limit_without_danbooru,
    test_danbooru_tops_up_when_gelbooru_is_short,
    test_dedupe_by_tag_key_across_sources,
    test_category_filter_restricts_results,
    test_limit_is_clamped_between_one_and_fifty,
    test_no_match_returns_empty_list,
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
