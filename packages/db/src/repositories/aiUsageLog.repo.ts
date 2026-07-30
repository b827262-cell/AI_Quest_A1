import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { CreateAiUsageLogInput } from "@ai-smartbook/schema";
import type { Db } from "../client";
import { aiUsageLogs } from "../schema";
import { newId, nowIso } from "./util";

type Row = typeof aiUsageLogs.$inferSelect;

export function makeAiUsageLogRepo(db: Db) {
  return {
    create(input: CreateAiUsageLogInput): Row {
      const row: Row = {
        id: newId("aiu"),
        requestId: input.requestId,
        provider: input.provider,
        credentialId: input.credentialId ?? null,
        model: input.model,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        totalTokens: input.totalTokens ?? null,
        // Q&A detail + token/cost breakdown + pricing provenance (spec §2, §5.3, §6).
        questionText: input.questionText ?? null,
        answerText: input.answerText ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        thinkingTokens: input.thinkingTokens ?? null,
        inputCostMicrousd: input.inputCostMicrousd ?? 0,
        cachedInputCostMicrousd: input.cachedInputCostMicrousd ?? 0,
        outputCostMicrousd: input.outputCostMicrousd ?? 0,
        totalCostMicrousd: input.totalCostMicrousd ?? 0,
        pricingSource: input.pricingSource ?? null,
        pricingVersion: input.pricingVersion ?? null,
        pricingSnapshotJson: input.pricingSnapshotJson ?? null,
        usageSource: input.usageSource ?? null,
        estimatedCostMicroUsd: input.estimatedCostMicroUsd ?? 0,
        actualCostMicroUsd: input.actualCostMicroUsd ?? 0,
        finishReason: input.finishReason ?? null,
        // Token Pool provenance (spec §6): from the composite reservation.
        poolId: input.poolId ?? null,
        logicalModelId: input.logicalModelId ?? null,
        estimated: input.estimated ?? null,
        overageTokens: input.overageTokens ?? null,
        // OpenAI Credential daily ledger provenance.
        credentialDailyReservationKey: input.credentialDailyReservationKey ?? null,
        usageAttempt: input.usageAttempt ?? null,
        costStatus: input.costStatus ?? null,
        createdAt: nowIso()
      };
      db.insert(aiUsageLogs).values(row).run();
      return row;
    },

    findByRequestId(requestId: string): Row | undefined {
      return db.select().from(aiUsageLogs).where(eq(aiUsageLogs.requestId, requestId)).get();
    },

    /** Sum tokens + cost within a UTC date (YYYY-MM-DD). */
    dailyTotals(date: string): {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      estimatedCostMicroUsd: number;
      actualCostMicroUsd: number;
    } {
      const fromIso = `${date}T00:00:00.000Z`;
      const toIso = `${date}T23:59:59.999Z`;
      const row = db
        .select({
          inputTokens: sql<number>`coalesce(sum(${aiUsageLogs.inputTokens}),0)`,
          outputTokens: sql<number>`coalesce(sum(${aiUsageLogs.outputTokens}),0)`,
          totalTokens: sql<number>`coalesce(sum(${aiUsageLogs.totalTokens}),0)`,
          estimatedCostMicroUsd: sql<number>`coalesce(sum(${aiUsageLogs.estimatedCostMicroUsd}),0)`,
          actualCostMicroUsd: sql<number>`coalesce(sum(${aiUsageLogs.actualCostMicroUsd}),0)`
        })
        .from(aiUsageLogs)
        .where(
          sql`${aiUsageLogs.createdAt} >= ${fromIso} AND ${aiUsageLogs.createdAt} <= ${toIso}`
        )
        .get();
      return {
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
        totalTokens: row?.totalTokens ?? 0,
        estimatedCostMicroUsd: row?.estimatedCostMicroUsd ?? 0,
        actualCostMicroUsd: row?.actualCostMicroUsd ?? 0
      };
    },

    totals(fromIso: string, toIso: string) {
      const row = db.select({
        inputTokens: sql<number>`coalesce(sum(${aiUsageLogs.inputTokens}),0)`,
        outputTokens: sql<number>`coalesce(sum(${aiUsageLogs.outputTokens}),0)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsageLogs.totalTokens}),0)`,
        estimatedCostMicroUsd: sql<number>`coalesce(sum(${aiUsageLogs.estimatedCostMicroUsd}),0)`,
        actualCostMicroUsd: sql<number>`coalesce(sum(${aiUsageLogs.actualCostMicroUsd}),0)`
      }).from(aiUsageLogs).where(
        and(gte(aiUsageLogs.createdAt, fromIso), lte(aiUsageLogs.createdAt, toIso))
      ).get();
      return {
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
        totalTokens: row?.totalTokens ?? 0,
        estimatedCostMicroUsd: row?.estimatedCostMicroUsd ?? 0,
        actualCostMicroUsd: row?.actualCostMicroUsd ?? 0
      };
    },

    dailyAggregate(fromIso: string, toIso: string, timezoneModifier = "+8 hours") {
      return db.select({
        date: sql<string>`date(${aiUsageLogs.createdAt}, ${timezoneModifier})`,
        totalTokens: sql<number>`coalesce(sum(${aiUsageLogs.totalTokens}),0)`,
        estimatedCostMicroUsd: sql<number>`coalesce(sum(${aiUsageLogs.estimatedCostMicroUsd}),0)`
      }).from(aiUsageLogs).where(
        and(gte(aiUsageLogs.createdAt, fromIso), lte(aiUsageLogs.createdAt, toIso))
      ).groupBy(sql`date(${aiUsageLogs.createdAt}, ${timezoneModifier})`)
        .orderBy(sql`date(${aiUsageLogs.createdAt}, ${timezoneModifier})`)
        .all() as Array<{ date: string; totalTokens: number; estimatedCostMicroUsd: number }>;
    },

    providerTotals(fromIso: string, toIso: string) {
      return db.select({
        provider: aiUsageLogs.provider,
        requestCount: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(${aiUsageLogs.totalTokens}),0)`,
        estimatedCostMicroUsd: sql<number>`coalesce(sum(${aiUsageLogs.estimatedCostMicroUsd}),0)`
      }).from(aiUsageLogs).where(
        and(gte(aiUsageLogs.createdAt, fromIso), lte(aiUsageLogs.createdAt, toIso))
      ).groupBy(aiUsageLogs.provider).all() as Array<{
        provider: string;
        requestCount: number;
        totalTokens: number;
        estimatedCostMicroUsd: number;
      }>;
    }
  };
}

export type AiUsageLogRepo = ReturnType<typeof makeAiUsageLogRepo>;
