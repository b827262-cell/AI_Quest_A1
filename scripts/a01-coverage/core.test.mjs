/**
 * Unit tests for the A-01 72h coverage report core.
 *
 * Run: node --test scripts/a01-coverage/core.test.mjs
 * No network, no secrets, no real log data.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APPLICABLE_NON_GET_ROUTES,
  PROPOSAL_THRESHOLDS,
  aggregate,
  buildReport,
  evaluateCoverageEquation,
  evaluateNonGetCoverage,
  evaluateSampleGates,
  parseJsonLines,
  pathClassMethodRows,
} from "./core.mjs";

function line(overrides) {
  return JSON.stringify({ evt: "relay.verify", result: "valid", site: "student", mode: "transitional", identityPresent: true, method: "GET", pathClass: "student", synthetic: false, ...overrides });
}

test("parseJsonLines keeps objects and counts malformed/blank lines", () => {
  const text = [`${line({})}`, "", "not json", "[1,2]", `${line({ site: "admin" })}`].join("\n");
  const { records, skipped } = parseJsonLines(text);
  assert.equal(records.length, 2);
  assert.equal(skipped, 2);
});

test("aggregate splits valid samples into natural and synthetic per site", () => {
  const records = [
    JSON.parse(line({ site: "student", synthetic: false })),
    JSON.parse(line({ site: "student", synthetic: true })),
    JSON.parse(line({ site: "admin", synthetic: false })),
    JSON.parse(line({ site: "admin", synthetic: false })),
    JSON.parse(line({ site: "unknown", synthetic: true })),
  ];
  const agg = aggregate(records);
  assert.deepEqual(agg.valid.natural, { student: 1, admin: 2, unknown: 0 });
  assert.deepEqual(agg.valid.synthetic, { student: 1, admin: 0, unknown: 1 });
  assert.equal(agg.verifyCount, 5);
});

test("aggregate counts zero-tolerance items and probes", () => {
  const records = [
    JSON.parse(line({ result: "invalid" })),
    JSON.parse(line({ result: "none", identityPresent: true })),
    JSON.parse(line({ result: "none", identityPresent: false })),
    { evt: "relay.probe", mode: "require", site: "student" },
  ];
  const agg = aggregate(records);
  assert.equal(agg.zeroTolerance.invalid, 1);
  assert.equal(agg.zeroTolerance.noneWithIdentity, 1);
  assert.equal(agg.probeCount, 1);
  assert.equal(agg.verifyCount, 3);
});

test("aggregate buckets counts by pathClass x method", () => {
  const records = [
    JSON.parse(line({ pathClass: "student", method: "GET" })),
    JSON.parse(line({ pathClass: "student", method: "PUT" })),
    JSON.parse(line({ pathClass: "student", method: "PUT" })),
    JSON.parse(line({ pathClass: "admin", method: "DELETE" })),
  ];
  const rows = pathClassMethodRows(aggregate(records).pathClassMethod);
  assert.deepEqual(rows, [
    { pathClass: "admin", method: "DELETE", count: 1 },
    { pathClass: "student", method: "GET", count: 1 },
    { pathClass: "student", method: "PUT", count: 2 },
  ]);
});

test("aggregate ignores records that are neither verify nor probe", () => {
  const agg = aggregate([{ evt: "something.else" }, null]);
  assert.equal(agg.verifyCount, 0);
  assert.equal(agg.skippedRecords, 2);
});

test("evaluateSampleGates ignores synthetic samples", () => {
  const gates = evaluateSampleGates({ natural: { student: 299, admin: 100, unknown: 0 }, synthetic: { student: 1000, admin: 1000, unknown: 0 } });
  assert.equal(gates.allPass, false);
  assert.equal(gates.checks.find((c) => c.id === "student-valid-min").pass, false);
  assert.equal(gates.checks.find((c) => c.id === "admin-valid-min").pass, true);
  assert.equal(gates.proposalNotice, PROPOSAL_THRESHOLDS.proposalNotice);
});

test("evaluateSampleGates passes at exactly the thresholds", () => {
  const gates = evaluateSampleGates({ natural: { student: 300, admin: 100, unknown: 0 }, synthetic: { student: 0, admin: 0, unknown: 0 } });
  assert.equal(gates.allPass, true);
});

test("evaluateNonGetCoverage reports HOLD when no route counts are supplied", () => {
  const coverage = evaluateNonGetCoverage([]);
  assert.equal(coverage.rows.length, APPLICABLE_NON_GET_ROUTES.length);
  assert.ok(coverage.rows.every((row) => row.status === "HOLD"));
  assert.equal(coverage.allPass, false);
  assert.equal(coverage.hasHold, true);
});

test("evaluateNonGetCoverage passes a route only when total >= 30", () => {
  const routeCounts = APPLICABLE_NON_GET_ROUTES.map((route, index) => ({ ...route, natural: index === 0 ? 30 : 1, synthetic: index === 0 ? 0 : 1 }));
  const coverage = evaluateNonGetCoverage(routeCounts);
  assert.equal(coverage.rows[0].status, "PASS");
  assert.equal(coverage.rows[1].status, "FAIL");
  assert.equal(coverage.hasHold, false);
});

test("coverage equation holds when components sum to the ingress total", () => {
  const equation = evaluateCoverageEquation({ ingressTotal: 100, verify: 40, probeStripped: 10, health: 5, books: 20, sync: 5, cors: 3, static: 17 });
  assert.equal(equation.status, "PASS");
  assert.equal(equation.diff, 0);
  assert.equal(equation.proposal, true);
});

test("coverage equation fails on a nonzero difference and holds on missing inputs", () => {
  const failed = evaluateCoverageEquation({ ingressTotal: 100, verify: 40, probeStripped: 10, health: 5, books: 20, sync: 5, cors: 3, static: 16 });
  assert.equal(failed.status, "FAIL");
  assert.equal(failed.diff, 1);
  const held = evaluateCoverageEquation({ ingressTotal: 100 });
  assert.equal(held.status, "HOLD");
  assert.ok(held.missing.includes("verify"));
});

test("buildReport stamps the proposal notice and stays free of raw content", () => {
  const records = [JSON.parse(line({ site: "student", synthetic: false, userEmail: "secret@example.com" }))];
  const agg = aggregate(records);
  const report = buildReport({
    runId: "r1",
    generatedAt: "2026-10-16T00:00:00.000Z",
    aggregate: agg,
    sampleGates: evaluateSampleGates(agg.valid),
    nonGetCoverage: evaluateNonGetCoverage([]),
    coverageEquation: evaluateCoverageEquation(null),
  });
  const serialized = JSON.stringify(report);
  assert.equal(report.proposalNotice, PROPOSAL_THRESHOLDS.proposalNotice);
  assert.equal(serialized.includes("secret@example.com"), false);
  assert.equal(report.coverageEquation.proposalNotice, PROPOSAL_THRESHOLDS.proposalNotice);
  assert.ok(report.notes.some((note) => note.includes(PROPOSAL_THRESHOLDS.proposalNotice)));
});
