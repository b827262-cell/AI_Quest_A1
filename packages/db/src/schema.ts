import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  description: text("description"),
  coverUrl: text("cover_url"),
  category: text("category").notNull().default("未分類"),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const bookFiles = sqliteTable("book_files", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull(),
  fileName: text("file_name").notNull(),
  filePath: text("file_path").notNull(),
  fileType: text("file_type").notNull(),
  fileSize: integer("file_size").notNull().default(0),
  role: text("role").notNull().default("source_document"),
  relatedFileId: text("related_file_id"),
  parseStatus: text("parse_status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const bookContents = sqliteTable("book_contents", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull(),
  fileId: text("file_id"),
  chapterId: text("chapter_id"),
  pageNumber: integer("page_number"),
  contentText: text("content_text").notNull(),
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: text("created_at").notNull()
});

export const bookChapters = sqliteTable("book_chapters", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  orderIndex: integer("order_index").notNull().default(0),
  pageStart: integer("page_start"),
  pageEnd: integer("page_end"),
  level: integer("level").notNull().default(0),
  source: text("source").notNull().default("manual"),
  status: text("status").notNull().default("draft"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull(),
  userId: text("user_id"),
  title: text("title").notNull().default("New chat"),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  userAgent: text("user_agent"),
  osName: text("os_name"),
  osVersion: text("os_version"),
  browserName: text("browser_name"),
  browserVersion: text("browser_version"),
  deviceType: text("device_type"),
  deviceVendor: text("device_vendor"),
  deviceModel: text("device_model"),
  // Last login / activity IP captured server-side (never trusted from client).
  lastIpAddress: text("last_ip_address"),
  lastIpCountry: text("last_ip_country"),
  lastIpRegion: text("last_ip_region"),
  lastIpCity: text("last_ip_city"),
  // How the IP was resolved (e.g. cf-connecting-ip / x-forwarded-for / socket).
  lastIpSource: text("last_ip_source"),
  // Admin security controls: risk marking and block state.
  riskLevel: text("risk_level").notNull().default("safe"),
  isBlocked: integer("is_blocked", { mode: "boolean" }).notNull().default(false),
  blockedAt: text("blocked_at"),
  blockedReason: text("blocked_reason"),
  riskNote: text("risk_note")
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull()
});

export const pdfAccessLogs = sqliteTable("pdf_access_logs", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull(),
  fileId: text("file_id").notNull(),
  sessionId: text("session_id").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  viewedAt: text("viewed_at").notNull()
});

export const bookAiJobs = sqliteTable("book_ai_jobs", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull(),
  jobType: text("job_type").notNull(),
  status: text("status").notNull().default("pending"),
  inputJson: text("input_json"),
  outputJson: text("output_json"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const bookQaLogs = sqliteTable("book_qa_logs", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull(),
  chapterId: text("chapter_id"),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  contextJson: text("context_json"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  createdAt: text("created_at").notNull()
});

export const smartBookNotes = sqliteTable("smart_book_notes", {
  id: text("id").primaryKey(),
  bookId: text("book_id").notNull(),
  chapterId: text("chapter_id"),
  pageNumber: integer("page_number"),
  type: text("type").notNull().default("text"),
  title: text("title").notNull().default(""),
  content: text("content"),
  canvasData: text("canvas_data"),
  canvasImageUrl: text("canvas_image_url"),
  sourceMessageId: text("source_message_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

// ---------------------------------------------------------------------------
// Phase 2 AI Gateway tables.
// Cost columns are integer micro-USD (1 USD = 1_000_000) to avoid float drift.
// IP is stored only as a hash; the raw IP never reaches this layer.
// ---------------------------------------------------------------------------

export const aiRequestLogs = sqliteTable("ai_request_logs", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  visitorId: text("visitor_id"),
  visitorIpHash: text("visitor_ip_hash"),
  requestSource: text("request_source").notNull(),
  question: text("question").notNull(),
  questionLength: integer("question_length").notNull(),
  subject: text("subject").notNull(),
  taskType: text("task_type").notNull(),
  complexity: text("complexity").notNull(),
  routingProvider: text("routing_provider").notNull(),
  routingModel: text("routing_model"),
  routingReason: text("routing_reason").notNull(),
  providerAttemptsJson: text("provider_attempts_json").notNull().default("[]"),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  diagnosticsJson: text("diagnostics_json"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at").notNull(),
  latencyMs: integer("latency_ms").notNull()
});

export const aiUsageLogs = sqliteTable("ai_usage_logs", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  provider: text("provider").notNull(),
  /** Credential used for the successful attempt; never stores key material. */
  credentialId: text("credential_id"),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  // ----- Q&A detail (spec §2) — redacted + bounded, never secrets/prompts ---
  /** Redacted, bounded question text (NULL on legacy rows). */
  questionText: text("question_text"),
  /** Redacted, bounded answer text (NULL on legacy rows / failures). */
  answerText: text("answer_text"),
  // ----- Token breakdown (spec §6) — cached/thinking are subsets, not extra ---
  /** Gemini cachedContentTokenCount; subset of input_tokens. */
  cachedInputTokens: integer("cached_input_tokens"),
  /** Gemini thoughtsTokenCount; subset of output_tokens. */
  thinkingTokens: integer("thinking_tokens"),
  // ----- Cost breakdown (spec §6) — integer micro-USD, never floats --------
  /** Non-cached input cost (integer micro-USD). */
  inputCostMicrousd: integer("input_cost_microusd").notNull().default(0),
  /** Cached input cost at the discounted rate (integer micro-USD). */
  cachedInputCostMicrousd: integer("cached_input_cost_microusd").notNull().default(0),
  /** Output cost (integer micro-USD). */
  outputCostMicrousd: integer("output_cost_microusd").notNull().default(0),
  /** Sum of the three above (integer micro-USD); the settled cost of record. */
  totalCostMicrousd: integer("total_cost_microusd").notNull().default(0),
  // ----- Pricing provenance (spec §5.3) — immutable snapshot per request -----
  /** Where the pricing came from (e.g. "google-ai-studio-2026-07"). */
  pricingSource: text("pricing_source"),
  /** Stable version of the pricing snapshot captured at request time. */
  pricingVersion: text("pricing_version"),
  /** Full pricing snapshot JSON (prices only; never keys/secrets). */
  pricingSnapshotJson: text("pricing_snapshot_json"),
  /** Whether tokens came from the provider response or local estimation. */
  usageSource: text("usage_source"),
  estimatedCostMicroUsd: integer("estimated_cost_micro_usd").notNull().default(0),
  actualCostMicroUsd: integer("actual_cost_micro_usd").notNull().default(0),
  finishReason: text("finish_reason"),
  // ----- Token Pool provenance (spec §6) — from the composite reservation ---
  /** Pool the request counted against (NULL for passthrough / legacy rows). */
  poolId: text("pool_id"),
  /** Logical model id used for quota accounting (NULL when unmapped). */
  logicalModelId: text("logical_model_id"),
  /** True when tokens were locally estimated rather than provider-reported. */
  estimated: integer("estimated", { mode: "boolean" }),
  /** Token overage beyond the reserved estimate (>= 0). */
  overageTokens: integer("overage_tokens"),
  // ----- OpenAI Credential daily ledger provenance — NULL on legacy rows -----
  /** Reservation key linking this request to a credential daily reservation. */
  credentialDailyReservationKey: text("credential_daily_reservation_key"),
  /** Fallback attempt ordinal that produced this row. */
  usageAttempt: integer("usage_attempt"),
  /** priced | unconfigured | unattributed */
  costStatus: text("cost_status"),
  createdAt: text("created_at").notNull()
});

/**
 * Complete guest answers are kept separately from operational request logs.
 * Recovery is authorized by a high-entropy recovery token (digest stored here),
 * never by IP alone. visitorIpHash is the legacy column kept for back-compat
 * but no longer read; visitorIpHmac is the HMAC-SHA-256 of the client IP used
 * only as a quota/risk signal. expires_at drives the retention cleanup.
 */
export const guestAskAnswers = sqliteTable("guest_ask_answers", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  visitorIpHash: text("visitor_ip_hash").notNull(),
  visitorIpHmac: text("visitor_ip_hmac"),
  recoveryTokenDigest: text("recovery_token_digest"),
  expiresAt: text("expires_at"),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  finishReason: text("finish_reason"),
  completionJson: text("completion_json"),
  createdAt: text("created_at").notNull()
});

/** Provider-level routing/display configuration. Secrets live in credentials. */
export const aiProviderConfigs = sqliteTable("ai_provider_configs", {
  id: text("id").primaryKey(),
  /** Adapter type, not the provider instance identity. Multiple instances may share it. */
  provider: text("provider").notNull(),
  /** Stable administrator-facing provider instance key. */
  slug: text("slug").notNull(),
  displayName: text("display_name").notNull(),
  baseUrl: text("base_url"),
  model: text("model"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  isRouterProvider: integer("is_router_provider", { mode: "boolean" }).notNull().default(false),
  priority: integer("priority").notNull().default(100),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at")
});

/** Encrypted credential material. Only server code can decrypt this column. */
export const aiProviderCredentials = sqliteTable("ai_provider_credentials", {
  id: text("id").primaryKey(),
  providerConfigId: text("provider_config_id").notNull(),
  name: text("name").notNull(),
  encryptedApiKey: text("encrypted_api_key").notNull(),
  maskedApiKey: text("masked_api_key").notNull(),
  keyFingerprint: text("key_fingerprint").notNull().unique(),
  baseUrl: text("base_url"),
  model: text("model"),
  status: text("status").notNull().default("active"),
  priority: integer("priority").notNull().default(100),
  weight: integer("weight").notNull().default(1),
  failureCount: integer("failure_count").notNull().default(0),
  cooldownUntil: text("cooldown_until"),
  lastTestedAt: text("last_tested_at"),
  lastTestStatus: text("last_test_status"),
  lastTestLatencyMs: integer("last_test_latency_ms"),
  /** Explicit billing/use metadata; legacy rows remain unknown. */
  billingMode: text("billing_mode").notNull().default("unknown"),
  region: text("region"),
  endpointProfile: text("endpoint_profile"),
  usageScope: text("usage_scope").notNull().default("unknown"),
  productionAuthorized: integer("production_authorized", { mode: "boolean" }).notNull().default(false),
  providerHealth: text("provider_health").notNull().default("unknown"),
  /** Evaluation access is always explicit; production eligibility does not imply it. */
  allowEvaluation: integer("allow_evaluation", { mode: "boolean" }).notNull().default(false),
  evaluationAuthorizedAt: text("evaluation_authorized_at"),
  evaluationAuthorizedByAdminId: text("evaluation_authorized_by_admin_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  disabledAt: text("disabled_at"),
  deletedAt: text("deleted_at")
});

/** Per-credential, per-model request/token quota and rolling counters. */
export const aiCredentialModelQuotas = sqliteTable("ai_credential_model_quotas", {
  id: text("id").primaryKey(),
  credentialId: text("credential_id").notNull(),
  model: text("model").notNull(),
  rpmLimit: integer("rpm_limit"),
  tpmLimit: integer("tpm_limit"),
  rpdLimit: integer("rpd_limit"),
  requestsThisMinute: integer("requests_this_minute").notNull().default(0),
  tokensThisMinute: integer("tokens_this_minute").notNull().default(0),
  requestsToday: integer("requests_today").notNull().default(0),
  minuteResetAt: text("minute_reset_at").notNull(),
  dailyResetAt: text("daily_reset_at").notNull(),
  /** IANA timezone used for the daily reset boundary. */
  resetTimezone: text("reset_timezone").notNull().default("Asia/Taipei"),
  /** Provider response usage when available; otherwise local estimation. */
  usageSource: text("usage_source").notNull().default("system_estimated"),
  // ----- Pricing config (spec §5.1) — DB-backed, authoritative per model. ---
  /** ISO-4217 currency; default USD. */
  currency: text("currency"),
  /** Pricing tier: standard | free | unavailable. */
  serviceTier: text("service_tier"),
  /** USD per 1,000,000 non-cached input tokens. */
  inputPriceUsdPerMillion: real("input_price_usd_per_million"),
  /** USD per 1,000,000 output tokens. */
  outputPriceUsdPerMillion: real("output_price_usd_per_million"),
  /** USD per 1,000,000 cached input tokens (discounted rate). */
  cachedInputPriceUsdPerMillion: real("cached_input_price_usd_per_million"),
  /** USD per 1,000,000 token-hours of context cache storage. */
  cacheStorageUsdPerMillionTokenHour: real("cache_storage_usd_per_million_token_hour"),
  /** ISO date the listed prices take effect. */
  pricingEffectiveAt: text("pricing_effective_at"),
  /** Human-readable provenance, e.g. "google-ai-studio-2026-07". */
  pricingSource: text("pricing_source"),
  /** True when paid pricing is intentionally not published (never fabricated). */
  pricingUnavailable: integer("pricing_unavailable", { mode: "boolean" }).notNull().default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** The single model selected when a request does not specify a model. */
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

/** Sanitised admin-operation ledger. Never put request bodies, keys, or errors here. */
export const aiAdminAuditLogs = sqliteTable("ai_admin_audit_logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull()
});

/** Revocable, short-lived browser sessions for the Admin SPA. Secrets are
 * stored only as SHA-256 digests; the raw cookie values never enter SQLite. */
export const adminSessions = sqliteTable("admin_sessions", {
  id: text("id").primaryKey(),
  tokenDigest: text("token_digest").notNull().unique(),
  csrfTokenDigest: text("csrf_token_digest").notNull(),
  username: text("username").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  revokedAt: text("revoked_at"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent")
});

/** Safe, offline evaluation run summaries. No question/answer/prompt payloads. */
export const aiEvaluationRuns = sqliteTable("ai_evaluation_runs", {
  id: text("id").primaryKey(),
  datasetId: text("dataset_id").notNull(),
  datasetVersion: integer("dataset_version").notNull(),
  executionMode: text("execution_mode").notNull(),
  status: text("status").notNull().default("running"),
  idempotencyKey: text("idempotency_key").unique(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  totalCases: integer("total_cases").notNull().default(0),
  passedCases: integer("passed_cases").notNull().default(0),
  failedCases: integer("failed_cases").notNull().default(0),
  passRate: real("pass_rate").notNull().default(0),
  averageScore: real("average_score").notNull().default(0),
  averageDurationMs: real("average_duration_ms").notNull().default(0),
  p50DurationMs: real("p50_duration_ms").notNull().default(0),
  p95DurationMs: real("p95_duration_ms").notNull().default(0),
  totalModelCalls: integer("total_model_calls").notNull().default(0),
  averageModelCalls: real("average_model_calls").notNull().default(0),
  totalInputTokens: integer("total_input_tokens"),
  totalOutputTokens: integer("total_output_tokens"),
  totalTokens: integer("total_tokens"),
  conflictRate: real("conflict_rate").notNull().default(0),
  unresolvedRate: real("unresolved_rate").notNull().default(0),
  baselineRunId: text("baseline_run_id"),
  regressionIssueCount: integer("regression_issue_count").notNull().default(0),
  trafficClass: text("traffic_class").notNull().default("evaluation"),
  maxTokenBudget: integer("max_token_budget"),
  consumedTokens: integer("consumed_tokens").notNull().default(0),
  dailyBudgetSnapshot: integer("daily_budget_snapshot"),
  evaluationPoolId: text("evaluation_pool_id"),
  cancelRequestedAt: text("cancel_requested_at"),
  cancelledAt: text("cancelled_at"),
  preflightId: text("preflight_id"),
  logicalModelIdsJson: text("logical_model_ids_json"),
  providerIdsJson: text("provider_ids_json"),
  createdByAdminId: text("created_by_admin_id"),
  createdAt: text("created_at").notNull()
});

export const aiEvaluationMetrics = sqliteTable("ai_evaluation_metrics", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  dimension: text("dimension").notNull(),
  dimensionValue: text("dimension_value").notNull(),
  count: integer("count").notNull(),
  passed: integer("passed").notNull(),
  passRate: real("pass_rate").notNull(),
  averageScore: real("average_score").notNull()
});

export const aiEvaluationIssues = sqliteTable("ai_evaluation_issues", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  caseId: text("case_id").notNull(),
  category: text("category").notNull(),
  expectedKind: text("expected_kind").notNull(),
  score: real("score").notNull(),
  code: text("code").notNull(),
  severity: text("severity").notNull(),
  safeSummary: text("safe_summary")
});

/** Server-controlled live evaluation settings. No credentials or prompts. */
export const aiEvaluationSettings = sqliteTable("ai_evaluation_settings", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  evaluationPoolId: text("evaluation_pool_id"),
  allowedDatasetIdsJson: text("allowed_dataset_ids_json").notNull().default("[]"),
  allowedLogicalModelIdsJson: text("allowed_logical_model_ids_json").notNull().default("[]"),
  allowedProviderIdsJson: text("allowed_provider_ids_json").notNull().default("[]"),
  maxCasesPerRun: integer("max_cases_per_run").notNull().default(0),
  maxTokensPerRun: integer("max_tokens_per_run").notNull().default(0),
  maxTokensPerDay: integer("max_tokens_per_day").notNull().default(0),
  maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(1),
  requireDryRun: integer("require_dry_run", { mode: "boolean" }).notNull().default(true),
  requireExplicitConfirmation: integer("require_explicit_confirmation", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull(),
  updatedByAdminId: text("updated_by_admin_id")
});

/** Daily live-evaluation budget, independent from formal student usage. */
export const aiEvaluationDailyUsage = sqliteTable("ai_evaluation_daily_usage", {
  usageDate: text("usage_date").primaryKey(),
  consumedTokens: integer("consumed_tokens").notNull().default(0),
  reservedTokens: integer("reserved_tokens").notNull().default(0),
  updatedAt: text("updated_at").notNull()
});

/** Dedicated evaluation pool. It is never used by production TokenPoolPort. */
export const aiEvaluationTokenPools = sqliteTable("ai_evaluation_token_pools", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  trafficClass: text("traffic_class").notNull().default("evaluation"),
  capacityTokens: integer("capacity_tokens").notNull(),
  usedTokens: integer("used_tokens").notNull().default(0),
  reservedTokens: integer("reserved_tokens").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const aiEvaluationBudgetReservations = sqliteTable("ai_evaluation_budget_reservations", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  requestId: text("request_id").notNull().unique(),
  poolId: text("pool_id").notNull(),
  usageDate: text("usage_date").notNull(),
  estimatedTokens: integer("estimated_tokens").notNull(),
  actualTokens: integer("actual_tokens"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  settledAt: text("settled_at"),
  releasedAt: text("released_at")
});

export const aiEvaluationPreflights = sqliteTable("ai_evaluation_preflights", {
  id: text("id").primaryKey(),
  adminId: text("admin_id").notNull(),
  datasetId: text("dataset_id").notNull(),
  datasetVersion: integer("dataset_version").notNull(),
  selectedCaseCount: integer("selected_case_count").notNull(),
  maxTokenBudget: integer("max_token_budget").notNull(),
  logicalModelIdsJson: text("logical_model_ids_json").notNull(),
  providerIdsJson: text("provider_ids_json").notNull(),
  estimatedMinimumModelCalls: integer("estimated_minimum_model_calls").notNull(),
  estimatedMaximumModelCalls: integer("estimated_maximum_model_calls").notNull(),
  estimatedMaximumTokens: integer("estimated_maximum_tokens").notNull(),
  evaluationPoolRemainingTokens: integer("evaluation_pool_remaining_tokens").notNull(),
  dailyRemainingTokens: integer("daily_remaining_tokens").notNull(),
  blockersJson: text("blockers_json").notNull().default("[]"),
  warningsJson: text("warnings_json").notNull().default("[]"),
  confirmationDigest: text("confirmation_digest"),
  allowed: integer("allowed", { mode: "boolean" }).notNull().default(false),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  createdAt: text("created_at").notNull()
});

/** Server-owned Phase 4D governance settings. No prompts or provider secrets. */
export const aiEvaluationGovernanceSettings = sqliteTable("ai_evaluation_governance_settings", {
  id: text("id").primaryKey(),
  retentionJson: text("retention_json").notNull().default("{}"),
  regressionAlertJson: text("regression_alert_json").notNull().default("{}"),
  budgetAlertJson: text("budget_alert_json").notNull().default("{}"),
  schedulerEnabled: integer("scheduler_enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
  updatedByAdminId: text("updated_by_admin_id")
});

export const aiEvaluationSchedules = sqliteTable("ai_evaluation_schedules", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  datasetId: text("dataset_id").notNull(),
  datasetVersion: integer("dataset_version").notNull(),
  executionMode: text("execution_mode").notNull(),
  cadence: text("cadence").notNull(),
  scheduledTime: text("scheduled_time").notNull(),
  timezone: text("timezone").notNull(),
  baselinePolicy: text("baseline_policy").notNull(),
  fixedBaselineRunId: text("fixed_baseline_run_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const aiEvaluationScheduleRuns = sqliteTable("ai_evaluation_schedule_runs", {
  id: text("id").primaryKey(),
  scheduleId: text("schedule_id").notNull(),
  scheduledWindow: text("scheduled_window").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").notNull().default("running"),
  runId: text("run_id"),
  attemptCount: integer("attempt_count").notNull().default(1),
  safeErrorCode: text("safe_error_code"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at")
});

export const aiEvaluationAlertPolicies = sqliteTable("ai_evaluation_alert_policies", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  minimumSampleSize: integer("minimum_sample_size").notNull().default(1),
  passRateDropPercentagePoints: real("pass_rate_drop_percentage_points"),
  categoryPassRateDropPercentagePoints: real("category_pass_rate_drop_percentage_points"),
  unresolvedRateIncreasePercentagePoints: real("unresolved_rate_increase_percentage_points"),
  conflictRateIncreasePercentagePoints: real("conflict_rate_increase_percentage_points"),
  averageModelCallsIncrease: real("average_model_calls_increase"),
  p95LatencyIncreaseMs: real("p95_latency_increase_ms"),
  consecutiveFailuresRequired: integer("consecutive_failures_required").notNull().default(1),
  evaluationPoolRemainingThreshold: integer("evaluation_pool_remaining_threshold"),
  dailyBudgetRemainingThreshold: integer("daily_budget_remaining_threshold"),
  updatedAt: text("updated_at").notNull(),
  updatedByAdminId: text("updated_by_admin_id")
});

export const aiEvaluationAlerts = sqliteTable("ai_evaluation_alerts", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  scheduleId: text("schedule_id"),
  type: text("type").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull().default("open"),
  safeSummary: text("safe_summary").notNull(),
  createdAt: text("created_at").notNull(),
  acknowledgedAt: text("acknowledged_at"),
  resolvedAt: text("resolved_at")
});

export const aiEvaluationRetentionRuns = sqliteTable("ai_evaluation_retention_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("previewed"),
  candidateIdsJson: text("candidate_ids_json").notNull().default("[]"),
  candidateDigest: text("candidate_digest").notNull(),
  expiresAt: text("expires_at").notNull(),
  deletedCount: integer("deleted_count").notNull().default(0),
  safeErrorCode: text("safe_error_code"),
  createdByAdminId: text("created_by_admin_id"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at")
});

/** Student pilot control plane. It contains policy and aggregates only. */
export const aiMultiModelPilotSettings = sqliteTable("ai_multi_model_pilot_settings", {
  id: text("id").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  trafficPercentage: integer("traffic_percentage").notNull().default(0),
  allowedTaskCategoriesJson: text("allowed_task_categories_json").notNull().default("[]"),
  allowVerification: integer("allow_verification", { mode: "boolean" }).notNull().default(true),
  allowAdjudication: integer("allow_adjudication", { mode: "boolean" }).notNull().default(false),
  maxModelCallsPerRequest: integer("max_model_calls_per_request").notNull().default(2),
  pilotVersion: text("pilot_version").notNull().default("phase-5a-default"),
  stopPolicyJson: text("stop_policy_json").notNull().default("{}"),
  readinessReviewJson: text("readiness_review_json").notNull().default("{}"),
  autoStoppedAt: text("auto_stopped_at"),
  autoStopReason: text("auto_stop_reason"),
  updatedAt: text("updated_at").notNull(),
  updatedByAdminId: text("updated_by_admin_id")
});

/** Safe aggregate windows; no question, answer, prompt or raw provider data. */
export const aiMultiModelPilotMetrics = sqliteTable("ai_multi_model_pilot_metrics", {
  id: text("id").primaryKey(),
  windowKey: text("window_key").notNull().unique(),
  trafficClass: text("traffic_class").notNull(),
  requestCount: integer("request_count").notNull().default(0),
  primaryOnlyCount: integer("primary_only_count").notNull().default(0),
  verificationCount: integer("verification_count").notNull().default(0),
  adjudicationCount: integer("adjudication_count").notNull().default(0),
  conflictCount: integer("conflict_count").notNull().default(0),
  unresolvedCount: integer("unresolved_count").notNull().default(0),
  providerFailureCount: integer("provider_failure_count").notNull().default(0),
  budgetRejectionCount: integer("budget_rejection_count").notNull().default(0),
  contextWindowRejectionCount: integer("context_window_rejection_count").notNull().default(0),
  totalModelCalls: integer("total_model_calls").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  p50LatencyMs: real("p50_latency_ms").notNull().default(0),
  p95LatencyMs: real("p95_latency_ms").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const aiBudgetPolicies = sqliteTable("ai_budget_policies", {
  id: text("id").primaryKey(),
  scopeType: text("scope_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  dailyTokenLimit: integer("daily_token_limit").notNull().default(1000000),
  // Stored as micro-USD integer (USD * 1_000_000) for exact arithmetic.
  dailyCostLimitMicroUsd: integer("daily_cost_limit_micro_usd").notNull().default(10000000),
  warningPercentage: integer("warning_percentage").notNull().default(80),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const aiDailyUsage = sqliteTable("ai_daily_usage", {
  id: text("id").primaryKey(),
  date: text("date").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeKey: text("scope_key").notNull(),
  requestCount: integer("request_count").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  estimatedCostMicroUsd: integer("estimated_cost_micro_usd").notNull().default(0),
  actualCostMicroUsd: integer("actual_cost_micro_usd").notNull().default(0),
  reservedTokens: integer("reserved_tokens").notNull().default(0),
  reservedCostMicroUsd: integer("reserved_cost_micro_usd").notNull().default(0),
  updatedAt: text("updated_at").notNull()
});

/** Idempotent reservation ledger used to make daily limits concurrency-safe. */
export const aiBudgetReservations = sqliteTable("ai_budget_reservations", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  date: text("date").notNull(),
  estimatedTokens: integer("estimated_tokens").notNull(),
  estimatedCostMicroUsd: integer("estimated_cost_micro_usd").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

// ---------------------------------------------------------------------------
// Token Pool system (spec: OpenAI daily token pool + multi-model routing).
//
// Four INDEPENDENT limit dimensions — a request must pass ALL of them before
// a provider is called:
//   (1) Daily Token Pool        — aiTokenPools / aiTokenPoolReservations
//   (2) Provider RPM/TPM/RPD    — aiCredentialModelQuotas (unchanged)
//   (3) Model Daily Limit       — aiModelDailyLimits
//   (4) Context Window          — per-request, stored on aiLogicalModels
//
// Quota accounting uses logicalModelId; the provider call uses providerModelName.
// Context Window columns describe single-request capacity and are deliberately
// kept separate from the per-day dailyLimit on aiModelDailyLimits.
// ---------------------------------------------------------------------------

/**
 * Logical Model Registry: maps a stable logical model id (e.g. "gpt-5.6-terra")
 * to the real provider + model name used in API calls. Also carries the
 * single-request Context Window spec (dimension 4), independent of daily quota.
 */
export const aiLogicalModels = sqliteTable("ai_logical_models", {
  id: text("id").primaryKey(),
  /** Stable logical id used for quota accounting (e.g. "gpt-5.6-terra"). */
  logicalModelId: text("logical_model_id").notNull().unique(),
  /** Provider the logical model routes to (AiProviderId). */
  providerId: text("provider_id").notNull(),
  /** Optional provider instance association; null preserves legacy adapter-only rows. */
  providerConfigId: text("provider_config_id"),
  /** Real model name passed to the provider API. */
  providerModelName: text("provider_model_name").notNull(),
  // ----- Context Window spec (dimension 4: single-request capacity) ---------
  /** Total context window of the model in tokens. */
  contextWindowTokens: integer("context_window_tokens").notNull(),
  /** Optional stricter input cap (must be <= contextWindowTokens). */
  maxInputTokens: integer("max_input_tokens"),
  /** Single-request output ceiling. */
  maxOutputTokens: integer("max_output_tokens").notNull(),
  /** Whether the model supports a thinking/reasoning budget. */
  supportsThinking: integer("supports_thinking", { mode: "boolean" }).notNull().default(false),
  /** Tokenizer id used for estimation (e.g. "char-3", "cl100k"). */
  tokenizerType: text("tokenizer_type"),
  /** Tokenizer version, for auditability of estimates. */
  tokenizerVersion: text("tokenizer_version"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

/**
 * Daily Token Pool: a shared daily token budget (e.g. OpenAI shared 2,500,000;
 * GPT-5.6 Sol independent 200,000). Reset daily at Taipei midnight.
 */
export const aiTokenPools = sqliteTable("ai_token_pools", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** "shared" = Tier 1-2 shared pool; "sol" = GPT-5.6 Sol independent pool. */
  poolType: text("pool_type").notNull().unique(),
  /** IANA timezone for the daily reset boundary. */
  timezone: text("timezone").notNull().default("Asia/Taipei"),
  /** Total daily token budget for the pool. */
  dailyLimit: integer("daily_limit").notNull(),
  /** Settled token usage for the current period. */
  usedTokens: integer("used_tokens").notNull().default(0),
  /** Reserved-but-not-yet-settled tokens (concurrency safety). */
  reservedTokens: integer("reserved_tokens").notNull().default(0),
  /** Utilization percentage (0-100) at which a warning is raised. */
  warningThreshold: integer("warning_threshold").notNull().default(60),
  /** Utilization percentage (0-100) at which throttling begins. */
  throttleThreshold: integer("throttle_threshold").notNull().default(80),
  /** Utilization percentage (0-100) at which critical restriction applies. */
  criticalThreshold: integer("critical_threshold").notNull().default(90),
  /** ISO timestamp of the next daily reset. */
  resetAt: text("reset_at").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

/**
 * Per logical-model daily token limit (dimension 3). Belongs to exactly one
 * pool. The model hard cap is a technical ceiling, NOT independent free quota:
 * every token also decrements the parent pool. maxOutputTokens lives on
 * aiLogicalModels (single-request); this row only carries the daily cap.
 */
export const aiModelDailyLimits = sqliteTable("ai_model_daily_limits", {
  id: text("id").primaryKey(),
  /** Logical model id (foreign reference to aiLogicalModels.logicalModelId). */
  logicalModelId: text("logical_model_id").notNull().unique(),
  /** Pool this model's usage counts against. */
  poolId: text("pool_id").notNull(),
  /** Per-model daily token hard cap. */
  dailyLimit: integer("daily_limit").notNull(),
  usedTokens: integer("used_tokens").notNull().default(0),
  reservedTokens: integer("reserved_tokens").notNull().default(0),
  /** Routing priority (lower = higher priority). */
  priority: integer("priority").notNull().default(100),
  /** Logical model to fall back to when this model's quota is exhausted. */
  fallbackLogicalModelId: text("fallback_logical_model_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Whether a second-model verification pass may use this model. */
  allowSecondModelVerification: integer("allow_second_model_verification", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

/**
 * Idempotent reservation ledger for the Token Pool, keyed by a composite
 * reservationKey so the same requestId can open distinct reservations across
 * fallback attempts (different pool/model). Supports the state machine:
 * pending -> settled | released, with idempotent re-settle/re-release.
 */
export const aiTokenPoolReservations = sqliteTable("ai_token_pool_reservations", {
  id: text("id").primaryKey(),
  /** Composite idempotency key: `${requestId}:${attemptId}:${poolId}:${logicalModelId}`. */
  reservationKey: text("reservation_key").notNull().unique(),
  requestId: text("request_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  poolId: text("pool_id").notNull(),
  logicalModelId: text("logical_model_id").notNull(),
  estimatedTokens: integer("estimated_tokens").notNull(),
  /** Actual tokens reported by the provider on settle (NULL until settled). */
  actualTokens: integer("actual_tokens"),
  /** True when actualTokens exceeded the reserved estimate. */
  overage: integer("overage", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("pending"),
  settledAt: text("settled_at"),
  releasedAt: text("released_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

// ---------------------------------------------------------------------------
// OpenAI Credential daily ledger (per-key independent daily quota).
//
// Four existing limit dimensions stay unchanged:
//   (1) Daily Token Pool        — aiTokenPools
//   (2) Provider RPM/TPM/RPD    — aiCredentialModelQuotas
//   (3) Model Daily Limit       — aiModelDailyLimits
//   (4) Context Window          — aiLogicalModels
// This adds a FIFTH, orthogonal dimension scoped per OpenAI credential:
//   (5) Credential Daily Token/Cost — tables below.
//
// Only OpenAI credentials (provider = 'openai' via provider_config_id) ever
// receive rows. Gemini/ZAI/Kimi/Qwen never enter this ledger.
// ---------------------------------------------------------------------------

/**
 * Per-credential daily quota configuration (one row per credential).
 * NULL limits mean "unset / unlimited"; enabled=0 means the daily quota is
 * configured but not yet enforcing (backfill default).
 */
export const aiCredentialDailyLimits = sqliteTable("ai_credential_daily_limits", {
  id: text("id").primaryKey(),
  credentialId: text("credential_id").notNull(),
  /** Daily token ceiling; NULL = unlimited. */
  dailyTokenLimit: integer("daily_token_limit"),
  /** Daily cost ceiling in integer micro-USD (1 USD = 1_000_000); NULL = unlimited. */
  dailyCostLimitMicroUsd: integer("daily_cost_limit_micro_usd"),
  timezone: text("timezone").notNull().default("Asia/Taipei"),
  warningThreshold: integer("warning_threshold").notNull().default(80),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /** ISO timestamp of the next daily reset (next local midnight). */
  resetAt: text("reset_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

/**
 * Per-credential, per-day usage aggregate. `usage_date` is the local date in
 * the snapshot `timezone`. UNIQUE(credential_id, usage_date) guarantees one
 * row per credential per local day; crossing local midnight opens a new row.
 */
export const aiCredentialDailyUsage = sqliteTable("ai_credential_daily_usage", {
  id: text("id").primaryKey(),
  credentialId: text("credential_id").notNull(),
  usageDate: text("usage_date").notNull(),
  /** Snapshot of the credential timezone when this row was created (audit). */
  timezone: text("timezone").notNull().default("Asia/Taipei"),
  providerConfigId: text("provider_config_id").notNull(),
  /** Last settled provider model name. */
  providerModel: text("provider_model"),
  inputTokens: integer("input_tokens").notNull().default(0),
  cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  reasoningTokens: integer("reasoning_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  usedTokens: integer("used_tokens").notNull().default(0),
  reservedTokens: integer("reserved_tokens").notNull().default(0),
  estimatedCostMicroUsd: integer("estimated_cost_micro_usd").notNull().default(0),
  actualCostMicroUsd: integer("actual_cost_micro_usd").notNull().default(0),
  reservedCostMicroUsd: integer("reserved_cost_micro_usd").notNull().default(0),
  requestCount: integer("request_count").notNull().default(0),
  /** priced | unconfigured */
  costSource: text("cost_source").notNull().default("unconfigured"),
  lastUsedAt: text("last_used_at"),
  resetAt: text("reset_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

/**
 * Idempotent reservation ledger for the credential daily quota. reservationKey
 * is `${requestId}:${attempt}:${credentialId}:${providerModel}` — never secrets.
 * State machine: pending -> settled | released, with idempotent re-settle/release.
 */
export const aiCredentialDailyReservations = sqliteTable("ai_credential_daily_reservations", {
  id: text("id").primaryKey(),
  reservationKey: text("reservation_key").notNull().unique(),
  requestId: text("request_id").notNull(),
  attempt: integer("attempt").notNull(),
  credentialId: text("credential_id").notNull(),
  providerConfigId: text("provider_config_id").notNull(),
  providerModel: text("provider_model").notNull(),
  usageDate: text("usage_date").notNull(),
  estimatedTokens: integer("estimated_tokens").notNull(),
  /** Actual tokens reported on settle (NULL until settled). */
  actualTokens: integer("actual_tokens"),
  estimatedCostMicroUsd: integer("estimated_cost_micro_usd").notNull().default(0),
  actualCostMicroUsd: integer("actual_cost_micro_usd"),
  /** True when actualTokens exceeded the reserved estimate. */
  overage: integer("overage", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("pending"),
  /** priced | unconfigured */
  costStatus: text("cost_status").notNull().default("unconfigured"),
  settledAt: text("settled_at"),
  releasedAt: text("released_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export type DbSchema = {
  books: typeof books;
  bookFiles: typeof bookFiles;
  bookContents: typeof bookContents;
  bookChapters: typeof bookChapters;
  chatSessions: typeof chatSessions;
  chatMessages: typeof chatMessages;
  pdfAccessLogs: typeof pdfAccessLogs;
  bookAiJobs: typeof bookAiJobs;
  bookQaLogs: typeof bookQaLogs;
  appSettings: typeof appSettings;
  smartBookNotes: typeof smartBookNotes;
  aiRequestLogs: typeof aiRequestLogs;
  aiUsageLogs: typeof aiUsageLogs;
  guestAskAnswers: typeof guestAskAnswers;
  aiProviderConfigs: typeof aiProviderConfigs;
  aiProviderCredentials: typeof aiProviderCredentials;
  aiCredentialModelQuotas: typeof aiCredentialModelQuotas;
  aiAdminAuditLogs: typeof aiAdminAuditLogs;
  aiEvaluationRuns: typeof aiEvaluationRuns;
  aiEvaluationMetrics: typeof aiEvaluationMetrics;
  aiEvaluationIssues: typeof aiEvaluationIssues;
  aiEvaluationSettings: typeof aiEvaluationSettings;
  aiEvaluationDailyUsage: typeof aiEvaluationDailyUsage;
  aiEvaluationTokenPools: typeof aiEvaluationTokenPools;
  aiEvaluationBudgetReservations: typeof aiEvaluationBudgetReservations;
  aiEvaluationPreflights: typeof aiEvaluationPreflights;
  aiEvaluationGovernanceSettings: typeof aiEvaluationGovernanceSettings;
  aiEvaluationSchedules: typeof aiEvaluationSchedules;
  aiEvaluationScheduleRuns: typeof aiEvaluationScheduleRuns;
  aiEvaluationAlertPolicies: typeof aiEvaluationAlertPolicies;
  aiEvaluationAlerts: typeof aiEvaluationAlerts;
  aiEvaluationRetentionRuns: typeof aiEvaluationRetentionRuns;
  aiMultiModelPilotSettings: typeof aiMultiModelPilotSettings;
  aiMultiModelPilotMetrics: typeof aiMultiModelPilotMetrics;
  aiBudgetPolicies: typeof aiBudgetPolicies;
  aiDailyUsage: typeof aiDailyUsage;
  aiBudgetReservations: typeof aiBudgetReservations;
  aiLogicalModels: typeof aiLogicalModels;
  aiTokenPools: typeof aiTokenPools;
  aiModelDailyLimits: typeof aiModelDailyLimits;
  aiTokenPoolReservations: typeof aiTokenPoolReservations;
  aiCredentialDailyLimits: typeof aiCredentialDailyLimits;
  aiCredentialDailyUsage: typeof aiCredentialDailyUsage;
  aiCredentialDailyReservations: typeof aiCredentialDailyReservations;
};

export const schema = {
  books,
  bookFiles,
  bookContents,
  bookChapters,
  chatSessions,
  chatMessages,
  pdfAccessLogs,
  bookAiJobs,
  bookQaLogs,
  appSettings,
  smartBookNotes,
  aiRequestLogs,
  aiUsageLogs,
  guestAskAnswers,
  aiProviderConfigs,
  aiProviderCredentials,
  aiCredentialModelQuotas,
  aiAdminAuditLogs,
  aiEvaluationRuns,
  aiEvaluationMetrics,
  aiEvaluationIssues,
  aiEvaluationSettings,
  aiEvaluationDailyUsage,
  aiEvaluationTokenPools,
  aiEvaluationBudgetReservations,
  aiEvaluationPreflights,
  aiEvaluationGovernanceSettings,
  aiEvaluationSchedules,
  aiEvaluationScheduleRuns,
  aiEvaluationAlertPolicies,
  aiEvaluationAlerts,
  aiEvaluationRetentionRuns,
  aiMultiModelPilotSettings,
  aiMultiModelPilotMetrics,
  aiBudgetPolicies,
  aiDailyUsage,
  aiBudgetReservations,
  aiLogicalModels,
  aiTokenPools,
  aiModelDailyLimits,
  aiTokenPoolReservations,
  aiCredentialDailyLimits,
  aiCredentialDailyUsage,
  aiCredentialDailyReservations
};
