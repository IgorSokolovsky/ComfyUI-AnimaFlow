"""Pure(-ish) logic for `AnimaRegionalConditioning`.

Substantially simpler than the reference pack's regional-conditioning node
(`../ComfyUI-EasyUseAnima/easyuse_anima/nodes/regional_nodes.py`'s
`EasyUseAnimaRegionalConditioning`), because masks arrive here already
rasterized as real `MASK` tensors (from `AnimaRegionMaskEditor`, or any
other source — this node makes no assumption about where a wired `mask_i`/
`cond_i` pair came from) — there is no geometry blob to parse/rasterize on
this side at all.

## Native ComfyUI conditioning-mask metadata, not invented keys

The metadata-attach step (`attach_region_mask` / `set_conditioning_values`
below) sets exactly the keys ComfyUI's OWN core `ConditioningSetMask` node
sets on a conditioning entry — `mask`, `set_area_to_bounds`,
`mask_strength` — via the exact same non-mutating copy-and-update algorithm
core's `node_helpers.conditioning_set_values` uses (confirmed against the
reference pack's own `_conditioning_set_values`, `../ComfyUI-EasyUseAnima/
easyuse_anima/prompt/regional.py`, which implements the identical
copy-the-metadata-dict-then-update contract — that pack's docstring/UI copy
also explicitly says its own `set_cond_area` combo "mirrors ComfyUI
ConditioningSetMask area behavior"). No `area` key is ever set by this
module: unlike the reference pack (which additionally hand-computes an
explicit `(height, width, y, x)` latent-space bounding box from the mask,
baking in an assumed 8x latent downscale factor that may not hold for every
VAE), this pack relies entirely on core's own `set_area_to_bounds=True`
flag, which tells the SAMPLER to derive the sampling area from the mask's
own bounds at run time — no separate area math needed, and no assumption
about latent/pixel scale baked into this pack's own code. See
`node_anima_regional_conditioning.py`'s docstring for how this delegates to
the real core class when one is reachable.

`collect_region_pairs` and `set_conditioning_values`/`attach_region_mask`
are fully pure (no `torch`, no `comfy` import at module level) — the actual
`mask`/conditioning-tensor VALUES that flow through them are opaque to this
module (it only inspects dict/list/tuple STRUCTURE, never tensor content),
so these functions work identically whether fed real ComfyUI conditioning/
mask tensors or plain fake `[[tensor_stub, {...}], ...]` structures, which
is exactly what `tests/test_anima_regional_conditioning.py` uses to assert
the non-mutation property without needing torch at all.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("AnimaFlow")

# Set the first time the live-core `ConditioningSetMask` delegation raises
# (see `combine_regional_conditioning` below), so the fallback warning fires
# once per process instead of once per region per run - this call sits in a
# per-region loop, and a broken core signature would otherwise spam the log
# on every single region of every single graph execution.
_warned_core_conditioning_set_mask_failed = False

AREA_MODE_MASK_BOUNDS = "mask bounds"
AREA_MODE_DEFAULT = "default"
AREA_MODES = (AREA_MODE_MASK_BOUNDS, AREA_MODE_DEFAULT)


def normalize_area_mode(value) -> str:
    """Sanitize a possibly-invalid `area_mode` widget value down to one of
    `AREA_MODES`, defaulting to `AREA_MODE_MASK_BOUNDS` (the node's own
    default, matching `playground/anima_region_mask_editor.html`'s combo
    order: "mask bounds" listed first)."""
    text = str(value or "").strip().lower()
    return text if text in AREA_MODES else AREA_MODE_MASK_BOUNDS


def area_mode_to_set_area_to_bounds(area_mode) -> bool:
    """`area_mode` -> core's own `set_area_to_bounds` boolean: mirrors
    ComfyUI's `ConditioningSetMask` exactly (its `set_cond_area` widget only
    treats the literal string `"default"` as "do NOT restrict to mask
    bounds" — every other value, including this node's `"mask bounds"`,
    means "yes, restrict")."""
    return normalize_area_mode(area_mode) != AREA_MODE_DEFAULT


def collect_region_pairs(pairs) -> list:
    """Decide which numbered `(mask, cond)` pairs are ACTIVE: a pair is
    active only when BOTH its mask and its conditioning are non-`None`
    (an unpaired mask or conditioning is silently ignored — see
    `AnimaRegionalConditioning`'s `mask_i`/`cond_i` tooltips). `pairs` is a
    list of `(mask, cond)` tuples in numbered order (index 0 == region 1,
    ..., index 5 == region 6) — sparse/non-contiguous wiring (e.g. only
    indices 1 and 4 populated) is preserved correctly since this iterates
    in order and only ever APPENDS active entries; it never renumbers or
    reorders. Returns a list of `(region_number, mask, cond)` tuples,
    `region_number` 1-based, in ascending numbered order."""
    active = []
    for i, pair in enumerate(pairs or [], start=1):
        if not isinstance(pair, (tuple, list)) or len(pair) != 2:
            continue
        mask, cond = pair
        if mask is not None and cond is not None:
            active.append((i, mask, cond))
    return active


def set_conditioning_values(conditioning, values: dict) -> list:
    """PURE mirror of ComfyUI core's own `node_helpers.conditioning_set_values`
    (also mirrored by the reference pack's `_conditioning_set_values`, see
    module docstring): for every `[cond_tensor, metadata_dict]` entry, COPY
    `metadata_dict` (never mutate the caller's dict in place — a classic
    ComfyUI custom-node bug: mutating an upstream conditioning's shared
    metadata dict corrupts every other branch of the graph that still holds
    a reference to it) and update the copy with `values`. Entries that
    don't match the `[tensor, dict]` shape pass through completely
    untouched. Never inspects `values["mask"]`'s type, so this works
    identically on real torch MASK tensors or plain test fakes."""
    out = []
    for entry in conditioning or []:
        if isinstance(entry, (list, tuple)) and len(entry) >= 2 and isinstance(entry[1], dict):
            metadata = dict(entry[1])
            metadata.update(values)
            out.append([entry[0], metadata])
        else:
            out.append(entry)
    return out


def attach_region_mask(conditioning, mask, mask_strength: float, area_mode) -> list:
    """PURE fallback implementation of the metadata-attach step, used when
    ComfyUI's own live `ConditioningSetMask` class isn't reachable (e.g.
    this repo's own plain-script test suite, run outside a live ComfyUI
    process — see `_comfy_core_bridge.py`). Sets exactly the three keys
    core's own node sets: `mask`, `set_area_to_bounds`, `mask_strength` — no
    invented keys, no separate `area` bounding-box computation (see module
    docstring for why `set_area_to_bounds` alone is sufficient)."""
    return set_conditioning_values(conditioning, {
        "mask": mask,
        "set_area_to_bounds": area_mode_to_set_area_to_bounds(area_mode),
        "mask_strength": float(mask_strength),
    })


def combine_regional_conditioning(
    positive,
    pairs,
    mask_strength: float,
    area_mode,
    core_conditioning_set_mask_cls=None,
) -> list:
    """Build the combined `positive` conditioning list: the global
    `positive` input passed through FIRST, unchanged and un-mutated
    (concatenation only — its own entries are never touched), followed by
    each ACTIVE region's own conditioning (see `collect_region_pairs`) with
    mask metadata attached, in ascending region-number order (1..6). This
    ordering — global entries first, then regions in numbered order — is
    ComfyUI's own established regional-prompting convention (each
    conditioning-list entry independently carries its own optional mask/
    area/strength metadata; the sampler weighs/areas each entry
    independently, so list order doesn't change SAMPLING semantics, only
    keeps the output deterministic/readable — matches the reference pack's
    own `positive.extend(...)` after its already-encoded global prompt).

    `core_conditioning_set_mask_cls`, if given, is ComfyUI's own live
    `ConditioningSetMask` node CLASS (see `_comfy_core_bridge.
    find_core_node_class("ConditioningSetMask")`) — when available, its own
    `.append(cond, mask, set_cond_area_string, strength)` method attaches
    the metadata, guaranteeing byte-identical behavior to any other
    core-node-produced conditioning (immune to this pack's own logic ever
    drifting from a future core version's exact contract). `attach_region_mask`
    above (this module's pure fallback, exercised directly by this repo's
    test suite) is used otherwise — same three keys, same non-mutating
    copy semantics, so behavior does not meaningfully differ between the
    two paths.

    The delegated call is wrapped in a broad `try`/`except Exception`: see
    `node_anima_regional_conditioning.py`'s own `VERIFY-IN-COMFYUI` note next
    to where `core_conditioning_set_mask_cls` is looked up — the assumed
    `.append(conditioning, mask, set_cond_area, strength)` signature has not
    been exercised against a real ComfyUI install, so a class being
    *reachable* is no guarantee its call signature still matches. If a live
    ComfyUI version ever changes that signature (or the class raises for any
    other reason), this now degrades safely to the pure `attach_region_mask`
    fallback instead of raising inside a user's graph, logging a one-time
    warning (see `_warned_core_conditioning_set_mask_failed` above) rather
    than either staying silent or spamming the log once per region.
    """
    global _warned_core_conditioning_set_mask_failed
    active = collect_region_pairs(pairs)
    result = list(positive or [])
    for _region_number, mask, cond in active:
        delegated = False
        if core_conditioning_set_mask_cls is not None:
            try:
                set_cond_area = (
                    AREA_MODE_MASK_BOUNDS if area_mode_to_set_area_to_bounds(area_mode) else AREA_MODE_DEFAULT
                )
                masked = core_conditioning_set_mask_cls().append(cond, mask, set_cond_area, float(mask_strength))[0]
                delegated = True
            except Exception as exc:
                if not _warned_core_conditioning_set_mask_failed:
                    logger.warning(
                        "[AnimaFlow] combine_regional_conditioning: core ConditioningSetMask delegation "
                        "failed (%s); falling back to this pack's own attach_region_mask implementation.",
                        exc,
                    )
                    _warned_core_conditioning_set_mask_failed = True
        if not delegated:
            masked = attach_region_mask(cond, mask, mask_strength, area_mode)
        result = result + list(masked)
    return result


__all__ = (
    "AREA_MODE_DEFAULT",
    "AREA_MODE_MASK_BOUNDS",
    "AREA_MODES",
    "area_mode_to_set_area_to_bounds",
    "attach_region_mask",
    "collect_region_pairs",
    "combine_regional_conditioning",
    "normalize_area_mode",
    "set_conditioning_values",
)
