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
});
