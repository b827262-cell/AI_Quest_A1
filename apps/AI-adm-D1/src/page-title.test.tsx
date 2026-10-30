// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AdminPageTitle } from "./page-title";
import { AdminLoginPage } from "./pages/AdminLoginPage";

vi.mock("./admin-auth", () => ({ useAdminAuth: () => ({ status: "anonymous", login: vi.fn() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("admin brand and page title", () => {
  it.each([["/login", "登入"], ["/admin", "首頁"], ["/admin/accounts", "帳戶管理"], ["/admin/books", "書本列表"], ["/admin/exam-snapshots", "高普考資料快照"], ["/admin/books/1/chapters", "書本章節管理"]])("uses the branded title for %s", async (path, name) => {
    const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={[path]}><AdminPageTitle />{path === "/login" && <AdminLoginPage />}</MemoryRouter>));
    expect(document.title).toBe(`${name} · iBrain AI`);
    if (path === "/login") expect(container.textContent).toContain("登入 iBrain AI");
    await act(async () => root.unmount()); container.remove();
  });
});
