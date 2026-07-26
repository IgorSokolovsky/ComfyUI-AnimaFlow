/**
 * colors.mjs — the 16-section color/background/weight/label table shared by
 * `overlay.mjs` (paints the mirror's `<span data-section="…">`) and
 * `legend.mjs` (draws the swatch list, styled with the SAME `.wtn-hl-tok`
 * rule this module emits — see that file). Single source of truth so the
 * overlay and legend can never disagree about what a section looks like.
 *
 * Each entry anchors to a house theme token (`--wtn-warn`, `--wtn-info`, …)
 * where the palette already has a fitting hue, or declares its own new
 * `--wtn-hl-*` custom property (with a hardcoded hex/rgba fallback, per the
 * `animaflow-node-theme` skill's `var(--wtn-x, #fallback)` rule) where 16
 * distinct, dark-background-legible categories need more hues than the core
 * palette has.
 *
 * The color + background + weight values are adopted, with attribution, from
 * `../ComfyUI-EasyUseAnima/web/js/prompt_studio/constants.js`'s
 * `SECTION_STYLES` table (MIT © n0va39) — chosen deliberately over inventing
 * our own, since that table is what makes the reference pack's highlighting
 * screenshot-readable (a translucent background CHIP behind the tag, not
 * just colored text). Two sections there intentionally share a hue
 * (`artist_unknown`/`syntax` both `#f87171`; `natural`/`unknown` both
 * `#cbd5e1`) and are told apart by background/underline instead — kept as-is
 * here rather than inventing a 17th/18th hue the reference doesn't have.
 *
 * VERIFY-IN-COMFYUI: per-section `font-weight` (700/600/400 above) is
 * applied PER SPAN inside the mirror, while `overlay.mjs`'s `METRIC_PROPERTIES`
 * copies the REAL textarea's single (uniform) `fontWeight` onto the mirror
 * element itself -- a mismatch would make the mirror's wrapped-line width
 * drift out from under the real, transparent caret exactly the way an
 * incomplete metric copy does (see `overlay.mjs`'s docstring). This is safe
 * ONLY because every textarea this module has ever been wired to
 * (`js/anima_prompt/prompt_rules/render.mjs`'s `.wtn-pr-textarea`, and
 * `js/anima_prompt/anima_prompt_studio/render.mjs`'s equivalent) uses
 * `var(--wtn-font-mono, monospace)` -- a genuinely fixed-pitch font stack
 * (SF Mono/Menlo/Consolas/ui-monospace), where by definition bold and
 * regular share the same glyph advance width (that invariant is the whole
 * point of a monospace/terminal font family). If this module is ever wired
 * to a PROPORTIONAL font, this assumption breaks and per-section weight
 * would need to be dropped for that textarea -- headless tests can't catch
 * this (no real font metrics), so it needs a live-ComfyUI screenshot check
 * (type a long, weight-mixed line and confirm the caret still lands under
 * the right character) whenever a NEW font family is introduced here.
 */

export const SECTIONS = [
  {
    id: "quality",
    label: "Quality",
    varName: "--wtn-hl-quality",
    hex: "#facc15",
    bgVarName: "--wtn-hl-quality-bg",
    bg: "rgba(202, 138, 4, 0.18)",
    weight: 700,
  },
  {
    id: "safety",
    label: "Rating",
    varName: "--wtn-hl-safety",
    hex: "#38bdf8",
    bgVarName: "--wtn-hl-safety-bg",
    bg: "rgba(2, 132, 199, 0.18)",
    weight: 600,
  },
  {
    id: "year",
    label: "Year",
    varName: "--wtn-hl-year",
    hex: "#2dd4bf",
    bgVarName: "--wtn-hl-year-bg",
    bg: "rgba(13, 148, 136, 0.18)",
    weight: 600,
  },
  {
    id: "count",
    label: "Count",
    varName: "--wtn-hl-count",
    hex: "#60a5fa",
    bgVarName: "--wtn-hl-count-bg",
    bg: "rgba(37, 99, 235, 0.18)",
    weight: 700,
  },
  {
    id: "character",
    label: "Character",
    varName: "--wtn-hl-character",
    hex: "#f472b6",
    bgVarName: "--wtn-hl-character-bg",
    bg: "rgba(219, 39, 119, 0.18)",
    weight: 700,
  },
  {
    id: "artist",
    label: "Artist",
    varName: "--wtn-hl-artist",
    hex: "#a78bfa",
    bgVarName: "--wtn-hl-artist-bg",
    bg: "rgba(124, 58, 237, 0.18)",
    weight: 700,
  },
  {
    id: "artist_unknown",
    label: "Unregistered artist",
    varName: "--wtn-hl-artist-unknown",
    hex: "#f87171",
    bg: null, // transparent -- told apart from `artist` by the underline, not a chip
    weight: 400,
    underline: "solid",
  },
  {
    id: "copyright",
    label: "Copyright",
    varName: "--wtn-hl-copyright",
    hex: "#fb923c",
    bgVarName: "--wtn-hl-copyright-bg",
    bg: "rgba(234, 88, 12, 0.18)",
    weight: 700,
  },
  {
    id: "meta",
    label: "Meta",
    varName: "--wtn-hl-meta",
    hex: "#94a3b8",
    bgVarName: "--wtn-hl-meta-bg",
    bg: "rgba(100, 116, 139, 0.18)",
    weight: 600,
  },
  {
    id: "general",
    label: "Trained tag",
    varName: "--wtn-hl-general",
    hex: "#4ade80",
    bgVarName: "--wtn-hl-general-bg",
    bg: "rgba(22, 163, 74, 0.16)",
    weight: 600,
  },
  {
    id: "natural",
    label: "Natural language",
    varName: "--wtn-hl-natural",
    hex: "#cbd5e1",
    bgVarName: "--wtn-hl-natural-bg",
    bg: "rgba(71, 85, 105, 0.16)",
    weight: 400,
  },
  {
    id: "translation",
    label: "Translation marker",
    varName: "--wtn-hl-translation",
    hex: "#22d3ee",
    bgVarName: "--wtn-hl-translation-bg",
    bg: "rgba(8, 145, 178, 0.22)",
    weight: 700,
  },
  {
    id: "wildcard",
    label: "Wildcard",
    varName: "--wtn-hl-wildcard",
    hex: "#c084fc",
    bgVarName: "--wtn-hl-wildcard-bg",
    bg: "rgba(126, 34, 206, 0.24)",
    weight: 700,
  },
  {
    id: "comment",
    label: "Comment",
    varName: "--wtn-hl-comment",
    hex: "#9ca3af",
    bgVarName: "--wtn-hl-comment-bg",
    bg: "rgba(156, 163, 175, 0.14)",
    weight: 400,
    italic: true,
  },
  {
    id: "syntax",
    label: "Syntax error",
    varName: "--wtn-hl-syntax",
    hex: "#f87171",
    bg: null, // transparent -- shares its hue with `artist_unknown`, told apart
    // by this wavy underline (and by context: syntax markers vs. a bare tag).
    weight: 400,
    underline: "wavy",
    underlineColor: "#ef4444",
  },
  {
    id: "unknown",
    label: "Unknown",
    varName: "--wtn-hl-unknown",
    hex: "#cbd5e1",
    bg: null, // transparent -- shares its hue with `natural` on purpose (an
    // unclassified run reads like plain prose until the backend says otherwise)
    weight: 400,
    underline: "solid",
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

function underlineRules(style, color) {
  if (!style) {
    return "";
  }
  const decorationColor = color || "currentColor";
  return `text-decoration-line: underline; text-decoration-style: ${style}; text-decoration-color: ${decorationColor}; text-underline-offset: 2px;`;
}

/** The `.wtn-hl { --wtn-hl-quality: #facc15; --wtn-hl-quality-bg: rgba(…); … }`
 * custom-property block — declares every section's foreground color (and,
 * where it has a background chip, that too) as a token, scoped under
 * `.wtn-hl` so this module owns its own namespace independent of whether the
 * host node's `.wtn` house-theme scope is present.
 */
export function sectionVarsCss() {
  const decls = [];
  for (const section of SECTIONS) {
    decls.push(`  ${section.varName}: ${section.hex};`);
    if (section.bg) {
      decls.push(`  ${section.bgVarName}: ${section.bg};`);
    }
  }
  return `.wtn-hl {\n${decls.join("\n")}\n}`;
}

/**
 * The per-section `[data-section="…"]` paint rules for `.wtn-hl-tok` spans
 * (color + font-weight + optional background chip / italic / underline),
 * plus the cross-cutting rules that don't vary by section:
 *  - `[data-weighted="true"]` — a `(tag:1.2)` weighted token is always
 *    boldened on top of its section's own weight (an emphasis cue, not a
 *    color category).
 *  - opacity — adopted from the reference's `tokenStyle()`: `1` for a
 *    DB-known token (`data-known="true"`) and for the `count` section
 *    (always exact, never a guess), `0.88` otherwise. A three-rule cascade
 *    (`.wtn-hl-tok` base, then the two same-specificity overrides) rather
 *    than a single ternary, since CSS has no "or" — either override alone
 *    is sufficient to win back to full opacity.
 */
export function sectionTokenCss() {
  const rules = SECTIONS.map((section) => {
    const parts = [`color: var(${section.varName}, ${section.hex});`, `font-weight: ${section.weight};`];
    if (section.bg) {
      parts.push(`background: var(${section.bgVarName}, ${section.bg});`);
      parts.push("border-radius: 3px;");
    }
    if (section.italic) {
      parts.push("font-style: italic;");
    }
    const underline = underlineRules(section.underline, section.underlineColor);
    if (underline) {
      parts.push(underline);
    }
    return `.wtn-hl-tok[data-section="${section.id}"] {\n  ${parts.join("\n  ")}\n}`;
  });
  rules.push('.wtn-hl-tok[data-weighted="true"] {\n  font-weight: 700;\n}');
  rules.push(".wtn-hl-tok {\n  opacity: 0.88;\n}");
  rules.push('.wtn-hl-tok[data-known="true"] {\n  opacity: 1;\n}');
  rules.push('.wtn-hl-tok[data-section="count"] {\n  opacity: 1;\n}');
  return rules.join("\n");
}
