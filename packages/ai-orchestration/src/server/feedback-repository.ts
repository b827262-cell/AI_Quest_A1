import Database from "better-sqlite3";
import type {
  AgentRunTrace,
  AgentWorkspace,
  AssignmentSubmission,
  FeedbackDraft,
  PublishResult
} from "@ai-smartbook/contracts";

type Entity = AgentWorkspace | AssignmentSubmission | AgentRunTrace | FeedbackDraft | PublishResult;

export interface FeedbackRepository {
  transaction<T>(operation: () => T): T;
  findWorkspace(orgId: string, scopeKind: string, scopeId: string): AgentWorkspace | undefined;
  findWorkspaceById(id: string): AgentWorkspace | undefined;
  findSubmission(id: string): AssignmentSubmission | undefined;
  findTrace(id: string): AgentRunTrace | undefined;
  findDraft(id: string): FeedbackDraft | undefined;
  findPublication(feedbackDraftId: string): PublishResult | undefined;
  saveWorkspace(value: AgentWorkspace): void;
  saveSubmission(value: AssignmentSubmission): void;
  saveTrace(value: AgentRunTrace): void;
  saveDraft(value: FeedbackDraft): void;
  savePublication(value: PublishResult): void;
  close(): void;
}

const parse = <T extends Entity>(row: { document: string } | undefined): T | undefined =>
  row ? JSON.parse(row.document) as T : undefined;

export class SqliteFeedbackRepository implements FeedbackRepository {
  private readonly sqlite: Database.Database;

  public constructor(path = ":memory:") {
    this.sqlite = new Database(path);
    this.sqlite.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS qm_feedback_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qm_feedback_workspaces (
        workspace_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        document TEXT NOT NULL,
        UNIQUE (org_id, scope_kind, scope_id)
      );
      CREATE TABLE IF NOT EXISTS qm_feedback_submissions (
        submission_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES qm_feedback_workspaces(workspace_id),
        document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qm_feedback_traces (
        run_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES qm_feedback_submissions(submission_id),
        document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qm_feedback_drafts (
        feedback_draft_id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES qm_feedback_submissions(submission_id),
        run_id TEXT NOT NULL REFERENCES qm_feedback_traces(run_id),
        document TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qm_feedback_publications (
        feedback_draft_id TEXT PRIMARY KEY REFERENCES qm_feedback_drafts(feedback_draft_id),
        document TEXT NOT NULL
      );
      INSERT OR IGNORE INTO qm_feedback_schema_migrations (version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
  }

  public transaction<T>(operation: () => T): T {
    return this.sqlite.transaction(operation)();
  }

  public findWorkspace(orgId: string, scopeKind: string, scopeId: string): AgentWorkspace | undefined {
    return parse(this.sqlite.prepare(
      "SELECT document FROM qm_feedback_workspaces WHERE org_id = ? AND scope_kind = ? AND scope_id = ?"
    ).get(orgId, scopeKind, scopeId) as { document: string } | undefined);
  }

  public findWorkspaceById(id: string): AgentWorkspace | undefined {
    return parse(this.sqlite.prepare("SELECT document FROM qm_feedback_workspaces WHERE workspace_id = ?")
      .get(id) as { document: string } | undefined);
  }

  public findSubmission(id: string): AssignmentSubmission | undefined {
    return parse(this.sqlite.prepare("SELECT document FROM qm_feedback_submissions WHERE submission_id = ?")
      .get(id) as { document: string } | undefined);
  }

  public findTrace(id: string): AgentRunTrace | undefined {
    return parse(this.sqlite.prepare("SELECT document FROM qm_feedback_traces WHERE run_id = ?")
      .get(id) as { document: string } | undefined);
  }

  public findDraft(id: string): FeedbackDraft | undefined {
    return parse(this.sqlite.prepare("SELECT document FROM qm_feedback_drafts WHERE feedback_draft_id = ?")
      .get(id) as { document: string } | undefined);
  }

  public findPublication(id: string): PublishResult | undefined {
    return parse(this.sqlite.prepare("SELECT document FROM qm_feedback_publications WHERE feedback_draft_id = ?")
      .get(id) as { document: string } | undefined);
  }

  public saveWorkspace(value: AgentWorkspace): void {
    this.sqlite.prepare(`INSERT INTO qm_feedback_workspaces
      (workspace_id, org_id, scope_kind, scope_id, document) VALUES (?, ?, ?, ?, ?)`)
      .run(value.workspaceId, value.orgId, value.scopeKind, value.scopeId, JSON.stringify(value));
  }

  public saveSubmission(value: AssignmentSubmission): void {
    this.sqlite.prepare(`INSERT INTO qm_feedback_submissions
      (submission_id, workspace_id, document) VALUES (?, ?, ?)`)
      .run(value.submissionId, value.workspaceId, JSON.stringify(value));
  }

  public saveTrace(value: AgentRunTrace): void {
    this.sqlite.prepare(`INSERT INTO qm_feedback_traces (run_id, submission_id, document) VALUES (?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET document = excluded.document`)
      .run(value.runId, value.submissionId, JSON.stringify(value));
  }

  public saveDraft(value: FeedbackDraft): void {
    this.sqlite.prepare(`INSERT INTO qm_feedback_drafts
      (feedback_draft_id, submission_id, run_id, document) VALUES (?, ?, ?, ?)
      ON CONFLICT(feedback_draft_id) DO UPDATE SET document = excluded.document`)
      .run(value.feedbackDraftId, value.submissionId, value.trace.runId, JSON.stringify(value));
  }

  public savePublication(value: PublishResult): void {
    this.sqlite.prepare("INSERT INTO qm_feedback_publications (feedback_draft_id, document) VALUES (?, ?)")
      .run(value.feedbackDraftId, JSON.stringify(value));
  }

  public close(): void { this.sqlite.close(); }
}
