import { and, count, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client";
import { studentLearningHistory, studentUsers } from "../schema";

export interface LearningHistoryRecord {
  id: string;
  askedAt: string;
  question: string;
  category: string;
  sourceType: "manual" | "image" | "file";
  strategy: "google-ai" | "api";
  answer?: string;
  answerUpdatedAt?: string;
  rawAnswer?: string;
  rawAnswerCapturedAt?: string;
  sourceUrl?: string;
  organizedAnswer?: string;
  syncVersion: number;
}

function publicRecord(row: typeof studentLearningHistory.$inferSelect) {
  return {
    id: row.entryId,
    askedAt: row.askedAt,
    question: row.question,
    category: row.category,
    sourceType: row.sourceType,
    strategy: row.strategy,
    answer: row.answer ?? undefined,
    answerUpdatedAt: row.answerUpdatedAt ?? undefined,
    rawAnswer: row.rawAnswer ?? undefined,
    rawAnswerCapturedAt: row.rawAnswerCapturedAt ?? undefined,
    sourceUrl: row.sourceUrl ?? undefined,
    organizedAnswer: row.organizedAnswer ?? undefined,
    syncVersion: row.syncVersion,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt
  };
}

/**
 * Content equality for one stored row and one incoming record.
 *
 * `syncVersion` is the only ordering signal, so an equal version only means
 * "nothing to do" when the payload is also identical. Two devices that edit
 * the same base version produce different payloads at the same version.
 */
function sameLearningHistoryPayload(
  row: typeof studentLearningHistory.$inferSelect,
  entry: LearningHistoryRecord
): boolean {
  const same = (stored: string | null, incoming: string | undefined) => (stored ?? undefined) === (incoming ?? undefined);
  return row.askedAt === entry.askedAt
    && row.question === entry.question
    && row.category === entry.category
    && row.sourceType === entry.sourceType
    && row.strategy === entry.strategy
    && same(row.answer, entry.answer)
    && same(row.answerUpdatedAt, entry.answerUpdatedAt)
    && same(row.rawAnswer, entry.rawAnswer)
    && same(row.rawAnswerCapturedAt, entry.rawAnswerCapturedAt)
    && same(row.sourceUrl, entry.sourceUrl)
    && same(row.organizedAnswer, entry.organizedAnswer);
}

export function makeStudentLearningHistoryRepo(db: Db) {
  return {
    listStudent(studentId: string, offset = 0, limit = 100) {
      return db.select().from(studentLearningHistory)
        .where(eq(studentLearningHistory.studentId, studentId))
        .orderBy(desc(studentLearningHistory.askedAt), desc(studentLearningHistory.entryId))
        .limit(limit).offset(offset).all().map(publicRecord);
    },
    upsertBatch(studentId: string, entries: LearningHistoryRecord[]) {
      const now = new Date().toISOString();
      return db.transaction((tx) => {
        for (const entry of entries) {
          const values = {
            askedAt: entry.askedAt,
            question: entry.question,
            category: entry.category,
            sourceType: entry.sourceType,
            strategy: entry.strategy,
            answer: entry.answer ?? null,
            answerUpdatedAt: entry.answerUpdatedAt ?? null,
            rawAnswer: entry.rawAnswer ?? null,
            rawAnswerCapturedAt: entry.rawAnswerCapturedAt ?? null,
            sourceUrl: entry.sourceUrl ?? null,
            organizedAnswer: entry.organizedAnswer ?? null
          };
          const key = and(
            eq(studentLearningHistory.studentId, studentId),
            eq(studentLearningHistory.entryId, entry.id)
          );
          const existing = tx.select().from(studentLearningHistory).where(key).get();
          if (!existing) {
            tx.insert(studentLearningHistory).values({
              studentId,
              entryId: entry.id,
              ...values,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
              syncVersion: entry.syncVersion
            }).run();
            continue;
          }
          // A tombstone always wins: a stale client must not resurrect a deleted entry.
          if (existing.deletedAt !== null) continue;
          if (entry.syncVersion > existing.syncVersion) {
            tx.update(studentLearningHistory).set({ ...values, updatedAt: now, syncVersion: entry.syncVersion })
              .where(key).run();
            continue;
          }
          // Equal versions are only idempotent when the payload matches. When it
          // differs, the strict `<` guard would silently drop this writer's edit
          // and the client would merge the other device's row over it, so
          // allocate the next version and apply the incoming payload instead.
          if (entry.syncVersion === existing.syncVersion && !sameLearningHistoryPayload(existing, entry)) {
            tx.update(studentLearningHistory).set({ ...values, updatedAt: now, syncVersion: existing.syncVersion + 1 })
              .where(and(key, eq(studentLearningHistory.syncVersion, existing.syncVersion))).run();
          }
        }
        return entries.map((entry) => {
          const row = tx.select().from(studentLearningHistory).where(and(
            eq(studentLearningHistory.studentId, studentId),
            eq(studentLearningHistory.entryId, entry.id)
          )).get();
          return row ? publicRecord(row) : undefined;
        }).filter((row) => row !== undefined);
      });
    },
    tombstone(studentId: string, entryId: string, syncVersion: number) {
      const where = and(eq(studentLearningHistory.studentId, studentId), eq(studentLearningHistory.entryId, entryId));
      const existing = db.select().from(studentLearningHistory).where(where).get();
      if (!existing) return undefined;
      if (syncVersion > existing.syncVersion) {
        const now = new Date().toISOString();
        db.update(studentLearningHistory).set({
          deletedAt: now, updatedAt: now, syncVersion,
          question: "", category: "auto", sourceType: "manual", strategy: "api",
          answer: null, answerUpdatedAt: null, rawAnswer: null, rawAnswerCapturedAt: null,
          organizedAnswer: null, sourceUrl: null
        }).where(and(where, sql`${studentLearningHistory.syncVersion} < ${syncVersion}`)).run();
      }
      const row = db.select().from(studentLearningHistory).where(where).get();
      return row ? publicRecord(row) : undefined;
    },
    listAdmin(input: {
      q?: string; strategy?: "google-ai" | "api"; sourceType?: "manual" | "image" | "file";
      from?: string; to?: string; status?: "active" | "deleted"; offset: number; limit: number;
    }) {
      const predicates: SQL[] = [];
      if (input.q) {
        const pattern = `%${input.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        predicates.push(or(
          sql`${studentLearningHistory.question} LIKE ${pattern} ESCAPE '\\'`,
          sql`${studentUsers.displayName} LIKE ${pattern} ESCAPE '\\'`
        )!);
      }
      if (input.strategy) predicates.push(eq(studentLearningHistory.strategy, input.strategy));
      if (input.sourceType) predicates.push(eq(studentLearningHistory.sourceType, input.sourceType));
      if (input.from) predicates.push(gte(studentLearningHistory.askedAt, new Date(`${input.from}T00:00:00+08:00`).toISOString()));
      if (input.to) predicates.push(lte(studentLearningHistory.askedAt, new Date(`${input.to}T23:59:59.999+08:00`).toISOString()));
      if (input.status) predicates.push(input.status === "deleted" ? sql`${studentLearningHistory.deletedAt} IS NOT NULL` : sql`${studentLearningHistory.deletedAt} IS NULL`);
      const where = predicates.length ? and(...predicates) : undefined;
      const rows = db.select({ history: studentLearningHistory, student: studentUsers })
        .from(studentLearningHistory)
        .leftJoin(studentUsers, eq(studentUsers.id, studentLearningHistory.studentId))
        .where(where)
        .orderBy(desc(studentLearningHistory.askedAt), desc(studentLearningHistory.entryId))
        .limit(input.limit).offset(input.offset).all();
      const total = db.select({ value: count() }).from(studentLearningHistory)
        .leftJoin(studentUsers, eq(studentUsers.id, studentLearningHistory.studentId)).where(where).get()?.value ?? 0;
      return {
        total,
        entries: rows.map(({ history, student }) => ({
          id: history.entryId,
          studentId: history.studentId,
          student: student?.displayName ?? "已移除學員",
          askedAt: history.askedAt,
          questionSummary: history.question.slice(0, 120),
          strategy: history.strategy,
          sourceType: history.sourceType,
          hasRawAnswer: Boolean(history.rawAnswer),
          answerSummary: history.answer ? history.answer.slice(0, 120) : history.rawAnswer ? "已保存原始回覆（詳情可檢視）" : "",
          updatedAt: history.updatedAt,
          deletedAt: history.deletedAt,
          syncVersion: history.syncVersion
        }))
      };
    },
    adminDetail(studentId: string, entryId: string) {
      const row = db.select({ history: studentLearningHistory, student: studentUsers })
        .from(studentLearningHistory)
        .leftJoin(studentUsers, eq(studentUsers.id, studentLearningHistory.studentId))
        .where(and(eq(studentLearningHistory.studentId, studentId), eq(studentLearningHistory.entryId, entryId))).get();
      return row ? { ...publicRecord(row.history), studentId, student: row.student?.displayName ?? "已移除學員" } : undefined;
    }
  };
}

export type StudentLearningHistoryRepo = ReturnType<typeof makeStudentLearningHistoryRepo>;
