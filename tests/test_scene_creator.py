"""Plain-script tests for the Scene Creator node's pure logic.

Run directly: `python tests/test_scene_creator.py` (no pytest, per project convention).
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json

from nodes._scene_creator_helpers import (
    assemble_background_block,
    assemble_characters,
    build_scene_data,
    build_scene_text,
    flatten_characters_block,
    parse_scene_state,
    render_character_paragraph,
)
from nodes.node_scene_creator import SceneCreator


def test_parse_scene_state_valid():
    raw = json.dumps(
        {
            "version": 1,
            "fields": {"place": "a rooftop", "lighting": "sunset"},
            "characters": [
                {
                    "socket": "char_1",
                    "name": "Yuna",
                    "enabled": True,
                    "appearance": "long black hair",
                    "outfits": [{"socket": "", "text": "armor", "enabled": True}],
                    "action": "smiling",
                    "focus": "eyes",
                },
            ],
            "backgrounds": [],
        }
    )
    fields, characters, backgrounds = parse_scene_state(raw)
    assert fields == {"place": "a rooftop", "lighting": "sunset"}
    assert characters == [
        {
            "socket": "char_1",
            "name": "Yuna",
            "enabled": True,
            "appearance": "long black hair",
            "outfits": [{"socket": "", "text": "armor", "enabled": True}],
            "action": "smiling",
            "focus": "eyes",
        }
    ]
    assert backgrounds == []


def test_parse_scene_state_guarded_against_garbage():
    assert parse_scene_state("not json") == ({}, [], [])
    assert parse_scene_state("[]") == ({}, [], [])
    assert parse_scene_state(
        json.dumps({"fields": "nope", "characters": "nope", "backgrounds": "nope"})
    ) == ({}, [], [])
    assert parse_scene_state(json.dumps({})) == ({}, [], [])


def test_parse_scene_state_legacy_scalar_outfit_normalized():
    raw = json.dumps(
        {
            "version": 1,
            "fields": {},
            "characters": [
                {
                    "socket": "char_1",
                    "enabled": True,
                    "outfit": "leather jacket",
                    "expression": "determined",
                },
                {
                    "socket": "char_2",
                    "enabled": True,
                    "outfit": "cloak",
                    "outfit_socket": "char_2_outfit",
                    "expression": "stoic",
                },
                {
                    "socket": "char_3",
                    "enabled": True,
                    "expression": "no outfit data at all",
                },
            ],
        }
    )
    _, characters, backgrounds = parse_scene_state(raw)
    assert backgrounds == []
    assert characters[0]["outfits"] == [
        {"socket": "", "text": "leather jacket", "enabled": True}
    ]
    assert characters[0]["action"] == "determined"
    assert "expression" not in characters[0]
    assert characters[1]["outfits"] == [
        {"socket": "char_2_outfit", "text": "cloak", "enabled": True}
    ]
    assert characters[1]["action"] == "stoic"
    assert "expression" not in characters[1]
    assert characters[2]["outfits"] == []
    assert characters[2]["action"] == "no outfit data at all"
    assert "expression" not in characters[2]


def test_parse_scene_state_expression_migrates_to_action_when_action_missing():
    raw = json.dumps(
        {
            "version": 1,
            "characters": [{"socket": "char_1", "enabled": True, "expression": "smirking"}],
        }
    )
    _, characters, _ = parse_scene_state(raw)
    assert characters[0]["action"] == "smirking"
    assert "expression" not in characters[0]


def test_parse_scene_state_expression_dropped_when_action_already_present():
    raw = json.dumps(
        {
            "version": 1,
            "characters": [
                {"socket": "char_1", "enabled": True, "expression": "OLD", "action": "NEW"}
            ],
        }
    )
    _, characters, _ = parse_scene_state(raw)
    assert characters[0]["action"] == "NEW"
    assert "expression" not in characters[0]


def test_parse_scene_state_missing_backgrounds_key_defaults_empty():
    raw = json.dumps({"version": 1, "fields": {"place": "x"}, "characters": []})
    fields, characters, backgrounds = parse_scene_state(raw)
    assert fields == {"place": "x"}
    assert characters == []
    assert backgrounds == []


def test_parse_scene_state_migrates_legacy_composition_camera_lighting_fields():
    # Best-effort migration: an OLDER state's composition/camera/lighting
    # scene fields map onto the new scene_description/shot pair. The legacy
    # keys themselves are left in place (harmless if unreferenced).
    raw = json.dumps(
        {
            "version": 1,
            "fields": {
                "composition": "rule of thirds",
                "camera": "medium shot",
                "lighting": "warm glow",
            },
            "characters": [],
        }
    )
    fields, _, _ = parse_scene_state(raw)
    assert fields["scene_description"] == "rule of thirds"
    assert fields["shot"] == "medium shot, warm glow"
    assert fields["composition"] == "rule of thirds"
    assert fields["camera"] == "medium shot"
    assert fields["lighting"] == "warm glow"


def test_parse_scene_state_migration_does_not_overwrite_existing_new_keys():
    raw = json.dumps(
        {
            "version": 1,
            "fields": {
                "composition": "old",
                "scene_description": "already set",
                "camera": "x",
                "shot": "already set too",
            },
            "characters": [],
        }
    )
    fields, _, _ = parse_scene_state(raw)
    assert fields["scene_description"] == "already set"
    assert fields["shot"] == "already set too"


def test_parse_scene_state_migration_is_a_noop_without_legacy_keys():
    raw = json.dumps({"version": 1, "fields": {"place": "x"}, "characters": []})
    fields, _, _ = parse_scene_state(raw)
    assert "scene_description" not in fields
    assert "shot" not in fields


def test_assemble_characters_two_enabled_one_disabled():
    characters = [
        {
            "socket": "char_1",
            "name": "Rex",
            "enabled": True,
            "outfits": [{"socket": "", "text": "leather jacket", "enabled": True}],
            "action": "determined",
        },
        {
            "socket": "char_2",
            "name": "SKIP",
            "enabled": False,
            "outfits": [{"socket": "", "text": "should be skipped", "enabled": True}],
            "action": "should be skipped",
        },
        {
            "socket": "char_3",
            "name": "Mira",
            "enabled": True,
            "outfits": [{"socket": "", "text": "school uniform", "enabled": True}],
            "action": "shy smile",
            "focus": "hands",
        },
    ]
    kwargs = {
        "char_1": {
            "template": "{character}",
            "fields": {"character": "Aria"},
            "prompt": "1girl, red hair, solo",
            "name": "prompt",
        },
        "char_2": "IGNORED PLAIN STRING",
        "char_3": "1boy, blue eyes",
    }
    result = assemble_characters(characters, kwargs)
    assert result == [
        {
            "name": "Rex",
            "appearance": "1girl, red hair, solo",
            "clothes": "leather jacket",
            "action": "determined",
        },
        {
            "name": "Mira",
            "appearance": "1boy, blue eyes",
            "clothes": "school uniform",
            "action": "shy smile",
            "focus": "hands",
        },
    ]


def test_assemble_characters_missing_socket_uses_appearance_field():
    characters = [
        {
            "socket": "char_1",
            "enabled": True,
            "appearance": "tall, scarred",
            "outfits": [{"socket": "", "text": "cloak", "enabled": True}],
            "action": "stoic",
        },
    ]
    # char_1 never wired -> not present in kwargs at all.
    result = assemble_characters(characters, {})
    assert result == [
        {"name": "", "appearance": "tall, scarred", "clothes": "cloak", "action": "stoic"}
    ]


def test_assemble_characters_all_blank_and_no_name_dropped():
    characters = [
        {
            "socket": "char_1",
            "enabled": True,
            "outfits": [{"socket": "", "text": "", "enabled": True}],
            "action": "  ",
        },
    ]
    assert assemble_characters(characters, {}) == []


def test_assemble_characters_name_only_kept():
    characters = [
        {"socket": "char_1", "name": "Nameless Cameo", "enabled": True},
    ]
    result = assemble_characters(characters, {})
    assert result == [{"name": "Nameless Cameo"}]


def test_assemble_characters_none_socket_value():
    characters = [
        {
            "socket": "char_1",
            "enabled": True,
            "outfits": [{"socket": "", "text": "armor", "enabled": True}],
            "action": "calm",
        },
    ]
    result = assemble_characters(characters, {"char_1": None})
    assert result == [{"name": "", "clothes": "armor", "action": "calm"}]


def test_assemble_characters_no_characters():
    assert assemble_characters([], {}) == []


def test_assemble_characters_multiple_outfits_wire_and_text_in_order():
    characters = [
        {
            "socket": "char_1",
            "enabled": True,
            "action": "confident",
            "outfits": [
                {"socket": "char_1_outfit_1", "text": "fallback text 1", "enabled": True},
                {"socket": "char_1_outfit_2", "text": "jacket", "enabled": True},
            ],
        },
    ]
    kwargs = {
        "char_1": "1girl, solo",
        "char_1_outfit_1": "black dress",
    }
    result = assemble_characters(characters, kwargs)
    assert result == [
        {
            "name": "",
            "appearance": "1girl, solo",
            "clothes": "black dress, jacket",
            "action": "confident",
        }
    ]


def test_assemble_characters_disabled_outfit_entry_skipped():
    characters = [
        {
            "socket": "char_1",
            "enabled": True,
            "outfits": [
                {"socket": "char_1_outfit_1", "text": "black dress", "enabled": True},
                {"socket": "char_1_outfit_2", "text": "SKIP ME", "enabled": False},
            ],
        },
    ]
    result = assemble_characters(characters, {})
    assert result == [{"name": "", "clothes": "black dress"}]
    assert "SKIP ME" not in json.dumps(result)


def test_assemble_background_block_two_enabled_one_disabled_with_text():
    backgrounds = [
        {"socket": "bg_1", "enabled": True, "text": "golden hour"},
        {"socket": "bg_2", "enabled": False, "text": "should be skipped"},
        {"socket": "bg_3", "enabled": True, "text": ""},
    ]
    kwargs = {
        "bg_1": {
            "template": "{place}",
            "fields": {"place": "rooftop"},
            "prompt": "rooftop skyline, dusk",
            "name": "prompt",
        },
        "bg_2": "SKIP ME",
        "bg_3": "misty forest clearing",
    }
    block = assemble_background_block(backgrounds, kwargs)
    assert block == "rooftop skyline, dusk, golden hour, misty forest clearing"
    assert "should be skipped" not in block
    assert "SKIP ME" not in block


def test_assemble_background_block_no_backgrounds():
    assert assemble_background_block([], {}) == ""


def test_flatten_characters_block_joins_values_in_order():
    characters_list = [
        {"name": "Kael", "appearance": "1boy", "clothes": "coat", "action": "calm", "focus": "eyes"},
        {"name": "", "appearance": "1girl"},
    ]
    assert flatten_characters_block(characters_list) == "Kael, 1boy, coat, calm, eyes, 1girl"


def test_flatten_characters_block_empty_list_yields_empty_string():
    assert flatten_characters_block([]) == ""


def test_render_character_paragraph_full_order_comma_joined_no_trailing_period():
    character = {
        "name": "Yuna",
        "appearance": "woman, 24yo, long black hair, hime cut, purple eyes",
        "clothes": "white blouse, black blazer, pencil skirt",
        "action": "sitting turned in chair, looking up, surprised smile",
        "focus": "sharp focus, facing camera",
    }
    assert render_character_paragraph(character) == (
        "Yuna: woman, 24yo, long black hair, hime cut, purple eyes, "
        "white blouse, black blazer, pencil skirt, "
        "sitting turned in chair, looking up, surprised smile, "
        "sharp focus, facing camera;"
    )


def test_render_character_paragraph_no_name_omits_prefix():
    character = {"appearance": "1girl, solo", "clothes": "wired black dress", "action": "smiling"}
    assert render_character_paragraph(character) == "1girl, solo, wired black dress, smiling;"


def test_render_character_paragraph_does_not_strip_periods_from_pieces():
    # No trailing-period stripping/appending any more — each piece is used
    # verbatim (just stripped of surrounding whitespace) and comma-joined,
    # then the whole paragraph gets its own single trailing ";".
    character = {"appearance": "tall.", "action": "calm.."}
    assert render_character_paragraph(character) == "tall., calm..;"


def test_render_character_paragraph_name_only_no_body():
    # A name-only character (no body at all) yields just the bare name — no
    # trailing ";".
    assert render_character_paragraph({"name": "Nameless Cameo"}) == "Nameless Cameo"


def test_build_scene_text_four_bucket_order_lead_characters_labeled_tail():
    # Section order is ALWAYS lead -> characters -> labeled -> tail,
    # regardless of where each token sits in the template. The bare {tags}
    # lead line has NO trailing ";"; LABELED lines (Background: / any other
    # non-tail token) each end with ";"; TAIL lines (scene_description,
    # shot) are bare, unlabeled, and have NO trailing ";".
    template = "{tags}, {characters}, {backgrounds}, {mood}, {scene_description}, {shot}"
    fields = {
        "tags": "score_7, masterpiece",
        "mood": "tense",
        "scene_description": "office standoff",
        "shot": "medium shot, harsh light",
    }
    characters_list = [{"name": "Yuna", "appearance": "long black hair"}]
    background_block = "cafe interior"
    result = build_scene_text(template, fields, characters_list, background_block)
    assert result == (
        "score_7, masterpiece\n\n"
        "Yuna: long black hair;\n\n"
        "Background: cafe interior;\n"
        "Mood: tense;\n\n"
        "office standoff\n"
        "medium shot, harsh light"
    )


def test_build_scene_text_tail_tokens_preserve_template_order_and_are_unlabeled():
    # `shot` before `scene_description` in the template -> tail lines follow
    # that order too (bare values, no label, no ";").
    result = build_scene_text(
        "{shot}, {scene_description}",
        {"shot": "medium shot", "scene_description": "quiet office"},
        [],
        "",
    )
    assert result == "medium shot\nquiet office"
    assert ":" not in result
    assert ";" not in result


def test_build_scene_text_empty_characters_and_background_omitted():
    result = build_scene_text("{characters}, {backgrounds}, {lighting}", {"lighting": "sunset"}, [], "")
    assert result == "Lighting: sunset;"
    assert "Background" not in result


def test_build_scene_text_no_json_syntax_and_preserves_unicode():
    result = build_scene_text(
        "{tags}, {lighting}", {"tags": "score_7", "lighting": "café glow"}, [], ""
    )
    assert result == "score_7\n\nLighting: café glow;"
    assert "café glow" in result
    assert "{" not in result and "}" not in result and '"' not in result


def test_build_scene_text_all_empty_yields_empty_string():
    assert (
        build_scene_text(
            "{tags}, {characters}, {backgrounds}, {scene_description}, {shot}", {}, [], ""
        )
        == ""
    )


def test_scene_data_shape():
    values = {"place": "rooftop", "characters": "1girl, solo", "backgrounds": ""}
    structured_str = build_scene_text("{place}, {characters}", {"place": "rooftop"}, [], "")
    data = build_scene_data("{place}, {characters}", values, "rooftop, 1girl, solo", structured_str)
    assert set(data.keys()) == {"template", "fields", "prompt", "structured", "name"}
    assert data["template"] == "{place}, {characters}"
    assert data["fields"] == values
    assert data["prompt"] == "rooftop, 1girl, solo"
    assert data["structured"] == structured_str
    assert data["name"] == "scene"


def test_node_input_types_contract():
    schema = SceneCreator.INPUT_TYPES()
    assert schema["required"]["template"][0] == "STRING"
    assert (
        schema["required"]["template"][1]["default"]
        == "{tags}, {characters}, {backgrounds}, {scene_description}, {shot}"
    )
    assert schema["required"]["scene_state"][0] == "STRING"
    assert schema["required"]["scene_state"][1]["default"] == "{}"
    optional = schema["optional"]
    assert "char_1" in optional
    assert "bg_1" in optional
    assert "anything_at_all" in optional
    assert "hidden" not in schema
    assert SceneCreator.CATEGORY == "AnimaFlow/scene"
    assert SceneCreator.FUNCTION == "build"
    assert SceneCreator.RETURN_TYPES == ("STRING", "PROMPT_DATA")
    assert SceneCreator.RETURN_NAMES == ("scene", "data")
    assert SceneCreator.RESERVED_CHARACTERS_TOKEN == "characters"
    assert SceneCreator.RESERVED_BACKGROUNDS_TOKEN == "backgrounds"
    assert not hasattr(SceneCreator, "OUTPUT_NODE")


def test_build_full_scene_with_wired_characters():
    node = SceneCreator()
    template = "{place}, {characters}, {lighting}, {camera}, {action}, {props}"
    scene_state = json.dumps(
        {
            "version": 1,
            "fields": {
                "place": "a neon-lit alley",
                "lighting": "cool blue rim light",
                "camera": "low angle",
                "action": "standing back to back",
                "props": "",
            },
            "characters": [
                {
                    "socket": "char_1",
                    "name": "Kael",
                    "enabled": True,
                    "outfits": [{"socket": "", "text": "trench coat", "enabled": True}],
                    "action": "narrowed eyes",
                    "focus": "face close-up",
                },
                {
                    "socket": "char_2",
                    "name": "SKIP ME",
                    "enabled": False,
                    "outfits": [{"socket": "", "text": "SKIP ME", "enabled": True}],
                    "action": "SKIP ME",
                },
                {
                    "socket": "char_3",
                    "name": "Mira",
                    "enabled": True,
                    "outfits": [{"socket": "", "text": "school uniform", "enabled": True}],
                    "action": "nervous smile",
                },
            ],
            "backgrounds": [],
        }
    )
    char_1_prompt_data = {
        "template": "{character}",
        "fields": {"character": "Kael"},
        "prompt": "1boy, silver hair, tall",
        "name": "prompt",
    }
    output = node.build(
        template,
        scene_state=scene_state,
        char_1=char_1_prompt_data,
        char_3="1girl, twin tails",
    )

    structured_str, data = output["result"]
    assert output["ui"]["text"] == [structured_str]
    assert output["ui"]["slots"] == {
        "char_1": "1boy, silver hair, tall",
        "char_3": "1girl, twin tails",
    }

    assert structured_str == (
        "Kael: 1boy, silver hair, tall, trench coat, narrowed eyes, face close-up;\n\n"
        "Mira: 1girl, twin tails, school uniform, nervous smile;\n\n"
        "Place: a neon-lit alley;\n"
        "Lighting: cool blue rim light;\n"
        "Camera: low angle;\n"
        "Action: standing back to back;"
    )
    assert "Props" not in structured_str
    assert "SKIP ME" not in structured_str

    # `.prompt` on PROMPT_DATA stays the flat, back-compat string.
    assert data["structured"] == structured_str
    assert data["name"] == "scene"
    assert data["template"] == template
    assert "a neon-lit alley" in data["prompt"]
    assert "cool blue rim light" in data["prompt"]
    assert "low angle" in data["prompt"]
    assert "standing back to back" in data["prompt"]
    assert "SKIP ME" not in data["prompt"]
    assert (
        "Kael, 1boy, silver hair, tall, trench coat, narrowed eyes, face close-up, "
        "Mira, 1girl, twin tails, school uniform, nervous smile" in data["prompt"]
    )
    # blank "props" field drops cleanly, no dangling commas.
    assert not data["prompt"].startswith(",")
    assert not data["prompt"].endswith(",")
    assert ",," not in data["prompt"]
    assert ", ," not in data["prompt"]


def test_build_no_characters_state_yields_empty_characters_token():
    node = SceneCreator()
    template = "{place}, {characters}, {lighting}"
    scene_state = json.dumps(
        {"version": 1, "fields": {"place": "a rooftop", "lighting": "sunset"}, "characters": []}
    )
    output = node.build(template, scene_state=scene_state)
    structured_str, data = output["result"]
    assert data["prompt"] == "a rooftop, sunset", data["prompt"]
    assert output["ui"]["text"] == [structured_str]
    assert data["fields"]["characters"] == ""
    assert structured_str == "Place: a rooftop;\nLighting: sunset;"
    assert "characters" not in structured_str.lower()


def test_build_default_scene_state_all_blank():
    node = SceneCreator()
    template = "{place}, {characters}, {lighting}, {camera}, {action}, {props}"
    output = node.build(template)
    structured_str, data = output["result"]
    assert data["prompt"] == "", data["prompt"]
    assert structured_str == "", structured_str
    assert output["ui"]["text"] == [structured_str]


def test_build_backgrounds_token_filled_from_wired_and_disabled_backgrounds():
    node = SceneCreator()
    template = "{backgrounds}, {characters}, {lighting}"
    scene_state = json.dumps(
        {
            "version": 1,
            "fields": {"lighting": "sunset"},
            "characters": [],
            "backgrounds": [
                {"socket": "bg_1", "enabled": True, "text": "golden hour"},
                {"socket": "bg_2", "enabled": False, "text": "SKIP ME"},
            ],
        }
    )
    bg_1_prompt_data = {
        "template": "{place}",
        "fields": {"place": "rooftop"},
        "prompt": "rooftop skyline, dusk",
        "name": "prompt",
    }
    output = node.build(template, scene_state=scene_state, bg_1=bg_1_prompt_data)
    structured_str, data = output["result"]
    assert data["prompt"] == "rooftop skyline, dusk, golden hour, sunset", data["prompt"]
    assert "SKIP ME" not in data["prompt"]
    assert data["fields"]["backgrounds"] == "rooftop skyline, dusk, golden hour"
    assert structured_str == "Background: rooftop skyline, dusk, golden hour;\nLighting: sunset;"


def test_build_outfit_wire_overrides_text():
    node = SceneCreator()
    template = "{characters}"
    scene_state = json.dumps(
        {
            "version": 1,
            "fields": {},
            "characters": [
                {
                    "socket": "char_1",
                    "enabled": True,
                    "action": "smiling",
                    "outfits": [
                        {
                            "socket": "char_1_outfit_1",
                            "text": "should be overridden",
                            "enabled": True,
                        }
                    ],
                },
            ],
        }
    )
    output = node.build(
        template,
        scene_state=scene_state,
        char_1="1girl, solo",
        char_1_outfit_1="wired black dress",
    )
    structured_str, data = output["result"]
    assert data["prompt"] == "1girl, solo, wired black dress, smiling", data["prompt"]
    assert "should be overridden" not in data["prompt"]
    assert structured_str == "1girl, solo, wired black dress, smiling;"
    assert output["ui"]["slots"] == {
        "char_1": "1girl, solo",
        "char_1_outfit_1": "wired black dress",
    }


def test_build_outfit_falls_back_to_text_when_wire_empty():
    node = SceneCreator()
    template = "{characters}"
    scene_state = json.dumps(
        {
            "version": 1,
            "fields": {},
            "characters": [
                {
                    "socket": "char_1",
                    "enabled": True,
                    "action": "calm",
                    "outfits": [
                        {"socket": "char_1_outfit_1", "text": "plain robe", "enabled": True}
                    ],
                },
            ],
        }
    )
    # outfit socket left unwired entirely.
    output = node.build(template, scene_state=scene_state, char_1="1boy, solo")
    structured_str, data = output["result"]
    assert data["prompt"] == "1boy, solo, plain robe, calm", data["prompt"]
    assert structured_str == "1boy, solo, plain robe, calm;"


def test_build_ui_slots_echo_every_wired_socket_unwrapped():
    node = SceneCreator()
    template = "{characters}, {backgrounds}"
    scene_state = json.dumps(
        {
            "version": 1,
            "fields": {},
            "characters": [
                {
                    "socket": "char_1",
                    "enabled": True,
                    "action": "",
                    "outfits": [
                        {"socket": "char_1_outfit_1", "text": "", "enabled": True}
                    ],
                },
            ],
            "backgrounds": [
                {"socket": "bg_1", "enabled": True, "text": ""},
            ],
        }
    )
    char_1_prompt_data = {
        "template": "{character}",
        "fields": {"character": "Kael"},
        "prompt": "1boy, silver hair",
        "name": "prompt",
    }
    output = node.build(
        template,
        scene_state=scene_state,
        char_1=char_1_prompt_data,
        char_1_outfit_1="trench coat",
        bg_1=None,
    )
    assert output["ui"]["slots"] == {
        "char_1": "1boy, silver hair",
        "char_1_outfit_1": "trench coat",
        "bg_1": "",
    }


def test_build_no_wired_sockets_yields_empty_slots():
    node = SceneCreator()
    template = "{place}"
    scene_state = json.dumps({"version": 1, "fields": {"place": "x"}, "characters": []})
    output = node.build(template, scene_state=scene_state)
    assert output["ui"]["slots"] == {}


def test_build_backward_compat_no_backgrounds_key_no_outfit_socket():
    node = SceneCreator()
    template = "{place}, {characters}, {lighting}"
    # Old-shape state: no "backgrounds" key at all, and a character using
    # the legacy scalar "outfit" field plus the legacy "expression" field
    # (no "outfit_socket", no "action").
    scene_state = json.dumps(
        {
            "version": 1,
            "fields": {"place": "a rooftop", "lighting": "sunset"},
            "characters": [
                {
                    "socket": "char_1",
                    "enabled": True,
                    "outfit": "armor",
                    "expression": "determined",
                },
            ],
        }
    )
    output = node.build(template, scene_state=scene_state, char_1="1girl, solo")
    structured_str, data = output["result"]
    assert data["prompt"] == "a rooftop, 1girl, solo, armor, determined, sunset", data["prompt"]
    assert data["fields"]["backgrounds"] == ""
    assert structured_str == "1girl, solo, armor, determined;\n\nPlace: a rooftop;\nLighting: sunset;"


ALL_TESTS = [
    test_parse_scene_state_valid,
    test_parse_scene_state_guarded_against_garbage,
    test_parse_scene_state_legacy_scalar_outfit_normalized,
    test_parse_scene_state_expression_migrates_to_action_when_action_missing,
    test_parse_scene_state_expression_dropped_when_action_already_present,
    test_parse_scene_state_missing_backgrounds_key_defaults_empty,
    test_parse_scene_state_migrates_legacy_composition_camera_lighting_fields,
    test_parse_scene_state_migration_does_not_overwrite_existing_new_keys,
    test_parse_scene_state_migration_is_a_noop_without_legacy_keys,
    test_assemble_characters_two_enabled_one_disabled,
    test_assemble_characters_missing_socket_uses_appearance_field,
    test_assemble_characters_all_blank_and_no_name_dropped,
    test_assemble_characters_name_only_kept,
    test_assemble_characters_none_socket_value,
    test_assemble_characters_no_characters,
    test_assemble_characters_multiple_outfits_wire_and_text_in_order,
    test_assemble_characters_disabled_outfit_entry_skipped,
    test_assemble_background_block_two_enabled_one_disabled_with_text,
    test_assemble_background_block_no_backgrounds,
    test_flatten_characters_block_joins_values_in_order,
    test_flatten_characters_block_empty_list_yields_empty_string,
    test_render_character_paragraph_full_order_comma_joined_no_trailing_period,
    test_render_character_paragraph_no_name_omits_prefix,
    test_render_character_paragraph_does_not_strip_periods_from_pieces,
    test_render_character_paragraph_name_only_no_body,
    test_build_scene_text_four_bucket_order_lead_characters_labeled_tail,
    test_build_scene_text_tail_tokens_preserve_template_order_and_are_unlabeled,
    test_build_scene_text_empty_characters_and_background_omitted,
    test_build_scene_text_no_json_syntax_and_preserves_unicode,
    test_build_scene_text_all_empty_yields_empty_string,
    test_scene_data_shape,
    test_node_input_types_contract,
    test_build_full_scene_with_wired_characters,
    test_build_no_characters_state_yields_empty_characters_token,
    test_build_default_scene_state_all_blank,
    test_build_backgrounds_token_filled_from_wired_and_disabled_backgrounds,
    test_build_outfit_wire_overrides_text,
    test_build_outfit_falls_back_to_text_when_wire_empty,
    test_build_ui_slots_echo_every_wired_socket_unwrapped,
    test_build_no_wired_sockets_yields_empty_slots,
    test_build_backward_compat_no_backgrounds_key_no_outfit_socket,
]


if __name__ == "__main__":
    failures = []
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
