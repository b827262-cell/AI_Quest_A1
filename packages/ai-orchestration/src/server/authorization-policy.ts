import type { AgentWorkspace, AssignmentSubmission } from "@ai-smartbook/contracts";
import type { AuthenticatedActor } from "../ports";

export interface FeedbackAuthorizationPolicy {
  authorizeSubmission(actor: AuthenticatedActor, workspace: AgentWorkspace, submission: AssignmentSubmission): void;
  authorizeReview(actor: AuthenticatedActor, workspace: AgentWorkspace): void;
  authorizePublish(actor: AuthenticatedActor, workspace: AgentWorkspace): void;
  authorizeStaffRead(actor: AuthenticatedActor, workspace: AgentWorkspace): void;
}

export class ServerFeedbackAuthorizationPolicy implements FeedbackAuthorizationPolicy {
  private requireStaffMember(actor: AuthenticatedActor, workspace: AgentWorkspace): void {
    if (!(["teacher", "ta", "admin"].includes(actor.role))) throw new Error("feedback_forbidden");
    if (actor.role !== "admin" && actor.actorId !== workspace.ownerId && !workspace.sharedWithIds.includes(actor.actorId)) {
      throw new Error("feedback_forbidden");
    }
  }

  public authorizeSubmission(actor: AuthenticatedActor, workspace: AgentWorkspace, submission: AssignmentSubmission): void {
    if (actor.role === "learner") {
      if (actor.actorId !== submission.learnerId || workspace.scopeKind === "class") throw new Error("feedback_forbidden");
      return;
    }
    this.requireStaffMember(actor, workspace);
  }

  public authorizeReview(actor: AuthenticatedActor, workspace: AgentWorkspace): void {
    this.requireStaffMember(actor, workspace);
  }

  public authorizePublish(actor: AuthenticatedActor, workspace: AgentWorkspace): void {
    this.requireStaffMember(actor, workspace);
  }

  public authorizeStaffRead(actor: AuthenticatedActor, workspace: AgentWorkspace): void {
    this.requireStaffMember(actor, workspace);
  }
}
