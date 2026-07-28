"""`generation_settings` defaults tree + normalizer (design doc §8). Pure —
no comfy/torch import anywhere in this file, matching
`nodes/controls/_rows_helpers.py`'s contract: every value here is treated as
**hostile**, since it can arrive from a hand-edited API payload, not just the
(not-yet-built) frontend overlay.

Defaults are upstream's verbatim wherever we ship the stage at all (design
doc §1 "Kept from it"), trimmed to the five stages we ship (no `save`, no
`spectrum`/`spd`/`dit_corrections` dispatch — design doc §1 "Deliberately NOT
copied": we run one sampler path, not upstream's three-way dispatch) — see
`../ComfyUI-EasyUseAnima/easyuse_anima/aio/generation_defaults.py` for the
upstream tree this is ported from (MIT © n0va39, THIRD_PARTY_NOTICES.md).

The three §9 divergences from the OLD (deleted) port are fixed in the
defaults below, not layered on afterward:
  - `guide_size_for: False` for both detailer blocks (`generation_defaults.py:306,372`).
  - `noise_mask_feather`: 10 for face, 20 for eye (`:321,387`) — never 0.
  - (The third divergence — hidden PROMPT/EXTRA_PNGINFO metadata — is a node-
    level concern on AnimaPreview, not a settings-tree concern; see
    `nodes/anima/preview.py`.)

**2026-07-28 reversal — `loras` and `latent` are GONE from this tree.** Both
only ever existed to serve `use_internal_loaders`'s "inline mode" (design
doc §3/§5b, now deleted): `loras` was the inline-mode-only ordered LoRA
list, and `latent` was inline mode's own width/height/batch, used only when
nothing was wired to the (now also deleted) `latent` socket. Resources —
MODEL/CLIP/VAE, LoRAs already baked in, and the starting LATENT — all
arrive exclusively through `AnimaContextBridge`'s `ANIMA_CONTEXT` now
(`src/anima/context.py`); a hand-edited payload that still sets either key
is not rejected (unknown keys always pass through per this module's own
contract, see below), it's simply inert data nothing reads anymore. An
unwired `latent` context field falls back to a FIXED default size in
`pipeline.py` itself (1024x1024, batch 1), not to a settings block, since
there's no more "inline mode" concept for such a block to belong to.

Normalization contract (identical to `_rows_helpers.parse_state`): unknown
keys pass through untouched, missing keys take defaults, an absent stage
block means "defaults, disabled" (every stage default already carries
`enabled: False`, so this falls out of the recursive merge for free — no
special case needed), and a version bump migrates forward, never rejects.
Hostile input (nulls, arrays where objects are expected, wrong types, an
array-shaped root) never raises.
"""
from __future__ import annotations

import copy
import json
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Schema / version
# ---------------------------------------------------------------------------

GENERATION_SETTINGS_SCHEMA = "animaflow.anima_generator.generation_settings"
GENERATION_SETTINGS_VERSION = 1

# Settled 2026-07-27 (design doc §6a): upstream is effectively uncapped, but
# every pass here is a full Impact re-sample, so the cap is a compute limit,
# not a socket-count limit (there are no per-block SEGS sockets at all — §6a).
# May grow later, must never shrink (same append-only spirit as
# `nodes/controls/control_panel.py`'s `MAX_ROWS`, `BACKLOG.md` §4).
MAX_DETAILER_PASSES = 4

# ---------------------------------------------------------------------------
# Per-block detailer defaults — upstream's face/eye blocks verbatim
# (`generation_defaults.py:292-424`), minus the spectrum/dit_corrections sub-
# trees we don't ship (design doc §4).
# ---------------------------------------------------------------------------


def _detailer_block(
    *,
    label: str,
    detect_prompt: str,
    threshold: float,
    crop_factor: float,
    drop_size: int,
    denoise: float,
    feather: int,
    noise_mask_feather: int,
) -> Dict[str, Any]:
    return {
        "label": label,
        "enabled": False,
        "detect_prompt": detect_prompt,
        "detect_count": 1,
        "threshold": threshold,
        "refine_iterations": 2,
        "individual_masks": True,
        "combined": False,
        "crop_factor": crop_factor,
        "bbox_fill": False,
        "drop_size": drop_size,
        "contour_fill": True,
        "guide_size": 1024,
        # §9 divergence #1 — MUST stay False (generation_defaults.py:306,372).
        "guide_size_for": False,
        "max_size": 2048,
        "steps": 20,
        "inherit_sampler_settings": True,
        "cfg": 8.0,
        "sampler_name": "euler",
        "scheduler": "sgm_uniform",
        "denoise": denoise,
        "feather": feather,
        "noise_mask": True,
        "force_inpaint": True,
        "wildcard": "",
        "cycle": 1,
        "alignment": "32",
        "inpaint_model": False,
        # §9 divergence #2 — must never be 0 (generation_defaults.py:321,387).
        "noise_mask_feather": noise_mask_feather,
        "tiled_encode": False,
        "tiled_decode": False,
    }


_FACE_BLOCK_DEFAULT = _detailer_block(
    label="Face Detailer", detect_prompt="face", threshold=0.52,
    crop_factor=4.0, drop_size=100, denoise=0.33, feather=5, noise_mask_feather=10,
)
_EYE_BLOCK_DEFAULT = _detailer_block(
    label="Eye Detailer", detect_prompt="eyes", threshold=0.5,
    crop_factor=6.0, drop_size=40, denoise=0.29, feather=6, noise_mask_feather=20,
)

# ---------------------------------------------------------------------------
# The full defaults tree
# ---------------------------------------------------------------------------
#
# NOTE on a design-doc discrepancy: `docs/generator-design.md` §8's example
# JSON literally repeats the `detailer` key twice — once as
# `{enabled, ...upstream face defaults}` and again lower down as
# `{blocks: [...], order: [...ids]}`. That's not valid JSON (a real object
# can't have two keys with the same name) and reads as a drafting artifact
# from merging two earlier revisions of the section. This tree resolves it
# the only way that keeps both intents: ONE `detailer` block, carrying its
# own `enabled` + `order` + a `blocks` dict keyed by block id (`face`/`eye`/
# `custom_N`), each block dict holding what the doc's first mention showed.
# `blocks` is a DICT, not upstream's array, because it lets `face`/`eye`
# merge generically against the recursive defaults-merge below — a list
# would need bespoke by-id merge logic for no benefit, since dict key ORDER
# already IS insertion order in Python, and `order` still governs display/
# apply order explicitly, matching upstream's own `detailer.order` field.
DEFAULT_GENERATION_SETTINGS: Dict[str, Any] = {
    "schema": GENERATION_SETTINGS_SCHEMA,
    "version": GENERATION_SETTINGS_VERSION,
    "sampler": {
        # -1 == "random"; resolving that into a real seed at run time is
        # `pipeline.py`'s job, not a settings-normalization concern.
        "seed": -1,
        "seed_after_generate": "fixed",
        "steps": 32,
        "cfg": 5.0,
        "sampler_name": "er_sde",
        "scheduler": "simple",
        "denoise": 1.0,
        # Anima's recommended default, always applied via
        # `ModelSamplingAuraFlow` (design doc §8) — a core ComfyUI node, not
        # a dependency, so it lives here unconditionally rather than under
        # `mod_guidance` (which IS conditional on Spectrum being installed).
        "shift": 3.0,
    },
    # NOTE (flag-underspecified in generator-design.md — see build report):
    # upstream drives Mod Guidance from prompt-data heuristics
    # (`mode: "from_prompt_data"`) that don't apply here, since conditioning
    # arrives to this node already encoded (§5 "Prompt text is not an
    # input"). We give it an explicit `enabled` flag instead, matching every
    # other stage's shape, rather than inventing a prompt-sniffing mode this
    # node has no prompt text to sniff.
    "mod_guidance": {
        "enabled": False,
        "profile": "step_i8_skip27",
        "quality_tags": "highres, best quality, score_7",
        "quality_neg": (
            "score_1, score_2, score_3, worst quality, lowres, old, bad "
            "hands, bad anatomy"
        ),
        "mod_w": 3.0,
        "mod_start_layer": 8,
        "mod_end_layer": 27,
        "mod_taper": 0,
        "mod_taper_scale": 0.25,
        "mod_final_w": 0.0,
    },
    "highres": {
        "enabled": False,
        "scale_by": 1.5,
        "upscale_method": "bicubic",
        "multiple": "32",
        "max_long_edge": 2560,
        # Never inherited regardless of the flag below — design doc §6b.
        "steps": 20,
        "denoise": 0.25,
        "inherit_sampler_settings": True,
        # Only reachable when `inherit_sampler_settings` is False — §6b.
        "cfg": 8.0,
        "sampler_name": "euler",
        "scheduler": "simple",
    },
    "upscale": {
        "enabled": False,
        "scale_by": 2.0,
        "steps": 20,
        "inherit_sampler_settings": True,
        "cfg": 8.0,
        "sampler_name": "euler",
        "scheduler": "simple",
        "denoise": 0.2,
        "usdu": {
            "upscale_model_name": "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors",
            "auto_tile_size": True,
            # Tile ORDER (Linear/Chess/None) — NOT the same axis as
            # `tiled_decode` below; see `usdu.py`'s module docstring (§6a).
            "mode_type": "Linear",
            "auto_tile_target": 1024,
            "auto_tile_min": 512,
            "auto_tile_max": 2048,
            "tile_width": 512,
            "tile_height": 512,
            "mask_blur": 8,
            "tile_padding": 32,
            "seam_fix_mode": "None",
            "seam_fix_denoise": 1.0,
            "seam_fix_width": 64,
            "seam_fix_mask_blur": 8,
            "seam_fix_padding": 16,
            "force_uniform_tiles": True,
            # An unrelated VAE flag — NOT tile order (§6a).
            "tiled_decode": False,
            "batch_size": 1,
        },
    },
    "postprocess": {
        "enabled": False,
        "fit": {
            "mode": "max_long_edge",
            "max_long_edge": 2048,
            "max_megapixels": 4.0,
            "method": "bicubic",
        },
    },
    "detailer": {
        "enabled": False,
        "order": ["face", "eye"],
        # NOTE (design-doc gap — see build report): neither §5's Generator
        # input table nor §8's settings example says where the SAM3
        # detection MODEL/CLIP come from — upstream loads its own dedicated
        # SAM3 checkpoint (`generation_defaults.py:288-291`) rather than
        # reusing the main generation MODEL/CLIP (SAM3 is a different model
        # family entirely). Carried forward verbatim since the detailer
        # stage cannot detect anything at all without it.
        "sam3": {"checkpoint": "sam3.1_multiplex_fp16.safetensors"},
        "blocks": {
            "face": _FACE_BLOCK_DEFAULT,
            "eye": _EYE_BLOCK_DEFAULT,
        },
    },
}


# ---------------------------------------------------------------------------
# Generic recursive merge — shape, not value validation. Value COERCION
# (str()/int()/float() guards) happens where each field is actually consumed
# (`sampler.py`, `resources.py`, `postprocess.py`, `usdu.py`), mirroring
# `_rows_helpers.value_for_row`'s split between `parse_state` (shape) and the
# coercers (value) rather than validating everything up front.
# ---------------------------------------------------------------------------


def _deep_merge_defaults(defaults: Any, value: Any) -> Any:
    """`value` merged onto a deep copy of `defaults`, recursively:
      - dict default + dict value -> merge key by key; keys in `value` not
        present in `defaults` pass through UNTOUCHED (the "unknown keys
        survive" contract) regardless of their shape.
      - dict default + non-dict value (or missing) -> the default, verbatim
        (a hand-edited payload replacing an object with a scalar can't be
        merged meaningfully; falling back to defaults is the safe read).
      - list default + list value -> `value`, verbatim (lists are treated as
        opaque data the owning module re-validates itself, e.g. `loras.py`'s
        promiscuous parsing) ; list default + non-list value (or missing) ->
        the default.
      - any other (scalar) default -> `value` if given (`is not None`),
        else the default. Hostile TYPES are accepted here on purpose
        (a string where a float is expected) — the consuming module coerces.
    """
    if isinstance(defaults, dict):
        if not isinstance(value, dict):
            return copy.deepcopy(defaults)
        merged = {key: _deep_merge_defaults(dval, value.get(key)) for key, dval in defaults.items()}
        for key, vval in value.items():
            if key not in merged:
                merged[key] = vval
        return merged
    if isinstance(defaults, list):
        return value if isinstance(value, list) else copy.deepcopy(defaults)
    return value if value is not None else defaults


def migrate_version(raw_version: Any, current_version: int = GENERATION_SETTINGS_VERSION) -> int:
    """Version-bump-forward, never-reject (design doc §8/§11). There is only
    ever one schema version shipped so far, so there is nothing to actually
    transform yet — this function exists so the CONTRACT ("hostile/old/future
    version numbers never crash normalization") is enforceable and tested
    now, before a second version ever exists to migrate from.

    Takes `current_version` as a parameter (rather than hardcoding this
    module's own `GENERATION_SETTINGS_VERSION`) so `preview_settings.py` can
    reuse it for the Preview node's own, differently-versioned settings
    blob (design doc §8: "The Preview node keeps its own settings blob, same
    hidden-serialized-STRING pattern").
    """
    try:
        version = int(raw_version)
    except (TypeError, ValueError):
        return current_version
    if version < current_version:
        # An old/missing version: the recursive merge above already brought
        # every key up to the current shape additively, so "migrating" is
        # just stamping the current version number.
        return current_version
    # A version from a NEWER build than this one understands: preserve it
    # rather than downgrading — we don't know what it means, but silently
    # relabeling it as our own older version would be a lie in the metadata.
    return version


# Backward-compatible private alias (this module's own call site below still
# uses the two-argument-default form).
_migrate_version = migrate_version


def _fixup_detailer(detailer: Any) -> Dict[str, Any]:
    """Two things the generic dict-merge above can't do on its own for
    `detailer.blocks`:
      1. An unknown block id (`custom_1`, or any user-chosen name) merges
         against the FACE template, not verbatim — "each inheriting the face
         defaults" (upstream `detailer_settings_dialog.js:357-368`, design
         doc §6a) — because the generic merge has no default entry for an
         id it's never seen, so it would otherwise pass the raw (possibly
         partial) block dict through untouched.
      2. `MAX_DETAILER_PASSES` cap enforcement: `order`'s listed ids win
         first, then any block present but not listed (a hand-edited payload
         could add one without adding it to `order`), each kept in
         encounter order; the rest are dropped rather than raising.
    """
    if not isinstance(detailer, dict):
        detailer = {}
    blocks = detailer.get("blocks")
    if not isinstance(blocks, dict):
        blocks = {}

    fixed_blocks: Dict[str, Any] = {}
    for block_id, block_value in blocks.items():
        if not isinstance(block_id, str) or not block_id:
            continue  # a hand-edited payload's garbage key has nowhere to go
        if block_id == "face":
            fixed_blocks[block_id] = _deep_merge_defaults(_FACE_BLOCK_DEFAULT, block_value)
        elif block_id == "eye":
            fixed_blocks[block_id] = _deep_merge_defaults(_EYE_BLOCK_DEFAULT, block_value)
        else:
            fixed_blocks[block_id] = _deep_merge_defaults(
                _FACE_BLOCK_DEFAULT, block_value if isinstance(block_value, dict) else {}
            )

    raw_order = detailer.get("order")
    if not isinstance(raw_order, list):
        raw_order = list(DEFAULT_GENERATION_SETTINGS["detailer"]["order"])
    ordered_ids: List[str] = [
        bid for bid in raw_order if isinstance(bid, str) and bid in fixed_blocks
    ]
    for bid in fixed_blocks:
        if bid not in ordered_ids:
            ordered_ids.append(bid)

    kept_ids = ordered_ids[:MAX_DETAILER_PASSES]
    detailer["blocks"] = {bid: fixed_blocks[bid] for bid in kept_ids}
    detailer["order"] = kept_ids
    detailer["enabled"] = bool(detailer.get("enabled", False))
    return detailer


def normalize_generation_settings(raw: Any) -> Dict[str, Any]:
    """`generation_settings` (the raw STRING widget value, or an already-
    parsed dict from a hand-edited API payload) -> a fully-shaped, defaulted
    settings tree. Never raises: bad JSON, a JSON scalar/array instead of an
    object, wrong-typed fields, and deeply-nested garbage all degrade to
    defaults rather than taking the node down — same contract as
    `_rows_helpers.parse_state`.
    """
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError, RecursionError):
        parsed = None
    if not isinstance(parsed, dict):
        parsed = {}

    merged = _deep_merge_defaults(DEFAULT_GENERATION_SETTINGS, parsed)
    merged["detailer"] = _fixup_detailer(merged.get("detailer"))
    merged["schema"] = GENERATION_SETTINGS_SCHEMA
    merged["version"] = _migrate_version(parsed.get("version"))
    return merged


def default_generation_settings() -> Dict[str, Any]:
    """A fresh deep copy of the defaults tree — for callers (tests, a future
    frontend) that want the shape without going through `json.dumps`/
    `normalize_generation_settings`'s parse round-trip.
    """
    return copy.deepcopy(DEFAULT_GENERATION_SETTINGS)
