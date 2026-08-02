"""Plain-script tests for the two-call Meili search design (docs/lora-
loader-design.md §7c-0/§7c-0b) -- `src/model_browser/civitai_meili.py`'s own
pure filter/payload/parse functions, its impure `_post_meili`/`two_call_search`
orchestration (via an injectable fake opener, no real network), the two new
`civitai_search.py` functions it depends on for STEP 2
(`build_ids_search_url`/`search_models_by_ids`), and `api.py`'s `search_impl`
choosing between the Meili default path and the REST fallback.

**Fixtures are RECORDED, not synthesized** (per this task's own brief) --
every id/name/`nsfwLevel`/`estimatedTotalHits`/`lastVersionAtUnix` value
below was captured from a REAL, live `POST https://search.civitai.com/
multi-search` (Civitai's own public web-app Meilisearch endpoint, Bearer
token from `Civicomfy/api/civitai.py:135`, MIT) and a REAL `GET https://
civitai.com/api/v1/models?ids=...&nsfw=true`, both 2026-08-02, then trimmed
to the fields these tests actually read. In particular the THREE Meili
fixtures below (`_MIXED_LEVELS_FIXTURE`/`_PG_EXCLUDED_FIXTURE`/
`_INCLUSION_LEAK_FIXTURE`) are the live measurement behind
`civitai_meili.level_exclusion_filter`'s own docstring: querying `"edit"` +
`baseModel=Anima` unfiltered returns 20 hits with plenty of MIXED-level
models (not just clean ones -- the design doc's own warning: "test this
against a model known to carry mixed levels, not only against a clean
one"); adding the EXCLUSION filter this module actually sends narrows that
to the two hits whose `nsfwLevel` is `[1]` and nothing else; the equivalent
INCLUSION filter (`nsfwLevel IN [1]`, Civicomfy's own approach) instead
returns TWENTY-ONE, including several whose `nsfwLevel` also contains
2/4/8/16 -- an inclusion filter passing a clean-model smoke test while
leaking mixed content, exactly as the design doc predicted.

`tests/test_model_browser.py` and `tests/test_model_browser_logs.py` cover
the REST-only path this task demotes to a fallback -- both force
`civitai_meili.two_call_search` to report `"meili_unavailable"` once, near
their own imports, so their existing `civitai_search.search_models`-facing
assertions keep exercising exactly the same REST behaviour as before this
task, now correctly read as the fallback rather than the default (see
either file's own top comment for the full reasoning). This file is the
one that actually exercises the Meili path, and the choice between the two.

Run directly: `python tests/test_model_browser_meili.py` (no pytest, per
project convention).
"""
from __future__ import annotations

import logging
import os
import sys
import tempfile
import types
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.model_browser import api as mb_api
from src.model_browser import civitai_meili, civitai_search, rate_limit
from src.model_browser import logs as mb_logs

# ---------------------------------------------------------------------------
# `folder_paths` stub -- deliberately duplicated per this repo's own
# precedent (`tests/test_model_browser_logs.py`'s/`test_model_browser_thumb_
# cache.py`'s own copies), so each test file stays independently runnable.
# ---------------------------------------------------------------------------


def _install_fake_folder_paths(roots_by_folder, names_by_folder):
    fake = types.ModuleType("folder_paths")

    def get_folder_paths(folder):
        return list(roots_by_folder.get(folder, []))

    def get_filename_list(folder):
        return list(names_by_folder.get(folder, []))

    def get_full_path(folder, name):
        for root in roots_by_folder.get(folder, []):
            candidate = os.path.join(root, name)
            if os.path.isfile(candidate):
                return candidate
        return None

    fake.get_folder_paths = get_folder_paths
    fake.get_filename_list = get_filename_list
    fake.get_full_path = get_full_path

    previous = sys.modules.get("folder_paths")
    sys.modules["folder_paths"] = fake

    def restore():
        if previous is None:
            sys.modules.pop("folder_paths", None)
        else:
            sys.modules["folder_paths"] = previous

    return restore


def _install_permissive_search_limiter():
    previous = mb_api._SEARCH_LIMITER
    mb_api._SEARCH_LIMITER = rate_limit.MinIntervalLimiter(0.0)
    return lambda: setattr(mb_api, "_SEARCH_LIMITER", previous)


class _ListHandler(logging.Handler):
    """Deliberately duplicated per this repo's own precedent -- same shape
    as `tests/test_model_browser_logs.py`'s own `_ListHandler`/`_capture_logs`."""

    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):  # noqa: D102 - stdlib override
        self.records.append(record.getMessage())


def _capture_logs():
    logger = logging.getLogger(mb_logs.LOGGER_NAME)
    previous_level = logger.level
    handler = _ListHandler()
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)

    def restore():
        logger.removeHandler(handler)
        logger.setLevel(previous_level)

    return handler.records, restore


def _with_debug_level():
    previous = mb_logs.current_level
    mb_logs.current_level = lambda: "debug"
    return lambda: setattr(mb_logs, "current_level", previous)


# ---------------------------------------------------------------------------
# RECORDED fixtures -- see this file's own top docstring for provenance.
# ---------------------------------------------------------------------------

# `POST /multi-search`, `q="edit"`, filter=[type=LORA, baseModel=Anima,
# availability=Public] -- NO level filter. 20 hits (of 49 total), Meili's
# OWN rank order preserved below. Deliberately contains PLENTY of
# mixed-level hits (e.g. id 1911956: `[1, 2, 4]`), not just clean ones.
_MIXED_LEVELS_FIXTURE = {
    "results": [{
        "hits": [
            {"id": 1443103, "name": "EdiTheMad Style (Anima/Illustrious)", "nsfwLevel": [4, 8, 16, 32]},
            {"id": 1911956, "name": "Editorial Cartoon Style", "nsfwLevel": [1, 2, 4]},
            {"id": 2730717, "name": "Edith Synthesis Ten", "nsfwLevel": [1, 2]},
            {"id": 2732316, "name": "Edith Gru - Despicable Me", "nsfwLevel": [1]},
            {"id": 2650553, "name": "Anima Edit", "nsfwLevel": [2, 4, 8]},
            {"id": 2652469, "name": "Anima Edit-experimental", "nsfwLevel": [2, 8, 16]},
            {"id": 2799653, "name": "uncensored edit test", "nsfwLevel": [1, 2, 4, 8]},
            {"id": 2797936, "name": "anima edit @photorealistic", "nsfwLevel": [1, 2, 4]},
            {"id": 2614771, "name": "Urban Editorial Anime Style", "nsfwLevel": [1]},
            {"id": 1978701, "name": "Queen Complex - ArtStyle - Special Edition", "nsfwLevel": [4, 8, 16, 32]},
            {"id": 1979404, "name": "Peach Momoko - ArtStyle - Special Edition", "nsfwLevel": [4, 8, 16, 32]},
            {"id": 2108608, "name": "Fnaf Characters Ilustrious Edition - IL-Lolbit", "nsfwLevel": [1, 2, 4]},
            {"id": 2752978, "name": "Extend Image - Image Edit (Anima Edit)", "nsfwLevel": [1, 4, 8, 16]},
            {"id": 2587631, "name": "nude filter | simple edit", "nsfwLevel": [4, 8, 16, 32]},
            {"id": 2685547, "name": "Manga Doujinshi Colorizer ANIMA Edit lora", "nsfwLevel": [4, 8, 16, 32]},
            {"id": 526273, "name": "Crotch face anime edit trained edition", "nsfwLevel": [4, 8, 16, 32]},
            {"id": 2689036, "name": "[Anima] Pregnant Edit LoRA", "nsfwLevel": [4, 8, 16, 32]},
            {"id": 2615507, "name": "Twokinds-Characters-Anima Edition", "nsfwLevel": [1, 2, 4, 8]},
            {"id": 2613308, "name": "Tsunade [Naruto] - AoRa v2 Edition LoRa", "nsfwLevel": [1, 2, 4, 8]},
            {"id": 2681704, "name": "Bulma (Namek Edition)", "nsfwLevel": [2]},
        ],
        "estimatedTotalHits": 49,
        "limit": 20,
        "offset": 0,
    }],
}

# SAME query, WITH the exclusion filter this module actually sends at PG
# (`"NOT nsfwLevel IN [2,4,8,16,32]"`) -- only the two truly-clean hits
# survive, out of the twenty above.
_PG_EXCLUDED_FIXTURE = {
    "results": [{
        "hits": [
            {"id": 2732316, "name": "Edith Gru - Despicable Me", "nsfwLevel": [1]},
            {"id": 2614771, "name": "Urban Editorial Anime Style", "nsfwLevel": [1]},
        ],
        "estimatedTotalHits": 2,
        "limit": 20,
        "offset": 0,
    }],
}

# SAME query, with the REJECTED inclusion filter (`"nsfwLevel IN [1]"`,
# Civicomfy's own approach) -- 21 hits, MANY of which also carry 2/4/8/16 in
# their `nsfwLevel` union (e.g. id 1911956 again: `[1, 2, 4]`). Kept only as
# a negative contrast proving the leak this module's own exclusion filter
# avoids -- never sent by this codebase.
_INCLUSION_LEAK_FIXTURE = {
    "results": [{
        "hits": [
            {"id": 1911956, "name": "Editorial Cartoon Style", "nsfwLevel": [1, 2, 4]},
            {"id": 2730717, "name": "Edith Synthesis Ten", "nsfwLevel": [1, 2]},
            {"id": 2732316, "name": "Edith Gru - Despicable Me", "nsfwLevel": [1]},
            {"id": 2799653, "name": "uncensored edit test", "nsfwLevel": [1, 2, 4, 8]},
            {"id": 2797936, "name": "anima edit @photorealistic", "nsfwLevel": [1, 2, 4]},
            {"id": 2614771, "name": "Urban Editorial Anime Style", "nsfwLevel": [1]},
            {"id": 2108608, "name": "Fnaf Characters Ilustrious Edition - IL-Lolbit", "nsfwLevel": [1, 2, 4]},
            {"id": 2752978, "name": "Extend Image - Image Edit (Anima Edit)", "nsfwLevel": [1, 4, 8, 16]},
            {"id": 2615507, "name": "Twokinds-Characters-Anima Edition", "nsfwLevel": [1, 2, 4, 8]},
            {"id": 2613308, "name": "Tsunade [Naruto] - AoRa v2 Edition LoRa", "nsfwLevel": [1, 2, 4, 8]},
            {"id": 2684658, "name": "Helluva Boss- Characters-Anima Edition", "nsfwLevel": [1, 4]},
            {"id": 2621084, "name": "Sakura [Boruto] - AoRa v2 Edition LoRa", "nsfwLevel": [1, 2]},
            {"id": 2693133, "name": "uwustyle Anima Edition", "nsfwLevel": [1, 2]},
            {"id": 1320174, "name": "Animal Crossing Character pack - IL-Isabelle", "nsfwLevel": [1, 2, 4]},
            {"id": 1320170, "name": "Animal Crossing Character pack - IL-Charly", "nsfwLevel": [1, 2, 4]},
            {"id": 2820047, "name": "YAAE | Yet Another Anima Edit", "nsfwLevel": [1, 2, 4]},
            {"id": 2651259, "name": "Kanu Unchou (IKKITOUSEN) AoRa v3 Edition LoRa", "nsfwLevel": [1, 2]},
            {"id": 2632484, "name": "Boa hancock [one piece] - AoRa v3 Edition LoRa", "nsfwLevel": [1, 2, 4, 8]},
            {"id": 2493147, "name": "Midori 'Senbei' Norimaki (Special Kon Kon Helmet Edition)", "nsfwLevel": [1, 2, 4, 8, 16]},
            {"id": 2800681, "name": "Disgaea 1 Anime Style | Anima Edition", "nsfwLevel": [1, 2, 4]},
        ],
        "estimatedTotalHits": 21,
        "limit": 20,
        "offset": 0,
    }],
}

# `GET /api/v1/models?ids=2650553&ids=1978701&ids=2108608&ids=1443103&nsfw=true`
# -- a REAL response, trimmed to the fields `civitai_search.
# parse_search_response` reads. Order here is v1's OWN response order,
# DELIBERATELY not Meili's rank order (measured live: v1 does not preserve
# request order) -- `reorder_by_ids` is what restores it in the tests below.
_V1_REHYDRATION_FIXTURE = {
    "items": [
        {
            "id": 2650553, "name": "Anima Edit", "type": "LORA",
            "modelVersions": [{
                "id": 3089149, "baseModel": "Anima",
                "files": [{"name": "AnimeEditV2.safetensors", "sizeKB": 358500.4,
                           "downloadUrl": "https://civitai.com/api/download/models/3089149",
                           "primary": True, "hashes": {"SHA256": "1A3B14064831C144DE293DF208F67A1F3F32CF43CAE8CE5DF46F337B21765218"}}],
            }],
        },
        {
            "id": 1978701, "name": "Queen Complex - ArtStyle - Special Edition", "type": "LORA",
            "modelVersions": [{
                "id": 3041192, "baseModel": "Anima",
                "files": [{"name": "QueenComplex-ANIMA-ArtStyle.safetensors", "sizeKB": 135507.7,
                           "downloadUrl": "https://civitai.com/api/download/models/3041192",
                           "primary": True, "hashes": {"SHA256": "C5E1E8C0D31CB0643BE57A0929C6E7F752A412D3156370DF5F7ABF35119ACF1E"}}],
            }],
        },
        {
            "id": 2108608, "name": "Fnaf Characters Ilustrious Edition - IL-Lolbit", "type": "LORA",
            "modelVersions": [{
                "id": 3172146, "baseModel": "Anima",
                "files": [{"name": "Lolbit-Fnaf-Anima.safetensors", "sizeKB": 135413.8,
                           "downloadUrl": "https://civitai.com/api/download/models/3172146",
                           "primary": True, "hashes": {"SHA256": "EBCAD657463831E6E1BF3263B2A031923A3E6D14A21328E01D2479130E1A65BC"}}],
            }],
        },
        {
            "id": 1443103, "name": "EdiTheMad Style (Anima/Illustrious)", "type": "LORA",
            "modelVersions": [{
                "id": 3142753, "baseModel": "Anima",
                "files": [{"name": "_ediani_epoch_10.safetensors", "sizeKB": 169302.4,
                           "downloadUrl": "https://civitai.com/api/download/models/3142753",
                           "primary": True, "hashes": {"SHA256": "B0B1930EA6FE00734EAC0D65E571AEFD4F8EB99F1FD6CBD6EEA25528CF45EB89"}}],
            }],
        },
    ],
}

# The Meili rank order for exactly those four ids, read off
# `_MIXED_LEVELS_FIXTURE` above (their positions there: 1443103 is hit 0,
# 2650553 is hit 4, 1978701 is hit 9, 2108608 is hit 11) -- this is the
# order `reorder_by_ids` must restore from `_V1_REHYDRATION_FIXTURE`'s own,
# different, order.
_FOUR_IDS_IN_MEILI_RANK_ORDER = [1443103, 2650553, 1978701, 2108608]


# ---------------------------------------------------------------------------
# Pure filters: level / period / sort.
# ---------------------------------------------------------------------------


def test_level_exclusion_filter_pg_matches_the_live_verified_string():
    # The EXACT filter string measured live (2026-08-02) to reduce
    # `_MIXED_LEVELS_FIXTURE`'s 20 hits down to `_PG_EXCLUDED_FIXTURE`'s 2.
    assert civitai_search.DEFAULT_LEVEL == 1
    assert civitai_meili.level_exclusion_filter(1) == "NOT nsfwLevel IN [2,4,8,16,32]"


def test_level_exclusion_filter_every_level_excludes_everything_above_it():
    assert civitai_meili.level_exclusion_filter(2) == "NOT nsfwLevel IN [4,8,16,32]"
    assert civitai_meili.level_exclusion_filter(4) == "NOT nsfwLevel IN [8,16,32]"
    assert civitai_meili.level_exclusion_filter(8) == "NOT nsfwLevel IN [16,32]"
    # 16 (XXX) is the highest SELECTABLE level -- 32 ("Blocked") is still
    # excluded, never browsable at any setting.
    assert civitai_meili.level_exclusion_filter(16) == "NOT nsfwLevel IN [32]"


def test_level_exclusion_filter_garbage_falls_back_to_pg():
    for bad in (0, 3, 32, "bogus", None, True):
        assert civitai_meili.level_exclusion_filter(bad) == "NOT nsfwLevel IN [2,4,8,16,32]", bad


def test_period_filter_each_period_maps_to_the_epoch_it_claims():
    now_ms = 1_800_000_000_000  # an arbitrary fixed instant, ms since epoch
    day_ms = 24 * 3600 * 1000
    assert civitai_meili.period_filter("Day", now_ms=now_ms) == f"lastVersionAtUnix > {now_ms - day_ms}"
    assert civitai_meili.period_filter("Week", now_ms=now_ms) == f"lastVersionAtUnix > {now_ms - 7 * day_ms}"
    assert civitai_meili.period_filter("Month", now_ms=now_ms) == f"lastVersionAtUnix > {now_ms - 30 * day_ms}"
    assert civitai_meili.period_filter("Year", now_ms=now_ms) == f"lastVersionAtUnix > {now_ms - 365 * day_ms}"


def test_period_filter_all_time_is_no_filter_at_all():
    assert civitai_meili.period_filter("AllTime", now_ms=1_800_000_000_000) is None


def test_period_filter_garbage_falls_back_to_the_default_period():
    assert civitai_meili.period_filter("not-a-real-period", now_ms=1_800_000_000_000) == civitai_meili.period_filter(
        civitai_search.DEFAULT_PERIOD, now_ms=1_800_000_000_000,
    )


def test_sort_value_relevancy_sends_no_sort_key_every_other_value_maps():
    assert civitai_meili.sort_value("Relevancy") is None
    assert civitai_meili.sort_value("Highest Rated") == "metrics.thumbsUpCount:desc"
    assert civitai_meili.sort_value("Most Downloaded") == "metrics.downloadCount:desc"
    assert civitai_meili.sort_value("Newest") == "createdAt:desc"


def test_sort_value_garbage_falls_back_to_the_default_sort():
    assert civitai_meili.sort_value("not-a-real-sort") == civitai_meili.sort_value(civitai_search.DEFAULT_SORT)


# ---------------------------------------------------------------------------
# build_meili_filter_groups / build_meili_payload.
# ---------------------------------------------------------------------------


def test_build_meili_filter_groups_a_given_kind_locks_the_type_group():
    groups = civitai_meili.build_meili_filter_groups("loras", now_ms=1_800_000_000_000)
    assert groups[0] == ['"type"="LORA"']
    assert "availability = Public" in groups
    assert "NOT nsfwLevel IN [2,4,8,16,32]" in groups


def test_build_meili_filter_groups_no_kind_validates_the_types_list():
    groups = civitai_meili.build_meili_filter_groups(
        None, types=["LORA", "NotReal", "Checkpoint"], now_ms=1_800_000_000_000,
    )
    # "NotReal" dropped -- never forwarded raw (same `clean_types` behind
    # the REST path already enforces).
    assert groups[0] == ['"type"="LORA"', '"type"="Checkpoint"']


def test_build_meili_filter_groups_no_kind_and_no_types_omits_the_type_group_entirely():
    groups = civitai_meili.build_meili_filter_groups(None, now_ms=1_800_000_000_000)
    assert not any(isinstance(g, list) and g and g[0].startswith('"type"=') for g in groups)


def test_build_meili_filter_groups_base_model_is_an_or_group_never_comma_joined():
    groups = civitai_meili.build_meili_filter_groups(
        "loras", base_model=["Anima", "Illustrious"], now_ms=1_800_000_000_000,
    )
    assert ['"version.baseModel"="Anima"', '"version.baseModel"="Illustrious"'] in groups


def test_build_meili_filter_groups_all_time_period_appends_no_period_group():
    groups = civitai_meili.build_meili_filter_groups("loras", period="AllTime", now_ms=1_800_000_000_000)
    assert not any(isinstance(g, str) and g.startswith("lastVersionAtUnix") for g in groups)


def test_build_meili_payload_full_shape_kind_scoped_relevancy_omits_sort():
    payload = civitai_meili.build_meili_payload(
        "loras", "edit", base_model=["Anima"], level=1, sort="Relevancy", period="AllTime",
        limit=20, offset=0, now_ms=1_800_000_000_000,
    )
    query_obj = payload["queries"][0]
    assert query_obj["q"] == "edit"
    assert query_obj["indexUid"] == "models_v9"
    assert query_obj["limit"] == 20
    assert query_obj["offset"] == 0
    assert query_obj["filter"] == [
        ['"type"="LORA"'],
        ['"version.baseModel"="Anima"'],
        "availability = Public",
        "NOT nsfwLevel IN [2,4,8,16,32]",
    ]
    assert "sort" not in query_obj  # Relevancy -- see this module's own top docstring


def test_build_meili_payload_a_non_relevancy_sort_sends_exactly_one_value_in_a_list():
    payload = civitai_meili.build_meili_payload(
        "loras", "x", sort="Most Downloaded", now_ms=1_800_000_000_000,
    )
    assert payload["queries"][0]["sort"] == ["metrics.downloadCount:desc"]


def test_build_meili_payload_falsy_query_becomes_an_explicit_empty_string():
    for falsy in (None, ""):
        payload = civitai_meili.build_meili_payload("loras", falsy, now_ms=1_800_000_000_000)
        assert payload["queries"][0]["q"] == ""


def test_build_meili_payload_limit_is_clamped_and_offset_never_negative():
    payload = civitai_meili.build_meili_payload("loras", "x", limit=999, offset=-5, now_ms=1_800_000_000_000)
    query_obj = payload["queries"][0]
    assert query_obj["limit"] == civitai_search._MAX_LIMIT
    assert query_obj["offset"] == 0


def test_build_meili_payload_encoded_wire_body_never_comma_joins_a_multi_value_filter():
    # Pin the LITERAL JSON body for a multi-value filter -- the exact shape
    # regression this task's brief calls out ("types" silently comma-joined
    # once already on the REST path, both sides green).
    import json as _json
    payload = civitai_meili.build_meili_payload(
        None, "", types=["LORA", "LoCon"], base_model=["Anima", "Illustrious"],
        period="AllTime", sort="Relevancy", limit=20, offset=0, now_ms=1_800_000_000_000,
    )
    encoded = _json.dumps(payload, sort_keys=True)
    assert encoded == _json.dumps({
        "queries": [{
            "q": "",
            "indexUid": "models_v9",
            "limit": 20,
            "offset": 0,
            "filter": [
                ['"type"="LORA"', '"type"="LoCon"'],
                ['"version.baseModel"="Anima"', '"version.baseModel"="Illustrious"'],
                "availability = Public",
                "NOT nsfwLevel IN [2,4,8,16,32]",
            ],
        }],
    }, sort_keys=True)


# ---------------------------------------------------------------------------
# parse_meili_response -- against the RECORDED fixtures.
# ---------------------------------------------------------------------------


def test_parse_meili_response_ids_come_back_in_rank_order_with_the_real_total():
    parsed = civitai_meili.parse_meili_response(_MIXED_LEVELS_FIXTURE)
    assert parsed["total"] == 49
    assert parsed["ids"][:4] == [1443103, 1911956, 2730717, 2732316]
    assert len(parsed["ids"]) == 20


def test_parse_meili_response_pg_excluded_fixture_keeps_only_the_two_clean_ids():
    # THE recorded proof behind `level_exclusion_filter`'s own docstring --
    # a query known to carry mixed-level hits, filtered with the EXACT
    # string this module sends at PG, leaves only the genuinely clean two.
    parsed = civitai_meili.parse_meili_response(_PG_EXCLUDED_FIXTURE)
    assert parsed["ids"] == [2732316, 2614771]
    assert parsed["total"] == 2


def test_parse_meili_response_inclusion_leak_fixture_is_the_rejected_negative_contrast():
    # NEGATIVE contrast, never sent by this codebase -- proves an inclusion
    # filter would have let mixed-level model 1911956 (`nsfwLevel`
    # `[1, 2, 4]`) through, which the exclusion filter above correctly drops.
    parsed = civitai_meili.parse_meili_response(_INCLUSION_LEAK_FIXTURE)
    assert 1911956 in parsed["ids"]
    assert len(parsed["ids"]) == 20  # `estimatedTotalHits` is 21 -- one more sits on page 2
    assert parsed["total"] == 21


def test_parse_meili_response_malformed_shapes_never_raise():
    for bad in (None, {}, {"results": []}, {"results": "not-a-list"}, {"results": [None]}, {"results": [{"hits": "nope"}]}, 42, "x"):
        assert civitai_meili.parse_meili_response(bad) == {"ids": [], "total": None}


def test_parse_meili_response_drops_non_integer_hit_ids_and_boolean_total():
    raw = {"results": [{"hits": [{"id": 1}, {"id": "two"}, {"id": True}, "not-a-dict"], "estimatedTotalHits": True}]}
    parsed = civitai_meili.parse_meili_response(raw)
    assert parsed["ids"] == [1]
    assert parsed["total"] is None  # a bool is never a valid total


# ---------------------------------------------------------------------------
# The opaque offset cursor.
# ---------------------------------------------------------------------------


def test_meili_cursor_round_trips():
    for offset in (0, 20, 40, 12345):
        assert civitai_meili.decode_meili_cursor(civitai_meili.encode_meili_cursor(offset)) == offset


def test_meili_cursor_decode_none_for_no_cursor_or_a_foreign_one():
    assert civitai_meili.decode_meili_cursor(None) is None
    assert civitai_meili.decode_meili_cursor("") is None
    assert civitai_meili.decode_meili_cursor("some-opaque-rest-cursor-xyz") is None
    assert civitai_meili.decode_meili_cursor("meili_offset:not-a-number") is None
    assert civitai_meili.decode_meili_cursor(42) is None


# ---------------------------------------------------------------------------
# ids_are_subset / reorder_by_ids -- rules 2/3/4 of the two-call design.
# ---------------------------------------------------------------------------


def test_ids_are_subset_true_when_every_returned_id_was_requested():
    assert civitai_meili.ids_are_subset([1, 2], [1, 2, 3]) is True
    assert civitai_meili.ids_are_subset([], [1, 2, 3]) is True  # vacuously true -- rule 3's territory, not 4's


def test_ids_are_subset_rejects_a_fabricated_foreign_id():
    # The exact failure mode the design doc warns about: Civitai's own
    # documented 0-hit REST fallback answering with unrelated "popular"
    # model ids that were never in the `ids=` request at all.
    assert civitai_meili.ids_are_subset([1, 2, 999999], [1, 2, 3]) is False


def test_reorder_by_ids_restores_meilis_order_from_a_shuffled_v1_response():
    parsed_v1 = civitai_search.parse_search_response(_V1_REHYDRATION_FIXTURE)
    reordered = civitai_meili.reorder_by_ids(parsed_v1["results"], _FOUR_IDS_IN_MEILI_RANK_ORDER)
    assert [r["model_id"] for r in reordered] == _FOUR_IDS_IN_MEILI_RANK_ORDER


def test_reorder_by_ids_a_missing_id_drops_one_card_and_keeps_the_rest():
    parsed_v1 = civitai_search.parse_search_response(_V1_REHYDRATION_FIXTURE)
    id_order_with_a_gap = [1443103, 999999999, 2650553, 1978701]  # 999999999 never resolved
    reordered = civitai_meili.reorder_by_ids(parsed_v1["results"], id_order_with_a_gap)
    assert [r["model_id"] for r in reordered] == [1443103, 2650553, 1978701]


# ---------------------------------------------------------------------------
# civitai_search.build_ids_search_url / search_models_by_ids.
# ---------------------------------------------------------------------------


def test_build_ids_search_url_encoded_query_string_never_comma_joined():
    # Pin the LITERAL encoded query string -- exactly where the last
    # multi-value contract broke on the REST path (`types`, comma-joined,
    # silently doing nothing with both sides green).
    url = civitai_search.build_ids_search_url("civitai.com", [1, 2, 3])
    assert url == "https://civitai.com/api/v1/models?ids=1&ids=2&ids=3&nsfw=true"


def test_build_ids_search_url_nsfw_true_is_unconditional_not_a_parameter():
    # There is no way to ask this function for `nsfw=false` -- rule 1 of the
    # two-call design ("mandatory, or adult models vanish with no error").
    url = civitai_search.build_ids_search_url("civitai.com", [1])
    assert "nsfw=true" in url


def test_build_ids_search_url_limit_is_appended_and_clamped_when_given():
    url = civitai_search.build_ids_search_url("civitai.com", [1, 2], limit=999)
    assert url.endswith(f"&limit={civitai_search._MAX_LIMIT}")
    assert civitai_search.build_ids_search_url("civitai.com", [1], limit=None).count("limit=") == 0


def test_build_ids_search_url_empty_or_non_integer_ids_returns_none():
    assert civitai_search.build_ids_search_url("civitai.com", []) is None
    assert civitai_search.build_ids_search_url("civitai.com", None) is None
    assert civitai_search.build_ids_search_url("civitai.com", ["not-an-int"]) is None
    # A mix keeps only the real ints -- never forwards a bad entry raw.
    url = civitai_search.build_ids_search_url("civitai.com", [1, "bad", 2, True])
    assert url == "https://civitai.com/api/v1/models?ids=1&ids=2&nsfw=true"


class _FakeHttpResponse:
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


def test_search_models_by_ids_success_parses_via_the_unchanged_parser():
    import json as _json
    body = _json.dumps(_V1_REHYDRATION_FIXTURE).encode("utf-8")

    def opener(url, timeout):
        assert "ids=2650553" in url and "nsfw=true" in url
        return _FakeHttpResponse(body)

    result = civitai_search.search_models_by_ids([2650553, 1978701, 2108608, 1443103], opener=opener)
    assert result["reason"] == "found"
    parsed = civitai_search.parse_search_response(result["data"])
    assert {r["model_id"] for r in parsed["results"]} == {2650553, 1978701, 2108608, 1443103}


def test_search_models_by_ids_empty_ids_never_touches_the_network():
    calls = []

    def opener(url, timeout):
        calls.append(url)
        raise AssertionError("must never be called for an empty ids list")

    result = civitai_search.search_models_by_ids([], opener=opener)
    assert result["reason"] == "offline"
    assert calls == []


def test_search_models_by_ids_404_folds_into_offline_unknown():
    def opener(url, timeout):
        raise urllib.error.HTTPError(url, 404, "Not Found", None, None)

    result = civitai_search.search_models_by_ids([1], opener=opener)
    assert result["reason"] == "offline"
    assert result["offline_reason"] == "unknown"


def test_search_models_by_ids_api_key_rides_as_token_param():
    seen_urls = []

    def opener(url, timeout):
        seen_urls.append(url)
        raise urllib.error.HTTPError(url, 500, "err", None, None)

    civitai_search.search_models_by_ids([1], api_key="secret123", opener=opener, hosts=("civitai.com",))
    assert "token=secret123" in seen_urls[0]


def test_search_models_by_ids_api_key_never_appears_in_a_debug_log_line():
    # 🔒 The ids= re-hydration call (this task's step 2) builds the SAME
    # `?token=...`-carrying URL `search_models` already does, through the
    # SAME `fetch_json_with_host_fallback` transport -- so it must get the
    # SAME redaction, not a second copy of the discipline. Verified
    # DIRECTLY here rather than only inherited via test_model_browser_logs
    # .py's existing REST-path assertion, since this is a genuinely new
    # call site for that transport.
    restore_level = _with_debug_level()
    records, restore_logs = _capture_logs()

    def opener(url, timeout):
        raise urllib.error.HTTPError(url, 500, "err", None, None)

    try:
        civitai_search.search_models_by_ids([1, 2], api_key="totally-secret-key-xyz", opener=opener)
        assert records  # sanity: the debug path really did log something
        for message in records:
            assert "totally-secret-key-xyz" not in message, message
    finally:
        restore_logs()
        restore_level()


# ---------------------------------------------------------------------------
# civitai_meili._post_meili / two_call_search -- fake openers, no network.
# ---------------------------------------------------------------------------


def _meili_opener_returning(raw):
    import json as _json
    body = _json.dumps(raw).encode("utf-8")

    def opener(payload, timeout):
        return _FakeHttpResponse(body)

    return opener


def _meili_opener_raising(exc_factory):
    def opener(payload, timeout):
        raise exc_factory()

    return opener


def _ids_opener_returning(raw):
    import json as _json
    body = _json.dumps(raw).encode("utf-8")

    def opener(url, timeout):
        return _FakeHttpResponse(body)

    return opener


def test_two_call_search_happy_path_reorders_and_reports_total():
    result = civitai_meili.two_call_search(
        "loras", "edit", base_model=["Anima"], limit=4,
        meili_opener=_meili_opener_returning({
            "results": [{
                "hits": [{"id": i} for i in _FOUR_IDS_IN_MEILI_RANK_ORDER],
                "estimatedTotalHits": 4,
            }],
        }),
        ids_opener=_ids_opener_returning(_V1_REHYDRATION_FIXTURE),
    )
    assert result["reason"] == "ok"
    assert [r["model_id"] for r in result["results"]] == _FOUR_IDS_IN_MEILI_RANK_ORDER
    assert result["total"] == 4
    assert result["next_cursor"] is None  # offset(0) + limit(4) == total(4) -- no more pages


def test_two_call_search_more_pages_encodes_the_next_offset():
    result = civitai_meili.two_call_search(
        "loras", "edit", limit=2,
        meili_opener=_meili_opener_returning({
            "results": [{"hits": [{"id": 1443103}, {"id": 2650553}], "estimatedTotalHits": 49}],
        }),
        ids_opener=_ids_opener_returning({"items": [item for item in _V1_REHYDRATION_FIXTURE["items"] if item["id"] in (1443103, 2650553)]}),
    )
    assert result["reason"] == "ok"
    assert result["next_cursor"] == civitai_meili.encode_meili_cursor(2)


def test_two_call_search_step1_failure_is_meili_unavailable_never_offline():
    result = civitai_meili.two_call_search(
        "loras", "x", meili_opener=_meili_opener_raising(lambda: TimeoutError()),
    )
    assert result["reason"] == "meili_unavailable"
    assert result["offline_reason"] == "timeout"


def test_two_call_search_empty_meili_hits_short_circuits_before_any_ids_call():
    def must_not_be_called(url, timeout):
        raise AssertionError("step 2 must never run for zero Meili hits")

    result = civitai_meili.two_call_search(
        "loras", "x",
        meili_opener=_meili_opener_returning({"results": [{"hits": [], "estimatedTotalHits": 0}]}),
        ids_opener=must_not_be_called,
    )
    assert result == {"reason": "ok", "results": [], "next_cursor": None, "total": 0}


def test_two_call_search_step2_failure_after_step1_success_is_offline_not_a_fallback():
    def failing_ids_opener(url, timeout):
        raise urllib.error.HTTPError(url, 500, "err", None, None)

    result = civitai_meili.two_call_search(
        "loras", "x",
        meili_opener=_meili_opener_returning({"results": [{"hits": [{"id": 1}], "estimatedTotalHits": 1}]}),
        ids_opener=failing_ids_opener,
    )
    assert result["reason"] == "offline"
    assert result["results"] == []
    assert result["total"] is None


def test_two_call_search_subset_violation_is_offline_with_no_results():
    # v1 answers with an id that was NEVER in the Meili-discovered set --
    # the exact shape of Civitai's own documented 0-hit REST fallback.
    result = civitai_meili.two_call_search(
        "loras", "x",
        meili_opener=_meili_opener_returning({"results": [{"hits": [{"id": 1}], "estimatedTotalHits": 1}]}),
        ids_opener=_ids_opener_returning({
            "items": [{
                "id": 999999, "name": "Foreign", "type": "LORA",
                "modelVersions": [{"id": 1, "baseModel": "SDXL", "files": [{"name": "a.safetensors", "downloadUrl": "https://civitai.com/a", "primary": True}]}],
            }],
        }),
    )
    assert result["reason"] == "offline"
    assert result["results"] == []


def test_two_call_search_a_gap_drops_one_card_and_still_succeeds():
    result = civitai_meili.two_call_search(
        "loras", "x", limit=2,
        meili_opener=_meili_opener_returning({
            "results": [{"hits": [{"id": 1443103}, {"id": 999999999}], "estimatedTotalHits": 2}],
        }),
        # v1 only resolves 1443103 -- 999999999 is a genuine gap, not a
        # subset violation (it's simply absent from the response, not a
        # FOREIGN id present in it).
        ids_opener=_ids_opener_returning({"items": [item for item in _V1_REHYDRATION_FIXTURE["items"] if item["id"] == 1443103]}),
    )
    assert result["reason"] == "ok"
    assert [r["model_id"] for r in result["results"]] == [1443103]


def test_two_call_search_cursor_decodes_to_the_requested_offset():
    seen_payloads = []

    def opener(payload, timeout):
        seen_payloads.append(payload)
        import json as _json
        return _FakeHttpResponse(_json.dumps({"results": [{"hits": [], "estimatedTotalHits": 0}]}).encode("utf-8"))

    civitai_meili.two_call_search("loras", "x", cursor=civitai_meili.encode_meili_cursor(40), meili_opener=opener)
    assert seen_payloads[0]["queries"][0]["offset"] == 40


# ---------------------------------------------------------------------------
# `api.py`'s `search_impl` -- choosing between the Meili default and the
# REST fallback, and the new `total` field.
# ---------------------------------------------------------------------------


def test_search_impl_uses_meili_by_default_and_reports_total():
    restore_limiter = _install_permissive_search_limiter()
    previous_two_call = mb_api.civitai_meili.two_call_search

    def fake_two_call_search(kind, query, **kwargs):
        return {
            "reason": "ok",
            "results": civitai_search.parse_search_response({
                "items": [{
                    "id": 1, "name": "X", "type": "LORA",
                    "modelVersions": [{"id": 10, "baseModel": "Anima",
                                       "files": [{"name": "x.safetensors", "downloadUrl": "https://civitai.com/x", "primary": True}]}],
                }],
            })["results"],
            "next_cursor": civitai_meili.encode_meili_cursor(20),
            "total": 137,
        }

    mb_api.civitai_meili.two_call_search = fake_two_call_search
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "x"})
            assert result["reason"] == "ok"
            assert result["total"] == 137
            assert result["next_cursor"] == civitai_meili.encode_meili_cursor(20)
            assert result["results"][0]["kind"] == "loras"  # `_annotate_search_results` still runs
            assert result["results"][0]["installed"] is False
        finally:
            restore_fp()
            mb_api.civitai_meili.two_call_search = previous_two_call
            restore_limiter()


def test_search_impl_falls_back_to_rest_when_meili_unavailable_and_total_is_none():
    restore_limiter = _install_permissive_search_limiter()
    previous_two_call = mb_api.civitai_meili.two_call_search
    previous_search_models = mb_api.civitai_search.search_models
    rest_calls = []

    def fake_two_call_search(kind, query, **kwargs):
        return {"reason": "meili_unavailable", "message": "Cloudflare blocked it.", "offline_reason": "forbidden"}

    def fake_search_models(kind, query, **kwargs):
        rest_calls.append((kind, query, kwargs))
        return {
            "reason": "found", "offline_reason": None, "message": "",
            "data": {"items": [{
                "id": 1, "name": "X", "type": "LORA",
                "modelVersions": [{"id": 10, "baseModel": "SDXL",
                                   "files": [{"name": "x.safetensors", "downloadUrl": "https://civitai.com/x", "primary": True}]}],
            }], "metadata": {"nextCursor": "rest-cursor"}},
        }

    mb_api.civitai_meili.two_call_search = fake_two_call_search
    mb_api.civitai_search.search_models = fake_search_models
    with tempfile.TemporaryDirectory() as tmp:
        loras_root = os.path.join(tmp, "loras")
        os.makedirs(loras_root)
        restore_fp = _install_fake_folder_paths(roots_by_folder={"loras": [loras_root]}, names_by_folder={"loras": []})
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "x"})
            assert result["reason"] == "ok"
            assert result["total"] is None  # REST cannot produce one
            assert result["next_cursor"] == "rest-cursor"
            assert len(rest_calls) == 1  # the fallback really did reach civitai_search.search_models
        finally:
            restore_fp()
            mb_api.civitai_search.search_models = previous_search_models
            mb_api.civitai_meili.two_call_search = previous_two_call
            restore_limiter()


def test_search_impl_meili_offline_after_success_never_falls_back_to_rest():
    restore_limiter = _install_permissive_search_limiter()
    previous_two_call = mb_api.civitai_meili.two_call_search
    previous_search_models = mb_api.civitai_search.search_models

    def fake_two_call_search(kind, query, **kwargs):
        return {
            "reason": "offline", "offline_reason": "unknown",
            "message": "Civitai returned unexpected results for this page -- try again.",
            "results": [], "next_cursor": None, "total": None,
        }

    def must_not_be_called(kind, query, **kwargs):
        raise AssertionError("a step-2 failure after Meili success must NOT fall back to REST")

    mb_api.civitai_meili.two_call_search = fake_two_call_search
    mb_api.civitai_search.search_models = must_not_be_called
    try:
        result = mb_api.search_impl({"kind": "loras", "query": "x"})
        assert result["reason"] == "offline"
        assert result["offline_reason"] == "unknown"
        assert result["total"] is None
        assert result["results"] == []
    finally:
        mb_api.civitai_search.search_models = previous_search_models
        mb_api.civitai_meili.two_call_search = previous_two_call
        restore_limiter()


def test_search_impl_invalid_kind_and_rate_limited_never_reach_two_call_search():
    def must_not_be_called(*a, **kw):
        raise AssertionError("must not be reached before the whitelist/rate-limit checks")

    previous_two_call = mb_api.civitai_meili.two_call_search
    mb_api.civitai_meili.two_call_search = must_not_be_called
    try:
        result = mb_api.search_impl({"kind": "../../etc", "query": "x"})
        assert result["reason"] == "invalid_kind"
        assert result["total"] is None

        previous_limiter = mb_api._SEARCH_LIMITER
        denying_limiter = rate_limit.MinIntervalLimiter(1000.0)
        denying_limiter.allow()
        mb_api._SEARCH_LIMITER = denying_limiter
        try:
            result = mb_api.search_impl({"kind": "loras", "query": "x"})
            assert result["reason"] == "rate_limited"
            assert result["total"] is None
        finally:
            mb_api._SEARCH_LIMITER = previous_limiter
    finally:
        mb_api.civitai_meili.two_call_search = previous_two_call


def test_search_impl_passes_the_resolved_api_key_into_two_call_search():
    restore_limiter = _install_permissive_search_limiter()
    previous_two_call = mb_api.civitai_meili.two_call_search
    previous_resolve = mb_api.keys.resolve_api_key
    seen_kwargs = []

    def fake_two_call_search(kind, query, **kwargs):
        seen_kwargs.append(kwargs)
        return {"reason": "ok", "results": [], "next_cursor": None, "total": 0}

    mb_api.civitai_meili.two_call_search = fake_two_call_search
    mb_api.keys.resolve_api_key = lambda **kw: mb_api.keys.ResolvedKey("secret-key", "setting")
    try:
        mb_api.search_impl({"kind": "loras", "query": "x"})
        assert seen_kwargs[-1]["api_key"] == "secret-key"
    finally:
        mb_api.keys.resolve_api_key = previous_resolve
        mb_api.civitai_meili.two_call_search = previous_two_call
        restore_limiter()


ALL_TESTS = [
    test_level_exclusion_filter_pg_matches_the_live_verified_string,
    test_level_exclusion_filter_every_level_excludes_everything_above_it,
    test_level_exclusion_filter_garbage_falls_back_to_pg,
    test_period_filter_each_period_maps_to_the_epoch_it_claims,
    test_period_filter_all_time_is_no_filter_at_all,
    test_period_filter_garbage_falls_back_to_the_default_period,
    test_sort_value_relevancy_sends_no_sort_key_every_other_value_maps,
    test_sort_value_garbage_falls_back_to_the_default_sort,
    test_build_meili_filter_groups_a_given_kind_locks_the_type_group,
    test_build_meili_filter_groups_no_kind_validates_the_types_list,
    test_build_meili_filter_groups_no_kind_and_no_types_omits_the_type_group_entirely,
    test_build_meili_filter_groups_base_model_is_an_or_group_never_comma_joined,
    test_build_meili_filter_groups_all_time_period_appends_no_period_group,
    test_build_meili_payload_full_shape_kind_scoped_relevancy_omits_sort,
    test_build_meili_payload_a_non_relevancy_sort_sends_exactly_one_value_in_a_list,
    test_build_meili_payload_falsy_query_becomes_an_explicit_empty_string,
    test_build_meili_payload_limit_is_clamped_and_offset_never_negative,
    test_build_meili_payload_encoded_wire_body_never_comma_joins_a_multi_value_filter,
    test_parse_meili_response_ids_come_back_in_rank_order_with_the_real_total,
    test_parse_meili_response_pg_excluded_fixture_keeps_only_the_two_clean_ids,
    test_parse_meili_response_inclusion_leak_fixture_is_the_rejected_negative_contrast,
    test_parse_meili_response_malformed_shapes_never_raise,
    test_parse_meili_response_drops_non_integer_hit_ids_and_boolean_total,
    test_meili_cursor_round_trips,
    test_meili_cursor_decode_none_for_no_cursor_or_a_foreign_one,
    test_ids_are_subset_true_when_every_returned_id_was_requested,
    test_ids_are_subset_rejects_a_fabricated_foreign_id,
    test_reorder_by_ids_restores_meilis_order_from_a_shuffled_v1_response,
    test_reorder_by_ids_a_missing_id_drops_one_card_and_keeps_the_rest,
    test_build_ids_search_url_encoded_query_string_never_comma_joined,
    test_build_ids_search_url_nsfw_true_is_unconditional_not_a_parameter,
    test_build_ids_search_url_limit_is_appended_and_clamped_when_given,
    test_build_ids_search_url_empty_or_non_integer_ids_returns_none,
    test_search_models_by_ids_success_parses_via_the_unchanged_parser,
    test_search_models_by_ids_empty_ids_never_touches_the_network,
    test_search_models_by_ids_404_folds_into_offline_unknown,
    test_search_models_by_ids_api_key_rides_as_token_param,
    test_search_models_by_ids_api_key_never_appears_in_a_debug_log_line,
    test_two_call_search_happy_path_reorders_and_reports_total,
    test_two_call_search_more_pages_encodes_the_next_offset,
    test_two_call_search_step1_failure_is_meili_unavailable_never_offline,
    test_two_call_search_empty_meili_hits_short_circuits_before_any_ids_call,
    test_two_call_search_step2_failure_after_step1_success_is_offline_not_a_fallback,
    test_two_call_search_subset_violation_is_offline_with_no_results,
    test_two_call_search_a_gap_drops_one_card_and_still_succeeds,
    test_two_call_search_cursor_decodes_to_the_requested_offset,
    test_search_impl_uses_meili_by_default_and_reports_total,
    test_search_impl_falls_back_to_rest_when_meili_unavailable_and_total_is_none,
    test_search_impl_meili_offline_after_success_never_falls_back_to_rest,
    test_search_impl_invalid_kind_and_rate_limited_never_reach_two_call_search,
    test_search_impl_passes_the_resolved_api_key_into_two_call_search,
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
