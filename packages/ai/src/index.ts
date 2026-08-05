export * from "./provider";
export * from "./ai-client";
export * from "./rag";
export { MockAiProvider } from "./providers/mock.provider";
export { GeminiAiProvider } from "./providers/gemini.provider";
export { OpenAiCompatibleProvider } from "./providers/openai-compatible.provider";

export { buildSplitBookPrompt, SPLIT_BOOK_TASK } from "./prompts/split-book.prompt";
export { buildChaptersPrompt, BUILD_CHAPTERS_TASK } from "./prompts/build-chapters.prompt";
export { buildSummarizeChapterPrompt, SUMMARIZE_CHAPTER_TASK } from "./prompts/summarize-chapter.prompt";
export { buildBookQaPrompt, BOOK_QA_TASK } from "./prompts/book-qa.prompt";
export {
  GUEST_ASK_SYSTEM_PROMPT,
  PROGRAMMING_TUTOR_SYSTEM_PROMPT,
  GRAPH_THEORY_TUTOR_SYSTEM_PROMPT,
  GRAPH_THEORY_KEYWORDS,
  isGraphTheoryQuestion,
  selectGuestSystemPrompt
} from "./prompts/guest-ask.prompt";
export {
  parseGraphAnswer,
  edgesMatch,
  verifyQ6Kruskal,
  verifyQ7Articulation,
  Q6_KRUSKAL_EXPECTED_EDGES,
  Q7_EXPECTED_ANSWER,
  Q7_EXPECTED_ARTICULATION_POINTS
} from "./prompts/graph-answer";
export type { GraphEdge, GraphAnswer } from "./prompts/graph-answer";

// ---------------------------------------------------------------------------
// Phase 2 AI Gateway (router + providers + budget/logging ports)
// ---------------------------------------------------------------------------

export * from "./gateway/ai-types";
export * from "./gateway/pricing";
export type { RouterConfig, RouterRule, ClassificationContext } from "./gateway/ai-router";
export {
  routePrompt,
  classify,
  classifySubject,
  classifyTask,
  classifyComplexity,
  DEFAULT_ROUTER_CONFIG
} from "./gateway/ai-router";
export type { GatewayAiProvider } from "./gateway/provider.interface";
export type {
  AnswerValidatorOptions,
  ValidatedAnswer
} from "./gateway/answer-validator";
export {
  validateAnswer,
  validateResult,
  DEFAULT_MAX_ANSWER_CHARS
} from "./gateway/answer-validator";
export type { AnswerCompleteness, AnswerCompletenessReason } from "./gateway/answer-completeness";
export { assessAnswerCompleteness } from "./gateway/answer-completeness";
export { buildContinuationPrompt, mergeContinuation } from "./gateway/continuation";
// NOTE: guest-ask is a non-streaming atomic JSON API (spec §7). A general SSE
// parser is not wired into any endpoint; do not reintroduce one without fully
// handling UTF-8 cross-chunk, event boundaries, client abort, heartbeats, and
// partial-answer safety.
export {
  toSafeAiDiagnostics,
  errorCategoryFromFailureKind
} from "./gateway/diagnostics-allowlist";
export type { AiErrorCategory, SafeAiDiagnostics } from "./gateway/diagnostics-allowlist";
export type {
  AiGatewayConfig,
  GatewayRunInput,
  GatewayRunOutput,
  BudgetManager,
  BudgetCheckInput,
  BudgetCheckResult,
  BudgetReservation,
  BudgetRecordInput,
  PromptLogger,
  GatewayLogEntry,
  GatewayLogContext
} from "./gateway/ai-gateway";
export {
  AiGateway,
  AllowAllBudgetManager,
  NoopPromptLogger
} from "./gateway/ai-gateway";
export type { GatewayEnvConfig } from "./gateway/gateway-config";
export { loadGatewayConfig, buildProviderRegistry } from "./gateway/gateway-config";
export {
  resolveGuestAskRetentionDays,
  GUEST_ASK_RETENTION_MIN_DAYS,
  GUEST_ASK_RETENTION_MAX_DAYS,
  GUEST_ASK_RETENTION_DEFAULT_DAYS
} from "./gateway/gateway-config";
export { redactSensitiveText } from "./gateway/secret-redaction";
export { isFallbackEligible, isRetryable } from "./gateway/ai-types";
export {
  armstrongNumbersInRange,
  armstrongOutputForRange,
  buildStudentAnswer,
  publicStudentAnswer,
  validateStudentAnswer
} from "./gateway/student-answer";
export type {
  StudentAnswerContent,
  StudentAnswerExample,
  StudentAnswerValidation
} from "./gateway/student-answer";

export { MockGatewayProvider } from "./gateway/providers/mock-gateway.provider";
export {
  GeminiGatewayProvider,
  DEFAULT_GEMINI_ENDPOINT_PROFILE,
  isGeminiEndpointProfile
} from "./gateway/providers/gemini.provider";
export type { GeminiEndpointProfile } from "./gateway/providers/gemini.provider";
export { OpenAiGatewayProvider } from "./gateway/providers/openai.provider";
export { KimiGatewayProvider } from "./gateway/providers/kimi.provider";
export { QwenGatewayProvider } from "./gateway/providers/qwen.provider";
export { ZaiGatewayProvider } from "./gateway/providers/zai.provider";
export {
  applyPromotionMultiplier,
  capabilityEnabled,
  classifyCredentialVerification,
  credentialMayServeScope,
  formalContextWindow,
  healthForCredentialVerification,
  isFormalCapabilityEvidence,
  isPromotionActive,
  isRollingQuotaAvailable,
  normalizeQuotaObservation,
  observedTokenUsage,
  QWEN_ENDPOINT_PROFILES,
  validateCredentialActivation,
  validateQwenEndpoint
} from "./provider-compliance";
export type {
  CapabilityEvidence,
  CredentialActivationResult,
  CredentialUsageScope,
  CredentialVerificationReason,
  ProviderBillingMode,
  ProviderHealth,
  ProviderPromotion,
  ProviderQuotaObservation,
  QwenCredentialMetadata,
  QwenEndpointProfile,
  RollingQuotaWindow,
  StoredCredentialUsageScope
} from "./provider-compliance";

// ---------------------------------------------------------------------------
// Multi-model orchestration (token pool + context preflight + verification)
// ---------------------------------------------------------------------------
export * from "./orchestration";
export * from "./evaluation";
export { normalizeZaiBaseUrl } from "./gateway/providers/zai.provider";
