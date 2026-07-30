"""A minimal, in-process rate limiter for outbound Civitai SEARCH requests
(docs/lora-loader-design.md §9: "Our own rate limiting on search, not just
Civitai's, since a stack of rows could fan out"). A fixed minimum interval
between allowed calls -- deliberately simple, since this pack runs
single-user (one ComfyUI process, typically one person operating one 🔍
panel at a time); a token-bucket/sliding-window scheme would be solving a
multi-tenant problem this pack doesn't have.

Pure enough to unit test without real wall-clock waits: `clock` is an
injectable seam (defaults to `time.monotonic`), the same dependency-
injection shape every other network-adjacent module in this package uses
(`civitai_client.py`'s `opener=`, `civitai_search.py`'s `opener=`,
`download.py`'s `opener=`).
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Optional


class MinIntervalLimiter:
    """Refuses `allow()` within `min_interval_seconds` of the last call that
    itself returned `True`. Thread-safe: aiohttp handlers in this package
    run their real work on the default executor's worker-thread pool (see
    `api.py`'s own `run_in_executor` usage), not just the event-loop
    thread, so two search requests really can race here.
    """

    def __init__(self, min_interval_seconds: float, *, clock: Callable[[], float] = time.monotonic):
        self._min_interval = min_interval_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._last_allowed: Optional[float] = None

    def allow(self) -> bool:
        """`True` and records "now" as the last-allowed instant, or `False`
        without recording anything, if `min_interval_seconds` hasn't
        elapsed since the last allowed call."""
        with self._lock:
            now = self._clock()
            if self._last_allowed is not None and (now - self._last_allowed) < self._min_interval:
                return False
            self._last_allowed = now
            return True

    def seconds_until_allowed(self) -> float:
        """How much longer a caller would have to wait right now for
        `allow()` to return `True` -- `0.0` if it would already. Read-only;
        never itself counts as a call."""
        with self._lock:
            if self._last_allowed is None:
                return 0.0
            remaining = self._min_interval - (self._clock() - self._last_allowed)
            return max(0.0, remaining)


__all__ = ("MinIntervalLimiter",)
