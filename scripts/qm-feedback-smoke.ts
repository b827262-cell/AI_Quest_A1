import { FeedbackWorkflowService, LocalQmAdapter } from "@ai-smartbook/ai-orchestration/server";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const adapter = new LocalQmAdapter({
    now: () => "2026-08-04T00:00:00.000Z",
    idFactory: (() => {
      let sequence = 0;
      return (prefix: string) => `${prefix}_${++sequence}`;
    })(),
    qmCliVersion: "0.1.4"
  });
  const workflow = new FeedbackWorkflowService(adapter);
  const workspace = await adapter.ensureWorkspace({
    orgId: "ai-quest-a1",
    scopeId: "class-1",
    scopeKind: "class",
    ownerId: "teacher-1",
    sharedWithIds: ["ta-1"]
  });
  const generated = await workflow.submitAndGenerate({
  submission: {
    submissionId: "submission-smoke",
    assignmentId: "assignment-smoke",
    courseId: "course-smoke",
    classId: "class-1",
    learnerId: "learner-1",
    workspaceId: workspace.workspaceId,
    content: "本機 smoke 作業答案",
    submittedAt: "2026-08-04T00:00:00.000Z",
    sourceReferences: [{ sourceId: "lesson-1", kind: "lesson" }]
  },
  run: {
    workspaceId: workspace.workspaceId,
    harness: "qm",
    harnessVersion: "0.1.4",
    qmCliVersion: "0.1.4",
    promptVersion: "feedback-prompt@1",
    rubric: { rubricId: "rubric-smoke", version: "2026-08" },
    provider: "mock",
    model: "local-feedback-fixture",
    sourceReferences: [{ sourceId: "lesson-1", kind: "lesson" }],
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      estimatedCostMicroUsd: 0,
      currency: "USD"
    }
  }
  });
  assert(generated.draft.status === "draft", "feedback draft was not created");
  assert(generated.trace.status === "succeeded", "feedback run did not succeed");

  const reviewed = await workflow.review({
  feedbackDraftId: generated.draft.feedbackDraftId,
  reviewerId: "ta-1",
  reviewerRole: "ta",
  decision: "approve",
  editedBody: "TA 已審核：補充教材來源後通過。",
  reviewNote: "來源補充完成",
  reviewedAt: "2026-08-04T00:01:00.000Z"
  });
  assert(reviewed.status === "approved", "review did not approve the draft");
  assert(reviewed.trace.humanEdited && reviewed.trace.reviewedBy === "ta-1", "review trace was not retained");

  const published = await workflow.publish({
  feedbackDraftId: reviewed.feedbackDraftId,
  publisherId: "teacher-1",
  publisherRole: "teacher",
  publishedAt: "2026-08-04T00:02:00.000Z"
  });
  assert(published.status === "published", "feedback was not published");
  assert(published.audience === "learner", "feedback audience was not learner-scoped");
  assert(published.trace.publishedBy === "teacher-1", "publisher trace was not retained");

  console.log("[qm-feedback-smoke] PASS submission -> draft -> review -> publish");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
