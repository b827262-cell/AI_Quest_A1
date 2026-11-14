// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildReadingProgressCsv, ReadingProgressTab } from "./ReadingProgressTab";
import { adminApi, type BookReadingProgressAnalytics } from "../../api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const sampleData: BookReadingProgressAnalytics = {
  bookId: "b1",
  totalSessions: 42,
  activeReadersCount: 17,
  averageCompletedPages: 3.5,
  pageDropoffDistribution: [
    { page: 1, currentReadersCount: 0, completedReadersCount: 2 },
    { page: 5, currentReadersCount: 1, completedReadersCount: 0 }
  ],
  chapterCompletionStats: [
    { chapterId: "c1", title: "Ch1", orderIndex: 0, completedCount: 2, completionRate: 0.5 },
    { chapterId: "c2", title: "Ch2", orderIndex: 1, completedCount: 1, completionRate: 0.25 }
  ],
  recentReaders: [
    {
      sessionId: "s1",
      currentPage: 5,
      completedPagesCount: 3,
      completedChaptersCount: 1,
      updatedAt: "2026-01-03T00:00:00.000Z"
    }
  ]
};

async function renderTab(data: BookReadingProgressAnalytics) {
  vi.spyOn(adminApi, "getBookReadingProgress").mockResolvedValue(data);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ReadingProgressTab bookId="b1" />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ReadingProgressTab", () => {
  it("renders the three summary metrics and percent-formatted completion rates", async () => {
    await renderTab(sampleData);
    const text = container!.textContent ?? "";
    expect(text).toContain("總連線數");
    expect(text).toContain("活躍讀者數");
    expect(text).toContain("平均完成頁數");
    expect(text).toContain("42");
    expect(text).toContain("17");
    expect(text).toContain("3.5");
    expect(text).toContain("50.0%");
    expect(text).toContain("25.0%");
    expect(text).toContain("第 5 頁");
    // CSV export button lives at the top of the screen.
    const exportButton = [...container!.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("匯出 CSV")
    );
    expect(exportButton).toBeTruthy();
  });

  it("shows friendly empty states when there is no data", async () => {
    await renderTab({
      bookId: "b1",
      totalSessions: 0,
      activeReadersCount: 0,
      averageCompletedPages: 0,
      pageDropoffDistribution: [],
      chapterCompletionStats: [],
      recentReaders: []
    });
    const text = container!.textContent ?? "";
    expect(text).toContain("尚無章節完成資料");
    expect(text).toContain("尚無頁面進度資料");
    expect(text).toContain("尚無讀者進度資料");
  });
});

describe("buildReadingProgressCsv", () => {
  it("emits chapter completion rates and page drop-off sections", () => {
    const csv = buildReadingProgressCsv(sampleData);
    expect(csv).toContain("章節完成率");
    expect(csv).toContain("章節,完成人數,完成率");
    expect(csv).toContain("1. Ch1,2,50.0%");
    expect(csv).toContain("2. Ch2,1,25.0%");
    expect(csv).toContain("各頁停留與完成分布");
    expect(csv).toContain("頁碼,目前停留讀者,已完成讀者");
    expect(csv).toContain("第 1 頁,0,2");
    expect(csv).toContain("第 5 頁,1,0");
  });

  it("escapes commas, double quotes, CR and LF in chapter titles", () => {
    const csv = buildReadingProgressCsv({
      ...sampleData,
      chapterCompletionStats: [
        { chapterId: "c1", title: 'Intro, "A"\r\nPart 2', orderIndex: 0, completedCount: 1, completionRate: 0.25 }
      ]
    });
    expect(csv).toContain('"1. Intro, ""A""\r\nPart 2",1,25.0%');
  });
});
