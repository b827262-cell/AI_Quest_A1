import type {
  AgentRunTrace,
  AgentWorkspace,
  AssignmentSubmission,
  EnsureWorkspaceInput,
  FeedbackDraft,
  PublishFeedbackInput,
  PublishResult,
  ReviewFeedbackInput,
  StartFeedbackRunInput,
  SubmitAssignmentInput
} from "@ai-smartbook/contracts";

/**
 * QM-compatible application port.
 *
 * The domain sees only AI_Quest_A1 contracts. QM scope ids, HTTP payloads and
 * harness SDK response objects remain inside the deployment adapter.
 */
export interface QmCompatibleOrchestrationPort {
  ensureWorkspace(input: EnsureWorkspaceInput): Promise<AgentWorkspace>;
  submitAssignment(input: SubmitAssignmentInput): Promise<AssignmentSubmission>;
  startFeedbackRun(input: StartFeedbackRunInput): Promise<AgentRunTrace>;
  getRunTrace(runId: string): Promise<AgentRunTrace>;
  getFeedbackDraft(feedbackDraftId: string): Promise<FeedbackDraft>;
  reviewFeedback(input: ReviewFeedbackInput): Promise<FeedbackDraft>;
  publishFeedback(input: PublishFeedbackInput): Promise<PublishResult>;
}
