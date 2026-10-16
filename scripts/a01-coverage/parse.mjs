/**
 * Parser for the sanitized relay.verify log summary consumed by the A-01
 * coverage aggregator.
 *
 * Input is newline-delimited JSON (JSON Lines). Each line is expected to be one
 * `relay.verify` application-log event with the fields documented in
 * `docs/ops/relay-rollout.md` §4.4:
 *
 *   evt, result, site, mode, identityPresent, method, pathClass, synthetic
 *
 * An optional `route` (route template, e.g. `/api/admin/books/[id]`) and `ts`
 * may be present when the summary was cross-referenced with invocation data.
 *
 * This module only reads and validates shape. It never persists raw lines; the
 * caller keeps aggregates only. Malformed lines are counted, never silently
 * dropped.
 */

export const RESULT_VALUES = Object.freeze(["none", "valid", "invalid"]);
export const SITE_VALUES = Object.freeze(["student", "admin", "unknown"]);
export const MODE_VALUES = Object.freeze(["transitional", "strict", "off"]);
export const METHOD_VALUES = Object.freeze(["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OTHER"]);
export const PATH_CLASS_VALUES = Object.freeze(["student", "admin", "other", "health"]);

export const RELAY_EVENT = "relay.verify";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a single already-parsed object as a relay.verify event.
 * @returns {{ok:true,event:object}|{ok:false,reason:string}}
 */
export function validateEvent(value) {
  if (!isPlainObject(value)) return { ok: false, reason: "not an object" };
  if (value.evt !== RELAY_EVENT) return { ok: false, reason: `unexpected evt: ${String(value.evt)}` };
  if (!RESULT_VALUES.includes(value.result)) return { ok: false, reason: `bad result: ${String(value.result)}` };
  if (!SITE_VALUES.includes(value.site)) return { ok: false, reason: `bad site: ${String(value.site)}` };
  if (!MODE_VALUES.includes(value.mode)) return { ok: false, reason: `bad mode: ${String(value.mode)}` };
  if (typeof value.identityPresent !== "boolean") return { ok: false, reason: "identityPresent not boolean" };
  if (!METHOD_VALUES.includes(value.method)) return { ok: false, reason: `bad method: ${String(value.method)}` };
  if (!PATH_CLASS_VALUES.includes(value.pathClass)) return { ok: false, reason: `bad pathClass: ${String(value.pathClass)}` };
  if (typeof value.synthetic !== "boolean") return { ok: false, reason: "synthetic not boolean" };
  if (value.route !== undefined && typeof value.route !== "string") return { ok: false, reason: "route not a string" };
  return {
    ok: true,
    event: {
      result: value.result,
      site: value.site,
      mode: value.mode,
      identityPresent: value.identityPresent,
      method: value.method,
      pathClass: value.pathClass,
      synthetic: value.synthetic,
      route: value.route,
    },
  };
}

/**
 * Parse a JSON Lines payload.
 *
 * @param {string} text
 * @returns {{events:object[], parseErrors:Array<{line:number,reason:string}>, blankLines:number, nonRelayLines:number, totalLines:number}}
 */
export function parseJsonLines(text) {
  const events = [];
  const parseErrors = [];
  let blankLines = 0;
  let nonRelayLines = 0;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (raw === "") { blankLines += 1; continue; }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parseErrors.push({ line: i + 1, reason: "invalid JSON" });
      continue;
    }
    const result = validateEvent(parsed);
    if (result.ok) {
      events.push(result.event);
    } else if (isPlainObject(parsed) && parsed.evt !== undefined && parsed.evt !== RELAY_EVENT) {
      // A well-formed line that is simply a different event type.
      nonRelayLines += 1;
    } else {
      parseErrors.push({ line: i + 1, reason: result.reason });
    }
  }
  return { events, parseErrors, blankLines, nonRelayLines, totalLines: lines.length };
}
