// Generic tag-autocomplete attach point: on every node's creation, scan its
// widgets and attach the popup (see interaction.mjs) to any control that's
// either name-matched (`prompt`/`positive`/`negative`/`_text`/`template`)
// or a plain multiline STRING `<textarea>` — this is NOT owned by one node
// type; it's a pack-wide extension, the one intentional exception to
// "one index.js per node" in this repo. It also reaches into any custom
// DOM-widget node's own rendered markup (e.g. PromptBuilder's TEMPLATE/
// FIELDS textareas) so those get autocomplete too without needing each
// node to opt in individually. See core.mjs/render.mjs/interaction.mjs for
// the token/DOM/event pieces this wires together.

import { app } from "/scripts/app.js";
import { isEligibleWidget } from "./core.mjs";
import { injectStyles } from "./render.mjs";
import { attachAutocomplete } from "./interaction.mjs";

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

  async nodeCreated(node) {
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
