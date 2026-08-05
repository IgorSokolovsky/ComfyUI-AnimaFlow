/**
 * test_delete_confirm.mjs — regression tests for `delete_confirm.mjs`: the
 * pure helpers (`deleteConfirmEnabled`, `formatDeleteFileSize`,
 * `folderLabelFor`, `removedSummary`) plus a DOM-level integration test of
 * `openDeleteConfirm` itself, via a minimal stub DOM mirroring
 * `js/controls/test_civitai_modal.mjs`'s own `makeDocStub` (this pack's
 * convention: each module keeps its own copy rather than sharing one). Plain
 * `node js/shared/test_delete_confirm.mjs`.
 */

import assert from "node:assert/strict";

import {
  deleteConfirmEnabled,
  formatDeleteFileSize,
  folderLabelFor,
  removedSummary,
  openDeleteConfirm,
  DELETE_CONFIRM_WORD,
} from "./delete_confirm.mjs";
// `civitai_search.mjs`'s own `DEFAULT_ROOT_DISPLAY` -- imported HERE, in the
// test, never by `delete_confirm.mjs` itself (that module's own `ROOT_FOR_
// KIND` doc comment: "duplicated rather than imported so this shared module
// carries no dependency on a track file"). This cross-file agreement test is
// what makes that duplication safe going forward -- see the test below,
// added 2026-08-05 after `ROOT_FOR_KIND.unet` was found to say `"models/unet"`
// (the wrong folder, in a DESTRUCTIVE confirmation dialog of all places)
// while `civitai_search.mjs`'s own copy had already been fixed.
import { DEFAULT_ROOT_DISPLAY } from "../controls/civitai_search.mjs";

let failures = 0;
let count = 0;
function test(name, fn) {
  count += 1;
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}
async function asyncTest(name, fn) {
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

// =========================================================================
// deleteConfirmEnabled
// =========================================================================

test("deleteConfirmEnabled: typing the word 'delete' enables it, typing the filename (or anything else) doesn't", () => {
  assert.equal(deleteConfirmEnabled("delete", "my_lora.safetensors"), true);
  assert.equal(deleteConfirmEnabled("my_lora.safetensors", "my_lora.safetensors"), false, "the filename itself is no longer the confirm word -- simplified, owner, 2026-08-01");
  assert.equal(deleteConfirmEnabled("my_lora", "my_lora.safetensors"), false);
  assert.equal(deleteConfirmEnabled("delet", "my_lora.safetensors"), false, "a near-miss must not enable it");
  assert.equal(deleteConfirmEnabled("", "my_lora.safetensors"), false);
});

test("deleteConfirmEnabled: case-insensitive -- 'delete' is a fixed English word, not a filename, so DELETE/Delete/delete all enable it (deliberate; see this module's own top doc comment for why that's NOT the same call as accepting a mis-cased filename)", () => {
  assert.equal(deleteConfirmEnabled("DELETE", "my_lora.safetensors"), true);
  assert.equal(deleteConfirmEnabled("Delete", "my_lora.safetensors"), true);
  assert.equal(deleteConfirmEnabled("DeLeTe", "my_lora.safetensors"), true);
});

test("deleteConfirmEnabled: only whitespace is forgiven (trimmed), never other differences", () => {
  assert.equal(deleteConfirmEnabled("  delete  ", "my_lora.safetensors"), true);
  assert.equal(deleteConfirmEnabled("delete ", "my_lora.safetensors"), true);
  assert.equal(deleteConfirmEnabled("delete extra", "my_lora.safetensors"), false, "must go back to disabled once anything else is appended");
});

test("deleteConfirmEnabled: a garbage/empty filename never enables, regardless of typed text", () => {
  assert.equal(deleteConfirmEnabled("", ""), false);
  assert.equal(deleteConfirmEnabled("anything", ""), false);
  assert.equal(deleteConfirmEnabled("anything", null), false);
  assert.equal(deleteConfirmEnabled("anything", undefined), false);
});

test("deleteConfirmEnabled: never throws on garbage typedText", () => {
  assert.equal(deleteConfirmEnabled(null, "a.safetensors"), false);
  assert.equal(deleteConfirmEnabled(undefined, "a.safetensors"), false);
  assert.equal(deleteConfirmEnabled(42, "a.safetensors"), false);
});

// =========================================================================
// formatDeleteFileSize
// =========================================================================

test("formatDeleteFileSize: bytes/KB/MB/GB thresholds", () => {
  assert.equal(formatDeleteFileSize(500), "500 B");
  assert.equal(formatDeleteFileSize(2048), "2 KB");
  assert.equal(formatDeleteFileSize(1_500_000), "1.4 MB");
  assert.equal(formatDeleteFileSize(5_000_000_000), "4.7 GB");
});

test("formatDeleteFileSize: garbage/negative degrades to '', never throws", () => {
  assert.equal(formatDeleteFileSize(-5), "");
  assert.equal(formatDeleteFileSize(NaN), "");
  assert.equal(formatDeleteFileSize(undefined), "");
  assert.equal(formatDeleteFileSize("not a number"), "");
});

// =========================================================================
// folderLabelFor
// =========================================================================

test("folderLabelFor: the kind's own root for a bare filename", () => {
  assert.equal(folderLabelFor("loras", "my_lora.safetensors"), "models/loras");
  assert.equal(folderLabelFor("checkpoints", "sdxl.safetensors"), "models/checkpoints");
  // Fixed 2026-08-05 -- this used to assert "models/unet", a folder that does
  // not exist (`src/model_browser/kinds.py`'s own `KIND_TO_FOLDER["unet"]` is
  // `diffusion_models`) -- a green test defending the exact bug it should
  // have caught. `civitai_modal.mjs`'s own `test_civitai_modal.mjs` fixed the
  // identical mistake in that module's copy under a973001; this one was
  // missed because it lives in a different file.
  assert.equal(folderLabelFor("unet", "flux.safetensors"), "models/diffusion_models");
});

test("folderLabelFor: agrees with civitai_search.mjs's own DEFAULT_ROOT_DISPLAY for every kind -- two copies (deliberately, see ROOT_FOR_KIND's own doc comment for why this module never imports the other), pinned so they can never silently diverge again", () => {
  for (const kind of Object.keys(DEFAULT_ROOT_DISPLAY)) {
    assert.equal(
      folderLabelFor(kind, ""),
      DEFAULT_ROOT_DISPLAY[kind],
      `folderLabelFor("${kind}") must match civitai_search.mjs's own DEFAULT_ROOT_DISPLAY["${kind}"]`,
    );
  }
});

test("folderLabelFor: a subfolder prefix in `name` is appended to the root", () => {
  assert.equal(folderLabelFor("loras", "detail/my_lora.safetensors"), "models/loras/detail");
  assert.equal(folderLabelFor("loras", "a/b/c.safetensors"), "models/loras/a/b");
});

test("folderLabelFor: a Windows-separator name is normalised", () => {
  assert.equal(folderLabelFor("loras", "detail\\my_lora.safetensors"), "models/loras/detail");
});

test("folderLabelFor: an unknown kind degrades to a generic root, never throws", () => {
  assert.equal(folderLabelFor("unknown-kind", "a.safetensors"), "models/unknown-kind");
  assert.equal(folderLabelFor(null, null), "models");
});

// =========================================================================
// removedSummary
// =========================================================================

test("removedSummary: joins with ' + ', in order", () => {
  assert.equal(removedSummary(["model"]), "model");
  assert.equal(removedSummary(["model", "sidecar"]), "model + sidecar");
  assert.equal(removedSummary(["model", "sidecar", "preview"]), "model + sidecar + preview");
});

test("removedSummary: a missing sidecar/preview is simply absent, not an error", () => {
  assert.equal(removedSummary(["model"]), "model", "a sidecar/preview that never existed never appears");
});

test("removedSummary: garbage/empty input degrades to 'nothing', never throws", () => {
  assert.equal(removedSummary([]), "nothing");
  assert.equal(removedSummary(null), "nothing");
  assert.equal(removedSummary(undefined), "nothing");
  assert.equal(removedSummary("not an array"), "nothing");
});

// =========================================================================
// openDeleteConfirm -- DOM-level integration, via a minimal stub DOM.
// =========================================================================

function makeDocStub() {
  let doc;
  function makeElement(tag) {
    const e = {
      tagName: tag,
      _listeners: {},
      children: [],
      style: {},
      value: "",
      textContent: "",
      title: "",
      type: "",
      placeholder: "",
      disabled: false,
      spellcheck: false,
      parentNode: null,
      get ownerDocument() {
        return doc;
      },
      set innerHTML(_v) {
        e.children = [];
      },
      classList: {
        _set: new Set(),
        add(...cls) {
          cls.forEach((c) => this._set.add(c));
        },
        remove(...cls) {
          cls.forEach((c) => this._set.delete(c));
        },
        contains(c) {
          return this._set.has(c);
        },
      },
      addEventListener(t, fn) {
        (e._listeners[t] = e._listeners[t] || []).push(fn);
      },
      removeEventListener(t, fn) {
        const arr = e._listeners[t];
        if (!arr) {
          return;
        }
        const i = arr.indexOf(fn);
        if (i >= 0) {
          arr.splice(i, 1);
        }
      },
      dispatch(t, evt) {
        (e._listeners[t] || []).forEach((fn) => fn(evt || { target: e, stopPropagation() {} }));
      },
      appendChild(child) {
        const idx = e.children.indexOf(child);
        if (idx >= 0) {
          e.children.splice(idx, 1);
        }
        e.children.push(child);
        child.parentNode = e;
        return child;
      },
      removeChild(child) {
        const idx = e.children.indexOf(child);
        if (idx >= 0) {
          e.children.splice(idx, 1);
        }
        child.parentNode = null;
        return child;
      },
      focus() {
        e._focused = true;
      },
      contains(node) {
        let cur = node;
        while (cur) {
          if (cur === e) {
            return true;
          }
          cur = cur.parentNode;
        }
        return false;
      },
    };
    Object.defineProperty(e, "className", {
      get() {
        return [...e.classList._set].join(" ");
      },
      set(v) {
        e.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
      },
    });
    return e;
  }
  const win = {
    _listeners: {},
    addEventListener(t, fn) {
      (win._listeners[t] = win._listeners[t] || []).push(fn);
    },
    removeEventListener(t, fn) {
      const arr = win._listeners[t];
      if (!arr) {
        return;
      }
      const i = arr.indexOf(fn);
      if (i >= 0) {
        arr.splice(i, 1);
      }
    },
    dispatch(t, evt) {
      (win._listeners[t] || []).forEach((fn) => fn(evt));
    },
  };
  const previousFocus = makeElement("button");
  doc = {
    createElement: makeElement,
    getElementById() {
      return null;
    },
    head: makeElement("head"),
    body: makeElement("body"),
    defaultView: win,
    activeElement: previousFocus,
  };
  return doc;
}

function findAll(root, className) {
  const out = [];
  const walk = (e) => {
    if (e.classList && e.classList.contains(className)) {
      out.push(e);
    }
    (e.children || []).forEach(walk);
  };
  walk(root);
  return out;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("openDeleteConfirm: names the file, its size and its folder; the Delete button starts disabled", () => {
  const doc = makeDocStub();
  const handle = openDeleteConfirm({
    doc, kind: "loras", name: "my_lora.safetensors", sizeBytes: 1_500_000,
    deleteFn: async () => ({ reason: "ok", removed: ["model"] }),
  });
  assert.ok(handle, "must return a handle");
  assert.equal(findAll(handle.scrim, "wtn-dc-file")[0].textContent, "my_lora.safetensors");
  assert.match(findAll(handle.scrim, "wtn-dc-meta")[0].textContent, /1\.4 MB/);
  assert.match(findAll(handle.scrim, "wtn-dc-meta")[0].textContent, /models\/loras/);
  const confirmBtn = findAll(handle.scrim, "wtn-dc-confirm")[0];
  assert.equal(confirmBtn.disabled, true, "must start disabled -- nothing has been typed yet");
  handle.close();
});

test("openDeleteConfirm: the Delete button stays disabled until the word 'delete' is typed -- NOT the filename", () => {
  const doc = makeDocStub();
  const handle = openDeleteConfirm({
    doc, kind: "loras", name: "my_lora.safetensors", sizeBytes: 100,
    deleteFn: async () => ({ reason: "ok", removed: ["model"] }),
  });
  const input = findAll(handle.scrim, "wtn-dc-input")[0];
  const confirmBtn = findAll(handle.scrim, "wtn-dc-confirm")[0];

  input.value = "my_lora.safetensors";
  input.dispatch("input");
  assert.equal(confirmBtn.disabled, true, "typing the FILENAME must no longer enable the button -- simplified to a fixed word");

  input.value = "delet";
  input.dispatch("input");
  assert.equal(confirmBtn.disabled, true, "a partial match must not enable the button");

  input.value = "delete";
  input.dispatch("input");
  assert.equal(confirmBtn.disabled, false, "typing 'delete' must enable the button");

  input.value = "delete extra";
  input.dispatch("input");
  assert.equal(confirmBtn.disabled, true, "must go back to disabled once the text no longer matches");

  handle.close();
});

await asyncTest("openDeleteConfirm: a successful delete calls onDeleted with the result, then closes", async () => {
  const doc = makeDocStub();
  let deletedWith = null;
  let closedCalls = 0;
  const handle = openDeleteConfirm({
    doc, kind: "loras", name: "gone.safetensors", sizeBytes: 100,
    deleteFn: async (kind, name) => {
      assert.equal(kind, "loras");
      assert.equal(name, "gone.safetensors");
      return { reason: "ok", message: "", removed: ["model", "sidecar"] };
    },
    onDeleted: (result) => {
      deletedWith = result;
    },
    onClose: () => {
      closedCalls += 1;
    },
  });
  const input = findAll(handle.scrim, "wtn-dc-input")[0];
  const confirmBtn = findAll(handle.scrim, "wtn-dc-confirm")[0];
  input.value = "delete";
  input.dispatch("input");
  confirmBtn.dispatch("click", { stopPropagation() {} });
  await settle();

  assert.ok(deletedWith, "onDeleted must have been called");
  assert.deepEqual(deletedWith.removed, ["model", "sidecar"]);
  assert.equal(closedCalls, 1, "must close exactly once after a successful delete");
  assert.equal(doc.body.children.includes(handle.scrim), false, "the scrim must be removed from the document");
});

await asyncTest("openDeleteConfirm: a write_error surfaces readably, stays open, and re-enables the button", async () => {
  const doc = makeDocStub();
  let onDeletedCalls = 0;
  const handle = openDeleteConfirm({
    doc, kind: "loras", name: "locked.safetensors", sizeBytes: 100,
    deleteFn: async () => ({ reason: "write_error", message: "Could not delete the model file: permission denied", removed: [] }),
    onDeleted: () => {
      onDeletedCalls += 1;
    },
  });
  const input = findAll(handle.scrim, "wtn-dc-input")[0];
  const confirmBtn = findAll(handle.scrim, "wtn-dc-confirm")[0];
  input.value = "delete";
  input.dispatch("input");
  confirmBtn.dispatch("click", { stopPropagation() {} });
  await settle();

  assert.equal(onDeletedCalls, 0, "onDeleted must never fire on a non-ok reason");
  const errorLine = findAll(handle.scrim, "wtn-dc-error")[0];
  assert.match(errorLine.textContent, /permission denied/);
  assert.notEqual(errorLine.style.display, "none", "the error line must be visible");
  assert.equal(confirmBtn.disabled, false, "'delete' is still typed -- the button must re-enable, not stay stuck disabled");
  assert.ok(doc.body.children.includes(handle.scrim), "the dialog must stay open after a failure");

  handle.close();
});

test("openDeleteConfirm: Cancel closes without ever calling deleteFn", () => {
  const doc = makeDocStub();
  let deleteFnCalls = 0;
  let closedCalls = 0;
  const handle = openDeleteConfirm({
    doc, kind: "loras", name: "a.safetensors", sizeBytes: 100,
    deleteFn: async () => {
      deleteFnCalls += 1;
      return { reason: "ok", removed: ["model"] };
    },
    onClose: () => {
      closedCalls += 1;
    },
  });
  const cancelBtn = findAll(handle.scrim, "wtn-dc-cancel")[0];
  cancelBtn.dispatch("click", { stopPropagation() {} });
  assert.equal(deleteFnCalls, 0);
  assert.equal(closedCalls, 1);
  assert.equal(doc.body.children.includes(handle.scrim), false);
});

test("openDeleteConfirm: Escape closes the dialog", () => {
  const doc = makeDocStub();
  const handle = openDeleteConfirm({
    doc, kind: "loras", name: "a.safetensors", sizeBytes: 100,
    deleteFn: async () => ({ reason: "ok", removed: ["model"] }),
  });
  doc.defaultView.dispatch("keydown", { key: "Escape" });
  assert.equal(doc.body.children.includes(handle.scrim), false);
});

test("openDeleteConfirm: clicking the scrim itself (not the dialog) closes it", () => {
  const doc = makeDocStub();
  const handle = openDeleteConfirm({
    doc, kind: "loras", name: "a.safetensors", sizeBytes: 100,
    deleteFn: async () => ({ reason: "ok", removed: ["model"] }),
  });
  handle.scrim.dispatch("mousedown", { target: handle.dialog });
  assert.ok(doc.body.children.includes(handle.scrim), "clicking the DIALOG must not close it");
  handle.scrim.dispatch("mousedown", { target: handle.scrim });
  assert.equal(doc.body.children.includes(handle.scrim), false, "clicking the SCRIM itself must close it");
});

console.log(`\n${count - failures}/${count} passed`);
if (failures > 0) {
  process.exitCode = 1;
}
