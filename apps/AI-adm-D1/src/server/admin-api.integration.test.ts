import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminApp } from "./app";
import { createAdminTestDependencies } from "./dependencies";
import { createDbHandle, type DbHandle } from "@ai-smartbook/db";
import { createAdminSessionSecrets, digestAdminSecret } from "./ai/admin-auth";

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
  const dependencies = createAdminTestDependencies(process.env, dbHandle);
  return { app: createAdminApp(dependencies), dependencies, token };
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
  it("supports login, me, session access, CSRF, logout and failed credentials", async () => {
    const { app } = buildTestApp();

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
    const { app, dependencies } = buildTestApp();
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
  });
});
