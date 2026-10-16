import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getNormalizedAuth } from "../app/api/auth-helper.ts";
import { countValidEdgeSecrets, gatePrimaryApiRequest, readEdgeGateMode } from "../lib/relay-edge-gate.ts";
import { signRelay } from "../lib/relay-signature.ts";

const STUDENT = "student-edge-secret-for-local-tests-123456";
const STUDENT_PREV = "student-previous-edge-secret-local-test-123456";
const ADMIN = "admin-edge-secret-for-local-tests-12345678";
const primary = { role: "primary", site: "backend", primaryOrigin: null };
const secondary = { role: "secondary", site: "student", primaryOrigin: "https://primary.example.test" };
const misconfigured = { role: "misconfigured", site: null, primaryOrigin: null };
const bindings = {
  A01_RELAY_EDGE_SECRET_STUDENT: STUDENT,
  A01_RELAY_EDGE_SECRET_STUDENT_PREV: STUDENT_PREV,
  A01_RELAY_EDGE_SECRET_ADMIN: ADMIN,
  A01_RELAY_EDGE_MODE: "require",
};

function request(path = "/api/student/me", headers = {}, method = "GET") {
  return new Request(`https://primary.example.test${path}`, { method, headers });
}

function relayHeaders(secret = STUDENT, site = "student") {
  return {
    "x-a01-relay-edge-secret": secret,
    "x-a01-relay-site": site,
    "x-a01-relay-sig": "signature-only-for-local-test",
    "oai-authenticated-user-id": "untrusted-user",
    "oai-authenticated-user-email": "untrusted@example.test",
  };
}

function capture(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args);
  try { return { value: fn(), lines }; }
  finally { console.log = original; }
}

test("edge mode defaults to accept and recognizes require", () => {
  assert.equal(readEdgeGateMode(undefined), "accept");
  assert.equal(readEdgeGateMode("accept"), "accept");
  assert.equal(readEdgeGateMode("  "), "accept");
  assert.equal(readEdgeGateMode(" REQUIRE "), "require");
  assert.equal(readEdgeGateMode("typo"), "require");
});

test("countValidEdgeSecrets reports only counts and cross-site distinctness", () => {
  const SHORT = "x".repeat(31);
  const SHARED = "shared-edge-secret-for-local-tests-123456789";

  assert.deepEqual(countValidEdgeSecrets({}), { student: 0, admin: 0, distinct: true });
  assert.deepEqual(
    countValidEdgeSecrets({ A01_RELAY_EDGE_SECRET_STUDENT: STUDENT, A01_RELAY_EDGE_SECRET_ADMIN: ADMIN }),
    { student: 1, admin: 1, distinct: true },
  );
  assert.deepEqual(countValidEdgeSecrets(bindings), { student: 2, admin: 1, distinct: true });
  assert.deepEqual(
    countValidEdgeSecrets({ A01_RELAY_EDGE_SECRET_STUDENT: SHORT, A01_RELAY_EDGE_SECRET_ADMIN: ADMIN }),
    { student: 0, admin: 1, distinct: true },
  );
  assert.deepEqual(
    countValidEdgeSecrets({ A01_RELAY_EDGE_SECRET_STUDENT: SHARED, A01_RELAY_EDGE_SECRET_ADMIN: SHARED }),
    { student: 0, admin: 0, distinct: false },
  );
  // The result is counts/booleans only; it must not carry any secret material.
  const serialized = JSON.stringify(countValidEdgeSecrets(bindings));
  for (const secret of [STUDENT, STUDENT_PREV, ADMIN]) {
    assert.equal(serialized.includes(secret), false, `counts leaked "${secret}"`);
  }
});

test("matching current and previous site secrets preserve relay headers but never expose the edge secret downstream", () => {
  for (const secret of [STUDENT, STUDENT_PREV]) {
    const source = request("/api/student/me", relayHeaders(secret));
    const { value, lines } = capture(() => gatePrimaryApiRequest(source, bindings, primary));
    assert.ok(value instanceof Request);
    assert.equal(value.headers.get("x-a01-relay-sig"), "signature-only-for-local-test");
    assert.equal(value.headers.get("oai-authenticated-user-id"), "untrusted-user");
    assert.equal(value.headers.get("x-a01-relay-edge-secret"), null);
    assert.equal(lines.length, 0);
  }
});

test("missing or wrong edge secret is silently stripped before strict authentication", async () => {
  for (const secret of [null, "wrong-edge-secret-1234567890123456789"]) {
    const headers = relayHeaders(secret ?? STUDENT);
    if (secret === null) delete headers["x-a01-relay-edge-secret"];
    const { value, lines } = capture(() => gatePrimaryApiRequest(request("/api/student/me", headers), bindings, primary));
    assert.ok(value instanceof Request);
    assert.equal(value.headers.get("x-a01-relay-site"), null);
    assert.equal(value.headers.get("x-a01-relay-sig"), null);
    assert.equal(value.headers.get("oai-authenticated-user-id"), null);
    assert.equal(value.headers.get("oai-authenticated-user-email"), null);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0][0]), { evt: "relay.probe", mode: "require", site: "student" });
    const savedMode = Object.getOwnPropertyDescriptor(globalThis, "A01_RELAY_MODE");
    const savedRole = Object.getOwnPropertyDescriptor(globalThis, "SITE_ROLE");
    try {
      globalThis.A01_RELAY_MODE = "strict";
      globalThis.SITE_ROLE = "primary";
      const auth = await getNormalizedAuth(value);
      assert.equal(auth.role, "guest");
      assert.equal(auth.relayRejected, undefined, "untrusted edge credentials cannot become relay invalid");
    } finally {
      if (savedMode) Object.defineProperty(globalThis, "A01_RELAY_MODE", savedMode);
      else delete globalThis.A01_RELAY_MODE;
      if (savedRole) Object.defineProperty(globalThis, "SITE_ROLE", savedRole);
      else delete globalThis.SITE_ROLE;
    }
  }
});

test("accept mode records probes and preserves legacy relay verification input", () => {
  for (const secret of [null, "wrong-edge-secret"]) {
    const headers = relayHeaders(secret ?? STUDENT);
    if (secret === null) delete headers["x-a01-relay-edge-secret"];
    const { value, lines } = capture(() => gatePrimaryApiRequest(request("/api/student/me", headers),
      { ...bindings, A01_RELAY_EDGE_MODE: "accept" }, primary));
    assert.ok(value instanceof Request);
    assert.equal(value.headers.get("x-a01-relay-site"), "student");
    assert.equal(value.headers.get("oai-authenticated-user-id"), "untrusted-user");
    assert.equal(value.headers.get("x-a01-relay-edge-secret"), null);
    assert.deepEqual(JSON.parse(lines[0][0]), { evt: "relay.probe", mode: "accept", site: "student" });
  }
});

test("a secret from the wrong site or shared across sites is not trusted", () => {
  for (const config of [bindings, { ...bindings, A01_RELAY_EDGE_SECRET_ADMIN: STUDENT }]) {
    const source = request("/api/student/books", relayHeaders(ADMIN));
    const result = gatePrimaryApiRequest(source, config, primary);
    assert.ok(result instanceof Request);
    assert.equal(result.headers.get("x-a01-relay-site"), null);
  }
  const shared = gatePrimaryApiRequest(request("/api/student/books", relayHeaders()),
    { ...bindings, A01_RELAY_EDGE_SECRET_ADMIN: STUDENT }, primary);
  assert.equal(shared.headers.get("x-a01-relay-site"), null);
});

test("matching edge secret with invalid relay signature still fails as relay invalid", async () => {
  const key = "student-signature-key-for-local-test-123456";
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = "edge-test-nonce-1234567890";
  const sig = await signRelay({ method: "GET", pathname: "/api/student/me", search: "", site: "student",
    userId: "user-1", email: "user@example.test", role: "-", ts, nonce }, key);
  const source = request("/api/student/me", {
    "x-a01-relay-edge-secret": STUDENT, "x-a01-relay-site": "student", "x-a01-relay-ts": ts,
    "x-a01-relay-nonce": nonce, "x-a01-relay-user-id": "user-1",
    "x-a01-relay-user-email": "user@example.test", "x-a01-relay-user-role": "-",
    "x-a01-relay-sig": `${sig.startsWith("a") ? "b" : "a"}${sig.slice(1)}`,
  });
  const passed = gatePrimaryApiRequest(source, bindings, primary);
  assert.ok(passed instanceof Request);
  const saved = ["A01_RELAY_MODE", "A01_RELAY_KEY_STUDENT", "A01_RELAY_KEY_ADMIN", "SITE_ROLE"]
    .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  try {
    Object.assign(globalThis, { A01_RELAY_MODE: "strict", A01_RELAY_KEY_STUDENT: key,
      A01_RELAY_KEY_ADMIN: "admin-signature-key-for-local-test-123456", SITE_ROLE: "primary" });
    const auth = await getNormalizedAuth(passed);
    assert.equal(auth.relayRejected, true);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

test("the check covers public GET APIs while health is exempt", () => {
  for (const path of ["/api/student/books", "/api/student/books/123", "/api/admin/books", "/api/admin/books/123"]) {
    const site = path.startsWith("/api/admin") ? "admin" : "student";
    const result = gatePrimaryApiRequest(request(path, relayHeaders("wrong", site)), bindings, primary);
    assert.ok(result instanceof Request);
    assert.equal(result.headers.get("oai-authenticated-user-id"), null, path);
  }
  const health = request("/API//HEALTH/", relayHeaders("wrong"));
  assert.equal(gatePrimaryApiRequest(health, bindings, primary), health);
});

test("existing 400/503/404 topology decisions precede the edge check; secondary remains unchanged", () => {
  const headers = relayHeaders("wrong");
  const cases = [
    ["/api/student%2f..%2fadmin", primary, 400],
    ["/api/student/me", misconfigured, 503],
    ["/api/admin/books", secondary, 404],
  ];
  for (const [path, declared, status] of cases) {
    const { value, lines } = capture(() => gatePrimaryApiRequest(request(path, headers), bindings, declared));
    assert.ok(value instanceof Response);
    assert.equal(value.status, status);
    assert.equal(lines.length, 0);
  }
  const source = request("/api/student/me", headers);
  assert.equal(gatePrimaryApiRequest(source, bindings, secondary), source);
});

test("probe logging never includes secret, identity, IP, path, or query", () => {
  const source = request("/api/student/me/private-id?token=private-query", {
    ...relayHeaders("private-secret-value"), "cf-connecting-ip": "192.0.2.1",
  });
  const { lines } = capture(() => gatePrimaryApiRequest(source, bindings, primary));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0][0])), ["evt", "mode", "site"]);
  for (const forbidden of ["private-secret-value", "untrusted-user", "192.0.2.1", "private-id", "private-query"])
    assert.ok(!lines[0][0].includes(forbidden));
});

test("no secret values or binding additions enter deploy targets", () => {
  const targets = readFileSync(new URL("../deploy/targets.json", import.meta.url), "utf8");
  for (const value of [STUDENT, STUDENT_PREV, ADMIN, "A01_RELAY_EDGE_SECRET_STUDENT", "A01_RELAY_EDGE_SECRET_ADMIN"])
    assert.ok(!targets.includes(value));
});
