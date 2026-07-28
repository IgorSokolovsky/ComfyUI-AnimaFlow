"""Plain-script tests for `src/anima/model_files.py` (the Detailer/Upscale
model-FILE pre-flight check — readable error instead of a `FileNotFoundError`
seven frames deep mid-sample, this task's whole point).

Run directly: `python tests/test_anima_model_files.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import model_files as mf

DETAILER_SETTINGS = {"sam3": {"checkpoint": "sam3.1_multiplex_fp16.safetensors"}}
UPSCALE_SETTINGS = {"usdu": {"upscale_model_name": "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors"}}

# ---------------------------------------------------------------------------
# find_missing_model_files -- Detailer
# ---------------------------------------------------------------------------


def test_missing_checkpoint_reported_when_detailer_live():
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=True,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=False,
        checkpoint_files=["some-other.safetensors"], upscale_model_files=None,
    )
    assert len(missing) == 1
    entry = missing[0]
    assert entry["filename"] == "sam3.1_multiplex_fp16.safetensors"
    assert entry["folder"] == "checkpoints"
    assert entry["section"] == "Detailer"


def test_same_missing_checkpoint_not_reported_when_detailer_disabled():
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=False,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=False,
        checkpoint_files=["some-other.safetensors"], upscale_model_files=None,
    )
    assert missing == []


def test_present_checkpoint_reports_nothing():
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=True,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=False,
        checkpoint_files=["sam3.1_multiplex_fp16.safetensors", "other.safetensors"],
        upscale_model_files=None,
    )
    assert missing == []


# ---------------------------------------------------------------------------
# find_missing_model_files -- Upscale
# ---------------------------------------------------------------------------


def test_missing_upscale_model_reported_when_upscale_live():
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=False,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=True,
        checkpoint_files=None, upscale_model_files=["some-other-model.pth"],
    )
    assert len(missing) == 1
    entry = missing[0]
    assert entry["filename"] == "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors"
    assert entry["folder"] == "upscale_models"
    assert entry["section"] == "Upscale"


def test_same_missing_upscale_model_not_reported_when_upscale_disabled():
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=False,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=False,
        checkpoint_files=None, upscale_model_files=["some-other-model.pth"],
    )
    assert missing == []


def test_present_upscale_model_reports_nothing():
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=False,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=True,
        checkpoint_files=None,
        upscale_model_files=["2x-AnimeSharpV4_Fast_RCAN_PU.safetensors"],
    )
    assert missing == []


# ---------------------------------------------------------------------------
# Skip-don't-guess: an unobtainable/empty list
# ---------------------------------------------------------------------------


def test_unobtainable_checkpoint_list_skips_the_check_even_when_live():
    # `None` means "couldn't enumerate at all" -- never block a run over it.
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=True,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=True,
        checkpoint_files=None, upscale_model_files=None,
    )
    assert missing == []


def test_empty_but_obtained_checkpoint_list_still_fails():
    # `[]` is a REAL answer ("nothing installed there"), unlike `None`.
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=True,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=False,
        checkpoint_files=[], upscale_model_files=None,
    )
    assert len(missing) == 1
    assert missing[0]["filename"] == "sam3.1_multiplex_fp16.safetensors"


def test_both_stages_live_and_both_missing_reports_both_in_stage_order():
    missing = mf.find_missing_model_files(
        detailer_settings=DETAILER_SETTINGS, detailer_live=True,
        upscale_settings=UPSCALE_SETTINGS, upscale_live=True,
        checkpoint_files=["nope.safetensors"], upscale_model_files=["nope.pth"],
    )
    assert [m["section"] for m in missing] == ["Detailer", "Upscale"]


def test_garbage_settings_never_raises_and_falls_back_to_upstream_default():
    missing = mf.find_missing_model_files(
        detailer_settings={"sam3": "not-a-dict"}, detailer_live=True,
        upscale_settings={"usdu": None}, upscale_live=True,
        checkpoint_files=[], upscale_model_files=[],
    )
    filenames = {m["filename"] for m in missing}
    assert mf.DEFAULT_SAM3_CHECKPOINT in filenames
    assert mf.DEFAULT_UPSCALE_MODEL in filenames


# ---------------------------------------------------------------------------
# raise_if_missing -- message content (mirrors ContextFieldMissing's own
# "assert the message actually names the thing" tests)
# ---------------------------------------------------------------------------


def test_raise_if_missing_is_a_noop_for_empty_list():
    mf.raise_if_missing([])  # must not raise


def test_raise_if_missing_names_filename_folder_and_section():
    missing = [{"filename": "sam3.1_multiplex_fp16.safetensors", "folder": "checkpoints", "section": "Detailer"}]
    try:
        mf.raise_if_missing(missing)
        assert False, "expected ModelFileMissing"
    except mf.ModelFileMissing as exc:
        message = str(exc)
        assert "sam3.1_multiplex_fp16.safetensors" in message
        assert "checkpoints" in message
        assert "Detailer" in message


def test_raise_if_missing_names_upscale_entry_too():
    missing = [{"filename": "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors", "folder": "upscale_models", "section": "Upscale"}]
    try:
        mf.raise_if_missing(missing)
        assert False, "expected ModelFileMissing"
    except mf.ModelFileMissing as exc:
        message = str(exc)
        assert "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors" in message
        assert "upscale_models" in message
        assert "Upscale" in message


def test_raise_if_missing_is_a_valueerror_subclass():
    # Matches ContextFieldMissing/ResourceError's own convention.
    assert issubclass(mf.ModelFileMissing, ValueError)


ALL_TESTS = [
    test_missing_checkpoint_reported_when_detailer_live,
    test_same_missing_checkpoint_not_reported_when_detailer_disabled,
    test_present_checkpoint_reports_nothing,
    test_missing_upscale_model_reported_when_upscale_live,
    test_same_missing_upscale_model_not_reported_when_upscale_disabled,
    test_present_upscale_model_reports_nothing,
    test_unobtainable_checkpoint_list_skips_the_check_even_when_live,
    test_empty_but_obtained_checkpoint_list_still_fails,
    test_both_stages_live_and_both_missing_reports_both_in_stage_order,
    test_garbage_settings_never_raises_and_falls_back_to_upstream_default,
    test_raise_if_missing_is_a_noop_for_empty_list,
    test_raise_if_missing_names_filename_folder_and_section,
    test_raise_if_missing_names_upscale_entry_too,
    test_raise_if_missing_is_a_valueerror_subclass,
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
