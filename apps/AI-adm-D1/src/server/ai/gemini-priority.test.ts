import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbHandle, runMigrations, createRepositories } from "@ai-smartbook/db";
import { encryptCredential } from "./credential-crypto";
import { CredentialBackedProvider } from "./credential-provider";

const previousVaultKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
let handle: ReturnType<typeof createDbHandle> | undefined;

function setup() {
  process.env.AI_CREDENTIAL_ENCRYPTION_KEY = "gemini-priority-test-master-key-0123456789";
  handle = createDbHandle(":memory:");
  runMigrations(handle.sqlite);
  const repos = createRepositories(handle.db);
  return { repos };
}

afterEach(() => {
  handle?.sqlite.close();
  handle = undefined;
  if (previousVaultKey === undefined) delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.AI_CREDENTIAL_ENCRYPTION_KEY = previousVaultKey;
});

function successfulGeminiNativeResponse() {
  return new Response(JSON.stringify({
    candidates: [{
      content: { parts: [{ text: "OK" }], role: "model" },
      finishReason: "STOP"
    }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 }
  }), { status: 200 });
}

describe("Gemini Priority & Failover Specification", () => {
  it("ranks Gemini Provider Config higher when set with lower priority number (priority ASC)", () => {
    const { repos } = setup();
    const openai = repos.aiProviders.upsertConfig({
      provider: "openai", displayName: "OpenAI", priority: 100
    });
    const gemini = repos.aiProviders.upsertConfig({
      provider: "gemini", displayName: "Gemini High Priority", priority: 10
    });

    const configs = repos.aiProviders.listConfigs();
    expect(configs[0].id).toBe(gemini.id);
    expect(configs[0].priority).toBe(10);
    expect(configs[1].id).toBe(openai.id);
    expect(configs[1].priority).toBe(100);
  });

  it("selects primary Gemini Credential over backup Credential based on priority ASC", async () => {
    const { repos } = setup();
    const config = repos.aiProviders.upsertConfig({
      provider: "gemini", displayName: "Gemini Primary", priority: 10, model: "gemini-3.5-flash"
    });

    const primaryKey = repos.aiProviders.createCredential({
      providerConfigId: config.id,
      name: "gemini-primary-key",
      encryptedApiKey: encryptCredential("gemini-primary-secret"),
      maskedApiKey: "gem****mary",
      keyFingerprint: "gemini-primary-fp",
      priority: 10,
      weight: 5,
      status: "active"
    });

    const backupKey = repos.aiProviders.createCredential({
      providerConfigId: config.id,
      name: "gemini-backup-key",
      encryptedApiKey: encryptCredential("gemini-backup-secret"),
      maskedApiKey: "gem****ckup",
      keyFingerprint: "gemini-backup-fp",
      priority: 20,
      weight: 1,
      status: "active"
    });

    vi.stubGlobal("fetch", vi.fn(async () => successfulGeminiNativeResponse()));

    const provider = new CredentialBackedProvider("gemini", repos, "gemini-3.5-flash");
    const result = await provider.generate({ requestId: "gemini-req-1", prompt: "hello" });

    expect(result.credentialId).toBe(primaryKey.id);
    expect(result.credentialId).not.toBe(backupKey.id);
  });

  it("performs weighted rotation within same priority group (weight DESC preference)", async () => {
    const { repos } = setup();
    const config = repos.aiProviders.upsertConfig({
      provider: "gemini", displayName: "Gemini Weighted Group", priority: 10, model: "gemini-3.5-flash"
    });

    const heavyKey = repos.aiProviders.createCredential({
      providerConfigId: config.id,
      name: "gemini-heavy-key",
      encryptedApiKey: encryptCredential("gemini-heavy-secret"),
      maskedApiKey: "gem****eavy",
      keyFingerprint: "gemini-heavy-fp",
      priority: 10,
      weight: 3,
      status: "active"
    });

    const lightKey = repos.aiProviders.createCredential({
      providerConfigId: config.id,
      name: "gemini-light-key",
      encryptedApiKey: encryptCredential("gemini-light-secret"),
      maskedApiKey: "gem****ight",
      keyFingerprint: "gemini-light-fp",
      priority: 10,
      weight: 1,
      status: "active"
    });

    vi.stubGlobal("fetch", vi.fn(async () => successfulGeminiNativeResponse()));

    const provider = new CredentialBackedProvider("gemini", repos, "gemini-3.5-flash");
    const selectedIds: string[] = [];

    for (let i = 0; i < 4; i += 1) {
      const res = await provider.generate({ requestId: `weight-req-${i}`, prompt: "hello" });
      selectedIds.push(res.credentialId!);
    }

    expect(selectedIds.filter((id) => id === heavyKey.id)).toHaveLength(3);
    expect(selectedIds.filter((id) => id === lightKey.id)).toHaveLength(1);
  });

  it("automatically fails over to backup Credential when primary Credential encounters rate limit (429)", async () => {
    const { repos } = setup();
    const config = repos.aiProviders.upsertConfig({
      provider: "gemini", displayName: "Gemini Failover Test", priority: 10, model: "gemini-3.5-flash"
    });

    const primaryKey = repos.aiProviders.createCredential({
      providerConfigId: config.id,
      name: "gemini-primary-key",
      encryptedApiKey: encryptCredential("gemini-primary-secret"),
      maskedApiKey: "gem****mary",
      keyFingerprint: "gemini-primary-fp",
      priority: 10,
      status: "active"
    });

    const backupKey = repos.aiProviders.createCredential({
      providerConfigId: config.id,
      name: "gemini-backup-key",
      encryptedApiKey: encryptCredential("gemini-backup-secret"),
      maskedApiKey: "gem****ckup",
      keyFingerprint: "gemini-backup-fp",
      priority: 20,
      status: "active"
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limit exceeded", { status: 429 }))
      .mockResolvedValueOnce(successfulGeminiNativeResponse());
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CredentialBackedProvider("gemini", repos, "gemini-3.5-flash");
    const result = await provider.generate({ requestId: "failover-req-1", prompt: "hello" });

    expect(result.credentialId).toBe(backupKey.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const updatedPrimary = repos.aiProviders.findCredential(primaryKey.id);
    expect(updatedPrimary?.failureCount).toBe(1);
    expect(updatedPrimary?.cooldownUntil).not.toBeNull();
  });
});
