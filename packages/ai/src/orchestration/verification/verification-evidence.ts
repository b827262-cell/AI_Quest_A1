import type { TaskCategory, TaskClassification } from "../classification/classification-types";

export type VerificationStrategyName =
  | "programming_static"
  | "programming_runtime"
  | "mathematical_numeric"
  | "mathematical_structured"
  | "knowledge_consistency"
  | "generic_model"
  | "none";

export type VerificationEvidenceStatus =
  | "passed"
  | "failed"
  | "partial"
  | "not_applicable"
  | "unavailable";

export interface VerificationEvidenceIssue {
  category: string;
  severity: "low" | "medium" | "high";
  message: string;
}

export interface VerificationEvidence {
  strategy: VerificationStrategyName;
  status: VerificationEvidenceStatus;
  confidence: number;
  issues: VerificationEvidenceIssue[];
  safeSummary?: string;
  /** Runtime remains unavailable unless a separately reviewed sandbox is injected. */
  runtimeVerification?: "available" | "unavailable";
}

export interface VerificationStrategyContext {
  requestId: string;
  question: string;
  primaryAnswer: string;
  logicalModelId: string;
  classification: TaskClassification;
}

export interface DomainVerificationStrategy {
  supports(category: TaskCategory): boolean;
  verify(context: VerificationStrategyContext): Promise<VerificationEvidence>;
}

export interface CodeExecutionPort {
  isAvailable(): boolean;
  execute(request: SafeCodeExecutionRequest): Promise<SafeCodeExecutionResult>;
}

export interface SafeCodeExecutionRequest {
  language: "c" | "cpp" | "python" | "javascript" | "typescript" | "java" | "unknown";
  source: string;
}

export interface SafeCodeExecutionResult {
  status: "passed" | "failed" | "unavailable";
  output?: string;
  safeReason?: string;
}

export interface NumericVerificationResult {
  expression?: string;
  expectedValue?: number;
  answerValue?: number;
  tolerance?: number;
  matched?: boolean;
}

export interface KnowledgeClaim {
  id: string;
  text: string;
  importance: "supporting" | "core";
}

export interface KnowledgeClaimAssessment {
  claimId: string;
  result: "supported" | "contradicted" | "uncertain" | "not_checked";
  severity: "low" | "medium" | "high";
  safeReason?: string;
}

export function safeEvidenceIssue(
  category: string,
  severity: VerificationEvidenceIssue["severity"],
  message: string
): VerificationEvidenceIssue {
  const safeCategory = /^[a-z_]{1,40}$/.test(category) ? category : "other";
  const safeMessage = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 240);
  return { category: safeCategory, severity, message: safeMessage || "verification_issue" };
}

export function clampEvidenceConfidence(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Claim assessment parser; raw response is intentionally not retained on failure. */
export function parseKnowledgeClaimAssessments(
  raw: string,
  claims: KnowledgeClaim[]
): { ok: true; value: KnowledgeClaimAssessment[] } | { ok: false; reason: "invalid_json" | "invalid_shape" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!Array.isArray(parsed) || parsed.length > 8) return { ok: false, reason: "invalid_shape" };
  const ids = new Set(claims.map((claim) => claim.id));
  const allowed = new Set(["supported", "contradicted", "uncertain", "not_checked"]);
  const severities = new Set(["low", "medium", "high"]);
  const assessments: KnowledgeClaimAssessment[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return { ok: false, reason: "invalid_shape" };
    const record = item as Record<string, unknown>;
    if (
      typeof record.claimId !== "string" || !ids.has(record.claimId) ||
      typeof record.result !== "string" || !allowed.has(record.result) ||
      typeof record.severity !== "string" || !severities.has(record.severity) ||
      (record.safeReason !== undefined && typeof record.safeReason !== "string")
    ) return { ok: false, reason: "invalid_shape" };
    assessments.push({
      claimId: record.claimId,
      result: record.result as KnowledgeClaimAssessment["result"],
      severity: record.severity as KnowledgeClaimAssessment["severity"],
      safeReason: typeof record.safeReason === "string" ? record.safeReason.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240) : undefined
    });
  }
  return { ok: true, value: assessments };
}
