import { describe, expect, it } from "vitest";
import {
  EXAM_COURSE_RECORD_COLUMNS,
  type ExamCourseRecord,
  type SqlExecutor
} from "@ai-smartbook/db";
import { computeContentHash } from "./ibrain-parse";
import {
  EXAM_SNAPSHOT_LEDGER_KEY,
  EXAM_SNAPSHOT_READ_SQL,
  ExamSnapshotServiceError,
  makeExamSnapshotService,
  type ExamSnapshotAttempt
} from "./admin-service";
import { resolveExamDatabase } from "./postgres";
import type { ExamDatabaseResolution } from "./postgres";
import type { ExamSnapshotCrawlResult } from "./ibrain-crawl";

const CLOCK = new Date("2026-10-04T02:00:00.000Z");

function courseRecord(overrides: Partial<ExamCourseRecord> = {}): ExamCourseRecord {
  const base: ExamCourseRecord = {
    exam_year: 115,
    category: "高普考",
    course_code: "BKA115001",
    course_name: "115年高普考【財稅行政】經濟學",
    course_content: "【師資】陳老师 【品號】BKA115001",
    source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=1001",
    fetched_at: CLOCK.toISOString(),
    content_hash: ""
  };
  const record = { ...base, ...overrides };
  return {
    ...record,
    content_hash: computeContentHash({
      exam_year: record.exam_year,
      category: record.category,
      course_code: record.course_code,
      course_name: record.course_name,
      course_content: record.course_content,
      source_url: record.source_url
    })
  };
}

function crawlResult(
  records: readonly ExamCourseRecord[],
  failures: ExamSnapshotCrawlResult["failures"] = []
): ExamSnapshotCrawlResult {
  return {
    records: records.map((record) => ({ ...record })) as ExamSnapshotCrawlResult["records"],
    failures,
    listingPagesFetched: 39,
    candidateLinks: records.length,
    detailPagesFetched: records.length,
    skippedOutOfScope: 0
  };
}

/**
 * Test double for Slot B's `exam_courses` table. It implements exactly the
 * semantics the reviewed upsert documents — the natural key is
 * (exam_year, course_code) and a row whose content_hash already matches is not
 * returned at all, which is what makes the write non-destructive. The guard is
 * asserted from the SQL text so the double cannot drift from B's statement.
 */
function makeTableDouble() {
  const rows = new Map<string, ExamCourseRecord>();
  const executed: string[] = [];
  const executor: SqlExecutor = {
    async query(text: string, params?: readonly unknown[]) {
      executed.push(text);
      if (text.startsWith("INSERT INTO exam_courses")) {
        const outcomes: Array<Record<string, unknown>> = [];
        const size = EXAM_COURSE_RECORD_COLUMNS.length;
        for (let offset = 0; offset + size <= (params?.length ?? 0); offset += size) {
          // `buildExamCourseUpsert` binds one flat group of 8 values per row, in
          // EXAM_COURSE_RECORD_COLUMNS order.
          const [exam_year, category, course_code, course_name, course_content, source_url, fetched_at, content_hash] =
            params!.slice(offset, offset + size) as [number, string, string, string, string, string, string, string];
          const record: ExamCourseRecord = {
            exam_year,
            category,
            course_code,
            course_name,
            course_content,
            source_url,
            fetched_at,
            content_hash
          };
          const key = `${exam_year}:${course_code}`;
          const existing = rows.get(key);
          if (existing === undefined) {
            rows.set(key, record);
            outcomes.push({ exam_year, course_code, is_insert: true });
          } else if (existing.content_hash !== content_hash) {
            rows.set(key, record);
            outcomes.push({ exam_year, course_code, is_insert: false });
          }
        }
        return { rows: outcomes };
      }
      const examYear = Number(params?.[0]);
      const matching = [...rows.values()].filter((row) => row.exam_year === examYear && row.category === params?.[1]);
      const last = matching.map((row) => Date.parse(row.fetched_at)).sort((a, b) => b - a)[0];
      return { rows: [{ row_count: matching.length, last_snapshot_at: last === undefined ? null : new Date(last).toISOString() }] };
    }
  };
  return { executor, rows, executed };
}

function availableResolution(table: ReturnType<typeof makeTableDouble>): ExamDatabaseResolution {
  return { available: true, handle: { executor: table.executor, close: async () => undefined } };
}

function makeSettings(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, value: string) => {
      store.set(key, value);
    }
  };
}

function attemptFor(settings: ReturnType<typeof makeSettings>, year: string): ExamSnapshotAttempt | undefined {
  const raw = settings.get(EXAM_SNAPSHOT_LEDGER_KEY);
  return raw === null ? undefined : (JSON.parse(raw) as Record<string, ExamSnapshotAttempt>)[year];
}

describe("exam snapshot admin service (Slot D real wiring)", () => {
  it("reads 115 and 116 straight out of exam_courses", async () => {
    const table = makeTableDouble();
    await table.executor.query("INSERT INTO exam_courses", [116, "高普考", "BKA116001", "116年高普考", "內容", "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=2001", CLOCK.toISOString(), "x".repeat(64)]);
    const service = makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => crawlResult([]),
      now: () => CLOCK
    });

    const response = await service.listSnapshots();
    expect(response.data_source).toBe("exam_courses");
    expect(response.snapshots.map((snapshot) => snapshot.year)).toEqual(["115", "116"]);
    expect(response.snapshots[1]).toMatchObject({ row_count: 1, status: "fresh", last_error: null });
    expect(response.snapshots[0]).toMatchObject({ row_count: 0, status: "not_started" });
    expect(EXAM_SNAPSHOT_READ_SQL).toContain("FROM exam_courses");
  });

  it("serves a fail-safe read instead of inventing counts when no DATABASE_URL exists", async () => {
    const service = makeExamSnapshotService({ env: {}, resolveDatabase: resolveExamDatabase, crawl: async () => crawlResult([]) });
    const response = await service.listSnapshots();
    expect(response.data_source).toBe("unavailable");
    expect(response.snapshots).toHaveLength(2);
    for (const snapshot of response.snapshots) {
      expect(snapshot).toMatchObject({ status: "unavailable", last_error: "database_not_configured" });
      expect(snapshot.row_count).toBeNull();
      expect(snapshot.last_snapshot_at).toBeNull();
    }
  });

  it("refuses a year outside 115/116 before crawling or writing", async () => {
    let crawled = 0;
    const table = makeTableDouble();
    const service = makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => {
        crawled += 1;
        return crawlResult([courseRecord()]);
      },
      now: () => CLOCK
    });

    await expect(service.refreshToday("117", "exam-snapshot-117-2026-10-04")).rejects.toMatchObject({
      httpStatus: 400,
      code: "invalid_exam_year"
    });
    expect(crawled).toBe(0);
    expect(table.rows.size).toBe(0);
  });

  it("writes the crawl through the content_hash upsert and reports the counts", async () => {
    const table = makeTableDouble();
    const settings = makeSettings();
    const service = makeExamSnapshotService({
      settings,
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => crawlResult([courseRecord(), courseRecord({ course_code: "BKA115002", source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=1002" })]),
      now: () => CLOCK
    });

    const result = await service.refreshToday("115", "exam-snapshot-115-2026-10-04");
    expect(result).toMatchObject({
      year: "115",
      status: "fresh",
      changed_count: 2,
      inserted: 2,
      updated: 0,
      unchanged: 0,
      error_count: 0,
      fetched_at: CLOCK.toISOString(),
      reused: false
    });
    expect(result.snapshot.row_count).toBe(2);
    expect(table.rows.size).toBe(2);
    expect(attemptFor(settings, "115")?.last_error).toBeNull();
    // The write went through B's statement, not an ad-hoc one.
    expect(table.executed.some((text) => text.includes("ON CONFLICT (exam_year, course_code) DO UPDATE"))).toBe(true);
    expect(table.executed.some((text) => text.includes("IS DISTINCT FROM EXCLUDED.content_hash"))).toBe(true);
  });

  it("performs no writes when an identical snapshot is refreshed again", async () => {
    const table = makeTableDouble();
    const records = [courseRecord()];
    const service = makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => crawlResult(records),
      now: () => CLOCK
    });

    await service.refreshToday("115", "key-run-1");
    const storedAfterFirst = table.rows.get("115:BKA115001");
    const later = new Date(CLOCK.getTime() + 3_600_000);
    const second = await makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => crawlResult([courseRecord({ course_content: "【師資】陳老师 【品號】BKA115001" })]),
      now: () => later
    }).refreshToday("115", "key-run-2");

    expect(second).toMatchObject({ changed_count: 0, inserted: 0, updated: 0, unchanged: 1 });
    expect(table.rows.size).toBe(1);
    // Non-destructive: the untouched row keeps the first run's fetched_at and hash.
    expect(table.rows.get("115:BKA115001")).toBe(storedAfterFirst);
  });

  it("updates the same row rather than duplicating it when content changes", async () => {
    const table = makeTableDouble();
    const service = makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => crawlResult([courseRecord()]),
      now: () => CLOCK
    });
    await service.refreshToday("115", "key-1");

    const changed = [courseRecord({ course_content: "【師資】陳老师 【品號】BKA115001 ｜ 提醒：新增章節" })];
    expect(changed[0].content_hash).not.toBe(table.rows.get("115:BKA115001")!.content_hash);

    const second = await makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => crawlResult(changed),
      now: () => new Date(CLOCK.getTime() + 3_600_000)
    }).refreshToday("115", "key-2");

    expect(second).toMatchObject({ changed_count: 1, inserted: 0, updated: 1, status: "fresh" });
    expect(table.rows.size).toBe(1);
    expect(table.rows.get("115:BKA115001")!.content_hash).toBe(changed[0].content_hash);
  });

  it("reports the upstream failure and writes nothing when the source answers with zero rows", async () => {
    const table = makeTableDouble();
    const settings = makeSettings();
    const service = makeExamSnapshotService({
      settings,
      resolveDatabase: async () => availableResolution(table),
      crawl: async () =>
        crawlResult([], [
          { url: "https://ec.ibrain.com.tw/Publish/www/layer.asp?bkid_1=1&KindID3=3", stage: "listing", reason: "fetch failed" },
          { url: "https://ec.ibrain.com.tw/Publish/www/layer.asp?bkid_1=1&KindID3=8", stage: "listing", status: 503, reason: "non-200" }
        ]),
      now: () => CLOCK
    });

    const error = await service.refreshToday("115", "key-upstream").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ExamSnapshotServiceError);
    expect(error).toMatchObject({ httpStatus: 502, code: "snapshot_source_unavailable", errorCount: 2 });
    expect(table.rows.size).toBe(0);
    expect(attemptFor(settings, "115")?.last_error).toBe("snapshot_source_unavailable");
  });

  it("fails safe without writes when the crawler throws", async () => {
    const table = makeTableDouble();
    const settings = makeSettings();
    const service = makeExamSnapshotService({
      settings,
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => {
        throw new Error("source transport reset");
      },
      now: () => CLOCK
    });

    await expect(service.refreshToday("115", "key-crawl-throw")).rejects.toMatchObject({
      httpStatus: 502,
      code: "snapshot_crawl_failed"
    });
    expect(table.rows.size).toBe(0);
    expect(attemptFor(settings, "115")?.last_error).toBe("snapshot_crawl_failed");
  });

  it("blocks the write when Slot B's validator rejects the snapshot", async () => {
    const table = makeTableDouble();
    const settings = makeSettings();
    // Two rows aimed at one source page: the contract treats that as an error, not a dedupe.
    const duplicated = [courseRecord(), courseRecord({ course_code: "BKA115009" })];
    const service = makeExamSnapshotService({
      settings,
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => crawlResult(duplicated),
      now: () => CLOCK
    });

    const error = await service.refreshToday("115", "key-invalid").catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ httpStatus: 502, code: "snapshot_validation_failed" });
    expect(table.rows.size).toBe(0);
    expect(attemptFor(settings, "115")?.last_error).toBe("snapshot_validation_failed");
  });

  it("answers 503 with no write when the configured database cannot be reached", async () => {
    const table = makeTableDouble();
    const settings = makeSettings();
    const service = makeExamSnapshotService({
      settings,
      env: { DATABASE_URL: "postgres://example.invalid/exam" },
      resolveDatabase: async () => ({ available: false, code: "database_unreachable", message: "database connection failed (ECONNREFUSED)" }),
      crawl: async () => crawlResult([courseRecord()]),
      now: () => CLOCK
    });

    const error = await service.refreshToday("115", "key-db").catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ httpStatus: 503, code: "database_unreachable" });
    expect(table.rows.size).toBe(0);
    expect(attemptFor(settings, "115")?.last_error).toBe("database_unreachable");
  });

  it("fails safe without a fake success when a write is rejected mid-transaction", async () => {
    const table = makeTableDouble();
    const settings = makeSettings();
    const failing: SqlExecutor = {
      async query(text: string, params?: readonly unknown[]) {
        if (text.startsWith("INSERT INTO exam_courses")) throw new Error("permission denied for table exam_courses");
        return table.executor.query(text, params);
      }
    };
    const service = makeExamSnapshotService({
      settings,
      resolveDatabase: async () => ({ available: true, handle: { executor: failing, close: async () => undefined } }),
      crawl: async () => crawlResult([courseRecord()]),
      now: () => CLOCK
    });

    const error = await service.refreshToday("115", "key-denied").catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ httpStatus: 503, code: "database_write_failed" });
    expect(attemptFor(settings, "115")?.last_error).toBe("database_write_failed");
  });

  it("replays the same idempotency key without crawling twice", async () => {
    let crawls = 0;
    const table = makeTableDouble();
    const service = makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () => {
        crawls += 1;
        return crawlResult([courseRecord()]);
      },
      now: () => CLOCK
    });

    const first = await service.refreshToday("115", "key-once");
    const second = await service.refreshToday("115", "key-once");
    expect(crawls).toBe(1);
    expect(second).toMatchObject({ reused: true, changed_count: first.changed_count });
  });

  it("keeps a partial crawl honest by reporting the page failures it did hit", async () => {
    const table = makeTableDouble();
    const service = makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () =>
        crawlResult([courseRecord()], [
          { url: "https://ec.ibrain.com.tw/Publish/www/layer.asp?bkid_1=1&KindID3=288", stage: "listing", status: 500, reason: "non-200 listing response" }
        ]),
      now: () => CLOCK
    });

    const result = await service.refreshToday("115", "key-partial");
    expect(result).toMatchObject({ status: "fresh", changed_count: 1, error_count: 1 });
  });

  it("only writes the rows of the requested year", async () => {
    const table = makeTableDouble();
    const service = makeExamSnapshotService({
      resolveDatabase: async () => availableResolution(table),
      crawl: async () =>
        crawlResult([
          courseRecord(),
          courseRecord({ exam_year: 116, course_code: "BKA116001", source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=3001" })
        ]),
      now: () => CLOCK
    });

    const result = await service.refreshToday("115", "key-year-filter");
    expect(result.total).toBe(1);
    expect([...table.rows.keys()]).toEqual(["115:BKA115001"]);
  });

  it("closes the handle it opened", async () => {
    let closed = 0;
    const table = makeTableDouble();
    const resolution: ExamDatabaseResolution = {
      available: true,
      handle: { executor: table.executor, close: async () => { closed += 1; } }
    };
    const service = makeExamSnapshotService({
      resolveDatabase: async () => resolution,
      crawl: async () => crawlResult([courseRecord()]),
      now: () => CLOCK
    });
    await service.listSnapshots();
    await service.refreshToday("115", "key-close");
    expect(closed).toBe(2);
  });

});
