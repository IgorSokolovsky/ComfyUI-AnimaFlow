"""Orchestrates one Civitai lookup: sidecar -> hash -> fetch -> sidecar write
(docs/lora-loader-design.md §2b/§7e). `lookup_model_info` is the one
function a route/consumer should call -- it ALWAYS returns a dict carrying a
`reason` of `found` / `notfound` / `offline` (plus a specific
`offline_reason` sub-cause whenever it's `offline`), never raises, and never
opens a socket at all unless the sidecar is missing or a refresh was asked
for -- or unless `cached_only` is set, in which case it can NEVER open a
socket at all, missing sidecar or not (see `cached_only`'s own doc below).
"""
from __future__ import annotations

from typing import Any, Dict

from . import civitai_client, civitai_parse, hashing, sidecar
from .local import resolve_model_path


def lookup_model_info(
    kind: object,
    name: Any,
    *,
    force_refresh: bool = False,
    cached_only: bool = False,
) -> Dict[str, Any]:
    """One model's Civitai info, cache-first.

      - `kind`/`name` don't resolve to a real, guarded local file -> offline
        (`offline_reason="missing_file"`) -- there's nothing to hash and
        nothing to display, and this is deliberately NOT its own top-level
        `reason` value: the caller's `reason`/`offline_reason` switch never
        needs a fifth branch just for this.
      - A cached sidecar exists (checked regardless of `force_refresh` when
        `cached_only` is set -- see below) -> `found`, parsed straight from
        the cached RAW response, no network at all.
      - Otherwise: hash the file, ask Civitai
        (`civitai_client.lookup_by_hash`), and on a genuinely usable
        `found` result (§2b: no `trainedWords`/no `model.name` still
        counts), cache the RAW response to the sidecar so the next call is
        free. A response that comes back 200 but parses to nothing usable
        at all degrades to `notfound`, matching upstream's own rule at
        `../ComfyUI-Pixaroma/server_routes.py:2205-2206`, inside
        `api_lora_civitai` (`:2131-2209`).

    `cached_only` (docs/lora-loader-design.md §7d/§7b decision 20, added for
    the "Civitai" ⚙/Settings switch being off): when set, the cache-check
    block below runs UNCONDITIONALLY (even if `force_refresh` was also
    passed -- `cached_only` wins, since "only ever read the sidecar" is a
    stronger constraint than "skip the sidecar"), and a cache MISS returns
    immediately, right here, before `hashing.sha256_file` or
    `civitai_client.lookup_by_hash` are ever reached. That is what makes
    decision 20's "no path left from which a request could originate" literal
    rather than a UI-layer promise: with this flag set, the function's own
    control flow makes the network-reaching code UNREACHABLE, not merely
    unused. The miss case returns `reason="offline"`,
    `offline_reason="civitai_disabled"` -- distinct from every genuine
    network-failure reason, since nothing was actually attempted.
    """
    path = resolve_model_path(kind, name)
    if path is None:
        return {
            "reason": "offline",
            "offline_reason": "missing_file",
            "message": "That model file could not be found locally.",
            "data": None,
        }

    if not force_refresh or cached_only:
        cached = sidecar.read_sidecar(path)
        if cached is not None:
            parsed = civitai_parse.parse_model_version(cached)
            if parsed:
                return {
                    "reason": "found",
                    "offline_reason": None,
                    "message": "",
                    "data": parsed,
                    "source": "sidecar",
                }

    if cached_only:
        # No sidecar (or nothing usable in it) -- STOP HERE. Reaching
        # `hashing.sha256_file`/`civitai_client.lookup_by_hash` below would
        # be exactly the outbound request `cached_only` exists to make
        # impossible, regardless of what `force_refresh` said.
        return {
            "reason": "offline",
            "offline_reason": "civitai_disabled",
            "message": "Civitai is turned off, and nothing is cached for this file yet.",
            "data": None,
        }

    try:
        sha = hashing.sha256_file(path)
    except OSError as exc:
        return {
            "reason": "offline",
            "offline_reason": "unreadable",
            "message": f"Could not read the file to hash it: {exc}",
            "data": None,
        }

    result = civitai_client.lookup_by_hash(sha)
    if result["reason"] == "offline":
        return {**result, "data": None}
    if result["reason"] == "notfound":
        return {
            "reason": "notfound",
            "offline_reason": None,
            "message": result.get("message", ""),
            "data": None,
        }

    # result["reason"] == "found"
    parsed = civitai_parse.parse_model_version(result["data"])
    if not parsed:
        # A 200 that parsed to nothing usable at all -- matches upstream's
        # own "if not parsed: notfound" rule (this function's own docstring).
        return {"reason": "notfound", "offline_reason": None, "message": "", "data": None}

    sidecar.write_sidecar(path, result["data"])
    return {"reason": "found", "offline_reason": None, "message": "", "data": parsed, "source": "civitai"}


def forget_cached(kind: object, name: Any) -> bool:
    """"Forget cached" -- delete the sidecar for this model, so its info
    reverts to file-derived metadata (or a fresh Civitai lookup next time).
    `False` when the model itself can't be resolved (nothing to forget);
    `sidecar.delete_sidecar`'s own result otherwise."""
    path = resolve_model_path(kind, name)
    if path is None:
        return False
    return sidecar.delete_sidecar(path)


__all__ = ("lookup_model_info", "forget_cached")
