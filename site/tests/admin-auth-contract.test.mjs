import assert from "node:assert/strict";
import test from "node:test";

async function requestWorker(pathname, { method = "GET", headers = {}, adminEmails = "owner@example.test" } = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: { accept: "application/json", ...headers },
    }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      ADMIN_EMAILS: adminEmails,
    },
    { waitUntil() {}, passThroughOnException() {} }
  );
}

const adminRoutes = [
  ["GET", "/api/admin/auth/me"],
  ["GET", "/api/admin/overview"],
  ["GET", "/api/admin/books"],
  ["DELETE", "/api/admin/books?id=book-synth-001"],
  ["GET", "/api/admin/books/book-synth-001"],
  ["DELETE", "/api/admin/books/book-synth-001"],
  ["POST", "/api/admin/books/upload"],
];

const student = {
  "oai-authenticated-user-id": "student-01",
  "oai-authenticated-user-email": "student@example.test",
};

for (const [method, pathname] of adminRoutes) {
  test(`${method} ${pathname} keeps the admin 401/403 identity boundary`, async () => {
    const anonymous = await requestWorker(pathname, {
      method,
      headers: { "oai-authenticated-user-role": "admin" },
    });
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).authenticated, false);

    const malformed = await requestWorker(pathname, {
      method,
      headers: { "oai-authenticated-user-id": "incomplete" },
    });
    assert.equal(malformed.status, 401);
    assert.equal((await malformed.json()).error, "malformed_auth");

    const forbidden = await requestWorker(pathname, {
      method,
      headers: { ...student, "oai-authenticated-user-role": "admin" },
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), {
      error: "admin permission required",
      authenticated: true,
      role: "student",
    });
  });
}

test("admin identity contract uses only exact server-side ADMIN_EMAILS membership", async () => {
  const headers = {
    "oai-authenticated-user-id": "owner-01",
    "oai-authenticated-user-email": "Owner@Example.Test",
    "oai-authenticated-user-role": "student",
  };
  const allowed = await requestWorker("/api/admin/auth/me", {
    headers,
    adminEmails: " other@example.test , owner@example.test ",
  });
  assert.equal(allowed.status, 200);
  const identity = await allowed.json();
  assert.equal(identity.authenticated, true);
  assert.equal(identity.role, "admin");
  assert.equal(identity.user.id, "owner-01");
  assert.equal(identity.user.email, "Owner@Example.Test");
  assert.equal(identity.user.role, "admin");

  for (const adminEmails of ["", "another-owner@example.test", "notowner@example.test"]) {
    const denied = await requestWorker("/api/admin/auth/me", { headers, adminEmails });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).role, "student");
  }
});
