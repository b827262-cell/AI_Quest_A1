import { describe, it, expect } from "vitest";
import {
  QM_RUNTIME_CONFIG_ERROR_CODES,
  qmRuntimeConfigSchema,
  qmRuntimeConfigPublicViewSchema,
  qmRuntimeConfigResolutionSchema,
  qmRuntimeConfigTestResultSchema
} from "./qm-runtime-config";

describe("qm-runtime-config schemas", () => {
  it("qmRuntimeConfigSchema has no api key field and parses a valid config", () => {
    const parsed = qmRuntimeConfigSchema.parse({
      providerConfigId: "prov_1",
      credentialId: "cred_1",
      model: "claude-3",
      baseUrlOverride: "https://api.example.com"
    });
    expect(parsed).toEqual({
      providerConfigId: "prov_1",
      credentialId: "cred_1",
      model: "claude-3",
      baseUrlOverride: "https://api.example.com"
    });
    // No key-shaped field is part of the persisted config, by contract.
    expect(qmRuntimeConfigSchema.shape).not.toHaveProperty("apiKey");
    expect(qmRuntimeConfigSchema.shape).not.toHaveProperty("encryptedApiKey");
  });

  it("treats an empty baseUrlOverride as null", () => {
    const parsed = qmRuntimeConfigSchema.parse({
      providerConfigId: "prov_1",
      credentialId: "cred_1",
      model: "claude-3"
    });
    expect(parsed.baseUrlOverride).toBeNull();
  });

  it("rejects an invalid baseUrlOverride", () => {
    expect(() =>
      qmRuntimeConfigSchema.parse({
        providerConfigId: "prov_1",
        credentialId: "cred_1",
        model: "claude-3",
        baseUrlOverride: "not-a-url"
      })
    ).toThrow();
  });

  it("resolution can be ok or blocked with an exact error code", () => {
    const ok = qmRuntimeConfigResolutionSchema.parse({
      ok: true,
      config: { providerConfigId: "p", credentialId: "c", model: "m", baseUrlOverride: null },
      effectiveBaseUrl: "https://api.example.com",
      credentialInCooldown: false
    });
    expect(ok.ok).toBe(true);

    const blocked = qmRuntimeConfigResolutionSchema.parse({
      ok: false,
      reason: "QM_CREDENTIAL_DISABLED"
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("QM_CREDENTIAL_DISABLED");
  });

  it("exposes the exact 9 error codes", () => {
    expect(QM_RUNTIME_CONFIG_ERROR_CODES).toEqual([
      "QM_RUNTIME_CONFIG_NOT_FOUND",
      "QM_PROVIDER_NOT_FOUND",
      "QM_PROVIDER_DISABLED",
      "QM_CREDENTIAL_NOT_FOUND",
      "QM_CREDENTIAL_MISMATCH",
      "QM_CREDENTIAL_DISABLED",
      "QM_CREDENTIAL_COOLDOWN",
      "QM_MODEL_NOT_CONFIGURED",
      "QM_RUNTIME_ENVIRONMENT_BLOCKED"
    ]);
  });

  it("public view has masked key but no plaintext key field", () => {
    const view = qmRuntimeConfigPublicViewSchema.shape;
    expect(view).toHaveProperty("maskedApiKey");
    expect(view).not.toHaveProperty("apiKey");
    expect(view).not.toHaveProperty("encryptedApiKey");

    const parsed = qmRuntimeConfigPublicViewSchema.parse({
      config: { providerConfigId: "p", credentialId: "c", model: "m", baseUrlOverride: null },
      providerDisplayName: "Anthropic",
      providerSlug: "anthropic",
      providerEnabled: true,
      credentialName: "prod",
      maskedApiKey: "ant****AB12",
      credentialStatus: "active",
      credentialInCooldown: false,
      effectiveBaseUrl: "https://api.anthropic.com",
      updatedAt: "2026-08-04T00:00:00.000Z"
    });
    expect(parsed.maskedApiKey).toBe("ant****AB12");
  });

  it("test result schema parses success and failure", () => {
    expect(qmRuntimeConfigTestResultSchema.parse({
      status: "success", reason: "valid", latencyMs: 42, upstreamRequestSent: true, model: "claude-3"
    }).status).toBe("success");
    expect(qmRuntimeConfigTestResultSchema.parse({
      status: "failed", reason: "provider_timeout", latencyMs: 5000, upstreamRequestSent: false, model: "claude-3"
    }).status).toBe("failed");
  });
});
