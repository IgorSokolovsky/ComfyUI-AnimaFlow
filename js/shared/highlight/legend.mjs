/**
 * legend.mjs — the color legend UI: a compact two-column swatch+label list,
 * built as a `<details class="wtn-collapse">` (the house theme's collapsible
 * component, see `js/shared/theme.css`) so it's COLLAPSED BY DEFAULT — the
 * legend is reference material, and node canvas space is scarce (per the
 * plan). A node places the returned element wherever it wants; this module
 * never mounts itself.
 */

import { SECTIONS } from "./colors.mjs";
import { injectHighlightStyles } from "./overlay.mjs";

/**
 * Builds the legend element. Options:
 *  - `doc` — document to build in (defaults to the global `document`).
 *  - `label` — summary text (default `"Color legend"`).
 *  - `open` — start expanded instead of collapsed (default `false`).
 *
 * Returns `{ root, el, setOpen(bool), destroy() }` (`el` is an alias for
 * `root`, for callers that prefer that name) or `null` if no document is
 * available (headless/no-DOM host).
 */
export function createLegend(options = {}) {
  const { label = "Color legend", open = false } = options;
  const doc = options.doc || (typeof document !== "undefined" ? document : null);
  if (!doc) {
    return null;
  }
  injectHighlightStyles(doc);

  const root = doc.createElement("details");
  root.className = "wtn-hl-legend wtn-collapse wtn";
  if (open) {
    root.setAttribute("open", "");
  }

  const summary = doc.createElement("summary");
  summary.textContent = label;
  root.appendChild(summary);

  const body = doc.createElement("div");
  body.className = "wtn-collapse__bd";

  const grid = doc.createElement("div");
  grid.className = "wtn-hl-legend-grid";
  for (const section of SECTIONS) {
    const item = doc.createElement("div");
    item.className = "wtn-hl-legend-item";

    // Reuses the real token class (`wtn-hl-tok`) + `data-section` so the
    // swatch is styled by the EXACT SAME `colors.mjs`-generated CSS rule a
    // live highlighted tag gets (color, background chip, weight, italic,
    // underline) -- legend and text can never disagree, by construction,
    // rather than by keeping two rule sets in sync by hand. `data-known`
    // pins it to full opacity (a legend swatch isn't "guessing").
    const swatch = doc.createElement("span");
    swatch.className = "wtn-hl-legend-swatch wtn-hl-tok";
    swatch.setAttribute("data-section", section.id);
    swatch.setAttribute("data-known", "true");
    swatch.textContent = "Aa";
    item.appendChild(swatch);

    const text = doc.createElement("span");
    text.className = "wtn-hl-legend-label";
    text.textContent = section.label;
    item.appendChild(text);

    grid.appendChild(item);
  }
  body.appendChild(grid);
  root.appendChild(body);

  function setOpen(next) {
    if (next) {
      root.setAttribute("open", "");
    } else {
      root.removeAttribute("open");
    }
  }

  function destroy() {
    if (root.parentNode) {
      root.parentNode.removeChild(root);
    }
  }

  return { root, el: root, setOpen, destroy };
}
