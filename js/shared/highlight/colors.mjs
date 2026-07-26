/**
 * colors.mjs — the 16-section color/label table shared by `overlay.mjs`
 * (paints the mirror's `<span data-section="…">`) and `legend.mjs` (draws
 * the swatch list). Single source of truth so the overlay and legend can
 * never disagree about what color a section is.
 *
 * Each entry anchors to a house theme token (`--wtn-warn`, `--wtn-info`, …)
 * where the palette already has a fitting hue, or declares its own new
 * `--wtn-hl-*` custom property (with a hardcoded hex fallback, per the
 * `animaflow-node-theme` skill's `var(--wtn-x, #fallback)` rule) where 16
 * distinct, dark-background-legible categories need more hues than the core
 * palette has. `varName`/`hex` are always paired so `sectionColorVar()`
 * below can emit `var(--wtn-hl-quality, #fbbf24)` regardless of which case
 * it is — the CSS never cares which bucket a section came from.
 */

export const SECTIONS = [
  { id: "quality", label: "Quality", varName: "--wtn-hl-quality", hex: "#fbbf24" },
  { id: "safety", label: "Rating", varName: "--wtn-hl-safety", hex: "#7dd3fc" },
  { id: "year", label: "Year", varName: "--wtn-hl-year", hex: "#2dd4bf" },
  { id: "count", label: "Count", varName: "--wtn-hl-count", hex: "#60a5fa" },
  { id: "character", label: "Character", varName: "--wtn-hl-character", hex: "#f472b6" },
  { id: "artist", label: "Artist", varName: "--wtn-hl-artist", hex: "#c4b5fd" },
  {
    id: "artist_unknown",
    label: "Unregistered artist",
    varName: "--wtn-hl-artist-unknown",
    hex: "#fb923c",
    underline: "dashed",
  },
  { id: "copyright", label: "Copyright", varName: "--wtn-hl-copyright", hex: "#818cf8" },
  { id: "meta", label: "Meta", varName: "--wtn-hl-meta", hex: "#93a0b1" },
  { id: "general", label: "Trained tag", varName: "--wtn-hl-general", hex: "#4ade80" },
  { id: "natural", label: "Natural language", varName: "--wtn-hl-natural", hex: "#cbd5e1" },
  { id: "translation", label: "Translation marker", varName: "--wtn-hl-translation", hex: "#22d3ee" },
  { id: "wildcard", label: "Wildcard", varName: "--wtn-hl-wildcard", hex: "#e879f9" },
  {
    id: "comment",
    label: "Comment",
    varName: "--wtn-hl-comment",
    hex: "#5f6c7d",
    italic: true,
    faint: true,
  },
  { id: "syntax", label: "Syntax error", varName: "--wtn-hl-syntax", hex: "#f87171", underline: "wavy" },
  {
    id: "unknown",
    label: "Unknown",
    varName: "--wtn-hl-unknown",
    hex: "#e7ecf3",
    underline: "dotted",
    faint: true,
  },
];

const SECTIONS_BY_ID = new Map(SECTIONS.map((section) => [section.id, section]));

/** Section metadata for `id`, or the `unknown` entry if `id` isn't one of
 * the 16 (an older/newer backend sending a section this build doesn't know
 * about degrades to the `unknown` treatment rather than losing color info).
 */
export function sectionInfo(id) {
  return SECTIONS_BY_ID.get(id) || SECTIONS_BY_ID.get("unknown");
}

/** The display label for `id` — what the legend and span `title` show. */
export function sectionLabel(id) {
  return sectionInfo(id).label;
}

function underlineRules(style) {
  if (style === "wavy") {
    return "text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: currentColor; text-underline-offset: 2px;";
  }
  if (style === "dashed") {
    return "text-decoration-line: underline; text-decoration-style: dashed; text-decoration-color: currentColor; text-underline-offset: 2px;";
  }
  if (style === "dotted") {
    return "text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: currentColor; text-underline-offset: 2px;";
  }
  return "";
}

/** The `.wtn-hl { --wtn-hl-quality: #fbbf24; … }` custom-property block —
 * declares every section's color as a token, scoped under `.wtn-hl` so this
 * module owns its own namespace independent of whether the host node's
 * `.wtn` house-theme scope is present.
 */
export function sectionVarsCss() {
  const decls = SECTIONS.map((section) => `  ${section.varName}: ${section.hex};`).join("\n");
  return `.wtn-hl {\n${decls}\n}`;
}

/** The per-section `[data-section="…"]` paint rules for `.wtn-hl-tok` spans
 * (color + optional italic/underline/opacity treatment), plus the one
 * cross-cutting `[data-weighted="true"]` boldening rule.
 */
export function sectionTokenCss() {
  const rules = SECTIONS.map((section) => {
    const parts = [`color: var(${section.varName}, ${section.hex});`];
    if (section.italic) parts.push("font-style: italic;");
    if (section.faint) parts.push("opacity: 0.82;");
    const underline = underlineRules(section.underline);
    if (underline) parts.push(underline);
    return `.wtn-hl-tok[data-section="${section.id}"] {\n  ${parts.join("\n  ")}\n}`;
  });
  rules.push('.wtn-hl-tok[data-weighted="true"] {\n  font-weight: 700;\n}');
  return rules.join("\n");
}
