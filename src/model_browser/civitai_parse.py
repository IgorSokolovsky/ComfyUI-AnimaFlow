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
to repeat. `_thumb_url`/`_is_adult_image`/`pick_thumbnail_url` (formerly
`_pick_thumbnail`, promoted public 2026-07-31 -- the old name survives as a
plain alias) below are also near-verbatim ports of that same upstream
file's `:361-374`/`:346-358`/(the thumbnail-selection loop inside
`parse_civitai_modelversion`, `:401-419`) respectively.
"""
from __future__ import annotations

import html as _html
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


_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
# Paragraph-level closers get a BLANK line (a real paragraph break); list/row
# closers get a single line -- a bullet list reads as consecutive lines, not
# as separate paragraphs with gaps between every item.
_PARA_CLOSE_RE = re.compile(r"</\s*(p|div|h[1-6]|blockquote)\s*>", re.IGNORECASE)
_LINE_CLOSE_RE = re.compile(r"</\s*(li|tr)\s*>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_BLANK_RUN_RE = re.compile(r"\n{3,}")


def html_to_text(value: Any) -> str:
    """BUG 11a (2026-07-29 owner report): a Civitai description is HTML, and
    we correctly write it with `textContent` -- never `innerHTML`, that is
    the XSS boundary and must not change -- so left as-is the raw tags
    showed up as literal text (`<p>Trained on preview3.</p>`). This converts
    HTML to READABLE PLAIN TEXT before it ever reaches `out["model_description"]`
    or `out["version_description"]` (§7d-i -- both go through this SAME
    conversion, never a second one):
    tags stripped, entities decoded, block-level closers turned into real
    newlines so a multi-paragraph write-up stays readable: `<br>` and a
    paragraph closer (`</p>`, `</div>`, `</h1>`-`</h6>`, `</blockquote>`) get
    a BLANK line (a real paragraph break), while a list/row closer (`</li>`,
    `</tr>`) gets a single line, since a bullet list reads as consecutive
    lines, not as separate paragraphs with a gap between every item.
    Everything else collapses to plain inline text (an inline `<a>`/`</a>`
    just disappears, its own text staying inline -- correct for a link that
    isn't block-level).

    Order matters: block/`<br>` tags are converted to newlines FIRST (real
    tags, real `<`/`>`), remaining tags are stripped SECOND, and HTML
    entities are decoded LAST -- so a literal `&lt;script&gt;` an author
    typed decodes to the literal text `<script>` (still perfectly safe
    written via `textContent`, never re-interpreted as markup) instead of
    being caught by the tag-stripping pass meant for REAL tags.

    Pure, offline-testable, no network. Never raises: non-string/blank input
    returns `""`.
    """
    if not isinstance(value, str) or not value.strip():
        return ""
    text = _BR_RE.sub("\n", value)
    text = _PARA_CLOSE_RE.sub("\n\n", text)
    text = _LINE_CLOSE_RE.sub("\n", text)
    text = _TAG_RE.sub("", text)
    text = _html.unescape(text)
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join(lines)
    text = _BLANK_RUN_RE.sub("\n\n", text)
    return text.strip()


def parse_model_version(obj: Any) -> Dict[str, Any]:
    """A Civitai model-version-by-hash response -> `{name?, type?,
    base_model?, triggers?, tags?, model_description?, version_description?,
    thumbnail?, model_id?, version_id?}` -- only the keys actually present in
    the source are set, so an empty return genuinely means "nothing usable
    was in this response at all", not "every field happened to be absent".

    docs/lora-loader-design.md §7d-i (owner, 2026-07-30): Civitai carries TWO
    distinct pieces of prose and they are returned as two INDEPENDENT,
    first-class fields, never collapsed into one -- a caller labels and
    renders each separately:

      - `model_description` -- the author's overall write-up for the whole
        model (what it's for, how to prompt it, recommended settings). Read
        from this response's embedded `model.description` when present; in
        practice the by-hash endpoint's `model` sub-object almost never
        actually carries one (verified live, 2026-07-29: it's `{name, type,
        nsfw, poi}` only) -- `lookup.py`'s `_augment_with_model_description`
        is the fallback that actually supplies it most of the time, by
        fetching `/api/v1/models/{id}` once and caching the result back into
        this same shape (so a future parse of the cached sidecar finds it
        right here, with no second fetch).
      - `version_description` -- the model-VERSION object's own `description`
        field, a per-version note that usually reads like a short changelog
        ("Trained on preview3.") -- NOT a lower-fidelity copy of the author
        write-up, a genuinely different piece of text. Read straight off
        this same response with no fallback fetch of its own: it either was
        in the payload already or it wasn't.

    BUG 11b (2026-07-29 owner report, superseded by §7d-i): an earlier cut
    collapsed both into one `description` key, which made a present version
    description silently SUPPRESS the model-id fallback fetch that gets the
    real write-up (the fetch was gated on `description` already being
    empty). Keeping the two fields fully independent -- `version_description`
    never gates, and is never gated by, `model_description` -- is what
    prevents that bug from coming back; there is no "collapse" step left to
    regress.

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
        if model.get("description"):
            model_description = html_to_text(str(model["description"]))
            if model_description:
                out["model_description"] = model_description

    top_tags = _clean_strings(obj.get("tags"))
    if top_tags:
        out["tags"] = top_tags

    # §7d-i: the two descriptions are independent fields, computed
    # independently -- `version_description`'s presence/absence never
    # depends on `model_description`, and vice versa (see this function's
    # own docstring for why that independence is what keeps BUG 11b fixed).
    if obj.get("description"):
        version_description = html_to_text(str(obj["description"]))
        if version_description:
            out["version_description"] = version_description

    mid = _clean_id(obj.get("modelId"))
    if mid is not None:
        out["model_id"] = mid
    vid = _clean_id(obj.get("id"))
    if vid is not None:
        out["version_id"] = vid

    thumbnail = pick_thumbnail_url(obj.get("images"))
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


def pick_gallery_image_url(images: Any) -> Optional[str]:
    """The first non-adult image's URL, UNTRANSFORMED (no thumbnail-size
    rewrite) -- the shared adult-filtering selection `_pick_thumbnail` below
    builds on (running this result through `_thumb_url`), and also what
    `civitai_search.py`'s own per-version preview-image selection reuses
    directly (docs task, 2026-07-30 "no preview image" fix: a download-time
    preview save wants the image roughly as Civitai served it in the search
    result, not deliberately downsized to a 256px live-thumbnail size) --
    same two-tier "prefer explicitly safe, then merely not-adult" fallback
    as `_pick_thumbnail`, factored out so the adult-filtering RULE lives in
    exactly one place rather than two copies of this loop.
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
            return image["url"]
        if fallback is None and not _is_adult_image(nsfw, level):
            fallback = image["url"]
    return fallback


def pick_thumbnail_url(images: Any) -> Optional[str]:
    """The first non-adult image's URL, THUMBNAIL-sized (`_thumb_url`'s
    width-256 rewrite) -- same two-tier fallback as the thumbnail-selection
    loop inside `../ComfyUI-Pixaroma/nodes/_lora_helpers.py:401-419`'s
    `parse_civitai_modelversion` (MIT, THIRD_PARTY_NOTICES.md), so a model
    whose gallery is entirely explicit ends up with NO thumbnail rather than
    an explicit one. A thin wrapper over `pick_gallery_image_url` (above),
    which now holds the actual selection loop.

    Public (promoted from `_pick_thumbnail`, docs task 2026-07-31, "Civitai
    search panel thumbnails") -- `civitai_search.py`'s own `_parse_version`
    calls this directly to seed each version's `thumb_url` (the LIVE
    in-browser thumbnail), sibling to that same function's `preview_url`
    (`pick_gallery_image_url`, untransformed, saved to disk at download
    time) -- see `_parse_version`'s own comment for why the two deliberately
    stay different sizes.
    """
    url = pick_gallery_image_url(images)
    return _thumb_url(url) if url else None


# Old private name kept as a plain alias -- `parse_model_version` above now
# calls the public `pick_thumbnail_url` directly, but `tests/
# test_model_browser.py`'s own `test_pick_thumbnail_still_transforms_its_own_
# result` (and any other existing internal call site) still reaches this
# under its original name, unchanged.
_pick_thumbnail = pick_thumbnail_url


def parse_model_description(obj: Any) -> Optional[str]:
    """A Civitai `GET /api/v1/models/{id}` response -> its own top-level
    `description`, converted to plain text (BUG 11a's `html_to_text`) --
    the author's main write-up for the WHOLE model, as opposed to
    `parse_model_version`'s per-VERSION one. `None` if the field is
    missing, blank, or `obj` isn't a dict at all.

    Confirmed live, 2026-07-29 (BUG 2, re-confirmed for BUG 11b): a real
    `/api/v1/models/{id}` response's `description` is a genuine multi-
    paragraph author intro (e.g. "<h1>DreamShaper - V∞!</h1><h3>Please check
    out my other base models...</h3>...") -- categorically different from
    that SAME model's by-hash version-level `description`, which read like a
    changelog ("Better at handling Character LoRA", "Better at photorealism
    ...") for the very same model. That is the real-world evidence behind
    BUG 11b's precedence fix: the version's own description is not a
    lower-fidelity copy of the author write-up, it is a DIFFERENT kind of
    text entirely, and only this endpoint carries the one users actually
    mean by "author's notes".

    Pure, offline-testable against recorded JSON. `lookup.py`'s
    `_augment_with_model_description` is the only caller -- BUG 2's fallback
    fetch for the case (the common one) where the by-hash endpoint's
    embedded `model` object didn't carry a description at all.
    """
    if not isinstance(obj, dict):
        return None
    description = obj.get("description")
    if isinstance(description, str) and description.strip():
        return html_to_text(description)
    return None


def civitai_shape_from_search_meta(meta: Any) -> Dict[str, Any]:
    """Reshape OUR OWN normalized search-result metadata (`model_id`,
    `version_id`, `name`, `type`, `base_model`, `tags`, `triggers` -- exactly
    what `civitai_search.parse_search_response`'s per-result/per-version
    dicts already carry, per that module's own docstring) into the SAME
    raw-Civitai-response shape `parse_model_version` reads -- so a value
    written this way at download time (the "no info sidecar" fix, 2026-07-30:
    the search result the user already saw is reused rather than re-hashing
    the file / re-fetching Civitai the first time the ⓘ panel opens) is read
    back through the EXACT same parser as a live by-hash lookup's response,
    with no second parser to keep in sync.

    Deliberately NOT `parse_model_version` run in reverse: a SEARCH result
    never carries `description` text at all (Civitai's search endpoint
    doesn't return it -- see `civitai_search.py`'s own per-item parse), so
    `model_description`/`version_description` are simply never set here --
    "omit rather than invent" (docs/lora-loader-design.md §1a-vi), not a
    placeholder.

    Never raises: non-dict input, or a `meta` with nothing usable at all,
    returns `{}` (mirrors `parse_model_version`'s own "nothing usable"
    contract, so a caller's "did this produce anything?" check is the same
    `if translated:` either way).
    """
    if not isinstance(meta, dict):
        return {}
    out: Dict[str, Any] = {}

    version_id = meta.get("version_id")
    if isinstance(version_id, int) and not isinstance(version_id, bool):
        out["id"] = version_id
    model_id = meta.get("model_id")
    if isinstance(model_id, int) and not isinstance(model_id, bool):
        out["modelId"] = model_id
    if meta.get("base_model"):
        out["baseModel"] = str(meta["base_model"])
    triggers = meta.get("triggers")
    if isinstance(triggers, list):
        cleaned_triggers = [str(t) for t in triggers if isinstance(t, str) and t.strip()]
        if cleaned_triggers:
            out["trainedWords"] = cleaned_triggers

    model_obj: Dict[str, Any] = {}
    if meta.get("name"):
        model_obj["name"] = str(meta["name"])
    if meta.get("type"):
        model_obj["type"] = str(meta["type"])
    tags = meta.get("tags")
    if isinstance(tags, list):
        cleaned_tags = [str(t) for t in tags if isinstance(t, str) and t.strip()]
        if cleaned_tags:
            model_obj["tags"] = cleaned_tags
            out["tags"] = cleaned_tags
    if model_obj:
        out["model"] = model_obj

    return out


__all__ = (
    "parse_model_version", "parse_model_description", "html_to_text",
    "pick_gallery_image_url", "pick_thumbnail_url", "civitai_shape_from_search_meta",
)
