import assert from "node:assert/strict";
import test from "node:test";
import { readAdminIdentity, resolveAdminIdentity } from "../app/admin/admin-identity.ts";

const admin = { id: "admin-1", email: "owner@example.test", displayName: "管理員" };
const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

test("admin identity keeps 401, 403 and service failures separate", async () => {
  assert.deepEqual(await resolveAdminIdentity(reply(401)), { status: "unauthenticated" });
  assert.deepEqual(await resolveAdminIdentity(reply(403)), { status: "forbidden" });
  assert.deepEqual(await resolveAdminIdentity(reply(503)), { status: "error" });
  assert.deepEqual(await resolveAdminIdentity(reply(200, { authenticated: true, role: "student", user: admin })), { status: "error" });
  assert.deepEqual(await resolveAdminIdentity(reply(200, { authenticated: true, role: "admin", user: null })), { status: "error" });
  assert.deepEqual(await resolveAdminIdentity(reply(200, { authenticated: true, role: "admin", user: admin })), {
    status: "authorized", user: admin,
  });
});

test("identity request uses the site API and fails closed on network errors", async () => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  try {
    globalThis.fetch = async (path, options) => {
      assert.equal(path, "/api/admin/auth/me");
      assert.equal(options.credentials, "same-origin");
      assert.equal(options.cache, "no-store");
      assert.equal(options.signal, controller.signal);
      return reply(403);
    };
    assert.deepEqual(await readAdminIdentity(controller.signal), { status: "forbidden" });
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.deepEqual(await readAdminIdentity(controller.signal), { status: "error" });
  } finally {
    globalThis.fetch = previousFetch;
  }
});
