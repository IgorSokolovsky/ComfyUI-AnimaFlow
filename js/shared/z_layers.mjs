/**
 * z_layers.mjs — the ONE named z-index scale every fixed-position surface in
 * this pack reads from, instead of each file hand-picking its own literal.
 *
 * ## Why this exists (owner-reported, 2026-08-01)
 *
 * The delete confirmation dialog rendered BEHIND the ⓘ info panel that
 * opened it — its warning line was clipped and the Cancel button was
 * unreachable, the worst thing a destructive-action confirm can do. Root
 * cause: `overlay.mjs`'s anchored panels set `z-index: 10020` inline, while
 * `delete_confirm.mjs`'s own scrim CSS said `10001` — nothing tied the two
 * numbers together at all, so whichever file happened to pick the bigger one
 * won. That was already the FOURTH hand-picked value across three files with
 * no shared ordering (`.wtn-tip`'s `999` in `theme.css`, `10020` inline in
 * `overlay.mjs`, `10001` in `delete_confirm.mjs`, the Rule Builder's own
 * `10000`) — exactly how they ended up inverted.
 *
 * Raising `10001` to some bigger number would only win until the next
 * surface picks a bigger one still. This module is the actual fix: a SCALE,
 * not a bump, so the next surface that needs a layer picks a NAME, never a
 * number, and the required ordering is enforced in exactly one place.
 *
 * **Required ordering (owner):** tooltip < anchored overlay/panel < full
 * modal < confirmation dialog. A confirmation must sit above everything it
 * can be launched from — today the ⓘ panel and the search panel, later the
 * browser modal too.
 *
 * ## Plain integers, not CSS custom properties
 *
 * Every real caller in this scope sets `z-index` from a JS string — either a
 * CSS-in-JS template literal (`delete_confirm.mjs`, `civitai_modal.mjs`,
 * `fields.mjs`, `lora_render.mjs`, `render.mjs`) or a direct inline-style
 * assignment (`overlay.mjs`'s own `overlay.style.zIndex`) — and a plain-`node`
 * test needs the same numbers with no browser/CSS engine around to resolve a
 * `var()` against. `theme.css` mirrors these same numbers as its own
 * `--wtn-z-*` custom properties (for `.wtn-tip`, the one rule in that file
 * that needs one), kept in sync BY HAND — the same "CSS is the source of
 * truth for styling, this module exists only for the call sites that need a
 * raw value" convention `theme.mjs`'s own `TOKENS` already documents for
 * colour.
 *
 * Steps of 10 (not 1) between rungs, matching this pack's existing
 * convention for this exact number range (`10000`/`10020` were already
 * spaced that way before this module existed) — headroom for a future rung
 * without renumbering everything else.
 */

export const Z_TOOLTIP = 10000;
/** Anchored overlay/popover panel (`overlay.mjs`'s own `openOverlay`, and
 * every `.wtn-ctl-overlay` it backs in `js/controls/render.mjs`/
 * `lora_render.mjs`) — the ⓘ panel, the search panel, option lists, ⚙
 * popovers, row context menus, the picker: every popover/menu this pack ever
 * opens through `openOverlay`/`openOverlayWithZoom`. */
export const Z_PANEL = 10010;
/** Full-bleed scrim modal (`civitai_modal.mjs`'s own Browse Civitai modal). */
export const Z_MODAL = 10020;
/** The type-to-confirm delete dialog (`delete_confirm.mjs`) — must outrank
 * every layer above, since it can be launched from inside either an anchored
 * panel (`Z_PANEL`) or, later, the browser modal (`Z_MODAL`). */
export const Z_CONFIRM = 10030;

/**
 * `js/shared/fields.mjs`'s own field-row ⓘ tooltip (`.wtn-tip.wtn-fld-tip`)
 * is a genuine, pre-existing exception to the plain tooltip tier above: it
 * renders INSIDE an already-open anchored panel (a LoRA row or an Anima
 * section, both `Z_PANEL`), so it must outrank that panel's own layer to
 * avoid being clipped underneath its own container — the exact reasoning
 * that CSS rule has carried since before this scale existed (it used to say
 * so directly against the literal `10020`).
 *
 * `Z_MODAL` is reused here rather than inventing a fifth named tier: this
 * tooltip is never nested inside an actual full-bleed modal (`fields.mjs`
 * has no caller in that context today — only `js/anima/render.mjs` and
 * `js/controls/lora_render.mjs`, neither of which ever mounts inside
 * `civitai_modal.mjs`), so borrowing that tier's value introduces no real
 * collision, and every value in this module still maps back to one of the
 * four required rungs rather than a fifth invented one.
 */
export const Z_ELEVATED_TOOLTIP = Z_MODAL;
