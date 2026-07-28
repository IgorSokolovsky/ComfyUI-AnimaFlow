# House Theme — node-pack design system

One palette + one component vocabulary shared by **every** node UI in this pack
(overlays like the Rule Builder, picker popovers, and in-node DOM widgets). Derived
from the Colab launcher's dark-slate + teal look, tuned to sit over ComfyUI's dark
canvas.

- **Single source of truth:** `js/shared/theme.mjs` injects the stylesheet once
  (idempotent, `<style id="wtn-theme">`); `js/shared/theme.css` is the same CSS for
  reference/playground. Tokens + components live under a **`.wtn` namespace class** so
  we never clobber ComfyUI globals — every widget root gets `class="wtn …"`.
- **Preview / approval + living reference:** `playground/theme.html`.
- **Dark-committed.** ComfyUI's canvas is dark; a light variant is out of scope. This
  is a deliberate single-world choice, not an omission.

---

## Tokens

Defined on `.wtn`; components read them via `var(--wtn-*)`.

### Color — surfaces & ink
| Token | Hex | Use |
|---|---|---|
| `--wtn-bg` | `#0e1116` | deepest ground (overlay backdrop) |
| `--wtn-surface` | `#151a21` | panels, cards |
| `--wtn-surface-2` | `#1b212a` | raised (card headers, inputs' chrome) |
| `--wtn-line` | `#28303b` | borders, dividers |
| `--wtn-line-soft` | `#1f2731` | inner hairlines |
| `--wtn-ink` | `#e7ecf3` | primary text |
| `--wtn-ink-dim` | `#93a0b1` | secondary text, labels |
| `--wtn-ink-faint` | `#5f6c7d` | placeholders, disabled, idle |
| `--wtn-console` | `#0a0d12` | log/console/input backgrounds |

### Color — brand accent (teal)
| Token | Hex | Use |
|---|---|---|
| `--wtn-accent` | `#2dd4bf` | primary accent, focus, active |
| `--wtn-accent-strong` | `#34e5d2` | accent hover |
| `--wtn-accent-deep` | `#14b8a6` | gradients, pressed |
| `--wtn-on-accent` | `#062420` | text/icon on an accent fill |

### Color — semantic (functional; NOT the accent)
| Token | Hex | Use |
|---|---|---|
| `--wtn-ok` | `#4ade80` | success, "add", running |
| `--wtn-warn` | `#fbbf24` | warning, "set"/anchor |
| `--wtn-bad` | `#f87171` | error, "remove", stop |
| `--wtn-info` | `#7dd3fc` | info, conditions |
| `--wtn-tmp` | `#c4b5fd` | temporary/violet accents |

> Semantic hues are separate from the brand accent on purpose — teal never means
> "success". This keeps state (good/warn/bad) legible independent of branding.

### Shape · space · type
| Token | Value |
|---|---|
| `--wtn-radius` / `-sm` / `-lg` | `10px` / `7px` / `13px` |
| `--wtn-shadow` | `0 10px 28px rgba(0,0,0,.55)` |
| `--wtn-font-ui` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| `--wtn-font-mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace` |
| type scale | `11` (micro-label) · `12.5` (data) · `13` (body) · `15` (title) · `17` (h1) |

No webfonts (CSP-safe / offline in ComfyUI) — strong system stacks only. **Mono is the
data face**: prompt text, values, logs, YAML, the trace. UI face for chrome/labels.

---

## Components (class vocabulary)

All prefixed `wtn-`, all under a `.wtn` root.

- **Buttons** — `.wtn-btn` + `--primary` (teal fill), `--ghost` (outline), `--danger`
  (red outline), `--icon` (borderless). Disabled dims via tokens.
- **Inputs** — `.wtn-input` (text), `.wtn-select`, `.wtn-textarea`: console bg, mono,
  teal focus ring.
- **Card** — `.wtn-card` › `.wtn-card__hd` (raised, title + right-aligned meta) ›
  `.wtn-card__bd`.
- **Collapse** — `.wtn-collapse` (a styled `<details>`): teal chevron, instant native
  toggle (no kernel/round-trip cost — same inline-onclick lesson from the launcher).
- **Segmented toggle** — `.wtn-seg` with `[aria-pressed]` buttons (profile switches).
- **Chips** — `.wtn-chip` + semantic `--ok/--warn/--bad/--info` (op/state tags).
- **Status pill** — `.wtn-pill[data-state]` with an LED dot: `idle/starting/running/
  error` → faint/warn/ok/bad.
- **Log / trace console** — `.wtn-log` (console bg, mono, column-reverse auto-pin);
  line classes `.is-ok .is-bad .is-warn .is-head .is-dim .is-accent`.
- **Tooltip** — `.wtn-tip` (fixed, `pointer-events:none`, teal `<b>` emphasis).
- **Label** — `.wtn-label` (uppercase mono micro-label, letter-spaced).

---

## Using it in a node

```js
import { injectTheme } from "/extensions/<pack>/shared/theme.mjs";
injectTheme();                     // idempotent; safe to call from every node
root.classList.add("wtn");         // the widget's DOM root
root.innerHTML = `<button class="wtn-btn wtn-btn--primary">Apply</button>`;
```

**"Better for ComfyUI" notes**
- Overlays (Rule Builder, pickers) use `--wtn-bg` as a scrim + `--wtn-surface` panels →
  reads as a native-but-branded layer over the canvas.
- In-node DOM widgets: keep to `--wtn-surface`/`--wtn-line`; avoid full-bleed `--wtn-bg`
  so the widget still feels like it belongs to the ComfyUI node body.
- Respect `prefers-reduced-motion`; keep focus rings visible (`--wtn-accent`).
- Everything is scoped to `.wtn` — no bare `:root`, no element selectors that leak into
  ComfyUI's own DOM.
- **`theme.css`'s box-sizing reset is `.wtn *` — it does NOT cover the `.wtn` element itself.**
  Harmless for a node body (each node's own CSS resets its root explicitly, e.g.
  `.wtn-an-root, .wtn-an-root *`), but a *popover* mounts on `document.body` with `class="… wtn"`
  and is therefore the one place with no ancestor rule to catch it. A fixed `width:` on such a
  root is then **content-box**, so its own padding pushes children past the edge and
  `overflow: auto` silently clips them — it reads as "the menu is cut", not as a sizing bug.
  Declare `box-sizing: border-box` on any popover/overlay root you give an explicit width
  (`js/anima/render.mjs`'s `.wtn-an-pop` is the worked example).
- **Anything you mount on `document.body` must carry the `wtn` class ITSELF, and its own rule needs
  a specificity bump.** Two separate traps, one victim (popovers, tooltips, overlays — everything
  that escapes the node's subtree to avoid being clipped):
  1. The tokens live on `.wtn`, so an element outside every `.wtn` subtree resolves
     `var(--wtn-console)` to *nothing*. Most component rules here are written
     `var(--wtn-x, #hex)` and survive that; **`theme.css`'s own `.wtn-tip` is not** — it has no
     fallbacks, so its properties compute to `unset`: transparent background, inherited text
     colour, initial border.
  2. `injectTheme()` arrives via an **async dynamic `import()`**, so `theme.css` lands *after* a
     module's own injected `<style>`. At equal specificity the later sheet wins — so a bare
     `.wtn-my-tip` rule loses to `.wtn-tip` even though yours is the specific one, and you also
     inherit `.wtn-tip`'s `z-index: 999` (below this pack's own overlays at 10020).

  Fix both at once: put `wtn` in the element's class list, and write your rule as the two-class
  compound (`.wtn-tip.wtn-fld-tip`, 0-2-0) rather than the single class.
  `js/shared/fields.mjs`'s ⓘ tooltip is the worked example. **This class of bug is invisible to a
  headless suite** — the DOM is correct, only the cascade is wrong — so assert the selector shape
  and the class list in a test, as `js/anima/test_resize.mjs` now does.

Swap any token value in ONE place (`theme.mjs`/`theme.css`) and the whole pack retunes.
