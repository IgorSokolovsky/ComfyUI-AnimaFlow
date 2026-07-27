"""AnimaFlow's supporting library code, grouped by feature.

Each subpackage here is one feature's worth of non-node logic:
`src/prompt_rules/` (the rules engine, its aiohttp routes, and the ruleset
spec + examples) and `src/autocomplete/` (tag dataset, index, classify
service). Nodes (`nodes/`) stay thin and import from here; this package has
no logic of its own.
"""
