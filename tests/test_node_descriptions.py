"""Regression guard: every node class registered in `NODE_CLASS_MAPPINGS`
carries a non-empty `DESCRIPTION` (ComfyUI renders this under the node's name
in the picker -- `AnimaLoraLoader` had one, the other seven registered nodes
didn't, so a future node landing without one would go unnoticed the same way).

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
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK_PARENT_DIR = os.path.dirname(REPO_ROOT)
PACK_NAME = os.path.basename(REPO_ROOT)

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


ALL_TESTS = [
    test_subprocess_import_succeeds,
    test_every_registered_node_has_a_description,
    test_at_least_the_known_eight_nodes_were_checked,
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
