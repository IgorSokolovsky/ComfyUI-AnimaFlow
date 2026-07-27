/**
 * Rule Builder API — thin fetch wrappers for the `/wtn/rules/*` routes
 * described in `docs/nodes-and-api.md` §2. These power the Rule Builder
 * overlay (`js/prompt_rules/rule_builder/`) and (later) the picker popover
 * (`js/prompt_rules/node/`).
 *
 * Every export returns **parsed JSON** on a 2xx response and **throws** on
 * anything else (non-2xx status, a network failure, or a route that simply
 * doesn't exist yet because Track A / `src/prompt_rules/api/rules_api.py` hasn't landed) —
 * callers are expected to `try/catch` and fall back (e.g. the Rule Builder's
 * ported offline JS engine, or a disabled Sheets panel) rather than crash.
 * This file makes no assumption about whether the backend exists yet.
 */

const BASE = "/wtn/rules";

/**
 * Parse a fetch Response as JSON and throw a descriptive Error for any
 * non-2xx status. Tries to read a JSON error body first (`{error}` or
 * `{message}`, matching aiohttp's conventional error shape) before falling
 * back to a bare `HTTP <status>` message.
 */
async function asJson(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // No body, or not JSON — fine for a 2xx with an empty body; for a
    // non-2xx we just fall back to the status-code message below.
  }
  if (!res.ok) {
    const detail = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    throw new Error(`${res.url || BASE} failed: ${detail}`);
  }
  return body;
}

function jsonRequest(method, path, payload) {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** GET /wtn/rules/profiles -> ["anima","illustrious","flux","raw"] */
export async function getProfiles() {
  return asJson(await fetch(`${BASE}/profiles`));
}

/** GET /wtn/rules/sheets -> [{name, character?, rules, mtime, size}] */
export async function listSheets() {
  return asJson(await fetch(`${BASE}/sheets`));
}

/** GET /wtn/rules/sheet?name=celica -> {name, ruleset} */
export async function getSheet(name) {
  return asJson(await fetch(`${BASE}/sheet?name=${encodeURIComponent(name)}`));
}

/**
 * POST /wtn/rules/sheet {name, ruleset}
 * -> {ok:true} on success, or {ok:false, errors:[{path,message}]} on a
 * validation failure (still a 2xx per the contract — callers should check
 * `.ok`, not just catch).
 */
export async function saveSheet(name, ruleset) {
  return asJson(await jsonRequest("POST", "/sheet", { name, ruleset }));
}

/** DELETE /wtn/rules/sheet?name=celica -> {ok} */
export async function deleteSheet(name) {
  return asJson(await fetch(`${BASE}/sheet?name=${encodeURIComponent(name)}`, { method: "DELETE" }));
}

/** POST /wtn/rules/validate {ruleset, profile} -> {ok, errors:[{path,message}]} */
export async function validate(ruleset, profile) {
  return asJson(await jsonRequest("POST", "/validate", { ruleset, profile }));
}

/**
 * POST /wtn/rules/preview {positive, negative, profile, sheets?, embedded?}
 * -> {positive, negative, trace, errors} — the live-preview route the Rule
 * Builder overlay calls on every (debounced) edit.
 */
export async function preview({ positive, negative, profile, sheets, embedded } = {}) {
  return asJson(await jsonRequest("POST", "/preview", { positive, negative, profile, sheets, embedded }));
}

/** GET /wtn/rules/characters -> [{token, name, character, kind, from}] */
export async function getCharacters() {
  return asJson(await fetch(`${BASE}/characters`));
}
