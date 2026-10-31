// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  listStudentQuestions: vi.fn(),
  deleteStudentQuestion: vi.fn(),
  deleteStudentQuestions: vi.fn()
}));

vi.mock("../api", () => ({ adminApi: api }));

import { AdminDashboardPage } from "./AdminDashboardPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function findButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!element) throw new Error(`button ${label} not found`);
  return element;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getDashboardStats.mockResolvedValue({
    totalUsers: 1,
    activeUsers: 1,
    totalConversations: 1,
    totalMessages: 1,
    dailyConversations: [],
    source: "real",
    asOf: "2026-10-31T00:00:00.000Z",
    isSynthetic: false
  });
  api.listStudentQuestions.mockResolvedValue({
    questions: [
      {
        id: "question-1",
        sessionId: "session-1",
        student: "小明",
        subject: "數學",
        content: "什麼是極值？",
        createdAt: "2026-10-31T00:00:00.000Z"
      }
    ]
  });
  api.deleteStudentQuestion.mockResolvedValue(undefined);
  api.deleteStudentQuestions.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

describe("AdminDashboardPage destructive confirmation", () => {
  it("does not delete on cancel and deletes on confirm", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AdminDashboardPage />);
    });

    await act(async () => {
      findButton("刪除", container!).click();
    });
    const cancelDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(cancelDialog?.textContent).toContain("確定要刪除此筆訊息紀錄嗎？");
    await act(async () => {
      findButton("取消", cancelDialog!).click();
      await Promise.resolve();
    });
    expect(api.deleteStudentQuestion).not.toHaveBeenCalled();

    await act(async () => {
      findButton("刪除", container!).click();
    });
    const confirmDialog = document.querySelector<HTMLElement>('[role="dialog"]');
    await act(async () => {
      findButton("確定", confirmDialog!).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.deleteStudentQuestion).toHaveBeenCalledWith("question-1");
  });
});
