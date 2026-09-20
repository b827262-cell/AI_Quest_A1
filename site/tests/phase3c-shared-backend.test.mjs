import assert from "node:assert/strict";
import test from "node:test";

async function requestWorker(pathname, options = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  const req = new Request(`${options.origin ?? "http://localhost"}${pathname}`, {
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
      RELEASE_VALIDATION_SECRET: options.releaseValidationSecret,
    },
    { waitUntil() {}, passThroughOnException() {} }
  );
}

test("Phase 3C: GET /api/health exposes staging-only backend state without D1 binding", async () => {
  const res = await requestWorker("/api/health");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.edge, "cloudflare-worker");
  assert.equal(data.d1, "unbound");
  assert.equal(data.phase, 2);
  assert.equal(data.role, "standalone");
  assert.equal(data.backendTarget, "disabled-or-staging-only");
});

test("Isolation: an unconfigured staging backend never makes an outbound proxy request", async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.NODE_ENV = "production";
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("outbound fetch must not occur when staging backend is disabled");
  };

  try {
    const res = await requestWorker("/api/student/me", {
      origin: "https://ai-quest-a1-student-staging.b827262.chatgpt.site",
    });
    assert.equal(res.status, 200);
    assert.equal(fetchCalls, 0);
  } finally {
    process.env.NODE_ENV = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

test("Phase 3C: OPTIONS preflight on /api/student/progress returns 204 with allowed CORS headers", async () => {
  const res = await requestWorker("/api/student/progress", {
    method: "OPTIONS",
    headers: {
      origin: "https://ai-quest-a1-student-staging.b827262.chatgpt.site",
      "access-control-request-method": "PUT",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get("access-control-allow-origin"),
    "https://ai-quest-a1-student-staging.b827262.chatgpt.site"
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

test("Phase 3C: Production rejects synthetic bearer bypass even with the former public gate header", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    // 1. A public header must not turn the committed student fixture into production auth.
    const resStudent = await requestWorker("/api/student/me", {
      headers: {
        authorization: "Bearer B1JUbt5YFSgGvo1XvJXqq5hYx3LIETptM8VT-6ZBKxw",
        "x-validation-gate": "e500-release-validation-20260914",
      },
    });
    assert.equal(resStudent.status, 200);
    const dataStudent = await resStudent.json();
    assert.equal(dataStudent.authenticated, false);
    assert.equal(dataStudent.guest, true);

    // 2. The committed admin fixture must also remain unauthorized.
    const resAdmin = await requestWorker("/api/admin/auth/me", {
      headers: {
        authorization: "Bearer 3wdv7mrWFW85fy0Sj7p2mXRBp84v4LlVigJHGM10siw",
        "x-validation-gate": "e500-release-validation-20260914",
      },
    });
    assert.equal(resAdmin.status, 401);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Phase 3C: Production validation bearer requires the configured server-side gate secret", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const releaseValidationSecret = "synthetic-unit-test-gate-secret-32-bytes";

  try {
    const resStudent = await requestWorker("/api/student/me", {
      headers: {
        authorization: "Bearer B1JUbt5YFSgGvo1XvJXqq5hYx3LIETptM8VT-6ZBKxw",
        "x-validation-gate": releaseValidationSecret,
      },
      releaseValidationSecret,
    });
    assert.equal(resStudent.status, 200);
    assert.equal((await resStudent.json()).role, "student");

    const resAdmin = await requestWorker("/api/admin/auth/me", {
      headers: {
        authorization: "Bearer 3wdv7mrWFW85fy0Sj7p2mXRBp84v4LlVigJHGM10siw",
        "x-validation-gate": releaseValidationSecret,
      },
      releaseValidationSecret,
    });
    assert.equal(resAdmin.status, 200);
    assert.equal((await resAdmin.json()).role, "admin");
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Phase 3C: Production rejects the synthetic admin-key fixture", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const res = await requestWorker("/api/admin/auth/me", {
      headers: { "x-admin-key": "synthetic-admin-secret" },
    });
    assert.equal(res.status, 401);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});
