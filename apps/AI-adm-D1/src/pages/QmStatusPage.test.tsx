// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeQmNotCheckedStatus,
  qmStatusResponseSchema,
  type QmStatusResponse
} from "@ai-smartbook/contracts";
import { QmStatusPage } from "./QmStatusPage";
import { AdminSidebar } from "../components/admin/AdminSidebar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  getQmStatus: vi.fn(),
  runQmValidate: vi.fn(),
  runQmSmoke: vi.fn()
}));

vi.mock("../api", () => ({ adminApi: api }));

function readyStatus(overrides: Partial<QmStatusResponse> = {}): QmStatusResponse {
  return qmStatusResponseSchema.parse({
    state: "ready",
    overallStatus: "warning",
    checkedAt: "2026-08-04T12:00:00Z",
    qmCliVersion: "0.1.4",
    contract: { valid: true, version: 1, clauses: {} },
    doctor: {
      status: "blocked",
      exitCode: 1,
      blockers: [{
        category: "credential",
        code: "missing_or_placeholder",
        names: ["ANTHROPIC_API_KEY"],
        message: "Required secrets are missing or placeholders",
        remediation: "Set it in the untracked environment file"
      }],
      message: "Required secrets are missing or placeholders"
    },
    smoke: { status: "pass", checkedAt: "2026-08-04T12:00:00Z", message: null },
    ...overrides
  });
}

function renderPage(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return { container, root };
}

async function render(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const rendered = renderPage();
  await act(async () => {
    rendered.root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return rendered;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.includes(label));
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return found;
}

describe("QmStatusPage behavior", () => {
  const mounted: Root[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    api.getQmStatus.mockResolvedValue(makeQmNotCheckedStatus());
    api.runQmValidate.mockResolvedValue(readyStatus());
    api.runQmSmoke.mockResolvedValue(readyStatus());
  });

  afterEach(async () => {
    for (const root of mounted.splice(0)) {
      await act(async () => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("renders the formal not_checked state", async () => {
    const rendered = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(rendered.root);

    expect(rendered.container.textContent).toContain("尚未驗證");
    expect(rendered.container.textContent).toContain("尚未檢查");
    expect(rendered.container.textContent).toContain("尚未執行");
    expect(button(rendered.container, "重新驗證").disabled).toBe(false);
  });

  it("renders ready with a blocked doctor and passing smoke", async () => {
    api.getQmStatus.mockResolvedValue(readyStatus());
    const rendered = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(rendered.root);

    expect(rendered.container.textContent).toContain("環境阻擋");
    expect(rendered.container.textContent).toContain("通過");
    expect(rendered.container.textContent).toContain("ANTHROPIC_API_KEY");
  });

  it("shows overall fail when Doctor fails", async () => {
    api.getQmStatus.mockResolvedValue(readyStatus({
      overallStatus: "fail",
      doctor: {
        status: "fail",
        exitCode: -1,
        blockers: [{
          category: "unknown",
          code: "doctor_failed",
          message: "QM Doctor failed safely.",
          remediation: "Inspect server logs"
        }],
        message: "QM Doctor failed safely."
      }
    }));
    const rendered = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(rendered.root);

    expect(rendered.container.textContent).toContain("失敗");
    expect(rendered.container.querySelector(".qm-status-grid .qm-badge")?.className).toContain("qm-badge-fail");
  });

  it("calls validate, shows loading/disabled state, and updates the result", async () => {
    let resolveValidate!: (status: QmStatusResponse) => void;
    api.runQmValidate.mockReturnValue(new Promise<QmStatusResponse>((resolve) => {
      resolveValidate = resolve;
    }));
    const rendered = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(rendered.root);

    await act(async () => {
      button(rendered.container, "重新驗證").click();
    });
    expect(api.runQmValidate).toHaveBeenCalledTimes(1);
    expect(button(rendered.container, "驗證中").disabled).toBe(true);
    expect(button(rendered.container, "執行 Smoke Test").disabled).toBe(true);

    await act(async () => resolveValidate(readyStatus({ overallStatus: "fail" })));
    expect(rendered.container.textContent).toContain("QM CLI Version");
    expect(rendered.container.querySelector(".qm-badge-fail")).not.toBeNull();
  });

  it("groups blockers with safe remediation and wraps long names", async () => {
    api.getQmStatus.mockResolvedValue(readyStatus({
      doctor: {
        status: "blocked",
        exitCode: 1,
        blockers: [
          {
            category: "credential",
            code: "missing_or_placeholder",
            names: ["ANTHROPIC_API_KEY"],
            message: "External credential is missing.",
            remediation: "Set it only in the untracked environment file."
          },
          {
            category: "local_secret",
            code: "missing_or_placeholder",
            names: ["VERY_LONG_LOCAL_SIGNING_SECRET_NAME_THAT_MUST_WRAP_ON_NARROW_SCREENS"],
            message: "Local secret is missing.",
            remediation: "Generate it locally without printing it."
          },
          {
            category: "configuration",
            code: "runtime_url_missing",
            names: ["PUBLIC_API_URL"],
            message: "Core URL is missing.",
            remediation: "Use the sandbox-reachable QM Core URL."
          }
        ],
        message: "Environment remains blocked."
      }
    }));
    const rendered = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(rendered.root);

    expect(rendered.container.textContent).toContain("憑證");
    expect(rendered.container.textContent).toContain("本機 Secret");
    expect(rendered.container.textContent).toContain("URL／設定");
    expect(rendered.container.textContent).toContain("下一步：");
    expect(rendered.container.querySelector(".qm-blocker-name")?.className).toContain("qm-blocker-name");
    expect(rendered.container.textContent).not.toContain("sk-ant-");
  });

  it("calls smoke, shows loading/disabled state, and updates the result", async () => {
    let resolveSmoke!: (status: QmStatusResponse) => void;
    api.runQmSmoke.mockReturnValue(new Promise<QmStatusResponse>((resolve) => {
      resolveSmoke = resolve;
    }));
    const rendered = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(rendered.root);

    await act(async () => {
      button(rendered.container, "執行 Smoke Test").click();
    });
    expect(api.runQmSmoke).toHaveBeenCalledTimes(1);
    expect(button(rendered.container, "執行中").disabled).toBe(true);
    expect(button(rendered.container, "重新驗證").disabled).toBe(true);

    await act(async () => resolveSmoke(readyStatus()));
    expect(rendered.container.querySelector(".qm-badge-pass")).not.toBeNull();
  });

  it("shows API errors, including a 409 concurrency message, without crashing", async () => {
    api.runQmSmoke.mockRejectedValue(new Error("Another QM operation is already in progress"));
    const rendered = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(rendered.root);

    await act(async () => {
      button(rendered.container, "執行 Smoke Test").click();
      await settle();
    });
    expect(rendered.container.textContent).toContain("Another QM operation is already in progress");

    api.getQmStatus.mockRejectedValue(new Error("Invalid response from server"));
    const failed = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(failed.root);
    expect(failed.container.textContent).toContain("讀取 QM 狀態失敗");
    expect(failed.container.textContent).toContain("Invalid response from server");
  });

  it.each([
    ["401", "Unauthorized"],
    ["403", "Forbidden"],
    ["409", "Another QM operation is already in progress"],
    ["500", "QM validation failed"]
  ])("renders a safe %s action error", async (_status, message) => {
    api.runQmValidate.mockRejectedValue(new Error(message));
    const rendered = await render(<MemoryRouter><QmStatusPage /></MemoryRouter>);
    mounted.push(rendered.root);

    await act(async () => {
      button(rendered.container, "重新驗證").click();
      await settle();
    });
    expect(rendered.container.textContent).toContain(message);
    expect(rendered.container.textContent).not.toContain("at /home/");
  });

  it("navigates from the sidebar to the actual QM route", async () => {
    api.getQmStatus.mockResolvedValue(makeQmNotCheckedStatus());
    const rendered = await render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AdminSidebar open onNavigate={() => {}} />
        <Routes>
          <Route path="/admin" element={<div>Dashboard</div>} />
          <Route path="/admin/qm-status" element={<QmStatusPage />} />
        </Routes>
      </MemoryRouter>
    );
    mounted.push(rendered.root);

    const link = Array.from(rendered.container.querySelectorAll("a"))
      .find((candidate) => candidate.textContent?.includes("QM 系統狀態"));
    if (!(link instanceof HTMLAnchorElement)) throw new Error("QM sidebar link not found");
    await act(async () => {
      link.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rendered.container.textContent).toContain("QM 系統狀態");
    expect(api.getQmStatus).toHaveBeenCalledTimes(1);
  });
});
