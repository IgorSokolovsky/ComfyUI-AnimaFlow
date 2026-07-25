"""Pure CSV load/parse for the two bundled autocomplete sources.

No ComfyUI imports here at all — this module is plain Python so it's
directly unit-testable (see `test_autocomplete_dataset.py`) and reusable
from both `index.py` (search) and `api.py` (the aiohttp route).

Both bundled CSVs (`data/gelbooru.csv` primary, `data/danbooru.csv`
fallback — see `data/SOURCES.md` for provenance) share the same no-header,
4-column shape: `tag,category_code,count,aliases`. `aliases` is often empty
and, when present, may itself contain commas — it arrives CSV-quoted in
that case, so a real `csv.reader` (not a manual `.split(",")`) is used to
parse rows correctly.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

DATA_DIR = Path(__file__).resolve().parent / "data"
GELBOORU_CSV = DATA_DIR / "gelbooru.csv"
DANBOORU_CSV = DATA_DIR / "danbooru.csv"

# Category codes shared by both bundled CSVs. Verified directly against
# sample rows in each file (see data/SOURCES.md) rather than assumed:
#   general:   1girl,0,...          highres,5,...        -> meta
#   artist:    dairi,1,...          yanderenohako_(artist),1,...
#   copyright: original,3,...       touhou,3,...
#   character: hatsune_miku,4,...   hakurei_reimu,4,...
# Both files come from the same DraconicDragon/dbr-e621-lists-archive
# tag-list family and agree on this mapping, so one table serves both.
CATEGORY_NAMES = {
    "0": "general",
    "1": "artist",
    "3": "copyright",
    "4": "character",
    "5": "meta",
}


@dataclass(frozen=True)
class AutocompleteEntry:
    """One tag row from either dataset.

    `tag` is the original casing/spelling from the CSV; `tag_key` is the
    normalized form (`normalize_tag_key`) used for matching/dedupe so
    `"1girl"` and `"1_Girl"` key the same regardless of source formatting.
    """

    tag: str
    tag_key: str
    category: str
    count: int
    source: str


def normalize_tag_key(tag: str) -> str:
    """Lowercase + spaces->underscores so free-text queries (prose models
    may type `1 girl`) key the same as the booru-underscore convention the
    CSVs use (`1girl`/`long_hair`). Deliberately NOT comma-splitting or
    otherwise assuming booru-only formatting here (a single tag never
    contains a separator) — this repo's separator-agnostic rule is about
    joining multiple tags/fields, not about a single tag's own spelling.
    """
    return str(tag or "").strip().lower().replace(" ", "_")


def _parse_row(row: list, source: str) -> Optional[AutocompleteEntry]:
    if not row:
        return None
    tag = (row[0] or "").strip()
    if not tag:
        return None
    category_code = (row[1] if len(row) > 1 else "").strip()
    category = CATEGORY_NAMES.get(category_code, "general")
    count_raw = (row[2] if len(row) > 2 else "").strip()
    try:
        count = int(count_raw) if count_raw else 0
    except ValueError:
        count = 0
    return AutocompleteEntry(
        tag=tag,
        tag_key=normalize_tag_key(tag),
        category=category,
        count=count,
        source=source,
    )


def parse_rows(rows: Iterable[list], source: str) -> list:
    """Pure: `rows` is an iterable of already-split column lists (what
    `csv.reader` yields) -> list of `AutocompleteEntry`. Blank/malformed
    rows are skipped rather than raising, matching CSV data that's meant to
    be resilient to a stray blank line.
    """
    entries = []
    for row in rows:
        entry = _parse_row(row, source)
        if entry is not None:
            entries.append(entry)
    return entries


# Cache key: (mtime_ns, size) per path — the classic cheap-invalidation
# stat pair. A changed/replaced CSV (new mtime or size) auto-invalidates on
# the next `load_dataset` call without a process restart.
_CACHE: dict = {}


def _stat_key(path: Path):
    st = path.stat()
    return (st.st_mtime_ns, st.st_size)


def load_dataset(path, source: str) -> list:
    """Load+parse a bundled CSV, cached by `(path, mtime_ns, size)`."""
    path = Path(path)
    mtime_ns, size = _stat_key(path)
    cache_key = str(path)
    cached = _CACHE.get(cache_key)
    if cached is not None and cached[0] == mtime_ns and cached[1] == size:
        return cached[2]

    with path.open("r", encoding="utf-8", newline="") as f:
        entries = parse_rows(csv.reader(f), source)

    _CACHE[cache_key] = (mtime_ns, size, entries)
    return entries


def load_gelbooru(path=GELBOORU_CSV) -> list:
    """The primary autocomplete source."""
    return load_dataset(path, source="gelbooru")


def load_danbooru(path=DANBOORU_CSV) -> list:
    """The fallback autocomplete source (used to top up results gelbooru
    alone doesn't have enough of; see `index.search`).
    """
    return load_dataset(path, source="danbooru")
