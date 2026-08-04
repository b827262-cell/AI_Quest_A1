import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("QM Status Frontend Constraints", () => {
  it("Browser/Server boundary checks", () => {
    const pageSource = readFileSync(resolve("src/pages/QmStatusPage.tsx"), "utf8");
    expect(pageSource).not.toMatch(/node:/);
    expect(pageSource).not.toMatch(/child_process/);
    expect(pageSource).not.toMatch(/better-sqlite3/);
    expect(pageSource).not.toMatch(/@yc-software\/qm/);
    expect(pageSource).not.toMatch(/process\.env/);
  });

  it("Route registration", () => {
    const appSource = readFileSync(resolve("src/App.tsx"), "utf8");
    expect(appSource).toContain("/admin/qm-status");
  });

  it("Sidebar registration", () => {
    const sidebarSource = readFileSync(resolve("src/components/admin/AdminSidebar.tsx"), "utf8");
    expect(sidebarSource).toContain("qm-status");
    expect(sidebarSource).toContain("QM 系統狀態");
  });

  it("Page contains required elements", () => {
    const pageSource = readFileSync(resolve("src/pages/QmStatusPage.tsx"), "utf8");
    expect(pageSource).toContain("載入中...");
    expect(pageSource).toContain("重新驗證");
    expect(pageSource).toContain("執行 Smoke Test");
    expect(pageSource).toContain("disabled");
    expect(pageSource).toContain("AdminErrorCard");
  });

  it("API client registration", () => {
    const apiSource = readFileSync(resolve("src/api.ts"), "utf8");
    expect(apiSource).toContain("getQmStatus");
    expect(apiSource).toContain("runQmValidate");
    expect(apiSource).toContain("runQmSmoke");
  });
});
