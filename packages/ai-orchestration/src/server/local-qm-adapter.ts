import { randomUUID } from "node:crypto";
import {
  agentRunTraceSchema,
  agentWorkspaceSchema,
  assignmentSubmissionSchema,
  feedbackDraftSchema,
  publishFeedbackInputSchema,
  publishResultSchema,
  reviewFeedbackInputSchema,
  startFeedbackRunInputSchema,
  submitAssignmentInputSchema,
  ensureWorkspaceInputSchema,
  type AgentRunTrace,
  type AgentWorkspace,
  type AssignmentSubmission,
  type FeedbackDraft,
  type PublishFeedbackInput,
  type PublishResult,
  type ReviewFeedbackInput,
  type StartFeedbackRunInput,
  type SubmitAssignmentInput,
  type EnsureWorkspaceInput
} from "@ai-smartbook/contracts";
import type { QmCompatibleOrchestrationPort } from "../ports";

export type LocalQmAdapterOptions = {
  now?: () => string;
  idFactory?: (prefix: string) => string;
  qmCliVersion?: string;
};

const defaultNow = (): string => new Date().toISOString();
const defaultIdFactory = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;

/**
 * In-memory deployment adapter for local contract tests.
 *
 * It models the deployment boundary and never imports QM internals or a QM
 * server SDK. A production adapter can map the same port to the standalone
 * deployment's API in a server-only package.
 */
export class LocalQmAdapter implements QmCompatibleOrchestrationPort {
  private readonly now: () => string;
  private readonly idFactory: (prefix: string) => string;
  private readonly qmCliVersion: string;
  private readonly workspaces = new Map<string, AgentWorkspace>();
  private readonly submissions = new Map<string, AssignmentSubmission>();
  private readonly traces = new Map<string, AgentRunTrace>();
  private readonly drafts = new Map<string, FeedbackDraft>();

  public constructor(options: LocalQmAdapterOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.qmCliVersion = options.qmCliVersion ?? "0.1.4";
  }

  public async ensureWorkspace(input: EnsureWorkspaceInput): Promise<AgentWorkspace> {
    const parsed = ensureWorkspaceInputSchema.parse(input);
    const existing = [...this.workspaces.values()].find(
      (workspace) => workspace.orgId === parsed.orgId && workspace.scopeId === parsed.scopeId
    );
    if (existing) return existing;

    const workspace = agentWorkspaceSchema.parse({
      workspaceId: this.idFactory("workspace"),
      orgId: parsed.orgId,
      scopeId: parsed.scopeId,
      scopeKind: parsed.scopeKind,
      ownerId: parsed.ownerId,
      sharedWithIds: parsed.sharedWithIds,
      createdAt: this.now()
    });
    this.workspaces.set(workspace.workspaceId, workspace);
    return workspace;
  }

  public async submitAssignment(input: SubmitAssignmentInput): Promise<AssignmentSubmission> {
    const parsed = submitAssignmentInputSchema.parse(input);
    if (!this.workspaces.has(parsed.workspaceId)) throw new Error("workspace_not_found");

    const submission = assignmentSubmissionSchema.parse(parsed);
    this.submissions.set(submission.submissionId, submission);
    return submission;
  }

  public async startFeedbackRun(input: StartFeedbackRunInput): Promise<AgentRunTrace> {
    const parsed = startFeedbackRunInputSchema.parse(input);
    if (parsed.qmCliVersion !== this.qmCliVersion) throw new Error("qm_cli_version_mismatch");
    const submission = this.submissions.get(parsed.submissionId);
    if (!submission || submission.workspaceId !== parsed.workspaceId) throw new Error("submission_not_found");

    const startedAt = this.now();
    const feedbackDraftId = this.idFactory("feedback");
    const runId = this.idFactory("run");
    const trace = agentRunTraceSchema.parse({
      runId,
      traceId: this.idFactory("trace"),
      feedbackDraftId,
      submissionId: submission.submissionId,
      workspaceId: submission.workspaceId,
      status: "succeeded",
      harness: parsed.harness,
      harnessVersion: parsed.harnessVersion,
      qmCliVersion: this.qmCliVersion,
      promptVersion: parsed.promptVersion,
      rubricVersion: parsed.rubric.version,
      provider: parsed.provider,
      model: parsed.model,
      startedAt,
      completedAt: this.now(),
      errorSummary: null,
      sourceReferences: parsed.sourceReferences,
      humanEdited: false,
      editedBy: null,
      editedAt: null,
      reviewedBy: null,
      reviewerRole: null,
      reviewedAt: null,
      reviewNote: null,
      publishedBy: null,
      publisherRole: null,
      publishedAt: null,
      usage: parsed.usage
    });
    const draft = feedbackDraftSchema.parse({
      feedbackDraftId,
      submissionId: submission.submissionId,
      workspaceId: submission.workspaceId,
      status: "draft",
      body: `已收到作業「${submission.assignmentId}」。這是本機 QM adapter 產生的可審核回饋草稿。`,
      rubric: parsed.rubric,
      trace,
      createdAt: startedAt,
      updatedAt: this.now()
    });
    this.traces.set(trace.runId, trace);
    this.drafts.set(draft.feedbackDraftId, draft);
    return trace;
  }

  public async getRunTrace(runId: string): Promise<AgentRunTrace> {
    const trace = this.traces.get(runId);
    if (!trace) throw new Error("run_not_found");
    return trace;
  }

  public async getFeedbackDraft(feedbackDraftId: string): Promise<FeedbackDraft> {
    const draft = this.drafts.get(feedbackDraftId);
    if (!draft) throw new Error("feedback_draft_not_found");
    return draft;
  }

  public async reviewFeedback(input: ReviewFeedbackInput): Promise<FeedbackDraft> {
    const parsed = reviewFeedbackInputSchema.parse(input);
    const current = this.drafts.get(parsed.feedbackDraftId);
    if (!current) throw new Error("feedback_draft_not_found");
    if (!["draft", "in_review", "changes_requested"].includes(current.status)) {
      throw new Error("feedback_draft_not_reviewable");
    }
    if (parsed.decision === "approve" && !parsed.editedBody && !current.body) {
      throw new Error("approved_feedback_requires_body");
    }

    const body = parsed.editedBody ?? current.body;
    const humanEdited = body !== current.body || current.trace.humanEdited;
    const trace = agentRunTraceSchema.parse({
      ...current.trace,
      humanEdited,
      editedBy: humanEdited ? parsed.reviewerId : current.trace.editedBy,
      editedAt: humanEdited ? parsed.reviewedAt : current.trace.editedAt,
      reviewedBy: parsed.reviewerId,
      reviewerRole: parsed.reviewerRole,
      reviewedAt: parsed.reviewedAt,
      reviewNote: parsed.reviewNote ?? null
    });
    const updated = feedbackDraftSchema.parse({
      ...current,
      status: parsed.decision === "approve" ? "approved" : "changes_requested",
      body,
      trace,
      updatedAt: parsed.reviewedAt
    });
    this.traces.set(trace.runId, trace);
    this.drafts.set(updated.feedbackDraftId, updated);
    return updated;
  }

  public async publishFeedback(input: PublishFeedbackInput): Promise<PublishResult> {
    const parsed = publishFeedbackInputSchema.parse(input);
    const current = this.drafts.get(parsed.feedbackDraftId);
    if (!current) throw new Error("feedback_draft_not_found");
    if (current.status !== "approved") throw new Error("feedback_draft_not_approved");

    const trace = agentRunTraceSchema.parse({
      ...current.trace,
      publishedBy: parsed.publisherId,
      publisherRole: parsed.publisherRole,
      publishedAt: parsed.publishedAt
    });
    const publishedDraft = feedbackDraftSchema.parse({
      ...current,
      status: "published",
      trace,
      updatedAt: parsed.publishedAt
    });
    const result = publishResultSchema.parse({
      feedbackDraftId: publishedDraft.feedbackDraftId,
      submissionId: publishedDraft.submissionId,
      audience: "learner",
      publishedBy: parsed.publisherId,
      publisherRole: parsed.publisherRole,
      publishedAt: parsed.publishedAt,
      status: "published",
      trace
    });
    this.traces.set(trace.runId, trace);
    this.drafts.set(publishedDraft.feedbackDraftId, publishedDraft);
    return result;
  }
}

export const createLocalQmAdapter = (options?: LocalQmAdapterOptions): LocalQmAdapter =>
  new LocalQmAdapter(options);
