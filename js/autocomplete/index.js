// Generic tag-autocomplete attach point: on every AnimaFlow node's creation,
// scan its widgets and attach the popup (see interaction.mjs) to any control
// that's either name-matched (`prompt`/`positive`/`negative`/`_text`/
// `template`) or a plain multiline STRING `<textarea>`. This is NOT owned by
// one node type; it's a cross-node extension within the pack, the one
// intentional exception to "one index.js per node" in this repo. It also
// reaches into any of our own custom DOM-widget nodes' own rendered markup
// (e.g. PromptBuilder's TEMPLATE/FIELDS textareas) so those get autocomplete
// too without needing each node to opt in individually.
//
// IMPORTANT — pack-scoped, not graph-wide: `nodeCreated` fires for every
// node in the graph, from every installed custom-node pack, plus every core
// ComfyUI node. Earlier versions of this file attached unconditionally to
// any node whose widget happened to render a `<textarea>`, which reached
// into other packs' DOM widgets (e.g. attaching a tag popup to a markdown/
// code-editor node, stealing its Tab/Enter/Arrow keys while our popup was
// open) and into plain display/read-only fields that were never meant to
// have completions, and could fight another pack's own autocomplete (e.g.
// pythongosssss Custom-Scripts). So attachment is now gated on ownership:
// only nodes whose Python class declares `CATEGORY = "AnimaFlow/..."` are
// eligible at all; core nodes (e.g. `CLIPTextEncode`) and every other pack
// are skipped even if they'd otherwise match the name/textarea heuristics
// below. See `isOwnNode` for how ownership is determined.
//
// See core.mjs/render.mjs/interaction.mjs for the token/DOM/event pieces
// this wires together.

import { app } from "/scripts/app.js";
import { isEligibleWidget, isOwnedCategory, resolveOwnership } from "./core.mjs";
import { injectStyles } from "./render.mjs";
import { attachAutocomplete } from "./interaction.mjs";

// Module-level set of node CLASS NAMES (`nodeData.name` / `node.comfyClass`)
// that belong to this pack, populated by `beforeRegisterNodeDef` below. That
// hook runs once per registered node type, for EVERY installed pack, before
// any node instance exists on the graph -- so by the time the first
// `nodeCreated` fires for any node, this set is already fully populated.
// Deliberately not a hardcoded list of our node class names: new nodes added
// to this pack are picked up automatically as long as they declare the
// `AnimaFlow/...` category (this pack's node-pack convention), with no
// need to remember to update this file. The actual ownership decision
// (Set-membership + category fallback) is pure logic and lives in
// `core.mjs` (`resolveOwnership`) so it can be unit-tested without a DOM.
const ownedNodeNames = new Set();

/**
 * Does `node` belong to this pack? Extracts the live-instance identity
 * (`className`/`category`) off `node` -- the litegraph-specific duck-typing
 * lives here, since it needs the real node object -- then delegates the
 * actual yes/no decision to `resolveOwnership` (see `core.mjs` for the
 * primary-signal/fallback-signal rationale).
 *
 * `className` prefers `node.comfyClass` (the modern, reliable field
 * ComfyUI sets on every node instance to its Python class name), falling
 * back to `node.type` and then `node.constructor?.comfyClass` for older/
 * edge-case legacy-litegraph instances where `comfyClass` isn't set
 * directly on the instance.
 */
function isOwnNode(node) {
  if (!node) {
    return false;
  }
  const className = node.comfyClass || node.type || node.constructor?.comfyClass;
  const category = node.constructor?.category;
  return resolveOwnership({ className, category }, ownedNodeNames);
}

/** Attach to `widget`'s own control if eligible (see `isEligibleWidget`),
 * OR, for a DOM widget (`addDOMWidget`, no single `inputEl`), fall back to
 * scanning its root element for any `<textarea>` a node renders itself —
 * these never show up as `widget.inputEl`, so the direct check can't see
 * them. Idempotent per real DOM element via a `_wtnAutocompleteAttached`
 * marker (a node can be rescanned harmlessly).
 */
function maybeAttachWidget(widget) {
  if (!widget) {
    return;
  }

  const el = widget.inputEl;
  if (el && !el._wtnAutocompleteAttached && isEligibleWidget(widget)) {
    el._wtnAutocompleteAttached = true;
    attachAutocomplete(el);
    return;
  }

  const root = widget.element;
  if (root && typeof root.querySelectorAll === "function") {
    root.querySelectorAll("textarea").forEach((textarea) => {
      if (textarea._wtnAutocompleteAttached) {
        return;
      }
      textarea._wtnAutocompleteAttached = true;
      attachAutocomplete(textarea);
    });
  }
}

function scanNode(node) {
  for (const widget of node.widgets || []) {
    maybeAttachWidget(widget);
  }
}

app.registerExtension({
  name: "webtoon.autocomplete",

  // Runs once per node TYPE at registration, across every installed pack --
  // this is where we learn which class names are ours, before any node of
  // that type has been placed on the graph.
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData && isOwnedCategory(nodeData.category)) {
      ownedNodeNames.add(nodeData.name);
    }
  },

  async nodeCreated(node) {
    // Bail out immediately for anything that isn't ours: every other
    // installed pack's nodes, and core ComfyUI nodes (including
    // `CLIPTextEncode`) -- see the top-of-file comment for why that
    // core-node trade was made deliberately.
    if (!isOwnNode(node)) {
      return;
    }

    injectStyles();
    scanNode(node);
    // Some DOM-widget nodes (e.g. PromptBuilder) build their inner
    // textareas synchronously in `onNodeCreated`, which runs before this
    // hook's own body finishes for a freshly-placed node in some load
    // orders -- a short rescan catches anything that wasn't mounted yet
    // without requiring every node to cooperate with this extension.
    setTimeout(() => scanNode(node), 50);
  },
});
