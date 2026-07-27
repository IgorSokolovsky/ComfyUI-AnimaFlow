"""Selector-scoped text matching: `mentions` (word-boundary/substring,
case-optional) and `matches` (regex) -- SCHEMA.md SS4.

Both consider EVERY item in scope, including `enabled=False` (removed/tmp)
items: per SCHEMA.md SS4, "Removed/tmp items are still visible to
conditions" (they keep their text; only rendering drops them).

Design choice (documented, not just an interpretation gap): matching is
evaluated PER-ITEM (an Item's own `.text`), not across a comma-joined
haystack spanning multiple items. That avoids two adjacent-but-separate
items combining into a phrase ("... jacket, celica ...") that was never
actually authored as one tag/phrase.
"""
from __future__ import annotations

import re
from typing import Iterable

from .document import Block


def _word_boundary_pattern(phrase: str) -> str:
    return r"(?<!\w)" + re.escape(phrase) + r"(?!\w)"


def item_mentions(text: str, phrase: str, boundary: str = "word", case_sensitive: bool = False) -> bool:
    """Whether a single item's text mentions `phrase`."""
    if not phrase:
        return False
    hay = text if case_sensitive else text.lower()
    needle = phrase if case_sensitive else phrase.lower()
    if boundary == "substring":
        return needle in hay
    return re.search(_word_boundary_pattern(needle), hay) is not None


def mentions(scope: Iterable[Block], phrase: str, boundary: str = "word", case_sensitive: bool = False) -> bool:
    """Whether any item (enabled or disabled) in `scope` mentions `phrase`."""
    return any(
        item_mentions(item.text, phrase, boundary, case_sensitive)
        for block in scope
        for item in block.items
    )


def matches(scope: Iterable[Block], pattern: str, flags: str = "", case_sensitive: bool = True) -> bool:
    """Whether any item (enabled or disabled) in `scope` matches regex `pattern`.

    `case_sensitive` mirrors `options.caseSensitive`; the ruleset's own
    `flags: "i"` always forces case-insensitive regardless.
    """
    re_flags = 0
    if "i" in flags or not case_sensitive:
        re_flags |= re.IGNORECASE
    if "m" in flags:
        re_flags |= re.MULTILINE
    if "s" in flags:
        re_flags |= re.DOTALL
    compiled = re.compile(pattern, re_flags)
    return any(
        compiled.search(item.text) is not None
        for block in scope
        for item in block.items
    )
