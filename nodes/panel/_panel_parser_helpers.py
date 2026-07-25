"""Pure logic for the Panel Parser (Batch) node — no ComfyUI imports.

Kept separate from `node_panel_parser.py` so it can be unit-tested in
isolation (see `test_panel_parser.py` at the repo root) and so the node file
itself stays thin, per the Pixaroma-style node + `_helpers.py` split.

Splits an `LLMPanels`-style multi-panel text (each panel preceded by a
delimiter line, see `_llm_panels_helpers.PANEL_DELIMITER_TEMPLATE`) back into
individual panel strings, so `PanelBatch` can fan them out as a ComfyUI LIST
output (one queue run per panel downstream). Each panel block is then split
again on the `--- STORY ---` marker (see `split_panel_body`) into the image
prompt (fed to the text encoder) and the narration/dialogue text (kept out
of the image prompt, surfaced as a separate output for e.g. `SavePanel`'s
metadata or an on-page caption).
"""

from __future__ import annotations

import re

DEFAULT_DELIMITER_REGEX = r"^\s*=+\s*PANEL\s*\d+\s*=+\s*$"
DEFAULT_STORY_REGEX = r"^\s*-{2,}\s*STORY\s*-{2,}\s*$"


def split_panels(text: str, delimiter_regex: str) -> list[str]:
    """Split `text` on `delimiter_regex` (matched per-line) into panel strings.

    The regex is matched case-insensitively, in MULTILINE mode, against each
    delimiter line (e.g. `"=== PANEL 1 ==="`); any preamble before the first
    delimiter match is dropped, each resulting piece is stripped, and
    empty/whitespace-only pieces are dropped.

    FALLBACK: if `delimiter_regex` is invalid (fails to compile) OR compiles
    but matches nothing in `text`, the whole non-empty, stripped `text` is
    treated as a single panel (`[text.strip()]`); blank/whitespace-only
    `text` yields `[]`.
    """
    text = text or ""

    try:
        pattern = re.compile(delimiter_regex, re.IGNORECASE | re.MULTILINE)
    except re.error:
        stripped = text.strip()
        return [stripped] if stripped else []

    matches = list(pattern.finditer(text))
    if not matches:
        stripped = text.strip()
        return [stripped] if stripped else []

    pieces: list[str] = []
    for i, match in enumerate(matches):
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        piece = text[start:end].strip()
        if piece:
            pieces.append(piece)

    return pieces


def split_panel_body(block: str, story_regex: str) -> tuple[str, str]:
    """Split one panel `block` on the FIRST line matching `story_regex`.

    The marker (e.g. `"--- STORY ---"`) is matched as a full line,
    case-insensitively, in MULTILINE mode. Returns `(image_prompt, story)`,
    both stripped: everything before the marker is the image prompt (the
    STORY block is removed so it never reaches the text encoder); everything
    after is the story/dialogue text.

    FALLBACK: if `story_regex` is invalid (fails to compile) OR compiles but
    matches nothing in `block`, the whole stripped `block` is returned as the
    image prompt with an empty story (`(block.strip(), "")`).
    """
    block = block or ""

    try:
        pattern = re.compile(story_regex, re.IGNORECASE | re.MULTILINE)
    except re.error:
        return block.strip(), ""

    match = pattern.search(block)
    if not match:
        return block.strip(), ""

    image_prompt = block[: match.start()].strip()
    story = block[match.end() :].strip()
    return image_prompt, story
