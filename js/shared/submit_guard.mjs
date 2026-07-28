/**
 * submit_guard.mjs — the shared "is a prompt currently being submitted?"
 * guard. Same shape as `js/shared/graph_loading.mjs`'s `isGraphLoading()`
 * (wrap the one funnel every call goes through, hold a flag for the
 * duration plus a trailing window), for a DIFFERENT churn window: a
 * connect-then-disconnect burst from **cg-use-everywhere** (and any other
 * extension that materializes real litegraph links at submit time to build
 * the prompt, then removes them again) rather than a workflow LOAD.
 *
 * ## The bug this fixes (`js/anima/index.js`'s two `onConnectionsChange`
 * hooks — the Bridge's forward-walk one and the Generator's own)
 *
 * Live instrumentation on `AnimaContextBridge`'s `onConnectionsChange`
 * during a run printed a burst like:
 *
 *   [bridge conn] 1 0 true   1 1 true   1 2 true   1 5 true   1 6 true  ...
 *   [bridge conn] 1 0 false  1 1 false  1 2 false  1 5 false  1 6 false ...
 *
 * — a full connect, then a full disconnect, across every Use-Everywhere-fed
 * socket, right around prompt submission. Both of this pack's
 * `onConnectionsChange` hooks call `clearContextRun` on every connection
 * change (the correct thing to do for a genuine user rewire — a stale
 * "context supplied" report must never outlive the wiring it described).
 * The UE churn defeats that: it wipes `node._anContextRun` right after
 * `handleGeneratorExecuted` stashed the run's own post-run truth, which is
 * why a context-supplied field never actually greyed out after a run —
 * `computeEffectiveContextSupplied` had nothing left to read. Both signals
 * (`supplied`/`values`) were verified correct up to that point; only this
 * clear was throwing them away.
 *
 * ## The fix
 *
 * Wrap the submission entry point(s) — `app.queuePrompt` (the documented
 * "user clicked Queue" entry point) AND `app.graphToPrompt` (the function
 * that actually SERIALIZES the graph into a prompt payload, and — per how
 * UE-style extensions are documented to work — the more likely place a
 * link-injecting extension hooks in, since it needs the links present
 * during serialization and gone again once it's done) — hold `_submitting`
 * true for the call plus a GENEROUS trailing window. "Generous" is
 * deliberate: the `executed` message and the UE teardown are both async,
 * and this dev environment has no live ComfyUI process to pin down which
 * one can land first — a short window risks the guard closing before a
 * late teardown arrives (reintroducing the bug), while a longer one costs
 * nothing except (rarely) tolerating one extra spurious connection-change
 * churn as "submitting" a little longer than strictly necessary. Callers
 * (`js/anima/index.js`'s two `onConnectionsChange` hooks) skip BOTH
 * `clearContextRun` AND the repaint entirely while `isSubmitting()` is
 * true — the repaint is skipped too because the observed churn fires the
 * hook roughly a dozen times per run, and a full-body rebuild on every one
 * of those is pure waste for a connection change that was never a real
 * rewire in the first place.
 *
 * **Do not remove this guard** without also fixing the churn at its
 * source — doing so silently reintroduces "post-run context-supplied
 * values never appear."
 */
import { app } from "/scripts/app.js";

const TRAILING_MS = 600; // generous -- see this module's own doc comment for why

let _submitting = false;
let _clearTimer = null;

function armSubmitting() {
  _submitting = true;
  if (_clearTimer !== null) {
    clearTimeout(_clearTimer);
    _clearTimer = null;
  }
}

function releaseSubmittingLater() {
  if (_clearTimer !== null) {
    clearTimeout(_clearTimer);
  }
  _clearTimer = setTimeout(() => {
    _submitting = false;
    _clearTimer = null;
  }, TRAILING_MS);
}

function wrapSubmitFn(fnName) {
  if (!app || typeof app[fnName] !== "function") {
    return;
  }
  const guardFlag = `_wtnSubmitWrapped_${fnName}`;
  if (app[guardFlag]) {
    return; // hot-reload guard -- never double-wrap
  }
  app[guardFlag] = true;
  const original = app[fnName].bind(app);
  app[fnName] = function (...args) {
    armSubmitting();
    let result;
    try {
      result = original(...args);
    } finally {
      // Sync or async return -- either way, the window closes AFTER this
      // call settles (Promise.resolve on a non-promise value resolves on
      // the next microtask), plus the trailing window on top of that.
      Promise.resolve(result).finally(releaseSubmittingLater);
    }
    return result;
  };
}

wrapSubmitFn("queuePrompt");
wrapSubmitFn("graphToPrompt");

export function isSubmitting() {
  return _submitting;
}
