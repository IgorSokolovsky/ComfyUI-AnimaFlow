/**
 * core.mjs — pure card-layout model for the AnimaGenerator DOM panel. No DOM
 * access, no `node`/`widget` runtime objects required beyond plain
 * `{value, options}` shapes (importable/testable under plain Node).
 *
 * ## Why this exists
 *
 * `AnimaGenerator` (`nodes/anima/node_anima_generator.py`) declares 42 real,
 * natively-serialized widgets (see that file's `INPUT_TYPES` — this list is
 * kept in sync BY HAND, same convention as `render.mjs`'s hardcoded `TOKENS`
 * mirror of `js/shared/theme.mjs`) plus two multiline STRING widgets
 * (`positive_text`/`negative_text`) that stay native per the plan. This
 * module is the single source of truth for which of those 33 widgets is
 * presented in which card, and in what order — the Python file is NEVER
 * touched (per the plan's critical constraint), only re-presented.
 *
 * `CARD_DEFS` below is deliberately data, not markup: `index.js`/
 * `interaction.mjs` walk it to decide which native widget to hide-and-mirror
 * and which DOM row to build for it; `render.mjs` never hardcodes a widget
 * name itself. This keeps the three modules honest about the "drive the
 * existing widget, don't invent new state" constraint — there is no
 * parallel state object for field values, only for UI-only collapse state
 * (see `isCardCollapsed`/`setCardCollapsed` below), which has no widget to
 * mirror onto at all.
 *
 * `control_after_generate` is listed in the SAMPLER card per the plan's
 * literal spec, but AnimaGenerator's `seed` INPUT_TYPES entry does NOT set
 * `"control_after_generate": True` (unlike core KSampler's `seed`), so
 * ComfyUI's frontend never actually creates that widget on this node. This
 * is intentionally left in the layout as a live exercise of the "a widget
 * named in the layout but absent at runtime is skipped without throwing"
 * fallback (see `interaction.mjs`'s `logMissingOnce`/`renderCard`) rather
 * than silently dropped from the layout — if a future Python change adds
 * that flag, the control appears with zero JS changes.
 */

// ---------------------------------------------------------------------------
// Card layout
// ---------------------------------------------------------------------------

/**
 * One entry per card. `fields` is the STATIC field list for non-dynamic
 * cards; for the "upscale" card `fields` is only the base (backend-agnostic)
 * fields — `getCardFieldNames`/`getCardAllPossibleFieldNames` below append
 * the backend-specific ones. `enabledWidget` is `null` for the two
 * always-on cards (SAMPLER, PREVIEW).
 */
export const CARD_DEFS = Object.freeze([
  Object.freeze({
    id: "sampler",
    title: "Sampler",
    enabledWidget: null,
    fields: Object.freeze([
      "seed",
      "control_after_generate",
      "steps",
      "cfg",
      "sampler_name",
      "scheduler",
      "denoise",
      "shift",
      "width",
      "height",
    ]),
  }),
  Object.freeze({
    id: "highres",
    title: "Highres Fix",
    enabledWidget: "highres_enabled",
    fields: Object.freeze([
      "highres_scale_by",
      "highres_multiple",
      "highres_max_long_edge",
      "highres_denoise",
    ]),
  }),
  Object.freeze({
    id: "detailer",
    title: "Detailer",
    enabledWidget: "detailer_enabled",
    fields: Object.freeze(["detailer_guide_size", "detailer_max_size", "detailer_denoise"]),
  }),
  Object.freeze({
    id: "upscale",
    title: "Upscale",
    enabledWidget: "upscale_enabled",
    // Base (backend-agnostic) fields only — the active backend's fields are
    // appended by getCardFieldNames/getCardAllPossibleFieldNames below. This
    // is "the one genuinely dynamic bit" the plan calls out.
    fields: Object.freeze(["upscale_backend"]),
  }),
  Object.freeze({
    id: "postprocess",
    title: "Postprocess",
    enabledWidget: "postprocess_resize_enabled",
    fields: Object.freeze(["postprocess_multiple"]),
  }),
  Object.freeze({
    id: "save",
    title: "Save",
    enabledWidget: "save_output",
    fields: Object.freeze(["save_prefix"]),
  }),
  Object.freeze({
    id: "preview",
    title: "Preview",
    enabledWidget: null,
    fields: Object.freeze(["preview_channel"]),
  }),
]);

export const DEFAULT_UPSCALE_BACKEND = "usdu";

/** Only the USDU/ResShift fields shown for the currently-selected
 * `upscale_backend` combo value — mirrors the Python `generate()`'s own
 * "only used if upscale_backend is X" tooltips exactly (see
 * `node_anima_generator.py`'s `upscale_usdu_*`/`upscale_resshift_*`
 * tooltips). Showing all ten at once (both backends) is the redundant UI the
 * plan calls out to trim; this function is what actually trims it. */
export const UPSCALE_BACKEND_FIELDS = Object.freeze({
  usdu: Object.freeze([
    "upscale_usdu_model_name",
    "upscale_usdu_scale_by",
    "upscale_usdu_tile_size",
    "upscale_usdu_denoise",
    // Appended in the USDU seam-fix + tile-control port (docs/backlog.md
    // §2.3) — these are declared LAST in the Python INPUT_TYPES (append
    // -only, see node_anima_generator.py's own comment), but presented here
    // right after the pre-existing usdu fields since this list is purely
    // presentation order, independent of Python declaration order.
    "upscale_usdu_auto_tile",
    "upscale_usdu_mode_type",
    "upscale_usdu_mask_blur",
    "upscale_usdu_tile_padding",
    "upscale_usdu_seam_fix_mode",
    "upscale_usdu_seam_fix_denoise",
    "upscale_usdu_seam_fix_width",
    "upscale_usdu_seam_fix_mask_blur",
    "upscale_usdu_seam_fix_padding",
  ]),
  resshift: Object.freeze([
    "upscale_resshift_scale",
    "upscale_resshift_chop",
    "upscale_resshift_overlap",
    "upscale_resshift_tile_batch",
  ]),
});

/** Fields for ONE backend (falls back to `DEFAULT_UPSCALE_BACKEND` for an
 * unrecognized/missing value — never throws, never returns nothing). */
export function getUpscaleBackendFields(backend) {
  return UPSCALE_BACKEND_FIELDS[backend] || UPSCALE_BACKEND_FIELDS[DEFAULT_UPSCALE_BACKEND];
}

/** The fields to actually RENDER for `cardDef` right now — for the upscale
 * card this is the base fields plus only the currently-selected backend's
 * fields (the dynamic filtering); every other card ignores `backend` and
 * just returns its static list. */
export function getCardFieldNames(cardDef, backend) {
  if (cardDef.id === "upscale") {
    return [...cardDef.fields, ...getUpscaleBackendFields(backend)];
  }
  return cardDef.fields.slice();
}

/** EVERY field name `cardDef` could ever show across all backend variants —
 * used only for the widget->card completeness bookkeeping below (never for
 * actual rendering, which always calls `getCardFieldNames` with the live
 * backend so only one variant renders at a time). */
export function getCardAllPossibleFieldNames(cardDef) {
  if (cardDef.id === "upscale") {
    return [...cardDef.fields, ...UPSCALE_BACKEND_FIELDS.usdu, ...UPSCALE_BACKEND_FIELDS.resshift];
  }
  return cardDef.fields.slice();
}

/** Flat list of every widget name any card claims to present (fields +
 * enabled-toggle widgets, both upscale-backend variants included) — the
 * completeness check in `test_resize.mjs` asserts this has no duplicates and
 * matches AnimaGenerator's real widget list 1:1 (minus `positive_text`/
 * `negative_text`, which are deliberately excluded — see this module's top
 * doc comment). */
export function getAllLayoutWidgetNames() {
  const names = [];
  for (const cardDef of CARD_DEFS) {
    if (cardDef.enabledWidget) {
      names.push(cardDef.enabledWidget);
    }
    names.push(...getCardAllPossibleFieldNames(cardDef));
  }
  return names;
}

// ---------------------------------------------------------------------------
// Widget shape inspection (pure — operates on a plain `{value, options}`
// shape, exactly what a real litegraph widget looks like from the outside;
// never touches the DOM or a real `node`)
// ---------------------------------------------------------------------------

/** Classify a widget's control kind purely from its own `value`/`options` —
 * per the plan: "read each control's constraints from the widget itself...
 * rather than hardcoding them". `"missing"` for a falsy widget (the
 * caller's cue to skip + log once, never throw). */
export function widgetKind(widget) {
  if (!widget) {
    return "missing";
  }
  const opts = (widget && widget.options) || {};
  if (Array.isArray(opts.values)) {
    return "combo";
  }
  if (typeof widget.value === "boolean") {
    return "boolean";
  }
  if (typeof opts.min === "number" || typeof opts.max === "number" || typeof opts.step === "number") {
    return "number";
  }
  return "text";
}

/** Clamp/round a raw (string or number) input to `widget`'s own
 * `options.min`/`max`, and round to an integer when `options.precision`
 * is `0` (how ComfyUI's own INT widgets mark themselves) — falls back to
 * the widget's current value if `raw` doesn't parse to a finite number. */
export function coerceNumberValue(widget, raw) {
  const opts = (widget && widget.options) || {};
  let value = Number(raw);
  if (!Number.isFinite(value)) {
    value = typeof (widget && widget.value) === "number" ? widget.value : 0;
  }
  if (typeof opts.min === "number") {
    value = Math.max(opts.min, value);
  }
  if (typeof opts.max === "number") {
    value = Math.min(opts.max, value);
  }
  if (opts.precision === 0) {
    value = Math.round(value);
  }
  return value;
}

/** Human-readable field label from a widget name: strips the card-scoped
 * prefix (redundant once the field is already inside e.g. the HIGHRES card)
 * and title-cases the rest. Pure string logic, no widget access needed. */
const LABEL_PREFIXES = [
  "highres_",
  "detailer_",
  "upscale_usdu_",
  "upscale_resshift_",
  "upscale_",
  "postprocess_",
  "save_",
];

export function prettyFieldLabel(name) {
  const raw = String(name || "");
  let base = raw;
  for (const prefix of LABEL_PREFIXES) {
    if (base.startsWith(prefix) && base.length > prefix.length) {
      base = base.slice(prefix.length);
      break;
    }
  }
  base = base.replace(/_/g, " ").trim();
  if (!base) {
    base = raw.replace(/_/g, " ");
  }
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Field presence (pure — testable without a DOM or a real node/widget)
// ---------------------------------------------------------------------------

/** Split `fieldNames` into `present` (found in `presentNames`) and
 * `missing` — the pure half of "a widget named in the layout but absent at
 * runtime is skipped without throwing" (the DOM-touching half lives in
 * `interaction.mjs`'s `renderCard`, which calls this indirectly by checking
 * each `resolveWidget(name)` result). */
export function partitionFieldsByPresence(fieldNames, presentNames) {
  const presentSet = new Set(presentNames || []);
  const present = [];
  const missing = [];
  for (const name of fieldNames || []) {
    (presentSet.has(name) ? present : missing).push(name);
  }
  return { present, missing };
}

// ---------------------------------------------------------------------------
// Collapse state — UI-ONLY, persisted on node.properties (no widget backs
// it; see index.js's doc comment for why node.properties is the right home)
// ---------------------------------------------------------------------------

const COLLAPSE_PROPERTY_KEY = "animaGeneratorCollapse";

/** Whether `cardId` is collapsed, read from `properties[animaGeneratorCollapse]`.
 * Defaults to expanded (`false`) for: no `properties`, a non-object
 * `properties`, a missing entry, or any non-`true` garbage value (a stray
 * string/number/null from a corrupted save) — collapse state must never
 * blank the node or throw. */
export function isCardCollapsed(properties, cardId) {
  const store = properties && typeof properties === "object" ? properties[COLLAPSE_PROPERTY_KEY] : null;
  if (!store || typeof store !== "object") {
    return false;
  }
  return store[cardId] === true;
}

/** Persist `cardId`'s collapsed flag onto `properties[animaGeneratorCollapse]`,
 * creating the store object if it's missing or was garbage. No-op if
 * `properties` itself isn't a mutable object (defensive; shouldn't happen —
 * `index.js` always ensures `node.properties = node.properties || {}`
 * before calling this). */
export function setCardCollapsed(properties, cardId, collapsed) {
  if (!properties || typeof properties !== "object") {
    return;
  }
  if (!properties[COLLAPSE_PROPERTY_KEY] || typeof properties[COLLAPSE_PROPERTY_KEY] !== "object") {
    properties[COLLAPSE_PROPERTY_KEY] = {};
  }
  properties[COLLAPSE_PROPERTY_KEY][cardId] = !!collapsed;
}

export { COLLAPSE_PROPERTY_KEY };
