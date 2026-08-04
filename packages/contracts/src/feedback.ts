import { z } from "zod";

const idSchema = z.string().trim().min(1);
const versionSchema = z.string().trim().min(1).max(160);
const timestampSchema = z.string().datetime({ offset: true });

export const agentHarnessSchema = z.enum(["qm", "codex", "claude-code", "opencode", "pi"]);
export type AgentHarness = z.infer<typeof agentHarnessSchema>;

export const workspaceScopeKindSchema = z.enum(["learner", "class", "course", "shared"]);
export type WorkspaceScopeKind = z.infer<typeof workspaceScopeKindSchema>;

export const runStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const feedbackStatusSchema = z.enum([
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "published"
]);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;

export const reviewerRoleSchema = z.enum(["teacher", "ta"]);
export type ReviewerRole = z.infer<typeof reviewerRoleSchema>;

export const sourceKindSchema = z.enum(["book", "chapter", "lesson", "submission", "external"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const sourceReferenceSchema = z.object({
  sourceId: idSchema,
  kind: sourceKindSchema,
  label: z.string().trim().min(1).max(240).optional()
});
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const rubricReferenceSchema = z.object({
  rubricId: idSchema,
  version: versionSchema
});
export type RubricReference = z.infer<typeof rubricReferenceSchema>;

export const agentWorkspaceSchema = z.object({
  workspaceId: idSchema,
  orgId: idSchema,
  scopeId: idSchema,
  scopeKind: workspaceScopeKindSchema,
  ownerId: idSchema,
  sharedWithIds: z.array(idSchema),
  createdAt: timestampSchema
});
export type AgentWorkspace = z.infer<typeof agentWorkspaceSchema>;

export const ensureWorkspaceInputSchema = z.object({
  orgId: idSchema,
  scopeId: idSchema,
  scopeKind: workspaceScopeKindSchema,
  ownerId: idSchema,
  sharedWithIds: z.array(idSchema).default([])
});
export type EnsureWorkspaceInput = z.input<typeof ensureWorkspaceInputSchema>;

export const assignmentSubmissionSchema = z.object({
  submissionId: idSchema,
  assignmentId: idSchema,
  courseId: idSchema,
  classId: idSchema.nullable(),
  learnerId: idSchema,
  workspaceId: idSchema,
  content: z.string().trim().min(1),
  submittedAt: timestampSchema,
  sourceReferences: z.array(sourceReferenceSchema)
});
export type AssignmentSubmission = z.infer<typeof assignmentSubmissionSchema>;

export const submitAssignmentInputSchema = z.object({
  submissionId: idSchema,
  assignmentId: idSchema,
  courseId: idSchema,
  classId: idSchema.nullable().default(null),
  learnerId: idSchema,
  workspaceId: idSchema,
  content: z.string().trim().min(1),
  submittedAt: timestampSchema,
  sourceReferences: z.array(sourceReferenceSchema).default([])
});
export type SubmitAssignmentInput = z.input<typeof submitAssignmentInputSchema>;

export const usageSummarySchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  estimatedCostMicroUsd: z.number().int().nonnegative().nullable(),
  currency: z.string().trim().min(1).default("USD")
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;

export const agentRunTraceSchema = z.object({
  runId: idSchema,
  traceId: idSchema,
  feedbackDraftId: idSchema,
  submissionId: idSchema,
  workspaceId: idSchema,
  status: runStatusSchema,
  harness: agentHarnessSchema,
  harnessVersion: versionSchema,
  qmCliVersion: versionSchema,
  promptVersion: versionSchema,
  rubricVersion: versionSchema,
  provider: idSchema,
  model: idSchema,
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  errorSummary: z.string().trim().max(500).nullable(),
  sourceReferences: z.array(sourceReferenceSchema),
  humanEdited: z.boolean(),
  editedBy: idSchema.nullable(),
  editedAt: timestampSchema.nullable(),
  reviewedBy: idSchema.nullable(),
  reviewerRole: reviewerRoleSchema.nullable(),
  reviewedAt: timestampSchema.nullable(),
  reviewNote: z.string().trim().max(1000).nullable(),
  publishedBy: idSchema.nullable(),
  publisherRole: reviewerRoleSchema.nullable(),
  publishedAt: timestampSchema.nullable(),
  usage: usageSummarySchema.nullable()
});
export type AgentRunTrace = z.infer<typeof agentRunTraceSchema>;

export const startFeedbackRunInputSchema = z.object({
  submissionId: idSchema,
  workspaceId: idSchema,
  harness: agentHarnessSchema.default("qm"),
  harnessVersion: versionSchema,
  qmCliVersion: versionSchema,
  promptVersion: versionSchema,
  rubric: rubricReferenceSchema,
  provider: idSchema,
  model: idSchema,
  sourceReferences: z.array(sourceReferenceSchema).default([]),
  usage: usageSummarySchema.nullable().default(null)
});
export type StartFeedbackRunInput = z.input<typeof startFeedbackRunInputSchema>;

export const feedbackDraftSchema = z.object({
  feedbackDraftId: idSchema,
  submissionId: idSchema,
  workspaceId: idSchema,
  status: feedbackStatusSchema,
  body: z.string().trim().min(1),
  rubric: rubricReferenceSchema,
  trace: agentRunTraceSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema
});
export type FeedbackDraft = z.infer<typeof feedbackDraftSchema>;

export const reviewDecisionSchema = z.enum(["approve", "request_changes"]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const reviewFeedbackInputSchema = z.object({
  feedbackDraftId: idSchema,
  reviewerId: idSchema,
  reviewerRole: reviewerRoleSchema,
  decision: reviewDecisionSchema,
  editedBody: z.string().trim().min(1).optional(),
  reviewNote: z.string().trim().max(1000).optional(),
  reviewedAt: timestampSchema
});
export type ReviewFeedbackInput = z.input<typeof reviewFeedbackInputSchema>;

export const publishFeedbackInputSchema = z.object({
  feedbackDraftId: idSchema,
  publisherId: idSchema,
  publisherRole: reviewerRoleSchema,
  publishedAt: timestampSchema
});
export type PublishFeedbackInput = z.input<typeof publishFeedbackInputSchema>;

export const publishResultSchema = z.object({
  feedbackDraftId: idSchema,
  submissionId: idSchema,
  audience: z.literal("learner"),
  publishedBy: idSchema,
  publisherRole: reviewerRoleSchema,
  publishedAt: timestampSchema,
  status: z.literal("published"),
  trace: agentRunTraceSchema
});
export type PublishResult = z.infer<typeof publishResultSchema>;

export type FeedbackContract = {
  workspace: AgentWorkspace;
  submission: AssignmentSubmission;
  draft: FeedbackDraft;
  trace: AgentRunTrace;
  publish: PublishResult;
};
