/**
 * Prompt Rules — encode-node button widgets (contract: `docs/nodes-and-api.md`
 * §1 node widgets / §3 "Picker popover").
 *
 * Adds two `button`-type widgets (plain `node.addWidget("button", ...)`,
 * same simple mechanism ComfyUI-Pixaroma uses for its "Open Paint"/"Open 3D
 * Builder"/etc. buttons -- no DOM widget needed here, unlike
 * `js/prompt_builder` or `js/prompt_combiner`) to both `Prompt Rules (CLIP)`
 * and `Prompt Rules` (text) nodes (`nodes/prompt_rules.py`'s
 * `PromptRulesClip` / `PromptRulesText` -- the exact `nodeData.name`s
 * registered in `__init__.py`'s `NODE_CLASS_MAPPINGS`):
 *
 *   - **Open Rule Builder** -- opens the full-screen Rule Builder overlay
 *     (`js/rule_builder/overlay.mjs`, via its `index.js`'s re-exported
 *     `openRuleBuilder(ctx)`) pointed at THIS node's `embedded_rules`
 *     widget: reads its current value as the initial ruleset, and writes
 *     `ctx.onApply`'s result back into it (JSON-stringified) so "Apply to
 *     node" in the overlay round-trips through this exact widget.
 *   - **Pick…** -- opens the lighter character/outfit/background/pose picker
 *     popover (`./picker.mjs`), which inserts a token into this node's
 *     `positive`/`negative` text widget.
 *
 * Absolute imports for both cross-folder modules (`js/rule_builder/`,
 * `js/shared/`) -- see `.claude/skills/comfyui-dynamic-node-frontend/
 * SKILL.md`'s "silent killer" gotcha and `docs/nodes-and-api.md` §3 ("State &
 * imports"): a subfolder's relative `../rule_builder/index.js` would resolve
 * from THIS file's own folder correctly here (both are siblings under
 * `js/`), but the skill's rule is absolute-for-any-cross-folder-import, and
 * `js/rule_builder/overlay.mjs`/`preview.mjs` already set that precedent for
 * this pack, so this file follows suit for consistency + robustness against
 * either module ever moving.
 * VERIFY-IN-COMFYUI: assumes this pack is installed as
 * `custom_nodes/ComfyUI-AnimaFlow` (this repo's own folder name) -- ComfyUI
 * mounts a pack's `WEB_DIRECTORY` at `/extensions/<that folder name>`. If
 * ever deployed under a different folder name, update the two absolute
 * import paths below (and their siblings in `js/rule_builder/`) to match.
 */
import { app } from "/scripts/app.js";
import { openRuleBuilder } from "/extensions/ComfyUI-AnimaFlow/rule_builder/index.js";
import { injectTheme } from "/extensions/ComfyUI-AnimaFlow/shared/theme.mjs";
import { openPicker } from "./picker.mjs";

// Both encode-node variants (`nodes/prompt_rules.py`) get the same two
// buttons -- they differ only in output type (CONDITIONING vs STRING), not
// in how their `positive`/`negative`/`profile`/`embedded_rules` widgets work.
const NODE_CLASS_NAMES = ["PromptRulesClip", "PromptRulesText"];

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

/**
 * Hides the `embedded_rules` widget for RENDERING only -- it still
 * serializes normally into `widgets_values` (this is the serialized-STRING
 * state pattern from the dynamic-node-frontend skill: a real, declared
 * widget is the only reliable way frontend-authored JSON state reaches
 * Python's `build()`/`process()`, unlike a `hidden`-INPUT_TYPES +
 * graphToPrompt injection, which the skill documents as silently
 * unreliable). There is no on-node DOM preview of the ruleset (the Rule
 * Builder overlay itself IS that preview), so nothing else needs to mirror
 * into this widget except the "Open Rule Builder" button's `onApply`.
 */
function hideEmbeddedRulesWidget(widget) {
  if (!widget) return;
  widget.hidden = true;
  widget.computeSize = () => [0, -4];
  if (widget.inputEl && widget.inputEl.style) {
    widget.inputEl.style.display = "none";
  }
}

/** Parses the `embedded_rules` widget's current value into a Ruleset object
 * for `openRuleBuilder`'s `ctx.embedded` -- `{}` (nothing embedded yet, a
 * fresh/empty node) on an empty value or any parse failure (a corrupt/
 * hand-edited widget value must never crash the button, just open empty). */
function parseEmbedded(widget) {
  const raw = widget && widget.value;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function addOpenRuleBuilderButton(node, embeddedWidget) {
  node.addWidget("button", "Open Rule Builder", null, () => {
    const positiveWidget = findWidget(node, "positive");
    const negativeWidget = findWidget(node, "negative");
    const profileWidget = findWidget(node, "profile");

    openRuleBuilder({
      // The encode node's button is ALWAYS about editing THIS node's own
      // `embedded_rules` widget -- never a file sheet (that's what the
      // separate "Rule Builder" menu command / toolbar button, and the
      // overlay's own File-sheet/Embedded mode toggle once it's open, are
      // for). So `mode` is pinned to "embedded" unconditionally here,
      // regardless of whether `embedded_rules` currently holds anything --
      // an empty widget just means "start authoring a new embedded
      // ruleset from the seeded example", not "switch to sheet mode".
      mode: "embedded",
      embedded: parseEmbedded(embeddedWidget),
      profile: profileWidget ? profileWidget.value : undefined,
      positive: positiveWidget ? positiveWidget.value : "",
      negative: negativeWidget ? negativeWidget.value : "",
      // Round-trips "Apply to node" (overlay.mjs's `apply-embedded` button)
      // back into this exact widget -- the only place this node reads its
      // embedded ruleset from (`nodes/_rules_helpers.py`'s resolution order:
      // file sheets, THEN `embedded_rules`).
      onApply(ruleset) {
        if (!embeddedWidget) return;
        embeddedWidget.value = JSON.stringify(ruleset);
        node.setDirtyCanvas(true, true);
      },
      onClose() {},
    });
  });
}

function addPickerButton(node) {
  node.addWidget("button", "Pick…", null, () => {
    openPicker({
      node,
      getPositiveWidget: () => findWidget(node, "positive"),
      getNegativeWidget: () => findWidget(node, "negative"),
    });
  });
}

function setupNode(node) {
  // Guards against a hypothetical double `onNodeCreated` re-entry (this
  // pack's other nodes use the same `_wtn*Setup`-style guard, e.g.
  // `js/prompt_combiner/index.js`'s `_promptCombinerRefs` existence check)
  // -- `addWidget` has no dedupe of its own, so calling `setupNode` twice on
  // the same node instance would stack duplicate button rows.
  if (node._wtnPromptRulesSetup) return;
  node._wtnPromptRulesSetup = true;

  injectTheme(); // shared by both the Rule Builder overlay and the picker

  const embeddedWidget = findWidget(node, "embedded_rules");
  hideEmbeddedRulesWidget(embeddedWidget);

  addOpenRuleBuilderButton(node, embeddedWidget);
  addPickerButton(node);
}

app.registerExtension({
  name: "webtoon.prompt_rules",

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_CLASS_NAMES.includes(nodeData.name)) return;

    const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function (...args) {
      const result = originalOnNodeCreated ? originalOnNodeCreated.apply(this, args) : undefined;
      setupNode(this);
      return result;
    };
  },
});
