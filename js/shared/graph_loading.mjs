/**
 * graph_loading.mjs — the shared "is a workflow currently loading?" guard.
 * Ported from `../ComfyUI-Pixaroma/js/shared/graph_loading.mjs` (MIT ©
 * pixaroma, credited in `THIRD_PARTY_NOTICES.md`) — this repo's own
 * `js/anima/index.js` hit the exact bug that module exists to fix (see its
 * own top comment, reproduced below with this pack's own trace): a fresh
 * page load or workflow re-open snapped `AnimaGenerator` back to its
 * hardcoded default size (`360×340`) instead of the saved one.
 *
 * ## Why a per-node `onConfigure` flag (what this pack already had) is NOT
 * enough
 *
 * `js/anima/index.js`'s `onConfigure` wrapper sets `node._anConfiguring =
 * true` synchronously, before its own `loadMods().then(...)` microtask
 * queues — the intent being "any sizing code that runs while this flag is
 * set knows a restore, not a fresh placement, is in progress." That's true
 * for code running SYNCHRONOUSLY inside `onConfigure` itself, but this
 * pack's actual sizing logic runs from `onNodeCreated`'s OWN deferred
 * `loadMods().then(setupNode)` — and `onNodeCreated` fires for a RESTORED
 * node too (litegraph's construct-then-configure sequence calls it before
 * `onConfigure`, not instead of it). ComfyUI's `app.loadGraphData` is
 * itself async, so there is a real window where `onNodeCreated`'s own
 * microtask resolves and runs BEFORE `onConfigure` has had a chance to set
 * `_anConfiguring` at all — during that window `node.size` still holds
 * litegraph's tiny freshly-constructed default, and any code that floors
 * the size up from THAT (this pack's `setupNode`, `Math.max(curW, wFloor)`
 * etc) stamps the fresh-node floor over whatever the saved workflow was
 * about to restore. Confirmed live: `[setSize] [360,340] id 747` — exactly
 * this module's `DEFAULT_W`/`DEFAULT_H`, on an already-saved node.
 *
 * ## The fix — wrap the one funnel every load goes through
 *
 * `app.loadGraphData` is the single function ComfyUI calls for workflow
 * open, tab switch, and Ctrl+Z undo alike. Wrapping it ONCE (idempotent —
 * `app._wtnGraphLoadWrapped` guards a hot-reload re-wrap) and holding a
 * flag true for the whole call PLUS a short trailing window (the graph-
 * level link/state restore settles a tick after the promise itself does)
 * gives every node in this pack a single, load-order-independent signal:
 * `isGraphLoading()`. Any load-sensitive mutation should gate on
 * `!isGraphLoading()` IN ADDITION to whatever per-node flag it already
 * uses — the two cover different windows (this one covers BEFORE
 * `onConfigure` even runs; a per-node flag covers the window an async
 * `loadMods()` import takes DURING/AFTER `onConfigure`), and both are
 * needed for belt-and-braces coverage.
 *
 * No `node`/`LiteGraph` reference beyond `app` itself — this module is a
 * plain library `.mjs` (not one of the pack's 5 auto-loaded `.js` entry
 * points), imported lazily by whichever `index.js` needs it.
 */
import { app } from "/scripts/app.js";

let _loading = false;

if (app && app.loadGraphData && !app._wtnGraphLoadWrapped) {
  app._wtnGraphLoadWrapped = true;
  const _origLoadGraphData = app.loadGraphData.bind(app);
  app.loadGraphData = function (...args) {
    _loading = true;
    let r;
    try {
      r = _origLoadGraphData(...args);
    } finally {
      // `loadGraphData` may be sync or async in different ComfyUI builds --
      // clear the flag after it settles, plus a short trailing window for
      // the graph-level link/state restore that finishes a tick later.
      Promise.resolve(r).finally(() => setTimeout(() => { _loading = false; }, 300));
    }
    return r;
  };
}

export function isGraphLoading() {
  return _loading;
}
