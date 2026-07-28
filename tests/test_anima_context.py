"""Plain-script tests for `src/anima/context.py` -- the `ANIMA_CONTEXT`
shape `AnimaContextBridge` builds and `AnimaGenerator` consumes (design doc
§1's 2026-07-28 reversal). The one thing this whole module exists to get
right: a field that was never supplied must be distinguishable from a field
that was supplied as `None` on purpose.

Run directly: `python tests/test_anima_context.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.anima import context as ctx

# ---------------------------------------------------------------------------
# build_context -- supplied vs absent, and the MISSING sentinel mechanism.
# ---------------------------------------------------------------------------


def test_every_field_missing_from_raw_is_recorded_as_not_supplied():
    context = ctx.build_context({})
    for field in ctx.CONTEXT_FIELDS:
        assert context["supplied"][field] is False, field
        assert context["values"][field] is None, field


def test_a_real_value_is_recorded_as_supplied():
    context = ctx.build_context({"model": "A_REAL_MODEL_OBJECT"})
    assert context["supplied"]["model"] is True
    assert context["values"]["model"] == "A_REAL_MODEL_OBJECT"


def test_present_but_none_is_supplied_true_distinct_from_absent():
    # THE contract this module exists to preserve: a field explicitly
    # handed `None` (the wire legitimately carried it through) is NOT the
    # same as a field that was never in `raw` at all.
    context = ctx.build_context({"latent": None})
    assert context["supplied"]["latent"] is True
    assert context["values"]["latent"] is None

    absent_context = ctx.build_context({})
    assert absent_context["supplied"]["latent"] is False
    assert absent_context["values"]["latent"] is None
    # Both `values["latent"]` entries are `None` -- ONLY `supplied` tells
    # them apart, which is exactly the point.


def test_missing_sentinel_itself_is_never_mistaken_for_a_real_value():
    context = ctx.build_context({"model": ctx.MISSING})
    assert context["supplied"]["model"] is False
    assert context["values"]["model"] is None


def test_wired_zero_and_false_and_empty_string_all_count_as_supplied():
    # Falsy-but-real values (seed=0, a False sampler flag were one to
    # exist, an empty string) must not be mistaken for "not supplied".
    context = ctx.build_context({"seed": 0, "sampler_name": ""})
    assert context["supplied"]["seed"] is True
    assert context["values"]["seed"] == 0
    assert context["supplied"]["sampler_name"] is True
    assert context["values"]["sampler_name"] == ""


def test_extra_keys_in_raw_outside_context_fields_are_ignored():
    context = ctx.build_context({"not_a_real_field": "whatever"})
    assert "not_a_real_field" not in context["values"]
    assert "not_a_real_field" not in context["supplied"]


def test_build_context_covers_all_eleven_fields():
    context = ctx.build_context({})
    assert set(context["values"]) == set(ctx.CONTEXT_FIELDS)
    assert set(context["supplied"]) == set(ctx.CONTEXT_FIELDS)
    assert len(ctx.CONTEXT_FIELDS) == 11


# ---------------------------------------------------------------------------
# context_supplied / context_value -- fail-closed on garbage input.
# ---------------------------------------------------------------------------


def test_context_supplied_fails_closed_on_garbage():
    assert ctx.context_supplied(None, "model") is False
    assert ctx.context_supplied("not-a-dict", "model") is False
    assert ctx.context_supplied({}, "model") is False
    assert ctx.context_supplied({"supplied": "not-a-dict"}, "model") is False


def test_context_value_returns_default_on_garbage():
    assert ctx.context_value(None, "model", default="fallback") == "fallback"
    assert ctx.context_value({}, "model", default="fallback") == "fallback"
    assert ctx.context_value({"values": "not-a-dict"}, "model", default="fallback") == "fallback"


def test_context_value_reads_the_real_value_when_present():
    context = ctx.build_context({"cfg": 7.5})
    assert ctx.context_value(context, "cfg") == 7.5
    assert ctx.context_value(context, "steps", default=99) is None  # supplied as None by build_context, not 99


# ---------------------------------------------------------------------------
# require_context_value -- the Generator's readable-error contract.
# ---------------------------------------------------------------------------


def test_require_context_value_returns_the_value_when_supplied():
    context = ctx.build_context({"model": "M"})
    assert ctx.require_context_value(context, "model") == "M"


def test_require_context_value_raises_readable_error_when_absent():
    context = ctx.build_context({})
    try:
        ctx.require_context_value(context, "model")
        assert False, "expected ContextFieldMissing"
    except ctx.ContextFieldMissing as exc:
        message = str(exc)
        assert "model" in message
        assert "MODEL" in message
        assert "Anima Context Bridge" in message


def test_require_context_value_raises_for_every_field_by_name():
    context = ctx.build_context({})
    for field in ctx.CONTEXT_FIELDS:
        try:
            ctx.require_context_value(context, field)
            assert False, field
        except ctx.ContextFieldMissing as exc:
            assert field in str(exc), field


def test_require_context_value_does_not_raise_when_supplied_as_none():
    # A wired socket that legitimately produced None must NOT be treated as
    # missing -- require_context_value returns None, doesn't raise.
    context = ctx.build_context({"latent": None})
    assert ctx.require_context_value(context, "latent") is None


def test_require_context_value_never_raises_attributeerror_on_garbage_context():
    for garbage in [None, "not-a-dict", 42, [], {}]:
        try:
            ctx.require_context_value(garbage, "model")
            assert False, garbage
        except ctx.ContextFieldMissing:
            pass  # expected -- readable error, not AttributeError.
        except AttributeError:
            assert False, f"raised AttributeError for {garbage!r}"


# ---------------------------------------------------------------------------
# build_context_ui_payload -- the post-run truth AnimaGenerator hands the
# frontend back (the only thing that can see a Use-Everywhere-injected
# sampler scalar, since that never rides a litegraph link).
# ---------------------------------------------------------------------------


def test_build_context_ui_payload_reports_supplied_for_all_eleven_fields():
    context = ctx.build_context({"model": "M", "seed": 7})
    payload = ctx.build_context_ui_payload(context)
    assert set(payload["supplied"]) == set(ctx.CONTEXT_FIELDS)
    assert payload["supplied"]["model"] is True
    assert payload["supplied"]["seed"] is True
    assert payload["supplied"]["clip"] is False


def test_build_context_ui_payload_values_are_only_the_five_sampler_scalars():
    # Every context field wired, so if anything besides the five sampler
    # scalars could ever land in `values`, this is where it would show up.
    context = ctx.build_context(
        {
            "model": "M", "clip": "C", "vae": "V",
            "positive": "POS", "negative": "NEG", "latent": "LAT",
            "seed": 1, "steps": 20, "cfg": 7.0,
            "sampler_name": "euler", "scheduler": "simple",
        }
    )
    payload = ctx.build_context_ui_payload(context)
    assert set(payload["values"]) == {"seed", "steps", "cfg", "sampler_name", "scheduler"}
    for banned in ("model", "clip", "vae", "positive", "negative", "latent"):
        assert banned not in payload["values"], banned
    # A torch-shaped stand-in in `values` would have blown up json.dumps --
    # prove the whole payload is actually JSON-safe, not just eyeballed.
    import json

    json.dumps(payload)


def test_build_context_ui_payload_values_only_include_supplied_sampler_fields():
    context = ctx.build_context({"seed": 7})
    payload = ctx.build_context_ui_payload(context)
    assert payload["values"] == {"seed": 7}
    for field in ("steps", "cfg", "sampler_name", "scheduler"):
        assert field not in payload["values"], field


def test_build_context_ui_payload_supplied_as_none_still_reports_a_value():
    # A wire that legitimately carried None through -- supplied stays True,
    # and the frontend, not this function, decides whether a None value
    # falls back to the settings tree.
    context = ctx.build_context({"cfg": None})
    payload = ctx.build_context_ui_payload(context)
    assert payload["supplied"]["cfg"] is True
    assert payload["values"]["cfg"] is None


def test_build_context_ui_payload_fails_closed_on_garbage_context():
    for garbage in [None, "not-a-dict", 42, [], {}]:
        payload = ctx.build_context_ui_payload(garbage)
        assert all(v is False for v in payload["supplied"].values()), garbage
        assert payload["values"] == {}, garbage


ALL_TESTS = [
    test_every_field_missing_from_raw_is_recorded_as_not_supplied,
    test_a_real_value_is_recorded_as_supplied,
    test_present_but_none_is_supplied_true_distinct_from_absent,
    test_missing_sentinel_itself_is_never_mistaken_for_a_real_value,
    test_wired_zero_and_false_and_empty_string_all_count_as_supplied,
    test_extra_keys_in_raw_outside_context_fields_are_ignored,
    test_build_context_covers_all_eleven_fields,
    test_context_supplied_fails_closed_on_garbage,
    test_context_value_returns_default_on_garbage,
    test_context_value_reads_the_real_value_when_present,
    test_require_context_value_returns_the_value_when_supplied,
    test_require_context_value_raises_readable_error_when_absent,
    test_require_context_value_raises_for_every_field_by_name,
    test_require_context_value_does_not_raise_when_supplied_as_none,
    test_require_context_value_never_raises_attributeerror_on_garbage_context,
    test_build_context_ui_payload_reports_supplied_for_all_eleven_fields,
    test_build_context_ui_payload_values_are_only_the_five_sampler_scalars,
    test_build_context_ui_payload_values_only_include_supplied_sampler_fields,
    test_build_context_ui_payload_supplied_as_none_still_reports_a_value,
    test_build_context_ui_payload_fails_closed_on_garbage_context,
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
