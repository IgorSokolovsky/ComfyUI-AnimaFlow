"""Prompt Rules — clean-room engine (pure Python, no ComfyUI, no UI).

Implements `src/prompt_rules/schema/SCHEMA.md` (v1) from scratch: Document IR, Ruleset,
conditions, rule types (tag/group/switch/swap), evaluation semantics,
profiles, and an execution trace. No code was copied from any other rule
engine; `playground/rule-builder.html`'s JS was read for SEMANTICS only
(parse/render/mentions/add/remove/set/group/switch/swap/dedup, per the build
brief) and reimplemented here independently, with deliberate structural
differences: per-item text matching instead of a joined comma-haystack,
dataclass-typed rules instead of dict blobs, a path-precise validation
`Auditor`, etc.

Public API (SCHEMA.md SS1, "the contract"):
    parse(text, profile)                     -> Document
    render(document, profile)                -> str
    validate(ruleset_dict, source=...)       -> {"ok": bool, "errors": [str, ...]}
    apply_ruleset(bundle, ruleset, profile)  -> {"positive", "negative", "trace"}
    load_profile(id_or_profile)              -> Profile
    transform(pos_text, neg_text, ruleset_dict, profile) -> (pos_text, neg_text, trace)

--------------------------------------------------------------------------
v1 SCOPE / SIMPLIFICATIONS (as scoped in the build brief)
--------------------------------------------------------------------------

WEIGHTS
    Weighted tokens like `(tag:1.2)` are treated as OPAQUE item text -- the
    engine does NOT parse or recombine `(:)` nesting. Dedup compares
    normalised text (whitespace-folded, lower-cased), ignoring any weight
    baked into the text itself. A mutation's structured `weight:` field is
    only honoured through the Mutation OBJECT form (`{"value": ...,
    "weight": 1.2}`), and only rendered when the target block's `weights`
    is `"preserve"`. `weightMode` stays reserved (SCHEMA.md SS2/SS7).

ANCHORS
    Adds without an explicit anchor append at the END of the target block
    (v1). The Mutation schema's `after`/`before` anchors (insert next to a
    matched phrase) parse without error but are NOT implemented -- they're
    silently ignored in favour of `at` (default `"end"`). TODO for a later
    version. `swap` similarly inserts its `add` mutations at the end of the
    resolved `into` block rather than at the removed placeholder's exact
    original index.

BLOCK CREATION / blockOrder
    When `into`/`section`/`target` addresses a block that doesn't exist
    yet, the engine creates it (SCHEMA.md SS2/SS6) but always APPENDS it as
    the last child of its resolved parent -- it does not consult
    `profile.blockOrder` to place it in "canonical position". TODO for a
    later version.

MATCHING
    `mentions`/`matches` are evaluated PER-ITEM (an Item's own `.text`),
    not across a comma-joined haystack spanning multiple items. Deliberate
    choice: avoids two adjacent-but-separate items combining into a phrase
    ("... jacket, celica ...") that was never actually authored as one
    tag/phrase.

    Sugar `any_of`/`all_of`/`none_of` (SCHEMA.md SS4) compiles a
    `string|string[]` into one `{"mentions": phrase}` condition PER phrase,
    combined with `any`/`all`/`none` respectively -- e.g. `all_of: "a, b"`
    becomes `{"all": [{"mentions": "a"}, {"mentions": "b"}]}` (a plain
    string is itself comma/newline-split into multiple phrases, matching
    how Mutation/Removal/SetOp values are split). A raw (non-sugar)
    `mentions: [a, b]` at a single condition node means "ANY of these are
    mentioned". `matches` takes a single regex string (per the JSON
    Schema), not a list.

PARSING (anima-style / labelled profiles)
    `profile.parse.labels.{container,section,leaf}` regexes (SCHEMA.md SS6)
    are matched as LINE-PREFIX patterns: for `leaf`, any trailing text on
    the same line after the bracket (e.g. "[quality] masterpiece, best
    quality") becomes that leaf's comma-split items; for `section`, the
    schema's own regex already captures the trailing content as its 2nd
    group. A line matching none of the three becomes an unlabelled
    top-level leaf (best-effort fallback) rather than a hard parse error.

Everything else (Document/Block/Item shape, selectors, group/switch/swap
semantics, dedup-on-add, remove/tmp visibility to later rules, and the
`{depth, kind, text}` trace shape) follows `src/prompt_rules/schema/SCHEMA.md` directly.
"""
from __future__ import annotations

from typing import Tuple, Union

from .document import Block, Bundle, Document, Item
from .engine import apply_ruleset, format_trace
from .profiles import Profile, load_profile, parse, render
from .rules import Ruleset, RulesetError, parse_ruleset
from .rules import validate_ruleset as validate

__all__ = [
    "Block", "Bundle", "Document", "Item",
    "Profile", "load_profile",
    "parse", "render",
    "Ruleset", "RulesetError", "parse_ruleset", "validate",
    "apply_ruleset", "format_trace",
    "transform",
]


def transform(pos_text: str, neg_text: str, ruleset_dict: Union[dict, Ruleset], profile) -> Tuple[str, str, list]:
    """Convenience one-shot: parse both prompts, apply the ruleset, render
    both back out. Returns `(pos_text_out, neg_text_out, trace)`.
    """
    prof = load_profile(profile)
    pos_doc = parse(pos_text or "", prof)
    neg_doc = parse(neg_text or "", prof)
    result = apply_ruleset({"positive": pos_doc, "negative": neg_doc}, ruleset_dict, prof)
    return (
        render(result["positive"], prof),
        render(result["negative"], prof),
        result["trace"],
    )
