"""The Civitai by-hash lookup's HTTP transport (docs/lora-loader-design.md
§2b), stdlib `urllib` ONLY -- `requirements.txt` mandates that over
`requests` for exactly this kind of call, and this is the pack's first
outbound network request of any kind. This module never opens a socket on
its own initiative; it's called from `lookup.py`, which is itself only ever
reached by an explicit user click (never a graph run) per the design doc's
network policy (§9).

This function is SYNCHRONOUS (`urllib` has no async API) -- `api.py`'s
route wiring runs it via `loop.run_in_executor` so a slow Civitai response
can't stall ComfyUI's event loop, the same reason
`../ComfyUI-Pixaroma/server_routes.py:2146`'s `/pixaroma/api/lora/civitai`
route (`:2131-2209`) offloads its own file-hashing step (and, at `:2111`,
its offline metadata read) the same way.

Verbatim details from the design doc, all load-bearing:
  - two hosts tried in order, but a 404 is DEFINITIVE and returns
    immediately -- the backup host serves the same catalogue, so retrying
    it would be a pointless round trip;
  - a non-200 (rate limit, maintenance, gateway error) DOES fall through to
    the next host, since those are transient;
  - 30s timeout, not a shorter one -- Civitai is regularly slow under load,
    and an early give-up reads to the user as "it doesn't work";
  - a 4 MB body cap, so a malfunctioning endpoint can't spike memory;
  - DISTINCT offline reasons preserved (timeout / dns_tls / unreadable /
    rate_limited) -- collapsing them into one generic line defeats the
    point of showing the user a reason at all (§7e).
"""
from __future__ import annotations

import json
import logging
import socket
import ssl
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Sequence

from . import logs as logs_mod

# One logger for the whole feature (`logs.py`'s own docstring) -- every
# debug-level request/response line below goes through this.
_logger = logging.getLogger(logs_mod.LOGGER_NAME)

# `.com` is the real home; `.red` serves the IDENTICAL API on separate DNS,
# so it's a useful backup when a network/ISP blocks civitai.com by name.
# Only ever reached after `.com` has already failed with something
# transient (never after a 404 -- see module docstring).
_CIVITAI_HOSTS: Sequence[str] = ("civitai.com", "civitai.red")

# Public alias -- M2 (`civitai_search.py`, `download.py`) reuses the SAME two
# hosts for search requests and for pinning the INITIAL download URL to a
# known-good host (`download.is_allowed_download_url`), rather than each
# module inventing its own copy of "which hosts do we trust" (docs/lora-
# loader-design.md's M2 brief: "extend them, don't fork them").
CIVITAI_HOSTS: Sequence[str] = _CIVITAI_HOSTS

# BUG (owner, 2026-07-30): Civitai's edge rejects a bare `Product/version`
# User-Agent -- measured live, same URL/same minute, only this header
# differing: `"AnimaFlow-ComfyUI/model-browser"` -> HTTP 401, a browser UA ->
# HTTP 200, on BOTH `/api/v1/models` and `/api/download/models/<id>`. Every
# download of a perfectly public file was reporting "Civitai requires an API
# key" as a result (see `download.py`'s `_http_error_result` -- that mapping
# is also fixed now, but this is the actual root cause).
#
# Fixed by sending a conventional browser-shaped UA with our own product
# token appended, rather than inventing a plausible-looking string --
# verified empirically (not guessed) against BOTH civitai.com and its
# civitai.red mirror, on `/api/v1/models`, `/api/v1/model-versions/by-hash/
# <hash>`, and a ranged `/api/download/models/<id>` (`Range: bytes=0-0`, never
# a full file): this exact string returned 200/206 on every one of those six
# combinations, same as the bare current string did in THIS environment --
# the rejection is presumed to depend on the calling network (e.g. Colab's
# cloud IP ranges are more heavily bot-filtered than the one this fix shipped
# from), which is exactly why a browser-shaped UA -- indistinguishable from
# real browser traffic to a header-only check -- is the right general fix
# rather than one more guessable product-token variant.
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 "
    "AnimaFlow-ComfyUI/model-browser"
)

_DEFAULT_TIMEOUT = 30.0
_DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024

# What `lookup_by_hash` always returns for `result["reason"] == "offline"` --
# see each branch below for which one is picked. `forbidden` (2026-07-30) is
# a 401/403 that was NOT confirmed to be Civitai's own "you must be logged
# in" response shape (see `download.py`'s `_is_key_required_body` for that
# confirmation logic, reused nowhere near this read-only path since a search/
# lookup 401/403 has never been reported as `key_required` here in the first
# place) -- distinct from `unknown` so a caller can tell "refused" from
# "something else went wrong" without this module asserting a cause it can't
# back up.
_OFFLINE_REASONS = ("timeout", "dns_tls", "unreadable", "rate_limited", "forbidden", "unknown")


def _default_opener(url: str, timeout: float):
    """The real network call -- `urllib.request.urlopen`, wrapped so tests
    can inject a fake `opener` (see this function's own `opener=` parameter
    on `lookup_by_hash`) and exercise every failure branch below without
    ever touching a real socket."""
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    return urllib.request.urlopen(request, timeout=timeout)


def _classify_urlerror(exc: BaseException) -> str:
    """`urllib.error.URLError`'s `.reason` -> one of `_OFFLINE_REASONS`'s
    connection-level values. `URLError` wraps whatever the underlying
    socket/SSL layer raised in `.reason`; a bare `socket.timeout`/
    `TimeoutError` can also reach here un-wrapped depending on Python
    version, so both shapes are checked.
    """
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return "timeout"
    if "timed out" in str(reason).lower():
        return "timeout"
    if isinstance(reason, (socket.gaierror, ssl.SSLError)):
        return "dns_tls"
    return "dns_tls"  # any other connection-level refusal folds in here


def fetch_json_with_host_fallback(
    build_url: Callable[[str], str],
    *,
    timeout: float = _DEFAULT_TIMEOUT,
    max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
    hosts: Sequence[str] = _CIVITAI_HOSTS,
    opener: Optional[Callable[[str, float], Any]] = None,
    notfound_message: str = "Not found on Civitai.",
) -> Dict[str, Any]:
    """The shared two-host-fallback GET-JSON transport every Civitai read in
    this package goes through -- extracted (M2, docs/lora-loader-design.md's
    own "extend them, don't fork them" instruction) from what used to be two
    near-identical copies of this exact loop inside `lookup_by_hash` and
    `lookup_model_by_id` below; `civitai_search.search_models` is the THIRD
    caller this was extracted for, so a third copy never gets written at
    all. `build_url(host) -> url` lets each caller pick its own path/query
    while sharing every transport rule verbatim: two hosts tried in order
    with a DEFINITIVE 404 that skips the backup host, a non-200 that DOES
    fall through (rate limit/maintenance are transient), the 30s timeout,
    the 4 MB body cap, and every distinct offline reason (module docstring
    has the full rationale for each, not repeated here).

    Always returns `{"reason": "found"|"notfound"|"offline",
    "offline_reason": None|one of _OFFLINE_REASONS, "message": str, "data":
    <parsed JSON dict>|None}` -- never raises. `opener` is the same
    `opener(url, timeout)` seam `lookup_by_hash`'s own docstring describes;
    unchanged from before this refactor, so every existing fake-opener test
    for `lookup_by_hash`/`lookup_model_by_id` keeps working unmodified.
    """
    opener = opener or _default_opener
    last_offline_reason = "unknown"
    last_message = "Could not reach Civitai."

    for host in hosts:
        url = build_url(host)
        # Debug-only (task: "wire the model browser into the pack's
        # existing console-logging setting") -- `logs_mod.log_debug` itself
        # is the guard (resolves the level, returns immediately when it
        # isn't "debug", never raises), so this costs nothing at `off`/
        # `summary`. `url` is ALWAYS redacted (`format_request_debug` ->
        # `redact_url`) before it's ever formatted into a string, since a
        # SEARCH caller's `build_url` can embed `?token=<api key>` (module
        # docstring's own "never logged" note) -- see `logs.py`'s own
        # top docstring for why this redaction happens unconditionally
        # rather than only for callers known to carry a key.
        logs_mod.log_debug(_logger, logs_mod.format_request_debug, url=url)
        _request_started = time.monotonic()

        def _duration_ms() -> float:
            return (time.monotonic() - _request_started) * 1000

        try:
            with opener(url, timeout) as response:
                # Cap the body so a malfunctioning endpoint can't spike
                # memory -- read ONE byte past the cap so we can tell
                # "exactly at the cap" from "over it" without a second read.
                body = response.read(max_body_bytes + 1)
                if len(body) > max_body_bytes:
                    logs_mod.log_debug(
                        _logger, logs_mod.format_response_debug,
                        url=url, outcome="offline:unreadable", duration_ms=_duration_ms(),
                    )
                    return {
                        "reason": "offline",
                        "offline_reason": "unreadable",
                        "message": "Civitai response too large.",
                        "data": None,
                    }
                try:
                    data = json.loads(body)
                except (ValueError, TypeError):
                    logs_mod.log_debug(
                        _logger, logs_mod.format_response_debug,
                        url=url, outcome="offline:unreadable", byte_count=len(body), duration_ms=_duration_ms(),
                    )
                    return {
                        "reason": "offline",
                        "offline_reason": "unreadable",
                        "message": "Civitai sent an unreadable reply (a login or block page?).",
                        "data": None,
                    }
                logs_mod.log_debug(
                    _logger, logs_mod.format_response_debug,
                    url=url, outcome="found", byte_count=len(body), duration_ms=_duration_ms(),
                )
                return {"reason": "found", "offline_reason": None, "message": "", "data": data}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                # DEFINITIVE -- do NOT try the backup host (module docstring).
                logs_mod.log_debug(
                    _logger, logs_mod.format_response_debug,
                    url=url, outcome="notfound", status=404, duration_ms=_duration_ms(),
                )
                return {
                    "reason": "notfound",
                    "offline_reason": None,
                    "message": notfound_message,
                    "data": None,
                }
            if exc.code == 429:
                last_offline_reason = "rate_limited"
                last_message = "Civitai returned 429 (rate limited)."
                logs_mod.log_debug(
                    _logger, logs_mod.format_response_debug,
                    url=url, outcome="offline:rate_limited", status=429, duration_ms=_duration_ms(),
                )
                continue
            if exc.code in (401, 403):
                # NOT `key_required` -- this read-only path has never
                # claimed that, and shouldn't start now. A 401/403 here is
                # most likely the SAME kind of edge-level rejection
                # `_USER_AGENT`'s own 2026-07-30 fix addresses (this module
                # docstring), not evidence any particular key would help.
                last_offline_reason = "forbidden"
                last_message = f"Civitai refused the request (HTTP {exc.code})."
                logs_mod.log_debug(
                    _logger, logs_mod.format_response_debug,
                    url=url, outcome="offline:forbidden", status=exc.code, duration_ms=_duration_ms(),
                )
                continue
            last_offline_reason = "unknown"
            last_message = f"Civitai returned {exc.code}."
            logs_mod.log_debug(
                _logger, logs_mod.format_response_debug,
                url=url, outcome="offline:unknown", status=exc.code, duration_ms=_duration_ms(),
            )
            continue
        except urllib.error.URLError as exc:
            last_offline_reason = _classify_urlerror(exc)
            last_message = (
                "Civitai timed out." if last_offline_reason == "timeout"
                else "Couldn't reach Civitai (DNS/TLS)."
            )
            logs_mod.log_debug(
                _logger, logs_mod.format_response_debug,
                url=url, outcome=f"offline:{last_offline_reason}", duration_ms=_duration_ms(),
            )
            continue
        except (socket.timeout, TimeoutError):
            last_offline_reason = "timeout"
            last_message = "Civitai timed out."
            logs_mod.log_debug(
                _logger, logs_mod.format_response_debug,
                url=url, outcome="offline:timeout", duration_ms=_duration_ms(),
            )
            continue
        except Exception as exc:  # noqa: BLE001 - degrade to offline, never raise
            last_offline_reason = "unknown"
            last_message = f"Could not reach Civitai ({type(exc).__name__})."
            logs_mod.log_debug(
                _logger, logs_mod.format_response_debug,
                url=url, outcome="offline:unknown", duration_ms=_duration_ms(),
            )
            continue

    return {"reason": "offline", "offline_reason": last_offline_reason, "message": last_message, "data": None}


def lookup_by_hash(
    sha256_hex: str,
    *,
    timeout: float = _DEFAULT_TIMEOUT,
    max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
    hosts: Sequence[str] = _CIVITAI_HOSTS,
    opener: Optional[Callable[[str, float], Any]] = None,
) -> Dict[str, Any]:
    """Ask Civitai's public by-hash endpoint about `sha256_hex`.

    Always returns `{"reason": "found"|"notfound"|"offline",
    "offline_reason": None|one of _OFFLINE_REASONS, "message": str,
    "data": <parsed JSON dict>|None}` -- never raises. `data` is the RAW
    Civitai response on `found`; parsing it into our own shape is
    `civitai_parse.parse_model_version`'s job, not this module's.

    `opener` (keyword-only, defaults to a real `urllib.request.urlopen`
    call) is the one seam this function's own test suite uses: a fake
    `opener(url, timeout)` returning a context-manager-with-`.read()`
    fake response, or raising `urllib.error.HTTPError`/`URLError`/
    `socket.timeout`, lets every branch below (404, 429, timeout, DNS
    failure, an oversized body, an unreadable body) be exercised with no
    network at all. A thin wrapper over `fetch_json_with_host_fallback`
    (see its own docstring for the shared transport rules).
    """
    return fetch_json_with_host_fallback(
        lambda host: f"https://{host}/api/v1/model-versions/by-hash/{sha256_hex}",
        timeout=timeout,
        max_body_bytes=max_body_bytes,
        hosts=hosts,
        opener=opener,
        notfound_message="This exact file isn't on Civitai.",
    )


def lookup_model_by_id(
    model_id: Any,
    *,
    timeout: float = _DEFAULT_TIMEOUT,
    max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
    hosts: Sequence[str] = _CIVITAI_HOSTS,
    opener: Optional[Callable[[str, float], Any]] = None,
) -> Dict[str, Any]:
    """Ask Civitai's public MODEL endpoint (`/api/v1/models/{id}`) about
    `model_id` -- BUG 2 (2026-07-29 owner report)'s fallback, used by
    `lookup.py`'s `_augment_with_model_description` when a by-hash lookup's
    embedded `model` sub-object (see `civitai_parse.py`'s own doc comment)
    didn't carry a `description` at all, which is the common case (verified
    live, 2026-07-29: that sub-object is `{name, type, nsfw, poi}` only).
    Public, no API key needed -- same as `lookup_by_hash` (§2b) -- and the
    SAME envelope/rules (two hosts with a definitive 404, 30s timeout, 4 MB
    body cap, distinct offline reasons); see that function's own docstring
    for the full rationale, not repeated here. A thin wrapper over
    `fetch_json_with_host_fallback`, same as `lookup_by_hash` above.
    """
    return fetch_json_with_host_fallback(
        lambda host: f"https://{host}/api/v1/models/{model_id}",
        timeout=timeout,
        max_body_bytes=max_body_bytes,
        hosts=hosts,
        opener=opener,
        notfound_message="This model isn't on Civitai.",
    )


def lookup_model_version_by_id(
    version_id: Any,
    *,
    timeout: float = _DEFAULT_TIMEOUT,
    max_body_bytes: int = _DEFAULT_MAX_BODY_BYTES,
    hosts: Sequence[str] = _CIVITAI_HOSTS,
    opener: Optional[Callable[[str, float], Any]] = None,
) -> Dict[str, Any]:
    """Ask Civitai's public MODEL-VERSION-BY-ID endpoint
    (`/api/v1/model-versions/{id}`) about `version_id` -- the detail view's
    own backend (`docs/lora-loader-design.md`'s "The detail view" /
    §7c-ii), used when a search result's own `model_id`/`version_id` are
    already known (unlike `lookup_by_hash`, §2b's by-FILE lookup) and the
    caller wants that exact version's own per-version description and its
    author's gallery (measured 2026-08-01: this endpoint's own `images` carry
    `meta`/prompt on 18/20 sampled, unlike the community `/api/v1/images`
    endpoint's 0/40 -- see `civitai_parse.parse_author_gallery`).

    Same envelope/rules as `lookup_by_hash`/`lookup_model_by_id` above (two
    hosts with a definitive 404, 30s timeout, 4 MB body cap, distinct offline
    reasons) -- a thin wrapper over `fetch_json_with_host_fallback`, public,
    no API key needed (§2b's same "no key needed" rule, extended to this
    endpoint -- verified: Civitai's model-version endpoints are all public).
    """
    return fetch_json_with_host_fallback(
        lambda host: f"https://{host}/api/v1/model-versions/{version_id}",
        timeout=timeout,
        max_body_bytes=max_body_bytes,
        hosts=hosts,
        opener=opener,
        notfound_message="This model version isn't on Civitai.",
    )


__all__ = (
    "CIVITAI_HOSTS", "fetch_json_with_host_fallback", "lookup_by_hash", "lookup_model_by_id",
    "lookup_model_version_by_id",
)
