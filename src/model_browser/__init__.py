"""AnimaFlow — the shared, kind-parameterised model browser (contract:
docs/lora-loader-design.md; plan: the `sunny-purring-boole` LoRA Loader M1
kickoff). Grouped by feature per `.claude/CLAUDE.md` ("`src/<feature>/` —
all supporting library code").

Named `model_browser`, not `civitai` (plan decision D): it also holds purely
LOCAL services -- file listing, safetensors metadata, preview-file discovery
-- that the Loader Panel needs too and that have nothing to do with Civitai.

Layering (mirrors the plan's JS-side reuse boundary): `kinds.py`, `local.py`,
`hashing.py` are track-agnostic and safe for the Loader Panel to import at
M3. `civitai_client.py`/`civitai_parse.py`/`sidecar.py`/`lookup.py` are the
Civitai half, also track-agnostic (kind-parameterised, never LoRA-specific).
`api.py` is the aiohttp wiring over all of it. Nothing here imports anything
under `nodes/controls/` -- the LoRA Loader node imports FROM this package,
never the reverse.

Every module that touches `folder_paths`/ComfyUI does so lazily (imports
inside functions, never at module scope), so this whole package stays
importable and unit-testable with no ComfyUI installed -- see each module's
own docstring.
"""
from __future__ import annotations
