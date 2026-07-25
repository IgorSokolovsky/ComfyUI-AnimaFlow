"""The rules engine: `apply_ruleset` walks a compiled Ruleset over a Bundle
(positive + negative Document) and returns the mutated bundle plus an
execution trace (SCHEMA.md SS5 evaluation semantics, SS8 trace shape).

Clean-room implementation from prompt-rules/SCHEMA.md. `playground/rule-
builder.html`'s JS was read for SEMANTICS only (as instructed) and
reimplemented here independently, with some deliberate structural
differences -- see `core/__init__.py` for the full list of documented v1
simplifications/interpretations (weights opaque, anchors append-only,
per-item matching, phrase-list splitting, etc).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Union

from ._util import listify_phrases, normalize_text
from .document import (
    Block,
    Bundle,
    Document,
    Item,
    find_by_glob,
    find_by_id,
    find_by_label,
    iter_leaves,
    selector_kind,
)
from .match import matches as _matches
from .match import mentions as _mentions
from .profiles import Profile, load_profile
from .rules import GroupRule, Rule, Ruleset, SwapRule, SwitchRule, TagRule, parse_ruleset


@dataclass
class TraceEntry:
    depth: int
    kind: str
    text: str

    def as_dict(self) -> dict:
        return {"depth": self.depth, "kind": self.kind, "text": self.text}


class EvalContext:
    def __init__(self, positive: Document, negative: Document, profile: Profile, options: dict):
        self.positive = positive
        self.negative = negative
        self.profile = profile
        self.options = options
        self.trace: List[TraceEntry] = []

    def emit(self, depth: int, kind: str, text: str) -> None:
        self.trace.append(TraceEntry(depth, kind, text))


# ---------------------------------------------------------------------------
# Selector resolution: bundle/document aware, profile-aware for creation.
# `core/document.py` only knows how to FIND blocks; this layer knows what to
# do when a selector doesn't resolve (create it, using the Profile's
# defaults) -- SCHEMA.md SS2/SS6.
# ---------------------------------------------------------------------------

def _split_doc_prefix(selector: Optional[str], default: str) -> tuple:
    """Handle an optional leading `@negative`/`@positive` selector prefix
    (SCHEMA.md SS2/SS4). Returns `(which, remainder)`.
    """
    sel = selector or "*"
    if sel == "@negative":
        return "negative", "*"
    if sel.startswith("@negative/"):
        return "negative", sel[len("@negative/"):] or "*"
    if sel == "@positive":
        return "positive", "*"
    if sel.startswith("@positive/"):
        return "positive", sel[len("@positive/"):] or "*"
    return default, sel


def _doc_for(ctx: EvalContext, which: str) -> Document:
    return ctx.negative if which == "negative" else ctx.positive


def scope_leaves(ctx: EvalContext, selector: Optional[str], default: str = "positive") -> List[Block]:
    """Resolve a selector to the LEAF blocks it addresses, for conditions
    (`mentions`/`matches`) and for `remove`/`tmp` search scope. Includes
    disabled items' blocks (matching happens at the item level later).
    """
    which, sel = _split_doc_prefix(selector, default)
    doc = _doc_for(ctx, which)
    return scope_leaves_in_doc(doc, sel)


def scope_leaves_in_doc(doc: Document, selector: Optional[str]) -> List[Block]:
    kind = selector_kind(selector)
    if kind == "all":
        return list(iter_leaves(doc.root))
    if kind == "id":
        b = find_by_id(doc.root, selector[1:])
        return list(iter_leaves(b)) if b else []
    if kind == "path":
        from .document import find_by_path
        b = find_by_path(doc.root, selector.split("/"))
        return list(iter_leaves(b)) if b else []
    if kind == "glob":
        out: List[Block] = []
        for b in find_by_glob(doc.root, selector):
            out.extend(iter_leaves(b))
        return out
    out = []
    for b in find_by_label(doc.root, selector):
        out.extend(iter_leaves(b))
    return out


def resolve_anchor(doc: Document, selector: Optional[str], profile: Profile, create: bool = True) -> Optional[Block]:
    """Resolve a selector to a single anchor Block (container or leaf),
    creating it -- v1-simplified: always appended as the last child of its
    resolved parent, ignoring `profile.blockOrder` "canonical position"
    (documented TODO in `core/__init__.py`) -- if `create` and it's missing.
    """
    sel = selector or "*"
    kind = selector_kind(sel)

    if kind == "all":
        return _default_leaf(doc, profile, create)
    if kind == "id":
        b = find_by_id(doc.root, sel[1:])
        if b is not None:
            return b
        return _default_leaf(doc, profile, create) if create else None
    if kind == "path":
        return _resolve_path(doc, sel.split("/"), profile, create)
    if kind == "glob":
        found = find_by_glob(doc.root, sel)
        return found[0] if found else None

    found = find_by_label(doc.root, sel)
    if found:
        return found[0]
    if not create:
        return None
    leaf = Block(
        label=sel, kind="leaf",
        sep=profile.per_label_sep.get(sel, profile.defaults.get("sep", ", ")),
        weights=profile.defaults.get("weights", "strip"),
    )
    doc.root.children.append(leaf)
    leaf.id = doc.next_id()
    return leaf


def _default_leaf(doc: Document, profile: Profile, create: bool) -> Optional[Block]:
    existing = next(iter_leaves(doc.root), None)
    if existing is not None:
        return existing
    if not create:
        return None
    leaf = Block(
        label="", kind="leaf",
        sep=profile.defaults.get("sep", ", "),
        weights=profile.defaults.get("weights", "strip"),
    )
    doc.root.children.append(leaf)
    leaf.id = doc.next_id()
    return leaf


def _resolve_path(doc: Document, segments: List[str], profile: Profile, create: bool) -> Optional[Block]:
    """Walk (and create-on-miss) a `/`-separated selector path.

    Intermediate segments are containers (they're addressing points along
    the path); the FINAL segment, if it needs creating, is a LEAF labelled
    with that segment -- matching how `resolve_section` already creates a
    section leaf under its anchor. (Fixes a bug where a fresh
    `"a/b"` path used to create `b` as an empty container wrapping an
    unlabelled `""` leaf, so e.g. `into: "character:celica/clothes"`
    rendered a bare, unlabelled line instead of `clothes: ...`.)
    """
    segments = [s for s in segments if s]
    current = doc.root
    for i, seg in enumerate(segments):
        is_last = i == len(segments) - 1
        nxt = next((c for c in current.children if c.label == seg), None)
        if nxt is None:
            if not create:
                return None
            if is_last:
                nxt = Block(
                    label=seg, kind="leaf",
                    sep=profile.per_label_sep.get(seg, profile.defaults.get("sep", ", ")),
                    weights=profile.defaults.get("weights", "strip"),
                )
            else:
                nxt = Block(label=seg, kind="container", children=[])
            current.children.append(nxt)
            nxt.id = doc.next_id()
        current = nxt
    return current


def resolve_section(doc: Document, anchor_selector: Optional[str], section_label: str,
                     profile: Profile, create: bool = True) -> Optional[Block]:
    """`SetOp.section` shorthand: the child of the resolved anchor labelled
    `section_label` (created if missing) -- SCHEMA.md SS3.2.
    """
    anchor = resolve_anchor(doc, anchor_selector, profile, create=True)
    if anchor is None:
        return None
    if anchor.is_leaf():
        return anchor
    found = next((c for c in anchor.children if c.label == section_label), None)
    if found:
        return found
    if not create:
        return None
    leaf = Block(
        label=section_label, kind="leaf",
        sep=profile.per_label_sep.get(section_label, profile.defaults.get("sep", ", ")),
        weights=profile.defaults.get("weights", "strip"),
    )
    anchor.children.append(leaf)
    leaf.id = doc.next_id()
    return leaf


def resolve_leaf_target(doc: Document, selector: Optional[str], profile: Profile, create: bool = True) -> Optional[Block]:
    """A plain `into`/`target` override: resolve to a single LEAF block,
    descending into a container anchor's unlabelled ("") child if needed
    (creating one if the anchor is a container with no such child yet).
    """
    anchor = resolve_anchor(doc, selector, profile, create)
    if anchor is None:
        return None
    if anchor.is_leaf():
        return anchor
    found = next((c for c in anchor.children if c.label == ""), None)
    if found:
        return found
    if not create:
        return None
    leaf = Block(
        label="", kind="leaf",
        sep=profile.defaults.get("sep", ", "),
        weights=profile.defaults.get("weights", "strip"),
    )
    anchor.children.append(leaf)
    leaf.id = doc.next_id()
    return leaf


# ---------------------------------------------------------------------------
# Mutations (SCHEMA.md SS5)
# ---------------------------------------------------------------------------

def _add_item(block: Block, text: str, weight: float = 1.0, disabled: bool = False, at: str = "end") -> bool:
    """Add (or dedupe-and-re-enable) `text` into `block`.

    Dedup on add: if an item with the same normalised text already exists,
    it's re-enabled (and, for `weights:"preserve"` blocks, upgraded to the
    stronger weight) rather than duplicated. Returns True iff a NEW item
    was appended.
    """
    norm = normalize_text(text)
    for item in block.items:
        if normalize_text(item.text) == norm:
            if not disabled:
                item.enabled = True
                if block.weights == "preserve" and weight > item.weight:
                    item.weight = weight
            return False
    item = Item(text=text, weight=weight, enabled=not disabled)
    if at == "start":
        block.items.insert(0, item)
    else:
        block.items.append(item)
    return True


def _remove_text(leaves: List[Block], text: str) -> bool:
    """`remove`/`tmp`: set `enabled=False` (kept for later conditions, dropped on render)."""
    norm = normalize_text(text)
    found = False
    for leaf in leaves:
        for item in leaf.items:
            if normalize_text(item.text) == norm:
                item.enabled = False
                found = True
    return found


def _apply_mutation(doc: Document, profile: Profile, mutation: dict, default_into: Optional[str], disabled: bool) -> List[str]:
    """Apply one normalized Mutation dict; returns the phrases it touched (for tracing)."""
    if mutation.get("section"):
        block = resolve_section(doc, default_into, mutation["section"], profile, create=True)
    else:
        target_selector = mutation.get("into") or default_into
        block = resolve_leaf_target(doc, target_selector, profile, create=True)
    if block is None:
        return []
    values = listify_phrases(mutation.get("value"))
    weight = mutation.get("weight", 1.0)
    at = mutation.get("at", "end")
    for v in values:
        _add_item(block, v, weight=weight, disabled=disabled, at=at)
    return values


def _apply_removal(doc: Document, removal: dict, default_into: Optional[str]) -> List[str]:
    from_selector = removal.get("from") or default_into or "*"
    leaves = scope_leaves_in_doc(doc, from_selector)
    values = listify_phrases(removal.get("value"))
    for v in values:
        _remove_text(leaves, v)
    return values


def _apply_setop(doc: Document, profile: Profile, setop: dict, default_into: Optional[str]) -> Block:
    if setop.get("section"):
        block = resolve_section(doc, default_into, setop["section"], profile, create=True)
    else:
        block = resolve_leaf_target(doc, setop.get("target") or default_into, profile, create=True)
    values = listify_phrases(setop.get("to"))
    block.items = []
    for v in values:
        _add_item(block, v)
    return block


# ---------------------------------------------------------------------------
# Conditions (SCHEMA.md SS4)
# ---------------------------------------------------------------------------

def _condition_selector(cond: dict, ctx: EvalContext) -> str:
    """The selector a leaf condition (`mentions`/`matches`) searches: its own
    `in`, else `options.conditionScope` (SCHEMA.md SS4: "Default scope (`in`)
    is `options.conditionScope` (normally the positive doc)."). `in` and
    `conditionScope` are both full selectors, so `@negative`/`@positive`
    prefixes on either are honoured by `scope_leaves`.
    """
    return cond.get("in") or ctx.options.get("conditionScope", "*")


def evaluate_condition(cond: Optional[dict], ctx: EvalContext) -> bool:
    if cond is None:
        return True
    if "mentions" in cond:
        scope = scope_leaves(ctx, _condition_selector(cond, ctx), default="positive")
        phrases = listify_phrases(cond["mentions"])
        return any(_mentions(scope, p, ctx.options["boundary"], ctx.options["caseSensitive"]) for p in phrases)
    if "matches" in cond:
        scope = scope_leaves(ctx, _condition_selector(cond, ctx), default="positive")
        return _matches(scope, cond["matches"], cond.get("flags", ""), ctx.options["caseSensitive"])
    if "all" in cond:
        return all(evaluate_condition(c, ctx) for c in cond["all"])
    if "any" in cond:
        return any(evaluate_condition(c, ctx) for c in cond["any"])
    if "none" in cond:
        return not any(evaluate_condition(c, ctx) for c in cond["none"])
    if "not" in cond:
        return not evaluate_condition(cond["not"], ctx)
    return True


def _describe_condition(cond: Optional[dict]) -> str:
    if cond is None:
        return "always"
    if "mentions" in cond:
        return f"mentions {listify_phrases(cond['mentions'])}"
    if "matches" in cond:
        return f"matches /{cond['matches']}/"
    if "all" in cond:
        return "all(" + ", ".join(_describe_condition(c) for c in cond["all"]) + ")"
    if "any" in cond:
        return "any(" + ", ".join(_describe_condition(c) for c in cond["any"]) + ")"
    if "none" in cond:
        return "none(" + ", ".join(_describe_condition(c) for c in cond["none"]) + ")"
    if "not" in cond:
        return f"not({_describe_condition(cond['not'])})"
    return "?"


# ---------------------------------------------------------------------------
# Rule execution (SCHEMA.md SS3/SS5)
# ---------------------------------------------------------------------------

def _run_rule(rule: Rule, ctx: EvalContext, into_inherit: Optional[str], depth: int) -> bool:
    """Evaluate `rule.when` (if any); if it passes, execute the rule body."""
    if rule.when is not None:
        result = evaluate_condition(rule.when, ctx)
        ctx.emit(depth, "condition", f"? {_describe_condition(rule.when)} = {result}")
        if not result:
            ctx.emit(depth, "skip", "x skipped")
            return False
    _execute(rule, ctx, into_inherit, depth)
    return True


def _execute(rule: Rule, ctx: EvalContext, into_inherit: Optional[str], depth: int) -> None:
    """Run a rule's body (its type-specific behaviour), assuming any `when` gate already passed."""
    effective_into = rule.into or into_inherit
    label = f" ({rule.name})" if rule.name else ""

    if isinstance(rule, GroupRule):
        ctx.emit(depth, "group", f"> group{label}")
        for child in rule.children:
            _run_rule(child, ctx, effective_into, depth + 1)
        return

    if isinstance(rule, SwitchRule):
        ctx.emit(depth, "switch", f"> switch{label}")
        default_child = None
        for i, child in enumerate(rule.children):
            if child.is_default:
                default_child = child
                continue
            result = evaluate_condition(child.when, ctx) if child.when is not None else True
            mark = "✓" if result else "x"
            child_label = f" ({child.name})" if child.name else f" children[{i}]"
            ctx.emit(depth + 1, "condition", f"{mark}{child_label} {_describe_condition(child.when)} = {result}")
            if result:
                _execute(child, ctx, effective_into, depth + 1)
                return
        if default_child is not None:
            ctx.emit(depth + 1, "condition", "✓ default")
            _execute(default_child, ctx, effective_into, depth + 1)
        return

    if isinstance(rule, SwapRule):
        _execute_swap(rule, ctx, effective_into, depth, label)
        return

    # TagRule
    ctx.emit(depth, "tag", f"$ tag{label}")
    _execute_tag(rule, ctx, effective_into, depth)


def _execute_tag(rule: TagRule, ctx: EvalContext, into: Optional[str], depth: int) -> None:
    for m in rule.add:
        values = _apply_mutation(ctx.positive, ctx.profile, m, into, disabled=False)
        if values:
            ctx.emit(depth + 1, "add", f"+ add {', '.join(values)}")
    for m in rule.add_negative:
        values = _apply_mutation(ctx.negative, ctx.profile, m, into, disabled=False)
        if values:
            ctx.emit(depth + 1, "add", f"+ add_negative {', '.join(values)}")
    for r in rule.remove:
        values = _apply_removal(ctx.positive, r, into)
        if values:
            ctx.emit(depth + 1, "remove", f"- remove {', '.join(values)}")
    for r in rule.remove_negative:
        values = _apply_removal(ctx.negative, r, into)
        if values:
            ctx.emit(depth + 1, "remove", f"- remove_negative {', '.join(values)}")
    for m in rule.tmp:
        values = _apply_mutation(ctx.positive, ctx.profile, m, into, disabled=True)
        _apply_mutation(ctx.negative, ctx.profile, m, into, disabled=True)
        if values:
            ctx.emit(depth + 1, "tmp", f"~ tmp {', '.join(values)}")
    for s in rule.set:
        block = _apply_setop(ctx.positive, ctx.profile, s, into)
        target_label = s.get("section") or s.get("target") or into or "*"
        rendered = block.sep.join(i.text for i in block.items if i.enabled)
        ctx.emit(depth + 1, "set", f"= set [{target_label}] {rendered}")


def _execute_swap(rule: SwapRule, ctx: EvalContext, into: Optional[str], depth: int, label: str) -> None:
    positive_leaves = list(iter_leaves(ctx.positive.root))
    hit = next(
        (t for t in rule.match if _mentions(positive_leaves, t, ctx.options["boundary"], ctx.options["caseSensitive"])),
        None,
    )
    ctx.emit(depth, "swap", f"$ swap{label} match({', '.join(rule.match)}) = {hit or '—'}")
    if not hit:
        ctx.emit(depth + 1, "skip", "x no match")
        return
    _remove_text(positive_leaves, hit)
    ctx.emit(depth + 1, "remove", f"- remove {hit}")
    for m in rule.add:
        values = _apply_mutation(ctx.positive, ctx.profile, m, into, disabled=False)
        if values:
            ctx.emit(depth + 1, "add", f"+ add {', '.join(values)}")
    for m in rule.add_negative:
        values = _apply_mutation(ctx.negative, ctx.profile, m, into, disabled=False)
        if values:
            ctx.emit(depth + 1, "add", f"+ add_negative {', '.join(values)}")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def apply_ruleset(bundle: Union[Bundle, dict], ruleset: Union[Ruleset, dict], profile: Union[str, Profile, None]) -> dict:
    """SCHEMA.md SS1 `applyRuleset(bundle, ruleset, profile) -> {positive, negative, trace}`."""
    positive = bundle.positive if isinstance(bundle, Bundle) else bundle["positive"]
    negative = bundle.negative if isinstance(bundle, Bundle) else bundle["negative"]
    prof = load_profile(profile)
    rs = ruleset if isinstance(ruleset, Ruleset) else parse_ruleset(ruleset)

    options = dict(rs.options or {})
    options.setdefault("conditionScope", "*")
    options.setdefault("caseSensitive", False)
    options.setdefault("boundary", "word")

    ctx = EvalContext(positive, negative, prof, options)
    for rule in rs.rules:
        _run_rule(rule, ctx, None, 0)

    return {
        "positive": positive,
        "negative": negative,
        "trace": [e.as_dict() for e in ctx.trace],
    }


def format_trace(trace: List[dict]) -> str:
    """Render a `{depth, kind, text}` trace as an indented tree, for printing/eyeballing."""
    return "\n".join("  " * entry["depth"] + entry["text"] for entry in trace)
