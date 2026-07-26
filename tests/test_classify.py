"""Plain-script tests for `autocomplete/classify.py` (`/wtn/classify`'s pure
classification core) + the `autocomplete/api.py` route wiring around it.

Run directly: `python tests/test_classify.py` (no pytest, per project
convention).

The single most important property tested here is OFFSET CORRECTNESS:
`text[start:end] == token["text"]` for every token `classify_text` returns,
across inputs designed to break naive tokenizers that normalize before
splitting (`\\r\\n`, the full-width comma `，`, multi-byte characters). See
`classify.py`'s module docstring for why that's non-trivial upstream and how
this port avoids the problem entirely (it never rewrites the input string).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from autocomplete.classify import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MIN_LIMIT,
    SECTION_LABELS,
    classify_text,
)
from autocomplete.dataset import AutocompleteEntry, normalize_tag_key


def _entry(tag, category="general", count=0, source="gelbooru"):
    return AutocompleteEntry(
        tag=tag, tag_key=normalize_tag_key(tag), category=category, count=count, source=source
    )


_FIXTURE = {
    e.tag_key: e
    for e in [
        _entry("1girl", category="general", count=9_000_000),
        _entry("hatsune miku", category="character", count=100_000),
        _entry("artistname", category="artist", count=500),
        _entry("touhou", category="copyright", count=200),
        _entry("highres", category="meta", count=1_000),
        _entry("some artist", category="artist", count=42),
        _entry("long hair", category="general", count=3_000_000),
    ]
}


def _lookup(tag):
    return _FIXTURE.get(normalize_tag_key(tag))


def _assert_offsets_exact(text, tokens):
    for token in tokens:
        actual = text[token["start"] : token["end"]]
        assert actual == token["text"], (
            f"offset mismatch: text[{token['start']}:{token['end']}] == {actual!r}, "
            f"expected {token['text']!r}"
        )


def _sections(tokens):
    return [t["section"] for t in tokens]


# ---------------------------------------------------------------------------
# Offset correctness -- the key invariant.
# ---------------------------------------------------------------------------


def test_offsets_hold_for_a_realistic_mixed_prompt():
    text = (
        "masterpiece, newest, 1girl, hatsune miku, @artistname, @unknownartist, "
        "touhou, highres, (blue eyes:1.2), (red hair, cat ears), solo, 2girls, "
        "year 2020, __wildcard__, {a|b|c}, %{hello}, "
        "this is a natural language sentence about something interesting!, "
        "((unbalanced"
    )
    result = classify_text(text, limit=100, entry_lookup=_lookup)
    assert result["tokens"], "expected at least one token"
    _assert_offsets_exact(text, result["tokens"])


def test_offsets_hold_with_crlf_line_endings():
    text = "foo\r\nbar\r\nbaz"
    result = classify_text(text, limit=100, entry_lookup=_lookup)
    _assert_offsets_exact(text, result["tokens"])
    assert [t["text"] for t in result["tokens"]] == ["foo", "bar", "baz"]


def test_offsets_hold_with_full_width_comma():
    text = "foo，bar，baz"
    result = classify_text(text, limit=100, entry_lookup=_lookup)
    _assert_offsets_exact(text, result["tokens"])
    assert [t["text"] for t in result["tokens"]] == ["foo", "bar", "baz"]


def test_offsets_hold_with_multibyte_characters():
    # Emoji (outside the BMP) and CJK, both of which are exactly ONE Python
    # string index each (Python str indexes by codepoint, not UTF-16 unit).
    text = "😀tag_one, 猫娘, masterpiece, 日本語のタグ"
    result = classify_text(text, limit=100, entry_lookup=_lookup)
    _assert_offsets_exact(text, result["tokens"])
    texts = [t["text"] for t in result["tokens"]]
    assert "😀tag_one" in texts
    assert "猫娘" in texts
    assert "日本語のタグ" in texts


def test_offsets_hold_when_comment_follows_real_tokens_on_own_line():
    text = "a, b\n# a comment line\nc, d"
    result = classify_text(text, limit=100, entry_lookup=_lookup)
    _assert_offsets_exact(text, result["tokens"])
    comment_tokens = [t for t in result["tokens"] if t["section"] == "comment"]
    assert len(comment_tokens) == 1
    assert comment_tokens[0]["text"] == "# a comment line"


# ---------------------------------------------------------------------------
# Every one of the 16 sections is reachable and labeled in English.
# ---------------------------------------------------------------------------


def test_all_sixteen_sections_are_defined_with_english_labels():
    assert set(SECTION_LABELS) == {
        "quality",
        "safety",
        "year",
        "count",
        "character",
        "artist",
        "artist_unknown",
        "copyright",
        "meta",
        "general",
        "natural",
        "translation",
        "wildcard",
        "comment",
        "syntax",
        "unknown",
    }
    for label in SECTION_LABELS.values():
        assert label and all(ord(ch) < 128 for ch in label), f"non-ASCII/English label: {label!r}"


def test_quality_section():
    result = classify_text("masterpiece, best quality", entry_lookup=_lookup)
    assert _sections(result["tokens"]) == ["quality", "quality"]


def test_safety_section():
    result = classify_text("nsfw, rating explicit", entry_lookup=_lookup)
    assert _sections(result["tokens"]) == ["safety", "safety"]


def test_year_section_vocab_and_pattern():
    result = classify_text("newest, year 2020", entry_lookup=_lookup)
    assert _sections(result["tokens"]) == ["year", "year"]


def test_count_section_vocab_and_regex():
    result = classify_text("solo, 1boy, 2 girls", entry_lookup=_lookup)
    assert _sections(result["tokens"]) == ["count", "count", "count"]


def test_character_section_via_db():
    result = classify_text("hatsune miku", entry_lookup=_lookup)
    assert result["tokens"][0]["section"] == "character"
    assert result["tokens"][0]["known"] is True
    assert result["tokens"][0]["count"] == 100_000


def test_artist_known_section():
    result = classify_text("@artistname", entry_lookup=_lookup)
    token = result["tokens"][0]
    assert token["section"] == "artist"
    assert token["base"] == "artistname"
    assert token["known"] is True


def test_artist_unknown_section():
    result = classify_text("@totally_not_a_registered_artist", entry_lookup=_lookup)
    token = result["tokens"][0]
    assert token["section"] == "artist_unknown"
    assert token["known"] is False


def test_copyright_section_via_db():
    result = classify_text("touhou", entry_lookup=_lookup)
    assert result["tokens"][0]["section"] == "copyright"


def test_meta_section_vocab_and_db():
    result = classify_text("highres, absurdres", entry_lookup=_lookup)
    # "highres" is in the DB fixture (category meta) AND in META_TAGS; either
    # path yields the same section.
    assert _sections(result["tokens"]) == ["meta", "meta"]


def test_general_section_via_db():
    # "1girl" itself is deliberately NOT used here: it's also in the ANIMA
    # builtin `ANIMA_PERSON_COUNT_TAGS` vocab, so per the precedence order
    # (builtin section wins before the generic "DB category" step) it
    # classifies as `count`, not `general` -- covered by
    # `test_count_section_vocab_and_regex` instead.
    result = classify_text("long hair", entry_lookup=_lookup)
    token = result["tokens"][0]
    assert token["section"] == "general"
    assert token["count"] == 3_000_000


def test_natural_language_section():
    long_tag = "a" * 32
    sentence = "a man walking through the rain at night."
    result = classify_text(f"{long_tag}, {sentence}", entry_lookup=_lookup)
    assert _sections(result["tokens"]) == ["natural", "natural"]


def test_translation_marker_section():
    result = classify_text("%{hello world}", entry_lookup=_lookup)
    token = result["tokens"][0]
    assert token["section"] == "translation"
    assert token["text"] == "%{hello world}"


def test_wildcard_section_for_wildcard_and_dynamic_prompt_syntax():
    result = classify_text("__my_wildcard__, {a|b|c}", entry_lookup=_lookup)
    assert _sections(result["tokens"]) == ["wildcard", "wildcard"]


def test_comment_section():
    result = classify_text("# just a comment", entry_lookup=_lookup)
    token = result["tokens"][0]
    assert token["section"] == "comment"
    assert token["text"] == "# just a comment"


def test_syntax_section_for_unbalanced_parentheses():
    result = classify_text("good tag, (unbalanced (parens", entry_lookup=_lookup)
    sections = _sections(result["tokens"])
    assert "syntax" in sections
    syntax_token = next(t for t in result["tokens"] if t["section"] == "syntax")
    assert "(unbalanced" in syntax_token["text"]


def test_unknown_section_fallback():
    result = classify_text("totally_unrecognized_short_tag", entry_lookup=_lookup)
    assert result["tokens"][0]["section"] == "unknown"


# ---------------------------------------------------------------------------
# Weighted-token handling.
# ---------------------------------------------------------------------------


def test_weighted_single_tag():
    result = classify_text("(masterpiece:1.3)", entry_lookup=_lookup)
    token = result["tokens"][0]
    assert token["weighted"] is True
    assert token["base"] == "masterpiece"
    assert token["section"] == "quality"


def test_weighted_group_splits_into_multiple_weighted_tokens():
    result = classify_text("(blue eyes, red hair:1.2)", entry_lookup=_lookup)
    tokens = result["tokens"]
    assert [t["base"] for t in tokens] == ["blue eyes", "red hair"]
    assert all(t["weighted"] for t in tokens)


def test_plain_parenthesized_group_unwraps_unweighted():
    result = classify_text("(masterpiece, best quality)", entry_lookup=_lookup)
    tokens = result["tokens"]
    assert [t["base"] for t in tokens] == ["masterpiece", "best quality"]
    assert all(not t["weighted"] for t in tokens)


def test_negative_weight_is_still_weighted():
    result = classify_text("(bad hands:-0.5)", entry_lookup=_lookup)
    token = result["tokens"][0]
    assert token["weighted"] is True
    assert token["base"] == "bad hands"


# ---------------------------------------------------------------------------
# `limit` clamping.
# ---------------------------------------------------------------------------


def test_limit_clamped_to_minimum():
    result = classify_text("a, b, c, d, e", limit=0, entry_lookup=_lookup)
    assert len(result["tokens"]) == MIN_LIMIT == 1


def test_limit_clamped_to_maximum():
    text = ", ".join(f"tag{i}" for i in range(1200))
    result = classify_text(text, limit=999_999, entry_lookup=_lookup)
    assert len(result["tokens"]) == MAX_LIMIT == 1000


def test_limit_default_is_five_hundred():
    assert DEFAULT_LIMIT == 500
    text = ", ".join(f"tag{i}" for i in range(600))
    result = classify_text(text, entry_lookup=_lookup)
    assert len(result["tokens"]) == 500


def test_limit_non_numeric_falls_back_to_default():
    text = ", ".join(f"tag{i}" for i in range(600))
    result = classify_text(text, limit="not-a-number", entry_lookup=_lookup)
    assert len(result["tokens"]) == DEFAULT_LIMIT


def test_limit_truncation_never_leaves_a_dangling_span():
    # Truncation always slices the already-fully-classified token LIST
    # (`tokens[:limit]`), never a token's own characters, so every token in
    # a truncated response -- including the very last one -- must still
    # satisfy the offset invariant, and its `end` must land exactly on a
    # tag boundary (never mid-tag).
    tags = [f"tag{i}" for i in range(50)]
    text = ", ".join(tags)
    for limit in (1, 7, 25, 49, 50):
        result = classify_text(text, limit=limit, entry_lookup=_lookup)
        tokens = result["tokens"]
        assert len(tokens) == limit
        _assert_offsets_exact(text, tokens)
        last = tokens[-1]
        assert last["text"] == tags[limit - 1]
        # The boundary right after the last returned token is either the
        # end of the string or lands exactly on the next delimiter -- never
        # inside a tag's characters.
        assert last["end"] == len(text) or text[last["end"] : last["end"] + 2] == ", "


def test_limit_truncation_inside_comment_loop_never_leaves_a_dangling_span():
    # Exercises the OTHER truncation path in `classify_text` -- the early
    # `return` inside the comment-scanning loop (as opposed to the final
    # `tokens[:limit]` slice after the loop) -- with the same guarantee.
    text = "\n".join([f"# comment {i}" for i in range(20)] + ["a, b, c"])
    for limit in (1, 3, 10, 19):
        result = classify_text(text, limit=limit, entry_lookup=_lookup)
        tokens = result["tokens"]
        assert len(tokens) == limit
        _assert_offsets_exact(text, tokens)
        assert tokens[-1]["section"] == "comment"


# ---------------------------------------------------------------------------
# Empty / whitespace-only input.
# ---------------------------------------------------------------------------


def test_empty_input_returns_no_tokens():
    assert classify_text("", entry_lookup=_lookup) == {"tokens": []}


def test_whitespace_only_input_returns_no_tokens():
    assert classify_text("   \t  ", entry_lookup=_lookup) == {"tokens": []}
    assert classify_text("\r\n\r\n,,,", entry_lookup=_lookup) == {"tokens": []}


def test_none_input_does_not_crash():
    assert classify_text(None, entry_lookup=_lookup) == {"tokens": []}


# ---------------------------------------------------------------------------
# `api.py`'s thin wrapper (`classify_impl`) + route wiring.
# ---------------------------------------------------------------------------


def test_classify_impl_matches_classify_text_shape():
    from autocomplete.api import classify_impl

    payload = classify_impl("masterpiece, 1girl", limit=10)
    assert "tokens" in payload
    assert isinstance(payload["tokens"], list)
    assert payload["tokens"][0]["section"] == "quality"


def test_classify_impl_uses_real_bundled_db_by_default():
    # Sanity check against the actual bundled CSVs (no fixture injection) --
    # a couple of extremely common tags must resolve as "known".
    from autocomplete.api import classify_impl

    payload = classify_impl("1girl, solo")
    tokens = {t["text"]: t for t in payload["tokens"]}
    assert tokens["1girl"]["known"] is True
    assert tokens["1girl"]["count"] > 0


def _install_fake_aiohttp_and_server():
    import importlib
    import types

    previous = {name: sys.modules.get(name) for name in ("aiohttp", "server", "autocomplete.api")}

    class _FakeJsonResponse:
        def __init__(self, payload):
            self.payload = payload

    class _FakeRoutes:
        def __init__(self):
            self.handlers = {}

        def get(self, path):
            def decorator(func):
                self.handlers[("GET", path)] = func
                return func

            return decorator

        def post(self, path):
            def decorator(func):
                self.handlers[("POST", path)] = func
                return func

            return decorator

    fake_aiohttp = types.ModuleType("aiohttp")
    fake_aiohttp.web = types.SimpleNamespace(json_response=_FakeJsonResponse)
    sys.modules["aiohttp"] = fake_aiohttp

    fake_routes = _FakeRoutes()
    fake_server = types.ModuleType("server")
    fake_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=fake_routes))
    sys.modules["server"] = fake_server

    sys.modules.pop("autocomplete.api", None)
    module = importlib.import_module("autocomplete.api")
    return module, fake_routes, _FakeJsonResponse, previous


def _restore_sys_modules(previous):
    for name, value in previous.items():
        if value is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = value


def test_classify_route_is_registered_next_to_autocomplete():
    import asyncio

    module, fake_routes, fake_json_response, previous = _install_fake_aiohttp_and_server()
    try:
        assert ("GET", "/wtn/autocomplete") in fake_routes.handlers
        handler = fake_routes.handlers.get(("POST", "/wtn/classify"))
        assert handler is not None, "POST /wtn/classify was not registered"

        class _FakeRequest:
            def __init__(self, body):
                self._body = body

            async def json(self):
                return self._body

        request = _FakeRequest({"text": "masterpiece, 1girl", "limit": 10})
        response = asyncio.run(handler(request))
        assert isinstance(response, fake_json_response)
        assert response.payload == module.classify_impl("masterpiece, 1girl", limit=10)
        assert response.payload["tokens"][0]["section"] == "quality"
    finally:
        _restore_sys_modules(previous)


ALL_TESTS = [
    test_offsets_hold_for_a_realistic_mixed_prompt,
    test_offsets_hold_with_crlf_line_endings,
    test_offsets_hold_with_full_width_comma,
    test_offsets_hold_with_multibyte_characters,
    test_offsets_hold_when_comment_follows_real_tokens_on_own_line,
    test_all_sixteen_sections_are_defined_with_english_labels,
    test_quality_section,
    test_safety_section,
    test_year_section_vocab_and_pattern,
    test_count_section_vocab_and_regex,
    test_character_section_via_db,
    test_artist_known_section,
    test_artist_unknown_section,
    test_copyright_section_via_db,
    test_meta_section_vocab_and_db,
    test_general_section_via_db,
    test_natural_language_section,
    test_translation_marker_section,
    test_wildcard_section_for_wildcard_and_dynamic_prompt_syntax,
    test_comment_section,
    test_syntax_section_for_unbalanced_parentheses,
    test_unknown_section_fallback,
    test_weighted_single_tag,
    test_weighted_group_splits_into_multiple_weighted_tokens,
    test_plain_parenthesized_group_unwraps_unweighted,
    test_negative_weight_is_still_weighted,
    test_limit_clamped_to_minimum,
    test_limit_clamped_to_maximum,
    test_limit_default_is_five_hundred,
    test_limit_non_numeric_falls_back_to_default,
    test_limit_truncation_never_leaves_a_dangling_span,
    test_limit_truncation_inside_comment_loop_never_leaves_a_dangling_span,
    test_empty_input_returns_no_tokens,
    test_whitespace_only_input_returns_no_tokens,
    test_none_input_does_not_crash,
    test_classify_impl_matches_classify_text_shape,
    test_classify_impl_uses_real_bundled_db_by_default,
    test_classify_route_is_registered_next_to_autocomplete,
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
