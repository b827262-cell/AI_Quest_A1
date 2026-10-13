/**
 * Slot D admin read/write model for 高普考資料快照.
 *
 * Everything that decides *what a course row is* belongs to Slot B and is reused
 * here unchanged: `runExamSnapshotCrawl` (parser + bounded seed list),
 * `validateExamSnapshot` (contract checks) and `upsertExamCourses`
 * (content_hash-guarded write). This module only decides *when* to run them, what
 * to report, and — the part that matters most — that a run which could not fetch
 * or could not write reports a failure instead of an empty success.
 *
 * `row_count: null` and `last_snapshot_at: null` are therefore meaningful: they
 * mean "the database did not answer", which is distinct from "0 rows today".
 */

import {
  EXAM_COURSE_ALLOWED_CATEGORIES,
  EXAM_COURSE_RECORD_COLUMNS,
  EXAM_COURSE_SNAPSHOT_SCHEMA_VERSION,
  EXAM_COURSE_YEARS,
  upsertExamCourses,
  validateExamSnapshot,
  type ExamCourseRecord,
  type ExamCourseUpsertResult,
  type ExamSnapshotValidationReport,
  type SqlExecutor
} from "@ai-smartbook/db";
import {
  EXAM_SNAPSHOT_YEARS,
  deriveExamSnapshotStatus,
  taipeiDateKey,
  type ExamSnapshotListResponse,
  type ExamSnapshotRefreshResponse,
  type ExamSnapshotRow,
  type ExamSnapshotYear
} from "../../exam-snapshots-contract";
import { runExamSnapshotCrawl, IBRAIN_ORIGIN, type ExamSnapshotCrawlResult } from "./ibrain-crawl";
import { resolveExamDatabase, type ExamDatabaseResolution } from "./postgres";

/** Durable per-year outcome of the last refresh, so `last_error` survives a restart. */
export const EXAM_SNAPSHOT_LEDGER_KEY = "exam_snapshot_attempts_v1";

/**
 * A read-only aggregate over Slot B's table. The columns already exist; no second
 * schema is introduced for the admin view.
 */
export const EXAM_SNAPSHOT_READ_SQL = [
  "SELECT count(*) AS row_count, max(fetched_at) AS last_snapshot_at",
  "FROM exam_courses",
  "WHERE exam_year = $1::smallint AND category = $2"
].join("\n");

export const EXAM_SNAPSHOT_CATEGORY = EXAM_COURSE_ALLOWED_CATEGORIES[0];

const DEFAULT_MAX_DETAIL_PAGES = 80;
const DEFAULT_DELAY_MS = 80;
const MAX_RECEIPTS = 64;

export interface ExamSnapshotSettings {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface ExamSnapshotAttempt {
  last_error: string | null;
  last_attempt_at: string;
}

type ExamSnapshotLedger = Partial<Record<ExamSnapshotYear, ExamSnapshotAttempt>>;

export class ExamSnapshotServiceError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    readonly errorCount: number,
    readonly changedCount = 0
  ) {
    super(code);
    this.name = "ExamSnapshotServiceError";
  }
}

export interface ExamSnapshotServiceOptions {
  env?: NodeJS.ProcessEnv;
  settings?: ExamSnapshotSettings;
  resolveDatabase?: (env: NodeJS.ProcessEnv) => Promise<ExamDatabaseResolution>;
  crawl?: (options: { maxDetailPages: number; delayMs: number; fetchedAt: string }) => Promise<ExamSnapshotCrawlResult>;
  now?: () => Date;
}

export interface ExamSnapshotService {
  listSnapshots(): Promise<ExamSnapshotListResponse>;
  refreshToday(year: string, idempotencyKey: string): Promise<ExamSnapshotRefreshResponse>;
}

function examYearNumber(year: string): number | null {
  const parsed = Number(year);
  return Number.isInteger(parsed) && (EXAM_COURSE_YEARS as readonly number[]).includes(parsed) ? parsed : null;
}

function isoFromDatabaseValue(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function unavailableRow(year: ExamSnapshotYear, errorCode: string): ExamSnapshotRow {
  return { year, last_snapshot_at: null, row_count: null, status: "unavailable", last_error: errorCode };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The manifest B's validator expects, rebuilt from what this crawl actually did.
 * Freshness still needs `liveFetchEvidence` from the caller: a manifest claiming
 * `direct_fetch_status: PASS` about itself is never accepted as proof.
 */
export function buildCrawlManifest(
  crawl: ExamSnapshotCrawlResult,
  records: readonly ExamCourseRecord[],
  fetchedAt: string
): Record<string, unknown> {
  return {
    schema_version: EXAM_COURSE_SNAPSHOT_SCHEMA_VERSION,
    rows: records.length,
    record_contract: [...EXAM_COURSE_RECORD_COLUMNS],
    source_host: new URL(IBRAIN_ORIGIN).host,
    allowed_exam_years: [...EXAM_COURSE_YEARS],
    fetched_at: fetchedAt,
    acquisition: {
      method: "direct",
      direct_fetch_status: crawl.failures.length === 0 ? "PASS" : "PARTIAL",
      listing_pages_fetched: crawl.listingPagesFetched,
      detail_pages_fetched: crawl.detailPagesFetched
    },
    failed_urls: crawl.failures.map((failure) => failure.url)
  };
}

export function makeExamSnapshotService(options: ExamSnapshotServiceOptions = {}): ExamSnapshotService {
  const env = options.env ?? process.env;
  const settings = options.settings;
  const resolveDatabase = options.resolveDatabase ?? resolveExamDatabase;
  const crawl = options.crawl ?? ((input) => runExamSnapshotCrawl(input));
  const now = options.now ?? (() => new Date());
  const inFlight = new Set<ExamSnapshotYear>();
  const receipts = new Map<string, ExamSnapshotRefreshResponse>();

  function readLedger(): ExamSnapshotLedger {
    if (!settings) return {};
    let parsed: unknown = {};
    try {
      const raw = settings.get(EXAM_SNAPSHOT_LEDGER_KEY);
      parsed = raw === null ? {} : JSON.parse(raw);
    } catch {
      return {};
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ExamSnapshotLedger) : {};
  }

  function recordAttempt(year: ExamSnapshotYear, lastError: string | null): void {
    if (!settings) return;
    const ledger = readLedger();
    ledger[year] = { last_error: lastError, last_attempt_at: now().toISOString() };
    try {
      settings.set(EXAM_SNAPSHOT_LEDGER_KEY, JSON.stringify(ledger));
    } catch {
      // A ledger that cannot be persisted only costs next load's tooltip; the
      // response of this refresh still reports the truth.
    }
  }

  async function readYear(executor: SqlExecutor, year: ExamSnapshotYear, numericYear: number): Promise<ExamSnapshotRow> {
    const result = await executor.query(EXAM_SNAPSHOT_READ_SQL, [numericYear, EXAM_SNAPSHOT_CATEGORY]);
    const row = result.rows[0] ?? {};
    const rawCount = row.row_count;
    const rowCount = rawCount === undefined || rawCount === null ? 0 : Number(rawCount);
    return {
      year,
      last_snapshot_at: isoFromDatabaseValue(row.last_snapshot_at ?? null),
      row_count: Number.isFinite(rowCount) ? rowCount : null,
      status: "not_started",
      last_error: null
    };
  }

  function decorate(row: ExamSnapshotRow, attempt: ExamSnapshotAttempt | undefined): ExamSnapshotRow {
    if (inFlight.has(row.year)) return { ...row, last_error: null, status: "updating" };    const lastError = attempt?.last_error ?? null;
    return {
      ...row,
      last_error: lastError,
      status: deriveExamSnapshotStatus({ last_snapshot_at: row.last_snapshot_at, last_error: lastError }, taipeiDateKey(now()))
    };
  }

  function storeReceipt(idempotencyKey: string, response: ExamSnapshotRefreshResponse): void {
    receipts.set(idempotencyKey, response);
    const oldest = receipts.keys().next().value;
    if (oldest !== undefined && receipts.size > MAX_RECEIPTS) receipts.delete(oldest);
  }

  async function runRefresh(year: ExamSnapshotYear, numericYear: number, idempotencyKey: string) {
    const resolution = await resolveDatabase(env);
    if (!resolution.available) {
      recordAttempt(year, resolution.code);
      throw new ExamSnapshotServiceError(503, resolution.code, 1);
    }
    const executor = resolution.handle.executor;
    try {
      const fetchedAt = now().toISOString();
      let crawlResult: ExamSnapshotCrawlResult;
      try {
        crawlResult = await crawl({
          maxDetailPages: positiveNumber(env.EXAM_SNAPSHOT_MAX_DETAIL_PAGES, DEFAULT_MAX_DETAIL_PAGES),
          delayMs: nonNegativeNumber(env.EXAM_SNAPSHOT_DELAY_MS, DEFAULT_DELAY_MS),
          fetchedAt
        });
      } catch {
        // A transport/parser exception must be just as visible as a crawl that
        // returns no rows: nothing was written, so it cannot be a success.
        recordAttempt(year, "snapshot_crawl_failed");
        throw new ExamSnapshotServiceError(502, "snapshot_crawl_failed", 1);
      }
      // The year/category gate is Slot B's own constant, applied before anything is written.
      const records: ExamCourseRecord[] = crawlResult.records.filter(
        (record) => record.exam_year === numericYear && record.category === EXAM_SNAPSHOT_CATEGORY
      );

      if (records.length === 0) {
        // A bounded 高普考 crawl that yields nothing for a supported year means the
        // source did not answer. Writing nothing and reporting success is forbidden.
        recordAttempt(year, "snapshot_source_unavailable");
        throw new ExamSnapshotServiceError(502, "snapshot_source_unavailable", Math.max(crawlResult.failures.length, 1));
      }

      const report: ExamSnapshotValidationReport = validateExamSnapshot({
        rows: records,
        manifest: buildCrawlManifest(crawlResult, records, fetchedAt),
        expectedRows: records.length,
        liveFetchEvidence: `admin refresh ${idempotencyKey}: ${crawlResult.detailPagesFetched} detail pages fetched live from ${IBRAIN_ORIGIN}`
      });
      if (!report.ok) {
        recordAttempt(year, "snapshot_validation_failed");
        throw new ExamSnapshotServiceError(502, "snapshot_validation_failed", report.errors);
      }

      let upsert: ExamCourseUpsertResult;
      try {
        upsert = await upsertExamCourses(executor, records);
      } catch {
        recordAttempt(year, "database_write_failed");
        throw new ExamSnapshotServiceError(503, "database_write_failed", 1);
      }

      recordAttempt(year, null);
      // The rows were just written with `fetchedAt`, so the year is by definition
      // current; the read-back only supplies the authoritative count.
      const stored = await readYear(executor, year, numericYear);
      const response: ExamSnapshotRefreshResponse = {
        year,
        status: "fresh",
        changed_count: upsert.inserted + upsert.updated,
        error_count: crawlResult.failures.length,
        fetched_at: fetchedAt,
        reused: false,
        total: upsert.total,
        inserted: upsert.inserted,
        updated: upsert.updated,
        unchanged: upsert.unchanged,
        snapshot: { ...stored, status: "fresh", last_error: null }
      };
      storeReceipt(idempotencyKey, response);
      return response;
    } finally {
      await resolution.handle.close().catch(() => undefined);
    }
  }

  return {
    async listSnapshots() {
      const ledger = readLedger();
      const resolution = await resolveDatabase(env);

      if (!resolution.available) {
        return {
          snapshots: EXAM_SNAPSHOT_YEARS.map((year) => unavailableRow(year, resolution.code)),
          data_source: "unavailable"
        };
      }

      const snapshots: ExamSnapshotRow[] = [];
      try {
        for (const year of EXAM_SNAPSHOT_YEARS) {
          const numericYear = examYearNumber(year);
          if (numericYear === null) continue;
          try {
            snapshots.push(decorate(await readYear(resolution.handle.executor, year, numericYear), ledger[year]));
          } catch {
            snapshots.push(unavailableRow(year, "snapshot_read_failed"));
          }
        }
      } finally {
        await resolution.handle.close().catch(() => undefined);
      }
      return { snapshots, data_source: "exam_courses" };
    },

    async refreshToday(year, idempotencyKey) {
      const numericYear = examYearNumber(year);
      if (numericYear === null || !(EXAM_SNAPSHOT_YEARS as readonly string[]).includes(year)) {
        throw new ExamSnapshotServiceError(400, "invalid_exam_year", 1);
      }
      const receipt = receipts.get(idempotencyKey);
      if (receipt) return { ...receipt, reused: true };

      inFlight.add(year);
      try {
        return await runRefresh(year, numericYear, idempotencyKey);
      } finally {
        inFlight.delete(year);
      }
    }
  };
}
