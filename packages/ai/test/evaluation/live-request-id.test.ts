import { describe, expect, it } from "vitest";
import {
  MockEvaluationOrchestrator,
  buildLiveRequestId,
  runLiveEvaluation,
  type EvaluationCase,
  type EvaluationDataset,
  type EvaluationOrchestratorRequest
} from "../../src";

const numericCase = (id: string): EvaluationCase => ({
  id,
  version: 1,
  category: "mathematics",
  difficulty: "easy",
  question: `計算 ${id}`,
  expected: { kind: "numeric", expectedValue: 5, tolerance: 0 },
  source: "synthetic",
  enabled: true
});

const dataset: EvaluationDataset = { id: "phase-4a-core", version: 1, cases: [numericCase("math-basic-001"), numericCase("math-decimal-001")] };

describe("buildLiveRequestId", () => {
  it("namespaces the primary requestId with the evaluation run id and dataset version", () => {
    expect(buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-123-abc"))
      .toBe("eval:eval-live-123-abc:phase-4a-core:v1:math-basic-001:primary");
  });

  it("is stable for the same run + case (retry/idempotency)", () => {
    const a = buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-123-abc");
    const b = buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-123-abc");
    expect(a).toBe(b);
  });

  it("differs across runs for the same case (no cross-run collision)", () => {
    const runA = buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-111-aaa");
    const runB = buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-222-bbb");
    expect(runA).not.toBe(runB);
  });

  it("differs across dataset versions for the same run + case", () => {
    const v1 = buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-111-aaa");
    const v2 = buildLiveRequestId({ id: "phase-4a-core", version: 2 }, "math-basic-001", "eval-live-111-aaa");
    expect(v1).not.toBe(v2);
  });

  it("falls back to the legacy format when no run id is supplied", () => {
    expect(buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001")).toBe("eval:phase-4a-core:math-basic-001:primary");
  });
});

describe("runLiveEvaluation requestId isolation", () => {
  it("passes the run-namespaced primary requestId to the orchestrator", async () => {
    const mock = new MockEvaluationOrchestrator({});
    await runLiveEvaluation(dataset, { mode: "live", maxCases: 1, evaluationRunId: "eval-live-999-zzz", orchestrator: mock });
    expect(mock.calls[0]?.requestId).toBe("eval:eval-live-999-zzz:phase-4a-core:v1:math-basic-001:primary");
  });

  it("produces identical requestIds on retry within the same run (idempotent reservation reuse)", async () => {
    const capturingOrchestrator = {
      requests: [] as EvaluationOrchestratorRequest[],
      async run(request: EvaluationOrchestratorRequest) {
        this.requests.push(request);
        return { answer: "5", modelCallCount: 1, durationMs: 1 };
      }
    };
    await runLiveEvaluation(dataset, { mode: "live", maxCases: 1, evaluationRunId: "eval-live-retry-1", orchestrator: capturingOrchestrator });
    await runLiveEvaluation(dataset, { mode: "live", maxCases: 1, evaluationRunId: "eval-live-retry-1", orchestrator: capturingOrchestrator });
    expect(capturingOrchestrator.requests).toHaveLength(2);
    expect(capturingOrchestrator.requests[0]?.requestId).toBe(capturingOrchestrator.requests[1]?.requestId);
  });

  it("produces distinct requestIds for the same case across two different runs", async () => {
    const seen = new Set<string>();
    const capturingOrchestrator = {
      async run(request: EvaluationOrchestratorRequest) {
        seen.add(request.requestId);
        return { answer: "5", modelCallCount: 1, durationMs: 1 };
      }
    };
    await runLiveEvaluation(dataset, { mode: "live", maxCases: 1, evaluationRunId: "eval-live-run-A", orchestrator: capturingOrchestrator });
    await runLiveEvaluation(dataset, { mode: "live", maxCases: 1, evaluationRunId: "eval-live-run-B", orchestrator: capturingOrchestrator });
    expect(seen.size).toBe(2);
    expect([...seen]).toEqual([
      "eval:eval-live-run-A:phase-4a-core:v1:math-basic-001:primary",
      "eval:eval-live-run-B:phase-4a-core:v1:math-basic-001:primary"
    ]);
  });

  it("a second run's primary requestId does not match a prior run's settled reservation requestId", () => {
    // Simulates the reservation store's dedup key: prior run settled a reservation
    // keyed by its primary requestId. The new run's requestId must not collide.
    const priorSettledKey = buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-old-run");
    const newRunKey = buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-new-run");
    expect(newRunKey).not.toBe(priorSettledKey);
  });

  it("verify/adjudicate ids derive from the namespaced primary requestId", () => {
    const primary = buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-777");
    // Mirrors MultiModelOrchestrator's derivation (multi-model-orchestrator.ts:523,578).
    const verify = `${primary}:verify`;
    const adjudicate = `${primary}:adjudicate`;
    expect(verify).toBe("eval:eval-live-777:phase-4a-core:v1:math-basic-001:primary:verify");
    expect(adjudicate).toBe("eval:eval-live-777:phase-4a-core:v1:math-basic-001:primary:adjudicate");
    // The derived ids also stay run-isolated.
    const otherRun = `${buildLiveRequestId({ id: "phase-4a-core", version: 1 }, "math-basic-001", "eval-live-888")}:verify`;
    expect(verify).not.toBe(otherRun);
  });
});
