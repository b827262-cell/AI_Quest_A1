#!/usr/bin/env node
/**
 * A-01 synthetic traffic injector.
 *
 * Sends signed relay requests to a STAGING target to top up per-path coverage
 * (each applicable path x verb to >= target valid verifications). It is a
 * draft tool: it refuses to run against production, defaults to dry-run, and
 * never prints or stores secrets.
 *
 * Usage:
 *   node scripts/a01-synthetic/inject.mjs --site student --dry-run
 *   A01_SYNTHETIC_CONFIRM=yes A01_SYNTHETIC_BASE_URL=https://staging... \
 *     A01_SYNTHETIC_SIGNING_KEY=... A01_SYNTHETIC_USER_EMAIL=... \
 *     node scripts/a01-synthetic/inject.mjs --site student --confirm
 *
 * Safety: see README.md. No deploy, no production, no secret output.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPlan, planTotal } from "./plan.mjs";
import { buildRelayHeaders } from "./relay-sign.mjs";
import {
  assertStagingTarget,
  denyListFromEnv,
  isConfigured,
  SafetyError,
} from "./safety.mjs";
import {
  createManifest,
  finalizeManifest,
  recordCreatedId,
  recordResult,
  summarize,
  writeEvidence,
} from "./manifest.mjs";

export const DEFAULT_EVIDENCE_DIR = "docs/evidence";
export const DEFAULT_ERROR_RATE_STOP = 0.2;
export const DEFAULT_MAX_5XX = 5;

function parseArgs(argv) {
  const args = { dryRun: true, confirm: false, site: null, target: null, rate: null, id: null, evidenceDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--dry-run": args.dryRun = true; break;
      case "--confirm": args.confirm = true; args.dryRun = false; break;
      case "--site": args.site = next(); break;
      case "--target": args.target = Number(next()); break;
      case "--rate": args.rate = Number(next()); break;
      case "--id": args.id = next(); break;
      case "--evidence-dir": args.evidenceDir = next(); break;
      case "--help": case "-h": args.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether to stop early. Returns a reason string or null.
 * Exposed for unit testing.
 */
export function checkStopConditions(manifest, config) {
  const { errorRateStop = DEFAULT_ERROR_RATE_STOP, max5xx = DEFAULT_MAX_5XX } = config;
  const { attempted, error } = manifest.totals;
  if (attempted >= 10) {
    const rate = error / attempted;
    if (rate > errorRateStop) return `error_rate_exceeded:${rate.toFixed(3)}`;
  }
  let fiveXx = 0;
  for (const row of Object.values(manifest.rows)) {
    for (const [status, count] of Object.entries(row.statuses)) {
      if (Number(status) >= 500) fiveXx += count;
    }
  }
  if (fiveXx > max5xx) return `5xx_exceeded:${fiveXx}`;
  return null;
}

function isSuccessStatus(status) {
  return status >= 200 && status < 300;
}

/**
 * Run an injection plan against a target. Designed to be testable: all I/O is
 * injectable.
 *
 * @returns {Promise<{manifest:object, summary:object, stopReason:string}>}
 */
export async function runInjection({
  plan,
  manifest,
  config,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = () => Date.now(),
  shouldStop = () => false,
  onEvent = () => {},
}) {
  const minIntervalMs = config.rateLimitPerSec > 0 ? 1000 / config.rateLimitPerSec : 0;
  let lastStart = 0;
  let stopReason = "completed";

  outer: for (const row of plan) {
    let successes = 0;
    let attempts = 0;
    // Bound the attempts so an unreachable target cannot loop forever.
    const maxAttempts = row.target * 3;
    while (successes < row.target && attempts < maxAttempts) {
      if (shouldStop()) { stopReason = "manual_stop_file"; break outer; }
      const stop = checkStopConditions(manifest, config);
      if (stop) { stopReason = stop; break outer; }

      if (minIntervalMs > 0) {
        const wait = lastStart + minIntervalMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastStart = now();

      const search = row.query ?? "";
      const url = `${config.baseOrigin}${row.route}${search}`;
      const body = row.method === "GET" || row.method === "HEAD" || row.body === undefined
        ? undefined
        : JSON.stringify(row.body);

      let status = 0;
      try {
        const { headers } = await buildRelayHeaders({
          method: row.method,
          pathname: row.route,
          search,
          body,
          site: config.site,
          userId: config.userId,
          email: config.email,
          role: "-",
          key: config.key,
          edgeSecret: config.edgeSecret,
          nowMs: now(),
        });
        const response = await fetchImpl(url, {
          method: row.method,
          headers: body === undefined
            ? headers
            : { ...headers, "content-type": "application/json" },
          body,
        });
        status = response.status;
        const success = isSuccessStatus(status);
        if (success) {
          successes += 1;
          if (row.method === "POST" && row.routeTemplate === "/api/admin/books") {
            // Capture a created id for cleanup, stored only in hashed form.
            try {
              const data = await response.clone().json();
              const rawId = data?.id ?? data?.book?.id;
              if (rawId !== undefined) await recordCreatedId(manifest, rawId);
            } catch { /* non-JSON or absent id: nothing to record */ }
          }
        }
        recordResult(manifest, { routeTemplate: row.routeTemplate, method: row.method, status, success });
        onEvent({ row: row.routeTemplate, method: row.method, status, success });
      } catch (error) {
        recordResult(manifest, { routeTemplate: row.routeTemplate, method: row.method, status: 0, success: false });
        onEvent({ row: row.routeTemplate, method: row.method, status: 0, success: false, error: error?.name });
      }
      attempts += 1;
    }
  }

  finalizeManifest(manifest, { stopReason });
  return { manifest, summary: summarize(manifest), stopReason };
}

function buildConfig(env, args) {
  const site = args.site ?? env.A01_SYNTHETIC_SITE;
  if (site !== "student" && site !== "admin") {
    throw new SafetyError("--site (or A01_SYNTHETIC_SITE) must be student or admin");
  }
  return {
    site,
    baseUrl: env.A01_SYNTHETIC_BASE_URL,
    key: env.A01_SYNTHETIC_SIGNING_KEY,
    edgeSecret: env.A01_SYNTHETIC_EDGE_SECRET,
    userId: env.A01_SYNTHETIC_USER_ID,
    email: env.A01_SYNTHETIC_USER_EMAIL,
    rateLimitPerSec: args.rate ?? Number(env.A01_SYNTHETIC_RATE_LIMIT ?? 2),
    errorRateStop: Number(env.A01_SYNTHETIC_ERROR_RATE_STOP ?? DEFAULT_ERROR_RATE_STOP),
    max5xx: Number(env.A01_SYNTHETIC_MAX_5XX ?? DEFAULT_MAX_5XX),
    stopFile: env.A01_SYNTHETIC_STOP_FILE ?? "tmp/a01-synthetic.stop",
    evidenceDir: args.evidenceDir ?? env.A01_SYNTHETIC_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_DIR,
    executor: env.A01_SYNTHETIC_EXECUTOR ?? "unknown",
    authorizationRef: env.A01_SYNTHETIC_AUTHORIZATION_REF ?? "unspecified",
    runId: env.A01_SYNTHETIC_RUN_ID ?? `syn-${site}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    targetPerPath: args.target ?? Number(env.A01_SYNTHETIC_TARGET_PER_PATH ?? 30),
  };
}

/** Report readiness as booleans only — never values. */
export function describeReadiness(config) {
  return {
    base_url_configured: isConfigured(config.baseUrl),
    signing_key_configured: isConfigured(config.key),
    identity_configured: isConfigured(config.userId) || isConfigured(config.email),
    edge_secret_configured: isConfigured(config.edgeSecret),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "A-01 synthetic injector (draft).\n" +
      "  --site student|admin   target site\n" +
      "  --dry-run              plan only (default)\n" +
      "  --confirm              actually send (requires staging target + confirm env)\n" +
      "  --target N             valid count per path x method (default 30)\n" +
      "  --rate N               max requests/sec (default 2)\n" +
      "  --id ID                concrete id for [id] templates\n" +
      "  --evidence-dir DIR     where sanitized evidence is written (default docs/evidence)",
    );
    return 0;
  }

  const config = buildConfig(env, args);
  const readiness = describeReadiness(config);

  // The target is validated in every mode so a production URL is rejected even
  // during a dry-run.
  const target = assertStagingTarget(config.baseUrl, denyListFromEnv(env));

  const plan = buildPlan(config.site, { targetPerPath: config.targetPerPath, id: args.id });
  const manifest = createManifest({
    runId: config.runId,
    site: config.site,
    targetHost: target.host,
    executor: config.executor,
    authorizationRef: config.authorizationRef,
    targetPerPath: config.targetPerPath,
    rateLimit: config.rateLimitPerSec,
    dryRun: args.dryRun,
  });

  const dryRun = args.dryRun || !args.confirm || String(env.A01_SYNTHETIC_CONFIRM ?? "").toLowerCase() !== "yes";

  console.log(JSON.stringify({
    mode: dryRun ? "dry-run" : "live",
    site: config.site,
    target_host: target.host,
    target_per_path: config.targetPerPath,
    planned_requests: planTotal(plan),
    non_get_rows: plan.filter((r) => r.method !== "GET" && r.method !== "HEAD").length,
    readiness,
    stop_file: config.stopFile,
  }, null, 2));

  if (dryRun) {
    for (const row of plan) {
      console.log(`  [plan] ${row.method} ${row.routeTemplate} x${row.target}`);
    }
    console.log("dry-run: no requests sent, no evidence written.");
    return 0;
  }

  if (!readiness.signing_key_configured) {
    throw new SafetyError("A01_SYNTHETIC_SIGNING_KEY is required for a live run");
  }
  if (!readiness.identity_configured) {
    throw new SafetyError("A01_SYNTHETIC_USER_ID or A01_SYNTHETIC_USER_EMAIL is required for a live run");
  }

  const result = await runInjection({
    plan,
    manifest,
    config: { ...config, baseOrigin: target.origin },
    shouldStop: () => existsSync(config.stopFile),
    onEvent: (event) => {
      if (event.success === false) console.log(`  [fail] ${event.method} ${event.row} status=${event.status}`);
    },
  });

  const { manifestPath, summaryPath } = await writeEvidence(config.evidenceDir, result.manifest, result.summary);
  console.log(JSON.stringify({
    stop_reason: result.stopReason,
    totals: result.summary.totals,
    all_targets_met: result.summary.all_targets_met,
    evidence: { manifest: manifestPath, summary: summaryPath },
  }, null, 2));
  return result.stopReason === "completed" ? 0 : 2;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`injector error: ${error?.name}: ${error?.message}`);
    process.exitCode = 1;
  });
}
