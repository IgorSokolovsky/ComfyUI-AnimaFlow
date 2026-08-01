/**
 * test_z_layers.mjs — regression tests for `z_layers.mjs`, the shared
 * z-index scale (owner-reported, 2026-08-01: the delete confirmation dialog
 * rendered BEHIND the ⓘ panel that opened it, because `overlay.mjs`'s
 * `10020` and `delete_confirm.mjs`'s own `10001` had no shared ordering).
 * Every assertion here reads the actual exported constants -- never restates
 * a literal number -- so a later rung (a fifth surface) can't quietly slip
 * back into the exact bug this scale exists to fix (a literal-vs-literal
 * comparison would keep passing even after that). Plain `node
 * js/shared/test_z_layers.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Z_TOOLTIP, Z_PANEL, Z_MODAL, Z_CONFIRM, Z_ELEVATED_TOOLTIP } from "./z_layers.mjs";

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

const here = path.dirname(fileURLToPath(import.meta.url));
const controlsDir = path.join(here, "..", "controls");
const animaDir = path.join(here, "..", "anima");
const autocompleteDir = path.join(here, "..", "autocomplete");
const ruleBuilderDir = path.join(here, "..", "prompt_rules", "rule_builder");
const promptRulesNodeDir = path.join(here, "..", "prompt_rules", "node");

// =========================================================================
// The required ordering itself -- read from the module, not restated.
// =========================================================================

test("the required ordering holds: tooltip < anchored overlay/panel < full modal < confirmation dialog", () => {
  assert.ok(Z_TOOLTIP < Z_PANEL, "tooltip must sit below the panel tier");
  assert.ok(Z_PANEL < Z_MODAL, "an anchored panel must sit below a full modal");
  assert.ok(Z_MODAL < Z_CONFIRM, "a full modal must sit below the confirm dialog -- the owner-reported bug this scale fixes");
});

test("the confirm dialog's own layer resolves above the anchored overlay/panel layer -- the exact owner-reported bug, asserted from the shared scale rather than two hardcoded literals", () => {
  assert.ok(Z_CONFIRM > Z_PANEL, "a confirmation must outrank every panel it can be launched from");
});

test("every rung is a distinct, finite, positive integer", () => {
  const rungs = [Z_TOOLTIP, Z_PANEL, Z_MODAL, Z_CONFIRM];
  for (const v of rungs) {
    assert.ok(Number.isInteger(v) && v > 0, `${v} must be a positive integer`);
  }
  assert.equal(new Set(rungs).size, rungs.length, "no two rungs may collide -- a tie is exactly as fragile as the ordering being wrong");
});

test("Z_ELEVATED_TOOLTIP (fields.mjs's field-row tooltip, deliberately escaping its own containing panel) outranks Z_PANEL, and is one of the scale's own named rungs -- never a fifth invented number", () => {
  assert.ok(Z_ELEVATED_TOOLTIP > Z_PANEL, "must outrank the panel it renders inside of");
  assert.ok(
    [Z_TOOLTIP, Z_PANEL, Z_MODAL, Z_CONFIRM].includes(Z_ELEVATED_TOOLTIP),
    "must equal one of the four required rungs, not a new one",
  );
});

// =========================================================================
// theme.css mirrors these same numbers, by hand (same convention as
// theme.mjs's own TOKENS) -- in the same required order.
// =========================================================================

test("theme.css's own --wtn-z-* custom properties mirror z_layers.mjs's numbers exactly", () => {
  const css = fs.readFileSync(path.join(here, "theme.css"), "utf8");
  const read = (name) => {
    const m = css.match(new RegExp(`--wtn-z-${name}:\\s*(\\d+);`));
    assert.ok(m, `theme.css must declare --wtn-z-${name}`);
    return Number(m[1]);
  };
  assert.equal(read("tooltip"), Z_TOOLTIP);
  assert.equal(read("panel"), Z_PANEL);
  assert.equal(read("modal"), Z_MODAL);
  assert.equal(read("confirm"), Z_CONFIRM);
});

test("theme.css's .wtn-tip rule reads the tooltip rung via var(), not a hardcoded literal", () => {
  const css = fs.readFileSync(path.join(here, "theme.css"), "utf8");
  const rule = css.match(/\.wtn-tip\s*\{([^}]*)\}/);
  assert.ok(rule, ".wtn-tip must be declared in theme.css");
  assert.match(rule[1], /z-index:\s*var\(--wtn-z-tooltip\)/, "must read the shared scale, not a bare number");
});

// =========================================================================
// Every in-scope consumer reads a named rung from THIS module -- never a
// raw literal -- so the next surface that needs a layer picks a name, not a
// number (this module's own top doc comment: "a scale, not a bump").
// =========================================================================

const CONSUMERS = [
  { file: path.join(here, "overlay.mjs"), importName: "Z_PANEL", usage: /overlay\.style\.zIndex\s*=\s*String\(Z_PANEL\)/ },
  { file: path.join(here, "delete_confirm.mjs"), importName: "Z_CONFIRM", usage: /z-index:\s*\$\{Z_CONFIRM\}/ },
  { file: path.join(here, "fields.mjs"), importName: "Z_ELEVATED_TOOLTIP", usage: /z-index:\s*\$\{Z_ELEVATED_TOOLTIP\}/ },
  { file: path.join(controlsDir, "civitai_modal.mjs"), importName: "Z_MODAL", usage: /z-index:\s*\$\{Z_MODAL\}/ },
  { file: path.join(controlsDir, "render.mjs"), importName: "Z_PANEL", usage: /z-index:\s*\$\{Z_PANEL\}/ },
  { file: path.join(controlsDir, "lora_render.mjs"), importName: "Z_PANEL", usage: /z-index:\s*\$\{Z_PANEL\}/ },
  // The last four hand-picked literals (task: "retire the last hand-picked
  // z-index values"). `js/anima/render.mjs`'s `.wtn-an-overlay` was already
  // dead as written (`overlay.mjs`'s own inline `zIndex` wins), migrating it
  // just removes the false `10020` it used to claim. `js/autocomplete/
  // render.mjs`'s popup is a canvas-level anchored popover (never mounts
  // inside the Rule Builder overlay -- `attachAutocomplete` only ever
  // attaches over a node's own widget), so `Z_PANEL`, not a fifth tier.
  // `rule_builder/overlay.mjs` and `prompt_rules/node/picker.mjs` are BOTH
  // full-bleed scrim modals that can genuinely coexist (see each file's own
  // matching comment for the reachability trace), so they take different
  // rungs -- `Z_MODAL` for the Rule Builder, `Z_PANEL` (reused, same
  // convention `Z_ELEVATED_TOOLTIP` already documents) for the picker.
  { file: path.join(animaDir, "render.mjs"), importName: "Z_PANEL", usage: /z-index:\s*\$\{Z_PANEL\}/ },
  { file: path.join(autocompleteDir, "render.mjs"), importName: "Z_PANEL", usage: /z-index:\s*\$\{Z_PANEL\}/ },
  { file: path.join(ruleBuilderDir, "overlay.mjs"), importName: "Z_MODAL", usage: /z-index:\s*\$\{Z_MODAL\}/ },
  { file: path.join(promptRulesNodeDir, "picker.mjs"), importName: "Z_PANEL", usage: /z-index:\s*\$\{Z_PANEL\}/ },
];

for (const { file, importName, usage } of CONSUMERS) {
  const rel = path.relative(path.join(here, ".."), file);
  test(`${rel} imports ${importName} from the shared scale and actually uses it in its own z-index declaration`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, new RegExp(`import\\s*\\{[^}]*\\b${importName}\\b[^}]*\\}\\s*from\\s*["'][^"']*z_layers\\.mjs["']`), `must import ${importName} from z_layers.mjs`);
    assert.match(src, usage, `must actually set z-index from ${importName}, not a hardcoded number`);
  });
}

test("regression guard: none of the ten consumers above declares a raw (>= 900) z-index literal anywhere in its own source -- every one must route through the shared scale", () => {
  const RAW_ZINDEX_RE = /z-index:\s*(\d+)/g;
  const offenders = [];
  for (const { file } of CONSUMERS) {
    const src = fs.readFileSync(file, "utf8");
    let m;
    RAW_ZINDEX_RE.lastIndex = 0;
    while ((m = RAW_ZINDEX_RE.exec(src))) {
      const n = Number(m[1]);
      if (n >= 900) {
        offenders.push(`${path.basename(file)}: z-index: ${n}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a raw high z-index literal outside z_layers.mjs is exactly how the four values ended up hand-picked and inverted in the first place");
});

test("z_layers.mjs itself is the only place these four numbers are allowed to appear as bare literals (sanity check on the regex above, false-green-verification: it must actually catch a planted violation)", () => {
  const planted = "some other rule { z-index: 12345; }";
  const RAW_ZINDEX_RE = /z-index:\s*(\d+)/g;
  const found = [];
  let m;
  while ((m = RAW_ZINDEX_RE.exec(planted))) {
    if (Number(m[1]) >= 900) found.push(Number(m[1]));
  }
  assert.deepEqual(found, [12345], "the detection regex must actually flag a planted raw literal, proving the guard above isn't vacuous");
});

const total = count;
const passed = total - failures;
console.log(`\n${passed}/${total} tests passed`);
if (failures > 0) {
  process.exitCode = 1;
}
