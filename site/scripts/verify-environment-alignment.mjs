#!/usr/bin/env node

/**
 * Fail-closed comparison of the committed shared-backend Sites declaration and
 * a fresh, read-only control-plane manifest.  The manifest contains resource
 * identities only: secrets, tokens, and D1/R2 contents are deliberately out
 * of scope.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(siteDir, "..");
const defaultManifest = path.join(repoDir, "docs/phase4a/environment-source-of-truth.json");
const defaultHosting = path.join(siteDir, ".openai/hosting.json");

function usage() {
  console.error("Usage: node site/scripts/verify-environment-alignment.mjs [--manifest <path>] [--hosting <path>] [--json]");
}

function parseArgs(args) {
  const options = { manifest: defaultManifest, hosting: defaultHosting, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--manifest" || arg === "--hosting") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = path.resolve(process.cwd(), value);
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

export function verifyEnvironment(options) {
  const errors = [];
  const checks = [];
  const manifest = readJson(options.manifest, "manifest", errors);
  const hosting = readJson(options.hosting, "hosting config", errors);
  const check = (name, actual, expected, valid) => {
    checks.push({ name, status: valid ? "PASS" : "FAIL", actual: actual ?? null, expected: expected ?? null });
    if (!valid) errors.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  if (manifest && hosting) {
    check("manifest_version", manifest.manifest_version, "phase4a.environment-source-of-truth/v1", manifest.manifest_version === "phase4a.environment-source-of-truth/v1");
    check("environment", manifest.environment, "staging|production", manifest.environment === "staging" || manifest.environment === "production");
    check("captured_at", manifest.captured_at, "ISO-8601 timestamp", nonEmptyString(manifest.captured_at) && !Number.isNaN(Date.parse(manifest.captured_at)));

    const backend = manifest.sites?.shared_backend;
    const student = manifest.sites?.student;
    const admin = manifest.sites?.admin;
    const worker = manifest.worker;
    check("shared_backend.project_id", hosting.project_id, backend?.project_id, nonEmptyString(backend?.project_id) && hosting.project_id === backend.project_id);
    check("worker.project_id", worker?.project_id, backend?.project_id, nonEmptyString(worker?.project_id) && worker.project_id === backend?.project_id);
    check("student.project_id.present", student?.project_id, "non-empty", nonEmptyString(student?.project_id));
    check("admin.project_id.present", admin?.project_id, "non-empty", nonEmptyString(admin?.project_id));
    check("worker.version.present", worker?.version, "non-empty", nonEmptyString(worker?.version));
    check("worker.health_endpoint", worker?.health_endpoint, "https URL", (() => { try { return new URL(worker?.health_endpoint).protocol === "https:"; } catch { return false; } })());
    check("worker.health_status", worker?.health_status, 200, worker?.health_status === 200);

    const db = worker?.bindings?.DB;
    const bucket = worker?.bindings?.BOOKS_BUCKET;
    check("hosting.d1_binding", hosting.d1, "DB", hosting.d1 === "DB");
    check("worker.DB.type", db?.type, "d1", db?.type === "d1");
    check("worker.DB.resource_id", db?.resource_id, "non-empty", nonEmptyString(db?.resource_id));
    check("worker.DB.readable", db?.readable, true, db?.readable === true);
    check("hosting.r2_binding", hosting.r2, "BOOKS_BUCKET", hosting.r2 === "BOOKS_BUCKET");
    check("worker.BOOKS_BUCKET.type", bucket?.type, "r2", bucket?.type === "r2");
    check("worker.BOOKS_BUCKET.resource_id", bucket?.resource_id, "non-empty", nonEmptyString(bucket?.resource_id));
    check("worker.BOOKS_BUCKET.list_readable", bucket?.list_readable, true, bucket?.list_readable === true);
    check("worker.BOOKS_BUCKET.get_readable", bucket?.get_readable, true, bucket?.get_readable === true);
  }

  const passed = errors.length === 0;
  const result = {
    schema: "phase4a.environment-alignment-result/v1",
    status: passed ? "PASS" : "FAIL",
    config_drift: passed ? "NO" : "YES",
    manifest: options.manifest,
    hosting: options.hosting,
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
    for (const item of result.checks) console.log(`CHECK_${item.name}=${item.status}`);
    for (const error of result.errors) console.error(`ERROR=${error}`);
  }
  process.exitCode = result.status === "PASS" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
