import { asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { aiEvaluationIssues } from "../schema";
import { newId } from "./util";

export function makeAiEvaluationIssueRepo(db: Db) {
  return {
    listByRun(runId: string) {
      return db.select().from(aiEvaluationIssues).where(eq(aiEvaluationIssues.runId, runId))
        .orderBy(asc(aiEvaluationIssues.caseId), asc(aiEvaluationIssues.severity)).all();
    },
    createMany(runId: string, rows: Array<Omit<typeof aiEvaluationIssues.$inferInsert, "id" | "runId">>) {
      for (const row of rows) db.insert(aiEvaluationIssues).values({ id: newId("aie-i"), runId, ...row }).run();
      return this.listByRun(runId);
    },
    deleteByRun(runId: string) {
      return db.delete(aiEvaluationIssues).where(eq(aiEvaluationIssues.runId, runId)).run();
    }
  };
}

export type AiEvaluationIssueRepo = ReturnType<typeof makeAiEvaluationIssueRepo>;
