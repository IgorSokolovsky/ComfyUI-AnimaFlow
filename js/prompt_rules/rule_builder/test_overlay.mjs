/**
 * test_overlay.mjs — regression tests for the rule-builder overlay's
 * "Copy YAML" wiring (`copy_yaml.mjs`'s `copyYamlToClipboard`).
 *
 * `overlay.mjs` itself (which imports this and wires it to the actual
 * button) can't be imported from a plain-`node` test at all -- it pulls in
 * `theme.mjs`/`api.mjs` via absolute `/extensions/ComfyUI-AnimaFlow/...`
 * paths that only resolve inside a running ComfyUI page, so a static
 * `import` of `overlay.mjs` throws `ERR_MODULE_NOT_FOUND` before a single
 * test runs. `copyYamlToClipboard` was split into its own module
 * (`copy_yaml.mjs`) precisely so this actual behaviour is testable; see
 * that module's own top doc comment.
 *
 * Owner-reported, 2026-08-04: "Copy seed" failed silently on an insecure
 * origin (`navigator.clipboard` doesn't exist there at all); this pane's own
 * "Copy YAML" button had the SAME bug, but worse -- its `catch` block
 * silently swallowed the failure, so a failed copy looked identical to a
 * successful one. `copyYamlToClipboard` now goes through the shared
 * `js/shared/clipboard.mjs` helper (covered on its own in
 * `js/shared/test_clipboard.mjs`) and always reports which outcome
 * happened via the button's own text.
 */
import assert from "node:assert/strict";

import { copyYamlToClipboard } from "./copy_yaml.mjs";

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

function makeButtonStub() {
  return { textContent: "Copy", title: "" };
}

function makeDocStub({ execCommandResult = true } = {}) {
  const execCommandCalls = [];
  const children = [];
  return {
    createElement() {
      return { style: {}, value: "", focus() {}, select() {}, setSelectionRange() {}, setAttribute() {}, remove() {} };
    },
    body: {
      appendChild(child) {
        children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx >= 0) children.splice(idx, 1);
        return child;
      },
    },
    execCommand(cmd) {
      execCommandCalls.push(cmd);
      return execCommandResult;
    },
    _execCommandCalls: execCommandCalls,
  };
}

async function withNavigator(value, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true });
  try {
    await fn();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "navigator", original);
    } else {
      delete globalThis.navigator;
    }
  }
}

await test("copyYamlToClipboard: on success, shows 'Copied ✓' and returns {ok: true}", async () => {
  const btn = makeButtonStub();
  const doc = makeDocStub();
  await withNavigator({ clipboard: { writeText: async () => {} } }, async () => {
    const result = await copyYamlToClipboard(btn, "rules: []", doc);
    assert.deepEqual(result, { ok: true });
    assert.equal(btn.textContent, "Copied ✓");
  });
});

await test("copyYamlToClipboard: falls back to execCommand and still reports success when navigator.clipboard is absent (insecure origin) -- the actual bug for this caller", async () => {
  const btn = makeButtonStub();
  const doc = makeDocStub({ execCommandResult: true });
  await withNavigator(undefined, async () => {
    const result = await copyYamlToClipboard(btn, "rules: []", doc);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(doc._execCommandCalls, ["copy"]);
    assert.equal(btn.textContent, "Copied ✓");
  });
});

await test("copyYamlToClipboard: a failure is SURFACED on the button -- this used to be a silent catch that swallowed it entirely", async () => {
  const btn = makeButtonStub();
  const doc = makeDocStub({ execCommandResult: false });
  await withNavigator(undefined, async () => {
    const result = await copyYamlToClipboard(btn, "rules: []", doc);
    assert.equal(result.ok, false);
    assert.notEqual(btn.textContent, "Copied ✓", "a failed copy must never read the same as a successful one");
    assert.equal(btn.textContent, "Copy failed");
    assert.ok(btn.title, "the failure reason is available (e.g. as a tooltip), not just an unlabeled state");
  });
});

await test("copyYamlToClipboard: the button's text reverts to 'Copy' after the timeout, on both success and failure", async () => {
  const successBtn = makeButtonStub();
  const failBtn = makeButtonStub();
  const okDoc = makeDocStub({ execCommandResult: true });
  const failDoc = makeDocStub({ execCommandResult: false });
  await withNavigator(undefined, async () => {
    await copyYamlToClipboard(successBtn, "x", okDoc);
    await copyYamlToClipboard(failBtn, "x", failDoc);
    assert.equal(successBtn.textContent, "Copied ✓");
    assert.equal(failBtn.textContent, "Copy failed");
    await new Promise((resolve) => setTimeout(resolve, 1450));
    assert.equal(successBtn.textContent, "Copy");
    assert.equal(failBtn.textContent, "Copy");
  });
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exit(1);
}
