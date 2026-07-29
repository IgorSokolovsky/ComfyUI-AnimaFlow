"""`<base>.civitai.info` sidecar next to a model file -- the offline cache a
successful Civitai hash lookup writes, so every later click is instant and
needs no network at all (docs/lora-loader-design.md §2b/§7e "found" state).

Pure file I/O, no comfy/torch/`folder_paths` import: the CALLER (`lookup.py`)
is the one that already resolved `model_path` through `local.
resolve_model_path`'s traversal guard, so this module never needs to
re-derive a path from a `kind`/`name` pair itself -- it only ever reads,
writes, or deletes the one sidecar path next to a path it's handed.
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional


def sidecar_path(model_path: str) -> str:
    """The sidecar's own path for `model_path` -- always
    `<base-without-extension>.civitai.info`, sitting next to the model file
    so it moves and deletes with it."""
    return os.path.splitext(model_path)[0] + ".civitai.info"


def read_sidecar(model_path: str) -> Optional[Dict[str, Any]]:
    """The cached raw Civitai response for `model_path`, or `None` if no
    sidecar exists, or it exists but can't be read as a JSON object. Never
    raises."""
    path = sidecar_path(model_path)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def write_sidecar(model_path: str, data: Dict[str, Any]) -> bool:
    """Cache `data` (the raw Civitai response) next to `model_path`. Returns
    `True` on success, `False` for any failure (permissions, a read-only
    filesystem, ...) -- never raises."""
    try:
        with open(sidecar_path(model_path), "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


def delete_sidecar(model_path: str) -> bool:
    """"Forget cached" (design doc §1a-i's ⓘ panel footer) -- remove the
    sidecar next to `model_path`, reverting its info back to the file's own
    metadata. Returns `True` if it's gone (deleted, or already absent),
    `False` only on a genuine deletion failure (permissions, ...). Never
    raises."""
    path = sidecar_path(model_path)
    try:
        if os.path.isfile(path):
            os.remove(path)
        return True
    except Exception:
        return False


__all__ = ("sidecar_path", "read_sidecar", "write_sidecar", "delete_sidecar")
