// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { studentClient } from "../../studentClient";
import { useGuestQuestion } from "./useGuestQuestion";
import { DEFAULT_CONFIG } from "./constants";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("guest cooldown", () => {
  it.each([
    { status: "rate_limited" as const, remainingGuestQuestions: 2, path: "/", message: "請等 12 秒" },
    { status: "busy" as const, remainingGuestQuestions: undefined, path: "/", message: "訪客服務目前繁忙，請稍後再試或登入使用" },
    { status: "limit_reached" as const, remainingGuestQuestions: 0, path: "/guest-answer", message: "額度已用完" }
  ])("handles $status without confusing cooldown and exhaustion", async ({ status, remainingGuestQuestions, path, message }) => {
    const spy = vi.spyOn(studentClient, "askAsGuest").mockResolvedValue({ requestId: "", status, remainingGuestQuestions, message });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Harness() {
      const location = useLocation();
      const guest = useGuestQuestion({ config: DEFAULT_CONFIG, setLearningHistory: () => {}, setGoogleStatus: () => {} });
      return <><button onClick={() => guest.setQuestion("問題")}>輸入</button><button onClick={() => void guest.submitGuestQuestion("manual")}>送出</button><div data-path={location.pathname} data-remaining={guest.guestRemaining}>{guest.error}</div></>;
    }
    try {
      await act(async () => root.render(<MemoryRouter><Harness /></MemoryRouter>));
      await act(async () => { container.querySelectorAll("button")[0].click(); });
      await act(async () => { container.querySelectorAll("button")[1].click(); });
      expect(container.querySelector("[data-path]")?.getAttribute("data-path")).toBe(path);
      expect(container.querySelector("[data-path]")?.getAttribute("data-remaining")).toBe(remainingGuestQuestions === undefined ? null : String(remainingGuestQuestions));
      if (status === "rate_limited" || status === "busy") expect(container.textContent).toContain(message);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      localStorage.clear();
      spy.mockRestore();
    }
  });
  it("retains the previously known remaining count during busy", async () => {
    const spy = vi.spyOn(studentClient, "askAsGuest")
      .mockResolvedValueOnce({ requestId: "", status: "rate_limited", remainingGuestQuestions: 2, message: "稍後再試" })
      .mockResolvedValueOnce({ requestId: "", status: "busy", message: "訪客服務目前繁忙，請稍後再試或登入使用" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Harness() {
      const guest = useGuestQuestion({ config: DEFAULT_CONFIG, setLearningHistory: () => {}, setGoogleStatus: () => {} });
      return <><button onClick={() => guest.setQuestion("問題")}>輸入</button><button onClick={() => void guest.submitGuestQuestion("manual")}>送出</button><div data-remaining={guest.guestRemaining}>{guest.error}</div></>;
    }
    try {
      await act(async () => root.render(<MemoryRouter><Harness /></MemoryRouter>));
      await act(async () => { container.querySelectorAll("button")[0].click(); });
      await act(async () => { container.querySelectorAll("button")[1].click(); });
      await act(async () => { container.querySelectorAll("button")[1].click(); });
      expect(container.querySelector("[data-remaining]")?.getAttribute("data-remaining")).toBe("2");
      expect(container.textContent).toContain("訪客服務目前繁忙");
    } finally { await act(async () => root.unmount()); container.remove(); localStorage.clear(); spy.mockRestore(); }
  });
});
