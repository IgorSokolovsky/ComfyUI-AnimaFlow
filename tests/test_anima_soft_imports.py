"""Plain-script test for `src/anima/soft_imports.py` (design doc §4/§11):
every optional dependency lookup must report ABSENT, never raise, when the
owning pack is genuinely not installed -- exercised in a fresh subprocess,
same reasoning as `tests/test_package_import.py`: running in-process here
would only prove the lookups are `None`-safe against whatever happens to
already be imported in THIS test run (which could accidentally include a
stray `NODE_CLASS_MAPPINGS`-shaped module from an unrelated import elsewhere
in the suite); a fresh interpreter guarantees the pack is ACTUALLY absent,
not just unimported by coincidence.

Run directly: `python tests/test_anima_soft_imports.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Minimal, self-contained subprocess script: repo root on `sys.path` (so
# `src.anima.soft_imports` resolves as a bare import -- unlike
# `test_package_import.py`, we are NOT testing the ComfyUI-package-load
# contract here, just "is the dependency lookup itself None-safe in total
# isolation").
_SUBPROCESS_SCRIPT = f"""
import sys
sys.path.insert(0, {REPO_ROOT!r})

from src.anima import soft_imports

assert soft_imports.find_node_class("AnimaModGuidance") is None
assert soft_imports.find_node_class("UltimateSDUpscale") is None
assert soft_imports.find_node_class("DetailerForEach") is None
assert soft_imports.find_node_class("MaskToSEGS") is None
assert soft_imports.find_node_class("TotallyMadeUpNodeClassName") is None
assert soft_imports.find_sam3_detect_class() is None

assert soft_imports.has_mod_guidance() is False
assert soft_imports.has_usdu() is False
assert soft_imports.has_impact_detailer() is False
assert soft_imports.has_sam3_detect() is False

print("SUBPROCESS_OK")
"""


def _run_subprocess():
    return subprocess.run(
        [sys.executable, "-c", _SUBPROCESS_SCRIPT],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_every_soft_dependency_reports_absent_with_no_ComfyUI_installed():
    result = _run_subprocess()
    assert result.returncode == 0, (
        f"soft_imports lookups failed with no ComfyUI/third-party packs installed:\n"
        f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
    assert "SUBPROCESS_OK" in result.stdout, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"


def test_soft_imports_module_itself_imports_with_no_eager_comfy_import():
    # A second, simpler check: importing the module at all must not touch
    # ComfyUI/torch/third-party packages eagerly (module-scope), independent
    # of whether any lookup is later called.
    script = f"""
import sys
sys.path.insert(0, {REPO_ROOT!r})
import src.anima.soft_imports as si
assert not hasattr(si, "nodes")
assert not hasattr(si, "torch")
print("IMPORT_OK")
"""
    result = subprocess.run(
        [sys.executable, "-c", script], cwd=REPO_ROOT, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert "IMPORT_OK" in result.stdout


ALL_TESTS = [
    test_every_soft_dependency_reports_absent_with_no_ComfyUI_installed,
    test_soft_imports_module_itself_imports_with_no_eager_comfy_import,
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
