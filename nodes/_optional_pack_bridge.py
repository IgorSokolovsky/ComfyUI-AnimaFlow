"""Tiny shared bridge for locating OPTIONAL external custom-node-pack
classes (Impact Pack's `DetailerForEach`, ComfyUI_UltimateSDUpscale's
`UltimateSDUpscale`, ComfyUI-Distilled-ResShift's `ResShiftLoader` /
`ResShiftUpscale`, ...) by their registered node id.

Different from `_comfy_core_bridge.py` (read that module's docstring first):
core ComfyUI node classes (`KSampler`, `CLIPTextEncode`, `SaveImage`,
`UpscaleModelLoader`, ...) live as direct attributes on the `nodes` module
itself, because they're defined inside ComfyUI's own core `nodes.py` (or a
`comfy_extras` module core imports at startup). Classes belonging to OTHER,
separately-installed custom-node packs are never attributes of `nodes` -
they only ever get merged into the global `nodes.NODE_CLASS_MAPPINGS` dict,
by ComfyUI's own `init_extra_nodes()` loader at startup, keyed by each
class's registered node-type string. So this module looks up ONLY
`nodes.NODE_CLASS_MAPPINGS`, never `nodes`' own attributes - a plain
`getattr(nodes, node_id)` would never find an Impact Pack / USDU / ResShift
class no matter how "installed" that pack is.

Registered node-type-id strings `_anima_generator_helpers.py` calls with,
and how they were confirmed (read from the reference pack's own source, not
guessed):
  - `"DetailerForEach"` - Impact Pack's detailer node. Confirmed via
    `../ComfyUI-EasyUseAnima/easyuse_anima/image/sam3.py`'s
    `_find_impact_detailer_class()`, which does
    `mappings.get("DetailerForEach")` against every loaded module's own
    `NODE_CLASS_MAPPINGS`, falling back to
    `from impact.impact_pack import DetailerForEach` as a last resort direct
    import - both paths agree on the same class under the same registered
    id.
  - `"UltimateSDUpscale"` - ComfyUI_UltimateSDUpscale's tiled img2img
    upscale node. Confirmed via
    `../ComfyUI-EasyUseAnima/easyuse_anima/aio/legacy_generation.py`'s
    `_run_aio_usdu_upscale_stage`, which does
    `_require_custom_node_class("UltimateSDUpscale", "ComfyUI_UltimateSDUpscale", ...)`
    then calls the resulting class's own `.upscale(...)` method.
  - `"ResShiftLoader"` / `"ResShiftUpscale"` - ComfyUI-Distilled-ResShift's
    model-loader and upscale nodes. Confirmed via the same file's
    `_run_aio_resshift_upscale_stage`, which requires both ids by name and
    calls `.load(...)` / `.upscale(...)` on them respectively.

Same "outside ComfyUI" guard pattern as `_comfy_core_bridge.py`: a bare
`import nodes` resolves to THIS pack's own `nodes/` package (not ComfyUI's
core `nodes.py`) whenever there's no live ComfyUI process on `sys.path`
(e.g. this repo's own plain-script test suite) - see that module's
docstring for the full explanation of why that's safe inside a real
ComfyUI process. This pack's own `nodes/` package has no
`NODE_CLASS_MAPPINGS` attribute of its own, so `find_optional_node_class`
correctly returns `None` there too, and every caller degrades to its
documented fallback / guarded-error behavior instead of silently reaching
into the wrong module.
"""

from __future__ import annotations


def find_optional_node_class(node_id: str):
    """Return an OPTIONAL external custom-node pack's Node class registered
    as `node_id` in ComfyUI's global `nodes.NODE_CLASS_MAPPINGS`, or `None`
    if it can't be found - never raises.

    Unlike `_comfy_core_bridge.find_core_node_class`, this checks ONLY
    `NODE_CLASS_MAPPINGS` (see this module's docstring for why): optional
    packs' classes are never plain attributes of the `nodes` module itself.
    """
    try:
        import nodes as core_nodes  # noqa: PLC0414 - intentionally the bare top-level name, see module docstring
    except Exception:
        return None

    mappings = getattr(core_nodes, "NODE_CLASS_MAPPINGS", None)
    if not isinstance(mappings, dict):
        return None

    candidate = mappings.get(node_id)
    if isinstance(candidate, type):
        return candidate
    return None


def require_optional_node_class(node_id: str, pack_name: str):
    """Same as `find_optional_node_class`, but raises a clear, actionable
    `RuntimeError` instead of returning `None` - for pipeline call sites
    (the detailer/upscale stages in `_anima_generator_helpers.py`) that
    genuinely cannot proceed without an optional pack's node actually being
    installed."""
    cls = find_optional_node_class(node_id)
    if cls is None:
        raise RuntimeError(
            f"{pack_name} is not installed — install it to use this feature "
            f"(missing node type: {node_id})"
        )
    return cls


__all__ = ("find_optional_node_class", "require_optional_node_class")
