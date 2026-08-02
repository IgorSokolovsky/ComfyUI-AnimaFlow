"""Plain-script tests for the detail view's COMMUNITY images gallery --
`docs/lora-loader-design.md` §"BOTH galleries, for different reasons"
(specced in `2a33db5`, built here): the bottom grid, fed by Civitai's
`GET /api/v1/images?modelVersionId=...` -- distinct from `model_detail.py`'s
own AUTHOR gallery (`/api/v1/model-versions/{id}`'s embedded `images`,
already covered by `tests/test_model_browser.py`'s own
`test_fetch_model_detail_*` suite).

Covers: `civitai_parse.parse_community_images` (the pure parser) against a
TRIMMED REAL response recorded live 2026-08-02 (`GET
https://civitai.com/api/v1/images?modelVersionId=207286&limit=100&nsfw=X`,
this task's own required probe) -- including the two things that probe
disproved from the task's own spec (see the fixture's own comment below):
`nsfwLevel` absent/`null` -> `16`, a missing `username` -> `None`, a missing
`stats` -> `reaction_count: None`, that NO `prompt` key is ever added
(0/40+ of these carry one), and non-list/malformed input; `civitai_client.
fetch_community_images` (the HTTP transport -- host-fallback, a definitive
404, an offline timeout) via an injectable fake opener, no real network; and
`api.community_images_impl` (`limit` clamping at both ends, a non-integer
`version_id` rejected readably, rate-limiting, and -- the wire-contract
regression this task's own brief warns about by name -- the LITERAL
`{"ok", "reason", "images"}` response-key set and each image's own literal
key set, pinned so this contract can't silently drift out of step with the
frontend task consuming it).

Run directly: `python tests/test_model_browser_community_images.py` (no
pytest, per project convention).
"""
from __future__ import annotations

import copy
import json
import os
import socket
import sys
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.model_browser import api as mb_api
from src.model_browser import civitai_client, civitai_parse, rate_limit

# ---------------------------------------------------------------------------
# A TRIMMED, REAL response -- recorded live 2026-08-02 against
# `https://civitai.com/api/v1/images?modelVersionId=207286&limit=100&nsfw=X`
# (this task's own required "make one real request... put a trimmed real
# sample in the test as a fixture" instruction). Four items kept, covering
# every shape actually observed across a 600-image sample spanning two model
# versions:
#
#   - item 0: the common case -- a real `username`, `browsingLevel`(int)
#     AND a WORD `nsfwLevel` (`"Mature"`) both present (measured: Civitai's
#     own `nsfwLevel` here is a WORD, `"None"/"Soft"/"Mature"/"X"/"XXX"` --
#     NOT the int the task brief described from an earlier/different probe;
#     `browsingLevel` is the sibling field actually carrying that int, on
#     EVERY one of 600 sampled images -- see `civitai_parse.
#     _community_nsfw_level`'s own docstring for the fallback chain this
#     built);
#   - item 1: `username` is a real, present `null` (measured: 2/100 on this
#     exact query) -- the task brief's own "an uncredited grid... is the
#     wrong default" case a caller must be able to detect;
#   - item 2: PG (`browsingLevel: 1`, `nsfwLevel: "None"`);
#   - item 3: `stats` entirely ABSENT (synthesised for this fixture --
#     never actually observed missing in this task's own live sample, but a
#     field this size that Civitai's API has already changed shape on once
#     is not something to assume always present) -- `reaction_count` must
#     come back `None`, not a fabricated `0`.
#
# `meta` is `null` on every item here (measured: `meta` was `null`/`{}` on
# every single one of 600 sampled community images) -- the design doc's own
# "0/40 carry a prompt" claim, re-confirmed at 15x that sample size; this is
# exactly why `parse_community_images` never reads `meta` at all.
# ---------------------------------------------------------------------------
RECORDED_COMMUNITY_IMAGES_RESPONSE = {
    "items": [
        {
            "id": 8874915,
            "url": (
                "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/"
                "aaaa0000-1111-2222-3333-444455556666/original=true/"
                "aaaa0000-1111-2222-3333-444455556666.jpeg"
            ),
            "width": 1024,
            "height": 1536,
            "nsfwLevel": "Mature",
            "type": "image",
            "nsfw": True,
            "browsingLevel": 4,
            "username": "Eternal2kPP",
            "stats": {
                "cryCount": 0, "laughCount": 1, "likeCount": 60,
                "dislikeCount": 0, "heartCount": 7, "commentCount": 3,
            },
            "meta": None,
        },
        {
            "id": 15198652,
            "url": (
                "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/"
                "5a5ba531-c2bb-4a1a-9580-699374730fbd/original=true/"
                "5a5ba531-c2bb-4a1a-9580-699374730fbd.jpeg"
            ),
            "width": 1024,
            "height": 1024,
            "nsfwLevel": "X",
            "type": "image",
            "nsfw": True,
            "browsingLevel": 16,
            "username": None,
            "stats": {
                "cryCount": 0, "laughCount": 1, "likeCount": 12,
                "dislikeCount": 0, "heartCount": 5, "commentCount": 0,
            },
            "meta": None,
        },
        {
            "id": 94080991,
            "url": (
                "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/"
                "fe74d016-5876-434e-a99e-fe56a4075027/original=true/"
                "fe74d016-5876-434e-a99e-fe56a4075027.jpeg"
            ),
            "width": 512,
            "height": 768,
            "nsfwLevel": "None",
            "type": "image",
            "nsfw": False,
            "browsingLevel": 1,
            "username": "jus98",
            "stats": {
                "cryCount": 418, "laughCount": 651, "likeCount": 3664,
                "dislikeCount": 0, "heartCount": 1471, "commentCount": 0,
            },
            "meta": None,
        },
        {
            "id": 99999999,
            "url": (
                "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/"
                "deadbeef-0000-1111-2222-333344445555/original=true/"
                "deadbeef-0000-1111-2222-333344445555.jpeg"
            ),
            "width": 768,
            "height": 768,
            "nsfwLevel": "Soft",
            "type": "image",
            "nsfw": True,
            "browsingLevel": 2,
            "username": "someone",
            # `stats` deliberately absent on this one -- see fixture comment.
            "meta": None,
        },
    ],
    "metadata": {"nextCursor": "100|1759019220000"},
}


# ---------------------------------------------------------------------------
# civitai_parse.parse_community_images -- the pure parser.
# ---------------------------------------------------------------------------


def test_parse_community_images_against_recorded_response_shape_and_count():
    images = civitai_parse.parse_community_images(RECORDED_COMMUNITY_IMAGES_RESPONSE["items"])
    assert len(images) == 4
    for image in images:
        assert set(image.keys()) == {"url", "width", "height", "nsfw_level", "username", "reaction_count"}


def test_parse_community_images_word_nsfw_level_mapped_via_browsing_level_common_case():
    images = civitai_parse.parse_community_images(RECORDED_COMMUNITY_IMAGES_RESPONSE["items"])
    assert images[0]["nsfw_level"] == 4  # "Mature" / browsingLevel=4
    assert images[0]["username"] == "Eternal2kPP"


def test_parse_community_images_null_username_stays_none_not_a_placeholder():
    images = civitai_parse.parse_community_images(RECORDED_COMMUNITY_IMAGES_RESPONSE["items"])
    assert images[1]["username"] is None
    assert images[1]["nsfw_level"] == 16


def test_parse_community_images_pg_level_reads_one():
    images = civitai_parse.parse_community_images(RECORDED_COMMUNITY_IMAGES_RESPONSE["items"])
    assert images[2]["nsfw_level"] == 1
    assert images[2]["username"] == "jus98"


def test_parse_community_images_missing_stats_reaction_count_is_none_not_zero():
    images = civitai_parse.parse_community_images(RECORDED_COMMUNITY_IMAGES_RESPONSE["items"])
    assert images[3]["reaction_count"] is None


def test_parse_community_images_reaction_count_sums_four_reaction_types_plus_dislike_excludes_comments():
    image = {
        "url": "https://image.civitai.com/x/y/original=true/y.jpeg",
        "stats": {
            "cryCount": 1, "laughCount": 2, "likeCount": 3,
            "dislikeCount": 4, "heartCount": 5, "commentCount": 1000,
        },
    }
    parsed = civitai_parse.parse_community_images([image])
    assert parsed[0]["reaction_count"] == 1 + 2 + 3 + 4 + 5  # commentCount NOT included


def test_parse_community_images_no_prompt_key_ever_present_even_with_meta():
    # `meta` on a community image never carries a usable prompt (design
    # doc's own measured 0/40 -- re-confirmed here at a higher sample size),
    # but even a MALICIOUS/unexpected `meta.prompt` must never surface --
    # this parser doesn't read `meta` at all, unlike `parse_author_gallery`.
    image = {
        "url": "https://image.civitai.com/x/y/original=true/y.jpeg",
        "meta": {"prompt": "1girl, masterpiece"},
    }
    parsed = civitai_parse.parse_community_images([image])
    assert "prompt" not in parsed[0]
    assert "negative_prompt" not in parsed[0]
    assert "params" not in parsed[0]


def test_parse_community_images_nsfw_level_absent_entirely_defaults_to_16():
    image = {"url": "https://image.civitai.com/x/y/original=true/y.jpeg"}
    parsed = civitai_parse.parse_community_images([image])
    assert parsed[0]["nsfw_level"] == 16


def test_parse_community_images_nsfw_level_explicit_null_defaults_to_16():
    image = {
        "url": "https://image.civitai.com/x/y/original=true/y.jpeg",
        "browsingLevel": None,
        "nsfwLevel": None,
    }
    parsed = civitai_parse.parse_community_images([image])
    assert parsed[0]["nsfw_level"] == 16


def test_parse_community_images_unrecognised_nsfw_word_defaults_to_16():
    image = {
        "url": "https://image.civitai.com/x/y/original=true/y.jpeg",
        "nsfwLevel": "Blocked",  # a real Civitai word this package never treats as browsable
    }
    parsed = civitai_parse.parse_community_images([image])
    assert parsed[0]["nsfw_level"] == 16


def test_parse_community_images_accepts_a_legacy_int_nsfw_level_when_browsing_level_absent():
    # This task's OWN spec described `nsfw_level` as a plain int -- kept as
    # a fallback in case an older/different Civitai response shape sends it
    # that way (this package has already seen this exact field switch shape
    # once, per the module comment above `_community_nsfw_level`).
    image = {"url": "https://image.civitai.com/x/y/original=true/y.jpeg", "nsfwLevel": 8}
    parsed = civitai_parse.parse_community_images([image])
    assert parsed[0]["nsfw_level"] == 8


def test_parse_community_images_missing_username_key_entirely_is_none():
    image = {"url": "https://image.civitai.com/x/y/original=true/y.jpeg"}
    parsed = civitai_parse.parse_community_images([image])
    assert parsed[0]["username"] is None


def test_parse_community_images_url_is_thumbnail_rewritten():
    image = {"url": "https://image.civitai.com/x/y/original=true/y.jpeg"}
    parsed = civitai_parse.parse_community_images([image])
    assert "anim=false,width=256" in parsed[0]["url"]
    assert "original=true" not in parsed[0]["url"]


def test_parse_community_images_skips_entries_without_a_usable_url():
    items = [
        {"url": ""},
        {"url": None},
        {},
        {"width": 100},
        {"url": "https://image.civitai.com/x/y/original=true/y.jpeg"},
    ]
    parsed = civitai_parse.parse_community_images(items)
    assert len(parsed) == 1


def test_parse_community_images_non_list_input_returns_empty_list():
    assert civitai_parse.parse_community_images(None) == []
    assert civitai_parse.parse_community_images({}) == []
    assert civitai_parse.parse_community_images("not a list") == []


def test_parse_community_images_non_dict_entries_in_list_are_skipped():
    parsed = civitai_parse.parse_community_images([
        "not a dict", 42, None, {"url": "https://image.civitai.com/x/y/original=true/y.jpeg"},
    ])
    assert len(parsed) == 1


def test_parse_community_images_width_height_missing_or_non_int_are_none():
    items = [
        {"url": "https://image.civitai.com/x/y/original=true/y.jpeg", "width": "not-an-int", "height": True},
        {"url": "https://image.civitai.com/x/y2/original=true/y2.jpeg"},
    ]
    parsed = civitai_parse.parse_community_images(items)
    assert parsed[0]["width"] is None
    assert parsed[0]["height"] is None  # `True` is a bool, rejected same as every other int field here
    assert parsed[1]["width"] is None
    assert parsed[1]["height"] is None


# ---------------------------------------------------------------------------
# civitai_client.fetch_community_images -- the HTTP transport, no real
# network (an injectable fake opener, same shape `tests/test_model_browser.
# py`'s own `_FakeResponse`/`_sequence_opener` already use for every sibling
# Civitai call).
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        if n is None or n < 0:
            data, self._body = self._body, b""
        else:
            data, self._body = self._body[:n], self._body[n:]
        return data


def _sequence_opener(steps):
    calls = []

    def opener(url, timeout):
        calls.append((url, timeout))
        step = steps[len(calls) - 1]
        return step()

    return opener, calls


def test_fetch_community_images_success_on_first_host_builds_the_documented_url():
    body = json.dumps(RECORDED_COMMUNITY_IMAGES_RESPONSE).encode("utf-8")
    opener, calls = _sequence_opener([lambda: _FakeResponse(body)])
    result = civitai_client.fetch_community_images(207286, limit=24, opener=opener)
    assert result["reason"] == "found"
    assert len(result["data"]["items"]) == 4
    assert len(calls) == 1
    assert "modelVersionId=207286" in calls[0][0]
    assert "limit=24" in calls[0][0]


def test_fetch_community_images_404_is_definitive_and_never_tries_backup_host():
    def raise_404():
        raise urllib.error.HTTPError("url", 404, "Not Found", None, None)

    opener, calls = _sequence_opener([raise_404])
    result = civitai_client.fetch_community_images(999999999, opener=opener)
    assert result["reason"] == "notfound"
    assert len(calls) == 1


def test_fetch_community_images_offline_timeout_is_a_distinct_reason():
    def raise_timeout():
        raise socket.timeout("timed out")

    opener, calls = _sequence_opener([raise_timeout, raise_timeout])
    result = civitai_client.fetch_community_images(207286, opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "timeout"
    assert len(calls) == 2  # both hosts tried -- a timeout is transient, unlike a 404


# ---------------------------------------------------------------------------
# api.community_images_impl -- the pure route body. The literal wire
# contract lives here: `{"ok", "reason", "images"}`, no other top-level key,
# on EVERY branch -- this is the exact shape a separately-built frontend
# task is consuming (this task's own brief: "a contract split across two
# builders... silently broke last time... assert the literal JSON shape").
# ---------------------------------------------------------------------------


def _install_permissive_community_images_limiter():
    """Same reasoning as `tests/test_model_browser.py`'s own
    `_install_permissive_search_limiter` -- avoids cross-test bleed from the
    real, shared `_COMMUNITY_IMAGES_LIMITER` singleton and its real 1.0s
    interval."""
    previous = mb_api._COMMUNITY_IMAGES_LIMITER
    mb_api._COMMUNITY_IMAGES_LIMITER = rate_limit.MinIntervalLimiter(0.0)
    return lambda: setattr(mb_api, "_COMMUNITY_IMAGES_LIMITER", previous)


def _install_fake_fetch_community_images(fn):
    """Swaps `mb_api.civitai_client.fetch_community_images` for `fn` --
    same "monkeypatch the module attribute the impl actually calls" shape
    `tests/test_model_browser.py`'s own `test_search_impl_happy_path_...`
    already uses for `civitai_search.search_models`. Returns a restore
    callable."""
    previous = mb_api.civitai_client.fetch_community_images
    mb_api.civitai_client.fetch_community_images = fn
    return lambda: setattr(mb_api.civitai_client, "fetch_community_images", previous)


def test_community_images_impl_non_integer_version_id_is_rejected_readably_with_no_network_call():
    restore_limiter = _install_permissive_community_images_limiter()

    def _must_not_run(*a, **kw):
        raise AssertionError("an invalid version_id must never reach the network")

    restore_fetch = _install_fake_fetch_community_images(_must_not_run)
    try:
        result = mb_api.community_images_impl({"version_id": "not-a-number"})
        assert result == {"ok": True, "reason": "notfound", "images": []}
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_missing_version_id_is_notfound_with_no_network_call():
    restore_limiter = _install_permissive_community_images_limiter()

    def _must_not_run(*a, **kw):
        raise AssertionError("a missing version_id must never reach the network")

    restore_fetch = _install_fake_fetch_community_images(_must_not_run)
    try:
        result = mb_api.community_images_impl({})
        assert result == {"ok": True, "reason": "notfound", "images": []}
        result_none = mb_api.community_images_impl({"version_id": None})
        assert result_none == {"ok": True, "reason": "notfound", "images": []}
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_a_negative_or_zero_version_id_is_also_notfound():
    restore_limiter = _install_permissive_community_images_limiter()
    restore_fetch = _install_fake_fetch_community_images(
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("must never reach the network"))
    )
    try:
        assert mb_api.community_images_impl({"version_id": "-5"})["reason"] == "notfound"
        assert mb_api.community_images_impl({"version_id": 0})["reason"] == "notfound"
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_happy_path_ok_reason_and_parsed_images():
    restore_limiter = _install_permissive_community_images_limiter()
    captured_calls = []

    def fake_fetch(version_id, *, limit=24, **kw):
        captured_calls.append((version_id, limit))
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": copy.deepcopy(RECORDED_COMMUNITY_IMAGES_RESPONSE),
        }

    restore_fetch = _install_fake_fetch_community_images(fake_fetch)
    try:
        result = mb_api.community_images_impl({"version_id": "207286", "limit": "10"})
        assert result["ok"] is True
        assert result["reason"] == "ok"
        assert len(result["images"]) == 4
        assert captured_calls == [(207286, 10)]
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_offline_degrades_to_ok_true_empty_images_never_an_error():
    restore_limiter = _install_permissive_community_images_limiter()
    restore_fetch = _install_fake_fetch_community_images(
        lambda *a, **kw: {"reason": "offline", "offline_reason": "timeout", "message": "Civitai timed out.", "data": None}
    )
    try:
        result = mb_api.community_images_impl({"version_id": "207286"})
        assert result == {"ok": True, "reason": "offline", "images": []}
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_transport_notfound_also_degrades_to_ok_true_empty_images():
    restore_limiter = _install_permissive_community_images_limiter()
    restore_fetch = _install_fake_fetch_community_images(
        lambda *a, **kw: {"reason": "notfound", "offline_reason": None, "message": "gone", "data": None}
    )
    try:
        result = mb_api.community_images_impl({"version_id": "207286"})
        assert result == {"ok": True, "reason": "notfound", "images": []}
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_empty_items_is_still_ok_not_an_error():
    # A version with genuinely zero community images is a SUCCESSFUL fetch,
    # not a failure -- `reason` stays `"ok"`, only `images` is empty.
    restore_limiter = _install_permissive_community_images_limiter()
    restore_fetch = _install_fake_fetch_community_images(
        lambda *a, **kw: {"reason": "found", "offline_reason": None, "message": "", "data": {"items": [], "metadata": {}}}
    )
    try:
        result = mb_api.community_images_impl({"version_id": "207286"})
        assert result == {"ok": True, "reason": "ok", "images": []}
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_rate_limited_never_reaches_the_network():
    previous_limiter = mb_api._COMMUNITY_IMAGES_LIMITER
    denying_limiter = rate_limit.MinIntervalLimiter(1000.0)
    denying_limiter.allow()  # consume the one free call so the NEXT is refused
    mb_api._COMMUNITY_IMAGES_LIMITER = denying_limiter

    def _must_not_run(*a, **kw):
        raise AssertionError("a rate-limited call must never reach fetch_community_images")

    restore_fetch = _install_fake_fetch_community_images(_must_not_run)
    try:
        result = mb_api.community_images_impl({"version_id": "207286"})
        assert result == {"ok": True, "reason": "rate_limited", "images": []}
    finally:
        restore_fetch()
        mb_api._COMMUNITY_IMAGES_LIMITER = previous_limiter


def test_community_images_impl_limit_defaults_to_24_when_absent():
    restore_limiter = _install_permissive_community_images_limiter()
    captured = []
    restore_fetch = _install_fake_fetch_community_images(
        lambda version_id, *, limit=24, **kw: (captured.append(limit) or {
            "reason": "found", "offline_reason": None, "message": "", "data": {"items": [], "metadata": {}},
        })
    )
    try:
        mb_api.community_images_impl({"version_id": "207286"})
        assert captured == [24]
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_limit_clamps_below_one_up_to_one():
    restore_limiter = _install_permissive_community_images_limiter()
    captured = []
    restore_fetch = _install_fake_fetch_community_images(
        lambda version_id, *, limit=24, **kw: (captured.append(limit) or {
            "reason": "found", "offline_reason": None, "message": "", "data": {"items": [], "metadata": {}},
        })
    )
    try:
        for bad_limit in ("0", "-10", "not-a-number", None):
            captured.clear()
            mb_api.community_images_impl({"version_id": "207286", "limit": bad_limit})
            expected = 24 if bad_limit in (None, "not-a-number") else 1
            assert captured == [expected], (bad_limit, captured)
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_limit_clamps_above_sixty_down_to_sixty():
    restore_limiter = _install_permissive_community_images_limiter()
    captured = []
    restore_fetch = _install_fake_fetch_community_images(
        lambda version_id, *, limit=24, **kw: (captured.append(limit) or {
            "reason": "found", "offline_reason": None, "message": "", "data": {"items": [], "metadata": {}},
        })
    )
    try:
        mb_api.community_images_impl({"version_id": "207286", "limit": "999"})
        assert captured == [60]
    finally:
        restore_fetch()
        restore_limiter()


def test_community_images_impl_literal_response_key_set_pinned_on_every_branch():
    """THE wire-contract regression test this task's own brief calls for by
    name: not just the VALUES, the literal KEY SET -- exactly `{"ok",
    "reason", "images"}`, no `message`/`offline_reason`/anything else, on
    EVERY branch (success, offline, notfound-by-validation, rate-limited),
    and each image dict's own literal key set. A frontend built against a
    DIFFERENT shape (an extra key it reads, or a missing one it needed)
    would pass every other assertion in this file and still be broken --
    exactly the failure mode the brief describes already happening once."""
    restore_limiter = _install_permissive_community_images_limiter()
    try:
        # notfound-by-validation (no network at all)
        result = mb_api.community_images_impl({"version_id": "garbage"})
        assert set(result.keys()) == {"ok", "reason", "images"}

        # rate_limited
        previous_limiter = mb_api._COMMUNITY_IMAGES_LIMITER
        denying_limiter = rate_limit.MinIntervalLimiter(1000.0)
        denying_limiter.allow()
        mb_api._COMMUNITY_IMAGES_LIMITER = denying_limiter
        try:
            result = mb_api.community_images_impl({"version_id": "207286"})
            assert set(result.keys()) == {"ok", "reason", "images"}
        finally:
            mb_api._COMMUNITY_IMAGES_LIMITER = previous_limiter

        # offline
        restore_fetch = _install_fake_fetch_community_images(
            lambda *a, **kw: {"reason": "offline", "offline_reason": "timeout", "message": "x", "data": None}
        )
        try:
            result = mb_api.community_images_impl({"version_id": "207286"})
            assert set(result.keys()) == {"ok", "reason", "images"}
        finally:
            restore_fetch()

        # ok, with real parsed images -- also pin EACH image's own key set.
        restore_fetch = _install_fake_fetch_community_images(
            lambda *a, **kw: {
                "reason": "found", "offline_reason": None, "message": "",
                "data": copy.deepcopy(RECORDED_COMMUNITY_IMAGES_RESPONSE),
            }
        )
        try:
            result = mb_api.community_images_impl({"version_id": "207286"})
            assert set(result.keys()) == {"ok", "reason", "images"}
            assert result["reason"] == "ok"
            assert len(result["images"]) == 4
            for image in result["images"]:
                assert set(image.keys()) == {"url", "width", "height", "nsfw_level", "username", "reaction_count"}
        finally:
            restore_fetch()
    finally:
        restore_limiter()


ALL_TESTS = [
    test_parse_community_images_against_recorded_response_shape_and_count,
    test_parse_community_images_word_nsfw_level_mapped_via_browsing_level_common_case,
    test_parse_community_images_null_username_stays_none_not_a_placeholder,
    test_parse_community_images_pg_level_reads_one,
    test_parse_community_images_missing_stats_reaction_count_is_none_not_zero,
    test_parse_community_images_reaction_count_sums_four_reaction_types_plus_dislike_excludes_comments,
    test_parse_community_images_no_prompt_key_ever_present_even_with_meta,
    test_parse_community_images_nsfw_level_absent_entirely_defaults_to_16,
    test_parse_community_images_nsfw_level_explicit_null_defaults_to_16,
    test_parse_community_images_unrecognised_nsfw_word_defaults_to_16,
    test_parse_community_images_accepts_a_legacy_int_nsfw_level_when_browsing_level_absent,
    test_parse_community_images_missing_username_key_entirely_is_none,
    test_parse_community_images_url_is_thumbnail_rewritten,
    test_parse_community_images_skips_entries_without_a_usable_url,
    test_parse_community_images_non_list_input_returns_empty_list,
    test_parse_community_images_non_dict_entries_in_list_are_skipped,
    test_parse_community_images_width_height_missing_or_non_int_are_none,
    test_fetch_community_images_success_on_first_host_builds_the_documented_url,
    test_fetch_community_images_404_is_definitive_and_never_tries_backup_host,
    test_fetch_community_images_offline_timeout_is_a_distinct_reason,
    test_community_images_impl_non_integer_version_id_is_rejected_readably_with_no_network_call,
    test_community_images_impl_missing_version_id_is_notfound_with_no_network_call,
    test_community_images_impl_a_negative_or_zero_version_id_is_also_notfound,
    test_community_images_impl_happy_path_ok_reason_and_parsed_images,
    test_community_images_impl_offline_degrades_to_ok_true_empty_images_never_an_error,
    test_community_images_impl_transport_notfound_also_degrades_to_ok_true_empty_images,
    test_community_images_impl_empty_items_is_still_ok_not_an_error,
    test_community_images_impl_rate_limited_never_reaches_the_network,
    test_community_images_impl_limit_defaults_to_24_when_absent,
    test_community_images_impl_limit_clamps_below_one_up_to_one,
    test_community_images_impl_limit_clamps_above_sixty_down_to_sixty,
    test_community_images_impl_literal_response_key_set_pinned_on_every_branch,
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
        except Exception as exc:  # noqa: BLE001 - surface unexpected errors as failures too
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
