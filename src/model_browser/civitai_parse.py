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

docs/lora-loader-design.md §7c-iv (2026-07-31, "the ⓘ panel's candidates
live in the sidecar" / "SETTLED: the saved preview is `anim=false,
width=450`" -- SUPERSEDED, same day, by the owner's later reversal "save
the ORIGINAL image on disk, downscale when SERVING it" -- see
`saved_preview_url`'s own docstring below): there are now THREE named
Civitai CDN transforms (`LIVE_THUMB_TRANSFORM`, `SAVED_PREVIEW_VIDEO_
TRANSFORM`, `SOURCE_TRANSFORM` below), all sharing one rewrite helper
(`_rewrite_transform`), and `parse_gallery_images` (moved here from
`civitai_search.py`'s own `_parse_images`, which is now a plain alias --
same "one function, not two copies" rule `pick_gallery_image_url`'s own
docstring already states) is what both `parse_model_version`'s new
`images` key and the search path share, so the candidate-list rule lives
in exactly one place.
"""
from __future__ import annotations

import html as _html
import os
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit


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
    images?, images_schema?, model_id?, version_id?}` -- only the keys
    actually present in the source are set, so an empty return genuinely
    means "nothing usable was in this response at all", not "every field
    happened to be absent".

    docs/lora-loader-design.md §7c-iv, "the ⓘ panel's candidates live in the
    sidecar" (2026-07-31): `images` replaces the old single pre-chosen
    `thumbnail` string entirely (deleted, not kept alongside this) --
    picking ONE image ahead of time baked the browsing level in force at
    WRITE time into the cache forever, since raising the level later never
    triggers a re-fetch. `images` is the SAME ordered `[{url, nsfw_level,
    type}]` candidate list `civitai_search.py`'s own search path already
    emits (`parse_gallery_images`, shared rather than duplicated -- see this
    module's own docstring), unfiltered by adult-ness, so a caller (the ⓘ
    panel) picks at RENDER time against whatever browsing level is current,
    exactly like the search card already does. `images_schema` is
    `"gallery"` when `images` came from a real Civitai `images` array, or
    `"legacy"` when it was grandfathered from an OLD raw record that only
    ever carried a bare `thumbnail` string (see the migration comment
    inline below) -- so a caller/test can tell the two shapes apart.

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

    images = parse_gallery_images(obj.get("images"))
    if images:
        out["images"] = images
        out["images_schema"] = "gallery"
    else:
        # §7c-iv "Legacy sidecars migrate with no re-fetch, and by proof
        # rather than assumption": a raw record with no usable `images`
        # array at all, but carrying a bare `thumbnail` STRING, predates
        # this `images` candidate list. That is provably safe to grandfather
        # rather than hide: the OLD selection rule this key came from
        # (`pick_gallery_image_url`, unchanged below) only ever accepted an
        # `nsfwLevel` in `(None, 0, 1, 2)` or the `_is_adult_image`
        # `level < 4` fallback -- and since Civitai's real levels are
        # `1, 2, 4, 8, 16`, ANY url that rule could ever have picked is
        # provably level <= 2. So it becomes a one-entry candidate list at
        # level 2 (PG-13), not "unknown" (which would needlessly blank an
        # already-cached, already-safe panel).
        legacy_thumbnail = obj.get("thumbnail")
        if isinstance(legacy_thumbnail, str) and legacy_thumbnail:
            out["images"] = [{"url": legacy_thumbnail, "nsfw_level": 2, "type": ""}]
            out["images_schema"] = "legacy"

    return out


# docs/lora-loader-design.md §7c-iv: THREE named Civitai CDN transforms,
# not scattered literals. `LIVE_THUMB_TRANSFORM` carries `anim=false` (a
# no-op on a still image, byte-identical either way; a poster-frame
# extractor on a `type: "video"` entry, since `width=<n>` alone makes the
# CDN transcode actual video -- `200 video/mp4`, ~1.66 MB, often timing out,
# and unrenderable in an `<img>` regardless -- see `_rewrite_transform`'s
# own docstring for the measured bytes).
LIVE_THUMB_TRANSFORM = "anim=false,width=256"    # search card + ⓘ panel thumb
SOURCE_TRANSFORM = "original=true"                # the untransformed source file

# Owner reversal, 2026-07-31: "save the ORIGINAL image on disk, downscale
# when SERVING it to a small UI box" -- see `saved_preview_url`'s own
# docstring. `SOURCE_TRANSFORM` (above) is now what a saved STILL preview
# uses. A video candidate can't use `SOURCE_TRANSFORM` at all though --
# measured live 2026-07-31, `original=true` on a video entry returns the
# actual `video/mp4` (2,768,985 B), unusable as a preview image -- so a
# video still needs a poster-frame extraction, and that needs `anim=false`
# PLUS a width (`anim=false` alone, no width, STILL returns `video/mp4`,
# also measured). The width VALUE below is a pure formality once
# `anim=false` is present: measured byte-identical (64,550 B) at
# width=256, 450, 1024 AND 4096 -- the CDN serves one stored poster frame
# regardless of the number. Do not "optimise" this number later expecting
# a size change; there isn't one to get.
SAVED_PREVIEW_VIDEO_TRANSFORM = "anim=false,width=256"

# `saved_preview_url`'s own "is this a video" sniff -- deliberately a small,
# SPECIFIC list of extensions actually seen on Civitai's gallery
# `type: "video"` entries (`.mp4`, measured), not a generic video-format
# list, since a false positive here would needlessly poster-frame a still
# and a false negative would let a video's raw bytes back through to
# `SOURCE_TRANSFORM` (caught by `fetch_preview_image`'s Content-Type
# backstop regardless -- see `saved_preview_url`'s own docstring).
_VIDEO_URL_EXTENSIONS = frozenset({".mp4", ".webm", ".mov", ".m4v"})


def _url_extension(url: Any) -> str:
    """`url`'s own trailing file extension, lowercased with the leading dot
    (e.g. `".mp4"`, `".jpeg"`, or `""` for none/non-string input) -- read off
    the URL's PATH component only (`urlsplit`), so a query string can never
    masquerade as the extension. None of the Civitai CDN URLs this module
    handles carry a query string, but this keeps the check honest either
    way rather than assuming that shape.
    """
    if not isinstance(url, str) or not url:
        return ""
    return os.path.splitext(urlsplit(url).path)[1].lower()


# Matches ANY Civitai transform path segment -- `/original=true/`,
# `/original=true,quality=90/`, `/width=256/`, `/anim=false,width=256/`, ...
# -- by shape (a segment that is itself one or more comma-separated
# `key=value` tokens) rather than one specific literal, so the rewrite below
# can NORMALISE a URL that already carries any of the three transforms, not
# only replace `original=true`. A hash/UUID/filename path segment never
# contains `=`, so this can't accidentally eat one of those.
_TRANSFORM_SEG_RE = re.compile(r"/[a-zA-Z][a-zA-Z0-9]*=[^/]*/")


def _rewrite_transform(url: str, transform: str) -> str:
    """Swap WHATEVER Civitai transform segment `url` already carries for
    `transform` (one of the three named constants above) -- the ONE shared
    rewrite helper every `_thumb_url`/`saved_preview_url` call goes through,
    so there is exactly one regex to keep in sync rather than three copies
    of it (docs/lora-loader-design.md §7c-iv, "Three named transforms, not
    scattered literals").

    ⚠️ Must normalise an ALREADY-transformed URL, not only `original=true`:
    the frontend hands back a URL it is already displaying (carrying
    `anim=false,width=256`, our own live-thumbnail rewrite) when the user
    downloads that same candidate, and that has to become `width=450` for
    the saved preview -- so this replaces `original=true`, an existing
    `width=<n>` (with or without `anim=false` alongside it), or any other
    transform segment shape uniformly. A URL with NO transform segment at
    all passes through completely untouched -- there is nothing to swap,
    and inventing a segment for a URL shape we don't recognise would be a
    guess, not a rewrite.

    Measured live 2026-07-31, on the same two URLs throughout §7c-iv (a
    still and a video-preview entry):

    | target                        | still                | video                 |
    |-------------------------------|-----------------------|------------------------|
    | `original=true` (source)      | `image/png` 4,192,036 B | `video/mp4` 2,768,985 B |
    | `anim=false,width=256` (live)  | `image/jpeg` 20,522 B  | `image/jpeg` 64,550 B (poster) |
    | `anim=false,width=450` (saved) | `image/jpeg` 36,481 B  | `image/jpeg` 64,550 B (poster) |

    (A video's poster frame comes back at the same 64,550 B for both
    `width=256` and `width=450` -- the CDN appears to serve one stored still
    regardless of the requested width; harmless, just don't expect the
    width parameter to change video output.)
    """
    if not isinstance(url, str) or not url:
        return url
    new_url, count = _TRANSFORM_SEG_RE.subn(f"/{transform}/", url, count=1)
    return new_url if count else url


def _thumb_url(url: str) -> str:
    """Rewrite `url` to `LIVE_THUMB_TRANSFORM` (`anim=false,width=256`) -- a
    thumbnail needs roughly 20 KB, not the ~1.5-4 MB the original-resolution
    image costs (same measurement as `../ComfyUI-Pixaroma/nodes/
    _lora_helpers.py:361-374`'s own `_thumb_url`, MIT,
    THIRD_PARTY_NOTICES.md, extended here with `anim=false` and generalised
    to `_rewrite_transform` so it also normalises an ALREADY-rewritten or
    already-`width=<n>` URL, not just `original=true`). A thin wrapper --
    see `_rewrite_transform`'s own docstring for the shared mechanism and
    the measured bytes.
    """
    return _rewrite_transform(url, LIVE_THUMB_TRANSFORM)


def saved_preview_url(url: str) -> str:
    """Rewrite `url` to the transform the saved preview should ACTUALLY be
    fetched at -- **type-conditional**, per the owner's 2026-07-31 reversal
    of the same-day "SETTLED: the saved preview is `anim=false,width=450`"
    decision (docs/lora-loader-design.md §7c-iv): *"save the ORIGINAL image
    on disk, and downscale when serving it to a small UI box"* -- a future
    in-pack browser wants to display the saved preview at full size, so the
    file on disk should BE the original, not a pre-shrunk copy. Downscaling
    for today's small on-screen box moved to SERVE time instead
    (`api.py`'s `downscale_thumb_bytes`/`thumb_bytes_impl`, behind
    `/wtn/model_browser/thumb`).

    But `original=true` on a VIDEO entry returns the actual video
    (`video/mp4`, measured 2,768,985 B) -- unusable as a preview image, and
    NOT something `download.fetch_preview_image`'s Content-Type map would
    ever accept (see that map's own docstring), so a video candidate must
    still go through a poster-frame extraction rather than the untransformed
    source. This function decides "is `url` a video" by sniffing the URL's
    OWN trailing file extension (`_url_extension`) -- self-contained and
    reliable here, since every URL this module handles ends in the real
    media extension (`.mp4`, `.jpeg`, ...) -- rather than threading the
    gallery entry's `type` field through from the caller, which would need
    a second parameter on every call site for a fact the URL string already
    carries on its own.

      - a recognised video extension (`_VIDEO_URL_EXTENSIONS`) -> rewritten
        to `SAVED_PREVIEW_VIDEO_TRANSFORM` (`anim=false,width=256`, a
        poster frame -- see that constant's own docstring for why the
        width number doesn't matter once `anim=false` is present);
      - anything else (a still, or an extension this function doesn't
        recognise) -> rewritten to `SOURCE_TRANSFORM` (`original=true`,
        the untransformed original) -- the owner's actual ask.

    Belt and braces either way: if a video ever slips through misidentified
    as a still (an extension this function doesn't recognise, say), the
    resulting fetch still comes back `Content-Type: video/mp4`, which
    `download._PREVIEW_CONTENT_TYPES` does not map to an extension --
    `fetch_preview_image` refuses to write ANY file in that case, rather
    than saving an `.mp4` under an image extension. That backstop is what
    made the original bug (a video's raw bytes silently saved as a
    "preview image") possible to fix in the first place, and it still
    holds after this reversal.

    `download.fetch_preview_image` is the only caller -- it normalises
    whatever URL it's handed (untransformed `original=true`, an existing
    `anim=false,width=256` the frontend is already displaying, or anything
    else) through this function before ever fetching, so the level-
    awareness this needs comes for free from the caller already having
    filtered its candidate by the user's browsing level (§7c-iv, "the
    sidecar's level applies at SAVE time... from the CALLER, not from a
    new parameter") -- this function itself has no idea what a browsing
    level even is, by design.
    """
    if _url_extension(url) in _VIDEO_URL_EXTENSIONS:
        return _rewrite_transform(url, SAVED_PREVIEW_VIDEO_TRANSFORM)
    return _rewrite_transform(url, SOURCE_TRANSFORM)


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
    `anim=false,width=256` rewrite) -- same two-tier fallback as the
    thumbnail-selection loop inside `../ComfyUI-Pixaroma/nodes/_lora_helpers.py
    :401-419`'s `parse_civitai_modelversion` (MIT, THIRD_PARTY_NOTICES.md),
    so a model whose gallery is entirely explicit ends up with NO thumbnail
    rather than an explicit one. A thin wrapper over `pick_gallery_image_url`
    (above), which now holds the actual selection loop.

    Public (promoted from `_pick_thumbnail`, docs task 2026-07-31, "Civitai
    search panel thumbnails"). **Neither `parse_model_version` nor
    `civitai_search.py`'s own `_parse_version` calls this any more**
    (docs/lora-loader-design.md §7c-iv, 2026-07-31, "the ⓘ panel's
    candidates live in the sidecar" / "Send the CANDIDATES to the frontend,
    not one pre-chosen URL"): once the browsing level became a user
    setting, picking ONE image ahead of time stopped being either layer's
    job -- both now hand over the full `images` candidate list instead
    (`parse_gallery_images`, each entry thumbnail-rewritten via `_thumb_url`
    directly, not through this function's own adult-filtering pick), and a
    caller (the frontend, or a future consumer) picks. This function's
    hardcoded level-4 cutoff (via `pick_gallery_image_url`) remains exactly
    what it always was for whatever still calls it directly (kept per this
    task's own "stays as they are unless something genuinely no longer uses
    it" constraint) -- that cutoff was never this function's problem to
    generalize, only its two callers stopped using it.
    """
    url = pick_gallery_image_url(images)
    return _thumb_url(url) if url else None


# Old private name kept as a plain alias -- `tests/test_model_browser.py`'s
# own `test_pick_thumbnail_still_transforms_its_own_result` (and any other
# existing internal call site) still reaches this under its original name,
# unchanged.
_pick_thumbnail = pick_thumbnail_url


def parse_gallery_images(images_raw: Any) -> List[Dict[str, Any]]:
    """A version's raw `images` gallery -> an ordered list of
    `{url, nsfw_level, type}` CANDIDATES, each `url` already thumbnail-
    rewritten (`_thumb_url`'s `anim=false,width=256`) -- docs/lora-loader-
    design.md §7c-iv, "Send the CANDIDATES to the frontend, not one
    pre-chosen URL". Once the browsing level is a user setting, picking a
    single image ahead of time is a CALLER decision (it knows the viewer's
    chosen level; this layer doesn't), so this function hands over every
    usable entry rather than selecting one -- unlike `pick_gallery_image_url`
    /`pick_thumbnail_url`, it does NOT filter by adult-ness at all; every
    level from the response is included, in the SAME order Civitai returned
    them, so a caller can walk it "first at or below my level, falling
    forward on failure".

    Only entries with a truthy `url` are kept (an entry with no URL at all
    is not a usable candidate for anything). `nsfw_level` is that entry's
    own `nsfwLevel`, or `None` when absent -- absent means UNKNOWN, never
    "safe": an existing sidecar/cached search result predates this field
    entirely, and inventing a safe default for it would defeat the whole
    point of a level ceiling. `type` is the entry's own `type` (`"image"`/
    `"video"`), or `""` when absent -- a video entry is a normal candidate
    here, not something to drop: `_thumb_url`'s `anim=false` is exactly what
    makes a video's poster frame renderable, so filtering video out here
    would throw away the fix.

    Shared by BOTH consumers -- `parse_model_version`'s own `images` key
    (the ⓘ panel, §7c-iv's THIRD consumer) and `civitai_search.py`'s
    `_parse_version` (the search card, via that module's own `_parse_images`
    alias to this function) -- so the candidate-list rule lives in exactly
    one place rather than drifting into two copies.
    """
    if not isinstance(images_raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for image in images_raw:
        if not isinstance(image, dict):
            continue
        url = image.get("url")
        if not url:
            continue
        level = image.get("nsfwLevel")
        out.append({
            "url": _thumb_url(str(url)),
            "nsfw_level": level if isinstance(level, int) and not isinstance(level, bool) else None,
            "type": str(image.get("type") or ""),
        })
    return out


def parse_author_gallery(images_raw: Any) -> List[Dict[str, Any]]:
    """The AUTHOR's own gallery -- a model-VERSION object's own `images`
    array, as returned by `civitai_client.lookup_model_version_by_id`'s
    `/api/v1/model-versions/{id}` -- into an ordered list of PROMPT-carrying
    candidates for the model/version detail view's own gallery
    (docs/lora-loader-design.md, "The detail view", the 2026-08-01 measured
    correction at the top of that section):

    | source | sampled | carrying a prompt |
    |---|---|---|
    | `/api/v1/images?modelVersionId=...` (community) | 40 | 0 -- `meta` is `{}` |
    | `/api/v1/model-versions/{id}` (THIS function's input) | 20 | 18, with `seed`/`steps`/`sampler`/`Size`/`Model` |

    So this is the gallery this pack actually builds the detail view's own
    community-images section from -- the community endpoint would produce a
    grid of pictures with nothing to copy, which the design doc's own test
    ("a gallery without reusable prompts is decoration") rules out.

    Each entry: `{url, nsfw_level, type, prompt?, negative_prompt?,
    params?: {sampler?, steps?, cfg?, size?}}`. `url` is thumbnail-rewritten
    (`_thumb_url`) -- the SAME level-aware candidate/retry/skeleton machinery
    (`js/shared/civitai_thumb.mjs`) that already serves every other gallery
    in this package serves this one too, no second mechanism. `prompt`/
    `negative_prompt`/`params` are read from the image's own `meta` dict
    (Civitai's own per-generation metadata); a missing/empty `meta` -- the
    community endpoint's own shape, or an author image that genuinely has no
    recorded generation info -- degrades to an entry with NONE of those
    optional keys set, never an invented empty string/zero: a caller (the
    detail view) reads their absence as "no hover overlay for this one"
    rather than showing an empty box (task brief: "an image with no meta
    degrading cleanly rather than showing an empty hover"). `size` prefers
    `meta["Size"]` (Civitai's own pre-formatted `"832x1216"`-shaped string)
    and falls back to the image's own top-level `width`/`height` pair when
    that's absent.

    Only entries with a truthy `url` are kept, same "not a usable candidate
    otherwise" rule `parse_gallery_images` already applies; `nsfw_level`/
    `type` follow that function's own conventions verbatim (an absent level
    is UNKNOWN, never assumed safe). Non-list input -> `[]`; never raises.

    Deliberately a SEPARATE function from `parse_gallery_images` rather than
    that one extended with optional prompt/params keys: every OTHER consumer
    of `parse_gallery_images` (the search card, the ⓘ panel) reads ONLY the
    community-shaped `/api/v1/models`-embedded gallery, which never carries a
    usable `meta` at all (measured above) -- adding prompt/params fields
    there would be dead weight on every existing call site for a shape only
    this one new caller ever populates.
    """
    if not isinstance(images_raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for image in images_raw:
        if not isinstance(image, dict):
            continue
        url = image.get("url")
        if not url:
            continue
        level = image.get("nsfwLevel")
        meta = image.get("meta") if isinstance(image.get("meta"), dict) else {}

        entry: Dict[str, Any] = {
            "url": _thumb_url(str(url)),
            "nsfw_level": level if isinstance(level, int) and not isinstance(level, bool) else None,
            "type": str(image.get("type") or ""),
        }

        prompt = meta.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            entry["prompt"] = prompt
        negative_prompt = meta.get("negativePrompt")
        if isinstance(negative_prompt, str) and negative_prompt.strip():
            entry["negative_prompt"] = negative_prompt

        params: Dict[str, Any] = {}
        sampler = meta.get("sampler")
        if isinstance(sampler, str) and sampler.strip():
            params["sampler"] = sampler
        steps = meta.get("steps")
        if isinstance(steps, int) and not isinstance(steps, bool):
            params["steps"] = steps
        cfg = meta.get("cfgScale")
        if isinstance(cfg, (int, float)) and not isinstance(cfg, bool):
            params["cfg"] = cfg
        size = meta.get("Size")
        if not (isinstance(size, str) and size.strip()):
            width, height = image.get("width"), image.get("height")
            has_dims = (
                isinstance(width, int) and not isinstance(width, bool)
                and isinstance(height, int) and not isinstance(height, bool)
            )
            size = f"{width}x{height}" if has_dims else None
        if isinstance(size, str) and size.strip():
            params["size"] = size
        if params:
            entry["params"] = params

        out.append(entry)
    return out


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
    "pick_gallery_image_url", "pick_thumbnail_url", "parse_gallery_images",
    "parse_author_gallery",
    "civitai_shape_from_search_meta",
    "LIVE_THUMB_TRANSFORM", "SAVED_PREVIEW_VIDEO_TRANSFORM", "SOURCE_TRANSFORM",
    "saved_preview_url",
)
