import { describe, it, expect } from "vitest";
import {
  buildIsolatedRunSecretEnv,
  createQmRuntimeConfigService,
  httpStatusForQmRuntimeBlock,
  resolveQmRuntimeConfig,
  runQmRuntimeConfigTest,
  type QmRuntimeConfigReader
} from "./qm-runtime-config";
import { buildQmRunEnv } from "./qm-runner";

/* ── Test doubles ──────────────────────────────────────────────
 * The pure resolver takes a reader, so each fail-closed branch is driven by a
 * hand-built reader without a database. The values are deliberately fake
 * references only — no real API key, secret, or token is ever constructed. */

function baseConfig() {
  return { providerConfigId: "prov_1", credentialId: "cred_1", model: "claude-3", baseUrlOverride: null };
}

function baseProvider() {
  return { id: "prov_1", provider: "anthropic", slug: "anthropic", displayName: "Anthropic", baseUrl: "https://api.anthropic.com", model: "claude-3", enabled: true };
}

function baseCredential() {
  return {
    id: "cred_1", providerConfigId: "prov_1", name: "prod", maskedApiKey: "ant****AB12",
    baseUrl: null, model: "claude-3", status: "active" as const, cooldownUntil: null
  };
}

function readerWith(overrides: Partial<QmRuntimeConfigReader> = {}): QmRuntimeConfigReader {
  const config = overrides.getConfig?.() ?? baseConfig();
  const provider = overrides.findProvider?.("prov_1") ?? baseProvider();
  const credential = overrides.findCredential?.("cred_1") ?? baseCredential();
  return {
    getConfig: () => config,
    findProvider: (id: string) => (id === provider.id ? provider : overrides.findProvider?.(id) ?? null),
    findCredential: (id: string) => (id === credential.id ? credential : overrides.findCredential?.(id) ?? null),
    enabledModelsForCredential: overrides.enabledModelsForCredential ?? (() => ["claude-3"]),
    now: overrides.now ?? (() => "2026-08-04T00:00:00.000Z")
  };
}

describe("resolveQmRuntimeConfig fail-closed codes", () => {
  it("returns QM_RUNTIME_CONFIG_NOT_FOUND when no config is saved", () => {
    const result = resolveQmRuntimeConfig({ ...readerWith(), getConfig: () => null });
    expect(result).toEqual({ ok: false, reason: "QM_RUNTIME_CONFIG_NOT_FOUND" });
  });

  it("returns QM_PROVIDER_NOT_FOUND when the provider does not exist", () => {
    const result = resolveQmRuntimeConfig({ ...readerWith(), findProvider: () => null });
    expect(result).toEqual({ ok: false, reason: "QM_PROVIDER_NOT_FOUND" });
  });

  it("returns QM_PROVIDER_DISABLED when the provider is disabled", () => {
    const result = resolveQmRuntimeConfig({ ...readerWith(), findProvider: () => ({ ...baseProvider(), enabled: false }) });
    expect(result).toEqual({ ok: false, reason: "QM_PROVIDER_DISABLED" });
  });

  it("returns QM_CREDENTIAL_NOT_FOUND when the credential does not exist", () => {
    const result = resolveQmRuntimeConfig({ ...readerWith(), findCredential: () => null });
    expect(result).toEqual({ ok: false, reason: "QM_CREDENTIAL_NOT_FOUND" });
  });

  it("returns QM_CREDENTIAL_MISMATCH when the credential belongs to a different provider", () => {
    const result = resolveQmRuntimeConfig({ ...readerWith(), findCredential: () => ({ ...baseCredential(), providerConfigId: "prov_OTHER" }) });
    expect(result).toEqual({ ok: false, reason: "QM_CREDENTIAL_MISMATCH" });
  });

  it("returns QM_CREDENTIAL_DISABLED when the credential is not active", () => {
    const result = resolveQmRuntimeConfig({ ...readerWith(), findCredential: () => ({ ...baseCredential(), status: "disabled" }) });
    expect(result).toEqual({ ok: false, reason: "QM_CREDENTIAL_DISABLED" });
  });

  it("returns QM_CREDENTIAL_COOLDOWN when the credential is cooling down", () => {
    const result = resolveQmRuntimeConfig({
      ...readerWith(),
      findCredential: () => ({ ...baseCredential(), cooldownUntil: "2026-08-04T01:00:00.000Z" }),
      now: () => "2026-08-04T00:30:00.000Z"
    });
    expect(result).toEqual({ ok: false, reason: "QM_CREDENTIAL_COOLDOWN" });
  });

  it("returns QM_MODEL_NOT_CONFIGURED when the model is empty", () => {
    const result = resolveQmRuntimeConfig({ ...readerWith(), getConfig: () => ({ ...baseConfig(), model: "" }) });
    expect(result).toEqual({ ok: false, reason: "QM_MODEL_NOT_CONFIGURED" });
  });

  it("returns QM_MODEL_NOT_CONFIGURED when the model is not in the credential's enabled models", () => {
    const result = resolveQmRuntimeConfig({
      ...readerWith(),
      getConfig: () => ({ ...baseConfig(), model: "claude-opus" }),
      enabledModelsForCredential: () => ["claude-3"],
      findCredential: () => ({ ...baseCredential(), model: "claude-3" })
    });
    expect(result).toEqual({ ok: false, reason: "QM_MODEL_NOT_CONFIGURED" });
  });

  it("returns QM_RUNTIME_ENVIRONMENT_BLOCKED when baseUrlOverride is an illegal scheme", () => {
    const result = resolveQmRuntimeConfig({
      ...readerWith(),
      getConfig: () => ({ ...baseConfig(), baseUrlOverride: "ftp://evil.example.com" })
    });
    expect(result).toEqual({ ok: false, reason: "QM_RUNTIME_ENVIRONMENT_BLOCKED" });
  });

  it("returns QM_RUNTIME_ENVIRONMENT_BLOCKED when baseUrlOverride targets a private/loopback/metadata host (SSRF)", () => {
    for (const unsafe of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "http://localhost/"]) {
      const result = resolveQmRuntimeConfig({
        ...readerWith(),
        getConfig: () => ({ ...baseConfig(), baseUrlOverride: unsafe })
      });
      expect(result).toEqual({ ok: false, reason: "QM_RUNTIME_ENVIRONMENT_BLOCKED" });
    }
  });

  it("resolves ok with effectiveBaseUrl from override when everything is valid", () => {
    const result = resolveQmRuntimeConfig({
      ...readerWith(),
      getConfig: () => ({ ...baseConfig(), baseUrlOverride: "https://proxy.example.com" })
    });
    expect(result).toEqual({ ok: true, config: { ...baseConfig(), baseUrlOverride: "https://proxy.example.com" }, effectiveBaseUrl: "https://proxy.example.com", credentialInCooldown: false });
  });

  it("falls back to credential then provider baseUrl when override is null", () => {
    const result = resolveQmRuntimeConfig({
      ...readerWith(),
      findCredential: () => ({ ...baseCredential(), baseUrl: "https://cred.example.com" })
    });
    expect(result.ok && result.effectiveBaseUrl).toBe("https://cred.example.com");
  });
});

describe("resolveQmRuntimeConfig re-validates on every read (not only on save)", () => {
  it("fails closed when the provider is disabled after the config was saved", () => {
    // Simulate a config that was valid when saved, then the provider got disabled.
    const reader = readerWith({ findProvider: () => ({ ...baseProvider(), enabled: false }) });
    expect(resolveQmRuntimeConfig(reader)).toEqual({ ok: false, reason: "QM_PROVIDER_DISABLED" });
  });

  it("fails closed when the credential is disabled after the config was saved", () => {
    const reader = readerWith({ findCredential: () => ({ ...baseCredential(), status: "disabled" }) });
    expect(resolveQmRuntimeConfig(reader)).toEqual({ ok: false, reason: "QM_CREDENTIAL_DISABLED" });
  });
});

describe("httpStatusForQmRuntimeBlock", () => {
  it("maps NOT_FOUND-shaped codes to 404 and the rest to 422", () => {
    expect(httpStatusForQmRuntimeBlock("QM_RUNTIME_CONFIG_NOT_FOUND")).toBe(404);
    expect(httpStatusForQmRuntimeBlock("QM_PROVIDER_NOT_FOUND")).toBe(404);
    expect(httpStatusForQmRuntimeBlock("QM_CREDENTIAL_NOT_FOUND")).toBe(404);
    expect(httpStatusForQmRuntimeBlock("QM_PROVIDER_DISABLED")).toBe(422);
    expect(httpStatusForQmRuntimeBlock("QM_CREDENTIAL_MISMATCH")).toBe(422);
    expect(httpStatusForQmRuntimeBlock("QM_CREDENTIAL_DISABLED")).toBe(422);
    expect(httpStatusForQmRuntimeBlock("QM_CREDENTIAL_COOLDOWN")).toBe(422);
    expect(httpStatusForQmRuntimeBlock("QM_MODEL_NOT_CONFIGURED")).toBe(422);
    expect(httpStatusForQmRuntimeBlock("QM_RUNTIME_ENVIRONMENT_BLOCKED")).toBe(422);
  });
});

describe("createQmRuntimeConfigService storage + public view", () => {
  function makeStore() {
    let stored: string | null = null;
    const settings = {
      get: () => stored,
      set: (_key: string, value: string) => { stored = value; }
    };
    return { settings, readRaw: () => stored };
  }

  it("persists only references (never an api key) and re-resolves on read", () => {
    const { settings, readRaw } = makeStore();
    const service = createQmRuntimeConfigService(settings, {
      findProvider: () => baseProvider(),
      findCredential: () => baseCredential(),
      enabledModelsForCredential: () => ["claude-3"]
    });
    service.save(baseConfig());
    const raw = readRaw()!;
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("encryptedApiKey");
    expect(raw).toContain("providerConfigId");
    expect(raw).toContain("credentialId");

    // The public view exposes a masked key but never a plaintext key.
    const view = service.getPublicView();
    expect(view.maskedApiKey).toBe("ant****AB12");
    expect(JSON.stringify(view)).not.toContain("apiKey");
    expect(service.resolve().ok).toBe(true);
  });

  it("returns a null public view when nothing is saved", () => {
    const { settings } = makeStore();
    const service = createQmRuntimeConfigService(settings, {
      findProvider: () => null,
      findCredential: () => null,
      enabledModelsForCredential: () => []
    });
    const view = service.getPublicView();
    expect(view.config).toBeNull();
    expect(view.maskedApiKey).toBeNull();
  });
});

describe("secret isolation (parallel runs)", () => {
  it("buildQmRunEnv never mutates the shared process.env and isolates per run", () => {
    const original = process.env.ISOLATION_TEST_KEY;
    delete process.env.ISOLATION_TEST_KEY;
    try {
      const envA = buildQmRunEnv({ RUN_SECRET: "secret-A-value" });
      const envB = buildQmRunEnv({ RUN_SECRET: "secret-B-value" });
      // Each run sees only its own secret.
      expect(envA.RUN_SECRET).toBe("secret-A-value");
      expect(envB.RUN_SECRET).toBe("secret-B-value");
      // The shared process.env is untouched.
      expect(process.env.RUN_SECRET).toBeUndefined();
      expect(process.env.ISOLATION_TEST_KEY).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.ISOLATION_TEST_KEY = original;
    }
  });

  it("two concurrent runs each build their own env and never observe the other's secret", () => {
    const envA = buildQmRunEnv({ RUN_SECRET: "alpha-secret" });
    const envB = buildQmRunEnv({ RUN_SECRET: "beta-secret" });
    expect(envA.RUN_SECRET).not.toBe(envB.RUN_SECRET);
    expect("alpha-secret" in envB).toBe(false);
    expect("beta-secret" in envA).toBe(false);
  });

  it("buildIsolatedRunSecretEnv decrypts transiently and never returns the plaintext", () => {
    const { env, secretEnv } = buildIsolatedRunSecretEnv(
      "QM_API_KEY",
      () => "decrypted-plaintext-key",
      "encrypted-envelope",
      (secrets) => ({ ...buildQmRunEnv(secrets) })
    );
    // The plaintext lives only inside secretEnv / env (the fresh object), never
    // on process.env, and is not a property named like the raw key.
    expect(secretEnv.QM_API_KEY).toBe("decrypted-plaintext-key");
    expect(env.QM_API_KEY).toBe("decrypted-plaintext-key");
    expect((env as Record<string, unknown>).apiKey).toBeUndefined();
    expect(process.env.QM_API_KEY).toBeUndefined();
  });

  it("buildIsolatedRunSecretEnv throws when the decryptor yields an empty value", () => {
    expect(() => buildIsolatedRunSecretEnv("K", () => "", "enc")).toThrow();
  });
});

describe("runQmRuntimeConfigTest bounded probe", () => {
  it("reports success when the probe resolves", async () => {
    const result = await runQmRuntimeConfigTest("claude-3", async () => ({ upstreamRequestSent: true }));
    expect(result.status).toBe("success");
    expect(result.model).toBe("claude-3");
  });

  it("reports provider_timeout when the probe aborts", async () => {
    const result = await runQmRuntimeConfigTest(
      "claude-3",
      (signal) => new Promise<{ upstreamRequestSent: boolean }>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      { timeoutMs: 10 }
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("provider_timeout");
  });

  it("reports local_validation_failed when the probe throws before sending upstream", async () => {
    const result = await runQmRuntimeConfigTest("claude-3", async () => { throw new Error("boom"); });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("local_validation_failed");
  });

  it("reports upstream_error (not local_validation_failed) and never leaks the thrown error's message when the probe fails after dispatch", async () => {
    let dispatched = false;
    const result = await runQmRuntimeConfigTest(
      "claude-3",
      async (signal) => {
        void signal;
        dispatched = true; // mirrors a real adapter firing its "request sent" callback
        throw new Error("/home/runner/project SECRET_VALUE=do-not-leak\nupstream 500: {\"raw\":\"body\"}\n  at Object.<anonymous>");
      },
      { isUpstreamRequestSent: () => dispatched }
    );
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("upstream_error");
    expect(result.upstreamRequestSent).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET_VALUE");
    expect(JSON.stringify(result)).not.toContain("/home/runner/project");
    expect(JSON.stringify(result)).not.toContain("raw");
  });
});
