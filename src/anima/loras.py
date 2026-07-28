"""Pure inline-LoRA-list normalization (design doc §5b). Ported from
upstream `_normalize_aio_lora_stack`
(`../ComfyUI-EasyUseAnima/easyuse_anima/aio/model_preparation.py:164-199`,
MIT © n0va39 — THIRD_PARTY_NOTICES.md), **widened** per the design doc:
upstream requires `len(item) >= 3` for a list/tuple entry, so a producer
emitting bare 2-tuples `(name, strength)` has every entry silently dropped;
here `len(item) >= 2` is accepted, defaulting `strength_clip` to
`strength_model`.

No comfy/torch/folder_paths import: resolving a saved LoRA name against
ComfyUI's actual `loras` folder (upstream's `_lora_stack_name`,
`../ComfyUI-EasyUseAnima/easyuse_anima/lora/metadata.py:61-`) is a real
filesystem lookup and belongs in `pipeline.py`'s lazy-imported apply step,
not here — keeping the pure/impure boundary absolute (per this task's brief)
means this module only ever normalizes SHAPE.
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


def _as_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_one(item: Any) -> Optional[Dict[str, Any]]:
    if isinstance(item, dict):
        raw_name = item.get("name", item.get("lora", item.get("lora_name", "")))
        model_strength = item.get(
            "strength_model", item.get("model_strength", item.get("strength", 1.0))
        )
        clip_strength = item.get(
            "strength_clip",
            item.get("clip_strength", item.get("strengthTwo", model_strength)),
        )
    elif isinstance(item, (list, tuple)) and len(item) >= 2:
        # WIDENED from upstream's `len(item) >= 3` (design doc §5b): a
        # producer emitting bare 2-tuples had every entry silently dropped
        # upstream. `strength_clip` defaults to `strength_model` here,
        # exactly like the dict-shape default above.
        raw_name = item[0]
        model_strength = item[1]
        clip_strength = item[2] if len(item) >= 3 else model_strength
    else:
        return None

    name = str(raw_name or "").strip()
    if not name or name.lower() == "none":
        return None
    return {
        "name": name,
        "strength_model": _as_float(model_strength, 1.0),
        "strength_clip": _as_float(clip_strength, _as_float(model_strength, 1.0)),
    }


def normalize_lora_stack(raw: Any) -> List[Dict[str, Any]]:
    """Whatever shape a `generation_settings.loras` value (or a demoted
    external `LORA_STACK`-shaped socket, if one is ever added — design doc
    §5b "appending an optional socket later is safe") arrives in ->
    `[{"name", "strength_model", "strength_clip"}, ...]`, order preserved
    (order IS apply order, §5b).

    Accepted shapes, all promiscuous per upstream:
      - a `{"__value__": ...}` envelope, unwrapped first.
      - a JSON string (parsed; invalid JSON degrades to `[]`).
      - a list of dicts, with several tolerated key spellings for name/
        strengths (`name`/`lora`/`lora_name`,
        `strength_model`/`model_strength`/`strength`,
        `strength_clip`/`clip_strength`/`strengthTwo`).
      - a list of 2+ element lists/tuples: `(name, strength_model[,
        strength_clip])` — see the widened-case note above.

    Entries named empty or `"none"` (case-insensitive) are dropped. Nothing
    else is filtered here — both-zero-strength entries are a BUILD-time
    concern (`entries_to_apply` below); the settings blob keeps a zeroed
    entry, muted rather than deleted, per §5b.
    """
    if isinstance(raw, dict) and "__value__" in raw:
        raw = raw["__value__"]
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except (ValueError, TypeError, RecursionError):
            raw = []
    if not isinstance(raw, list):
        return []

    entries: List[Dict[str, Any]] = []
    for item in raw:
        parsed = _normalize_one(item)
        if parsed is not None:
            entries.append(parsed)
    return entries


def entries_to_apply(entries: Any) -> List[Dict[str, Any]]:
    """The normalized list -> the subset actually applied when building the
    stack: entries where BOTH strengths are exactly `0` are skipped (upstream
    `model_preparation.py:236`) — the settings blob still keeps the row (per
    §5b), but nothing is applied for it. We follow upstream ANIMA here, not
    Pixaroma's own LoRA node (which keeps a zeroed row's trigger words) —
    this pack has no trigger-word output for a zeroed LoRA to contribute to,
    so keeping it would mean applying nothing and claiming something (§5b
    "Two things in their node we deliberately don't copy").
    """
    if not isinstance(entries, list):
        return []
    return [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and not (entry.get("strength_model") == 0 and entry.get("strength_clip") == 0)
    ]
