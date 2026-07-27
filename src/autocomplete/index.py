"""Pure tag search: Gelbooru-primary / Danbooru-fallback tiered lookup.

No ComfyUI imports here either (see `dataset.py`'s header) — `api.py`'s
aiohttp handler is the only consumer that needs a live ComfyUI process.

Ranking is a simple top-k scan (three match tiers, `heapq.nsmallest` keyed
by `(tier, -count, tag)`): no SQLite/inverted index for v1 — both bundled
CSVs combined are ~300k-400k rows, which a linear scan handles fast enough
for an interactive autocomplete popup.
"""

from __future__ import annotations

import heapq
from typing import Iterable, Optional

from .dataset import AutocompleteEntry, load_danbooru, load_gelbooru, normalize_tag_key

# Cache for `exact_lookup`'s dict-backed index, keyed by the `id()` pair of
# whatever gelbooru/danbooru entry lists last built it. `load_gelbooru`/
# `load_danbooru` return the SAME cached list object while their backing CSV
# is unchanged (see `dataset.py`'s own `_CACHE`), so this naturally
# invalidates itself the moment either source reloads -- no separate stat
# check needed here.
_EXACT_CACHE: dict = {}


def _exact_index(gelbooru_entries, danbooru_entries) -> dict:
    cache_key = (id(gelbooru_entries), id(danbooru_entries))
    cached = _EXACT_CACHE.get("default")
    if cached is not None and cached[0] == cache_key:
        return cached[1]
    merged = {}
    # Danbooru first, Gelbooru second (and therefore overwriting on a
    # tag_key collision) -- matches `search()`'s "Gelbooru's copy wins" rule.
    for entry in danbooru_entries:
        merged[entry.tag_key] = entry
    for entry in gelbooru_entries:
        merged[entry.tag_key] = entry
    _EXACT_CACHE["default"] = (cache_key, merged)
    return merged


def exact_lookup(
    tag: str,
    gelbooru_entries: Optional[Iterable[AutocompleteEntry]] = None,
    danbooru_entries: Optional[Iterable[AutocompleteEntry]] = None,
) -> Optional[AutocompleteEntry]:
    """O(1) exact `tag_key` lookup (as opposed to `search()`'s prefix/
    substring scan) -- e.g. for `/wtn/classify`, which needs to know whether
    ONE specific tag is a known DB entry, not to rank candidates for it.

    `gelbooru_entries`/`danbooru_entries` let callers (mainly tests) inject a
    fixture dataset, same convention as `search()`.
    """
    key = normalize_tag_key(tag)
    if not key:
        return None
    gelbooru = list(gelbooru_entries) if gelbooru_entries is not None else load_gelbooru()
    danbooru = list(danbooru_entries) if danbooru_entries is not None else load_danbooru()
    return _exact_index(gelbooru, danbooru).get(key)


# Lower number = better match.
_TIER_EXACT = 0
_TIER_PREFIX = 1
_TIER_SUBSTRING = 2


def _match_tier(entry: AutocompleteEntry, query_key: str) -> Optional[int]:
    if not query_key:
        # Empty query -> everything matches at the loosest tier so results
        # still rank purely by popularity (`count`).
        return _TIER_SUBSTRING
    if entry.tag_key == query_key:
        return _TIER_EXACT
    if entry.tag_key.startswith(query_key):
        return _TIER_PREFIX
    if query_key in entry.tag_key:
        return _TIER_SUBSTRING
    return None


def _filter_category(entries: Iterable[AutocompleteEntry], category: Optional[str]) -> Iterable[AutocompleteEntry]:
    if not category:
        return entries
    return [e for e in entries if e.category == category]


def _rank(entries: Iterable[AutocompleteEntry], query_key: str, limit: int) -> list:
    """Top-`limit` entries matching `query_key`, best tier then highest
    `count` then alphabetical (for deterministic ordering on ties).
    """
    scored = []
    for entry in entries:
        tier = _match_tier(entry, query_key)
        if tier is None:
            continue
        scored.append(((tier, -entry.count, entry.tag), entry))
    top = heapq.nsmallest(max(limit, 0), scored, key=lambda pair: pair[0])
    return [entry for _, entry in top]


def search(
    query: str,
    limit: int = 20,
    category: Optional[str] = None,
    gelbooru_entries: Optional[Iterable[AutocompleteEntry]] = None,
    danbooru_entries: Optional[Iterable[AutocompleteEntry]] = None,
) -> list:
    """Gelbooru-primary / Danbooru-fallback tiered tag search.

    Match tiers (best first): exact `tag_key` match, then prefix, then
    substring; within a tier, higher `count` (popularity) wins. Gelbooru is
    queried first; only if it returns FEWER than `limit` matches is the
    remainder topped up from Danbooru, de-duplicated by `tag_key` so a tag
    present in both sources is never returned twice (Gelbooru's copy wins).

    `gelbooru_entries`/`danbooru_entries` let callers (mainly tests) inject
    a small in-memory fixture dataset instead of loading the full bundled
    CSVs, so search-tiering tests stay fast and deterministic.
    """
    if limit is None:
        limit = 20
    limit = max(1, min(int(limit), 50))
    query_key = normalize_tag_key(query)

    gelbooru = list(gelbooru_entries) if gelbooru_entries is not None else load_gelbooru()
    gelbooru = _filter_category(gelbooru, category)
    gelbooru_ranked = _rank(gelbooru, query_key, limit)

    results = list(gelbooru_ranked)
    seen_keys = {e.tag_key for e in results}

    remaining = limit - len(results)
    if remaining > 0:
        danbooru = list(danbooru_entries) if danbooru_entries is not None else load_danbooru()
        danbooru = _filter_category(danbooru, category)
        # Over-fetch by the number of gelbooru hits we might have to skip as
        # duplicates, so we don't come up short after dedup.
        danbooru_ranked = _rank(danbooru, query_key, remaining + len(seen_keys))
        for entry in danbooru_ranked:
            if entry.tag_key in seen_keys:
                continue
            results.append(entry)
            seen_keys.add(entry.tag_key)
            if len(results) >= limit:
                break

    return results[:limit]
