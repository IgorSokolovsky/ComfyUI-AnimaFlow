"""Pure logic for the Scene Creator node — no ComfyUI imports.

Kept separate from `node_scene_creator.py` so it can be unit-tested in
isolation (see `test_scene_creator.py` at the repo root) and so the node
file itself stays thin, per the Pixaroma-style node + `_helpers.py` split.

`parse_tokens` / `render_prompt` / `humanize` are shared with the Prompt
Builder node (imported from `_prompt_builder_helpers`); `unwrap_value` /
`ContainsAnyDict` are shared with the Prompt Combiner node (imported from
`_prompt_combiner_helpers`) rather than duplicated here.

The node's primary output is a STRUCTURED document assembled as LABELED
PROSE SECTIONS (see `build_scene_text`), not JSON: a JSON `{token: value}`
document was tried first, but the target model (Anima) uses a Qwen LLM text
encoder for which braces/quotes read as literal noise tokens rather than
structure. Labeled prose ("Composition: rule of thirds", one paragraph per
character) keeps the same information-dense per-character grouping (still
avoiding attribute/pose bleed between characters) without any JSON syntax
the encoder would otherwise have to "read past". A flat string is still
assembled (`render_prompt` over the scene fields, `flatten_characters_block`
for the characters piece) and carried on PROMPT_DATA's `"prompt"` key for
back-compat with any wired socket->socket downstream node that calls
`unwrap_value`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from ._prompt_builder_helpers import humanize, parse_tokens, render_prompt  # noqa: F401 (re-exported)
from ._prompt_combiner_helpers import ContainsAnyDict, unwrap_value  # noqa: F401 (re-exported)

RESERVED_CHARACTERS_TOKEN = "characters"
RESERVED_BACKGROUNDS_TOKEN = "backgrounds"

# The one token rendered UNLABELED, as a bare lead line ahead of everything
# else (see `build_scene_text`) — e.g. booru quality/rating tags, which read
# better as a plain leading clause than under a "Tags:" label.
LEAD_TOKEN = "tags"

# Tokens rendered as bare UNLABELED lines in the trailing "tail" bucket (see
# `build_scene_text`) — free-form scene description / shot (camera+lighting
# merged by the user into one field) prose, in that order.
TAIL_TOKENS = {"scene_description", "shot"}

DEFAULT_TEMPLATE = "{tags}, {characters}, {backgrounds}, {scene_description}, {shot}"


def _normalize_outfits(character: dict) -> list:
    """Return `character`'s outfits as a normalized list of entry dicts.

    The current shape is a list under `"outfits"`: `[{"socket": "...",
    "text": "...", "enabled": True}, ...]`. Older states instead carried a
    single scalar `"outfit"` text field (optionally paired with a scalar
    `"outfit_socket"`); that legacy shape is normalized here into an
    equivalent single-entry `outfits` list so callers only ever deal with
    the list form. A character with neither shape yields `[]`.
    """
    outfits = character.get("outfits")
    if isinstance(outfits, list):
        return [o for o in outfits if isinstance(o, dict)]

    if "outfit" in character or "outfit_socket" in character:
        return [
            {
                "socket": character.get("outfit_socket") or "",
                "text": character.get("outfit", ""),
                "enabled": True,
            }
        ]

    return []


def _normalize_character(character: dict) -> dict:
    """Normalize a raw character dict into the canonical shape.

    Canonical fields: `socket`, `name`, `enabled`, `appearance` (plain
    text), `action` (the character's pose/expression/action text), `focus`
    (plain text), `outfits` (see `_normalize_outfits`).

    Two migrations happen here:
    - `outfits` is normalized from either shape (see `_normalize_outfits`).
    - Older states used `"expression"` instead of `"action"`; if a loaded
      character has `expression` but no `action` key at all, `expression`'s
      value is copied over to `action`. Either way, `expression` itself is
      dropped from the result — `action` is the only canonical key from
      here on.
    """
    result = dict(character)
    result["outfits"] = _normalize_outfits(character)
    if "expression" in result:
        if "action" not in result:
            result["action"] = result.get("expression", "")
        del result["expression"]
    return result


def _migrate_legacy_scene_fields(fields: dict) -> dict:
    """Best-effort migration for an OLDER `scene_state.fields` that used the
    previous `composition`/`camera`/`lighting` scene-field split instead of
    the current `scene_description`/`shot` pair (see `DEFAULT_TEMPLATE` /
    `TAIL_TOKENS`).

    `composition` maps to `scene_description` (only if that key is
    otherwise absent and `composition` is non-empty); `camera` and
    `lighting` (non-empty values joined with `", "`) map to `shot` (only if
    `shot` is otherwise absent). The legacy keys themselves are left
    untouched — this only ever ADDS the new keys, so an old node's saved
    field values aren't lost, and a node whose template still references the
    legacy tokens keeps working unmodified. A node that never had the legacy
    keys (or already has the new ones) is left alone entirely. The `shot`
    migration is keyed on the presence of `camera` specifically (not
    `lighting` alone) — `lighting` alone is common enough as an unrelated,
    coincidentally-named custom scene field that triggering on it alone
    would be too eager; `camera`+`composition` together are the distinctive
    fingerprint of the OLD default template.
    """
    if "scene_description" not in fields and str(fields.get("composition", "") or "").strip():
        fields = dict(fields)
        fields["scene_description"] = str(fields["composition"]).strip()

    if "shot" not in fields and "camera" in fields:
        camera = str(fields.get("camera", "") or "").strip()
        lighting = str(fields.get("lighting", "") or "").strip()
        shot = ", ".join(piece for piece in (camera, lighting) if piece)
        if shot:
            fields = dict(fields)
            fields["shot"] = shot

    return fields


def parse_scene_state(raw: str) -> tuple[dict, list, list]:
    """Parse the hidden `scene_state` JSON string into `(fields, characters,
    backgrounds)`.

    Any failure (invalid JSON, wrong shape, missing/mistyped keys) yields
    `({}, [], [])`; a valid document with a malformed `fields`, `characters`,
    or `backgrounds` value falls back to `{}` / `[]` / `[]` respectively for
    that piece. Older states with no `backgrounds` key still parse cleanly —
    missing pieces just default to empty. Each character is normalized via
    `_normalize_character` (outfits normalization + `expression`->`action`
    migration), so a legacy scalar `"outfit"`/`"outfit_socket"` or
    `"expression"`-only character still works. `fields` gets the best-effort
    `composition`/`camera`/`lighting` -> `scene_description`/`shot` migration
    (see `_migrate_legacy_scene_fields`).
    """
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}, [], []
    if not isinstance(data, dict):
        return {}, [], []

    fields = data.get("fields", {})
    if not isinstance(fields, dict):
        fields = {}
    fields = _migrate_legacy_scene_fields(fields)

    characters = data.get("characters", [])
    if not isinstance(characters, list):
        characters = []
    characters = [c for c in characters if isinstance(c, dict)]
    characters = [_normalize_character(c) for c in characters]

    backgrounds = data.get("backgrounds", [])
    if not isinstance(backgrounds, list):
        backgrounds = []
    backgrounds = [b for b in backgrounds if isinstance(b, dict)]

    return fields, characters, backgrounds


def _assemble_outfits_block(outfits: list, kwargs: dict) -> str:
    """Join an (already-normalized) character's enabled outfit entries.

    Each entry looks like `{"socket": "char_1_outfit_1", "text": "...",
    "enabled": True}`. Disabled entries are skipped. For each enabled entry
    the wired `socket` value (unwrapped) overrides the `text` field when
    non-empty; otherwise `text` is used. Entries are processed in order and
    joined with `", "`, dropping empty pieces.
    """
    pieces: list[str] = []
    for entry in outfits:
        if not entry.get("enabled"):
            continue

        wire = unwrap_value(kwargs.get(entry.get("socket"))).strip()
        value = wire if wire else str(entry.get("text", "") or "").strip()
        if value:
            pieces.append(value)

    return ", ".join(pieces)


def assemble_characters(characters: list, kwargs: dict) -> list[dict]:
    """Build the structured `"characters"` array from enabled character entries.

    Each entry looks like the canonical shape from `_normalize_character`:
    `{"socket": "char_1", "name": "...", "enabled": True, "appearance":
    "...", "action": "...", "focus": "...", "outfits": [...]}`. Disabled
    characters are skipped entirely. For each enabled character:

    - `appearance` is the wired `socket` value (unwrapped) when non-empty,
      else the character's own `appearance` text field.
    - `clothes` is the joined result of that character's enabled outfit
      entries (`_assemble_outfits_block`; each entry's wired socket
      overrides its text).
    - `action` / `focus` are the character's own text fields.

    The emitted dict always has a `"name"` key; `appearance`, `clothes`,
    `action`, and `focus` are included only when non-empty, keeping the
    JSON tidy. A character is skipped entirely (not just left name-only) if
    ALL of appearance/clothes/action/focus/name are empty.
    """
    result: list[dict] = []
    for character in characters:
        if not character.get("enabled"):
            continue

        socket = character.get("socket")
        wired = unwrap_value(kwargs.get(socket)).strip()
        appearance = wired if wired else str(character.get("appearance", "") or "").strip()

        outfits = character.get("outfits")
        if not isinstance(outfits, list):
            outfits = _normalize_outfits(character)
        clothes = _assemble_outfits_block(outfits, kwargs)

        action = str(character.get("action", "") or "").strip()
        focus = str(character.get("focus", "") or "").strip()
        name = str(character.get("name", "") or "").strip()

        if not any([name, appearance, clothes, action, focus]):
            continue

        entry: dict = {"name": name}
        if appearance:
            entry["appearance"] = appearance
        if clothes:
            entry["clothes"] = clothes
        if action:
            entry["action"] = action
        if focus:
            entry["focus"] = focus
        result.append(entry)

    return result


def flatten_characters_block(characters_list: list) -> str:
    """Join the structured character dicts (from `assemble_characters`) into
    the flat `{characters}` substitution used for PROMPT_DATA's `.prompt`.

    Each character dict's non-empty values (in their existing key order:
    name, appearance, clothes, action, focus) are joined with `", "`; the
    per-character strings are then joined with `", "`.
    """
    blocks: list[str] = []
    for character in characters_list:
        pieces = [str(value).strip() for value in character.values() if str(value).strip()]
        if pieces:
            blocks.append(", ".join(pieces))
    return ", ".join(blocks)


def assemble_background_block(backgrounds: list, kwargs: dict) -> str:
    """Build the `{backgrounds}` substitution from enabled background entries.

    Each entry looks like `{"socket": "bg_1", "enabled": True, "text":
    "..."}`. Disabled backgrounds are skipped entirely. For each enabled
    background, the wired socket's value (a PROMPT_DATA dict or plain
    string, unwrapped via `unwrap_value`) plus its optional `text` are
    joined with `", "`, dropping any empty or whitespace-only piece. The
    per-background blocks are then joined with `", "`.
    """
    blocks: list[str] = []
    for background in backgrounds:
        if not background.get("enabled"):
            continue

        socket = background.get("socket")
        tags = unwrap_value(kwargs.get(socket))
        text = str(background.get("text", "") or "").strip()

        pieces = [piece.strip() for piece in (tags, text)]
        pieces = [piece for piece in pieces if piece]
        if pieces:
            blocks.append(", ".join(pieces))

    return ", ".join(blocks)


def render_character_paragraph(character: dict) -> str:
    """Render one `assemble_characters` entry as a labeled prose paragraph.

    Takes the present sub-values in the fixed order `appearance`, `clothes`,
    `action`, `focus`, each stripped, and joins them with `", "`, then
    appends a single trailing `;` to the whole paragraph. The paragraph is
    prefixed with `"<name>: "` when `name` is non-empty, else it's just the
    body (still `;`-terminated). A character with a name but no body (all
    four sub-values empty — e.g. a name-only cameo) yields just the bare
    name — no `";"`, no dangling `": "`.
    """
    name = str(character.get("name", "") or "").strip()
    pieces = []
    for key in ("appearance", "clothes", "action", "focus"):
        value = str(character.get(key, "") or "").strip()
        if value:
            pieces.append(value)

    if not pieces:
        return name

    body = ", ".join(pieces) + ";"
    return f"{name}: {body}" if name else body


def build_scene_text(
    template: str, fields: dict, characters_list: list, background_block: str
) -> str:
    """Assemble the scene as LABELED PROSE SECTIONS (see the module
    docstring for why this replaced a JSON document).

    Each `{token}` from `parse_tokens(template)` routes into one of four
    FIXED-ORDER buckets (the final section order is lead -> characters ->
    labeled -> tail, regardless of where each token actually sits in the
    template):

    - `LEAD_TOKEN` (`"tags"`): rendered UNLABELED as a bare lead line — the
      one token exempt from labeling (no trailing punctuation added). Only
      ever one such line.
    - The reserved `characters` token: each `assemble_characters` entry
      becomes one paragraph (`render_character_paragraph`); paragraphs are
      joined with a blank line (`"\\n\\n"`) between characters.
    - LABELED: the reserved `backgrounds` token becomes a single
      `"Background: <value>;"` line; any OTHER token that isn't in
      `TAIL_TOKENS` becomes `"<Humanize(token)>: <value>;"` (kept for
      extensibility — no custom scene field currently exercises this) —
      EVERY labeled line ends with a trailing `;`. Preserves the template's
      token order, packed with a single `"\\n"` between lines (no blank
      lines within this section).
    - TAIL: any token in `TAIL_TOKENS` (`"scene_description"`, `"shot"`)
      renders as a bare UNLABELED value line — no label, no punctuation.
      Preserves the template's token order, packed with a single `"\\n"`
      between lines.

    Any empty value (blank field, empty characters list, empty background)
    is dropped entirely — no empty lines, no dangling labels. The four
    bucket results are then joined with a blank line (`"\\n\\n"`), skipping
    any bucket that ended up empty.
    """
    lead = ""
    character_block = ""
    labeled_lines: list[str] = []
    tail_lines: list[str] = []

    for token in parse_tokens(template):
        if token == LEAD_TOKEN:
            lead = str(fields.get(token, "") or "").strip()
        elif token == RESERVED_CHARACTERS_TOKEN:
            paragraphs = [render_character_paragraph(c) for c in characters_list]
            character_block = "\n\n".join(p for p in paragraphs if p)
        elif token == RESERVED_BACKGROUNDS_TOKEN:
            background = str(background_block or "").strip()
            if background:
                labeled_lines.append(f"Background: {background};")
        elif token in TAIL_TOKENS:
            value = str(fields.get(token, "") or "").strip()
            if value:
                tail_lines.append(value)
        else:
            value = str(fields.get(token, "") or "").strip()
            if value:
                labeled_lines.append(f"{humanize(token)}: {value};")

    parts = [
        part
        for part in (lead, character_block, "\n".join(labeled_lines), "\n".join(tail_lines))
        if part
    ]
    return "\n\n".join(parts)


@dataclass(frozen=True)
class ScenePromptData:
    """The `PROMPT_DATA` payload returned alongside the rendered scene string.

    `prompt` stays the FLAT, comma-joined scene string (unchanged behavior)
    so a wired socket->socket connection downstream (via `unwrap_value`)
    still gets plain text rather than the structured text blob.
    `structured_str` is the labeled-prose scene document (see
    `build_scene_text`), exposed under the `"structured"` key — that's the
    node's primary output now.
    """

    template: str
    fields: dict = field(default_factory=dict)
    prompt: str = ""
    structured_str: str = ""
    name: str = "scene"

    def as_dict(self) -> dict:
        return {
            "template": self.template,
            "fields": dict(self.fields),
            "prompt": self.prompt,
            "structured": self.structured_str,
            "name": self.name,
        }


def build_scene_data(template: str, values: dict, prompt: str, structured_str: str) -> dict:
    """Assemble the PROMPT_DATA dict: template, fields, flat scene, structured text, name."""
    return ScenePromptData(
        template=template,
        fields=dict(values),
        prompt=prompt,
        structured_str=structured_str,
        name="scene",
    ).as_dict()
