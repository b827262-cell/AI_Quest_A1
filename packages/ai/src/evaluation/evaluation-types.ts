import type { AnswerConfidence } from "../orchestration/verification/confidence";
import type { FusionOutcome } from "../orchestration/orchestration-diagnostics";
import type { TaskCategory } from "../orchestration/classification/classification-types";

export type EvaluationCategory = TaskCategory;
export type EvaluationDifficulty = "easy" | "medium" | "hard";

export interface ExactAnswerExpectation {
  kind: "exact";
  acceptedAnswers: string[];
  caseSensitive?: boolean;
  normalizeWhitespace?: boolean;
}

export interface NumericAnswerExpectation {
  kind: "numeric";
  expectedValue: number;
  tolerance: number;
  unit?: string;
}

export interface RequiredConceptExpectation {
  kind: "required_concepts";
  required: string[];
  forbidden?: string[];
  minimumRequired?: number;
}

export interface ProgrammingAnalysisExpectation {
  kind: "programming_analysis";
  requiredFindings: string[];
  forbiddenClaims?: string[];
  requiresUndefinedBehaviorNotice?: boolean;
  requiresCompileErrorNotice?: boolean;
  requiresRuntimeWarning?: boolean;
}

export interface ClassificationExpectation {
  kind: "classification";
  expectedCategory: EvaluationCategory;
}

export interface SafetyExpectation {
  kind: "safety";
  mustPreservePrimary?: boolean;
  mustNotContain?: string[];
  expectedOutcome?: FusionOutcome;
}

export type EvaluationExpectation =
  | ExactAnswerExpectation
  | NumericAnswerExpectation
  | RequiredConceptExpectation
  | ProgrammingAnalysisExpectation
  | ClassificationExpectation
  | SafetyExpectation;

export interface EvaluationCase {
  id: string;
  version: number;
  category: EvaluationCategory;
  difficulty: EvaluationDifficulty;
  question: string;
  expected: EvaluationExpectation;
  tags?: string[];
  source: "synthetic" | "curated" | "regression";
  enabled: boolean;
}

export interface EvaluationDataset {
  id: string;
  version: number;
  cases: EvaluationCase[];
}

export interface EvaluationSubjectResult {
  answer?: string;
  primaryAnswer?: string;
  classification?: EvaluationCategory;
  outcome?: FusionOutcome;
  confidenceLevel?: AnswerConfidence["level"];
  modelCallCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs: number;
  safeDiagnostics?: Record<string, unknown>;
}

export interface EvaluationIssue {
  code: string;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface EvaluationCaseResult {
  caseId: string;
  datasetVersion: number;
  category: EvaluationCategory;
  difficulty: EvaluationDifficulty;
  passed: boolean;
  score: number;
  scoringMethod: "exact" | "numeric" | "heuristic_concepts" | "programming_analysis" | "classification" | "safety";
  outcome?: string;
  confidenceLevel?: AnswerConfidence["level"];
  modelCallCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs: number;
  issues: EvaluationIssue[];
  safeDiagnostics?: Record<string, unknown>;
}

export interface EvaluationMetricGroup {
  count: number;
  passed: number;
  passRate: number;
  averageScore: number;
}

export interface ConfidenceCalibrationRow {
  confidenceLevel: AnswerConfidence["level"];
  total: number;
  passed: number;
  empiricalPassRate: number;
}

export interface EvaluationSummary {
  datasetId: string;
  datasetVersion: number;
  executionMode: EvaluationExecutionMode;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  averageScore: number;
  byCategory: Record<string, EvaluationMetricGroup>;
  byDifficulty: Record<string, EvaluationMetricGroup>;
  byOutcome: Record<string, EvaluationMetricGroup>;
  byConfidence: Record<string, EvaluationMetricGroup>;
  confidenceCalibration: ConfidenceCalibrationRow[];
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalModelCalls: number;
  averageModelCalls: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
}

export type EvaluationExecutionMode = "fixture" | "mock_orchestrator" | "live";

export interface EvaluationRegressionIssue {
  code: "pass_rate" | "category_pass_rate" | "unresolved_rate" | "model_calls";
  severity: "warning" | "error";
  message: string;
}

export interface EvaluationRegression {
  comparable: boolean;
  reason?: string;
  passRateDelta: number;
  averageScoreDelta: number;
  p95LatencyDeltaMs: number;
  averageModelCallsDelta: number;
  totalTokenDelta?: number;
  regressions: EvaluationRegressionIssue[];
}
