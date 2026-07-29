"""Plain-script tests for `src/anima/api.py` -- the `/wtn/anima/preview/
save_now` route (task item 6). Mirrors `test_prompt_rules.py`'s own pattern
for `src/prompt_rules/api/rules_api.py`: import the module with no live
ComfyUI (the route-registration `try/except` must swallow the missing
`aiohttp`/`server.PromptServer`, not crash), then exercise the pure
`save_now_impl(payload)` function directly -- no aiohttp `Request` object
anywhere in this file.

Run directly: `python tests/test_anima_api.py` (no pytest, per project convention).
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima import _preview_helpers as ph


def test_anima_api_imports_without_comfyui():
    from src.anima import api  # noqa: F401 - import itself is the assertion


def test_save_now_impl_ok_shape():
    from src.anima import api

    # `api.py` does `from ...nodes.anima._preview_helpers import save_now`,
    # so the name it actually calls lives in ITS OWN module namespace
    # (`api.save_now`) -- patching `ph.save_now` instead would silently miss
    # every call (the classic `from x import y` monkeypatch trap).
    original = api.save_now
    try:
        api.save_now = lambda **kwargs: {"filename": "final_1.png", "subfolder": "AnimaFlow", "type": "output", "stage": "final"}
        result = api.save_now_impl({
            "stages": {"final": {"filename": "final_temp.png", "subfolder": "", "type": "temp"}},
            "preview_state": json.dumps({"save": {"extension": "png"}}),
        })
        assert result == {
            "ok": True, "filename": "final_1.png", "subfolder": "AnimaFlow", "type": "output", "stage": "final",
        }
    finally:
        api.save_now = original


def test_save_now_impl_reports_a_readable_error_not_a_traceback():
    from src.anima import api

    original = api.save_now

    def raise_save_now_error(**kwargs):
        raise ph.SaveNowError("Nothing to save yet -- run the Generator first, then click Save now again.")

    try:
        api.save_now = raise_save_now_error
        result = api.save_now_impl({"stages": {}, "preview_state": "{}"})
        assert result["ok"] is False
        assert "nothing to save" in result["error"].lower()
    finally:
        api.save_now = original


def test_save_now_impl_normalizes_a_missing_preview_state():
    from src.anima import api

    original = api.save_now
    seen = {}

    def fake_save_now(*, stage_entries, preview_settings, seed=0):
        seen["preview_settings"] = preview_settings
        return {"filename": "x.png", "subfolder": "AnimaFlow", "type": "output", "stage": "base"}

    try:
        api.save_now = fake_save_now
        api.save_now_impl({"stages": {"base": {"filename": "a.png", "type": "temp"}}})
        # No `preview_state` key at all -> normalized from "{}" -- the
        # DEFAULT save.enabled is False (task item 6), never rewritten to
        # True just because this route ran.
        assert seen["preview_settings"]["save"]["enabled"] is False
    finally:
        api.save_now = original


ALL_TESTS = [
    test_anima_api_imports_without_comfyui,
    test_save_now_impl_ok_shape,
    test_save_now_impl_reports_a_readable_error_not_a_traceback,
    test_save_now_impl_normalizes_a_missing_preview_state,
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
