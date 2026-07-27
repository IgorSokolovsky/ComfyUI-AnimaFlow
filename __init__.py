"""AnimaFlow — ComfyUI custom nodes for the Anima model and prompt authoring.

A toolkit of focused utility nodes: prompt-rule transforms, the Anima Prompt
Studio block editor, and the Anima-model generation/conditioning pipeline.
Nodes are registered below via NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS,
which ComfyUI reads at startup.

Add a node:
  1. Implement its class (e.g. in a `nodes/` package).
  2. Import it here and add it to both mappings below.
"""

from __future__ import annotations

from .nodes.anima.node_anima_conditioning_encode import AnimaConditioningEncode
from .nodes.anima.node_anima_detailer_hook import AnimaDetailerAlignHook
from .nodes.anima.node_anima_generator import AnimaGenerator
from .nodes.anima.node_anima_image_scale import AnimaImageScaleByMultiple
from .nodes.anima.node_anima_loader import AnimaLoader
from .nodes.anima.node_anima_preview import AnimaPreview
from .nodes.anima.node_anima_region_mask_editor import AnimaRegionMaskEditor
from .nodes.anima.node_anima_regional_conditioning import AnimaRegionalConditioning
from .nodes.anima_prompt.node_anima_prompt_studio import AnimaPromptStudio
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
    "PromptRulesClip": PromptRulesClip,
    "PromptRulesText": PromptRulesText,
    "AnimaImageScaleByMultiple": AnimaImageScaleByMultiple,
    "AnimaLoader": AnimaLoader,
    "AnimaDetailerAlignHook": AnimaDetailerAlignHook,
    "AnimaPreview": AnimaPreview,
    "AnimaGenerator": AnimaGenerator,
    "AnimaConditioningEncode": AnimaConditioningEncode,
    "AnimaPromptStudio": AnimaPromptStudio,
    "AnimaRegionMaskEditor": AnimaRegionMaskEditor,
    "AnimaRegionalConditioning": AnimaRegionalConditioning,
}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {
    "PromptRulesClip": "Prompt Rules (CLIP)",
    "PromptRulesText": "Prompt Rules",
    "AnimaImageScaleByMultiple": "Anima Image Scale By Multiple",
    "AnimaLoader": "Anima Loader",
    "AnimaDetailerAlignHook": "Anima Detailer Align Hook",
    "AnimaPreview": "Anima Preview",
    "AnimaGenerator": "Anima Generator",
    "AnimaConditioningEncode": "Anima Conditioning Encode",
    "AnimaPromptStudio": "Anima Prompt Studio",
    "AnimaRegionMaskEditor": "Anima Region Mask Editor",
    "AnimaRegionalConditioning": "Anima Regional Conditioning",
}

WEB_DIRECTORY = "./js"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
