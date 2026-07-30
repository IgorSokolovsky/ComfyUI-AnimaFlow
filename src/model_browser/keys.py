"""API key resolution -- docs/lora-loader-design.md §8's three-tier ladder:

  1. our own ComfyUI setting (`AnimaFlow.*`, stored server-side in
     `comfy.settings.json`), then
  2. the `CIVITAI_API_KEY` environment variable -- Civicomfy's own
     convention, so anyone already running it gets ours working with zero
     setup, then
  3. no key -> public-only mode, clearly indicated.

🔒 The resolved key is a SECRET, full stop. Every caller of
`resolve_api_key` must keep the returned string entirely server-side: never
logged, never put in a route's JSON response, and never written into a
node's `lora_state` blob (§3/§8) -- that blob lands in a saved workflow, and
the Preview embeds workflows into saved PNGs, so a key there would leak into
every shared image. `api.py`'s routes only ever surface `ResolvedKey.
public_only` (a bool) to the frontend, never `.api_key` or `.source`.
"""
from __future__ import annotations

import os
from typing import Mapping, NamedTuple, Optional

from ..anima.frontend_settings import get_setting

# `AnimaFlow.Controls.CivitaiApiKey` -- now ALSO declared in `js/shared/
# settings.mjs`'s `SETTING_IDS` map (a Settings-dialog "Civitai API key"
# text field, docs/settings.md), landed with no change needed on this
# side -- `get_setting` already reads whatever value ComfyUI's own
# persisted `comfy.settings.json` holds for this exact id, and degrades to
# `default` (here, `None`) if it's unset, same as before that frontend
# control existed. `tests/test_model_browser_key_setting_id.py` pins the
# two sides' literal against each other, since a rename on either end would
# break this silently (the setting would just always resolve to "no key").
SETTING_ID = "AnimaFlow.Controls.CivitaiApiKey"

# Civicomfy's own env var name (docs/lora-loader-design.md §8) -- matching
# it verbatim means anyone who already has Civicomfy configured gets this
# pack's Civitai features working with zero additional setup.
ENV_VAR = "CIVITAI_API_KEY"


class ResolvedKey(NamedTuple):
    """The ladder's outcome. `source` is `"setting"` / `"env"` / `"none"` --
    kept only for tests/diagnostics; NEVER put into a route's response
    (§8's "never logged" extends to "never surfaced" -- even the SOURCE of
    a key is more than a client needs to know, and the key itself must
    never appear at all).
    """

    api_key: Optional[str]
    source: str

    @property
    def public_only(self) -> bool:
        """Whether NO key was resolved -- the one field of this tuple a
        route may safely put in a JSON response (§8: "public-only mode,
        clearly indicated")."""
        return self.api_key is None


def resolve_api_key(*, env: Optional[Mapping[str, str]] = None) -> ResolvedKey:
    """Run §8's three-tier ladder and return the result. Never raises --
    `get_setting` already degrades to `None` for any problem reading the
    settings file (missing/malformed/ComfyUI not installed), and a missing
    env var degrades to `None` here the same way.

    `env` (keyword-only, defaults to `os.environ`) is the one seam this
    module's own test suite uses, so a test can set/omit `CIVITAI_API_KEY`
    without mutating the real process environment.
    """
    active_env: Mapping[str, str] = env if env is not None else os.environ

    setting_value = get_setting(SETTING_ID, None)
    if isinstance(setting_value, str) and setting_value.strip():
        return ResolvedKey(setting_value.strip(), "setting")

    env_value = active_env.get(ENV_VAR)
    if isinstance(env_value, str) and env_value.strip():
        return ResolvedKey(env_value.strip(), "env")

    return ResolvedKey(None, "none")


__all__ = ("SETTING_ID", "ENV_VAR", "ResolvedKey", "resolve_api_key")
