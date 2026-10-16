/**
 * Unit tests for the A-01 synthetic traffic driver core.
 *
 * Run: node --test scripts/a01-synthetic/core.test.mjs
 * No network, no filesystem, no real credentials.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

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
  isHostAllowListed,
  isProductionHost,
  maskIp,
  minGapMs,
  normalizeHost,
  ratio,
  redactText,
  resolveTargetConfig,
} from "./core.mjs";
import { parseArgs } from "./index.mjs";
import { SYNTHETIC_TARGETS, nonGetTargets, resolvePath, templatesRequiringId } from "./targets.mjs";

const STAGING_ENV = {
  A01_SYNTHETIC_BASE_URL: "https://staging.example-staging.com",
  A01_SYNTHETIC_ALLOWED_HOSTS: "example-staging.com",
};

test("resolveTargetConfig refuses an unset base URL", () => {
  assert.throws(() => resolveTargetConfig({}), ConfigError);
});

test("resolveTargetConfig refuses a non-https base URL", () => {
  assert.throws(() => resolveTargetConfig({ ...STAGING_ENV, A01_SYNTHETIC_BASE_URL: "http://staging.example-staging.com" }), ConfigError);
});

test("resolveTargetConfig refuses a production host even when allow-listed", () => {
  const env = { A01_SYNTHETIC_BASE_URL: "https://ai-quest-a1-student.b827262.chatgpt.site", A01_SYNTHETIC_ALLOWED_HOSTS: "chatgpt.site" };
  assert.throws(() => resolveTargetConfig(env), /production suffix/);
});

test("resolveTargetConfig refuses a host missing from the allow-list", () => {
  const env = { A01_SYNTHETIC_BASE_URL: "https://staging.other.com", A01_SYNTHETIC_ALLOWED_HOSTS: "example-staging.com" };
  assert.throws(() => resolveTargetConfig(env), /not in A01_SYNTHETIC_ALLOWED_HOSTS/);
});

test("resolveTargetConfig refuses when no allow-list is configured", () => {
  const env = { A01_SYNTHETIC_BASE_URL: "https://staging.example-staging.com" };
  assert.throws(() => resolveTargetConfig(env), /ALLOWED_HOSTS is not set/);
});

test("resolveTargetConfig accepts a valid staging target and strips the path", () => {
  const config = resolveTargetConfig({ ...STAGING_ENV, A01_SYNTHETIC_BASE_URL: "https://staging.example-staging.com/some/path" });
  assert.equal(config.origin, "https://staging.example-staging.com");
  assert.equal(config.host, "staging.example-staging.com");
});

test("isProductionHost matches the suffix root and subdomains", () => {
  assert.equal(isProductionHost("chatgpt.site"), true);
  assert.equal(isProductionHost("ai-quest-a1-student.b827262.chatgpt.site"), true);
  assert.equal(isProductionHost("staging.example.com"), false);
});

test("isHostAllowListed is exact or subdomain, never a substring", () => {
  assert.equal(isHostAllowListed("a.example-staging.com", ["example-staging.com"]), true);
  assert.equal(isHostAllowListed("notexample-staging.com", ["example-staging.com"]), false);
  assert.equal(isHostAllowListed("example-staging.com.evil.com", ["example-staging.com"]), false);
});

test("normalizeHost lowercases, drops the port and trailing dots", () => {
  assert.equal(normalizeHost("Example.COM:443."), "example.com");
});

test("maskIp never returns the raw client address", () => {
  assert.equal(maskIp("203.0.113.42"), "203.0.0.0/16");
  assert.equal(maskIp("198.51.100.7"), "198.51.0.0/16");
  assert.equal(maskIp("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(maskIp("not-an-ip"), null);
  assert.equal(maskIp(""), null);
});

test("hashId is deterministic, salted, and short", () => {
  assert.equal(hashId("book-1", "salt"), hashId("book-1", "salt"));
  assert.notEqual(hashId("book-1", "salt"), hashId("book-1", "other"));
  assert.equal(hashId("book-1", "salt").length, 16);
  assert.equal(hashId(undefined, "salt"), null);
});

test("redactText and assertNoSecrets remove and detect credential values", () => {
  const secrets = ["super-secret-value", "another-token"];
  assert.equal(redactText("bearer super-secret-value", secrets), "bearer [REDACTED]");
  assert.doesNotThrow(() => assertNoSecrets("clean output", secrets));
  assert.throws(() => assertNoSecrets("leaked another-token here", secrets), ConfigError);
});

test("collectSecretValues ignores blanks and unknown names", () => {
  const values = collectSecretValues({ A01_SYNTHETIC_STUDENT_RELAY_KEY: "k1", A01_SYNTHETIC_ADMIN_RELAY_KEY: "", UNRELATED: "x" });
  assert.deepEqual(values, ["k1"]);
});

test("expandTargets applies the default >=30 floor", () => {
  const expanded = expandTargets(SYNTHETIC_TARGETS, 0);
  assert.ok(expanded.every((target) => target.count === DEFAULT_PER_TARGET));
  assert.equal(DEFAULT_PER_TARGET >= 30, true);
});

test("minGapMs converts a rate into a minimum inter-request delay", () => {
  assert.equal(minGapMs(10), 100);
  assert.equal(minGapMs(0), 0);
  assert.equal(minGapMs(Number.NaN), 0);
});

test("evaluateStop trips on the manual stop file, error rate, and 5xx rate", () => {
  assert.equal(evaluateStop({ stopFileExists: true }).stop, true);
  assert.equal(evaluateStop({ attempted: 100, failures: 11, errorRateLimit: 0.1 }).stop, true);
  assert.equal(evaluateStop({ attempted: 100, serverErrors: 6, serverErrorLimit: 0.05 }).stop, true);
  assert.equal(evaluateStop({ attempted: 100, failures: 1, errorRateLimit: 0.1 }).stop, false);
  assert.equal(evaluateStop({ attempted: 0, errorRateLimit: 0.1 }).stop, false);
});

test("ratio is stable and guards divide-by-zero", () => {
  assert.equal(ratio(1, 3), 0.3333);
  assert.equal(ratio(0, 0), 0);
});

test("buildSummary and buildManifest stay redacted", () => {
  const secrets = ["leaky-key"];
  const summary = buildSummary({ runId: "r1", target: { host: "staging.example.com", origin: "https://staging.example.com" }, startedAt: "t0", finishedAt: "t1", dryRun: true, totals: { attempted: 0 }, byTarget: [], stop: { stop: false, reasons: [] }, cleanup: null, clientIpHashes: [] });
  const manifest = buildManifest({ runId: "r1", target: { host: "staging.example.com", origin: "https://staging.example.com" }, startedAt: "t0", finishedAt: "t1", dryRun: true, targets: [], credentials: ["student-relay"], cleanup: null });
  assert.equal(summary.kind, "a01-synthetic-summary");
  assert.equal(manifest.kind, "a01-synthetic-manifest");
  assert.equal(manifest.credentials.includes("leaky-key"), false);
  assertNoSecrets(JSON.stringify({ summary, manifest }), secrets);
});

test("target matrix covers every non-GET path x verb plus GET", () => {
  const nonGet = nonGetTargets();
  const keys = new Set(nonGet.map((t) => `${t.method} ${t.pathTemplate}`));
  for (const expected of [
    "PUT /api/student/progress",
    "POST /api/admin/books",
    "DELETE /api/admin/books",
    "POST /api/admin/books/upload",
    "DELETE /api/admin/books/[id]",
  ]) {
    assert.ok(keys.has(expected), `missing non-GET target: ${expected}`);
  }
  assert.ok(SYNTHETIC_TARGETS.some((t) => t.method === "GET" && t.pathTemplate === "/api/student/me"));
  assert.ok(SYNTHETIC_TARGETS.some((t) => t.method === "GET" && t.pathTemplate === "/api/admin/books"));
});

test("resolvePath substitutes the [id] template with the test id", () => {
  const target = SYNTHETIC_TARGETS.find((t) => t.pathTemplate === "/api/admin/books/[id]");
  assert.equal(resolvePath(target, { bookId: "test-book-1" }), "/api/admin/books/test-book-1");
  assert.equal(resolvePath(target, { bookId: "a/b" }), "/api/admin/books/a%2Fb");
  assert.throws(() => resolvePath(target, {}));
  assert.deepEqual(templatesRequiringId(), ["/api/admin/books/[id]", "/api/admin/books/[id]"]);
});

test("parseArgs defaults to dryRun=true and execute=false", () => {
  const options = parseArgs([]);
  assert.equal(options.dryRun, true);
  assert.equal(options.execute, false);
});

test("parseArgs enables execute and disables dryRun only when --execute is passed", () => {
  const options = parseArgs(["--execute"]);
  assert.equal(options.execute, true);
  assert.equal(options.dryRun, false);
});

test("parseArgs keeps dryRun=true when --dry-run is explicitly passed", () => {
  const options = parseArgs(["--dry-run"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.execute, false);
});

test("parseArgs respects precedence between --execute and --dry-run", () => {
  assert.equal(parseArgs(["--execute", "--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--execute", "--dry-run"]).execute, false);
  assert.equal(parseArgs(["--dry-run", "--execute"]).dryRun, false);
  assert.equal(parseArgs(["--dry-run", "--execute"]).execute, true);
});

test("parseArgs preserves configuration options alongside --execute", () => {
  const options = parseArgs(["--execute", "--per-target", "50", "--rate", "10", "--stop-file", "/tmp/stop"]);
  assert.equal(options.execute, true);
  assert.equal(options.dryRun, false);
  assert.equal(options.perTarget, 50);
  assert.equal(options.rate, 10);
  assert.equal(options.stopFile, "/tmp/stop");
});

test("parseArgs throws ConfigError on unknown options", () => {
  assert.throws(() => parseArgs(["--unknown-flag"]), ConfigError);
});

test("CLI execution defaults to dry-run (no live requests) without --execute", () => {
  const tmpOut = mkdtempSync(join(tmpdir(), "a01-dry-"));
  try {
    const res = spawnSync(process.execPath, [resolve(import.meta.dirname, "index.mjs"), "--out", tmpOut], {
      env: { ...process.env, ...STAGING_ENV },
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /\[dry-run\]/);
    assert.match(res.stdout, /attempted=0 failures=0/);
  } finally {
    rmSync(tmpOut, { recursive: true, force: true });
  }
});

test("CLI execution with --execute requires necessary env (refuses when book ID missing)", () => {
  const tmpOut = mkdtempSync(join(tmpdir(), "a01-exec-"));
  try {
    const res = spawnSync(process.execPath, [resolve(import.meta.dirname, "index.mjs"), "--execute", "--out", tmpOut], {
      env: { ...process.env, ...STAGING_ENV },
      encoding: "utf8",
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /\[refused\] A01_SYNTHETIC_BOOK_ID is required/);
  } finally {
    rmSync(tmpOut, { recursive: true, force: true });
  }
});

