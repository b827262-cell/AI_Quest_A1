import {
  AiGatewayError,
  type BudgetCheckInput,
  type BudgetCheckResult,
  type BudgetManager,
  type BudgetRecordInput,
  type BudgetReservation
} from "@ai-smartbook/ai";
import type { Repositories } from "@ai-smartbook/db";

function taipeiDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export interface EvaluationBudgetManagerOptions {
  repos: Repositories;
  runId: string;
  poolId: string;
  maxTokensPerRun: number;
  maxTokensPerDay: number;
  getConsumedTokens: () => number;
  setConsumedTokens: (value: number) => void;
  isCancelled: () => boolean;
}

/** BudgetManager implementation backed only by the evaluation pool tables. */
export class EvaluationBudgetManager implements BudgetManager {
  constructor(private readonly options: EvaluationBudgetManagerOptions) {}

  async preCheck(input: BudgetCheckInput): Promise<BudgetCheckResult> {
    if (this.options.isCancelled()) return { allowed: false, utilisation: 0, reason: "evaluation_cancelled" };
    const estimate = Math.max(1, input.inputTokens + input.estimatedOutputTokens);
    if (this.options.getConsumedTokens() + estimate > this.options.maxTokensPerRun) return { allowed: false, utilisation: 1, reason: "evaluation_run_budget_exhausted" };
    const snapshot = this.options.repos.aiEvaluationControl.dailySnapshot(taipeiDateKey(), this.options.maxTokensPerDay);
    if (snapshot.consumedTokens + snapshot.reservedTokens + estimate > this.options.maxTokensPerDay) return { allowed: false, utilisation: 1, reason: "evaluation_daily_budget_exhausted" };
    return { allowed: true, utilisation: this.options.maxTokensPerDay > 0 ? (snapshot.consumedTokens + snapshot.reservedTokens) / this.options.maxTokensPerDay : 1 };
  }

  async reserve(input: BudgetCheckInput): Promise<BudgetCheckResult> {
    const preflight = await this.preCheck(input);
    if (!preflight.allowed) return preflight;
    const estimatedTokens = Math.max(1, input.inputTokens + input.estimatedOutputTokens);
    const reserved = this.options.repos.aiEvaluationControl.reserve({
      runId: this.options.runId,
      requestId: input.requestId ?? `${this.options.runId}:${input.provider}:${input.model}`,
      poolId: this.options.poolId,
      usageDate: taipeiDateKey(),
      estimatedTokens,
      dailyLimit: this.options.maxTokensPerDay
    });
    if (!reserved.allowed) return { allowed: false, utilisation: 1, reason: reserved.reason };
    const reservation: BudgetReservation = {
      id: reserved.reservationId,
      provider: input.provider,
      model: input.model,
      estimatedTokens,
      estimatedCostMicroUsd: input.estimatedCostMicroUsd
    };
    return { allowed: true, utilisation: preflight.utilisation, reservation };
  }

  async recordUsage(input: BudgetRecordInput): Promise<void> {
    this.options.setConsumedTokens(this.options.getConsumedTokens() + Math.max(0, input.totalTokens));
  }

  async settleReservation(reservation: BudgetReservation, input: BudgetRecordInput): Promise<void> {
    this.options.repos.aiEvaluationControl.settle(reservation.id, Math.max(0, input.totalTokens));
    this.options.setConsumedTokens(this.options.getConsumedTokens() + Math.max(0, input.totalTokens));
  }

  async releaseReservation(reservation: BudgetReservation): Promise<void> {
    this.options.repos.aiEvaluationControl.release(reservation.id);
  }
}

export function liveBudgetError(reason: string): AiGatewayError {
  return new AiGatewayError("AI_BUDGET_EXCEEDED", "Live 評測預算不足，已安全停止。", { internalMessage: reason });
}

export { taipeiDateKey };
