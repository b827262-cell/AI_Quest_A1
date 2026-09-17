import assert from "node:assert/strict";
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
    captured_at: "2026-09-17T00:00:00.000Z",
    sites: {
      shared_backend: { project_id: "appgprj_backend" },
      student: { project_id: "appgprj_student" },
      admin: { project_id: "appgprj_admin" },
    },
    worker: {
      project_id: "appgprj_backend",
      version: "appgver_123",
      health_endpoint: "https://backend.example.test/api/health",
      health_status: 200,
      bindings: {
        DB: { type: "d1", resource_id: "d1_123", readable: true },
        BOOKS_BUCKET: { type: "r2", resource_id: "r2_123", list_readable: true, get_readable: true },
      },
    },
  };
}

function run(manifest, hosting) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "environment-alignment-"));
  try {
    const manifestPath = writeFixture(dir, "manifest.json", manifest);
    const hostingPath = writeFixture(dir, "hosting.json", hosting);
    return verifyEnvironment({ manifest: manifestPath, hosting: hostingPath, json: true });
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
  manifest.worker.health_endpoint = "http://insecure.test/api/health";
  manifest.worker.health_status = 500;
  const result = run(manifest, { project_id: "appgprj_backend", d1: "DB", r2: "BOOKS_BUCKET" });
  assert.equal(result.status, "FAIL");
  assert.ok(result.checks.some((check) => check.name === "worker.health_endpoint" && check.status === "FAIL"));
  assert.ok(result.checks.some((check) => check.name === "worker.health_status" && check.status === "FAIL"));
});

test("environment alignment verifies committed repo hosting against source-of-truth file", () => {
  const truthPath = path.join(siteDir, "../docs/phase4a/environment-source-of-truth.json");
  const hostingPath = path.join(siteDir, ".openai/hosting.json");
  if (fs.existsSync(truthPath)) {
    const result = verifyEnvironment({ manifest: truthPath, hosting: hostingPath, json: true });
    assert.equal(result.status, "PASS");
    assert.equal(result.config_drift, "NO");
    assert.equal(result.errors.length, 0);
  }
});
