"""Profiles: pure-data parsing/rendering conventions per model family
(SCHEMA.md SS6). The engine (`core/engine.py`) never reads
`profile.parse`/`profile.render` directly -- only `parse()`/`render()` here,
plus the block-creation helpers in `core/engine.py`, consult a Profile.
That keeps rulesets portable across profiles (SCHEMA.md SS6, last line).

Reference profiles shipped: `raw`, `illustrious`/`pony` (booru tags),
`anima` (labelled prose), `flux`/`wan` (natural-language prose).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional, Union

from ._util import split_values
from .document import Block, Document, Item, ensure_ids


@dataclass
class Profile:
    id: str
    parse: dict = field(default_factory=dict)
    block_order: List[str] = field(default_factory=list)
    defaults: dict = field(default_factory=lambda: {"sep": ", ", "weights": "strip"})
    per_label_sep: dict = field(default_factory=dict)
    render: dict = field(default_factory=lambda: {"sectionLabelStyle": "prefix"})


PROFILES: dict = {
    "raw": Profile(
        id="raw",
        parse={"split": "commas"},
        defaults={"sep": ", ", "weights": "preserve"},
    ),
    "illustrious": Profile(
        id="illustrious",
        parse={"split": "commas"},
        defaults={"sep": ", ", "weights": "preserve"},
    ),
    "pony": Profile(
        id="pony",
        parse={"split": "commas"},
        defaults={"sep": ", ", "weights": "preserve"},
    ),
    "anima": Profile(
        id="anima",
        parse={
            "split": "lines",
            "labels": {
                "container": r"^\[character:(.+)\]$",
                "section": r"^(appearance|clothes|action|focus):\s*(.*)$",
                "leaf": r"^\[(quality|global)\]$",
            },
        },
        block_order=["quality", "character:*", "global"],
        defaults={"sep": ", ", "weights": "strip"},
        per_label_sep={"__sections__": "\n", "clothes": ", "},
        render={"sectionLabelStyle": "prefix"},
    ),
    "flux": Profile(
        id="flux",
        parse={"split": "sentences"},
        defaults={"sep": ". ", "weights": "strip"},
    ),
    "wan": Profile(
        id="wan",
        parse={"split": "sentences"},
        defaults={"sep": ". ", "weights": "strip"},
    ),
}


def load_profile(profile: Union[str, Profile, None]) -> Profile:
    if isinstance(profile, Profile):
        return profile
    key = (profile or "raw").lower()
    if key not in PROFILES:
        raise KeyError(f"Unknown profile '{profile}'. Known profiles: {sorted(PROFILES)}")
    return PROFILES[key]


# ---------------------------------------------------------------------------
# parse(text, profile) -> Document
# ---------------------------------------------------------------------------

def parse(text: Optional[str], profile: Union[str, Profile, None]) -> Document:
    prof = load_profile(profile)
    text = text or ""
    labels = prof.parse.get("labels")
    if labels:
        root = _parse_labelled(text, prof, labels)
    else:
        split_mode = prof.parse.get("split", "commas")
        if split_mode == "sentences":
            item_texts = _split_sentences(text)
        elif split_mode == "none":
            item_texts = [text.strip()] if text.strip() else []
        else:  # "commas" (also covers "lines" without labels, which is rare)
            item_texts = split_values(text)
        leaf = Block(
            label="",
            kind="leaf",
            items=[Item(text=t) for t in item_texts],
            sep=prof.defaults.get("sep", ", "),
            weights=prof.defaults.get("weights", "strip"),
        )
        root = Block(label="", kind="container", children=[leaf])

    doc = Document(root=root, profile=prof.id)
    ensure_ids(doc.root, [0])
    return doc


def _split_sentences(text: str) -> List[str]:
    parts = re.split(r"(?<=[.!?])\s+|\n+", text.strip())
    out = []
    for p in parts:
        p = p.strip().rstrip(".!?").strip()
        if p:
            out.append(p)
    return out


def _parse_labelled(text: str, prof: Profile, labels: dict) -> Block:
    """Line-oriented parser for "sectioned prose" profiles (e.g. anima).

    Interpretation of `profile.parse.labels` (documented in
    `core/__init__.py`'s v1-simplifications list): the `container`/`leaf`/
    `section` regexes are matched as LINE-PREFIX patterns. For `leaf`, any
    trailing text on the same line (after the bracket) becomes that leaf's
    comma-split items; `section`'s own regex already captures the trailing
    content as its 2nd group (per SCHEMA.md's example). A line matching
    none of the three becomes an unlabelled top-level leaf (best-effort
    fallback rather than a hard parse error).
    """
    container_re = re.compile(labels.get("container") or r"(?!)")
    section_re = re.compile(labels.get("section") or r"(?!)")
    leaf_re = re.compile(labels.get("leaf") or r"(?!)")

    root = Block(label="", kind="container", children=[])
    current_container: Optional[Block] = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        m = container_re.match(line)
        if m:
            label = f"character:{m.group(1).strip()}"
            current_container = Block(label=label, kind="container", children=[])
            root.children.append(current_container)
            continue

        m = leaf_re.match(line)
        if m:
            rest = line[m.end():].strip()
            leaf = Block(
                label=m.group(1),
                kind="leaf",
                items=[Item(text=t) for t in split_values(rest)],
                sep=prof.defaults.get("sep", ", "),
                weights=prof.defaults.get("weights", "strip"),
            )
            root.children.append(leaf)
            current_container = None
            continue

        m = section_re.match(line)
        if m:
            groups = m.groups()
            name = groups[0]
            rest = groups[1] if len(groups) > 1 else line[m.end():].strip()
            leaf = Block(
                label=name,
                kind="leaf",
                items=[Item(text=t) for t in split_values(rest)],
                sep=prof.per_label_sep.get(name, prof.defaults.get("sep", ", ")),
                weights=prof.defaults.get("weights", "strip"),
            )
            if current_container is not None:
                current_container.children.append(leaf)
            else:
                root.children.append(leaf)
            continue

        # Fallback: an unrecognised line becomes its own top-level leaf.
        leaf = Block(
            label="",
            kind="leaf",
            items=[Item(text=t) for t in split_values(line)],
            sep=prof.defaults.get("sep", ", "),
            weights=prof.defaults.get("weights", "strip"),
        )
        root.children.append(leaf)
        current_container = None

    return root


# ---------------------------------------------------------------------------
# render(document, profile) -> str
# ---------------------------------------------------------------------------

def render(doc: Document, profile: Union[str, Profile, None]) -> str:
    prof = load_profile(profile)
    text = _render_block(doc.root, prof)
    return text or ""


def _render_block(block: Block, prof: Profile) -> Optional[str]:
    if block.is_leaf():
        text = _render_leaf_items(block, prof)
        if not text:
            return None
        style = (block.render or {}).get("labelStyle") or prof.render.get("sectionLabelStyle", "none")
        if block.label and style == "prefix":
            prefix = (block.render or {}).get("prefix", f"{block.label}: ")
            return f"{prefix}{text}"
        return text

    parts = []
    for c in block.children:
        p = _render_block(c, prof)
        if p:
            parts.append(p)
    if not parts:
        return None
    sep = prof.per_label_sep.get(block.label) or prof.per_label_sep.get("__sections__", "\n")
    return sep.join(parts)


def _render_leaf_items(block: Block, prof: Profile) -> str:
    enabled = [i for i in block.items if i.enabled]
    if not enabled:
        return ""
    parts = []
    for item in enabled:
        if block.weights == "preserve" and item.weight and abs(item.weight - 1.0) > 1e-9:
            parts.append(f"({item.text}:{_fmt_weight(item.weight)})")
        else:
            parts.append(item.text)
    return block.sep.join(parts)


def _fmt_weight(weight: float) -> str:
    s = f"{weight:.2f}".rstrip("0").rstrip(".")
    return s or "0"
