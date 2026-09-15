import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const syncColumns = {
  sourceSystem: text("source_system"),
  sourceRecordId: text("source_record_id"),
  sourceUpdatedAt: text("source_updated_at"),
  syncVersion: integer("sync_version"),
  checksum: text("checksum"),
};

export const students = sqliteTable("students", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("student"),
  isSynthetic: integer("is_synthetic", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ...syncColumns,
}, (table) => ({
  sourceIdentity: uniqueIndex("uq_students_source_identity").on(table.sourceSystem, table.sourceRecordId),
}));

export const readingProgress = sqliteTable("reading_progress", {
  id: text("id").primaryKey(),
  studentId: text("student_id").notNull(),
  bookId: text("book_id").notNull(),
  progressPercent: integer("progress_percent").notNull().default(0),
  lastReadChapter: text("last_read_chapter"),
  lastReadPage: integer("last_read_page").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ...syncColumns,
}, (table) => ({
  sourceIdentity: uniqueIndex("uq_progress_source_identity").on(table.sourceSystem, table.sourceRecordId),
  studentBook: uniqueIndex("uq_progress_student_book").on(table.studentId, table.bookId),
}));

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  totalChapters: integer("total_chapters").notNull().default(1),
  totalPages: integer("total_pages").notNull().default(100),
  isSynthetic: integer("is_synthetic", { mode: "boolean" }).notNull().default(true),
  objectKey: text("object_key").default(""),
  contentType: text("content_type").notNull().default("application/pdf"),
  byteSize: integer("byte_size").notNull().default(0),
  sha256: text("sha256").default(""),
  storageState: text("storage_state").notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ...syncColumns,
}, (table) => ({
  sourceIdentity: uniqueIndex("uq_books_source_identity").on(table.sourceSystem, table.sourceRecordId),
}));

export const adminOverview = sqliteTable("admin_overview", {
  id: text("id").primaryKey(),
  metricName: text("metric_name").notNull().unique(),
  metricValue: integer("metric_value").notNull().default(0),
  note: text("note").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ...syncColumns,
});

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  status: text("status").notNull().default("running"),
  dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
  total: integer("total").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  conflicts: integer("conflicts").notNull().default(0),
  failed: integer("failed").notNull().default(0),
});

export const syncItems = sqliteTable("sync_items", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  entityType: text("entity_type").notNull(),
  sourceRecordId: text("source_record_id").notNull(),
  targetRecordId: text("target_record_id"),
  operation: text("operation").notNull(),
  checksum: text("checksum").notNull(),
  sourceVersion: integer("source_version"),
  status: text("status").notNull(),
  error: text("error"),
}, (table) => ({
  run: index("idx_sync_items_run").on(table.runId),
  conflicts: index("idx_sync_items_conflicts").on(table.status),
}));

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  result: text("result").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const syncNonces = sqliteTable("sync_nonces", {
  nonce: text("nonce").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});
