// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExamSnapshotsPage } from "./ExamSnapshotsPage";
import type { ExamSnapshotClient, ExamSnapshotJob } from "../exam-snapshots-contract";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("exam snapshot job polling", () => {
  it.each(["succeeded", "failed"] as const)("shows running followed by %s", async (status) => {
    vi.useFakeTimers();
    const row = { year: "116", last_snapshot_at: null, row_count: 0, status: "not_started" as const, last_error: null };
    const base: ExamSnapshotJob = { job_id: "job-1", year: "116", status: "running", started_at: "2026-10-29T00:00:00Z", reused: false };
    const client: ExamSnapshotClient = {
      listSnapshots: vi.fn(async () => ({ snapshots: [row], data_source: "exam_courses" as const })),
      refreshTodaySnapshot: vi.fn(async () => base),
      refreshStatus: vi.fn(async () => status === "failed" ? { ...base, status, error_code: "database_write_failed" } : { ...base, status, response: { year: "116", status: "fresh" as const, changed_count: 3, error_count: 0, fetched_at: "2026-10-29T00:00:00Z", reused: false, snapshot: { ...row, row_count: 3, status: "fresh" as const } } })
    };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    await act(async () => { root.render(<MemoryRouter><ExamSnapshotsPage client={client} /></MemoryRouter>); });
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("更新今日快照"))!;
    await act(async () => { button.click(); });
    expect(container.textContent).toContain("更新中");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(container.textContent).toContain(status === "succeeded" ? "本次寫入 3 筆" : "資料庫寫入失敗");
    expect(client.refreshStatus).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
  it("stops polling when unmounted, including an already pending response", async () => {
    vi.useFakeTimers();
    const row = { year: "116", last_snapshot_at: null, row_count: 0, status: "not_started" as const, last_error: null };
    const base: ExamSnapshotJob = { job_id: "job-1", year: "116", status: "running", started_at: "2026-10-29T00:00:00Z", reused: false };
    let complete!: (job: ExamSnapshotJob) => void;
    const pending = new Promise<ExamSnapshotJob>((resolve) => { complete = resolve; });
    const client: ExamSnapshotClient = {
      listSnapshots: vi.fn(async () => ({ snapshots: [row], data_source: "exam_courses" as const })),
      refreshTodaySnapshot: vi.fn(async () => base),
      refreshStatus: vi.fn(() => pending)
    };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    await act(async () => { root.render(<MemoryRouter><ExamSnapshotsPage client={client} /></MemoryRouter>); });
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("更新今日快照"))!;
    await act(async () => { button.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(client.refreshStatus).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    const resultRead = vi.fn(() => ({ year: "116", status: "fresh" as const, changed_count: 3, error_count: 0, fetched_at: "2026-10-29T00:00:00Z", reused: false, snapshot: { ...row, row_count: 3, status: "fresh" as const } }));
    const completed = { ...base, status: "succeeded" as const };
    Object.defineProperty(completed, "response", { get: resultRead });
    await act(async () => { complete(completed); await vi.advanceTimersByTimeAsync(10000); });
    expect(resultRead).not.toHaveBeenCalled();
    expect(client.refreshStatus).toHaveBeenCalledTimes(1);
    expect(client.listSnapshots).toHaveBeenCalledTimes(1);
  });

  it("clears the scheduled poll when unmounted before the timer fires", async () => {
    vi.useFakeTimers();
    const row = { year: "116", last_snapshot_at: null, row_count: 0, status: "not_started" as const, last_error: null };
    const base: ExamSnapshotJob = { job_id: "job-1", year: "116", status: "running", started_at: "2026-10-29T00:00:00Z", reused: false };
    const client: ExamSnapshotClient = {
      listSnapshots: vi.fn(async () => ({ snapshots: [row], data_source: "exam_courses" as const })),
      refreshTodaySnapshot: vi.fn(async () => base),
      refreshStatus: vi.fn(async () => base)
    };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    await act(async () => { root.render(<MemoryRouter><ExamSnapshotsPage client={client} /></MemoryRouter>); });
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("更新今日快照"))!;
    await act(async () => { button.click(); });
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(client.refreshStatus).not.toHaveBeenCalled();
  });

  it("discards a pending old client result after a client change", async () => {
    vi.useFakeTimers();
    const oldRow = { year: "116", last_snapshot_at: null, row_count: 1, status: "not_started" as const, last_error: null };
    const newRow = { ...oldRow, row_count: 42 };
    const base: ExamSnapshotJob = { job_id: "old-job", year: "116", status: "running", started_at: "2026-10-29T00:00:00Z", reused: false };
    let complete!: (job: ExamSnapshotJob) => void;
    const pending = new Promise<ExamSnapshotJob>((resolve) => { complete = resolve; });
    const oldClient: ExamSnapshotClient = { listSnapshots: vi.fn(async () => ({ snapshots: [oldRow], data_source: "exam_courses" as const })), refreshTodaySnapshot: vi.fn(async () => base), refreshStatus: vi.fn(() => pending) };
    const newClient: ExamSnapshotClient = { listSnapshots: vi.fn(async () => ({ snapshots: [newRow], data_source: "exam_courses" as const })), refreshTodaySnapshot: vi.fn(async () => base), refreshStatus: vi.fn(async () => base) };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    await act(async () => { root.render(<MemoryRouter><ExamSnapshotsPage client={oldClient} /></MemoryRouter>); });
    const getButton = () => [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("更新今日快照"))!;
    await act(async () => { getButton().click(); await vi.advanceTimersByTimeAsync(2000); });
    expect(oldClient.refreshStatus).toHaveBeenCalledTimes(1);
    await act(async () => { root.render(<MemoryRouter><ExamSnapshotsPage client={newClient} /></MemoryRouter>); });
    expect(getButton().disabled).toBe(false);
    await act(async () => { getButton().click(); });
    const result = { ...base, status: "succeeded" as const, response: { year: "116", status: "fresh" as const, changed_count: 99, error_count: 0, fetched_at: "2026-10-29T00:00:00Z", reused: false, snapshot: { ...oldRow, row_count: 99, status: "fresh" as const } } };
    await act(async () => { complete(result); await vi.advanceTimersByTimeAsync(10000); });
    expect(oldClient.refreshStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("本次寫入 99 筆");
    expect(container.textContent).toContain("42");
    const activeButton = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("更新中"))!;
    expect(activeButton.disabled).toBe(true);
    expect(newClient.refreshStatus).toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("refreshes successfully with the new client after a client change", async () => {
    vi.useFakeTimers();
    const row = { year: "116", last_snapshot_at: null, row_count: 0, status: "not_started" as const, last_error: null };
    const base: ExamSnapshotJob = { job_id: "job-1", year: "116", status: "running", started_at: "2026-10-29T00:00:00Z", reused: false };
    const oldClient: ExamSnapshotClient = { listSnapshots: vi.fn(async () => ({ snapshots: [row], data_source: "exam_courses" as const })), refreshTodaySnapshot: vi.fn(async () => base), refreshStatus: vi.fn(async () => base) };
    const newClient: ExamSnapshotClient = { listSnapshots: vi.fn(async () => ({ snapshots: [row], data_source: "exam_courses" as const })), refreshTodaySnapshot: vi.fn(async () => ({ ...base, job_id: "new-job" })), refreshStatus: vi.fn(async () => ({ ...base, job_id: "new-job", status: "succeeded" as const, response: { year: "116", status: "fresh" as const, changed_count: 3, error_count: 0, fetched_at: "2026-10-29T00:00:00Z", reused: false, snapshot: { ...row, row_count: 3, status: "fresh" as const } } })) };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    await act(async () => { root.render(<MemoryRouter><ExamSnapshotsPage client={oldClient} /></MemoryRouter>); });
    const getButton = () => [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("更新今日快照"))!;
    await act(async () => { getButton().click(); });
    await act(async () => { root.render(<MemoryRouter><ExamSnapshotsPage client={newClient} /></MemoryRouter>); });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { getButton().click(); await vi.advanceTimersByTimeAsync(2000); });
    expect(oldClient.refreshStatus).not.toHaveBeenCalled();
    expect(newClient.refreshStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("本次寫入 3 筆");
    expect(getButton().disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("creates a different UUID idempotency key for each completed refresh", async () => {
    vi.useFakeTimers();
    const row = { year: "116", last_snapshot_at: null, row_count: 0, status: "not_started" as const, last_error: null };
    const base: ExamSnapshotJob = { job_id: "job-1", year: "116", status: "running", started_at: "2026-10-29T00:00:00Z", reused: false };
    const refresh = vi.fn(async (_year: string, _key: string) => base);
    const client: ExamSnapshotClient = { listSnapshots: vi.fn(async () => ({ snapshots: [row], data_source: "exam_courses" as const })), refreshTodaySnapshot: refresh,
      refreshStatus: vi.fn(async () => ({ ...base, status: "succeeded" as const, response: { year: "116", status: "fresh" as const, changed_count: 1, error_count: 0, fetched_at: "2026-10-29T00:00:00Z", reused: false, snapshot: { ...row, status: "fresh" as const } } })) };
    const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
    await act(async () => { root.render(<MemoryRouter><ExamSnapshotsPage client={client} /></MemoryRouter>); });
    const getButton = () => [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("更新今日快照"))!;
    for (let i = 0; i < 2; i++) { await act(async () => { getButton().click(); }); await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); }
    const keys = refresh.mock.calls.map((call) => call[1]);
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
    for (const key of keys) expect(key).toMatch(/^exam-snapshot-116-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await act(async () => root.unmount());
  });

});
