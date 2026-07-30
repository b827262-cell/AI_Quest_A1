import { asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { aiEvaluationMetrics } from "../schema";
import { newId } from "./util";

export function makeAiEvaluationMetricRepo(db: Db) {
  return {
    listByRun(runId: string) {
      return db.select().from(aiEvaluationMetrics).where(eq(aiEvaluationMetrics.runId, runId))
        .orderBy(asc(aiEvaluationMetrics.dimension), asc(aiEvaluationMetrics.dimensionValue)).all();
    },
    createMany(runId: string, rows: Array<Omit<typeof aiEvaluationMetrics.$inferInsert, "id" | "runId">>) {
      for (const row of rows) db.insert(aiEvaluationMetrics).values({ id: newId("aie-m"), runId, ...row }).run();
      return this.listByRun(runId);
    },
    deleteByRun(runId: string) {
      return db.delete(aiEvaluationMetrics).where(eq(aiEvaluationMetrics.runId, runId)).run();
    }
  };
}

export type AiEvaluationMetricRepo = ReturnType<typeof makeAiEvaluationMetricRepo>;
