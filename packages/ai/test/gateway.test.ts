import { describe, expect, it } from "vitest";
import {
  AiGateway,
  AiGatewayError,
  MockGatewayProvider,
  type AiProviderId,
  type BudgetManager,
  type GatewayLogEntry,
  type PromptLogger
} from "../src";
import type { GatewayAiProvider } from "../src/gateway/provider.interface";
import type { AiGenerateRequest, AiGenerateResult } from "../src/gateway/ai-types";

/** A fake provider whose behaviour is scripted per test. */
class ScriptedProvider implements GatewayAiProvider {
  readonly providerId: AiProviderId;
  readonly defaultModel: string;
  available: boolean;
  behaviour: "ok" | "fail" | "empty" | "raw-json" | "slow";
  calls = 0;

  constructor(
    providerId: AiProviderId,
    opts: {
      model?: string;
      available?: boolean;
      behaviour?: "ok" | "fail" | "empty" | "raw-json" | "slow";
    } = {}
  ) {
    this.providerId = providerId;
    this.defaultModel = opts.model ?? `${providerId}-model`;
    this.available = opts.available ?? true;
    this.behaviour = opts.behaviour ?? "ok";
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.calls += 1;
    if (this.behaviour === "fail") {
      throw new AiGatewayError(
        "AI_PROVIDER_UNAVAILABLE",
        "upstream down",
        { failedProvider: this.providerId }
      );
    }
    if (this.behaviour === "slow") {
      await new Promise((r) => setTimeout(r, 200));
      return this.ok(request);
    }
    if (this.behaviour === "empty") {
      return this.ok(request, "   ");
    }
    if (this.behaviour === "raw-json") {
      return this.ok(request, '{"choices":[{"message":{"content":"x"}}]}');
    }
    return this.ok(request);
  }

  private ok(request: AiGenerateRequest, answer = `answer from ${this.providerId}`): AiGenerateResult {
    return {
      provider: this.providerId,
      model: request.model ?? this.defaultModel,
      answer,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      latencyMs: 3,
      estimatedCostMicroUsd: this.providerId === "mock" ? 0 : 12,
      finishReason: "stop"
    };
  }
}

function makeCapturingLogger(): { logger: PromptLogger; entries: GatewayLogEntry[] } {
  const entries: GatewayLogEntry[] = [];
  return {
    entries,
    logger: {
      async log(entry) {
        entries.push(entry);
      }
    }
  };
}

function makeBudget(deny: boolean = false): BudgetManager {
  return {
    async preCheck() {
      return { allowed: !deny, utilisation: deny ? 1 : 0, reason: deny ? "capped" : undefined };
    },
    async recordUsage() {}
  };
}

describe("AiGateway full flow", () => {
  it("runs a successful mock request and logs it", async () => {
    const { logger, entries } = makeCapturingLogger();
    const mock = new MockGatewayProvider();
    const gw = new AiGateway({
      providers: new Map([["mock", mock]]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000,
      budgetManager: makeBudget(false),
      logger
    });

    const out = await gw.run({
      requestId: "req-1",
      prompt: "請解釋光合作用",
      requestSource: "guest",
      scopeKey: "visitor-1"
    });

    expect(out.result.provider).toBe("mock");
    expect(out.result.answer).toBeTruthy();
    expect(out.fallbackUsed).toBe(false);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("success");
    expect(entries[0].requestSource).toBe("guest");
  });

  it("rejects empty prompts with AI_INVALID_INPUT", async () => {
    const gw = new AiGateway({
      providers: new Map([["mock", new MockGatewayProvider()]]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000
    });
    await expect(gw.run({ requestId: "r", prompt: "   " })).rejects.toMatchObject({
      code: "AI_INVALID_INPUT",
      httpStatus: 400
    });
  });

  it("rejects oversized prompts", async () => {
    const gw = new AiGateway({
      providers: new Map([["mock", new MockGatewayProvider()]]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 5
    });
    await expect(gw.run({ requestId: "r", prompt: "abcdefgh" })).rejects.toMatchObject({
      code: "AI_INVALID_INPUT"
    });
  });

  it("falls back to the next provider when the preferred one fails", async () => {
    const { logger, entries } = makeCapturingLogger();
    const openai = new ScriptedProvider("openai", { behaviour: "fail" });
    const mock = new ScriptedProvider("mock", { behaviour: "ok" });
    const gw = new AiGateway({
      providers: new Map([
        ["openai", openai],
        ["mock", mock]
      ]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000,
      budgetManager: makeBudget(false),
      logger,
      forceProvider: "openai"
    });

    const out = await gw.run({ requestId: "r", prompt: "hi", preferredProvider: "openai" });

    expect(out.result.provider).toBe("mock");
    expect(out.fallbackUsed).toBe(true);
    expect(out.failedProviders).toContain("openai");
    expect(entries[0].status).toBe("fallback");
    expect(entries[0].providerAttempts).toEqual(["openai", "mock"]);
    expect(openai.calls).toBe(1);
    expect(mock.calls).toBe(1);
  });

  it("returns AI_PROVIDER_UNAVAILABLE when all providers fail", async () => {
    const openai = new ScriptedProvider("openai", { behaviour: "fail" });
    const mock = new ScriptedProvider("mock", { behaviour: "fail" });
    const gw = new AiGateway({
      providers: new Map([
        ["openai", openai],
        ["mock", mock]
      ]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000
    });
    await expect(
      gw.run({ requestId: "r", prompt: "hi", preferredProvider: "openai" })
    ).rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", httpStatus: 503 });
  });

  it("denies requests when the budget manager rejects (AI_BUDGET_EXCEEDED → 429)", async () => {
    const gw = new AiGateway({
      providers: new Map([["mock", new MockGatewayProvider()]]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000,
      budgetManager: makeBudget(true)
    });
    await expect(gw.run({ requestId: "r", prompt: "hi" })).rejects.toMatchObject({
      code: "AI_BUDGET_EXCEEDED",
      httpStatus: 429
    });
  });

  it("treats an answer-validation failure as fallback-eligible", async () => {
    const openai = new ScriptedProvider("openai", { behaviour: "raw-json" });
    const mock = new ScriptedProvider("mock", { behaviour: "ok" });
    const gw = new AiGateway({
      providers: new Map([
        ["openai", openai],
        ["mock", mock]
      ]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000
    });
    const out = await gw.run({ requestId: "r", prompt: "hi", preferredProvider: "openai" });
    expect(out.result.provider).toBe("mock");
    expect(out.fallbackUsed).toBe(true);
  });

  it("enforces the per-call timeout (slow provider → fallback)", async () => {
    const slow = new ScriptedProvider("openai", { behaviour: "slow" });
    const mock = new ScriptedProvider("mock", { behaviour: "ok" });
    const gw = new AiGateway({
      providers: new Map([
        ["openai", slow],
        ["mock", mock]
      ]),
      requestTimeoutMs: 30,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000
    });
    const out = await gw.run({ requestId: "r", prompt: "hi", preferredProvider: "openai" });
    expect(out.result.provider).toBe("mock");
    expect(out.fallbackUsed).toBe(true);
  });

  it("stops on client abort without spending a fallback request", async () => {
    const slow = new ScriptedProvider("openai", { behaviour: "slow" });
    const mock = new ScriptedProvider("mock", { behaviour: "ok" });
    const controller = new AbortController();
    const gw = new AiGateway({
      providers: new Map([
        ["openai", slow],
        ["mock", mock]
      ]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000
    });
    const request = gw.run({
      requestId: "client-abort",
      prompt: "hi",
      preferredProvider: "openai",
      clientSignal: controller.signal
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({
      code: "AI_INTERNAL",
      failureKind: "client_abort"
    });
    expect(mock.calls).toBe(0);
  });

  it("skips providers reporting isAvailable=false", async () => {
    const openai = new ScriptedProvider("openai", { available: false, behaviour: "ok" });
    const mock = new ScriptedProvider("mock", { behaviour: "ok" });
    const gw = new AiGateway({
      providers: new Map([
        ["openai", openai],
        ["mock", mock]
      ]),
      requestTimeoutMs: 1000,
      maxRetries: 0,
      maxOutputTokens: 100,
      maxInputChars: 1000
    });
    const out = await gw.run({ requestId: "r", prompt: "hi", preferredProvider: "openai" });
    expect(out.result.provider).toBe("mock");
    expect(openai.calls).toBe(0);
  });

  it("does not silently use mock when mock fallback is disabled", async () => {
    const real = new ScriptedProvider("openai", { available: false });
    const mock = new MockGatewayProvider();
    const gw = new AiGateway({
      providers: new Map([["openai", real], ["mock", mock]]),
      requestTimeoutMs: 100,
      maxRetries: 0,
      maxOutputTokens: 20,
      maxInputChars: 100,
      allowMockFallback: false
    });
    await expect(gw.run({ requestId: "production-request", prompt: "hi" }))
      .rejects.toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", httpStatus: 503 });
  });

  it("keeps mock usage free and uses a generated request id when omitted", async () => {
    const records: Array<{ actualCostMicroUsd: number; totalTokens: number }> = [];
    const gw = new AiGateway({
      providers: new Map([["mock", new MockGatewayProvider()]]),
      requestTimeoutMs: 100,
      maxRetries: 0,
      maxOutputTokens: 20,
      maxInputChars: 100,
      budgetManager: {
        async preCheck() { return { allowed: true, utilisation: 0 }; },
        async recordUsage(input) { records.push(input); }
      }
    });
    const output = await gw.run({ requestId: "", prompt: "hi" });
    expect(output.result.provider).toBe("mock");
    expect(records[0].actualCostMicroUsd).toBe(0);
    expect(records[0].totalTokens).toBeGreaterThan(0);
  });

  // ----- totalTokens includes thinking (spec §4.1) ---------------------------
  it("computes totalTokens = input + output + thinking when provider omits totalTokenCount", async () => {
    // A scripted provider that returns token breakdown WITHOUT totalTokenCount.
    class BreakdownProvider extends ScriptedProvider {
      override async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
        this.calls += 1;
        return {
          provider: this.providerId,
          model: request.model ?? this.defaultModel,
          answer: "details",
          inputTokens: 1100,
          cachedInputTokens: 100,
          outputTokens: 500,
          thinkingTokens: 200,
          // No totalTokens — the gateway must compute it.
          totalTokens: undefined,
          latencyMs: 5,
          estimatedCostMicroUsd: 100,
          finishReason: "stop"
        };
      }
    }
    const records: Array<{ actualCostMicroUsd: number; totalTokens: number }> = [];
    const breakdown = new BreakdownProvider("gemini");
    const gw = new AiGateway({
      providers: new Map([["gemini", breakdown]]),
      requestTimeoutMs: 100,
      maxRetries: 0,
      maxOutputTokens: 20,
      maxInputChars: 100,
      budgetManager: {
        async preCheck() { return { allowed: true, utilisation: 0 }; },
        async recordUsage(input) { records.push(input); }
      }
    });
    await gw.run({ requestId: "r", prompt: "hi", preferredProvider: "gemini" });
    // Gateway fallback: totalTokens = input + output + thinking = 1100 + 500 + 200 = 1800.
    expect(records[0].totalTokens).toBe(1800);
  });
});
