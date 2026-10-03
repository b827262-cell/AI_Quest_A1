/**
 * Slot D admin endpoints for 高普考資料快照.
 *
 * `GET  /api/admin/exam-snapshots`
 * `POST /api/admin/exam-snapshots/:year/refresh-today`
 *
 * The router owns nothing about crawling, validation or SQL; it only turns the
 * service's machine codes into HTTP. Failures keep the same snake_case body as
 * successes so a client can render a real `status` / `changed_count` /
 * `error_count` / `fetched_at` for a run that did nothing, rather than an empty
 * 200 that looks like a refresh.
 */

import { Router, type Request, type Response } from "express";
import {
  EXAM_SNAPSHOT_ERROR_LABELS,
  type ExamSnapshotRefreshResponse,
  type ExamSnapshotRow
} from "../../exam-snapshots-contract";
import { ExamSnapshotServiceError, makeExamSnapshotService, type ExamSnapshotService, type ExamSnapshotSettings } from "./admin-service";

/** Same shape the evaluation endpoints accept, so one client rule covers both. */
export const EXAM_SNAPSHOT_IDEMPOTENCY_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{7,127}$/i;

export interface ExamSnapshotRouterOptions {
  env?: NodeJS.ProcessEnv;
  settings?: ExamSnapshotSettings;
  service?: ExamSnapshotService;
}

function examSnapshotErrorLabel(code: string): string {
  return EXAM_SNAPSHOT_ERROR_LABELS[code] ?? "高普考資料快照更新失敗";
}

function failedSnapshotRow(year: string, code: string): ExamSnapshotRow {
  return { year, last_snapshot_at: null, row_count: null, status: "failed", last_error: code };
}

function refreshFailureBody(year: string, code: string, changedCount: number, errorCount: number) {
  const body: ExamSnapshotRefreshResponse & { error: string; code: string } = {
    error: examSnapshotErrorLabel(code),
    code,
    year,
    status: "failed",
    changed_count: changedCount,
    error_count: errorCount,
    fetched_at: null,
    reused: false,
    snapshot: failedSnapshotRow(year, code)
  };
  return body;
}

function sendServiceError(res: Response, year: string, error: unknown) {
  if (error instanceof ExamSnapshotServiceError) {
    return res.status(error.httpStatus).json(refreshFailureBody(year, error.code, error.changedCount, error.errorCount));
  }
  // An unexpected throw must not be dressed up as a completed refresh.
  return res.status(500).json(refreshFailureBody(year, "snapshot_refresh_failed", 0, 1));
}

export function createExamSnapshotRouter(options: ExamSnapshotRouterOptions = {}): Router {
  const router = Router();
  const service = options.service ?? makeExamSnapshotService({ env: options.env, settings: options.settings });

  function requireAdmin(req: Request, res: Response): boolean {
    if (!req.adminAuth) {
      res.status(401).json({ error: "admin authentication required", code: "admin_authentication_required" });
      return false;
    }
    return true;
  }

  router.get("/", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    service
      .listSnapshots()
      .then((payload) => res.json(payload))
      .catch(() => res.status(503).json({ snapshots: [], data_source: "unavailable", error: "exam snapshot read failed", code: "snapshot_read_failed" }));
  });

  router.post("/:year/refresh-today", (req, res) => {
    if (!requireAdmin(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const year = req.params.year ?? "";
    const idempotencyKey = req.header("Idempotency-Key")?.trim() ?? "";
    if (!EXAM_SNAPSHOT_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return res.status(400).json(refreshFailureBody(year, "missing_idempotency_key", 0, 1));
    }
    service
      .refreshToday(year, idempotencyKey)
      .then((payload) => res.json(payload))
      .catch((error) => sendServiceError(res, year, error));
  });

  return router;
}
