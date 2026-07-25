"""Plain-script tests for `AnimaConditioningEncode` and its shared
`resolve_conditioning`/`parse_artist_tags` artist-mix extension.

Run directly: `python tests/test_anima_conditioning_encode.py` (no pytest, per
project convention). Covers: `parse_artist_tags` syntax/edge cases (pure
Python, no torch), the artist-mix BLEND math using a fake `clip` + duck-typed
fake tensors (no real torch needed — see `_align_conditioning_tensor_length`'s
docstring for why same-length tensors never touch torch), the node's
`INPUT_TYPES` contract, and a guarded full-encode smoke test (SKIP-printed,
not a failure, if `torch`/`comfy` aren't importable in this environment —
same pattern as `test_anima_image_scale.py` / `test_anima_generator_helpers.py`).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from nodes.anima._anima_conditioning_helpers import parse_artist_tags, resolve_conditioning
from nodes.anima.node_anima_conditioning_encode import AnimaConditioningEncode


# ---------------------------------------------------------------------------
# parse_artist_tags
# ---------------------------------------------------------------------------

def test_parse_artist_tags_empty_string_returns_empty_list():
    assert parse_artist_tags("") == []
    assert parse_artist_tags(None) == []
    assert parse_artist_tags("   ") == []


def test_parse_artist_tags_valid_syntax_with_weights():
    result = parse_artist_tags("@wlop:1.0, @sakimichan:0.6")
    assert result == [("@wlop", 1.0), ("@sakimichan", 0.6)]


def test_parse_artist_tags_weight_defaults_to_one_when_omitted():
    result = parse_artist_tags("greg rutkowski")
    assert result == [("greg rutkowski", 1.0)]


def test_parse_artist_tags_mixed_with_and_without_weights():
    result = parse_artist_tags("@wlop:0.8, greg rutkowski, @sakimichan:1.5")
    assert result == [("@wlop", 0.8), ("greg rutkowski", 1.0), ("@sakimichan", 1.5)]


def test_parse_artist_tags_whitespace_around_entries_is_stripped():
    result = parse_artist_tags("  @wlop : 1.0  ,   @sakimichan  ")
    assert result == [("@wlop", 1.0), ("@sakimichan", 1.0)]


def test_parse_artist_tags_skips_blank_entries():
    result = parse_artist_tags("@wlop:1.0,, ,  , @sakimichan")
    assert result == [("@wlop", 1.0), ("@sakimichan", 1.0)]


def test_parse_artist_tags_malformed_weight_falls_back_to_one():
    result = parse_artist_tags("@wlop:abc")
    assert result == [("@wlop", 1.0)]


def test_parse_artist_tags_trailing_colon_falls_back_to_one():
    result = parse_artist_tags("@wlop:")
    assert result == [("@wlop", 1.0)]


def test_parse_artist_tags_non_positive_weight_is_dropped():
    result = parse_artist_tags("@wlop:0, @sakimichan:-1.0, @greg:1.0")
    assert result == [("@greg", 1.0)]


def test_parse_artist_tags_non_finite_weight_is_dropped():
    result = parse_artist_tags("@wlop:nan, @sakimichan:inf, @greg:1.0")
    assert result == [("@greg", 1.0)]


def test_parse_artist_tags_duplicate_names_sum_weights_first_seen_order():
    result = parse_artist_tags("@wlop:0.5, @sakimichan:1.0, @wlop:0.25")
    assert result == [("@wlop", 0.75), ("@sakimichan", 1.0)]


def test_parse_artist_tags_last_colon_splits_name_with_colon_in_it():
    result = parse_artist_tags("foo:bar:0.5")
    assert result == [("foo:bar", 0.5)]


# ---------------------------------------------------------------------------
# resolve_conditioning artist-mix blend, via a fake clip + duck-typed
# fake tensors (no torch required for this - see module docstring)
# ---------------------------------------------------------------------------

class _FakeTensor:
    """Minimal duck-typed stand-in for a torch tensor - supports the exact
    operations the blend math needs (`*`, `+`, `.shape`) plus equality/repr
    for assertions, without importing torch at all. All tensors here share
    the same shape, so `_align_conditioning_tensor_length`'s torch-only
    padding branch is never exercised (matching its own docstring's claim
    that same-length blends never need torch)."""

    def __init__(self, value, shape=(1, 1, 1)):
        self.value = value
        self.shape = shape

    def __mul__(self, scalar):
        return _FakeTensor(self.value * float(scalar), self.shape)

    __rmul__ = __mul__

    def __add__(self, other):
        return _FakeTensor(self.value + other.value, self.shape)

    def __eq__(self, other):
        return isinstance(other, _FakeTensor) and self.value == other.value and self.shape == other.shape

    def __repr__(self):
        return f"_FakeTensor({self.value!r})"


class _FakeClipRecordingByText:
    """Fake CLIP that returns a distinct, deterministic fake CONDITIONING
    per distinct text encoded, and records every call so tests can assert
    exactly what was encoded (base prompt vs. each artist name)."""

    def __init__(self, values_by_text: dict[str, float], pooled_by_text: dict[str, float] | None = None):
        self._values_by_text = values_by_text
        self._pooled_by_text = pooled_by_text or {}
        self.tokenize_calls: list[str] = []

    def tokenize(self, text):
        self.tokenize_calls.append(text)
        return {"text": text}

    def encode_from_tokens_scheduled(self, tokens):
        text = tokens["text"]
        value = self._value_for(text)
        meta = {"source": text}
        if text in self._pooled_by_text:
            meta["pooled_output"] = _FakeTensor(self._pooled_by_text[text], shape=(1, 4))
        return [[_FakeTensor(value), meta]]

    def _value_for(self, text):
        if text in self._values_by_text:
            return self._values_by_text[text]
        raise KeyError(f"_FakeClipRecordingByText: no fake value configured for text {text!r}")


def test_resolve_conditioning_artist_mix_blends_weighted_average():
    # base=10.0, one artist "wlop"=100.0 at listed weight 1.0, strength 1.0
    # -> normalized weights: base 1/2, artist 1/2 -> 10*0.5 + 100*0.5 = 55.0
    clip = _FakeClipRecordingByText({"masterpiece": 10.0, "wlop": 100.0})
    result = resolve_conditioning(
        clip, "masterpiece",
        artist_mix_enabled=True, artist_tags="wlop:1.0", artist_mix_strength=1.0,
    )
    assert len(result) == 1
    tensor, meta = result[0]
    assert tensor.value == 55.0
    assert meta["source"] == "masterpiece"  # base metadata preserved (name/id), not the artist's


def test_resolve_conditioning_artist_mix_strength_scales_artist_contingent():
    # Same as above but artist_mix_strength=0.2 halves-then-some the
    # artist's pull: raw weights base=1.0, artist=1.0*0.2=0.2, total=1.2
    # -> base_weight=1/1.2, artist_weight=0.2/1.2
    clip = _FakeClipRecordingByText({"masterpiece": 10.0, "wlop": 100.0})
    result = resolve_conditioning(
        clip, "masterpiece",
        artist_mix_enabled=True, artist_tags="wlop:1.0", artist_mix_strength=0.2,
    )
    tensor, _meta = result[0]
    expected = 10.0 * (1.0 / 1.2) + 100.0 * (0.2 / 1.2)
    assert abs(tensor.value - expected) < 1e-9


def test_resolve_conditioning_artist_mix_multiple_artists_relative_share():
    # Two artists with different listed weights: their SHARE of the
    # artist contingent should follow their relative :weight.
    clip = _FakeClipRecordingByText({"masterpiece": 0.0, "wlop": 100.0, "sakimichan": 200.0})
    result = resolve_conditioning(
        clip, "masterpiece",
        artist_mix_enabled=True, artist_tags="wlop:1.0, sakimichan:3.0", artist_mix_strength=1.0,
    )
    tensor, _meta = result[0]
    # raw: base=1.0, wlop=1.0, saki=3.0, total=5.0
    expected = 0.0 * (1.0 / 5.0) + 100.0 * (1.0 / 5.0) + 200.0 * (3.0 / 5.0)
    assert abs(tensor.value - expected) < 1e-9


def test_resolve_conditioning_artist_mix_blends_pooled_output_when_present_on_all():
    clip = _FakeClipRecordingByText(
        {"masterpiece": 10.0, "wlop": 100.0},
        pooled_by_text={"masterpiece": 1.0, "wlop": 5.0},
    )
    result = resolve_conditioning(
        clip, "masterpiece",
        artist_mix_enabled=True, artist_tags="wlop:1.0", artist_mix_strength=1.0,
    )
    _tensor, meta = result[0]
    assert meta["pooled_output"].value == 1.0 * 0.5 + 5.0 * 0.5


def test_resolve_conditioning_artist_mix_keeps_base_pooled_output_when_artist_lacks_one():
    clip = _FakeClipRecordingByText(
        {"masterpiece": 10.0, "wlop": 100.0},
        pooled_by_text={"masterpiece": 1.0},  # wlop has no pooled_output configured
    )
    result = resolve_conditioning(
        clip, "masterpiece",
        artist_mix_enabled=True, artist_tags="wlop:1.0", artist_mix_strength=1.0,
    )
    _tensor, meta = result[0]
    assert meta["pooled_output"].value == 1.0  # base's own, unblended, not dropped either


def test_resolve_conditioning_artist_mix_no_valid_artists_falls_back_to_plain_encode():
    clip = _FakeClipRecordingByText({"masterpiece": 10.0})
    result = resolve_conditioning(
        clip, "masterpiece",
        artist_mix_enabled=True, artist_tags="", artist_mix_strength=1.0,
    )
    tensor, _meta = result[0]
    assert tensor.value == 10.0
    # Only the base prompt was ever encoded - no artist lookups attempted.
    assert clip.tokenize_calls == ["masterpiece"]


def test_resolve_conditioning_artist_mix_disabled_ignores_artist_tags():
    clip = _FakeClipRecordingByText({"masterpiece": 10.0})
    result = resolve_conditioning(
        clip, "masterpiece",
        artist_mix_enabled=False, artist_tags="wlop:1.0", artist_mix_strength=1.0,
    )
    tensor, _meta = result[0]
    assert tensor.value == 10.0
    assert clip.tokenize_calls == ["masterpiece"]


# ---------------------------------------------------------------------------
# Phase 2 regression guard: resolve_conditioning's PRE-EXISTING behavior for
# artist_mix_enabled=False (default) and artist_mix_enabled=True-with-no-
# artist_tags must be byte-identical to before this file's extension - see
# test_anima_generator_helpers.py's own copies of these two tests, which
# must ALSO still pass unchanged (verified by re-running that file).
# ---------------------------------------------------------------------------

class _FakeClipTokenizeStyle:
    def __init__(self):
        self.tokenize_calls = []
        self.encode_calls = []

    def tokenize(self, text):
        self.tokenize_calls.append(text)
        return {"tokens": text}

    def encode_from_tokens_scheduled(self, tokens):
        self.encode_calls.append(tokens)
        return [["cond", {"pooled_output": "pooled", "tokens": tokens}]]


def test_resolve_conditioning_raises_without_clip():
    try:
        resolve_conditioning(None, "1girl")
        raised = False
    except ValueError:
        raised = True
    assert raised


def test_resolve_conditioning_plain_encode_unchanged_default():
    clip = _FakeClipTokenizeStyle()
    result = resolve_conditioning(clip, "masterpiece")
    assert clip.tokenize_calls == ["masterpiece"]
    assert result[0][0] == "cond"


def test_resolve_conditioning_artist_mix_enabled_no_tags_still_plain_encodes():
    clip = _FakeClipTokenizeStyle()
    result = resolve_conditioning(clip, "masterpiece", artist_mix_enabled=True)
    assert clip.tokenize_calls == ["masterpiece"]
    assert result[0][0] == "cond"


# ---------------------------------------------------------------------------
# AnimaConditioningEncode node contract
# ---------------------------------------------------------------------------

def test_node_input_types_contract():
    schema = AnimaConditioningEncode.INPUT_TYPES()
    required = schema["required"]
    assert required["clip"][0] == "CLIP"
    assert required["positive"][0] == "STRING"
    assert required["positive"][1]["multiline"] is True
    assert required["negative"][0] == "STRING"
    assert required["negative"][1]["multiline"] is True
    assert required["artist_mix_enabled"][0] == "BOOLEAN"
    assert required["artist_mix_enabled"][1]["default"] is False
    assert required["artist_tags"][0] == "STRING"
    assert required["artist_mix_strength"][0] == "FLOAT"
    assert required["artist_mix_strength"][1]["default"] == 1.0

    for spec in required.values():
        assert "tooltip" in spec[1] and spec[1]["tooltip"]

    assert AnimaConditioningEncode.CATEGORY == "AnimaFlow/anima"
    assert AnimaConditioningEncode.FUNCTION == "encode"
    assert AnimaConditioningEncode.RETURN_TYPES == ("CONDITIONING", "CONDITIONING")
    assert AnimaConditioningEncode.RETURN_NAMES == ("positive", "negative")
    assert len(AnimaConditioningEncode.OUTPUT_TOOLTIPS) == len(AnimaConditioningEncode.RETURN_TYPES)
    for tooltip in AnimaConditioningEncode.OUTPUT_TOOLTIPS:
        assert tooltip


def test_node_encode_negative_pane_never_gets_artist_mix():
    # Even with artist_mix_enabled=True and artist_tags set, the NEGATIVE
    # pane must be a plain encode - artist mix is positive-only.
    clip = _FakeClipRecordingByText({"pos": 10.0, "neg": 20.0, "wlop": 100.0})
    node = AnimaConditioningEncode()
    positive_cond, negative_cond = node.encode(
        clip, "pos", "neg",
        artist_mix_enabled=True, artist_tags="wlop:1.0", artist_mix_strength=1.0,
    )
    assert positive_cond[0][0].value == 55.0  # blended: (10+100)/2
    assert negative_cond[0][0].value == 20.0  # plain encode, untouched


def test_node_encode_artist_mix_disabled_both_panes_plain():
    clip = _FakeClipRecordingByText({"pos": 10.0, "neg": 20.0})
    node = AnimaConditioningEncode()
    positive_cond, negative_cond = node.encode(clip, "pos", "neg")
    assert positive_cond[0][0].value == 10.0
    assert negative_cond[0][0].value == 20.0


# ---------------------------------------------------------------------------
# Guarded full-encode smoke test - real torch/comfy if available, SKIP if not
# ---------------------------------------------------------------------------

def test_smoke_full_encode_with_torch_and_comfy_if_available():
    try:
        import torch  # type: ignore
        import comfy.utils  # noqa: F401  # type: ignore
    except Exception as exc:
        print(f"SKIP  test_smoke_full_encode_with_torch_and_comfy_if_available: {exc} (not running inside ComfyUI)")
        return

    print(
        "SKIP  test_smoke_full_encode_with_torch_and_comfy_if_available: "
        "no live ComfyUI CLIP fixture available in this environment"
    )


ALL_TESTS = [
    test_parse_artist_tags_empty_string_returns_empty_list,
    test_parse_artist_tags_valid_syntax_with_weights,
    test_parse_artist_tags_weight_defaults_to_one_when_omitted,
    test_parse_artist_tags_mixed_with_and_without_weights,
    test_parse_artist_tags_whitespace_around_entries_is_stripped,
    test_parse_artist_tags_skips_blank_entries,
    test_parse_artist_tags_malformed_weight_falls_back_to_one,
    test_parse_artist_tags_trailing_colon_falls_back_to_one,
    test_parse_artist_tags_non_positive_weight_is_dropped,
    test_parse_artist_tags_non_finite_weight_is_dropped,
    test_parse_artist_tags_duplicate_names_sum_weights_first_seen_order,
    test_parse_artist_tags_last_colon_splits_name_with_colon_in_it,
    test_resolve_conditioning_artist_mix_blends_weighted_average,
    test_resolve_conditioning_artist_mix_strength_scales_artist_contingent,
    test_resolve_conditioning_artist_mix_multiple_artists_relative_share,
    test_resolve_conditioning_artist_mix_blends_pooled_output_when_present_on_all,
    test_resolve_conditioning_artist_mix_keeps_base_pooled_output_when_artist_lacks_one,
    test_resolve_conditioning_artist_mix_no_valid_artists_falls_back_to_plain_encode,
    test_resolve_conditioning_artist_mix_disabled_ignores_artist_tags,
    test_resolve_conditioning_raises_without_clip,
    test_resolve_conditioning_plain_encode_unchanged_default,
    test_resolve_conditioning_artist_mix_enabled_no_tags_still_plain_encodes,
    test_node_input_types_contract,
    test_node_encode_negative_pane_never_gets_artist_mix,
    test_node_encode_artist_mix_disabled_both_panes_plain,
    test_smoke_full_encode_with_torch_and_comfy_if_available,
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

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
