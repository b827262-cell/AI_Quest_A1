/**
 * Unit tests for the synthetic driver's canonical relay signer.
 *
 * Run: node --test scripts/a01-synthetic/signer.test.mjs
 *
 * The known-answer vector below was produced independently by
 * `site/lib/relay-signature.ts` (`signRelay`), so it pins the mirror to the
 * real implementation. When that module is importable, a cross-check test
 * signs the same input with both and compares.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCanonicalString, buildRelayHeaders, signRelay } from "./signer.mjs";

const KEY = "unit-test-key-0123456789";
const INPUT = {
  method: "PUT",
  pathname: "/api/student/progress",
  search: "",
  body: '{"a":1}',
  site: "student",
  userId: "u1",
  email: "Test@Example.com",
  role: "student",
  ts: "1700000000",
  nonce: "abcdefghij0123456789",
};

const KAT_CANONICAL = "a01-relay-v1\nPUT\n/api/student/progress\n-\n015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862\nstudent\nu1\ntest@example.com\nstudent\n1700000000\nabcdefghij0123456789";
const KAT_SIGNATURE = "9Z2O-JXLiJaBwEPtKLo2wdLmb-Z1Wk2R3Pp6qLY4gcA";

test("buildCanonicalString matches the known-answer vector", () => {
  assert.equal(buildCanonicalString(INPUT), KAT_CANONICAL);
});

test("signRelay matches the known-answer vector", () => {
  assert.equal(signRelay(INPUT, KEY), KAT_SIGNATURE);
});

test("buildRelayHeaders emits the full x-a01-relay-* set", () => {
  const headers = buildRelayHeaders(INPUT, KEY);
  assert.deepEqual(Object.keys(headers).sort(), [
    "x-a01-relay-nonce",
    "x-a01-relay-sig",
    "x-a01-relay-site",
    "x-a01-relay-ts",
    "x-a01-relay-user-email",
    "x-a01-relay-user-id",
    "x-a01-relay-user-role",
  ]);
  assert.equal(headers["x-a01-relay-sig"], KAT_SIGNATURE);
  assert.equal(headers["x-a01-relay-user-email"], "test@example.com");
});

test("GET/HEAD sign with an empty body digest and non-GET with a body digest", () => {
  const get = buildCanonicalString({ ...INPUT, method: "GET", body: undefined });
  const head = buildCanonicalString({ ...INPUT, method: "HEAD", body: undefined });
  assert.equal(get, head.replace("HEAD", "GET"));
  assert.ok(get.split("\n")[4] === "-");
  assert.notEqual(signRelay({ ...INPUT, method: "GET", body: undefined }, KEY), signRelay(INPUT, KEY));
});

test("query strings are covered by the signature", () => {
  const withQuery = signRelay({ ...INPUT, search: "page=2" }, KEY);
  assert.notEqual(withQuery, signRelay(INPUT, KEY));
});

test("invalid inputs fail closed with null", () => {
  assert.equal(signRelay({ ...INPUT, site: "other" }, KEY), null);
  assert.equal(signRelay({ ...INPUT, nonce: "short" }, KEY), null);
  assert.equal(signRelay(INPUT, ""), null);
  assert.equal(buildRelayHeaders(INPUT, ""), null);
});

test("cross-check against site/lib/relay-signature.ts when importable", async () => {
  let site;
  try {
    site = await import("../../site/lib/relay-signature.ts");
  } catch {
    return; // module or TS loader unavailable in this environment
  }
  const reference = await site.signRelay(INPUT, KEY);
  assert.equal(signRelay(INPUT, KEY), reference);
});
