"""Civitai's own MEILISEARCH endpoint -- the two-call search design,
docs/lora-loader-design.md §7c-0/§7c-0b, `search_impl`'s new DEFAULT path
(`api.py`).

**Why this exists at all.** `GET /api/v1/models` (`civitai_search.py`) is a
known, unfixed upstream bug (civitai/civitai#2214): a `query` forces
`sort=id:desc` server-side to make cursor pagination work, which returns the
20 NEWEST matches rather than the 20 BEST -- so a narrow filter (a base-model
filter especially) routinely returns an EMPTY first page while real matches
sit on a later one, and a client that treats an empty page as "no results"
(ours did) reports nothing found. Civitai's own web app doesn't hit that
endpoint for search at all -- it POSTs to `search.civitai.com/multi-search`,
where filters run INSIDE the index instead of over an already-mis-sorted
page. That's this module.

**The two-call shape (§7c-0b), and why it's two calls, not one:**

  1. MEILI decides WHICH models match, in RANK order, plus a real
     `estimatedTotalHits` (`build_meili_payload` / `_post_meili` /
     `parse_meili_response` below). A Meili hit has NO `files` array --
     confirmed absent: file size, name, `downloadUrl`, `primary`,
     per-file `sha256` -- so it cannot describe a download on its own.
  2. `/api/v1/models?ids=<meili's ids>&nsfw=true` (`civitai_search.
     search_models_by_ids`, a SIBLING of `search_models` in that module, not
     duplicated here) re-hydrates that exact page from the SAME endpoint
     `civitai_search.parse_search_response` ALREADY parses -- so that
     parser (along with `_parse_version`/`_parse_search_item`/
     `pick_primary_file`) is untouched by this task, per its own brief:
     "step 2 hands them the exact response shape they already parse."

Two upstream requests per page, regardless of page size (measured
2026-08-02: 20 ids -> one 292-char `ids=` URL, not twenty). `two_call_search`
below is the ONE function that orchestrates both calls end to end; `api.py`'s
`search_impl` calls it once per incoming search and falls back to the
existing REST-only `civitai_search.search_models` path when (and only when)
step 1 -- Meili itself -- is unreachable (a rotated token, a Cloudflare
block, an index rename). Step 2 failing AFTER step 1 succeeded is
deliberately NOT a fallback case (see `two_call_search`'s own docstring):
the ids are good, so the caller surfaces `offline` and lets the user retry,
rather than silently serving a different, REST-sourced result set for the
same query.

**Four rules from measured failures, load-bearing on step 2** (repeated here
because they are the whole correctness story, same as the design doc):

  1. `nsfw=true` is MANDATORY on the `ids=` call, or adult models vanish
     with no error -- our own browsing-level filtering still happens
     client-side against `nsfw_level`, unchanged; this parameter is about
     what Civitai is willing to return at all, not what we show.
  2. RE-SORT into Meili's own id order -- the `ids=` response comes back in
     a DIFFERENT order than requested (measured, not assumed).
  3. TOLERATE gaps -- one un-resolving id (unpublished/restricted since
     indexed) drops that one card, never fails the page.
  4. ASSERT the returned ids are a SUBSET of the requested ones
     (`ids_are_subset`) -- Civitai's own unmerged fix PR documents a 0-hit
     REST fallback that answers with the 100 newest published models
     instead of an empty list; the identical failure mode could show up
     here if the `ids=` filter were ever silently dropped, so this one line
     converts that entire class of silent wrongness into a detectable
     `offline` result rather than a page of unrelated "matches".

**The level filter is an EXCLUSION, not an inclusion** (`level_exclusion_filter`)
-- a model's `nsfwLevel` in the Meili index is a BITMASK UNION of every
level present in it (e.g. `[4, 8, 16, 32]`), so `nsfwLevel IN [1]` (an
inclusion filter, and Civicomfy's own approach) matches a model that ALSO
carries level 1 among several -- it does not exclude it. VERIFIED LIVE
2026-08-02 against a query known to carry mixed-level hits: `NOT nsfwLevel
IN [2,4,8,16]` (the PG exclusion) returned only the two hits whose
`nsfwLevel` was `[1]` and nothing else, out of twenty; the equivalent
inclusion filter (`nsfwLevel IN [1]`) returned TWENTY-ONE, including several
whose `nsfwLevel` also contained 4/8/16 -- an inclusion filter passes a
clean-model smoke test perfectly while leaking mixed content. See this
module's own test file for the recorded fixtures behind that finding.

**`32` is never one of the excluded levels, at any ceiling** (fixed
2026-08-03, `level_exclusion_filter`'s own comment) -- it is not a rung
above XXX on Civitai's five-rung scale (1 PG, 2 PG-13, 4 R, 8 X, 16 XXX;
their OR is 31, the top of the scale). It's a separate marker that
co-occurs constantly with ordinary adult content (20/40 sampled adult
LoRAs carried it alongside 4/8/16), so the ORIGINAL version of this filter
-- which did include `32` -- hid most adult models even at the MAXIMUM
browsing level: measured live, a *Deepthroat* search returned 347 hits
unfiltered but only 69 with the (buggy) XXX-ceiling filter, an 80% loss, the
exact opposite of what "maximum" is supposed to mean. `level_exclusion_
filter(16)` (the XXX ceiling) now returns `None` -- no filter clause at all,
not a vacuous one -- and `build_meili_filter_groups` omits the level group
entirely in that case.

**`lastVersionAtUnix` (the period filter's field) is MILLISECONDS since
epoch**, verified live 2026-08-02 (a real hit's `lastVersionAtUnix` decoded
to a plausible recent date only when divided by 1000, i.e. treated as ms;
as whole seconds it doesn't even fit a valid year). Not stated as a unit
anywhere in Civitai's own docs -- get this wrong and the period filter
silently stops matching anything, or matches everything.

**Sort:** `Relevancy` sends NO `sort` key at all -- sending one (even
`"id:desc"`, Civicomfy's own mapping for it) is exactly the upstream defect
this whole module exists to avoid; Meili's own ranking is what "Relevancy"
means here.

**Licensing.** `../Civicomfy` is MIT (c) 2025 MoonGoblin -- the request
SHAPE (POST body, filter-group structure, the sort-string mapping) is
ported from `Civicomfy/api/civitai.py:127-236`'s `search_models_meili`, with
attribution (see `THIRD_PARTY_NOTICES.md`). The level-exclusion fix, the
period-to-`lastVersionAtUnix` mapping, and the two-call/subset/re-sort
orchestration below are OURS, not theirs -- do not attribute those to
upstream (docs/lora-loader-design.md's own instruction).

**The bearer token is Civitai's own public web-app search key** -- identical
for every visitor to civitai.com's own search box (Civicomfy's author
verified this against three separate accounts; not a per-user secret). It is
still never logged and never returned to a client, same discipline this
package already gives its OWN Civitai API key (`keys.py`) -- not because
this token is secret, but because the URL/payload-building code path
shouldn't get to discover that difference the hard way.
"""
from __future__ import annotations

import json
import logging
import socket
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Sequence

from . import civitai_client
from . import civitai_search
from . import logs as logs_mod

_logger = logging.getLogger(logs_mod.LOGGER_NAME)

# Civitai's own web-app search endpoint -- ONE host, no `.red` mirror (that
# fallback host is specific to `civitai_client.CIVITAI_HOSTS`'s API surface;
# nothing establishes it also serves Meilisearch, so this module doesn't
# assume it does).
MEILI_URL = "https://search.civitai.com/multi-search"
MEILI_INDEX_UID = "models_v9"

# The COMMUNITY gallery's own prompt-enrichment index (2026-08-02, "community
# images gain their prompts") -- a SIBLING Meili index on the SAME endpoint,
# NOT a second Meili host/client: `GET /api/v1/images?modelVersionId=...`
# (`civitai_client.fetch_community_images`) answers `meta: {}` on every
# sampled image (`civitai_parse.parse_community_images`'s own docstring,
# "0/40 sampled" -- that measurement was RIGHT about the REST endpoint),
# but Civitai's own `images_v6` Meili index carries `prompt` as a top-level
# field on the SAME images, measured live against the owner's own report
# (`/wtn/model_browser/community_images?version_id=2982108`): `GET /api/v1/
# images?modelVersionId=2982108` -> 20 images, 0 prompts; the SAME 20 ids
# resolved through `images_v6` via `id IN [...]` -> 20 prompts. `id` is
# filterable on this index (`modelVersionId` is NOT -- the 400 body's own
# error lists the filterable set: `aspectRatio`, `baseModel`,
# `combinedNsfwLevel`, `createdAtUnix`, `id`, `minor`, `nsfwLevel`, `poi`,
# `tagNames`, `techniqueNames`, `toolNames`, `type`, `user.username`), which
# is exactly why this is a SECOND lookup keyed by the ids the REST call
# already returned, not a way to ask Meili for a version's images directly.
IMAGES_MEILI_INDEX_UID = "images_v6"

# Civitai's own public web-app Meilisearch bearer token -- see this module's
# own top docstring for why this is safe to keep verbatim, ported from
# `Civicomfy/api/civitai.py:135` (MIT, with attribution).
MEILI_BEARER_TOKEN = "8c46eb2508e21db1e9828a97968d91ab1ca1caa5f70a00e88a2ba1e286603b61"

_DEFAULT_TIMEOUT = 30.0
_DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024

# Our four `SORT_VALUES` -> Meili's own sort-string syntax. `Relevancy` maps
# to `None`, meaning "omit `sort` from the request entirely" -- see this
# module's own top docstring for why sending anything (even a plausible
# "id:desc") for Relevancy would silently recreate the upstream defect this
# whole module exists to fix.
SORT_TO_MEILI: Dict[str, Optional[str]] = {
    "Highest Rated": "metrics.thumbsUpCount:desc",
    "Most Downloaded": "metrics.downloadCount:desc",
    "Newest": "createdAt:desc",
    "Relevancy": None,
}

# Our five `PERIOD_VALUES` -> a millisecond DELTA subtracted from "now" to
# build a `lastVersionAtUnix > <epoch_ms>` filter. `AllTime` -> `None`,
# meaning "no period filter at all". Calendar-approximate (a 30-day month, a
# 365-day year) -- Civitai's own REST `period` parameter is no more precise
# than this either, and the design doc doesn't ask for calendar-exact
# boundaries.
_PERIOD_TO_DELTA_MS: Dict[str, Optional[int]] = {
    "Day": 24 * 3600 * 1000,
    "Week": 7 * 24 * 3600 * 1000,
    "Month": 30 * 24 * 3600 * 1000,
    "Year": 365 * 24 * 3600 * 1000,
    "AllTime": None,
}

# The five REAL `nsfwLevel` rungs, PG through XXX -- `32` is deliberately
# NOT one of them. `32` is not a rung above XXX on Civitai's own scale (1 PG,
# 2 PG-13, 4 R, 8 X, 16 XXX; their OR is 31, the top of the scale); it's a
# separate "Blocked"-ish marker that co-occurs constantly with ordinary adult
# content (measured 2026-08-03: 20/40 sampled adult LoRAs carry it alongside
# 4/8/16), so excluding it hides most adult models even at the MAXIMUM
# browsing level -- the exact opposite of what that setting means. This is
# also why `js/shared/civitai_thumb.mjs`'s own `NSFW_LEVEL_BITS` (the
# frontend's equivalent bitmask, `hasNsfwAboveLevel`'s source of truth)
# deliberately omits it; this tuple must agree with that one.
# `level_exclusion_filter` below picks the subset of this tuple that sits
# above the caller's level.
_LEVELS_ABOVE_PG: Sequence[int] = (2, 4, 8, 16)

# The opaque cursor this module hands back through `search_impl`'s existing
# `next_cursor` field (docs/lora-loader-design.md §7c-0b: "`next_cursor`
# stays an opaque token the client never interprets... internally it now
# encodes a Meili `offset` rather than a Civitai cursor"). Prefixed so
# `decode_meili_cursor` can tell "a cursor THIS module minted" from "a raw
# REST cursor a previous page's fallback returned" -- the two are not
# interchangeable (a REST cursor isn't a number `int()` would even parse),
# so an un-prefixed value is never mistaken for one of ours.
_MEILI_CURSOR_PREFIX = "meili_offset:"


def encode_meili_cursor(offset: int) -> str:
    """An `offset` -> the opaque string `search_impl` hands to the
    frontend as `next_cursor`. The frontend never parses this -- it is
    handed back VERBATIM as `cursor` on the next page request."""
    return f"{_MEILI_CURSOR_PREFIX}{int(offset)}"


def decode_meili_cursor(cursor: Any) -> Optional[int]:
    """The reverse of `encode_meili_cursor` -- `None` for anything that
    isn't a cursor THIS module minted (no cursor at all, i.e. page one; a
    raw REST cursor left over from a previous page's fallback; garbage).
    Never raises. `two_call_search` treats `None` as "start from offset 0",
    which is the correct, safe behaviour for all three of those cases: a
    genuine first page, and a foreign cursor this module can't interpret
    (restarting rather than guessing is the honest choice for something
    this rare -- see `two_call_search`'s own docstring)."""
    if not isinstance(cursor, str) or not cursor.startswith(_MEILI_CURSOR_PREFIX):
        return None
    rest = cursor[len(_MEILI_CURSOR_PREFIX):]
    if not rest.isdigit():
        return None
    return int(rest)


def level_exclusion_filter(level: Any) -> Optional[str]:
    """The "Maximum browsing level" setting -> a Meili filter STRING that
    EXCLUDES every rung above it, e.g. `"NOT nsfwLevel IN [2,4,8,16]"` at PG
    (`level=1`), or `None` at XXX (`level=16`, the highest selectable rung --
    there is nothing left to exclude, so this returns "no filter at all"
    rather than a vacuous clause). Deliberately an EXCLUSION -- see this
    module's own top docstring for the measured, live-verified reason an
    INCLUSION filter (`"nsfwLevel IN [1]"`, Civicomfy's own approach) leaks
    mixed-level models: `nsfwLevel` is a bitmask UNION of every image a model
    carries, so an inclusion filter matches the instant ANY element matches,
    while an exclusion filter correctly rejects the model the instant ANY
    element is over the ceiling.

    **`32` never appears here, at any level** -- see `_LEVELS_ABOVE_PG`'s own
    comment for why: it is not a rung above XXX on Civitai's five-rung scale
    (1/2/4/8/16), it's a separate marker that co-occurs constantly with
    ordinary adult content, so excluding it hid most adult models even at the
    MAXIMUM browsing level (measured live 2026-08-03, a *Deepthroat* search:
    347 hits unfiltered, 69 with the old XXX filter that excluded `32`) --
    the exact opposite of what "maximum" is supposed to mean. Fixed here, not
    patched over: this function agrees with `js/shared/civitai_thumb.mjs`'s
    own `NSFW_LEVEL_BITS`, which never included `32` either.

    `level` is cleaned via `civitai_search.clean_level` first (garbage/
    missing falls back to PG, same tolerance every other filter here gets),
    so this never raises.
    """
    clean = civitai_search.clean_level(level)
    excluded = [v for v in _LEVELS_ABOVE_PG if v > clean]
    if not excluded:
        return None
    return f"NOT nsfwLevel IN [{','.join(str(v) for v in excluded)}]"


def period_filter(period: Any, *, now_ms: Optional[int] = None) -> Optional[str]:
    """The "period" setting -> a `"lastVersionAtUnix > <epoch_ms>"` Meili
    filter string, or `None` for `AllTime` (no filter at all). `period` is
    validated against `civitai_search.PERIOD_VALUES` first (falls back to
    `civitai_search.DEFAULT_PERIOD` for anything else, same tolerance every
    other filter here gets) -- never raises.

    `now_ms` (keyword-only, milliseconds since the Unix epoch) is the one
    seam this function's own tests use to avoid a real wall-clock read;
    defaults to the actual current time. **Milliseconds, not seconds** --
    Civitai's own `lastVersionAtUnix` field is in milliseconds (verified
    live 2026-08-02, this module's own top docstring), and a caller passing
    seconds here would silently build a filter that excludes everything
    published in roughly the last 44,000 years, i.e. matches nothing that
    matters.
    """
    clean_period = period if period in civitai_search.PERIOD_VALUES else civitai_search.DEFAULT_PERIOD
    delta_ms = _PERIOD_TO_DELTA_MS.get(clean_period)
    if delta_ms is None:
        return None
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    return f"lastVersionAtUnix > {int(now_ms) - delta_ms}"


def sort_value(sort: Any) -> Optional[str]:
    """The "sort" setting -> Meili's own sort-string syntax, or `None` for
    `Relevancy`/anything unrecognised (falls back to `DEFAULT_SORT` first,
    same tolerance `civitai_search.build_search_url` already gives this
    parameter) -- meaning "omit `sort` from the request entirely"."""
    clean_sort = sort if sort in civitai_search.SORT_VALUES else civitai_search.DEFAULT_SORT
    return SORT_TO_MEILI.get(clean_sort)


def build_meili_filter_groups(
    kind: object,
    *,
    types: Optional[Sequence[str]] = None,
    base_model: Optional[Sequence[str]] = None,
    level: Any = civitai_search.DEFAULT_LEVEL,
    period: Any = civitai_search.DEFAULT_PERIOD,
    now_ms: Optional[int] = None,
) -> List[Any]:
    """The Meili `filter` array -- a list of GROUPS, each either a list of
    strings (OR'd together) or a single string (AND'd against every other
    entry) -- mirroring `civitai_search.build_search_url`'s own `kind`-given-
    vs-`kind`-absent split for the type filter EXACTLY (a given `kind` locks
    to one type value via `civitai_search.type_for_kind`, ignoring `types`;
    `kind=None` validates `types` itself via `civitai_search.clean_types` --
    same "picker locks, modal doesn't" rule, same validation, just building
    a Meili group instead of a `types=` query param), and `base_model` via
    `civitai_search.clean_base_models` the same way `build_search_url` does.

    Always ends with `"availability = Public"` (excludes unlisted/removed
    models, unconditionally) and, UNLESS `level` is XXX (the top of the
    scale, where `level_exclusion_filter` returns `None` -- nothing left to
    exclude), `level_exclusion_filter`'s own group. A period filter is
    appended too, UNLESS `period` is `AllTime` (no filter).
    An unwhitelisted/type-less `kind` simply contributes no type group at
    all (never raises) -- `civitai_meili.two_call_search`'s own caller
    (`api.py`'s `search_impl`) has already validated `kind` before reaching
    here, same as every other route in this package.
    """
    groups: List[Any] = []

    if kind is not None:
        model_type = civitai_search.type_for_kind(kind)
        if model_type is not None:
            groups.append([f'"type"="{model_type}"'])
    else:
        cleaned_types = civitai_search.clean_types(types)
        if cleaned_types:
            groups.append([f'"type"="{t}"' for t in cleaned_types])

    cleaned_base_models = civitai_search.clean_base_models(base_model)
    if cleaned_base_models:
        groups.append([f'"version.baseModel"="{bm}"' for bm in cleaned_base_models])

    groups.append("availability = Public")
    level_group = level_exclusion_filter(level)
    if level_group is not None:
        groups.append(level_group)

    period_group = period_filter(period, now_ms=now_ms)
    if period_group is not None:
        groups.append(period_group)

    return groups


def build_meili_payload(
    kind: object,
    query: Any,
    *,
    types: Optional[Sequence[str]] = None,
    base_model: Optional[Sequence[str]] = None,
    level: Any = civitai_search.DEFAULT_LEVEL,
    sort: Any = civitai_search.DEFAULT_SORT,
    period: Any = civitai_search.DEFAULT_PERIOD,
    limit: Any = civitai_search.DEFAULT_LIMIT,
    offset: int = 0,
    now_ms: Optional[int] = None,
) -> Dict[str, Any]:
    """The full `POST https://search.civitai.com/multi-search` JSON body --
    pure, no network. Shape ported from `Civicomfy/api/civitai.py:186-210`
    (MIT, with attribution -- see this module's own top docstring), trimmed
    to what THIS pack's two-call design actually needs: no `facets`/
    highlighting (we never render Meili's own hit, only its ids -- "keep
    nothing else from the hit" per the design doc).

    `query` -> Meili's own `"q"`, sent verbatim (never quoted/rewritten --
    the design doc's own "quoting -- left as-is for now" decision: whatever
    quoting behaviour the CALLER already relies on for the REST path
    continues to reach this endpoint unchanged too). Falsy `query` (`None`,
    `""`) -> an explicit empty string, matching Meili's own expectation for
    "no text query, filters only".

    `limit`/`offset` are Meili's own pagination knobs -- `limit` is clamped
    via `civitai_search.clean_limit` (same bound `build_search_url` already
    enforces for the REST path); `offset` is coerced to a non-negative `int`,
    falling back to `0` for anything that isn't one (never raises).
    """
    filter_groups = build_meili_filter_groups(
        kind, types=types, base_model=base_model, level=level, period=period, now_ms=now_ms,
    )
    try:
        clean_offset = max(0, int(offset))
    except (TypeError, ValueError):
        clean_offset = 0

    query_obj: Dict[str, Any] = {
        "q": str(query) if query else "",
        "indexUid": MEILI_INDEX_UID,
        "limit": civitai_search.clean_limit(limit),
        "offset": clean_offset,
        "filter": filter_groups,
    }
    meili_sort = sort_value(sort)
    if meili_sort is not None:
        query_obj["sort"] = [meili_sort]

    return {"queries": [query_obj]}


def parse_meili_response(raw: Any) -> Dict[str, Any]:
    """A `multi-search` response -> `{"ids": [...in rank order...], "total":
    int|None}`. Pure, offline-testable from recorded JSON. **Keeps nothing
    else from the hit** -- per the design doc's own instruction ("every
    other field is v1's job, and a second source for a field v1 already owns
    is how the two drift"), so this function is deliberately narrow: it
    reads `results[0].hits[].id` (in the order Meili returned them -- THIS
    is the relevance ranking the whole two-call design exists to preserve)
    and `results[0].estimatedTotalHits`.

    Never raises; a malformed/unexpected shape (not a dict, no `results`
    list, an empty `results` list, a non-dict first result, a non-list
    `hits`) degrades to `{"ids": [], "total": None}` rather than raising. A
    non-integer/boolean `hit["id"]` is dropped rather than propagated (an
    `id` this pack can't later put in a `?ids=` query is useless and
    shouldn't silently become one anyway). A non-`int`/boolean
    `estimatedTotalHits` -> `total=None` (unknown, never guessed).
    """
    if not isinstance(raw, dict):
        return {"ids": [], "total": None}
    results = raw.get("results")
    if not isinstance(results, list) or not results:
        return {"ids": [], "total": None}
    first = results[0]
    if not isinstance(first, dict):
        return {"ids": [], "total": None}

    ids: List[int] = []
    hits = first.get("hits")
    if isinstance(hits, list):
        for hit in hits:
            if not isinstance(hit, dict):
                continue
            hit_id = hit.get("id")
            if isinstance(hit_id, int) and not isinstance(hit_id, bool):
                ids.append(hit_id)

    total = first.get("estimatedTotalHits")
    if isinstance(total, bool) or not isinstance(total, int):
        total = None

    return {"ids": ids, "total": total}


def ids_are_subset(returned_ids: Sequence[Any], requested_ids: Sequence[Any]) -> bool:
    """Rule 4 of the two-call design: every id v1 actually returned must be
    one of the ids we asked for. `False` means step 2 answered with
    something OTHER than what was requested -- the exact shape of Civitai's
    own documented (unmerged-fix) 0-hit REST fallback, which answers with
    the 100 newest published models instead of an empty list. `True` for an
    empty `returned_ids` (vacuously a subset -- "v1 resolved nothing" is
    rule 3's gap-tolerance territory, not a subset violation)."""
    requested = set(requested_ids)
    return all(rid in requested for rid in returned_ids)


def reorder_by_ids(
    results: List[Dict[str, Any]], id_order: Sequence[Any], *, id_key: str = "model_id",
) -> List[Dict[str, Any]]:
    """Rules 2+3 of the two-call design in one pass: re-sort `results`
    (already parsed by `civitai_search.parse_search_response`, so each one
    carries `id_key`) into `id_order` -- Meili's own rank order, which the
    two-call design exists to preserve -- and DROP any id in `id_order` that
    `results` has no entry for (a gap: an id that didn't resolve on the v1
    call, e.g. unpublished/restricted since Meili indexed it). An id present
    in `results` but ABSENT from `id_order` is silently excluded too (that
    case should already have been caught by `ids_are_subset` before this is
    ever called -- this function doesn't re-raise it, it just doesn't
    invent a position for something it was never asked to place).
    """
    by_id: Dict[Any, Dict[str, Any]] = {}
    for item in results:
        if isinstance(item, dict) and id_key in item and item[id_key] not in by_id:
            by_id[item[id_key]] = item
    return [by_id[rid] for rid in id_order if rid in by_id]


def _default_meili_opener(payload: Dict[str, Any], timeout: float):
    """The real network call -- a `POST` with a JSON body and Civitai's own
    public Meilisearch bearer token, reusing `civitai_client.USER_AGENT`
    VERBATIM (docs/lora-loader-design.md §7c-0: "reuse `_default_opener`'s
    existing header and this question does not arise" -- no new Cloudflare-
    facing header decision needed here). Wrapped so tests can inject a fake
    `opener(payload, timeout)` (see `_post_meili`'s own `opener=` parameter)
    and exercise every failure branch with no real socket, same seam shape
    `civitai_client._default_opener`/`civitai_search.search_models`'s
    `opener=` already establish."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        MEILI_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {MEILI_BEARER_TOKEN}",
            "User-Agent": civitai_client.USER_AGENT,
        },
    )
    return urllib.request.urlopen(request, timeout=timeout)


def _post_meili(
    payload: Dict[str, Any],
    *,
    timeout: float = _DEFAULT_TIMEOUT,
    max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
    opener=None,
) -> Dict[str, Any]:
    """The Meili discovery step's own transport -- ONE host (no `.red`-style
    mirror is known to exist for this endpoint, so no host-fallback loop),
    otherwise the SAME rules `civitai_client.fetch_json_with_host_fallback`
    already applies to every REST call in this package: a byte cap so a
    malformed response can't spike memory, and the SAME distinct offline-
    reason vocabulary (`timeout`/`dns_tls`/`unreadable`/`rate_limited`/
    `forbidden`/`unknown`) via `civitai_client.classify_urlerror` -- shared,
    not duplicated.

    Always returns `{"reason": "found"|"offline", "offline_reason":
    None|one of civitai_client's offline reasons, "message": str, "data":
    <parsed JSON dict>|None}` -- never raises. `two_call_search` maps any
    non-`"found"` result here to `"meili_unavailable"`, its own signal that
    `api.py`'s `search_impl` should fall back to the existing REST-only
    path for this WHOLE page (docs/lora-loader-design.md's own fallback
    rule) -- this function itself has no opinion on fallback; it only
    reports what happened.
    """
    opener = opener or _default_meili_opener
    logs_mod.log_debug(_logger, logs_mod.format_request_debug, url=MEILI_URL)
    started = time.monotonic()

    def _duration_ms() -> float:
        return (time.monotonic() - started) * 1000

    try:
        with opener(payload, timeout) as response:
            body = response.read(max_body_bytes + 1)
            if len(body) > max_body_bytes:
                logs_mod.log_debug(
                    _logger, logs_mod.format_response_debug,
                    url=MEILI_URL, outcome="offline:unreadable", duration_ms=_duration_ms(),
                )
                return {
                    "reason": "offline", "offline_reason": "unreadable",
                    "message": "Civitai (Meilisearch) response too large.", "data": None,
                }
            try:
                data = json.loads(body)
            except (ValueError, TypeError):
                logs_mod.log_debug(
                    _logger, logs_mod.format_response_debug,
                    url=MEILI_URL, outcome="offline:unreadable", byte_count=len(body), duration_ms=_duration_ms(),
                )
                return {
                    "reason": "offline", "offline_reason": "unreadable",
                    "message": "Civitai (Meilisearch) sent an unreadable reply.", "data": None,
                }
            logs_mod.log_debug(
                _logger, logs_mod.format_response_debug,
                url=MEILI_URL, outcome="found", byte_count=len(body), duration_ms=_duration_ms(),
            )
            return {"reason": "found", "offline_reason": None, "message": "", "data": data}
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            offline_reason, message = "rate_limited", "Civitai (Meilisearch) returned 429 (rate limited)."
        elif exc.code in (401, 403):
            # NOT the search API key -- this is Civitai's own public token
            # (see this module's top docstring), so a 401/403 here means the
            # token itself has rotated/been revoked, not that a USER's key
            # would help. `civitai_client._OFFLINE_REASONS`'s existing
            # `"forbidden"` value already fits that without inventing a new
            # one.
            offline_reason, message = "forbidden", f"Civitai (Meilisearch) refused the request (HTTP {exc.code})."
        else:
            offline_reason, message = "unknown", f"Civitai (Meilisearch) returned {exc.code}."
        logs_mod.log_debug(
            _logger, logs_mod.format_response_debug,
            url=MEILI_URL, outcome=f"offline:{offline_reason}", status=exc.code, duration_ms=_duration_ms(),
        )
        return {"reason": "offline", "offline_reason": offline_reason, "message": message, "data": None}
    except urllib.error.URLError as exc:
        offline_reason = civitai_client.classify_urlerror(exc)
        message = "Civitai (Meilisearch) timed out." if offline_reason == "timeout" else "Couldn't reach Civitai (Meilisearch) (DNS/TLS)."
        logs_mod.log_debug(
            _logger, logs_mod.format_response_debug,
            url=MEILI_URL, outcome=f"offline:{offline_reason}", duration_ms=_duration_ms(),
        )
        return {"reason": "offline", "offline_reason": offline_reason, "message": message, "data": None}
    except (socket.timeout, TimeoutError):
        logs_mod.log_debug(
            _logger, logs_mod.format_response_debug,
            url=MEILI_URL, outcome="offline:timeout", duration_ms=_duration_ms(),
        )
        return {"reason": "offline", "offline_reason": "timeout", "message": "Civitai (Meilisearch) timed out.", "data": None}
    except Exception as exc:  # noqa: BLE001 - degrade to offline, never raise
        logs_mod.log_debug(
            _logger, logs_mod.format_response_debug,
            url=MEILI_URL, outcome="offline:unknown", duration_ms=_duration_ms(),
        )
        return {
            "reason": "offline", "offline_reason": "unknown",
            "message": f"Could not reach Civitai (Meilisearch) ({type(exc).__name__}).", "data": None,
        }


def two_call_search(
    kind: object,
    query: Any,
    *,
    types: Optional[Sequence[str]] = None,
    base_model: Optional[Sequence[str]] = None,
    level: Any = civitai_search.DEFAULT_LEVEL,
    sort: Any = civitai_search.DEFAULT_SORT,
    period: Any = civitai_search.DEFAULT_PERIOD,
    cursor: Optional[str] = None,
    limit: Any = civitai_search.DEFAULT_LIMIT,
    api_key: Optional[str] = None,
    timeout: float = _DEFAULT_TIMEOUT,
    max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
    hosts: Sequence[str] = civitai_client.CIVITAI_HOSTS,
    now_ms: Optional[int] = None,
    meili_opener=None,
    ids_opener=None,
) -> Dict[str, Any]:
    """The whole two-call design end to end, for ONE search page. `api.py`'s
    `search_impl` calls this ONCE per incoming search (never per HTTP
    request -- both calls below share the SAME logical search, so
    `search_impl`'s own `_SEARCH_LIMITER.allow()` check, made once before
    this function is ever reached, is the only rate-limit slot either of
    them costs).

    Always returns one of THREE shapes, distinguished by `"reason"`:

      - `{"reason": "meili_unavailable", "message": str, "offline_reason":
        ...}` -- step 1 (Meili itself) failed: a rotated token, a
        Cloudflare block, an index rename, a timeout. `search_impl` maps
        this to a full fallback -- re-running the SAME search against the
        existing REST-only `civitai_search.search_models` path -- rather
        than to a user-visible error (docs/lora-loader-design.md's own
        fallback rule: "must degrade to the existing REST search, not to an
        error").
      - `{"reason": "offline", "offline_reason": ..., "message": str,
        "results": [], "next_cursor": None, "total": None}` -- step 1
        SUCCEEDED (Meili found real ids) but step 2 (the `ids=` re-hydration)
        failed, OR the subset assertion (rule 4) caught step 2 answering
        with ids we never asked for. Deliberately NOT a fallback case (see
        the module docstring): the ids Meili gave us are trustworthy, so a
        REST re-search would silently serve a DIFFERENT result set for the
        same query -- worse than telling the truth and letting the user
        retry.
      - `{"reason": "ok", "results": [...parsed, re-sorted, un-annotated...],
        "next_cursor": str|None, "total": int|None}` -- the common case.
        `results` are `civitai_search.parse_search_response`'s own per-item
        shape (`_annotate_search_results` in `api.py` still adds the disk-
        touching `installed`/`kind` fields afterwards, same as the REST
        path) -- re-ordered into Meili's own rank order and with any
        non-resolving id already dropped.

    An empty Meili hit list (a real, valid "nothing matched" answer) short-
    circuits to `"ok"` with `results=[]` WITHOUT ever calling
    `civitai_search.search_models_by_ids` -- there's nothing to re-hydrate,
    and an EMPTY `ids=` query isn't a request this pack should ever make
    (`civitai_search.build_ids_search_url`'s own guard against exactly
    that).

    `cursor` decodes via `decode_meili_cursor` -- `None` (page one, OR a
    foreign/un-decodable cursor left over from a REST-fallback page) means
    "start this call at Meili offset 0". Restarting rather than guessing is
    the deliberate, honest choice for that rare cross-engine-pagination
    edge case (a fallback happened on an earlier page, Meili is queried
    again on a later one): there is no way to translate an opaque REST
    cursor into a Meili offset, so this function doesn't try.
    """
    offset = decode_meili_cursor(cursor)
    if offset is None:
        offset = 0
    clean_limit = civitai_search.clean_limit(limit)

    payload = build_meili_payload(
        kind, query,
        types=types, base_model=base_model, level=level, sort=sort, period=period,
        limit=clean_limit, offset=offset, now_ms=now_ms,
    )
    step1 = _post_meili(payload, timeout=timeout, max_body_bytes=max_body_bytes, opener=meili_opener)
    if step1["reason"] != "found":
        return {
            "reason": "meili_unavailable",
            "message": step1.get("message", ""),
            "offline_reason": step1.get("offline_reason"),
        }

    parsed_meili = parse_meili_response(step1["data"])
    ids = parsed_meili["ids"]
    total = parsed_meili["total"]

    if not ids:
        return {"reason": "ok", "results": [], "next_cursor": None, "total": total}

    step2 = civitai_search.search_models_by_ids(
        ids, limit=clean_limit, api_key=api_key,
        timeout=timeout, max_body_bytes=max_body_bytes, hosts=hosts, opener=ids_opener,
    )
    if step2["reason"] != "found":
        return {
            "reason": "offline",
            "offline_reason": step2.get("offline_reason"),
            "message": step2.get("message") or "Could not load search result details.",
            "results": [], "next_cursor": None, "total": None,
        }

    parsed_v1 = civitai_search.parse_search_response(step2["data"])
    returned_ids = [item.get("model_id") for item in parsed_v1["results"]]
    if not ids_are_subset(returned_ids, ids):
        return {
            "reason": "offline",
            "offline_reason": "unknown",
            "message": "Civitai returned unexpected results for this page -- try again.",
            "results": [], "next_cursor": None, "total": None,
        }

    reordered = reorder_by_ids(parsed_v1["results"], ids)

    if total is not None:
        has_more = (offset + clean_limit) < total
    else:
        # No total to compare against (a malformed-but-still-`"found"` Meili
        # response) -- fall back to the same heuristic the REST path already
        # lives with: a full page MIGHT mean there's more, a short one can't.
        has_more = len(ids) >= clean_limit
    next_cursor = encode_meili_cursor(offset + clean_limit) if has_more else None

    return {"reason": "ok", "results": reordered, "next_cursor": next_cursor, "total": total}


# ---------------------------------------------------------------------------
# The COMMUNITY gallery's own `images_v6` prompt enrichment (2026-08-02,
# "community images gain their prompts") -- reuses `_post_meili`'s existing
# transport (host, headers, byte cap, offline-reason vocabulary) verbatim;
# only the payload shape and the index differ from `two_call_search`'s own
# step 1. See `IMAGES_MEILI_INDEX_UID`'s own comment above for the measured
# "why this index, why `id IN [...]`" story.
# ---------------------------------------------------------------------------


def build_images_meili_payload(ids: Sequence[int]) -> Dict[str, Any]:
    """`ids` (already-cleaned positive ints -- the caller's job, same
    division of labour `build_meili_payload`'s own caller keeps) -> the
    `POST https://search.civitai.com/multi-search` body for `images_v6`'s
    own `id IN [...]` filter. No text query (`q: ""`), no sort (rank order is
    irrelevant here -- this is a lookup by id, not a search), `limit` sized
    to the request itself so every requested id can come back in one page
    (never Civitai's own default page size, which could silently truncate a
    request for more ids than that default). Pure, no network.
    """
    clean_ids = [i for i in ids if isinstance(i, int) and not isinstance(i, bool)]
    query_obj: Dict[str, Any] = {
        "q": "",
        "indexUid": IMAGES_MEILI_INDEX_UID,
        "filter": [f"id IN [{','.join(str(i) for i in clean_ids)}]"],
        "limit": max(len(clean_ids), 1),
    }
    return {"queries": [query_obj]}


def parse_images_meili_response(raw: Any) -> Dict[int, Dict[str, Any]]:
    """An `images_v6` `multi-search` response -> `{image_id: {"prompt":
    str|None, "hide_meta": bool}}`. `prompt` is the hit's own top-level field,
    kept only when it's a real, non-blank string (`None` otherwise -- "omit
    rather than invent", the same rule every parser in this package
    follows). `hide_meta` is the hit's own `hideMeta` boolean, coerced with
    `bool()` -- an uploader who set it chose to hide their generation data,
    and `fetch_image_prompts`'s own caller (`community_images_impl`) must
    never surface a `prompt` for a hit where this is `True`, regardless of
    what `prompt` itself holds.

    Never raises; a malformed/unexpected shape (not a dict, no `results`
    list, an empty `results` list, a non-dict first result, a non-list
    `hits`) degrades to `{}` rather than raising, same as `parse_meili_
    response` above. A hit with a non-integer/boolean `id` is dropped (no key
    to file it under). Order is not meaningful here (unlike `parse_meili_
    response`'s own rank-order contract) -- this is a lookup, not a search.
    """
    if not isinstance(raw, dict):
        return {}
    results = raw.get("results")
    if not isinstance(results, list) or not results:
        return {}
    first = results[0]
    if not isinstance(first, dict):
        return {}
    hits = first.get("hits")
    if not isinstance(hits, list):
        return {}

    out: Dict[int, Dict[str, Any]] = {}
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        hit_id = hit.get("id")
        if not isinstance(hit_id, int) or isinstance(hit_id, bool):
            continue
        prompt = hit.get("prompt")
        out[hit_id] = {
            "prompt": prompt if isinstance(prompt, str) and prompt.strip() else None,
            "hide_meta": bool(hit.get("hideMeta")),
        }
    return out


def fetch_image_prompts(
    ids: Sequence[int],
    *,
    timeout: float = _DEFAULT_TIMEOUT,
    max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
    opener=None,
) -> Dict[int, Dict[str, Any]]:
    """Best-effort `id -> {"prompt": str|None, "hide_meta": bool}` enrichment
    from `images_v6`, for the COMMUNITY gallery's own prompt reversal
    (2026-08-02, docs/lora-loader-design.md's own community-gallery section).
    `community_images_impl`'s ONE caller for this -- never raises, and a
    failure/partial resolve degrades to `{}`/a PARTIAL dict rather than
    turning a working community grid into a broken one: this extends
    `fb949a8`'s own "the whole section is additive" rule to this SECOND
    network call the same way it already governs the first
    (`civitai_client.fetch_community_images`) -- a failed or rate-limited
    `images_v6` lookup must never change `reason` or empty out `images`, it
    can only ever leave some/all entries' `prompt` at `None`.

    Reuses `_post_meili`'s existing transport (host, headers, byte cap,
    offline-reason vocabulary) rather than a second Meili client -- only the
    payload shape (`build_images_meili_payload`, `images_v6` instead of
    `models_v9`, an `id IN [...]` filter instead of `two_call_search`'s own
    filter groups) differs from that function's own step 1.

    An empty/falsy/non-iterable `ids` (`None` included -- `_community_image_
    ids`'s own non-list-input case) -- nothing to enrich -- short-circuits to
    `{}` with NO network call, mirroring `two_call_search`'s own identical
    short-circuit for an empty Meili hit list: an empty `id IN []` filter
    isn't a request this pack should ever make.
    """
    if not ids:
        return {}
    clean_ids = [i for i in ids if isinstance(i, int) and not isinstance(i, bool)]
    if not clean_ids:
        return {}
    payload = build_images_meili_payload(clean_ids)
    step = _post_meili(payload, timeout=timeout, max_body_bytes=max_body_bytes, opener=opener)
    if step["reason"] != "found":
        return {}
    return parse_images_meili_response(step["data"])


__all__ = (
    "MEILI_URL",
    "MEILI_INDEX_UID",
    "MEILI_BEARER_TOKEN",
    "IMAGES_MEILI_INDEX_UID",
    "SORT_TO_MEILI",
    "encode_meili_cursor",
    "decode_meili_cursor",
    "level_exclusion_filter",
    "period_filter",
    "sort_value",
    "build_meili_filter_groups",
    "build_meili_payload",
    "parse_meili_response",
    "ids_are_subset",
    "reorder_by_ids",
    "two_call_search",
    "build_images_meili_payload",
    "parse_images_meili_response",
    "fetch_image_prompts",
)
