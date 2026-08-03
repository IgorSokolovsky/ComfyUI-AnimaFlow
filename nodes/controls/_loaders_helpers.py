"""Model loading for the Anima Loader Panel (docs/control-panel-design.md §3
"Loader Panel", §2 "Residual coupling").

Real `MODEL`/`VAE`/`CLIP` objects are built by delegating to ComfyUI's OWN
loader nodes (`UNETLoader`, `VAELoader`, `CLIPLoader` from ComfyUI's top-level
`nodes` module) rather than reimplementing their `comfy.sd`/`comfy.utils`
plumbing here -- that plumbing is exactly the kind of thing that drifts out
from under a custom pack across ComfyUI versions.

`torch`/`folder_paths`/`nodes` (ComfyUI's own, not this pack's `nodes/`) are
all imported LAZILY, inside functions, so this module -- and
`tests/test_controls_loaders.py`, which stubs them via `sys.modules` -- stay
importable with no ComfyUI installed (comfyui-pack-import-structure skill).

Cache tradeoff (deliberate, read before "fixing" this into an LRU): the
cache holds exactly ONE entry PER ROW KIND ("unet"/"vae"/"clip"), not one
per distinct name ever seen. A loaded MODEL/CLIP/VAE keeps its weights
resident (VRAM for a MODEL/CLIP, RAM/VRAM for a VAE) for as long as
something still references it, so caching every name a user ever picked
would be a slow leak across a session. Because there's only one slot per
kind, changing a row's name simply overwrites that slot -- the old
`(key, obj)` pair drops its only reference here and becomes freeable --
while an unrelated row changing (e.g. the VAE row) does NOT evict the UNET
slot, so the "residual coupling" re-execution (ComfyUI re-running every
row's load because the loader node object changed) still returns the SAME
cached UNET/CLIP objects instead of re-reading them from disk.

The cache itself (`LoaderCache`, a plain dict) is owned by each
`AnimaLoaderPanel` INSTANCE (`self._cache`, created in `loader_panel.py`'s
`__init__`) and passed explicitly into `load_row_model`/`cache_probe` below
-- deliberately NOT a module-level global (that was this module's shape
until 2026-07-30: a global made every Loader Panel in the graph share one
slot per kind, so two panels holding different UNETs evicted each other's
model on every run). ComfyUI keeps one node instance alive across queue runs
for the same node in the graph -- the same assumption `lora_loader.py`'s own
`LoraCache` already relies on (see its `__init__`) -- so an instance-scoped
cache still gets the cross-run reuse this mechanism needs; it just no
longer leaks across UNRELATED Loader Panel instances.

VRAM-skip scan (`referenced_slots`): loading a row is not free -- it pulls a
MODEL/VAE/CLIP onto the GPU (the user's real constraint is a Colab GPU with
tight VRAM) -- so a row whose output slot nothing downstream is wired to
should not load at all. `referenced_slots` is a PURE function (no
folder_paths/nodes/torch) that inspects the hidden `PROMPT` payload to work
out which of our own output slots are actually referenced anywhere in the
graph; `loader_panel.py`'s `run()` skips `load_row_model` for every other
slot, exactly as it already does for a slot with no row. It fails OPEN
(returns `None`, meaning "load everything", the pre-existing behaviour) on
any input shape it can't confidently parse -- see the function's own
docstring for the exact conditions. This machinery is deliberately NOT
mirrored on `AnimaControlPanel`: control_panel.py's docstring explains why.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Set, Tuple

# kind -> (cache_key, loaded_object). One entry per kind -- see module
# docstring for why this must not grow into a dict keyed by name. Owned by
# each `AnimaLoaderPanel` INSTANCE (`self._cache`), never a module global --
# every function below that reads or writes one takes it as an explicit
# `cache` parameter instead of reaching for a shared name.
LoaderCache = Dict[str, Tuple[Tuple, Any]]

# Row kind -> the folder_paths folder its filename list / validation lives
# in, matching the ComfyUI loader node each kind delegates to (§3 table).
# `checkpoint` (M3, docs/lora-loader-design.md + docs/control-panel-
# design.md) matches `src/model_browser/kinds.py`'s own `KIND_TO_FOLDER
# ["checkpoints"]` -- the two whitelists must agree, same reasoning that
# module's own docstring gives for `unet`.
_FOLDER_FOR_KIND = {
    "unet": "diffusion_models",
    "vae": "vae",
    "clip": "text_encoders",
    "checkpoint": "checkpoints",
}

# Fallback ONLY for a clip row's `opts` missing a `"type"` key entirely --
# the normal path (`js/controls/rows.mjs`'s `normalizeRow`/`mkRow`) always
# writes a real `type` before the row's state ever reaches this module, so
# this fires only for a genuinely hand-edited/malformed API payload. Was
# "stable_diffusion" (CLIP_TYPES[0] on the JS side) -- the same wrong-for-
# Anima default Bug 1 fixed on the frontend; kept in sync here so a
# malformed payload doesn't quietly disagree with the frontend's own
# default. See `js/controls/rows.mjs`'s clip branch / `src/anima/resources.py`.
_DEFAULT_CLIP_TYPE = "qwen_image"


class LoaderRowError(ValueError):
    """A loader row's saved filename can no longer be resolved against
    ComfyUI's installed models -- the common real failure when a model has
    been moved, renamed, or deleted since the workflow was saved."""


def _validate_name(kind: str, name: Any) -> str:
    import folder_paths  # ComfyUI-only; lazy (see module docstring).

    if not isinstance(name, str) or not name:
        raise LoaderRowError(
            f"Loader Panel's '{kind}' row has no model file selected. Pick one "
            f"from the row's combo before running the graph."
        )
    folder = _FOLDER_FOR_KIND[kind]
    available = folder_paths.get_filename_list(folder)
    if name not in available:
        listed = ", ".join(available) if available else "(none found)"
        raise LoaderRowError(
            f"Loader Panel's '{kind}' row wants '{name}', but that file is no "
            f"longer in ComfyUI's '{folder}' folder -- it may have been moved, "
            f"renamed, or deleted since this workflow was saved. Re-pick it in "
            f"the row's combo. Files currently available: {listed}."
        )
    return name


def _cache_key(kind: str, name: str, opts: Dict[str, Any]) -> Tuple:
    """The part of a row that actually changes what gets loaded -- distinct
    from `opts` fields that are pure UI state (there are none of those for
    loader rows today, but keeping this as an explicit allow-list rather than
    hashing the whole `opts` dict means a future UI-only field doesn't
    silently defeat the cache).
    """
    if kind == "unet":
        return (name, opts.get("weight_dtype", "default"))
    if kind == "clip":
        return (name, opts.get("type", _DEFAULT_CLIP_TYPE), opts.get("device", "default"))
    return (name,)  # vae/checkpoint have no extra options (§3 table)


def load_row_model(row: Optional[Dict[str, Any]], cache: LoaderCache) -> Any:
    """A loader-panel row -> a real MODEL/VAE/CLIP object, per its `kind`.
    `cache` is the CALLING `AnimaLoaderPanel` instance's own `self._cache`
    (see module docstring) -- this function only reads/writes the dict it's
    handed, never a shared one, so two callers with two different `cache`
    dicts can never evict each other. Returns `0` for a non-dict row or an
    unrecognized/garbage `kind` (the same "kind-appropriate zero" an empty
    slot emits -- see control_panel.py/_rows_helpers.py). Raises
    `LoaderRowError` -- a legible, user-facing message -- when the row's
    saved filename can't be resolved.
    """
    if not isinstance(row, dict):
        return 0
    kind = row.get("kind")
    if kind not in _FOLDER_FOR_KIND:
        return 0

    opts = row.get("opts")
    if not isinstance(opts, dict):
        opts = {}
    name = _validate_name(kind, row.get("value"))

    key = _cache_key(kind, name, opts)
    cached = cache.get(kind)
    if cached is not None and cached[0] == key:
        return cached[1]

    obj = _load(kind, name, opts)
    # Overwriting (not merging into) `cache[kind]` is the whole mechanism:
    # whatever was cached for this kind before is now unreferenced here.
    cache[kind] = (key, obj)
    return obj


def _load(kind: str, name: str, opts: Dict[str, Any]) -> Any:
    import nodes as comfy_nodes  # ComfyUI's own `nodes` module; lazy (see module docstring).

    if kind == "unet":
        weight_dtype = opts.get("weight_dtype", "default")
        return comfy_nodes.UNETLoader().load_unet(name, weight_dtype)[0]
    if kind == "vae":
        return comfy_nodes.VAELoader().load_vae(name)[0]
    if kind == "checkpoint":
        # `CheckpointLoaderSimple.load_checkpoint` returns `(MODEL, CLIP,
        # VAE)` -- MODEL only, deliberately (see `rows.mjs`'s
        # `KIND_META.checkpoint` doc comment: a checkpoint row is one output
        # socket, same as every other Loader Panel row, and exposing the
        # baked CLIP/VAE would need a multi-socket row -- unscheduled).
        return comfy_nodes.CheckpointLoaderSimple().load_checkpoint(name)[0]
    # kind == "clip"
    clip_type = opts.get("type", _DEFAULT_CLIP_TYPE)
    device = opts.get("device", "default")
    return comfy_nodes.CLIPLoader().load_clip(name, clip_type, device)[0]


# ---------------------------------------------------------------------------
# VRAM-skip scan -- which of our own output slots does anything downstream
# actually reference? Pure (no comfy/torch/folder_paths import) so it's unit
# -testable without ComfyUI; see tests/test_controls_loaders.py.
# ---------------------------------------------------------------------------


def _node_id_matches(candidate: Any, unique_id: Any) -> bool:
    """String-safe node-id comparison that also tolerates nested/subgraph ids
    (`"12:3"`). Exact string match first; if that fails, compare the segment
    after each id's last `:` -- the same fallback Pixaroma's `findNode` uses
    in `js/sliders/index.js`, for the same reason: a link's source id and our
    own `unique_id` can be spelled with or without a subgraph prefix
    depending on where in the graph each is read from.
    """
    a, b = str(candidate), str(unique_id)
    if a == b:
        return True
    return a.rsplit(":", 1)[-1] == b.rsplit(":", 1)[-1]


def referenced_slots(prompt: Any, unique_id: Any, max_rows: int) -> Optional[Set[int]]:
    """Which of our own output slots (1-based, `[1, max_rows]`) does anything
    in `prompt` actually wire to? Returns `None` -- meaning "couldn't tell,
    load everything", the safe/old behaviour -- rather than an empty set,
    whenever the scan can't be trusted:

      - `prompt` is missing / not a dict (a hand-edited API payload can omit
        the hidden PROMPT entirely, or ComfyUI could hand us something we
        don't expect from a future version).
      - Our OWN `unique_id` doesn't appear as a key in `prompt` at all -- we
        can't even locate ourselves in the graph, so we cannot possibly trust
        a scan for references TO us. This is different from "we found
        ourselves, but nothing points at us", which is the legitimate
        nothing-is-wired case and correctly yields an EMPTY set (load
        nothing), not `None`.

    Otherwise: walk every node's every input; ComfyUI represents a wired link
    as a 2-element `[source_node_id, output_index]` (see
    `comfy_execution/graph_utils.is_link` upstream) -- anything else (a
    literal widget value) is ignored. Keep the links whose `source_node_id`
    matches ours (`_node_id_matches`, string-safe + subgraph-tolerant) and
    collect `output_index + 1` (ComfyUI's outputs are 0-indexed; our slots
    are 1-indexed) into the result, clipped to `[1, max_rows]` -- an
    out-of-range index can't be a genuine reference to one of our slots.
    """
    if not isinstance(prompt, dict):
        return None
    if not any(_node_id_matches(node_id, unique_id) for node_id in prompt.keys()):
        return None

    referenced: Set[int] = set()
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        node_inputs = node.get("inputs")
        if not isinstance(node_inputs, dict):
            continue
        for value in node_inputs.values():
            # A link is a 2-element [source_node_id, output_index]; anything
            # else (a plain widget value: a string, number, bool, dict, a
            # list of some other length) is not a link and is ignored.
            if not (isinstance(value, (list, tuple)) and len(value) == 2):
                continue
            source_id, output_index = value
            if not isinstance(output_index, int) or isinstance(output_index, bool):
                continue
            if _node_id_matches(source_id, unique_id):
                referenced.add(output_index + 1)

    return {slot for slot in referenced if 1 <= slot <= max_rows}


# ---------------------------------------------------------------------------
# Diagnostic-only reads -- for the "which model did the Loader Panel
# actually load" logging (`loader_panel.py`'s `_emit_loader_log`; see that
# module's own docstring for the console-logging contract). Both functions
# below are read-only: neither ever mutates `cache`, and `resolve_full_path`
# never raises. Kept HERE (not in the new `_loader_log_helpers.py`) because
# they need this module's own private helpers/constants (`_cache_key`,
# `_FOLDER_FOR_KIND`) and the SAME `cache` dict `load_row_model` reads/writes
# -- exporting a probe alongside the state it reads is less error-prone than
# reaching into another module's privates.
# ---------------------------------------------------------------------------


def cache_probe(kind: str, name: str, opts: Dict[str, Any], cache: LoaderCache) -> Dict[str, Any]:
    """Would `load_row_model` hit the cache for this exact `(kind, name,
    opts)` right now? `cache` must be the SAME dict (the calling panel's own
    `self._cache`) the real `load_row_model` call will use -- otherwise the
    hit/miss field in the debug log would describe a cache that isn't the
    one actually deciding. Read-only: computes the same key `load_row_model`
    itself would (`_cache_key`) and compares it against `cache[kind]`
    (`cached[0] == key`, the SAME comparison `load_row_model` makes) without
    ever writing to `cache` -- calling this before a real
    `load_row_model(row, cache)` cannot change what that call does or
    returns. Returns `{"cache_key": key, "hit": bool}`.
    """
    key = _cache_key(kind, name, opts)
    cached = cache.get(kind)
    hit = cached is not None and cached[0] == key
    return {"cache_key": key, "hit": hit}


def resolve_full_path(kind: str, name: Any) -> Optional[str]:
    """Best-effort absolute path for `name` in `kind`'s folder -- the
    decisive field a wrong-model log line needs (a name string alone doesn't
    prove which FILE was actually read; a resolved path does). Diagnostic
    ONLY: never raises, and its result is never fed back into any load
    decision -- a `None` here means "couldn't resolve it for the log", not
    "the file doesn't exist" (that's `_validate_name`'s job, and it already
    ran, with a user-facing error, before this is ever called).
    """
    try:
        import folder_paths  # ComfyUI-only; lazy (see module docstring).
    except Exception:
        return None
    folder = _FOLDER_FOR_KIND.get(kind)
    if not folder or not isinstance(name, str) or not name:
        return None
    getter = getattr(folder_paths, "get_full_path", None)
    if getter is None:
        return None
    try:
        path = getter(folder, name)
    except Exception:
        return None
    return path if isinstance(path, str) else None
