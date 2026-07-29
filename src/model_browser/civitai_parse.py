"""Pure parsing of a Civitai model-version JSON response (docs/lora-loader-
design.md §1a-vi/§2b). Stdlib only, no network -- `civitai_client.py` does
the fetching; this module only ever reads a dict a caller already has (a
live response, or a `<base>.civitai.info` sidecar read back), so it's fully
offline-testable against recorded JSON.

`parse_model_version` is a near-verbatim port of
`../ComfyUI-Pixaroma/nodes/_lora_helpers.py:377-420`'s own
`parse_civitai_modelversion` (MIT, THIRD_PARTY_NOTICES.md; `_clean_id`
above mirrors that file's `:60-69`), with one DELIBERATE divergence:
**this parser keeps `tags`** (§1a-vi). Upstream's drops them entirely, and
`tags` is the ONLY place a model's real category
(character/style/concept/clothing/poses/...) lives at all -- losing them
there is called out in the design doc as a defect to fix, not a precedent
to repeat. `_thumb_url`/`_is_adult_image`/`_pick_thumbnail` below are also
near-verbatim ports of that same upstream file's `:361-374`/`:346-358`/
(the thumbnail-selection loop inside `parse_civitai_modelversion`,
`:401-419`) respectively.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


def _clean_id(value: Any) -> Optional[int]:
    """A Civitai model/version id -> a clean `int`, or `None` -- rejects
    bools/dicts/lists/garbage from a hand-edited sidecar so a caller never
    builds a junk civitai.com URL from it."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _clean_strings(value: Any) -> List[str]:
    """A list-of-strings-ish field (`trainedWords`, `tags`, ...) -> a clean
    `List[str]`: empty/non-string entries dropped, non-list input -> `[]`.
    Tolerates a Civitai shape where each entry is `{"name": "..."}` rather
    than a bare string (seen on some endpoints for `tags`) rather than
    silently dropping every entry on a response shaped that way.
    """
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        if isinstance(item, str):
            text = item.strip()
        elif isinstance(item, dict):
            text = str(item.get("name", "")).strip()
        else:
            continue
        if text:
            out.append(text)
    return out


def parse_model_version(obj: Any) -> Dict[str, Any]:
    """A Civitai model-version-by-hash response -> `{name?, type?,
    base_model?, triggers?, tags?, description?, thumbnail?, model_id?,
    version_id?}` -- only the keys actually present in the source are set,
    so an empty return genuinely means "nothing usable was in this response
    at all", not "every field happened to be absent".

    **A response with no `trainedWords` and no `model.name` still counts as
    a usable record** (§2b) as long as ANYTHING else identifying comes back
    -- a base model, a type, a model/version id, tags, or a thumbnail.
    Plenty of real Civitai versions ship neither `trainedWords` nor a model
    name; requiring them threw away genuine hits and skipped the sidecar
    write, so every later click re-hashed the whole file and re-fetched it.
    Whether a `parse_model_version({})`-style empty dict should be reported
    as `notfound` rather than `found` is `lookup.py`'s decision, not this
    function's -- this function only ever describes what it actually found.
    """
    if not isinstance(obj, dict):
        return {}
    out: Dict[str, Any] = {}

    triggers = _clean_strings(obj.get("trainedWords"))
    if triggers:
        out["triggers"] = triggers

    if obj.get("baseModel"):
        out["base_model"] = str(obj["baseModel"])

    if obj.get("description"):
        out["description"] = str(obj["description"])

    # `tags` -- KEPT, unlike upstream (see module docstring). Seen on both
    # the version object itself and its embedded `model`, depending on
    # which Civitai endpoint answered; prefer the top-level one if both are
    # present, since it's the more specific of the two when they disagree.
    model = obj.get("model")
    if isinstance(model, dict):
        if model.get("name"):
            out["name"] = str(model["name"])
        if model.get("type"):
            out["type"] = str(model["type"])
        model_tags = _clean_strings(model.get("tags"))
        if model_tags:
            out["tags"] = model_tags

    top_tags = _clean_strings(obj.get("tags"))
    if top_tags:
        out["tags"] = top_tags

    mid = _clean_id(obj.get("modelId"))
    if mid is not None:
        out["model_id"] = mid
    vid = _clean_id(obj.get("id"))
    if vid is not None:
        out["version_id"] = vid

    thumbnail = _pick_thumbnail(obj.get("images"))
    if thumbnail:
        out["thumbnail"] = thumbnail

    return out


_ORIGINAL_SEG_RE = re.compile(r"/original=true(?:,[^/]*)?/")


def _thumb_url(url: str) -> str:
    """Swap Civitai's full-resolution `/original=true/` transform segment
    for a width-256 one -- a thumbnail needs roughly 55 KB, not the ~1.5 MB
    the original-resolution image costs (same measurement as
    `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:361-374`'s own `_thumb_url`,
    MIT, THIRD_PARTY_NOTICES.md). Any other URL shape (already a width
    transform, or no transform segment at all) passes through untouched.
    """
    return _ORIGINAL_SEG_RE.sub("/width=256/", url, count=1)


def _is_adult_image(nsfw: Any, level: Any) -> bool:
    """Whether a Civitai gallery image is flagged adult -- used only to keep
    an explicit image from becoming a node thumbnail, so it errs toward
    refusing rather than showing one. `nsfwLevel` is a bitmask (1 PG, 2
    PG13, 4 R, 8 X, 16 XXX); `nsfw` is the older bool/word field.

    Near-verbatim port of `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:346-358`'s
    own `_is_adult_image` (MIT, THIRD_PARTY_NOTICES.md).
    """
    if nsfw in (True, "X", "XXX", "Mature"):
        return True
    try:
        if level is not None and int(level) >= 4:
            return True
    except (TypeError, ValueError):
        pass
    return False


def _pick_thumbnail(images: Any) -> Optional[str]:
    """The first non-adult image's URL (thumbnail-sized), preferring one
    explicitly marked safe over merely "not obviously adult" -- same
    two-tier fallback as the thumbnail-selection loop inside
    `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:401-419`'s
    `parse_civitai_modelversion` (MIT, THIRD_PARTY_NOTICES.md), so a model
    whose gallery is entirely explicit ends up with NO thumbnail rather than
    an explicit one.
    """
    if not isinstance(images, list):
        return None
    fallback = None
    for image in images:
        if not isinstance(image, dict) or not image.get("url"):
            continue
        nsfw = image.get("nsfw")
        level = image.get("nsfwLevel")
        if nsfw in (None, False, "None", "Soft") and level in (None, 0, 1, 2):
            return _thumb_url(image["url"])
        if fallback is None and not _is_adult_image(nsfw, level):
            fallback = image["url"]
    return _thumb_url(fallback) if fallback else None


__all__ = ("parse_model_version",)
