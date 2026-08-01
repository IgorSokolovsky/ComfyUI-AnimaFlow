"""Civitai's model SEARCH endpoint (`GET /api/v1/models`) -- docs/lora-
loader-design.md §7a/§7c-i/§9. Stdlib `urllib` only, same constraint as
every other network module in this package.

Split the same way `civitai_client.py`/`civitai_parse.py` already are:
`build_search_url` and `parse_search_response` are PURE and fully
offline-testable from recorded JSON; `search_models` is the one impure
function (an actual network call, synchronous -- `api.py`'s route offloads
it via `run_in_executor`, same reasoning as every other route in this
package). The actual host-fallback/timeout/body-cap/distinct-offline-reason
transport is NOT reimplemented here -- it's `civitai_client.
fetch_json_with_host_fallback`, extracted from that module specifically so
this would be a reuse rather than a third copy of the same loop (docs/lora-
loader-design.md's M2 brief: "extend them, don't fork them").

When a caller passes a `kind`, `type` is ALWAYS derived from it via
`TYPE_FOR_KIND` (§7c-i: "type... locked to the caller's kind" for the two
node-embedded pickers) -- a raw Civitai `type` string never rides through
that path, so an unwhitelisted `kind` can't smuggle an arbitrary `types=`
value into the request either, extending `kinds.py`'s whitelist discipline
to the search request the same way it already applies to every local path.

M2b (the unscoped toolbar modal, docs/lora-loader-design.md §7c/"the
modal"): `kind` is OPTIONAL on this whole path (`build_search_url`,
`search_models`) -- absent, it sends no `types` parameter at all UNLESS the
caller supplies an explicit `types` list, which IS a raw-ish client value
(the rail's "Filter by Model Type" chips), so it's validated against
`VALID_CIVITAI_TYPES` (`clean_types`) before it ever reaches the wire --
same "never forward an unvalidated value raw" discipline, extended from
`kind` to `types` for the one caller that has no `kind` to derive it from.
`kind_for_type` is the reverse direction: given one of a search RESULT's
own Civitai `type` values, which (if any) of our three kinds it could land
in -- see its own docstring for why it isn't simply `TYPE_FOR_KIND`
inverted.

`base_model` is the modal's OTHER multi-value rail filter ("Filter by Base
Model"), and follows `types`'s exact convention: a list, cleaned
(`clean_base_models` -- shape only, no fixed enum unlike `types`) before it
ever reaches the wire, sent as one repeated `baseModels=` pair per value,
never comma-joined. Fixed 2026-07-31 -- the M2b wire-contract mismatch: the
modal's frontend and this backend were built in parallel against a contract
that pinned the RESPONSE shape but not the REQUEST shape for either
multi-value filter, so both `types` and `base_model` silently did nothing
(`types` because a comma-joined single value fails `VALID_CIVITAI_TYPES`
membership and gets dropped; `base_model` because it rode under a plural
`base_models` key this module never read at all). See `clean_base_models`'s
own docstring for the fix.
"""
from __future__ import annotations

import urllib.parse
from typing import Any, Dict, List, Optional, Sequence

from . import civitai_client
from . import civitai_parse
from .kinds import folder_for_kind

# kind -> Civitai's own `types` filter value (§7a's table, extended to the
# search request), used when a caller LOCKS a search to one `kind` (the two
# node-embedded pickers). All three of `loras`/`checkpoints`/`unet` are
# active kinds as of M2b (`kinds.ACTIVE_KINDS`) -- only `loras` has a live
# NODE picker wired to it today (the Loader Panel reuse pass, M3, is what
# wires the other two into a picker); `checkpoints`/`unet` are already
# reachable via this same route through the toolbar modal's UNSCOPED search
# (which doesn't use this table at all -- see `KIND_FOR_TYPE` instead).
TYPE_FOR_KIND: Dict[str, str] = {
    "loras": "LORA",
    "checkpoints": "Checkpoint",
    "unet": "Checkpoint",
}

# Civitai's own enum values for these two filters (§7c-i's table) -- kept
# here as the validated set so a garbage/hostile query-string value falls
# back to a sane default instead of being interpolated raw into the request.
SORT_VALUES: Sequence[str] = ("Highest Rated", "Most Downloaded", "Newest", "Relevancy")
PERIOD_VALUES: Sequence[str] = ("AllTime", "Year", "Month", "Week", "Day")

DEFAULT_SORT = "Highest Rated"
DEFAULT_PERIOD = "AllTime"
DEFAULT_LIMIT = 20
_MAX_LIMIT = 50

# docs/lora-loader-design.md §7c-iv's "Maximum browsing level" -- Civitai's
# own `nsfwLevel` bitmask values a user can pick as a ceiling: PG · PG-13 ·
# R · X · XXX (32 "Blocked" is deliberately absent -- never browsable at any
# setting, so it's not a valid REQUEST level either). PG is the default, and
# it is the one genuine server-side guarantee: at PG we ask Civitai for
# `nsfw=false` and never request adult content at all, rather than fetching
# it and choosing not to render it. Every level above PG requires
# `nsfw=true` (measured: there is no level-granular request parameter --
# `browsingLevel=31`/`nsfw=16`/`nsfw=X` are all HTTP 400), so anything above
# PG is filtered CLIENT-SIDE against the full gallery `nsfw=true` returns --
# see `api.py`'s `search_impl` for where that request-level split happens.
LEVEL_VALUES: Sequence[int] = (1, 2, 4, 8, 16)
DEFAULT_LEVEL = 1

# docs/lora-loader-design.md §7c-i's modal filter rail ("Filter by Model
# Type"), M2b task 1: the whitelist a client-supplied `types` list is
# validated against before it ever reaches the wire -- same "garbage/
# unrecognised falls back / gets dropped, never forwarded raw" posture
# `sort`/`period`/`clean_level` already take. Kept as a flat, append-only
# tuple in one place, same reasoning as `KIND_FOR_TYPE` above -- every entry
# `KIND_FOR_TYPE` maps somewhere is included here too, plus the wider set of
# Civitai types we simply have no folder for yet (never guessed, always
# `None` from `kind_for_type`).
#
# VERIFIED LIVE 2026-07-31 -- these are Civitai's actual API enum values,
# not display labels. An EARLIER version of this tuple was transcribed from
# docs/lora-loader-design.md §7c-i's description of Civitai's rail (read off
# a screenshot of the UI, which shows LABELS, not the wire values) and got
# two entries wrong as a result: `LyCORIS` isn't a real API value at all
# (the API's own value for that model family is `LoCon`, already present
# here -- `LyCORIS` is just Civitai's UI label for it) and `VLM` should have
# been `VisionLanguage`. Both would have been worse than an unrecognised
# value: being IN this tuple but not Civitai's own enum means `clean_types`
# waves it through and Civitai 400s the ENTIRE search on it.
#
# HOW TO RE-VERIFY WHEN THIS DRIFTS: don't transcribe the rail again --
# Civitai's own API enumerates its valid values FOR you. A request with an
# invalid `types` value (e.g. `GET /api/v1/models?types=NotARealType`)
# 400s with a `ZodError` body that lists every accepted enum member
# verbatim. That response body is the source of truth for this tuple, not
# a screenshot of the modal's own rail.
VALID_CIVITAI_TYPES: Sequence[str] = (
    "Checkpoint", "TextualInversion", "Hypernetwork", "AestheticGradient",
    "LORA", "LoCon", "DoRA", "Controlnet", "Upscaler", "MotionModule", "VAE",
    "TextEncoder", "UNet", "CLIPVision", "Poses", "Wildcards", "Workflows",
    "Detection", "VisionLanguage", "CLIP", "LLM", "Other",
)


def clean_types(values: Any) -> List[str]:
    """A client-supplied `types` filter list -> the validated subset, in the
    order given, de-duplicated -- anything not a string in
    `VALID_CIVITAI_TYPES` is DROPPED rather than forwarded raw (same
    "unrecognised falls back to safe, never reaches the wire unchecked"
    posture `clean_level` already gives the browsing-level filter). Non-list
    input (a bare string, `None`, a dict, ...) -> `[]`. Never raises."""
    if not isinstance(values, list):
        return []
    out: List[str] = []
    seen = set()
    for value in values:
        if isinstance(value, str) and value in VALID_CIVITAI_TYPES and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def clean_base_models(values: Any) -> List[str]:
    """A client-supplied `base_model` filter -> the cleaned list, in the
    order given, de-duplicated -- same SHAPE-only posture `clean_types`
    gives `types` (list in, list out, non-string/empty entries dropped,
    non-list input -> `[]`, never raises), but with NO fixed enum to
    validate against: unlike `types` (a small, closed, Civitai-enforced set
    -- an invalid value 400s the WHOLE search), Civitai's base-model values
    are free text drawn from a large and growing set (`js/shared/settings
    .mjs`'s `CIVITAI_SEARCH_BASE_MODEL_OPTIONS` is the UI's own quick-filter
    subset, deliberately NOT authoritative/closed -- its own comment: "an
    unlisted base model simply isn't offered as a quick filter", not
    "rejected"). So this only enforces the shape (a list of non-empty,
    stripped strings) rather than membership.

    Bug fix (2026-07-31, the M2b wire-contract mismatch): the frontend and
    backend were built in parallel against a contract that pinned the
    RESPONSE shape but not the REQUEST shape for this filter -- the modal
    sent a single comma-joined `base_models` (plural) value, the backend
    read a singular `base_model` key it never received, so the filter
    silently did nothing. This function -- and `build_search_url`'s own
    per-value `baseModels=` pairs below, mirroring `types` -- is the fix:
    ONE key (`base_model`, the SAME one the anchored panel already sends),
    ONE meaning, one-or-many REPEATED values, never comma-joined."""
    if not isinstance(values, list):
        return []
    out: List[str] = []
    seen = set()
    for value in values:
        if isinstance(value, str):
            text = value.strip()
            if text and text not in seen:
                seen.add(text)
                out.append(text)
    return out


def clean_level(value: Any) -> int:
    """A requested browsing level -> a valid member of `LEVEL_VALUES`, or
    `DEFAULT_LEVEL` (PG) for anything else -- same "garbage falls back to
    the default" tolerance `build_search_url` already gives `sort`/`period`,
    extended to the level query param (`api.py`'s `search_impl` is the only
    caller). Never raises: a non-numeric value, `None`, a bool, or a valid
    int that just isn't one of the five real levels (e.g. `32`/"Blocked",
    or a negative/garbage number) all fall back to PG -- the safe default,
    consistent with treating an unknown level as "not safe to assume above
    PG" everywhere else in this module.
    """
    if isinstance(value, bool):
        return DEFAULT_LEVEL
    try:
        value = int(value)
    except (TypeError, ValueError):
        return DEFAULT_LEVEL
    return value if value in LEVEL_VALUES else DEFAULT_LEVEL


def type_for_kind(kind: object) -> Optional[str]:
    """`kind` -> its Civitai `types` filter value, or `None` for anything
    not in the whitelist above -- same "never raises, never used raw"
    contract as `kinds.folder_for_kind`."""
    if not isinstance(kind, str):
        return None
    return TYPE_FOR_KIND.get(kind)


# docs/lora-loader-design.md M2b task 2: the REVERSE of `TYPE_FOR_KIND` -- a
# Civitai `type` string -> OUR kind, or absent when we don't have (yet) a
# folder for it. NOT auto-derived from `TYPE_FOR_KIND` above by inverting
# it: that forward map has `checkpoints` AND `unet` BOTH pointing at
# `"Checkpoint"` (a pragmatic choice for locking a SEARCH REQUEST to the
# closest available Civitai type when searching for standalone diffusion
# models -- see `TYPE_FOR_KIND`'s own comment), so it isn't a clean
# bijection and can't just be inverted. This is its own explicit, one-way
# table instead.
#
# Owner direction (coordinator, after this task's first draft): most
# Civitai types will eventually get a folder here -- this dict is the one
# place that ever grows, kept as a plain, flat, append-only table for
# exactly that reason (never inline a per-type `if`/`elif` anywhere else in
# this module or its callers). `kinds.KIND_TO_FOLDER`/`kinds.ACTIVE_KINDS`
# remain the single source of truth for which kinds exist/are wired at
# all -- this table only ever maps INTO that set, never invents a kind of
# its own.
#
# Three decisions worth naming for today's four entries, as the model for
# how a future addition should be justified:
#   - `Checkpoint` -> `checkpoints`, never `unet` -- Civitai's `Checkpoint`
#     type IS a full checkpoint file in the ordinary sense, and there is no
#     Civitai type that unambiguously means "standalone UNET/diffusion
#     weights" the way `TYPE_FOR_KIND`'s forward mapping (pragmatically)
#     treats them. `unet` is reachable here only via the literal `"UNet"`
#     type string (a real API value, VERIFIED 2026-07-31 -- see
#     `VALID_CIVITAI_TYPES`'s own comment).
#   - `LoCon` -> `loras`, DELIBERATELY (not an accident of string matching):
#     it's a LoRA-family variant that ComfyUI's own `LoraLoader` loads
#     straight out of `models/loras`, same as a plain `LORA` file, so a
#     result of that type can genuinely land there. (`LyCORIS` -- Civitai's
#     UI LABEL for this same family, not a real API value -- used to have
#     its own entry here too; removed 2026-07-31 once the API's own enum
#     confirmed it doesn't exist on the wire at all. See
#     `VALID_CIVITAI_TYPES`'s own comment for how that was verified.)
#   - `DoRA` -> `loras`, same reasoning as `LoCon` -- it's a LoRA variant
#     (weight-decomposed LoRA) that ComfyUI's `LoraLoader` also loads
#     straight out of `models/loras` (owner direction, 2026-07-31: "apply
#     the same standard" as `LoCon`/`LORA`).
#
# A type with NO entry here maps to `None` (see `kind_for_type` below) --
# the safety net that stops a Workflow JSON (or anything else we can't
# place) being written into `models/loras/`. Per the owner's own framing,
# that case is expected to become RARE (unsupported types are meant to be
# removed from the search options entirely) rather than something worth
# building further machinery around -- so nothing here tries to be clever
# about it beyond returning `None`.
KIND_FOR_TYPE: Dict[str, str] = {
    "LORA": "loras",
    "LoCon": "loras",
    "DoRA": "loras",
    "Checkpoint": "checkpoints",
    "UNet": "unet",
}


def kind_for_type(civitai_type: object) -> Optional[str]:
    """A Civitai `type` string (as carried on a search result / model
    record) -> our `kind`, or `None` when we have no folder for it (an
    unmapped type like `"Workflows"`, or anything not a recognised string at
    all) -- see `KIND_FOR_TYPE`'s own comment for the reasoning behind
    today's three entries and how a future one should be justified. Never
    raises."""
    if not isinstance(civitai_type, str):
        return None
    return KIND_FOR_TYPE.get(civitai_type)


def _clean_limit(limit: Any) -> int:
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(value, _MAX_LIMIT))


def build_search_url(
    host: str,
    kind: object,
    query: str,
    *,
    types: Optional[Sequence[str]] = None,
    base_model: Optional[Sequence[str]] = None,
    sort: str = DEFAULT_SORT,
    period: str = DEFAULT_PERIOD,
    nsfw: bool = False,
    cursor: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
) -> Optional[str]:
    """A full `https://<host>/api/v1/models?...` URL for this search, or
    `None` for a GIVEN but unwhitelisted `kind` -- the SAME short-circuit
    `kinds.folder_for_kind` already applies to local paths, extended here
    so a bad `kind` never even reaches Civitai (never mind a local
    filesystem). Pure string-building -- no network, no `folder_paths`.

    docs/lora-loader-design.md M2b task 1 -- `kind` is now OPTIONAL,
    reflecting the toolbar modal's UNSCOPED search (§7c: "the modal ...
    answers to nobody"):

      - `kind` given (either node-embedded picker, §7c-i: "type ... locked
        to the caller's kind") -- the SAME behaviour as before this task,
        byte for byte: exactly one `types` value, `type_for_kind(kind)`,
        and `types` (the parameter) is ignored -- the picker's kind IS the
        type filter, so a second, independent one would be a contradiction
        rather than an addition.
      - `kind` is `None` (the modal) -- no kind to lock to, so NO `types`
        parameter is sent at all UNLESS the caller passed one: `types` is
        then validated (`clean_types`, never forwarded raw) and, if
        anything survives validation, sent as one `types=` pair PER value
        -- Civitai's own multi-value filter convention. An empty/all-
        invalid `types` list (or none at all) means "every model type",
        which is the modal's actual default (§7c-i's table: only the
        picker's `type` filter is locked).

    `base_model` is now ALSO multi-value, the SAME "one key, repeated
    pairs" shape `types` uses -- fixed 2026-07-31 (the M2b wire-contract
    mismatch: the modal was sending one comma-joined value under a
    plural key nothing ever read, so the filter silently did nothing; see
    `clean_base_models`'s own docstring). A GIVEN list is cleaned
    (`clean_base_models` -- non-empty strings, de-duplicated, order
    preserved, no fixed enum: Civitai's own base-model values aren't a
    closed set the way `types` is) and, if anything survives, sent as one
    `baseModels=` pair PER value -- VERIFIED LIVE 2026-07-31 that Civitai's
    real endpoint accepts repeated `baseModels` pairs (an OR across the
    given values), the same convention `types` already uses. A single-
    element list (the anchored panel's own one `base_model=X`) emits
    exactly one `baseModels=X` pair -- byte-for-byte the same request this
    function sent before this fix, when `base_model` was a single string.

    Unknown/garbage `sort`/`period` values silently fall back to their
    defaults rather than being sent raw (`SORT_VALUES`/`PERIOD_VALUES`
    above) -- Civitai's own API would likely just ignore an invalid enum
    value, but validating here means the request we actually send always
    matches what we asked for.
    """
    if kind is not None:
        model_type = type_for_kind(kind)
        if model_type is None or folder_for_kind(kind) is None:
            return None
        type_values: List[str] = [model_type]
    else:
        type_values = clean_types(types)

    base_model_values = clean_base_models(base_model)

    params: List[tuple] = [("types", t) for t in type_values]
    params.extend([
        ("sort", sort if sort in SORT_VALUES else DEFAULT_SORT),
        ("period", period if period in PERIOD_VALUES else DEFAULT_PERIOD),
        ("limit", str(_clean_limit(limit))),
        ("nsfw", "true" if nsfw else "false"),
    ])
    if query:
        params.append(("query", str(query)))
    params.extend([("baseModels", bm) for bm in base_model_values])
    if cursor:
        params.append(("cursor", str(cursor)))
    return f"https://{host}/api/v1/models?{urllib.parse.urlencode(params)}"


def search_models(
    kind: object,
    query: str,
    *,
    types: Optional[Sequence[str]] = None,
    base_model: Optional[Sequence[str]] = None,
    sort: str = DEFAULT_SORT,
    period: str = DEFAULT_PERIOD,
    nsfw: bool = False,
    cursor: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
    api_key: Optional[str] = None,
    timeout: float = 30.0,
    max_body_bytes: int = 4 * 1024 * 1024,
    hosts: Sequence[str] = civitai_client.CIVITAI_HOSTS,
    opener=None,
) -> Dict[str, Any]:
    """The actual search request. Always `{"reason": "invalid_kind"|"found"|
    "offline", ...}` -- deliberately never `"notfound"`: an empty result
    LIST from a valid query is still a successful (`"found"`) search with
    `data["items"] == []`; a real Civitai 404 on this endpoint would be an
    actual server-side error, not "no matches", so `civitai_client.
    fetch_json_with_host_fallback`'s `notfound` outcome is folded into
    `offline`/`unknown` here rather than given a `notfound` meaning that
    would contradict "found with zero results".

    docs/lora-loader-design.md M2b task 1 -- `kind` is now OPTIONAL (the
    toolbar modal's unscoped search): `None` skips the whitelist check
    entirely (there's no kind to validate) and `build_search_url` sends no
    `types` parameter unless `types` is given -- see that function's own
    docstring for the full kind-given-vs-absent split, which this function
    defers to rather than duplicating. A GIVEN `kind` is validated exactly
    as before this task (unchanged behaviour, no regression).

    `base_model` is a LIST (fixed 2026-07-31, the M2b wire-contract
    mismatch -- see `clean_base_models`/`build_search_url`'s own doc
    comments): validated/de-duplicated and sent as one repeated
    `baseModels=` pair per value, never comma-joined. This function does no
    validation of its own -- `build_search_url` is the one place it
    happens, same as `types`.

    `api_key`, when given, rides along as Civitai's own `?token=` query
    parameter (documented alternative to an `Authorization` header) rather
    than a header -- this keeps `opener(url, timeout)`'s calling convention
    IDENTICAL to `civitai_client`'s (so every existing by-hash/by-id fake-
    opener test keeps working unmodified), and avoids threading a `headers=`
    parameter through the shared transport for exactly one caller. 🔒 The
    resulting URL (with the key embedded) is NEVER logged anywhere in this
    module or its caller (`api.py`'s `search_impl`) -- keep it that way.
    """
    if kind is not None and (type_for_kind(kind) is None or folder_for_kind(kind) is None):
        return {
            "reason": "invalid_kind",
            "offline_reason": None,
            "message": "Unknown or unsupported model kind.",
            "data": None,
        }

    def build_url(host: str) -> str:
        url = build_search_url(
            host, kind, query,
            types=types, base_model=base_model, sort=sort, period=period,
            nsfw=nsfw, cursor=cursor, limit=limit,
        )
        # A GIVEN `kind` was already validated (`type_for_kind`/
        # `folder_for_kind`) above; `kind is None` never makes
        # `build_search_url` return `None` either (see its own docstring) --
        # this assertion documents that invariant rather than silently
        # trusting it.
        assert url is not None
        if api_key:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}token={urllib.parse.quote(api_key)}"
        return url

    result = civitai_client.fetch_json_with_host_fallback(
        build_url,
        timeout=timeout,
        max_body_bytes=max_body_bytes,
        hosts=hosts,
        opener=opener,
        notfound_message="Civitai's search endpoint returned 404.",
    )
    if result["reason"] == "notfound":
        # See docstring -- a definitive 404 on the SEARCH endpoint isn't
        # "no results", it's unexpected; report it as an unknown-cause
        # offline failure rather than inventing a third meaning for
        # "notfound" that would contradict "found, zero results".
        return {"reason": "offline", "offline_reason": "unknown", "message": result["message"], "data": None}
    return result


def _clean_string_list(value: Any) -> List[str]:
    """A list-of-strings-ish field (`tags`, ...) -> a clean `List[str]` --
    tolerates the SAME `{"name": "..."}`-per-entry shape `civitai_parse.
    _clean_strings` already tolerates (seen on some Civitai endpoints for
    `tags`), rather than silently dropping every entry on a response shaped
    that way. Non-list input -> `[]`; never raises."""
    if not isinstance(value, list):
        return []
    out: List[str] = []
    for item in value:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict):
            text = str(item.get("name", "")).strip()
        else:
            continue
        if text:
            out.append(text)
    return out


def _clean_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


# docs/lora-loader-design.md, "The detail view" (2026-08-01): this file-list
# parse moved to `civitai_parse.parse_files` so `model_detail.
# fetch_model_detail`'s own new `files` key (the ⓘ panel's Download button)
# shares the EXACT same wire-shape rule rather than a second copy of this
# loop -- kept under this module's original private name (a plain alias, not
# a copy, same convention as `_parse_images` below) so every existing call
# site referencing `_parse_files` still resolves.
_parse_files = civitai_parse.parse_files


# docs/lora-loader-design.md §7c-iv (2026-07-31, "the ⓘ panel's candidates
# live in the sidecar"): this gallery-candidate parse moved to
# `civitai_parse.parse_gallery_images` so `parse_model_version`'s own new
# `images` key (the ⓘ panel's THIRD level-aware consumer) shares the EXACT
# same rule rather than a second copy of this loop -- kept under this
# module's original private name (a plain alias, not a copy, same
# convention as `civitai_parse._pick_thumbnail`'s own alias) so every
# existing call/comment below referencing `_parse_images` still resolves.
_parse_images = civitai_parse.parse_gallery_images


def pick_primary_file(files: Any) -> Optional[Dict[str, Any]]:
    """The file a plain "download this" action should use: the one Civitai
    marks `primary`, or the first file if none is (every real response has
    at least a primary file, but this degrades sanely if that's ever not
    true). `None` for an empty/non-list `files`."""
    if not isinstance(files, list) or not files:
        return None
    for f in files:
        if isinstance(f, dict) and f.get("primary"):
            return f
    return files[0] if isinstance(files[0], dict) else None


def _parse_version(v: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(v, dict):
        return None
    version_id = v.get("id")
    if not isinstance(version_id, int) or isinstance(version_id, bool):
        return None

    # `earlyAccessEndsAt` is Civitai's own field for a version still gated
    # behind early access (non-null while the gate is up); a version with no
    # such key at all -- the overwhelming common case -- is fully public.
    # This is a documented HEURISTIC, not a guarantee: the definitive answer
    # is always the download attempt itself, which is why `download.py`'s
    # `stream_download` ALSO maps a live 401/403 to its own `"key_required"`
    # reason regardless of what this flag said in advance (defense in depth,
    # never trusting a client-editable-in-transit search result alone for a
    # security-relevant decision). Shared with `model_detail.
    # fetch_model_detail` via `civitai_parse.is_version_gated` (2026-08-01) so
    # both paths compute the same gate status from the same raw shape rather
    # than two copies of this one-line rule.
    gated = civitai_parse.is_version_gated(v)

    return {
        "version_id": version_id,
        "name": str(v.get("name") or ""),
        "base_model": str(v.get("baseModel") or ""),
        "published_at": v.get("publishedAt") if isinstance(v.get("publishedAt"), str) else None,
        "gated": gated,
        "files": _parse_files(v.get("files"), gated=gated),
        # `trainedWords` -- Civitai's search endpoint DOES carry this
        # per-version (2026-07-30, the "no info sidecar" fix's own download-
        # time metadata reuse: `api.py`'s `_annotate_search_results`/
        # `civitai_parse.civitai_shape_from_search_meta` need it to seed a
        # `.civitai.info` sidecar without a fresh lookup).
        "triggers": _clean_string_list(v.get("trainedWords")),
        # The first non-adult gallery image's URL, UNTRANSFORMED (never the
        # thumbnail rewrite `_parse_images`'s own `images` list applies
        # below) -- kept exactly as it was: reused, as-is, to SAVE a local
        # preview file at download time, so a higher-fidelity image is
        # worth keeping. `None` when the gallery has no usable (non-adult)
        # image -- never invent one. The open questions about whether this
        # sidecar image should follow the browsing level, and what size it
        # should be saved at, are OUT OF SCOPE here (docs/lora-loader-
        # design.md §7c-iv) -- do not touch this key for that reason.
        "preview_url": civitai_parse.pick_gallery_image_url(v.get("images")),
        # docs/lora-loader-design.md §7c-iv, "Send the CANDIDATES to the
        # frontend, not one pre-chosen URL": the version's FULL gallery,
        # ordered exactly as Civitai returned it, each entry thumbnail-
        # rewritten (`_parse_images`) -- replaces the old single pre-chosen
        # `thumb_url` key entirely (deleted, not kept alongside this). Once
        # the browsing level became a per-user setting, picking ONE image
        # ahead of time stopped being a decision this layer can make --
        # only the frontend knows the viewer's chosen level, so it walks
        # this list itself ("first candidate at or below my level, falling
        # forward on failure"). Deliberately UNFILTERED by adult-ness,
        # unlike `preview_url` above -- see `_parse_images`'s own docstring.
        "images": _parse_images(v.get("images")),
    }


def _parse_search_item(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    model_id = item.get("id")
    if not isinstance(model_id, int) or isinstance(model_id, bool):
        return None

    versions_raw = item.get("modelVersions")
    versions: List[Dict[str, Any]] = []
    if isinstance(versions_raw, list):
        for v in versions_raw:
            parsed_version = _parse_version(v)
            if parsed_version is not None:
                versions.append(parsed_version)
    if not versions:
        return None  # nothing installable at all -- not a usable result

    stats = item.get("stats") if isinstance(item.get("stats"), dict) else {}
    creator = item.get("creator") if isinstance(item.get("creator"), dict) else {}

    result: Dict[str, Any] = {
        "model_id": model_id,
        "name": str(item.get("name") or ""),
        "type": str(item.get("type") or ""),
        "creator": str(creator.get("username") or ""),
        "tags": _clean_string_list(item.get("tags")),
        # `nsfw` -- Civitai's legacy bool. KEPT (nothing removed), but
        # nothing in this module or its callers may *decide* anything from
        # it any more: docs/lora-loader-design.md §7c-iv measured twelve
        # LoRAs from one query all reporting `nsfw: False` while carrying
        # `nsfwLevel` 15/23/31 -- the bool simply does not track adult
        # content reliably. `nsfw_level` below is the real signal.
        "nsfw": bool(item.get("nsfw")),
        # The model's own `nsfwLevel` -- a BITMASK UNION of every image in
        # its gallery (e.g. `31` means it has images at levels 1, 2, 4, 8
        # AND 16), NOT an ordinal severity score. **Never compare this to a
        # chosen level with `<=`/`>=`** -- that would silently misread e.g.
        # `31 > 4` as "entirely above R" when the model actually has PG
        # images too. `None` when the field is absent -- unknown, never
        # assumed safe (existing sidecars/cached search results predate
        # this field entirely).
        "nsfw_level": _clean_int(item.get("nsfwLevel")),
        "stats": {
            "downloads": _clean_int(stats.get("downloadCount")) or 0,
            "favorites": _clean_int(stats.get("favoriteCount")) or 0,
            "rating": stats.get("rating") if isinstance(stats.get("rating"), (int, float)) and not isinstance(stats.get("rating"), bool) else None,
        },
        "versions": versions,
    }

    # Flatten the PRIMARY version's (`versions[0]` -- `versions` is never
    # empty here, the "no usable version" case already returned `None`
    # above) `base_model` onto the top level, so a search-result CARD can
    # state a base model without a caller reaching into `versions` itself
    # (the frontend's `resultSubtitle` reads exactly this key). A model CAN
    # have versions on different base models, so this is deliberately a
    # claim about the primary version only, NOT "the model's base model" --
    # the per-version `base_model` above is untouched and stays the source
    # of truth for any version other than the primary one (a future
    # version-selector/detail view needs to be able to disagree with this
    # card-level value without that being a bug). "Omit rather than invent"
    # (docs/lora-loader-design.md §1a-vi): a primary version with no
    # `baseModel` at all leaves this key ABSENT, never a placeholder like
    # `"Unknown"` or an empty string -- `resultSubtitle`'s own comment
    # already commits to "a Civitai result with no `base_model` genuinely
    # has none".
    primary_base_model = versions[0]["base_model"]
    if primary_base_model:
        result["base_model"] = primary_base_model
    return result


def parse_search_response(raw: Any) -> Dict[str, Any]:
    """A Civitai `/api/v1/models` search response -> `{"results": [...],
    "next_cursor": str|None}`. Pure, offline-testable from recorded JSON --
    same convention as `civitai_parse.parse_model_version`. Never raises; a
    malformed/unexpected shape degrades to `{"results": [], "next_cursor":
    None}` rather than raising.

    Each result: `{model_id, name, type, creator, tags, nsfw, nsfw_level,
    base_model?, stats: {downloads, favorites, rating}, versions:
    [{version_id, name, base_model, published_at, gated, triggers,
    preview_url, images: [{url, nsfw_level, type}], files: [{name,
    size_kb, download_url, primary, sha256, gated}]}]}`. `nsfw_level`
    (model level) is a BITMASK UNION of the model's images, never an
    ordinal (`_parse_search_item`'s own comment has the full "never `<=`"
    reasoning). `preview_url`/`images` are BOTH derived from the same
    gallery but serve different consumers and must not be conflated
    (`_parse_version`'s own comment). `versions` keeps EVERY version Civitai
    returned (a future version-selector/detail view needs all of them, not
    just the newest) -- a result with no usable version at all (every
    version failed to parse, or the list was empty/absent) is DROPPED
    entirely, since a search result nobody could ever download from isn't
    useful. The top-level `base_model` is the PRIMARY version's (`versions
    [0]`) value flattened up a level for the search-result card -- see
    `_parse_search_item`'s own comment for why that's a distinct claim from
    "the model's base model" and why the key is ABSENT (never `""` or a
    placeholder) when the primary version has none. `installed`/`primary_*`
    convenience fields are NOT added here -- that requires touching local
    disk state (`download.destination_exists`) and belongs to `api.py`'s
    `search_impl`, which is the impure layer; this function stays offline-
    testable against recorded JSON alone.
    """
    if not isinstance(raw, dict):
        return {"results": [], "next_cursor": None}
    items = raw.get("items")
    if not isinstance(items, list):
        return {"results": [], "next_cursor": None}

    results: List[Dict[str, Any]] = []
    for item in items:
        parsed = _parse_search_item(item)
        if parsed is not None:
            results.append(parsed)

    next_cursor = None
    metadata = raw.get("metadata")
    if isinstance(metadata, dict):
        cursor = metadata.get("nextCursor")
        if isinstance(cursor, (str, int)) and not isinstance(cursor, bool) and cursor != "":
            next_cursor = str(cursor)

    return {"results": results, "next_cursor": next_cursor}


__all__ = (
    "TYPE_FOR_KIND",
    "KIND_FOR_TYPE",
    "SORT_VALUES",
    "PERIOD_VALUES",
    "DEFAULT_SORT",
    "DEFAULT_PERIOD",
    "DEFAULT_LIMIT",
    "LEVEL_VALUES",
    "DEFAULT_LEVEL",
    "VALID_CIVITAI_TYPES",
    "type_for_kind",
    "kind_for_type",
    "clean_level",
    "clean_types",
    "clean_base_models",
    "build_search_url",
    "search_models",
    "pick_primary_file",
    "parse_search_response",
)
