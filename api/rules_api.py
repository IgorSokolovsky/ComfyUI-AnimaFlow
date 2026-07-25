"""aiohttp routes for the Prompt Rules builder + pickers (contract:
docs/nodes-and-api.md §2). All JSON, prefix `/wtn/rules`.

Route REGISTRATION needs a live ComfyUI `server.PromptServer` instance, so
the `from server import PromptServer` import (and the aiohttp import it
implies) is guarded: importing this module OUTSIDE ComfyUI (e.g. from
`test_prompt_rules.py`) must not crash, it just skips registering routes.

The pure `*_impl` functions below have NO aiohttp/ComfyUI dependency at all
(plain args in, plain dicts/lists out) -- those are what's actually tested
standalone, and what the thin aiohttp handlers below call into.
"""
from __future__ import annotations

import json
import os
import re
from typing import Optional

import yaml

import core

try:  # pragma: no cover - exercised implicitly by whichever context imports us
    # Real ComfyUI context: `api` and `nodes` are both subpackages of this
    # custom-node pack's top-level package, so a relative cross-package
    # import is correct here (and avoids ever doing a bare `import nodes`,
    # which would collide with ComfyUI's OWN top-level `nodes.py`).
    from ..nodes.anima_prompt._rules_helpers import (  # type: ignore
        PROFILE_CHOICES,
        RULES_DIR,
        apply_rulesets,
        list_sheets_metadata,
        load_sheet_file,
        sheet_path,
        _guess_character,
    )
except ImportError:
    # Standalone context (plain-script tests, run from the repo root with the
    # repo root on `sys.path`): no parent package to relate to, so fall back
    # to the same bare import the project's other `test_*.py` scripts use.
    from nodes.anima_prompt._rules_helpers import (  # type: ignore
        PROFILE_CHOICES,
        RULES_DIR,
        apply_rulesets,
        list_sheets_metadata,
        load_sheet_file,
        sheet_path,
        _guess_character,
    )


# ---------------------------------------------------------------------------
# Error-shape helper: core's `validate`/`RulesetError` messages look like
# "Error at celica.yaml → rules[0](celica).type, 'bogus' is not supported";
# the API contract wants `{path, message}` (docs/nodes-and-api.md §2), e.g.
# `{path:"celica.yaml -> rules[0](celica).type", message:"…"}`.
# ---------------------------------------------------------------------------

_ERROR_RE = re.compile(r"^Error at (?P<source>.+?) → (?P<path>.+?), (?P<message>.+)$")


def _split_error(raw: str) -> dict:
    m = _ERROR_RE.match(raw)
    if not m:
        return {"path": "<root>", "message": raw}
    return {"path": f"{m.group('source')} -> {m.group('path')}", "message": m.group("message")}


def _sheets_payload_to_selector(sheets) -> Optional[str]:
    """`/preview`'s `sheets?[]` request field -> the `sheets` selector string
    `_rules_helpers.resolve_sheet_selection` understands. `None`/absent keeps
    the node-widget default (all sheets); an explicit `[]` means none.
    """
    if sheets is None:
        return None
    if isinstance(sheets, list):
        return ",".join(str(s) for s in sheets)
    return str(sheets)


def _embedded_payload_to_str(embedded) -> str:
    if embedded is None:
        return ""
    if isinstance(embedded, str):
        return embedded
    return json.dumps(embedded)


# ---------------------------------------------------------------------------
# Pure handlers -- one per route, plain-dict/list in and out (contract §2)
# ---------------------------------------------------------------------------

def profiles_impl() -> list:
    """`GET /wtn/rules/profiles`."""
    return list(PROFILE_CHOICES)


def sheets_impl() -> list:
    """`GET /wtn/rules/sheets`."""
    return list_sheets_metadata()


def sheet_get_impl(name: str) -> dict:
    """`GET /wtn/rules/sheet?name=...`. Raises on a missing/invalid sheet;
    the aiohttp wrapper turns that into a 404.
    """
    ruleset = load_sheet_file(name)
    return {"name": name, "ruleset": ruleset}


def sheet_post_impl(payload: dict) -> dict:
    """`POST /wtn/rules/sheet {name, ruleset}` -- validates then writes
    `rules/<name>.yaml`.
    """
    name = (payload or {}).get("name")
    ruleset = (payload or {}).get("ruleset")
    if not name or not isinstance(name, str):
        return {"ok": False, "errors": [{"path": "name", "message": "'name' is required"}]}
    if not isinstance(ruleset, dict):
        return {"ok": False, "errors": [{"path": "<root>", "message": "'ruleset' must be an object"}]}

    validation = validate_impl({"ruleset": ruleset})
    if not validation["ok"]:
        return {"ok": False, "errors": validation["errors"]}

    try:
        path = sheet_path(name)
    except ValueError as exc:
        return {"ok": False, "errors": [{"path": "name", "message": str(exc)}]}

    os.makedirs(RULES_DIR, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(ruleset, f, sort_keys=False, allow_unicode=True)
    return {"ok": True}


def sheet_delete_impl(name: str) -> dict:
    """`DELETE /wtn/rules/sheet?name=...`."""
    path = sheet_path(name)
    if os.path.exists(path):
        os.remove(path)
    return {"ok": True}


def validate_impl(payload: dict) -> dict:
    """`POST /wtn/rules/validate {ruleset, profile}`."""
    ruleset = (payload or {}).get("ruleset")
    source = (payload or {}).get("name") or "<ruleset>"
    if not isinstance(ruleset, dict):
        return {"ok": False, "errors": [{"path": "<root>", "message": "'ruleset' must be an object"}]}
    result = core.validate(ruleset, source=source)
    return {"ok": result["ok"], "errors": [_split_error(e) for e in result["errors"]]}


def preview_impl(payload: dict) -> dict:
    """`POST /wtn/rules/preview {positive, negative, profile, sheets?, embedded?}`
    -- live preview for the builder + node; calls the engine server-side.
    """
    payload = payload or {}
    positive = payload.get("positive") or ""
    negative = payload.get("negative") or ""
    profile = payload.get("profile") or "raw"
    sheets_selector = _sheets_payload_to_selector(payload.get("sheets"))
    embedded_str = _embedded_payload_to_str(payload.get("embedded"))

    try:
        pos_out, neg_out, trace, errors = apply_rulesets(positive, negative, profile, sheets_selector, embedded_str)
    except KeyError as exc:  # unknown profile (core.load_profile raises KeyError)
        return {"positive": positive, "negative": negative, "trace": [], "errors": [{"path": "profile", "message": str(exc)}]}

    return {"positive": pos_out, "negative": neg_out, "trace": trace, "errors": errors}


def characters_impl() -> list:
    """`GET /wtn/rules/characters` -- best-effort picker data derived from
    each sheet's metadata (a sheet contributes one `character` entry if it
    has a `group` rule addressing a `character:<name>` block; outfit/
    background/pose entries are left for a later, richer sheet convention).
    Empty list if nothing can be derived, per the contract.
    """
    out = []
    for name in list(dict.fromkeys(m["name"] for m in list_sheets_metadata())):
        try:
            ruleset = load_sheet_file(name)
        except (OSError, ValueError):
            continue
        character = _guess_character(ruleset)
        if not character:
            continue
        out.append({
            "token": character,
            "name": character,
            "character": character,
            "kind": "character",
            "from": f"{name}.yaml",
        })
    return out


# ---------------------------------------------------------------------------
# aiohttp route registration -- guarded so this module is importable (and
# its pure `*_impl` functions above testable) with no ComfyUI installed.
# ---------------------------------------------------------------------------

try:
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/wtn/rules/profiles")
    async def _route_profiles(request):  # noqa: ANN001 - aiohttp handler signature
        return web.json_response(profiles_impl())

    @routes.get("/wtn/rules/sheets")
    async def _route_sheets(request):
        return web.json_response(sheets_impl())

    @routes.get("/wtn/rules/sheet")
    async def _route_sheet_get(request):
        name = request.query.get("name", "")
        try:
            return web.json_response(sheet_get_impl(name))
        except (FileNotFoundError, ValueError) as exc:
            return web.json_response({"error": str(exc)}, status=404)

    @routes.post("/wtn/rules/sheet")
    async def _route_sheet_post(request):
        payload = await request.json()
        result = sheet_post_impl(payload)
        return web.json_response(result)

    @routes.delete("/wtn/rules/sheet")
    async def _route_sheet_delete(request):
        name = request.query.get("name", "")
        try:
            return web.json_response(sheet_delete_impl(name))
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @routes.post("/wtn/rules/validate")
    async def _route_validate(request):
        payload = await request.json()
        return web.json_response(validate_impl(payload))

    @routes.post("/wtn/rules/preview")
    async def _route_preview(request):
        payload = await request.json()
        return web.json_response(preview_impl(payload))

    @routes.get("/wtn/rules/characters")
    async def _route_characters(request):
        return web.json_response(characters_impl())

except Exception:  # noqa: BLE001 - any failure here means "not running inside ComfyUI"
    # VERIFY-IN-COMFYUI: route registration itself (the decorators above)
    # only actually runs inside a live ComfyUI process with `server.py`'s
    # `PromptServer.instance` constructed; not exercised by the plain-script
    # tests, which only call the `*_impl` functions directly.
    pass
