import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminApp } from "./app";
import { createAdminTestDependencies } from "./dependencies";
import { createDbHandle, type DbHandle } from "@ai-smartbook/db";

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
    ADMIN_ALLOWED_ORIGINS: "http://127.0.0.1:5174"
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

describe("Admin API HTTP authentication and quota behavior", () => {
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
});
