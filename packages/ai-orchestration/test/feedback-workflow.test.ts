import { describe, expect, it } from "vitest";
import { FeedbackWorkflowService, LocalQmAdapter } from "../src/server";

describe("QM-compatible feedback workflow", () => {
  it("submits, drafts, reviews, publishes, and preserves the run trace", async () => {
    let id = 0;
    const adapter = new LocalQmAdapter({
      now: () => "2026-08-04T00:00:00.000Z",
      idFactory: (prefix) => `${prefix}_${++id}`,
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
        submissionId: "submission-1",
        assignmentId: "assignment-1",
        courseId: "course-1",
        classId: "class-1",
        learnerId: "learner-1",
        workspaceId: workspace.workspaceId,
        content: "我的作業答案",
        submittedAt: "2026-08-04T00:00:00.000Z",
        sourceReferences: [{ sourceId: "chapter-1", kind: "chapter", label: "第一章" }]
      },
      run: {
        workspaceId: workspace.workspaceId,
        harness: "qm",
        harnessVersion: "0.1.4",
        qmCliVersion: "0.1.4",
        promptVersion: "feedback-prompt@1",
        rubric: { rubricId: "rubric-1", version: "2026-08" },
        provider: "mock",
        model: "local-feedback-fixture",
        sourceReferences: [{ sourceId: "chapter-1", kind: "chapter" }],
        usage: {
          inputTokens: 12,
          outputTokens: 18,
          totalTokens: 30,
          estimatedCostMicroUsd: 0,
          currency: "USD"
        }
      }
    }, { actorId: "teacher-1", role: "teacher" });

    expect(generated.trace.status).toBe("succeeded");
    expect(generated.trace.qmCliVersion).toBe("0.1.4");
    expect(generated.trace.humanEdited).toBe(false);
    expect(generated.draft.status).toBe("draft");

    const reviewed = await workflow.review({
      feedbackDraftId: generated.draft.feedbackDraftId,
      reviewerId: "ta-1",
      reviewerRole: "ta",
      decision: "approve",
      editedBody: "已檢閱：論點清楚；請再補上教材第一章的定義引用。",
      reviewNote: "補上來源提示",
      reviewedAt: "2026-08-04T00:01:00.000Z"
    }, { actorId: "ta-1", role: "ta" });
    expect(reviewed.status).toBe("approved");
    expect(reviewed.trace.humanEdited).toBe(true);
    expect(reviewed.trace.editedBy).toBe("ta-1");
    expect(reviewed.trace.reviewedBy).toBe("ta-1");
    expect(reviewed.trace.reviewerRole).toBe("ta");

    const published = await workflow.publish({
      feedbackDraftId: reviewed.feedbackDraftId,
      publisherId: "teacher-1",
      publisherRole: "teacher",
      publishedAt: "2026-08-04T00:02:00.000Z"
    }, { actorId: "teacher-1", role: "teacher" });
    expect(published.status).toBe("published");
    expect(published.audience).toBe("learner");
    expect(published.publishedBy).toBe("teacher-1");
    expect(published.publisherRole).toBe("teacher");
    expect(published.trace.publishedBy).toBe("teacher-1");
    expect(published.trace.publishedAt).toBe("2026-08-04T00:02:00.000Z");
  });

  it("does not publish a draft before teacher or TA approval", async () => {
    const adapter = new LocalQmAdapter({
      idFactory: (prefix) => `${prefix}_fixed`
    });
    const workspace = await adapter.ensureWorkspace({
      orgId: "ai-quest-a1",
      scopeId: "class-1",
      scopeKind: "class",
      ownerId: "teacher-1",
      sharedWithIds: []
    });
    await adapter.submitAssignment({
      submissionId: "submission-1",
      assignmentId: "assignment-1",
      courseId: "course-1",
      classId: "class-1",
      learnerId: "learner-1",
      workspaceId: workspace.workspaceId,
      content: "答案",
      submittedAt: new Date().toISOString(),
      sourceReferences: []
    });
    const trace = await adapter.startFeedbackRun({
      submissionId: "submission-1",
      workspaceId: workspace.workspaceId,
      harnessVersion: "0.1.4",
      qmCliVersion: "0.1.4",
      promptVersion: "feedback-prompt@1",
      rubric: { rubricId: "rubric-1", version: "2026-08" },
      provider: "mock",
      model: "local"
    });

    await expect(
      adapter.publishFeedback({
        feedbackDraftId: trace.feedbackDraftId,
        publisherId: "teacher-1",
        publisherRole: "teacher",
        publishedAt: new Date().toISOString()
      }, { actorId: "teacher-1", role: "teacher" })
    ).rejects.toThrow("feedback_draft_not_approved");
  });
});
