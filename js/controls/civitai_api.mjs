/**
 * civitai_api.mjs — the client-side fetch + cache layer behind the shared
 * model-browser library (`docs/lora-loader-design.md` §7a). **Track-agnostic
 * and kind-parameterised, like `src/model_browser/` itself** — every cache
 * here is keyed `(kind, name)`, never bare `name`, so a future Loader Panel
 * reuse pass (M3, `checkpoints`/`unet`) is wiring, not a rewrite (the same
 * "parameterise by kind on day one" rule the Python side already follows,
 * design doc §7a).
 *
 * ## Layering — the ONE thing a later slice must not violate
 *
 * This file, `model_picker.mjs`, `model_info.mjs`, and (M2)
 * `civitai_search.mjs` are what `AnimaLoaderPanel` will import at M3 (the
 * plan's whole reuse boundary, `docs/lora-loader-design.md` build-plan
 * §"Architecture"). **None of the four may ever import a `lora_*` module** —
 * that's the layering guard in `test_model_picker.mjs` (precedent:
 * `js/shared/test_field_logic.mjs`'s own guard for `js/shared/` vs a track).
 * This file has zero imports at all beyond the standard library, so it
 * trivially satisfies that from day one.
 *
 * ## M2 adds the search + download client (docs/lora-loader-design.md §9)
 *
 * `searchModels`/`startDownload`/`downloadProgress`/`cancelDownload` (near
 * the bottom of this file) are the client side of the four M2 routes
 * (`src/model_browser/api.py`'s own `search`/`download/start`/
 * `download/progress`/`download/cancel`). Consumed by
 * `js/controls/civitai_search.mjs`, never by a `lora_*` module directly (same
 * layering rule as everything else in this file).
 *
 * ## Slice 4 wires the REMOTE half too
 *
 * `listModels`/`hasFile`/`invalidateList` (the `/wtn/model_browser/list`
 * route) and `thumbUrl` (the `/wtn/model_browser/thumb` route, Slice 3's own
 * addition to `src/model_browser/api.py`) are the LOCAL half, unchanged.
 * `lookupInfo`/`forgetInfo` (below) are Slice 4's own addition — the client
 * side of the by-hash Civitai lookup (`docs/lora-loader-design.md` §2b) and
 * "Forget cached" (§7e), against the `/wtn/model_browser/lookup` and
 * `/wtn/model_browser/forget` routes Slice 1 already built and tested
 * server-side (`src/model_browser/api.py`). `cachedInfo`/`cachedCategoryTag`
 * are the read-only, NO-NETWORK side of the same `_infoCache` — see their
 * own doc comments for why they exist and what they must never do (trigger
 * a lookup themselves).
 *
 * **§9's "never block a graph run, only an explicit click" applies here
 * unchanged**: nothing in this module calls `lookupInfo`/`forgetInfo` on its
 * own initiative — every call is the caller's (`model_info.mjs`'s
 * `openModelInfo`, wired from a row's ⓘ click/"More info") response to an
 * explicit user action (opening the panel, "Re-fetch", "Retry", "Forget
 * cached"). **This module never reads the "Civitai" ⚙/Settings switch
 * itself** (§7b decision 20) — the CALLER (`model_info.mjs`) does, and
 * translates it into `lookupInfo`'s own `cachedOnly` option rather than
 * skipping the call outright: with the switch off, `model_info.mjs` still
 * calls `lookupInfo(kind, name, { cachedOnly: true })` so a cached sidecar
 * can still display (§7d), but `cachedOnly` makes the SERVER's own control
 * flow incapable of reaching Civitai at all on a cache miss (`lookup.py`'s
 * own doc comment) — so this module has no "are we allowed to be here"
 * logic to get wrong either way.
 *
 * ## The caching shape — ported from `../ComfyUI-Pixaroma/js/lora_loader/
 * api.mjs` (MIT, THIRD_PARTY_NOTICES.md), generalised from a bare `name` key
 * to `(kind, name)`
 *
 * Two rules worth keeping verbatim, both upstream's own hard-won fixes:
 *
 * 1. **"Unknown, not missing, before first load."** `hasFile(kind, name)`
 *    returns `null` — not `false` — until THAT kind's list has actually
 *    resolved at least once. Every consumer (this slice: `lora_render.mjs`'s
 *    missing-file mark) MUST treat `null` as "don't know yet, don't paint
 *    red" — collapsing it to `false` is exactly the bug upstream's own
 *    comment names: "[] made hasLora() brand every row 'missing' — a
 *    workflow-wide false alarm" the moment a node mounts before its very
 *    first list fetch resolves.
 * 2. **A failed/errored fetch keeps whatever list was already cached**
 *    (stale beats empty) — `_listCache` is only ever OVERWRITTEN by a
 *    genuinely successful `{reason: "ok", models: [...]}` response, never
 *    cleared by a network failure or a non-"ok" `reason`. A transient
 *    failure must not fabricate a "this kind now has zero files" answer
 *    that would false-flag every row as missing.
 */

const LIST_URL = "/wtn/model_browser/list";
const THUMB_URL = "/wtn/model_browser/thumb";
const LOOKUP_URL = "/wtn/model_browser/lookup";
const FORGET_URL = "/wtn/model_browser/forget";
const DELETE_URL = "/wtn/model_browser/delete";
const SAVE_PREVIEW_URL = "/wtn/model_browser/save_preview";
const SEARCH_URL = "/wtn/model_browser/search";
const DOWNLOAD_START_URL = "/wtn/model_browser/download/start";
const DOWNLOAD_PROGRESS_URL = "/wtn/model_browser/download/progress";
const DOWNLOAD_CANCEL_URL = "/wtn/model_browser/download/cancel";
const MODEL_DETAIL_URL = "/wtn/model_browser/model_detail";
const COMMUNITY_IMAGES_URL = "/wtn/model_browser/community_images";

// ---------------------------------------------------------------------------
// Local file list -- per kind. `null`/absent-from-the-map means "never
// fetched" (the "unknown, not missing" state `hasFile` reads below), NOT
// "this kind has no files" -- that's represented by a present, empty array.
// ---------------------------------------------------------------------------

const _listCache = new Map(); // kind -> models[]
const _listPromise = new Map(); // kind -> in-flight promise (de-dupes concurrent callers)

/**
 * Every model `folder_paths` (server-side) knows about for `kind`: `[{name,
 * size, group, base_model, triggers, has_preview}, ...]` (the exact shape
 * `src/model_browser/local.py`'s `list_models` returns). Cached per kind;
 * `force` (Slice 3's own refresh-hook path, and any explicit user
 * re-fetch) bypasses BOTH the cache and the in-flight dedupe. An invalid
 * `kind` (never reaches this file — every caller already knows its own
 * fixed kind string) or a network failure degrades to the PREVIOUSLY
 * cached list (or `[]` if none exists yet) rather than throwing or wiping a
 * good cache.
 */
export async function listModels(kind, force = false) {
  if (!kind) {
    return [];
  }
  if (!force && _listCache.has(kind)) {
    return _listCache.get(kind);
  }
  if (!force && _listPromise.has(kind)) {
    return _listPromise.get(kind);
  }
  const p = (async () => {
    try {
      // `cache: "no-store"` -- the route sends no cache headers of its own,
      // and a heuristically browser-cached copy of this list is exactly the
      // "a renamed/added file never appears without a hard refresh" bug
      // (same reasoning as upstream's own `listLoras`).
      const r = await fetch(`${LIST_URL}?kind=${encodeURIComponent(kind)}`, { cache: "no-store" });
      const j = await r.json();
      if (j && j.reason === "ok" && Array.isArray(j.models)) {
        _listCache.set(kind, j.models);
      }
      // Any other `reason` (a server-side scan failure, `invalid_kind`, ...)
      // or a response that doesn't even parse -- keep whatever was already
      // cached for this kind (see this module's top doc comment, rule 2).
    } catch {
      // Transient network failure -- identical "keep the stale copy" rule.
    } finally {
      // Only clear the in-flight slot if it's still OURS -- a `force` call
      // may have replaced it while this one was in the air.
      if (_listPromise.get(kind) === p) {
        _listPromise.delete(kind);
      }
    }
    return _listCache.get(kind) || [];
  })();
  _listPromise.set(kind, p);
  return p;
}

/** Drop the cached list for `kind` (or every kind, if `kind` is omitted) --
 * called from the `R`/WebSocket-reconnect refresh hook (`lora_interaction
 * .mjs`'s `refreshLoraModels`) so the NEXT `listModels` call re-fetches
 * rather than serving a now-possibly-stale cache. Dropping the cache alone
 * intentionally does NOT re-fetch -- the caller decides when to actually
 * hit the network again (immediately, via `listModels(kind, true)`, in this
 * pack's own refresh hook). */
export function invalidateList(kind) {
  if (kind) {
    _listCache.delete(kind);
  } else {
    _listCache.clear();
  }
}

/** The already-fetched list for `kind`, read with NO network at all (`[]` if
 * that kind's list has never resolved) — the synchronous counterpart to
 * `listModels`'s async fetch-or-cache. Exists for a caller (`model_info.mjs`'s
 * `openModelInfo`, wired from `lora_interaction.mjs`) that needs a specific
 * entry's file-derived data (its `triggers`/`base_model`) RIGHT NOW rather
 * than awaiting a promise — every LoRA Loader node already warms this cache
 * on mount (`lora_interaction.mjs`'s `mountLoraNode`), so by the time a row's
 * ⓘ is actually clickable this is populated in every real case; the `[]`
 * fallback is just "don't crash," not the expected path. */
export function cachedList(kind) {
  return (kind && _listCache.get(kind)) || [];
}

/** Whether `kind`'s list has EVER resolved at least once, this session --
 * `true` even for a real, successful fetch that came back empty (a genuinely
 * file-less folder), `false` for "never fetched" -- the same "unknown, not
 * missing" distinction `hasFile` already draws, but as its own predicate:
 * `cachedList` alone can't tell "never fetched" apart from "fetched, empty"
 * (both return `[]`). Exists for a caller (`model_picker.mjs`'s own summary
 * logging, task brief C/E: "list fetched vs served from cache") that needs to
 * know, BEFORE calling `listModels`, whether the upcoming call will be
 * answered from cache or actually reach the network. */
export function isListCached(kind) {
  return !!kind && _listCache.has(kind);
}

/**
 * Whether `name` is in the last-fetched list for `kind`:
 *   - `true`/`false` once that kind's list has actually resolved at least
 *     once;
 *   - `null` if it never has -- "unknown," NOT "missing" (this module's top
 *     doc comment, rule 1). Every caller must treat `null` as "don't paint
 *     a missing-file mark yet."
 */
export function hasFile(kind, name) {
  if (!kind || !name) {
    return null;
  }
  if (!_listCache.has(kind)) {
    return null; // this kind's list has never resolved -- unknown, not missing
  }
  const list = _listCache.get(kind);
  return list.some((m) => m && m.name === name);
}

/**
 * The cached Civitai display name for `(kind, name)` (docs/lora-loader-
 * design.md §1a-vii), read with NO network of its own from `(kind, name)`'s
 * entry in the last-fetched `/list` response -- `null` for an incomplete
 * pair, a kind whose list hasn't resolved yet, a name not in it, or a real
 * entry that simply carries no `civitai_name` at all (the server already
 * OMITS that field rather than sending a blank one -- `src/model_browser/
 * local.py`'s own doc comment). Never a placeholder, never the file name
 * echoed back as if it were a Civitai name -- a caller (`lora_render.mjs`'s
 * `paintRow`) that gets `null` back falls through to the plain file-name
 * display, silently, same as a model that was never looked up at all.
 */
export function civitaiNameFor(kind, name) {
  if (!kind || !name) {
    return null;
  }
  const entry = cachedList(kind).find((m) => m && m.name === name);
  const raw = entry && entry.civitai_name;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

// ---------------------------------------------------------------------------
// Per-model info -- keyed `(kind, name)`. `_infoCache` holds the last-known
// `/wtn/model_browser/lookup` RESPONSE for each pair (the whole `{reason,
// offline_reason, message, data, source}` dict, unchanged) -- written only by
// `lookupInfo` below, on an explicit call.
// ---------------------------------------------------------------------------

const _infoCache = new Map(); // "kind name" -> the route's last response dict
const _infoPromise = new Map(); // "kind name" -> in-flight promise (de-dupes concurrent lookups)

function infoKey(kind, name) {
  return `${kind} ${name}`;
}

/** Drop the cached info for `(kind, name)` -- called after "Forget cached"
 * (`forgetInfo`, below) deletes the server-side sidecar, so a stale `found`
 * response can't keep being served client-side once the thing it describes
 * is gone. */
export function invalidateInfo(kind, name) {
  _infoCache.delete(infoKey(kind, name));
}

/** The by-hash Civitai lookup (`docs/lora-loader-design.md` §2b), against
 * `POST /wtn/model_browser/lookup` (`src/model_browser/api.py`, Slice 1).
 * ALWAYS resolves -- never rejects -- to the route's own `{reason: "found"|
 * "notfound"|"offline", offline_reason, message, data, source}` shape;
 * anything that goes wrong on the way there (an unreachable dev server, a
 * response that isn't even JSON) degrades to the SAME `offline` shape the
 * route itself uses for an unreachable Civitai, so `model_info.mjs`'s
 * `lookupStateView` has exactly one shape to branch on regardless of which
 * hop actually failed.
 *
 * `force` (an explicit "Re-fetch"/"Retry" click) bypasses BOTH the
 * concurrent-call dedupe below AND asks the SERVER to skip its own
 * sidecar-first shortcut (`force_refresh` in the request body) -- i.e. it
 * really does reach Civitai again even if a sidecar already exists.
 *
 * `cachedOnly` (§7d/§7b decision 20 -- the "Civitai" ⚙/Settings switch being
 * off) is a straight pass-through to the route's own `cached_only` flag
 * (`lookup.py`'s `lookup_model_info`): when set, a cache HIT still answers
 * `found` exactly as normal, but a cache MISS returns `offline`/
 * `civitai_disabled` from server-side control flow that never reaches
 * Civitai's network at all -- see that function's own doc comment for why
 * this makes the guarantee literal rather than a UI-layer promise. That is
 * what lets a caller with Civitai turned off call this AT ALL (for cached
 * data only) without violating "no path left from which a request could
 * originate": `model_info.mjs` always passes `cachedOnly: true` when its own
 * `civitaiEnabled` parameter is `false`. */
export async function lookupInfo(kind, name, { force = false, cachedOnly = false } = {}) {
  if (!kind || !name) {
    return { reason: "offline", offline_reason: "missing_file", message: "No model selected.", data: null };
  }
  const key = infoKey(kind, name);
  if (!force && _infoPromise.has(key)) {
    return _infoPromise.get(key);
  }
  const p = (async () => {
    try {
      const r = await fetch(LOOKUP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name, force_refresh: force, cached_only: cachedOnly }),
      });
      const j = await r.json();
      if (j && typeof j.reason === "string") {
        _infoCache.set(key, j);
        return j;
      }
      return {
        reason: "offline",
        offline_reason: "unreadable",
        message: "The lookup route sent an unreadable reply.",
        data: null,
      };
    } catch (err) {
      return {
        reason: "offline",
        offline_reason: "unknown",
        message: `Could not reach the lookup route (${err && err.message ? err.message : err}).`,
        data: null,
      };
    } finally {
      if (_infoPromise.get(key) === p) {
        _infoPromise.delete(key);
      }
    }
  })();
  _infoPromise.set(key, p);
  return p;
}

/** "Forget cached" (`docs/lora-loader-design.md` §7e's `found` state) --
 * `POST /wtn/model_browser/forget`, then drops the client-side cache too so
 * the NEXT `lookupInfo` call genuinely re-asks rather than serving the
 * just-forgotten response. Returns the route's own `{reason, deleted}`, or a
 * `{reason: "offline", deleted: false}` degrade on any transport failure --
 * never throws. */
export async function forgetInfo(kind, name) {
  if (!kind || !name) {
    return { reason: "invalid_kind", deleted: false };
  }
  try {
    const r = await fetch(FORGET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name }),
    });
    const j = await r.json();
    invalidateInfo(kind, name);
    return j && typeof j === "object" ? j : { reason: "ok", deleted: false };
  } catch {
    invalidateInfo(kind, name);
    return { reason: "offline", deleted: false };
  }
}

/** The last-cached lookup RESPONSE for `(kind, name)`, read with NO network
 * at all -- `null` if nothing has ever been looked up (this session).
 * **Must never itself trigger a lookup** -- it exists so a read-only
 * consumer (`cachedCategoryTag`, below) can opportunistically use whatever a
 * PRIOR, explicit ⓘ-panel lookup already found, without paying for (or
 * causing) a network call of its own. */
export function cachedInfo(kind, name) {
  return _infoCache.get(infoKey(kind, name)) || null;
}

/** A genuinely-known Civitai category for `(kind, name)`, or `null` --
 * `model_picker.mjs`'s own seam for §1a-vi ("never invent a category"): this
 * reads ONLY the client-side cache above (never fetches), so a picker open
 * costs nothing extra even though this function exists (`docs/lora-loader-
 * design.md`'s "keep the picker's open path cheap" constraint) -- it can
 * only ever show a category chip for a model the user has ALREADY opened
 * the ⓘ panel for, this session, with a `found` result carrying `tags`. That
 * is a real, honest (if narrow) answer to "where does the category come
 * from" -- never a per-file sidecar scan, and never a guess. Civitai's
 * `tags` is a LIST (a model can carry several); this surfaces the first one,
 * matching the single-chip "category" concept `model_picker.mjs`'s own
 * `categoryOf` already renders one of. */
export function cachedCategoryTag(kind, name) {
  const info = cachedInfo(kind, name);
  if (!info || info.reason !== "found" || !info.data) {
    return null;
  }
  const tags = info.data.tags;
  if (!Array.isArray(tags)) {
    return null;
  }
  const first = tags.find((t) => typeof t === "string" && t.trim());
  return first ? first.trim() : null;
}

// ---------------------------------------------------------------------------
// Local preview thumbnail -- `/wtn/model_browser/thumb` (Slice 3's own route,
// `src/model_browser/api.py`). Fully offline: the route only ever serves a
// preview file already sitting next to the model on disk (design doc §1a-v).
// ---------------------------------------------------------------------------

/** The thumbnail URL for `(kind, name)`, or `null` for an incomplete pair.
 * Callers (the picker) should only ever request this when the model's own
 * `has_preview` flag (from `listModels`) is `true` -- the route itself 404s
 * cleanly for "no preview," but skipping the request entirely for a model
 * that's already known to have none avoids a guaranteed-404 round trip for
 * every unpictured file in a real `models/loras` folder. */
export function thumbUrl(kind, name) {
  if (!kind || !name) {
    return null;
  }
  return `${THUMB_URL}?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// "Remove an installed model" + the ⓘ backfill's own preview save
// (`docs/TODO.md`, owner decisions 2026-07-30 / `6ce43de`) -- both routes
// existed server-side with no frontend caller until this pass. Same
// never-throw discipline as every function above: each ALWAYS resolves to
// the route's own shape, degrading to an `offline`-flavoured shape for a
// transport failure (never reaches the server, or the reply isn't JSON with
// a usable `reason`).
// ---------------------------------------------------------------------------

/**
 * `POST /wtn/model_browser/delete` -- destroys the model `(kind, name)`
 * resolves to, plus its sidecar/preview if either exists
 * (`src/model_browser/remove.py`'s own doc comment has the full guarantee).
 * Always resolves to `{reason, message, removed}` -- `reason` is one of
 * `invalid_kind`/`not_found`/`write_error`/`ok` from the route itself, or
 * this function's own `offline` degrade for a transport failure. `removed`
 * names exactly which of `"model"`/`"sidecar"`/`"preview"` were actually
 * deleted on an `"ok"` -- a missing sidecar/preview is correctly absent from
 * that list, never an error.
 *
 * 🔒 This is the first network call in this pack that DESTROYS user data --
 * every caller must go through a type-to-confirm dialog first
 * (`../shared/delete_confirm.mjs`); this function itself has no confirmation
 * of its own, by design (the same "the DOM layer decides when to call, this
 * layer just calls" split every other function here already keeps).
 */
export async function deleteModel(kind, name) {
  if (!kind || !name) {
    return { reason: "invalid_kind", message: "No model selected.", removed: [] };
  }
  try {
    const r = await fetch(DELETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name }),
    });
    const j = await r.json();
    if (j && typeof j.reason === "string") {
      return j;
    }
    return { reason: "offline", message: "The delete route sent an unreadable reply.", removed: [] };
  } catch (err) {
    return {
      reason: "offline",
      message: `Could not reach the delete route (${err && err.message ? err.message : err}).`,
      removed: [],
    };
  }
}

/**
 * `POST /wtn/model_browser/save_preview` -- the ⓘ backfill's own missing
 * half (`docs/lora-loader-design.md` §7c-iv, "the backfill must save the
 * image too"): hands back the URL of whichever candidate the CALLER is
 * already displaying (level-filtered by construction -- this function makes
 * no leveling decision of its own) so it gets saved next to the model on
 * disk, instead of being re-fetched from Civitai on every render forever.
 * Always resolves to `{reason, message, saved, detail, path}` --
 * `reason` is one of `invalid_kind`/`not_found`/`ok` from the route itself
 * (`saved: false` on `"ok"` is a correct no-op -- `detail` names why:
 * `"no_url"`/`"already_present"`/`"fetch_failed"` -- never an error), or this
 * function's own `offline` degrade for a transport failure. A falsy
 * `previewUrl` is sent through as-is (the route's own `"no_url"` no-op
 * handles it); callers should still prefer skipping the call entirely when
 * they have no candidate at all (`docs/TODO.md`: "no candidate passes ⇒ send
 * nothing").
 */
export async function savePreview(kind, name, previewUrl) {
  if (!kind || !name) {
    return { reason: "invalid_kind", message: "No model selected.", saved: false, detail: null, path: null };
  }
  try {
    const r = await fetch(SAVE_PREVIEW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, name, preview_url: previewUrl }),
    });
    const j = await r.json();
    if (j && typeof j.reason === "string") {
      return j;
    }
    return { reason: "offline", message: "The save_preview route sent an unreadable reply.", saved: false, detail: null, path: null };
  } catch (err) {
    return {
      reason: "offline",
      message: `Could not reach the save_preview route (${err && err.message ? err.message : err}).`,
      saved: false,
      detail: null,
      path: null,
    };
  }
}

// ---------------------------------------------------------------------------
// M2 -- Civitai search + the streamed download queue (docs/lora-loader-
// design.md §9, `js/controls/civitai_search.mjs`'s own caller). Same
// never-throw discipline as `lookupInfo`/`forgetInfo` above: every function
// here ALWAYS resolves to the route's own `{reason, ...}` shape, degrading to
// a well-shaped `offline`/`unknown_job` response for anything that goes
// wrong on the way there (an unreachable dev server, a response that isn't
// even JSON) -- `civitai_search.mjs` has exactly one shape to branch on
// regardless of which hop actually failed, same reasoning as `lookupInfo`'s
// own doc comment.
// ---------------------------------------------------------------------------

/** `GET /wtn/model_browser/search` (docs/lora-loader-design.md §7c-i's full
 * filter set: base model / sort / period / maximum browsing level, plus a
 * free-text `query` and pagination `cursor`). Always resolves to `{reason,
 * message, results, next_cursor, public_only}` -- `reason` is one of
 * `invalid_kind`/`rate_limited`/`offline`/`ok` from the route itself, or this
 * function's own `offline` degrade for a transport failure (never reaches
 * the server at all, or the reply isn't JSON with a usable `reason`). No
 * client-side caching here -- unlike `listModels`, a search result depends on
 * the query string, so there is nothing sensible to key a cache by that
 * wouldn't just be "the whole query string," which buys nothing over
 * re-fetching.
 *
 * `level` (§7c-iv) replaces the old boolean `nsfw` parameter -- the numeric
 * Civitai bitmask value the "maximum browsing level" select resolves to
 * (`1` PG / `2` PG-13 / `4` R / `8` X / `16` XXX; `civitai_search.mjs`'s
 * `levelLabelToInt` is what turns the setting's own label string into this).
 * Always sent (never conditionally, unlike the old `nsfw` flag) -- the route
 * needs it to decide whether to ask Civitai for adult content at all (PG) or
 * fetch the fuller gallery for client-side filtering (everything above PG).
 * Defaults to `1` (PG) for a garbage/missing value, never throws. */
export async function searchModels(kind, { query = "", baseModel = "", sort = "", period = "", level = 1, cursor = "", limit } = {}) {
  if (!kind) {
    return { reason: "invalid_kind", message: "No model kind.", results: [], next_cursor: null, public_only: true };
  }
  const params = new URLSearchParams({ kind });
  if (query) {
    params.set("query", query);
  }
  if (baseModel) {
    params.set("base_model", baseModel);
  }
  if (sort) {
    params.set("sort", sort);
  }
  if (period) {
    params.set("period", period);
  }
  params.set("level", String(Number.isFinite(level) ? level : 1));
  if (cursor) {
    params.set("cursor", cursor);
  }
  if (limit) {
    params.set("limit", String(limit));
  }
  try {
    const r = await fetch(`${SEARCH_URL}?${params.toString()}`, { cache: "no-store" });
    const j = await r.json();
    if (j && typeof j.reason === "string") {
      return j;
    }
    return {
      reason: "offline",
      message: "The search route sent an unreadable reply.",
      results: [], next_cursor: null, public_only: true,
    };
  } catch (err) {
    return {
      reason: "offline",
      message: `Could not reach the search route (${err && err.message ? err.message : err}).`,
      results: [], next_cursor: null, public_only: true,
    };
  }
}

/**
 * `GET /wtn/model_browser/search` with NO `kind` locked -- the M2b toolbar
 * MODAL's own search (`js/controls/civitai_modal.mjs`), unlike `searchModels`
 * above, which is always kind-LOCKED (the two node-embedded pickers,
 * `docs/lora-loader-design.md` §7c: "the modal is unscoped"). Sends no
 * `kind` query param at all (rather than some sentinel string) -- the
 * absence of the param IS the "search every supported type" signal.
 *
 * `baseModels`/`modelTypes` are ARRAYS (§7c-i's rail: "a `<select>` per
 * multi-value filter" -- unlike the picker's own single-value `baseModel`
 * string). Each non-empty value is sent as its OWN REPEATED query-string
 * pair (`params.append`, one call per value) -- NEVER comma-joined -- under
 * the SAME singular keys `searchModels` above already uses (`base_model`/
 * `types`): one key, one meaning, one-or-many values, for both filters
 * alike. An empty array sends no pair for that filter at all (mirrors
 * `searchModels`'s own "omit rather than send an empty filter" convention
 * for `baseModel`/`sort`/`period`). Response shape is the SAME `{reason,
 * message, results, next_cursor, public_only}` `searchModels` already
 * returns, with one addition this function doesn't itself read: each
 * result carries its own `kind` (this pack's derived folder for that
 * Civitai model type, or `null` when we have none) -- `civitai_modal.mjs`'s
 * own `resultKind` is what reads that key, never this one.
 *
 * **Wire-contract fix, 2026-07-31**: this function used to comma-join both
 * filters under an invented plural key (`base_models`) for one of them --
 * the backend (`src/model_browser/api.py`/`civitai_search.py`) reads
 * REPEATED params via aiohttp's `getall`, so a comma-joined `types` value
 * failed `VALID_CIVITAI_TYPES` membership and was dropped, and
 * `base_models` (plural) was never read under any key at all (the route
 * reads `base_model`, singular) -- both filters silently did nothing. Fixed
 * by matching the wire format the backend actually parses; see
 * `src/model_browser/api.py`'s `_search_query_to_payload` and
 * `civitai_search.build_search_url` for the other end of this contract.
 */
export async function searchUnscoped({ query = "", baseModels = [], modelTypes = [], sort = "", period = "", level = 1, cursor = "", limit } = {}) {
  const params = new URLSearchParams();
  if (query) {
    params.set("query", query);
  }
  if (Array.isArray(baseModels)) {
    for (const value of baseModels) {
      if (value) {
        params.append("base_model", value);
      }
    }
  }
  if (Array.isArray(modelTypes)) {
    for (const value of modelTypes) {
      if (value) {
        params.append("types", value);
      }
    }
  }
  if (sort) {
    params.set("sort", sort);
  }
  if (period) {
    params.set("period", period);
  }
  params.set("level", String(Number.isFinite(level) ? level : 1));
  if (cursor) {
    params.set("cursor", cursor);
  }
  if (limit) {
    params.set("limit", String(limit));
  }
  try {
    const r = await fetch(`${SEARCH_URL}?${params.toString()}`, { cache: "no-store" });
    const j = await r.json();
    if (j && typeof j.reason === "string") {
      return j;
    }
    return {
      reason: "offline",
      message: "The search route sent an unreadable reply.",
      results: [], next_cursor: null, public_only: true,
    };
  } catch (err) {
    return {
      reason: "offline",
      message: `Could not reach the search route (${err && err.message ? err.message : err}).`,
      results: [], next_cursor: null, public_only: true,
    };
  }
}

/** `POST /wtn/model_browser/download/start` -- kicks off a server-side
 * streamed download (docs/lora-loader-design.md §9: "downloads are
 * server-side Python... this pack's frontend cannot write to `models/`
 * itself"). Always resolves to `{reason, message, job_id}` -- `reason` is one
 * of `invalid_kind`/`invalid_destination`/`already_installed`/`invalid_url`/
 * `too_large`/`busy`/`started` from the route itself, or this function's own
 * `offline` degrade for a transport failure. `job_id` is set ONLY when
 * `reason === "started"`; poll it via `downloadProgress` below.
 *
 * `civitaiMeta`/`previewUrl` -- the sidecar-seeding fields `api.py`'s route
 * has accepted since `4965389` but `civitai_search.mjs` never actually sent
 * (task brief: "the whole sidecar feature is dead code today"). Both are
 * OPTIONAL and passed through as-is: `civitai_meta` is the caller's own
 * normalized search-result fields for this exact result (so the backend can
 * seed a `.civitai.info` sidecar with no second lookup); `preview_url` is the
 * URL of whichever candidate the caller's own card is currently showing
 * (already level-filtered by the caller -- this function makes no leveling
 * decision of its own), or omitted entirely when nothing passed the level.
 * Neither is required -- a caller with nothing to send (a legacy/garbage
 * result) simply omits them, and the route's own `payload.get(...)` already
 * treats an absent key as `None`. */
export async function startDownload({ kind, subfolder = "", filename, downloadUrl, sizeKb, civitaiMeta, previewUrl } = {}) {
  if (!kind || !filename || !downloadUrl) {
    return { reason: "invalid_destination", message: "Missing required download fields.", job_id: null };
  }
  try {
    const body = { kind, subfolder, filename, download_url: downloadUrl, size_kb: sizeKb };
    if (civitaiMeta && typeof civitaiMeta === "object") {
      body.civitai_meta = civitaiMeta;
    }
    if (typeof previewUrl === "string" && previewUrl) {
      body.preview_url = previewUrl;
    }
    const r = await fetch(DOWNLOAD_START_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j && typeof j.reason === "string") {
      return j;
    }
    return { reason: "offline", message: "The download route sent an unreadable reply.", job_id: null };
  } catch (err) {
    return {
      reason: "offline",
      message: `Could not reach the download route (${err && err.message ? err.message : err}).`,
      job_id: null,
    };
  }
}

/** `GET /wtn/model_browser/download/progress?job_id=` -- a thin poll.
 * Always resolves to `{reason, status, bytes, total, message}` (`reason` is
 * `"ok"`/`"unknown_job"` from the route, or this function's own `offline`
 * degrade for a transport failure) -- `status` is only meaningful when
 * `reason === "ok"`: `"downloading"`/`"cancelling"` (still running),
 * `"ok"`/`"cancelled"`/`"too_large"`/`"key_required"`/`"write_error"`/
 * `"offline"` (terminal). */
export async function downloadProgress(jobId) {
  if (!jobId) {
    return { reason: "unknown_job", message: "No job id.", status: null, bytes: 0, total: null };
  }
  try {
    const r = await fetch(`${DOWNLOAD_PROGRESS_URL}?job_id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
    const j = await r.json();
    if (j && typeof j.reason === "string") {
      return j;
    }
    return { reason: "offline", message: "The progress route sent an unreadable reply.", status: null, bytes: 0, total: null };
  } catch (err) {
    return {
      reason: "offline",
      message: `Could not reach the progress route (${err && err.message ? err.message : err}).`,
      status: null, bytes: 0, total: null,
    };
  }
}

// ---------------------------------------------------------------------------
// The model/version DETAIL VIEW's own backend (`docs/lora-loader-design.md`
// "The detail view" / §7c-ii / §7d-i) -- `js/controls/model_detail_view.mjs`'s
// caller (`civitai_search.mjs`'s picker mount, `civitai_modal.mjs`'s modal
// mount) is who actually calls this; the render component itself never
// fetches anything on its own (that file's own top doc comment).
//
// Cached per `(model_id, version_id)`, mirroring `_infoCache`'s own "cache
// the last-known response, dedupe an in-flight call" shape above -- a user
// flipping back and forth between two versions (or reopening the same
// model's detail view a second time this session) costs no second request.
// ---------------------------------------------------------------------------

const _modelDetailCache = new Map(); // "modelId versionId" -> the route's last response dict
const _modelDetailPromise = new Map(); // "modelId versionId" -> in-flight promise (de-dupes concurrent callers)

function modelDetailKey(modelId, versionId) {
  return `${modelId} ${versionId}`;
}

/** Drops the cached detail for `(modelId, versionId)` -- exists for
 * completeness/tests; no real caller forces a re-fetch today (unlike
 * `invalidateInfo`, there is no "Forget cached"-shaped action for THIS
 * data). */
export function invalidateModelDetail(modelId, versionId) {
  _modelDetailCache.delete(modelDetailKey(modelId, versionId));
}

/** The last-cached `fetchModelDetail` response for `(modelId, versionId)`,
 * read with NO network of its own -- `null` if nothing has ever resolved
 * this session. Never triggers a fetch (same "read-only, never causes a
 * request" contract as `cachedInfo`). */
export function cachedModelDetail(modelId, versionId) {
  return _modelDetailCache.get(modelDetailKey(modelId, versionId)) || null;
}

/**
 * `GET /wtn/model_browser/model_detail?model_id=...&version_id=...` -- the
 * two things a search result doesn't already carry for `versionId`: its own
 * `version_description` + the author's prompt-carrying `gallery`, plus the
 * MODEL's own `model_description` (fetched once per model, independent of
 * which version is selected -- `src/model_browser/model_detail.py`'s own
 * doc comment has the full contract).
 *
 * Always resolves -- never rejects -- to `{reason: "found"|"notfound"|
 * "offline"|"rate_limited", message, offline_reason, model_description,
 * model_description_checked, version_description, gallery}`; a transport
 * failure (unreachable dev server, an unreadable reply) degrades to the
 * SAME `offline` shape the route itself uses, so a caller has exactly one
 * shape to branch on regardless of which hop actually failed -- same
 * discipline as `lookupInfo`.
 *
 * A GARBAGE `modelId`/`versionId` (missing, non-numeric) still reaches the
 * network -- the ROUTE is what validates/rejects them (`notfound` for an
 * unusable `version_id`, `src/model_browser/model_detail.py`'s own
 * `_clean_positive_int`) -- this function has no whitelist of its own to
 * enforce, mirroring `searchModels`'s "the backend re-validates regardless"
 * posture for every other network call in this file.
 */
export async function fetchModelDetail(modelId, versionId) {
  const key = modelDetailKey(modelId, versionId);
  if (_modelDetailPromise.has(key)) {
    return _modelDetailPromise.get(key);
  }
  const p = (async () => {
    try {
      const params = new URLSearchParams();
      if (modelId != null) {
        params.set("model_id", String(modelId));
      }
      if (versionId != null) {
        params.set("version_id", String(versionId));
      }
      const r = await fetch(`${MODEL_DETAIL_URL}?${params.toString()}`, { cache: "no-store" });
      const j = await r.json();
      if (j && typeof j.reason === "string") {
        _modelDetailCache.set(key, j);
        return j;
      }
      return {
        reason: "offline",
        message: "The model_detail route sent an unreadable reply.",
        offline_reason: null,
        model_description: null,
        model_description_checked: false,
        version_description: null,
        gallery: [],
      };
    } catch (err) {
      return {
        reason: "offline",
        message: `Could not reach the model_detail route (${err && err.message ? err.message : err}).`,
        offline_reason: null,
        model_description: null,
        model_description_checked: false,
        version_description: null,
        gallery: [],
      };
    } finally {
      if (_modelDetailPromise.get(key) === p) {
        _modelDetailPromise.delete(key);
      }
    }
  })();
  _modelDetailPromise.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Community images (`docs/lora-loader-design.md` "BOTH galleries, for
// different reasons" -- the BOTTOM grid, "what it looks like in other
// people's hands", as opposed to `fetchModelDetail`'s own AUTHOR gallery
// above). Cached per `(versionId, limit)`, session-indefinite -- same shape
// as `_modelDetailCache`, except THIS cache is checked BEFORE a network call
// is even made (mirroring `listModels`'s own cache-first `!force &&
// _cache.has(key)` short-circuit, not `fetchModelDetail`'s "always re-fetch,
// caller decides when to call" contract): `model_detail_view.mjs`'s own
// section fetches this lazily, on an `IntersectionObserver` that can fire
// more than once (a rebuild that re-mounts the whole detail view re-creates
// the observer too), so THIS layer is the second, defence-in-depth guarantee
// behind that component's own "already started" flag that a version's
// community images are ever requested over the network at most once per
// session.
// ---------------------------------------------------------------------------

const _communityImagesCache = new Map(); // "versionId limit" -> {reason, images}
const _communityImagesPromise = new Map(); // same key -> in-flight promise (de-dupes concurrent callers)

function communityImagesKey(versionId, limit) {
  return `${versionId} ${limit}`;
}

/** Drops the cached community-images response for `(versionId, limit)` (or
 * every entry, if `versionId` is omitted) -- exists for completeness/tests;
 * no real caller forces a re-fetch today, same as `invalidateModelDetail`. */
export function invalidateCommunityImages(versionId, limit) {
  if (versionId == null) {
    _communityImagesCache.clear();
    return;
  }
  _communityImagesCache.delete(communityImagesKey(versionId, limit));
}

/**
 * `GET /wtn/model_browser/community_images?version_id=...&limit=...` -- the
 * COMMUNITY's own gallery (`src/model_browser/api.py`'s
 * `community_images_impl`, the literal wire contract this function is built
 * against): "what it looks like in other people's hands", not a prompt
 * source -- `images` never carries a `prompt` key, by design, on the Python
 * side.
 *
 * Always resolves -- never rejects -- to `{reason: "ok"|"notfound"|
 * "offline"|"rate_limited", images: [...]}`. The route itself ALWAYS answers
 * HTTP 200 with `ok: true` at the transport level (§"a failed or empty fetch
 * must never turn a working detail view into a broken one") -- `reason` is
 * where the actual outcome lives, not the HTTP status; a transport failure
 * here (unreachable dev server, an unreadable reply) degrades to the SAME
 * `{reason: "offline", images: []}` shape, so a caller has exactly one shape
 * to branch on regardless of which hop actually failed -- same discipline as
 * `fetchModelDetail`. `images` is `[]` on every branch except a genuine
 * `"ok"`.
 *
 * A GARBAGE `versionId` still reaches the network -- the ROUTE is what
 * validates it (`"notfound"` for an unusable `version_id`) -- this function
 * has no whitelist of its own, mirroring every other call in this file.
 *
 * Cache-first, unlike `fetchModelDetail`: a call for a `(versionId, limit)`
 * already resolved this session returns the cached response with NO second
 * network round trip -- only a NON-"ok" reason from a genuine transport
 * failure (this function's own `catch`) is left uncached, so a real outage
 * can still recover on a later call rather than being pinned as "offline"
 * for the rest of the session.
 */
export async function fetchCommunityImages(versionId, limit = 24) {
  const key = communityImagesKey(versionId, limit);
  if (_communityImagesCache.has(key)) {
    return _communityImagesCache.get(key);
  }
  if (_communityImagesPromise.has(key)) {
    return _communityImagesPromise.get(key);
  }
  const p = (async () => {
    try {
      const params = new URLSearchParams();
      if (versionId != null) {
        params.set("version_id", String(versionId));
      }
      if (limit != null) {
        params.set("limit", String(limit));
      }
      const r = await fetch(`${COMMUNITY_IMAGES_URL}?${params.toString()}`, { cache: "no-store" });
      const j = await r.json();
      if (j && typeof j.reason === "string" && Array.isArray(j.images)) {
        const result = { reason: j.reason, images: j.images };
        _communityImagesCache.set(key, result);
        return result;
      }
      return { reason: "offline", images: [] };
    } catch (err) {
      return { reason: "offline", images: [] };
    } finally {
      if (_communityImagesPromise.get(key) === p) {
        _communityImagesPromise.delete(key);
      }
    }
  })();
  _communityImagesPromise.set(key, p);
  return p;
}

/** `POST /wtn/model_browser/download/cancel` -- always resolves to
 * `{reason, message}` (`"cancelling"`/`"unknown_job"` from the route, or this
 * function's own `offline` degrade). Cancellation is cooperative -- the next
 * `downloadProgress` poll is what actually observes the job reaching
 * `"cancelled"`, this call only requests it. */
export async function cancelDownload(jobId) {
  if (!jobId) {
    return { reason: "unknown_job", message: "No job id." };
  }
  try {
    const r = await fetch(DOWNLOAD_CANCEL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    });
    const j = await r.json();
    return j && typeof j === "object" ? j : { reason: "offline", message: "" };
  } catch (err) {
    return { reason: "offline", message: `Could not reach the cancel route (${err && err.message ? err.message : err}).` };
  }
}
