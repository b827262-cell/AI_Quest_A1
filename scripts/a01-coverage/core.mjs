/**
 * A-01 72h coverage report — pure core.
 *
 * Consumes a redacted JSON-lines log summary (fields mirroring the
 * `relay.verify` / `relay.probe` application logs) and produces the counts the
 * acceptance runbook needs:
 *   - valid samples split natural vs synthetic, per site;
 *   - per pathClass x method counts;
 *   - Student >=300 / Admin >=100 gates on *natural* samples only;
 *   - per applicable non-GET path x verb >=30 (synthetic only fills the floor);
 *   - zero-tolerance items (result=invalid; result=none with identityPresent).
 *
 * The ingress coverage equation is a *proposal*: it is evaluated from
 * caller-supplied, configurable inputs and every report that contains it is
 * stamped "提案，未經 Owner 確認".
 *
 * No raw log text, PII, or secret ever leaves this module: only counters and
 * fixed labels are emitted.
 */

/** Thresholds are proposals until the Owner confirms them. */
export const PROPOSAL_THRESHOLDS = Object.freeze({
  studentValidMin: 300,
  adminValidMin: 100,
  nonGetPerPathMin: 30,
  proposalNotice: "提案，未經 Owner 確認",
});

/**
 * Applicable non-GET relay-protected routes (docs/ops/relay-rollout.md §4.3,
 * baseline `d4d5c026`). Log records only carry `pathClass`, which cannot tell
 * sub-routes apart, so per-route counts come from the optional route-counts
 * input; without it these rows are reported as HOLD, never inferred.
 */
export const APPLICABLE_NON_GET_ROUTES = Object.freeze([
  { site: "student", method: "PUT", pathTemplate: "/api/student/progress" },
  { site: "admin", method: "POST", pathTemplate: "/api/admin/books" },
  { site: "admin", method: "DELETE", pathTemplate: "/api/admin/books" },
  { site: "admin", method: "POST", pathTemplate: "/api/admin/books/upload" },
  { site: "admin", method: "DELETE", pathTemplate: "/api/admin/books/[id]" },
]);

const VERIFY_RESULTS = new Set(["valid", "invalid", "none"]);

/** Parse JSON lines, returning valid records and a count of skipped lines. */
export function parseJsonLines(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    records.push(parsed);
  }
  return { records, skipped };
}

function isVerify(record) {
  return record && record.evt === "relay.verify" && VERIFY_RESULTS.has(record.result);
}

function isProbe(record) {
  return record && record.evt === "relay.probe";
}

function bucketKey(pathClass, method) {
  return `${typeof pathClass === "string" ? pathClass : "other"}\u0000${typeof method === "string" ? method : "OTHER"}`;
}

/**
 * Aggregate relay.verify records into the runbook counters. Only counters are
 * produced; no record content is retained.
 */
export function aggregate(records) {
  const valid = {
    natural: { student: 0, admin: 0, unknown: 0 },
    synthetic: { student: 0, admin: 0, unknown: 0 },
  };
  const pathClassMethod = new Map();
  let verifyCount = 0;
  let probeCount = 0;
  let invalid = 0;
  let noneWithIdentity = 0;
  let skippedRecords = 0;

  for (const record of records) {
    if (isProbe(record)) {
      probeCount += 1;
      continue;
    }
    if (!isVerify(record)) {
      skippedRecords += 1;
      continue;
    }
    verifyCount += 1;
    const site = record.site === "student" || record.site === "admin" ? record.site : "unknown";
    const method = typeof record.method === "string" ? record.method : "OTHER";
    const pathClass = typeof record.pathClass === "string" ? record.pathClass : "other";

    const key = bucketKey(pathClass, method);
    pathClassMethod.set(key, (pathClassMethod.get(key) ?? 0) + 1);

    if (record.result === "invalid") invalid += 1;
    if (record.result === "none" && record.identityPresent === true) noneWithIdentity += 1;

    if (record.result === "valid") {
      const split = record.synthetic === true ? "synthetic" : "natural";
      valid[split][site] += 1;
    }
  }

  return {
    verifyCount,
    probeCount,
    skippedRecords,
    valid,
    pathClassMethod,
    zeroTolerance: { invalid, noneWithIdentity },
  };
}

/** Convert the pathClass x method map into a stable, sorted array. */
export function pathClassMethodRows(map) {
  return [...map.entries()]
    .map(([key, count]) => {
      const [pathClass, method] = key.split("\u0000");
      return { pathClass, method, count };
    })
    .sort((a, b) => (a.pathClass === b.pathClass ? a.method.localeCompare(b.method) : a.pathClass.localeCompare(b.pathClass)));
}

/** Evaluate the natural-sample gates (synthetic samples never count here). */
export function evaluateSampleGates(valid, thresholds = PROPOSAL_THRESHOLDS) {
  const checks = [
    { id: "student-valid-min", site: "student", count: valid.natural.student, min: thresholds.studentValidMin, pass: valid.natural.student >= thresholds.studentValidMin },
    { id: "admin-valid-min", site: "admin", count: valid.natural.admin, min: thresholds.adminValidMin, pass: valid.natural.admin >= thresholds.adminValidMin },
  ];
  return { checks, allPass: checks.every((check) => check.pass), proposalNotice: thresholds.proposalNotice };
}

/**
 * Evaluate per-route non-GET coverage from a route-counts input. A route with
 * no supplied count is reported HOLD (the logs cannot prove it); it is never
 * inferred from pathClass totals.
 */
export function evaluateNonGetCoverage(routeCounts, routes = APPLICABLE_NON_GET_ROUTES, thresholds = PROPOSAL_THRESHOLDS) {
  const supplied = new Map();
  for (const entry of routeCounts ?? []) {
    if (!entry || typeof entry !== "object") continue;
    supplied.set(`${entry.site}\u0000${entry.method}\u0000${entry.pathTemplate}`, {
      natural: Number.isFinite(entry.natural) ? entry.natural : 0,
      synthetic: Number.isFinite(entry.synthetic) ? entry.synthetic : 0,
    });
  }
  const rows = routes.map((route) => {
    const found = supplied.get(`${route.site}\u0000${route.method}\u0000${route.pathTemplate}`);
    if (!found) {
      return { ...route, natural: null, synthetic: null, total: null, min: thresholds.nonGetPerPathMin, status: "HOLD", reason: "pathClass 無法區分路由模板，需提供 route-counts 輸入" };
    }
    const total = found.natural + found.synthetic;
    return { ...route, natural: found.natural, synthetic: found.synthetic, total, min: thresholds.nonGetPerPathMin, status: total >= thresholds.nonGetPerPathMin ? "PASS" : "FAIL", reason: null };
  });
  return { rows, allPass: rows.every((row) => row.status === "PASS"), hasHold: rows.some((row) => row.status === "HOLD"), proposalNotice: thresholds.proposalNotice };
}

/**
 * Evaluate the ingress coverage equation from configurable inputs.
 *
 * Equation (proposal): ingressTotal === verify + probeStripped + health + books
 * + sync + cors + static. The difference must be 0. Every component is supplied
 * by the caller; missing inputs yield `status: "HOLD"`.
 */
export function evaluateCoverageEquation(input) {
  const required = ["ingressTotal", "verify", "probeStripped", "health", "books", "sync", "cors", "static"];
  const missing = required.filter((key) => !Number.isFinite(input?.[key]));
  if (missing.length > 0) {
    return { proposal: true, proposalNotice: PROPOSAL_THRESHOLDS.proposalNotice, status: "HOLD", missing, diff: null, components: null };
  }
  const components = Object.fromEntries(required.filter((key) => key !== "ingressTotal").map((key) => [key, input[key]]));
  const sum = Object.values(components).reduce((acc, value) => acc + value, 0);
  const diff = input.ingressTotal - sum;
  return { proposal: true, proposalNotice: PROPOSAL_THRESHOLDS.proposalNotice, status: diff === 0 ? "PASS" : "FAIL", diff, components };
}

/** Build the final redacted report object. */
export function buildReport({ runId, generatedAt, aggregate: agg, sampleGates, nonGetCoverage, coverageEquation, thresholds = PROPOSAL_THRESHOLDS }) {
  return {
    kind: "a01-coverage-report",
    runId,
    generatedAt,
    proposalNotice: thresholds.proposalNotice,
    totals: { verifyCount: agg.verifyCount, probeCount: agg.probeCount, skippedRecords: agg.skippedRecords },
    valid: agg.valid,
    pathClassMethod: pathClassMethodRows(agg.pathClassMethod),
    zeroTolerance: { ...agg.zeroTolerance, pass: agg.zeroTolerance.invalid === 0 && agg.zeroTolerance.noneWithIdentity === 0 },
    sampleGates,
    nonGetCoverage,
    coverageEquation,
    notes: [
      "natural/synthetic valid counts are split; synthetic samples never count toward the 300/100 gates",
      "per-route non-GET coverage requires a route-counts input; logs cannot distinguish sub-routes",
      `coverage equation is ${thresholds.proposalNotice}`,
      "no raw log text, PII, or secret is included",
    ],
  };
}
