#!/usr/bin/env node

/**
 * Fail-closed comparison of the committed shared-backend Sites declaration and
 * a fresh, read-only control-plane manifest.  The manifest contains resource
 * identities only: secrets, tokens, and D1/R2 contents are deliberately out
 * of scope.
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(siteDir, "..");
// The default is deliberately staging-only. The production record remains a
// provenance artifact and must be named explicitly for a negative comparison.
const defaultManifest = path.join(repoDir, "docs/phase4a/environment-source-of-truth.staging.json");
const defaultHosting = path.join(siteDir, ".openai/hosting.json");
export const DEFAULT_MAX_AGE_HOURS = 72;
// Owner D-09 F7 decision, recorded in docs/phase4a/F7_FRESHNESS_POLICY_D09.md.
// This is an explicit, one-off credit for this decision only.  It is not a
// calendar/weekend calculation and is deliberately not applied per holiday.
export const ONE_TIME_HOLIDAY_DEDUCTION_HOURS = 24;

function usage() {
  console.error("Usage: node site/scripts/verify-environment-alignment.mjs [--manifest <path>] [--hosting <path>] [--max-age-hours <hours>] [--test-run-at <iso-timestamp>] [--json]");
}

function parseArgs(args) {
  const options = { manifest: defaultManifest, hosting: defaultHosting, maxAgeHours: DEFAULT_MAX_AGE_HOURS, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--manifest" || arg === "--hosting") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = path.resolve(process.cwd(), value);
      index += 1;
    } else if (arg === "--max-age-hours") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --max-age-hours");
      options.maxAgeHours = Number(value);
      if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours < 0) throw new Error("--max-age-hours must be a non-negative number");
      index += 1;
    } else if (arg === "--test-run-at") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("Missing value for --test-run-at");
      options.testRunAt = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readJson(file, label, errors) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${label} cannot be read as JSON (${error.code ?? error.message})`);
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function fullGitSha(value) {
  // Git's SHA-1 object IDs are 40 hex characters; allow longer IDs so this
  // gate remains compatible with SHA-256 repositories.
  return typeof value === "string" && /^[0-9a-f]{40,}$/i.test(value);
}

function gitCheck(args) {
  const result = spawnSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    stdio: "ignore",
  });
  return result.status === 0;
}

function captureAgeMs(capturedAt, runAtMs) {
  // A timezone is mandatory: a timestamp without one is ambiguous and cannot
  // be accepted as control-plane evidence.
  if (typeof capturedAt !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(capturedAt)) return null;
  const parsed = Date.parse(capturedAt);
  if (Number.isNaN(parsed)) return null;
  return runAtMs - parsed;
}

function taipeiTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestampMs));
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second} +08:00`;
}

export function verifyEnvironment(options) {
  const errors = [];
  const checks = [];
  const testRunAt = options.testRunAt ? new Date(options.testRunAt) : new Date();
  const runAtMs = testRunAt.getTime();
  const manifest = readJson(options.manifest, "manifest", errors);
  const hosting = readJson(options.hosting, "hosting config", errors);
  const capturedAtMs = manifest && Number.isFinite(runAtMs) ? captureAgeMs(manifest.captured_at, runAtMs) : null;
  const actualElapsedHours = capturedAtMs === null ? null : capturedAtMs / (3600 * 1000);
  const effectiveAgeHours = actualElapsedHours === null
    ? null
    : Math.max(0, actualElapsedHours - ONE_TIME_HOLIDAY_DEDUCTION_HOURS);

  const check = (name, actual, expected, valid) => {
    checks.push({ name, status: valid ? "PASS" : "FAIL", actual: actual ?? null, expected: expected ?? null });
    if (!valid) errors.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  // FPT-1: missing timezone, null, unparseable, future, or stale evidence
  // fail closed.  The D-09 credit is applied exactly once to elapsed time;
  // it is never derived from weekends or reapplied for consecutive holidays.
  check(
    "captured_at",
    manifest?.captured_at ?? null,
    `effective age within ${options.maxAgeHours}h after one-time ${ONE_TIME_HOLIDAY_DEDUCTION_HOURS}h holiday deduction`,
    capturedAtMs !== null && capturedAtMs >= 0 && effectiveAgeHours <= options.maxAgeHours,
  );

  if (manifest && hosting) {
    check("manifest_version", manifest.manifest_version, "phase4a.environment-source-of-truth/v1", manifest.manifest_version === "phase4a.environment-source-of-truth/v1");
    check("environment", manifest.environment, "staging|production", manifest.environment === "staging" || manifest.environment === "production");

    const backend = manifest.sites?.shared_backend;
    const worker = manifest.worker;
    const isStagingPredeploy = manifest.environment === "staging" && worker?.deployment_state === "predeploy";
    check("shared_backend.project_id", hosting.project_id, backend?.project_id, nonEmptyString(backend?.project_id) && hosting.project_id === backend.project_id);
    check("worker.project_id", worker?.project_id, backend?.project_id, nonEmptyString(worker?.project_id) && worker.project_id === backend?.project_id);
    if (!isStagingPredeploy) {
      const student = manifest.sites?.student;
      const admin = manifest.sites?.admin;
      check("student.project_id.present", student?.project_id, "non-empty", nonEmptyString(student?.project_id));
      check("admin.project_id.present", admin?.project_id, "non-empty", nonEmptyString(admin?.project_id));

      // FPT-2: three site project_ids must be pairwise distinct
      const projectIds = [backend?.project_id, student?.project_id, admin?.project_id].filter(nonEmptyString);
      const distinctProjectIds = new Set(projectIds);
      check("sites.project_ids.distinct", distinctProjectIds.size, 3, distinctProjectIds.size === 3 && projectIds.length === 3);

      check("worker.version.present", worker?.version, "non-empty", nonEmptyString(worker?.version));
      const deployedGitSha = worker?.deployed_git_sha;
      // F2 / FS-1: a deployment SHA is evidence only when it names a local
      // commit and that commit belongs to the checked-out repository lineage.
      // Do not pass a plausible-looking, arbitrary object ID such as `banana`.
      const deployedCommitExists = fullGitSha(deployedGitSha)
        && gitCheck(["rev-parse", "--verify", "--quiet", `${deployedGitSha}^{commit}`]);
      const deployedCommitInLineage = deployedCommitExists
        && gitCheck(["merge-base", "--is-ancestor", deployedGitSha, "HEAD"]);
      check(
        "worker.deployed_git_sha.provenance",
        deployedGitSha,
        "40+ hexadecimal commit that exists in the repository and is an ancestor of HEAD",
        fullGitSha(deployedGitSha) && deployedCommitExists && deployedCommitInLineage,
      );
    } else {
      check("worker.deployment_state", worker?.deployment_state, "predeploy", worker?.deployment_state === "predeploy");
      check("worker.version", worker?.version, "not_configured", worker?.version === "not_configured");
      check("worker.deployed_git_sha", worker?.deployed_git_sha, null, worker?.deployed_git_sha == null);
    }

    // FPT-4: derive the expected origin from the declared shared-backend URL.
    let backendUrl = null;
    let healthUrl = null;
    try {
      backendUrl = new URL(backend?.url);
      healthUrl = new URL(worker?.health_endpoint);
    } catch {
      backendUrl = null;
      healthUrl = null;
    }
    check("worker.health_endpoint.origin", healthUrl ? healthUrl.origin : null, backendUrl ? backendUrl.origin : null, Boolean(backendUrl && healthUrl && healthUrl.origin === backendUrl.origin));
    check("worker.health_endpoint.path", healthUrl ? healthUrl.pathname : null, "/api/health", healthUrl?.pathname === "/api/health");
    check("worker.health_status", worker?.health_status, isStagingPredeploy ? "not_configured" : 200, isStagingPredeploy ? worker?.health_status === "not_configured" : worker?.health_status === 200);

    const db = worker?.bindings?.DB;
    const bucket = worker?.bindings?.BOOKS_BUCKET;
    if (isStagingPredeploy) {
      // Staging must never inherit production D1/R2 bindings. Absence is the
      // required state; this is a configuration assertion, not a live probe.
      check("hosting.d1_binding", hosting.d1, "unbound", hosting.d1 == null);
      check("hosting.r2_binding", hosting.r2, "unbound", hosting.r2 == null);
      check("worker.DB.binding", db, "unbound", db == null);
      check("worker.BOOKS_BUCKET.binding", bucket, "unbound", bucket == null);
    } else {
      check("hosting.d1_binding", hosting.d1, "DB", hosting.d1 === "DB");
      check("worker.DB.type", db?.type, "d1", db?.type === "d1");
      check("worker.DB.resource_id", db?.resource_id, "non-empty", nonEmptyString(db?.resource_id));

    // F1: resource_id must not merely echo the binding name, unless identity_source says unavailable
      const dbResourceEcho = db?.resource_id === "DB";
      check("worker.DB.resource_id_not_binding_echo", db?.resource_id, "opaque resource id", !dbResourceEcho || db?.identity_source === "unavailable");

      check("worker.DB.readable", db?.readable, true, db?.readable === true);
      check("hosting.r2_binding", hosting.r2, "BOOKS_BUCKET", hosting.r2 === "BOOKS_BUCKET");
      check("worker.BOOKS_BUCKET.type", bucket?.type, "r2", bucket?.type === "r2");
      check("worker.BOOKS_BUCKET.resource_id", bucket?.resource_id, "non-empty", nonEmptyString(bucket?.resource_id));

    // F1: resource_id must not merely echo the binding name, unless identity_source says unavailable
      const bucketResourceEcho = bucket?.resource_id === "BOOKS_BUCKET";
      check("worker.BOOKS_BUCKET.resource_id_not_binding_echo", bucket?.resource_id, "opaque resource id", !bucketResourceEcho || bucket?.identity_source === "unavailable");

    // FPT-5: DB and BOOKS_BUCKET resource_ids must differ
      check("bindings.resource_ids.distinct", db?.resource_id !== bucket?.resource_id, "different", Boolean(db?.resource_id && bucket?.resource_id && db.resource_id !== bucket.resource_id));

      check("worker.BOOKS_BUCKET.list_readable", bucket?.list_readable, true, bucket?.list_readable === true);
      check("worker.BOOKS_BUCKET.get_readable", bucket?.get_readable, true, bucket?.get_readable === true);
    }

    // F3 safeguard: check repo-root hosting if present
    const rootHostingPath = path.join(repoDir, ".openai/hosting.json");
    if (fs.existsSync(rootHostingPath)) {
      const rootHosting = readJson(rootHostingPath, "repo root hosting config", errors);
      if (rootHosting) {
        check("repo_root.hosting.project_id", rootHosting.project_id, backend?.project_id, rootHosting.project_id === backend?.project_id);
      }
    }
  }

  const passed = errors.length === 0;
  const result = {
    schema: "phase4a.environment-alignment-result/v1",
    status: passed ? "PASS" : "FAIL",
    config_drift: passed ? "NO" : "YES",
    manifest: options.manifest,
    hosting: options.hosting,
    max_age_hours: options.maxAgeHours,
    captured_at: manifest?.captured_at ?? null,
    test_run_at: Number.isFinite(runAtMs) ? testRunAt.toISOString() : null,
    test_run_at_taipei: taipeiTimestamp(runAtMs),
    captured_at_taipei: manifest && typeof manifest.captured_at === "string" && !Number.isNaN(Date.parse(manifest.captured_at))
      ? taipeiTimestamp(Date.parse(manifest.captured_at))
      : null,
    // Kept for consumers of the earlier schema; it is the unmodified elapsed age.
    age_hours: actualElapsedHours,
    actual_elapsed_hours: actualElapsedHours,
    holiday_deduction_hours: ONE_TIME_HOLIDAY_DEDUCTION_HOURS,
    effective_age_hours: effectiveAgeHours,
    predeploy_config: manifest?.environment === "staging" && manifest?.worker?.deployment_state === "predeploy" ? "PREDEPLOY_CONFIG_PASS" : null,
    postdeploy_live: manifest?.environment === "staging" && manifest?.worker?.deployment_state === "predeploy" ? "POSTDEPLOY_LIVE_PENDING" : null,
    checks,
    errors,
  };

  return result;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(`ENV_ALIGNMENT=FAIL\nERROR=${error.message}`);
    process.exitCode = 2;
    return;
  }
  const result = verifyEnvironment(options);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`ENV_ALIGNMENT=${result.status}`);
    console.log(`CONFIG_DRIFT=${result.config_drift}`);
    console.log(`MANIFEST=${result.manifest}`);
    console.log(`HOSTING=${result.hosting}`);
    console.log(`MAX_AGE_HOURS=${result.max_age_hours}`);
    console.log(`SOT_CAPTURED_AT=${result.captured_at}`);
    console.log(`TEST_RUN_AT=${result.test_run_at}`);
    console.log(`TEST_RUN_AT_TAIPEI=${result.test_run_at_taipei}`);
    console.log(`SOT_CAPTURED_AT_TAIPEI=${result.captured_at_taipei}`);
    console.log(`ACTUAL_ELAPSED_HOURS=${result.actual_elapsed_hours}`);
    console.log(`HOLIDAY_DEDUCTION_HOURS=${result.holiday_deduction_hours}`);
    console.log(`EFFECTIVE_AGE_HOURS=${result.effective_age_hours}`);
    if (result.predeploy_config) console.log(`PREDEPLOY_CONFIG=${result.predeploy_config}`);
    if (result.postdeploy_live) console.log(`POSTDEPLOY_LIVE=${result.postdeploy_live}`);
    for (const item of result.checks) console.log(`CHECK_${item.name}=${item.status}`);
    for (const error of result.errors) console.error(`ERROR=${error}`);
  }
  process.exitCode = result.status === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
