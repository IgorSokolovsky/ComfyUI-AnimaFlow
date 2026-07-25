"""Pure logic for the Prompt Builder node — no ComfyUI imports.

Kept separate from `node_prompt_builder.py` so it can be unit-tested in
isolation (see `test_prompt_builder.py` at the repo root) and so the node
file itself stays thin, per the Pixaroma-style node + `_helpers.py` split.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

DEFAULT_TEMPLATE = (
    "{character}, {hair_style}, {hair_color}, {eyes}, {body_type}, "
    "{skin}, {marks}, {breasts}, {genital_state}, {body_details}"
)

_TOKEN_RE = re.compile(r"\{([a-zA-Z0-9_]+)\}")


def parse_tokens(template: str) -> list[str]:
    """Extract unique `{token}` names from `template`, in first-appearance order."""
    seen: set[str] = set()
    tokens: list[str] = []
    for match in _TOKEN_RE.finditer(template or ""):
        token = match.group(1)
        if token not in seen:
            seen.add(token)
            tokens.append(token)
    return tokens


def humanize(token: str) -> str:
    """`hair_style` -> "Hair Style". Splits on `_`, capitalizes each word."""
    return " ".join(word.capitalize() for word in token.split("_") if word)


def render_prompt(template: str, values: dict) -> str:
    """Fill `{token}` placeholders in `template` from `values`, then clean up.

    Missing tokens render as empty string. After substitution the result is
    split on `,`, each piece is stripped, empty pieces are dropped, and the
    remaining pieces are rejoined with `", "` (so blank fields don't leave
    dangling `, ,` or a leading/trailing comma).
    """

    def _replace(match: re.Match) -> str:
        return str(values.get(match.group(1), ""))

    filled = _TOKEN_RE.sub(_replace, template or "")
    pieces = [piece.strip() for piece in filled.split(",")]
    pieces = [piece for piece in pieces if piece]
    return ", ".join(pieces)


def build_field_text(values: dict) -> str:
    """Render `values` as labeled PROSE lines, in `values`' iteration order.

    Callers pass an already token-ordered dict (see `PromptBuilder.build` /
    `PromptCombiner.combine`, which build `values` via a dict comprehension
    over the parsed token list), so the emitted lines follow the template's
    token order. Each non-empty value becomes one `"<Humanize(token)>: <value>"`
    line (see `humanize`); empty/whitespace-only values are dropped entirely
    (no dangling label, no blank line). Lines are joined with a single `"\n"`.

    A structured JSON document (`{token: value}`) was tried first but proved
    noisy for a Qwen-style text encoder (Anima) — braces/quotes read as
    literal tokens rather than structure — so this labeled-prose format
    replaced it as the node's primary output (see `build_scene_text` in
    `_scene_creator_helpers.py` for the richer per-character version of the
    same idea).
    """
    lines = []
    for token, value in values.items():
        text = str(value or "").strip()
        if text:
            lines.append(f"{humanize(token)}: {text}")
    return "\n".join(lines)


def parse_state(raw: str) -> dict:
    """Parse the hidden `prompt_builder_state` JSON string into a fields dict.

    Any failure (invalid JSON, wrong shape, missing "fields" key) yields `{}`.
    """
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    fields = data.get("fields", {})
    if not isinstance(fields, dict):
        return {}
    return fields


@dataclass(frozen=True)
class PromptData:
    """The `PROMPT_DATA` payload returned alongside the rendered prompt string.

    `prompt` stays the FLAT, comma-joined string (unchanged behavior) so a
    wired socket->socket connection downstream (via `unwrap_value`) still
    gets plain text rather than the structured text blob. `structured_str`
    is the labeled-prose document (see `build_field_text`), exposed under
    the `"structured"` key — that's the node's primary output now.
    """

    template: str
    fields: dict = field(default_factory=dict)
    prompt: str = ""
    structured_str: str = ""
    name: str = "prompt"

    def as_dict(self) -> dict:
        return {
            "template": self.template,
            "fields": dict(self.fields),
            "prompt": self.prompt,
            "structured": self.structured_str,
            "name": self.name,
        }


def build_prompt_data(template: str, values: dict, prompt: str, structured_str: str) -> dict:
    """Assemble the PROMPT_DATA dict: template, fields, flat prompt, structured text, name."""
    name = (values.get("character", "") or "").strip() or "prompt"
    return PromptData(
        template=template,
        fields=dict(values),
        prompt=prompt,
        structured_str=structured_str,
        name=name,
    ).as_dict()
