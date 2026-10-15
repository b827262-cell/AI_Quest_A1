import assert from "node:assert/strict";
import test from "node:test";
import { delegateToBackend } from "../app/api/backend-client.ts";
import { checkTimestamp, parseRelayHeaders, verifyRelay } from "../lib/relay-signature.ts";

const KEY = "local-test-relay-key-at-least-32-characters";
const ORIGIN = "https://primary.example.test";
const IDENTITY = { "oai-authenticated-user-id": "test-user", "oai-authenticated-user-email": "Alice@Example.COM" };
const BINDINGS = ["SITE_ROLE", "SITE_NAME", "PRIMARY_ORIGIN", "A01_RELAY_SIGNING_KEY", "A01_RELAY_SITE", "__env__"];

async function withRelay(bindings, run) {
  const saved = BINDINGS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const fetch = globalThis.fetch;
  const arrived = [];
  for (const name of BINDINGS) delete globalThis[name];
  Object.assign(globalThis, { SITE_ROLE: "secondary", SITE_NAME: "student", PRIMARY_ORIGIN: ORIGIN,
    A01_RELAY_SIGNING_KEY: KEY, A01_RELAY_SITE: "student", ...bindings });
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).origin, ORIGIN, "all outbound traffic stays in the local mock");
    arrived.push({ url: new URL(url), init, headers: new Headers(init.headers) });
    return new Response("primary-data", { status: 201, headers: { "x-existing": "kept" } });
  };
  try { await run(arrived); }
  finally {
    globalThis.fetch = fetch;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

function request({ headers = IDENTITY, method = "GET", body, path = "/api/student/books/BookA/content?b=2&a=1" } = {}) {
  return new Request(`https://secondary.example.test${path}`, { method, headers, body });
}
async function validSignature(sent, key = KEY) {
  const parsed = parseRelayHeaders(sent.headers);
  assert.equal(parsed.ok, true);
  assert.equal(checkTimestamp(parsed.ts, Math.floor(Date.now() / 1000)), true);
  assert.match(parsed.nonce, /^[A-Za-z0-9_-]{16,}$/);
  assert.equal(parsed.role, "-");
  const signed = { method: sent.init.method, pathname: sent.url.pathname, search: sent.url.search,
    body: sent.init.body, site: parsed.site, userId: parsed.userId, email: parsed.email,
    role: parsed.role, ts: parsed.ts, nonce: parsed.nonce };
  assert.equal(await verifyRelay(signed, parsed.signature, [key]), true);
  assert.equal([...sent.headers.keys()].filter((name) => name.startsWith("x-a01-relay-")).length, 7);
  return { parsed, signed };
}

test("student identity is signed with seven headers, original case and raw query, preserving proxy response", async () => {
  await withRelay({}, async (arrived) => {
    const response = await delegateToBackend(request({ headers: { ...IDENTITY, "x-forwarded-for": "192.0.2.1", "x-demo-mode": "yes" } }), "/api/student/books/BookA/content");
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("x-data-plane"), "primary");
    assert.equal(response.headers.get("x-existing"), "kept");
    assert.equal(await response.text(), "primary-data");
    assert.equal(arrived.length, 1);
    const sent = arrived[0];
    assert.equal(sent.url.pathname, "/api/student/books/BookA/content");
    assert.equal(sent.url.search, "?b=2&a=1");
    assert.equal(sent.headers.get("x-forwarded-for"), "192.0.2.1");
    assert.equal(sent.headers.get("x-forwarded-host"), "secondary.example.test");
    assert.equal(sent.headers.get("x-forwarded-proto"), "https");
    assert.equal(sent.headers.get("x-demo-mode"), "yes");
    const { signed, parsed } = await validSignature(sent);
    assert.equal(parsed.userId, "test-user");
    assert.equal(parsed.email, "alice@example.com");
    assert.equal(await verifyRelay({ ...signed, pathname: signed.pathname.toLowerCase() }, parsed.signature, [KEY]), false);
  });
});

test("admin site signs role dash regardless of inbound claimed administrator role", async () => {
  await withRelay({ SITE_NAME: "admin", A01_RELAY_SITE: "admin" }, async (arrived) => {
    await delegateToBackend(request({ headers: { ...IDENTITY, "oai-authenticated-user-role": "admin" } }), "/api/admin/auth/me");
    const { parsed } = await validSignature(arrived[0]);
    assert.equal(parsed.site, "admin");
    assert.equal(parsed.role, "-");
  });
});

test("incoming oai and relay prefixes are stripped and forged signatures replaced", async () => {
  await withRelay({}, async (arrived) => {
    await delegateToBackend(request({ headers: { ...IDENTITY, "OAI-Extra": "spoof", "oai-authenticated-user-role": "admin", "X-A01-Relay-Sig": "forged", "x-a01-relay-extra": "spoof", "x-a01-relay-user-id": "attacker", "x-a01-relay-site": "admin" } }), "/api/student/me");
    const sent = arrived[0];
    for (const name of sent.headers.keys()) assert.equal(name.startsWith("oai-"), false);
    assert.equal(sent.headers.has("x-a01-relay-extra"), false);
    const { parsed } = await validSignature(sent);
    assert.equal(parsed.userId, "test-user");
    assert.notEqual(parsed.signature, "forged");
  });
});

for (const [label, bindings] of [
  ["missing key", { A01_RELAY_SIGNING_KEY: undefined }],
  ["short key", { A01_RELAY_SIGNING_KEY: "k".repeat(31) }],
  ["non-string key", { A01_RELAY_SIGNING_KEY: 123 }],
  ["mismatched site", { A01_RELAY_SITE: "admin" }],
  ["missing site", { A01_RELAY_SITE: undefined }],
]) {
  test(`${label} with identity fails closed before fetch`, async () => {
    await withRelay(bindings, async (arrived) => {
      const response = await delegateToBackend(request(), "/api/student/me");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "relay_signing_unavailable" });
      assert.equal(arrived.length, 0);
    });
  });
}

for (const [label, bindings] of [["missing key", { A01_RELAY_SIGNING_KEY: undefined }], ["mismatched site", { A01_RELAY_SITE: "admin" }]]) {
  test(`${label} anonymous request forwards without any identity prefixes`, async () => {
    await withRelay(bindings, async (arrived) => {
      const response = await delegateToBackend(request({ headers: { "oai-authenticated-user-role": "admin", "oai-extra": "forged", "x-a01-relay-sig": "forged", "x-a01-relay-user-id": "attacker" } }), "/api/student/me");
      assert.equal(response.status, 201);
      assert.equal(arrived.length, 1);
      for (const name of arrived[0].headers.keys()) assert.equal(name.startsWith("oai-") || name.startsWith("x-a01-relay-"), false);
    });
  });
}

test("POST reads body once and signs the exact forwarded binary bytes", async () => {
  await withRelay({}, async (arrived) => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 65]);
    const req = request({ method: "POST", body: bytes });
    const read = req.arrayBuffer.bind(req); let calls = 0; let consumed;
    req.arrayBuffer = async () => { calls++; consumed = await read(); return consumed; };
    await delegateToBackend(req, "/api/student/books/BookA/content");
    assert.equal(calls, 1);
    assert.equal(arrived[0].init.body, consumed);
    assert.deepEqual(new Uint8Array(arrived[0].init.body), bytes);
    const { signed, parsed } = await validSignature(arrived[0]);
    assert.equal(await verifyRelay({ ...signed, body: new Uint8Array([1]) }, parsed.signature, [KEY]), false);
  });
});

test("HEAD forwards no body and creates a fresh random nonce per request", async () => {
  await withRelay({}, async (arrived) => {
    for (let i = 0; i < 2; i++) await delegateToBackend(request({ method: "HEAD" }), "/api/student/me");
    for (const sent of arrived) { assert.equal(sent.init.body, undefined); await validSignature(sent); }
    assert.notEqual(arrived[0].headers.get("x-a01-relay-nonce"), arrived[1].headers.get("x-a01-relay-nonce"));
  });
});

test("identity supplied only by email still requires signing; key uses exact bytes", async () => {
  const key = " " + KEY + " ";
  await withRelay({ A01_RELAY_SIGNING_KEY: key }, async (arrived) => {
    await delegateToBackend(request({ headers: { "oai-authenticated-user-email": "alice@example.com" } }), "/api/student/me");
    const { parsed } = await validSignature(arrived[0], key);
    assert.equal(parsed.userId, "-");
  });
  await withRelay({ A01_RELAY_SIGNING_KEY: undefined }, async (arrived) => {
    const response = await delegateToBackend(request({ headers: { "oai-authenticated-user-email": "alice@example.com" } }), "/api/student/me");
    assert.equal(response.status, 503); assert.equal(arrived.length, 0);
  });
});

test("invalid platform identity never reaches primary or leaks in an error", async () => {
  await withRelay({}, async (arrived) => {
    const response = await delegateToBackend(request({ headers: { "oai-authenticated-user-id": "invalid\u0085id" } }), "/api/student/me");
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "relay_signing_unavailable" });
    assert.equal(arrived.length, 0);
  });
});

test("runtime __env__ fallback reads both signing bindings", async () => {
  await withRelay({ A01_RELAY_SIGNING_KEY: undefined, A01_RELAY_SITE: undefined,
    __env__: { A01_RELAY_SIGNING_KEY: KEY, A01_RELAY_SITE: "student" } }, async (arrived) => {
    await delegateToBackend(request(), "/api/student/me"); await validSignature(arrived[0]);
  });
});

test("configured anonymous requests sign missing identity sentinels", async () => {
  await withRelay({}, async (arrived) => {
    await delegateToBackend(request({ headers: {} }), "/api/student/me");
    const { parsed } = await validSignature(arrived[0]);
    assert.equal(parsed.userId, "-"); assert.equal(parsed.email, "-");
  });
});

test("built Worker injects signing bindings per request and clears a missing key", async () => {
  const { default: worker } = await import(new URL("../dist/server/index.js?relay-secondary=1", import.meta.url).href);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const assets = { fetch: async () => new Response("not found", { status: 404 }) };
  // Warm the framework's one-time fetch wrapper before installing our mock.
  await worker.fetch(new Request("https://primary.example.test/api/health"),
    { ASSETS: assets, SITE_ROLE: "primary", SITE_NAME: "backend" }, ctx);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await withRelay({}, async (arrived) => {
      const env = { ASSETS: assets, SITE_ROLE: "secondary", SITE_NAME: "student", PRIMARY_ORIGIN: ORIGIN,
        A01_RELAY_SIGNING_KEY: KEY, A01_RELAY_SITE: "student" };
      const response = await worker.fetch(request({ path: "/api/student/me" }), env, ctx);
      assert.equal(response.status, 201);
      assert.equal(arrived.length, 1);
      await validSignature(arrived[0]);
      const { A01_RELAY_SIGNING_KEY: omitted, ...missingKey } = env;
      const unavailable = await worker.fetch(request({ path: "/api/student/me" }), missingKey, ctx);
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await unavailable.json(), { error: "relay_signing_unavailable" });
      assert.equal(arrived.length, 1, "no stale key from the previous request");
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
