/**
 * test_clipboard.mjs — regression tests for `clipboard.mjs`'s shared
 * copy-to-clipboard helper (owner-reported, 2026-08-04: "Copy seed" failed
 * silently over plain `http://`, an insecure context where
 * `navigator.clipboard` doesn't exist at all).
 *
 * Plain `node`, a tiny local doc/element stub -- just enough `createElement`/
 * `body.appendChild`/`removeChild` for the textarea fallback, no real DOM.
 * The absent-`navigator.clipboard` case (not merely a present navigator with
 * no `.clipboard`) is the one that matters: it's the actual shape of an
 * insecure origin, and it's the one a test environment that always provides
 * `navigator.clipboard` would hide completely.
 */
import assert from "node:assert/strict";

import { copyToClipboard } from "./clipboard.mjs";

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

// ---------------------------------------------------------------------------
// A tiny doc stub -- just enough for the textarea fallback path.
// ---------------------------------------------------------------------------

function makeDocStub({ execCommandResult = true, execCommandThrows = false } = {}) {
  const execCommandCalls = [];
  const removed = [];
  let activeElement = null;

  function makeElement(tag) {
    const el = {
      tagName: tag,
      style: {},
      value: "",
      parentNode: null,
      focus() {
        activeElement = el;
      },
      select() {},
      setSelectionRange() {},
      setAttribute() {},
      remove() {
        removed.push(el);
        if (el.parentNode) {
          const idx = el.parentNode.children.indexOf(el);
          if (idx >= 0) el.parentNode.children.splice(idx, 1);
          el.parentNode = null;
        }
      },
    };
    return el;
  }

  const body = {
    children: [],
    appendChild(child) {
      body.children.push(child);
      child.parentNode = body;
      return child;
    },
    removeChild(child) {
      const idx = body.children.indexOf(child);
      if (idx >= 0) body.children.splice(idx, 1);
      child.parentNode = null;
      removed.push(child);
      return child;
    },
  };

  const doc = {
    createElement: makeElement,
    body,
    get activeElement() {
      return activeElement;
    },
    execCommand(cmd) {
      execCommandCalls.push(cmd);
      if (execCommandThrows) {
        throw new Error("simulated execCommand failure");
      }
      return execCommandResult;
    },
  };
  return { doc, execCommandCalls, removed };
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

// ---------------------------------------------------------------------------
// The modern path -- used whenever navigator.clipboard exists
// ---------------------------------------------------------------------------

await test("copyToClipboard: uses navigator.clipboard.writeText when it exists, never touches the doc fallback", async () => {
  let written = null;
  const { doc, execCommandCalls } = makeDocStub();
  await withNavigator({ clipboard: { writeText: async (text) => { written = text; } } }, async () => {
    const result = await copyToClipboard("hello world", doc);
    assert.deepEqual(result, { ok: true });
    assert.equal(written, "hello world");
    assert.deepEqual(execCommandCalls, [], "the fallback must never run when the modern API succeeds");
  });
});

// ---------------------------------------------------------------------------
// The actual bug: no navigator.clipboard at all (insecure origin)
// ---------------------------------------------------------------------------

await test("copyToClipboard: falls back to execCommand('copy') when navigator.clipboard is absent entirely -- the actual reported bug", async () => {
  const { doc, execCommandCalls } = makeDocStub();
  await withNavigator(undefined, async () => {
    const result = await copyToClipboard("the seed 12345", doc);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(execCommandCalls, ["copy"]);
  });
});

await test("copyToClipboard: also falls back when navigator exists but has no .clipboard property", async () => {
  const { doc, execCommandCalls } = makeDocStub();
  await withNavigator({}, async () => {
    const result = await copyToClipboard("x", doc);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(execCommandCalls, ["copy"]);
  });
});

// ---------------------------------------------------------------------------
// The fallback also runs when writeText itself rejects (not just absent)
// ---------------------------------------------------------------------------

await test("copyToClipboard: falls back to execCommand when writeText rejects (permission denied, browser quirk)", async () => {
  const { doc, execCommandCalls } = makeDocStub();
  await withNavigator({ clipboard: { writeText: async () => { throw new Error("permission denied"); } } }, async () => {
    const result = await copyToClipboard("x", doc);
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(execCommandCalls, ["copy"]);
  });
});

// ---------------------------------------------------------------------------
// The temporary textarea is removed on both success and failure
// ---------------------------------------------------------------------------

await test("copyToClipboard: the temporary textarea is appended then removed again on a SUCCESSFUL fallback copy", async () => {
  const { doc, removed } = makeDocStub({ execCommandResult: true });
  await withNavigator(undefined, async () => {
    await copyToClipboard("x", doc);
    assert.equal(doc.body.children.length, 0, "the textarea must not be left in the DOM");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].tagName, "textarea");
  });
});

await test("copyToClipboard: the temporary textarea is removed even when execCommand returns false (a FAILED fallback copy)", async () => {
  const { doc, removed } = makeDocStub({ execCommandResult: false });
  await withNavigator(undefined, async () => {
    const result = await copyToClipboard("x", doc);
    assert.equal(result.ok, false);
    assert.equal(doc.body.children.length, 0);
    assert.equal(removed.length, 1);
  });
});

await test("copyToClipboard: the temporary textarea is removed even when execCommand THROWS", async () => {
  const { doc, removed } = makeDocStub({ execCommandThrows: true });
  await withNavigator(undefined, async () => {
    const result = await copyToClipboard("x", doc);
    assert.equal(result.ok, false, "a throwing execCommand must be treated as a failed copy, never propagate");
    assert.equal(doc.body.children.length, 0, "still removed despite the throw");
    assert.equal(removed.length, 1);
  });
});

// ---------------------------------------------------------------------------
// A failure returns {ok: false}, never throws
// ---------------------------------------------------------------------------

await test("copyToClipboard: execCommand returning false yields {ok: false, message} rather than throwing", async () => {
  const { doc } = makeDocStub({ execCommandResult: false });
  await withNavigator(undefined, async () => {
    const result = await copyToClipboard("x", doc);
    assert.equal(result.ok, false);
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0);
  });
});

await test("copyToClipboard: no doc and no global document at all degrades to {ok: false}, never throws", async () => {
  await withNavigator(undefined, async () => {
    const result = await copyToClipboard("x", undefined);
    assert.equal(result.ok, false);
    assert.equal(typeof result.message, "string");
  });
});

await test("copyToClipboard: restores the previously-focused element after the fallback copy", async () => {
  const { doc } = makeDocStub();
  const previouslyFocused = { focused: false, focus() { this.focused = true; } };
  Object.defineProperty(doc, "activeElement", { value: previouslyFocused, configurable: true });
  await withNavigator(undefined, async () => {
    await copyToClipboard("x", doc);
    assert.equal(previouslyFocused.focused, true, "focus must be restored to whatever had it before the copy");
  });
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exit(1);
}
