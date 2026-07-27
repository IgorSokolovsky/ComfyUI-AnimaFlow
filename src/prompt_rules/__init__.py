"""Prompt Rules feature: the clean-room rules engine (`core/`), its aiohttp
routes (`api/`), and the ruleset spec + worked examples (`schema/`).

This package has no logic of its own -- it exists so `core`/`api`/`schema`
are reachable as `src.prompt_rules.core` / `src.prompt_rules.api` /
`src.prompt_rules.schema` from anywhere else in the pack.
"""
