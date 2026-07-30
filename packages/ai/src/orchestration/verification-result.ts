export type VerificationDecision = "agree" | "supplement" | "conflict" | "uncertain";

export type VerificationIssueCategory =
  | "factual"
  | "calculation"
  | "logic"
  | "code"
  | "safety"
  | "missing_information"
  | "other";

export type VerificationIssueSeverity = "low" | "medium" | "high";

export interface VerificationIssue {
  category: VerificationIssueCategory;
  severity: VerificationIssueSeverity;
  description: string;
}

export interface VerificationResult {
  decision: VerificationDecision;
  confidence?: number;
  issues: VerificationIssue[];
  supplementalContent?: string | null;
  proposedAnswer?: string | null;
}

export type VerificationParseFailure =
  | "empty"
  | "invalid_json"
  | "not_object"
  | "unknown_field"
  | "invalid_decision"
  | "invalid_confidence"
  | "invalid_issues"
  | "invalid_content";

export type VerificationParseResult =
  | { ok: true; value: VerificationResult }
  | { ok: false; reason: VerificationParseFailure };

const DECISIONS = new Set<VerificationDecision>(["agree", "supplement", "conflict", "uncertain"]);
const CATEGORIES = new Set<VerificationIssueCategory>([
  "factual",
  "calculation",
  "logic",
  "code",
  "safety",
  "missing_information",
  "other"
]);
const SEVERITIES = new Set<VerificationIssueSeverity>(["low", "medium", "high"]);
const ALLOWED_FIELDS = new Set([
  "decision",
  "confidence",
  "issues",
  "supplementalContent",
  "proposedAnswer"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalText(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/**
 * Strictly parse the small JSON contract expected from a verification model.
 * Failure results never retain the raw model output or provider error.
 */
export function parseVerificationResult(raw: string): VerificationParseResult {
  if (!raw.trim()) return { ok: false, reason: "empty" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "not_object" };
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.has(key)) return { ok: false, reason: "unknown_field" };
  }

  const decision = parsed.decision;
  if (typeof decision !== "string" || !DECISIONS.has(decision as VerificationDecision)) {
    return { ok: false, reason: "invalid_decision" };
  }

  const confidence = parsed.confidence;
  if (
    confidence !== undefined &&
    (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) {
    return { ok: false, reason: "invalid_confidence" };
  }

  if (!Array.isArray(parsed.issues) || parsed.issues.length > 32) {
    return { ok: false, reason: "invalid_issues" };
  }
  const issues: VerificationIssue[] = [];
  for (const issue of parsed.issues) {
    if (!isRecord(issue)) return { ok: false, reason: "invalid_issues" };
    if (
      typeof issue.category !== "string" ||
      !CATEGORIES.has(issue.category as VerificationIssueCategory) ||
      typeof issue.severity !== "string" ||
      !SEVERITIES.has(issue.severity as VerificationIssueSeverity) ||
      typeof issue.description !== "string" ||
      issue.description.trim().length === 0 ||
      issue.description.length > 2_000
    ) {
      return { ok: false, reason: "invalid_issues" };
    }
    issues.push({
      category: issue.category as VerificationIssueCategory,
      severity: issue.severity as VerificationIssueSeverity,
      description: issue.description.trim()
    });
  }

  if (!isOptionalText(parsed.supplementalContent) || !isOptionalText(parsed.proposedAnswer)) {
    return { ok: false, reason: "invalid_content" };
  }
  if (
    typeof parsed.supplementalContent === "string" &&
    parsed.supplementalContent.length > 8_000
  ) {
    return { ok: false, reason: "invalid_content" };
  }
  if (typeof parsed.proposedAnswer === "string" && parsed.proposedAnswer.length > 20_000) {
    return { ok: false, reason: "invalid_content" };
  }

  return {
    ok: true,
    value: {
      decision: decision as VerificationDecision,
      confidence,
      issues,
      supplementalContent: parsed.supplementalContent,
      proposedAnswer: parsed.proposedAnswer
    }
  };
}

/** Prompt contract for verification. The model is explicitly denied a free-form answer path. */
export function buildVerificationPrompt(question: string, primaryAnswer: string): string {
  return [
    "你是答案驗證器。請只輸出符合指定 JSON schema 的驗證結果，不要輸出 Markdown、解釋或 Chain of Thought。",
    'schema: {"decision":"agree|supplement|conflict|uncertain","confidence":0..1,"issues":[{"category":"factual|calculation|logic|code|safety|missing_information|other","severity":"low|medium|high","description":"簡短安全描述"}],"supplementalContent":string|null,"proposedAnswer":string|null}',
    "decision=agree 時保留 supplementalContent/proposedAnswer 為 null；decision=supplement 時只提供不改變核心結論的必要補充；decision=conflict 時描述衝突類別，不要直接覆寫答案。",
    "使用者問題：",
    question,
    "Primary 答案：",
    primaryAnswer
  ].join("\n");
}
