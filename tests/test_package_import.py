"""Regression guard: the pack must import the way ComfyUI actually imports
custom-node packs -- as a PACKAGE, from its PARENT directory, with the repo
root itself NOT on `sys.path`.

Every other `test_*.py` in this repo puts the repo root on `sys.path`
(`sys.path.insert(0, <repo root>)`), which is exactly the condition that
masks a bare `import core`/`import nodes`/etc. from crashing: those bare
imports only resolve because the repo root happens to be importable in the
test context, NOT because the import is actually correct for how ComfyUI
loads this pack. ComfyUI only ever puts `custom_nodes/` (this pack's PARENT
dir) on `sys.path`, then imports the pack folder itself as a package -- the
repo root is never reachable as a bare top-level import target.

This test reproduces that real-ComfyUI condition in an isolated subprocess
(so the parent process's own `sys.path.insert(0, <repo root>)` calls made by
sibling test modules can never leak in and mask a regression), imports the
pack via `importlib.import_module(<pack dir name>)`, and asserts the
mappings contract holds. If a bare `import core` (or similar) is ever
reintroduced anywhere on the pack's eager import chain, this test goes red
with a `ModuleNotFoundError` even though every other plain-script test in
this repo stays green.

Run directly: `python tests/test_package_import.py` (no pytest, per project
convention).
"""
from __future__ import annotations

import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK_PARENT_DIR = os.path.dirname(REPO_ROOT)
PACK_NAME = os.path.basename(REPO_ROOT)

# The subprocess script below is deliberately minimal and self-contained: it
# must NOT inherit anything from this test module's own `sys.path` (which
# other test files mutate), so it runs as a fresh `python3 -c ...` process
# with an explicit, minimal `sys.path` of its own.
_SUBPROCESS_SCRIPT = f"""
import sys
sys.path = [{PACK_PARENT_DIR!r}] + [p for p in sys.path if p not in ({REPO_ROOT!r}, "", {PACK_PARENT_DIR!r})]
assert {REPO_ROOT!r} not in sys.path, "repo root leaked onto sys.path"

import importlib
m = importlib.import_module({PACK_NAME!r})

assert m.NODE_CLASS_MAPPINGS, "NODE_CLASS_MAPPINGS is empty"
assert set(m.NODE_CLASS_MAPPINGS) == set(m.NODE_DISPLAY_NAME_MAPPINGS), (
    "NODE_CLASS_MAPPINGS and NODE_DISPLAY_NAME_MAPPINGS key sets differ"
)

print("NODE_COUNT", len(m.NODE_CLASS_MAPPINGS))
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


def test_package_imports_cleanly_as_comfyui_would_load_it():
    result = _run_subprocess_import()
    assert result.returncode == 0, (
        f"package import failed (as ComfyUI would load it, repo root NOT on "
        f"sys.path):\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "SUBPROCESS_OK" in result.stdout, (
        f"subprocess did not report success:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


def test_package_reports_a_nonzero_node_count():
    result = _run_subprocess_import()
    assert result.returncode == 0, f"import failed:\n{result.stderr}"
    lines = [line for line in result.stdout.splitlines() if line.startswith("NODE_COUNT")]
    assert lines, f"NODE_COUNT line missing from subprocess stdout:\n{result.stdout}"
    count = int(lines[0].split()[1])
    assert count > 0, "NODE_CLASS_MAPPINGS reported as empty"


ALL_TESTS = [
    test_package_imports_cleanly_as_comfyui_would_load_it,
    test_package_reports_a_nonzero_node_count,
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
