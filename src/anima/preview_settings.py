"""`AnimaPreview`'s own settings blob (design doc §8: compare + save), same
hidden-serialized-STRING pattern and same tolerant/additive normalization
contract as `settings.py` — kept in its own module since it belongs to a
different node's state, not the Generator's `generation_settings`. Reuses
`settings.py`'s pure `_deep_merge_defaults`/`migrate_version` rather than
duplicating them.
"""
from __future__ import annotations

import json
from typing import Any, Dict

from .settings import _deep_merge_defaults, migrate_version

PREVIEW_SETTINGS_SCHEMA = "animaflow.anima_preview.preview_state"
PREVIEW_SETTINGS_VERSION = 1

# design doc §8's `compare`/`save` shapes verbatim, plus §7a's filename-token
# list (`%stage%` is the one that justifies putting save on THIS node at all
# — §2/§7a) and `which` values (`"shown"` / `"both compared"` / `"every
# wired input"`).
DEFAULT_PREVIEW_SETTINGS: Dict[str, Any] = {
    "schema": PREVIEW_SETTINGS_SCHEMA,
    "version": PREVIEW_SETTINGS_VERSION,
    "compare": {"enabled": True, "a": "base", "b": "final"},
    "save": {
        # On by default -- this is the only node in the pair that saves
        # (design doc §7a).
        "enabled": True,
        "which": "shown",
        "extension": "png",
        "path": "AnimaFlow",
        "filename": "%date:yyyy-MM-dd%_%seed%_%stage%",
        "embed_workflow": True,
    },
}

# `compare.a`/`compare.b` and `save.which` are free-standing enums the
# (not-yet-built) frontend will present as pickers; kept here so
# `pipeline`/node code has one place to validate against.
COMPARE_SLOTS = ("base", "mid", "final")
SAVE_WHICH_OPTIONS = ("shown", "both compared", "every wired input")


def normalize_preview_settings(raw: Any) -> Dict[str, Any]:
    """Same hostile-input contract as `settings.normalize_generation_settings`:
    never raises, unknown keys pass through, missing keys default, a version
    bump migrates forward.
    """
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError, RecursionError):
        parsed = None
    if not isinstance(parsed, dict):
        parsed = {}

    merged = _deep_merge_defaults(DEFAULT_PREVIEW_SETTINGS, parsed)
    compare = merged.get("compare")
    if isinstance(compare, dict):
        if compare.get("a") not in COMPARE_SLOTS:
            compare["a"] = "base"
        if compare.get("b") not in COMPARE_SLOTS:
            compare["b"] = "final"
    save = merged.get("save")
    if isinstance(save, dict) and save.get("which") not in SAVE_WHICH_OPTIONS:
        save["which"] = "shown"

    merged["schema"] = PREVIEW_SETTINGS_SCHEMA
    merged["version"] = migrate_version(parsed.get("version"), PREVIEW_SETTINGS_VERSION)
    return merged


def format_filename(
    template: str, *, stage: str, seed: Any, width: int, height: int, counter: int, now: Any = None,
) -> str:
    """Expand the design doc §7a filename tokens: `%stage%` (`base`/`mid`/
    `final` — the one that justifies putting save on the Preview node at
    all, §2/§7a), `%seed%`, `%date:FMT%`, `%counter:N%`, `%width%`,
    `%height%`. Pure given an explicit `now` — callers pass the real current
    time; tests pass a fixed one for determinism. No comfy/torch import.
    """
    import datetime as _dt
    import re

    if now is None:
        now = _dt.datetime.now()

    def _date_token(match: "re.Match[str]") -> str:
        fmt = match.group(1)
        # A small yyyy/MM/dd/HH/mm/ss token set (translated to strftime)
        # rather than raw strftime codes, matching how these read elsewhere
        # in the pack's design docs.
        py_fmt = (
            fmt.replace("yyyy", "%Y").replace("MM", "%m").replace("dd", "%d")
            .replace("HH", "%H").replace("mm", "%M").replace("ss", "%S")
        )
        try:
            return now.strftime(py_fmt)
        except ValueError:
            return now.strftime("%Y-%m-%d-%H%M%S")

    def _counter_token(match: "re.Match[str]") -> str:
        try:
            pad = int(match.group(1))
        except (TypeError, ValueError):
            pad = 4
        return str(max(0, int(counter))).zfill(max(1, pad))

    result = str(template or "")
    result = re.sub(r"%date:([^%]*)%", _date_token, result)
    result = re.sub(r"%counter:(\d+)%", _counter_token, result)
    result = result.replace("%stage%", str(stage))
    result = result.replace("%seed%", str(seed))
    result = result.replace("%width%", str(int(width)))
    result = result.replace("%height%", str(int(height)))
    return result
