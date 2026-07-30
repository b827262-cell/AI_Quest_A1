/**
 * Multi-model orchestration layer.
 *
 * Sits above the gateway (which remains unmodified) and coordinates:
 *   - Token Pool daily quota (TokenPoolBudgetManager decorator)
 *   - Context Window preflight (single-request capacity, independent of daily quota)
 *   - Multi-model verification passes (MultiModelOrchestrator)
 *
 * All four limit dimensions remain independent:
 *   (1) Daily Token Pool
 *   (2) Provider RPM/TPM/RPD  (unchanged, in aiCredentialModelQuotas)
 *   (3) Model Daily Limit
 *   (4) Context Window (single-request)
 */
export type { CompositeBudgetReservation } from "./composite-reservation";
export { compositeFromInner, withPoolReservation, hasPoolReservation } from "./composite-reservation";
export type {
  ContextPreflightInput,
  ContextPreflightResult,
  ContextPreflightStrategy
} from "./context-preflight";
export { checkContextWindow, estimateTokenCount, reducedOutputBudget } from "./context-preflight";
export { TokenPoolBudgetManager } from "./token-pool-budget-manager";
export {
  buildAdjudicationPrompt,
  parseAdjudicationResult
} from "./adjudication";
export type {
  AdjudicationDecision,
  AdjudicationParseFailure,
  AdjudicationParseResult,
  AdjudicationReasonCategory,
  AdjudicationResult
} from "./adjudication";
export { fusePrimaryAndVerification } from "./answer-fusion";
export type { AnswerFusionResult } from "./answer-fusion";
export type {
  FusionOutcome,
  MultiModelFusionDiagnostics,
  DomainVerificationDiagnostics,
  OrchestrationFallbackReason,
  SafeVerificationDecision
} from "./orchestration-diagnostics";
export {
  buildVerificationPrompt,
  parseVerificationResult
} from "./verification-result";
export type {
  VerificationDecision,
  VerificationIssue,
  VerificationIssueCategory,
  VerificationIssueSeverity,
  VerificationParseFailure,
  VerificationParseResult,
  VerificationResult
} from "./verification-result";
export type {
  TokenPoolPort,
  LogicalModelMapping,
  ModelDailyLimitRow,
  TokenPoolRow,
  ReservePoolInput,
  ReservePoolResult
} from "./token-pool-ports";
export type {
  FusionOptions,
  ModelRequest,
  ModelResult,
  MultiModelFusionResult
} from "./multi-model-orchestrator";
export { MultiModelOrchestrator } from "./multi-model-orchestrator";
export {
  classifyTaskCategory,
  classifyTask,
  classifyProblem,
  requiresGraphAnalysis,
  isTaskCategory
} from "./classification/task-classifier";
export type {
  ProblemClassification,
  ProblemTopic,
  ProblemType,
  TaskCategory,
  TaskClassification,
  OrchestrationStage
} from "./classification/classification-types";
export { ProgrammingStaticVerifier } from "./verification/programming-verifier";
export { MathematicsVerifier, evaluateSafeExpression, verifyNumericAnswer } from "./verification/mathematics-verifier";
export {
  KnowledgeConsistencyVerifier,
  assessKnowledgeClaims,
  buildKnowledgeClaimAssessmentPrompt,
  extractKnowledgeClaims
} from "./verification/knowledge-verifier";
export { GenericModelVerificationStrategy, unavailableEvidence } from "./verification/verification-strategy";
export { deriveAnswerConfidence } from "./verification/confidence";
export type { AnswerConfidence } from "./verification/confidence";
export { parseKnowledgeClaimAssessments, safeEvidenceIssue } from "./verification/verification-evidence";
export type {
  CodeExecutionPort,
  DomainVerificationStrategy,
  KnowledgeClaim,
  KnowledgeClaimAssessment,
  NumericVerificationResult,
  SafeCodeExecutionRequest,
  SafeCodeExecutionResult,
  VerificationEvidence,
  VerificationEvidenceIssue,
  VerificationEvidenceStatus,
  VerificationStrategyContext,
  VerificationStrategyName
} from "./verification/verification-evidence";
