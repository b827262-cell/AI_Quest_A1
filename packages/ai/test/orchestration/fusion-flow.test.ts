import { describe, expect, it } from "vitest";
import {
  AiGateway,
  AiGatewayError,
  MultiModelOrchestrator,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProviderId,
  type BudgetCheckInput,
  type BudgetManager,
  type GatewayAiProvider,
  type LogicalModelMapping,
  type ModelDailyLimitRow,
  type ModelRequest,
  type ReservePoolInput,
  type ReservePoolResult,
  type TokenPoolPort,
  type TokenPoolRow
} from "../../src";

class FusionProvider implements GatewayAiProvider {
  readonly providerId: AiProviderId = "mock";
  readonly defaultModel = "primary-model";
  readonly calls: AiGenerateRequest[] = [];
  verificationAnswer = JSON.stringify({ decision: "agree", confidence: 0.95, issues: [] });
  adjudicationAnswer = JSON.stringify({
    decision: "primary_correct",
    finalAnswer: "裁決答案",
    confidence: 0.9,
    reasonCategory: "logic"
  });
  failVerification = false;
  failAdjudication = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.calls.push(request);
    if (request.model === "verification-model") {
      if (this.failVerification) {
        throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", "safe provider failure");
      }
      return this.result(request, this.verificationAnswer);
    }
    if (request.model === "adjudication-model") {
      if (this.failAdjudication) {
        throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", "safe provider failure");
      }
      return this.result(request, this.adjudicationAnswer);
    }
    return this.result(request, "Primary answer stays available.");
  }

  private result(request: AiGenerateRequest, answer: string): AiGenerateResult {
    return {
      provider: "mock",
      model: request.model ?? this.defaultModel,
      answer,
      inputTokens: 8,
      outputTokens: 6,
      totalTokens: 14,
      latencyMs: 0,
      finishReason: "stop"
    };
  }
}

class FusionPool implements TokenPoolPort {
  readonly reserveCalls: ReservePoolInput[] = [];

  constructor(
    readonly logicalModels: LogicalModelMapping[],
    readonly limits: ModelDailyLimitRow[],
    readonly pools: TokenPoolRow[]
  ) {}

  listEnabledLogicalModels(): LogicalModelMapping[] {
    return this.logicalModels.filter((model) => model.enabled);
  }

  findEnabledLogicalModel(logicalModelId: string): LogicalModelMapping | undefined {
    return this.listEnabledLogicalModels().find((model) => model.logicalModelId === logicalModelId);
  }

  findModelDailyLimit(logicalModelId: string): ModelDailyLimitRow | undefined {
    return this.limits.find((limit) => limit.logicalModelId === logicalModelId);
  }

  findTokenPool(poolId: string): TokenPoolRow | undefined {
    return this.pools.find((pool) => pool.id === poolId);
  }

  reservePool(input: ReservePoolInput): ReservePoolResult {
    this.reserveCalls.push(input);
    return { allowed: true, reservationId: `pool:${input.reservationKey}`, utilizationRatio: 0 };
  }

  settlePool(): void {}
  releasePool(): void {}
}

function logicalModel(
  logicalModelId: string,
  providerModelName: string,
  contextWindowTokens = 10_000
): LogicalModelMapping {
  return {
    logicalModelId,
    providerId: "mock",
    providerModelName,
    contextWindowTokens,
    maxInputTokens: null,
    maxOutputTokens: 100,
    supportsThinking: false,
    tokenizerType: "estimate",
    enabled: true
  };
}

function modelLimit(
  logicalModelId: string,
  poolId: string,
  usedTokens = 10,
  allowAdjudication = true
): ModelDailyLimitRow {
  return {
    logicalModelId,
    poolId,
    dailyLimit: 100,
    usedTokens,
    reservedTokens: 0,
    priority: 1,
    fallbackLogicalModelId: null,
    enabled: true,
    allowSecondModelVerification: true,
    allowAdjudication
  };
}

function pool(id: string, usedTokens = 10): TokenPoolRow {
  return { id, poolType: id, dailyLimit: 100, usedTokens, reservedTokens: 0, enabled: true };
}

function makePool(options: {
  verificationUsed?: number;
  verificationContextWindow?: number;
  adjudicationUsed?: number;
  adjudicationContextWindow?: number;
  allowAdjudication?: boolean;
} = {}): FusionPool {
  return new FusionPool(
    [
      logicalModel("primary", "primary-model"),
      logicalModel("verification", "verification-model", options.verificationContextWindow ?? 10_000),
      logicalModel("adjudication", "adjudication-model", options.adjudicationContextWindow ?? 10_000)
    ],
    [
      modelLimit("primary", "primary-pool"),
      modelLimit("verification", "verification-pool", options.verificationUsed ?? 10),
      modelLimit("adjudication", "adjudication-pool", options.adjudicationUsed ?? 10, options.allowAdjudication ?? true)
    ],
    [pool("primary-pool"), pool("verification-pool", options.verificationUsed ?? 10), pool("adjudication-pool", options.adjudicationUsed ?? 10)]
  );
}

interface BudgetTrace {
  reservations: BudgetCheckInput[];
  settled: string[];
  released: string[];
}

function makeBudget(): { manager: BudgetManager; trace: BudgetTrace } {
  const trace: BudgetTrace = { reservations: [], settled: [], released: [] };
  const manager: BudgetManager = {
    async preCheck() {
      return { allowed: true, utilisation: 0 };
    },
    async reserve(input) {
      trace.reservations.push(input);
      return {
        allowed: true,
        utilisation: 0,
        reservation: {
          id: `reservation:${input.requestId ?? "unknown"}`,
          provider: input.provider,
          model: input.model,
          estimatedTokens: input.inputTokens + input.estimatedOutputTokens,
          estimatedCostMicroUsd: input.estimatedCostMicroUsd
        }
      };
    },
    async recordUsage() {},
    async settleReservation(reservation) {
      trace.settled.push(reservation.id);
    },
    async releaseReservation(reservation) {
      trace.released.push(reservation.id);
    }
  };
  return { manager, trace };
}

function makeOrchestrator(
  provider: FusionProvider,
  pool: FusionPool,
  budget?: BudgetManager
): MultiModelOrchestrator {
  const gateway = new AiGateway({
    providers: new Map([["mock", provider]]),
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    maxOutputTokens: 200,
    maxInputChars: 30_000,
    autoContinueOnLength: false,
    budgetManager: budget
  });
  return new MultiModelOrchestrator(gateway, pool);
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: "fusion-request",
    prompt: "請判斷這個答案是否正確。",
    preferredLogicalModel: "primary",
    verificationLogicalModel: "verification",
    adjudicationLogicalModel: "adjudication",
    secondModelEligible: true,
    allowAdjudication: true,
    ...overrides
  };
}

describe("MultiModelOrchestrator fusion flow", () => {
  it("keeps Primary for agree, skips adjudication, and settles verification", async () => {
    const provider = new FusionProvider();
    const pool = makePool();
    const budget = makeBudget();
    const result = await makeOrchestrator(provider, pool, budget.manager).runWithFusion(request());

    expect(result.finalAnswer).toBe("Primary answer stays available.");
    expect(result.diagnostics).toMatchObject({
      outcome: "verified",
      verificationAttempted: true,
      adjudicationAttempted: false,
      conflictDetected: false,
      modelCallCount: 2
    });
    expect(provider.calls).toHaveLength(2);
    expect(budget.trace.reservations.map((input) => input.requestId)).toEqual([
      "fusion-request",
      "fusion-request:verify"
    ]);
    expect(budget.trace.settled).toEqual(["reservation:fusion-request", "reservation:fusion-request:verify"]);
  });

  it("fuses a supplement without changing Primary's core answer", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({
      decision: "supplement",
      confidence: 0.8,
      issues: [{ category: "missing_information", severity: "medium", description: "缺少條件" }],
      supplementalContent: "補充必要條件。"
    });
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(request());

    expect(result.diagnostics.outcome).toBe("supplemented");
    expect(result.finalAnswer).toBe("Primary answer stays available.\n\n補充說明：\n補充必要條件。");
    expect(provider.calls).toHaveLength(2);
  });

  it("returns unresolved for uncertain verification while keeping Primary", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "uncertain", issues: [] });
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(request());

    expect(result.finalAnswer).toBe("Primary answer stays available.");
    expect(result.diagnostics).toMatchObject({ outcome: "unresolved", fallbackReason: "verification_uncertain" });
  });

  it("adjudicates a conflict once with independent request and reservation ids", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({
      decision: "conflict",
      confidence: 0.7,
      issues: [{ category: "logic", severity: "high", description: "兩個結論衝突" }],
      proposedAnswer: "不可直接採用"
    });
    const budget = makeBudget();
    const orchestrator = makeOrchestrator(provider, makePool(), budget.manager);
    const result = await orchestrator.runWithFusion(request());

    expect(result.finalAnswer).toBe("Primary answer stays available.");
    expect(result.diagnostics).toMatchObject({
      outcome: "adjudicated",
      conflictDetected: true,
      adjudicationAttempted: true,
      modelCallCount: 3
    });
    expect(provider.calls.map((call) => call.requestId)).toEqual([
      "fusion-request",
      "fusion-request:verify",
      "fusion-request:adjudicate"
    ]);
    expect(budget.trace.reservations.map((input) => input.requestId)).toEqual([
      "fusion-request",
      "fusion-request:verify",
      "fusion-request:adjudicate"
    ]);
  });

  it("never uses an unadjudicated Verification proposedAnswer", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({
      decision: "conflict",
      issues: [{ category: "factual", severity: "high", description: "衝突" }],
      proposedAnswer: "不應直接輸出"
    });
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(
      request({ allowAdjudication: false })
    );

    expect(result.finalAnswer).toBe("Primary answer stays available.");
    expect(result.diagnostics).toMatchObject({
      outcome: "unresolved",
      fallbackReason: "adjudication_disabled",
      adjudicationAttempted: false
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("does not call adjudication when its quota is exhausted", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    const result = await makeOrchestrator(provider, makePool({ adjudicationUsed: 100 })).runWithFusion(request());

    expect(result.diagnostics).toMatchObject({ outcome: "unresolved", fallbackReason: "adjudication_quota_exhausted" });
    expect(provider.calls).toHaveLength(2);
  });

  it("does not call adjudication when the model policy disables it", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    const result = await makeOrchestrator(provider, makePool({ allowAdjudication: false })).runWithFusion(request());

    expect(result.diagnostics).toMatchObject({ outcome: "unresolved", fallbackReason: "adjudication_disabled" });
    expect(provider.calls).toHaveLength(2);
  });

  it("does not call adjudication when its Context Window preflight fails", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    const result = await makeOrchestrator(
      provider,
      makePool({ adjudicationContextWindow: 10 })
    ).runWithFusion(request());

    expect(result.diagnostics).toMatchObject({
      outcome: "unresolved",
      fallbackReason: "adjudication_context_window"
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("falls back safely when adjudication output is malformed", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    provider.adjudicationAnswer = "not-json";
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(request());

    expect(result.finalAnswer).toBe("Primary answer stays available.");
    expect(result.diagnostics).toMatchObject({ outcome: "unresolved", fallbackReason: "adjudication_parse_failed" });
  });

  it("marks insufficient information unresolved instead of claiming certainty", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    provider.adjudicationAnswer = JSON.stringify({
      decision: "insufficient_information",
      finalAnswer: "目前資訊不足，無法可靠裁決。",
      confidence: 0.2,
      reasonCategory: "missing_information"
    });
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(request());

    expect(result.finalAnswer).toBe("目前資訊不足，無法可靠裁決。");
    expect(result.diagnostics).toMatchObject({
      outcome: "unresolved",
      fallbackReason: "adjudication_insufficient_information"
    });
  });

  it("returns an adjudicated merged answer when the adjudicator resolves the conflict", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    provider.adjudicationAnswer = JSON.stringify({
      decision: "merged_answer",
      finalAnswer: "Primary answer stays available. 裁決補充。",
      confidence: 0.88,
      reasonCategory: "logic"
    });
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(request());

    expect(result.diagnostics.outcome).toBe("adjudicated");
    expect(result.finalAnswer).toContain("裁決補充");
  });

  it("keeps Primary when adjudication provider fails and releases its reservation", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    provider.failAdjudication = true;
    const budget = makeBudget();
    const result = await makeOrchestrator(provider, makePool(), budget.manager).runWithFusion(request());

    expect(result.finalAnswer).toBe("Primary answer stays available.");
    expect(result.diagnostics).toMatchObject({ outcome: "unresolved", fallbackReason: "adjudication_unavailable" });
    expect(budget.trace.released).toEqual(["reservation:fusion-request:adjudicate"]);
  });

  it("does not call verification when Router eligibility is false", async () => {
    const provider = new FusionProvider();
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(
      request({ secondModelEligible: false, secondModelReason: "低難度一般問題" })
    );

    expect(result.diagnostics).toMatchObject({
      outcome: "primary_only",
      verificationAttempted: false,
      secondModelReason: "低難度一般問題",
      fallbackReason: "second_model_ineligible"
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("does not call verification when its quota is exhausted", async () => {
    const provider = new FusionProvider();
    const result = await makeOrchestrator(provider, makePool({ verificationUsed: 100 })).runWithFusion(request());

    expect(result.diagnostics).toMatchObject({
      outcome: "primary_only",
      verificationAttempted: false,
      fallbackReason: "verification_quota_exhausted"
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("does not call verification when its independent Context Window preflight fails", async () => {
    const provider = new FusionProvider();
    const result = await makeOrchestrator(
      provider,
      makePool({ verificationContextWindow: 10 })
    ).runWithFusion(request());

    expect(result.diagnostics).toMatchObject({
      outcome: "primary_only",
      verificationAttempted: true,
      fallbackReason: "verification_context_window"
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("throttles verification at the existing utilization boundary", async () => {
    const provider = new FusionProvider();
    const pool = makePool();
    pool.pools[0].usedTokens = 60;
    const result = await makeOrchestrator(provider, pool).runWithFusion(request());

    expect(result.diagnostics).toMatchObject({ outcome: "primary_only", fallbackReason: "verification_throttled" });
    expect(provider.calls).toHaveLength(1);
  });

  it("throttles adjudication using the adjudication model pool", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    const result = await makeOrchestrator(provider, makePool({ adjudicationUsed: 80 })).runWithFusion(request());

    expect(result.diagnostics).toMatchObject({ outcome: "unresolved", fallbackReason: "adjudication_throttled" });
    expect(provider.calls).toHaveLength(2);
  });

  it("uses Primary-only when verification output is invalid", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = "not-json";
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(request());

    expect(result.finalAnswer).toBe("Primary answer stays available.");
    expect(result.diagnostics).toMatchObject({ outcome: "unresolved", fallbackReason: "verification_parse_failed" });
  });

  it("releases a verification reservation after provider failure", async () => {
    const provider = new FusionProvider();
    provider.failVerification = true;
    const budget = makeBudget();
    const result = await makeOrchestrator(provider, makePool(), budget.manager).runWithFusion(request());

    expect(result.diagnostics).toMatchObject({ outcome: "primary_only", fallbackReason: "verification_unavailable" });
    expect(budget.trace.released).toEqual(["reservation:fusion-request:verify"]);
  });

  it("does not repeat verification or adjudication for the same request", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [] });
    const orchestrator = makeOrchestrator(provider, makePool());
    const [first, second] = await Promise.all([
      orchestrator.runWithFusion(request()),
      orchestrator.runWithFusion(request())
    ]);

    expect(first).toBe(second);
    expect(provider.calls.map((call) => call.requestId)).toEqual([
      "fusion-request",
      "fusion-request:verify",
      "fusion-request:adjudicate"
    ]);
  });

  it("keeps diagnostics free of Prompt, Verification text, and provider errors", async () => {
    const provider = new FusionProvider();
    provider.verificationAnswer = JSON.stringify({
      decision: "conflict",
      issues: [{ category: "other", severity: "high", description: "PRIVATE-VERIFICATION-TEXT" }]
    });
    const result = await makeOrchestrator(provider, makePool()).runWithFusion(
      request({ prompt: "PRIVATE-PROMPT-TEXT" })
    );

    const diagnostics = JSON.stringify(result.diagnostics);
    expect(diagnostics).not.toContain("PRIVATE-PROMPT-TEXT");
    expect(diagnostics).not.toContain("PRIVATE-VERIFICATION-TEXT");
    expect(diagnostics).not.toContain("provider failure");
  });
});
