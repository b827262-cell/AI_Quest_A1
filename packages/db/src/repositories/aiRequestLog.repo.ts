import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { CreateAiRequestLogInput } from "@ai-smartbook/schema";
import type { Db } from "../client";
import { aiRequestLogs } from "../schema";
import { newId, nowIso } from "./util";

type Row = typeof aiRequestLogs.$inferSelect;

export type AiRequestLogQuery = {
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
};

export type AiRequestLogPage = {
  rows: Row[];
  total: number;
  page: number;
  limit: number;
};

export function makeAiRequestLogRepo(db: Db) {
  return {
    create(input: CreateAiRequestLogInput): Row {
      const id = newId("air");
      const createdAt = nowIso();
      const row: Row = {
        id,
        requestId: input.requestId,
        visitorId: input.visitorId ?? null,
        visitorIpHash: input.visitorIpHash ?? null,
        requestSource: input.requestSource,
        question: input.question,
        questionLength: input.question.length,
        subject: input.subject,
        taskType: input.taskType,
        complexity: input.complexity,
        routingProvider: input.routingProvider,
        routingModel: input.routingModel ?? null,
        routingReason: input.routingReason,
        providerAttemptsJson: JSON.stringify(input.providerAttempts ?? []),
        status: input.status,
        errorCode: input.errorCode ?? null,
        diagnosticsJson: input.diagnosticsJson ?? null,
        createdAt,
        completedAt: createdAt,
        latencyMs: input.latencyMs
      };
      db.insert(aiRequestLogs).values(row).run();
      return row;
    },

    findByRequestId(requestId: string): Row | undefined {
      return db
        .select()
        .from(aiRequestLogs)
        .where(eq(aiRequestLogs.requestId, requestId))
        .get();
    },

    findById(id: string): Row | undefined {
      return db.select().from(aiRequestLogs).where(eq(aiRequestLogs.id, id)).get();
    },

    query(q: AiRequestLogQuery = {}): AiRequestLogPage {
      const page = Math.max(1, q.page ?? 1);
      const limit = Math.min(200, Math.max(1, q.limit ?? 50));
      const conditions = [];
      if (q.from) conditions.push(gte(aiRequestLogs.createdAt, q.from));
      if (q.to) conditions.push(lte(aiRequestLogs.createdAt, q.to));
      if (q.provider) conditions.push(eq(aiRequestLogs.routingProvider, q.provider));
      if (q.model) conditions.push(eq(aiRequestLogs.routingModel, q.model));
      if (q.subject) conditions.push(eq(aiRequestLogs.subject, q.subject));
      if (q.status) conditions.push(eq(aiRequestLogs.status, q.status));
      if (q.requestSource) conditions.push(eq(aiRequestLogs.requestSource, q.requestSource));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const order =
        q.sort === "oldest"
          ? aiRequestLogs.createdAt
          : q.sort === "latency"
            ? desc(aiRequestLogs.latencyMs)
            : desc(aiRequestLogs.createdAt);

      const rows = db
        .select()
        .from(aiRequestLogs)
        .where(where)
        .orderBy(order)
        .limit(limit)
        .offset((page - 1) * limit)
        .all();

      const totalRow = db
        .select({ count: sql<number>`count(*)` })
        .from(aiRequestLogs)
        .where(where)
        .get();
      return { rows, total: totalRow?.count ?? 0, page, limit };
    },

    /** Aggregate counts grouped by status for a date range (UTC). */
    statusCountsByDate(fromIso: string, toIso: string): Array<{ status: string; n: number }> {
      return db
        .select({
          status: aiRequestLogs.status,
          n: sql<number>`count(*)`
        })
        .from(aiRequestLogs)
        .where(
          and(gte(aiRequestLogs.createdAt, fromIso), lte(aiRequestLogs.createdAt, toIso))
        )
        .groupBy(aiRequestLogs.status)
        .all() as Array<{ status: string; n: number }>;
    },

    /** Group counts by routing provider within a date range. */
    providerCountsByDate(
      fromIso: string,
      toIso: string
    ): Array<{ provider: string; n: number; avgLatency: number }> {
      return db
        .select({
          provider: aiRequestLogs.routingProvider,
          n: sql<number>`count(*)`,
          avgLatency: sql<number>`avg(${aiRequestLogs.latencyMs})`
        })
        .from(aiRequestLogs)
        .where(
          and(gte(aiRequestLogs.createdAt, fromIso), lte(aiRequestLogs.createdAt, toIso))
        )
        .groupBy(aiRequestLogs.routingProvider)
        .all() as Array<{ provider: string; n: number; avgLatency: number }>;
    },

    /** Group counts by subject within a date range. */
    subjectCountsByDate(fromIso: string, toIso: string): Array<{ subject: string; n: number }> {
      return db
        .select({
          subject: aiRequestLogs.subject,
          n: sql<number>`count(*)`
        })
        .from(aiRequestLogs)
        .where(
          and(gte(aiRequestLogs.createdAt, fromIso), lte(aiRequestLogs.createdAt, toIso))
        )
        .groupBy(aiRequestLogs.subject)
        .all() as Array<{ subject: string; n: number }>;
    },

    metricsByDate(fromIso: string, toIso: string): {
      total: number;
      success: number;
      failed: number;
      fallback: number;
      avgLatencyMs: number;
    } {
      const row = db.select({
        total: sql<number>`count(*)`,
        success: sql<number>`sum(CASE WHEN ${aiRequestLogs.status} IN ('success','fallback') THEN 1 ELSE 0 END)`,
        failed: sql<number>`sum(CASE WHEN ${aiRequestLogs.status} IN ('failed','timeout','rejected') THEN 1 ELSE 0 END)`,
        fallback: sql<number>`sum(CASE WHEN ${aiRequestLogs.status} = 'fallback' THEN 1 ELSE 0 END)`,
        avgLatencyMs: sql<number>`coalesce(avg(${aiRequestLogs.latencyMs}),0)`
      }).from(aiRequestLogs).where(
        and(gte(aiRequestLogs.createdAt, fromIso), lte(aiRequestLogs.createdAt, toIso))
      ).get();
      return {
        total: row?.total ?? 0,
        success: row?.success ?? 0,
        failed: row?.failed ?? 0,
        fallback: row?.fallback ?? 0,
        avgLatencyMs: row?.avgLatencyMs ?? 0
      };
    },

    /** Daily aggregates for trend charts. */
    dailyAggregate(
      fromIso: string,
      toIso: string,
      timezoneModifier = "+8 hours"
    ): Array<{
      date: string;
      requestCount: number;
      successCount: number;
      failedCount: number;
      avgLatencyMs: number;
    }> {
      const rows = db
        .select({
          date: sql<string>`date(${aiRequestLogs.createdAt}, ${timezoneModifier})`,
          requestCount: sql<number>`count(*)`,
          successCount: sql<number>`sum(CASE WHEN ${aiRequestLogs.status} IN ('success','fallback') THEN 1 ELSE 0 END)`,
          failedCount: sql<number>`sum(CASE WHEN ${aiRequestLogs.status} IN ('failed','timeout','rejected') THEN 1 ELSE 0 END)`,
          avgLatencyMs: sql<number>`avg(${aiRequestLogs.latencyMs})`
        })
        .from(aiRequestLogs)
        .where(
          and(gte(aiRequestLogs.createdAt, fromIso), lte(aiRequestLogs.createdAt, toIso))
        )
        .groupBy(sql`date(${aiRequestLogs.createdAt}, ${timezoneModifier})`)
        .orderBy(sql`date(${aiRequestLogs.createdAt}, ${timezoneModifier})`)
        .all();
      return rows as Array<{
        date: string;
        requestCount: number;
        successCount: number;
        failedCount: number;
        avgLatencyMs: number;
      }>;
    }
  };
}

export type AiRequestLogRepo = ReturnType<typeof makeAiRequestLogRepo>;
