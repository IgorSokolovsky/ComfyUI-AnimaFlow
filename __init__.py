"""AnimaFlow — ComfyUI custom nodes for the Rule Builder prompt-authoring line.

A toolkit of focused utility nodes: prompt-rule transforms driven by the
clean-room rules engine (`src/prompt_rules/core/`) and authored via the
visual Rule Builder overlay. Nodes are registered below via
NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS, which ComfyUI reads at
startup.

Add a node:
  1. Implement its class (e.g. in a `nodes/` package).
  2. Import it here and add it to both mappings below.
"""

from __future__ import annotations

from .nodes.anima.generator import AnimaGenerator
from .nodes.anima.preview import AnimaPreview
from .nodes.controls.control_panel import AnimaControlPanel
from .nodes.controls.loader_panel import AnimaLoaderPanel
from .nodes.prompt_rules.prompt_rules import PromptRulesClip, PromptRulesText

# Registers the `/wtn/rules/*` aiohttp routes as an import side effect (see
# `src/prompt_rules/api/rules_api.py`); guarded there so this import is a
# no-op outside a live ComfyUI process instead of raising.
from .src.prompt_rules.api import rules_api as _rules_api  # noqa: F401

# Registers the `/wtn/autocomplete` aiohttp route as an import side effect
# (see `src/autocomplete/api.py`); guarded there the same way as `rules_api`
# above. No node class here — tag autocomplete is a cross-cutting service
# consumed by `js/autocomplete/` and attached generically to any matching
# text widget across the whole pack, so nothing is added to
# NODE_CLASS_MAPPINGS for it.
from .src.autocomplete import api as _autocomplete_api  # noqa: F401

NODE_CLASS_MAPPINGS: dict[str, type] = {
    "PromptRulesClip": PromptRulesClip,
    "PromptRulesText": PromptRulesText,
    "AnimaControlPanel": AnimaControlPanel,
    "AnimaLoaderPanel": AnimaLoaderPanel,
    "AnimaGenerator": AnimaGenerator,
    "AnimaPreview": AnimaPreview,
}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {
    "PromptRulesClip": "Prompt Rules (CLIP)",
    "PromptRulesText": "Prompt Rules",
    "AnimaControlPanel": "Anima Control Panel",
    "AnimaLoaderPanel": "Anima Loader Panel",
    "AnimaGenerator": "Anima Generator",
    "AnimaPreview": "Anima Preview",
}

WEB_DIRECTORY = "./js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
