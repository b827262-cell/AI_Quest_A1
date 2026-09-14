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
      "oai-authenticated-user-role": "admin",
    },
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
