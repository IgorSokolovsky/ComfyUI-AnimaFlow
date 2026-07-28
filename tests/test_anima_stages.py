"""Plain-script tests for `src/anima/stages.py` (output-stage gating,
design doc §5/§6/§11) and `src/anima/sampler.py` (`inherit_sampler_settings`
resolution, §6b).

Run directly: `python tests/test_anima_stages.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import sampler as sm
from src.anima import stages as st

# ---------------------------------------------------------------------------
# detailer_is_live
# ---------------------------------------------------------------------------

_ONE_BLOCK_ON = {"face": {"enabled": True}, "eye": {"enabled": False}}
_ALL_BLOCKS_OFF = {"face": {"enabled": False}, "eye": {"enabled": False}}


def test_detailer_not_live_when_disabled():
    assert st.detailer_is_live(detailer_enabled=False, have_impact=True, blocks=_ONE_BLOCK_ON) is False


def test_detailer_not_live_when_impact_absent():
    assert st.detailer_is_live(detailer_enabled=True, have_impact=False, blocks=_ONE_BLOCK_ON) is False


def test_detailer_not_live_when_every_block_off():
    assert st.detailer_is_live(detailer_enabled=True, have_impact=True, blocks=_ALL_BLOCKS_OFF) is False


def test_detailer_live_when_enabled_impact_present_and_one_block_on():
    assert st.detailer_is_live(detailer_enabled=True, have_impact=True, blocks=_ONE_BLOCK_ON) is True


def test_detailer_not_live_with_garbage_blocks_shape():
    assert st.detailer_is_live(detailer_enabled=True, have_impact=True, blocks="not-a-dict") is False
    assert st.detailer_is_live(detailer_enabled=True, have_impact=True, blocks=None) is False
    assert st.detailer_is_live(detailer_enabled=True, have_impact=True, blocks={"x": "not-a-dict"}) is False


# ---------------------------------------------------------------------------
# resolve_outputs -- every combination of the four toggles resolves each of
# the three image outputs to a real stage; image_base never drifts off the
# first pass.
# ---------------------------------------------------------------------------


def test_everything_off_all_outputs_are_base():
    out = st.resolve_outputs(
        highres_enabled=False, detailer_enabled=False, have_impact=True, blocks=_ALL_BLOCKS_OFF,
        upscale_enabled=False, have_usdu=True,
    )
    assert out == {"image_base": "base", "image_mid": "base", "image": "base", "detailer_live": False}


def test_everything_on_advances_through_every_stage():
    out = st.resolve_outputs(
        highres_enabled=True, detailer_enabled=True, have_impact=True, blocks=_ONE_BLOCK_ON,
        upscale_enabled=True, have_usdu=True,
    )
    assert out["image_base"] == "base"
    assert out["image_mid"] == "mid"
    assert out["image"] == "upscale"
    assert out["detailer_live"] is True


def test_highres_only():
    out = st.resolve_outputs(
        highres_enabled=True, detailer_enabled=False, have_impact=True, blocks=_ALL_BLOCKS_OFF,
        upscale_enabled=False, have_usdu=True,
    )
    assert out["image_base"] == "base"
    assert out["image_mid"] == "highres"  # detailer off -> passes highres through
    assert out["image"] == "highres"


def test_detailer_only_no_highres():
    out = st.resolve_outputs(
        highres_enabled=False, detailer_enabled=True, have_impact=True, blocks=_ONE_BLOCK_ON,
        upscale_enabled=False, have_usdu=True,
    )
    assert out["image_base"] == "base"
    assert out["image_mid"] == "mid"
    assert out["image"] == "mid"  # upscale off -> passes detailer's result through


def test_upscale_only():
    out = st.resolve_outputs(
        highres_enabled=False, detailer_enabled=False, have_impact=True, blocks=_ALL_BLOCKS_OFF,
        upscale_enabled=True, have_usdu=True,
    )
    assert out["image_base"] == "base"
    assert out["image_mid"] == "base"
    assert out["image"] == "upscale"


def test_upscale_enabled_but_usdu_absent_is_inert():
    out = st.resolve_outputs(
        highres_enabled=True, detailer_enabled=False, have_impact=True, blocks=_ALL_BLOCKS_OFF,
        upscale_enabled=True, have_usdu=False,
    )
    assert out["image"] == "highres"  # falls back to the previous stage, not an error.


def test_detailer_enabled_but_impact_absent_is_inert_image_mid_equals_image_base():
    out = st.resolve_outputs(
        highres_enabled=False, detailer_enabled=True, have_impact=False, blocks=_ONE_BLOCK_ON,
        upscale_enabled=False, have_usdu=True,
    )
    # image_mid == image_base is a legitimate "no detailer ran" result (design doc §5).
    assert out["image_mid"] == out["image_base"] == "base"
    assert out["detailer_live"] is False


def test_detailer_enabled_every_block_off_is_inert():
    out = st.resolve_outputs(
        highres_enabled=False, detailer_enabled=True, have_impact=True, blocks=_ALL_BLOCKS_OFF,
        upscale_enabled=False, have_usdu=True,
    )
    assert out["image_mid"] == out["image_base"]
    assert out["detailer_live"] is False


def test_image_base_never_drifts_off_first_pass_regardless_of_other_stages():
    # Every combination of the four toggles -- image_base must ALWAYS be "base".
    for highres in (False, True):
        for detailer in (False, True):
            for upscale in (False, True):
                for have_impact in (False, True):
                    for have_usdu in (False, True):
                        out = st.resolve_outputs(
                            highres_enabled=highres, detailer_enabled=detailer,
                            have_impact=have_impact, blocks=_ONE_BLOCK_ON,
                            upscale_enabled=upscale, have_usdu=have_usdu,
                        )
                        assert out["image_base"] == "base", (highres, detailer, upscale, have_impact, have_usdu)


# ---------------------------------------------------------------------------
# inherit_sampler_settings (§6b) -- both directions. steps/denoise NEVER
# inherit; cfg/sampler_name/scheduler come from the base sampler ONLY when
# the flag is on.
# ---------------------------------------------------------------------------

_BASE_SAMPLER = {"cfg": 5.0, "sampler_name": "er_sde", "scheduler": "simple", "steps": 32, "denoise": 1.0}


def _stage(inherit: bool, **overrides):
    stage = {
        "inherit_sampler_settings": inherit,
        "steps": 20, "denoise": 0.25, "cfg": 8.0, "sampler_name": "euler", "scheduler": "sgm_uniform",
    }
    stage.update(overrides)
    return stage


def test_inherit_on_cfg_sampler_scheduler_come_from_base():
    resolved = sm.resolve_stage_sampler(_stage(True), _BASE_SAMPLER)
    assert resolved["cfg"] == _BASE_SAMPLER["cfg"]
    assert resolved["sampler_name"] == _BASE_SAMPLER["sampler_name"]
    assert resolved["scheduler"] == _BASE_SAMPLER["scheduler"]


def test_inherit_on_steps_and_denoise_are_still_the_stages_own():
    # The realistic regression: "inherit everything" is the WRONG intuitive
    # reading -- steps/denoise never inherit, in EITHER direction (§6b).
    resolved = sm.resolve_stage_sampler(_stage(True), _BASE_SAMPLER)
    assert resolved["steps"] == 20            # the stage's OWN value, not base's 32.
    assert resolved["denoise"] == 0.25         # the stage's OWN value, not base's 1.0.


def test_inherit_off_cfg_sampler_scheduler_are_the_stages_own():
    resolved = sm.resolve_stage_sampler(_stage(False), _BASE_SAMPLER)
    assert resolved["cfg"] == 8.0
    assert resolved["sampler_name"] == "euler"
    assert resolved["scheduler"] == "sgm_uniform"


def test_inherit_off_steps_and_denoise_are_still_the_stages_own():
    resolved = sm.resolve_stage_sampler(_stage(False), _BASE_SAMPLER)
    assert resolved["steps"] == 20
    assert resolved["denoise"] == 0.25


def test_inherit_defaults_to_true_when_missing():
    stage = _stage(True)
    del stage["inherit_sampler_settings"]
    resolved = sm.resolve_stage_sampler(stage, _BASE_SAMPLER)
    assert resolved["inherit_sampler_settings"] is True
    assert resolved["cfg"] == _BASE_SAMPLER["cfg"]


def test_resolve_stage_sampler_applies_to_all_three_sampling_stages():
    # highres / upscale / detailer-block dicts are all "a stage settings
    # dict with inherit_sampler_settings + steps + denoise + cfg/sampler_name
    # /scheduler" -- the same function covers all three (§6b "Applies to all
    # three sampling stages").
    highres = {"inherit_sampler_settings": True, "steps": 20, "denoise": 0.25, "cfg": 8.0, "sampler_name": "euler", "scheduler": "simple"}
    upscale = {"inherit_sampler_settings": False, "steps": 20, "denoise": 0.2, "cfg": 8.0, "sampler_name": "euler", "scheduler": "simple"}
    detailer_block = {"inherit_sampler_settings": True, "steps": 20, "denoise": 0.33, "cfg": 8.0, "sampler_name": "euler", "scheduler": "sgm_uniform"}

    r_highres = sm.resolve_stage_sampler(highres, _BASE_SAMPLER)
    r_upscale = sm.resolve_stage_sampler(upscale, _BASE_SAMPLER)
    r_detailer = sm.resolve_stage_sampler(detailer_block, _BASE_SAMPLER)

    assert r_highres["cfg"] == _BASE_SAMPLER["cfg"]         # inherited
    assert r_highres["steps"] == 20                          # own
    assert r_upscale["cfg"] == 8.0                            # own (flag off)
    assert r_upscale["steps"] == 20                           # own
    assert r_detailer["scheduler"] == _BASE_SAMPLER["scheduler"]  # inherited
    assert r_detailer["steps"] == 20                          # own


def test_resolve_stage_sampler_hostile_input_never_raises():
    assert sm.resolve_stage_sampler(None, None)["inherit_sampler_settings"] is True
    assert sm.resolve_stage_sampler("not-a-dict", 123) is not None


ALL_TESTS = [
    test_detailer_not_live_when_disabled,
    test_detailer_not_live_when_impact_absent,
    test_detailer_not_live_when_every_block_off,
    test_detailer_live_when_enabled_impact_present_and_one_block_on,
    test_detailer_not_live_with_garbage_blocks_shape,
    test_everything_off_all_outputs_are_base,
    test_everything_on_advances_through_every_stage,
    test_highres_only,
    test_detailer_only_no_highres,
    test_upscale_only,
    test_upscale_enabled_but_usdu_absent_is_inert,
    test_detailer_enabled_but_impact_absent_is_inert_image_mid_equals_image_base,
    test_detailer_enabled_every_block_off_is_inert,
    test_image_base_never_drifts_off_first_pass_regardless_of_other_stages,
    test_inherit_on_cfg_sampler_scheduler_come_from_base,
    test_inherit_on_steps_and_denoise_are_still_the_stages_own,
    test_inherit_off_cfg_sampler_scheduler_are_the_stages_own,
    test_inherit_off_steps_and_denoise_are_still_the_stages_own,
    test_inherit_defaults_to_true_when_missing,
    test_resolve_stage_sampler_applies_to_all_three_sampling_stages,
    test_resolve_stage_sampler_hostile_input_never_raises,
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
