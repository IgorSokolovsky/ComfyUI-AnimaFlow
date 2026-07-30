"""Import-URL version stamping for this pack's own ES modules.

Ported from `../ComfyUI-Pixaroma/nodes/_cache_bust_helpers.py` (whole file,
~50 lines, MIT (c) pixaroma -- see THIRD_PARTY_NOTICES.md). The regex and the
stamping function below are that file's own `_IMPORT_RE`/`stamp_import_urls`,
carried over near-verbatim; the reasoning in its long doc comment is the
valuable part, reproduced here in this pack's own words, not the regex.

Why (owner-confirmed live 2026-07-30): ComfyUI core's cache middleware sets
`Cache-Control: no-store` on JS responses, but it checks
`request.path.endswith(".js")`, which never matches `.mjs` -- every lazily
imported `.mjs` module in this pack (`js/*/**.mjs`) is therefore served with
NO cache directive at all, and browsers hold it indefinitely. Headers alone
(`src/web_cache/api.py`'s Layer 1) only help when the browser actually
REQUESTS the file -- a browser that heuristically cached a pre-fix `.mjs`
treats it as fresh and never asks the server again. The only server-side move
that defeats an already-poisoned cache is changing the URL itself: stamp
`?v=<version>` onto every RELATIVE `.mjs` import specifier as the file is
served. After an update the version changes, every internal module URL is one
the browser has never seen, and the whole tree is fetched fresh with zero
user action.

Kept dependency-free (no `aiohttp`/`server` imports) so it is importable and
unit-testable with no ComfyUI installed, per `.claude/CLAUDE.md`'s pure/impure
rule for `src/`.

Scope rules (each deliberate -- do not widen; identical to upstream's own
list, `_cache_bust_helpers.py:16-27`):
- Only specifiers starting "./" or "../" AND ending ".mjs" are stamped. That
  is exactly this pack's own module convention. `/scripts/app.js` and any
  other ".js" specifier are NEVER stamped -- stamping `/scripts/app.js` would
  make the browser load a SECOND instance of ComfyUI's own app module (two
  registries, catastrophic and hard to diagnose).
- Every importer must receive the SAME version string in one page load, or
  two URLs for one module would create two module instances (duplicate
  registries). See `api.py`'s own doc comment for how this pack's version
  source (a single mtime-derived value computed once at import time and held
  for the process lifetime) makes that impossible in principle, not just in
  practice.
"""
from __future__ import annotations

import os
import re

# The module specifier of a relative .mjs import, in every form this pack
# writes:
#   import { x } from "./a.mjs";      import "../b.mjs";
#   export * from "./c.mjs";          const m = await import("./d.mjs");
# Multi-line dynamic imports match too (\s covers newlines). Alternation order
# matters: the dynamic-import branch (with the paren) is tried before the bare
# static-import branch. Verbatim from `_cache_bust_helpers.py:38-40`.
_IMPORT_RE = re.compile(
    r"""(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?/[^"'\n]+?\.mjs)\2"""
)

_SAFE_VERSION_RE = re.compile(r"[^A-Za-z0-9._-]")


def stamp_import_urls(text: str, version) -> str:
    """Return `text` with `?v=<version>` appended to every relative `.mjs`
    import specifier. Verbatim port of `_cache_bust_helpers.py:45-50`.

    `version` is sanitised to `[A-Za-z0-9._-]` (anything else becomes `-`);
    an empty/`None`/all-unsafe version degrades to `"0"` rather than
    producing a bare `?v=` with nothing after it.

    Idempotency note (pinned by `tests/test_web_cache.py`, not assumed): the
    regex requires the closing quote to immediately follow `.mjs`, so an
    ALREADY-stamped specifier (`"./a.mjs?v=1"`) does not match at all -- the
    `?v=1` between `.mjs` and the quote breaks the pattern. Re-stamping
    already-stamped text is therefore a no-op, not a double-append; this is
    incidental to the regex's shape, not a dedicated idempotency check, so a
    future edit to `_IMPORT_RE` could change that -- the test exists so a
    change here is a deliberate decision, not a silent regression.
    """
    v = _SAFE_VERSION_RE.sub("-", str(version or "")) or "0"
    return _IMPORT_RE.sub(
        lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}?v={v}{m.group(2)}", text
    )


def compute_js_version(js_root: str) -> str:
    """Return this process's stable cache-busting version: the maximum mtime
    (integer seconds, as a string) across every `.js`/`.mjs` file under
    `js_root`, walked once.

    Deliberately NOT Pixaroma's own design (`../ComfyUI-Pixaroma/
    server_routes.py:103-116`'s `_pixaroma_stamp_version`, which re-reads
    `pyproject.toml` on every call whenever ITS mtime changes, because that
    pack's users update without restarting ComfyUI). This pack's owner
    instead deploys via `git pull` then a FULL ComfyUI restart
    (`.claude/CLAUDE.md`'s own deploy note) -- `pyproject.toml`'s version
    field rarely bumps on that loop, so mirroring Pixaroma's source would
    often hand out the SAME stamp across an update that changed `.mjs`
    content. Using the JS tree's own max mtime instead changes the stamp
    exactly when a JS file changes (a `git pull` touches mtimes), and calling
    this ONCE, at import time, and holding the result for the process
    lifetime gives an ABSOLUTE guarantee of one stable version per process --
    the same-version-per-page-load invariant (`_IMPORT_RE`'s own module doc
    comment above) cannot be violated even in principle, not merely "unlikely
    in practice" the way a live-reloadable version would leave it. The
    trade-off is explicit: a code change needs a restart to be reflected in
    the stamp -- already true for this pack's Python, and consistent with the
    existing deploy instruction, so this is not a new requirement.

    Returns "0" if `js_root` doesn't exist or contains no matching files;
    never raises (a missing/unreadable directory degrades to "0" rather than
    propagating -- this runs once at import time, so raising here would break
    importing the whole pack over a cache-busting nicety).
    """
    latest = 0.0
    try:
        for dirpath, _dirnames, filenames in os.walk(js_root):
            for name in filenames:
                if name.endswith(".mjs") or name.endswith(".js"):
                    try:
                        mtime = os.path.getmtime(os.path.join(dirpath, name))
                    except OSError:
                        continue
                    if mtime > latest:
                        latest = mtime
    except OSError:
        pass
    return str(int(latest)) if latest > 0 else "0"
