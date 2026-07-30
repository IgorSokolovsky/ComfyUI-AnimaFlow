"""Plain-script tests for the Loader Panel's model loading and cache
(`nodes/controls/_loaders_helpers.py`) -- WITHOUT a live ComfyUI process.

`_loaders_helpers.py` imports `folder_paths` and `nodes` (ComfyUI's OWN
top-level `nodes` module -- not this pack's `nodes/` package) lazily, inside
functions, specifically so they can be stubbed here via `sys.modules` rather
than needing a real ComfyUI install. See the module's own docstring and
`.claude/skills/comfyui-pack-import-structure/SKILL.md`.

Run directly: `python tests/test_controls_loaders.py` (no pytest, per project convention).
"""
from __future__ import annotations

import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import the module under test FIRST (this resolves our own pack's `nodes`
# package via the repo-root sys.path shim above), THEN stub `sys.modules`
# for ComfyUI's `folder_paths`/`nodes` below -- `_loaders_helpers.py`'s own
# lazy imports happen per-call, inside its functions, so they pick up
# whatever is in `sys.modules` at CALL time, not at this module's import
# time. Stubbing before this import would work too, but stubbing after is
# what proves the laziness actually holds.
from nodes.controls import _loaders_helpers as lh
from nodes.controls.loader_panel import AnimaLoaderPanel


class _FakeModel:
    """Stands in for a real MODEL/VAE/CLIP object -- identity matters here
    (cache hit/miss is asserted via `is`, not equality), not content."""

    def __init__(self, tag):
        self.tag = tag

    def __repr__(self):
        return f"_FakeModel({self.tag!r})"


def _install_fake_comfy():
    """Install fake `folder_paths` + `nodes` modules into `sys.modules` and
    return (calls, restore) -- `calls` records every load the fakes see, so
    a test can assert the real loader was (or wasn't) invoked; `restore`
    puts back whatever was there before (nothing, in this repo, but good
    hygiene for a shared test process).
    """
    calls = []

    fake_folder_paths = types.ModuleType("folder_paths")

    def get_filename_list(folder):
        return {
            "diffusion_models": ["unetA.safetensors", "unetB.safetensors"],
            "vae": ["vaeA.safetensors"],
            "text_encoders": ["clipA.safetensors"],
        }.get(folder, [])

    fake_folder_paths.get_filename_list = get_filename_list

    fake_nodes = types.ModuleType("nodes")

    class UNETLoader:
        def load_unet(self, unet_name, weight_dtype):
            calls.append(("unet", unet_name, weight_dtype))
            return (_FakeModel(f"unet:{unet_name}:{weight_dtype}:{len(calls)}"),)

    class VAELoader:
        def load_vae(self, vae_name):
            calls.append(("vae", vae_name))
            return (_FakeModel(f"vae:{vae_name}:{len(calls)}"),)

    class CLIPLoader:
        def load_clip(self, clip_name, type, device):
            calls.append(("clip", clip_name, type, device))
            return (_FakeModel(f"clip:{clip_name}:{type}:{device}:{len(calls)}"),)

    fake_nodes.UNETLoader = UNETLoader
    fake_nodes.VAELoader = VAELoader
    fake_nodes.CLIPLoader = CLIPLoader

    previous = {"folder_paths": sys.modules.get("folder_paths"), "nodes": sys.modules.get("nodes")}
    sys.modules["folder_paths"] = fake_folder_paths
    sys.modules["nodes"] = fake_nodes

    def restore():
        for name, mod in previous.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod

    return calls, restore


# The cache is no longer module-level (`_loaders_helpers.LoaderCache` is
# owned per `AnimaLoaderPanel` instance -- see that module's docstring), so
# every test below that exercises `load_row_model`/`cache_probe` directly
# creates its OWN fresh `{}` and passes it in explicitly, exactly the way
# `loader_panel.py` passes `self._cache`.


# ---------------------------------------------------------------------------
# Name validation
# ---------------------------------------------------------------------------


def test_load_row_model_missing_name_raises_legible_error():
    calls, restore = _install_fake_comfy()
    try:
        row = {"kind": "unet", "value": "does-not-exist.safetensors", "opts": {}}
        try:
            lh.load_row_model(row, {})
            assert False, "expected LoaderRowError"
        except lh.LoaderRowError as exc:
            msg = str(exc)
            assert "does-not-exist.safetensors" in msg, msg
            assert "unet" in msg, msg
            # Names the folder AND lists what IS available -- the "legible
            # error naming the missing file" the spec asks for.
            assert "unetA.safetensors" in msg, msg
        assert calls == [], "loader must not be invoked when validation fails"
    finally:
        restore()


def test_load_row_model_no_value_set_raises_legible_error():
    calls, restore = _install_fake_comfy()
    try:
        for bad_value in (None, "", 42, ["a", "list"]):
            try:
                lh.load_row_model({"kind": "vae", "value": bad_value, "opts": {}}, {})
                assert False, f"expected LoaderRowError for value={bad_value!r}"
            except lh.LoaderRowError:
                pass
        assert calls == []
    finally:
        restore()


def test_load_row_model_valid_name_loads_and_returns_object():
    calls, restore = _install_fake_comfy()
    try:
        obj = lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {}}, {})
        assert isinstance(obj, _FakeModel)
        assert calls == [("unet", "unetA.safetensors", "default")]
    finally:
        restore()


def test_load_row_model_non_dict_or_unrecognized_kind_returns_zero():
    calls, restore = _install_fake_comfy()
    try:
        assert lh.load_row_model(None, {}) == 0
        assert lh.load_row_model("not-a-dict", {}) == 0
        assert lh.load_row_model({"kind": "sampler", "value": "euler"}, {}) == 0
        assert calls == []
    finally:
        restore()


# ---------------------------------------------------------------------------
# Loader dispatch per kind, including their opts (weight_dtype / type+device)
# ---------------------------------------------------------------------------


def test_load_row_model_unet_passes_weight_dtype():
    calls, restore = _install_fake_comfy()
    try:
        lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {"weight_dtype": "fp8_e4m3fn"}}, {})
        assert calls == [("unet", "unetA.safetensors", "fp8_e4m3fn")]
    finally:
        restore()


def test_load_row_model_clip_passes_type_and_device():
    calls, restore = _install_fake_comfy()
    try:
        lh.load_row_model({"kind": "clip", "value": "clipA.safetensors", "opts": {"type": "qwen_image", "device": "cpu"}}, {})
        assert calls == [("clip", "clipA.safetensors", "qwen_image", "cpu")]
    finally:
        restore()


def test_load_row_model_clip_missing_type_key_defaults_to_qwen_image_not_stable_diffusion():
    # A genuinely hand-edited/malformed API payload can omit "type" entirely
    # -- the frontend (js/controls/rows.mjs) always fills it in via
    # normalizeRow/mkRow, so this only fires off that path. Was
    # "stable_diffusion" (the same wrong-for-Anima default Bug 1 fixed on
    # the frontend); must agree with it, not silently diverge.
    calls, restore = _install_fake_comfy()
    try:
        lh.load_row_model({"kind": "clip", "value": "clipA.safetensors", "opts": {}}, {})
        assert calls == [("clip", "clipA.safetensors", "qwen_image", "default")]
    finally:
        restore()


def test_load_row_model_vae_has_no_extra_opts():
    calls, restore = _install_fake_comfy()
    try:
        lh.load_row_model({"kind": "vae", "value": "vaeA.safetensors", "opts": {}}, {})
        assert calls == [("vae", "vaeA.safetensors")]
    finally:
        restore()


# ---------------------------------------------------------------------------
# Cache: hits on an unchanged row, evicts on name/opts change, single entry
# PER KIND (an unrelated kind's load doesn't disturb this kind's cache), and
# instance-scoped (two callers with two different `cache` dicts don't evict
# each other -- the whole point of this move off the module global).
# ---------------------------------------------------------------------------


def test_cache_hits_when_row_is_unchanged():
    calls, restore = _install_fake_comfy()
    try:
        cache = {}
        row = {"kind": "unet", "value": "unetA.safetensors", "opts": {"weight_dtype": "default"}}
        first = lh.load_row_model(row, cache)
        second = lh.load_row_model(row, cache)
        assert first is second, "unchanged row must hit the cache, not reload"
        assert len(calls) == 1, calls
    finally:
        restore()


def test_cache_evicts_on_name_change():
    calls, restore = _install_fake_comfy()
    try:
        cache = {}
        first = lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {}}, cache)
        second = lh.load_row_model({"kind": "unet", "value": "unetB.safetensors", "opts": {}}, cache)
        assert first is not second
        assert len(calls) == 2, calls
        # The old entry is gone -- reloading the ORIGINAL name loads again
        # rather than finding a stale hit, proving eviction (not growth).
        third = lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {}}, cache)
        assert len(calls) == 3, calls
        assert third is not first
    finally:
        restore()


def test_cache_evicts_on_opts_change_same_name():
    calls, restore = _install_fake_comfy()
    try:
        cache = {}
        first = lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {"weight_dtype": "default"}}, cache)
        second = lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {"weight_dtype": "fp8_e4m3fn"}}, cache)
        assert first is not second
        assert len(calls) == 2, calls
    finally:
        restore()


def test_cache_is_single_entry_per_kind_not_shared_across_kinds():
    calls, restore = _install_fake_comfy()
    try:
        cache = {}
        unet_obj = lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {}}, cache)
        vae_obj = lh.load_row_model({"kind": "vae", "value": "vaeA.safetensors", "opts": {}}, cache)
        # Loading the VAE row must not have evicted the UNET row's cache
        # entry -- this is the "residual coupling" mitigation from the
        # design doc: changing an unrelated row still returns the SAME
        # object for a row that didn't change.
        unet_obj_again = lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {}}, cache)
        assert unet_obj_again is unet_obj
        assert len(calls) == 2, calls  # one unet load, one vae load -- no re-load
        assert vae_obj is not unet_obj
    finally:
        restore()


def test_cache_changing_one_kind_does_not_evict_another_kind():
    calls, restore = _install_fake_comfy()
    try:
        cache = {}
        lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {}}, cache)
        lh.load_row_model({"kind": "vae", "value": "vaeA.safetensors", "opts": {}}, cache)
        # Reload the VAE row by NAME change (vae has no extra opts per the
        # §3 table, so an unrelated opts field alone wouldn't change its
        # cache key) -- this still must not touch the unet slot.
        lh.load_row_model({"kind": "vae", "value": "vaeA.safetensors", "opts": {}}, cache)  # cache hit, no reload
        unet_again = lh.load_row_model({"kind": "unet", "value": "unetA.safetensors", "opts": {}}, cache)
        assert len(calls) == 2, calls  # unet load, vae load -- neither reloaded
        assert unet_again.tag.startswith("unet:")
    finally:
        restore()


def test_cache_is_scoped_to_the_dict_passed_in_not_shared_globally():
    # Two INDEPENDENT cache dicts (standing in for two AnimaLoaderPanel
    # instances) loading the SAME row must each load their own object --
    # proof there is no module-level global left for them to collide on.
    calls, restore = _install_fake_comfy()
    try:
        cache_a, cache_b = {}, {}
        row = {"kind": "unet", "value": "unetA.safetensors", "opts": {}}
        obj_a = lh.load_row_model(row, cache_a)
        obj_b = lh.load_row_model(row, cache_b)
        assert obj_a is not obj_b, "separate caches must not share a cached object"
        assert len(calls) == 2, calls
        # Each cache still hits on its OWN second call.
        assert lh.load_row_model(row, cache_a) is obj_a
        assert lh.load_row_model(row, cache_b) is obj_b
        assert len(calls) == 2, calls
    finally:
        restore()


# ---------------------------------------------------------------------------
# referenced_slots -- the pure VRAM-skip scan, no comfy stubs needed at all.
# ---------------------------------------------------------------------------


def _link(source_id, output_index):
    """An API-prompt link value: [source_node_id, output_index]."""
    return [source_id, output_index]


def test_referenced_slots_missing_or_bad_prompt_fails_open():
    for bad_prompt in (None, "not-a-dict", 42, [1, 2, 3]):
        assert lh.referenced_slots(bad_prompt, "7", 8) is None, bad_prompt


def test_referenced_slots_our_id_absent_from_prompt_fails_open():
    # We (unique_id "7") don't appear as a key anywhere in `prompt` -- can't
    # trust a scan for references to an id we can't even locate.
    prompt = {"1": {"class_type": "KSampler", "inputs": {"seed": _link("99", 0)}}}
    assert lh.referenced_slots(prompt, "7", 8) is None


def test_referenced_slots_no_wires_at_all_is_a_real_empty_set():
    # We DO appear in the graph, but nothing points at us -- this is the
    # legitimate "load nothing" case, distinct from "couldn't tell".
    prompt = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": "{}"}},
        "1": {"class_type": "KSampler", "inputs": {"seed": 12345}},  # plain value, not a link
    }
    assert lh.referenced_slots(prompt, "7", 8) == set()


def test_referenced_slots_one_wired_slot():
    prompt = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": "{}"}},
        "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 0), "seed": 12345}},
    }
    assert lh.referenced_slots(prompt, "7", 8) == {1}  # output_index 0 -> slot 1


def test_referenced_slots_multiple_wired_slots_across_nodes():
    prompt = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 0)}},
        "2": {"class_type": "VAEDecode", "inputs": {"vae": _link("7", 1)}},
    }
    assert lh.referenced_slots(prompt, "7", 8) == {1, 2}


def test_referenced_slots_plain_values_are_ignored():
    prompt = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "1": {"class_type": "Note", "inputs": {"text": "hello", "count": 3, "flag": True, "cfg": [1, 2, 3]}},
    }
    assert lh.referenced_slots(prompt, "7", 8) == set()


def test_referenced_slots_link_to_a_different_node_is_ignored():
    prompt = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "9": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "1": {"class_type": "KSampler", "inputs": {"model": _link("9", 0)}},  # points at node 9, not us
    }
    assert lh.referenced_slots(prompt, "7", 8) == set()


def test_referenced_slots_nested_subgraph_ids_match_via_tail():
    # A link's source id and our own unique_id can each carry (or lack) a
    # subgraph prefix depending on where they're read from -- "12:7" and "7"
    # must still be recognised as the same node.
    prompt = {
        "12:7": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "1": {"class_type": "KSampler", "inputs": {"model": _link("12:7", 2)}},
    }
    assert lh.referenced_slots(prompt, "7", 8) == {3}

    prompt2 = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 0)}},
    }
    assert lh.referenced_slots(prompt2, "12:7", 8) == {1}


def test_referenced_slots_link_pointing_at_no_row_is_still_reported():
    # referenced_slots only reports WIRING -- whether a row exists at that
    # slot is a separate concern the node's run() handles (a wired slot with
    # no row is harmless: nothing loads because there's no row, same as any
    # other empty slot).
    prompt = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 5)}},  # slot 6, no row there
    }
    assert lh.referenced_slots(prompt, "7", 8) == {6}


def test_referenced_slots_out_of_range_output_index_is_dropped():
    prompt = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 99)}},  # slot 100, beyond max_rows
    }
    assert lh.referenced_slots(prompt, "7", 8) == set()


def test_referenced_slots_malformed_link_shapes_are_ignored_not_fatal():
    prompt = {
        "7": {"class_type": "AnimaLoaderPanel", "inputs": {}},
        "1": {
            "class_type": "Weird",
            "inputs": {
                "a": ["7"],               # wrong length
                "b": ["7", 0, "extra"],   # wrong length
                "c": ["7", "not-an-int"],  # output_index not an int
                "d": {"7": 0},            # not a list/tuple at all
                "e": None,
            },
        },
    }
    assert lh.referenced_slots(prompt, "7", 8) == set()


# ---------------------------------------------------------------------------
# AnimaLoaderPanel.run() -- the VRAM-skip integration: only wired rows load.
# ---------------------------------------------------------------------------


def _panel_state(rows):
    import json
    return json.dumps({"version": 1, "rows": rows})


def test_run_only_loads_rows_whose_slot_is_wired():
    calls, restore = _install_fake_comfy()
    try:
        state = _panel_state([
            {"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}},
            {"slot": 2, "kind": "vae", "value": "vaeA.safetensors", "opts": {}},
            {"slot": 3, "kind": "clip", "value": "clipA.safetensors", "opts": {}},
        ])
        prompt = {
            "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": state}},
            # Only the unet row's slot (1, i.e. output_index 0) is wired.
            "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 0)}},
        }
        out = AnimaLoaderPanel().run(state, prompt=prompt, unique_id="7")
        assert out[0] != 0, "wired unet row must load"
        assert out[1] == 0, "unwired vae row must NOT load"
        assert out[2] == 0, "unwired clip row must NOT load"
        assert calls == [("unet", "unetA.safetensors", "default")], calls
    finally:
        restore()


def test_run_nothing_wired_loads_nothing():
    calls, restore = _install_fake_comfy()
    try:
        state = _panel_state([
            {"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}},
            {"slot": 2, "kind": "vae", "value": "vaeA.safetensors", "opts": {}},
        ])
        prompt = {
            "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": state}},
            "1": {"class_type": "Note", "inputs": {"text": "unrelated"}},
        }
        out = AnimaLoaderPanel().run(state, prompt=prompt, unique_id="7")
        assert out == tuple([0] * 8)
        assert calls == [], "no row's output is wired -- nothing should load"
    finally:
        restore()


def test_run_missing_prompt_fails_open_and_loads_everything():
    calls, restore = _install_fake_comfy()
    try:
        state = _panel_state([
            {"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}},
            {"slot": 2, "kind": "vae", "value": "vaeA.safetensors", "opts": {}},
        ])
        # No prompt/unique_id at all -- e.g. an older ComfyUI that doesn't
        # populate hidden inputs the way we expect, or a hand-built call.
        out = AnimaLoaderPanel().run(state)
        assert out[0] != 0 and out[1] != 0, "fail-open must load every present row"
        assert len(calls) == 2, calls
    finally:
        restore()


def test_run_garbage_prompt_fails_open_and_loads_everything():
    calls, restore = _install_fake_comfy()
    try:
        state = _panel_state([{"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}}])
        out = AnimaLoaderPanel().run(state, prompt="not-a-dict", unique_id="7")
        assert out[0] != 0
        assert len(calls) == 1
    finally:
        restore()


def test_run_wired_slot_with_no_row_is_harmless():
    calls, restore = _install_fake_comfy()
    try:
        state = _panel_state([{"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}}])
        prompt = {
            "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": state}},
            # Wired to slot 5 (output_index 4), where no row exists.
            "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 4)}},
        }
        out = AnimaLoaderPanel().run(state, prompt=prompt, unique_id="7")
        assert out == tuple([0] * 8), "a wire to an empty slot must not crash or load anything"
        assert calls == []
    finally:
        restore()


# ---------------------------------------------------------------------------
# The whole point of this change: the model cache is per AnimaLoaderPanel
# INSTANCE, not a module-level global. Two panels loading different unets
# must not evict each other; one panel changing its own row still must.
# ---------------------------------------------------------------------------


def test_run_two_panel_instances_with_different_unets_do_not_evict_each_other():
    calls, restore = _install_fake_comfy()
    try:
        state_a = _panel_state([{"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}}])
        state_b = _panel_state([{"slot": 1, "kind": "unet", "value": "unetB.safetensors", "opts": {}}])
        prompt_a = {
            "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": state_a}},
            "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 0)}},
        }
        prompt_b = {
            "8": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": state_b}},
            "1": {"class_type": "KSampler", "inputs": {"model": _link("8", 0)}},
        }
        panel_a = AnimaLoaderPanel()
        panel_b = AnimaLoaderPanel()

        out_a1 = panel_a.run(state_a, prompt=prompt_a, unique_id="7")
        out_b1 = panel_b.run(state_b, prompt=prompt_b, unique_id="8")
        assert len(calls) == 2, calls  # one unetA load (panel A), one unetB load (panel B)

        # Panel A re-runs its OWN unchanged row AFTER panel B has loaded a
        # completely different unet in between -- this must be a cache HIT
        # on panel A's own object, not a reload, and panel B's load must not
        # have evicted it. This is the exact bug this change fixes: with a
        # module-level cache, panel B's load would have overwritten the
        # shared "unet" slot and forced panel A to reload from disk here.
        out_a2 = panel_a.run(state_a, prompt=prompt_a, unique_id="7")
        assert len(calls) == 2, calls  # still 2 -- no reload for panel A
        assert out_a2[0] is out_a1[0], "instance A's cached model must survive instance B's unrelated load"
        assert out_a1[0] is not out_b1[0], "the two instances must hold genuinely different objects"
    finally:
        restore()


def test_run_single_instance_changing_its_own_row_name_misses_cache_and_reloads():
    # The pre-existing one-entry-per-kind behaviour, now exercised through a
    # single persistent AnimaLoaderPanel INSTANCE (the same one ComfyUI would
    # reuse across queue runs) rather than a module global: changing what
    # THIS instance's own unet row asks for must still miss the cache.
    calls, restore = _install_fake_comfy()
    try:
        panel = AnimaLoaderPanel()
        state_a = _panel_state([{"slot": 1, "kind": "unet", "value": "unetA.safetensors", "opts": {}}])
        state_b = _panel_state([{"slot": 1, "kind": "unet", "value": "unetB.safetensors", "opts": {}}])
        prompt_a = {
            "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": state_a}},
            "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 0)}},
        }
        prompt_b = {
            "7": {"class_type": "AnimaLoaderPanel", "inputs": {"panel_state": state_b}},
            "1": {"class_type": "KSampler", "inputs": {"model": _link("7", 0)}},
        }
        out1 = panel.run(state_a, prompt=prompt_a, unique_id="7")
        out2 = panel.run(state_b, prompt=prompt_b, unique_id="7")
        assert out1[0] is not out2[0], "changing this instance's own row name must miss the cache and reload"
        assert len(calls) == 2, calls

        # And re-running the ORIGINAL name on the SAME instance still hits
        # the cache once eviction has happened -- eviction, not disabling.
        out3 = panel.run(state_a, prompt=prompt_a, unique_id="7")
        assert out3[0] is not out1[0], "the original slot was overwritten -- a fresh load, not a stale hit"
        assert len(calls) == 3, calls
    finally:
        restore()


ALL_TESTS = [
    test_load_row_model_missing_name_raises_legible_error,
    test_load_row_model_no_value_set_raises_legible_error,
    test_load_row_model_valid_name_loads_and_returns_object,
    test_load_row_model_non_dict_or_unrecognized_kind_returns_zero,
    test_load_row_model_unet_passes_weight_dtype,
    test_load_row_model_clip_passes_type_and_device,
    test_load_row_model_clip_missing_type_key_defaults_to_qwen_image_not_stable_diffusion,
    test_load_row_model_vae_has_no_extra_opts,
    test_cache_hits_when_row_is_unchanged,
    test_cache_evicts_on_name_change,
    test_cache_evicts_on_opts_change_same_name,
    test_cache_is_single_entry_per_kind_not_shared_across_kinds,
    test_cache_changing_one_kind_does_not_evict_another_kind,
    test_cache_is_scoped_to_the_dict_passed_in_not_shared_globally,
    test_referenced_slots_missing_or_bad_prompt_fails_open,
    test_referenced_slots_our_id_absent_from_prompt_fails_open,
    test_referenced_slots_no_wires_at_all_is_a_real_empty_set,
    test_referenced_slots_one_wired_slot,
    test_referenced_slots_multiple_wired_slots_across_nodes,
    test_referenced_slots_plain_values_are_ignored,
    test_referenced_slots_link_to_a_different_node_is_ignored,
    test_referenced_slots_nested_subgraph_ids_match_via_tail,
    test_referenced_slots_link_pointing_at_no_row_is_still_reported,
    test_referenced_slots_out_of_range_output_index_is_dropped,
    test_referenced_slots_malformed_link_shapes_are_ignored_not_fatal,
    test_run_only_loads_rows_whose_slot_is_wired,
    test_run_nothing_wired_loads_nothing,
    test_run_missing_prompt_fails_open_and_loads_everything,
    test_run_garbage_prompt_fails_open_and_loads_everything,
    test_run_wired_slot_with_no_row_is_harmless,
    test_run_two_panel_instances_with_different_unets_do_not_evict_each_other,
    test_run_single_instance_changing_its_own_row_name_misses_cache_and_reloads,
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
        except Exception as exc:  # noqa: BLE001 - surface unexpected errors as failures too
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
