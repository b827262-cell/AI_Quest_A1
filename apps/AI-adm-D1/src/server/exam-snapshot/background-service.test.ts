import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createExamSnapshotRouter } from "./admin-router";
import { makeBackgroundExamSnapshotService, MAX_REFRESH_RECEIPTS } from "./background-service";
import { ExamSnapshotServiceError, type ExamSnapshotService } from "./admin-service";
import type { SqlExecutor } from "@ai-smartbook/db";

function fakeDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const executor: SqlExecutor = { async query(sql, params = []) {
    if (sql.startsWith("SELECT *")) {
      const row = sql.includes("idempotency_key = $1") ? rows.get(String(params[0])) : [...rows.values()].find((r) => String(r.exam_year) === String(params[0]) && r.job_id === params[1]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (sql.startsWith("INSERT INTO exam_snapshot_refresh_receipts")) {
      const key = String(params[0]); if (rows.has(key)) return { rows: [] };
      const row = { idempotency_key: key, exam_year: Number(params[1]), job_id: params[2], status: "running", created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      rows.set(key, row); return { rows: [{ ...row }] };
    }
    if (sql.startsWith("UPDATE exam_snapshot_refresh_receipts")) {
      const row = [...rows.values()].find((item) => item.job_id === params[0]);
      if (!row) return { rows: [] };
      if (sql.includes("refresh_interrupted")) { if (row.status !== "running") return { rows: [] }; row.status = "failed"; row.error_code = "refresh_interrupted"; }
      else if (sql.includes("'succeeded'")) { row.status = "succeeded"; row.response = JSON.parse(String(params[1])); }
      else { row.status = "failed"; row.error_code = params[1]; }
      row.updated_at = new Date().toISOString(); return { rows: [{ ...row }] };
    }
    if (sql.startsWith("DELETE FROM exam_snapshot_refresh_receipts")) {
      const completed = [...rows.values()].filter((r) => r.status !== "running").sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || String(b.idempotency_key).localeCompare(String(a.idempotency_key)));
      for (const row of completed.slice(Number(params[0]))) rows.delete(String(row.idempotency_key));
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  return { rows, resolve: async () => ({ available: true as const, handle: { executor, close: async () => undefined } }) };
}
function fixtureResponse(year = "116") { return { year, status: "fresh" as const, changed_count: 1, error_count: 0, fetched_at: "2026-10-29T00:00:00Z", reused: false, inserted: 1, updated: 0, unchanged: 0, snapshot: { year, last_snapshot_at: null, row_count: 1, status: "fresh" as const, last_error: null } }; }
function worker(fn: ExamSnapshotService["refreshToday"]): ExamSnapshotService { return { refreshToday: fn, listSnapshots: async () => ({ snapshots: [], data_source: "exam_courses" }) }; }
function defer<T>() { let resolve!: (value: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }

describe("background exam refresh", () => {
  it("returns immediately, single-flights same year, and persists success for replay after restart", async () => {
    const db = fakeDb(); const gate = defer<ReturnType<typeof fixtureResponse>>(); const crawl = vi.fn(() => gate.promise);
    const service = makeBackgroundExamSnapshotService({ worker: worker(crawl), resolveDatabase: db.resolve });
    const first = await service.start("116", "same-key-1");
    expect(first).toMatchObject({ status: "running", reused: false });
    expect(await service.start("116", "same-key-1")).toMatchObject({ job_id: first.job_id, reused: true });
    await expect(service.start("116", "different-key")).rejects.toMatchObject({ code: "refresh_in_progress", jobId: first.job_id });
    await tick(); expect(crawl).toHaveBeenCalledTimes(1);
    gate.resolve(fixtureResponse()); await tick(); await tick();
    expect(await service.status("116", first.job_id)).toMatchObject({ status: "succeeded", response: { inserted: 1 } });
    const restarted = makeBackgroundExamSnapshotService({ worker: worker(crawl), resolveDatabase: db.resolve });
    expect(await restarted.start("116", "same-key-1")).toMatchObject({ job_id: first.job_id, status: "succeeded", reused: true });
    expect(crawl).toHaveBeenCalledTimes(1);
  });
  it("persists failures and releases the slot", async () => {
    const db = fakeDb(); const service = makeBackgroundExamSnapshotService({ worker: worker(async () => { throw new ExamSnapshotServiceError(502, "snapshot_crawl_failed", 1); }), resolveDatabase: db.resolve });
    const first = await service.start("116", "failure-key"); await tick(); await tick();
    expect(await service.status("116", first.job_id)).toMatchObject({ status: "failed", error_code: "snapshot_crawl_failed" });
    expect(await service.start("116", "second-key")).toMatchObject({ status: "running" });
  });
  it("converts a stale running receipt to interrupted after restart", async () => {
    const db = fakeDb(); db.rows.set("stale-key", { idempotency_key: "stale-key", exam_year: 116, job_id: "old-job", status: "running", created_at: new Date().toISOString() });
    const service = makeBackgroundExamSnapshotService({ worker: worker(async () => fixtureResponse()), resolveDatabase: db.resolve });
    expect(await service.start("116", "stale-key")).toMatchObject({ job_id: "old-job", status: "failed", error_code: "refresh_interrupted", reused: true });
  });
  it("allows different years to work concurrently when supported", async () => {
    const db = fakeDb(); const gate = defer<ReturnType<typeof fixtureResponse>>(); const crawl = vi.fn(() => gate.promise);
    const service = makeBackgroundExamSnapshotService({ worker: worker(crawl), resolveDatabase: db.resolve, isYearSupported: () => true });
    const [a, b] = await Promise.all([service.start("115", "key-year-115"), service.start("116", "key-year-116")]);
    await tick(); expect(a.job_id).not.toBe(b.job_id); expect(crawl).toHaveBeenCalledTimes(2); gate.resolve(fixtureResponse()); await tick();
  });
  it("bounds retained completed receipts without deleting running jobs", async () => {
    const db = fakeDb();
    for (let i = 0; i < MAX_REFRESH_RECEIPTS + 5; i++) db.rows.set(`old-${i}`, { idempotency_key: `old-${i}`, exam_year: 116, job_id: `job-${i}`, status: "succeeded", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    const gate = defer<ReturnType<typeof fixtureResponse>>(); const service = makeBackgroundExamSnapshotService({ worker: worker(() => gate.promise), resolveDatabase: db.resolve });
    await service.start("116", "new-job-key");
    expect([...db.rows.values()].filter((row) => row.status === "succeeded")).toHaveLength(MAX_REFRESH_RECEIPTS);
    gate.resolve(fixtureResponse()); await tick(); await tick();
    expect([...db.rows.values()].filter((row) => row.status !== "running").length).toBeLessThanOrEqual(MAX_REFRESH_RECEIPTS);
  });
  it("HTTP responds 202 before completion, 409 for another key, then exposes completed status", async () => {
    const db = fakeDb(); const gate = defer<ReturnType<typeof fixtureResponse>>();
    const service = makeBackgroundExamSnapshotService({ worker: worker(() => gate.promise), resolveDatabase: db.resolve });
    const app = express();
    app.use((req, _res, next) => { req.adminAuth = { kind: "token", id: "admin-api-token" }; next(); });
    app.use("/api/admin/exam-snapshots", createExamSnapshotRouter({ background: service }));
    const first = await request(app).post("/api/admin/exam-snapshots/116/refresh-today").set("Idempotency-Key", "http-key-0001");
    expect(first.status).toBe(202); expect(first.body.status).toBe("running");
    const second = await request(app).post("/api/admin/exam-snapshots/116/refresh-today").set("Idempotency-Key", "http-key-0002");
    expect(second.status).toBe(409); expect(second.body).toMatchObject({ code: "refresh_in_progress", job_id: first.body.job_id });
    gate.resolve(fixtureResponse()); await tick(); await tick();
    const status = await request(app).get(`/api/admin/exam-snapshots/116/jobs/${first.body.job_id}`);
    expect(status.status).toBe(200); expect(status.body).toMatchObject({ status: "succeeded", response: { inserted: 1 } });
  });

});
