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
import socket
import ssl
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional, Sequence

# `.com` is the real home; `.red` serves the IDENTICAL API on separate DNS,
# so it's a useful backup when a network/ISP blocks civitai.com by name.
# Only ever reached after `.com` has already failed with something
# transient (never after a 404 -- see module docstring).
_CIVITAI_HOSTS: Sequence[str] = ("civitai.com", "civitai.red")

_USER_AGENT = "AnimaFlow-ComfyUI/model-browser"

_DEFAULT_TIMEOUT = 30.0
_DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024

# What `lookup_by_hash` always returns for `result["reason"] == "offline"` --
# see each branch below for which one is picked.
_OFFLINE_REASONS = ("timeout", "dns_tls", "unreadable", "rate_limited", "unknown")


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
    network at all.
    """
    opener = opener or _default_opener
    last_offline_reason = "unknown"
    last_message = "Could not reach Civitai."

    for host in hosts:
        url = f"https://{host}/api/v1/model-versions/by-hash/{sha256_hex}"
        try:
            with opener(url, timeout) as response:
                # Cap the body so a malfunctioning endpoint can't spike
                # memory -- read ONE byte past the cap so we can tell
                # "exactly at the cap" from "over it" without a second read.
                body = response.read(max_body_bytes + 1)
                if len(body) > max_body_bytes:
                    return {
                        "reason": "offline",
                        "offline_reason": "unreadable",
                        "message": "Civitai response too large.",
                        "data": None,
                    }
                try:
                    data = json.loads(body)
                except (ValueError, TypeError):
                    return {
                        "reason": "offline",
                        "offline_reason": "unreadable",
                        "message": "Civitai sent an unreadable reply (a login or block page?).",
                        "data": None,
                    }
                return {"reason": "found", "offline_reason": None, "message": "", "data": data}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                # DEFINITIVE -- do NOT try the backup host (module docstring).
                return {
                    "reason": "notfound",
                    "offline_reason": None,
                    "message": "This exact file isn't on Civitai.",
                    "data": None,
                }
            if exc.code == 429:
                last_offline_reason = "rate_limited"
                last_message = "Civitai returned 429 (rate limited)."
                continue
            last_offline_reason = "unknown"
            last_message = f"Civitai returned {exc.code}."
            continue
        except urllib.error.URLError as exc:
            last_offline_reason = _classify_urlerror(exc)
            last_message = (
                "Civitai timed out." if last_offline_reason == "timeout"
                else "Couldn't reach Civitai (DNS/TLS)."
            )
            continue
        except (socket.timeout, TimeoutError):
            last_offline_reason = "timeout"
            last_message = "Civitai timed out."
            continue
        except Exception as exc:  # noqa: BLE001 - degrade to offline, never raise
            last_offline_reason = "unknown"
            last_message = f"Could not reach Civitai ({type(exc).__name__})."
            continue

    return {"reason": "offline", "offline_reason": last_offline_reason, "message": last_message, "data": None}


__all__ = ("lookup_by_hash",)
