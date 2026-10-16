/**
 * Unit tests for the A-01 synthetic traffic injector (draft).
 * Run: node --test scripts/a01-synthetic/a01-synthetic.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCanonical,
  buildRelayHeaders,
  canonicalEmail,
  canonicalPath,
  generateNonce,
  NONCE_PATTERN,
  signRelay,
} from "./relay-sign.mjs";
import {
  assertStagingTarget,
  DEFAULT_DENY_HOSTS,
  denyListFromEnv,
  isConfigured,
  maskIp,
  redactEnv,
  redactString,
  SafetyError,
} from "./safety.mjs";
import { buildPlan, nonGetRows, planTotal, resolveRoute } from "./plan.mjs";
import {
  createManifest,
  finalizeManifest,
  hashId,
  recordResult,
  summarize,
  writeEvidence,
} from "./manifest.mjs";
import {
  checkStopConditions,
  describeReadiness,
  runInjection,
} from "./inject.mjs";

const KEY = "k".repeat(40); // >= 32 chars

// --------------------------------------------------------------------------
// relay-sign
// --------------------------------------------------------------------------

test("canonicalPath collapses duplicate slashes and strips trailing slash", () => {
  assert.equal(canonicalPath("/api//student//me/"), "/api/student/me");
  assert.equal(canonicalPath("/"), "/");
  assert.equal(canonicalPath("/api/student/me"), "/api/student/me");
});

test("canonicalEmail trims, lowercases, empty/dash -> dash", () => {
  assert.equal(canonicalEmail("  Test@Example.COM "), "test@example.com");
  assert.equal(canonicalEmail(""), "-");
  assert.equal(canonicalEmail("-"), "-");
  assert.equal(canonicalEmail(undefined), "-");
});

test("buildCanonical uses '-' digests for GET and sha256 for PUT", async () => {
  const get = await buildCanonical({
    method: "get", pathname: "/api/student/me", search: "", body: undefined,
    site: "student", userId: "u1", email: "a@b.com", role: "-", ts: "1700000000", nonce: "n".repeat(20),
  });
  const lines = get.split("\n");
  assert.equal(lines[0], "a01-relay-v1");
  assert.equal(lines[1], "GET");
  assert.equal(lines[2], "/api/student/me");
  assert.equal(lines[3], "-"); // no query
  assert.equal(lines[4], "-"); // GET body digest
  assert.equal(lines[5], "student");
  assert.equal(lines[6], "u1");
  assert.equal(lines[7], "a@b.com");
  assert.equal(lines[8], "-");

  const put = await buildCanonical({
    method: "PUT", pathname: "/api/student/progress", search: "", body: "{}",
    site: "student", userId: "u1", email: "a@b.com", role: "-", ts: "1700000000", nonce: "n".repeat(20),
  });
  const putLines = put.split("\n");
  assert.equal(putLines[1], "PUT");
  assert.match(putLines[4], /^[0-9a-f]{64}$/); // sha256 hex of "{}"
  // sha256("{}") is a fixed value; assert exact to lock the digest.
  assert.equal(putLines[4], "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
});

test("buildCanonical digests the raw query string when present", async () => {
  const canonical = await buildCanonical({
    method: "GET", pathname: "/api/admin/books", search: "?id=42",
    site: "admin", userId: "a", email: "-", role: "-", ts: "1", nonce: "n".repeat(20),
  });
  assert.match(canonical.split("\n")[3], /^[0-9a-f]{64}$/);
});

test("signRelay is deterministic and rejects short keys", async () => {
  const input = {
    method: "GET", pathname: "/api/student/me", search: "",
    site: "student", userId: "u1", email: "-", role: "-", ts: "1700000000", nonce: "n".repeat(20),
  };
  const a = await signRelay(input, KEY);
  const b = await signRelay(input, KEY);
  assert.equal(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url, no padding
  await assert.rejects(() => signRelay(input, "short"), /length >= 32/);
});

test("generateNonce satisfies the verifier pattern", () => {
  for (let i = 0; i < 20; i += 1) {
    assert.match(generateNonce(), NONCE_PATTERN);
  }
});

test("buildRelayHeaders sets all relay headers and omits edge secret when absent", async () => {
  const { headers, signature } = await buildRelayHeaders({
    method: "GET", pathname: "/api/student/me", site: "student",
    userId: "u1", email: "a@b.com", key: KEY, nowMs: 1700000000_000,
  });
  assert.equal(headers["x-a01-relay-site"], "student");
  assert.equal(headers["x-a01-relay-ts"], "1700000000");
  assert.equal(headers["x-a01-relay-user-id"], "u1");
  assert.equal(headers["x-a01-relay-user-email"], "a@b.com");
  assert.equal(headers["x-a01-relay-user-role"], "-");
  assert.equal(headers["x-a01-relay-sig"], signature);
  assert.equal("x-a01-relay-edge-secret" in headers, false);
});

test("buildRelayHeaders includes edge secret only when supplied", async () => {
  const { headers } = await buildRelayHeaders({
    method: "GET", pathname: "/api/student/me", site: "student",
    userId: "u1", email: "-", key: KEY, edgeSecret: "s".repeat(40), nowMs: 1700000000_000,
  });
  assert.equal(headers["x-a01-relay-edge-secret"], "s".repeat(40));
});

// --------------------------------------------------------------------------
// safety
// --------------------------------------------------------------------------

test("assertStagingTarget rejects unset, non-https, credentials and prod hosts", () => {
  assert.throws(() => assertStagingTarget(undefined), SafetyError);
  assert.throws(() => assertStagingTarget(""), SafetyError);
  assert.throws(() => assertStagingTarget("http://staging.example.test"), /https/);
  assert.throws(() => assertStagingTarget("https://user:pw@staging.example.test"), /credentials/);
  for (const host of DEFAULT_DENY_HOSTS) {
    assert.throws(() => assertStagingTarget(`https://${host}`), /production deny-list/);
  }
  // Unknown subdomain of the production domain is also denied.
  assert.throws(() => assertStagingTarget("https://evil.b827262.chatgpt.site"), /production deny-list/);
});

test("assertStagingTarget accepts a legitimate staging origin", () => {
  const result = assertStagingTarget("https://staging.example.test/");
  assert.equal(result.origin, "https://staging.example.test");
  assert.equal(result.host, "staging.example.test");
});

test("denyListFromEnv merges defaults with extras", () => {
  const list = denyListFromEnv({ A01_SYNTHETIC_DENY_HOSTS: "extra.example.test", A01_SYNTHETIC_DENY_SUFFIXES: ".internal" });
  assert.ok(list.denyHosts.includes("extra.example.test"));
  assert.ok(list.denyHosts.includes(DEFAULT_DENY_HOSTS[0]));
  assert.ok(list.denySuffixes.includes(".internal"));
});

test("redactEnv replaces all values; isConfigured reports presence only", () => {
  const redacted = redactEnv({ SECRET: "abc", OTHER: "def" });
  assert.deepEqual(redacted, { SECRET: "<redacted>", OTHER: "<redacted>" });
  assert.equal(isConfigured("x"), true);
  assert.equal(isConfigured("  "), false);
  assert.equal(isConfigured(undefined), false);
});

test("redactString masks long tokens and key=value pairs", () => {
  assert.equal(redactString(`sig=${"a".repeat(50)}`), "sig=<redacted>");
  assert.equal(redactString(`token=${"a".repeat(50)}`), "token=<redacted>");
});

test("maskIp masks IPv4 and IPv6", () => {
  assert.equal(maskIp("203.0.113.9"), "203.0.x.x");
  assert.equal(maskIp("2001:db8:1234::1"), "2001:db8::x");
  assert.equal(maskIp(""), "<masked>");
});

// --------------------------------------------------------------------------
// plan
// --------------------------------------------------------------------------

test("resolveRoute substitutes [id] with an encoded id", () => {
  assert.equal(resolveRoute("/api/admin/books/[id]", "a b"), "/api/admin/books/a%20b");
  assert.equal(resolveRoute("/api/student/me", "x"), "/api/student/me");
});

test("buildPlan produces one row per route x method with the target", () => {
  const student = buildPlan("student", { targetPerPath: 30 });
  assert.equal(student.length, 3);
  assert.equal(planTotal(student), 90);
  assert.equal(nonGetRows(student).length, 1);
  assert.equal(nonGetRows(student)[0].method, "PUT");

  const admin = buildPlan("admin", { targetPerPath: 30 });
  assert.equal(admin.length, 8);
  // Four non-GET path x verb rows per docs/ops/relay-rollout.md §4.4:
  // POST/DELETE /api/admin/books, POST /api/admin/books/upload,
  // DELETE /api/admin/books/[id].
  assert.equal(nonGetRows(admin).length, 4);
  assert.equal(planTotal(admin), 240);
});

test("buildPlan rejects unknown sites and bad targets", () => {
  assert.throws(() => buildPlan("nope"), /unknown site/);
  assert.throws(() => buildPlan("student", { targetPerPath: 0 }), /positive integer/);
});

// --------------------------------------------------------------------------
// manifest
// --------------------------------------------------------------------------

test("hashId is deterministic and hides the raw id", async () => {
  const a = await hashId("book-123");
  const b = await hashId("book-123");
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{16}$/);
  assert.equal(a.includes("book-123"), false);
});

test("recordResult accumulates per-row and total counts", () => {
  const manifest = createManifest({ runId: "r", site: "student", targetHost: "h", targetPerPath: 2 });
  recordResult(manifest, { routeTemplate: "/api/student/me", method: "GET", status: 200, success: true });
  recordResult(manifest, { routeTemplate: "/api/student/me", method: "GET", status: 500, success: false });
  recordResult(manifest, { routeTemplate: "/api/student/me", method: "GET", status: 200, success: true });
  const row = manifest.rows["GET /api/student/me"];
  assert.equal(row.attempted, 3);
  assert.equal(row.success, 2);
  assert.equal(row.error, 1);
  assert.deepEqual(row.statuses, { "200": 2, "500": 1 });
  assert.equal(manifest.totals.attempted, 3);
});

test("summarize reports met_target per row and overall", () => {
  const manifest = createManifest({ runId: "r", site: "student", targetHost: "h", targetPerPath: 2 });
  for (let i = 0; i < 2; i += 1) recordResult(manifest, { routeTemplate: "/api/student/me", method: "GET", status: 200, success: true });
  recordResult(manifest, { routeTemplate: "/api/student/progress", method: "PUT", status: 200, success: true });
  finalizeManifest(manifest);
  const summary = summarize(manifest);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows.find((r) => r.method === "GET").met_target, true);
  assert.equal(summary.rows.find((r) => r.method === "PUT").met_target, false);
  assert.equal(summary.all_targets_met, false);
});

test("writeEvidence writes sanitized manifest and summary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a01-syn-"));
  const manifest = createManifest({ runId: "run-1", site: "student", targetHost: "staging.example.test", targetPerPath: 1 });
  recordResult(manifest, { routeTemplate: "/api/student/me", method: "GET", status: 200, success: true });
  finalizeManifest(manifest);
  const { manifestPath, summaryPath } = await writeEvidence(dir, manifest);
  const written = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(written.run_id, "run-1");
  assert.equal(written.target_host, "staging.example.test");
  assert.ok(JSON.parse(await readFile(summaryPath, "utf8")).totals);
});

// --------------------------------------------------------------------------
// inject
// --------------------------------------------------------------------------

function fakeResponse(status, body = {}) {
  return {
    status,
    clone() { return { json: async () => body }; },
    async json() { return body; },
  };
}

test("checkStopConditions triggers on error rate and 5xx", () => {
  const manifest = createManifest({ runId: "r", site: "student", targetHost: "h", targetPerPath: 1 });
  for (let i = 0; i < 20; i += 1) recordResult(manifest, { routeTemplate: "/x", method: "GET", status: 200, success: true });
  assert.equal(checkStopConditions(manifest, {}), null);
  for (let i = 0; i < 10; i += 1) recordResult(manifest, { routeTemplate: "/x", method: "GET", status: 500, success: false });
  assert.match(checkStopConditions(manifest, { errorRateStop: 0.2, max5xx: 100 }), /error_rate_exceeded/);
  const m5 = createManifest({ runId: "r", site: "student", targetHost: "h", targetPerPath: 1 });
  for (let i = 0; i < 6; i += 1) recordResult(m5, { routeTemplate: "/x", method: "GET", status: 503, success: false });
  assert.match(checkStopConditions(m5, { max5xx: 5, errorRateStop: 1 }), /5xx_exceeded/);
});

test("runInjection reaches target on a healthy fake target and writes counts", async () => {
  const plan = [{ site: "student", routeTemplate: "/api/student/me", route: "/api/student/me", method: "GET", kind: "read", target: 3 }];
  const manifest = createManifest({ runId: "r", site: "student", targetHost: "h", targetPerPath: 3 });
  const calls = [];
  const { summary, stopReason } = await runInjection({
    plan, manifest,
    config: { baseOrigin: "https://staging.example.test", site: "student", key: KEY, userId: "u1", email: "-", rateLimitPerSec: 0 },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return fakeResponse(200); },
    sleep: async () => {},
    now: () => 1700000000_000,
  });
  assert.equal(stopReason, "completed");
  assert.equal(summary.totals.success, 3);
  assert.equal(summary.rows[0].met_target, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers["x-a01-relay-site"], "student");
});

test("runInjection stops on the manual stop file", async () => {
  const plan = [{ site: "student", routeTemplate: "/api/student/me", route: "/api/student/me", method: "GET", kind: "read", target: 10 }];
  const manifest = createManifest({ runId: "r", site: "student", targetHost: "h", targetPerPath: 10 });
  let n = 0;
  const { stopReason } = await runInjection({
    plan, manifest,
    config: { baseOrigin: "https://staging.example.test", site: "student", key: KEY, userId: "u1", email: "-", rateLimitPerSec: 0 },
    fetchImpl: async () => fakeResponse(200),
    sleep: async () => {},
    now: () => 1700000000_000,
    shouldStop: () => { n += 1; return n > 2; },
  });
  assert.equal(stopReason, "manual_stop_file");
  assert.ok(manifest.totals.attempted <= 3);
});

test("runInjection records network failures as errors", async () => {
  const plan = [{ site: "student", routeTemplate: "/api/student/me", route: "/api/student/me", method: "GET", kind: "read", target: 2 }];
  const manifest = createManifest({ runId: "r", site: "student", targetHost: "h", targetPerPath: 2 });
  const { summary } = await runInjection({
    plan, manifest,
    config: { baseOrigin: "https://staging.example.test", site: "student", key: KEY, userId: "u1", email: "-", rateLimitPerSec: 0, errorRateStop: 1, max5xx: 100 },
    fetchImpl: async () => { throw new Error("boom"); },
    sleep: async () => {},
    now: () => 1700000000_000,
  });
  assert.equal(summary.totals.error, summary.totals.attempted);
  assert.equal(summary.totals.success, 0);
});

test("describeReadiness reports booleans only", () => {
  const r = describeReadiness({ baseUrl: "https://x", key: "k", userId: "u", edgeSecret: undefined });
  assert.deepEqual(r, {
    base_url_configured: true,
    signing_key_configured: true,
    identity_configured: true,
    edge_secret_configured: false,
  });
});
