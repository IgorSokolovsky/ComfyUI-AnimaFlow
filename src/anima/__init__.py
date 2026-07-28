"""AnimaFlow — the Anima Generator/Preview line's supporting library
(contract: docs/generator-design.md). Grouped by feature per `.claude/CLAUDE.md`
("`src/<feature>/` — all supporting library code").

Every module here that touches comfy/torch does so lazily (imports inside
functions, never at module scope), so this whole package stays importable
and unit-testable with no ComfyUI installed — see each module's own
docstring, and `tests/test_anima_soft_imports.py` for why that matters
enough to test in a subprocess.
"""
from __future__ import annotations
