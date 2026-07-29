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
 * This file, `model_picker.mjs`, and (Slice 4) `model_info.mjs` are what
 * `AnimaLoaderPanel` will import at M3 (the plan's whole reuse boundary,
 * `docs/lora-loader-design.md` build-plan §"Architecture"). **None of the
 * three may ever import a `lora_*` module** — that's the layering guard in
 * `test_model_picker.mjs` (precedent: `js/shared/test_field_logic.mjs`'s own
 * guard for `js/shared/` vs a track). This file has zero imports at all
 * beyond the standard library, so it trivially satisfies that from day one.
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
