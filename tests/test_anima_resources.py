"""Plain-script tests for `src/anima/resources.py` (design doc §3
`use_internal_loaders`, §5a per-field sampler wired-wins).

Run directly: `python tests/test_anima_resources.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import resources as r

# ---------------------------------------------------------------------------
# resolve_loader_socket / resolve_loader_resources
# ---------------------------------------------------------------------------


def test_flag_on_pickers_win_even_with_sockets_wired():
    assert r.resolve_loader_socket("model", True, "a wired model object") == "internal"
    assert r.resolve_loader_socket("model", True, None) == "internal"


def test_flag_off_socket_wins_when_wired():
    assert r.resolve_loader_socket("model", False, "a wired model object") == "socket"


def test_flag_off_no_socket_raises_readable_error():
    try:
        r.resolve_loader_socket("model", False, None)
        assert False, "expected ResourceError"
    except r.ResourceError as exc:
        assert str(exc) == "use_internal_loaders is off but no MODEL is connected"


def test_flag_off_missing_clip_and_vae_name_the_right_type():
    try:
        r.resolve_loader_socket("clip", False, None)
        assert False
    except r.ResourceError as exc:
        assert "CLIP" in str(exc)
    try:
        r.resolve_loader_socket("vae", False, None)
        assert False
    except r.ResourceError as exc:
        assert "VAE" in str(exc)


def test_resolve_loader_resources_all_internal():
    result = r.resolve_loader_resources(True, model=None, clip=None, vae=None)
    assert result == {"model": "internal", "clip": "internal", "vae": "internal"}


def test_resolve_loader_resources_all_sockets_wired():
    result = r.resolve_loader_resources(False, model="M", clip="C", vae="V")
    assert result == {"model": "socket", "clip": "socket", "vae": "socket"}


def test_resolve_loader_resources_mixed_combination_missing_clip_raises():
    try:
        r.resolve_loader_resources(False, model="M", clip=None, vae="V")
        assert False
    except r.ResourceError as exc:
        assert "CLIP" in str(exc)


def test_resolve_loader_resources_raises_on_first_missing_in_model_clip_vae_order():
    try:
        r.resolve_loader_resources(False, model=None, clip=None, vae=None)
        assert False
    except r.ResourceError as exc:
        assert "MODEL" in str(exc)  # model is checked first, deterministically.


# ---------------------------------------------------------------------------
# resolve_sampler_inputs -- per-field wired-wins, five sockets, no flag.
# ---------------------------------------------------------------------------

_SETTINGS_SAMPLER = {
    "seed": -1, "steps": 32, "cfg": 5.0, "sampler_name": "er_sde", "scheduler": "simple",
    "denoise": 1.0, "shift": 3.0,
}


def test_nothing_wired_uses_settings_verbatim():
    resolved = r.resolve_sampler_inputs(_SETTINGS_SAMPLER, None)
    assert resolved["seed"] == -1
    assert resolved["steps"] == 32
    assert resolved["cfg"] == 5.0
    assert resolved["sampler_name"] == "er_sde"
    assert resolved["scheduler"] == "simple"
    # other, non-wire-eligible keys pass through untouched.
    assert resolved["denoise"] == 1.0
    assert resolved["shift"] == 3.0


def test_every_field_wired_wins_over_settings():
    wired = {"seed": 42, "steps": 10, "cfg": 7.5, "sampler_name": "euler", "scheduler": "karras"}
    resolved = r.resolve_sampler_inputs(_SETTINGS_SAMPLER, wired)
    assert resolved == {
        "seed": 42, "steps": 10, "cfg": 7.5, "sampler_name": "euler", "scheduler": "karras",
        "denoise": 1.0, "shift": 3.0,
    }


def test_mixed_combination_only_wired_fields_win():
    # The realistic setup: only seed is wired (e.g. from a Control Panel row).
    wired = {"seed": 99, "steps": None, "cfg": None, "sampler_name": None, "scheduler": None}
    resolved = r.resolve_sampler_inputs(_SETTINGS_SAMPLER, wired)
    assert resolved["seed"] == 99                 # wired
    assert resolved["steps"] == 32                # from settings
    assert resolved["cfg"] == 5.0                  # from settings
    assert resolved["sampler_name"] == "er_sde"    # from settings
    assert resolved["scheduler"] == "simple"       # from settings


def test_each_field_independently_wireable():
    for field in r.SAMPLER_FIELDS:
        wired = {f: None for f in r.SAMPLER_FIELDS}
        wired[field] = "WIRED_MARKER" if field in ("sampler_name", "scheduler") else 12345
        resolved = r.resolve_sampler_inputs(_SETTINGS_SAMPLER, wired)
        assert resolved[field] == wired[field], field
        for other in r.SAMPLER_FIELDS:
            if other != field:
                assert resolved[other] == _SETTINGS_SAMPLER[other], (field, other)


def test_wired_zero_and_false_still_count_as_wired_not_none():
    # seed=0 and cfg=0.0 are real wire-able values, not "unwired".
    wired = {"seed": 0, "steps": 0, "cfg": 0.0, "sampler_name": None, "scheduler": None}
    resolved = r.resolve_sampler_inputs(_SETTINGS_SAMPLER, wired)
    assert resolved["seed"] == 0
    assert resolved["steps"] == 0
    assert resolved["cfg"] == 0.0


def test_hostile_inputs_never_raise():
    assert isinstance(r.resolve_sampler_inputs(None, None), dict)
    assert isinstance(r.resolve_sampler_inputs("not-a-dict", "also-not-a-dict"), dict)


ALL_TESTS = [
    test_flag_on_pickers_win_even_with_sockets_wired,
    test_flag_off_socket_wins_when_wired,
    test_flag_off_no_socket_raises_readable_error,
    test_flag_off_missing_clip_and_vae_name_the_right_type,
    test_resolve_loader_resources_all_internal,
    test_resolve_loader_resources_all_sockets_wired,
    test_resolve_loader_resources_mixed_combination_missing_clip_raises,
    test_resolve_loader_resources_raises_on_first_missing_in_model_clip_vae_order,
    test_nothing_wired_uses_settings_verbatim,
    test_every_field_wired_wins_over_settings,
    test_mixed_combination_only_wired_fields_win,
    test_each_field_independently_wireable,
    test_wired_zero_and_false_still_count_as_wired_not_none,
    test_hostile_inputs_never_raise,
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
