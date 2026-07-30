import { afterEach, describe, expect, it } from "vitest";
import {
  credentialFingerprint,
  decryptCredential,
  decryptCredentialWithKey,
  encryptCredential,
  maskCredential,
  assertCredentialEncryptionConfigured
} from "./credential-crypto";
import { createAiCredentialInputSchema, updateAiCredentialInputSchema } from "@ai-smartbook/schema";

const previous = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
const previousNodeEnv = process.env.NODE_ENV;
const previousAdminToken = process.env.ADMIN_API_TOKEN;
afterEach(() => {
  if (previous === undefined) delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.AI_CREDENTIAL_ENCRYPTION_KEY = previous;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousAdminToken === undefined) delete process.env.ADMIN_API_TOKEN;
  else process.env.ADMIN_API_TOKEN = previousAdminToken;
});

describe("credential encryption vault", () => {
  it("uses authenticated encryption and a non-reversible UI mask", () => {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = "unit-test-encryption-key";
    const apiKey = "sk-example-secret-8A2F";
    const encrypted = encryptCredential(apiKey);
    expect(encrypted).not.toContain(apiKey);
    expect(decryptCredential(encrypted)).toBe(apiKey);
    expect(maskCredential(apiKey)).toBe("sk-****8A2F");
    expect(credentialFingerprint(apiKey)).toHaveLength(64);
  });

  it("fails closed in production when the vault key is absent", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => assertCredentialEncryptionConfigured()).toThrow("AI_CREDENTIAL_ENCRYPTION_KEY");
  });

  it("does not use the admin token as an encryption fallback", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    process.env.ADMIN_API_TOKEN = "admin-token-must-not-be-used";
    expect(() => assertCredentialEncryptionConfigured()).toThrow();
  });

  it("refuses to decrypt an envelope with a different master key", () => {
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = "vault-master-key-one-0123456789";
    const encrypted = encryptCredential("test-provider-key-value");
    expect(() => decryptCredentialWithKey(encrypted, "vault-master-key-two-0123456789")).toThrow();
  });

  it("does not write plaintext when the local vault key is absent", () => {
    delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptCredential("test-provider-key-value")).toThrow("not configured");
  });

  it("treats a blank update key as unchanged while rejecting a blank create key", () => {
    expect(updateAiCredentialInputSchema.safeParse({ name: "primary", apiKey: "" })).toMatchObject({
      success: true,
      data: { name: "primary", apiKey: undefined }
    });
    expect(createAiCredentialInputSchema.safeParse({ name: "primary", apiKey: "" }).success).toBe(false);
  });

  it("accepts the exact admin create payload and normalizes blank optional fields", () => {
    const result = createAiCredentialInputSchema.safeParse({
      name: "Gemini primary",
      apiKey: "safe-test-key-1234",
      baseUrl: "",
      model: "",
      status: "active",
      priority: 100,
      weight: 1,
      rpmLimit: "",
      tpmLimit: null,
      rpdLimit: 500,
      resetTimezone: "Asia/Taipei",
      isDefaultModel: true
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.baseUrl).toBeNull();
      expect(result.data.model).toBeNull();
      expect(result.data.rpmLimit).toBeNull();
      expect(result.data.tpmLimit).toBeNull();
    }
  });

  it("reports missing required fields without accepting a partial credential", () => {
    const result = createAiCredentialInputSchema.safeParse({ model: "gemini-3.5-flash" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path[0])).toEqual(
        expect.arrayContaining(["name", "apiKey"])
      );
    }
  });

  it("rejects a URL as a credential model", () => {
    const result = createAiCredentialInputSchema.safeParse({
      name: "primary",
      apiKey: "safe-test-key-1234",
      model: "https://example.invalid/model"
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid credential Base URL", () => {
    const result = createAiCredentialInputSchema.safeParse({
      name: "primary",
      apiKey: "safe-test-key-1234",
      baseUrl: "not-a-url"
    });
    expect(result.success).toBe(false);
  });
});
