import { describe, expect, it } from "vitest";
import {
  AiGateway,
  AiGatewayError,
  MultiModelOrchestrator,
  type AiGenerateRequest,
  type AiGenerateResult,
  type AiProviderId,
  type DomainVerificationStrategy,
  type GatewayAiProvider,
  type LogicalModelMapping,
  type ModelDailyLimitRow,
  type ModelRequest,
  type ReservePoolInput,
  type ReservePoolResult,
  type TaskCategory,
  type TokenPoolPort,
  type TokenPoolRow,
  type VerificationEvidence
} from "../../src";

class DomainProvider implements GatewayAiProvider {
  readonly providerId: AiProviderId = "mock";
  readonly defaultModel = "primary-model";
  readonly calls: AiGenerateRequest[] = [];
  primaryAnswer = "Primary answer remains available.";
  verificationAnswer = JSON.stringify({ decision: "agree", issues: [] });
  adjudicationAnswer = JSON.stringify({ decision: "primary_correct", finalAnswer: "safe adjudication" });

  async isAvailable(): Promise<boolean> { return true; }

  async generate(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.calls.push(request);
    const answer = request.model === "verification-model"
      ? this.verificationAnswer
      : request.model === "adjudication-model"
        ? this.adjudicationAnswer
        : this.primaryAnswer;
    return {
      provider: "mock",
      model: request.model ?? this.defaultModel,
      answer,
      inputTokens: 4,
      outputTokens: 4,
      totalTokens: 8,
      latencyMs: 0,
      finishReason: "stop"
    };
  }
}

class DomainPool implements TokenPoolPort {
  readonly reservations: ReservePoolInput[] = [];
  readonly logicalModels: LogicalModelMapping[] = [
    this.model("primary", "primary-model"),
    this.model("verification", "verification-model"),
    this.model("adjudication", "adjudication-model")
  ];
  readonly limits: ModelDailyLimitRow[] = [
    this.limit("primary", "primary-pool"),
    this.limit("verification", "verification-pool"),
    this.limit("adjudication", "adjudication-pool")
  ];
  readonly pools: TokenPoolRow[] = [
    this.pool("primary-pool"),
    this.pool("verification-pool"),
    this.pool("adjudication-pool")
  ];

  listEnabledLogicalModels(): LogicalModelMapping[] { return this.logicalModels; }
  findEnabledLogicalModel(id: string): LogicalModelMapping | undefined { return this.logicalModels.find((model) => model.logicalModelId === id && model.enabled); }
  findModelDailyLimit(id: string): ModelDailyLimitRow | undefined { return this.limits.find((limit) => limit.logicalModelId === id); }
  findTokenPool(id: string): TokenPoolRow | undefined { return this.pools.find((pool) => pool.id === id); }
  reservePool(input: ReservePoolInput): ReservePoolResult {
    this.reservations.push(input);
    return { allowed: true, reservationId: `reservation:${input.requestId}`, utilizationRatio: 0 };
  }
  settlePool(): void {}
  releasePool(): void {}

  private model(logicalModelId: string, providerModelName: string): LogicalModelMapping {
    return { logicalModelId, providerId: "mock", providerModelName, contextWindowTokens: 10_000, maxInputTokens: null, maxOutputTokens: 100, supportsThinking: false, tokenizerType: "estimate", enabled: true };
  }
  private limit(logicalModelId: string, poolId: string): ModelDailyLimitRow {
    return { logicalModelId, poolId, dailyLimit: 100, usedTokens: 0, reservedTokens: 0, priority: 1, fallbackLogicalModelId: null, enabled: true, allowSecondModelVerification: true, allowAdjudication: true };
  }
  private pool(id: string): TokenPoolRow { return { id, poolType: id, dailyLimit: 100, usedTokens: 0, reservedTokens: 0, enabled: true }; }
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    requestId: "domain-request",
    prompt: "計算 2 + 2。",
    preferredLogicalModel: "primary",
    verificationLogicalModel: "verification",
    adjudicationLogicalModel: "adjudication",
    secondModelEligible: true,
    allowAdjudication: true,
    ...overrides
  };
}

function makeOrchestrator(provider: DomainProvider, pool: DomainPool, strategies?: DomainVerificationStrategy[]): MultiModelOrchestrator {
  return new MultiModelOrchestrator(
    new AiGateway({ providers: new Map([["mock", provider]]), requestTimeoutMs: 1_000, maxRetries: 0, maxOutputTokens: 200, maxInputChars: 20_000 }),
    pool,
    strategies
  );
}

describe("domain verification integration", () => {
  it("adds mathematical evidence before the existing model verification", async () => {
    const provider = new DomainProvider();
    provider.primaryAnswer = "答案是 4";
    const result = await makeOrchestrator(provider, new DomainPool()).runWithFusion(request());
    expect(result.diagnostics).toMatchObject({ taskCategory: "mathematics", verificationStrategy: "mathematical_numeric", evidenceStatus: "passed", confidenceLevel: "high", confidenceBasis: "deterministic_verified" });
  });

  it("forces a high-severity deterministic mismatch into existing conflict handling", async () => {
    const provider = new DomainProvider();
    provider.primaryAnswer = "答案是 5";
    const result = await makeOrchestrator(provider, new DomainPool()).runWithFusion(request({ allowAdjudication: false }));
    expect(result.diagnostics).toMatchObject({ outcome: "unresolved", conflictDetected: true, fallbackReason: "adjudication_disabled" });
    expect(result.finalAnswer).toBe("答案是 5");
  });

  it("keeps Primary when an injected domain strategy fails", async () => {
    const provider = new DomainProvider();
    const failing: DomainVerificationStrategy = {
      supports: (category: TaskCategory) => category === "mathematics",
      verify: async () => { throw new Error("private provider error"); }
    };
    const result = await makeOrchestrator(provider, new DomainPool(), [failing]).runWithFusion(request());
    expect(result.finalAnswer).toBe("Primary answer remains available.");
    expect(result.diagnostics.evidenceStatus).toBe("unavailable");
  });

  it("does not force conflict when deterministic evidence is unavailable", async () => {
    const provider = new DomainProvider();
    const unavailable: DomainVerificationStrategy = {
      supports: () => true,
      verify: async (): Promise<VerificationEvidence> => ({ strategy: "none", status: "unavailable", confidence: 0, issues: [] })
    };
    const result = await makeOrchestrator(provider, new DomainPool(), [unavailable]).runWithFusion(request());
    expect(result.diagnostics).toMatchObject({ outcome: "verified", conflictDetected: false, evidenceStatus: "unavailable" });
  });

  it("does not call a domain strategy twice for a concurrent same request", async () => {
    const provider = new DomainProvider();
    let calls = 0;
    const strategy: DomainVerificationStrategy = {
      supports: () => true,
      verify: async (): Promise<VerificationEvidence> => {
        calls += 1;
        return { strategy: "mathematical_numeric", status: "partial", confidence: 0.5, issues: [] };
      }
    };
    const orchestrator = makeOrchestrator(provider, new DomainPool(), [strategy]);
    await Promise.all([orchestrator.runWithFusion(request()), orchestrator.runWithFusion(request())]);
    expect(calls).toBe(1);
  });

  it("preserves the existing verification and adjudication request ids", async () => {
    const provider = new DomainProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [{ category: "logic", severity: "high", description: "safe conflict" }] });
    const result = await makeOrchestrator(provider, new DomainPool()).runWithFusion(request());
    expect(result.diagnostics.adjudicationAttempted).toBe(true);
    expect(provider.calls.map((call) => call.requestId)).toEqual(["domain-request", "domain-request:verify", "domain-request:adjudicate"]);
  });

  it("passes only safe evidence fields to adjudication", async () => {
    const provider = new DomainProvider();
    provider.verificationAnswer = JSON.stringify({ decision: "conflict", issues: [{ category: "logic", severity: "high", description: "safe conflict" }] });
    await makeOrchestrator(provider, new DomainPool()).runWithFusion(request({ prompt: "PRIVATE QUESTION" }));
    const adjudicationPrompt = provider.calls[2]?.prompt ?? "";
    expect(adjudicationPrompt).not.toContain("modelCallCount");
    expect(adjudicationPrompt).toContain("PRIVATE QUESTION");
    expect(adjudicationPrompt).toContain("safe conflict");
  });

  it("passes the bounded deterministic evidence summary to adjudication", async () => {
    const provider = new DomainProvider();
    provider.primaryAnswer = "答案是 5";
    await makeOrchestrator(provider, new DomainPool()).runWithFusion(request());
    const adjudicationPrompt = provider.calls[2]?.prompt ?? "";
    expect(adjudicationPrompt).toContain("numeric_check_failed");
    expect(adjudicationPrompt).not.toContain("modelCallCount");
  });

  it("keeps a partial evidence result non-conflicting", async () => {
    const provider = new DomainProvider();
    const partial: DomainVerificationStrategy = {
      supports: () => true,
      verify: async (): Promise<VerificationEvidence> => ({ strategy: "mathematical_numeric", status: "partial", confidence: 0.5, issues: [] })
    };
    const result = await makeOrchestrator(provider, new DomainPool(), [partial]).runWithFusion(request());
    expect(result.diagnostics).toMatchObject({ outcome: "verified", evidenceStatus: "partial", confidenceLevel: "medium" });
  });

  it("uses generic model evidence for unknown tasks", async () => {
    const provider = new DomainProvider();
    const result = await makeOrchestrator(provider, new DomainPool()).runWithFusion(request({ prompt: "請給我一個適合今天的回答。" }));
    expect(result.diagnostics).toMatchObject({ taskCategory: "unknown", verificationStrategy: "generic_model", evidenceStatus: "not_applicable" });
  });

  it("does not rerun Primary after domain verification failure", async () => {
    const provider = new DomainProvider();
    const failing: DomainVerificationStrategy = { supports: () => true, verify: async () => { throw new Error("failure"); } };
    const result = await makeOrchestrator(provider, new DomainPool(), [failing]).runWithFusion(request());
    expect(provider.calls.filter((call) => call.requestId === "domain-request")).toHaveLength(1);
    expect(result.finalAnswer).toBe("Primary answer remains available.");
  });

  it("does not expose provider failure text in fallback diagnostics", async () => {
    const provider = new DomainProvider();
    const failing: DomainVerificationStrategy = { supports: () => true, verify: async () => { throw new AiGatewayError("AI_PROVIDER_UNAVAILABLE", "PRIVATE RAW ERROR"); } };
    const result = await makeOrchestrator(provider, new DomainPool(), [failing]).runWithFusion(request());
    expect(JSON.stringify(result.diagnostics)).not.toContain("PRIVATE RAW ERROR");
  });
});
