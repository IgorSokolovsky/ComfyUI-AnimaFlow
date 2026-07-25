"""Plain-script tests for the Prompt Rules encode nodes' resolution logic
(`nodes/_rules_helpers.py`) and the `/wtn/rules/*` API's pure handlers
(`api/rules_api.py`) -- all WITHOUT a live ComfyUI process.

Run directly: `python tests/test_prompt_rules.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json

from nodes import _rules_helpers as rh
from nodes.prompt_rules import PromptRulesClip, PromptRulesText

# ---------------------------------------------------------------------------
# `_rules_helpers` resolution over the real `rules/celica.yaml` sample --
# mirrors the anima-profile assertions in `test_rules.py`'s
# `test_anima_sections_and_negative`.
# ---------------------------------------------------------------------------

ANIMA_POS = (
    "[quality] masterpiece, best quality\n"
    "[character:celica]\n"
    "appearance:\n"
    "clothes:\n"
    "action:\n"
    "focus: celica, jacket\n"
    "[global] cafe, morning light"
)
ANIMA_NEG = "sketch"


def test_list_sheet_names_finds_celica():
    names = rh.list_sheet_names()
    assert "celica" in names, names


def test_load_sheet_file_celica():
    data = rh.load_sheet_file("celica")
    assert data["version"] == 1
    assert data["profile"] == "anima"
    assert isinstance(data["rules"], list) and data["rules"], data


def test_resolve_sheet_selection_star_and_list():
    all_names = rh.resolve_sheet_selection("*")
    assert "celica" in all_names, all_names
    assert rh.resolve_sheet_selection(None) == all_names
    assert rh.resolve_sheet_selection("celica, other") == ["celica", "other"]
    assert rh.resolve_sheet_selection("") == []


def test_apply_rulesets_celica_sections_and_negative():
    pos_out, neg_out, trace, errors = rh.apply_rulesets(ANIMA_POS, ANIMA_NEG, "anima", sheets="celica")
    assert errors == [], errors
    assert "short black hair" in pos_out, pos_out
    assert "pixie cut" in pos_out, pos_out
    assert "blue eyes" in pos_out, pos_out
    assert "black leather jacket" in pos_out, pos_out
    assert "celica" not in pos_out.lower(), pos_out
    assert "blurry" in neg_out, neg_out
    assert trace, "expected a non-empty trace"
    assert any(e["kind"] == "anchor" for e in trace), trace


def test_apply_rulesets_switch_default_branch():
    pos_no_outfit = ANIMA_POS.replace("focus: celica, jacket", "focus: celica")
    pos_out, _neg_out, _trace, errors = rh.apply_rulesets(pos_no_outfit, ANIMA_NEG, "anima", sheets="celica")
    assert errors == [], errors
    assert "black camisole" in pos_out, pos_out
    assert "black leather jacket" not in pos_out, pos_out


def test_run_rules_wraps_apply_rulesets(capsys):
    pos_out, neg_out, trace = rh.run_rules(ANIMA_POS, ANIMA_NEG, "anima", sheets="celica", log_trace=True)
    assert "black leather jacket" in pos_out, pos_out
    assert "blurry" in neg_out, neg_out
    assert trace
    printed = capsys.readouterr().out
    assert printed.strip(), "expected the trace to be printed when log_trace=True"


def test_run_rules_silent_when_log_trace_false(capsys):
    rh.run_rules(ANIMA_POS, ANIMA_NEG, "anima", sheets="celica", log_trace=False)
    printed = capsys.readouterr().out
    assert printed == ""


def test_sheet_digests_reflects_selection():
    digest_all = rh.sheet_digests("*")
    digest_celica = rh.sheet_digests("celica")
    assert "celica" in digest_celica, digest_celica
    assert digest_celica in digest_all or digest_all.count("celica") >= 1


def test_is_changed_digest_stable_and_sensitive():
    a = rh.is_changed_digest("1girl", "sketch", "anima", "celica", "")
    b = rh.is_changed_digest("1girl", "sketch", "anima", "celica", "")
    c = rh.is_changed_digest("1girl smiling", "sketch", "anima", "celica", "")
    assert a == b, (a, b)
    assert a != c, (a, c)


def test_load_rulesets_missing_sheet_reports_error():
    rulesets, errors = rh.load_rulesets("does-not-exist", "")
    assert rulesets == []
    assert errors and errors[0]["path"] == "does-not-exist.yaml", errors


def test_load_rulesets_appends_embedded_after_file_sheets():
    embedded = json.dumps({
        "version": 1,
        "rules": [{"name": "extra", "add_negative": "watermark"}],
    })
    rulesets, errors = rh.load_rulesets("celica", embedded)
    assert errors == [], errors
    assert [name for name, _ in rulesets] == ["celica.yaml", "embedded_rules"]


def test_load_rulesets_bad_embedded_json_reports_error():
    rulesets, errors = rh.load_rulesets("celica", "{not json")
    assert [name for name, _ in rulesets] == ["celica.yaml"]
    assert errors and errors[0]["path"] == "embedded_rules", errors


def test_apply_rulesets_embedded_applies_after_file_sheets():
    embedded = json.dumps({
        "version": 1,
        "rules": [{"name": "extra", "add_negative": "watermark"}],
    })
    _pos_out, neg_out, _trace, errors = rh.apply_rulesets(
        ANIMA_POS, ANIMA_NEG, "anima", sheets="celica", embedded_rules=embedded,
    )
    assert errors == [], errors
    assert "blurry" in neg_out, neg_out
    assert "watermark" in neg_out, neg_out


# ---------------------------------------------------------------------------
# The node classes themselves (`nodes/prompt_rules.py`) -- thin wiring only,
# but still exercised directly (a fake CLIP stub stands in for the real
# ComfyUI CLIP object the CONDITIONING variant needs).
# ---------------------------------------------------------------------------

class _FakeTokens:
    pass


class _FakeClip:
    """Mimics the two calls `_encode` makes on a real ComfyUI CLIP object."""

    def __init__(self):
        self.tokenized = []

    def tokenize(self, text):
        self.tokenized.append(text)
        return _FakeTokens()

    def encode_from_tokens(self, tokens, return_pooled=True):
        assert isinstance(tokens, _FakeTokens)
        assert return_pooled is True
        return ("COND", "POOLED")


def test_prompt_rules_text_node_process_returns_strings():
    node = PromptRulesText()
    positive, negative = node.process(
        ANIMA_POS, ANIMA_NEG, "anima", sheets="celica", embedded_rules="", log_trace=False,
    )
    assert isinstance(positive, str) and isinstance(negative, str)
    assert "black leather jacket" in positive, positive
    assert "blurry" in negative, negative


def test_prompt_rules_text_node_is_changed_matches_helper():
    expected = rh.is_changed_digest(ANIMA_POS, ANIMA_NEG, "anima", "celica", "")
    actual = PromptRulesText.IS_CHANGED(ANIMA_POS, ANIMA_NEG, "anima", "celica", "")
    assert actual == expected


def test_prompt_rules_clip_node_encodes_resolved_text():
    node = PromptRulesClip()
    clip = _FakeClip()
    positive, negative = node.process(
        clip, ANIMA_POS, ANIMA_NEG, "anima", sheets="celica", embedded_rules="", log_trace=False,
    )
    # Shape: [[cond, {"pooled_output": pooled}]] per the standard ComfyUI
    # CONDITIONING convention.
    assert positive == [["COND", {"pooled_output": "POOLED"}]], positive
    assert negative == [["COND", {"pooled_output": "POOLED"}]], negative
    assert any("black leather jacket" in t for t in clip.tokenized), clip.tokenized
    assert any("blurry" in t for t in clip.tokenized), clip.tokenized


def test_prompt_rules_input_types_contract_shapes():
    text_types = PromptRulesText.INPUT_TYPES()
    assert set(text_types["required"]) == {"positive", "negative", "profile", "sheets"}
    assert set(text_types["optional"]) == {"embedded_rules", "log_trace"}
    assert PromptRulesText.RETURN_TYPES == ("STRING", "STRING")

    clip_types = PromptRulesClip.INPUT_TYPES()
    assert set(clip_types["required"]) == {"clip", "positive", "negative", "profile", "sheets"}
    assert clip_types["required"]["clip"][0] == "CLIP"
    assert PromptRulesClip.RETURN_TYPES == ("CONDITIONING", "CONDITIONING")


# ---------------------------------------------------------------------------
# `api/rules_api.py` -- must import cleanly with no ComfyUI installed, and
# its pure handler functions must work directly.
# ---------------------------------------------------------------------------

def test_rules_api_imports_without_comfyui():
    from api import rules_api  # noqa: F401 - import itself is the assertion
    assert True


def test_rules_api_profiles_and_sheets():
    from api import rules_api

    profiles = rules_api.profiles_impl()
    assert "anima" in profiles, profiles

    sheets = rules_api.sheets_impl()
    names = [s["name"] for s in sheets]
    assert "celica" in names, names
    celica_meta = next(s for s in sheets if s["name"] == "celica")
    assert celica_meta.get("character") == "celica", celica_meta
    assert celica_meta["rules"] >= 1, celica_meta


def test_rules_api_validate_impl_ok_and_error():
    from api import rules_api

    ruleset = rh.load_sheet_file("celica")
    ok_result = rules_api.validate_impl({"ruleset": ruleset})
    assert ok_result["ok"] is True, ok_result
    assert ok_result["errors"] == []

    bad_result = rules_api.validate_impl({"ruleset": {"version": 1, "rules": [{"type": "bogus"}]}})
    assert bad_result["ok"] is False
    assert bad_result["errors"], bad_result
    err = bad_result["errors"][0]
    assert "path" in err and "message" in err, err
    assert "rules[0]" in err["path"], err
    assert ".type" in err["path"], err


def test_rules_api_preview_impl_shape_and_content():
    from api import rules_api

    payload = {
        "positive": ANIMA_POS,
        "negative": ANIMA_NEG,
        "profile": "anima",
        "sheets": ["celica"],
    }
    result = rules_api.preview_impl(payload)
    assert set(result.keys()) == {"positive", "negative", "trace", "errors"}, result
    assert "black leather jacket" in result["positive"], result
    assert "blurry" in result["negative"], result
    assert result["errors"] == []
    assert isinstance(result["trace"], list) and result["trace"]
    for entry in result["trace"]:
        assert set(entry.keys()) == {"depth", "kind", "text"}, entry


def test_rules_api_preview_impl_empty_sheets_means_none():
    from api import rules_api

    result = rules_api.preview_impl({
        "positive": ANIMA_POS,
        "negative": ANIMA_NEG,
        "profile": "anima",
        "sheets": [],
    })
    # No sheet applied -> "celica" activation word is untouched (not removed).
    assert "celica" in result["positive"].lower(), result


def test_rules_api_characters_impl_best_effort():
    from api import rules_api

    chars = rules_api.characters_impl()
    tokens = [c["token"] for c in chars]
    assert "celica" in tokens, chars
    entry = next(c for c in chars if c["token"] == "celica")
    assert entry["kind"] == "character", entry
    assert entry["from"] == "celica.yaml", entry


ALL_TESTS = [
    test_list_sheet_names_finds_celica,
    test_load_sheet_file_celica,
    test_resolve_sheet_selection_star_and_list,
    test_apply_rulesets_celica_sections_and_negative,
    test_apply_rulesets_switch_default_branch,
    test_sheet_digests_reflects_selection,
    test_is_changed_digest_stable_and_sensitive,
    test_load_rulesets_missing_sheet_reports_error,
    test_load_rulesets_appends_embedded_after_file_sheets,
    test_load_rulesets_bad_embedded_json_reports_error,
    test_apply_rulesets_embedded_applies_after_file_sheets,
    test_prompt_rules_text_node_process_returns_strings,
    test_prompt_rules_text_node_is_changed_matches_helper,
    test_prompt_rules_clip_node_encodes_resolved_text,
    test_prompt_rules_input_types_contract_shapes,
    test_rules_api_imports_without_comfyui,
    test_rules_api_profiles_and_sheets,
    test_rules_api_validate_impl_ok_and_error,
    test_rules_api_preview_impl_shape_and_content,
    test_rules_api_preview_impl_empty_sheets_means_none,
    test_rules_api_characters_impl_best_effort,
]

# `run_rules` tests need a fake `capsys` (this project has no pytest) --
# a tiny stdout-capturing stand-in so we can still assert on printed output.
class _FakeCapsys:
    def __init__(self):
        import io
        import sys
        self._sys = sys
        self._real_stdout = sys.stdout
        self._buf = io.StringIO()

    def start(self):
        self._sys.stdout = self._buf

    def readouterr(self):
        class _Out:
            pass
        out = _Out()
        out.out = self._buf.getvalue()
        self._buf.truncate(0)
        self._buf.seek(0)
        return out

    def stop(self):
        self._sys.stdout = self._real_stdout


if __name__ == "__main__":
    failures = []

    capsys = _FakeCapsys()

    def _run(test):
        if "capsys" in test.__code__.co_varnames[: test.__code__.co_argcount]:
            capsys.start()
            try:
                test(capsys)
            finally:
                capsys.stop()
        else:
            test()

    for test in ALL_TESTS + [test_run_rules_wraps_apply_rulesets, test_run_rules_silent_when_log_trace_false]:
        try:
            _run(test)
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001 - surface unexpected errors as failures too
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS) + 2
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
