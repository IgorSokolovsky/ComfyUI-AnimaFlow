"""Pure logic for `AnimaPromptStudio` (`nodes/node_anima_prompt_studio.py`).

`blocks_state` is the JS block editor's own serialized state:
`{"positive": [block, ...], "negative": [block, ...]}` where a block is
`{"id": str, "type": "quality"|"artist"|"trigger"|"general", "label": str,
"text": str, "enabled": bool, "pin": bool}`.

## The correction/pin algorithm

The mockup (`playground/anima_prompt_studio.html`)'s `assemble()`/`correct()`
always moves pinned blocks to the front, then corrects the rest as a block —
its own code comment disclaims this as a rough demo stand-in, not the real
contract. The real Prompt Rules engine (`_rules_helpers.run_rules`) is a
WHOLE-BUNDLE operation: it parses the ENTIRE positive text + ENTIRE negative
text together as one document per call and can reorder/move tokens anywhere
within that single pass — so correction cannot be meaningfully applied to
disconnected mid-list fragments one at a time. Given that constraint, this
module implements POSITION-PRESERVING pin bypass instead:

  1. `assemble_pane_segments` walks a pane's enabled, non-blank blocks in
     order. A pinned block becomes a `("pin", text)` segment emitted right
     where it sits. The FIRST non-pinned block reached inserts a single
     `("rest", None)` placeholder AT THAT POSITION; that block's text and
     every subsequent non-pinned block's text are folded into one
     `rest_raw` string (joined by `separator`) instead of each getting its
     own segment.
  2. The engine (if correction is on) runs ONCE over the whole-pane
     `rest_raw` string (for positive and negative together, since
     `run_rules` itself takes both panes in one call).
  3. `substitute_rest` drops the corrected string back into the `("rest",
     None)` placeholder's slot and joins every segment with `separator`.

This means a pinned block's text is never seen by the engine at all (it
can't be reordered, rewritten, or removed by a ruleset) and its POSITION
relative to the non-pinned blocks around it is preserved, even though the
non-pinned blocks themselves get folded into one corrected run.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Optional

BLOCK_TYPES = ("quality", "artist", "trigger", "general")


def default_blocks_state() -> dict:
    """The seed content used as the `blocks_state` widget's default —
    mirrors `playground/anima_prompt_studio.html`'s initial 4 positive
    blocks (quality/artist/trigger/general) + 1 negative general block."""
    return {
        "positive": [
            {
                "id": "p1",
                "type": "quality",
                "label": "Quality Tags",
                "text": "newest, masterpiece, best quality, absurdres",
                "enabled": True,
                "pin": False,
            },
            {
                "id": "p2",
                "type": "artist",
                "label": "Artist Mix",
                "text": "@wlop, @sakimichan",
                "enabled": True,
                "pin": False,
            },
            {
                "id": "p3",
                "type": "trigger",
                "label": "LoRA Trigger",
                "text": "ohwx_style, celica_v2",
                "enabled": True,
                "pin": True,
            },
            {
                "id": "p4",
                "type": "general",
                "label": "Scene",
                "text": "1girl, solo, silver hair, violet eyes, rainy neon alley, cinematic lighting",
                "enabled": True,
                "pin": False,
            },
        ],
        "negative": [
            {
                "id": "n1",
                "type": "general",
                "label": "Negative",
                "text": "worst quality, low quality, blurry, extra digits, watermark",
                "enabled": True,
                "pin": False,
            },
        ],
    }


# Serialized once at import time; used as the `blocks_state` widget's
# `default` in `INPUT_TYPES` (a real, required, JSON-serialized STRING
# widget the JS hides for rendering only — see the skill's serialized-STRING
# state pattern).
DEFAULT_BLOCKS_STATE_JSON = json.dumps(default_blocks_state())


def _normalize_block(block: dict) -> dict:
    block_type = block.get("type")
    if block_type not in BLOCK_TYPES:
        block_type = "general"
    return {
        "id": str(block.get("id") or ""),
        "type": block_type,
        "label": str(block.get("label") or ""),
        "text": str(block.get("text") or ""),
        "enabled": bool(block.get("enabled", True)),
        "pin": bool(block.get("pin", False)),
    }


def _normalize_pane(pane: Any) -> list:
    if not isinstance(pane, list):
        return []
    return [_normalize_block(item) for item in pane if isinstance(item, dict)]


def parse_blocks_state(raw: Optional[str]) -> dict:
    """Tolerant parse of the `blocks_state` widget's JSON.

    A corrupted/hand-edited hidden widget must never crash the whole
    workflow — this is a deliberate decision, not an oversight: invalid
    JSON, or JSON that parses to something other than an object (a list, a
    string, `null`, a number...), returns the empty shape
    `{"positive": [], "negative": []}` instead of raising. Each block
    surviving pane normalization gets its `type`/`label`/`text`/`enabled`/
    `pin` defaulted per the class contract (see `_normalize_block`); a
    pane entry that isn't itself a JSON object is dropped rather than
    raising.
    """
    try:
        data = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        data = None

    if not isinstance(data, dict):
        return {"positive": [], "negative": []}

    return {
        "positive": _normalize_pane(data.get("positive")),
        "negative": _normalize_pane(data.get("negative")),
    }


def assemble_pane_segments(blocks: list, separator: str) -> tuple:
    """Walk `blocks` in pane order, producing `(segments, rest_raw)`.

    - Disabled blocks and blocks whose (stripped) `text` is blank are
      skipped entirely — not emitted, not counted toward `rest_raw`.
    - A pinned block becomes a `("pin", text)` segment, emitted in place.
    - The FIRST non-pinned block reached inserts one `("rest", None)`
      placeholder at that position; its text and every subsequent
      non-pinned block's text are folded into `rest_raw` (joined by
      `separator`) instead of individual segments — no further `("rest",
      ...)` segments are ever emitted for the same pane.
    """
    segments: list = []
    rest_parts: list = []
    rest_started = False

    for block in blocks:
        if not block.get("enabled", True):
            continue
        text = str(block.get("text") or "").strip()
        if not text:
            continue

        if block.get("pin"):
            segments.append(("pin", text))
            continue

        if not rest_started:
            segments.append(("rest", None))
            rest_started = True
        rest_parts.append(text)

    rest_raw = separator.join(rest_parts)
    return segments, rest_raw


def substitute_rest(segments: list, rest_corrected: str, separator: str) -> str:
    """Replace the `("rest", None)` placeholder (if any) in `segments` with
    `rest_corrected`, omitting it entirely if `rest_corrected` is blank,
    then join every segment's text with `separator`, skipping blanks."""
    parts = []
    for kind, value in segments:
        if kind == "rest":
            text = str(rest_corrected or "").strip()
        else:
            text = value or ""
        if text:
            parts.append(text)
    return separator.join(parts)


def build_prompt_studio_output(
    blocks_state_raw: Optional[str],
    separator: str = ", ",
    rules_correction_enabled: bool = False,
    rules_profile: str = "anima",
    rules_sheets: str = "*",
) -> tuple:
    """Orchestrator `AnimaPromptStudio.compose` calls directly.

    `rules_correction_enabled=False` is a byte-identical passthrough of the
    raw assembled text — no engine import, no engine call at all. When on
    (and at least one pane has a non-blank "rest" portion), calls the SAME
    engine entry point `PromptRulesText` uses (`_rules_helpers.run_rules`)
    exactly once over both panes' whole "rest" strings together (the engine
    is a whole-bundle operation — see this module's docstring), then splices
    the corrected result back into each pane via `substitute_rest`.
    """
    state = parse_blocks_state(blocks_state_raw)
    pos_segments, pos_rest_raw = assemble_pane_segments(state["positive"], separator)
    neg_segments, neg_rest_raw = assemble_pane_segments(state["negative"], separator)

    if rules_correction_enabled and (pos_rest_raw.strip() or neg_rest_raw.strip()):
        from ._rules_helpers import run_rules

        pos_corrected, neg_corrected, _trace = run_rules(
            pos_rest_raw, neg_rest_raw, rules_profile, rules_sheets,
            embedded_rules="", log_trace=False,
        )
    else:
        pos_corrected, neg_corrected = pos_rest_raw, neg_rest_raw

    return (
        substitute_rest(pos_segments, pos_corrected, separator),
        substitute_rest(neg_segments, neg_corrected, separator),
    )


def is_changed_digest(
    blocks_state: Optional[str],
    separator: str = ", ",
    rules_correction_enabled: bool = False,
    rules_profile: str = "anima",
    rules_sheets: str = "*",
) -> str:
    """`sha256(blocks_state + separator + rules_correction_enabled +
    rules_profile + rules_sheets + sheet_digests(rules_sheets))` — reuses
    `_rules_helpers.sheet_digests` directly (rather than re-deriving a
    parallel mtime/size scan) so an externally-edited `rules/*.yaml` sheet
    hot-reloads even though none of THIS node's own widgets changed,
    mirroring why `PromptRulesText.IS_CHANGED` does the same digest trick.
    """
    from ._rules_helpers import sheet_digests

    payload = "\x1f".join([
        blocks_state or "",
        separator or "",
        "1" if rules_correction_enabled else "0",
        rules_profile or "",
        rules_sheets or "",
        sheet_digests(rules_sheets),
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


__all__ = (
    "BLOCK_TYPES",
    "DEFAULT_BLOCKS_STATE_JSON",
    "default_blocks_state",
    "parse_blocks_state",
    "assemble_pane_segments",
    "substitute_rest",
    "build_prompt_studio_output",
    "is_changed_digest",
)
