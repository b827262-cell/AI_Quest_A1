import assert from "node:assert/strict";
import test from "node:test";

async function requestWorker(pathname, options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  const req = new Request(`http://localhost${pathname}`, {
    headers: {
      accept: "application/json",
      ...(options.headers ?? {}),
    },
    method: options.method ?? "GET",
  });

  return worker.fetch(
    req,
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
      DB: options.db,
    },
    { waitUntil() {}, passThroughOnException() {} }
  );
}

test("GET /api/health returns 200 OK with worker edge metadata", async () => {
  const res = await requestWorker("/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.edge, "cloudflare-worker");
  assert.equal(data.d1, "unbound");
  assert.equal(data.phase, 2);
});

test("GET /api/student/me returns deterministic synthetic student or SIWC user", async () => {
  // Guest visitor
  const resGuest = await requestWorker("/api/student/me");
  assert.equal(resGuest.status, 200);
  const dataGuest = await resGuest.json();
  assert.equal(dataGuest.authenticated, false);
  assert.equal(dataGuest.guest, true);
  assert.equal(dataGuest.defaultStudent.isSynthetic, true);

  // Authenticated SIWC student
  const resAuth = await requestWorker("/api/student/me", {
    headers: {
      "oai-authenticated-user-id": "user-test-123",
      "oai-authenticated-user-email": "student.bob@synthetic.ai-smartbook.test",
      "oai-authenticated-user-full-name": "Bob%20Smith",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  });
  assert.equal(resAuth.status, 200);
  const dataAuth = await resAuth.json();
  assert.equal(dataAuth.authenticated, true);
  assert.equal(dataAuth.user.id, "user-test-123");
  assert.equal(dataAuth.user.displayName, "Bob Smith");
  assert.equal(dataAuth.user.role, "student");
});

test("GET /api/student/progress returns deterministic synthetic progress", async () => {
  const res = await requestWorker("/api/student/progress");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.progress));
  assert.ok(data.progress.length > 0);
  assert.equal(data.progress[0].isSynthetic, true);
  assert.equal(data.progress[0].progressPercent, 68);
});

test("GET /api/admin/auth/me enforces controlled 401 and 403 access control", async () => {
  // 1. Unauthenticated -> 401
  const resUnauth = await requestWorker("/api/admin/auth/me");
  assert.equal(resUnauth.status, 401);
  const dataUnauth = await resUnauth.json();
  assert.match(dataUnauth.error, /admin authentication required/i);

  // 2. Authenticated as student (non-admin) -> 403 Forbidden
  const resStudent = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "student-123",
      "oai-authenticated-user-email": "student.alice@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "student",
    },
  });
  assert.equal(resStudent.status, 403);
  const dataStudent = await resStudent.json();
  assert.match(dataStudent.error, /admin permission required/i);

  // 3. Authenticated as admin -> 200 OK
  const resAdmin = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "admin-123",
      "oai-authenticated-user-email": "admin@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "admin",
    },
  });
  assert.equal(resAdmin.status, 200);
  const dataAdmin = await resAdmin.json();
  assert.equal(dataAdmin.authenticated, true);
  assert.equal(dataAdmin.role, "admin");
});

test("GET /api/admin/overview returns metrics for admin and blocks unauthorized requests", async () => {
  // Unauthorized -> 401
  const resUnauth = await requestWorker("/api/admin/overview");
  assert.equal(resUnauth.status, 401);

  // Admin -> 200 OK
  const resAdmin = await requestWorker("/api/admin/overview", {
    headers: {
      "x-admin-key": "synthetic-admin-secret",
    },
  });
  assert.equal(resAdmin.status, 200);
  const data = await resAdmin.json();
  assert.equal(data.isSynthetic, true);
  assert.ok(data.totals.totalUsers > 0);
  assert.ok(Array.isArray(data.topSubjects));
  assert.ok(Array.isArray(data.recentKeywords));
});
