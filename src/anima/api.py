"""aiohttp route for `js/anima/`'s Preview "Save now" button (task item 6):

    POST /wtn/anima/preview/save_now
      {stages: {stage: {filename, subfolder, type}}, preview_state: "...json...",
       seed: "1234...decimal-string" | absent}
      -> {ok: true, filename, subfolder, stage} | {ok: false, error: "..."}

Fires when the user clicks "Save now" on a Preview node whose
`preview.save.enabled` is off (the new default, task item 6) -- it writes
the best-available stage (`final` -> `mid` -> `base`) through the exact same
filename template + save path a normal enabled save would use, on demand,
without turning saving on. This runs OUTSIDE a graph run, so there is no
`AnimaPreview.preview()` execution to piggyback on; that is exactly why a
small dedicated route exists (task brief) rather than re-queuing the graph.

The actual decision (which stage wins) and file I/O both live in
`nodes/anima/_preview_helpers.py`'s `save_now` (impure, folder_paths/PIL) --
this module is JUST the aiohttp wiring, the thinnest possible layer,
following `src/prompt_rules/api/rules_api.py`'s own precedent: pure/impure
logic lives elsewhere, this file only translates an HTTP request into a
plain-Python call and its result back into a JSON response.

Route REGISTRATION needs a live ComfyUI `server.PromptServer` instance, so
the `from server import PromptServer` import (and the aiohttp import it
implies) is guarded exactly like `rules_api.py`: importing this module
OUTSIDE ComfyUI (e.g. from a plain-script test) must not crash, it just
skips registering the route.
"""
from __future__ import annotations

from typing import Any, Dict

try:
    # Real ComfyUI context: this module's own package is `src.anima`
    # (two components deep from the pack root: `src`, `anima`) -- same "own
    # package + ascend to the pack root, then descend" convention
    # `nodes/anima/preview.py` (also two components deep, `nodes`/`anima`)
    # already uses for the mirror-image reach (THREE dots: `anima` -> `src`
    # -> pack root).
    from ...nodes.anima._preview_helpers import SaveNowError, save_now  # type: ignore
except ImportError:
    # Standalone context (plain-script tests, repo root on `sys.path`).
    from nodes.anima._preview_helpers import SaveNowError, save_now

try:
    from .preview_settings import normalize_preview_settings  # type: ignore
except ImportError:
    from src.anima.preview_settings import normalize_preview_settings


def save_now_impl(payload: Dict[str, Any]) -> Dict[str, Any]:
    """`POST /wtn/anima/preview/save_now`'s pure-python body -- plain dict in,
    plain dict out, no aiohttp/Request object anywhere, so this is what's
    actually exercised by a plain-script test (mirrors `rules_api.py`'s own
    `*_impl` split). Never raises `SaveNowError` itself -- catches it and
    reports `{ok: False, error}` instead, so the aiohttp wrapper below only
    has to decide a status code, not parse an exception.
    """
    payload = payload or {}
    stage_entries = payload.get("stages")
    preview_state = payload.get("preview_state")
    # `seed` (fixes `%seed%` always resolving to `0` -- `docs/TODO.md`'s last
    # Now item): `js/anima/interaction.mjs`'s Save-now handler now echoes
    # back the seed `nodes/anima/preview.py`'s own `anima_seed` `ui` payload
    # stashed on the last run, as a decimal STRING (never a JSON number --
    # design doc §8's precision rule). Passed through UNCONVERTED and
    # UNVALIDATED here -- this route is just the aiohttp wiring (this
    # module's own top doc comment); the actual hostile-input handling (a
    # missing/`None`/garbage/negative/oversized value must never raise, and
    # must still produce a file) is `_preview_helpers.save_now`'s job, at its
    # single `resolve_seed_int` conversion point, not this route's.
    # `payload.get("seed", 0)`'s own default only ever fires when the key is
    # missing entirely (an explicit posted `null` arrives as `None` instead,
    # which `resolve_seed_int` also degrades to `0` -- see its own doc
    # comment) -- either way this route never has to tell those two cases
    # apart itself.
    #
    # **One limitation this does NOT paper over**: a CACHED Preview node
    # (this run served from ComfyUI's own execution cache) emits no `ui`
    # payload at all, so the frontend's `node._anSeed` is never populated for
    # that queue and posts no `seed` key here either -- `%seed%` correctly
    # falls back to `0` in that case, the same "no report this run"
    # degradation design doc §5a-0 already documents for the Generator's own
    # context report. There is no fix for this short of re-running the
    # graph; see `nodes/anima/preview.py`'s own doc comment on the same gap.
    seed = payload.get("seed", 0)

    preview_settings = normalize_preview_settings(preview_state if preview_state is not None else "{}")

    try:
        result = save_now(stage_entries=stage_entries, preview_settings=preview_settings, seed=seed)
    except SaveNowError as exc:
        return {"ok": False, "error": str(exc)}

    return {"ok": True, **result}


try:
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.post("/wtn/anima/preview/save_now")
    async def _route_save_now(request):  # noqa: ANN001 - aiohttp handler signature
        payload = await request.json()
        result = save_now_impl(payload)
        status = 200 if result.get("ok") else 400
        return web.json_response(result, status=status)

except Exception:  # noqa: BLE001 - any failure here means "not running inside ComfyUI"
    # VERIFY-IN-COMFYUI: route registration itself (the decorator above) only
    # actually runs inside a live ComfyUI process with `server.py`'s
    # `PromptServer.instance` constructed; not exercised by the plain-script
    # tests, which only call `save_now_impl` directly.
    pass
