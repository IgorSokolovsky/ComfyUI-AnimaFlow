"""Resolution logic for the Prompt Rules encode nodes (`nodes/prompt_rules/prompt_rules.py`).

Pure(ish) logic split out per the project's node + `_helpers.py` convention so
it stays testable without ComfyUI (see `test_prompt_rules.py`). Everything
here that touches the engine goes through `core`'s public API only (`parse`,
`render`, `apply_ruleset`, `load_profile`, `RulesetError`) -- no reaching into
`core` internals.

Responsibilities (contract: docs/nodes-and-api.md §1/§4):
  - Discover/load `rules/*.yaml` "sheets".
  - Resolve the node's `sheets` selector (`"*"` = all, else an ordered comma
    list) to an ordered list of ruleset sources.
  - Append the node's `embedded_rules` (a JSON-serialized ruleset string,
    authored via the Rule Builder overlay) after the file sheets.
  - Run the resolved rulesets, in order, through `core.apply_ruleset` against
    the SAME parsed bundle (so later rulesets see earlier ones' edits).
  - Render the result back to text, print the trace when asked, and expose a
    `sheet_digests` helper the nodes' `IS_CHANGED` uses for cache-busting on
    file edits.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import List, Optional, Tuple

import yaml

try:  # pragma: no cover - exercised implicitly by whichever context imports us
    # Real ComfyUI context: this module lives two package levels below this
    # custom-node pack's top-level package (`nodes/prompt_rules/` -> pack
    # root), so a relative import up to the pack's own `src.prompt_rules.core`
    # is correct here (a bare `import core` would only resolve if the pack's
    # parent dir -- not the pack root -- were on `sys.path`, which it isn't).
    from ...src.prompt_rules import core  # type: ignore
except ImportError:
    # Standalone context (plain-script tests, run from the repo root with the
    # repo root on `sys.path`): no parent package to relate to, so fall back
    # to the bare import the project's other `test_*.py` scripts rely on --
    # `core` now lives under `src/prompt_rules/core`, so the bare form is
    # `src.prompt_rules.core`, bound to the same local name `core` used below.
    from src.prompt_rules import core

# ---------------------------------------------------------------------------
# Sheets directory
# ---------------------------------------------------------------------------

RULES_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "rules"
)

_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# Node `profile` combo choices, exactly as enumerated by the contract
# (docs/nodes-and-api.md §1/§2). Kept as a literal list rather than reaching
# into `core.profiles`'s internals -- `core.load_profile` is the public API
# and will raise a clear `KeyError` if one of these ever falls out of sync.
PROFILE_CHOICES: List[str] = ["anima", "illustrious", "flux", "raw"]


def _safe_name(name: str) -> str:
    """Guard against path traversal / invalid sheet names."""
    name = (name or "").strip()
    if not name or not _NAME_RE.match(name):
        raise ValueError(f"invalid sheet name: {name!r}")
    return name


def sheet_path(name: str) -> str:
    return os.path.join(RULES_DIR, f"{_safe_name(name)}.yaml")


def list_sheet_names() -> List[str]:
    """Every `rules/*.yaml` sheet, sorted by filename (stem, no extension)."""
    if not os.path.isdir(RULES_DIR):
        return []
    names = []
    for fname in os.listdir(RULES_DIR):
        if fname.endswith((".yaml", ".yml")):
            names.append(os.path.splitext(fname)[0])
    return sorted(names)


def load_sheet_file(name: str) -> dict:
    """Load and parse one `rules/<name>.yaml` sheet. Raises `FileNotFoundError`
    / `yaml.YAMLError` on failure -- callers decide how to surface that.
    """
    path = sheet_path(name)
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        raise ValueError(f"{name}.yaml did not parse to a mapping")
    return data


def sheet_metadata(name: str) -> dict:
    """`{name, character?, rules, mtime, size}` for the `/wtn/rules/sheets` route."""
    path = sheet_path(name)
    st = os.stat(path)
    try:
        data = load_sheet_file(name)
    except (OSError, yaml.YAMLError, ValueError):
        data = {}
    rules = data.get("rules") if isinstance(data, dict) else None
    meta = {
        "name": name,
        "rules": len(rules) if isinstance(rules, list) else 0,
        "mtime": st.st_mtime,
        "size": st.st_size,
    }
    character = _guess_character(data)
    if character:
        meta["character"] = character
    return meta


def _guess_character(ruleset: dict) -> Optional[str]:
    """Best-effort character-name guess from a sheet's rules (used for both
    `/sheets` metadata and `/characters`). Looks for a top-level `group` rule
    whose `into` addresses a `character:<name>` container.
    """
    if not isinstance(ruleset, dict):
        return None
    for rule in ruleset.get("rules") or []:
        if not isinstance(rule, dict):
            continue
        into = rule.get("into")
        if isinstance(into, str) and into.startswith("character:"):
            return into.split(":", 1)[1]
    return None


def list_sheets_metadata() -> List[dict]:
    return [sheet_metadata(name) for name in list_sheet_names()]


# ---------------------------------------------------------------------------
# Selection (`sheets` widget: "*" = all, else an ordered comma list)
# ---------------------------------------------------------------------------

def resolve_sheet_selection(sheets: Optional[str]) -> List[str]:
    """`"*"` (or `None`, the node widget's default) = all sheets, sorted.
    An explicit empty string means "no file sheets" (used by `/preview` when
    the caller passes an empty `sheets` array -- distinct from the `"*"`
    default). Anything else is an ordered, comma-separated name list.
    """
    if sheets is None:
        return list_sheet_names()
    selection = sheets.strip()
    if selection == "*":
        return list_sheet_names()
    if selection == "":
        return []
    return [s.strip() for s in selection.split(",") if s.strip()]


def sheet_digests(sheets: Optional[str]) -> str:
    """A stable `name:mtime:size` string per selected sheet, for `IS_CHANGED`
    (mtime+size so an edited sheet on disk hot-reloads without needing a
    content hash of every file).
    """
    parts = []
    for name in resolve_sheet_selection(sheets):
        try:
            st = os.stat(sheet_path(name))
            parts.append(f"{name}:{st.st_mtime}:{st.st_size}")
        except (OSError, ValueError):
            parts.append(f"{name}:missing")
    return "|".join(parts)


# ---------------------------------------------------------------------------
# Ruleset resolution: file sheets (in order) -> embedded_rules
# ---------------------------------------------------------------------------

def load_rulesets(sheets: Optional[str], embedded_rules: Optional[str] = "") -> Tuple[List[Tuple[str, dict]], List[dict]]:
    """Resolve `sheets` + `embedded_rules` to an ordered list of
    `(source_label, ruleset_dict)` pairs, plus any `{path, message}` load
    errors (missing file / bad YAML / bad embedded JSON) collected along
    the way -- resolution keeps going past a bad sheet rather than aborting.
    """
    rulesets: List[Tuple[str, dict]] = []
    errors: List[dict] = []

    for name in resolve_sheet_selection(sheets):
        source = f"{name}.yaml"
        try:
            rulesets.append((source, load_sheet_file(name)))
        except FileNotFoundError:
            errors.append({"path": source, "message": f"sheet '{name}' not found in rules/"})
        except (yaml.YAMLError, ValueError) as exc:
            errors.append({"path": source, "message": str(exc)})

    embedded_rules = (embedded_rules or "").strip()
    if embedded_rules:
        try:
            data = json.loads(embedded_rules)
        except json.JSONDecodeError as exc:
            errors.append({"path": "embedded_rules", "message": f"invalid JSON: {exc}"})
            data = None
        if isinstance(data, dict):
            rulesets.append(("embedded_rules", data))
        elif data is not None:
            errors.append({"path": "embedded_rules", "message": "embedded ruleset must be an object"})

    return rulesets, errors


# ---------------------------------------------------------------------------
# Run: parse -> apply each resolved ruleset in order -> render
# ---------------------------------------------------------------------------

def apply_rulesets(
    positive_text: str,
    negative_text: str,
    profile: str,
    sheets: Optional[str] = "*",
    embedded_rules: Optional[str] = "",
) -> Tuple[str, str, list, List[dict]]:
    """Parse `positive`/`negative`, apply every resolved ruleset in order to
    the SAME bundle, render back out. Returns
    `(positive_text, negative_text, trace, errors)`.

    A ruleset that fails validation (`core.RulesetError`) is skipped (its
    error recorded) rather than aborting the whole run, so one bad sheet
    doesn't blank out the node's output.
    """
    prof = core.load_profile(profile)
    bundle = {
        "positive": core.parse(positive_text or "", prof),
        "negative": core.parse(negative_text or "", prof),
    }

    rulesets, errors = load_rulesets(sheets, embedded_rules)
    trace: list = []

    for source, ruleset_dict in rulesets:
        trace.append({"depth": 0, "kind": "anchor", "text": f"— {source} —"})
        try:
            result = core.apply_ruleset(bundle, ruleset_dict, prof)
        except core.RulesetError as exc:
            errors.append({"path": source, "message": str(exc)})
            trace.append({"depth": 1, "kind": "skip", "text": f"x {source}: {exc}"})
            continue
        bundle = {"positive": result["positive"], "negative": result["negative"]}
        trace.extend(result["trace"])

    positive_out = core.render(bundle["positive"], prof)
    negative_out = core.render(bundle["negative"], prof)
    return positive_out, negative_out, trace, errors


def run_rules(
    positive_text: str,
    negative_text: str,
    profile: str,
    sheets: Optional[str] = "*",
    embedded_rules: Optional[str] = "",
    log_trace: bool = True,
) -> Tuple[str, str, list]:
    """Node-facing entry point (contract §1 FUNCTION `process`): resolve +
    run, print the trace when `log_trace`, return `(positive, negative, trace)`.
    """
    positive_out, negative_out, trace, errors = apply_rulesets(
        positive_text, negative_text, profile, sheets, embedded_rules,
    )
    for err in errors:
        trace.append({"depth": 0, "kind": "skip", "text": f"x error at {err['path']}: {err['message']}"})
    if log_trace:
        print(core.format_trace(trace))
    return positive_out, negative_out, trace


# ---------------------------------------------------------------------------
# IS_CHANGED
# ---------------------------------------------------------------------------

def is_changed_digest(
    positive: str,
    negative: str,
    profile: str,
    sheets: Optional[str] = "*",
    embedded_rules: Optional[str] = "",
) -> str:
    """`sha256(positive + negative + profile + selected-sheet digests +
    embedded_rules)` (contract §1 `IS_CHANGED`) -- re-encode only on a real
    change, free hot-reload of edited sheets via `sheet_digests`'s mtime+size.
    """
    payload = "\x1f".join([
        positive or "",
        negative or "",
        profile or "",
        sheet_digests(sheets),
        embedded_rules or "",
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
