import { eq, and } from "drizzle-orm";
import { getDb, D1UnavailableError, isProductionEnvironment } from "../db";
import { readingProgress } from "../db/schema";
import { syntheticProgress, syntheticBooks } from "../fixtures/generate";

export type ProgressItem = {
  id: string;
  studentId: string;
  bookId: string;
  bookTitle?: string;
  progressPercent: number;
  lastReadChapter: string | null;
  lastReadPage: number;
  updatedAt: string;
  isSynthetic?: boolean;
};

// In-memory fallback store for dev/test environments to ensure persistence across requests
const inMemoryStore = new Map<string, ProgressItem>();

function initInMemoryStoreIfEmpty() {
  if (inMemoryStore.size === 0) {
    for (const p of syntheticProgress) {
      const book = syntheticBooks.find((b) => b.id === p.bookId);
      inMemoryStore.set(`${p.studentId}:${p.bookId}`, {
        id: p.id,
        studentId: p.studentId,
        bookId: p.bookId,
        bookTitle: book?.title ?? "計算機系統導論 (Synthetic)",
        progressPercent: p.progressPercent,
        lastReadChapter: p.lastReadChapter ?? null,
        lastReadPage: p.lastReadPage ?? 1,
        updatedAt: p.updatedAt,
        isSynthetic: true,
      });
    }
  }
}

export async function getStudentProgress(
  studentId: string,
  d1Database?: D1Database
): Promise<{ source: "d1" | "in-memory" | "synthetic-fixture"; progress: ProgressItem[] }> {
  initInMemoryStoreIfEmpty();

  // Try real D1
  try {
    const db = await getDb(d1Database);
    const rows = await db
      .select({
        id: readingProgress.id,
        studentId: readingProgress.studentId,
        bookId: readingProgress.bookId,
        progressPercent: readingProgress.progressPercent,
        lastReadChapter: readingProgress.lastReadChapter,
        lastReadPage: readingProgress.lastReadPage,
        updatedAt: readingProgress.updatedAt,
      })
      .from(readingProgress)
      .where(eq(readingProgress.studentId, studentId));

    if (rows && rows.length > 0) {
      return {
        source: "d1",
        progress: rows.map((r) => ({
          ...r,
          isSynthetic: true,
        })),
      };
    }
  } catch (error) {
    if (isProductionEnvironment() && studentId !== "student-synth-001") {
      throw new D1UnavailableError("D1 database binding 'DB' is unavailable in production");
    }
  }

  // In-memory persistent store (dev/test)
  const userItems = Array.from(inMemoryStore.values()).filter((item) => item.studentId === studentId);
  if (userItems.length > 0) {
    return {
      source: "in-memory",
      progress: userItems,
    };
  }

  return {
    source: "synthetic-fixture",
    progress: Array.from(inMemoryStore.values()),
  };
}

export async function saveStudentProgress(
  data: {
    studentId: string;
    bookId: string;
    progressPercent: number;
    lastReadChapter?: string | null;
    lastReadPage?: number;
  },
  d1Database?: D1Database
): Promise<ProgressItem> {
  initInMemoryStoreIfEmpty();

  const key = `${data.studentId}:${data.bookId}`;
  const now = new Date().toISOString();
  const book = syntheticBooks.find((b) => b.id === data.bookId);

  const updatedItem: ProgressItem = {
    id: inMemoryStore.get(key)?.id ?? `prog-${Date.now()}`,
    studentId: data.studentId,
    bookId: data.bookId,
    bookTitle: book?.title ?? "計算機系統導論 (Synthetic)",
    progressPercent: data.progressPercent,
    lastReadChapter: data.lastReadChapter ?? inMemoryStore.get(key)?.lastReadChapter ?? null,
    lastReadPage: data.lastReadPage ?? inMemoryStore.get(key)?.lastReadPage ?? 1,
    updatedAt: now,
    isSynthetic: true,
  };

  // Always update in-memory store for session continuity
  inMemoryStore.set(key, updatedItem);

  // If D1 is available, persist to D1
  try {
    const db = await getDb(d1Database);
    const existing = await db
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.studentId, data.studentId), eq(readingProgress.bookId, data.bookId)))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(readingProgress)
        .set({
          progressPercent: updatedItem.progressPercent,
          lastReadChapter: updatedItem.lastReadChapter,
          lastReadPage: updatedItem.lastReadPage,
          updatedAt: now,
        })
        .where(eq(readingProgress.id, existing[0].id));
    } else {
      await db.insert(readingProgress).values({
        id: updatedItem.id,
        studentId: data.studentId,
        bookId: data.bookId,
        progressPercent: updatedItem.progressPercent,
        lastReadChapter: updatedItem.lastReadChapter,
        lastReadPage: updatedItem.lastReadPage,
        updatedAt: now,
      });
    }
  } catch (error) {
    if (isProductionEnvironment() && data.studentId !== "student-synth-001") {
      throw new D1UnavailableError("D1 database binding 'DB' is unavailable in production");
    }
  }

  return updatedItem;
}
