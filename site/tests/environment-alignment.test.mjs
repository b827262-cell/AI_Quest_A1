import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.resolve(testDir, "..");
const validator = path.join(siteDir, "scripts/verify-environment-alignment.mjs");
const { DEFAULT_MAX_AGE_HOURS, ONE_TIME_HOLIDAY_DEDUCTION_HOURS, verifyEnvironment } = await import(validator);

function writeFixture(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function validManifest() {
  return {
    manifest_version: "phase4a.environment-source-of-truth/v1",
    environment: "production",
    captured_at: new Date().toISOString(),
    sites: {
      shared_backend: {
        project_id: "appgprj_backend",
        url: "https://ai-quest-a1-backend.b827262.chatgpt.site",
      },
      student: { project_id: "appgprj_student" },
      admin: { project_id: "appgprj_admin" },
    },
    worker: {
      project_id: "appgprj_backend",
      version: "appgver_123",
      deployed_git_sha: "f0085202150c67760040644f1db3d6c479dc2074",
      health_endpoint: "https://ai-quest-a1-backend.b827262.chatgpt.site/api/health",
      health_status: 200,
      bindings: {
        DB: { type: "d1", resource_id: "d1_opaque_123", readable: true },
        BOOKS_BUCKET: { type: "r2", resource_id: "r2_opaque_123", list_readable: true, get_readable: true },
      },
    },
  };
}

function run(manifest, hosting, extraOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "environment-alignment-"));
  try {
    const manifestPath = writeFixture(dir, "manifest.json", manifest);
    const hostingPath = writeFixture(dir, "hosting.json", hosting);
    return verifyEnvironment({ manifest: manifestPath, hosting: hostingPath, maxAgeHours: DEFAULT_MAX_AGE_HOURS, json: true, ...extraOpts });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(manifest, hosting, testRunAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "environment-alignment-cli-"));
  try {
    const manifestPath = writeFixture(dir, "manifest.json", manifest);
    const hostingPath = writeFixture(dir, "hosting.json", hosting);
    return spawnSync(process.execPath, [validator, "--manifest", manifestPath, "--hosting", hostingPath, "--test-run-at", testRunAt, "--json"], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("environment alignment passes only for matching identities and readable bindings", () => {
  const result = run(validManifest(), { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "PASS");
  assert.equal(result.config_drift, "NO");
});

test("environment alignment fails closed for a project mismatch", () => {
  const result = run(validManifest(), { project_id: "appgprj_wrong", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.equal(result.config_drift, "YES");
  assert.ok(result.checks.some((check) => check.name === "shared_backend.project_id" && check.status === "FAIL"));
});

test("environment alignment fails closed for missing or unreadable bindings", () => {
  const manifest = validManifest();
  manifest.worker.bindings.DB.readable = false;
  delete manifest.worker.bindings.BOOKS_BUCKET.get_readable;
  const result = run(manifest, { project_id: "appgprj_backend", d1: "OTHER_DB", r2: null });
  assert.equal(result.status, "FAIL");
  assert.ok(result.errors.length >= 3);
});

test("environment alignment fails closed for invalid environment target", () => {
  const manifest = validManifest();
  manifest.environment = "unknown_env";
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "environment" && check.status === "FAIL"));
});

test("FS-1: environment alignment fails closed for a garbage deployed Git SHA", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-garbage-sha-"));
  try {
    // 1. Non-hex format ('banana')
    const manifestBanana = validManifest();
    manifestBanana.worker.deployed_git_sha = "banana";
    const manifestPathBanana = writeFixture(dir, "manifest-banana.json", manifestBanana);
    const hostingPath = writeFixture(dir, "hosting.json", { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
    const resultBanana = verifyEnvironment({ manifest: manifestPathBanana, hosting: hostingPath, maxAgeHours: DEFAULT_MAX_AGE_HOURS, json: true });
    assert.equal(resultBanana.status, "FAIL");
    assert.ok(resultBanana.checks.some((check) => check.name === "worker.deployed_git_sha.provenance" && check.status === "FAIL"));

    const resBanana = spawnSync(process.execPath, [validator, "--manifest", manifestPathBanana, "--hosting", hostingPath, "--json"], { encoding: "utf8" });
    if (resBanana.error?.code === "EPERM") return t.skip("subprocess execution is unavailable in this sandbox");
    assert.equal(resBanana.status, 1);
    const parsedBanana = JSON.parse(resBanana.stdout);
    assert.equal(parsedBanana.status, "FAIL");
    assert.ok(parsedBanana.checks.some((check) => check.name === "worker.deployed_git_sha.provenance" && check.status === "FAIL"));

    // 2. Valid 40-hex format but non-existent commit in repo
    const manifestHexNonExistent = validManifest();
    manifestHexNonExistent.worker.deployed_git_sha = "0000000000000000000000000000000000000000";
    const manifestPathHex = writeFixture(dir, "manifest-hex.json", manifestHexNonExistent);
    const resultHex = verifyEnvironment({ manifest: manifestPathHex, hosting: hostingPath, maxAgeHours: DEFAULT_MAX_AGE_HOURS, json: true });
    assert.equal(resultHex.status, "FAIL");
    assert.ok(resultHex.checks.some((check) => check.name === "worker.deployed_git_sha.provenance" && check.status === "FAIL"));

    const resHex = spawnSync(process.execPath, [validator, "--manifest", manifestPathHex, "--hosting", hostingPath, "--json"], { encoding: "utf8" });
    assert.equal(resHex.status, 1);
    const parsedHex = JSON.parse(resHex.stdout);
    assert.equal(parsedHex.status, "FAIL");
    assert.ok(parsedHex.checks.some((check) => check.name === "worker.deployed_git_sha.provenance" && check.status === "FAIL"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("environment alignment fails closed for non-https or non-200 health status", () => {
  const manifest = validManifest();
  manifest.worker.health_endpoint = "http://ai-quest-a1-backend.b827262.chatgpt.site/api/health";
  manifest.worker.health_status = 500;
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "worker.health_endpoint.origin" && check.status === "FAIL"));
  assert.ok(result.checks.some((check) => check.name === "worker.health_status" && check.status === "FAIL"));
});

test("FPT-1 / F5: one-time 24h holiday deduction gives the 96h actual boundary", (t) => {
  const capturedAt = "2026-09-22T07:16:40.000Z";
  const baseTime = new Date("2026-09-26T07:16:40.000Z");
  const hosting = { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" };
  assert.equal(ONE_TIME_HOLIDAY_DEDUCTION_HOURS, 24);

  // 95h59m actual => 71h59m effective: PASS.
  const m95h59m = validManifest();
  m95h59m.captured_at = capturedAt;
  const res95h59m = run(m95h59m, hosting, { testRunAt: new Date(baseTime.getTime() - 60_000).toISOString() });
  assert.equal(res95h59m.status, "PASS");
  assert.equal(res95h59m.actual_elapsed_hours, 95 + (59 / 60));
  assert.equal(res95h59m.effective_age_hours, 71 + (59 / 60));

  // 96h actual => 72h effective: inclusive PASS.
  const m96h = validManifest();
  m96h.captured_at = capturedAt;
  const res96h = run(m96h, hosting, { testRunAt: baseTime.toISOString() });
  assert.equal(res96h.status, "PASS");
  assert.equal(res96h.actual_elapsed_hours, 96);
  assert.equal(res96h.effective_age_hours, 72);

  // 96h + 1s actual => 72h + 1s effective: FAIL.
  const m96h1s = validManifest();
  m96h1s.captured_at = capturedAt;
  const res96h1s = run(m96h1s, hosting, { testRunAt: new Date(baseTime.getTime() + 1_000).toISOString() });
  assert.equal(res96h1s.status, "FAIL");
  assert.equal(res96h1s.effective_age_hours, 72 + (1 / 3600));

  // Missing, future, and timezone-less timestamps remain fail closed.
  const mMissing = validManifest();
  delete mMissing.captured_at;
  const resMissing = run(mMissing, hosting, { testRunAt: baseTime.toISOString() });
  assert.equal(resMissing.status, "FAIL");
  assert.equal(resMissing.checks.find((c) => c.name === "captured_at").status, "FAIL");

  // 6. Future timestamp FAIL
  const mFuture = validManifest();
  mFuture.captured_at = new Date(baseTime.getTime() + (3600 * 1000)).toISOString();
  const resFuture = run(mFuture, hosting, { testRunAt: baseTime.toISOString() });
  assert.equal(resFuture.status, "FAIL");
  assert.equal(resFuture.checks.find((c) => c.name === "captured_at").status, "FAIL");

  // 7. Invalid timezone FAIL
  const mNoTz = validManifest();
  mNoTz.captured_at = "2026-09-25T12:00:00.000";
  const resNoTz = run(mNoTz, hosting, { testRunAt: baseTime.toISOString() });
  assert.equal(resNoTz.status, "FAIL");
  assert.equal(resNoTz.checks.find((c) => c.name === "captured_at").status, "FAIL");

  const mInvalid = validManifest();
  mInvalid.captured_at = "not-a-timestamp";
  const resInvalid = run(mInvalid, hosting, { testRunAt: baseTime.toISOString() });
  assert.equal(resInvalid.status, "FAIL");
  assert.equal(resInvalid.checks.find((c) => c.name === "captured_at").status, "FAIL");

  // The credit is a constant one-time subtraction, not an accumulating rule.
  const mShort = validManifest();
  mShort.captured_at = new Date(baseTime.getTime() - 1_000).toISOString();
  const resShort = run(mShort, hosting, { testRunAt: baseTime.toISOString() });
  assert.equal(resShort.effective_age_hours, 0);
  assert.equal(resShort.holiday_deduction_hours, 24);
  const m120h = validManifest();
  m120h.captured_at = new Date(baseTime.getTime() - (120 * 3600 * 1000)).toISOString();
  const res120h = run(m120h, hosting, { testRunAt: baseTime.toISOString() });
  assert.equal(res120h.effective_age_hours, 96, "the one-time credit is not repeatedly applied");
  assert.equal(res120h.status, "FAIL");

  // The F7 CLI itself has the same inclusive boundary and reports both ages.
  const cli95h59m = runCli(m95h59m, hosting, new Date(baseTime.getTime() - 60_000).toISOString());
  const cli96h = runCli(m96h, hosting, baseTime.toISOString());
  const cli96h1s = runCli(m96h1s, hosting, new Date(baseTime.getTime() + 1_000).toISOString());
  if (cli95h59m.error?.code === "EPERM" || cli96h.error?.code === "EPERM" || cli96h1s.error?.code === "EPERM") {
    t.skip("subprocess execution is unavailable in this sandbox");
    return;
  }
  assert.equal(cli95h59m.status, 0);
  assert.equal(cli96h.status, 0);
  assert.equal(cli96h1s.status, 1);
  assert.equal(JSON.parse(cli96h.stdout).effective_age_hours, 72);
});

test("FPT-2: environment alignment fails closed when site project_ids are not distinct", () => {
  const manifest = validManifest();
  manifest.sites.student.project_id = manifest.sites.shared_backend.project_id;
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "sites.project_ids.distinct" && check.status === "FAIL"));
});

test("FPT-4: environment alignment fails closed when health endpoint origin is not shared backend", () => {
  const manifest = validManifest();
  manifest.worker.health_endpoint = "https://evil.example.com/api/health";
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "worker.health_endpoint.origin" && check.status === "FAIL"));
});

test("F1: environment alignment fails closed when resource_id echoes binding name without unavailable identity_source", () => {
  const manifest = validManifest();
  manifest.worker.bindings.DB.resource_id = "DB";
  delete manifest.worker.bindings.DB.identity_source;
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "worker.DB.resource_id_not_binding_echo" && check.status === "FAIL"));
});

test("FPT-5: environment alignment fails closed when DB and BOOKS_BUCKET share the same resource_id", () => {
  const manifest = validManifest();
  manifest.worker.bindings.DB.resource_id = "same_resource_id";
  manifest.worker.bindings.BOOKS_BUCKET.resource_id = "same_resource_id";
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "bindings.resource_ids.distinct" && check.status === "FAIL"));
});

test("F6 / FPT-6: real staging files are adjudicated from the measured 72h age", () => {
  const truthPath = path.join(siteDir, "../docs/phase4a/environment-source-of-truth.staging.json");
  const hostingPath = path.join(siteDir, ".openai/hosting.json");
  assert.ok(fs.existsSync(truthPath), "environment source-of-truth file must exist");
  assert.ok(fs.existsSync(hostingPath), "hosting config must exist");
  const result = verifyEnvironment({ manifest: truthPath, hosting: hostingPath, maxAgeHours: DEFAULT_MAX_AGE_HOURS, json: true });
  const fresh = result.effective_age_hours !== null && result.age_hours >= 0 && result.effective_age_hours <= DEFAULT_MAX_AGE_HOURS;
  assert.equal(result.status, fresh ? "PASS" : "FAIL");
  assert.equal(result.config_drift, fresh ? "NO" : "YES");
  assert.equal(result.predeploy_config, "PREDEPLOY_CONFIG_PASS");
  assert.equal(result.postdeploy_live, "POSTDEPLOY_LIVE_PENDING");
});

test("F7: CLI subprocess exit on real repo files follows the measured 72h result", (t) => {
  const res = spawnSync(process.execPath, [validator, "--json"], { encoding: "utf8" });
  if (res.error?.code === "EPERM") return t.skip("subprocess execution is unavailable in this sandbox");
  const parsed = JSON.parse(res.stdout);
  const fresh = parsed.effective_age_hours !== null && parsed.age_hours >= 0 && parsed.effective_age_hours <= DEFAULT_MAX_AGE_HOURS;
  assert.equal(res.status, fresh ? 0 : 1);
  assert.equal(parsed.status, fresh ? "PASS" : "FAIL");
  assert.equal(parsed.config_drift, fresh ? "NO" : "YES");
  assert.equal(parsed.predeploy_config, "PREDEPLOY_CONFIG_PASS");
  assert.equal(parsed.postdeploy_live, "POSTDEPLOY_LIVE_PENDING");
});

test("superseded production source-of-truth fails when used as the staging validator input", () => {
  const productionTruthPath = path.join(siteDir, "../docs/phase4a/environment-source-of-truth.json");
  const hostingPath = path.join(siteDir, ".openai/hosting.json");
  const result = verifyEnvironment({ manifest: productionTruthPath, hosting: hostingPath, maxAgeHours: DEFAULT_MAX_AGE_HOURS, json: true });
  assert.equal(result.status, "FAIL");
  assert.equal(result.config_drift, "YES");
});

test("F7: CLI subprocess exits 1 on config drift / mismatch", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-drift-"));
  try {
    const manifestPath = writeFixture(dir, "manifest.json", validManifest());
    const hostingPath = writeFixture(dir, "hosting.json", { project_id: "appgprj_wrong", d1: "DB", r2: "BOOKS_BUCKET" });
    const res = spawnSync(process.execPath, [validator, "--manifest", manifestPath, "--hosting", hostingPath], { encoding: "utf8" });
    if (res.error?.code === "EPERM") return t.skip("subprocess execution is unavailable in this sandbox");
    assert.equal(res.status, 1);
    assert.ok(res.stdout.includes("ENV_ALIGNMENT=FAIL"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F7: CLI subprocess exits 2 on usage / unknown argument error", (t) => {
  const res = spawnSync(process.execPath, [validator, "--unknown-flag"], { encoding: "utf8" });
  if (res.error?.code === "EPERM") return t.skip("subprocess execution is unavailable in this sandbox");
  assert.equal(res.status, 2);
  assert.ok(res.stderr.includes("ENV_ALIGNMENT=FAIL"));
});
