/**
 * test_theme.mjs — regression tests for `theme.css`'s shared, cross-file
 * utility/component rules (as opposed to `theme.mjs`'s own `injectTheme`/
 * `TOKENS`, which have no dedicated test file because there is nothing pure
 * to assert beyond "reads the raw CSS text"). Plain `node
 * js/shared/test_theme.mjs`.
 *
 * Covers: `.wtn-flex-bound` (the shared "a flex/scroll region that actually
 * bounds its own content" fix, 2026-08-01 -- civitai_modal.mjs's own
 * `.wtn-cm-main`/`.wtn-cm-detailhost` and model_detail_view.mjs's own
 * `.wtn-dv`/`.wtn-dv-body` all lean on this ONE rule rather than a fourth+
 * hand-written `min-width: 0; min-height: 0;` pair), `.wtn-select:hover`
 * (owner, 2026-08-01: "on the select field we need to show cursor pointer on
 * hover and border teal color (not shiny)" -- asserted on the SHARED base
 * class, never a mount-scoped descendant selector, so a later mount can't
 * silently miss it the way the arrow-clearance fix did earlier the same
 * day), and `.wtn-select`'s own control HEIGHT (owner, with a screenshot,
 * 2026-08-01: the modal grid card's version select read visibly taller than
 * its Download button -- the 26px height this track had already picked lived
 * on two per-surface classes and never on THIS shared one, so a new select
 * inherited nothing and came out wrong; declared here now, with a regression
 * guard that no per-surface select class in the controls track redeclares
 * it).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const css = fs.readFileSync(path.join(here, "theme.css"), "utf8");

test("`.wtn-flex-bound` -- the shared min-width/min-height: 0 fix for a bounded flex/scroll region", () => {
  const rule = css.match(/\.wtn-flex-bound\s*\{([^}]*)\}/);
  assert.ok(rule, ".wtn-flex-bound must be declared in theme.css");
  assert.match(rule[1], /min-width:\s*0;?/, "must zero min-width -- the flex-row overflow trap");
  assert.match(rule[1], /min-height:\s*0;?/, "must zero min-height -- the flex-column overflow trap");
});

test("`.wtn-select:not(:disabled):hover` -- cursor: pointer and a MUTED teal border (--wtn-accent-deep), declared on the SHARED base class", () => {
  const rule = css.match(/\.wtn-select:not\(:disabled\):hover\s*\{([^}]*)\}/);
  assert.ok(rule, ".wtn-select:not(:disabled):hover must be declared on the shared .wtn-select base, not a mount-scoped descendant selector");
  assert.match(rule[1], /cursor:\s*pointer;?/, "a <select> must read as clickable on hover");
  assert.match(rule[1], /border-color:\s*var\(--wtn-accent-deep\)/, "must use the MUTED teal token");
  assert.doesNotMatch(rule[1], /var\(--wtn-accent-strong\)/, "must never use the brighter --wtn-accent-strong token -- 'not shiny' was the explicit ask");
  assert.doesNotMatch(rule[1], /box-shadow|background/, "only the border may change on hover -- no glow, no background shift");
});

test("`.wtn-select` hover is explicitly EXCLUDED for a disabled select -- a genuine, documented exception, not a quiet special case", () => {
  // The bare `.wtn-select:hover` (no `:not(:disabled)` guard) must not also
  // exist as a second, competing rule.
  assert.doesNotMatch(css, /\.wtn-select:hover\s*\{/, "must not ALSO declare an unguarded .wtn-select:hover -- that would re-apply the pointer/teal border to a disabled select too");
});

test("`.wtn-select:not(:disabled):hover` reads --wtn-accent-deep specifically, not the plain (brighter) --wtn-accent", () => {
  const rule = css.match(/\.wtn-select:not\(:disabled\):hover\s*\{([^}]*)\}/)[1];
  // A bare `var(--wtn-accent)` (no `-deep`/`-strong` suffix) would also match
  // a naive `/--wtn-accent/` search, so this checks the token name exactly.
  const borderColorDecl = rule.match(/border-color:\s*([^;]+);?/)[1].trim();
  assert.equal(borderColorDecl, "var(--wtn-accent-deep)");
});

// =========================================================================
// Owner-reported, with a screenshot (2026-08-01): "the select field in the
// browser modal preview height should be lower -- same height as the
// download button." Root cause: the 26px control height this track already
// used (model_detail_view.mjs's own `.wtn-dv-version-sel`/`.wtn-dv-back`,
// civitai_modal.mjs's own `.wtn-dv-topbar .wtn-cm-action`) had only ever been
// declared on per-surface classes, never on the shared `.wtn-select` base a
// new select inherits by construction -- so civitai_modal.mjs's own
// `.wtn-cm-version-sel` (which DOES carry `.wtn-select`) fell through to a
// plain <select>'s native UA sizing instead. This is the fourth occurrence of
// the same shape this session (arrow clearance, hover treatment, the flex
// `min-*: 0` trap, now this) -- fixed on the shared class, with a guard that
// nothing quietly re-declares it per-surface again.
// =========================================================================

test("`.wtn-select` -- the shared control height (26px) every select in the track inherits, declared on the shared base itself", () => {
  const rule = css.match(/\.wtn-select\s*\{([^}]*)\}/);
  assert.ok(rule, ".wtn-select must be declared in theme.css");
  assert.match(rule[1], /height:\s*26px;?/, "the shared height fix must live on .wtn-select itself");
});

test("regression guard: no per-surface select class in the controls track re-declares its own height -- that duplication is exactly how the modal card's select fell through to native UA sizing", () => {
  const controlsDir = path.join(here, "..", "controls");
  const modelDetailViewSrc = fs.readFileSync(path.join(controlsDir, "model_detail_view.mjs"), "utf8");
  const civitaiModalSrc = fs.readFileSync(path.join(controlsDir, "civitai_modal.mjs"), "utf8");

  const dvVersionSelRule = modelDetailViewSrc.match(/\.wtn-dv-version-sel\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(dvVersionSelRule, /height:/, ".wtn-dv-version-sel must not re-declare height -- it must inherit the shared .wtn-select base instead");

  const cmVersionSelRule = civitaiModalSrc.match(/\.wtn-cm-version-sel\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(cmVersionSelRule, /height:/, ".wtn-cm-version-sel must not re-declare height -- same regression, one select later");
});

const total = count;
const passed = total - failures;
console.log(`\n${passed}/${total} tests passed`);
if (failures > 0) {
  process.exitCode = 1;
}
