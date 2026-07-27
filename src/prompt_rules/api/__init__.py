"""API route modules for AnimaFlow (registered on `PromptServer`).

Each module here registers its own aiohttp routes as an import side effect
(see `rules_api.py`) and guards that registration so importing it OUTSIDE a
live ComfyUI process (e.g. from a plain-script test) never crashes.
"""
