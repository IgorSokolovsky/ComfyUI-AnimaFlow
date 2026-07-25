"""Parse + validate a Ruleset dict into typed rule objects (SCHEMA.md SS3),
via an `Auditor` that raises path-precise errors (SCHEMA.md SS8):

    Error at celica.yaml -> rules[0](celica).children[1].when.any[0], 'mentons' is not a valid condition

Clean-room from prompt-rules/SCHEMA.md + ruleset.schema.json; no code copied
from any other rule engine.
"""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field
from typing import List, Optional, Union

from ._util import listify_phrases

VALID_RULE_TYPES = {"tag", "group", "switch", "swap"}
CONDITION_KEYS = {"mentions", "matches", "flags", "in", "all", "any", "none", "not"}
VALID_CHARACTER_LABEL_STYLES = {"generic", "name", "none"}

# Closed property sets -- mirrors `prompt-rules/ruleset.schema.json`'s
# per-rule-type `additionalProperties: false` blocks exactly. An unknown key
# here is NOT ignored (that's the silent-failure hole this closes): a typo'd
# condition key (e.g. `anyof` for `any_of`) used to compile away to nothing,
# turning a conditional rule into an unconditional one with no warning.
TOP_LEVEL_KEYS = {"version", "profile", "options", "rules"}
OPTIONS_KEYS = {"conditionScope", "caseSensitive", "boundary", "characterLabel"}

TAG_RULE_KEYS = {
    "add", "add_negative", "all_of", "any_of", "into", "name", "none_of",
    "remove", "remove_negative", "set", "tmp", "type", "when",
}
GROUP_RULE_KEYS = {"all_of", "any_of", "children", "into", "name", "none_of", "type", "when"}
SWITCH_RULE_KEYS = {"all_of", "any_of", "children", "into", "name", "none_of", "type", "when"}
SWAP_RULE_KEYS = {
    "add", "add_negative", "all_of", "any_of", "into", "match", "name", "none_of", "type", "when",
}
RULE_KEYS_BY_TYPE = {
    "tag": TAG_RULE_KEYS,
    "group": GROUP_RULE_KEYS,
    "switch": SWITCH_RULE_KEYS,
    "swap": SWAP_RULE_KEYS,
}
# `default: true` (SCHEMA.md SS3.4) is meaningful ONLY on a rule object that
# is a direct child of a `switch`'s `children` list -- it is not part of any
# rule type's own property set.
SWITCH_CHILD_EXTRA_KEYS = {"default"}

MUTATION_OBJECT_KEYS = {"value", "into", "section", "at", "after", "before", "weight"}
REMOVAL_OBJECT_KEYS = {"value", "from"}
SETOP_KEYS = {"to", "target", "section"}


class RulesetError(Exception):
    """Raised by `parse_ruleset` when a ruleset fails validation.

    `.errors` holds every path-precise message collected while walking the
    ruleset (not just the first one).
    """

    def __init__(self, errors: List[str]):
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


# ---------------------------------------------------------------------------
# Typed rules
# ---------------------------------------------------------------------------

@dataclass
class TagRule:
    name: Optional[str]
    when: Optional[dict]
    into: Optional[str]
    add: list
    add_negative: list
    remove: list
    remove_negative: list
    tmp: list
    set: list
    path: str
    is_default: bool = False
    type: str = "tag"


@dataclass
class GroupRule:
    name: Optional[str]
    when: Optional[dict]
    into: Optional[str]
    children: list
    path: str
    is_default: bool = False
    type: str = "group"


@dataclass
class SwitchRule:
    name: Optional[str]
    when: Optional[dict]
    into: Optional[str]
    children: list
    path: str
    is_default: bool = False
    type: str = "switch"


@dataclass
class SwapRule:
    name: Optional[str]
    when: Optional[dict]
    into: Optional[str]
    match: list
    add: list
    add_negative: list
    path: str
    is_default: bool = False
    type: str = "swap"


Rule = Union[TagRule, GroupRule, SwitchRule, SwapRule]


@dataclass
class Ruleset:
    version: int
    profile: Optional[str]
    options: dict = field(default_factory=dict)
    rules: List[Rule] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Auditor
# ---------------------------------------------------------------------------

class Auditor:
    """Walks a raw ruleset dict, collecting path-precise error messages and
    (if there are none) building the typed `Ruleset`.
    """

    def __init__(self, source: str = "<ruleset>"):
        self.source = source
        self.errors: List[str] = []

    def error(self, path: str, reason: str) -> None:
        self.errors.append(f"Error at {self.source} → {path}, {reason}")

    def _check_unknown_keys(self, obj: dict, valid_keys: set, path: str, allow: Optional[set] = None) -> None:
        """Reject any key in `obj` not in `valid_keys` (plus `allow`, for the
        switch-child `default` carve-out), with a near-miss suggestion
        (`difflib.get_close_matches`) when the typo is close to a real key --
        e.g. `'anyof' is not a supported property (did you mean 'any_of'?)`.
        """
        allowed = valid_keys | (allow or set())
        for key in sorted(set(obj.keys()) - allowed):
            message = f"'{key}' is not a supported property"
            match = difflib.get_close_matches(key, sorted(allowed), n=1)
            if match:
                message += f" (did you mean '{match[0]}'?)"
            self.error(f"{path}.{key}", message)

    # -- top level ----------------------------------------------------------

    def audit_ruleset(self, data) -> Optional[Ruleset]:
        if not isinstance(data, dict):
            self.error("<root>", "ruleset must be an object")
            return None

        self._check_unknown_keys(data, TOP_LEVEL_KEYS, "<root>")

        rules_data = data.get("rules")
        if not isinstance(rules_data, list):
            self.error("rules", "'rules' is required and must be a list")
            rules_data = []

        raw_options = data.get("options")
        if isinstance(raw_options, dict):
            self._check_unknown_keys(raw_options, OPTIONS_KEYS, "options")

        options = dict(raw_options or {})
        options.setdefault("conditionScope", "*")
        options.setdefault("caseSensitive", False)
        options.setdefault("boundary", "word")
        # `characterLabel` (SCHEMA.md SS3/SS7) is deliberately left
        # absent-by-default -- NOT `setdefault`'d to a style -- so "this
        # sheet has no opinion" stays distinguishable from an explicit
        # choice (see `core/engine.py`'s `_stamp_character_containers`,
        # which only stamps a `character:*` container when the key is
        # actually present). Still validated when present.
        if "characterLabel" in options:
            value = options["characterLabel"]
            if value not in VALID_CHARACTER_LABEL_STYLES:
                self.error(
                    "options.characterLabel",
                    f"'{value}' is not a valid characterLabel (expected one of "
                    f"{sorted(VALID_CHARACTER_LABEL_STYLES)})",
                )

        rules: List[Rule] = []
        for i, rd in enumerate(rules_data):
            path = self._rule_path(f"rules[{i}]", rd)
            r = self.audit_rule(rd, path)
            if r is not None:
                rules.append(r)

        return Ruleset(version=data.get("version", 1), profile=data.get("profile"), options=options, rules=rules)

    @staticmethod
    def _rule_path(path: str, rd) -> str:
        name = rd.get("name") if isinstance(rd, dict) else None
        return f"{path}({name})" if name else path

    # -- one rule -------------------------------------------------------

    def audit_rule(self, rd, path: str, allow_default: bool = False) -> Optional[Rule]:
        if not isinstance(rd, dict):
            self.error(path, "rule must be an object")
            return None

        rtype = rd.get("type", "tag")
        if rtype not in VALID_RULE_TYPES:
            self.error(f"{path}.type", f"'{rtype}' is not supported")
            return None

        allow = SWITCH_CHILD_EXTRA_KEYS if allow_default else None
        self._check_unknown_keys(rd, RULE_KEYS_BY_TYPE[rtype], path, allow=allow)

        name = rd.get("name")
        into = rd.get("into")
        when = self._compile_when(rd, path)

        if rtype == "group":
            return self._audit_group(rd, path, name, when, into)
        if rtype == "switch":
            return self._audit_switch(rd, path, name, when, into)
        if rtype == "swap":
            return self._audit_swap(rd, path, name, when, into)
        return self._audit_tag(rd, path, name, when, into)

    def _audit_children(self, rd, path: str, type_label: str) -> List[Rule]:
        children_data = rd.get("children")
        if not isinstance(children_data, list):
            self.error(path, f"'children' is required for type '{type_label}'")
            children_data = []
        children: List[Rule] = []
        for i, cd in enumerate(children_data):
            cpath = self._rule_path(f"{path}.children[{i}]", cd)
            c = self.audit_rule(cd, cpath)
            if c is not None:
                children.append(c)
        return children

    def _audit_group(self, rd, path, name, when, into) -> GroupRule:
        children = self._audit_children(rd, path, "group")
        return GroupRule(name=name, when=when, into=into, children=children, path=path)

    def _audit_switch(self, rd, path, name, when, into) -> SwitchRule:
        children_data = rd.get("children")
        if not isinstance(children_data, list):
            self.error(path, "'children' is required for type 'switch'")
            children_data = []

        children: List[Rule] = []
        default_seen = False
        for i, cd in enumerate(children_data):
            cpath = self._rule_path(f"{path}.children[{i}]", cd)
            is_default = bool(cd.get("default")) if isinstance(cd, dict) else False
            if is_default:
                if default_seen:
                    self.error(cpath, "a switch may have at most one 'default' child")
                default_seen = True
            c = self.audit_rule(cd, cpath, allow_default=True)
            if c is None:
                continue
            c.is_default = is_default
            if is_default and c.when is not None:
                self.error(cpath, "a 'default' switch child cannot contain conditions (when/any_of/all_of/none_of)")
            if not is_default and c.when is None:
                self.error(cpath, "non-default switch children must have a condition (when/any_of/all_of/none_of)")
            children.append(c)

        return SwitchRule(name=name, when=when, into=into, children=children, path=path)

    def _audit_swap(self, rd, path, name, when, into) -> SwapRule:
        match_raw = rd.get("match")
        if match_raw is None:
            self.error(path, "'match' is required for type 'swap'")
            match = []
        else:
            match = listify_phrases(match_raw)

        add = self._compile_mutations(rd.get("add"), f"{path}.add")
        add_negative = self._compile_mutations(rd.get("add_negative"), f"{path}.add_negative")
        if not add and not add_negative:
            self.error(path, "'swap' requires 'add' or 'add_negative'")

        return SwapRule(name=name, when=when, into=into, match=match, add=add, add_negative=add_negative, path=path)

    def _audit_tag(self, rd, path, name, when, into) -> TagRule:
        add = self._compile_mutations(rd.get("add"), f"{path}.add")
        add_negative = self._compile_mutations(rd.get("add_negative"), f"{path}.add_negative")
        remove = self._compile_removals(rd.get("remove"), f"{path}.remove")
        remove_negative = self._compile_removals(rd.get("remove_negative"), f"{path}.remove_negative")
        tmp = self._compile_mutations(rd.get("tmp"), f"{path}.tmp")
        set_ops = self._compile_setops(rd.get("set"), f"{path}.set")

        if not any([add, add_negative, remove, remove_negative, tmp, set_ops]):
            self.error(
                path,
                "a 'tag' rule requires at least one of add/add_negative/remove/remove_negative/tmp/set",
            )

        return TagRule(
            name=name, when=when, into=into,
            add=add, add_negative=add_negative,
            remove=remove, remove_negative=remove_negative,
            tmp=tmp, set=set_ops, path=path,
        )

    # -- when / sugar ----------------------------------------------------

    def _compile_when(self, rd, path: str) -> Optional[dict]:
        parts = []
        if "when" in rd and rd["when"] is not None:
            validated = self._audit_condition(rd["when"], f"{path}.when")
            if validated is not None:
                parts.append(validated)
        if "any_of" in rd:
            parts.append({"any": [{"mentions": p} for p in listify_phrases(rd["any_of"])]})
        if "all_of" in rd:
            parts.append({"all": [{"mentions": p} for p in listify_phrases(rd["all_of"])]})
        if "none_of" in rd:
            parts.append({"none": [{"mentions": p} for p in listify_phrases(rd["none_of"])]})
        if not parts:
            return None
        if len(parts) == 1:
            return parts[0]
        return {"all": parts}

    def _audit_condition(self, cond, path: str) -> Optional[dict]:
        if not isinstance(cond, dict):
            self.error(path, "condition must be an object")
            return None

        unknown = set(cond.keys()) - CONDITION_KEYS
        for k in sorted(unknown):
            self.error(f"{path}.{k}", f"'{k}' is not a valid condition key")

        has_leaf = "mentions" in cond or "matches" in cond
        has_combinator = any(k in cond for k in ("all", "any", "none", "not"))
        if not has_leaf and not has_combinator:
            self.error(path, "condition requires one of mentions/matches/all/any/none/not")

        if "mentions" in cond and "matches" in cond:
            self.error(path, "condition cannot have both 'mentions' and 'matches'")

        if "matches" in cond and isinstance(cond["matches"], str):
            try:
                re.compile(cond["matches"])
            except re.error as exc:
                self.error(f"{path}.matches", f"'{cond['matches']}' is not a valid regex ({exc})")

        for key in ("all", "any", "none"):
            if key not in cond:
                continue
            if not isinstance(cond[key], list):
                self.error(f"{path}.{key}", f"'{key}' must be a list of conditions")
                continue
            for i, c in enumerate(cond[key]):
                self._audit_condition(c, f"{path}.{key}[{i}]")

        if "not" in cond:
            self._audit_condition(cond["not"], f"{path}.not")

        return cond

    # -- mutations / removals / set --------------------------------------

    def _compile_mutations(self, value, path: str) -> List[dict]:
        if value is None:
            return []

        def compile_one(v, idx):
            p = f"{path}[{idx}]" if idx is not None else path
            if isinstance(v, str):
                return {"value": v}
            if isinstance(v, list):
                if all(isinstance(x, str) for x in v):
                    return {"value": v}
                self.error(p, "a mutation list must contain strings")
                return None
            if isinstance(v, dict):
                self._check_unknown_keys(v, MUTATION_OBJECT_KEYS, p)
                if "value" not in v:
                    self.error(p, "a mutation object requires 'value'")
                    return None
                if "after" in v and "before" in v:
                    self.error(p, "a mutation cannot have both 'after' and 'before'")
                out = {"value": v["value"]}
                # `section` isn't in the Mutation schema (only SetOp's), but
                # the worked examples (prompt-rules/examples/*.yaml) use it as
                # section-shorthand on `add`/`tmp` too -- honour it the same
                # way as SetOp's `section`.
                for k in ("into", "at", "after", "before", "weight", "section"):
                    if k in v:
                        out[k] = v[k]
                return out
            self.error(p, "a mutation must be a string, a list of strings, or an object")
            return None

        if isinstance(value, list) and value and all(isinstance(x, dict) for x in value):
            out = []
            for i, v in enumerate(value):
                c = compile_one(v, i)
                if c is not None:
                    out.append(c)
            return out

        c = compile_one(value, None)
        return [c] if c is not None else []

    def _compile_removals(self, value, path: str) -> List[dict]:
        if value is None:
            return []

        def compile_one(v, idx):
            p = f"{path}[{idx}]" if idx is not None else path
            if isinstance(v, str):
                return {"value": v}
            if isinstance(v, list) and all(isinstance(x, str) for x in v):
                return {"value": v}
            if isinstance(v, dict):
                self._check_unknown_keys(v, REMOVAL_OBJECT_KEYS, p)
                if "value" not in v:
                    self.error(p, "a removal object requires 'value'")
                    return None
                out = {"value": v["value"]}
                if "from" in v:
                    out["from"] = v["from"]
                return out
            self.error(p, "a removal must be a string, a list of strings, or an object")
            return None

        if isinstance(value, list) and value and all(isinstance(x, dict) for x in value):
            out = []
            for i, v in enumerate(value):
                c = compile_one(v, i)
                if c is not None:
                    out.append(c)
            return out

        c = compile_one(value, None)
        return [c] if c is not None else []

    def _compile_setops(self, value, path: str) -> List[dict]:
        if value is None:
            return []

        def compile_one(v, idx):
            p = f"{path}[{idx}]" if idx is not None else path
            if not isinstance(v, dict):
                self.error(p, "'set' must be an object with 'to'")
                return None
            self._check_unknown_keys(v, SETOP_KEYS, p)
            if "to" not in v:
                self.error(p, "'to' is required for 'set'")
                return None
            out = {"to": v["to"]}
            if "target" in v:
                out["target"] = v["target"]
            if "section" in v:
                out["section"] = v["section"]
            return out

        if isinstance(value, list):
            out = []
            for i, v in enumerate(value):
                c = compile_one(v, i)
                if c is not None:
                    out.append(c)
            return out

        c = compile_one(value, None)
        return [c] if c is not None else []


def parse_ruleset(data: dict, source: str = "<ruleset>") -> Ruleset:
    """Validate + compile a raw ruleset dict; raises `RulesetError` (with
    every path-precise message collected) if it's invalid.
    """
    auditor = Auditor(source)
    rs = auditor.audit_ruleset(data)
    if auditor.errors:
        raise RulesetError(auditor.errors)
    return rs  # type: ignore[return-value]


def validate_ruleset(data: dict, source: str = "<ruleset>") -> dict:
    """SCHEMA.md SS1 `validate(ruleset, profile) -> {ok, errors[]}` contract."""
    auditor = Auditor(source)
    auditor.audit_ruleset(data)
    return {"ok": not auditor.errors, "errors": list(auditor.errors)}
