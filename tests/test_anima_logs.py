"""Plain-script tests for `src/anima/logs.py` (server-side per-run console
log, task brief: "an entire debugging session was spent pasting
browser-console probes to answer questions the server could simply have
printed"). Covers: each pure message builder against a representative
settings/context pair; the dependency-missing case reading distinctly from
the plainly-disabled case; the `ANIMAFLOW_DEBUG` predicate; and fail-safety
(garbage/missing inputs produce a string, never an exception).

Run directly: `python tests/test_anima_logs.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import logs as logs_mod

# ---------------------------------------------------------------------------
# is_debug_enabled -- the ANIMAFLOW_DEBUG predicate.
# ---------------------------------------------------------------------------


def test_debug_enabled_for_common_truthy_spellings():
    for value in ("1", "true", "True", "YES", "on", " On "):
        assert logs_mod.is_debug_enabled({"ANIMAFLOW_DEBUG": value}) is True, value


def test_debug_disabled_for_falsy_or_missing():
    assert logs_mod.is_debug_enabled({"ANIMAFLOW_DEBUG": "0"}) is False
    assert logs_mod.is_debug_enabled({"ANIMAFLOW_DEBUG": "false"}) is False
    assert logs_mod.is_debug_enabled({"ANIMAFLOW_DEBUG": ""}) is False
    assert logs_mod.is_debug_enabled({}) is False


def test_debug_predicate_fails_closed_on_garbage_env():
    assert logs_mod.is_debug_enabled(None) is False
    assert logs_mod.is_debug_enabled("not-a-mapping") is False
    assert logs_mod.is_debug_enabled(12345) is False
    assert logs_mod.is_debug_enabled([("ANIMAFLOW_DEBUG", "1")]) is False


def test_debug_predicate_real_os_environ_shape_works():
    # `os.environ` itself (what pipeline.py/preview.py actually pass) is a
    # real mapping with a `.get` -- exercise that exact shape, not just a
    # plain dict, since that's the real call site.
    assert logs_mod.is_debug_enabled(os.environ) in (True, False)


# ---------------------------------------------------------------------------
# stage_status_text -- the dependency-missing vs. plainly-disabled distinction
# (task brief: "detailer_is_live already distinguishes disabled from no
# Impact pack -- surface that distinction").
# ---------------------------------------------------------------------------


def test_stage_off_when_disabled_reads_plain_off():
    text = logs_mod.stage_status_text(enabled=False, live=False)
    assert text == "off"


def test_stage_off_because_dependency_missing_names_the_pack():
    text = logs_mod.stage_status_text(
        enabled=True, live=False, dependency_missing=True, dependency_label="Impact Pack (DetailerForEach/MaskToSEGS)",
    )
    assert "Impact Pack" in text
    assert text != "off"


def test_disabled_and_dependency_missing_read_distinctly():
    disabled = logs_mod.stage_status_text(enabled=False, live=False)
    dependency_missing = logs_mod.stage_status_text(
        enabled=True, live=False, dependency_missing=True, dependency_label="Ultimate SD Upscale",
    )
    assert disabled != dependency_missing
    assert "Ultimate SD Upscale" in dependency_missing
    assert "Ultimate SD Upscale" not in disabled


def test_stage_on_when_enabled_and_live():
    assert logs_mod.stage_status_text(enabled=True, live=True) == "on"


def test_stage_off_with_a_non_dependency_reason():
    text = logs_mod.stage_status_text(enabled=True, live=False, not_live_reason="no blocks enabled")
    assert "no blocks enabled" in text
    assert "needs" not in text


def test_stage_status_text_fail_safe_on_garbage():
    text = logs_mod.stage_status_text(enabled="not-a-bool", live=object())
    assert isinstance(text, str) and text


# ---------------------------------------------------------------------------
# format_run_header
# ---------------------------------------------------------------------------


def test_format_run_header_names_every_stage_and_its_status():
    line = logs_mod.format_run_header(
        mod_guidance_status="off",
        highres_status="on",
        detailer_status="off (needs Impact Pack)",
        upscale_status="off (needs Ultimate SD Upscale)",
        postprocess_status="off",
    )
    assert "[AnimaFlow]" in line
    assert "mod_guidance=off" in line
    assert "highres=on" in line
    assert "detailer=off (needs Impact Pack)" in line
    assert "upscale=off (needs Ultimate SD Upscale)" in line
    assert "postprocess=off" in line


def test_format_run_header_fail_safe_on_garbage():
    line = logs_mod.format_run_header(mod_guidance_status=None, highres_status=object(), detailer_status=1, upscale_status=[], postprocess_status={})
    assert isinstance(line, str) and line


# ---------------------------------------------------------------------------
# format_sampler_provenance -- "the single most valuable line" (task brief):
# each of the five scalars must name whether it came from the context or the
# settings blob, for a REPRESENTATIVE mix of supplied/unsupplied fields.
# ---------------------------------------------------------------------------

_RESOLVED_SAMPLER = {"seed": 12345, "steps": 32, "cfg": 5.0, "sampler_name": "er_sde", "scheduler": "simple"}
# A realistic mix: seed/cfg wired from the Anima Context Bridge, everything
# else left to the settings blob.
_MIXED_SUPPLIED = {"seed": True, "steps": False, "cfg": True, "sampler_name": False, "scheduler": False}


def test_sampler_provenance_names_context_for_supplied_fields():
    line = logs_mod.format_sampler_provenance(_RESOLVED_SAMPLER, _MIXED_SUPPLIED)
    assert "seed=12345 (context)" in line
    assert "cfg=5.0 (context)" in line


def test_sampler_provenance_names_settings_for_unsupplied_fields():
    line = logs_mod.format_sampler_provenance(_RESOLVED_SAMPLER, _MIXED_SUPPLIED)
    assert "steps=32 (settings)" in line
    assert "sampler_name='er_sde' (settings)" in line
    assert "scheduler='simple' (settings)" in line


def test_sampler_provenance_all_from_settings_when_nothing_supplied():
    line = logs_mod.format_sampler_provenance(_RESOLVED_SAMPLER, {})
    for field in ("seed", "steps", "cfg", "sampler_name", "scheduler"):
        assert f"{field}=" in line
    assert "(context)" not in line


def test_sampler_provenance_all_from_context_when_everything_supplied():
    all_supplied = {field: True for field in ("seed", "steps", "cfg", "sampler_name", "scheduler")}
    line = logs_mod.format_sampler_provenance(_RESOLVED_SAMPLER, all_supplied)
    assert line.count("(context)") == 5
    assert "(settings)" not in line


def test_sampler_provenance_fail_safe_on_garbage_input():
    line = logs_mod.format_sampler_provenance(None, None)
    assert isinstance(line, str) and line
    line2 = logs_mod.format_sampler_provenance("not-a-dict", "also-not-a-dict")
    assert isinstance(line2, str) and line2


# ---------------------------------------------------------------------------
# format_model_files_line
# ---------------------------------------------------------------------------


def test_model_files_line_names_the_resolved_checkpoint_when_live():
    line = logs_mod.format_model_files_line(
        detailer_live=True, sam3_checkpoint="sam3.1_multiplex_fp16.safetensors",
        upscale_live=False, upscale_model=None,
    )
    assert "sam3.1_multiplex_fp16.safetensors" in line
    assert "verified installed" in line


def test_model_files_line_reports_not_needed_when_stage_off():
    line = logs_mod.format_model_files_line(
        detailer_live=False, sam3_checkpoint=None, upscale_live=False, upscale_model=None,
    )
    assert "not needed" in line


def test_model_files_line_names_both_when_both_live():
    line = logs_mod.format_model_files_line(
        detailer_live=True, sam3_checkpoint="sam3.safetensors",
        upscale_live=True, upscale_model="2x-AnimeSharpV4_Fast_RCAN_PU.safetensors",
    )
    assert "sam3.safetensors" in line
    assert "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors" in line


def test_model_files_line_fail_safe_on_garbage():
    line = logs_mod.format_model_files_line(detailer_live="nope", sam3_checkpoint=123, upscale_live=None, upscale_model=object())
    assert isinstance(line, str) and line


# ---------------------------------------------------------------------------
# format_stage_result -- one line per stage, dimensions when it produced one.
# ---------------------------------------------------------------------------


def test_stage_result_includes_dimensions_when_given():
    line = logs_mod.format_stage_result("highres", "on", 1536, 1536)
    assert "1536x1536" in line
    assert "highres" in line


def test_stage_result_omits_dimensions_when_stage_did_not_run():
    line = logs_mod.format_stage_result("highres", "off")
    assert "x" not in line.split(":")[-1].replace("off", "")  # no WxH suffix
    assert "off" in line


def test_stage_result_fail_safe_on_garbage_dimensions():
    line = logs_mod.format_stage_result("upscale", "on", "not-a-number", None)
    assert isinstance(line, str) and line


# ---------------------------------------------------------------------------
# format_postprocess_status / format_detailer_block_line -- "anything
# swallowed" (a stage that returned its input unchanged) reads distinctly.
# ---------------------------------------------------------------------------


def test_postprocess_status_distinguishes_off_no_op_and_applied():
    off = logs_mod.format_postprocess_status(enabled=False, applied=False)
    no_op = logs_mod.format_postprocess_status(enabled=True, applied=False)
    applied = logs_mod.format_postprocess_status(enabled=True, applied=True)
    assert len({off, no_op, applied}) == 3


def test_detailer_block_line_distinguishes_disabled_ran_and_unchanged():
    disabled = logs_mod.format_detailer_block_line("face", enabled=False, changed=False)
    ran = logs_mod.format_detailer_block_line("face", enabled=True, changed=True)
    unchanged = logs_mod.format_detailer_block_line("face", enabled=True, changed=False)
    assert len({disabled, ran, unchanged}) == 3
    assert "face" in disabled and "face" in ran and "face" in unchanged


# ---------------------------------------------------------------------------
# format_context_supplied_debug / format_stage_sampler_debug
# ---------------------------------------------------------------------------


def test_context_supplied_debug_lists_supplied_and_missing_separately():
    line = logs_mod.format_context_supplied_debug({"model": True, "clip": True, "latent": False})
    assert "model" in line
    assert "latent" in line


def test_context_supplied_debug_fail_safe_on_garbage():
    assert isinstance(logs_mod.format_context_supplied_debug(None), str)
    assert isinstance(logs_mod.format_context_supplied_debug("garbage"), str)


def test_stage_sampler_debug_names_all_five_fields():
    line = logs_mod.format_stage_sampler_debug("highres", {
        "steps": 20, "cfg": 8.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 0.25,
    })
    for token in ("steps=20", "cfg=8.0", "sampler_name='euler'", "scheduler='simple'", "denoise=0.25"):
        assert token in line, (token, line)


def test_stage_sampler_debug_fail_safe_on_garbage():
    line = logs_mod.format_stage_sampler_debug("upscale", None)
    assert isinstance(line, str) and line
    line2 = logs_mod.format_stage_sampler_debug(123, "not-a-dict")
    assert isinstance(line2, str) and line2


# ---------------------------------------------------------------------------
# format_preview_run_line -- AnimaPreview's own per-run line.
# ---------------------------------------------------------------------------

_SAVED_ENTRY = {"filename": "2026-07-28_7_base.png", "subfolder": "AnimaFlow", "type": "output", "stage": "base"}
_TEMP_ENTRY = {"filename": "AnimaPreview_final_temp_abcde_00001_.png", "subfolder": "", "type": "temp", "stage": "final"}


def test_preview_run_line_names_saved_path_and_temp_only():
    line = logs_mod.format_preview_run_line(
        image_count=2, stage_labels=["base", "final"], entries=[_SAVED_ENTRY, _TEMP_ENTRY],
    )
    assert "2 image(s)" in line
    assert "base" in line and "final" in line
    assert "AnimaFlow/2026-07-28_7_base.png" in line
    assert "temp only" in line


def test_preview_run_line_reports_a_stage_present_but_not_written():
    line = logs_mod.format_preview_run_line(image_count=1, stage_labels=["base"], entries=[])
    assert "not written" in line


def test_preview_run_line_multi_batch_entry_notes_extra_count():
    two_saved = [
        {"filename": "a_000.png", "subfolder": "AnimaFlow", "type": "output", "stage": "base"},
        {"filename": "a_001.png", "subfolder": "AnimaFlow", "type": "output", "stage": "base"},
    ]
    line = logs_mod.format_preview_run_line(image_count=1, stage_labels=["base"], entries=two_saved)
    assert "+1 more" in line


def test_preview_run_line_fail_safe_on_garbage():
    line = logs_mod.format_preview_run_line(image_count="not-an-int", stage_labels="not-a-list", entries="not-a-list")
    assert isinstance(line, str) and line
    line2 = logs_mod.format_preview_run_line(image_count=None, stage_labels=None, entries=None)
    assert isinstance(line2, str) and line2


ALL_TESTS = [
    test_debug_enabled_for_common_truthy_spellings,
    test_debug_disabled_for_falsy_or_missing,
    test_debug_predicate_fails_closed_on_garbage_env,
    test_debug_predicate_real_os_environ_shape_works,
    test_stage_off_when_disabled_reads_plain_off,
    test_stage_off_because_dependency_missing_names_the_pack,
    test_disabled_and_dependency_missing_read_distinctly,
    test_stage_on_when_enabled_and_live,
    test_stage_off_with_a_non_dependency_reason,
    test_stage_status_text_fail_safe_on_garbage,
    test_format_run_header_names_every_stage_and_its_status,
    test_format_run_header_fail_safe_on_garbage,
    test_sampler_provenance_names_context_for_supplied_fields,
    test_sampler_provenance_names_settings_for_unsupplied_fields,
    test_sampler_provenance_all_from_settings_when_nothing_supplied,
    test_sampler_provenance_all_from_context_when_everything_supplied,
    test_sampler_provenance_fail_safe_on_garbage_input,
    test_model_files_line_names_the_resolved_checkpoint_when_live,
    test_model_files_line_reports_not_needed_when_stage_off,
    test_model_files_line_names_both_when_both_live,
    test_model_files_line_fail_safe_on_garbage,
    test_stage_result_includes_dimensions_when_given,
    test_stage_result_omits_dimensions_when_stage_did_not_run,
    test_stage_result_fail_safe_on_garbage_dimensions,
    test_postprocess_status_distinguishes_off_no_op_and_applied,
    test_detailer_block_line_distinguishes_disabled_ran_and_unchanged,
    test_context_supplied_debug_lists_supplied_and_missing_separately,
    test_context_supplied_debug_fail_safe_on_garbage,
    test_stage_sampler_debug_names_all_five_fields,
    test_stage_sampler_debug_fail_safe_on_garbage,
    test_preview_run_line_names_saved_path_and_temp_only,
    test_preview_run_line_reports_a_stage_present_but_not_written,
    test_preview_run_line_multi_batch_entry_notes_extra_count,
    test_preview_run_line_fail_safe_on_garbage,
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
