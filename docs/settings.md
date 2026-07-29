# Settings — the **AnimaFlow** section in ComfyUI's Settings dialog

Ten knobs that used to be hardcoded constants (or one env var) live in ComfyUI's own Settings
dialog, under an **AnimaFlow** entry in the sidebar — alongside EasyUseAnima, Pixaroma and Use
Everywhere. Declared in [`js/shared/settings.mjs`](../js/shared/settings.mjs). (Count grows over
time — re-count `ANIMAFLOW_SETTINGS.length` rather than trusting this number.)

| Setting | Id | Type | Default | Reaches |
|---|---|---|---|---|
| Console logging | `AnimaFlow.General.ConsoleLogging` | `off` / `summary` / `debug` | **`off`** | `src/anima/logs.py`, and every per-run line in `pipeline.py` / `preview.py` |
| Wheel quiet period (ms) | `AnimaFlow.Canvas.WheelQuietPeriodMs` | int | 450 | `js/shared/canvas_zoom.mjs` |
| Tooltip delay (ms) | `AnimaFlow.Fields.TooltipDelayMs` | int | 250 | `js/shared/fields.mjs`'s ⓘ |
| Node panel type size (px) | `AnimaFlow.Anima.NodePanelFontSize` | int | 14 | `js/anima/render.mjs`'s `BASE_FONT` **and everything derived from it** |
| Themed node chrome | `AnimaFlow.Theme.NodeChrome` | bool | true | `js/shared/node_chrome.mjs` |
| Keep post-run values across reload | `AnimaFlow.Anima.PersistPostRunValues` | bool | false | the Generator's post-run context report |
| Confirm before removing a row | `AnimaFlow.Controls.ConfirmRemoveRow` | bool | true | the Control Panel's row delete |
| Civitai | `AnimaFlow.Controls.CivitaiEnabled` | bool | **true** | `js/controls/lora_interaction.mjs`/`model_info.mjs` — off hides EVERY network affordance on `AnimaLoraLoader` (the ⓘ panel's lookup status, `↻ Civitai`, `View on Civitai ↗`), not just one button. Already-cached info (notes, trigger words, display name) still displays — it's read via `lookup.py`'s `cached_only` flag, whose cache-miss path is made unreachable to Civitai's network server-side, not merely unused client-side (`lora-loader-design.md` §7b decision 20/§7d) |
| Hide file extension | `AnimaFlow.Controls.HideFileExtension` | bool | false | `js/controls/model_picker.mjs`'s `displayModelName` — strips the extension in the picker's list only; the row's own name label and the underlying file name are unaffected |
| Show preview thumbnails | `AnimaFlow.Controls.ShowPreviewThumbnails` | bool | **true** | `js/controls/model_picker.mjs` (picker thumbnail column) and `model_info.mjs` (ⓘ panel identity thumbnail) |

**The ids are the persistence key, so that namespace is append-only.** Renaming one silently
abandons whatever the user had set. Same discipline as node widget order.

**The LoRA Loader's own ⚙ dialog writes the last three of the above directly** (via
`js/shared/settings.mjs`'s `setSetting`), even though they live in this pack-wide section rather
than the node's own state blob — `docs/lora-loader-design.md` §7b explains the split: memory mode,
trigger-words separator, separate-strengths and per-node strength defaults are genuinely per-node
and live in `lora_state.mjs`'s own state; hiding the extension, showing thumbnails, and the Civitai
switch are user-wide display/posture preferences, so the dialog's own toggles for those three read
and write THIS section instead, immediately, with no separate "apply" step.

## Things that are not obvious

**Console logging defaults to `off`, and that is a deliberate behaviour change.** The per-run lines
(stage status, sampler provenance, model files, the Preview's save/temp routing) were unconditional
when logging first landed. They are genuinely useful — the sampler-provenance line answers "is my
Bridge/UE wire actually driving this field?" from the server with no browser probe — so if you want
them, set this to `summary`. `debug` adds the full 11-field context report and per-stage resolved
sampler dicts. **`ANIMAFLOW_DEBUG` still works and forces `debug`**, which is what headless/API-only
runs should use, since they have no browser to carry a setting.

**A frontend setting reaching Python is not automatic.** The logging level is the only one that has
to, and it does it *without* a custom route: `src/anima/frontend_settings.py` reads ComfyUI's own
persisted `user/default/comfy.settings.json`, cached by mtime. That choice matters — it survives a
server restart, and it still works for an API-only run with no browser attached, which an
`onChange`-posts-to-our-route design would not. Missing, unreadable or malformed file all degrade to
the documented default; it never raises.

**Node panel type size needs a page refresh**, and its tooltip says so. The CSS is built once per
page and the scale is applied atomically at that point, because the value drives not just
`font-size` but row heights, `SHEAD_H`, and the `PANEL_MIN_H` / `PREVIEW_*_MIN_H` floors. Applying it
live would mean re-deriving all of them mid-session; half-applying it would crowd rows and clip text.
(Wiring this up surfaced a real pre-existing bug: three CSS floors carried hardcoded `256`/`284`/`188`
literals that were never actually wired to the exported constants they were supposed to mirror, so
the CSS and the JS could drift silently. They're derived now.)

**Keep post-run values across reload is off for a reason.** The report is normally in-memory only, so
it dies with the page — deliberately, because it describes *one run's* wiring. Turning this on
persists it to `node.properties` (never the settings blob — it is run output, not settings) so it
survives a reload, at the cost of possibly showing values from a run whose wiring no longer applies.

**No sixth auto-loaded `.js`.** ComfyUI auto-loads every `.js` under `WEB_DIRECTORY`, and
[`.claude/CLAUDE.md`](../.claude/CLAUDE.md) caps this pack at 5. The settings are therefore declared
in a `.mjs` behind a register-once guard, imported by the entry points that already exist. Adding
`js/settings/index.js` would have been the obvious shape and would have broken that budget.
