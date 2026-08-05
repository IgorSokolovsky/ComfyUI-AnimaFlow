/**
 * layout_check.mjs — the measured-layout check (`docs/TODO.md`'s *Now* item
 * 4). Run it deliberately with `node js/controls/layout_check.mjs` -- it is
 * NOT a `test_*.mjs` and the repo's own sweep (`node` over every `test_*.mjs`
 * under `js/`, recursively) cannot pick it up, on purpose (this task's own
 * hard constraint): nothing in this pack's ~1,900 JS assertions has a layout
 * engine, and everything under `test_*.mjs` runs against a hand-rolled
 * doc-stub with none either.
 * This is the other kind of check -- it drives REAL headless Chrome over the
 * REAL production render modules and measures `getBoundingClientRect()`, the
 * one thing a doc-stub can never produce.
 *
 * ## What it actually does
 *
 * 1. Locates a real Chrome binary (macOS-pathed, see `CHROME_CANDIDATES`
 *    below) -- if it's missing, this FAILS LOUDLY (non-zero exit, an
 *    unmistakable message naming what could not be measured). It never
 *    degrades to a silent skip that still prints something that reads as
 *    green -- that is the exact false-green failure mode this check exists
 *    to end (`.claude/skills/false-green-verification/SKILL.md`).
 * 2. Starts a tiny static file server over the repo root on loopback, so
 *    Chrome can load `js/controls/layout_check_probe.mjs` (the browser-side
 *    half, see that file's own doc comment) as a REAL ES module with REAL
 *    relative imports of the production `.mjs` files it measures -- the same
 *    resolution a live ComfyUI page uses, never a bundler or a `node`-side
 *    stub.
 * 3. Serves one generated HTML shell that links `js/shared/theme.css` and
 *    loads that probe module -- this is where the `.wtn`-ancestor
 *    requirement lives; `layout_check_probe.mjs`'s own `mountWtn()` is what
 *    actually applies the class per mount, but the theme stylesheet itself
 *    is loaded HERE, once, so no invariant can forget it.
 * 4. Runs Chrome headless with `--dump-dom`, which serializes the page's
 *    final DOM (after `--virtual-time-budget` lets the probe's own
 *    `requestAnimationFrame`/promise chain settle) to stdout -- the probe's
 *    own `<pre id="wtn-probe-json">` is what this file extracts and
 *    `JSON.parse`s.
 * 5. Runs `ASSERTIONS` (below) against the parsed numbers, each with a
 *    tolerance -- never a hardcoded golden pixel value, since a legitimate
 *    design change would otherwise permanently red this check (this task's
 *    own brief). Prints one `ok -`/`FAIL -` line per invariant, matching
 *    this pack's own `test_*.mjs` console convention, and exits non-zero on
 *    any failure OR on any page-level error/exception the probe recorded --
 *    a scenario that threw partway through must never be graded as if every
 *    later invariant had actually been measured.
 *
 * ## When it fails
 *
 * - **"Chrome not found"** -- install Google Chrome at the default macOS
 *   location, or set `WTN_CHROME_BIN` to the binary's full path. This is the
 *   only environment dependency; nothing here touches `requirements.txt` or
 *   any `package.json` (this repo has neither for this purpose, by design --
 *   this task's own hard constraints).
 * - **"harness sanity check failed (boxSizing=...)"** -- `theme.css` didn't
 *   load or the `.wtn` ancestor didn't apply; every OTHER number in the run
 *   is a probe artifact, not a real measurement (`.claude/skills/css-layout-
 *   diagnose-headless/SKILL.md`'s own "stop and fix the harness before
 *   believing any number" rule) -- fix the server/page shell below, not the
 *   production CSS.
 * - **A named invariant FAILs** -- read its own doc comment in
 *   `layout_check_probe.mjs` for which commit/bug it pins, then re-run the
 *   `css-layout-diagnose-headless` skill's own workflow (instrument a copy,
 *   measure, do the arithmetic) against the SAME production file the
 *   invariant imports -- this check tells you WHAT regressed, the skill is
 *   how you find WHERE.
 * - **"the probe page reported N page error(s)"** -- a real exception ran
 *   during a scenario (an import failed, a fixture shape changed underneath
 *   this file). Fix the harness or the fixture; do not silence the error and
 *   keep the numbers that came after it, they cannot be trusted.
 *
 * ## Adding a new invariant
 *
 * See `layout_check_probe.mjs`'s own doc comment for the browser-side half.
 * On this side, add one entry to `ASSERTIONS` below: a `name`, the
 * `results.invariants.<key>` path it reads, and a tolerance-based `check(v)`
 * that returns `{ pass, detail }`.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PROBE_HTML_PATH = "/__wtn_layout_probe__.html";
const PROBE_MODULE_PATH = "/js/controls/layout_check_probe.mjs";

const MIME_TYPES = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

// ---------------------------------------------------------------------------
// Chrome discovery -- fails LOUDLY, never a silent skip (task brief, hard
// constraint 3: "a self-skipping check that prints PASS having measured
// nothing is exactly the false-green failure mode this whole check exists
// to end").
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  process.env.WTN_CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Fall through -- try the next candidate.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// A tiny static file server over the repo root -- Chrome needs a real HTTP
// origin (not `file://`) so `layout_check_probe.mjs`'s relative ES-module
// imports of the production `.mjs` files resolve exactly the way they do in
// a live ComfyUI page.
// ---------------------------------------------------------------------------

function buildProbeHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/js/shared/theme.css">
<style>html,body{margin:0;padding:0;background:#0a0d12;}</style>
</head>
<body>
<script type="module" src="${PROBE_MODULE_PATH}"></script>
</body>
</html>
`;
}

function startServer() {
  const probeHtml = buildProbeHtml();
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    if (urlPath === PROBE_HTML_PATH) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(probeHtml);
      return;
    }
    // Everything else is served straight off disk, rooted at the repo --
    // this is what lets `/js/controls/layout_check_probe.mjs` resolve its own
    // relative imports of `/js/controls/model_detail_view.mjs` etc. exactly
    // like a live ComfyUI page does.
    const filePath = path.join(REPO_ROOT, urlPath);
    if (!filePath.startsWith(REPO_ROOT)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end(`not found: ${urlPath}`);
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

// ---------------------------------------------------------------------------
// Running Chrome + extracting the probe's own JSON blob out of --dump-dom
// ---------------------------------------------------------------------------

/**
 * Spawns headless Chrome and returns its `--dump-dom` stdout.
 *
 * Deliberately NOT `execFileSync`/`spawnSync`: those wait for the tracked
 * child's stdio PIPES to fully close (EOF), and on macOS a `Google Chrome`
 * launch (even fully headless, even with `--disable-*` flags) spawns
 * Keystone/`GoogleUpdater` helper processes as children of Chrome's own
 * process that INHERIT those pipe file descriptors and can keep them open
 * for 30-90+ seconds after Chrome itself is done and has written the dump --
 * measured on this exact machine. That looks identical to a genuine hang and
 * cost real time to diagnose (`ps` showing Chrome's own process already gone
 * while `GoogleUpdater --wake-all` children, parented to it, lingered).
 *
 * The fix: spawn Chrome `detached: true` (its own process GROUP, via
 * `setsid`), accumulate stdout ourselves, resolve the moment Chrome's own
 * process (not its descendants) reports `exit`, then SIGKILL the whole
 * group (`process.kill(-pid, ...)`) so no orphaned Keystone helper is left
 * running -- both to return promptly and so a second run never accumulates
 * leftover processes across CI-less, unattended invocations.
 */
function runProbe(chromePath, url) {
  return new Promise((resolve, reject) => {
    // A FRESH, throwaway `--user-data-dir` per run -- without one, headless
    // Chrome launches against the user's REAL default profile, which wakes
    // the whole background-service ecosystem (GoogleUpdater, GCM
    // registration, sync). Isolated here precisely so this check's own
    // runtime depends on nothing about whichever Chrome installs/profiles
    // happen to exist on the machine it runs on.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wtn-layout-check-"));
    const cleanupUserDataDir = () => fs.rmSync(userDataDir, { recursive: true, force: true });

    const args = [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-client-side-phishing-detection",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-breakpad",
      "--virtual-time-budget=6000",
      "--window-size=1400,900",
      "--dump-dom",
      url,
    ];

    const child = spawn(chromePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL"); // negative pid -- the whole detached group, not just Chrome's own pid
      } catch {
        // Already gone -- fine.
      }
    };

    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      killGroup();
      cleanupUserDataDir();
      fn();
    };

    // A completion MARKER inside the accumulating stdout, not `exit`/`close`.
    // Measured on this exact machine: macOS `Google Chrome` can take 30-90+
    // seconds to actually terminate its OWN process after `--dump-dom` has
    // already written the full page (it appears to block its own shutdown
    // on a Keystone/update-check round-trip) -- so `exit` is unreliable as
    // the "we have our data" signal, and `close` is worse (waits for
    // inherited-fd grandchildren too, per this function's own top doc
    // comment). The probe page's own final act
    // (`layout_check_probe.mjs`'s `run().finally()`) is to append
    // `<pre id="wtn-probe-json">` and set `document.title` -- the instant
    // BOTH are visible in the dump, the data we need exists and everything
    // after it (Chrome's own teardown) is irrelevant.
    const isComplete = () => stdout.includes("wtn-probe-json") && stdout.includes("</html>");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (isComplete()) {
        finish(() => resolve(stdout));
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const watchdog = setTimeout(() => {
      finish(() => reject(new Error(
        `headless Chrome did not produce a complete dump within 45s.\n`
        + `stdout so far (${stdout.length} chars): ${stdout.slice(0, 500)}\n`
        + `stderr so far (${stderr.length} chars): ${stderr.slice(-2000)}`,
      )));
    }, 45_000);

    child.on("error", (err) => {
      finish(() => reject(err));
    });

    // `exit`, not `close` -- `close` waits for the stdio streams to end,
    // which (per this function's own doc comment) can be held open by
    // Chrome's own inherited-fd grandchildren long after Chrome itself is
    // done. Kept as a fallback completion path for a well-behaved Chrome
    // that exits promptly; the marker check above is the PRIMARY path.
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      if (code !== 0 && code !== null) {
        finish(() => reject(new Error(`headless Chrome exited with code ${code} (signal ${signal}). stderr:\n${stderr.slice(-4000)}`)));
        return;
      }
      finish(() => resolve(stdout));
    });
  });
}

function unescapeHtmlText(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractResults(domText) {
  const match = domText.match(/<pre id="wtn-probe-json"[^>]*>([\s\S]*?)<\/pre>/);
  if (!match) {
    return null;
  }
  const raw = unescapeHtmlText(match[1]);
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Assertions -- one entry per pinned invariant. Every `check` is tolerance-
// based (task brief: "a tolerance is fine; a hardcoded golden pixel value is
// not").
// ---------------------------------------------------------------------------

const ASSERTIONS = [
  {
    name: "gallery filmstrip has non-zero height when populated (25b60f1)",
    check(results) {
      const v = results.invariants.filmstripHeight;
      if (!v) {
        return { pass: false, detail: "no filmstripHeight measurement recorded" };
      }
      // A collapsed filmstrip measured 0 (task brief); a healthy one is the
      // full ~115px tile. 40px is comfortably above "collapsed", comfortably
      // below "a legitimate future tile-size change broke this".
      const pass = v.filmstripHeightPx > 40 && v.tileHeightPx > 40;
      return { pass, detail: JSON.stringify(v) };
    },
  },
  {
    name: "LoRA row caret is x-aligned across rows of differing name length (cc36388)",
    check(results) {
      const v = results.invariants.caretAlignment;
      if (!v) {
        return { pass: false, detail: "no caretAlignment measurement recorded" };
      }
      // The owner's own pre-fix measurement spread was ~114px (114.3 to
      // 228.8); post-fix, all three landed on the identical 225.2. 1.5px
      // covers real sub-pixel layout noise without accepting anything close
      // to the original bug's own spread.
      const pass = Number.isFinite(v.spreadPx) && v.spreadPx <= 1.5;
      return { pass, detail: JSON.stringify(v) };
    },
  },
  {
    name: "prompt drawer fits inside its tile (e05f6fd)",
    check(results) {
      const v = results.invariants.drawerFitsTile;
      if (!v || !Number.isFinite(v.drawerHeightPx) || !Number.isFinite(v.tileHeightPx)) {
        return { pass: false, detail: "no drawerFitsTile measurement recorded" };
      }
      const pass = v.drawerHeightPx <= v.tileHeightPx + 1;
      return { pass, detail: JSON.stringify(v) };
    },
  },
  {
    name: "no page-level horizontal scroll on the detail view (f82d08a)",
    check(results) {
      const v = results.invariants.noPageHorizontalScroll;
      if (!v) {
        return { pass: false, detail: "no noPageHorizontalScroll measurement recorded" };
      }
      // A couple of px of tolerance for scrollbar-width rounding across
      // engines; anything past that is real overflow, not noise.
      const pass = v.docScrollWidthPx <= v.docClientWidthPx + 2
        && v.bodyScrollWidthPx <= v.bodyClientWidthPx + 2;
      return { pass, detail: JSON.stringify(v) };
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error("=".repeat(78));
    console.error("FAIL — no headless Chrome found. NOTHING WAS MEASURED.");
    console.error("");
    console.error("Checked: " + (process.env.WTN_CHROME_BIN ? `$WTN_CHROME_BIN=${process.env.WTN_CHROME_BIN}, ` : "")
      + `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`);
    console.error("Install Google Chrome at that path, or set WTN_CHROME_BIN to a real binary.");
    console.error("This check refuses to report PASS without a real measurement.");
    console.error("=".repeat(78));
    process.exitCode = 1;
    return;
  }

  const { server, port } = await startServer();
  let domText;
  try {
    const url = `http://127.0.0.1:${port}${PROBE_HTML_PATH}`;
    try {
      domText = await runProbe(chromePath, url);
    } catch (err) {
      console.error("=".repeat(78));
      console.error("FAIL — headless Chrome did not run to completion. NOTHING WAS MEASURED.");
      console.error(err && err.message ? err.message : String(err));
      console.error("=".repeat(78));
      process.exitCode = 1;
      return;
    }
  } finally {
    server.close();
  }

  let results;
  try {
    results = extractResults(domText);
  } catch (err) {
    console.error("=".repeat(78));
    console.error("FAIL — the probe page's own JSON blob did not parse. NOTHING WAS MEASURED.");
    console.error(err && err.message ? err.message : String(err));
    console.error("--- first 2000 chars of the dumped DOM, for debugging ---");
    console.error(domText.slice(0, 2000));
    console.error("=".repeat(78));
    process.exitCode = 1;
    return;
  }
  if (!results) {
    console.error("=".repeat(78));
    console.error("FAIL — no <pre id=\"wtn-probe-json\"> found in the dumped DOM. NOTHING WAS MEASURED.");
    console.error("The probe page likely failed to load its module script (check MIME types");
    console.error("and that js/controls/layout_check_probe.mjs actually exists and imports cleanly).");
    console.error("--- first 2000 chars of the dumped DOM, for debugging ---");
    console.error(domText.slice(0, 2000));
    console.error("=".repeat(78));
    process.exitCode = 1;
    return;
  }

  if (results.fatal) {
    console.error("=".repeat(78));
    console.error("FAIL — the probe page threw before finishing. NOTHING PAST THAT POINT WAS MEASURED.");
    console.error(results.fatal);
    console.error("=".repeat(78));
    process.exitCode = 1;
    return;
  }

  if (Array.isArray(results.errors) && results.errors.length > 0) {
    console.error("=".repeat(78));
    console.error(`FAIL — the probe page reported ${results.errors.length} page error(s)/rejection(s):`);
    for (const e of results.errors) {
      console.error(`  - ${e}`);
    }
    console.error("Any measurement taken after one of these cannot be trusted.");
    console.error("=".repeat(78));
    process.exitCode = 1;
    return;
  }

  if (results.meta.boxSizing !== "border-box") {
    console.error("=".repeat(78));
    console.error(`FAIL — harness sanity check failed: boxSizing=${results.meta.boxSizing}, expected border-box.`);
    console.error(`(sanityWidthPx=${results.meta.sanityWidthPx}, expected 50 for a 50px box with border-box)`);
    console.error("theme.css's .wtn scoping did not engage -- every measurement below would be the");
    console.error("~17px-inflated probe artifact this task's own brief warns about, not a real bug.");
    console.error("Fix js/controls/layout_check.mjs's page shell / server, not any production CSS.");
    console.error("=".repeat(78));
    process.exitCode = 1;
    return;
  }

  // `WTN_DEBUG_RESULTS=1 node js/controls/layout_check.mjs` -- prints every
  // raw measurement regardless of pass/fail, for tuning a new invariant's
  // tolerance or diagnosing why one didn't move the way a revert was
  // expected to (several did not, while building this check -- see the
  // notes on invariant 4 in this file's own top doc comment / the build
  // report this check shipped with).
  if (process.env.WTN_DEBUG_RESULTS) {
    console.error("DEBUG results.invariants:", JSON.stringify(results.invariants, null, 2));
  }

  let failures = 0;
  for (const assertion of ASSERTIONS) {
    const { pass, detail } = assertion.check(results);
    if (pass) {
      console.log(`ok - ${assertion.name}`);
    } else {
      failures += 1;
      console.error(`FAIL - ${assertion.name}`);
      console.error(`       ${detail}`);
    }
  }

  console.log("");
  console.log(`${ASSERTIONS.length - failures}/${ASSERTIONS.length} measured layout invariants passed.`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("=".repeat(78));
  console.error("FAIL — layout_check.mjs itself threw. NOTHING WAS MEASURED.");
  console.error(err && err.stack ? err.stack : String(err));
  console.error("=".repeat(78));
  process.exitCode = 1;
});
