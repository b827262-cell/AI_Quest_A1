import type { Repositories } from "@ai-smartbook/db";

/**
 * Phase 2 AI Analytics service. Pure read-side aggregations over
 * ai_request_logs + ai_usage_logs + ai_daily_usage, surfaced through the
 * admin Analytics API. All responses are sanitised: no raw IPs (only hashes
 * were ever stored), no keys, no system prompts.
 */

const MAX_QUESTION_PREVIEW = 120;

export type AnalyticsSummary = {
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
};

export type AnalyticsDailyRow = {
  date: string;
  requestCount: number;
  successCount: number;
  failedCount: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  avgLatencyMs: number;
};

export type AnalyticsProviderRow = {
  provider: string;
  requestCount: number;
  totalTokens: number;
  estimatedCostMicroUsd: number;
  avgLatencyMs: number;
};

export type AnalyticsSubjectRow = {
  subject: string;
  requestCount: number;
};

export type RequestLogRow = {
  id: string;
  requestId: string;
  requestSource: string;
  questionPreview: string;
  /** Bounded answer preview (spec §3.1) — never the full text. */
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
};

export type RequestLogDetail = RequestLogRow & {
  questionLength: number;
  routingReason: string;
  // visitorIpHash is intentionally NOT exposed in the default detail view to
  // avoid trivial fingerprint tourism; admins can enable it via flag if needed.
  usage?:
    | {
        provider: string;
        model: string;
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
        estimatedCostMicroUsd: number;
        finishReason: string | null;
      }
    | undefined;
};

export function todayTaipei(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function dayRangeIso(date: string): { fromIso: string; toIso: string } {
  return {
    fromIso: new Date(`${date}T00:00:00+08:00`).toISOString(),
    toIso: new Date(`${date}T23:59:59.999+08:00`).toISOString()
  };
}

export function makeAnalyticsService(repos: Repositories, budgetDefaults: {
  dailyTokenLimit: number;
  dailyCostLimitUsd: number;
}) {
  return {
    summary(date: string = todayTaipei()): AnalyticsSummary {
      const { fromIso, toIso } = dayRangeIso(date);
      const metrics = repos.aiRequestLogs.metricsByDate(fromIso, toIso);
      const totalRequests = metrics.total;
      const successCount = metrics.success;
      const failedCount = metrics.failed;
      const fallbackCount = metrics.fallback;
      const avgLatencyMs = Math.round(metrics.avgLatencyMs);

      const usageTotals = repos.aiUsageLogs.totals(fromIso, toIso);

      const providerCounts = repos.aiRequestLogs.providerCountsByDate(fromIso, toIso);
      const subjectCounts = repos.aiRequestLogs.subjectCountsByDate(fromIso, toIso);
      const usageProviders = repos.aiUsageLogs.providerTotals(fromIso, toIso);
      const topProvider = usageProviders.sort((a, b) => b.requestCount - a.requestCount)[0]?.provider ??
        providerCounts.sort((a, b) => b.n - a.n)[0]?.provider ?? null;
      const topSubject = subjectCounts.sort((a, b) => b.n - a.n)[0]?.subject ?? null;

      // Budget utilisation for the day (cost or token, whichever is higher %).
      const policy = repos.aiBudgetPolicies.findByScope("global", "default");
      const tokenLimit = policy?.dailyTokenLimit ?? budgetDefaults.dailyTokenLimit;
      const costLimitMicroUsd =
        policy?.dailyCostLimitMicroUsd ??
        Math.round(budgetDefaults.dailyCostLimitUsd * 1_000_000);
      const tokenPct = tokenLimit > 0 ? (usageTotals.totalTokens / tokenLimit) * 100 : 0;
      const costPct =
        costLimitMicroUsd > 0 ? (usageTotals.estimatedCostMicroUsd / costLimitMicroUsd) * 100 : 0;
      const budgetUtilisationPercentage = Math.round(Math.max(tokenPct, costPct) * 100) / 100;

      return {
        date,
        totalRequests,
        successCount,
        failedCount,
        fallbackCount,
        avgLatencyMs,
        totalInputTokens: usageTotals.inputTokens,
        totalOutputTokens: usageTotals.outputTokens,
        totalEstimatedCostMicroUsd: usageTotals.estimatedCostMicroUsd,
        topProvider,
        topSubject,
        budgetUtilisationPercentage
      };
    },

    daily(fromIso: string, toIso: string): AnalyticsDailyRow[] {
      const agg = repos.aiRequestLogs.dailyAggregate(fromIso, toIso, "+8 hours");
      const usage = new Map(
        repos.aiUsageLogs.dailyAggregate(fromIso, toIso, "+8 hours")
          .map((row) => [row.date, row])
      );
      return agg.map((a) => ({
        date: a.date,
        requestCount: a.requestCount,
        successCount: a.successCount,
        failedCount: a.failedCount,
        totalTokens: usage.get(a.date)?.totalTokens ?? 0,
        estimatedCostMicroUsd: usage.get(a.date)?.estimatedCostMicroUsd ?? 0,
        avgLatencyMs: Math.round(a.avgLatencyMs ?? 0)
      }));
    },

    providers(fromIso: string, toIso: string): AnalyticsProviderRow[] {
      const rows = repos.aiRequestLogs.providerCountsByDate(fromIso, toIso);
      const usage = repos.aiUsageLogs.providerTotals(fromIso, toIso);
      if (usage.length > 0) {
        const latency = new Map(rows.map((r) => [r.provider, r.avgLatency]));
        return usage.map((r) => ({
          provider: r.provider,
          requestCount: r.requestCount,
          totalTokens: r.totalTokens,
          estimatedCostMicroUsd: r.estimatedCostMicroUsd,
          avgLatencyMs: Math.round(latency.get(r.provider) ?? 0)
        }));
      }
      return rows.map((r) => ({
        provider: r.provider,
        requestCount: r.n,
        totalTokens: 0,
        estimatedCostMicroUsd: 0,
        avgLatencyMs: Math.round(r.avgLatency ?? 0)
      }));
    },

    subjects(fromIso: string, toIso: string): AnalyticsSubjectRow[] {
      return repos.aiRequestLogs.subjectCountsByDate(fromIso, toIso).map((r) => ({
        subject: r.subject,
        requestCount: r.n
      }));
    },

    listRequests(query: {
      from?: string;
      to?: string;
      provider?: string;
      model?: string;
      subject?: string;
      status?: string;
      requestSource?: string;
      page?: number;
      limit?: number;
      sort?: "newest" | "oldest" | "latency";
    }): { rows: RequestLogRow[]; total: number; page: number; limit: number } {
      const page = repos.aiRequestLogs.query(query);
      return {
        total: page.total,
        page: page.page,
        limit: page.limit,
        rows: page.rows.map((r) => {
          const usage = repos.aiUsageLogs.findByRequestId(r.requestId);
          return {
          id: r.id,
          requestId: r.requestId,
          requestSource: r.requestSource,
          questionPreview: preview(r.question),
          // Answer preview comes from the usage log's stored answerText
          // (bounded); never the full text in the list response (spec §3.1).
          answerPreview: preview(usage?.answerText ?? ""),
          subject: r.subject,
          taskType: r.taskType,
          complexity: r.complexity,
          routingProvider: r.routingProvider,
          routingModel: r.routingModel,
          providerAttempts: parseProviderAttempts(r.providerAttemptsJson),
          status: r.status,
          errorCode: r.errorCode,
          fallbackReason: readFallbackReason(r.diagnosticsJson),
          latencyMs: r.latencyMs,
          createdAt: r.createdAt,
          totalTokens: usage?.totalTokens ?? null,
          estimatedCostMicroUsd: usage?.estimatedCostMicroUsd ?? 0
          };
        })
      };
    },

    requestDetail(requestId: string): RequestLogDetail | undefined {
      const r = repos.aiRequestLogs.findByRequestId(requestId);
      if (!r) return undefined;
      const usage = repos.aiUsageLogs.findByRequestId(requestId);
      return {
        id: r.id,
        requestId: r.requestId,
        requestSource: r.requestSource,
        questionPreview: preview(r.question),
        answerPreview: preview(usage?.answerText ?? ""),
        questionLength: r.questionLength,
        subject: r.subject,
        taskType: r.taskType,
        complexity: r.complexity,
        routingProvider: r.routingProvider,
        routingModel: r.routingModel,
        providerAttempts: parseProviderAttempts(r.providerAttemptsJson),
        routingReason: r.routingReason,
        status: r.status,
        errorCode: r.errorCode,
        fallbackReason: readFallbackReason(r.diagnosticsJson),
        latencyMs: r.latencyMs,
        createdAt: r.createdAt,
        usage: usage
          ? {
              provider: usage.provider,
              model: usage.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              estimatedCostMicroUsd: usage.estimatedCostMicroUsd,
              finishReason: usage.finishReason
            }
          : undefined
      };
    },

    /**
     * Full Q&A + token/cost detail for one request (spec §3.3). The full
     * questionText / answerText are exposed ONLY here. Returns undefined when
     * no usage row exists for the requestId.
     */
    usageDetail(requestId: string): UsageDetail | undefined {
      const req = repos.aiRequestLogs.findByRequestId(requestId);
      const usage = repos.aiUsageLogs.findByRequestId(requestId);
      if (!usage) return undefined;
      // Parse the immutable pricing snapshot (prices only; never keys/secrets).
      let pricingSnapshot: unknown = null;
      if (usage.pricingSnapshotJson) {
        try {
          pricingSnapshot = JSON.parse(usage.pricingSnapshotJson);
        } catch {
          pricingSnapshot = null;
        }
      }
      return {
        requestId: usage.requestId,
        createdAt: usage.createdAt,
        mode: req?.requestSource ?? "unknown",
        status: req?.status ?? "success",
        fallbackReason: readFallbackReason(req?.diagnosticsJson ?? null),
        latencyMs: req?.latencyMs ?? 0,
        provider: usage.provider,
        model: usage.model,
        finishReason: usage.finishReason,
        questionText: usage.questionText ?? req?.question ?? "",
        answerText: usage.answerText ?? "",
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        thinkingTokens: usage.thinkingTokens,
        totalTokens: usage.totalTokens,
        inputCostMicrousd: usage.inputCostMicrousd,
        cachedInputCostMicrousd: usage.cachedInputCostMicrousd,
        outputCostMicrousd: usage.outputCostMicrousd,
        totalCostMicrousd: usage.totalCostMicrousd,
        usageSource: usage.usageSource,
        pricingSource: usage.pricingSource,
        pricingVersion: usage.pricingVersion,
        pricingSnapshot
      };
    }
  };
}

export type AnalyticsService = ReturnType<typeof makeAnalyticsService>;

/**
 * Full Q&A + token + cost detail for a single request (spec §3.3). Returned
 * ONLY by the detail endpoint; the list endpoint exposes previews only.
 */
export type UsageDetail = {
  requestId: string;
  createdAt: string;
  mode: string;
  status: string;
  fallbackReason: string | null;
  latencyMs: number;
  provider: string;
  model: string;
  finishReason: string | null;
  // Full Q&A (spec §3.3) — these are the only fields that carry full text.
  questionText: string;
  answerText: string;
  // Token breakdown (spec §3.3, §6).
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
  // Cost breakdown (spec §3.3, §6) — integer micro-USD.
  inputCostMicrousd: number;
  cachedInputCostMicrousd: number;
  outputCostMicrousd: number;
  totalCostMicrousd: number;
  // Provenance (spec §3.3, §5.3, §6.7).
  usageSource: string | null;
  pricingSource: string | null;
  pricingVersion: string | null;
  pricingSnapshot: unknown;
};

function preview(question: string): string {
  const trimmed = question.trim().replace(/\s+/g, " ");
  return trimmed.length > MAX_QUESTION_PREVIEW
    ? `${trimmed.slice(0, MAX_QUESTION_PREVIEW)}…`
    : trimmed;
}

function parseProviderAttempts(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 10)
      : [];
  } catch {
    return [];
  }
}

const FALLBACK_REASONS = new Set([
  "no_active_credential",
  "no_default_model",
  "model_not_enabled",
  "quota_exhausted",
  "credential_cooldown",
  "provider_disabled",
  "provider_request_failed"
]);

function readFallbackReason(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { fallbackReason?: unknown };
    return typeof parsed.fallbackReason === "string" && FALLBACK_REASONS.has(parsed.fallbackReason)
      ? parsed.fallbackReason
      : null;
  } catch {
    return null;
  }
}
