"""Per-token prompt classification, for the `/wtn/classify` tag-highlighting
route (`api.py`'s `classify_impl`).

Ported (MIT © n0va39, see `../THIRD_PARTY_NOTICES.md`) from
`ComfyUI-EasyUseAnima`:
  - `autocomplete_dataset.py`'s `classify_prompt_text()` / `_token_section()`
    and their helpers (`_token_base`, `_normalize`, `_is_artist_request`,
    `_is_weighted_token`, `_classification_tokens_from_chunk` and its
    dependency chain, `_COMMENT_RE`, `_WILDCARD_TOKEN_RE`,
    `_DYNAMIC_PROMPT_TOKEN_RE`, `_COUNT_RE`).
  - `anima_prompt/ordering.py`'s builtin ANIMA vocab (`QUALITY_TAGS`,
    `META_TAGS`, `YEAR_TAGS`, `SAFETY_TAGS`, `ANIMA_PERSON_COUNT_TAGS`,
    `YEAR_TAG_PATTERN`) and its `builtin_tag_section()` matching approach
    (`lookup_key`/`normalize_tag` from `anima_prompt/normalize.py`, ported
    here as `_builtin_lookup_key`/`_builtin_key`).

Upstream's labels are Korean; this port's labels are English (see
`SECTION_LABELS` below) and upstream never returns character offsets at all
(the frontend had to re-derive token positions itself). This port's whole
reason for existing is to fix that: every classified token below carries an
exact `start`/`end` character offset into the CALLER'S ORIGINAL string, so
the frontend can paint highlights directly without re-tokenizing.

Getting those offsets right is the one hard part upstream didn't have to
solve, because upstream normalizes destructively before tokenizing
(`\r\n` -> `\n`, full-width `，` -> `,`, `\n` -> `,`) which shifts every
position after the first substitution. This module never rewrites the input
string at all: comments, wildcards/dynamic-prompt/translation markers,
parenthesised (weight) groups and plain comma/newline-separated tags are all
located by scanning the ORIGINAL text and recording `(start, end)` spans into
it directly. `\r`, `\n` and the full-width comma `，` are simply added to the
same "top-level delimiter" character set as `,` (each is single-character, so
`\r\n` naturally becomes two adjacent delimiters with an empty -- and
therefore dropped -- token between them; no substitution needed). The result
is that `text[start:end] == token["text"]` holds for every token, for any
input, including CJK/emoji (offsets are Python string/codepoint indices).

Deliberately NOT ported: upstream's `[[artist1, artist2]]` "artist mix group"
syntax and `_has_invalid_weight_syntax`'s narrower "bad weight number" syntax
case -- neither appears in this route's contract (see the module docstring
of `api.py`'s classify handler / the 16-section table it implements), so
supporting them here would be undocumented, untested surface area. A
`(tag:notanumber)` group simply falls through to being classified as a
single literal token instead of `syntax`.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Callable, Optional

from .dataset import AutocompleteEntry, normalize_tag_key

# ---------------------------------------------------------------------------
# ANIMA builtin vocab -- ported as-is from `anima_prompt/ordering.py`.
# ---------------------------------------------------------------------------

QUALITY_TAGS = frozenset(
    {
        "masterpiece",
        "best quality",
        "great quality",
        "good quality",
        "high quality",
        "normal quality",
        "average quality",
        "low quality",
        "bad quality",
        "worst quality",
        "high score",
        "great score",
        "good score",
        "average score",
        "bad score",
        "low score",
        "score_9",
        "score_8",
        "score_7",
        "score_7:",
        "score_6",
        "score_5",
        "score_4",
        "very aesthetic",
        "aesthetic",
        "displeasing",
        "very displeasing",
    }
)
META_TAGS = frozenset(
    {
        "highres",
        "absurdres",
        "lowres",
        "official art",
        "scan",
        "source anime",
        "source pony",
        "source furry",
        "source cartoon",
    }
)
YEAR_TAGS = frozenset(
    {
        "oldest",
        "old",
        "early",
        "mid",
        "recent",
        "newest",
    }
)
SAFETY_TAGS = frozenset(
    {
        "safe",
        "sensitive",
        "nsfw",
        "questionable",
        "explicit",
        "rating safe",
        "rating questionable",
        "rating explicit",
    }
)
YEAR_TAG_PATTERN = re.compile(r"^year\s+\d+$")

ANIMA_PERSON_COUNT_TAGS = frozenset(
    {
        "solo",
        "no humans",
        "multiple boys",
        "multiple girls",
        "multiple others",
        "1boy",
        "2boys",
        "3boys",
        "4boys",
        "5boys",
        "6+boys",
        "1girl",
        "2girls",
        "3girls",
        "4girls",
        "5girls",
        "6+girls",
        "1other",
        "2others",
        "3others",
        "4others",
        "5others",
        "6+others",
    }
)

_BUILTIN_SECTIONS = {
    **{tag: "quality" for tag in QUALITY_TAGS},
    **{tag: "meta" for tag in META_TAGS},
    **{tag: "year" for tag in YEAR_TAGS},
    **{tag: "safety" for tag in SAFETY_TAGS},
    **{tag: "count" for tag in ANIMA_PERSON_COUNT_TAGS},
}

# English labels for every one of the 16 sections `/wtn/classify` can return.
SECTION_LABELS = {
    "quality": "Quality",
    "safety": "Rating",
    "year": "Year",
    "count": "Count",
    "character": "Character",
    "artist": "Artist",
    "artist_unknown": "Unregistered artist",
    "copyright": "Copyright",
    "meta": "Meta",
    "general": "Trained tag",
    "natural": "Natural language",
    "translation": "Translation marker",
    "wildcard": "Wildcard",
    "comment": "Comment",
    "syntax": "Syntax error",
    "unknown": "Unknown",
}

# entry.category (from `dataset.CATEGORY_NAMES`) -> (section, label), for the
# generic "DB category" precedence step (ported from upstream's per-category
# label table in `_token_section`).
_DB_CATEGORY_SECTIONS = {
    "quality": ("quality", SECTION_LABELS["quality"]),
    "character": ("character", SECTION_LABELS["character"]),
    "artist": ("artist", SECTION_LABELS["artist"]),
    "copyright": ("copyright", SECTION_LABELS["copyright"]),
    "meta": ("meta", SECTION_LABELS["meta"]),
    "general": ("general", SECTION_LABELS["general"]),
}


# ---------------------------------------------------------------------------
# Regexes -- ported as-is from `autocomplete_dataset.py`.
# ---------------------------------------------------------------------------

_COUNT_RE = re.compile(
    r"^\d+\s*(girl|girls|boy|boys|person|people|other|others|animal|animals|"
    r"female|females|male|males|child|children)s?$",
    re.IGNORECASE,
)

_WEIGHT_NUMBER_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")

_WEIGHTED_TOKEN_RE = re.compile(r"^\((.*):[+-]?(?:\d+(?:\.\d*)?|\.\d+)\)$")

_WILDCARD_TOKEN_RE = re.compile(r"^(?:\d+#)?__[\w.\-+/*\\]+__$", re.IGNORECASE)

_WILDCARD_SYNTAX_RE = re.compile(r"(?:\d+#)?__[\w.\-+/*\\]+?__", re.IGNORECASE)

_DYNAMIC_PROMPT_TOKEN_RE = re.compile(r"^(?<!\\)\{(?:[^{}]|(?<=\\)[{}])*?(?<!\\)\}$")

_DYNAMIC_PROMPT_SYNTAX_RE = re.compile(r"(?<!\\)\{(?:[^{}]|(?<=\\)[{}])*?(?<!\\)\}")

_COMMENT_RE = re.compile(r"^[ \t]*#[^\n]*", re.MULTILINE)

_INLINE_SPACE_RE = re.compile(r"\s+")

_PONY_SCORE_RE = re.compile(r"^score[\s_]+(\d+)(:?)$", re.IGNORECASE)

# Top-level "this ends a tag" delimiter set: plain comma plus the newline
# variants and full-width comma upstream destructively normalizes to `,`
# before tokenizing. Each is a single character, so `\r\n` is simply two
# adjacent delimiters (the empty token between them is dropped) -- no string
# rewriting needed to support it.
_DELIM_CHARS = ",\n\r，"


# ---------------------------------------------------------------------------
# Escape-aware paren/weight helpers -- ported from `autocomplete_dataset.py`.
# ---------------------------------------------------------------------------


def _is_escaped(value: str, index: int) -> bool:
    count = 0
    cursor = index - 1
    while cursor >= 0 and value[cursor] == "\\":
        count += 1
        cursor -= 1
    return count % 2 == 1


def _has_unbalanced_parentheses(token: str) -> bool:
    depth = 0
    for index, char in enumerate(token):
        if char == "(" and not _is_escaped(token, index):
            depth += 1
        elif char == ")" and not _is_escaped(token, index):
            if depth <= 0:
                return True
            depth -= 1
    return depth != 0


def _top_level_colon(value: str) -> int:
    depth = 0
    colon = -1
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "(":
            depth += 1
            continue
        if char == ")" and depth > 0:
            depth -= 1
            continue
        if char == ":" and depth == 0:
            colon = index
    return colon


def _is_plain_parenthesized_group(token: str) -> bool:
    """True if `token` is a `(...)` group with no top-level `:weight` -- i.e.
    a plain (unweighted) grouping like `(masterpiece, best quality)` that
    should be unwrapped and its contents comma-split, rather than kept as one
    literal token.
    """
    text = token.strip()
    if not (text.startswith("(") and text.endswith(")")):
        return False
    inner = text[1:-1].strip(" ,\n\t")
    if not inner:
        return False
    return _top_level_colon(inner) < 0


# ---------------------------------------------------------------------------
# Token-text helpers -- ported as-is from `autocomplete_dataset.py`.
# ---------------------------------------------------------------------------


def _token_base(token: str) -> str:
    token = str(token or "").strip()
    weighted = _WEIGHTED_TOKEN_RE.match(token)
    if weighted:
        token = weighted.group(1).strip(" ,\n\t")
    token = token.rstrip(":").strip()
    token = re.sub(r"\\(.)", r"\1", token)
    if token.startswith("@"):
        return token[1:].strip()
    return token


def _is_artist_request(token: str) -> bool:
    token = str(token or "").strip()
    if token.startswith("@"):
        return True
    weighted = _WEIGHTED_TOKEN_RE.match(token)
    return bool(weighted and weighted.group(1).strip().startswith("@"))


def _is_weighted_token(token: str) -> bool:
    return bool(_WEIGHTED_TOKEN_RE.match(str(token or "").strip()))


def _normalize(value: str) -> str:
    """Ported as-is from `autocomplete_dataset.py`'s `_normalize` -- used
    ONLY for the `_COUNT_RE` match (matches upstream exactly); NOT the same
    key this module uses for our own DB lookup (that's `normalize_tag_key`,
    from `dataset.py`, which uses underscores rather than spaces to match
    this pack's CSV convention).
    """
    value = unicodedata.normalize("NFKC", str(value or ""))
    value = re.sub(r"\\(.)", r"\1", value)
    value = value.replace("_", " ").casefold()
    value = _INLINE_SPACE_RE.sub(" ", value)
    return value.strip()


def _normalize_pony_score(text: str) -> Optional[str]:
    match = _PONY_SCORE_RE.match(text.strip())
    if not match:
        return None
    return f"score_{match.group(1)}{match.group(2)}"


def _builtin_key(tag: str) -> str:
    """Ported from `anima_prompt/normalize.py`'s `normalize_tag` -- the key
    space `QUALITY_TAGS`/`META_TAGS`/etc. above are written in (spaces, not
    underscores; `score_9` kept intact via the pony-score special case).
    """
    text = str(tag or "").strip().lower()
    text = _INLINE_SPACE_RE.sub(" ", text)
    pony = _normalize_pony_score(text)
    if pony:
        return pony
    text = text.replace("_", " ")
    if text.startswith("@"):
        text = "@" + text[1:].strip()
    return text


def _builtin_lookup_key(tag: str) -> str:
    """Ported from `anima_prompt/normalize.py`'s `lookup_key`."""
    key = _builtin_key(tag)
    return key[1:].strip() if key.startswith("@") else key


def _builtin_tag_section(base: str) -> Optional[str]:
    """Ported from `anima_prompt/ordering.py`'s `builtin_tag_section`."""
    key = _builtin_lookup_key(base)
    if key in _BUILTIN_SECTIONS:
        return _BUILTIN_SECTIONS[key]
    if YEAR_TAG_PATTERN.match(key):
        return "year"
    return None


# ---------------------------------------------------------------------------
# Span-tracking tokenizer. Everything below scans the ORIGINAL text and
# records (start, end) offsets into it directly -- nothing is ever
# normalized/rewritten, so offsets are exact by construction.
# ---------------------------------------------------------------------------


def _strip_span(text: str, start: int, end: int, chars: str = " \t\r\n,") -> tuple[int, int]:
    while start < end and text[start] in chars:
        start += 1
    while end > start and text[end - 1] in chars:
        end -= 1
    return start, end


def _split_top_level_plain(text: str, start: int, end: int) -> list[tuple[int, int]]:
    """Split `text[start:end]` at depth-0 occurrences of `_DELIM_CHARS`,
    tracking `(`/`)` nesting (escape-aware) exactly like upstream's
    `parse_prompt`/`_split_prompt_tokens` -- commas etc. inside an unescaped
    parenthesised group stay in the same span.
    """
    spans = []
    depth = 0
    piece_start = start
    index = start
    while index < end:
        char = text[index]
        if char == "(" and not _is_escaped(text, index):
            depth += 1
        elif char == ")" and not _is_escaped(text, index):
            depth = max(0, depth - 1)
        elif depth == 0 and char in _DELIM_CHARS:
            spans.append((piece_start, index))
            piece_start = index + 1
        index += 1
    spans.append((piece_start, end))
    return spans


def _find_translation_marker(text: str, start: int, end: int) -> Optional[tuple[int, int]]:
    """Bounded, escape-aware port of `iter_prompt_translation_markers`
    (`%{...}`), stopping at `end` without ever slicing `text` (so lookbehind/
    escape checks still see the real characters before `start`).
    """
    cursor = start
    while cursor < end:
        idx = text.find("%{", cursor, end)
        if idx < 0:
            return None
        if _is_escaped(text, idx):
            cursor = idx + 2
            continue
        scan = idx + 2
        close = -1
        while scan < end:
            if text[scan] == "}" and not _is_escaped(text, scan):
                close = scan + 1
                break
            scan += 1
        if close < 0:
            return None
        return idx, close
    return None


def _find_atomic_span(text: str, start: int, end: int) -> Optional[tuple[int, int]]:
    """Earliest of a translation marker / dynamic-prompt `{...}` / wildcard
    `__..__` occurrence in `text[start:end]`, or `None`. Ported from
    upstream's `_next_prompt_syntax_range` (minus the `[[artist mix]]`
    branch -- see module docstring).
    """
    candidates = []
    marker = _find_translation_marker(text, start, end)
    if marker is not None:
        candidates.append(marker)
    dynamic = _DYNAMIC_PROMPT_SYNTAX_RE.search(text, start, end)
    if dynamic:
        candidates.append((dynamic.start(), dynamic.end()))
    wildcard = _WILDCARD_SYNTAX_RE.search(text, start, end)
    if wildcard:
        candidates.append((wildcard.start(), wildcard.end()))
    if not candidates:
        return None
    return min(candidates, key=lambda pair: pair[0])


def _iter_regions(text: str, start: int, end: int):
    cursor = start
    while cursor < end:
        atomic = _find_atomic_span(text, cursor, end)
        if atomic is None:
            yield "plain", cursor, end
            return
        atomic_start, atomic_end = atomic
        if atomic_start > cursor:
            yield "plain", cursor, atomic_start
        yield "atomic", atomic_start, atomic_end
        cursor = atomic_end


# ---------------------------------------------------------------------------
# Classification (`_token_section` port) + final-token assembly.
# ---------------------------------------------------------------------------

EntryLookup = Callable[[str], Optional[AutocompleteEntry]]


def _token_section(raw: str, base: str, entry: Optional[AutocompleteEntry]) -> tuple[str, str]:
    """Ported from `autocomplete_dataset.py`'s `_token_section`, with
    English labels. Precedence: translation -> wildcard -> count ->
    artist(@) -> builtin section -> DB category -> natural -> unknown.
    """
    marker = raw.strip()
    if marker.startswith("%{") and marker.endswith("}"):
        return "translation", SECTION_LABELS["translation"]

    is_artist_request = _is_artist_request(raw)
    if _WILDCARD_TOKEN_RE.match(base) or _DYNAMIC_PROMPT_TOKEN_RE.match(base):
        return "wildcard", SECTION_LABELS["wildcard"]
    if _COUNT_RE.match(_normalize(base)):
        return "count", SECTION_LABELS["count"]
    if is_artist_request:
        if entry is not None:
            return "artist", SECTION_LABELS["artist"]
        return "artist_unknown", SECTION_LABELS["artist_unknown"]

    builtin_section = _builtin_tag_section(base)
    if builtin_section is not None:
        return builtin_section, SECTION_LABELS[builtin_section]

    if entry is not None:
        return _DB_CATEGORY_SECTIONS.get(
            entry.category, (entry.category or "unknown", entry.category or SECTION_LABELS["unknown"])
        )

    if len(base) >= 32 or re.search(r"[.!?]", base):
        return "natural", SECTION_LABELS["natural"]

    return "unknown", SECTION_LABELS["unknown"]


def _default_entry_lookup(tag: str) -> Optional[AutocompleteEntry]:
    from .index import exact_lookup

    return exact_lookup(tag)


def _classify_final(
    text: str,
    start: int,
    end: int,
    entry_lookup: EntryLookup,
    weighted_override: bool = False,
) -> Optional[dict]:
    raw = text[start:end]
    if not raw:
        return None
    base = _token_base(raw)
    entry = entry_lookup(base) if base else None
    weighted = weighted_override or _is_weighted_token(raw)
    section, label = _token_section(raw, base, entry)
    return {
        "start": start,
        "end": end,
        "text": raw,
        "base": base,
        "section": section,
        "label": label,
        "known": entry is not None,
        "weighted": weighted,
        "count": entry.count if entry is not None else 0,
    }


def _syntax_token(text: str, start: int, end: int) -> dict:
    raw = text[start:end]
    return {
        "start": start,
        "end": end,
        "text": raw,
        "base": raw,
        "section": "syntax",
        "label": SECTION_LABELS["syntax"],
        "known": False,
        "weighted": False,
        "count": 0,
    }


def _comment_token(text: str, start: int, end: int) -> dict:
    raw = text[start:end]
    return {
        "start": start,
        "end": end,
        "text": raw,
        "base": raw.strip(),
        "section": "comment",
        "label": SECTION_LABELS["comment"],
        "known": False,
        "weighted": False,
        "count": 0,
    }


def _split_and_classify_group(text: str, start: int, end: int, entry_lookup: EntryLookup) -> list[dict]:
    """One depth-0-split "group" (already comma/newline-delimited from its
    neighbours) -> one or more final tokens. Ported from upstream's
    `_classification_tokens`: unbalanced parens is `syntax`; a
    `(tag:weight)` group unwraps to its (possibly comma-split) contents,
    each marked `weighted`; a plain `(a, b)` group unwraps to its
    comma-split contents unweighted; anything else is a single literal
    token.
    """
    raw = text[start:end]
    if not raw:
        return []
    if _has_unbalanced_parentheses(raw):
        return [_syntax_token(text, start, end)]

    weighted_match = _WEIGHTED_TOKEN_RE.match(raw)
    if weighted_match:
        inner_start = start + weighted_match.start(1)
        inner_end = start + weighted_match.end(1)
        inner_start, inner_end = _strip_span(text, inner_start, inner_end)
        results = []
        for group_start, group_end in _split_top_level_plain(text, inner_start, inner_end):
            group_start, group_end = _strip_span(text, group_start, group_end)
            if group_start >= group_end:
                continue
            token = _classify_final(text, group_start, group_end, entry_lookup, weighted_override=True)
            if token:
                results.append(token)
        return results

    if _is_plain_parenthesized_group(raw):
        inner_start, inner_end = _strip_span(text, start + 1, end - 1)
        results = []
        for group_start, group_end in _split_top_level_plain(text, inner_start, inner_end):
            group_start, group_end = _strip_span(text, group_start, group_end)
            if group_start >= group_end:
                continue
            token = _classify_final(text, group_start, group_end, entry_lookup, weighted_override=False)
            if token:
                results.append(token)
        return results

    token = _classify_final(text, start, end, entry_lookup, weighted_override=False)
    return [token] if token else []


def _tokenize_plain_region(text: str, start: int, end: int, entry_lookup: EntryLookup) -> list[dict]:
    tokens: list[dict] = []
    for kind, region_start, region_end in _iter_regions(text, start, end):
        if kind == "atomic":
            span_start, span_end = _strip_span(text, region_start, region_end)
            token = _classify_final(text, span_start, span_end, entry_lookup)
            if token:
                tokens.append(token)
            continue
        for group_start, group_end in _split_top_level_plain(text, region_start, region_end):
            group_start, group_end = _strip_span(text, group_start, group_end)
            if group_start >= group_end:
                continue
            tokens.extend(_split_and_classify_group(text, group_start, group_end, entry_lookup))
    return tokens


DEFAULT_LIMIT = 500
MIN_LIMIT = 1
MAX_LIMIT = 1000


def _clamp_limit(raw) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = DEFAULT_LIMIT
    return max(MIN_LIMIT, min(value, MAX_LIMIT))


def classify_text(
    text: str,
    limit: int = DEFAULT_LIMIT,
    entry_lookup: Optional[EntryLookup] = None,
) -> dict:
    """Classify every token in `text` for `/wtn/classify`.

    Returns `{"tokens": [...]}`; each token has exact `start`/`end`
    **Unicode CODE POINT offsets** into `text` itself (`text[start:end] ==
    token["text"]` always holds -- see module docstring). This is also
    EXACTLY what `api.py`'s `classify_impl` returns over the wire for the
    `/wtn/classify` route -- there is no offset conversion at the
    serialization boundary; `classify_text` IS the wire contract.

    OFFSET CONTRACT (read before touching offsets on either side of this
    route): these are Unicode code point offsets, i.e. plain Python string
    indices (`len(text)` counts code points; `ord(text[i])` is one whole
    character even for astral characters like emoji or rare CJK). They are
    deliberately NOT UTF-16 code units. A naive JS consumer doing
    `text.slice(start, end)` on a raw JS string would get this wrong for any
    character outside the Basic Multilingual Plane (JS strings are UTF-16,
    where such a character is 2 code units but only 1 Python code point) --
    the frontend consumer, `js/shared/highlight/classify.mjs`, is
    responsible for indexing via `Array.from(text)` (which iterates by code
    point, matching this contract) rather than raw `.slice()`/`[i]` indexing.
    Do NOT "fix" this by converting to UTF-16 on the Python side -- that
    would silently double-correct against the frontend's own
    `Array.from`-based fix and reintroduce the exact same drift bug (just in
    the opposite direction), and only for prompts containing emoji/astral
    characters, i.e. hard to catch by casual testing. This offset space is
    owned end-to-end by whichever side reads this comment first: right now
    that's "code points everywhere," full stop.

    `limit` is clamped to `MIN_LIMIT..MAX_LIMIT` (default `DEFAULT_LIMIT`)
    and caps the number of tokens returned. Truncation happens on the
    already-fully-classified token LIST (`tokens[:limit]`), never mid-token,
    so a truncated response can never end in a partial/dangling span -- the
    last token returned (if any) is always a complete, correctly-spanned
    token; there's just possibly more prompt text after it that wasn't
    classified.

    `entry_lookup` (default `autocomplete.index.exact_lookup`) is an
    injectable `tag -> AutocompleteEntry | None` callable, so tests can
    supply a small deterministic fixture instead of the full bundled CSVs.
    """
    text = text if isinstance(text, str) else str(text or "")
    limit = _clamp_limit(limit)
    lookup = entry_lookup if entry_lookup is not None else _default_entry_lookup

    tokens: list[dict] = []
    cursor = 0
    for match in _COMMENT_RE.finditer(text):
        comment_start, comment_end = match.span()
        if comment_start > cursor:
            tokens.extend(_tokenize_plain_region(text, cursor, comment_start, lookup))
        tokens.append(_comment_token(text, comment_start, comment_end))
        cursor = comment_end
        if len(tokens) >= limit:
            return {"tokens": tokens[:limit]}
    if cursor < len(text):
        tokens.extend(_tokenize_plain_region(text, cursor, len(text), lookup))

    return {"tokens": tokens[:limit]}
