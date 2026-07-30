"""Regression guard: `EXPERIMENTAL` (ComfyUI's `[BETA]` badge) is pinned per
registered node, not left to drift.

Every node in `NODE_CLASS_MAPPINGS` is `EXPERIMENTAL = True` EXCEPT the
explicit `GRADUATED` allow-list below. `AnimaLoaderPanel` graduated 2026-07-30
(the attribute was removed outright -- ComfyUI treats a missing attribute the
same as falsy, and an absent attribute is the cleaner statement than
`EXPERIMENTAL = False`). `AnimaControlPanel` stays beta for now: it has an
open drag-scale defect whose fix is still unverified live, and it is
scheduled to graduate separately.

Without this guard, a future node could silently start (or stop) rendering
the beta badge with no test noticing either way. Graduating the next node is
meant to be a one-line, visible edit: add its name to `GRADUATED` here.

Reuses `test_node_descriptions.py`'s own subprocess-import trick (repro'd
here rather than imported, to keep this file runnable standalone): ComfyUI
only ever puts this pack's PARENT directory on `sys.path` and imports the
pack itself as a package, so `NODE_CLASS_MAPPINGS` is read the same way here,
in an isolated subprocess, rather than via a hand-copied local dict that
could drift from `__init__.py`'s real mapping.

Run directly: `python tests/test_node_graduation.py` (no pytest, per project
convention).
"""
from __future__ import annotations

import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACK_PARENT_DIR = os.path.dirname(REPO_ROOT)
PACK_NAME = os.path.basename(REPO_ROOT)

# Nodes that have graduated out of beta (no `[BETA]` badge). Every OTHER
# registered node is expected to still carry `EXPERIMENTAL = True`. Adding a
# name here is the one-line, visible edit a future graduation should be.
GRADUATED = {"AnimaLoaderPanel"}

# Deliberately minimal and self-contained (same reasoning as
# `test_node_descriptions.py`'s own script): a fresh `python3 -c ...` process
# with an explicit, minimal `sys.path`, so this doesn't inherit the repo
# root from this test module's own sibling `sys.path.insert(...)` calls.
_SUBPROCESS_SCRIPT = f"""
import sys
sys.path = [{PACK_PARENT_DIR!r}] + [p for p in sys.path if p not in ({REPO_ROOT!r}, "", {PACK_PARENT_DIR!r})]
assert {REPO_ROOT!r} not in sys.path, "repo root leaked onto sys.path"

import importlib
m = importlib.import_module({PACK_NAME!r})

for name, cls in sorted(m.NODE_CLASS_MAPPINGS.items()):
    experimental = bool(getattr(cls, "EXPERIMENTAL", False))
    print(f"EXP {{name}} {{'TRUE' if experimental else 'FALSE'}}")

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


def _experimental_flags(stdout: str) -> dict:
    flags = {}
    for line in stdout.splitlines():
        if line.startswith("EXP "):
            _, name, value = line.split(maxsplit=2)
            flags[name] = value == "TRUE"
    return flags


def test_subprocess_import_succeeds():
    result = _run_subprocess_import()
    assert result.returncode == 0, (
        f"package import failed:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "SUBPROCESS_OK" in result.stdout, (
        f"subprocess did not report success:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )


def test_at_least_the_known_eight_nodes_were_checked():
    # Guards against the subprocess silently reporting zero/fewer nodes
    # (e.g. a broken import that still exits 0) masking the assertions below
    # -- mirrors `test_node_descriptions.py`'s own nonzero-count check.
    result = _run_subprocess_import()
    assert result.returncode == 0, f"import failed:\n{result.stderr}"
    flags = _experimental_flags(result.stdout)
    expected = {
        "PromptRulesText", "PromptRulesClip",
        "AnimaControlPanel", "AnimaLoaderPanel", "AnimaLoraLoader",
        "AnimaContextBridge", "AnimaGenerator", "AnimaPreview",
    }
    assert expected.issubset(flags), (
        f"expected node set missing from mapping: {expected - set(flags)}"
    )


def test_only_the_allow_listed_nodes_have_graduated():
    result = _run_subprocess_import()
    assert result.returncode == 0, f"import failed:\n{result.stderr}"
    flags = _experimental_flags(result.stdout)
    assert flags, f"no EXP lines found in subprocess stdout:\n{result.stdout}"

    still_beta_but_allow_listed = {
        name for name in GRADUATED if flags.get(name, False)
    }
    assert not still_beta_but_allow_listed, (
        f"nodes in GRADUATED still report EXPERIMENTAL truthy (allow-list is "
        f"stale, or the node's attribute wasn't actually removed): "
        f"{still_beta_but_allow_listed}"
    )

    graduated_but_not_allow_listed = {
        name for name, experimental in flags.items()
        if not experimental and name not in GRADUATED
    }
    assert not graduated_but_not_allow_listed, (
        f"node(s) report EXPERIMENTAL falsy but are not in this test's "
        f"GRADUATED allow-list -- a node silently graduated (or lost its "
        f"beta badge) with no visible record of the decision: "
        f"{graduated_but_not_allow_listed}"
    )


ALL_TESTS = [
    test_subprocess_import_succeeds,
    test_at_least_the_known_eight_nodes_were_checked,
    test_only_the_allow_listed_nodes_have_graduated,
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
