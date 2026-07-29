/**
 * test_refresh.mjs — regression tests for `refresh.mjs`'s three exports:
 * `onNodeDefsRefresh`, `runRefreshHandlers`, `installRefreshHook`. Plain
 * `node`, no DOM/`app`/`window` -- `refresh.mjs` itself never touches any of
 * those (its own top doc comment), and per `js/shared/test_field_logic.mjs`'s
 * layering guard, nothing under `js/shared/` may import a track, so this file
 * doesn't either.
 *
 * Covers:
 *   - `onNodeDefsRefresh` registers a handler that actually fires on the next
 *     refresh signal.
 *   - Registering the SAME function reference twice does not stack it --
 *     `_handlers` is a `Set`, so it still only runs once (the module's own
 *     idempotency: re-registering never means "run twice").
 *   - `runRefreshHandlers` collapses several calls made in the SAME microtask
 *     turn into one firing per handler (the doc comment's "many node
 *     instances of the same type can call this in one refresh pass"), but
 *     is NOT a one-shot -- a later call (after the previous batch already
 *     ran) fires again.
 *   - A throwing handler is swallowed and never stops the other registered
 *     handlers, nor breaks the microtask itself.
 *   - `installRefreshHook` wraps (never replaces) an existing
 *     `refreshComboInNode` on the prototype: the original still runs, its
 *     return value still passes through, `this`/arguments still forward, AND
 *     it triggers a `runRefreshHandlers` pass as a side effect.
 *   - Calling `installRefreshHook` with NO pre-existing `refreshComboInNode`
 *     still installs a working hook that returns `undefined` and still fires
 *     the refresh handlers.
 *
 * `refresh.mjs` exports no unregister/teardown function -- there is nothing
 * to "uninstall" a handler once added (the module's whole point is a
 * write-only-until-page-reload registry, mirrored from
 * `../ComfyUI-Pixaroma/js/shared/refresh.mjs`), so this file does not invent
 * one to test. See this file's own bottom section for the
 * `findLoraNodes`/`wireLoraRefresh` testability ruling -- NOT covered here,
 * on purpose: both live in `js/controls/index.js`, which has a top-level
 * absolute `/scripts/app.js` import and needs a real `app`/`window.LiteGraph`
 * (same "never import index.js directly" rule as
 * `js/controls/test_resize.mjs` and `js/controls/test_lora_resize.mjs`).
 */

import assert from "node:assert/strict";

import { onNodeDefsRefresh, runRefreshHandlers, installRefreshHook } from "./refresh.mjs";

let failures = 0;
let count = 0;
async function test(name, fn) {
  count += 1;
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

/** One microtask turn -- `runRefreshHandlers` fires its handlers via
 * `queueMicrotask`, which is FIFO with `Promise` continuations, so a single
 * `await` here always runs AFTER an already-queued `queueMicrotask` callback
 * scheduled earlier in the same synchronous stretch of code. */
async function flush() {
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// onNodeDefsRefresh / runRefreshHandlers -- registration and firing.
// ---------------------------------------------------------------------------

await test("onNodeDefsRefresh: a registered handler fires after runRefreshHandlers + a microtask flush", async () => {
  let calls = 0;
  onNodeDefsRefresh(() => {
    calls += 1;
  });
  assert.equal(calls, 0, "must not fire synchronously on registration");
  runRefreshHandlers();
  assert.equal(calls, 0, "must not fire synchronously on runRefreshHandlers() itself -- it's queued");
  await flush();
  assert.equal(calls, 1);
});

await test("onNodeDefsRefresh: multiple distinct handlers all fire from one runRefreshHandlers() pass", async () => {
  let a = 0;
  let b = 0;
  onNodeDefsRefresh(() => {
    a += 1;
  });
  onNodeDefsRefresh(() => {
    b += 1;
  });
  runRefreshHandlers();
  await flush();
  assert.equal(a, 1);
  assert.equal(b, 1);
});

await test("onNodeDefsRefresh: registering the SAME function reference twice does not stack it -- it still only runs once per pass (Set dedup)", async () => {
  let calls = 0;
  function handler() {
    calls += 1;
  }
  onNodeDefsRefresh(handler);
  onNodeDefsRefresh(handler); // same reference, second registration
  runRefreshHandlers();
  await flush();
  assert.equal(calls, 1, "re-registering the identical function must not make it run twice in one pass");
});

// ---------------------------------------------------------------------------
// runRefreshHandlers -- microtask-batch dedup, but not a permanent one-shot.
// ---------------------------------------------------------------------------

await test("runRefreshHandlers: several calls in the SAME synchronous turn collapse into ONE firing per handler", async () => {
  let calls = 0;
  onNodeDefsRefresh(() => {
    calls += 1;
  });
  runRefreshHandlers();
  runRefreshHandlers();
  runRefreshHandlers();
  await flush();
  assert.equal(calls, 1, "three calls made before any microtask ran must still only fire the handler once");
});

await test("runRefreshHandlers: NOT a one-shot -- a later call (after the previous batch already fired) fires again", async () => {
  let calls = 0;
  onNodeDefsRefresh(() => {
    calls += 1;
  });
  runRefreshHandlers();
  await flush();
  assert.equal(calls, 1);

  runRefreshHandlers();
  await flush();
  assert.equal(calls, 2, "a fresh refresh pass after the previous one has already fully run must fire the handler again");
});

// ---------------------------------------------------------------------------
// A throwing handler must not stop the rest, or the microtask itself.
// ---------------------------------------------------------------------------

await test("runRefreshHandlers: a throwing handler is swallowed and never stops the OTHER registered handlers", async () => {
  let good = 0;
  onNodeDefsRefresh(() => {
    throw new Error("boom -- a deliberately bad handler");
  });
  onNodeDefsRefresh(() => {
    good += 1;
  });
  await assert.doesNotReject(async () => {
    runRefreshHandlers();
    await flush();
  }, "the throwing handler must never surface as an unhandled rejection / thrown microtask error");
  assert.equal(good, 1, "a handler registered alongside a throwing one must still run");
});

// ---------------------------------------------------------------------------
// installRefreshHook -- composes with (never replaces) an existing
// refreshComboInNode, and always triggers a refresh pass as a side effect.
// ---------------------------------------------------------------------------

await test("installRefreshHook: with NO pre-existing refreshComboInNode, installs a hook that returns undefined and still triggers a refresh pass", async () => {
  let calls = 0;
  onNodeDefsRefresh(() => {
    calls += 1;
  });

  function FakeNodeType() {}
  installRefreshHook(FakeNodeType);

  const instance = new FakeNodeType();
  const result = instance.refreshComboInNode();
  assert.equal(result, undefined, "no orig hook -- nothing to return");

  await flush();
  assert.equal(calls, 1, "installRefreshHook's wrapper must call runRefreshHandlers() even with no pre-existing hook");
});

await test("installRefreshHook: wraps an EXISTING refreshComboInNode -- orig still runs, its return value passes through, this/arguments forward", async () => {
  let calls = 0;
  onNodeDefsRefresh(() => {
    calls += 1;
  });

  function FakeNodeType() {}
  let origCalledWith = null;
  let origThis = null;
  FakeNodeType.prototype.refreshComboInNode = function (defs) {
    origCalledWith = defs;
    origThis = this;
    return "orig-return-value";
  };

  installRefreshHook(FakeNodeType);

  const instance = new FakeNodeType();
  const defsArg = { some: "defs" };
  const result = instance.refreshComboInNode(defsArg);

  assert.equal(result, "orig-return-value", "the original hook's return value must still pass through the wrapper");
  assert.equal(origCalledWith, defsArg, "the original hook must still receive its argument");
  assert.equal(origThis, instance, "the original hook must still run with the real node instance as `this`");

  await flush();
  assert.equal(calls, 1, "wrapping an existing hook must still trigger a refresh pass");
});

await test("installRefreshHook: composes across TWO node types -- each keeps its OWN original, both still trigger the shared refresh pass", async () => {
  let calls = 0;
  onNodeDefsRefresh(() => {
    calls += 1;
  });

  function TypeA() {}
  function TypeB() {}
  let aOrigRan = false;
  let bOrigRan = false;
  TypeA.prototype.refreshComboInNode = function () {
    aOrigRan = true;
    return "a";
  };
  TypeB.prototype.refreshComboInNode = function () {
    bOrigRan = true;
    return "b";
  };

  installRefreshHook(TypeA);
  installRefreshHook(TypeB);

  const resultA = new TypeA().refreshComboInNode();
  const resultB = new TypeB().refreshComboInNode();

  assert.equal(resultA, "a");
  assert.equal(resultB, "b");
  assert.ok(aOrigRan);
  assert.ok(bOrigRan);

  await flush();
  assert.equal(calls, 1, "both node types firing in the same synchronous turn must still collapse to one shared refresh pass");
});

await test("installRefreshHook: installing TWICE on the SAME nodeType composes (never wipes the earlier wrap) and still only fires the handler ONCE per pass -- runRefreshHandlers's own scheduling flag absorbs the double call, so the double-install is harmless even though installRefreshHook itself has no re-entry guard (that's documented as the CALLER's job, e.g. `_wtnLoraPatched` in js/controls/index.js)", async () => {
  let calls = 0;
  onNodeDefsRefresh(() => {
    calls += 1;
  });

  function FakeNodeType() {}
  let origRuns = 0;
  FakeNodeType.prototype.refreshComboInNode = function () {
    origRuns += 1;
    return "base";
  };

  installRefreshHook(FakeNodeType);
  installRefreshHook(FakeNodeType); // deliberately called twice, mirrors a missing caller-side guard

  const result = new FakeNodeType().refreshComboInNode();

  assert.equal(result, "base", "the original base hook must still run and its value still surface through both wraps");
  assert.equal(origRuns, 1, "the base hook itself is only reachable once per call, however many times it was wrapped");

  await flush();
  assert.equal(calls, 1, "even though refreshComboInNode's wrapper calls runRefreshHandlers() twice in this stacked case, the microtask scheduling flag collapses it to ONE actual handler firing");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
