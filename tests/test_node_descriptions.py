"""Regression guard: every node class registered in `NODE_CLASS_MAPPINGS`
carries a non-empty `DESCRIPTION` (ComfyUI renders this under the node's name
in the picker -- `AnimaLoraLoader` had one, the other seven registered nodes
didn't, so a future node landing without one would go unnoticed the same way).

Also guards `DESCRIPTION`'s FIRST SENTENCE against ComfyUI's picker, which
truncates the description at roughly 90 characters -- mid-word, with no
ellipsis. Five descriptions (106-129 chars) shipped past that limit and were
only caught by eyeballing a screenshot, which is exactly the kind of thing a
green suite should have flagged on its own. `_first_sentence` below picks the
FIRST `.`/`!`/`?` that is followed by whitespace-then-a-capital-letter (or by
the end of the string) as the sentence boundary -- not a naive
`text.split(".")[0]`, which breaks on "0.80" (mid-number) and "e.g." (an
abbreviation, lowercase after the dot) alike, both of which appear in this
pack's own DESCRIPTION strings.

Reuses `test_package_import.py`'s own subprocess-import trick (repro'd here
rather than imported, to keep this file runnable standalone): ComfyUI only
ever puts this pack's PARENT directory on `sys.path` and imports the pack
itself as a package, so `NODE_CLASS_MAPPINGS` is read the same way here,
in an isolated subprocess, rather than via a hand-copied local dict that
could drift from `__init__.py`'s real mapping.

Run directly: `python tests/test_node_descriptions.py` (no pytest, per
project convention).
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK_PARENT_DIR = os.path.dirname(REPO_ROOT)
PACK_NAME = os.path.basename(REPO_ROOT)

# ComfyUI's picker truncation is observed at "roughly 90 characters" (owner's
# own screenshot) -- this is a defensive proxy for that, not a promise the
# real cutoff is exactly this value (it's pixel-width, proportional-font
# based, so it varies with which letters are in play). Comfortable margin,
# not a hairline.
MAX_FIRST_SENTENCE_LENGTH = 90

# A sentence boundary is a `.`/`!`/`?` followed by whitespace and a capital
# letter, or by the end of the string. Deliberately NOT `text.split(".")[0]`:
# that breaks on a mid-number decimal ("0.80") and on an abbreviation ("e.g.
# a natural-language encoder"), both of which appear in this pack's own
# DESCRIPTION strings -- a naive split would report a false, tiny "first
# sentence" for either.
_SENTENCE_END_RE = re.compile(r"^(.*?[.!?])(\s+[A-Z]|$)")


def _first_sentence(description: str) -> str:
    match = _SENTENCE_END_RE.search(description)
    return match.group(1) if match else description


# Deliberately minimal and self-contained (same reasoning as
# `test_package_import.py`'s own script): a fresh `python3 -c ...` process
# with an explicit, minimal `sys.path`, so this doesn't inherit the repo
# root from this test module's own sibling `sys.path.insert(...)` calls.
_SUBPROCESS_SCRIPT = f"""
import sys
sys.path = [{PACK_PARENT_DIR!r}] + [p for p in sys.path if p not in ({REPO_ROOT!r}, "", {PACK_PARENT_DIR!r})]
assert {REPO_ROOT!r} not in sys.path, "repo root leaked onto sys.path"

import importlib
m = importlib.import_module({PACK_NAME!r})

for name, cls in sorted(m.NODE_CLASS_MAPPINGS.items()):
    description = getattr(cls, "DESCRIPTION", None)
    ok = isinstance(description, str) and description.strip() != ""
    print(f"DESC {{name}} {{'OK' if ok else 'MISSING'}}")
    if ok:
        # repr() so a single-line, unambiguously re-parseable (via
        # ast.literal_eval) form survives the subprocess's stdout pipe
        # regardless of quotes/dashes/etc. in the description text itself.
        print(f"DESC_TEXT {{name}} {{description!r}}")

print("SUBPROCESS_OK")
"""


def _run_subprocess_import():
    return subprocess.run(
        [sys.executable, "-c", _SUBPROCESS_SCRIPT],
        cwd=PACK_PARENT_DIR,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _description_status_lines(stdout: str) -> dict:
    statuses = {}
    for line in stdout.splitlines():
        if line.startswith("DESC "):
            _, name, status = line.split(maxsplit=2)
            statuses[name] = status
    return statuses


def _description_texts(stdout: str) -> dict:
    import ast

    texts = {}
    for line in stdout.splitlines():
        if line.startswith("DESC_TEXT "):
            _, name, literal = line.split(maxsplit=2)
            texts[name] = ast.literal_eval(literal)
    return texts


def test_subprocess_import_succeeds():
    result = _run_subprocess_import()
    assert result.returncode == 0, (
        f"package import failed:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "SUBPROCESS_OK" in result.stdout, (
        f"subprocess did not report success:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


def test_every_registered_node_has_a_description():
    result = _run_subprocess_import()
    assert result.returncode == 0, f"import failed:\n{result.stderr}"
    statuses = _description_status_lines(result.stdout)
    assert statuses, f"no DESC lines found in subprocess stdout:\n{result.stdout}"
    missing = [name for name, status in statuses.items() if status != "OK"]
    assert not missing, f"node classes with no (or empty) DESCRIPTION: {missing}"


def test_at_least_the_known_eight_nodes_were_checked():
    # Guards against the subprocess silently reporting zero/fewer nodes
    # (e.g. a broken import that still exits 0) masking the real assertion
    # above -- mirrors `test_package_import.py`'s own nonzero-count check.
    result = _run_subprocess_import()
    assert result.returncode == 0, f"import failed:\n{result.stderr}"
    statuses = _description_status_lines(result.stdout)
    expected = {
        "PromptRulesText", "PromptRulesClip",
        "AnimaControlPanel", "AnimaLoaderPanel", "AnimaLoraLoader",
        "AnimaContextBridge", "AnimaGenerator", "AnimaPreview",
    }
    assert expected.issubset(statuses), (
        f"expected node set missing from mapping: {expected - set(statuses)}"
    )


def test_first_sentence_split_survives_decimals_and_abbreviations():
    # The exact pitfalls a naive `text.split(".")[0]` falls into (see module
    # docstring): a mid-number decimal, and a lowercase abbreviation, must
    # NOT be mistaken for a sentence boundary.
    assert _first_sentence("The default strength is 0.80. Tune it per LoRA.") == (
        "The default strength is 0.80."
    )
    assert _first_sentence("Ahead of it, e.g. a natural-language encoder. Wire it there.") == (
        "Ahead of it, e.g. a natural-language encoder."
    )
    # A description with no second sentence at all -- falls back to the
    # whole (short) string via the `$` branch of `_SENTENCE_END_RE`.
    assert _first_sentence("Stack as many LoRAs as you want in one node.") == (
        "Stack as many LoRAs as you want in one node."
    )


def test_every_description_first_sentence_fits_the_picker():
    # The property that actually matters (see module docstring): a
    # DESCRIPTION whose first sentence is too long truncates mid-word in
    # ComfyUI's picker, which is exactly what slipped through before this
    # test existed.
    result = _run_subprocess_import()
    assert result.returncode == 0, f"import failed:\n{result.stderr}"
    texts = _description_texts(result.stdout)
    assert texts, f"no DESC_TEXT lines found in subprocess stdout:\n{result.stdout}"
    too_long = {
        name: (len(_first_sentence(text)), _first_sentence(text))
        for name, text in texts.items()
        if len(_first_sentence(text)) >= MAX_FIRST_SENTENCE_LENGTH
    }
    assert not too_long, (
        f"DESCRIPTION first sentence(s) at/over {MAX_FIRST_SENTENCE_LENGTH} "
        f"chars (truncates mid-word in the picker): {too_long}"
    )


ALL_TESTS = [
    test_subprocess_import_succeeds,
    test_every_registered_node_has_a_description,
    test_at_least_the_known_eight_nodes_were_checked,
    test_first_sentence_split_survives_decimals_and_abbreviations,
    test_every_description_first_sentence_fits_the_picker,
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
