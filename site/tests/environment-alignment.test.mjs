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
const { verifyEnvironment } = await import(validator);

function writeFixture(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function validManifest() {
  return {
    manifest_version: "phase4a.environment-source-of-truth/v1",
    environment: "staging",
    captured_at: new Date().toISOString(),
    sites: {
      shared_backend: { project_id: "appgprj_backend" },
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
    return verifyEnvironment({ manifest: manifestPath, hosting: hostingPath, maxAgeHours: 24, json: true, ...extraOpts });
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

test("environment alignment fails closed for non-https or non-200 health status", () => {
  const manifest = validManifest();
  manifest.worker.health_endpoint = "http://ai-quest-a1-backend.b827262.chatgpt.site/api/health";
  manifest.worker.health_status = 500;
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "worker.health_endpoint.origin" && check.status === "FAIL"));
  assert.ok(result.checks.some((check) => check.name === "worker.health_status" && check.status === "FAIL"));
});

test("FPT-1 / F5: environment alignment fails closed when captured_at exceeds maxAgeHours", () => {
  const manifest = validManifest();
  manifest.captured_at = "2025-01-01T00:00:00.000Z";
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" }, { maxAgeHours: 24 });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "captured_at" && check.status === "FAIL"));
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

test("F6 / FPT-6: environment alignment verifies committed repo hosting against source-of-truth file unconditionally", () => {
  const truthPath = path.join(siteDir, "../docs/phase4a/environment-source-of-truth.json");
  const hostingPath = path.join(siteDir, ".openai/hosting.json");
  assert.ok(fs.existsSync(truthPath), "environment source-of-truth file must exist");
  assert.ok(fs.existsSync(hostingPath), "hosting config must exist");
  const result = verifyEnvironment({ manifest: truthPath, hosting: hostingPath, maxAgeHours: 24, json: true });
  assert.equal(result.status, "PASS");
  assert.equal(result.config_drift, "NO");
  assert.equal(result.errors.length, 0);
});

test("F7: CLI subprocess exits 0 on real repo files", () => {
  const res = spawnSync(process.execPath, [validator, "--json"], { encoding: "utf8" });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, "PASS");
  assert.equal(parsed.config_drift, "NO");
});

test("F7: CLI subprocess exits 1 on config drift / mismatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-drift-"));
  try {
    const manifestPath = writeFixture(dir, "manifest.json", validManifest());
    const hostingPath = writeFixture(dir, "hosting.json", { project_id: "appgprj_wrong", d1: "DB", r2: "BOOKS_BUCKET" });
    const res = spawnSync(process.execPath, [validator, "--manifest", manifestPath, "--hosting", hostingPath], { encoding: "utf8" });
    assert.equal(res.status, 1);
    assert.ok(res.stdout.includes("ENV_ALIGNMENT=FAIL"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("F7: CLI subprocess exits 2 on usage / unknown argument error", () => {
  const res = spawnSync(process.execPath, [validator, "--unknown-flag"], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.ok(res.stderr.includes("ENV_ALIGNMENT=FAIL"));
});
