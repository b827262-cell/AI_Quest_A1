import assert from "node:assert/strict";
import test from "node:test";

async function requestWorker(pathname, options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  const req = new Request(`http://localhost${pathname}`, {
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    method: options.method ?? "GET",
    body: options.body ? JSON.stringify(options.body) : undefined,
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

test("Phase 3C: GET /api/health exposes unified shared backend target and D1 project", async () => {
  const res = await requestWorker("/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.edge, "cloudflare-worker");
  assert.equal(data.d1, "bound");
  assert.equal(data.phase, 2);
  assert.equal(data.backendTarget, "https://ai-quest-a1-backend.b827262.chatgpt.site");
  assert.equal(data.sharedD1Project, "appgprj_6aa80235182c8191a876361138ecbc36");
});

test("Phase 3C: OPTIONS preflight on /api/student/progress returns 204 with allowed CORS headers", async () => {
  const res = await requestWorker("/api/student/progress", {
    method: "OPTIONS",
    headers: {
      origin: "https://ai-quest-a1-student.b827262.chatgpt.site",
      "access-control-request-method": "PUT",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get("access-control-allow-origin"),
    "https://ai-quest-a1-student.b827262.chatgpt.site"
  );
  assert.ok(res.headers.get("access-control-allow-methods")?.includes("PUT"));
});

test("Phase 3C: Production disallowed cross-origin returns 403 cors_forbidden", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const res = await requestWorker("/api/student/progress", {
      headers: {
        origin: "https://unauthorized-attacker.example.com",
      },
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.error, "cors_forbidden");
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Phase 3C: Gated security - Production bearer bypass is rejected without validation gate header", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    // 1. Student endpoint with bearer token but missing validation gate -> treated as guest
    const resStudent = await requestWorker("/api/student/me", {
      headers: {
        authorization: "Bearer B1JUbt5YFSgGvo1XvJXqq5hYx3LIETptM8VT-6ZBKxw",
      },
    });
    assert.equal(resStudent.status, 200);
    const dataStudent = await resStudent.json();
    assert.equal(dataStudent.authenticated, false);
    assert.equal(dataStudent.guest, true);

    // 2. Admin endpoint with bearer token but missing validation gate -> 401 unauthorized
    const resAdmin = await requestWorker("/api/admin/auth/me", {
      headers: {
        authorization: "Bearer 3wdv7mrWFW85fy0Sj7p2mXRBp84v4LlVigJHGM10siw",
      },
    });
    assert.equal(resAdmin.status, 401);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Phase 3C: Gated security - Production bearer bypass is accepted with active validation gate header", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    // 1. Student with validation gate header
    const resStudent = await requestWorker("/api/student/me", {
      headers: {
        authorization: "Bearer B1JUbt5YFSgGvo1XvJXqq5hYx3LIETptM8VT-6ZBKxw",
        "x-validation-gate": "e500-release-validation-20260914",
      },
    });
    assert.equal(resStudent.status, 200);
    const dataStudent = await resStudent.json();
    assert.equal(dataStudent.authenticated, true);
    assert.equal(dataStudent.role, "student");
    assert.equal(dataStudent.user?.id, "student-synth-001");

    // 2. Admin with validation gate header
    const resAdmin = await requestWorker("/api/admin/auth/me", {
      headers: {
        authorization: "Bearer 3wdv7mrWFW85fy0Sj7p2mXRBp84v4LlVigJHGM10siw",
        "x-validation-gate": "e500-release-validation-20260914",
      },
    });
    assert.equal(resAdmin.status, 200);
    const dataAdmin = await resAdmin.json();
    assert.equal(dataAdmin.authenticated, true);
    assert.equal(dataAdmin.role, "admin");
    assert.equal(dataAdmin.user?.id, "admin-synth-001");
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});
