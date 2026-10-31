// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listAiEvaluations: vi.fn(),
  getAiEvaluation: vi.fn(),
  listAiEvaluationSchedules: vi.fn(),
  listAiEvaluationAlerts: vi.fn(),
  getAiEvaluationRetention: vi.fn(),
  getAiEvaluationGovernance: vi.fn(),
  getAiEvaluationSettings: vi.fn(),
  getAiLiveReadiness: vi.fn(),
  getAiProductionReadiness: vi.fn(),
  getAiPilotSettings: vi.fn(),
  deleteAiEvaluation: vi.fn()
}));

vi.mock("./api", () => ({ adminApi: api }));

import { AiQualityEvaluationsPage } from "./pages/AiQualityEvaluationsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom gives `import.meta.url` an http URL, so source files are read from the app root.
function readSource(relativePath: string) {
  return readFileSync(join(process.cwd(), "src", relativePath), "utf8");
}

const appSource = readSource("App.tsx");
const sidebarSource = readSource("components/admin/AdminSidebar.tsx");
const pageSource = readSource("pages/AiQualityEvaluationsPage.tsx");

const RUN = {
  id: "run-1",
  datasetId: "phase-4a-core",
  datasetVersion: 1,
  executionMode: "fixture",
  status: "completed",
  startedAt: "2026-10-31T00:00:00.000Z",
  completedAt: "2026-10-31T00:01:00.000Z",
  totalCases: 10,
  passedCases: 9,
  failedCases: 1,
  passRate: 0.9,
  averageScore: 0.9,
  averageDurationMs: 10,
  p50DurationMs: 10,
  p95DurationMs: 20,
  totalModelCalls: 10,
  averageModelCalls: 1,
  totalInputTokens: 100,
  totalOutputTokens: 100,
  totalTokens: 200,
  conflictRate: 0,
  unresolvedRate: 0,
  baselineRunId: null,
  regressionIssueCount: 0,
  createdAt: "2026-10-31T00:00:00.000Z"
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function findButton(label: string, scope: ParentNode = document): HTMLButtonElement {
  const element = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!element) throw new Error(`button ${label} not found`);
  return element;
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error("dialog not rendered");
  return element;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listAiEvaluations.mockResolvedValue({ runs: [RUN] });
  api.getAiEvaluation.mockResolvedValue({ run: RUN, metrics: [], issues: [] });
  api.listAiEvaluationSchedules.mockResolvedValue({ schedulerEnabled: false, schedules: [] });
  api.listAiEvaluationAlerts.mockResolvedValue({ alerts: [] });
  api.getAiEvaluationRetention.mockResolvedValue({
    policy: { enabled: false, preserveLatestSuccessful: 1, maxRunsPerDatasetMode: 3 }
  });
  api.getAiEvaluationGovernance.mockResolvedValue({ schedulerEnabled: false });
  api.getAiEvaluationSettings.mockResolvedValue({ settings: { enabled: false, allowedLogicalModelIds: [] } });
  api.getAiLiveReadiness.mockResolvedValue({
    ready: false,
    credentialReady: false,
    evaluationPoolReady: false,
    budgetReady: false,
    allowlistReady: false,
    liveEnabled: false,
    blockers: []
  });
  api.getAiProductionReadiness.mockResolvedValue({ status: "blocked", liveRunId: null });
  api.getAiPilotSettings.mockResolvedValue({
    settings: {
      enabled: false,
      trafficPercentage: 0,
      allowedTaskCategories: [],
      allowVerification: false,
      allowAdjudication: false,
      maxModelCallsPerRequest: 1,
      pilotVersion: "v1",
      stopPolicy: {}
    }
  });
  api.deleteAiEvaluation.mockResolvedValue({ deleted: true });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

describe("AI quality evaluation admin UI contract", () => {
  it("registers the expected route", () => expect(appSource).toContain("/admin/ai-quality-evaluations"));
  it("imports the quality evaluation page", () => expect(appSource).toContain("AiQualityEvaluationsPage"));
  it("shows the quality evaluation sidebar label", () => expect(sidebarSource).toContain("AI 品質評測"));
  it("places the page after quota navigation", () => expect(sidebarSource.indexOf("ai-quota-center")).toBeLessThan(sidebarSource.indexOf("ai-quality-evaluations")));
  it("has loading state", () => expect(pageSource).toContain("評測載入中"));
  it("has empty state", () => expect(pageSource).toContain("尚無評測紀錄"));
  it("has error state", () => expect(pageSource).toContain("AdminErrorCard"));
  it("shows offline accuracy disclaimer", () => expect(pageSource).toContain("不代表正式模型的真實世界準確率"));
  it("offers Fixture and Mock controls", () => { expect(pageSource).toContain("執行 Fixture 評測"); expect(pageSource).toContain("執行 Mock 評測"); });
  it("does not expose Live as a run button", () => expect(pageSource).not.toContain("執行 Live"));
  it("shows confidence calibration", () => expect(pageSource).toContain("Confidence Calibration"));
  it("shows safe failed cases", () => expect(pageSource).toContain("Safe Summary"));
  it("offers report downloads", () => { expect(pageSource).toContain("下載 JSON"); expect(pageSource).toContain("下載 Markdown"); });
  it("renders explicit mode badges", () => expect(pageSource).toContain("evaluation-mode-badge"));
  it("offers comparable baseline selection", () => expect(pageSource).toContain("evaluation-baseline-picker"));
});

describe("AI quality evaluation delete confirmation", () => {
  async function renderPage() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(createElement(AiQualityEvaluationsPage));
    });
    await flush();
  }

  it("does not delete the evaluation when the confirmation is cancelled", async () => {
    await renderPage();

    await act(async () => {
      findButton("刪除").click();
    });
    expect(dialog().textContent).toContain("確定刪除此評測紀錄及其安全指標？");

    await act(async () => {
      findButton("取消", dialog()).click();
      await Promise.resolve();
    });
    await flush();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.deleteAiEvaluation).not.toHaveBeenCalled();
  });

  it("deletes the evaluation exactly once when the confirmation is accepted", async () => {
    await renderPage();

    await act(async () => {
      findButton("刪除").click();
    });
    expect(dialog().textContent).toContain("確認刪除評測紀錄");

    await act(async () => {
      findButton("確定", dialog()).click();
      await Promise.resolve();
    });
    await flush();

    expect(api.deleteAiEvaluation).toHaveBeenCalledTimes(1);
    expect(api.deleteAiEvaluation).toHaveBeenCalledWith("run-1");
  });
});
