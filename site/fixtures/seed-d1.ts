import { getDb } from "../db";
import { students, books, readingProgress, adminOverview } from "../db/schema";
import { syntheticStudents, syntheticBooks, syntheticProgress } from "./generate";

export async function seedD1(d1Database?: D1Database) {
  const db = getDb(d1Database);

  // Insert students
  for (const s of syntheticStudents) {
    await db
      .insert(students)
      .values({
        id: s.id,
        email: s.email,
        displayName: s.displayName,
        role: s.role,
        isSynthetic: s.isSynthetic,
        createdAt: s.createdAt,
      })
      .onConflictDoNothing();
  }

  // Insert books
  for (const b of syntheticBooks) {
    await db
      .insert(books)
      .values({
        id: b.id,
        title: b.title,
        description: b.description,
        totalChapters: b.totalChapters,
        totalPages: b.totalPages,
        isSynthetic: b.isSynthetic,
        createdAt: b.createdAt,
      })
      .onConflictDoNothing();
  }

  // Insert reading progress
  for (const p of syntheticProgress) {
    await db
      .insert(readingProgress)
      .values({
        id: p.id,
        studentId: p.studentId,
        bookId: p.bookId,
        progressPercent: p.progressPercent,
        lastReadChapter: p.lastReadChapter,
        lastReadPage: p.lastReadPage,
        updatedAt: p.updatedAt,
      })
      .onConflictDoNothing();
  }

  // Insert initial admin overview metrics
  const overviewMetrics = [
    { id: "metric-users", metricName: "總用戶數", metricValue: 93, note: "前台累計使用者" },
    { id: "metric-active", metricName: "活躍用戶", metricValue: 5, note: "最近 15 分鐘活動" },
    { id: "metric-sessions", metricName: "總對話數", metricValue: 93, note: "累計對話 session" },
    { id: "metric-messages", metricName: "總訊息數", metricValue: 107, note: "提問 + 回覆累計" },
  ];

  for (const m of overviewMetrics) {
    await db
      .insert(adminOverview)
      .values(m)
      .onConflictDoNothing();
  }

  console.log("✅ D1 seeded with synthetic fixtures successfully.");
}

if (process.argv[1] && process.argv[1].endsWith("seed-d1.ts")) {
  seedD1().catch((err) => {
    console.error("Seed D1 notice:", err.message);
  });
}
