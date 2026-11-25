// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAccountsPage } from "./AdminAccountsPage";
import { adminApi, type AdminAccount, type AdminStudentUser } from "../api";

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

function makeAccount(
  over: Partial<AdminAccount> & Pick<AdminAccount, "id" | "sessionId" | "name">
): AdminAccount {
  return {
    loginMethod: "帳號登入",
    osName: "Linux",
    deviceType: "desktop",
    browserName: "Chrome",
    ipAddress: null,
    ipLocation: "Localhost / Private IP",
    riskLevel: "safe",
    riskNote: null,
    isBlocked: false,
    blockedReason: null,
    blockedAt: null,
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    online: true,
    ...over
  };
}

const accounts: AdminAccount[] = [
  makeAccount({
    id: "u1",
    sessionId: "s1",
    name: "Alice",
    schoolName: "Sunrise High",
    gradeLevel: "G10",
    profileCompleted: true,
    studentDisplayName: "Alice"
  }),
  makeAccount({
    id: "u2",
    sessionId: "s2",
    name: "Bob",
    schoolName: null,
    gradeLevel: null,
    profileCompleted: false,
    studentDisplayName: null
  })
];

const studentUsers: AdminStudentUser[] = [
  {
    id: "stu1",
    displayName: "Alice",
    email: "alice@example.invalid",
    schoolName: "Sunrise High",
    gradeLevel: "G10",
    profileCompleted: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z"
  }
];

async function renderPage() {
  vi.spyOn(adminApi, "listAccounts").mockResolvedValue({ accounts, studentUsers });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <AdminAccountsPage />
      </MemoryRouter>
    );
  });
  // Flush the listAccounts().then().catch().finally() chain.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AdminAccountsPage Phase A", () => {
  it("renders school/grade and uses 未填寫 / — for empty values", async () => {
    await renderPage();
    const cells = [...container!.querySelectorAll(".admin-school-grade")].map(
      (el) => el.textContent ?? ""
    );
    expect(cells.some((t) => t.includes("Sunrise High") && t.includes("G10"))).toBe(true);
    expect(cells.some((t) => t.includes("未填寫"))).toBe(true);
    expect(cells.some((t) => t.includes("—"))).toBe(true);
  });

  it("filters account rows by school", async () => {
    await renderPage();
    expect(container!.textContent).toContain("Bob");

    const select = container!.querySelector(
      ".admin-accounts-school-filter select"
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "Sunrise High");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container!.textContent).not.toContain("Bob");
    expect(container!.textContent).toContain("Alice");
    expect(container!.textContent).toContain("顯示 1 / 2 筆");
  });

  it("renders the registered student roster summary", async () => {
    await renderPage();
    const text = container!.textContent ?? "";
    expect(text).toContain("已註冊學生學籍名冊");
    expect(text).toContain("alice@example.invalid");
  });
});
