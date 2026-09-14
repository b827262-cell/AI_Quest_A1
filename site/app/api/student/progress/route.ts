import { getAuthFromRequest } from "../../auth-helper";
import { getDb } from "../../../../db";
import { readingProgress, books } from "../../../../db/schema";
import { eq } from "drizzle-orm";
import { syntheticProgress, syntheticBooks } from "../../../../fixtures/generate";

export async function GET(request: Request) {
  const auth = getAuthFromRequest(request);
  const targetStudentId = auth.userId ?? "student-synth-001";

  try {
    const db = await getDb();
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
      .where(eq(readingProgress.studentId, targetStudentId));

    if (rows && rows.length > 0) {
      return Response.json({
        studentId: targetStudentId,
        source: "d1",
        progress: rows.map((r) => ({ ...r, isSynthetic: true })),
      });
    }
  } catch {
    // Graceful fallback to deterministic synthetic fixtures when D1 is unmigrated or in offline mode
  }

  // Deterministic synthetic fixture response
  const matched = syntheticProgress.filter((p) => p.studentId === targetStudentId);
  const resultProgress = matched.length > 0 ? matched : syntheticProgress;

  return Response.json({
    studentId: targetStudentId,
    source: "synthetic-fixture",
    progress: resultProgress.map((p) => {
      const book = syntheticBooks.find((b) => b.id === p.bookId);
      return {
        ...p,
        bookTitle: book?.title ?? "計算機系統導論 (Synthetic)",
      };
    }),
  });
}
