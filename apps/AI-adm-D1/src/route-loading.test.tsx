// @vitest-environment happy-dom
import { act, lazy } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { RouteLoading } from "./route-loading";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("lazy routes", () => {
  it("renders a target route when its lazy module loads", async () => {
    const Page = lazy(async () => ({ default: () => <p>測試頁面</p> }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<MemoryRouter initialEntries={["/target"]}><RouteLoading><Routes><Route path="/target" element={<Page />} /></Routes></RouteLoading></MemoryRouter>); });
    expect(container.textContent).toContain("測試頁面");
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows a reload action when a lazy import fails", async () => {
    const Page = lazy(() => Promise.reject(new Error("chunk unavailable")));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await act(async () => { root.render(<MemoryRouter initialEntries={["/target"]}><RouteLoading><Routes><Route path="/target" element={<Page />} /></Routes></RouteLoading></MemoryRouter>); });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("頁面載入失敗");
      expect(container.querySelector("button")?.textContent).toBe("重新載入");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      consoleError.mockRestore();
    }
  });
});
