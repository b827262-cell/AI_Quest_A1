import assert from "node:assert/strict";
import test from "node:test";
import { delegateToBackend } from "../app/api/backend-client.ts";
import { checkTimestamp, parseRelayHeaders, verifyRelay } from "../lib/relay-signature.ts";

const KEY = "local-test-relay-key-at-least-32-characters";
const EDGE = "local-test-edge-secret-at-least-32-characters";
const ORIGIN = "https://primary.example.test";
const IDENTITY = { "oai-authenticated-user-id": "test-user", "oai-authenticated-user-email": "Alice@Example.COM" };
const BINDINGS = ["SITE_ROLE", "SITE_NAME", "PRIMARY_ORIGIN", "A01_RELAY_SIGNING_KEY", "A01_RELAY_SITE",
  "A01_RELAY_EDGE_SECRET_STUDENT", "A01_RELAY_EDGE_SECRET_STUDENT_PREV",
  "A01_RELAY_EDGE_SECRET_ADMIN", "A01_RELAY_EDGE_SECRET_ADMIN_PREV", "A01_RELAY_EDGE_MODE", "__env__"];

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
  const relayHeaders = [...sent.headers.keys()].filter((name) => name.startsWith("x-a01-relay-"));
  assert.equal(relayHeaders.filter((name) => name !== "x-a01-relay-edge-secret").length, 7);
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
      const missingKey = { ...env };
      delete missingKey.A01_RELAY_SIGNING_KEY;
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

test("signed request carries the current per-site edge secret and still signs seven headers", async () => {
  await withRelay({ A01_RELAY_EDGE_SECRET_STUDENT: EDGE }, async (arrived) => {
    await delegateToBackend(request(), "/api/student/me");
    const sent = arrived[0];
    assert.equal(sent.headers.get("x-a01-relay-edge-secret"), EDGE);
    await validSignature(sent);
  });
});

test("admin site reads only the admin edge secret", async () => {
  await withRelay({ SITE_NAME: "admin", A01_RELAY_SITE: "admin", A01_RELAY_EDGE_SECRET_ADMIN: EDGE }, async (arrived) => {
    await delegateToBackend(request({ path: "/api/admin/auth/me" }), "/api/admin/auth/me");
    assert.equal(arrived[0].headers.get("x-a01-relay-edge-secret"), EDGE);
  });
});

test("a secret bound to the other site is never sent", async () => {
  await withRelay({ A01_RELAY_EDGE_SECRET_ADMIN: EDGE }, async (arrived) => {
    await delegateToBackend(request(), "/api/student/me");
    assert.equal(arrived[0].headers.has("x-a01-relay-edge-secret"), false);
  });
});

test("anonymous request without signing capability forwards no edge secret", async () => {
  await withRelay({ A01_RELAY_SIGNING_KEY: undefined, A01_RELAY_EDGE_SECRET_STUDENT: EDGE }, async (arrived) => {
    const response = await delegateToBackend(request({ headers: {} }), "/api/student/me");
    assert.equal(response.status, 201);
    assert.equal(arrived.length, 1);
    assert.equal(arrived[0].headers.has("x-a01-relay-edge-secret"), false);
    for (const name of arrived[0].headers.keys()) assert.equal(name.startsWith("x-a01-relay-"), false);
  });
});

test("forged inbound edge secret is stripped and replaced by the real per-site value", async () => {
  await withRelay({ A01_RELAY_EDGE_SECRET_STUDENT: EDGE }, async (arrived) => {
    await delegateToBackend(request({ headers: { ...IDENTITY, "x-a01-relay-edge-secret": "forged",
      "X-A01-Relay-Edge-Secret": "forged-too" } }), "/api/student/me");
    assert.equal(arrived[0].headers.get("x-a01-relay-edge-secret"), EDGE);
  });
});

test("forged inbound edge secret is dropped when no local secret is configured", async () => {
  await withRelay({}, async (arrived) => {
    await delegateToBackend(request({ headers: { ...IDENTITY, "x-a01-relay-edge-secret": "forged" } }), "/api/student/me");
    assert.equal(arrived[0].headers.has("x-a01-relay-edge-secret"), false);
    await validSignature(arrived[0]);
  });
});

for (const [label, value] of [
  ["missing", undefined],
  ["31-character", "s".repeat(31)],
  ["513-character", "s".repeat(513)],
  ["non-string", 123],
]) {
  test(`${label} edge secret is omitted without failing the request`, async () => {
    await withRelay({ A01_RELAY_EDGE_SECRET_STUDENT: value }, async (arrived) => {
      const response = await delegateToBackend(request(), "/api/student/me");
      assert.equal(response.status, 201);
      assert.equal(arrived[0].headers.has("x-a01-relay-edge-secret"), false);
      await validSignature(arrived[0]);
    });
  });
}

test("edge secret falls back to the runtime __env__ binding", async () => {
  await withRelay({ A01_RELAY_EDGE_SECRET_STUDENT: undefined,
    __env__: { A01_RELAY_EDGE_SECRET_STUDENT: EDGE } }, async (arrived) => {
    await delegateToBackend(request(), "/api/student/me");
    assert.equal(arrived[0].headers.get("x-a01-relay-edge-secret"), EDGE);
  });
});

test("edge secret never appears in a failure response or console output", async () => {
  const original = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  console.log = console.error = console.warn = (...args) => lines.push(args.map(String).join(" "));
  try {
    await withRelay({ A01_RELAY_EDGE_SECRET_STUDENT: EDGE }, async (arrived) => {
      const response = await delegateToBackend(request({ headers: { "oai-authenticated-user-id": "invalid\u0085id" } }), "/api/student/me");
      assert.equal(response.status, 503);
      assert.equal((await response.text()).includes(EDGE), false);
      assert.equal(arrived.length, 0);
    });
  } finally {
    console.log = original.log; console.error = original.error; console.warn = original.warn;
  }
  assert.equal(lines.join("\n").includes(EDGE), false);
});

test("built Worker injects the secondary edge secret binding and clears a missing one", async () => {
  const { default: worker } = await import(new URL("../dist/server/index.js?relay-secondary-edge=1", import.meta.url).href);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const assets = { fetch: async () => new Response("not found", { status: 404 }) };
  await worker.fetch(new Request("https://primary.example.test/api/health"),
    { ASSETS: assets, SITE_ROLE: "primary", SITE_NAME: "backend" }, ctx);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await withRelay({}, async (arrived) => {
      const env = { ASSETS: assets, SITE_ROLE: "secondary", SITE_NAME: "student", PRIMARY_ORIGIN: ORIGIN,
        A01_RELAY_SIGNING_KEY: KEY, A01_RELAY_SITE: "student", A01_RELAY_EDGE_SECRET_STUDENT: EDGE };
      const response = await worker.fetch(request({ path: "/api/student/me" }), env, ctx);
      assert.equal(response.status, 201);
      assert.equal(arrived[0].headers.get("x-a01-relay-edge-secret"), EDGE);
      const withoutEdge = { ...env };
      delete withoutEdge.A01_RELAY_EDGE_SECRET_STUDENT;
      await worker.fetch(request({ path: "/api/student/me" }), withoutEdge, ctx);
      assert.equal(arrived[1].headers.has("x-a01-relay-edge-secret"), false, "no stale edge secret from the previous request");
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("require mode refuses missing or invalid current edge secrets before body consumption or fetch", async () => {
  const original = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  console.log = console.error = console.warn = (...args) => lines.push(args.map(String).join(" "));
  try {
    for (const site of ["student", "admin"]) {
      for (const value of [undefined, "x".repeat(31), "x".repeat(513), 123]) {
        await withRelay({ SITE_NAME: site, A01_RELAY_SITE: site, A01_RELAY_EDGE_MODE: "require",
          [`A01_RELAY_EDGE_SECRET_${site.toUpperCase()}`]: value }, async (arrived) => {
          const req = request({ method: "POST", body: "local-body" });
          req.arrayBuffer = () => { throw Error("body must not be consumed"); };
          const response = await delegateToBackend(req, `/api/${site}/me`);
          assert.equal(response.status, 503);
          assert.deepEqual(await response.json(), { error: "relay_edge_secret_unavailable" });
          assert.equal(arrived.length, 0);
        });
      }
    }
    assert.deepEqual(lines, [], "configuration refusal neither leaks values nor emits relay logs");
  } finally { Object.assign(console, original); }
});

test("require mode sends valid 32 and 512 character current secrets with unchanged signatures", async () => {
  for (const site of ["student", "admin"]) {
    for (const length of [32, 512]) {
      const secret = "e".repeat(length);
      await withRelay({ SITE_NAME: site, A01_RELAY_SITE: site,
        __env__: { A01_RELAY_EDGE_MODE: " REQUIRE ", [`A01_RELAY_EDGE_SECRET_${site.toUpperCase()}`]: secret } }, async (arrived) => {
        const response = await delegateToBackend(request(), `/api/${site}/me`);
        assert.equal(response.status, 201);
        assert.equal(arrived[0].headers.get("x-a01-relay-edge-secret"), secret);
        await validSignature(arrived[0]);
      });
    }
  }
});

test("require mode without signing capability preserves anonymous forwarding and identity failure", async () => {
  await withRelay({ A01_RELAY_EDGE_MODE: "require", A01_RELAY_SIGNING_KEY: undefined }, async (arrived) => {
    const anonymous = await delegateToBackend(request({ headers: {} }), "/api/student/me");
    assert.equal(anonymous.status, 201);
    assert.equal(arrived.length, 1);
    assert.equal(arrived[0].headers.has("x-a01-relay-edge-secret"), false);
    const identity = await delegateToBackend(request(), "/api/student/me");
    assert.equal(identity.status, 503);
    assert.deepEqual(await identity.json(), { error: "relay_signing_unavailable" });
    assert.equal(arrived.length, 1);
  });
});

test("require mode also refuses signed anonymous requests and never substitutes other-site or previous secrets", async () => {
  for (const extra of [{}, { A01_RELAY_EDGE_SECRET_ADMIN: EDGE }, { A01_RELAY_EDGE_SECRET_STUDENT_PREV: EDGE }]) {
    await withRelay({ A01_RELAY_EDGE_MODE: "require", ...extra }, async (arrived) => {
      const response = await delegateToBackend(request({ headers: { "x-a01-relay-edge-secret": EDGE } }), "/api/student/me");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "relay_edge_secret_unavailable" });
      assert.equal(arrived.length, 0);
    });
  }
});

test("accept and unset modes retain signed forwarding when the edge secret is unavailable", async () => {
  for (const mode of [undefined, "accept", " ACCEPT ", ""]) {
    for (const value of [undefined, "e".repeat(31), "e".repeat(513), 123]) {
      await withRelay({ A01_RELAY_EDGE_MODE: mode, A01_RELAY_EDGE_SECRET_STUDENT: value }, async (arrived) => {
        const response = await delegateToBackend(request(), "/api/student/me");
        assert.equal(response.status, 201);
        assert.equal(arrived[0].headers.has("x-a01-relay-edge-secret"), false);
        await validSignature(arrived[0]);
      });
    }
  }
});

test("built Worker applies require from its live bindings and clears the secret without stale reuse", async () => {
  const { default: worker } = await import(new URL("../dist/server/index.js?relay-secondary-require=1", import.meta.url).href);
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const assets = { fetch: async () => new Response("not found", { status: 404 }) };
  await worker.fetch(new Request("https://primary.example.test/api/health"),
    { ASSETS: assets, SITE_ROLE: "primary", SITE_NAME: "backend" }, ctx);
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await withRelay({}, async (arrived) => {
      const env = { ASSETS: assets, SITE_ROLE: "secondary", SITE_NAME: "student", PRIMARY_ORIGIN: ORIGIN,
        A01_RELAY_SIGNING_KEY: KEY, A01_RELAY_SITE: "student", A01_RELAY_EDGE_MODE: "require",
        A01_RELAY_EDGE_SECRET_STUDENT: EDGE };
      assert.equal((await worker.fetch(request({ path: "/api/student/me" }), env, ctx)).status, 201);
      assert.equal(arrived.length, 1);
      const missing = { ...env }; delete missing.A01_RELAY_EDGE_SECRET_STUDENT;
      const response = await worker.fetch(request({ path: "/api/student/me" }), missing, ctx);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "relay_edge_secret_unavailable" });
      assert.equal(arrived.length, 1);
      assert.equal((await worker.fetch(request({ path: "/api/student/me" }), { ...missing, A01_RELAY_EDGE_MODE: "accept" }, ctx)).status, 201);
      assert.equal(arrived.length, 2);
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});
