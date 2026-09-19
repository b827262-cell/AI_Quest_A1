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
const productionManifest = path.join(repoDir, "docs/phase4a/environment-source-of-truth.json");
const defaultManifest = productionManifest;
const defaultHosting = path.join(siteDir, ".openai/hosting.json");

function usage() {
  console.error("Usage: node site/scripts/verify-environment-alignment.mjs [--manifest <path>] [--hosting <path>] [--max-age-hours <hours>] [--json]");
}

function parseArgs(args) {
  const options = { manifest: defaultManifest, hosting: defaultHosting, maxAgeHours: 24, json: false };
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

function captureAgeMs(capturedAt) {
  const parsed = Date.parse(capturedAt);
  if (Number.isNaN(parsed)) return null;
  return Date.now() - parsed;
}

function containsProductionBinding(value) {
  if (typeof value === "string") return value === "DB" || value === "BOOKS_BUCKET";
  if (Array.isArray(value)) return value.some(containsProductionBinding);
  if (value && typeof value === "object") return Object.values(value).some(containsProductionBinding);
  return false;
}

function containsProductionProjectId(value, productionProjectIds) {
  if (typeof value === "string") return productionProjectIds.has(value);
  if (Array.isArray(value)) return value.some((item) => containsProductionProjectId(item, productionProjectIds));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsProductionProjectId(item, productionProjectIds));
  return false;
}

function verifyProduction(manifest, hosting, production, check) {
  const backend = manifest.sites?.shared_backend;
  const student = manifest.sites?.student;
  const admin = manifest.sites?.admin;
  const worker = manifest.worker;
  const productionProjectId = production?.sites?.shared_backend?.project_id;
  let productionHealthOrigin = null;
  try { productionHealthOrigin = new URL(production?.worker?.health_endpoint).origin; } catch { /* checked below */ }
  check("shared_backend.project_id", hosting.project_id, productionProjectId, nonEmptyString(productionProjectId) && hosting.project_id === productionProjectId && backend?.project_id === productionProjectId);
  check("worker.project_id", worker?.project_id, productionProjectId, nonEmptyString(productionProjectId) && worker?.project_id === productionProjectId);
  check("student.project_id.present", student?.project_id, "non-empty", nonEmptyString(student?.project_id));
  check("admin.project_id.present", admin?.project_id, "non-empty", nonEmptyString(admin?.project_id));
  const projectIds = [backend?.project_id, student?.project_id, admin?.project_id].filter(nonEmptyString);
  check("sites.project_ids.distinct", new Set(projectIds).size, 3, new Set(projectIds).size === 3 && projectIds.length === 3);
  check("worker.version.present", worker?.version, "non-empty", nonEmptyString(worker?.version));
  const deployedGitSha = worker?.deployed_git_sha;
  const deployedCommitExists = fullGitSha(deployedGitSha) && gitCheck(["rev-parse", "--verify", "--quiet", `${deployedGitSha}^{commit}`]);
  check("worker.deployed_git_sha.provenance", deployedGitSha, "40+ hexadecimal commit that exists in the repository and is an ancestor of HEAD", fullGitSha(deployedGitSha) && deployedCommitExists && gitCheck(["merge-base", "--is-ancestor", deployedGitSha, "HEAD"]));
  let healthUrl = null;
  try { healthUrl = new URL(worker?.health_endpoint); } catch { /* checked below */ }
  check("worker.health_endpoint.origin", healthUrl ? healthUrl.origin : null, productionHealthOrigin, nonEmptyString(productionHealthOrigin) && healthUrl?.origin === productionHealthOrigin);
  check("worker.health_status", worker?.health_status, 200, worker?.health_status === 200);
  const db = worker?.bindings?.DB;
  const bucket = worker?.bindings?.BOOKS_BUCKET;
  check("hosting.d1_binding", hosting.d1, "DB", hosting.d1 === "DB");
  check("worker.DB.type", db?.type, "d1", db?.type === "d1");
  check("worker.DB.resource_id", db?.resource_id, "non-empty", nonEmptyString(db?.resource_id));
  check("worker.DB.resource_id_not_binding_echo", db?.resource_id, "opaque resource id", db?.resource_id !== "DB" || db?.identity_source === "unavailable");
  check("worker.DB.readable", db?.readable, true, db?.readable === true);
  check("hosting.r2_binding", hosting.r2, "BOOKS_BUCKET", hosting.r2 === "BOOKS_BUCKET");
  check("worker.BOOKS_BUCKET.type", bucket?.type, "r2", bucket?.type === "r2");
  check("worker.BOOKS_BUCKET.resource_id", bucket?.resource_id, "non-empty", nonEmptyString(bucket?.resource_id));
  check("worker.BOOKS_BUCKET.resource_id_not_binding_echo", bucket?.resource_id, "opaque resource id", bucket?.resource_id !== "BOOKS_BUCKET" || bucket?.identity_source === "unavailable");
  check("bindings.resource_ids.distinct", db?.resource_id !== bucket?.resource_id, "different", Boolean(db?.resource_id && bucket?.resource_id && db.resource_id !== bucket.resource_id));
  check("worker.BOOKS_BUCKET.list_readable", bucket?.list_readable, true, bucket?.list_readable === true);
  check("worker.BOOKS_BUCKET.get_readable", bucket?.get_readable, true, bucket?.get_readable === true);
}

function verifyStaging(manifest, hosting, productionProjectIds, check) {
  const testSite = manifest.sites?.test_site;
  check("test_site.project_id", hosting.project_id, testSite?.project_id, nonEmptyString(testSite?.project_id) && hosting.project_id === testSite.project_id);
  check("test_site.project_id.format", testSite?.project_id, "appgprj_<opaque id>", /^appgprj_[a-z0-9]+$/i.test(testSite?.project_id ?? ""));
  check("hosting.d1_binding.absent", hosting.d1 ?? null, null, !("d1" in hosting) || hosting.d1 == null);
  check("hosting.r2_binding.absent", hosting.r2 ?? null, null, !("r2" in hosting) || hosting.r2 == null);
  check("staging.production_bindings.absent", containsProductionBinding(manifest), false, !containsProductionBinding(manifest));
  check("staging.production_project_literals.absent", containsProductionProjectId(manifest, productionProjectIds), false, !containsProductionProjectId(manifest, productionProjectIds));
  check("staging.worker.absent", manifest.worker ?? null, null, !("worker" in manifest));
  check("staging.postdeploy_live", manifest.postdeploy_live, "PENDING", manifest.postdeploy_live === "PENDING");
  check("staging.backend_mode", manifest.backend_mode, "isolated-fail-closed", manifest.backend_mode === "isolated-fail-closed");
}

export function verifyEnvironment(options) {
  const errors = [];
  const checks = [];
  const manifest = readJson(options.manifest, "manifest", errors);
  const hosting = readJson(options.hosting, "hosting config", errors);
  const production = readJson(productionManifest, "production source of truth", errors);
  const productionProjectIds = new Set(Object.values(production?.sites ?? {}).map((site) => site?.project_id).filter(nonEmptyString));
  const capturedAtMs = manifest ? captureAgeMs(manifest.captured_at) : null;

  const check = (name, actual, expected, valid) => {
    checks.push({ name, status: valid ? "PASS" : "FAIL", actual: actual ?? null, expected: expected ?? null });
    if (!valid) errors.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  // FPT-1: captured_at freshness (default max-age 24h; null/unparseable = FAIL)
  const maxAgeMs = options.maxAgeHours * 3600 * 1000;
  check("captured_at", manifest?.captured_at ?? null, `within ${options.maxAgeHours}h`, capturedAtMs !== null && capturedAtMs >= 0 && capturedAtMs <= maxAgeMs);

  if (manifest && hosting) {
    check("manifest_version", manifest.manifest_version, "phase4a.environment-source-of-truth/v1", manifest.manifest_version === "phase4a.environment-source-of-truth/v1");
    check("environment", manifest.environment, "staging|production", manifest.environment === "staging" || manifest.environment === "production");

    if (manifest.environment === "production") verifyProduction(manifest, hosting, production, check);
    if (manifest.environment === "staging") verifyStaging(manifest, hosting, productionProjectIds, check);

    // F3 safeguard: check repo-root hosting if present
    const rootHostingPath = path.join(repoDir, ".openai/hosting.json");
    if (fs.existsSync(rootHostingPath)) {
      const rootHosting = readJson(rootHostingPath, "repo root hosting config", errors);
      if (rootHosting) {
        check("repo_root.hosting.project_id", rootHosting.project_id, manifest.sites?.shared_backend?.project_id, manifest.environment === "production" && rootHosting.project_id === manifest.sites?.shared_backend?.project_id);
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
    for (const item of result.checks) console.log(`CHECK_${item.name}=${item.status}`);
    for (const error of result.errors) console.error(`ERROR=${error}`);
  }
  process.exitCode = result.status === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
