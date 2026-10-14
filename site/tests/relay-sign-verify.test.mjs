import assert from "node:assert/strict";
import test from "node:test";
import { checkTimestamp, parseRelayHeaders, signRelay, verifyRelay } from "../lib/relay-signature.ts";

const vector = {
  method: "post",
  pathname: "/API//V1/Resource/",
  search: "?b=2&a=1",
  body: new TextEncoder().encode('{"x":1}'),
  site: "student",
  userId: "user-123",
  email: " Alice@Example.COM ",
  role: "student",
  ts: "1700000000",
  nonce: "0123456789abcdef",
};
const key = "test-secret";
const signature = "Au_8riTHa6gWu5zPJnwifQa66ip15h4zfZ3XcbFSW0A";

function requiredHeaders(overrides = {}) {
  return new Headers({
    "x-a01-relay-site": "student",
    "x-a01-relay-ts": "1700000000",
    "x-a01-relay-nonce": "0123456789abcdef",
    "x-a01-relay-sig": signature,
    ...overrides,
  });
}

test("verifies the fixed vector and rejects a wrong key", async () => {
  assert.equal(await verifyRelay(vector, signature, [key]), true);
  assert.equal(await verifyRelay(vector, signature, ["wrong-key"]), false);
});

test("every canonical input field is covered by the signature", async () => {
  const changed = [
    ["method", (input) => ({ ...input, method: "PATCH" })],
    ["path", (input) => ({ ...input, pathname: "/different/path" })],
    ["query", (input) => ({ ...input, search: "?b=3&a=1" })],
    ["body", (input) => ({ ...input, body: new TextEncoder().encode('{"x":2}') })],
    ["user-id", (input) => ({ ...input, userId: "user-456" })],
    ["email", (input) => ({ ...input, email: "other@example.com" })],
    ["role", (input) => ({ ...input, role: "admin" })],
    ["site", (input) => ({ ...input, site: "admin" })],
    ["ts", (input) => ({ ...input, ts: "1700000001" })],
    ["nonce", (input) => ({ ...input, nonce: "abcdef0123456789" })],
  ];
  for (const [field, mutate] of changed) {
    assert.equal(await verifyRelay(mutate(vector), signature, [key]), false, `${field} must be signed`);
  }
});

test("tries all rotation keys and accepts signatures from either key", async () => {
  const newer = "relay-key-new";
  const older = "relay-key-old";
  const newSignature = await signRelay(vector, newer);
  const oldSignature = await signRelay(vector, older);
  assert.equal(await verifyRelay(vector, newSignature, [newer, older]), true);
  assert.equal(await verifyRelay(vector, oldSignature, [newer, older]), true);
});

test("timestamp checks accept both skew boundaries and reject one second beyond", () => {
  const now = 1_700_000_000;
  for (const seconds of [299, 300]) {
    assert.equal(checkTimestamp(String(now + seconds), now), true);
    assert.equal(checkTimestamp(String(now - seconds), now), true);
  }
  assert.equal(checkTimestamp(String(now + 301), now), false);
  assert.equal(checkTimestamp(String(now - 301), now), false);
  assert.equal(checkTimestamp("not-a-timestamp", now), false);
});

test("invalid nonce formats and newline-bearing fields are rejected without a reason", async () => {
  const invalidNonces = ["short", "not/valid-nonce____", "a".repeat(129)];
  for (const nonce of invalidNonces) {
    assert.deepEqual(await signRelay({ ...vector, nonce }, key), { ok: false });
    assert.equal(await verifyRelay({ ...vector, nonce }, signature, [key]), false);
  }

  const newlineCases = [
    { method: "POST\n" },
    { pathname: "/api/\nresource" },
    { search: "?q=one\ntwo" },
    { site: "student\n" },
    { userId: "user\n123" },
    { email: "alice\n@example.com" },
    { role: "student\n" },
    { ts: "1700000000\n" },
    { nonce: "0123456789abcde\nf" },
  ];
  for (const change of newlineCases) {
    assert.deepEqual(await signRelay({ ...vector, ...change }, key), { ok: false });
  }
});

test("relay header parser rejects repeated, comma-multi-value, and missing required headers", () => {
  const valid = parseRelayHeaders(requiredHeaders({
    "x-a01-relay-user-id": "user-123",
    "x-a01-relay-user-email": "Alice@Example.com",
    "x-a01-relay-user-role": "student",
  }));
  assert.deepEqual(valid, {
    ok: true,
    site: "student",
    ts: "1700000000",
    nonce: "0123456789abcdef",
    userId: "user-123",
    email: "Alice@Example.com",
    role: "student",
    signature,
  });

  const repeated = requiredHeaders();
  repeated.append("x-a01-relay-ts", "1700000000");
  assert.deepEqual(parseRelayHeaders(repeated), { ok: false });
  assert.deepEqual(parseRelayHeaders(requiredHeaders({ "x-a01-relay-user-id": "one,two" })), { ok: false });
  assert.deepEqual(parseRelayHeaders(requiredHeaders({ "x-a01-relay-site": "student,admin" })), { ok: false });

  const missing = requiredHeaders();
  missing.delete("x-a01-relay-sig");
  assert.deepEqual(parseRelayHeaders(missing), { ok: false });
  assert.deepEqual(parseRelayHeaders({
    "x-a01-relay-site": "student",
    "x-a01-relay-ts": "1700000000",
    "x-a01-relay-nonce": "0123456789abcdef",
    "x-a01-relay-sig": signature,
    "X-A01-RELAY-TS": "1700000000",
  }), { ok: false });
  assert.deepEqual(parseRelayHeaders(requiredHeaders({ "x-a01-relay-user-role": "owner" })), { ok: false });
});
