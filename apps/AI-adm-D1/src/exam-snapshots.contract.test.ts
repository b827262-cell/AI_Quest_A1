import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createExamSnapshotHttpClient,
  deriveExamSnapshotStatus,
  examSnapshotErrorLabel,
  EXAM_SNAPSHOT_ENDPOINTS,
  EXAM_SNAPSHOT_STATUS_LABELS,
  EXAM_SNAPSHOT_YEARS,
  formatExamSnapshotCount,
  formatExamSnapshotTime,
  isExamSnapshotYear,
  taipeiDateKey,
  type ExamSnapshotRefreshResponse,
  type ExamSnapshotRequest
} from "./exam-snapshots-contract";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const sidebarSource = readFileSync(new URL("./components/admin/AdminSidebar.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./pages/ExamSnapshotsPage.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("./api.ts", import.meta.url), "utf8");

/** 2026-10-03 10:00 Asia/Taipei. */
const CLOCK = new Date("2026-10-03T02:00:00.000Z");

function recordingClient(responses: Record<string, unknown>) {
  const calls: Array<{ path: string; method: string; headers: Record<string, string> }> = [];
  const request: ExamSnapshotRequest = <T>(path: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push({ path, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    return Promise.resolve(responses[path] as T);
  };
  return { client: createExamSnapshotHttpClient(request), calls };
}

describe("高普考資料快照 contract (Slot D real wiring)", () => {
  describe("admin 版型 registration", () => {
    it("registers the expected route", () => expect(appSource).toContain("/admin/exam-snapshots"));
    it("imports the snapshot page", () => expect(appSource).toContain("ExamSnapshotsPage"));
    it("shows the sidebar label", () => expect(sidebarSource).toContain("高普考資料快照"));
    it("builds on AdminCard / AdminPageHeader / AdminErrorCard like every other admin page", () => {
      expect(pageSource).toContain("AdminPageHeader");
      expect(pageSource).toContain("AdminCard");
      expect(pageSource).toContain("AdminErrorCard");
    });
    it("keeps the reviewed layout columns and states", () => {
      for (const label of ["年度", "最後快照時間", "筆數", "狀態", "更新今日快照"]) expect(pageSource).toContain(label);
      expect(pageSource).toContain("高普考資料快照載入中");
      expect(pageSource).toContain("尚無快照資料");
    });
  });

  describe("required wire fields", () => {
    it("covers both contract years", () => expect(EXAM_SNAPSHOT_YEARS).toEqual(["115", "116"]));
    it("labels every status", () => {
      expect(Object.keys(EXAM_SNAPSHOT_STATUS_LABELS).sort()).toEqual(
        ["failed", "fresh", "not_started", "stale", "unavailable", "updating"].sort()
      );
    });
    it("rejects a year the snapshot contract does not cover", () => {
      expect(isExamSnapshotYear("117")).toBe(false);
      expect(isExamSnapshotYear("115")).toBe(true);
    });
  });

  describe("real client", () => {
    it("targets the two admin endpoints", () => {
      expect(EXAM_SNAPSHOT_ENDPOINTS.list).toBe("/api/admin/exam-snapshots");
      expect(EXAM_SNAPSHOT_ENDPOINTS.refreshToday("115")).toBe("/api/admin/exam-snapshots/115/refresh-today");
    });
    it("escapes the year segment instead of interpolating raw input", () => {
      expect(EXAM_SNAPSHOT_ENDPOINTS.refreshToday("1 5/../../x")).toBe(
        "/api/admin/exam-snapshots/1%205%2F..%2F..%2Fx/refresh-today"
      );
    });
    it("reads the snapshot list from GET without a body", async () => {
      const { client, calls } = recordingClient({ [EXAM_SNAPSHOT_ENDPOINTS.list]: { snapshots: [], data_source: "exam_courses" } });
      await expect(client.listSnapshots()).resolves.toEqual({ snapshots: [], data_source: "exam_courses" });
      expect(calls).toEqual([{ path: "/api/admin/exam-snapshots", method: "GET", headers: {} }]);
    });
    it("posts the refresh with an idempotency key", async () => {
      const receipt: ExamSnapshotRefreshResponse = {
        year: "115",
        status: "fresh",
        changed_count: 12,
        error_count: 0,
        fetched_at: CLOCK.toISOString(),
        reused: false,
        snapshot: { year: "115", last_snapshot_at: CLOCK.toISOString(), row_count: 12, status: "fresh", last_error: null }
      };
      const { client, calls } = recordingClient({ [EXAM_SNAPSHOT_ENDPOINTS.refreshToday("115")]: receipt });
      const key = `exam-snapshot-115-${taipeiDateKey(CLOCK)}`;
      await expect(client.refreshTodaySnapshot("115", key)).resolves.toMatchObject({ changed_count: 12, fetched_at: CLOCK.toISOString() });
      expect(calls[0]).toMatchObject({ method: "POST", headers: { "Idempotency-Key": key } });
    });
    it("reuses the shared http helper, so cookies/CSRF/401 stay in one place", () => {
      expect(apiSource).toContain("createExamSnapshotHttpClient");
      expect(apiSource).toContain("export const examSnapshotApi");
      expect(apiSource).toContain("http<T>(path, init)");
    });
    it("the page defaults to the real client and never hand-rolls fetch", () => {
      expect(pageSource).toContain("client = examSnapshotApi");
      expect(pageSource).not.toContain("mockExamSnapshotClient");
      expect(pageSource).not.toContain("fetch(");
    });
    it("no longer claims the numbers are mock", () => {
      expect(pageSource).not.toContain("mock contract 資料");
      expect(pageSource).toContain("content_hash");
    });
  });

  describe("status derivation and formatting", () => {
    it("treats a missing snapshot as not started", () => {
      expect(deriveExamSnapshotStatus({ last_snapshot_at: null, last_error: null }, "2026-10-03")).toBe("not_started");
    });
    it("treats any error code as failed", () => {
      expect(deriveExamSnapshotStatus({ last_snapshot_at: CLOCK.toISOString(), last_error: "boom" }, "2026-10-03")).toBe("failed");
    });
    it("is fresh only on the current Taipei calendar day", () => {
      const todayInTaipei = taipeiDateKey(CLOCK);
      expect(deriveExamSnapshotStatus({ last_snapshot_at: CLOCK.toISOString(), last_error: null }, todayInTaipei)).toBe("fresh");
      expect(deriveExamSnapshotStatus({ last_snapshot_at: "2026-10-02T02:00:00.000Z", last_error: null }, todayInTaipei)).toBe("stale");
    });
    it("rolls a same-instant snapshot to stale once Taipei crosses midnight", () => {
      const justBeforeMidnight = new Date("2026-10-03T15:30:00.000Z"); // 10/03 23:30 Taipei
      expect(taipeiDateKey(justBeforeMidnight)).toBe("2026-10-03");
      expect(deriveExamSnapshotStatus({ last_snapshot_at: justBeforeMidnight.toISOString(), last_error: null }, "2026-10-04")).toBe("stale");
    });
    it("renders an unknown timestamp as a dash rather than Invalid Date", () => {
      expect(formatExamSnapshotTime(null)).toBe("—");
      expect(formatExamSnapshotTime("not-a-timestamp")).toBe("—");
    });
    it("renders an unreadable count as a dash, never as zero", () => {
      expect(formatExamSnapshotCount(null)).toBe("—");
      expect(formatExamSnapshotCount(0)).toBe("0");
    });
    it("translates fail-safe codes into operator-facing text", () => {
      expect(examSnapshotErrorLabel("database_not_configured")).toContain("DATABASE_URL");
      expect(examSnapshotErrorLabel(null)).toBeNull();
    });
  });
});
