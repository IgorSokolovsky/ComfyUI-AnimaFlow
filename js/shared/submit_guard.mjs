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
 *
 * ## `onGraphToPromptResult` — the stale-model diagnostic's tap (added for
 * the "AnimaLoaderPanel generates with a stale model" investigation)
 *
 * This module is already the ONE place `app.graphToPrompt` is wrapped —
 * extending it with a read-only result tap is the least invasive way to see
 * what a submit actually carried, rather than adding a SECOND wrap of
 * `app.graphToPrompt` next to this one (exactly the fragility
 * `docs/lora-loader-design.md` §3 warns about). `js/controls/index.js`'s
 * `installStateDiagnosticHook` is the one real caller: it registers a
 * listener that reads the resolved `{workflow, output}` (confirmed by
 * reading the installed `comfyui_frontend_package`'s own
 * `dialogService-*.js` bundle — `app.graphToPrompt(e) { return
 * graphToPrompt(e, {...}) }`, whose body ends `return {workflow: r, output:
 * a}`, `a` keyed by node id with `{inputs, class_type, _meta}` — and
 * crucially reads each widget's LIVE `.value` via `serializeValue`/`i.value`
 * at call time, not a cached snapshot) and compares it against each node's
 * own live widget value.
 *
 * Fired from a SEPARATE `.then()` chain with its own `.catch()`, exactly
 * like `js/controls/index.js`'s existing `advanceSeedsAfterRun` pattern for
 * `app.queuePrompt` above this module — so a listener that throws (or the
 * whole diagnostic feature) can NEVER affect what `graphToPrompt` itself
 * returns to its real caller, delay it, or turn a queue attempt into a
 * rejection. Every listener call is ALSO individually try/caught
 * (`notifyGraphToPromptListeners` below), so one bad listener can't stop a
 * second one from running.
 */
import { app } from "/scripts/app.js";

const TRAILING_MS = 600; // generous -- see this module's own doc comment for why

let _submitting = false;
let _clearTimer = null;

// See this module's own "onGraphToPromptResult" doc comment above.
const _graphToPromptListeners = [];

/** Register `fn` to run every time `app.graphToPrompt` resolves, called with
 * the EXACT resolved value (whatever `graphToPrompt` itself hands back —
 * `{workflow, output}` on the currently installed frontend build, per this
 * module's own doc comment). No unregister — every real caller registers at
 * most once per page load, module-level-guarded exactly like every other
 * "wrap once" mechanism in this pack (`js/controls/index.js`'s
 * `_stateDiagnosticWrapped`). A non-function `fn` is silently ignored rather
 * than queued, matching `wrapSubmitFn`'s own "absent capability, do nothing"
 * posture. */
export function onGraphToPromptResult(fn) {
  if (typeof fn === "function") {
    _graphToPromptListeners.push(fn);
  }
}

/** Fan `resolved` out to every registered listener, each wrapped in its own
 * try/catch — one listener throwing must never stop the next one, or ever
 * propagate up into the `graphToPrompt` call chain that triggered it (this
 * module's own doc comment: "can NEVER affect what graphToPrompt itself
 * returns"). */
function notifyGraphToPromptListeners(resolved) {
  for (const listener of _graphToPromptListeners) {
    try {
      listener(resolved);
    } catch (err) {
      console.error("[AnimaFlow] a graphToPrompt-result listener threw (ignored):", err);
    }
  }
}

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
      if (fnName === "graphToPrompt") {
        // A SEPARATE chain from the one above, with its own `.catch()` --
        // see `onGraphToPromptResult`'s own doc comment for why this can
        // never affect `result` (the real return value) or the timing of
        // the trailing window just above.
        Promise.resolve(result).then(notifyGraphToPromptListeners).catch(() => {});
      }
    }
    return result;
  };
}

wrapSubmitFn("queuePrompt");
wrapSubmitFn("graphToPrompt");

export function isSubmitting() {
  return _submitting;
}
