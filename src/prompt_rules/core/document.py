"""Document IR: `Item` atoms, `Block` (container|leaf), `Document`/`Bundle`,
plus PURE selector-lookup helpers (SCHEMA.md SS2).

This module only knows how to *find* blocks (by id/label/glob/path) -- it
has no opinion on Profiles or on what to do when a selector doesn't resolve
(that's `core/engine.py`'s job, since creating a missing block needs a
Profile's defaults). Clean-room from src/prompt_rules/schema/SCHEMA.md; no code copied
from any other rule engine.
"""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass, field
from typing import Iterator, List, Optional


@dataclass
class Item:
    """A single prompt atom -- a booru tag or a prose phrase, they're the
    same thing here. `weight` is opaque in v1 (see core/__init__.py).
    """

    text: str
    weight: float = 1.0
    enabled: bool = True


@dataclass
class Block:
    """A container (has `children`) or a leaf (has `items`)."""

    label: str = ""
    kind: str = "leaf"  # "container" | "leaf"
    id: Optional[str] = None
    items: List[Item] = field(default_factory=list)
    children: List["Block"] = field(default_factory=list)
    sep: str = ", "
    weights: str = "strip"  # "preserve" | "strip"
    render: dict = field(default_factory=dict)  # {"labelStyle": ..., "prefix": ...}

    def is_leaf(self) -> bool:
        return self.kind == "leaf"

    def is_container(self) -> bool:
        return self.kind == "container"


@dataclass
class Document:
    root: Block
    version: int = 1
    profile: str = "raw"

    def next_id(self) -> str:
        """Scan the tree for the highest existing `bN` id and return the next one."""
        max_n = 0
        for b in iter_blocks(self.root):
            if b.id and b.id.startswith("b") and b.id[1:].isdigit():
                max_n = max(max_n, int(b.id[1:]))
        return f"b{max_n + 1}"


@dataclass
class Bundle:
    positive: Document
    negative: Document


# ---------------------------------------------------------------------------
# Tree walking
# ---------------------------------------------------------------------------

def iter_blocks(block: Optional[Block]) -> Iterator[Block]:
    """Yield `block` and every descendant, depth-first pre-order."""
    if block is None:
        return
    yield block
    for c in block.children:
        yield from iter_blocks(c)


def iter_leaves(block: Optional[Block]) -> Iterator[Block]:
    """Yield every LEAF block reachable from `block` (including `block`
    itself if it's already a leaf), depth-first.
    """
    if block is None:
        return
    if block.is_leaf():
        yield block
        return
    for c in block.children:
        yield from iter_leaves(c)


def ensure_ids(block: Block, counter: List[int]) -> None:
    """Fill in missing `.id`s in-place, depth-first, sharing one counter."""
    if not block.id:
        counter[0] += 1
        block.id = f"b{counter[0]}"
    for c in block.children:
        ensure_ids(c, counter)


# ---------------------------------------------------------------------------
# Selectors (SCHEMA.md SS2 "Selectors")
#   "*"                     the whole document
#   "clothes"               any block whose label == "clothes" (exact / glob)
#   "character:*"           glob on labels
#   "character:celica/clothes"  path by labels (container -> child)
#   "#b3"                   by block id
#   "@negative"             handled one level up (Bundle-aware, see engine.py)
# ---------------------------------------------------------------------------

def selector_kind(selector: Optional[str]) -> str:
    if not selector or selector == "*":
        return "all"
    if selector.startswith("#"):
        return "id"
    if "/" in selector:
        return "path"
    if "*" in selector:
        return "glob"
    return "label"


def find_by_id(root: Block, block_id: str) -> Optional[Block]:
    for b in iter_blocks(root):
        if b.id == block_id:
            return b
    return None


def find_by_label(root: Block, label: str) -> List[Block]:
    """Exact label match, anywhere in the tree."""
    return [b for b in iter_blocks(root) if b.label == label]


def find_by_glob(root: Block, pattern: str) -> List[Block]:
    return [b for b in iter_blocks(root) if fnmatch.fnmatchcase(b.label.lower(), pattern.lower())]


def find_by_path(root: Block, segments: List[str]) -> Optional[Block]:
    """Walk `root`'s children by exact label match, one path segment per level."""
    current = root
    for seg in segments:
        if not seg:
            continue
        nxt = next((c for c in current.children if c.label == seg), None)
        if nxt is None:
            return None
        current = nxt
    return current
