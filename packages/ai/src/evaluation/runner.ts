import type { EvaluationCase, EvaluationCaseResult, EvaluationDataset, EvaluationExecutionMode, EvaluationSubjectResult } from "./evaluation-types";
import { scoreEvaluationCase } from "./scorer";
import type { EvaluationReport } from "./reports";
import { aggregateEvaluationMetrics } from "./metrics";
import { compareEvaluationBaseline, type EvaluationBaseline, type EvaluationRegressionThresholds } from "./baseline";
import type { ModelRequest, MultiModelFusionResult } from "../orchestration";

export type EvaluationStage = "primary" | "verify" | "adjudicate";

export interface EvaluationOrchestratorRequest {
  requestId: string;
  testCase: EvaluationCase;
}

export interface EvaluationOrchestratorPort {
  run(request: EvaluationOrchestratorRequest): Promise<EvaluationSubjectResult>;
}

export interface FusionOrchestratorPort {
  runWithFusion(request: ModelRequest): Promise<MultiModelFusionResult>;
}

/** Adapter for a caller that has already constructed the existing Orchestrator with mock ports. */
export class MultiModelOrchestratorEvaluationAdapter implements EvaluationOrchestratorPort {
  constructor(
    private readonly orchestrator: FusionOrchestratorPort,
    private readonly requestBuilder: (request: EvaluationOrchestratorRequest) => ModelRequest = (request) => ({
      requestId: request.requestId,
      prompt: request.testCase.question,
      secondModelEligible: true,
      allowAdjudication: true
    })
  ) {}

  async run(request: EvaluationOrchestratorRequest): Promise<EvaluationSubjectResult> {
    const startedAt = Date.now();
    const output = await this.orchestrator.runWithFusion(this.requestBuilder(request));
    const primaryAnswer = output.primary.output.result.answer;
    return {
      answer: output.finalAnswer,
      primaryAnswer,
      outcome: output.diagnostics.outcome,
      confidenceLevel: output.confidence.level,
      modelCallCount: output.diagnostics.modelCallCount,
      inputTokens: output.primary.output.result.inputTokens,
      outputTokens: output.primary.output.result.outputTokens,
      totalTokens: output.primary.output.result.totalTokens,
      durationMs: Math.max(0, Date.now() - startedAt),
      safeDiagnostics: {
        outcome: output.diagnostics.outcome,
        verificationAttempted: output.diagnostics.verificationAttempted,
        adjudicationAttempted: output.diagnostics.adjudicationAttempted,
        conflictDetected: output.diagnostics.conflictDetected,
        confidenceLevel: output.confidence.level
      }
    };
  }
}

export type EvaluationFixtureMap = Record<string, EvaluationSubjectResult>;

function safeDiagnostics(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 16)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,48}$/.test(key) || /prompt|answer|credential|secret|token|authorization|error/i.test(key)) continue;
    if (typeof value === "string") output[key] = value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
    else if (typeof value === "number" || typeof value === "boolean") output[key] = value;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function selectCases(dataset: EvaluationDataset, options: EvaluationRunOptions): EvaluationCase[] {
  return dataset.cases.filter((testCase) => testCase.enabled && (!options.category || testCase.category === options.category) && (!options.difficulty || testCase.difficulty === options.difficulty)).slice(0, options.maxCases ?? Number.POSITIVE_INFINITY);
}

export class MockEvaluationOrchestrator implements EvaluationOrchestratorPort {
  readonly calls: EvaluationOrchestratorRequest[] = [];
  constructor(private readonly fixtures: EvaluationFixtureMap) {}
  async run(request: EvaluationOrchestratorRequest): Promise<EvaluationSubjectResult> {
    this.calls.push(request);
    const fixture = this.fixtures[request.testCase.id];
    if (!fixture) return { answer: "", primaryAnswer: "", modelCallCount: 0, durationMs: 0, safeDiagnostics: { fallbackReason: "fixture_missing" } };
    return {
      ...fixture,
      durationMs: fixture.durationMs,
      safeDiagnostics: safeDiagnostics(fixture.safeDiagnostics)
    };
  }
}

export interface EvaluationRunOptions {
  mode?: EvaluationExecutionMode;
  maxCases?: number;
  category?: EvaluationCase["category"];
  difficulty?: EvaluationCase["difficulty"];
  fixtures?: EvaluationFixtureMap;
  orchestrator?: EvaluationOrchestratorPort;
  baseline?: EvaluationBaseline;
  thresholds?: EvaluationRegressionThresholds;
}

export interface EvaluationRunOutput {
  report: EvaluationReport;
  results: EvaluationCaseResult[];
}

export interface LiveEvaluationRunHooks {
  beforeCase?: (testCase: EvaluationCase, index: number) => Promise<{ allowed: true } | { allowed: false; reason: string }>;
  afterCase?: (testCase: EvaluationCase, result: EvaluationCaseResult) => Promise<void>;
  shouldStop?: () => boolean;
}

/**
 * Build the primary requestId for a live evaluation case. When an
 * evaluationRunId is supplied (the live path always provides the persisted run
 * id), the id is namespaced per run so that re-running the same dataset/case in
 * a different run produces a distinct requestId. This prevents a prior run's
 * settled reservation (same dataset+case) from colliding via the reservation
 * store's "already_settled" short-circuit and being misclassified as a budget
 * failure.
 *
 * Within a single run the id is stable, so retries/idempotency still reuse the
 * same reservation. Verification and adjudication derive from this id as
 * `{primaryRequestId}:verify` / `{primaryRequestId}:adjudicate`, so they inherit
 * the same run isolation.
 */
export function buildLiveRequestId(
  dataset: { id: string; version: number },
  caseId: string,
  evaluationRunId?: string
): string {
  return evaluationRunId
    ? `eval:${evaluationRunId}:${dataset.id}:v${dataset.version}:${caseId}:primary`
    : `eval:${dataset.id}:${caseId}:primary`;
}

function missingSubject(): EvaluationSubjectResult {
  return { answer: "", modelCallCount: 0, durationMs: 0, safeDiagnostics: { fallbackReason: "fixture_missing" } };
}

export async function runEvaluation(dataset: EvaluationDataset, options: EvaluationRunOptions = {}): Promise<EvaluationRunOutput> {
  const mode = options.mode ?? "fixture";
  const cases = selectCases(dataset, options);
  const fixtures = options.fixtures ?? {};
  const mock = mode === "mock_orchestrator" ? (options.orchestrator ?? new MockEvaluationOrchestrator(fixtures)) : undefined;
  if (mode === "live") throw new Error("live evaluation requires an explicit policy and a dedicated live adapter");
  const results: EvaluationCaseResult[] = [];
  for (const testCase of cases) {
    const requestId = `eval:${dataset.id}:${testCase.id}:primary`;
    const subject = mode === "fixture" ? fixtures[testCase.id] ?? missingSubject() : await (mock as EvaluationOrchestratorPort).run({ requestId, testCase });
    const score = scoreEvaluationCase(testCase, subject);
    results.push({
      caseId: testCase.id,
      datasetVersion: dataset.version,
      category: testCase.category,
      difficulty: testCase.difficulty,
      passed: score.passed,
      score: Math.min(1, Math.max(0, score.score)),
      scoringMethod: score.method,
      outcome: subject.outcome,
      confidenceLevel: subject.confidenceLevel,
      modelCallCount: Math.max(0, subject.modelCallCount),
      inputTokens: subject.inputTokens,
      outputTokens: subject.outputTokens,
      totalTokens: subject.totalTokens,
      durationMs: Math.max(0, subject.durationMs),
      issues: score.issues.slice(0, 16),
      safeDiagnostics: safeDiagnostics(subject.safeDiagnostics)
    });
  }
  const summary = aggregateEvaluationMetrics({ datasetId: dataset.id, datasetVersion: dataset.version, executionMode: mode, results });
  const report: EvaluationReport = { dataset: { id: dataset.id, version: dataset.version }, executionMode: mode, summary, results, warnings: ["Evaluation results are offline measurements and do not represent real-world probability.", ...(results.some((result) => result.scoringMethod === "heuristic_concepts" || result.scoringMethod === "programming_analysis") ? ["Heuristic concept/programming scores are approximate."] : [])] };
  if (options.baseline) report.regression = compareEvaluationBaseline(summary, options.baseline, options.thresholds);
  return { report, results };
}

/**
 * Explicit Live runner. The caller must supply a real orchestrator and budget
 * hooks; this function never constructs a provider, reads credentials, or
 * falls back to the offline fixture runner.
 */
export async function runLiveEvaluation(
  dataset: EvaluationDataset,
  options: EvaluationRunOptions & { orchestrator: EvaluationOrchestratorPort; maxCases: number; evaluationRunId?: string; hooks?: LiveEvaluationRunHooks }
): Promise<EvaluationRunOutput> {
  const cases = selectCases(dataset, { ...options, maxCases: options.maxCases });
  const results: EvaluationCaseResult[] = [];
  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    if (options.hooks?.shouldStop?.()) break;
    const permission = await options.hooks?.beforeCase?.(testCase, index) ?? { allowed: true as const };
    if (!permission.allowed) break;
    const requestId = buildLiveRequestId(dataset, testCase.id, options.evaluationRunId);
    let subject: EvaluationSubjectResult;
    try {
      subject = await options.orchestrator.run({ requestId, testCase });
    } catch {
      subject = { answer: "", primaryAnswer: "", modelCallCount: 0, durationMs: 0, safeDiagnostics: { fallbackReason: "live_provider_unavailable" } };
    }
    const score = scoreEvaluationCase(testCase, subject);
    const result: EvaluationCaseResult = {
      caseId: testCase.id,
      datasetVersion: dataset.version,
      category: testCase.category,
      difficulty: testCase.difficulty,
      passed: score.passed,
      score: Math.min(1, Math.max(0, score.score)),
      scoringMethod: score.method,
      outcome: subject.outcome,
      confidenceLevel: subject.confidenceLevel,
      modelCallCount: Math.max(0, subject.modelCallCount),
      inputTokens: subject.inputTokens,
      outputTokens: subject.outputTokens,
      totalTokens: subject.totalTokens,
      durationMs: Math.max(0, subject.durationMs),
      issues: score.issues.slice(0, 16),
      safeDiagnostics: safeDiagnostics(subject.safeDiagnostics)
    };
    results.push(result);
    await options.hooks?.afterCase?.(testCase, result);
  }
  const summary = aggregateEvaluationMetrics({ datasetId: dataset.id, datasetVersion: dataset.version, executionMode: "live", results });
  return {
    report: {
      dataset: { id: dataset.id, version: dataset.version },
      executionMode: "live",
      summary,
      results,
      warnings: ["Live 結果僅代表指定離線資料集，不代表所有學生問題的真實世界準確率。"]
    },
    results
  };
}
