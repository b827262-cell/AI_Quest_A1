import type { AiGateway, GatewayRunInput, GatewayRunOutput } from "../gateway/ai-gateway";
import type { AiGatewayError, AiRequestSource } from "../gateway/ai-types";
import { AiGatewayError as AiGatewayErrorClass } from "../gateway/ai-types";
import { checkContextWindow, estimateTokenCount, reducedOutputBudget } from "./context-preflight";
import { formalContextWindow } from "../provider-compliance";
import {
  buildAdjudicationPrompt,
  parseAdjudicationResult,
  type AdjudicationResult
} from "./adjudication";
import { fusePrimaryAndVerification } from "./answer-fusion";
import type {
  MultiModelFusionDiagnostics,
  OrchestrationFallbackReason
} from "./orchestration-diagnostics";
import { classifyTaskCategory } from "./classification/task-classifier";
import type { TaskClassification } from "./classification/classification-types";
import {
  deriveAnswerConfidence,
  type AnswerConfidence
} from "./verification/confidence";
import {
  GenericModelVerificationStrategy,
  unavailableEvidence
} from "./verification/verification-strategy";
import { MathematicsVerifier } from "./verification/mathematics-verifier";
import { KnowledgeConsistencyVerifier } from "./verification/knowledge-verifier";
import { ProgrammingStaticVerifier } from "./verification/programming-verifier";
import type {
  DomainVerificationStrategy,
  VerificationEvidence,
  VerificationStrategyContext
} from "./verification/verification-evidence";
import {
  buildVerificationPrompt,
  parseVerificationResult,
  type VerificationResult
} from "./verification-result";
import type { TokenPoolPort } from "./token-pool-ports";

export interface ModelRequest {
  requestId: string;
  prompt: string;
  systemPrompt?: string;
  /** Logical model id to route to (e.g. "gpt-5.6-terra"). */
  preferredLogicalModel?: string;
  /** Explicit verification target. Sol is never inferred as a router target. */
  verificationLogicalModel?: string;
  /** Explicit adjudication target; no default model is assumed. */
  adjudicationLogicalModel?: string;
  /** Router eligibility is an input to orchestration, not a new routing rule. */
  secondModelEligible?: boolean;
  secondModelReason?: string;
  /** Conflict adjudication is opt-in unless a caller explicitly enables it. */
  allowAdjudication?: boolean;
  requestSource?: AiRequestSource;
  scopeKey?: string;
  clientSignal?: AbortSignal;
  /** Explicit provider override (bypasses logical-model mapping when set). */
  preferredProvider?: GatewayRunInput["preferredProvider"];
}

export interface ModelResult {
  output: GatewayRunOutput;
  /** Pool utilization ratio (0..1+) at the time of the model call. */
  utilizationRatio: number;
  /** Logical model id that handled the request, when mapped. */
  logicalModelId?: string;
}

export interface FusionOptions {
  verificationLogicalModel?: string;
  adjudicationLogicalModel?: string;
  allowAdjudication?: boolean;
}

/** Final answer plus safe orchestration metadata; raw verification text is not returned. */
export interface MultiModelFusionResult {
  finalAnswer: string;
  primary: ModelResult;
  diagnostics: MultiModelFusionDiagnostics;
  confidence: AnswerConfidence;
}

interface PassAttempt {
  result: ModelResult | null;
  attempted: boolean;
  reason?: OrchestrationFallbackReason;
}

/** Utilization throttle tiers (ratios, 0..1). Mirrors the existing protection table. */
const THROTTLE_STOP_SECOND_MODEL = 0.6;
const THROTTLE_RESTRICT_TERRA = 0.8;
const THROTTLE_STOP_VERIFICATION = 0.9;
const THROTTLE_STOP_ADJUDICATION = 0.8;

function safeRouterReason(reason: string | undefined): string | undefined {
  if (!reason || reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) return undefined;
  return reason.trim() || undefined;
}

export class MultiModelOrchestrator {
  private readonly fusionRuns = new Map<string, Promise<MultiModelFusionResult>>();

  constructor(
    private readonly gateway: AiGateway,
    private readonly pool: TokenPoolPort,
    private readonly domainStrategies: DomainVerificationStrategy[] = [
      new ProgrammingStaticVerifier(),
      new MathematicsVerifier(),
      new KnowledgeConsistencyVerifier(),
      new GenericModelVerificationStrategy()
    ]
  ) {}

  /**
   * Run the primary model. Context preflight happens before the gateway, so a
   * request that cannot fit never reaches provider or reservation code.
   */
  async runPrimary(req: ModelRequest): Promise<ModelResult> {
    const mapped = req.preferredLogicalModel
      ? this.pool.findEnabledLogicalModel(req.preferredLogicalModel)
      : undefined;

    if (!mapped) {
      const output = await this.gateway.run(this.toGatewayInput(req));
      return { output, utilizationRatio: 0 };
    }

    const estimatedInput = estimateTokenCount((req.systemPrompt ?? "") + req.prompt);
    const thinkingBudget = mapped.supportsThinking ? this.thinkingBudget(mapped.maxOutputTokens) : 0;
    const formalWindow = formalContextWindow(mapped.contextWindowTokens, mapped.capabilityEvidence);
    if (formalWindow === undefined) {
      throw this.contextWindowError({
        reason: "context_window_exceeded",
        totalRequired: estimatedInput + mapped.maxOutputTokens + thinkingBudget,
        contextWindowTokens: 0
      }, mapped.logicalModelId);
    }
    const preflightInput = {
      estimatedInputTokens: estimatedInput,
      reservedOutputTokens: mapped.maxOutputTokens,
      reservedThinkingTokens: thinkingBudget,
      contextWindowTokens: formalWindow,
      maxInputTokens: mapped.maxInputTokens
    };
    const preflight = checkContextWindow(preflightInput);

    let effectiveMaxOutput = mapped.maxOutputTokens;
    if (!preflight.ok) {
      if (preflight.reason === "context_window_exceeded") {
        const reduced = reducedOutputBudget(preflightInput);
        if (reduced > 0) {
          effectiveMaxOutput = Math.min(mapped.maxOutputTokens, reduced);
        } else {
          throw this.contextWindowError(preflight, mapped.logicalModelId);
        }
      } else {
        throw this.contextWindowError(preflight, mapped.logicalModelId);
      }
    }

    const output = await this.gateway.run(
      this.toGatewayInput(req, {
        preferredProvider: mapped.providerId as GatewayRunInput["preferredProvider"],
        preferredModel: mapped.providerModelName,
        maxOutputTokens: effectiveMaxOutput
      })
    );
    return {
      output,
      utilizationRatio: this.poolUtilization(mapped.logicalModelId),
      logicalModelId: mapped.logicalModelId
    };
  }

  /**
   * Backward-compatible raw verification API. Fusion callers should use
   * runWithFusion(), which supplies the structured verification prompt.
   */
  async runVerification(
    req: ModelRequest,
    primary: ModelResult,
    verificationLogicalModel?: string
  ): Promise<ModelResult | null> {
    const attempt = await this.attemptVerification(
      req,
      primary,
      verificationLogicalModel ?? req.verificationLogicalModel,
      req.prompt
    );
    return attempt.result;
  }

  /** Execute primary → structured verification → deterministic fusion → optional adjudication. */
  async runWithFusion(req: ModelRequest, options: FusionOptions = {}): Promise<MultiModelFusionResult> {
    const existing = this.fusionRuns.get(req.requestId);
    if (existing) return existing;

    const execution = this.executeFusion(req, options);
    this.fusionRuns.set(req.requestId, execution);
    return execution;
  }

  /** Short alias for callers that treat the orchestrator as the answer service. */
  async run(req: ModelRequest, options: FusionOptions = {}): Promise<MultiModelFusionResult> {
    return this.runWithFusion(req, options);
  }

  private async executeFusion(req: ModelRequest, options: FusionOptions): Promise<MultiModelFusionResult> {
    const primary = await this.runPrimary(req);
    const classification = this.classify(req.prompt);
    const evidence = await this.runDomainVerification(req, primary, classification);
    const verificationModel =
      options.verificationLogicalModel ??
      req.verificationLogicalModel ??
      this.defaultVerificationLogicalModel(primary.logicalModelId);
    const baseDiagnostics = {
      verificationAttempted: false,
      verificationModel,
      secondModelReason: safeRouterReason(req.secondModelReason),
      adjudicationAttempted: false,
      conflictDetected: false,
      modelCallCount: 1,
      taskCategory: classification.category,
      classificationSource: classification.source,
      verificationStrategy: evidence.strategy,
      evidenceStatus: evidence.status
    } satisfies Omit<MultiModelFusionDiagnostics, "outcome">;

    const verification = await this.attemptVerification(
      req,
      primary,
      verificationModel,
      buildVerificationPrompt(req.prompt, primary.output.result.answer)
    );
    if (!verification.result) {
      const domainConflict = this.hasHighSeverityEvidenceFailure(evidence);
      const confidence = deriveAnswerConfidence(
        domainConflict ? "unresolved" : "primary_only",
        evidence,
        false
      );
      return {
        finalAnswer: primary.output.result.answer,
        primary,
        diagnostics: {
          ...baseDiagnostics,
          verificationAttempted: verification.attempted,
          modelCallCount: 1 + (verification.attempted ? 1 : 0),
          outcome: domainConflict ? "unresolved" : "primary_only",
          conflictDetected: domainConflict,
          fallbackReason: domainConflict ? "domain_evidence_conflict" : verification.reason ?? "verification_unavailable",
          confidenceLevel: confidence.level,
          confidenceBasis: confidence.basis
        },
        confidence
      };
    }

    const verificationText = verification.result.output.result.answer;
    const parsedVerification = parseVerificationResult(verificationText);
    const verificationDiagnostics = {
      ...baseDiagnostics,
      verificationAttempted: verification.attempted,
      modelCallCount: 2
    };
    if (!parsedVerification.ok) {
      const confidence = deriveAnswerConfidence("unresolved", evidence, verification.attempted);
      return {
        finalAnswer: primary.output.result.answer,
        primary,
        diagnostics: {
          ...verificationDiagnostics,
          outcome: "unresolved",
          fallbackReason: "verification_parse_failed",
          confidenceLevel: confidence.level,
          confidenceBasis: confidence.basis
        },
        confidence
      };
    }

    const effectiveVerification = this.applyDeterministicEvidence(parsedVerification.value, evidence);
    const fused = fusePrimaryAndVerification(primary.output.result.answer, effectiveVerification);
    const preliminaryConfidence = deriveAnswerConfidence(
      fused.outcome,
      evidence,
      verification.attempted,
      effectiveVerification.decision
    );
    const withVerification = {
      ...verificationDiagnostics,
      outcome: fused.outcome,
      verificationDecision: effectiveVerification.decision,
      conflictDetected: fused.conflictDetected,
      fallbackReason: fused.fallbackReason,
      confidenceLevel: preliminaryConfidence.level,
      confidenceBasis: preliminaryConfidence.basis
    } satisfies MultiModelFusionDiagnostics;
    if (fused.outcome !== "conflict_detected") {
      return {
        finalAnswer: fused.finalAnswer,
        primary,
        diagnostics: withVerification,
        confidence: preliminaryConfidence
      };
    }

    const adjudication = await this.attemptAdjudication(
      req,
      options,
      primary,
      effectiveVerification,
      evidence
    );
    if (!adjudication.result) {
      const confidence = deriveAnswerConfidence("unresolved", evidence, verification.attempted, effectiveVerification.decision);
      return {
        finalAnswer: primary.output.result.answer,
        primary,
        diagnostics: {
          ...withVerification,
          outcome: "unresolved",
          fallbackReason: adjudication.reason ?? "adjudication_unavailable",
          confidenceLevel: confidence.level,
          confidenceBasis: confidence.basis
        },
        confidence
      };
    }

    const parsedAdjudication = parseAdjudicationResult(adjudication.result.output.result.answer);
    if (!parsedAdjudication.ok) {
      const confidence = deriveAnswerConfidence("unresolved", evidence, verification.attempted, effectiveVerification.decision);
      return {
        finalAnswer: primary.output.result.answer,
        primary,
        diagnostics: {
          ...withVerification,
          adjudicationAttempted: true,
          adjudicationModel: adjudication.result.logicalModelId,
          modelCallCount: 3,
          outcome: "unresolved",
          fallbackReason: "adjudication_parse_failed",
          confidenceLevel: confidence.level,
          confidenceBasis: confidence.basis
        },
        confidence
      };
    }

    return this.finishAdjudication(primary, withVerification, adjudication.result, parsedAdjudication.value, evidence);
  }

  private finishAdjudication(
    primary: ModelResult,
    diagnostics: MultiModelFusionDiagnostics,
    adjudication: ModelResult,
    result: AdjudicationResult,
    evidence: VerificationEvidence
  ): MultiModelFusionResult {
    const nextDiagnostics: MultiModelFusionDiagnostics = {
      ...diagnostics,
      adjudicationAttempted: true,
      adjudicationModel: adjudication.logicalModelId,
      modelCallCount: 3
    };
    if (result.decision === "primary_correct") {
      const confidence = deriveAnswerConfidence("adjudicated", evidence, true);
      return {
        finalAnswer: primary.output.result.answer,
        primary,
        diagnostics: { ...nextDiagnostics, outcome: "adjudicated", confidenceLevel: confidence.level, confidenceBasis: confidence.basis },
        confidence
      };
    }
    if (result.decision === "insufficient_information") {
      const confidence = deriveAnswerConfidence("unresolved", evidence, true);
      return {
        finalAnswer: result.finalAnswer,
        primary,
        diagnostics: {
          ...nextDiagnostics,
          outcome: "unresolved",
          fallbackReason: "adjudication_insufficient_information",
          confidenceLevel: confidence.level,
          confidenceBasis: confidence.basis
        },
        confidence
      };
    }
    const confidence = deriveAnswerConfidence("adjudicated", evidence, true);
    return {
      finalAnswer: result.finalAnswer,
      primary,
      diagnostics: { ...nextDiagnostics, outcome: "adjudicated", confidenceLevel: confidence.level, confidenceBasis: confidence.basis },
      confidence
    };
  }

  private classify(question: string): TaskClassification {
    try {
      return classifyTaskCategory(question);
    } catch {
      return { category: "unknown", confidence: 0, source: "fallback", reasons: ["classification_unavailable"] };
    }
  }

  private async runDomainVerification(
    req: ModelRequest,
    primary: ModelResult,
    classification: TaskClassification
  ): Promise<VerificationEvidence> {
    const strategy = this.domainStrategies.find((candidate) => candidate.supports(classification.category));
    if (!strategy) return unavailableEvidence("none");
    const context: VerificationStrategyContext = {
      requestId: `${req.requestId}:domain`,
      question: req.prompt,
      primaryAnswer: primary.output.result.answer,
      logicalModelId: primary.logicalModelId ?? "unknown",
      classification
    };
    try {
      const evidence = await strategy.verify(context);
      return this.normalizeEvidence(evidence);
    } catch {
      return unavailableEvidence(this.strategyName(strategy), "domain_verification_unavailable");
    }
  }

  private normalizeEvidence(evidence: VerificationEvidence): VerificationEvidence {
    const statuses = new Set(["passed", "failed", "partial", "not_applicable", "unavailable"]);
    const status = statuses.has(evidence.status) ? evidence.status : "unavailable";
    return {
      strategy: evidence.strategy,
      status,
      confidence: Number.isFinite(evidence.confidence) ? Math.min(1, Math.max(0, evidence.confidence)) : 0,
      issues: Array.isArray(evidence.issues)
        ? evidence.issues.slice(0, 16).map((issue) => ({
          category: /^[a-z_]{1,40}$/.test(issue.category) ? issue.category : "other",
          severity: issue.severity === "high" || issue.severity === "medium" ? issue.severity : "low",
          message: issue.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240)
        }))
        : [],
      safeSummary: typeof evidence.safeSummary === "string" ? evidence.safeSummary.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120) : undefined,
      runtimeVerification: evidence.runtimeVerification
    };
  }

  private strategyName(strategy: DomainVerificationStrategy): VerificationEvidence["strategy"] {
    if (strategy instanceof ProgrammingStaticVerifier) return "programming_static";
    if (strategy instanceof MathematicsVerifier) return "mathematical_numeric";
    if (strategy instanceof KnowledgeConsistencyVerifier) return "knowledge_consistency";
    if (strategy instanceof GenericModelVerificationStrategy) return "generic_model";
    return "none";
  }

  private hasHighSeverityEvidenceFailure(evidence: VerificationEvidence): boolean {
    return evidence.status === "failed" && evidence.issues.some((issue) => issue.severity === "high");
  }

  private applyDeterministicEvidence(
    verification: VerificationResult,
    evidence: VerificationEvidence
  ): VerificationResult {
    if (!this.hasHighSeverityEvidenceFailure(evidence)) return verification;
    return {
      ...verification,
      decision: "conflict",
      issues: [
        ...verification.issues,
        ...evidence.issues.map((issue) => ({
          category: this.safeVerificationCategory(issue.category),
          severity: issue.severity,
          description: issue.message
        }))
      ]
    };
  }

  private safeVerificationCategory(category: string): VerificationResult["issues"][number]["category"] {
    const allowed: VerificationResult["issues"][number]["category"][] = [
      "factual", "calculation", "logic", "code", "safety", "missing_information", "other"
    ];
    return allowed.includes(category as VerificationResult["issues"][number]["category"])
      ? category as VerificationResult["issues"][number]["category"]
      : category.includes("numeric") || category.includes("division") ? "calculation"
        : category.includes("code") || category.includes("pointer") || category.includes("variable") ? "code"
          : "other";
  }

  private async attemptVerification(
    req: ModelRequest,
    primary: ModelResult,
    targetLogicalModel: string | undefined,
    prompt: string
  ): Promise<PassAttempt> {
    if (req.secondModelEligible === false) {
      return { result: null, attempted: false, reason: "second_model_ineligible" };
    }
    const ratio = primary.utilizationRatio;
    if (ratio >= THROTTLE_STOP_VERIFICATION || ratio >= THROTTLE_STOP_SECOND_MODEL) {
      return { result: null, attempted: false, reason: "verification_throttled" };
    }
    const target = targetLogicalModel ?? this.defaultVerificationLogicalModel(primary.logicalModelId);
    if (!target) return { result: null, attempted: false, reason: "second_model_ineligible" };
    const limit = this.pool.findModelDailyLimit(target);
    if (limit && !limit.allowSecondModelVerification) {
      return { result: null, attempted: false, reason: "second_model_ineligible" };
    }
    if (!this.isQuotaAvailable(target)) {
      return { result: null, attempted: false, reason: "verification_quota_exhausted" };
    }
    if (ratio >= THROTTLE_RESTRICT_TERRA && target === "gpt-5.6-terra") {
      return { result: null, attempted: false, reason: "verification_throttled" };
    }
    try {
      const verificationReq: ModelRequest = {
        ...req,
        prompt,
        preferredLogicalModel: target,
        requestId: `${req.requestId}:verify`
      };
      return { result: await this.runPrimary(verificationReq), attempted: true };
    } catch (error) {
      return {
        result: null,
        attempted: true,
        reason: this.contextReason(error, "verification_context_window")
      };
    }
  }

  private async attemptAdjudication(
    req: ModelRequest,
    options: FusionOptions,
    primary: ModelResult,
    verification: VerificationResult,
    evidence: VerificationEvidence
  ): Promise<PassAttempt> {
    if (options.allowAdjudication === false || req.allowAdjudication === false) {
      return { result: null, attempted: false, reason: "adjudication_disabled" };
    }
    const target = options.adjudicationLogicalModel ?? req.adjudicationLogicalModel;
    if (!target) return { result: null, attempted: false, reason: "adjudication_unconfigured" };
    const mapping = this.pool.findEnabledLogicalModel(target);
    if (!mapping) return { result: null, attempted: false, reason: "adjudication_unconfigured" };
    const limit = this.pool.findModelDailyLimit(target);
    if (limit?.allowAdjudication === false) {
      return { result: null, attempted: false, reason: "adjudication_disabled" };
    }
    if (!this.isQuotaAvailable(target)) {
      return { result: null, attempted: false, reason: "adjudication_quota_exhausted" };
    }
    if (this.poolUtilization(target) >= THROTTLE_STOP_ADJUDICATION) {
      return { result: null, attempted: false, reason: "adjudication_throttled" };
    }
    try {
      const prompt = buildAdjudicationPrompt(
        req.prompt,
        primary.output.result.answer,
        evidence.safeSummary
          ? [
            ...verification.issues,
            {
              category: "other",
              severity: evidence.status === "failed" ? "high" : "medium",
              description: evidence.safeSummary
            }
          ]
          : verification.issues
      );
      const adjudicationReq: ModelRequest = {
        ...req,
        prompt,
        preferredLogicalModel: target,
        requestId: `${req.requestId}:adjudicate`
      };
      return { result: await this.runPrimary(adjudicationReq), attempted: true };
    } catch (error) {
      return {
        result: null,
        attempted: true,
        reason: this.contextReason(error, "adjudication_context_window")
      };
    }
  }

  private contextReason(
    error: unknown,
    contextReason: "verification_context_window" | "adjudication_context_window"
  ): OrchestrationFallbackReason {
    if (error instanceof AiGatewayErrorClass && error.diagnostics?.errorCategory === "context_window") {
      return contextReason;
    }
    if (error instanceof AiGatewayErrorClass && error.code === "AI_BUDGET_EXCEEDED") {
      return contextReason.startsWith("verification")
        ? "verification_quota_exhausted"
        : "adjudication_quota_exhausted";
    }
    return contextReason.startsWith("verification")
      ? "verification_unavailable"
      : "adjudication_unavailable";
  }

  private isQuotaAvailable(logicalModelId: string): boolean {
    const limit = this.pool.findModelDailyLimit(logicalModelId);
    if (limit && limit.dailyLimit > 0 && limit.usedTokens + limit.reservedTokens >= limit.dailyLimit) {
      return false;
    }
    if (!limit) return true;
    const pool = this.pool.findTokenPool(limit.poolId);
    return !pool || pool.dailyLimit <= 0 || pool.usedTokens + pool.reservedTokens < pool.dailyLimit;
  }

  private toGatewayInput(
    req: ModelRequest,
    overrides?: {
      preferredProvider?: GatewayRunInput["preferredProvider"];
      preferredModel?: string;
      maxOutputTokens?: number;
    }
  ): GatewayRunInput {
    return {
      requestId: req.requestId,
      prompt: req.prompt,
      systemPrompt: req.systemPrompt,
      requestSource: req.requestSource,
      scopeKey: req.scopeKey,
      clientSignal: req.clientSignal,
      preferredProvider: overrides?.preferredProvider ?? req.preferredProvider,
      preferredModel: overrides?.preferredModel,
      maxOutputTokens: overrides?.maxOutputTokens
    };
  }

  private thinkingBudget(maxOutputTokens: number): number {
    return Math.max(1, Math.floor(maxOutputTokens * 0.25));
  }

  private poolUtilization(logicalModelId?: string): number {
    if (!logicalModelId) return 0;
    const limit = this.pool.findModelDailyLimit(logicalModelId);
    if (!limit) return 0;
    const pool = this.pool.findTokenPool(limit.poolId);
    if (!pool || pool.dailyLimit <= 0) return 0;
    return (pool.usedTokens + pool.reservedTokens) / pool.dailyLimit;
  }

  private defaultVerificationLogicalModel(primaryLogicalModel?: string): string | undefined {
    const sol = this.pool.findEnabledLogicalModel("gpt-5.6-sol");
    if (sol && primaryLogicalModel !== "gpt-5.6-sol") return "gpt-5.6-sol";
    return undefined;
  }

  private contextWindowError(
    preflight: { reason?: string; totalRequired: number; contextWindowTokens: number },
    logicalModelId?: string
  ): AiGatewayError {
    return new AiGatewayErrorClass(
      "AI_INVALID_INPUT",
      "輸入內容超過模型 Context Window，請精簡或分段後再試。",
      {
        internalMessage: `context preflight ${preflight.reason}: required=${preflight.totalRequired} window=${preflight.contextWindowTokens} model=${logicalModelId ?? "unknown"}`,
        retryable: false,
        diagnostics: {
          errorCategory: "context_window",
          contextWindowExceeded: true,
          contextWindowTotalRequired: preflight.totalRequired
        }
      }
    );
  }
}
