"""Plain-script tests for the prompt-rules engine (`src/prompt_rules/core/`).

Run directly: `python tests/test_rules.py` (no pytest, per project convention).

IMPORTANT: the `# Output:` comments in the example YAML files
(`src/prompt_rules/schema/examples/*.yaml`) are ILLUSTRATIVE -- they assume
anchor insertion (inserting a new tag exactly where a removed/matched one
used to be) that v1 does not implement (adds always append at the end of
the target block; see `src/prompt_rules/core/__init__.py`'s
v1-simplifications docstring). These tests assert on SEMANTIC PROPERTIES
(substrings/contains, section contents), not exact rendered strings.
"""
from __future__ import annotations

import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import yaml

from src.prompt_rules import core
from src.prompt_rules.core import profiles as core_profiles
from src.prompt_rules.core.document import find_by_label
from nodes.prompt_rules import _rules_helpers as rh

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXAMPLES_DIR = os.path.join(REPO_ROOT, "src", "prompt_rules", "schema", "examples")
RULES_DIR = os.path.join(REPO_ROOT, "rules")


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
# Container-label headers (BUG fix: `character:*` container boundaries were
# parsed correctly but never rendered -- `_render_container` only used
# `block.label` to pick a separator, so two characters' sections became one
# undifferentiated pool). All assertions here are on FULL rendered strings,
# not substrings -- a substring-only assertion is exactly what let the
# original bug hide.
# ---------------------------------------------------------------------------

TWO_CHARACTER_INPUT = (
    "[quality] masterpiece, best quality\n"
    "[character:celica]\n"
    "appearance: short black hair, blue eyes\n"
    "clothes: black leather jacket\n"
    "action: sitting, holding coffee\n"
    "[character:ren]\n"
    "appearance: long blonde hair, green eyes\n"
    "clothes: white kimono\n"
    "action: standing, arms crossed\n"
    "[global] cafe interior, morning light, wooden table"
)


def test_container_boundary_renders_and_default_is_generic_numbering_in_render_order():
    """The exact two-character-plus-background repro from the bug report,
    with NO sheet opinion applied: default style is the profile's
    `"generic"` -- `character 1:` / `character 2:`, in render order --
    which is enough on its own to tell the two characters' sections apart.
    """
    doc = core.parse(TWO_CHARACTER_INPUT, "anima")
    out = core.render(doc, "anima")

    expected = (
        "quality: masterpiece, best quality\n"
        "character 1:\n"
        "appearance: short black hair, blue eyes\n"
        "clothes: black leather jacket\n"
        "action: sitting, holding coffee\n"
        "character 2:\n"
        "appearance: long blonde hair, green eyes\n"
        "clothes: white kimono\n"
        "action: standing, arms crossed\n"
        "global: cafe interior, morning light, wooden table"
    )
    assert out == expected, out


def test_container_label_name_style_strips_character_prefix():
    doc = core.parse(TWO_CHARACTER_INPUT, "anima")
    for label in ("character:celica", "character:ren"):
        find_by_label(doc.root, label)[0].render["labelStyle"] = "name"
    out = core.render(doc, "anima")

    expected = (
        "quality: masterpiece, best quality\n"
        "character: celica\n"
        "appearance: short black hair, blue eyes\n"
        "clothes: black leather jacket\n"
        "action: sitting, holding coffee\n"
        "character: ren\n"
        "appearance: long blonde hair, green eyes\n"
        "clothes: white kimono\n"
        "action: standing, arms crossed\n"
        "global: cafe interior, morning light, wooden table"
    )
    assert out == expected, out


def test_container_label_none_style_is_byte_identical_to_pre_fix_output():
    """`characterLabel: "none"` reproduces exactly the buggy pre-fix
    output quoted in the bug report (today's behaviour, opted into)."""
    doc = core.parse(TWO_CHARACTER_INPUT, "anima")
    for label in ("character:celica", "character:ren"):
        find_by_label(doc.root, label)[0].render["labelStyle"] = "none"
    out = core.render(doc, "anima")

    pre_fix_buggy_output = (
        "quality: masterpiece, best quality\n"
        "appearance: short black hair, blue eyes\n"
        "clothes: black leather jacket\n"
        "action: sitting, holding coffee\n"
        "appearance: long blonde hair, green eyes\n"
        "clothes: white kimono\n"
        "action: standing, arms crossed\n"
        "global: cafe interior, morning light, wooden table"
    )
    assert out == pre_fix_buggy_output, out


def test_container_label_numbering_follows_render_order_not_authored_order():
    """`[global]`/`[quality]` are authored scrambled around and BETWEEN the
    two characters; `<N>` must still match each character's position in the
    RENDERED (post-`blockOrder`) output, not its raw authored top-level
    index.
    """
    text = (
        "[global] GLOBALMARK\n"
        "[character:ren]\n"
        "action: RENACTION\n"
        "[quality] QUALITYMARK\n"
        "[character:celica]\n"
        "action: CELICAACTION\n"
    )
    doc = core.parse(text, "anima")
    out = core.render(doc, "anima")

    expected = (
        "quality: QUALITYMARK\n"
        "character 1:\n"
        "action: RENACTION\n"
        "character 2:\n"
        "action: CELICAACTION\n"
        "global: GLOBALMARK"
    )
    assert out == expected, out


def test_container_label_mixed_styles_numbers_by_position_not_by_style():
    """character 1 (celica) is `"name"`, character 2 (ren) is left at the
    profile default `"generic"` -- the second character must be
    `character 2:`, NOT `character 1:` (numbering counts POSITION among all
    character containers, independent of each one's own style)."""
    doc = core.parse(TWO_CHARACTER_INPUT, "anima")
    find_by_label(doc.root, "character:celica")[0].render["labelStyle"] = "name"
    out = core.render(doc, "anima")

    assert "character: celica" in out, out
    assert "character 2:" in out, out
    assert "character 1:" not in out, out


def test_stamp_scoped_to_targeted_container_only():
    """A sheet whose only `into` is `character:celica` must stamp ONLY
    that container -- `character:ren` is untouched and falls back to the
    profile default (`"generic"`)."""
    pos_doc = core.parse(TWO_CHARACTER_INPUT, "anima")
    neg_doc = core.parse("", "anima")
    ruleset = {
        "version": 1,
        "options": {"characterLabel": "name"},
        "rules": [{"into": "character:celica", "add": "extra detail"}],
    }
    result = core.apply_ruleset({"positive": pos_doc, "negative": neg_doc}, ruleset, "anima")

    celica = find_by_label(result["positive"].root, "character:celica")[0]
    ren = find_by_label(result["positive"].root, "character:ren")[0]
    assert celica.render.get("labelStyle") == "name", celica.render
    assert "labelStyle" not in ren.render, ren.render

    out = core.render(result["positive"], "anima")
    assert "character: celica" in out, out
    assert "character 2:" in out, out
    assert "character: ren" not in out, out


def test_last_applied_sheet_wins_for_same_container():
    """Two sheets both target `character:celica` with conflicting styles;
    applied sequentially (as `_rules_helpers.apply_rulesets` does), the
    LAST one applied wins."""
    pos_doc = core.parse(TWO_CHARACTER_INPUT, "anima")
    neg_doc = core.parse("", "anima")
    sheet_a = {
        "version": 1,
        "options": {"characterLabel": "name"},
        "rules": [{"into": "character:celica", "add": "a"}],
    }
    sheet_b = {
        "version": 1,
        "options": {"characterLabel": "none"},
        "rules": [{"into": "character:celica", "add": "b"}],
    }

    result_a = core.apply_ruleset({"positive": pos_doc, "negative": neg_doc}, sheet_a, "anima")
    bundle_b = {"positive": result_a["positive"], "negative": result_a["negative"]}
    result_b = core.apply_ruleset(bundle_b, sheet_b, "anima")

    celica = find_by_label(result_b["positive"].root, "character:celica")[0]
    assert celica.render.get("labelStyle") == "none", celica.render

    out = core.render(result_b["positive"], "anima")
    assert "character: celica" not in out, out
    assert "character 1:" not in out.split("\n"), out.split("\n")


def test_root_never_emits_a_header():
    """`doc.root` is a container with an empty label; a single-character
    document must render EXACTLY one header (celica's), never a stray
    leading `character`/`:`-only line for the root itself."""
    text = "[quality] q\n[character:celica]\naction: a\n[global] g"
    doc = core.parse(text, "anima")
    out = core.render(doc, "anima")
    lines = out.split("\n")

    header_lines = [line for line in lines if line.startswith("character") and line.endswith(":")]
    assert header_lines == ["character 1:"], lines
    assert lines[0] == "quality: q", lines
    assert lines[-1] == "global: g", lines


def test_container_label_profiles_without_containers_are_byte_identical():
    """Backward-compat guard: `raw`/`illustrious`/`pony`/`flux`/`wan` never
    create containers, so this feature is a provable no-op for them --
    reuses the exact fixtures from `test_block_order_empty_profiles_are_
    provable_no_ops` (same reasoning: those profiles' renders can never
    change from before this feature existed).
    """
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
        doc = core.parse(text, profile_id)
        actual_render = core.render(doc, profile_id)
        assert actual_render == expected_render, (profile_id, actual_render)


def test_validation_invalid_character_label_raises_path_precise_error():
    bad = {"version": 1, "options": {"characterLabel": "bogus"}, "rules": [{"add": "x"}]}
    result = core.validate(bad, source="bad.yaml")
    assert result["ok"] is False, result
    assert any(
        "options.characterLabel" in e and "bogus" in e for e in result["errors"]
    ), result["errors"]


def test_celica_sheet_end_to_end_with_two_characters_fires_all_rules_no_leak():
    """The REAL `rules/celica.yaml` sheet, via `apply_rulesets(sheets=
    "celica")`, against a document with a SECOND character it doesn't
    target: all five of its rules still fire, "celica" still never leaks
    into item text, and (since the sheet itself sets no `characterLabel`)
    BOTH characters get the profile default -- `"generic"`.
    """
    text = (
        "[quality] masterpiece, best quality\n"
        "[character:celica]\n"
        "appearance:\n"
        "clothes:\n"
        "action:\n"
        "focus: celica, jacket\n"
        "[character:ren]\n"
        "appearance: long blonde hair\n"
        "clothes: white kimono\n"
        "action: standing\n"
        "[global] cafe interior"
    )
    pos_out, neg_out, trace, errors = rh.apply_rulesets(text, "sketch", "anima", sheets="celica")
    assert errors == [], errors

    trace_text = core.format_trace(trace)
    for rule_name in ("remove-activation", "appearance", "eyes", "outfit", "quality-guard"):
        assert f"({rule_name})" in trace_text, trace_text

    assert "celica" not in pos_out.lower(), pos_out
    assert "blurry, low quality, extra fingers" in neg_out, neg_out
    # No `characterLabel` in celica.yaml -> profile default ("generic")
    # applies to both containers, including the one the sheet never
    # targets (`character:ren`).
    assert "character 1:" in pos_out, pos_out
    assert "character 2:" in pos_out, pos_out
    assert "character: celica" not in pos_out, pos_out


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
# Closed key sets (BUG fix: unknown keys on a rule/ruleset/options object used
# to be silently ignored -- a typo'd condition key like `anyof` for `any_of`
# compiled away to nothing, turning a conditional rule into an unconditional
# one with no warning at all). The `Auditor` now rejects any key outside the
# per-rule-type set mirrored from `src/prompt_rules/schema/ruleset.schema.json`, plus the
# ruleset top level and `options`, with a near-miss suggestion.
# ---------------------------------------------------------------------------

def test_unknown_rule_key_anyof_repro_is_rejected_with_path_precise_error():
    """Exact repro from the bug report: 'anyof' (not 'any_of') used to be
    dropped silently, turning a conditional rule unconditional. It must now
    be a validation error whose path points at the RULE (not the ruleset
    root), and `ok` must be False.
    """
    ruleset = {
        "version": 1,
        "profile": "illustrious",
        "rules": [{"name": "t", "anyof": "celica", "add": "BLACK HAIR"}],
    }
    result = core.validate(ruleset, source="repro.yaml")

    assert result["ok"] is False, result
    assert result["errors"], "expected at least one error"
    matches = [e for e in result["errors"] if "anyof" in e]
    assert matches, result["errors"]
    error = matches[0]
    assert "rules[0]" in error, error
    assert "not a supported property" in error, error


def test_near_miss_suggestion_mentions_any_of_for_anyof_typo():
    bad = {"version": 1, "rules": [{"anyof": "celica", "add": "x"}]}
    result = core.validate(bad)
    assert result["ok"] is False
    matches = [e for e in result["errors"] if "anyof" in e]
    assert matches, result["errors"]
    assert "did you mean 'any_of'" in matches[0], matches[0]


def test_unrelated_unknown_key_gets_no_bogus_suggestion():
    bad = {"version": 1, "rules": [{"bogus_key": "x", "add": "y"}]}
    result = core.validate(bad)
    assert result["ok"] is False
    matches = [e for e in result["errors"] if "bogus_key" in e]
    assert matches, result["errors"]
    assert "not a supported property" in matches[0], matches[0]
    assert "did you mean" not in matches[0], matches[0]


def test_unknown_key_rejected_on_each_rule_type():
    cases = {
        "tag": {"name": "t", "unknown_tag_key": True, "add": "x"},
        "group": {"type": "group", "unknown_group_key": True, "children": [{"add": "x"}]},
        "switch": {"type": "switch", "unknown_switch_key": True, "children": [{"default": True, "add": "x"}]},
        "swap": {"type": "swap", "unknown_swap_key": True, "match": "x", "add": "y"},
    }
    for rtype, rule in cases.items():
        bad = {"version": 1, "rules": [rule]}
        result = core.validate(bad)
        assert result["ok"] is False, (rtype, result)
        key = [k for k in rule if k.startswith("unknown_")][0]
        assert any(key in e for e in result["errors"]), (rtype, result["errors"])


def test_group_rule_rejects_add_key():
    """`add` is a tagRule/swapRule property, not groupRule's -- and the
    reference pack rejects it too."""
    bad = {"version": 1, "rules": [{"type": "group", "add": "x", "children": [{"add": "y"}]}]}
    result = core.validate(bad)
    assert result["ok"] is False
    assert any("'add' is not a supported property" in e for e in result["errors"]), result["errors"]


def test_switch_child_default_accepted_but_rejected_elsewhere():
    # Accepted: `default` on a direct child of a `switch`.
    good = {
        "version": 1,
        "rules": [
            {
                "type": "switch",
                "children": [{"any_of": "a", "add": "x"}, {"default": True, "add": "y"}],
            }
        ],
    }
    result_good = core.validate(good)
    assert result_good["ok"] is True, result_good["errors"]

    # Rejected: `default` on a top-level rule (not a switch child at all).
    bad_top = {"version": 1, "rules": [{"default": True, "add": "x"}]}
    result_top = core.validate(bad_top)
    assert result_top["ok"] is False
    assert any("'default' is not a supported property" in e for e in result_top["errors"]), result_top["errors"]

    # Rejected: `default` on a group child (only meaningful under `switch`).
    bad_group_child = {
        "version": 1,
        "rules": [{"type": "group", "children": [{"default": True, "add": "x"}]}],
    }
    result_group_child = core.validate(bad_group_child)
    assert result_group_child["ok"] is False
    assert any(
        "'default' is not a supported property" in e for e in result_group_child["errors"]
    ), result_group_child["errors"]


def test_unknown_top_level_ruleset_key_is_rejected():
    bad = {"version": 1, "rule": [{"add": "x"}]}  # 'rule' instead of 'rules'
    result = core.validate(bad)
    assert result["ok"] is False
    assert any("'rule' is not a supported property" in e for e in result["errors"]), result["errors"]


def test_unknown_options_key_rejected_and_correct_key_still_validates():
    bad = {"version": 1, "options": {"characterLabl": "generic"}, "rules": [{"add": "x"}]}
    result = core.validate(bad)
    assert result["ok"] is False
    assert any(
        "'characterLabl' is not a supported property" in e and "options" in e for e in result["errors"]
    ), result["errors"]

    good = {"version": 1, "options": {"characterLabel": "generic"}, "rules": [{"add": "x"}]}
    result_good = core.validate(good)
    assert result_good["ok"] is True, result_good["errors"]


def test_collect_all_reports_every_distinct_unknown_key_in_one_call():
    bad = {
        "version": 1,
        "options": {"badOption": True},
        "rules": [
            {"name": "a", "anyof": "celica", "add": "x"},
            {"type": "group", "add": "y", "children": [{"bogus_child_key": 1, "add": "z"}]},
        ],
    }
    result = core.validate(bad)
    assert result["ok"] is False

    joined = " | ".join(result["errors"])
    assert "badOption" in joined, joined
    assert "anyof" in joined, joined
    assert "'add' is not a supported property" in joined, joined
    assert "bogus_child_key" in joined, joined
    # four distinct unknown-key complaints, not just the first found.
    assert len(result["errors"]) >= 4, result["errors"]


def test_mutation_object_unknown_key_rejected():
    bad = {"version": 1, "rules": [{"add": {"value": "x", "bogus": "y"}}]}
    result = core.validate(bad)
    assert result["ok"] is False
    assert any("'bogus' is not a supported property" in e for e in result["errors"]), result["errors"]


def test_removal_object_unknown_key_rejected():
    bad = {"version": 1, "rules": [{"remove": {"value": "x", "bogus": "y"}}]}
    result = core.validate(bad)
    assert result["ok"] is False
    assert any("'bogus' is not a supported property" in e for e in result["errors"]), result["errors"]


def test_setop_unknown_key_rejected():
    bad = {"version": 1, "rules": [{"set": {"to": "x", "bogus": "y"}}]}
    result = core.validate(bad)
    assert result["ok"] is False
    assert any("'bogus' is not a supported property" in e for e in result["errors"]), result["errors"]


def test_every_shipped_sheet_validates_cleanly():
    """Every sheet actually shipped with the repo (`rules/*.yaml` plus
    everything under `src/prompt_rules/schema/examples/`) must still validate with zero
    errors under the new closed-key-set checks. Globs the directories so a
    newly added file is covered automatically.
    """
    paths = sorted(glob.glob(os.path.join(RULES_DIR, "*.yaml"))) + sorted(
        glob.glob(os.path.join(EXAMPLES_DIR, "*.yaml"))
    )
    assert paths, "expected at least one shipped ruleset file to check"
    for path in paths:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        result = core.validate(data, source=os.path.basename(path))
        assert result["ok"] is True, (path, result["errors"])
        assert result["errors"] == [], (path, result["errors"])


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
    test_container_boundary_renders_and_default_is_generic_numbering_in_render_order,
    test_container_label_name_style_strips_character_prefix,
    test_container_label_none_style_is_byte_identical_to_pre_fix_output,
    test_container_label_numbering_follows_render_order_not_authored_order,
    test_container_label_mixed_styles_numbers_by_position_not_by_style,
    test_stamp_scoped_to_targeted_container_only,
    test_last_applied_sheet_wins_for_same_container,
    test_root_never_emits_a_header,
    test_container_label_profiles_without_containers_are_byte_identical,
    test_validation_invalid_character_label_raises_path_precise_error,
    test_celica_sheet_end_to_end_with_two_characters_fires_all_rules_no_leak,
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
    test_unknown_rule_key_anyof_repro_is_rejected_with_path_precise_error,
    test_near_miss_suggestion_mentions_any_of_for_anyof_typo,
    test_unrelated_unknown_key_gets_no_bogus_suggestion,
    test_unknown_key_rejected_on_each_rule_type,
    test_group_rule_rejects_add_key,
    test_switch_child_default_accepted_but_rejected_elsewhere,
    test_unknown_top_level_ruleset_key_is_rejected,
    test_unknown_options_key_rejected_and_correct_key_still_validates,
    test_collect_all_reports_every_distinct_unknown_key_in_one_call,
    test_mutation_object_unknown_key_rejected,
    test_removal_object_unknown_key_rejected,
    test_setop_unknown_key_rejected,
    test_every_shipped_sheet_validates_cleanly,
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
