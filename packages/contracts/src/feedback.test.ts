import { describe, it, expect } from "vitest";
import {
  submitAssignmentInputSchema,
  reviewFeedbackInputSchema,
  publishFeedbackInputSchema
} from "./feedback";

describe("feedback contracts ISO-8601 datetime validation", () => {
  const baseSubmission = {
    submissionId: "sub-1",
    assignmentId: "assign-1",
    courseId: "course-1",
    classId: "class-1",
    learnerId: "learner-1",
    workspaceId: "ws-1",
    content: "Learner answer"
  };

  it("accepts valid Zulu ISO-8601 datetime strings", () => {
    const valid = submitAssignmentInputSchema.parse({
      ...baseSubmission,
      submittedAt: "2026-08-04T00:00:00.000Z"
    });
    expect(valid.submittedAt).toBe("2026-08-04T00:00:00.000Z");
  });

  it("accepts valid timezone offset ISO-8601 datetime strings", () => {
    const valid = submitAssignmentInputSchema.parse({
      ...baseSubmission,
      submittedAt: "2026-08-04T08:00:00.000+08:00"
    });
    expect(valid.submittedAt).toBe("2026-08-04T08:00:00.000+08:00");
  });

  it("rejects invalid date strings", () => {
    expect(() =>
      submitAssignmentInputSchema.parse({
        ...baseSubmission,
        submittedAt: "not-a-date"
      })
    ).toThrow();
  });

  it("rejects natural language date strings", () => {
    expect(() =>
      submitAssignmentInputSchema.parse({
        ...baseSubmission,
        submittedAt: "yesterday"
      })
    ).toThrow();
  });

  it("rejects invalid datetimes in review and publish inputs", () => {
    expect(() =>
      reviewFeedbackInputSchema.parse({
        feedbackDraftId: "draft-1",
        reviewerId: "t-1",
        reviewerRole: "teacher",
        decision: "approve",
        reviewedAt: "invalid-date"
      })
    ).toThrow();

    expect(() =>
      publishFeedbackInputSchema.parse({
        feedbackDraftId: "draft-1",
        publisherId: "t-1",
        publisherRole: "teacher",
        publishedAt: "2026-99-99"
      })
    ).toThrow();
  });
});
