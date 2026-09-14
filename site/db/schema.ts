import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const students = sqliteTable("students", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("student"),
  isSynthetic: integer("is_synthetic", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const readingProgress = sqliteTable("reading_progress", {
  id: text("id").primaryKey(),
  studentId: text("student_id").notNull(),
  bookId: text("book_id").notNull(),
  progressPercent: integer("progress_percent").notNull().default(0),
  lastReadChapter: text("last_read_chapter"),
  lastReadPage: integer("last_read_page").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

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
});

export const adminOverview = sqliteTable("admin_overview", {
  id: text("id").primaryKey(),
  metricName: text("metric_name").notNull().unique(),
  metricValue: integer("metric_value").notNull().default(0),
  note: text("note").notNull().default(""),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
