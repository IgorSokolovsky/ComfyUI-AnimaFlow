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
                "leaf": r"^\[(quality|global)\]",
            },
        },
        block_order=["quality", "character:*", "global"],
        defaults={"sep": ", ", "weights": "strip"},
        per_label_sep={"__sections__": "\n", "clothes": ", "},
        # `containerLabelStyle` (SCHEMA.md SS6/SS7): the header a labelled
        # CONTAINER (in practice, only `character:*`) renders before its own
        # sections, when no sheet's `options.characterLabel` stamped a style
        # onto that specific container (see `core/engine.py`'s
        # `_stamp_character_containers`). "generic" is the default -- an
        # unknown OC name is both an ungroundable token for the diffusion
        # side (nothing to ground it to) and semantically loaded for an LLM
        # text encoder (an unrelated proper noun injects spurious priors).
        render={"sectionLabelStyle": "prefix", "containerLabelStyle": "generic"},
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
    ordered_root_children = _ordered_top_level_children(doc.root, prof)
    character_numbers = _number_character_containers(ordered_root_children)
    text = _render_container(
        doc.root, prof,
        children=ordered_root_children,
        character_numbers=character_numbers,
        is_root=True,
    )
    return text or ""


def _number_character_containers(children: List[Block]) -> dict:
    """1-based ordinal, in RENDER order, among all `character:*` containers
    (used by the `"generic"` container-label style, `character <N>:`).

    Takes the already-`blockOrder`-reordered top-level child list (see
    `render()`), so numbering matches what a reader actually sees, not
    authored order. Keyed by `id(block)` (object identity) rather than
    `block.id`/label, since it's a purely render-local lookup that never
    needs to survive past this one `render()` call.

    `character:*` containers are always top-level children of `doc.root` in
    this engine (created either by `_parse_labelled`'s `[character:...]`
    handling or by `core/engine.py`'s path-selector resolution, both of
    which only ever append to `doc.root`) -- so scanning just this one level
    is sufficient; nested containers-within-containers don't occur.
    """
    numbers: dict = {}
    n = 0
    for c in children:
        if c.is_container() and c.label.startswith("character:"):
            n += 1
            numbers[id(c)] = n
    return numbers


def _ordered_top_level_children(root: Block, prof: Profile) -> List[Block]:
    """Render-time-only ordering of `root`'s direct children per
    `prof.block_order` (SCHEMA.md SS6 `blockOrder`). Pure and non-destructive:
    returns a NEW list, never mutates `root.children` -- rule application
    addresses blocks by label/id and must be unaffected by render order.

    Applies to top-level children of `doc.root` ONLY; nested children (e.g.
    a `character:celica` container's own `appearance`/`clothes`/... leaves)
    are rendered in their own, untouched, authored order -- those labels
    aren't in `block_order` anyway.

    - Empty `block_order` (the `raw`/`illustrious`/`pony`/`flux`/`wan`
      profiles) is a hard no-op: returns `root.children` as-is, so those
      profiles' rendered output is byte-identical to before this ordering
      existed.
    - Each `block_order` entry matches a block's `label`: exact match, or
      (for a trailing `*`) a plain-prefix glob (`"character:*"` matches
      `"character:celica"`, `"character:ren"`, ...) -- simple
      `str.startswith`, not `fnmatch` (no need for the extra generality).
    - A block matching entry `i` sorts before a block matching entry `j`
      when `i < j`.
    - Blocks matching NO entry keep their relative authored order and sort
      LAST, after every named entry (deliberate choice: an unrecognised/new
      top-level block should still render, just at the end, rather than
      vanishing or jumping to the front).
    - Ties (blocks matching the SAME entry, or several unmatched blocks)
      keep their original relative authored order -- `sorted()` is stable,
      so this "just falls out" of sorting by rank alone.
    """
    if not prof.block_order:
        return root.children

    order = prof.block_order

    def rank(block: Block) -> int:
        for i, pattern in enumerate(order):
            if pattern.endswith("*"):
                if block.label.startswith(pattern[:-1]):
                    return i
            elif block.label == pattern:
                return i
        return len(order)

    return sorted(root.children, key=rank)


def _render_block(block: Block, prof: Profile, character_numbers: Optional[dict] = None) -> Optional[str]:
    if block.is_leaf():
        text = _render_leaf_items(block, prof)
        if not text:
            return None
        style = (block.render or {}).get("labelStyle") or prof.render.get("sectionLabelStyle", "none")
        if block.label and style == "prefix":
            prefix = (block.render or {}).get("prefix", f"{block.label}: ")
            return f"{prefix}{text}"
        return text

    return _render_container(block, prof, character_numbers=character_numbers)


def _render_container(
    block: Block,
    prof: Profile,
    children: Optional[List[Block]] = None,
    character_numbers: Optional[dict] = None,
    is_root: bool = False,
) -> Optional[str]:
    """Render a container's children, joined by its per-label separator,
    preceded by a boundary-marking HEADER LINE for this container itself
    (bug fix -- previously `block.label` was only ever consulted to pick a
    separator, never emitted, so e.g. two `character:*` containers rendered
    as one undifferentiated attribute pool; see SCHEMA.md SS7).

    `children` lets callers (currently just `render()`, for `doc.root`)
    supply a reordered view without mutating `block.children`; every other
    caller (i.e. every nested container) renders in authored order.

    Header text is intentionally NOT round-trippable back to the bracketed
    `[character:...]` input syntax -- emitting literal `[`/`]` would send
    those characters straight to the text encoder, exactly the bug already
    fixed for `[quality]`/`[global]` (SCHEMA.md SS7's "quality"/"global"
    leaves aren't round-trippable either; this container header keeps that
    same, deliberate, encoder-correctness-over-round-tripping tradeoff).
    """
    parts = []
    for c in (block.children if children is None else children):
        p = _render_block(c, prof, character_numbers=character_numbers)
        if p:
            parts.append(p)
    if not parts:
        return None
    sep = prof.per_label_sep.get(block.label) or prof.per_label_sep.get("__sections__", "\n")
    body = sep.join(parts)

    # The root is a container with an empty label -- it must NEVER emit a
    # header (guarded explicitly, not just by the `if block.label` check
    # below, since `render()` calls `_render_container` for the root with a
    # reordered child list and it'd be easy to accidentally fall through).
    if is_root:
        return body

    header = _container_header(block, prof, character_numbers or {})
    if header:
        return f"{header}\n{body}"
    return body


def _container_header(block: Block, prof: Profile, character_numbers: dict) -> Optional[str]:
    """The boundary line a labelled (non-root) container renders before its
    own sections -- see SCHEMA.md SS7. Its own line, immediately before the
    container's (unchanged) section join.

    Per-sheet override: `core/engine.py`'s `_stamp_character_containers`
    writes the ruleset's `options.characterLabel` choice into
    `block.render["labelStyle"]` for exactly the `character:*` containers
    that ruleset targets via `into`. Absent a stamp, the profile's
    `containerLabelStyle` applies (default `"generic"` for `anima`).
    """
    if not block.label:
        return None
    style = (block.render or {}).get("labelStyle") or prof.render.get("containerLabelStyle", "generic")
    if style == "none":
        return None
    if style == "name":
        name = block.label
        if name.startswith("character:"):
            name = name[len("character:"):]
        return f"character: {name}"
    # "generic" (also the fallback for any unrecognised style value).
    n = character_numbers.get(id(block), 1)
    return f"character {n}:"


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
