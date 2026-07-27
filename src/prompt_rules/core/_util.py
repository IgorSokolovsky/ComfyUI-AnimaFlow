"""Small shared helpers used across the prompt-rules engine (`src/prompt_rules/core/`).

Kept tiny and dependency-free on purpose: every other module in `core/`
imports from here rather than duplicating text-splitting/normalisation
logic.
"""
from __future__ import annotations

import re
from typing import List, Optional, Union

StringList = Union[str, List[str], None]


def normalize_text(text: Optional[str]) -> str:
    """Fold whitespace and case for dedup/equality comparisons.

    Item text otherwise stays OPAQUE (see the v1 weight simplifications
    documented in `core/__init__.py`) -- this only affects *comparison*,
    never the stored/rendered text.
    """
    return re.sub(r"\s+", " ", (text or "")).strip().lower()


def split_values(text: Optional[str]) -> List[str]:
    """Split a raw string on commas/newlines into individual phrases,
    trimming whitespace and dropping empties.
    """
    return [t.strip() for t in re.split(r"[,\n]", text or "") if t.strip()]


def listify_phrases(value: StringList) -> List[str]:
    """Normalize a `string | string[]` phrase field into a flat phrase list.

    Used for Mutation/Removal/SetOp `value`/`to`, the `any_of`/`all_of`/
    `none_of` rule sugar, `swap.match`, and a raw (non-sugar) condition's
    `mentions` field: a plain string is comma/newline-split into multiple
    phrases (e.g. `"closed eyes, eyes out of frame"` -> two phrases); each
    element of an already-given list is *also* comma/newline-split (so
    `["a, b", "c"]` -> `["a", "b", "c"]`), since list elements aren't
    guaranteed to already be atomic.
    """
    if value is None:
        return []
    if isinstance(value, list):
        out: List[str] = []
        for v in value:
            out.extend(split_values(str(v)))
        return out
    return split_values(str(value))
