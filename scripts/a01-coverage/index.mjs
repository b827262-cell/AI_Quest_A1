#!/usr/bin/env node
/**
 * A-01 72h coverage report.
 *
 * Reads a redacted JSON-lines log summary (fields mirroring `relay.verify`:
 * evt, result, site, mode, identityPresent, method, pathClass, synthetic — plus
 * `relay.probe` lines) and emits the acceptance counters:
 *   - natural vs synthetic `valid` counts per site;
 *   - per pathClass x method counts;
 *   - Student >=300 / Admin >=100 (natural only);
 *   - per applicable non-GET path x verb >=30 (synthetic only fills the floor);
 *   - zero-tolerance items (result=invalid; result=none with identityPresent).
 *
 * The ingress coverage equation is a PROPOSAL evaluated from a configurable
 * input; the output is stamped "提案，未經 Owner 確認".
 *
 * Emits only counters and fixed labels — never raw log text, PII, or a secret.
 * Does not deploy, does not read secrets, does not touch migration 0003, does
 * not force-push.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  PROPOSAL_THRESHOLDS,
  aggregate,
  buildReport,
  evaluateCoverageEquation,
  evaluateNonGetCoverage,
  evaluateSampleGates,
  parseJsonLines,
} from "./core.mjs";

const HELP = `A-01 72h coverage report

Usage: node scripts/a01-coverage/index.mjs --logs <file> [options]

Options:
  --logs <file>          Redacted JSON-lines log summary (required).
  --route-counts <file>  JSON per-route counts: { "routes": [ { site, method,
                         pathTemplate, natural, synthetic } ] }.
  --ingress <file>       JSON ingress coverage-equation inputs: { ingressTotal,
                         verify, probeStripped, health, books, sync, cors, static }.
  --out <dir>            Output directory (default docs/evidence).
  --run-id <id>          Overrides the generated run id.
  --student-min <n>      Default ${PROPOSAL_THRESHOLDS.studentValidMin}.
  --admin-min <n>        Default ${PROPOSAL_THRESHOLDS.adminValidMin}.
  --per-path-min <n>     Default ${PROPOSAL_THRESHOLDS.nonGetPerPathMin}.
  --help                 Show this message.
`;

function parseArgs(argv) {
  const options = { out: "docs/evidence" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--logs") options.logs = argv[++index];
    else if (arg === "--route-counts") options.routeCounts = argv[++index];
    else if (arg === "--ingress") options.ingress = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--run-id") options.runId = argv[++index];
    else if (arg === "--student-min") options.studentMin = Number(argv[++index]);
    else if (arg === "--admin-min") options.adminMin = Number(argv[++index]);
    else if (arg === "--per-path-min") options.perPathMin = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${label} (${path}): ${error?.message ?? error}`);
  }
}

function loadRouteCounts(path) {
  if (!path) return [];
  const parsed = readJson(path, "route-counts");
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.routes)) return parsed.routes;
  throw new Error("route-counts must be an array or { routes: [...] }");
}

function formatReport(report) {
  const lines = [];
  lines.push(`kind=${report.kind} runId=${report.runId} (${report.proposalNotice})`);
  lines.push(`totals: verify=${report.totals.verifyCount} probe=${report.totals.probeCount} skipped=${report.totals.skippedRecords}`);
  lines.push(`valid natural: student=${report.valid.natural.student} admin=${report.valid.natural.admin} unknown=${report.valid.natural.unknown}`);
  lines.push(`valid synthetic: student=${report.valid.synthetic.student} admin=${report.valid.synthetic.admin} unknown=${report.valid.synthetic.unknown}`);
  for (const check of report.sampleGates.checks) lines.push(`gate ${check.id}: ${check.pass ? "PASS" : "FAIL"} (${check.count}/${check.min})`);
  lines.push(`zero-tolerance: ${report.zeroTolerance.pass ? "PASS" : "FAIL"} invalid=${report.zeroTolerance.invalid} noneWithIdentity=${report.zeroTolerance.noneWithIdentity}`);
  for (const row of report.nonGetCoverage.rows) lines.push(`non-GET ${row.method} ${row.pathTemplate} (${row.site}): ${row.status}${row.total === null ? "" : ` (${row.total}/${row.min})`}${row.reason ? ` — ${row.reason}` : ""}`);
  lines.push(`coverage equation: ${report.coverageEquation.status}${report.coverageEquation.diff === null ? "" : ` diff=${report.coverageEquation.diff}`} (${report.coverageEquation.proposalNotice})`);
  return lines.join("\n");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[error] ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!options.logs) {
    console.error("[error] --logs <file> is required");
    process.exitCode = 2;
    return;
  }

  const thresholds = {
    ...PROPOSAL_THRESHOLDS,
    ...(Number.isFinite(options.studentMin) ? { studentValidMin: options.studentMin } : {}),
    ...(Number.isFinite(options.adminMin) ? { adminValidMin: options.adminMin } : {}),
    ...(Number.isFinite(options.perPathMin) ? { nonGetPerPathMin: options.perPathMin } : {}),
  };

  let rawLogs;
  try {
    rawLogs = readFileSync(options.logs, "utf8");
  } catch (error) {
    console.error(`[error] failed to read logs: ${error?.message ?? error}`);
    process.exitCode = 2;
    return;
  }

  const { records, skipped } = parseJsonLines(rawLogs);
  const agg = aggregate(records);
  agg.skippedRecords += skipped;

  const routeCounts = loadRouteCounts(options.routeCounts);
  const ingress = options.ingress ? readJson(options.ingress, "ingress") : null;

  const sampleGates = evaluateSampleGates(agg.valid, thresholds);
  const nonGetCoverage = evaluateNonGetCoverage(routeCounts, undefined, thresholds);
  const coverageEquation = evaluateCoverageEquation(ingress);

  const runId = (options.runId ?? `coverage-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "");
  const report = buildReport({ runId, generatedAt: new Date().toISOString(), aggregate: agg, sampleGates, nonGetCoverage, coverageEquation, thresholds });

  const outDir = resolve(options.out);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${runId}.coverage.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(formatReport(report));
  console.log(`evidence=${outPath}`);
}

const isEntry = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isEntry) {
  try {
    main();
  } catch (error) {
    console.error(`[fatal] ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

export { formatReport, loadRouteCounts, parseArgs };
