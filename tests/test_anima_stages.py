"""Plain-script tests for `src/anima/stages.py` (output-stage gating,
design doc §5/§6/§11 — 2026-07-28 reversal: `resolve_stage_labels` replaces
`resolve_outputs`, since the Generator's `images` output is now a LIST that
OMITS a stage rather than duplicating the previous one) and
`src/anima/sampler.py` (`inherit_sampler_settings` resolution, §6b).

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
# resolve_stage_labels -- the 2026-07-28 replacement for resolve_outputs:
# "base" is always present; "mid"/"final" are each present only when
# something ACTUALLY changed the image, never duplicated as a pass-through.
# ---------------------------------------------------------------------------


def test_everything_off_only_base_is_present():
    labels = st.resolve_stage_labels(
        highres_enabled=False, detailer_live=False, upscale_live=False, postprocess_applied=False,
    )
    assert labels == ["base"]


def test_everything_on_all_three_present_in_order():
    labels = st.resolve_stage_labels(
        highres_enabled=True, detailer_live=True, upscale_live=True, postprocess_applied=True,
    )
    assert labels == ["base", "mid", "final"]


def test_highres_only_mid_present_final_absent():
    labels = st.resolve_stage_labels(
        highres_enabled=True, detailer_live=False, upscale_live=False, postprocess_applied=False,
    )
    assert labels == ["base", "mid"]


def test_detailer_only_no_highres_mid_present():
    labels = st.resolve_stage_labels(
        highres_enabled=False, detailer_live=True, upscale_live=False, postprocess_applied=False,
    )
    assert labels == ["base", "mid"]


def test_upscale_only_no_highres_no_detailer_mid_omitted():
    # mid would equal base (nothing changed it) -- final still appears
    # directly after base, mid is OMITTED rather than duplicated.
    labels = st.resolve_stage_labels(
        highres_enabled=False, detailer_live=False, upscale_live=True, postprocess_applied=False,
    )
    assert labels == ["base", "final"]


def test_postprocess_alone_still_counts_as_final_present():
    # Postprocess "has no label of its own" (it only resizes whichever
    # tensor `final` already names) but it DOES change the pixels, so it
    # alone is enough to make `final` present even with nothing else on.
    labels = st.resolve_stage_labels(
        highres_enabled=False, detailer_live=False, upscale_live=False, postprocess_applied=True,
    )
    assert labels == ["base", "final"]


def test_mid_present_but_nothing_further_changes_final_omitted():
    labels = st.resolve_stage_labels(
        highres_enabled=True, detailer_live=False, upscale_live=False, postprocess_applied=False,
    )
    assert labels == ["base", "mid"]
    assert "final" not in labels


def test_base_is_always_first_and_always_present():
    for highres in (False, True):
        for detailer in (False, True):
            for upscale in (False, True):
                for postprocess in (False, True):
                    labels = st.resolve_stage_labels(
                        highres_enabled=highres, detailer_live=detailer,
                        upscale_live=upscale, postprocess_applied=postprocess,
                    )
                    assert labels[0] == "base", (highres, detailer, upscale, postprocess)
                    assert labels == sorted(labels, key=st.STAGE_ORDER.index)


def test_one_enabled_stage_yields_one_entry():
    # Task brief: "one enabled stage -> one entry" -- falls out for free.
    labels = st.resolve_stage_labels(
        highres_enabled=False, detailer_live=False, upscale_live=False, postprocess_applied=False,
    )
    assert len(labels) == 1


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
    test_everything_off_only_base_is_present,
    test_everything_on_all_three_present_in_order,
    test_highres_only_mid_present_final_absent,
    test_detailer_only_no_highres_mid_present,
    test_upscale_only_no_highres_no_detailer_mid_omitted,
    test_postprocess_alone_still_counts_as_final_present,
    test_mid_present_but_nothing_further_changes_final_omitted,
    test_base_is_always_first_and_always_present,
    test_one_enabled_stage_yields_one_entry,
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
