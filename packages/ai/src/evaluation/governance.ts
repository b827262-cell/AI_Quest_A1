import type { EvaluationExecutionMode, EvaluationSummary } from "./evaluation-types";

export type GovernedEvaluationMode = "fixture" | "mock_orchestrator" | "live";
export type EvaluationCadence = "daily" | "weekly";
export type EvaluationBaselinePolicy = "latest_comparable" | "fixed";

export interface EvaluationRetentionPolicy {
  enabled: boolean;
  maxRunsPerDatasetMode: number;
  maxAgeDays?: number;
  preserveLatestSuccessful: number;
  preserveBaselines: boolean;
  preserveRunsWithRegressionIssues: boolean;
  executionModes: GovernedEvaluationMode[];
}

export const DEFAULT_EVALUATION_RETENTION_POLICY: EvaluationRetentionPolicy = {
  enabled: false,
  maxRunsPerDatasetMode: 10,
  preserveLatestSuccessful: 1,
  preserveBaselines: true,
  preserveRunsWithRegressionIssues: true,
  executionModes: ["fixture", "mock_orchestrator", "live"]
};

export interface EvaluationSchedule {
  id: string;
  enabled: boolean;
  datasetId: string;
  datasetVersion: number;
  executionMode: "fixture" | "mock_orchestrator";
  cadence: EvaluationCadence;
  scheduledTime: string;
  timezone: string;
  baselinePolicy: EvaluationBaselinePolicy;
  fixedBaselineRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RetentionRunCandidate {
  id: string;
  datasetId: string;
  datasetVersion: number;
  executionMode: GovernedEvaluationMode;
  createdAt: string;
  reason: "max_runs_exceeded" | "max_age_exceeded";
  protectedReason?: string;
  estimatedMetricCount: number;
  estimatedIssueCount: number;
}

export interface RetentionPreview {
  id: string;
  expiresAt: string;
  candidates: RetentionRunCandidate[];
  protectedCount: number;
  estimatedDeletedMetrics: number;
  estimatedDeletedIssues: number;
}

export type EvaluationAlertType =
  | "pass_rate_regression"
  | "category_regression"
  | "unresolved_rate_increase"
  | "conflict_rate_increase"
  | "model_calls_increase"
  | "latency_increase"
  | "run_failed"
  | "budget_low"
  | "evaluation_pool_low"
  | "retention_failed";

export type EvaluationAlertSeverity = "info" | "warning" | "critical";
export type EvaluationAlertStatus = "open" | "acknowledged" | "resolved";

export interface EvaluationRegressionAlertPolicy {
  enabled: boolean;
  minimumSampleSize: number;
  passRateDropPercentagePoints?: number;
  categoryPassRateDropPercentagePoints?: number;
  unresolvedRateIncreasePercentagePoints?: number;
  conflictRateIncreasePercentagePoints?: number;
  averageModelCallsIncrease?: number;
  p95LatencyIncreaseMs?: number;
  consecutiveFailuresRequired: number;
}

export interface EvaluationBudgetAlertPolicy {
  evaluationPoolRemainingThreshold?: number;
  dailyBudgetRemainingThreshold?: number;
}

export interface EvaluationAlertRecord {
  id: string;
  runId?: string;
  scheduleId?: string;
  type: EvaluationAlertType;
  severity: EvaluationAlertSeverity;
  status: EvaluationAlertStatus;
  safeSummary: string;
  createdAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
}

export interface GovernanceRunSnapshot {
  id: string;
  datasetId: string;
  datasetVersion: number;
  executionMode: GovernedEvaluationMode;
  status: string;
  createdAt: string;
  totalCases: number;
  passRate: number;
  averageScore: number;
  unresolvedRate: number;
  conflictRate: number;
  averageModelCalls: number;
  p95DurationMs: number;
  totalTokens?: number | null;
  regressionIssueCount: number;
  baselineRunId?: string | null;
  logicalModelIds?: string[];
}

export interface GovernanceMetricSnapshot {
  dimension: string;
  dimensionValue: string;
  passRate: number;
}

function pctDelta(current: number, baseline: number): number { return (current - baseline) * 100; }
function safePositive(value: number | undefined): number | undefined { return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined; }

export function validateRetentionPolicy(policy: EvaluationRetentionPolicy): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(policy.maxRunsPerDatasetMode) || policy.maxRunsPerDatasetMode <= 0) errors.push("max_runs_invalid");
  if (!Number.isInteger(policy.preserveLatestSuccessful) || policy.preserveLatestSuccessful < 0) errors.push("preserve_latest_invalid");
  if (policy.maxAgeDays !== undefined && (!Number.isInteger(policy.maxAgeDays) || policy.maxAgeDays <= 0)) errors.push("max_age_invalid");
  if (!policy.executionModes.every((mode) => ["fixture", "mock_orchestrator", "live"].includes(mode))) errors.push("execution_mode_invalid");
  return errors;
}

export function retentionCandidates(
  runs: GovernanceRunSnapshot[],
  policy: EvaluationRetentionPolicy,
  now = new Date()
): { candidates: RetentionRunCandidate[]; protectedCount: number } {
  if (!policy.enabled) return { candidates: [], protectedCount: runs.length };
  const baselineIds = new Set(runs.map((run) => run.baselineRunId).filter((id): id is string => Boolean(id)));
  const grouped = new Map<string, GovernanceRunSnapshot[]>();
  for (const run of runs) {
    if (!policy.executionModes.includes(run.executionMode)) continue;
    const key = `${run.datasetId}:${run.datasetVersion}:${run.executionMode}`;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  const protectedIds = new Set<string>();
  for (const group of grouped.values()) {
    const successful = group.filter((run) => run.status === "completed").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const run of successful.slice(0, policy.preserveLatestSuccessful)) protectedIds.add(run.id);
  }
  for (const run of runs) {
    if (run.status === "running" || run.status === "pending_confirmation" || baselineIds.has(run.id)) protectedIds.add(run.id);
    if (policy.preserveRunsWithRegressionIssues && run.regressionIssueCount > 0) protectedIds.add(run.id);
  }
  const ageCutoff = policy.maxAgeDays === undefined ? undefined : now.getTime() - policy.maxAgeDays * 86_400_000;
  const candidates: RetentionRunCandidate[] = [];
  for (const group of grouped.values()) {
    const ordered = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    ordered.forEach((run, index) => {
      if (protectedIds.has(run.id)) return;
      const ageExceeded = ageCutoff !== undefined && Date.parse(run.createdAt) < ageCutoff;
      const countExceeded = index >= policy.maxRunsPerDatasetMode;
      if (!ageExceeded && !countExceeded) return;
      candidates.push({
        id: run.id, datasetId: run.datasetId, datasetVersion: run.datasetVersion, executionMode: run.executionMode,
        createdAt: run.createdAt, reason: ageExceeded ? "max_age_exceeded" : "max_runs_exceeded",
        estimatedMetricCount: 0, estimatedIssueCount: 0
      });
    });
  }
  return { candidates, protectedCount: runs.length - candidates.length };
}

export function validateSchedule(input: Omit<EvaluationSchedule, "id" | "createdAt" | "updatedAt">): string[] {
  const errors: string[] = [];
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.datasetId)) errors.push("dataset_not_allowed");
  if (!Number.isInteger(input.datasetVersion) || input.datasetVersion <= 0) errors.push("version_invalid");
  if (!["fixture", "mock_orchestrator"].includes(input.executionMode)) errors.push("live_schedule_forbidden");
  if (!["daily", "weekly"].includes(input.cadence)) errors.push("cadence_invalid");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.scheduledTime)) errors.push("scheduled_time_invalid");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(); } catch { errors.push("timezone_invalid"); }
  if (input.baselinePolicy === "fixed" && !input.fixedBaselineRunId) errors.push("fixed_baseline_required");
  if (!["latest_comparable", "fixed"].includes(input.baselinePolicy)) errors.push("baseline_policy_invalid");
  return errors;
}

export function scheduleWindowKey(schedule: Pick<EvaluationSchedule, "id" | "cadence" | "timezone">, instant: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (schedule.cadence === "daily") return `${schedule.id}:${date}`;
  const week = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  const day = week.getUTCDay();
  week.setUTCDate(week.getUTCDate() - day);
  return `${schedule.id}:${week.toISOString().slice(0, 10)}`;
}

export function scheduledWindowIsDue(schedule: Pick<EvaluationSchedule, "scheduledTime" | "timezone">, instant: Date): boolean {
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const [scheduledHour, scheduledMinute] = schedule.scheduledTime.split(":").map(Number);
  const actualMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  return actualMinutes >= scheduledHour * 60 + scheduledMinute;
}

export function regressionAlertSeverity(consecutiveFailures: number, required: number): EvaluationAlertSeverity {
  return consecutiveFailures >= Math.max(1, required) ? "critical" : "warning";
}

export function compareGovernanceRuns(current: GovernanceRunSnapshot, baseline: GovernanceRunSnapshot, policy: EvaluationRegressionAlertPolicy, categoryMetrics: GovernanceMetricSnapshot[] = [], baselineCategoryMetrics: GovernanceMetricSnapshot[] = []): EvaluationAlertType[] {
  if (!policy.enabled || current.totalCases < policy.minimumSampleSize || baseline.totalCases < policy.minimumSampleSize) return [];
  if (current.datasetId !== baseline.datasetId || current.datasetVersion !== baseline.datasetVersion || current.executionMode !== baseline.executionMode) return [];
  if (current.executionMode === "live" && JSON.stringify([...(current.logicalModelIds ?? [])].sort()) !== JSON.stringify([...(baseline.logicalModelIds ?? [])].sort())) return [];
  const types: EvaluationAlertType[] = [];
  const passDrop = safePositive(policy.passRateDropPercentagePoints);
  if (passDrop !== undefined && pctDelta(current.passRate, baseline.passRate) <= -passDrop) types.push("pass_rate_regression");
  const unresolved = safePositive(policy.unresolvedRateIncreasePercentagePoints);
  if (unresolved !== undefined && pctDelta(current.unresolvedRate, baseline.unresolvedRate) >= unresolved) types.push("unresolved_rate_increase");
  const conflict = safePositive(policy.conflictRateIncreasePercentagePoints);
  if (conflict !== undefined && pctDelta(current.conflictRate, baseline.conflictRate) >= conflict) types.push("conflict_rate_increase");
  if (policy.averageModelCallsIncrease !== undefined && current.averageModelCalls - baseline.averageModelCalls >= policy.averageModelCallsIncrease) types.push("model_calls_increase");
  if (policy.p95LatencyIncreaseMs !== undefined && current.p95DurationMs - baseline.p95DurationMs >= policy.p95LatencyIncreaseMs) types.push("latency_increase");
  const categoryDrop = safePositive(policy.categoryPassRateDropPercentagePoints);
  if (categoryDrop !== undefined) {
    const previous = new Map(baselineCategoryMetrics.map((metric) => [`${metric.dimension}:${metric.dimensionValue}`, metric.passRate]));
    if (categoryMetrics.some((metric) => {
      const before = previous.get(`${metric.dimension}:${metric.dimensionValue}`);
      return before !== undefined && pctDelta(metric.passRate, before) <= -categoryDrop;
    })) types.push("category_regression");
  }
  return types;
}

export function budgetAlertTypes(policy: EvaluationBudgetAlertPolicy, poolRemaining?: number, dailyRemaining?: number): EvaluationAlertType[] {
  const types: EvaluationAlertType[] = [];
  if (policy.evaluationPoolRemainingThreshold !== undefined && poolRemaining !== undefined && poolRemaining <= policy.evaluationPoolRemainingThreshold) types.push("evaluation_pool_low");
  if (policy.dailyBudgetRemainingThreshold !== undefined && dailyRemaining !== undefined && dailyRemaining <= policy.dailyBudgetRemainingThreshold) types.push("budget_low");
  return types;
}

export function governanceSummary(summary: EvaluationSummary): Pick<GovernanceRunSnapshot, "totalCases" | "passRate" | "averageScore" | "unresolvedRate" | "conflictRate" | "averageModelCalls" | "p95DurationMs" | "totalTokens"> {
  return { totalCases: summary.totalCases, passRate: summary.passRate, averageScore: summary.averageScore, unresolvedRate: summary.byOutcome.unresolved?.count ? summary.byOutcome.unresolved.count / summary.totalCases : 0, conflictRate: summary.byOutcome.conflict_detected?.count ? summary.byOutcome.conflict_detected.count / summary.totalCases : 0, averageModelCalls: summary.averageModelCalls, p95DurationMs: summary.p95DurationMs, totalTokens: summary.totalTokens };
}

export type { EvaluationExecutionMode };
