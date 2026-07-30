"""AnimaFlow — the browser-cache fix for this pack's own ES modules.

Grouped by feature per `.claude/CLAUDE.md` ("`src/<feature>/` — all
supporting library code"). `stamp.py` is pure (no imports beyond `re`/`os`)
and holds the import-URL rewrite + version-computation logic, unit-testable
with no ComfyUI installed. `api.py` is the aiohttp wiring (the
`on_response_prepare` hook + middleware) over it, registered as a guarded
import side effect from `__init__.py` (the pack's own top-level one), same
idiom as `src/anima/api.py`/`src/model_browser/api.py`.

Ported from `../ComfyUI-Pixaroma` (MIT (c) pixaroma) — see
`stamp.py`/`api.py`'s own doc comments for exact upstream file:line
citations, and `THIRD_PARTY_NOTICES.md` for the license text.
"""
from __future__ import annotations
