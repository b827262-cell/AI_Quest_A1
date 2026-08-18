import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Book } from "@ai-smartbook/schema";
import { GuestAnswerSection } from "./GuestAnswerSection";
import { formatMetricValue, MetricCards } from "./MetricCards";
import { SmartBookSection } from "./SmartBookSection";

const BOOK: Book = {
  id: "book-1",
  title: "學習導論",
  subtitle: null,
  description: "一本測試書",
  coverUrl: null,
  category: "通識",
  status: "published",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("dashboard components", () => {
  it("keeps zero distinct from unavailable metric data", () => {
    expect(formatMetricValue(0)).toBe("0");
    expect(formatMetricValue(null)).toBe("—");
    const markup = renderToStaticMarkup(
      <MetricCards metrics={[{ id: "points", label: "學習點數", value: 0, description: "目前點數" }]} />
    );
    expect(markup).toContain(">0<");
    expect(markup).not.toContain("目前沒有可用資料");
  });

  it("renders SmartBook empty, loading and error states without throwing", () => {
    const loading = renderToStaticMarkup(
      <MemoryRouter><SmartBookSection books={[]} status="loading" error={null} onRetry={() => undefined} /></MemoryRouter>
    );
    const empty = renderToStaticMarkup(
      <MemoryRouter><SmartBookSection books={[]} status="success" error={null} onRetry={() => undefined} /></MemoryRouter>
    );
    const error = renderToStaticMarkup(
      <MemoryRouter><SmartBookSection books={[]} status="error" error="暫時離線" onRetry={() => undefined} /></MemoryRouter>
    );
    expect(loading).toContain("SmartBook 載入中");
    expect(empty).toContain("還沒有可閱讀的 SmartBook");
    expect(error).toContain("暫時離線");
    expect(error).toContain("重試");
  });

  it("renders a real book and does not add citation markup to guest answers", () => {
    const bookMarkup = renderToStaticMarkup(
      <MemoryRouter><SmartBookSection books={[BOOK]} status="success" error={null} onRetry={() => undefined} /></MemoryRouter>
    );
    const answerMarkup = renderToStaticMarkup(
      <GuestAnswerSection
        response={{
          requestId: "guest-test",
          question: "什麼是學習？",
          status: "success",
          answer: "學習是理解與練習的過程。",
          remainingGuestQuestions: 0
        }}
        status="success"
        error={null}
        onAsk={async () => undefined}
      />
    );
    expect(bookMarkup).toContain("學習導論");
    expect(bookMarkup).toContain("/books/book-1");
    expect(answerMarkup).toContain("剩餘體驗：0");
    expect(answerMarkup).not.toContain("citation");
    expect(answerMarkup).not.toContain("引用來源");
  });

  it("keeps guest loading, error and partial-answer states local to the section", () => {
    const loading = renderToStaticMarkup(
      <GuestAnswerSection
        response={null}
        status="loading"
        error={null}
        onAsk={async () => undefined}
      />
    );
    const error = renderToStaticMarkup(
      <GuestAnswerSection
        response={null}
        status="error"
        error="網路暫時不可用"
        onAsk={async () => undefined}
      />
    );
    const partial = renderToStaticMarkup(
      <GuestAnswerSection
        response={{
          requestId: "guest-partial",
          question: "請說明第一步",
          status: "incomplete",
          answer: "第一步是先整理已知條件。",
          retryable: true
        }}
        status="success"
        error={null}
        onAsk={async () => undefined}
      />
    );
    expect(loading).toContain("正在整理回答");
    expect(error).toContain("網路暫時不可用");
    expect(partial).toContain("回答可能尚未完整結束");
    expect(partial).toContain("重新產生");
  });
});
