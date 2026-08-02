# Settings — the **AnimaFlow** section in ComfyUI's Settings dialog

Eighteen knobs that used to be hardcoded constants (or one env var) live in ComfyUI's own Settings
dialog, under an **AnimaFlow** entry in the sidebar — alongside EasyUseAnima, Pixaroma and Use
Everywhere. Declared in [`js/shared/settings.mjs`](../js/shared/settings.mjs). (Count grows over
time — re-count `ANIMAFLOW_SETTINGS.length` rather than trusting this number; this table has
undercounted before by simply missing rows — "Civitai: maximum browsing level" and "Show Civitai
name instead of filename" were both live settings with no row here until this pass added them.)

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
| Civitai API key | `AnimaFlow.Controls.CivitaiApiKey` | text | **empty** (public-only) | `src/model_browser/keys.py`'s `resolve_api_key` — tier 1 of `docs/lora-loader-design.md` §8's three-tier ladder (this setting, then the `CIVITAI_API_KEY` environment variable, then public-only mode) |
| Civitai search: base model filter | `AnimaFlow.Controls.CivitaiSearchBaseModel` | combo | empty (any) | `js/controls/civitai_search.mjs`'s remembered base-model filter |
| Civitai search: sort | `AnimaFlow.Controls.CivitaiSearchSort` | combo | `Highest Rated` | `js/controls/civitai_search.mjs`'s remembered sort order, matching `src/model_browser/civitai_search.py`'s `DEFAULT_SORT` |
| Civitai search: period | `AnimaFlow.Controls.CivitaiSearchPeriod` | combo | `AllTime` | `js/controls/civitai_search.mjs`'s remembered time-period filter, matching `src/model_browser/civitai_search.py`'s `DEFAULT_PERIOD` |
| Civitai search: show NSFW | `AnimaFlow.Controls.CivitaiSearchNsfw` | bool | false | `js/controls/civitai_search.mjs`'s remembered NSFW-results toggle; ships off, then follows whatever the user last picked (§7c-i) |
| Show Civitai name instead of filename | `AnimaFlow.Controls.ShowCivitaiName` | bool | false | `js/controls/model_picker.mjs`'s `displayRowName` — picker row, LoRA row's own name field, ⓘ panel title; purely cosmetic, falls back to the file name for anything not yet looked up |
| Civitai: maximum browsing level | `AnimaFlow.Controls.CivitaiBrowsingLevel` | combo (`PG`/`PG-13`/`R`/`X`/`XXX`) | **`PG`** | every surface that loads a Civitai image — the search panel/toolbar browser's results/thumbnails, the ⓘ panel's identity thumbnail, the download-time preview sidecar |
| Civitai detail view: modal body text size (px) | `AnimaFlow.Controls.CivitaiDetailModalFontSize` | int (clamped 12-20) | **14** | `js/controls/model_detail_view.mjs`'s `FONT_RATIOS` base, read by the browser modal (`civitai_modal.mjs`'s `modalFontSizePx`) |
| Civitai detail view: picker panel body text size (px) | `AnimaFlow.Controls.CivitaiDetailPanelFontSize` | int (clamped 12-20) | **12** | same `FONT_RATIOS` base, read by the picker's ⓘ/detail panel (`civitai_search.mjs`'s `panelFontSizePx`) — a separate id so the two mounts can size differently |

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

**A frontend setting reaching Python is not automatic — but two of these do, and both through the
same one mechanism.** Console logging and the Civitai API key both need a live Python value, and
both get it *without* a custom route: `src/anima/frontend_settings.py`'s `get_setting` reads
ComfyUI's own persisted `user/default/comfy.settings.json` directly, cached by mtime
(`src/model_browser/keys.py` imports the same function rather than duplicating the read). That
choice matters — it survives a server restart, and it still works for an API-only run with no
browser attached, which an `onChange`-posts-to-our-route design would not. Missing, unreadable or
malformed file all degrade to the documented default; it never raises.

**The Civitai API key is a secret, and this is the least-protected of the three tiers it can come
from.** `docs/lora-loader-design.md` §8's ladder is: this setting, then the `CIVITAI_API_KEY`
environment variable, then public-only mode. A ComfyUI setting lives in plain text in
`comfy.settings.json` and is served to the browser by ComfyUI's own settings endpoint — so it is
exactly as protected as any other ComfyUI setting, i.e. readable by anything that can reach the
ComfyUI UI or that file on disk. That is inherent to what a tier-1 UI-editable setting *is*, not a
defect introduced here, but don't assume it is encrypted, write-only, or hidden from anyone who can
open the Settings dialog or the JSON file. **The Settings dialog has no masked/password input
type** in the installed ComfyUI frontend (checked against `comfyui_frontend_package` 1.45.21/
1.47.10's own `FormItem.vue`: its `type` switch covers `boolean` / `number` / `slider` / `knob` /
`combo` / `radio` / `image` / `color` / `url` / `backgroundImage`, with anything else — including
this setting's own `"text"` — falling through to a plain, unmasked `InputText`) — so this field is
declared `type: "text"` and typed in plain view, same as any other short string setting here. If
you'd rather the key never touch `comfy.settings.json` at all (a shared box, or a cloud instance),
set the `CIVITAI_API_KEY` environment variable instead — the ladder's tier 2, checked whenever this
setting is left blank.

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

**The two detail-view font-size settings are a scale factor, not a raw px value, on purpose.**
Both feed `model_detail_view.mjs`'s own `--wtn-dv-font-scale` custom property (the setting's px value
divided by 16, the browser's own conventional default root size); every actual `font-size` in that
component reads `calc(var(--wtn-dv-font-scale) * <ratio> * 1rem)`, never a bare `px`. That is what
lets a user's own browser font-size preference or zoom still apply on top of this setting instead of
being overridden by it — a hardcoded `px` here would silently defeat the single most common
accessibility control there is. The section headings (`GALLERY` / `VERSION DESCRIPTION` / `MODEL
DESCRIPTION`) are real `<h4>` elements for the same reason (screen-reader structure), matching this
pack's existing convention for a single popover title (`js/controls/interaction.mjs`'s `buildSeedPopover`
and its siblings). Both settings are clamped to 12-20px in `model_detail_view.mjs` itself
(`clampDetailViewFontSize`) regardless of what's typed into the number field — there is no
min/max on the Settings-dialog widget itself, only at the point of use.

**No sixth auto-loaded `.js`.** ComfyUI auto-loads every `.js` under `WEB_DIRECTORY`, and
[`.claude/CLAUDE.md`](../.claude/CLAUDE.md) caps this pack at 5. The settings are therefore declared
in a `.mjs` behind a register-once guard, imported by the entry points that already exist. Adding
`js/settings/index.js` would have been the obvious shape and would have broken that budget.
