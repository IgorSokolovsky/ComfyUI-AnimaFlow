"""SavePanel — saves a rendered webtoon panel PNG with its prompt/story
embedded as tEXt metadata (metadata is STORED only; nothing is drawn onto
the image itself).

Thin node wrapper; the tEXt key/value map is built by the pure, unit-tested
`_save_panel_helpers.build_text_metadata` (see `test_save_panel.py`). This
file does the impure parts — reading the image tensor, writing the PNG,
resolving ComfyUI's output directory — and ALL of torch/numpy/PIL/
folder_paths are imported LAZILY, inside `save()`, specifically so importing
this module (and the package `__init__.py`) still works headlessly without
ComfyUI/torch installed, same as every other node in this package.

Pairs with `PanelBatch`: since `PanelBatch` emits `panel`/`story`/
`panel_index` as ComfyUI LIST outputs (`OUTPUT_IS_LIST`) and this node does
NOT set `INPUT_IS_LIST`, ComfyUI calls `save()` once per panel, each call
receiving that one panel's image plus its aligned `prompt_text`/`story_text`/
`panel_index` — no manual zipping required.
"""

from __future__ import annotations

from ._save_panel_helpers import build_text_metadata


class SavePanel:
    CATEGORY = "AnimaFlow/panel"
    EXPERIMENTAL = True
    FUNCTION = "save"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "filename_prefix": ("STRING", {"default": "webtoon/panel"}),
            },
            "optional": {
                "prompt_text": ("STRING", {"multiline": True, "default": ""}),
                "story_text": ("STRING", {"multiline": True, "default": ""}),
                "panel_index": ("INT", {"default": 0, "min": 0}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    def save(
        self,
        images,
        filename_prefix="webtoon/panel",
        prompt_text="",
        story_text="",
        panel_index=0,
        prompt=None,
        extra_pnginfo=None,
    ):
        # Lazy imports: keep this module importable (and the package
        # __init__.py loadable) without ComfyUI/torch/PIL installed.
        import os

        import folder_paths
        import numpy as np
        from PIL.PngImagePlugin import PngInfo
        from PIL import Image

        disable_metadata = False
        try:
            from comfy.cli_args import args as _comfy_args

            disable_metadata = bool(getattr(_comfy_args, "disable_metadata", False))
        except Exception:
            disable_metadata = False

        output_dir = folder_paths.get_output_directory()
        full_folder, name, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, images.shape[2], images.shape[1]
        )
        os.makedirs(full_folder, exist_ok=True)

        metadata = {}
        if not disable_metadata:
            metadata = build_text_metadata(
                prompt_text,
                story_text,
                panel_index,
                extra_pnginfo=extra_pnginfo,
                comfy_prompt=prompt,
            )

        results = []
        for i, tensor in enumerate(images):
            arr = (255.0 * tensor.cpu().numpy()).clip(0, 255).astype(np.uint8)
            img = Image.fromarray(arr)

            pnginfo = PngInfo()
            for key, value in metadata.items():
                pnginfo.add_text(key, value)

            if panel_index and panel_index > 0:
                # `name` is the already-resolved filename STEM (subfolder
                # portion of `filename_prefix`, if any, is folded into
                # `full_folder` by get_save_image_path) — reusing it here
                # (rather than the raw filename_prefix, which may itself
                # contain "/" subfolder syntax) avoids double-nesting the
                # subfolder into the filename.
                filename = f"{name}_{panel_index:05d}.png"
            else:
                filename = f"{name}_{counter + i:05}_.png"

            img.save(os.path.join(full_folder, filename), pnginfo=pnginfo, compress_level=4)
            results.append({"filename": filename, "subfolder": subfolder, "type": "output"})

        return {"ui": {"images": results}}
