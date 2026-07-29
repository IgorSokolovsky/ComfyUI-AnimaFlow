"""Chunked SHA256 of a file -- the pack's first file-hashing utility.

Used by the Civitai by-hash lookup (`lookup.py`): Civitai identifies a model
FILE (not a name) by its exact SHA256, so a match requires hashing the whole
file first. Streams in fixed-size chunks rather than `f.read()` in one call
so hashing a multi-GB checkpoint never pulls the whole file into memory at
once -- the pack has no file hashing today (the only existing `hashlib` use,
`nodes/prompt_rules/_rules_helpers.py`'s `is_changed_digest`, hashes short
strings, not files). Stdlib only, no comfy/torch import, so this module is
usable from anywhere in `src/` that runs outside ComfyUI too.

`sha256_file` is the same streamed, 1 MB-chunk pattern as
`../ComfyUI-Pixaroma/nodes/_lora_helpers.py:332-340`'s `file_sha256` (MIT,
THIRD_PARTY_NOTICES.md) -- reimplemented here as a stdlib-only function with
a configurable `chunk_size` rather than upstream's hardcoded literal.
"""
from __future__ import annotations

import hashlib

# 1 MiB -- large enough that the per-chunk overhead is negligible, small
# enough that memory use stays flat regardless of how big the file is.
_DEFAULT_CHUNK_SIZE = 1024 * 1024


def sha256_file(path: str, *, chunk_size: int = _DEFAULT_CHUNK_SIZE) -> str:
    """Hex SHA256 digest of the file at `path`, read `chunk_size` bytes at a
    time -- a several-GB checkpoint must never be loaded whole into memory
    just to fingerprint it. Raises `OSError` (or a subclass, e.g.
    `FileNotFoundError`) for a missing/unreadable file; catching that is the
    caller's job, same as any other filesystem call -- this module makes no
    attempt to guess or paper over a reason.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


__all__ = ("sha256_file",)
