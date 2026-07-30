import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbHandle, createRepositories, runMigrations } from "@ai-smartbook/db";
import { encryptCredential } from "./credential-crypto";
import { buildGateway } from "./gateway-instance";

const previousVaultKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
const previousGatewayEnabled = process.env.AI_GATEWAY_ENABLED;

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousVaultKey === undefined) delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.AI_CREDENTIAL_ENCRYPTION_KEY = previousVaultKey;
  if (previousGatewayEnabled === undefined) delete process.env.AI_GATEWAY_ENABLED;
  else process.env.AI_GATEWAY_ENABLED = previousGatewayEnabled;
});

describe("vault-backed gateway registration", () => {
  it("selects a credential created after gateway boot without requiring a restart", async () => {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = "gateway-dynamic-vault-key-0123456789";
    process.env.AI_GATEWAY_ENABLED = "true";
    const handle = createDbHandle(":memory:");
    try {
      runMigrations(handle.sqlite);
      const repos = createRepositories(handle.db);
      const { gateway } = buildGateway(repos);
      const config = repos.aiProviders.upsertConfig({
        provider: "gemini", displayName: "Gemini", model: "configured-model", enabled: true
      });
      const credential = repos.aiProviders.createCredential({
        providerConfigId: config.id,
        name: "newly-added",
        encryptedApiKey: encryptCredential("test-gemini-provider-key"),
        maskedApiKey: "tes****-key",
        keyFingerprint: "dynamic-gemini-fingerprint",
        status: "active"
      });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: "OK" }] } }],
        usageMetadata: { totalTokenCount: 1 }
      }), { status: 200 })));

      const output = await gateway.run({
        requestId: "dynamic-vault-credential", prompt: "hello", preferredProvider: "gemini", requestSource: "admin"
      });

      expect(output.result).toMatchObject({ provider: "gemini", credentialId: credential.id, answer: "OK" });
    } finally {
      handle.sqlite.close();
    }
  });
});
