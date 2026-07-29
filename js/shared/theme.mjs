/**
 * House theme — idempotent stylesheet injector + raw color tokens.
 *
 * Every node UI in this pack shares one palette and one component vocabulary
 * (see docs/THEME.md). `theme.css` holds the actual rules, scoped under a `.wtn`
 * class so nothing leaks into ComfyUI's own DOM; this module just makes sure
 * that stylesheet is on the page exactly once, and exposes the same palette
 * as plain hex strings for JS that needs raw colors (canvas draws, computed
 * styles, etc. — CSS `var(--wtn-*)` isn't usable there).
 *
 * Usage (from any node's index.js / core.mjs):
 *
 *   import { injectTheme, TOKENS } from "./shared/theme.mjs";
 *   // or, from a subfolder two+ levels deep, the absolute cross-folder form:
 *   // import { injectTheme } from "/extensions/<pack>/shared/theme.mjs";
 *
 *   injectTheme();                  // safe to call from every node; runs once
 *   root.classList.add("wtn");      // the widget's DOM root — required for
 *                                   // the `.wtn-*` component classes to apply
 *   root.innerHTML = `<button class="wtn-btn wtn-btn--primary">Apply</button>`;
 *
 * Keep TOKENS in sync with theme.css by hand — theme.css is the CSS source
 * of truth for styling, TOKENS exists only for the handful of call sites
 * that need a raw hex (e.g. drawing on a <canvas>).
 */

/** Injects js/shared/theme.css into <head> once. Safe to call repeatedly. */
export function injectTheme() {
  if (document.getElementById("wtn-theme")) return;
  const link = document.createElement("link");
  link.id = "wtn-theme";
  link.rel = "stylesheet";
  link.href = new URL("./theme.css", import.meta.url).href; // sibling; no build step
  document.head.appendChild(link);
}

/**
 * Raw palette, hex strings — mirrors the `--wtn-*` custom properties in
 * theme.css. For CSS, prefer `var(--wtn-*)` inside a `.wtn`-scoped element;
 * use TOKENS only where a hex string is required (canvas, inline computed
 * values, etc).
 */
export const TOKENS = {
  bg: "#0e1116",
  surface: "#151a21",
  surface2: "#1b212a",
  line: "#28303b",
  lineSoft: "#1f2731",
  ink: "#e7ecf3",
  inkDim: "#93a0b1",
  inkFaint: "#5f6c7d",
  console: "#0a0d12",
  accent: "#2dd4bf",
  accentStrong: "#34e5d2",
  accentDeep: "#14b8a6",
  onAccent: "#062420",
  ok: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  info: "#7dd3fc",
  tmp: "#c4b5fd",
};
