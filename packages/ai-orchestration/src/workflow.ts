import type {
  FeedbackDraft,
  PublishFeedbackInput,
  PublishResult,
  ReviewFeedbackInput,
  StartFeedbackRunInput,
  SubmitAssignmentInput,
  AgentRunTrace,
  AssignmentSubmission
} from "@ai-smartbook/contracts";
import type { QmCompatibleOrchestrationPort } from "./ports";

export type EvaluateSubmissionInput = {
  submission: SubmitAssignmentInput;
  run: Omit<StartFeedbackRunInput, "submissionId" | "workspaceId"> & {
    workspaceId: string;
  };
};

export type EvaluatedSubmission = {
  submission: AssignmentSubmission;
  trace: AgentRunTrace;
  draft: FeedbackDraft;
};

/**
 * Application workflow for the teaching use case. It is deliberately
 * independent from QM and from HTTP/DB implementations so a later QM client
 * can replace the local adapter without changing the learner-facing contract.
 */
export class FeedbackWorkflowService {
  public constructor(private readonly orchestration: QmCompatibleOrchestrationPort) {}

  public async submitAndGenerate(input: EvaluateSubmissionInput): Promise<EvaluatedSubmission> {
    const submission = await this.orchestration.submitAssignment(input.submission);
    const trace = await this.orchestration.startFeedbackRun({
      ...input.run,
      submissionId: submission.submissionId,
      workspaceId: submission.workspaceId
    });
    const draft = await this.orchestration.getFeedbackDraft(trace.feedbackDraftId);
    return { submission, trace, draft };
  }

  public review(input: ReviewFeedbackInput): Promise<FeedbackDraft> {
    return this.orchestration.reviewFeedback(input);
  }

  public publish(input: PublishFeedbackInput): Promise<PublishResult> {
    return this.orchestration.publishFeedback(input);
  }
}
