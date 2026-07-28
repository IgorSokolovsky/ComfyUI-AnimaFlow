"""`Anima Preview` — compares two of the Generator's image outputs with a
hover wipe (`js/anima/`), and OWNS SAVING (contract: docs/generator-design.md
§2/§7/§7a). Terminal, `OUTPUT_NODE = True`: a graph with no Preview wired
runs nothing at all, since the Generator itself isn't an output node (design
doc §2).

The hidden `PROMPT`/`EXTRA_PNGINFO` inputs live HERE, not on the Generator,
because this is where embed-workflow happens (§9 divergence #3's fix — the
deleted old port never declared them anywhere, so its saves were worse than
stock `SaveImage`: dragging a saved PNG back into ComfyUI restored nothing).

Real logic lives in `nodes/anima/_preview_helpers.py` (impure — PIL/
folder_paths) and `src/anima/preview_settings.py` (pure — settings shape,
filename tokens, and stage-routing decisions); this class only wires up
`INPUT_TYPES` and calls them.

**PREVIEW vs SAVE are two different questions, answered by two different
inputs** — this is the fix for the bug where saving off meant the frontend's
hover wipe got zero images: `preview_stages` (below) is EVERY wired stage,
ALWAYS, because the wipe needs whichever two the user picks in
`compare.a`/`compare.b` regardless of what gets saved to disk;
`stages_to_save` is `save.which`'s scoped subset, only computed at all when
saving is on. `_preview_helpers.build_preview_ui_images` then routes each
previewed stage to exactly one write: a real output file if it's also in
`stages_to_save`, an ephemeral temp file otherwise (never both, so one run
never produces two files for the same stage) — see that function's and
`resolve_wired_stages`'s own docstrings for the rest of this contract.
"""
from __future__ import annotations

from ._preview_helpers import (
    build_preview_ui_images,
    extract_seed_from_prompt,
    resolve_save_stages,
    resolve_wired_stages,
)

CATEGORY = "AnimaFlow/Anima"


class AnimaPreview:
    """`Anima Preview` — terminal node: compares (`js/anima/`'s hover wipe)
    and saves. `image_a`/`image_b`/`image_c` are all optional so "I don't
    want preview" is expressed by leaving them unwired — the whole Generator
    then does nothing at all, which is intended (design doc §2)."""

    CATEGORY = CATEGORY
    EXPERIMENTAL = True
    OUTPUT_NODE = True
    FUNCTION = "preview"
    RETURN_TYPES = ()
    RETURN_NAMES = ()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preview_state": (
                    "STRING",
                    {
                        "default": "{}",
                        "tooltip": (
                            "Serialized Preview state (JSON): the compare "
                            "picker (which two stages, and whether the wipe "
                            "is on) and the save settings (which images, "
                            "filename tokens, path, extension, embed-"
                            "workflow). Hidden for rendering only, not meant "
                            "to be hand-edited -- see docs/generator-design.md §8."
                        ),
                    },
                ),
            },
            "optional": {
                "image_a": ("IMAGE", {"tooltip": "First image to compare/save -- by convention wire the Generator's image_base here."}),
                "image_b": ("IMAGE", {"tooltip": "Second image to compare/save -- by convention wire the Generator's image_mid here."}),
                "image_c": ("IMAGE", {"tooltip": "Third image to compare/save -- by convention wire the Generator's image here."}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    def preview(self, preview_state="{}", image_a=None, image_b=None, image_c=None, prompt=None, extra_pnginfo=None):
        try:
            # Real ComfyUI context -- same convention as
            # `nodes/prompt_rules/_rules_helpers.py`'s import of `src.prompt_rules.core`.
            from ...src.anima.preview_settings import normalize_preview_settings  # type: ignore
        except ImportError:
            from src.anima.preview_settings import normalize_preview_settings

        settings = normalize_preview_settings(preview_state)
        wired = {"image_a": image_a, "image_b": image_b, "image_c": image_c}

        save_settings = settings.get("save", {})
        compare_settings = settings.get("compare", {})

        # PREVIEW is every wired stage, ALWAYS -- independent of save.enabled
        # (this module's own top-doc comment explains why; conflating the two
        # is exactly how "saving off means the wipe shows nothing" happened).
        preview_stages = resolve_wired_stages(wired)
        # SAVE is `save.which`'s scoped subset -- only computed at all when
        # saving is actually on; empty otherwise, which routes every
        # previewed stage to a temp file (see `build_preview_ui_images`).
        stages_to_save = (
            resolve_save_stages(save_settings, compare_settings, wired)
            if isinstance(save_settings, dict) and save_settings.get("enabled", True)
            else []
        )

        seed = extract_seed_from_prompt(prompt)
        ui_images = build_preview_ui_images(
            wired=wired, preview_stages=preview_stages, stages_to_save=stages_to_save,
            preview_settings=settings, seed=seed, prompt=prompt, extra_pnginfo=extra_pnginfo,
        )

        return {"ui": {"images": ui_images}}


NODE_CLASS_MAPPINGS = {"AnimaPreview": AnimaPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaPreview": "Anima Preview"}
