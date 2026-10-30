import { randomUUID } from "node:crypto";
import { EXAM_SNAPSHOT_YEARS, type ExamSnapshotRefreshResponse } from "../../exam-snapshots-contract";
import { ExamSnapshotServiceError, type ExamSnapshotService } from "./admin-service";
import { resolveExamDatabase, type ExamDatabaseResolution } from "./postgres";

export const MAX_REFRESH_RECEIPTS = 1000;
export type RefreshJob = {
  job_id: string;
  year: string;
  status: "running" | "succeeded" | "failed";
  started_at: string;
  reused: boolean;
  response?: ExamSnapshotRefreshResponse;
  error_code?: string;
};
export class RefreshInProgressError extends ExamSnapshotServiceError {
  constructor(readonly jobId: string) { super(409, "refresh_in_progress", 0); }
}
type Row = Record<string, unknown>;
function jobFromRow(row: Row, reused: boolean): RefreshJob {
  const result: RefreshJob = {
    job_id: String(row.job_id), year: String(row.exam_year), status: row.status as RefreshJob["status"],
    started_at: new Date(String(row.created_at)).toISOString(), reused
  };
  if (row.response) result.response = (typeof row.response === "string" ? JSON.parse(row.response) : row.response) as ExamSnapshotRefreshResponse;
  if (row.error_code) result.error_code = String(row.error_code);
  return result;
}
export function makeBackgroundExamSnapshotService(options: {
  worker: ExamSnapshotService;
  env?: NodeJS.ProcessEnv;
  resolveDatabase?: (env: NodeJS.ProcessEnv) => Promise<ExamDatabaseResolution>;
  isYearSupported?: (year: string) => boolean;
}) {
  const env = options.env ?? process.env;
  const resolveDatabase = options.resolveDatabase ?? resolveExamDatabase;
  const supported = options.isYearSupported ?? ((year: string) => (EXAM_SNAPSHOT_YEARS as readonly string[]).includes(year));
  const active = new Map<string, { key: string; jobId: string; pending: Promise<RefreshJob> }>();
  async function withDb<T>(fn: (executor: import("@ai-smartbook/db").SqlExecutor) => Promise<T>): Promise<T> {
    const resolution = await resolveDatabase(env);
    if (!resolution.available) throw new ExamSnapshotServiceError(503, resolution.code, 1);
    try { return await fn(resolution.handle.executor); }
    catch (error) { if (error instanceof ExamSnapshotServiceError) throw error; throw new ExamSnapshotServiceError(503, "database_write_failed", 1); }
    finally { await resolution.handle.close().catch(() => undefined); }
  }
  async function normalize(row: Row, query: import("@ai-smartbook/db").SqlExecutor): Promise<Row> {
    if (row.status === "running" && ![...active.values()].some((item) => item.jobId === row.job_id)) {
      const updated = await query.query("UPDATE exam_snapshot_refresh_receipts SET status = 'failed', error_code = 'refresh_interrupted', updated_at = now() WHERE job_id = $1 AND status = 'running' RETURNING *", [row.job_id]);
      return updated.rows[0] ?? row;
    }
    return row;
  }
  async function perform(year: string, jobId: string): Promise<void> {
    try {
      const response = await options.worker.refreshToday(year, jobId);
      await withDb(async (db) => { await db.query("UPDATE exam_snapshot_refresh_receipts SET status = 'succeeded', response = $2::jsonb, updated_at = now() WHERE job_id = $1", [jobId, JSON.stringify(response)]); });
    } catch (error) {
      const code = error instanceof ExamSnapshotServiceError ? error.code : "snapshot_refresh_failed";
      await withDb(async (db) => { await db.query("UPDATE exam_snapshot_refresh_receipts SET status = 'failed', error_code = $2, updated_at = now() WHERE job_id = $1", [jobId, code]); }).catch(() => undefined);
    } finally {
      if (active.get(year)?.jobId === jobId) active.delete(year);
      await withDb(async (db) => { await db.query("DELETE FROM exam_snapshot_refresh_receipts WHERE status <> 'running' AND idempotency_key IN (SELECT idempotency_key FROM exam_snapshot_refresh_receipts WHERE status <> 'running' ORDER BY updated_at DESC, idempotency_key DESC OFFSET $1)", [MAX_REFRESH_RECEIPTS]); }).catch(() => undefined);
    }
  }
  async function start(year: string, key: string): Promise<RefreshJob> {
    if (!supported(year)) throw new ExamSnapshotServiceError(400, "invalid_exam_year", 1);
    const current = active.get(year);
    if (current) {
      if (current.key !== key) throw new RefreshInProgressError(current.jobId);
      const result = await current.pending;
      return { ...result, reused: true };
    }
    const jobId = randomUUID();
    let launch = false;
    const pending = withDb(async (db) => {
      const existing = await db.query("SELECT * FROM exam_snapshot_refresh_receipts WHERE idempotency_key = $1", [key]);
      if (existing.rows[0]) {
        if (String(existing.rows[0].exam_year) !== year) throw new ExamSnapshotServiceError(409, "idempotency_key_year_conflict", 0);
        return jobFromRow(await normalize(existing.rows[0], db), true);
      }
      const inserted = await db.query("INSERT INTO exam_snapshot_refresh_receipts (idempotency_key, exam_year, job_id, status) VALUES ($1, $2::smallint, $3, 'running') ON CONFLICT (idempotency_key) DO NOTHING RETURNING *", [key, year, jobId]);
      if (!inserted.rows[0]) {
        const raced = await db.query("SELECT * FROM exam_snapshot_refresh_receipts WHERE idempotency_key = $1", [key]);
        if (!raced.rows[0] || String(raced.rows[0].exam_year) !== year) throw new ExamSnapshotServiceError(409, "idempotency_key_year_conflict", 0);
        return jobFromRow(await normalize(raced.rows[0], db), true);
      }
      await db.query("DELETE FROM exam_snapshot_refresh_receipts WHERE status <> 'running' AND idempotency_key IN (SELECT idempotency_key FROM exam_snapshot_refresh_receipts WHERE status <> 'running' ORDER BY updated_at DESC, idempotency_key DESC OFFSET $1)", [MAX_REFRESH_RECEIPTS]);
      launch = true;
      return jobFromRow(inserted.rows[0], false);
    });
    active.set(year, { key, jobId, pending });
    try {
      const result = await pending;
      if (launch) setImmediate(() => { void perform(year, jobId); });
      else if (active.get(year)?.jobId === jobId) active.delete(year);
      return result;
    } catch (error) {
      if (active.get(year)?.jobId === jobId) active.delete(year);
      throw error;
    }
  }
  async function status(year: string, jobId: string): Promise<RefreshJob> {
    if (!supported(year)) throw new ExamSnapshotServiceError(400, "invalid_exam_year", 1);
    return withDb(async (db) => {
      const result = await db.query("SELECT * FROM exam_snapshot_refresh_receipts WHERE exam_year = $1::smallint AND job_id = $2", [year, jobId]);
      if (!result.rows[0]) throw new ExamSnapshotServiceError(404, "refresh_job_not_found", 1);
      return jobFromRow(await normalize(result.rows[0], db), false);
    });
  }
  return { start, status };
}
