"""AnimaFlow — ComfyUI custom nodes for webtoon creation utilities.

A toolkit of focused utility nodes for building webtoons: prompt builders,
scene generators, and related helpers. Nodes are registered below via
NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS, which ComfyUI reads at startup.

Add a node:
  1. Implement its class (e.g. in a `nodes/` package).
  2. Import it here and add it to both mappings below.
"""

from __future__ import annotations

from .nodes.anima.node_anima_conditioning_encode import AnimaConditioningEncode
from .nodes.anima.node_anima_detailer_hook import AnimaDetailerAlignHook
from .nodes.anima.node_anima_generator import AnimaGenerator
from .nodes.anima.node_anima_image_scale import AnimaImageScaleByMultiple
from .nodes.anima.node_anima_preview import AnimaPreview
from .nodes.anima_prompt.node_anima_prompt_studio import AnimaPromptStudio
from .nodes.panel.node_llm_panels import LLMPanels
from .nodes.panel.node_panel_parser import PanelBatch
from .nodes.anima_prompt.node_prompt_builder import PromptBuilder
from .nodes.anima_prompt.node_prompt_combiner import PromptCombiner
from .nodes.panel.node_save_panel import SavePanel
from .nodes.panel.node_scene_creator import SceneCreator
from .nodes.anima_prompt.prompt_rules import PromptRulesClip, PromptRulesText

# Registers the `/wtn/rules/*` aiohttp routes as an import side effect (see
# `api/rules_api.py`); guarded there so this import is a no-op outside a live
# ComfyUI process instead of raising.
from .api import rules_api as _rules_api  # noqa: F401

# Registers the `/wtn/autocomplete` aiohttp route as an import side effect
# (see `autocomplete/api.py`); guarded there the same way as `rules_api`
# above. No node class here — tag autocomplete is a cross-cutting service
# consumed by `js/autocomplete/` and attached generically to any matching
# text widget across the whole pack, so nothing is added to
# NODE_CLASS_MAPPINGS for it.
from .autocomplete import api as _autocomplete_api  # noqa: F401

NODE_CLASS_MAPPINGS: dict[str, type] = {
    "PromptBuilder": PromptBuilder,
    "PromptCombiner": PromptCombiner,
    "SceneCreator": SceneCreator,
    "LLMPanels": LLMPanels,
    "PanelBatch": PanelBatch,
    "SavePanel": SavePanel,
    "PromptRulesClip": PromptRulesClip,
    "PromptRulesText": PromptRulesText,
    "AnimaImageScaleByMultiple": AnimaImageScaleByMultiple,
    "AnimaDetailerAlignHook": AnimaDetailerAlignHook,
    "AnimaPreview": AnimaPreview,
    "AnimaGenerator": AnimaGenerator,
    "AnimaConditioningEncode": AnimaConditioningEncode,
    "AnimaPromptStudio": AnimaPromptStudio,
}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {
    "PromptBuilder": "Prompt Builder",
    "PromptCombiner": "Prompt Combiner",
    "SceneCreator": "Scene Creator",
    "LLMPanels": "LLM Panels",
    "PanelBatch": "Panel Parser (Batch)",
    "SavePanel": "Save Panel (metadata)",
    "PromptRulesClip": "Prompt Rules (CLIP)",
    "PromptRulesText": "Prompt Rules",
    "AnimaImageScaleByMultiple": "Anima Image Scale By Multiple",
    "AnimaDetailerAlignHook": "Anima Detailer Align Hook",
    "AnimaPreview": "Anima Preview",
    "AnimaGenerator": "Anima Generator",
    "AnimaConditioningEncode": "Anima Conditioning Encode",
    "AnimaPromptStudio": "Anima Prompt Studio",
}

WEB_DIRECTORY = "./js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
