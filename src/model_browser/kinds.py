"""`kind` -> ComfyUI folder-key whitelist (docs/lora-loader-design.md §7a).

🔒 SECURITY BOUNDARY: `kind` arrives from the client (a query-string value or
a JSON body field) and, downstream, resolves to a real filesystem path via
`folder_paths.get_full_path(folder, name)` and -- for a future search/
download route -- a WRITE destination under `models/`. A client-supplied
folder key is therefore a directory-traversal vector the moment it's passed
to `folder_paths` raw. This module is the one place that decision gets made:
map `kind` through a FIXED dict and reject anything not in it. Nothing else
in this package (or `nodes/controls/lora_loader.py`) should ever interpolate
a raw `kind` string into a path -- always go through `folder_for_kind` first
and treat `None` as "reject the request".

Wired: `loras` only (design doc M1). `checkpoints`/`unet` are already in the
map -- kept, unused, rather than added later -- because retrofitting `kind`
touches folder resolution, the sidecar path, the download destination, and
the Civitai `type` filter all at once (design doc §7a); adding the other two
kinds for the Loader Panel reuse pass (M3) is then just wiring, not a schema
change.
"""
from __future__ import annotations

from typing import Optional

# kind -> the folder_paths folder key (docs/lora-loader-design.md §7a table).
# `unet`'s folder_paths key has changed name across ComfyUI versions -- it
# maps here to the CURRENT one, `diffusion_models`, matching
# `nodes/controls/_loaders_helpers.py`'s own `_FOLDER_FOR_KIND["unet"]`, so
# the two whitelists agree rather than silently drifting apart.
KIND_TO_FOLDER = {
    "loras": "loras",
    "checkpoints": "checkpoints",
    "unet": "diffusion_models",
}

# Only `loras` is reachable from a registered node/route today (design doc
# M1); the Loader Panel reuse pass (M3) wires `checkpoints`/`unet`. Kept as
# its own explicit set -- not "whatever's in KIND_TO_FOLDER" -- so turning a
# kind on for real is a one-line, deliberate change here, not an accident of
# the whitelist growing.
ACTIVE_KINDS = frozenset({"loras"})


def folder_for_kind(kind: object) -> Optional[str]:
    """`kind` -> its ComfyUI folder key, or `None` for anything not in the
    fixed whitelist above -- including a non-string, an empty string, or a
    traversal attempt like `"../../etc"`. Never raises, and never
    interpolates `kind` into a path itself; every caller MUST treat `None`
    as "reject the request" rather than falling back to `kind` itself.
    """
    if not isinstance(kind, str):
        return None
    return KIND_TO_FOLDER.get(kind)


def is_active_kind(kind: object) -> bool:
    """Whether `kind` is not just whitelisted but actually wired up for a
    live node/route today -- see `ACTIVE_KINDS`'s docstring for why this is
    a separate, smaller check than `folder_for_kind`."""
    return isinstance(kind, str) and kind in ACTIVE_KINDS


__all__ = ("KIND_TO_FOLDER", "ACTIVE_KINDS", "folder_for_kind", "is_active_kind")
