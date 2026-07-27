"""Plain-script tests cross-checking `src/prompt_rules/schema/ruleset.schema.json`
(JSON Schema, draft 2020-12) against the Python `Auditor` (`src/prompt_rules/core/rules.py`).

Run directly: `python tests/test_ruleset_schema.py` (no pytest, per project
convention).

This file needs the `jsonschema` package, which is a DEV-ONLY dependency
(`requirements-dev.txt` / pyproject.toml's `dev` extra) -- never a runtime
one; a plain ComfyUI user must never be made to install it. Unlike the
torch-guarded smoke tests elsewhere in this repo (where only ONE test in an
otherwise fully runnable file needs the optional import), literally every
test in THIS file needs `jsonschema` -- so the guard lives once, at the top
of `__main__`, rather than being repeated per test: if the import fails, the
whole file SKIP-prints a single line and exits 0 without running anything,
keeping `for f in tests/test_*.py` green on a machine without dev deps.

The Python `Auditor` remains the RUNTIME validation authority (imported by
nodes at runtime); the JSON Schema is an editor/CI surface only (autocomplete,
`ajv`/`jsonschema`-based pre-commit checks, etc.) -- see
`src/prompt_rules/schema/SCHEMA.md` SS10. The two must not drift, hence the
parity corpus below.
"""
from __future__ import annotations

import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from jsonschema import Draft202012Validator
    HAVE_JSONSCHEMA = True
except ImportError:
    HAVE_JSONSCHEMA = False

import yaml

from src.prompt_rules import core

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA_PATH = os.path.join(REPO_ROOT, "src", "prompt_rules", "schema", "ruleset.schema.json")
EXAMPLES_DIR = os.path.join(REPO_ROOT, "src", "prompt_rules", "schema", "examples")
RULES_DIR = os.path.join(REPO_ROOT, "rules")

_VALIDATOR = None  # lazily built by `_validator()`, only ever called when HAVE_JSONSCHEMA


def _validator():
    """Build (and cache) the schema validator. `ruleset.schema.json` declares
    `$schema: .../draft/2020-12/schema`, so `Draft202012Validator` is the
    correct engine (not the newer-draft-agnostic auto-detecting validator --
    we want a hard failure if the file's declared draft ever silently
    changes to something this validator can't check).
    """
    global _VALIDATOR
    if _VALIDATOR is None:
        with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
            schema = json.load(f)
        Draft202012Validator.check_schema(schema)
        _VALIDATOR = Draft202012Validator(schema)
    return _VALIDATOR


def schema_errors(data) -> list:
    return list(_validator().iter_errors(data))


def schema_ok(data) -> bool:
    return not schema_errors(data)


def python_ok(data, source: str = "<ruleset>") -> bool:
    return core.validate(data, source=source)["ok"]


def load_yaml(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def shipped_sheet_paths():
    """Every sheet actually shipped with the repo, globbed (not hardcoded)
    so a newly added sheet is covered automatically -- mirrors
    `tests/test_rules.py`'s `test_every_shipped_sheet_validates_cleanly`.
    """
    return sorted(glob.glob(os.path.join(RULES_DIR, "*.yaml"))) + sorted(
        glob.glob(os.path.join(EXAMPLES_DIR, "*.yaml"))
    )


# ---------------------------------------------------------------------------
# The confirmed defect (regression guard): `ruleset.schema.json` used to
# reject every shipped sheet with exactly one error each --
# `Additional properties are not allowed ('default' was unexpected)` at
# `.../switchRule/children/items` -- because `switchRule.children.items`
# declared `properties: {default: ...}` one level ABOVE the `$ref`'d `rule`
# schema that dispatches (via `if`/`then`) into `tagRule`, whose
# `additionalProperties: false` can only see properties declared in its OWN
# schema object, not a parent's. Fixed by dropping `additionalProperties:
# false` from the four rule-variant `$defs` and adding `unevaluatedProperties:
# false` at each POINT OF USE (`properties.rules.items`, `groupRule.children.
# items`, `switchRule.children.items`) instead -- `unevaluatedProperties`
# collects annotations from the whole subschema tree reachable via `$ref`/
# `allOf`/`if`/`then` starting at that same use site, so it sees BOTH the
# use site's own `properties` (e.g. `default`) AND the referenced variant's.
# ---------------------------------------------------------------------------

def test_every_shipped_sheet_validates_with_zero_schema_errors():
    paths = shipped_sheet_paths()
    assert paths, "expected at least one shipped ruleset file to check"
    for path in paths:
        data = load_yaml(path)
        errors = schema_errors(data)
        assert errors == [], (path, [e.message for e in errors])


def test_default_true_accepted_on_direct_switch_child():
    good = {
        "version": 1,
        "rules": [
            {"type": "switch", "children": [{"any_of": "a", "add": "x"}, {"default": True, "add": "y"}]}
        ],
    }
    assert schema_ok(good), [e.message for e in schema_errors(good)]


def test_default_true_rejected_on_top_level_rule():
    """The naive fix (adding `default` to every variant's own `properties`)
    would make this incorrectly pass -- `default` must stay illegal outside
    a switch's direct children, matching `src/prompt_rules/core/rules.py`'s
    `SWITCH_CHILD_EXTRA_KEYS` carve-out.
    """
    bad = {"version": 1, "rules": [{"default": True, "add": "x"}]}
    assert not schema_ok(bad)


def test_default_true_rejected_on_group_child():
    bad = {"version": 1, "rules": [{"type": "group", "children": [{"default": True, "add": "x"}]}]}
    assert not schema_ok(bad)


def test_unknown_key_rejected_on_each_rule_type():
    """Proves the fix didn't loosen anything: each of the four rule types
    still rejects a key outside its own property set.
    """
    cases = {
        "tag": {"name": "t", "unknown_tag_key": True, "add": "x"},
        "group": {"type": "group", "unknown_group_key": True, "children": [{"add": "x"}]},
        "switch": {"type": "switch", "unknown_switch_key": True, "children": [{"default": True, "add": "x"}]},
        "swap": {"type": "swap", "unknown_swap_key": True, "match": "x", "add": "y"},
    }
    for rtype, rule in cases.items():
        bad = {"version": 1, "rules": [rule]}
        assert not schema_ok(bad), rtype


def test_anyof_typo_real_world_repro_is_rejected():
    """Exact repro from `src/prompt_rules/core/rules.py`'s docstring/tests: `anyof` (not
    `any_of`) used to silently compile away in the Python engine; the schema
    must reject it as an unknown property on a `tagRule` too.
    """
    bad = {"version": 1, "rules": [{"name": "t", "anyof": "celica", "add": "BLACK HAIR"}]}
    assert not schema_ok(bad)


def test_unknown_top_level_ruleset_key_rejected():
    bad = {"version": 1, "rule": [{"add": "x"}]}  # 'rule' instead of 'rules'
    assert not schema_ok(bad)


def test_unknown_options_key_rejected():
    bad = {"version": 1, "options": {"characterLabl": "generic"}, "rules": [{"add": "x"}]}
    assert not schema_ok(bad)


def test_valid_character_label_validates():
    for value in ("generic", "name", "none"):
        good = {"version": 1, "options": {"characterLabel": value}, "rules": [{"add": "x"}]}
        assert schema_ok(good), value


def test_invalid_character_label_rejected():
    bad = {"version": 1, "options": {"characterLabel": "bogus"}, "rules": [{"add": "x"}]}
    assert not schema_ok(bad)


# ---------------------------------------------------------------------------
# Parity corpus: the Python `Auditor` (runtime authority) and the JSON Schema
# (editor/CI surface) must not silently drift apart. Each entry pairs a
# ruleset with what BOTH validators are expected to say; entries marked
# "diverge" are GENUINE, DOCUMENTED expected divergences (never forced into
# false agreement) -- semantic checks the Auditor makes that plain JSON
# Schema structurally cannot express. See the per-entry comments below for
# why each divergence is defensible.
# ---------------------------------------------------------------------------

PARITY_CORPUS = []


def _corpus(name, ruleset, expect_agree, reason=None):
    PARITY_CORPUS.append({"name": name, "ruleset": ruleset, "expect_agree": expect_agree, "reason": reason})


# -- agreeing: valid shapes --------------------------------------------------

_corpus("celica_real_sheet", load_yaml(os.path.join(RULES_DIR, "celica.yaml")), True)

_corpus(
    "switch_default_child_valid",
    {
        "version": 1,
        "rules": [{"type": "switch", "children": [{"any_of": "a", "add": "x"}, {"default": True, "add": "y"}]}],
    },
    True,
)

_corpus(
    "valid_characterLabel_generic",
    {"version": 1, "options": {"characterLabel": "generic"}, "rules": [{"add": "x"}]},
    True,
)

# -- agreeing: invalid shapes -------------------------------------------------

_corpus("default_on_top_level_rule", {"version": 1, "rules": [{"default": True, "add": "x"}]}, True)

_corpus(
    "default_on_group_child",
    {"version": 1, "rules": [{"type": "group", "children": [{"default": True, "add": "x"}]}]},
    True,
)

_corpus("anyof_typo", {"version": 1, "rules": [{"anyof": "celica", "add": "x"}]}, True)

_corpus("unknown_top_level_key", {"version": 1, "rule": [{"add": "x"}]}, True)

_corpus(
    "unknown_options_key",
    {"version": 1, "options": {"characterLabl": "generic"}, "rules": [{"add": "x"}]},
    True,
)

_corpus(
    "invalid_characterLabel",
    {"version": 1, "options": {"characterLabel": "bogus"}, "rules": [{"add": "x"}]},
    True,
)

_corpus(
    "group_rule_with_add_key",
    {"version": 1, "rules": [{"type": "group", "add": "x", "children": [{"add": "y"}]}]},
    True,
)

_corpus(
    "mutation_after_before_conflict",
    {"version": 1, "rules": [{"add": {"value": "x", "after": "a", "before": "b"}}]},
    True,
)

# -- documented expected divergences ------------------------------------------

_corpus(
    "invalid_regex_in_matches",
    {"version": 1, "rules": [{"when": {"matches": "([a-z"}, "add": "x"}]},
    False,
    reason=(
        "The Auditor `re.compile()`s a `matches` string and rejects an invalid "
        "regex; JSON Schema only declares `matches` as `type: string` -- there "
        "is no JSON Schema keyword that validates 'this string is a syntactically "
        "valid regex in Python's `re` dialect', so the schema structurally cannot "
        "express this check."
    ),
)

_corpus(
    "switch_two_default_children",
    {
        "version": 1,
        "rules": [{"type": "switch", "children": [{"default": True, "add": "x"}, {"default": True, "add": "y"}]}],
    },
    False,
    reason=(
        "The Auditor enforces 'a switch may have at most one default child' "
        "(a cross-item cardinality constraint over the `children` array). "
        "`ruleset.schema.json` has no such constraint on `switchRule.children` "
        "-- expressing 'at most one item with `default: true`' would need a "
        "`not: {contains: ..., minContains: 2}`-style construct this schema "
        "does not include, so two `default: true` children pass schema "
        "validation today."
    ),
)

_corpus(
    "switch_child_missing_condition",
    {"version": 1, "rules": [{"type": "switch", "children": [{"add": "x"}, {"default": True, "add": "y"}]}]},
    False,
    reason=(
        "The Auditor requires every non-default switch child to carry a "
        "condition (when/any_of/all_of/none_of). This is a semantic rule tied "
        "to the child's POSITION (is it the switch's default child or not), "
        "not a per-object structural constraint any rule variant's own schema "
        "can express -- `when`/`any_of`/etc. are optional on every rule type, "
        "so a conditionless non-default switch child still validates."
    ),
)

_corpus(
    "default_child_with_condition",
    {
        "version": 1,
        "rules": [
            {
                "type": "switch",
                "children": [{"any_of": "a", "add": "x"}, {"default": True, "any_of": "b", "add": "y"}],
            }
        ],
    },
    False,
    reason=(
        "The Auditor rejects a `default: true` switch child that ALSO carries "
        "a condition (when/any_of/all_of/none_of) -- 'a default switch child "
        "cannot contain conditions'. The schema has no `if default==true then "
        "forbid when/any_of/...`-style cross-property constraint wired up for "
        "switch children, so this combination currently passes schema "
        "validation."
    ),
)


def test_parity_corpus_agrees_except_documented_divergences():
    assert len(PARITY_CORPUS) >= 8, "corpus should cover a meaningful range of valid/invalid shapes"

    for entry in PARITY_CORPUS:
        name, rs, expect_agree, reason = entry["name"], entry["ruleset"], entry["expect_agree"], entry["reason"]
        p_ok = python_ok(rs, source=name)
        s_ok = schema_ok(rs)

        if expect_agree:
            assert p_ok == s_ok, (name, "python_ok=%r schema_ok=%r" % (p_ok, s_ok))
        else:
            assert reason, (name, "a divergence entry must document its reason")
            assert p_ok != s_ok, (
                name,
                "expected a DOCUMENTED divergence but the validators agreed -- "
                "either the Python side or the schema changed; update the corpus entry",
            )
            # Every documented divergence so far is the Auditor being STRICTER
            # (a semantic check JSON Schema cannot express structurally) --
            # assert that direction explicitly so a future divergence that
            # goes the other way (schema stricter than Python) still fails
            # loudly instead of silently matching this shape.
            assert p_ok is False and s_ok is True, (name, p_ok, s_ok)


ALL_TESTS = [
    test_every_shipped_sheet_validates_with_zero_schema_errors,
    test_default_true_accepted_on_direct_switch_child,
    test_default_true_rejected_on_top_level_rule,
    test_default_true_rejected_on_group_child,
    test_unknown_key_rejected_on_each_rule_type,
    test_anyof_typo_real_world_repro_is_rejected,
    test_unknown_top_level_ruleset_key_rejected,
    test_unknown_options_key_rejected,
    test_valid_character_label_validates,
    test_invalid_character_label_rejected,
    test_parity_corpus_agrees_except_documented_divergences,
]


if __name__ == "__main__":
    if not HAVE_JSONSCHEMA:
        print(
            "SKIP  test_ruleset_schema: jsonschema is not installed "
            "(pip install -r requirements-dev.txt, or `pip install -e .[dev]`) "
            "-- schema cross-check tests skipped; src/prompt_rules/core/rules.py's Auditor "
            "remains the runtime validation authority regardless"
        )
        raise SystemExit(0)

    failures = []
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001 - surface unexpected errors as failures too
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
