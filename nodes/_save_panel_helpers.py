"""Pure logic for the Save Panel (metadata) node — no ComfyUI/torch/PIL imports.

Kept separate from `node_save_panel.py` so it can be unit-tested in isolation
(see `test_save_panel.py` at the repo root) with NO dependency on ComfyUI,
torch, numpy, or PIL being installed — importing this module (and the node
class that imports it) must work headlessly. The actual image tensor -> PIL
-> PNG-with-tEXt-metadata save is the one impure thing, and stays entirely in
`node_save_panel.py`'s `save` method, with all of those imports done lazily
(inside the method) for exactly that reason.

Distinct `webtoon_*` keys are used for this node's own metadata so it never
clobbers ComfyUI's own `"prompt"` / `"workflow"` tEXt chunks (the same two
keys stock `SaveImage` writes, embedded here too via `comfy_prompt` /
`extra_pnginfo` so a saved panel can still be dragged back onto the canvas
to restore the workflow, exactly like a native save).
"""

from __future__ import annotations

import json

WEBTOON_PROMPT_KEY = "webtoon_prompt"
WEBTOON_STORY_KEY = "webtoon_story"
WEBTOON_PANEL_INDEX_KEY = "webtoon_panel_index"
COMFY_PROMPT_KEY = "prompt"


def build_text_metadata(
    prompt_text: str,
    story_text: str,
    panel_index: int,
    extra_pnginfo: dict | None = None,
    comfy_prompt=None,
) -> dict[str, str]:
    """Build the tEXt key/value map to embed in the saved PNG.

    - `"webtoon_prompt"`: `prompt_text`, stripped — included only when non-empty.
    - `"webtoon_story"`: `story_text`, stripped — included only when non-empty.
    - `"webtoon_panel_index"`: `str(panel_index)` — included only when > 0.
    - `"prompt"`: `json.dumps(comfy_prompt)` — included only when `comfy_prompt`
      is not `None` (this is ComfyUI's own PROMPT hidden input, embedded under
      its stock key so drag-to-restore keeps working).
    - One entry per `extra_pnginfo` item (e.g. `"workflow"`), each
      `json.dumps`-ed — `extra_pnginfo` is only read when it's a dict.

    Every value in the returned dict is a `str`. None of the `webtoon_*` keys
    can collide with `"prompt"`/`"workflow"` (distinct names by construction).
    """
    metadata: dict[str, str] = {}

    prompt_clean = str(prompt_text or "").strip()
    if prompt_clean:
        metadata[WEBTOON_PROMPT_KEY] = prompt_clean

    story_clean = str(story_text or "").strip()
    if story_clean:
        metadata[WEBTOON_STORY_KEY] = story_clean

    if panel_index and panel_index > 0:
        metadata[WEBTOON_PANEL_INDEX_KEY] = str(panel_index)

    if comfy_prompt is not None:
        metadata[COMFY_PROMPT_KEY] = json.dumps(comfy_prompt)

    if isinstance(extra_pnginfo, dict):
        for key, value in extra_pnginfo.items():
            metadata[str(key)] = json.dumps(value)

    return metadata
