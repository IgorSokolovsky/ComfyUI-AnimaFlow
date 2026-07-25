"""Tag autocomplete — cross-cutting service (Gelbooru-primary / Danbooru-
fallback), not a graph node. No import-time side effects here: this module
only re-exports the pure pieces. The one intentional import-time side
effect in this pack (aiohttp route registration) lives solely in `api.py`,
imported explicitly by the root `__init__.py`.
"""

from __future__ import annotations

from .dataset import AutocompleteEntry, load_danbooru, load_gelbooru, normalize_tag_key
from .index import search

__all__ = [
    "AutocompleteEntry",
    "load_gelbooru",
    "load_danbooru",
    "normalize_tag_key",
    "search",
]
