"""Plain-script tests for the model browser's console logging (task: "wire
the model browser into the pack's existing console-logging setting").

Covers: `src/console_logging.py` (the shared level core, now the ONE
definition `src/anima/logs.py` re-exports and `src/model_browser/logs.py`
imports independently -- `tests/test_anima_logs.py` already pins that the
move left `src/anima/`'s own behaviour byte-identical, so this file only
needs to pin the shared module's OWN basic contract, not repeat that whole
suite); `src/model_browser/logs.py`'s own message builders, `redact_url`,
and the `log_summary`/`log_debug` fail-safe/off-is-silent guarantees; and
the real call sites (`api.search_impl`, `download.stream_download`/
`fetch_preview_image`/`finalize_successful_download`,
`lookup.lookup_model_info`) at `off`/`summary`/`debug`, including the one
constraint that matters most: the Civitai API key must NEVER appear in any
emitted log line, at any level.

Run directly: `python tests/test_model_browser_logs.py` (no pytest, per
project convention).
"""
from __future__ import annotations

import logging
import os
import sys
import tempfile
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import console_logging
from src.model_browser import api as mb_api
from src.model_browser import civitai_client, download, keys, lookup, rate_limit, sidecar
from src.model_browser import logs as mb_logs

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


class _ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):  # noqa: D102 - stdlib override
        self.records.append(record.getMessage())


def _capture_logs():
    """Attach a `_ListHandler` to `mb_logs.LOGGER_NAME` and force its level
    to `INFO` (a fresh `logging.Logger` otherwise inherits the root's
    default `WARNING`, which would silently swallow every `.info(...)` call
    below regardless of this feature's OWN "off"/"summary"/"debug" logic --
    a separate gate this test suite must not confuse with the one under
    test). Returns `(handler.records, restore)`."""
    logger = logging.getLogger(mb_logs.LOGGER_NAME)
    previous_level = logger.level
    handler = _ListHandler()
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)

    def restore():
        logger.removeHandler(handler)
        logger.setLevel(previous_level)

    return handler.records, restore


def _with_level(level):
    """Monkeypatch `mb_logs.current_level` to always return `level` --
    same "reassign the module attribute directly" convention every other
    seam in `tests/test_model_browser.py` already uses (`keys.
    resolve_api_key = lambda **kwargs: ...`, `keys.get_setting = lambda ...`).
    Every call site in this package (`api.py`/`download.py`/`lookup.py`/
    `civitai_client.py`) reads `current_level()` off THIS module, so a
    single patch point controls all of them."""
    previous = mb_logs.current_level
    mb_logs.current_level = lambda: level
    return lambda: setattr(mb_logs, "current_level", previous)


def _install_permissive_search_limiter():
    previous = mb_api._SEARCH_LIMITER
    mb_api._SEARCH_LIMITER = rate_limit.MinIntervalLimiter(0.0)
    return lambda: setattr(mb_api, "_SEARCH_LIMITER", previous)


class _FakeResponse:
    def __init__(self, body: bytes, headers=None):
        self._body = body
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        if n is None or n < 0:
            data, self._body = self._body, b""
        else:
            data, self._body = self._body[:n], self._body[n:]
        return data


# ---------------------------------------------------------------------------
# src/console_logging.py -- the shared core, now the ONE definition.
# ---------------------------------------------------------------------------


def test_console_logging_is_the_single_source_the_setting_id_matches():
    assert console_logging.CONSOLE_LOGGING_SETTING_ID == "AnimaFlow.General.ConsoleLogging"
    assert console_logging.LOG_LEVELS == ("off", "summary", "debug")
    assert console_logging.DEFAULT_LOG_LEVEL == "off"


def test_console_logging_normalize_and_effective_level_basic_contract():
    assert console_logging.normalize_log_level("DEBUG") == "debug"
    assert console_logging.normalize_log_level("garbage") == "off"
    assert console_logging.effective_log_level({"ANIMAFLOW_DEBUG": "1"}, "off") == "debug"
    assert console_logging.effective_log_level({}, "summary") == "summary"


def test_console_logging_is_debug_enabled_fails_closed_on_garbage():
    assert console_logging.is_debug_enabled(None) is False
    assert console_logging.is_debug_enabled("not-a-mapping") is False
    assert console_logging.is_debug_enabled({"ANIMAFLOW_DEBUG": "yes"}) is True


def test_anima_logs_reexports_the_exact_same_objects_from_console_logging():
    # A MOVE, not a redesign (task instruction) -- `src/anima/logs.py`'s own
    # names must be the SAME objects, not equal-but-separate copies.
    from src.anima import logs as anima_logs
    assert anima_logs.effective_log_level is console_logging.effective_log_level
    assert anima_logs.normalize_log_level is console_logging.normalize_log_level
    assert anima_logs.is_debug_enabled is console_logging.is_debug_enabled
    assert anima_logs.CONSOLE_LOGGING_SETTING_ID == console_logging.CONSOLE_LOGGING_SETTING_ID


# ---------------------------------------------------------------------------
# redact_url
# ---------------------------------------------------------------------------


def test_redact_url_strips_a_civitai_token_query_param():
    url = "https://civitai.com/api/download/models/123?token=super-secret-key"
    redacted = mb_logs.redact_url(url)
    assert "super-secret-key" not in redacted
    assert "token" not in redacted
    assert redacted.startswith("https://civitai.com/api/download/models/123")


def test_redact_url_strips_api_key_and_apikey_spellings_too():
    assert "shh" not in mb_logs.redact_url("https://x.example/y?api_key=shh")
    assert "shh" not in mb_logs.redact_url("https://x.example/y?apiKey=shh".lower())


def test_redact_url_preserves_every_non_secret_query_param():
    url = "https://civitai.com/api/v1/models?query=anime&limit=20"
    redacted = mb_logs.redact_url(url)
    assert "query=anime" in redacted
    assert "limit=20" in redacted


def test_redact_url_keeps_other_params_alongside_a_stripped_token():
    url = "https://civitai.com/x?limit=5&token=abc123&sort=Newest"
    redacted = mb_logs.redact_url(url)
    assert "abc123" not in redacted
    assert "limit=5" in redacted
    assert "sort=Newest" in redacted


def test_redact_url_never_raises_on_garbage():
    for bad in (None, 12345, "", "not even close to a url::::", ["a", "b"]):
        result = mb_logs.redact_url(bad)
        assert isinstance(result, str) and result


# ---------------------------------------------------------------------------
# Message builders -- shape + fail-safety.
# ---------------------------------------------------------------------------


def test_format_search_summary_names_kind_query_count_and_reason():
    line = mb_logs.format_search_summary(kind="loras", query="anime girl", count=12, reason="ok")
    assert "[AnimaFlow]" in line
    assert "kind=loras" in line
    assert "anime girl" in line
    assert "results=12" in line
    assert "reason=ok" in line


def test_format_search_summary_unscoped_kind_reads_as_any():
    line = mb_logs.format_search_summary(kind=None, query="", count=0, reason="invalid_kind")
    assert "kind=(any)" in line


def test_format_search_summary_fail_safe_on_garbage():
    line = mb_logs.format_search_summary(kind=object(), query=object(), count="not-a-number", reason=None)
    assert isinstance(line, str) and line


def test_format_search_shortcircuit_debug_names_reason_and_detail():
    line = mb_logs.format_search_shortcircuit_debug(reason="rate_limited", detail="minimum interval is 1.5s")
    assert "reason=rate_limited" in line
    assert "1.5s" in line


def test_format_download_summary_names_file_status_bytes_and_duration():
    line = mb_logs.format_download_summary(file_name="thing.safetensors", reason="ok", bytes_written=12345, duration_ms=42.0)
    assert "thing.safetensors" in line
    assert "status=ok" in line
    assert "bytes=12345" in line
    assert "42ms" in line


def test_format_download_summary_fail_safe_on_garbage():
    line = mb_logs.format_download_summary(file_name=object(), reason=None, bytes_written="nope", duration_ms="nope")
    assert isinstance(line, str) and line


def test_format_download_failure_debug_names_reason_and_message():
    line = mb_logs.format_download_failure_debug(reason="incomplete", message="got 5 of 10 bytes", bytes_written=5)
    assert "reason=incomplete" in line
    assert "got 5 of 10 bytes" in line
    assert "bytes_written=5" in line


def test_format_lookup_summary_names_kind_name_and_reason():
    line = mb_logs.format_lookup_summary(kind="loras", name="a.safetensors", reason="found")
    assert "kind=loras" in line
    assert "a.safetensors" in line
    assert "reason=found" in line


def test_format_lookup_summary_appends_offline_reason_only_when_offline():
    offline = mb_logs.format_lookup_summary(kind="loras", name="a", reason="offline", offline_reason="timeout")
    found = mb_logs.format_lookup_summary(kind="loras", name="a", reason="found", offline_reason="timeout")
    assert "timeout" in offline
    assert "timeout" not in found


def test_format_lookup_cache_debug_distinguishes_hit_and_miss():
    hit = mb_logs.format_lookup_cache_debug(name="a.safetensors", hit=True)
    miss = mb_logs.format_lookup_cache_debug(name="a.safetensors", hit=False)
    assert hit != miss
    assert "hit" in hit
    assert "miss" in miss


def test_format_preview_summary_distinguishes_saved_skipped_failed():
    saved = mb_logs.format_preview_summary(status="saved", detail="/x/a.preview.png")
    skipped = mb_logs.format_preview_summary(status="skipped", detail="no preview URL")
    failed = mb_logs.format_preview_summary(status="failed")
    assert len({saved, skipped, failed}) == 3
    assert "saved" in saved and "/x/a.preview.png" in saved
    assert "skipped" in skipped
    assert "failed" in failed


def test_format_request_and_response_debug_redact_url_internally():
    url = "https://civitai.com/api/v1/models?token=leak-me"
    request_line = mb_logs.format_request_debug(url=url)
    response_line = mb_logs.format_response_debug(url=url, outcome="found", status=200, byte_count=10, duration_ms=5.0)
    assert "leak-me" not in request_line
    assert "leak-me" not in response_line
    assert "outcome=found" in response_line
    assert "status=200" in response_line
    assert "bytes=10" in response_line


# ---------------------------------------------------------------------------
# current_level -- the real (impure) resolver.
# ---------------------------------------------------------------------------


def test_current_level_defaults_to_off_with_no_comfyui_and_no_env_override():
    # No `folder_paths` installed in this test environment and no
    # `ANIMAFLOW_DEBUG` set -- degrades to the documented default, same as
    # `src/anima/pipeline.py`'s own `_log_level()` would in this environment.
    previous = os.environ.pop("ANIMAFLOW_DEBUG", None)
    try:
        assert mb_logs.current_level() == "off"
    finally:
        if previous is not None:
            os.environ["ANIMAFLOW_DEBUG"] = previous


def test_current_level_animaflow_debug_env_forces_debug():
    previous = os.environ.get("ANIMAFLOW_DEBUG")
    os.environ["ANIMAFLOW_DEBUG"] = "1"
    try:
        assert mb_logs.current_level() == "debug"
    finally:
        if previous is None:
            os.environ.pop("ANIMAFLOW_DEBUG", None)
        else:
            os.environ["ANIMAFLOW_DEBUG"] = previous


# ---------------------------------------------------------------------------
# log_summary / log_debug -- the fail-safe, off-is-silent funnel.
# ---------------------------------------------------------------------------


def test_log_summary_off_emits_nothing_and_never_even_calls_the_builder():
    restore_level = _with_level("off")
    records, restore_logs = _capture_logs()
    calls = []

    def _builder(**kwargs):
        calls.append(kwargs)
        return "should never be built"

    try:
        mb_logs.log_summary(logging.getLogger(mb_logs.LOGGER_NAME), _builder, x=1)
        mb_logs.log_debug(logging.getLogger(mb_logs.LOGGER_NAME), _builder, x=1)
        assert records == []
        assert calls == []  # off -- not even the string-building ran
    finally:
        restore_logs()
        restore_level()


def test_log_summary_emits_at_summary_and_log_debug_does_not():
    restore_level = _with_level("summary")
    records, restore_logs = _capture_logs()
    try:
        mb_logs.log_summary(logging.getLogger(mb_logs.LOGGER_NAME), lambda **kw: "a summary line")
        mb_logs.log_debug(logging.getLogger(mb_logs.LOGGER_NAME), lambda **kw: "a debug line")
        assert records == ["a summary line"]
    finally:
        restore_logs()
        restore_level()


def test_log_debug_emits_at_debug_level_alongside_summary():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    try:
        mb_logs.log_summary(logging.getLogger(mb_logs.LOGGER_NAME), lambda **kw: "a summary line")
        mb_logs.log_debug(logging.getLogger(mb_logs.LOGGER_NAME), lambda **kw: "a debug line")
        assert records == ["a summary line", "a debug line"]
    finally:
        restore_logs()
        restore_level()


def test_log_summary_never_raises_even_if_the_builder_itself_raises():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()

    def _raising(**kwargs):
        raise RuntimeError("boom")

    try:
        mb_logs.log_summary(logging.getLogger(mb_logs.LOGGER_NAME), _raising)  # must not raise
        mb_logs.log_debug(logging.getLogger(mb_logs.LOGGER_NAME), _raising)  # must not raise
        assert records == []
    finally:
        restore_logs()
        restore_level()


# ---------------------------------------------------------------------------
# civitai_client.fetch_json_with_host_fallback -- shared transport debug.
# ---------------------------------------------------------------------------


def test_civitai_client_debug_logs_request_and_response_lines():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    body = b'{"id": 1, "modelId": 2}'
    try:
        result = civitai_client.lookup_by_hash("deadbeef", opener=lambda url, timeout: _FakeResponse(body))
        assert result["reason"] == "found"
        joined = "\n".join(records)
        assert "request:" in joined and "GET" in joined
        assert "response:" in joined and "outcome=found" in joined
        assert "bytes=" in joined
    finally:
        restore_logs()
        restore_level()


def test_civitai_client_off_emits_nothing_even_on_a_real_lookup():
    restore_level = _with_level("off")
    records, restore_logs = _capture_logs()
    body = b'{"id": 1, "modelId": 2}'
    try:
        civitai_client.lookup_by_hash("deadbeef", opener=lambda url, timeout: _FakeResponse(body))
        assert records == []
    finally:
        restore_logs()
        restore_level()


def test_civitai_client_summary_level_logs_nothing_debug_only_here():
    # This module's own lines are ALL debug-level (the summary line for a
    # lookup is `lookup.py`'s job, not the shared transport's) -- pin that
    # `"summary"` alone produces nothing from this layer.
    restore_level = _with_level("summary")
    records, restore_logs = _capture_logs()
    body = b'{"id": 1, "modelId": 2}'
    try:
        civitai_client.lookup_by_hash("deadbeef", opener=lambda url, timeout: _FakeResponse(body))
        assert records == []
    finally:
        restore_logs()
        restore_level()


def test_civitai_client_404_debug_line_names_notfound():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()

    def _raise_404(url, timeout):
        raise urllib.error.HTTPError("url", 404, "Not Found", None, None)

    try:
        result = civitai_client.lookup_by_hash("deadbeef", opener=_raise_404)
        assert result["reason"] == "notfound"
        joined = "\n".join(records)
        assert "notfound" in joined
        assert "status=404" in joined
    finally:
        restore_logs()
        restore_level()


# ---------------------------------------------------------------------------
# api.search_impl
# ---------------------------------------------------------------------------


def test_search_impl_summary_emits_one_line_naming_count_and_reason():
    restore_limiter = _install_permissive_search_limiter()
    restore_level = _with_level("summary")
    records, restore_logs = _capture_logs()
    previous_search_models = mb_api.civitai_search.search_models
    mb_api.civitai_search.search_models = lambda kind, query, **kwargs: {
        "reason": "found", "offline_reason": None, "message": "",
        "data": {"items": [{
            "id": 1, "name": "X", "modelVersions": [{
                "id": 10, "baseModel": "SDXL",
                "files": [{"name": "x.safetensors", "downloadUrl": "https://civitai.com/x", "primary": True}],
            }],
        }]},
    }
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "anime"})
            assert result["reason"] == "ok"
            assert len(records) == 1
            assert "kind=loras" in records[0]
            assert "results=1" in records[0]
            assert "reason=ok" in records[0]
        finally:
            restore_fp()
            mb_api.civitai_search.search_models = previous_search_models
            restore_logs()
            restore_level()
            restore_limiter()


def test_search_impl_off_emits_nothing():
    restore_limiter = _install_permissive_search_limiter()
    restore_level = _with_level("off")
    records, restore_logs = _capture_logs()
    previous_search_models = mb_api.civitai_search.search_models
    mb_api.civitai_search.search_models = lambda kind, query, **kwargs: {
        "reason": "found", "offline_reason": None, "message": "", "data": {"items": []},
    }
    try:
        mb_api.search_impl({"kind": "loras", "query": "anime"})
        assert records == []
    finally:
        mb_api.civitai_search.search_models = previous_search_models
        restore_logs()
        restore_level()
        restore_limiter()


def test_search_impl_invalid_kind_shortcircuit_logs_debug_detail_and_summary():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    try:
        result = mb_api.search_impl({"kind": "../../etc", "query": "x"})
        assert result["reason"] == "invalid_kind"
        joined = "\n".join(records)
        assert "short-circuit" in joined and "invalid_kind" in joined
        assert "reason=invalid_kind" in joined  # the summary line too
    finally:
        restore_logs()
        restore_level()


def test_search_impl_rate_limited_shortcircuit_logs_debug_detail_and_summary():
    previous_limiter = mb_api._SEARCH_LIMITER
    denying_limiter = rate_limit.MinIntervalLimiter(1000.0)
    denying_limiter.allow()
    mb_api._SEARCH_LIMITER = denying_limiter
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    try:
        result = mb_api.search_impl({"kind": "loras", "query": "x"})
        assert result["reason"] == "rate_limited"
        joined = "\n".join(records)
        assert "short-circuit" in joined and "rate_limited" in joined
    finally:
        restore_logs()
        restore_level()
        mb_api._SEARCH_LIMITER = previous_limiter


# ---------------------------------------------------------------------------
# download.stream_download
# ---------------------------------------------------------------------------


class _FakeDownloadResponse:
    def __init__(self, body: bytes, headers=None):
        self._body = body
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        if n is None or n < 0:
            data, self._body = self._body, b""
        else:
            data, self._body = self._body[:n], self._body[n:]
        return data


def test_stream_download_summary_emits_one_ok_line_with_bytes_and_duration():
    restore_level = _with_level("summary")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.bin")
        payload = b"x" * 100

        def opener(url, timeout):
            return _FakeDownloadResponse(payload, headers={"Content-Length": str(len(payload))})

        try:
            result = download.stream_download("https://civitai.com/x", dest, opener=opener)
            assert result["reason"] == "ok"
            assert len(records) == 1
            assert "a.bin" in records[0]
            assert "status=ok" in records[0]
            assert "bytes=100" in records[0]
            assert "duration=" in records[0]
        finally:
            restore_logs()
            restore_level()


def test_stream_download_off_emits_nothing():
    restore_level = _with_level("off")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.bin")
        payload = b"x" * 10

        def opener(url, timeout):
            return _FakeDownloadResponse(payload, headers={"Content-Length": str(len(payload))})

        try:
            download.stream_download("https://civitai.com/x", dest, opener=opener)
            assert records == []
        finally:
            restore_logs()
            restore_level()


def test_stream_download_debug_names_the_incomplete_failure_branch():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.bin")
        payload = b"short"

        def opener(url, timeout):
            # Content-Length lies -- claims more than the body actually has,
            # so `_stream_download_core` reports "incomplete".
            return _FakeDownloadResponse(payload, headers={"Content-Length": "999"})

        try:
            result = download.stream_download("https://civitai.com/x", dest, opener=opener)
            assert result["reason"] == "incomplete"
            joined = "\n".join(records)
            assert "status=incomplete" in joined  # the summary line
            assert "reason=incomplete" in joined  # the debug failure-detail line
        finally:
            restore_logs()
            restore_level()


def test_stream_download_debug_logs_the_redacted_request_url():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.bin")
        payload = b"x" * 10
        url_with_token = "https://civitai.com/x?token=super-secret-download-key"

        def opener(url, timeout):
            return _FakeDownloadResponse(payload, headers={"Content-Length": str(len(payload))})

        try:
            download.stream_download(url_with_token, dest, opener=opener)
            joined = "\n".join(records)
            assert "super-secret-download-key" not in joined
            assert "civitai.com/x" in joined
        finally:
            restore_logs()
            restore_level()


# ---------------------------------------------------------------------------
# download.fetch_preview_image / finalize_successful_download
# ---------------------------------------------------------------------------


def test_finalize_successful_download_summary_reports_saved():
    restore_level = _with_level("summary")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.safetensors")
        open(dest, "wb").close()
        png_bytes = b"\x89PNG\r\n\x1a\nrest-of-a-fake-png"

        def preview_opener(url, timeout):
            return _FakeDownloadResponse(png_bytes, headers={"Content-Type": "image/png"})

        try:
            download.finalize_successful_download(
                dest, preview_url="https://image.civitai.com/x.png",
                civitai_enabled=True, preview_opener=preview_opener,
            )
            assert len(records) == 1
            assert "status=saved" in records[0]
            assert dest.replace(".safetensors", ".preview.png") in records[0]
        finally:
            restore_logs()
            restore_level()


def test_finalize_successful_download_summary_reports_skipped_when_civitai_disabled():
    restore_level = _with_level("summary")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.safetensors")
        open(dest, "wb").close()
        try:
            download.finalize_successful_download(dest, preview_url="https://image.civitai.com/x.png", civitai_enabled=False)
            assert len(records) == 1
            assert "status=skipped" in records[0]
            assert "disabled" in records[0]
        finally:
            restore_logs()
            restore_level()


def test_finalize_successful_download_summary_reports_failed_on_a_bad_response():
    restore_level = _with_level("summary")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.safetensors")
        open(dest, "wb").close()

        def preview_opener(url, timeout):
            return _FakeDownloadResponse(b"not an image", headers={"Content-Type": "text/html"})

        try:
            download.finalize_successful_download(
                dest, preview_url="https://image.civitai.com/x.png",
                civitai_enabled=True, preview_opener=preview_opener,
            )
            assert len(records) == 1
            assert "status=failed" in records[0]
        finally:
            restore_logs()
            restore_level()


def test_fetch_preview_image_debug_logs_the_candidate_url():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    png_bytes = b"\x89PNG\r\n\x1a\nrest"

    def opener(url, timeout):
        return _FakeDownloadResponse(png_bytes, headers={"Content-Type": "image/png"})

    with tempfile.TemporaryDirectory() as tmp:
        dest = os.path.join(tmp, "a.safetensors")
        try:
            download.fetch_preview_image("https://image.civitai.com/x.png?original=true", dest, opener=opener)
            joined = "\n".join(records)
            assert "candidate=" in joined
            assert "image.civitai.com" in joined
        finally:
            restore_logs()
            restore_level()


# ---------------------------------------------------------------------------
# lookup.lookup_model_info -- cache hit/miss debug + summary + sidecar-write.
# ---------------------------------------------------------------------------


def _install_fake_folder_paths(roots_by_folder, names_by_folder):
    import types

    fake = types.ModuleType("folder_paths")
    fake.get_folder_paths = lambda folder: list(roots_by_folder.get(folder, []))
    fake.get_filename_list = lambda folder: list(names_by_folder.get(folder, []))

    def get_full_path(folder, name):
        for root in roots_by_folder.get(folder, []):
            candidate = os.path.join(root, name)
            if os.path.isfile(candidate):
                return candidate
        return None

    fake.get_full_path = get_full_path
    previous = sys.modules.get("folder_paths")
    sys.modules["folder_paths"] = fake
    return lambda: (sys.modules.pop("folder_paths", None) if previous is None else sys.modules.__setitem__("folder_paths", previous))


def test_lookup_model_info_cache_hit_logs_debug_and_summary_found():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        open(model_path, "wb").close()
        sidecar.write_sidecar(model_path, {"modelId": 1, "id": 2, "baseModel": "SDXL", "_wtn_model_description_checked": True})

        restore_fp = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": ["a.safetensors"]},
        )
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["reason"] == "found"
            joined = "\n".join(records)
            assert "cache:" in joined and "hit" in joined
            assert "reason=found" in joined
        finally:
            restore_fp()
            restore_logs()
            restore_level()


def test_lookup_model_info_cache_miss_then_fetch_and_write_logs_debug_miss_and_sidecar_write():
    restore_level = _with_level("debug")
    records, restore_logs = _capture_logs()
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        model_path = os.path.join(loras_root, "a.safetensors")
        with open(model_path, "wb") as fh:
            fh.write(b"some bytes")

        restore_fp = _install_fake_folder_paths(
            roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": ["a.safetensors"]},
        )
        previous_lookup = lookup.civitai_client.lookup_by_hash
        previous_by_id = lookup.civitai_client.lookup_model_by_id
        lookup.civitai_client.lookup_by_hash = lambda sha, **kw: {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {"modelId": 7, "id": 8, "baseModel": "Pony"},
        }
        lookup.civitai_client.lookup_model_by_id = lambda model_id, **kw: {
            "reason": "offline", "offline_reason": "timeout", "message": "", "data": None,
        }
        try:
            result = lookup.lookup_model_info("loras", "a.safetensors")
            assert result["reason"] == "found" and result["source"] == "civitai"
            joined = "\n".join(records)
            assert "cache:" in joined and "miss" in joined
            assert "wrote sidecar cache" in joined
            assert "reason=found" in joined
        finally:
            lookup.civitai_client.lookup_by_hash = previous_lookup
            lookup.civitai_client.lookup_model_by_id = previous_by_id
            restore_fp()
            restore_logs()
            restore_level()


def test_lookup_model_info_missing_file_summary_reports_offline_missing_file():
    restore_level = _with_level("summary")
    records, restore_logs = _capture_logs()
    try:
        result = lookup.lookup_model_info("../../etc", "passwd")
        assert result["reason"] == "offline"
        assert len(records) == 1
        assert "reason=offline" in records[0]
        assert "missing_file" in records[0]
    finally:
        restore_logs()
        restore_level()


def test_lookup_model_info_off_emits_nothing():
    restore_level = _with_level("off")
    records, restore_logs = _capture_logs()
    try:
        lookup.lookup_model_info("../../etc", "passwd")
        assert records == []
    finally:
        restore_logs()
        restore_level()


# ---------------------------------------------------------------------------
# 🔒 The Civitai API key must NEVER appear in any emitted log line, at any
# level -- the hard constraint this whole task is built around.
# ---------------------------------------------------------------------------

_SECRET_API_KEY = "totally-real-civitai-secret-4f8a9c"


def test_api_key_never_appears_in_any_log_line_across_search_and_download():
    restore_limiter = _install_permissive_search_limiter()
    restore_level = _with_level("debug")  # the MOST verbose level -- the strongest test
    records, restore_logs = _capture_logs()

    previous_resolve = keys.resolve_api_key
    keys.resolve_api_key = lambda **kwargs: keys.ResolvedKey(_SECRET_API_KEY, "setting")

    previous_search_models = mb_api.civitai_search.search_models
    captured_search_kwargs = {}

    def fake_search_models(kind, query, **kwargs):
        captured_search_kwargs.update(kwargs)
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {"items": [{
                "id": 1, "name": "X", "modelVersions": [{
                    "id": 10, "baseModel": "SDXL",
                    "files": [{"name": "x.safetensors", "downloadUrl": "https://civitai.com/x", "primary": True}],
                }],
            }]},
        }

    mb_api.civitai_search.search_models = fake_search_models

    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            mb_api.search_impl({"kind": "loras", "query": "x"})
            assert captured_search_kwargs.get("api_key") == _SECRET_API_KEY  # sanity: the key WAS in play

            # And a download whose fetch URL carries the key as `?token=...`
            # (exactly what `download_start_impl` builds in real use).
            dest = os.path.join(loras_root, "new.safetensors")
            payload = b"x" * 50

            def opener(url, timeout):
                return _FakeDownloadResponse(payload, headers={"Content-Length": str(len(payload))})

            fetch_url = f"https://civitai.com/api/download/models/1?token={_SECRET_API_KEY}"
            download.stream_download(fetch_url, dest, opener=opener)

            for message in records:
                assert _SECRET_API_KEY not in message, message
        finally:
            restore_fp()
            mb_api.civitai_search.search_models = previous_search_models
            keys.resolve_api_key = previous_resolve
            restore_logs()
            restore_level()
            restore_limiter()


ALL_TESTS = [
    test_console_logging_is_the_single_source_the_setting_id_matches,
    test_console_logging_normalize_and_effective_level_basic_contract,
    test_console_logging_is_debug_enabled_fails_closed_on_garbage,
    test_anima_logs_reexports_the_exact_same_objects_from_console_logging,
    test_redact_url_strips_a_civitai_token_query_param,
    test_redact_url_strips_api_key_and_apikey_spellings_too,
    test_redact_url_preserves_every_non_secret_query_param,
    test_redact_url_keeps_other_params_alongside_a_stripped_token,
    test_redact_url_never_raises_on_garbage,
    test_format_search_summary_names_kind_query_count_and_reason,
    test_format_search_summary_unscoped_kind_reads_as_any,
    test_format_search_summary_fail_safe_on_garbage,
    test_format_search_shortcircuit_debug_names_reason_and_detail,
    test_format_download_summary_names_file_status_bytes_and_duration,
    test_format_download_summary_fail_safe_on_garbage,
    test_format_download_failure_debug_names_reason_and_message,
    test_format_lookup_summary_names_kind_name_and_reason,
    test_format_lookup_summary_appends_offline_reason_only_when_offline,
    test_format_lookup_cache_debug_distinguishes_hit_and_miss,
    test_format_preview_summary_distinguishes_saved_skipped_failed,
    test_format_request_and_response_debug_redact_url_internally,
    test_current_level_defaults_to_off_with_no_comfyui_and_no_env_override,
    test_current_level_animaflow_debug_env_forces_debug,
    test_log_summary_off_emits_nothing_and_never_even_calls_the_builder,
    test_log_summary_emits_at_summary_and_log_debug_does_not,
    test_log_debug_emits_at_debug_level_alongside_summary,
    test_log_summary_never_raises_even_if_the_builder_itself_raises,
    test_civitai_client_debug_logs_request_and_response_lines,
    test_civitai_client_off_emits_nothing_even_on_a_real_lookup,
    test_civitai_client_summary_level_logs_nothing_debug_only_here,
    test_civitai_client_404_debug_line_names_notfound,
    test_search_impl_summary_emits_one_line_naming_count_and_reason,
    test_search_impl_off_emits_nothing,
    test_search_impl_invalid_kind_shortcircuit_logs_debug_detail_and_summary,
    test_search_impl_rate_limited_shortcircuit_logs_debug_detail_and_summary,
    test_stream_download_summary_emits_one_ok_line_with_bytes_and_duration,
    test_stream_download_off_emits_nothing,
    test_stream_download_debug_names_the_incomplete_failure_branch,
    test_stream_download_debug_logs_the_redacted_request_url,
    test_finalize_successful_download_summary_reports_saved,
    test_finalize_successful_download_summary_reports_skipped_when_civitai_disabled,
    test_finalize_successful_download_summary_reports_failed_on_a_bad_response,
    test_fetch_preview_image_debug_logs_the_candidate_url,
    test_lookup_model_info_cache_hit_logs_debug_and_summary_found,
    test_lookup_model_info_cache_miss_then_fetch_and_write_logs_debug_miss_and_sidecar_write,
    test_lookup_model_info_missing_file_summary_reports_offline_missing_file,
    test_lookup_model_info_off_emits_nothing,
    test_api_key_never_appears_in_any_log_line_across_search_and_download,
]


if __name__ == "__main__":
    failures = []
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
