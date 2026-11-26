import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client";
import { studentNotes } from "../schema";
import type { LearningHistoryRecord } from "./studentLearningHistory.repo";
import { newId, nowIso } from "./util";

export type StudentNoteType = "text" | "ai_answer" | "canvas";
export type StudentNoteSource = "manual" | "google-ai-relay" | "gemini-api";

/** Parsed student note as returned by every read method (`tags` is decoded). */
export interface StudentNoteRecord {
  id: string;
  studentId: string;
  entryId: string | null;
  bookId: string | null;
  chapterId: string | null;
  pageNumber: number | null;
  type: StudentNoteType;
  title: string;
  content: string;
  canvasData: string | null;
  tags: string[];
  source: StudentNoteSource;
  sourceDetail: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  syncVersion: number;
}

export interface CreateStudentNoteInput {
  type?: StudentNoteType;
  title?: string;
  content?: string;
  canvasData?: string | null;
  tags?: string[];
  bookId?: string | null;
  chapterId?: string | null;
  pageNumber?: number | null;
  entryId?: string | null;
  source?: StudentNoteSource;
  sourceDetail?: string | null;
}

export interface UpdateStudentNoteInput {
  title?: string;
  content?: string;
  canvasData?: string | null;
  tags?: string[];
  chapterId?: string | null;
  pageNumber?: number | null;
}

export interface FromHistoryPatch {
  title?: string;
  note?: string;
  tags?: string[];
  bookId?: string | null;
  chapterId?: string | null;
  pageNumber?: number | null;
}

type StudentNoteRow = typeof studentNotes.$inferSelect;

/** `tags` is stored as a JSON string array; malformed or legacy values decode to []. */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    return [];
  }
}

function publicRecord(row: StudentNoteRow): StudentNoteRecord {
  return {
    id: row.id,
    studentId: row.studentId,
    entryId: row.entryId,
    bookId: row.bookId,
    chapterId: row.chapterId,
    pageNumber: row.pageNumber,
    type: row.type as StudentNoteType,
    title: row.title,
    content: row.content,
    canvasData: row.canvasData,
    tags: parseTags(row.tags),
    source: row.source as StudentNoteSource,
    sourceDetail: row.sourceDetail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    syncVersion: row.syncVersion
  };
}

function serializeTags(tags: string[] | undefined): string | null {
  return tags === undefined ? null : JSON.stringify(tags);
}

/**
 * Student note repository. Every method takes `studentId` as its first
 * parameter and every query filters on `student_id = studentId`, so one
 * student can never read, edit or delete another student's notes (IDOR).
 */
export function makeStudentNoteRepo(db: Db) {
  const byStudent = (studentId: string) => eq(studentNotes.studentId, studentId);

  /** Revive a tombstoned note (or return the live one) for an identical entry. */
  const reviveOrReturn = (studentId: string, existing: StudentNoteRow, values: {
    type: StudentNoteType;
    title: string;
    content: string;
    canvasData: string | null;
    tags: string | null;
    bookId: string | null;
    chapterId: string | null;
    pageNumber: number | null;
    source: StudentNoteSource;
    sourceDetail: string | null;
  }): StudentNoteRecord => {
    if (existing.deletedAt === null) return publicRecord(existing);
    const now = nowIso();
    db.update(studentNotes).set({
      ...values,
      deletedAt: null,
      updatedAt: now,
      syncVersion: existing.syncVersion + 1
    }).where(and(byStudent(studentId), eq(studentNotes.id, existing.id))).run();
    const revived = db.select().from(studentNotes)
      .where(and(byStudent(studentId), eq(studentNotes.id, existing.id))).get();
    return publicRecord(revived ?? existing);
  };

  const fromHistoryRow = (entry: LearningHistoryRecord, patch?: FromHistoryPatch) => {
    const content = patch?.note ?? entry.organizedAnswer ?? entry.answer ?? entry.rawAnswer ?? entry.question;
    const title = patch?.title ?? entry.question.slice(0, 80);
    return {
      title,
      content,
      canvasData: null,
      tags: serializeTags(patch?.tags),
      bookId: patch?.bookId ?? null,
      chapterId: patch?.chapterId ?? null,
      pageNumber: patch?.pageNumber ?? null,
      type: "ai_answer" as const,
      source: (entry.strategy === "google-ai" ? "google-ai-relay" : "gemini-api") as StudentNoteSource,
      sourceDetail: entry.sourceUrl ?? null
    };
  };

  return {
    list(
      studentId: string,
      options?: {
        offset?: number;
        limit?: number;
        includeDeleted?: boolean;
        bookId?: string;
        tag?: string;
        q?: string;
      }
    ): StudentNoteRecord[] {
      const predicates: SQL[] = [byStudent(studentId)];
      if (options?.bookId !== undefined) predicates.push(eq(studentNotes.bookId, options.bookId));
      if (!options?.includeDeleted) predicates.push(sql`${studentNotes.deletedAt} IS NULL`);
      const where = and(...predicates);
      const query = db.select().from(studentNotes).where(where)
        .orderBy(desc(studentNotes.createdAt), desc(studentNotes.id));
      const tag = options?.tag?.trim();
      const q = options?.q?.trim().toLowerCase();
      if (!tag && !q) {
        return query.limit(options?.limit ?? 100)
          .offset(options?.offset ?? 0)
          .all().map(publicRecord);
      }

      const filtered = query.all().filter((row) => {
        if (tag && !parseTags(row.tags).includes(tag)) return false;
        if (q && !row.title.toLowerCase().includes(q) && !row.content.toLowerCase().includes(q)) return false;
        return true;
      });
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? 100;
      return filtered.slice(offset, offset + limit).map(publicRecord);
    },

    findById(studentId: string, id: string, includeDeleted?: boolean): StudentNoteRecord | null {
      const predicates: SQL[] = [byStudent(studentId), eq(studentNotes.id, id)];
      if (!includeDeleted) predicates.push(sql`${studentNotes.deletedAt} IS NULL`);
      const row = db.select().from(studentNotes).where(and(...predicates)).get();
      return row ? publicRecord(row) : null;
    },

    /** The student's live (non-deleted) note mapped to a learning-history entry. */
    findByEntry(studentId: string, entryId: string): StudentNoteRecord | null {
      const row = db.select().from(studentNotes)
        .where(and(
          byStudent(studentId),
          eq(studentNotes.entryId, entryId),
          sql`${studentNotes.deletedAt} IS NULL`
        ))
        .get();
      return row ? publicRecord(row) : null;
    },

    create(studentId: string, input: CreateStudentNoteInput): StudentNoteRecord {
      const now = nowIso();
      const values = {
        entryId: input.entryId ?? null,
        bookId: input.bookId ?? null,
        chapterId: input.chapterId ?? null,
        pageNumber: input.pageNumber ?? null,
        type: input.type ?? "text",
        title: input.title ?? "",
        content: input.content ?? "",
        canvasData: input.canvasData ?? null,
        tags: serializeTags(input.tags),
        source: input.source ?? "manual",
        sourceDetail: input.sourceDetail ?? null
      };
      const row = {
        id: newId("snote"),
        studentId,
        ...values,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        syncVersion: 1
      };
      if (row.entryId !== null) {
        const key = and(byStudent(studentId), eq(studentNotes.entryId, row.entryId));
        const existing = db.select().from(studentNotes).where(key).get();
        if (existing) return reviveOrReturn(studentId, existing, values);
        try {
          db.insert(studentNotes).values(row).run();
        } catch (error) {
          if (!String((error as Error).message).includes("UNIQUE")) throw error;
          const raced = db.select().from(studentNotes).where(key).get();
          if (!raced) throw error;
          return reviveOrReturn(studentId, raced, values);
        }
      } else {
        db.insert(studentNotes).values(row).run();
      }
      return publicRecord(row);
    },

    /**
     * Snapshot a learning-history entry into an AI-answer note. Idempotent per
     * `(studentId, entry.id)`: a retry returns the existing note; if the old
     * row was tombstoned it is revived with `syncVersion + 1`, never duplicated.
     */
    fromHistory(
      studentId: string,
      entry: LearningHistoryRecord,
      patch?: FromHistoryPatch
    ): StudentNoteRecord {
      const values = fromHistoryRow(entry, patch);
      const key = and(byStudent(studentId), eq(studentNotes.entryId, entry.id));
      const existing = db.select().from(studentNotes).where(key).get();
      if (existing) return reviveOrReturn(studentId, existing, values);

      const now = nowIso();
      try {
        db.insert(studentNotes).values({
          ...values,
          id: newId("snote"),
          studentId,
          entryId: entry.id,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncVersion: 1
        }).run();
      } catch (error) {
        // Lost a race against a concurrent import of the same entry: merge onto
        // the winner instead of surfacing SQLITE_CONSTRAINT_UNIQUE to the caller.
        if (!String((error as Error).message).includes("UNIQUE")) throw error;
        const raced = db.select().from(studentNotes).where(key).get();
        if (!raced) throw error;
        return reviveOrReturn(studentId, raced, values);
      }
      const inserted = db.select().from(studentNotes).where(key).get();
      if (!inserted) throw new Error("student note insert vanished");
      return publicRecord(inserted);
    },

    /** Update a live note; tombstoned or foreign notes are unreachable (`null`). */
    update(studentId: string, id: string, input: UpdateStudentNoteInput): StudentNoteRecord | null {
      const key = and(byStudent(studentId), eq(studentNotes.id, id));
      const existing = db.select().from(studentNotes)
        .where(and(key, sql`${studentNotes.deletedAt} IS NULL`)).get();
      if (!existing) return null;
      const set: Partial<StudentNoteRow> = {
        updatedAt: nowIso(),
        syncVersion: existing.syncVersion + 1
      };
      if (input.title !== undefined) set.title = input.title;
      if (input.content !== undefined) set.content = input.content;
      if (input.canvasData !== undefined) set.canvasData = input.canvasData;
      if (input.tags !== undefined) set.tags = serializeTags(input.tags);
      if (input.chapterId !== undefined) set.chapterId = input.chapterId;
      if (input.pageNumber !== undefined) set.pageNumber = input.pageNumber;
      db.update(studentNotes).set(set).where(key).run();
      const updated = db.select().from(studentNotes).where(key).get();
      return updated ? publicRecord(updated) : null;
    },

    /**
     * Tombstone a note. With `syncVersion`, the caller must not be behind the
     * stored version; a stale upload is ignored (the row is returned as-is).
     */
    tombstone(studentId: string, id: string, syncVersion?: number): StudentNoteRecord | null {
      const key = and(byStudent(studentId), eq(studentNotes.id, id));
      const existing = db.select().from(studentNotes).where(key).get();
      if (!existing) return null;
      if (syncVersion !== undefined && syncVersion < existing.syncVersion) {
        return publicRecord(existing);
      }
      const nextVersion = syncVersion !== undefined ? syncVersion : existing.syncVersion + 1;
      db.update(studentNotes).set({
        deletedAt: nowIso(),
        updatedAt: nowIso(),
        syncVersion: nextVersion
      }).where(key).run();
      const row = db.select().from(studentNotes).where(key).get();
      return row ? publicRecord(row) : null;
    }
  };
}

export type StudentNoteRepo = ReturnType<typeof makeStudentNoteRepo>;
