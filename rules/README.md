# `rules/` — character-sheet files

Each `*.yaml` in this directory is a **Ruleset** (`prompt-rules/SCHEMA.md`) --
a "sheet" the Prompt Rules encode nodes can apply to a prompt. They're
authored/edited via the Rule Builder overlay (`js/rule_builder/`, `POST/GET
/wtn/rules/sheet`) or by hand.

- File name (sans `.yaml`) is the sheet's `name`, e.g. `rules/celica.yaml` ->
  `"celica"`.
- A node's `sheets` widget selects which sheets to apply, in order:
  `"*"` (default) = all sheets in this directory, sorted by filename;
  otherwise a comma-separated, ORDER-PRESERVING list of names (e.g.
  `"celica, scene"`).
- Selected sheets are applied in that order, then the node's own
  `embedded_rules` (a workflow-local ruleset authored in the builder, not a
  file) is applied last -- see `docs/nodes-and-api.md` §1 "Resolution order".
- `celica.yaml` is a working sample (anima/labelled-prose profile): groups an
  activation word (`celica`) into a `character:celica` block, sets
  appearance/clothes, and adds a negative quality guard. See
  `prompt-rules/examples/celica.anima.yaml` for the annotated original this
  was adapted from, and `test_prompt_rules.py` for how it's exercised.
