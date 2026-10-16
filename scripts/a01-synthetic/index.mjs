#!/usr/bin/env node
/**
 * A-01 synthetic traffic driver (staging only).
 *
 * Injects relay-verified synthetic requests across the route × verb matrix so
 * the 72h acceptance window can reach its per-path `>=30` floor. Synthetic
 * samples are tagged server-side (`synthetic: true` in `relay.verify`) via the
 * non-secret `A01_SYNTHETIC_ACCOUNTS` allowlist; they never count toward the
 * Student `>=300` / Admin `>=100` natural-sample gates.
 *
 * Safety rails (see README.md):
 *   1. Staging only. The target base URL and an explicit staging host
 *      allow-list come from the environment; production hosts and unset config
 *      are refused.
 *   2. Credentials/secrets come from runtime environment variables only. The
 *      script never prints an environment value and never writes one to output.
 *   3. Covers every applicable non-GET path × verb plus GET; per-target count
 *      (default 30) and request rate are configurable.
 *   4. Stops on an error-rate/5xx threshold breach or a manual stop file, and
 *      records a cleanup plan (delete test data, disable test accounts, remove
 *      the allowlist after the window).
 *   5. Emits only a redacted summary + manifest (masked IPs, hashed ids, no raw
 *      request content) under `docs/evidence/`.
 *   6. Dry-run by default (no network); requires explicit --execute and
 *      necessary environment variables to inject live traffic.
 *
 * This tool never deploys, never targets production, never reads real secrets
 * at authoring time, never touches migration 0003, and never force-pushes.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ConfigError,
  DEFAULT_PER_TARGET,
  assertNoSecrets,
  buildManifest,
  buildSummary,
  collectSecretValues,
  evaluateStop,
  expandTargets,
  hashId,
  maskIp,
  minGapMs,
  ratio,
  redactText,
  resolveTargetConfig,
} from "./core.mjs";
import { SYNTHETIC_TARGETS, resolvePath, templatesRequiringId } from "./targets.mjs";
import { buildRelayHeaders } from "./signer.mjs";

const HELP = `A-01 synthetic traffic driver (staging only)

Usage: node scripts/a01-synthetic/index.mjs [options]

Options:
  --execute            Actually inject traffic (must be explicitly provided; default is dry-run).
  --dry-run            Dry-run mode (default); validate config and print the plan.
  --per-target <n>     Requests per target (default ${DEFAULT_PER_TARGET}).
  --rate <n>           Max requests per second (default 5).
  --out <dir>          Evidence output directory (default docs/evidence).
  --stop-file <path>   Manual stop file; if it exists the run halts.
  --cleanup            Run the recorded cleanup steps instead of injecting.
  --help               Show this message.

Required environment:
  A01_SYNTHETIC_BASE_URL        Staging origin (https).
  A01_SYNTHETIC_ALLOWED_HOSTS   Comma-separated staging host allow-list.

Optional environment (values are never printed):
  A01_SYNTHETIC_PRODUCTION_SUFFIXES   Default: .chatgpt.site
  A01_SYNTHETIC_STUDENT_USER_ID / _EMAIL / _ROLE
  A01_SYNTHETIC_ADMIN_USER_ID / _EMAIL / _ROLE
  A01_SYNTHETIC_STUDENT_RELAY_KEY / A01_SYNTHETIC_ADMIN_RELAY_KEY
  A01_SYNTHETIC_BOOK_ID               Test id substituted into [id] routes.
  A01_SYNTHETIC_ERROR_RATE_LIMIT      0..1 ratio; 0 disables.
  A01_SYNTHETIC_5XX_RATE_LIMIT        0..1 ratio; 0 disables.
  A01_SYNTHETIC_CLEANUP_ACCOUNT_PATH  POST path that disables test accounts.
  A01_SYNTHETIC_RUN_ID                Overrides the generated run id.
`;

function parseArgs(argv) {
  const options = { dryRun: true, execute: false, perTarget: DEFAULT_PER_TARGET, rate: 5, out: "docs/evidence", stopFile: null, cleanup: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      options.execute = true;
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
      options.execute = false;
    } else if (arg === "--cleanup") options.cleanup = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--per-target") options.perTarget = Number(argv[++index]);
    else if (arg === "--rate") options.rate = Number(argv[++index]);
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--stop-file") options.stopFile = argv[++index];
    else throw new ConfigError(`unknown argument: ${arg}`);
  }
  return options;
}

function identityFor(env, site) {
  const prefix = site === "student" ? "A01_SYNTHETIC_STUDENT" : "A01_SYNTHETIC_ADMIN";
  return {
    site,
    userId: env[`${prefix}_USER_ID`] ?? "",
    email: env[`${prefix}_EMAIL`] ?? "",
    role: site,
    relayKey: env[`${prefix}_RELAY_KEY`] ?? "",
  };
}

function nonceFor(runId, index) {
  const raw = `${runId}${index}`.replace(/[^A-Za-z0-9_-]/g, "");
  return raw.length >= 16 ? raw.slice(0, 128) : raw.padEnd(16, "0");
}

/** Build the request for one target invocation; returns null when unusable. */
function buildRequest({ target, index, runId, env, targetConfig }) {
  const identity = identityFor(env, target.site);
  const path = resolvePath(target, { bookId: env.A01_SYNTHETIC_BOOK_ID });
  const url = new URL(path, targetConfig.origin);
  const method = target.method;
  const body = method === "GET" || method === "HEAD" ? undefined : JSON.stringify({ synthetic: true, run: runId, seq: index });
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (identity.relayKey) {
    const signed = buildRelayHeaders(
      { method, pathname: url.pathname, search: url.search.replace(/^\?/, ""), body, site: identity.site, userId: identity.userId, email: identity.email, role: identity.role, ts: String(Math.floor(Date.now() / 1000)), nonce: nonceFor(runId, index) },
      identity.relayKey,
    );
    if (signed === null) return null;
    Object.assign(headers, signed);
  } else {
    // Unsigned fallback: still sends the platform identity headers so a
    // staging site running in transitional/accept mode can exercise the path.
    if (identity.userId) headers["oai-authenticated-user-id"] = identity.userId;
    if (identity.email) headers["oai-authenticated-user-email"] = identity.email;
  }
  return { url: url.toString(), method, headers, body };
}

function cleanupPlan(env, createdBookIds) {
  return {
    steps: [
      { step: "delete-test-books", kind: "request", method: "DELETE", pathTemplate: "/api/admin/books", manual: false, hashedIds: createdBookIds.map((id) => hashId(id, "cleanup")) },
      { step: "disable-test-accounts", kind: "request", method: "POST", pathTemplate: env.A01_SYNTHETIC_CLEANUP_ACCOUNT_PATH ?? null, manual: !env.A01_SYNTHETIC_CLEANUP_ACCOUNT_PATH },
      { step: "remove-allowlist-entry", kind: "ops", detail: "After the 72h window closes, remove the test identities from A01_SYNTHETIC_ACCOUNTS.", manual: true },
    ],
    note: "Run with --cleanup to execute the request steps; ops steps are recorded for the window owner.",
  };
}

async function inject({ targets, env, targetConfig, options, runId, stopFile }) {
  const secrets = collectSecretValues(env);
  const gap = minGapMs(options.rate);
  const byTarget = [];
  const createdBookIds = [];
  let attempted = 0;
  let failures = 0;
  let serverErrors = 0;
  let stop = { stop: false, reasons: [] };

  for (const target of targets) {
    let targetAttempted = 0;
    let targetFailures = 0;
    for (let index = 0; index < target.count; index += 1) {
      stop = evaluateStop({
        attempted,
        failures,
        serverErrors,
        errorRateLimit: Number(env.A01_SYNTHETIC_ERROR_RATE_LIMIT) || 0,
        serverErrorLimit: Number(env.A01_SYNTHETIC_5XX_RATE_LIMIT) || 0,
        stopFileExists: Boolean(stopFile) && existsSync(stopFile),
      });
      if (stop.stop) break;

      const request = buildRequest({ target, index, runId, env, targetConfig });
      attempted += 1;
      targetAttempted += 1;
      if (request === null) {
        failures += 1;
        targetFailures += 1;
        continue;
      }
      try {
        const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
        if (response.status >= 500) {
          serverErrors += 1;
          failures += 1;
          targetFailures += 1;
        } else if (response.status >= 400) {
          failures += 1;
          targetFailures += 1;
        } else if (target.method === "POST" && target.pathTemplate === "/api/admin/books") {
          const created = await response.clone().json().catch(() => null);
          const id = created && (created.id ?? created.bookId);
          if (id !== undefined && id !== null) createdBookIds.push(String(id));
        }
      } catch (error) {
        failures += 1;
        targetFailures += 1;
        void redactText(error?.message ?? "", secrets); // never surfaced with secrets
      }
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
    byTarget.push({ site: target.site, method: target.method, pathTemplate: target.pathTemplate, pathClass: target.pathClass, verbClass: target.verbClass, attempted: targetAttempted, failures: targetFailures });
    if (stop.stop) break;
  }

  return { byTarget, createdBookIds, totals: { attempted, failures, serverErrors, errorRate: ratio(failures, attempted), serverErrorRate: ratio(serverErrors, attempted) }, stop };
}

async function runCleanup({ env, manifestPath }) {
  const secrets = collectSecretValues(env);
  const path = env.A01_SYNTHETIC_CLEANUP_ACCOUNT_PATH;
  if (!path) {
    console.log("[cleanup] no request-level cleanup configured; follow the ops steps in the manifest.");
    return { executed: [], note: `see ${manifestPath}` };
  }
  const targetConfig = resolveTargetConfig(env);
  const url = new URL(path, targetConfig.origin);
  const token = env.A01_SYNTHETIC_ADMIN_TOKEN;
  const headers = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const executed = [];
  try {
    const response = await fetch(url.toString(), { method: "POST", headers });
    executed.push({ step: "disable-test-accounts", status: response.status });
  } catch (error) {
    executed.push({ step: "disable-test-accounts", status: "error", reason: redactText(error?.message ?? "", secrets) });
  }
  return { executed };
}

async function main() {
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

  const env = process.env;
  let targetConfig;
  try {
    targetConfig = resolveTargetConfig(env);
  } catch (error) {
    console.error(`[refused] ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const runId = (env.A01_SYNTHETIC_RUN_ID ?? `synthetic-${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "");
  const targets = expandTargets(SYNTHETIC_TARGETS, options.perTarget);
  const outDir = resolve(options.out);
  const startedAt = new Date().toISOString();

  if (options.cleanup) {
    const result = await runCleanup({ env, manifestPath: join(outDir, `${runId}.manifest.json`) });
    console.log(`[cleanup] ${JSON.stringify(result)}`);
    return;
  }

  const missingIds = templatesRequiringId().length > 0 && !env.A01_SYNTHETIC_BOOK_ID;
  if (!options.dryRun && missingIds) {
    console.error("[refused] A01_SYNTHETIC_BOOK_ID is required for [id] routes; run without --execute to preview in dry-run mode");
    process.exitCode = 2;
    return;
  }

  if (options.dryRun) {
    console.log(`[dry-run] target=${targetConfig.host} targets=${targets.length} perTarget=${options.perTarget} rate=${options.rate}/s`);
    for (const target of targets) console.log(`[dry-run]   ${target.method.padEnd(6)} ${target.pathTemplate} (${target.site}) x${target.count}`);
    if (missingIds) console.log("[dry-run] A01_SYNTHETIC_BOOK_ID unset; [id] routes would be skipped in a live run");
  }

  const result = options.dryRun
    ? { byTarget: targets.map((t) => ({ ...t, attempted: 0, failures: 0 })), createdBookIds: [], totals: { attempted: 0, failures: 0, serverErrors: 0, errorRate: 0, serverErrorRate: 0 }, stop: { stop: false, reasons: [] } }
    : await inject({ targets, env, targetConfig, options, runId, stopFile: options.stopFile });

  const finishedAt = new Date().toISOString();
  const cleanup = cleanupPlan(env, result.createdBookIds);
  const summary = buildSummary({ runId, target: targetConfig, startedAt, finishedAt, dryRun: options.dryRun, totals: result.totals, byTarget: result.byTarget, stop: result.stop, cleanup: { planned: cleanup.steps.length, executed: false }, clientIpHashes: [] });
  const manifest = buildManifest({ runId, target: targetConfig, startedAt, finishedAt, dryRun: options.dryRun, targets: targets.map((t) => ({ site: t.site, method: t.method, pathTemplate: t.pathTemplate, pathClass: t.pathClass, verbClass: t.verbClass, count: t.count })), credentials: ["student-relay", "admin-relay"].filter((role) => (role === "student-relay" ? env.A01_SYNTHETIC_STUDENT_RELAY_KEY : env.A01_SYNTHETIC_ADMIN_RELAY_KEY)), cleanup });

  const secrets = collectSecretValues(env);
  const summaryJson = JSON.stringify(summary, null, 2);
  const manifestJson = JSON.stringify(manifest, null, 2);
  assertNoSecrets(summaryJson, secrets);
  assertNoSecrets(manifestJson, secrets);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${runId}.summary.json`), `${summaryJson}\n`);
  writeFileSync(join(outDir, `${runId}.manifest.json`), `${manifestJson}\n`);
  console.log(`[done] runId=${runId} attempted=${result.totals.attempted} failures=${result.totals.failures} stop=${result.stop.stop} evidence=${outDir}`);
  if (result.stop.stop) console.log(`[stopped] ${result.stop.reasons.join("; ")}`);
}

// Export the pure pieces for tests without executing the CLI on import.
export { buildRequest, cleanupPlan, identityFor, nonceFor, parseArgs };

const isEntry = process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`;
if (isEntry) {
  main().catch((error) => {
    console.error(`[fatal] ${redactText(error?.message ?? error, collectSecretValues(process.env))}`);
    process.exitCode = 1;
  });
}
