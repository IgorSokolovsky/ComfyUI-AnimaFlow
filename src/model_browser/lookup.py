"""Orchestrates one Civitai lookup: sidecar -> hash -> fetch -> sidecar write
(docs/lora-loader-design.md §2b/§7e). `lookup_model_info` is the one
function a route/consumer should call -- it ALWAYS returns a dict carrying a
`reason` of `found` / `notfound` / `offline` (plus a specific
`offline_reason` sub-cause whenever it's `offline`), never raises, and never
opens a socket at all unless the sidecar is missing or a refresh was asked
for -- or unless `cached_only` is set, in which case it can NEVER open a
socket at all, missing sidecar or not (see `cached_only`'s own doc below).
"""
from __future__ import annotations

import logging
from typing import Any, Dict

from . import civitai_client, civitai_parse, hashing, sidecar
from . import download as download_mod
from . import logs as logs_mod
from .local import find_preview_path, resolve_model_path

# One logger for the whole feature (`logs.py`'s own docstring).
_logger = logging.getLogger(logs_mod.LOGGER_NAME)


def _augment_with_model_description(
    parsed: Dict[str, Any],
    raw: Dict[str, Any],
    *,
    cached_only: bool,
) -> "tuple[Dict[str, Any], bool]":
    """BUG 2 (2026-07-29 owner report): `parsed["model_description"]` is the
    MODEL's own write-up (`civitai_parse.parse_model_version`'s own key),
    but the by-hash endpoint's embedded `model` object almost never actually
    carries one (verified live, 2026-07-29: it's `{name, type, nsfw, poi}`
    only) -- so a `parsed` with a `model_id` but no `model_description`
    almost always means "we haven't fetched the model's own page yet", not
    "this LoRA genuinely has no author write-up". One extra call,
    `civitai_client.lookup_model_by_id` (public, no key -- §2b's same
    rules), fetches it; a hit is folded BOTH into the returned `parsed` AND
    into `raw` (the sidecar's own on-disk shape, under `model.description`,
    matching the real Civitai response's own key) so the very next read --
    cache hit or not -- already has it, per the task's "caching it into the
    existing sidecar" instruction.

    Returns `(parsed, raw_changed)` -- the caller re-writes the sidecar only
    when `raw_changed` is true, so a call that changes nothing (already had
    a model description, no `model_id` to ask about, or `cached_only`)
    never triggers a pointless disk write.

    Never reached when `cached_only` (the same network-policy gate
    `lookup_model_info` enforces everywhere else in this module) -- and
    never raises, mirroring every other function in this module: a failed/
    offline fetch here just leaves `parsed` without a model description,
    exactly like any other Civitai data that couldn't be fetched.

    A "once-only" marker (`raw["_wtn_model_description_checked"]`) is set
    once Civitai has given a DEFINITIVE answer (found, with or without a
    usable description, or a definitive 404/notfound) -- so a model that
    genuinely has no description is never re-asked on every panel open. A
    transient failure (timeout/DNS/rate-limit) does NOT set it, so a later
    open tries again instead of being stuck. `_finalize_descriptions`
    (below) turns this raw-sidecar marker into the public
    `model_description_checked` flag a caller can render on.

    §7d-i (owner, 2026-07-30): `model_description` and `version_description`
    are independent fields since `civitai_parse.parse_model_version` stopped
    collapsing them (BUG 11b) -- so the gate below only ever looks at
    `model_description`. A version description existing can no longer
    suppress this fetch (that WAS the bug: the pre-BUG-11b gate read a
    single shared `description` key, so a present version note skipped the
    fetch that gets the real write-up, most of the time). There is nothing
    left to regress here because there is no shared key to gate on any more.
    """
    if parsed.get("model_description") or cached_only:
        return parsed, False
    if raw.get("_wtn_model_description_checked"):
        return parsed, False
    model_id = parsed.get("model_id")
    if model_id is None:
        return parsed, False

    result = civitai_client.lookup_model_by_id(model_id)
    if result.get("reason") == "offline":
        # Transient -- retry on a later open rather than giving up for good.
        return parsed, False

    # "found" (with or without a usable description) or a definitive
    # "notfound" -- either way we now genuinely know the answer.
    raw["_wtn_model_description_checked"] = True
    if result.get("reason") == "found" and isinstance(result.get("data"), dict):
        description = civitai_parse.parse_model_description(result["data"])
        if description:
            parsed["model_description"] = description
            model_obj = raw.get("model")
            if not isinstance(model_obj, dict):
                model_obj = {}
                raw["model"] = model_obj
            model_obj["description"] = description
    return parsed, True


def _finalize_descriptions(parsed: Dict[str, Any], raw: Dict[str, Any]) -> Dict[str, Any]:
    """§7d-i: attach the public `model_description_checked` flag -- the
    thing that lets a caller distinguish "genuinely no model description"
    from "haven't asked Civitai yet", per field. (`version_description` needs
    no equivalent flag: it comes straight off the SAME by-hash response that
    produced everything else in `parsed`, with no separate fetch of its own
    -- by the time `parsed` exists at all, its value is already final.)

    `True` when any of the following holds -- i.e. there is genuinely
    nothing further this lookup could ever learn about `model_description`:

      - `model_description` is already present (whatever supplied it).
      - The model-id fallback fetch (`_augment_with_model_description`) has
        reached a DEFINITIVE answer at some point, recorded in the raw
        sidecar shape as `_wtn_model_description_checked` -- covers "ran
        just now" and "ran on an earlier open", both.
      - There is no `model_id` to ever fetch by in the first place -- the
        fallback fetch can never run for this record, on this open or any
        future one, so there is nothing left to "not yet" about.

    `False` only when a fetch that COULD supply the answer hasn't happened
    yet: `cached_only` skipped it, or a transient failure (timeout/DNS/
    rate-limit) left it unresolved for a later open to retry.
    """
    checked = (
        bool(parsed.get("model_description"))
        or bool(raw.get("_wtn_model_description_checked"))
        or parsed.get("model_id") is None
    )
    parsed["model_description_checked"] = checked
    return parsed


def lookup_model_info(
    kind: object,
    name: Any,
    *,
    force_refresh: bool = False,
    cached_only: bool = False,
) -> Dict[str, Any]:
    """One model's Civitai info, cache-first.

      - `kind`/`name` don't resolve to a real, guarded local file -> offline
        (`offline_reason="missing_file"`) -- there's nothing to hash and
        nothing to display, and this is deliberately NOT its own top-level
        `reason` value: the caller's `reason`/`offline_reason` switch never
        needs a fifth branch just for this.
      - A cached sidecar exists (checked regardless of `force_refresh` when
        `cached_only` is set -- see below) -> `found`, parsed straight from
        the cached RAW response, no network at all.
      - Otherwise: hash the file, ask Civitai
        (`civitai_client.lookup_by_hash`), and on a genuinely usable
        `found` result (§2b: no `trainedWords`/no `model.name` still
        counts), cache the RAW response to the sidecar so the next call is
        free. A response that comes back 200 but parses to nothing usable
        at all degrades to `notfound`, matching upstream's own rule at
        `../ComfyUI-Pixaroma/server_routes.py:2205-2206`, inside
        `api_lora_civitai` (`:2131-2209`).

    `cached_only` (docs/lora-loader-design.md §7d/§7b decision 20, added for
    the "Civitai" ⚙/Settings switch being off): when set, the cache-check
    block below runs UNCONDITIONALLY (even if `force_refresh` was also
    passed -- `cached_only` wins, since "only ever read the sidecar" is a
    stronger constraint than "skip the sidecar"), and a cache MISS returns
    immediately, right here, before `hashing.sha256_file` or
    `civitai_client.lookup_by_hash` are ever reached. That is what makes
    decision 20's "no path left from which a request could originate" literal
    rather than a UI-layer promise: with this flag set, the function's own
    control flow makes the network-reaching code UNREACHABLE, not merely
    unused. The miss case returns `reason="offline"`,
    `offline_reason="civitai_disabled"` -- distinct from every genuine
    network-failure reason, since nothing was actually attempted.
    """
    def _emit(result: Dict[str, Any]) -> Dict[str, Any]:
        """Summary-level: exactly ONE `found`/`notfound`/`offline` line per
        call, whatever branch produced `result` -- every `return` below
        goes through this instead of returning its dict directly, so no
        branch can be added later without also being covered (task:
        "a lookup (found/notfound/offline)"). Returns `result` unchanged;
        `logs.log_summary` itself never raises and does nothing at `off`.
        """
        logs_mod.log_summary(
            _logger, logs_mod.format_lookup_summary,
            kind=kind, name=name, reason=result.get("reason"), offline_reason=result.get("offline_reason"),
        )
        return result

    path = resolve_model_path(kind, name)
    if path is None:
        return _emit({
            "reason": "offline",
            "offline_reason": "missing_file",
            "message": "That model file could not be found locally.",
            "data": None,
        })

    if not force_refresh or cached_only:
        cached = sidecar.read_sidecar(path)
        # Debug-only: "cache hit vs miss on the sidecar" (task's own
        # phrasing) -- a hit/miss on the SIDECAR FILE itself, independent of
        # whether it goes on to parse to something usable (that's a
        # separate, rarer failure the `if parsed:` branch below already
        # handles by falling through to a fresh fetch).
        logs_mod.log_debug(_logger, logs_mod.format_lookup_cache_debug, name=name, hit=cached is not None)
        if cached is not None:
            parsed = civitai_parse.parse_model_version(cached)
            if parsed:
                # BUG 2 -- top up a cached record that's missing a MODEL
                # description (common: the by-hash sidecar's `model` object
                # almost never carries one) with the one-time model-id
                # fallback fetch, re-caching the raw sidecar only if it
                # actually changed.
                parsed, changed = _augment_with_model_description(parsed, cached, cached_only=cached_only)
                if changed:
                    sidecar.write_sidecar(path, cached)
                    logs_mod.log_debug(_logger, logs_mod.format_sidecar_write_debug, name=name)
                return _emit({
                    "reason": "found",
                    "offline_reason": None,
                    "message": "",
                    "data": _finalize_descriptions(parsed, cached),
                    "source": "sidecar",
                })

    if cached_only:
        # No sidecar (or nothing usable in it) -- STOP HERE. Reaching
        # `hashing.sha256_file`/`civitai_client.lookup_by_hash` below would
        # be exactly the outbound request `cached_only` exists to make
        # impossible, regardless of what `force_refresh` said.
        return _emit({
            "reason": "offline",
            "offline_reason": "civitai_disabled",
            "message": "Civitai is turned off, and nothing is cached for this file yet.",
            "data": None,
        })

    try:
        sha = hashing.sha256_file(path)
    except OSError as exc:
        return _emit({
            "reason": "offline",
            "offline_reason": "unreadable",
            "message": f"Could not read the file to hash it: {exc}",
            "data": None,
        })

    result = civitai_client.lookup_by_hash(sha)
    if result["reason"] == "offline":
        return _emit({**result, "data": None})
    if result["reason"] == "notfound":
        return _emit({
            "reason": "notfound",
            "offline_reason": None,
            "message": result.get("message", ""),
            "data": None,
        })

    # result["reason"] == "found"
    parsed = civitai_parse.parse_model_version(result["data"])
    if not parsed:
        # A 200 that parsed to nothing usable at all -- matches upstream's
        # own "if not parsed: notfound" rule (this function's own docstring).
        return _emit({"reason": "notfound", "offline_reason": None, "message": "", "data": None})

    # BUG 2 -- same one-time description top-up as the cache-hit branch
    # above, applied to the freshly-fetched raw response before it's cached.
    # `cached_only` is always False on this branch (the function returns
    # earlier when it's set), passed through for defensiveness only.
    parsed, _ = _augment_with_model_description(parsed, result["data"], cached_only=cached_only)
    sidecar.write_sidecar(path, result["data"])
    logs_mod.log_debug(_logger, logs_mod.format_sidecar_write_debug, name=name)
    return _emit({
        "reason": "found",
        "offline_reason": None,
        "message": "",
        "data": _finalize_descriptions(parsed, result["data"]),
        "source": "civitai",
    })


def save_preview(
    kind: object,
    name: Any,
    preview_url: Any,
    *,
    opener: Any = None,
) -> Dict[str, Any]:
    """"Save this preview URL for this model" -- docs/lora-loader-design.md
    §7c-iv, "The ⓘ backfill must save the image too": a model identified
    only through a Civitai hash lookup gets its metadata cached
    (`lookup_model_info`) but never an image, so its thumbnail re-fetches
    from Civitai on every render, forever -- and is the direct cause of a
    404 on `/wtn/model_browser/thumb`, which serves the *local* preview
    file that nothing had ever written. This closes that gap: called by the
    frontend right after a lookup resolves, with the URL of the CANDIDATE
    it is already displaying (level-filtered by construction -- this
    function stays entirely level-agnostic, same reasoning `download.
    finalize_successful_download`'s own docstring gives for the identical
    choice on the download path: one rule, one place, never taught here a
    second time).

    Same kind-whitelist + containment guard as every other route: `name`
    must resolve to a real, guarded local file (`local.resolve_model_path`)
    before anything else happens.

    ALWAYS returns `{"reason": ..., "message": str, "saved": bool,
    "detail": str|None, "path": str|None}`, never raises:

      - `not_found`             -- `(kind, name)` doesn't resolve to a real
        local file.
      - `ok`, `saved=False`     -- a correct NO-OP, never an error:
          * `detail="no_url"`             -- no `preview_url` at all, or not
            a non-empty string. Correct behaviour, not a failure.
          * `detail="already_present"`    -- a preview already sits next to
            the model (`local.find_preview_path`) -- NEVER overwritten,
            whoever wrote it is the owner of that file now.
          * `detail="fetch_failed"`       -- `download.fetch_preview_image`
            (never raises on its own) came back empty-handed for any
            reason. The metadata this lookup already resolved is the
            valuable part; a failed image fetch must never fail THIS call.
      - `ok`, `saved=True`      -- the preview file now exists at `path`.

    `opener` is the same injectable network seam `download.
    fetch_preview_image` already exposes for its own tests -- threaded
    straight through, `None` meaning "use the real network".
    """
    def _result(reason: str, saved: bool, *, detail: Any = None, path: Any = None, message: str = "") -> Dict[str, Any]:
        return {"reason": reason, "message": message, "saved": saved, "detail": detail, "path": path}

    model_path = resolve_model_path(kind, name)
    if model_path is None:
        return _result("not_found", False, message="That model file could not be found locally.")

    if not isinstance(preview_url, str) or not preview_url:
        logs_mod.log_summary(_logger, logs_mod.format_preview_summary, status="skipped", detail="no preview URL")
        return _result("ok", False, detail="no_url")

    if find_preview_path(model_path) is not None:
        # A file on disk is the user's, whatever wrote it -- never clobber it.
        logs_mod.log_summary(_logger, logs_mod.format_preview_summary, status="skipped", detail="already present")
        return _result("ok", False, detail="already_present")

    saved_path = download_mod.fetch_preview_image(preview_url, model_path, opener=opener)
    if saved_path is None:
        logs_mod.log_summary(_logger, logs_mod.format_preview_summary, status="failed")
        return _result("ok", False, detail="fetch_failed")

    logs_mod.log_summary(_logger, logs_mod.format_preview_summary, status="saved", detail=saved_path)
    return _result("ok", True, path=saved_path)


def forget_cached(kind: object, name: Any) -> bool:
    """"Forget cached" -- delete the sidecar for this model, so its info
    reverts to file-derived metadata (or a fresh Civitai lookup next time).
    `False` when the model itself can't be resolved (nothing to forget);
    `sidecar.delete_sidecar`'s own result otherwise."""
    path = resolve_model_path(kind, name)
    if path is None:
        return False
    return sidecar.delete_sidecar(path)


__all__ = ("lookup_model_info", "forget_cached", "save_preview")
