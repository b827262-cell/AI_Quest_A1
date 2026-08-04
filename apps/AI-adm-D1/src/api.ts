import type {
  AdminChapter,
  AppearanceSettings,
  AppearanceSettingsUpdate,
  Book,
  BookAiJob,
  BookChapter,
  BookContent,
  BookFile,
  BookFileRole,
  BookQaLog,
  ChapterPreviewRow,
  GeneratePdfJsonIndexInput,
  ReaderOutlineNode,
  ReaderOutlineSource,
  PdfJsonIndex,
  StoredJsonIndexSummary,
  CreateBookInput,
  UpdateBookInput
} from "@ai-smartbook/schema";
import type { SiteConfig, SiteConfigUpdate } from "@ai-smartbook/schema";
import {
  qmStatusResponseSchema,
  qmRuntimeConfigViewResponseSchema,
  qmRuntimeConfigSaveResponseSchema,
  qmRuntimeConfigTestResultSchema,
  type QmStatusResponse,
  type QmRuntimeConfig,
  type QmRuntimeConfigViewResponse,
  type QmRuntimeConfigSaveResponse,
  type QmRuntimeConfigTestResult
} from "@ai-smartbook/contracts";

export interface ChapterInput {
  title: string;
  orderIndex: number;
  pageStart?: number | null;
  pageEnd?: number | null;
  level?: number;
  summary?: string | null;
}

export interface ReaderTocImportPayload {
  format: "json" | "markdown";
  content: string;
}

export interface ReaderTocSummary {
  fileId: string;
  fileName: string;
  createdAt: string;
  itemCount: number;
}

export interface ReaderTocResponse {
  source: ReaderOutlineSource;
  file: ReaderTocSummary | null;
  outline: ReaderOutlineNode[];
}

export interface GenerateReaderTocResponse extends ReaderTocResponse {
  textPreview: string;
  warnings: string[];
}

export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly fields?: Record<string, string>,
    public readonly details?: CredentialTestDetails
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export interface CredentialTestResponse {
  status: "success" | "failed";
  reason: string;
  latencyMs: number;
  endpointProfile: string | null;
  upstreamRequestSent: boolean;
}

export type CredentialTestDetails = Pick<CredentialTestResponse, "reason" | "latencyMs" | "endpointProfile" | "upstreamRequestSent">;

export type AiEvaluationMode = "fixture" | "mock_orchestrator" | "live";
export type AiEvaluationStatus = "pending_confirmation" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted";
export interface AiEvaluationRun {
  id: string;
  datasetId: string;
  datasetVersion: number;
  executionMode: AiEvaluationMode;
  status: AiEvaluationStatus;
  startedAt: string;
  completedAt: string | null;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  passRate: number;
  averageScore: number;
  averageDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  totalModelCalls: number;
  averageModelCalls: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalTokens: number | null;
  conflictRate: number;
  unresolvedRate: number;
  baselineRunId: string | null;
  regressionIssueCount: number;
  trafficClass?: "evaluation";
  maxTokenBudget?: number | null;
  consumedTokens?: number;
  dailyBudgetSnapshot?: number | null;
  evaluationPoolId?: string | null;
  cancelRequestedAt?: string | null;
  cancelledAt?: string | null;
  preflightId?: string | null;
  logicalModelIds?: string[];
  providerIds?: string[];
  createdAt: string;
}
export interface AiLiveEvaluationSettings {
  enabled: boolean;
  evaluationPoolId?: string;
  allowedDatasetIds: string[];
  allowedLogicalModelIds: string[];
  allowedProviderIds: string[];
  maxCasesPerRun: number;
  maxTokensPerRun: number;
  maxTokensPerDay: number;
  maxConcurrentRuns: number;
  requireDryRun: boolean;
  requireExplicitConfirmation: boolean;
  updatedAt: string;
}
export interface AiLivePreflight {
  dryRunId: string;
  confirmationToken?: string;
  expiresAt: string;
  allowed: boolean;
  datasetId: string;
  datasetVersion: number;
  selectedCaseCount: number;
  estimatedMinimumModelCalls: number;
  estimatedMaximumModelCalls: number;
  estimatedMaximumTokens: number;
  evaluationPoolRemainingTokens: number;
  dailyRemainingTokens: number;
  blockers: string[];
  warnings: string[];
}
export type AiPilotTaskCategory = "programming" | "mathematics" | "knowledge";
export interface AiPilotStopPolicy {
  providerFailureRateThreshold?: number;
  unresolvedRateThreshold?: number;
  budgetRejectionRateThreshold?: number;
  p95LatencyThresholdMs?: number;
  minimumRequestCount: number;
  consecutiveWindows: number;
}
export interface AiPilotSettings {
  enabled: boolean;
  trafficPercentage: number;
  allowedTaskCategories: AiPilotTaskCategory[];
  allowVerification: boolean;
  allowAdjudication: boolean;
  maxModelCallsPerRequest: number;
  pilotVersion: string;
  stopPolicy: AiPilotStopPolicy;
  updatedAt: string;
  autoStoppedAt?: string;
  autoStopReason?: string;
}
export interface AiLiveReadiness {
  ready: boolean;
  credentialReady: boolean;
  evaluationPoolReady: boolean;
  budgetReady: boolean;
  allowlistReady: boolean;
  liveEnabled: boolean;
  blockers: string[];
  warnings: string[];
  checkedAt: string;
  datasetId?: string;
  datasetVersion?: number;
  providerIds?: string[];
  logicalModelIds?: string[];
  evaluationPoolConfigured?: boolean;
}
export interface AiProductionReadiness {
  status: "ready_for_pilot" | "blocked" | "ready_with_warnings";
  checks: Array<{ name: string; passed: boolean; severity: "blocker" | "warning"; safeSummary: string }>;
  blockers: string[];
  warnings: string[];
  liveRunId?: string;
  reviewedAt: string;
}
export type AiEvaluationCadence = "daily" | "weekly";
export type AiEvaluationBaselinePolicy = "latest_comparable" | "fixed";
export interface AiEvaluationRetentionPolicy {
  enabled: boolean;
  maxRunsPerDatasetMode: number;
  maxAgeDays?: number;
  preserveLatestSuccessful: number;
  preserveBaselines: boolean;
  preserveRunsWithRegressionIssues: boolean;
  executionModes: AiEvaluationMode[];
}
export interface AiEvaluationSchedule {
  id: string;
  enabled: boolean;
  datasetId: string;
  datasetVersion: number;
  executionMode: "fixture" | "mock_orchestrator";
  cadence: AiEvaluationCadence;
  scheduledTime: string;
  timezone: string;
  baselinePolicy: AiEvaluationBaselinePolicy;
  fixedBaselineRunId?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AiEvaluationAlert {
  id: string;
  runId?: string | null;
  scheduleId?: string | null;
  type: string;
  severity: "info" | "warning" | "critical";
  status: "open" | "acknowledged" | "resolved";
  safeSummary: string;
  createdAt: string;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
}
export interface AiEvaluationMetric {
  id: string;
  runId: string;
  dimension: "category" | "difficulty" | "outcome" | "confidence";
  dimensionValue: string;
  count: number;
  passed: number;
  passRate: number;
  averageScore: number;
}
export interface AiEvaluationIssue {
  id: string;
  runId: string;
  caseId: string;
  category: string;
  expectedKind: string;
  score: number;
  code: string;
  severity: "low" | "medium" | "high";
  safeSummary?: string;
}
export interface AiEvaluationDetail {
  run: AiEvaluationRun;
  metrics: AiEvaluationMetric[];
  issues: AiEvaluationIssue[];
  regression?: {
    comparable: boolean;
    reason?: string;
    passRateDelta: number;
    averageScoreDelta: number;
    p95LatencyDeltaMs: number;
    averageModelCallsDelta: number;
    totalTokenDelta?: number;
    regressions: Array<{ code: string; severity: string; message: string }>;
  };
}

type ResponseSchema<T> = {
  safeParse: (input: unknown) =>
    | { success: true; data: T }
    | { success: false };
};

async function http<T>(path: string, init?: RequestInit, schema?: ResponseSchema<T>): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body && !(init.body instanceof FormData)
      ? { "Content-Type": "application/json" }
      : undefined,
    ...init
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      code?: string;
      fields?: Record<string, string>;
      fieldErrors?: Record<string, string>;
      reason?: unknown;
      latencyMs?: unknown;
      endpointProfile?: unknown;
      upstreamRequestSent?: unknown;
    };
    const details: CredentialTestDetails | undefined =
      typeof data.reason === "string"
      && typeof data.latencyMs === "number"
      && (typeof data.endpointProfile === "string" || data.endpointProfile === null)
      && typeof data.upstreamRequestSent === "boolean"
        ? {
            reason: data.reason,
            latencyMs: data.latencyMs,
            endpointProfile: data.endpointProfile,
            upstreamRequestSent: data.upstreamRequestSent
          }
        : undefined;
    throw new ApiHttpError(
      res.status,
      data.error || data.message || `${res.status} ${res.statusText}`,
      data.code,
      data.fieldErrors ?? data.fields,
      details
    );
  }
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json();
  if (!schema) return body as T;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiHttpError(502, "Invalid response from server", "INVALID_API_RESPONSE");
  }
  return parsed.data;
}

export interface UploadBookFileOptions {
  role?: BookFileRole;
  relatedFileId?: string | null;
}

export const adminApi = {
  getQmStatus: () => http<QmStatusResponse>("/api/admin/qm/status", undefined, qmStatusResponseSchema),
  runQmValidate: () => http<QmStatusResponse>("/api/admin/qm/validate", { method: "POST" }, qmStatusResponseSchema),
  runQmSmoke: () => http<QmStatusResponse>("/api/admin/qm/smoke", { method: "POST" }, qmStatusResponseSchema),
  getQmRuntimeConfig: () => http<QmRuntimeConfigViewResponse>("/api/admin/qm/runtime-config", undefined, qmRuntimeConfigViewResponseSchema),
  saveQmRuntimeConfig: (config: QmRuntimeConfig) => http<QmRuntimeConfigSaveResponse>("/api/admin/qm/runtime-config", { method: "PUT", body: JSON.stringify(config) }, qmRuntimeConfigSaveResponseSchema),
  testQmRuntimeConfig: () => http<QmRuntimeConfigTestResult>("/api/admin/qm/runtime-config/test", { method: "POST" }, qmRuntimeConfigTestResultSchema),
  getAiEvaluationSettings: () => http<{ settings: AiLiveEvaluationSettings }>("/api/admin/ai-evaluations/settings"),
  saveAiEvaluationSettings: (settings: Omit<AiLiveEvaluationSettings, "updatedAt">) => http<{ settings: AiLiveEvaluationSettings }>("/api/admin/ai-evaluations/settings", { method: "PUT", body: JSON.stringify(settings) }),
  preflightAiEvaluation: (input: { datasetId: string; maxCases: number; maxTokenBudget: number; logicalModelIds: string[] }) => http<AiLivePreflight>("/api/admin/ai-evaluations/live-preflight", { method: "POST", body: JSON.stringify(input) }),
  startLiveAiEvaluation: (input: { datasetId: string; maxCases: number; maxTokenBudget: number; logicalModelIds: string[]; dryRunId: string; confirmationToken: string; baselineRunId?: string }, idempotencyKey: string) => http<{ run: AiEvaluationRun; report: unknown; reused: boolean; cancelled: boolean }>("/api/admin/ai-evaluations/run", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ ...input, executionMode: "live" }) }),
  cancelAiEvaluation: (id: string) => http<{ run: AiEvaluationRun; alreadyFinished: boolean }>(`/api/admin/ai-evaluations/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  getAiLiveReadiness: () => http<AiLiveReadiness>("/api/admin/ai-evaluations/live-readiness"),
  getAiProductionReadiness: () => http<AiProductionReadiness>("/api/admin/ai-pilot/production-readiness"),
  submitAiReadinessReview: (review: Record<string, boolean>) => http<AiProductionReadiness>("/api/admin/ai-pilot/readiness-review", { method: "POST", body: JSON.stringify(review) }),
  getAiPilotSettings: () => http<{ settings: AiPilotSettings }>("/api/admin/ai-pilot/settings"),
  saveAiPilotSettings: (settings: Omit<AiPilotSettings, "updatedAt" | "autoStoppedAt" | "autoStopReason">) => http<{ settings: AiPilotSettings }>("/api/admin/ai-pilot/settings", { method: "PUT", body: JSON.stringify(settings) }),
  disableAiPilot: () => http<{ settings: AiPilotSettings }>("/api/admin/ai-pilot/disable", { method: "POST" }),
  getAiPilotMetrics: () => http<{ metrics: Array<Record<string, unknown>> }>("/api/admin/ai-pilot/metrics"),
  getAiEvaluationRetention: () => http<{ policy: AiEvaluationRetentionPolicy }>("/api/admin/ai-evaluations/retention"),
  getAiEvaluationGovernance: () => http<{ schedulerEnabled: boolean }>("/api/admin/ai-evaluations/governance"),
  setAiEvaluationScheduler: (schedulerEnabled: boolean) => http<{ schedulerEnabled: boolean }>("/api/admin/ai-evaluations/governance", { method: "PUT", body: JSON.stringify({ schedulerEnabled }) }),
  saveAiEvaluationRetention: (policy: AiEvaluationRetentionPolicy) => http<{ policy: AiEvaluationRetentionPolicy }>("/api/admin/ai-evaluations/retention", { method: "PUT", body: JSON.stringify(policy) }),
  previewAiEvaluationRetention: () => http<{ id: string; expiresAt: string; confirmationToken: string; candidates: Array<{ id: string; datasetId: string; datasetVersion: number; executionMode: AiEvaluationMode; reason: string; estimatedMetricCount: number; estimatedIssueCount: number }>; protectedCount: number; estimatedDeletedMetrics: number; estimatedDeletedIssues: number }>("/api/admin/ai-evaluations/retention/preview", { method: "POST" }),
  runAiEvaluationRetention: (input: { previewId: string; confirmationToken: string }) => http<{ deleted: number }>("/api/admin/ai-evaluations/retention/run", { method: "POST", body: JSON.stringify(input) }),
  listAiEvaluationSchedules: () => http<{ schedulerEnabled: boolean; schedules: AiEvaluationSchedule[] }>("/api/admin/ai-evaluation-schedules"),
  createAiEvaluationSchedule: (input: Omit<AiEvaluationSchedule, "id" | "createdAt" | "updatedAt">) => http<{ schedule: AiEvaluationSchedule }>("/api/admin/ai-evaluation-schedules", { method: "POST", body: JSON.stringify(input) }),
  updateAiEvaluationSchedule: (id: string, input: Partial<Omit<AiEvaluationSchedule, "id" | "createdAt" | "updatedAt">>) => http<{ schedule: AiEvaluationSchedule }>(`/api/admin/ai-evaluation-schedules/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteAiEvaluationSchedule: (id: string) => http<{ deleted: boolean }>(`/api/admin/ai-evaluation-schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listAiEvaluationAlerts: (status?: string) => http<{ alerts: AiEvaluationAlert[] }>(`/api/admin/ai-evaluation-alerts${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  acknowledgeAiEvaluationAlert: (id: string) => http<{ alert: AiEvaluationAlert }>(`/api/admin/ai-evaluation-alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }),
  resolveAiEvaluationAlert: (id: string) => http<{ alert: AiEvaluationAlert }>(`/api/admin/ai-evaluation-alerts/${encodeURIComponent(id)}/resolve`, { method: "POST" }),
  listAiProviders: () => http<{ providers: Array<{
    id: string;
    provider: "openai" | "gemini" | "kimi" | "qwen" | "zai";
    slug: string;
    displayName: string;
    baseUrl: string | null;
    model: string | null;
    enabled: boolean;
    isDefault: boolean;
    isRouterProvider: boolean;
    priority: number;
    createdAt: string;
    updatedAt: string;
  }> }>("/api/admin/ai-providers"),
  saveAiProvider: (input: Record<string, unknown>) => http<{ provider: unknown; code?: string }>("/api/admin/ai-providers", { method: "POST", body: JSON.stringify(input) }),
  updateAiProvider: (input: Record<string, unknown>) => http<{ provider: unknown; code?: string }>("/api/admin/ai-providers", { method: "PUT", body: JSON.stringify(input) }),
  deleteAiProvider: (id: string) => http<void>(`/api/admin/ai-providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listAiCredentials: (providerId: string) => http<{ credentials: Array<{
    id: string;
    providerConfigId: string;
    name: string;
    maskedApiKey: string;
    baseUrl: string | null;
    model: string | null;
    status: "active" | "standby" | "disabled";
    priority: number;
    weight: number;
    failureCount: number;
    cooldownUntil: string | null;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
    lastTestLatencyMs: number | null;
    createdAt: string;
    updatedAt: string;
    disabledAt: string | null;
    billingMode: "pay_as_you_go" | "token_plan_personal" | "token_plan_team" | "unknown";
    region: string | null;
    endpointProfile: string | null;
    usageScope: "development_interactive" | "staging" | "production" | "unknown";
    productionAuthorized: boolean;
    providerHealth: "healthy" | "authentication_error" | "access_denied" | "quota_exhausted" | "rate_limited" | "degraded" | "unavailable" | "unknown";
    modelQuotas: Array<{
      id: string;
      credentialId: string;
      model: string;
      rpmLimit: number | null;
      tpmLimit: number | null;
      rpdLimit: number | null;
      requestsThisMinute: number;
      tokensThisMinute: number;
      requestsToday: number;
      minuteResetAt: string;
      dailyResetAt: string;
      resetTimezone: string;
      usageSource: "provider_response" | "system_estimated";
      enabled: boolean;
      isDefault: boolean;
      currency: string | null;
      serviceTier: string | null;
      inputPriceUsdPerMillion: number | null;
      outputPriceUsdPerMillion: number | null;
      cachedInputPriceUsdPerMillion: number | null;
      cacheStorageUsdPerMillionTokenHour: number | null;
      pricingEffectiveAt: string | null;
      pricingSource: string | null;
      pricingUnavailable: boolean | null;
      createdAt: string;
      updatedAt: string;
      remaining: { rpm: number | null; tpm: number | null; rpd: number | null };
    }>;
  }> }>(`/api/admin/ai-providers/${providerId}/credentials`),
  createAiCredential: (providerId: string, input: Record<string, unknown>) => http<{ credential: unknown }>(`/api/admin/ai-providers/${providerId}/credentials`, { method: "POST", body: JSON.stringify(input) }),
  updateAiCredential: (id: string, input: Record<string, unknown>) => http<{ credential: unknown }>(`/api/admin/ai-credentials/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  testAiCredential: (id: string) => http<CredentialTestResponse>(`/api/admin/ai-credentials/${id}/test`, { method: "POST" }),
  enableAiCredential: (id: string) => http<{ credential: unknown }>(`/api/admin/ai-credentials/${id}/enable`, { method: "POST" }),
  disableAiCredential: (id: string) => http<{ credential: unknown }>(`/api/admin/ai-credentials/${id}/disable`, { method: "POST" }),
  deleteAiCredential: (id: string) => http<void>(`/api/admin/ai-credentials/${id}`, { method: "DELETE" }),
  listAiCredentialQuotas: (id: string) => http<{ quotas: Array<Record<string, unknown>> }>(`/api/admin/ai-credentials/${id}/quotas`),
  createAiCredentialQuota: (id: string, input: Record<string, unknown>) => http<{ quota: unknown }>(`/api/admin/ai-credentials/${id}/quotas`, { method: "POST", body: JSON.stringify(input) }),
  updateAiCredentialQuota: (id: string, input: Record<string, unknown>) => http<{ quota: unknown }>(`/api/admin/ai-credential-quotas/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  setDefaultAiCredentialQuota: (id: string) => http<{ quota: unknown }>(`/api/admin/ai-credential-quotas/${id}/default`, { method: "POST" }),
  deleteAiCredentialQuota: (id: string) => http<void>(`/api/admin/ai-credential-quotas/${id}`, { method: "DELETE" }),
  listBooks: () => http<{ books: Book[] }>("/api/admin/books"),

  createBook: (input: CreateBookInput) =>
    http<{ book: Book }>("/api/admin/books", {
      method: "POST",
      body: JSON.stringify(input)
    }),

  getBook: (bookId: string) =>
    http<{ book: Book; chapters: BookChapter[]; files: BookFile[] }>(
      `/api/admin/books/${bookId}`
    ),

  importReaderToc: (bookId: string, payload: ReaderTocImportPayload) =>
    http<ReaderTocResponse>(`/api/admin/books/${bookId}/reader-toc/import`, {
      method: "POST",
      body: JSON.stringify(payload)
    }),

  getReaderToc: (bookId: string) => http<ReaderTocResponse>(`/api/admin/books/${bookId}/reader-toc`),

  generateReaderTocFromJsonIndex: (
    bookId: string,
    jsonIndexFileId: string,
    pageStart: number,
    pageEnd: number
  ) =>
    http<GenerateReaderTocResponse>(
      `/api/admin/books/${bookId}/reader-toc/generate-from-json-index`,
      { method: "POST", body: JSON.stringify({ jsonIndexFileId, pageStart, pageEnd }) }
    ),

  deleteReaderToc: (bookId: string) =>
    http<{ deleted: number }>(`/api/admin/books/${bookId}/reader-toc`, {
      method: "DELETE"
    }),

  updateBook: (bookId: string, input: UpdateBookInput) =>
    http<{ book: Book }>(`/api/admin/books/${bookId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),

  uploadFile: (bookId: string, file: File, options?: UploadBookFileOptions) => {
    const form = new FormData();
    form.append("file", file);
    form.append("displayName", file.name);
    if (options?.role) form.append("role", options.role);
    if (options?.relatedFileId) form.append("relatedFileId", options.relatedFileId);
    return http<{ file: BookFile }>(`/api/admin/books/${bookId}/files`, {
      method: "POST",
      body: form
    });
  },

  deleteFile: (bookId: string, fileId: string) =>
    http<{ deleted: boolean }>(`/api/admin/books/${bookId}/files/${fileId}`, {
      method: "DELETE"
    }),

  parseContent: (bookId: string, fileId: string) =>
    http<{ parsed: number; pageCount: number }>(
      `/api/admin/books/${bookId}/files/${fileId}/parse-content`,
      { method: "POST" }
    ),

  parseOutlinePreview: (bookId: string, fileId: string) =>
    http<{ parsed: number; pageCount: number; rows: ChapterPreviewRow[] }>(
      `/api/admin/books/${bookId}/files/${fileId}/outline-preview`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  generateJsonIndex: (bookId: string, fileId: string, level: GeneratePdfJsonIndexInput["level"]) =>
    http<{ index: PdfJsonIndex }>(`/api/admin/books/${bookId}/files/${fileId}/generate-json-index`, {
      method: "POST",
      body: JSON.stringify({ level })
    }),

  applyChapterPreview: (bookId: string, fileId: string, rows: ChapterPreviewRow[]) =>
    http<{ applied: number; skipped: number; linked: number; chapters: AdminChapter[] }>(
      `/api/admin/books/${bookId}/files/${fileId}/apply-chapters`,
      { method: "POST", body: JSON.stringify({ rows }) }
    ),

  saveJsonIndex: (
    bookId: string,
    fileId: string,
    level: GeneratePdfJsonIndexInput["level"],
    setActive = false
  ) =>
    http<{ index: StoredJsonIndexSummary }>(
      `/api/admin/books/${bookId}/files/${fileId}/save-json-index`,
      { method: "POST", body: JSON.stringify({ level, setActive }) }
    ),

  uploadJsonIndex: (bookId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http<{ index: StoredJsonIndexSummary }>(
      `/api/admin/books/${bookId}/json-indexes/upload`,
      { method: "POST", body: form }
    );
  },

  listJsonIndexes: (bookId: string) =>
    http<{ indexes: StoredJsonIndexSummary[]; activeId: string | null }>(
      `/api/admin/books/${bookId}/json-indexes`
    ),

  setActiveQaReference: (bookId: string, indexFileId: string) =>
    http<{ activeId: string; index: StoredJsonIndexSummary }>(
      `/api/admin/books/${bookId}/json-indexes/${indexFileId}/set-active-qa-reference`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  getJsonIndexRawUrl: (bookId: string, indexFileId: string) =>
    `/api/admin/books/${bookId}/json-indexes/${indexFileId}/raw`,

  deleteJsonIndex: (bookId: string, indexFileId: string) =>
    http<{ deleted: boolean }>(`/api/admin/books/${bookId}/json-indexes/${indexFileId}`, {
      method: "DELETE"
    }),

  getBookFileUrl: (bookId: string, fileId: string) =>
    `/api/admin/books/${bookId}/files/${fileId}/raw`,

  getContents: (bookId: string) =>
    http<{ contents: BookContent[] }>(`/api/admin/books/${bookId}/contents`),

  clearContents: (bookId: string) =>
    http<{ cleared: boolean }>(`/api/admin/books/${bookId}/contents`, {
      method: "DELETE"
    }),

  getChapters: (bookId: string) =>
    http<{ chapters: AdminChapter[] }>(`/api/admin/books/${bookId}/chapters`),

  generateChapters: (bookId: string) =>
    http<{ chapters: AdminChapter[] }>(`/api/admin/books/${bookId}/chapters/build`, {
      method: "POST",
      body: JSON.stringify({})
    }),

  linkChapterContent: (bookId: string) =>
    http<{ linked: number; chapters: AdminChapter[] }>(
      `/api/admin/books/${bookId}/chapters/link-content`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  createChapter: (bookId: string, input: ChapterInput) =>
    http<{ chapter: BookChapter }>(`/api/admin/books/${bookId}/chapters`, {
      method: "POST",
      body: JSON.stringify(input)
    }),

  updateChapter: (bookId: string, chapterId: string, input: Partial<ChapterInput>) =>
    http<{ chapter: BookChapter }>(`/api/admin/books/${bookId}/chapters/${chapterId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),

  deleteChapter: (bookId: string, chapterId: string) =>
    http<{ deleted: boolean }>(`/api/admin/books/${bookId}/chapters/${chapterId}`, {
      method: "DELETE"
    }),

  summarizeChapter: (bookId: string, chapterId: string) =>
    http<{ chapter: BookChapter }>(
      `/api/admin/books/${bookId}/chapters/${chapterId}/ai/summarize`,
      { method: "POST", body: JSON.stringify({}) }
    ),

  ask: (bookId: string, question: string) =>
    http<{ answer: string; context: string[]; log: BookQaLog }>(
      `/api/admin/books/${bookId}/qa`,
      { method: "POST", body: JSON.stringify({ question }) }
    ),

  importQaMarkdown: (bookId: string, markdown: string) =>
    http<{ imported: number; logs: BookQaLog[] }>(
      `/api/admin/books/${bookId}/qa/import-markdown`,
      { method: "POST", body: JSON.stringify({ markdown }) }
    ),

  getQaLogs: (bookId: string) =>
    http<{ logs: BookQaLog[] }>(`/api/admin/books/${bookId}/qa-logs`),

  getJobs: (bookId: string) =>
    http<{ jobs: BookAiJob[] }>(`/api/admin/books/${bookId}/ai-jobs`),

  getDashboardStats: (range: DashboardRange = "month") =>
    http<AdminDashboardStats>(`/api/admin/dashboard/stats?range=${range}`),

  listAccounts: () => http<{ accounts: AdminAccount[] }>("/api/admin/accounts"),

  setAccountRisk: (sessionId: string, riskLevel: RiskLevel, note?: string | null) =>
    http<{ account: AdminAccount | null }>(`/api/admin/accounts/${sessionId}/risk`, {
      method: "PATCH",
      body: JSON.stringify({ riskLevel, note: note ?? null })
    }),

  blockAccount: (sessionId: string, reason?: string | null) =>
    http<{ account: AdminAccount | null }>(`/api/admin/accounts/${sessionId}/block`, {
      method: "PATCH",
      body: JSON.stringify({ blocked: true, reason: reason ?? null })
    }),

  unblockAccount: (sessionId: string) =>
    http<{ account: AdminAccount | null }>(`/api/admin/accounts/${sessionId}/block`, {
      method: "PATCH",
      body: JSON.stringify({ blocked: false })
    }),

  listStudentQuestions: () =>
    http<{ questions: StudentQuestion[] }>("/api/admin/student-questions"),

  deleteStudentQuestion: (id: string) =>
    http<{ deleted: boolean }>(`/api/admin/student-questions/${id}`, { method: "DELETE" }),

  deleteStudentQuestions: (ids: string[]) =>
    http<{ deleted: number }>("/api/admin/student-questions/delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    }),

  getAppearanceSettings: () =>
    http<{ settings: AppearanceSettings }>("/api/appearance-settings"),

  updateAppearanceSettings: (input: AppearanceSettingsUpdate) =>
    http<{ settings: AppearanceSettings }>("/api/admin/appearance-settings", {
      method: "PUT",
      body: JSON.stringify(input)
    }),

  uploadAppearanceImage: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http<{ url: string }>("/api/admin/appearance-settings/upload", {
      method: "POST",
      body: form
    });
  },

  getSiteConfig: () =>
    http<{ config: SiteConfig }>("/api/admin/site-config"),

  updateSiteConfig: (input: SiteConfigUpdate) =>
    http<{ config: SiteConfig; updatedAt: string }>("/api/admin/site-config", {
      method: "PUT",
      body: JSON.stringify(input)
    }),

  getAiAnalyticsSummary: (date?: string) => {
    const qs = date ? `?date=${encodeURIComponent(date)}` : "";
    return http<AiAnalyticsSummary>(`/api/admin/ai-analytics/summary${qs}`);
  },

  getAiAnalyticsDaily: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return http<AiAnalyticsDailyRow[]>(`/api/admin/ai-analytics/daily${tail}`);
  },

  getAiAnalyticsProviders: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return http<AiAnalyticsProviderRow[]>(`/api/admin/ai-analytics/providers${tail}`);
  },

  getAiAnalyticsSubjects: (from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return http<AiAnalyticsSubjectRow[]>(`/api/admin/ai-analytics/subjects${tail}`);
  },

  listAiRequests: (query: AiRequestLogQuery = {}) => {
    const qs = new URLSearchParams();
    if (query.from) qs.set("from", query.from);
    if (query.to) qs.set("to", query.to);
    if (query.provider) qs.set("provider", query.provider);
    if (query.model) qs.set("model", query.model);
    if (query.subject) qs.set("subject", query.subject);
    if (query.status) qs.set("status", query.status);
    if (query.requestSource) qs.set("requestSource", query.requestSource);
    if (query.page) qs.set("page", String(query.page));
    if (query.limit) qs.set("limit", String(query.limit));
    if (query.sort) qs.set("sort", query.sort);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return http<AiRequestLogPage>(`/api/admin/ai-requests${tail}`);
  },

  getAiRequestDetail: (requestId: string) =>
    http<AiRequestLogDetail>(`/api/admin/ai-requests/${encodeURIComponent(requestId)}`),

  getAiUsageDetail: (requestId: string) =>
    http<AiUsageDetail>(`/api/admin/ai-usage/${encodeURIComponent(requestId)}`),

  listAiEvaluations: (query: { datasetId?: string; executionMode?: AiEvaluationMode; status?: AiEvaluationStatus; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    return http<{ runs: AiEvaluationRun[]; total: number; limit: number; offset: number }>(`/api/admin/ai-evaluations${suffix}`);
  },
  getAiEvaluation: (id: string) => http<AiEvaluationDetail>(`/api/admin/ai-evaluations/${encodeURIComponent(id)}`),
  startAiEvaluation: (input: { datasetId: string; executionMode: "fixture" | "mock_orchestrator"; baselineRunId?: string }, idempotencyKey: string) =>
    http<{ run: AiEvaluationRun; reused: boolean }>("/api/admin/ai-evaluations/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input)
    }),
  deleteAiEvaluation: (id: string) =>
    http<{ deleted: boolean; alreadyDeleted: boolean }>(`/api/admin/ai-evaluations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "x-confirm-delete": "true" }
    }),
  downloadAiEvaluationReport: async (id: string, format: "json" | "markdown") => {
    const response = await fetch(`/api/admin/ai-evaluations/${encodeURIComponent(id)}/report?format=${format}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiHttpError(response.status, data.error ?? "報告下載失敗");
    }
    return response.blob();
  },

  listAiBudgetPolicies: () =>
    http<{ policies: AiBudgetPolicyRow[] }>("/api/admin/ai-budget-policies"),

  updateAiBudgetPolicy: (id: string, input: AiBudgetPolicyUpdate) =>
    http<{ policy: AiBudgetPolicyRow }>(`/api/admin/ai-budget-policies/${id}`, {
      method: "PUT",
      body: JSON.stringify(input)
    }),

  listAiTokenPools: () =>
    http<{ pools: AiTokenPoolRow[] }>("/api/admin/ai-token-pools"),

  createAiTokenPool: (input: Record<string, unknown>) =>
    http<{ pool: AiTokenPoolRow }>("/api/admin/ai-token-pools", {
      method: "POST",
      body: JSON.stringify(input)
    }),

  updateAiTokenPool: (id: string, input: Record<string, unknown>) =>
    http<{ pool: AiTokenPoolRow }>(`/api/admin/ai-token-pools/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),

  listAiLogicalModels: () =>
    http<{ logicalModels: AiLogicalModelRow[] }>("/api/admin/ai-logical-models"),

  upsertAiLogicalModel: (input: Record<string, unknown>) =>
    http<{ logicalModel: AiLogicalModelRow }>("/api/admin/ai-logical-models", {
      method: "POST",
      body: JSON.stringify(input)
    }),

  updateAiLogicalModel: (logicalModelId: string, input: Record<string, unknown>) =>
    http<{ logicalModel: AiLogicalModelRow }>(`/api/admin/ai-logical-models/${encodeURIComponent(logicalModelId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),

  listAiModelLimits: () =>
    http<{ modelLimits: AiModelDailyLimitRow[] }>("/api/admin/ai-model-limits"),

  updateAiModelLimit: (logicalModelId: string, input: Record<string, unknown>) =>
    http<{ modelLimit: AiModelDailyLimitRow }>(`/api/admin/ai-model-limits/${encodeURIComponent(logicalModelId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),

  getAiTokenUsageToday: () =>
    http<AiTokenUsageToday>("/api/admin/ai-token-usage/today"),

  getAiTokenUsageModels: () =>
    http<{ models: AiModelDailyLimitRow[] }>("/api/admin/ai-token-usage/models"),

  getOpenAiCredentialDailyUsage: () =>
    http<OpenAiCredentialDailyUsageResponse>("/api/admin/ai-quota-center/openai-credentials"),

  getOpenAiCredentialDailyDetail: (credentialId: string) =>
    http<OpenAiCredentialDailyDetail>(`/api/admin/ai-quota-center/openai-credentials/${credentialId}`),

  updateOpenAiCredentialDailyLimit: (credentialId: string, input: OpenAiCredentialDailyLimitPatch) =>
    http<{ limit: OpenAiCredentialDailyLimitRow }>(`/api/admin/ai-quota-center/openai-credentials/${credentialId}/daily-limit`, {
      method: "PUT",
      body: JSON.stringify(input)
    })

};

export type DashboardRange = "week" | "month" | "all";

export interface DailyConversationPoint {
  date: string;
  count: number;
}

export interface AdminDashboardStats {
  totalUsers: number;
  activeUsers: number;
  totalConversations: number;
  totalMessages: number;
  dailyConversations: DailyConversationPoint[];
}

export type RiskLevel = "safe" | "risk" | "dangerous";

export interface AdminAccount {
  id: string;
  sessionId: string;
  name: string;
  loginMethod: string;
  osName: string;
  deviceType: string;
  browserName: string;
  ipAddress: string | null;
  ipLocation: string;
  riskLevel: RiskLevel;
  riskNote: string | null;
  isBlocked: boolean;
  blockedReason: string | null;
  blockedAt: string | null;
  lastSeenAt: string;
  online: boolean;
}

export interface StudentQuestion {
  id: string;
  sessionId: string;
  student: string;
  subject: string;
  content: string;
  createdAt: string;
}

export interface AiAnalyticsSummary {
  date: string;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  fallbackCount: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostMicroUsd: number;
  topProvider: string | null;
  topSubject: string | null;
  budgetUtilisationPercentage: number;
}

export interface AiAnalyticsDailyRow {
  date: string;
  requestCount: number;
  successCount: number;
  failedCount: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  avgLatencyMs: number;
}

export interface AiAnalyticsProviderRow {
  provider: string;
  requestCount: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  avgLatencyMs: number;
}

export interface AiAnalyticsSubjectRow {
  subject: string;
  requestCount: number;
}

export interface AiRequestLogRow {
  id: string;
  requestId: string;
  requestSource: string;
  questionPreview: string;
  answerPreview: string;
  subject: string;
  taskType: string;
  complexity: string;
  routingProvider: string;
  routingModel: string | null;
  providerAttempts: string[];
  status: string;
  errorCode: string | null;
  fallbackReason: string | null;
  latencyMs: number;
  createdAt: string;
  totalTokens?: number | null;
  estimatedCostMicroUsd?: number;
}

export interface AiUsageDetail {
  requestId: string;
  createdAt: string;
  mode: string;
  status: string;
  fallbackReason: string | null;
  latencyMs: number;
  provider: string;
  model: string;
  finishReason: string | null;
  questionText: string;
  answerText: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
  inputCostMicrousd: number;
  cachedInputCostMicrousd: number;
  outputCostMicrousd: number;
  totalCostMicrousd: number;
  usageSource: string | null;
  pricingSource: string | null;
  pricingVersion: string | null;
  pricingSnapshot: unknown;
}

export interface AiRequestLogDetail extends AiRequestLogRow {
  questionLength: number;
  routingReason: string;
  usage?: {
    provider: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    estimatedCostMicroUsd: number;
    finishReason: string | null;
  };
}

export interface AiRequestLogPage {
  rows: AiRequestLogRow[];
  total: number;
  page: number;
  limit: number;
}

export interface AiBudgetPolicyRow {
  id: string;
  scopeType: string;
  scopeKey: string;
  dailyTokenLimit: number;
  dailyCostLimitMicroUsd: number;
  warningPercentage: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiBudgetPolicyUpdate {
  dailyTokenLimit?: number;
  dailyCostLimitUsd?: number;
  warningPercentage?: number;
  enabled?: boolean;
}

export interface AiTokenPoolRow {
  id: string;
  name: string;
  poolType: string;
  timezone: string;
  dailyLimit: number;
  usedTokens: number;
  reservedTokens: number;
  committedTokens: number;
  remaining: number;
  utilizationRatio: number;
  warningThreshold: number;
  throttleThreshold: number;
  criticalThreshold: number;
  resetAt: string;
  enabled: boolean;
  unallocatedCapacity?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiLogicalModelRow {
  id: string;
  logicalModelId: string;
  providerId: string;
  providerModelName: string;
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number;
  supportsThinking: boolean;
  tokenizerType: string | null;
  tokenizerVersion: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiModelDailyLimitRow {
  id: string;
  logicalModelId: string;
  poolId: string;
  dailyLimit: number;
  usedTokens: number;
  reservedTokens: number;
  priority: number;
  fallbackLogicalModelId: string | null;
  enabled: boolean;
  allowSecondModelVerification: boolean;
  committedTokens?: number;
  remaining?: number;
  utilizationRatio?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiTokenUsageModelRow {
  logicalModelId: string;
  poolId: string;
  dailyLimit: number;
  usedTokens: number;
  reservedTokens: number;
  committedTokens: number;
  remaining: number;
  utilizationRatio: number;
  priority: number;
  fallbackLogicalModelId: string | null;
  enabled: boolean;
  allowSecondModelVerification: boolean;
}

export interface AiTokenUsageToday {
  date: string;
  pools: AiTokenPoolRow[];
  models: AiTokenUsageModelRow[];
}

// ---- OpenAI Credential daily quota (per-key independent daily ledger) ----
export interface OpenAiCredentialDailyLimitRow {
  id: string;
  credentialId: string;
  dailyTokenLimit: number | null;
  dailyCostLimitMicroUsd: number | null;
  timezone: string;
  warningThreshold: number;
  enabled: boolean;
  resetAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenAiCredentialDailyUsageRow {
  credentialId: string;
  instanceName: string | null;
  name: string;
  maskedApiKey: string;
  status: string;
  cooldownUntil: string | null;
  dailyTokenLimit: number | null;
  dailyCostLimitMicroUsd: number | null;
  timezone: string;
  limitEnabled: boolean;
  usedTokens: number;
  reservedTokens: number;
  remainingTokens: number | null;
  utilizationRatio: number;
  requestCount: number;
  actualCostMicroUsd: number;
  costSource: "priced" | "unconfigured";
  providerModel: string | null;
  resetAt: string | null;
  lastUsedAt: string | null;
}

export interface OpenAiCredentialDailyUsageResponse {
  date: string;
  credentials: OpenAiCredentialDailyUsageRow[];
  poolSummary: {
    label: string;
    credentialCount: number;
    usedTokens: number;
    reservedTokens: number;
    requestCount: number;
    actualCostMicroUsd: number;
    isAggregate: boolean;
  };
}

export interface OpenAiCredentialDailyDetail {
  credentialId: string;
  name: string;
  maskedApiKey: string;
  limit: OpenAiCredentialDailyLimitRow | undefined;
  usage: Record<string, unknown> | null;
  latestReservation: Record<string, unknown> | null;
}

export interface OpenAiCredentialDailyLimitPatch {
  dailyTokenLimit?: number | null;
  dailyCostLimitMicroUsd?: number | null;
  timezone?: string;
  warningThreshold?: number;
  enabled?: boolean;
}

export type AiRequestLogSort = "newest" | "oldest" | "latency";

export interface AiRequestLogQuery {
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
  subject?: string;
  status?: string;
  requestSource?: string;
  page?: number;
  limit?: number;
  sort?: AiRequestLogSort;
}
