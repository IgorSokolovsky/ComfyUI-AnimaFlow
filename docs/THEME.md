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

Swap any token value in ONE place (`theme.mjs`/`theme.css`) and the whole pack retunes.
