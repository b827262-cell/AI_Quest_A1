import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { getNormalizedAuth } from "../app/api/auth-helper.ts";
import { gateApiRequest } from "../app/api/backend-client.ts";
import { GET as studentMe } from "../app/api/student/me/route.ts";
import { GET as health } from "../app/api/health/route.ts";
import { readRelayMode, relayKeyCount, verifyIncomingRelay } from "../lib/relay-verification.ts";
import { signRelay } from "../lib/relay-signature.ts";

const STUDENT_KEY = "student-local-test-key-32-characters-long";
const STUDENT_PREV = "student-previous-key-32-characters-long";
const ADMIN_KEY = "admin-local-test-key-32-characters-long--";
const KEYS = ["A01_RELAY_MODE", "A01_RELAY_KEY_STUDENT", "A01_RELAY_KEY_STUDENT_PREV", "A01_RELAY_KEY_ADMIN", "A01_RELAY_KEY_ADMIN_PREV", "ADMIN_EMAILS", "DB", "SITE_ROLE", "SITE_NAME", "PRIMARY_ORIGIN", "__env__"];
let nonceNumber = 0;

function fixtureDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../drizzle/", import.meta.url);
  for (const filename of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(filename, dir), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  const d1 = { prepare(sql) { const statement = sqlite.prepare(sql); return {
    bind(...params) { this.params = params; return this; },
    async all() { return { results: statement.all(...(this.params ?? [])) }; },
    async run() { statement.run(...(this.params ?? [])); return { success: true, meta: {} }; },
    async raw() { return statement.all(...(this.params ?? [])).map((row) => Object.values(row)); },
  }; } };
  return { sqlite, d1 };
}

async function withRuntime(bindings, fn) {
  const saved = KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const { sqlite, d1 } = fixtureDb();
  try {
    for (const key of KEYS) delete globalThis[key];
    Object.assign(globalThis, { A01_RELAY_MODE: "strict", A01_RELAY_KEY_STUDENT: STUDENT_KEY,
      A01_RELAY_KEY_ADMIN: ADMIN_KEY, ADMIN_EMAILS: "owner@example.test", DB: d1,
      SITE_ROLE: "primary", SITE_NAME: "backend", ...bindings });
    await fn(sqlite);
  } finally {
    sqlite.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

async function signedRequest({ method = "GET", pathname = "/api/student/me", search = "?a=1", body,
  site = "student", userId = "user-123", email = "Alice@Example.TEST", role = "-",
  ts = String(Math.floor(Date.now() / 1000)), nonce = `nonce-${String(++nonceNumber).padStart(20, "0")}`,
  key = site === "student" ? STUDENT_KEY : ADMIN_KEY, extra = {} } = {}) {
  const signature = await signRelay({ method, pathname, search, body, site, userId, email, role, ts, nonce }, key);
  assert.equal(typeof signature, "string");
  const headers = { "x-a01-relay-site": site, "x-a01-relay-ts": ts,
    "x-a01-relay-nonce": nonce, "x-a01-relay-user-id": userId,
    "x-a01-relay-user-email": email, "x-a01-relay-user-role": role,
    "x-a01-relay-sig": signature, ...extra };
  const request = new Request(`https://primary.example.test${pathname}${search}`, { method, headers, body });
  return { request, headers, signature };
}
const direct = (pathname, headers = {}) => new Request(`https://primary.example.test${pathname}`, { headers });

for (const [label, value, expected] of [
  ["unset", undefined, "off"], ["null", null, "off"], ["empty", "", "off"],
  ["whitespace", "  ", "off"], ["off", "off", "off"], ["spaced uppercase off", " OFF ", "off"],
  ["transitional", "transitional", "transitional"], ["spaced mixed-case transitional", " Transitional ", "transitional"],
  ["strict", "strict", "strict"], ["uppercase strict", "STRICT", "strict"],
  ["invalid", "typo", "strict"], ["trueish", "trueish", "strict"], ["non-string", true, "strict"],
]) {
  test(`relay mode ${label} resolves to ${expected}`, async () => {
    await withRuntime({ A01_RELAY_MODE: value }, async () => assert.equal(readRelayMode(), expected));
  });
}

test("strict ignores unsigned oai identity and local bypass credentials", async () => {
  await withRuntime({}, async () => {
    const auth = await getNormalizedAuth(direct("/api/student/me", {
      "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.test",
      authorization: "Bearer 3wdv7mrWFW85fy0Sj7p2mXRBp84v4LlVigJHGM10siw",
      "x-admin-key": "synthetic-admin-secret" }));
    assert.equal(auth.isAuthenticated, false);
    assert.equal(auth.role, "guest");
    assert.equal(auth.isDemo, false);
  });
});

test("off and transitional preserve unsigned oai identity", async () => {
  for (const mode of ["off", "transitional"]) {
    await withRuntime({ A01_RELAY_MODE: mode }, async () => {
      const auth = await getNormalizedAuth(direct("/api/student/me", {
        "oai-authenticated-user-id": "legacy", "oai-authenticated-user-email": "legacy@example.test" }));
      assert.equal(auth.userId, "legacy");
    });
  }
});

test("valid signed student identity overrides forged oai and preserves canonical email", async () => {
  await withRuntime({}, async () => {
    const { request } = await signedRequest({ extra: {
      "oai-authenticated-user-id": "forged", "oai-authenticated-user-email": "owner@example.test",
      "oai-authenticated-user-role": "admin", "oai-authenticated-user-full-name": "forged name" } });
    const auth = await getNormalizedAuth(request);
    assert.equal(auth.userId, "user-123");
    assert.equal(auth.email, "alice@example.test");
    assert.equal(auth.role, "student");
    assert.equal(auth.displayName, "alice@example.test");
  });
});

test("one POST Request reuses normalized auth without replaying its nonce; a new Request is rejected", async () => {
  await withRuntime({}, async (sqlite) => {
    const signed = await signedRequest({ method: "POST", pathname: "/api/student/progress", body: "progress" });
    const firstPromise = getNormalizedAuth(signed.request);
    assert.strictEqual(getNormalizedAuth(signed.request), firstPromise);
    const first = await firstPromise;
    assert.equal(first.isAuthenticated, true);
    assert.equal(first.userId, "user-123");
    assert.strictEqual(await getNormalizedAuth(signed.request), first);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relay_nonces").get().n, 1);

    const replay = new Request(signed.request.url, { method: "POST", headers: signed.headers, body: "progress" });
    const replayAuth = await getNormalizedAuth(replay);
    assert.equal(replayAuth.isAuthenticated, false);
    assert.equal(replayAuth.relayRejected, true);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relay_nonces").get().n, 1);
  });
});

test("one invalid Request caches its rejected auth result", async () => {
  await withRuntime({}, async () => {
    const signed = await signedRequest({ extra: { "x-a01-relay-sig": "invalid" } });
    const firstPromise = getNormalizedAuth(signed.request);
    assert.strictEqual(getNormalizedAuth(signed.request), firstPromise);
    const first = await firstPromise;
    assert.equal(first.relayRejected, true);
    assert.equal(first.isAuthenticated, false);
    assert.strictEqual(await getNormalizedAuth(signed.request), first);
  });
});

test("signed admin role is audit-only; ADMIN_EMAILS alone decides privilege", async () => {
  await withRuntime({}, async () => {
    const imposter = await signedRequest({ site: "admin", pathname: "/api/admin/auth/me", email: "imposter@example.test", role: "admin" });
    const allowed = await signedRequest({ site: "admin", pathname: "/api/admin/auth/me", email: "owner@example.test", role: "-" });
    assert.equal((await getNormalizedAuth(imposter.request)).role, "student");
    assert.equal((await getNormalizedAuth(allowed.request)).role, "admin");
  });
});

for (const [label, change] of [
  ["path", { pathname: "/api/student/other" }],
  ["query", { search: "?a=2" }],
  ["site", { headers: { "x-a01-relay-site": "admin" } }],
  ["id", { headers: { "x-a01-relay-user-id": "different" } }],
  ["email", { headers: { "x-a01-relay-user-email": "other@example.test" } }],
  ["role", { headers: { "x-a01-relay-user-role": "admin" } }],
  ["nonce", { headers: { "x-a01-relay-nonce": "different-nonce-123456" } }],
  ["signature", { headers: { "x-a01-relay-sig": "invalid" } }],
]) {
  test(`tampered ${label} returns the same 401`, async () => {
    await withRuntime({}, async () => {
      const { request } = await signedRequest();
      const changed = new Request(new URL(request.url), { headers: { ...Object.fromEntries(request.headers), ...change.headers } });
      const url = new URL(request.url);
      if (change.pathname) url.pathname = change.pathname;
      if (change.search) url.search = change.search;
      const finalRequest = new Request(url, { headers: changed.headers });
      const response = await studentMe(finalRequest);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    });
  });
}

test("body mutation, distinct-request replay and expired timestamps fail; one Request reuses verification", async () => {
  await withRuntime({}, async (sqlite) => {
    const body = new Uint8Array([0, 255, 10, 13]);
    const signed = await signedRequest({ method: "POST", pathname: "/api/student/progress", body });
    assert.equal((await verifyIncomingRelay(signed.request)).status, "valid");
    assert.equal(signed.request.bodyUsed, false);
    assert.equal((await verifyIncomingRelay(signed.request)).status, "valid");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relay_nonces").get().n, 1);
    const replay = new Request(signed.request.url, { method: "POST", headers: signed.headers, body });
    assert.equal((await verifyIncomingRelay(replay)).status, "invalid");
    const mutated = new Request(signed.request.url, { method: "POST", headers: signed.headers, body: new Uint8Array([1, 255, 10, 13]) });
    assert.equal((await verifyIncomingRelay(mutated)).status, "invalid");
    const old = await signedRequest({ ts: String(Math.floor(Date.now() / 1000) - 301) });
    assert.equal((await verifyIncomingRelay(old.request)).status, "invalid");
    const future = await signedRequest({ ts: String(Math.floor(Date.now() / 1000) + 301) });
    assert.equal((await verifyIncomingRelay(future.request)).status, "invalid");
    const get = await signedRequest();
    assert.equal((await verifyIncomingRelay(get.request)).status, "valid");
    assert.equal((await verifyIncomingRelay(get.request)).status, "valid");
  });
});

test("site-scoped keys, missing key and previous key rotation", async () => {
  await withRuntime({ A01_RELAY_KEY_STUDENT_PREV: STUDENT_PREV }, async () => {
    const previous = await signedRequest({ key: STUDENT_PREV });
    assert.equal((await verifyIncomingRelay(previous.request)).status, "valid");
    const wrongKey = await signedRequest({ key: ADMIN_KEY });
    assert.equal((await verifyIncomingRelay(wrongKey.request)).status, "invalid");
    const wrongSite = await signedRequest({ site: "admin", pathname: "/api/student/me" });
    assert.equal((await verifyIncomingRelay(wrongSite.request)).status, "invalid");
    assert.equal(relayKeyCount(), 3);
  });
  await withRuntime({ A01_RELAY_KEY_ADMIN: STUDENT_KEY }, async () => {
    const signed = await signedRequest();
    assert.equal((await verifyIncomingRelay(signed.request)).status, "invalid");
    assert.equal(relayKeyCount(), 0);
  });
  await withRuntime({ A01_RELAY_KEY_STUDENT: undefined }, async () => {
    const signed = await signedRequest();
    assert.equal((await verifyIncomingRelay(signed.request)).status, "invalid");
  });
});

test("malformed, incomplete and comma-coalesced relay headers get uniform 401", async () => {
  await withRuntime({}, async () => {
    const { request } = await signedRequest();
    for (const headers of [
      { "x-a01-relay-sig": "a,b" },
      { "x-a01-relay-user-id": "a,b" },
      { "x-a01-relay-site": "unknown" },
      { "x-a01-relay-ts": "wrong" },
    ]) {
      const response = await studentMe(new Request(request.url, { headers: { ...Object.fromEntries(request.headers), ...headers } }));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
    const incomplete = await studentMe(direct("/api/student/me", { "x-a01-relay-sig": "forged" }));
    assert.equal(incomplete.status, 401);
    assert.deepEqual(await incomplete.json(), { error: "unauthorized" });
    const duplicate = new Headers(request.headers);
    duplicate.append("x-a01-relay-sig", "forged");
    assert.equal((await verifyIncomingRelay(new Request(request.url, { headers: duplicate }))).status, "invalid");
  });
});

test("signed anonymous identity remains a guest and signed partial identity is rejected", async () => {
  await withRuntime({}, async () => {
    const anonymous = await signedRequest({ userId: "-", email: "-" });
    assert.equal((await getNormalizedAuth(anonymous.request)).isAuthenticated, false);
    const partial = await signedRequest({ userId: "-", email: "alice@example.test" });
    assert.equal((await verifyIncomingRelay(partial.request)).status, "invalid");
    const malformed = await signedRequest({ email: "bad-email" });
    assert.equal((await verifyIncomingRelay(malformed.request)).status, "invalid");
  });
});

test("upload body over 21 MiB is rejected without consuming the original request", async () => {
  await withRuntime({}, async () => {
    const { headers } = await signedRequest({ method: "POST", pathname: "/api/admin/books/upload", site: "admin", body: "small" });
    const tooLarge = new Uint8Array(21 * 1024 * 1024 + 1);
    const req = new Request("https://primary.example.test/api/admin/books/upload", { method: "POST", headers, body: tooLarge });
    assert.equal((await verifyIncomingRelay(req)).status, "invalid");
    assert.equal(req.bodyUsed, false);
  });
});

test("health reports mode, valid key count and relay status without key material", async () => {
  await withRuntime({ A01_RELAY_KEY_STUDENT_PREV: STUDENT_PREV }, async () => {
    const plain = await (await health(direct("/api/health"))).json();
    assert.equal(plain.relayMode, "strict");
    assert.equal(plain.relayKeys, 3);
    assert.equal(plain.relaySeen, "none");
    const signed = await signedRequest({ pathname: "/api/health", search: "" });
    const valid = await (await health(signed.request)).json();
    assert.equal(valid.relaySeen, "valid");
    const invalid = await (await health(direct("/api/health", { "x-a01-relay-sig": "bad" }))).json();
    assert.equal(invalid.relaySeen, "invalid");
    for (const body of [plain, valid, invalid]) {
      const json = JSON.stringify(body);
      for (const secret of [STUDENT_KEY, STUDENT_PREV, ADMIN_KEY, "Alice@Example.TEST", "user-123"])
        assert.equal(json.includes(secret), false);
    }
  });
});

test("migration creates relay_nonces primary key and cleanup permits reuse after expiry", async () => {
  await withRuntime({}, async (sqlite) => {
    const columns = sqlite.prepare("PRAGMA table_info(relay_nonces)").all();
    assert.deepEqual(columns.map((column) => column.name), ["nonce", "expires_at"]);
    assert.equal(columns[0].pk, 1);
    sqlite.prepare("INSERT INTO relay_nonces (nonce, expires_at) VALUES (?, ?)").run("old-nonce", 0);
    const signed = await signedRequest({ method: "POST", pathname: "/api/student/progress", body: "x" });
    assert.equal((await verifyIncomingRelay(signed.request)).status, "valid");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relay_nonces WHERE nonce = 'old-nonce'").get().n, 0);
  });
});


test("verified POST leaves its original bytes available to the route", async () => {
  await withRuntime({}, async () => {
    const bytes = new Uint8Array([0, 255, 65, 10, 13]);
    const { request } = await signedRequest({ method: "POST", pathname: "/api/student/progress", body: bytes });
    const auth = await getNormalizedAuth(request);
    assert.equal(auth.userId, "user-123");
    assert.equal(request.bodyUsed, false);
    assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
  });
});

test("built primary Worker injects mode and keys for strict API handling", async () => {
  const { default: worker } = await import(new URL("../dist/server/index.js?relay-primary=1", import.meta.url).href);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const ASSETS = { fetch: async () => new Response("missing", { status: 404 }) };
  await withRuntime({}, async () => {
    const env = { ASSETS, DB: globalThis.DB, SITE_ROLE: "primary", SITE_NAME: "backend",
      A01_RELAY_MODE: "strict", A01_RELAY_KEY_STUDENT: STUDENT_KEY,
      A01_RELAY_KEY_ADMIN: ADMIN_KEY, ADMIN_EMAILS: "owner@example.test" };
    const signed = await signedRequest({ search: "" });
    const authenticated = await worker.fetch(signed.request, env, ctx);
    assert.equal(authenticated.status, 200);
    const body = await authenticated.json();
    assert.equal(body.authenticated, true);
    assert.equal(body.user.id, "user-123");
    const unsigned = await worker.fetch(direct("/api/student/me", {
      "oai-authenticated-user-id": "forged", "oai-authenticated-user-email": "owner@example.test"
    }), env, ctx);
    assert.equal((await unsigned.json()).authenticated, false);
    const healthResponse = await worker.fetch(direct("/api/health"), env, ctx);
    const healthBody = await healthResponse.json();
    assert.equal(healthBody.relayMode, "strict");
    assert.equal(healthBody.relayKeys, 2);
  });
});


test("signer target and verifier URL keep path case, slash and escapes aligned", async () => {
  await withRuntime({}, async () => {
    for (const pathname of [
      "/api/student/books/BookA/content", "/api/student/books/BookA/content/",
      "/api/student/books/A%2FB/content", "/api/student/books/A%2eB/content",
    ]) {
      const target = new URL(pathname, "https://primary.example.test");
      const signed = await signedRequest({ pathname: target.pathname, search: "" });
      assert.equal(new URL(signed.request.url).pathname, target.pathname);
      assert.equal((await verifyIncomingRelay(signed.request)).status, "valid");
    }
    const upper = await signedRequest({ pathname: "/api/student/books/BookA/content", search: "" });
    const lower = new URL(upper.request.url);
    lower.pathname = lower.pathname.replace("BookA", "booka");
    assert.equal((await verifyIncomingRelay(new Request(lower, { headers: upper.headers }))).status, "invalid");
    for (const path of ["/api/student/books/A%2FB/content", "/api/student/books/A%2eB/content"]) {
      const gate = gateApiRequest(path, { role: "primary", site: "backend", primaryOrigin: null });
      assert.equal(gate?.status, 400, "the Worker gate rejects ambiguous escapes before routing");
    }
  });
});
