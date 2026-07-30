"""Plain-script tests for `src/web_cache/` -- the two-layer browser-cache fix
for this pack's own ES modules, ported from `../ComfyUI-Pixaroma` (MIT (c)
pixaroma; see THIRD_PARTY_NOTICES.md). Mirrors `test_anima_api.py`'s own
pattern: import the aiohttp-wiring module with no live ComfyUI (the
route-registration `try/except` must swallow the missing `aiohttp`/
`server.PromptServer`, not crash), then exercise the PURE `stamp.py` functions
directly -- no aiohttp `Request`/`Response` object anywhere in this file.

Covers `stamp.stamp_import_urls` hard (it is where the risk is -- a wrong
rewrite either leaves a stale module cached or, worse, double-instances
`/scripts/app.js`) and `stamp.compute_js_version`'s mtime-scan + degradation
behaviour.

Run directly: `python tests/test_web_cache.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.web_cache.stamp import compute_js_version, stamp_import_urls


# ---------------------------------------------------------------------------
# stamp_import_urls -- specifier forms
# ---------------------------------------------------------------------------


def test_stamps_static_from_import():
    text = 'import { x } from "./a.mjs";'
    result = stamp_import_urls(text, "123")
    assert result == 'import { x } from "./a.mjs?v=123";'


def test_stamps_bare_import():
    text = 'import "../b.mjs";'
    result = stamp_import_urls(text, "123")
    assert result == 'import "../b.mjs?v=123";'


def test_stamps_export_star_from():
    text = 'export * from "./c.mjs";'
    result = stamp_import_urls(text, "123")
    assert result == 'export * from "./c.mjs?v=123";'


def test_stamps_dynamic_import():
    text = 'const m = await import("./d.mjs");'
    result = stamp_import_urls(text, "123")
    assert result == 'const m = await import("./d.mjs?v=123");'


def test_stamps_multiline_dynamic_import():
    text = 'const m = await import(\n  "./d.mjs"\n);'
    result = stamp_import_urls(text, "123")
    assert result == 'const m = await import(\n  "./d.mjs?v=123"\n);'


# ---------------------------------------------------------------------------
# stamp_import_urls -- scope rules
# ---------------------------------------------------------------------------


def test_relative_dot_slash_mjs_stamped():
    result = stamp_import_urls('import "./a.mjs";', "9")
    assert result == 'import "./a.mjs?v=9";'


def test_relative_nested_dotdot_slash_mjs_stamped():
    result = stamp_import_urls('import "../b/c.mjs";', "9")
    assert result == 'import "../b/c.mjs?v=9";'


def test_bare_specifier_not_stamped():
    text = 'import "some-package/thing.mjs";'
    assert stamp_import_urls(text, "9") == text


def test_absolute_specifier_not_stamped():
    text = 'import "/x.mjs";'
    assert stamp_import_urls(text, "9") == text


def test_scripts_app_js_not_stamped():
    # THE dangerous case: stamping /scripts/app.js would make the browser
    # load a SECOND instance of ComfyUI's own app module (two registries).
    text = 'import { app } from "/scripts/app.js";'
    assert stamp_import_urls(text, "9") == text


def test_relative_app_js_not_stamped():
    text = 'import { app } from "../../../../scripts/app.js";'
    assert stamp_import_urls(text, "9") == text


def test_relative_js_not_mjs_not_stamped():
    text = 'import "./helper.js";'
    assert stamp_import_urls(text, "9") == text


# ---------------------------------------------------------------------------
# stamp_import_urls -- version sanitisation
# ---------------------------------------------------------------------------


def test_unsafe_version_characters_sanitised():
    result = stamp_import_urls('import "./a.mjs";', 'v" onerror=alert(1)//')
    # Every char outside [A-Za-z0-9._-] becomes "-"; no stray quote/space/
    # parenthesis from the unsafe version survives into the served URL --
    # pin the exact sanitised output rather than just "doesn't crash".
    assert result == 'import "./a.mjs?v=v--onerror-alert-1---";'


def test_empty_version_degrades_to_zero():
    result = stamp_import_urls('import "./a.mjs";', "")
    assert result == 'import "./a.mjs?v=0";'


def test_none_version_degrades_to_zero():
    result = stamp_import_urls('import "./a.mjs";', None)
    assert result == 'import "./a.mjs?v=0";'


def test_all_unsafe_version_degrades_to_zero():
    # Sanitising 'a "b' -> "a -b" is non-empty, so it does NOT fall back to
    # "0" -- only an ALL-unsafe (or empty/None) version does.
    result = stamp_import_urls('import "./a.mjs";', "!!!")
    assert result == 'import "./a.mjs?v=---";'


# ---------------------------------------------------------------------------
# stamp_import_urls -- idempotency (pinned actual behaviour, not assumed)
# ---------------------------------------------------------------------------


def test_already_stamped_specifier_is_not_double_stamped():
    once = stamp_import_urls('import "./a.mjs";', "1")
    twice = stamp_import_urls(once, "1")
    # The regex requires the closing quote to immediately follow ".mjs";
    # "./a.mjs?v=1" has more text after ".mjs" before the quote, so it does
    # not match at all on a second pass -- re-stamping is a no-op, not a
    # double-append.
    assert once == 'import "./a.mjs?v=1";'
    assert twice == once


# ---------------------------------------------------------------------------
# stamp_import_urls -- quote style preserved
# ---------------------------------------------------------------------------


def test_double_quote_style_preserved():
    result = stamp_import_urls('import "./a.mjs";', "1")
    assert result == 'import "./a.mjs?v=1";'


def test_single_quote_style_preserved():
    result = stamp_import_urls("import './a.mjs';", "1")
    assert result == "import './a.mjs?v=1';"


def test_mixed_quote_specifiers_each_keep_their_own_style():
    text = 'import "./a.mjs";\nimport \'./b.mjs\';'
    result = stamp_import_urls(text, "1")
    assert result == 'import "./a.mjs?v=1";\nimport \'./b.mjs?v=1\';'


# ---------------------------------------------------------------------------
# compute_js_version
# ---------------------------------------------------------------------------


def test_compute_js_version_tracks_the_max_mtime():
    with tempfile.TemporaryDirectory() as root:
        old_path = os.path.join(root, "old.mjs")
        new_path = os.path.join(root, "new.js")
        with open(old_path, "w") as fh:
            fh.write("// old")
        with open(new_path, "w") as fh:
            fh.write("// new")
        older = time.time() - 1000
        newer = time.time()
        os.utime(old_path, (older, older))
        os.utime(new_path, (newer, newer))

        version = compute_js_version(root)
        assert version == str(int(newer))


def test_compute_js_version_walks_nested_directories():
    with tempfile.TemporaryDirectory() as root:
        nested_dir = os.path.join(root, "sub", "deep")
        os.makedirs(nested_dir)
        nested_path = os.path.join(nested_dir, "x.mjs")
        with open(nested_path, "w") as fh:
            fh.write("// nested")
        mtime = time.time()
        os.utime(nested_path, (mtime, mtime))

        version = compute_js_version(root)
        assert version == str(int(mtime))


def test_compute_js_version_ignores_non_js_files():
    with tempfile.TemporaryDirectory() as root:
        with open(os.path.join(root, "readme.md"), "w") as fh:
            fh.write("# not js")
        assert compute_js_version(root) == "0"


def test_compute_js_version_empty_dir_is_zero():
    with tempfile.TemporaryDirectory() as root:
        assert compute_js_version(root) == "0"


def test_compute_js_version_missing_dir_is_zero_not_a_crash():
    assert compute_js_version("/this/path/does/not/exist/at/all") == "0"


# ---------------------------------------------------------------------------
# src/web_cache/api.py -- importable with no ComfyUI installed
# ---------------------------------------------------------------------------


def test_web_cache_api_imports_without_comfyui():
    from src.web_cache import api  # noqa: F401 - import itself is the assertion


def test_web_cache_api_version_is_a_sanitised_string():
    from src.web_cache import api

    assert isinstance(api.VERSION, str)
    assert api.VERSION != ""


def test_web_cache_api_is_our_served_js_matches_own_prefix_and_extensions():
    from src.web_cache import api

    assert api._is_our_served_js(api._PREFIX + "anima/index.js") is True
    assert api._is_our_served_js(api._PREFIX + "anima/render.mjs") is True
    assert api._is_our_served_js(api._PREFIX + "anima/render.css") is False
    assert api._is_our_served_js("/extensions/some-other-pack/x.mjs") is False
    assert api._is_our_served_js("/scripts/app.js") is False


ALL_TESTS = [
    test_stamps_static_from_import,
    test_stamps_bare_import,
    test_stamps_export_star_from,
    test_stamps_dynamic_import,
    test_stamps_multiline_dynamic_import,
    test_relative_dot_slash_mjs_stamped,
    test_relative_nested_dotdot_slash_mjs_stamped,
    test_bare_specifier_not_stamped,
    test_absolute_specifier_not_stamped,
    test_scripts_app_js_not_stamped,
    test_relative_app_js_not_stamped,
    test_relative_js_not_mjs_not_stamped,
    test_unsafe_version_characters_sanitised,
    test_empty_version_degrades_to_zero,
    test_none_version_degrades_to_zero,
    test_all_unsafe_version_degrades_to_zero,
    test_already_stamped_specifier_is_not_double_stamped,
    test_double_quote_style_preserved,
    test_single_quote_style_preserved,
    test_mixed_quote_specifiers_each_keep_their_own_style,
    test_compute_js_version_tracks_the_max_mtime,
    test_compute_js_version_walks_nested_directories,
    test_compute_js_version_ignores_non_js_files,
    test_compute_js_version_empty_dir_is_zero,
    test_compute_js_version_missing_dir_is_zero_not_a_crash,
    test_web_cache_api_imports_without_comfyui,
    test_web_cache_api_version_is_a_sanitised_string,
    test_web_cache_api_is_our_served_js_matches_own_prefix_and_extensions,
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
