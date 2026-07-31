"""Generic "how verbose should this pack's console logging be right now"
core -- the "off"/"summary"/"debug" vocabulary, the `ANIMAFLOW_DEBUG`
override, and the fail-safe wrapper every log-message builder in this pack
is wrapped in. Extracted 2026-07-31 from `src/anima/logs.py`, which used to
define all of this itself; `src/model_browser/logs.py` (the Civitai
browser's own search/download/lookup console log) now shares this SAME
definition rather than a second copy.

**Why this lives here, not inside either feature**: `.claude/CLAUDE.md`'s
`src/<feature>/` rule groups a feature's own logic into one folder
specifically so a feature is independent of the others; `src/model_browser/`
importing this core FROM `src/anima/` (or the reverse) would coeuple two
features that otherwise share nothing, for the sake of ~40 lines with no
feature-specific behaviour in it at all. A flat module directly under `src/`
-- a sibling of `src/anima/`/`src/model_browser/`, not a subpackage of
either -- is the smallest thing that avoids that coupling: both features
depend on this one shared, nobody-owns-it module instead, the same role
`js/shared/` already plays for the frontend half of this pack (theme,
highlight, the overlay mechanism -- see `.claude/CLAUDE.md`'s JS layout
section). It is deliberately NOT a new `src/<feature>/` of its own: there is
no feature here, just shared vocabulary, so a package would be the wrong
size for what this is.

**This is a MOVE, not a redesign.** Every symbol below is exactly what
`src/anima/logs.py` used to define at module scope
(`CONSOLE_LOGGING_SETTING_ID`, `LOG_LEVELS`, `DEFAULT_LOG_LEVEL`,
`normalize_log_level`, `effective_log_level`, `is_debug_enabled`, and the
`_safe` fail-safe decorator), copied verbatim. `src/anima/logs.py` now
re-exports these same names (`from ..console_logging import ...`), so every
existing caller (`pipeline.py`, `nodes/anima/preview.py`,
`tests/test_anima_logs.py`) keeps resolving `logs_mod.CONSOLE_LOGGING_SETTING_ID`
etc. exactly as before -- behaviour, including the `ANIMAFLOW_DEBUG`
precedence, is byte-identical to before this extraction.

See `src/anima/logs.py`'s own module docstring for the full "Verbosity
contract" / "Two ways to set the level" write-up (the env-var override,
the Settings-dialog value, and how `effective_log_level` combines them) --
not repeated here, so the two copies of that explanation can't drift apart;
this module is deliberately the terse, implementation-only half, and
`src/model_browser/logs.py`'s own docstring covers what THAT feature adds
on top (its own logger name, its own message builders, its own call sites).
"""
from __future__ import annotations

import functools
from typing import Any, Callable, Optional

# Truthy spellings for `ANIMAFLOW_DEBUG` -- case-insensitive, matching every
# other "is this env var on" convention in this ecosystem.
_TRUTHY_ENV_VALUES = {"1", "true", "yes", "on"}


def is_debug_enabled(env: Optional[Any] = None) -> bool:
    """Is `ANIMAFLOW_DEBUG` set to a truthy value in `env` (a plain mapping --
    pass `os.environ` at the real call site)? Fails CLOSED (`False`) for
    `None`, a non-mapping, or a `.get` that itself raises -- never crashes,
    and never turns debug logging on by accident for a garbage input.
    """
    try:
        if env is None:
            return False
        value = env.get("ANIMAFLOW_DEBUG")
    except Exception:
        return False
    if value is None:
        return False
    try:
        return str(value).strip().lower() in _TRUTHY_ENV_VALUES
    except Exception:
        return False


# The id every feature's own `frontend_settings.get_setting` call reads from
# `comfy.settings.json`, and the id `js/shared/settings.mjs`'s
# `SETTING_IDS.CONSOLE_LOGGING` declares on the frontend side -- the two
# literals MUST match byte-for-byte; there is no shared module between the
# two languages, so this is duplicated by necessity (same convention as
# `GENERATION_SETTINGS_SCHEMA` existing in both `settings.py` and
# `state.mjs`). ONE Settings-dialog control governs every feature's console
# log -- there is no separate "Model Browser" logging toggle, by design (the
# owner asked to "wire the model browser into the pack's EXISTING
# console-logging setting").
CONSOLE_LOGGING_SETTING_ID = "AnimaFlow.General.ConsoleLogging"

# The three legal levels, in increasing verbosity order, and the default for
# anything unset/garbage.
LOG_LEVELS = ("off", "summary", "debug")
DEFAULT_LOG_LEVEL = "off"


def normalize_log_level(value: Any) -> str:
    """Coerce whatever `comfy.settings.json` (or a hand-edited config) handed
    back for the console-logging setting into one of `LOG_LEVELS`, falling
    back to `DEFAULT_LOG_LEVEL` for anything else at all (`None`, the wrong
    type, an unrecognised string, a `str()`/`.lower()` call that itself
    raises) -- never throws.
    """
    try:
        text = str(value).strip().lower()
    except Exception:
        return DEFAULT_LOG_LEVEL
    return text if text in LOG_LEVELS else DEFAULT_LOG_LEVEL


def effective_log_level(env: Optional[Any] = None, setting_value: Any = None) -> str:
    """The console-logging level a caller should actually use THIS call,
    combining both inputs with the documented precedence: `ANIMAFLOW_DEBUG`
    truthy in `env` forces `"debug"`, unconditionally, regardless of
    `setting_value` -- the override for a headless run with no browser
    attached. Otherwise, `setting_value` (whatever the caller's own
    settings-file read handed back) is normalized via `normalize_log_level`
    and used as-is. Never raises -- both halves already fail closed on
    their own.
    """
    if is_debug_enabled(env):
        return "debug"
    return normalize_log_level(setting_value)


def _safe(fn: Callable[..., str]) -> Callable[..., str]:
    """Wrap a message builder so ANY exception it raises degrades to a
    short fallback string naming the builder, never propagates -- the
    mechanism behind this pack's "a log line must never be worth an
    exception mid-operation" contract. Every public message-building
    function in `src/anima/logs.py` and `src/model_browser/logs.py` is
    defined as a plain `_*_impl` and exported through this decorator, so
    the fail-safe behaviour can't be forgotten function-by-function.
    """

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> str:
        try:
            return fn(*args, **kwargs)
        except Exception:  # noqa: BLE001 - a log line must never raise.
            return f"[AnimaFlow] (log message unavailable: {fn.__name__})"

    return wrapper


__all__ = (
    "CONSOLE_LOGGING_SETTING_ID",
    "LOG_LEVELS",
    "DEFAULT_LOG_LEVEL",
    "is_debug_enabled",
    "normalize_log_level",
    "effective_log_level",
)
