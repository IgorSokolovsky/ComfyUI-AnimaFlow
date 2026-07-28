"""Plain-script tests for `src/anima/settings.py`'s `generation_settings`
normalization (design doc §8/§11): unknown keys survive, missing keys
default, an absent stage block means disabled-with-defaults, a version bump
migrates forward, and hostile input never raises.

Run directly: `python tests/test_anima_settings.py` (no pytest, per project convention).
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import settings as s

# ---------------------------------------------------------------------------
# Defaults shape
# ---------------------------------------------------------------------------


def test_default_generation_settings_has_five_stage_keys():
    defaults = s.default_generation_settings()
    for key in ("highres", "detailer", "upscale", "postprocess"):
        assert key in defaults, key


def test_every_stage_default_starts_disabled():
    defaults = s.default_generation_settings()
    assert defaults["highres"]["enabled"] is False
    assert defaults["upscale"]["enabled"] is False
    assert defaults["postprocess"]["enabled"] is False
    assert defaults["detailer"]["enabled"] is False
    assert defaults["detailer"]["blocks"]["face"]["enabled"] is False
    assert defaults["detailer"]["blocks"]["eye"]["enabled"] is False


def test_default_settings_carry_the_two_divergence_fixes():
    # §9: guide_size_for MUST be False, noise_mask_feather must not be 0.
    defaults = s.default_generation_settings()
    face = defaults["detailer"]["blocks"]["face"]
    eye = defaults["detailer"]["blocks"]["eye"]
    assert face["guide_size_for"] is False
    assert eye["guide_size_for"] is False
    assert face["noise_mask_feather"] == 10
    assert eye["noise_mask_feather"] == 20


# ---------------------------------------------------------------------------
# Normalization -- unknown keys survive, missing keys default
# ---------------------------------------------------------------------------


def test_normalize_empty_object_returns_full_defaults():
    normalized = s.normalize_generation_settings("{}")
    assert normalized["sampler"]["steps"] == 32
    assert normalized["highres"]["enabled"] is False
    assert normalized["detailer"]["blocks"]["face"]["detect_prompt"] == "face"


def test_normalize_unknown_top_level_key_passes_through():
    raw = json.dumps({"a_future_field_we_dont_know_about": {"nested": True}})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["a_future_field_we_dont_know_about"] == {"nested": True}


def test_normalize_unknown_nested_key_passes_through():
    raw = json.dumps({"sampler": {"a_new_sampler_field": 42}})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["sampler"]["a_new_sampler_field"] == 42
    # existing defaults for OTHER sampler fields are untouched.
    assert normalized["sampler"]["steps"] == 32


def test_normalize_missing_stage_key_takes_full_defaults():
    raw = json.dumps({"sampler": {"steps": 10}})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["highres"] == s.default_generation_settings()["highres"]


def test_normalize_partial_stage_fills_missing_fields_from_defaults():
    raw = json.dumps({"highres": {"enabled": True, "scale_by": 2.0}})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["highres"]["enabled"] is True
    assert normalized["highres"]["scale_by"] == 2.0
    # untouched fields still default.
    assert normalized["highres"]["denoise"] == 0.25
    assert normalized["highres"]["sampler_name"] == "euler"


def test_normalize_absent_stage_block_means_defaults_disabled():
    # Design doc §8/§11: "an absent stage block means 'defaults, disabled'".
    normalized = s.normalize_generation_settings("{}")
    for key in ("highres", "upscale", "postprocess", "detailer"):
        assert normalized[key]["enabled"] is False


# ---------------------------------------------------------------------------
# Version migration -- forward, never rejecting.
# ---------------------------------------------------------------------------


def test_normalize_missing_version_stamps_current():
    normalized = s.normalize_generation_settings("{}")
    assert normalized["version"] == s.GENERATION_SETTINGS_VERSION


def test_normalize_old_version_migrates_forward_without_rejecting():
    raw = json.dumps({"version": 0, "sampler": {"steps": 12}})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["version"] == s.GENERATION_SETTINGS_VERSION
    assert normalized["sampler"]["steps"] == 12  # the old data survives the bump.


def test_normalize_future_version_is_preserved_not_downgraded():
    raw = json.dumps({"version": 99})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["version"] == 99


def test_normalize_garbage_version_defaults_to_current():
    for bad_version in ["not-a-number", None, [1, 2], {"nested": True}]:
        normalized = s.normalize_generation_settings(json.dumps({"version": bad_version}))
        assert normalized["version"] == s.GENERATION_SETTINGS_VERSION, bad_version


def test_schema_is_always_stamped():
    normalized = s.normalize_generation_settings(json.dumps({"schema": "garbage"}))
    assert normalized["schema"] == s.GENERATION_SETTINGS_SCHEMA


# ---------------------------------------------------------------------------
# Hostile input -- nulls, arrays, wrong types, an array-shaped root -- never raises.
# ---------------------------------------------------------------------------


def test_normalize_hostile_shapes_never_raise():
    hostile_payloads = [
        "{not json",
        "",
        "null",
        "42",
        "[1, 2, 3]",              # array-shaped root
        None,
        123,
        ["a", "list"],
        json.dumps({"sampler": None}),
        json.dumps({"sampler": "not-an-object"}),
        json.dumps({"sampler": [1, 2, 3]}),
        json.dumps({"highres": "not-an-object"}),
        json.dumps({"detailer": {"blocks": "not-an-object"}}),
        json.dumps({"detailer": {"blocks": {"face": "not-an-object"}}}),
        json.dumps({"detailer": {"order": "not-a-list"}}),
        json.dumps({"detailer": {"order": [1, 2, None, {}]}}),
        json.dumps({"loras": "not-a-list"}),
        json.dumps({"loras": {"nested": "object"}}),
    ]
    for raw in hostile_payloads:
        normalized = s.normalize_generation_settings(raw)
        assert isinstance(normalized, dict), raw
        assert "sampler" in normalized and isinstance(normalized["sampler"], dict), raw
        assert isinstance(normalized["detailer"]["blocks"], dict), raw


def test_normalize_deeply_nested_garbage_does_not_raise():
    nested = {}
    cursor = nested
    for _ in range(500):
        cursor["nested"] = {}
        cursor = cursor["nested"]
    raw = json.dumps({"sampler": nested})
    normalized = s.normalize_generation_settings(raw)
    assert isinstance(normalized, dict)


# ---------------------------------------------------------------------------
# Detailer blocks fixup -- unknown ids inherit face defaults; MAX_DETAILER_PASSES cap.
# ---------------------------------------------------------------------------


def test_unknown_detailer_block_id_inherits_face_template():
    raw = json.dumps({
        "detailer": {
            "order": ["face", "eye", "hands"],
            "blocks": {"hands": {"detect_prompt": "hands", "enabled": True}},
        },
    })
    normalized = s.normalize_generation_settings(raw)
    hands = normalized["detailer"]["blocks"]["hands"]
    assert hands["detect_prompt"] == "hands"
    assert hands["enabled"] is True
    # inherited from the face template, untouched by the caller's payload:
    assert hands["guide_size_for"] is False
    assert hands["noise_mask_feather"] == 10
    assert hands["scheduler"] == "sgm_uniform"


def test_max_detailer_passes_cap_enforced():
    blocks = {"face": {}, "eye": {}, "b1": {"enabled": True}, "b2": {"enabled": True}, "b3": {"enabled": True}}
    raw = json.dumps({
        "detailer": {"order": ["face", "eye", "b1", "b2", "b3"], "blocks": blocks},
    })
    normalized = s.normalize_generation_settings(raw)
    assert len(normalized["detailer"]["blocks"]) == s.MAX_DETAILER_PASSES
    assert len(normalized["detailer"]["order"]) == s.MAX_DETAILER_PASSES
    # `order`'s priority wins -- b3 (5th in order) is the one dropped.
    assert "b3" not in normalized["detailer"]["blocks"]
    assert set(normalized["detailer"]["order"]) == set(normalized["detailer"]["blocks"])


def test_detailer_block_with_garbage_id_is_dropped_not_fatal():
    raw = json.dumps({"detailer": {"blocks": {"": {"enabled": True}, "face": {"enabled": True}}}})
    normalized = s.normalize_generation_settings(raw)
    assert "" not in normalized["detailer"]["blocks"]
    assert normalized["detailer"]["blocks"]["face"]["enabled"] is True


# ---------------------------------------------------------------------------
# Seed — a STRING in state (this task's whole reason for existing: a seed
# past `Number.MAX_SAFE_INTEGER` must survive a JS round-trip verbatim).
# ---------------------------------------------------------------------------


def test_default_seed_is_the_string_random_sentinel():
    defaults = s.default_generation_settings()
    assert defaults["sampler"]["seed"] == "-1"
    assert isinstance(defaults["sampler"]["seed"], str)


def test_normalize_migrates_an_old_bare_int_seed_to_string():
    # An old saved workflow's `generation_settings` JSON always carried a
    # bare JSON int for `seed` -- `json.loads` hands that to Python as an
    # `int`. It must keep working, migrated to the new string form.
    raw = json.dumps({"sampler": {"seed": 123456789}})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["sampler"]["seed"] == "123456789"
    assert isinstance(normalized["sampler"]["seed"], str)


def test_normalize_huge_20_digit_seed_survives_verbatim():
    huge = "16963467365598029952"  # a real seed from the user's own run
    raw = json.dumps({"sampler": {"seed": huge}})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["sampler"]["seed"] == huge  # exact digits, no rounding


def test_normalize_huge_seed_as_a_json_int_also_survives_verbatim():
    # The same value, but arriving as a JSON NUMBER (a hand-edited API
    # payload) rather than a pre-stringified one -- `json.loads` hands this
    # to Python as an arbitrary-precision `int`.
    huge = 16963467365598029952
    raw = json.dumps({"sampler": {"seed": huge}})
    normalized = s.normalize_generation_settings(raw)
    assert normalized["sampler"]["seed"] == str(huge)


def test_normalize_seed_minus_one_stays_minus_one():
    for raw_seed in [-1, "-1", -1.0]:
        raw = json.dumps({"sampler": {"seed": raw_seed}})
        normalized = s.normalize_generation_settings(raw)
        assert normalized["sampler"]["seed"] == "-1", raw_seed


def test_normalize_seed_out_of_range_clamps():
    # Below -1 clamps to 0 (only exactly -1 is the sentinel).
    raw = json.dumps({"sampler": {"seed": -5}})
    assert s.normalize_generation_settings(raw)["sampler"]["seed"] == "0"
    # Above 2**64-1 clamps to the max.
    too_big = json.dumps({"sampler": {"seed": str(s.MAX_SEED + 1000)}})
    assert s.normalize_generation_settings(too_big)["sampler"]["seed"] == str(s.MAX_SEED)
    # Exactly the max survives verbatim.
    at_max = json.dumps({"sampler": {"seed": str(s.MAX_SEED)}})
    assert s.normalize_generation_settings(at_max)["sampler"]["seed"] == str(s.MAX_SEED)


def test_normalize_seed_integral_float_coerces_cleanly():
    raw = json.dumps({"sampler": {"seed": 42.0}})
    assert s.normalize_generation_settings(raw)["sampler"]["seed"] == "42"


def test_normalize_seed_garbage_falls_back_to_zero():
    for bad in ["not-a-seed", None, [1, 2], {"nested": True}, float("nan")]:
        assert s.normalize_seed(bad) == "0", bad


def test_normalize_seed_bool_is_not_silently_accepted_as_0_or_1():
    # bool is an int subclass in Python -- must not sneak through as a seed.
    assert s.normalize_seed(True) == "0"
    assert s.normalize_seed(False) == "0"


# ---------------------------------------------------------------------------
# `resolve_seed_int` -- the boundary where the STRING form becomes the real
# `int` `pipeline.py` hands to `KSampler` (design doc: "pipeline.py converts
# to int once at the boundary").
# ---------------------------------------------------------------------------


def test_resolve_seed_int_round_trips_2_64_minus_1_exactly():
    raw = str(s.MAX_SEED)
    assert s.resolve_seed_int(raw) == s.MAX_SEED
    assert str(s.resolve_seed_int(raw)) == raw  # exact digits, both directions


def test_resolve_seed_int_round_trips_a_20_digit_seed_exactly():
    huge = "16963467365598029952"
    assert s.resolve_seed_int(huge) == int(huge)


def test_resolve_seed_int_minus_one_falls_back_to_zero():
    # -1 ("random") resolution is NOT this function's job to randomize
    # (settings.py's own docstring) -- it falls back to 0, matching the
    # pre-existing pipeline.py behaviour this function centralizes.
    assert s.resolve_seed_int("-1") == 0
    assert s.resolve_seed_int(-1) == 0


def test_resolve_seed_int_garbage_falls_back_to_zero():
    for bad in ["not-a-seed", None, [1, 2], {}]:
        assert s.resolve_seed_int(bad) == 0, bad


def test_resolve_seed_int_accepts_a_real_int_unchanged():
    assert s.resolve_seed_int(12345) == 12345


ALL_TESTS = [
    test_default_generation_settings_has_five_stage_keys,
    test_every_stage_default_starts_disabled,
    test_default_settings_carry_the_two_divergence_fixes,
    test_normalize_empty_object_returns_full_defaults,
    test_normalize_unknown_top_level_key_passes_through,
    test_normalize_unknown_nested_key_passes_through,
    test_normalize_missing_stage_key_takes_full_defaults,
    test_normalize_partial_stage_fills_missing_fields_from_defaults,
    test_normalize_absent_stage_block_means_defaults_disabled,
    test_normalize_missing_version_stamps_current,
    test_normalize_old_version_migrates_forward_without_rejecting,
    test_normalize_future_version_is_preserved_not_downgraded,
    test_normalize_garbage_version_defaults_to_current,
    test_schema_is_always_stamped,
    test_normalize_hostile_shapes_never_raise,
    test_normalize_deeply_nested_garbage_does_not_raise,
    test_unknown_detailer_block_id_inherits_face_template,
    test_max_detailer_passes_cap_enforced,
    test_detailer_block_with_garbage_id_is_dropped_not_fatal,
    test_default_seed_is_the_string_random_sentinel,
    test_normalize_migrates_an_old_bare_int_seed_to_string,
    test_normalize_huge_20_digit_seed_survives_verbatim,
    test_normalize_huge_seed_as_a_json_int_also_survives_verbatim,
    test_normalize_seed_minus_one_stays_minus_one,
    test_normalize_seed_out_of_range_clamps,
    test_normalize_seed_integral_float_coerces_cleanly,
    test_normalize_seed_garbage_falls_back_to_zero,
    test_normalize_seed_bool_is_not_silently_accepted_as_0_or_1,
    test_resolve_seed_int_round_trips_2_64_minus_1_exactly,
    test_resolve_seed_int_round_trips_a_20_digit_seed_exactly,
    test_resolve_seed_int_minus_one_falls_back_to_zero,
    test_resolve_seed_int_garbage_falls_back_to_zero,
    test_resolve_seed_int_accepts_a_real_int_unchanged,
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
