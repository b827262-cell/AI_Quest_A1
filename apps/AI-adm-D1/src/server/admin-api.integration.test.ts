import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdminApp } from "./app";
import { createGuestUsageStore } from "./guest-usage-store";
import { createAdminTestDependencies } from "./dependencies";
import { createDbHandle, type DbHandle } from "@ai-smartbook/db";
import { createAdminSessionSecrets, digestAdminSecret } from "./ai/admin-auth";
import { createStudentSessionSecrets, digestStudentSecret } from "@ai-smartbook/auth/server";

const temporaryDirectories: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function buildTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "ai-smartbook-admin-api-"));
  temporaryDirectories.push(directory);
  const dbHandle: DbHandle = createDbHandle(join(directory, "admin.db"));
  const token = "phase-a-test-token";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    ADMIN_API_TOKEN: token,
    AI_CREDENTIAL_ENCRYPTION_KEY: "phase-a-test-encryption-key-0123456789",
    AI_PROVIDER: "mock",
    AI_GATEWAY_ENABLED: "false",
    ADMIN_ALLOWED_ORIGINS: "http://127.0.0.1:5174",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "test-password",
    ADMIN_SESSION_SECURE: "true"
  };
  process.env = { ...process.env, ...env, SQLITE_PATH: join(directory, "admin.db") };
  delete process.env.ADMIN_PASSWORD_HASH;
  const dependencies = createAdminTestDependencies(process.env, dbHandle);
  return { app: createAdminApp(dependencies, undefined, () => "2026-11-12"), dependencies, dbHandle, token };
}

function seedCredential(dependencies: ReturnType<typeof createAdminTestDependencies>) {
  const provider = dependencies.repos.aiProviders.createConfig({
    provider: "openai",
    slug: "integration-openai",
    displayName: "Integration OpenAI",
    model: "gpt-5.6-terra",
    enabled: true,
    isDefault: true,
    isRouterProvider: true,
    priority: 10
  }).row;
  const credential = dependencies.repos.aiProviders.createCredential({
    providerConfigId: provider.id,
    name: "Integration Credential",
    encryptedApiKey: "test-encrypted-api-key",
    maskedApiKey: "tes****-key",
    keyFingerprint: randomBytes(32).toString("hex"),
    model: "gpt-5.6-terra"
  });
  return { provider, credential };
}

function cookieHeader(setCookie: string[] | undefined): string {
  return (setCookie ?? []).map((value) => value.split(";", 1)[0]).join("; ");
}

function cookieValue(setCookie: string[] | undefined, name: string): string {
  const entry = (setCookie ?? []).find((value) => value.startsWith(`${name}=`));
  if (!entry) throw new Error(`missing ${name} cookie`);
  return entry.slice(name.length + 1).split(";", 1)[0];
}

async function login(app: ReturnType<typeof createAdminApp>) {
  const response = await request(app)
    .post("/api/admin/auth/login")
    .set("Origin", "http://127.0.0.1:5174")
    .send({ username: "admin", password: "test-password" });
  expect(response.status).toBe(200);
  const cookies = response.headers["set-cookie"] as unknown as string[];
  return { cookies, cookieHeader: cookieHeader(cookies), csrf: cookieValue(cookies, "ai_admin_csrf") };
}

describe("Admin API HTTP authentication and quota behavior", () => {
  it("returns safe validation fields for an empty public guest question", async () => {
    const { app, dbHandle } = buildTestApp();
    const response = await request(app).post("/api/public/guest-ask").send({});
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "請求內容格式不正確", code: "invalid_request", fields: ["question"] });
    expect(response.body.error).not.toMatch(/\[|"code"|invalid_type/);
    dbHandle.sqlite.close();
  });

  it("keeps guest quotas independent for distinct Cloudflare client IPs", async () => {
    const { app, dependencies, dbHandle } = buildTestApp();
    const gateway = vi.spyOn(dependencies.aiGateway, "run").mockResolvedValue({
      result: { provider: "mock", model: "test", answer: "這是測試答案。", latencyMs: 0 }
    } as Awaited<ReturnType<typeof dependencies.aiGateway.run>>);
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const ask = (ip: string) => request(app).post("/api/public/guest-ask")
        .set("CF-Connecting-IP", ip).send({ question: "測試題目" });
      const first = await ask("203.0.113.41");
      const second = await ask("203.0.113.42");
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.remainingGuestQuestions).toBe(2);
      expect(second.body.remainingGuestQuestions).toBe(2);
      now += 21_000;
      const again = await ask("203.0.113.41");
      expect(again.status).toBe(200);
      expect(again.body.remainingGuestQuestions).toBe(1);
      const otherAgain = await ask("203.0.113.42");
      expect(otherAgain.status).toBe(200);
      expect(otherAgain.body.remainingGuestQuestions).toBe(1);
    } finally { clock.mockRestore(); gateway.mockRestore(); dbHandle.sqlite.close(); }
  });

  it("returns busy at capacity and evicts an exhausted IP after one hour", async () => {
    const { dependencies, dbHandle } = buildTestApp();
    const warning = vi.fn();
    const store = createGuestUsageStore({ capacity: 1, warn: warning });
    const app = createAdminApp(dependencies, store, () => "2026-11-12");
    const gateway = vi.spyOn(dependencies.aiGateway, "run").mockResolvedValue({
      result: { provider: "mock", model: "test", answer: "測試答案。", latencyMs: 0 }
    } as Awaited<ReturnType<typeof dependencies.aiGateway.run>>);
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const ask = (ip: string) => request(app).post("/api/public/guest-ask").set("CF-Connecting-IP", ip).send({ question: "測試題目" });
      for (let i = 0; i < 3; i++) {
        expect((await ask("203.0.113.61")).status).toBe(200);
        now += 21_000;
      }
      const denied = await ask("203.0.113.62");
      expect(denied.status).toBe(503);
      expect(denied.headers["retry-after"]).toBe("60");
      expect(denied.body).toEqual({ status: "busy", message: "訪客服務目前繁忙，請稍後再試或登入使用" });
      const original = await ask("203.0.113.61");
      expect(original.status).toBe(429);
      expect(original.body.remainingGuestQuestions).toBe(0);
      expect(warning).toHaveBeenCalledOnce();
      now += 3_600_001;
      const admitted = await ask("203.0.113.62");
      expect(admitted.status).toBe(200);
      expect(admitted.body.remainingGuestQuestions).toBe(2);
    } finally { clock.mockRestore(); gateway.mockRestore(); dbHandle.sqlite.close(); }
  });

  it("exposes guest usage saturation diagnostics only to authenticated admins", async () => {
    const { dependencies, dbHandle, token } = buildTestApp();
    const store = createGuestUsageStore({ capacity: 1, warn: () => {} });
    const app = createAdminApp(dependencies, store, () => "2026-11-12");
    const gateway = vi.spyOn(dependencies.aiGateway, "run").mockResolvedValue({
      result: { provider: "mock", model: "test", answer: "測試答案。", latencyMs: 0 }
    } as Awaited<ReturnType<typeof dependencies.aiGateway.run>>);
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const ask = (ip: string) => request(app).post("/api/public/guest-ask").set("CF-Connecting-IP", ip).send({ question: "測試題目" });
      for (let i = 0; i < 3; i++) {
        expect((await ask("203.0.113.71")).status).toBe(200);
        now += 21_000;
      }
      expect((await ask("203.0.113.72")).status).toBe(503);

      expect((await request(app).get("/api/admin/diagnostics/guest-usage")).status).toBe(401);
      const response = await request(app).get("/api/admin/diagnostics/guest-usage").set("x-admin-token", token);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body.guestUsage).toMatchObject({ size: 1, capacity: 1, day: "2026-11-12", busyCount: 1 });
      expect(typeof response.body.guestUsage.lastSaturatedAt).toBe("number");
      expect(JSON.stringify(response.body)).not.toContain("203.0.113");
    } finally { clock.mockRestore(); gateway.mockRestore(); dbHandle.sqlite.close(); }
  });

  it("uses the Cloudflare IP for admin login throttling and session audit", async () => {
    const { app, dbHandle } = buildTestApp();
    try {
      const loginFrom = (ip: string, username: string, password: string) => request(app)
        .post("/api/admin/auth/login").set("Origin", "http://127.0.0.1:5174")
        .set("CF-Connecting-IP", ip).set("X-Forwarded-For", "198.51.100.99")
        .send({ username, password });
      for (let i = 0; i < 20; i++) expect((await loginFrom("203.0.113.51", `user${i}`, "wrong")).status).toBe(401);
      expect((await loginFrom("203.0.113.51", "another", "wrong")).status).toBe(429);
      expect((await loginFrom("203.0.113.52", "admin", "test-password")).status).toBe(200);
      expect(dbHandle.sqlite.prepare("SELECT ip_address FROM admin_sessions").get()).toEqual({ ip_address: "203.0.113.52" });
    } finally { dbHandle.sqlite.close(); }
  });

  it("warns once at startup when obsolete TRUST_PROXY is configured", () => {
    process.env.TRUST_PROXY = "false";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dbHandle } = buildTestApp();
    try {
      expect(warn).toHaveBeenCalledExactlyOnceWith("TRUST_PROXY is no longer used for client IP resolution; only loopback Cloudflare headers are trusted.");
    } finally { warn.mockRestore(); dbHandle.sqlite.close(); }
  });

  it("returns safe validation fields for an authenticated admin request", async () => {
    const { app, dbHandle } = buildTestApp();
    const session = await login(app);
    const response = await request(app).post("/api/admin/ai-budget-policies")
      .set("Cookie", session.cookieHeader).set("Origin", "http://127.0.0.1:5174")
      .set("x-csrf-token", session.csrf).send({});
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "請求內容格式不正確", code: "invalid_request" });
    expect(response.body.fields).toEqual(expect.arrayContaining(["scopeType", "scopeKey"]));
    expect(response.body.error).not.toMatch(/\[|"code"|invalid_type/);
    dbHandle.sqlite.close();
  });

  it("keeps the localized quota validation message with structured fields", async () => {
    const { app, dependencies, dbHandle } = buildTestApp();
    const { credential } = seedCredential(dependencies);
    const session = await login(app);
    const response = await request(app).post(`/api/admin/ai-credentials/${credential.id}/quotas`)
      .set("Cookie", session.cookieHeader).set("Origin", "http://127.0.0.1:5174")
      .set("x-csrf-token", session.csrf).send({ model: "", rpmLimit: -1 });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_request", error: "模型配額欄位格式不正確；上限須為正整數或留白" });
    expect(response.body.fields).toEqual(expect.arrayContaining(["model"]));
    dbHandle.sqlite.close();
  });

  it("keeps book routes behind Origin, administrator authentication, CSRF and mutation audit", async () => {
    const { app, dependencies, dbHandle, token } = buildTestApp();
    const student = dependencies.repos.studentUsers.create({
      googleSubject: "books-student-subject", email: "books-student@example.test", displayName: "Books Student"
    });
    const { sessionToken } = createStudentSessionSecrets();
    dependencies.repos.studentSessions.create({
      tokenDigest: digestStudentSecret(sessionToken),
      userId: student.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });

    expect((await request(app).get("/api/admin/books")).status).toBe(401);
    expect((await request(app).get("/api/admin/books")
      .set("Cookie", `ai_student_session=${sessionToken}`)).status).toBe(401);
    expect((await request(app).get("/api/admin/books")
      .set("x-admin-token", token).set("Origin", "https://not-admin.example.test")).status).toBe(403);
    const authorized = await request(app).get("/api/admin/books").set("x-admin-token", token);
    expect(authorized.status).toBe(200);
    expect(authorized.body).toEqual({ books: [] });

    const session = await login(app);
    const blockedMutation = await request(app).post("/api/admin/books")
      .set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174")
      .send({ title: "Test Book" });
    expect(blockedMutation.status).toBe(403);
    const created = await request(app).post("/api/admin/books")
      .set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174")
      .set("x-csrf-token", session.csrf)
      .send({ title: "Test Book" });
    expect(created.status).toBe(201);
    const audits = dbHandle.sqlite.prepare("SELECT action, metadata_json FROM ai_admin_audit_logs").all() as
      Array<{ action: string; metadata_json: string }>;
    expect(audits.some((row) => row.action === "admin.request.mutation" &&
      row.metadata_json.includes('"path":"/api/admin/books"') &&
      row.metadata_json.includes('"statusCode":201'))).toBe(true);
  });

  it("protects account routes with Origin, authentication and CSRF, and audits successful mutations", async () => {
    const { app, dependencies, dbHandle, token } = buildTestApp();
    const student = dependencies.repos.studentUsers.create({
      googleSubject: "accounts-student-subject", email: "accounts-student@example.test", displayName: "Accounts Student"
    });
    const { sessionToken } = createStudentSessionSecrets();
    dependencies.repos.studentSessions.create({
      tokenDigest: digestStudentSecret(sessionToken), userId: student.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const account = dependencies.repos.chat.createSession({ bookId: "accounts-fixture" });
    const riskPath = `/api/admin/accounts/${account.id}/risk`;
    const blockPath = `/api/admin/accounts/${account.id}/block`;
    expect((await request(app).get("/api/admin/accounts")).status).toBe(401);
    expect((await request(app).patch(riskPath).set("Cookie", `ai_student_session=${sessionToken}`)
      .send({ riskLevel: "risk" })).status).toBe(401);
    expect((await request(app).get("/api/admin/accounts").set("x-admin-token", token)
      .set("Origin", "https://not-admin.example.test")).status).toBe(403);
    const session = await login(app);
    expect((await request(app).patch(riskPath).set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174").send({ riskLevel: "risk" })).status).toBe(403);
    const list = await request(app).get("/api/admin/accounts").set("Cookie", session.cookieHeader);
    expect(list.status).toBe(200);
    expect(list.body.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: account.id })]));
    const risk = await request(app).patch(riskPath).set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174").set("x-csrf-token", session.csrf)
      .send({ riskLevel: "risk", note: "fixture" });
    expect(risk.status).toBe(200);
    expect(risk.body.account).toMatchObject({ id: account.id, riskLevel: "risk", riskNote: "fixture" });
    const blocked = await request(app).patch(blockPath).set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174").set("x-csrf-token", session.csrf)
      .send({ blocked: true, reason: "fixture" });
    expect(blocked.status).toBe(200);
    expect(blocked.body.account).toMatchObject({ id: account.id, isBlocked: true });
    const audits = dbHandle.sqlite.prepare("SELECT action, metadata_json FROM ai_admin_audit_logs").all() as
      Array<{ action: string; metadata_json: string }>;
    for (const path of [riskPath, blockPath]) {
      expect(audits.some((row) => row.action === "admin.request.mutation" &&
        row.metadata_json.includes(`"path":"${path}"`) && row.metadata_json.includes('"statusCode":200'))).toBe(true);
    }
  });

  it("keeps anonymous, student-only and administrator overview access distinct", async () => {
    const { app, dependencies, token } = buildTestApp();
    const student = dependencies.repos.studentUsers.create({
      googleSubject: "student-only-subject", email: "student-only@example.test", displayName: "Student Only"
    });
    const { sessionToken } = createStudentSessionSecrets();
    const studentSession = dependencies.repos.studentSessions.create({
      tokenDigest: digestStudentSecret(sessionToken),
      userId: student.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const studentCookie = `ai_student_session=${sessionToken}`;
    const anonymous = await request(app).get("/api/admin/dashboard/stats");
    const studentOnly = await request(app).get("/api/admin/dashboard/stats").set("Cookie", studentCookie);
    const wrongOrigin = await request(app).get("/api/admin/dashboard/stats")
      .set("x-admin-token", token).set("Origin", "https://not-admin.example.test");
    const administrator = await request(app).get("/api/admin/dashboard/stats").set("x-admin-token", token);

    expect(studentSession.userId).toBe(student.id);
    expect(anonymous.status).toBe(401);
    expect(studentOnly.status).toBe(401);
    expect(wrongOrigin.status).toBe(403);
    expect(administrator.status).toBe(200);
    expect(administrator.body).toMatchObject({
      totalUsers: 1, activeUsers: 0, totalConversations: 0, totalMessages: 0,
      dailyConversations: [], source: "real", isSynthetic: false
    });
    for (const response of [anonymous, studentOnly, wrongOrigin, administrator]) {
      expect(JSON.stringify(response.body)).not.toMatch(/student-only@example\.test|student-only-subject|session_/);
    }
  });

  it("returns student identity count and aggregate-only overview metadata", async () => {
    const { app, dependencies, token } = buildTestApp();
    expect((await request(app).get("/api/admin/dashboard/stats")).status).toBe(401);
    dependencies.repos.studentUsers.create({
      googleSubject: "fixture-subject", email: "fixture@example.test", displayName: "Fixture Student"
    });
    const recent = dependencies.repos.chat.createSession({ bookId: "fixture-book" });
    dependencies.repos.chat.createSession({ bookId: "fixture-book" });
    dependencies.repos.chat.addMessage({ sessionId: recent.id, role: "user", content: "private fixture question" });
    const response = await request(app).get("/api/admin/dashboard/stats?range=all").set("x-admin-token", token);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalUsers: 1, activeUsers: 2, totalConversations: 2, totalMessages: 1,
      source: "real", isSynthetic: false
    });
    expect(response.body.dailyConversations).toHaveLength(1);
    expect(response.body.dailyConversations[0].count).toBe(1);
    expect(Number.isNaN(Date.parse(response.body.asOf))).toBe(false);
    expect(JSON.stringify(response.body)).not.toMatch(/fixture@example\.test|private fixture question|session_/);
  });

  it("returns 503 and no data when the student count source is unavailable", async () => {
    const { app, dependencies, token } = buildTestApp();
    vi.spyOn(dependencies.repos.studentUsers, "count").mockImplementation(() => {
      throw new Error("fixture unavailable");
    });
    const response = await request(app).get("/api/admin/dashboard/stats").set("x-admin-token", token);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      totalUsers: 0, activeUsers: 0, totalConversations: 0, totalMessages: 0,
      dailyConversations: [], source: "unavailable", isSynthetic: false
    });
    expect(JSON.stringify(response.body)).not.toContain("fixture unavailable");
  });

  it("supports login, me, session access, CSRF, logout and failed credentials", async () => {
    const { app, dbHandle } = buildTestApp();

    const failed = await request(app)
      .post("/api/admin/auth/login")
      .set("Origin", "http://127.0.0.1:5174")
      .send({ username: "admin", password: "wrong" });
    expect(failed.status).toBe(401);

    const session = await login(app);
    expect(session.cookies.some((cookie) => /ai_admin_session=.*HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/i.test(cookie))).toBe(true);
    expect(session.cookies.some((cookie) => cookie.startsWith("ai_admin_csrf=") && /Secure/.test(cookie) && /SameSite=Strict/i.test(cookie))).toBe(true);

    const me = await request(app).get("/api/admin/auth/me").set("Cookie", session.cookieHeader);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ authenticated: true, authType: "session", user: { username: "admin" } });
    expect(JSON.stringify(me.body)).not.toContain("test-password");
    expect((await request(app).get("/api/admin/accounts").set("Cookie", session.cookieHeader)).status).toBe(200);

    const blockedMutation = await request(app)
      .post("/api/admin/auth/logout")
      .set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174");
    expect(blockedMutation.status).toBe(403);

    const logout = await request(app)
      .post("/api/admin/auth/logout")
      .set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174")
      .set("x-csrf-token", session.csrf);
    expect(logout.status).toBe(204);
    expect((await request(app).get("/api/admin/accounts").set("Cookie", session.cookieHeader)).status).toBe(401);
    const actions = (dbHandle.sqlite.prepare("SELECT action FROM ai_admin_audit_logs ORDER BY created_at").all() as Array<{ action: string }>).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining([
      "admin.auth.login.failed",
      "admin.auth.login.succeeded",
      "admin.auth.logout"
    ]));
  });

  it("rejects expired and revoked browser sessions", async () => {
    const { app, dependencies } = buildTestApp();
    for (const state of ["expired", "revoked"] as const) {
      const secrets = createAdminSessionSecrets();
      const session = dependencies.repos.adminSessions.create({
        tokenDigest: digestAdminSecret(secrets.sessionToken),
        csrfTokenDigest: digestAdminSecret(secrets.csrfToken),
        username: "admin",
        expiresAt: state === "expired"
          ? new Date(Date.now() - 1_000).toISOString()
          : new Date(Date.now() + 60_000).toISOString()
      });
      if (state === "revoked") dependencies.repos.adminSessions.revokeById(session.id);
      const response = await request(app)
        .get("/api/admin/accounts")
        .set("Cookie", `ai_admin_session=${secrets.sessionToken}; ai_admin_csrf=${secrets.csrfToken}`);
      expect(response.status).toBe(401);
    }
  });

  it("protects accounts with token authentication and exposes health endpoints", async () => {
    const { app, token } = buildTestApp();

    expect((await request(app).get("/health/live")).status).toBe(200);
    expect((await request(app).get("/health/ready")).status).toBe(200);
    expect((await request(app).get("/api/admin/accounts")).status).toBe(401);
    expect((await request(app).get("/api/admin/accounts").set("x-admin-token", "wrong-token")).status).toBe(401);
    expect((await request(app).get("/api/admin/accounts").set("x-admin-token", token)).status).toBe(200);
    expect((await request(app).get("/api/admin/accounts").set("Authorization", `Bearer ${token}`)).status).toBe(200);
  });

  it("serves the main admin collections through the real Express app", async () => {
    const { app, token } = buildTestApp();
    const responses = await Promise.all([
      request(app).get("/api/admin/accounts").set("x-admin-token", token),
      request(app).get("/api/admin/books").set("x-admin-token", token),
      request(app).get("/api/admin/ai-providers").set("x-admin-token", token)
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  });

  it("accepts nullable pricing and prevents duplicate credential model quotas", async () => {
    const { app, dependencies, token } = buildTestApp();
    const { credential } = seedCredential(dependencies);
    const payload = {
      model: "gpt-5.6-luna",
      rpmLimit: null,
      tpmLimit: null,
      rpdLimit: null,
      resetTimezone: "Asia/Taipei",
      enabled: true,
      isDefault: false,
      currency: null,
      serviceTier: null,
      inputPriceUsdPerMillion: null,
      outputPriceUsdPerMillion: null,
      cachedInputPriceUsdPerMillion: null,
      cacheStorageUsdPerMillionTokenHour: null,
      pricingEffectiveAt: null,
      pricingSource: null
    };

    const first = await request(app)
      .post(`/api/admin/ai-credentials/${credential.id}/quotas`)
      .set("x-admin-token", token)
      .send(payload);
    expect(first.status).toBe(201);
    expect(first.body.quota.model).toBe("gpt-5.6-luna");
    expect(first.body.quota.isDefault).toBe(false);
    expect(first.body.quota.currency).toBeNull();

    const duplicate = await request(app)
      .post(`/api/admin/ai-credentials/${credential.id}/quotas`)
      .set("Authorization", `Bearer ${token}`)
      .send(payload);
    expect(duplicate.status).toBe(409);

    const list = await request(app)
      .get(`/api/admin/ai-credentials/${credential.id}/quotas`)
      .set("x-admin-token", token);
    expect(list.status).toBe(200);
    expect(list.body.quotas.filter((quota: { model: string }) => quota.model === "gpt-5.6-luna")).toHaveLength(1);
  });

  it("accepts a null-pricing quota through a browser session with CSRF", async () => {
    const { app, dependencies, dbHandle } = buildTestApp();
    const { credential } = seedCredential(dependencies);
    const session = await login(app);
    const response = await request(app)
      .post(`/api/admin/ai-credentials/${credential.id}/quotas`)
      .set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174")
      .set("x-csrf-token", session.csrf)
      .send({
        model: "gpt-5.6-luna",
        rpmLimit: null,
        tpmLimit: null,
        rpdLimit: null,
        resetTimezone: "Asia/Taipei",
        enabled: true,
        isDefault: false,
        currency: null,
        serviceTier: null,
        inputPriceUsdPerMillion: null,
        outputPriceUsdPerMillion: null,
        cachedInputPriceUsdPerMillion: null,
        cacheStorageUsdPerMillionTokenHour: null,
        pricingEffectiveAt: null,
        pricingSource: null
      });
    expect(response.status).toBe(201);
    expect(response.body.quota).toMatchObject({ model: "gpt-5.6-luna", isDefault: false, pricingSource: null });
    const auditRows = dbHandle.sqlite.prepare("SELECT action, metadata_json FROM ai_admin_audit_logs ORDER BY created_at").all() as Array<{ action: string; metadata_json: string }>;
    expect(auditRows.some((row) => row.action === "admin.request.mutation" && row.metadata_json.includes("admin:session:"))).toBe(true);
  });
});

describe("student questions routes", () => {
  it("enforces the admin boundary and preserves question and deletion behavior", async () => {
    const { app, dependencies, dbHandle, token } = buildTestApp();
    const student = dependencies.repos.studentUsers.create({ googleSubject: "questions-student", email: "questions@example.test", displayName: "Student" });
    const { sessionToken } = createStudentSessionSecrets();
    dependencies.repos.studentSessions.create({ tokenDigest: digestStudentSecret(sessionToken), userId: student.id, expiresAt: "2099-01-01T00:00:00.000Z" });
    const chat = dependencies.repos.chat.createSession({ bookId: "questions-fixture" });
    const older = dependencies.repos.chat.addMessage({ sessionId: chat.id, role: "user", content: "older" });
    const newer = dependencies.repos.chat.addMessage({ sessionId: chat.id, role: "user", content: "newer" });
    const assistant = dependencies.repos.chat.addMessage({ sessionId: chat.id, role: "assistant", content: "answer" });
    const setTime = dbHandle.sqlite.prepare("UPDATE chat_messages SET created_at = ? WHERE id = ?");
    setTime.run("2020-01-01T00:00:00.000Z", older.id);
    setTime.run("2021-01-01T00:00:00.000Z", newer.id);
    const path = "/api/admin/student-questions";
    const routes = [() => request(app).get(path), () => request(app).delete(`${path}/${older.id}`), () => request(app).post(`${path}/delete`).send({ ids: [newer.id] })];
    for (const make of routes) {
      expect((await make()).status).toBe(401);
      expect((await make().set("Cookie", `ai_student_session=${sessionToken}`)).status).toBe(401);
      expect((await make().set("x-admin-token", token).set("Origin", "https://evil.example.test")).status).toBe(403);
    }
    const session = await login(app);
    for (const make of routes.slice(1)) {
      expect((await make().set("Cookie", session.cookieHeader).set("Origin", "http://127.0.0.1:5174")).status).toBe(403);
    }
    const list = await request(app).get(path).set("Cookie", session.cookieHeader);
    expect(list.status).toBe(200);
    expect(list.body.questions.map((q: { id: string }) => q.id)).toEqual([newer.id, older.id]);
    const del = await request(app).delete(`${path}/${older.id}`).set("Cookie", session.cookieHeader).set("Origin", "http://127.0.0.1:5174").set("x-csrf-token", session.csrf);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    const missing = await request(app).delete(`${path}/missing`).set("Cookie", session.cookieHeader).set("Origin", "http://127.0.0.1:5174").set("x-csrf-token", session.csrf);
    expect(missing.body).toEqual({ deleted: true });
    const batch = await request(app).post(`${path}/delete`).set("Cookie", session.cookieHeader).set("Origin", "http://127.0.0.1:5174").set("x-csrf-token", session.csrf).send({ ids: [newer.id, 42, null, {}, "missing"] });
    expect(batch.status).toBe(200);
    expect(batch.body).toEqual({ deleted: 2 });
    expect(dependencies.repos.chat.listAllMessages().map((m) => m.id)).toEqual([assistant.id]);
    const audits = dbHandle.sqlite.prepare("SELECT action, metadata_json FROM ai_admin_audit_logs").all() as Array<{ action: string; metadata_json: string }>;
    for (const auditPath of [`${path}/${older.id}`, `${path}/delete`]) {
      expect(audits.some((row) => row.action === "admin.request.mutation" && row.metadata_json.includes(`"path":"${auditPath}"`) && row.metadata_json.includes('"statusCode":200'))).toBe(true);
    }
  });
});

describe("Phase A backend DTO (P1-1 accounts enrichment, P1-2 guest quota)", () => {
  it("P1-1 enriches accounts with the matching student profile and returns the studentUsers projection", async () => {
    const { app, dependencies, token } = buildTestApp();
    const student = dependencies.repos.studentUsers.create({
      googleSubject: "p1-1-subject", email: "p1-1@example.test", displayName: "P1 Student"
    });
    dependencies.repos.studentUsers.updateProfile(student.id, {
      displayName: "P1 Student",
      schoolName: "Sunrise High",
      gradeLevel: "G10"
    });
    const studentSession = dependencies.repos.chat.createSession({ bookId: "p1-1-book", userId: student.id });
    const anonymousSession = dependencies.repos.chat.createSession({ bookId: "p1-1-anon" });

    const response = await request(app).get("/api/admin/accounts").set("x-admin-token", token);
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("studentUsers");
    expect(Array.isArray(response.body.studentUsers)).toBe(true);

    const returnedStudent = response.body.studentUsers.find((u: { id: string }) => u.id === student.id);
    expect(returnedStudent).toEqual({
      id: student.id,
      displayName: "P1 Student",
      email: "p1-1@example.test",
      schoolName: "Sunrise High",
      gradeLevel: "G10",
      profileCompleted: true,
      createdAt: expect.any(String),
      updatedAt: expect.any(String)
    });

    const enriched = response.body.accounts.find((a: { sessionId: string }) => a.sessionId === studentSession.id);
    const anon = response.body.accounts.find((a: { sessionId: string }) => a.sessionId === anonymousSession.id);
    expect(enriched).toMatchObject({
      sessionId: studentSession.id,
      loginMethod: "帳號登入",
      schoolName: "Sunrise High",
      gradeLevel: "G10",
      email: "p1-1@example.test",
      profileCompleted: true,
      studentDisplayName: "P1 Student"
    });
    expect(anon).toMatchObject({
      sessionId: anonymousSession.id,
      loginMethod: "匿名進入",
      schoolName: null,
      gradeLevel: null,
      email: null,
      profileCompleted: false,
      studentDisplayName: null
    });
  });

  it("P1-2 returns the public guest quota DTO with a no-store cache header", async () => {
    const { app } = buildTestApp();
    const response = await request(app).get("/api/public/guest-quota");
    expect(response.status).toBe(200);
    expect(String(response.headers["cache-control"])).toMatch(/no-store/);
    expect(response.body).toEqual({
      guestAiEnabled: true,
      dailyLimit: 3,
      usedCount: 0,
      remainingCount: 3,
      blocked: false
    });
  });
});

describe("Phase B backend DTO (P2-3 reading-progress analytics, P2-4 notes)", () => {
  it("P2-3 returns the reading-progress analytics DTO for a book", async () => {
    const { app, dependencies, dbHandle, token } = buildTestApp();
    const book = dependencies.repos.books.create({ title: "P2-3 Book" });
    const ch1 = dependencies.repos.chapters.create({ bookId: book.id, title: "Ch1", orderIndex: 0 });
    const ch2 = dependencies.repos.chapters.create({ bookId: book.id, title: "Ch2", orderIndex: 1 });

    const progressPrefix = `reader-progress-v1:${book.id}:`;
    dependencies.repos.settings.set(`${progressPrefix}s1`, JSON.stringify({
      currentPage: 5, currentChapterId: ch1.id, completedPages: [1, 2, 3],
      completedChapters: [ch1.id], updatedAt: "2024-01-03T00:00:00.000Z", lastEventType: "page_view"
    }));
    dependencies.repos.settings.set(`${progressPrefix}s2`, JSON.stringify({
      currentPage: 3, currentChapterId: ch1.id, completedPages: [1, 2],
      completedChapters: [], updatedAt: "2024-01-02T00:00:00.000Z", lastEventType: "chapter_complete"
    }));
    dependencies.repos.settings.set(`${progressPrefix}s3`, JSON.stringify({
      currentPage: null, currentChapterId: null, completedPages: [],
      completedChapters: [ch1.id, ch2.id], updatedAt: "2024-01-01T00:00:00.000Z", lastEventType: "chapter_complete"
    }));
    dependencies.repos.settings.set(`${progressPrefix}s4`, JSON.stringify({
      currentPage: null, currentChapterId: null, completedPages: [],
      completedChapters: [], updatedAt: null, lastEventType: null
    }));

    const response = await request(app)
      .get(`/api/admin/books/${book.id}/analytics/reading-progress`)
      .set("x-admin-token", token);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      bookId: book.id,
      totalSessions: 4,
      activeReadersCount: 3,
      averageCompletedPages: 1.25,
      pageDropoffDistribution: [
        { page: 1, currentReadersCount: 0, completedReadersCount: 2 },
        { page: 2, currentReadersCount: 0, completedReadersCount: 2 },
        { page: 3, currentReadersCount: 1, completedReadersCount: 1 },
        { page: 5, currentReadersCount: 1, completedReadersCount: 0 }
      ],
      chapterCompletionStats: [
        { chapterId: ch1.id, title: "Ch1", orderIndex: 0, completedCount: 2, completionRate: 0.5 },
        { chapterId: ch2.id, title: "Ch2", orderIndex: 1, completedCount: 1, completionRate: 0.25 }
      ],
      recentReaders: [
        { sessionId: "s1", currentPage: 5, completedPagesCount: 3, completedChaptersCount: 1, updatedAt: "2024-01-03T00:00:00.000Z" },
        { sessionId: "s2", currentPage: 3, completedPagesCount: 2, completedChaptersCount: 0, updatedAt: "2024-01-02T00:00:00.000Z" },
        { sessionId: "s3", currentPage: null, completedPagesCount: 0, completedChaptersCount: 2, updatedAt: "2024-01-01T00:00:00.000Z" },
        { sessionId: "s4", currentPage: null, completedPagesCount: 0, completedChaptersCount: 0, updatedAt: null }
      ]
    });
    dbHandle.sqlite.close();
  });

  it("P2-3 returns 404 for a missing book", async () => {
    const { app, dbHandle, token } = buildTestApp();
    const response = await request(app)
      .get("/api/admin/books/missing-book/analytics/reading-progress")
      .set("x-admin-token", token);
    expect(response.status).toBe(404);
    dbHandle.sqlite.close();
  });

  it("P2-4 returns the notes DTO with optional filters", async () => {
    const { app, dependencies, dbHandle, token } = buildTestApp();
    const book = dependencies.repos.books.create({ title: "P2-4 Book" });
    const ch1 = dependencies.repos.chapters.create({ bookId: book.id, title: "Ch1", orderIndex: 0 });
    const ch2 = dependencies.repos.chapters.create({ bookId: book.id, title: "Ch2", orderIndex: 1 });

    const n1 = dependencies.repos.notes.create(book.id, {
      type: "text", title: "Note A", content: "alpha content", chapterId: ch1.id, pageNumber: 1
    });
    const n2 = dependencies.repos.notes.create(book.id, {
      type: "ai_answer", title: "Note B", content: "beta", chapterId: ch2.id, pageNumber: 2
    });
    const n3 = dependencies.repos.notes.create(book.id, {
      type: "canvas", title: "Sketch", content: null, chapterId: null, pageNumber: null,
      canvasData: "data", canvasImageUrl: "http://img"
    });

    const expectedNotes = [
      { id: n1.id, bookId: book.id, chapterId: ch1.id, chapterTitle: "Ch1", pageNumber: 1, type: "text", title: "Note A", content: "alpha content", canvasData: null, canvasImageUrl: null, createdAt: expect.any(String), updatedAt: expect.any(String) },
      { id: n2.id, bookId: book.id, chapterId: ch2.id, chapterTitle: "Ch2", pageNumber: 2, type: "ai_answer", title: "Note B", content: "beta", canvasData: null, canvasImageUrl: null, createdAt: expect.any(String), updatedAt: expect.any(String) },
      { id: n3.id, bookId: book.id, chapterId: null, chapterTitle: null, pageNumber: null, type: "canvas", title: "Sketch", content: null, canvasData: "data", canvasImageUrl: "http://img", createdAt: expect.any(String), updatedAt: expect.any(String) }
    ];

    const all = await request(app).get(`/api/admin/books/${book.id}/notes`).set("x-admin-token", token);
    expect(all.status).toBe(200);
    expect(all.body.bookId).toBe(book.id);
    expect(all.body.totalCount).toBe(3);
    expect(all.body.notes.slice().sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)))
      .toEqual(expectedNotes.slice().sort((a, b) => a.id.localeCompare(b.id)));

    const byChapter = await request(app).get(`/api/admin/books/${book.id}/notes?chapterId=${ch1.id}`).set("x-admin-token", token);
    expect(byChapter.status).toBe(200);
    expect(byChapter.body.totalCount).toBe(1);
    expect(byChapter.body.notes[0].id).toBe(n1.id);

    const byType = await request(app).get(`/api/admin/books/${book.id}/notes?type=ai_answer`).set("x-admin-token", token);
    expect(byType.status).toBe(200);
    expect(byType.body.totalCount).toBe(1);
    expect(byType.body.notes[0].id).toBe(n2.id);

    const byQuery = await request(app).get(`/api/admin/books/${book.id}/notes?q=ALPHA`).set("x-admin-token", token);
    expect(byQuery.status).toBe(200);
    expect(byQuery.body.totalCount).toBe(1);
    expect(byQuery.body.notes[0].id).toBe(n1.id);

    dbHandle.sqlite.close();
  });

  it("P2-4 returns 404 for a missing book", async () => {
    const { app, dbHandle, token } = buildTestApp();
    const response = await request(app)
      .get("/api/admin/books/missing-book/notes")
      .set("x-admin-token", token);
    expect(response.status).toBe(404);
    dbHandle.sqlite.close();
  });
});

describe("P2-4 delete note route (DELETE /api/admin/books/:bookId/notes/:noteId)", () => {
  function seedBookWithNotes(dependencies: ReturnType<typeof createAdminTestDependencies>) {
    const book = dependencies.repos.books.create({ title: "Delete Notes Book" });
    const ch1 = dependencies.repos.chapters.create({ bookId: book.id, title: "Ch1", orderIndex: 0 });
    const n1 = dependencies.repos.notes.create(book.id, {
      type: "text", title: "Note A", content: "alpha", chapterId: ch1.id, pageNumber: 1
    });
    const n2 = dependencies.repos.notes.create(book.id, {
      type: "text", title: "Note B", content: "beta", chapterId: null, pageNumber: null
    });
    return { book, ch1, n1, n2 };
  }

  it("deletes a note and reduces the notes count", async () => {
    const { app, dependencies, dbHandle } = buildTestApp();
    const { book, n1 } = seedBookWithNotes(dependencies);
    const session = await login(app);

    const before = await request(app).get(`/api/admin/books/${book.id}/notes`).set("Cookie", session.cookieHeader);
    expect(before.status).toBe(200);
    expect(before.body.totalCount).toBe(2);

    const del = await request(app)
      .delete(`/api/admin/books/${book.id}/notes/${n1.id}`)
      .set("Cookie", session.cookieHeader)
      .set("Origin", "http://127.0.0.1:5174")
      .set("x-csrf-token", session.csrf);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true, noteId: n1.id });

    const after = await request(app).get(`/api/admin/books/${book.id}/notes`).set("Cookie", session.cookieHeader);
    expect(after.status).toBe(200);
    expect(after.body.totalCount).toBe(1);
    expect(after.body.notes.map((n: { id: string }) => n.id)).not.toContain(n1.id);
    dbHandle.sqlite.close();
  });

  it("returns 404 for a missing book, a missing note, and a cross-book note", async () => {
    const { app, dependencies, dbHandle } = buildTestApp();
    const session = await login(app);
    const headers = {
      Cookie: session.cookieHeader,
      Origin: "http://127.0.0.1:5174",
      "x-csrf-token": session.csrf
    };

    const missingBook = await request(app)
      .delete("/api/admin/books/missing-book/notes/whatever")
      .set(headers);
    expect(missingBook.status).toBe(404);

    const book = dependencies.repos.books.create({ title: "Delete Notes Book X" });
    const missingNote = await request(app)
      .delete(`/api/admin/books/${book.id}/notes/missing-note`)
      .set(headers);
    expect(missingNote.status).toBe(404);

    const otherBook = dependencies.repos.books.create({ title: "Delete Notes Book Y" });
    const crossNote = dependencies.repos.notes.create(otherBook.id, {
      type: "text", title: "Cross", content: "c", chapterId: null, pageNumber: null
    });
    const cross = await request(app)
      .delete(`/api/admin/books/${book.id}/notes/${crossNote.id}`)
      .set(headers);
    expect(cross.status).toBe(404);
    dbHandle.sqlite.close();
  });

  it("rejects deletion without authentication, with a wrong origin, and without CSRF", async () => {
    const { app, dependencies, dbHandle, token } = buildTestApp();
    const book = dependencies.repos.books.create({ title: "Delete Notes Auth Book" });
    const n1 = dependencies.repos.notes.create(book.id, {
      type: "text", title: "N", content: "c", chapterId: null, pageNumber: null
    });
    const path = `/api/admin/books/${book.id}/notes/${n1.id}`;

    expect((await request(app).delete(path)).status).toBe(401);

    const student = dependencies.repos.studentUsers.create({
      googleSubject: "del-student-subject", email: "del-student@example.test", displayName: "Del Student"
    });
    const { sessionToken } = createStudentSessionSecrets();
    dependencies.repos.studentSessions.create({
      tokenDigest: digestStudentSecret(sessionToken), userId: student.id,
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    expect((await request(app).delete(path).set("Cookie", `ai_student_session=${sessionToken}`)).status).toBe(401);

    expect((await request(app).delete(path).set("x-admin-token", token).set("Origin", "https://evil.example.test")).status).toBe(403);

    const session = await login(app);
    expect((await request(app).delete(path).set("Cookie", session.cookieHeader).set("Origin", "http://127.0.0.1:5174")).status).toBe(403);
    dbHandle.sqlite.close();
  });
});
