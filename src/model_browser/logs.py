"""The Civitai model browser's own server-side console log -- wired into the
SAME "Console logging" Settings-dialog control (`AnimaFlow.General.
ConsoleLogging`) `src/anima/` already uses, per the owner's own direction
("when debug mode on we need to see logs (of the search and download
etc...)"). There is deliberately no second, Model-Browser-specific toggle --
one control governs every feature's console verbosity.

**Level core is SHARED, not copied** -- `CONSOLE_LOGGING_SETTING_ID`,
`LOG_LEVELS`, `DEFAULT_LOG_LEVEL`, `normalize_log_level`, `effective_log_level`,
`is_debug_enabled`, and the `_safe` fail-safe decorator all come from
`src/console_logging.py` (extracted 2026-07-31 out of `src/anima/logs.py`
specifically so this module wouldn't need a second copy, and so this module
does NOT import `src/anima/` -- see that module's own docstring for the full
"why here, not either feature" reasoning). This module re-exports them so a
caller only ever needs `from . import logs as logs_mod` and never has to
know the core lives one level up.

**Verbosity contract -- the same three levels, this feature's own lines**:

  - `summary` -- exactly ONE line per operation, naming its outcome: a
    search (`format_search_summary` -- query, result count, `reason`), a
    download (`format_download_summary` -- file, final status, bytes,
    duration), a lookup (`format_lookup_summary` -- `found`/`notfound`/
    `offline`), a preview save (`format_preview_summary` -- `saved`/
    `skipped`/`failed`).
  - `debug` adds the detail you'd actually want when something misbehaves:
    the resolved request URL (`format_request_debug` -- ALWAYS through
    `redact_url` first, see below), the response outcome/status/byte count/
    duration (`format_response_debug`), a download's own failure detail
    (`format_download_failure_debug`), the sidecar cache hit/miss
    (`format_lookup_cache_debug`) and a sidecar write
    (`format_sidecar_write_debug`), the chosen preview candidate URL
    (`format_preview_candidate_debug`), and the two `reason` short-circuits
    a search can take before ever reaching the network
    (`format_search_shortcircuit_debug` -- `invalid_kind`/`rate_limited`).
  - `off` -- genuinely silent: `log_summary`/`log_debug` below return
    BEFORE calling any message builder at all when the resolved level says
    not to, so an "off" run does zero string-formatting work on top of
    doing zero logging.

**🔒 The Civitai API key must NEVER reach a log line, in any form** -- not
the value, a prefix, a length, or a masked rendering (`keys.
resolve_api_key()`'s return value is never passed to anything in this
module). The one place a key rides along on the wire at all is as a
`?token=...` query parameter this package appends to an already-built URL
(`civitai_search.search_models`, `api.py`'s `download_start_impl`) -- so
EVERY url this module ever logs goes through `redact_url` first, which
strips that (and a couple of other plausible secret-shaped) query parameter
spellings before the string is even built, not merely before it's printed.
Only `keys.ResolvedKey.public_only` (a bool) may ever be surfaced anywhere,
same rule `keys.py`'s own docstring already states for API responses,
extended here to log lines.

**🔒 Logging must never change behaviour or add a failure mode.**
`log_summary`/`log_debug` below are the ONLY way any call site in this
package emits a line: both resolve the current level FRESH (cheap -- see
`current_level`'s own docstring) and return immediately, before building or
emitting anything, whenever the level doesn't call for that line; and both
swallow ANY exception from resolving the level, building the message, or the
actual `logger.info(...)` call -- a malformed input, a `logging` handler
misconfiguration, anything -- so a logging call can never be the reason a
search/download/lookup fails. This is IN ADDITION to `_safe` already
guarding every individual message builder (`src/console_logging.py`'s own
docstring); the two are deliberately redundant, since this feature (unlike
`src/anima/`) writes bytes to disk from a remote, adversarial source, and a
logging bug breaking a download would be worse here than a formatting bug
breaking a print statement.

**Never real I/O on the event loop**: every call site in this package that
uses this module already runs off the aiohttp event loop (`api.py`'s routes
all offload their `*_impl` bodies via `run_in_executor`; `DownloadManager`
runs the actual transfer on its own background thread) -- a plain
`logging.Logger.info(...)` call here is the same in-memory-then-handler
call `src/anima/pipeline.py` already makes from ComfyUI's own execution
thread, not a new I/O pattern.
"""
from __future__ import annotations

import logging
import os
import urllib.parse
from typing import Any, Callable, Optional

from .. import console_logging
from ..anima import frontend_settings as frontend_settings_mod

# One logger for the whole feature, same "one name per track" convention
# `src/anima/logs.py`'s own `LOGGER_NAME` establishes -- groups every
# search/download/lookup/preview line under one console/`user/comfyui.log`
# name. The `[AnimaFlow]` prefix still lives in the MESSAGE TEXT (see every
# formatter below), not just the logger name, matching that same precedent.
LOGGER_NAME = "AnimaFlow.model_browser"

# Re-exported from the shared core -- see this module's own docstring for
# why these are imported rather than redefined. `_safe` is "private" by
# convention (leading underscore) in `src/console_logging.py` too; imported
# explicitly here (not via `import *`) since every formatter below needs it.
CONSOLE_LOGGING_SETTING_ID = console_logging.CONSOLE_LOGGING_SETTING_ID
LOG_LEVELS = console_logging.LOG_LEVELS
DEFAULT_LOG_LEVEL = console_logging.DEFAULT_LOG_LEVEL
normalize_log_level = console_logging.normalize_log_level
effective_log_level = console_logging.effective_log_level
is_debug_enabled = console_logging.is_debug_enabled
_safe = console_logging._safe


def current_level() -> str:
    """The console-logging level THIS call should honour, right now --
    `src/anima/pipeline.py`'s own `_log_level()` reads the identical
    Settings-dialog value the exact same way (`frontend_settings.
    get_setting`, mtime-cached, so calling this many times per operation is
    cheap); this is that same pattern's `src/model_browser/` copy, since
    this feature has no single "pipeline.py" funnel point of its own --
    `api.py`/`download.py`/`lookup.py` each call this directly at their own
    log call sites instead. `frontend_settings.get_setting` already reads
    from `..anima.frontend_settings` -- NOT a new coupling: `src/
    model_browser/keys.py` already imports that exact function for the
    Civitai-API-key Settings-dialog value, since it's a generic "read one
    value from ComfyUI's persisted settings file" helper with nothing
    anima-specific in it (see its own module docstring). What this module
    does NOT reuse from `src/anima/` is the LEVEL CORE itself
    (`effective_log_level`/`normalize_log_level`/...) -- that comes from
    `src/console_logging.py` instead, which is the actual coupling this
    task's own instruction was about.

    Never raises -- `get_setting`/`effective_log_level` both already
    degrade to `DEFAULT_LOG_LEVEL`/`"off"` for anything unset/unreadable/
    malformed, and `ANIMAFLOW_DEBUG` (read from the real `os.environ` here,
    the one place this module touches it) forces `"debug"` regardless, same
    precedence `src/anima/logs.py`'s own docstring documents in full.
    """
    setting_value = frontend_settings_mod.get_setting(CONSOLE_LOGGING_SETTING_ID, DEFAULT_LOG_LEVEL)
    return effective_log_level(os.environ, setting_value)


def log_summary(logger: logging.Logger, builder: Callable[..., str], **kwargs: Any) -> None:
    """Emit `builder(**kwargs)` at INFO level through `logger`, but ONLY when
    the CURRENT level is `"summary"` or `"debug"` (never `"off"`) -- the one
    funnel every summary-level call site in this package goes through, so
    "off is genuinely silent" and "a logging call can never raise" are both
    guaranteed structurally here rather than re-proven at each call site.

    Resolves the level FRESH on every call (`current_level()`, itself cheap
    -- mtime-cached file read) rather than threading a level value through
    every caller -- same "just ask again, it's cheap" posture `src/anima/
    pipeline.py`'s own `_should_log()`/`_debug_enabled()` already take.

    Never raises, for ANY reason -- a level-resolution failure, `builder`
    raising despite already being `_safe`-wrapped, or `logger.info` itself
    misbehaving are all swallowed. This is deliberately more defensive than
    `_safe` alone: this feature (unlike `src/anima/`) writes files to disk
    from a remote, adversarial source, so "a logging bug must never break a
    download" is worth an extra guard here, not just on the string-builder.
    """
    try:
        if current_level() == "off":
            return
        logger.info(builder(**kwargs))
    except Exception:  # noqa: BLE001 - a log call must never raise.
        pass


def log_debug(logger: logging.Logger, builder: Callable[..., str], **kwargs: Any) -> None:
    """`log_summary`'s `"debug"`-only twin -- emits `builder(**kwargs)` ONLY
    when the current level is exactly `"debug"` (not `"summary"`), same
    fail-safe posture (never raises, resolves the level fresh every call).
    """
    try:
        if current_level() != "debug":
            return
        logger.info(builder(**kwargs))
    except Exception:  # noqa: BLE001 - a log call must never raise.
        pass


# ---------------------------------------------------------------------------
# 🔒 URL redaction -- the one thing every formatter that logs a URL routes
# through first. See this module's own top docstring for why.
# ---------------------------------------------------------------------------

# Every query-parameter spelling this package (or a plausible future caller)
# might use for a secret riding along in a URL: `token` is Civitai's own
# documented alternative to an `Authorization` header (`civitai_search.
# search_models`/`download_start_impl`'s own doc comments); `api_key`/
# `apikey` are defensive extras -- not currently used anywhere in this
# package, but cheap insurance against a future call site choosing either
# spelling and silently bypassing this redaction if it only knew `token`.
_SECRET_QUERY_PARAMS = frozenset({"token", "api_key", "apikey"})


def redact_url(url: Any) -> str:
    """`url`, with every query parameter in `_SECRET_QUERY_PARAMS` removed --
    the ONLY form a URL may ever reach a log line in this module. Never
    raises: a non-string, or a string that doesn't even parse as a URL,
    degrades to a fixed placeholder rather than risking a partially-redacted
    string reaching a log call (the safe failure direction: refuse to log
    the URL at all rather than log it un-redacted).

    Every OTHER part of the URL (scheme, host, path, every non-secret query
    param, fragment) is preserved -- this is deliberately a narrow redaction,
    not a wholesale "just log the host" downgrade, since the resolved
    request URL minus its secret is exactly the debugging detail the task
    asks for.
    """
    if not isinstance(url, str) or not url:
        return "(no url)"
    try:
        parsed = urllib.parse.urlsplit(url)
        query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        safe_pairs = [(key, value) for key, value in query_pairs if key.lower() not in _SECRET_QUERY_PARAMS]
        redacted_query = urllib.parse.urlencode(safe_pairs)
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, redacted_query, parsed.fragment))
    except Exception:  # noqa: BLE001 - refuse to log rather than risk a leak.
        return "(unloggable url)"


# ---------------------------------------------------------------------------
# Transport (civitai_client.py's `fetch_json_with_host_fallback`, shared by
# search/lookup-by-hash/lookup-by-id) -- debug-only detail.
# ---------------------------------------------------------------------------


def _format_request_debug_impl(*, url: Any) -> str:
    return f"[AnimaFlow] Model Browser request: GET {redact_url(url)}"


format_request_debug = _safe(_format_request_debug_impl)


def _format_response_debug_impl(
    *, url: Any, outcome: str, status: Optional[int] = None,
    byte_count: Optional[int] = None, duration_ms: Optional[float] = None,
) -> str:
    parts = [f"outcome={outcome}"]
    if status is not None:
        parts.append(f"status={int(status)}")
    if byte_count is not None:
        parts.append(f"bytes={int(byte_count)}")
    if duration_ms is not None:
        parts.append(f"duration={float(duration_ms):.0f}ms")
    return f"[AnimaFlow] Model Browser response: {redact_url(url)} -> " + ", ".join(parts)


format_response_debug = _safe(_format_response_debug_impl)


# ---------------------------------------------------------------------------
# Search (api.py's `search_impl`).
# ---------------------------------------------------------------------------


def _format_search_summary_impl(*, kind: Any, query: Any, count: int, reason: str) -> str:
    kind_text = kind if isinstance(kind, str) and kind else "(any)"
    query_text = query if isinstance(query, str) and query else "(empty)"
    return (
        f"[AnimaFlow] Model Browser search: kind={kind_text}, query='{query_text}', "
        f"results={int(count)}, reason={reason}"
    )


format_search_summary = _safe(_format_search_summary_impl)


def _format_search_shortcircuit_debug_impl(*, reason: str, detail: str = "") -> str:
    suffix = f" ({detail})" if detail else ""
    return f"[AnimaFlow] Model Browser search short-circuit: reason={reason}{suffix}"


format_search_shortcircuit_debug = _safe(_format_search_shortcircuit_debug_impl)


# ---------------------------------------------------------------------------
# Download (download.py's `stream_download`).
# ---------------------------------------------------------------------------


def _format_download_summary_impl(
    *, file_name: Any, reason: str, bytes_written: int = 0, duration_ms: Optional[float] = None,
) -> str:
    name_text = file_name if isinstance(file_name, str) and file_name else "(unknown file)"
    duration_text = f", duration={float(duration_ms):.0f}ms" if duration_ms is not None else ""
    return (
        f"[AnimaFlow] Model Browser download: file='{name_text}', status={reason}, "
        f"bytes={int(bytes_written)}{duration_text}"
    )


format_download_summary = _safe(_format_download_summary_impl)


def _format_download_failure_debug_impl(*, reason: str, message: str = "", bytes_written: int = 0) -> str:
    return (
        f"[AnimaFlow] Model Browser download detail: reason={reason}, "
        f"bytes_written={int(bytes_written)}, message='{message}'"
    )


format_download_failure_debug = _safe(_format_download_failure_debug_impl)


# ---------------------------------------------------------------------------
# Lookup (lookup.py's `lookup_model_info`).
# ---------------------------------------------------------------------------


def _format_lookup_summary_impl(*, kind: Any, name: Any, reason: str, offline_reason: Optional[str] = None) -> str:
    kind_text = kind if isinstance(kind, str) and kind else "(unknown kind)"
    name_text = name if isinstance(name, str) and name else "(unknown name)"
    suffix = f" ({offline_reason})" if reason == "offline" and offline_reason else ""
    return f"[AnimaFlow] Model Browser lookup: kind={kind_text}, name='{name_text}', reason={reason}{suffix}"


format_lookup_summary = _safe(_format_lookup_summary_impl)


def _format_lookup_cache_debug_impl(*, name: Any, hit: bool) -> str:
    name_text = name if isinstance(name, str) and name else "(unknown name)"
    state = "hit" if hit else "miss -- fetching from Civitai"
    return f"[AnimaFlow] Model Browser lookup cache: name='{name_text}', {state}"


format_lookup_cache_debug = _safe(_format_lookup_cache_debug_impl)


def _format_sidecar_write_debug_impl(*, name: Any) -> str:
    name_text = name if isinstance(name, str) and name else "(unknown name)"
    return f"[AnimaFlow] Model Browser lookup: wrote sidecar cache for '{name_text}'"


format_sidecar_write_debug = _safe(_format_sidecar_write_debug_impl)


# ---------------------------------------------------------------------------
# Model/version detail (api.py's `model_detail_impl`, `docs/lora-loader-
# design.md`'s "The detail view" -- the one component mounted twice, the
# picker's vertical panel and the modal's master/detail swap).
# ---------------------------------------------------------------------------


def _format_model_detail_summary_impl(*, model_id: Any, version_id: Any, reason: str) -> str:
    model_text = model_id if model_id is not None else "(unknown)"
    version_text = version_id if version_id is not None else "(unknown)"
    return (
        f"[AnimaFlow] Model Browser detail view: model_id={model_text}, "
        f"version_id={version_text}, reason={reason}"
    )


format_model_detail_summary = _safe(_format_model_detail_summary_impl)


# ---------------------------------------------------------------------------
# Community images (api.py's `community_images_impl`, `docs/lora-loader-
# design.md`'s "BOTH galleries, for different reasons" -- the detail view's
# bottom grid, the COMMUNITY's own images for a model version, lazy-loaded
# separately from `model_detail_impl`'s own author-gallery fetch above).
# ---------------------------------------------------------------------------


def _format_community_images_summary_impl(*, version_id: Any, count: int, reason: str) -> str:
    version_text = version_id if version_id is not None else "(unknown)"
    return (
        f"[AnimaFlow] Model Browser community images: version_id={version_text}, "
        f"count={int(count)}, reason={reason}"
    )


format_community_images_summary = _safe(_format_community_images_summary_impl)


# ---------------------------------------------------------------------------
# Delete (remove.py's `delete_model`) -- "Remove an installed model", the
# first code in this pack that destroys user data (docs/TODO.md, decisions
# taken 2026-07-30). A delete is exactly the sort of thing that belongs at
# `summary`, same one-line-per-operation convention every other feature here
# already follows -- never `debug`-only, since this is the operation an
# owner is most likely to want a permanent record of.
# ---------------------------------------------------------------------------


def _format_delete_summary_impl(*, kind: Any, name: Any, reason: str, removed: Any = None) -> str:
    kind_text = kind if isinstance(kind, str) and kind else "(unknown kind)"
    name_text = name if isinstance(name, str) and name else "(unknown name)"
    removed_text = ",".join(removed) if isinstance(removed, (list, tuple)) and removed else "(none)"
    return (
        f"[AnimaFlow] Model Browser delete: kind={kind_text}, name='{name_text}', "
        f"reason={reason}, removed={removed_text}"
    )


format_delete_summary = _safe(_format_delete_summary_impl)


# ---------------------------------------------------------------------------
# Preview save (download.py's `fetch_preview_image` / `finalize_successful_download`,
# and lookup.py's `save_preview` -- the ⓘ backfill's own use of the SAME
# `format_preview_summary` line below, docs/lora-loader-design.md §7c-iv
# "the ⓘ backfill must save the image too").
# ---------------------------------------------------------------------------


def _format_preview_candidate_debug_impl(*, url: Any) -> str:
    return f"[AnimaFlow] Model Browser preview: candidate={redact_url(url)}"


format_preview_candidate_debug = _safe(_format_preview_candidate_debug_impl)


def _format_preview_summary_impl(*, status: str, detail: str = "") -> str:
    suffix = f" ({detail})" if detail else ""
    return f"[AnimaFlow] Model Browser preview: status={status}{suffix}"


format_preview_summary = _safe(_format_preview_summary_impl)


__all__ = (
    "LOGGER_NAME",
    "CONSOLE_LOGGING_SETTING_ID",
    "LOG_LEVELS",
    "DEFAULT_LOG_LEVEL",
    "normalize_log_level",
    "effective_log_level",
    "is_debug_enabled",
    "current_level",
    "log_summary",
    "log_debug",
    "redact_url",
    "format_request_debug",
    "format_response_debug",
    "format_search_summary",
    "format_search_shortcircuit_debug",
    "format_download_summary",
    "format_download_failure_debug",
    "format_lookup_summary",
    "format_lookup_cache_debug",
    "format_sidecar_write_debug",
    "format_delete_summary",
    "format_preview_candidate_debug",
    "format_preview_summary",
    "format_model_detail_summary",
    "format_community_images_summary",
)
