"""Generate `colab-launcher.md` (and `colab-recovery.md`) from the reference
cell sources next to them.

Why generated rather than hand-written: the markdown is a THIRD copy of code
that already exists twice (`colab_launcher_cells.py` and the
`colab-launcher.html` mockup). A hand-maintained copy drifts the first time
someone edits a cell — so this reads the `.py` and emits the `.md`, and the
`.py` stays the single source of truth. Re-run it after touching a cell:

    python colab/build_colab_md.py

It splits on the source's own markers and needs no metadata beyond them:

  * a CELL boundary: ``# ====== CELL 2 - Backend ======``  (em dash in the file)
  * a section inside a cell: ``# ---- 03 Extra pip ----`` or the longer
    ``# ---------- 03 Extra pip ----------`` style cell 3 uses

Each Colab cell becomes ONE fenced block, deliberately: cells 2 and 3 are meant
to be pasted whole and switched to Form view, and cell 3 depends on names cell 2
defines. The per-cell section list is what makes a 600-line block navigable
without inviting anyone to paste it in pieces.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# Cell ids are alphanumeric, not numeric: the launcher uses `CELL 1..3` and the
# recovery file uses `CELL A`/`CELL B`. Requiring a digit here silently skipped
# the whole recovery file.
CELL_RE = re.compile(r"^#\s*=+\s*CELL\s+([A-Za-z0-9]+)\s*[-—–]\s*(.+?)\s*=+\s*$")
SECTION_RE = re.compile(r"^#\s*-{4,}\s*(.+?)\s*-{4,}\s*$")

SOURCES = [
    # (source cells, generated markdown, title, ready-to-run notebook or None)
    (
        "colab_launcher_cells.py",
        "colab-launcher.md",
        "ComfyUI · Colab launcher",
        "ComfyUI Launcher.ipynb",
    ),
    ("colab_recovery_cells.py", "colab-recovery.md", "ComfyUI · Colab recovery", None),
]


def split_cells(lines: list[str]) -> tuple[list[str], list[dict]]:
    """-> (preamble comment lines, [{number, title, body, sections}])."""
    preamble: list[str] = []
    cells: list[dict] = []
    for raw in lines:
        line = raw.rstrip("\n")
        match = CELL_RE.match(line)
        if match:
            cells.append(
                {"number": match.group(1), "title": match.group(2), "body": [], "sections": []}
            )
            continue
        if not cells:
            preamble.append(line)
            continue
        cell = cells[-1]
        cell["body"].append(line)
        section = SECTION_RE.match(line)
        if section:
            cell["sections"].append(section.group(1))
    return preamble, cells


def trim(body: list[str]) -> list[str]:
    """Drop leading/trailing blank lines so the fence hugs the code."""
    start, end = 0, len(body)
    while start < end and not body[start].strip():
        start += 1
    while end > start and not body[end - 1].strip():
        end -= 1
    return body[start:end]


def render(
    title: str,
    source_name: str,
    preamble: list[str],
    cells: list[dict],
    notebook: str | None = None,
) -> str:
    intro = [ln.lstrip("#").strip() for ln in preamble if ln.startswith("#")]
    intro = [ln for ln in intro if ln and not set(ln) <= {"=", "-"}]
    # The source's banner repeats the title as its first comment line; the H1
    # above already says it, so drop it rather than printing it twice.
    while intro and intro[0].startswith(title):
        intro.pop(0)

    out: list[str] = [f"# {title}", ""]
    out.append(
        f"> **Generated** from [`{source_name}`]({source_name}) by "
        "[`build_colab_md.py`](build_colab_md.py) — edit the `.py`, then re-run "
        "`python colab/build_colab_md.py`. Don't hand-edit this file."
    )
    out.append("")
    if intro:
        out.extend(intro[1:] if intro and intro[0] == title.split(" · ")[-1] else intro)
        out.append("")

    if notebook:
        quoted = notebook.replace(" ", "%20")
        out.append(f"## 👉 Just want to run it? Open [`{notebook}`]({quoted})")
        out.append("")
        out.append(
            f"[`{notebook}`]({quoted}) is the **ready-to-use notebook** — the same three cells, "
            "already assembled. Download it and use *File → Upload notebook* in Colab (or open it "
            "from Drive), then run the cells top to bottom. It ships with **no saved outputs and no "
            "credentials**: the token field is blank and you fill it in yourself."
        )
        out.append("")
        out.append(
            "> **Re-exporting it?** Colab saves the ipywidgets state, your Google account name and "
            "id, and every cell's output into the `.ipynb`. A token typed into a form field lands "
            "in that saved state. **Clear all outputs and strip `metadata.widgets` before "
            "committing** — the first export of this notebook carried a live tunnel token."
        )
        out.append("")
        out.append("The blocks below are the same cells, for reading or copying piecemeal.")
        out.append("")

    out.append("## Cells at a glance")
    out.append("")
    out.append("| # | Cell | Contains |")
    out.append("|---|---|---|")
    for cell in cells:
        inner = ", ".join(cell["sections"]) if cell["sections"] else "—"
        out.append(f"| {cell['number']} | [{cell['title']}](#cell-{cell['number']}) | {inner} |")
    out.append("")
    out.append(
        "**Paste each cell below into its own Colab cell, in order.** They are not "
        "interchangeable: later cells use names earlier ones define, and cells shown "
        "as one block must stay one block."
    )
    out.append("")

    for cell in cells:
        out.append(f'<a id="cell-{cell["number"]}"></a>')
        out.append("")
        out.append(f"## Cell {cell['number']} — {cell['title']}")
        out.append("")
        if cell["sections"]:
            out.append("Sections inside this cell:")
            out.append("")
            for name in cell["sections"]:
                out.append(f"- `{name}`")
            out.append("")
        out.append("```python")
        out.extend(trim(cell["body"]))
        out.append("```")
        out.append("")

    return "\n".join(out).rstrip() + "\n"


def main() -> int:
    written = 0
    for source_name, target_name, title, notebook in SOURCES:
        source = HERE / source_name
        if not source.exists():
            print(f"skip {source_name} (not present)")
            continue
        preamble, cells = split_cells(source.read_text(encoding="utf-8").splitlines(True))
        if not cells:
            print(f"WARNING: no `# ==== CELL n - title ====` markers found in {source_name}")
            continue
        # Only advertise the ready-to-run notebook if it's actually next to us.
        ready = notebook if notebook and (HERE / notebook).exists() else None
        (HERE / target_name).write_text(
            render(title, source_name, preamble, cells, ready), encoding="utf-8"
        )
        inner = sum(len(c["sections"]) for c in cells)
        print(f"wrote {target_name}: {len(cells)} cells, {inner} sections")
        written += 1
    return 0 if written else 1


if __name__ == "__main__":
    raise SystemExit(main())
