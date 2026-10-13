import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExamCourseRecordV1 } from "@ai-smartbook/contracts";
import type { ExamSnapshotFailure } from "./ibrain-crawl";

/**
 * Raw snapshot layout: data/snapshots/ibrain/<YYYY-MM-DD>/courses.jsonl plus
 * manifest.json. A snapshot directory is never deleted or truncated by an
 * update — writers only add files, and readers only pick a directory.
 */

export const SNAPSHOT_ROOT_RELATIVE = join("data", "snapshots", "ibrain");

export type ExamSnapshotCounts = Readonly<{
  records: number;
  by_exam_year: Readonly<Record<string, number>>;
  by_category: Readonly<Record<string, number>>;
}>;

export type ExamSnapshotManifest = Readonly<{
  snapshot_date: string;
  source_host: string;
  generated_at: string;
  scope: Readonly<{ exam_years: readonly number[]; tiers: readonly string[]; seed_pages: number }>;
  counts: ExamSnapshotCounts;
  crawl: Readonly<{
    listing_pages_fetched: number;
    candidate_links: number;
    detail_pages_fetched: number;
    skipped_out_of_scope: number;
  }>;
  failures: readonly ExamSnapshotFailure[];
  files: Readonly<{ raw: string; manifest: string }>;
}>;

export function taipeiDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function taipeiTimestamp(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now).replace(",", "T") + "+08:00";
}

export function snapshotDirectory(root: string, snapshotDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) throw new Error(`invalid snapshot date: ${snapshotDate}`);
  return resolve(root, SNAPSHOT_ROOT_RELATIVE, snapshotDate);
}

export function countSnapshotRecords(records: readonly ExamCourseRecordV1[]): ExamSnapshotCounts {
  const byExamYear: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const record of records) {
    byExamYear[String(record.exam_year)] = (byExamYear[String(record.exam_year)] ?? 0) + 1;
    byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
  }
  return { records: records.length, by_exam_year: byExamYear, by_category: byCategory };
}

export function writeSnapshot(options: {
  root: string;
  snapshotDate: string;
  records: readonly ExamCourseRecordV1[];
  failures: readonly ExamSnapshotFailure[];
  crawl: ExamSnapshotManifest["crawl"];
  seedPages: number;
  generatedAt?: string;
}): { directory: string; rawPath: string; manifestPath: string; manifest: ExamSnapshotManifest } {
  const directory = snapshotDirectory(options.root, options.snapshotDate);
  mkdirSync(directory, { recursive: true });
  const rawPath = join(directory, "courses.jsonl");
  const manifestPath = join(directory, "manifest.json");
  const body = options.records.map((record) => JSON.stringify(record)).join("\n");
  writeFileSync(rawPath, body ? `${body}\n` : "", "utf8");
  const manifest: ExamSnapshotManifest = {
    snapshot_date: options.snapshotDate,
    source_host: "ec.ibrain.com.tw",
    generated_at: options.generatedAt ?? taipeiTimestamp(),
    scope: {
      exam_years: [115, 116],
      tiers: ["高考", "普考", "高普考共同科目"],
      seed_pages: options.seedPages
    },
    counts: countSnapshotRecords(options.records),
    crawl: options.crawl,
    failures: options.failures,
    files: { raw: "courses.jsonl", manifest: "manifest.json" }
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { directory, rawPath, manifestPath, manifest };
}

export type LoadedSnapshot = Readonly<{
  snapshotDate: string;
  records: ExamCourseRecordV1[];
  manifest: ExamSnapshotManifest | null;
}>;

export function loadSnapshot(options: { root: string; snapshotDate?: string }): LoadedSnapshot | null {
  const root = resolve(options.root, SNAPSHOT_ROOT_RELATIVE);
  if (!existsSync(root)) return null;
  const snapshotDate = options.snapshotDate ?? listSnapshotDates(options.root).at(-1);
  if (!snapshotDate) return null;
  const directory = join(root, snapshotDate);
  const rawPath = join(directory, "courses.jsonl");
  if (!existsSync(rawPath)) return null;
  const records = readFileSync(rawPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExamCourseRecordV1);
  const manifestPath = join(directory, "manifest.json");
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, "utf8")) as ExamSnapshotManifest) : null;
  return { snapshotDate, records, manifest };
}

export function listSnapshotDates(root: string): string[] {
  const directory = resolve(root, SNAPSHOT_ROOT_RELATIVE);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort();
}
