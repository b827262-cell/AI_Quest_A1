/**
 * Unit tests for the A-01 coverage aggregator.
 * Run: node --test scripts/a01-coverage/a01-coverage.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseJsonLines, validateEvent } from "./parse.mjs";
import { computeCounts, DEFAULT_APPLICABLE_NON_GET } from "./counts.mjs";
import { computeEquation, EQUATION_LABEL, DEFAULT_BUCKETS } from "./equation.mjs";
import { buildReport } from "./aggregate.mjs";

function ev(overrides = {}) {
  return {
    evt: "relay.verify",
    result: "valid",
    site: "student",
    mode: "transitional",
    identityPresent: true,
    method: "GET",
    pathClass: "student",
    synthetic: false,
    ...overrides,
  };
}

function jsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

// --------------------------------------------------------------------------
// parse
// --------------------------------------------------------------------------

test("validateEvent accepts a well-formed event and rejects bad ones", () => {
  assert.equal(validateEvent(ev()).ok, true);
  assert.match(validateEvent(ev({ result: "weird" })).reason, /bad result/);
  assert.match(validateEvent(ev({ method: "FROBNICATE" })).reason, /bad method/);
  assert.match(validateEvent(ev({ synthetic: "yes" })).reason, /synthetic not boolean/);
  assert.match(validateEvent({ evt: "other" }).reason, /unexpected evt/);
  assert.equal(validateEvent(null).ok, false);
});

test("parseJsonLines counts blanks, parse errors and non-relay lines", () => {
  const text = [
    JSON.stringify(ev()),
    "",
    "{not json}",
    JSON.stringify({ evt: "relay.probe", result: "none" }),
    JSON.stringify(ev({ synthetic: true })),
  ].join("\n");
  const parsed = parseJsonLines(text);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.blankLines, 1);
  assert.equal(parsed.parseErrors.length, 1);
  assert.equal(parsed.nonRelayLines, 1);
});

test("parseJsonLines records the line number of a parse error", () => {
  const parsed = parseJsonLines(`${JSON.stringify(ev())}\n{bad}`);
  assert.equal(parsed.parseErrors[0].line, 2);
});

// --------------------------------------------------------------------------
// counts
// --------------------------------------------------------------------------

test("computeCounts splits natural and synthetic valid counts per site", () => {
  const events = [
    ev({ site: "student", synthetic: false }),
    ev({ site: "student", synthetic: true }),
    ev({ site: "admin", synthetic: true }),
    ev({ site: "admin", result: "invalid" }),
  ].map((e) => validateEvent(e).event);
  const c = computeCounts(events);
  assert.deepEqual(c.valid.student, { natural: 1, synthetic: 1, total: 2 });
  assert.deepEqual(c.valid.admin, { natural: 0, synthetic: 1, total: 1 });
});

test("synthetic samples never count toward Student 300 / Admin 100", () => {
  const events = [];
  for (let i = 0; i < 5; i += 1) events.push(validateEvent(ev({ site: "student", synthetic: true })).event);
  const c = computeCounts(events, { thresholds: { studentValid: 3 } });
  assert.equal(c.thresholds.student_valid.natural, 0);
  assert.equal(c.thresholds.student_valid.met, false);
});

test("per-path verb counts natural + synthetic and needs a route field", () => {
  const events = [
    validateEvent(ev({ site: "student", method: "PUT", pathClass: "student", route: "/api/student/progress", synthetic: false })).event,
    validateEvent(ev({ site: "student", method: "PUT", pathClass: "student", route: "/api/student/progress", synthetic: true })).event,
  ];
  const c = computeCounts(events, {
    thresholds: { perPathVerb: 2 },
    applicable: [{ site: "student", route: "/api/student/progress", method: "PUT" }],
  });
  assert.equal(c.route_available, true);
  assert.equal(c.thresholds.per_path_verb.status, "evaluated");
  const row = c.thresholds.per_path_verb.rows[0];
  assert.equal(row.natural, 1);
  assert.equal(row.synthetic, 1);
  assert.equal(row.total, 2);
  assert.equal(row.met, true);
});

test("per-path verb is undeterminable without a route field", () => {
  const events = [validateEvent(ev({ method: "PUT", pathClass: "student" })).event];
  const c = computeCounts(events);
  assert.equal(c.route_available, false);
  assert.equal(c.thresholds.per_path_verb.status, "undeterminable");
  assert.match(c.thresholds.per_path_verb.reason, /route/);
  assert.equal(c.thresholds.per_path_verb.rows.length, DEFAULT_APPLICABLE_NON_GET.length);
});

test("computeCounts reports zero-tolerance violations", () => {
  const events = [
    validateEvent(ev({ result: "invalid" })).event,
    validateEvent(ev({ result: "none", identityPresent: true })).event,
    validateEvent(ev({ result: "none", identityPresent: false })).event,
  ];
  const c = computeCounts(events);
  assert.equal(c.zero_tolerance.invalid, 1);
  assert.equal(c.zero_tolerance.none_with_identity, 1);
  assert.equal(c.zero_tolerance.ok, false);
});

test("computeCounts tallies pathClass x method buckets", () => {
  const events = [
    validateEvent(ev({ pathClass: "admin", method: "POST", site: "admin" })).event,
    validateEvent(ev({ pathClass: "admin", method: "POST", site: "admin", synthetic: true })).event,
    validateEvent(ev({ pathClass: "health", method: "GET", site: "unknown" })).event,
  ];
  const c = computeCounts(events);
  assert.deepEqual(c.path_class_method["admin/POST"], { natural: 1, synthetic: 1, total: 2 });
  assert.deepEqual(c.path_class_method["health/GET"], { natural: 1, synthetic: 0, total: 1 });
});

// --------------------------------------------------------------------------
// equation
// --------------------------------------------------------------------------

test("computeEquation flags a zero and a non-zero difference and carries the label", () => {
  const ok = computeEquation({ ingressTotal: 100, buckets: { verify: 60, probeStripped: 10, health: 5, books: 10, sync: 5, cors: 5, static: 5 } });
  assert.equal(ok.difference, 0);
  assert.equal(ok.ok, true);
  assert.equal(ok.label, EQUATION_LABEL);
  const bad = computeEquation({ ingressTotal: 100, buckets: { verify: 50 } });
  assert.equal(bad.difference, 50);
  assert.equal(bad.ok, false);
});

test("computeEquation defaults to the proposal bucket set", () => {
  const eq = computeEquation({ ingressTotal: 0 });
  assert.deepEqual(Object.keys(eq.buckets), [...DEFAULT_BUCKETS]);
});

// --------------------------------------------------------------------------
// buildReport (integration)
// --------------------------------------------------------------------------

test("buildReport ties source, counts and equation together", () => {
  const text = jsonl([
    ev({ site: "student", result: "valid", synthetic: false }),
    ev({ site: "admin", result: "valid", synthetic: true, pathClass: "admin", method: "POST" }),
    "{bad json}",
  ]);
  const report = buildReport(text, { equation: { ingressTotal: 2, buckets: { verify: 2 } } });
  assert.equal(report.source.parsed_events, 2);
  assert.equal(report.source.parse_errors, 1);
  assert.equal(report.counts.valid.student.natural, 1);
  assert.equal(report.counts.valid.admin.synthetic, 1);
  assert.equal(report.equation.ok, true);
});

test("buildReport omits the equation when not provided", () => {
  const report = buildReport(jsonl([ev()]));
  assert.equal(report.equation, null);
});
