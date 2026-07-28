"""Soft lookups for the optional third-party (and one ComfyUI-built-in) node
classes this pack composes with, never depends on at import time (design doc
§4). Absent pack => the caller's section is disabled; nothing here ever
raises `ImportError` outward — only returns `None`/`False`.

This module itself imports nothing eagerly (no `comfy`, `torch`, `nodes`,
or third-party package at module scope) — every lookup is lazy, matching
`nodes/controls/_loaders_helpers.py`'s lazy `import folder_paths`/`import
nodes` pattern (comfyui-pack-import-structure skill), so this file is
importable with no ComfyUI installed. `tests/test_anima_soft_imports.py`
exercises the "pack genuinely absent" case in a subprocess.
"""
from __future__ import annotations

import sys
from typing import Optional


def find_node_class(class_name: str) -> Optional[type]:
    """A third-party (or ComfyUI built-in) node's registered class, by its
    `NODE_CLASS_MAPPINGS` key — e.g. `"AnimaModGuidance"`,
    `"UltimateSDUpscale"`, `"DetailerForEach"`, `"MaskToSEGS"`.

    Scans every already-imported module's own `NODE_CLASS_MAPPINGS` dict —
    the same approach upstream's `_find_comfy_node_class` uses
    (`../ComfyUI-EasyUseAnima/easyuse_anima/image/sam3.py:20-30`) — rather
    than importing a specific `custom_nodes/<pack>` path, because a custom
    node pack's on-disk module path is not part of its public contract and
    varies across installs (pip-installed vs git-cloned, renamed folders,
    ...). ComfyUI itself has already imported every installed custom node
    pack by the time any node's `run()` executes, so this scan is reliable
    at that point even though it can't find anything at plain-script import
    time (there is no ComfyUI process running at all then — see this
    module's own docstring).

    Returns `None` — never raises — if the class isn't registered anywhere,
    which is the caller's cue that the owning pack isn't installed/enabled.
    """
    try:
        import nodes as comfy_nodes  # ComfyUI's own top-level `nodes` module; lazy.
    except ModuleNotFoundError:
        comfy_nodes = None
    if comfy_nodes is not None:
        mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", None)
        if isinstance(mappings, dict) and class_name in mappings:
            return mappings[class_name]
    for module in list(sys.modules.values()):
        mappings = getattr(module, "NODE_CLASS_MAPPINGS", None)
        if isinstance(mappings, dict) and class_name in mappings:
            return mappings[class_name]
    return None


def find_sam3_detect_class() -> Optional[type]:
    """`SAM3_Detect` is a ComfyUI BUILT-IN (`comfy_extras.nodes_sam3`), not a
    third-party dependency (design doc §4) — soft-looked-up the same way
    since it still isn't safe to import eagerly (no ComfyUI outside a live
    process), but its absence means an OLD ComfyUI build without native SAM3
    support, not a missing custom-node pack.
    """
    cls = find_node_class("SAM3_Detect")
    if cls is not None:
        return cls
    try:
        from comfy_extras.nodes_sam3 import SAM3_Detect  # type: ignore
        return SAM3_Detect
    except Exception:
        return None


def has_mod_guidance() -> bool:
    """Spectrum-KSampler's `AnimaModGuidance` present? (design doc §4 — the
    ONE dependency this pack takes). Repo is `blepping/ComfyUI-Spectrum-
    KSampler`, resolving the design doc's open discrepancy with its own
    README: verified against upstream's own `aio/sampling.py:131,257`, which
    cites `github.com/blepping/ComfyUI-Spectrum-KSampler` as the actual
    source for this exact class, not the README's `sorryhyun` spelling.
    """
    return find_node_class("AnimaModGuidance") is not None


def has_usdu() -> bool:
    """UltimateSDUpscale present? (design doc §4 — the upscale stage)."""
    return find_node_class("UltimateSDUpscale") is not None


def has_impact_detailer() -> bool:
    """Impact Pack's `DetailerForEach` + `MaskToSEGS` both present? (design
    doc §4 — BOTH required by the detailer stage; no detailer => no Impact,
    so we don't report "available" on a partial install).
    """
    return find_node_class("DetailerForEach") is not None and find_node_class("MaskToSEGS") is not None


def has_sam3_detect() -> bool:
    """ComfyUI's built-in SAM3 detection present? (design doc §4 — not a
    third-party dependency, but still absent on older ComfyUI builds).
    """
    return find_sam3_detect_class() is not None
