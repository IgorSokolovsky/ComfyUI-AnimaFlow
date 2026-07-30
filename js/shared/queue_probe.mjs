/**
 * queue_probe.mjs — the queue-time state probe for the stale-model
 * investigation (`.claude/CLAUDE.md` Task 2, 2026-07-30).
 *
 * ## The clue this probe is built around
 *
 * The owner's decisive measurement: manually running `app.graphToPrompt()`
 * in the console BEFORE queueing always fixed the bug; not doing so always
 * reproduced it. That means invoking `graphToPrompt` a SECOND time changes
 * the outcome — so any probe that itself calls (or wraps and thereby
 * "wakes") `graphToPrompt` risks creating the very condition it exists to
 * observe. This probe therefore NEVER calls or wraps `graphToPrompt` — it
 * hooks `api.queuePrompt` instead (see the next section for why that's the
 * right point, confirmed by reading the installed frontend build rather
 * than assumed).
 *
 * ## What the Queue button actually calls (read off the installed
 * `comfyui_frontend_package` 1.47.10 build — `assets/GraphView-*.js` +
 * `assets/promotionUtils-*.js` + `assets/api-*.js`; re-verify against
 * whatever build is actually installed rather than trusting this comment)
 *
 * Queue button (`ComfyQueueButton-*.js`) → `re.execute("Comfy.QueuePrompt",
 * ...)` → the `Comfy.QueuePrompt` command's own handler → `app.queuePrompt(0,
 * batchCount)`. `ComfyApp.queuePrompt` (`promotionUtils-*.js`) THEN, per run,
 * does exactly this, in order:
 *
 *   let r = await this.graphToPrompt(this.rootGraph);   // the ONE call
 *   let c = await B.queuePrompt(e, r, {...});            // B === api
 *
 * — i.e. `app.queuePrompt` calls `graphToPrompt` itself exactly once, then
 * hands the already-serialized `{workflow, output}` result straight to
 * `api.queuePrompt` (`assets/api-*.js`: `async queuePrompt(e,t,n){let
 * {output:r,workflow:i}=t; ...}` — it destructures `output`/`workflow`
 * directly off its own second argument and POSTs `{prompt: r, ...}`).
 *
 * So `api.queuePrompt`'s SECOND argument's `.output` IS the literal per-node
 * prompt dict about to reach the backend — this probe reads it straight off
 * that call's own arguments. It never re-derives it, never calls
 * `graphToPrompt` a second time, and sits strictly DOWNSTREAM of the one
 * `graphToPrompt` call `app.queuePrompt` already made — tapping it costs
 * nothing extra and cannot itself mask (or fix) the bug the way re-invoking
 * `graphToPrompt` would.
 *
 * `app.queuePrompt` itself was deliberately NOT chosen as the hook point:
 * wrapping it only gives you its OWN arguments (`number`, `batchCount`) —
 * the actual prompt payload is a purely-internal local variable inside that
 * function, never passed to (or returned from) `app.queuePrompt` itself, so
 * observing it there would require calling `graphToPrompt` a second time
 * ourselves — exactly the thing this probe must not do.
 *
 * ## Safety
 *
 * Wrapped exactly once (guarded on `api` itself, surviving a hot reload of
 * this pack's own JS), and the probe body runs BEFORE delegating to the
 * real `api.queuePrompt`, wrapped in its own try/catch that can never
 * prevent (or alter the return value/timing of) the real call — a probe
 * failure is logged and swallowed, never surfaced as a broken queue. Also
 * gated on the LIVE `AnimaFlow.General.ConsoleLogging = "debug"` setting,
 * checked FIRST, before any graph walk — off by default, so this costs
 * nothing for a user who never turns on debug logging.
 */
import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { getSetting, SETTING_IDS, SETTING_DEFAULTS } from "./settings.mjs";
import * as fingerprint from "./queue_probe_fingerprint.mjs";

/** Every live node whose class this probe knows how to check
 * (`fingerprint.STATE_WIDGET_NAME_BY_CLASS` — all five stateful nodes,
 * both tracks), top-level and nested inside any subgraph — mirrors
 * `js/controls/index.js`'s `findLoraNodes`/`findDiagnosticNodes` (itself
 * mirroring `../ComfyUI-Pixaroma/js/lora_loader/index.js`'s own
 * `buildIndex`/`walk` recursion, MIT, THIRD_PARTY_NOTICES.md). */
function findProbeNodes() {
  const found = [];
  const walk = (g) => {
    for (const n of (g && (g._nodes || g.nodes)) || []) {
      const className = n && (n.comfyClass || n.type);
      if (className && fingerprint.STATE_WIDGET_NAME_BY_CLASS[className]) {
        found.push(n);
      }
      const sub = n && (n.subgraph || n.graph || n._graph);
      if (sub && sub !== g) {
        walk(sub);
      }
    }
  };
  walk(app.graph);
  return found;
}

/**
 * The actual probe body — runs once per `api.queuePrompt` call, entirely
 * wrapped in its own try/catch by the caller (`installQueueProbeHook`
 * below). `payload` is `api.queuePrompt`'s own second argument, exactly as
 * received — `{workflow, output}` per this module's own top doc comment.
 *
 * Gated on the LIVE "Console logging" setting being exactly `"debug"` --
 * anything else stays completely silent, checked FIRST so neither the
 * graph walk nor any per-node work ever runs at the pack's default logging
 * level.
 */
function runQueueProbe(payload) {
  const level = getSetting(SETTING_IDS.CONSOLE_LOGGING, SETTING_DEFAULTS[SETTING_IDS.CONSOLE_LOGGING], app);
  if (level !== "debug") {
    return;
  }
  const output = payload && payload.output;
  const nodes = findProbeNodes();
  if (!nodes.length) {
    return;
  }
  if (!fingerprint.hasComparablePayload(output)) {
    console.warn(fingerprint.formatNoPayloadLine());
    return;
  }
  let mismatches = 0;
  for (const node of nodes) {
    try {
      const className = node.comfyClass || node.type;
      const widgetName = fingerprint.STATE_WIDGET_NAME_BY_CLASS[className];
      const widget = (node.widgets || []).find((w) => w.name === widgetName);
      const liveRaw = widget ? widget.value : undefined;
      const nodeId = String(node.id);
      const inputs = output[nodeId] && output[nodeId].inputs;
      const payloadHasInput = !!(inputs && Object.prototype.hasOwnProperty.call(inputs, widgetName));
      const payloadRaw = payloadHasInput ? inputs[widgetName] : undefined;
      const report = fingerprint.buildNodeReport({ nodeId, className, widgetName, liveRaw, payloadRaw, payloadHasInput });
      if (!report.agree) {
        mismatches += 1;
      }
      const { loud, lines } = fingerprint.formatNodeReportLines(report);
      for (const line of lines) {
        if (loud) {
          console.warn(line);
        } else {
          console.log(line);
        }
      }
    } catch (err) {
      console.error(`[AnimaFlow] queue-probe failed for node ${node && node.id}:`, err);
    }
  }
  console.log(fingerprint.formatSummaryLine(nodes.length, mismatches));
}

/**
 * Wrap `api.queuePrompt` exactly once — guarded on `api` itself
 * (`api._wtnQueueProbeWrapped`, surviving a hot reload of this pack's own
 * JS, same convention as `js/shared/submit_guard.mjs`'s `app[guardFlag]`).
 * Never wraps if `api.queuePrompt` isn't a function (a frontend build that
 * renamed/removed it, or this probe's own dynamic import running before
 * `api` exists) — the original is simply left alone rather than throwing.
 *
 * The probe runs SYNCHRONOUSLY, before delegating to the original — its own
 * try/catch means it can never throw out of this wrapper, and the original
 * call (and whatever it returns — sync or a promise) is passed straight
 * through UNMODIFIED, so a probe bug can never affect what actually reaches
 * the backend, delay it, or turn a queue attempt into a rejection.
 *
 * Safe to call from multiple entry points (`js/controls/index.js`'s
 * Control/Loader Panel + LoRA Loader instance-creation paths, `js/anima/
 * index.js`'s Generator/Preview one) — this module is one singleton (ES
 * modules are cached by resolved URL, so every caller's `import(
 * "../shared/queue_probe.mjs")` resolves to the SAME instance), and the
 * `api._wtnQueueProbeWrapped` guard makes a second (or third) call here a
 * pure no-op.
 */
export function installQueueProbeHook() {
  if (!api || typeof api.queuePrompt !== "function") {
    return;
  }
  if (api._wtnQueueProbeWrapped) {
    return; // hot-reload guard -- never double-wrap
  }
  api._wtnQueueProbeWrapped = true;
  const original = api.queuePrompt.bind(api);
  api.queuePrompt = function (...args) {
    try {
      runQueueProbe(args[1]);
    } catch (err) {
      console.error("[AnimaFlow] queue-probe failed to run (ignored):", err);
    }
    return original(...args);
  };
}
