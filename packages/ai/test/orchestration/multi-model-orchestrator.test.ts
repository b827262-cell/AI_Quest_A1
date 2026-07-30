import { describe, expect, it } from "vitest";
import {
  AiGateway,
  AiGatewayError,
  routePrompt,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProviderId,
  type BudgetCheckInput,
  type BudgetManager,
  type GatewayAiProvider,
  type LogicalModelMapping,
  type ModelDailyLimitRow,
  MultiModelOrchestrator,
  type ReservePoolInput,
  type ReservePoolResult,
  type TokenPoolPort,
  type TokenPoolRow
} from "../../src";

class RecordingProvider implements GatewayAiProvider {
  readonly providerId: AiProviderId;
  readonly defaultModel: string;
  readonly calls: AiGenerateRequest[] = [];

  constructor(providerId: AiProviderId, defaultModel: string) {
    this.providerId = providerId;
    this.defaultModel = defaultModel;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.calls.push(request);
    return {
      provider: this.providerId,
      model: request.model ?? this.defaultModel,
      answer: `answer from ${request.model ?? this.defaultModel}`,
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      latencyMs: 0,
      finishReason: "stop"
    };
  }
}

class TestTokenPool implements TokenPoolPort {
  readonly reserveCalls: ReservePoolInput[] = [];
  readonly settledReservations: string[] = [];
  readonly releasedReservations: string[] = [];

  constructor(
    readonly logicalModels: LogicalModelMapping[],
    readonly modelLimits: ModelDailyLimitRow[],
    readonly pools: TokenPoolRow[]
  ) {}

  listEnabledLogicalModels(): LogicalModelMapping[] {
    return this.logicalModels.filter((model) => model.enabled);
  }

  findEnabledLogicalModel(logicalModelId: string): LogicalModelMapping | undefined {
    return this.listEnabledLogicalModels().find((model) => model.logicalModelId === logicalModelId);
  }

  findModelDailyLimit(logicalModelId: string): ModelDailyLimitRow | undefined {
    return this.modelLimits.find((limit) => limit.logicalModelId === logicalModelId);
  }

  findTokenPool(poolId: string): TokenPoolRow | undefined {
    return this.pools.find((pool) => pool.id === poolId);
  }

  reservePool(input: ReservePoolInput): ReservePoolResult {
    this.reserveCalls.push(input);
    return {
      allowed: true,
      reservationId: `pool-reservation:${input.reservationKey}`,
      utilizationRatio: 0
    };
  }

  settlePool(reservationId: string): void {
    this.settledReservations.push(reservationId);
  }

  releasePool(reservationId: string): void {
    this.releasedReservations.push(reservationId);
  }
}

function logicalModel(overrides: Partial<LogicalModelMapping> = {}): LogicalModelMapping {
  return {
    logicalModelId: "gpt-5.6-terra",
    providerId: "mock",
    providerModelName: "terra-test",
    contextWindowTokens: 10_000,
    maxInputTokens: null,
    maxOutputTokens: 100,
    supportsThinking: false,
    tokenizerType: "estimate",
    enabled: true,
    ...overrides
  };
}

function modelLimit(overrides: Partial<ModelDailyLimitRow> = {}): ModelDailyLimitRow {
  return {
    logicalModelId: "gpt-5.6-terra",
    poolId: "shared",
    dailyLimit: 100_000,
    usedTokens: 0,
    reservedTokens: 0,
    priority: 1,
    fallbackLogicalModelId: null,
    enabled: true,
    allowSecondModelVerification: true,
    ...overrides
  };
}

function tokenPool(overrides: Partial<TokenPoolRow> = {}): TokenPoolRow {
  return {
    id: "shared",
    poolType: "shared",
    dailyLimit: 100_000,
    usedTokens: 0,
    reservedTokens: 0,
    enabled: true,
    ...overrides
  };
}

function gatewayFor(provider: RecordingProvider, budgetManager?: BudgetManager): AiGateway {
  return new AiGateway({
    providers: new Map([[provider.providerId, provider]]),
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    maxOutputTokens: 1_000,
    maxInputChars: 20_000,
    autoContinueOnLength: false,
    budgetManager
  });
}

function request(overrides: Partial<Parameters<MultiModelOrchestrator["runPrimary"]>[0]> = {}) {
  return {
    requestId: "orchestrator-test",
    prompt: "請回答這個測試問題",
    preferredLogicalModel: "gpt-5.6-terra",
    ...overrides
  };
}

describe("MultiModelOrchestrator", () => {
  it("runPrimary passes Context Preflight and calls the primary model", async () => {
    const provider = new RecordingProvider("mock", "mock-default");
    const pool = new TestTokenPool(
      [logicalModel({ contextWindowTokens: 100, maxOutputTokens: 20 })],
      [modelLimit({ dailyLimit: 1, usedTokens: 1 })],
      [tokenPool({ dailyLimit: 100, usedTokens: 100 })]
    );
    const orchestrator = new MultiModelOrchestrator(gatewayFor(provider), pool);

    const result = await orchestrator.runPrimary(request({ prompt: "abcdef" }));

    expect(result.output.result.provider).toBe("mock");
    expect(result.logicalModelId).toBe("gpt-5.6-terra");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].model).toBe("terra-test");
    expect(pool.reserveCalls).toHaveLength(0);
    expect(result.utilizationRatio).toBe(1);
  });

  it("runPrimary rejects a Context Window overflow before provider or pool reservation", async () => {
    const provider = new RecordingProvider("mock", "mock-default");
    const pool = new TestTokenPool(
      [logicalModel({ contextWindowTokens: 10, maxOutputTokens: 20 })],
      [modelLimit({ dailyLimit: 1_000, usedTokens: 0 })],
      [tokenPool({ dailyLimit: 1_000 })]
    );
    const orchestrator = new MultiModelOrchestrator(gatewayFor(provider), pool);
    let caught: unknown;

    try {
      await orchestrator.runPrimary(request({ prompt: "a".repeat(30) }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AiGatewayError);
    if (caught instanceof AiGatewayError) {
      expect(caught.code).toBe("AI_INVALID_INPUT");
      expect(caught.diagnostics).toMatchObject({
        errorCategory: "context_window",
        contextWindowExceeded: true,
        contextWindowTotalRequired: 30
      });
      expect(caught.diagnostics).not.toHaveProperty("token_pool_exhausted");
      expect(caught.diagnostics).not.toHaveProperty("model_daily_limit_exhausted");
    }
    expect(provider.calls).toHaveLength(0);
    expect(pool.reserveCalls).toHaveLength(0);
  });

  it("runPrimary reduces output budget to the safe remaining Context Window capacity", async () => {
    const provider = new RecordingProvider("mock", "mock-default");
    const pool = new TestTokenPool(
      [logicalModel({ contextWindowTokens: 100, maxOutputTokens: 80 })],
      [modelLimit({ dailyLimit: 100_000, usedTokens: 10 })],
      [tokenPool({ dailyLimit: 100_000, usedTokens: 10 })]
    );
    const orchestrator = new MultiModelOrchestrator(gatewayFor(provider), pool);

    await orchestrator.runPrimary(request({ prompt: "a".repeat(75) }));

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].maxOutputTokens).toBe(75);
    expect(provider.calls[0].maxOutputTokens).toBeGreaterThanOrEqual(0);
    expect(provider.calls[0].maxOutputTokens).toBeLessThanOrEqual(80);
    expect(pool.reserveCalls).toHaveLength(0);
  });

  it("runVerification skips the second model at the utilization throttle", async () => {
    const provider = new RecordingProvider("mock", "mock-default");
    const pool = new TestTokenPool(
      [
        logicalModel({ contextWindowTokens: 100, maxOutputTokens: 20 }),
        logicalModel({ logicalModelId: "gpt-5.6-sol", providerModelName: "sol-test" })
      ],
      [
        modelLimit({ dailyLimit: 100, usedTokens: 60 }),
        modelLimit({ logicalModelId: "gpt-5.6-sol", poolId: "sol", allowSecondModelVerification: true })
      ],
      [tokenPool({ dailyLimit: 100, usedTokens: 60 }), tokenPool({ id: "sol", poolType: "sol" })]
    );
    const orchestrator = new MultiModelOrchestrator(gatewayFor(provider), pool);
    const primary = await orchestrator.runPrimary(request());

    const verification = await orchestrator.runVerification(request(), primary);

    expect(verification).toBeNull();
    expect(primary.output.result.answer).toBeTruthy();
    expect(provider.calls).toHaveLength(1);
    expect(pool.reserveCalls).toHaveLength(0);
  });

  it("runVerification calls an eligible second model once with an independent request id", async () => {
    const provider = new RecordingProvider("mock", "mock-default");
    const reservationInputs: BudgetCheckInput[] = [];
    const budgetManager: BudgetManager = {
      async preCheck() {
        return { allowed: true, utilisation: 0 };
      },
      async reserve(input) {
        reservationInputs.push(input);
        return {
          allowed: true,
          utilisation: 0,
          reservation: {
            id: `budget:${input.requestId ?? "missing"}`,
            provider: input.provider,
            model: input.model,
            estimatedTokens: input.inputTokens + input.estimatedOutputTokens,
            estimatedCostMicroUsd: input.estimatedCostMicroUsd
          }
        };
      },
      async recordUsage() {},
      async settleReservation() {}
    };
    const pool = new TestTokenPool(
      [
        logicalModel({ contextWindowTokens: 100, maxOutputTokens: 20 }),
        logicalModel({ logicalModelId: "gpt-5.6-sol", providerModelName: "sol-test" })
      ],
      [
        modelLimit({ dailyLimit: 100, usedTokens: 10 }),
        modelLimit({ logicalModelId: "gpt-5.6-sol", poolId: "sol", allowSecondModelVerification: true })
      ],
      [tokenPool({ dailyLimit: 100, usedTokens: 10 }), tokenPool({ id: "sol", poolType: "sol" })]
    );
    const orchestrator = new MultiModelOrchestrator(gatewayFor(provider, budgetManager), pool);
    const primary = await orchestrator.runPrimary(request({ requestId: "request-with-verification" }));

    const verification = await orchestrator.runVerification(
      request({ requestId: "request-with-verification" }),
      primary
    );

    expect(verification?.output.result.model).toBe("sol-test");
    expect(provider.calls).toHaveLength(2);
    expect(reservationInputs).toHaveLength(2);
    expect(reservationInputs.map((input) => input.requestId)).toEqual([
      "request-with-verification",
      "request-with-verification:verify"
    ]);
    expect(reservationInputs[0].requestId).not.toBe(reservationInputs[1].requestId);
    expect(pool.reserveCalls).toHaveLength(0);
  });

  it("runVerification skips a model whose daily-limit policy disallows verification", async () => {
    const provider = new RecordingProvider("mock", "mock-default");
    const pool = new TestTokenPool(
      [
        logicalModel({ contextWindowTokens: 100, maxOutputTokens: 20 }),
        logicalModel({ logicalModelId: "gpt-5.6-sol", providerModelName: "sol-test" })
      ],
      [
        modelLimit({ dailyLimit: 100, usedTokens: 10 }),
        modelLimit({ logicalModelId: "gpt-5.6-sol", poolId: "sol", allowSecondModelVerification: false })
      ],
      [tokenPool({ dailyLimit: 100, usedTokens: 10 }), tokenPool({ id: "sol", poolType: "sol" })]
    );
    const orchestrator = new MultiModelOrchestrator(gatewayFor(provider), pool);
    const primary = await orchestrator.runPrimary(request());

    expect(await orchestrator.runVerification(request(), primary)).toBeNull();
    expect(provider.calls).toHaveLength(1);
    expect(pool.reserveCalls).toHaveLength(0);
  });

  it("keeps the router's ineligible second-model reason intact", () => {
    const decision = routePrompt("請問今天的閱讀重點是什麼？", {
      availableProviderIds: ["qwen", "mock"]
    });

    expect(decision.secondModelEligible).toBe(false);
    expect(decision.secondModelReason).toContain("不需第二模型");
  });

  it("does not route Sol directly from the default high-complexity router", () => {
    const decision = routePrompt("請計算這個方程式並詳細推導每一步：" + "x".repeat(300), {
      availableProviderIds: ["openai", "mock"]
    });

    expect(decision.preferredProvider).toBe("openai");
    expect(decision.preferredLogicalModel).not.toBe("gpt-5.6-sol");
    expect(decision.reason).not.toContain("Sol");
  });
});
