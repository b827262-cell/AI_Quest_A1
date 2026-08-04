import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LocalQmAdapter } from "../src/server";

const createdDirectories: string[] = [];
afterEach(() => { for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true }); });

async function seededAdapter(options: ConstructorParameters<typeof LocalQmAdapter>[0] = {}) {
  let id = 0;
  const adapter = new LocalQmAdapter({
    now: () => "2026-08-04T00:00:00.000Z",
    idFactory: (prefix) => `${prefix}_${++id}`,
    ...options
  });
  const workspace = await adapter.ensureWorkspace({
    orgId: "org", scopeId: "class-1", scopeKind: "class",
    ownerId: "teacher-1", sharedWithIds: ["ta-1"]
  });
  const submission = await adapter.submitAssignment({
    submissionId: "submission-1", assignmentId: "assignment-1", courseId: "course-1",
    classId: "class-1", learnerId: "learner-1", workspaceId: workspace.workspaceId,
    content: "answer", submittedAt: "2026-08-04T00:00:00.000Z", sourceReferences: []
  });
  const trace = await adapter.startFeedbackRun({
    submissionId: submission.submissionId, workspaceId: workspace.workspaceId,
    harnessVersion: "0.1.4", qmCliVersion: "0.1.4", promptVersion: "prompt@1",
    rubric: { rubricId: "rubric", version: "1" }, provider: "fixture", model: "fixture"
  });
  return { adapter, workspace, submission, trace };
}

describe("feedback persistence and integrity", () => {
  it("persists state across repository restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qm-feedback-")); createdDirectories.push(directory);
    const databasePath = join(directory, "feedback.sqlite");
    const first = await seededAdapter({ databasePath });
    const draftId = first.trace.feedbackDraftId;
    first.adapter.close();
    const second = new LocalQmAdapter({ databasePath });
    expect((await second.getFeedbackDraft(draftId, { actorId: "teacher-1", role: "teacher" })).submissionId).toBe("submission-1");
    second.close();
  });

  it("separates equal textual scope ids by scope kind and rejects identity changes", async () => {
    const adapter = new LocalQmAdapter({ idFactory: (prefix) => `${prefix}_${Math.random()}` });
    const classWorkspace = await adapter.ensureWorkspace({ orgId: "org", scopeId: "shared-id", scopeKind: "class", ownerId: "t1", sharedWithIds: [] });
    const courseWorkspace = await adapter.ensureWorkspace({ orgId: "org", scopeId: "shared-id", scopeKind: "course", ownerId: "t1", sharedWithIds: [] });
    expect(courseWorkspace.workspaceId).not.toBe(classWorkspace.workspaceId);
    await expect(adapter.ensureWorkspace({ orgId: "org", scopeId: "shared-id", scopeKind: "class", ownerId: "t2", sharedWithIds: [] }))
      .rejects.toThrow("workspace_identity_conflict");
    adapter.close();
  });

  it("returns identical submission retries and rejects conflicting retries", async () => {
    const { adapter, submission } = await seededAdapter();
    expect(await adapter.submitAssignment(submission)).toEqual(submission);
    await expect(adapter.submitAssignment({ ...submission, content: "changed" })).rejects.toThrow("submission_id_conflict");
    adapter.close();
  });

  it("rejects a submission bound to another class workspace", async () => {
    const adapter = new LocalQmAdapter();
    const workspace = await adapter.ensureWorkspace({ orgId: "org", scopeId: "class-2", scopeKind: "class", ownerId: "teacher-2", sharedWithIds: [] });
    await expect(adapter.submitAssignment({ submissionId: "s", assignmentId: "a", courseId: "course-1", classId: "class-1", learnerId: "l", workspaceId: workspace.workspaceId, content: "x", submittedAt: "2026-08-04T00:00:00.000Z" }))
      .rejects.toThrow("submission_workspace_mismatch");
    adapter.close();
  });

  it("rejects learner, non-member, cross-class and claimed-identity review access", async () => {
    const { adapter, trace } = await seededAdapter();
    const input = { feedbackDraftId: trace.feedbackDraftId, reviewerId: "learner-1", reviewerRole: "ta" as const, decision: "approve" as const, reviewedAt: "2026-08-04T00:01:00.000Z" };
    await expect(adapter.reviewFeedback(input, { actorId: "learner-1", role: "learner" })).rejects.toThrow("actor_claim_mismatch");
    await expect(adapter.reviewFeedback({ ...input, reviewerId: "ta-other" }, { actorId: "ta-other", role: "ta" })).rejects.toThrow("feedback_forbidden");
    await expect(adapter.reviewFeedback({ ...input, reviewerId: "ta-1" }, { actorId: "ta-1", role: "teacher" })).rejects.toThrow("actor_claim_mismatch");
    await expect(adapter.getFeedbackDraft(trace.feedbackDraftId, { actorId: "learner-1", role: "learner" })).rejects.toThrow("feedback_forbidden");
    await expect(adapter.getRunTrace(trace.runId, { actorId: "learner-1", role: "learner" })).rejects.toThrow("feedback_forbidden");
    adapter.close();
  });

  it("rejects duplicate publication", async () => {
    const { adapter, trace } = await seededAdapter();
    await adapter.reviewFeedback({ feedbackDraftId: trace.feedbackDraftId, reviewerId: "ta-1", reviewerRole: "ta", decision: "approve", reviewedAt: "2026-08-04T00:01:00.000Z" }, { actorId: "ta-1", role: "ta" });
    const publish = { feedbackDraftId: trace.feedbackDraftId, publisherId: "teacher-1", publisherRole: "teacher" as const, publishedAt: "2026-08-04T00:02:00.000Z" };
    await adapter.publishFeedback(publish, { actorId: "teacher-1", role: "teacher" });
    await expect(adapter.publishFeedback(publish, { actorId: "teacher-1", role: "teacher" })).rejects.toThrow("feedback_already_published");
    adapter.close();
  });

  it("rolls back trace and draft when a review transaction fails", async () => {
    const { adapter, trace } = await seededAdapter({ transactionProbe: (stage) => { if (stage === "review_saved") throw new Error("forced_failure"); } });
    await expect(adapter.reviewFeedback({ feedbackDraftId: trace.feedbackDraftId, reviewerId: "ta-1", reviewerRole: "ta", decision: "approve", editedBody: "edited", reviewedAt: "2026-08-04T00:01:00.000Z" }, { actorId: "ta-1", role: "ta" })).rejects.toThrow("forced_failure");
    const draft = await adapter.getFeedbackDraft(trace.feedbackDraftId, { actorId: "teacher-1", role: "teacher" });
    expect(draft.status).toBe("draft"); expect(draft.trace.humanEdited).toBe(false);
    adapter.close();
  });

  it("rejects non-ISO datetimes", async () => {
    const { adapter, submission } = await seededAdapter();
    await expect(adapter.submitAssignment({ ...submission, submissionId: "bad-time", submittedAt: "yesterday" })).rejects.toThrow();
    adapter.close();
  });
});
