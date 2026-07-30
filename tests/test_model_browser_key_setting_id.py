"""Regression guard: `src/model_browser/keys.py`'s `SETTING_ID` and
`js/shared/settings.mjs`'s `SETTING_IDS.CIVITAI_API_KEY` must be the exact
same string, character for character. `keys.py`'s `resolve_api_key` reads
whatever string the JS side declares (via ComfyUI's own persisted
`comfy.settings.json`) -- a rename on either side silently breaks the read
path with no error anywhere; the setting would just always resolve to "no
key", indistinguishable from a user who genuinely left it blank.

Deliberately its OWN file, not inside `tests/test_model_browser.py` -- this
reads `js/shared/settings.mjs` as plain TEXT (no JS runtime/Node involved,
so this stays a `src/` + `tests/` only Python test), and living separately
means it can't collide with unrelated concurrent edits to the larger
`test_model_browser.py` suite.

Run directly: `python tests/test_model_browser_key_setting_id.py` (no
pytest, per project convention).
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.model_browser import keys  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS_MJS = os.path.join(REPO_ROOT, "js", "shared", "settings.mjs")


def _read_settings_mjs() -> str:
    with open(SETTINGS_MJS, "r", encoding="utf-8") as fh:
        return fh.read()


def test_keys_setting_id_is_the_documented_literal():
    assert keys.SETTING_ID == "AnimaFlow.Controls.CivitaiApiKey"


def test_settings_mjs_declares_the_exact_same_literal_verbatim():
    text = _read_settings_mjs()
    needle = f'"{keys.SETTING_ID}"'
    assert needle in text, (
        f"js/shared/settings.mjs no longer contains the literal {needle!r} -- "
        "a rename here silently breaks src/model_browser/keys.py's read path "
        "with no error on either side."
    )


def test_settings_mjs_registers_it_as_a_plain_text_setting():
    # Cheap smoke check (this test doesn't parse JS) against the id being
    # declared in SETTING_IDS but never actually wired into a registered
    # setting: both the `SETTING_IDS.CIVITAI_API_KEY: "..."` entry and a
    # `type: "text"` declaration must be present. `type: "text"` is unique
    # to this one setting in the file today (every other entry is
    # boolean/number/combo) -- if that ever changes, tighten this check to
    # scope the match to the CIVITAI_API_KEY block specifically.
    text = _read_settings_mjs()
    assert re.search(r'CIVITAI_API_KEY:\s*"AnimaFlow\.Controls\.CivitaiApiKey"', text)
    assert 'type: "text"' in text


ALL_TESTS = [
    test_keys_setting_id_is_the_documented_literal,
    test_settings_mjs_declares_the_exact_same_literal_verbatim,
    test_settings_mjs_registers_it_as_a_plain_text_setting,
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
        except Exception as exc:  # noqa: BLE001 - surface unexpected errors as failures too
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
