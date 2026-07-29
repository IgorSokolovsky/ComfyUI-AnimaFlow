"""Plain-script tests for `Anima LoRA Loader`'s apply step + memory-mode
cache (`nodes/controls/_lora_helpers.py`'s `apply_loras`/`LoraCache`) --
WITHOUT a live ComfyUI process.

`_lora_helpers.py` imports `folder_paths`/`comfy.sd`/`comfy.utils` lazily,
inside functions, specifically so they can be stubbed here via
`sys.modules` rather than needing a real ComfyUI install -- same convention
as `tests/test_controls_loaders.py`.

Run directly: `python tests/test_lora_apply.py` (no pytest, per project convention).
"""
from __future__ import annotations

import atexit
import os
import sys
import tempfile
import types

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import the module under test FIRST (resolves this pack's own `nodes`
# package via the repo-root sys.path shim above), THEN stub `sys.modules`
# for ComfyUI's `folder_paths`/`comfy.sd`/`comfy.utils` below --
# `_lora_helpers.py`'s own lazy imports happen per-call, inside its
# functions, so they pick up whatever is in `sys.modules` at CALL time, not
# at this module's import time.
from nodes.controls import _lora_helpers as lh

# `apply_loras` checks `os.path.isfile(path)` on whatever the fake
# `folder_paths.get_full_path` resolves to (mirroring the real node's own
# defence against a stale ComfyUI filename-cache entry pointing at a file
# that's since been deleted) -- so "a resolvable LoRA" in these tests needs
# to be a REAL file on disk, not just a string. One shared temp directory
# for the whole module holds every filename any test below resolves to
# "present"; a name simply absent from a test's own `files={}` mapping
# stays "not found" without needing a matching file at all.
_TMP_DIR = tempfile.TemporaryDirectory()
atexit.register(_TMP_DIR.cleanup)


def _real_path(name: str) -> str:
    path = os.path.join(_TMP_DIR.name, name)
    if not os.path.isfile(path):
        open(path, "wb").close()
    return path


def _files_map(*names: str):
    """`{name: real_on_disk_path}` for every name in `names` -- what a test's
    fake `folder_paths.get_full_path` should resolve. A name deliberately
    left OUT of a test's own mapping (never passed here) stays unresolvable,
    simulating a missing/renamed file without needing a matching real file."""
    return {name: _real_path(name) for name in names}


class _FakeLora:
    """Stands in for the raw state-dict `comfy.utils.load_torch_file`
    returns -- identity matters here (cache hit/miss is asserted via `is`
    on the underlying object), not content."""

    def __init__(self, path, load_index):
        self.path = path
        self.load_index = load_index  # which physical load produced this

    def __repr__(self):
        return f"_FakeLora({self.path!r}, load#{self.load_index})"


def _install_fake_comfy(*, files=None, fail_load_for=(), fail_apply_for=()):
    """Install fake `folder_paths`/`comfy.sd`/`comfy.utils` modules and
    return `(load_calls, apply_calls, restore)`:

      - `files`: {name: real path} the fake `folder_paths.get_full_path`
        knows about (see `_files_map`); a name not in it resolves to `None`
        (missing file).
      - `fail_load_for`: a set of paths whose `load_torch_file` call raises
        (simulating a corrupt file).
      - `fail_apply_for`: a set of paths whose `load_lora_for_models` call
        raises (simulating a file that loads but fails to apply).
      - `load_calls`: every `(path,)` actually passed to `load_torch_file`.
      - `apply_calls`: every `(path, sm, sc)` actually passed to
        `load_lora_for_models`.
    """
    files = files or {}
    load_calls = []
    apply_calls = []
    load_counter = {"n": 0}

    fake_folder_paths = types.ModuleType("folder_paths")

    def get_full_path(folder, name):
        assert folder == "loras"
        return files.get(name)

    fake_folder_paths.get_full_path = get_full_path

    fake_comfy = types.ModuleType("comfy")
    fake_comfy_sd = types.ModuleType("comfy.sd")
    fake_comfy_utils = types.ModuleType("comfy.utils")

    def load_torch_file(path, safe_load=True, return_metadata=False):
        load_calls.append((path,))
        if path in fail_load_for:
            raise RuntimeError(f"corrupt file: {path}")
        load_counter["n"] += 1
        lora = _FakeLora(path, load_counter["n"])
        meta = {"path": path}
        return (lora, meta) if return_metadata else lora

    def load_lora_for_models(model, clip, lora, sm, sc, lora_metadata=None):
        apply_calls.append((lora.path, sm, sc))
        if lora.path in fail_apply_for:
            raise RuntimeError(f"apply failed: {lora.path}")
        new_model = f"{model}+lora({lora.path},{sm})"
        new_clip = clip if clip is None else f"{clip}+lora({lora.path},{sc})"
        return new_model, new_clip

    fake_comfy_utils.load_torch_file = load_torch_file
    fake_comfy_sd.load_lora_for_models = load_lora_for_models
    fake_comfy.sd = fake_comfy_sd
    fake_comfy.utils = fake_comfy_utils

    previous = {
        "folder_paths": sys.modules.get("folder_paths"),
        "comfy": sys.modules.get("comfy"),
        "comfy.sd": sys.modules.get("comfy.sd"),
        "comfy.utils": sys.modules.get("comfy.utils"),
    }
    sys.modules["folder_paths"] = fake_folder_paths
    sys.modules["comfy"] = fake_comfy
    sys.modules["comfy.sd"] = fake_comfy_sd
    sys.modules["comfy.utils"] = fake_comfy_utils

    def restore():
        for name, mod in previous.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod

    return load_calls, apply_calls, restore


def _row(name, on=True, sm=1.0, sc=None, triggers=None):
    row = {"name": name, "on": on, "sm": sm}
    if sc is not None:
        row["sc"] = sc
    if triggers is not None:
        row["triggers"] = triggers
    return row


def _state(rows, cache_mode="last", sep=", "):
    return {"cacheMode": cache_mode, "sep": sep, "rows": rows}


# ---------------------------------------------------------------------------
# Basic apply: row order, CLIP passthrough when unwired
# ---------------------------------------------------------------------------


def test_apply_applies_switched_on_rows_in_order():
    files = _files_map("a.safetensors", "b.safetensors")
    path_a, path_b = files["a.safetensors"], files["b.safetensors"]
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        state = _state([_row("a.safetensors"), _row("b.safetensors")])
        cache = lh.LoraCache()
        model, clip, triggers = lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert model == f"MODEL0+lora({path_a},1.0)+lora({path_b},1.0)"
        assert apply_calls == [(path_a, 1.0, 1.0), (path_b, 1.0, 1.0)]
    finally:
        restore()


def test_apply_clip_none_passes_through_unchanged_and_zeroes_clip_strength():
    files = _files_map("a.safetensors")
    path_a = files["a.safetensors"]
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        state = _state([_row("a.safetensors", sm=0.8, sc=0.5)])
        cache = lh.LoraCache()
        model, clip, triggers = lh.apply_loras("MODEL0", None, state, cache)
        assert clip is None
        # sc forced to 0.0 when clip is unwired -- nothing to apply it to.
        assert apply_calls == [(path_a, 0.8, 0.0)]
    finally:
        restore()


def test_apply_off_row_is_skipped_entirely():
    files = _files_map("a.safetensors")
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        state = _state([_row("a.safetensors", on=False)])
        cache = lh.LoraCache()
        model, clip, triggers = lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert model == "MODEL0"
        assert clip == "CLIP0"
        assert apply_calls == []
    finally:
        restore()


# ---------------------------------------------------------------------------
# Trigger provenance (§1b) -- only rows that ACTUALLY APPLIED contribute.
# ---------------------------------------------------------------------------


def test_triggers_only_from_rows_that_actually_applied():
    files = _files_map("a.safetensors", "b.safetensors")  # "missing.safetensors" left OUT
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        state = _state([
            _row("a.safetensors", triggers=["alpha"]),
            _row("missing.safetensors", triggers=["ghost"]),  # not in `files` -- unresolvable
            _row("b.safetensors", triggers=["beta"]),
        ])
        cache = lh.LoraCache()
        _, _, triggers = lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert triggers == "alpha, beta"
        assert "ghost" not in triggers
    finally:
        restore()


def test_missing_file_contributes_no_triggers_and_is_not_loaded():
    load_calls, apply_calls, restore = _install_fake_comfy(files={})  # nothing resolves
    try:
        state = _state([_row("gone.safetensors", triggers=["ghost"])])
        cache = lh.LoraCache()
        model, clip, triggers = lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert model == "MODEL0" and clip == "CLIP0"
        assert triggers == ""
        assert load_calls == [] and apply_calls == []
    finally:
        restore()


def test_corrupt_file_load_failure_contributes_no_triggers():
    files = _files_map("bad.safetensors", "good.safetensors")
    load_calls, apply_calls, restore = _install_fake_comfy(
        files=files, fail_load_for={files["bad.safetensors"]},
    )
    try:
        state = _state([
            _row("bad.safetensors", triggers=["ghost"]),
            _row("good.safetensors", triggers=["kept"]),
        ])
        cache = lh.LoraCache()
        _, _, triggers = lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert triggers == "kept"
    finally:
        restore()


def test_apply_failure_after_successful_load_contributes_no_triggers():
    files = _files_map("bad.safetensors", "good.safetensors")
    load_calls, apply_calls, restore = _install_fake_comfy(
        files=files, fail_apply_for={files["bad.safetensors"]},
    )
    try:
        state = _state([
            _row("bad.safetensors", triggers=["ghost"]),
            _row("good.safetensors", triggers=["kept"]),
        ])
        cache = lh.LoraCache()
        _, _, triggers = lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert triggers == "kept"
    finally:
        restore()


def test_strength_zero_row_still_counts_for_triggers_but_does_not_load():
    files = _files_map("a.safetensors")
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        state = _state([_row("a.safetensors", sm=0.0, sc=0.0, triggers=["zeroed"])])
        cache = lh.LoraCache()
        model, clip, triggers = lh.apply_loras("MODEL0", "CLIP0", state, cache)
        # File present, strengths zero: NOT applied to the model...
        assert model == "MODEL0" and clip == "CLIP0"
        assert load_calls == [] and apply_calls == []
        # ...but the user turned it on on purpose, so it still counts (§1b).
        assert triggers == "zeroed"
    finally:
        restore()


# ---------------------------------------------------------------------------
# Memory modes (§1b) -- "all" / "none" / "last", incl. the last-mode fix.
# ---------------------------------------------------------------------------


def test_mode_none_clears_cache_after_every_run():
    files = _files_map("a.safetensors", "b.safetensors")
    path_a, path_b = files["a.safetensors"], files["b.safetensors"]
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        cache = lh.LoraCache()
        state = _state([_row("a.safetensors"), _row("b.safetensors")], cache_mode="none")
        lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert cache._entry_count_for_tests() == 0
        # Running again re-loads everything from scratch (no cross-run reuse).
        lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert load_calls == [(path_a,), (path_b,), (path_a,), (path_b,)]
    finally:
        restore()


def test_mode_none_peaks_at_two_entries_mid_run_not_the_whole_stack():
    files = _files_map("a.safetensors", "b.safetensors", "c.safetensors")
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        cache = lh.LoraCache()
        seen_counts = []
        real_load = cache.load

        def spying_load(path):
            result = real_load(path)
            seen_counts.append(cache._entry_count_for_tests())
            return result

        cache.load = spying_load
        state = _state(
            [_row("a.safetensors"), _row("b.safetensors"), _row("c.safetensors")],
            cache_mode="none",
        )
        lh.apply_loras("MODEL0", "CLIP0", state, cache)
        # Right after each load, at most 2 entries are resident (the one
        # just loaded plus, briefly, the previous one before it's popped by
        # the NEXT load) -- never all 3.
        assert seen_counts, "spying_load never ran"
        assert max(seen_counts) <= 2, seen_counts
    finally:
        restore()


def test_mode_all_keeps_whole_stack_and_frees_removed_rows():
    files = _files_map("a.safetensors", "b.safetensors")
    path_a, path_b = files["a.safetensors"], files["b.safetensors"]
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        cache = lh.LoraCache()
        state1 = _state([_row("a.safetensors"), _row("b.safetensors")], cache_mode="all")
        lh.apply_loras("MODEL0", "CLIP0", state1, cache)
        assert cache._entry_count_for_tests() == 2

        # Re-running with the SAME rows must not reload either file.
        lh.apply_loras("MODEL0", "CLIP0", state1, cache)
        assert load_calls == [(path_a,), (path_b,)]

        # Removing row b frees its cache entry; a stays resident.
        state2 = _state([_row("a.safetensors")], cache_mode="all")
        lh.apply_loras("MODEL0", "CLIP0", state2, cache)
        assert cache._entry_count_for_tests() == 1
    finally:
        restore()


def test_mode_last_keeps_exactly_one_entry_across_runs():
    files = _files_map("a.safetensors", "b.safetensors")
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        cache = lh.LoraCache()
        state = _state([_row("a.safetensors"), _row("b.safetensors")], cache_mode="last")
        lh.apply_loras("MODEL0", "CLIP0", state, cache)
        # Only the LAST row's file survives to the next run.
        assert cache._entry_count_for_tests() == 1
    finally:
        restore()


def test_mode_last_does_not_evict_retained_entry_on_the_runs_first_row():
    # THE regression this test exists for (§1b): a 2+ row stack where the
    # first row of THIS run is the entry retained from the PREVIOUS run --
    # it must be REUSED (cache hit, no reload), not evicted the moment it's
    # touched, which would make "last" behave like "none".
    files = _files_map("a.safetensors", "b.safetensors")
    path_a, path_b = files["a.safetensors"], files["b.safetensors"]
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        cache = lh.LoraCache()

        # Run 1: stack is just [a] -- "last" retains a's entry afterward.
        run1 = _state([_row("a.safetensors")], cache_mode="last")
        lh.apply_loras("MODEL0", "CLIP0", run1, cache)
        assert load_calls == [(path_a,)]
        assert cache._entry_count_for_tests() == 1

        # Run 2: stack is [a, b] -- a is THIS run's first row, and it's the
        # entry retained from run 1. It must be a CACHE HIT (no second load
        # call for "a"), and must NOT be evicted before b's load happens.
        run2 = _state([_row("a.safetensors"), _row("b.safetensors")], cache_mode="last")
        lh.apply_loras("MODEL0", "CLIP0", run2, cache)
        assert load_calls == [(path_a,), (path_b,)], load_calls
        # After run 2, "last" mode again retains only the most recent (b).
        assert cache._entry_count_for_tests() == 1
    finally:
        restore()


def test_mode_last_keeps_retained_entry_when_nothing_loads_this_run():
    # A run where every row is switched OFF (nothing loads) must not drop
    # the entry retained from the previous run, as long as it's still part
    # of the (off) stack.
    files = _files_map("a.safetensors")
    path_a = files["a.safetensors"]
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        cache = lh.LoraCache()
        run1 = _state([_row("a.safetensors")], cache_mode="last")
        lh.apply_loras("MODEL0", "CLIP0", run1, cache)
        assert cache._entry_count_for_tests() == 1

        run2 = _state([_row("a.safetensors", on=False)], cache_mode="last")
        lh.apply_loras("MODEL0", "CLIP0", run2, cache)
        assert load_calls == [(path_a,)]  # no second load
    finally:
        restore()


def test_mode_last_frees_retained_entry_when_stack_emptied():
    files = _files_map("a.safetensors")
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        cache = lh.LoraCache()
        run1 = _state([_row("a.safetensors")], cache_mode="last")
        lh.apply_loras("MODEL0", "CLIP0", run1, cache)
        assert cache._entry_count_for_tests() == 1

        run2 = _state([], cache_mode="last")
        lh.apply_loras("MODEL0", "CLIP0", run2, cache)
        assert cache._entry_count_for_tests() == 0
    finally:
        restore()


def test_older_comfy_without_lora_metadata_param_falls_back():
    files = _files_map("a.safetensors")
    path_a = files["a.safetensors"]
    load_calls, apply_calls, restore = _install_fake_comfy(files=files)
    try:
        import comfy.sd  # the fake module just installed

        def load_lora_for_models_no_metadata_kw(model, clip, lora, sm, sc):
            apply_calls.append((lora.path, sm, sc))
            return f"{model}+fallback({lora.path})", clip

        def picky(*args, **kwargs):
            if "lora_metadata" in kwargs:
                raise TypeError("unexpected keyword argument 'lora_metadata'")
            return load_lora_for_models_no_metadata_kw(*args, **kwargs)

        comfy.sd.load_lora_for_models = picky

        state = _state([_row("a.safetensors")])
        cache = lh.LoraCache()
        model, clip, triggers = lh.apply_loras("MODEL0", "CLIP0", state, cache)
        assert model == f"MODEL0+fallback({path_a})"
    finally:
        restore()


ALL_TESTS = [
    test_apply_applies_switched_on_rows_in_order,
    test_apply_clip_none_passes_through_unchanged_and_zeroes_clip_strength,
    test_apply_off_row_is_skipped_entirely,
    test_triggers_only_from_rows_that_actually_applied,
    test_missing_file_contributes_no_triggers_and_is_not_loaded,
    test_corrupt_file_load_failure_contributes_no_triggers,
    test_apply_failure_after_successful_load_contributes_no_triggers,
    test_strength_zero_row_still_counts_for_triggers_but_does_not_load,
    test_mode_none_clears_cache_after_every_run,
    test_mode_none_peaks_at_two_entries_mid_run_not_the_whole_stack,
    test_mode_all_keeps_whole_stack_and_frees_removed_rows,
    test_mode_last_keeps_exactly_one_entry_across_runs,
    test_mode_last_does_not_evict_retained_entry_on_the_runs_first_row,
    test_mode_last_keeps_retained_entry_when_nothing_loads_this_run,
    test_mode_last_frees_retained_entry_when_stack_emptied,
    test_older_comfy_without_lora_metadata_param_falls_back,
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
