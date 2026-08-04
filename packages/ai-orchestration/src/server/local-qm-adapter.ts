import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  agentRunTraceSchema,
  agentWorkspaceSchema,
  assignmentSubmissionSchema,
  ensureWorkspaceInputSchema,
  feedbackDraftSchema,
  publishFeedbackInputSchema,
  publishResultSchema,
  reviewFeedbackInputSchema,
  startFeedbackRunInputSchema,
  submitAssignmentInputSchema,
  type AgentRunTrace,
  type AgentWorkspace,
  type AssignmentSubmission,
  type EnsureWorkspaceInput,
  type FeedbackDraft,
  type PublishFeedbackInput,
  type PublishResult,
  type ReviewFeedbackInput,
  type StartFeedbackRunInput,
  type SubmitAssignmentInput
} from "@ai-smartbook/contracts";
import type { AuthenticatedActor, QmCompatibleOrchestrationPort } from "../ports";
import {
  ServerFeedbackAuthorizationPolicy,
  type FeedbackAuthorizationPolicy
} from "./authorization-policy";
import { SqliteFeedbackRepository, type FeedbackRepository } from "./feedback-repository";

export type LocalQmAdapterOptions = {
  now?: () => string;
  idFactory?: (prefix: string) => string;
  qmCliVersion?: string;
  databasePath?: string;
  repository?: FeedbackRepository;
  authorizationPolicy?: FeedbackAuthorizationPolicy;
  transactionProbe?: (stage: "review_saved" | "publish_saved") => void;
};

const defaultNow = (): string => new Date().toISOString();
const defaultIdFactory = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;

/** SQLite-backed server adapter. It does not claim or guess a QM network API. */
export class LocalQmAdapter implements QmCompatibleOrchestrationPort {
  private readonly now: () => string;
  private readonly idFactory: (prefix: string) => string;
  private readonly qmCliVersion: string;
  private readonly repository: FeedbackRepository;
  private readonly authorization: FeedbackAuthorizationPolicy;
  private readonly transactionProbe?: LocalQmAdapterOptions["transactionProbe"];

  public constructor(options: LocalQmAdapterOptions = {}) {
    this.now = options.now ?? defaultNow;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.qmCliVersion = options.qmCliVersion ?? "0.1.4";
    this.repository = options.repository ?? new SqliteFeedbackRepository(options.databasePath);
    this.authorization = options.authorizationPolicy ?? new ServerFeedbackAuthorizationPolicy();
    this.transactionProbe = options.transactionProbe;
  }

  public close(): void { this.repository.close(); }

  public async ensureWorkspace(input: EnsureWorkspaceInput): Promise<AgentWorkspace> {
    const parsed = ensureWorkspaceInputSchema.parse(input);
    const existing = this.repository.findWorkspace(parsed.orgId, parsed.scopeKind, parsed.scopeId);
    if (existing) {
      const requestedMembers = [...parsed.sharedWithIds].sort();
      const existingMembers = [...existing.sharedWithIds].sort();
      if (existing.ownerId !== parsed.ownerId || !isDeepStrictEqual(existingMembers, requestedMembers)) {
        throw new Error("workspace_identity_conflict");
      }
      return existing;
    }
    const workspace = agentWorkspaceSchema.parse({
      workspaceId: this.idFactory("workspace"), ...parsed, createdAt: this.now()
    });
    this.repository.saveWorkspace(workspace);
    return workspace;
  }

  public async submitAssignment(input: SubmitAssignmentInput): Promise<AssignmentSubmission> {
    const parsed = assignmentSubmissionSchema.parse(submitAssignmentInputSchema.parse(input));
    const workspace = this.repository.findWorkspaceById(parsed.workspaceId);
    if (!workspace) throw new Error("workspace_not_found");
    if (workspace.scopeKind === "class" && workspace.scopeId !== parsed.classId) {
      throw new Error("submission_workspace_mismatch");
    }
    if (workspace.scopeKind === "course" && workspace.scopeId !== parsed.courseId) {
      throw new Error("submission_workspace_mismatch");
    }
    const existing = this.repository.findSubmission(parsed.submissionId);
    if (existing) {
      if (!isDeepStrictEqual(existing, parsed)) throw new Error("submission_id_conflict");
      return existing;
    }
    this.repository.saveSubmission(parsed);
    return parsed;
  }

  public async startFeedbackRun(input: StartFeedbackRunInput): Promise<AgentRunTrace> {
    const parsed = startFeedbackRunInputSchema.parse(input);
    if (parsed.qmCliVersion !== this.qmCliVersion) throw new Error("qm_cli_version_mismatch");
    const submission = this.repository.findSubmission(parsed.submissionId);
    if (!submission || submission.workspaceId !== parsed.workspaceId) throw new Error("submission_not_found");
    const startedAt = this.now();
    const feedbackDraftId = this.idFactory("feedback");
    const trace = agentRunTraceSchema.parse({
      runId: this.idFactory("run"), traceId: this.idFactory("trace"), feedbackDraftId,
      submissionId: submission.submissionId, workspaceId: submission.workspaceId,
      status: "succeeded", harness: parsed.harness, harnessVersion: parsed.harnessVersion,
      qmCliVersion: this.qmCliVersion, promptVersion: parsed.promptVersion,
      rubricVersion: parsed.rubric.version, provider: parsed.provider, model: parsed.model,
      startedAt, completedAt: this.now(), errorSummary: null,
      sourceReferences: parsed.sourceReferences, humanEdited: false, editedBy: null, editedAt: null,
      reviewedBy: null, reviewerRole: null, reviewedAt: null, reviewNote: null,
      publishedBy: null, publisherRole: null, publishedAt: null, usage: parsed.usage
    });
    const draft = feedbackDraftSchema.parse({
      feedbackDraftId, submissionId: submission.submissionId, workspaceId: submission.workspaceId,
      status: "draft", body: `已收到作業「${submission.assignmentId}」。這是可審核回饋草稿。`,
      rubric: parsed.rubric, trace, createdAt: startedAt, updatedAt: this.now()
    });
    this.repository.transaction(() => { this.repository.saveTrace(trace); this.repository.saveDraft(draft); });
    return trace;
  }

  public async getRunTrace(runId: string, actor: AuthenticatedActor): Promise<AgentRunTrace> {
    const value = this.repository.findTrace(runId);
    if (!value) throw new Error("run_not_found");
    const workspace = this.repository.findWorkspaceById(value.workspaceId);
    if (!workspace) throw new Error("workspace_not_found");
    this.authorization.authorizeStaffRead(actor, workspace);
    return value;
  }

  public async getFeedbackDraft(id: string, actor: AuthenticatedActor): Promise<FeedbackDraft> {
    const value = this.repository.findDraft(id);
    if (!value) throw new Error("feedback_draft_not_found");
    const workspace = this.repository.findWorkspaceById(value.workspaceId);
    if (!workspace) throw new Error("workspace_not_found");
    this.authorization.authorizeStaffRead(actor, workspace);
    return value;
  }

  public async reviewFeedback(input: ReviewFeedbackInput, actor: AuthenticatedActor): Promise<FeedbackDraft> {
    const parsed = reviewFeedbackInputSchema.parse(input);
    if (parsed.reviewerId !== actor.actorId || parsed.reviewerRole !== actor.role) throw new Error("actor_claim_mismatch");
    const current = this.repository.findDraft(parsed.feedbackDraftId);
    if (!current) throw new Error("feedback_draft_not_found");
    const workspace = this.repository.findWorkspaceById(current.workspaceId);
    if (!workspace) throw new Error("workspace_not_found");
    this.authorization.authorizeReview(actor, workspace);
    if (!["draft", "in_review", "changes_requested"].includes(current.status)) throw new Error("feedback_draft_not_reviewable");
    const body = parsed.editedBody ?? current.body;
    const changedNow = body !== current.body;
    const trace = agentRunTraceSchema.parse({
      ...current.trace, humanEdited: changedNow || current.trace.humanEdited,
      editedBy: changedNow ? actor.actorId : current.trace.editedBy,
      editedAt: changedNow ? parsed.reviewedAt : current.trace.editedAt,
      reviewedBy: actor.actorId, reviewerRole: actor.role, reviewedAt: parsed.reviewedAt,
      reviewNote: parsed.reviewNote ?? null
    });
    const updated = feedbackDraftSchema.parse({ ...current,
      status: parsed.decision === "approve" ? "approved" : "changes_requested",
      body, trace, updatedAt: parsed.reviewedAt
    });
    return this.repository.transaction(() => {
      this.repository.saveTrace(trace); this.repository.saveDraft(updated);
      this.transactionProbe?.("review_saved");
      return updated;
    });
  }

  public async publishFeedback(input: PublishFeedbackInput, actor: AuthenticatedActor): Promise<PublishResult> {
    const parsed = publishFeedbackInputSchema.parse(input);
    if (parsed.publisherId !== actor.actorId || parsed.publisherRole !== actor.role) throw new Error("actor_claim_mismatch");
    const current = this.repository.findDraft(parsed.feedbackDraftId);
    if (!current) throw new Error("feedback_draft_not_found");
    const workspace = this.repository.findWorkspaceById(current.workspaceId);
    if (!workspace) throw new Error("workspace_not_found");
    this.authorization.authorizePublish(actor, workspace);
    if (this.repository.findPublication(current.feedbackDraftId)) throw new Error("feedback_already_published");
    if (current.status !== "approved") throw new Error("feedback_draft_not_approved");
    const trace = agentRunTraceSchema.parse({ ...current.trace,
      publishedBy: actor.actorId, publisherRole: actor.role, publishedAt: parsed.publishedAt
    });
    const publishedDraft = feedbackDraftSchema.parse({ ...current, status: "published", trace, updatedAt: parsed.publishedAt });
    const result = publishResultSchema.parse({ feedbackDraftId: current.feedbackDraftId,
      submissionId: current.submissionId, audience: "learner", publishedBy: actor.actorId,
      publisherRole: actor.role, publishedAt: parsed.publishedAt, status: "published", trace
    });
    return this.repository.transaction(() => {
      this.repository.saveTrace(trace); this.repository.saveDraft(publishedDraft);
      this.repository.savePublication(result); this.transactionProbe?.("publish_saved"); return result;
    });
  }
}

export const createLocalQmAdapter = (options?: LocalQmAdapterOptions): LocalQmAdapter => new LocalQmAdapter(options);
