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
      // Administrator privilege is allowlist-driven (issue #47); the synthetic
      // admin identity used by these tests is configured here.
      ADMIN_EMAILS: options.adminEmails ?? "admin@synthetic.ai-smartbook.test",
      ...(options.env ?? {}),
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
  // Staging predeploy: no D1/R2 bindings are attached, so the health endpoint
  // derived from the live worker environment reports unbound.
  assert.equal(data.d1, "unbound");
  assert.equal(data.phase, 2);
});

test("GET /api/health reports edge gate observability without exposing secrets", async () => {
  // Unset: the gate defaults to accept and reports no usable secrets.
  const resDefault = await requestWorker("/api/health");
  const textDefault = await resDefault.text();
  const dataDefault = JSON.parse(textDefault);
  assert.equal(dataDefault.edgeMode, "accept");
  assert.deepEqual(dataDefault.edgeSecrets, { student: 0, admin: 0 });
  assert.equal(dataDefault.edgeSecretsDistinct, true);

  const student = "health-student-edge-secret-for-local-tests-1234567";
  const studentPrev = "health-student-previous-edge-secret-local-1234567";
  const admin = "health-admin-edge-secret-for-local-tests-123456789";
  const shared = "health-shared-edge-secret-for-local-tests-123456789";
  const tooShort = "too-short";

  // Configured: current + previous student secrets and one admin secret count;
  // a too-short value never counts.
  const resConfigured = await requestWorker("/api/health", {
    env: {
      A01_RELAY_EDGE_MODE: "require",
      A01_RELAY_EDGE_SECRET_STUDENT: student,
      A01_RELAY_EDGE_SECRET_STUDENT_PREV: studentPrev,
      A01_RELAY_EDGE_SECRET_ADMIN: admin,
    },
  });
  const textConfigured = await resConfigured.text();
  const dataConfigured = JSON.parse(textConfigured);
  assert.equal(dataConfigured.edgeMode, "require");
  assert.deepEqual(dataConfigured.edgeSecrets, { student: 2, admin: 1 });
  assert.equal(dataConfigured.edgeSecretsDistinct, true);

  // Cross-site reuse invalidates both sites; too-short values are ignored.
  const resReuse = await requestWorker("/api/health", {
    env: {
      A01_RELAY_EDGE_SECRET_STUDENT: shared,
      A01_RELAY_EDGE_SECRET_STUDENT_PREV: tooShort,
      A01_RELAY_EDGE_SECRET_ADMIN: shared,
    },
  });
  const textReuse = await resReuse.text();
  const dataReuse = JSON.parse(textReuse);
  assert.deepEqual(dataReuse.edgeSecrets, { student: 0, admin: 0 });
  assert.equal(dataReuse.edgeSecretsDistinct, false);

  // The serialized response must never contain any configured secret string.
  const serialized = [textDefault, textConfigured, textReuse].join("\n");
  for (const secret of [student, studentPrev, admin, shared, tooShort]) {
    assert.equal(serialized.includes(secret), false, `health response leaked "${secret}"`);
  }
});

async function captureWarnings(run) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try { await run(warnings); }
  finally { console.warn = original; }
}

const secondaryHealthEnv = (site, extra = {}) => ({
  SITE_ROLE: "secondary", SITE_NAME: site, PRIMARY_ORIGIN: "https://primary.example.test", ...extra,
});

test("secondary health reports a missing sender secret and warns only once across repeated probes", async () => {
  await captureWarnings(async (warnings) => {
    for (let i = 0; i < 2; i++) {
      const response = await requestWorker("/api/health", {
        env: secondaryHealthEnv("student", { A01_RELAY_EDGE_MODE: "require" }),
      });
      assert.equal(response.status, 200, "health remains exempt and available in require mode");
      const data = await response.json();
      assert.equal(data.edgeSenderSecret, "missing");
      assert.equal(data.edgeMode, "require");
      assert.deepEqual(data.edgeSecrets, { student: 0, admin: 0 });
      assert.equal(data.edgeSecretsDistinct, true);
    }
    assert.deepEqual(warnings, ["[relay] secondary edge sender secret is missing or invalid"]);
  });
});

test("secondary health recognizes only the valid current secret for its own site without exposing it", async () => {
  await captureWarnings(async (warnings) => {
    for (const [site, secret] of [["student", "s".repeat(32)], ["admin", "a".repeat(512)]]) {
      const previous = "previous-local-edge-secret-for-health-123456789";
      const response = await requestWorker("/api/health", { env: secondaryHealthEnv(site, {
        [`A01_RELAY_EDGE_SECRET_${site.toUpperCase()}`]: secret,
        [`A01_RELAY_EDGE_SECRET_${site.toUpperCase()}_PREV`]: previous,
      }) });
      assert.equal(response.status, 200);
      const text = await response.text();
      const data = JSON.parse(text);
      assert.equal(data.edgeSenderSecret, "present");
      assert.equal(data.edgeSecrets[site], 2, "#67 current + previous counts remain unchanged");
      assert.equal(text.includes(secret), false);
      assert.equal(text.includes(previous), false);
    }
    assert.deepEqual(warnings, []);
  });
});

test("secondary health treats invalid, other-site and previous-only sender secrets as missing in either mode", async () => {
  const other = "other-site-only-local-edge-secret-123456789";
  const previous = "previous-only-local-edge-secret-123456789";
  await captureWarnings(async (warnings) => {
    for (const mode of ["accept", "require"]) {
      for (const value of [undefined, "i".repeat(31), "i".repeat(513), 123]) {
        const response = await requestWorker("/api/health", { env: secondaryHealthEnv("admin", {
          A01_RELAY_EDGE_MODE: mode, A01_RELAY_EDGE_SECRET_ADMIN: value,
          A01_RELAY_EDGE_SECRET_ADMIN_PREV: previous, A01_RELAY_EDGE_SECRET_STUDENT: other,
        }) });
        assert.equal(response.status, 200);
        const text = await response.text();
        const data = JSON.parse(text);
        assert.equal(data.edgeSenderSecret, "missing");
        assert.deepEqual(data.edgeSecrets, { student: 1, admin: 1 }, "#67 still counts the valid previous key");
        for (const secret of [other, previous, ...(typeof value === "string" ? [value] : [])]) {
          assert.equal(text.includes(secret), false);
          assert.equal(warnings.join("\n").includes(secret), false);
        }
      }
    }
    assert.deepEqual(warnings, ["[relay] secondary edge sender secret is missing or invalid"]);
  });
});

test("non-secondary health keeps #67 fields and does not add a sender field or warning", async () => {
  await captureWarnings(async (warnings) => {
    const shared = "shared-local-edge-secret-health-123456789";
    for (const env of [{}, { SITE_ROLE: "primary", SITE_NAME: "backend" }, { SITE_ROLE: "invalid", SITE_NAME: "student" }]) {
      const response = await requestWorker("/api/health", { env: { ...env,
        A01_RELAY_EDGE_SECRET_STUDENT: shared, A01_RELAY_EDGE_SECRET_ADMIN: shared,
      } });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(Object.hasOwn(data, "edgeSenderSecret"), false);
      assert.deepEqual(data.edgeSecrets, { student: 0, admin: 0 });
      assert.equal(data.edgeSecretsDistinct, false);
    }
    assert.deepEqual(warnings, []);
  });
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
