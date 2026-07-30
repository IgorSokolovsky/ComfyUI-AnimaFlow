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

`type` is ALWAYS derived from the caller's `kind` via `TYPE_FOR_KIND`
(§7c-i: "type... locked to the caller's kind" for the two node-embedded
pickers) -- callers never pass a raw Civitai `type` string, so an
unwhitelisted `kind` can't smuggle an arbitrary `types=` value into the
request either, extending `kinds.py`'s whitelist discipline to the search
request the same way it already applies to every local path.
"""
from __future__ import annotations

import urllib.parse
from typing import Any, Dict, List, Optional, Sequence

from . import civitai_client
from .kinds import folder_for_kind

# kind -> Civitai's own `types` filter value (§7a's table, extended to the
# search request). Only `loras` is reachable from a live route today
# (`kinds.ACTIVE_KINDS`) -- `checkpoints`/`unet` are kept, unused, for the
# same "wire kind day one, activate later" reason `kinds.py` states for its
# own `KIND_TO_FOLDER`.
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


def type_for_kind(kind: object) -> Optional[str]:
    """`kind` -> its Civitai `types` filter value, or `None` for anything
    not in the whitelist above -- same "never raises, never used raw"
    contract as `kinds.folder_for_kind`."""
    if not isinstance(kind, str):
        return None
    return TYPE_FOR_KIND.get(kind)


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
    base_model: Optional[str] = None,
    sort: str = DEFAULT_SORT,
    period: str = DEFAULT_PERIOD,
    nsfw: bool = False,
    cursor: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
) -> Optional[str]:
    """A full `https://<host>/api/v1/models?...` URL for this search, or
    `None` for an unwhitelisted `kind` -- the SAME short-circuit
    `kinds.folder_for_kind` already applies to local paths, extended here
    so a bad `kind` never even reaches Civitai (never mind a local
    filesystem). Pure string-building -- no network, no `folder_paths`.

    Unknown/garbage `sort`/`period` values silently fall back to their
    defaults rather than being sent raw (`SORT_VALUES`/`PERIOD_VALUES`
    above) -- Civitai's own API would likely just ignore an invalid enum
    value, but validating here means the request we actually send always
    matches what we asked for.
    """
    model_type = type_for_kind(kind)
    if model_type is None or folder_for_kind(kind) is None:
        return None

    params: List[tuple] = [
        ("types", model_type),
        ("sort", sort if sort in SORT_VALUES else DEFAULT_SORT),
        ("period", period if period in PERIOD_VALUES else DEFAULT_PERIOD),
        ("limit", str(_clean_limit(limit))),
        ("nsfw", "true" if nsfw else "false"),
    ]
    if query:
        params.append(("query", str(query)))
    if base_model:
        params.append(("baseModels", str(base_model)))
    if cursor:
        params.append(("cursor", str(cursor)))
    return f"https://{host}/api/v1/models?{urllib.parse.urlencode(params)}"


def search_models(
    kind: object,
    query: str,
    *,
    base_model: Optional[str] = None,
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

    `api_key`, when given, rides along as Civitai's own `?token=` query
    parameter (documented alternative to an `Authorization` header) rather
    than a header -- this keeps `opener(url, timeout)`'s calling convention
    IDENTICAL to `civitai_client`'s (so every existing by-hash/by-id fake-
    opener test keeps working unmodified), and avoids threading a `headers=`
    parameter through the shared transport for exactly one caller. 🔒 The
    resulting URL (with the key embedded) is NEVER logged anywhere in this
    module or its caller (`api.py`'s `search_impl`) -- keep it that way.
    """
    if type_for_kind(kind) is None or folder_for_kind(kind) is None:
        return {
            "reason": "invalid_kind",
            "offline_reason": None,
            "message": "Unknown or unsupported model kind.",
            "data": None,
        }

    def build_url(host: str) -> str:
        url = build_search_url(
            host, kind, query,
            base_model=base_model, sort=sort, period=period,
            nsfw=nsfw, cursor=cursor, limit=limit,
        )
        # `type_for_kind`/`folder_for_kind` were already checked above, so
        # `build_search_url` cannot return `None` here -- this assertion
        # documents that invariant rather than silently trusting it.
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


def _parse_files(files_raw: Any, *, gated: bool) -> List[Dict[str, Any]]:
    if not isinstance(files_raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for f in files_raw:
        if not isinstance(f, dict):
            continue
        name = f.get("name")
        download_url = f.get("downloadUrl")
        if not isinstance(name, str) or not name:
            continue
        if not isinstance(download_url, str) or not download_url:
            continue
        hashes = f.get("hashes") if isinstance(f.get("hashes"), dict) else {}
        size_kb = f.get("sizeKB")
        sha256 = hashes.get("SHA256")
        out.append({
            "name": name,
            "size_kb": size_kb if isinstance(size_kb, (int, float)) and not isinstance(size_kb, bool) else None,
            "download_url": download_url,
            "primary": bool(f.get("primary")),
            "sha256": str(sha256) if isinstance(sha256, str) and sha256 else None,
            # The version's gate status, copied onto every one of its files
            # so a caller never has to cross-reference the parent version --
            # a file is exactly as gated as the version it belongs to.
            "gated": gated,
        })
    return out


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
    # security-relevant decision).
    gated = bool(v.get("earlyAccessEndsAt"))

    return {
        "version_id": version_id,
        "name": str(v.get("name") or ""),
        "base_model": str(v.get("baseModel") or ""),
        "published_at": v.get("publishedAt") if isinstance(v.get("publishedAt"), str) else None,
        "gated": gated,
        "files": _parse_files(v.get("files"), gated=gated),
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
        "nsfw": bool(item.get("nsfw")),
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

    Each result: `{model_id, name, type, creator, tags, nsfw, base_model?,
    stats: {downloads, favorites, rating}, versions: [{version_id, name,
    base_model, published_at, gated, files: [{name, size_kb, download_url,
    primary, sha256, gated}]}]}`. `versions` keeps EVERY version Civitai
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
    "SORT_VALUES",
    "PERIOD_VALUES",
    "DEFAULT_SORT",
    "DEFAULT_PERIOD",
    "DEFAULT_LIMIT",
    "type_for_kind",
    "build_search_url",
    "search_models",
    "pick_primary_file",
    "parse_search_response",
)
