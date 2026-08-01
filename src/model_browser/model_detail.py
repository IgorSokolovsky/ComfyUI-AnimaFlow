"""Backend orchestration for the model/version DETAIL VIEW
(`docs/lora-loader-design.md` §7c-ii / §7d-i / "The detail view"). One
component, mounted twice per that section's own table ("the modal's detail
view ... is also the picker's") -- this module is the ONE place that fetches
what neither mount already holds from its own search result: the per-
VERSION description + the author's own prompt-carrying gallery (fetched
fresh whenever the user switches versions, since each version's own gallery
differs), and the per-MODEL description (fetched once per model, the same
`lookup.py`'s `_augment_with_model_description` fallback the ⓘ panel already
relies on -- ported here standalone, since a search result may not
correspond to a local file/sidecar at all: the whole point of this view is
that you're looking at a model you might not have downloaded yet).

**No `kind`/local filesystem path is ever involved here**, unlike every
other route in `api.py` (that module's own top doc comment) -- this is a
pure Civitai proxy by `(model_id, version_id)`. It never resolves or writes
a path, so `kinds.folder_for_kind`'s whitelist has nothing to guard: there is
no destination string a hostile `kind` could redirect. The SSRF posture is
unchanged regardless -- both ids are validated as plain positive ints
(`_clean_positive_int`) before either ever reaches a URL, and the actual
request goes through `civitai_client.fetch_json_with_host_fallback`'s own
allow-listed-host transport (`civitai.com`/`civitai.red` only), the exact
same transport `lookup_by_hash`/`search_models` already use.

Always returns `{"reason": "found"|"notfound"|"offline", "message": str,
"offline_reason": str|None, "model_description": str|None,
"model_description_checked": bool, "version_description": str|None,
"gallery": [...], "files": [...]}` -- the same "reason" vocabulary every
other Civitai route in this package commits to (`api.py`'s own top doc
comment), never raises.

`files` (added 2026-08-01, to unblock the ⓘ panel's deleted-model Download
button -- `fa27ca1`'s frontend rewire to a real server-side download job
had nothing to render a button FROM, since this route never sent a file
list at all) is the SELECTED version's own `files` array, in the wire shape
`civitai_search.py`'s own search path already emits for the very same
field -- `[{name, download_url, size_kb, primary, sha256, gated}, ...]` --
via `civitai_parse.parse_files` (moved there from that module's private
`_parse_files` specifically so this route reuses it rather than forking a
second parser for the same shape). A version with no files (or none that
parsed) yields `[]`, never a fabricated entry ("omit rather than invent",
§1a-vi) -- the frontend's own `pickPrimaryDownloadFile` already renders no
button in that case.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from . import civitai_client
from . import civitai_parse


def _clean_positive_int(value: Any) -> Optional[int]:
    """A model/version id -> a clean positive `int`, or `None` -- rejects
    bools/floats/dicts/lists/garbage/non-positive values, mirroring
    `civitai_parse._clean_id`'s own tolerance (a hand-edited query string or
    a stale client is never trusted raw). Never raises."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str) and value.isdigit():
        parsed = int(value)
        return parsed if parsed > 0 else None
    return None


def _empty_result(
    reason: str, message: str, *,
    offline_reason: Optional[str] = None,
    model_description_checked: bool = False,
) -> Dict[str, Any]:
    return {
        "reason": reason,
        "message": message,
        "offline_reason": offline_reason,
        "model_description": None,
        "model_description_checked": model_description_checked,
        "version_description": None,
        "gallery": [],
        "files": [],
    }


def fetch_model_detail(model_id: Any, version_id: Any) -> Dict[str, Any]:
    """Fetches the things a caller's own search result doesn't already carry
    for the SELECTED version: `version_description` + the author's prompt-
    carrying `gallery` + the version's own `files` list (all three from
    `civitai_client.lookup_model_version_by_id(version_id)`), and
    `model_description` (from a fallback `civitai_client.
    lookup_model_by_id(model_id)` call, exactly `lookup.py`'s
    `_augment_with_model_description` -- no sidecar caching here, since there
    may be no local file at all yet to cache alongside).

    `version_id` is the one thing this call genuinely can't proceed without
    (§2b: "the by-hash lookup is per version" -- extended here to "the
    detail view is per version" for the same reason) -- a missing/garbage
    one is `"notfound"` with no network call at all. `model_id` is used only
    for the description fallback; a missing/garbage one just means that
    fallback can never run (`model_description_checked=True` -- there's
    nothing left to ever ask, matching `lookup.py`'s own
    `_finalize_descriptions` rule for "no `model_id` to ever fetch by").

    `model_description_checked` (§7d-i's own wire contract, reused verbatim
    for this route): `True` once Civitai has given a DEFINITIVE answer for
    the model description (found, with or without a usable one; a definitive
    notfound; or there was never a `model_id` to ask by) -- `False` only when
    a fetch that COULD supply it hasn't resolved (a transient offline
    failure). `version_description` needs no such flag: it comes straight off
    the SAME version response that supplies everything else here, with no
    separate fetch of its own.

    A transient failure fetching the MODEL description never fails this
    whole call -- the version data (description + gallery) is independently
    useful, so a caller still gets `"reason": "found"` with
    `model_description` simply absent and `model_description_checked=False`
    (the caller can retry later, same as the ⓘ panel's own "not looked up
    yet" state).
    """
    version_id_clean = _clean_positive_int(version_id)
    if version_id_clean is None:
        return _empty_result(
            "notfound", "No model version to look up.",
            model_description_checked=_clean_positive_int(model_id) is None,
        )

    version_result = civitai_client.lookup_model_version_by_id(version_id_clean)
    if version_result["reason"] == "offline":
        return _empty_result(
            "offline", version_result.get("message", ""),
            offline_reason=version_result.get("offline_reason"),
        )
    if version_result["reason"] == "notfound":
        return _empty_result("notfound", version_result.get("message", ""))

    raw_version = version_result["data"] if isinstance(version_result.get("data"), dict) else {}
    parsed = civitai_parse.parse_model_version(raw_version)
    gallery = civitai_parse.parse_author_gallery(raw_version.get("images"))
    # Same wire shape `civitai_search.py`'s own search path emits for this
    # field, via the SAME shared parser (`civitai_parse.parse_files`) and the
    # SAME gate-status rule (`civitai_parse.is_version_gated`) -- see this
    # function's own docstring for why this route needed it at all.
    files = civitai_parse.parse_files(
        raw_version.get("files"), gated=civitai_parse.is_version_gated(raw_version),
    )

    model_description = parsed.get("model_description")
    model_id_clean = _clean_positive_int(model_id)
    if model_id_clean is None:
        # `parse_model_version` sometimes recovers a `model_id` off the
        # version response itself (`obj["modelId"]`) even when the caller
        # didn't pass one -- prefer that before giving up on the fallback
        # fetch entirely.
        model_id_clean = parsed.get("model_id")

    if model_description:
        model_description_checked = True
    elif model_id_clean is None:
        model_description_checked = True  # nothing left to ever ask by
    else:
        model_result = civitai_client.lookup_model_by_id(model_id_clean)
        if model_result["reason"] == "offline":
            model_description_checked = False
        else:
            # A definitive "found" (with or without a usable description) or
            # a definitive "notfound" -- either way, genuinely known now.
            model_description_checked = True
            if model_result["reason"] == "found" and isinstance(model_result.get("data"), dict):
                model_description = civitai_parse.parse_model_description(model_result["data"])

    return {
        "reason": "found",
        "message": "",
        "offline_reason": None,
        "model_description": model_description,
        "model_description_checked": model_description_checked,
        "version_description": parsed.get("version_description"),
        "gallery": gallery,
        "files": files,
    }


__all__ = ("fetch_model_detail",)
