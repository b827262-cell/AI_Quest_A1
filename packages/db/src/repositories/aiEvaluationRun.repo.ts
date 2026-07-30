import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../client";
import { aiEvaluationIssues, aiEvaluationMetrics, aiEvaluationRuns } from "../schema";
import { newId, nowIso } from "./util";

export type EvaluationExecutionMode = "fixture" | "mock_orchestrator" | "live";
export type EvaluationRunStatus = "pending_confirmation" | "running" | "completed" | "failed" | "cancelled" | "budget_exhausted";
export type EvaluationMetricDimension = "category" | "difficulty" | "outcome" | "confidence";

export type EvaluationRunSummaryInput = {
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
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  conflictRate: number;
  unresolvedRate: number;
  baselineRunId?: string | null;
  regressionIssueCount: number;
};

export type EvaluationMetricInput = {
  dimension: EvaluationMetricDimension;
  dimensionValue: string;
  count: number;
  passed: number;
  passRate: number;
  averageScore: number;
};

export type EvaluationIssueInput = {
  caseId: string;
  category: string;
  expectedKind: string;
  score: number;
  code: string;
  severity: "low" | "medium" | "high";
  safeSummary?: string | null;
};

type RunRow = typeof aiEvaluationRuns.$inferSelect;

function boundedLimit(value: number | undefined, fallback = 50): number {
  return Math.min(100, Math.max(1, Math.floor(value ?? fallback)));
}

const allowedTransitions: Record<EvaluationRunStatus, readonly EvaluationRunStatus[]> = {
  pending_confirmation: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled", "budget_exhausted"],
  completed: [], failed: [], cancelled: [], budget_exhausted: []
};

export function makeAiEvaluationRunRepo(db: Db) {
  const findById = (id: string) => db.select().from(aiEvaluationRuns).where(eq(aiEvaluationRuns.id, id)).get();

  return {
    createRun(input: {
      id?: string;
      datasetId: string;
      datasetVersion: number;
      executionMode: EvaluationExecutionMode;
      idempotencyKey?: string;
      createdByAdminId?: string;
      startedAt?: string;
      status?: EvaluationRunStatus;
      maxTokenBudget?: number;
      dailyBudgetSnapshot?: number;
      evaluationPoolId?: string;
      preflightId?: string;
      logicalModelIds?: string[];
      providerIds?: string[];
    }): RunRow {
      if (input.id) {
        const existingById = findById(input.id);
        if (existingById) return existingById;
      }
      if (input.idempotencyKey) {
        const existing = db.select().from(aiEvaluationRuns)
          .where(eq(aiEvaluationRuns.idempotencyKey, input.idempotencyKey)).get();
        if (existing) return existing;
      }
      const now = input.startedAt ?? nowIso();
      const row: RunRow = {
        id: input.id ?? newId("aiev"),
        datasetId: input.datasetId,
        datasetVersion: input.datasetVersion,
        executionMode: input.executionMode,
        status: input.status ?? "running",
        idempotencyKey: input.idempotencyKey ?? null,
        startedAt: now,
        completedAt: null,
        totalCases: 0,
        passedCases: 0,
        failedCases: 0,
        passRate: 0,
        averageScore: 0,
        averageDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        totalModelCalls: 0,
        averageModelCalls: 0,
        totalInputTokens: null,
        totalOutputTokens: null,
        totalTokens: null,
        conflictRate: 0,
        unresolvedRate: 0,
        baselineRunId: null,
        regressionIssueCount: 0,
        trafficClass: "evaluation",
        maxTokenBudget: input.maxTokenBudget ?? null,
        consumedTokens: 0,
        dailyBudgetSnapshot: input.dailyBudgetSnapshot ?? null,
        evaluationPoolId: input.evaluationPoolId ?? null,
        cancelRequestedAt: null,
        cancelledAt: null,
        preflightId: input.preflightId ?? null,
        logicalModelIdsJson: input.logicalModelIds ? JSON.stringify(input.logicalModelIds) : null,
        providerIdsJson: input.providerIds ? JSON.stringify(input.providerIds) : null,
        createdByAdminId: input.createdByAdminId ?? null,
        createdAt: now
      };
      db.insert(aiEvaluationRuns).values(row).run();
      return row;
    },

    findById,

    findByIdempotencyKey(key: string) {
      return db.select().from(aiEvaluationRuns).where(eq(aiEvaluationRuns.idempotencyKey, key)).get();
    },

    findRunning(datasetId: string, datasetVersion: number, executionMode: EvaluationExecutionMode) {
      return db.select().from(aiEvaluationRuns).where(and(
        eq(aiEvaluationRuns.datasetId, datasetId),
        eq(aiEvaluationRuns.datasetVersion, datasetVersion),
        eq(aiEvaluationRuns.executionMode, executionMode),
        sql`${aiEvaluationRuns.status} IN ('running', 'pending_confirmation')`
      )).get();
    },

    completeRun(id: string, summary: EvaluationRunSummaryInput, completedAt = nowIso()) {
      const current = findById(id);
      if (!current || current.status !== "running") return current;
      db.update(aiEvaluationRuns).set({ ...summary, completedAt, status: "completed" })
        .where(and(eq(aiEvaluationRuns.id, id), eq(aiEvaluationRuns.status, "running"))).run();
      return findById(id);
    },

    failRun(id: string, completedAt = nowIso()) {
      const current = findById(id);
      if (!current || current.status !== "running") return current;
      db.update(aiEvaluationRuns).set({ status: "failed", completedAt })
        .where(and(eq(aiEvaluationRuns.id, id), eq(aiEvaluationRuns.status, "running"))).run();
      return findById(id);
    },

    requestCancel(id: string, requestedAt = nowIso()) {
      const current = findById(id);
      if (!current || (current.status !== "running" && current.status !== "pending_confirmation")) return current;
      db.update(aiEvaluationRuns).set({ cancelRequestedAt: requestedAt })
        .where(and(eq(aiEvaluationRuns.id, id), sql`${aiEvaluationRuns.status} IN ('running', 'pending_confirmation')`)).run();
      return findById(id);
    },

    transition(id: string, from: EvaluationRunStatus, to: EvaluationRunStatus, timestamp = nowIso()) {
      if (!allowedTransitions[from].includes(to)) return findById(id);
      const patch = to === "cancelled"
        ? { status: to, completedAt: timestamp, cancelledAt: timestamp }
        : { status: to, completedAt: to === "running" ? null : timestamp };
      db.update(aiEvaluationRuns).set(patch)
        .where(and(eq(aiEvaluationRuns.id, id), eq(aiEvaluationRuns.status, from))).run();
      return findById(id);
    },

    updateConsumedTokens(id: string, consumedTokens: number) {
      db.update(aiEvaluationRuns).set({ consumedTokens: Math.max(0, Math.floor(consumedTokens)) }).where(eq(aiEvaluationRuns.id, id)).run();
      return findById(id);
    },

    /** Atomically writes the summary, metric groups and safe failed-case issues. */
    finalizeRun(id: string, summary: EvaluationRunSummaryInput, metrics: EvaluationMetricInput[], issues: EvaluationIssueInput[], completedAt = nowIso(), finalStatus: EvaluationRunStatus = "completed") {
      const current = findById(id);
      if (!current) return undefined;
      if (current.status !== "running") return current;
      db.transaction((tx) => {
        tx.update(aiEvaluationRuns).set({ ...summary, completedAt, status: finalStatus })
          .where(and(eq(aiEvaluationRuns.id, id), eq(aiEvaluationRuns.status, "running"))).run();
        for (const metric of metrics) {
          tx.insert(aiEvaluationMetrics).values({ id: newId("aie-m"), runId: id, ...metric }).run();
        }
        for (const issue of issues) {
          tx.insert(aiEvaluationIssues).values({ id: newId("aie-i"), runId: id, ...issue }).run();
        }
      });
      return findById(id);
    },

    listRuns(query: {
      datasetId?: string;
      executionMode?: EvaluationExecutionMode;
      status?: EvaluationRunStatus;
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
      offset?: number;
    } = {}) {
      const conditions = [];
      if (query.datasetId) conditions.push(eq(aiEvaluationRuns.datasetId, query.datasetId));
      if (query.executionMode) conditions.push(eq(aiEvaluationRuns.executionMode, query.executionMode));
      if (query.status) conditions.push(eq(aiEvaluationRuns.status, query.status));
      if (query.dateFrom) conditions.push(gte(aiEvaluationRuns.createdAt, query.dateFrom));
      if (query.dateTo) conditions.push(lte(aiEvaluationRuns.createdAt, query.dateTo));
      const where = conditions.length ? and(...conditions) : undefined;
      const limit = boundedLimit(query.limit);
      const offset = Math.max(0, Math.floor(query.offset ?? 0));
      const rows = db.select().from(aiEvaluationRuns).where(where)
        .orderBy(desc(aiEvaluationRuns.createdAt)).limit(limit).offset(offset).all();
      const count = db.select({ count: sql<number>`count(*)` }).from(aiEvaluationRuns).where(where).get()?.count ?? 0;
      return { rows, total: count, limit, offset };
    },

    findLatestComparableBaseline(datasetId: string, datasetVersion: number, executionMode: EvaluationExecutionMode, excludeRunId?: string) {
      const conditions = [
        eq(aiEvaluationRuns.datasetId, datasetId),
        eq(aiEvaluationRuns.datasetVersion, datasetVersion),
        eq(aiEvaluationRuns.executionMode, executionMode),
        eq(aiEvaluationRuns.status, "completed")
      ];
      if (excludeRunId) conditions.push(sql`${aiEvaluationRuns.id} <> ${excludeRunId}` as never);
      return db.select().from(aiEvaluationRuns).where(and(...conditions))
        .orderBy(desc(aiEvaluationRuns.createdAt)).get();
    },

    deleteRun(id: string) {
      const current = findById(id);
      if (!current) return { deleted: false, alreadyDeleted: true };
      const result = db.transaction((tx) => {
        tx.delete(aiEvaluationMetrics).where(eq(aiEvaluationMetrics.runId, id)).run();
        tx.delete(aiEvaluationIssues).where(eq(aiEvaluationIssues.runId, id)).run();
        return tx.delete(aiEvaluationRuns).where(eq(aiEvaluationRuns.id, id)).run();
      });
      return { deleted: result.changes > 0, alreadyDeleted: result.changes === 0 };
    }
  };
}

export type AiEvaluationRunRepo = ReturnType<typeof makeAiEvaluationRunRepo>;
