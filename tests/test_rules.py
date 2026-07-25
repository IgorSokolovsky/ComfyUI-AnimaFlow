"""Plain-script tests for the prompt-rules engine (`core/`).

Run directly: `python tests/test_rules.py` (no pytest, per project convention).

IMPORTANT: the `# Output:` comments in the example YAML files
(`prompt-rules/examples/*.yaml`) are ILLUSTRATIVE -- they assume anchor
insertion (inserting a new tag exactly where a removed/matched one used to
be) that v1 does not implement (adds always append at the end of the
target block; see `core/__init__.py`'s v1-simplifications docstring). These
tests assert on SEMANTIC PROPERTIES (substrings/contains, section
contents), not exact rendered strings.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import yaml

import core
from core import profiles as core_profiles
from core.document import find_by_label
from nodes.anima_prompt import _rules_helpers as rh

EXAMPLES_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompt-rules", "examples"
)


def load_yaml(name: str) -> dict:
    path = os.path.join(EXAMPLES_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


# ---------------------------------------------------------------------------
# Booru / illustrious profile (celica.booru.yaml)
# ---------------------------------------------------------------------------

def test_booru_jacket_branch():
    ruleset = load_yaml("celica.booru.yaml")
    pos_out, neg_out, _trace = core.transform("1girl, celica, jacket, smile", "sketch", ruleset, "illustrious")

    assert "short black hair" in pos_out, pos_out
    assert "pixie cut" in pos_out, pos_out
    assert "blue eyes" in pos_out, pos_out
    assert "black leather jacket" in pos_out, pos_out
    assert "celica" not in pos_out, pos_out
    assert "blurry" in neg_out, neg_out


def test_booru_shirt_branch():
    ruleset = load_yaml("celica.booru.yaml")
    pos_out, _neg_out, _trace = core.transform("1girl, celica, shirt, smile", "sketch", ruleset, "illustrious")

    assert "black t-shirt" in pos_out, pos_out
    assert "black leather jacket" not in pos_out, pos_out


def test_booru_default_branch():
    ruleset = load_yaml("celica.booru.yaml")
    pos_out, _neg_out, _trace = core.transform("1girl, celica, smile", "sketch", ruleset, "illustrious")

    assert "black camisole" in pos_out, pos_out
    assert "black leather jacket" not in pos_out, pos_out
    assert "black t-shirt" not in pos_out, pos_out


def test_booru_none_of_gate_blocks_blue_eyes():
    ruleset = load_yaml("celica.booru.yaml")
    pos_out, _neg_out, _trace = core.transform("1girl, celica, jacket, closed eyes", "sketch", ruleset, "illustrious")

    assert "blue eyes" not in pos_out, pos_out
    # Unconditional adds in the same group still fire.
    assert "short black hair" in pos_out, pos_out
    assert "black leather jacket" in pos_out, pos_out


def test_booru_dedup_on_repeated_apply():
    ruleset = load_yaml("celica.booru.yaml")
    prof = "illustrious"
    pos_doc = core.parse("1girl, celica, jacket, smile", prof)
    neg_doc = core.parse("sketch", prof)

    result = core.apply_ruleset({"positive": pos_doc, "negative": neg_doc}, ruleset, prof)
    result2 = core.apply_ruleset({"positive": result["positive"], "negative": result["negative"]}, ruleset, prof)
    pos_out = core.render(result2["positive"], prof)

    assert pos_out.count("short black hair") == 1, pos_out
    assert pos_out.count("pixie cut") == 1, pos_out
    assert pos_out.count("blue eyes") == 1, pos_out
    assert pos_out.count("black leather jacket") == 1, pos_out


# ---------------------------------------------------------------------------
# Anima profile (celica.anima.yaml) -- same logic, sectioned prose shape.
# ---------------------------------------------------------------------------

ANIMA_POS = (
    "[quality] masterpiece, best quality\n"
    "[character:celica]\n"
    "appearance:\n"
    "clothes:\n"
    "action:\n"
    "focus: celica, jacket\n"
    "[global] cafe, morning light"
)
ANIMA_NEG = "sketch"


def _run_anima(pos_text=ANIMA_POS, neg_text=ANIMA_NEG):
    ruleset = load_yaml("celica.anima.yaml")
    prof = "anima"
    pos_doc = core.parse(pos_text, prof)
    neg_doc = core.parse(neg_text, prof)
    result = core.apply_ruleset({"positive": pos_doc, "negative": neg_doc}, ruleset, prof)
    return result, prof


def test_anima_sections_and_negative():
    result, prof = _run_anima()
    positive, negative, trace = result["positive"], result["negative"], result["trace"]

    character = find_by_label(positive.root, "character:celica")
    assert character, "expected a 'character:celica' block to exist"
    character = character[0]

    clothes = next(c for c in character.children if c.label == "clothes")
    clothes_text = clothes.sep.join(i.text for i in clothes.items if i.enabled)
    assert clothes_text == "black leather jacket", clothes_text

    appearance = next(c for c in character.children if c.label == "appearance")
    appearance_text = appearance.sep.join(i.text for i in appearance.items if i.enabled)
    assert "blue eyes" in appearance_text, appearance_text
    assert "short black hair" in appearance_text, appearance_text

    pos_out = core.render(positive, prof)
    assert "celica" not in pos_out.lower(), pos_out

    neg_out = core.render(negative, prof)
    assert "blurry" in neg_out, neg_out

    assert trace, "expected a non-empty trace"


def test_anima_none_of_gate_blocks_blue_eyes():
    pos_text = ANIMA_POS.replace("focus: celica, jacket", "focus: celica, jacket, closed eyes")
    result, _prof = _run_anima(pos_text=pos_text)
    positive = result["positive"]

    character = find_by_label(positive.root, "character:celica")[0]
    appearance = next(c for c in character.children if c.label == "appearance")
    appearance_text = appearance.sep.join(i.text for i in appearance.items if i.enabled)

    assert "blue eyes" not in appearance_text, appearance_text
    # The unconditional `set` for appearance still fires.
    assert "short black hair" in appearance_text, appearance_text


# ---------------------------------------------------------------------------
# Negative-document targeting (BUG fix C): a group's `into` (e.g.
# "character:celica") addresses a POSITIVE-side container and must NOT be
# inherited as the default target/scope for `add_negative`/`remove_negative`/
# `tmp`'s negative half -- the negative document has no character-container
# structure. Before the fix this (a) leaked the literal "character:celica: "
# label into the rendered negative text sent to the encoder, and (b) made a
# bare `remove_negative` (no explicit `from`) silently no-op, since it only
# searched inside that non-existent labelled scope.
# ---------------------------------------------------------------------------

def test_group_negative_ops_do_not_inherit_positive_into():
    """Exact repro from the bug report: a group `into: "character:celica"`
    with `add_negative: "blurry"` and a bare `remove_negative: "lowres"`,
    against negative input "sketch, lowres". Asserts on the FULL rendered
    string (not just substring-present) -- a substring-only assertion is
    exactly what let this bug hide previously.
    """
    ruleset = {
        "version": 1,
        "rules": [
            {
                "name": "celica",
                "type": "group",
                "into": "character:celica",
                "children": [
                    {"name": "r1", "remove_negative": {"value": "sketch", "from": "*"}},
                    {"name": "r2", "remove_negative": "lowres"},
                    {"name": "r3", "add_negative": "blurry"},
                ],
            }
        ],
    }
    _pos_out, neg_out, _trace = core.transform("", "sketch, lowres", ruleset, "anima")

    assert neg_out == "blurry", neg_out
    assert "lowres" not in neg_out, neg_out
    assert "character:celica" not in neg_out, neg_out


def test_celica_sheet_negative_render_never_leaks_container_label():
    """Same check against the REAL `rules/celica.yaml` sheet (via
    `apply_rulesets(sheets="celica")`, the node-facing entry point), not a
    synthetic ruleset.
    """
    pos_out, neg_out, _trace, errors = rh.apply_rulesets(ANIMA_POS, ANIMA_NEG, "anima", sheets="celica")

    assert errors == [], errors
    assert neg_out == "sketch, blurry, low quality, extra fingers", neg_out
    assert "character:celica" not in neg_out, neg_out
    assert ":" not in neg_out, neg_out  # no labelled block at all in the negative render
    # Positive side is untouched by this check (covered in detail below).
    assert "appearance:" in pos_out, pos_out


def test_remove_negative_explicit_from_still_works():
    """Regression: `remove_negative` WITH an explicit `from` continues to
    work exactly as before the fix (only the inherited *default* changed).
    """
    ruleset = {
        "version": 1,
        "rules": [
            {
                "type": "group",
                "into": "character:celica",
                "children": [
                    {"remove_negative": {"value": "sketch", "from": "*"}},
                ],
            },
        ],
    }
    _pos_out, neg_out, _trace = core.transform("", "sketch, lowres", ruleset, "anima")

    assert neg_out == "lowres", neg_out


def test_negative_mutation_explicit_into_is_honored():
    """A mutation with its OWN explicit `into` (not inherited from the
    group) must still be honored in the negative document exactly as
    today -- the fix only changes the *inherited default*, never an
    explicit override.
    """
    ruleset = {
        "version": 1,
        "rules": [
            {
                "type": "group",
                "into": "character:celica",
                "children": [
                    {"add_negative": {"value": "extra grain", "into": "camera"}},
                ],
            },
        ],
    }
    _pos_out, neg_out, _trace = core.transform("", "sketch", ruleset, "anima")

    assert neg_out == "sketch\ncamera: extra grain", neg_out


def test_negative_stays_single_flat_leaf_in_common_case():
    """Without an explicit override, `add_negative`/`remove_negative` must
    keep operating on the SAME single flat leaf -- no spurious extra block
    created (regardless of an inherited group `into`).
    """
    ruleset = {
        "version": 1,
        "rules": [
            {
                "type": "group",
                "into": "character:celica",
                "children": [
                    {"remove_negative": "lowres"},
                    {"add_negative": "blurry"},
                ],
            },
        ],
    }
    pos_doc = core.parse("", "anima")
    neg_doc = core.parse("sketch, lowres", "anima")
    result = core.apply_ruleset({"positive": pos_doc, "negative": neg_doc}, ruleset, "anima")
    negative = result["negative"]

    assert [c.label for c in negative.root.children] == [""], [c.label for c in negative.root.children]
    assert core.render(negative, "anima") == "sketch, blurry", core.render(negative, "anima")


def test_positive_side_into_inheritance_is_unchanged():
    """Backward-compat guard: the celica sheet's five rules must all still
    fire exactly as before -- a group's `into: "character:celica"` still
    routes `add`/`set`/`section` writes into that character's container, and
    the positive render still shows the `appearance:`/`clothes:` section
    prefixes. Only negative-side default targeting changed.
    """
    pos_out, neg_out, _trace, errors = rh.apply_rulesets(ANIMA_POS, ANIMA_NEG, "anima", sheets="celica")

    assert errors == [], errors
    # appearance filled (unconditional `set` + conditional `add` blue eyes)
    assert "appearance: short black hair, pixie cut, blue eyes" in pos_out, pos_out
    # jacket branch chosen (ANIMA_POS's "focus: celica, jacket" mentions "jacket")
    assert "clothes: black leather jacket" in pos_out, pos_out
    assert "black t-shirt" not in pos_out, pos_out
    assert "black camisole" not in pos_out, pos_out
    # name stripped (remove-activation: "celica" removed from "*")
    assert "celica" not in pos_out.lower(), pos_out
    # negative guard added
    assert "blurry" in neg_out, neg_out


# ---------------------------------------------------------------------------
# Anima `leaf` regex (BUG fix A): `^\[(quality|global)\]$` could never match
# its own documented "[label] trailing text" input format (the `$` anchor
# rejected any trailing content). Fixed to `^\[(quality|global)\]` (a
# line-prefix match, like `container`/`section`); `_parse_labelled`'s
# existing `rest = line[m.end():].strip()` + `split_values(rest)` then does
# the rest unchanged.
# ---------------------------------------------------------------------------

def test_anima_leaf_with_trailing_content_parses_as_labelled_leaf():
    doc = core.parse("[quality] masterpiece, best quality", "anima")
    leaf = doc.root.children[0]

    assert leaf.label == "quality", leaf.label
    assert [i.text for i in leaf.items] == ["masterpiece", "best quality"], leaf.items


def test_anima_bare_leaf_bracket_yields_empty_items():
    doc = core.parse("[quality]", "anima")
    leaf = doc.root.children[0]

    assert leaf.label == "quality", leaf.label
    assert leaf.items == [], leaf.items


def test_anima_global_leaf_with_trailing_content_parses_as_labelled_leaf():
    doc = core.parse("[global] cafe, morning light", "anima")
    leaf = doc.root.children[0]

    assert leaf.label == "global", leaf.label
    assert [i.text for i in leaf.items] == ["cafe", "morning light"], leaf.items


def test_anima_unrecognized_line_still_falls_back_to_unlabelled_leaf():
    doc = core.parse("just some free-form line", "anima")
    leaf = doc.root.children[0]

    assert leaf.label == "", leaf.label
    assert [i.text for i in leaf.items] == ["just some free-form line"], leaf.items


def test_anima_rendered_output_never_contains_literal_bracket_markers():
    doc = core.parse(ANIMA_POS, "anima")
    out = core.render(doc, "anima")

    assert "[quality]" not in out, out
    assert "[global]" not in out, out
    # The now-labelled leaves render with the profile's "prefix" style,
    # exactly like the `appearance:`/`clothes:` sections already do.
    assert "quality: masterpiece, best quality" in out, out
    assert "global: cafe, morning light" in out, out


# ---------------------------------------------------------------------------
# `block_order` (FEATURE fix B): render-time-only reordering of `doc.root`'s
# top-level children per `Profile.block_order` (SCHEMA.md SS6). Nested
# children (e.g. a character container's own sections) are never reordered,
# and profiles with an empty `block_order` are a byte-identical no-op.
# ---------------------------------------------------------------------------

ANIMA_SCRAMBLED = (
    "[global] cafe, morning light\n"
    "[character:celica]\n"
    "action: standing\n"
    "[quality] masterpiece, best quality"
)


def test_block_order_reorders_top_level_children_quality_character_global():
    doc = core.parse(ANIMA_SCRAMBLED, "anima")
    out = core.render(doc, "anima")

    assert out.index("quality:") < out.index("action:") < out.index("global:"), out


ANIMA_SCRAMBLED_TWO_CHARACTERS = (
    "[global] g\n"
    "[character:celica]\n"
    "action: first-character-action\n"
    "[character:ren]\n"
    "action: second-character-action\n"
    "[quality] q"
)


def test_block_order_multiple_character_containers_keep_relative_order():
    doc = core.parse(ANIMA_SCRAMBLED_TWO_CHARACTERS, "anima")
    out = core.render(doc, "anima")

    assert out.index("quality:") < out.index("first-character-action"), out
    assert out.index("first-character-action") < out.index("second-character-action"), out
    assert out.index("second-character-action") < out.index("global:"), out


def test_block_order_unrecognized_label_goes_last_and_keeps_relative_order():
    text = "randomline1\n[quality] q\n[global] g\nrandomline2"
    doc = core.parse(text, "anima")
    out = core.render(doc, "anima")
    lines = out.split("\n")

    assert lines == ["quality: q", "global: g", "randomline1", "randomline2"], lines


def test_block_order_does_not_mutate_document():
    doc = core.parse(ANIMA_SCRAMBLED, "anima")
    before = [c.label for c in doc.root.children]

    core.render(doc, "anima")

    after = [c.label for c in doc.root.children]
    assert after == before, (before, after)


def test_block_order_nested_sections_inside_character_are_not_reordered():
    text = (
        "[character:celica]\n"
        "focus: f\n"
        "action: a\n"
        "clothes: c\n"
        "appearance: ap\n"
        "[quality] q"
    )
    doc = core.parse(text, "anima")
    character = find_by_label(doc.root, "character:celica")[0]

    # Authored order (focus, action, clothes, appearance) is kept as-is --
    # none of those labels are in `block_order`, and nested children are
    # out of scope for it regardless.
    assert [c.label for c in character.children] == ["focus", "action", "clothes", "appearance"]

    out = core.render(doc, "anima")
    assert out.index("focus:") < out.index("action:") < out.index("clothes:") < out.index("appearance:"), out


def test_block_order_empty_profiles_are_provable_no_ops():
    # `raw`/`illustrious`/`pony`/`flux`/`wan` all ship an empty `block_order`
    # -- the ordering helper must return `root.children` UNCHANGED (identity,
    # not just equal), so these profiles' render output can never differ
    # from before this feature existed.
    fixtures = {
        "raw": ("1girl, celica, jacket, smile", "1girl, celica, jacket, smile"),
        "illustrious": ("1girl, celica, jacket, smile", "1girl, celica, jacket, smile"),
        "pony": ("1girl, celica, jacket, smile", "1girl, celica, jacket, smile"),
        "flux": (
            "A girl stands in a cafe. She wears a jacket.",
            "A girl stands in a cafe. She wears a jacket",
        ),
        "wan": (
            "A girl stands in a cafe. She wears a jacket.",
            "A girl stands in a cafe. She wears a jacket",
        ),
    }
    for profile_id, (text, expected_render) in fixtures.items():
        prof = core.load_profile(profile_id)
        assert prof.block_order == [], (profile_id, prof.block_order)

        doc = core.parse(text, profile_id)
        ordered = core_profiles._ordered_top_level_children(doc.root, prof)
        assert ordered is doc.root.children, profile_id

        actual_render = core.render(doc, profile_id)
        assert actual_render == expected_render, (profile_id, actual_render)


# ---------------------------------------------------------------------------
# swap
# ---------------------------------------------------------------------------

def test_swap_rule_expands_placeholder_and_removes_it():
    ruleset = {
        "version": 1,
        "rules": [
            {"name": "bg-swap", "type": "swap", "match": "PLACEHOLDER_BG", "add": "detailed background, bokeh"},
        ],
    }
    pos_out, _neg_out, trace = core.transform("1girl, PLACEHOLDER_BG, smile", "", ruleset, "illustrious")

    assert "PLACEHOLDER_BG" not in pos_out, pos_out
    assert "detailed background" in pos_out, pos_out
    assert "bokeh" in pos_out, pos_out
    assert any(e["kind"] == "swap" for e in trace), trace


def test_swap_rule_is_noop_when_placeholder_absent():
    ruleset = {
        "version": 1,
        "rules": [{"name": "bg-swap", "type": "swap", "match": "PLACEHOLDER_BG", "add": "detailed background"}],
    }
    pos_out, _neg_out, _trace = core.transform("1girl, smile", "", ruleset, "illustrious")

    assert pos_out == "1girl, smile", pos_out


# ---------------------------------------------------------------------------
# `matches` condition
# ---------------------------------------------------------------------------

def test_matches_condition_regex_gates_add():
    ruleset = {
        "version": 1,
        "rules": [{"name": "hair-guard", "when": {"matches": r"^jack.*"}, "add": "denim"}],
    }
    pos_out, _neg_out, _trace = core.transform("1girl, jacket", "", ruleset, "illustrious")
    assert "denim" in pos_out, pos_out

    pos_out2, _neg_out2, _trace2 = core.transform("1girl, shirt", "", ruleset, "illustrious")
    assert "denim" not in pos_out2, pos_out2


# ---------------------------------------------------------------------------
# `options.conditionScope` (regression: engine used to hardcode "*" and
# never read this option -- a bare `mentions` without its own `in` must be
# scoped by `conditionScope`, not always search the whole document).
# ---------------------------------------------------------------------------

ANIMA_SCOPE_TEXT = (
    "[character:celica]\n"
    "clothes: jacket\n"
    "action: running\n"
)


def test_condition_scope_option_scopes_bare_mentions():
    scoped_to_action = {
        "version": 1,
        "options": {"conditionScope": "action"},
        "rules": [{"name": "r", "when": {"mentions": "jacket"}, "add": "SHOULD_NOT_FIRE"}],
    }
    pos_out, _neg_out, _trace = core.transform(ANIMA_SCOPE_TEXT, "", scoped_to_action, "anima")
    assert "SHOULD_NOT_FIRE" not in pos_out, pos_out

    scoped_to_clothes = {
        "version": 1,
        "options": {"conditionScope": "clothes"},
        "rules": [{"name": "r", "when": {"mentions": "jacket"}, "add": "SHOULD_FIRE"}],
    }
    pos_out2, _neg_out2, _trace2 = core.transform(ANIMA_SCOPE_TEXT, "", scoped_to_clothes, "anima")
    assert "SHOULD_FIRE" in pos_out2, pos_out2


# ---------------------------------------------------------------------------
# Selectors: `#id`, `label:*` glob, `@negative`
# ---------------------------------------------------------------------------

def test_selector_by_id_scopes_condition():
    doc = core.parse(ANIMA_SCOPE_TEXT, "anima")
    neg_doc = core.parse("", "anima")
    clothes = find_by_label(doc.root, "clothes")[0]

    ruleset = {
        "version": 1,
        "rules": [{"when": {"mentions": "jacket", "in": f"#{clothes.id}"}, "add": "ID_MATCHED"}],
    }
    result = core.apply_ruleset({"positive": doc, "negative": neg_doc}, ruleset, "anima")
    pos_out = core.render(result["positive"], "anima")
    assert "ID_MATCHED" in pos_out, pos_out


ANIMA_GLOB_TEXT = (
    "[character:celica]\n"
    "clothes: jacket\n"
    "action: running\n"
    "focus: celica\n"
)


def test_selector_glob_scopes_condition_to_matching_containers():
    doc = core.parse(ANIMA_GLOB_TEXT, "anima")
    neg_doc = core.parse("", "anima")

    ruleset = {
        "version": 1,
        "rules": [{"when": {"mentions": "celica", "in": "character:*"}, "add": "GLOB_MATCHED"}],
    }
    result = core.apply_ruleset({"positive": doc, "negative": neg_doc}, ruleset, "anima")
    pos_out = core.render(result["positive"], "anima")
    assert "GLOB_MATCHED" in pos_out, pos_out


def test_selector_negative_scopes_condition_to_negative_document():
    ruleset = {
        "version": 1,
        "rules": [{"when": {"mentions": "sketch", "in": "@negative"}, "add": "NEG_MATCHED"}],
    }
    pos_out, _neg_out, _trace = core.transform("1girl", "sketch, lowres", ruleset, "illustrious")
    assert "NEG_MATCHED" in pos_out, pos_out

    pos_out2, _neg_out2, _trace2 = core.transform("1girl", "lowres", ruleset, "illustrious")
    assert "NEG_MATCHED" not in pos_out2, pos_out2


# ---------------------------------------------------------------------------
# `path`-selector leaf creation (regression: the final segment of a fresh
# "a/b" path used to be created as an empty container wrapping an
# unlabelled "" leaf; it must be a LEAF labelled with that segment).
# ---------------------------------------------------------------------------

def test_path_selector_creates_final_segment_as_labelled_leaf():
    ruleset = {
        "version": 1,
        "rules": [{"add": {"value": "black jacket", "into": "character:celica/clothes"}}],
    }
    pos_out, _neg_out, _trace = core.transform("[character:celica]\naction: standing", "", ruleset, "anima")
    assert "clothes: black jacket" in pos_out, pos_out


# ---------------------------------------------------------------------------
# Nested `group` inside a `switch`
# ---------------------------------------------------------------------------

def test_nested_group_inside_switch_branch():
    ruleset = {
        "version": 1,
        "rules": [
            {
                "type": "switch",
                "children": [
                    {
                        "when": {"mentions": "day"},
                        "type": "group",
                        "children": [{"add": "sunny sky"}, {"add": "warm light"}],
                    },
                    {"default": True, "add": "night sky"},
                ],
            }
        ],
    }
    pos_out, _neg_out, _trace = core.transform("1girl, day", "", ruleset, "illustrious")
    assert "sunny sky" in pos_out, pos_out
    assert "warm light" in pos_out, pos_out
    assert "night sky" not in pos_out, pos_out

    pos_out2, _neg_out2, _trace2 = core.transform("1girl, night", "", ruleset, "illustrious")
    assert "night sky" in pos_out2, pos_out2
    assert "sunny sky" not in pos_out2, pos_out2


# ---------------------------------------------------------------------------
# Dedup weight upgrade
# ---------------------------------------------------------------------------

def test_dedup_add_upgrades_weight_without_duplicating():
    ruleset = {
        "version": 1,
        "rules": [
            {"name": "base", "add": "masterpiece"},
            {"name": "upgrade", "add": {"value": "masterpiece", "weight": 1.3}},
        ],
    }
    pos_out, _neg_out, _trace = core.transform("1girl", "", ruleset, "illustrious")

    assert pos_out.count("masterpiece") == 1, pos_out
    assert "(masterpiece:1.3)" in pos_out, pos_out


# ---------------------------------------------------------------------------
# Empty ruleset
# ---------------------------------------------------------------------------

def test_empty_ruleset_is_noop():
    ruleset = {"version": 1, "rules": []}
    result = core.validate(ruleset)
    assert result["ok"] is True, result["errors"]

    pos_out, neg_out, trace = core.transform("1girl, smile", "sketch", ruleset, "illustrious")
    assert pos_out == "1girl, smile", pos_out
    assert neg_out == "sketch", neg_out
    assert trace == []


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def test_validation_unknown_rule_type_raises_path_precise_error():
    bad = {"version": 1, "rules": [{"name": "celica", "type": "bogus", "add": "x"}]}
    try:
        core.parse_ruleset(bad, source="celica.yaml")
        raised = False
        message = ""
    except core.RulesetError as exc:
        raised = True
        message = str(exc)

    assert raised, "expected an invalid rule type to raise RulesetError"
    assert "celica.yaml" in message, message
    assert "rules[0]" in message, message
    assert ".type" in message, message
    assert "bogus" in message, message
    assert "not supported" in message, message


def test_validation_group_missing_children_raises_path_precise_error():
    bad = {"version": 1, "rules": [{"type": "group"}]}
    try:
        core.parse_ruleset(bad, source="celica.yaml")
        raised = False
        message = ""
    except core.RulesetError as exc:
        raised = True
        message = str(exc)

    assert raised, "expected a group rule missing 'children' to raise RulesetError"
    assert "rules[0]" in message, message
    assert "children" in message, message


def test_validate_returns_ok_dict_for_valid_ruleset():
    ruleset = load_yaml("celica.booru.yaml")
    result = core.validate(ruleset, source="celica.booru.yaml")
    assert result["ok"] is True, result["errors"]
    assert result["errors"] == []


def test_validation_switch_default_with_condition_raises():
    bad = {
        "version": 1,
        "rules": [
            {
                "type": "switch",
                "children": [
                    {"any_of": "a", "add": "x"},
                    {"default": True, "any_of": "b", "add": "y"},
                ],
            }
        ],
    }
    result = core.validate(bad, source="bad.yaml")
    assert result["ok"] is False
    assert any("default" in e and "cannot contain conditions" in e for e in result["errors"]), result["errors"]


def test_validation_condition_mentions_and_matches_conflict_raises():
    bad = {"version": 1, "rules": [{"when": {"mentions": "a", "matches": "b.*"}, "add": "x"}]}
    result = core.validate(bad, source="bad.yaml")
    assert result["ok"] is False
    assert any("mentions" in e and "matches" in e for e in result["errors"]), result["errors"]


def test_validation_mutation_after_and_before_conflict_raises():
    bad = {"version": 1, "rules": [{"add": {"value": "x", "after": "a", "before": "b"}}]}
    result = core.validate(bad, source="bad.yaml")
    assert result["ok"] is False
    assert any("after" in e and "before" in e for e in result["errors"]), result["errors"]


def test_validation_invalid_regex_raises():
    bad = {"version": 1, "rules": [{"when": {"matches": "([a-z"}, "add": "x"}]}
    result = core.validate(bad, source="bad.yaml")
    assert result["ok"] is False
    assert any(".matches" in e for e in result["errors"]), result["errors"]


# ---------------------------------------------------------------------------
# Trace print (for eyeballing, per the build brief)
# ---------------------------------------------------------------------------

def print_full_trace_for_eyeballing():
    ruleset = load_yaml("celica.booru.yaml")
    _pos_out, _neg_out, trace = core.transform("1girl, celica, jacket, smile", "sketch", ruleset, "illustrious")
    print("\n--- full trace (celica.booru.yaml, 'jacket' branch) ---")
    print(core.format_trace(trace))
    print("--- end trace ---\n")


ALL_TESTS = [
    test_booru_jacket_branch,
    test_booru_shirt_branch,
    test_booru_default_branch,
    test_booru_none_of_gate_blocks_blue_eyes,
    test_booru_dedup_on_repeated_apply,
    test_anima_sections_and_negative,
    test_anima_none_of_gate_blocks_blue_eyes,
    test_group_negative_ops_do_not_inherit_positive_into,
    test_celica_sheet_negative_render_never_leaks_container_label,
    test_remove_negative_explicit_from_still_works,
    test_negative_mutation_explicit_into_is_honored,
    test_negative_stays_single_flat_leaf_in_common_case,
    test_positive_side_into_inheritance_is_unchanged,
    test_anima_leaf_with_trailing_content_parses_as_labelled_leaf,
    test_anima_bare_leaf_bracket_yields_empty_items,
    test_anima_global_leaf_with_trailing_content_parses_as_labelled_leaf,
    test_anima_unrecognized_line_still_falls_back_to_unlabelled_leaf,
    test_anima_rendered_output_never_contains_literal_bracket_markers,
    test_block_order_reorders_top_level_children_quality_character_global,
    test_block_order_multiple_character_containers_keep_relative_order,
    test_block_order_unrecognized_label_goes_last_and_keeps_relative_order,
    test_block_order_does_not_mutate_document,
    test_block_order_nested_sections_inside_character_are_not_reordered,
    test_block_order_empty_profiles_are_provable_no_ops,
    test_swap_rule_expands_placeholder_and_removes_it,
    test_swap_rule_is_noop_when_placeholder_absent,
    test_matches_condition_regex_gates_add,
    test_condition_scope_option_scopes_bare_mentions,
    test_selector_by_id_scopes_condition,
    test_selector_glob_scopes_condition_to_matching_containers,
    test_selector_negative_scopes_condition_to_negative_document,
    test_path_selector_creates_final_segment_as_labelled_leaf,
    test_nested_group_inside_switch_branch,
    test_dedup_add_upgrades_weight_without_duplicating,
    test_empty_ruleset_is_noop,
    test_validation_unknown_rule_type_raises_path_precise_error,
    test_validation_group_missing_children_raises_path_precise_error,
    test_validate_returns_ok_dict_for_valid_ruleset,
    test_validation_switch_default_with_condition_raises,
    test_validation_condition_mentions_and_matches_conflict_raises,
    test_validation_mutation_after_and_before_conflict_raises,
    test_validation_invalid_regex_raises,
]


if __name__ == "__main__":
    print_full_trace_for_eyeballing()

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
