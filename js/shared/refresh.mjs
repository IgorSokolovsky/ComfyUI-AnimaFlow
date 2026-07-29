/**
 * refresh.mjs — one global "the user refreshed node definitions" signal,
 * shared across every track in this pack (not LoRA-specific — genuinely
 * cross-cutting, hence `js/shared/`, not `js/controls/`).
 *
 * ComfyUI's `R` key (Refresh Node Definitions) re-fetches `/object_info` and
 * then calls `node.refreshComboInNode?.(defs)` on EVERY node instance in the
 * graph — verified against a real ComfyUI frontend build; it also runs
 * automatically on WebSocket reconnect. Native combo widgets get fresh
 * option lists from that pass for free; a custom DOM picker (this pack's
 * `js/controls/model_picker.mjs`, wired to `AnimaLoraLoader`'s missing-file
 * marks in `lora_interaction.mjs`) does not, so any module whose cache
 * should refresh on `R` registers a handler here, and each affected node
 * TYPE installs the per-node hook below in its own `beforeRegisterNodeDef`.
 *
 * Fire-and-forget by ComfyUI core's own contract (the `refreshComboInNode`
 * return value is discarded) — a handler must do its own async work and
 * repaint, never rely on being awaited. Several node instances of the same
 * type fire this hook in the SAME `reloadNodeDefs` pass; the microtask flag
 * below collapses them into one handler run rather than one per node.
 *
 * Near-verbatim port of `../ComfyUI-Pixaroma/js/shared/refresh.mjs` (MIT,
 * `THIRD_PARTY_NOTICES.md`), generalised from a Pixaroma-specific comment to
 * a pack-wide one — the mechanism itself (a `Set` of handlers, a microtask-
 * deduped fire, wrapping `refreshComboInNode` rather than replacing it) is
 * unchanged.
 */

const _handlers = new Set();
let _scheduled = false;

/** Register `fn` to run on the next `R`/WebSocket-reconnect refresh pass. */
export function onNodeDefsRefresh(fn) {
  _handlers.add(fn);
}

/** Fires every registered handler, deduped per microtask (many node
 * instances of the same type can call this in one refresh pass) -- a
 * throwing handler is caught and skipped so one bad handler can never stop
 * the rest, or break ComfyUI's own refresh loop that (indirectly) triggers
 * this via `installRefreshHook` below. */
export function runRefreshHandlers() {
  if (_scheduled) {
    return;
  }
  _scheduled = true;
  queueMicrotask(() => {
    _scheduled = false;
    for (const fn of _handlers) {
      try {
        fn();
      } catch {
        // one bad handler must not stop the rest
      }
    }
  });
}

/** Installs the official per-node hook on `nodeType` (call from that node
 * type's own `beforeRegisterNodeDef`, once — the caller's own guard, same
 * as every other prototype patch in this pack). Wraps any existing
 * `refreshComboInNode`, never replaces it, so this composes with whatever
 * else (a future node type, or ComfyUI itself) already hooked it. */
export function installRefreshHook(nodeType) {
  const orig = nodeType.prototype.refreshComboInNode;
  nodeType.prototype.refreshComboInNode = function refreshComboInNode() {
    try {
      runRefreshHandlers();
    } catch {
      // never break core's own refresh loop
    }
    return orig ? orig.apply(this, arguments) : undefined;
  };
}
