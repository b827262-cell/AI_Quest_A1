import type {
  AiBudgetScopeType,
  AiRequestSource
} from "@ai-smartbook/schema";
import type {
  BudgetCheckInput,
  BudgetCheckResult,
  BudgetManager,
  BudgetRecordInput,
  BudgetReservation
} from "@ai-smartbook/ai";
import type { Repositories } from "@ai-smartbook/db";

/**
 * DB-backed budget manager. Real providers reserve the worst-case gateway
 * estimate in SQLite before the HTTP call; the reservation is released on a
 * failed attempt and settled exactly once after success. This prevents two
 * concurrent requests from both passing the same daily limit check.
 *
 * Threshold behaviour (spec §6):
 *  - below warning%: allow
 *  - warning%..100%: allow but flag (returned via `utilisation`, not blocked)
 *  - >= 100% of either token or cost limit: deny (gateway maps to 429)
 *
 * Mock provider calls are always allowed and recorded as zero cost. The
 * gateway decides whether mock is eligible in production.
 */
export class DbBudgetManager implements BudgetManager {
  constructor(
    private readonly repos: Repositories,
    private readonly defaults: {
      dailyTokenLimit: number;
      dailyCostLimitUsd: number;
      warningPercentage: number;
    }
  ) {}

  async preCheck(input: BudgetCheckInput): Promise<BudgetCheckResult> {
    // Mock never spends budget.
    if (input.provider === "mock") {
      return { allowed: true, utilisation: 0 };
    }

    const date = todayTaipei();
    const global = this.repos.aiDailyUsage.dailyGlobalTotals(date);

    // Resolve the effective global policy (fallback to env defaults).
    const policy = this.repos.aiBudgetPolicies.findByScope("global", "default");
    const tokenLimit = policy?.dailyTokenLimit ?? this.defaults.dailyTokenLimit;
    const costLimitMicroUsd =
      policy?.dailyCostLimitMicroUsd ?? Math.round(this.defaults.dailyCostLimitUsd * 1_000_000);

    const projectedTokens =
      global.totalTokens + global.reservedTokens + input.inputTokens + input.estimatedOutputTokens;
    const projectedCost =
      global.estimatedCostMicroUsd + global.reservedCostMicroUsd + input.estimatedCostMicroUsd;

    const tokenUtilisation = tokenLimit > 0 ? projectedTokens / tokenLimit : 0;
    const costUtilisation =
      costLimitMicroUsd > 0 ? projectedCost / costLimitMicroUsd : 0;
    const utilisation = Math.max(tokenUtilisation, costUtilisation);

    if (projectedTokens > tokenLimit && tokenLimit > 0) {
      return {
        allowed: false,
        utilisation,
        reason: `token budget exceeded (${projectedTokens} > ${tokenLimit})`
      };
    }
    if (projectedCost > costLimitMicroUsd && costLimitMicroUsd > 0) {
      return {
        allowed: false,
        utilisation,
        reason: `cost budget exceeded (${projectedCost} > ${costLimitMicroUsd} micro-USD)`
      };
    }
    return { allowed: true, utilisation };
  }

  async reserve(input: BudgetCheckInput): Promise<BudgetCheckResult> {
    if (input.provider === "mock") return { allowed: true, utilisation: 0 };
    const policy = this.repos.aiBudgetPolicies.findByScope("global", "default");
    if (policy?.enabled === false) return { allowed: true, utilisation: 0 };
    const result = this.repos.aiBudgetReservations.reserve({
      requestId: input.requestId ?? "unknown-request",
      provider: input.provider,
      model: input.model,
      date: todayTaipei(),
      estimatedTokens: input.inputTokens + input.estimatedOutputTokens,
      estimatedCostMicroUsd: input.estimatedCostMicroUsd,
      dailyTokenLimit: policy?.dailyTokenLimit ?? this.defaults.dailyTokenLimit,
      dailyCostLimitMicroUsd:
        policy?.dailyCostLimitMicroUsd ?? Math.round(this.defaults.dailyCostLimitUsd * 1_000_000)
    });
    return {
      allowed: result.allowed,
      utilisation: result.utilisation,
      reason: result.reason,
      reservation: result.reservationId
        ? {
            id: result.reservationId,
            provider: input.provider,
            model: input.model,
            estimatedTokens: input.inputTokens + input.estimatedOutputTokens,
            estimatedCostMicroUsd: input.estimatedCostMicroUsd
          }
        : undefined
    };
  }

  async settleReservation(reservation: BudgetReservation, input: BudgetRecordInput): Promise<void> {
    this.repos.aiBudgetReservations.settle(reservation.id, {
      date: todayTaipei(),
      scopeType: scopeForRequestSource(input.scopeType),
      scopeKey: input.scopeKey,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      estimatedCostMicroUsd: input.estimatedCostMicroUsd,
      actualCostMicroUsd: input.actualCostMicroUsd
    });
  }

  async releaseReservation(reservation: BudgetReservation): Promise<void> {
    this.repos.aiBudgetReservations.release(reservation.id);
  }

  async recordUsage(input: BudgetRecordInput): Promise<void> {
    const date = todayTaipei();
    const scopeType = scopeForRequestSource(input.scopeType);

    // Always accumulate into the global row.
    this.repos.aiDailyUsage.accumulate({
      date,
      scopeType: "global",
      scopeKey: "default",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      estimatedCostMicroUsd: input.estimatedCostMicroUsd,
      actualCostMicroUsd: input.actualCostMicroUsd
    });

    // Also accumulate into the per-source scope for finer analytics.
    if (scopeType !== "global") {
      this.repos.aiDailyUsage.accumulate({
        date,
        scopeType,
        scopeKey: input.scopeKey,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens: input.totalTokens,
        estimatedCostMicroUsd: input.estimatedCostMicroUsd,
        actualCostMicroUsd: input.actualCostMicroUsd
      });
    }
  }
}

function todayTaipei(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function scopeForRequestSource(source: AiRequestSource): AiBudgetScopeType {
  if (source === "guest") return "guest";
  if (source === "student") return "student";
  return "global";
}
