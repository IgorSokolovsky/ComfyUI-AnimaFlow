"""Plain-script tests for `src/anima/preview_settings.py` (the Preview
node's own settings blob, design doc §8, and its §7a filename-token
formatter).

Run directly: `python tests/test_anima_preview_settings.py` (no pytest, per project convention).
"""
from __future__ import annotations

import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import preview_settings as ps

# ---------------------------------------------------------------------------
# normalize_preview_settings -- same tolerant/additive contract as settings.py.
# ---------------------------------------------------------------------------


def test_defaults_shape():
    normalized = ps.normalize_preview_settings("{}")
    assert normalized["compare"]["enabled"] is True
    assert normalized["compare"]["a"] == "base"
    assert normalized["compare"]["b"] == "final"
    assert normalized["save"]["enabled"] is True  # on by default (§7a).


def test_unknown_keys_survive():
    raw = json.dumps({"a_future_field": 42})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["a_future_field"] == 42


def test_missing_keys_default():
    raw = json.dumps({"compare": {"a": "mid"}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["compare"]["a"] == "mid"
    assert normalized["compare"]["b"] == "final"  # default fills the rest.
    assert normalized["save"]["enabled"] is True


def test_garbage_compare_slot_falls_back_to_default():
    raw = json.dumps({"compare": {"a": "not-a-real-stage", "b": "also-garbage"}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["compare"]["a"] == "base"
    assert normalized["compare"]["b"] == "final"


def test_garbage_save_which_falls_back_to_shown():
    raw = json.dumps({"save": {"which": "not-a-real-option"}})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["save"]["which"] == "shown"


def test_version_migrates_forward():
    raw = json.dumps({"version": 0})
    normalized = ps.normalize_preview_settings(raw)
    assert normalized["version"] == ps.PREVIEW_SETTINGS_VERSION


def test_hostile_input_never_raises():
    for bad in ["{not json", "null", "[1,2,3]", None, 42, {"compare": None}, {"save": "not-a-dict"}]:
        normalized = ps.normalize_preview_settings(bad if not isinstance(bad, dict) else json.dumps(bad))
        assert isinstance(normalized, dict)
        assert isinstance(normalized["compare"], dict)
        assert isinstance(normalized["save"], dict)


# ---------------------------------------------------------------------------
# format_filename -- %stage%/%seed%/%date:FMT%/%counter:N%/%width%/%height%
# ---------------------------------------------------------------------------

_FIXED_NOW = datetime.datetime(2026, 7, 27, 13, 5, 9)


def test_stage_and_seed_tokens():
    result = ps.format_filename("%stage%_%seed%", stage="final", seed=12345, width=1024, height=1024, counter=0, now=_FIXED_NOW)
    assert result == "final_12345"


def test_date_token_custom_format():
    result = ps.format_filename("%date:yyyy-MM-dd%", stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW)
    assert result == "2026-07-27"


def test_date_token_with_time_components():
    result = ps.format_filename("%date:yyyy-MM-dd-HHmmss%", stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW)
    assert result == "2026-07-27-130509"


def test_counter_token_zero_padded():
    result = ps.format_filename("img_%counter:4%", stage="base", seed=0, width=1, height=1, counter=7, now=_FIXED_NOW)
    assert result == "img_0007"


def test_width_height_tokens():
    result = ps.format_filename("%width%x%height%", stage="base", seed=0, width=832, height=1216, counter=0, now=_FIXED_NOW)
    assert result == "832x1216"


def test_full_template_combining_every_token():
    result = ps.format_filename(
        "%date:yyyy-MM-dd%_%seed%_%stage%_%counter:3%_%width%x%height%",
        stage="mid", seed=99, width=512, height=768, counter=2, now=_FIXED_NOW,
    )
    assert result == "2026-07-27_99_mid_002_512x768"


def test_template_with_no_tokens_passes_through_unchanged():
    assert ps.format_filename("plain_name", stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW) == "plain_name"


def test_hostile_template_never_raises():
    assert isinstance(ps.format_filename(None, stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW), str)
    assert isinstance(ps.format_filename(123, stage="base", seed=0, width=1, height=1, counter=0, now=_FIXED_NOW), str)


ALL_TESTS = [
    test_defaults_shape,
    test_unknown_keys_survive,
    test_missing_keys_default,
    test_garbage_compare_slot_falls_back_to_default,
    test_garbage_save_which_falls_back_to_shown,
    test_version_migrates_forward,
    test_hostile_input_never_raises,
    test_stage_and_seed_tokens,
    test_date_token_custom_format,
    test_date_token_with_time_components,
    test_counter_token_zero_padded,
    test_width_height_tokens,
    test_full_template_combining_every_token,
    test_template_with_no_tokens_passes_through_unchanged,
    test_hostile_template_never_raises,
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
