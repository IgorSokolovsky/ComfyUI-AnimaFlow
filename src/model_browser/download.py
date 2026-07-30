"""The streamed downloader (docs/lora-loader-design.md §2 item 2, §9) --
destination resolution + filename/subfolder sanitisation, the actual
`.part`-then-atomic-rename stream, and a serial one-at-a-time queue with
progress + cancel. Stdlib `urllib` only, no torch/comfy import (`folder_paths`
is reached only indirectly, via `local._model_dirs`, itself lazy).

🔒 This module is the pack's first code that WRITES a file to disk from a
remote source (docs/lora-loader-design.md's M2 brief) -- every function here
treats every input as hostile: `kind` goes through the SAME whitelist
`kinds.folder_for_kind` already enforces for local paths; `subfolder` is
untrusted user input, rejected for traversal/absolute paths/Windows
separators and re-checked against the configured root via `local.
_is_path_under` (reusing that guard, not writing a second one, per the M2
brief); the `filename` a remote server hands back is untrusted too,
sanitised to a bare name with an expected model extension; and the URL we're
told to fetch is validated HTTPS + a known Civitai host before the FIRST
request, with every REDIRECT hop re-validated for scheme + SSRF-shaped host
safety before it's followed (`_SafeRedirectHandler`/`_is_safe_redirect`).

§9's "never register as installed" guarantee: `stream_download` writes ONLY
to `<dest_path>.part` while the transfer is in flight, and reaches
`os.replace(part_path, dest_path)` -- the atomic rename -- on the SOLE
success path. `destination_exists` (what `api.py`'s search/download-start
routes call to decide "already on disk") only ever `os.path.isfile`s
`dest_path` itself, never the `.part` file, so a cancelled, failed, or
crashed-mid-stream download is invisible to that check by construction, not
by a case the code happens to also handle.

🔒 2026-07-30 fix: reaching the rename used to be gated on nothing but "the
socket stopped sending bytes" -- indistinguishable from a genuinely complete
transfer, so a short read (dropped connection, flaky link) or a wrong-content
body (an HTML error/login page) got renamed over `dest_path` and reported
`"ok"` anyway. `stream_download` now runs two integrity gates immediately
before that same rename -- a `Content-Length` length check, then (for a
`.safetensors`/`.sft` destination) a safetensors-header sanity check via
`local.is_valid_safetensors_header` -- and only reaches `os.replace` if both
pass, closing the hole without changing where the guarantee itself lives.

🔒 2026-07-30 fix #2 (confirmed live: a gated LoRA landed as a 10 KB file
whose bytes were Civitai's OWN "Civitai Login" HTML page): the two gates
above run AFTER the full body has already been read and written to `.part`,
and neither one is a real fix for THIS shape of failure -- Civitai answered
with a plain `200`, not a `401`/`403`, so `_http_error_result` never even
runs; the page carried a correct `Content-Length` *for itself*, so the
length gate agreed exactly; and the safetensors-header gate below DID stop
the file landing, but reported `"corrupt"` -- true in the narrowest sense
(it isn't a valid safetensors file) but actively misleading, since the real
problem is "you're not logged in," not "the download broke." `stream_download`
now checks the response's `Content-Type` BEFORE writing a single byte: an
`html` media type is never a valid model file, full stop, so this is
reported as `"key_required"` (the SAME reason a confirmed 401/403 body
produces, `_is_key_required_body`/`_http_error_result`) with NO `.part` file
ever created for this path -- see `_is_html_content_type`/
`_html_login_page_result` below.
"""
from __future__ import annotations

import ipaddress
import json
import os
import socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Optional

from . import civitai_client
from . import local
from .kinds import folder_for_kind

# Real LoRAs are tens-hundreds of MB; a checkpoint (M3's eventual `kind`) can
# be several GB. 20 GiB is a generous ceiling that still refuses a
# misconfigured/hostile URL (or a Civitai response lying about its own size)
# from filling a disk -- a hard cap per §9's "a hard size cap, and a
# readable refusal when a file exceeds it".
DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 * 1024

_CHUNK_SIZE = 1024 * 1024  # 1 MiB -- same streaming granularity as `hashing.sha256_file`.

# A remote-supplied filename must resolve to one of these -- an "expected
# model extension" per the M2 brief's filename-sanitisation requirement.
# `.bin`/`.pt` are legacy PyTorch checkpoint saves still seen in the wild for
# older LoRAs; `.safetensors` is what the overwhelming majority of Civitai
# LoRAs (and this pack's own M1 preview/metadata code) already assume.
ALLOWED_MODEL_EXTENSIONS = frozenset({".safetensors", ".ckpt", ".pt", ".bin"})

# 🔒 2026-07-30 fix: the two suffixes `stream_download`'s post-download
# safetensors-header sanity check applies to -- `.sft` is an alternate
# extension for the exact same container format, seen in the wild alongside
# `.safetensors`; nothing else in `ALLOWED_MODEL_EXTENSIONS` (`.ckpt`/`.pt`/
# `.bin`) uses this header shape, so checking them would just be a false
# "corrupt" on a legitimate legacy pickle checkpoint.
_SAFETENSORS_DEST_SUFFIXES = (".safetensors", ".sft")


# ---------------------------------------------------------------------------
# Filename / subfolder sanitisation + destination resolution.
# ---------------------------------------------------------------------------


def sanitize_filename(name: Any) -> Optional[str]:
    """A remote-supplied (or client-supplied) filename -> a safe BARE
    filename with no directory component, or `None` for anything hostile:
    a non-string/empty value, any path separator (`/` or the Windows `\\`),
    a `..` sequence anywhere in it, an embedded NUL byte (`\x00` -- see
    below), a leading dot (hidden-file/relative tricks), or an extension
    outside `ALLOWED_MODEL_EXTENSIONS`. Never raises.

    🔒 2026-07-30 fix: a NUL byte used to pass every check here and reach
    `os.path.realpath` inside `local._is_path_under` (via
    `resolve_destination_path`), which raises `ValueError: embedded null
    character` -- uncaught, that propagated out of `download_start_impl`
    inside `run_in_executor` and broke `api.py`'s own "every route answers
    200 with a reason" contract. Rejected explicitly here (belt), with
    `local._is_path_under` also hardened to catch the `ValueError`
    (suspenders) so nothing downstream of either check can crash on one.
    """
    if not isinstance(name, str):
        return None
    if "\x00" in name:
        return None
    candidate = name.strip()
    if not candidate:
        return None
    if "/" in candidate or "\\" in candidate:
        return None
    if ".." in candidate:
        return None
    if candidate.startswith("."):
        return None
    # Belt-and-suspenders: `os.path.basename` should be a no-op given the
    # separator checks above, on every platform this runs on -- if it isn't,
    # something about `candidate` is stranger than expected, so refuse it
    # rather than trust a value that changed shape under inspection.
    if os.path.basename(candidate) != candidate:
        return None
    ext = os.path.splitext(candidate)[1].lower()
    if ext not in ALLOWED_MODEL_EXTENSIONS:
        return None
    return candidate


def validate_subfolder(subfolder: Any) -> Optional[str]:
    """A user-supplied destination subfolder (decision 1: "an editable
    folder, defaulting to `models/loras`... the user may supply a
    subfolder") -> a normalised, forward-slash subfolder string with no
    trailing slash, `""` for "no subfolder, use the kind's root", or `None`
    for anything hostile: a non-string, a Windows separator, an ABSOLUTE
    path (checked BEFORE any slash-stripping -- see below), or any
    `.`/`..`/empty path SEGMENT (covers `..`, `a/../b`, `a//b`, and a bare
    `.`).

    The absolute-path check runs on the value with only whitespace
    stripped, deliberately BEFORE a leading `/` could be stripped away --
    stripping first and checking after would silently turn a rejected
    `"/etc/passwd"` into an accepted `"etc/passwd"`, exactly the class of
    bug this function exists to not have. A single TRAILING slash (a
    harmless "detail/" typed with a trailing separator) is still tolerated.

    This is the CHEAP, unambiguous rejection pass; the actual traversal
    GUARANTEE is `resolve_destination_path`'s `local._is_path_under` check
    below, reusing that existing guard rather than writing a second one
    (per the M2 brief).

    🔒 2026-07-30 fix: also rejects an embedded NUL byte (`\x00`) -- see
    `sanitize_filename`'s own docstring for why (an uncaught
    `ValueError: embedded null character` out of `os.path.realpath`
    otherwise).
    """
    if subfolder is None:
        return ""
    if not isinstance(subfolder, str):
        return None
    if "\x00" in subfolder:
        return None
    if "\\" in subfolder:
        return None

    value = subfolder.strip()
    if value == "":
        return ""
    if os.path.isabs(value):
        return None

    if value.endswith("/") and len(value) > 1:
        value = value[:-1]
    if value == "":
        return ""

    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return value


def resolve_destination_path(kind: object, subfolder: Any, filename: Any) -> Optional[str]:
    """`(kind, subfolder, filename)` -> the real destination path a
    download would write to, or `None` if ANY of the three doesn't check
    out: an unwhitelisted `kind` (never touches `folder_paths`, same
    short-circuit as `local.resolve_model_path`), a hostile `filename`
    (`sanitize_filename`), a hostile `subfolder` (`validate_subfolder`), or
    a kind whose configured directories can't even be determined (fails
    CLOSED, same as `local.resolve_model_path`).

    The destination's ROOT is the kind's FIRST configured directory
    (`folder_paths.get_folder_paths(folder)[0]`, via `local._model_dirs`) --
    decision 1's "an editable folder, defaulting to `models/loras`": the
    first configured `loras` directory on a stock ComfyUI install IS
    `models/loras`, and this is the SAME "first configured directory"
    convention `folder_paths` itself uses as the default save location
    elsewhere in ComfyUI.

    The resulting path does NOT need to exist yet (a download's whole point
    is that it doesn't) -- what's guaranteed is that it resolves to
    somewhere INSIDE that root, verified with the exact same `local.
    _is_path_under` realpath-then-`commonpath` guard every other
    client-supplied path in this package goes through.
    """
    folder = folder_for_kind(kind)
    if folder is None:
        return None

    safe_name = sanitize_filename(filename)
    if safe_name is None:
        return None

    safe_subfolder = validate_subfolder(subfolder)
    if safe_subfolder is None:
        return None

    roots = local._model_dirs(folder)
    if not roots:
        return None
    root = roots[0]

    candidate = os.path.join(root, safe_subfolder, safe_name) if safe_subfolder else os.path.join(root, safe_name)
    if not local._is_path_under(candidate, root):
        return None
    return candidate


def destination_exists(kind: object, subfolder: Any, filename: Any) -> bool:
    """Whether `(kind, subfolder, filename)` already resolves to a REAL file
    on disk -- decision 2's "already on disk => no download" check. `False`
    for anything that doesn't even resolve to a valid destination (an
    unresolvable destination obviously isn't "installed").

    This is the guarantee a partial download must never satisfy: it only
    ever inspects `dest_path` itself, never a `.part` sibling (see this
    module's own top docstring).
    """
    path = resolve_destination_path(kind, subfolder, filename)
    return path is not None and os.path.isfile(path)


def part_path_for(dest_path: str) -> str:
    """The in-flight scratch path a download streams to before the atomic
    rename -- always `<dest_path>.part`, so it sits next to (and is
    trivially found beside) the file it will become."""
    return dest_path + ".part"


# ---------------------------------------------------------------------------
# URL / redirect safety.
# ---------------------------------------------------------------------------


def _is_https(url: Any) -> bool:
    if not isinstance(url, str):
        return False
    try:
        return urllib.parse.urlparse(url).scheme == "https"
    except ValueError:
        return False


def is_allowed_download_url(url: Any) -> bool:
    """Whether `url` is safe to use as the INITIAL download request: HTTPS,
    and its host is one of Civitai's own two known-good hosts
    (`civitai_client.CIVITAI_HOSTS`). This is deliberately STRICTER than
    `_is_safe_redirect` below -- the client fully controls this first URL
    (it comes from a download-start request body), so this is the one place
    we CAN pin to a known-good host outright, closing off the SSRF-to-write
    vector of "tell our server to fetch and write an arbitrary URL". A
    REDIRECT Civitai's own response sends us to (typically a different CDN
    host) is a different, necessarily looser check -- see `_is_safe_redirect`
    for why the two aren't the same rule.
    """
    if not isinstance(url, str):
        return False
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and hostname in civitai_client.CIVITAI_HOSTS


def _unsafe_ip(ip: ipaddress._BaseAddress) -> bool:
    """Every address CLASS a redirect target must never resolve to -- the
    full unsafe set, checked against EVERY address a hostname resolves to,
    not just the first."""
    return (
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_reserved or ip.is_multicast or ip.is_unspecified
    )


def _is_safe_redirect(
    url: str,
    *,
    resolver: Callable[[str, Optional[int]], Any] = socket.getaddrinfo,
) -> bool:
    """Whether following a REDIRECT to `url` is safe (§9 / the M2 brief:
    "do not follow a redirect to another scheme or to a non-Civitai host
    without re-validating"). Unlike `is_allowed_download_url` (which pins
    the INITIAL url to Civitai's own two hosts), a redirect's destination is
    legitimately a third-party CDN host we don't control -- Civitai itself
    redirects real downloads off-host -- so this only enforces what matters
    for safety regardless of WHICH host: still HTTPS (no scheme downgrade
    partway through a transfer), and not a private/loopback/link-local/
    reserved/multicast/unspecified address (the SSRF-shaped risk: a
    compromised or malicious redirect pointing our server at its OWN
    internal network, or at a cloud metadata endpoint -- squarely in scope
    since the owner runs on Colab).

    🔒 SECURITY FIX (2026-07-30, confirmed SSRF bypass): this used to call
    `ipaddress.ip_address(hostname)` directly on the hostname STRING and
    treat a `ValueError` as "not a bare IP literal, therefore a real
    hostname, therefore allowed". That is wrong: `ipaddress.ip_address`
    parses ONLY dotted-quad/IPv6 literal syntax, but the platform resolver
    (and hence `urllib`'s own eventual connection) accepts several OTHER
    numeric encodings as the exact same address -- decimal (`2130706433`),
    hex (`0x7f.0.0.1`), and a bare integer (`0` -> `0.0.0.0`) all measurably
    resolve to loopback/unspecified/link-local (including the cloud
    metadata address, `169.254.169.254`, as `2852039166`) on this platform's
    resolver, and every one of them fell into the `except ValueError: return
    True` branch -- allowed. Now this function RESOLVES the hostname (via
    `getaddrinfo`, the same resolution `urllib` itself performs before
    connecting) and checks EVERY returned address, which closes every
    numeric encoding AND the case where a perfectly normal-looking DNS name
    simply points at an internal address -- something a syntax check could
    never catch at all.

    Resolution failure is treated as UNSAFE (`False`), never as "couldn't
    tell, so allow" -- an unresolvable redirect target is refused outright.

    ⚠️ RESIDUAL RISK, stated honestly rather than implied away: this is
    resolve-THEN-connect, not connect-time address pinning. A DNS-rebinding
    attacker controls a name that resolves safely for THIS check and then
    answers differently (to a private/internal address) a moment later when
    `urllib` performs its OWN, separate resolution to actually connect --
    that TOCTOU window is NOT closed here. Fully closing it means pinning
    the resolved address for the real connection itself, which stdlib
    `urllib` does not make straightforward (it re-resolves internally with
    no hook to supply a pre-resolved address). Out of scope for this fix;
    recorded here so it is not mistaken for solved.

    `resolver` (keyword-only, defaults to the real `socket.getaddrinfo`) is
    the seam this function's own test suite uses to exercise "a DNS name
    that resolves to a private address" and "resolution fails" without
    depending on real, external DNS being reachable in a test environment --
    the concrete numeric-encoding bypasses above are tested against the
    REAL resolver instead, since those are local address-parsing behaviour,
    not a network call.
    """
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    hostname = parsed.hostname
    if not hostname:
        return False
    hostname = hostname.lower()
    if hostname == "localhost":
        return False

    try:
        addr_infos = resolver(hostname, None)
    except (socket.gaierror, UnicodeError, OSError):
        return False
    if not addr_infos:
        return False

    for info in addr_infos:
        sockaddr = info[4]
        raw_ip = sockaddr[0].split("%", 1)[0]  # drop an IPv6 zone id (`fe80::1%eth0`) before parsing
        try:
            ip = ipaddress.ip_address(raw_ip)
        except ValueError:
            return False  # an address we can't even parse -- refuse, don't guess
        if _unsafe_ip(ip):
            return False
    return True


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuses to follow a redirect `_is_safe_redirect` rejects. Returning
    `None` from `redirect_request` (per `urllib.request`'s own documented
    contract) means "do not redirect" -- the caller then sees the original
    3xx response rather than a followed one, which `stream_download` treats
    as a plain HTTP error (a 3xx not handled by `urlopen` surfaces as
    `urllib.error.HTTPError` there)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102 - stdlib override
        if not _is_safe_redirect(newurl):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _default_download_opener(url: str, timeout: float):
    """The real network call, with the safe-redirect handler installed --
    tests inject a fake `opener(url, timeout)` (same seam as
    `civitai_client._default_opener`) so every branch below is exercised
    with no real socket."""
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    request = urllib.request.Request(url, headers={"User-Agent": civitai_client._USER_AGENT})
    return opener.open(request, timeout=timeout)


def _content_length(response: Any) -> Optional[int]:
    try:
        headers = response.headers
        value = headers.get("Content-Length") if headers is not None else None
    except AttributeError:
        return None
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _is_html_content_type(response: Any) -> bool:
    """Whether `response`'s `Content-Type` header names the `text/html`
    MEDIA TYPE -- parsed as a media type (split on the first `;`, so a
    trailing `charset=...` parameter doesn't matter), never string-matched
    against the whole header value. A missing header, or any other media
    type, is `False` -- never invent a requirement the server didn't state
    (same stance as `_content_length`'s "no header -> skip, don't fail").

    This is the confirmed-bug signal (see this module's own top docstring,
    2026-07-30 fix #2): Civitai can answer a gated download with a `200` and
    its own login page instead of a `401`/`403`, so neither `_http_error_
    result` nor the post-download integrity gates below ever see it. An HTML
    body is never a valid model file under any circumstance, so this check
    runs BEFORE any bytes are read or written.
    """
    try:
        headers = response.headers
        value = headers.get("Content-Type") if headers is not None else None
    except AttributeError:
        return False
    if not isinstance(value, str):
        return False
    media_type = value.split(";", 1)[0].strip().lower()
    return media_type == "text/html"


def _html_login_page_result() -> Dict[str, Any]:
    """The result for `_is_html_content_type` confirming a `200` response is
    actually an HTML page, not a file -- reported as the SAME `"key_required"`
    reason a confirmed 401/403 body produces (`_is_key_required_body`/
    `_http_error_result`), routed through the same existing UI affordance
    rather than a parallel one (task brief). `bytes_written` is always `0`
    here: this fires before the `.part` file even exists, so nothing was
    ever written and nothing needs cleaning up."""
    return {
        "reason": "key_required",
        "message": (
            "Civitai returned a web page instead of a file -- this usually "
            "means the download needs an API key. Add one in "
            "Settings -> AnimaFlow -> Controls."
        ),
        "bytes_written": 0,
    }


def _is_key_required_body(exc: urllib.error.HTTPError) -> bool:
    """Whether `exc`'s body is Civitai's OWN documented "you must be logged
    in to download this" shape, as opposed to a 401/403 that merely LOOKS
    like an auth failure because of the status code alone -- a WAF/edge
    rejection (e.g. the 2026-07-30 User-Agent bug -- `civitai_client.py`'s
    `_USER_AGENT` docstring has the measurement), a proxy, or anything else
    upstream of Civitai's own API code ever answering.

    Verified live (2026-07-30) against three real early-access LoRA
    versions: Civitai's genuine 401 is `Content-Type: application/json`,
    body `{"error": "Unauthorized", "message": "The creator of this asset
    requires you to be logged in to download it"}`. This checks for that
    shape specifically -- a JSON body with an `"error"`/`"message"` field
    that reads as an auth refusal -- rather than trusting the status code by
    itself. Never raises: a body that can't be read or parsed, or isn't a
    dict, is simply NOT confirmed (`False`), the safe default (§8: naming
    the WRONG thing to do is worse than not naming one).
    """
    headers = exc.headers
    content_type = headers.get("Content-Type", "") if headers is not None else ""
    if "json" not in content_type.lower():
        return False
    try:
        body = exc.read(4096)
    except Exception:  # noqa: BLE001 - an unreadable body is just "not confirmed"
        return False
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return False
    if not isinstance(data, dict):
        return False
    error_field = str(data.get("error", "")).lower()
    message_field = str(data.get("message", "")).lower()
    return "unauthorized" in error_field or "logged in" in message_field or "api key" in message_field


def _http_error_result(exc: urllib.error.HTTPError) -> Dict[str, Any]:
    if exc.code in (401, 403):
        if _is_key_required_body(exc):
            # A distinct, machine-readable reason -- NEVER folded into a
            # generic offline/failure bucket (§8: "say so in the UI naming
            # what to do -- never a bare 401"). This is the download route's
            # defense-in-depth answer to a gated file even when
            # `civitai_search.py`'s own `earlyAccessEndsAt`-based `gated`
            # flag didn't already say so in advance (a stale/edited-in-
            # transit search result, or a version that goes early-access
            # after being listed). CONFIRMED by `_is_key_required_body`
            # above, not assumed from the status code alone (2026-07-30 fix
            # -- an unrelated User-Agent rejection used to be reported as
            # this exact reason, which was a confidently wrong claim to a
            # user about a perfectly public file).
            return {"reason": "key_required", "message": "Civitai requires an API key for this file (early access or a restricted download).", "bytes_written": 0}
        # A 401/403 that did NOT confirm Civitai's own "you need to be
        # logged in" shape -- most likely an edge/WAF-level rejection (the
        # 2026-07-30 User-Agent bug was exactly this), not evidence a key
        # would fix anything. `forbidden` says "refused" without asserting
        # WHY -- see `civitai_client._OFFLINE_REASONS`'s own comment for the
        # same distinction on the read-only (search/lookup) side.
        return {"reason": "offline", "offline_reason": "forbidden", "message": "Civitai refused this download (not confirmed to require an API key).", "bytes_written": 0}
    if exc.code == 404:
        return {"reason": "offline", "offline_reason": "notfound", "message": "Civitai returned 404 for this file.", "bytes_written": 0}
    if exc.code == 429:
        return {"reason": "offline", "offline_reason": "rate_limited", "message": "Civitai returned 429 (rate limited).", "bytes_written": 0}
    return {"reason": "offline", "offline_reason": "unknown", "message": f"Civitai returned {exc.code}.", "bytes_written": 0}


def _url_error_result(exc: urllib.error.URLError) -> Dict[str, Any]:
    reason = civitai_client._classify_urlerror(exc)
    message = "Civitai timed out." if reason == "timeout" else "Couldn't reach Civitai (DNS/TLS)."
    return {"reason": "offline", "offline_reason": reason, "message": message, "bytes_written": 0}


def _cleanup_part(part_path: str) -> None:
    """Best-effort removal of an in-flight `.part` file on any non-success
    path -- §9's "clean up `.part` on failure or cancel". Never raises: a
    permissions error deleting it is unfortunate, but must not become a
    SECOND failure on top of the download's own."""
    try:
        if os.path.isfile(part_path):
            os.remove(part_path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# The stream itself.
# ---------------------------------------------------------------------------


def stream_download(
    url: str,
    dest_path: str,
    *,
    max_size_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
    timeout: float = 30.0,
    chunk_size: int = _CHUNK_SIZE,
    opener: Optional[Callable[[str, float], Any]] = None,
    progress_cb: Optional[Callable[[int, Optional[int]], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """Stream `url` to `<dest_path>.part`, then atomically rename it to
    `dest_path` on success (§9) -- ALWAYS returns a dict, never raises for a
    network/write-level failure, matching `civitai_client`'s own "always
    answer, never raise" contract.

    `{"reason": ..., "message": str, "bytes_written": int}` where `reason`
    is one of:
      - `"ok"`             -- the atomic rename happened; `dest_path` is now
        the complete file, and `.part` no longer exists.
      - `"cancelled"`      -- `should_cancel()` returned `True` mid-stream;
        `.part` is cleaned up, `dest_path` was never touched.
      - `"too_large"`      -- more than `max_size_bytes` were read before
        the server stopped sending; `.part` is cleaned up.
      - `"key_required"`   -- Civitai answered 401/403 with its own
        confirmed "you must be logged in" body (§8: a distinct,
        machine-readable reason, never a bare failure -- see
        `_is_key_required_body`; a 401/403 that DOESN'T confirm that shape
        is reported as `"offline"`/`"forbidden"` below instead, never this).
        Also reported here -- with NO `.part` file ever created -- for a
        `200` response whose `Content-Type` is `text/html`: 🔒 2026-07-30 fix
        #2, a confirmed live bug where a gated download's login page was
        served with a genuine `200` and written verbatim to the model's real
        filename. See `_is_html_content_type`/`_html_login_page_result`.
      - `"offline"`        -- a network-level failure, with `offline_reason`
        matching `civitai_client`'s own vocabulary (`timeout`/`dns_tls`/
        `unreadable`/`rate_limited`/`notfound`/`forbidden`/`unknown`) plus
        `"invalid_url"` for a non-HTTPS `url` (checked before anything else,
        so a hostile URL never even reaches `opener`). `"forbidden"` is a
        401/403 that was NOT confirmed to be an actual "needs a key"
        response (2026-07-30: the real root cause of that class of failure
        was a rejected User-Agent, not a gate -- see `civitai_client.py`'s
        `_USER_AGENT` docstring).
      - `"write_error"`    -- couldn't create the destination directory,
        write the `.part` file, or complete the final rename (disk full,
        permissions, ...).
      - `"incomplete"`     -- 🔒 2026-07-30 fix: the server sent a
        `Content-Length` and the stream stopped before that many bytes
        arrived (a dropped connection, the server closing early, a flaky
        link) -- checked BEFORE the rename, never after. Skipped (not
        failed) when there was no `Content-Length` to compare against.
      - `"corrupt"`        -- 🔒 2026-07-30 fix: `dest_path` is a
        `.safetensors`/`.sft` destination and the bytes that arrived don't
        even parse as a safetensors header (an HTML error/login page served
        with a perfectly correct `Content-Length` for ITSELF, which the
        length check above can't catch). See `local.is_valid_safetensors_
        header`.

    Both of the above exist because the `.part`-then-rename design's own
    guarantee -- "`dest_path` exists => it is the complete file" -- used to
    have a hole: `bytes_written` was compared against nothing before the
    atomic rename, so a short read got renamed over the real filename and
    reported `"ok"` (root cause of a `json.JSONDecodeError` surfacing all
    the way up through `AnimaLoaderPanel` trying to load the result).

    On EVERY path except `"ok"`, `dest_path` itself is guaranteed untouched
    and no `.part` file survives (see `_cleanup_part`) -- so `destination_
    exists` never counts a partial/failed/cancelled/incomplete/corrupt
    download as installed.
    """
    if not _is_https(url):
        return {"reason": "offline", "offline_reason": "invalid_url", "message": "Refusing a non-HTTPS download URL.", "bytes_written": 0}

    opener = opener or _default_download_opener
    part_path = part_path_for(dest_path)

    dest_dir = os.path.dirname(dest_path)
    if dest_dir:
        try:
            os.makedirs(dest_dir, exist_ok=True)
        except OSError as exc:
            return {"reason": "write_error", "message": f"Could not create the destination folder: {exc}", "bytes_written": 0}

    bytes_written = 0
    try:
        with opener(url, timeout) as response:
            # 🔒 2026-07-30 fix #2 -- checked BEFORE anything else in this
            # block: no bytes read, no `.part` file created, nothing to
            # clean up on this path. See `_is_html_content_type`'s docstring
            # and this module's own top docstring for the confirmed bug.
            if _is_html_content_type(response):
                return _html_login_page_result()
            total = _content_length(response)
            with open(part_path, "wb") as out:
                while True:
                    if should_cancel is not None and should_cancel():
                        _cleanup_part(part_path)
                        return {"reason": "cancelled", "message": "Download cancelled.", "bytes_written": bytes_written}
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    bytes_written += len(chunk)
                    if bytes_written > max_size_bytes:
                        _cleanup_part(part_path)
                        return {
                            "reason": "too_large",
                            "message": f"This file exceeds the {max_size_bytes}-byte cap.",
                            "bytes_written": bytes_written,
                        }
                    out.write(chunk)
                    if progress_cb is not None:
                        progress_cb(bytes_written, total)
    except urllib.error.HTTPError as exc:
        _cleanup_part(part_path)
        return {**_http_error_result(exc), "bytes_written": bytes_written}
    except urllib.error.URLError as exc:
        _cleanup_part(part_path)
        return {**_url_error_result(exc), "bytes_written": bytes_written}
    except (socket.timeout, TimeoutError):
        _cleanup_part(part_path)
        return {"reason": "offline", "offline_reason": "timeout", "message": "Civitai timed out.", "bytes_written": bytes_written}
    except OSError as exc:
        _cleanup_part(part_path)
        return {"reason": "write_error", "message": f"Could not write the file: {exc}", "bytes_written": bytes_written}
    except Exception as exc:  # noqa: BLE001 - degrade to offline, never raise
        _cleanup_part(part_path)
        return {"reason": "offline", "offline_reason": "unknown", "message": f"Download failed ({type(exc).__name__}).", "bytes_written": bytes_written}

    # 🔒 2026-07-30 fix: two integrity gates, BOTH before the atomic rename --
    # neither ever renames `.part` over `dest_path`, both leave `dest_path`
    # untouched and clean up `.part` on failure, same as every other
    # non-"ok" path above.
    #
    # Gate 1 -- length check: `total` (the `Content-Length` the server sent,
    # captured above) is the one signal a short/dropped stream leaves behind
    # that a bare `if not chunk: break` can't distinguish from "the server
    # finished normally". `total is None` (no `Content-Length` header at
    # all) means this check simply cannot run -- skipped, not failed; do not
    # invent an expectation the server never stated.
    if total is not None and bytes_written != total:
        _cleanup_part(part_path)
        return {
            "reason": "incomplete",
            "message": (
                f"The download ended early: got {bytes_written} of {total} bytes. "
                "The file was not saved -- try again."
            ),
            "bytes_written": bytes_written,
        }

    # Gate 2 -- safetensors header sanity: catches what the length check
    # above cannot -- a wrong-content body (an HTML error/login page) served
    # with a perfectly correct `Content-Length` for ITSELF. Only applies to
    # destinations that are actually claiming to be a safetensors file;
    # `local.is_valid_safetensors_header` is the SAME header parse
    # `local.read_safetensors_metadata` uses, factored out so this isn't a
    # second copy of it.
    if dest_path.lower().endswith(_SAFETENSORS_DEST_SUFFIXES):
        if not local.is_valid_safetensors_header(part_path):
            _cleanup_part(part_path)
            return {
                "reason": "corrupt",
                "message": (
                    "The download did not produce a valid safetensors file. "
                    "The file was not saved -- try again."
                ),
                "bytes_written": bytes_written,
            }

    try:
        os.replace(part_path, dest_path)
    except OSError as exc:
        _cleanup_part(part_path)
        return {"reason": "write_error", "message": f"Could not finalise the download: {exc}", "bytes_written": bytes_written}

    return {"reason": "ok", "message": "", "bytes_written": bytes_written}


# ---------------------------------------------------------------------------
# Serial one-at-a-time queue, with progress + cancel (§9).
# ---------------------------------------------------------------------------


class DownloadManager:
    """One download at a time (§9), with progress reported to the UI and a
    cancel. A single process-wide instance lives in `api.py`
    (`_DOWNLOAD_MANAGER`); this class itself has no aiohttp dependency and
    is directly constructible/testable with a fake `stream_fn`.

    The actual transfer runs on a background `threading.Thread` (NOT the
    aiohttp executor pool `api.py`'s routes use for their own I/O) -- a
    download can run far longer than any single HTTP request/response
    cycle, so `start()` launches the thread and returns immediately;
    `progress()`/`cancel()` are separate, later requests that read/signal
    the SAME in-flight job by `job_id`.
    """

    def __init__(self, *, stream_fn: Callable[..., Dict[str, Any]] = stream_download):
        self._lock = threading.Lock()
        self._stream_fn = stream_fn
        self._thread: Optional[threading.Thread] = None
        self._cancel_event: Optional[threading.Event] = None
        self._job: Optional[Dict[str, Any]] = None

    def start(
        self,
        job_id: str,
        url: str,
        dest_path: str,
        *,
        max_size_bytes: int = DEFAULT_MAX_DOWNLOAD_BYTES,
        timeout: float = 30.0,
    ) -> Dict[str, Any]:
        """Launch a new download as `job_id`, or refuse with `"busy"` if one
        is already running -- the serial-queue rule. Never blocks on the
        transfer itself."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return {"reason": "busy", "message": "Another download is already in progress.", "job_id": None}

            cancel_event = threading.Event()
            job: Dict[str, Any] = {"job_id": job_id, "status": "downloading", "bytes": 0, "total": None, "message": ""}
            self._cancel_event = cancel_event
            self._job = job

            def progress_cb(bytes_written: int, total: Optional[int]) -> None:
                with self._lock:
                    if self._job is job:
                        job["bytes"] = bytes_written
                        job["total"] = total

            def run() -> None:
                result = self._stream_fn(
                    url, dest_path,
                    max_size_bytes=max_size_bytes,
                    timeout=timeout,
                    progress_cb=progress_cb,
                    should_cancel=cancel_event.is_set,
                )
                with self._lock:
                    if self._job is job:
                        job["status"] = result["reason"]
                        job["message"] = result.get("message", "")
                        job["bytes"] = result.get("bytes_written", job["bytes"])

            thread = threading.Thread(target=run, name=f"model-browser-download-{job_id}", daemon=True)
            self._thread = thread
            thread.start()
            return {"reason": "started", "job_id": job_id}

    def progress(self, job_id: Any) -> Dict[str, Any]:
        """The current state of `job_id` -- `{"reason": "ok", "status":
        "downloading"|"ok"|"cancelled"|"too_large"|"key_required"|
        "offline"|"write_error", "bytes": int, "total": int|None, "message":
        str}`, or `{"reason": "unknown_job"}` if `job_id` doesn't match the
        (single) job this manager knows about -- covers both "never started"
        and "a different job is now current"."""
        with self._lock:
            job = self._job
            if job is None or job.get("job_id") != job_id:
                return {"reason": "unknown_job", "message": "No such download job."}
            return {"reason": "ok", "status": job["status"], "bytes": job["bytes"], "total": job["total"], "message": job["message"]}

    def cancel(self, job_id: Any) -> Dict[str, Any]:
        """Signal `job_id`'s cancel event -- the running transfer notices
        (`should_cancel()`) at its next chunk boundary and cleans up its own
        `.part` file; this method itself returns immediately, it does not
        wait for the thread to actually stop."""
        with self._lock:
            job = self._job
            if job is None or job.get("job_id") != job_id:
                return {"reason": "unknown_job", "message": "No such download job."}
            if self._cancel_event is not None:
                self._cancel_event.set()
            return {"reason": "cancelling", "message": "Cancelling…"}


__all__ = (
    "DEFAULT_MAX_DOWNLOAD_BYTES",
    "ALLOWED_MODEL_EXTENSIONS",
    "sanitize_filename",
    "validate_subfolder",
    "resolve_destination_path",
    "destination_exists",
    "part_path_for",
    "is_allowed_download_url",
    "stream_download",
    "DownloadManager",
)
