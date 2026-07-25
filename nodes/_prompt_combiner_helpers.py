"""Pure logic for the Prompt Combiner node — no ComfyUI imports.

Kept separate from `node_prompt_combiner.py` so it can be unit-tested in
isolation (see `test_prompt_combiner.py` at the repo root) and so the node
file itself stays thin, per the Pixaroma-style node + `_helpers.py` split.

`parse_tokens` / `render_prompt` are shared with the Prompt Builder node and
are imported from `_prompt_builder_helpers` rather than duplicated here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ._prompt_builder_helpers import (  # noqa: F401 (re-exported)
    build_field_text,
    parse_tokens,
    render_prompt,
)


class AnyType(str):
    """A type string that is equal to every other type (ComfyUI validates
    connections with `!=`), so a dynamic input accepts STRING or PROMPT_DATA.
    """

    def __ne__(self, other):
        return False


ANY_TYPE = AnyType("*")


class ContainsAnyDict(dict):
    """A dict that reports every key as present AND resolves any key to a
    valid input spec.

    Used as the `"optional"` schema in `INPUT_TYPES` so ComfyUI accepts the
    dynamically-named input slots the frontend adds to the node (character,
    background, style, ...) without them needing to be declared up front.

    ComfyUI's `get_input_info` does `key in valid_inputs["optional"]` (which
    `__contains__` satisfies) and then `valid_inputs["optional"][key]` — an
    empty dict would raise `KeyError` there, so `__getitem__` must also
    return a valid `(type, options)` tuple for any key.
    """

    def __contains__(self, key):
        return True

    def __getitem__(self, key):
        # Any dynamically-named input resolves to the wildcard type with no
        # extra options — matches how ComfyUI's get_input_info unpacks it
        # (input_type = info[0], extra_info = info[1] if present).
        return (ANY_TYPE, {})


def unwrap_value(value) -> str:
    """Unwrap a combiner input slot's value into a plain, stripped string.

    - A `PROMPT_DATA` dict (has a `"prompt"` key) yields its `"prompt"` value.
    - A plain string is used as-is.
    - `None` / missing / anything else yields `""`.
    """
    if isinstance(value, dict) and "prompt" in value:
        return str(value.get("prompt") or "").strip()
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    return str(value).strip()


@dataclass(frozen=True)
class CombinedPromptData:
    """The `PROMPT_DATA` payload returned alongside the combined prompt string.

    `prompt` stays the FLAT, comma-joined string (unchanged behavior) so a
    wired socket->socket connection downstream (via `unwrap_value`) still
    gets plain text rather than the structured text blob. `structured_str`
    is the labeled-prose `"<Variable>: <value>"` block (see
    `build_field_text`, reused from the Prompt Builder helpers), exposed
    under the `"structured"` key — that's the node's primary output now.
    """

    template: str
    variables: dict = field(default_factory=dict)
    prompt: str = ""
    structured_str: str = ""
    name: str = "combined"

    def as_dict(self) -> dict:
        return {
            "template": self.template,
            "variables": dict(self.variables),
            "prompt": self.prompt,
            "structured": self.structured_str,
            "name": self.name,
        }


def build_combined_prompt_data(template: str, values: dict, prompt: str, structured_str: str) -> dict:
    """Assemble the PROMPT_DATA dict: template, variables, flat prompt, structured text, name."""
    return CombinedPromptData(
        template=template,
        variables=dict(values),
        prompt=prompt,
        structured_str=structured_str,
        name="combined",
    ).as_dict()
