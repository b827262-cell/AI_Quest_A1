import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbHandle, runMigrations, createRepositories } from "@ai-smartbook/db";
import { AiGateway, AiGatewayError, AllowAllBudgetManager, MockGatewayProvider } from "@ai-smartbook/ai";
import { encryptCredential } from "./credential-crypto";
import { CredentialBackedProvider } from "./credential-provider";
import { DbPromptLogger } from "./db-prompt-logger";

const previousVaultKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
let handle: ReturnType<typeof createDbHandle> | undefined;

function setup() {
  process.env.AI_CREDENTIAL_ENCRYPTION_KEY = "provider-selection-test-master-key-0123456789";
  handle = createDbHandle(":memory:");
  runMigrations(handle.sqlite);
  const repos = createRepositories(handle.db);
  const config = repos.aiProviders.upsertConfig({ provider: "openai", displayName: "OpenAI", model: "gpt-test" });
  return { repos, config };
}

function addCredential(repos: ReturnType<typeof setup>["repos"], configId: string, input: {
  id?: string;
  name: string;
  apiKey?: string;
  endpointProfile?: string;
  model?: string;
  status?: "active" | "standby" | "disabled";
  billingMode?: "pay_as_you_go" | "token_plan_personal" | "token_plan_team" | "unknown";
  usageScope?: "development_interactive" | "staging" | "production" | "unknown";
  priority?: number;
  weight?: number;
}) {
  const row = repos.aiProviders.createCredential({
    providerConfigId: configId,
    name: input.name,
    encryptedApiKey: encryptCredential(input.apiKey ?? `unit-${input.name}-credential`),
    maskedApiKey: "uni****tial",
    keyFingerprint: `fingerprint-${input.name}`,
    model: input.model,
    status: input.status,
    billingMode: input.billingMode,
    usageScope: input.usageScope,
    endpointProfile: input.endpointProfile,
    priority: input.priority,
    weight: input.weight
  });
  if (input.id && row.id !== input.id) {
    throw new Error("test helper does not replace generated ids");
  }
  return row;
}

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.sqlite.close();
  handle = undefined;
  if (previousVaultKey === undefined) delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.AI_CREDENTIAL_ENCRYPTION_KEY = previousVaultKey;
});

function successfulOpenAiResponse() {
  return new Response(JSON.stringify({
    choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  }), { status: 200 });
}

describe("DB-backed credential selection", () => {
  it("never selects a Personal Qwen credential for production traffic", async () => {
    const { repos } = setup();
    const config = repos.aiProviders.upsertConfig({ provider: "qwen", displayName: "Qwen", model: "qwen-turbo" });
    const credential = addCredential(repos, config.id, {
      name: "personal-qwen",
      model: "qwen-turbo",
      billingMode: "token_plan_personal",
      usageScope: "development_interactive"
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new CredentialBackedProvider("qwen", repos, "qwen-turbo")
      .generate({ requestId: "qwen-production-personal", prompt: "hello" }))
      .rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(credential.billingMode).toBe("token_plan_personal");
  });

  it("allows a Personal Qwen credential for development interactive traffic", async () => {
    const { repos } = setup();
    const config = repos.aiProviders.upsertConfig({ provider: "qwen", displayName: "Qwen", model: "qwen-turbo" });
    const credential = addCredential(repos, config.id, {
      name: "interactive-qwen",
      model: "qwen-turbo",
      billingMode: "token_plan_personal",
      usageScope: "development_interactive"
    });
    vi.stubGlobal("fetch", vi.fn(async () => successfulOpenAiResponse()));
    const result = await new CredentialBackedProvider(
      "qwen", repos, "qwen-turbo", undefined, "development_interactive"
    ).generate({ requestId: "qwen-development-personal", prompt: "hello" });
    expect(result.credentialId).toBe(credential.id);
  });

  it("treats AQ. as an opaque Credential value rather than a validity prefix", async () => {
    const { repos, config } = setup();
    const credential = addCredential(repos, config.id, {
      name: "opaque-aq-key",
      apiKey: "AQ.abcdefghijklmnopqrstuvwxyz123456",
      model: "gpt-test"
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer AQ.abcdefghijklmnopqrstuvwxyz123456");
      return successfulOpenAiResponse();
    }));
    const result = await new CredentialBackedProvider("openai", repos, "gpt-test")
      .generate({ requestId: "opaque-aq-key", prompt: "hello" });
    expect(result.credentialId).toBe(credential.id);
  });

  it("falls back through the existing Router when production Qwen is unavailable", async () => {
    const { repos } = setup();
    const config = repos.aiProviders.upsertConfig({ provider: "qwen", displayName: "Qwen", model: "qwen-turbo" });
    addCredential(repos, config.id, {
      name: "router-blocked-personal-qwen",
      model: "qwen-turbo",
      billingMode: "token_plan_personal",
      usageScope: "development_interactive"
    });
    const output = await new AiGateway({
      providers: new Map([
        ["qwen", new CredentialBackedProvider("qwen", repos, "qwen-turbo")],
        ["mock", new MockGatewayProvider()]
      ]),
      requestTimeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 8,
      maxInputChars: 200,
      budgetManager: new AllowAllBudgetManager(),
      allowMockFallback: true
    }).run({ requestId: "qwen-production-fallback", prompt: "hello", preferredProvider: "qwen" });
    expect(output.result.provider).toBe("mock");
    expect(output.fallbackUsed).toBe(true);
  });

  it("uses the credential's enabled default model when the request omits model", async () => {
    const { repos, config } = setup();
    const credential = addCredential(repos, config.id, { name: "default-model", model: "credential-default" });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).model).toBe("credential-default");
      return successfulOpenAiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new CredentialBackedProvider("openai", repos, "provider-default")
      .generate({ requestId: "credential-default-model", prompt: "hello" });
    expect(result.credentialId).toBe(credential.id);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("resolves a credential test through its exact Gemini provider instance", async () => {
    const { repos } = setup();
    const firstConfig = repos.aiProviders.upsertConfig({ provider: "gemini", displayName: "Gemini First", model: "gemini-test" });
    const secondConfig = repos.aiProviders.upsertConfig({ provider: "gemini", displayName: "Gemini Second", model: "gemini-test" });
    addCredential(repos, firstConfig.id, { name: "gemini-first", model: "gemini-test" });
    const secondCredential = addCredential(repos, secondConfig.id, { name: "gemini-second", model: "gemini-test", endpointProfile: "gemini_openai_compatible" });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/v1beta/openai/chat/completions");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer unit-gemini-second-credential");
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBeUndefined();
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new CredentialBackedProvider(
      "gemini", repos, "gemini-test", secondCredential.id, "development_interactive"
    ).generate({ requestId: "gemini-instance-test", prompt: "hello" });
    expect(result.credentialId).toBe(secondCredential.id);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("marks upstream entry only after local credential selection succeeds", async () => {
    const { repos, config } = setup();
    addCredential(repos, config.id, { name: "upstream-trace", model: "gpt-test" });
    let upstreamRequestSent = false;
    vi.stubGlobal("fetch", vi.fn(async () => successfulOpenAiResponse()));
    await new CredentialBackedProvider(
      "openai",
      repos,
      "gpt-test",
      undefined,
      "development_interactive",
      () => { upstreamRequestSent = true; }
    ).generate({ requestId: "upstream-trace-success", prompt: "hello" });
    expect(upstreamRequestSent).toBe(true);
  });

  it("lets the Gateway resolve the managed credential model and stays live", async () => {
    const { repos, config } = setup();
    const credential = addCredential(repos, config.id, { name: "gateway-default", model: "credential-live-model" });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).model).toBe("credential-live-model");
      return successfulOpenAiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const output = await new AiGateway({
      providers: new Map([["openai", new CredentialBackedProvider("openai", repos, "provider-model")]]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 8,
      maxInputChars: 200,
      budgetManager: new AllowAllBudgetManager(),
      allowMockFallback: false
    }).run({ requestId: "gateway-live-model", prompt: "solve this", preferredProvider: "openai" });
    expect(output.result.provider).toBe("openai");
    expect(output.result.model).toBe("credential-live-model");
    expect(output.fallbackUsed).toBe(false);
    expect(output.result.credentialId).toBe(credential.id);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports model resolution failure safely instead of silently calling Mock", async () => {
    const { repos, config } = setup();
    addCredential(repos, config.id, { name: "wrong-model", model: "credential-only-model" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const output = await new AiGateway({
      providers: new Map([
        ["openai", new CredentialBackedProvider("openai", repos, "provider-model")],
        ["mock", new MockGatewayProvider()]
      ]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 8,
      maxInputChars: 200,
      budgetManager: new AllowAllBudgetManager(),
      allowMockFallback: true
    }).run({ requestId: "wrong-model-fallback", prompt: "solve this", preferredProvider: "openai", preferredModel: "not-configured" });
    expect(output.result.provider).toBe("mock");
    expect(output.fallbackUsed).toBe(true);
    expect(output.fallbackReason).toBe("model_not_enabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a Z.AI-compatible request with one /v4 path", async () => {
    const { repos } = setup();
    const config = repos.aiProviders.upsertConfig({
      provider: "zai",
      displayName: "Z.AI",
      baseUrl: "https://api.z.ai/api/paas/v4/v4/",
      model: "glm-test"
    });
    addCredential(repos, config.id, { name: "zai-primary" });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer unit-zai-primary-credential");
      return successfulOpenAiResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await new CredentialBackedProvider("zai", repos, "glm-test")
      .generate({ requestId: "zai-credential", prompt: "hello" });
    expect(result.provider).toBe("zai");
  });

  it("uses the lowest priority active credential before standby", async () => {
    const { repos, config } = setup();
    const low = addCredential(repos, config.id, { name: "low", priority: 10, weight: 1 });
    const high = addCredential(repos, config.id, { name: "high", priority: 20, weight: 1 });
    const standby = addCredential(repos, config.id, { name: "standby", status: "standby", priority: 0, weight: 20 });
    vi.stubGlobal("fetch", vi.fn(async () => successfulOpenAiResponse()));
    const provider = new CredentialBackedProvider("openai", repos, "gpt-test");
    const result = await provider.generate({ requestId: "selection-1", prompt: "hello" });
    expect(result.credentialId).toBe(low.id);
    expect(result.credentialId).not.toBe(high.id);
    expect(result.credentialId).not.toBe(standby.id);
  });

  it("uses weighted rotation within a priority group", async () => {
    const { repos, config } = setup();
    const weighted = addCredential(repos, config.id, { name: "weighted", priority: 10, weight: 3 });
    const other = addCredential(repos, config.id, { name: "other", priority: 10, weight: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => successfulOpenAiResponse()));
    const provider = new CredentialBackedProvider("openai", repos, "gpt-test");
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push((await provider.generate({ requestId: `weight-${i}`, prompt: "hello" })).credentialId!);
    }
    expect(ids.filter((id) => id === weighted.id)).toHaveLength(3);
    expect(ids.filter((id) => id === other.id)).toHaveLength(1);
  });

  it.each([401, 403, 429, 500])("moves past upstream %s and records cooldown", async (status) => {
    const { repos, config } = setup();
    const failed = addCredential(repos, config.id, { name: `failed-${status}`, priority: 10 });
    const standby = addCredential(repos, config.id, { name: `standby-${status}`, status: "standby", priority: 20 });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("provider error", { status }))
      .mockResolvedValueOnce(successfulOpenAiResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await new CredentialBackedProvider("openai", repos, "gpt-test")
      .generate({ requestId: `failure-${status}`, prompt: "hello" });
    expect(result.credentialId).toBe(standby.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const state = repos.aiProviders.findCredential(failed.id);
    expect(state?.failureCount).toBe(1);
    expect(state?.cooldownUntil).toBeTruthy();
    expect(state?.encryptedApiKey).not.toContain("unit-failed");
  });

  it("moves past a fetch timeout without permanently disabling the credential", async () => {
    const { repos, config } = setup();
    const timedOut = addCredential(repos, config.id, { name: "timed-out", priority: 10 });
    const standby = addCredential(repos, config.id, { name: "timeout-standby", status: "standby", priority: 20 });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError"))
      .mockResolvedValueOnce(successfulOpenAiResponse());
    vi.stubGlobal("fetch", fetchMock);
    const result = await new CredentialBackedProvider("openai", repos, "gpt-test")
      .generate({ requestId: "timeout-1", prompt: "hello" });
    expect(result.credentialId).toBe(standby.id);
    expect(repos.aiProviders.findCredential(timedOut.id)).toMatchObject({ status: "active", failureCount: 1 });
  });

  it("never selects disabled, deleted, or cooling-down credentials", async () => {
    const { repos, config } = setup();
    const disabled = addCredential(repos, config.id, { name: "disabled", status: "disabled", priority: 1 });
    const deleted = addCredential(repos, config.id, { name: "deleted", priority: 2 });
    repos.aiProviders.updateCredential(deleted.id, { deletedAt: new Date().toISOString() });
    const cooling = addCredential(repos, config.id, { name: "cooling", priority: 3 });
    repos.aiProviders.markCredentialFailure(cooling.id, 60_000);
    const usable = addCredential(repos, config.id, { name: "usable", priority: 4 });
    vi.stubGlobal("fetch", vi.fn(async () => successfulOpenAiResponse()));
    const result = await new CredentialBackedProvider("openai", repos, "gpt-test")
      .generate({ requestId: "eligibility-1", prompt: "hello" });
    expect(result.credentialId).toBe(usable.id);
    expect(result.credentialId).not.toBe(disabled.id);
    expect(result.credentialId).not.toBe(deleted.id);
    expect(result.credentialId).not.toBe(cooling.id);
  });

  it("re-enters a credential after cooldown and clears failure state on success", async () => {
    const { repos, config } = setup();
    const credential = addCredential(repos, config.id, { name: "reentry", priority: 10 });
    repos.aiProviders.updateCredential(credential.id, {
      failureCount: 2,
      cooldownUntil: new Date(Date.now() - 1_000).toISOString()
    });
    vi.stubGlobal("fetch", vi.fn(async () => successfulOpenAiResponse()));
    const result = await new CredentialBackedProvider("openai", repos, "gpt-test")
      .generate({ requestId: "reentry-1", prompt: "hello" });
    expect(result.credentialId).toBe(credential.id);
    expect(repos.aiProviders.findCredential(credential.id)).toMatchObject({ failureCount: 0, cooldownUntil: null });
  });

  it("returns a sanitised unavailable error when no credential is eligible", async () => {
    const { repos, config } = setup();
    addCredential(repos, config.id, { name: "disabled", status: "disabled" });
    vi.stubGlobal("fetch", vi.fn());
    await expect(new CredentialBackedProvider("openai", repos, "gpt-test")
      .generate({ requestId: "none-1", prompt: "hello" }))
      .rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    expect(JSON.stringify(new AiGatewayError("AI_PROVIDER_UNAVAILABLE", "safe"))).not.toContain("credential");
  });

  it("does not expose a key when every credential fails", async () => {
    const { repos, config } = setup();
    const first = addCredential(repos, config.id, { name: "all-fail-one", priority: 1 });
    const second = addCredential(repos, config.id, { name: "all-fail-two", priority: 2 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("vendor body contains no client response", { status: 401 })));
    const provider = new CredentialBackedProvider("openai", repos, "gpt-test");
    await expect(provider.generate({ requestId: "all-fail-1", prompt: "hello" }))
      .rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE" });
    expect(repos.aiProviders.findCredential(first.id)?.failureCount).toBe(1);
    expect(repos.aiProviders.findCredential(second.id)?.failureCount).toBe(1);
    expect(JSON.stringify(repos.aiProviders.listCredentials(config.id))).not.toContain("vendor body");
    expect(JSON.stringify(repos.aiProviders.listCredentials(config.id))).not.toContain("credential-one-value");
  });

  it("writes the successful credentialId to usage logs without key material", async () => {
    const { repos, config } = setup();
    const credential = addCredential(repos, config.id, { name: "logged", priority: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => successfulOpenAiResponse()));
    const gateway = new AiGateway({
      providers: new Map([["openai", new CredentialBackedProvider("openai", repos, "gpt-test")]]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 8,
      maxInputChars: 200,
      budgetManager: new AllowAllBudgetManager(),
      logger: new DbPromptLogger(repos),
      allowMockFallback: false
    });
    const output = await gateway.run({ requestId: "usage-credential-1", prompt: "hello", preferredProvider: "openai", requestSource: "admin" });
    const usage = repos.aiUsageLogs.findByRequestId("usage-credential-1");
    expect(output.result.credentialId).toBe(credential.id);
    expect(usage?.credentialId).toBe(credential.id);
    expect(JSON.stringify(usage)).not.toMatch(/encrypted|authorization|api[_-]?key|unit-logged-credential/i);
  });

  it("falls through to the next Provider after every managed credential fails", async () => {
    const { repos, config } = setup();
    const credential = addCredential(repos, config.id, { name: "provider-fallback", priority: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("vendor failure", { status: 401 })));
    const gateway = new AiGateway({
      providers: new Map([
        ["openai", new CredentialBackedProvider("openai", repos, "gpt-test")],
        ["mock", new MockGatewayProvider()]
      ]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 8,
      maxInputChars: 200,
      budgetManager: new AllowAllBudgetManager(),
      allowMockFallback: true
    });
    const output = await gateway.run({ requestId: "provider-fallback-1", prompt: "hello", preferredProvider: "openai" });
    expect(output.result.provider).toBe("mock");
    expect(output.fallbackUsed).toBe(true);
    expect(repos.aiProviders.findCredential(credential.id)?.failureCount).toBe(1);
  });

  it("keeps concurrent successful selections independent", async () => {
    const { repos, config } = setup();
    const first = addCredential(repos, config.id, { name: "concurrent-one", priority: 1 });
    const second = addCredential(repos, config.id, { name: "concurrent-two", priority: 1 });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return successfulOpenAiResponse();
    }));
    const provider = new CredentialBackedProvider("openai", repos, "gpt-test");
    const results = await Promise.all([
      provider.generate({ requestId: "concurrent-1", prompt: "hello" }),
      provider.generate({ requestId: "concurrent-2", prompt: "hello" })
    ]);
    expect(new Set(results.map((result) => result.credentialId))).toEqual(new Set([first.id, second.id]));
    expect(repos.aiProviders.findCredential(first.id)?.failureCount).toBe(0);
    expect(repos.aiProviders.findCredential(second.id)?.failureCount).toBe(0);
  });

  it("switches to the next credential when a model RPM quota is exhausted", async () => {
    const { repos, config } = setup();
    const limited = addCredential(repos, config.id, { name: "limited", priority: 1 });
    const fallback = addCredential(repos, config.id, { name: "quota-fallback", priority: 2 });
    repos.aiCredentialModelQuotas.create({
      credentialId: limited.id, model: "gpt-test", rpmLimit: 1, tpmLimit: 100, rpdLimit: 10
    });
    vi.stubGlobal("fetch", vi.fn(async () => successfulOpenAiResponse()));
    const provider = new CredentialBackedProvider("openai", repos, "gpt-test");
    expect((await provider.generate({ requestId: "quota-first", prompt: "hello" })).credentialId).toBe(limited.id);
    expect((await provider.generate({ requestId: "quota-second", prompt: "hello" })).credentialId).toBe(fallback.id);
    expect(repos.aiCredentialModelQuotas.findForCredential(limited.id, "gpt-test")?.requestsThisMinute).toBe(1);
  });

  it("uses provider token usage to settle quota counters and rejects concurrent over-limit reservations", async () => {
    const { repos, config } = setup();
    const credential = addCredential(repos, config.id, { name: "token-quota", priority: 1 });
    repos.aiCredentialModelQuotas.create({
      credentialId: credential.id, model: "gpt-test", rpmLimit: 10, tpmLimit: 3, rpdLimit: 10
    });
    const reservationResults = await Promise.all([
      Promise.resolve().then(() => repos.aiCredentialModelQuotas.reserve(credential.id, "gpt-test", 3)),
      Promise.resolve().then(() => repos.aiCredentialModelQuotas.reserve(credential.id, "gpt-test", 3))
    ]);
    expect(reservationResults.filter((result) => result.allowed)).toHaveLength(1);
    const reservation = reservationResults.find((result) => result.reservation)?.reservation;
    repos.aiCredentialModelQuotas.settle(reservation!, 2, "provider_response");
    expect(repos.aiCredentialModelQuotas.findForCredential(credential.id, "gpt-test")).toMatchObject({
      tokensThisMinute: 2,
      usageSource: "provider_response"
    });
  });
});
