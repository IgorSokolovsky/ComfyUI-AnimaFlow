"""LLMPanels — story/scene brief -> multi-panel labeled-prose text via an
OpenAI-compatible chat-completions endpoint (OpenRouter by default).

Thin node wrapper; payload building and response parsing live in
`_llm_panels_helpers` (pure, unit-tested, no network I/O). This file does the
one impure thing — the HTTP POST — using stdlib `urllib` only (no `requests`,
nothing added to `requirements.txt`; see the module docstring in
`_llm_panels_helpers.py` for why the format matters: it must slot straight
into `PanelBatch` -> the same labeled-prose shape `_scene_creator_helpers`
produces).

Supports story CONTINUATION across separate queue runs: since ComfyUI nodes
are stateless, the caller feeds this node's own prior `panels_text` /
`synopsis` outputs back in as `previous_panels` / `synopsis` inputs (e.g.
run 1 -> panels 1-4 + a synopsis; run 2 wires that synopsis and/or
panels_text back in -> panels 5-8 + an updated synopsis, and so on).
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from ._llm_panels_helpers import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_SYSTEM_PROMPT,
    build_messages,
    build_payload,
    extract_content,
    split_panels_and_synopsis,
)

_REQUEST_TIMEOUT_SECONDS = 120


class LLMPanels:
    CATEGORY = "AnimaFlow/llm"
    EXPERIMENTAL = True
    FUNCTION = "generate"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("panels_text", "synopsis")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "brief": ("STRING", {"multiline": True, "default": ""}),
                "api_key": ("STRING", {"default": ""}),
                "model": ("STRING", {"default": DEFAULT_MODEL}),
            },
            "optional": {
                "target_panels": ("INT", {"default": 0, "min": 0, "max": 24}),
                "base_url": ("STRING", {"default": DEFAULT_BASE_URL}),
                "system_prompt": (
                    "STRING",
                    {"multiline": True, "default": DEFAULT_SYSTEM_PROMPT},
                ),
                "character_bible": ("STRING", {"multiline": True, "default": ""}),
                "previous_panels": ("STRING", {"multiline": True, "default": ""}),
                "synopsis": ("STRING", {"multiline": True, "default": ""}),
                "temperature": (
                    "FLOAT",
                    {"default": 0.8, "min": 0.0, "max": 2.0, "step": 0.05},
                ),
                "max_tokens": ("INT", {"default": 2048, "min": 64, "max": 32768}),
                "seed": ("INT", {"default": 0, "min": 0}),
            },
        }

    def generate(
        self,
        brief,
        api_key,
        model,
        target_panels=0,
        base_url=DEFAULT_BASE_URL,
        system_prompt=DEFAULT_SYSTEM_PROMPT,
        character_bible="",
        previous_panels="",
        synopsis="",
        temperature=0.8,
        max_tokens=2048,
        seed=0,
    ):
        messages = build_messages(
            system_prompt, brief, target_panels, character_bible, previous_panels, synopsis
        )
        payload = build_payload(model, messages, temperature, max_tokens, seed)

        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            base_url,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            raise RuntimeError(
                f"LLM Panels request failed: HTTP {exc.code} {exc.reason}. {detail}".strip()
            ) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"LLM Panels request failed: {exc.reason}") from exc
        except TimeoutError as exc:
            raise RuntimeError("LLM Panels request timed out.") from exc

        try:
            response_json = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"LLM Panels received invalid JSON response: {exc}") from exc

        try:
            content = extract_content(response_json)
        except ValueError as exc:
            raise RuntimeError(f"LLM Panels: {exc}") from exc

        panels_text, new_synopsis = split_panels_and_synopsis(content)
        return (panels_text, new_synopsis)
