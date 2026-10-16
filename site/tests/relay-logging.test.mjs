import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { getNormalizedAuth } from "../app/api/auth-helper.ts";
import { gateApiRequest } from "../app/api/backend-client.ts";
import { GET as studentMe } from "../app/api/student/me/route.ts";
import { GET as studentProgress, PUT as putProgress } from "../app/api/student/progress/route.ts";
import { GET as adminAuth } from "../app/api/admin/auth/me/route.ts";
import { GET as adminOverview } from "../app/api/admin/overview/route.ts";
import { POST as adminUpload } from "../app/api/admin/books/upload/route.ts";
import { GET as health } from "../app/api/health/route.ts";
import { OPTIONS as internalRunOptions } from "../app/api/internal/sync/runs/route.ts";
import { verifyIncomingRelay } from "../lib/relay-verification.ts";
import { signRelay } from "../lib/relay-signature.ts";

const STUDENT_KEY = "student-local-test-key-32-characters-long";
const ADMIN_KEY = "admin-local-test-key-32-characters-long--";
const KEYS = ["A01_RELAY_MODE", "A01_RELAY_KEY_STUDENT", "A01_RELAY_KEY_ADMIN", "ADMIN_EMAILS", "DB", "SITE_ROLE", "SITE_NAME", "PRIMARY_ORIGIN", "A01_RELAY_SIGNING_KEY", "A01_RELAY_SITE", "__env__"];
let nonceNumber = 0;

function fixtureDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../drizzle/", import.meta.url);
  for (const filename of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
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
    return await fn(sqlite);
  } finally {
    sqlite.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

async function capture(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args); };
  try {
    const value = await fn();
    const relay = lines.filter((args) => typeof args[0] === "string" && args[0].startsWith('{"evt":"relay.verify"'));
    for (const args of relay) assert.equal(args.length, 1, "one JSON string per relay event");
    return { value, lines: relay.map((args) => args[0]), events: relay.map((args) => JSON.parse(args[0])) };
  } finally {
    console.log = original;
  }
}

function checkEvent(event, fields = {}) {
  assert.deepEqual(Object.keys(event), ["evt", "result", "site", "mode", "identityPresent", "method", "pathClass"]);
  assert.equal(event.evt, "relay.verify");
  assert.ok(["none", "valid", "invalid"].includes(event.result));
  assert.ok(["student", "admin", "unknown"].includes(event.site));
  assert.ok(["transitional", "strict"].includes(event.mode));
  assert.equal(typeof event.identityPresent, "boolean");
  assert.ok(["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OTHER"].includes(event.method));
  assert.ok(["student", "admin", "other", "health"].includes(event.pathClass));
  for (const [key, expected] of Object.entries(fields)) assert.equal(event[key], expected, key);
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
  return { request: new Request(`https://primary.example.test${pathname}${search}`, { method, headers, body }), headers, signature, nonce, ts };
}
const direct = (pathname, headers = {}) => new Request(`https://primary.example.test${pathname}`, { headers });

async function routeCase(label, { bindings = {}, create, handler = studentMe, status, event, logs = 1, bodyCheck, production = false }) {
  test(label, async () => {
    await withRuntime(bindings, async () => {
      const request = await create();
      const previous = process.env.NODE_ENV;
      try {
        if (production) process.env.NODE_ENV = "production";
        const { value: response, events } = await capture(() => handler(request));
        assert.equal(response.status, status);
        assert.equal(events.length, logs);
        if (logs) checkEvent(events[0], event);
        if (bodyCheck) await bodyCheck(response);
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
    });
  });
}

routeCase("A1 anonymous has one none event and guest 200", { create: () => direct("/api/student/me"), status: 200,
  event: { result: "none", site: "unknown", identityPresent: false, pathClass: "student" },
  bodyCheck: async (response) => assert.equal((await response.json()).guest, true) });
routeCase("A2 signed student has one valid event", { create: async () => (await signedRequest()).request, status: 200,
  event: { result: "valid", site: "student", method: "GET" } });
routeCase("A3 signed admin has one valid event", { create: async () => (await signedRequest({ site: "admin", pathname: "/api/admin/overview", email: "owner@example.test" })).request,
  handler: adminOverview, status: 200, event: { result: "valid", site: "admin", pathClass: "admin" } });
routeCase("A4 changed signature is invalid", { create: async () => (await signedRequest({ extra: { "x-a01-relay-sig": "bad" } })).request,
  status: 401, event: { result: "invalid", site: "student" } });
routeCase("A5 changed path is invalid", { create: async () => {
  const signed = await signedRequest();
  return new Request("https://primary.example.test/api/student/progress?a=1", { headers: signed.headers });
}, handler: studentProgress, status: 401, event: { result: "invalid", site: "student" } });
routeCase("A6 changed body is invalid", { create: async () => {
  const signed = await signedRequest({ method: "PUT", pathname: "/api/student/progress", body: "original" });
  return new Request(signed.request.url, { method: "PUT", headers: signed.headers, body: "changed" });
}, handler: putProgress, status: 401, event: { result: "invalid", method: "PUT" } });
for (const [id, offset] of [["A7", -400], ["A8", 400]]) {
  routeCase(`${id} timestamp outside skew is invalid`, { create: async () => (await signedRequest({ ts: String(Math.floor(Date.now() / 1000) + offset) })).request,
    status: 401, event: { result: "invalid" } });
}
test("A9 another Request replaying a PUT nonce is invalid after the first valid result", async () => {
  await withRuntime({}, async (sqlite) => {
    const signed = await signedRequest({ method: "PUT", pathname: "/api/student/progress", body: "x" });
    const first = await capture(() => getNormalizedAuth(signed.request));
    const replay = new Request(signed.request.url, { method: "PUT", headers: signed.headers, body: "x" });
    const second = await capture(() => putProgress(replay));
    assert.equal(first.value.isAuthenticated, true);
    assert.equal(second.value.status, 401);
    assert.equal(first.events.length, 1);
    assert.equal(second.events.length, 1);
    checkEvent(first.events[0], { result: "valid" });
    checkEvent(second.events[0], { result: "invalid" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relay_nonces").get().n, 1);
  });
});
routeCase("A10 missing key is invalid", { bindings: { A01_RELAY_KEY_STUDENT: undefined },
  create: async () => (await signedRequest()).request, status: 401, event: { result: "invalid" } });
routeCase("A11 shared cross-site key is invalid", { bindings: { A01_RELAY_KEY_ADMIN: STUDENT_KEY },
  create: async () => (await signedRequest()).request, status: 401, event: { result: "invalid" } });
routeCase("A12 whitespace mode is off and emits nothing", { bindings: { A01_RELAY_MODE: "   " },
  create: () => direct("/api/student/me", { "oai-authenticated-user-id": "legacy", "oai-authenticated-user-email": "legacy@example.test" }),
  status: 200, logs: 0, bodyCheck: async (response) => assert.equal((await response.json()).authenticated, true) });
routeCase("A13 non-string mode fails closed as strict", { bindings: { A01_RELAY_MODE: true },
  create: () => direct("/api/student/me", { "oai-authenticated-user-id": "legacy", "oai-authenticated-user-email": "legacy@example.test" }),
  status: 200, event: { result: "none", mode: "strict", identityPresent: true },
  bodyCheck: async (response) => assert.equal((await response.json()).guest, true) });
routeCase("A14 ordinary body above 8 MiB is invalid", { create: async () => {
  const signed = await signedRequest({ method: "PUT", pathname: "/api/student/progress", body: "x" });
  return new Request(signed.request.url, { method: "PUT", headers: signed.headers, body: new Uint8Array(8 * 1024 * 1024 + 1) });
}, handler: putProgress, status: 401, event: { result: "invalid", method: "PUT" } });
routeCase("A15 upload body above 21 MiB is invalid", { create: async () => {
  const signed = await signedRequest({ method: "POST", pathname: "/api/admin/books/upload", site: "admin", email: "owner@example.test", body: "x" });
  return new Request(signed.request.url, { method: "POST", headers: signed.headers, body: new Uint8Array(21 * 1024 * 1024 + 1) });
}, handler: adminUpload, status: 401, event: { result: "invalid", site: "admin", method: "POST" } });
routeCase("A16 unavailable D1 makes PUT invalid", { bindings: { DB: undefined }, create: async () => (await signedRequest({ method: "PUT", pathname: "/api/student/progress", body: "x" })).request,
  handler: putProgress, status: 401, event: { result: "invalid", method: "PUT" } });
routeCase("A16b GET verification stays valid without D1", { bindings: { DB: undefined }, create: async () => (await signedRequest()).request,
  status: 200, event: { result: "valid" } });
test("A17 two GET Requests with one nonce each emit valid without storage", async () => {
  await withRuntime({}, async (sqlite) => {
    const signed = await signedRequest();
    const other = new Request(signed.request.url, { headers: signed.headers });
    const { value, events } = await capture(async () => [await studentMe(signed.request), await studentMe(other)]);
    assert.deepEqual(value.map((response) => response.status), [200, 200]);
    assert.equal(events.length, 2);
    for (const event of events) checkEvent(event, { result: "valid", method: "GET" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relay_nonces").get().n, 0);
  });
});
test("HEAD verification is valid, logs HEAD and never stores a nonce", async () => {
  await withRuntime({}, async (sqlite) => {
    const signed = await signedRequest({ method: "HEAD" });
    const { value, events } = await capture(() => getNormalizedAuth(signed.request));
    assert.equal(value.isAuthenticated, true);
    assert.equal(events.length, 1);
    checkEvent(events[0], { result: "valid", method: "HEAD" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relay_nonces").get().n, 0);
  });
});

test("each known HTTP verb is logged verbatim and unknown verbs fall back to OTHER", async () => {
  await withRuntime({}, async () => {
    for (const verb of ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"]) {
      const signed = await signedRequest({ method: verb, pathname: "/api/student/progress", search: "",
        body: verb === "GET" || verb === "HEAD" ? undefined : "x" });
      const { events } = await capture(() => getNormalizedAuth(signed.request));
      assert.equal(events.length, 1, verb);
      checkEvent(events[0], { result: "valid", method: verb });
    }
    for (const verb of ["OPTIONS", "PROPFIND", "PURGE"]) {
      const signed = await signedRequest({ method: verb, pathname: "/api/student/progress", search: "", body: "x" });
      const { events } = await capture(() => getNormalizedAuth(signed.request));
      assert.equal(events.length, 1, verb);
      checkEvent(events[0], { result: "valid", method: "OTHER" });
    }
  });
});

routeCase("B1 off protected API emits no event", { bindings: { A01_RELAY_MODE: "off" }, create: () => direct("/api/student/me", {
  "oai-authenticated-user-id": "legacy", "oai-authenticated-user-email": "legacy@example.test" }), status: 200, logs: 0 });
routeCase("B2 transitional signed request is valid", { bindings: { A01_RELAY_MODE: "transitional" }, create: async () => (await signedRequest()).request,
  status: 200, event: { result: "valid", mode: "transitional" } });
routeCase("B3 transitional unsigned oai identity is accepted and logged as none", { bindings: { A01_RELAY_MODE: "transitional" },
  create: () => direct("/api/student/me", { "oai-authenticated-user-id": "legacy", "oai-authenticated-user-email": "legacy@example.test" }),
  status: 200, event: { result: "none", identityPresent: true, mode: "transitional" },
  bodyCheck: async (response) => assert.equal((await response.json()).authenticated, true) });
routeCase("B4 strict unsigned oai identity is guest", { create: () => direct("/api/student/me", {
  "oai-authenticated-user-id": "legacy", "oai-authenticated-user-email": "legacy@example.test" }), status: 200,
  event: { result: "none", identityPresent: true, mode: "strict" },
  bodyCheck: async (response) => assert.equal((await response.json()).guest, true) });
routeCase("B4 admin unsigned identity is 401", { create: () => direct("/api/admin/auth/me", {
  "oai-authenticated-user-id": "legacy", "oai-authenticated-user-email": "legacy@example.test" }), handler: adminAuth, status: 401,
  event: { result: "none", identityPresent: true, pathClass: "admin" } });
routeCase("B5 health emits no relay event", { create: () => direct("/api/health"), handler: health, status: 200, logs: 0 });
test("B6 unprotected API paths never invoke normalized auth", async () => {
  await withRuntime({}, async () => {
    const { value, events } = await capture(() => internalRunOptions());
    assert.equal(value.status, 204);
    assert.equal(events.length, 0);
  });
});
test("B7 gate interception emits no relay event", async () => {
  await withRuntime({}, async () => {
    const { value, events } = await capture(() => [
      gateApiRequest("/api/%2fstudent", { role: "primary", site: "backend", primaryOrigin: null }),
      gateApiRequest("/api/student/me", { role: "misconfigured", site: null, primaryOrigin: null }),
      gateApiRequest("/api/admin/me", { role: "secondary", site: "student", primaryOrigin: "https://primary.example.test" }),
    ]);
    assert.deepEqual(value.map((response) => response.status), [400, 503, 404]);
    assert.equal(events.length, 0);
  });
});
routeCase("B8 route CORS 403 emits no event", { create: () => direct("/api/student/me", { origin: "https://evil.example.test" }),
  status: 403, logs: 0, production: true });
test("B9 secondary delegation emits no local relay event", async () => {
  await withRuntime({ SITE_ROLE: "secondary", SITE_NAME: "student", PRIMARY_ORIGIN: "https://primary.example.test",
    A01_RELAY_SIGNING_KEY: STUDENT_KEY, A01_RELAY_SITE: "student" }, async () => {
    const previous = process.env.NODE_ENV;
    const originalFetch = globalThis.fetch;
    try {
      process.env.NODE_ENV = "production";
      globalThis.fetch = async () => Response.json({ delegated: true });
      const { value, events } = await capture(() => studentMe(direct("/api/student/me")));
      assert.equal(value.status, 200);
      assert.equal(events.length, 0);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
      globalThis.fetch = originalFetch;
    }
  });
});

test("C1/C2 one Request logs once and shares the verified result", async () => {
  await withRuntime({}, async (sqlite) => {
    const signed = await signedRequest({ method: "PUT", pathname: "/api/student/progress", body: "x" });
    const { value, events } = await capture(async () => {
      const first = await getNormalizedAuth(signed.request);
      const second = await getNormalizedAuth(signed.request);
      const directResult = await verifyIncomingRelay(signed.request);
      return { first, second, directResult };
    });
    assert.strictEqual(value.first, value.second);
    assert.equal(value.directResult.status, "valid");
    assert.equal(events.length, 1);
    checkEvent(events[0], { result: "valid", method: "PUT" });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM relay_nonces").get().n, 1);
  });
});
test("C3 two distinct Request objects each emit one line", async () => {
  await withRuntime({}, async () => {
    const request = direct("/api/student/me");
    const other = new Request(request.url, { headers: request.headers });
    const { events } = await capture(async () => { await getNormalizedAuth(request); await getNormalizedAuth(other); });
    assert.equal(events.length, 2);
    for (const event of events) checkEvent(event, { result: "none" });
  });
});

registerBoundaryCases();
function registerBoundaryCases() {
  routeCase("D1 forged site is clamped to unknown and rejected", { create: async () => (await signedRequest({ extra: { "x-a01-relay-site": "evil" } })).request,
    status: 401, event: { result: "invalid", site: "unknown" } });
  routeCase("D2 comma-coalesced signature is invalid", { create: async () => {
    const signed = await signedRequest();
    const headers = new Headers(signed.headers);
    headers.append("x-a01-relay-sig", "forged");
    return new Request(signed.request.url, { headers });
  }, status: 401, event: { result: "invalid" } });
  routeCase("D3 control-byte injection stays one JSON line", { create: async () => (await signedRequest({ extra: { "x-a01-relay-user-id": "evil\x7fevt" } })).request,
    status: 401, event: { result: "invalid" } });
  routeCase("D4 partial signed identity is invalid", { create: async () => (await signedRequest({ extra: { "x-a01-relay-user-email": "-" } })).request,
    status: 401, event: { result: "invalid" } });
  routeCase("D5 signed anonymous is valid relay but guest response", { create: async () => (await signedRequest({ userId: "-", email: "-" })).request,
    status: 200, event: { result: "valid" }, bodyCheck: async (response) => assert.equal((await response.json()).guest, true) });
  routeCase("D5 signed anonymous admin is still 401", { create: async () => (await signedRequest({ site: "admin", pathname: "/api/admin/auth/me", userId: "-", email: "-" })).request,
    handler: adminAuth, status: 401, event: { result: "valid", site: "admin" } });
  routeCase("D6 student signature cannot authorize admin path", { create: async () => {
    const signed = await signedRequest();
    return new Request("https://primary.example.test/api/admin/auth/me?a=1", { headers: signed.headers });
  }, handler: adminAuth, status: 401, event: { result: "invalid", site: "student", pathClass: "admin" } });
  routeCase("D7 signed health emits no relay event", { create: async () => (await signedRequest({ pathname: "/api/health", search: "" })).request,
    handler: health, status: 200, logs: 0 });
}
test("D8 direct verification in off mode performs verification without logging", async () => {
  await withRuntime({ A01_RELAY_MODE: "off" }, async () => {
    const signed = await signedRequest();
    const { value, events } = await capture(() => verifyIncomingRelay(signed.request));
    assert.equal(value.status, "valid");
    assert.equal(events.length, 0);
  });
});

test("privacy: JSON event has no signature, identifiers, headers, query or path details", async () => {
  await withRuntime({}, async () => {
    const signed = await signedRequest({ pathname: "/api/student/me", search: "?private=book-123", userId: "secret-user-id",
      email: "Private@Example.TEST", extra: { "oai-authenticated-user-full-name": "Secret Full Name", authorization: "Bearer private-token",
        cookie: "session=private-cookie", "cf-connecting-ip": "192.0.2.99" } });
    const { lines, events } = await capture(() => studentMe(signed.request));
    assert.equal(events.length, 1);
    checkEvent(events[0], { result: "valid", identityPresent: false });
    assert.equal(lines[0].includes("\n"), false);
    assert.equal(lines[0].includes("\u2028"), false);
    for (const secret of [STUDENT_KEY, signed.signature, signed.nonce, signed.ts, "secret-user-id", "Private@Example.TEST",
      "private@example.test", "Secret Full Name", "private-token", "private-cookie", "192.0.2.99", "book-123", "/api/student/me", "?private"])
      assert.equal(lines[0].includes(secret), false, secret);
  });
});
test("privacy: hostile site value is reduced to unknown in one JSON line", async () => {
  await withRuntime({}, async () => {
    const injected = '[a01-relay]{"evt":"evil"}\x7f';
    const signed = await signedRequest({ extra: { "x-a01-relay-site": injected } });
    const { value, lines, events } = await capture(() => studentMe(signed.request));
    assert.equal(value.status, 401);
    assert.equal(events.length, 1);
    checkEvent(events[0], { result: "invalid", site: "unknown" });
    assert.equal(lines[0].includes(injected), false);
    assert.equal(lines[0].includes("\x7f"), false);
  });
});
test("privacy: Request rejects CRLF and Unicode line-separator header injection before verification", () => {
  for (const value of ["evil\r\nevt", "evil\u2028evt"]) {
    assert.throws(() => direct("/api/student/me", { "x-a01-relay-site": value }), TypeError);
  }
});
test("privacy: console failure does not change valid or invalid authorization", async () => {
  await withRuntime({}, async () => {
    const original = console.log;
    try {
      console.log = () => { throw new Error("logger unavailable"); };
      const valid = await studentMe((await signedRequest()).request);
      const invalid = await studentMe((await signedRequest({ extra: { "x-a01-relay-sig": "bad" } })).request);
      assert.equal(valid.status, 200);
      assert.equal(invalid.status, 401);
    } finally { console.log = original; }
  });
});
test("privacy: JSON serialization failure does not change cached valid verification", async () => {
  await withRuntime({}, async () => {
    const signed = await signedRequest();
    assert.equal((await verifyIncomingRelay(signed.request)).status, "valid");
    const original = JSON.stringify;
    try {
      JSON.stringify = () => { throw new Error("serializer unavailable"); };
      const auth = await getNormalizedAuth(signed.request);
      assert.equal(auth.isAuthenticated, true);
    } finally { JSON.stringify = original; }
  });
});
