// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeAiPage } from "./KnowledgeAiPage";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

async function renderPage(fetcher: typeof fetch) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<MemoryRouter><KnowledgeAiPage /></MemoryRouter>));
}

async function submitSearch() {
  const form = container?.querySelector("form");
  expect(form).not.toBeNull();
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function successResponse() {
  return new Response(JSON.stringify({
    contractVersion: 1, mode: "snapshot", query: { keyword: "憲法", search_mode: "product_name", limit: 20 }, total: 1,
    results: [{ exam_year: 116, course_code: "course-1", course_name: "憲法課程", course_content: "基本權", source_url: "https://ec.ibrain.com.tw/Publish/www/book.asp?bkid=18757" }]
  }));
}

describe("knowledge search syntax guidance", () => {
  it("replaces old results with localized guidance and restores results after a successful retry", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(successResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unsupported_snapshot_query", message: "Snapshot keyword search supports plain words only" }), { status: 400 }))
      .mockResolvedValueOnce(successResponse());
    await renderPage(fetcher);
    await submitSearch();
    expect(container?.textContent).toContain("憲法課程");

    await submitSearch();
    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.classList.contains("knowledge-query-error")).toBe(true);
    expect(alert?.getAttribute("aria-labelledby")).toBe("knowledge-query-error-heading");
    expect(alert?.querySelector("h3")?.textContent).toBe("此搜尋語法暫時無法使用");
    expect(alert?.querySelectorAll("li")).toHaveLength(3);
    for (const text of ["一般關鍵字", "行政法 OR 民法", '"行政法"', "-民法", "空白分隔", "同時符合所有詞", "行政法 民法", "品名、品號、師資、適用範圍"]) {
      expect(alert?.textContent).toContain(text);
    }
    expect(alert?.textContent).not.toMatch(/HTTP|400|Snapshot|unsupported_snapshot_query/);
    expect(container?.textContent).not.toContain("憲法課程");
    expect(container?.querySelector(".knowledge-card-meta")).toBeNull();
    expect(container?.querySelectorAll('select[aria-label="公開來源查詢方式"] option')).toHaveLength(4);

    await submitSearch();
    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(container?.textContent).toContain("憲法課程");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith("/api/public/exam-courses/search?"))).toBe(true);
  });

  it.each([400, 503])("keeps ordinary HTTP %i errors in the existing generic alert", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: "invalid_request", message: "Do not show this server message" }), { status }));
    await renderPage(fetcher);
    await submitSearch();
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(`公開課程搜尋暫時無法使用（HTTP ${status}）`);
    expect(container?.querySelector(".knowledge-query-error")).toBeNull();
    expect(container?.textContent).not.toContain("Do not show this server message");
    expect(container?.textContent).not.toContain("目前資料僅涵蓋部分 116 年公開課程");
  });
  it("explains the limited source coverage when a successful search has no results", async () => {
    const empty = new Response(JSON.stringify({ contractVersion: 1, mode: "snapshot", query: { keyword: "行政法", search_mode: "product_name", limit: 20 }, total: 0, results: [] }));
    await renderPage(vi.fn<typeof fetch>().mockResolvedValue(empty));
    expect(container?.textContent).not.toContain("目前資料僅涵蓋部分 116 年公開課程");
    await submitSearch();
    expect(container?.textContent).toContain("目前資料僅涵蓋部分 116 年公開課程");
    expect(container?.textContent).toContain("請更換關鍵字或改用品名、品號查詢");
    expect(container?.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not show the empty-result guidance when courses are returned", async () => {
    await renderPage(vi.fn<typeof fetch>().mockResolvedValue(successResponse()));
    expect(container?.querySelector('input[aria-label="搜尋關鍵字"]')?.getAttribute("placeholder")).toBe("例如：行政法、民法、會計");
    await submitSearch();
    expect(container?.textContent).toContain("憲法課程");
    expect(container?.textContent).not.toContain("目前資料僅涵蓋部分 116 年公開課程");
  });

});
