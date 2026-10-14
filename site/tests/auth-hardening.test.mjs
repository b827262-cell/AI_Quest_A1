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
      ...(options.env ?? {}),
    },
    { waitUntil() {}, passThroughOnException() {} }
  );
}

test("Phase 3B: Missing auth returns unauthenticated guest status", async () => {
  const res = await requestWorker("/api/student/me");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.authenticated, false);
  assert.equal(data.guest, true);
});

test("Phase 3B: Inconsistent auth headers (userId without email) returns 401 malformed_auth", async () => {
  const res = await requestWorker("/api/student/me", {
    headers: {
      "oai-authenticated-user-id": "usr-12345",
      // Missing oai-authenticated-user-email
    },
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "malformed_auth");
  assert.match(data.message, /inconsistent/i);
});

test("Phase 3B: Malformed email syntax in auth headers returns 401 malformed_auth", async () => {
  const res = await requestWorker("/api/student/me", {
    headers: {
      "oai-authenticated-user-id": "usr-12345",
      "oai-authenticated-user-email": "not-an-email-address",
    },
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "malformed_auth");
  assert.match(data.message, /malformed user-email/i);
});

test("Phase 3B: Invalid name encoding header returns 401 malformed_auth", async () => {
  const res = await requestWorker("/api/student/me", {
    headers: {
      "oai-authenticated-user-id": "usr-12345",
      "oai-authenticated-user-email": "user@example.test",
      "oai-authenticated-user-full-name": "Test User",
      "oai-authenticated-user-full-name-encoding": "iso-8859-1", // invalid expected encoding
    },
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "malformed_auth");
  assert.match(data.message, /invalid name encoding/i);
});

test("Phase 3B: Corrupt percent-encoded name header returns 401 malformed_auth", async () => {
  const res = await requestWorker("/api/student/me", {
    headers: {
      "oai-authenticated-user-id": "usr-12345",
      "oai-authenticated-user-email": "user@example.test",
      "oai-authenticated-user-full-name": "%E0%A4%A", // invalid truncated UTF-8 percent sequence
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, "malformed_auth");
  assert.match(data.message, /malformed percent-encoded/i);
});

test("Phase 3B: Valid student auth succeeds on student routes", async () => {
  const res = await requestWorker("/api/student/me", {
    headers: {
      "oai-authenticated-user-id": "std-42",
      "oai-authenticated-user-email": "student.charlie@synthetic.ai-smartbook.test",
      "oai-authenticated-user-full-name": "Charlie%20Brown",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.authenticated, true);
  assert.equal(data.user.id, "std-42");
  assert.equal(data.user.displayName, "Charlie Brown");
  assert.equal(data.role, "student");
});

test("Phase 3B: Valid admin auth succeeds on admin routes", async () => {
  const res = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "adm-01",
      "oai-authenticated-user-email": "admin.master@synthetic.ai-smartbook.test",
    },
    // Administrator privilege now comes from the server-side allowlist, not a
    // client-supplied role header.
    env: { ADMIN_EMAILS: "admin.master@synthetic.ai-smartbook.test" },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.authenticated, true);
  assert.equal(data.role, "admin");
});

test("Phase 3B: Student attempting to access admin route returns HTTP 403 Forbidden", async () => {
  const res = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "std-42",
      "oai-authenticated-user-email": "student.alice@synthetic.ai-smartbook.test",
      "oai-authenticated-user-role": "student",
    },
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /admin permission required/i);
});

test("Phase 3B: Production anonymous progress write is forbidden (401)", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const res = await requestWorker("/api/student/progress", {
      method: "PUT",
      body: { bookId: "book-synth-001", progressPercent: 95 },
    });
    assert.equal(res.status, 401);
    const data = await res.json();
    assert.equal(data.error, "unauthorized");
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Phase 3B: Production anonymous student/me never returns synthetic student identity", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const res = await requestWorker("/api/student/me");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.authenticated, false);
    assert.equal(data.guest, true);
    assert.equal(data.user, null);
    assert.equal(data.defaultStudent, undefined);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Phase 3B: Valid authenticated progress write and persistence across requests", async () => {
  const authHeaders = {
    "oai-authenticated-user-id": "student-persistence-tester",
    "oai-authenticated-user-email": "student.tester@synthetic.ai-smartbook.test",
  };

  const putRes = await requestWorker("/api/student/progress", {
    method: "PUT",
    headers: authHeaders,
    body: {
      bookId: "book-synth-001",
      progressPercent: 92,
      lastReadChapter: "ch-05-microarchitecture",
      lastReadPage: 85,
    },
  });
  assert.equal(putRes.status, 200);
  const putData = await putRes.json();
  assert.equal(putData.success, true);
  assert.equal(putData.updated.progressPercent, 92);

  const getRes = await requestWorker("/api/student/progress", {
    headers: authHeaders,
  });
  assert.equal(getRes.status, 200);
  const getData = await getRes.json();
  const bookProgress = getData.progress.find((p) => p.bookId === "book-synth-001");
  assert.ok(bookProgress);
  assert.equal(bookProgress.progressPercent, 92);
  assert.equal(bookProgress.lastReadChapter, "ch-05-microarchitecture");
  assert.equal(bookProgress.lastReadPage, 85);
});

// Issue #47: administrator privilege comes from an explicit server-side
// allowlist (ADMIN_EMAILS), never from an email substring or a role header.

test("Issue #47: an email containing 'admin' is not an administrator without an allowlist match", async () => {
  const res = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "usr-substr",
      "oai-authenticated-user-email": "admin.imposter@example.test",
    },
    env: { ADMIN_EMAILS: "owner@example.test" },
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /admin permission required/i);
});

test("Issue #47: an exact allowlist match is an administrator", async () => {
  const res = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "usr-owner",
      "oai-authenticated-user-email": "owner@example.test",
    },
    env: { ADMIN_EMAILS: "owner@example.test" },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.role, "admin");
});

test("Issue #47: allowlist matching folds case and ignores surrounding whitespace", async () => {
  const res = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "usr-owner",
      "oai-authenticated-user-email": "Owner@Example.Test",
    },
    env: { ADMIN_EMAILS: "  owner@example.test , second@example.test " },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.role, "admin");
});

test("Issue #47: an unset allowlist grants nobody administrator", async () => {
  const res = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "usr-owner",
      "oai-authenticated-user-email": "owner@example.test",
    },
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /admin permission required/i);
});

test("Issue #47: production with an unset allowlist fails closed", async () => {
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const res = await requestWorker("/api/admin/auth/me", {
      headers: {
        "oai-authenticated-user-id": "usr-owner",
        "oai-authenticated-user-email": "owner@example.test",
      },
    });
    assert.equal(res.status, 403);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Issue #47: a forged oai-authenticated-user-role header never grants admin", async () => {
  const res = await requestWorker("/api/admin/auth/me", {
    headers: {
      "oai-authenticated-user-id": "usr-forged",
      "oai-authenticated-user-email": "forged@example.test",
      "oai-authenticated-user-role": "admin",
    },
    env: { ADMIN_EMAILS: "owner@example.test" },
  });
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.match(data.error, /admin permission required/i);
});

test("Issue #47: the synthetic x-admin-key works outside production and is inert in production", async () => {
  const allowed = await requestWorker("/api/admin/auth/me", {
    headers: { "x-admin-key": "synthetic-admin-secret" },
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).role, "admin");

  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const blocked = await requestWorker("/api/admin/auth/me", {
      headers: { "x-admin-key": "synthetic-admin-secret" },
    });
    assert.equal(blocked.status, 401);
  } finally {
    process.env.NODE_ENV = originalEnv;
  }
});

test("Issue #47: health reports the allowlist state without exposing any address", async () => {
  const unset = await requestWorker("/api/health");
  const unsetBody = await unset.json();
  assert.equal(unsetBody.adminAllowlist, "unset");
  assert.equal(JSON.stringify(unsetBody).includes("example.test"), false);

  const configured = await requestWorker("/api/health", {
    env: { ADMIN_EMAILS: "owner@example.test" },
  });
  const configuredBody = await configured.json();
  assert.equal(configuredBody.adminAllowlist, "configured");
  assert.equal(JSON.stringify(configuredBody).includes("example.test"), false);
});
