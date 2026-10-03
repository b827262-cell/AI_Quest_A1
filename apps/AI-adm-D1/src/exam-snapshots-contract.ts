/**
 * A-01 Slot D — 高普考資料快照 wire contract.
 *
 * The field names below are Slot B's vocabulary, not a third one: `year`,
 * `last_snapshot_at`, `row_count`, `status`, `last_error` mirror the
 * `exam_courses` columns that Slot B's repository already writes, so the table,
 * the admin API and this page never need a translation layer.
 *
 * The client is transport-independent: `createExamSnapshotHttpClient` receives a
 * request function, which lets `api.ts` reuse the shared fetch wrapper (cookies,
 * CSRF, 401 handling) instead of opening a second HTTP path.
 */

export const EXAM_SNAPSHOT_YEARS = ["115", "116"] as const;

/** MOC 年度 (民国年). Kept as `string` because the URL segment is a string. */
export type ExamSnapshotYear = (typeof EXAM_SNAPSHOT_YEARS)[number] | (string & Record<never, never>);

export type ExamSnapshotStatus =
  | "fresh"
  | "stale"
  | "updating"
  | "failed"
  | "not_started"
  | "unavailable";

export interface ExamSnapshotRow {
  year: ExamSnapshotYear;
  /** ISO-8601 instant of the newest `fetched_at` for that year; null when never taken. */
  last_snapshot_at: string | null;
  /** `null` means the count could not be read — deliberately not the same as `0`. */
  row_count: number | null;
  status: ExamSnapshotStatus;
  /** Stable machine code from the last failed attempt; rendered as a tooltip, never as raw data. */
  last_error: string | null;
}

export interface ExamSnapshotListResponse {
  snapshots: ExamSnapshotRow[];
  /** `unavailable` marks a fail-safe read: the rows below carry no database facts. */
  data_source: "exam_courses" | "unavailable";
}

export interface ExamSnapshotRefreshResponse {
  year: ExamSnapshotYear;
  status: ExamSnapshotStatus;
  /** Rows the upsert actually wrote (inserted + updated); unchanged rows are not writes. */
  changed_count: number;
  /** Page-level crawl failures, or 1 for a single pipeline error. */
  error_count: number;
  /** The `fetched_at` stamped on the written rows; null when nothing was written. */
  fetched_at: string | null;
  reused: boolean;
  total?: number;
  inserted?: number;
  updated?: number;
  unchanged?: number;
  snapshot: ExamSnapshotRow;
}

export interface ExamSnapshotClient {
  listSnapshots(): Promise<ExamSnapshotListResponse>;
  refreshTodaySnapshot(year: ExamSnapshotYear, idempotencyKey: string): Promise<ExamSnapshotRefreshResponse>;
}

export const EXAM_SNAPSHOT_ENDPOINTS = {
  list: "/api/admin/exam-snapshots",
  refreshToday: (year: ExamSnapshotYear) => `/api/admin/exam-snapshots/${encodeURIComponent(year)}/refresh-today`
} as const;

/** Machine codes the admin API may return, mapped to the text the page shows. */
export const EXAM_SNAPSHOT_ERROR_LABELS: Readonly<Record<string, string>> = {
  invalid_exam_year: "只支援 115 / 116 年度",
  missing_idempotency_key: "缺少更新識別碼",
  database_not_configured: "尚未設定資料庫連線（DATABASE_URL）",
  pg_driver_missing: "PostgreSQL 驅動程式未安裝",
  database_unreachable: "資料庫無法連線",
  database_write_failed: "資料庫寫入失敗",
  snapshot_source_unavailable: "上游來源頁面無法取得",
  snapshot_validation_failed: "快照內容未通過資料契約檢查",
  snapshot_read_failed: "快照資料讀取失敗"
};

export const EXAM_SNAPSHOT_STATUS_LABELS: Record<ExamSnapshotStatus, string> = {
  fresh: "今日已更新",
  stale: "待更新",
  updating: "更新中",
  failed: "更新失敗",
  not_started: "尚未建立",
  unavailable: "資料來源不可用"
};

export function isExamSnapshotYear(value: unknown): value is (typeof EXAM_SNAPSHOT_YEARS)[number] {
  return typeof value === "string" && (EXAM_SNAPSHOT_YEARS as readonly string[]).includes(value);
}

export function taipeiDateKey(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

/**
 * Freshness is derived, not stored: a snapshot is `fresh` only while it belongs to
 * the current Taipei calendar day, so a midnight rollover flips it to `stale`
 * without any writer having to touch the row.
 */
export function deriveExamSnapshotStatus(
  snapshot: Pick<ExamSnapshotRow, "last_snapshot_at" | "last_error">,
  todayKey = taipeiDateKey(new Date())
): ExamSnapshotStatus {
  if (snapshot.last_error !== null) return "failed";
  if (snapshot.last_snapshot_at === null) return "not_started";
  return taipeiDateKey(snapshot.last_snapshot_at) === todayKey ? "fresh" : "stale";
}

export function formatExamSnapshotCount(rowCount: number | null): string {
  if (rowCount === null) return "—";
  return rowCount.toLocaleString("zh-TW");
}

export function formatExamSnapshotTime(lastSnapshotAt: string | null): string {
  if (lastSnapshotAt === null) return "—";
  const date = new Date(lastSnapshotAt);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function examSnapshotErrorLabel(code: string | null): string | null {
  if (code === null) return null;
  return EXAM_SNAPSHOT_ERROR_LABELS[code] ?? code;
}

export type ExamSnapshotRequest = <T>(path: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<T>;

/** The real client: it talks to the two admin endpoints and nothing else. */
export function createExamSnapshotHttpClient(request: ExamSnapshotRequest): ExamSnapshotClient {
  return {
    listSnapshots() {
      return request<ExamSnapshotListResponse>(EXAM_SNAPSHOT_ENDPOINTS.list);
    },
    refreshTodaySnapshot(year, idempotencyKey) {
      return request<ExamSnapshotRefreshResponse>(EXAM_SNAPSHOT_ENDPOINTS.refreshToday(year), {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey }
      });
    }
  };
}
