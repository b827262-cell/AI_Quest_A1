import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AiGateway,
  MultiModelOrchestrator,
  MultiModelOrchestratorEvaluationAdapter,
  type EvaluationCase,
  evaluateLivePreflight,
  evaluateCredentialEligibility,
  formalContextWindow,
  validateQwenEndpoint,
  parseEvaluationDataset,
  runLiveEvaluation,
  validateLiveEvaluationSettings,
  type EvaluationReport,
  type AiProviderId,
  type LiveEvaluationSettings
} from "@ai-smartbook/ai";
import type { Repositories } from "@ai-smartbook/db";
import { safeEvaluationError, safeEvaluationIssueSummary } from "./evaluation-redaction";
import { createTokenPoolPort } from "./token-pool-adapter";
import { EvaluationBudgetManager, taipeiDateKey } from "./live-budget-manager";
import { createEvaluationProvider } from "./live-provider";

const DATASET_ID = "phase-4a-core";
const DATASET_FILE = resolve(new URL("../../../../../packages/ai/evals/datasets/phase-4a-core.json", import.meta.url).pathname);
const MAX_SERVER_CASES = 100;
const PREFLIGHT_TTL_MS = 5 * 60_000;

export class LiveEvaluationServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "LiveEvaluationServiceError"; }
}

export interface LivePreflightRequest {
  adminId: string;
  datasetId: string;
  maxCases: number;
  maxTokenBudget: number;
  logicalModelIds: string[];
}

export interface StartLiveEvaluationRequest extends LivePreflightRequest {
  dryRunId: string;
  confirmationToken: string;
  baselineRunId?: string;
  idempotencyKey: string;
}

function readDataset() { return parseEvaluationDataset(JSON.parse(readFileSync(DATASET_FILE, "utf8")) as unknown); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function jsonList(value: string | null): string[] { try { const parsed: unknown = JSON.parse(value ?? "[]"); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; } catch { return []; } }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function sameModelSet(left: string[], right: string[]): boolean { return JSON.stringify(unique(left).sort()) === JSON.stringify(unique(right).sort()); }
function safeId(value: string): boolean { return /^[A-Za-z0-9._:-]{8,128}$/.test(value); }

function liveMetricInputs(summary: EvaluationReport["summary"]) {
  const dimensions: Array<["category" | "difficulty" | "outcome" | "confidence", Record<string, { count: number; passed: number; passRate: number; averageScore: number }>]> = [
    ["category", summary.byCategory], ["difficulty", summary.byDifficulty], ["outcome", summary.byOutcome], ["confidence", summary.byConfidence]
  ];
  return dimensions.flatMap(([dimension, groups]) => Object.entries(groups).map(([dimensionValue, group]) => ({ dimension, dimensionValue, ...group })));
}

function liveIssueInputs(dataset: { cases: EvaluationCase[] }, results: EvaluationReport["results"]) {
  const cases = new Map(dataset.cases.map((testCase) => [testCase.id, testCase]));
  return results.filter((result) => !result.passed).flatMap((result) => result.issues.slice(0, 8).map((issue) => ({
    caseId: result.caseId,
    category: result.category,
    expectedKind: cases.get(result.caseId)?.expected.kind ?? "unknown",
    score: result.score,
    code: issue.code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80) || "evaluation_issue",
    severity: issue.severity,
    safeSummary: safeEvaluationIssueSummary(issue.message)
  })));
}

function settingsFromRow(row: ReturnType<Repositories["aiEvaluationControl"]["getSettings"]>): LiveEvaluationSettings {
  if (!row) return { enabled: false, allowedDatasetIds: [], allowedLogicalModelIds: [], allowedProviderIds: [], maxCasesPerRun: 0, maxTokensPerRun: 0, maxTokensPerDay: 0, maxConcurrentRuns: 1, requireDryRun: true, requireExplicitConfirmation: true, updatedAt: "" };
  return { enabled: row.enabled, evaluationPoolId: row.evaluationPoolId ?? undefined, allowedDatasetIds: row.allowedDatasetIds, allowedLogicalModelIds: row.allowedLogicalModelIds, allowedProviderIds: row.allowedProviderIds, maxCasesPerRun: row.maxCasesPerRun, maxTokensPerRun: row.maxTokensPerRun, maxTokensPerDay: row.maxTokensPerDay, maxConcurrentRuns: row.maxConcurrentRuns, requireDryRun: row.requireDryRun, requireExplicitConfirmation: row.requireExplicitConfirmation, updatedAt: row.updatedAt, updatedByAdminId: row.updatedByAdminId ?? undefined };
}

function evaluationCredentialAvailable(repos: Repositories, providerId: string, logicalModelId: string): boolean {
  const mapping = repos.aiLogicalModels.findEnabled(logicalModelId);
  const config = mapping?.providerConfigId
    ? repos.aiProviders.findConfig(mapping.providerConfigId)
    : repos.aiProviders.findConfigByProvider(providerId as "openai" | "gemini" | "kimi" | "qwen" | "zai");
  if (!config || !mapping) return false;
  return repos.aiProviders.listCredentials(config.id).some((credential) => {
    const endpointValid = providerId !== "qwen" || validateQwenEndpoint({ baseUrl: credential.baseUrl ?? config.baseUrl, region: credential.region ?? undefined, endpointProfile: credential.endpointProfile ?? undefined }).ok;
    const result = evaluateCredentialEligibility({
      providerId,
      billingMode: credential.billingMode as "pay_as_you_go" | "token_plan_personal" | "token_plan_team" | "unknown",
      usageScope: credential.usageScope as "development_interactive" | "staging" | "production" | "unknown",
      providerHealth: credential.providerHealth as "healthy" | "authentication_error" | "access_denied" | "quota_exhausted" | "rate_limited" | "degraded" | "unavailable" | "unknown",
      status: credential.status as "active" | "standby" | "disabled",
      deleted: Boolean(credential.deletedAt),
      allowEvaluation: credential.allowEvaluation,
      evaluationAuthorized: Boolean(credential.evaluationAuthorizedAt),
      regionValid: endpointValid,
      endpointValid
    });
    return result.allowed && repos.aiCredentialModelQuotas.modelsForCredential(credential.id).some((quota) => quota.enabled && quota.model === mapping.providerModelName);
  });
}

function modelPoolPort(repos: Repositories) {
  const production = createTokenPoolPort(repos);
  return {
    listEnabledLogicalModels: () => production.listEnabledLogicalModels(),
    findEnabledLogicalModel: (id: string) => production.findEnabledLogicalModel(id),
    // Live traffic is governed by EvaluationBudgetManager, never formal pool rows.
    findModelDailyLimit: () => undefined,
    findTokenPool: () => undefined,
    reservePool: () => ({ allowed: false, utilizationRatio: 0, reason: "evaluation_pool_only" }),
    settlePool: () => undefined,
    releasePool: () => undefined
  };
}

export function makeLiveEvaluationService(
  repos: Repositories,
  audit: (action: string, targetId: string, metadata: Record<string, unknown>) => void
) {
  const runs = repos.aiEvaluationRuns;

  function getSettings() { return settingsFromRow(repos.aiEvaluationControl.getSettings()); }

  /** Gate 1 status only. This is a safe policy snapshot; it never returns credential data. */
  function readiness() {
    const settings = getSettings();
    const models = settings.allowedLogicalModelIds.map((id) => repos.aiLogicalModels.findEnabled(id));
    const validModels = models.filter((model): model is NonNullable<typeof model> => Boolean(model));
    const providers = [...new Set(validModels.map((model) => model.providerId))];
    const datasetAllowed = settings.allowedDatasetIds.includes(DATASET_ID);
    const pool = settings.evaluationPoolId ? repos.aiEvaluationControl.findPool(settings.evaluationPoolId) : undefined;
    const budgetReady = settings.maxCasesPerRun > 0 && settings.maxTokensPerRun > 0 && settings.maxTokensPerDay > 0
      && settings.maxTokensPerRun <= settings.maxTokensPerDay;
    const allowlistReady = datasetAllowed && validModels.length === settings.allowedLogicalModelIds.length && validModels.length > 0
      && providers.length > 0 && providers.every((provider) => settings.allowedProviderIds.includes(provider))
      && validModels.every((model) => formalContextWindow(model.contextWindowTokens) !== undefined && model.contextWindowTokens > 0);
    const credentialReady = allowlistReady && validModels.every((model) => evaluationCredentialAvailable(repos, model.providerId, model.logicalModelId));
    const evaluationPoolReady = Boolean(pool?.enabled && pool.trafficClass === "evaluation" && settings.evaluationPoolId);
    const blockers: string[] = [];
    if (!credentialReady) blockers.push("credential_not_ready");
    if (!evaluationPoolReady) blockers.push("evaluation_pool_not_ready");
    if (!budgetReady) blockers.push("evaluation_budget_not_ready");
    if (!allowlistReady) blockers.push("server_allowlist_not_ready");
    if (!settings.enabled) blockers.push("live_evaluation_disabled");
    return {
      ready: blockers.length === 0,
      credentialReady,
      evaluationPoolReady,
      budgetReady,
      allowlistReady,
      liveEnabled: settings.enabled,
      blockers: [...new Set(blockers)],
      warnings: ["live_smoke_test_not_completed"],
      checkedAt: new Date().toISOString(),
      datasetId: DATASET_ID,
      datasetVersion: 1,
      providerIds: providers,
      logicalModelIds: settings.allowedLogicalModelIds,
      evaluationPoolConfigured: Boolean(settings.evaluationPoolId)
    };
  }

  function saveSettings(input: LiveEvaluationSettings, adminId: string) {
    if (input.maxCasesPerRun > MAX_SERVER_CASES) throw new LiveEvaluationServiceError("max_cases_server_limit", "Max Cases 超過 Server 上限", 400);
    const errors = validateLiveEvaluationSettings(input);
    if (errors.length) throw new LiveEvaluationServiceError("invalid_live_settings", "Live 評測設定不符合安全限制", 400);
    if (input.allowedDatasetIds.some((id) => id !== DATASET_ID)) throw new LiveEvaluationServiceError("dataset_not_allowed", "Dataset 不在 Server Allowlist", 400);
    const managedProviders = new Set(["openai", "gemini", "kimi", "qwen", "zai"]);
    if (input.allowedProviderIds.some((id) => !managedProviders.has(id))) throw new LiveEvaluationServiceError("provider_not_allowed", "Provider 不在 Server Allowlist", 400);
    if (input.enabled && (!input.evaluationPoolId || !repos.aiEvaluationControl.findPool(input.evaluationPoolId)?.enabled)) throw new LiveEvaluationServiceError("evaluation_pool_required", "啟用 Live 前必須指定已啟用的 Evaluation Pool", 409);
    for (const modelId of input.allowedLogicalModelIds) {
      const mapping = repos.aiLogicalModels.findEnabled(modelId);
      if (!mapping || !input.allowedProviderIds.includes(mapping.providerId)) throw new LiveEvaluationServiceError("allowlist_model_provider_mismatch", "Logical Model 與 Provider Allowlist 不匹配", 400);
    }
    const saved = repos.aiEvaluationControl.saveSettings({ ...input, updatedByAdminId: adminId });
    audit(input.enabled ? "evaluation.live.settings_enabled" : "evaluation.live.settings_updated", "default", { status: input.enabled ? "enabled" : "disabled", datasetId: input.allowedDatasetIds[0] ?? "", executionMode: "live", runId: "" });
    return saved;
  }

  function preflight(input: LivePreflightRequest) {
    const settings = getSettings();
    const dataset = input.datasetId === DATASET_ID ? readDataset() : null;
    const modelIds = unique(input.logicalModelIds);
    const mappings = modelIds.map((id) => repos.aiLogicalModels.findEnabled(id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const providerIds = unique(mappings.map((mapping) => mapping.providerId));
    const pool = settings.evaluationPoolId ? repos.aiEvaluationControl.poolSnapshot(settings.evaluationPoolId) : undefined;
    const daily = repos.aiEvaluationControl.dailySnapshot(taipeiDateKey(), settings.maxTokensPerDay);
    const enabledCaseCount = dataset?.cases.filter((testCase) => testCase.enabled).length ?? 0;
    const requestedBudgetValid = Number.isInteger(input.maxTokenBudget) && input.maxTokenBudget > 0 && input.maxTokenBudget <= settings.maxTokensPerRun;
    const contextWindowAvailable = mappings.length > 0 && mappings.every((mapping) => formalContextWindow(mapping.contextWindowTokens) !== undefined && mapping.contextWindowTokens > 0);
    const credentialEligible = mappings.length > 0 && mappings.every((mapping) => evaluationCredentialAvailable(repos, mapping.providerId, mapping.logicalModelId));
    const concurrentRuns = runs.listRuns({ executionMode: "live", status: "running", limit: 100 }).total + runs.listRuns({ executionMode: "live", status: "pending_confirmation", limit: 100 }).total;
    const base = evaluateLivePreflight({
      settings: { ...settings, maxTokensPerRun: requestedBudgetValid ? input.maxTokenBudget : settings.maxTokensPerRun },
      datasetId: input.datasetId,
      datasetVersion: dataset?.version ?? 0,
      enabledCaseCount,
      requestedCaseCount: input.maxCases,
      logicalModelIds: modelIds,
      modelMaxOutputTokens: mappings.map((mapping) => mapping.maxOutputTokens + (dataset ? Math.max(...dataset.cases.map((testCase) => testCase.question.length), 0) : 0)),
      providerIds,
      evaluationPoolRemainingTokens: pool?.remainingTokens ?? 0,
      dailyRemainingTokens: daily.remainingTokens,
      concurrentRuns,
      contextWindowAvailable,
      credentialEligible
    });
    const blockers = [...base.blockers];
    blockers.push(...readiness().blockers);
    if (!dataset) blockers.push("dataset_not_allowed");
    if (modelIds.length === 0) blockers.push("logical_model_required");
    if (!requestedBudgetValid) blockers.push("token_budget_not_allowed");
    if (!settings.evaluationPoolId) blockers.push("evaluation_pool_not_configured");
    if (input.datasetId === DATASET_ID && input.maxCases !== 3) blockers.push("phase5a_smoke_requires_three_cases");
    const now = Date.now();
    const expiresAt = new Date(now + PREFLIGHT_TTL_MS).toISOString();
    const allowed = blockers.length === 0;
    const token = allowed ? randomBytes(32).toString("base64url") : undefined;
    const row = repos.aiEvaluationControl.createPreflight({ adminId: input.adminId, datasetId: input.datasetId, datasetVersion: dataset?.version ?? 0, selectedCaseCount: base.selectedCaseCount, maxTokenBudget: input.maxTokenBudget, logicalModelIds: modelIds, providerIds, estimatedMinimumModelCalls: base.estimatedMinimumModelCalls, estimatedMaximumModelCalls: base.estimatedMaximumModelCalls, estimatedMaximumTokens: base.estimatedMaximumTokens, evaluationPoolRemainingTokens: base.evaluationPoolRemainingTokens, dailyRemainingTokens: base.dailyRemainingTokens, blockers: [...new Set(blockers)], warnings: base.warnings, confirmationDigest: token ? digest(token) : undefined, allowed, expiresAt });
    audit(allowed ? "evaluation.live.preflight_passed" : "evaluation.live.preflight_rejected", row.id, { datasetId: input.datasetId, datasetVersion: dataset?.version ?? 0, executionMode: "live", status: allowed ? "passed" : "rejected", runId: "" });
    return { ...base, dryRunId: row.id, expiresAt, confirmationToken: token, blockers: [...new Set(blockers)], allowed };
  }

  async function start(input: StartLiveEvaluationRequest) {
    if (!safeId(input.idempotencyKey)) throw new LiveEvaluationServiceError("invalid_idempotency_key", "Idempotency Key 格式不合法", 400);
    const existing = runs.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return { run: existing, reused: true };
    const settings = getSettings();
    if (!settings.enabled) throw new LiveEvaluationServiceError("live_evaluation_disabled", "Live Evaluation 目前停用", 403);
    const preflight = repos.aiEvaluationControl.findPreflight(input.dryRunId);
    if (!preflight || !preflight.allowed || preflight.adminId !== input.adminId || !preflight.confirmationDigest || preflight.usedAt || Date.parse(preflight.expiresAt) <= Date.now()) throw new LiveEvaluationServiceError("confirmation_invalid", "Dry Run 或 Confirmation Token 無效、已過期或已使用", 409);
    if (digest(input.confirmationToken) !== preflight.confirmationDigest) throw new LiveEvaluationServiceError("confirmation_invalid", "Confirmation Token 無效", 409);
    const requestedModels = unique(input.logicalModelIds);
    if (preflight.datasetId !== input.datasetId || preflight.selectedCaseCount !== input.maxCases || preflight.maxTokenBudget !== input.maxTokenBudget || JSON.stringify(jsonList(preflight.logicalModelIdsJson)) !== JSON.stringify(requestedModels)) throw new LiveEvaluationServiceError("confirmation_mismatch", "Live 請求與 Dry Run 不一致", 409);
    if (input.baselineRunId) {
      const baseline = runs.findById(input.baselineRunId);
      if (!baseline || baseline.status !== "completed" || baseline.executionMode !== "live" || baseline.datasetId !== input.datasetId || baseline.datasetVersion !== preflight.datasetVersion || !sameModelSet(jsonList(baseline.logicalModelIdsJson), requestedModels)) throw new LiveEvaluationServiceError("baseline_not_comparable", "Live Baseline 必須使用相同 Dataset、Version、Mode 與 Logical Model Set", 409);
    }
    if (runs.listRuns({ executionMode: "live", status: "running", limit: 100 }).total >= settings.maxConcurrentRuns) throw new LiveEvaluationServiceError("concurrent_run_limit", "Live 評測已達同時執行上限", 409);
    const running = runs.findRunning(input.datasetId, preflight.datasetVersion, "live");
    if (running) throw new LiveEvaluationServiceError("evaluation_already_running", "Live 評測已有執行中 Run", 409);
    if (!repos.aiEvaluationControl.consumePreflight(preflight.id)) throw new LiveEvaluationServiceError("confirmation_replayed", "Confirmation Token 已使用", 409);
    const poolId = settings.evaluationPoolId!;
    let consumed = 0;
    const row = runs.createRun({ id: `eval-live-${Date.now()}-${randomBytes(4).toString("hex")}`, datasetId: input.datasetId, datasetVersion: preflight.datasetVersion, executionMode: "live", idempotencyKey: input.idempotencyKey, createdByAdminId: input.adminId, status: "running", maxTokenBudget: input.maxTokenBudget, dailyBudgetSnapshot: settings.maxTokensPerDay, evaluationPoolId: poolId, preflightId: preflight.id, logicalModelIds: requestedModels, providerIds: jsonList(preflight.providerIdsJson) });
    audit("evaluation.live.run_started", row.id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: "live", status: "running", runId: row.id });
    try {
      const mappings = requestedModels.map((id) => repos.aiLogicalModels.findEnabled(id)).filter((mapping): mapping is NonNullable<typeof mapping> => Boolean(mapping));
      const providers = new Map<AiProviderId, ReturnType<typeof createEvaluationProvider>>();
      for (const mapping of mappings) if (!providers.has(mapping.providerId as AiProviderId)) providers.set(mapping.providerId as AiProviderId, createEvaluationProvider(repos, mapping.providerId as "openai" | "gemini" | "kimi" | "qwen" | "zai", mapping.logicalModelId));
      const budget = new EvaluationBudgetManager({ repos, runId: row.id, poolId, maxTokensPerRun: input.maxTokenBudget, maxTokensPerDay: settings.maxTokensPerDay, getConsumedTokens: () => consumed, setConsumedTokens: (value) => { consumed = value; runs.updateConsumedTokens(row.id, consumed); }, isCancelled: () => Boolean(runs.findById(row.id)?.cancelRequestedAt) });
      const gateway = new AiGateway({ providers, requestTimeoutMs: 30_000, maxRetries: 0, maxOutputTokens: Math.max(...mappings.map((mapping) => mapping.maxOutputTokens), 1), maxInputChars: 100_000, budgetManager: budget, allowMockFallback: false, autoContinueOnLength: false });
      const orchestrator = new MultiModelOrchestrator(gateway, modelPoolPort(repos));
      const adapter = new MultiModelOrchestratorEvaluationAdapter(orchestrator, (request) => ({ requestId: request.requestId, prompt: request.testCase.question, preferredLogicalModel: requestedModels[0], verificationLogicalModel: requestedModels[1], adjudicationLogicalModel: requestedModels[2], secondModelEligible: requestedModels.length > 1, allowAdjudication: requestedModels.length > 2, requestSource: "admin" }));
      const maxQuestionChars = Math.max(...readDataset().cases.map((testCase) => testCase.question.length), 1);
      const perCaseEstimate = Math.max(1, mappings.reduce((sum, mapping) => sum + mapping.maxOutputTokens + maxQuestionChars, 0));
      const output = await runLiveEvaluation(readDataset(), { mode: "live", maxCases: input.maxCases, evaluationRunId: row.id, orchestrator: adapter, hooks: {
        shouldStop: () => Boolean(runs.findById(row.id)?.cancelRequestedAt),
        beforeCase: async () => {
          const current = runs.findById(row.id);
          if (current?.cancelRequestedAt) return { allowed: false, reason: "cancel_requested" };
          if (consumed + perCaseEstimate > input.maxTokenBudget) return { allowed: false, reason: "run_budget_exhausted" };
          return { allowed: true };
        }
      }});
      const current = runs.findById(row.id);
      if (current?.cancelRequestedAt) {
        runs.transition(row.id, "running", "cancelled");
        audit("evaluation.live.run_cancelled", row.id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: "live", status: "cancelled", runId: row.id });
        return { run: runs.findById(row.id)!, report: output.report, cancelled: true };
      }
      const status = consumed >= input.maxTokenBudget ? "budget_exhausted" : "completed";
      const summary = { totalCases: output.report.summary.totalCases, passedCases: output.report.summary.passedCases, failedCases: output.report.summary.failedCases, passRate: output.report.summary.passRate, averageScore: output.report.summary.averageScore, averageDurationMs: output.report.summary.averageDurationMs, p50DurationMs: output.report.summary.p50DurationMs, p95DurationMs: output.report.summary.p95DurationMs, totalModelCalls: output.report.summary.totalModelCalls, averageModelCalls: output.report.summary.averageModelCalls, totalInputTokens: output.report.summary.totalInputTokens, totalOutputTokens: output.report.summary.totalOutputTokens, totalTokens: output.report.summary.totalTokens, conflictRate: output.report.summary.totalCases ? (output.report.summary.byOutcome.conflict_detected?.count ?? 0) / output.report.summary.totalCases : 0, unresolvedRate: output.report.summary.totalCases ? (output.report.summary.byOutcome.unresolved?.count ?? 0) / output.report.summary.totalCases : 0, baselineRunId: input.baselineRunId ?? null, regressionIssueCount: 0 };
      runs.finalizeRun(row.id, summary, liveMetricInputs(output.report.summary), liveIssueInputs(readDataset(), output.results), new Date().toISOString(), status);
      audit(`evaluation.live.run.${status}`, row.id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: "live", status, runId: row.id });
      return { run: runs.findById(row.id)!, report: output.report, cancelled: false };
    } catch (error) {
      const current = runs.findById(row.id);
      if (current?.status === "running") runs.transition(row.id, "running", "failed");
      audit("evaluation.live.run_failed", row.id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: "live", status: "failed", runId: row.id });
      throw new LiveEvaluationServiceError("live_evaluation_failed", safeEvaluationError(error), 500);
    }
  }

  function cancel(id: string) {
    const row = runs.findById(id);
    if (!row) throw new LiveEvaluationServiceError("evaluation_not_found", "評測紀錄不存在", 404);
    if (row.executionMode !== "live") throw new LiveEvaluationServiceError("live_only", "只有 Live Run 可取消", 409);
    const updated = runs.requestCancel(id);
    if (!updated) return { run: row, alreadyFinished: true };
    audit("evaluation.live.cancel_requested", id, { datasetId: row.datasetId, datasetVersion: row.datasetVersion, executionMode: "live", status: updated.status, runId: id });
    if (updated.status === "pending_confirmation") runs.transition(id, "pending_confirmation", "cancelled");
    return { run: runs.findById(id), alreadyFinished: false };
  }

  return { getSettings, saveSettings, readiness, preflight, start, cancel };
}
