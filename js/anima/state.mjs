/**
 * state.mjs — PURE settings-tree logic for `js/anima/`: defaults, the
 * tolerant/additive normalizer, and the small mutation helpers the popover
 * UI needs (detailer block add/remove/reorder). No `document`/`window`/
 * `node` reference anywhere in this file — it must stay importable and
 * testable under plain `node`, mirroring the `src/anima/` pure/impure split
 * this whole track is built on (`.claude/CLAUDE.md`: "In `src/anima/` the
 * pure/impure boundary is absolute... Don't put a decision in `pipeline.py`"
 * — the JS analogue is "don't put a decision in `interaction.mjs`/
 * `index.js`").
 *
 * This is a byte-for-byte PORT of `src/anima/settings.py` (defaults tree +
 * `normalize_generation_settings`/`_deep_merge_defaults`/`_fixup_detailer`/
 * `migrate_version`) and `src/anima/preview_settings.py`
 * (`normalize_preview_settings`) — the two normalizers MUST deep-equal each
 * other's output for the same input, or the frontend and backend would
 * silently disagree about what a settings blob means. `test_resize.mjs`
 * asserts this against a checked-in copy of Python's actual output
 * (`fixture_default_generation_settings.json` / `fixture_default_preview_
 * settings.json` in this folder) rather than re-deriving it, since spawning
 * `python3` from a headless `node` test is avoidable ceremony for a value
 * that only needs regenerating when `settings.py`'s defaults change. To
 * regenerate:
 *
 *   python3 -c "import sys,json;sys.path.insert(0,'.');\
 *     from src.anima.settings import DEFAULT_GENERATION_SETTINGS as D;\
 *     print(json.dumps(D,indent=1))" > /tmp/f.json && python3 -c "\
 *     import json; d=json.load(open('/tmp/f.json'));\
 *     json.dump(d, open('js/anima/fixture_default_generation_settings.json','w'),\
 *     indent=2, sort_keys=True)"
 *
 * (and the equivalent for `src.anima.preview_settings.DEFAULT_PREVIEW_SETTINGS`
 * -> `fixture_default_preview_settings.json`).
 *
 * **2026-07-28 reversal (Context Bridge dispatch)** — `use_internal_loaders`,
 * the four internal-loader picker rows, the inline LoRA list, and the inline
 * `latent` row are ALL GONE from the Python contract (`docs/generator-
 * design.md` §3/§5/§8's dated notes), so `generation_settings.latent`/
 * `.loras` are deleted from the defaults tree below and every mutation
 * helper that only ever served them (`addLora`/`removeLora`/`moveLora`/
 * `toggleMuteLora`, `preferredNameDefault`/`UNET_NAME_CANDIDATES`/
 * `CLIP_NAME_CANDIDATES`/`VAE_NAME_CANDIDATES`) is deleted too, not left
 * unreferenced. `resolveOutputs`/`STAGE_HIGHRES`/`STAGE_DETAILER`/
 * `STAGE_UPSCALE` (the old three-fixed-socket resolver) are replaced by
 * `resolveStageLabels`, a byte-for-byte port of `src/anima/stages.py`'s
 * `resolve_stage_labels` (the new `images` LIST's position -> stage-label
 * resolver).
 */

// ---------------------------------------------------------------------------
// Schema / version — mirrors src/anima/settings.py exactly.
// ---------------------------------------------------------------------------

export const GENERATION_SETTINGS_SCHEMA = "animaflow.anima_generator.generation_settings";
export const GENERATION_SETTINGS_VERSION = 1;

// Settled 2026-07-27 (design doc §6a): a compute cap, not a socket-count cap
// (there are no per-block SEGS sockets at all). May grow later, never
// shrink — mirrors `src/anima/settings.py`'s `MAX_DETAILER_PASSES`. Import
// the REAL value's meaning here rather than hardcoding a different number.
export const MAX_DETAILER_PASSES = 4;

export const PREVIEW_SETTINGS_SCHEMA = "animaflow.anima_preview.preview_state";
export const PREVIEW_SETTINGS_VERSION = 1;

// The three labels a run's `images` list can carry, in the order they always
// appear when present -- mirrors `src/anima/stages.py`'s `STAGE_ORDER`.
export const STAGE_BASE = "base";
export const STAGE_MID = "mid";
export const STAGE_FINAL = "final";
export const STAGE_ORDER = [STAGE_BASE, STAGE_MID, STAGE_FINAL];
export const COMPARE_SLOTS = STAGE_ORDER;

export const SAVE_WHICH_OPTIONS = ["shown", "both compared", "every wired input"];

// The Anima Context Bridge's own field order (`nodes/anima/context_bridge.py`'s
// `OPTIONAL_KEY_ORDER` / `src/anima/context.py`'s `CONTEXT_FIELDS`) --
// display/iteration order only (matches Python: "it has no append-only
// obligation the way a node's INPUT_TYPES does, since this is a plain dict
// shape"), used by `interaction.mjs` to walk the bridge's own sockets when
// resolving which of them are wired.
export const CONTEXT_FIELDS = [
  "model", "clip", "vae", "positive", "negative", "latent",
  "seed", "steps", "cfg", "sampler_name", "scheduler",
];

// The five sampler scalars, independently wired-wins, no flag (design doc
// §5a) -- mirrors `src/anima/resources.py`'s `SAMPLER_FIELDS`. A SUBSET of
// `CONTEXT_FIELDS`, kept as its own export because it's the list
// `buildSamplerSection` actually iterates.
export const SAMPLER_FIELDS = ["seed", "steps", "cfg", "sampler_name", "scheduler"];

// ---------------------------------------------------------------------------
// Per-block detailer defaults — upstream's face/eye blocks verbatim, ported
// from `src/anima/settings.py`'s `_detailer_block`/`_FACE_BLOCK_DEFAULT`/
// `_EYE_BLOCK_DEFAULT`.
// ---------------------------------------------------------------------------

function detailerBlock({
  label, detectPrompt, threshold, cropFactor, dropSize, denoise, feather, noiseMaskFeather,
}) {
  return {
    label,
    enabled: false,
    detect_prompt: detectPrompt,
    detect_count: 1,
    threshold,
    refine_iterations: 2,
    individual_masks: true,
    combined: false,
    crop_factor: cropFactor,
    bbox_fill: false,
    drop_size: dropSize,
    contour_fill: true,
    guide_size: 1024,
    // design doc §9 divergence #1 -- MUST stay false.
    guide_size_for: false,
    max_size: 2048,
    steps: 20,
    inherit_sampler_settings: true,
    cfg: 8.0,
    sampler_name: "euler",
    scheduler: "sgm_uniform",
    denoise,
    feather,
    noise_mask: true,
    force_inpaint: true,
    wildcard: "",
    cycle: 1,
    alignment: "32",
    inpaint_model: false,
    // design doc §9 divergence #2 -- must never be 0.
    noise_mask_feather: noiseMaskFeather,
    tiled_encode: false,
    tiled_decode: false,
  };
}

const FACE_BLOCK_DEFAULT = detailerBlock({
  label: "Face Detailer", detectPrompt: "face", threshold: 0.52,
  cropFactor: 4.0, dropSize: 100, denoise: 0.33, feather: 5, noiseMaskFeather: 10,
});
const EYE_BLOCK_DEFAULT = detailerBlock({
  label: "Eye Detailer", detectPrompt: "eyes", threshold: 0.5,
  cropFactor: 6.0, dropSize: 40, denoise: 0.29, feather: 6, noiseMaskFeather: 20,
});

// ---------------------------------------------------------------------------
// The full defaults tree -- NO `latent`/`loras` (2026-07-28 reversal, this
// module's own top doc comment) -- see settings.py's module docstring for
// why `detailer` is ONE block (`enabled` + `order` + a `blocks` dict keyed by
// id).
// ---------------------------------------------------------------------------

export const DEFAULT_GENERATION_SETTINGS = {
  schema: GENERATION_SETTINGS_SCHEMA,
  version: GENERATION_SETTINGS_VERSION,
  sampler: {
    seed: -1,
    seed_after_generate: "fixed",
    steps: 32,
    cfg: 5.0,
    sampler_name: "er_sde",
    scheduler: "simple",
    denoise: 1.0,
    shift: 3.0,
  },
  mod_guidance: {
    enabled: false,
    profile: "step_i8_skip27",
    quality_tags: "highres, best quality, score_7",
    quality_neg: "score_1, score_2, score_3, worst quality, lowres, old, bad hands, bad anatomy",
    mod_w: 3.0,
    mod_start_layer: 8,
    mod_end_layer: 27,
    mod_taper: 0,
    mod_taper_scale: 0.25,
    mod_final_w: 0.0,
  },
  highres: {
    enabled: false,
    scale_by: 1.5,
    upscale_method: "bicubic",
    multiple: "32",
    max_long_edge: 2560,
    steps: 20,
    denoise: 0.25,
    inherit_sampler_settings: true,
    cfg: 8.0,
    sampler_name: "euler",
    scheduler: "simple",
  },
  upscale: {
    enabled: false,
    scale_by: 2.0,
    steps: 20,
    inherit_sampler_settings: true,
    cfg: 8.0,
    sampler_name: "euler",
    scheduler: "simple",
    denoise: 0.2,
    usdu: {
      upscale_model_name: "2x-AnimeSharpV4_Fast_RCAN_PU.safetensors",
      auto_tile_size: true,
      mode_type: "Linear",
      auto_tile_target: 1024,
      auto_tile_min: 512,
      auto_tile_max: 2048,
      tile_width: 512,
      tile_height: 512,
      mask_blur: 8,
      tile_padding: 32,
      seam_fix_mode: "None",
      seam_fix_denoise: 1.0,
      seam_fix_width: 64,
      seam_fix_mask_blur: 8,
      seam_fix_padding: 16,
      force_uniform_tiles: true,
      tiled_decode: false,
      batch_size: 1,
    },
  },
  postprocess: {
    enabled: false,
    fit: { mode: "max_long_edge", max_long_edge: 2048, max_megapixels: 4.0, method: "bicubic" },
  },
  detailer: {
    enabled: false,
    order: ["face", "eye"],
    sam3: { checkpoint: "sam3.1_multiplex_fp16.safetensors" },
    blocks: { face: FACE_BLOCK_DEFAULT, eye: EYE_BLOCK_DEFAULT },
  },
};

export const DEFAULT_PREVIEW_SETTINGS = {
  schema: PREVIEW_SETTINGS_SCHEMA,
  version: PREVIEW_SETTINGS_VERSION,
  compare: { enabled: true, a: "base", b: "final" },
  save: {
    enabled: true,
    which: "shown",
    extension: "png",
    path: "AnimaFlow",
    filename: "%date:yyyy-MM-dd%_%seed%_%stage%",
    embed_workflow: true,
  },
};

// ---------------------------------------------------------------------------
// Generic recursive merge -- port of settings.py's `_deep_merge_defaults`.
// Shape, not value validation; value coercion happens where each field is
// actually consumed.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

export function deepMergeDefaults(defaults, value) {
  if (isPlainObject(defaults)) {
    if (!isPlainObject(value)) {
      return deepCopy(defaults);
    }
    const merged = {};
    for (const key of Object.keys(defaults)) {
      merged[key] = deepMergeDefaults(defaults[key], value[key]);
    }
    for (const key of Object.keys(value)) {
      if (!(key in merged)) {
        merged[key] = value[key];
      }
    }
    return merged;
  }
  if (Array.isArray(defaults)) {
    return Array.isArray(value) ? value : deepCopy(defaults);
  }
  return value !== undefined && value !== null ? value : defaults;
}

/** Version-bump-forward, never-reject -- port of settings.py's
 * `migrate_version`. Takes `currentVersion` as a parameter so both
 * generation and preview settings (differently versioned) can share it. */
export function migrateVersion(rawVersion, currentVersion) {
  const version = Number(rawVersion);
  if (!Number.isFinite(version)) {
    return currentVersion;
  }
  if (version < currentVersion) {
    return currentVersion;
  }
  return version;
}

/** Two things the generic merge can't do alone for `detailer.blocks` -- port
 * of settings.py's `_fixup_detailer`: an unknown block id merges against the
 * FACE template (not verbatim), and `MAX_DETAILER_PASSES` caps `order` (its
 * listed ids win first, then any block present but not listed, dropped
 * rather than raising past the cap). */
function fixupDetailer(rawDetailer) {
  const detailer = isPlainObject(rawDetailer) ? rawDetailer : {};
  const blocks = isPlainObject(detailer.blocks) ? detailer.blocks : {};

  const fixedBlocks = {};
  for (const blockId of Object.keys(blocks)) {
    if (!blockId) {
      continue;
    }
    const blockValue = blocks[blockId];
    if (blockId === "face") {
      fixedBlocks[blockId] = deepMergeDefaults(FACE_BLOCK_DEFAULT, blockValue);
    } else if (blockId === "eye") {
      fixedBlocks[blockId] = deepMergeDefaults(EYE_BLOCK_DEFAULT, blockValue);
    } else {
      fixedBlocks[blockId] = deepMergeDefaults(FACE_BLOCK_DEFAULT, isPlainObject(blockValue) ? blockValue : {});
    }
  }

  let rawOrder = Array.isArray(detailer.order) ? detailer.order : DEFAULT_GENERATION_SETTINGS.detailer.order.slice();
  const orderedIds = rawOrder.filter((id) => typeof id === "string" && id in fixedBlocks);
  for (const id of Object.keys(fixedBlocks)) {
    if (!orderedIds.includes(id)) {
      orderedIds.push(id);
    }
  }

  const keptIds = orderedIds.slice(0, MAX_DETAILER_PASSES);
  const keptBlocks = {};
  for (const id of keptIds) {
    keptBlocks[id] = fixedBlocks[id];
  }
  detailer.blocks = keptBlocks;
  detailer.order = keptIds;
  detailer.enabled = !!detailer.enabled;
  return detailer;
}

/** `generation_settings` (the raw STRING widget value, an already-parsed
 * object, or garbage) -> a fully-shaped, defaulted settings tree. Never
 * throws. Port of `src/anima/settings.py`'s `normalize_generation_settings`
 * -- MUST deep-equal it for the same input (`test_resize.mjs` checks the
 * default case against a checked-in copy of Python's actual output). */
export function normalizeGenerationSettings(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!isPlainObject(parsed)) {
    parsed = {};
  }

  const merged = deepMergeDefaults(DEFAULT_GENERATION_SETTINGS, parsed);
  merged.detailer = fixupDetailer(merged.detailer);
  merged.schema = GENERATION_SETTINGS_SCHEMA;
  merged.version = migrateVersion(parsed.version, GENERATION_SETTINGS_VERSION);
  return merged;
}

export function defaultGenerationSettings() {
  return deepCopy(DEFAULT_GENERATION_SETTINGS);
}

/** Port of `src/anima/preview_settings.py`'s `normalize_preview_settings`. */
export function normalizePreviewSettings(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!isPlainObject(parsed)) {
    parsed = {};
  }

  const merged = deepMergeDefaults(DEFAULT_PREVIEW_SETTINGS, parsed);
  if (isPlainObject(merged.compare)) {
    if (!COMPARE_SLOTS.includes(merged.compare.a)) {
      merged.compare.a = "base";
    }
    if (!COMPARE_SLOTS.includes(merged.compare.b)) {
      merged.compare.b = "final";
    }
  }
  if (isPlainObject(merged.save) && !SAVE_WHICH_OPTIONS.includes(merged.save.which)) {
    merged.save.which = "shown";
  }

  merged.schema = PREVIEW_SETTINGS_SCHEMA;
  merged.version = migrateVersion(parsed.version, PREVIEW_SETTINGS_VERSION);
  return merged;
}

export function defaultPreviewSettings() {
  return deepCopy(DEFAULT_PREVIEW_SETTINGS);
}

// ---------------------------------------------------------------------------
// inherit_sampler_settings resolution -- port of src/anima/sampler.py's
// `resolve_stage_sampler`. The flag covers ONLY cfg/sampler_name/scheduler;
// steps/denoise are always the stage's own regardless (design doc §6b).
// ---------------------------------------------------------------------------

export const INHERITED_SAMPLER_FIELDS = ["cfg", "sampler_name", "scheduler"];
export const OWN_SAMPLER_FIELDS = ["steps", "denoise"];

export function resolveStageSampler(stageSettings, baseSampler) {
  const stage = isPlainObject(stageSettings) ? stageSettings : {};
  const base = isPlainObject(baseSampler) ? baseSampler : {};
  const inherit = stage.inherit_sampler_settings !== false;
  const resolved = {
    inherit_sampler_settings: inherit,
    steps: stage.steps,
    denoise: stage.denoise,
  };
  for (const field of INHERITED_SAMPLER_FIELDS) {
    resolved[field] = inherit ? base[field] : stage[field];
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Stage-label resolution -- port of `src/anima/stages.py`'s
// `detailer_is_live`/`resolve_stage_labels` (REPLACES the deleted
// `resolve_outputs`, this module's own top doc comment). The Generator now
// returns one `images` LIST; a stage that didn't run, or didn't change the
// image, is OMITTED, never duplicated.
// ---------------------------------------------------------------------------

export function detailerIsLive({ detailerEnabled, haveImpact, blocks }) {
  if (!detailerEnabled || !haveImpact) {
    return false;
  }
  if (!isPlainObject(blocks)) {
    return false;
  }
  return Object.values(blocks).some((block) => isPlainObject(block) && !!block.enabled);
}

/**
 * `{ highresEnabled, detailerLive, upscaleLive, postprocessApplied }` ->
 * ordered `["base", ...]` labels -- byte-for-byte port of `resolve_stage_
 * labels`. `base` is always present; `mid` iff highres or a live detailer
 * pass changed the image; `final` iff a live upscale or an applied
 * postprocess resize changed it again. A run with every stage off returns
 * `["base"]`.
 */
export function resolveStageLabels({ highresEnabled, detailerLive, upscaleLive, postprocessApplied }) {
  const stages = [STAGE_BASE];
  if (highresEnabled || detailerLive) {
    stages.push(STAGE_MID);
  }
  if (upscaleLive || postprocessApplied) {
    stages.push(STAGE_FINAL);
  }
  return stages;
}

// ---------------------------------------------------------------------------
// Detailer block mutation helpers (design doc §6a). `face`/`eye` are
// built-in and can never be removed; beyond them `+ Add block` creates
// `custom_1`, `custom_2`, ... inheriting the FACE defaults, enabled on
// creation -- matches upstream (`detailer_settings_dialog.js:357-368`) and
// `fixupDetailer`'s own merge-against-face-template rule above.
// ---------------------------------------------------------------------------

export function isBuiltinDetailerBlock(id) {
  return id === "face" || id === "eye";
}

/** Adds a new `custom_N` block (N is the smallest positive integer not
 * already used), inheriting the face template, enabled, appended to
 * `order`. Returns the new block's id, or `null` if `MAX_DETAILER_PASSES`
 * is already reached (caller decides how to surface that -- the mockup
 * disables its `+` button on `atMax`). */
export function addDetailerBlock(detailer) {
  if (Object.keys(detailer.blocks).length >= MAX_DETAILER_PASSES) {
    return null;
  }
  let n = 1;
  while (Object.prototype.hasOwnProperty.call(detailer.blocks, `custom_${n}`)) {
    n += 1;
  }
  const id = `custom_${n}`;
  const block = deepMergeDefaults(FACE_BLOCK_DEFAULT, {});
  block.label = `Detailer Block ${n}`;
  block.enabled = true;
  block.detect_prompt = "";
  detailer.blocks[id] = block;
  detailer.order.push(id);
  return id;
}

/** Removes a custom block; refuses (no-op, returns `false`) for `face`/`eye`
 * -- matches upstream's `removeTarget` refusing a non-custom name. */
export function removeDetailerBlock(detailer, id) {
  if (isBuiltinDetailerBlock(id) || !(id in detailer.blocks)) {
    return false;
  }
  delete detailer.blocks[id];
  detailer.order = detailer.order.filter((x) => x !== id);
  return true;
}

/** Swap `id` with its neighbour in `order` in direction `dir` (`-1`/`1`) --
 * upstream's `<`/`>` buttons mutating `detailer.order` (design doc §6a). */
export function moveDetailerBlock(detailer, id, dir) {
  const i = detailer.order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= detailer.order.length) {
    return detailer;
  }
  const tmp = detailer.order[i];
  detailer.order[i] = detailer.order[j];
  detailer.order[j] = tmp;
  return detailer;
}
