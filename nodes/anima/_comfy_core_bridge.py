"""Tiny shared bridge for locating ComfyUI's own core Node classes
(`KSampler`, `CLIPTextEncode`, `EmptyLatentImage`, `VAEEncode`, `VAEDecode`,
`LoraLoader`, ...) by their registered node id.

`AnimaGenerator`'s pipeline stages (`_anima_generator_helpers.py`) and the
shared conditioning helper (`_anima_conditioning_helpers.py`) both call
these core node classes directly - literally instantiating e.g. core's own
`KSampler` and calling its `.sample(...)` method - rather than re-deriving
the equivalent lower-level `comfy.sample`/`comfy.sd` calls by hand. That
guarantees bit-identical results to wiring the same core node into a stock
workflow, and it stays correct automatically across ComfyUI versions
whose internal tensor-shape/device/latent-channel handling changes over
time, instead of this pack duplicating (and risking drifting from) that
logic. Modeled on the reference pack's own `_find_comfy_node_class`
(`../ComfyUI-EasyUseAnima/easyuse_anima/infrastructure/comfy/capabilities.py`),
simplified: no `sys.modules` scan, just the top-level `nodes` module's own
attributes and its `NODE_CLASS_MAPPINGS`.

IMPORTANT gotcha (why `import nodes` below is safe): this pack's own node
package is also named `nodes/` (this very file lives in it), but it is
NEVER imported under the bare top-level name `nodes` - only under this
pack's own dotted path (e.g. `webtoon_generator.nodes...`), because the
root `__init__.py` uses a relative import (`from .nodes.node_x import X`).
So inside a live ComfyUI process, the bare name `nodes` unambiguously
resolves to sys.modules's actual entry for ComfyUI's own core `nodes.py`
(already imported at startup under exactly that name) - never this pack's
own package.

VERIFY-IN-COMFYUI: the one place that guarantee does NOT hold is this
repo's own plain-script test suite (`test_*.py`, run directly with
`python3 file.py` from the repo root): there, the repo root - which
contains a real `nodes/` directory - sits on `sys.path` with no ComfyUI
process around it, so bare `import nodes` resolves to THIS pack's own
package instead (already cached in `sys.modules` the moment any test does
`from nodes._x_helpers import ...`). That package has none of these
core-node attributes, so `find_core_node_class` correctly returns None
there and every caller degrades to its documented fallback / guarded-
smoke-test-skip behavior instead of silently reaching into the wrong
module - this is exactly the behavior `test_anima_generator_helpers.py`
relies on to exercise the "core node unavailable" branches without a real
ComfyUI install.
"""

from __future__ import annotations


def find_core_node_class(node_id: str):
    """Return ComfyUI's own core Node class registered as `node_id` (e.g.
    `"KSampler"`), or `None` if it can't be found - never raises. See the
    module docstring for exactly when/why this returns `None` (no live
    ComfyUI process, e.g. this repo's own test suite)."""
    try:
        import nodes as core_nodes  # noqa: PLC0414 - intentionally the bare top-level name, see module docstring
    except Exception:
        return None

    cls = getattr(core_nodes, node_id, None)
    if isinstance(cls, type):
        return cls

    mappings = getattr(core_nodes, "NODE_CLASS_MAPPINGS", None)
    if isinstance(mappings, dict):
        candidate = mappings.get(node_id)
        if isinstance(candidate, type):
            return candidate

    return None


def require_core_node_class(node_id: str):
    """Same as `find_core_node_class`, but raises a clear, actionable
    `RuntimeError` instead of returning `None` - for pipeline call sites
    that genuinely cannot proceed without the real core node (mid-run
    sampling stages), matching this repo's `AnimaDetailerAlignHook` /
    the reference pack's "missing required core node" error convention."""
    cls = find_core_node_class(node_id)
    if cls is None:
        raise RuntimeError(
            f"[AnimaGenerator] Could not find ComfyUI's core '{node_id}' node. "
            "This node must run inside a live ComfyUI process with core nodes.py "
            "loaded (not, for example, this repo's own plain-script test suite)."
        )
    return cls


__all__ = ("find_core_node_class", "require_core_node_class")
